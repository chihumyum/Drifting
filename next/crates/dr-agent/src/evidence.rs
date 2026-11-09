//! Product observations, never provider-supplied receipt handles. Read text is
//! verified against the immutable document frontier before only hashes persist.
use std::collections::{BTreeMap, BTreeSet};

use dr_doc::{book::BorrowedBook, prose::BorrowedProse};
use dr_model::{DocId, id::BookId};
use dr_store::{Library, Settlement};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{Error, Result};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadParagraph {
    pub index: usize,
    pub block_id: Option<String>,
    pub heading: u8,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadObservation {
    pub doc: String,
    pub version: String,
    pub total: usize,
    pub paragraphs: Vec<ReadParagraph>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct ReadProof {
    pub id: String,
    pub session: String,
    pub turn: u32,
    pub call: String,
    pub doc: String,
    pub version: String,
    pub total: usize,
    pub paragraphs: BTreeMap<usize, String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct WriteProof {
    pub id: String,
    pub session: String,
    pub turn: u32,
    pub call: String,
    pub targets: BTreeSet<String>,
    pub settlements: Vec<i64>,
}

pub(crate) fn hash(value: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(value.as_ref()))
}
pub(crate) fn version(frontiers: &loro::Frontiers) -> String {
    frontiers
        .encode()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
pub(crate) fn frontier(encoded: &str) -> Result<loro::Frontiers> {
    if !encoded.len().is_multiple_of(2) || !encoded.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(Error::Protocol("invalid evidence frontier".into()));
    }
    let bytes = (0..encoded.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&encoded[i..i + 2], 16))
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|_| Error::Protocol("invalid evidence frontier".into()))?;
    loro::Frontiers::decode(&bytes).map_err(|_| Error::Protocol("invalid evidence frontier".into()))
}

pub(crate) fn paragraphs(lib: &Library, doc: &str, at: &str) -> Result<Vec<ReadParagraph>> {
    let id = DocId::parse(doc).map_err(|error| Error::Protocol(error.to_string()))?;
    let copy = lib.load_copy_at(doc, &frontier(at)?)?;
    let body = BorrowedProse::new(&copy, &id)?;
    Ok(body
        .view()
        .paragraphs()
        .enumerate()
        .map(|(index, paragraph)| ReadParagraph {
            index,
            block_id: paragraph.id.as_ref().map(ToString::to_string),
            heading: paragraph
                .attrs
                .heading
                .map(|h| h.level() as u8)
                .unwrap_or(0),
            text: paragraph.text(),
        })
        .collect())
}

pub(crate) fn verify_read(
    lib: &Library,
    book: &BookId,
    session: &str,
    turn: u32,
    call: &str,
    observation: ReadObservation,
) -> Result<ReadProof> {
    if lib
        .doc_info(&observation.doc)?
        .is_none_or(|info| info.book_id.as_deref() != Some(book.as_str()))
    {
        return Err(Error::Protocol(
            "read evidence belongs to another book".into(),
        ));
    }
    let canonical = paragraphs(lib, &observation.doc, &observation.version)?;
    if canonical.len() != observation.total
        || observation.paragraphs.is_empty() && observation.total > 0
    {
        return Err(Error::Protocol("invalid read evidence page".into()));
    }
    let mut covered = BTreeMap::new();
    for paragraph in observation.paragraphs {
        if canonical.get(paragraph.index) != Some(&paragraph)
            || covered
                .insert(paragraph.index, hash(serde_json::to_vec(&paragraph)?))
                .is_some()
        {
            return Err(Error::Protocol(
                "read evidence does not match its exact source".into(),
            ));
        }
    }
    Ok(ReadProof {
        id: hash(format!("{session}/{turn}/{call}/{}", observation.doc)),
        session: session.into(),
        turn,
        call: call.into(),
        doc: observation.doc,
        version: observation.version,
        total: observation.total,
        paragraphs: covered,
    })
}

