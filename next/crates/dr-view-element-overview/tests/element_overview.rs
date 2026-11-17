use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use dr_shell::{Services, SettingsFile, ShellInfo, Workspace, workspace::FillPlace};
use dr_ui::Appearance;
use dr_view_element_overview::{ElementLayoutMode, ElementOverview, IslandMode, RelatePoint};
use dr_view_elements::data::v3 as g2_data;
use dr_workspace::{
    Actor, Workspace as Library, WorkspaceOptions,
    commands::v3::entry::{CreateIn as EntryCreateIn, EntryCreate},
};
use gpui::{Entity, TestAppContext, VisualTestContext};
use serde_json::json;

fn wait(cx: &mut VisualTestContext, done: impl Fn(&mut VisualTestContext) -> bool) {
    let until = Instant::now() + Duration::from_secs(15);
    loop {
        cx.run_until_parked();
        cx.update(|window, cx| window.draw(cx).clear(cx));
        if done(cx) {
            return;
        }
        assert!(Instant::now() < until, "element-overview test timed out");
        std::thread::sleep(Duration::from_millis(4));
    }
}

fn setup_seed_fixture(
    preset: dr_testkit::seed::Preset,
) -> (tempfile::TempDir, Library, Vec<String>) {
    let dir = tempfile::tempdir().expect("tempdir");
    let store =
        dr_store::Library::open(dir.path(), dr_workspace::library_options("test")).expect("store");
    let seed =
        dr_testkit::seed::generate_v3(preset, dr_testkit::seed::DEFAULT_SEED).expect("seed v3");
    let book_ids: Vec<String> = seed.books.iter().map(|b| b.book_id().to_string()).collect();
    seed.write_to(&store).expect("write seed");
    store.rebuild_stale_indexes().expect("rebuild indexes");
    let lib = Library::open(store, WorkspaceOptions::default()).expect("open workspace");
    (dir, lib, book_ids)
}

fn init_test_shell(lib: Library, book_id: String, cx: &mut TestAppContext) {
    cx.update(|cx| {
        let _ = dr_ui::init(cx);
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "0.2.0-dev",
                url_scheme: "drifting-next-dev",
                forced_appearance: Some(Appearance::Light),
            },
            Services {
                library: Some(lib),
                book: Some(book_id),
                ..Default::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
        dr_view_page::init(cx);
        dr_view_elements::init(cx);
        dr_view_element_overview::init(cx);
    });
}

fn mount_overview(
    shell: &Entity<Workspace>,
    cx: &mut VisualTestContext,
) -> Entity<ElementOverview> {
    cx.update(|window, cx| shell.update(cx, |ws, cx| ws.enter_fill(FillPlace::Left, window, cx)));
    wait(cx, |cx| {
        shell.read_with(cx, |ws, _| ws.v3_sidebar.is_some())
    });
    cx.update(|_, cx| {
        let ws = shell.read(cx);
        let v = ws.book.v3().expect("v3 book");
        let tab = v
            .project
            .tabs
            .iter()
            .find(|tab| match &tab.mount {
                dr_workspace::commands::v3::types::TabMount::Entry { entry } => v
                    .levels
                    .get(entry)
                    .is_some_and(|level| level.settings.display == "island"),
                _ => false,
            })
            .expect("seeded island Tab")
            .id
            .clone();
        let sidebar = ws.v3_sidebar.clone().expect("left sidebar");
        sidebar.update(cx, |sidebar, cx| sidebar.choose(&tab, cx));
    });
    wait(cx, |cx| {
        cx.update(|_, cx| {
            dr_view_element_overview::current(cx).is_some_and(|ov| ov.read(cx).is_ready())
        })
    });
    cx.update(|_, cx| dr_view_element_overview::current(cx).expect("mounted ElementOverview"))
}

fn position_bits(map: &BTreeMap<String, RelatePoint>) -> BTreeMap<String, (u64, u64)> {
    map.iter()
        .map(|(k, p)| (k.clone(), (p.x.to_bits(), p.y.to_bits())))
        .collect()
}

