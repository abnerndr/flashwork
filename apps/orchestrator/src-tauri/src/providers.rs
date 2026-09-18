//! OS keyring storage for provider API keys (ADR 010).
//!
//! Each supported provider gets its own keyring entry: service
//! `flashwork.provider.<id>`, username `api-key`. The key itself is never
//! returned to the WebView — `provider_key_status` only reports whether a
//! non-empty secret is present.
//!
//! Validation is factored into plain functions (`validate_key_input`,
//! `validate_provider_id`) so unit tests can cover the rejection rules
//! without touching a live OS Secret Service / Keychain.

use keyring::Entry;
use std::collections::HashMap;
use std::time::Duration;

/// v1 provider ids. Keep in sync with `ProviderId` in
/// `src/lib/providers/modelCatalog.ts`.
const PROVIDER_IDS: [&str; 3] = ["anthropic", "openai", "google"];

const KEYRING_USERNAME: &str = "api-key";

/// Locked mapping (ADR 010): provider id -> CLI env var name(s) it feeds.
/// Keep in sync with `PROVIDER_CLI_ENV` in
/// `src/lib/providers/envForCli.ts`.
fn cli_env_names(id: &str) -> &'static [&'static str] {
    match id {
        "anthropic" => &["ANTHROPIC_API_KEY"],
        "openai" => &["OPENAI_API_KEY"],
        "google" => &["GEMINI_API_KEY", "GOOGLE_API_KEY"],
        _ => &[],
    }
}

fn is_known_provider(id: &str) -> bool {
    PROVIDER_IDS.contains(&id)
}

fn keyring_service(id: &str) -> String {
    format!("flashwork.provider.{id}")
}

fn validate_provider_id(id: &str) -> Result<(), String> {
    if !is_known_provider(id) {
        return Err(format!("Unknown provider id: {id}"));
    }
    Ok(())
}

/// Rejects unknown provider ids and empty/whitespace-only keys before any
/// keyring I/O happens.
fn validate_key_input(id: &str, key: &str) -> Result<(), String> {
    validate_provider_id(id)?;
    if key.trim().is_empty() {
        return Err("API key cannot be empty".to_string());
    }
    Ok(())
}

fn open_entry(id: &str) -> Result<Entry, String> {
    Entry::new(&keyring_service(id), KEYRING_USERNAME).map_err(|error| error.to_string())
}

#[derive(serde::Serialize)]
pub struct ProviderKeyStatus {
    pub saved: bool,
}

/// Stores the trimmed key under the OS keyring entry for `id`. Never logs the
/// key value; only the (non-secret) error message is propagated on failure.
#[tauri::command]
pub fn provider_key_set(id: String, key: String) -> Result<(), String> {
    validate_key_input(&id, &key)?;
    let entry = open_entry(&id)?;
    entry
        .set_password(key.trim())
        .map_err(|error| format!("provider_key_set:{error}"))
}

/// Reports whether a non-empty secret is stored for `id`. Never returns the
/// secret itself to the caller (the WebView).
#[tauri::command]
pub fn provider_key_status(id: String) -> Result<ProviderKeyStatus, String> {
    validate_provider_id(&id)?;
    let entry = open_entry(&id)?;
    let saved = matches!(entry.get_password(), Ok(secret) if !secret.trim().is_empty());
    Ok(ProviderKeyStatus { saved })
}

/// Deletes the stored key for `id`. Treated as a no-op success if nothing was
/// stored yet.
#[tauri::command]
pub fn provider_key_clear(id: String) -> Result<(), String> {
    validate_provider_id(&id)?;
    let entry = open_entry(&id)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("provider_key_clear:{error}")),
    }
}

