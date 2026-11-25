//! The 0.1 client's settings and shortcuts, as this client takes them over
//! (`docs/rust-rewrite/modules/m10-import.md`, 「0.1 的设置、快捷键和工作记忆
//! （2026-11-21）」, which has the table in words).
//!
//! One table, two ways in:
//!
//! - **At import** ([`adopt`]): what the 0.1 hand-over captured from this
//!   device's WebView storage (`settings-storage`, `shortcuts-storage`,
//!   `project-checkin`; `docs/v2-handoff.md`) goes into the keys the author
//!   has not set here. The caller does it once per device and records the
//!   rows this returns.
//! - **Through the account** ([`synced_source`], [`convert_synced`]): the
//!   preferences a 0.1 client synced under its own names
//!   (`preference-fields.ts`). M37's merge takes one for a key of this
//!   client that holds no change yet (`dr-view-account`).
//!
//! 0.1 persisted every field, chosen or not, so at import a value equal to
//! 0.1's own default is no choice the author made and is left to this
//! client's default. A field whose meaning differs here, or that has no
//! setting here, is listed in [`NO_EQUIVALENT`] with why; nothing is guessed.

use std::collections::BTreeMap;

use gpui::{Keystroke, OperatingSystem};
use serde::Serialize;
use serde_json::{Map, Value};

use super::registry::{self, SettingDef};
use super::store::{KEY_BINDINGS, SettingsFile};
use crate::keymap;

/// The persisted settings store of 0.1 (`settings-store.ts`).
pub const SETTINGS_STORE: &str = "settings-storage";
/// The persisted shortcuts store of 0.1 (`shortcuts-store.ts`).
pub const SHORTCUTS_STORE: &str = "shortcuts-storage";
/// The project check-in store of 0.1 (`project-checkin-store.ts`): its
/// `enabled` is the 主动建议 switch.
pub const CHECKIN_STORE: &str = "project-checkin";
/// The key 0.1 synced its shortcut bindings under (`preference-fields.ts`).
pub const SYNCED_SHORTCUTS: &str = "shortcutBindings";

/// 0.1's own default of a field.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Default01 {
    Str(&'static str),
    Num(f64),
    Bool(bool),
    Null,
    EmptyObject,
    EmptyArray,
    /// The system's language (0.1 stored the one it found at first launch).
    SystemLocale,
    /// `DEFAULT_ENTITY_LINK_KIND_COLORS`.
    LinkColors,
}

/// A 0.1 field with a setting of the same meaning here.
#[derive(Clone, Copy, Debug)]
pub struct Field {
    /// The 0.1 store the field is in (its WebView storage key).
    pub store: &'static str,
    /// The field of the store's persisted `state`. For a synced field it is
    /// also the key 0.1 synced it under.
    pub field: &'static str,
    /// The key here (`registry.rs`).
    pub key: &'static str,
    pub default: Default01,
    /// 0.1 synced it through the account (`preference-fields.ts`).
    pub synced: bool,
}

const fn field(
    store: &'static str,
    name: &'static str,
    key: &'static str,
    default: Default01,
    synced: bool,
) -> Field {
    Field {
        store,
        field: name,
        key,
        default,
        synced,
    }
}

use Default01 as D;

/// Every 0.1 setting with an equivalent here. The value is the same on both
/// sides; [`convert`] only checks it (and clamps a number) the way the
/// registry does.
pub static FIELDS: &[Field] = &[
    field(
        SETTINGS_STORE,
        "themeMode",
        registry::THEME,
        D::Str("light"),
        true,
    ),
    field(
        SETTINGS_STORE,
        "accentColor",
        registry::ACCENT_COLOR,
        D::Null,
        true,
    ),
    field(
        SETTINGS_STORE,
        "agentEditRevealAnimation",
        registry::AGENT_EDIT_REVEAL_ANIMATION,
        D::Bool(true),
        true,
    ),
    // The same five sizes; 0.1 renamed them at its store version 35.
    field(
        SETTINGS_STORE,
        "interfaceTextSize",
        registry::TEXT_SIZE,
        D::Str("standard"),
        false,
    ),
    field(
        SETTINGS_STORE,
        "uiLocale",
        registry::UI_LOCALE,
        D::SystemLocale,
        true,
    ),
    field(
        SETTINGS_STORE,
        "editorFontSource",
        registry::FONT_SOURCE,
        D::Str("system-serif"),
        false,
    ),
    field(
        SETTINGS_STORE,
        "editorSystemFontFamily",
        registry::FONT_FAMILY,
        D::Str(""),
        false,
    ),
    field(
        SETTINGS_STORE,
        "bodyFontSize",
        registry::FONT_SIZE,
        D::Num(17.0),
        true,
    ),
    field(
        SETTINGS_STORE,
        "lineHeight",
        registry::LINE_HEIGHT,
        D::Num(1.5),
        true,
    ),
    field(
        SETTINGS_STORE,
        "editorTextWrap",
        registry::TEXT_WRAP,
        D::Str("stable"),
        false,
    ),
    // 0.1 allowed up to 3 em, this client 2.5.
    field(
        SETTINGS_STORE,
        "paragraphSpacing",
        registry::PARAGRAPH_SPACING,
        D::Num(1.0),
        true,
    ),
    field(
        SETTINGS_STORE,
        "maxLineWidth",
        registry::PAGE_WIDTH,
        D::Num(720.0),
        true,
    ),
    field(
        SETTINGS_STORE,
        "paragraphIndent",
        registry::PARAGRAPH_INDENT,
        D::Str("none"),
        true,
    ),
    field(
        SETTINGS_STORE,
        "editorIndentStep",
        registry::TAB_INDENT_WIDTH,
        D::Num(2.0),
        true,
    ),
    field(
        SETTINGS_STORE,
        "autoImmersiveWriting",
        registry::AUTO_IMMERSIVE,
        D::Bool(false),
        true,
    ),
    field(
        SETTINGS_STORE,
        "typewriterMode",
        registry::TYPEWRITER,
        D::Bool(false),
        true,
    ),
    field(
        SETTINGS_STORE,
        "typewriterPosition",
        registry::TYPEWRITER_POSITION,
        D::Num(50.0),
        true,
    ),
    field(
        SETTINGS_STORE,
        "caretColor",
        registry::CARET_COLOR,
        D::Str("#6b7fa6"),
        true,
    ),
    field(
        SETTINGS_STORE,
        "autoElementLinkEnabled",
        registry::AUTO_ENTITY_LINKS,
        D::Bool(true),
        true,
    ),
    field(
        SETTINGS_STORE,
        "entityLinkInteractive",
        registry::ENTITY_LINK_INTERACTIVE,
        D::Bool(true),
        true,
    ),
    field(
        SETTINGS_STORE,
        "commentMarksVisible",
        registry::COMMENT_MARKS_VISIBLE,
        D::Bool(true),
        true,
    ),
    field(
        SETTINGS_STORE,
        "entityLinkColorMode",
        registry::ENTITY_LINK_COLOR_MODE,
        D::Str("contextual"),
        true,
    ),
    field(
        SETTINGS_STORE,
        "entityLinkHighlightMode",
        registry::ENTITY_LINK_HIGHLIGHT_MODE,
        D::Str("both"),
        true,
    ),
    field(
        SETTINGS_STORE,
        "entityLinkBandStyle",
        registry::ENTITY_LINK_BAND_STYLE,
        D::Str("wash"),
        true,
    ),
    field(
        SETTINGS_STORE,
        "entityLinkKindColors",
        registry::ENTITY_LINK_KIND_COLORS,
        D::LinkColors,
        true,
    ),
    // `null` is no cap on both sides.
    field(
        SETTINGS_STORE,
        "agentTurnIterationLimit",
        registry::AGENT_MAX_MODEL_ROUNDS,
        D::Num(50.0),
        true,
    ),
    field(
        SETTINGS_STORE,
        "sendCrashLogs",
        registry::CRASH_REPORTS,
        D::Bool(true),
        false,
    ),
    field(
        CHECKIN_STORE,
        "enabled",
        registry::AGENT_PROACTIVE,
        D::Bool(true),
        false,
    ),
];

