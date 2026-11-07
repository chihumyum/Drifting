//! Prose documents: one flat `LoroText` per body (decision D3).
//!
//! - A paragraph is a run of text terminated by `\n`; the body always ends
//!   with `\n` (the genesis change writes the first one).
//! - Paragraph attributes are marks on that one `\n` character.
//! - Every paragraph has a block id (`bid`). A fresh id is the op id of the
//!   paragraph's own `\n` (`"{counter}@{peer}"`), so ids are unique without
//!   randomness and a deterministic repair converges on every peer.

use std::collections::{BTreeMap, HashSet};
use std::ops::Range;

use loro::cursor::{PosType, Side};
use loro::{CommitOptions, ExportMode, LoroDoc, LoroMap, LoroText, LoroValue, TextDelta};

use crate::ids::genesis_peer;
use crate::schema::{self, block, inline};

/// Version of the genesis content. Bump it (and the schema version) if the
/// genesis change ever changes; the peer id is derived from it.
pub const GENESIS_VERSION: u32 = 0;

pub type Attrs = BTreeMap<String, LoroValue>;

/// One paragraph as read from the document.
#[derive(Clone, Debug, PartialEq)]
pub struct Paragraph {
    /// Block id. `None` only for a damaged document (see [`ProseDoc::repair_block_ids`]).
    pub id: Option<String>,
    /// Unicode-scalar range of the paragraph text, excluding its `\n`.
    pub range: Range<usize>,
    /// Position of the terminating `\n` (equal to `range.end`).
    pub newline: usize,
    /// Block attributes, `bid` excluded.
    pub attrs: Attrs,
    /// Inline runs: text and its inline marks.
    pub runs: Vec<(String, Attrs)>,
}

impl Paragraph {
    pub fn text(&self) -> String {
        self.runs.iter().map(|(t, _)| t.as_str()).collect()
    }

    pub fn heading(&self) -> Option<i64> {
        match self.attrs.get(block::HEADING) {
            Some(LoroValue::I64(v)) => Some(*v),
            _ => None,
        }
    }
}

/// The deterministic genesis change of a prose document: `meta` plus one
/// empty paragraph. Every device computes identical bytes, and Loro dedupes
/// changes by op id, so two devices that initialise the same document
/// concurrently do not produce two empty paragraphs.
pub fn genesis(doc_id: &str) -> Vec<u8> {
    let doc = LoroDoc::new();
    doc.config_text_style(schema::style_config());
    let peer = genesis_peer(doc_id, GENESIS_VERSION);
    doc.set_peer_id(peer).expect("genesis peer");
    let meta = doc.get_map(schema::prose::META);
    meta.insert("v", schema::SCHEMA_VERSION).unwrap();
    meta.insert("doc", doc_id).unwrap();
    let text = doc.get_text(schema::prose::BODY);
    text.insert(0, "\n").unwrap();
    text.mark(0..1, block::ID, format!("0@{peer}")).unwrap();
    doc.commit_with(CommitOptions::new().timestamp(0));
    doc.export(ExportMode::all_updates())
        .expect("export genesis")
}

/// A prose document and helpers that keep the v0 invariants.
#[derive(Clone)]
pub struct ProseDoc {
    pub doc: LoroDoc,
}

impl ProseDoc {
    /// A new document at genesis, editing as `peer`.
    pub fn create(doc_id: &str, peer: u64) -> Self {
        let doc = LoroDoc::new();
        schema::configure(&doc);
        doc.import(&genesis(doc_id)).expect("import genesis");
        doc.set_peer_id(peer).expect("peer id");
        Self { doc }
    }

    /// Wrap a document that was loaded from storage (already configured).
    pub fn from_doc(doc: LoroDoc) -> Self {
        Self { doc }
    }

    pub fn text(&self) -> LoroText {
        self.doc.get_text(schema::prose::BODY)
    }

    pub fn embeds(&self) -> LoroMap {
        self.doc.get_map(schema::prose::EMBEDS)
    }

    pub fn len(&self) -> usize {
        self.text().len_unicode()
    }

    pub fn is_empty(&self) -> bool {
        self.len() <= 1
    }

    /// Fresh block id for the `\n` at `pos`: that character's op id.
    pub fn fresh_block_id(&self, pos: usize) -> String {
        let cursor = self
            .text()
            .get_cursor(pos, Side::Middle)
            .expect("cursor on newline");
        let id = cursor.id.expect("newline has an op id");
        format!("{}@{}", id.counter, id.peer)
    }

    /// Read every paragraph.
    pub fn paragraphs(&self) -> Vec<Paragraph> {
        read_paragraphs(&self.text())
    }