#[gpui::test]
fn default_relate_determinism_mode_memory_and_two_book_isolation(
    cx_a: &mut TestAppContext,
    cx_b: &mut TestAppContext,
) {
    cx_a.executor().allow_parking();
    cx_b.executor().allow_parking();

    let (_dir_a, lib_a, books_a) = setup_seed_fixture(dr_testkit::seed::Preset::Showcase);
    let (_dir_b, lib_b, books_b) = setup_seed_fixture(dr_testkit::seed::Preset::Showcase);
    assert!(
        books_a.len() >= 2,
        "showcase preset carries at least two books"
    );
    assert_eq!(books_a[0], books_b[0]);

    init_test_shell(lib_a.clone(), books_a[0].clone(), cx_a);
    let (shell_a, vcx_a) = cx_a.add_window_view(Workspace::new);
    wait(vcx_a, |cx| {
        shell_a.read_with(cx, |ws, _| ws.book.v3().is_some() && ws.book_memory_ready())
    });
    let ov_a = mount_overview(&shell_a, vcx_a);

    // 1. Default open uses `Relate` (`关系`) and settles non-empty canonical elements + co-occurrences.
    let bits_a = vcx_a.update(|_, cx| {
        let v = ov_a.read(cx);
        assert_eq!(v.layout_mode(), ElementLayoutMode::Relate);
        assert!(!v.elements().is_empty());
        assert!(!v.cooccurrences().mentions.is_empty());
        position_bits(v.relate_positions())
    });

    // 2. Fresh open on an independent identical store yields bitwise-identical settled coordinates.
    init_test_shell(lib_b, books_b[0].clone(), cx_b);
    let (shell_b, vcx_b) = cx_b.add_window_view(Workspace::new);
    wait(vcx_b, |cx| {
        shell_b.read_with(cx, |ws, _| ws.book.v3().is_some() && ws.book_memory_ready())
    });
    let ov_b = mount_overview(&shell_b, vcx_b);
    let bits_b = vcx_b.update(|_, cx| position_bits(ov_b.read(cx).relate_positions()));
    assert_eq!(bits_a, bits_b);

    // 3. The left Tab's Island choice is in local layout and survives a reopen.
    vcx_a.update(|_, cx| {
        let sidebar = shell_a.read(cx).v3_sidebar.clone().unwrap();
        sidebar.update(cx, |v, cx| {
            v.choose_fill_layout(dr_shell::v3::tab_fill::FillLayout::Island, cx);
        });
    });
    vcx_a.update(|window, cx| {
        shell_a.update(cx, |ws, cx| {
            assert!(
                ws.layout()
                    .tab_fill_layouts
                    .values()
                    .any(|layout| *layout == dr_shell::v3::tab_fill::FillLayout::Island)
            );
            ws.store_layout(cx);
            ws.exit_fill(window, cx);
        });
    });
    let ov_a_reopened = mount_overview(&shell_a, vcx_a);
    vcx_a.update(|_, cx| {
        assert_eq!(
            ov_a_reopened.read(cx).layout_mode(),
            ElementLayoutMode::Isles
        )
    });

    // 4. Switching to Book 1 isolates memory: the filled Tab for
    // Book 1 starts in Book 1's default `Relate` with nothing focused. Opening
    // a book exits fill, and the overview kept for Book 0 follows
    // nothing while it is not shown, so Book 1 gets one of its own.
    let book_1 = books_a[1].clone();
    vcx_a.update(|window, cx| {
        ov_a_reopened.update(cx, |v, cx| {
            let first = v.elements()[0].id.clone();
            v.focus_element(Some(first), window, cx);
        });
        shell_a.update(cx, |ws, cx| ws.open_book(&book_1, window, cx));
    });
    wait(vcx_a, |cx| {
        shell_a.read_with(cx, |ws, _| {
            ws.book_id == book_1 && ws.book.v3().is_some() && ws.book_memory_ready()
        })
    });
    let ov_book_1 = mount_overview(&shell_a, vcx_a);
    assert_ne!(ov_book_1, ov_a_reopened);
    vcx_a.update(|_, cx| {
        assert_eq!(ov_book_1.read(cx).layout_mode(), ElementLayoutMode::Relate);
        assert_eq!(ov_book_1.read(cx).focused_element(), None);
    });
}

#[gpui::test]
fn focus_peek_isolate_sheet_entry_page_and_release_barrier(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let (_dir, lib, books) = setup_seed_fixture(dr_testkit::seed::Preset::Tiny);
    let book_id = books[0].clone();

    init_test_shell(lib, book_id, cx);
    let (shell, vcx) = cx.add_window_view(Workspace::new);
    wait(vcx, |cx| {
        shell.read_with(cx, |ws, _| ws.book.v3().is_some() && ws.book_memory_ready())
    });

    let ov = mount_overview(&shell, vcx);
    let target_el = vcx.update(|_, cx| ov.read(cx).elements()[0].id.clone());

    vcx.update(|window, cx| {
        ov.update(cx, |v, cx| {
            v.focus_element(Some(target_el.clone()), window, cx);
            v.toggle_isolated(cx);
        });
    });
    vcx.update(|_, cx| {
        let v = ov.read(cx);
        assert_eq!(v.focused_element(), Some(target_el.as_str()));
        assert_eq!(v.island_mode(), IslandMode::Peek);
        assert!(v.isolated());
        assert!(!v.island_sheet_active());
    });

    // Expand Peek into Sheet mounting real G1 `EntryPage`.
    vcx.update(|window, cx| {
        ov.update(cx, |v, cx| v.grow_island(window, cx));
    });
    wait(vcx, |cx| ov.read_with(cx, |v, _| v.island_sheet_active()));
    vcx.update(|_, cx| {
        assert_eq!(ov.read(cx).island_mode(), IslandMode::Sheet);
        assert!(ov.read(cx).island_sheet_active());
    });

    // Run `dr_shell::library::replace`: `before_release` drops `island_sheet` so no open
    // `DocHandle` blocks replacement, and `after_release` rebinds cleanly.
    let dir_repl = tempfile::tempdir().expect("replacement dir");
    let repl_path = dir_repl.path().to_path_buf();
    let seed_repl = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .expect("seed repl");
    let replaced = std::rc::Rc::new(std::cell::Cell::new(false));
    let replaced_done = replaced.clone();
    vcx.update(|_, cx| {
        dr_shell::library::replace(
            cx,
            move |_, options| {
                let s = dr_store::Library::open(&repl_path, options).map_err(|e| e.to_string())?;
                seed_repl.write_to(&s).map_err(|e| e.to_string())?;
                Ok(s)
            },
            move |res, _| {
                assert!(res.is_ok(), "library replacement failed: {res:?}");
                replaced_done.set(true);
            },
        );
    });
    wait(vcx, |_| replaced.get());
    wait(vcx, |cx| ov.read_with(cx, |v, _| v.is_ready()));
}

