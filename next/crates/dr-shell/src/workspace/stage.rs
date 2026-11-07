//! The middle column: the paper (one page, or two side by side in a split),
//! the dock over its top edge, and the window-drag strip under the dock.
//!
//! The page is the one raised surface (surfaces.md). Changing pages
//! dissolves in place (`PageTurn`, 180 ms). A prose document's page is its
//! editor (`dr-editor`, see [`super::editors`]). The whole book is still
//! read-only, set with the editor settings (font size, line height,
//! paragraph spacing and indent, page width): body text in the prose face,
//! H1/H2/H3 at the 0.1 client's 28/22/18 px for its 17 px text, scaled with
//! the font size. Only the rows on screen are laid out (GPUI's `list`).

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
    AnyElement, App, BoxShadow, Context, ElementId, Entity, InteractiveElement, IntoElement,
    MouseButton, ParentElement, SharedString, Styled, Window, div, list, point,
    prelude::FluentBuilder as _, px, relative,
};

use super::chrome::{self, TITLEBAR_HEIGHT};
use super::dock::DockDrag;
use super::{Item, PageSide, Workspace, corner, dock, outline};
use crate::Settings;
use crate::book::Paragraph;
use crate::nav::{Tab, Target};
use crate::settings::registry as r;
use crate::strings::t;

/// How the editor settings set the whole book's read-only page.
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
    let column_h = f32::from(viewport.height);
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
                Some(&left_target),
                column_w * ratio,
                column_h,
                window,
                cx,
            );
            let right_rail = outline::rail(
                ws,
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
            let rail = outline::rail(ws, target.as_ref(), column_w, column_h, window, cx);
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
    let dock = (!immersive).then(|| dock::dock(ws, window, cx));
    let leave = immersive.then(|| corner::leave_immersive(cx));
    let dragging = cx.has_active_drag();
    div()
        .relative()
        .flex_1()
        .min_w_0()
        .h_full()
        .child(pages)
        .child(strip)
        .children(dock)
        .children(leave)
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
    let content = match target {
        None => home(ws, window, cx),
        Some(target) => document(ws, target, look, window, cx),
    };
    let sheet = div()
        .id(ElementId::Name(format!("paper-{key}").into()))
        .h_full()
        .w(px(look.page_width))
        .max_w(relative(1.0))
        .bg(p.page.solid())
        .rounded(px(surface::PAGE_RADIUS))
        .shadow(shadow)
        .child(content);
    div()
        .size_full()
        .bg(p.desk.solid())
        .flex()
        .justify_center()
        .child(glass::surface(Ground::flat(p.page), sheet))
        .into_any_element()
}

fn home(ws: &Entity<Workspace>, window: &mut Window, cx: &mut App) -> AnyElement {
    // Project Home (M02, dr-view-home) when the app registered it.
    if let Some(view) = crate::pages::home_of(ws, window, cx) {
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

/// The page's side margins and the room above the title and below the last
/// paragraph.
const PAGE_PAD_X: f32 = 64.0;
const PAGE_PAD_TOP: f32 = 96.0;
const PAGE_PAD_BOTTOM: f32 = 160.0;

fn document(
    ws: &Entity<Workspace>,
    target: &Target,
    look: EditorLook,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let w = ws.read(cx);
    if *target != Target::Book {
        let Some(editor) = w.editor_of(target).cloned() else {
            return div().into_any_element();
        };
        let id = ElementId::Name(format!("editor-{}", target.key()).into());
        return super::editors::forward_edit_actions(div().id(id).size_full())
            .child(editor)
            .into_any_element();
    }
    let Some(slot) = w.pages.get(&target.key()) else {
        return div().into_any_element();
    };
    let items = slot.items.clone();
    let state = slot.list.clone();
    let book = w.book.clone();
    let theme = Theme::of(window, cx);
    let (kind, color) = book.mark(target);
    let title = super::title_of(&book, target, cx);
    let key = target.key();
    let last = items.len().saturating_sub(1);
    list(state, move |ix, window, cx| {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let row = match &items[ix] {
            Item::Head => {
                let mark = KindMark::new(ElementId::Name(format!("page-mark-{key}").into()), kind);
                let mark = match color {
                    Some(c) => mark.color(c),
                    None => mark,
                };
                div()
                    .pt(px(PAGE_PAD_TOP))
                    .pb(px(28.0))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(10.0))
                    .child(mark)
                    .child(
                        div()
                            .font_role(Role::Structure)
                            .type_px(s.heading + 10.0, s.heading + 20.0)
                            .text_color(p.ink(1).solid())
                            .child(title.clone()),
                    )
            }
            Item::Section(name) => div()
                .pt(px(if ix <= 1 { 0.0 } else { 36.0 }))
                .pb(px(16.0))
                .font_role(Role::Structure)
                .type_px(s.heading + 4.0, s.heading + 12.0)
                .text_color(p.ink(1).solid())
                .child(name.clone()),
            Item::Para(para) => paragraph(para, look, p.ink(1).solid()),
        };
        div()
            .px(px(PAGE_PAD_X))
            .when(ix == last, |el| el.pb(px(PAGE_PAD_BOTTOM)))
            .child(row)
            .into_any_element()
    })
    .size_full()
    .text_color(theme.palette.ink(1).solid())
    .into_any_element()
}

/// A paragraph as the editor sets it: the prose face, the font size or a
/// heading's, the line height as a multiple, the paragraph spacing after
/// it and the indent on body text only (`:is(p, h1, h2, h3)` margin,
/// `p { text-indent }`).
fn paragraph(para: &Paragraph, look: EditorLook, ink: gpui::Hsla) -> gpui::Div {
    let size = look.size_of(para.heading);
    let heading = para.heading > 0;
    let indent = if heading {
        String::new()
    } else {
        "\u{3000}".repeat(look.indent)
    };
    div()
        .font_family(Role::Prose.family())
        .font_weight(weight::REGULAR)
        .text_size(px(size))
        .line_height(px(size * look.line_height))
        .pb(px(look.font_size * look.paragraph_spacing))
        .text_color(ink)
        .child(format!("{indent}{}", para.text))
}
