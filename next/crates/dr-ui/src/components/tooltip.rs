//! Compact floating tooltips for icon buttons, controls, and toolbar actions.
//!
//! Styled with Drifting's desk surface, hairline edge, subtle floating shadow,
//! UI body face for the label, and index face for an optional shortcut hint.

use gpui::{
    AnyView, App, AppContext as _, Context, IntoElement, ParentElement, Render, SharedString,
    Styled, Window, div, prelude::FluentBuilder as _, px,
};

use crate::{fonts::Role, style::DrStyled, theme::Theme, tokens::radius};

use super::menu::float_shadow;

/// A floating tooltip view showing a short label and an optional keyboard
/// shortcut hint.
pub struct Tooltip {
    label: SharedString,
    shortcut: Option<SharedString>,
}

impl Tooltip {
    pub fn new(label: impl Into<SharedString>) -> Self {
        Self {
            label: label.into(),
            shortcut: None,
        }
    }

    pub fn shortcut(mut self, shortcut: impl Into<SharedString>) -> Self {
        let s = shortcut.into();
        if !s.is_empty() {
            self.shortcut = Some(s);
        }
        self
    }

    /// Builder closure suitable for GPUI's `StatefulInteractiveElement::tooltip`.
    pub fn text(
        label: impl Into<SharedString>,
    ) -> impl Fn(&mut Window, &mut App) -> AnyView + 'static {
        let label = label.into();
        move |_, cx| cx.new(|_| Tooltip::new(label.clone())).into()
    }

    /// Builder closure showing `label` with a trailing keyboard shortcut hint.
    pub fn with_shortcut(
        label: impl Into<SharedString>,
        shortcut: impl Into<SharedString>,
    ) -> impl Fn(&mut Window, &mut App) -> AnyView + 'static {
        let label = label.into();
        let shortcut = shortcut.into();
        move |_, cx| {
            cx.new(|_| Tooltip::new(label.clone()).shortcut(shortcut.clone()))
                .into()
        }
    }
}

/// Convenience builder for GPUI's `.tooltip(...)`.
pub fn tooltip(
    label: impl Into<SharedString>,
) -> impl Fn(&mut Window, &mut App) -> AnyView + 'static {
    Tooltip::text(label)
}

/// Convenience builder for GPUI's `.tooltip(...)` with a shortcut hint.
pub fn tooltip_with_shortcut(
    label: impl Into<SharedString>,
    shortcut: impl Into<SharedString>,
) -> impl Fn(&mut Window, &mut App) -> AnyView + 'static {
    Tooltip::with_shortcut(label, shortcut)
}

impl Render for Tooltip {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        div().pl(px(4.0)).pt(px(6.0)).child(
            div()
                .max_w(px(280.0))
                .px(px(8.0))
                .py(px(4.0))
                .rounded(px(radius::SM))
                .bg(p.desk.solid())
                .border_1()
                .border_color(p.hairline())
                .shadow(float_shadow(p))
                .flex()
                .flex_row()
                .items_center()
                .gap(px(8.0))
                .child(
                    div()
                        .font_role(Role::Ui)
                        .type_px(s.caption, s.line_caption)
                        .text_color(p.ink(1).solid())
                        .child(self.label.clone()),
                )
                .when_some(self.shortcut.clone(), |el, shortcut| {
                    el.child(
                        div()
                            .flex_none()
                            .font_role(Role::Index)
                            .type_px(s.caption - 1.0, s.line_caption)
                            .text_color(p.ink(3).solid())
                            .child(shortcut),
                    )
                }),
        )
    }
}