#[gpui::test]
fn drag_drop_onto_island_reuses_g2_prepare_drop_and_supports_undo(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let (_dir, lib, books) = setup_seed_fixture(dr_testkit::seed::Preset::Tiny);
    let book_id = books[0].clone();

    init_test_shell(lib.clone(), book_id.clone(), cx);
    let (shell, vcx) = cx.add_window_view(Workspace::new);
    wait(vcx, |cx| {
        shell.read_with(cx, |ws, _| ws.book.v3().is_some() && ws.book_memory_ready())
    });

    // Find the elements root and a level template in canonical v3, then create:
    // 1) an `accept: true` category island (`阵营`), and
    // 2) an `accept: false` resident category island (`器物归档`) with `allow: []`.
    let (elements_root, level_tpl) = vcx.update(|_, cx| {
        let v3 = shell.read(cx).book.v3().expect("v3 book");
        let root_id = v3
            .entries
            .iter()
            .find(|e| {
                e.deleted_at.is_none()
                    && v3
                        .levels
                        .get(&e.id)
                        .is_some_and(|l| l.settings.display == "island")
            })
            .map(|e| e.id.clone())
            .expect("island display root");
        let existing_cat = v3
            .entries
            .iter()
            .find(|e| {
                e.deleted_at.is_none()
                    && e.parent.as_deref() == Some(root_id.as_str())
                    && v3.levels.contains_key(&e.id)
            })
            .expect("category level under island root");
        (Some(root_id), existing_cat.template.clone())
    });

    let accept_level = lib
        .run::<EntryCreate>(
            &Actor::User,
            EntryCreateIn {
                book: book_id.clone(),
                title: "阵营".into(),
                mark: None,
                parent: elements_root.clone(),
                host: None,
                template: level_tpl.clone(),
                level: None,
                bodies: BTreeMap::new(),
            },
        )
        .expect("create accept category")
        .output
        .id;
    let book_snap = dr_shell::book::Book::load(&lib, &book_id).expect("book snap");
    g2_data::prepare_override(&book_snap, &accept_level, "accept", Some(json!(true)))
        .and_then(|m| m.commit(&lib))
        .expect("set accept=true");

    let move_level = lib
        .run::<EntryCreate>(
            &Actor::User,
            EntryCreateIn {
                book: book_id.clone(),
                title: "器物归档".into(),
                mark: None,
                parent: elements_root,
                host: None,
                template: level_tpl,
                level: None,
                bodies: BTreeMap::new(),
            },
        )
        .expect("create move category")
        .output
        .id;
    let book_snap = dr_shell::book::Book::load(&lib, &book_id).expect("book snap");
    g2_data::prepare_override(&book_snap, &move_level, "accept", Some(json!(false)))
        .and_then(|m| m.commit(&lib))
        .expect("set accept=false");

    // A drop onto an island starts with a visible Island card. Relations
    // also contains organising entries that only appear as graph endpoints.
    mount_overview(&shell, vcx);
    vcx.update(|_, cx| {
        let sidebar = shell.read(cx).v3_sidebar.clone().unwrap();
        sidebar.update(cx, |sidebar, cx| {
            sidebar.choose_fill_layout(dr_shell::v3::tab_fill::FillLayout::Island, cx);
        });
    });
    wait(vcx, |cx| {
        cx.update(|_, cx| {
            dr_view_element_overview::current(cx).is_some_and(|view| {
                let view = view.read(cx);
                view.layout_mode() == ElementLayoutMode::Isles && view.is_ready()
            })
        })
    });
    let ov =
        vcx.update(|_, cx| dr_view_element_overview::current(cx).expect("mounted Island view"));
    vcx.update(|_, cx| {
        ov.update(cx, |v, cx| v.sync_workspace_book(cx));
    });
    let (el_id, orig_home) = vcx.update(|_, cx| {
        let el = &ov.read(cx).elements()[0];
        (el.id.clone(), el.home_island_id.clone())
    });

    // 1. Drop with ⌥ onto an island whose category takes entries in and from
    //    elsewhere -> adds membership while preserving `orig_home` (without ⌥
    //    it would move in, kernel-v5 §16 「挂名」).
    let added = vcx.update(|_, cx| {
        ov.update(cx, |v, cx| {
            v.drop_element_onto_island(&el_id, &accept_level, true, cx)
        })
    });
    assert!(added, "drop onto accept:true island should succeed");
    vcx.update(|_, cx| {
        let v = ov.read(cx);
        let el = v
            .elements()
            .iter()
            .find(|e| e.id == el_id)
            .expect("element");
        assert_eq!(el.home_island_id, orig_home, "residence preserved");
        let accept_island = v
            .island_models()
            .iter()
            .find(|m| m.creation_level_id.as_deref() == Some(accept_level.as_str()))
            .expect("accept island");
        assert!(
            accept_island
                .groups
                .iter()
                .any(|g| g.items.iter().any(|i| i.id == el_id)),
            "accepted island lists dropped member"
        );
    });

    // Undo reverts membership cleanly.
    assert!(lib.undo(&Actor::User).expect("undo membership").is_some());
    vcx.update(|_, cx| {
        ov.update(cx, |v, cx| v.sync_workspace_book(cx));
    });

    // 2. Drop onto `accept: false` category -> moves residence, and `undo` restores `orig_home`.
    let moved = vcx.update(|_, cx| {
        ov.update(cx, |v, cx| {
            v.drop_element_onto_island(&el_id, &move_level, false, cx)
        })
    });
    assert!(
        moved,
        "drop onto accept:false category should move residence"
    );
    vcx.update(|_, cx| {
        let v = ov.read(cx);
        let el = v
            .elements()
            .iter()
            .find(|e| e.id == el_id)
            .expect("element");
        assert_eq!(el.home_island_id, move_level);
    });
    assert!(lib.undo(&Actor::User).expect("undo move").is_some());
    vcx.update(|_, cx| {
        ov.update(cx, |v, cx| v.sync_workspace_book(cx));
        let v = ov.read(cx);
        let el = v
            .elements()
            .iter()
            .find(|e| e.id == el_id)
            .expect("element");
        assert_eq!(el.home_island_id, orig_home);
    });
}

