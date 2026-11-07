//! Mouse: click to place the caret, shift-click to extend, double click to
//! select a word (ICU), triple click to select a paragraph, drag to select
//! (scrolling when dragged past the edge).

use gpui::{Context, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, Window};

use super::Selection;
use crate::{ProseEditor, text::segment};

impl ProseEditor {
    pub(crate) fn on_mouse_down(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        window.focus(&self.focus, cx);
        let Some((chapter, offset)) = self.hit_test(event.position) else {
            return;
        };
        let mut sel = if event.modifiers.shift && chapter == self.selection.chapter {
            let mut sel = self.selection;
            sel.head = offset;
            sel
        } else {
            Selection::caret(chapter, offset)
        };
        match event.click_count {
            2 => {
                let word = self.word_range_at(chapter, offset);
                sel.anchor = word.start;
                sel.head = word.end;
            }
            n if n >= 3 => {
                let doc = &mut self.book.chapters[chapter].doc;
                let (line, _) = doc.locate(offset);
                sel.anchor = doc.line_start(line);
                sel.head = sel.anchor + doc.line(line).chars;
            }
            _ => {}
        }
        self.selecting = true;
        self.set_selection_with(sel, false, cx);
    }

    /// The word (by ICU, Chinese words from its dictionary) around `offset`:
    /// what a double click selects.
    pub fn word_range_at(&mut self, chapter: usize, offset: usize) -> std::ops::Range<usize> {
        let doc = &mut self.book.chapters[chapter].doc;
        let (line, inner) = doc.locate(offset);
        let start = doc.line_start(line);
        let line = doc.line(line);
        let word = segment::word_range(&line.text, line.byte_of_char(inner));
        start + line.char_of_byte(word.start)..start + line.char_of_byte(word.end)
    }

    pub(crate) fn on_mouse_move(
        &mut self,
        event: &MouseMoveEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.selecting || event.pressed_button != Some(MouseButton::Left) {
            return;
        }
        if let Some((chapter, offset)) = self.hit_test(event.position) {
            let head = if chapter == self.selection.chapter {
                offset
            } else if chapter > self.selection.chapter {
                self.book.chapters[self.selection.chapter].doc.max_cursor()
            } else {
                0
            };
            if head != self.selection.head {
                self.selection.head = head;
                self.emit_selection_changed(cx);
                cx.notify();
            }
        }
        // Dragged past the edge: scroll so the selection can grow.
        let viewport = self.list.viewport_bounds();
        let delta = if event.position.y < viewport.top() {
            f64::from(f32::from(event.position.y - viewport.top()))
        } else if event.position.y > viewport.bottom() {
            f64::from(f32::from(event.position.y - viewport.bottom()))
        } else {
            0.
        };
        if delta != 0. {
            self.scroll_by_estimate(delta, cx);
        }
    }

    pub(crate) fn on_mouse_up(&mut self, _: &MouseUpEvent, _: &mut Window, _: &mut Context<Self>) {
        self.selecting = false;
    }
}
