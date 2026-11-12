//! Author mutations grow the canonical Tiny v3 seed; no second prose corpus.
use dr_doc::v3::BorrowedBookV3;
use dr_model::id::BookId;
use dr_shell::book::Book;
use dr_store::OpenDoc;
use dr_view_elements::data::v3::{
    Drop, creation, drop_target, membership_hosts, prepare, prepare_board, prepare_drop,
    prepare_edit, switch_templates,
};
use dr_workspace::{Actor, Workspace, WsError};
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
fn removing_visible_membership_preserves_position_and_span_under_a_trashed_lane() {
    let (_dir, ws, book) = seed();
    let initial = Book::load(&ws, &book).unwrap();
    let manuscript = root(&initial, "tpl-manuscript");
    let storylines = root(&initial, "tpl-storylines");
    let a = entry(
        &ws,
        &book,
        &storylines,
        "tpl-storyline",
        "Synthetic visible A",
    );
    let b = entry(
        &ws,
        &book,
        &storylines,
        "tpl-storyline",
        "Synthetic hidden B",
    );
    let member = entry(
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
        json!({"book":book,"host":a,"member":member}),
    );
    call(
        &ws,
        "timeline_view.put",
        json!({"book":book,"view":{"id":view,"name":"Synthetic retained timeline","lanes":[{"entry":b}]}}),
    );
    call(
        &ws,
        "timeline_view.place",
        json!({"book":book,"view":view,"entry":member,"lane":b,"at":41.0,"span":7.0}),
    );
    let before = raw_timeline(&ws, &book, view);
    assert_eq!(before["placements"].as_array().unwrap().len(), 1);
    assert_eq!(before["placements"][0]["at"], 41.0);
    assert_eq!(before["placements"][0]["span"], 7.0);

    call(&ws, "entry.trash", json!({"book":book,"id":b}));
    assert_eq!(
        raw_timeline(&ws, &book, view)["placements"],
        before["placements"]
    );
    let hidden = Book::load(&ws, &book).unwrap();
    assert!(
        hidden
            .v3()
            .unwrap()
            .memberships
            .iter()
            .any(|m| m.host == a && m.member == member)
    );
    assert!(
        !hidden
            .v3()
            .unwrap()
            .memberships
            .iter()
            .any(|m| m.host == b && m.member == member)
    );
    let visible = call(&ws, "timeline_view.list", json!({"book":book}));
    assert!(
        visible
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == view)
            .unwrap()["placements"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    // The public-card consumer's exact snapshot and guarded commit, rather than
    // a direct unguarded backend probe. Removing A must not clean hidden B.
    prepare(
        &hidden,
        "membership.remove",
        json!({"host":a,"member":member}),
    )
    .unwrap()
    .commit(&ws)
    .unwrap();
    let after_remove = raw_timeline(&ws, &book, view);
    call(&ws, "entry.restore", json!({"book":book,"id":b}));
    let restored = raw_timeline(&ws, &book, view);
    let memberships = Book::load(&ws, &book).unwrap();
    assert!(
        !memberships
            .v3()
            .unwrap()
            .memberships
            .iter()
            .any(|m| m.host == a && m.member == member)
    );
    assert!(
        memberships
            .v3()
            .unwrap()
            .memberships
            .iter()
            .any(|m| m.host == b && m.member == member)
    );
    let visible = call(&ws, "timeline_view.list", json!({"book":book}));
    let visible = visible
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == view)
        .unwrap();
    ws.shutdown().unwrap();
    assert_eq!(
        after_remove["placements"], before["placements"],
        "an unrelated membership edit must retain raw hidden placement"
    );
    assert_eq!(
        restored["placements"], before["placements"],
        "restoring B must recover the original position and span"
    );
    assert_eq!(
        visible["placements"], before["placements"],
        "restoring B must expose the retained placement"
    );
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
        json!({"book":book,"id":group,"overrides":{"default_template":null}}),
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
    // No level restricts templates any more; a swimlane in a view is only
    // offered templates that keep it a swimlane.
    assert!(switch_templates(&initial, &chapter).contains(&"tpl-idea".into()));
    assert!(!switch_templates(&initial, &lane).contains(&"tpl-group".into()));
    let parent = entry(
        &ws,
        &book,
        &manuscript,
        "tpl-group",
        "Synthetic retained modules",
    );
    let character = root(&initial, "tpl-character");
    call(
        &ws,
        "entry.move",
        json!({"book":book,"id":character,"parent":parent}),
    );
    let before = Book::load(&ws, &book).unwrap();
    // The template does not decide what lives below: an entry with
    // children may take a template whose default switch is off.
    assert!(switch_templates(&before, &parent).contains(&"tpl-chapter".into()));
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
    // Switching the parent's template keeps its switch and its children.
    prepare_edit(&after, &parent, json!({"template":"tpl-chapter"}))
        .unwrap()
        .commit(&ws)
        .unwrap();
    let switched = Book::load(&ws, &book).unwrap();
    let v = switched.v3().unwrap();
    assert_eq!(
        v.entry(&parent).unwrap().template.as_deref(),
        Some("tpl-chapter")
    );
    assert!(v.entry(&parent).unwrap().level);
    assert_eq!(
        v.entry(&character).unwrap().parent.as_deref(),
        Some(parent.as_str())
    );
    ws.shutdown().unwrap();
}
#[test]
fn tree_drop_checks_the_switch_cycles_and_membership_without_moving_the_original() {
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
        "Synthetic switched-off destination",
    );
    call(
        &ws,
        "entry.set_level",
        json!({"book":book,"id":category,"level":false}),
    );
    let snapshot = Book::load(&ws, &book).unwrap();
    assert!(drop_target(&snapshot, &a, &nested, false).is_none());
    // Nothing lives below an entry whose switch is off: a drop onto it
    // places the entry beside it.
    assert_eq!(
        drop_target(&snapshot, &child, &category, false),
        Some(Drop::Residence {
            parent: Some(manuscript.clone()),
            anchor: Some((category.clone(), false)),
        })
    );
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
    assert!(matches!(
        stale.commit(&ws),
        Err(dr_workspace::WsError::Conflict(_))
    ));
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
    assert!(matches!(
        stale.commit(&ws),
        Err(dr_workspace::WsError::Conflict(_))
    ));
    let refreshed = Book::load(&ws, &book).unwrap();
    assert_eq!(
        refreshed.v3().unwrap().entry(&idea).unwrap().layout.board,
        Some((40.0, 80.0))
    );
    // An explicit retry from the new observation succeeds as a second author
    // edit. Both successful writes, including the intervening rename, survive.
    prepare_board(&refreshed, &idea, (50.0, 90.0))
        .unwrap()
        .commit(&ws)
        .unwrap();
    let final_book = Book::load(&ws, &book).unwrap();
    let entry = final_book.v3().unwrap().entry(&idea).unwrap();
    assert_eq!(entry.title, "Synthetic concurrent board rename");
    assert_eq!(entry.layout.board, Some((50.0, 90.0)));
    assert_eq!(entry.layout.grid, Some((2, 3)));
    assert_eq!(entry.layout.relation_graph, Some((7.0, 8.0)));
    ws.shutdown().unwrap();
}