/// Pure builder: given a provider id and an already-read secret, returns the
/// env var map for that provider (ADR 010's `PROVIDER_CLI_ENV`), or empty for
/// an unknown id or blank secret. Kept separate from keyring I/O so the
/// key-name mapping is testable with a fake secret, without a live OS Secret
/// Service / Keychain.
fn build_cli_env(id: &str, secret: &str) -> HashMap<String, String> {
    let mut env = HashMap::new();
    let secret = secret.trim();
    if secret.is_empty() {
        return env;
    }
    for name in cli_env_names(id) {
        env.insert(name.to_string(), secret.to_string());
    }
    env
}

/// Reads the keyring for `id` and returns the env vars a matching CLI spawn
/// should get, or an empty map if the id is unknown or nothing is stored yet.
/// Never logs the secret — callers must not print this map's values either
/// (see `pty.rs` spawn logging).
///
/// Used at spawn time when the frontend sends `{ useProviderKey: true,
/// provider: <id> }`; the toggle being on with no stored key is not an
/// error — the spawn proceeds and injects nothing.
pub(crate) fn provider_cli_env(id: &str) -> HashMap<String, String> {
    if cli_env_names(id).is_empty() {
        return HashMap::new();
    }
    let Ok(entry) = open_entry(id) else {
        return HashMap::new();
    };
    let Ok(secret) = entry.get_password() else {
        return HashMap::new();
    };
    build_cli_env(id, &secret)
}

// --- Direct chat completion (Task 4, P07 / no-CLI) -------------------------
//
// `provider_chat` talks to each vendor's official HTTPS API directly, using
// the key already stored by `provider_key_set`. No third-party LLM gateway
// of any kind is ever involved — see ADR 006/009/010.
//
// Errors returned to the WebView are short, stable strings. HTTP 401 always
// maps to `provider_unauthorized` (locked contract) with no retry. Timeout
// and transport failures are also mapped to fixed strings rather than the
// raw `reqwest::Error` message, because that message can embed the request
// URL — which, for Google, includes the API key as a `?key=` query param.

/// Router-role calls (fast, cheap models) default to this timeout when the
/// caller omits `timeoutMs` or passes `0`.
pub const ROUTER_TIMEOUT_MS: u64 = 2_500;
/// Coding-role calls (slower, higher-quality models) use this timeout.
/// Documented here for the locked contract; the caller (frontend) is the one
/// that actually supplies `timeoutMs = 120_000` for coding-role calls.
#[allow(dead_code)]
pub const CODING_TIMEOUT_MS: u64 = 120_000;
/// Timeout for the (user-triggered) catalog refresh GET requests.
const CATALOG_REFRESH_TIMEOUT_MS: u64 = 10_000;

/// Locked error string (see task-4 brief): HTTP 401 from any vendor maps to
/// this, unconditionally, with no retry and no fallback to any other gateway.
const UNAUTHORIZED_ERROR: &str = "provider_unauthorized";

fn http_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

#[derive(serde::Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(serde::Serialize)]
pub struct ChatResponse {
    pub text: String,
}

/// `0`/omitted means "use the router-role default" (locked contract).
fn resolve_timeout_ms(timeout_ms: u64) -> u64 {
    if timeout_ms == 0 {
        ROUTER_TIMEOUT_MS
    } else {
        timeout_ms
    }
}

/// Maps a non-2xx HTTP status to a stable error string. `401` always maps to
/// the locked `provider_unauthorized` string; everything else carries the
/// numeric status so callers/logs can tell failures apart without leaking
/// any response body (which may echo request headers/params back).
fn map_status_error(status_code: u16) -> String {
    if status_code == 401 {
        UNAUTHORIZED_ERROR.to_string()
    } else {
        format!("provider_http_error:{status_code}")
    }
}

fn chat_url(provider: &str, model: &str) -> Result<String, String> {
    match provider {
        "anthropic" => Ok("https://api.anthropic.com/v1/messages".to_string()),
        "openai" => Ok("https://api.openai.com/v1/chat/completions".to_string()),
        "google" => Ok(format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        )),
        _ => Err(format!("Unknown provider id: {provider}")),
    }
}

