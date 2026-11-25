//! Editing actions: deleting by grapheme cluster, word and row; Enter;
//! paragraph kinds; inline-mark toggles; undo and redo across chapters;
//! plain-text copy, cut and paste. A selection across chapters is edited
//! chapter by chapter (`span.rs`); Enter and Backspace in list items have
//! their own rules (`lists.rs`).

use gpui::{ClipboardItem, Context, Window};
use loro::LoroValue;

use super::{
    Selection,
    actions::*,
    movement::{next_cluster, prev_cluster, word_end_after, word_start_before},
};
use crate::{
    ProseEditor,
    schema::{LINE_BREAK, block, inline},
    text::{BlockKind, Edit, ORIGIN_USER},
};

/// Block attributes lifted when converting a paragraph back to plain Body (`⌘0`).
const CLEAR_BLOCK_KEYS: &[&str] = &[
    block::HEADING,
    block::QUOTE,
    block::LIST,
    block::LIST_LEVEL,
    block::CHECKED,
    block::TODO,
    block::CODE_BLOCK,
    block::CALLOUT,
    block::RULE,
];

/// Inline formatting marks cleared by `SetBody` (`⌘0`); preserves `entity:*`, `link`, `embed`.
const CLEAR_INLINE_KEYS: &[&str] = &[
    inline::BOLD,
    inline::ITALIC,
    inline::UNDERLINE,
    inline::STRIKE,
    inline::CODE,
    inline::HIGHLIGHT,
];

/// Non-list block attributes lifted on Backspace at column 0.
const LIFT_ON_BACKSPACE_KEYS: &[&str] = &[
    block::HEADING,
    block::QUOTE,
    block::CALLOUT,
    block::CODE_BLOCK,
];

/// Container block attributes exited on Enter in an empty paragraph.
const EXIT_ON_EMPTY_ENTER_KEYS: &[&str] = &[block::QUOTE, block::CALLOUT, block::CODE_BLOCK];

