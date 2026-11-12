//! The shell consumes what the kernel says lies below each level without resolving it again.
use std::collections::BTreeMap;

use dr_shell::book::Book;
use dr_workspace::{Actor, Workspace};
use serde_json::{Value, json};

fn call(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input).unwrap()["output"].clone()
}

fn seed(edit: impl FnOnce(&mut dr_doc::v3::BookDocV3)) -> (tempfile::TempDir, Workspace, String) {
    let dir = tempfile::tempdir().unwrap();
    let store =
        dr_store::Library::open(dir.path(), dr_workspace::library_options("0.2.0-dev")).unwrap();
    let mut made = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    edit(&mut made.books[0].book);
    let id = made.books[0].book_id().to_string();
    made.write_to(&store).unwrap();
    store.close().unwrap();
    let ws = Workspace::open_dir(dir.path(), "0.2.0-dev").unwrap();
    (dir, ws, id)
}

fn checked_load(ws: &Workspace, id: &str) -> Book {
    let before = ws.observe(&format!("book:{id}")).unwrap();
    let book = Book::load(ws, id).unwrap();
    let v3 = book.v3().unwrap();
    let batch = call(ws, "entry.list", json!({"book":id,"all":true,"below":true}));
    assert_eq!(v3.revision, before.version);
    assert_eq!(
        call(ws, "entry_history.version", json!({"book":id}))["version"],
        v3.revision
    );
    let rows: Vec<_> = batch
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row.get("below").is_some())
        .collect();
    assert_eq!(v3.levels.len(), rows.len());
    for row in rows {
        let level = &v3.levels[row["id"].as_str().unwrap()];
        let below = &row["below"];
        assert_eq!(json!(level.settings), below["settings"]);
        assert_eq!(json!(level.sources), below["sources"]);
        assert_eq!(level.sources.len(), 8);
        for (actual, field) in [(&level.children, "children"), (&level.members, "members")] {
            let expected: Vec<_> = below[field]
                .as_array()
                .unwrap()
                .iter()
                .map(|entry| entry["id"].as_str().unwrap())
                .collect();
            assert_eq!(*actual, expected);
        }
    }
    assert_eq!(
        before.version,
        ws.observe(&format!("book:{id}")).unwrap().version
    );
    book
}

fn root(book: &Book, template: &str) -> String {
    book.v3()
        .unwrap()
        .entries
        .iter()
        .find(|entry| entry.template.as_deref() == Some(template))
        .unwrap()
        .id
        .clone()
}