fn models_list_url(provider: &str) -> Result<String, String> {
    match provider {
        "anthropic" => Ok("https://api.anthropic.com/v1/models".to_string()),
        "openai" => Ok("https://api.openai.com/v1/models".to_string()),
        "google" => Ok("https://generativelanguage.googleapis.com/v1beta/models".to_string()),
        _ => Err(format!("Unknown provider id: {provider}")),
    }
}

/// Anthropic's Messages API takes `system` as a top-level field, not a
/// message with `role: "system"` — so `system`-role turns get pulled out of
/// the `messages` array and joined into that field.
fn build_anthropic_body(model: &str, messages: &[ChatMessage]) -> serde_json::Value {
    let mut system_parts = Vec::new();
    let mut chat_messages = Vec::new();
    for message in messages {
        if message.role == "system" {
            system_parts.push(message.content.clone());
        } else {
            chat_messages.push(serde_json::json!({
                "role": message.role,
                "content": message.content,
            }));
        }
    }
    let mut body = serde_json::json!({
        "model": model,
        "max_tokens": 4096,
        "messages": chat_messages,
    });
    if !system_parts.is_empty() {
        body["system"] = serde_json::Value::String(system_parts.join("\n\n"));
    }
    body
}

fn build_openai_body(model: &str, messages: &[ChatMessage]) -> serde_json::Value {
    let chat_messages: Vec<serde_json::Value> = messages
        .iter()
        .map(|message| {
            serde_json::json!({
                "role": message.role,
                "content": message.content,
            })
        })
        .collect();
    serde_json::json!({
        "model": model,
        "messages": chat_messages,
    })
}

/// Gemini's `generateContent` takes `contents` (`role: "user" | "model"`)
/// plus a separate `systemInstruction` — so `system`-role turns are pulled
/// out and joined there, and `assistant` is remapped to `model`.
fn build_google_body(messages: &[ChatMessage]) -> serde_json::Value {
    let mut system_parts = Vec::new();
    let mut contents = Vec::new();
    for message in messages {
        if message.role == "system" {
            system_parts.push(message.content.clone());
        } else {
            let role = if message.role == "assistant" { "model" } else { "user" };
            contents.push(serde_json::json!({
                "role": role,
                "parts": [{ "text": message.content }],
            }));
        }
    }
    let mut body = serde_json::json!({ "contents": contents });
    if !system_parts.is_empty() {
        body["systemInstruction"] = serde_json::json!({
            "parts": [{ "text": system_parts.join("\n\n") }],
        });
    }
    body
}

fn extract_anthropic_text(body: &serde_json::Value) -> String {
    body.get("content")
        .and_then(|content| content.as_array())
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|block| block.get("text").and_then(|text| text.as_str()))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}

fn extract_openai_text(body: &serde_json::Value) -> String {
    body.get("choices")
        .and_then(|choices| choices.as_array())
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(|content| content.as_str())
        .unwrap_or_default()
        .to_string()
}

fn extract_google_text(body: &serde_json::Value) -> String {
    body.get("candidates")
        .and_then(|candidates| candidates.as_array())
        .and_then(|candidates| candidates.first())
        .and_then(|candidate| candidate.get("content"))
        .and_then(|content| content.get("parts"))
        .and_then(|parts| parts.as_array())
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| part.get("text").and_then(|text| text.as_str()))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}

fn extract_chat_text(provider: &str, body: &serde_json::Value) -> String {
    match provider {
        "anthropic" => extract_anthropic_text(body),
        "openai" => extract_openai_text(body),
        "google" => extract_google_text(body),
        _ => String::new(),
    }
}

/// Reads the keyring for `id` and returns a trimmed, non-empty secret, or a
/// human-readable (non-401) error if nothing usable is stored.
fn read_key_for_chat(id: &str) -> Result<String, String> {
    let entry = open_entry(id)?;
    match entry.get_password() {
        Ok(secret) if !secret.trim().is_empty() => Ok(secret.trim().to_string()),
        _ => Err(format!(
            "No API key saved for provider '{id}'. Add one in Preferences \u{2192} Providers."
        )),
    }
}

