//! The shortcut registry: every key binding the app makes, in one table.
//!
//! - Every binding goes through GPUI actions and the keymap; nothing reads
//!   raw key events (the 0.1 client had window listeners in several places).
//! - Defaults are the 0.1 client's (`store/shortcuts-store.ts`,
//!   `useDesktopGlobalShortcuts.ts`), without ⌘S: a commit is on disk the
//!   moment it is made (simplifications.md, section 1, item 6).
//! - The shortcuts the 0.1 Settings listed can be rebound; the rebinding is
//!   stored in the settings file (`keys.bindings`, by the 0.1 ids) and
//!   follows the account once preference sync reads it.
//! - `secondary-` is ⌘ on macOS and Ctrl elsewhere, resolved when bound.
//! - Editor actions keep their names (`prose_editor::ToggleBold`, F4) and
//!   are bound by name: only when the editor is linked into the app.
//!
//! [`apply`] clears the keymap and binds everything again, so a rebinding
//! takes effect at once; the menu bar is rebuilt with it. A module's own
//! keys that are not shortcuts (a dialog's ⌘↵, a list's ↑↓) are added with
//! [`add_bindings`] and bound again with the rest.

use std::rc::Rc;

use dr_i18n::{Key, keys};
use gpui::{
    App, Global, KeyBinding, KeyBindingContextPredicate, Keystroke, Modifiers, OperatingSystem,
};
use serde_json::{Map, Value};

/// The workspace's key context.
pub const WORKSPACE: &str = "Workspace";
/// The editor's key context (`gpui_prose::input::actions::KEY_CONTEXT`).
pub const EDITOR: &str = "ProseEditor";
/// The left column's tree while it has the keyboard (KB): its arrows, Enter,
/// Space and Esc ([`crate::actions::left`]).
pub const LEFT_TREE: &str = "LeftColumnTree";
/// The left column's Tab row while it has the keyboard (KB): ← → ↓ and Esc.
pub const LEFT_TABS: &str = "LeftColumnTabs";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Only {
    All,
    Mac,
    NotMac,
}

#[derive(Clone, Copy, Debug)]
pub struct Shortcut {
    /// What a rebinding is stored under: the 0.1 id for the shortcuts it
    /// listed, else the action's name.
    pub id: &'static str,
    /// The GPUI action's name.
    pub action: &'static str,
    /// The default keystrokes, in GPUI's syntax with `secondary-`.
    pub keys: &'static [&'static str],
    pub context: Option<&'static str>,
    /// Listed in Settings → Keys, and so rebindable: its label and line.
    pub listed: Option<(Key, Key)>,
    pub only: Only,
}

const fn listed(
    id: &'static str,
    action: &'static str,
    keys: &'static [&'static str],
    label: Key,
    desc: Key,
) -> Shortcut {
    Shortcut {
        id,
        action,
        keys,
        context: Some(WORKSPACE),
        listed: Some((label, desc)),
        only: Only::All,
    }
}

const fn fixed(
    action: &'static str,
    keys: &'static [&'static str],
    context: Option<&'static str>,
    only: Only,
) -> Shortcut {
    Shortcut {
        id: action,
        action,
        keys,
        context,
        listed: None,
        only,
    }
}

use keys::settings::keys::actions as a;

