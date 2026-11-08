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

/// The settings panel's sections, in rail order (M08's first batch).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Section {
    Appearance,
    Editor,
    Language,
    Keys,
    Models,
    Agent,
    /// 本地数据: what stays on this machine and what leaves it (the 0.1
    /// client's local-data page, with its privacy rows).
    LocalData,
    /// 关于 Drifting: version, credits and licences, contact.
    About,
}

impl Section {
    pub const ALL: [Section; 8] = [
        Section::Appearance,
        Section::Editor,
        Section::Language,
        Section::Keys,
        Section::Models,
        Section::Agent,
        Section::LocalData,
        Section::About,
    ];

    pub fn label(self) -> Key {
        match self {
            Section::Appearance => keys::settings::rail::APPEARANCE,
            Section::Editor => keys::settings::rail::EDITOR,
            Section::Language => keys::settings::rail::LANGUAGE,
            Section::Keys => keys::settings::rail::KEYS,
            Section::Models => keys::settings::rail::MODELS,
            Section::Agent => keys::settings::rail::AGENT,
            Section::LocalData => keys::settings::sync::LOCAL_DATA,
            Section::About => keys::settings::rail::ABOUT_APP,
        }
    }

    /// The rail group a section sits under (`settings.groups.*`).
    pub fn group(self) -> Key {
        match self {
            Section::Appearance | Section::Editor | Section::Language | Section::Keys => {
                keys::settings::groups::PREFERENCES
            }
            Section::LocalData => keys::settings::groups::CONTROL,
            Section::Models | Section::Agent => keys::settings::groups::INTELLIGENCE,
            Section::About => keys::settings::groups::ABOUT,
        }
    }

    pub fn slug(self) -> &'static str {
        match self {
            Section::Appearance => "appearance",
            Section::Editor => "editor",
            Section::Language => "language",
            Section::Keys => "keys",
            Section::Models => "models",
            Section::Agent => "agent",
            Section::LocalData => "local-data",
            Section::About => "about",
        }
    }
}

/// What a row that is not a stored setting does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RowAction {
    /// Opens a page in the browser (the button's words).
    Open { url: &'static str, button: Key },
    /// Copies the de-identified diagnostics summary.
    CopyDiagnostics,
    /// Shows the version, channel, engine and platform.
    Version,
    /// Opens the feedback dialog (F7's, [`crate::actions::SendFeedback`]).
    Feedback,
    /// 检查更新, and what the last check found (M42's, through
    /// [`super::set_updates_row`]); left out when no updater is installed.
    Updates,
    /// Backs the library up ([`crate::actions::BackupLibrary`]).
    Backup,
    /// Restores the library from a backup ([`crate::actions::RestoreLibrary`]);
    /// beside it, 「打开恢复前副本」 opens the folder the copies saved
    /// before each restore are kept in (as the 0.1 client did).
    Restore,
    /// The Markdown folder (M40, [`crate::mirror`]): 开启 while it is off,
    /// else 在访达中打开.
    MarkdownFolder,
    /// Where it is (all books): 选择文件夹 and the danger's 关闭 Markdown
    /// 文件夹. Only while it is on.
    MarkdownLocation,
    /// 重新显示 the workspace tour (M24); only when the app has one.
    ReplayGuides,
    /// A registered module owns the control; metadata remains in this registry.
    Module,
}

/// A row of the panel that is not a stored setting: a link, an action, a
/// read-only value. Searched like the settings (label and description).
#[derive(Clone, Copy, Debug)]
pub struct InfoRow {
    pub id: &'static str,
    pub section: Section,
    /// The heading it sits under.
    pub group: Option<Key>,
    pub label: Key,
    pub description: Option<Key>,
    pub action: RowAction,
}

/// The 0.1 client's links (ControlSettingsPanels.tsx, lib/config.ts).
pub const REPO_URL: &str = "https://github.com/chihumyum/Drifting";
pub const SUPPORT_URL: &str = "https://drifting.cc/support";
pub const SUPPORT_EMAIL: &str = "support@drifting.cc";

