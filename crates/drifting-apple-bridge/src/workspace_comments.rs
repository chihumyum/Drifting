//! The project's comments outside a text selection: TODOs that float or sit
//! on a whole chapter or drift, kind and priority changes, resolve and
//! delete. Selection notes are created through the chapter's owner.
use super::elements::present;
use super::*;
use drifting_core::workspace::{CommentPatch, NewComment};

#[derive(Debug, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum CommentsCommand {
    List,
    /// A floating TODO, or a note or TODO on a whole chapter, drift,
    /// element, category or storyline.
    Create {
        kind: String,
        #[serde(default)]
        target_kind: Option<String>,
        #[serde(default)]
        target_id: Option<String>,
        body: String,
        #[serde(default)]
        priority: Option<String>,
    },
    /// Absent fields stay; `priority: null` clears it.
    Update {
        comment_id: String,
        #[serde(default)]
        body: Option<String>,
        #[serde(default)]
        kind: Option<String>,
        #[serde(default, deserialize_with = "present")]
        priority: Option<Option<String>>,
    },
    SetResolved {
        comment_id: String,
        resolved: bool,
    },
    Delete {
        comment_id: String,
    },
}

impl WorkspaceSession {
    pub(super) fn comments(
        &mut self,
        documents: &mut HashMap<u64, LabSession>,
        project_id: &str,
        command: &CommentsCommand,
    ) -> Result<Value, String> {
        let project = self.project(project_id)?;
        let store = WorkspaceStore::new(&self.gateway, CLIENT);
        let result = match command {
            CommentsCommand::List => Value::Null,
            CommentsCommand::Create {
                kind,
                target_kind,
                target_id,
                body,
                priority,
            } => json!(store.create_comment(
                &self.context(&project)?,
                NewComment {
                    id: identifier("comment")?,
                    author_id: WORKSPACE_USER.into(),
                    kind: kind.clone(),
                    target: match (target_kind, target_id) {
                        (Some(kind), Some(id)) => Some((kind.clone(), id.clone())),
                        (None, None) => None,
                        _ => return Err("targetKind and targetId go together".into()),
                    },
                    target_block_ids: Vec::new(),
                    anchor_json: None,
                    body_text: body.clone(),
                    priority: priority.clone(),
                },
            )?),
            CommentsCommand::Update {
                comment_id,
                body,
                kind,
                priority,
            } => json!(store.update_comment(
                &self.context(&project)?,
                comment_id,
                CommentPatch {
                    body_text: body.clone(),
                    kind: kind.clone(),
                    priority: priority.clone(),
                },
            )?),
            CommentsCommand::SetResolved {
                comment_id,
                resolved,
            } => json!(store.set_comment_resolved(
                &self.context(&project)?,
                comment_id,
                *resolved
            )?),
            CommentsCommand::Delete { comment_id } => {
                // An open owner tracks the anchor; it must not persist the
                // deleted row's anchor afterwards.
                let target = store
                    .project_comments(project_id)?
                    .into_iter()
                    .find(|comment| comment.id == *comment_id)
                    .filter(|comment| comment.target_kind.as_deref() == Some("node"))
                    .and_then(|comment| comment.target_id);
                let owner = target.and_then(|node| {
                    let key = (project_id.to_owned(), node);
                    self.documents
                        .get(&key)
                        .or_else(|| self.drift_bodies.get(&key))
                        .copied()
                });
                if let Some(session) = owner.and_then(|handle| documents.get(&handle)) {
                    if session.write_blocked() {
                        return Err("请先重试未保存的修改，再删除这条批注".into());
                    }
                }
                store.delete_comment(&self.context(&project)?, comment_id)?;
                if let Some(session) = owner.and_then(|handle| documents.get_mut(&handle)) {
                    let records = session
                        .document
                        .comment_anchor_records()
                        .into_iter()
                        .filter(|record| record.id != *comment_id)
                        .collect();
                    session.document.set_comment_anchors(records)?;
                    session.persisted_comments.remove(comment_id);
                }
                Value::Null
            }
        };
        Ok(json!({"result": result, "comments": store.project_comments(project_id)?}))
    }
}
