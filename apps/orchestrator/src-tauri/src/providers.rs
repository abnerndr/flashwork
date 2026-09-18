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

/// v1 provider ids. Keep in sync with `ProviderId` in
/// `src/lib/providers/modelCatalog.ts`.
const PROVIDER_IDS: [&str; 3] = ["anthropic", "openai", "google"];

const KEYRING_USERNAME: &str = "api-key";

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
}