#[gpui::test]
fn pin_and_unpin_preserve_board_and_grid_and_survive_relayout(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let (_dir, lib, books) = setup_seed_fixture(dr_testkit::seed::Preset::Tiny);
    let book_id = books[0].clone();

    init_test_shell(lib.clone(), book_id.clone(), cx);
    let (shell, vcx) = cx.add_window_view(Workspace::new);
    wait(vcx, |cx| {
        shell.read_with(cx, |ws, _| ws.book.v3().is_some() && ws.book_memory_ready())
    });

    let ov = mount_overview(&shell, vcx);
    let el_id = vcx.update(|_, cx| ov.read(cx).elements()[0].id.clone());

    // Pre-seed `board` and `grid` layout coordinates on the same entry.
    let el_scope = vcx.update(|_, cx| {
        let book = shell.read(cx).book.clone();
        let scope = book
            .v3()
            .and_then(|v| v.entry(&el_id))
            .and_then(|e| e.parent.clone())
            .unwrap_or_else(|| "root".to_owned());
        lib.call(
            &Actor::User,
            "layout.put",
            json!({ "book": book_id, "scope": scope, "mode": "board", "positions": { &el_id: [42.5, -18.0] } }),
        )
        .expect("seed board");
        lib.call(
            &Actor::User,
            "layout.put",
            json!({ "book": book_id, "scope": scope, "mode": "grid", "positions": { &el_id: [3.0, 7.0] } }),
        )
        .expect("seed grid");
        scope
    });
    vcx.update(|_, cx| {
        ov.update(cx, |v, cx| v.sync_workspace_book(cx));
    });

    // Pin in `Relate`: writes `root/relation_graph` while preserving `board` and `grid`.
    vcx.update(|_, cx| {
        ov.update(cx, |v, cx| {
            v.pin_element_in_relate(&el_id, RelatePoint::new(312.4, -148.6), cx);
        });
    });

    let after_pin = dr_shell::book::Book::load(&lib, &book_id).expect("load book");
    let after_pin_v3 = after_pin.v3().expect("v3");
    assert_eq!(
        after_pin_v3.layout_position(&el_scope, "board", &el_id),
        Some((42.5, -18.0))
    );
    assert_eq!(
        after_pin_v3.layout_position(&el_scope, "grid", &el_id),
        Some((3.0, 7.0))
    );
    assert_eq!(
        after_pin_v3.layout_position("root", "relation_graph", &el_id),
        Some((312.4, -148.6))
    );

    // `relayout_relate` keeps author-pinned element fixed at `(312.4, -148.6)`.
    vcx.update(|_, cx| {
        ov.update(cx, |v, cx| v.relayout_relate(cx));
        let pos = ov.read(cx).relate_positions()[&el_id];
        assert_eq!((pos.x, pos.y), (312.4, -148.6));
    });

    // `unpin_element_in_relate` clears `root/relation_graph` while keeping `board` and `grid` intact.
    vcx.update(|_, cx| {
        ov.update(cx, |v, cx| v.unpin_element_in_relate(&el_id, cx));
    });
    let after_unpin = dr_shell::book::Book::load(&lib, &book_id).expect("load book");
    let after_unpin_v3 = after_unpin.v3().expect("v3");
    assert_eq!(
        after_unpin_v3.layout_position(&el_scope, "board", &el_id),
        Some((42.5, -18.0))
    );
    assert_eq!(
        after_unpin_v3.layout_position(&el_scope, "grid", &el_id),
        Some((3.0, 7.0))
    );
    assert_eq!(
        after_unpin_v3.layout_position("root", "relation_graph", &el_id),
        None
    );
}

#[gpui::test]
fn graph_expands_a_relation_row_to_one_edge_per_pair(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let (_dir, lib, books) = setup_seed_fixture(dr_testkit::seed::Preset::Tiny);
    let book_id = books[0].clone();
    let entries =
        dr_testkit::seed::acceptance::entries_by_template(&lib, &book_id, "tpl-character");
    let [a, b, c] = [0, 1, 2].map(|n| entries[n]["id"].as_str().unwrap().to_owned());
    let call =
        |name, input| lib.call(&dr_workspace::Actor::User, name, input).unwrap()["output"].clone();
    let made = call(
        "relation_row.create_pair",
        serde_json::json!({
            "book":book_id,"left":a,"right":b,"new_type":{"name":"同盟契约","direction":"symmetric"},
        }),
    );
    call(
        "relation_row.add_entry",
        serde_json::json!({"book":book_id,"id":made["id"],"side":"right","entry":c}),
    );
    init_test_shell(lib, book_id, cx);
    let (shell, vcx) = cx.add_window_view(Workspace::new);
    wait(vcx, |cx| {
        shell.read_with(cx, |ws, _| ws.book.v3().is_some() && ws.book_memory_ready())
    });
    let ov = mount_overview(&shell, vcx);
    vcx.update(|_, cx| {
        let v = ov.read(cx);
        let pairs: Vec<_> = v
            .relations()
            .iter()
            .filter(|r| r.relation_type == made["relation_type"].as_str().unwrap())
            .map(|r| {
                assert!(!r.directed);
                (r.from.as_str(), r.to.as_str())
            })
            .collect();
        assert_eq!(pairs.len(), 2);
        assert!(pairs.contains(&(a.as_str(), b.as_str())));
        assert!(pairs.contains(&(a.as_str(), c.as_str())));
    });
    vcx.update(|_, cx| {
        ov.update(cx, |v, cx| {
            v.toggle_relation_type(made["relation_type"].as_str().unwrap(), cx)
        })
    });
}