/// Every binding. The listed ones come first, in the 0.1 Settings order.
pub static REGISTRY: &[Shortcut] = &[
    listed(
        "closeActiveTab",
        "workspace::CloseActiveTab",
        &["secondary-w"],
        a::close_active_tab::LABEL,
        a::close_active_tab::DESC,
    ),
    listed(
        "findInEditor",
        "workspace::FindInEditor",
        &["secondary-f"],
        a::find_in_editor::LABEL,
        a::find_in_editor::DESC,
    ),
    listed(
        "globalSearch",
        "workspace::GlobalSearch",
        &["secondary-shift-f"],
        a::global_search::LABEL,
        a::global_search::DESC,
    ),
    listed(
        "goBack",
        "workspace::GoBack",
        &["secondary-["],
        a::go_back::LABEL,
        a::go_back::DESC,
    ),
    listed(
        "goForward",
        "workspace::GoForward",
        &["secondary-]"],
        a::go_forward::LABEL,
        a::go_forward::DESC,
    ),
    // The 0.1 client also took ⇧⌘[ and ⇧⌘] for these, unlisted.
    listed(
        "prevTab",
        "workspace::PreviousTab",
        &["secondary-alt-left", "secondary-shift-["],
        a::prev_tab::LABEL,
        a::prev_tab::DESC,
    ),
    listed(
        "nextTab",
        "workspace::NextTab",
        &["secondary-alt-right", "secondary-shift-]"],
        a::next_tab::LABEL,
        a::next_tab::DESC,
    ),
    listed(
        "toggleBottomTimeline",
        "workspace::ToggleBottomTimeline",
        &["secondary-j"],
        a::toggle_bottom_timeline::LABEL,
        a::toggle_bottom_timeline::DESC,
    ),
    listed(
        "toggleImmersiveWriting",
        "workspace::ToggleImmersiveWriting",
        &["secondary-shift-enter"],
        a::toggle_immersive_writing::LABEL,
        a::toggle_immersive_writing::DESC,
    ),
    // KB (`kernel-v5.md` §15 item 48; the line's words are the
    // supervisor's, after 「沉浸写作」's).
    listed(
        "focusLeftSidebar",
        "workspace::FocusLeftSidebar",
        &["secondary-shift-l"],
        a::focus_left_sidebar::LABEL,
        a::focus_left_sidebar::DESC,
    ),
    listed(
        "newEntity",
        "workspace::NewEntity",
        &["secondary-n"],
        a::new_entity::LABEL,
        a::new_entity::DESC,
    ),
    // Fixed in the 0.1 client (⌘⌥1). ⌘⌥3–5 retired in v5 T9 (`kernel-v5.md` §17).
    fixed(
        "workspace::ShowProjectHome",
        &["secondary-alt-1"],
        Some(WORKSPACE),
        Only::All,
    ),
    fixed(
        "workspace::ReplaceInEditor",
        &["cmd-alt-f"],
        Some(WORKSPACE),
        Only::Mac,
    ),
    fixed(
        "workspace::ReplaceInEditor",
        &["ctrl-h"],
        Some(WORKSPACE),
        Only::NotMac,
    ),
    fixed(
        "workspace::Dismiss",
        &["escape"],
        Some(WORKSPACE),
        Only::All,
    ),
    // The app and the system's conventions.
    fixed("app::OpenSettings", &["secondary-,"], None, Only::All),
    fixed("app::Quit", &["cmd-q"], None, Only::Mac),
    fixed("app::Hide", &["cmd-h"], None, Only::Mac),
    fixed("app::HideOthers", &["alt-cmd-h"], None, Only::Mac),
    fixed("window::Minimize", &["cmd-m"], None, Only::Mac),
    // Not in the workspace, where ⌘W closes the tab: a binding without a
    // context outranks every context in GPUI.
    fixed(
        "window::CloseWindow",
        &["secondary-w"],
        Some("!Workspace"),
        Only::All,
    ),
    fixed("edit::Undo", &["secondary-z"], None, Only::All),
    fixed("edit::Redo", &["secondary-shift-z"], None, Only::All),
    fixed("edit::Redo", &["ctrl-y"], None, Only::NotMac),
    fixed("edit::Cut", &["secondary-x"], None, Only::All),
    fixed("edit::Copy", &["secondary-c"], None, Only::All),
    fixed("edit::Paste", &["secondary-v"], None, Only::All),
    // ⇧⌘V / Ctrl+Shift+V: only the text, in a body (the 0.1 client's
    // ProseMirror pasted so with Shift held). No menu item: the editor's
    // own key, not the edit menu's.
    fixed(
        "dr_editor::PasteAsPlainText",
        &["secondary-shift-v"],
        Some(EDITOR),
        Only::All,
    ),
    fixed("edit::SelectAll", &["secondary-a"], None, Only::All),
    // The editor's formatting keys, by name (F4's `bind_keys` had them).
    fixed(
        "prose_editor::ToggleBold",
        &["secondary-b"],
        Some(EDITOR),
        Only::All,
    ),
    fixed(
        "prose_editor::ToggleItalic",
        &["secondary-i"],
        Some(EDITOR),
        Only::All,
    ),
    fixed(
        "prose_editor::ToggleUnderline",
        &["secondary-u"],
        Some(EDITOR),
        Only::All,
    ),
    fixed(
        "prose_editor::ToggleStrikethrough",
        &["secondary-shift-x"],
        Some(EDITOR),
        Only::All,
    ),
    fixed(
        "prose_editor::SetBody",
        &["secondary-0"],
        Some(EDITOR),
        Only::All,
    ),
    fixed(
        "prose_editor::SetH1",
        &["secondary-1"],
        Some(EDITOR),
        Only::All,
    ),
    fixed(
        "prose_editor::SetH2",
        &["secondary-2"],
        Some(EDITOR),
        Only::All,
    ),
    fixed(
        "prose_editor::SetH3",
        &["secondary-3"],
        Some(EDITOR),
        Only::All,
    ),
];

