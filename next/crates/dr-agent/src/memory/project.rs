use dr_model::id::{BookId, MemoryId};
use dr_workspace::Workspace;
use serde::{Deserialize, Serialize};

use super::{MemoryError, MemoryResult};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProjectEntry {
    pub id: MemoryId,
    pub body: String,
    pub kind: String,
    pub status: String,
    pub source: String,
    #[serde(default)]
    pub removed: bool,
}
impl ProjectEntry {
    pub fn active(&self) -> bool {
        !self.removed && self.status == "active"
    }
}
#[derive(Clone, Debug)]
pub struct ProjectSnapshot {
    /// All nondeleted entries retain their open-enum status. Only active
    /// entries are instructions; pending/unknown never become active on read.
    pub entries: Vec<ProjectEntry>,
    pub markdown: String,
    pub version: String,
    /// The guard of a change made from this snapshot: held to the entries it
    /// replaces as they were read here.
    pub guard: dr_workspace::WritePreconditions,
}

pub fn project(ws: &Workspace, book: &BookId) -> MemoryResult<ProjectSnapshot> {
    let doc = format!("book:{book}");
    let error = |e: dr_workspace::WsError| MemoryError::Invalid(e.to_string());
    for _ in 0..3 {
        let before = ws.version(&doc).map_err(error)?;
        let copy = ws
            .library()
            .load_copy(&doc)
            .map_err(|e| MemoryError::Invalid(e.to_string()))?;
        let mut entries: Vec<ProjectEntry> = {
            let borrowed = dr_doc::v3::BorrowedBookV3::new(&copy, book)
                .map_err(|e| MemoryError::Invalid(e.to_string()))?;
            let view = borrowed.view();
            if view.trashed_at().is_some() {
                return Err(MemoryError::Invalid("book is unavailable".into()));
            }
            view.memory()
                .into_iter()
                .map(|m| ProjectEntry {
                    id: m.id,
                    body: m.body,
                    kind: m.kind.as_str().to_owned(),
                    status: m.status.as_str().to_owned(),
                    source: m.source.as_str().to_owned(),
                    removed: m.deleted_at.is_some(),
                })
                .collect()
        };
        // The digest of each entry, in the same state as the copy: a change
        // made from this snapshot is held to the entry it changes.
        let keys: Vec<dr_workspace::RecordKey> = entries
            .iter()
            .map(|e| dr_workspace::RecordKey::record("memory", e.id.as_str()))
            .collect();
        let shown = ws.observe_records(&doc, &keys).map_err(error)?;
        let after = ws.version(&doc).map_err(error)?;
        if before != after {
            continue;
        }
        entries.retain(|e| !e.removed);
        entries.sort_by(|a, b| a.id.cmp(&b.id));
        let mut markdown = String::from("# PROJECT_MEMORY.md\n");
        let mut first = true;
        for entry in entries.iter().filter(|e| e.active()) {
            markdown.push_str(if first { "\n" } else { "\n\n" });
            first = false;
            markdown.push_str(&entry.body);
        }
        if !markdown.ends_with('\n') {
            markdown.push('\n');
        }
        return Ok(ProjectSnapshot {
            entries,
            markdown,
            version: after,
            guard: dr_workspace::WritePreconditions::default()
                .with_shown(shown.into_iter().map(Into::into)),
        });
    }
    Err(MemoryError::Invalid(
        "project memory changed; read again".into(),
    ))
}
