//! Reuse the existing licensed sample definitions, preserving prose through
//! dr-doc's full copy API and preserving exact block/anchor ranges.

use std::collections::BTreeMap;

use dr_doc::peer::import_peer;
use dr_doc::prose::ProseDoc;
use dr_doc::v3::{BookDocV3, genesis_v3};
use dr_doc::{Anchor, DocError, Result};
use dr_model::id::BookId;
use dr_model::kind::EntityKind;
use dr_model::{DocId, Origin};

use super::*;

pub struct SampleBookV3 {
    pub book: BookDocV3,
    pub prose: Vec<ProseDoc>,
    groups: BTreeMap<&'static str, Vec<String>>,
    counters: crate::build::Counters,
}

impl SampleBookV3 {
    pub fn book_id(&self) -> &BookId {
        self.book.book_id()
    }
    pub fn groups(&self) -> &BTreeMap<&'static str, Vec<String>> {
        &self.groups
    }
    pub fn counters(&self) -> crate::build::Counters {
        self.counters
    }
}

/// Same two recipes, with migration policy supplied explicitly until the
/// author settles m10's pending items. The source catalog exists only in memory.
pub fn pride_and_prejudice(choices: &MappingChoices) -> Result<SampleBookV3> {
    convert(&crate::pride_and_prejudice()?, choices)
}
pub fn a_q(choices: &MappingChoices) -> Result<SampleBookV3> {
    convert(&crate::a_q()?, choices)
}

pub fn convert(source: &crate::SeededBook, choices: &MappingChoices) -> Result<SampleBookV3> {
    let pending = choices.pending(&source.book.view());
    if !pending.is_empty() {
        return Err(super::catalog::invalid(format!(
            "unresolved sample v3 mapping: {pending:?}"
        )));
    }
    let mut prose = Vec::new();
    let mut indices = BTreeMap::new();
    for (index, old) in source.prose.iter().enumerate() {
        for (_, link) in old.view().entity_links() {
            if link.kind == EntityKind::Material || link.block.is_some() || link.end_block.is_some()
            {
                return Err(super::catalog::invalid(
                    "v3 prose link writer needs material/module support (m10 pending 28)",
                ));
            }
        }
        for paragraph in old.view().paragraphs() {
            if let Some(embed) = paragraph.embed()
                && let Some(dr_doc::prose::EmbedView::Table { rows, cols, .. }) =
                    old.view().embed(embed)
            {
                for row in rows {
                    for col in &cols {
                        if old
                            .view()
                            .table_cell(embed, &row.id, &col.id)
                            .is_some_and(|runs| runs.iter().any(|r| !r.marks.entities.is_empty()))
                        {
                            return Err(super::catalog::invalid(
                                "v3 table-cell link writer is not available",
                            ));
                        }
                    }
                }
            }
        }
        let id = prose_id(source.book_id(), old.doc_id());
        let mut doc = ProseDoc::create(id.clone(), import_peer(&id.to_string()))?;
        let (r, _) = doc.edit_at(
            Origin::Import,
            Some(crate::build::T0 + index as i64 + 1),
            |t| {
                t.insert_copy(0, &old.view())?;
                // Copy creates fresh paragraph identities; a migration keeps
                // the authored ids used by links, comments and task markers.
                let old_blocks = old.view().blocks();
                let new_blocks = t.view().blocks();
                if old_blocks.len() != new_blocks.len() {
                    return Err(super::catalog::invalid("sample paragraph count changed"));
                }
                for (old, new) in old_blocks.iter().zip(&new_blocks) {
                    t.set_block_id(new.newline, old.id.as_ref())?;
                }
                let links = t.view().entity_links();
                for (range, link) in &links {
                    if link.kind == EntityKind::Material {
                        return Err(DocError::NotInProfile(
                            "v3 material link writer is not available",
                        ));
                    }
                    if map_kind(&link.kind) != link.kind {
                        t.unlink_entity(range.clone(), &link.target)?;
                    }
                }
                // Remove old marks first, then add every mapped mark: links
                // with the same target but different block ranges may overlap.
                for (range, link) in links {
                    if map_kind(&link.kind) != link.kind {
                        let mut mapped = link.clone();
                        mapped.kind = map_kind(&link.kind);
                        t.link_entity(range, &mapped)?;
                    }
                }
                Ok(())
            },
        );
        r?;
        if old.view().plain_text() != doc.view().plain_text() {
            return Err(super::catalog::invalid("sample prose text changed"));
        }
        indices.insert(old.doc_id().to_string(), prose.len());
        prose.push(doc);
    }
    // Clone just the catalog into memory so anchor replacement cannot
    // mutate the source. Resolve exact cursors, never search for a quote
    // which could occur more than once.
    let mut catalog = dr_doc::import_v1::BookDoc::load(
        source.book_id().clone(),
        import_peer("sample-v3-anchor-catalog"),
        &[source.book.export_snapshot()?],
    )?;
    let relocate = |id: &DocId, encoded: &dr_model::import_v1::EncodedAnchor| -> Result<Anchor> {
        let index = *indices
            .get(&id.to_string())
            .ok_or_else(|| super::catalog::invalid(format!("missing sample prose {id}")))?;
        let anchor =
            Anchor::decode(encoded).ok_or_else(|| super::catalog::invalid("bad sample anchor"))?;
        let resolved = source.prose[index]
            .view()
            .resolve(&anchor)
            .ok_or_else(|| super::catalog::invalid("unresolvable sample anchor"))?;
        prose[index]
            .view()
            .anchor(resolved.range)
            .ok_or_else(|| super::catalog::invalid("collapsed sample anchor"))
    };
    let view = source.book.view();
    let (r, _) = catalog.edit_at(Origin::Import, Some(crate::build::T0 + 10_000), |t| {
        for comment in view.comments() {
            if let (Some(target), Some(anchor)) = (&comment.target, &comment.anchor) {
                let id = super::catalog::target_doc(target)
                    .ok_or_else(|| super::catalog::invalid("sample anchor target has no prose"))?;
                t.comment(&comment.id)?
                    .anchor(Some(&relocate(&id, anchor)?))?;
            }
        }
        for patch in view.patches() {
            if let (Some(node), Some(anchor)) = (&patch.source_node, &patch.anchor) {
                t.patch(&patch.id)?
                    .anchor(Some(&relocate(&DocId::Node(node.clone()), anchor)?))?;
            }
        }
        Ok(())
    });
    r?;
    let id = source.book_id().clone();
    let mut book = BookDocV3::create(id.clone(), import_peer(&format!("sample-v3:{id}")))?;
    let (r, _) = book.edit_at(Origin::Import, Some(crate::build::T0 + 10_001), |t| {
        sync_catalog(t, &catalog.view(), choices)
    });
    r?;
    validate(&book.view()).map_err(super::catalog::invalid)?;
    Ok(SampleBookV3 {
        book,
        prose,
        groups: source.groups().clone(),
        counters: source.counters(),
    })
}

