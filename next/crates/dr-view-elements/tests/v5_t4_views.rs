//! Kernel v5 Track T4 (`t4-views`): authoritative view scale ordering on lane
//! and view-governed folder pages, multi-view reference resolution, scale-order
//! preservation on lane removal, and view-governed folder drag-reorder.

use std::{
    collections::{BTreeMap, BTreeSet},
    rc::Rc,
    time::{Duration, Instant},
};

use dr_shell::{
    Services, SettingsFile, ShellInfo,
    book::Book,
    pages::PageViewHost,
    v3::{DisplaySurface, LevelHost},
};
use dr_view_elements::{
    data::v3::{DropSlot, SortOrder, prepare_resolved_drop, resolve_drop, sort_memory_key},
    panel::v3::{Display, LevelDisplay, Row, rows_sorted},
};
use dr_workspace::{Actor, Workspace, WsError};
use gpui::{Entity, TestAppContext, VisualTestContext, WeakEntity, px, size};
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
    parent: Option<&str>,
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

fn member_ids(rows: &[Row]) -> Vec<String> {
    rows.iter()
        .filter_map(|row| match row {
            Row::Member { id, .. } => Some(id.clone()),
            _ => None,
        })
        .collect()
}

/// What a level's page lists in its two blocks (`kernel-v5.md` §16, T1):
/// what lives under it on the page's surface, then what is attached to it
/// on its own.
#[allow(clippy::too_many_arguments)]
fn both_blocks(
    book: &Book,
    level: &str,
    display: Display,
    sort: SortOrder,
    updated: &dr_view_elements::data::v3::UpdatedMap,
    folded: &BTreeSet<String>,
    columns: usize,
) -> Vec<Row> {
    let mut rows = rows_sorted(
        book,
        level,
        display,
        DisplaySurface::Page,
        sort,
        updated,
        folded,
        columns,
    );
    rows.extend(rows_sorted(
        book,
        level,
        display,
        DisplaySurface::Members,
        sort,
        updated,
        folded,
        columns,
    ));
    rows
}

/// The book's entries living directly in `folder`, in book order (the book
/// reads from the root, DW).
fn book_in(v: &dr_shell::book::v3::BookV3, folder: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for m in &v.manuscript {
        if v.entry(&m.entry).and_then(|e| e.parent.as_deref()) == Some(folder)
            && !out.contains(&m.entry)
        {
            out.push(m.entry.clone());
        }
    }
    out
}

fn drag_reorder(ws: &Workspace, book_id: &str, entry: &str, onto: &str, slot: DropSlot) -> bool {
    let snapshot = Book::load(ws, book_id).unwrap();
    let target = resolve_drop(&snapshot, entry, onto, slot, true, false)
        .expect("same-folder drop should resolve");
    prepare_resolved_drop(&snapshot, entry, target)
        .unwrap()
        .commit_if_changed(ws)
        .unwrap()
        .is_some()
}

