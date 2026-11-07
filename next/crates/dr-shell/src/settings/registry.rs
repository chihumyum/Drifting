//! The settings registry: every setting once, declared.
//!
//! The 0.1 client kept settings in four kinds of storage and searched them
//! by scraping DOM text (simplifications.md, 「设置散在四类存储」). Here each
//! setting is one [`SettingDef`]: its key, type, default, scope, section,
//! strings and search terms. The settings panel, the search, the store's
//! validation (and later preference sync and the 0.1 import mapping) are
//! all read from [`REGISTRY`].
//!
//! Dead settings of the 0.1 client are not carried over: ⌘S, the options of
//! retired features, the mobile-only rails.

use dr_i18n::{Key, keys};
use serde_json::Value;

/// Where a value lives.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Scope {
    /// This device only (interface text size, crash reports).
    Device,
    /// The author's preferences, which follow the account once preference
    /// sync (M37) reads them; stored locally until then.
    Account,
    /// One book's local preference.
    Book,
}

/// The settings panel's sections, in rail order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Section {
    Appearance,
    Editor,
    Language,
    Keys,
    Privacy,
    Updates,
}

impl Section {
    pub const ALL: [Section; 6] = [
        Section::Appearance,
        Section::Editor,
        Section::Language,
        Section::Keys,
        Section::Privacy,
        Section::Updates,
    ];

    pub fn label(self) -> Key {
        match self {
            Section::Appearance => keys::settings::rail::APPEARANCE,
            Section::Editor => keys::settings::rail::EDITOR,
            Section::Language => keys::settings::rail::LANGUAGE,
            Section::Keys => keys::settings::rail::KEYS,
            Section::Privacy => keys::settings::rail::PRIVACY,
            Section::Updates => keys::settings::rail::UPDATES,
        }
    }

    /// The rail group a section sits under (`settings.groups.*`).
    pub fn group(self) -> Key {
        match self {
            Section::Appearance | Section::Editor | Section::Language | Section::Keys => {
                keys::settings::groups::PREFERENCES
            }
            Section::Privacy | Section::Updates => keys::settings::groups::CONTROL,
        }
    }

    pub fn slug(self) -> &'static str {
        match self {
            Section::Appearance => "appearance",
            Section::Editor => "editor",
            Section::Language => "language",
            Section::Keys => "keys",
            Section::Privacy => "privacy",
            Section::Updates => "updates",
        }
    }
}

/// One option of a choice.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Opt {
    pub value: &'static str,
    pub label: Key,
}

