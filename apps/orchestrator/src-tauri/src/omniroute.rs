use std::io::ErrorKind;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::State;

const GATEWAY_SERVICE: &str = "flashwork";
const GATEWAY_USER: &str = "omniroute-gateway";
const HEALTH_TIMEOUT: Duration = Duration::from_millis(500);

pub struct SidecarHandle {
    child: Child,
    started_by_app: bool,
}

#[derive(Clone, Default)]
pub struct OmniRouteState(Arc<Mutex<Option<SidecarHandle>>>);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OmniRouteStartResult {
    pub started_by_app: bool,
    pub already_running: bool,
}

/// Accepts only `http://127.0.0.1:<port>` (optional trailing slash).
/// `localhost` and non-loopback hosts are rejected so WSL/IPv6 cannot bind the wrong interface.
pub(crate) fn parse_loopback_port(base_url: &str) -> Result<u16, String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    let rest = trimmed
        .strip_prefix("http://")
        .ok_or_else(|| "base_url must be http://127.0.0.1:<port>".to_string())?;
    if rest.contains('/') || rest.contains('@') || rest.contains('[') {
        return Err("base_url must be http://127.0.0.1:<port>".into());
    }
    let (host, port_str) = rest
        .rsplit_once(':')
        .ok_or_else(|| "base_url must include a port".to_string())?;
    if host != "127.0.0.1" {
        return Err("only http://127.0.0.1:<port> is allowed".into());
    }
    let port: u16 = port_str.parse().map_err(|_| "invalid port".to_string())?;
    if port == 0 {
        return Err("invalid port".into());
    }
    Ok(port)
}

pub(crate) fn require_initial_password(password: &str) -> Result<(), String> {
    if password.trim().is_empty() {
        return Err("password must not be empty".into());
    }
    Ok(())
}

pub(crate) fn sidecar_args(port: u16) -> Vec<String> {
    vec![
        "--no-browser".into(),
        "--host".into(),
        "127.0.0.1".into(),
        "--port".into(),
        port.to_string(),
    ]
}

async fn health_get_ok(port: u16) -> bool {
    let Ok(client) = reqwest::Client::builder()
        .timeout(HEALTH_TIMEOUT)
        .no_proxy()
        .build()
    else {
        return false;
    };
    let url = format!("http://127.0.0.1:{port}/");
    client.get(url).send().await.is_ok()
}

fn spawn_sidecar(port: u16, password: &str) -> Result<Child, String> {
    let mut command = Command::new("9router");
    command
        .args(sidecar_args(port))
        .env("INITIAL_PASSWORD", password)
        .env("PORT", port.to_string())
        .env("HOSTNAME", "127.0.0.1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Own process group so SIGTERM/SIGKILL can reach the Next child, not only the CLI.
        command.process_group(0);
    }
    crate::git_control::hide_console(&mut command);
    command.spawn().map_err(|error| {
        if error.kind() == ErrorKind::NotFound {
            "9router is not on PATH".to_string()
        } else {
            format!("failed to start 9router: {error}")
        }
    })
}

#[cfg(unix)]
const STOP_GRACE: Duration = Duration::from_secs(2);

#[cfg(unix)]
fn send_unix_signal(pid: u32, signal: &str) {
    let mut command = Command::new("kill");
    command
        .args([signal, "--", &format!("-{pid}")])
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let _ = command.status();
}

#[cfg(unix)]
fn wait_for_exit(child: &mut Child, timeout: Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    return false;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return true,
        }
    }
}

fn stop_owned_child(child: &mut Child) {
    #[cfg(windows)]
    {
        crate::pty::kill_process_tree(child.id());
        let _ = child.wait();
    }
    #[cfg(unix)]
    {
        let pid = child.id();
        // SIGTERM first so 9router can reap server.pid (Next). SIGKILL skips that cleanup.
        send_unix_signal(pid, "-TERM");
        if wait_for_exit(child, STOP_GRACE) {
            return;
        }
        send_unix_signal(pid, "-KILL");
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Kill the sidecar only when this process spawned it. Foreign listeners are left alone.
pub fn stop_owned_sidecar(state: &OmniRouteState) -> Result<(), String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "omniroute lock poisoned".to_string())?;
    let Some(mut handle) = guard.take() else {
        return Ok(());
    };
    if handle.started_by_app {
        stop_owned_child(&mut handle.child);
    }
    Ok(())
}

#[tauri::command]
pub async fn omniroute_start(
    state: State<'_, OmniRouteState>,
    password: String,
    base_url: String,
) -> Result<OmniRouteStartResult, String> {
    require_initial_password(&password)?;
    let port = parse_loopback_port(&base_url)?;
    if health_get_ok(port).await {
        return Ok(OmniRouteStartResult {
            started_by_app: false,
            already_running: true,
        });
    }

    let mut guard = state
        .0
        .lock()
        .map_err(|_| "omniroute lock poisoned".to_string())?;
    if let Some(handle) = guard.as_mut() {
        if handle.started_by_app {
            if let Ok(None) = handle.child.try_wait() {
                return Ok(OmniRouteStartResult {
                    started_by_app: true,
                    already_running: true,
                });
            }
        }
    }

    let child = spawn_sidecar(port, &password)?;
    *guard = Some(SidecarHandle {
        child,
        started_by_app: true,
    });
    Ok(OmniRouteStartResult {
        started_by_app: true,
        already_running: false,
    })
}

#[tauri::command]
pub fn omniroute_stop(state: State<'_, OmniRouteState>) -> Result<(), String> {
    stop_owned_sidecar(state.inner())
}

fn gateway_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(GATEWAY_SERVICE, GATEWAY_USER).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn omniroute_set_gateway_key(key: String) -> Result<(), String> {
    let entry = gateway_entry()?;
    if key.is_empty() {
        return match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.to_string()),
        };
    }
    entry.set_password(&key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn omniroute_get_gateway_key() -> Result<Option<String>, String> {
    let entry = gateway_entry()?;
    match entry.get_password() {
        Ok(value) if value.is_empty() => Ok(None),
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_loopback_http_only() {
        assert!(parse_loopback_port("http://127.0.0.1:20128").ok() == Some(20128));
        assert!(parse_loopback_port("http://localhost:20128").is_err());
        assert!(parse_loopback_port("http://0.0.0.0:20128").is_err());
    }

    #[test]
    fn spawn_args_bind_loopback_host_and_port() {
        let args = sidecar_args(20128);
        assert!(
            args.windows(2)
                .any(|pair| pair[0] == "--host" && pair[1] == "127.0.0.1"),
            "spawn args must include --host 127.0.0.1, got {args:?}"
        );
        assert!(
            args.windows(2)
                .any(|pair| pair[0] == "--port" && pair[1] == "20128"),
            "spawn args must include --port, got {args:?}"
        );
    }

    #[test]
    fn rejects_empty_password() {
        assert!(require_initial_password("").is_err());
        assert!(require_initial_password("   ").is_err());
        assert!(require_initial_password("secret").is_ok());
    }
}
