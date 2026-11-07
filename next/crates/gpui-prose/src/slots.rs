//! Places in the scroll for the host's own elements: each chapter's head (in
//! place of the editor's title row) and its end (after its last paragraph).
//!
//! A host puts a chapter page's header, an editable title, a synopsis, an
//! end ornament or an empty-chapter hint there. They are list items like the
//! paragraphs: they scroll with the text, only the visible ones are built,
//! and each is measured at its real height for the scrollbar and for jumps.
//! A mouse press inside one stays there (the editor does not move its caret
//! or take focus), so the host's buttons and fields work as usual.

use std::{cell::RefCell, rc::Rc};

use gpui::{
    AnyElement, App, InteractiveElement, IntoElement, MouseButton, ParentElement, Styled, Window,
    canvas, div,
};

use crate::layout::HeightIndex;

/// The host's elements around each chapter ([`crate::ProseEditor::set_slots`]).
pub trait ChapterSlots: 'static {
    /// Drawn in place of chapter `chapter`'s title row. `None` keeps the
    /// editor's own title row.
    fn head(&self, _chapter: usize, _window: &mut Window, _cx: &mut App) -> Option<AnyElement> {
        None
    }

    /// Drawn after chapter `chapter`'s last paragraph. `None` draws nothing.
    fn end(&self, _chapter: usize, _window: &mut Window, _cx: &mut App) -> Option<AnyElement> {
        None
    }

    /// The height to assume for a head that has not been drawn yet, in px
    /// (the scrollbar and jumps use it until the real height is known).
    fn head_estimate(&self, _chapter: usize) -> f32 {
        160.
    }

    /// The height to assume for an end that has not been drawn yet, in px.
    fn end_estimate(&self, _chapter: usize) -> f32 {
        96.
    }
}

