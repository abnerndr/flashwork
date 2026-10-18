use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use tauri::AppHandle;

use crate::git_control::hide_console;

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interrupted_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interrupt_reason: Option<String>,
    /// Project-relative path of the shared board (`.flashwork/runs/<id>/board.md`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub board_path: Option<String>,
    /// SPEC task plan (opaque to the backend; validated by the frontend).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spec_tasks: Option<serde_json::Value>,
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

fn read_prompt_run_file_inner(
    runs: PathBuf,
    run_id: String,
    file_name: String,
) -> Result<String, String> {
    validate_prompt_run_file_name(&file_name)?;
    let Some(run_dir) = confined_existing_run_dir(&runs, &run_id)? else {
        return Err("prompt run not found".to_string());
    };
    let path = run_dir.join(&file_name);
    if path.parent() != Some(run_dir.as_path()) {
        return Err("prompt run file escapes run dir".to_string());
    }
    fs::read_to_string(&path).map_err(|error| error.to_string())
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
pub async fn read_prompt_run_file(
    app: AppHandle,
    run_id: String,
    file_name: String,
) -> Result<String, String> {
    let runs = crate::paths::runs_dir(&app)?;
    tokio::task::spawn_blocking(move || read_prompt_run_file_inner(runs, run_id, file_name))
        .await
        .map_err(|error| format!("read_prompt_run_file task failed: {error}"))?
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

/// Largest SPEC markdown the Run SPEC modal accepts.
const SPEC_MARKDOWN_MAX_BYTES: u64 = 1024 * 1024;
const SPEC_MARKDOWN_EXTENSIONS: &[&str] = &["md", "markdown", "mdx"];

fn read_spec_markdown_inner(path: &Path) -> Result<String, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();
    if !SPEC_MARKDOWN_EXTENSIONS.contains(&extension.as_str()) {
        return Err("spec must be a markdown file".to_string());
    }
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("spec is not a regular file".to_string());
    }
    if metadata.len() > SPEC_MARKDOWN_MAX_BYTES {
        return Err("spec_too_large".to_string());
    }
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    String::from_utf8(bytes).map_err(|_| "spec is not valid UTF-8".to_string())
}

/// Reads a user-picked SPEC markdown file (extension and size checked).
#[tauri::command]
pub async fn read_spec_markdown(path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || read_spec_markdown_inner(Path::new(&path)))
        .await
        .map_err(|error| format!("read_spec_markdown task failed: {error}"))?
}

const PROJECT_RUNS_GITIGNORE_LINE: &str = "runs/";

/// Keeps `.flashwork/runs/` out of git without touching other entries.
fn ensure_runs_gitignored(home: &Path) -> Result<(), String> {
    let path = home.join(".gitignore");
    if let Ok(metadata) = fs::symlink_metadata(&path) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("project .gitignore is not a regular file".to_string());
        }
        let existing = fs::read_to_string(&path).map_err(|error| error.to_string())?;
        if existing
            .lines()
            .any(|line| matches!(line.trim(), "runs/" | "runs" | "/runs" | "/runs/"))
        {
            return Ok(());
        }
        let separator = if existing.is_empty() || existing.ends_with('\n') { "" } else { "\n" };
        let next = format!("{existing}{separator}{PROJECT_RUNS_GITIGNORE_LINE}\n");
        return fs::write(&path, next).map_err(|error| error.to_string());
    }
    fs::write(&path, format!("{PROJECT_RUNS_GITIGNORE_LINE}\n")).map_err(|error| error.to_string())
}

/// Resolves `<project>/.flashwork/runs/<runId>`, refusing symlinks that escape the project.
fn project_run_dir(cwd: &str, run_id: &str, create: bool) -> Result<Option<PathBuf>, String> {
    validate_run_id(run_id)?;
    let root = fs::canonicalize(cwd).map_err(|error| error.to_string())?;
    if !root.is_dir() {
        return Err("project folder is not a directory".to_string());
    }
    let home = root.join(".flashwork");
    match fs::symlink_metadata(&home) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err("project home escapes the project folder".to_string());
            }
        }
        Err(_) if create => fs::create_dir(&home).map_err(|error| error.to_string())?,
        Err(_) => return Ok(None),
    }
    let runs = home.join("runs");
    match fs::symlink_metadata(&runs) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err("project runs dir escapes the project folder".to_string());
            }
        }
        Err(_) if create => fs::create_dir(&runs).map_err(|error| error.to_string())?,
        Err(_) => return Ok(None),
    }
    if create {
        ensure_runs_gitignored(&home)?;
        confined_run_dir(&runs, run_id).map(Some)
    } else {
        confined_existing_run_dir(&runs, run_id)
    }
}

