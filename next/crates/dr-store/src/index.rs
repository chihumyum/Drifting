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

use std::collections::HashMap;

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
    /// Paragraph index in the document.
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
    paragraph: u32,
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
        ord: paragraph,
        match_offset: offset,
        snippet: chars[start..end].iter().collect(),
    }
}

/// Paragraph numbers from sort keys (see [`ORD_GAP`]), counted on the
/// `(doc_id, ord)` index: one count per hit, until a document has had a
/// few hits, then its keys are read once and searched.
#[derive(Default)]
struct DocKeys(HashMap<String, (usize, Option<Vec<i64>>)>);

impl DocKeys {
    /// Hits in one document after which its keys are read whole.
    const READ_AFTER: usize = 4;

    fn position(&mut self, conn: &Connection, doc_id: &str, key: i64) -> Result<u32> {
        let entry = self.0.entry(doc_id.to_string()).or_default();
        entry.0 += 1;
        if entry.1.is_none() && entry.0 > Self::READ_AFTER {
            entry.1 = Some(
                conn.prepare_cached("SELECT ord FROM block_index WHERE doc_id = ?1 ORDER BY ord")?
                    .query_map([doc_id], |r| r.get(0))?
                    .collect::<rusqlite::Result<Vec<i64>>>()?,
            );
        }
        Ok(match &entry.1 {
            Some(keys) => keys.partition_point(|k| *k < key) as u32,
            None => conn
                .prepare_cached("SELECT count(*) FROM block_index WHERE doc_id = ?1 AND ord < ?2")?
                .query_row(params![doc_id, key], |r| r.get::<_, i64>(0))?
                as u32,
        })
    }
}

type HitRow = (String, Option<String>, i64, String);

fn hit_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<HitRow> {
    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
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
    {
        let keys = spaced_keys(index.derived.blocks.len())?;
        let mut insert = Inserter::new(&tx, index.doc_id, index.book_id)?;
        for (b, key) in index.derived.blocks.iter().zip(keys) {
            if b.heading > 3 {
                return Err(StoreError::invalid("heading", b.heading.to_string()));
            }
            insert.row(b, key)?;
        }
    }
    update_references(&tx, index.doc_id, index.book_id, &index.derived.references)?;
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

/// `block_index.ord` is a sort key, not the paragraph's number. A document
/// written whole gets keys `ORD_GAP` apart; a patch gives new paragraphs
/// keys between their neighbours' and touches no other row, so splitting a
/// paragraph writes two rows whatever comes after it. Only a patch that
/// finds no room renumbers the whole document. Readers that report a
/// paragraph's number count the keys before it ([`DocKeys`]).
///
/// Libraries written before this numbered paragraphs 0, 1, 2, …: they read
/// the same, and the first patch that needs room in such a document
/// renumbers it.
const ORD_GAP: i64 = 1 << 32;
/// Every key stays at or below this, so a renumbering can park rows above
/// all keys without overflowing.
const ORD_MAX: i64 = 1 << 60;

/// Keys for `n` paragraphs written whole.
fn spaced_keys(n: usize) -> Result<impl Iterator<Item = i64>> {
    if n as i64 > ORD_MAX / ORD_GAP {
        return Err(StoreError::invalid("index", format!("{n} paragraphs")));
    }
    Ok((0..n as i64).map(|i| i * ORD_GAP))
}

/// `k` increasing keys strictly between `lo` and `hi` (`None`: no paragraph
/// on that side), or `None` when they do not fit.
fn keys_between(lo: Option<i64>, hi: Option<i64>, k: usize) -> Option<Vec<i64>> {
    if k == 0 {
        return Some(Vec::new());
    }
    let k = k as i64;
    match hi {
        // At the end (the common case: writing on): a full gap each.
        None => {
            let start = match lo {
                Some(l) => l.checked_add(ORD_GAP)?,
                None => 0,
            };
            let last = start.checked_add(ORD_GAP.checked_mul(k - 1)?)?;
            (last <= ORD_MAX).then(|| (0..k).map(|j| start + j * ORD_GAP).collect())
        }
        // Between two paragraphs (or before the first): spread evenly.
        Some(h) => {
            let lo = lo.unwrap_or(-1);
            let step = (h - lo) / (k + 1);
            (step >= 1).then(|| (1..=k).map(|j| lo + j * step).collect())
        }
    }
}

/// Inserts paragraph rows and their FTS entries.
struct Inserter<'c> {
    insert: rusqlite::CachedStatement<'c>,
    fts: rusqlite::CachedStatement<'c>,
    conn: &'c Connection,
    doc_id: &'c str,
    book_id: Option<&'c str>,
}

