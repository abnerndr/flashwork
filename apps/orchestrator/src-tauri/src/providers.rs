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
}