    /// Block attributes (including `bid`) of the `\n` at `pos`.
    pub fn newline_attrs(&self, pos: usize) -> Attrs {
        let text = self.text();
        let delta = text
            .slice_delta(pos, pos + 1, PosType::Unicode)
            .expect("slice newline");
        let mut out = Attrs::new();
        for d in delta {
            if let TextDelta::Insert {
                attributes: Some(a),
                ..
            } = d
            {
                for (k, v) in a {
                    if block::ALL.contains(&k.as_str()) && !v.is_null() {
                        out.insert(k, v);
                    }
                }
            }
        }
        out
    }

    /// Position of the first `\n` at or after `pos`.
    pub fn next_newline(&self, pos: usize) -> usize {
        let text = self.text();
        let len = text.len_unicode();
        let mut start = pos;
        while start < len {
            let end = (start + 512).min(len);
            let chunk = text.slice(start, end).expect("slice");
            if let Some(i) = chunk.chars().position(|c| c == '\n') {
                return start + i;
            }
            start = end;
        }
        len.saturating_sub(1)
    }

    /// Start of the paragraph that contains `pos`.
    pub fn paragraph_start(&self, pos: usize) -> usize {
        let text = self.text();
        let mut end = pos;
        while end > 0 {
            let start = end.saturating_sub(512);
            let chunk: Vec<char> = text.slice(start, end).expect("slice").chars().collect();
            if let Some(i) = chunk.iter().rposition(|c| *c == '\n') {
                return start + i + 1;
            }
            end = start;
        }
        0
    }

    /// Insert text that contains no `\n` (use [`Self::split`] for Enter).
    pub fn insert_text(&self, pos: usize, s: &str) {
        debug_assert!(!s.contains('\n'));
        self.text().insert(pos, s).expect("insert");
    }

    /// Enter at `pos`. Returns the caret position afterwards.
    ///
    /// The new `\n` is always inserted at the caret (as in Quill), so text is
    /// only ever inserted before the genesis `\n` and that one stays the last
    /// character for good: no command deletes it, and an Undo can only delete
    /// what this peer inserted. Block ids follow the text:
    ///
    /// - at the end of a non-empty paragraph the new `\n` now terminates the
    ///   written text, so the paragraph's id and attributes move onto it and
    ///   the old `\n` (now ending the new empty paragraph) gets a fresh id;
    /// - at the start of a paragraph (or in an empty one) the new empty
    ///   paragraph above gets the fresh id;
    /// - in the middle the first half gets the fresh id and the second half
    ///   keeps the old `\n` and id.
    pub fn split(&self, pos: usize) -> usize {
        let text = self.text();
        let nl = self.next_newline(pos);
        let start = self.paragraph_start(pos);
        let old = self.newline_attrs(nl);
        text.insert(pos, "\n").expect("insert newline");
        let fresh: LoroValue = self.fresh_block_id(pos).into();
        let subset = |keys: &[&str]| -> Attrs {
            let mut a: Attrs = keys
                .iter()
                .filter_map(|k| old.get(*k).map(|v| (k.to_string(), v.clone())))
                .collect();
            a.insert(block::ID.to_string(), fresh.clone());
            a
        };
        if pos == nl && pos > start {
            self.set_newline_attrs(pos, &old);
            self.set_newline_attrs(nl + 1, &subset(block::INHERITED_AT_END));
        } else if pos == start {
            self.set_newline_attrs(pos, &subset(block::INHERITED_AT_END));
        } else {
            self.set_newline_attrs(pos, &subset(block::INHERITED_ON_SPLIT));
        }
        pos + 1
    }

    /// Make the block attributes of the `\n` at `nl` exactly `want`.
    ///
    /// A newly inserted `\n` can fall inside a paragraph mark: `ExpandType`
    /// only governs local inserts, so text another peer inserted at a
    /// paragraph's boundary concurrently with a mark on its `\n` can end up
    /// covered by that mark. Readers ignore block attributes on other
    /// characters; writers state every attribute of a new `\n` explicitly so
    /// a covered one does not inherit a stray heading or block id.
    pub fn set_newline_attrs(&self, nl: usize, want: &Attrs) {
        let text = self.text();
        let have = self.newline_attrs(nl);
        for key in block::ALL {
            match (want.get(*key), have.get(*key)) {
                (Some(w), Some(h)) if w == h => {}
                (Some(w), _) => text.mark(nl..nl + 1, key, w.clone()).expect("mark"),
                (None, Some(_)) => text.unmark(nl..nl + 1, key).expect("unmark"),
                (None, None) => {}
            }
        }
    }