/// A 0.1 field that is not taken over, its 0.1 default, and why.
#[derive(Clone, Copy, Debug)]
pub struct NoEquivalent {
    pub field: &'static str,
    pub default: Default01,
    pub why: &'static str,
}

const fn none(field: &'static str, default: Default01, why: &'static str) -> NoEquivalent {
    NoEquivalent {
        field,
        default,
        why,
    }
}

/// Every other field of 0.1's `settings-storage` state.
pub static NO_EQUIVALENT: &[NoEquivalent] = &[
    none(
        "outlineRailMode",
        D::Str("visible"),
        "no outline rail switch here",
    ),
    none(
        "recentEntitiesLimit",
        D::Num(10.0),
        "no recent list length here",
    ),
    none(
        "editorUndoDepth",
        D::Num(100.0),
        "no undo depth setting here",
    ),
    none(
        "autoSnapshot",
        D::Bool(true),
        "history is always kept here (M09)",
    ),
    none(
        "agentAuth",
        D::Str("apikey"),
        "a retired credential token of 0.1",
    ),
    none(
        "agentProvider",
        D::Str("deepseek"),
        "chosen through the model connection here, which checks the provider is connected",
    ),
    none(
        "agentModel",
        D::Str("deepseek-flash"),
        "chosen through the model connection here, which gives the model a thinking level it supports",
    ),
    none(
        "agentEffort",
        D::Str("high"),
        "0.1 kept effort and thinking apart; here one level, whose choices depend on the model",
    ),
    none(
        "agentThinking",
        D::Str("off"),
        "0.1 kept effort and thinking apart; here one level, whose choices depend on the model",
    ),
    none(
        "agentToolSearch",
        D::Str("auto"),
        "no tool search switch here",
    ),
    none(
        "lastAgentConvByProject",
        D::EmptyObject,
        "0.1 conversations are kept read-only; there is none to reopen",
    ),
    none(
        "agentOnboardingStep",
        D::Str("new"),
        "a guide this device has seen, not a setting",
    ),
    none(
        "guidesSeen",
        D::EmptyArray,
        "guides this device has seen, not a setting",
    ),
];

/// The 0.1 shortcut ids (`shortcuts-store.ts`), their 0.1 defaults, and the
/// listed shortcut here with the same id (`keymap::REGISTRY` keeps 0.1's
/// ids), or why there is none.
pub static SHORTCUTS: &[(&str, &str, Result<&str, &str>)] = &[
    ("closeActiveTab", "Mod+W", Ok("closeActiveTab")),
    ("findInEditor", "Mod+F", Ok("findInEditor")),
    ("globalSearch", "Mod+Shift+F", Ok("globalSearch")),
    (
        "saveCurrentEditor",
        "Mod+S",
        Err("nothing is saved by hand here"),
    ),
    ("goBack", "Mod+[", Ok("goBack")),
    ("goForward", "Mod+]", Ok("goForward")),
    ("prevTab", "Mod+Alt+ArrowLeft", Ok("prevTab")),
    ("nextTab", "Mod+Alt+ArrowRight", Ok("nextTab")),
    ("toggleBottomTimeline", "Mod+J", Ok("toggleBottomTimeline")),
    (
        "toggleImmersiveWriting",
        "Mod+Shift+Enter",
        Ok("toggleImmersiveWriting"),
    ),
    ("newEntity", "Mod+N", Ok("newEntity")),
    (
        "closeProject",
        "Mod+Shift+W",
        Err("closing a project from the keyboard was retired (2026-11-14)"),
    ),
];

