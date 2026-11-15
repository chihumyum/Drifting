//! What the editor (F4, `dr-editor`) calls besides its session: comment
//! anchors its undo brings back, and the TODOs it finds typed as markers.

mod common;

use common::*;
use dr_doc::anchor::Anchor;
use dr_model::DocId;
use dr_model::id::{BlockId, CommentId};
use dr_model::kind::ProjectionKind;
use dr_store::OpenDoc;
use dr_workspace::dto::AnchorBytes;
use dr_workspace::{Actor, RecordKey, Workspace, WritePreconditions, WsError};
use loro::ExportMode;
use serde_json::{Value, json};

fn id(v: &Value) -> String {
    v["id"].as_str().unwrap().to_string()
}

/// Import `doc` of `from` into `to`, as sync would.
fn sync_doc(from: &Workspace, to: &Workspace, doc: &str) {
    let info = from.library().doc_info(doc).unwrap().expect("stored");
    if from.library().head(doc).unwrap().is_none() {
        return;
    }
    let bytes = from
        .library()
        .load_copy(doc)
        .unwrap()
        .export(ExportMode::all_updates())
        .unwrap();
    let book = info.book_id.clone().unwrap_or_default();
    to.import_remote(doc, Some((&info.kind, &book)), bytes, &Actor::Sync)
        .unwrap();
}

/// Every stored document of `from`, into `to`.
fn sync(from: &Workspace, to: &Workspace) {
    let mut docs = from.library().docs(None, None).unwrap();
    docs.sort_by_key(|d| (d.kind != "book", d.doc_id.clone()));
    for d in docs {
        sync_doc(from, to, &d.doc_id);
    }
}

/// An anchor on characters `range` of `doc`'s body, made the way the editor
/// makes one (on the holder thread).
fn anchor(ws: &Workspace, doc: &str, range: std::ops::Range<usize>) -> AnchorBytes {
    let h = ws.library().open_doc(doc, OpenDoc::Existing).unwrap();
    let a = h
        .read(move |d| Anchor::new(&d.get_text("body"), range))
        .unwrap()
        .expect("anchor");
    AnchorBytes::from(&a.encode())
}

fn anchors(e: &Env, b: &str, chapter: &str) -> Value {
    e.out(
        "comment.anchors",
        json!({"book": b, "target": {"kind": "entry", "id": chapter}, "module":"mod-prose"}),
    )
}

#[test]
fn reanchor_puts_back_what_the_editors_undo_brought_back() {
    let e = env();
    let b = e.book();
    let c = id(&e.out(
        "entry.create", json!({"book": b, "parent": common::acceptance::novel_root(e.ws(), &b, "tpl-manuscript"), "template": "tpl-chapter", "title": "One", "bodies": {"mod-prose": "灯塔亮了。潮水退了。"}}),
    ));
    let doc = format!("body:{c}/mod-prose");
    let note = id(&e.out(
        "comment.create",
        json!({"book": b, "target": {"kind": "entry", "id": c}, "module":"mod-prose", "range": [0, 2], "body": "灯塔？"}),
    ));
    let list = anchors(&e, &b, &c);
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["id"], note.as_str());
    let first: AnchorBytes = serde_json::from_value(list[0]["anchor"].clone()).unwrap();
    // The author deletes the passage and undoes it in the editor: the text
    // comes back under new operations, the stored anchor is collapsed, and
    // the editor hands over the anchor its undo item carried.
    let s = e.ws().prose_session(&doc).unwrap();
    s.edit(|t| t.delete(0..5)).unwrap();
    assert!(s.undo().unwrap());
    let back = anchor(e.ws(), &doc, 0..2);
    assert_ne!(back, first);
    let o = e.call(
        "comment.reanchor",
        json!({"book": b, "id": note, "anchor": back}),
    );
    assert_eq!(effects(&o), ["updated comment"]);
    let list = anchors(&e, &b, &c);
    assert_eq!(list[0]["anchor"], serde_json::to_value(&back).unwrap());
    // It follows the editor's undo: no journal row, so the object-level undo
    // neither stops at it nor loses its redo to it. Its own inverse is given.
    assert!(o["journal"].is_null());
    assert!(
        e.ws()
            .journal(Some("user"), 10)
            .unwrap()
            .iter()
            .all(|j| j.command != "comment.reanchor")
    );
    let inverse = o["undo"][0].clone();
    assert_eq!(inverse["command"], "comment.reanchor");
    e.call("comment.reanchor", inverse["input"].clone());
    assert_eq!(
        anchors(&e, &b, &c)[0]["anchor"],
        serde_json::to_value(&first).unwrap()
    );
    // The same anchor again changes nothing.
    let o = e.call(
        "comment.reanchor",
        json!({"book": b, "id": note, "anchor": first}),
    );
    assert!(effects(&o).is_empty());
    // `null` removes it; the comment stays on its chapter.
    e.call(
        "comment.reanchor",
        json!({"book": b, "id": note, "anchor": null}),
    );
    assert!(anchors(&e, &b, &c).as_array().unwrap().is_empty());
    let info = &e.out("comment.list", json!({"book": b}))[0];
    assert_eq!(info["anchored"], false);
    assert_eq!(info["target"]["id"], c.as_str());
}

