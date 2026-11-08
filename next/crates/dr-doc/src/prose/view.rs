//! Reading a prose document without copying it.

use std::collections::HashSet;
use std::ops::Range;

use dr_model::ProseProfile;
use dr_model::id::{BlockId, EmbedId};
use dr_model::prose::{BlockAttrs, EntityLink, InlineMarks, OBJECT_CHAR, PARAGRAPH_END};
use loro::cursor::{PosType, Side};
use loro::{LoroDoc, LoroMap, LoroText, LoroValue, TextDelta, ValueOrContainer};

use super::attrs::{RawAttrs, decode_block, decode_inline, raw};
use crate::anchor::{Anchor, Resolved};
use crate::error::{DocError, Result};
use crate::pos::{PosError, TextPos, Unit};
use crate::schema::inline;

/// A run of text with the same inline marks.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Run {
    pub text: String,
    pub marks: InlineMarks,
}

/// One paragraph as read. Copies only this paragraph's text.
#[derive(Clone, Debug, PartialEq)]
pub struct Paragraph {
    /// The block id readers use: `None` when the paragraph has none or when an
    /// earlier paragraph already carries the same id (until the repair runs,
    /// the first one in document order keeps it).
    pub id: Option<BlockId>,
    /// The id as stored on the newline, even when it is a duplicate.
    pub stored_id: Option<BlockId>,
    /// Unicode-scalar range of the text, excluding the newline.
    pub range: Range<usize>,
    /// Position of the terminating newline (`range.end`). In damaged data the
    /// last paragraph may have none; then `terminated` is false.
    pub newline: usize,
    pub terminated: bool,
    pub attrs: BlockAttrs,
    pub runs: Vec<Run>,
}

impl Paragraph {
    pub fn text(&self) -> String {
        self.runs.iter().map(|r| r.text.as_str()).collect()
    }

    pub fn len(&self) -> usize {
        self.range.len()
    }

    pub fn is_empty(&self) -> bool {
        self.range.is_empty()
    }

    /// The embed this paragraph stands for, if it is a lone U+FFFC.
    pub fn embed(&self) -> Option<&EmbedId> {
        match self.runs.as_slice() {
            [r] if r.text == OBJECT_CHAR.to_string() => r.marks.embed.as_ref(),
            _ => None,
        }
    }
}

/// Where a paragraph is, without its text: what an index needs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlockRef {
    /// As stored (duplicates included).
    pub id: Option<BlockId>,
    pub newline: usize,
}

/// A read-only view of a prose document. Cheap to make; every method reads
/// only what it returns.
#[derive(Clone, Copy)]
pub struct ProseView<'a> {
    pub(crate) doc: &'a LoroDoc,
    pub(crate) text: &'a LoroText,
    pub(crate) embeds: &'a LoroMap,
    pub(crate) profile: ProseProfile,
}

impl<'a> ProseView<'a> {
    pub fn profile(&self) -> ProseProfile {
        self.profile
    }

    /// Length in Unicode scalars, the final newline included.
    pub fn len(&self) -> usize {
        self.text.len_unicode()
    }

    /// Whether the body is a single empty paragraph.
    pub fn is_empty(&self) -> bool {
        self.len() <= 1
    }

    pub fn len_utf8(&self) -> usize {
        self.text.len_utf8()
    }

    pub fn len_utf16(&self) -> usize {
        self.text.len_utf16()
    }

