//! Canonical v3 prose mention and shared-paragraph co-occurrence queries.
//!
//! Reads the derived `reference` rows of `body:<entry>/<module>` documents in a
//! book (`Library::entry_module_references_in_book`), scoped to live v3 entries.
//! Two entries co-occur once for every distinct `(source_doc, source_block)`
//! paragraph in which both appear as `Link` or `Mention` targets; references
//! without a `source_block` contribute to mention totals only and never form a
//! synthetic paragraph.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use dr_model::id::BookId;
use dr_store::index::RefKind;

use crate::error::{Result, WsError};
use crate::workspace::Workspace;

/// Mention totals and shared-paragraph co-occurrence counts for live v3 entries in a book.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EntryCooccurrenceGraph {
    /// Total prose mention/link count per live target `EntryId`.
    pub mentions: BTreeMap<String, u32>,
    /// Shared-paragraph (`(source_doc, source_block)`) count per ordered pair `(a, b)` (`a < b`).
    pub pairs: BTreeMap<(String, String), u32>,
}

impl Workspace {
    /// Compute prose mention totals and true shared-paragraph co-occurrence
    /// counts across all live v3 `body:<entry>/<module>` documents of `book`.
    pub fn entry_cooccurrences(&self, book: &str) -> Result<EntryCooccurrenceGraph> {
        let book_id = BookId::parse(book).map_err(|e| WsError::Invalid(e.to_string()))?;
        let slot = self.book_slot(&book_id)?;
        let live_entries: HashSet<String> = slot
            .reader_v3
            .view()
            .entries_raw()
            .into_iter()
            .filter(|e| !e.is_trashed())
            .map(|e| e.id.to_string())
            .collect();

        self.flush_book_prose_indices(&book_id)?;
        let rows = self
            .inner
            .lib
            .entry_module_references_in_book(book_id.as_str())?;

        let mut mentions: BTreeMap<String, u32> = BTreeMap::new();
        let mut by_paragraph: BTreeMap<(&str, &str), BTreeSet<&str>> = BTreeMap::new();

        for r in &rows {
            if r.count == 0 {
                continue;
            }
            if !matches!(r.kind, RefKind::Link | RefKind::Mention) || r.target_kind != "entry" {
                continue;
            }
            if r.source_entry == r.target_id {
                continue;
            }
            if !live_entries.contains(r.source_entry.as_str())
                || !live_entries.contains(r.target_id.as_str())
            {
                continue;
            }
            *mentions.entry(r.target_id.clone()).or_insert(0) += r.count;
            if let Some(block_id) = r.source_block.as_deref().filter(|b| !b.is_empty()) {
                by_paragraph
                    .entry((r.source_doc.as_str(), block_id))
                    .or_default()
                    .insert(r.target_id.as_str());
            }
        }

        let mut pairs: BTreeMap<(String, String), u32> = BTreeMap::new();
        for targets in by_paragraph.values() {
            if targets.len() < 2 {
                continue;
            }
            let sorted: Vec<&str> = targets.iter().copied().collect();
            for i in 0..sorted.len() {
                for j in (i + 1)..sorted.len() {
                    let key = (sorted[i].to_owned(), sorted[j].to_owned());
                    *pairs.entry(key).or_insert(0) += 1;
                }
            }
        }

        Ok(EntryCooccurrenceGraph { mentions, pairs })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Actor, WorkspaceOptions, library_options};
    use dr_store::Library;
    use dr_store::index::{DOC_KIND_BODY, Derived, DocIndex, RefRow, format_body_doc_id};
    use serde_json::json;

