//! dr-i18n: the interface strings.
//!
//! The strings are the 0.1 client's JSON locales (nine languages), copied
//! into `locales/` by `script/sync-locales.py` for the keys listed in
//! `keys.txt`, plus the Windows overlay that turns 「这台 Mac」 into
//! 「这台电脑」. The build turns every key into a constant
//! ([`keys`]), so a key that does not exist is a compile error, and fails
//! when a language lacks a key or a translation's `{{placeholders}}` differ
//! from English.
//!
//! The format is i18next's, as in the old client: `{{name}}` interpolates,
//! plural keys carry `_one`, `_other`, … suffixes picked by the CLDR plural
//! rules of the language (`icu_plurals`), and a missing plural form falls
//! back to `_other`.
//!
//! ```
//! use dr_i18n::{I18n, Locale, Platform, keys};
//! let zh = I18n::new(Locale::ZhCn, Platform::Mac);
//! assert_eq!(zh.t(keys::left_sidebar::tabs::DRIFTS), "构想");
//! let en = I18n::new(Locale::En, Platform::Mac);
//! assert_eq!(en.fmt(keys::left_sidebar::meta::DRIFTS, &[("count", &3)]), "3 ideas");
//! ```
//!
//! [`number`] writes counts the way the interface language does (grouped
//! thousands, the compact 万 / K notation).
//!
//! Nothing here depends on GPUI; the shell keeps one [`I18n`] as a global.

use std::borrow::Cow;
use std::fmt::Display;

use icu_plurals::{PluralCategory, PluralRules};

pub mod number;

include!(concat!(env!("OUT_DIR"), "/strings.rs"));

/// A plain string key. Made only by the generated [`keys`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Key(usize);

/// A key with plural forms, chosen by a count.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct PluralKey(usize);

impl Key {
    /// The dotted JSON path, for logs and tests.
    pub fn name(self) -> &'static str {
        PLAIN_NAMES[self.0]
    }

    /// Every plain key, for tests and the settings search.
    pub fn all() -> impl Iterator<Item = Key> {
        (0..PLAIN_COUNT).map(Key)
    }
}

impl PluralKey {
    pub fn name(self) -> &'static str {
        PLURAL_NAMES[self.0]
    }

    pub fn all() -> impl Iterator<Item = PluralKey> {
        (0..PLURAL_COUNT).map(PluralKey)
    }
}

/// The interface languages, as in the 0.1 client (`src/shared/ui-locales.ts`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Locale {
    ZhCn,
    ZhTw,
    #[default]
    En,
    Ja,
    Ko,
    Es,
    De,
    Fr,
    PtBr,
}

impl Locale {
    /// In the order the language setting lists them.
    pub const ALL: [Locale; 9] = [
        Locale::ZhCn,
        Locale::ZhTw,
        Locale::En,
        Locale::Ja,
        Locale::Ko,
        Locale::Es,
        Locale::De,
        Locale::Fr,
        Locale::PtBr,
    ];

    const fn index(self) -> usize {
        self as usize
    }

    /// The BCP 47 tag the 0.1 client stores (`settings-storage.uiLocale`).
    pub const fn code(self) -> &'static str {
        match self {
            Locale::ZhCn => "zh-CN",
            Locale::ZhTw => "zh-TW",
            Locale::En => "en",
            Locale::Ja => "ja",
            Locale::Ko => "ko",
            Locale::Es => "es",
            Locale::De => "de",
            Locale::Fr => "fr",
            Locale::PtBr => "pt-BR",
        }
    }

    /// The language's name in itself, as the language setting shows it.
    pub const fn native_name(self) -> &'static str {
        match self {
            Locale::ZhCn => "简体中文",
            Locale::ZhTw => "繁體中文",
            Locale::En => "English",
            Locale::Ja => "日本語",
            Locale::Ko => "한국어",
            Locale::Es => "Español",
            Locale::De => "Deutsch",
            Locale::Fr => "Français",
            Locale::PtBr => "Português (Brasil)",
        }
    }

    /// A language tag to one of ours, as `matchUiLocale` does: Chinese by
    /// script or region (Hant, TW, HK, MO → Traditional), every Portuguese
    /// to Brazilian, otherwise by the primary subtag. `None` when we have no
    /// such language.
    pub fn match_tag(tag: &str) -> Option<Locale> {
        let code = tag.trim().replace('_', "-").to_ascii_lowercase();
        let parts: Vec<&str> = code.split('-').collect();
        match parts[0] {
            "zh" => {
                if parts.contains(&"hant") {
                    Some(Locale::ZhTw)
                } else if parts.contains(&"hans") {
                    Some(Locale::ZhCn)
                } else if parts.iter().any(|p| ["tw", "hk", "mo"].contains(p)) {
                    Some(Locale::ZhTw)
                } else {
                    Some(Locale::ZhCn)
                }
            }
            "pt" => Some(Locale::PtBr),
            primary => Locale::ALL
                .into_iter()
                .find(|l| l.code().eq_ignore_ascii_case(primary)),
        }
    }

    /// The stored setting, or English when it is not one of ours.
    pub fn from_code(code: &str) -> Locale {
        Locale::match_tag(code).unwrap_or(Locale::En)
    }

    /// The first of the user's preferred languages we have, else English.
    pub fn detect<I, S>(languages: I) -> Locale
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        languages
            .into_iter()
            .find_map(|tag| Locale::match_tag(tag.as_ref()))
            .unwrap_or(Locale::En)
    }

    /// From the system's preferred languages.
    pub fn from_system() -> Locale {
        Locale::detect(sys_locale::get_locales())
    }

    fn icu(self) -> icu_locale_core::Locale {
        icu_locale_core::Locale::try_from_str(self.code()).expect("our tags are valid BCP 47")
    }
}