/// Every [`InfoRow`], in panel order.
pub static INFO_ROWS: &[InfoRow] = &[
    InfoRow {
        id: "models.chatgpt",
        section: Section::Models,
        group: None,
        label: keys::settings::codex_subscription::NAME,
        description: Some(keys::settings::models::providers::OPENAI_CODEX),
        action: RowAction::Module,
    },
    InfoRow {
        id: "models.deepseek",
        section: Section::Models,
        group: None,
        label: keys::settings::models::providers::DEEPSEEK,
        description: None,
        action: RowAction::Module,
    },
    InfoRow {
        id: "models.anthropic",
        section: Section::Models,
        group: None,
        label: keys::settings::models::providers::ANTHROPIC,
        description: None,
        action: RowAction::Module,
    },
    InfoRow {
        id: "models.openai",
        section: Section::Models,
        group: None,
        label: keys::settings::models::providers::OPENAI,
        description: None,
        action: RowAction::Module,
    },
    InfoRow {
        id: "agent.onboarding",
        section: Section::Agent,
        group: None,
        label: keys::settings::agent::REPLAY_ONBOARDING,
        description: Some(keys::settings::agent::CHAT_CONFIG_DESC),
        action: RowAction::Module,
    },
    // At the top of 本地数据, as in the 0.1 client (LibraryBackupSettings).
    InfoRow {
        id: "local.backup",
        section: Section::LocalData,
        group: None,
        label: keys::settings::sync::backup::EXPORT_TITLE,
        description: Some(keys::settings::sync::backup::EXPORT_DESC),
        action: RowAction::Backup,
    },
    InfoRow {
        id: "local.restore",
        section: Section::LocalData,
        group: None,
        label: keys::settings::sync::backup::RESTORE_TITLE,
        description: Some(keys::settings::sync::backup::RESTORE_DESC),
        action: RowAction::Restore,
    },
    // The Markdown folder (0.1's MarkdownProjectionSettings).
    InfoRow {
        id: "local.markdown",
        section: Section::LocalData,
        group: None,
        label: keys::settings::sync::projection::TITLE,
        description: Some(keys::settings::sync::projection::DESCRIPTION),
        action: RowAction::MarkdownFolder,
    },
    InfoRow {
        id: "local.markdown_location",
        section: Section::LocalData,
        group: None,
        label: keys::settings::sync::projection::ALL_PROJECTS,
        description: Some(keys::settings::sync::projection::LOCATION_HINT),
        action: RowAction::MarkdownLocation,
    },
    InfoRow {
        id: "local.diagnostics",
        section: Section::LocalData,
        group: Some(keys::settings::privacy::DATA_USAGE),
        label: keys::settings::privacy::DIAGNOSTICS,
        description: Some(keys::settings::privacy::DIAGNOSTICS_DESC),
        action: RowAction::CopyDiagnostics,
    },
    InfoRow {
        id: "appearance.replay_guides",
        section: Section::Appearance,
        group: Some(keys::settings::appearance::GUIDES),
        label: keys::settings::appearance::REPLAY_GUIDES,
        description: None,
        action: RowAction::ReplayGuides,
    },
    InfoRow {
        id: "about.version",
        section: Section::About,
        group: None,
        label: keys::settings::about::VERSION,
        description: None,
        action: RowAction::Version,
    },
    InfoRow {
        id: "about.update",
        section: Section::About,
        group: None,
        label: keys::settings::update::CHECK,
        description: None,
        action: RowAction::Updates,
    },
    InfoRow {
        id: "about.open_source",
        section: Section::About,
        group: Some(keys::settings::about::CREDITS),
        label: keys::settings::about::OPEN_SOURCE,
        description: None,
        action: RowAction::Open {
            url: "https://github.com/chihumyum/Drifting/blob/main/THIRD_PARTY_NOTICES.md",
            button: keys::settings::about::VIEW_LIST,
        },
    },
    InfoRow {
        id: "about.source_code",
        section: Section::About,
        group: Some(keys::settings::about::CREDITS),
        label: keys::settings::about::SOURCE_CODE,
        description: Some(keys::settings::about::SOURCE_CODE_DESC),
        action: RowAction::Open {
            url: REPO_URL,
            button: keys::settings::about::VIEW_SOURCE,
        },
    },
    InfoRow {
        id: "about.license",
        section: Section::About,
        group: Some(keys::settings::about::CREDITS),
        label: keys::settings::about::LICENSE,
        description: Some(keys::settings::about::LICENSE_DESC),
        action: RowAction::Open {
            url: "https://github.com/chihumyum/Drifting/blob/main/LICENSE",
            button: keys::settings::about::VIEW_LICENSE,
        },
    },
    InfoRow {
        id: "about.known_issues",
        section: Section::About,
        group: Some(keys::settings::about::CREDITS),
        label: keys::settings::about::KNOWN_ISSUES,
        description: Some(keys::settings::about::KNOWN_ISSUES_DESC),
        action: RowAction::Open {
            url: "https://github.com/chihumyum/Drifting/blob/main/KNOWN_ISSUES.md",
            button: keys::settings::common::OPEN_IN_BROWSER,
        },
    },
    InfoRow {
        id: "about.support",
        section: Section::About,
        group: Some(keys::settings::about::CONTACT),
        label: keys::settings::about::SUPPORT,
        description: Some(keys::settings::about::SUPPORT_DESC),
        action: RowAction::Open {
            url: SUPPORT_URL,
            button: keys::settings::common::OPEN_IN_BROWSER,
        },
    },
    InfoRow {
        id: "about.feedback",
        section: Section::About,
        group: Some(keys::settings::about::CONTACT),
        label: keys::settings::about::SUBMIT_FEEDBACK,
        description: Some(keys::settings::about::SUBMIT_FEEDBACK_DESC),
        action: RowAction::Feedback,
    },
    InfoRow {
        id: "about.email",
        section: Section::About,
        group: Some(keys::settings::about::CONTACT),
        label: keys::settings::about::EMAIL_TEAM,
        description: None,
        action: RowAction::Open {
            url: "mailto:support@drifting.cc",
            button: keys::settings::about::WRITE_EMAIL,
        },
    },
];

