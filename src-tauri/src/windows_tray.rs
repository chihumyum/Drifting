//! Windows keeps Drifting in the notification area, as macOS keeps it in the
//! Dock: closing the window on the shelf hides it after the renderer has
//! saved (finish_shutdown), so a background Agent and sync go on. A left click
//! on the icon, its Open item or launching Drifting again brings the window
//! back; Quit saves and ends the process. The menu's words follow the
//! interface language (`tray_set_labels`, AppEffects).

/// Longest label the renderer may set.
const MAX_LABEL_CHARS: usize = 80;

#[cfg(target_os = "windows")]
mod imp {
    use tauri::{
        menu::{Menu, MenuItem},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
        AppHandle, Manager, Wry,
    };

    pub struct TrayMenu {
        pub open: MenuItem<Wry>,
        pub quit: MenuItem<Wry>,
    }

    pub fn show_main(app: &AppHandle) {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }

    fn quit(app: &AppHandle) {
        if !crate::request_flushed_shutdown(app, crate::state::ShutdownAction::ExitApp) {
            app.exit(0);
        }
    }

    pub fn install(app: &AppHandle) -> tauri::Result<()> {
        let open = MenuItem::with_id(app, "tray-open", "Open Drifting", true, None::<&str>)?;
        let quit_item = MenuItem::with_id(app, "tray-quit", "Quit Drifting", true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&open, &quit_item])?;
        let mut builder = TrayIconBuilder::with_id("drifting")
            .tooltip("Drifting")
            .menu(&menu)
            .show_menu_on_left_click(false)
            .on_menu_event(|app, event| match event.id().as_ref() {
                "tray-open" => show_main(app),
                "tray-quit" => quit(app),
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    show_main(tray.app_handle());
                }
            });
        if let Some(icon) = app.default_window_icon() {
            builder = builder.icon(icon.clone());
        }
        builder.build(app)?;
        app.manage(TrayMenu {
            open,
            quit: quit_item,
        });
        Ok(())
    }
}

#[cfg(target_os = "windows")]
pub(crate) use imp::install;

fn valid_label(label: &str) -> bool {
    let count = label.chars().count();
    count > 0 && count <= MAX_LABEL_CHARS && !label.chars().any(char::is_control)
}

/// The tray menu in the interface language. Other platforms have no tray.
#[tauri::command]
pub fn tray_set_labels(app: tauri::AppHandle, open: String, quit: String) -> Result<(), String> {
    if !valid_label(&open) || !valid_label(&quit) {
        return Err("tray labels are invalid".into());
    }
    #[cfg(target_os = "windows")]
    {
        use tauri::Manager;
        if let Some(menu) = app.try_state::<imp::TrayMenu>() {
            menu.open
                .set_text(&open)
                .map_err(|error| error.to_string())?;
            menu.quit
                .set_text(&quit)
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::valid_label;

    #[test]
    fn labels_are_short_single_lines() {
        assert!(valid_label("打开 Drifting"));
        assert!(!valid_label(""));
        assert!(!valid_label("Quit\nDrifting"));
        assert!(!valid_label(&"x".repeat(81)));
    }
}
