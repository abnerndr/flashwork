use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use tauri::AppHandle;

use crate::git_control::hide_console;

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
}