/// A slot's list item: the host's element at full width, its height written
/// to the editor's height index, mouse presses kept inside.
pub(crate) fn slot_item(
    item_ix: usize,
    heights: Rc<RefCell<HeightIndex>>,
    element: Option<AnyElement>,
) -> AnyElement {
    let Some(element) = element else {
        // An empty end: nothing to draw, and no height.
        heights.borrow_mut().set_measured(item_ix, 0.);
        return div().w_full().h_0().into_any_element();
    };
    div()
        .w_full()
        .relative()
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .child(element)
        .child(
            canvas(
                move |bounds, _, _| {
                    heights
                        .borrow_mut()
                        .set_measured(item_ix, f32::from(bounds.size.height));
                },
                |_, _, _, _| {},
            )
            .absolute()
            .size_full(),
        )
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use gpui::{
        AppContext as _, Context, Entity, Focusable as _, Modifiers, Render, TestAppContext,
        VisualTestContext, point, px, size,
    };

    use super::*;
    use crate::{
        ProseEditor, ProseStyle,
        layout::{Book, Chapter, Item},
        text::{BlockKind, ProseDoc},
    };

    /// Heads 120 px high (counting how often they are built), an 80 px end
    /// after the first chapter only.
    struct Slots {
        built: Rc<Cell<usize>>,
    }

    impl ChapterSlots for Slots {
        fn head(&self, chapter: usize, _: &mut Window, _: &mut App) -> Option<AnyElement> {
            self.built.set(self.built.get() + 1);
            Some(
                div()
                    .h(px(120.))
                    .child(format!("页眉 {chapter}"))
                    .into_any_element(),
            )
        }

        fn end(&self, chapter: usize, _: &mut Window, _: &mut App) -> Option<AnyElement> {
            (chapter == 0).then(|| div().h(px(80.)).child("⁂").into_any_element())
        }
    }

    fn book() -> Book {
        Book::new(vec![
            Chapter {
                title: "一".into(),
                doc: ProseDoc::from_paragraphs([
                    (BlockKind::Body, "雨夜。"),
                    (BlockKind::Body, "钟停了。"),
                ]),
            },
            Chapter {
                title: "二".into(),
                doc: ProseDoc::from_paragraphs([(BlockKind::Body, "天亮。")]),
            },
        ])
    }

    fn draw(cx: &mut VisualTestContext) {
        cx.run_until_parked();
        cx.update(|window, cx| {
            window.simulate_next_frame(cx);
            window.draw(cx).clear(cx);
        });
        cx.run_until_parked();
    }

    #[gpui::test]
    fn slots_take_the_title_row_and_follow_each_chapter(cx: &mut TestAppContext) {
        let built = Rc::new(Cell::new(0));
        let (editor, cx) = cx.add_window_view(|window, cx| {
            let mut editor = ProseEditor::new(book(), ProseStyle::default(), window, cx);
            editor.set_slots(
                Some(Rc::new(Slots {
                    built: built.clone(),
                })),
                cx,
            );
            editor
        });
        cx.simulate_resize(size(px(900.), px(900.)));
        draw(cx);
        draw(cx);
        let (count, listed, items) = editor.update(cx, |e, _| {
            let book = e.book();
            (
                book.item_count(),
                e.list_state().item_count(),
                (0..book.item_count())
                    .map(|ix| book.item(ix))
                    .collect::<Vec<_>>(),
            )
        });
        assert_eq!(count, 7);
        assert_eq!(listed, 7);
        assert_eq!(items[3], Item::End(0));
        assert_eq!(items[6], Item::End(1));
        // Measured at their real heights.
        let heights = editor.update(cx, |e, _| e.heights());
        {
            let h = heights.borrow();
            assert_eq!(
                (h.height(0), h.height(3), h.height(4), h.height(6)),
                (120., 80., 120., 0.)
            );
            assert!(h.is_measured(0) && h.is_measured(3));
        }
        assert!(built.get() >= 2);

        // A press inside a head stays there: the caret does not move.
        editor.update_in(cx, |e, window, cx| e.select(1, 2..2, window, cx));
        cx.simulate_click(point(px(300.), px(60.)), Modifiers::default());
        draw(cx);
        assert_eq!(
            editor.update(cx, |e, _| (e.selection().chapter, e.selection().head)),
            (1, 2)
        );

        // A new paragraph in chapter one: its end moves along.
        editor.update_in(cx, |e, window, cx| {
            e.select(0, 3..3, window, cx);
            e.press_enter(window, cx);
        });
        draw(cx);
        let (end, item, listed) = editor.update(cx, |e, _| {
            let end = e.book().end_item(0).unwrap();
            (end, e.book().item(end), e.list_state().item_count())
        });
        assert_eq!((end, item, listed), (4, Item::End(0), 8));

        // Enter in the host's title hands over to the text.
        editor.update_in(cx, |e, window, cx| e.focus_chapter_start(1, window, cx));
        let (sel, focused) = editor.update_in(cx, |e, window, cx| {
            (
                (e.selection().chapter, e.selection().head),
                e.focus_handle(cx).is_focused(window),
            )
        });
        assert_eq!(sel, (1, 0));
        assert!(focused);
    }

    #[gpui::test]
    fn host_edits_undo_on_their_own_or_with_the_typing(cx: &mut TestAppContext) {
        use gpui::EntityInputHandler as _;

        use crate::{HostStep, schema::inline};

        let (editor, cx) = cx.add_window_view(|window, cx| {
            ProseEditor::new(book(), ProseStyle::default(), window, cx)
        });
        let text = |editor: &Entity<ProseEditor>, cx: &mut VisualTestContext| {
            editor.update(cx, |e, _| e.book().chapters[0].doc.plain_text())
        };
        editor.update_in(cx, |e, window, cx| {
            e.select(0, 3..3, window, cx);
            e.replace_text_in_range(None, "甲", window, cx);
        });
        // Derived from the typing (a link on 雨夜): undone with it.
        assert!(editor.update_in(cx, |e, window, cx| {
            e.edit_chapter(0, HostStep::JoinLast, window, cx, |doc| {
                doc.mark(0..2, inline::BOLD, true.into(), crate::text::ORIGIN_USER);
                None
            })
        }));
        assert_eq!(
            editor.update(cx, |e, _| e.selection().head),
            4,
            "caret kept"
        );
        // Its own step: a picker inserting a name, the caret after it.
        editor.update_in(cx, |e, window, cx| {
            e.edit_chapter(0, HostStep::Own, window, cx, |doc| {
                doc.replace(0..0, "乙", crate::text::ORIGIN_USER);
                Some(1)
            })
        });
        assert_eq!(text(&editor, cx), "乙雨夜。甲\n钟停了。\n");
        assert_eq!(editor.update(cx, |e, _| e.selection().head), 1);
        editor.update_in(cx, |e, window, cx| e.undo(window, cx));
        assert_eq!(text(&editor, cx), "雨夜。甲\n钟停了。\n");
        assert!(editor.update(cx, |e, _| e.marks_at(0, 0).has(inline::BOLD)));
        editor.update_in(cx, |e, window, cx| e.undo(window, cx));
        assert_eq!(text(&editor, cx), "雨夜。\n钟停了。\n");
        assert!(!editor.update(cx, |e, _| e.marks_at(0, 0).has(inline::BOLD)));
    }

    struct Page {
        editor: Entity<ProseEditor>,
        opacity: f32,
    }

    impl Render for Page {
        fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            div()
                .size_full()
                .opacity(self.opacity)
                .child(ProseEditor::element_at_opacity(
                    &self.editor,
                    self.opacity,
                    cx,
                ))
        }
    }

    #[gpui::test]
    fn a_fading_editor_is_drawn_afresh_until_it_holds_still(cx: &mut TestAppContext) {
        let built = Rc::new(Cell::new(0));
        let (page, cx) = cx.add_window_view(|window, cx| {
            let editor = cx.new(|cx| {
                let mut editor = ProseEditor::new(book(), ProseStyle::default(), window, cx);
                editor.set_slots(
                    Some(Rc::new(Slots {
                        built: built.clone(),
                    })),
                    cx,
                );
                editor
            });
            Page {
                editor,
                opacity: 0.2,
            }
        });
        cx.simulate_resize(size(px(900.), px(900.)));
        draw(cx);
        let frame = |opacity: f32, cx: &mut VisualTestContext| {
            page.update(cx, |p, cx| {
                p.opacity = opacity;
                cx.notify();
            });
            draw(cx);
            built.get()
        };
        // Held still: the editor's last frame is replayed (its heads are not
        // built again).
        let still = frame(0.2, cx);
        let again = frame(0.2, cx);
        assert_eq!(still, again, "replayed");
        // Fading: drawn afresh each frame the opacity moves.
        let faded = frame(0.6, cx);
        assert!(faded > again, "drawn afresh");
        let more = frame(1.0, cx);
        assert!(more > faded);
        // Still again: replayed once more after one fresh frame.
        let settled = frame(1.0, cx);
        assert_eq!(frame(1.0, cx), settled);
    }
}
