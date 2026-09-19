use regex::Regex;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use tauri::AppHandle;

use crate::git_control::hide_console;

/// Markdown extensions accepted for task history handoffs, mirroring
/// `HAND_OFF_EXTENSIONS` in `src/lib/taskBoard/attachments.ts`.
const HAND_OFF_EXTENSIONS: &[&str] = &[".md", ".markdown", ".mdx"];

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSliceRecord {
    pub id: String,
    pub kind: String,
    pub agent: String,
    pub prompt: String,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub allowed_files: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
    pub status: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskAttachment {
    pub id: String,
    pub source_path: String,
    pub stored_path: String,
    pub kind: String,
    pub title: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskToolSelectionRecord {
    pub mode: String,
    #[serde(default)]
    pub mcp_server_ids: Vec<String>,
    #[serde(default)]
    pub skill_names: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCardRecord {
    pub id: String,
    pub project_id: String,
    pub cwd: String,
    pub title: String,
    pub prompt: String,
    #[serde(default)]
    pub allowed_files: Vec<String>,
    pub priority: i32,
    pub column: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verify_commands: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub board_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slice_plan: Option<Vec<TaskSliceRecord>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub attachments: Vec<TaskAttachment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_selection: Option<TaskToolSelectionRecord>,
    pub created_at: u64,
    pub updated_at: u64,
}

fn validate_card_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_')
    {
        return Err("invalid card id".to_string());
    }
    Ok(())
}

/// Mirrors `isHandoffPath` in `src/lib/taskBoard/attachments.ts`.
fn is_handoff_path(path: &Path) -> bool {
    let lower = path.to_string_lossy().to_lowercase();
    HAND_OFF_EXTENSIONS.iter().any(|ext| lower.ends_with(ext))
}

/// Mirrors `attachmentTitleFromMarkdown` in `src/lib/taskBoard/attachments.ts`,
/// falling back to the source file stem instead of the literal `"untitled"`.
fn attachment_title(body: &str, source_path: &Path) -> String {
    let heading = Regex::new(r"(?m)^#\s+(.+)$").expect("valid heading regex");
    if let Some(captures) = heading.captures(body) {
        let title = captures.get(1).map(|m| m.as_str().trim()).unwrap_or("");
        if !title.is_empty() {
            return title.to_string();
        }
    }
    source_path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.is_empty())
        .unwrap_or("untitled")
        .to_string()
}

/// Extracts and validates the file name from a source path, rejecting
/// separators and traversal segments so it is safe to join onto a
/// destination directory.
fn sanitize_attachment_file_name(source_path: &Path) -> Result<String, String> {
    let file_name = source_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "invalid source file name".to_string())?;
    if file_name.is_empty() || file_name.contains(['/', '\\']) || file_name.contains("..") {
        return Err("invalid source file name".to_string());
    }
    Ok(file_name.to_string())
}

/// Pure path helper (no filesystem access) that computes the destination
/// path for an attachment while confining it under
/// `{attachments_root}/{card_id}/{file_name}` — rejects zip-slip / escape
/// attempts even when `card_id` or `file_name` are crafted maliciously.
fn attachment_destination_path(
    attachments_root: &Path,
    card_id: &str,
    file_name: &str,
) -> Result<PathBuf, String> {
    validate_card_id(card_id)?;
    if file_name.is_empty() || file_name.contains(['/', '\\']) || file_name.contains("..") {
        return Err("invalid attachment file name".to_string());
    }
    let card_dir = attachments_root.join(card_id);
    let destination = card_dir.join(file_name);
    if card_dir.parent() != Some(attachments_root) {
        return Err("attachment path escapes destination".to_string());
    }
    if destination.parent() != Some(card_dir.as_path()) {
        return Err("attachment path escapes destination".to_string());
    }
    Ok(destination)
}

fn stored_attachment_file_name(attachment_id: &str, source_path: &Path) -> Result<String, String> {
    let safe_file_name = sanitize_attachment_file_name(source_path)?;
    Ok(format!("{attachment_id}-{safe_file_name}"))
}

