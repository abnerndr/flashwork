//! GitHub **repository** SCM authentication (device flow, `gh`, OS keyring).
//!
//! This is **not** gist backup. App-state gist sync lives in `github_sync.rs` and
//! must keep using its own token. Do not reuse gist tokens here.

use std::collections::HashMap;
use std::fmt;
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

/// OS keyring service for the repo SCM token (plan name). Username is `repo-token`.
pub const KEYRING_SERVICE: &str = "flashwork.github.repo";
pub const KEYRING_USERNAME: &str = "repo-token";

/// Public OAuth App client id. Left empty so device-flow start fails closed
/// unless the owner sets `FLASHWORK_GITHUB_CLIENT_ID`.
pub const DEFAULT_GITHUB_OAUTH_CLIENT_ID: &str = "";

const USER_AGENT: &str = "Flashwork";
const DEVICE_SCOPE: &str = "repo";
const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const DEFAULT_DEVICE_URI: &str = "https://github.com/login/device";

/// Whether `url` is a github.com HTTPS remote (including `www.github.com`).
pub fn is_github_https_remote(url: &str) -> bool {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return false;
    }
    let Some(rest) = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("HTTPS://"))
    else {
        return false;
    };
    let host = rest.split('/').next().unwrap_or("").to_ascii_lowercase();
    let host = host.split(':').next().unwrap_or("");
    host == "github.com" || host == "www.github.com"
}

/// Env vars for `git` HTTPS extraheader. Empty unless the remote is GitHub
/// HTTPS **and** `token` is non-empty. Values must never be formatted into
/// error strings — use [`AuthEnv`] / [`format_auth_helper_error`].
pub fn github_https_extraheader_env(remote_url: &str, token: &str) -> HashMap<String, String> {
    github_https_extraheader_auth_env(remote_url, token).into_map()
}

/// Same as [`github_https_extraheader_env`] with a redacted `Debug` impl.
pub fn github_https_extraheader_auth_env(remote_url: &str, token: &str) -> AuthEnv {
    let mut env = HashMap::new();
    if !is_github_https_remote(remote_url) || token.trim().is_empty() {
        return AuthEnv { env };
    }
    env.insert("GIT_CONFIG_COUNT".into(), "1".into());
    env.insert(
        "GIT_CONFIG_KEY_0".into(),
        "http.https://github.com/.extraheader".into(),
    );
    env.insert(
        "GIT_CONFIG_VALUE_0".into(),
        format!("AUTHORIZATION: bearer {}", token.trim()),
    );
    env.insert("GIT_TERMINAL_PROMPT".into(), "0".into());
    AuthEnv { env }
}

/// Process environment for GitHub HTTPS extraheader. `Debug` never prints values.
#[derive(Clone, Default)]
pub struct AuthEnv {
    env: HashMap<String, String>,
}

impl AuthEnv {
    pub fn is_empty(&self) -> bool {
        self.env.is_empty()
    }

    pub fn into_map(self) -> HashMap<String, String> {
        self.env
    }

    pub fn iter(&self) -> impl Iterator<Item = (&String, &String)> {
        self.env.iter()
    }

    pub fn apply_to(&self, command: &mut Command) {
        for (key, value) in &self.env {
            command.env(key, value);
        }
    }
}

impl fmt::Debug for AuthEnv {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut keys: Vec<&str> = self.env.keys().map(String::as_str).collect();
        keys.sort_unstable();
        f.debug_struct("AuthEnv").field("keys", &keys).finish()
    }
}

impl fmt::Display for AuthEnv {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}