impl Shortcut {
    fn applies(&self, os: OperatingSystem) -> bool {
        match self.only {
            Only::All => true,
            Only::Mac => os == OperatingSystem::Mac,
            Only::NotMac => os != OperatingSystem::Mac,
        }
    }

    /// The keystrokes in force: the rebinding if any ("" = none), else the
    /// defaults.
    pub fn effective(&self, overrides: &Map<String, Value>) -> Vec<String> {
        if self.listed.is_some()
            && let Some(Value::String(keys)) = overrides.get(self.id)
        {
            return if keys.is_empty() {
                Vec::new()
            } else {
                vec![keys.clone()]
            };
        }
        self.keys.iter().map(|k| (*k).to_owned()).collect()
    }
}

pub fn listed_shortcuts() -> impl Iterator<Item = &'static Shortcut> {
    REGISTRY.iter().filter(|s| s.listed.is_some())
}

pub fn find(id: &str) -> Option<&'static Shortcut> {
    REGISTRY.iter().find(|s| s.id == id)
}

/// Every binding the registry makes on `os` with `overrides`, as
/// (action name, keystrokes, context), skipping actions this build does not
/// have.
pub fn bindings(
    os: OperatingSystem,
    overrides: &Map<String, Value>,
) -> Vec<(&'static str, String, Option<&'static str>)> {
    REGISTRY
        .iter()
        .filter(|s| s.applies(os))
        .flat_map(|s| {
            s.effective(overrides)
                .into_iter()
                .map(move |k| (s.action, k, s.context))
        })
        .collect()
}

/// Clears the keymap and binds the inputs', the registry's and the
/// rebindings again, then rebuilds the menu bar so it shows them.
pub fn apply(overrides: &Map<String, Value>, cx: &mut App) {
    let os = cx.platform_info().os;
    cx.clear_key_bindings();
    cx.bind_keys(dr_ui::input::field::bindings());
    // The left column's keys (KB) in its own contexts, and those of a hover
    // card the keyboard walks.
    cx.bind_keys(left_column_bindings());
    cx.bind_keys(dr_ui::components::hover_card::key_bindings());
    // The editor's own keys (moving, deleting, Enter …) in its context; its
    // formatting keys are the registry's below as well.
    cx.bind_keys(gpui_prose::input::actions::key_bindings(
        gpui_prose::input::actions::KeyScheme::native(),
    ));
    // The modules' own keys.
    let extra: Vec<Rc<dyn Fn() -> Vec<KeyBinding>>> = cx
        .try_global::<ModuleKeys>()
        .map(|m| m.0.clone())
        .unwrap_or_default();
    for make in extra {
        cx.bind_keys(make());
    }
    let mut made = Vec::new();
    for (action, keys, context) in bindings(os, overrides) {
        let Ok(action) = cx.build_action(action, None) else {
            // The editor is not linked into this build yet.
            log::debug!("no action {action} in this build; not bound");
            continue;
        };
        let predicate =
            context.map(|c| Rc::new(KeyBindingContextPredicate::parse(c).expect("valid context")));
        match KeyBinding::load(&keys, action, predicate, false, None, cx) {
            Ok(binding) => made.push(binding),
            Err(error) => log::warn!("shortcut {keys:?} does not parse: {error}"),
        }
    }
    cx.bind_keys(made);
    cx.set_menus(crate::menus::app_menus(cx));
}