/// What became of one 0.1 value.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Outcome {
    /// Taken over as it was.
    Adopted,
    /// Taken over, brought into this client's range.
    Clamped,
    /// Set here already (or carrying a change of the account's preference
    /// sync): left as it is.
    KeptHere,
    /// 0.1's own default, or this client's: nothing to take over.
    Default,
    /// No setting of the same meaning here.
    NoEquivalent,
    /// Not a value this client takes (an unknown option, a chord it cannot
    /// read).
    Invalid,
    /// A shortcut whose chord another command here already has.
    Conflict,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::Adopted => "adopted",
            Outcome::Clamped => "clamped",
            Outcome::KeptHere => "kept-here",
            Outcome::Default => "default",
            Outcome::NoEquivalent => "no-equivalent",
            Outcome::Invalid => "invalid",
            Outcome::Conflict => "conflict",
        }
    }
}

/// One row of what [`adopt`] did.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Carried {
    /// `setting` or `shortcut`.
    pub kind: &'static str,
    /// `<store>.<field>` for a setting, the 0.1 id for a shortcut.
    pub old_key: String,
    pub new_key: Option<String>,
    pub outcome: Outcome,
    pub old_value: Option<Value>,
    pub new_value: Option<Value>,
    pub detail: Option<String>,
}

/// The circumstances [`adopt`] needs from the app.
pub struct Here<'a> {
    pub os: OperatingSystem,
    /// The language this client picks from the system (`Locale::from_system`).
    pub system_locale: &'a str,
    /// Whether this client's preference sync holds a change for a key
    /// (a ledger entry later than `UNCHANGED_AT`, `dr-view-account`).
    pub stamped: &'a dyn Fn(&str) -> bool,
}

/// The `state` (and `version`) of a persisted 0.1 store, from its raw
/// WebView storage value.
fn persisted(raw: Option<&String>) -> Option<(Map<String, Value>, Option<i64>)> {
    let value: Value = serde_json::from_str(raw?).ok()?;
    let state = value.get("state")?.as_object()?.clone();
    Some((state, value.get("version").and_then(Value::as_i64)))
}

/// Whether the hand-over captured anything [`adopt`] reads.
pub fn has_captured(entries: &BTreeMap<String, String>) -> bool {
    [SETTINGS_STORE, SHORTCUTS_STORE, CHECKIN_STORE]
        .iter()
        .any(|store| persisted(entries.get(*store)).is_some())
}

fn is_default(value: &Value, default: Default01, system_locale: &str) -> bool {
    match default {
        D::Str(s) => value.as_str() == Some(s),
        D::Num(n) => value.as_f64() == Some(n),
        D::Bool(b) => value.as_bool() == Some(b),
        D::Null => value.is_null(),
        D::EmptyObject => value.as_object().is_some_and(Map::is_empty),
        D::EmptyArray => value.as_array().is_some_and(Vec::is_empty),
        D::SystemLocale => value
            .as_str()
            .and_then(dr_i18n::Locale::match_tag)
            .is_some_and(|l| l.code() == system_locale),
        D::LinkColors => {
            let defaults = [
                ("element", "#8b72c6"),
                ("chapter", "#5b93c7"),
                ("drift", "#9b6baa"),
                ("patch", "#c28b43"),
                ("category", "#5f9b73"),
                ("storyline", "#4f9497"),
            ];
            value.as_object().is_some_and(|o| {
                o.len() == defaults.len()
                    && defaults.iter().all(|(k, c)| {
                        o.get(*k)
                            .and_then(Value::as_str)
                            .is_some_and(|v| v.eq_ignore_ascii_case(c))
                    })
            })
        }
    }
}

/// `value` of 0.1 field `field` as this client's value for its key, checked
/// (a number clamped) the way the registry checks a stored value, and
/// whether it was clamped. `version`: the 0.1 store's, when known.
pub fn convert(field: &Field, value: &Value, version: Option<i64>) -> Option<(Value, bool)> {
    let def: &SettingDef = registry::find(field.key)?;
    let mut value = value.clone();
    // 0.1's store version 35 renamed the sizes without resizing anything.
    if field.field == "interfaceTextSize"
        && version.is_some_and(|v| v < 35)
        && let Some(old) = value.as_str()
    {
        value = Value::from(match old {
            "small" => "smallest",
            "standard" => "small",
            "large" => "standard",
            other => other,
        });
    }
    let checked = def.validate(&value)?;
    let clamped = match (value.as_f64(), checked.as_f64()) {
        (Some(before), Some(after)) => before != after,
        _ => false,
    };
    Some((checked, clamped))
}

