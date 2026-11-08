//! Caret movement: by grapheme cluster, by word (ICU), by visual row, to row
//! and chapter edges, and into neighbouring chapters in the book view. With
//! ⇧ the head crosses chapter boundaries too (←/→, ⌥←/⌥→ and ↑/↓): the
//! selection then spans chapters (`span.rs`).

use gpui::{Context, Window};

use super::{Selection, actions::*};
use crate::{
    ProseEditor,
    layout::Affinity,
    text::{ProseDoc, segment},
};

/// The offset one grapheme cluster after `offset` (crossing a newline is one step).
pub(crate) fn next_cluster(doc: &mut ProseDoc, offset: usize) -> usize {
    let (ix, inner) = doc.locate(offset);
    let line = doc.line(ix);
    if inner >= line.chars {
        return offset + 1;
    }
    let byte = line.byte_of_char(inner);
    let next = segment::next_grapheme(&line.text, byte);
    offset + line.char_of_byte(next) - inner
}

/// The offset one grapheme cluster before `offset`.
pub(crate) fn prev_cluster(doc: &mut ProseDoc, offset: usize) -> usize {
    let (ix, inner) = doc.locate(offset);
    if inner == 0 {
        return offset.saturating_sub(1);
    }
    let line = doc.line(ix);
    let byte = line.byte_of_char(inner);
    let prev = segment::prev_grapheme(&line.text, byte);
    offset - (inner - line.char_of_byte(prev))
}

/// Where ⌥→ lands from `offset`: the end of the next word, looking into
/// later paragraphs if this one has none; the chapter end if none follows.
pub(crate) fn word_end_after(doc: &mut ProseDoc, offset: usize) -> usize {
    let (mut ix, inner) = doc.locate(offset);
    let mut byte = doc.line(ix).byte_of_char(inner);
    let visible = doc.visible_lines();
    while ix < visible {
        let line = doc.line(ix);
        if let Some(end) = segment::next_word_end(&line.text, byte) {
            let chars = line.char_of_byte(end);
            return doc.line_start(ix) + chars;
        }
        ix += 1;
        byte = 0;
    }
    doc.max_cursor()
}

/// Where ⌥← lands from `offset`: the start of the word before it, looking
/// into earlier paragraphs; the chapter start if none precedes it.
pub(crate) fn word_start_before(doc: &mut ProseDoc, offset: usize) -> usize {
    let (mut ix, inner) = doc.locate(offset);
    let mut byte = Some(doc.line(ix).byte_of_char(inner));
    loop {
        let line = doc.line(ix);
        let from = byte.unwrap_or(line.text.len());
        if let Some(start) = segment::prev_word_start(&line.text, from) {
            let chars = line.char_of_byte(start);
            return doc.line_start(ix) + chars;
        }
        if ix == 0 {
            return 0;
        }
        ix -= 1;
        byte = None;
    }
}

/// Where a paragraph move goes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ParagraphMove {
    Start,
    End,
    Next,
}

impl ProseEditor {
    pub(crate) fn move_horizontal(&mut self, forward: bool, extend: bool, cx: &mut Context<Self>) {
        // Off a selected embed (`objects.rs`).
        if !extend && self.step_off_embed(forward, cx) {
            return;
        }
        let mut sel = self.selection;
        let chapters = self.book.chapters.len();
        let doc = &mut self.book.chapters[sel.chapter].doc;
        if !extend && !sel.is_empty() {
            let to = if forward { sel.end() } else { sel.start() };
            sel = Selection::caret(to.chapter, to.offset);
        } else if forward {
            if sel.head < doc.max_cursor() {
                sel.head = next_cluster(doc, sel.head);
            } else if sel.chapter + 1 < chapters {
                // The chapter boundary is one step, like a line break.
                sel.chapter += 1;
                sel.head = 0;
            }
        } else if sel.head > 0 {
            sel.head = prev_cluster(doc, sel.head);
        } else if sel.chapter > 0 {
            sel.chapter -= 1;
            sel.head = self.book.chapters[sel.chapter].doc.max_cursor();
        }
        if !extend {
            sel.collapse();
        }
        sel.affinity = Affinity::Downstream;
        sel.goal_x = None;
        self.set_selection(sel, cx);
    }

