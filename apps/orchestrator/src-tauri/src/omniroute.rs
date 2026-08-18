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
        .arg("--no-browser")
        .arg("--port")
        .arg(port.to_string())
        .env("INITIAL_PASSWORD", password)
        .env("PORT", port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    crate::git_control::hide_console(&mut command);
    command.spawn().map_err(|error| {
        if error.kind() == ErrorKind::NotFound {
            "9router is not on PATH".to_string()
        } else {
            format!("failed to start 9router: {error}")
        }
    })
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
        let _ = handle.child.kill();
        let _ = handle.child.wait();
    }
    Ok(())
}

#[tauri::command]
pub async fn omniroute_start(
    state: State<'_, OmniRouteState>,
    password: String,
    base_url: String,
) -> Result<OmniRouteStartResult, String> {
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
}
