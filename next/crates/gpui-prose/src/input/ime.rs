//! The input-method handler: GPUI's `EntityInputHandler`, which `insertText:`,
//! `setMarkedText:`, `unmarkText`, `firstRectForCharacterRange` and friends
//! turn into on macOS.

use std::ops::Range;

use gpui::{Bounds, Context, EntityInputHandler, Pixels, Point, UTF16Selection, Window, px, size};

use super::composition::{Composition, Marked16, Virtual16};
use crate::{
    ProseEditor,
    input::Selection,
    layout::{Affinity, shape},
    text::{ORIGIN_USER, units::byte_of_utf16, units::utf16_slice},
};

/// A position in the IME's view of the focused chapter.
pub(crate) enum VirtualPos {
    Doc(usize),
    Marked(usize),
}

impl ProseEditor {
    pub(crate) fn log_ime(&self, call: std::fmt::Arguments) {
        if self.options.ime_log {
            eprintln!(
                "[ime] {call} | comp={:?} sel={:?}",
                self.composition
                    .as_ref()
                    .map(|c| (&c.text, c.at, c.replaced)),
                self.selection.range()
            );
        }
    }

    pub(crate) fn input_chapter(&self) -> usize {
        self.composition
            .as_ref()
            .map_or(self.selection.chapter, |comp| comp.chapter)
    }

    /// The marked text in UTF-16 units of the committed chapter text.
    pub(crate) fn marked16(&mut self) -> Option<Marked16> {
        let comp = self.composition.as_ref()?;
        let (chapter, at, replaced) = (comp.chapter, comp.at, comp.replaced);
        let len = comp.text.encode_utf16().count();
        let doc = &mut self.book.chapters[chapter].doc;
        let at16 = doc.offset_to_utf16(at);
        let end16 = doc.offset_to_utf16(at + replaced);
        Some(Marked16 {
            at: at16,
            len,
            replaced: end16 - at16,
        })
    }

    fn virtual_len16(&mut self) -> usize {
        let marked = self.marked16();
        let chapter = self.input_chapter();
        let len = self.book.chapters[chapter].doc.len_utf16();
        marked.map_or(len, |m| m.virtual_len(len))
    }

    fn doc_to_virtual16(&mut self, offset: usize) -> usize {
        let marked = self.marked16();
        let chapter = self.input_chapter();
        let offset16 = self.book.chapters[chapter].doc.offset_to_utf16(offset);
        marked.map_or(offset16, |m| m.to_virtual(offset16))
    }

    fn virtual16_to_doc(&mut self, v: usize) -> VirtualPos {
        let chapter = self.input_chapter();
        let doc_pos = |editor: &mut Self, c16: usize| {
            VirtualPos::Doc(editor.book.chapters[chapter].doc.offset_from_utf16(c16))
        };
        match self.marked16() {
            None => doc_pos(self, v),
            Some(m) => match m.from_virtual(v) {
                Virtual16::Committed(c16) => doc_pos(self, c16),
                Virtual16::Marked(k) => VirtualPos::Marked(k),
            },
        }
    }

    /// A virtual UTF-16 range as committed offsets; positions inside the
    /// marked text map to its edges.
    fn virtual_range_to_doc(&mut self, range: Range<usize>) -> Range<usize> {
        let chapter = self.input_chapter();
        match self.marked16() {
            None => {
                let doc = &mut self.book.chapters[chapter].doc;
                let (a, b) = (
                    doc.offset_from_utf16(range.start),
                    doc.offset_from_utf16(range.end),
                );
                a.min(b)..a.max(b)
            }
            Some(m) => {
                let committed = m.range_to_committed(range);
                let doc = &mut self.book.chapters[chapter].doc;
                doc.offset_from_utf16(committed.start)..doc.offset_from_utf16(committed.end)
            }
        }
    }

    /// Writes confirmed text in one commit (one undo step), ending any
    /// composition.
    pub(crate) fn commit_text(
        &mut self,
        range: Range<usize>,
        text: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.cancel_composition();
        let overrides = std::mem::take(&mut self.pending_marks);
        self.edit(window, cx, |doc, sel| {
            let max = doc.len_chars();
            let range = range.start.min(max)..range.end.min(max);
            doc.checkpoint();
            let inserted = doc.replace_styled(range, text, &overrides, ORIGIN_USER);
            *sel = Selection::caret(sel.chapter, inserted.end);
        });
    }

