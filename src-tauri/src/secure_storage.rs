//! Platform secure-storage commands used by the renderer contract.
//!
//! Desktop and Apple targets use their operating-system credential store via
//! `keyring`. Android delegates to the private `drifting-secure-storage`
//! Tauri plugin, which encrypts every value with an Android Keystore key and
//! stores only authenticated ciphertext in the app's no-backup directory.
//! There is deliberately no plaintext fallback on any target.
//! Renderer commands may manage ordinary BYOK/session values, but native-only
//! provider credentials and resumable sessions reject value reads and
//! mutations even when JavaScript knows their opaque reference.

use tauri::AppHandle;

#[cfg(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "windows",
    target_os = "linux"
))]
const KEYCHAIN_SERVICE: &str = "Drifting";
const MAX_KEY_BYTES: usize = 128;
const MAX_VALUE_BYTES: usize = 256 * 1024;
/// Secrets only native code may read or mutate: sync credentials and the
/// ChatGPT subscription OAuth tokens that back the Codex transport.
const NATIVE_ONLY_SECRET_PREFIXES: &[&str] = &["sync.google-drive.", "oauth."];

fn key_is_valid(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= MAX_KEY_BYTES
        && key.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '-')
        })
}

fn renderer_can_access_secret_value(key: &str) -> bool {
    !NATIVE_ONLY_SECRET_PREFIXES
        .iter()
        .any(|prefix| key.starts_with(prefix))
}

fn require_renderer_secret_value_access(key: &str) -> Result<(), String> {
    if renderer_can_access_secret_value(key) {
        Ok(())
    } else {
        Err("NATIVE_ONLY_SECRET".into())
    }
}

#[cfg(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "windows",
    target_os = "linux"
))]
fn get_value(_app: &AppHandle, key: &str) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, key)
        .map_err(|_| "secure storage entry could not be opened".to_string())?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("secure storage read failed".into()),
    }
}

#[cfg(target_os = "macos")]
fn has_value(_app: &AppHandle, key: &str) -> Result<bool, String> {
    use security_framework::item::{ItemClass, ItemSearchOptions};

    // Query attributes only and explicitly skip items that would require
    // authentication. Reading kSecValueData here would turn a passive Settings
    // status check into a macOS password prompt.
    let result = ItemSearchOptions::new()
        .class(ItemClass::generic_password())
        .service(KEYCHAIN_SERVICE)
        .account(key)
        .load_attributes(true)
        .skip_authenticated_items(true)
        .limit(1)
        .search();
    match result {
        Ok(items) => Ok(!items.is_empty()),
        Err(error) if error.code() == -25300 => Ok(false), // errSecItemNotFound
        Err(_) => Err("secure storage status check failed".into()),
    }
}

#[cfg(any(target_os = "ios", target_os = "windows", target_os = "linux"))]
fn has_value(app: &AppHandle, key: &str) -> Result<bool, String> {
    // These stores do not expose the macOS attribute-only query. Keep the
    // secret native and return only existence to the renderer.
    get_value(app, key).map(|value| value.is_some())
}

#[cfg(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "windows",
    target_os = "linux"
))]
fn set_value(_app: &AppHandle, key: &str, value: &str) -> Result<bool, String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, key)
        .map_err(|_| "secure storage entry could not be opened".to_string())?;
    entry
        .set_password(value)
        .map_err(|_| "secure storage write failed".to_string())?;
    Ok(true)
}

#[cfg(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "windows",
    target_os = "linux"
))]
fn delete_value(_app: &AppHandle, key: &str) -> Result<bool, String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, key)
        .map_err(|_| "secure storage entry could not be opened".to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(true),
        Err(_) => Err("secure storage delete failed".into()),
    }
}

#[cfg(target_os = "android")]
fn get_value(app: &AppHandle, key: &str) -> Result<Option<String>, String> {
    use tauri_plugin_drifting_secure_storage::SecureStorageExt;

    app.drifting_secure_storage()
        .get(key)
        .map_err(|_| "secure storage read failed".into())
}

#[cfg(target_os = "android")]
fn set_value(app: &AppHandle, key: &str, value: &str) -> Result<bool, String> {
    use tauri_plugin_drifting_secure_storage::SecureStorageExt;

    app.drifting_secure_storage()
        .set(key, value)
        .map(|()| true)
        .map_err(|_| "secure storage write failed".into())
}

#[cfg(target_os = "android")]
fn delete_value(app: &AppHandle, key: &str) -> Result<bool, String> {
    use tauri_plugin_drifting_secure_storage::SecureStorageExt;

    app.drifting_secure_storage()
        .delete(key)
        .map(|()| true)
        .map_err(|_| "secure storage delete failed".into())
}

#[cfg(target_os = "android")]
fn has_value(app: &AppHandle, key: &str) -> Result<bool, String> {
    get_value(app, key).map(|value| value.is_some())
}