#[test]
fn reanchor_refuses_what_is_not_an_anchor_here() {
    let e = env();
    let b = e.book();
    let c = id(&e.out(
        "entry.create", json!({"book": b, "parent": common::acceptance::novel_root(e.ws(), &b, "tpl-manuscript"), "template": "tpl-chapter", "title": "One", "bodies": {"mod-prose": "灯塔亮了。"}}),
    ));
    let note = id(&e.out(
        "comment.create",
        json!({"book": b, "target": {"kind": "entry", "id": c}, "module":"mod-prose", "range": [0, 2]}),
    ));
    let floating = id(&e.out("comment.create", json!({"book": b, "body": "随手"})));
    let good = anchor(e.ws(), &format!("body:{c}/mod-prose"), 0..2);
    let refused = |input: Value| {
        e.try_call("comment.reanchor", input)
            .expect_err("refused")
            .code()
    };
    assert_eq!(refused(json!({"book": b, "id": note})), "bad_input");
    assert_eq!(
        refused(json!({"book": b, "id": note, "anchor": {"start": "%%", "end": "%%"}})),
        "invalid"
    );
    assert_eq!(
        refused(json!({"book": b, "id": note, "anchor": {"start": "AAAA", "end": "AAAA"}})),
        "invalid"
    );
    assert_eq!(
        refused(json!({"book": b, "id": floating, "anchor": good})),
        "invalid"
    );
    assert_eq!(
        refused(json!({"book": b, "id": "nope", "anchor": good})),
        "not_found"
    );
    // A cursor on operations this device has never seen.
    let other = env();
    let ob = other.book();
    let oc = id(&other.out(
        "entry.create", json!({"book": ob, "parent": common::acceptance::novel_root(other.ws(), &ob, "tpl-manuscript"), "template": "tpl-chapter", "title": "Elsewhere", "bodies": {"mod-prose": "别处的字。"}}),
    ));
    let elsewhere = anchor(other.ws(), &format!("body:{oc}/mod-prose"), 0..2);
    assert_eq!(
        refused(json!({"book": b, "id": note, "anchor": elsewhere})),
        "invalid"
    );
}

#[test]
fn a_reanchor_reaches_the_other_device() {
    let a = env();
    let b_dev = env();
    let b = a.book();
    let c = id(&a.out(
        "entry.create", json!({"book": b, "parent": common::acceptance::novel_root(a.ws(), &b, "tpl-manuscript"), "template": "tpl-chapter", "title": "One", "bodies": {"mod-prose": "灯塔亮了。潮水退了。"}}),
    ));
    let note = id(&a.out(
        "comment.create",
        json!({"book": b, "target": {"kind": "entry", "id": c}, "module":"mod-prose", "range": [0, 2]}),
    ));
    sync(a.ws(), b_dev.ws());
    let moved = anchor(a.ws(), &format!("body:{c}/mod-prose"), 5..7);
    a.call(
        "comment.reanchor",
        json!({"book": b, "id": note, "anchor": moved}),
    );
    sync_doc(a.ws(), b_dev.ws(), &format!("book:{b}"));
    assert_eq!(
        anchors(&b_dev, &b, &c)[0]["anchor"],
        serde_json::to_value(&moved).unwrap()
    );
}

