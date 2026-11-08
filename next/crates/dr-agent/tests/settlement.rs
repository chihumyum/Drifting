//! M27's F3/F2 boundary: the runtime's actor survives writes, restart and undo.

use dr_store::Library;
use dr_testkit::seed::{self, Preset};
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use serde_json::{Value, json};

fn out(ws: &Workspace, actor: &Actor, name: &str, input: Value) -> Value {
    ws.call(actor, name, input).unwrap()["output"].clone()
}

fn seeded(root: &std::path::Path) -> (Workspace, String) {
    let lib = Library::open(root, library_options("m27-test")).unwrap();
    let seed = seed::generate(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
    seed.write_to(&lib).unwrap();
    let book = seed.books[0].book_id().to_string();
    let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
    ws.set_auto_links(false);
    (ws, book)
}

#[test]
fn registered_agent_write_is_durable_and_undoable_by_source() {
    let dir = tempfile::tempdir().unwrap();
    let (ws, book) = seeded(dir.path());
    let chapter = out(&ws, &Actor::User, "chapter.list", json!({"book": book}))[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let doc = format!("node:{chapter}");
    let before = out(&ws, &Actor::User, "prose.read", json!({"doc": doc}));
    let paragraph = &before["paragraphs"][1];
    let text = paragraph["text"].as_str().unwrap();
    // Transform the shared seed, rather than introducing another manuscript corpus.
    let changed: String = text.chars().rev().collect();
    assert_ne!(text, changed);
    let actor = Actor::agent("m27-settlement", 7, "replace-1");
    out(
        &ws,
        &actor,
        "prose.replace",
        json!({"doc": doc, "find": text, "replace": changed, "block_id": paragraph["block_id"]}),
    );
    let receipts = ws
        .library()
        .settlements(Some("m27-settlement"), Some(&doc))
        .unwrap();
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0].turn, "7");
    assert_eq!(receipts[0].call, "replace-1");
    assert_ne!(receipts[0].before, receipts[0].after);
    ws.shutdown().unwrap();

    let ws = Workspace::open_dir(dir.path(), "m27-test").unwrap();
    assert_eq!(
        out(&ws, &Actor::User, "prose.read", json!({"doc": doc}))["paragraphs"][1]["text"],
        changed
    );
    let changes = out(
        &ws,
        &Actor::User,
        "history.agent_changes",
        json!({"session": "m27-settlement", "turn": 7}),
    );
    assert_eq!(changes.as_array().unwrap().len(), 1);
    assert_eq!(changes[0]["call"], "replace-1");
    let undone = out(
        &ws,
        &Actor::User,
        "history.undo_agent",
        json!({"session": "m27-settlement", "turn": 7}),
    );
    assert_eq!(undone["reverted_prose"], json!([doc]));
    assert!(undone["conflicts"].as_array().unwrap().is_empty());
    assert_eq!(
        out(&ws, &Actor::User, "prose.read", json!({"doc": doc}))["paragraphs"],
        before["paragraphs"]
    );
    ws.shutdown().unwrap();
}

#[test]
fn agent_deletion_needs_no_approval_and_history_restores_cascaded_comments() {
    let dir = tempfile::tempdir().unwrap();
    let (ws, book) = seeded(dir.path());
    let chapters = out(&ws, &Actor::User, "chapter.list", json!({"book": book}));
    let comments = out(&ws, &Actor::User, "comment.list", json!({"book": book}));
    let comment = comments
        .as_array()
        .unwrap()
        .iter()
        .find(|c| {
            chapters
                .as_array()
                .unwrap()
                .iter()
                .any(|ch| ch["id"] == c["target"]["id"])
        })
        .expect("tiny seed has chapter comments");
    let chapter = comment["target"]["id"].clone();
    let comment_id = comment["id"].clone();
    let original_comment = comment.clone();
    let actor = Actor::agent("m27-delete", 1, "purge-1");
    out(
        &ws,
        &actor,
        "chapter.purge",
        json!({"book": book, "id": chapter}),
    );
    let remaining = out(
        &ws,
        &Actor::User,
        "chapter.list",
        json!({"book": book, "trashed": true}),
    );
    assert!(
        remaining
            .as_array()
            .unwrap()
            .iter()
            .all(|c| c["id"] != chapter)
    );
    let floating = out(&ws, &Actor::User, "comment.list", json!({"book": book}));
    let floating_comment = floating
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == comment_id)
        .unwrap();
    assert!(floating_comment["target"].is_null());
    assert_eq!(floating_comment["body"], original_comment["body"]);
    assert!(
        ws.library()
            .settlements(Some("m27-delete"), None)
            .unwrap()
            .iter()
            .any(|r| r.call == "purge-1")
    );
    ws.shutdown().unwrap();
    let ws = Workspace::open_dir(dir.path(), "m27-test").unwrap();
    out(
        &ws,
        &Actor::User,
        "history.undo_agent",
        json!({"session": "m27-delete"}),
    );
    assert_eq!(
        out(&ws, &Actor::User, "chapter.list", json!({"book": book})),
        chapters
    );
    assert!(
        out(&ws, &Actor::User, "comment.list", json!({"book": book}))
            .as_array()
            .unwrap()
            .contains(&original_comment)
    );
    ws.shutdown().unwrap();
}
