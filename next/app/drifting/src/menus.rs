//! The menu bar and the key bindings behind it.
//!
//! On macOS the Edit menu is load-bearing: AppKit routes ⌘X/⌘C/⌘V/⌘A through
//! the `cut:`/`copy:`/`paste:`/`selectAll:` menu items, adds Emoji & Symbols
//! and Dictation to it, and input methods look for it. GPUI turns each item
//! back into the action named here, so a view that handles the action makes the
//! item available; with nothing focused that handles it, the item is disabled.
//!
//! Windows has no menu bar: GPUI keeps the menus as data and the key bindings
//! still work. F6 decides whether to draw an in-window menu there.

use gpui::{App, KeyBinding, Menu, MenuItem, OsAction, SystemMenuType, actions};

use crate::identity::APP_NAME;

actions!(
    app,
    [
        /// Opens the About window.
        About,
        /// Opens Settings (a placeholder until F6).
        OpenSettings,
        /// Hides the app (macOS).
        Hide,
        /// Hides every other app (macOS).
        HideOthers,
        /// Shows every hidden app (macOS).
        ShowAll,
        /// Quits the app.
        Quit,
        /// Closes a placeholder or overlay.
        Dismiss,
    ]
);

actions!(
    edit,
    [
        /// Undoes the focused view's last change.
        Undo,
        /// Redoes the focused view's last undone change.
        Redo,
        /// Cuts the selection.
        Cut,
        /// Copies the selection.
        Copy,
        /// Pastes the clipboard.
        Paste,
        /// Selects everything in the focused view.
        SelectAll,
    ]
);

actions!(
    window,
    [
        /// Minimizes the active window.
        Minimize,
        /// Zooms the active window.
        Zoom,
        /// Closes the active window.
        CloseWindow,
        /// Brings every window of the app to the front.
        BringAllToFront,
    ]
);

/// GPUI makes the menu with exactly this title the macOS Window menu, which
/// AppKit then fills with the open windows. A translated title would lose
/// that, so this one stays English until GPUI identifies the menu otherwise.
pub const WINDOW_MENU: &str = "Window";

pub fn app_menus() -> Vec<Menu> {
    vec![
        Menu::new(APP_NAME).items([
            MenuItem::action(format!("About {APP_NAME}"), About),
            MenuItem::separator(),
            MenuItem::action("Settings…", OpenSettings),
            MenuItem::separator(),
            MenuItem::os_submenu("Services", SystemMenuType::Services),
            MenuItem::separator(),
            MenuItem::action(format!("Hide {APP_NAME}"), Hide),
            MenuItem::action("Hide Others", HideOthers),
            MenuItem::action("Show All", ShowAll),
            MenuItem::separator(),
            MenuItem::action(format!("Quit {APP_NAME}"), Quit),
        ]),
        Menu::new("Edit").items([
            MenuItem::os_action("Undo", Undo, OsAction::Undo),
            MenuItem::os_action("Redo", Redo, OsAction::Redo),
            MenuItem::separator(),
            MenuItem::os_action("Cut", Cut, OsAction::Cut),
            MenuItem::os_action("Copy", Copy, OsAction::Copy),
            MenuItem::os_action("Paste", Paste, OsAction::Paste),
            MenuItem::os_action("Select All", SelectAll, OsAction::SelectAll),
        ]),
        Menu::new(WINDOW_MENU).items([
            MenuItem::action("Minimize", Minimize),
            MenuItem::action("Zoom", Zoom),
            MenuItem::separator(),
            MenuItem::action("Close Window", CloseWindow),
            MenuItem::separator(),
            MenuItem::action("Bring All to Front", BringAllToFront),
        ]),
    ]
}

/// `primary!("z")` is `cmd-z` on macOS and `ctrl-z` elsewhere. GPUI's own
/// `secondary-` modifier only parses in keymap files loaded for an OS;
/// `KeyBinding::new` panics on it.
macro_rules! primary {
    ($keys:literal) => {
        if cfg!(target_os = "macos") {
            concat!("cmd-", $keys)
        } else {
            concat!("ctrl-", $keys)
        }
    };
}

pub fn key_bindings() -> Vec<KeyBinding> {
    let mut bindings = vec![
        KeyBinding::new(primary!(","), OpenSettings, None),
        KeyBinding::new(primary!("z"), Undo, None),
        KeyBinding::new(primary!("shift-z"), Redo, None),
        KeyBinding::new(primary!("x"), Cut, None),
        KeyBinding::new(primary!("c"), Copy, None),
        KeyBinding::new(primary!("v"), Paste, None),
        KeyBinding::new(primary!("a"), SelectAll, None),
        KeyBinding::new(primary!("w"), CloseWindow, None),
        KeyBinding::new("escape", Dismiss, None),
    ];
    if cfg!(target_os = "macos") {
        bindings.extend([
            KeyBinding::new("cmd-h", Hide, None),
            KeyBinding::new("alt-cmd-h", HideOthers, None),
            KeyBinding::new("cmd-q", Quit, None),
            KeyBinding::new("cmd-m", Minimize, None),
        ]);
    } else {
        bindings.push(KeyBinding::new("ctrl-y", Redo, None));
    }
    bindings
}