    pub(crate) fn move_word(&mut self, forward: bool, extend: bool, cx: &mut Context<Self>) {
        let mut sel = self.selection;
        if !extend && sel.spans_chapters() {
            let to = if forward { sel.end() } else { sel.start() };
            sel = Selection::caret(to.chapter, to.offset);
        }
        let from = if extend || sel.is_empty() {
            sel.head
        } else if forward {
            sel.range().end
        } else {
            sel.range().start
        };
        // At a chapter's edge the word is looked for in the next chapter
        // (the boundary counts as a space).
        let (mut chapter, mut from) = (sel.chapter, from);
        if forward
            && from >= self.book.chapters[chapter].doc.max_cursor()
            && chapter + 1 < self.book.chapters.len()
        {
            chapter += 1;
            from = 0;
        } else if !forward && from == 0 && chapter > 0 {
            chapter -= 1;
            from = self.book.chapters[chapter].doc.max_cursor();
        }
        let doc = &mut self.book.chapters[chapter].doc;
        sel.chapter = chapter;
        sel.head = if forward {
            word_end_after(doc, from)
        } else {
            word_start_before(doc, from)
        };
        if !extend {
            sel.collapse();
        }
        sel.affinity = Affinity::Downstream;
        sel.goal_x = None;
        self.set_selection(sel, cx);
    }

    pub(crate) fn move_vertical(
        &mut self,
        down: bool,
        extend: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // Off a selected embed (`objects.rs`).
        if !extend && self.step_off_embed(down, cx) {
            return;
        }
        let mut sel = self.selection;
        let chapter = sel.chapter;
        let (line_ix, inner) = self.book.chapters[chapter].doc.locate(sel.head);
        let Some((layout, line_height)) = self.line_layout(chapter, line_ix, window) else {
            return;
        };
        let rows = layout.row_count();
        let byte = self.book.chapters[chapter]
            .doc
            .line(line_ix)
            .byte_of_char(inner);
        let here = layout.point_for_byte(byte, sel.affinity, line_height);
        let goal_x = sel.goal_x.unwrap_or(here.x);
        let row = layout.row_of(byte, sel.affinity);
        let target = if down && row + 1 < rows {
            Some((chapter, line_ix, row + 1))
        } else if !down && row > 0 {
            Some((chapter, line_ix, row - 1))
        } else {
            // Into the neighbouring paragraph, possibly in the next chapter.
            let visible = self.book.chapters[chapter].doc.visible_lines();
            let neighbour = if down {
                if line_ix + 1 < visible {
                    Some((chapter, line_ix + 1))
                } else if chapter + 1 < self.book.chapters.len() {
                    Some((chapter + 1, 0))
                } else {
                    None
                }
            } else if line_ix > 0 {
                Some((chapter, line_ix - 1))
            } else if chapter > 0 {
                Some((
                    chapter - 1,
                    self.book.chapters[chapter - 1].doc.visible_lines() - 1,
                ))
            } else {
                None
            };
            neighbour.and_then(|(c, l)| {
                let (layout, _) = self.line_layout(c, l, window)?;
                let rows = layout.row_count();
                Some((c, l, if down { 0 } else { rows - 1 }))
            })
        };
        // Onto an embed: its host may take the caret inside (`objects.rs`).
        if !extend
            && let Some((c, l, _)) = target
            && self.enter_embed(c, l, !down, window, cx)
        {
            return;
        }
        let (offset, affinity, target_chapter) = match target {
            Some((c, l, r)) => {
                let Some((layout, _)) = self.line_layout(c, l, window) else {
                    return;
                };
                let (byte, affinity) = layout.byte_in_row(r, goal_x);
                let doc = &mut self.book.chapters[c].doc;
                let line = doc.line(l);
                let byte = segment::snap_grapheme(&line.text, byte);
                let inner = line.char_of_byte(byte);
                (doc.line_start(l) + inner, affinity, c)
            }
            None => {
                let doc = &mut self.book.chapters[chapter].doc;
                let end = if down { doc.max_cursor() } else { 0 };
                (end, Affinity::Downstream, chapter)
            }
        };
        sel.chapter = target_chapter;
        sel.head = offset;
        if !extend {
            sel.collapse();
        }
        sel.affinity = affinity;
        sel.goal_x = Some(goal_x);
        self.set_selection(sel, cx);
    }

