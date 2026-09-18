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

#[tauri::command]
pub async fn save_task_card(app: AppHandle, card: TaskCardRecord) -> Result<(), String> {
    let path = crate::paths::task_board_file(&app)?;
    tokio::task::spawn_blocking(move || save_task_card_inner(path, card))
        .await
        .map_err(|error| format!("save_task_card task failed: {error}"))?
}

#[tauri::command]
pub async fn list_task_cards(
    app: AppHandle,
    project_id: Option<String>,
) -> Result<Vec<TaskCardRecord>, String> {
    let path = crate::paths::task_board_file(&app)?;
    tokio::task::spawn_blocking(move || list_task_cards_inner(path, project_id))
        .await
        .map_err(|error| format!("list_task_cards task failed: {error}"))?
}

#[tauri::command]
pub async fn delete_task_card(app: AppHandle, card_id: String) -> Result<(), String> {
    let path = crate::paths::task_board_file(&app)?;
    tokio::task::spawn_blocking(move || delete_task_card_inner(path, card_id))
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
}