/// Installs the app-wide actions, the key bindings and the menu bar.
pub fn init(cx: &mut App) {
    cx.on_action(|_: &Quit, cx| cx.quit());
    cx.on_action(|_: &Hide, cx| cx.hide());
    cx.on_action(|_: &HideOthers, cx| cx.hide_other_apps());
    cx.on_action(|_: &ShowAll, cx| cx.unhide_other_apps());
    cx.on_action(|_: &BringAllToFront, cx| cx.activate(true));
    cx.on_action(|_: &Minimize, cx| with_active_window(cx, |window| window.minimize_window()));
    cx.on_action(|_: &Zoom, cx| with_active_window(cx, |window| window.zoom_window()));
    cx.on_action(|_: &CloseWindow, cx| with_active_window(cx, |window| window.remove_window()));

    cx.bind_keys(key_bindings());
    cx.set_menus(app_menus());
}

/// Runs `f` on the active window once the current dispatch is over. GPUI
/// checks a window out while it dispatches a menu or key action to it, so an
/// app-level handler that updates that window directly gets "window not found".
pub fn after_dispatch(cx: &mut App, f: impl FnOnce(&mut App) + 'static) {
    cx.defer(f);
}

fn with_active_window(cx: &mut App, f: impl FnOnce(&mut gpui::Window) + 'static) {
    after_dispatch(cx, |cx| {
        if let Some(handle) = cx.active_window()
            && let Err(error) = handle.update(cx, |_, window, _| f(window))
        {
            log::error!("could not reach the active window: {error:#}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::Action;

    fn menu<'a>(menus: &'a [Menu], name: &str) -> &'a Menu {
        menus
            .iter()
            .find(|menu| menu.name.as_ref() == name)
            .unwrap_or_else(|| panic!("there is a {name} menu"))
    }

    fn actions(menu: &Menu) -> Vec<(&str, &dyn Action, Option<OsAction>)> {
        menu.items
            .iter()
            .filter_map(|item| match item {
                MenuItem::Action {
                    name,
                    action,
                    os_action,
                    ..
                } => Some((name.as_ref(), action.as_ref(), *os_action)),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn the_edit_menu_carries_the_six_system_edit_commands() {
        let menus = app_menus();
        let edit = actions(menu(&menus, "Edit"));
        let expected: [(&str, &dyn Action, OsAction); 6] = [
            ("Undo", &Undo, OsAction::Undo),
            ("Redo", &Redo, OsAction::Redo),
            ("Cut", &Cut, OsAction::Cut),
            ("Copy", &Copy, OsAction::Copy),
            ("Paste", &Paste, OsAction::Paste),
            ("Select All", &SelectAll, OsAction::SelectAll),
        ];
        assert_eq!(edit.len(), expected.len());
        for ((name, action, os_action), (want_name, want_action, want_os)) in
            edit.into_iter().zip(expected)
        {
            assert_eq!(name, want_name);
            assert!(
                action.partial_eq(want_action),
                "{name} dispatches its action"
            );
            assert!(os_action == Some(want_os), "{name} is the system item");
        }
    }

    #[test]
    fn the_app_menu_comes_first_and_the_window_menu_keeps_its_english_title() {
        let menus = app_menus();
        assert_eq!(menus[0].name.as_ref(), APP_NAME);
        let app: Vec<_> = actions(&menus[0])
            .into_iter()
            .map(|(name, ..)| name)
            .collect();
        assert_eq!(
            app,
            [
                "About Drifting Next",
                "Settings…",
                "Hide Drifting Next",
                "Hide Others",
                "Show All",
                "Quit Drifting Next",
            ]
        );
        let window = menu(&menus, WINDOW_MENU);
        assert_eq!(WINDOW_MENU, "Window");
        assert!(!actions(window).is_empty());
    }

    #[test]
    fn the_primary_modifier_follows_the_platform() {
        let expected = if cfg!(target_os = "macos") {
            "cmd-z"
        } else {
            "ctrl-z"
        };
        assert_eq!(primary!("z"), expected);
    }

    #[test]
    fn every_edit_command_has_a_shortcut() {
        let bindings = key_bindings();
        let edit: [&dyn Action; 6] = [&Undo, &Redo, &Cut, &Copy, &Paste, &SelectAll];
        for action in edit {
            assert!(
                bindings
                    .iter()
                    .any(|binding| binding.action().partial_eq(action)),
                "{} has a key binding",
                action.name()
            );
        }
    }
}