fn task_attach_markdown_inner(
    attachments_root: PathBuf,
    card_id: String,
    source_path: PathBuf,
) -> Result<TaskAttachment, String> {
    validate_card_id(&card_id)?;
    if !is_handoff_path(&source_path) {
        return Err("only .md, .markdown, and .mdx files can be attached".to_string());
    }
    let attachment_id = nanoid::nanoid!();
    let stored_file_name = stored_attachment_file_name(&attachment_id, &source_path)?;
    let destination =
        attachment_destination_path(&attachments_root, &card_id, &stored_file_name)?;
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::copy(&source_path, &destination).map_err(|error| error.to_string())?;
    let body = fs::read_to_string(&destination).unwrap_or_default();
    let title = attachment_title(&body, &source_path);
    Ok(TaskAttachment {
        id: attachment_id,
        source_path: source_path.to_string_lossy().to_string(),
        stored_path: destination.to_string_lossy().to_string(),
        kind: "handoff".to_string(),
        title,
    })
}

fn write_json_atomically(path: &Path, contents: &str) -> Result<(), String> {
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, contents).map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

/// Writes the resolved MCP/skill allowlist for a card as `tools.json` under
/// `{attachments_root}/{card_id}/tools.json`, creating the card directory if
/// needed. Unlike the generic `write_text_file` command, this does not
/// require the destination to already exist, so it works for cards with no
/// prior markdown attachments (e.g. `restrict` mode with zero attachments).
/// Returns the absolute path written.
fn task_write_tools_json_inner(
    attachments_root: PathBuf,
    card_id: String,
    json: String,
) -> Result<String, String> {
    validate_card_id(&card_id)?;
    let destination = attachment_destination_path(&attachments_root, &card_id, "tools.json")?;
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    write_json_atomically(&destination, &json)?;
    Ok(destination.to_string_lossy().to_string())
}

fn load_cards(path: &Path) -> Result<Vec<TaskCardRecord>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    if content.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&content).map_err(|error| error.to_string())
}

fn save_cards(path: &Path, cards: &[TaskCardRecord]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let json = serde_json::to_string_pretty(cards).map_err(|error| error.to_string())?;
    write_json_atomically(path, &json)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFolderHint {
    pub project_id: String,
    pub folder: String,
}

fn save_task_card_inner(path: PathBuf, card: TaskCardRecord) -> Result<(), String> {
    validate_card_id(&card.id)?;
    let mut cards = load_cards(&path)?;
    if let Some(existing) = cards.iter_mut().find(|item| item.id == card.id) {
        *existing = card;
    } else {
        cards.push(card);
    }
    save_cards(&path, &cards)
}

fn list_task_cards_inner(
    path: PathBuf,
    project_id: Option<String>,
) -> Result<Vec<TaskCardRecord>, String> {
    let mut cards = load_cards(&path)?;
    if let Some(project_id) = project_id {
        cards.retain(|card| card.project_id == project_id);
    }
    cards.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(cards)
}

fn delete_task_card_inner(path: PathBuf, card_id: String) -> Result<(), String> {
    validate_card_id(&card_id)?;
    let mut cards = load_cards(&path)?;
    cards.retain(|card| card.id != card_id);
    save_cards(&path, &cards)
}

fn load_single_card(path: &Path) -> Result<TaskCardRecord, String> {
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&content).map_err(|error| error.to_string())
}

fn matching_project_folder(folder: &str, project_id: &str) -> Option<String> {
    let trimmed = folder.trim();
    if trimmed.is_empty() {
        return None;
    }
    let meta = crate::project_home::detect(trimmed)?;
    if meta.id != project_id {
        return None;
    }
    Some(trimmed.to_string())
}

fn usable_project_folder(card: &TaskCardRecord) -> Option<String> {
    matching_project_folder(&card.cwd, &card.project_id)
}

fn confined_history_tasks_dir(folder: &str) -> Option<PathBuf> {
    let _ = crate::project_home::detect(folder)?;
    let root = fs::canonicalize(folder).ok()?;
    let home = root.join(".flashwork");
    let tasks = home.join("history").join("tasks");
    let metadata = fs::symlink_metadata(&tasks).ok()?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return None;
    }
    let resolved_home = fs::canonicalize(&home).ok()?;
    let resolved_tasks = fs::canonicalize(&tasks).ok()?;
    if !resolved_tasks.starts_with(&resolved_home) {
        return None;
    }
    Some(resolved_tasks)
}