/// Calls the vendor's official chat-completions endpoint directly and
/// returns only the assistant's text. Never returns the API key. `provider`
/// must be one of the v1 ids (see `PROVIDER_IDS`) — unknown ids are rejected
/// the same way Task 2's key commands reject them.
#[tauri::command]
pub async fn provider_chat(
    provider: String,
    model: String,
    messages: Vec<ChatMessage>,
    timeout_ms: u64,
) -> Result<ChatResponse, String> {
    validate_provider_id(&provider)?;
    let url = chat_url(&provider, &model)?;
    let key = read_key_for_chat(&provider)?;
    let timeout = Duration::from_millis(resolve_timeout_ms(timeout_ms));

    let client = http_client();
    let request = match provider.as_str() {
        "anthropic" => client
            .post(&url)
            .header("x-api-key", &key)
            .header("anthropic-version", "2023-06-01")
            .json(&build_anthropic_body(&model, &messages)),
        "openai" => client
            .post(&url)
            .header("Authorization", format!("Bearer {key}"))
            .json(&build_openai_body(&model, &messages)),
        "google" => client
            .post(&url)
            .query(&[("key", key.as_str())])
            .json(&build_google_body(&messages)),
        // Unreachable: `chat_url` already rejected unknown ids above.
        _ => return Err(format!("Unknown provider id: {provider}")),
    };

    // No retry on any failure path, per the locked contract.
    let response = request.timeout(timeout).send().await.map_err(|error| {
        if error.is_timeout() {
            "provider_timeout".to_string()
        } else {
            "provider_request_failed".to_string()
        }
    })?;

    let status = response.status();
    if !status.is_success() {
        return Err(map_status_error(status.as_u16()));
    }

    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|_| "provider_invalid_response".to_string())?;

    Ok(ChatResponse {
        text: extract_chat_text(&provider, &body),
    })
}

// --- Catalog refresh (Task 4, user-triggered) -------------------------------

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub struct CatalogModel {
    pub id: String,
    pub label: String,
}

/// Extracts `{id, label}` pairs from a vendor's models-list response. Pure
/// and network-free so it is directly unit-testable with fixture JSON.
/// Returns `None` for a shape we don't recognize or an empty list, so the
/// caller keeps that provider's existing (Task 1) snapshot.
fn parse_models_list(provider: &str, body: &serde_json::Value) -> Option<Vec<CatalogModel>> {
    let models: Vec<CatalogModel> = match provider {
        "anthropic" | "openai" => body
            .get("data")?
            .as_array()?
            .iter()
            .filter_map(|item| {
                let id = item.get("id")?.as_str()?.to_string();
                let label = item
                    .get("display_name")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&id)
                    .to_string();
                Some(CatalogModel { id, label })
            })
            .collect(),
        "google" => body
            .get("models")?
            .as_array()?
            .iter()
            .filter_map(|item| {
                let raw_name = item.get("name")?.as_str()?;
                let id = raw_name.strip_prefix("models/").unwrap_or(raw_name).to_string();
                let label = item
                    .get("displayName")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&id)
                    .to_string();
                Some(CatalogModel { id, label })
            })
            .collect(),
        _ => return None,
    };
    if models.is_empty() {
        None
    } else {
        Some(models)
    }
}

/// Best-effort GET of one vendor's models list using its stored key. Returns
/// `None` on any failure (no key saved, network error, non-2xx, unexpected
/// shape) so the caller can keep that provider's Task 1 snapshot instead of
/// failing the whole refresh.
async fn fetch_provider_models(provider: &str) -> Option<Vec<CatalogModel>> {
    let entry = open_entry(provider).ok()?;
    let key = entry.get_password().ok()?;
    let key = key.trim();
    if key.is_empty() {
        return None;
    }
    let url = models_list_url(provider).ok()?;
    let client = http_client();
    let request = match provider {
        "anthropic" => client
            .get(&url)
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01"),
        "openai" => client.get(&url).header("Authorization", format!("Bearer {key}")),
        "google" => client.get(&url).query(&[("key", key)]),
        _ => return None,
    };
    let response = request
        .timeout(Duration::from_millis(CATALOG_REFRESH_TIMEOUT_MS))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body: serde_json::Value = response.json().await.ok()?;
    parse_models_list(provider, &body)
}

