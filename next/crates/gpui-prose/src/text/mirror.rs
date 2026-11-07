//! The paragraph mirror: the body text split at `\n`, with each paragraph's
//! attributes and inline marks, kept in step with Loro by its events only.
//!
//! Local edits, undo, redo and imported remote changes all arrive the same
//! way, as text deltas. A delta's structure (inserted and deleted text) is
//! folded in directly; the attributes and marks of every paragraph it touched
//! are then re-read from Loro, which is simpler than replaying attribute
//! deltas and applies the reading rules (paragraph keys only on `\n`, marks
//! only off it) in one place. A property test checks the mirror against a
//! fresh read after every step.

use std::{ops::Range, sync::Arc};

use gpui::SharedString;
use loro::{LoroText, TextDelta, cursor::PosType};

use super::{
    blocks::{BlockAttrs, BlockKind},
    marks::{Marks, Span, push_span, spans_after_delete, spans_after_insert},
    units::byte_of_char,
};

/// One paragraph of the mirror: the text between two newlines.
#[derive(Clone, Debug)]
pub struct Line {
    pub text: SharedString,
    /// The attributes on the `\n` that ends this paragraph (block id, heading …).
    pub block: BlockAttrs,
    /// The heading level, from `block`.
    pub kind: BlockKind,
    /// Marked runs, in bytes of `text`.
    pub spans: Arc<[Span]>,
    /// Length in Unicode scalars, without the newline.
    pub chars: usize,
    /// Length in UTF-16 code units, without the newline.
    pub utf16: usize,
    /// Bumped whenever the text, attributes or marks change; a layout cache key.
    pub rev: u64,
    /// Touched by the last delta; attributes and marks still to be re-read.
    pub(crate) stale: bool,
}

impl Line {
    pub(crate) fn new(text: &str, rev: u64) -> Line {
        Line {
            chars: text.chars().count(),
            utf16: text.encode_utf16().count(),
            text: SharedString::from(text.to_owned()),
            block: BlockAttrs::default(),
            kind: BlockKind::Body,
            spans: Arc::from([]),
            rev,
            stale: true,
        }
    }

    fn set_text(&mut self, text: String, rev: u64) {
        self.chars = text.chars().count();
        self.utf16 = text.encode_utf16().count();
        self.text = SharedString::from(text);
        self.rev = rev;
    }

    /// The block id of this paragraph, if it has one.
    pub fn bid(&self) -> Option<&str> {
        self.block.bid()
    }

    /// Byte offset of the given scalar offset inside this line.
    pub fn byte_of_char(&self, char_offset: usize) -> usize {
        byte_of_char(&self.text, char_offset)
    }

    /// Scalar offset of the given byte offset inside this line.
    pub fn char_of_byte(&self, byte_offset: usize) -> usize {
        self.text[..byte_offset.min(self.text.len())]
            .chars()
            .count()
    }
}

/// How one applied delta changed the line list, in the coordinates current
/// when it was applied: lines `start..start + old` became `new` lines.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LineSplice {
    pub start: usize,
    pub old: usize,
    pub new: usize,
}

/// One applied text op, in scalar offsets, for moving positions held elsewhere
/// (selection, composition anchor) over changes the editor did not make.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TextOp {
    pub pos: usize,
    pub deleted: usize,
    pub inserted: usize,
}

impl TextOp {
    /// Moves `offset` over this op. Text inserted exactly at `offset` lands
    /// after it (the position stays in front of foreign inserts).
    pub fn transform(&self, offset: usize) -> usize {
        if offset <= self.pos {
            offset
        } else if offset <= self.pos + self.deleted {
            self.pos
        } else {
            offset - self.deleted + self.inserted
        }
    }
}

/// What one Loro event did to the mirror.
#[derive(Clone, Debug, Default)]
pub struct ChangeSet {
    pub origin: String,
    pub local: bool,
    pub splices: Vec<LineSplice>,
    pub ops: Vec<TextOp>,
}

/// One paragraph as read from a delta: text, attributes, marks.
pub(crate) struct ReadLine {
    pub text: String,
    pub block: BlockAttrs,
    pub spans: Vec<Span>,
}