/// A Tab keeps its canvas while fill is closed. A kept canvas
/// that is not on screen does not follow the book: nothing is read again for
/// it until the filled Tab shows it, and then it catches up in one step.
#[gpui::test]
fn a_closed_overview_does_not_follow_the_book_and_catches_up_when_shown(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let (_dir, lib, books) = setup_seed_fixture(dr_testkit::seed::Preset::Lite);
    let book_id = books[0].clone();

    init_test_shell(lib.clone(), book_id.clone(), cx);
    let (shell, vcx) = cx.add_window_view(Workspace::new);
    wait(vcx, |cx| {
        shell.read_with(cx, |ws, _| ws.book.v3().is_some() && ws.book_memory_ready())
    });
    let ov = mount_overview(&shell, vcx);

    // An element as the overview shows it, to make a sibling of.
    let (count, parent, template) = vcx.update(|_, cx| {
        let v = ov.read(cx);
        let shown = v.elements()[0].id.clone();
        let v3 = shell.read(cx).book.v3().expect("v3 book");
        let entry = v3
            .entries
            .iter()
            .find(|e| e.id == shown)
            .expect("shown element");
        (
            v.elements().len(),
            entry.parent.clone(),
            entry.template.clone(),
        )
    });

    vcx.update(|window, cx| {
        shell.update(cx, |ws, cx| ws.exit_fill(window, cx));
    });
    vcx.run_until_parked();

    let added = lib
        .run::<EntryCreate>(
            &Actor::User,
            EntryCreateIn {
                book: book_id,
                title: "离屏时新建的要素".into(),
                mark: None,
                parent,
                host: None,
                template,
                level: None,
                bodies: BTreeMap::new(),
            },
        )
        .expect("create an element while fill is closed")
        .output
        .id;

    // The shell has the new book; the closed overview still holds the old one.
    wait(vcx, |cx| {
        shell.read_with(cx, |ws, _| {
            ws.book
                .v3()
                .is_some_and(|v3| v3.entries.iter().any(|e| e.id == added))
        })
    });
    vcx.run_until_parked();
    vcx.update(|_, cx| {
        let v = ov.read(cx);
        assert_eq!(v.elements().len(), count);
        assert!(v.elements().iter().all(|e| e.id != added));
    });

    // Shown again, the same overview reads the book once and has it.
    let reopened = mount_overview(&shell, vcx);
    assert_eq!(reopened, ov);
    wait(vcx, |cx| {
        ov.read_with(cx, |v, _| v.elements().iter().any(|e| e.id == added))
    });
    vcx.update(|_, cx| assert_eq!(ov.read(cx).elements().len(), count + 1));
}

#[gpui::test]
#[ignore = "release reference benchmark over Preset::Heavy (~300 elements, ~1.65M chars)"]
fn heavy_seed_reference_timings(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let (_dir, lib, books) = setup_seed_fixture(dr_testkit::seed::Preset::Heavy);
    let book_id = books[0].clone();

    init_test_shell(lib, book_id, cx);
    let (shell, vcx) = cx.add_window_view(Workspace::new);
    wait(vcx, |cx| {
        shell.read_with(cx, |ws, _| ws.book.v3().is_some() && ws.book_memory_ready())
    });

    let t_open = Instant::now();
    let ov = mount_overview(&shell, vcx);
    let open_ms = t_open.elapsed().as_secs_f64() * 1000.0;
    let t_frame = Instant::now();
    vcx.update(|window, cx| window.draw(cx).clear(cx));
    let first_frame_ms = t_frame.elapsed().as_secs_f64() * 1000.0;

    let (el_count, pair_count, first_id) = vcx.update(|_, cx| {
        let v = ov.read(cx);
        (
            v.elements().len(),
            v.cooccurrences().pairs.len(),
            v.elements()[0].id.clone(),
        )
    });

    let mut frame_ms = Vec::with_capacity(20);
    for step in 0..20 {
        let t_f = Instant::now();
        vcx.update(|window, cx| {
            ov.update(cx, |v, cx| {
                v.set_zoom(0.75 + (step as f32) * 0.02, cx);
            });
            window.draw(cx).clear(cx);
        });
        frame_ms.push(t_f.elapsed().as_secs_f64() * 1000.0);
    }
    frame_ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let p50_draw_ms = frame_ms[frame_ms.len() / 2];
    let p95_draw_ms = frame_ms[(frame_ms.len() * 95) / 100];

    let t_pin = Instant::now();
    vcx.update(|_, cx| {
        ov.update(cx, |v, cx| {
            v.pin_element_in_relate(&first_id, RelatePoint::new(220.0, -90.0), cx);
        });
    });
    let pin_settle_ms = t_pin.elapsed().as_secs_f64() * 1000.0;

    eprintln!(
        "[m22-heavy-reference] elements={el_count} cooccurrence_pairs={pair_count} first_frame_ms={first_frame_ms:.2} open_first_frame_ms={open_ms:.2} draw_p50_ms={p50_draw_ms:.2} draw_p95_ms={p95_draw_ms:.2} pin_reheat_settle_ms={pin_settle_ms:.2}"
    );
}

