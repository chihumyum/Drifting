use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_opener::OpenerExt;

use crate::state::{CloseCoordinator, DeepLinkQueue, ShutdownAction};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    name: String,
    version: String,
    platform: &'static str,
    architecture: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformCapabilities {
    desktop_window_controls: bool,
    deep_links: bool,
    external_url_opener: bool,
    secure_storage: bool,
    material_files: bool,
    asset_cache: bool,
    ai_log: bool,
    oauth: bool,
    image_codecs: ImageCodecCapabilities,
    general_agent: bool,
    general_agent_unavailable_reason: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageCodecCapabilities {
    rust: &'static [&'static str],
    native_system: &'static [&'static str],
    runtime_checked: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleStatus {
    pending_flush_request_id: Option<u64>,
}

#[derive(Deserialize)]
pub struct WindowControlPosition {
    x: f64,
    y: f64,
}

#[tauri::command]
pub fn app_get_info(app: AppHandle) -> AppInfo {
    let package_info = app.package_info();
    AppInfo {
        name: package_info.name.clone(),
        version: package_info.version.to_string(),
        platform: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
    }
}

#[tauri::command]
pub fn app_get_path(app: AppHandle, name: String) -> Result<String, String> {
    let resolver = app.path();
    let path: PathBuf = match name.as_str() {
        "home" => resolver.home_dir(),
        "appData" => resolver.app_data_dir(),
        "userData" => resolver.app_local_data_dir(),
        "temp" => Ok(std::env::temp_dir()),
        "documents" => resolver.document_dir(),
        _ => return Err(format!("unsupported app path: {name}")),
    }
    .map_err(|error| error.to_string())?;

    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn platform_capabilities() -> PlatformCapabilities {
    PlatformCapabilities {
        desktop_window_controls: cfg!(desktop),
        deep_links: true,
        external_url_opener: true,
        secure_storage: cfg!(any(
            target_os = "macos",
            target_os = "ios",
            target_os = "windows",
            target_os = "linux",
            target_os = "android"
        )),
        material_files: true,
        asset_cache: true,
        ai_log: true,
        oauth: true,
        image_codecs: ImageCodecCapabilities {
            rust: &["jpeg", "png", "gif", "webp", "bmp", "ico", "tiff"],
            native_system: if cfg!(any(
                target_os = "macos",
                target_os = "ios",
                target_os = "android"
            )) {
                &["heic", "heif", "avif"]
            } else {
                &[]
            },
            // OS version and installed codec support are checked when the source is decoded.
            runtime_checked: true,
        },
        // The provider-neutral runtime executes in the renderer and calls
        // Drifting's own use cases. It does not require a native sidecar.
        general_agent: true,
        general_agent_unavailable_reason: "",
    }
}

#[tauri::command]
pub async fn window_minimize(window: WebviewWindow) -> Result<(), String> {
    #[cfg(desktop)]
    {
        window.minimize().map_err(|error| error.to_string())
    }
    #[cfg(mobile)]
    {
        let _ = window;
        Err("window minimize is unsupported on mobile".into())
    }
}

#[tauri::command]
pub async fn window_toggle_maximize(window: WebviewWindow) -> Result<bool, String> {
    #[cfg(desktop)]
    {
        let maximized = window.is_maximized().map_err(|error| error.to_string())?;
        if maximized {
            window.unmaximize().map_err(|error| error.to_string())?;
        } else {
            window.maximize().map_err(|error| error.to_string())?;
        }
        Ok(!maximized)
    }
    #[cfg(mobile)]
    {
        let _ = window;
        Err("window maximize is unsupported on mobile".into())
    }
}

#[tauri::command]
pub async fn window_is_maximized(window: WebviewWindow) -> Result<bool, String> {
    #[cfg(desktop)]
    {
        window.is_maximized().map_err(|error| error.to_string())
    }
    #[cfg(mobile)]
    {
        let _ = window;
        Ok(false)
    }
}

#[tauri::command]
pub async fn window_close(window: WebviewWindow) -> Result<(), String> {
    window.close().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn window_set_traffic_light_position(
    window: WebviewWindow,
    position: WindowControlPosition,
) -> Result<(), String> {
    if !position.x.is_finite()
        || !position.y.is_finite()
        || !(0.0..=128.0).contains(&position.x)
        || !(0.0..=128.0).contains(&position.y)
    {
        return Err("invalid traffic-light position".into());
    }

    #[cfg(target_os = "macos")]
    {
        window
            .with_webview(move |webview| unsafe {
                use objc2_app_kit::{NSWindow, NSWindowButton};

                let native_window: &NSWindow = &*webview.ns_window().cast();
                let Some(close) = native_window.standardWindowButton(NSWindowButton::CloseButton)
                else {
                    return;
                };
                let Some(minimize) =
                    native_window.standardWindowButton(NSWindowButton::MiniaturizeButton)
                else {
                    return;
                };
                let Some(zoom) = native_window.standardWindowButton(NSWindowButton::ZoomButton)
                else {
                    return;
                };
                let Some(button_row) = close.superview() else {
                    return;
                };
                let Some(title_bar_container) = button_row.superview() else {
                    return;
                };

                let close_frame = close.frame();
                let title_bar_height = close_frame.size.height + position.y;
                let mut title_bar_frame = title_bar_container.frame();
                title_bar_frame.size.height = title_bar_height;
                title_bar_frame.origin.y = native_window.frame().size.height - title_bar_height;
                title_bar_container.setFrame(title_bar_frame);

                let spacing = minimize.frame().origin.x - close_frame.origin.x;
                for (index, button) in [close, minimize, zoom].into_iter().enumerate() {
                    let mut origin = button.frame().origin;
                    origin.x = position.x + index as f64 * spacing;
                    button.setFrameOrigin(origin);
                }
            })
            .map_err(|error| error.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        Err("traffic-light positioning is supported only on macOS".into())
    }
}

#[tauri::command]
pub fn opener_open_external(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = tauri::Url::parse(&url).map_err(|_| "invalid URL".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https" | "mailto" | "tel") {
        return Err("unsupported external URL scheme".into());
    }

    app.opener()
        .open_url(parsed, None::<&str>)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn deep_link_take_pending(queue: State<'_, DeepLinkQueue>) -> Vec<String> {
    queue.drain()
}

#[tauri::command]
pub fn lifecycle_get_status(coordinator: State<'_, Arc<CloseCoordinator>>) -> LifecycleStatus {
    LifecycleStatus {
        pending_flush_request_id: coordinator.pending_request_id(),
    }
}

#[tauri::command]
pub fn lifecycle_complete_flush(
    app: AppHandle,
    window: WebviewWindow,
    coordinator: State<'_, Arc<CloseCoordinator>>,
    request_id: u64,
) -> Result<bool, String> {
    let Some(action) = coordinator.complete(request_id) else {
        return Ok(false);
    };

    match action {
        ShutdownAction::CloseWindow => {
            #[cfg(target_os = "macos")]
            window.hide().map_err(|error| error.to_string())?;

            #[cfg(not(target_os = "macos"))]
            {
                coordinator.permit_next_close();
                coordinator.permit_next_exit();
                window.close().map_err(|error| error.to_string())?;
            }
        }
        ShutdownAction::ExitApp => app.exit(0),
    }
    Ok(true)
}
