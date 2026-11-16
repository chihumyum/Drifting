//! Product observations, never provider-supplied receipt handles. Read text is
//! verified against the immutable document frontier before only hashes persist.
use std::collections::{BTreeMap, BTreeSet};

use dr_doc::prose::BorrowedProse;
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

    let borrowed = dr_doc::v3::BorrowedBookV3::new(&doc, &book)?;
    let view = borrowed.view();
    let templates = view.templates_map();
    let mut entities = BTreeMap::new();
    for entry in view.entries_raw() {
        let key = format!("entry:{}", entry.id);
        let mut targets = BTreeSet::from([key.clone()]);
        if let Some(tpl) = entry.effective_template(&templates) {
            for m in &tpl.modules {
                if m.kind == dr_model::v3::ModuleKind::Prose {
                    targets.insert(format!("body:{}/{}", entry.id, m.id));
                }
            }
        }
        entities.insert(key, (serde_json::to_value(&entry)?, targets));
    }
    for template in view.templates_map().into_values() {
        let key = format!("entry_template:{}", template.id);
        entities.insert(
            key.clone(),
            (serde_json::to_value(&template)?, BTreeSet::from([key])),
        );
    }
    let meta = view.meta();
    entities.insert(
        format!("book_meta:{book}"),
        (
            serde_json::to_value(&meta)?,
            BTreeSet::from([format!("book:{book}")]),
        ),
    );
    let project = view.project();
    for tab in &project.tabs {
        let key = format!("tab:{}", tab.id);
        entities.insert(
            key.clone(),
            (
                serde_json::to_value(tab)?,
                BTreeSet::from([key, format!("project:{book}"), format!("book:{book}")]),
            ),
        );
    }
    let mut project_without_tabs = project;
    project_without_tabs.tabs.clear();
    entities.insert(
        format!("project:{book}"),
        (
            serde_json::to_value(&project_without_tabs)?,
            BTreeSet::from([format!("project:{book}"), format!("book:{book}")]),
        ),
    );
    for asset in view.assets_raw() {
        let key = format!("asset:{}", asset.id);
        let mut targets = BTreeSet::from([key.clone()]);
        if let Some(folder) = &asset.folder {
            targets.insert(format!("asset_folder:{folder}"));
        }
        entities.insert(key, (serde_json::to_value(&asset)?, targets));
    }
    for folder in view.asset_folders_raw() {
        let key = format!("asset_folder:{}", folder.id);
        let mut targets = BTreeSet::from([key.clone()]);
        if let Some(parent) = &folder.parent {
            targets.insert(format!("asset_folder:{parent}"));
        }
        entities.insert(key, (serde_json::to_value(&folder)?, targets));
    }
    for rt in view.relation_types_raw() {
        let key = format!("relation_type:{}", rt.id);
        entities.insert(
            key.clone(),
            (serde_json::to_value(&rt)?, BTreeSet::from([key])),
        );
    }
    for fact in view.facts() {
        let key = format!("fact:{}", fact.id);
        entities.insert(
            key.clone(),
            (serde_json::to_value(&fact)?, BTreeSet::from([key])),
        );
    }
    for mem in view.memory() {
        let key = format!("memory:{}", mem.id);
        let mut targets = BTreeSet::from([key.clone()]);
        if let Some(target) = &mem.target {
            targets.insert(format!("{}:{}", target.kind.as_str(), target.id));
        }
        entities.insert(key, (serde_json::to_value(&mem)?, targets));
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
        let mut targets = BTreeSet::from([key.clone(), format!("entry:{}", patch.entry)]);
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
    for comment in view.comments() {
        let key = format!("comment:{}", comment.id);
        let mut targets = BTreeSet::from([key.clone()]);
        if let Some(target) = &comment.target {
            targets.insert(format!("{}:{}", target.kind.as_str(), target.id));
        }
        entities.insert(key, (serde_json::to_value(&comment)?, targets));
    }
    for relation in view.relations_raw() {
        let key = format!("relation_row:{}", relation.id);
        let mut targets = BTreeSet::from([key.clone()]);
        targets.insert(format!("relation_type:{}", relation.relation_type));
        for entry in relation.left.union(&relation.right) {
            targets.insert(format!("entry:{entry}"));
        }
        entities.insert(key, (serde_json::to_value(&relation)?, targets));
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
            DocId::Conversation(_) | DocId::Stats(_) | DocId::Checkpoints(_) | DocId::Layout(_) => {
                continue;
            }
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

#[cfg(test)]
mod tests {
    use super::write_proof;
    use dr_testkit::seed::{self, Preset};
    use dr_workspace::{Actor, Workspace};
    use serde_json::json;

    #[test]
    fn v5_write_proof_covers_project_tabs_assets_folders_memory_and_skips_layouts() {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::open_dir(dir.path(), "m27-v5-write-proof").unwrap();
        let seeded = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        let book = seeded.books[0].book_id().to_string();
        let entry = seeded.books[0].book.view().entries()[0].id.to_string();
        seeded.write_to(ws.library()).unwrap();

        let asset_id = "01950000-0000-7000-8000-000000000701";
        ws.call(
            &Actor::User,
            "asset.put",
            json!({
                "book": book,
                "id": asset_id,
                "name": "sketch.png",
                "kind": "image",
                "mime": "image/png",
                "size": 64,
                "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                "width": 32,
                "height": 32
            }),
        )
        .unwrap();

        let session = "m27-proof-session";
        let folder = ws
            .call(
                &Actor::agent(session, 1, "folder"),
                "asset_folder.create",
                json!({"book": book, "name": "草图"}),
            )
            .unwrap()["output"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let folder_proof = write_proof(ws.library(), session, 1, "folder")
            .unwrap()
            .unwrap();
        assert!(
            folder_proof
                .targets
                .contains(&format!("asset_folder:{folder}"))
        );

        ws.call(
            &Actor::agent(session, 1, "move-asset"),
            "asset.move",
            json!({"book": book, "id": asset_id, "folder": folder}),
        )
        .unwrap();
        let asset_proof = write_proof(ws.library(), session, 1, "move-asset")
            .unwrap()
            .unwrap();
        assert!(asset_proof.targets.contains(&format!("asset:{asset_id}")));
        assert!(
            asset_proof
                .targets
                .contains(&format!("asset_folder:{folder}"))
        );

        ws.call(
            &Actor::agent(session, 1, "project"),
            "project.update",
            json!({"book": book, "agent": {"instructions": "保持克制"}}),
        )
        .unwrap();
        let project_proof = write_proof(ws.library(), session, 1, "project")
            .unwrap()
            .unwrap();
        assert!(project_proof.targets.contains(&format!("project:{book}")));
        assert!(project_proof.targets.contains(&format!("book:{book}")));

        let tab_id = ws
            .call(
                &Actor::agent(session, 1, "tab"),
                "tab.put",
                // 「全部」 already shows the root; a tab has no name of its own.
                json!({
                    "book": book,
                    "mount": {"kind": "book"}
                }),
            )
            .unwrap()["output"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let tab_proof = write_proof(ws.library(), session, 1, "tab")
            .unwrap()
            .unwrap();
        assert!(tab_proof.targets.contains(&format!("tab:{tab_id}")));
        assert!(tab_proof.targets.contains(&format!("project:{book}")));

        let mem_id = ws
            .call(
                &Actor::agent(session, 1, "memory"),
                "memory.add",
                json!({
                    "book": book,
                    "body": "草图定稿为冷色调",
                    "target": {"kind": "asset", "id": asset_id}
                }),
            )
            .unwrap()["output"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let mem_proof = write_proof(ws.library(), session, 1, "memory")
            .unwrap()
            .unwrap();
        assert!(mem_proof.targets.contains(&format!("memory:{mem_id}")));
        assert!(mem_proof.targets.contains(&format!("asset:{asset_id}")));

        ws.call(
            &Actor::agent(session, 1, "layout"),
            "layout.put",
            json!({
                "book": book,
                "mode": "board",
                "scope": "root",
                "positions": {entry: [12.0, 24.0]}
            }),
        )
        .unwrap();
        assert!(
            write_proof(ws.library(), session, 1, "layout")
                .unwrap()
                .is_none(),
            "DocId::Layout writes remain quiet for completion evidence"
        );

        ws.shutdown().unwrap();
    }
}
