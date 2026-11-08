//! How the relations views look on an entity page: the text's column, the
//! section head (dr-view-elements draws the same for 「字段」), a type's
//! sand dash, and the words for kinds and ends.

use dr_i18n::keys::references_panel as rp;
use dr_i18n::keys::relation_picker as pick;
use dr_shell::strings::t;
use dr_shell::workspace::editors::{PAGE_GUTTER, editor_settings};
use dr_ui::tokens::{Rgb, Story};
use dr_ui::{
    Theme,
    fonts::{Role, weight},
    sand::{self, Icon},
    style::DrStyled,
};
use gpui::{
    AnyElement, App, ClickEvent, Div, InteractiveElement as _, IntoElement, ParentElement as _,
    SharedString, StatefulInteractiveElement as _, Styled as _, Window, canvas, div, point, px,
    size,
};

use crate::model::{Paint, Shown};

/// The text's type as the author set it.
#[derive(Clone, Copy, Debug)]
pub struct Look {
    pub font_size: f32,
    pub line_height: f32,
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

/// A dotted rule: one grain every 3 px.
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

/// A section's head on the page (`.page__section`): the title in the
/// structure face, the count and the text actions on the right, a dotted
/// rule under it.
pub fn section(
    title: SharedString,
    trailing: Vec<AnyElement>,
    window: &Window,
    cx: &App,
) -> AnyElement {
    let p = Theme::of(window, cx).palette;
    div()
        .mt(px(36.0))
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

/// A section head's count (`.refs-section__count`): index type, faint.
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

/// A text action at a section head's right (`.refs-section__text-action`):
/// an optional small icon and words; the pointer deepens them.
pub fn text_action(
    id: &'static str,
    icon: Option<Icon>,
    label: SharedString,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    window: &Window,
    cx: &App,
) -> gpui::Stateful<Div> {
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
        .weight(weight::MEDIUM)
        .text_color(p.ink(3).solid())
        .group_hover(id, move |st| st.text_color(p.ink(1).solid()))
        .on_click(on_click)
        .children(icon.map(|i| sand::icon(i, 10.0, p.ink(3).solid())))
        .child(label)
}

/// The line an empty section shows: the text's face and size, the
/// placeholder ink.
pub fn empty_line(text: SharedString, look: Look, window: &Window, cx: &App) -> AnyElement {
    let p = Theme::of(window, cx).palette;
    div()
        .font_role(Role::Prose)
        .type_px(look.font_size, look.font_size * look.line_height)
        .text_color(p.ink(4).solid())
        .child(text)
        .into_any_element()
}

/// A stored colour in this theme.
pub fn rgb(paint: Paint, window: &Window, cx: &App) -> Rgb {
    let p = Theme::of(window, cx).palette;
    match paint {
        Paint::Story(i) => p.story(Story::ALL[i.min(5)]),
        Paint::Ink3 => p.ink(3),
        Paint::Hex(v) => Rgb::hex(v),
    }
}

/// A relation type's sand dash in its colour.
pub fn dash(id: impl Into<gpui::ElementId>, color: Rgb) -> sand::KindMark {
    sand::KindMark::new(id, sand::Kind::Storyline).color(color)
}

/// The word for an end's kind (`referencesPanel.kind.*`).
pub fn kind_word(kind: &str, cx: &App) -> SharedString {
    t(
        cx,
        match kind {
            "element" => rp::kind::ELEMENT,
            "node" => rp::kind::NODE,
            "category" => rp::kind::CATEGORY,
            "storyline" => rp::kind::STORYLINE,
            _ => rp::kind::PATCH,
        },
    )
}

/// An end's name: its own, the untitled word for its kind, or the gone one.
pub fn title(kind: &str, shown: &Shown, cx: &App) -> SharedString {
    if !shown.live {
        return t(
            cx,
            match kind {
                "element" => rp::deleted::ELEMENT,
                "category" => rp::deleted::CATEGORY,
                "storyline" => rp::deleted::STORYLINE,
                _ => rp::deleted::NODE,
            },
        );
    }
    if !shown.title.trim().is_empty() {
        return shown.title.clone().into();
    }
    t(
        cx,
        match kind {
            "element" => pick::UNTITLED_ELEMENT,
            "storyline" => pick::UNTITLED_STORYLINE,
            // 0.1 named an untitled category by its id; its kind reads better.
            "category" => rp::kind::CATEGORY,
            "node" if shown.idea => pick::UNTITLED_DRIFT,
            _ => pick::UNTITLED_CHAPTER,
        },
    )
}