#[gpui::test]
fn shift_pair_reuses_the_named_row_and_duplicate_adds_no_undo_step(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let (_dir, lib, books) = setup_seed_fixture(dr_testkit::seed::Preset::Tiny);
    let book = books[0].clone();
    let entries = dr_testkit::seed::acceptance::entries_by_template(&lib, &book, "tpl-character");
    let [a, b, c] = [0, 1, 2].map(|i| entries[i]["id"].as_str().unwrap().to_owned());
    let original = lib.call(&Actor::User, "relation_row.create_pair", json!({
        "book":book,"left":a,"right":b,"new_type":{"name":"Graph Mentor","direction":"directed"}
    })).unwrap()["output"].clone();
    init_test_shell(lib.clone(), book.clone(), cx);
    let (shell, vcx) = cx.add_window_view(Workspace::new);
    wait(vcx, |cx| {
        shell.read_with(cx, |ws, _| ws.book.v3().is_some() && ws.book_memory_ready())
    });
    let ov = mount_overview(&shell, vcx);
    // A mouse test must wait for fill to finish: during the opening animation
    // graph cells can be laid out beyond the moving viewport's clipping edge.
    wait(vcx, |cx| {
        shell.read_with(cx, |ws, _| ws.fill_progress(FillPlace::Left) >= 1.0)
    });
    vcx.update(|_, cx| ov.update(cx, |v, cx| v.reset_view(cx)));
    for _ in 0..2 {
        for id in [&a, &c] {
            let selector: &'static str = Box::leak(format!("se-relate-card-{id}").into_boxed_str());
            wait(vcx, |cx| cx.debug_bounds(selector).is_some());
            let at = vcx.debug_bounds(selector).unwrap().center();
            let modifiers = gpui::Modifiers {
                shift: true,
                ..Default::default()
            };
            vcx.simulate_mouse_move(at, None, modifiers);
            vcx.simulate_click(at, modifiers);
        }
        let row = vcx.update(|window, cx| {
            ov.update(cx, |v, cx| {
                assert_eq!(v.relation_draft().unwrap().target, c);
                v.set_relation_name("  graph mentor  ", cx);
                v.cycle_relation_direction(cx);
                v.cycle_relation_direction(cx);
                assert_eq!(
                    v.relation_draft().unwrap().direction,
                    dr_view_element_overview::view::PairDirection::Forward
                );
                v.confirm_relation(window, cx).expect("pair committed")
            })
        });
        assert_eq!(row, original["id"].as_str().unwrap());
    }
    let read = || {
        lib.call(&Actor::User, "relation_type.list", json!({"book":book}))
            .unwrap()["output"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == original["relation_type"])
            .unwrap()
            .clone()
    };
    assert_eq!(read()["rows"][0]["right"].as_array().unwrap().len(), 2);
    lib.undo(&Actor::User)
        .unwrap()
        .expect("one added pair to undo");
    assert_eq!(read()["rows"][0]["right"], json!([b]));
}

#[gpui::test]
fn shift_pair_button_direction_enter_does_not_submit_and_failed_write_keeps_draft(
    cx: &mut TestAppContext,
) {
    use dr_view_element_overview::view::PairDirection;
    cx.executor().allow_parking();
    let (_dir, lib, books) = setup_seed_fixture(dr_testkit::seed::Preset::Tiny);
    let book = books[0].clone();
    let entries = dr_testkit::seed::acceptance::entries_by_template(&lib, &book, "tpl-character");
    let [a, b] = [0, 1].map(|i| entries[i]["id"].as_str().unwrap().to_owned());
    init_test_shell(lib.clone(), book.clone(), cx);
    let (shell, vcx) = cx.add_window_view(Workspace::new);
    wait(vcx, |cx| {
        shell.read_with(cx, |ws, _| ws.book.v3().is_some() && ws.book_memory_ready())
    });
    let ov = mount_overview(&shell, vcx);
    let begin = |vcx: &mut VisualTestContext| {
        vcx.update(|window, cx| {
            ov.update(cx, |v, cx| {
                v.click_entity("entry", &a, true, window, cx);
                v.click_entity("entry", &a, true, window, cx);
                assert!(v.relation_draft().is_none(), "self-pair never opens");
                v.click_entity("entry", &b, true, window, cx);
            })
        })
    };
    begin(vcx);
    vcx.simulate_keystrokes("escape");
    assert!(ov.read_with(vcx, |v, _| v.relation_draft().is_none()));
    assert!(
        shell.read_with(vcx, |ws, _| ws.is_filled(FillPlace::Left)),
        "Esc closes the draft before exiting fill"
    );
    begin(vcx);
    vcx.update(|window, cx| {
        ov.update(cx, |v, cx| {
            assert!(
                v.confirm_relation(window, cx).is_none(),
                "a name is required"
            );
            v.set_relation_name("Graph Reversed", cx);
            v.cycle_relation_direction(cx);
            assert_eq!(
                v.relation_draft().unwrap().direction,
                PairDirection::Reverse
            );
        })
    });
    vcx.simulate_keystrokes("enter");
    assert!(
        ov.read_with(vcx, |v, _| v.relation_draft().is_some()),
        "Enter has no approved create action; the draft stays open"
    );
    let list = || {
        lib.call(&Actor::User, "relation_type.list", json!({"book":book}))
            .unwrap()["output"]
            .as_array()
            .unwrap()
            .clone()
    };
    assert!(
        !list().iter().any(|r| r["name"] == "Graph Reversed"),
        "Enter must not save a relation"
    );
    wait(vcx, |cx| {
        shell.read_with(cx, |ws, _| ws.fill_progress(FillPlace::Left) >= 1.0)
    });
    wait(vcx, |cx| cx.debug_bounds("se-relation-create").is_some());
    let at = vcx.debug_bounds("se-relation-create").unwrap().center();
    vcx.simulate_mouse_move(at, None, gpui::Modifiers::default());
    vcx.simulate_click(at, gpui::Modifiers::default());
    wait(vcx, |cx| {
        ov.read_with(cx, |v, _| v.relation_draft().is_none())
    });
    let rows = list();
    let made = rows.iter().find(|r| r["name"] == "Graph Reversed").unwrap();
    assert_eq!(made["direction"], "directed");
    assert_eq!(made["rows"][0]["left"], json!([b]));
    assert_eq!(made["rows"][0]["right"], json!([a]));
    lib.undo(&Actor::User)
        .unwrap()
        .expect("one edit creates both name and pair");
    assert!(!list().iter().any(|r| r["name"] == "Graph Reversed"));
    begin(vcx);
    vcx.update(|window, cx| {
        ov.update(cx, |v, cx| {
            v.set_relation_name("Graph Symmetric", cx);
            v.cycle_relation_direction(cx);
            v.cycle_relation_direction(cx);
            assert_eq!(v.relation_draft().unwrap().direction, PairDirection::Both);
            v.confirm_relation(window, cx)
                .expect("new symmetric relation");
        })
    });
    assert_eq!(
        list()
            .iter()
            .find(|r| r["name"] == "Graph Symmetric")
            .unwrap()["direction"],
        "symmetric"
    );
    lib.undo(&Actor::User)
        .unwrap()
        .expect("undo symmetric relation in one step");
    assert!(!list().iter().any(|r| r["name"] == "Graph Symmetric"));
    begin(vcx);
    vcx.update(|_, cx| ov.update(cx, |v, cx| v.set_relation_name("Graph Failed", cx)));
    lib.call(&Actor::User, "entry.trash", json!({"book":book,"id":b}))
        .unwrap();
    // Deliberately keep the UI snapshot: the command must reject a now-deleted endpoint.
    vcx.update(|window, cx| {
        ov.update(cx, |v, cx| {
            assert!(v.confirm_relation(window, cx).is_none());
            assert!(v.relation_error());
            assert_eq!(v.relation_draft().unwrap().name, "Graph Failed");
            assert_eq!(v.relation_draft().unwrap().target, b);
        })
    });
}