// ---- TODO markers ---------------------------------------------------------

struct Chapter {
    book: String,
    id: String,
    doc: String,
    /// Block ids, paragraph by paragraph.
    blocks: Vec<String>,
}

fn chapter(e: &Env, b: &str, text: &str) -> Chapter {
    let c = id(&e.out(
        "entry.create", json!({"book": b, "parent": common::acceptance::novel_root(e.ws(), &b, "tpl-manuscript"), "template": "tpl-chapter", "title": "One", "bodies": {"mod-prose": text}}),
    ));
    let doc = format!("body:{c}/mod-prose");
    let blocks = field(
        &e.out("prose.read", json!({"doc": doc}))["paragraphs"],
        "block_id",
    )
    .into_iter()
    .map(|v| v.as_str().unwrap().to_string())
    .collect();
    Chapter {
        book: b.to_string(),
        id: c,
        doc,
        blocks,
    }
}

fn project(e: &Env, ch: &Chapter, markers: &[(usize, &str)], editing: Option<usize>) -> Value {
    let markers: Vec<Value> = markers
        .iter()
        .map(|(i, t)| json!({"block": ch.blocks[*i], "task": t}))
        .collect();
    let mut input = json!({"doc": ch.doc, "markers": markers});
    if let Some(i) = editing {
        input["editing"] = json!(ch.blocks[i]);
    }
    e.call("comment.project", input)
}

fn todo_id(ch: &Chapter, i: usize) -> String {
    CommentId::for_projection(
        &ProjectionKind::Marker,
        &DocId::parse(&ch.doc).unwrap(),
        &BlockId::parse(&ch.blocks[i]).unwrap(),
    )
    .to_string()
}

fn todos(e: &Env, ch: &Chapter) -> Vec<Value> {
    e.out(
        "comment.list",
        json!({"book": ch.book, "origin": "marker", "target": {"kind": "entry", "id": ch.id}, "module":"mod-prose"}),
    )
    .as_array()
    .unwrap()
    .clone()
}

#[test]
fn markers_project_into_todos_by_the_old_rules() {
    let e = env();
    let b = e.book();
    let ch = chapter(
        &e,
        &b,
        "第一段。\nTODO: 查一查赵太爷的年纪\n待办：\n普通的一段。",
    );
    // The author is still typing in paragraph 2: only paragraph 1 projects.
    let o = project(&e, &ch, &[(1, "查一查赵太爷的年纪"), (2, "")], Some(2));
    assert_eq!(o["output"]["created"], json!([todo_id(&ch, 1)]));
    let list = todos(&e, &ch);
    assert_eq!(list.len(), 1);
    let t = &list[0];
    assert_eq!(t["body"], "查一查赵太爷的年纪");
    assert_eq!(t["projection"], "marker");
    assert_eq!(t["target_block"], ch.blocks[1].as_str());
    assert_eq!(t["status"], "open");
    assert_eq!(
        (&t["author_kind"], &t["source"]),
        (&json!("user"), &json!("manual"))
    );
    // Leaving the paragraph: its marker projects, with the old placeholder.
    project(&e, &ch, &[(1, "查一查赵太爷的年纪"), (2, "")], None);
    let list = todos(&e, &ch);
    assert_eq!(list.len(), 2);
    let empty = list
        .iter()
        .find(|t| t["id"] == todo_id(&ch, 2).as_str())
        .unwrap();
    assert_eq!(empty["body"], "（此处待办）");
    // Editing the marker's text does not touch the TODO (the author may have
    // edited it in the sidebar), and nothing is written.
    let o = project(&e, &ch, &[(1, "查一查赵太爷的生日"), (2, "")], None);
    assert!(effects(&o).is_empty());
    assert_eq!(todos(&e, &ch).len(), 2);
    // A resolved TODO is frozen: its marker going away keeps it, and the
    // marker coming back does not make another.
    e.call(
        "comment.update",
        json!({"book": b, "id": todo_id(&ch, 1), "status": "resolved"}),
    );
    project(&e, &ch, &[(2, "")], None);
    project(&e, &ch, &[(1, "又来了"), (2, "")], None);
    let list = todos(&e, &ch);
    assert_eq!(list.len(), 2);
    // An open TODO whose marker is gone is deleted, also while the author is
    // in that paragraph (only creating waits).
    let o = project(&e, &ch, &[(1, "又来了")], Some(2));
    assert_eq!(o["output"]["removed"], json!([todo_id(&ch, 2)]));
    assert_eq!(todos(&e, &ch).len(), 1);
    // A marker in a paragraph that is not there (a stale list) makes nothing.
    let o = e.call(
        "comment.project",
        json!({"doc": ch.doc, "markers": [{"block": "gone-block", "task": "x"}]}),
    );
    assert!(effects(&o).is_empty());
    // Refused: no markers in a book or a material, a malformed block id.
    assert_eq!(
        e.try_call(
            "comment.project",
            json!({"doc": format!("book:{b}"), "markers": []})
        )
        .unwrap_err()
        .code(),
        "invalid"
    );
    assert_eq!(
        e.try_call(
            "comment.project",
            json!({"doc": ch.doc, "markers": [{"block": "", "task": ""}]})
        )
        .unwrap_err()
        .code(),
        "invalid"
    );
}