fn book_entities(
    lib: &Library,
    settlement: &Settlement,
    after: bool,
) -> Result<BTreeMap<String, (Value, BTreeSet<String>)>> {
    let DocId::Book(book) =
        DocId::parse(&settlement.doc_id).map_err(|e| Error::Protocol(e.to_string()))?
    else {
        return Ok(BTreeMap::new());
    };
    let doc = lib.load_copy_at(
        &settlement.doc_id,
        if after {
            &settlement.after
        } else {
            &settlement.before
        },
    )?;
    if dr_doc::v3::is_v3_doc(&doc) {
        let borrowed = dr_doc::v3::BorrowedBookV3::new(&doc, &book)?;
        let view = borrowed.view();
        let templates = view.templates_map();
        let mut entities = BTreeMap::new();
        for entry in view.entries_raw() {
            let key = format!("entry:{}", entry.id);
            let mut targets = BTreeSet::from([key.clone(), format!("body:{}/about", entry.id)]);
            if let Some(tpl) = entry.effective_template(&templates) {
                for m in &tpl.modules {
                    if m.kind == dr_model::v3::ModuleKind::Prose {
                        targets.insert(format!("body:{}/{}", entry.id, m.id));
                    }
                }
            }
            entities.insert(key, (serde_json::to_value(&entry)?, targets));
        }
        for template in view.templates() {
            let key = format!("entry_template:{}", template.id);
            entities.insert(
                key.clone(),
                (serde_json::to_value(&template)?, BTreeSet::from([key])),
            );
        }
        for membership in view.memberships_raw() {
            let key = format!("membership:{}/{}", membership.host, membership.member);
            let targets = BTreeSet::from([
                key.clone(),
                format!("entry:{}", membership.host),
                format!("entry:{}", membership.member),
            ]);
            entities.insert(key, (serde_json::to_value(&membership)?, targets));
        }
        for tv in view.timeline_views_raw() {
            let key = format!("timeline_view:{}", tv.id);
            let mut targets = BTreeSet::from([key.clone()]);
            for lane in &tv.lanes {
                targets.insert(format!("entry:{}", lane.entry));
            }
            for pl in &tv.placements {
                targets.insert(format!("entry:{}", pl.entry));
            }
            for pin in &tv.pins {
                if let Some(entry) = &pin.entry {
                    targets.insert(format!("entry:{entry}"));
                }
            }
            entities.insert(key, (serde_json::to_value(&tv)?, targets));
        }
        for patch in view.patches() {
            let key = format!("patch:{}", patch.id);
            let mut targets = BTreeSet::from([
                key.clone(),
                format!("entry:{}", patch.entry),
                format!("body:{}/about", patch.entry),
            ]);
            if let Some(src) = &patch.source_entry {
                targets.insert(format!("entry:{src}"));
            }
            entities.insert(key, (serde_json::to_value(&patch)?, targets));
        }
        for grid in view.plot_grids() {
            let key = format!("plot_grid:{}/{}", grid.entry, grid.module);
            let targets = BTreeSet::from([key.clone(), format!("entry:{}", grid.entry)]);
            entities.insert(key, (serde_json::to_value(&grid)?, targets));
        }
        for material in view.materials() {
            let key = format!("material:{}", material.id);
            entities.insert(
                key.clone(),
                (serde_json::to_value(&material)?, BTreeSet::from([key])),
            );
        }
        for comment in view.comments() {
            let key = format!("comment:{}", comment.id);
            let mut targets = BTreeSet::from([key.clone()]);
            if let Some(target) = &comment.target {
                targets.insert(format!("{}:{}", target.kind.as_str(), target.id));
            }
            entities.insert(key, (serde_json::to_value(&comment)?, targets));
        }
        for relation in view.relations_raw() {
            let key = format!("relation:{}", relation.id);
            let mut targets = BTreeSet::from([key.clone()]);
            for endpoint in [&relation.from, &relation.to] {
                targets.insert(format!("{}:{}", endpoint.kind.as_str(), endpoint.id));
            }
            entities.insert(key, (serde_json::to_value(&relation)?, targets));
        }
        return Ok(entities);
    }
    let borrowed = BorrowedBook::new(&doc, &book)?;
    let view = borrowed.view();
    let mut entities = BTreeMap::new();
    macro_rules! insert {
        ($kind:literal, $rows:expr) => {
            for row in $rows {
                let key = format!("{}:{}", $kind, row.id);
                entities.insert(
                    key.clone(),
                    (serde_json::to_value(&row)?, BTreeSet::from([key])),
                );
            }
        };
    }
    insert!("node", view.nodes());
    insert!("element", view.elements());
    insert!("storyline", view.storylines());
    insert!("category", view.categories());
    insert!("material", view.materials());
    insert!("comment", view.comments());
    for patch in view.patches() {
        let mut targets = BTreeSet::from([format!("element:{}", patch.element)]);
        if let Some(node) = &patch.source_node {
            targets.insert(format!("node:{node}"));
        }
        entities.insert(
            format!("patch:{}", patch.id),
            (serde_json::to_value(&patch)?, targets),
        );
    }
    for relation in view.relations_raw() {
        let mut targets = BTreeSet::from([format!("relation:{}", relation.id)]);
        for endpoint in [&relation.from, &relation.to] {
            targets.insert(format!("{}:{}", endpoint.kind.as_str(), endpoint.id));
        }
        entities.insert(
            format!("relation:{}", relation.id),
            (serde_json::to_value(&relation)?, targets),
        );
    }
    Ok(entities)
}

/// Claims are derived from persisted F3 before/after states, never the model's
/// tool output. All writes by one call share a proof and can complete one step.
pub(crate) fn write_proof(
    lib: &Library,
    session: &str,
    turn: u32,
    call: &str,
) -> Result<Option<WriteProof>> {
    let mut proof = WriteProof {
        id: hash(format!("{session}/{turn}/{call}")),
        session: session.into(),
        turn,
        call: call.into(),
        targets: BTreeSet::new(),
        settlements: Vec::new(),
    };
    for receipt in lib
        .settlements(Some(session), None)?
        .into_iter()
        .filter(|r| r.turn == turn.to_string() && r.call == call)
    {
        if receipt.before == receipt.after {
            continue;
        }
        let doc = DocId::parse(&receipt.doc_id).map_err(|e| Error::Protocol(e.to_string()))?;
        match doc {
            DocId::Book(_) => {
                let before = book_entities(lib, &receipt, false)?;
                let after = book_entities(lib, &receipt, true)?;
                let keys: BTreeSet<_> = before.keys().chain(after.keys()).collect();
                for key in keys {
                    if before.get(key).map(|v| &v.0) != after.get(key).map(|v| &v.0) {
                        for state in [before.get(key), after.get(key)].into_iter().flatten() {
                            proof.targets.extend(state.1.iter().cloned());
                        }
                    }
                }
            }
            DocId::Conversation(_) => continue,
            DocId::Body(body) => {
                proof.targets.insert(receipt.doc_id.clone());
                proof.targets.insert(format!("entry:{}", body.entry()));
            }
            _ => {
                proof.targets.insert(receipt.doc_id.clone());
            }
        }
        proof.settlements.push(receipt.id);
    }
    Ok((!proof.targets.is_empty()).then_some(proof))
}
