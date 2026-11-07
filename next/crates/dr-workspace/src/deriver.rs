//! The derived index of prose documents (search, outline, lengths,
//! references), computed by dr-store's holders when idle.
//!
//! dr-store hands the deriver the holder's raw `LoroDoc`; dr-doc reads only
//! its own documents, so the deriver exports a snapshot and reads it through
//! a detached `ProseReader` (adapter, f3-workspace.md "待协调" F1-1). It runs
//! on the holder thread between writes, so exporting cuts no write in two.
//!
//! Word counts use a simple stand-in until dr-text exists: every CJK
//! character is a word, and so is every run of other letters or digits.

use dr_doc::prose::ProseReader;
use dr_model::DocId;
use dr_store::index::{BlockRow, DeriveInput, Derived, DerivedUpdate, Deriver, RefKind, RefRow};
use loro::ExportMode;
use std::collections::BTreeMap;

pub(crate) struct ProseDeriver;

fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0x20000..=0x2FA1F
        | 0x3040..=0x30FF | 0xAC00..=0xD7AF)
}

/// Stand-in word count: CJK characters plus runs of other alphanumerics.
pub fn count_words(s: &str) -> u64 {
    let mut n = 0u64;
    let mut in_word = false;
    for c in s.chars() {
        if is_cjk(c) {
            n += 1;
            in_word = false;
        } else if c.is_alphanumeric() {
            if !in_word {
                n += 1;
                in_word = true;
            }
        } else {
            in_word = false;
        }
    }
    n
}

impl Deriver for ProseDeriver {
    fn derive(&self, input: &DeriveInput<'_>) -> Option<DerivedUpdate> {
        let doc = DocId::parse(input.doc_id).ok()?;
        if doc.is_book() {
            return None;
        }
        let snap = input.doc.export(ExportMode::Snapshot).ok()?;
        let frontiers = input.doc.oplog_frontiers();
        let reader = match ProseReader::load_at(doc, &[snap], &frontiers) {
            Ok(r) => r,
            Err(e) => {
                log::warn!("deriving {}: {e}", input.doc_id);
                return None;
            }
        };
        let view = reader.view();
        let mut d = Derived::default();
        let paragraphs: Vec<_> = view.paragraphs().collect();
        for p in &paragraphs {
            let text = p.text();
            let chars = text.chars().count();
            d.chars += chars as u64;
            d.words += count_words(&text);
            d.blocks.push(BlockRow {
                block_id: p.id.as_ref().map(|b| b.to_string()),
                heading: p.attrs.heading.map(|h| h.level() as u8).unwrap_or(0),
                chars: chars as u32,
                text,
            });
        }
        // Entity links, counted per (block, target).
        let mut refs: BTreeMap<(Option<String>, String, String), u32> = BTreeMap::new();
        for (range, link) in view.entity_links() {
            let block = paragraphs
                .iter()
                .find(|p| p.range.start <= range.start && range.start <= p.newline)
                .and_then(|p| p.id.as_ref().map(|b| b.to_string()));
            *refs
                .entry((block, link.kind.as_str().to_string(), link.target.clone()))
                .or_default() += 1;
        }
        d.references = refs
            .into_iter()
            .map(|((source_block, target_kind, target_id), count)| RefRow {
                source_block,
                target_kind,
                target_id,
                kind: RefKind::Link,
                count,
            })
            .collect();
        Some(DerivedUpdate::Full(d))
    }
}

#[cfg(test)]
mod tests {
    use super::count_words;

    #[test]
    fn stand_in_word_count() {
        assert_eq!(count_words("安娜走了。"), 4);
        assert_eq!(count_words("Anna left, 2 days ago"), 5);
        assert_eq!(count_words("她说 OK 就好"), 5);
    }
}
