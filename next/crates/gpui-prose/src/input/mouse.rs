//! Mouse: click to place the caret, shift-click to extend, double click to
//! select a word (ICU), triple click to select a paragraph, drag to select
//! (scrolling when dragged past the edge).
//!
//! A drag keeps the unit of the click that started it: after a double click
//! the selection grows word by word, after a triple click paragraph by
//! paragraph, always keeping the whole first word (or paragraph) and
//! reaching the far edge of the one under the pointer, in either direction.
//!
//! In the whole-book view a drag or a shift-click may cross into other
//! chapters: the selection then spans chapters (`span.rs`). Titles and the
//! host's chapter heads and ends are not text; dragging over them selects
//! up to the nearest paragraph.

use std::ops::Range;

use gpui::{Context, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, Window};

use super::Selection;
use crate::{ProseEditor, layout::BookPos, text::segment};

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
        let sel = if shift {
            // Possibly into another chapter: a selection across chapters.
            let mut sel = self.selection;
            sel.chapter = chapter;
            sel.head = offset;
            sel.goal_x = None;
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

    /// The pointer dragged to `offset` in the chapter the drag started in.
    pub fn drag_to(&mut self, offset: usize, cx: &mut Context<Self>) {
        self.drag_to_in(self.selection.anchor_chapter, offset, cx);
    }

    /// The pointer dragged to `offset` of `chapter` (any chapter of the
    /// book: the selection then spans chapters).
    pub fn drag_to_in(&mut self, chapter: usize, offset: usize, cx: &mut Context<Self>) {
        if chapter >= self.book.chapters.len() {
            return;
        }
        let sel = self.drag_selection(chapter, offset);
        if (sel.anchor_pos(), sel.head_pos())
            != (self.selection.anchor_pos(), self.selection.head_pos())
        {
            self.selection.anchor_chapter = sel.anchor_chapter;
            self.selection.anchor = sel.anchor;
            self.selection.chapter = sel.chapter;
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

    /// The selection a drag to `offset` of `chapter` makes: by characters
    /// from the click, or by the click's unit, keeping the first unit whole.
    fn drag_selection(&mut self, chapter: usize, offset: usize) -> Selection {
        let Some(drag) = self.input.drag.clone() else {
            let mut sel = self.selection;
            sel.chapter = chapter;
            sel.head = offset;
            return sel;
        };
        let under = self.unit_range(chapter, offset, drag.granularity);
        let initial = drag.initial;
        let pos = |chapter, offset| BookPos { chapter, offset };
        if pos(chapter, under.start) < pos(drag.chapter, initial.start) {
            Selection::across(pos(drag.chapter, initial.end), pos(chapter, under.start))
        } else {
            let end = if chapter == drag.chapter {
                under.end.max(initial.end)
            } else {
                under.end
            };
            Selection::across(pos(drag.chapter, initial.start), pos(chapter, end))
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
            self.drag_to_in(chapter, offset, cx);
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
