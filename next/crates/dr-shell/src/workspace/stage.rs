//! The middle column: the paper (one page, or two side by side in a split),
//! the dock over its top edge, and the window-drag strip under the dock.
//!
//! The page is the one raised surface (surfaces.md). Changing pages
//! dissolves in place (`PageTurn`, 180 ms). Until the editor (F4e) arrives,
//! a chapter shows the stand-in book's made-up passage read-only, set with
//! the editor settings (font size, line height, paragraph spacing and
//! indent, page width), so those settings already show their effect.

use std::rc::Rc;

use dr_i18n::keys;
use dr_ui::{
    Theme,
    fonts::{Role, weight},
    glass::{self, Ground},
    sand::KindMark,
    style::DrStyled,
    tokens::surface,
    transitions::PageTurn,
};
use gpui::{
    AnyElement, App, BoxShadow, Context, ElementId, InteractiveElement, IntoElement, MouseButton,
    ParentElement, SharedString, StatefulInteractiveElement, Styled, Window, div, point,
    prelude::FluentBuilder as _, px, relative,
};

use super::chrome::{self, TITLEBAR_HEIGHT};
use super::dock::{self, DockDrag};
use super::{PageSide, Workspace};
use crate::Settings;
use crate::nav::{Tab, Target};
use crate::settings::registry as r;
use crate::stand_in::StandIn;
use crate::strings::t;

/// How the editor settings set the read-only page.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EditorLook {
    pub font_size: f32,
    pub line_height: f32,
    pub paragraph_spacing: f32,
    pub page_width: f32,
    pub indent: usize,
}

impl EditorLook {
    pub fn read(cx: &App) -> EditorLook {
        let file = Settings::read(cx);
        EditorLook {
            font_size: file.number(r::FONT_SIZE) as f32,
            line_height: file.number(r::LINE_HEIGHT) as f32,
            paragraph_spacing: file.number(r::PARAGRAPH_SPACING) as f32,
            page_width: file.number(r::PAGE_WIDTH) as f32,
            indent: match file.str(r::PARAGRAPH_INDENT).as_deref() {
                Some("one") => 1,
                Some("two") => 2,
                _ => 0,
            },
        }
    }
}

/// The key a page is turned by.
fn page_key(target: Option<&Target>) -> SharedString {
    match target {
        Some(target) => target.key().into(),
        None => "home".into(),
    }
}

fn target_for_key(book: &StandIn, key: &str) -> Option<Target> {
    if key == "book" {
        return Some(Target::Book);
    }
    let (kind, id) = key.split_once(':')?;
    let target = match kind {
        "chapter" => Target::Chapter(id.parse().ok()?),
        "idea" => Target::Idea(id.parse().ok()?),
        "storyline" => Target::Storyline(id.parse().ok()?),
        "element" => Target::Element(id.parse().ok()?),
        "category" => Target::Category(id.parse().ok()?),
        "material" => Target::Material(id.parse().ok()?),
        _ => return None,
    };
    book.exists(&target).then_some(target)
}

pub fn mid(ws: &mut Workspace, window: &mut Window, cx: &mut Context<Workspace>) -> AnyElement {
    let book = ws.book.clone();
    let look = EditorLook::read(cx);
    let active = ws.nav.active_index();
    let pages: AnyElement = match ws.nav.active_tab().cloned() {
        Some(Tab::Split(split)) => {
            let index = active.unwrap_or(0);
            let ratio = split.ratio;
            let side = |which: PageSide, cx: &mut Context<Workspace>| {
                let leaf = split.side(which).clone();
                let focused = split.focused == which;
                let entity = cx.entity();
                div()
                    .id(match which {
                        PageSide::Left => "split-left",
                        PageSide::Right => "split-right",
                    })
                    .h_full()
                    .when(which == PageSide::Left, |el| el.w(relative(ratio)))
                    .when(which == PageSide::Right, |el| el.flex_1())
                    .min_w_0()
                    .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                        if !focused {
                            entity.update(cx, |ws, cx| {
                                ws.nav.focus_side(index, which);
                                ws.changed(cx);
                            });
                        }
                    })
                    .child(page_turn(
                        match which {
                            PageSide::Left => "page-left",
                            PageSide::Right => "page-right",
                        },
                        Some(&leaf.target),
                        &book,
                        look,
                    ))
            };
            let left = side(PageSide::Left, cx);
            let right = side(PageSide::Right, cx);
            let theme = Theme::of(window, cx);
            div()
                .size_full()
                .flex()
                .flex_row()
                .child(left)
                .child(
                    div()
                        .w(px(surface::HAIRLINE))
                        .h_full()
                        .bg(theme.palette.local_hairline()),
                )
                .child(right)
                .into_any_element()
        }
        tab => {
            let target = tab.map(|t| t.focused().target.clone());
            page_turn("page-main", target.as_ref(), &book, look).into_any_element()
        }
    };
    let strip = chrome::drag_region(
        div()
            .id("drag-strip")
            .absolute()
            .top_0()
            .left_0()
            .right_0()
            .h(px(TITLEBAR_HEIGHT)),
        cx,
    );
    let dock = dock::dock(ws, window, cx);
    let dragging = cx.has_active_drag();
    div()
        .relative()
        .flex_1()
        .min_w_0()
        .h_full()
        .child(pages)
        .child(strip)
        .child(dock)
        .when(dragging && ws.nav.active_index().is_some(), |el| {
            el.child(drop_zones(window, cx))
        })
        .into_any_element()
}

