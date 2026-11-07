//! Mouse: click to place the caret, shift-click to extend, double click to
//! select a word (ICU), triple click to select a paragraph, drag to select
//! (scrolling when dragged past the edge).
//!
//! A drag keeps the unit of the click that started it: after a double click
//! the selection grows word by word, after a triple click paragraph by
//! paragraph, always keeping the whole first word (or paragraph) and
//! reaching the far edge of the one under the pointer, in either direction.

use std::ops::Range;

use gpui::{Context, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, Window};

use super::Selection;
use crate::{ProseEditor, text::segment};

/// What a drag selects by.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Granularity {
    Character,
    Word,
    Paragraph,
}

impl Granularity {
    pub fn of_clicks(click_count: usize) -> Granularity {
        match click_count {
            0 | 1 => Granularity::Character,
            2 => Granularity::Word,
            _ => Granularity::Paragraph,
        }
    }
}

/// The unit a drag extends by and the unit it started on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DragUnit {
    pub granularity: Granularity,
    pub chapter: usize,
    pub initial: Range<usize>,
}

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
        self.click_at(
            chapter,
            offset,
            event.click_count,
            event.modifiers.shift,
            cx,
        );
    }

    /// A press at `offset`: places the caret, or selects the word or
    /// paragraph there and remembers it for the drag; shift extends.
    pub fn click_at(
        &mut self,
        chapter: usize,
        offset: usize,
        click_count: usize,
        shift: bool,
        cx: &mut Context<Self>,
    ) {
        let granularity = Granularity::of_clicks(click_count);
        let sel = if shift && chapter == self.selection.chapter {
            let mut sel = self.selection;
            sel.head = offset;
            self.input.drag = None;
            sel
        } else {
            let unit = self.unit_range(chapter, offset, granularity);
            self.input.drag = (granularity != Granularity::Character).then(|| DragUnit {
                granularity,
                chapter,
                initial: unit.clone(),
            });
            Selection::new(chapter, unit.start, unit.end)
        };
        self.selecting = true;
        self.set_selection_with(sel, false, cx);
    }

    /// The pointer dragged to `offset` (in the selection's chapter).
    pub fn drag_to(&mut self, offset: usize, cx: &mut Context<Self>) {
        let sel = self.drag_selection(offset);
        if sel.anchor != self.selection.anchor || sel.head != self.selection.head {
            self.selection.anchor = sel.anchor;
            self.selection.head = sel.head;
            self.emit_selection_changed(cx);
            cx.notify();
        }
    }

    /// The button went up: the drag is over.
    pub fn release(&mut self) {
        self.selecting = false;
        self.input.drag = None;
    }

    /// The word (by ICU, Chinese words from its dictionary) around `offset`:
    /// what a double click selects.
    pub fn word_range_at(&mut self, chapter: usize, offset: usize) -> Range<usize> {
        let doc = &mut self.book.chapters[chapter].doc;
        let (line, inner) = doc.locate(offset);
        let start = doc.line_start(line);
        let line = doc.line(line);
        let word = segment::word_range(&line.text, line.byte_of_char(inner));
        start + line.char_of_byte(word.start)..start + line.char_of_byte(word.end)
    }

    /// The paragraph around `offset`, without its line break: what a triple
    /// click selects.
    pub fn paragraph_range_at(&mut self, chapter: usize, offset: usize) -> Range<usize> {
        let doc = &mut self.book.chapters[chapter].doc;
        let (line, _) = doc.locate(offset);
        let start = doc.line_start(line);
        start..start + doc.line(line).chars
    }

    fn unit_range(&mut self, chapter: usize, offset: usize, unit: Granularity) -> Range<usize> {
        match unit {
            Granularity::Character => offset..offset,
            Granularity::Word => self.word_range_at(chapter, offset),
            Granularity::Paragraph => self.paragraph_range_at(chapter, offset),
        }
    }

    /// The selection a drag to `offset` makes: by characters from the click,
    /// or by the click's unit, keeping the first unit whole.
    fn drag_selection(&mut self, offset: usize) -> Selection {
        let Some(drag) = self.input.drag.clone() else {
            let mut sel = self.selection;
            sel.head = offset;
            return sel;
        };
        let under = self.unit_range(drag.chapter, offset, drag.granularity);
        let initial = drag.initial;
        if under.start < initial.start {
            Selection::new(drag.chapter, initial.end, under.start)
        } else {
            Selection::new(drag.chapter, initial.start, under.end.max(initial.end))
        }
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
            let offset = if chapter == self.selection.chapter {
                offset
            } else if chapter > self.selection.chapter {
                self.book.chapters[self.selection.chapter].doc.max_cursor()
            } else {
                0
            };
            self.drag_to(offset, cx);
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
        self.release();
    }
}