/// The left column's own keys (KB): the tree's arrows, Enter, Space and
/// Esc; the Tab row's ← → ↓ and Esc. Anything else there does nothing.
pub fn left_column_bindings() -> Vec<KeyBinding> {
    use crate::actions::left::{Back, Down, Enter, Left, Right, Space, Up};
    let tree = Some(LEFT_TREE);
    let tabs = Some(LEFT_TABS);
    vec![
        KeyBinding::new("up", Up, tree),
        KeyBinding::new("down", Down, tree),
        KeyBinding::new("left", Left, tree),
        KeyBinding::new("right", Right, tree),
        KeyBinding::new("enter", Enter, tree),
        KeyBinding::new("space", Space, tree),
        KeyBinding::new("escape", Back, tree),
        KeyBinding::new("down", Down, tabs),
        KeyBinding::new("left", Left, tabs),
        KeyBinding::new("right", Right, tabs),
        KeyBinding::new("escape", Back, tabs),
    ]
}

#[derive(Default)]
struct ModuleKeys(Vec<Rc<dyn Fn() -> Vec<KeyBinding>>>);

impl Global for ModuleKeys {}

/// A module's own key bindings, in its own key context (a dialog's ⌘↵, a
/// list's ↑↓): not shortcuts the author rebinds, so not in the registry.
/// Bound now and again whenever [`apply`] rebuilds the keymap (which clears
/// every binding). `make` builds them each time.
pub fn add_bindings(cx: &mut App, make: impl Fn() -> Vec<KeyBinding> + 'static) {
    let make: Rc<dyn Fn() -> Vec<KeyBinding>> = Rc::new(make);
    cx.bind_keys(make());
    cx.default_global::<ModuleKeys>().0.push(make);
}

/// A recorded keystroke in the stored, portable form: the platform's
/// primary modifier (⌘ on macOS, Ctrl elsewhere) becomes `secondary-`.
/// `None` for a bare modifier or a key that needs no modifier to type.
pub fn portable(keystroke: &Keystroke, os: OperatingSystem) -> Option<String> {
    let m = keystroke.modifiers;
    let key = keystroke.key.as_str();
    if key.is_empty() || ["shift", "control", "alt", "platform", "function"].contains(&key) {
        return None;
    }
    let primary = if os == OperatingSystem::Mac {
        m.platform
    } else {
        m.control
    };
    // Without ⌘/Ctrl (or ⌥ with something), a key types text.
    let function_key = key.starts_with('f') && key.len() > 1 && key[1..].parse::<u8>().is_ok();
    if !primary && !m.alt && !function_key {
        return None;
    }
    let mut out = String::new();
    if os == OperatingSystem::Mac && m.control {
        out.push_str("ctrl-");
    }
    if m.alt {
        out.push_str("alt-");
    }
    if m.shift {
        out.push_str("shift-");
    }
    if primary {
        out.push_str("secondary-");
    }
    if os != OperatingSystem::Mac && m.platform {
        out.push_str("win-");
    }
    out.push_str(key);
    Some(out)
}