    /// The line and display byte of a virtual UTF-16 position.
    fn display_position(&mut self, v: usize) -> (usize, usize) {
        let chapter = self.input_chapter();
        let pos = self.virtual16_to_doc(v);
        let comp = self.composition.clone();
        let doc = &mut self.book.chapters[chapter].doc;
        match (pos, comp) {
            (VirtualPos::Marked(k), Some(comp)) => {
                let (line, inner) = doc.locate(comp.at);
                let base = doc.line(line).byte_of_char(inner);
                (line, base + byte_of_utf16(&comp.text, k))
            }
            (VirtualPos::Doc(offset), comp) => {
                let (line, inner) = doc.locate(offset);
                let mut byte = doc.line(line).byte_of_char(inner);
                if let Some(comp) = comp {
                    let (comp_line, comp_inner) = doc.locate(comp.at);
                    if comp_line == line && inner >= comp_inner + comp.replaced && offset > comp.at
                    {
                        let replaced_bytes =
                            doc.line(line).byte_of_char(comp_inner + comp.replaced)
                                - doc.line(line).byte_of_char(comp_inner);
                        byte = byte - replaced_bytes + comp.text.len();
                    }
                }
                (line, byte)
            }
            (VirtualPos::Marked(_), None) => (0, 0),
        }
    }

    fn bounds_for_range_inner(
        &mut self,
        range16: Range<usize>,
        window: &mut Window,
    ) -> Option<Bounds<Pixels>> {
        let chapter = self.input_chapter();
        let (line_ix, byte) = self.display_position(range16.start);
        let (end_line, end_byte) = self.display_position(range16.end);
        let painted = self.frame.borrow().get(chapter, line_ix).cloned()?;
        // The paragraph may have changed since it was painted (this query often
        // comes right after a keystroke): shape the current display text at the
        // painted width so the candidate window lands on the new position.
        let display = self.display(chapter, line_ix);
        let layout = if display.text == painted.text {
            painted.layout.clone()
        } else {
            let kind = self.book.chapters[chapter].doc.line(line_ix).kind;
            let font_size = self.style.font_size(kind);
            std::rc::Rc::new(shape(
                &display.text,
                font_size,
                &display.runs,
                painted.layout.wrap_width,
                window,
            ))
        };
        let start = layout.point_for_byte(byte, Affinity::Downstream, painted.line_height);
        let end_x = if end_line == line_ix {
            let end = layout.point_for_byte(end_byte, Affinity::Upstream, painted.line_height);
            if end.y == start.y { end.x } else { start.x }
        } else {
            start.x
        };
        Some(Bounds::new(
            painted.origin + start,
            size((end_x - start.x).max(px(1.)), painted.line_height),
        ))
    }
}

