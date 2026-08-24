#![cfg(any(target_os = "ios", target_os = "android"))]

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    Manager, Runtime,
};
use zeroize::{Zeroize, ZeroizeOnDrop};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_drifting_google_drive_oauth);

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "cc.drifting.googledriveoauth";

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("native mobile Google OAuth invocation failed")]
    Plugin(#[from] tauri::plugin::mobile::PluginInvokeError),
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthorizeRequest<'a> {
    client_id: &'a str,
    expected_account_subject: Option<&'a str>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountRequest<'a> {
    client_id: &'a str,
    expected_account_subject: &'a str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg(target_os = "ios")]
struct UrlRequest<'a> {
    url: &'a str,
}

#[derive(Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase")]
pub struct MobileOAuthResponse {
    pub ok: bool,
    pub account_subject: Option<String>,
    pub access_token: Option<String>,
    pub expires_at_ms: Option<u64>,
    pub error_code: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileDiagnosticError {
    pub family: String,
    pub domain: String,
    pub code: i64,
    pub reason: Option<String>,
    pub http_status: Option<u16>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileOperationDiagnostics {
    pub schema_version: u8,
    pub operation: String,
    pub platform: String,
    pub phase: String,
    pub elapsed_ms: u64,
    pub completed_phases: Vec<String>,
    pub error_chain: Vec<MobileDiagnosticError>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileRevokeResponse {
    pub ok: bool,
    pub already_missing: bool,
    pub error_code: Option<String>,
    pub diagnostics: Option<MobileOperationDiagnostics>,
}

pub struct GoogleDriveOAuth<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> GoogleDriveOAuth<R> {
    pub async fn authorize(
        &self,
        client_id: &str,
        expected_account_subject: Option<&str>,
    ) -> Result<MobileOAuthResponse> {
        self.0
            .run_mobile_plugin_async(
                "authorize",
                AuthorizeRequest {
                    client_id,
                    expected_account_subject,
                },
            )
            .await
            .map_err(Into::into)
    }

    pub async fn fresh_token(
        &self,
        client_id: &str,
        expected_account_subject: &str,
    ) -> Result<MobileOAuthResponse> {
        self.0
            .run_mobile_plugin_async(
                "freshToken",
                AccountRequest {
                    client_id,
                    expected_account_subject,
                },
            )
            .await
            .map_err(Into::into)
    }

    pub async fn revoke(
        &self,
        client_id: &str,
        expected_account_subject: &str,
    ) -> Result<MobileRevokeResponse> {
        self.0
            .run_mobile_plugin_async(
                "revoke",
                AccountRequest {
                    client_id,
                    expected_account_subject,
                },
            )
            .await
            .map_err(Into::into)
    }

    #[cfg(target_os = "ios")]
    pub async fn handle_url(&self, url: &str) -> Result<MobileOAuthResponse> {
        self.0
            .run_mobile_plugin_async("handleUrl", UrlRequest { url })
            .await
            .map_err(Into::into)
    }
}

pub trait GoogleDriveOAuthExt<R: Runtime> {
    fn drifting_google_drive_oauth(&self) -> &GoogleDriveOAuth<R>;
}

impl<R: Runtime, T: Manager<R>> GoogleDriveOAuthExt<R> for T {
    fn drifting_google_drive_oauth(&self) -> &GoogleDriveOAuth<R> {
        self.state::<GoogleDriveOAuth<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("drifting-google-drive-oauth")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let handle =
                api.register_android_plugin(PLUGIN_IDENTIFIER, "GoogleDriveOAuthPlugin")?;
            #[cfg(target_os = "ios")]
            let handle = api.register_ios_plugin(init_plugin_drifting_google_drive_oauth)?;
            app.manage(GoogleDriveOAuth(handle));
            Ok(())
        })
        .build()
}