    /// The position `value` (in `unit`) of the whole body, in all three
    /// units. Logarithmic: Loro converts through its own index.
    pub fn pos(&self, unit: Unit, value: usize) -> Result<TextPos, PosError> {
        let from = match unit {
            Unit::Char => PosType::Unicode,
            Unit::Utf8 => PosType::Bytes,
            Unit::Utf16 => PosType::Utf16,
        };
        let len = match unit {
            Unit::Char => self.len(),
            Unit::Utf8 => self.len_utf8(),
            Unit::Utf16 => self.len_utf16(),
        };
        if value > len {
            return Err(PosError::OutOfRange { unit, value, len });
        }
        let conv = |to: PosType| self.text.convert_pos(value, from, to);
        let (Some(chars), Some(utf8), Some(utf16)) = (
            conv(PosType::Unicode),
            conv(PosType::Bytes),
            conv(PosType::Utf16),
        ) else {
            return Err(PosError::NotABoundary { unit, value });
        };
        let p = TextPos { chars, utf8, utf16 };
        // Loro rounds a position inside a character; converting back exposes it.
        let back = self.text.convert_pos(chars, PosType::Unicode, from);
        if back != Some(value) {
            return Err(PosError::NotABoundary { unit, value });
        }
        Ok(p)
    }

    /// Text in `range` (Unicode scalars). Copies only that range.
    pub fn text_in(&self, range: Range<usize>) -> Result<String> {
        self.check_range(&range)?;
        Ok(self.text.slice(range.start, range.end)?)
    }

    /// The whole body as plain text, newlines included. Copies everything.
    pub fn plain_text(&self) -> String {
        self.text.to_string()
    }

    pub(crate) fn check_range(&self, r: &Range<usize>) -> Result<()> {
        let len = self.len();
        if r.start > r.end || r.end > len {
            return Err(DocError::BadRange {
                start: r.start,
                end: r.end,
                len,
            });
        }
        Ok(())
    }

    /// Positions of every newline, in order. Scans the text once without
    /// copying it.
    pub fn newlines(&self) -> Vec<usize> {
        let mut out = Vec::new();
        let mut pos = 0usize;
        self.text.iter(|chunk| {
            for c in chunk.chars() {
                if c == PARAGRAPH_END {
                    out.push(pos);
                }
                pos += 1;
            }
            true
        });
        out
    }

    /// Every paragraph's newline and stored block id, without text.
    pub fn blocks(&self) -> Vec<BlockRef> {
        self.blocks_in(0, self.len())
    }

    /// Newlines and stored block ids in `start..end`, read in one pass.
    fn blocks_in(&self, start: usize, end: usize) -> Vec<BlockRef> {
        let mut out = Vec::new();
        if end <= start {
            return out;
        }
        let Ok(delta) = self.text.slice_delta(start, end, PosType::Unicode) else {
            return out;
        };
        let mut pos = start;
        for d in delta {
            let TextDelta::Insert { insert, attributes } = d else {
                continue;
            };
            let mut id: Option<Option<BlockId>> = None;
            for c in insert.chars() {
                if c == PARAGRAPH_END {
                    let id = id
                        .get_or_insert_with(|| {
                            let a: RawAttrs = attributes
                                .as_ref()
                                .map(|a| raw(a.iter()))
                                .unwrap_or_default();
                            decode_block(&a, self.profile).0
                        })
                        .clone();
                    out.push(BlockRef { id, newline: pos });
                }
                pos += 1;
            }
        }
        out
    }

    /// Number of paragraphs.
    pub fn paragraph_count(&self) -> usize {
        let n = self.newlines().len();
        if self.terminated() { n } else { n + 1 }
    }

    fn terminated(&self) -> bool {
        let len = self.len();
        len > 0 && self.text.char_at(len - 1).ok() == Some(PARAGRAPH_END)
    }

