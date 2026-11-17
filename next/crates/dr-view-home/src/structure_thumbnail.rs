//! The 「结构」 row of the Project Template table: the structure, small
//! (`W30Home`, 乙). A click fills the left column into 模板结构.
use dr_shell::{
    t,
    v3::template_structure::{
        CARD_W, EdgeKind, Graph, Route, Stroke, card_height, paint_route, template_meta,
    },
};
use dr_ui::{
    Theme,
    fonts::Role,
    glass::{self, Kind, Mode, Spec, Tone},
    style::DrStyled as _,
};
use gpui::{prelude::*, *};

use crate::v3::Home;

/// The board's largest size in the thumbnail (`.w8-th-b`); the thumbnail is
/// the board as drawn and its margins, no larger (UP, kernel-v5 §15 item 50:
/// it was a fixed 300 × 226 with the board in a corner of it).
const BOARD_W: f32 = 262.0;
const BOARD_H: f32 = 194.0;
/// The thumbnail's margins round the board, and the board's top under the
/// counts.
const PAD: f32 = 10.0;
const BOARD_TOP: f32 = 30.0;
/// Never narrower than the counts at its head need.
pub const MIN_W: f32 = 170.0;

pub(crate) fn render(home: &Home, window: &mut Window, cx: &mut App) -> Option<AnyElement> {
    let book = home.source.as_ref()?;
    let v3 = book.v3()?;
    let graph = Graph::read(v3);
    let mut layout = graph.position(v3);
    // The unused templates stand in the board's tray, a column to the
    // right of the used ones (`W12Template`), as small as the rest.
    let tray_x = layout.width;
    let mut tray_y = 30.0;
    for id in &graph.unused {
        if let Some(template) = v3.template(id) {
            let height = card_height(template);
            layout
                .cards
                .insert(id.clone(), [tray_x, tray_y, CARD_W, height]);
            tray_y += height + 8.0;
            layout.width = layout.width.max(tray_x + CARD_W + 20.0);
            layout.height = layout.height.max(tray_y + 4.0);
        }
    }
    let scale = (BOARD_W / layout.width.max(1.0)).min(BOARD_H / layout.height.max(1.0));
    let drawn_w = (layout.width * scale).min(BOARD_W);
    let drawn_h = (layout.height * scale).min(BOARD_H);
    let p = Theme::of(window, cx).palette;
    let routes: Vec<(Route, EdgeKind)> = graph
        .edges
        .iter()
        .filter_map(|edge| Some((Route::of(&layout, edge)?, edge.kind)))
        .collect();
    let cards: Vec<[f32; 4]> = layout.cards.values().copied().collect();
    let line = p.ink(4).alpha(0.8);
    let page = p.page.solid();
    let hair = p.local_hairline();
    let board = div()
        .debug_selector(|| "v5-home-structure-board".into())
        .absolute()
        .left(px(PAD))
        .top(px(BOARD_TOP))
        .w(px(drawn_w))
        .h(px(drawn_h))
        .child(
            canvas(
                |_, _, _| (),
                move |bounds, _, window, _| {
                    for (route, kind) in &routes {
                        let stroke = Stroke {
                            color: line,
                            width: 0.8,
                            dot: false,
                            thin: true,
                        };
                        paint_route(route, *kind, stroke, bounds, scale, window);
                    }
                    for [x, y, w, h] in &cards {
                        let at = Bounds::new(
                            bounds.origin + point(px(x * scale), px(y * scale)),
                            size(px(w * scale), px(h * scale)),
                        );
                        window.paint_quad(
                            gpui::fill(at, page)
                                .corner_radii(px(1.5))
                                .border_widths(px(0.5))
                                .border_color(hair),
                        );
                    }
                },
            )
            .size_full(),
        );

    let meta = template_meta(v3, cx);
    let workspace = home.ws.clone();
    let book_id = book.id.clone();
    let label = t(cx, dr_i18n::keys::v5_fill::STRUCTURE);
    Some(
        glass::glass_box(
            "v5-home-structure-thumbnail",
            Kind::Rest,
            Mode::default(),
            false,
            Spec::new(Tone::Clear, 4.0).filled(p.desk),
            window,
            cx,
        )
        .debug_selector(|| "v5-home-structure-thumbnail".into())
        .role(gpui::Role::Button)
        .aria_label(label)
        .cursor_pointer()
        .flex_none()
        .w(px((drawn_w + 2.0 * PAD).max(MIN_W)))
        .h(px(BOARD_TOP + drawn_h + PAD))
        .rounded(px(4.0))
        .bg(p.desk.solid())
        .overflow_hidden()
        .on_click(move |_, window, cx| {
            let _ = workspace.update(cx, |ws, cx| {
                if ws.book_id == book_id {
                    ws.open_template_structure(window, cx);
                }
            });
        })
        // The head: the counts (the row's key already says 「结构」).
        .child(
            div()
                .id("v5-home-structure-meta")
                .debug_selector(|| "v5-home-structure-meta".into())
                .role(gpui::Role::Label)
                .aria_label(meta.clone())
                .absolute()
                .left(px(10.0))
                .right(px(10.0))
                .top(px(6.0))
                .h(px(20.0))
                .flex()
                .items_center()
                .whitespace_nowrap()
                .font_role(Role::Index)
                .type_px(13.0, 13.0)
                .text_color(p.ink(4).solid())
                .child(meta),
        )
        .child(board)
        .into_any_element(),
    )
}
