//! Permanent integration regression: removing an unrelated visible membership
//! must not erase a timeline placement hidden by a trashed lane.
//! Uses only the canonical Tiny v3 seed and synthetic entity names.

use dr_doc::v3::BorrowedBookV3;
use dr_model::id::BookId;
use dr_store::OpenDoc;
use dr_testkit::seed::{self, Preset};
use dr_workspace::{Actor, Workspace, WritePreconditions};
use serde_json::{Value, json};

fn call(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input).unwrap()["output"].clone()
}

fn root(entries: &Value, template: &str) -> String {
    entries
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["template"] == template)
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn create(ws: &Workspace, book: &str, parent: &str, template: &str, title: &str) -> String {
    call(
        ws,
        "entry.create",
        json!({"book":book,"parent":parent,"template":template,"title":title}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn raw_timeline(ws: &Workspace, book: &str, view: &str) -> Value {
    let id: BookId = book.parse().unwrap();
    let view = view.to_owned();
    ws.library()
        .open_doc(&format!("book:{book}"), OpenDoc::Existing)
        .unwrap()
        .read(move |doc| {
            let book = BorrowedBookV3::new(doc, &id).unwrap();
            let raw = book
                .view()
                .timeline_views_raw()
                .into_iter()
                .find(|timeline| timeline.id.as_str() == view)
                .unwrap();
            serde_json::to_value(raw).unwrap()
        })
        .unwrap()
}

#[test]
fn guarded_membership_remove_keeps_placement_hidden_by_an_unrelated_trashed_lane() {
    let dir = tempfile::tempdir().unwrap();
    let store =
        dr_store::Library::open(dir.path(), dr_workspace::library_options("0.2.0-dev")).unwrap();
    let made = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
    let book = made.books[0].book_id().to_string();
    made.write_to(&store).unwrap();
    store.close().unwrap();
    let ws = Workspace::open_dir(dir.path(), "0.2.0-dev").unwrap();

    let entries = call(&ws, "entry.list", json!({"book":book,"all":true}));
    let manuscript = root(&entries, "tpl-manuscript");
    let storylines = root(&entries, "tpl-storylines");
    let a = create(
        &ws,
        &book,
        &storylines,
        "tpl-storyline",
        "Synthetic visible A",
    );
    let b = create(
        &ws,
        &book,
        &storylines,
        "tpl-storyline",
        "Synthetic hidden B",
    );
    let entry = create(
        &ws,
        &book,
        &manuscript,
        "tpl-chapter",
        "Synthetic retained position",
    );
    let view = "synthetic-hidden-membership";
    call(
        &ws,
        "membership.add",
        json!({"book":book,"host":a,"member":entry}),
    );
    call(
        &ws,
        "timeline_view.put",
        json!({"book":book,"view":{"id":view,"name":"Synthetic retained timeline","lanes":[{"entry":b}]}}),
    );
    call(
        &ws,
        "timeline_view.place",
        json!({"book":book,"view":view,"entry":entry,"lane":b,"at":41.0,"span":7.0}),
    );
    let before = raw_timeline(&ws, &book, view);
    assert_eq!(before["placements"].as_array().unwrap().len(), 1);
    assert_eq!(before["placements"][0]["at"], 41.0);
    assert_eq!(before["placements"][0]["span"], 7.0);

    call(&ws, "entry.trash", json!({"book":book,"id":b}));
    let hidden = raw_timeline(&ws, &book, view);
    assert_eq!(
        hidden["placements"], before["placements"],
        "trash retains raw placement"
    );
    let visible = call(&ws, "timeline_view.list", json!({"book":book}));
    let hidden_view = visible
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == view)
        .unwrap();
    assert!(hidden_view["placements"].as_array().unwrap().is_empty());
    let memberships = call(&ws, "membership.list", json!({"book":book}));
    assert!(
        memberships
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["host"] == a && m["member"] == entry)
    );
    assert!(
        !memberships
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["host"] == b && m["member"] == entry)
    );

    // Match G2's Mutation::commit: exact observed book frontier and
    // require_all=false, then the real membership.remove command.
    let observed = ws.observe(&format!("book:{book}")).unwrap();
    let guard = WritePreconditions {
        versions: [(observed.doc, observed.version)].into(),
        records: Vec::new(),
        require_all: false,
    };
    let removed = ws
        .call_guarded(
            &Actor::User,
            "membership.remove",
            json!({"book":book,"host":a,"member":entry}),
            guard,
        )
        .unwrap();
    let after_remove = raw_timeline(&ws, &book, view);
    call(&ws, "entry.restore", json!({"book":book,"id":b}));
    let restored = raw_timeline(&ws, &book, view);
    let memberships = call(&ws, "membership.list", json!({"book":book}));
    assert!(
        memberships
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["host"] == b && m["member"] == entry)
    );
    eprintln!(
        "guarded remove={removed}; before={}; hidden={}; after_remove={}; restored={}",
        before["placements"],
        hidden["placements"],
        after_remove["placements"],
        restored["placements"]
    );
    ws.shutdown().unwrap();
    assert_eq!(
        restored["placements"], before["placements"],
        "removing visible A must not delete a placement retained under unrelated hidden B"
    );
}