#[test]
fn template_and_layout_edits_preserve_memberships_hidden_by_a_trashed_host() {
    let (_dir, ws, book) = seed();
    let initial = Book::load(&ws, &book).unwrap();
    let manuscript = root(&initial, "tpl-manuscript");
    let character = root(&initial, "tpl-character");
    let residence = entry(&ws, &book, &manuscript, "tpl-group", "Synthetic residence");
    let host = entry(
        &ws,
        &book,
        &manuscript,
        "tpl-group",
        "Synthetic retained host",
    );
    for id in [&residence, &host] {
        call(
            &ws,
            "entry.update",
            json!({"book":book,"id":id,"overrides":{"accept":true}}),
        );
    }
    call(
        &ws,
        "entry.move",
        json!({"book":book,"id":character,"parent":residence}),
    );
    call(
        &ws,
        "membership.add",
        json!({"book":book,"host":host,"member":character}),
    );
    call(
        &ws,
        "membership.primary",
        json!({"book":book,"host":host,"member":character}),
    );
    let before = Book::load(&ws, &book).unwrap();
    let retained_membership = before
        .v3()
        .unwrap()
        .memberships
        .iter()
        .find(|m| m.host == host && m.member == character)
        .unwrap()
        .clone();
    call(&ws, "entry.trash", json!({"book":book,"id":host}));
    let hidden = Book::load(&ws, &book).unwrap();
    assert!(
        !hidden
            .v3()
            .unwrap()
            .memberships
            .iter()
            .any(|m| m.host == host && m.member == character)
    );
    assert!(switch_templates(&hidden, &character).contains(&"tpl-idea".into()));
    prepare_edit(&hidden, &character, json!({"template":"tpl-idea"}))
        .unwrap()
        .commit(&ws)
        .unwrap();
    let switched = Book::load(&ws, &book).unwrap();
    prepare_board(&switched, &character, (24.0, 48.0))
        .unwrap()
        .commit(&ws)
        .unwrap();
    call(&ws, "entry.restore", json!({"book":book,"id":host}));
    let restored = Book::load(&ws, &book).unwrap();
    let v = restored.v3().unwrap();
    assert_eq!(
        serde_json::to_value(
            v.memberships
                .iter()
                .find(|m| m.host == host && m.member == character)
                .unwrap()
        )
        .unwrap(),
        serde_json::to_value(retained_membership).unwrap()
    );
    let entry = v.entry(&character).unwrap();
    assert_eq!(entry.primary.as_deref(), Some(host.as_str()));
    assert_eq!(entry.parent.as_deref(), Some(residence.as_str()));
    assert_eq!(entry.template.as_deref(), Some("tpl-idea"));
    assert_eq!(entry.layout.board, Some((24.0, 48.0)));
    ws.shutdown().unwrap();
}