#[test]
fn projection_follows_prose_and_stays_out_of_the_journal() {
    let e = env();
    let b = e.book();
    let ch = chapter(&e, &b, "TODO 改名\n第二段。");
    e.call(
        "entry.update",
        json!({"book": b, "id": ch.id, "title": "Uno"}),
    );
    assert!(e.ws().undo(&Actor::User).unwrap().is_some());
    // Projecting after an undo keeps the redo: it is not the author's step.
    let o = project(&e, &ch, &[(0, "改名")], None);
    assert!(o["journal"].is_null());
    assert!(e.ws().redo(&Actor::User).unwrap().is_some());
    assert_eq!(
        e.out("entry.get", json!({"book": b,"id":ch.id}))["title"],
        "Uno"
    );
    // The object-level undo does not take the TODO back either.
    assert!(e.ws().undo(&Actor::User).unwrap().is_some());
    assert_eq!(todos(&e, &ch).len(), 1);
}

#[test]
fn two_devices_project_one_todo() {
    let a = env();
    let b_dev = env();
    let b = a.book();
    let ch = chapter(&a, &b, "第一段。\nTODO: 补一场雨\n");
    sync(a.ws(), b_dev.ws());
    // Both editors find the marker and project it before they sync.
    project(&a, &ch, &[(1, "补一场雨")], None);
    project(&b_dev, &ch, &[(1, "补一场雨")], None);
    // One exchange: both wrote the same seed change (dr-doc's
    // `project_todo`), which Loro keeps once, so the body reads once.
    sync_doc(a.ws(), b_dev.ws(), &format!("book:{b}"));
    sync_doc(b_dev.ws(), a.ws(), &format!("book:{b}"));
    for dev in [&a, &b_dev] {
        let list = todos(dev, &ch);
        assert_eq!(list.len(), 1, "one entity");
        assert_eq!(list[0]["id"], todo_id(&ch, 1).as_str());
        assert_eq!(list[0]["body"], "补一场雨");
        assert_eq!(list[0]["status"], "open");
    }
}

#[test]
fn a_todo_resolved_on_one_device_stays_resolved_when_another_projects_it_late() {
    let a = env();
    let b_dev = env();
    let b = a.book();
    let ch = chapter(&a, &b, "第一段。\nTODO: 补一场雨\n");
    sync(a.ws(), b_dev.ws());
    project(&a, &ch, &[(1, "补一场雨")], None);
    let id = todo_id(&ch, 1);
    a.call(
        "comment.update",
        json!({"book": b, "id": id, "status": "resolved", "body": "下一场雨"}),
    );
    // B, offline all along, finds the marker and projects it too.
    project(&b_dev, &ch, &[(1, "补一场雨")], None);
    sync_doc(a.ws(), b_dev.ws(), &format!("book:{b}"));
    sync_doc(b_dev.ws(), a.ws(), &format!("book:{b}"));
    for dev in [&a, &b_dev] {
        let list = todos(dev, &ch);
        assert_eq!(list.len(), 1, "one entity");
        assert_eq!(list[0]["id"], id.as_str());
        assert_eq!(
            list[0]["status"], "resolved",
            "the author's edit wins over a seed"
        );
        assert_eq!(list[0]["body"], "下一场雨");
    }
}