/// Body-first storage. Refuse an existing v2 document of the same book id;
/// sample insertion must never produce a mixture of kernel versions.
pub fn write_book(
    lib: &dr_store::Library,
    sample: &SampleBookV3,
) -> std::result::Result<usize, crate::WriteError> {
    let all = dr_doc::loro_types::VersionVector::default();
    let mut count = 0;
    let mut store = |id: &DocId,
                     genesis: Vec<u8>,
                     bytes: Vec<u8>|
     -> std::result::Result<(), crate::WriteError> {
        let key = id.to_string();
        if lib.doc_info(&key)?.is_some() {
            return Err(
                super::catalog::invalid(format!("sample document already exists: {key}")).into(),
            );
        }
        let h = lib.open_doc(
            &key,
            dr_store::OpenDoc::CreateIfMissing {
                kind: id.kind().prefix(),
                book_id: Some(sample.book_id().as_str()),
                genesis: &move |d| {
                    d.import(&genesis).expect("typed genesis");
                },
            },
        )?;
        h.import(bytes, dr_store::Origin::Import)?;
        h.compact_now()?;
        h.close();
        count += 1;
        Ok(())
    };
    // Check all ids before any writes, including the unchanged book id.
    for id in sample
        .prose
        .iter()
        .map(|p| p.doc_id())
        .chain([sample.book.doc_id()])
    {
        if lib.doc_info(&id.to_string())?.is_some() {
            return Err(
                super::catalog::invalid(format!("sample document already exists: {id}")).into(),
            );
        }
    }
    for doc in &sample.prose {
        store(
            doc.doc_id(),
            dr_doc::prose::genesis(doc.doc_id()),
            doc.export_updates_since(&all)?,
        )?;
    }
    store(
        sample.book.doc_id(),
        genesis_v3(sample.book_id()),
        sample.book.export_updates_since(&all)?,
    )?;
    Ok(count)
}
