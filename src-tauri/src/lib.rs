#[cfg(target_os = "android")]
mod android_image_codec;
#[cfg(any(target_os = "macos", target_os = "ios"))]
mod apple_image_codec;
mod commands;
mod data_migration;
mod database;
mod image_pipeline;
mod native_capabilities;
mod secure_storage;
mod state;

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;

use state::{CloseCoordinator, DeepLinkQueue, ShutdownAction};

const DEEP_LINK_EVENT: &str = "drifting:deep-link";
const LIFECYCLE_EVENT: &str = "drifting:lifecycle";
const CLOSE_FLUSH_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeepLinkPayload {
    urls: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LifecyclePayload {
    event: &'static str,
    request_id: Option<u64>,
    deadline_ms: Option<u64>,
    reason: Option<&'static str>,
    confirmation_required: bool,
}

fn record_deep_links(app: &tauri::AppHandle, urls: Vec<String>) {
    if urls.is_empty() {
        return;
    }

    app.state::<DeepLinkQueue>().push_all(urls.clone());
    let _ = app.emit(DEEP_LINK_EVENT, DeepLinkPayload { urls });
}

fn finish_shutdown(
    app: tauri::AppHandle,
    window: Option<tauri::Window>,
    coordinator: &CloseCoordinator,
    request_id: u64,
) {
    match coordinator.complete(request_id) {
        Some(ShutdownAction::CloseWindow) => {
            if let Some(window) = window {
                // macOS applications conventionally remain alive after the
                // last window closes. Hiding keeps the flushed WebView state
                // available so a Dock reopen can restore it without creating
                // a second renderer/database session.
                #[cfg(target_os = "macos")]
                let _ = window.hide();

                #[cfg(not(target_os = "macos"))]
                {
                    coordinator.permit_next_close();
                    coordinator.permit_next_exit();
                    let _ = window.close();
                }
            }
        }
        Some(ShutdownAction::ExitApp) => app.exit(0),
        None => {}
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let close_coordinator = Arc::new(CloseCoordinator::default());
    let builder = tauri::Builder::default();

    // This must be the first desktop plugin: it forwards Windows/Linux deep links
    // from a newly launched process into the already-running application.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));

    #[cfg(target_os = "android")]
    let builder = builder
        .plugin(tauri_plugin_drifting_secure_storage::init())
        .plugin(tauri_plugin_drifting_image_codec::init());

    let app = builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .manage(DeepLinkQueue::default())
        .manage(close_coordinator)
        .invoke_handler(tauri::generate_handler![
            commands::app_get_info,
            commands::app_get_path,
            commands::platform_capabilities,
            commands::window_minimize,
            commands::window_toggle_maximize,
            commands::window_is_maximized,
            commands::window_close,
            commands::window_set_traffic_light_position,
            commands::opener_open_external,
            commands::deep_link_take_pending,
            commands::lifecycle_get_status,
            commands::lifecycle_complete_flush,
            commands::general_agent_start_unsupported,
            secure_storage::keychain_get,
            secure_storage::keychain_set,
            secure_storage::keychain_delete,
            native_capabilities::material_open_local,
            native_capabilities::material_pick_file,
            native_capabilities::material_delete_import,
            native_capabilities::material_thumbnail,
            native_capabilities::material_read_bytes,
            native_capabilities::material_inspect_image,
            native_capabilities::material_prepare_image,
            native_capabilities::material_create_image_variant,
            native_capabilities::material_create_thumbnail_variant,
            native_capabilities::material_resolve_url_meta,
            native_capabilities::asset_cache_get_path,
            native_capabilities::asset_cache_write_bytes,
            native_capabilities::asset_cache_copy_file,
            native_capabilities::asset_cache_upload_file,
            native_capabilities::asset_cache_download,
            native_capabilities::asset_cache_delete_asset,
            native_capabilities::ai_log_write,
            native_capabilities::ai_log_open_dir,
            native_capabilities::ai_log_get_dir,
            database::database_open,
            database::database_execute,
            database::database_query,
            database::database_begin,
            database::database_commit,
            database::database_rollback,
            database::database_checkpoint,
            database::database_close,
        ])
        .setup(|app| {
            let data_directories = data_migration::prepare_data_directories(app.handle())
                .map_err(std::io::Error::other)?;
            let database_directory = data_directories.database_directory;
            let database_gateway = database::DatabaseGateway::new(database_directory)
                .map_err(std::io::Error::other)?;
            if !app.manage(database_gateway) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    "database gateway state is already managed",
                )
                .into());
            }

            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
            app.deep_link().register_all()?;

            if let Some(urls) = app.deep_link().get_current()? {
                record_deep_links(
                    app.handle(),
                    urls.into_iter().map(|url| url.to_string()).collect(),
                );
            }

            let app_handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                record_deep_links(
                    &app_handle,
                    event.urls().iter().map(ToString::to_string).collect(),
                );
            });

            if let Some(window) = app.get_webview_window("main") {
                window.show()?;
            }
            Ok(())
        })
        .on_window_event(|_window, _event| {
            #[cfg(mobile)]
            if let WindowEvent::Suspended = _event {
                let _ = _window.emit(
                    LIFECYCLE_EVENT,
                    LifecyclePayload {
                        event: "flush-requested",
                        request_id: None,
                        deadline_ms: None,
                        reason: Some("suspended"),
                        confirmation_required: false,
                    },
                );
            }

            #[cfg(desktop)]
            if let WindowEvent::CloseRequested { api, .. } = _event {
                let coordinator = _window
                    .app_handle()
                    .state::<Arc<CloseCoordinator>>()
                    .inner()
                    .clone();
                if coordinator.consume_close_permission() {
                    return;
                }

                api.prevent_close();
                let request_id = coordinator.begin(ShutdownAction::CloseWindow);
                let _ = _window.emit(
                    LIFECYCLE_EVENT,
                    LifecyclePayload {
                        event: "flush-requested",
                        request_id: Some(request_id),
                        deadline_ms: Some(CLOSE_FLUSH_TIMEOUT.as_millis() as u64),
                        reason: Some("shutdown"),
                        confirmation_required: true,
                    },
                );

                let app = _window.app_handle().clone();
                let window = _window.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(CLOSE_FLUSH_TIMEOUT);
                    finish_shutdown(app, Some(window), &coordinator, request_id);
                });
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the Drifting Tauri application");

    app.run(|app_handle, event| match event {
        RunEvent::Ready => {
            let _ = app_handle.emit(
                LIFECYCLE_EVENT,
                LifecyclePayload {
                    event: "ready",
                    request_id: None,
                    deadline_ms: None,
                    reason: None,
                    confirmation_required: false,
                },
            );
        }
        RunEvent::Resumed => {
            let _ = app_handle.emit(
                LIFECYCLE_EVENT,
                LifecyclePayload {
                    event: "resumed",
                    request_id: None,
                    deadline_ms: None,
                    reason: None,
                    confirmation_required: false,
                },
            );
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen {
            has_visible_windows,
            ..
        } => {
            if !has_visible_windows {
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        }
        RunEvent::ExitRequested { code, api, .. } if code.is_none() => {
            let coordinator = app_handle.state::<Arc<CloseCoordinator>>().inner().clone();
            if coordinator.consume_exit_permission() {
                return;
            }

            let Some(window) = app_handle.get_webview_window("main") else {
                return;
            };
            api.prevent_exit();
            let request_id = coordinator.begin(ShutdownAction::ExitApp);
            let _ = window.emit(
                LIFECYCLE_EVENT,
                LifecyclePayload {
                    event: "flush-requested",
                    request_id: Some(request_id),
                    deadline_ms: Some(CLOSE_FLUSH_TIMEOUT.as_millis() as u64),
                    reason: Some("shutdown"),
                    confirmation_required: true,
                },
            );

            let app = app_handle.clone();
            std::thread::spawn(move || {
                std::thread::sleep(CLOSE_FLUSH_TIMEOUT);
                finish_shutdown(app, None, &coordinator, request_id);
            });
        }
        _ => {}
    });
}