/// Error string for auth helpers. Never interpolates env values or tokens.
pub fn format_auth_helper_error(code: &str) -> String {
    code.to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TokenSource {
    Gh,
    Keyring,
}

/// Resolved repo token. `Debug` never prints the secret.
#[derive(Clone)]
pub struct ResolvedToken {
    token: String,
    pub source: TokenSource,
}

impl ResolvedToken {
    pub fn secret(&self) -> &str {
        &self.token
    }
}

impl fmt::Debug for ResolvedToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ResolvedToken")
            .field("source", &self.source)
            .field("token", &"[redacted]")
            .finish()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepoAuthStatus {
    pub connected: bool,
    pub source: Option<TokenSource>,
    pub login: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStartResult {
    pub session_id: String,
    pub user_code: String,
    pub verification_uri: String,
    pub interval: u64,
    pub expires_in: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DevicePollStatus {
    Pending,
    Complete,
    Denied,
    Expired,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicePollResult {
    pub status: DevicePollStatus,
    /// True when GitHub returned `slow_down`. The client must wait longer.
    #[serde(default)]
    pub slow_down: bool,
    /// Next poll interval in seconds when GitHub sent one with `slow_down`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interval: Option<u64>,
}

impl DevicePollResult {
    fn from_status(status: DevicePollStatus) -> Self {
        Self {
            status,
            slow_down: false,
            interval: None,
        }
    }
}

/// Parsed device-flow poll body. `slow_down` is only set when GitHub sent that error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParsedDevicePoll {
    pub status: DevicePollStatus,
    pub slow_down: bool,
}

/// RFC 8628: after `slow_down`, the interval MUST increase by at least 5 seconds.
pub const SLOW_DOWN_EXTRA_SECS: u64 = 5;

/// Next poll interval after `slow_down`: GitHub's `interval` if larger, else `current + 5`.
pub fn next_poll_interval(current: u64, github_interval: Option<u64>) -> u64 {
    let bumped = current.saturating_add(SLOW_DOWN_EXTRA_SECS);
    match github_interval {
        Some(v) => v.max(bumped),
        None => bumped,
    }
}

/// Parses a GitHub device-flow poll JSON body. Never logs the body.
pub fn parse_device_poll_body(value: &serde_json::Value) -> DevicePollStatus {
    parse_device_poll(value).status
}

/// Parses status and whether the body was a `slow_down` pending response.
pub fn parse_device_poll(value: &serde_json::Value) -> ParsedDevicePoll {
    if value
        .get("access_token")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .is_some_and(|t| !t.is_empty())
    {
        return ParsedDevicePoll {
            status: DevicePollStatus::Complete,
            slow_down: false,
        };
    }
    match value.get("error").and_then(|v| v.as_str()) {
        Some("authorization_pending") => ParsedDevicePoll {
            status: DevicePollStatus::Pending,
            slow_down: false,
        },
        Some("slow_down") => ParsedDevicePoll {
            status: DevicePollStatus::Pending,
            slow_down: true,
        },
        Some("access_denied") => ParsedDevicePoll {
            status: DevicePollStatus::Denied,
            slow_down: false,
        },
        Some("expired_token") => ParsedDevicePoll {
            status: DevicePollStatus::Expired,
            slow_down: false,
        },
        _ => ParsedDevicePoll {
            status: DevicePollStatus::Error,
            slow_down: false,
        },
    }
}

/// Maps a GitHub poll body to the IPC result, including `slow_down` + interval.
pub fn device_poll_result_from_body(value: &serde_json::Value) -> DevicePollResult {
    let parsed = parse_device_poll(value);
    DevicePollResult {
        status: parsed.status,
        slow_down: parsed.slow_down,
        interval: if parsed.slow_down {
            value.get("interval").and_then(|v| v.as_u64())
        } else {
            None
        },
    }
}

/// Injectable store so device-flow success can be tested without a live keyring.
pub trait RepoTokenStore {
    fn store(&self, token: &str) -> Result<(), String>;
    fn read(&self) -> Result<Option<String>, String>;
    fn clear(&self) -> Result<(), String>;
}

/// On poll success, persist the token via `store`. Never logs the token.
pub fn apply_device_poll_success<S: RepoTokenStore>(
    value: &serde_json::Value,
    store: &S,
) -> Result<DevicePollStatus, String> {
    let status = parse_device_poll_body(value);
    if status == DevicePollStatus::Complete {
        if let Some(token) = value.get("access_token").and_then(|v| v.as_str()) {
            store.store(token.trim())?;
        }
    }
    Ok(status)
}

/// Resolves the OAuth client id: explicit override, then env, then compile-time, then default.
pub fn resolve_github_client_id(explicit: Option<&str>) -> String {
    if let Some(id) = explicit.map(str::trim).filter(|id| !id.is_empty()) {
        return id.to_string();
    }
    if let Ok(id) = std::env::var("FLASHWORK_GITHUB_CLIENT_ID") {
        let trimmed = id.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Some(id) = option_env!("FLASHWORK_GITHUB_CLIENT_ID") {
        let trimmed = id.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    DEFAULT_GITHUB_OAUTH_CLIENT_ID.to_string()
}

/// Prefer `gh auth token` (non-empty trimmed stdout) over the keyring reader.
pub fn resolve_repo_token_with<G, K>(
    try_gh: G,
    try_keyring: K,
) -> Result<Option<ResolvedToken>, String>
where
    G: FnOnce() -> Result<Option<String>, String>,
    K: FnOnce() -> Result<Option<String>, String>,
{
    match try_gh() {
        Ok(Some(token)) => {
            let trimmed = token.trim();
            if !trimmed.is_empty() {
                return Ok(Some(ResolvedToken {
                    token: trimmed.to_string(),
                    source: TokenSource::Gh,
                }));
            }
        }
        Ok(None) => {}
        Err(_) => {}
    }
    match try_keyring()? {
        Some(token) => {
            let trimmed = token.trim();
            if trimmed.is_empty() {
                Ok(None)
            } else {
                Ok(Some(ResolvedToken {
                    token: trimmed.to_string(),
                    source: TokenSource::Keyring,
                }))
            }
        }
        None => Ok(None),
    }
}

/// Runs `gh auth token`. Maps every failure to `gh_auth_unavailable`.
/// Never prints stdout/stderr (they may contain the token).
pub fn try_gh_auth_token() -> Result<Option<String>, String> {
    try_gh_auth_token_with_path(None)
}

fn try_gh_auth_token_with_path(
    path_override: Option<&std::ffi::OsStr>,
) -> Result<Option<String>, String> {
    let mut command = Command::new("gh");
    command
        .args(["auth", "token"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(path) = path_override {
        command.env("PATH", path);
    }
    crate::git_control::hide_console(&mut command);
    let output = command
        .output()
        .map_err(|_| "gh_auth_unavailable".to_string())?;
    if !output.status.success() {
        return Err("gh_auth_unavailable".to_string());
    }
    let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if token.is_empty() {
        Ok(None)
    } else {
        Ok(Some(token))
    }
}

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USERNAME).map_err(|error| error.to_string())
}

fn try_keyring_token() -> Result<Option<String>, String> {
    let entry = keyring_entry()?;
    match entry.get_password() {
        Ok(secret) => {
            let trimmed = secret.trim();
            if trimmed.is_empty() {
                Ok(None)
            } else {
                Ok(Some(trimmed.to_string()))
            }
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format_auth_helper_error(&format!(
            "github_repo_keyring:{error}"
        ))),
    }
}

struct OsKeyringStore;

impl RepoTokenStore for OsKeyringStore {
    fn store(&self, token: &str) -> Result<(), String> {
        let trimmed = token.trim();
        if trimmed.is_empty() {
            return Err("empty_token".to_string());
        }
        keyring_entry()?
            .set_password(trimmed)
            .map_err(|error| format_auth_helper_error(&format!("github_repo_keyring_set:{error}")))
    }

    fn read(&self) -> Result<Option<String>, String> {
        try_keyring_token()
    }

    fn clear(&self) -> Result<(), String> {
        match keyring_entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(format_auth_helper_error(&format!(
                "github_repo_keyring_clear:{error}"
            ))),
        }
    }
}

/// Resolve a repo token: `gh auth token` first, then OS keyring. Never logs it.
pub fn resolve_repo_token() -> Result<Option<ResolvedToken>, String> {
    resolve_repo_token_with(try_gh_auth_token, try_keyring_token)
}

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

struct DeviceSession {
    device_code: String,
    expires_at: Instant,
}

fn device_sessions() -> &'static Mutex<HashMap<String, DeviceSession>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, DeviceSession>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .map_err(|_| "github_http_client".to_string())
}

#[derive(Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: Option<String>,
    verification_uri_complete: Option<String>,
    expires_in: Option<u64>,
    interval: Option<u64>,
    error: Option<String>,
}

async fn request_device_code(client_id: &str) -> Result<DeviceCodeResponse, String> {
    let client = http_client()?;
    let response = client
        .post(DEVICE_CODE_URL)
        .header("Accept", "application/json")
        .header("User-Agent", USER_AGENT)
        .form(&[("client_id", client_id), ("scope", DEVICE_SCOPE)])
        .send()
        .await
        .map_err(|_| "github_device_request_failed".to_string())?;
    if !response.status().is_success() {
        return Err("github_device_request_failed".to_string());
    }
    response
        .json::<DeviceCodeResponse>()
        .await
        .map_err(|_| "github_device_request_failed".to_string())
}

#[tauri::command]
pub fn github_repo_auth_status() -> Result<GithubRepoAuthStatus, String> {
    match resolve_repo_token()? {
        Some(resolved) => Ok(GithubRepoAuthStatus {
            connected: true,
            source: Some(resolved.source),
            login: None,
        }),
        None => Ok(GithubRepoAuthStatus {
            connected: false,
            source: None,
            login: None,
        }),
    }
}

#[tauri::command]
pub async fn github_repo_device_start() -> Result<DeviceStartResult, String> {
    let client_id = resolve_github_client_id(None);
    if client_id.is_empty() {
        return Err("github_device_unconfigured".to_string());
    }
    let body = request_device_code(&client_id).await?;
    if body.error.as_deref().is_some_and(|e| !e.is_empty()) {
        return Err("github_device_request_failed".to_string());
    }
    if body.device_code.trim().is_empty() || body.user_code.trim().is_empty() {
        return Err("github_device_request_failed".to_string());
    }
    let session_id = nanoid::nanoid!(12);
    let expires_in = body.expires_in.unwrap_or(900);
    let interval = body.interval.unwrap_or(5);
    let verification_uri = body
        .verification_uri
        .filter(|u| !u.trim().is_empty())
        .or(body.verification_uri_complete)
        .unwrap_or_else(|| DEFAULT_DEVICE_URI.to_string());
    {
        let mut sessions = device_sessions()
            .lock()
            .map_err(|_| "github_device_session".to_string())?;
        sessions.insert(
            session_id.clone(),
            DeviceSession {
                device_code: body.device_code,
                expires_at: Instant::now() + Duration::from_secs(expires_in),
            },
        );
    }
    Ok(DeviceStartResult {
        session_id,
        user_code: body.user_code,
        verification_uri,
        interval,
        expires_in,
    })
}

#[tauri::command]
pub async fn github_repo_device_poll(session_id: String) -> Result<DevicePollResult, String> {
    let session = {
        let sessions = device_sessions()
            .lock()
            .map_err(|_| "github_device_session".to_string())?;
        sessions.get(&session_id).map(|s| DeviceSession {
            device_code: s.device_code.clone(),
            expires_at: s.expires_at,
        })
    };
    let Some(session) = session else {
        return Ok(DevicePollResult::from_status(DevicePollStatus::Expired));
    };
    if Instant::now() >= session.expires_at {
        let _ = forget_session(&session_id);
        return Ok(DevicePollResult::from_status(DevicePollStatus::Expired));
    }
    let client_id = resolve_github_client_id(None);
    if client_id.is_empty() {
        return Err("github_device_unconfigured".to_string());
    }
    let client = http_client()?;
    let response = client
        .post(ACCESS_TOKEN_URL)
        .header("Accept", "application/json")
        .header("User-Agent", USER_AGENT)
        .form(&[
            ("client_id", client_id.as_str()),
            ("device_code", session.device_code.as_str()),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send()
        .await
        .map_err(|_| "github_device_poll_failed".to_string())?;
    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|_| "github_device_poll_failed".to_string())?;
    let status = apply_device_poll_success(&value, &OsKeyringStore)?;
    if matches!(
        status,
        DevicePollStatus::Complete | DevicePollStatus::Denied | DevicePollStatus::Expired
    ) {
        let _ = forget_session(&session_id);
    }
    let mut result = device_poll_result_from_body(&value);
    result.status = status;
    Ok(result)
}

fn forget_session(session_id: &str) -> Result<(), String> {
    device_sessions()
        .lock()
        .map_err(|_| "github_device_session".to_string())?
        .remove(session_id);
    Ok(())
}

#[tauri::command]
pub fn github_repo_auth_logout() -> Result<GithubRepoAuthStatus, String> {
    OsKeyringStore.clear()?;
    github_repo_auth_status()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::Mutex;

    struct MemoryStore {
        token: Mutex<Option<String>>,
    }

    impl MemoryStore {
        fn new() -> Self {
            Self {
                token: Mutex::new(None),
            }
        }
    }

    impl RepoTokenStore for MemoryStore {
        fn store(&self, token: &str) -> Result<(), String> {
            *self.token.lock().unwrap() = Some(token.to_string());
            Ok(())
        }

        fn read(&self) -> Result<Option<String>, String> {
            Ok(self.token.lock().unwrap().clone())
        }

        fn clear(&self) -> Result<(), String> {
            *self.token.lock().unwrap() = None;
            Ok(())
        }
    }

    #[test]
    fn is_github_https_remote_accepts_github_https() {
        assert!(is_github_https_remote("https://github.com/acme/app.git"));
        assert!(is_github_https_remote(
            "https://www.github.com/acme/app.git"
        ));
    }

    #[test]
    fn is_github_https_remote_rejects_ssh_gitlab_and_empty() {
        assert!(!is_github_https_remote("git@github.com:acme/app.git"));
        assert!(!is_github_https_remote("https://gitlab.com/acme/app.git"));
        assert!(!is_github_https_remote(""));
        assert!(!is_github_https_remote("   "));
    }

    #[test]
    fn extraheader_env_is_built_only_for_github_https_with_token() {
        let token = "gho_secret_test_token";
        let github = github_https_extraheader_env("https://github.com/acme/app.git", token);
        assert_eq!(
            github.get("GIT_CONFIG_COUNT").map(String::as_str),
            Some("1")
        );
        assert_eq!(
            github.get("GIT_CONFIG_KEY_0").map(String::as_str),
            Some("http.https://github.com/.extraheader")
        );
        assert_eq!(
            github.get("GIT_CONFIG_VALUE_0").map(String::as_str),
            Some("AUTHORIZATION: bearer gho_secret_test_token")
        );
        assert_eq!(
            github.get("GIT_TERMINAL_PROMPT").map(String::as_str),
            Some("0")
        );

        assert!(github_https_extraheader_env("git@github.com:acme/app.git", token).is_empty());
        assert!(github_https_extraheader_env("https://gitlab.com/acme/app.git", token).is_empty());
        assert!(github_https_extraheader_env("https://github.com/acme/app.git", "").is_empty());
        assert!(github_https_extraheader_env("https://github.com/acme/app.git", "  ").is_empty());
    }

    #[test]
    fn extraheader_env_values_are_not_formatted_into_error_strings() {
        let token = "gho_must_never_appear_in_errors";
        let env = github_https_extraheader_auth_env("https://github.com/acme/app.git", token);
        let debug = format!("{env:?}");
        let display = format!("{env}");
        let helper_error = format_auth_helper_error("github_auth_failed");
        assert!(!debug.contains(token), "Debug leaked token: {debug}");
        assert!(!display.contains(token), "Display leaked token: {display}");
        assert!(
            !helper_error.contains(token),
            "helper error leaked token: {helper_error}"
        );
    }

    #[test]
    fn auth_helper_debug_formatting_does_not_contain_the_token() {
        let token = "gho_debug_leak_probe_token";
        let resolved = resolve_repo_token_with(
            || Ok(Some(token.to_string())),
            || Ok(Some("keyring-should-lose".to_string())),
        )
        .unwrap()
        .unwrap();
        let debug = format!("{resolved:?}");
        assert!(
            !debug.contains(token),
            "resolved debug leaked token: {debug}"
        );
        let env = github_https_extraheader_auth_env("https://github.com/acme/app.git", token);
        let combined = format!("{env:?} {resolved:?}");
        assert!(!combined.contains(token));
    }

    #[test]
    fn device_poll_authorization_pending_is_pending() {
        let body = serde_json::json!({ "error": "authorization_pending" });
        assert_eq!(parse_device_poll_body(&body), DevicePollStatus::Pending);
        let result = device_poll_result_from_body(&body);
        assert_eq!(result.status, DevicePollStatus::Pending);
        assert!(!result.slow_down);
        assert_eq!(result.interval, None);
    }

    #[test]
    fn device_poll_slow_down_is_pending_and_surfaces_interval() {
        let body = serde_json::json!({ "error": "slow_down", "interval": 10 });
        assert_eq!(parse_device_poll_body(&body), DevicePollStatus::Pending);
        let parsed = parse_device_poll(&body);
        assert_eq!(parsed.status, DevicePollStatus::Pending);
        assert!(parsed.slow_down);
        let result = device_poll_result_from_body(&body);
        assert_eq!(result.status, DevicePollStatus::Pending);
        assert!(result.slow_down);
        assert_eq!(result.interval, Some(10));
        assert_eq!(next_poll_interval(5, result.interval), 10);
        assert_eq!(next_poll_interval(5, None), 10);
        assert_eq!(next_poll_interval(5, Some(6)), 10);
    }

    #[test]
    fn device_poll_access_denied_is_denied() {
        let body = serde_json::json!({ "error": "access_denied" });
        assert_eq!(parse_device_poll_body(&body), DevicePollStatus::Denied);
    }

    #[test]
    fn device_poll_success_stores_token_via_injectable_store() {
        let token = "gho_device_success_token";
        let body = serde_json::json!({ "access_token": token, "token_type": "bearer" });
        let store = MemoryStore::new();
        let status = apply_device_poll_success(&body, &store).unwrap();
        assert_eq!(status, DevicePollStatus::Complete);
        assert_eq!(store.read().unwrap().as_deref(), Some(token));
    }

    #[test]
    fn device_start_fails_closed_when_client_id_is_empty() {
        assert_eq!(resolve_github_client_id(Some("")), "");
        assert_eq!(resolve_github_client_id(Some("   ")), "");
        let id = resolve_github_client_id(Some("Iv1.testclient"));
        assert_eq!(id, "Iv1.testclient");
    }

    #[test]
    fn prefers_gh_token_over_keyring_when_fake_gh_is_on_path() {
        let token = "gho_fake_gh_path_token";
        let dir = std::env::temp_dir().join(format!(
            "flashwork-gh-auth-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let gh_path = dir.join("gh");
        fs::write(&gh_path, format!("#!/bin/sh\nprintf '%s\\n' '{token}'\n")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&gh_path, fs::Permissions::from_mode(0o755)).unwrap();
        }

        let mut path = dir.to_string_lossy().into_owned();
        if let Ok(existing) = std::env::var("PATH") {
            path.push(':');
            path.push_str(&existing);
        }

        let from_gh = try_gh_auth_token_with_path(Some(std::ffi::OsStr::new(&path))).unwrap();
        assert_eq!(from_gh.as_deref(), Some(token));

        let resolved = resolve_repo_token_with(
            || try_gh_auth_token_with_path(Some(std::ffi::OsStr::new(&path))),
            || Ok(Some("gho_keyring_should_lose".to_string())),
        )
        .unwrap()
        .unwrap();
        assert_eq!(resolved.source, TokenSource::Gh);
        assert_eq!(resolved.secret(), token);

        fs::remove_dir_all(&dir).unwrap();
    }
}
