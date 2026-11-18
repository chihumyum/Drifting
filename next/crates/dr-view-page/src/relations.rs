//! Draw relation arcs across the visible prose modules of one entry page.

use dr_editor::assist::relate::PageRelations;
use dr_shell::v3::{self, page::EntryPage};
use gpui::prelude::*;
use gpui::{App, Context, Render, WeakEntity, Window, canvas, div};

use crate::v3::BodyModule;

pub(crate) fn register(cx: &mut App) {
    v3::add_entry_overlay(cx, |host, cx| {
        cx.new(|_| RelationsLayer {
            page: host.entry_page,
            relations: PageRelations::default(),
        })
        .into()
    });
}

struct RelationsLayer {
    page: WeakEntity<EntryPage>,
    relations: PageRelations,
}

impl Render for RelationsLayer {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let mut layer = div().absolute().inset_0();
        if let Some(page) = self.page.upgrade() {
            let page = page.read(cx);
            let scroll = page.scroll_handle().clone();
            let view = scroll.bounds();
            let offset = scroll.offset();
            let assists = page
                .prose_views()
                .filter_map(|view| view.downcast::<BodyModule>().ok())
                .filter_map(|body| body.read(cx).editor())
                .map(|editor| editor.read(cx).assist().clone())
                .collect::<Vec<_>>();
            layer = layer.children(self.relations.render(&assists, view, window, cx));
            // The page may scroll during prepaint, after this render read
            // its last frame. Paint the lines again at the settled bounds.
            if self.relations.drawn().is_some() {
                layer = layer.child(
                    canvas(
                        move |_, window, _| {
                            if scroll.bounds() != view || scroll.offset() != offset {
                                window.request_animation_frame();
                            }
                        },
                        |_, _, _, _| {},
                    )
                    .size_0(),
                );
            }
        }
        layer
    }
}