/// Which platform's wording to use (the Windows overlay).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Platform {
    Mac,
    Windows,
}

impl Platform {
    pub const fn current() -> Platform {
        if cfg!(target_os = "windows") {
            Platform::Windows
        } else {
            Platform::Mac
        }
    }
}

/// An argument for `{{name}}`.
pub type Arg<'a> = (&'a str, &'a dyn Display);

/// The strings of one language on one platform.
pub struct I18n {
    locale: Locale,
    platform: Platform,
    plurals: Option<PluralRules>,
}

impl std::fmt::Debug for I18n {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("I18n")
            .field("locale", &self.locale)
            .field("platform", &self.platform)
            .finish_non_exhaustive()
    }
}

impl I18n {
    pub fn new(locale: Locale, platform: Platform) -> I18n {
        let plurals = PluralRules::try_new_cardinal((&locale.icu()).into()).ok();
        I18n {
            locale,
            platform,
            plurals,
        }
    }

    pub fn locale(&self) -> Locale {
        self.locale
    }

    pub fn platform(&self) -> Platform {
        self.platform
    }

    /// The string for `key`.
    pub fn t(&self, key: Key) -> &'static str {
        let i = self.locale.index();
        if self.platform == Platform::Windows
            && let Some(text) = WINDOWS[i][key.0]
        {
            return text;
        }
        PLAIN[i][key.0]
    }

    /// The string for `key` with `{{name}}` filled in from `args`.
    pub fn fmt(&self, key: Key, args: &[Arg<'_>]) -> String {
        interpolate(self.t(key), args).into_owned()
    }

    /// The plural form for `count`, with `{{count}}` and `args` filled in.
    pub fn plural(&self, key: PluralKey, count: u64, args: &[Arg<'_>]) -> String {
        let forms = &PLURAL[self.locale.index()][key.0];
        let category = self
            .plurals
            .as_ref()
            .map_or(PluralCategory::Other, |rules| rules.category_for(count));
        let form = match category {
            PluralCategory::Zero => 0,
            PluralCategory::One => 1,
            PluralCategory::Two => 2,
            PluralCategory::Few => 3,
            PluralCategory::Many => 4,
            PluralCategory::Other => 5,
        };
        let text = forms[form]
            .or(forms[5])
            .expect("the build checks every plural key has _other");
        let mut all: Vec<Arg<'_>> = Vec::with_capacity(args.len() + 1);
        all.push(("count", &count));
        all.extend_from_slice(args);
        interpolate(text, &all).into_owned()
    }

    /// Whether `needle` occurs in `key`'s string, ignoring case and runs of
    /// white space (the settings search).
    pub fn contains(&self, key: Key, needle: &str) -> bool {
        normalize(self.t(key)).contains(&normalize(needle))
    }
}

/// Lower case with every run of white space folded to one space, trimmed.
pub fn normalize(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Fills `{{name}}` (spaces inside the braces allowed). An unknown name is
/// left as written, so a missing argument shows instead of vanishing.
pub fn interpolate<'a>(text: &'a str, args: &[Arg<'_>]) -> Cow<'a, str> {
    if !text.contains("{{") {
        return Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len() + 16);
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            out.push_str(&rest[start..]);
            return Cow::Owned(out);
        };
        let name = after[..end].trim();
        match args.iter().find(|(n, _)| *n == name) {
            Some((_, value)) => out.push_str(&value.to_string()),
            None => out.push_str(&rest[start..start + 2 + end + 2]),
        }
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    Cow::Owned(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_resolve_in_every_language() {
        for locale in Locale::ALL {
            let strings = I18n::new(locale, Platform::Mac);
            for key in Key::all() {
                assert!(!strings.t(key).is_empty(), "{locale:?} {}", key.name());
            }
        }
        let zh = I18n::new(Locale::ZhCn, Platform::Mac);
        assert_eq!(zh.t(keys::right_sidebar::tabs::COMPANION), "帮手");
        assert_eq!(zh.t(keys::left_sidebar::tabs::DRIFTS), "构想");
        let tw = I18n::new(Locale::ZhTw, Platform::Mac);
        assert_eq!(tw.t(keys::right_sidebar::tabs::REVIEW), "審閱");
        let en = I18n::new(Locale::En, Platform::Mac);
        assert_eq!(en.t(keys::left_sidebar::tabs::DRIFTS), "Ideas");
    }

    #[test]
    fn the_windows_overlay_replaces_mac_wording() {
        let key = keys::settings::update::CHANNEL_DESC;
        let mac = I18n::new(Locale::ZhCn, Platform::Mac);
        let windows = I18n::new(Locale::ZhCn, Platform::Windows);
        assert!(mac.t(key).contains("macOS"));
        assert!(windows.t(key).contains("Windows"));
        // Keys without an override read the same on both.
        let tab = keys::left_sidebar::tabs::CHAPTERS;
        assert_eq!(mac.t(tab), windows.t(tab));
    }

    #[test]
    fn interpolation_fills_known_names_and_keeps_unknown_ones() {
        assert_eq!(
            interpolate("{{a}} · {{ b }}", &[("a", &1), ("b", &"二")]),
            "1 · 二"
        );
        assert_eq!(interpolate("{{missing}} 字", &[]), "{{missing}} 字");
        assert_eq!(interpolate("no braces", &[("a", &1)]), "no braces");
        assert_eq!(interpolate("open {{ never", &[]), "open {{ never");
        let en = I18n::new(Locale::En, Platform::Mac);
        assert_eq!(
            en.fmt(
                keys::left_sidebar::view_mode::CHAPTER_SUMMARY,
                &[("storylines", &2), ("chapters", &14)]
            ),
            "2 storylines · 14 chapters"
        );
    }

    #[test]
    fn plurals_follow_the_languages_cldr_rules() {
        let key = keys::notifications::markdown_folder::PRESERVED;
        let en = I18n::new(Locale::En, Platform::Mac);
        assert_eq!(
            en.plural(key, 1, &[]),
            "1 edited file was kept in .drifting/preserved"
        );
        assert_eq!(
            en.plural(key, 3, &[]),
            "3 edited files were kept in .drifting/preserved"
        );
        // Chinese has only `other`.
        let zh = I18n::new(Locale::ZhCn, Platform::Mac);
        assert!(zh.plural(key, 1, &[]).starts_with("1 个"));
        // A suffixed key whose stem is a key stays plain (`indent_one`).
        assert_eq!(en.t(keys::settings::editor::INDENT_ONE), "1 char");
        // Not a plural key in the 0.1 data: interpolation only.
        let minutes = keys::notifications::time::MINUTES_AGO;
        assert_eq!(en.fmt(minutes, &[("count", &5)]), "5 min ago");
        for key in PluralKey::all() {
            for locale in Locale::ALL {
                let strings = I18n::new(locale, Platform::Mac);
                for count in [0, 1, 2, 5, 21, 100] {
                    let text = strings.plural(key, count, &[]);
                    assert!(!text.contains("{{count}}"), "{locale:?} {}", key.name());
                }
            }
        }
    }

    #[test]
    fn the_plural_category_picks_the_form() {
        // English: one for 1, other otherwise; French: one for 0 and 1;
        // Japanese: other always.
        let rules = |l: Locale| PluralRules::try_new_cardinal((&l.icu()).into()).unwrap();
        assert_eq!(rules(Locale::En).category_for(1u64), PluralCategory::One);
        assert_eq!(rules(Locale::En).category_for(0u64), PluralCategory::Other);
        assert_eq!(rules(Locale::Fr).category_for(0u64), PluralCategory::One);
        assert_eq!(rules(Locale::Ja).category_for(1u64), PluralCategory::Other);
        assert_eq!(rules(Locale::PtBr).category_for(1u64), PluralCategory::One);
    }

    #[test]
    fn language_tags_match_like_the_old_client() {
        assert_eq!(Locale::match_tag("zh-Hant-HK"), Some(Locale::ZhTw));
        assert_eq!(Locale::match_tag("zh_TW"), Some(Locale::ZhTw));
        assert_eq!(Locale::match_tag("zh-Hans-SG"), Some(Locale::ZhCn));
        assert_eq!(Locale::match_tag("zh"), Some(Locale::ZhCn));
        assert_eq!(Locale::match_tag("pt-PT"), Some(Locale::PtBr));
        assert_eq!(Locale::match_tag("en-GB"), Some(Locale::En));
        assert_eq!(Locale::match_tag("DE-at"), Some(Locale::De));
        assert_eq!(Locale::match_tag("ru"), None);
        assert_eq!(Locale::detect(["ru-RU", "ja-JP"]), Locale::Ja);
        assert_eq!(Locale::detect(["ru"]), Locale::En);
        assert_eq!(Locale::from_code("garbage"), Locale::En);
        for locale in Locale::ALL {
            assert_eq!(Locale::from_code(locale.code()), locale);
        }
    }

    #[test]
    fn search_normalizes_case_and_white_space() {
        assert_eq!(
            normalize("  Interface   Text\nSize "),
            "interface text size"
        );
        let en = I18n::new(Locale::En, Platform::Mac);
        assert!(en.contains(
            keys::settings::appearance::INTERFACE_TEXT_SIZE,
            "text  SIZE"
        ));
    }
}