    /// Delete `range`. When it removes one or more `\n`, the paragraph that
    /// contains `range.start` absorbs the rest of the one that contains
    /// `range.end`: the joined paragraph keeps the first one's block
    /// attributes and id (as ProseMirror joins into the first block). The
    /// exception is a range of whole paragraphs (it starts at a paragraph start
    /// and ends right after a `\n`): the paragraph after it is untouched. So a
    /// Backspace that removes an empty paragraph above keeps the one below.
    pub fn delete(&self, range: Range<usize>) {
        if range.is_empty() {
            return;
        }
        let text = self.text();
        let len = text.len_unicode();
        // Never delete the final newline.
        let end = range.end.min(len - 1);
        let start = range.start.min(end);
        if start == end {
            return;
        }
        let deleted = text.slice(start, end).expect("slice");
        if !deleted.contains('\n') {
            text.delete(start, end - start).expect("delete");
            return;
        }
        let first_start = self.paragraph_start(start);
        let first_nl = self.next_newline(start);
        let first_attrs = self.newline_attrs(first_nl);
        let survivor_nl = self.next_newline(end);
        text.delete(start, end - start).expect("delete");
        if start == first_start && deleted.ends_with('\n') {
            return;
        }
        let nl = survivor_nl - (end - start);
        self.set_newline_attrs(nl, &first_attrs);
    }

    /// Set (or clear with `None`) a block attribute of the paragraph whose
    /// `\n` is at `nl`.
    pub fn set_block_attr(&self, nl: usize, key: &str, value: Option<LoroValue>) {
        let text = self.text();
        match value {
            Some(v) => text.mark(nl..nl + 1, key, v).expect("mark"),
            None => text.unmark(nl..nl + 1, key).expect("unmark"),
        }
    }

    /// Apply an inline mark to `range`, skipping the paragraph newlines it
    /// crosses so `\n` only ever carries block attributes.
    pub fn mark_inline(&self, range: Range<usize>, key: &str, value: impl Into<LoroValue>) {
        let value = value.into();
        let text = self.text();
        let s = text.slice(range.start, range.end).expect("slice");
        let mut seg_start = range.start;
        for (i, c) in s.chars().enumerate() {
            if c == '\n' {
                let pos = range.start + i;
                if pos > seg_start {
                    text.mark(seg_start..pos, key, value.clone()).expect("mark");
                }
                seg_start = pos + 1;
            }
        }
        if range.end > seg_start {
            text.mark(seg_start..range.end, key, value).expect("mark");
        }
    }

    /// Link `range` to an entity (element, chapter, …). Different targets use
    /// different keys, so links can overlap.
    pub fn link_entity(&self, range: Range<usize>, target_id: &str, kind: &str) {
        let v = LoroValue::Map(vec![("kind".to_string(), LoroValue::from(kind))].into());
        self.mark_inline(range, &inline::entity_key(target_id), v);
    }

    pub fn unlink_entity(&self, range: Range<usize>, target_id: &str) {
        self.text()
            .unmark(range, &inline::entity_key(target_id))
            .expect("unmark");
    }

    /// Give every paragraph a unique block id. Later duplicates and missing
    /// ids get the op id of their own `\n`, so concurrent repairs on two
    /// peers write the same value. Returns how many paragraphs were fixed.
    pub fn repair_block_ids(&self) -> usize {
        let paras = self.paragraphs();
        let mut all: HashSet<String> = paras.iter().filter_map(|p| p.id.clone()).collect();
        let mut seen = HashSet::new();
        let mut fixes = Vec::new();
        for p in &paras {
            match &p.id {
                Some(id) if seen.insert(id.clone()) => {}
                _ => fixes.push(p.newline),
            }
        }
        let text = self.text();
        for nl in &fixes {
            // The newline's op id, unless another paragraph already carries
            // that string (an id moved by Enter or a join): then a suffix.
            let base = self.fresh_block_id(*nl);
            let mut id = base.clone();
            let mut n = 1;
            while all.contains(&id) {
                id = format!("{base}/{n}");
                n += 1;
            }
            all.insert(id.clone());
            text.mark(*nl..*nl + 1, block::ID, id).expect("mark bid");
        }
        fixes.len()
    }

    /// Insert an embed paragraph (`U+FFFC` + `\n`) at the start of the
    /// paragraph that begins at `para_start`, and its entry in `embeds`.
    /// Returns the embed id and the entry map.
    pub fn insert_embed(&self, para_start: usize, embed_id: &str, kind: &str) -> LoroMap {
        let text = self.text();
        let mut s = String::new();
        s.push(schema::OBJECT);
        s.push('\n');
        text.insert(para_start, &s).expect("insert embed");
        text.mark(para_start..para_start + 1, inline::EMBED, embed_id)
            .expect("mark embed");
        let nl = para_start + 1;
        let mut want = Attrs::new();
        want.insert(block::ID.to_string(), self.fresh_block_id(nl).into());
        self.set_newline_attrs(nl, &want);
        let entry = self
            .embeds()
            .ensure_mergeable_map(embed_id)
            .expect("embed entry");
        entry.insert("kind", kind).expect("kind");
        entry
    }

