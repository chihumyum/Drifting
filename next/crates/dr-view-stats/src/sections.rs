//! Shared statistics typography and strokes, consumed by the v3 panel.
use dr_i18n::{Arg, I18n, Key, keys};
use dr_ui::{Theme, fonts::Role, sand::Readout, style::DrStyled, tokens::Rgb};
use gpui::{Div, ElementId, IntoElement, ParentElement, SharedString, Styled, div, px};
use keys::right_sidebar::stats;
pub(crate) struct Ui<'a> {
    pub theme: Theme,
    pub i18n: &'a I18n,
    pub id: SharedString,
}
impl Ui<'_> {
    pub fn id(&self, name: &str) -> ElementId {
        ElementId::Name(format!("{}-{name}", self.id).into())
    }
    pub fn t(&self, key: Key) -> SharedString {
        self.i18n.t(key).into()
    }
    pub fn fmt(&self, key: Key, args: &[Arg<'_>]) -> SharedString {
        self.i18n.fmt(key, args).into()
    }
    pub fn n(&self, v: i64) -> String {
        dr_i18n::number::grouped_signed(v, self.i18n.locale())
    }
    pub fn words(&self, v: u64) -> SharedString {
        self.fmt(stats::WORDS_VALUE, &[("count", &self.n(v as i64))])
    }
    pub fn small(&self, text: impl Into<SharedString>) -> Div {
        let s = self.theme.scale;
        div()
            .font_role(Role::Index)
            .type_px(s.caption, s.line_caption)
            .text_color(self.theme.palette.muted().solid())
            .child(text.into())
    }
    pub fn row(&self, key: impl Into<SharedString>, value: impl IntoElement) -> Div {
        let s = self.theme.scale;
        div()
            .flex()
            .flex_row()
            .items_baseline()
            .justify_between()
            .gap(px(12.0))
            .child(self.small(key).flex_none())
            .child(
                div()
                    .min_w_0()
                    .font_role(Role::Ui)
                    .type_px(s.secondary, s.line_body)
                    .text_color(self.theme.palette.ink(1).solid())
                    .child(value),
            )
    }
    pub fn section(&self, title: Option<SharedString>) -> Div {
        let s = self.theme.scale;
        let mut el = div().flex().flex_col().gap(px(6.0));
        if let Some(title) = title {
            el = el.child(
                div()
                    .font_role(Role::Structure)
                    .type_px(s.secondary, s.line_body)
                    .text_color(self.theme.palette.ink(2).solid())
                    .pb(px(2.0))
                    .child(title),
            );
        }
        el
    }
    pub fn stroke(&self, name: &str, value: f32, color: Option<Rgb>) -> Readout {
        Readout::new(self.id(name), value).color(color.unwrap_or(self.theme.palette.ink(2)))
    }
}
