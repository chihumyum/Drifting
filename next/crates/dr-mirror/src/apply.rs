//! Workspace operations following a file merge. Keep the ordinary field
//! validators and the canonical comment projection in the workspace.

use std::collections::BTreeSet;

use dr_doc::{prose::BorrowedProse, v3::BorrowedBookV3};
use dr_model::{
    DocId,
    id::{BlockId, BodyDocId, BookId, EntryTemplateId},
    kind::CommentOrigin,
};
use dr_workspace::{Actor, RecordKey, Workspace, WritePreconditions, WsError};
use serde_json::json;

use crate::file::{FieldEdit, FieldSlot};

/// Apply only the edited slots, each with a guard for the value the file
/// came from (or the value it already supplied on an earlier pass). A slot
/// whose file value does not fit the field is refused without a write.
pub fn apply_fields(
    ws: &Workspace,
    book: &BookId,
    body: &BodyDocId,
    template: &EntryTemplateId,
    fields: &[FieldEdit],
) -> dr_workspace::Result<Vec<FieldSlot>> {
    let doc = DocId::Book(book.clone()).to_string();
    let entry = RecordKey::entry(body.entry().as_str());
    let mut refused = Vec::new();
    for edit in fields {
        let slot = &edit.slot;
        let Some(value) = &edit.value else {
            refused.push(slot.clone());
            continue;
        };
        let key = entry
            .clone()
            .at(["fields", slot.module.as_str(), &slot.field]);
        let want = json!(value);
        let guards = WritePreconditions::default()
            .with_value(&doc, key, [json!(edit.expected), want.clone()])
            .with_value(&doc, entry.clone().at(["template"]), [json!(template)])
            .with_value(
                &doc,
                entry.clone().at(["deleted_at"]),
                [serde_json::Value::Null],
            );
        let result = ws.call_guarded(
            &Actor::Mirror,
            "module.set_field",
            json!({"book":book,"entry":body.entry(),"module":slot.module,"field":slot.field,"value":want}),
            guards,
        );
        match result {
            Ok(_) => {}
            Err(
                WsError::Conflict(_)
                | WsError::Invalid(_)
                | WsError::Violation(_)
                | WsError::NotFound { .. },
            ) => {
                refused.push(slot.clone());
            }
            Err(err) => return Err(err),
        }
    }
    Ok(refused)
}

pub fn save_before_removal(
    ws: &Workspace,
    book: &BookId,
    body: &BodyDocId,
) -> dr_workspace::Result<()> {
    ws.call(
        &Actor::Mirror,
        "entry_snapshot.create",
        json!({"book":book,"entry":body.entry()}),
    )?;
    Ok(())
}

/// One open conflict comment per paragraph. The same notification can be
/// processed again after interruption without adding another open comment.
/// The comments are found by the folder's stable author id and the
/// paragraph, never by the shown name or text, which follow the interface
/// language.
pub fn record_conflicts(
    ws: &Workspace,
    book: &BookId,
    body: &BodyDocId,
    blocks: &[BlockId],
    author: &str,
    text: &str,
) -> dr_workspace::Result<()> {
    if blocks.is_empty() {
        return Ok(());
    }
    let mirror = Actor::Mirror.comment_author();
    let found = {
        let book = book.clone();
        let owning = body.clone();
        ws.read_book_v3(book.as_str(), {
            let book = book.clone();
            move |raw, _| {
                let view = BorrowedBookV3::new(raw, &book)?;
                Ok(view
                    .view()
                    .comments()
                    .into_iter()
                    .filter(|c| {
                        !c.is_done()
                            && c.origin == CommentOrigin::Manual
                            && c.author.as_deref() == mirror
                            && c.target
                                .as_ref()
                                .is_some_and(|t| t.id == owning.entry().as_str())
                            && c.target_module.as_ref() == Some(owning.module())
                    })
                    .filter_map(|c| c.target_block)
                    .collect::<BTreeSet<_>>())
            }
        })?
    };
    for block in blocks.iter().filter(|block| !found.contains(*block)) {
        let result = ws.call(
            &Actor::Mirror,
            "comment.create",
            json!({
                "book":book,"target":{"kind":"entry","id":body.entry()},"module":body.module(),
                "block_id":block,"author_name":author,"body":text,"origin":"manual"
            }),
        );
        // It may have been removed by a concurrent edit after the file
        // was merged. The author can still read the saved file.
        if !matches!(result, Err(WsError::NotFound { .. })) {
            result?;
        }
    }
    Ok(())
}

/// Run the existing projection from the current prose. The shell supplies
/// the same marker reader the editor uses.
pub fn project_comments(
    ws: &Workspace,
    body: &BodyDocId,
    marker: impl Fn(&str) -> Option<String>,
) -> dr_workspace::Result<()> {
    let doc = DocId::Body(body.clone());
    let name = doc.to_string();
    let raw = ws.library().load_copy(&name)?;
    let prose = BorrowedProse::new(&raw, &doc)?;
    let markers: Vec<_> = prose
        .view()
        .paragraphs()
        .filter_map(|p| {
            let task = marker(&p.text())?;
            Some(json!({"block":p.id?, "task":task}))
        })
        .collect();
    ws.call(
        &Actor::Mirror,
        "comment.project",
        json!({"doc":name,"markers":markers,"tasks":[]}),
    )?;
    Ok(())
}
