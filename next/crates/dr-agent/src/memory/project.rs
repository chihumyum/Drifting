use dr_model::id::{BookId, MemoryId};
use dr_workspace::{Actor, Workspace};
use serde::{Deserialize, Serialize};
use serde_json::json;

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
}

pub fn project(ws: &Workspace, book: &BookId) -> MemoryResult<ProjectSnapshot> {
    let doc = format!("book:{book}");
    let error = |e: dr_workspace::WsError| MemoryError::Invalid(e.to_string());
    for _ in 0..3 {
        let before = ws.observe(&doc).map_err(error)?;
        let detail = ws
            .call(&Actor::User, "book.get", json!({"book":book}))
            .map_err(error)?;
        if detail["output"]["trashed"].as_bool() != Some(false) {
            return Err(MemoryError::Invalid("book is unavailable".into()));
        }
        let rows = ws
            .call(&Actor::User, "memory.list", json!({"book":book}))
            .map_err(error)?;
        let after = ws.observe(&doc).map_err(error)?;
        if before.version != after.version {
            continue;
        }
        let mut entries: Vec<ProjectEntry> =
            serde_json::from_value(rows["output"].clone()).map_err(|_| MemoryError::Corrupt)?;
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
            version: after.version,
        });
    }
    Err(MemoryError::Invalid(
        "project memory changed; read again".into(),
    ))
}
