//! Paragraph attributes and the write rules that keep block ids attached to
//! the right text (Enter, joins, cross-paragraph deletes, repair).
//!
//! The rules read straight from Loro, not from the paragraph mirror, so they
//! stay correct in the middle of a multi-step edit (a paste is several splits
//! in one commit) before the mirror has seen any event.

use std::{collections::HashSet, ops::Range};

use loro::{LoroText, LoroValue, TextDelta, cursor::PosType, cursor::Side};

use crate::schema::block;

/// The kind of a paragraph. H1/H2/H3 are three heading levels whose meaning
/// the author decides; the editor treats them alike apart from their size.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum BlockKind {
    #[default]
    Body,
    H1,
    H2,
    H3,
}

impl BlockKind {
    pub fn level(self) -> Option<i64> {
        match self {
            BlockKind::Body => None,
            BlockKind::H1 => Some(1),
            BlockKind::H2 => Some(2),
            BlockKind::H3 => Some(3),
        }
    }

    pub fn from_level(level: Option<i64>) -> BlockKind {
        match level {
            Some(1) => BlockKind::H1,
            Some(2) => BlockKind::H2,
            Some(3) => BlockKind::H3,
            _ => BlockKind::Body,
        }
    }
}

/// The attributes of one paragraph (the marks on its `\n`): paragraph keys
/// only, non-null values, sorted by key.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BlockAttrs(Vec<(&'static str, LoroValue)>);

/// The schema's own spelling of a paragraph key (no allocation per line).
fn block_key(key: &str) -> Option<&'static str> {
    block::ALL.iter().copied().find(|k| *k == key)
}

