//! Undo: object level (each command's declared inverse) and an Agent's
//! changes (by origin, from history).

mod common;

use common::*;
use dr_workspace::Actor;
use serde_json::{Value, json};

fn titles(e: &Env, b: &str) -> Vec<Value> {
    field(
        &e.out("entry.list", json!({"book": b, "parent":common::acceptance::novel_root(e.ws(),&b,"tpl-manuscript"), "trashed": true})),
        "title",
    )
}

#[test]
fn undo_and_redo_walk_the_journal() {
    let e = env();
    let b = e.book();
    let u = Actor::User;
    let c1 = e.out("entry.create", json!({"book": b, "parent": common::acceptance::novel_root(e.ws(), &b, "tpl-manuscript"), "template": "tpl-chapter", "title": "A"}))["id"].clone();
    let c2 = e.out("entry.create", json!({"book": b, "parent": common::acceptance::novel_root(e.ws(), &b, "tpl-manuscript"), "template": "tpl-chapter", "title": "B"}))["id"].clone();
    e.call("entry.update", json!({"book": b, "id": c1, "title": "A2"}));
    e.call(
        "entry.move",
        json!({"book": b, "id": c2, "parent":common::acceptance::novel_root(e.ws(),&b,"tpl-manuscript"), "index":0}),
    );
    let states = [e.out("entry.list", json!({"book": b, "parent":common::acceptance::novel_root(e.ws(),&b,"tpl-manuscript"), "trashed": true}))];
    // Undo the move, the rename, both creates (they go to the trash).
    e.ws().undo(&u).unwrap().unwrap();
    assert_eq!(
        ids(&e.out(
            "entry.list",
            json!({"book": b, "parent":common::acceptance::novel_root(e.ws(),&b,"tpl-manuscript")})
        ))[0],
        c1.as_str().unwrap()
    );
    e.ws().undo(&u).unwrap().unwrap();
    assert_eq!(titles(&e, &b)[0], "A");
    e.ws().undo(&u).unwrap().unwrap();
    e.ws().undo(&u).unwrap().unwrap();
    assert!(
        ids(&e.out(
            "entry.list",
            json!({"book": b, "parent":common::acceptance::novel_root(e.ws(),&b,"tpl-manuscript")})
        ))
        .is_empty()
    );
    // Then the book's creation; then nothing.
    e.ws().undo(&u).unwrap().unwrap();
    assert!(e.ws().undo(&u).unwrap().is_none());
    for _ in 0..5 {
        e.ws().redo(&u).unwrap().unwrap();
    }
    assert!(e.ws().redo(&u).unwrap().is_none());
    assert_eq!(
        e.out("entry.list", json!({"book": b, "parent":common::acceptance::novel_root(e.ws(),&b,"tpl-manuscript"), "trashed": true})),
        states[0]
    );
}

#[test]
fn a_new_command_clears_redo_and_actors_have_their_own_stacks() {
    let e = env();
    let b = e.book();
    let u = Actor::User;
    let agent = Actor::agent("s", 1, "c");
    e.out("entry.create", json!({"book": b, "parent": common::acceptance::novel_root(e.ws(), &b, "tpl-manuscript"), "template": "tpl-chapter", "title": "Mine"}));
    call(
        e.ws(),
        &agent,
        "entry.create",
        json!({"book": b, "parent": common::acceptance::novel_root(e.ws(), &b, "tpl-manuscript"), "template": "tpl-chapter", "title": "Agent's"}),
    );
    // The author's undo skips the Agent's command.
    e.ws().undo(&u).unwrap().unwrap();
    assert_eq!(
        field(&e.out("entry.list", json!({"book": b, "parent":common::acceptance::novel_root(e.ws(),&b,"tpl-manuscript")})), "title"),
        [json!("Agent's")]
    );
    common::acceptance::novel_entry(e.ws(), &b, "tpl-idea", "x", None);
    assert!(
        e.ws().redo(&u).unwrap().is_none(),
        "redo cleared by a new command"
    );
    // The Agent's own stack.
    e.ws().undo(&agent).unwrap().unwrap();
    assert!(
        ids(&e.out(
            "entry.list",
            json!({"book": b, "parent":common::acceptance::novel_root(e.ws(),&b,"tpl-manuscript")})
        ))
        .is_empty()
    );
}

#[test]
fn the_editor_layer_undoes_only_the_authors_typing() {
    let e = env();
    let b = e.book();
    let c = e.out(
        "entry.create", json!({"book": b, "parent": common::acceptance::novel_root(e.ws(), &b, "tpl-manuscript"), "template": "tpl-chapter", "title": "One", "bodies": {"mod-prose": "开头。"}}),
    )["id"]
        .clone();
    let doc = format!("body:{}/mod-prose", c.as_str().unwrap());
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
        "entry.create", json!({"book": b, "parent": common::acceptance::novel_root(e.ws(), &b, "tpl-manuscript"), "template": "tpl-chapter", "title": "One", "bodies": {"mod-prose": "开头。"}}),
    )["id"]
        .clone();
    let doc = format!("body:{}/mod-prose", c.as_str().unwrap());
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
    let c = e.out("entry.create", json!({"book": b, "parent": common::acceptance::novel_root(e.ws(), &b, "tpl-manuscript"), "template": "tpl-chapter", "title": "A"}))["id"].clone();
    e.call("entry.update", json!({"book": b, "id": c, "title": "B"}));
    e.reopen();
    // The rows are in library.sqlite: the same stacks after reopening.
    let rows = e.ws().journal(Some("user"), 10).unwrap();
    assert_eq!(
        rows.iter().map(|r| r.command.as_str()).collect::<Vec<_>>(),
        ["entry.update", "entry.create", "project.create"]
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
    let c = e.out("entry.create", json!({"book": b, "parent": common::acceptance::novel_root(e.ws(), &b, "tpl-manuscript"), "template": "tpl-chapter", "title": "T"}))["id"].clone();
    let keep = dr_workspace::journal::KEEP as usize;
    for i in 0..keep + 70 {
        e.call(
            "entry.update",
            json!({"book": b, "id": c, "title": format!("s{i}")}),
        );
    }
    let rows = e.ws().journal(Some("user"), 2 * keep).unwrap();
    assert!(
        (keep..=keep + 64).contains(&rows.len()),
        "{} rows kept (limit {keep})",
        rows.len()
    );
    assert_eq!(rows[0].command, "entry.update");
    // Other actors are not touched.
    let agent = Actor::agent("s", 1, "c");
    call(
        e.ws(),
        &agent,
        "entry.update",
        json!({"book": b, "id": c, "title": "U"}),
    );
    assert_eq!(e.ws().journal(Some("agent:s"), 10).unwrap().len(), 1);
}