impl EntityInputHandler for ProseEditor {
    fn text_for_range(
        &mut self,
        range16: Range<usize>,
        actual_range: &mut Option<Range<usize>>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<String> {
        let len = self.virtual_len16();
        let range16 = range16.start.min(len)..range16.end.min(len);
        actual_range.replace(range16.clone());
        let chapter = self.input_chapter();
        let Some(m) = self.marked16() else {
            let doc = &mut self.book.chapters[chapter].doc;
            let range = doc.offset_from_utf16(range16.start)..doc.offset_from_utf16(range16.end);
            return Some(doc.slice(range));
        };
        let comp_text = self.composition.as_ref().map(|comp| comp.text.clone())?;
        let doc = &mut self.book.chapters[chapter].doc;
        let mut out = String::new();
        if range16.start < m.at {
            let end = range16.end.min(m.at);
            let range = doc.offset_from_utf16(range16.start)..doc.offset_from_utf16(end);
            out.push_str(&doc.slice(range));
        }
        let (ms, me) = (
            range16.start.clamp(m.at, m.at + m.len) - m.at,
            range16.end.clamp(m.at, m.at + m.len) - m.at,
        );
        if ms < me {
            out.push_str(utf16_slice(&comp_text, ms, me));
        }
        if range16.end > m.at + m.len {
            let start = range16.start.max(m.at + m.len) - m.len + m.replaced;
            let end = range16.end - m.len + m.replaced;
            let range = doc.offset_from_utf16(start)..doc.offset_from_utf16(end);
            out.push_str(&doc.slice(range));
        }
        Some(out)
    }

    fn selected_text_range(
        &mut self,
        _ignore_disabled_input: bool,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        if let Some(m) = self.marked16() {
            let comp = self.composition.as_ref()?;
            let start = comp.text[..comp.selected.start].encode_utf16().count();
            let end = comp.text[..comp.selected.end].encode_utf16().count();
            return Some(UTF16Selection {
                range: m.at + start..m.at + end,
                reversed: false,
            });
        }
        let sel = self.selection;
        let doc = &mut self.book.chapters[sel.chapter].doc;
        let range = sel.range();
        Some(UTF16Selection {
            range: doc.offset_to_utf16(range.start)..doc.offset_to_utf16(range.end),
            reversed: sel.head < sel.anchor,
        })
    }

    fn marked_text_range(
        &self,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Range<usize>> {
        let comp = self.composition.as_ref()?;
        // `&self` here: compute the anchor's UTF-16 offset by scanning.
        let doc = &self.book.chapters[comp.chapter].doc;
        let mut at16 = 0;
        let mut remaining = comp.at;
        for line in doc.lines() {
            if remaining <= line.chars {
                at16 += line
                    .text
                    .chars()
                    .take(remaining)
                    .map(char::len_utf16)
                    .sum::<usize>();
                break;
            }
            at16 += line.utf16 + 1;
            remaining -= line.chars + 1;
        }
        Some(at16..at16 + comp.text.encode_utf16().count())
    }

    fn unmark_text(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.log_ime(format_args!("unmark_text"));
        // The input method accepts the marked text as it stands.
        if let Some(comp) = self.composition.clone() {
            self.commit_text(comp.at..comp.at + comp.replaced, &comp.text, window, cx);
        }
    }

    fn replace_text_in_range(
        &mut self,
        range16: Option<Range<usize>>,
        text: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.log_ime(format_args!("replace_text_in_range({range16:?}, {text:?})"));
        let explicit = range16.is_some();
        let range = match (&self.composition, range16) {
            (Some(comp), None) => comp.at..comp.at + comp.replaced,
            (Some(comp), Some(range16)) => {
                let (at, end) = (comp.at, comp.at + comp.replaced);
                let mapped = self.virtual_range_to_doc(range16);
                mapped.start.min(at)..mapped.end.max(end)
            }
            (None, Some(range16)) => self.virtual_range_to_doc(range16),
            (None, None) => self.selection.range(),
        };
        if self.composition.is_none() && !explicit && text.is_empty() && range.is_empty() {
            return;
        }
        if self.composition.is_some() {
            self.commit_text(range, text, window, cx);
        } else {
            // Plain typing: merges with neighbouring keystrokes into one undo step.
            let overrides = std::mem::take(&mut self.pending_marks);
            self.edit(window, cx, |doc, sel| {
                let inserted = doc.replace_styled(range.clone(), text, &overrides, ORIGIN_USER);
                *sel = Selection::caret(sel.chapter, inserted.end);
            });
        }
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range16: Option<Range<usize>>,
        new_text: &str,
        new_selected_range16: Option<Range<usize>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.log_ime(format_args!(
            "replace_and_mark_text_in_range({range16:?}, {new_text:?}, {new_selected_range16:?})"
        ));
        if self.composition.is_none() {
            let mut base = match range16 {
                Some(range16) => self.virtual_range_to_doc(range16),
                None => self.selection.range(),
            };
            let chapter = self.selection.chapter;
            let doc = &mut self.book.chapters[chapter].doc;
            let (first, _) = doc.locate(base.start);
            let (last, _) = doc.locate(base.end);
            if first != last {
                // A selection across paragraphs is removed up front; the marked
                // text is then shown inside one paragraph.
                let range = base.clone();
                self.edit(window, cx, |doc, sel| {
                    doc.checkpoint();
                    doc.delete(range.clone(), ORIGIN_USER);
                    *sel = Selection::caret(sel.chapter, range.start);
                });
                base = base.start..base.start;
            }
            self.composition = Some(Composition {
                chapter,
                at: base.start,
                replaced: base.len(),
                text: String::new(),
                selected: 0..0,
            });
        } else if let Some(range16) = range16 {
            // The input method re-targets the marked range (rare).
            let mapped = self.virtual_range_to_doc(range16);
            if let Some(comp) = self.composition.as_mut() {
                let end = (comp.at + comp.replaced).max(mapped.end);
                comp.at = comp.at.min(mapped.start);
                comp.replaced = end - comp.at;
            }
        }
        if new_text.is_empty() {
            // All marked text deleted: back to the committed text, untouched.
            let at = self.composition.as_ref().map_or(0, |comp| comp.at);
            let chapter = self.input_chapter();
            self.cancel_composition();
            self.selection = Selection::caret(chapter, at);
        } else if let Some(comp) = self.composition.as_mut() {
            comp.text = new_text.to_owned();
            comp.selected = match new_selected_range16 {
                Some(range) => {
                    byte_of_utf16(new_text, range.start)..byte_of_utf16(new_text, range.end)
                }
                None => new_text.len()..new_text.len(),
            };
        }
        self.autoscroll = true;
        self.reset_blink(cx);
        cx.notify();
        self.present_now(window);
    }

    fn bounds_for_range(
        &mut self,
        range16: Range<usize>,
        _element_bounds: Bounds<Pixels>,
        window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let result = self.bounds_for_range_inner(range16.clone(), window);
        self.log_ime(format_args!("bounds_for_range({range16:?}) -> {result:?}"));
        result
    }

    fn selection_bounds_for_range(
        &mut self,
        range16: Range<usize>,
        element_bounds: Bounds<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<Bounds<Pixels>> {
        self.bounds_for_range(range16, element_bounds, window, cx)
            .into_iter()
            .collect()
    }

    fn character_index_for_point(
        &mut self,
        point: Point<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<usize> {
        let (chapter, offset) = self.hit_test(point)?;
        (chapter == self.input_chapter()).then(|| self.doc_to_virtual16(offset))
    }

    fn text_length_utf16(
        &mut self,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<usize> {
        Some(self.virtual_len16())
    }

    fn set_selected_text_range(
        &mut self,
        range16: Range<usize>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.composition.is_some() {
            return;
        }
        let range = self.virtual_range_to_doc(range16);
        self.selection = Selection::new(self.selection.chapter, range.start, range.end);
        self.clamp_selection();
        cx.notify();
    }
}