fn task_id(ch: &Chapter, i: usize) -> String {
    CommentId::for_projection(
        &ProjectionKind::NoteTask,
        &DocId::parse(&ch.doc).unwrap(),
        &BlockId::parse(&ch.blocks[i]).unwrap(),
    )
    .to_string()
}

fn project_tasks(e: &Env, ch: &Chapter) -> Value {
    e.call(
        "comment.project",
        json!({"doc": ch.doc, "markers": [], "tasks": []}),
    )
}

fn task_comments(e: &Env, ch: &Chapter) -> Vec<Value> {
    e.out(
        "comment.list",
        json!({"book": ch.book, "origin": "task", "target": {"kind": "entry", "id": ch.id}}),
    )
    .as_array()
    .unwrap()
    .clone()
}

fn task_comment(e: &Env, ch: &Chapter, i: usize) -> Option<Value> {
    task_comments(e, ch)
        .into_iter()
        .find(|c| c["id"] == task_id(ch, i).as_str())
}

/// Whether paragraph `i` of `ch`'s prose is a ticked checklist item.
fn ticked(e: &Env, ch: &Chapter, i: usize) -> bool {
    let doc = DocId::parse(&ch.doc).unwrap();
    let block = BlockId::parse(&ch.blocks[i]).unwrap();
    e.ws()
        .library()
        .open_doc(&ch.doc, OpenDoc::Existing)
        .unwrap()
        .read(move |d| {
            dr_doc::prose::BorrowedProse::new(d, &doc)
                .unwrap()
                .view()
                .paragraphs()
                .find(|p| p.id.as_ref() == Some(&block))
                .is_some_and(|p| p.attrs.checked)
        })
        .unwrap()
}

/// A chapter whose first two paragraphs are checklist items.
fn checklist(e: &Env, b: &str) -> Chapter {
    let ch = chapter(e, b, "买灯芯\n问钟楼的年代\n普通的一段。");
    let s = e.ws().prose_session(&ch.doc).unwrap();
    for pos in [0, 4] {
        s.edit(move |t| {
            t.set_block_attrs(
                pos,
                &dr_model::prose::BlockAttrs {
                    list: Some(dr_model::kind::ListKind::Task),
                    ..Default::default()
                },
            )
        })
        .unwrap();
    }
    ch
}