#[gpui::test]
fn symmetric_reuse_locks_direction_and_peek_excludes_same_side_members(cx: &mut TestAppContext) {
    use dr_view_element_overview::view::PairDirection;
    cx.executor().allow_parking();
    let (_dir, lib, books) = setup_seed_fixture(dr_testkit::seed::Preset::Tiny);
    let book = books[0].clone();
    let entries = dr_testkit::seed::acceptance::entries_by_template(&lib, &book, "tpl-character");
    let [a, b, c] = [0, 1, 2].map(|i| entries[i]["id"].as_str().unwrap().to_owned());
    let made = lib
        .call(
            &Actor::User,
            "relation_row.create_pair",
            json!({"book":book,"left":a,"right":b,
        "new_type":{"name":"Graph Allies","direction":"symmetric"}}),
        )
        .unwrap()["output"]
        .clone();
    lib.call(
        &Actor::User,
        "relation_row.add_entry",
        json!({"book":book,"id":made["id"],"side":"right","entry":c}),
    )
    .unwrap();
    init_test_shell(lib, book, cx);
    let (shell, vcx) = cx.add_window_view(Workspace::new);
    wait(vcx, |cx| {
        shell.read_with(cx, |ws, _| ws.book.v3().is_some() && ws.book_memory_ready())
    });
    let ov = mount_overview(&shell, vcx);
    vcx.update(|window, cx| {
        ov.update(cx, |v, cx| {
            let peers = v.peek_relations(&b);
            let own: Vec<_> = peers
                .iter()
                .filter(|r| r.relation == made["relation_type"].as_str().unwrap())
                .collect();
            assert_eq!(own.len(), 1);
            assert_eq!(own[0].other, a);
            assert_eq!(own[0].name, "Graph Allies");
            assert_eq!(own[0].direction, PairDirection::Both);
            v.click_entity("entry", &b, true, window, cx);
            v.click_entity("entry", &a, true, window, cx);
            v.set_relation_name("Graph Allies", cx);
            v.cycle_relation_direction(cx);
            assert_eq!(v.relation_draft().unwrap().direction, PairDirection::Both);
            assert_eq!(
                v.confirm_relation(window, cx).unwrap(),
                made["id"].as_str().unwrap()
            );
            v.focus_element(Some(b.clone()), window, cx);
        })
    });
    wait(vcx, |cx| cx.debug_bounds("se-peek-relations").is_some());
}

