//! The interface strings as a GPUI global.

use dr_i18n::{Arg, I18n, Key, Locale, Platform, PluralKey};
use gpui::{App, Global, SharedString};

/// The current language's strings. Replaced when the language setting
/// changes; every window is refreshed then.
pub struct Strings(pub I18n);

impl Global for Strings {}

impl Strings {
    pub fn install(locale: Locale, cx: &mut App) {
        cx.set_global(Strings(I18n::new(locale, Platform::current())));
        cx.refresh_windows();
    }

    pub fn get(cx: &App) -> &I18n {
        &cx.global::<Strings>().0
    }
}

/// `key` in the current language.
pub fn t(cx: &App, key: Key) -> SharedString {
    SharedString::new_static(Strings::get(cx).t(key))
}

/// `key` with `{{name}}` filled in.
pub fn tf(cx: &App, key: Key, args: &[Arg<'_>]) -> SharedString {
    Strings::get(cx).fmt(key, args).into()
}

/// The plural form of `key` for `count`.
pub fn tp(cx: &App, key: PluralKey, count: u64, args: &[Arg<'_>]) -> SharedString {
    Strings::get(cx).plural(key, count, args).into()
}