/// How a binding reads: `⌘⇧F` on macOS, `Ctrl+Shift+F` elsewhere (the 0.1
/// client's `formatAccelerator`).
pub fn display(keys: &str, os: OperatingSystem) -> String {
    let Ok(keystroke) = Keystroke::parse_with_os(keys, os) else {
        return keys.to_owned();
    };
    let Modifiers {
        control,
        alt,
        shift,
        platform,
        ..
    } = keystroke.modifiers;
    let mac = os == OperatingSystem::Mac;
    let mut parts: Vec<String> = Vec::new();
    if mac {
        if platform {
            parts.push("⌘".into());
        }
        if control {
            parts.push("⌃".into());
        }
    } else if control {
        parts.push("Ctrl".into());
    }
    if alt {
        parts.push(if mac { "⌥" } else { "Alt" }.into());
    }
    if shift {
        parts.push(if mac { "⇧" } else { "Shift" }.into());
    }
    if !mac && platform {
        parts.push("Win".into());
    }
    let key = match keystroke.key.as_str() {
        "left" => "←".to_owned(),
        "right" => "→".to_owned(),
        "up" => "↑".to_owned(),
        "down" => "↓".to_owned(),
        "enter" => if mac { "↩" } else { "Enter" }.to_owned(),
        "escape" => "Esc".to_owned(),
        "backspace" => if mac { "⌫" } else { "Backspace" }.to_owned(),
        "space" => if mac { "␣" } else { "Space" }.to_owned(),
        "tab" => if mac { "⇥" } else { "Tab" }.to_owned(),
        k if k.chars().count() == 1 => k.to_uppercase(),
        k => k.to_owned(),
    };
    parts.push(key);
    parts.join(if mac { "" } else { "+" })
}

