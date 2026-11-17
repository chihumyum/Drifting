//! The parts of an entity page (the 0.1 client's `.page--entity`) the
//! element and category pages share: the column over the text, the folio,
//! section heads, the dotted rule, the line an empty section shows.
//!
//! The head and end of a page are list items of the editor, as wide as the
//! paper; [`column`] puts their content over the text (the paper's gutter on
//! both sides, at most the text's width, centred), as the editor lays out
//! its paragraphs.

use dr_shell::workspace::editors::{PAGE_GUTTER, editor_settings};
use dr_ui::{
    Theme,
    fonts::Role,
    sand::{self, Icon},
    style::DrStyled,
};
use gpui::{
    AnyElement, App, ClickEvent, Div, InteractiveElement as _, IntoElement, ParentElement as _,
    SharedString, StatefulInteractiveElement as _, Styled as _, Window, div, px,
};

/// The text's type as the author set it (the entity page follows the
/// editor's size and line height).
#[derive(Clone, Copy, Debug)]
pub struct Look {
    /// The text's widest, px.
    pub width: f32,
}

pub fn look(cx: &App) -> Look {
    let settings = editor_settings(cx);
    Look {
        width: settings.page_width,
    }
}

/// `content` over the text: the paper's gutter on both sides, at most the
/// text's width, centred.
pub fn column(look: Look, content: impl IntoElement) -> Div {
    div()
        .w_full()
        .px(px(PAGE_GUTTER))
        .flex()
        .justify_center()
        .child(div().w_full().max_w(px(look.width)).child(content))
}

/// A small word for a dangerous action in a row's title line (a patch's
/// 「删除」, UP): the index ink at rest, the danger colour under the pointer,
/// so it reads as dangerous only when the hand is on it.
pub fn danger_word(
    id: SharedString,
    label: SharedString,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    window: &Window,
    cx: &App,
) -> AnyElement {
    let p = Theme::of(window, cx).palette;
    let danger = p.danger.solid();
    div()
        .id(id.clone())
        .debug_selector(move || id.to_string())
        .flex_none()
        .h(px(24.0))
        .px(px(4.0))
        .flex()
        .items_center()
        .cursor_pointer()
        .role(gpui::Role::Button)
        .aria_label(label.clone())
        .font_role(Role::Ui)
        .type_px(12.5, 16.0)
        .weight(dr_ui::fonts::weight::MEDIUM)
        .text_color(p.ink(4).solid())
        .hover(move |st| st.text_color(danger))
        .on_click(on_click)
        .child(label)
        .into_any_element()
}

/// A text action at a module title's right (`.refs-section__text-action`,
/// 「+ 新增字段」): a small plus and words; the pointer deepens them.
pub fn text_action(
    id: &'static str,
    label: SharedString,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    window: &Window,
    cx: &App,
) -> AnyElement {
    let p = Theme::of(window, cx).palette;
    div()
        .id(id)
        .group(id)
        .flex_none()
        .h(px(24.0))
        .px(px(4.0))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(4.0))
        .cursor_pointer()
        .role(gpui::Role::Button)
        .aria_label(label.clone())
        .font_role(Role::Ui)
        .type_px(12.5, 16.0)
        .weight(dr_ui::fonts::weight::MEDIUM)
        .text_color(p.ink(3).solid())
        .group_hover(id, move |st| st.text_color(p.ink(1).solid()))
        .on_click(on_click)
        .child(sand::icon(Icon::Plus, 10.0, p.ink(3).solid()))
        .child(label)
        .into_any_element()
}
