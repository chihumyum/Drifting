//! The menu bar (from spike P0-A).
//!
//! On macOS the Edit menu is load-bearing: AppKit routes ⌘X/⌘C/⌘V/⌘A through
//! the `cut:`/`copy:`/`paste:`/`selectAll:` items, adds Emoji & Symbols and
//! Dictation to it, and input methods look for it. GPUI turns each item back
//! into the action named here, so a view that handles the action makes the
//! item available.
//!
//! The menus stay in English this round: GPUI makes the menu titled exactly
//! `Window` the macOS Window menu, so a translated title loses the window
//! list (p0-a-skeleton.md, pitfall 6). See f6-shell.md, 「待协调」.
//!
//! Windows has no menu bar: GPUI keeps the menus as data and the key bindings
//! still work.

use dr_i18n::{Key, keys};
use gpui::{App, Menu, MenuItem, OsAction, SystemMenuType};

use crate::ShellInfo;
use crate::actions::{
    About, BringAllToFront, CloseWindow, Copy, Cut, Hide, HideOthers, Minimize, OpenSettings,
    Paste, Quit, Redo, SelectAll, ShowAll, Undo, Zoom,
};

/// See the module comment.
pub const WINDOW_MENU: &str = "Window";

fn label(cx: &App, key: Key, fallback: &str) -> String {
    if cx.has_global::<crate::Strings>() {
        crate::strings::t(cx, key).to_string()
    } else {
        fallback.to_owned()
    }
}

fn label_with_app(cx: &App, key: Key, fallback: String, app: &str) -> String {
    if cx.has_global::<crate::Strings>() {
        crate::strings::tf(cx, key, &[("app", &app)]).to_string()
    } else {
        fallback
    }
}

pub fn app_menus(cx: &App) -> Vec<Menu> {
    use keys::shell_ui as k;
    let name = cx
        .try_global::<ShellInfo>()
        .map_or("Drifting", |info| info.app_name);
    vec![
        Menu::new(name).items([
            MenuItem::action(
                label_with_app(cx, k::MENU_ABOUT, format!("About {name}"), name),
                About,
            ),
            MenuItem::separator(),
            MenuItem::action(label(cx, k::MENU_SETTINGS, "Settings…"), OpenSettings),
            MenuItem::separator(),
            MenuItem::os_submenu(
                label(cx, k::MENU_SERVICES, "Services"),
                SystemMenuType::Services,
            ),
            MenuItem::separator(),
            MenuItem::action(
                label_with_app(cx, k::MENU_HIDE, format!("Hide {name}"), name),
                Hide,
            ),
            MenuItem::action(label(cx, k::MENU_HIDE_OTHERS, "Hide Others"), HideOthers),
            MenuItem::action(label(cx, k::MENU_SHOW_ALL, "Show All"), ShowAll),
            MenuItem::separator(),
            MenuItem::action(
                label_with_app(cx, k::MENU_QUIT, format!("Quit {name}"), name),
                Quit,
            ),
        ]),
        Menu::new(label(cx, k::MENU_EDIT, "Edit")).items([
            MenuItem::os_action(label(cx, k::MENU_UNDO, "Undo"), Undo, OsAction::Undo),
            MenuItem::os_action(label(cx, k::MENU_REDO, "Redo"), Redo, OsAction::Redo),
            MenuItem::separator(),
            MenuItem::os_action(label(cx, k::MENU_CUT, "Cut"), Cut, OsAction::Cut),
            MenuItem::os_action(label(cx, k::MENU_COPY, "Copy"), Copy, OsAction::Copy),
            MenuItem::os_action(label(cx, k::MENU_PASTE, "Paste"), Paste, OsAction::Paste),
            MenuItem::os_action(
                label(cx, k::MENU_SELECT_ALL, "Select All"),
                SelectAll,
                OsAction::SelectAll,
            ),
        ]),
        // Keep `WINDOW_MENU` untranslated so macOS preserves the native Window list.
        Menu::new(WINDOW_MENU).items([
            MenuItem::action(label(cx, k::MENU_MINIMIZE, "Minimize"), Minimize),
            MenuItem::action(label(cx, k::MENU_ZOOM, "Zoom"), Zoom),
            MenuItem::separator(),
            MenuItem::action(label(cx, k::MENU_CLOSE_WINDOW, "Close Window"), CloseWindow),
            MenuItem::separator(),
            MenuItem::action(
                label(cx, k::MENU_BRING_ALL_TO_FRONT, "Bring All to Front"),
                BringAllToFront,
            ),
        ]),
    ]
}

/// The app-wide actions that need no window.
pub fn init(cx: &mut App) {
    cx.on_action(|_: &Quit, cx| crate::quit::request(cx));
    cx.on_action(|_: &Hide, cx| cx.hide());
    cx.on_action(|_: &HideOthers, cx| cx.hide_other_apps());
    cx.on_action(|_: &ShowAll, cx| cx.unhide_other_apps());
    cx.on_action(|_: &BringAllToFront, cx| cx.activate(true));
    cx.on_action(|_: &Minimize, cx| with_active_window(cx, |window| window.minimize_window()));
    cx.on_action(|_: &Zoom, cx| with_active_window(cx, |window| window.zoom_window()));
    cx.on_action(|_: &CloseWindow, cx| with_active_window(cx, |window| window.remove_window()));
}

/// Runs `f` once the current dispatch is over. GPUI checks a window out
/// while it dispatches a menu or key action to it, so an app-level handler
/// that updates that window directly gets "window not found" (P0-A pitfall 4).
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

    #[gpui::test]
    fn the_edit_menu_carries_the_six_system_edit_commands(cx: &mut gpui::TestAppContext) {
        let menus = cx.update(|cx| app_menus(cx));
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
            assert!(action.partial_eq(want_action), "{name}");
            assert!(os_action == Some(want_os), "{name} is the system item");
        }
        assert!(!actions(menu(&menus, WINDOW_MENU)).is_empty());
    }
}