/// Board path as agents should reference it: relative to the project root, forward slashes,
/// so Linux CLIs (including ones running inside WSL) resolve it too.
pub(crate) fn project_board_relative_path(run_id: &str) -> String {
    format!(".flashwork/runs/{run_id}/board.md")
}

fn write_project_run_board_inner(cwd: &str, run_id: &str, contents: &str) -> Result<String, String> {
    let run_dir = project_run_dir(cwd, run_id, true)?
        .ok_or_else(|| "project run dir unavailable".to_string())?;
    let truncated = truncate_journal(contents, JOURNAL_CHAR_LIMIT);
    write_named_markdown(&run_dir, "board.md", &truncated)?;
    Ok(project_board_relative_path(run_id))
}

fn append_project_run_board_inner(
    cwd: &str,
    run_id: &str,
    heading: &str,
    body: &str,
) -> Result<String, String> {
    let run_dir = project_run_dir(cwd, run_id, true)?
        .ok_or_else(|| "project run dir unavailable".to_string())?;
    let board_path = run_dir.join("board.md");
    let existing = if board_path.exists() {
        fs::read_to_string(&board_path).map_err(|error| error.to_string())?
    } else {
        String::new()
    };
    let appended = append_journal_entry(&existing, heading, body);
    let truncated = truncate_journal(&appended, JOURNAL_CHAR_LIMIT);
    write_named_markdown(&run_dir, "board.md", &truncated)?;
    Ok(project_board_relative_path(run_id))
}

#[tauri::command]
pub async fn write_project_run_board(
    cwd: String,
    run_id: String,
    contents: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || write_project_run_board_inner(&cwd, &run_id, &contents))
        .await
        .map_err(|error| format!("write_project_run_board task failed: {error}"))?
}

#[tauri::command]
pub async fn append_project_run_board(
    cwd: String,
    run_id: String,
    heading: String,
    body: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        append_project_run_board_inner(&cwd, &run_id, &heading, &body)
    })
    .await
    .map_err(|error| format!("append_project_run_board task failed: {error}"))?
}

/// Runs a planner CLI headless (e.g. `gemini -p`) and returns its output. `stdin` carries the
/// long prompt so it never goes through argv (Windows `.cmd` shims mangle multi-line args).
#[tauri::command]
pub async fn run_planner_cli(
    bin: String,
    args: Vec<String>,
    cwd: String,
    timeout_ms: u64,
    stdin: Option<String>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || run_planner_cli_inner(bin, args, cwd, timeout_ms, stdin))
        .await
        .map_err(|error| format!("run_planner_cli task failed: {error}"))?
}

fn spawn_pipe_reader<R: Read + Send + 'static>(mut pipe: R) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = pipe.read_to_end(&mut buffer);
        buffer
    })
}

