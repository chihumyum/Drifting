//! Undo: object level (each command's declared inverse) and an Agent's
//! changes (by origin, from history).

mod common;

use common::*;
use dr_workspace::Actor;
use serde_json::{Value, json};

fn titles(e: &Env, b: &str) -> Vec<Value> {
    field(
        &e.out("chapter.list", json!({"book": b, "trashed": true})),
        "title",
    )
}

#[test]
fn undo_and_redo_walk_the_journal() {
    let e = env();
    let b = e.book();
    let u = Actor::User;
    let c1 = e.out("chapter.create", json!({"book": b, "title": "A"}))["id"].clone();
    let c2 = e.out("chapter.create", json!({"book": b, "title": "B"}))["id"].clone();
    e.call(
        "chapter.update",
        json!({"book": b, "id": c1, "title": "A2", "summary": "s"}),
    );
    e.call(
        "chapter.move",
        json!({"book": b, "id": c2, "place": "first"}),
    );
    let states = [e.out("chapter.list", json!({"book": b, "trashed": true}))];
    // Undo the move, the rename, both creates (they go to the trash).
    e.ws().undo(&u).unwrap().unwrap();
    assert_eq!(
        ids(&e.out("chapter.list", json!({"book": b})))[0],
        c1.as_str().unwrap()
    );
    e.ws().undo(&u).unwrap().unwrap();
    assert_eq!(titles(&e, &b)[0], "A");
    e.ws().undo(&u).unwrap().unwrap();
    e.ws().undo(&u).unwrap().unwrap();
    assert!(ids(&e.out("chapter.list", json!({"book": b}))).is_empty());
    // Then the book's creation; then nothing.
    e.ws().undo(&u).unwrap().unwrap();
    assert!(e.ws().undo(&u).unwrap().is_none());
    for _ in 0..5 {
        e.ws().redo(&u).unwrap().unwrap();
    }
    assert!(e.ws().redo(&u).unwrap().is_none());
    assert_eq!(
        e.out("chapter.list", json!({"book": b, "trashed": true})),
        states[0]
    );
}

#[test]
fn a_new_command_clears_redo_and_actors_have_their_own_stacks() {
    let e = env();
    let b = e.book();
    let u = Actor::User;
    let agent = Actor::agent("s", 1, "c");
    e.out("chapter.create", json!({"book": b, "title": "Mine"}));
    call(
        e.ws(),
        &agent,
        "chapter.create",
        json!({"book": b, "title": "Agent's"}),
    );
    // The author's undo skips the Agent's command.
    e.ws().undo(&u).unwrap().unwrap();
    assert_eq!(
        field(&e.out("chapter.list", json!({"book": b})), "title"),
        [json!("Agent's")]
    );
    e.out("idea.create", json!({"book": b, "title": "x"}));
    assert!(
        e.ws().redo(&u).unwrap().is_none(),
        "redo cleared by a new command"
    );
    // The Agent's own stack.
    e.ws().undo(&agent).unwrap().unwrap();
    assert!(ids(&e.out("chapter.list", json!({"book": b}))).is_empty());
}

