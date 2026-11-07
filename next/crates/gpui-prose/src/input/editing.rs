//! Editing actions: deleting by grapheme cluster, word and row; Enter;
//! paragraph kinds; inline-mark toggles; undo and redo across chapters;
//! plain-text copy, cut and paste.

use gpui::{ClipboardItem, Context, Window};
use loro::LoroValue;

use super::{
    Selection,
    actions::*,
    movement::{next_cluster, prev_cluster, word_end_after, word_start_before},
};
use crate::{
    ProseEditor,
    schema::inline,
    text::{BlockKind, ORIGIN_USER},
};

impl ProseEditor {
    /// Deletes the selection, or the range from the caret to `target(doc, head)`.
    fn delete_towards(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
        target: impl FnOnce(&mut crate::text::ProseDoc, usize) -> usize,
    ) {
        if self.composition.is_some() {
            return;
        }
        self.edit(window, cx, |doc, sel| {
            let range = if sel.is_empty() {
                let to = target(doc, sel.head).min(doc.max_cursor());
                sel.head.min(to)..sel.head.max(to)
            } else {
                sel.range()
            };
            if range.is_empty() {
                return;
            }
            // Joining paragraphs is its own undo step.
            if doc.slice(range.clone()).contains('\n') {
                doc.checkpoint();
            }
            doc.delete(range.clone(), ORIGIN_USER);
            *sel = Selection::caret(sel.chapter, range.start);
        });
    }

    pub(crate) fn on_backspace(
        &mut self,
        _: &Backspace,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.delete_towards(window, cx, prev_cluster);
    }

    pub(crate) fn on_delete(&mut self, _: &Delete, window: &mut Window, cx: &mut Context<Self>) {
        self.delete_towards(window, cx, next_cluster);
    }

    pub(crate) fn on_delete_word_backward(
        &mut self,
        _: &DeleteWordBackward,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.delete_towards(window, cx, word_start_before);
    }

    pub(crate) fn on_delete_word_forward(
        &mut self,
        _: &DeleteWordForward,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.delete_towards(window, cx, word_end_after);
    }

    pub(crate) fn on_delete_to_line_start(
        &mut self,
        _: &DeleteToLineStart,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.delete_towards(window, cx, |doc, head| {
            let (ix, inner) = doc.locate(head);
            if inner == 0 {
                head.saturating_sub(1)
            } else {
                doc.line_start(ix)
            }
        });
    }

    pub(crate) fn on_newline(&mut self, _: &Newline, window: &mut Window, cx: &mut Context<Self>) {
        if self.composition.is_some() {
            return;
        }
        self.pending_marks.clear();
        self.edit(window, cx, |doc, sel| {
            let range = sel.range();
            doc.checkpoint();
            if !range.is_empty() {
                doc.delete(range.clone(), ORIGIN_USER);
                doc.checkpoint();
            }
            let caret = doc.split(range.start, ORIGIN_USER);
            *sel = Selection::caret(sel.chapter, caret);
        });
    }

    fn set_kind(&mut self, kind: BlockKind, window: &mut Window, cx: &mut Context<Self>) {
        self.edit(window, cx, |doc, sel| {
            let range = sel.range();
            let (first, _) = doc.locate(range.start);
            let (last, _) = doc.locate(range.end);
            doc.checkpoint();
            for line in first..=last {
                doc.set_kind(line, kind, ORIGIN_USER);
            }
        });
    }

    pub(crate) fn on_set_body(&mut self, _: &SetBody, window: &mut Window, cx: &mut Context<Self>) {
        self.set_kind(BlockKind::Body, window, cx);
    }
    pub(crate) fn on_set_h1(&mut self, _: &SetH1, window: &mut Window, cx: &mut Context<Self>) {
        self.set_kind(BlockKind::H1, window, cx);
    }
    pub(crate) fn on_set_h2(&mut self, _: &SetH2, window: &mut Window, cx: &mut Context<Self>) {
        self.set_kind(BlockKind::H2, window, cx);
    }
    pub(crate) fn on_set_h3(&mut self, _: &SetH3, window: &mut Window, cx: &mut Context<Self>) {
        self.set_kind(BlockKind::H3, window, cx);
    }

    /// Toggles bold, italic, underline or strike: on the selection, or (with
    /// a bare caret) for the next typed text.
    pub fn toggle_mark(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.composition.is_some() {
            return;
        }
        if self.selection.is_empty() {
            let head = self.selection.head;
            let doc = &mut self.book.chapters[self.selection.chapter].doc;
            let current = match self.pending_marks.iter().find(|(k, _)| k == key) {
                Some((_, value)) => value.is_some(),
                None => doc.marks_before(head).has(key),
            };
            self.pending_marks.retain(|(k, _)| k != key);
            self.pending_marks
                .push((key.to_owned(), (!current).then_some(LoroValue::Bool(true))));
            cx.notify();
            return;
        }
        let key = key.to_owned();
        self.edit(window, cx, |doc, sel| {
            doc.checkpoint();
            doc.toggle_mark(sel.range(), &key, ORIGIN_USER);
        });
    }

