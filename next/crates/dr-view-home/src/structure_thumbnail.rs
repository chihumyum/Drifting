//! The structure entry in the Project Template table.
use dr_shell::{
    t,
    v3::template_structure::{Graph, paint_edges},
};
use dr_ui::{Theme, tokens::radius};
use gpui::{prelude::*, *};

use crate::v3::Home;

pub(crate) fn render(home: &Home, window: &Window, cx: &App) -> Option<AnyElement> {
    let book = home.source.as_ref()?;
    let v3 = book.v3()?;
    let graph = Graph::read(v3);
    let layout = graph.position(v3);
    let p = Theme::of(window, cx).palette;
    let thumb = canvas(
        |_, _, _| (),
        move |bounds, _, window, _| {
            let scale = (f32::from(bounds.size.width) / layout.width.max(1.0))
                .min(f32::from(bounds.size.height) / layout.height.max(1.0))
                .min(0.35);
            paint_edges(&layout, &graph.edges, bounds, scale, p.ink(2), window);
            for [x, y, w, h] in layout.cards.values() {
                window.paint_quad(gpui::fill(
                    Bounds::new(
                        bounds.origin + point(px(x * scale), px(y * scale)),
                        size(px(w * scale), px(h * scale)),
                    ),
                    p.ink(3).alpha(0.15),
                ));
            }
        },
    )
    .size_full();

    let workspace = home.ws.clone();
    let book_id = book.id.clone();
    let label = t(cx, dr_i18n::keys::v5_fill::STRUCTURE);
    Some(
        div()
            .id("v5-home-structure-thumbnail")
            .debug_selector(|| "v5-home-structure-thumbnail".into())
            .role(gpui::Role::Button)
            .aria_label(label)
            .cursor_pointer()
            .p_1()
            .rounded(px(radius::SM))
            .border_1()
            .border_color(p.local_hairline())
            .hover(move |el| el.bg(p.ink(4).alpha(0.06)))
            .w(px(200.0))
            .max_w_full()
            .h(px(58.0))
            .on_click(move |_, window, cx| {
                let _ = workspace.update(cx, |ws, cx| {
                    if ws.book_id == book_id {
                        ws.open_template_structure(window, cx);
                    }
                });
            })
            .child(thumb)
            .into_any_element(),
    )
}
