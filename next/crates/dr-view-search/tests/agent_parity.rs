//! The Agent's `entry.search` finds what the search panel shows: the same
//! entries, modules, paragraphs and snippets in the same order, for Chinese
//! queries of one, two, four and eight characters (the index's substring
//! scan and its trigram search) and for titles. Only the panel lists the
//! asset library's file names. Tiny seed, synthetic text.

use dr_view_search::v3::{self, Target};
use dr_workspace::{Actor, Workspace};
use serde_json::{Value, json};

fn fixture() -> (tempfile::TempDir, Workspace, String) {
    let dir = tempfile::tempdir().unwrap();
    let store =
        dr_store::Library::open(dir.path(), dr_workspace::library_options("0.2.0-dev")).unwrap();
    let made = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let id = made.books[0].book_id().to_string();
    made.write_to(&store).unwrap();
    store.close().unwrap();
    let ws = Workspace::open_dir(dir.path(), "0.2.0-dev").unwrap();
    // The panel reads the index as it is; bring it up to date first.
    for doc in ws.library().docs(Some(&id), None).unwrap() {
        ws.library().reindex_doc(&doc.doc_id).unwrap();
    }
    (dir, ws, id)
}

fn call(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input).unwrap()["output"].clone()
}

type Place = (String, Option<String>, Option<u32>, String);

/// The panel's entry rows, in order.
fn panel(ws: &Workspace, book: &str, query: &str) -> Vec<Place> {
    let mut out = Vec::new();
    for group in v3::search(ws, book, query, 500).unwrap() {
        let Target::Entry { id, module } = &group.target else {
            continue;
        };
        for row in &group.rows {
            out.push((
                id.clone(),
                module.clone(),
                row.paragraph,
                row.snippet.clone(),
            ));
        }
    }
    out
}

/// Every page of `entry.search`, up to the panel's 500.
fn agent(ws: &Workspace, book: &str, query: &str) -> Vec<Place> {
    let mut out = Vec::new();
    let mut from = Some(0);
    while let Some(at) = from
        && out.len() < 500
    {
        let page = call(
            ws,
            "entry.search",
            json!({"book": book, "query": query, "from": at, "limit": 50}),
        );
        for hit in page["hits"].as_array().unwrap() {
            out.push((
                hit["entry"].as_str().unwrap().to_owned(),
                hit["module"].as_str().map(str::to_owned),
                hit["paragraph"].as_u64().map(|n| n as u32),
                hit["snippet"].as_str().unwrap().to_owned(),
            ));
        }
        from = page["next"].as_u64();
    }
    out.truncate(500);
    out
}

#[test]
fn the_agent_finds_what_the_search_panel_shows() {
    let (_dir, ws, book) = fixture();
    let entries = call(&ws, "entry.list", json!({"book": book, "all": true}));
    let entries = entries.as_array().unwrap();
    let chapter = entries
        .iter()
        .find(|e| e["template"] == "tpl-chapter")
        .unwrap();
    let source = call(
        &ws,
        "module.read_prose",
        json!({"book": book, "owner": chapter["id"], "module": "mod-prose"}),
    );
    let text: Vec<char> = source["paragraphs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["text"].as_str().unwrap())
        .find(|t| t.chars().count() > 12)
        .unwrap()
        .chars()
        .collect();
    let part = |from: usize, len: usize| -> String { text[from..from + len].iter().collect() };
    let character = entries
        .iter()
        .find(|e| e["template"] == "tpl-character")
        .unwrap();
    let mut queries = vec![
        part(0, 1),
        part(1, 2),
        part(2, 4),
        part(3, 8),
        chapter["title"].as_str().unwrap().to_owned(),
        character["title"].as_str().unwrap().to_owned(),
    ];
    queries.retain(|q| !q.trim().is_empty());
    let mut compared = 0;
    for query in &queries {
        let shown = panel(&ws, &book, query);
        assert_eq!(agent(&ws, &book, query), shown, "{query:?}");
        compared += shown.len();
    }
    assert!(compared > queries.len(), "the queries find something");
}