impl<'c> Inserter<'c> {
    fn new(conn: &'c Connection, doc_id: &'c str, book_id: Option<&'c str>) -> Result<Self> {
        Ok(Self {
            insert: conn.prepare_cached(
                "INSERT INTO block_index (doc_id, book_id, ord, block_id, heading, chars, text)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?,
            fts: conn.prepare_cached("INSERT INTO block_fts (rowid, text) VALUES (?1, ?2)")?,
            conn,
            doc_id,
            book_id,
        })
    }

    fn row(&mut self, b: &BlockRow, key: i64) -> Result<()> {
        self.insert.execute(params![
            self.doc_id,
            self.book_id,
            key,
            b.block_id,
            b.heading,
            b.chars,
            b.text
        ])?;
        self.fts
            .execute(params![self.conn.last_insert_rowid(), b.text])?;
        Ok(())
    }
}

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
    // (id, key) of every row, in order: read from the (doc_id, ord) index
    // alone.
    let rows: Vec<(i64, i64)> = tx
        .prepare_cached("SELECT id, ord FROM block_index WHERE doc_id = ?1 ORDER BY ord")?
        .query_map([p.doc_id], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    if rows.len() != p.patch.base_paragraphs as usize {
        return Err(StoreError::IndexBase {
            doc_id: p.doc_id.into(),
            stored: rows.len() as u64,
            expected: p.patch.base_paragraphs as u64,
        });
    }
    // Splices that touch (one ends where the next starts) share one gap
    // between surviving paragraphs: plan their keys together.
    let mut groups: Vec<(usize, usize, Vec<&BlockRow>)> = Vec::new(); // (start, end, new rows)
    for sp in &p.patch.splices {
        let (at, end) = (sp.at as usize, (sp.at + sp.removed) as usize);
        match groups.last_mut() {
            Some(g) if g.1 == at => {
                g.1 = end;
                g.2.extend(&sp.blocks);
            }
            _ => groups.push((at, end, sp.blocks.iter().collect())),
        }
    }
    let planned: Option<Vec<Vec<i64>>> = groups
        .iter()
        .map(|(at, end, blocks)| {
            let lo = at.checked_sub(1).map(|i| rows[i].1);
            let hi = rows.get(*end).map(|r| r.1);
            keys_between(lo, hi, blocks.len())
        })
        .collect();
    {
        let mut text_of = tx.prepare_cached("SELECT text FROM block_index WHERE id = ?1")?;
        let mut fts_delete = tx.prepare_cached(
            "INSERT INTO block_fts (block_fts, rowid, text) VALUES ('delete', ?1, ?2)",
        )?;
        let mut delete = tx.prepare_cached("DELETE FROM block_index WHERE id = ?1")?;
        for (at, end, _) in &groups {
            for (id, _) in &rows[*at..*end] {
                let text: String = text_of.query_row([id], |r| r.get(0))?;
                fts_delete.execute(params![id, text])?;
                delete.execute([id])?;
            }
        }
    }
    let mut insert = Inserter::new(&tx, p.doc_id, p.book_id)?;
    if let Some(planned) = planned {
        for ((_, _, blocks), keys) in groups.iter().zip(planned) {
            for (b, key) in blocks.iter().zip(keys) {
                insert.row(b, key)?;
            }
        }
    } else {
        // No room somewhere: renumber the document. Park the surviving rows
        // above every key, then give every row, old and new, its spaced key.
        let mut keys = spaced_keys(p.patch.paragraphs() as usize)?;
        let mut key = || {
            keys.next()
                .ok_or_else(|| StoreError::invalid("index patch", "paragraph count"))
        };
        tx.prepare_cached("UPDATE block_index SET ord = ord + ?2 WHERE doc_id = ?1")?
            .execute(params![p.doc_id, ORD_MAX + 1])?;
        let mut set = tx.prepare_cached("UPDATE block_index SET ord = ?2 WHERE id = ?1")?;
        let mut next_old = 0usize;
        for (at, end, blocks) in &groups {
            for (id, _) in &rows[next_old..*at] {
                set.execute(params![id, key()?])?;
            }
            for b in blocks {
                insert.row(b, key()?)?;
            }
            next_old = *end;
        }
        for (id, _) in &rows[next_old..] {
            set.execute(params![id, key()?])?;
        }
    }
    drop(insert);
    if let Some(refs) = &p.patch.references {
        update_references(&tx, p.doc_id, p.book_id, refs)?;
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

/// A document's reference rows come back in the deriver's order by row id
/// (`references_from` orders by it). Ids are chosen with gaps, so a change
/// rewrites only the rows that differ: the rows before and after the change
/// keep theirs, and the new ones get ids in the gap between. With no room
/// (or rows from before the gaps, numbered one by one) the document's rows
/// are written again at the end.
const REF_GAP: i64 = 1 << 16;

/// (id, source_block, book_id, target_kind, target_id, kind, count)
type StoredRef = (
    i64,
    Option<String>,
    Option<String>,
    String,
    String,
    String,
    i64,
);

fn update_references(
    tx: &Connection,
    doc_id: &str,
    book_id: Option<&str>,
    refs: &[RefRow],
) -> Result<()> {
    let stored: Vec<StoredRef> = tx
        .prepare_cached(
            "SELECT id, source_block, book_id, target_kind, target_id, kind, count
             FROM reference WHERE source_doc = ?1 ORDER BY id",
        )?
        .query_map([doc_id], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let same = |s: &StoredRef, r: &RefRow| {
        s.1 == r.source_block
            && s.2.as_deref() == book_id
            && s.3 == r.target_kind
            && s.4 == r.target_id
            && s.5 == r.kind.as_str()
            && s.6 == i64::from(r.count.max(1))
    };
    let mut p = 0;
    while p < stored.len() && p < refs.len() && same(&stored[p], &refs[p]) {
        p += 1;
    }
    let mut q = 0;
    while q < stored.len() - p
        && q < refs.len() - p
        && same(&stored[stored.len() - 1 - q], &refs[refs.len() - 1 - q])
    {
        q += 1;
    }
    let gone = &stored[p..stored.len() - q];
    let new = &refs[p..refs.len() - q];
    if gone.is_empty() && new.is_empty() {
        return Ok(());
    }
    let mut delete = tx.prepare_cached("DELETE FROM reference WHERE id = ?1")?;
    for row in gone {
        delete.execute([row.0])?;
    }
    let lo = p.checked_sub(1).map(|i| stored[i].0);
    let hi = (q > 0).then(|| stored[stored.len() - q].0);
    let ids = match hi {
        // After every row of the document: past every id in the table.
        None => fresh_ref_ids(tx, new.len())?,
        Some(h) => {
            let k = new.len() as i64;
            let lo = lo.unwrap_or_else(|| h.saturating_sub((k + 1).saturating_mul(REF_GAP)));
            let step = (h - lo) / (k + 1);
            let ids: Vec<i64> = (1..=k).map(|j| lo + j * step).collect();
            let mut taken =
                tx.prepare_cached("SELECT EXISTS(SELECT 1 FROM reference WHERE id = ?1)")?;
            let mut free = step >= 1;
            for id in &ids {
                if !free {
                    break;
                }
                free = !taken.query_row([id], |r| r.get::<_, bool>(0))?;
            }
            if free {
                ids
            } else {
                // No room: the document's rows again, at the end.
                tx.prepare_cached("DELETE FROM reference WHERE source_doc = ?1")?
                    .execute([doc_id])?;
                let ids = fresh_ref_ids(tx, refs.len())?;
                return insert_references(tx, doc_id, book_id, refs, &ids);
            }
        }
    };
    insert_references(tx, doc_id, book_id, new, &ids)
}

/// `n` ids past every reference row, `REF_GAP` apart.
fn fresh_ref_ids(tx: &Connection, n: usize) -> Result<Vec<i64>> {
    let max: i64 = tx
        .prepare_cached("SELECT coalesce(max(id), 0) FROM reference")?
        .query_row([], |r| r.get(0))?;
    (1..=n as i64)
        .map(|j| {
            j.checked_mul(REF_GAP)
                .and_then(|d| max.checked_add(d))
                .ok_or_else(|| StoreError::invalid("reference", "row ids exhausted"))
        })
        .collect()
}

fn insert_references(
    tx: &Connection,
    doc_id: &str,
    book_id: Option<&str>,
    refs: &[RefRow],
    ids: &[i64],
) -> Result<()> {
    let mut insert = tx.prepare_cached(
        "INSERT INTO reference (id, source_doc, source_block, book_id, target_kind, target_id, kind, count)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )?;
    for (r, id) in refs.iter().zip(ids) {
        insert.execute(params![
            id,
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
    ///
    /// Full-text queries (three characters or more) read every match's row
    /// id, document and key first (no text), rank and cut them in Rust, and
    /// read only the rows kept. Shorter queries (`LIKE`) go document by
    /// document in `order` and stop at `limit`. Either way the cost no longer
    /// grows with the length of `order`.
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
        let fts = needle.len() >= TRIGRAM_MIN_CHARS;
        let pattern = if fts {
            fts_phrase(query)
        } else {
            like_pattern(query)
        };
        let conn = self.reader();
        let rows: Vec<HitRow> = if order.is_empty() {
            let sql = if fts {
                "SELECT b.doc_id, b.block_id, b.ord, b.text
                 FROM block_fts JOIN block_index b ON b.id = block_fts.rowid
                 WHERE block_fts MATCH ?1 AND (?2 IS NULL OR b.book_id = ?2)
                 ORDER BY b.doc_id, b.ord LIMIT ?3"
            } else {
                "SELECT b.doc_id, b.block_id, b.ord, b.text FROM block_index b
                 WHERE (?2 IS NULL OR b.book_id = ?2) AND b.text LIKE ?1 ESCAPE '\\'
                 ORDER BY b.doc_id, b.ord LIMIT ?3"
            };
            conn.prepare_cached(sql)?
                .query_map(params![pattern, book_id, limit as i64], hit_row)?
                .collect::<rusqlite::Result<_>>()?
        } else if !fts {
            // `LIKE` reads every row anyway: go document by document in the
            // given order on the (doc_id, ord) index and stop once there are
            // `limit` hits (a common character fills them from the first
            // chapters), then the documents not listed.
            let mut rows: Vec<HitRow> = Vec::new();
            let mut listed: Vec<&str> = Vec::with_capacity(order.len());
            let mut in_doc = conn.prepare_cached(
                "SELECT doc_id, block_id, ord, text FROM block_index
                 WHERE doc_id = ?1 AND (?2 IS NULL OR book_id = ?2) AND text LIKE ?3 ESCAPE '\\'
                 ORDER BY ord LIMIT ?4",
            )?;
            for doc in order {
                if rows.len() >= limit {
                    break;
                }
                if listed.contains(doc) {
                    continue;
                }
                listed.push(doc);
                let left = (limit - rows.len()) as i64;
                for row in in_doc.query_map(params![doc, book_id, pattern, left], hit_row)? {
                    rows.push(row?);
                }
            }
            if rows.len() < limit {
                let left = (limit - rows.len()) as i64;
                let listed = serde_json::to_string(&listed)
                    .map_err(|e| StoreError::invalid("search", e.to_string()))?;
                let mut rest = conn.prepare_cached(
                    "SELECT b.doc_id, b.block_id, b.ord, b.text FROM block_index b
                     WHERE (?2 IS NULL OR b.book_id = ?2) AND b.text LIKE ?1 ESCAPE '\\'
                       AND b.doc_id NOT IN (SELECT value FROM json_each(?3))
                     ORDER BY b.doc_id, b.ord LIMIT ?4",
                )?;
                for row in rest.query_map(params![pattern, book_id, listed, left], hit_row)? {
                    rows.push(row?);
                }
            }
            rows
        } else {
            let mut rank: HashMap<&str, usize> = HashMap::with_capacity(order.len());
            for (i, id) in order.iter().enumerate() {
                rank.entry(*id).or_insert(i);
            }
            let sql = "SELECT b.id, b.doc_id, b.ord
                 FROM block_fts JOIN block_index b ON b.id = block_fts.rowid
                 WHERE block_fts MATCH ?1 AND (?2 IS NULL OR b.book_id = ?2)";
            // (rank, the id of an unlisted document, key, row id)
            type Found = (usize, Option<String>, i64, i64);
            let mut found: Vec<Found> = conn
                .prepare_cached(sql)?
                .query_map(params![pattern, book_id], |r| {
                    let doc = r.get_ref(1)?.as_str().map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            1,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?;
                    let (n, unlisted) = match rank.get(doc) {
                        Some(&n) => (n, None),
                        None => (usize::MAX, Some(doc.to_string())),
                    };
                    Ok((n, unlisted, r.get(2)?, r.get(0)?))
                })?
                .collect::<rusqlite::Result<_>>()?;
            let by_place = |a: &Found, b: &Found| (a.0, &a.1, a.2).cmp(&(b.0, &b.1, b.2));
            if found.len() > limit {
                found.select_nth_unstable_by(limit, by_place);
                found.truncate(limit);
            }
            found.sort_unstable_by(by_place);
            let mut row = conn.prepare_cached(
                "SELECT doc_id, block_id, ord, text FROM block_index WHERE id = ?1",
            )?;
            found
                .iter()
                .map(|f| row.query_row([f.3], hit_row))
                .collect::<rusqlite::Result<_>>()?
        };
        let mut keys = DocKeys::default();
        rows.into_iter()
            .map(|(doc, block, key, text)| {
                let n = keys.position(&conn, &doc, key)?;
                Ok(hit(doc, block, n, &text, &needle))
            })
            .collect()
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
        let mut keys = DocKeys::default();
        let mut out = Vec::with_capacity(rows.len());
        for (key, block_id, heading, text) in rows {
            let text = text.trim_matches(is_js_whitespace);
            if !text.is_empty() {
                out.push(OutlineEntry {
                    ord: keys.position(&conn, doc_id, key)?,
                    block_id,
                    heading: heading as u8,
                    text: text.to_string(),
                });
            }
        }
        Ok(out)
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

    /// References made by every document of a book.
    pub fn references_in_book(&self, book_id: &str) -> Result<Vec<Reference>> {
        self.references_where("book_id = ?1", book_id)
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