#[test]
fn undo_agent_restores_fields_nobody_changed_since() {
    let e = env();
    let b = e.book();
    let c = e.out(
        "chapter.create",
        json!({"book": b, "title": "Original", "text": "原文。"}),
    )["id"]
        .clone();
    let keep = e.out("element.create", json!({"book": b, "name": "Keep"}))["id"].clone();
    let agent = Actor::agent("sess", 7, "call");
    // The Agent's turn: rename + summary, a new element, trash one, a prose edit.
    call(
        e.ws(),
        &agent,
        "chapter.update",
        json!({"book": b, "id": c, "title": "By Agent", "summary": "agent summary"}),
    );
    let made = call(
        e.ws(),
        &agent,
        "element.create",
        json!({"book": b, "name": "Agent Made"}),
    )["output"]["id"]
        .clone();
    call(
        e.ws(),
        &agent,
        "element.trash",
        json!({"book": b, "id": keep}),
    );
    let doc = format!("node:{}", c.as_str().unwrap());
    call(
        e.ws(),
        &agent,
        "prose.replace",
        json!({"doc": doc, "find": "原文", "replace": "代笔"}),
    );
    // Then the author changes the summary the Agent wrote.
    e.call(
        "chapter.update",
        json!({"book": b, "id": c, "summary": "author summary"}),
    );
    let changes = e.out("history.agent_changes", json!({"session": "sess"}));
    assert_eq!(changes.as_array().unwrap().len(), 4);
    let o = e.call("history.undo_agent", json!({"session": "sess", "turn": 7}));
    let out = &o["output"];
    let ch = &e.out("chapter.list", json!({"book": b}))[0];
    assert_eq!(ch["title"], "Original", "the Agent's rename is undone");
    assert_eq!(
        ch["summary"], "author summary",
        "the author's later edit stays"
    );
    assert!(
        out["conflicts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["field"] == "summary")
    );
    let els = e.out("element.list", json!({"book": b}));
    assert_eq!(
        ids(&els),
        [keep.as_str().unwrap()],
        "made goes to the trash, kept comes back"
    );
    assert!(
        out["trashed"]
            .as_array()
            .unwrap()
            .iter()
            .any(|k| k["id"] == made)
    );
    assert_eq!(
        e.out("prose.read", json!({"doc": doc}))["paragraphs"][0]["text"],
        "原文。"
    );
    assert_eq!(out["reverted_prose"], json!([doc]));
    // Undoing the undo puts the Agent's changes back.
    e.ws().undo(&Actor::User).unwrap().unwrap();
    assert_eq!(
        e.out("chapter.list", json!({"book": b}))[0]["title"],
        "By Agent"
    );
    assert_eq!(
        e.out("prose.read", json!({"doc": doc}))["paragraphs"][0]["text"],
        "代笔。"
    );
}

#[test]
fn undo_agent_brings_back_what_it_deleted_for_good() {
    let e = env();
    let b = e.book();
    let c = e.out("chapter.create", json!({"book": b, "title": "One"}))["id"].clone();
    let el = e.out("element.create", json!({"book": b, "name": "A"}))["id"].clone();
    let t = e.out(
        "relation_type.create",
        json!({"book": b, "name": "r", "orientation": "symmetric",
        "source_kinds": ["element", "node"], "target_kinds": ["element", "node"]}),
    )["id"]
        .clone();
    e.call("relation.create", json!({"book": b, "from": {"kind": "element", "id": el}, "to": {"kind": "node", "id": c}, "relation_type": t}));
    e.call(
        "comment.create",
        json!({"book": b, "target": {"kind": "node", "id": c}, "body": "note"}),
    );
    let agent = Actor::agent("s2", 1, "call");
    call(e.ws(), &agent, "chapter.purge", json!({"book": b, "id": c}));
    assert!(ids(&e.out("chapter.list", json!({"book": b, "trashed": true}))).is_empty());
    e.call("history.undo_agent", json!({"session": "s2"}));
    assert_eq!(
        ids(&e.out("chapter.list", json!({"book": b}))),
        [c.as_str().unwrap()]
    );
    assert_eq!(
        e.out("relation.list", json!({"book": b}))
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        e.out("comment.list", json!({"book": b}))[0]["target"]["id"],
        c
    );
}

#[test]
fn undo_agent_leaves_prose_someone_else_edited() {
    let e = env();
    let b = e.book();
    let c = e.out(
        "chapter.create",
        json!({"book": b, "title": "One", "text": "甲乙丙。"}),
    )["id"]
        .clone();
    let doc = format!("node:{}", c.as_str().unwrap());
    let agent = Actor::agent("s3", 1, "call");
    call(
        e.ws(),
        &agent,
        "prose.replace",
        json!({"doc": doc, "find": "乙", "replace": "二"}),
    );
    e.call(
        "prose.replace",
        json!({"doc": doc, "find": "丙", "replace": "三"}),
    );
    let o = e.out("history.undo_agent", json!({"session": "s3"}));
    assert_eq!(o["reverted_prose"], json!([]));
    assert_eq!(o["conflicts"][0]["what"], json!(doc));
    assert_eq!(
        e.out("prose.read", json!({"doc": doc}))["paragraphs"][0]["text"],
        "甲二三。"
    );
}

#[test]
fn restore_entities_is_its_own_inverse() {
    let e = env();
    let b = e.book();
    let el = e.out(
        "element.create",
        json!({"book": b, "name": "A", "summary": "one"}),
    )["id"]
        .clone();
    e.call("element.purge", json!({"book": b, "id": el}));
    let undo = e.ws().undo(&Actor::User).unwrap().unwrap();
    assert_eq!(
        undo.undo.as_ref().unwrap()[0].command,
        "history.restore_entities"
    );
    assert_eq!(
        e.out("element.list", json!({"book": b}))[0]["summary"],
        "one"
    );
    e.ws().redo(&Actor::User).unwrap().unwrap();
    assert!(
        e.out("element.list", json!({"book": b, "trashed": true}))
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn the_editor_layer_undoes_only_the_authors_typing() {
    let e = env();
    let b = e.book();
    let c = e.out(
        "chapter.create",
        json!({"book": b, "title": "One", "text": "开头。"}),
    )["id"]
        .clone();
    let doc = format!("node:{}", c.as_str().unwrap());
    let s = e.ws().prose_session(&doc).unwrap();
    s.edit(|t| t.insert_text(0, "作者")).unwrap();
    // An Agent writes in between: the author's undo leaves it alone.
    call(
        e.ws(),
        &Actor::agent("s", 1, "c"),
        "prose.replace",
        json!({"doc": doc, "find": "开头", "replace": "起首"}),
    );
    let text = |e: &Env| e.out("prose.read", json!({"doc": doc}))["paragraphs"][0]["text"].clone();
    assert_eq!(text(&e), "作者起首。");
    assert!(s.can_undo());
    assert!(s.undo().unwrap());
    assert_eq!(
        text(&e),
        "起首。",
        "the author's insertion undone, the Agent's edit kept"
    );
    assert!(s.redo().unwrap());
    assert_eq!(text(&e), "作者起首。");
    // Durable like any editor step.
    drop(s);
    let mut e = e;
    e.reopen();
    assert_eq!(
        e.out("prose.read", json!({"doc": doc}))["paragraphs"][0]["text"],
        "作者起首。"
    );
}

/// The author's commands on an open document (the command palette, the
/// Agent panel acting for the author, an object-level undo) are not steps of
/// the editor: its Undo takes back only its own typing, the journal undoes
/// the command, and either order leaves the other's change alone.
#[test]
fn the_editors_undo_leaves_the_authors_commands_to_the_journal() {
    let e = env();
    let b = e.book();
    let c = e.out(
        "chapter.create",
        json!({"book": b, "title": "One", "text": "开头。"}),
    )["id"]
        .clone();
    let doc = format!("node:{}", c.as_str().unwrap());
    let s = e.ws().prose_session(&doc).unwrap();
    let text = |e: &Env| e.out("prose.read", json!({"doc": doc}))["paragraphs"][0]["text"].clone();
    s.edit(|t| t.insert_text(0, "作者")).unwrap();
    // The author, from the command palette, on the open chapter.
    e.call(
        "prose.replace",
        json!({"doc": doc, "find": "开头", "replace": "起首"}),
    );
    assert_eq!(text(&e), "作者起首。");
    // Stored as the author's command (dr-store's `Origin::Command`), which
    // counts as the author's write everywhere.
    let rows = e.ws().library().updates_since(&doc, 0).unwrap();
    assert_eq!(rows.last().unwrap().origin, "user:command");
    assert!(dr_store::Origin::parse(&rows.last().unwrap().origin).is_some_and(|o| o.is_author()));
    // The editor's one step is the typing; the command is not on its stack.
    assert!(s.undo().unwrap());
    assert_eq!(text(&e), "起首。");
    assert!(!s.can_undo(), "the command is not an editor step");
    assert!(!s.undo().unwrap());
    assert_eq!(text(&e), "起首。");
    // The journal undoes the command, and that is no editor step either.
    assert!(e.ws().undo(&Actor::User).unwrap().is_some());
    assert_eq!(text(&e), "开头。");
    assert!(!s.can_undo());
    // The editor's redo still brings its typing back, after both.
    assert!(s.redo().unwrap());
    assert_eq!(text(&e), "作者开头。");
    // The other order: typing, a command, the journal's undo first.
    e.call(
        "prose.replace",
        json!({"doc": doc, "find": "开头", "replace": "起首"}),
    );
    s.edit(|t| t.insert_text(0, "又")).unwrap();
    assert!(e.ws().undo(&Actor::User).unwrap().is_some());
    assert_eq!(text(&e), "又作者开头。");
    assert!(s.undo().unwrap());
    assert_eq!(text(&e), "作者开头。", "the editor undid its own step");
}

#[test]
fn the_journal_survives_a_restart() {
    let mut e = env();
    let b = e.book();
    let c = e.out("chapter.create", json!({"book": b, "title": "A"}))["id"].clone();
    e.call("chapter.update", json!({"book": b, "id": c, "title": "B"}));
    e.reopen();
    // The rows are in library.sqlite: the same stacks after reopening.
    let rows = e.ws().journal(Some("user"), 10).unwrap();
    assert_eq!(
        rows.iter().map(|r| r.command.as_str()).collect::<Vec<_>>(),
        ["chapter.update", "chapter.create", "book.create"]
    );
    e.ws().undo(&Actor::User).unwrap().unwrap();
    assert_eq!(titles(&e, &b)[0], "A");
    e.reopen();
    e.ws().redo(&Actor::User).unwrap().unwrap();
    assert_eq!(titles(&e, &b)[0], "B");
    let states: Vec<String> = e
        .ws()
        .journal(Some("user"), 10)
        .unwrap()
        .into_iter()
        .map(|r| r.state)
        .collect();
    assert_eq!(states, ["live", "live", "live"]);
}

#[test]
fn an_actor_keeps_its_newest_rows() {
    let e = env();
    let b = e.book();
    let c = e.out("chapter.create", json!({"book": b, "title": "T"}))["id"].clone();
    let keep = dr_workspace::journal::KEEP as usize;
    for i in 0..keep + 70 {
        e.call(
            "chapter.update",
            json!({"book": b, "id": c, "summary": format!("s{i}")}),
        );
    }
    let rows = e.ws().journal(Some("user"), 2 * keep).unwrap();
    assert!(
        (keep..=keep + 64).contains(&rows.len()),
        "{} rows kept (limit {keep})",
        rows.len()
    );
    assert_eq!(rows[0].command, "chapter.update");
    // Other actors are not touched.
    let agent = Actor::agent("s", 1, "c");
    call(
        e.ws(),
        &agent,
        "chapter.update",
        json!({"book": b, "id": c, "title": "U"}),
    );
    assert_eq!(e.ws().journal(Some("agent:s"), 10).unwrap().len(), 1);
}
