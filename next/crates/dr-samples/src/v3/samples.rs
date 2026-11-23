//! Reuse the existing licensed sample definitions, preserving prose through
//! dr-doc's full copy API and preserving exact block/anchor ranges.

use std::collections::{BTreeMap, BTreeSet};

use dr_doc::peer::import_peer;
use dr_doc::prose::ProseDoc;
use dr_doc::v3::{BookDocV3, book_genesis};
use dr_doc::{Anchor, Result};
use dr_model::id::BookId;
use dr_model::import_v1::MaterialKind;
use dr_model::{DocId, Origin};

use super::*;

pub struct SampleBookV3 {
    pub book: BookDocV3,
    pub prose: Vec<ProseDoc>,
    /// `stats:<book>`: the sample's writing days.
    pub stats: dr_doc::side::StatsDoc,
    /// `checkpoints:<book>`: empty.
    pub checkpoints: dr_doc::side::CheckpointsDoc,
    /// `layout:<book>`: board, grid and relation-graph positions.
    pub layout: dr_doc::side::LayoutDoc,
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
    let non_text_materials: BTreeSet<String> = source
        .book
        .view()
        .materials()
        .into_iter()
        .filter(|m| m.kind != MaterialKind::Text)
        .map(|m| m.id.to_string())
        .collect();
    let mut prose = Vec::new();
    let mut indices = BTreeMap::new();
    for (index, old) in source.prose.iter().enumerate() {
        if matches!(old.doc_id(), DocId::Material(id) if non_text_materials.contains(id.as_str())) {
            continue;
        }
        let id = prose_id(source.book_id(), old.doc_id());
        let mut doc = ProseDoc::create(id.clone(), import_peer(&id.to_string()))?;
        let old_links = old.view().entity_links();
        let old_embeds = old.view().embed_refs();
        let (r, _) = doc.edit_at(
            Origin::Import,
            Some(crate::build::T0 + index as i64 + 1),
            |t| {
                t.insert_copy_v3(0, &old.view())?;
                // Copy creates fresh paragraph identities; a migration keeps
                // the authored ids used by links, comments and task markers.
                let old_blocks = old.view().blocks();
                let new_blocks = t.view().blocks();
                if old_blocks.len() != new_blocks.len() {
                    return Err(super::catalog::invalid("sample paragraph count changed"));
                }
                for (old_b, new_b) in old_blocks.iter().zip(&new_blocks) {
                    t.set_block_id(new_b.newline, old_b.id.as_ref())?;
                }
                // Remove old marks first, then add every mapped v3 mark: links
                // with the same target but different block ranges may overlap.
                for (range, link) in &old_links {
                    t.unlink_entity(range.clone(), &link.target)?;
                }
                for (range, link) in &old_links {
                    if link.kind == EntityKind::Material
                        && non_text_materials.contains(&link.target)
                    {
                        continue;
                    }
                    let mapped = map_entity_link(link, None)?;
                    t.link_entity_v3(range.clone(), &mapped)?;
                }
                let new_embeds = t.view().embed_refs();
                if old_embeds.len() != new_embeds.len() {
                    return Err(super::catalog::invalid("sample embed count changed"));
                }
                for ((_, old_eid), (_, new_eid)) in old_embeds.iter().zip(&new_embeds) {
                    if let Some(dr_doc::prose::EmbedView::Table { cells, .. }) =
                        t.view().embed(new_eid)
                    {
                        for (row, col) in cells.keys() {
                            let runs = old.view().table_cell(old_eid, row, col).unwrap_or_default();
                            if runs.iter().any(|r| !r.marks.entities.is_empty()) {
                                let mut by_target: BTreeMap<
                                    String,
                                    Vec<(std::ops::Range<usize>, dr_model::v3::EntityLinkV3)>,
                                > = BTreeMap::new();
                                let mut at = 0usize;
                                for r in &runs {
                                    let span = at..at + r.text.chars().count();
                                    at = span.end;
                                    if span.is_empty() {
                                        continue;
                                    }
                                    for e in &r.marks.entities {
                                        if e.kind == EntityKind::Material
                                            && non_text_materials.contains(&e.target)
                                        {
                                            continue;
                                        }
                                        let mapped = map_entity_link(e, None)?;
                                        let list =
                                            by_target.entry(mapped.target.clone()).or_default();
                                        if let Some((prev, last)) = list.last_mut()
                                            && prev.end == span.start
                                            && *last == mapped
                                        {
                                            prev.end = span.end;
                                        } else {
                                            list.push((span.clone(), mapped));
                                        }
                                    }
                                }
                                let mut cell_links: Vec<_> =
                                    by_target.into_values().flatten().collect();
                                cell_links.sort_by(|a, b| {
                                    (a.0.start, &a.1.target).cmp(&(b.0.start, &b.1.target))
                                });
                                t.set_table_cell_runs_v3(new_eid, row, col, &runs, &cell_links)?;
                            }
                        }
                    }
                }
                Ok(())
            },
        );
        r?;
        if old.view().plain_text() != doc.view().plain_text() {
            return Err(super::catalog::invalid("sample prose text changed"));
        }
        indices.insert(old.doc_id().to_string(), (index, prose.len()));
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
        let (src_index, dst_index) = *indices
            .get(&id.to_string())
            .ok_or_else(|| super::catalog::invalid(format!("missing sample prose {id}")))?;
        let anchor =
            Anchor::decode(encoded).ok_or_else(|| super::catalog::invalid("bad sample anchor"))?;
        let resolved = source.prose[src_index]
            .view()
            .resolve(&anchor)
            .ok_or_else(|| super::catalog::invalid("unresolvable sample anchor"))?;
        prose[dst_index]
            .view()
            .anchor(resolved.range)
            .ok_or_else(|| super::catalog::invalid("collapsed sample anchor"))
    };
    let view = source.book.view();
    let (r, _) = catalog.edit_at(Origin::Import, Some(crate::build::T0 + 10_000), |t| {
        for comment in view.comments() {
            if let (Some(target), Some(anchor)) = (&comment.target, &comment.anchor) {
                if target.kind == EntityKind::Material && non_text_materials.contains(&target.id) {
                    t.comment(&comment.id)?.anchor(None)?;
                    continue;
                }
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
    // The lines the projected comments follow, from the converted prose.
    let marked: BTreeSet<(String, dr_model::id::BlockId)> = view
        .comments()
        .into_iter()
        .filter_map(|c| {
            let p = c
                .projection
                .as_ref()
                .filter(|p| p.kind == dr_model::kind::ProjectionKind::Marker)?;
            let old = super::catalog::target_doc(c.target.as_ref()?)?;
            Some((
                prose_id(source.book_id(), &old).to_string(),
                p.block.clone(),
            ))
        })
        .collect();
    let mut lines = ProjectedLines::default();
    for doc in &prose {
        let at = doc.doc_id().to_string();
        lines.add(doc.doc_id(), &doc.view(), |block| {
            marked.contains(&(at.clone(), block.clone()))
        });
    }
    let id = source.book_id().clone();
    let mut book = BookDocV3::create(id.clone(), import_peer(&format!("sample-v3:{id}")))?;
    let (r, _) = book.edit_at(Origin::Import, Some(crate::build::T0 + 10_001), |t| {
        sync_catalog(t, &catalog.view(), choices, &lines)?;
        // A sample book is a book of the writing template, not a 0.1 one:
        // its entries keep the switches a new book's would give them
        // (`kernel-v5.md` §16), the elements in their categories linked and
        // the chapters and ideas not (the adapter turns those on for a book
        // imported from 0.1).
        let graph = t.view().graph();
        for e in graph.entries.values().filter(|e| e.auto_link) {
            if !dr_model::v3::new_entry_auto_link(
                e.parent.as_ref(),
                e.template.as_ref(),
                &graph.entries,
                &graph.templates,
            ) {
                t.entries().entry(&e.id)?.auto_link(false)?;
            }
        }
        Ok(())
    });
    r?;
    validate(&book.view()).map_err(super::catalog::invalid)?;
    super::catalog::validate_names(&book.view()).map_err(super::catalog::invalid)?;
    let (stats, checkpoints, layout) = super::catalog::side_documents(
        &id,
        &source.book.view(),
        &book.view(),
        crate::build::T0 + 10_002,
    )?;
    Ok(SampleBookV3 {
        book,
        prose,
        stats,
        checkpoints,
        layout,
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
    for id in sample.prose.iter().map(|p| p.doc_id()).chain([
        sample.stats.doc_id(),
        sample.checkpoints.doc_id(),
        sample.layout.doc_id(),
        sample.book.doc_id(),
    ]) {
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
        sample.stats.doc_id(),
        dr_doc::side::stats_genesis(sample.book_id()),
        sample.stats.export_updates_since(&all)?,
    )?;
    store(
        sample.checkpoints.doc_id(),
        dr_doc::side::checkpoints_genesis(sample.book_id()),
        sample.checkpoints.export_updates_since(&all)?,
    )?;
    store(
        sample.layout.doc_id(),
        dr_doc::side::layout_genesis(sample.book_id()),
        sample.layout.export_updates_since(&all)?,
    )?;
    store(
        sample.book.doc_id(),
        book_genesis(sample.book_id()),
        sample.book.export_updates_since(&all)?,
    )?;
    Ok(count)
}

/// Returns `true` when every stored document for `sample.book_id()` in `lib`
/// belongs to `sample` and matches its unmodified deterministic CRDT state.
/// Any extra document, trashed document, or post-import edit returns `false`.
pub fn is_unmodified_subset(
    lib: &dr_store::Library,
    sample: &SampleBookV3,
) -> std::result::Result<bool, String> {
    let stored = lib
        .docs(Some(sample.book_id().as_str()), None)
        .map_err(|e| e.to_string())?;
    if stored.is_empty() {
        return Ok(true);
    }
    let all = dr_doc::loro_types::VersionVector::default();
    for info in stored {
        let expected_pair = if let Some(doc) = sample
            .prose
            .iter()
            .find(|p| p.doc_id().to_string() == info.doc_id)
        {
            Some((
                dr_doc::prose::genesis(doc.doc_id()),
                doc.export_updates_since(&all).map_err(|e| e.to_string())?,
            ))
        } else if sample.stats.doc_id().to_string() == info.doc_id {
            Some((
                dr_doc::side::stats_genesis(sample.book_id()),
                sample
                    .stats
                    .export_updates_since(&all)
                    .map_err(|e| e.to_string())?,
            ))
        } else if sample.checkpoints.doc_id().to_string() == info.doc_id {
            Some((
                dr_doc::side::checkpoints_genesis(sample.book_id()),
                sample
                    .checkpoints
                    .export_updates_since(&all)
                    .map_err(|e| e.to_string())?,
            ))
        } else if sample.layout.doc_id().to_string() == info.doc_id {
            Some((
                dr_doc::side::layout_genesis(sample.book_id()),
                sample
                    .layout
                    .export_updates_since(&all)
                    .map_err(|e| e.to_string())?,
            ))
        } else if sample.book.doc_id().to_string() == info.doc_id {
            Some((
                book_genesis(sample.book_id()),
                sample
                    .book
                    .export_updates_since(&all)
                    .map_err(|e| e.to_string())?,
            ))
        } else {
            None
        };
        let Some((genesis, updates)) = expected_pair else {
            return Ok(false);
        };
        let expected = loro::LoroDoc::new();
        expected.import(&genesis).map_err(|e| e.to_string())?;
        expected.import(&updates).map_err(|e| e.to_string())?;
        let actual = lib.load_copy(&info.doc_id).map_err(|e| e.to_string())?;
        if actual.oplog_frontiers() != expected.oplog_frontiers()
            || actual.state_vv() != expected.state_vv()
        {
            return Ok(false);
        }
    }
    Ok(true)
}
