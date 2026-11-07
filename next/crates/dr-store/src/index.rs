//! Derived indexes: paragraphs (search, outline, lengths), references and
//! counts. Everything here is computed from Loro documents and can be
//! rebuilt.
//!
//! Who computes them: dr-store itself, from Loro changes, not the editor.
//! A [`Deriver`] (implemented with dr-doc's knowledge of paragraphs, block
//! ids and entity links, and dr-text's counting) is registered in
//! [`crate::LibraryOptions::deriver`]. Each document holder hands it the Loro
//! diffs that accumulated since the last derivation when it is idle, and
//! stores the result. The rows and the seq they reflect (`index_state`) are
//! written in one transaction, and a write never moves a document's index
//! backwards. When a library opens, every document whose head is beyond its
//! `indexed_seq` is rebuilt (P0-E found 0.1's caches falling behind the text;
//! this is the cure).
//!
//! Search uses FTS5 with the trigram tokenizer, which needs at least three
//! characters per query. Chinese searches are often one or two characters
//! (人名、地名), so shorter queries fall back to `LIKE` over the same rows.

use loro::{Frontiers, LoroDoc};
use rusqlite::{Connection, OptionalExtension, params};

use crate::error::{Result, StoreError};
use crate::holder::ContainerChange;
use crate::{Library, now_ms};

/// One paragraph of a document, in order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlockRow {
    pub block_id: Option<String>,
    /// 0 for a body paragraph, 1–3 for H1–H3.
    pub heading: u8,
    /// Length in characters as shown (for height estimates).
    pub chars: u32,
    /// Plain text for search.
    pub text: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RefKind {
    /// An entity link mark in the text.
    Link,
    /// A name found in the text.
    Mention,
    /// An embedded object (table, material).
    Embed,
}

impl RefKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Link => "link",
            Self::Mention => "mention",
            Self::Embed => "embed",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "link" => Self::Link,
            "mention" => Self::Mention,
            "embed" => Self::Embed,
            _ => return None,
        })
    }
}

/// A reference from a document (and paragraph) to an object.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RefRow {
    pub source_block: Option<String>,
    pub target_kind: String,
    pub target_id: String,
    pub kind: RefKind,
    pub count: u32,
}

/// Everything derived from one document at one version.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Derived {
    /// Counted by dr-text's rules (Chinese characters plus other words).
    pub words: u64,
    pub chars: u64,
    pub blocks: Vec<BlockRow>,
    pub references: Vec<RefRow>,
}

/// What a [`Deriver`] produced.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum DerivedUpdate {
    /// Replace everything derived from the document.
    Full(Derived),
    /// Change only some paragraphs: what keystrokes need. Writing one changed
    /// paragraph of a 20 000-character chapter costs about a hundredth of a
    /// full replacement (the trigram index is rebuilt only for the rows that
    /// change).
    Patch(DerivedPatch),
}

/// In the stored paragraph order: replace the `removed` paragraphs starting
/// at `at` with `blocks` (which may be more, fewer or none).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Splice {
    pub at: u32,
    pub removed: u32,
    pub blocks: Vec<BlockRow>,
}

/// Paragraph-level changes to a document's derived rows.
///
/// Splices are sorted by `at` and do not overlap; positions are in the
/// stored order before the patch. The paragraphs after a splice move by its
/// size difference. A patch is only written onto exactly the rows it was
/// made from: if the stored document does not have `base_paragraphs` rows,
/// writing fails with [`StoreError::IndexBase`] and the holder derives the
/// document from scratch next time.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DerivedPatch {
    pub base_paragraphs: u32,
    pub splices: Vec<Splice>,
    /// The document's references after the patch, or `None` when they did
    /// not change (they are few, so a change rewrites them all).
    pub references: Option<Vec<RefRow>>,
    /// The new totals for the whole document.
    pub words: u64,
    pub chars: u64,
}