/// A lane holds what is hung on it (DV, `kernel-v5.md` §16 「泳道」): on the
/// page of an entry with both switches that is a lane, what is hung on it
/// follows the first view's scale and keeps it after leaving the last view;
/// what lives under it keeps its manual order throughout.
#[test]
fn lane_page_orders_members_by_the_scale_and_keeps_residents_in_manual_order() {
    let (_dir, ws, book) = seed();
    let initial = Book::load(&ws, &book).unwrap();
    let manuscript = root_by_template(&initial, "tpl-manuscript");

    // Hybrid lane: both `level == true` (residents) and `accept == true` (members).
    let lane = create_entry(
        &ws,
        &book,
        None,
        "tpl-group",
        "Synthetic Hybrid Lane",
        Some(true),
    );
    call(
        &ws,
        "entry.update",
        json!({"book": book, "id": lane, "overrides": {"accept": true}}),
    );
    let r_c = create_entry(&ws, &book, Some(&lane), "tpl-chapter", "Resident C", None);
    let r_a = create_entry(&ws, &book, Some(&lane), "tpl-chapter", "Resident A", None);
    let r_b = create_entry(&ws, &book, Some(&lane), "tpl-chapter", "Resident B", None);

    let m_z = create_entry(
        &ws,
        &book,
        Some(&manuscript),
        "tpl-chapter",
        "Member Z",
        None,
    );
    let m_x = create_entry(
        &ws,
        &book,
        Some(&manuscript),
        "tpl-chapter",
        "Member X",
        None,
    );
    let m_y = create_entry(
        &ws,
        &book,
        Some(&manuscript),
        "tpl-chapter",
        "Member Y",
        None,
    );
    for m in [&m_z, &m_x, &m_y] {
        call(
            &ws,
            "membership.add",
            json!({"book": book, "host": lane, "member": m}),
        );
    }

    // Put `lane` into two independent views (`view_a`, `view_b`).
    let p0 = dr_model::pos::PosKey::first();
    let p1 = p0.after();
    call(
        &ws,
        "timeline_view.put",
        json!({"book": book, "view": {"id": "view-a", "name": "View A", "pos": p0.to_string()}}),
    );
    call(
        &ws,
        "timeline_view.put",
        json!({"book": book, "view": {"id": "view-b", "name": "View B", "pos": p1.to_string()}}),
    );
    call(
        &ws,
        "timeline_view.add_lane",
        json!({"book": book, "view": "view-a", "lane": lane}),
    );
    call(
        &ws,
        "timeline_view.add_lane",
        json!({"book": book, "view": "view-b", "lane": lane}),
    );

    // Residents are on no lane: no place on either scale, and none can be
    // given them without hanging them.
    for v in call(&ws, "timeline_view.list", json!({"book": book}))
        .as_array()
        .unwrap()
    {
        for r in [&r_a, &r_b, &r_c] {
            assert!(
                v["placements"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|p| p["entry"] != *r)
            );
        }
    }
    assert!(
        ws.call(
            &Actor::User,
            "timeline_view.place",
            json!({"book": book, "view": "view-a", "entry": r_b, "at": 1.0}),
        )
        .is_err()
    );
    let manual = vec![r_c.clone(), r_a.clone(), r_b.clone()];

    // Order in View A: Members [m_y, m_z, m_x].
    for (entry, at) in [(&m_y, 4.0), (&m_z, 5.0), (&m_x, 6.0)] {
        call(
            &ws,
            "timeline_view.place",
            json!({"book": book, "view": "view-a", "entry": entry, "at": at}),
        );
    }
    // Independent order in View B: Members [m_x, m_z, m_y].
    for (entry, at) in [(&m_x, 40.0), (&m_z, 50.0), (&m_y, 60.0)] {
        call(
            &ws,
            "timeline_view.place",
            json!({"book": book, "view": "view-b", "entry": entry, "at": at}),
        );
    }

    // While `project.book.root` is still the manuscript entry, `lane` follows
    // the first live view containing it (`view-a`), and local display sorts
    // (`Name`, `Updated`) do NOT override its authoritative scale order!
    let snap_a = Book::load(&ws, &book).unwrap();
    let mut fake_updated = BTreeMap::new();
    fake_updated.insert(r_a.clone(), (999, 999));
    fake_updated.insert(m_x.clone(), (999, 999));
    for (display, sort) in [
        (Display::List, SortOrder::Manual),
        (Display::List, SortOrder::Name),
        (Display::List, SortOrder::Updated),
        (Display::Grid, SortOrder::Name),
    ] {
        let rows = both_blocks(
            &snap_a,
            &lane,
            display,
            sort,
            &fake_updated,
            &BTreeSet::new(),
            3,
        );
        assert_eq!(
            resident_ids(&rows),
            manual,
            "residents keep their manual order in a lane, whatever {display:?}/{sort:?}"
        );
        assert_eq!(
            member_ids(&rows),
            vec![m_y.clone(), m_z.clone(), m_x.clone()],
            "members must follow View A scale regardless of {display:?}/{sort:?}"
        );
    }

    // Putting `view-b` before `view-a` makes `lane`'s own page follow
    // `view-b`'s scale (the first view it is in), while `view-a` retains its
    // own placements untouched.
    let mut tv_b = call(&ws, "timeline_view.list", json!({"book": book}))
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == "view-b")
        .unwrap()
        .clone();
    tv_b["pos"] = json!(
        dr_model::pos::PosKey::between(None, Some(&p0))
            .unwrap()
            .to_string()
    );
    call(
        &ws,
        "timeline_view.put",
        json!({"book": book, "view": tv_b}),
    );
    let snap_b = Book::load(&ws, &book).unwrap();
    let rows_b = both_blocks(
        &snap_b,
        &lane,
        Display::List,
        SortOrder::Name,
        &fake_updated,
        &BTreeSet::new(),
        2,
    );
    assert_eq!(resident_ids(&rows_b), manual);
    assert_eq!(
        member_ids(&rows_b),
        vec![m_x.clone(), m_z.clone(), m_y.clone()]
    );

    // Remove `lane` from `view-a`, then from `view-b` (its last live view):
    // the lane's own page preserves `view-b`'s prior scale order, and re-adding
    // `lane` to `view-b` keeps that exact order.
    call(
        &ws,
        "timeline_view.remove_lane",
        json!({"book": book, "view": "view-a", "lane": lane}),
    );
    call(
        &ws,
        "timeline_view.remove_lane",
        json!({"book": book, "view": "view-b", "lane": lane}),
    );
    let snap_removed = Book::load(&ws, &book).unwrap();
    assert!(!snap_removed.v3().unwrap().is_lane(&lane));
    let rows_after_removal = both_blocks(
        &snap_removed,
        &lane,
        Display::List,
        SortOrder::Manual,
        &BTreeMap::new(),
        &BTreeSet::new(),
        2,
    );
    assert_eq!(resident_ids(&rows_after_removal), manual);
    assert_eq!(
        member_ids(&rows_after_removal),
        vec![m_x.clone(), m_z.clone(), m_y.clone()]
    );

    call(
        &ws,
        "timeline_view.add_lane",
        json!({"book": book, "view": "view-b", "lane": lane}),
    );
    let snap_readded = Book::load(&ws, &book).unwrap();
    let rows_readded = both_blocks(
        &snap_readded,
        &lane,
        Display::List,
        SortOrder::Manual,
        &BTreeMap::new(),
        &BTreeSet::new(),
        2,
    );
    assert_eq!(resident_ids(&rows_readded), manual);
    assert_eq!(member_ids(&rows_readded), vec![m_x, m_z, m_y]);
    ws.shutdown().unwrap();
}