    /// Links the selection to `url`, or removes links from it.
    pub fn set_link(&mut self, url: Option<&str>, window: &mut Window, cx: &mut Context<Self>) {
        if self.selection.is_empty() || self.composition.is_some() {
            return;
        }
        self.edit(window, cx, |doc, sel| {
            doc.checkpoint();
            doc.set_link(sel.range(), url, ORIGIN_USER);
        });
    }

    /// Whether `key` is on at the caret or over the whole selection, counting
    /// a caret's pending toggles (for a toolbar's pressed state).
    pub fn mark_active(&mut self, key: &str) -> bool {
        let sel = self.selection;
        let doc = &mut self.book.chapters[sel.chapter].doc;
        if sel.is_empty() {
            match self.pending_marks.iter().find(|(k, _)| k == key) {
                Some((_, value)) => value.is_some(),
                None => doc.marks_before(sel.head).has(key),
            }
        } else {
            doc.range_has_mark(sel.range(), key)
        }
    }

    pub(crate) fn on_toggle_bold(
        &mut self,
        _: &ToggleBold,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.toggle_mark(inline::BOLD, window, cx);
    }
    pub(crate) fn on_toggle_italic(
        &mut self,
        _: &ToggleItalic,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.toggle_mark(inline::ITALIC, window, cx);
    }
    pub(crate) fn on_toggle_underline(
        &mut self,
        _: &ToggleUnderline,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.toggle_mark(inline::UNDERLINE, window, cx);
    }
    pub(crate) fn on_toggle_strikethrough(
        &mut self,
        _: &ToggleStrikethrough,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.toggle_mark(inline::STRIKE, window, cx);
    }

    /// Undo across chapters: the most recent author step in any chapter.
    /// Ignored while composing (the marked text belongs to the input method).
    pub fn undo(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.composition.is_some() {
            return;
        }
        while let Some(chapter) = self.undo_chapters.pop() {
            self.own_edit = true;
            let result = self.book.chapters[chapter].doc.undo();
            self.sync_chapter(chapter, cx);
            self.own_edit = false;
            if let Some(cursor) = result {
                self.redo_chapters.push(chapter);
                if let Some(cursor) = cursor {
                    self.selection = Selection::caret(chapter, cursor);
                    self.clamp_selection();
                }
                self.after_history_step(chapter, window, cx);
                return;
            }
        }
    }

    pub fn redo(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.composition.is_some() {
            return;
        }
        while let Some(chapter) = self.redo_chapters.pop() {
            self.own_edit = true;
            let result = self.book.chapters[chapter].doc.redo();
            self.sync_chapter(chapter, cx);
            self.own_edit = false;
            if let Some(cursor) = result {
                self.undo_chapters.push(chapter);
                if let Some(cursor) = cursor {
                    self.selection = Selection::caret(chapter, cursor);
                    self.clamp_selection();
                }
                self.after_history_step(chapter, window, cx);
                return;
            }
        }
    }

    pub(crate) fn on_undo(&mut self, _: &Undo, window: &mut Window, cx: &mut Context<Self>) {
        self.undo(window, cx);
    }

    pub(crate) fn on_redo(&mut self, _: &Redo, window: &mut Window, cx: &mut Context<Self>) {
        self.redo(window, cx);
    }

    pub(crate) fn on_copy(&mut self, _: &Copy, _: &mut Window, cx: &mut Context<Self>) {
        let sel = self.selection;
        if !sel.is_empty() {
            let text = self.book.chapters[sel.chapter].doc.slice(sel.range());
            cx.write_to_clipboard(ClipboardItem::new_string(text));
        }
    }

    pub(crate) fn on_cut(&mut self, _: &Cut, window: &mut Window, cx: &mut Context<Self>) {
        self.on_copy(&Copy, window, cx);
        if !self.selection.is_empty() {
            self.on_backspace(&Backspace, window, cx);
        }
    }

    pub(crate) fn on_paste(&mut self, _: &Paste, window: &mut Window, cx: &mut Context<Self>) {
        let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) else {
            return;
        };
        self.paste_text(&text, window, cx);
    }

    /// Pastes plain text; line breaks become paragraphs with fresh block ids.
    pub fn paste_text(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.composition.is_some() {
            return;
        }
        let text = text.replace("\r\n", "\n").replace('\r', "\n");
        self.pending_marks.clear();
        self.edit(window, cx, |doc, sel| {
            doc.checkpoint();
            let inserted = doc.replace(sel.range(), &text, ORIGIN_USER);
            *sel = Selection::caret(sel.chapter, inserted.end);
        });
    }
}