impl DerivedPatch {
    /// The patch that turns `old` into `new`: one splice around what lies
    /// between their common first and last paragraphs. A deriver that keeps
    /// what it derived last can send this instead of [`DerivedUpdate::Full`].
    pub fn between(old: &Derived, new: &Derived) -> Self {
        let (a, b) = (&old.blocks, &new.blocks);
        let prefix = a.iter().zip(b).take_while(|(x, y)| x == y).count();
        let max_suffix = a.len().min(b.len()) - prefix;
        let suffix = a
            .iter()
            .rev()
            .zip(b.iter().rev())
            .take(max_suffix)
            .take_while(|(x, y)| x == y)
            .count();
        let removed = a.len() - prefix - suffix;
        let inserted = &b[prefix..b.len() - suffix];
        let splices = if removed == 0 && inserted.is_empty() {
            Vec::new()
        } else {
            vec![Splice {
                at: prefix as u32,
                removed: removed as u32,
                blocks: inserted.to_vec(),
            }]
        };
        Self {
            base_paragraphs: a.len() as u32,
            splices,
            references: (old.references != new.references).then(|| new.references.clone()),
            words: new.words,
            chars: new.chars,
        }
    }

    /// Check the splices: sorted, apart, inside `base_paragraphs`.
    pub fn validate(&self) -> Result<()> {
        let mut end = 0u32;
        for s in &self.splices {
            let stop = s.at.checked_add(s.removed);
            if s.at < end || stop.is_none_or(|e| e > self.base_paragraphs) {
                return Err(StoreError::invalid(
                    "index patch",
                    format!(
                        "splice at {} removing {} out of order or out of range",
                        s.at, s.removed
                    ),
                ));
            }
            end = stop.unwrap_or(u32::MAX);
            if s.blocks.iter().any(|b| b.heading > 3) {
                return Err(StoreError::invalid("heading", "above 3"));
            }
        }
        Ok(())
    }

    /// The paragraph count after the patch.
    pub fn paragraphs(&self) -> u64 {
        self.splices
            .iter()
            .fold(self.base_paragraphs as i64, |n, s| {
                n - s.removed as i64 + s.blocks.len() as i64
            }) as u64
    }

    /// What `old` becomes (to check a patch, or keep a copy in step).
    pub fn apply_to(&self, old: &Derived) -> Result<Derived> {
        self.validate()?;
        if old.blocks.len() != self.base_paragraphs as usize {
            return Err(StoreError::IndexBase {
                doc_id: String::new(),
                stored: old.blocks.len() as u64,
                expected: self.base_paragraphs as u64,
            });
        }
        let mut blocks = Vec::with_capacity(self.paragraphs() as usize);
        let mut next = 0usize;
        for s in &self.splices {
            blocks.extend_from_slice(&old.blocks[next..s.at as usize]);
            blocks.extend(s.blocks.iter().cloned());
            next = (s.at + s.removed) as usize;
        }
        blocks.extend_from_slice(&old.blocks[next..]);
        Ok(Derived {
            words: self.words,
            chars: self.chars,
            blocks,
            references: self
                .references
                .clone()
                .unwrap_or_else(|| old.references.clone()),
        })
    }
}

/// What a deriver is given: the document on its holder thread (or a copy
/// loaded from SQLite), and the Loro diffs since the last derivation, or
/// `None` when it must start from scratch.
pub struct DeriveInput<'a> {
    pub doc_id: &'a str,
    pub kind: &'a str,
    pub book_id: Option<&'a str>,
    pub doc: &'a LoroDoc,
    pub changes: Option<&'a [ContainerChange]>,
    /// `true`: the open document of a holder (worth caching for the next
    /// diffs). `false`: a copy loaded from SQLite for a rebuild, read once.
    pub held: bool,
}

