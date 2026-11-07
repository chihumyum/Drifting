//! Derived indexes: paragraphs (search, outline, lengths), references and
//! counts. Everything here is computed from Loro documents and can be
//! rebuilt; this module only stores and queries. Deciding what changed and
//! keeping the rows up to date incrementally is dr-workspace's job (F3).
//!
//! Search uses FTS5 with the trigram tokenizer, which needs at least three
//! characters per query. Chinese searches are often one or two characters
//! (人名、地名), so shorter queries fall back to `LIKE` over the same rows.

use loro::Frontiers;
use rusqlite::{OptionalExtension, params};

use crate::error::{Result, StoreError};
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
#[derive(Clone, Debug)]
pub struct DocIndex<'a> {
    pub doc_id: &'a str,
    pub book_id: Option<&'a str>,
    /// The version the rows were computed from.
    pub frontiers: &'a Frontiers,
    /// Counted by dr-text's rules (Chinese characters plus other words).
    pub words: u64,
    pub chars: u64,
    pub blocks: &'a [BlockRow],
    pub references: &'a [RefRow],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DocStats {
    pub doc_id: String,
    pub book_id: Option<String>,
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

impl Library {
    /// Replace everything derived from one document, in one transaction.
    pub fn index_doc(&self, index: &DocIndex<'_>) -> Result<()> {
        let conn = self.writer();
        let tx = conn.unchecked_transaction()?;
        tx.execute("DELETE FROM block_index WHERE doc_id = ?1", [index.doc_id])?;
        tx.execute(
            "DELETE FROM reference WHERE source_doc = ?1",
            [index.doc_id],
        )?;
        {
            let mut insert = tx.prepare_cached(
                "INSERT INTO block_index (doc_id, book_id, ord, block_id, heading, chars, text)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?;
            for (ord, b) in index.blocks.iter().enumerate() {
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
            }
            let mut insert = tx.prepare_cached(
                "INSERT INTO reference (source_doc, source_block, book_id, target_kind, target_id, kind, count)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?;
            for r in index.references {
                insert.execute(params![
                    index.doc_id,
                    r.source_block,
                    index.book_id,
                    r.target_kind,
                    r.target_id,
                    r.kind.as_str(),
                    r.count.max(1)
                ])?;
            }
        }
        tx.execute(
            "INSERT INTO doc_stats (doc_id, book_id, frontiers, words, chars, paragraphs, updated_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT (doc_id) DO UPDATE SET book_id = excluded.book_id,
               frontiers = excluded.frontiers, words = excluded.words, chars = excluded.chars,
               paragraphs = excluded.paragraphs, updated_ms = excluded.updated_ms",
            params![
                index.doc_id,
                index.book_id,
                index.frontiers.encode(),
                index.words as i64,
                index.chars as i64,
                index.blocks.len() as i64,
                now_ms()
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Remove everything derived from a document.
    pub fn remove_doc_index(&self, doc_id: &str) -> Result<()> {
        let conn = self.writer();
        let tx = conn.unchecked_transaction()?;
        tx.execute("DELETE FROM block_index WHERE doc_id = ?1", [doc_id])?;
        tx.execute("DELETE FROM reference WHERE source_doc = ?1", [doc_id])?;
        tx.execute("DELETE FROM doc_stats WHERE doc_id = ?1", [doc_id])?;
        tx.commit()?;
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
        let query = query.trim();
        let needle: Vec<char> = query.chars().collect();
        if needle.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        let conn = self.reader();
        let map = |r: &rusqlite::Row<'_>| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
            ))
        };
        let rows = if needle.len() >= TRIGRAM_MIN_CHARS {
            conn.prepare_cached(
                "SELECT b.doc_id, b.block_id, b.ord, b.text
                 FROM block_fts JOIN block_index b ON b.id = block_fts.rowid
                 WHERE block_fts MATCH ?1 AND (?2 IS NULL OR b.book_id = ?2)
                 ORDER BY b.doc_id, b.ord LIMIT ?3",
            )?
            .query_map(params![fts_phrase(query), book_id, limit as i64], map)?
            .collect::<rusqlite::Result<Vec<_>>>()?
        } else {
            conn.prepare_cached(
                "SELECT doc_id, block_id, ord, text FROM block_index
                 WHERE (?2 IS NULL OR book_id = ?2) AND text LIKE ?1 ESCAPE '\\'
                 ORDER BY doc_id, ord LIMIT ?3",
            )?
            .query_map(params![like_pattern(query), book_id, limit as i64], map)?
            .collect::<rusqlite::Result<Vec<_>>>()?
        };
        Ok(rows
            .into_iter()
            .map(|(doc, block, ord, text)| hit(doc, block, ord, &text, &needle))
            .collect())
    }

    /// The H1–H3 paragraphs of a document, in order.
    pub fn outline(&self, doc_id: &str) -> Result<Vec<OutlineEntry>> {
        let conn = self.reader();
        let rows = conn
            .prepare_cached(
                "SELECT ord, block_id, heading, text FROM block_index
                 WHERE doc_id = ?1 AND heading > 0 ORDER BY ord",
            )?
            .query_map([doc_id], |r| {
                Ok(OutlineEntry {
                    ord: r.get::<_, i64>(0)? as u32,
                    block_id: r.get(1)?,
                    heading: r.get::<_, i64>(2)? as u8,
                    text: r.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
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
                "SELECT doc_id, book_id, frontiers, words, chars, paragraphs, updated_ms
                 FROM doc_stats WHERE doc_id = ?1",
            )?
            .query_row([doc_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Vec<u8>>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, i64>(5)?,
                    r.get::<_, i64>(6)?,
                ))
            })
            .optional()?;
        row.map(
            |(doc_id, book_id, f, words, chars, paragraphs, updated_ms)| {
                Ok(DocStats {
                    doc_id,
                    book_id,
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

    /// Totals over the indexed documents of a book.
    pub fn book_stats(&self, book_id: &str) -> Result<BookStats> {
        let conn = self.reader();
        let (docs, words, chars, paragraphs): (i64, i64, i64, i64) = conn.query_row(
            "SELECT count(*), coalesce(sum(words), 0), coalesce(sum(chars), 0), coalesce(sum(paragraphs), 0)
             FROM doc_stats WHERE book_id = ?1",
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