/// A command built from a snapshot is held to what its dialog showed: the
/// level it names and the levels above it. Anything else in the book may
/// change without refusing it.
#[test]
fn a_creation_is_held_to_the_levels_it_was_chosen_under_and_to_nothing_else() {
    let (_dir, ws, book) = seed();
    let snapshot = Book::load(&ws, &book).unwrap();
    let manuscript = root(&snapshot, "tpl-manuscript");
    let lane = root(&snapshot, "tpl-storyline");
    let context = creation(&snapshot, &lane).unwrap();
    let create = |from: &Book, title: &str| {
        prepare(
            from,
            "entry.create",
            json!({"parent":context.context,"template":context.default,"title":title}),
        )
        .unwrap()
        .commit(&ws)
    };
    let titled = |title: &str| {
        call(
            &ws,
            "entry.list",
            json!({"book":book,"all":true,"query":title}),
        )
        .as_array()
        .unwrap()
        .clone()
    };

    // The book moves on in ways the dialog never showed.
    let other = entry(
        &ws,
        &book,
        &manuscript,
        "tpl-chapter",
        "Synthetic elsewhere",
    );
    call(
        &ws,
        "writing_day.record",
        json!({"book":book,"device":"device-000000000000000000000001","day":"2026-11-12","words":7}),
    );
    call(
        &ws,
        "entry.update",
        json!({"book":book,"id":other,"title":"Synthetic elsewhere renamed"}),
    );
    create(&snapshot, "Synthetic unaffected").unwrap();
    assert_eq!(titled("Synthetic unaffected").len(), 1);

    // The level now sends new entries somewhere else than the dialog said.
    let snapshot = Book::load(&ws, &book).unwrap();
    let home = entry(&ws, &book, &manuscript, "tpl-group", "Synthetic new home");
    call(
        &ws,
        "entry.update",
        json!({"book":book,"id":lane,"overrides":{"home":home}}),
    );
    let refused = create(&snapshot, "Synthetic stale home");
    assert!(matches!(refused, Err(WsError::Conflict(_))), "{refused:?}");
    assert!(titled("Synthetic stale home").is_empty());

    // So does a change to a level above it, where settings are inherited from.
    let snapshot = Book::load(&ws, &book).unwrap();
    let above = snapshot
        .v3()
        .unwrap()
        .entry(&lane)
        .unwrap()
        .parent
        .clone()
        .unwrap();
    call(
        &ws,
        "entry.update",
        json!({"book":book,"id":above,"overrides":{"default_template":"tpl-idea"}}),
    );
    let refused = create(&snapshot, "Synthetic stale ancestor");
    assert!(matches!(refused, Err(WsError::Conflict(_))), "{refused:?}");
    assert!(titled("Synthetic stale ancestor").is_empty());

    // From what is shown now it goes through, to the new home.
    let snapshot = Book::load(&ws, &book).unwrap();
    let created = create(&snapshot, "Synthetic current").unwrap();
    assert_eq!(created["parent"], home.as_str());
    ws.shutdown().unwrap();
}