impl BlockAttrs {
    /// Builds from a delta item's attributes, keeping paragraph keys only.
    pub fn from_attributes<'a>(
        attributes: impl IntoIterator<Item = (&'a String, &'a LoroValue)>,
    ) -> BlockAttrs {
        let mut attrs: Vec<(&'static str, LoroValue)> = attributes
            .into_iter()
            .filter(|(_, value)| !value.is_null())
            .filter_map(|(key, value)| Some((block_key(key)?, value.clone())))
            .collect();
        attrs.sort_by(|a, b| a.0.cmp(b.0));
        BlockAttrs(attrs)
    }

    pub fn get(&self, key: &str) -> Option<&LoroValue> {
        self.0
            .binary_search_by(|(k, _)| (*k).cmp(key))
            .ok()
            .map(|ix| &self.0[ix].1)
    }

    /// Sets or clears a paragraph key (other keys are ignored).
    pub fn set(&mut self, key: &str, value: Option<LoroValue>) {
        let Some(key) = block_key(key) else {
            return;
        };
        match (self.0.binary_search_by(|(k, _)| (*k).cmp(key)), value) {
            (Ok(ix), Some(value)) if !value.is_null() => self.0[ix].1 = value,
            (Ok(ix), _) => {
                self.0.remove(ix);
            }
            (Err(ix), Some(value)) if !value.is_null() => self.0.insert(ix, (key, value)),
            (Err(_), _) => {}
        }
    }

    /// The block id, if the paragraph has one.
    pub fn bid(&self) -> Option<&str> {
        match self.get(block::ID) {
            Some(LoroValue::String(id)) => Some(id.as_str()),
            _ => None,
        }
    }

    /// Heading level 1–3, if the paragraph is a heading.
    pub fn heading(&self) -> Option<i64> {
        match self.get(block::HEADING) {
            Some(LoroValue::I64(level)) if (1..=3).contains(level) => Some(*level),
            Some(LoroValue::Double(level)) if (1.0..=3.0).contains(level) => Some(*level as i64),
            _ => None,
        }
    }

    pub fn kind(&self) -> BlockKind {
        BlockKind::from_level(self.heading())
    }

    /// The listed keys only, plus `bid` set to `bid`.
    pub fn inherit(&self, keys: &[&str], bid: &str) -> BlockAttrs {
        let mut out = BlockAttrs(
            self.0
                .iter()
                .filter(|(key, _)| keys.contains(key))
                .cloned()
                .collect(),
        );
        out.set(block::ID, Some(LoroValue::from(bid)));
        out
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &LoroValue)> {
        self.0.iter().map(|(key, value)| (*key, value))
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

// ----- reading from Loro ------------------------------------------------------

/// Paragraph attributes of the `\n` at `nl`.
pub(crate) fn newline_attrs(text: &LoroText, nl: usize) -> BlockAttrs {
    let Ok(delta) = text.slice_delta(nl, nl + 1, PosType::Unicode) else {
        return BlockAttrs::default();
    };
    for item in delta {
        if let TextDelta::Insert {
            attributes: Some(attributes),
            ..
        } = item
        {
            return BlockAttrs::from_attributes(&attributes);
        }
    }
    BlockAttrs::default()
}

const SCAN: usize = 2048;

/// Position of the first `\n` at or after `pos` (the last character if none).
pub(crate) fn next_newline(text: &LoroText, pos: usize) -> usize {
    let len = text.len_unicode();
    let mut start = pos.min(len);
    while start < len {
        let end = (start + SCAN).min(len);
        let chunk = text.slice(start, end).unwrap_or_default();
        if let Some(ix) = chunk.chars().position(|c| c == '\n') {
            return start + ix;
        }
        start = end;
    }
    len.saturating_sub(1)
}

/// Start of the paragraph that contains `pos`.
pub(crate) fn paragraph_start(text: &LoroText, pos: usize) -> usize {
    let mut end = pos.min(text.len_unicode());
    while end > 0 {
        let start = end.saturating_sub(SCAN);
        let chunk: Vec<char> = text.slice(start, end).unwrap_or_default().chars().collect();
        if let Some(ix) = chunk.iter().rposition(|c| *c == '\n') {
            return start + ix + 1;
        }
        end = start;
    }
    0
}

/// A fresh block id for the `\n` at `pos`: that character's op id, written
/// `"{counter}@{peer}"`. Op ids are unique, so no randomness is needed.
pub(crate) fn fresh_block_id(text: &LoroText, pos: usize) -> String {
    match text
        .get_cursor(pos, Side::Middle)
        .and_then(|cursor| cursor.id)
    {
        Some(id) => format!("{}@{}", id.counter, id.peer),
        // A detached text has no op ids; any unique string will do there.
        None => format!("{pos}@detached"),
    }
}

// ----- writing ----------------------------------------------------------------

/// Makes the paragraph attributes of the `\n` at `nl` exactly `want`.
///
/// `ExpandType` only governs local inserts: text another device inserted at a
/// paragraph boundary while this one marked the `\n` can end up covered by the
/// mark. Readers ignore paragraph keys on other characters; writers state every
/// attribute of a new `\n` explicitly so it never inherits a stray one.
pub(crate) fn set_newline_attrs(text: &LoroText, nl: usize, want: &BlockAttrs) {
    // No inline mark on a newline (one inserted inside a bold or italic run
    // gets it from Loro's expand rule, and the text typed after it would
    // continue it): the same rule as `dr-doc`'s writer.
    if let Ok(delta) = text.slice_delta(nl, nl + 1, PosType::Unicode) {
        for item in delta {
            if let TextDelta::Insert {
                attributes: Some(attributes),
                ..
            } = item
            {
                for (key, value) in attributes.iter() {
                    if !block::is_block_key(key) && !value.is_null() {
                        let _ = text.unmark(nl..nl + 1, key);
                    }
                }
            }
        }
    }
    let have = newline_attrs(text, nl);
    for key in block::ALL {
        match (want.get(key), have.get(key)) {
            (Some(w), Some(h)) if w == h => {}
            (Some(w), _) => {
                let _ = text.mark(nl..nl + 1, key, w.clone());
            }
            (None, Some(_)) => {
                let _ = text.unmark(nl..nl + 1, key);
            }
            (None, None) => {}
        }
    }
}

/// Sets (or clears) one paragraph attribute of the `\n` at `nl`.
/// Sets (or clears) one attribute of the newline at `nl`. Writes nothing when
/// it already has that value, so an unchanged attribute never becomes an
/// undo step that does nothing (dr-doc behaves the same).
pub(crate) fn set_block_attr(text: &LoroText, nl: usize, key: &str, value: Option<LoroValue>) {
    let current = newline_attrs(text, nl).get(key).cloned();
    let value = value.filter(|v| !v.is_null());
    if current == value {
        return;
    }
    let _ = match value {
        Some(value) => text.mark(nl..nl + 1, key, value),
        None => text.unmark(nl..nl + 1, key),
    };
}

/// Enter at `pos`; returns the caret position afterwards.
///
/// The new `\n` always goes in at the caret, so text is only ever inserted
/// before the document's last `\n`, which no command deletes and an undo can
/// never reach. Block ids follow the text:
///
/// - at the end of a non-empty paragraph the new `\n` now ends the written
///   text, so the paragraph's id and attributes move onto it; the old `\n`
///   ends the new empty paragraph and gets a fresh id (no heading);
/// - at the start of a paragraph (or in an empty one) the new empty paragraph
///   above gets the fresh id and the paragraph itself is untouched;
/// - in the middle the first half gets a fresh id and inherits the heading,
///   the second half keeps the old `\n` and id.
pub(crate) fn split(text: &LoroText, pos: usize) -> usize {
    let nl = next_newline(text, pos);
    let start = paragraph_start(text, pos);
    let old = newline_attrs(text, nl);
    if text.insert(pos, "\n").is_err() {
        return pos;
    }
    let fresh = fresh_block_id(text, pos);
    if pos == nl && pos > start {
        set_newline_attrs(text, pos, &old);
        set_newline_attrs(text, nl + 1, &old.inherit(block::INHERITED_AT_END, &fresh));
    } else if pos == start {
        set_newline_attrs(text, pos, &old.inherit(block::INHERITED_AT_END, &fresh));
    } else {
        set_newline_attrs(text, pos, &old.inherit(block::INHERITED_ON_SPLIT, &fresh));
    }
    pos + 1
}

/// Deletes `range` (never the document's last character). When it removes one
/// or more `\n`, the paragraph holding `range.start` absorbs the rest of the
/// one holding `range.end` and keeps its own attributes and id. Exception: a
/// range of whole paragraphs (from a paragraph start to just after a `\n`)
/// leaves the paragraph after it untouched, so Backspace below an empty
/// paragraph removes the empty one and keeps the heading and id below.
///
/// Returns the range actually deleted.
pub(crate) fn delete(text: &LoroText, range: Range<usize>) -> Range<usize> {
    let len = text.len_unicode();
    let end = range.end.min(len.saturating_sub(1));
    let start = range.start.min(end);
    if start == end {
        return start..start;
    }
    let deleted = text.slice(start, end).unwrap_or_default();
    if !deleted.contains('\n') {
        let _ = text.delete(start, end - start);
        return start..end;
    }
    let first_start = paragraph_start(text, start);
    let first_attrs = newline_attrs(text, next_newline(text, start));
    let survivor = next_newline(text, end);
    let _ = text.delete(start, end - start);
    if !(start == first_start && deleted.ends_with('\n')) {
        set_newline_attrs(text, survivor - (end - start), &first_attrs);
    }
    start..end
}

/// Inserts `s` at `pos`; each `\n` in it is an Enter (so pasted paragraphs get
/// fresh ids). Returns the position after the inserted text.
pub(crate) fn insert(text: &LoroText, pos: usize, s: &str) -> usize {
    let mut at = pos;
    for (ix, part) in s.split('\n').enumerate() {
        if ix > 0 {
            at = split(text, at);
        }
        if !part.is_empty() && text.insert(at, part).is_ok() {
            at += part.chars().count();
        }
    }
    at
}

/// Gives every paragraph a unique block id. Later duplicates and missing ids
/// get the op id of their own `\n` (with a `/n` suffix if another paragraph
/// already carries that string), so two devices repairing the same state write
/// the same values. Returns how many paragraphs were fixed.
pub(crate) fn repair_block_ids(text: &LoroText, paragraphs: &[(usize, Option<String>)]) -> usize {
    let mut all: HashSet<String> = paragraphs.iter().filter_map(|(_, id)| id.clone()).collect();
    let mut seen = HashSet::new();
    let mut fixes = Vec::new();
    for (nl, id) in paragraphs {
        match id {
            Some(id) if seen.insert(id.as_str()) => {}
            _ => fixes.push(*nl),
        }
    }
    for nl in &fixes {
        let base = fresh_block_id(text, *nl);
        let mut id = base.clone();
        let mut n = 1;
        while all.contains(&id) {
            id = format!("{base}/{n}");
            n += 1;
        }
        let _ = text.mark(*nl..*nl + 1, block::ID, id.clone());
        all.insert(id);
    }
    fixes.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attrs_are_sorted_and_typed() {
        let mut attrs = BlockAttrs::default();
        attrs.set(block::HEADING, Some(2.into()));
        attrs.set(block::ID, Some("7@1".into()));
        assert_eq!(attrs.bid(), Some("7@1"));
        assert_eq!(attrs.kind(), BlockKind::H2);
        let inherited = attrs.inherit(block::INHERITED_AT_END, "9@1");
        assert_eq!(inherited.bid(), Some("9@1"));
        assert_eq!(inherited.kind(), BlockKind::Body);
        attrs.set(block::HEADING, None);
        assert_eq!(attrs.kind(), BlockKind::Body);
    }
}
