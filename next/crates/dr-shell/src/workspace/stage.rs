//! The middle column: the paper (one page, or two side by side in a split),
//! the dock over its top edge, the window-drag strip under the dock, and
//! at its foot the Bottom Panel (the timeline or the plot planner,
//! [`super::bottom`]), which the pages make room for.
//!
//! The page is the one raised surface (surfaces.md). Changing pages
//! dissolves in place (`PageTurn`, 180 ms). A page is its editor
//! (`dr-editor`, see [`super::editors`]): one prose document's, or the
//! whole book's (M05).

use dr_i18n::keys;
use dr_ui::{
    Theme,
    fonts::Role,
    glass::{self, Ground},
    style::DrStyled,
    tokens::surface,
    transitions::PageTurn,
};
use gpui::{
    AnyElement, App, BoxShadow, Context, ElementId, Entity, InteractiveElement, IntoElement,
    MouseButton, ParentElement, SharedString, Styled, Window, div, point,
    prelude::FluentBuilder as _, px, relative,
};

use super::chrome::{self, TITLEBAR_HEIGHT};
use super::dock::DockDrag;
use super::{PageSide, Workspace, bottom, corner, dock, outline};
use crate::Settings;
use crate::nav::{Tab, Target};
use crate::settings::registry as r;
use crate::strings::t;

/// The editor settings the paper itself follows (its width).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EditorLook {
    pub font_size: f32,
    pub line_height: f32,
    pub paragraph_spacing: f32,
    pub page_width: f32,
    pub indent: usize,
}

/// The 0.1 client's H1, H2 and H3 (`.page__body .ProseMirror h1…h3`: 28,
/// 22 and 18 px) over its 17 px body text.
pub const HEADING_SCALE: [f32; 3] = [28.0 / 17.0, 22.0 / 17.0, 18.0 / 17.0];

impl EditorLook {
    /// The size of a paragraph's text: the font size, or a heading's.
    pub fn size_of(&self, heading: u8) -> f32 {
        match heading {
            1..=3 => (self.font_size * HEADING_SCALE[heading as usize - 1]).round(),
            _ => self.font_size,
        }
    }

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

pub fn mid(ws: &mut Workspace, window: &mut Window, cx: &mut Context<Workspace>) -> AnyElement {
    let entity = cx.entity();
    let look = EditorLook::read(cx);
    // The middle column's size, for the outline rail's margin.
    let viewport = window.viewport_size();
    let beside = |width: f32, shown: f32| (width * shown).round();
    let column_w = f32::from(viewport.width)
        - if ws.immersive {
            0.0
        } else {
            beside(ws.left.width, ws.left.shown()) + beside(ws.right.width, ws.right.shown())
        };
    // The Bottom Panel takes the column's foot; the pages have the rest.
    let panel = bottom::panel(ws, f32::from(viewport.height), window, cx);
    let column_h = f32::from(viewport.height) - panel.as_ref().map_or(0.0, |(_, h)| *h);
    let active = ws.nav.active_index();
    let pages: AnyElement = match ws.nav.active_tab().cloned() {
        Some(Tab::Split(split)) => {
            let index = active.unwrap_or(0);
            let ratio = split.ratio;
            let side = |which: PageSide, cx: &mut Context<Workspace>| {
                let leaf = split.side(which).clone();
                let focused = split.focused == which;
                let focus = cx.entity();
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
                            focus.update(cx, |ws, cx| {
                                ws.nav.focus_side(index, which);
                                ws.changed(cx);
                            });
                        }
                    })
                    .relative()
                    .child(page_turn(
                        match which {
                            PageSide::Left => "page-left",
                            PageSide::Right => "page-right",
                        },
                        Some(&leaf.target),
                        &entity,
                        look,
                    ))
            };
            let left_target = split.side(PageSide::Left).target.clone();
            let right_target = split.side(PageSide::Right).target.clone();
            let left_rail = outline::rail(
                ws,
                &entity,
                Some(&left_target),
                column_w * ratio,
                column_h,
                window,
                cx,
            );
            let right_rail = outline::rail(
                ws,
                &entity,
                Some(&right_target),
                column_w * (1.0 - ratio),
                column_h,
                window,
                cx,
            );
            let left = side(PageSide::Left, cx)
                .children(left_rail)
                .child(corner::corner(
                    ws,
                    &entity,
                    Some(&left_target),
                    false,
                    window,
                    cx,
                ));
            let right = side(PageSide::Right, cx)
                .children(right_rail)
                .child(corner::corner(
                    ws,
                    &entity,
                    Some(&right_target),
                    true,
                    window,
                    cx,
                ));
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
            let rail = outline::rail(ws, &entity, target.as_ref(), column_w, column_h, window, cx);
            div()
                .relative()
                .size_full()
                .child(page_turn("page-main", target.as_ref(), &entity, look))
                .children(rail)
                .child(corner::corner(
                    ws,
                    &entity,
                    target.as_ref(),
                    true,
                    window,
                    cx,
                ))
                .into_any_element()
        }
    };
    let immersive = ws.immersive;
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
    // Immersed, the tab dots come back with the top band (M26).
    let dock = (!immersive || ws.immersion.top).then(|| dock::dock(ws, window, cx));
    // The find bar, at the paper's top right under the dock.
    let find = ws.find.clone().map(|bar| {
        div()
            .absolute()
            .top(px(TITLEBAR_HEIGHT + 8.0))
            .right(px(corner::CORNER_INSET))
            .child(bar)
    });
    let leave = immersive.then(|| super::immersive::exit(ws, window, cx));
    let dragging = cx.has_active_drag() && ws.nav.active_index().is_some();
    let pages = div()
        .relative()
        .flex_1()
        .min_h_0()
        .w_full()
        .child(pages)
        .when(dragging, |el| el.child(drop_zones(window, cx)));
    div()
        .relative()
        .flex_1()
        .min_w_0()
        .h_full()
        .flex()
        .flex_col()
        .child(pages)
        .children(panel.map(|(el, _)| Workspace::on_sea("sea-bottom", el, ws.ebbing(), cx)))
        .child(strip)
        .children(dock)
        .children(find)
        .children(leave)
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
    ws: &Entity<Workspace>,
    look: EditorLook,
) -> PageTurn {
    let ws = ws.clone();
    PageTurn::new(id, page_key(target), move |key, window, cx| {
        let target = Target::from_key(key);
        paper(&ws, target.as_ref(), look, window, cx)
    })
}

