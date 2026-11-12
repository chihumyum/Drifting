//! What continuing agrees to, in one line (the 0.1 client's `ConsentLine`,
//! 2026-11-13): the last line of the first-run welcome, which every author
//! passes whether they sign in or go on locally (a Hosted build sends fault
//! reports without a session too). It is the welcome's alone: the sign-in
//! dialog has no copy of it, wherever it is opened from (0.1 tried one in
//! its sign-in flow the same day and took it back).
//!
//! The line only names it. The items wait in a hover card on 「相关条款」
//! (underlined, a step darker than the sentence round it): the fault reports
//! this build sends (`docs/crash-reports.md`), then rows that open the
//! service's terms and privacy policy in the browser; a build without terms
//! has no terms row. Pointing at the words opens the card, and so does a
//! press, by hand, keyboard or screen reader. The card opens downward, clear
//! of the ways on above the line.

use dr_i18n::keys;
use dr_i18n::keys::auth::legal as k;
use dr_shell::{settings::registry, strings::tf, t};
use dr_ui::{
    Theme,
    components::{CardAction, CardBody, HoverCard},
    fonts::Role,
    sand::Icon,
    style::{DrStyled, child_id},
};
use gpui::{
    AnyElement, App, ElementId, InteractiveElement as _, IntoElement, ParentElement, Styled,
    Window, div,
};

/// Stands where the sentence names what is agreed to; never in a translation.
const TERMS_SLOT: &str = "\u{0}";

/// The consent sentence in the current language, split round the words that
/// hold the card: `(before, after)`. Where those words go differs by
/// language (「继续即视为同意{{terms}}」, "By continuing, you agree to
/// {{terms}}.").
pub fn consent_parts(cx: &App) -> (String, String) {
    split(&tf(cx, k::CONSENT, &[("terms", &TERMS_SLOT)]))
}

fn split(sentence: &str) -> (String, String) {
    let (before, after) = sentence.split_once(TERMS_SLOT).unwrap_or((sentence, ""));
    (before.to_owned(), after.to_owned())
}

/// The consent line, `id` unique in the window.
pub fn consent_line(id: impl Into<ElementId>, window: &mut Window, cx: &mut App) -> AnyElement {
    let id: ElementId = id.into();
    let theme = Theme::of(window, cx);
    let (p, s) = (theme.palette, theme.scale);
    let (before, after) = consent_parts(cx);
    let terms = t(cx, k::CONSENT_TERMS);
    let words = div()
        .underline()
        .text_color(p.ink(2).solid())
        .hover(move |el| el.text_color(p.ink(1).solid()))
        .debug_selector(|| "consent-terms".into())
        .child(terms.clone());
    let card_id = id.clone();
    let hover = HoverCard::new(child_id(&id, "terms"), words, move |_, cx| {
        consent_card(&card_id, cx)
    })
    .pressable(terms);
    let mut line = div()
        .id(id)
        .flex()
        .flex_row()
        .flex_wrap()
        .items_baseline()
        .font_role(Role::Ui)
        .type_px(s.caption, s.line_caption)
        .text_color(p.ink(3).solid());
    if !before.is_empty() {
        line = line.child(div().child(before));
    }
    line = line.child(hover);
    if !after.is_empty() {
        line = line.child(div().child(after));
    }
    line.into_any_element()
}

/// The card on 「相关条款」: the fault reports, then the terms and the privacy
/// policy, each opening in the browser.
fn consent_card(id: &ElementId, cx: &mut App) -> AnyElement {
    let opens = |name: &'static str, label, url: &'static str| {
        CardAction::new(child_id(id, name), Icon::ArrowOut, label)
            .on_click(move |_, _, cx| cx.open_url(url))
            .into_any_element()
    };
    let mut rows = Vec::new();
    if let Some(url) = registry::terms_url() {
        rows.push(opens("terms-row", t(cx, k::TERMS), url));
    }
    rows.push(opens(
        "privacy-row",
        t(cx, k::PRIVACY),
        registry::privacy_url(),
    ));
    div()
        .debug_selector(|| "consent-card".into())
        .child(
            CardBody::untitled(child_id(id, "card"))
                .summary(t(cx, keys::pre_alpha_guide::CRASH_REPORTS))
                .section(rows),
        )
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;
    use dr_i18n::{I18n, Locale, Platform};

    /// In every language the sentence has the slot once, and its words are
    /// not lost round it.
    #[test]
    fn every_language_splits_round_the_terms() {
        for locale in Locale::ALL {
            let i18n = I18n::new(locale, Platform::Mac);
            let sentence = i18n.fmt(k::CONSENT, &[("terms", &TERMS_SLOT)]);
            assert_eq!(
                sentence.matches(TERMS_SLOT).count(),
                1,
                "{locale:?}: {sentence:?}"
            );
            let (before, after) = split(&sentence);
            assert!(
                !before.contains("{{") && !after.contains("{{"),
                "{locale:?}"
            );
            assert_eq!(
                format!("{before}{}{after}", i18n.t(k::CONSENT_TERMS)),
                i18n.fmt(k::CONSENT, &[("terms", &i18n.t(k::CONSENT_TERMS))]),
                "{locale:?}"
            );
        }
        let zh = I18n::new(Locale::ZhCn, Platform::Mac);
        assert_eq!(
            split(&zh.fmt(k::CONSENT, &[("terms", &TERMS_SLOT)])),
            ("继续即视为同意".to_owned(), String::new())
        );
    }
}