/// A folder that is only a level does not go into a view; one with both
/// switches does, and dragging inside it in the left column or on its page
/// changes its manual order (counting a trashed sibling stored first), writes
/// nothing on the scale, and a stale drop still conflicts (DV, 2026-11-16).
#[test]
fn a_folder_in_a_view_reorders_by_hand_and_writes_nothing_on_the_scale() {
    let (_dir, ws, book) = seed();
    let initial = Book::load(&ws, &book).unwrap();
    let manuscript = root_by_template(&initial, "tpl-manuscript");

    let folder = create_entry(
        &ws,
        &book,
        Some(&manuscript),
        "tpl-group",
        "Chapter Folder",
        Some(true),
    );
    let trashed_first = create_entry(
        &ws,
        &book,
        Some(&folder),
        "tpl-chapter",
        "Trashed Sibling",
        None,
    );
    let ch_1 = create_entry(&ws, &book, Some(&folder), "tpl-chapter", "Ch 1", None);
    let ch_2 = create_entry(&ws, &book, Some(&folder), "tpl-chapter", "Ch 2", None);
    let ch_3 = create_entry(&ws, &book, Some(&folder), "tpl-chapter", "Ch 3", None);
    call(
        &ws,
        "entry.trash",
        json!({"book": book, "id": trashed_first}),
    );
    call(
        &ws,
        "timeline_view.put",
        json!({"book": book, "view": {"id": "folder-view", "name": "Folder View"}}),
    );
    match ws.call(
        &Actor::User,
        "timeline_view.add_lane",
        json!({"book": book, "view": "folder-view", "lane": folder}),
    ) {
        Err(WsError::Violation(v)) => assert_eq!(v.invariant, "V3-TIMELINE-LANE-ENABLED"),
        other => panic!("a folder that is only a level is no lane: {other:?}"),
    }
    call(
        &ws,
        "entry.update",
        json!({"book": book, "id": folder, "overrides": {"accept": true}}),
    );
    call(
        &ws,
        "timeline_view.add_lane",
        json!({"book": book, "view": "folder-view", "lane": folder}),
    );
    let placements = |ws: &Workspace| {
        call(ws, "timeline_view.list", json!({"book": book}))
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == "folder-view")
            .unwrap()["placements"]
            .clone()
    };
    assert_eq!(placements(&ws), json!([]), "nothing is hung on it");
    let s0 = Book::load(&ws, &book).unwrap();
    assert!(s0.v3().unwrap().is_lane(&folder));
    assert_eq!(
        s0.v3().unwrap().levels[&folder].children,
        vec![ch_1.clone(), ch_2.clone(), ch_3.clone()]
    );

    // Dropping an entry before its successor is a no-op, with a trashed
    // sibling first in raw storage.
    let rev_before_noop = s0.v3().unwrap().revision.clone();
    assert!(!drag_reorder(&ws, &book, &ch_1, &ch_2, DropSlot::Before));
    assert_eq!(
        Book::load(&ws, &book).unwrap().v3().unwrap().revision,
        rev_before_noop
    );

    // Dragging inside the folder changes the manual order, and the book.
    assert!(drag_reorder(&ws, &book, &ch_3, &ch_1, DropSlot::Before));
    let s1 = Book::load(&ws, &book).unwrap();
    assert_eq!(
        s1.v3().unwrap().levels[&folder].children,
        vec![ch_3.clone(), ch_1.clone(), ch_2.clone()]
    );
    assert_eq!(
        book_in(s1.v3().unwrap(), &folder),
        vec![ch_3.clone(), ch_1.clone(), ch_2.clone()]
    );
    assert_eq!(placements(&ws), json!([]));

    // A drop planned before another device reordered the folder conflicts.
    let stale_snap = Book::load(&ws, &book).unwrap();
    let stale_target =
        resolve_drop(&stale_snap, &ch_2, &ch_3, DropSlot::Before, true, false).unwrap();
    let stale_drop = prepare_resolved_drop(&stale_snap, &ch_2, stale_target).unwrap();
    call(
        &ws,
        "entry.move",
        json!({"book": book, "id": ch_1, "parent": folder, "index": 0}),
    );
    let err = stale_drop.commit_if_changed(&ws).unwrap_err();
    assert!(
        matches!(err, WsError::Conflict(_)),
        "expected a conflict when the folder changed concurrently, got {err:?}"
    );

    // Taking the folder out of the view changes no order.
    let before_out = Book::load(&ws, &book).unwrap().v3().unwrap().levels[&folder]
        .children
        .clone();
    call(
        &ws,
        "timeline_view.remove_lane",
        json!({"book": book, "view": "folder-view", "lane": folder}),
    );
    let s3 = Book::load(&ws, &book).unwrap();
    assert_eq!(s3.v3().unwrap().levels[&folder].children, before_out);
    ws.shutdown().unwrap();
}

