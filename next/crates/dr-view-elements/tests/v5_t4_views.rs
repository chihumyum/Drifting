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
    panel::v3::{Display, LevelDisplay, Row, Section, rows_sorted},
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
            Row::Member { id } => Some(id.clone()),
            _ => None,
        })
        .collect()
}

fn manuscript_entries(v: &dr_shell::book::v3::BookV3) -> Vec<String> {
    v.manuscript.iter().map(|m| m.entry.clone()).collect()
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

#[test]
fn lane_page_orders_residents_and_members_by_authoritative_scale_and_preserves_order_on_removal() {
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

    // Order in View A: Residents [r_b, r_c, r_a], Members [m_y, m_z, m_x].
    for (entry, at) in [
        (&r_b, 1.0),
        (&r_c, 2.0),
        (&r_a, 3.0),
        (&m_y, 4.0),
        (&m_z, 5.0),
        (&m_x, 6.0),
    ] {
        call(
            &ws,
            "timeline_view.place",
            json!({"book": book, "view": "view-a", "entry": entry, "at": at}),
        );
    }
    // Independent order in View B: Residents [r_a, r_c, r_b], Members [m_x, m_z, m_y].
    for (entry, at) in [
        (&r_a, 10.0),
        (&r_c, 20.0),
        (&r_b, 30.0),
        (&m_x, 40.0),
        (&m_z, 50.0),
        (&m_y, 60.0),
    ] {
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
        let rows = rows_sorted(
            &snap_a,
            &lane,
            display,
            false,
            sort,
            &fake_updated,
            &BTreeSet::new(),
            3,
        );
        assert!(rows.contains(&Row::Section(Section::Residents)));
        assert!(rows.contains(&Row::Section(Section::Members)));
        assert_eq!(
            resident_ids(&rows),
            vec![r_b.clone(), r_c.clone(), r_a.clone()],
            "residents must follow View A scale regardless of {display:?}/{sort:?}"
        );
        assert_eq!(
            member_ids(&rows),
            vec![m_y.clone(), m_z.clone(), m_x.clone()],
            "members must follow View A scale regardless of {display:?}/{sort:?}"
        );
    }

    // Setting `project.book.root` to `view-b` makes `lane`'s own page follow
    // `view-b`'s scale, while `view-a` retains its own placements untouched.
    call(
        &ws,
        "project.update",
        json!({"book": book, "root": {"kind": "view", "view": "view-b"}}),
    );
    let snap_b = Book::load(&ws, &book).unwrap();
    let rows_b = rows_sorted(
        &snap_b,
        &lane,
        Display::List,
        false,
        SortOrder::Name,
        &fake_updated,
        &BTreeSet::new(),
        2,
    );
    assert_eq!(
        resident_ids(&rows_b),
        vec![r_a.clone(), r_c.clone(), r_b.clone()]
    );
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
    let rows_after_removal = rows_sorted(
        &snap_removed,
        &lane,
        Display::List,
        false,
        SortOrder::Manual,
        &BTreeMap::new(),
        &BTreeSet::new(),
        2,
    );
    assert_eq!(
        resident_ids(&rows_after_removal),
        vec![r_a.clone(), r_c.clone(), r_b.clone()]
    );
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
    let rows_readded = rows_sorted(
        &snap_readded,
        &lane,
        Display::List,
        false,
        SortOrder::Manual,
        &BTreeMap::new(),
        &BTreeSet::new(),
        2,
    );
    assert_eq!(resident_ids(&rows_readded), vec![r_a, r_c, r_b]);
    assert_eq!(member_ids(&rows_readded), vec![m_x, m_z, m_y]);
    ws.shutdown().unwrap();
}

#[test]
fn folder_in_view_drag_reorder_updates_scale_handles_trashed_siblings_and_guards_concurrency() {
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
        "project.update",
        json!({"book": book, "root": {"kind": "entry", "entry": folder}}),
    );
    call(
        &ws,
        "timeline_view.put",
        json!({"book": book, "view": {"id": "folder-view", "name": "Folder View"}}),
    );
    call(
        &ws,
        "timeline_view.add_lane",
        json!({"book": book, "view": "folder-view", "lane": folder}),
    );

    // Adding the folder to a view places live chapters onto the scale in manual order.
    let s0 = Book::load(&ws, &book).unwrap();
    assert_eq!(
        s0.v3().unwrap().levels[&folder].children,
        vec![ch_1.clone(), ch_2.clone(), ch_3.clone()]
    );
    assert_eq!(
        manuscript_entries(s0.v3().unwrap()),
        vec![ch_1.clone(), ch_2.clone(), ch_3.clone()]
    );

    // Dragging on the view updates the sidebar/page list and manuscript sequence.
    call(
        &ws,
        "timeline_view.place",
        json!({"book": book, "view": "folder-view", "entry": ch_3, "at": -5.0}),
    );
    let s1 = Book::load(&ws, &book).unwrap();
    assert_eq!(
        s1.v3().unwrap().levels[&folder].children,
        vec![ch_3.clone(), ch_1.clone(), ch_2.clone()]
    );
    assert_eq!(
        manuscript_entries(s1.v3().unwrap()),
        vec![ch_3.clone(), ch_1.clone(), ch_2.clone()]
    );

    // Dropping an entry Before its current successor in the scale order is a no-op
    // even when a trashed sibling precedes them in raw LoroTree storage.
    let rev_before_noop = s1.v3().unwrap().revision.clone();
    assert!(!drag_reorder(&ws, &book, &ch_3, &ch_1, DropSlot::Before));
    assert_eq!(
        Book::load(&ws, &book).unwrap().v3().unwrap().revision,
        rev_before_noop
    );

    // Dragging inside the folder (sidebar / folder page) writes back to the view's scale!
    assert!(drag_reorder(&ws, &book, &ch_2, &ch_3, DropSlot::Before));
    let s2 = Book::load(&ws, &book).unwrap();
    assert_eq!(
        s2.v3().unwrap().levels[&folder].children,
        vec![ch_2.clone(), ch_3.clone(), ch_1.clone()]
    );
    assert_eq!(
        manuscript_entries(s2.v3().unwrap()),
        vec![ch_2.clone(), ch_3.clone(), ch_1.clone()]
    );

    // Concurrent scale edit on `folder-view` conflicts with a stale DropMutation.
    let stale_snap = Book::load(&ws, &book).unwrap();
    let stale_target =
        resolve_drop(&stale_snap, &ch_1, &ch_2, DropSlot::Before, true, false).unwrap();
    let stale_drop = prepare_resolved_drop(&stale_snap, &ch_1, stale_target).unwrap();
    call(
        &ws,
        "timeline_view.place",
        json!({"book": book, "view": "folder-view", "entry": ch_3, "at": -20.0}),
    );
    let err = stale_drop.commit_if_changed(&ws).unwrap_err();
    assert!(
        matches!(err, WsError::Conflict(_)),
        "expected conflict when view scale changed concurrently, got {err:?}"
    );

    // Removing the folder from the view preserves the scale order `[ch_3, ch_2, ch_1]`.
    let order_in_view = Book::load(&ws, &book).unwrap().v3().unwrap().levels[&folder]
        .children
        .clone();
    assert_eq!(
        order_in_view,
        vec![ch_3.clone(), ch_2.clone(), ch_1.clone()]
    );
    call(
        &ws,
        "timeline_view.remove_lane",
        json!({"book": book, "view": "folder-view", "lane": folder}),
    );
    let s3 = Book::load(&ws, &book).unwrap();
    assert_eq!(s3.v3().unwrap().levels[&folder].children, order_in_view);
    assert_eq!(manuscript_entries(s3.v3().unwrap()), order_in_view);
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