/// The info rows of `section`, in panel order.
pub fn info_in(section: Section) -> impl Iterator<Item = &'static InfoRow> {
    INFO_ROWS.iter().filter(move |r| r.section == section)
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
    /// The store validates this value; a module registers its richer control.
    Module(ModuleValue),
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
pub enum ModuleValue {
    Choice(&'static [&'static str]),
    Text { max_bytes: usize },
    OptionalPositiveU32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Initial {
    Bool(bool),
    Unsigned(u32),
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
            (Kind::Module(ModuleValue::Choice(options)), Value::String(value)) => options
                .contains(&value.as_str())
                .then(|| Value::String(value.clone())),
            (Kind::Module(ModuleValue::Text { max_bytes }), Value::String(value)) => {
                (!value.trim().is_empty() && value.len() <= max_bytes)
                    .then(|| Value::String(value.clone()))
            }
            (Kind::Module(ModuleValue::OptionalPositiveU32), Value::Null) => Some(Value::Null),
            (Kind::Module(ModuleValue::OptionalPositiveU32), Value::Number(number)) => number
                .as_u64()
                .filter(|value| (1..=u32::MAX as u64).contains(value))
                .map(Value::from),
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
            Initial::Unsigned(value) => Value::from(value),
            Initial::Bool(b) => Value::Bool(b),
            Initial::Str(s) => Value::from(s),
            Initial::Num(n) => Value::from(n),
            Initial::Computed => Value::Null,
        }
    }
}