    /// Embed ids referenced from the body, in document order.
    pub fn embed_refs(&self) -> Vec<(usize, String)> {
        let mut out = Vec::new();
        let mut pos = 0;
        for d in self.text().to_delta() {
            if let TextDelta::Insert { insert, attributes } = d {
                let n = insert.chars().count();
                if let Some(LoroValue::String(id)) =
                    attributes.as_ref().and_then(|a| a.get(inline::EMBED))
                {
                    for (i, c) in insert.chars().enumerate() {
                        if c == schema::OBJECT {
                            out.push((pos + i, id.to_string()));
                        }
                    }
                }
                pos += n;
            }
        }
        out
    }
}

/// Read paragraphs from a body text. Inline marks on `\n` and block
/// attributes on other characters are ignored; a body that does not end with
/// `\n` gets a synthetic last paragraph without an id.
pub fn read_paragraphs(text: &LoroText) -> Vec<Paragraph> {
    let mut out = Vec::new();
    let mut runs: Vec<(String, Attrs)> = Vec::new();
    let mut para_start = 0usize;
    let mut pos = 0usize;
    for d in text.to_delta() {
        let TextDelta::Insert { insert, attributes } = d else {
            continue;
        };
        let inline_attrs: Attrs = attributes
            .as_ref()
            .map(|a| {
                a.iter()
                    .filter(|(k, v)| !block::ALL.contains(&k.as_str()) && !v.is_null())
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect()
            })
            .unwrap_or_default();
        let mut seg = String::new();
        for c in insert.chars() {
            if c == '\n' {
                if !seg.is_empty() {
                    push_run(&mut runs, std::mem::take(&mut seg), &inline_attrs);
                }
                let mut attrs: Attrs = attributes
                    .as_ref()
                    .map(|a| {
                        a.iter()
                            .filter(|(k, v)| block::ALL.contains(&k.as_str()) && !v.is_null())
                            .map(|(k, v)| (k.clone(), v.clone()))
                            .collect()
                    })
                    .unwrap_or_default();
                let id = match attrs.remove(block::ID) {
                    Some(LoroValue::String(s)) => Some(s.to_string()),
                    _ => None,
                };
                out.push(Paragraph {
                    id,
                    range: para_start..pos,
                    newline: pos,
                    attrs,
                    runs: std::mem::take(&mut runs),
                });
                pos += 1;
                para_start = pos;
            } else {
                seg.push(c);
                pos += 1;
            }
        }
        if !seg.is_empty() {
            push_run(&mut runs, seg, &inline_attrs);
        }
    }
    if !runs.is_empty() {
        out.push(Paragraph {
            id: None,
            range: para_start..pos,
            newline: pos,
            attrs: Attrs::new(),
            runs,
        });
    }
    out
}

fn push_run(runs: &mut Vec<(String, Attrs)>, text: String, attrs: &Attrs) {
    if let Some((last, last_attrs)) = runs.last_mut()
        && last_attrs == attrs
    {
        last.push_str(&text);
        return;
    }
    runs.push((text, attrs.clone()));
}

/// Entity links in a body: `(range, target id)` per contiguous run.
pub fn entity_links(text: &LoroText) -> Vec<(Range<usize>, String)> {
    let mut open: BTreeMap<String, usize> = BTreeMap::new();
    let mut out = Vec::new();
    let mut pos = 0usize;
    for d in text.to_delta() {
        let TextDelta::Insert { insert, attributes } = d else {
            continue;
        };
        let n = insert.chars().count();
        let keys: HashSet<String> = attributes
            .as_ref()
            .map(|a| {
                a.iter()
                    .filter(|(k, v)| inline::is_entity_key(k) && !v.is_null())
                    .map(|(k, _)| k.clone())
                    .collect()
            })
            .unwrap_or_default();
        let closed: Vec<String> = open
            .keys()
            .filter(|k| !keys.contains(*k))
            .cloned()
            .collect();
        for k in closed {
            let start = open.remove(&k).unwrap();
            out.push((start..pos, k[inline::ENTITY.len() + 1..].to_string()));
        }
        for k in keys {
            open.entry(k).or_insert(pos);
        }
        pos += n;
    }
    for (k, start) in open {
        out.push((start..pos, k[inline::ENTITY.len() + 1..].to_string()));
    }
    out.sort_by(|a, b| (a.0.start, &a.1).cmp(&(b.0.start, &b.1)));
    out
}