fn project_card_file(folder: &str, card_id: &str) -> Result<PathBuf, String> {
    validate_card_id(card_id)?;
    let dir = confined_history_tasks_dir(folder).ok_or_else(|| "no project home".to_string())?;
    let path = dir.join(format!("{card_id}.json"));
    if path.parent() != Some(dir.as_path()) {
        return Err("card path escapes history/tasks".to_string());
    }
    Ok(path)
}

fn save_project_home_card(folder: &str, card: &TaskCardRecord) -> Result<PathBuf, String> {
    crate::project_home::ensure_history_layout(folder)?;
    let path = project_card_file(folder, &card.id)?;
    let json = serde_json::to_string_pretty(card).map_err(|error| error.to_string())?;
    write_json_atomically(&path, &json)?;
    Ok(path)
}

fn remove_profile_card(profile_path: &Path, card_id: &str) -> Result<(), String> {
    if !profile_path.exists() {
        return Ok(());
    }
    let mut cards = load_cards(profile_path)?;
    let before = cards.len();
    cards.retain(|card| card.id != card_id);
    if cards.len() != before {
        save_cards(profile_path, &cards)?;
    }
    Ok(())
}

fn list_project_home_cards(folder: &str) -> Result<Vec<TaskCardRecord>, String> {
    let Some(meta) = crate::project_home::detect(folder) else {
        return Ok(Vec::new());
    };
    let Some(dir) = confined_history_tasks_dir(folder) else {
        return Ok(Vec::new());
    };
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(Vec::new()),
    };
    let mut cards = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let path = entry.path();
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        if !file_name.ends_with(".json") || file_name.ends_with(".tmp") {
            continue;
        }
        let Some(stem) = file_name.strip_suffix(".json") else {
            continue;
        };
        if validate_card_id(stem).is_err() {
            continue;
        }
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            continue;
        }
        if let Ok(card) = load_single_card(&path) {
            if card.id == stem && card.project_id == meta.id {
                cards.push(card);
            }
        }
    }
    Ok(cards)
}

fn save_task_card_resolved(profile_path: &Path, card: TaskCardRecord) -> Result<(), String> {
    validate_card_id(&card.id)?;
    if let Some(folder) = usable_project_folder(&card) {
        save_project_home_card(&folder, &card)?;
        remove_profile_card(profile_path, &card.id)?;
        return Ok(());
    }
    save_task_card_inner(profile_path.to_path_buf(), card)
}

fn list_task_cards_resolved(
    profile_path: &Path,
    project_id: Option<String>,
    project_folders: &[ProjectFolderHint],
) -> Result<Vec<TaskCardRecord>, String> {
    let mut cards = list_task_cards_inner(profile_path.to_path_buf(), None)?;
    let mut home_ids = std::collections::HashSet::new();
    let mut home_cards = Vec::new();
    for hint in project_folders {
        let Some(folder) = matching_project_folder(&hint.folder, &hint.project_id) else {
            continue;
        };
        for card in list_project_home_cards(&folder)? {
            home_ids.insert(card.id.clone());
            home_cards.push(card);
        }
    }
    cards.retain(|card| !home_ids.contains(&card.id));
    cards.append(&mut home_cards);
    if let Some(project_id) = project_id {
        cards.retain(|card| card.project_id == project_id);
    }
    cards.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(cards)
}

fn delete_project_home_card(folder: &str, card_id: &str) -> Result<bool, String> {
    let path = match project_card_file(folder, card_id) {
        Ok(path) => path,
        Err(_) => return Ok(false),
    };
    if !path.exists() {
        return Ok(false);
    }
    fs::remove_file(&path).map_err(|error| error.to_string())?;
    Ok(true)
}

fn delete_task_card_resolved(
    profile_path: &Path,
    card_id: String,
    folder: Option<String>,
    project_id: Option<String>,
) -> Result<(), String> {
    validate_card_id(&card_id)?;
    if let Some(folder) = folder.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        let home_matches = project_id
            .as_deref()
            .map(|id| matching_project_folder(folder, id).is_some())
            .unwrap_or_else(|| crate::project_home::detect(folder).is_some());
        if home_matches {
            delete_project_home_card(folder, &card_id)?;
        }
    }
    delete_task_card_inner(profile_path.to_path_buf(), card_id)
}

