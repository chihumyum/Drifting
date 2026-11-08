//! Selections across chapters (the whole-book view): what is selected in
//! each chapter, copying, and edits that go chapter by chapter.
//!
//! Every chapter is its own document with its own undo history, so an edit
//! of a selection across chapters is one step in each chapter it touches,
//! never a move of text from one chapter into another: the first chapter
//! loses its part from the start of the selection to its end (and gets the
//! typed or pasted text there), the chapters in between are emptied, the
//! last chapter loses its part up to the selection's end. The steps are
//! tagged as one edit group ([`crate::ProseDoc::tag_last_step`]); undoing
//! the newest step of a chapter undoes the group's steps in the other
//! chapters too, where each is still that chapter's newest step (a chapter
//! edited since keeps its step for its own undo). The rule is written down
//! in `docs/rust-rewrite/foundations/f4c-input.md` (第三轮：跨章选区).

use std::ops::Range;

use gpui::{Context, Window};

use super::Selection;
use crate::{
    EditorEvent, ProseEditor,
    layout::BookPos,
    text::{BlockKind, MarkOverride, ORIGIN_USER, ProseDoc},
};

impl ProseEditor {
    /// What the selection covers in `chapter`, if anything: the range, and
    /// whether it runs on past the range's end (through the paragraph's
    /// line break, or past the chapter's end into the next chapter).
    pub fn selected_in(&self, chapter: usize) -> Option<(Range<usize>, bool)> {
        let sel = self.selection;
        if sel.is_empty() {
            return None;
        }
        let (start, end) = (sel.start(), sel.end());
        if chapter < start.chapter || chapter > end.chapter {
            return None;
        }
        let doc = &self.book.chapters.get(chapter)?.doc;
        let max = doc.max_cursor();
        let from = if chapter == start.chapter {
            start.offset.min(max)
        } else {
            0
        };
        let (to, beyond) = if chapter == end.chapter {
            (end.offset.min(max), false)
        } else {
            (max, true)
        };
        Some((from..to.max(from), beyond))
    }

    /// The selected text: one chapter's slice, or each chapter's part joined
    /// by a line break ([`crate::Book::text_in`]).
    pub fn selected_text(&self) -> String {
        let sel = self.selection;
        if sel.spans_chapters() {
            self.book.text_in(sel.book_range())
        } else {
            self.book.chapters[sel.chapter].doc.slice(sel.range())
        }
    }

    /// Selects from `anchor` to `head` (possibly across chapters) and
    /// reveals the head.
    pub fn select_across(
        &mut self,
        anchor: BookPos,
        head: BookPos,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let n = self.book.chapters.len();
        if anchor.chapter >= n || head.chapter >= n {
            return;
        }
        self.cancel_composition();
        self.set_selection(Selection::across(anchor, head), cx);
    }

    fn next_edit_group(&mut self) -> u64 {
        self.input.edit_groups += 1;
        self.input.edit_groups
    }

    /// Runs `f` on each chapter's part of the selection (in order; the index
    /// counts the parts), each as a step of its own in its chapter, tagged
    /// as one edit group. Returns the chapters that got a step. The caller
    /// places the selection, then calls [`ProseEditor::after_across`].
    fn edit_across(
        &mut self,
        cx: &mut Context<Self>,
        mut f: impl FnMut(&mut ProseDoc, Range<usize>, usize),
    ) -> Vec<usize> {
        let parts = self.book.split_range(self.selection.book_range());
        let group = self.next_edit_group();
        let mut touched = Vec::new();
        self.own_edit = true;
        for (ix, (chapter, range)) in parts.into_iter().enumerate() {
            let doc = &mut self.book.chapters[chapter].doc;
            let before = doc.undo_count();
            doc.checkpoint();
            f(doc, range, ix);
            if doc.undo_count() != before {
                doc.tag_last_step(group);
                self.undo_chapters.push(chapter);
                touched.push(chapter);
            }
            self.sync_chapter(chapter, cx);
        }
        self.own_edit = false;
        if !touched.is_empty() {
            self.redo_chapters.clear();
        }
        touched
    }

    /// After an edit across chapters: like the end of a single-chapter edit,
    /// for each chapter it touched.
    fn after_across(&mut self, touched: &[usize], window: &mut Window, cx: &mut Context<Self>) {
        self.selection.goal_x = None;
        self.clamp_selection();
        self.reveal_cursor();
        self.reset_blink(cx);
        window.notify_text_input_changed(&self.focus);
        for &chapter in touched {
            cx.emit(EditorEvent::Edited { chapter });
        }
        self.emit_selection_changed(cx);
        cx.notify();
        self.present_now(window);
    }

