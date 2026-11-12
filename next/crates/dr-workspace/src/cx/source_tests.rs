use super::*;
use crate::{WorkspaceOptions, WritePreconditions, library_options};
use dr_model::id::{CommentId, ModuleId};
use dr_model::kind::{CommentKind, EntityKind};
use dr_model::shared::{BlockSnapshot, EntityRef};
use dr_store::{Library, Origin};
use serde_json::json;
use std::sync::mpsc;
use std::time::Duration;

#[test]
fn guarded_source_read_serializes_a_real_concurrent_writer_and_keeps_historical_quote() {
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(dir.path(), library_options("source-race")).unwrap();
    let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
    ws.set_auto_links(false);
    let call = |name, input| ws.call(&Actor::User, name, input).unwrap()["output"].clone();
    let book = call("project.create", json!({"name":"Source race"}))["id"]
        .as_str()
        .unwrap()
        .to_string();
    let entries = call("entry.list", json!({"book":book}));
    let root = entries
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["template"] == "tpl-manuscript")
        .unwrap()["id"]
        .clone();
    let entry = call(
        "entry.create",
        json!({"book":book,"parent":root,"template":"tpl-chapter",
        "title":"Source","bodies":{"mod-prose":"alpha selected omega"}}),
    )["id"]
        .as_str()
        .unwrap()
        .to_string();
    let doc = DocId::parse(&format!("body:{entry}/mod-prose")).unwrap();
    let old_body = ws.observe(&doc.to_string()).unwrap();
    let old_book = ws.observe(&format!("book:{book}")).unwrap();
    let actor = Actor::agent("source-race", 1, "comment");
    let cx = Cx::guarded(
        &ws,
        &actor,
        crate::registry().get("comment.create").unwrap(),
        crate::guard::Guards::parse(WritePreconditions::from_observations([
            old_book.clone(),
            old_body.clone(),
        ]))
        .unwrap(),
    );
    let book_slot = cx.book_v3(&book).unwrap();
    let prose = cx.prose(&doc).unwrap();
    let writer = prose.handle.clone();
    let writer_doc = doc.clone();
    let (reading, start_write) = mpsc::channel();
    let (submitted, queued) = mpsc::channel();
    // Actor B really queues a user write while actor A is between its source
    // guard check and quote/cursor derivation. No sleeps or production hooks.
    let peer = std::thread::spawn(move || {
        start_write.recv_timeout(Duration::from_secs(10)).unwrap();
        let pending = writer
            .submit(Origin::User, move |raw| {
                BorrowedProse::new(raw, &writer_doc)
                    .unwrap()
                    .txn()
                    .insert_text(0, "new ")
            })
            .unwrap();
        submitted.send(()).unwrap();
        pending.wait().unwrap().0.unwrap();
    });
    let source_doc = doc.clone();
    let expected_version = old_body.version.clone();
    let (anchor, quote, snapshots) = cx
        .read_prose_source(&prose, move |raw| {
            reading.send(()).unwrap();
            queued.recv_timeout(Duration::from_secs(10)).unwrap();
            assert_eq!(
                crate::naming::frontiers_hex(&raw.oplog_frontiers()),
                expected_version
            );
            let body = BorrowedProse::new(raw, &source_doc)?;
            let view = body.view();
            let anchor = view.anchor(6..14).unwrap();
            let quote = view.text_in(6..14)?;
            let snapshots = view
                .paragraphs()
                .map(|p| BlockSnapshot {
                    block: p.id.clone(),
                    text: p.text(),
                })
                .collect::<Vec<_>>();
            Ok((anchor, quote, snapshots))
        })
        .unwrap();
    peer.join().unwrap();
    let after_body = ws.observe(&doc.to_string()).unwrap();
    assert_ne!(old_body.version, after_body.version);
    assert_eq!(quote, "selected");
    assert_eq!(snapshots[0].text, "alpha selected omega");
    assert_eq!(prose.reader.view().resolve(&anchor).unwrap().range, 10..18);

    // Source is now newer, yet stable cursors still name the verified text.
    // Book CAS remains separate; no claim of an atomic two-document commit.
    let id = CommentId::new_v7();
    let key = id.to_string();
    cx.write_book_v3(&book_slot, Replaces::nothing(), move |txn| {
        txn.comment(&id)?
            .kind(&CommentKind::Note)?
            .target(Some(&EntityRef::new(EntityKind::Entry, entry)))?
            .module(Some(&ModuleId::parse("mod-prose").unwrap()))?
            .anchor(Some(&anchor))?
            .quote(Some(&quote))?
            .snapshots(&snapshots)?
            .body("Review")?;
        Ok(())
    })
    .unwrap();
    let after_book = ws.observe(&format!("book:{book}")).unwrap();
    let mut only_addition = old_book.value;
    only_addition["comments"][&key] = after_book.value["comments"][&key].clone();
    assert_eq!(only_addition, after_book.value);
    assert_eq!(after_book.value["comments"][&key]["quote"], "selected");
    assert_eq!(
        after_body.version,
        ws.observe(&doc.to_string()).unwrap().version
    );
    assert_eq!(
        after_body.value,
        ws.observe(&doc.to_string()).unwrap().value
    );
    drop(cx);
    ws.close();
}
