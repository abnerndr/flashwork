use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

const JOURNAL_CHAR_LIMIT: usize = 48_000;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptRunStepRecord {
    pub agent: String,
    pub reason: String,
    pub started_at: u64,
    pub ended_at: Option<u64>,
    pub handoff_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_path: Option<String>,
    pub terminal_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptRunRecord {
    pub id: String,
    pub project_id: String,
    pub cwd: String,
    pub prompt: String,
    pub status: String,
    pub active_agent: String,
    pub active_terminal_id: String,
    pub unrestricted: bool,
    pub steps: Vec<PromptRunStepRecord>,
    pub journal_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canonical_claude_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canonical_claude_terminal_id: Option<String>,
    pub created_at: u64,
}

fn validate_run_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 64
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
    {
        return Err("invalid run id".to_string());
    }
    Ok(())
}

fn truncate_journal(content: &str, limit: usize) -> String {
    let count = content.chars().count();
    if count <= limit {
        return content.to_string();
    }
    let skip = count - limit + 1;
    let mut trimmed: String = content.chars().skip(skip).collect();
    trimmed.insert(0, '…');
    trimmed
}

pub(crate) fn confined_existing_run_dir(runs: &Path, run_id: &str) -> Result<Option<PathBuf>, String> {
    validate_run_id(run_id)?;
    if !runs.exists() {
        return Ok(None);
    }
    let canonical_runs = fs::canonicalize(runs).map_err(|error| error.to_string())?;
    let target = canonical_runs.join(run_id);
    if !target.exists() {
        return Ok(None);
    }
    let canonical_target = fs::canonicalize(&target).map_err(|error| error.to_string())?;
    if canonical_target.parent() != Some(canonical_runs.as_path()) || !canonical_target.is_dir() {
        return Err("run path is outside the runs directory".to_string());
    }
    Ok(Some(canonical_target))
}

