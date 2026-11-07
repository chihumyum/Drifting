//! Inline marks: bold, italic, underline, strike, links and any other key an
//! extension uses (entity links `entity:<id>`, highlights …).
//!
//! Marks never go on a `\n` (that character carries paragraph attributes), so
//! a range that crosses paragraphs is marked one paragraph at a time.

use std::{ops::Range, sync::Arc};

use gpui::SharedString;
use loro::{LoroText, LoroValue};

use crate::schema::{block, inline};

/// The inline marks of a run of text: non-paragraph keys with non-null
/// values, sorted by key.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Marks(Arc<[(SharedString, LoroValue)]>);

impl Marks {
    pub fn from_attributes<'a>(
        attributes: impl IntoIterator<Item = (&'a String, &'a LoroValue)>,
    ) -> Marks {
        let mut marks: Vec<(SharedString, LoroValue)> = attributes
            .into_iter()
            .filter(|(key, value)| !block::is_block_key(key) && !value.is_null())
            .map(|(key, value)| (SharedString::from(key.clone()), value.clone()))
            .collect();
        marks.sort_by(|a, b| a.0.cmp(&b.0));
        Marks(marks.into())
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn get(&self, key: &str) -> Option<&LoroValue> {
        self.0
            .binary_search_by(|(k, _)| k.as_ref().cmp(key))
            .ok()
            .map(|ix| &self.0[ix].1)
    }

    /// Whether `key` is set to a truthy value (anything but `false`).
    pub fn has(&self, key: &str) -> bool {
        !matches!(self.get(key), None | Some(LoroValue::Bool(false)))
    }

    pub fn bold(&self) -> bool {
        self.has(inline::BOLD)
    }

    pub fn italic(&self) -> bool {
        self.has(inline::ITALIC)
    }

    pub fn underline(&self) -> bool {
        self.has(inline::UNDERLINE)
    }

    pub fn strike(&self) -> bool {
        self.has(inline::STRIKE)
    }

    /// The link URL, if the run is a link.
    pub fn link(&self) -> Option<&str> {
        match self.get(inline::LINK) {
            Some(LoroValue::String(url)) => Some(url.as_str()),
            _ => None,
        }
    }

    /// Entity links on the run: `(target id, value)`.
    pub fn entities(&self) -> impl Iterator<Item = (&str, &LoroValue)> {
        self.0
            .iter()
            .filter_map(|(key, value)| Some((inline::entity_target(key)?, value)))
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &LoroValue)> {
        self.0.iter().map(|(key, value)| (key.as_ref(), value))
    }
}

/// A run of marked text inside one paragraph, in bytes of the paragraph text.
/// Unmarked text has no span; neighbouring spans never have equal marks.
#[derive(Clone, Debug, PartialEq)]
pub struct Span {
    pub range: Range<usize>,
    pub marks: Marks,
}

/// Appends `len` bytes with `marks` at `at`, merging with the previous span.
pub(crate) fn push_span(spans: &mut Vec<Span>, at: usize, len: usize, marks: Marks) {
    if len == 0 || marks.is_empty() {
        return;
    }
    if let Some(last) = spans.last_mut()
        && last.range.end == at
        && last.marks == marks
    {
        last.range.end += len;
        return;
    }
    spans.push(Span {
        range: at..at + len,
        marks,
    });
}

/// Spans after inserting `len` bytes with `marks` at byte `at`.
pub(crate) fn spans_after_insert(spans: &[Span], at: usize, len: usize, marks: Marks) -> Vec<Span> {
    let mut out: Vec<Span> = Vec::with_capacity(spans.len() + 2);
    let mut placed = false;
    let place = |out: &mut Vec<Span>| push_span(out, at, len, marks.clone());
    for span in spans {
        if span.range.end <= at {
            push_span(
                &mut out,
                span.range.start,
                span.range.len(),
                span.marks.clone(),
            );
        } else if span.range.start >= at {
            if !placed {
                place(&mut out);
                placed = true;
            }
            push_span(
                &mut out,
                span.range.start + len,
                span.range.len(),
                span.marks.clone(),
            );
        } else {
            push_span(
                &mut out,
                span.range.start,
                at - span.range.start,
                span.marks.clone(),
            );
            place(&mut out);
            placed = true;
            push_span(&mut out, at + len, span.range.end - at, span.marks.clone());
        }
    }
    if !placed {
        place(&mut out);
    }
    out
}

/// Spans after deleting bytes `range`.
pub(crate) fn spans_after_delete(spans: &[Span], range: Range<usize>) -> Vec<Span> {
    let gone = range.len();
    let map = |b: usize| {
        if b <= range.start {
            b
        } else if b >= range.end {
            b - gone
        } else {
            range.start
        }
    };
    let mut out: Vec<Span> = Vec::with_capacity(spans.len());
    for span in spans {
        let (start, end) = (map(span.range.start), map(span.range.end));
        if start < end {
            push_span(&mut out, start, end - start, span.marks.clone());
        }
    }
    out
}

/// The marks at byte `byte` of a paragraph's spans (of the character that
/// starts there).
pub fn marks_at(spans: &[Span], byte: usize) -> Option<&Marks> {
    spans
        .iter()
        .find(|span| span.range.start <= byte && byte < span.range.end)
        .map(|span| &span.marks)
}

/// The scalar ranges of `range` with the `\n` characters cut out.
pub(crate) fn segments_without_newlines(text: &LoroText, range: Range<usize>) -> Vec<Range<usize>> {
    let mut out = Vec::new();
    if range.is_empty() {
        return out;
    }
    let s = text.slice(range.start, range.end).unwrap_or_default();
    let mut seg = range.start;
    for (ix, c) in s.chars().enumerate() {
        if c == '\n' {
            let pos = range.start + ix;
            if pos > seg {
                out.push(seg..pos);
            }
            seg = pos + 1;
        }
    }
    if range.end > seg {
        out.push(seg..range.end);
    }
    out
}

/// Marks `range` with `key`, skipping newlines.
pub(crate) fn mark_inline(text: &LoroText, range: Range<usize>, key: &str, value: LoroValue) {
    for seg in segments_without_newlines(text, range) {
        let _ = text.mark(seg, key, value.clone());
    }
}

/// Removes `key` from `range`, newlines included, so no stray piece survives
/// on one (as `dr-doc` does).
pub(crate) fn unmark_inline(text: &LoroText, range: Range<usize>, key: &str) {
    if !range.is_empty() {
        let _ = text.unmark(range, key);
    }
}