/// Computes a document's derived rows. Implemented outside dr-store (it needs
/// dr-doc's structure and dr-text's counting); `None` means "nothing derived
/// for this kind of document".
pub trait Deriver: Send + Sync {
    fn derive(&self, input: &DeriveInput<'_>) -> Option<DerivedUpdate>;
}

/// A patch to write with [`crate::Library::patch_index`].
#[derive(Clone, Debug)]
pub struct DocPatch<'a> {
    pub doc_id: &'a str,
    pub book_id: Option<&'a str>,
    /// The document's stored seq the result reflects (as for [`DocIndex`]).
    pub seq: i64,
    pub frontiers: &'a Frontiers,
    pub patch: &'a DerivedPatch,
}

/// Everything derived from one document at one version, for
/// [`crate::Library::index_doc`].
#[derive(Clone, Debug)]
pub struct DocIndex<'a> {
    pub doc_id: &'a str,
    pub book_id: Option<&'a str>,
    /// The document's stored seq the rows reflect: a write with a lower
    /// seq than the one already stored is ignored.
    pub seq: i64,
    /// The version the rows were computed from.
    pub frontiers: &'a Frontiers,
    pub derived: &'a Derived,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DocStats {
    pub doc_id: String,
    pub book_id: Option<String>,
    pub indexed_seq: i64,
    pub frontiers: Frontiers,
    pub words: u64,
    pub chars: u64,
    pub paragraphs: u64,
    pub updated_ms: i64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BookStats {
    pub docs: u64,
    pub words: u64,
    pub chars: u64,
    pub paragraphs: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutlineEntry {
    pub ord: u32,
    pub block_id: Option<String>,
    pub heading: u8,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchHit {
    pub doc_id: String,
    pub block_id: Option<String>,
    /// Paragraph index in the document.
    pub ord: u32,
    /// Character offset of the first match in the paragraph.
    pub match_offset: usize,
    /// The match with a little context.
    pub snippet: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reference {
    pub source_doc: String,
    pub source_block: Option<String>,
    pub book_id: Option<String>,
    pub target_kind: String,
    pub target_id: String,
    pub kind: RefKind,
    pub count: u32,
}

/// JavaScript's `\\s` (what the 0.1 client's `trim()` removes): the same set
/// as prose-metrics' `is_js_whitespace` (a test compares them).
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// Queries shorter than this many characters use `LIKE` instead of FTS5.
pub const TRIGRAM_MIN_CHARS: usize = 3;
const SNIPPET_CONTEXT: usize = 24;

fn like_pattern(query: &str) -> String {
    let mut p = String::with_capacity(query.len() + 2);
    p.push('%');
    for c in query.chars() {
        if matches!(c, '%' | '_' | '\\') {
            p.push('\\');
        }
        p.push(c);
    }
    p.push('%');
    p
}

fn fts_phrase(query: &str) -> String {
    format!("\"{}\"", query.replace('"', "\"\""))
}

/// Case-insensitive (simple case folding) character offset of `needle`.
fn find_chars(hay: &[char], needle: &[char]) -> Option<usize> {
    if needle.is_empty() || needle.len() > hay.len() {
        return None;
    }
    let fold = |c: char| c.to_lowercase().next().unwrap_or(c);
    (0..=hay.len() - needle.len()).find(|&i| {
        hay[i..i + needle.len()]
            .iter()
            .zip(needle)
            .all(|(a, b)| fold(*a) == fold(*b))
    })
}

fn hit(
    doc_id: String,
    block_id: Option<String>,
    ord: i64,
    text: &str,
    query: &[char],
) -> SearchHit {
    let chars: Vec<char> = text.chars().collect();
    let offset = find_chars(&chars, query).unwrap_or(0);
    let start = offset.saturating_sub(SNIPPET_CONTEXT);
    let end = (offset + query.len() + SNIPPET_CONTEXT).min(chars.len());
    SearchHit {
        doc_id,
        block_id,
        ord: ord as u32,
        match_offset: offset,
        snippet: chars[start..end].iter().collect(),
    }
}

/// Delete a document's paragraph rows and their FTS entries (the FTS table
/// is maintained by hand: no triggers).
fn delete_blocks(tx: &Connection, doc_id: &str) -> Result<()> {
    let old: Vec<(i64, String)> = tx
        .prepare_cached("SELECT id, text FROM block_index WHERE doc_id = ?1")?
        .query_map([doc_id], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut fts = tx.prepare_cached(
        "INSERT INTO block_fts (block_fts, rowid, text) VALUES ('delete', ?1, ?2)",
    )?;
    for (id, text) in &old {
        fts.execute(params![id, text])?;
    }
    tx.execute("DELETE FROM block_index WHERE doc_id = ?1", [doc_id])?;
    Ok(())
}

/// Write a document's derived rows and `index_state` in one transaction.
/// Returns false (and writes nothing) when the stored index is already at
/// `seq` or later, or the document is not registered.
pub(crate) fn write_index(conn: &Connection, index: &DocIndex<'_>) -> Result<bool> {
    let tx = conn.unchecked_transaction()?;
    let registered: bool = tx
        .prepare_cached("SELECT EXISTS(SELECT 1 FROM loro_doc WHERE doc_id = ?1)")?
        .query_row([index.doc_id], |r| r.get(0))?;
    if !registered {
        // Purged meanwhile (a background rebuild racing a purge).
        return Ok(false);
    }
    let stored: Option<i64> = tx
        .prepare_cached("SELECT indexed_seq FROM index_state WHERE doc_id = ?1")?
        .query_row([index.doc_id], |r| r.get(0))
        .optional()?;
    if stored.is_some_and(|s| s >= index.seq) {
        return Ok(false);
    }
    delete_blocks(&tx, index.doc_id)?;
    tx.execute(
        "DELETE FROM reference WHERE source_doc = ?1",
        [index.doc_id],
    )?;
    {
        let mut insert = tx.prepare_cached(
            "INSERT INTO block_index (doc_id, book_id, ord, block_id, heading, chars, text)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )?;
        let mut fts = tx.prepare_cached("INSERT INTO block_fts (rowid, text) VALUES (?1, ?2)")?;
        for (ord, b) in index.derived.blocks.iter().enumerate() {
            if b.heading > 3 {
                return Err(StoreError::invalid("heading", b.heading.to_string()));
            }
            insert.execute(params![
                index.doc_id,
                index.book_id,
                ord as i64,
                b.block_id,
                b.heading,
                b.chars,
                b.text
            ])?;
            fts.execute(params![tx.last_insert_rowid(), b.text])?;
        }
    }
    insert_references(&tx, index.doc_id, index.book_id, &index.derived.references)?;
    tx.execute(
        "INSERT INTO index_state (doc_id, book_id, indexed_seq, frontiers, words, chars, paragraphs, updated_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (doc_id) DO UPDATE SET book_id = excluded.book_id,
           indexed_seq = excluded.indexed_seq, frontiers = excluded.frontiers,
           words = excluded.words, chars = excluded.chars,
           paragraphs = excluded.paragraphs, updated_ms = excluded.updated_ms",
        params![
            index.doc_id,
            index.book_id,
            index.seq,
            index.frontiers.encode(),
            index.derived.words as i64,
            index.derived.chars as i64,
            index.derived.blocks.len() as i64,
            now_ms()
        ],
    )?;
    tx.commit()?;
    Ok(true)
}

/// Renumbering moves rows above every real paragraph index first, so the
/// `UNIQUE (doc_id, ord)` constraint never sees two rows on one index.
const RENUMBER_OFFSET: i64 = 1 << 40;

/// Write a paragraph patch and `index_state` in one transaction. Returns
/// false when the stored index is already at `seq` or later, or the document
/// is not registered; fails with [`StoreError::IndexBase`] when the stored
/// rows are not the ones the patch was made from.
pub(crate) fn write_patch(conn: &Connection, p: &DocPatch<'_>) -> Result<bool> {
    p.patch.validate()?;
    let tx = conn.unchecked_transaction()?;
    let registered: bool = tx
        .prepare_cached("SELECT EXISTS(SELECT 1 FROM loro_doc WHERE doc_id = ?1)")?
        .query_row([p.doc_id], |r| r.get(0))?;
    if !registered {
        return Ok(false);
    }
    let stored: Option<i64> = tx
        .prepare_cached("SELECT indexed_seq FROM index_state WHERE doc_id = ?1")?
        .query_row([p.doc_id], |r| r.get(0))
        .optional()?;
    let Some(stored) = stored else {
        // Nothing to patch: the first index of a document is a full one.
        return Err(StoreError::IndexBase {
            doc_id: p.doc_id.into(),
            stored: 0,
            expected: p.patch.base_paragraphs as u64,
        });
    };
    if stored >= p.seq {
        return Ok(false);
    }
    let rows: i64 = tx
        .prepare_cached("SELECT count(*) FROM block_index WHERE doc_id = ?1")?
        .query_row([p.doc_id], |r| r.get(0))?;
    if rows != p.patch.base_paragraphs as i64 {
        return Err(StoreError::IndexBase {
            doc_id: p.doc_id.into(),
            stored: rows as u64,
            expected: p.patch.base_paragraphs as u64,
        });
    }
    {
        let mut old = tx.prepare_cached(
            "SELECT id, text FROM block_index WHERE doc_id = ?1 AND ord >= ?2 AND ord < ?3",
        )?;
        let mut fts_delete = tx.prepare_cached(
            "INSERT INTO block_fts (block_fts, rowid, text) VALUES ('delete', ?1, ?2)",
        )?;
        let mut delete = tx.prepare_cached(
            "DELETE FROM block_index WHERE doc_id = ?1 AND ord >= ?2 AND ord < ?3",
        )?;
        for s in &p.patch.splices {
            if s.removed == 0 {
                continue;
            }
            let end = s.at as i64 + s.removed as i64;
            let gone: Vec<(i64, String)> = old
                .query_map(params![p.doc_id, s.at, end], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?;
            for (id, text) in &gone {
                fts_delete.execute(params![id, text])?;
            }
            delete.execute(params![p.doc_id, s.at, end])?;
        }
        // Move the paragraphs between and after splices by the size change
        // before them.
        let mut segments: Vec<(i64, i64, i64)> = Vec::new(); // (from, to, delta), old indexes
        let mut delta = 0i64;
        for (i, s) in p.patch.splices.iter().enumerate() {
            delta += s.blocks.len() as i64 - s.removed as i64;
            let from = s.at as i64 + s.removed as i64;
            let to = p
                .patch
                .splices
                .get(i + 1)
                .map(|n| n.at as i64)
                .unwrap_or(p.patch.base_paragraphs as i64);
            if from < to {
                segments.push((from, to, delta));
            }
        }
        if let Some(first) = segments.iter().position(|(_, _, d)| *d != 0) {
            let moving = &segments[first..];
            tx.prepare_cached(
                "UPDATE block_index SET ord = ord + ?2 WHERE doc_id = ?1 AND ord >= ?3",
            )?
            .execute(params![p.doc_id, RENUMBER_OFFSET, moving[0].0])?;
            let mut settle = tx.prepare_cached(
                "UPDATE block_index SET ord = ord - ?2 + ?3 WHERE doc_id = ?1 AND ord >= ?4 AND ord < ?5",
            )?;
            for (from, to, d) in moving {
                settle.execute(params![
                    p.doc_id,
                    RENUMBER_OFFSET,
                    d,
                    from + RENUMBER_OFFSET,
                    to + RENUMBER_OFFSET
                ])?;
            }
        }
        // The new paragraphs, at their indexes after the patch.
        let mut insert = tx.prepare_cached(
            "INSERT INTO block_index (doc_id, book_id, ord, block_id, heading, chars, text)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )?;
        let mut fts = tx.prepare_cached("INSERT INTO block_fts (rowid, text) VALUES (?1, ?2)")?;
        let mut shift = 0i64;
        for s in &p.patch.splices {
            let start = s.at as i64 + shift;
            for (k, b) in s.blocks.iter().enumerate() {
                insert.execute(params![
                    p.doc_id,
                    p.book_id,
                    start + k as i64,
                    b.block_id,
                    b.heading,
                    b.chars,
                    b.text
                ])?;
                fts.execute(params![tx.last_insert_rowid(), b.text])?;
            }
            shift += s.blocks.len() as i64 - s.removed as i64;
        }
    }
    if let Some(refs) = &p.patch.references {
        tx.execute("DELETE FROM reference WHERE source_doc = ?1", [p.doc_id])?;
        insert_references(&tx, p.doc_id, p.book_id, refs)?;
    }
    tx.prepare_cached(
        "UPDATE index_state SET book_id = ?2, indexed_seq = ?3, frontiers = ?4, words = ?5,
           chars = ?6, paragraphs = ?7, updated_ms = ?8 WHERE doc_id = ?1",
    )?
    .execute(params![
        p.doc_id,
        p.book_id,
        p.seq,
        p.frontiers.encode(),
        p.patch.words as i64,
        p.patch.chars as i64,
        p.patch.paragraphs() as i64,
        now_ms()
    ])?;
    tx.commit()?;
    Ok(true)
}

fn insert_references(
    tx: &Connection,
    doc_id: &str,
    book_id: Option<&str>,
    refs: &[RefRow],
) -> Result<()> {
    let mut insert = tx.prepare_cached(
        "INSERT INTO reference (source_doc, source_block, book_id, target_kind, target_id, kind, count)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )?;
    for r in refs {
        insert.execute(params![
            doc_id,
            r.source_block,
            book_id,
            r.target_kind,
            r.target_id,
            r.kind.as_str(),
            r.count.max(1)
        ])?;
    }
    Ok(())
}

/// Remove everything derived from a document, inside the caller's
/// transaction.
pub(crate) fn delete_index(tx: &Connection, doc_id: &str) -> Result<()> {
    delete_blocks(tx, doc_id)?;
    tx.execute("DELETE FROM reference WHERE source_doc = ?1", [doc_id])?;
    tx.execute("DELETE FROM index_state WHERE doc_id = ?1", [doc_id])?;
    Ok(())
}

impl Library {
    /// Replace everything derived from one document, in one transaction,
    /// unless the stored index already reflects `seq` or later (returns
    /// false then). Normally the holders do this through the deriver.
    pub fn index_doc(&self, index: &DocIndex<'_>) -> Result<bool> {
        let written = write_index(&self.writer(), index)?;
        if written {
            self.notify_local(crate::LocalChange::new(
                "index",
                index.doc_id,
                crate::LocalChangeKind::Update,
            ));
        }
        Ok(written)
    }

    /// Write a paragraph patch (see [`DerivedPatch`]) unless the stored index
    /// already reflects `seq` or later (returns false then).
    pub fn patch_index(&self, patch: &DocPatch<'_>) -> Result<bool> {
        let written = write_patch(&self.writer(), patch)?;
        if written {
            self.notify_local(crate::LocalChange::new(
                "index",
                patch.doc_id,
                crate::LocalChangeKind::Update,
            ));
        }
        Ok(written)
    }

    /// Remove everything derived from a document.
    pub fn remove_doc_index(&self, doc_id: &str) -> Result<()> {
        {
            let conn = self.writer();
            let tx = conn.unchecked_transaction()?;
            delete_index(&tx, doc_id)?;
            tx.commit()?;
        }
        self.notify_local(crate::LocalChange::new(
            "index",
            doc_id,
            crate::LocalChangeKind::Delete,
        ));
        Ok(())
    }

    /// Paragraphs containing `query`, in document order (by doc id, then
    /// paragraph), optionally within one book. Case-insensitive.
    pub fn search(
        &self,
        book_id: Option<&str>,
        query: &str,
        limit: usize,
    ) -> Result<Vec<SearchHit>> {
        self.search_in_order(book_id, query, limit, &[])
    }

    /// [`Self::search`], with documents ranked in `order` (say the book's
    /// chapter order, which the book document knows and dr-store does not):
    /// hits come document by document in that order, then from documents
    /// not listed (by id), and `limit` cuts the list in that order.
    pub fn search_in_order(
        &self,
        book_id: Option<&str>,
        query: &str,
        limit: usize,
        order: &[&str],
    ) -> Result<Vec<SearchHit>> {
        let query = query.trim();
        let needle: Vec<char> = query.chars().collect();
        if needle.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        // The ranks as a table of values: ?4, ?5, … are the doc ids.
        let (with, join, rank) = if order.is_empty() {
            (String::new(), "", "")
        } else {
            let values: Vec<String> = (0..order.len())
                .map(|i| format!("(?{}, {i})", i + 4))
                .collect();
            (
                format!("WITH rank (doc_id, r) AS (VALUES {}) ", values.join(", ")),
                " LEFT JOIN rank ON rank.doc_id = b.doc_id",
                "coalesce(rank.r, 9223372036854775807), ",
            )
        };
        let (from, pattern) = if needle.len() >= TRIGRAM_MIN_CHARS {
            (
                format!(
                    "FROM block_fts JOIN block_index b ON b.id = block_fts.rowid{join}
                     WHERE block_fts MATCH ?1 AND (?2 IS NULL OR b.book_id = ?2)"
                ),
                fts_phrase(query),
            )
        } else {
            (
                format!(
                    "FROM block_index b{join}
                     WHERE (?2 IS NULL OR b.book_id = ?2) AND b.text LIKE ?1 ESCAPE '\\'"
                ),
                like_pattern(query),
            )
        };
        let sql = format!(
            "{with}SELECT b.doc_id, b.block_id, b.ord, b.text {from}
             ORDER BY {rank}b.doc_id, b.ord LIMIT ?3"
        );
        let mut args: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(3 + order.len());
        let limit = limit as i64;
        args.push(&pattern);
        args.push(&book_id);
        args.push(&limit);
        for id in order {
            args.push(id);
        }
        let conn = self.reader();
        let rows = conn
            .prepare_cached(&sql)?
            .query_map(args.as_slice(), |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows
            .into_iter()
            .map(|(doc, block, ord, text)| hit(doc, block, ord, &text, &needle))
            .collect())
    }

    /// The H1–H3 paragraphs of a document, in order, by dr-text's outline
    /// rule (the 0.1 client's `outline.ts`): a heading's text is trimmed of
    /// JavaScript whitespace, and a heading with nothing left is not listed.
    pub fn outline(&self, doc_id: &str) -> Result<Vec<OutlineEntry>> {
        let conn = self.reader();
        let rows = conn
            .prepare_cached(
                "SELECT ord, block_id, heading, text FROM block_index
                 WHERE doc_id = ?1 AND heading > 0 ORDER BY ord",
            )?
            .query_map([doc_id], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows
            .into_iter()
            .filter_map(|(ord, block_id, heading, text)| {
                let text = text.trim_matches(is_js_whitespace);
                (!text.is_empty()).then(|| OutlineEntry {
                    ord: ord as u32,
                    block_id,
                    heading: heading as u8,
                    text: text.to_string(),
                })
            })
            .collect())
    }

    /// Paragraph lengths of a document, in order, without decoding it.
    pub fn block_lengths(&self, doc_id: &str) -> Result<Vec<u32>> {
        let conn = self.reader();
        let rows = conn
            .prepare_cached("SELECT chars FROM block_index WHERE doc_id = ?1 ORDER BY ord")?
            .query_map([doc_id], |r| Ok(r.get::<_, i64>(0)? as u32))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    fn references_where(&self, clause: &str, key: &str) -> Result<Vec<Reference>> {
        let conn = self.reader();
        let sql = format!(
            "SELECT source_doc, source_block, book_id, target_kind, target_id, kind, count
             FROM reference WHERE {clause} ORDER BY source_doc, id"
        );
        let rows = conn
            .prepare_cached(&sql)?
            .query_map([key], |r| {
                let kind: String = r.get(5)?;
                Ok(Reference {
                    source_doc: r.get(0)?,
                    source_block: r.get(1)?,
                    book_id: r.get(2)?,
                    target_kind: r.get(3)?,
                    target_id: r.get(4)?,
                    kind: RefKind::parse(&kind).unwrap_or(RefKind::Link),
                    count: r.get::<_, i64>(6)? as u32,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// References to an object, from every document.
    pub fn references_to(&self, target_id: &str) -> Result<Vec<Reference>> {
        self.references_where("target_id = ?1", target_id)
    }

    /// References made by one document.
    pub fn references_from(&self, doc_id: &str) -> Result<Vec<Reference>> {
        self.references_where("source_doc = ?1", doc_id)
    }

    pub fn doc_stats(&self, doc_id: &str) -> Result<Option<DocStats>> {
        let conn = self.reader();
        let row = conn
            .prepare_cached(
                "SELECT doc_id, book_id, indexed_seq, frontiers, words, chars, paragraphs, updated_ms
                 FROM index_state WHERE doc_id = ?1",
            )?
            .query_row([doc_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, Vec<u8>>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, i64>(5)?,
                    r.get::<_, i64>(6)?,
                    r.get::<_, i64>(7)?,
                ))
            })
            .optional()?;
        row.map(
            |(doc_id, book_id, indexed_seq, f, words, chars, paragraphs, updated_ms)| {
                Ok(DocStats {
                    doc_id,
                    book_id,
                    indexed_seq,
                    frontiers: Frontiers::decode(&f)?,
                    words: words as u64,
                    chars: chars as u64,
                    paragraphs: paragraphs as u64,
                    updated_ms,
                })
            },
        )
        .transpose()
    }

    /// Documents whose stored head is beyond their index (or that have no
    /// index yet), by id.
    pub fn stale_index_docs(&self) -> Result<Vec<String>> {
        let conn = self.reader();
        let rows = conn
            .prepare_cached(
                "SELECT h.doc_id FROM loro_head h LEFT JOIN index_state i ON i.doc_id = h.doc_id
                 WHERE i.indexed_seq IS NULL OR h.seq > i.indexed_seq ORDER BY h.doc_id",
            )?
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(rows)
    }

    /// Totals over the indexed documents of a book.
    pub fn book_stats(&self, book_id: &str) -> Result<BookStats> {
        let conn = self.reader();
        let (docs, words, chars, paragraphs): (i64, i64, i64, i64) = conn.query_row(
            "SELECT count(*), coalesce(sum(words), 0), coalesce(sum(chars), 0), coalesce(sum(paragraphs), 0)
             FROM index_state WHERE book_id = ?1",
            [book_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;
        Ok(BookStats {
            docs: docs as u64,
            words: words as u64,
            chars: chars as u64,
            paragraphs: paragraphs as u64,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patterns_escape_specials() {
        assert_eq!(like_pattern("a%b_c\\"), "%a\\%b\\_c\\\\%");
        assert_eq!(fts_phrase("say \"hi\""), "\"say \"\"hi\"\"\"");
    }

    #[test]
    fn snippets_find_the_match() {
        let q: Vec<char> = "安娜".chars().collect();
        let h = hit("d".into(), None, 0, "她叫安娜。", &q);
        assert_eq!(h.match_offset, 2);
        assert_eq!(h.snippet, "她叫安娜。");
        let q: Vec<char> = "ANNA".chars().collect();
        assert_eq!(hit("d".into(), None, 0, "dear anna", &q).match_offset, 5);
    }
}
