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
    tokens::Rgb,
};
use gpui::{
    AnyElement, App, ClickEvent, Div, ElementId, InteractiveElement as _, IntoElement,
    ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _, Window, canvas,
    div, point, px, size,
};

/// The text's type as the author set it (the entity page follows the
/// editor's size and line height).
#[derive(Clone, Copy, Debug)]
pub struct Look {
    /// Body size, px.
    pub font_size: f32,
    /// Line height, a multiple of the size.
    pub line_height: f32,
    /// The text's widest, px.
    pub width: f32,
}

pub fn look(cx: &App) -> Look {
    let settings = editor_settings(cx);
    Look {
        font_size: settings.font_size,
        line_height: settings.line_height,
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

/// A dotted rule (`1px dotted var(--rule)`): one grain every 3 px.
pub fn dotted_rule(color: Rgb) -> impl IntoElement {
    let color = color.solid();
    canvas(
        |_, _, _| {},
        move |bounds, _, window, _| {
            let w = f32::from(bounds.size.width);
            let mut x = 0.0;
            while x < w {
                window.paint_quad(gpui::fill(
                    gpui::Bounds {
                        origin: bounds.origin + point(px(x), px(0.0)),
                        size: size(px(1.0), px(1.0)),
                    },
                    color,
                ));
                x += 3.0;
            }
        },
    )
    .w_full()
    .h(px(1.0))
}

/// The folio over a page (`.page__folio`): small index type, the parts
/// joined by a faint 「·」, a dotted rule under it.
pub fn folio(parts: Vec<AnyElement>, window: &Window, cx: &App) -> AnyElement {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let mut line = div()
        .flex()
        .flex_row()
        .flex_wrap()
        .items_center()
        .font_role(Role::Index)
        .type_px(9.5, 9.5 * 1.4)
        .text_color(p.ink(4).solid());
    for (i, part) in parts.into_iter().enumerate() {
        if i > 0 {
            line = line.child(div().mx(px(8.0)).text_color(p.ink(5).solid()).child("·"));
        }
        line = line.child(part);
    }
    div()
        .mb(px(28.0))
        .flex()
        .flex_col()
        .child(div().pb(px(14.0)).child(line))
        .child(dotted_rule(p.rule))
        .into_any_element()
}

/// A part of the folio: a kind mark and a name in ink (`.page__folio-
/// storyline`).
pub fn folio_mark(
    id: impl Into<ElementId>,
    kind: sand::Kind,
    color: Option<Rgb>,
    name: SharedString,
    window: &Window,
    cx: &App,
) -> AnyElement {
    let p = Theme::of(window, cx).palette;
    let mark = sand::KindMark::new(id, kind);
    div()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(5.0))
        .child(match color {
            Some(c) => mark.color(c),
            None => mark,
        })
        .child(div().text_color(p.ink(2).solid()).child(name))
        .into_any_element()
}

/// A section's head on the page (`.page__section`): its title in the
/// structure face, then an index-type meta or a text action on the right,
/// a dotted rule under it. The first section of a page sits closer to what
/// is above it.
pub fn section(
    title: SharedString,
    trailing: Option<AnyElement>,
    first: bool,
    window: &Window,
    cx: &App,
) -> AnyElement {
    let p = Theme::of(window, cx).palette;
    div()
        .mt(px(if first { 8.0 } else { 36.0 }))
        .mb(px(18.0))
        .flex()
        .flex_col()
        .child(
            div()
                .pb(px(6.0))
                .flex()
                .flex_row()
                .items_end()
                .gap(px(12.0))
                .child(
                    div()
                        .flex_1()
                        .font_role(Role::Structure)
                        .type_px(16.0, 16.0 * 1.3)
                        .text_color(p.ink(2).solid())
                        .child(title),
                )
                .children(trailing),
        )
        .child(dotted_rule(p.rule))
        .into_any_element()
}

/// A section head's meta (`.page__section-meta`): index type, faint.
pub fn meta(text: SharedString, window: &Window, cx: &App) -> AnyElement {
    let p = Theme::of(window, cx).palette;
    div()
        .flex_none()
        .font_role(Role::Index)
        .type_px(10.0, 14.0)
        .text_color(p.ink(4).solid())
        .child(text)
        .into_any_element()
}

/// A text action at a section head's right (`.refs-section__text-action`,
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

/// The line an empty section shows (`.ui-section-empty`): the text's face
/// and size on an entity page, the placeholder ink, upright.
pub fn empty_line(text: SharedString, look: Look, window: &Window, cx: &App) -> AnyElement {
    let p = Theme::of(window, cx).palette;
    div()
        .font_role(Role::Prose)
        .type_px(look.font_size, look.font_size * look.line_height)
        .text_color(p.ink(4).solid())
        .child(text)
        .into_any_element()
}
