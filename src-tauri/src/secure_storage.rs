//! Platform secure-storage commands used by the renderer contract.
//!
//! Desktop and Apple targets use their operating-system credential store via
//! `keyring`. Android delegates to the private `drifting-secure-storage`
//! Tauri plugin, which encrypts every value with an Android Keystore key and
//! stores only authenticated ciphertext in the app's no-backup directory.
//! There is deliberately no plaintext fallback on any target.

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

fn key_is_valid(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= MAX_KEY_BYTES
        && key.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '-')
        })
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

#[tauri::command]
pub async fn keychain_get(app: AppHandle, key: String) -> Result<Option<String>, String> {
    if !key_is_valid(&key) {
        return Err("invalid secure storage key".into());
    }

    tauri::async_runtime::spawn_blocking(move || get_value(&app, &key))
        .await
        .map_err(|_| "secure storage worker failed".to_string())?
}

#[tauri::command]
pub async fn keychain_set(app: AppHandle, key: String, value: String) -> Result<bool, String> {
    if !key_is_valid(&key) || value.len() > MAX_VALUE_BYTES {
        return Err("invalid secure storage entry".into());
    }

    tauri::async_runtime::spawn_blocking(move || set_value(&app, &key, &value))
        .await
        .map_err(|_| "secure storage worker failed".to_string())?
}

#[tauri::command]
pub async fn keychain_delete(app: AppHandle, key: String) -> Result<bool, String> {
    if !key_is_valid(&key) {
        return Err("invalid secure storage key".into());
    }

    tauri::async_runtime::spawn_blocking(move || delete_value(&app, &key))
        .await
        .map_err(|_| "secure storage worker failed".to_string())?
}

#[cfg(test)]
mod tests {
    use super::{key_is_valid, MAX_KEY_BYTES};

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
}