/// The 0.1 accelerator (`Mod+Shift+F`, `lib/shortcuts.ts`) in this client's
/// stored form (`shift-secondary-f`, [`keymap::portable`]'s order), or
/// `None` when it is no chord this client's recorder would take.
pub fn chord(accelerator: &str, os: OperatingSystem) -> Option<String> {
    let (mut primary, mut ctrl, mut alt, mut shift) = (false, false, false, false);
    let mut key: Option<&str> = None;
    for part in accelerator
        .split('+')
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        match part.to_ascii_lowercase().as_str() {
            "mod" | "cmd" | "meta" => primary = true,
            "ctrl" | "control" => ctrl = true,
            "shift" => shift = true,
            "alt" | "option" => alt = true,
            _ if key.is_none() => key = Some(part),
            _ => return None,
        }
    }
    let key = key?;
    // Off the Mac, 0.1 read Ctrl and Mod as one key (`matchesAccelerator`).
    if os != OperatingSystem::Mac && ctrl {
        primary = true;
        ctrl = false;
    }
    let named = match key {
        "ArrowLeft" => Some("left"),
        "ArrowRight" => Some("right"),
        "ArrowUp" => Some("up"),
        "ArrowDown" => Some("down"),
        "Enter" => Some("enter"),
        "Tab" => Some("tab"),
        "Backspace" => Some("backspace"),
        "Escape" => Some("escape"),
        "Delete" => Some("delete"),
        "Home" => Some("home"),
        "End" => Some("end"),
        "PageUp" => Some("pageup"),
        "PageDown" => Some("pagedown"),
        // 0.1 read Shift+[ and Shift+] as those keys (`matchesAccelerator`).
        "{" if shift => Some("["),
        "}" if shift => Some("]"),
        _ => None,
    };
    let function_key = key.len() > 1
        && key.starts_with(['F', 'f'])
        && key[1..].parse::<u8>().is_ok_and(|n| (1..=24).contains(&n));
    let key = match named {
        Some(k) => k.to_owned(),
        None if function_key => key.to_ascii_lowercase(),
        None => {
            let mut chars = key.chars();
            let (Some(c), None) = (chars.next(), chars.next()) else {
                return None;
            };
            if !(c.is_ascii_alphanumeric() || "[]\\;',./`-=".contains(c)) {
                return None;
            }
            c.to_ascii_lowercase().to_string()
        }
    };
    // This client's recorder: ⌘/Ctrl, or ⌥, or a function key.
    if !primary && !alt && !function_key {
        return None;
    }
    let mut out = String::new();
    if os == OperatingSystem::Mac && ctrl {
        out.push_str("ctrl-");
    }
    if alt {
        out.push_str("alt-");
    }
    if shift {
        out.push_str("shift-");
    }
    if primary {
        out.push_str("secondary-");
    }
    out.push_str(&key);
    Keystroke::parse_with_os(&out, os).ok()?;
    Some(out)
}

fn same_chord(a: &str, b: &str, os: OperatingSystem) -> bool {
    match (
        Keystroke::parse_with_os(a, os),
        Keystroke::parse_with_os(b, os),
    ) {
        (Ok(a), Ok(b)) => a.modifiers == b.modifiers && a.key == b.key,
        _ => false,
    }
}