/// Another listed shortcut, or a fixed one in the workspace or app-wide,
/// that already uses `keys` on `os`.
pub fn conflict(
    id: &str,
    keys: &str,
    os: OperatingSystem,
    overrides: &Map<String, Value>,
) -> Option<&'static Shortcut> {
    let wanted = Keystroke::parse_with_os(keys, os).ok()?;
    REGISTRY.iter().find(|s| {
        s.id != id
            && s.applies(os)
            && s.context != Some(EDITOR)
            && s.effective(overrides).iter().any(|k| {
                Keystroke::parse_with_os(k, os)
                    .is_ok_and(|k| k.modifiers == wanted.modifiers && k.key == wanted.key)
            })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_defaults_are_the_0_1_clients_without_save() {
        assert!(find("saveCurrentEditor").is_none());
        let none = Map::new();
        for os in [OperatingSystem::Mac, OperatingSystem::Windows] {
            for (action, keys, _) in bindings(os, &none) {
                assert!(
                    Keystroke::parse_with_os(&keys, os).is_ok(),
                    "{action} {keys}"
                );
                assert_ne!(keys, "secondary-s", "nothing saves by hand");
            }
        }
        let back = find("goBack").unwrap();
        assert_eq!(back.effective(&none), ["secondary-["]);
        assert_eq!(display("secondary-shift-f", OperatingSystem::Mac), "⌘⇧F");
        assert_eq!(
            display("secondary-shift-f", OperatingSystem::Windows),
            "Ctrl+Shift+F"
        );
        assert_eq!(display("secondary-alt-left", OperatingSystem::Mac), "⌘⌥←");
        // The 0.1 client listed 11; 关闭项目 (⇧⌘W) went on 2026-11-14;
        // 进出左栏 (⌘⇧L) came with KB on 2026-11-17.
        assert_eq!(listed_shortcuts().count(), 11);
        let left = find("focusLeftSidebar").unwrap();
        assert_eq!(left.effective(&none), ["secondary-shift-l"]);
        assert_eq!(display("secondary-shift-l", OperatingSystem::Mac), "⌘⇧L");
        assert_eq!(
            display("secondary-shift-l", OperatingSystem::Windows),
            "Ctrl+Shift+L"
        );
        assert!(find("closeProject").is_none());
    }

    /// S2 (作者 2026-11-24): ⇧⌘V, Ctrl+Shift+V off macOS, pastes only the
    /// text in the editor; nothing else has the key, and it is not one the
    /// author rebinds (no line in Settings, no menu item).
    #[test]
    fn shift_paste_is_the_editors_plain_text_paste_on_both_systems() {
        let none = Map::new();
        for (os, shown) in [
            (OperatingSystem::Mac, "⌘⇧V"),
            (OperatingSystem::Windows, "Ctrl+Shift+V"),
        ] {
            let all = bindings(os, &none);
            let plain: Vec<_> = all
                .iter()
                .filter(|(action, ..)| *action == "dr_editor::PasteAsPlainText")
                .collect();
            assert_eq!(plain.len(), 1, "{os:?}");
            let (_, keys, context) = plain[0];
            assert_eq!(
                (keys.as_str(), *context),
                ("secondary-shift-v", Some(EDITOR))
            );
            assert_eq!(display(keys, os), shown);
            let wanted = Keystroke::parse_with_os(keys, os).unwrap();
            for (action, keys, _) in &all {
                if *action != "dr_editor::PasteAsPlainText" {
                    let other = Keystroke::parse_with_os(keys, os).unwrap();
                    assert!(
                        other.modifiers != wanted.modifiers || other.key != wanted.key,
                        "{action} {keys} on {os:?}"
                    );
                }
            }
        }
        let shortcut = find("dr_editor::PasteAsPlainText").unwrap();
        assert!(shortcut.listed.is_none());
    }

    #[test]
    fn a_rebinding_replaces_the_defaults_and_empty_unbinds() {
        let mut overrides = Map::new();
        overrides.insert("prevTab".into(), Value::from("secondary-alt-p"));
        overrides.insert("nextTab".into(), Value::from(""));
        // Fixed shortcuts ignore stray overrides.
        overrides.insert("workspace::Dismiss".into(), Value::from("q"));
        let all = bindings(OperatingSystem::Mac, &overrides);
        let of = |action: &str| -> Vec<String> {
            all.iter()
                .filter(|(a, ..)| *a == action)
                .map(|(_, k, _)| k.clone())
                .collect()
        };
        assert_eq!(of("workspace::PreviousTab"), ["secondary-alt-p"]);
        assert!(of("workspace::NextTab").is_empty());
        assert_eq!(of("workspace::Dismiss"), ["escape"]);
    }

    #[test]
    fn recorded_keystrokes_are_stored_portably() {
        let mac = OperatingSystem::Mac;
        let k = |s: &str| Keystroke::parse(Box::leak(s.to_owned().into_boxed_str())).unwrap();
        assert_eq!(
            portable(&k("cmd-shift-k"), mac).as_deref(),
            Some("shift-secondary-k")
        );
        assert_eq!(
            portable(&k("ctrl-k"), OperatingSystem::Windows).as_deref(),
            Some("secondary-k")
        );
        assert_eq!(portable(&k("alt-k"), mac).as_deref(), Some("alt-k"));
        assert_eq!(portable(&k("k"), mac), None, "a bare key types text");
        assert_eq!(portable(&k("shift-k"), mac), None);
        assert_eq!(portable(&k("f5"), mac).as_deref(), Some("f5"));
        // Stored keys bind and read back the same on both systems.
        assert_eq!(display("shift-secondary-k", mac), "⌘⇧K");
    }

    #[test]
    fn conflicts_are_found_across_listed_and_fixed_shortcuts() {
        let none = Map::new();
        let mac = OperatingSystem::Mac;
        let hit = conflict("goBack", "secondary-]", mac, &none).unwrap();
        assert_eq!(hit.id, "goForward");
        let hit = conflict("goBack", "secondary-,", mac, &none).unwrap();
        assert_eq!(hit.action, "app::OpenSettings");
        assert!(
            conflict("goBack", "secondary-[", mac, &none).is_none(),
            "itself"
        );
        assert!(
            conflict("goBack", "secondary-b", mac, &none).is_none(),
            "editor keys live in their own context"
        );
    }
}