pub const THEME: &str = "appearance.theme";
pub const AGENT_PROVIDER: &str = "agent.provider";
pub const AGENT_MODEL: &str = "agent.model";
pub const AGENT_THINKING: &str = "agent.thinking";
pub const AGENT_MAX_MODEL_ROUNDS: &str = "agent.max_model_rounds";
pub const TEXT_SIZE: &str = "appearance.interface_text_size";
pub const UI_LOCALE: &str = "language.ui_locale";
pub const FONT_SIZE: &str = "editor.font_size";
pub const LINE_HEIGHT: &str = "editor.line_height";
pub const PARAGRAPH_SPACING: &str = "editor.paragraph_spacing";
pub const PAGE_WIDTH: &str = "editor.page_width";
pub const PARAGRAPH_INDENT: &str = "editor.paragraph_indent";
pub const AUTO_IMMERSIVE: &str = "editor.auto_immersive";
pub const TYPEWRITER: &str = "editor.typewriter_mode";
pub const TYPEWRITER_POSITION: &str = "editor.typewriter_position";
pub const JUSTIFY: &str = "editor.justify";
pub const AUTO_ENTITY_LINKS: &str = "editor.auto_entity_links";
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
        key: AGENT_PROVIDER,
        kind: Kind::Module(ModuleValue::Choice(&[
            "deepseek",
            "anthropic",
            "openai",
            "openai-codex",
        ])),
        default: Initial::Str("deepseek"),
        scope: Scope::Account,
        section: Section::Agent,
        group: None,
        label: keys::settings::models::TITLE,
        description: None,
        search: &["provider", "模型", "API"],
    },
    SettingDef {
        key: AGENT_MODEL,
        kind: Kind::Module(ModuleValue::Text { max_bytes: 1024 }),
        default: Initial::Str("deepseek-flash"),
        scope: Scope::Account,
        section: Section::Agent,
        group: None,
        label: keys::agent_panel::config::MODEL,
        description: None,
        search: &["model", "模型"],
    },
    SettingDef {
        key: AGENT_THINKING,
        kind: Kind::Module(ModuleValue::Choice(&[
            "off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
        ])),
        default: Initial::Str("off"),
        scope: Scope::Account,
        section: Section::Agent,
        group: None,
        label: keys::agent_panel::config::EFFORT_LABEL,
        description: None,
        search: &["thinking", "reasoning", "思考", "推理"],
    },
    SettingDef {
        key: AGENT_MAX_MODEL_ROUNDS,
        kind: Kind::Module(ModuleValue::OptionalPositiveU32),
        default: Initial::Unsigned(50),
        scope: Scope::Account,
        section: Section::Agent,
        group: None,
        label: keys::settings::agent_limits::ITERATION_LABEL,
        description: Some(keys::settings::agent_limits::DESC),
        search: &["limit", "iterations", "上限", "迭代"],
    },
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
        key: JUSTIFY,
        kind: Kind::Switch,
        default: Initial::Bool(false),
        scope: Scope::Account,
        section: Section::Editor,
        group: Some(keys::settings::editor::TYPESETTING),
        label: keys::settings::editor::JUSTIFY,
        description: None,
        search: &["justify", "align", "对齐"],
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
        key: TYPEWRITER_POSITION,
        kind: Kind::Number {
            min: 25.0,
            max: 75.0,
            step: 1.0,
            unit: "%",
        },
        default: Initial::Num(50.0),
        scope: Scope::Account,
        section: Section::Editor,
        group: Some(keys::settings::editor::FLOW),
        label: keys::settings::editor::TYPEWRITER_POSITION,
        description: Some(keys::settings::editor::TYPEWRITER_POSITION_DESC),
        search: &["typewriter", "caret line"],
    },
    SettingDef {
        key: AUTO_ENTITY_LINKS,
        kind: Kind::Switch,
        default: Initial::Bool(true),
        scope: Scope::Account,
        section: Section::Editor,
        group: Some(keys::settings::editor::FLOW),
        label: keys::settings::editor::AUTO_ELEMENT_LINK,
        description: Some(keys::settings::editor::AUTO_ELEMENT_LINK_DESC),
        search: &["link", "entity", "element", "链接"],
    },
    SettingDef {
        key: CRASH_REPORTS,
        kind: Kind::Switch,
        // The 0.1 client: on, and said so on first launch.
        default: Initial::Bool(true),
        scope: Scope::Device,
        section: Section::LocalData,
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
            // A stored key keeps its name when its row moves: the crash
            // reports switch was 隐私's before 本地数据 took it in.
            let prefix = match def.section {
                Section::LocalData => "privacy",
                other => other.slug(),
            };
            assert!(
                def.key.starts_with(prefix),
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

    #[test]
    fn backup_and_restore_open_the_local_data_section() {
        let rows: Vec<&str> = info_in(Section::LocalData).map(|r| r.id).collect();
        assert_eq!(&rows[..2], ["local.backup", "local.restore"]);
        for row in info_in(Section::LocalData).take(2) {
            assert!(row.group.is_none(), "{}: under no heading", row.id);
        }
        assert_eq!(
            INFO_ROWS
                .iter()
                .filter(|r| matches!(r.action, RowAction::Backup | RowAction::Restore))
                .count(),
            2
        );
    }
}
