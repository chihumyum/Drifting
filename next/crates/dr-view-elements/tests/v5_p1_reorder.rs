//! Kernel v5 Track P1 (`p1-reorder`): same-folder drag-to-reorder, device-local
//! display sort, manuscript sequence alignment, and single-step undo.

use std::{
    collections::BTreeSet,
    rc::Rc,
    time::{Duration, Instant},
};

use dr_shell::{
    Services, SettingsFile, ShellInfo, Workspace as ShellWorkspace,
    book::Book,
    nav::{Open, Target},
    pages::PageViewHost,
    v3::{DisplaySurface, LevelHost},
};
use dr_view_elements::{
    data::v3::{
        Drop, DropSlot, SortOrder, drop_slot_at, natural_title_cmp, prepare_resolved_drop,
        resolve_drop, sort_memory_key, updated_timestamps,
    },
    panel::v3::{Display, LevelDisplay, Row, rows_sorted},
};
use dr_workspace::{Actor, Workspace, WsError};
use gpui::{
    App, AppContext as _, Bounds, Entity, EntityInputHandler as _, Focusable as _, Point,
    TestAppContext, VisualTestContext, WeakEntity, px, size,
};
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

fn create_entry(
    ws: &Workspace,
    book: &str,
    parent: &str,
    template: &str,
    title: &str,
    level: Option<bool>,
) -> String {
    let mut input = json!({
        "book": book,
        "parent": parent,
        "template": template,
        "title": title,
    });
    if let Some(level) = level {
        input["level"] = json!(level);
    }
    call(ws, "entry.create", input)["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn root_by_template(book: &Book, template: &str) -> String {
    book.v3()
        .unwrap()
        .entries
        .iter()
        .find(|e| e.template.as_deref() == Some(template))
        .unwrap()
        .id
        .clone()
}

fn resident_ids(rows: &[Row]) -> Vec<String> {
    rows.iter()
        .flat_map(|row| match row {
            Row::Entry { id, .. } => vec![id.clone()],
            Row::Tiles { ids, .. } => ids.clone(),
            _ => Vec::new(),
        })
        .collect()
}

fn manuscript_entries(v: &dr_shell::book::v3::BookV3) -> Vec<String> {
    v.manuscript.iter().map(|m| m.entry.clone()).collect()
}

fn drag_reorder(ws: &Workspace, book_id: &str, entry: &str, onto: &str, slot: DropSlot) -> bool {
    let snapshot = Book::load(ws, book_id).unwrap();
    let target = resolve_drop(&snapshot, entry, onto, slot, true, false)
        .expect("same-folder manual drop should resolve");
    prepare_resolved_drop(&snapshot, entry, target)
        .unwrap()
        .commit_if_changed(ws)
        .unwrap()
        .is_some()
}

#[test]
fn same_folder_reorder_persists_across_reopen_and_single_step_undo_restores_manuscript_order() {
    let (dir, ws, book) = seed();
    let initial = Book::load(&ws, &book).unwrap();
    let manuscript = root_by_template(&initial, "tpl-manuscript");

    let folder_a = create_entry(
        &ws,
        &book,
        &manuscript,
        "tpl-group",
        "Synthetic Part A",
        Some(true),
    );
    let sub_1 = create_entry(
        &ws,
        &book,
        &folder_a,
        "tpl-chapter",
        "Synthetic Sub 1",
        None,
    );
    let sub_2 = create_entry(
        &ws,
        &book,
        &folder_a,
        "tpl-chapter",
        "Synthetic Sub 2",
        None,
    );
    let leaf_tail = create_entry(
        &ws,
        &book,
        &manuscript,
        "tpl-chapter",
        "Synthetic Tail Chapter",
        None,
    );

    let before = Book::load(&ws, &book).unwrap();
    let before_v = before.v3().unwrap();
    assert_eq!(
        before_v.levels[&folder_a].children,
        vec![sub_1.clone(), sub_2.clone()]
    );
    let seed_first = before_v.levels[&manuscript].children[0].clone();

    // Dropping an item Before the neighbor immediately after it is a no-op: it
    // must not bump the book revision or push an empty undo entry.
    let rev_before_noop = before_v.revision.clone();
    assert!(!drag_reorder(&ws, &book, &sub_1, &sub_2, DropSlot::Before));
    let after_noop = Book::load(&ws, &book).unwrap();
    assert_eq!(after_noop.v3().unwrap().revision, rev_before_noop);

    // Reorder inside the sub-folder: place sub_2 Before sub_1.
    assert!(drag_reorder(&ws, &book, &sub_2, &sub_1, DropSlot::Before));
    let sub_reordered = Book::load(&ws, &book).unwrap();
    assert_eq!(
        sub_reordered.v3().unwrap().levels[&folder_a].children,
        vec![sub_2.clone(), sub_1.clone()]
    );

    // Move the entire sub-folder Before the very first chapter of the manuscript.
    let prior_root_children = sub_reordered.v3().unwrap().levels[&manuscript]
        .children
        .clone();
    let prior_manuscript = manuscript_entries(sub_reordered.v3().unwrap());
    assert!(drag_reorder(
        &ws,
        &book,
        &folder_a,
        &seed_first,
        DropSlot::Before
    ));

    let moved_folder = Book::load(&ws, &book).unwrap();
    let mv = moved_folder.v3().unwrap();
    assert_eq!(mv.levels[&manuscript].children[0], folder_a);
    let mv_entries = manuscript_entries(mv);
    assert_eq!(&mv_entries[..2], &[sub_2.clone(), sub_1.clone()]);
    assert_eq!(mv_entries.last(), Some(&leaf_tail));

    // Reorder a leaf chapter After folder_a in the manuscript root.
    let before_leaf_move_children = mv.levels[&manuscript].children.clone();
    let before_leaf_move_manuscript = mv_entries;
    assert!(drag_reorder(
        &ws,
        &book,
        &leaf_tail,
        &folder_a,
        DropSlot::After
    ));

    let final_snap = Book::load(&ws, &book).unwrap();
    let fv = final_snap.v3().unwrap();
    assert_eq!(
        &fv.levels[&manuscript].children[..2],
        &[folder_a.clone(), leaf_tail.clone()]
    );
    let fv_entries = manuscript_entries(fv);
    assert_eq!(
        &fv_entries[..3],
        &[sub_2.clone(), sub_1.clone(), leaf_tail.clone()]
    );
    let expected_root_children = fv.levels[&manuscript].children.clone();
    let expected_sub_children = fv.levels[&folder_a].children.clone();
    let expected_manuscript = fv_entries;

    // Persist to disk, shut down, reopen, and verify both folder order and
    // manuscript sequence survived untouched.
    ws.shutdown().unwrap();
    let ws = Workspace::open_dir(dir.path(), "0.2.0-dev").unwrap();
    let reopened = Book::load(&ws, &book).unwrap();
    let rv = reopened.v3().unwrap();
    assert_eq!(rv.levels[&manuscript].children, expected_root_children);
    assert_eq!(rv.levels[&folder_a].children, expected_sub_children);
    assert_eq!(manuscript_entries(rv), expected_manuscript);

    // Single-step undo restores the exact prior order and manuscript sequence.
    assert!(ws.undo(&Actor::User).unwrap().is_some());
    let after_undo_1 = Book::load(&ws, &book).unwrap();
    assert_eq!(
        after_undo_1.v3().unwrap().levels[&manuscript].children,
        before_leaf_move_children
    );
    assert_eq!(
        manuscript_entries(after_undo_1.v3().unwrap()),
        before_leaf_move_manuscript
    );

    // Undo one more step restores the folder move as well.
    assert!(ws.undo(&Actor::User).unwrap().is_some());
    let after_undo_2 = Book::load(&ws, &book).unwrap();
    assert_eq!(
        after_undo_2.v3().unwrap().levels[&manuscript].children,
        prior_root_children
    );
    assert_eq!(
        manuscript_entries(after_undo_2.v3().unwrap()),
        prior_manuscript
    );

    // Redo reapplies both steps in order.
    assert!(ws.redo(&Actor::User).unwrap().is_some());
    assert!(ws.redo(&Actor::User).unwrap().is_some());
    let after_redo = Book::load(&ws, &book).unwrap();
    assert_eq!(
        after_redo.v3().unwrap().levels[&manuscript].children,
        expected_root_children
    );
    assert_eq!(
        manuscript_entries(after_redo.v3().unwrap()),
        expected_manuscript
    );
    ws.shutdown().unwrap();
}

#[gpui::test]
fn time_and_name_sort_are_device_local_keep_manual_order_intact_and_refuse_reorder(
    cx: &mut TestAppContext,
) {
    cx.executor().allow_parking();
    let mut names = vec!["人物 10", "人物 2", "地点", "物件与往事", "人物 1", "Alice"];
    names.sort_by(|a, b| natural_title_cmp(a, b));
    assert_eq!(
        names,
        ["地点", "人物 1", "人物 2", "人物 10", "物件与往事", "Alice"]
    );

    let (dir, ws, book) = seed();
    let initial = Book::load(&ws, &book).unwrap();
    let manuscript = root_by_template(&initial, "tpl-manuscript");
    let lane = root_by_template(&initial, "tpl-storyline");

    let folder = create_entry(
        &ws,
        &book,
        &manuscript,
        "tpl-group",
        "Synthetic Sort Folder",
        Some(true),
    );
    let other_folder = create_entry(
        &ws,
        &book,
        &manuscript,
        "tpl-group",
        "Synthetic Destination Folder",
        Some(true),
    );

    let c1 = create_entry(&ws, &book, &folder, "tpl-chapter", "第10章 远行", None);
    std::thread::sleep(Duration::from_millis(5));
    let c2 = create_entry(&ws, &book, &folder, "tpl-chapter", "第2章 启程", None);
    std::thread::sleep(Duration::from_millis(5));
    let c3 = create_entry(&ws, &book, &folder, "tpl-chapter", "第1章 序幕", None);

    // Manually arrange c2, c1, c3.
    assert!(drag_reorder(&ws, &book, &c2, &c1, DropSlot::Before));
    let manual_snap = Book::load(&ws, &book).unwrap();
    let manual_order = vec![c2.clone(), c1.clone(), c3.clone()];
    assert_eq!(
        manual_snap.v3().unwrap().levels[&folder].children,
        manual_order
    );

    // Edit c1's prose so its modified timestamp becomes the newest, then
    // reorder c2/c1 back-and-forth or verify entry.move never bumps Updated.
    std::thread::sleep(Duration::from_millis(5));
    call(
        &ws,
        "module.set_prose",
        json!({
            "book": book,
            "owner": c1,
            "module": "mod-prose",
            "paragraphs": [{"text": "Synthetic updated paragraph."}],
        }),
    );
    std::thread::sleep(Duration::from_millis(5));
    // Update c2's synopsis field via entry.update so c2 is now even newer than c1,
    // while c3 remains untouched since creation.
    call(
        &ws,
        "entry.update",
        json!({"book": book, "id": c2, "title": "第2章 启程"}),
    );

    let snap = Rc::new(Book::load(&ws, &book).unwrap());
    let revision_before_sorts = snap.v3().unwrap().revision.clone();
    let updated = updated_timestamps(&ws, &snap);
    assert!(
        updated[&c2] > updated[&c1] && updated[&c1] > updated[&c3],
        "expected updated order c2 > c1 > c3, got {updated:?}"
    );

    // Verify rows_sorted in List and Grid across all four modes.
    for display in [Display::List, Display::Grid] {
        assert_eq!(
            resident_ids(&rows_sorted(
                &snap,
                &folder,
                display,
                DisplaySurface::Page,
                SortOrder::Manual,
                &updated,
                &BTreeSet::new(),
                4,
            )),
            manual_order
        );
        assert_eq!(
            resident_ids(&rows_sorted(
                &snap,
                &folder,
                display,
                DisplaySurface::Page,
                SortOrder::Updated,
                &updated,
                &BTreeSet::new(),
                4,
            )),
            vec![c2.clone(), c1.clone(), c3.clone()]
        );
        assert_eq!(
            resident_ids(&rows_sorted(
                &snap,
                &folder,
                display,
                DisplaySurface::Page,
                SortOrder::Created,
                &updated,
                &BTreeSet::new(),
                4,
            )),
            vec![c3.clone(), c2.clone(), c1.clone()]
        );
        assert_eq!(
            resident_ids(&rows_sorted(
                &snap,
                &folder,
                display,
                DisplaySurface::Page,
                SortOrder::Name,
                &updated,
                &BTreeSet::new(),
                4,
            )),
            vec![c3.clone(), c2.clone(), c1.clone()]
        );
    }

    // Islands and Board ignore non-manual sort and do not allow reordering.
    let island_view = LevelDisplay::new(
        LevelHost {
            page: PageViewHost {
                workspace: WeakEntity::new_invalid(),
                library: ws.clone(),
                book_id: book.clone(),
                book: snap.clone(),
            },
            level: folder.clone(),
            surface: DisplaySurface::Page,
        },
        Display::Islands,
    );
    assert!(!island_view.can_reorder());
    let board_view = LevelDisplay::new(
        LevelHost {
            page: PageViewHost {
                workspace: WeakEntity::new_invalid(),
                library: ws.clone(),
                book_id: book.clone(),
                book: snap.clone(),
            },
            level: folder.clone(),
            surface: DisplaySurface::Page,
        },
        Display::Board,
    );
    assert!(!board_view.can_reorder());
    drop((island_view, board_view));

    // Persist a device-local sort key, shut down and reopen from disk first,
    // confirming LevelDisplay::new restores it without touching book revision.
    let local_row = format!("memory:{book}:{}", sort_memory_key(&folder));
    ws.library()
        .local_set(
            dr_shell::workspace::BOOK_MEMORY_SCOPE,
            &local_row,
            &json!("name").to_string(),
            Some(&book),
        )
        .unwrap();
    drop(snap);
    ws.shutdown().unwrap();

    let ws = Workspace::open_dir(dir.path(), "0.2.0-dev").unwrap();
    let snap = Rc::new(Book::load(&ws, &book).unwrap());
    assert_eq!(snap.v3().unwrap().revision, revision_before_sorts);
    assert_eq!(snap.v3().unwrap().levels[&folder].children, manual_order);

    let restored_view = LevelDisplay::new(
        LevelHost {
            page: PageViewHost {
                workspace: WeakEntity::new_invalid(),
                library: ws.clone(),
                book_id: book.clone(),
                book: snap.clone(),
            },
            level: folder.clone(),
            surface: DisplaySurface::Page,
        },
        Display::Grid,
    );
    assert_eq!(restored_view.sort, SortOrder::Name);
    assert!(!restored_view.can_reorder());
    assert_eq!(
        resident_ids(&restored_view.rows),
        vec![c3.clone(), c2.clone(), c1.clone()]
    );
    drop(restored_view);
    // A Tab's tree in the left column has no sort of its own (Tab
    // prototype, 2026-11-15): the saved sort is not read there.
    let column_view = LevelDisplay::new(
        LevelHost {
            page: PageViewHost {
                workspace: WeakEntity::new_invalid(),
                library: ws.clone(),
                book_id: book.clone(),
                book: snap.clone(),
            },
            level: folder.clone(),
            surface: DisplaySurface::Sidebar,
        },
        Display::List,
    );
    assert_eq!(column_view.sort, SortOrder::Manual);
    drop(column_view);

    // Drive LevelDisplay::set_sort: must store in local_state only, leave book
    // revision untouched, disable can_reorder when non-manual, and restore exact
    // manual order when switched back to Manual.
    let view = cx.update(|cx| {
        cx.new(|_| {
            LevelDisplay::new(
                LevelHost {
                    page: PageViewHost {
                        workspace: WeakEntity::new_invalid(),
                        library: ws.clone(),
                        book_id: book.clone(),
                        book: snap.clone(),
                    },
                    level: folder.clone(),
                    surface: DisplaySurface::Page,
                },
                Display::List,
            )
        })
    });
    cx.update(|cx| {
        assert_eq!(view.read(cx).sort, SortOrder::Name);
        assert!(!view.read(cx).can_reorder());
        view.update(cx, |v, cx| v.set_sort(SortOrder::Created, cx));
        assert!(!view.read(cx).can_reorder());
        assert_eq!(
            resident_ids(&view.read(cx).rows),
            vec![c3.clone(), c2.clone(), c1.clone()]
        );
    });

    // While viewing by time (`can_reorder == false`), sibling drops and dropping
    // Into the same parent are refused; cross-folder moves and accept hosts
    // remain available!
    assert_eq!(
        resolve_drop(&snap, &c3, &c1, DropSlot::Before, false, false),
        None
    );
    assert_eq!(
        resolve_drop(&snap, &c3, &c1, DropSlot::After, false, false),
        None
    );
    assert_eq!(
        resolve_drop(&snap, &c3, &c1, DropSlot::Into, false, false),
        None
    );
    assert_eq!(
        resolve_drop(&snap, &c3, &folder, DropSlot::Into, false, false),
        None
    );
    assert_eq!(
        resolve_drop(&snap, &c3, &other_folder, DropSlot::Into, false, false),
        Some(Drop::Residence {
            parent: Some(other_folder.clone()),
            anchor: None,
        })
    );
    assert_eq!(
        resolve_drop(&snap, &c3, &lane, DropSlot::Into, false, false),
        None
    );

    // Book revision and stored manual order did not change at all.
    let unchanged = Book::load(&ws, &book).unwrap();
    assert_eq!(unchanged.v3().unwrap().revision, revision_before_sorts);
    assert_eq!(
        unchanged.v3().unwrap().levels[&folder].children,
        manual_order
    );

    // Switch back to Manual and verify both the rows and saved local_state row.
    cx.update(|cx| {
        view.update(cx, |v, cx| v.set_sort(SortOrder::Manual, cx));
        assert!(view.read(cx).can_reorder());
        assert_eq!(resident_ids(&view.read(cx).rows), manual_order);
    });
    assert_eq!(
        ws.library()
            .local_get(dr_shell::workspace::BOOK_MEMORY_SCOPE, &local_row)
            .unwrap()
            .as_deref(),
        Some("\"manual\"")
    );
    drop(view);
    cx.run_until_parked();
    drop(ws);
}

#[test]
fn drop_slot_geometry_and_sibling_order_write_guard() {
    let box_bounds = Bounds {
        origin: Point {
            x: px(10.0),
            y: px(20.0),
        },
        size: size(px(100.0), px(40.0)),
    };

    // List leaf row: top half Before, exact center & bottom half After.
    assert_eq!(
        drop_slot_at(
            box_bounds,
            Point {
                x: px(50.0),
                y: px(39.0)
            },
            false,
            false,
            true
        ),
        DropSlot::Before
    );
    assert_eq!(
        drop_slot_at(
            box_bounds,
            Point {
                x: px(50.0),
                y: px(40.0)
            },
            false,
            false,
            true
        ),
        DropSlot::After
    );

    // Grid leaf tile: left half Before, exact center & right half After.
    assert_eq!(
        drop_slot_at(
            box_bounds,
            Point {
                x: px(59.0),
                y: px(55.0)
            },
            false,
            true,
            true
        ),
        DropSlot::Before
    );
    assert_eq!(
        drop_slot_at(
            box_bounds,
            Point {
                x: px(60.0),
                y: px(25.0)
            },
            false,
            true,
            true
        ),
        DropSlot::After
    );

    // Level row: top 25% Before, middle 50% (including center) Into, bottom 25% After.
    assert_eq!(
        drop_slot_at(
            box_bounds,
            Point {
                x: px(50.0),
                y: px(29.0)
            },
            true,
            false,
            true
        ),
        DropSlot::Before
    );
    assert_eq!(
        drop_slot_at(
            box_bounds,
            Point {
                x: px(50.0),
                y: px(40.0)
            },
            true,
            false,
            true
        ),
        DropSlot::Into
    );
    assert_eq!(
        drop_slot_at(
            box_bounds,
            Point {
                x: px(50.0),
                y: px(51.0)
            },
            true,
            false,
            true
        ),
        DropSlot::After
    );
    assert_eq!(
        drop_slot_at(
            box_bounds,
            Point {
                x: px(20.0),
                y: px(21.0)
            },
            true,
            false,
            false
        ),
        DropSlot::Into
    );

    // Sibling order write-guard: concurrent edit in an unrelated folder is
    // allowed, whereas concurrent sibling reorder in the same folder conflicts!
    let (_dir, ws, book) = seed();
    let initial = Book::load(&ws, &book).unwrap();
    let manuscript = root_by_template(&initial, "tpl-manuscript");
    let folder_a = create_entry(&ws, &book, &manuscript, "tpl-group", "Folder A", Some(true));
    let folder_b = create_entry(&ws, &book, &manuscript, "tpl-group", "Folder B", Some(true));
    let a1 = create_entry(&ws, &book, &folder_a, "tpl-chapter", "A1", None);
    let a2 = create_entry(&ws, &book, &folder_a, "tpl-chapter", "A2", None);
    let a3 = create_entry(&ws, &book, &folder_a, "tpl-chapter", "A3", None);
    let b1 = create_entry(&ws, &book, &folder_b, "tpl-chapter", "B1", None);
    let b2 = create_entry(&ws, &book, &folder_b, "tpl-chapter", "B2", None);

    let snap_1 = Book::load(&ws, &book).unwrap();
    let target_1 = resolve_drop(&snap_1, &a3, &a1, DropSlot::Before, true, false).unwrap();
    let pending_a = prepare_resolved_drop(&snap_1, &a3, target_1).unwrap();

    // Concurrent reorder in Folder B must NOT block Folder A's prepared drop.
    call(
        &ws,
        "entry.move",
        json!({"book": book, "id": b2, "parent": folder_b, "index": 0}),
    );
    assert_eq!(
        Book::load(&ws, &book).unwrap().v3().unwrap().levels[&folder_b].children,
        vec![b2, b1]
    );
    assert!(pending_a.commit_if_changed(&ws).unwrap().is_some());
    assert_eq!(
        Book::load(&ws, &book).unwrap().v3().unwrap().levels[&folder_a].children,
        vec![a3.clone(), a1.clone(), a2.clone()]
    );

    // Concurrent reorder inside Folder A itself MUST reject the stale drop.
    let snap_2 = Book::load(&ws, &book).unwrap();
    let target_2 = resolve_drop(&snap_2, &a2, &a3, DropSlot::Before, true, false).unwrap();
    let stale_a = prepare_resolved_drop(&snap_2, &a2, target_2).unwrap();
    call(
        &ws,
        "entry.move",
        json!({"book": book, "id": a1, "parent": folder_a, "index": 0}),
    );
    let err = stale_a.commit_if_changed(&ws).unwrap_err();
    assert!(
        matches!(err, WsError::Conflict(_)),
        "expected conflict when sibling order changed concurrently, got {err:?}"
    );
    assert_eq!(
        Book::load(&ws, &book).unwrap().v3().unwrap().levels[&folder_a].children,
        vec![a1, a3, a2]
    );
    ws.shutdown().unwrap();
}

fn wait_workspace(
    view: &Entity<ShellWorkspace>,
    cx: &mut VisualTestContext,
    done: impl Fn(&ShellWorkspace, &App) -> bool,
) {
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        cx.run_until_parked();
        cx.update(|window, cx| {
            window.simulate_next_frame(cx);
            window.draw(cx).clear(cx);
        });
        if view.read_with(cx, |w, cx| done(w, cx)) {
            return;
        }
        assert!(Instant::now() < until, "workspace did not settle");
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[gpui::test]
fn three_surfaces_sync_sort_and_cmd_z_undoes_reorder_without_stealing_prose_undo(
    cx: &mut TestAppContext,
) {
    cx.executor().allow_parking();
    let (_dir, lib, book) = seed();
    let initial = Book::load(&lib, &book).unwrap();
    let manuscript = root_by_template(&initial, "tpl-manuscript");

    // Create a hybrid entry that has BOTH prose AND `children` ("下面的条目")
    // by adding a `children` module to `tpl-chapter` and turning its level
    // switch on, plus a grid-configured folder for the level page surface.
    call(
        &lib,
        "entry_template.put_module",
        json!({
            "book": book,
            "template": "tpl-chapter",
            "module": {"id": "mod-children", "name": "下面的条目", "kind": "children"}
        }),
    );
    let hybrid = create_entry(
        &lib,
        &book,
        &manuscript,
        "tpl-chapter",
        "Synthetic Hybrid Entry",
        Some(true),
    );
    call(
        &lib,
        "module.set_prose",
        json!({
            "book": book,
            "owner": hybrid,
            "module": "mod-prose",
            "paragraphs": [{"text": "Initial hybrid prose."}],
        }),
    );
    let h1 = create_entry(&lib, &book, &hybrid, "tpl-chapter", "Sub B", None);
    let h2 = create_entry(&lib, &book, &hybrid, "tpl-chapter", "Sub A", None);

    let grid_folder = create_entry(
        &lib,
        &book,
        &manuscript,
        "tpl-group",
        "Synthetic Grid Level",
        Some(true),
    );
    call(
        &lib,
        "entry.update",
        json!({"book": book, "id": grid_folder, "overrides": {"display": "grid"}}),
    );
    let _g1 = create_entry(&lib, &book, &grid_folder, "tpl-chapter", "Tile 2", None);
    let _g2 = create_entry(&lib, &book, &grid_folder, "tpl-chapter", "Tile 1", None);

    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "0.2.0-dev",
                url_scheme: "drifting-next-dev",
                forced_appearance: Some(dr_ui::Appearance::Light),
            },
            Services {
                library: Some(lib.clone()),
                book: Some(book.clone()),
                ..Services::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
        dr_view_page::init(cx);
        dr_view_elements::init(cx);
    });

    let (ws, vcx) = cx.add_window_view(ShellWorkspace::new);
    vcx.update(|window, _| window.activate_window());
    vcx.simulate_resize(size(px(1280.0), px(860.0)));
    wait_workspace(&ws, vcx, |w, _| {
        w.book.v3().is_some() && w.book_memory_ready()
    });

    // Surface 3: open the Grid level page and verify it renders without error
    // and syncs per-folder sort memory without mutating BookV3.revision.
    let grid_target = Target::Entry {
        id: grid_folder.parse().unwrap(),
        module: None,
    };
    ws.update(vcx, |w, cx| w.open(grid_target.clone(), Open::KEEP, cx));
    wait_workspace(&ws, vcx, |w, _| w.nav.is_selected(&grid_target));

    let rev_before_memory = ws.read_with(vcx, |w, _| w.book.v3().unwrap().revision.clone());
    let sort_key = sort_memory_key(&hybrid);
    ws.update(vcx, |w, cx| {
        w.set_book_memory(&sort_key, json!("name"), cx);
        cx.notify();
    });
    vcx.run_until_parked();
    assert_eq!(
        ws.read_with(vcx, |w, _| w.book.v3().unwrap().revision.clone()),
        rev_before_memory
    );
    ws.update(vcx, |w, cx| {
        w.set_book_memory(&sort_key, json!("manual"), cx);
        cx.notify();
    });

    // Surface 2: open the hybrid entry page (mounts both BodyModule prose AND
    // the `children` module "下面的条目", alongside Surface 1 in the left sidebar).
    let hybrid_target = Target::Entry {
        id: hybrid.parse().unwrap(),
        module: None,
    };
    ws.update(vcx, |w, cx| w.open(hybrid_target.clone(), Open::KEEP, cx));
    wait_workspace(&ws, vcx, |w, _| w.editor_of(&hybrid_target).is_some());

    // Perform a same-folder reorder under `hybrid`: place h2 Before h1.
    assert!(drag_reorder(&lib, &book, &h2, &h1, DropSlot::Before));
    wait_workspace(&ws, vcx, |w, _| {
        w.book
            .v3()
            .is_some_and(|v| v.levels[&hybrid].children == vec![h2.clone(), h1.clone()])
    });

    // Focus the prose editor, insert text, then dispatch `dr_shell::actions::Undo`
    // (bound to Cmd/Ctrl+Z): it MUST undo the prose edit and leave the folder
    // reorder untouched!
    let prose_editor = ws.read_with(vcx, |w, _| w.editor_of(&hybrid_target).unwrap().clone());
    let inner = prose_editor.read_with(vcx, |ed, _| ed.editor().clone());
    inner.update_in(vcx, |ed, window, cx| {
        ed.focus_handle(cx).focus(window, cx);
        ed.select(0, 0..0, window, cx);
        ed.replace_text_in_range(None, "Typed ", window, cx);
    });
    vcx.run_until_parked();
    assert!(prose_editor.read_with(vcx, |ed, cx| ed.plain_text(cx).contains("Typed")));

    vcx.dispatch_action(dr_shell::actions::Undo);
    vcx.run_until_parked();
    assert!(
        !prose_editor.read_with(vcx, |ed, cx| ed.plain_text(cx).contains("Typed")),
        "Cmd/Ctrl+Z inside a focused ProseEditor must undo prose typing"
    );
    assert_eq!(
        Book::load(&lib, &book).unwrap().v3().unwrap().levels[&hybrid].children,
        vec![h2.clone(), h1.clone()],
        "Cmd/Ctrl+Z inside ProseEditor must not undo the folder reorder"
    );

    // Move focus to the workspace / LevelDisplay surface (as starting or
    // completing a drag does), then dispatch `dr_shell::actions::Undo`: it MUST
    // undo the same-folder reorder in one step, and `Redo` must reapply it!
    vcx.update(|window, cx| {
        let focus = ws.read(cx).focus_handle().clone();
        focus.focus(window, cx);
    });
    vcx.dispatch_action(dr_shell::actions::Undo);
    wait_workspace(&ws, vcx, |w, _| {
        w.book
            .v3()
            .is_some_and(|v| v.levels[&hybrid].children == vec![h1.clone(), h2.clone()])
    });
    assert_eq!(
        Book::load(&lib, &book).unwrap().v3().unwrap().levels[&hybrid].children,
        vec![h1.clone(), h2.clone()]
    );

    vcx.dispatch_action(dr_shell::actions::Redo);
    wait_workspace(&ws, vcx, |w, _| {
        w.book
            .v3()
            .is_some_and(|v| v.levels[&hybrid].children == vec![h2.clone(), h1.clone()])
    });
    assert_eq!(
        Book::load(&lib, &book).unwrap().v3().unwrap().levels[&hybrid].children,
        vec![h2, h1]
    );
}