    /// Paragraphs in order, read one at a time. The duplicate-id rule is
    /// applied as it goes: a later paragraph with an id already seen gets
    /// `id: None`.
    pub fn paragraphs(&self) -> Paragraphs<'a> {
        let newlines = self.newlines();
        Paragraphs {
            view: *self,
            newlines,
            next: 0,
            start: 0,
            seen: HashSet::new(),
            done: false,
        }
    }

    /// The paragraph containing `pos` (a position on its newline counts as
    /// inside it). The duplicate rule needs the paragraphs before it, so this
    /// reads every block id up to it, but only this paragraph's text.
    pub fn paragraph_at(&self, pos: usize) -> Result<Paragraph> {
        let len = self.len();
        if pos > len || len == 0 {
            return Err(DocError::BadRange {
                start: pos,
                end: pos,
                len,
            });
        }
        let pos = pos.min(len.saturating_sub(1));
        let start = self.paragraph_start(pos);
        let nl = self.next_newline(start);
        let mut p = self.read_paragraph(start, nl);
        if let Some(id) = &p.stored_id
            && self
                .blocks_in(0, start)
                .iter()
                .any(|b| b.id.as_ref() == Some(id))
        {
            p.id = None;
        }
        Ok(p)
    }

    /// Up to `n` paragraphs starting with the one that contains `pos`, read
    /// without looking at anything before it (cheap anywhere in the body).
    /// `id` is the stored block id: the "a later duplicate has none" rule
    /// needs every paragraph before, so it is not applied here (duplicates
    /// only exist between an import and its repair, which the holder runs
    /// right away).
    pub fn paragraph_in(&self, pos: usize, n: usize) -> Vec<Paragraph> {
        let len = self.len();
        let mut out = Vec::with_capacity(n);
        if len == 0 || n == 0 {
            return out;
        }
        let mut start = self.paragraph_start(pos.min(len - 1));
        while out.len() < n && start < len {
            let nl = self.next_newline(start);
            out.push(self.read_paragraph(start, nl));
            match nl {
                Some(nl) => start = nl + 1,
                None => break,
            }
        }
        out
    }

    /// The paragraph whose (effective) id is `id`. A scan: an editor keeps
    /// its own index.
    pub fn paragraph_by_id(&self, id: &BlockId) -> Option<Paragraph> {
        // The first paragraph in document order carrying the id is the one
        // that keeps it.
        self.blocks()
            .into_iter()
            .find(|b| b.id.as_ref() == Some(id))
            .map(|b| self.read_paragraph(self.paragraph_start(b.newline), Some(b.newline)))
    }

    pub(crate) fn read_paragraph(&self, start: usize, nl: Option<usize>) -> Paragraph {
        let end = nl.unwrap_or_else(|| self.len());
        let runs = if end > start {
            self.text
                .slice_delta(start, end, PosType::Unicode)
                .map(|d| runs_of(d, self.profile))
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        let (stored_id, attrs) = match nl {
            Some(n) => self.newline_block(n),
            None => (None, BlockAttrs::default()),
        };
        Paragraph {
            id: stored_id.clone(),
            stored_id,
            range: start..end,
            newline: end,
            terminated: nl.is_some(),
            attrs,
            runs,
        }
    }

    /// Raw attributes of the character at `pos`.
    pub(crate) fn raw_attrs_at(&self, pos: usize) -> RawAttrs {
        match self.text.slice_delta(pos, pos + 1, PosType::Unicode) {
            Ok(delta) => delta
                .into_iter()
                .find_map(|d| match d {
                    TextDelta::Insert { attributes, .. } => attributes.map(|a| raw(a.iter())),
                    _ => None,
                })
                .unwrap_or_default(),
            Err(_) => RawAttrs::new(),
        }
    }

    /// Stored block id and attributes of the newline at `nl`.
    pub fn newline_block(&self, nl: usize) -> (Option<BlockId>, BlockAttrs) {
        decode_block(&self.raw_attrs_at(nl), self.profile)
    }

    /// Position of the first newline at or after `pos`; `None` when the body
    /// does not end with one (damaged data).
    pub fn next_newline(&self, pos: usize) -> Option<usize> {
        let len = self.len();
        let mut start = pos;
        while start < len {
            let end = (start + 512).min(len);
            let chunk = self.text.slice(start, end).ok()?;
            if let Some(i) = chunk.chars().position(|c| c == PARAGRAPH_END) {
                return Some(start + i);
            }
            start = end;
        }
        None
    }

    /// Start of the paragraph that contains `pos`.
    pub fn paragraph_start(&self, pos: usize) -> usize {
        let mut end = pos.min(self.len());
        while end > 0 {
            let start = end.saturating_sub(512);
            let Ok(s) = self.text.slice(start, end) else {
                return 0;
            };
            let chunk: Vec<char> = s.chars().collect();
            if let Some(i) = chunk.iter().rposition(|c| *c == PARAGRAPH_END) {
                return start + i + 1;
            }
            end = start;
        }
        0
    }

    /// Entity links: `(range, link)` per contiguous run of one target, sorted
    /// by start then target. Overlapping links (different targets) are listed
    /// separately.
    pub fn entity_links(&self) -> Vec<(Range<usize>, EntityLink)> {
        let mut open: std::collections::BTreeMap<String, (usize, EntityLink)> = Default::default();
        let mut out = Vec::new();
        let mut pos = 0usize;
        // Close every open link that is not in `here` at `pos`.
        fn step(
            open: &mut std::collections::BTreeMap<String, (usize, EntityLink)>,
            out: &mut Vec<(Range<usize>, EntityLink)>,
            here: &std::collections::BTreeMap<String, EntityLink>,
            pos: usize,
        ) {
            let closed: Vec<String> = open
                .keys()
                .filter(|k| !here.contains_key(*k))
                .cloned()
                .collect();
            for k in closed {
                let (start, link) = open.remove(&k).expect("open link");
                out.push((start..pos, link));
            }
            for (k, link) in here {
                open.entry(k.clone()).or_insert((pos, link.clone()));
            }
        }
        let none = std::collections::BTreeMap::new();
        for d in self.text.to_delta() {
            let TextDelta::Insert { insert, attributes } = d else {
                continue;
            };
            let mut here: std::collections::BTreeMap<String, EntityLink> = Default::default();
            if let Some(a) = &attributes {
                for (k, v) in a.iter() {
                    if let Some(t) = inline::entity_target(k)
                        && !v.is_null()
                        && let Some(link) = super::attrs::decode_entity(t, v)
                    {
                        here.insert(t.to_string(), link);
                    }
                }
            }
            // Newlines carry no inline marks as far as readers are concerned:
            // a link never spans a paragraph break.
            for (i, piece) in insert.split(PARAGRAPH_END).enumerate() {
                if i > 0 {
                    step(&mut open, &mut out, &none, pos);
                    pos += 1;
                }
                let n = piece.chars().count();
                if n > 0 {
                    step(&mut open, &mut out, &here, pos);
                    pos += n;
                }
            }
        }
        for (_, (start, link)) in open {
            out.push((start..pos, link));
        }
        out.sort_by(|a, b| (a.0.start, &a.1.target).cmp(&(b.0.start, &b.1.target)));
        out
    }

    /// Embed placeholders in document order: `(position, embed id)`. A
    /// placeholder whose entry is missing is still listed; see [`Self::embed`].
    pub fn embed_refs(&self) -> Vec<(usize, EmbedId)> {
        let mut out = Vec::new();
        let mut pos = 0usize;
        for d in self.text.to_delta() {
            if let TextDelta::Insert { insert, attributes } = d {
                let id = attributes
                    .as_ref()
                    .and_then(|a| a.get(inline::EMBED))
                    .and_then(|v| match v {
                        LoroValue::String(s) => EmbedId::parse(s).ok(),
                        _ => None,
                    });
                for (i, c) in insert.chars().enumerate() {
                    if c == OBJECT_CHAR
                        && let Some(id) = &id
                    {
                        out.push((pos + i, id.clone()));
                    }
                }
                pos += insert.chars().count();
            }
        }
        out
    }

    /// An embed's entry, if it exists.
    pub fn embed(&self, id: &EmbedId) -> Option<super::embed::EmbedView> {
        match self.embeds.get(id.as_str())? {
            ValueOrContainer::Container(loro::Container::Map(m)) => {
                Some(super::embed::EmbedView::read(id.clone(), &m))
            }
            _ => None,
        }
    }

    /// Cell (`row`, `col`) of table `table` as runs, with the inline marks
    /// this document's profile reads (a material note's table keeps
    /// highlight and inline code; line breaks are U+2028). `None` when the
    /// table, the row or the cell does not exist; an existing cell whose
    /// column is gone is still read ([`EmbedView::Table`] leaves it out).
    ///
    /// [`EmbedView::Table`]: super::embed::EmbedView::Table
    pub fn table_cell(&self, table: &EmbedId, row: &str, col: &str) -> Option<Vec<Run>> {
        let sub = |m: &LoroMap, k: &str| match m.get(k)? {
            ValueOrContainer::Container(loro::Container::Map(m)) => Some(m),
            _ => None,
        };
        let entry = sub(self.embeds, table.as_str())?;
        let cells = sub(&sub(&sub(&entry, "rows")?, row)?, "cells")?;
        let ValueOrContainer::Container(loro::Container::Text(t)) = cells.get(col)? else {
            return None;
        };
        Some(runs_of(t.to_delta(), self.profile))
    }

    /// Embed entries no placeholder points at (kept so Undo can bring a
    /// deleted placeholder back; a background cleanup may drop them).
    pub fn orphan_embeds(&self) -> Vec<EmbedId> {
        let used: HashSet<EmbedId> = self.embed_refs().into_iter().map(|(_, id)| id).collect();
        let mut out = Vec::new();
        self.embeds.for_each(|k, _| {
            if let Ok(id) = EmbedId::parse(k)
                && !used.contains(&id)
            {
                out.push(id);
            }
        });
        out.sort();
        out
    }

    /// An anchor over `range` (non-empty, before the final newline).
    pub fn anchor(&self, range: Range<usize>) -> Option<Anchor> {
        Anchor::new(self.text, range)
    }

    /// Where `anchor` points now. When Loro had to replay history, the
    /// result carries a cheaper replacement anchor ([`Resolved::updated`]).
    pub fn resolve(&self, anchor: &Anchor) -> Option<Resolved> {
        anchor.resolve(self.doc, self.text)
    }

    /// A cursor on the character at `pos` (`Side::Left` sticks to it).
    pub fn cursor(&self, pos: usize, side: Side) -> Option<loro::cursor::Cursor> {
        self.text.get_cursor(pos, side)
    }
}