/// The type of a value and the control that edits it (f5-ui.md,
/// 「给设置注册表用的控件约定」).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    /// `Switch`.
    Switch,
    /// `Segmented` with up to 4 options, `Select` beyond.
    Choice(&'static [Opt]),
    /// One of the nine interface languages (`Select`, native names).
    Locale,
    /// A bounded number. dr-ui has no `GlassSlider` yet; the panel steps it.
    Number {
        min: f64,
        max: f64,
        step: f64,
        unit: &'static str,
    },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Initial {
    Bool(bool),
    Str(&'static str),
    Num(f64),
    /// Decided at run time (the interface language follows the system).
    Computed,
}

#[derive(Clone, Copy, Debug)]
pub struct SettingDef {
    /// Stable storage key, `section.name`.
    pub key: &'static str,
    pub kind: Kind,
    pub default: Initial,
    pub scope: Scope,
    pub section: Section,
    /// The heading inside the section it sits under, if any.
    pub group: Option<Key>,
    pub label: Key,
    pub description: Option<Key>,
    /// More words that find it (English and Chinese), beyond its strings.
    pub search: &'static [&'static str],
}

impl SettingDef {
    /// `value` if it is valid for this setting, else `None`.
    pub fn validate(&self, value: &Value) -> Option<Value> {
        match (self.kind, value) {
            (Kind::Switch, Value::Bool(_)) => Some(value.clone()),
            (Kind::Choice(options), Value::String(s)) => {
                options.iter().any(|o| o.value == s).then(|| value.clone())
            }
            (Kind::Locale, Value::String(s)) => {
                dr_i18n::Locale::match_tag(s).map(|l| Value::from(l.code()))
            }
            (Kind::Number { min, max, .. }, Value::Number(n)) => {
                let n = n.as_f64()?;
                n.is_finite().then(|| Value::from(n.clamp(min, max)))
            }
            _ => None,
        }
    }

    /// The default as a value (`Null` for [`Initial::Computed`]).
    pub fn default_value(&self) -> Value {
        match self.default {
            Initial::Bool(b) => Value::Bool(b),
            Initial::Str(s) => Value::from(s),
            Initial::Num(n) => Value::from(n),
            Initial::Computed => Value::Null,
        }
    }
}

pub const THEME: &str = "appearance.theme";
pub const TEXT_SIZE: &str = "appearance.interface_text_size";
pub const UI_LOCALE: &str = "language.ui_locale";
pub const FONT_SIZE: &str = "editor.font_size";
pub const LINE_HEIGHT: &str = "editor.line_height";
pub const PARAGRAPH_SPACING: &str = "editor.paragraph_spacing";
pub const PAGE_WIDTH: &str = "editor.page_width";
pub const PARAGRAPH_INDENT: &str = "editor.paragraph_indent";
pub const AUTO_IMMERSIVE: &str = "editor.auto_immersive";
pub const TYPEWRITER: &str = "editor.typewriter_mode";
pub const CRASH_REPORTS: &str = "privacy.crash_reports";

const THEMES: &[Opt] = &[
    Opt {
        value: "system",
        label: keys::settings::appearance::SYSTEM,
    },
    Opt {
        value: "light",
        label: keys::settings::appearance::LIGHT,
    },
    Opt {
        value: "dark",
        label: keys::settings::appearance::DARK,
    },
];

const TEXT_SIZES: &[Opt] = &[
    Opt {
        value: "smallest",
        label: keys::settings::appearance::INTERFACE_TEXT_SMALLEST,
    },
    Opt {
        value: "small",
        label: keys::settings::appearance::INTERFACE_TEXT_SMALL,
    },
    Opt {
        value: "standard",
        label: keys::settings::appearance::INTERFACE_TEXT_STANDARD,
    },
    Opt {
        value: "large",
        label: keys::settings::appearance::INTERFACE_TEXT_LARGE,
    },
    Opt {
        value: "largest",
        label: keys::settings::appearance::INTERFACE_TEXT_LARGEST,
    },
];

const INDENTS: &[Opt] = &[
    Opt {
        value: "none",
        label: keys::settings::editor::INDENT_NONE,
    },
    Opt {
        value: "one",
        label: keys::settings::editor::INDENT_ONE,
    },
    Opt {
        value: "two",
        label: keys::settings::editor::INDENT_TWO,
    },
];

/// Every setting. Defaults are the 0.1 client's (`settings-store.ts`,
/// `EDITOR_STYLE_DEFAULTS`).
pub static REGISTRY: &[SettingDef] = &[
    SettingDef {
        key: THEME,
        kind: Kind::Choice(THEMES),
        default: Initial::Str("system"),
        scope: Scope::Account,
        section: Section::Appearance,
        group: None,
        label: keys::settings::appearance::THEME,
        description: Some(keys::settings::appearance::THEME_DESC),
        search: &["dark mode", "light", "theme", "深色", "浅色", "夜间"],
    },
    SettingDef {
        key: TEXT_SIZE,
        kind: Kind::Choice(TEXT_SIZES),
        default: Initial::Str("standard"),
        scope: Scope::Device,
        section: Section::Appearance,
        group: None,
        label: keys::settings::appearance::INTERFACE_TEXT_SIZE,
        description: Some(keys::settings::appearance::INTERFACE_TEXT_SIZE_DESC),
        search: &["font size", "zoom", "字号", "字体大小"],
    },
    SettingDef {
        key: UI_LOCALE,
        kind: Kind::Locale,
        default: Initial::Computed,
        scope: Scope::Account,
        section: Section::Language,
        group: None,
        label: keys::settings::language::UI_LOCALE,
        description: Some(keys::settings::language::UI_LOCALE_DESC),
        search: &["language", "locale", "语言", "語言"],
    },
    SettingDef {
        key: FONT_SIZE,
        kind: Kind::Number {
            min: 12.0,
            max: 28.0,
            step: 1.0,
            unit: "px",
        },
        default: Initial::Num(17.0),
        scope: Scope::Account,
        section: Section::Editor,
        group: Some(keys::settings::editor::TYPESETTING),
        label: keys::settings::editor::FONT_SIZE,
        description: Some(keys::settings::editor::FONT_SIZE_DESC),
        search: &["font size", "字号"],
    },
    SettingDef {
        key: LINE_HEIGHT,
        kind: Kind::Number {
            min: 1.0,
            max: 2.0,
            step: 0.02,
            unit: "",
        },
        default: Initial::Num(1.5),
        scope: Scope::Account,
        section: Section::Editor,
        group: Some(keys::settings::editor::TYPESETTING),
        label: keys::settings::editor::LINE_HEIGHT,
        description: None,
        search: &["line height", "leading", "行距"],
    },
    SettingDef {
        key: PARAGRAPH_SPACING,
        kind: Kind::Number {
            min: 0.0,
            max: 2.5,
            step: 0.05,
            unit: "em",
        },
        default: Initial::Num(1.0),
        scope: Scope::Account,
        section: Section::Editor,
        group: Some(keys::settings::editor::TYPESETTING),
        label: keys::settings::editor::PARAGRAPH_SPACING,
        description: Some(keys::settings::editor::PARAGRAPH_SPACING_DESC),
        search: &["paragraph spacing", "段距"],
    },
    SettingDef {
        key: PAGE_WIDTH,
        kind: Kind::Number {
            min: 480.0,
            max: 1280.0,
            step: 10.0,
            unit: "px",
        },
        default: Initial::Num(720.0),
        scope: Scope::Account,
        section: Section::Editor,
        group: Some(keys::settings::editor::TYPESETTING),
        label: keys::settings::editor::PAGE_WIDTH,
        description: Some(keys::settings::editor::PAGE_WIDTH_DESC),
        search: &["page width", "column", "稿纸", "版心"],
    },
    SettingDef {
        key: PARAGRAPH_INDENT,
        kind: Kind::Choice(INDENTS),
        default: Initial::Str("none"),
        scope: Scope::Account,
        section: Section::Editor,
        group: Some(keys::settings::editor::TYPESETTING),
        label: keys::settings::editor::INDENT,
        description: Some(keys::settings::editor::INDENT_DESC),
        search: &["indent", "首行缩进"],
    },
    SettingDef {
        key: AUTO_IMMERSIVE,
        kind: Kind::Switch,
        default: Initial::Bool(false),
        scope: Scope::Account,
        section: Section::Editor,
        group: Some(keys::settings::editor::FLOW),
        label: keys::settings::editor::AUTO_IMMERSIVE,
        description: Some(keys::settings::editor::AUTO_IMMERSIVE_DESC),
        search: &["immersive", "focus", "专注"],
    },
    SettingDef {
        key: TYPEWRITER,
        kind: Kind::Switch,
        default: Initial::Bool(false),
        scope: Scope::Account,
        section: Section::Editor,
        group: Some(keys::settings::editor::FLOW),
        label: keys::settings::editor::TYPEWRITER_MODE,
        description: Some(keys::settings::editor::TYPEWRITER_MODE_DESC),
        search: &["typewriter", "scroll"],
    },
    SettingDef {
        key: CRASH_REPORTS,
        kind: Kind::Switch,
        // The 0.1 client: on, and said so on first launch.
        default: Initial::Bool(true),
        scope: Scope::Device,
        section: Section::Privacy,
        group: Some(keys::settings::privacy::DATA_USAGE),
        label: keys::settings::privacy::CRASH_LOGS,
        description: Some(keys::settings::privacy::CRASH_LOGS_DESC),
        search: &["crash", "sentry", "diagnostics", "崩溃", "故障"],
    },
];

pub fn find(key: &str) -> Option<&'static SettingDef> {
    REGISTRY.iter().find(|d| d.key == key)
}

