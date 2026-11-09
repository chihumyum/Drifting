//! Author mutations grow the canonical Tiny v3 seed; no second prose corpus.
use dr_shell::book::Book;
use dr_view_elements::data::v3::{
    creation, drop_target, membership_hosts, prepare, prepare_board, prepare_drop, prepare_edit,
    switch_templates,
};
use dr_workspace::{Actor, Workspace};
use serde_json::{Value, json};
fn seed() -> (tempfile::TempDir, Workspace, String) {
    let dir = tempfile::tempdir().unwrap();
    let store =
        dr_store::Library::open(dir.path(), dr_workspace::library_options("0.2.0-dev")).unwrap();
    let seed = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let id = seed.books[0].book_id().to_string();
    seed.write_to(&store).unwrap();
    store.close().unwrap();
    let ws = Workspace::open_dir(dir.path(), "0.2.0-dev").unwrap();
    (dir, ws, id)
}
fn call(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input).unwrap()["output"].clone()
}
fn entry(ws: &Workspace, book: &str, parent: &str, template: &str, title: &str) -> String {
    call(
        ws,
        "entry.create",
        json!({"book":book,"parent":parent,"template":template,"title":title}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned()
}
fn root(book: &Book, template: &str) -> String {
    book.v3()
        .unwrap()
        .entries
        .iter()
        .find(|e| e.template.as_deref() == Some(template))
        .unwrap()
        .id
        .clone()
}
#[test]
fn creation_uses_home_and_atomic_membership_without_inventing_a_default() {
    let (_dir, ws, book) = seed();
    let snapshot = Book::load(&ws, &book).unwrap();
    let manuscript = root(&snapshot, "tpl-manuscript");
    let lane = root(&snapshot, "tpl-storyline");
    let context = creation(&snapshot, &lane).unwrap();
    assert_eq!(context.context.as_deref(), Some(lane.as_str()));
    assert_eq!(context.home.as_deref(), Some(manuscript.as_str()));
    assert_eq!(context.default.as_deref(), Some("tpl-chapter"));
    assert!(!context.blank);
    let created=prepare(&snapshot,"entry.create",json!({"parent":context.context,"template":context.default,"title":"Synthetic lane creation"})).unwrap().commit(&ws).unwrap();
    assert_eq!(created["parent"], manuscript);
    assert_eq!(created["template"], "tpl-chapter");
    assert_eq!(created["primary"], lane);
    let again = Book::load(&ws, &book).unwrap();
    assert!(
        again
            .v3()
            .unwrap()
            .memberships
            .iter()
            .any(|m| m.host == lane && m.member == created["id"].as_str().unwrap())
    );
    let group = entry(&ws, &book, &manuscript, "tpl-group", "Synthetic no default");
    call(
        &ws,
        "entry.update",
        json!({"book":book,"id":group,"overrides":{"default_template":null,"allow":[]}}),
    );
    let snapshot = Book::load(&ws, &book).unwrap();
    let context = creation(&snapshot, &group).unwrap();
    assert_eq!(context.default, None);
    assert!(context.blank);
    let blank = prepare(
        &snapshot,
        "entry.create",
        json!({"parent":context.context,"template":null,"title":"Synthetic blank entry"}),
    )
    .unwrap()
    .commit(&ws)
    .unwrap();
    assert!(blank["template"].is_null());
    ws.shutdown().unwrap();
}
#[test]
fn template_choices_preserve_active_relationships_children_and_retained_content() {
    let (_dir, ws, book) = seed();
    let initial = Book::load(&ws, &book).unwrap();
    let manuscript = root(&initial, "tpl-manuscript");
    let lane = root(&initial, "tpl-storyline");
    let chapter = root(&initial, "tpl-chapter");
    assert!(!switch_templates(&initial, &chapter).contains(&"tpl-idea".into()));
    assert!(!switch_templates(&initial, &lane).contains(&"tpl-group".into()));
    let parent = entry(
        &ws,
        &book,
        &manuscript,
        "tpl-group",
        "Synthetic retained modules",
    );
    call(
        &ws,
        "entry.update",
        json!({"book":book,"id":parent,"overrides":{"allow":[]}}),
    );
    let character = root(&initial, "tpl-character");
    call(
        &ws,
        "entry.move",
        json!({"book":book,"id":character,"parent":parent}),
    );
    let before = Book::load(&ws, &book).unwrap();
    assert!(!switch_templates(&before, &parent).contains(&"tpl-chapter".into()));
    assert!(switch_templates(&before, &character).contains(&"tpl-idea".into()));
    let prose = call(
        &ws,
        "module.read_prose",
        json!({"book":book,"owner":character,"module":"mod-prose"}),
    );
    let fields = before
        .v3()
        .unwrap()
        .entry(&character)
        .unwrap()
        .fields
        .clone();
    let kv = before.v3().unwrap().entry(&character).unwrap().kv.clone();
    prepare_edit(&before, &character, json!({"template":"tpl-idea"}))
        .unwrap()
        .commit(&ws)
        .unwrap();
    let after = Book::load(&ws, &book).unwrap();
    let changed = after.v3().unwrap().entry(&character).unwrap();
    for (module, values) in fields {
        for (field, value) in values {
            assert_eq!(changed.fields[&module][&field], value);
        }
    }
    for (module, rows) in kv {
        assert_eq!(changed.kv[&module], rows);
    }
    assert_eq!(
        call(
            &ws,
            "module.read_prose",
            json!({"book":book,"owner":character,"module":"mod-prose"})
        ),
        prose
    );
    ws.shutdown().unwrap();
}
#[test]
fn tree_drop_checks_allowance_cycles_and_membership_without_moving_the_original() {
    let (_dir, ws, book) = seed();
    let initial = Book::load(&ws, &book).unwrap();
    let manuscript = root(&initial, "tpl-manuscript");
    let lane = root(&initial, "tpl-storyline");
    let a = entry(&ws, &book, &manuscript, "tpl-group", "Synthetic A");
    let b = entry(&ws, &book, &manuscript, "tpl-group", "Synthetic B");
    let child = entry(&ws, &book, &a, "tpl-chapter", "Synthetic moved leaf");
    let nested = entry(&ws, &book, &a, "tpl-group", "Synthetic nested");
    let category = entry(
        &ws,
        &book,
        &manuscript,
        "tpl-group",
        "Synthetic restricted destination",
    );
    call(
        &ws,
        "entry.update",
        json!({"book":book,"id":category,"overrides":{"allow":["tpl-character"]}}),
    );
    let snapshot = Book::load(&ws, &book).unwrap();
    assert!(drop_target(&snapshot, &a, &nested, false).is_none());
    assert!(drop_target(&snapshot, &child, &category, false).is_none());
    prepare_drop(&snapshot, &child, &b, false)
        .unwrap()
        .commit(&ws)
        .unwrap();
    let moved = Book::load(&ws, &book).unwrap();
    assert_eq!(
        moved.v3().unwrap().entry(&child).unwrap().parent.as_deref(),
        Some(b.as_str())
    );
    assert!(membership_hosts(&moved, &child).contains(&lane));
    prepare_drop(&moved, &child, &lane, false)
        .unwrap()
        .commit(&ws)
        .unwrap();
    let assigned = Book::load(&ws, &book).unwrap();
    assert_eq!(
        assigned
            .v3()
            .unwrap()
            .entry(&child)
            .unwrap()
            .parent
            .as_deref(),
        Some(b.as_str())
    );
    assert!(
        assigned
            .v3()
            .unwrap()
            .memberships
            .iter()
            .any(|m| m.member == child && m.host == lane)
    );
    let stale = prepare_drop(&assigned, &child, &a, false).unwrap();
    call(
        &ws,
        "entry.update",
        json!({"book":book,"id":child,"title":"Synthetic concurrent rename"}),
    );
    assert!(stale.commit(&ws).is_err());
    assert_eq!(
        Book::load(&ws, &book)
            .unwrap()
            .v3()
            .unwrap()
            .entry(&child)
            .unwrap()
            .parent
            .as_deref(),
        Some(b.as_str())
    );
    ws.shutdown().unwrap();
}
#[test]
fn sibling_drop_counts_raw_trash_slots_and_not_the_filtered_rows() {
    let (_dir, ws, book) = seed();
    let initial = Book::load(&ws, &book).unwrap();
    let manuscript = root(&initial, "tpl-manuscript");
    let parent = entry(&ws, &book, &manuscript, "tpl-group", "Synthetic ordering");
    let a = entry(&ws, &book, &parent, "tpl-chapter", "Synthetic first");
    let trash = entry(
        &ws,
        &book,
        &parent,
        "tpl-chapter",
        "Synthetic trashed sibling",
    );
    let b = entry(&ws, &book, &parent, "tpl-chapter", "Synthetic second");
    let c = entry(&ws, &book, &parent, "tpl-chapter", "Synthetic last");
    call(&ws, "entry.trash", json!({"book":book,"id":trash}));
    let snapshot = Book::load(&ws, &book).unwrap();
    prepare_drop(&snapshot, &c, &b, false)
        .unwrap()
        .commit(&ws)
        .unwrap();
    let all = call(
        &ws,
        "entry.list",
        json!({"book":book,"parent":parent,"trashed":true}),
    );
    let ids: Vec<_> = all
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        ids,
        vec![a.as_str(), trash.as_str(), c.as_str(), b.as_str()]
    );
    let snapshot = Book::load(&ws, &book).unwrap();
    prepare_drop(&snapshot, &a, &b, true)
        .unwrap()
        .commit(&ws)
        .unwrap();
    let all = call(
        &ws,
        "entry.list",
        json!({"book":book,"parent":parent,"trashed":true}),
    );
    let ids: Vec<_> = all
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        ids,
        vec![trash.as_str(), c.as_str(), b.as_str(), a.as_str()]
    );
    ws.shutdown().unwrap();
}
#[test]
fn board_position_writes_keep_other_layouts_and_refuse_a_stale_snapshot() {
    let (_dir, ws, book) = seed();
    let snapshot = Book::load(&ws, &book).unwrap();
    let idea = root(&snapshot, "tpl-idea");
    call(
        &ws,
        "entry.update",
        json!({"book":book,"id":idea,"layout":{"board":[-12.0,34.0],"grid":[2,3],"relation_graph":[7.0,8.0]}}),
    );
    let snapshot = Book::load(&ws, &book).unwrap();
    let parent = snapshot.v3().unwrap().entry(&idea).unwrap().parent.clone();
    prepare_board(&snapshot, &idea, (40.0, 80.0))
        .unwrap()
        .commit(&ws)
        .unwrap();
    let changed = Book::load(&ws, &book).unwrap();
    let entry = changed.v3().unwrap().entry(&idea).unwrap();
    assert_eq!(entry.layout.board, Some((40.0, 80.0)));
    assert_eq!(entry.layout.grid, Some((2, 3)));
    assert_eq!(entry.layout.relation_graph, Some((7.0, 8.0)));
    assert_eq!(entry.parent, parent);
    let stale = prepare_board(&changed, &idea, (50.0, 90.0)).unwrap();
    call(
        &ws,
        "entry.update",
        json!({"book":book,"id":idea,"title":"Synthetic concurrent board rename"}),
    );
    assert!(stale.commit(&ws).is_err());
    assert_eq!(
        Book::load(&ws, &book)
            .unwrap()
            .v3()
            .unwrap()
            .entry(&idea)
            .unwrap()
            .layout
            .board,
        Some((40.0, 80.0))
    );
    ws.shutdown().unwrap();
}
