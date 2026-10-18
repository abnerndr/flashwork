use serde::Serialize;
use std::path::Path;
use std::process::Command;

#[derive(Serialize)]
pub struct OpenCodeSessionSnapshot {
    pub id: String,
    pub modified_at_ms: u128,
}

/// Canonical spelling for comparing an OpenCode session `directory` with a cwd.
/// A WSL UNC path (`\\wsl.localhost\Ubuntu\home\u\p`) compares as the Linux
/// path the in-distro CLI records (`/home/u/p`).
fn normalize_path(path: &str) -> String {
    if let Some(wsl) = crate::wsl::parse_wsl_unc(path) {
        return wsl.linux_path.trim_end_matches('/').to_string();
    }
    let trimmed = path
        .trim()
        .trim_end_matches(|c: char| c == '\\' || c == '/');
    let unprefixed = trimmed
        .strip_prefix(r"\\?\UNC\")
        .map(|rest| format!(r"\\{rest}"))
        .unwrap_or_else(|| trimmed.strip_prefix(r"\\?\").unwrap_or(trimmed).to_string());
    if unprefixed.starts_with('/') {
        return unprefixed;
    }
    if cfg!(windows) {
        unprefixed.replace('/', "\\").to_ascii_lowercase()
    } else {
        unprefixed
    }
}

/// `async` + `spawn_blocking`: runs a subprocess (`opencode session list`).
#[tauri::command]
pub async fn snapshot_opencode_sessions(
    cwd: String,
) -> Result<Vec<OpenCodeSessionSnapshot>, String> {
    tokio::task::spawn_blocking(move || snapshot_opencode_sessions_inner(cwd))
        .await
        .map_err(|error| format!("snapshot_opencode_sessions: falha na task bloqueante: {error}"))?
}

fn snapshot_opencode_sessions_inner(cwd: String) -> Result<Vec<OpenCodeSessionSnapshot>, String> {
    const LIST_ARGS: [&str; 6] = ["session", "list", "--format", "json", "--max-count", "50"];
    let mut command = if let Some(target) = crate::wsl::wsl_target_for_cwd(Some(&cwd)) {
        // Project inside a distro: ask the distro's opencode, from the Linux cwd.
        let args: Vec<String> = LIST_ARGS.iter().map(|a| a.to_string()).collect();
        let script = crate::wsl::agent_exec_script(&["opencode"], &args);
        crate::wsl::wsl_command(&crate::wsl::wsl_exec_args(
            &target.distro,
            &target.linux_path,
            Some(&script),
        ))
    } else {
        let mut command = Command::new("opencode");
        command.args(LIST_ARGS);
        if !cwd.is_empty() && Path::new(&cwd).is_dir() {
            command.current_dir(crate::worktrees::git_arg(Path::new(&cwd)));
        }
        command
    };
    let output = command
        .output()
        .map_err(|e| format!("falha ao executar opencode: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("opencode session list falhou: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);

    if stdout.trim().is_empty() {
        return Ok(Vec::new());
    }
    let entries: Vec<serde_json::Value> =
        serde_json::from_str(&stdout).map_err(|e| format!("falha ao parsear JSON: {e}"))?;

    let target = normalize_path(&cwd);
    let mut sessions: Vec<OpenCodeSessionSnapshot> = entries
        .into_iter()
        .filter_map(|entry| {
            let id = entry.get("id")?.as_str()?.to_string();
            let updated = entry.get("updated")?.as_f64()? as u128;

            if !target.is_empty() {
                if let Some(directory) = entry.get("directory").and_then(|d| d.as_str()) {
                    if normalize_path(directory) != target {
                        return None;
                    }
                }
            }
            Some(OpenCodeSessionSnapshot {
                id,
                modified_at_ms: updated,
            })
        })
        .collect();

    sessions.sort_by(|a, b| b.modified_at_ms.cmp(&a.modified_at_ms));
    Ok(sessions)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wsl_unc_and_linux_spellings_compare_equal() {
        assert_eq!(normalize_path(r"\\wsl.localhost\Ubuntu\home\u\p\"), "/home/u/p");
        assert_eq!(normalize_path(r"\\?\UNC\wsl$\Ubuntu\home\u\p"), "/home/u/p");
        assert_eq!(normalize_path("/home/u/p/"), "/home/u/p");
    }
}