pub(crate) fn journal_path_for_persist(path: &Path) -> String {
    crate::cli_launch::strip_verbatim_prefix(path.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

pub(crate) fn confined_run_dir(runs: &Path, run_id: &str) -> Result<PathBuf, String> {
    validate_run_id(run_id)?;
    fs::create_dir_all(runs).map_err(|error| error.to_string())?;
    let canonical_runs = fs::canonicalize(runs).map_err(|error| error.to_string())?;
    let target = canonical_runs.join(run_id);
    fs::create_dir_all(&target).map_err(|error| error.to_string())?;
    let canonical_target = fs::canonicalize(&target).map_err(|error| error.to_string())?;
    if canonical_target.parent() != Some(canonical_runs.as_path()) || !canonical_target.is_dir() {
        return Err("run path is outside the runs directory".to_string());
    }
    Ok(canonical_target)
}

fn write_json_atomically(path: &Path, contents: &str) -> Result<(), String> {
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, contents).map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

fn write_journal_atomically(path: &Path, contents: &str) -> Result<(), String> {
    let temporary = path.with_file_name("journal.md.tmp");
    fs::write(&temporary, contents).map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

fn save_prompt_run_inner(runs: PathBuf, mut run: PromptRunRecord) -> Result<(), String> {
    let run_dir = confined_run_dir(&runs, &run.id)?;
    let journal_path = run_dir.join("journal.md");
    if !journal_path.exists() {
        fs::write(&journal_path, "").map_err(|error| error.to_string())?;
    }
    run.journal_path = journal_path_for_persist(&journal_path);
    let context_dir = run_dir.join("context");
    fs::create_dir_all(context_dir.join("chunks")).map_err(|error| error.to_string())?;
    run.context_dir = Some(journal_path_for_persist(&context_dir));
    let json = serde_json::to_string_pretty(&run).map_err(|error| error.to_string())?;
    write_json_atomically(&run_dir.join("run.json"), &json)
}

fn load_prompt_run_inner(runs: PathBuf, run_id: String) -> Result<Option<PromptRunRecord>, String> {
    let Some(run_dir) = confined_existing_run_dir(&runs, &run_id)? else {
        return Ok(None);
    };
    let path = run_dir.join("run.json");
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    serde_json::from_str(&content).map_err(|error| error.to_string())
}

fn list_prompt_runs_inner(
    runs: PathBuf,
    project_id: String,
) -> Result<Vec<PromptRunRecord>, String> {
    if !runs.exists() {
        return Ok(Vec::new());
    }
    let canonical_runs = fs::canonicalize(&runs).map_err(|error| error.to_string())?;
    let Ok(entries) = fs::read_dir(&canonical_runs) else {
        return Ok(Vec::new());
    };
    let mut records = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if validate_run_id(name).is_err() {
            continue;
        }
        let Ok(canonical_target) = fs::canonicalize(&path) else {
            continue;
        };
        if canonical_target.parent() != Some(canonical_runs.as_path()) {
            continue;
        }
        let json_path = canonical_target.join("run.json");
        let Ok(content) = fs::read_to_string(json_path) else {
            continue;
        };
        let Ok(record) = serde_json::from_str::<PromptRunRecord>(&content) else {
            continue;
        };
        if record.project_id == project_id {
            records.push(record);
        }
    }
    records.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    Ok(records)
}

fn append_journal_entry(existing: &str, heading: &str, body: &str) -> String {
    let entry = format!("## {heading}\n\n{body}");
    if existing.is_empty() {
        return entry;
    }
    let mut content = existing.to_string();
    if !content.ends_with('\n') {
        content.push('\n');
    }
    content.push('\n');
    content.push_str(&entry);
    content
}

fn append_prompt_run_journal_inner(
    runs: PathBuf,
    run_id: String,
    heading: String,
    body: String,
) -> Result<String, String> {
    let Some(run_dir) = confined_existing_run_dir(&runs, &run_id)? else {
        return Err("prompt run not found".to_string());
    };
    let journal_path = run_dir.join("journal.md");
    let existing = if journal_path.exists() {
        fs::read_to_string(&journal_path).map_err(|error| error.to_string())?
    } else {
        String::new()
    };
    let appended = append_journal_entry(&existing, &heading, &body);
    let truncated = truncate_journal(&appended, JOURNAL_CHAR_LIMIT);
    write_journal_atomically(&journal_path, &truncated)?;
    Ok(journal_path_for_persist(&journal_path))
}

fn write_named_markdown(run_dir: &Path, file_name: &str, contents: &str) -> Result<String, String> {
    let path = run_dir.join(file_name);
    let temporary = run_dir.join(format!("{file_name}.tmp"));
    fs::write(&temporary, contents).map_err(|error| error.to_string())?;
    fs::rename(&temporary, &path).map_err(|error| error.to_string())?;
    Ok(journal_path_for_persist(&path))
}

const ALLOWED_PROMPT_RUN_FILES: &[&str] = &["api-reply.md"];

fn validate_prompt_run_file_name(file_name: &str) -> Result<(), String> {
    if !ALLOWED_PROMPT_RUN_FILES.contains(&file_name) {
        return Err("unsupported prompt run file".to_string());
    }
    Ok(())
}

fn write_prompt_run_file_inner(
    runs: PathBuf,
    run_id: String,
    file_name: String,
    contents: String,
) -> Result<String, String> {
    validate_prompt_run_file_name(&file_name)?;
    let run_dir = confined_run_dir(&runs, &run_id)?;
    write_named_markdown(&run_dir, &file_name, &contents)
}

fn write_prompt_run_board_inner(runs: PathBuf, run_id: String, contents: String) -> Result<String, String> {
    let run_dir = confined_run_dir(&runs, &run_id)?;
    let truncated = truncate_journal(&contents, JOURNAL_CHAR_LIMIT);
    write_named_markdown(&run_dir, "board.md", &truncated)
}

fn append_prompt_run_board_inner(
    runs: PathBuf,
    run_id: String,
    heading: String,
    body: String,
) -> Result<String, String> {
    let Some(run_dir) = confined_existing_run_dir(&runs, &run_id)? else {
        return Err("prompt run not found".to_string());
    };
    let board_path = run_dir.join("board.md");
    let existing = if board_path.exists() {
        fs::read_to_string(&board_path).map_err(|error| error.to_string())?
    } else {
        String::new()
    };
    let appended = append_journal_entry(&existing, &heading, &body);
    let truncated = truncate_journal(&appended, JOURNAL_CHAR_LIMIT);
    write_named_markdown(&run_dir, "board.md", &truncated)
}

#[tauri::command]
pub async fn save_prompt_run(app: AppHandle, run: PromptRunRecord) -> Result<(), String> {
    let runs = crate::paths::runs_dir(&app)?;
    tokio::task::spawn_blocking(move || save_prompt_run_inner(runs, run))
        .await
        .map_err(|error| format!("save_prompt_run task failed: {error}"))?
}

#[tauri::command]
pub async fn load_prompt_run(
    app: AppHandle,
    run_id: String,
) -> Result<Option<PromptRunRecord>, String> {
    let runs = crate::paths::runs_dir(&app)?;
    tokio::task::spawn_blocking(move || load_prompt_run_inner(runs, run_id))
        .await
        .map_err(|error| format!("load_prompt_run task failed: {error}"))?
}

#[tauri::command]
pub async fn list_prompt_runs(
    app: AppHandle,
    project_id: String,
) -> Result<Vec<PromptRunRecord>, String> {
    let runs = crate::paths::runs_dir(&app)?;
    tokio::task::spawn_blocking(move || list_prompt_runs_inner(runs, project_id))
        .await
        .map_err(|error| format!("list_prompt_runs task failed: {error}"))?
}

#[tauri::command]
pub async fn append_prompt_run_journal(
    app: AppHandle,
    run_id: String,
    heading: String,
    body: String,
) -> Result<String, String> {
    let runs = crate::paths::runs_dir(&app)?;
    tokio::task::spawn_blocking(move || {
        append_prompt_run_journal_inner(runs, run_id, heading, body)
    })
    .await
    .map_err(|error| format!("append_prompt_run_journal task failed: {error}"))?
}

#[tauri::command]
pub async fn write_prompt_run_file(
    app: AppHandle,
    run_id: String,
    file_name: String,
    contents: String,
) -> Result<String, String> {
    let runs = crate::paths::runs_dir(&app)?;
    tokio::task::spawn_blocking(move || {
        write_prompt_run_file_inner(runs, run_id, file_name, contents)
    })
    .await
    .map_err(|error| format!("write_prompt_run_file task failed: {error}"))?
}

#[tauri::command]
pub async fn write_prompt_run_board(
    app: AppHandle,
    run_id: String,
    contents: String,
) -> Result<String, String> {
    let runs = crate::paths::runs_dir(&app)?;
    tokio::task::spawn_blocking(move || write_prompt_run_board_inner(runs, run_id, contents))
        .await
        .map_err(|error| format!("write_prompt_run_board task failed: {error}"))?
}

#[tauri::command]
pub async fn append_prompt_run_board(
    app: AppHandle,
    run_id: String,
    heading: String,
    body: String,
) -> Result<String, String> {
    let runs = crate::paths::runs_dir(&app)?;
    tokio::task::spawn_blocking(move || {
        append_prompt_run_board_inner(runs, run_id, heading, body)
    })
    .await
    .map_err(|error| format!("append_prompt_run_board task failed: {error}"))?
}

#[tauri::command]
pub async fn ensure_prompt_run_context(app: AppHandle, run_id: String) -> Result<String, String> {
    let runs = crate::paths::runs_dir(&app)?;
    tokio::task::spawn_blocking(move || {
        let run_dir = confined_run_dir(&runs, &run_id)?;
        let context_dir = run_dir.join("context");
        fs::create_dir_all(context_dir.join("chunks")).map_err(|error| error.to_string())?;
        crate::context_hub::ensure_hub_skeleton(&context_dir)?;
        Ok(journal_path_for_persist(&context_dir))
    })
    .await
    .map_err(|error| format!("ensure_prompt_run_context task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsafe_run_ids() {
        assert!(validate_run_id("abc").is_ok());
        assert!(validate_run_id("../x").is_err());
        assert!(validate_run_id("").is_err());
        assert!(validate_run_id("bad id").is_err());
    }

    #[test]
    fn truncates_journal_from_the_front() {
        let kept = truncate_journal(&"a".repeat(100), 40);
        assert!(kept.chars().count() <= 40);
        assert!(kept.starts_with('…') || kept.len() <= 40);
    }

    #[test]
    fn journal_path_for_persist_strips_windows_verbatim_prefix() {
        let persisted = journal_path_for_persist(Path::new(r"\\?\C:\Users\me\runs\abc\journal.md"));
        assert!(!persisted.starts_with(r"\\?\"));
        assert_eq!(persisted, r"C:\Users\me\runs\abc\journal.md");
    }

    #[test]
    fn writes_api_reply_md_when_file_does_not_exist() {
        let runs = tempfile::tempdir().unwrap();
        let path = write_prompt_run_file_inner(
            runs.path().to_path_buf(),
            "run_api".to_string(),
            "api-reply.md".to_string(),
            "# reply\n".to_string(),
        )
        .expect("create api-reply.md");
        let written = runs.path().join("run_api").join("api-reply.md");
        assert!(written.is_file(), "api-reply.md should be created");
        assert_eq!(fs::read_to_string(&written).unwrap(), "# reply\n");
        assert!(path.ends_with("api-reply.md"));
    }
}