    pub(crate) fn move_to_row_edge(
        &mut self,
        end: bool,
        extend: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let mut sel = self.selection;
        let (line_ix, inner) = self.book.chapters[sel.chapter].doc.locate(sel.head);
        let Some((layout, _)) = self.line_layout(sel.chapter, line_ix, window) else {
            return;
        };
        let doc = &mut self.book.chapters[sel.chapter].doc;
        let byte = doc.line(line_ix).byte_of_char(inner);
        let row = layout.rows[layout.row_of(byte, sel.affinity)].clone();
        let target = if end { row.end } else { row.start };
        let inner = doc.line(line_ix).char_of_byte(target);
        sel.head = doc.line_start(line_ix) + inner;
        if !extend {
            sel.collapse();
        }
        sel.affinity = if end {
            Affinity::Upstream
        } else {
            Affinity::Downstream
        };
        sel.goal_x = None;
        self.set_selection(sel, cx);
    }

    /// Paragraph moves: `Start` to the start of the caret's paragraph (or
    /// the previous one's, if already there: ⌥↑, Ctrl+↑); `End` to its end
    /// (or the next one's: ⌥↓); `Next` to the start of the next paragraph
    /// (Ctrl+↓ on Windows).
    pub(crate) fn move_by_paragraph(
        &mut self,
        to: ParagraphMove,
        extend: bool,
        cx: &mut Context<Self>,
    ) {
        let mut sel = self.selection;
        if !extend && sel.spans_chapters() {
            let at = if to == ParagraphMove::Start {
                sel.start()
            } else {
                sel.end()
            };
            sel = Selection::caret(at.chapter, at.offset);
        }
        let doc = &mut self.book.chapters[sel.chapter].doc;
        let from = if extend || sel.is_empty() {
            sel.head
        } else if to == ParagraphMove::Start {
            sel.range().start
        } else {
            sel.range().end
        };
        let (line, inner) = doc.locate(from);
        let last = doc.visible_lines().saturating_sub(1);
        sel.head = match to {
            ParagraphMove::Start if inner == 0 && line > 0 => doc.line_start(line - 1),
            ParagraphMove::Start => doc.line_start(line),
            ParagraphMove::End => {
                let end = doc.line_start(line) + doc.line(line).chars;
                if from == end && line < last {
                    doc.line_start(line + 1) + doc.line(line + 1).chars
                } else {
                    end
                }
            }
            ParagraphMove::Next if line < last => doc.line_start(line + 1),
            ParagraphMove::Next => doc.line_start(line) + doc.line(line).chars,
        };
        if !extend {
            sel.collapse();
        }
        sel.affinity = Affinity::Downstream;
        sel.goal_x = None;
        self.set_selection(sel, cx);
    }

    fn move_to_chapter_edge(&mut self, end: bool, extend: bool, cx: &mut Context<Self>) {
        let mut sel = self.selection;
        let doc = &mut self.book.chapters[sel.chapter].doc;
        sel.head = if end { doc.max_cursor() } else { 0 };
        if !extend {
            sel.collapse();
        }
        sel.goal_x = None;
        self.set_selection(sel, cx);
    }

    // ----- action handlers --------------------------------------------------------

