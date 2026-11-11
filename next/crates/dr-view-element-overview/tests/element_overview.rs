use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use dr_model::v3::EntryLayout;
use dr_shell::{Services, SettingsFile, ShellInfo, Workspace, workspace::SuperView};
use dr_ui::Appearance;
use dr_view_element_overview::{
    ElementLayoutMode, ElementOverview, IslandMode, MEMORY_KEY, RelatePoint, parse_overview_memory,
};
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
    cx.update(|_, cx| {
        shell.update(cx, |ws, cx| {
            ws.super_view = Some(SuperView::Elements);
            cx.notify();
        });
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

    // 3. Switching to `Isles` (`群岛`) persists in `Workspace::book_memory` and restores on reopen.
    vcx_a.update(|window, cx| {
        ov_a.update(cx, |v, cx| {
            v.set_layout_mode(ElementLayoutMode::Isles, window, cx);
        });
    });
    wait(vcx_a, |cx| {
        shell_a.read_with(cx, |ws, _| {
            parse_overview_memory(ws.book_memory(MEMORY_KEY)).mode == ElementLayoutMode::Isles
        })
    });

    // Close SuperView::Elements and reopen a fresh instance on Book 0: restores `Isles`.
    vcx_a.update(|_, cx| {
        shell_a.update(cx, |ws, cx| {
            ws.super_view = None;
            cx.notify();
        });
    });
    vcx_a.run_until_parked();
    let ov_a_reopened = mount_overview(&shell_a, vcx_a);
    vcx_a.update(|_, cx| {
        assert_eq!(
            ov_a_reopened.read(cx).layout_mode(),
            ElementLayoutMode::Isles
        );
    });

    // 4. Switching to Book 1 isolates memory and resets mode to Book 1's default `Relate`.
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
        }) && ov_a_reopened.read_with(cx, |v, _| v.is_ready())
    });
    vcx_a.update(|_, cx| {
        assert_eq!(
            ov_a_reopened.read(cx).layout_mode(),
            ElementLayoutMode::Relate
        );
        assert_eq!(ov_a_reopened.read(cx).focused_element(), None);
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
                parent: elements_root.clone(),
                template: level_tpl.clone(),
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
    let book_snap = dr_shell::book::Book::load(&lib, &book_id).expect("book snap");
    g2_data::prepare_override(&book_snap, &accept_level, "allow", Some(json!([])))
        .and_then(|m| m.commit(&lib))
        .expect("set allow=[] on accept_level");

    let move_level = lib
        .run::<EntryCreate>(
            &Actor::User,
            EntryCreateIn {
                book: book_id.clone(),
                title: "器物归档".into(),
                parent: elements_root,
                template: level_tpl,
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
    let book_snap = dr_shell::book::Book::load(&lib, &book_id).expect("book snap");
    g2_data::prepare_override(&book_snap, &move_level, "allow", Some(json!([])))
        .and_then(|m| m.commit(&lib))
        .expect("set allow=[]");

    let ov = mount_overview(&shell, vcx);
    vcx.update(|_, cx| {
        ov.update(cx, |v, cx| v.sync_workspace_book(cx));
    });
    let (el_id, orig_home) = vcx.update(|_, cx| {
        let el = &ov.read(cx).elements()[0];
        (el.id.clone(), el.home_island_id.clone())
    });

    // 1. Drop onto `accept: true` island -> adds membership while preserving `orig_home`.
    let added = vcx.update(|_, cx| {
        ov.update(cx, |v, cx| {
            v.drop_element_onto_island(&el_id, &accept_level, cx)
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
            v.drop_element_onto_island(&el_id, &move_level, cx)
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
    vcx.update(|_, cx| {
        let book = shell.read(cx).book.clone();
        let seed_layout = EntryLayout {
            board: Some((42.5, -18.0)),
            grid: Some((3, 7)),
            relation_graph: None,
        };
        g2_data::prepare_edit(&book, &el_id, json!({ "layout": seed_layout }))
            .and_then(|m| m.commit(&lib))
            .expect("seed board and grid");
    });
    vcx.update(|_, cx| {
        ov.update(cx, |v, cx| v.sync_workspace_book(cx));
    });

    // Pin in `Relate`: writes `relation_graph` while preserving `board` and `grid`.
    vcx.update(|_, cx| {
        ov.update(cx, |v, cx| {
            v.pin_element_in_relate(&el_id, RelatePoint::new(312.4, -148.6), cx);
        });
    });

    let after_pin = dr_shell::book::Book::load(&lib, &book_id)
        .expect("load book")
        .v3()
        .and_then(|v| v.entry(&el_id))
        .expect("entry")
        .layout;
    assert_eq!(after_pin.board, Some((42.5, -18.0)));
    assert_eq!(after_pin.grid, Some((3, 7)));
    assert_eq!(after_pin.relation_graph, Some((312.4, -148.6)));

    // `relayout_relate` keeps author-pinned element fixed at `(312.4, -148.6)`.
    vcx.update(|_, cx| {
        ov.update(cx, |v, cx| v.relayout_relate(cx));
        let pos = ov.read(cx).relate_positions()[&el_id];
        assert_eq!((pos.x, pos.y), (312.4, -148.6));
    });

    // `unpin_element_in_relate` clears `relation_graph` while keeping `board` and `grid` intact.
    vcx.update(|_, cx| {
        ov.update(cx, |v, cx| v.unpin_element_in_relate(&el_id, cx));
    });
    let after_unpin = dr_shell::book::Book::load(&lib, &book_id)
        .expect("load book")
        .v3()
        .and_then(|v| v.entry(&el_id))
        .expect("entry")
        .layout;
    assert_eq!(after_unpin.board, Some((42.5, -18.0)));
    assert_eq!(after_unpin.grid, Some((3, 7)));
    assert_eq!(after_unpin.relation_graph, None);
}

#[gpui::test]
fn shift_click_relation_create_legend_filter_and_delete(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let (_dir, lib, books) = setup_seed_fixture(dr_testkit::seed::Preset::Tiny);
    let book_id = books[0].clone();

    init_test_shell(lib, book_id, cx);
    let (shell, vcx) = cx.add_window_view(Workspace::new);
    wait(vcx, |cx| {
        shell.read_with(cx, |ws, _| ws.book.v3().is_some() && ws.book_memory_ready())
    });

    let ov = mount_overview(&shell, vcx);
    let (el_a, el_b, initial_rel_count) = vcx.update(|_, cx| {
        let v = ov.read(cx);
        assert!(v.elements().len() >= 2);
        (
            v.elements()[0].id.clone(),
            v.elements()[1].id.clone(),
            v.relations().len(),
        )
    });

    // Shift-click A then Shift-click B to open `pending_link`, create a dedicated relation type,
    // and confirm the canonical v3 relation.
    let (created_type_id, created_rel_id) = vcx.update(|window, cx| {
        ov.update(cx, |v, cx| {
            v.click_entity("entry", &el_a, true, window, cx);
            v.click_entity("entry", &el_b, true, window, cx);
            let tid = v
                .create_relation_type("同盟契约", true, "主导方", "响应方", cx)
                .expect("create relation type");
            let rid = v
                .confirm_pending_link(cx)
                .expect("confirm canonical v3 relation");
            (tid, rid)
        })
    });

    vcx.update(|_, cx| {
        let v = ov.read(cx);
        assert_eq!(v.relations().len(), initial_rel_count + 1);
        assert!(v.relations().iter().any(|r| r.id == created_rel_id));
    });

    // Toggle legend visibility for the type, then delete the relation and unused custom type.
    vcx.update(|_, cx| {
        ov.update(cx, |v, cx| {
            v.toggle_relation_type(&created_type_id, cx);
            v.toggle_relation_type(&created_type_id, cx);
            assert!(v.delete_relation(&created_rel_id, cx));
            assert!(v.delete_relation_type(&created_type_id, cx));
        });
    });
    vcx.update(|_, cx| {
        assert_eq!(ov.read(cx).relations().len(), initial_rel_count);
    });
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
    vcx.update(|window, cx| {
        shell.update(cx, |ws, cx| {
            ws.super_view = Some(SuperView::Elements);
            cx.notify();
        });
        window.draw(cx).clear(cx);
    });
    let first_frame_ms = t_open.elapsed().as_secs_f64() * 1000.0;
    wait(vcx, |cx| {
        cx.update(|_, cx| {
            dr_view_element_overview::current(cx).is_some_and(|ov| ov.read(cx).is_ready())
        })
    });
    let open_ms = t_open.elapsed().as_secs_f64() * 1000.0;
    let ov =
        vcx.update(|_, cx| dr_view_element_overview::current(cx).expect("mounted ElementOverview"));

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
