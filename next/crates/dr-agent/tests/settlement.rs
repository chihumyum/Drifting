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
    let seed = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
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
    let chapter =
        dr_testkit::seed::acceptance::entries_by_template(&ws, &book, "tpl-chapter")[0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
    let point = dr_testkit::seed::acceptance::entry_point(&ws, &book, &chapter);
    let doc = format!("body:{chapter}/mod-prose");
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
    let receipts = ws
        .library()
        .settlements(Some("m27-settlement"), Some(&doc))
        .unwrap();
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0].call, "replace-1");
    dr_testkit::seed::acceptance::restore_entry(&ws, &book, &chapter, &point);
    assert_eq!(
        out(&ws, &Actor::User, "prose.read", json!({"doc": doc}))["paragraphs"],
        before["paragraphs"]
    );
    ws.shutdown().unwrap();
}

#[test]
fn agent_trash_is_durable_and_entry_history_restores_without_losing_comments() {
    let dir = tempfile::tempdir().unwrap();
    let (ws, book) = seeded(dir.path());
    let chapters = dr_testkit::seed::acceptance::entries_by_template(&ws, &book, "tpl-chapter");
    let comments = out(&ws, &Actor::User, "comment.list", json!({"book":book}));
    let comment = comments
        .as_array()
        .unwrap()
        .iter()
        .find(|c| chapters.iter().any(|e| e["id"] == c["target"]["id"]))
        .unwrap()
        .clone();
    let entry = comment["target"]["id"].clone();
    let point = dr_testkit::seed::acceptance::entry_point(&ws, &book, &entry);
    let actor = Actor::agent("m27-delete", 1, "trash-1");
    out(&ws, &actor, "entry.trash", json!({"book":book,"id":entry}));
    assert!(
        out(
            &ws,
            &Actor::User,
            "entry.get",
            json!({"book":book,"id":entry})
        )["deleted_at"]
            .is_number()
    );
    assert!(
        ws.library()
            .settlements(Some("m27-delete"), None)
            .unwrap()
            .iter()
            .any(|r| r.call == "trash-1")
    );
    ws.shutdown().unwrap();
    let ws = Workspace::open_dir(dir.path(), "m27-test").unwrap();
    dr_testkit::seed::acceptance::restore_entry(&ws, &book, &entry, &point);
    assert_eq!(
        dr_testkit::seed::acceptance::entries_by_template(&ws, &book, "tpl-chapter"),
        chapters
    );
    assert!(
        out(&ws, &Actor::User, "comment.list", json!({"book":book}))
            .as_array()
            .unwrap()
            .contains(&comment)
    );
    ws.shutdown().unwrap();
}