/// 0.1's bindings (id → accelerator) as rebindings here, on top of `base`
/// (the rebindings already here): the rows, and the rebindings to add.
/// `kept`: an id the author set here already. A chord another command
/// here has (with every other rebinding in force) leaves that one at its
/// default.
pub fn shortcuts(
    bindings: &Map<String, Value>,
    base: &Map<String, Value>,
    kept: &dyn Fn(&str) -> bool,
    os: OperatingSystem,
) -> (Vec<Carried>, Map<String, Value>) {
    let row = |id: &str, new_key: Option<&str>, outcome, old: &Value, new: Option<&str>| Carried {
        kind: "shortcut",
        old_key: id.to_owned(),
        new_key: new_key.map(str::to_owned),
        outcome,
        old_value: Some(old.clone()),
        new_value: new.map(Value::from),
        detail: None,
    };
    let mut rows = Vec::new();
    let mut candidates: BTreeMap<String, (String, Value)> = BTreeMap::new();
    for (id, value) in bindings {
        let Some(accelerator) = value.as_str() else {
            rows.push(row(id, None, Outcome::Invalid, value, None));
            continue;
        };
        let known = SHORTCUTS.iter().find(|(old, ..)| old == id);
        let converted = chord(accelerator, os);
        if let Some((_, default, _)) = known {
            let default_chord = chord(default, os);
            let unchanged = match (&converted, &default_chord) {
                (Some(a), Some(b)) => same_chord(a, b, os),
                _ => accelerator == *default,
            };
            if unchanged {
                rows.push(row(id, None, Outcome::Default, value, None));
                continue;
            }
        }
        let target = match known {
            Some((_, _, Ok(new_id))) => *new_id,
            Some((_, _, Err(why))) => {
                let mut r = row(id, None, Outcome::NoEquivalent, value, None);
                r.detail = Some((*why).to_owned());
                rows.push(r);
                continue;
            }
            None => {
                let mut r = row(id, None, Outcome::NoEquivalent, value, None);
                r.detail = Some("an unknown 0.1 command".into());
                rows.push(r);
                continue;
            }
        };
        let Some(shortcut) = keymap::find(target).filter(|s| s.listed.is_some()) else {
            let mut r = row(id, None, Outcome::NoEquivalent, value, None);
            r.detail = Some("no such command here".into());
            rows.push(r);
            continue;
        };
        if kept(target) {
            rows.push(row(id, Some(target), Outcome::KeptHere, value, None));
            continue;
        }
        let Some(converted) = converted else {
            let mut r = row(id, Some(target), Outcome::Invalid, value, None);
            r.detail = Some("a chord this client does not take".into());
            rows.push(r);
            continue;
        };
        if shortcut.keys.iter().any(|k| same_chord(k, &converted, os)) {
            rows.push(row(id, Some(target), Outcome::Default, value, None));
            continue;
        }
        candidates.insert(target.to_owned(), (converted, value.clone()));
    }
    // Take a chord only where no other command here has it, every other
    // candidate in force (so two swapped 0.1 bindings stay swapped).
    loop {
        let mut overrides = base.clone();
        for (id, (keys, _)) in &candidates {
            overrides.insert(id.clone(), Value::from(keys.as_str()));
        }
        let clashing: Vec<(String, &'static str)> = candidates
            .iter()
            .filter_map(|(id, (keys, _))| {
                keymap::conflict(id, keys, os, &overrides).map(|other| (id.clone(), other.id))
            })
            .collect();
        if clashing.is_empty() {
            break;
        }
        for (id, other) in clashing {
            let (keys, old) = candidates.remove(&id).expect("a candidate");
            let mut r = row(&id, Some(&id), Outcome::Conflict, &old, None);
            r.detail = Some(format!("{keys} is {other}'s here"));
            rows.push(r);
        }
    }
    let mut add = Map::new();
    for (id, (keys, old)) in candidates {
        rows.push(row(&id, Some(&id), Outcome::Adopted, &old, Some(&keys)));
        add.insert(id, Value::from(keys));
    }
    rows.sort_by(|a, b| a.old_key.cmp(&b.old_key));
    (rows, add)
}

/// Takes the captured 0.1 settings and shortcuts (the raw WebView storage
/// values of the hand-over, by key) into `file`, into keys the author has
/// not set here (nor this client's preference sync changed). Returns a row
/// for every 0.1 field and shortcut, adopted or not.
pub fn adopt(
    file: &mut SettingsFile,
    entries: &BTreeMap<String, String>,
    here: &Here<'_>,
) -> Vec<Carried> {
    let mut rows = Vec::new();
    let settings = persisted(entries.get(SETTINGS_STORE));
    let checkin = persisted(entries.get(CHECKIN_STORE));
    for f in FIELDS {
        let store = match f.store {
            SETTINGS_STORE => &settings,
            _ => &checkin,
        };
        let Some((state, version)) = store else {
            continue;
        };
        let Some(old) = state.get(f.field) else {
            continue;
        };
        let def = registry::find(f.key).expect("a registry key");
        let mut row = Carried {
            kind: "setting",
            old_key: format!("{}.{}", f.store, f.field),
            new_key: Some(f.key.to_owned()),
            outcome: Outcome::Default,
            old_value: Some(old.clone()),
            new_value: None,
            detail: None,
        };
        if is_default(old, f.default, here.system_locale) {
            rows.push(row);
            continue;
        }
        let Some((value, clamped)) = convert(f, old, *version) else {
            row.outcome = Outcome::Invalid;
            rows.push(row);
            continue;
        };
        if file.stored(def, None).is_some() || (here.stamped)(f.key) {
            row.outcome = Outcome::KeptHere;
            row.new_value = file.stored(def, None);
            rows.push(row);
            continue;
        }
        if file.set(f.key, value.clone(), None).is_err() {
            row.outcome = Outcome::Invalid;
            rows.push(row);
            continue;
        }
        row.outcome = if clamped {
            Outcome::Clamped
        } else {
            Outcome::Adopted
        };
        row.new_value = Some(value);
        rows.push(row);
    }
    if let Some((state, _)) = &settings {
        let mapped = |name: &str| {
            FIELDS
                .iter()
                .any(|f| f.store == SETTINGS_STORE && f.field == name)
        };
        for (name, old) in state {
            if mapped(name) {
                continue;
            }
            let known = NO_EQUIVALENT.iter().find(|n| n.field == name);
            let outcome = match known {
                Some(n) if is_default(old, n.default, here.system_locale) => Outcome::Default,
                _ => Outcome::NoEquivalent,
            };
            rows.push(Carried {
                kind: "setting",
                old_key: format!("{SETTINGS_STORE}.{name}"),
                new_key: None,
                outcome,
                old_value: Some(old.clone()),
                new_value: None,
                detail: Some(
                    known
                        .map(|n| n.why)
                        .unwrap_or("an unknown 0.1 field")
                        .to_owned(),
                ),
            });
        }
    }
    if let Some((state, _)) = persisted(entries.get(SHORTCUTS_STORE))
        && let Some(bindings) = state.get("bindings").and_then(Value::as_object)
    {
        let base = file.key_bindings();
        let all_kept = (here.stamped)(KEY_BINDINGS);
        let kept = |id: &str| all_kept || base.contains_key(id);
        let (shortcut_rows, add) = shortcuts(bindings, &base, &kept, here.os);
        for (id, keys) in add {
            file.set_key_binding(&id, keys.as_str());
        }
        rows.extend(shortcut_rows);
    }
    rows
}

/// The 0.1 key a synced key of this client was synced under by 0.1, if any.
pub fn synced_source(key: &str) -> Option<&'static str> {
    if key == KEY_BINDINGS {
        return Some(SYNCED_SHORTCUTS);
    }
    FIELDS
        .iter()
        .find(|f| f.synced && f.key == key)
        .map(|f| f.field)
}

/// A value 0.1 synced under `old_key`, as this client's value for the key
/// [`synced_source`] names: checked (and clamped) like a stored value; for
/// the shortcuts, the 0.1 rebindings this client takes (none: `None`).
pub fn convert_synced(old_key: &str, value: &Value, os: OperatingSystem) -> Option<Value> {
    if old_key == SYNCED_SHORTCUTS {
        let (_, add) = shortcuts(value.as_object()?, &Map::new(), &|_| false, os);
        return (!add.is_empty()).then_some(Value::Object(add));
    }
    let f = FIELDS.iter().find(|f| f.synced && f.field == old_key)?;
    convert(f, value, None).map(|(value, _)| value)
}

