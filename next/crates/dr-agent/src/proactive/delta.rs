use std::collections::BTreeMap;

use dr_doc::{loro_types::Frontiers, prose::BorrowedProse};
use dr_model::{DocId, id::BookId};
use dr_store::Library;
use serde::{Deserialize, Serialize};

use crate::{Error, Result};

pub const CHECKIN_DOCUMENT_LIMIT: usize = 8;
pub const ORGANIZE_DOCUMENT_LIMIT: usize = 12;
pub const DIGEST_CHAR_LIMIT: usize = 3_000;

/// Per-document coverage, rather than a global timestamp: a bounded batch
/// must not swallow the next document or an edit in the same wall-clock second.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeltaCursor {
    /// Kept for documents not yet included in a bounded batch. Advancing a
    /// display timestamp must never move this unseen-document horizon.
    pub since_ms: Option<i64>,
    pub documents: BTreeMap<String, DocumentCursor>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocumentCursor {
    pub frontiers: Vec<u8>,
    #[serde(with = "peer_counters")]
    pub counters: BTreeMap<u64, i32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeltaMode {
    AllProse,
    LocalAuthorBodies,
}

#[derive(Clone, Debug)]
pub struct DeltaRequest {
    pub book: BookId,
    pub since_ms: i64,
    pub captured_ms: i64,
    pub mode: DeltaMode,
    pub cursor: DeltaCursor,
    pub limit: usize,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangeSources {
    pub author: usize,
    pub agent: usize,
    pub remote: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CardTarget {
    pub kind: String,
    pub id: String,
    pub title: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangedDocument {
    pub reference: String,
    pub doc: String,
    pub target: CardTarget,
    pub last_changed_ms: i64,
    pub sources: ChangeSources,
    pub has_baseline: bool,
    pub digest: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeltaBatch {
    pub documents: Vec<ChangedDocument>,
    pub coverage: DeltaCursor,
    pub omitted: usize,
    pub captured_ms: i64,
}

fn live_targets(
    lib: &Library,
    book: &BookId,
    mode: DeltaMode,
) -> Result<BTreeMap<String, CardTarget>> {
    let copy = lib.load_copy(&format!("book:{book}"))?;

    let borrowed = dr_doc::v3::BorrowedBookV3::new(&copy, book)?;
    let view = borrowed.view();
    if view.trashed_at().is_some() {
        return Err(Error::Closed);
    }
    let templates = view.templates_map();
    let entries = view.entries_map();
    let materials: BTreeMap<_, _> = view
        .materials()
        .into_iter()
        .map(|m| (m.id.clone(), m))
        .collect();
    let mut targets = BTreeMap::new();
    // The evidence collector does not infer a task from template names or
    // auto-link flags. Every retained, registered body keeps its identity.
    for info in lib.docs(Some(book.as_str()), None)? {
        match DocId::parse(&info.doc_id) {
            Ok(DocId::Body(body)) => {
                if let Some(entry) = entries.get(body.entry()).filter(|e| !e.is_trashed()) {
                    let module = entry
                        .effective_template(&templates)
                        .and_then(|t| t.module(body.module()))
                        .map(|m| m.name.as_str())
                        .unwrap_or(body.module().as_str());
                    targets.insert(
                        info.doc_id,
                        CardTarget {
                            kind: "entry".into(),
                            id: entry.id.to_string(),
                            title: format!("{} / {}", entry.title, module),
                        },
                    );
                }
            }
            Ok(DocId::Material(id)) if mode == DeltaMode::AllProse => {
                if let Some(material) = materials.get(&id) {
                    targets.insert(
                        info.doc_id,
                        CardTarget {
                            kind: "material".into(),
                            id: id.to_string(),
                            title: material.title.clone(),
                        },
                    );
                }
            }
            _ => {}
        }
    }
    Ok(targets)
}

fn normalized(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_whitespace() && *c != '\u{fffc}')
        .collect()
}

pub(crate) fn bounded(text: &str, chars: usize) -> String {
    let mut value: String = text.chars().filter(|c| *c != '\0').take(chars).collect();
    if text.chars().count() > chars {
        value.push('…');
    }
    value
}

fn digest(before: Option<&[(String, String)]>, after: &[(String, String)]) -> Option<String> {
    let current = after
        .iter()
        .map(|(_, text)| text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let Some(before) = before else {
        return (!normalized(&current).is_empty()).then(|| bounded(&current, DIGEST_CHAR_LIMIT));
    };
    let previous = before
        .iter()
        .map(|(_, text)| text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    if normalized(&previous) == normalized(&current) {
        return None;
    }
    let old: BTreeMap<_, _> = before
        .iter()
        .map(|(id, text)| (id.as_str(), text.as_str()))
        .collect();
    let new: BTreeMap<_, _> = after
        .iter()
        .map(|(id, text)| (id.as_str(), text.as_str()))
        .collect();
    let mut lines = Vec::new();
    for (id, text) in after {
        match old.get(id.as_str()) {
            Some(prior) if normalized(prior) == normalized(text) => {}
            Some(prior) => lines.push(format!("~ [-{prior}-]{{+{text}+}}")),
            None if !normalized(text).is_empty() => lines.push(format!("+ {text}")),
            None => {}
        }
    }
    for (id, text) in before {
        if !new.contains_key(id.as_str()) && !normalized(text).is_empty() {
            lines.push(format!("- {text}"));
        }
    }
    // A reorder of existing paragraphs is a structural prose change.
    if lines.is_empty() {
        lines.push(current);
    }
    Some(bounded(&lines.join("\n"), DIGEST_CHAR_LIMIT))
}

/// Read only. In particular, `peer_for` must not be called here: it allocates
/// a local peer and would turn discovery into a write.
pub fn collect_delta(lib: &Library, request: &DeltaRequest) -> Result<DeltaBatch> {
    if request.limit == 0 || request.limit > 64 {
        return Err(Error::Protocol("invalid suggestion batch limit".into()));
    }
    let targets = live_targets(lib, &request.book, request.mode)?;
    let epoch = lib.epoch();
    let peers: BTreeMap<String, u64> = lib.local_read(|conn| {
        let mut stmt = conn.prepare("SELECT doc_id, peer_id FROM loro_peer WHERE epoch = ?1")?;
        let rows = stmt.query_map([&epoch], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u64))
        })?;
        let mut peers = BTreeMap::new();
        for row in rows {
            let (id, peer) = row?;
            peers.insert(id, peer);
        }
        Ok(peers)
    })?;
    let mut batch = DeltaBatch {
        coverage: request.cursor.clone(),
        captured_ms: request.captured_ms,
        ..DeltaBatch::default()
    };
    let since_ms = request.cursor.since_ms.unwrap_or(request.since_ms);
    batch.coverage.since_ms = Some(since_ms);
    batch
        .coverage
        .documents
        .retain(|doc, _| targets.contains_key(doc));
    let mut changed = Vec::new();
    for info in lib.docs(Some(request.book.as_str()), None)? {
        let Some(target) = targets.get(&info.doc_id) else {
            continue;
        };
        let id: DocId = info
            .doc_id
            .parse()
            .map_err(|e| Error::Protocol(format!("invalid prose id: {e}")))?;
        let copy = lib.load_copy(&info.doc_id)?;
        let previous = request.cursor.documents.get(&info.doc_id);
        let mut sources = ChangeSources::default();
        let mut last_changed_ms = 0;
        for change in dr_store::history::changes_since(&copy, 1) {
            let end = change
                .counter
                .saturating_add(i32::try_from(change.len).unwrap_or(i32::MAX));
            if previous.is_some_and(|p| p.counters.get(&change.peer).copied().unwrap_or(0) >= end)
                || (previous.is_none() && change.timestamp < since_ms.div_euclid(1000))
            {
                continue;
            }
            let message = change.message.as_deref().unwrap_or_default();
            if matches!(message, "import" | "repair" | "outside" | "genesis")
                || change.peer >> 63 != 0
            {
                continue;
            }
            let local = peers.get(&info.doc_id) == Some(&change.peer);
            let author = local && matches!(message, "" | "user" | "user:command" | "mirror");
            if request.mode == DeltaMode::LocalAuthorBodies && !author {
                continue;
            }
            if message.starts_with("agent:") {
                sources.agent += 1;
            } else if author {
                sources.author += 1;
            } else if !local {
                sources.remote += 1;
            } else {
                continue;
            }
            last_changed_ms = last_changed_ms.max(change.timestamp.saturating_mul(1000));
        }
        if sources == ChangeSources::default() {
            continue;
        }
        let captured = DocumentCursor {
            frontiers: copy.oplog_frontiers().encode(),
            counters: copy
                .oplog_vv()
                .iter()
                .map(|(peer, counter)| (*peer, *counter))
                .collect(),
        };
        let view = BorrowedProse::new(&copy, &id)?;
        let after: Vec<_> = view
            .view()
            .paragraphs()
            .enumerate()
            .map(|(index, p)| {
                (
                    p.id.as_ref()
                        .map(ToString::to_string)
                        .unwrap_or_else(|| format!("@{index}")),
                    p.text(),
                )
            })
            .collect();
        let baseline = match previous {
            Some(cursor) => Some(
                Frontiers::decode(&cursor.frontiers)
                    .map_err(|e| Error::Protocol(format!("invalid suggestion cursor: {e}")))?,
            ),
            None => lib
                .history(&info.doc_id)?
                .into_iter()
                .filter(|h| h.ts <= since_ms)
                .max_by_key(|h| h.ts)
                .map(|h| h.frontiers),
        };
        let before = baseline
            .as_ref()
            .map(|frontiers| -> Result<Vec<(String, String)>> {
                let baseline = lib.load_copy_at(&info.doc_id, frontiers)?;
                let view = BorrowedProse::new(&baseline, &id)?;
                Ok(view
                    .view()
                    .paragraphs()
                    .enumerate()
                    .map(|(index, p)| {
                        (
                            p.id.as_ref()
                                .map(ToString::to_string)
                                .unwrap_or_else(|| format!("@{index}")),
                            p.text(),
                        )
                    })
                    .collect())
            })
            .transpose()?;
        if let Some(digest) = digest(before.as_deref(), &after) {
            changed.push((
                ChangedDocument {
                    reference: String::new(),
                    doc: info.doc_id,
                    target: target.clone(),
                    last_changed_ms,
                    sources,
                    has_baseline: before.is_some(),
                    digest,
                },
                captured,
            ));
        } else {
            batch.coverage.documents.insert(info.doc_id, captured);
        }
    }
    // Oldest first lets a bounded sequence make progress even while newer
    // documents keep arriving. Unselected documents retain their old cursor.
    changed.sort_by(|(a, _), (b, _)| {
        a.last_changed_ms
            .cmp(&b.last_changed_ms)
            .then_with(|| a.doc.cmp(&b.doc))
    });
    batch.omitted = changed.len().saturating_sub(request.limit);
    for (mut document, cursor) in changed.into_iter().take(request.limit) {
        document.reference = format!("c{}", batch.documents.len() + 1);
        batch
            .coverage
            .documents
            .insert(document.doc.clone(), cursor);
        batch.documents.push(document);
    }
    Ok(batch)
}

// JSON object keys are strings. Deserialize explicitly so this also works
// through serde's internally tagged enum buffer (ActiveSuggestion).
mod peer_counters {
    use super::*;
    pub fn serialize<S: serde::Serializer>(
        value: &BTreeMap<u64, i32>,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        value
            .iter()
            .map(|(peer, count)| (peer.to_string(), *count))
            .collect::<BTreeMap<_, _>>()
            .serialize(serializer)
    }
    pub fn deserialize<'de, D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<BTreeMap<u64, i32>, D::Error> {
        BTreeMap::<String, i32>::deserialize(deserializer)?
            .into_iter()
            .map(|(peer, count)| Ok((peer.parse().map_err(serde::de::Error::custom)?, count)))
            .collect()
    }
}