    /// Replaces a selection across chapters with `text` (empty: deletes it),
    /// chapter by chapter; the caret ends after the text, in the first
    /// chapter. Returns false (and does nothing) for a selection inside one
    /// chapter.
    pub(crate) fn replace_across(
        &mut self,
        text: &str,
        overrides: &[MarkOverride],
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if !self.selection.spans_chapters() || self.composition.is_some() {
            return false;
        }
        let start = self.selection.start();
        let mut caret = start.offset;
        let touched = self.edit_across(cx, |doc, range, ix| {
            if ix == 0 {
                caret = doc
                    .replace_styled(range.clone(), text, overrides, ORIGIN_USER)
                    .end;
            } else if !range.is_empty() {
                doc.delete(range, ORIGIN_USER);
            }
        });
        self.pending_marks.clear();
        self.selection = Selection::caret(start.chapter, caret);
        self.after_across(&touched, window, cx);
        true
    }

    /// Toggles an inline mark over a selection across chapters: off where
    /// every chapter's part already has it, else on everywhere.
    pub(crate) fn toggle_mark_across(
        &mut self,
        key: &str,
        value: loro::LoroValue,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let on = !self.mark_active(key);
        let touched = self.edit_across(cx, |doc, range, _| {
            if range.is_empty() {
                return;
            }
            if on {
                doc.mark(range, key, value.clone(), ORIGIN_USER);
            } else {
                doc.unmark(range, key, ORIGIN_USER);
            }
        });
        self.after_across(&touched, window, cx);
    }

    /// Sets or removes a link over a selection across chapters.
    pub(crate) fn set_link_across(
        &mut self,
        url: Option<&str>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let touched = self.edit_across(cx, |doc, range, _| {
            if !range.is_empty() {
                doc.set_link(range, url, ORIGIN_USER);
            }
        });
        self.after_across(&touched, window, cx);
    }

    /// Sets the kind of every paragraph a selection across chapters touches.
    pub(crate) fn set_kind_across(
        &mut self,
        kind: BlockKind,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let touched = self.edit_across(cx, |doc, range, _| {
            let (first, _) = doc.locate(range.start);
            let (last, _) = doc.locate(range.end);
            for line in first..=last {
                doc.set_kind(line, kind, ORIGIN_USER);
            }
        });
        self.after_across(&touched, window, cx);
    }

    /// Whether every chapter's part of a selection across chapters has
    /// `key` (the toolbar's pressed state).
    pub(crate) fn mark_active_across(&mut self, key: &str) -> bool {
        let parts = self.book.split_range(self.selection.book_range());
        let mut any = false;
        for (chapter, range) in parts {
            if range.is_empty() {
                continue;
            }
            any = true;
            if !self.book.chapters[chapter].doc.range_has_mark(range, key) {
                return false;
            }
        }
        any
    }

    // ----- undo by edit group ---------------------------------------------------

    /// Undoes `chapter`'s newest step and, when it belongs to an edit across
    /// chapters, the same edit's steps in the other chapters that are still
    /// their chapter's newest. Returns `chapter`'s result (see
    /// [`ProseDoc::undo`]); the other chapters move from the undo list to
    /// the redo list here.
    pub(crate) fn undo_grouped(
        &mut self,
        chapter: usize,
        cx: &mut Context<Self>,
    ) -> Option<Option<usize>> {
        let group = self.book.chapters[chapter].doc.last_step_group();
        self.own_edit = true;
        let result = self.book.chapters[chapter].doc.undo();
        self.sync_chapter(chapter, cx);
        if result.is_some()
            && let Some(group) = group
        {
            for other in 0..self.book.chapters.len() {
                if other == chapter
                    || self.book.chapters[other].doc.last_step_group() != Some(group)
                    || self.book.chapters[other].doc.undo().is_none()
                {
                    continue;
                }
                self.sync_chapter(other, cx);
                if let Some(at) = self.undo_chapters.iter().rposition(|c| *c == other) {
                    self.undo_chapters.remove(at);
                }
                self.redo_chapters.push(other);
                cx.emit(EditorEvent::Edited { chapter: other });
            }
        }
        self.own_edit = false;
        result
    }

    /// Redoes `chapter`'s next undone step and the rest of its edit group;
    /// see [`ProseEditor::undo_grouped`].
    pub(crate) fn redo_grouped(
        &mut self,
        chapter: usize,
        cx: &mut Context<Self>,
    ) -> Option<Option<usize>> {
        let group = self.book.chapters[chapter].doc.next_redo_group();
        self.own_edit = true;
        let result = self.book.chapters[chapter].doc.redo();
        self.sync_chapter(chapter, cx);
        if result.is_some()
            && let Some(group) = group
        {
            for other in 0..self.book.chapters.len() {
                if other == chapter
                    || self.book.chapters[other].doc.next_redo_group() != Some(group)
                    || self.book.chapters[other].doc.redo().is_none()
                {
                    continue;
                }
                self.sync_chapter(other, cx);
                if let Some(at) = self.redo_chapters.iter().rposition(|c| *c == other) {
                    self.redo_chapters.remove(at);
                }
                self.undo_chapters.push(other);
                cx.emit(EditorEvent::Edited { chapter: other });
            }
        }
        self.own_edit = false;
        result
    }
}