/// The operating system this build runs on, for code without an `App`.
pub fn this_os() -> OperatingSystem {
    if cfg!(target_os = "macos") {
        OperatingSystem::Mac
    } else if cfg!(target_os = "windows") {
        OperatingSystem::Windows
    } else {
        OperatingSystem::Linux
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::registry::*;
    use serde_json::json;

    const MAC: OperatingSystem = OperatingSystem::Mac;

    fn entries(
        settings: Value,
        shortcuts: Option<Value>,
        checkin: Option<Value>,
    ) -> BTreeMap<String, String> {
        let mut out = BTreeMap::from([(
            SETTINGS_STORE.to_owned(),
            json!({"state": settings, "version": 37}).to_string(),
        )]);
        if let Some(s) = shortcuts {
            out.insert(
                SHORTCUTS_STORE.into(),
                json!({"state": {"bindings": s}, "version": 0}).to_string(),
            );
        }
        if let Some(c) = checkin {
            out.insert(
                CHECKIN_STORE.into(),
                json!({"state": c, "version": 2}).to_string(),
            );
        }
        out
    }

    fn here(stamped: &dyn Fn(&str) -> bool) -> Here<'_> {
        Here {
            os: MAC,
            system_locale: "en",
            stamped,
        }
    }

    fn outcome(rows: &[Carried], old: &str) -> Outcome {
        rows.iter()
            .find(|r| r.old_key == old)
            .unwrap_or_else(|| panic!("no row for {old}"))
            .outcome
    }

    /// The 0.1 defaults: 0.1 persisted them too, and none is a choice.
    fn defaults() -> Value {
        json!({
            "themeMode": "light", "interfaceTextSize": "standard", "uiLocale": "en",
            "bodyFontSize": 17, "lineHeight": 1.5, "paragraphSpacing": 1, "maxLineWidth": 720,
            "paragraphIndent": "none", "autoImmersiveWriting": false, "typewriterMode": false,
            "typewriterPosition": 50, "autoElementLinkEnabled": true, "agentTurnIterationLimit": 50,
            "sendCrashLogs": true, "accentColor": null, "caretColor": "#6b7fa6",
            "agentProvider": "deepseek", "agentModel": "deepseek-flash", "guidesSeen": [],
            "lastAgentConvByProject": {},
            "entityLinkKindColors": {"element":"#8b72c6","chapter":"#5b93c7","drift":"#9b6baa",
                "patch":"#c28b43","category":"#5f9b73","storyline":"#4f9497"}
        })
    }

    #[test]
    fn every_field_of_the_01_state_is_mapped_or_has_a_reason() {
        // `SettingsState`'s persisted fields (settings-store.ts).
        let state = [
            "autoElementLinkEnabled",
            "recentEntitiesLimit",
            "editorUndoDepth",
            "themeMode",
            "interfaceTextSize",
            "accentColor",
            "agentEditRevealAnimation",
            "editorFontSource",
            "editorSystemFontFamily",
            "bodyFontSize",
            "lineHeight",
            "paragraphIndent",
            "editorIndentStep",
            "paragraphSpacing",
            "maxLineWidth",
            "editorTextWrap",
            "autoImmersiveWriting",
            "typewriterMode",
            "typewriterPosition",
            "caretColor",
            "outlineRailMode",
            "entityLinkInteractive",
            "commentMarksVisible",
            "entityLinkColorMode",
            "entityLinkHighlightMode",
            "entityLinkBandStyle",
            "entityLinkKindColors",
            "uiLocale",
            "agentAuth",
            "agentProvider",
            "agentModel",
            "agentEffort",
            "agentThinking",
            "agentToolSearch",
            "agentTurnIterationLimit",
            "lastAgentConvByProject",
            "agentOnboardingStep",
            "guidesSeen",
            "autoSnapshot",
            "sendCrashLogs",
        ];
        for name in state {
            let mapped = FIELDS
                .iter()
                .filter(|f| f.store == SETTINGS_STORE && f.field == name)
                .count();
            let unmapped = NO_EQUIVALENT.iter().filter(|n| n.field == name).count();
            assert_eq!(mapped + unmapped, 1, "{name}");
        }
        assert_eq!(FIELDS.len() + NO_EQUIVALENT.len(), state.len() + 1);
        for f in FIELDS {
            assert!(find(f.key).is_some(), "{}", f.key);
        }
        // The synced ones are exactly 0.1's synced settings that have a key here.
        let synced: Vec<&str> = FIELDS
            .iter()
            .filter(|f| f.synced)
            .map(|f| f.field)
            .collect();
        assert_eq!(synced.len(), 22);
        for f in FIELDS.iter().filter(|f| f.synced) {
            assert_eq!(synced_source(f.key), Some(f.field));
            assert_eq!(find(f.key).unwrap().scope, Scope::Account);
        }
        for f in FIELDS.iter().filter(|f| !f.synced) {
            assert_eq!(synced_source(f.key), None);
            assert_eq!(find(f.key).unwrap().scope, Scope::Device, "{}", f.key);
        }
        for (_, _, target) in SHORTCUTS {
            if let Ok(id) = target {
                assert!(keymap::find(id).is_some_and(|s| s.listed.is_some()), "{id}");
            }
        }
    }

    #[test]
    fn each_mapped_setting_is_adopted_with_its_value() {
        let mut file = SettingsFile::in_memory();
        let custom_colors = json!({
            "element": "#112233",
            "chapter": "#223344",
            "drift": "#334455",
            "patch": "#445566",
            "category": "#556677",
            "storyline": "#667788"
        });
        let raw = entries(
            json!({
                "themeMode": "dark", "accentColor": "#aa5500",
                "agentEditRevealAnimation": false, "interfaceTextSize": "large", "uiLocale": "ja",
                "editorFontSource": "system", "editorSystemFontFamily": "Georgia",
                "bodyFontSize": 20, "lineHeight": 1.8, "editorTextWrap": "pretty",
                "paragraphSpacing": 0.5, "maxLineWidth": 900, "paragraphIndent": "two",
                "editorIndentStep": 4, "autoImmersiveWriting": true,
                "typewriterMode": true, "typewriterPosition": 40, "caretColor": "#ff5500",
                "autoElementLinkEnabled": false, "entityLinkInteractive": false,
                "commentMarksVisible": false, "entityLinkColorMode": "kind",
                "entityLinkHighlightMode": "text", "entityLinkBandStyle": "dots",
                "entityLinkKindColors": custom_colors,
                "agentTurnIterationLimit": null, "sendCrashLogs": false
            }),
            None,
            Some(json!({"enabled": false, "projects": {}})),
        );
        let rows = adopt(&mut file, &raw, &here(&|_| false));
        for (key, value) in [
            (THEME, json!("dark")),
            (ACCENT_COLOR, json!("#aa5500")),
            (AGENT_EDIT_REVEAL_ANIMATION, json!(false)),
            (TEXT_SIZE, json!("large")),
            (UI_LOCALE, json!("ja")),
            (FONT_SOURCE, json!("system")),
            (FONT_FAMILY, json!("Georgia")),
            (FONT_SIZE, json!(20.0)),
            (LINE_HEIGHT, json!(1.8)),
            (TEXT_WRAP, json!("pretty")),
            (PARAGRAPH_SPACING, json!(0.5)),
            (PAGE_WIDTH, json!(900.0)),
            (PARAGRAPH_INDENT, json!("two")),
            (TAB_INDENT_WIDTH, json!(4.0)),
            (AUTO_IMMERSIVE, json!(true)),
            (TYPEWRITER, json!(true)),
            (TYPEWRITER_POSITION, json!(40.0)),
            (CARET_COLOR, json!("#ff5500")),
            (AUTO_ENTITY_LINKS, json!(false)),
            (ENTITY_LINK_INTERACTIVE, json!(false)),
            (COMMENT_MARKS_VISIBLE, json!(false)),
            (ENTITY_LINK_COLOR_MODE, json!("kind")),
            (ENTITY_LINK_HIGHLIGHT_MODE, json!("text")),
            (ENTITY_LINK_BAND_STYLE, json!("dots")),
            (ENTITY_LINK_KIND_COLORS, custom_colors),
            (AGENT_MAX_MODEL_ROUNDS, Value::Null),
            (CRASH_REPORTS, json!(false)),
            (AGENT_PROACTIVE, json!(false)),
        ] {
            assert_eq!(file.get(key), value, "{key}");
            assert!(file.stored(find(key).unwrap(), None).is_some(), "{key}");
        }
        assert_eq!(
            rows.iter()
                .filter(|r| r.outcome == Outcome::Adopted)
                .count(),
            FIELDS.len()
        );
    }

    #[test]
    fn defaults_set_values_stamps_and_bad_values_are_not_adopted() {
        let mut file = SettingsFile::in_memory();
        file.set(FONT_SIZE, json!(22), None).unwrap();
        let mut state = defaults();
        state["themeMode"] = json!("sepia");
        state["bodyFontSize"] = json!(19);
        state["lineHeight"] = json!(1.9);
        state["paragraphSpacing"] = json!(3);
        state["caretColor"] = json!("#ff0000");
        state["agentProvider"] = json!("anthropic");
        let stamped = |key: &str| key == LINE_HEIGHT;
        let rows = adopt(&mut file, &entries(state, None, None), &here(&stamped));
        let s = |f: &str| format!("{SETTINGS_STORE}.{f}");
        assert_eq!(outcome(&rows, &s("themeMode")), Outcome::Invalid);
        assert_eq!(file.get(THEME), json!("system"), "this client's default");
        assert_eq!(outcome(&rows, &s("bodyFontSize")), Outcome::KeptHere);
        assert_eq!(file.number(FONT_SIZE), 22.0);
        assert_eq!(outcome(&rows, &s("lineHeight")), Outcome::KeptHere);
        assert!(file.stored(find(LINE_HEIGHT).unwrap(), None).is_none());
        // Out of this client's range: clamped as the registry clamps.
        assert_eq!(outcome(&rows, &s("paragraphSpacing")), Outcome::Clamped);
        assert_eq!(file.number(PARAGRAPH_SPACING), 2.5);
        let spacing = rows
            .iter()
            .find(|r| r.old_key == s("paragraphSpacing"))
            .unwrap();
        assert_eq!(spacing.old_value, Some(json!(3)));
        assert_eq!(spacing.new_value, Some(json!(2.5)));
        // 0.1's defaults are not choices: nothing stored for them.
        for f in [
            "interfaceTextSize",
            "uiLocale",
            "maxLineWidth",
            "typewriterPosition",
            "sendCrashLogs",
        ] {
            assert_eq!(outcome(&rows, &s(f)), Outcome::Default, "{f}");
        }
        for key in [
            TEXT_SIZE,
            UI_LOCALE,
            PAGE_WIDTH,
            TYPEWRITER_POSITION,
            CRASH_REPORTS,
        ] {
            assert!(file.stored(find(key).unwrap(), None).is_none(), "{key}");
        }
        // Restored caretColor adopts non-default hex; agentProvider still has no equivalent.
        assert_eq!(outcome(&rows, &s("caretColor")), Outcome::Adopted);
        assert_eq!(file.get(CARET_COLOR), json!("#ff0000"));
        assert_eq!(outcome(&rows, &s("agentProvider")), Outcome::NoEquivalent);
        assert_eq!(outcome(&rows, &s("accentColor")), Outcome::Default);
        assert_eq!(outcome(&rows, &s("entityLinkKindColors")), Outcome::Default);
        assert_eq!(file.get(AGENT_PROVIDER), json!("deepseek"));
    }

    #[test]
    fn the_sizes_renamed_at_version_35_are_read_by_their_version() {
        let f = FIELDS
            .iter()
            .find(|f| f.field == "interfaceTextSize")
            .unwrap();
        assert_eq!(
            convert(f, &json!("standard"), Some(34)),
            Some((json!("small"), false))
        );
        assert_eq!(
            convert(f, &json!("standard"), Some(37)),
            Some((json!("standard"), false))
        );
        let rounds = FIELDS
            .iter()
            .find(|f| f.field == "agentTurnIterationLimit")
            .unwrap();
        assert_eq!(
            convert(rounds, &json!(200), None),
            Some((json!(200), false))
        );
        assert_eq!(
            convert(rounds, &Value::Null, None),
            Some((Value::Null, false))
        );
        assert_eq!(convert(rounds, &json!(0), None), None);
    }

    #[test]
    fn accelerators_read_as_this_clients_chords() {
        assert_eq!(
            chord("Mod+Shift+F", MAC).as_deref(),
            Some("shift-secondary-f")
        );
        assert_eq!(
            chord("Mod+Alt+ArrowLeft", MAC).as_deref(),
            Some("alt-secondary-left")
        );
        assert_eq!(
            chord("Mod+Shift+{", MAC).as_deref(),
            Some("shift-secondary-[")
        );
        assert_eq!(
            chord("Mod+Ctrl+K", MAC).as_deref(),
            Some("ctrl-secondary-k")
        );
        assert_eq!(
            chord("Ctrl+K", OperatingSystem::Windows).as_deref(),
            Some("secondary-k"),
            "off the Mac, 0.1's Ctrl was the primary key"
        );
        assert_eq!(chord("F5", MAC).as_deref(), Some("f5"));
        assert_eq!(chord("K", MAC), None, "a bare key types text");
        assert_eq!(chord("Shift+K", MAC), None);
        assert_eq!(
            chord("Mod+!", MAC),
            None,
            "a shifted character, layout-bound"
        );
        assert_eq!(chord("Mod+K+L", MAC), None);
    }

    #[test]
    fn shortcuts_are_adopted_unless_they_clash_or_have_no_command() {
        let bindings = json!({
            "closeActiveTab": "Mod+W",            // 0.1's default
            "goBack": "Mod+]", "goForward": "Mod+[", // swapped: both stay swapped
            "globalSearch": "Mod+B",              // ⌘B is the editor's: own context
            "findInEditor": "Mod+,",              // ⌘, opens the settings here
            "toggleBottomTimeline": "Mod+Shift+J",
            "newEntity": "Mod+Alt+N",              // set here already
            "saveCurrentEditor": "Mod+Shift+S",   // no command here
            "closeProject": "Mod+Shift+W",        // 0.1's default of a retired one
            "somethingNew": "Mod+Y",
            "prevTab": "Mod+!"
        });
        let mut file = SettingsFile::in_memory();
        file.set_key_binding("newEntity", Some("secondary-alt-m"));
        let mut state = defaults();
        state["themeMode"] = json!("light");
        let rows = adopt(
            &mut file,
            &entries(state, Some(bindings), None),
            &here(&|_| false),
        );
        let b = file.key_bindings();
        assert_eq!(b["goBack"], "secondary-]");
        assert_eq!(b["goForward"], "secondary-[");
        assert_eq!(b["globalSearch"], "secondary-b");
        assert_eq!(b["toggleBottomTimeline"], "shift-secondary-j");
        assert_eq!(b["newEntity"], "secondary-alt-m", "set here: kept");
        assert!(!b.contains_key("findInEditor"));
        assert!(!b.contains_key("closeActiveTab"));
        assert_eq!(outcome(&rows, "closeActiveTab"), Outcome::Default);
        assert_eq!(outcome(&rows, "closeProject"), Outcome::Default);
        assert_eq!(outcome(&rows, "goBack"), Outcome::Adopted);
        assert_eq!(outcome(&rows, "findInEditor"), Outcome::Conflict);
        let conflict = rows.iter().find(|r| r.old_key == "findInEditor").unwrap();
        assert!(
            conflict
                .detail
                .as_deref()
                .unwrap()
                .contains("app::OpenSettings")
        );
        assert_eq!(outcome(&rows, "newEntity"), Outcome::KeptHere);
        assert_eq!(outcome(&rows, "saveCurrentEditor"), Outcome::NoEquivalent);
        assert_eq!(outcome(&rows, "somethingNew"), Outcome::NoEquivalent);
        assert_eq!(outcome(&rows, "prevTab"), Outcome::Invalid);
        // Every rebinding taken binds.
        for (action, keys, _) in keymap::bindings(MAC, &file.key_bindings()) {
            assert!(
                Keystroke::parse_with_os(&keys, MAC).is_ok(),
                "{action} {keys}"
            );
        }
    }

    #[test]
    fn a_stamped_binding_set_keeps_every_shortcut() {
        let mut file = SettingsFile::in_memory();
        let stamped = |key: &str| key == KEY_BINDINGS;
        let rows = adopt(
            &mut file,
            &entries(defaults(), Some(json!({"goBack": "Mod+Alt+B"})), None),
            &here(&stamped),
        );
        assert_eq!(outcome(&rows, "goBack"), Outcome::KeptHere);
        assert!(file.key_bindings().is_empty());
    }

    #[test]
    fn synced_01_values_convert_to_this_clients_keys() {
        assert_eq!(synced_source(THEME), Some("themeMode"));
        assert_eq!(synced_source(KEY_BINDINGS), Some(SYNCED_SHORTCUTS));
        assert_eq!(synced_source(TEXT_SIZE), None, "device only on both sides");
        assert_eq!(synced_source(AGENT_PROVIDER), None);
        assert_eq!(
            convert_synced("paragraphSpacing", &json!(2.8), MAC),
            Some(json!(2.5))
        );
        assert_eq!(convert_synced("themeMode", &json!("sepia"), MAC), None);
        assert_eq!(
            convert_synced("agentTurnIterationLimit", &Value::Null, MAC),
            Some(Value::Null)
        );
        let all_default = json!({"goBack": "Mod+[", "saveCurrentEditor": "Mod+S"});
        assert_eq!(convert_synced(SYNCED_SHORTCUTS, &all_default, MAC), None);
        assert_eq!(
            convert_synced(
                SYNCED_SHORTCUTS,
                &json!({"goBack": "Mod+Alt+B", "goForward": "Mod+]"}),
                MAC
            ),
            Some(json!({"goBack": "alt-secondary-b"}))
        );
    }
}