/// DY fix 8 / step 8: every checklist item is a comment (origin `task`, its
/// id from the line). The tick is the status both ways: a tick resolves, a
/// resolve ticks (undoable), a reopen clears; the text follows the line, and
/// a line that is gone takes its comment with it, resolved or not.
#[test]
fn checklist_items_are_comments_whose_tick_is_their_status_both_ways() {
    let e = env();
    let b = e.book();
    let ch = checklist(&e, &b);
    let o = project_tasks(&e, &ch);
    let mut created: Vec<String> = o["output"]["created"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect();
    created.sort();
    let mut want = vec![task_id(&ch, 0), task_id(&ch, 1)];
    want.sort();
    assert_eq!(created, want);
    let first = task_comment(&e, &ch, 0).unwrap();
    assert_eq!(
        (&first["body"], &first["status"], &first["origin"]),
        (&json!("买灯芯"), &json!("open"), &json!("task"))
    );
    // A tick in the prose resolves the item's comment.
    let s = e.ws().prose_session(&ch.doc).unwrap();
    s.edit(|t| t.set_checked(0, true)).unwrap();
    project_tasks(&e, &ch);
    assert_eq!(task_comment(&e, &ch, 0).unwrap()["status"], "resolved");
    // Resolving a comment ticks its item; the object-level undo takes both back.
    e.call(
        "comment.update",
        json!({"book": b, "id": task_id(&ch, 1), "status": "resolved"}),
    );
    assert!(ticked(&e, &ch, 1));
    assert_eq!(task_comment(&e, &ch, 1).unwrap()["status"], "resolved");
    project_tasks(&e, &ch);
    assert_eq!(task_comment(&e, &ch, 1).unwrap()["status"], "resolved");
    e.ws().undo(&Actor::User).unwrap().unwrap();
    assert!(!ticked(&e, &ch, 1));
    assert_eq!(task_comment(&e, &ch, 1).unwrap()["status"], "open");
    // Reopening clears the tick.
    e.call(
        "comment.update",
        json!({"book": b, "id": task_id(&ch, 0), "status": "open"}),
    );
    assert!(!ticked(&e, &ch, 0));
    project_tasks(&e, &ch);
    assert_eq!(task_comment(&e, &ch, 0).unwrap()["status"], "open");
    // The text follows the line.
    // 「问钟楼的年代」 is characters 4..10, its newline at 10.
    s.edit(|t| t.insert_text(10, "和年月")).unwrap();
    project_tasks(&e, &ch);
    assert_eq!(
        task_comment(&e, &ch, 1).unwrap()["body"],
        "问钟楼的年代和年月"
    );
    // A resolved item whose line is gone: its comment goes too.
    e.call(
        "comment.update",
        json!({"book": b, "id": task_id(&ch, 1), "status": "resolved"}),
    );
    s.edit(|t| t.delete(4..14)).unwrap();
    let o = project_tasks(&e, &ch);
    assert_eq!(o["output"]["removed"], json!([task_id(&ch, 1)]));
    assert!(task_comment(&e, &ch, 1).is_none());
    assert!(task_comment(&e, &ch, 0).is_some());
}

/// Step 8: two devices projecting the same checklist item get one comment;
/// a device that has the resolve but not yet the tick keeps it resolved.
#[test]
fn a_checklist_item_is_one_comment_on_every_device_and_a_late_tick_waits() {
    let a = env();
    let b_dev = env();
    let b = a.book();
    let ch = checklist(&a, &b);
    sync(a.ws(), b_dev.ws());
    project_tasks(&a, &ch);
    project_tasks(&b_dev, &ch);
    sync_doc(a.ws(), b_dev.ws(), &format!("book:{b}"));
    sync_doc(b_dev.ws(), a.ws(), &format!("book:{b}"));
    for dev in [&a, &b_dev] {
        assert_eq!(task_comments(dev, &ch).len(), 2, "one comment per item");
    }
    // A resolves item 0 (ticking it); B gets the book before the prose.
    a.call(
        "comment.update",
        json!({"book": b, "id": task_id(&ch, 0), "status": "resolved"}),
    );
    sync_doc(a.ws(), b_dev.ws(), &format!("book:{b}"));
    let o = project_tasks(&b_dev, &ch);
    assert_eq!(o["output"]["waiting"], json!([task_id(&ch, 0)]));
    assert_eq!(task_comment(&b_dev, &ch, 0).unwrap()["status"], "resolved");
    sync_doc(a.ws(), b_dev.ws(), &ch.doc);
    project_tasks(&b_dev, &ch);
    assert!(ticked(&b_dev, &ch, 0));
    assert_eq!(task_comment(&b_dev, &ch, 0).unwrap()["status"], "resolved");
}

/// The author, 2026-11-15: a checklist item's comment is the line's shadow.
/// Giving it other words or deleting it is refused (the line in the prose is
/// what to change); resolving, reopening and linking an Agent conversation
/// still go through. A marker's comment is edited and deleted as before.
#[test]
fn a_checklist_comment_takes_no_other_words_and_is_not_deleted() {
    let e = env();
    let b = e.book();
    let ch = checklist(&e, &b);
    project_tasks(&e, &ch);
    let id = task_id(&ch, 0);
    let refused = e.try_call(
        "comment.update",
        json!({"book": b, "id": id, "body": "别的字"}),
    );
    assert!(matches!(refused, Err(WsError::Invalid(_))), "{refused:?}");
    let refused = e.try_call("comment.delete", json!({"book": b, "id": id}));
    assert!(matches!(refused, Err(WsError::Invalid(_))), "{refused:?}");
    assert_eq!(task_comment(&e, &ch, 0).unwrap()["body"], "买灯芯");
    // The same words are no change; the conversation and the status go through.
    e.call(
        "comment.update",
        json!({"book": b, "id": id, "body": "买灯芯", "agent_conversation": "conv-1"}),
    );
    e.call(
        "comment.update",
        json!({"book": b, "id": id, "status": "resolved"}),
    );
    assert!(ticked(&e, &ch, 0));
    assert_eq!(task_comment(&e, &ch, 0).unwrap()["status"], "resolved");

    // A TODO marker's comment: its words and its deletion are the author's.
    let s = e.ws().prose_session(&ch.doc).unwrap();
    // 「普通的一段。」 starts at character 11.
    s.edit(|t| t.insert_text(11, "TODO: ")).unwrap();
    project(&e, &ch, &[(2, "普通的一段。")], None);
    let marker = todo_id(&ch, 2);
    e.call(
        "comment.update",
        json!({"book": b, "id": marker, "body": "改过的字"}),
    );
    e.call("comment.delete", json!({"book": b, "id": marker}));
}

/// A guarded writer whose read of the comment is stale is refused before
/// the item is ticked: a refused resolve leaves the prose as it was. With a
/// current read of the comment and of the prose it goes through.
#[test]
fn a_refused_resolve_of_a_checklist_comment_leaves_the_item_unticked() {
    let e = env();
    let b = e.book();
    let ch = checklist(&e, &b);
    project_tasks(&e, &ch);
    let id = task_id(&ch, 0);
    let agent = Actor::agent("dy-guard", 1, "comment.update");
    let book_doc = format!("book:{b}");
    let read = || {
        WritePreconditions::from_observations([e.ws().observe(&ch.doc).unwrap()]).with_records(
            e.ws()
                .observe_records(&book_doc, &[RecordKey::record("comments", id.as_str())])
                .unwrap(),
        )
    };
    let stale = read();
    // The author changes the comment after the Agent read it.
    e.call(
        "comment.update",
        json!({"book": b, "id": id, "agent_conversation": "conv-1"}),
    );
    let refused = e.ws().call_guarded(
        &agent,
        "comment.update",
        json!({"book": b, "id": id, "status": "resolved"}),
        stale,
    );
    assert!(matches!(refused, Err(WsError::Conflict(_))), "{refused:?}");
    assert!(!ticked(&e, &ch, 0), "the refused resolve ticked nothing");
    assert_eq!(task_comment(&e, &ch, 0).unwrap()["status"], "open");
    e.ws()
        .call_guarded(
            &agent,
            "comment.update",
            json!({"book": b, "id": id, "status": "resolved"}),
            read(),
        )
        .unwrap();
    assert!(ticked(&e, &ch, 0));
    assert_eq!(task_comment(&e, &ch, 0).unwrap()["status"], "resolved");
}

/// A step whose target is gone is retired. Resolving a checklist item's
/// comment and then deleting the line (its comment goes with it) leaves a
/// step with nothing to undo: Undo passes over it to the step before,
/// instead of failing on it for ever.
#[test]
fn undo_passes_over_the_resolve_of_a_checklist_item_that_is_gone() {
    let e = env();
    let b = e.book();
    let ch = checklist(&e, &b);
    project_tasks(&e, &ch);
    for i in [0, 1] {
        e.call(
            "comment.update",
            json!({"book": b, "id": task_id(&ch, i), "status": "resolved"}),
        );
    }
    // 「问钟楼的年代」 is characters 4..10, its newline at 10.
    let s = e.ws().prose_session(&ch.doc).unwrap();
    s.edit(|t| t.delete(4..11)).unwrap();
    let o = project_tasks(&e, &ch);
    assert_eq!(o["output"]["removed"], json!([task_id(&ch, 1)]));
    // The newest step resolved item 1, which is gone; the one before it
    // resolved item 0.
    let undone = e.ws().undo(&Actor::User).unwrap();
    assert!(
        undone.is_some(),
        "the step before the retired one is undone"
    );
    assert!(!ticked(&e, &ch, 0));
    assert_eq!(task_comment(&e, &ch, 0).unwrap()["status"], "open");
    assert!(task_comment(&e, &ch, 1).is_none());
    // Redo brings item 0's resolve back; the retired step never returns.
    e.ws().redo(&Actor::User).unwrap().unwrap();
    assert!(ticked(&e, &ch, 0));
    assert!(e.ws().redo(&Actor::User).unwrap().is_none());
}

/// A file purged on another device: this device's step that changed the
/// file (a rename) has nothing to bring back. Undo retires it and goes on
/// to the step before, instead of failing on it for ever.
#[test]
fn undo_passes_over_a_step_on_a_file_another_device_purged() {
    let a = env();
    let b_dev = env();
    let b = a.book();
    let ch = a.out(
        "entry.create",
        json!({"book": b, "parent": common::acceptance::novel_root(a.ws(), &b, "tpl-manuscript"),
               "template": "tpl-chapter", "title": "一"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    a.call(
        "asset.put",
        json!({"book": b, "id": "asset-far", "name": "远.png", "kind": "image",
               "mime": "image/png", "size": 10, "sha256": "e".repeat(64),
               "width": 2, "height": 2}),
    );
    sync(a.ws(), b_dev.ws());
    // On B: an unrelated step, then a rename of the file.
    b_dev.call(
        "entry.update",
        json!({"book": b, "id": ch, "title": "改过的"}),
    );
    b_dev.call(
        "asset.rename",
        json!({"book": b, "id": "asset-far", "name": "近.png"}),
    );
    // On A: the file is purged; B gets the book.
    sync_doc(b_dev.ws(), a.ws(), &format!("book:{b}"));
    a.call("asset.trash", json!({"book": b, "id": "asset-far"}));
    a.call("asset.purge", json!({"book": b, "id": "asset-far"}));
    sync_doc(a.ws(), b_dev.ws(), &format!("book:{b}"));
    assert_eq!(
        b_dev.out("asset.list", json!({"book": b, "trashed": true})),
        json!([])
    );
    let undone = b_dev.ws().undo_in(&Actor::User, &b, None).unwrap();
    assert_eq!(
        undone.map(|u| u.entry.command),
        Some("entry.update".to_owned())
    );
    assert_eq!(
        b_dev.out("entry.get", json!({"book": b, "id": ch}))["title"],
        "一"
    );
    assert_eq!(
        b_dev.out("asset.list", json!({"book": b, "trashed": true})),
        json!([]),
        "the purged file did not come back as an empty one"
    );
}

#[test]
fn a_device_without_the_prose_yet_keeps_the_todo() {
    let a = env();
    let b_dev = env();
    let b = a.book();
    let ch = chapter(&a, &b, "第一段。\n第二段。");
    sync(a.ws(), b_dev.ws());
    // On device A the author turns paragraph 2 into a marker; it projects.
    let s = a.ws().prose_session(&ch.doc).unwrap();
    s.edit(|t| t.insert_text(5, "TODO: ")).unwrap();
    project(&a, &ch, &[(1, "第二段。")], None);
    // Device B gets the book first: its prose has no marker yet. The TODO
    // waits instead of being deleted.
    sync_doc(a.ws(), b_dev.ws(), &format!("book:{b}"));
    let o = project(&b_dev, &ch, &[], None);
    assert_eq!(o["output"]["waiting"], json!([todo_id(&ch, 1)]));
    assert!(effects(&o).is_empty());
    assert_eq!(todos(&b_dev, &ch).len(), 1);
    // Once the prose arrives the marker is there; when it is removed on any
    // device, B deletes the TODO.
    sync_doc(a.ws(), b_dev.ws(), &ch.doc);
    let o = project(&b_dev, &ch, &[(1, "第二段。")], None);
    assert!(effects(&o).is_empty());
    let o = project(&b_dev, &ch, &[], None);
    assert_eq!(o["output"]["removed"], json!([todo_id(&ch, 1)]));
}
