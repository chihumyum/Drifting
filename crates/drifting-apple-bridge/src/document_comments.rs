//! Direct comments on an open workspace chapter. The shared core commits the
//! row and its canonical original; only then does the live owner track the
//! same anchor record, which also becomes its comment CAS baseline.
use super::*;
use drifting_core::workspace::{NewChapterComment, WorkspaceStore};
use drifting_document::NativeRange;

fn workspace_session(session: &LabSession) -> Result<(), String> {
    if session.owner.workspace {
        Ok(())
    } else {
        Err("Comments require a workspace chapter".into())
    }
}

pub(super) fn list(session: &LabSession) -> Result<Value, String> {
    workspace_session(session)?;
    let comments = WorkspaceStore::new(&session.gateway, CLIENT)
        .chapter_comments(&session.owner.scope.project_id, &session.owner.chapter_id)?;
    Ok(json!({ "comments": comments }))
}

pub(super) fn create(
    session: &mut LabSession,
    revision: u64,
    range: NativeRange,
    body: &str,
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
    let comment = WorkspaceStore::new(&session.gateway, CLIENT).create_chapter_comment(
        &context,
        NewChapterComment {
            id: id.clone(),
            chapter_id: session.owner.chapter_id.clone(),
            author_id: workspace::WORKSPACE_USER.into(),
            body_text: body.into(),
            anchor_json: anchor.record.anchor_json.clone(),
            target_block_ids: anchor.target_block_ids,
        },
    )?;
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
        &session.owner.chapter_id,
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
        &session.owner.chapter_id,
        comment_id,
        resolved,
    )?;
    Ok(json!({ "comment": comment }))
}
