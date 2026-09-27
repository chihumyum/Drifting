//! Direct comments on an open workspace chapter. The shared core commits the
//! row and its canonical original; only then does the live owner track the
//! same anchor record, which also becomes its comment CAS baseline.
use super::*;
use drifting_core::workspace::{NewChapterComment, NewSuggestion, WorkspaceStore};

/// A Copilot suggestion's proposal (a JSON object) and optional priority.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SuggestionInput {
    metadata: Value,
    #[serde(default)]
    priority: Option<String>,
}
use drifting_document::NativeRange;

fn workspace_session(session: &LabSession) -> Result<(), String> {
    if session.owner.workspace && session.owner.target_kind == "node" {
        Ok(())
    } else {
        Err("Comments require a workspace chapter".into())
    }
}

pub(super) fn list(session: &LabSession) -> Result<Value, String> {
    workspace_session(session)?;
    let comments = WorkspaceStore::new(&session.gateway, CLIENT)
        .chapter_comments(&session.owner.scope.project_id, &session.owner.target_id)?;
    Ok(json!({ "comments": comments }))
}

pub(super) fn create(
    session: &mut LabSession,
    revision: u64,
    range: NativeRange,
    body: &str,
    suggestion: Option<SuggestionInput>,
) -> Result<Value, String> {
    workspace_session(session)?;
    if session.write_blocked() {
        return Err("Retry the pending save before commenting".into());
    }
    let context = session.authored_context()?;
    let id = workspace::identifier("comment")?;
    let anchor =
        session
            .document
            .comment_anchor_for_selection(&id, revision, range, &context.now_iso)?;
    let input = NewChapterComment {
        id: id.clone(),
        chapter_id: session.owner.target_id.clone(),
        author_id: workspace::WORKSPACE_USER.into(),
        body_text: body.into(),
        anchor_json: anchor.record.anchor_json.clone(),
        target_block_ids: anchor.target_block_ids,
    };
    let store = WorkspaceStore::new(&session.gateway, CLIENT);
    let comment = match suggestion {
        Some(suggestion) => store.create_chapter_suggestion(
            &context,
            input,
            NewSuggestion {
                metadata_json: suggestion.metadata.to_string(),
                priority: suggestion.priority,
            },
        )?,
        None => store.create_chapter_comment(&context, input)?,
    };
    session.persisted_comments.insert(id, anchor.record.clone());
    session.document.add_comment_anchor(anchor.record)?;
    session.persist();
    Ok(json!({ "comment": comment, "state": session.document_state()? }))
}

pub(super) fn update_body(
    session: &LabSession,
    comment_id: &str,
    body: &str,
) -> Result<Value, String> {
    workspace_session(session)?;
    let comment = WorkspaceStore::new(&session.gateway, CLIENT).update_chapter_comment_body(
        &session.authored_context()?,
        &session.owner.target_id,
        comment_id,
        body,
    )?;
    Ok(json!({ "comment": comment }))
}

pub(super) fn set_resolved(
    session: &LabSession,
    comment_id: &str,
    resolved: bool,
) -> Result<Value, String> {
    workspace_session(session)?;
    let comment = WorkspaceStore::new(&session.gateway, CLIENT).set_chapter_comment_resolved(
        &session.authored_context()?,
        &session.owner.target_id,
        comment_id,
        resolved,
    )?;
    Ok(json!({ "comment": comment }))
}