/// While a pill is in the hand: the paper's halves, to split onto.
fn drop_zones(window: &mut Window, cx: &mut Context<Workspace>) -> impl IntoElement {
    let theme = Theme::of(window, cx);
    let wash = theme.palette.accent.alpha(0.06);
    let zone = |id: &'static str, side: PageSide, cx: &mut Context<Workspace>| {
        div()
            .id(id)
            .absolute()
            .top(px(TITLEBAR_HEIGHT))
            .bottom_0()
            .w(relative(0.5))
            .when(side == PageSide::Left, |el| el.left_0())
            .when(side == PageSide::Right, |el| el.right_0())
            .drag_over::<DockDrag>(move |style, _, _, _| style.bg(wash))
            .on_drop(cx.listener(move |ws, drag: &DockDrag, _, cx| {
                if ws.nav.split_with(drag.from, side) {
                    ws.changed(cx);
                }
            }))
    };
    div()
        .absolute()
        .inset_0()
        .child(zone("drop-left", PageSide::Left, cx))
        .child(zone("drop-right", PageSide::Right, cx))
}

fn page_turn(
    id: &'static str,
    target: Option<&Target>,
    book: &Rc<StandIn>,
    look: EditorLook,
) -> PageTurn {
    let book = book.clone();
    PageTurn::new(id, page_key(target), move |key, window, cx| {
        let target = target_for_key(&book, key);
        paper(&book, target.as_ref(), look, window, cx)
    })
}

/// One page: the raised paper on the desk, its content scrolling inside.
fn paper(
    book: &StandIn,
    target: Option<&Target>,
    look: EditorLook,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let (edge, fall) = p.page_shadow;
    let shadow = vec![
        BoxShadow {
            color: p.shadow_ink.alpha(edge),
            offset: point(px(0.0), px(0.0)),
            blur_radius: px(0.0),
            spread_radius: px(1.0),
            inset: false,
        },
        BoxShadow {
            color: p.shadow_ink.alpha(fall),
            offset: point(px(0.0), px(2.0)),
            blur_radius: px(14.0),
            spread_radius: px(0.0),
            inset: false,
        },
    ];
    let key = page_key(target);
    let content = match target {
        None => home(book, window, cx),
        Some(target) => document(book, target, look, window, cx),
    };
    let sheet = div()
        .id(ElementId::Name(format!("paper-{key}").into()))
        .h_full()
        .w(px(look.page_width))
        .max_w(relative(1.0))
        .bg(p.page.solid())
        .rounded(px(surface::PAGE_RADIUS))
        .shadow(shadow)
        .overflow_y_scroll()
        .child(content);
    div()
        .size_full()
        .bg(p.desk.solid())
        .flex()
        .justify_center()
        .child(glass::surface(Ground::flat(p.page), sheet))
        .into_any_element()
}

fn home(book: &StandIn, window: &mut Window, cx: &mut App) -> AnyElement {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let s = theme.scale;
    div()
        .pt(px(120.0))
        .px(px(64.0))
        .flex()
        .flex_col()
        .gap(px(10.0))
        .child(
            div()
                .font_role(Role::Index)
                .type_px(s.caption, s.line_caption)
                .text_color(p.muted().solid())
                .child(t(cx, keys::project_home::KICKER)),
        )
        .child(
            div()
                .font_role(Role::Structure)
                .type_px(s.heading + 16.0, s.heading + 26.0)
                .text_color(p.ink(1).solid())
                .child(book.title),
        )
        .into_any_element()
}

fn document(
    book: &StandIn,
    target: &Target,
    look: EditorLook,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let s = theme.scale;
    let (kind, color) = dock::mark_of(book, target, &theme);
    let title = super::title_of(book, target, cx);
    let mark = KindMark::new(
        ElementId::Name(format!("page-mark-{}", target.key()).into()),
        kind,
    );
    let mark = match color {
        Some(c) => mark.color(c),
        None => mark,
    };
    let heading = |text: SharedString| {
        div()
            .font_role(Role::Structure)
            .type_px(s.heading + 10.0, s.heading + 20.0)
            .text_color(p.ink(1).solid())
            .child(text)
    };
    let prose = |text: &'static str| {
        let indent = "\u{3000}".repeat(look.indent);
        div()
            .font_family(Role::Prose.family())
            .font_weight(weight::REGULAR)
            .text_size(px(look.font_size))
            .line_height(px(look.font_size * look.line_height))
            .mb(px(look.font_size * look.paragraph_spacing))
            .text_color(p.ink(1).solid())
            .child(format!("{indent}{text}"))
    };
    let mut col = div()
        .pt(px(96.0))
        .pb(px(160.0))
        .px(px(64.0))
        .flex()
        .flex_col();
    col = col.child(
        div()
            .mb(px(28.0))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(10.0))
            .child(mark)
            .child(heading(title)),
    );
    match target {
        Target::Chapter(id) => {
            let i = book.chapter_index(id).unwrap_or(0);
            col = col.children(book.paragraphs(i).map(prose));
        }
        Target::Book => {
            for (i, chapter) in book.chapters.iter().enumerate() {
                col = col.child(
                    div()
                        .mt(px(if i == 0 { 0.0 } else { 36.0 }))
                        .mb(px(16.0))
                        .font_role(Role::Structure)
                        .type_px(s.heading + 4.0, s.heading + 12.0)
                        .text_color(p.ink(1).solid())
                        .child(chapter.title),
                );
                col = col.children(book.paragraphs(i).take(2).map(prose));
            }
        }
        _ => {}
    }
    col.into_any_element()
}