/// One page: the raised paper on the desk, its content scrolling inside.
fn paper(
    ws: &Entity<Workspace>,
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
    // A page a module draws whole lies on the desk at full width, with no
    // sheet: M19's picture is itself the raised paper (the 0.1 client's
    // shell mode).
    if let Some(view) = target.and_then(|t| ws.read(cx).module_page(t).cloned()) {
        return div()
            .id(ElementId::Name(format!("desk-{key}").into()))
            .size_full()
            .bg(p.desk.solid())
            .child(view)
            .into_any_element();
    }
    let content = match target {
        None => home(ws, window, cx),
        Some(target) => document(ws, target, window, cx),
    };
    // Where this page's paper is (a press off it leaves typed immersion).
    let papers = ws.read(cx).immersion.papers.clone();
    let probe_key = key.to_string();
    let probe = gpui::canvas(
        move |bounds, _, _| {
            papers.borrow_mut().insert(probe_key.clone(), bounds);
        },
        |_, _, _, _| {},
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full();
    let sheet = div()
        .id(ElementId::Name(format!("paper-{key}").into()))
        .h_full()
        .w(px(look.page_width))
        .max_w(relative(1.0))
        .bg(p.page.solid())
        .rounded(px(surface::PAGE_RADIUS))
        .shadow(shadow)
        .relative()
        .child(probe)
        .child(content);
    // While the sea ebbs (M24) the desk leaves its colour to it.
    let ebbing = ws.read(cx).ebbing();
    div()
        .size_full()
        .when(!ebbing, |el| el.bg(p.desk.solid()))
        .flex()
        .justify_center()
        .child(glass::surface(Ground::flat(p.page), sheet))
        .into_any_element()
}

fn home(ws: &Entity<Workspace>, window: &mut Window, cx: &mut App) -> AnyElement {
    // Project Home (M02, dr-view-home) when the app registered it.
    if let Some(view) = ws.read(cx).home.clone() {
        return view.into_any_element();
    }
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let s = theme.scale;
    let name = ws.read(cx).book.name.clone();
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
                .child(name),
        )
        .into_any_element()
}

/// A page: its editor (one document's, or the whole book's), the edit
/// menu's commands handed to it.
fn document(ws: &Entity<Workspace>, target: &Target, _: &mut Window, cx: &mut App) -> AnyElement {
    let Some(view) = ws.read(cx).page_view(target).map(|v| v.view()) else {
        return div().into_any_element();
    };
    let id = ElementId::Name(format!("editor-{}", target.key()).into());
    super::editors::forward_edit_actions(div().id(id).size_full())
        .child(view)
        .into_any_element()
}
