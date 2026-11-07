//! Light, dark or the system's, for the app's own drawing and the native
//! chrome (traffic lights, menus, the About window).
//!
//! `dr_ui::theme::force_appearance` decides what dr-ui paints; on macOS the
//! app's `NSAppearance` is set too, so AppKit's parts follow (P0-A). The
//! system setting is never touched.

use dr_ui::Appearance;
use gpui::App;

/// Applies `forced` (`None` follows the system) to dr-ui and the platform.
pub fn apply(forced: Option<Appearance>, cx: &mut App) {
    dr_ui::theme::force_appearance(forced, cx);
    apply_natively(forced);
}

#[cfg(target_os = "macos")]
fn apply_natively(forced: Option<Appearance>) {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{
        NSAppearance, NSAppearanceNameAqua, NSAppearanceNameDarkAqua, NSApplication,
    };

    let Some(main_thread) = MainThreadMarker::new() else {
        log::error!("the appearance must be set on the main thread");
        return;
    };
    let app = NSApplication::sharedApplication(main_thread);
    let appearance = match forced {
        None => None,
        // SAFETY: AppKit's appearance names are immutable statics.
        Some(Appearance::Light) => NSAppearance::appearanceNamed(unsafe { NSAppearanceNameAqua }),
        Some(Appearance::Dark) => {
            NSAppearance::appearanceNamed(unsafe { NSAppearanceNameDarkAqua })
        }
    };
    app.setAppearance(appearance.as_deref());
}

#[cfg(not(target_os = "macos"))]
fn apply_natively(_forced: Option<Appearance>) {}

/// The theme setting's value as a forced appearance.
pub fn from_setting(value: &str) -> Option<Appearance> {
    match value {
        "light" => Some(Appearance::Light),
        "dark" => Some(Appearance::Dark),
        _ => None,
    }
}
