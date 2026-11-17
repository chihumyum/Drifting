//! The Agent's read-before-write over relations it cannot fully see (RD
//! review, 2026-11-17): rows hidden because a side is in Recently Deleted
//! are named by `relation_type.list`, so a pair that lands in one and a
//! delete that takes one out can be made; two same-named relations a merge
//! read as one are found by that name.

use dr_agent_tools::{AgentTools, CallRequest};
use dr_model::id::BookId;
use dr_testkit::seed::{self, Preset};
use dr_workspace::{Actor, Workspace};
use serde_json::{Value, json};

struct Fixture {
    ws: Workspace,
    book: BookId,
    chapters: Vec<Value>,
    elements: Vec<Value>,
    _dir: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::open_dir(dir.path(), "rd-hidden-rows-test").unwrap();
        let seeded = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        seeded.write_to(ws.library()).unwrap();
        let book = seeded.books[0].book_id().clone();
        let chapters = seed::acceptance::entries_by_template(&ws, &book, "tpl-chapter");
        let elements = seed::acceptance::entries_by_template(&ws, &book, "tpl-character");
        assert!(chapters.len() >= 2 && elements.len() >= 2);
        Self {
            ws,
            book,
            chapters,
            elements,
            _dir: dir,
        }
    }

    fn author(&self, name: &str, mut arguments: Value) -> Value {
        arguments["book"] = json!(self.book);
        self.ws.call(&Actor::User, name, arguments).unwrap()["output"].clone()
    }

    fn agent(
        &self,
        tools: &AgentTools,
        actor: &Actor,
        name: &str,
        arguments: Value,
    ) -> dr_agent_tools::Result<Value> {
        tools.invoke(
            &self.ws,
            &self.book,
            actor,
            CallRequest {
                name: name.into(),
                arguments,
                revision: None,
                edited_text: None,
            },
        )
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.ws.close();
    }
}

fn named<'a>(list: &'a Value, name: &str) -> Option<&'a Value> {
    list["output"]
        .as_array()
        .unwrap()
        .iter()
        .find(|relation| relation["name"] == name)
}

/// The review's scenario: row {A}×{B in Recently Deleted}; the Agent relates
/// A to C (landing in that row) and deletes the relation; and deletes a
/// relation whose only row is hidden.
#[test]
fn the_agent_can_land_in_and_delete_rows_it_cannot_see() {
    let f = Fixture::new();
    let (a, b, c) = (
        &f.chapters[0]["id"],
        &f.elements[0]["id"],
        &f.elements[1]["id"],
    );
    let allies = f.author("relation_type.create", json!({"name":"Allies"}))["id"].clone();
    let rivals = f.author("relation_type.create", json!({"name":"Rivals"}))["id"].clone();
    let row = f.author(
        "relation_row.create_pair",
        json!({"relation_type":allies,"left":a,"right":b}),
    )["id"]
        .clone();
    let rival_row = f.author(
        "relation_row.create_pair",
        json!({"relation_type":rivals,"left":f.chapters[1]["id"],"right":b}),
    )["id"]
        .clone();
    f.author("entry.trash", json!({"id":b}));

    let tools = AgentTools::new();
    let actor = Actor::agent("rd-hidden", 1, "relations");
    let listed = f
        .agent(&tools, &actor, "relation_type.list", json!({}))
        .unwrap();
    let shown = named(&listed, "Allies").unwrap();
    assert_eq!(shown["rows"], json!([]));
    assert_eq!(shown["hidden_rows"], json!([row]));
    assert_eq!(
        named(&listed, "Rivals").unwrap()["hidden_rows"],
        json!([rival_row])
    );
    f.agent(&tools, &actor, "entry.list", json!({"all":true}))
        .unwrap();
    let placed = f
        .agent(
            &tools,
            &actor,
            "relation_row.create_pair",
            json!({"relation_type":"Allies","left":a,"right":c}),
        )
        .unwrap();
    assert_eq!(
        placed["output"]["id"], row,
        "the pair lands in the hidden row"
    );

    f.agent(&tools, &actor, "relation_type.list", json!({}))
        .unwrap();
    f.agent(
        &tools,
        &actor,
        "relation_type.delete",
        json!({"id":"Rivals"}),
    )
    .unwrap();
    f.agent(&tools, &actor, "relation_type.list", json!({}))
        .unwrap();
    f.agent(
        &tools,
        &actor,
        "relation_type.delete",
        json!({"id":"Allies"}),
    )
    .unwrap();
    let after = f.author("relation_type.list", json!({}));
    assert!(
        after
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["id"] != allies && r["id"] != rivals)
    );
    // The trashed entry's rows went with their relations: restoring it
    // brings back only the seed's own relations.
    f.author("entry.restore", json!({"id":b}));
    let restored = f.author("relation_type.list", json!({"entry":b}));
    assert!(
        restored
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["id"] != allies && r["id"] != rivals)
    );
}

/// Two devices each create 「盟友」: after the merge the Agent's lookup by
/// that name finds the one relation shown, not an ambiguity.
#[test]
fn the_agent_finds_one_relation_by_a_name_two_devices_gave_two() {
    let one = Fixture::new();
    let dir = tempfile::tempdir().unwrap();
    let two = Workspace::open_dir(dir.path(), "rd-hidden-rows-two").unwrap();
    sync_docs(&one.ws, &two);
    let first = one.author("relation_type.create", json!({"name":"盟友"}))["id"].clone();
    two.call(
        &Actor::User,
        "relation_type.create",
        json!({"book":one.book,"name":" 盟友 ","direction":"symmetric"}),
    )
    .unwrap();
    sync_docs(&two, &one.ws);
    two.close();

    let tools = AgentTools::new();
    let actor = Actor::agent("rd-merged-name", 1, "relations");
    let listed = one
        .agent(&tools, &actor, "relation_type.list", json!({}))
        .unwrap();
    let shown: Vec<_> = listed["output"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["name"].as_str().is_some_and(|n| n.trim() == "盟友"))
        .collect();
    assert_eq!(shown.len(), 1);
    assert_eq!(shown[0]["id"], first, "the earliest is shown");
    one.agent(&tools, &actor, "entry.list", json!({"all":true}))
        .unwrap();
    let placed = one
        .agent(
            &tools,
            &actor,
            "relation_row.create_pair",
            json!({"relation_type":"盟友","left":one.chapters[0]["id"],"right":one.elements[0]["id"]}),
        )
        .unwrap();
    assert_eq!(placed["output"]["relation_type"], first);
}

/// Every stored document of `from`, the book first, imported into `to` as
/// another device's sync would.
fn sync_docs(from: &Workspace, to: &Workspace) {
    let mut docs = from.library().docs(None, None).unwrap();
    docs.sort_by_key(|d| (d.kind != "book", d.doc_id.clone()));
    for d in docs {
        if from.library().head(&d.doc_id).unwrap().is_none() {
            continue;
        }
        let bytes = from
            .library()
            .load_copy(&d.doc_id)
            .unwrap()
            .export(loro::ExportMode::all_updates())
            .unwrap();
        to.import_remote(
            &d.doc_id,
            Some((&d.kind, d.book_id.as_deref().unwrap_or(""))),
            bytes,
            &Actor::Sync,
        )
        .unwrap();
    }
}