/// Splits a delta into paragraphs, applying the reading rules: paragraph
/// attributes only from `\n`, marks only from other characters. The last
/// entry is whatever follows the last `\n` (empty in well-formed text).
pub(crate) fn read_lines(delta: &[TextDelta]) -> Vec<ReadLine> {
    let mut lines = Vec::new();
    let mut current = ReadLine {
        text: String::new(),
        block: BlockAttrs::default(),
        spans: Vec::new(),
    };
    for item in delta {
        let TextDelta::Insert { insert, attributes } = item else {
            continue;
        };
        let marks = attributes
            .as_ref()
            .map(Marks::from_attributes)
            .unwrap_or_default();
        let mut parts = insert.split('\n');
        if let Some(first) = parts.next() {
            push_span(
                &mut current.spans,
                current.text.len(),
                first.len(),
                marks.clone(),
            );
            current.text.push_str(first);
        }
        for part in parts {
            current.block = attributes
                .as_ref()
                .map(BlockAttrs::from_attributes)
                .unwrap_or_default();
            lines.push(std::mem::replace(
                &mut current,
                ReadLine {
                    text: String::new(),
                    block: BlockAttrs::default(),
                    spans: Vec::new(),
                },
            ));
            push_span(&mut current.spans, 0, part.len(), marks.clone());
            current.text.push_str(part);
        }
    }
    lines.push(current);
    lines
}

/// Builds the mirror from a full delta (`LoroText::to_delta`).
pub(crate) fn lines_from_delta(delta: &[TextDelta], rev: u64) -> Vec<Line> {
    read_lines(delta)
        .into_iter()
        .map(|read| {
            let mut line = Line::new(&read.text, rev);
            line.kind = read.block.kind();
            line.block = read.block;
            line.spans = read.spans.into();
            line.stale = false;
            line
        })
        .collect()
}

/// Records that line `ix` changed (so the editor remeasures it); `stale`
/// also schedules a re-read of its attributes and marks.
fn touch(lines: &mut [Line], ix: usize, rev: u64, stale: bool, set: &mut ChangeSet) {
    let line = &mut lines[ix];
    line.stale |= stale;
    line.rev = rev;
    if set.splices.last()
        != Some(&LineSplice {
            start: ix,
            old: 1,
            new: 1,
        })
    {
        set.splices.push(LineSplice {
            start: ix,
            old: 1,
            new: 1,
        });
    }
}

fn push_op(set: &mut ChangeSet, op: TextOp) {
    // Adjacent pieces of one insert (split by attribute runs) or one delete
    // become one op, so an undo that puts deleted text back shows as one insert.
    if let Some(last) = set.ops.last_mut() {
        if op.deleted == 0 && last.deleted == 0 && last.pos + last.inserted == op.pos {
            last.inserted += op.inserted;
            return;
        }
        if op.inserted == 0 && last.inserted == 0 && last.pos == op.pos {
            last.deleted += op.deleted;
            return;
        }
    }
    set.ops.push(op);
}