#[cfg(not(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "windows",
    target_os = "linux",
    target_os = "android"
)))]
fn get_value(_app: &AppHandle, _key: &str) -> Result<Option<String>, String> {
    Err("secure storage is unavailable on this target".into())
}

#[cfg(not(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "windows",
    target_os = "linux",
    target_os = "android"
)))]
fn set_value(_app: &AppHandle, _key: &str, _value: &str) -> Result<bool, String> {
    Err("secure storage is unavailable on this target".into())
}

#[cfg(not(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "windows",
    target_os = "linux",
    target_os = "android"
)))]
fn delete_value(_app: &AppHandle, _key: &str) -> Result<bool, String> {
    Err("secure storage is unavailable on this target".into())
}

#[cfg(not(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "windows",
    target_os = "linux",
    target_os = "android"
)))]
fn has_value(_app: &AppHandle, _key: &str) -> Result<bool, String> {
    Err("secure storage is unavailable on this target".into())
}

pub(crate) fn read_secret(app: &AppHandle, key: &str) -> Result<Option<String>, String> {
    if !key_is_valid(key) {
        return Err("invalid secure storage key".into());
    }
    get_value(app, key)
}

pub(crate) fn write_secret(app: &AppHandle, key: &str, value: &str) -> Result<(), String> {
    if !key_is_valid(key) || value.len() > MAX_VALUE_BYTES {
        return Err("invalid secure storage entry".into());
    }
    set_value(app, key, value).map(|_| ())
}

pub(crate) fn remove_secret(app: &AppHandle, key: &str) -> Result<(), String> {
    if !key_is_valid(key) {
        return Err("invalid secure storage key".into());
    }
    delete_value(app, key).map(|_| ())
}

#[tauri::command]
pub async fn keychain_get(app: AppHandle, key: String) -> Result<Option<String>, String> {
    if !key_is_valid(&key) {
        return Err("invalid secure storage key".into());
    }
    require_renderer_secret_value_access(&key)?;

    tauri::async_runtime::spawn_blocking(move || get_value(&app, &key))
        .await
        .map_err(|_| "secure storage worker failed".to_string())?
}

#[tauri::command]
pub async fn keychain_has(app: AppHandle, key: String) -> Result<bool, String> {
    if !key_is_valid(&key) {
        return Err("invalid secure storage key".into());
    }

    tauri::async_runtime::spawn_blocking(move || has_value(&app, &key))
        .await
        .map_err(|_| "secure storage worker failed".to_string())?
}

#[tauri::command]
pub async fn keychain_set(app: AppHandle, key: String, value: String) -> Result<bool, String> {
    if !key_is_valid(&key) || value.len() > MAX_VALUE_BYTES {
        return Err("invalid secure storage entry".into());
    }
    require_renderer_secret_value_access(&key)?;

    tauri::async_runtime::spawn_blocking(move || set_value(&app, &key, &value))
        .await
        .map_err(|_| "secure storage worker failed".to_string())?
}

#[tauri::command]
pub async fn keychain_delete(app: AppHandle, key: String) -> Result<bool, String> {
    if !key_is_valid(&key) {
        return Err("invalid secure storage key".into());
    }
    require_renderer_secret_value_access(&key)?;

    tauri::async_runtime::spawn_blocking(move || delete_value(&app, &key))
        .await
        .map_err(|_| "secure storage worker failed".to_string())?
}

#[cfg(test)]
mod tests {
    use super::{key_is_valid, renderer_can_access_secret_value, MAX_KEY_BYTES};

    #[test]
    fn accepts_namespaced_keys_used_by_the_renderer() {
        for key in [
            "drifting.session_token",
            "byok.anthropic",
            "byok.openai",
            "byok.google",
            "byok.deepseek",
            "byok.agent.anthropic",
        ] {
            assert!(key_is_valid(key), "expected valid key: {key}");
        }
    }

    #[test]
    fn rejects_empty_oversized_and_path_like_keys() {
        assert!(!key_is_valid(""));
        assert!(!key_is_valid(&"a".repeat(MAX_KEY_BYTES + 1)));
        assert!(!key_is_valid("../session"));
        assert!(!key_is_valid("session/token"));
        assert!(!key_is_valid("session token"));
        assert!(!key_is_valid("令牌"));
    }

    #[test]
    fn renderer_cannot_read_or_mutate_native_sync_secrets() {
        for key in [
            "sync.google-drive.credentials.opaque",
            "sync.google-drive.resumable.opaque",
            "oauth.openai-codex",
        ] {
            assert!(key_is_valid(key));
            assert!(
                !renderer_can_access_secret_value(key),
                "expected native-only secret: {key}"
            );
        }

        for key in [
            "drifting.session_token",
            "byok.openai",
            "sync.installation.identity.v1",
        ] {
            assert!(renderer_can_access_secret_value(key));
        }
    }
}