/// Inspect the actual canvas paint after direction, zoom and pan. Merely
/// checking GraphRelation::directed would miss an omitted arrow draw call.
#[gpui::test]
fn directed_graph_arrows_are_painted_towards_both_targets_after_zoom_and_pan(
    cx: &mut TestAppContext,
) {
    use gpui::{Modifiers, MouseButton, ScrollDelta, ScrollEvent, point, px};
    cx.executor().allow_parking();
    let (_dir, lib, books) = setup_seed_fixture(dr_testkit::seed::Preset::Tiny);
    let book = books[0].clone();
    let entries = dr_testkit::seed::acceptance::entries_by_template(&lib, &book, "tpl-character");
    let mut pair = [0, 1].map(|i| entries[i]["id"].as_str().unwrap().to_owned());
    pair.sort();
    let [a, b] = pair;
    let a_selector: &'static str = Box::leak(format!("se-relate-card-{a}").into_boxed_str());
    let b_selector: &'static str = Box::leak(format!("se-relate-card-{b}").into_boxed_str());
    let create =
        |name, left: &str, right: &str, direction| {
            lib.call(&Actor::User, "relation_row.create_pair", json!({
            "book":book,"left":left,"right":right,"new_type":{"name":name,"direction":direction}
        })).unwrap()["output"]["relation_type"].as_str().unwrap().to_owned()
        };
    let forward = create("Graph Arrow Forward", &a, &b, "directed");
    let reverse = create("Graph Arrow Reverse", &b, &a, "directed");
    let symmetric = create("Graph Arrow Symmetric", &a, &b, "symmetric");
    init_test_shell(lib, book, cx);
    let (shell, vcx) = cx.add_window_view(Workspace::new);
    wait(vcx, |cx| {
        shell.read_with(cx, |ws, _| ws.book.v3().is_some() && ws.book_memory_ready())
    });
    let ov = mount_overview(&shell, vcx);
    wait(vcx, |cx| {
        shell.read_with(cx, |ws, _| ws.fill_progress(FillPlace::Left) >= 1.0)
    });
    vcx.update(|_, cx| {
        ov.update(cx, |v, cx| {
            v.pin_element_in_relate(&a, RelatePoint::new(-120.0, 0.0), cx);
            v.pin_element_in_relate(&b, RelatePoint::new(120.0, 0.0), cx);
            v.reset_view(cx);
        })
    });
    let assert_frame = |vcx: &mut VisualTestContext| {
        wait(vcx, |cx| {
            cx.debug_bounds(a_selector).is_some() && cx.debug_bounds(b_selector).is_some()
        });
        let arrows = ov.read_with(vcx, |v, _| v.painted_relation_arrows());
        assert!(
            !arrows.iter().any(|x| x.relation_type == symmetric),
            "symmetric relation has no painted arrow"
        );
        let viewport = vcx.debug_bounds("se-viewport").unwrap();
        let ink = vcx.update(|window, cx| dr_ui::Theme::of(window, cx).palette.ink(2));
        let mut tips = Vec::new();
        for (relation, from, to) in [(&forward, &a, &b), (&reverse, &b, &a)] {
            let found: Vec<_> = arrows
                .iter()
                .filter(|x| &x.relation_type == relation)
                .collect();
            assert_eq!(
                found.len(),
                1,
                "exactly one arrow actually painted for this directed pair"
            );
            let arrow = found[0];
            assert_eq!((&arrow.from, &arrow.to), (from, to));
            assert_eq!(arrow.color, ink, "arrow uses the relation line's ink");
            let target = vcx
                .debug_bounds(if to == &a { a_selector } else { b_selector })
                .unwrap();
            let center = target.center();
            assert!(
                viewport.contains(&arrow.tip),
                "arrow is in the visible graph viewport"
            );
            assert!(
                !target.contains(&arrow.tip),
                "tip is outside the target card, not hidden beneath it"
            );
            let gap_x = (f32::from(arrow.tip.x - center.x).abs()
                - f32::from(target.size.width) * 0.5)
                .max(0.0);
            let gap_y = (f32::from(arrow.tip.y - center.y).abs()
                - f32::from(target.size.height) * 0.5)
                .max(0.0);
            assert!(
                gap_x.max(gap_y) < 2.05,
                "arrow hugs the target card boundary: {gap_x}, {gap_y}"
            );
            let back = point(
                (arrow.wings[0].x + arrow.wings[1].x) * 0.5,
                (arrow.wings[0].y + arrow.wings[1].y) * 0.5,
            );
            let dot = f32::from(center.x - arrow.tip.x) * f32::from(arrow.tip.x - back.x)
                + f32::from(center.y - arrow.tip.y) * f32::from(arrow.tip.y - back.y);
            assert!(
                dot > 0.0,
                "triangle points at the target, regardless of sorted curve direction"
            );
            let length = f32::from(arrow.tip.x - back.x).hypot(f32::from(arrow.tip.y - back.y));
            let width = f32::from(arrow.wings[0].x - arrow.wings[1].x)
                .hypot(f32::from(arrow.wings[0].y - arrow.wings[1].y));
            assert!(
                (length - 9.0).abs() < 0.01 && (width - 8.0).abs() < 0.01,
                "9 x 8 screen pixel arrow stays readable when zoomed"
            );
            tips.push(arrow.tip);
        }
        tips
    };
    let first = assert_frame(vcx);
    vcx.update(|_, cx| ov.update(cx, |v, cx| v.set_zoom(v.zoom() * 0.7, cx)));
    vcx.update(|window, cx| window.draw(cx).clear(cx));
    let zoomed = assert_frame(vcx);
    assert_ne!(first, zoomed, "arrow follows the scaled target");
    let viewport = vcx.debug_bounds("se-viewport").unwrap();
    let at = point(viewport.left() + px(8.0), viewport.bottom() - px(8.0));
    vcx.simulate_mouse_move(at, None::<MouseButton>, Modifiers::default());
    vcx.simulate_event(ScrollEvent {
        position: at,
        delta: ScrollDelta::Pixels(point(px(25.0), px(15.0))),
        ..Default::default()
    });
    vcx.update(|window, cx| window.draw(cx).clear(cx));
    let panned = assert_frame(vcx);
    for (before, after) in zoomed.iter().zip(panned.iter()) {
        assert!((f32::from(after.x - before.x) - 25.0).abs() < 0.01);
        assert!((f32::from(after.y - before.y) - 15.0).abs() < 0.01);
    }
}