/// User-triggered ("Refresh" button) catalog sync. Fetches each vendor's
/// official models list and returns `{ provider: [{id, label}] }` only for
/// providers that succeeded — the frontend keeps the Task 1 snapshot
/// (`MODEL_CATALOG`) for any provider missing from the result, and on total
/// failure the returned map is simply empty. This command never errors.
#[tauri::command]
pub async fn provider_catalog_refresh() -> Result<HashMap<String, Vec<CatalogModel>>, String> {
    let mut result = HashMap::new();
    for id in PROVIDER_IDS {
        if let Some(models) = fetch_provider_models(id).await {
            result.insert(id.to_string(), models);
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_key() {
        let error = validate_key_input("anthropic", "").unwrap_err();
        assert!(error.contains("empty"), "unexpected message: {error}");
    }

    #[test]
    fn rejects_whitespace_only_key() {
        let error = validate_key_input("openai", "   \t  ").unwrap_err();
        assert!(error.contains("empty"), "unexpected message: {error}");
    }

    #[test]
    fn rejects_unknown_provider_id_on_set() {
        let error = validate_key_input("mistral", "sk-real-looking-key").unwrap_err();
        assert!(error.contains("Unknown provider"), "unexpected message: {error}");
    }

    #[test]
    fn rejects_unknown_provider_id_on_status_and_clear() {
        assert!(validate_provider_id("mistral").is_err());
        assert!(validate_provider_id("").is_err());
    }

    #[test]
    fn accepts_every_known_provider_with_a_nonempty_key() {
        for id in PROVIDER_IDS {
            assert!(validate_key_input(id, "sk-test-key").is_ok(), "provider {id} should be valid");
        }
    }

    #[test]
    fn keyring_service_name_follows_adr_010() {
        assert_eq!(keyring_service("anthropic"), "flashwork.provider.anthropic");
        assert_eq!(keyring_service("openai"), "flashwork.provider.openai");
        assert_eq!(keyring_service("google"), "flashwork.provider.google");
    }

    #[test]
    fn cli_env_names_match_the_locked_provider_cli_env_mapping() {
        assert_eq!(cli_env_names("anthropic"), &["ANTHROPIC_API_KEY"]);
        assert_eq!(cli_env_names("openai"), &["OPENAI_API_KEY"]);
        assert_eq!(cli_env_names("google"), &["GEMINI_API_KEY", "GOOGLE_API_KEY"]);
    }

    #[test]
    fn cli_env_names_are_empty_for_unknown_providers() {
        assert!(cli_env_names("mistral").is_empty());
        assert!(cli_env_names("").is_empty());
    }

    #[test]
    fn provider_cli_env_is_empty_for_unknown_provider_id_without_touching_keyring() {
        // Unknown ids short-circuit on `cli_env_names` before any keyring I/O,
        // so this is safe to run without a live OS Secret Service / Keychain.
        assert!(provider_cli_env("mistral").is_empty());
        assert!(provider_cli_env("").is_empty());
    }

    #[test]
    fn build_cli_env_maps_a_fake_secret_onto_the_right_env_names() {
        let fake_secret = "sk-fake-test-secret";

        let anthropic_env = build_cli_env("anthropic", fake_secret);
        assert_eq!(anthropic_env.len(), 1);
        assert_eq!(anthropic_env.get("ANTHROPIC_API_KEY"), Some(&fake_secret.to_string()));

        let openai_env = build_cli_env("openai", fake_secret);
        assert_eq!(openai_env.len(), 1);
        assert_eq!(openai_env.get("OPENAI_API_KEY"), Some(&fake_secret.to_string()));

        let google_env = build_cli_env("google", fake_secret);
        assert_eq!(google_env.len(), 2);
        assert_eq!(google_env.get("GEMINI_API_KEY"), Some(&fake_secret.to_string()));
        assert_eq!(google_env.get("GOOGLE_API_KEY"), Some(&fake_secret.to_string()));
    }

    #[test]
    fn build_cli_env_is_empty_for_blank_secret_or_unknown_provider() {
        assert!(build_cli_env("anthropic", "").is_empty());
        assert!(build_cli_env("anthropic", "   \t  ").is_empty());
        assert!(build_cli_env("mistral", "sk-fake-test-secret").is_empty());
    }

    // --- Task 4: direct chat completion -----------------------------------

    #[test]
    fn timeout_constants_match_the_locked_contract() {
        assert_eq!(ROUTER_TIMEOUT_MS, 2_500);
        assert_eq!(CODING_TIMEOUT_MS, 120_000);
    }

    #[test]
    fn resolve_timeout_ms_defaults_omitted_or_zero_to_router_timeout() {
        assert_eq!(resolve_timeout_ms(0), ROUTER_TIMEOUT_MS);
    }

    #[test]
    fn resolve_timeout_ms_passes_through_caller_supplied_values() {
        assert_eq!(resolve_timeout_ms(CODING_TIMEOUT_MS), CODING_TIMEOUT_MS);
        assert_eq!(resolve_timeout_ms(1), 1);
    }

    #[test]
    fn http_401_maps_to_the_locked_provider_unauthorized_string() {
        assert_eq!(map_status_error(401), "provider_unauthorized");
    }

    #[test]
    fn other_http_errors_do_not_map_to_provider_unauthorized() {
        let mapped = map_status_error(500);
        assert_ne!(mapped, "provider_unauthorized");
        assert!(mapped.contains("500"), "unexpected message: {mapped}");

        let mapped_429 = map_status_error(429);
        assert_ne!(mapped_429, "provider_unauthorized");
    }

    #[test]
    fn chat_url_rejects_unknown_provider() {
        assert!(chat_url("mistral", "some-model").is_err());
        assert!(chat_url("", "some-model").is_err());
    }

    #[test]
    fn models_list_url_rejects_unknown_provider() {
        assert!(models_list_url("mistral").is_err());
    }

    #[test]
    fn chat_url_matches_the_locked_official_endpoints() {
        assert_eq!(
            chat_url("anthropic", "claude-sonnet-4-5-20250929").unwrap(),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            chat_url("openai", "gpt-5").unwrap(),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            chat_url("google", "gemini-2.5-flash").unwrap(),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
        );
    }

    #[test]
    fn models_list_url_matches_the_locked_official_endpoints() {
        assert_eq!(
            models_list_url("anthropic").unwrap(),
            "https://api.anthropic.com/v1/models"
        );
        assert_eq!(models_list_url("openai").unwrap(), "https://api.openai.com/v1/models");
        assert_eq!(
            models_list_url("google").unwrap(),
            "https://generativelanguage.googleapis.com/v1beta/models"
        );
    }

    fn msg(role: &str, content: &str) -> ChatMessage {
        ChatMessage {
            role: role.to_string(),
            content: content.to_string(),
        }
    }

    #[test]
    fn anthropic_body_pulls_system_role_into_top_level_system_field() {
        let messages = vec![msg("system", "Be terse."), msg("user", "Hi")];
        let body = build_anthropic_body("claude-x", &messages);
        assert_eq!(body["model"], "claude-x");
        assert_eq!(body["system"], "Be terse.");
        assert_eq!(body["messages"].as_array().unwrap().len(), 1);
        assert_eq!(body["messages"][0]["role"], "user");
    }

    #[test]
    fn anthropic_body_has_no_system_field_when_no_system_message() {
        let messages = vec![msg("user", "Hi")];
        let body = build_anthropic_body("claude-x", &messages);
        assert!(body.get("system").is_none());
    }

    #[test]
    fn openai_body_passes_messages_through_unchanged() {
        let messages = vec![msg("system", "Be terse."), msg("user", "Hi")];
        let body = build_openai_body("gpt-5", &messages);
        assert_eq!(body["model"], "gpt-5");
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(msgs[1]["role"], "user");
    }

    #[test]
    fn google_body_remaps_assistant_to_model_and_extracts_system_instruction() {
        let messages = vec![msg("system", "Be terse."), msg("user", "Hi"), msg("assistant", "Hello")];
        let body = build_google_body(&messages);
        assert_eq!(body["systemInstruction"]["parts"][0]["text"], "Be terse.");
        let contents = body["contents"].as_array().unwrap();
        assert_eq!(contents.len(), 2);
        assert_eq!(contents[0]["role"], "user");
        assert_eq!(contents[1]["role"], "model");
    }

    #[test]
    fn extract_anthropic_text_joins_text_blocks() {
        let body = serde_json::json!({
            "content": [{"type": "text", "text": "Hello"}, {"type": "text", "text": " world"}]
        });
        assert_eq!(extract_anthropic_text(&body), "Hello world");
    }

    #[test]
    fn extract_openai_text_reads_first_choice_message_content() {
        let body = serde_json::json!({
            "choices": [{"message": {"role": "assistant", "content": "Hello world"}}]
        });
        assert_eq!(extract_openai_text(&body), "Hello world");
    }

    #[test]
    fn extract_google_text_joins_first_candidate_parts() {
        let body = serde_json::json!({
            "candidates": [{"content": {"parts": [{"text": "Hello"}, {"text": " world"}]}}]
        });
        assert_eq!(extract_google_text(&body), "Hello world");
    }

    #[test]
    fn extract_chat_text_dispatches_by_provider_and_is_empty_for_unknown() {
        let anthropic_body = serde_json::json!({"content": [{"text": "hi"}]});
        assert_eq!(extract_chat_text("anthropic", &anthropic_body), "hi");
        assert_eq!(extract_chat_text("mistral", &anthropic_body), "");
    }

    #[test]
    fn read_key_for_chat_rejects_unknown_provider_gracefully() {
        // `open_entry` still succeeds for an unknown id (keyring doesn't
        // validate ids), but there is never a stored secret for it, so this
        // returns the clear "no key" error, not a panic and not a 401.
        let error = read_key_for_chat("mistral").unwrap_err();
        assert!(!error.is_empty());
        assert_ne!(error, UNAUTHORIZED_ERROR);
    }

    #[test]
    fn parse_models_list_reads_anthropic_and_openai_data_array() {
        let body = serde_json::json!({
            "data": [
                {"id": "claude-sonnet-4-5-20250929", "display_name": "Sonnet"},
                {"id": "claude-opus-4-1-20250805"}
            ]
        });
        let models = parse_models_list("anthropic", &body).unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "claude-sonnet-4-5-20250929");
        assert_eq!(models[0].label, "Sonnet");
        // Falls back to the id as the label when display_name is missing.
        assert_eq!(models[1].label, "claude-opus-4-1-20250805");
    }

    #[test]
    fn parse_models_list_reads_google_models_array_and_strips_name_prefix() {
        let body = serde_json::json!({
            "models": [
                {"name": "models/gemini-2.5-pro", "displayName": "Gemini 2.5 Pro"}
            ]
        });
        let models = parse_models_list("google", &body).unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "gemini-2.5-pro");
        assert_eq!(models[0].label, "Gemini 2.5 Pro");
    }

    #[test]
    fn parse_models_list_returns_none_for_empty_or_malformed_body() {
        assert!(parse_models_list("anthropic", &serde_json::json!({"data": []})).is_none());
        assert!(parse_models_list("anthropic", &serde_json::json!({})).is_none());
        assert!(parse_models_list("mistral", &serde_json::json!({"data": []})).is_none());
    }
}