    pub(crate) fn on_move_left(&mut self, _: &MoveLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.move_horizontal(false, false, cx);
    }
    pub(crate) fn on_move_right(&mut self, _: &MoveRight, _: &mut Window, cx: &mut Context<Self>) {
        self.move_horizontal(true, false, cx);
    }
    pub(crate) fn on_select_left(
        &mut self,
        _: &SelectLeft,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.move_horizontal(false, true, cx);
    }
    pub(crate) fn on_select_right(
        &mut self,
        _: &SelectRight,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.move_horizontal(true, true, cx);
    }
    pub(crate) fn on_move_word_left(
        &mut self,
        _: &MoveWordLeft,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.move_word(false, false, cx);
    }
    pub(crate) fn on_move_word_right(
        &mut self,
        _: &MoveWordRight,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.move_word(true, false, cx);
    }
    pub(crate) fn on_select_word_left(
        &mut self,
        _: &SelectWordLeft,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.move_word(false, true, cx);
    }
    pub(crate) fn on_select_word_right(
        &mut self,
        _: &SelectWordRight,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.move_word(true, true, cx);
    }
    pub(crate) fn on_move_up(&mut self, _: &MoveUp, window: &mut Window, cx: &mut Context<Self>) {
        self.move_vertical(false, false, window, cx);
    }
    pub(crate) fn on_move_down(
        &mut self,
        _: &MoveDown,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.move_vertical(true, false, window, cx);
    }
    pub(crate) fn on_select_up(
        &mut self,
        _: &SelectUp,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.move_vertical(false, true, window, cx);
    }
    pub(crate) fn on_select_down(
        &mut self,
        _: &SelectDown,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.move_vertical(true, true, window, cx);
    }
    pub(crate) fn on_move_to_line_start(
        &mut self,
        _: &MoveToLineStart,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.move_to_row_edge(false, false, window, cx);
    }
    pub(crate) fn on_move_to_line_end(
        &mut self,
        _: &MoveToLineEnd,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.move_to_row_edge(true, false, window, cx);
    }
    pub(crate) fn on_select_to_line_start(
        &mut self,
        _: &SelectToLineStart,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.move_to_row_edge(false, true, window, cx);
    }
    pub(crate) fn on_select_to_line_end(
        &mut self,
        _: &SelectToLineEnd,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.move_to_row_edge(true, true, window, cx);
    }
    pub(crate) fn on_move_to_chapter_start(
        &mut self,
        _: &MoveToChapterStart,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.move_to_chapter_edge(false, false, cx);
    }
    pub(crate) fn on_move_to_chapter_end(
        &mut self,
        _: &MoveToChapterEnd,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.move_to_chapter_edge(true, false, cx);
    }
    pub(crate) fn on_select_to_chapter_start(
        &mut self,
        _: &SelectToChapterStart,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.move_to_chapter_edge(false, true, cx);
    }
    pub(crate) fn on_select_to_chapter_end(
        &mut self,
        _: &SelectToChapterEnd,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.move_to_chapter_edge(true, true, cx);
    }
    pub(crate) fn on_move_to_paragraph_start(
        &mut self,
        _: &MoveToParagraphStart,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.move_by_paragraph(ParagraphMove::Start, false, cx);
    }
    pub(crate) fn on_move_to_paragraph_end(
        &mut self,
        _: &MoveToParagraphEnd,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.move_by_paragraph(ParagraphMove::End, false, cx);
    }
    pub(crate) fn on_move_to_next_paragraph(
        &mut self,
        _: &MoveToNextParagraph,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.move_by_paragraph(ParagraphMove::Next, false, cx);
    }
    pub(crate) fn on_select_to_paragraph_start(
        &mut self,
        _: &SelectToParagraphStart,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.move_by_paragraph(ParagraphMove::Start, true, cx);
    }
    pub(crate) fn on_select_to_paragraph_end(
        &mut self,
        _: &SelectToParagraphEnd,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.move_by_paragraph(ParagraphMove::End, true, cx);
    }
    pub(crate) fn on_select_to_next_paragraph(
        &mut self,
        _: &SelectToNextParagraph,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.move_by_paragraph(ParagraphMove::Next, true, cx);
    }
    pub(crate) fn on_select_all(&mut self, _: &SelectAll, _: &mut Window, cx: &mut Context<Self>) {
        let chapter = self.selection.chapter;
        let end = self.book.chapters[chapter].doc.max_cursor();
        let sel = Selection::new(chapter, 0, end);
        // Selecting everything does not scroll to the end.
        self.set_selection_with(sel, false, cx);
    }
}