/// Iterator over paragraphs; see [`ProseView::paragraphs`].
pub struct Paragraphs<'a> {
    view: ProseView<'a>,
    newlines: Vec<usize>,
    next: usize,
    start: usize,
    seen: HashSet<BlockId>,
    done: bool,
}

impl Iterator for Paragraphs<'_> {
    type Item = Paragraph;

    fn next(&mut self) -> Option<Paragraph> {
        if self.done {
            return None;
        }
        let mut p = if let Some(&nl) = self.newlines.get(self.next) {
            self.next += 1;
            let p = self.view.read_paragraph(self.start, Some(nl));
            self.start = nl + 1;
            p
        } else {
            self.done = true;
            if self.start >= self.view.len() {
                return None;
            }
            self.view.read_paragraph(self.start, None)
        };
        if let Some(id) = &p.stored_id
            && !self.seen.insert(id.clone())
        {
            p.id = None;
        }
        Some(p)
    }
}

/// A text's delta as runs: the inline marks `profile` reads, adjacent runs
/// with the same marks joined.
fn runs_of(delta: Vec<TextDelta>, profile: ProseProfile) -> Vec<Run> {
    let mut runs = Vec::new();
    for d in delta {
        if let TextDelta::Insert { insert, attributes } = d {
            let a: RawAttrs = attributes
                .as_ref()
                .map(|a| raw(a.iter()))
                .unwrap_or_default();
            push_run(&mut runs, insert, decode_inline(&a, profile));
        }
    }
    runs
}

fn push_run(runs: &mut Vec<Run>, text: String, marks: InlineMarks) {
    if let Some(last) = runs.last_mut()
        && last.marks == marks
    {
        last.text.push_str(&text);
        return;
    }
    runs.push(Run { text, marks });
}
