//! The caret around embeds (see [`crate::embeds`]): an embed paragraph is
//! one thing to select, step over and delete, and is never replaced by a
//! keystroke. Only while the host draws embeds ([`ProseEditor::set_embed_views`]);
//! without it they are text like any other paragraph.

use std::ops::Range;

use gpui::{Context, Window};

use super::Selection;
use crate::{ProseEditor, text::ORIGIN_USER};

impl ProseEditor {
    fn draws_embeds(&self) -> bool {
        self.embeds.is_some()
    }

    fn is_embed(&self, chapter: usize, line: usize) -> bool {
        self.book.chapters[chapter]
            .doc
            .lines()
            .get(line)
            .is_some_and(|l| l.embed().is_some())
    }

    /// A caret that landed in an embed paragraph selects the embed (called
    /// wherever the selection is clamped).
    pub(crate) fn select_embed_under_caret(&mut self) {
        if !self.draws_embeds() || !self.selection.is_empty() {
            return;
        }
        let chapter = self.selection.chapter;
        let doc = &self.book.chapters[chapter].doc;
        let line = doc.line_of(self.selection.head);
        if line < doc.visible_lines() && doc.lines()[line].embed().is_some() {
            let start = doc.line_start(line);
            self.selection.anchor = start;
            self.selection.head = start + 1;
        }
    }

    /// ← ↑ (`forward` false) or → ↓ from a selected embed: the caret goes to
    /// the end of the paragraph before it or the start of the one after it.
    /// Returns whether the key was taken.
    pub(crate) fn step_off_embed(&mut self, forward: bool, cx: &mut Context<Self>) -> bool {
        if !self.draws_embeds() {
            return false;
        }
        let Some((chapter, line)) = self.selected_embed() else {
            return false;
        };
        let doc = &self.book.chapters[chapter].doc;
        let start = doc.line_start(line);
        let visible = doc.visible_lines();
        let to = if forward {
            if line + 1 < visible {
                Some((chapter, start + 2))
            } else if chapter + 1 < self.book.chapters.len() {
                Some((chapter + 1, 0))
            } else {
                None
            }
        } else if line > 0 {
            Some((chapter, start - 1))
        } else if chapter > 0 {
            Some((
                chapter - 1,
                self.book.chapters[chapter - 1].doc.max_cursor(),
            ))
        } else {
            None
        };
        // At the text's edge the embed stays selected.
        if let Some((chapter, offset)) = to {
            self.set_selection(Selection::caret(chapter, offset), cx);
        }
        true
    }

    /// ↑ ↓ arriving at embed paragraph `line`: the host may take the caret
    /// inside it. Returns whether it did.
    pub(crate) fn enter_embed(
        &mut self,
        chapter: usize,
        line: usize,
        from_below: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(views) = self.embeds.clone() else {
            return false;
        };
        let Some((id, _)) = self.embed_at(chapter, line) else {
            return false;
        };
        views.enter(chapter, &id, from_below, window, cx)
    }

    /// Backspace or Delete next to or on an embed. `range` is what the key
    /// would delete (`was_caret`: from a bare caret at its start or end).
    /// Returns whether the embed rule took the key.
    pub(crate) fn delete_at_embed(
        &mut self,
        chapter: usize,
        range: Range<usize>,
        was_caret: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if !self.draws_embeds() {
            return false;
        }
        if !was_caret {
            let Some((chapter, line)) = self.selected_embed() else {
                return false;
            };
            self.delete_embed_paragraph(chapter, line, window, cx);
            return true;
        }
        let doc = &self.book.chapters[chapter].doc;
        let (first, _) = doc.locate(range.start);
        let (last, _) = doc.locate(range.end);
        if first == last {
            return false;
        }
        let backward = self.selection.head == range.end;
        // The paragraph the caret is in and the embed it would join.
        let (here, embed) = if backward {
            (last, last - 1)
        } else {
            (first, first + 1)
        };
        if !self.is_embed(chapter, embed) {
            return false;
        }
        let doc = &self.book.chapters[chapter].doc;
        let empty = doc.lines()[here].chars == 0;
        // An empty paragraph between the caret and the embed goes first (not
        // the text's last paragraph: its newline is never deleted).
        let drop_here = empty && here + 1 < doc.visible_lines();
        let here_start = doc.line_start(here);
        self.edit(window, cx, |doc, sel| {
            let mut embed_line = embed;
            if drop_here {
                doc.checkpoint();
                doc.delete(here_start..here_start + 1, ORIGIN_USER);
                if !backward {
                    embed_line = here;
                }
            }
            let start = doc.line_start(embed_line);
            *sel = Selection::new(sel.chapter, start, start + 1);
        });
        true
    }

    /// Deletes embed paragraph `line` whole: the caret goes to the start of
    /// the paragraph after it, else the end of the one before it.
    fn delete_embed_paragraph(
        &mut self,
        chapter: usize,
        line: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if chapter != self.selection.chapter {
            return;
        }
        let doc = &self.book.chapters[chapter].doc;
        let start = doc.line_start(line);
        let (range, caret) = if line + 1 < doc.visible_lines() {
            (start..start + 2, start)
        } else if line > 0 {
            (start - 1..start + 1, start - 1)
        } else {
            (start..start + 1, start)
        };
        self.edit(window, cx, |doc, sel| {
            doc.checkpoint();
            doc.delete(range, ORIGIN_USER);
            *sel = Selection::caret(sel.chapter, caret);
        });
    }

    /// Enter with an embed selected: an empty paragraph after it, the caret
    /// in it. Returns whether the key was taken.
    pub(crate) fn newline_at_embed(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if !self.draws_embeds() {
            return false;
        }
        let Some((chapter, line)) = self.selected_embed() else {
            return false;
        };
        if chapter != self.selection.chapter {
            return false;
        }
        let start = self.book.chapters[chapter].doc.line_start(line);
        self.edit(window, cx, |doc, sel| {
            doc.checkpoint();
            let caret = doc.split(start + 1, ORIGIN_USER);
            *sel = Selection::caret(sel.chapter, caret);
        });
        true
    }

    /// Text arriving with an embed selected (typing, an input method, a
    /// paste) goes into a new paragraph after the embed, not over it. A
    /// `range16` naming the embed is dropped (the caret's place is meant).
    pub(crate) fn leave_embed_for_text(
        &mut self,
        range16: &mut Option<Range<usize>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.composition.is_some() {
            return;
        }
        let Some((chapter, line)) = self.selected_embed() else {
            return;
        };
        let doc = &mut self.book.chapters[chapter].doc;
        let start = doc.line_start(line);
        let embed16 = doc.offset_to_utf16(start)..doc.offset_to_utf16(start + 1);
        match range16 {
            Some(r) if *r == embed16 => *range16 = None,
            Some(_) => return,
            None => {}
        }
        self.newline_at_embed(window, cx);
    }
}