pub fn in_section(section: Section) -> impl Iterator<Item = &'static SettingDef> {
    REGISTRY.iter().filter(move |d| d.section == section)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_unique_and_defaults_valid() {
        for (i, def) in REGISTRY.iter().enumerate() {
            assert!(
                REGISTRY[..i].iter().all(|d| d.key != def.key),
                "{} twice",
                def.key
            );
            assert!(
                def.key.starts_with(def.section.slug()),
                "{} is under its section",
                def.key
            );
            if def.default != Initial::Computed {
                assert_eq!(
                    def.validate(&def.default_value()),
                    Some(def.default_value()),
                    "{}",
                    def.key
                );
            }
        }
    }

    #[test]
    fn values_are_checked_against_their_kind() {
        let theme = find(THEME).unwrap();
        assert!(theme.validate(&Value::from("sepia")).is_none());
        assert!(theme.validate(&Value::from(true)).is_none());
        let size = find(FONT_SIZE).unwrap();
        assert_eq!(size.validate(&Value::from(99)), Some(Value::from(28.0)));
        assert_eq!(size.validate(&Value::from(16.5)), Some(Value::from(16.5)));
        let locale = find(UI_LOCALE).unwrap();
        assert_eq!(
            locale.validate(&Value::from("zh-Hant-TW")),
            Some(Value::from("zh-TW"))
        );
        assert!(locale.validate(&Value::from("ru")).is_none());
    }
}
