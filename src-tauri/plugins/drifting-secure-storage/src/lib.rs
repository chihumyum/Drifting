#![cfg(target_os = "android")]

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    Manager, Runtime,
};

const PLUGIN_IDENTIFIER: &str = "cc.drifting.securestorage";

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Android secure-storage plugin invocation failed")]
    Plugin(#[from] tauri::plugin::mobile::PluginInvokeError),
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KeyPayload<'a> {
    key: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SetPayload<'a> {
    key: &'a str,
    value: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GetResponse {
    value: Option<String>,
}

/// Rust-side handle for the private Android plugin. It is intentionally not
/// exposed as a renderer plugin API; the renderer continues to use the
/// application-owned `keychain_get/set/delete` commands.
pub struct SecureStorage<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> SecureStorage<R> {
    pub fn get(&self, key: &str) -> Result<Option<String>> {
        let response: GetResponse = self.0.run_mobile_plugin("get", KeyPayload { key })?;
        Ok(response.value)
    }

    pub fn set(&self, key: &str, value: &str) -> Result<()> {
        self.0
            .run_mobile_plugin("set", SetPayload { key, value })
            .map_err(Into::into)
    }

    pub fn delete(&self, key: &str) -> Result<()> {
        self.0
            .run_mobile_plugin("delete", KeyPayload { key })
            .map_err(Into::into)
    }
}

pub trait SecureStorageExt<R: Runtime> {
    fn drifting_secure_storage(&self) -> &SecureStorage<R>;
}

impl<R: Runtime, T: Manager<R>> SecureStorageExt<R> for T {
    fn drifting_secure_storage(&self) -> &SecureStorage<R> {
        self.state::<SecureStorage<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("drifting-secure-storage")
        .setup(|app, api| {
            let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "SecureStoragePlugin")?;
            app.manage(SecureStorage(handle));
            Ok(())
        })
        .build()
}