/// Folds one event delta into the mirror's structure. Positions advance in
/// scalars. Touched lines are marked stale for [`refresh_stale`].
pub(crate) fn apply_delta(
    lines: &mut Vec<Line>,
    delta: &[TextDelta],
    rev: u64,
    set: &mut ChangeSet,
) {
    // Cursor: line index, scalar offset inside it, and absolute scalar offset.
    let (mut ix, mut inner, mut pos) = (0usize, 0usize, 0usize);
    for item in delta {
        match item {
            TextDelta::Retain { retain, attributes } => {
                let styled = attributes.as_ref().is_some_and(|a| !a.is_empty());
                let mut remaining = *retain;
                while remaining > 0 {
                    if styled {
                        touch(lines, ix, rev, true, set);
                    }
                    let left_in_line = lines[ix].chars - inner;
                    if remaining <= left_in_line {
                        inner += remaining;
                        pos += remaining;
                        remaining = 0;
                    } else {
                        // Step over the rest of the line and its newline.
                        remaining -= left_in_line + 1;
                        pos += left_in_line + 1;
                        ix += 1;
                        inner = 0;
                    }
                }
            }
            TextDelta::Insert { insert, attributes } => {
                let inserted = insert.chars().count();
                push_op(
                    set,
                    TextOp {
                        pos,
                        deleted: 0,
                        inserted,
                    },
                );
                let line = &lines[ix];
                let split = line.byte_of_char(inner);
                let (left, right) = (&line.text[..split], &line.text[split..]);
                let parts: Vec<&str> = insert.split('\n').collect();
                if parts.len() == 1 {
                    // Typing: the event says which marks the new text has, so
                    // the spans shift in place and nothing is re-read.
                    let text = format!("{left}{insert}{right}");
                    let marks = attributes
                        .as_ref()
                        .map(Marks::from_attributes)
                        .unwrap_or_default();
                    let line = &mut lines[ix];
                    if !line.stale && !(line.spans.is_empty() && marks.is_empty()) {
                        line.spans =
                            spans_after_insert(&line.spans, split, insert.len(), marks).into();
                    }
                    line.set_text(text, rev);
                    touch(lines, ix, rev, false, set);
                    inner += inserted;
                } else {
                    let last = parts.len() - 1;
                    let mut new_lines = Vec::with_capacity(parts.len());
                    new_lines.push(Line::new(&format!("{left}{}", parts[0]), rev));
                    for part in &parts[1..last] {
                        new_lines.push(Line::new(part, rev));
                    }
                    // The tail keeps the original newline and its attributes.
                    let mut tail = lines[ix].clone();
                    tail.set_text(format!("{}{right}", parts[last]), rev);
                    tail.stale = true;
                    new_lines.push(tail);
                    let added = new_lines.len();
                    lines.splice(ix..ix + 1, new_lines);
                    set.splices.push(LineSplice {
                        start: ix,
                        old: 1,
                        new: added,
                    });
                    ix += last;
                    inner = parts[last].chars().count();
                }
                pos += inserted;
            }
            TextDelta::Delete { delete } => {
                push_op(
                    set,
                    TextOp {
                        pos,
                        deleted: *delete,
                        inserted: 0,
                    },
                );
                let mut remaining = *delete;
                let mut joined = 0;
                while remaining > 0 {
                    let left_in_line = lines[ix].chars - inner;
                    if remaining <= left_in_line {
                        let line = &mut lines[ix];
                        let start = line.byte_of_char(inner);
                        let end = line.byte_of_char(inner + remaining);
                        let text = format!("{}{}", &line.text[..start], &line.text[end..]);
                        if !line.stale && !line.spans.is_empty() {
                            line.spans = spans_after_delete(&line.spans, start..end).into();
                        }
                        line.set_text(text, rev);
                        remaining = 0;
                    } else {
                        // Drop the rest of the line, then its newline: the next
                        // line joins this one and its newline (and attributes)
                        // remain.
                        let line = &lines[ix];
                        let start = line.byte_of_char(inner);
                        let next = &lines[ix + 1];
                        let text = format!("{}{}", &line.text[..start], next.text);
                        let block = next.block.clone();
                        lines[ix].set_text(text, rev);
                        lines[ix].block = block;
                        lines[ix].stale = true;
                        lines.remove(ix + 1);
                        remaining -= left_in_line + 1;
                        joined += 1;
                    }
                }
                set.splices.push(LineSplice {
                    start: ix,
                    old: joined + 1,
                    new: 1,
                });
            }
        }
    }
}

/// Re-reads attributes and marks of every stale line from Loro. Returns
/// whether any line was stale.
pub(crate) fn refresh_stale(lines: &mut [Line], text: &LoroText) -> bool {
    let last = lines.len() - 1;
    let mut at = 0;
    let mut any = false;
    for (ix, line) in lines.iter_mut().enumerate() {
        let len = line.chars + usize::from(ix < last);
        if line.stale {
            any = true;
            refresh_line(line, text, at..at + len);
        }
        at += len;
    }
    any
}

fn refresh_line(line: &mut Line, text: &LoroText, range: Range<usize>) {
    line.stale = false;
    let delta = if range.is_empty() {
        Vec::new()
    } else {
        text.slice_delta(range.start, range.end, PosType::Unicode)
            .unwrap_or_default()
    };
    let mut read = read_lines(&delta);
    let first = if read.is_empty() {
        None
    } else {
        Some(read.swap_remove(0))
    };
    match first {
        Some(read) => {
            debug_assert_eq!(read.text, line.text.as_ref(), "mirror text drifted");
            line.kind = read.block.kind();
            line.block = read.block;
            line.spans = read.spans.into();
        }
        None => {
            line.block = BlockAttrs::default();
            line.kind = BlockKind::Body;
            line.spans = Arc::from([]);
        }
    }
}