impl ProseEditor {
    /// Deletes the selection, or the range from the caret to `target(doc, head)`.
    fn delete_towards(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
        target: impl FnOnce(&mut crate::text::ProseDoc, usize) -> usize,
    ) {
        if self.composition.is_some() || self.replace_across("", &[], window, cx) {
            return;
        }
        let sel = self.selection;
        let range = if sel.is_empty() {
            let doc = &mut self.book.chapters[sel.chapter].doc;
            let to = target(doc, sel.head).min(doc.max_cursor());
            sel.head.min(to)..sel.head.max(to)
        } else {
            sel.range()
        };
        // Next to or on an embed (`objects.rs`).
        if self.delete_at_embed(sel.chapter, range.clone(), sel.is_empty(), window, cx) {
            return;
        }
        self.edit(window, cx, |doc, sel| {
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
        // At a list item's start: out of the list first (`lists.rs`).
        if self.backspace_in_list(window, cx) || self.backspace_in_block(window, cx) {
            return;
        }
        self.delete_towards(window, cx, prev_cluster);
    }

    pub(crate) fn on_delete(&mut self, _: &Delete, window: &mut Window, cx: &mut Context<Self>) {
        if self.delete_at_rule(window, cx) {
            return;
        }
        self.delete_towards(window, cx, next_cluster);
    }

    /// Backspace on a horizontal rule, after a rule, or at column 0 of a
    /// heading, quote, callout or code block.
    fn backspace_in_block(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let sel = self.selection;
        if !sel.is_empty() || self.composition.is_some() {
            return false;
        }
        let doc = &self.book.chapters[sel.chapter].doc;
        let (line, inner) = doc.locate(sel.head);
        let para = doc.line(line);
        if para.block.get(block::RULE).is_some() {
            return self.remove_rule_line(line, window, cx);
        }
        if inner != 0 {
            return false;
        }
        let lift_keys: Vec<&'static str> = LIFT_ON_BACKSPACE_KEYS
            .iter()
            .copied()
            .filter(|&k| para.block.get(k).is_some())
            .collect();
        if !lift_keys.is_empty() {
            let nl = doc.line_start(line) + para.chars;
            self.edit(window, cx, |doc, _| {
                doc.checkpoint();
                let edits: Vec<Edit> = lift_keys
                    .iter()
                    .map(|&key| Edit::SetBlockAttr {
                        newline: nl,
                        key,
                        value: None,
                    })
                    .collect();
                doc.edit_batch(&edits, ORIGIN_USER);
            });
            return true;
        }
        if line > 0 && doc.line(line - 1).block.get(block::RULE).is_some() {
            let prev_start = doc.line_start(line - 1);
            self.edit(window, cx, |doc, sel| {
                doc.checkpoint();
                doc.delete(prev_start..prev_start + 1, ORIGIN_USER);
                *sel = Selection::caret(sel.chapter, prev_start);
            });
            return true;
        }
        false
    }

    /// Delete on a horizontal rule, or right before one.
    fn delete_at_rule(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let sel = self.selection;
        if !sel.is_empty() || self.composition.is_some() {
            return false;
        }
        let doc = &self.book.chapters[sel.chapter].doc;
        let (line, inner) = doc.locate(sel.head);
        if doc.line(line).block.get(block::RULE).is_some() {
            return self.remove_rule_line(line, window, cx);
        }
        if inner == doc.line(line).chars
            && line + 1 < doc.visible_lines()
            && doc.line(line + 1).block.get(block::RULE).is_some()
        {
            let next_start = doc.line_start(line + 1);
            let keep_caret = sel.head;
            if line + 2 < doc.visible_lines() {
                self.edit(window, cx, |doc, sel| {
                    doc.checkpoint();
                    doc.delete(next_start..next_start + 1, ORIGIN_USER);
                    *sel = Selection::caret(sel.chapter, keep_caret);
                });
            } else {
                self.edit(window, cx, |doc, sel| {
                    doc.checkpoint();
                    doc.delete(next_start - 1..next_start, ORIGIN_USER);
                    *sel = Selection::caret(sel.chapter, keep_caret);
                });
            }
            return true;
        }
        false
    }

    /// Removes horizontal-rule paragraph `line` cleanly.
    fn remove_rule_line(
        &mut self,
        line: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let sel = self.selection;
        let doc = &self.book.chapters[sel.chapter].doc;
        let start = doc.line_start(line);
        let visible = doc.visible_lines();
        if line + 1 < visible {
            self.edit(window, cx, |doc, sel| {
                doc.checkpoint();
                doc.delete(start..start + 1, ORIGIN_USER);
                *sel = Selection::caret(sel.chapter, start);
            });
        } else if line > 0 {
            let prev_end = start - 1;
            self.edit(window, cx, |doc, sel| {
                doc.checkpoint();
                doc.delete(prev_end..start, ORIGIN_USER);
                *sel = Selection::caret(sel.chapter, prev_end);
            });
        } else {
            self.edit(window, cx, |doc, sel| {
                doc.checkpoint();
                doc.set_block_attr(line, block::RULE, None, ORIGIN_USER);
                *sel = Selection::caret(sel.chapter, start);
            });
        }
        true
    }

    /// Ensures typing or pasting when the caret sits on a horizontal rule lands
    /// on a plain paragraph after it instead of turning the rule into text.
    pub(crate) fn leave_rule_for_text(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.composition.is_some() || !self.selection.is_empty() {
            return;
        }
        let sel = self.selection;
        let doc = &self.book.chapters[sel.chapter].doc;
        let (line, _) = doc.locate(sel.head);
        if doc.line(line).block.get(block::RULE).is_none() {
            return;
        }
        if line + 1 < doc.visible_lines()
            && doc.line(line + 1).chars == 0
            && doc.line(line + 1).block.get(block::RULE).is_none()
        {
            let next_start = doc.line_start(line + 1);
            self.set_selection(Selection::caret(sel.chapter, next_start), cx);
        } else {
            let at = doc.line_start(line) + doc.line(line).chars;
            self.edit(window, cx, |doc, sel| {
                doc.checkpoint();
                let caret = doc.split(at, ORIGIN_USER);
                let next_line = doc.line_of(caret);
                doc.set_block_attr(next_line, block::RULE, None, ORIGIN_USER);
                *sel = Selection::caret(sel.chapter, caret);
            });
        }
    }

    /// Enter inside a quote, callout, code block, or on a horizontal rule.
    fn newline_in_block(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let sel = self.selection;
        if !sel.is_empty() {
            return false;
        }
        let doc = &self.book.chapters[sel.chapter].doc;
        let (line, inner) = doc.locate(sel.head);
        let para = doc.line(line);
        if para.block.get(block::RULE).is_some() {
            let at = doc.line_start(line) + para.chars;
            self.edit(window, cx, |doc, sel| {
                doc.checkpoint();
                let caret = doc.split(at, ORIGIN_USER);
                let next = doc.line_of(caret);
                doc.set_block_attr(next, block::RULE, None, ORIGIN_USER);
                *sel = Selection::caret(sel.chapter, caret);
            });
            return true;
        }
        if para.chars == 0 {
            let exit_keys: Vec<&'static str> = EXIT_ON_EMPTY_ENTER_KEYS
                .iter()
                .copied()
                .filter(|&k| para.block.get(k).is_some())
                .collect();
            if !exit_keys.is_empty() {
                let nl = doc.line_start(line);
                self.edit(window, cx, |doc, _| {
                    doc.checkpoint();
                    let edits: Vec<Edit> = exit_keys
                        .iter()
                        .map(|&key| Edit::SetBlockAttr {
                            newline: nl,
                            key,
                            value: None,
                        })
                        .collect();
                    doc.edit_batch(&edits, ORIGIN_USER);
                });
                return true;
            }
        }
        if para.chars > 0
            && inner == para.chars
            && let Some(lang) = para.block.get(block::CODE_BLOCK).cloned()
        {
            let at = sel.head;
            self.edit(window, cx, |doc, sel| {
                doc.checkpoint();
                doc.edit_batch(
                    &[
                        Edit::Split { at },
                        Edit::SetBlockAttr {
                            newline: at + 1,
                            key: block::CODE_BLOCK,
                            value: Some(lang),
                        },
                    ],
                    ORIGIN_USER,
                );
                *sel = Selection::caret(sel.chapter, at + 1);
            });
            return true;
        }
        false
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
        if self.composition.is_some() || self.replace_across("", &[], window, cx) {
            return;
        }
        let target = if self.selection.is_empty() {
            let sel = self.selection;
            let (ix, inner) = self.book.chapters[sel.chapter].doc.locate(sel.head);
            if inner == 0 {
                sel.head.saturating_sub(1)
            } else if let Some((layout, _)) = self.line_layout(sel.chapter, ix, window) {
                let doc = &self.book.chapters[sel.chapter].doc;
                let line = doc.line(ix);
                let byte = line.byte_of_char(inner);
                let row_ix = layout.row_of(byte, sel.affinity);
                let row = &layout.rows[row_ix];
                if byte > row.start {
                    doc.line_start(ix) + line.char_of_byte(row.start)
                } else if row_ix > 0 {
                    doc.line_start(ix) + line.char_of_byte(layout.rows[row_ix - 1].start)
                } else {
                    doc.line_start(ix)
                }
            } else {
                self.book.chapters[sel.chapter].doc.line_start(ix)
            }
        } else {
            self.selection.range().start
        };
        self.delete_towards(window, cx, |_, _| target);
    }

    pub(crate) fn on_delete_to_line_end(
        &mut self,
        _: &DeleteToLineEnd,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.composition.is_some() || self.replace_across("", &[], window, cx) {
            return;
        }
        let target = if self.selection.is_empty() {
            let sel = self.selection;
            let (ix, inner) = self.book.chapters[sel.chapter].doc.locate(sel.head);
            let line_chars = self.book.chapters[sel.chapter].doc.line(ix).chars;
            if inner >= line_chars {
                (sel.head + 1).min(self.book.chapters[sel.chapter].doc.max_cursor())
            } else if let Some((layout, _)) = self.line_layout(sel.chapter, ix, window) {
                let doc = &self.book.chapters[sel.chapter].doc;
                let line = doc.line(ix);
                let byte = line.byte_of_char(inner);
                let row_ix = layout.row_of(byte, sel.affinity);
                let row = &layout.rows[row_ix];
                if byte < row.end {
                    doc.line_start(ix) + line.char_of_byte(row.end)
                } else if row_ix + 1 < layout.rows.len() {
                    doc.line_start(ix) + line.char_of_byte(layout.rows[row_ix + 1].end)
                } else {
                    doc.line_start(ix) + line.chars
                }
            } else {
                let doc = &self.book.chapters[sel.chapter].doc;
                doc.line_start(ix) + doc.line(ix).chars
            }
        } else {
            self.selection.range().end
        };
        self.delete_towards(window, cx, |_, _| target);
    }

    pub(crate) fn on_soft_newline(
        &mut self,
        _: &SoftNewline,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.composition.is_some() {
            return;
        }
        cx.emit(crate::AuthorTyped {
            chapter: self.selection.chapter,
        });
        self.leave_embed_for_text(&mut None, window, cx);
        self.leave_rule_for_text(window, cx);
        let overrides = std::mem::take(&mut self.pending_marks);
        let mut buf = [0u8; 4];
        let lb = LINE_BREAK.encode_utf8(&mut buf);
        if self.replace_across(lb, &overrides, window, cx) {
            return;
        }
        self.edit(window, cx, |doc, sel| {
            doc.checkpoint();
            let inserted = doc.replace_styled(sel.range(), lb, &overrides, ORIGIN_USER);
            *sel = Selection::caret(sel.chapter, inserted.end);
        });
    }

    pub(crate) fn on_newline(&mut self, _: &Newline, window: &mut Window, cx: &mut Context<Self>) {
        if self.composition.is_some() {
            return;
        }
        cx.emit(crate::AuthorTyped {
            chapter: self.selection.chapter,
        });
        self.pending_marks.clear();
        // In an empty list item: out of the list (`lists.rs`).
        if self.newline_in_list(window, cx) {
            return;
        }
        // An embed selected: a paragraph after it (`objects.rs`).
        if self.newline_at_embed(window, cx) {
            return;
        }
        // Quote, callout, code block, or horizontal rule rules.
        if self.newline_in_block(window, cx) {
            return;
        }
        // Across chapters: the selection goes first, as its own step (like a
        // selection across paragraphs below).
        self.replace_across("", &[], window, cx);
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
        if self.selection.spans_chapters() {
            self.set_kind_across(kind, window, cx);
            return;
        }
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
        self.pending_marks.clear();
        if self.selection.spans_chapters() {
            self.set_body_across(CLEAR_BLOCK_KEYS, CLEAR_INLINE_KEYS, window, cx);
            return;
        }
        self.edit(window, cx, |doc, sel| {
            let range = sel.range();
            let (first, _) = doc.locate(range.start);
            let (last, _) = doc.locate(range.end);
            let mut edits: Vec<Edit> = Vec::new();
            for line in first..=last {
                let para = doc.line(line);
                let nl = doc.line_start(line) + para.chars;
                for &key in CLEAR_BLOCK_KEYS {
                    if para.block.get(key).is_some() {
                        edits.push(Edit::SetBlockAttr {
                            newline: nl,
                            key,
                            value: None,
                        });
                    }
                }
            }
            if !range.is_empty() {
                for &key in CLEAR_INLINE_KEYS {
                    edits.push(Edit::Unmark {
                        range: range.clone(),
                        key,
                    });
                }
            }
            if !edits.is_empty() {
                doc.checkpoint();
                doc.edit_batch(&edits, ORIGIN_USER);
            }
        });
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
        self.toggle_mark_value(key, LoroValue::Bool(true), window, cx);
    }

    /// [`ProseEditor::toggle_mark`] for a mark whose value is not `true` (a
    /// note's highlight).
    pub fn toggle_mark_value(
        &mut self,
        key: &str,
        value: LoroValue,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
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
                .push((key.to_owned(), (!current).then_some(value)));
            cx.notify();
            return;
        }
        if self.selection.spans_chapters() {
            self.toggle_mark_across(key, value, window, cx);
            return;
        }
        let key = key.to_owned();
        self.edit(window, cx, |doc, sel| {
            doc.checkpoint();
            doc.toggle_mark_value(sel.range(), &key, value, ORIGIN_USER);
        });
    }

    /// Links the selection to `url`, or removes links from it.
    pub fn set_link(&mut self, url: Option<&str>, window: &mut Window, cx: &mut Context<Self>) {
        if self.selection.is_empty() || self.composition.is_some() {
            return;
        }
        if self.selection.spans_chapters() {
            self.set_link_across(url, window, cx);
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
        if sel.spans_chapters() {
            return self.mark_active_across(key);
        }
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
            // With the rest of its edit group, if it is part of an edit
            // across chapters.
            let result = self.undo_grouped(chapter, cx);
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
            let result = self.redo_grouped(chapter, cx);
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

    /// Copies the selection as plain text; across chapters, each chapter's
    /// part on its own line(s), in order.
    pub(crate) fn on_copy(&mut self, _: &Copy, _: &mut Window, cx: &mut Context<Self>) {
        if !self.selection.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(self.selected_text()));
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
        // Never over a selected embed or onto a horizontal rule (`objects.rs`).
        self.leave_embed_for_text(&mut None, window, cx);
        self.leave_rule_for_text(window, cx);
        self.pending_marks.clear();
        // Across chapters: one step per chapter, the text in the first.
        if self.replace_across(&text, &[], window, cx) {
            return;
        }
        self.edit(window, cx, |doc, sel| {
            doc.checkpoint();
            let inserted = doc.replace(sel.range(), &text, ORIGIN_USER);
            *sel = Selection::caret(sel.chapter, inserted.end);
        });
    }
}