    #[test]
    fn counts_true_shared_paragraphs_skips_null_blocks_and_excludes_trashed_entries() {
        let dir = tempfile::tempdir().expect("tempdir");
        let lib = Library::open(dir.path(), library_options("test")).expect("open lib");
        let ws = Workspace::open(lib.clone(), WorkspaceOptions::default()).expect("open ws");
        let created = ws
            .call(
                &Actor::User,
                "project.create",
                json!({ "name": "Test Book" }),
            )
            .expect("create novel book");
        let book_id = created["output"]["id"]
            .as_str()
            .expect("book id")
            .to_owned();

        let parsed_book = BookId::parse(&book_id).expect("parse book id");
        let raw = lib
            .load_copy(&format!("book:{book_id}"))
            .expect("load book copy");
        let borrowed = dr_doc::v3::BorrowedBookV3::new(&raw, &parsed_book).expect("borrowed book");
        let roots = dr_doc::v3::find_novel_roots(&borrowed.view()).expect("novel roots");

        let make_char = |title: &str| -> String {
            ws.call(
                &Actor::User,
                "entry.create",
                json!({
                    "book": book_id,
                    "parent": roots.cat_character,
                    "template": "tpl-character",
                    "title": title,
                }),
            )
            .expect("create character")["output"]["id"]
                .as_str()
                .expect("char id")
                .to_owned()
        };
        let a = make_char("陈石");
        let b = make_char("沈青");
        let c = make_char("周木");

        // Paragraph 0 mentions 陈石 (a) and 沈青 (b) -> co-occur once.
        // Paragraph 1 mentions 陈石 (a) and 周木 (c) -> co-occur once; b and c are in different paragraphs -> 0 co-occurrences.
        let ch = ws
            .call(
                &Actor::Import,
                "entry.create",
                json!({
                    "book": book_id,
                    "parent": roots.manuscript,
                    "template": "tpl-chapter",
                    "title": "第一章",
                    "bodies": {
                        "mod-prose": "陈石与沈青在灯下交谈。\n\n陈石再见周木于河岸。"
                    }
                }),
            )
            .expect("create chapter")["output"]["id"]
            .as_str()
            .expect("chapter id")
            .to_owned();

        let graph = ws.entry_cooccurrences(&book_id).expect("cooccurrences");
        assert_eq!(graph.mentions.get(&a), Some(&2));
        assert_eq!(graph.mentions.get(&b), Some(&1));
        assert_eq!(graph.mentions.get(&c), Some(&1));

        let pair = |x: &str, y: &str| -> (String, String) {
            if x < y {
                (x.to_owned(), y.to_owned())
            } else {
                (y.to_owned(), x.to_owned())
            }
        };
        assert_eq!(graph.pairs.get(&pair(&a, &b)), Some(&1));
        assert_eq!(graph.pairs.get(&pair(&a, &c)), Some(&1));
        assert_eq!(
            graph.pairs.get(&pair(&b, &c)),
            None,
            "entries in different paragraphs of the same document must not be paired"
        );

        // Inject two `source_block: None` references in another body doc and verify they count as mentions ONLY, never paired.
        let null_doc = format_body_doc_id(&ch, "mod-extra");
        lib.register(&null_doc, DOC_KIND_BODY, Some(&book_id))
            .expect("register null-block body doc");
        let derived = Derived {
            words: 0,
            chars: 0,
            blocks: Vec::new(),
            references: vec![
                RefRow {
                    source_block: None,
                    target_kind: "entry".into(),
                    target_id: b.clone(),
                    kind: RefKind::Mention,
                    count: 3,
                },
                RefRow {
                    source_block: None,
                    target_kind: "entry".into(),
                    target_id: c.clone(),
                    kind: RefKind::Mention,
                    count: 2,
                },
            ],
        };
        assert!(
            lib.index_doc(&DocIndex {
                doc_id: &null_doc,
                book_id: Some(&book_id),
                seq: 1,
                frontiers: &loro::Frontiers::default(),
                derived: &derived,
            })
            .expect("index null-block doc")
        );

        let graph2 = ws
            .entry_cooccurrences(&book_id)
            .expect("cooccurrences with null block");
        assert_eq!(graph2.mentions.get(&b), Some(&4));
        assert_eq!(graph2.mentions.get(&c), Some(&3));
        assert_eq!(
            graph2.pairs.get(&pair(&b, &c)),
            None,
            "source_block = None must never form a synthetic co-occurrence paragraph"
        );

        // Trashing `b` immediately excludes `b` from mentions and pairs.
        ws.call(
            &Actor::User,
            "entry.trash",
            json!({ "book": book_id, "id": b }),
        )
        .expect("trash b");
        let graph3 = ws
            .entry_cooccurrences(&book_id)
            .expect("cooccurrences after trash");
        assert!(!graph3.mentions.contains_key(&b));
        assert!(!graph3.pairs.contains_key(&pair(&a, &b)));
        assert_eq!(graph3.pairs.get(&pair(&a, &c)), Some(&1));

        ws.close();
    }
}