pub(crate) fn run_planner_cli_inner(
    bin: String,
    args: Vec<String>,
    cwd: String,
    timeout_ms: u64,
    stdin: Option<String>,
) -> Result<String, String> {
    if bin.trim().is_empty() {
        return Err("planner binary is empty".to_string());
    }
    // A WSL project (Windows build) runs the planner inside its distro; `bin` is then
    // the Linux path reported by `detect_agents_for_cwd`.
    let mut command = match crate::wsl::wsl_target_for_cwd(Some(&cwd)) {
        Some(target) => {
            let script = crate::wsl::agent_exec_script(&[bin.as_str()], &args);
            crate::wsl::wsl_command(&crate::wsl::wsl_exec_args(
                &target.distro,
                &target.linux_path,
                Some(&script),
            ))
        }
        None => {
            let mut command = Command::new(&bin);
            command.args(&args).current_dir(&cwd);
            hide_console(&mut command);
            command
        }
    };
    command
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    // Drain pipes on threads so a chatty planner cannot fill a pipe buffer and stall.
    let stdout_reader = child.stdout.take().map(spawn_pipe_reader);
    let stderr_reader = child.stderr.take().map(spawn_pipe_reader);
    if let (Some(input), Some(mut pipe)) = (stdin, child.stdin.take()) {
        thread::spawn(move || {
            let _ = pipe.write_all(input.as_bytes());
        });
    }
    let deadline = Instant::now() + Duration::from_millis(timeout_ms.max(1_000));
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("planner timed out".to_string());
            }
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(error) => return Err(error.to_string()),
        }
    };
    let collect = |reader: Option<thread::JoinHandle<Vec<u8>>>| {
        reader
            .and_then(|handle| handle.join().ok())
            .map(|bytes| String::from_utf8_lossy(&bytes).to_string())
            .unwrap_or_default()
    };
    let stdout = collect(stdout_reader);
    let stderr = collect(stderr_reader);
    if !status.success() && stdout.trim().is_empty() {
        return Err(if stderr.trim().is_empty() {
            format!("planner exited {status}")
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

    #[test]
    fn read_spec_markdown_accepts_md_and_rejects_others() {
        let dir = tempfile::tempdir().unwrap();
        let spec = dir.path().join("SPEC.md");
        fs::write(&spec, "# Spec\n").unwrap();
        assert_eq!(read_spec_markdown_inner(&spec).unwrap(), "# Spec\n");
        let text = dir.path().join("notes.txt");
        fs::write(&text, "x").unwrap();
        assert!(read_spec_markdown_inner(&text).is_err());
        let big = dir.path().join("big.md");
        fs::write(&big, vec![b'a'; (SPEC_MARKDOWN_MAX_BYTES + 1) as usize]).unwrap();
        assert_eq!(read_spec_markdown_inner(&big).unwrap_err(), "spec_too_large");
    }

    #[test]
    fn project_board_lives_in_the_project_and_is_gitignored() {
        let project = tempfile::tempdir().unwrap();
        let cwd = project.path().to_string_lossy().to_string();
        let relative = write_project_run_board_inner(&cwd, "run_1", "# Board\n").unwrap();
        assert_eq!(relative, ".flashwork/runs/run_1/board.md");
        let board = project.path().join(".flashwork/runs/run_1/board.md");
        assert_eq!(fs::read_to_string(&board).unwrap(), "# Board\n");
        let gitignore = fs::read_to_string(project.path().join(".flashwork/.gitignore")).unwrap();
        assert!(gitignore.lines().any(|line| line == "runs/"));

        append_project_run_board_inner(&cwd, "run_1", "Done", "t1 finished").unwrap();
        let after = fs::read_to_string(&board).unwrap();
        assert!(after.contains("# Board"));
        assert!(after.contains("t1 finished"));

        // A second write keeps a single gitignore entry.
        write_project_run_board_inner(&cwd, "run_2", "# Two\n").unwrap();
        let gitignore = fs::read_to_string(project.path().join(".flashwork/.gitignore")).unwrap();
        assert_eq!(gitignore.lines().filter(|line| *line == "runs/").count(), 1);
    }

    #[test]
    fn ensure_runs_gitignored_appends_to_existing_file() {
        let home = tempfile::tempdir().unwrap();
        fs::write(home.path().join(".gitignore"), "rag/cache").unwrap();
        ensure_runs_gitignored(home.path()).unwrap();
        assert_eq!(
            fs::read_to_string(home.path().join(".gitignore")).unwrap(),
            "rag/cache\nruns/\n"
        );
    }

    #[test]
    fn project_board_rejects_unsafe_run_ids() {
        let project = tempfile::tempdir().unwrap();
        let cwd = project.path().to_string_lossy().to_string();
        assert!(write_project_run_board_inner(&cwd, "../escape", "x").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn run_planner_cli_pipes_stdin_and_returns_stdout() {
        let dir = tempfile::tempdir().unwrap();
        let out = run_planner_cli_inner(
            "cat".to_string(),
            vec![],
            dir.path().to_string_lossy().to_string(),
            5_000,
            Some("{\"tasks\":[]}".to_string()),
        )
        .unwrap();
        assert_eq!(out, "{\"tasks\":[]}");
    }

    #[cfg(unix)]
    #[test]
    fn run_planner_cli_times_out() {
        let dir = tempfile::tempdir().unwrap();
        let error = run_planner_cli_inner(
            "sleep".to_string(),
            vec!["5".to_string()],
            dir.path().to_string_lossy().to_string(),
            1_000,
            None,
        )
        .unwrap_err();
        assert_eq!(error, "planner timed out");
    }

    #[cfg(unix)]
    #[test]
    fn run_planner_cli_drains_large_output() {
        let dir = tempfile::tempdir().unwrap();
        let out = run_planner_cli_inner(
            "head".to_string(),
            vec!["-c".to_string(), "200000".to_string(), "/dev/zero".to_string()],
            dir.path().to_string_lossy().to_string(),
            10_000,
            None,
        )
        .unwrap();
        assert_eq!(out.len(), 200_000);
    }
}