fn wait_for(cx: &mut VisualTestContext, done: impl Fn(&mut VisualTestContext) -> bool) {
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        cx.run_until_parked();
        cx.update(|window, cx| {
            window.simulate_next_frame(cx);
            window.draw(cx).clear(cx);
        });
        if done(cx) {
            return;
        }
        assert!(Instant::now() < until, "view did not settle");
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[gpui::test]
fn lane_level_display_hides_sort_controls_and_keeps_reorder_enabled(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let (_dir, lib, book) = seed();
    let initial = Book::load(&lib, &book).unwrap();
    let manuscript = root_by_template(&initial, "tpl-manuscript");
    let folder = create_entry(
        &lib,
        &book,
        Some(&manuscript),
        "tpl-group",
        "View Governed Folder",
        Some(true),
    );
    // A lane takes entries from elsewhere (DV, 2026-11-16).
    call(
        &lib,
        "entry.update",
        json!({"book": book, "id": folder, "overrides": {"accept": true}}),
    );
    let _c1 = create_entry(&lib, &book, Some(&folder), "tpl-chapter", "Zeta", None);
    let _c2 = create_entry(&lib, &book, Some(&folder), "tpl-chapter", "Alpha", None);

    // Persist a non-manual local sort (`name`) for `folder` before mounting.
    let row = format!("memory:{book}:{}", sort_memory_key(&folder));
    lib.library()
        .local_set(
            dr_shell::workspace::BOOK_MEMORY_SCOPE,
            &row,
            "\"name\"",
            None,
        )
        .unwrap();

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
        dr_view_elements::init(cx);
    });

    let snap_before = Rc::new(Book::load(&lib, &book).unwrap());
    let folder_id = folder.clone();
    let lib_cl = lib.clone();
    let book_cl = book.clone();
    let (display, vcx): (Entity<LevelDisplay>, _) = cx.add_window_view(|_, _| {
        LevelDisplay::new(
            LevelHost {
                page: PageViewHost {
                    book_id: book_cl,
                    book: snap_before,
                    library: lib_cl,
                    workspace: WeakEntity::new_invalid(),
                },
                level: folder_id,
                surface: DisplaySurface::Page,
            },
            Display::List,
        )
    });
    vcx.simulate_resize(size(px(900.0), px(640.0)));
    let sort_sel: &'static str = Box::leak(format!("g2-sort-scroll-{folder}").into_boxed_str());

    // Before adding to a view: sort switcher is visible and `Name` sort disables manual reorder.
    wait_for(vcx, |vcx| vcx.debug_bounds(sort_sel).is_some());
    assert!(!display.read_with(vcx, |d, _| d.is_lane()));
    assert!(!display.read_with(vcx, |d, _| d.can_reorder()));

    // Add `folder` to a live view and refresh `LevelDisplay`: sort switcher disappears
    // and `can_reorder()` becomes true so dragging writes to the view's scale!
    call(
        &lib,
        "timeline_view.put",
        json!({"book": book, "view": {"id": "ui-view", "name": "UI View"}}),
    );
    call(
        &lib,
        "timeline_view.add_lane",
        json!({"book": book, "view": "ui-view", "lane": folder}),
    );
    let snap_in_view = Rc::new(Book::load(&lib, &book).unwrap());
    display.update(vcx, |d, cx| d.refresh(snap_in_view, cx));
    wait_for(vcx, |vcx| vcx.debug_bounds(sort_sel).is_none());
    assert!(display.read_with(vcx, |d, _| d.is_lane()));
    assert!(display.read_with(vcx, |d, _| d.can_reorder()));

    // Remove `folder` from its last view: sort switcher returns cleanly.
    call(
        &lib,
        "timeline_view.remove_lane",
        json!({"book": book, "view": "ui-view", "lane": folder}),
    );
    let snap_out = Rc::new(Book::load(&lib, &book).unwrap());
    display.update(vcx, |d, cx| d.refresh(snap_out, cx));
    wait_for(vcx, |vcx| vcx.debug_bounds(sort_sel).is_some());
    assert!(!display.read_with(vcx, |d, _| d.is_lane()));
}