#[tauri::command]
pub async fn save_task_card(app: AppHandle, card: TaskCardRecord) -> Result<(), String> {
    let path = crate::paths::task_board_file(&app)?;
    tokio::task::spawn_blocking(move || save_task_card_resolved(&path, card))
        .await
        .map_err(|error| format!("save_task_card task failed: {error}"))?
}

#[tauri::command]
pub async fn list_task_cards(
    app: AppHandle,
    project_id: Option<String>,
    project_folders: Option<Vec<ProjectFolderHint>>,
) -> Result<Vec<TaskCardRecord>, String> {
    let path = crate::paths::task_board_file(&app)?;
    tokio::task::spawn_blocking(move || {
        list_task_cards_resolved(&path, project_id, project_folders.as_deref().unwrap_or(&[]))
    })
    .await
    .map_err(|error| format!("list_task_cards task failed: {error}"))?
}

#[tauri::command]
pub async fn delete_task_card(
    app: AppHandle,
    card_id: String,
    folder: Option<String>,
    project_id: Option<String>,
) -> Result<(), String> {
    let path = crate::paths::task_board_file(&app)?;
    tokio::task::spawn_blocking(move || {
        delete_task_card_resolved(&path, card_id, folder, project_id)
    })
    .await
    .map_err(|error| format!("delete_task_card task failed: {error}"))?
}

#[tauri::command]
pub async fn task_attach_markdown(
    app: AppHandle,
    card_id: String,
    source_path: String,
) -> Result<TaskAttachment, String> {
    let attachments_root = crate::paths::task_board_attachments_dir(&app)?;
    tokio::task::spawn_blocking(move || {
        task_attach_markdown_inner(attachments_root, card_id, PathBuf::from(source_path))
    })
    .await
    .map_err(|error| format!("task_attach_markdown task failed: {error}"))?
}

#[tauri::command]
pub async fn task_write_tools_json(
    app: AppHandle,
    card_id: String,
    json: String,
) -> Result<String, String> {
    let attachments_root = crate::paths::task_board_attachments_dir(&app)?;
    tokio::task::spawn_blocking(move || {
        task_write_tools_json_inner(attachments_root, card_id, json)
    })
    .await
    .map_err(|error| format!("task_write_tools_json task failed: {error}"))?
}

#[tauri::command]
pub async fn run_planner_cli(
    bin: String,
    args: Vec<String>,
    cwd: String,
    timeout_ms: u64,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || run_planner_cli_inner(bin, args, cwd, timeout_ms))
        .await
        .map_err(|error| format!("run_planner_cli task failed: {error}"))?
}