#[test]
fn level_values_and_all_sources_refresh_together_and_survive_reopen() {
    let (dir, ws, id) = seed(|_| {});
    let initial = checked_load(&ws, &id);
    let manuscript = root(&initial, "tpl-manuscript");
    let group = call(
        &ws,
        "entry.create",
        json!({"book":id,"parent":manuscript,"template":"tpl-group","title":"Synthetic inherited level"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let inherited = checked_load(&ws, &id);
    assert_eq!(
        json!(inherited.v3().unwrap().levels[&group].sources["display"]),
        json!({"kind":"template","entry":manuscript,"template":"tpl-manuscript"})
    );
    call(
        &ws,
        "entry.update",
        json!({"book":id,"id":manuscript,"overrides":{
            "default_template":"tpl-chapter","display":"board",
            "auto_link":true,"accept":true,"home":manuscript,
            "is_manuscript":true,"format_shortcuts":"plain"
        }}),
    );
    let changed = checked_load(&ws, &id);
    let level = &changed.v3().unwrap().levels[&group];
    assert_eq!(
        json!(level.settings),
        json!({
            "default_template":"tpl-chapter","display":"board",
            "auto_link":true,"accept":true,"home":manuscript,
            "is_manuscript":true,"format_shortcuts":"plain","lane":false
        })
    );
    for (key, source) in &level.sources {
        if key == "lane" {
            // `lane` never passes down from an ancestor.
            assert_eq!(json!(source), json!({"kind":"default"}));
        } else {
            assert_eq!(json!(source), json!({"kind":"override","entry":manuscript}));
        }
    }
    assert_ne!(
        initial.v3().unwrap().revision,
        changed.v3().unwrap().revision
    );
    assert_eq!(
        inherited.v3().unwrap().levels[&group].settings.display,
        "list"
    );

    call(
        &ws,
        "entry.update",
        json!({"book":id,"id":group,"overrides":{"default_template":null,"home":null,"display":"grid"}}),
    );
    let cleared = checked_load(&ws, &id);
    let level = &cleared.v3().unwrap().levels[&group];
    assert_eq!(level.settings.default_template, None);
    assert_eq!(level.settings.home, None);
    for key in ["default_template", "home", "display"] {
        assert_eq!(
            json!(level.sources[key]),
            json!({"kind":"override","entry":group})
        );
    }
    assert_eq!(
        json!(level.sources["accept"]),
        json!({"kind":"override","entry":manuscript})
    );
    // Omitting those nullable keys restores inheritance, rather than clearing it.
    call(
        &ws,
        "entry.update",
        json!({"book":id,"id":group,"overrides":{}}),
    );
    let restored = checked_load(&ws, &id);
    assert_eq!(
        json!(restored.v3().unwrap().levels[&group]),
        json!(changed.v3().unwrap().levels[&group])
    );
    let expected = json!(restored.v3().unwrap());
    ws.shutdown().unwrap();
    let reopened = Workspace::open_dir(dir.path(), "0.2.0-dev").unwrap();
    assert_eq!(json!(checked_load(&reopened, &id).v3().unwrap()), expected);
    reopened.shutdown().unwrap();
}

#[test]
fn structure_loads_are_read_only_and_other_books_remain_unchanged() {
    let (_dir, ws, id) = seed(|_| {});
    let other = call(
        &ws,
        "project.create",
        json!({"name":"Synthetic isolated book"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let a = checked_load(&ws, &id);
    let b = checked_load(&ws, &other);
    let expected_other = json!(b.v3().unwrap());
    let manuscript = root(&a, "tpl-manuscript");
    call(
        &ws,
        "entry.update",
        json!({"book":id,"id":manuscript,"overrides":{"display":"grid"}}),
    );
    let changed = checked_load(&ws, &id);
    assert_ne!(a.v3().unwrap().revision, changed.v3().unwrap().revision);
    assert_eq!(
        json!(checked_load(&ws, &other).v3().unwrap()),
        expected_other
    );
    assert!(
        !changed
            .v3()
            .unwrap()
            .levels
            .contains_key(&root(&b, "tpl-manuscript"))
    );

    let observations = || -> BTreeMap<_, _> {
        ws.library()
            .docs(None, None)
            .unwrap()
            .into_iter()
            .map(|doc| {
                let observation = ws.observe(&doc.doc_id).unwrap();
                (doc.doc_id, (observation.version, observation.value))
            })
            .collect()
    };
    let before = observations();
    let journal = json!(ws.journal(None, 1000).unwrap());
    for book in [&id, &other, &id] {
        checked_load(&ws, book);
    }
    assert_eq!(
        observations(),
        before,
        "reads neither write nor advance any document frontier"
    );
    assert_eq!(json!(ws.journal(None, 1000).unwrap()), journal);
    ws.shutdown().unwrap();
}

#[test]
fn kernel_tolerance_order_trash_and_lane_memberships_reach_the_shell_unchanged() {
    let (_dir, ws, id) = seed(|book| {
        // Model a merged leaf-parent edge through the typed fixture writer.
        // Runtime edits below still use the public workspace commands.
        let leaf = book
            .view()
            .entries()
            .into_iter()
            .find(|e| {
                e.template
                    .as_ref()
                    .is_some_and(|t| t.as_str() == "tpl-chapter")
            })
            .unwrap()
            .id;
        book.edit(dr_model::Origin::Import, |txn| {
            txn.entries().create(
                &"synthetic-lifted-level".parse().unwrap(),
                Some(&leaf),
                "Synthetic lifted level",
                Some(&"tpl-group".parse().unwrap()),
                true,
            )?;
            Ok::<_, dr_doc::DocError>(())
        })
        .0
        .unwrap();
    });
    let initial = checked_load(&ws, &id);
    let lifted = initial
        .v3()
        .unwrap()
        .entry("synthetic-lifted-level")
        .unwrap();
    let parent = initial
        .v3()
        .unwrap()
        .entry(lifted.parent.as_deref().unwrap())
        .unwrap();
    assert_eq!(parent.template.as_deref(), Some("tpl-chapter"));
    let home = parent.parent.as_deref().unwrap();
    assert!(
        initial.v3().unwrap().levels[home]
            .children
            .contains(&lifted.id)
    );
    assert!(!initial.v3().unwrap().levels.contains_key(&parent.id));

    let lane = root(&initial, "tpl-storyline");
    call(
        &ws,
        "entry.update",
        json!({"book":id,"id":lane,"overrides":{"accept":false}}),
    );
    let leaf = parent.id.clone();
    call(
        &ws,
        "membership.add",
        json!({"book":id,"host":lane,"member":leaf}),
    );
    let with_member = checked_load(&ws, &id);
    let level = &with_member.v3().unwrap().levels[&lane];
    assert!(level.settings.accept);
    assert_eq!(
        json!(level.sources["accept"]),
        json!({"kind":"lane","entry":lane})
    );
    assert!(level.members.contains(&leaf));
    assert!(!level.children.contains(&leaf));
    assert_eq!(
        with_member
            .v3()
            .unwrap()
            .entry(&leaf)
            .unwrap()
            .parent
            .as_deref(),
        Some(home)
    );

    call(
        &ws,
        "entry.move",
        json!({"book":id,"id":lifted.id,"parent":home,"index":0}),
    );
    let reordered = checked_load(&ws, &id);
    assert_eq!(reordered.v3().unwrap().levels[home].children[0], lifted.id);
    call(&ws, "entry.trash", json!({"book":id,"id":lifted.id}));
    let trashed = checked_load(&ws, &id);
    assert!(trashed.v3().unwrap().entry(&lifted.id).is_none());
    assert!(!trashed.v3().unwrap().levels.contains_key(&lifted.id));
    call(&ws, "entry.restore", json!({"book":id,"id":lifted.id}));
    assert!(
        checked_load(&ws, &id)
            .v3()
            .unwrap()
            .levels
            .contains_key(&lifted.id)
    );
    ws.shutdown().unwrap();
}

#[test]
fn snapshots_published_during_writes_match_their_entire_historical_revision() {
    let (_dir, ws, id) = seed(|_| {});
    let initial = checked_load(&ws, &id);
    let manuscript = root(&initial, "tpl-manuscript");
    let mut published = vec![initial];
    std::thread::scope(|scope| {
        let writer = scope.spawn(|| {
            for n in 0..12 {
                let display = if n % 2 == 0 { "grid" } else { "board" };
                call(
                    &ws,
                    "book.update",
                    json!({"book":id,"name":format!("Synthetic revision {n}")}),
                );
                call(
                    &ws,
                    "entry.update",
                    json!({
                        "book":id,"id":manuscript,"title":format!("Synthetic {display} {n}"),
                        "overrides":{"display":display,"accept":n % 2 == 0}
                    }),
                );
            }
        });
        for _ in 0..16 {
            match Book::load(&ws, &id) {
                Ok(book) => published.push(book),
                // A busy batch may exhaust its three retries; publishing a
                // mixture to make progress is never an acceptable alternative.
                Err(dr_workspace::WsError::Conflict(_)) => {}
                Err(error) => panic!("unexpected snapshot error: {error}"),
            }
        }
        writer.join().unwrap();
    });
    published.push(checked_load(&ws, &id));
    assert_ne!(
        published[0].v3().unwrap().revision,
        published.last().unwrap().v3().unwrap().revision
    );
    for book in published {
        let shell = book.v3().unwrap();
        let frontier = dr_workspace::naming::frontiers_from_hex(&shell.revision).unwrap();
        let historical = ws
            .library()
            .load_copy_at(&format!("book:{id}"), &frontier)
            .unwrap();
        let book_id = id.parse().unwrap();
        let borrowed = dr_doc::v3::BorrowedBookV3::new(&historical, &book_id).unwrap();
        let view = borrowed.view();
        let structure = view.structure_snapshot();
        assert_eq!(book.name, view.meta().name);
        assert_eq!(
            json!(shell.entries),
            json!(
                structure
                    .entries()
                    .filter(|e| !e.is_trashed())
                    .collect::<Vec<_>>()
            )
        );
        assert_eq!(json!(shell.templates), json!(view.templates()));
        assert_eq!(
            shell.roots,
            structure
                .children_of(None)
                .iter()
                .map(|e| e.id.to_string())
                .collect::<Vec<_>>()
        );
        assert_eq!(shell.levels.len(), structure.levels().count());
        for entry in structure.levels() {
            let row = &shell.levels[entry.id.as_str()];
            let resolved = structure.level_settings(&entry.id).unwrap();
            assert_eq!(json!(row.settings), json!(resolved.settings));
            assert_eq!(json!(row.sources), json!(resolved.sources));
            assert_eq!(
                row.children,
                structure
                    .children_of(Some(&entry.id))
                    .iter()
                    .map(|e| e.id.to_string())
                    .collect::<Vec<_>>()
            );
            assert_eq!(
                row.members,
                structure
                    .members_of(&entry.id)
                    .iter()
                    .map(|e| e.id.to_string())
                    .collect::<Vec<_>>()
            );
        }
        assert_eq!(json!(shell.memberships), json!(structure.memberships()));
        assert_eq!(json!(shell.timeline_views), json!(view.timeline_views()));
        assert_eq!(
            json!(shell.materials),
            json!(
                view.materials()
                    .iter()
                    .map(dr_workspace::dto::MaterialInfo::from)
                    .collect::<Vec<_>>()
            )
        );
        assert_eq!(
            json!(shell.material_folders),
            json!(
                view.material_folders()
                    .iter()
                    .map(|folder| json!({
                        "id":folder.id,"name":folder.name,"color":null,"parent":folder.parent
                    }))
                    .collect::<Vec<_>>()
            )
        );
    }
    ws.shutdown().unwrap();
}