fn run_planner_cli_inner(
    bin: String,
    args: Vec<String>,
    cwd: String,
    timeout_ms: u64,
) -> Result<String, String> {
    if bin.trim().is_empty() {
        return Err("planner binary is empty".to_string());
    }
    let mut command = Command::new(&bin);
    command
        .args(&args)
        .current_dir(&cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut command);
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let deadline = Instant::now() + Duration::from_millis(timeout_ms.max(1_000));
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                return Err("planner timed out".to_string());
            }
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(error) => return Err(error.to_string()),
        }
    }
    let output = child.wait_with_output().map_err(|error| error.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() && stdout.trim().is_empty() {
        return Err(if stderr.trim().is_empty() {
            format!("planner exited {}", output.status)
        } else {
            stderr
        });
    }
    Ok(if stdout.trim().is_empty() { stderr } else { stdout })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsafe_card_ids() {
        assert!(validate_card_id("card_1").is_ok());
        assert!(validate_card_id("../x").is_err());
    }

    fn unique_temp_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "flashwork-task-board-{label}-{}",
            nanoid::nanoid!(8)
        ))
    }

    #[test]
    fn is_handoff_path_accepts_markdown_extensions_only() {
        assert!(is_handoff_path(Path::new("/tmp/spec.md")));
        assert!(is_handoff_path(Path::new("/tmp/spec.MDX")));
        assert!(is_handoff_path(Path::new("/tmp/spec.markdown")));
        assert!(!is_handoff_path(Path::new("/tmp/spec.txt")));
    }

    #[test]
    fn attachment_title_reads_first_heading_or_falls_back_to_stem() {
        let source = Path::new("/tmp/login-handoff.md");
        assert_eq!(
            attachment_title("# Login handoff\n\nDo the thing", source),
            "Login handoff"
        );
        assert_eq!(attachment_title("no heading here", source), "login-handoff");
    }

    #[test]
    fn attachment_destination_path_rejects_escaping_file_names() {
        let root = Path::new("/profile/attachments");
        assert!(attachment_destination_path(root, "card_1", "../../etc/passwd").is_err());
        assert!(attachment_destination_path(root, "card_1", "..\\evil.md").is_err());
        assert!(attachment_destination_path(root, "../escape", "note.md").is_err());
    }

    #[test]
    fn attachment_destination_path_confines_to_card_dir() {
        let root = Path::new("/profile/attachments");
        let destination = attachment_destination_path(root, "card_1", "note.md").unwrap();
        assert_eq!(destination, root.join("card_1").join("note.md"));
        assert!(destination.starts_with(root));
    }

    #[test]
    fn task_attach_markdown_inner_rejects_non_markdown_source() {
        let root = unique_temp_dir("reject-non-md");
        let result =
            task_attach_markdown_inner(root, "card_1".to_string(), PathBuf::from("/tmp/notes.txt"));
        assert!(result.is_err());
    }

    #[test]
    fn task_attach_markdown_inner_rejects_invalid_card_id() {
        let root = unique_temp_dir("reject-bad-card");
        let result = task_attach_markdown_inner(
            root,
            "../escape".to_string(),
            PathBuf::from("/tmp/notes.md"),
        );
        assert!(result.is_err());
    }

    #[test]
    fn task_attach_markdown_inner_copies_file_and_extracts_title() {
        let root = unique_temp_dir("happy-path");
        let source_dir = unique_temp_dir("happy-path-source");
        fs::create_dir_all(&source_dir).unwrap();
        let source_path = source_dir.join("handoff.md");
        fs::write(&source_path, "# Login handoff\n\nDo the thing").unwrap();

        let attachment =
            task_attach_markdown_inner(root.clone(), "card_1".to_string(), source_path.clone())
                .expect("copy should succeed");

        assert_eq!(attachment.kind, "handoff");
        assert_eq!(attachment.title, "Login handoff");
        assert_eq!(attachment.source_path, source_path.to_string_lossy());
        let stored_path = PathBuf::from(&attachment.stored_path);
        assert!(stored_path.starts_with(&root));
        assert!(stored_path.exists());
        let expected_file_name = format!("{}-handoff.md", attachment.id);
        assert_eq!(
            stored_path.file_name().and_then(|name| name.to_str()),
            Some(expected_file_name.as_str())
        );
        assert_eq!(
            fs::read_to_string(&stored_path).unwrap(),
            "# Login handoff\n\nDo the thing"
        );

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&source_dir);
    }

    #[test]
    fn task_attach_markdown_inner_does_not_require_existing_card_json() {
        // The copy should succeed even though no `task-board.json` entry
        // exists yet for this card id (composer may attach before save).
        let root = unique_temp_dir("no-card-json");
        let source_dir = unique_temp_dir("no-card-json-source");
        fs::create_dir_all(&source_dir).unwrap();
        let source_path = source_dir.join("draft.mdx");
        fs::write(&source_path, "no heading").unwrap();

        let attachment =
            task_attach_markdown_inner(root.clone(), "draft_card".to_string(), source_path)
                .expect("copy should succeed without a saved card");
        assert_eq!(attachment.title, "draft");

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&source_dir);
    }

    #[test]
    fn task_attach_markdown_inner_unique_paths_for_same_basename() {
        let root = unique_temp_dir("duplicate-basename");
        let source_dir = unique_temp_dir("duplicate-basename-source");
        fs::create_dir_all(&source_dir).unwrap();

        let source_a = source_dir.join("handoff.md");
        fs::write(&source_a, "# First\n").unwrap();

        let nested = source_dir.join("nested");
        fs::create_dir_all(&nested).unwrap();
        let source_b = nested.join("handoff.md");
        fs::write(&source_b, "# Second\n").unwrap();

        let attachment_a =
            task_attach_markdown_inner(root.clone(), "card_1".to_string(), source_a)
                .expect("first copy should succeed");
        let attachment_b =
            task_attach_markdown_inner(root.clone(), "card_1".to_string(), source_b)
                .expect("second copy should succeed");

        assert_ne!(attachment_a.id, attachment_b.id);
        assert_ne!(attachment_a.stored_path, attachment_b.stored_path);
        assert!(PathBuf::from(&attachment_a.stored_path).exists());
        assert!(PathBuf::from(&attachment_b.stored_path).exists());
        assert_eq!(
            fs::read_to_string(&attachment_a.stored_path).unwrap(),
            "# First\n"
        );
        assert_eq!(
            fs::read_to_string(&attachment_b.stored_path).unwrap(),
            "# Second\n"
        );

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&source_dir);
    }

    #[test]
    fn task_write_tools_json_inner_rejects_invalid_card_id() {
        let root = unique_temp_dir("tools-json-bad-card");
        let result = task_write_tools_json_inner(
            root,
            "../escape".to_string(),
            "{\"mode\":\"projectDefault\"}".to_string(),
        );
        assert!(result.is_err());
    }

    #[test]
    fn task_write_tools_json_inner_creates_card_dir_and_writes_file() {
        let root = unique_temp_dir("tools-json-happy-path");
        // The card directory does not exist yet — no prior attachment was
        // made for this card, mirroring `restrict` mode with zero attachments.
        let path = task_write_tools_json_inner(
            root.clone(),
            "card_1".to_string(),
            "{\"mode\":\"restrict\",\"mcpServerIds\":[\"figma\"],\"skillNames\":[]}".to_string(),
        )
        .expect("write should succeed even without an existing card dir");

        let written = PathBuf::from(&path);
        assert!(written.starts_with(&root));
        assert_eq!(
            written.file_name().and_then(|name| name.to_str()),
            Some("tools.json")
        );
        assert_eq!(
            fs::read_to_string(&written).unwrap(),
            "{\"mode\":\"restrict\",\"mcpServerIds\":[\"figma\"],\"skillNames\":[]}"
        );
        // No leftover temp file from the atomic write.
        assert!(!written.with_extension("json.tmp").exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn task_write_tools_json_inner_overwrites_existing_file() {
        let root = unique_temp_dir("tools-json-overwrite");
        task_write_tools_json_inner(
            root.clone(),
            "card_1".to_string(),
            "{\"mode\":\"projectDefault\"}".to_string(),
        )
        .expect("first write should succeed");
        let path = task_write_tools_json_inner(
            root.clone(),
            "card_1".to_string(),
            "{\"mode\":\"restrict\",\"mcpServerIds\":[],\"skillNames\":[\"qa\"]}".to_string(),
        )
        .expect("second write should succeed");

        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "{\"mode\":\"restrict\",\"mcpServerIds\":[],\"skillNames\":[\"qa\"]}"
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn task_write_tools_json_inner_confines_path_under_attachments_root() {
        let root = unique_temp_dir("tools-json-confinement");
        let path = task_write_tools_json_inner(
            root.clone(),
            "card_1".to_string(),
            "{\"mode\":\"projectDefault\"}".to_string(),
        )
        .expect("write should succeed");
        let written = PathBuf::from(&path);
        assert_eq!(written, root.join("card_1").join("tools.json"));

        let _ = fs::remove_dir_all(&root);
    }

    fn sample_card(id: &str, project_id: &str, cwd: &str) -> TaskCardRecord {
        TaskCardRecord {
            id: id.to_string(),
            project_id: project_id.to_string(),
            cwd: cwd.to_string(),
            title: format!("Card {id}"),
            prompt: "do it".to_string(),
            allowed_files: vec![],
            priority: 1,
            column: "backlog".to_string(),
            verify_commands: None,
            run_id: None,
            board_path: None,
            slice_plan: None,
            error: None,
            attachments: vec![],
            tool_selection: None,
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn listing_one_project_folder_does_not_see_another_project_card() {
        let folder_a = tempfile::tempdir().unwrap();
        let folder_b = tempfile::tempdir().unwrap();
        let profile = tempfile::tempdir().unwrap();
        let profile_file = profile.path().join("task-board.json");

        crate::project_home::bootstrap(&folder_a.path().to_string_lossy(), "proj_a").unwrap();
        crate::project_home::bootstrap(&folder_b.path().to_string_lossy(), "proj_b").unwrap();

        let cwd_a = folder_a.path().to_string_lossy().to_string();
        let cwd_b = folder_b.path().to_string_lossy().to_string();
        save_task_card_resolved(&profile_file, sample_card("card_a", "proj_a", &cwd_a)).unwrap();
        save_task_card_resolved(&profile_file, sample_card("card_b", "proj_b", &cwd_b)).unwrap();

        let card_a_path = folder_a.path().join(".flashwork/history/tasks/card_a.json");
        let card_b_path = folder_b.path().join(".flashwork/history/tasks/card_b.json");
        assert!(card_a_path.is_file(), "card A belongs under project A");
        assert!(card_b_path.is_file(), "card B belongs under project B");
        assert!(
            load_cards(&profile_file).unwrap().is_empty(),
            "folder-backed cards must not be dual-written to the profile file"
        );

        #[cfg(unix)]
        let b_history_perms = {
            use std::os::unix::fs::PermissionsExt;
            let b_history = folder_b.path().join(".flashwork/history");
            let original = fs::metadata(&b_history).unwrap().permissions();
            let mut locked = original.clone();
            locked.set_mode(0o000);
            fs::set_permissions(&b_history, locked).unwrap();
            (b_history, original)
        };

        let listed = list_task_cards_resolved(
            &profile_file,
            None,
            &[ProjectFolderHint {
                project_id: "proj_a".into(),
                folder: cwd_a,
            }],
        )
        .expect("listing A must not need to read B");

        #[cfg(unix)]
        {
            fs::set_permissions(&b_history_perms.0, b_history_perms.1).unwrap();
        }

        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "card_a");
        assert!(listed.iter().all(|card| card.id != "card_b"));
    }

    #[test]
    fn save_falls_back_to_profile_when_cwd_empty_or_home_missing() {
        let profile = tempfile::tempdir().unwrap();
        let profile_file = profile.path().join("task-board.json");
        let empty_cwd = sample_card("legacy_empty", "proj_old", "");
        save_task_card_resolved(&profile_file, empty_cwd).unwrap();

        let folder = tempfile::tempdir().unwrap();
        let no_home = sample_card(
            "legacy_no_home",
            "proj_old",
            &folder.path().to_string_lossy(),
        );
        save_task_card_resolved(&profile_file, no_home).unwrap();

        let cards = load_cards(&profile_file).unwrap();
        assert_eq!(cards.len(), 2);
        assert!(!folder.path().join(".flashwork/history/tasks/legacy_no_home.json").exists());
    }

    #[test]
    fn save_to_project_home_removes_legacy_profile_copy() {
        let folder = tempfile::tempdir().unwrap();
        let profile = tempfile::tempdir().unwrap();
        let profile_file = profile.path().join("task-board.json");
        crate::project_home::bootstrap(&folder.path().to_string_lossy(), "proj_a").unwrap();
        let cwd = folder.path().to_string_lossy().to_string();

        save_task_card_inner(profile_file.clone(), sample_card("card_a", "proj_a", &cwd)).unwrap();
        assert_eq!(load_cards(&profile_file).unwrap().len(), 1);

        save_task_card_resolved(&profile_file, sample_card("card_a", "proj_a", &cwd)).unwrap();
        assert!(folder.path().join(".flashwork/history/tasks/card_a.json").is_file());
        assert!(load_cards(&profile_file).unwrap().is_empty());
    }

    #[test]
    fn delete_removes_project_home_card_and_profile_leftover() {
        let folder = tempfile::tempdir().unwrap();
        let profile = tempfile::tempdir().unwrap();
        let profile_file = profile.path().join("task-board.json");
        crate::project_home::bootstrap(&folder.path().to_string_lossy(), "proj_a").unwrap();
        let cwd = folder.path().to_string_lossy().to_string();
        save_task_card_resolved(&profile_file, sample_card("card_a", "proj_a", &cwd)).unwrap();
        save_task_card_inner(profile_file.clone(), sample_card("card_a", "proj_a", &cwd)).unwrap();

        delete_task_card_resolved(
            &profile_file,
            "card_a".into(),
            Some(cwd.clone()),
            Some("proj_a".into()),
        )
        .unwrap();

        assert!(!folder.path().join(".flashwork/history/tasks/card_a.json").exists());
        assert!(load_cards(&profile_file).unwrap().is_empty());
    }

    #[test]
    fn list_ignores_cards_with_wrong_project_id_or_stem() {
        let folder = tempfile::tempdir().unwrap();
        crate::project_home::bootstrap(&folder.path().to_string_lossy(), "proj_a").unwrap();
        let tasks = folder.path().join(".flashwork/history/tasks");
        let cwd = folder.path().to_string_lossy().to_string();

        let bound = sample_card("card_good", "proj_a", &cwd);
        fs::write(
            tasks.join("card_good.json"),
            serde_json::to_string_pretty(&bound).unwrap(),
        )
        .unwrap();

        let wrong_project = sample_card("card_foreign", "proj_other", &cwd);
        fs::write(
            tasks.join("card_foreign.json"),
            serde_json::to_string_pretty(&wrong_project).unwrap(),
        )
        .unwrap();

        let mismatched_stem = sample_card("card_real", "proj_a", &cwd);
        fs::write(
            tasks.join("card_alias.json"),
            serde_json::to_string_pretty(&mismatched_stem).unwrap(),
        )
        .unwrap();

        fs::write(tasks.join("notes.json"), "{\"title\":\"not a card\"}").unwrap();

        let listed = list_project_home_cards(&cwd).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "card_good");
        assert_eq!(listed[0].project_id, "proj_a");
        assert!(listed.iter().all(|card| card.id != "card_foreign"));
        assert!(listed.iter().all(|card| card.id != "card_real"));
    }

    #[test]
    fn card_save_does_not_rerun_full_bootstrap() {
        let folder = tempfile::tempdir().unwrap();
        let profile = tempfile::tempdir().unwrap();
        let profile_file = profile.path().join("task-board.json");
        let home =
            crate::project_home::bootstrap(&folder.path().to_string_lossy(), "proj_a").unwrap();
        fs::remove_file(home.join("harness/AGENTS.md")).unwrap();
        fs::create_dir(home.join("harness/AGENTS.md")).unwrap();
        fs::remove_file(home.join("history/runs/README.md")).unwrap();

        let cwd = folder.path().to_string_lossy().to_string();
        save_task_card_resolved(&profile_file, sample_card("card_a", "proj_a", &cwd)).unwrap();

        assert!(folder.path().join(".flashwork/history/tasks/card_a.json").is_file());
        assert!(
            home.join("harness/AGENTS.md").is_dir(),
            "card save must not rewrite harness files"
        );
        assert_eq!(
            fs::read_to_string(home.join("history/runs/README.md")).unwrap(),
            "Run hubs remain under the app profile until the hub plan ships.\n"
        );
        assert!(load_cards(&profile_file).unwrap().is_empty());
    }

    #[test]
    fn first_project_home_write_restores_runs_hub_pointer() {
        let folder = tempfile::tempdir().unwrap();
        let profile = tempfile::tempdir().unwrap();
        let profile_file = profile.path().join("task-board.json");
        let home =
            crate::project_home::bootstrap(&folder.path().to_string_lossy(), "proj_a").unwrap();
        fs::remove_file(home.join("history/runs/README.md")).unwrap();
        let cwd = folder.path().to_string_lossy().to_string();
        save_task_card_resolved(&profile_file, sample_card("card_a", "proj_a", &cwd)).unwrap();
        assert_eq!(
            fs::read_to_string(home.join("history/runs/README.md")).unwrap(),
            "Run hubs remain under the app profile until the hub plan ships.\n"
        );
    }
}
