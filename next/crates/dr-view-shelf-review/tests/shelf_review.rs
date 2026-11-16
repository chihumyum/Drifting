use std::time::{Duration, Instant};

use dr_shell::{
    Services, SettingsFile, ShellInfo, Workspace, book::MaterialInfo, pages::SuperViewHost,
    workspace::SuperView,
};
use dr_ui::Appearance;
use dr_view_shelf_review::{
    MEMORY_KEY, Rail, ShelfMemory, ShelfReviewView,
    model::{
        DRAWER_MIN_HEIGHT, LIBRARY_MIN_WIDTH, RAIL_DEFAULT_WIDTH, RAIL_MIN_WIDTH,
        clamp_drawer_height, drag_rail_width, matches_material,
    },
};
use dr_workspace::{
    Actor, Workspace as Library, WorkspaceOptions,
    commands::v3::comment::{CommentCreate, CommentCreateIn},
};
use gpui::{AppContext as _, Entity, TestAppContext, VisualTestContext};

fn wait(cx: &mut VisualTestContext, done: impl Fn(&mut VisualTestContext) -> bool) {
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        cx.run_until_parked();
        cx.update(|window, cx| window.draw(cx).clear(cx));
        if done(cx) {
            return;
        }
        assert!(Instant::now() < until, "shelf-review test timed out");
        std::thread::sleep(Duration::from_millis(4));
    }
}

fn setup_v3_fixture() -> (tempfile::TempDir, Library, String, String) {
    let dir = tempfile::tempdir().expect("tempdir");
    let store =
        dr_store::Library::open(dir.path(), dr_workspace::library_options("test")).expect("store");
    let seed = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .expect("seed");
    let book_id = seed.books[0].book_id().to_string();
    let entry_id = seed.books[0].book.view().entries_raw()[0].id.to_string();
    seed.write_to(&store).expect("write seed");
    let lib = Library::open(store, WorkspaceOptions::default()).expect("open workspace");
    (dir, lib, book_id, entry_id)
}

#[test]
fn rail_widths_and_ratios_preserve_library_minimum_and_roundtrip() {
    let mut mem = ShelfMemory::default();
    assert_eq!(
        mem.resolve_widths(None),
        (RAIL_DEFAULT_WIDTH, RAIL_DEFAULT_WIDTH)
    );

    // Dragging the TODO rail in a 1200px stage leaves at least 360px for the material shelf.
    let (todo_w, comment_w) = mem.apply_rail_drag(Rail::Todos, 900.0, Some(1200.0));
    assert_eq!(comment_w, RAIL_DEFAULT_WIDTH);
    assert_eq!(todo_w, 1200.0 - LIBRARY_MIN_WIDTH - RAIL_DEFAULT_WIDTH);
    assert!(mem.todo_ratio.is_some());
    assert!(mem.comment_ratio.is_some());

    // Shrinking the container scales excess above RAIL_MIN_WIDTH proportionally.
    let (shrunk_todo, shrunk_comment) = mem.resolve_widths(Some(900.0));
    assert!(shrunk_todo >= RAIL_MIN_WIDTH);
    assert!(shrunk_comment >= RAIL_MIN_WIDTH);
    assert!(shrunk_todo + shrunk_comment <= 900.0 - LIBRARY_MIN_WIDTH + 1.0);

    // JSON round-trip preserves fields and clamps malformed inputs.
    let json = mem.to_json();
    let restored = ShelfMemory::from_json(&json);
    assert_eq!(restored.todo_width, mem.todo_width);
    assert_eq!(restored.comment_width, mem.comment_width);
    assert_eq!(drag_rail_width(40.0, 280.0, Some(1200.0)), RAIL_MIN_WIDTH);
    assert_eq!(clamp_drawer_height(30.0, Some(800.0)), DRAWER_MIN_HEIGHT);
}

#[test]
fn material_query_matches_title_first_words_and_folder_path() {
    let mat = MaterialInfo {
        id: "mat-1".into(),
        title: "Harbor Map".into(),
        kind: "image".into(),
        asset: None,
        folder: Some("f-1".into()),
        pos: None,
        task_todos: false,
        description: String::new(),
        entry: None,
        module: None,
    };
    assert!(matches_material(
        &mat,
        None,
        Some("Atlas / Coast"),
        "harbor"
    ));
    assert!(matches_material(&mat, None, Some("Atlas / Coast"), "coast"));
    assert!(matches_material(
        &mat,
        Some("tide chart notes"),
        None,
        "tide"
    ));
    assert!(!matches_material(
        &mat,
        None,
        Some("Atlas / Coast"),
        "mountain"
    ));
}

#[gpui::test]
fn shelf_review_filters_resolves_links_and_persists_memory(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let (_dir, lib, book_id, entry_id) = setup_v3_fixture();

    // Seed synthetic review items and two distinct materials (one linked, one unlinked).
    let todo_id = lib
        .run::<CommentCreate>(
            &Actor::User,
            CommentCreateIn {
                book: book_id.clone(),
                module: None,
                part: None,
                // Written by hand: marker comments are only projected from prose.
                origin: Some("manual".into()),
                target: None,
                block_id: None,
                range: None,
                anchor: None,
                body: "Synthetic check lighthouse lantern".into(),
                author_name: None,
            },
        )
        .expect("create todo")
        .output
        .id;

    let note_id = lib
        .run::<CommentCreate>(
            &Actor::User,
            CommentCreateIn {
                book: book_id.clone(),
                module: None,
                part: None,
                origin: Some("manual".into()),
                target: None,
                block_id: None,
                range: None,
                anchor: None,
                body: "Synthetic pacing observation".into(),
                author_name: None,
            },
        )
        .expect("create comment")
        .output
        .id;

    let linked_mat = dr_view_material::import::import_bytes(
        &lib,
        &book_id,
        None,
        dr_testkit::media::png(8, 8),
        "Synthetic Linked Almanac",
    )
    .expect("create linked material")
    .material;

    let orphan_mat = dr_view_material::import::import_bytes(
        &lib,
        &book_id,
        None,
        // Other bytes than the linked one: the same bytes would be the same file.
        dr_testkit::media::png(9, 8),
        "Synthetic Unsorted Sketch",
    )
    .expect("create orphan material")
    .material;

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
                library: Some(lib.clone()),
                book: Some(book_id.clone()),
                ..Default::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
        dr_view_material::init(cx);
        dr_view_shelf_review::init(cx);
    });

    let (shell, cx) = cx.add_window_view(Workspace::new);
    wait(cx, |cx| {
        shell.read_with(cx, |ws, _| ws.book.v3().is_some() && ws.book_memory_ready())
    });

    // Open SuperView::ReviewMaterials in the real Workspace shell and also mount a direct
    // ShelfReviewView handle against the same SuperViewHost to inspect deterministic state.
    cx.update(|_, cx| {
        shell.update(cx, |ws, cx| {
            ws.super_view = Some(SuperView::ReviewMaterials);
            cx.notify();
        });
    });

    let view: Entity<ShelfReviewView> = cx.update(|window, cx| {
        let host = shell.read_with(cx, |ws, _| SuperViewHost {
            workspace: shell.downgrade(),
            library: ws.library.clone(),
            book_id: ws.book_id.clone(),
            book: ws.book.clone(),
            view: SuperView::ReviewMaterials,
        });
        cx.new(|cx| ShelfReviewView::new(&host, window, cx))
    });

    wait(cx, |cx| view.read_with(cx, |v, cx| v.is_ready(cx)));

    // The retired relation filter contributes no files.
    cx.update(|_, cx| {
        view.update(cx, |v, cx| {
            let orphans = v.orphan_materials(cx);
            assert!(orphans.iter().any(|m| m.id == orphan_mat));
            assert!(orphans.iter().any(|m| m.id == linked_mat));
        });
    });

    cx.update(|_, cx| {
        view.update(cx, |v, cx| v.set_entry_filter(Some(entry_id.clone()), cx));
    });
    wait(cx, |cx| view.read_with(cx, |v, cx| v.is_ready(cx)));
    cx.update(|_, cx| {
        view.update(cx, |v, cx| {
            let filtered = v.visible_materials(cx);
            assert!(!filtered.iter().any(|m| m.id == linked_mat));
            assert!(!filtered.iter().any(|m| m.id == orphan_mat));
            v.set_entry_filter(None, cx);
        });
    });
    wait(cx, |cx| view.read_with(cx, |v, cx| v.is_ready(cx)));

    // 2. Direct single-step trash_material moves the orphan file to Recently Deleted
    // without a confirmation dialog.
    cx.update(|_, cx| {
        view.update(cx, |v, cx| {
            v.trash_material(orphan_mat.clone(), cx);
            assert!(!v.has_dialog());
        });
    });
    wait(cx, |cx| {
        cx.update(|_, cx| {
            view.update(cx, |v, cx| {
                !v.orphan_materials(cx).iter().any(|m| m.id == orphan_mat)
            })
        })
    });

    // 3. Kind chip and search query narrow materials & review items.
    cx.update(|_, cx| {
        view.update(cx, |v, cx| {
            v.set_kind_enabled("image", false, cx);
            assert!(!v.visible_materials(cx).iter().any(|m| m.kind == "image"));
            v.set_kind_enabled("image", true, cx);
            v.set_search_query("lighthouse", cx);
            let counts = v.counts(cx);
            // Written by hand, so a comment: TODOs only come from the prose.
            assert_eq!(counts.open_todos, 0);
            assert_eq!(counts.open_comments, 1);
            v.set_search_query("", cx);
        });
    });

    // 4. Resolve TODO & comment -> move into resolved drawer; reopen -> back to open rail.
    cx.update(|_, cx| {
        view.update(cx, |v, cx| {
            let rv = v.review_view().expect("review view").clone();
            rv.update(cx, |r, cx| {
                r.set_done(&todo_id, true, cx);
                r.set_done(&note_id, true, cx);
            });
        });
    });
    wait(cx, |cx| {
        view.read_with(cx, |v, cx| {
            let resolved = v.resolved_items(cx);
            resolved.iter().any(|(c, _)| c.id == todo_id)
                && resolved.iter().any(|(c, _)| c.id == note_id)
        })
    });

    cx.update(|_, cx| {
        view.update(cx, |v, cx| v.reopen_review_item(&todo_id, cx));
    });
    wait(cx, |cx| {
        view.read_with(cx, |v, cx| {
            !v.resolved_items(cx).iter().any(|(c, _)| c.id == todo_id)
        })
    });

    // 5. Resize rails & open drawer -> persisted in Workspace::book_memory("shelf-review").
    cx.update(|_, cx| {
        view.update(cx, |v, cx| {
            v.resize_rail(Rail::Todos, 340.0, Some(1280.0), cx);
            v.resize_rail(Rail::Comments, 310.0, Some(1280.0), cx);
            v.set_drawer_open(true, cx);
        });
    });
    wait(cx, |cx| {
        shell.read_with(cx, |ws, _| {
            ws.book_memory(MEMORY_KEY).is_some_and(|val| {
                let mem = ShelfMemory::from_json(val);
                mem.todo_width == 340.0 && mem.comment_width == 310.0 && mem.drawer_open
            })
        })
    });

    cx.update(|_, cx| {
        dr_view_review::release(cx);
    });
}

#[gpui::test]
fn shelf_review_isolates_books_and_drains_on_release(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let dir = tempfile::tempdir().expect("tempdir");
    let store =
        dr_store::Library::open(dir.path(), dr_workspace::library_options("test")).expect("store");
    let seed_a = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .expect("seed a");
    let seed_b = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED + 1,
    )
    .expect("seed b");
    let book_a = seed_a.books[0].book_id().to_string();
    let entry_a = seed_a.books[0].book.view().entries_raw()[0].id.to_string();
    let book_b = seed_b.books[0].book_id().to_string();
    assert_ne!(book_a, book_b);
    seed_a.write_to(&store).expect("write seed a");
    seed_b.write_to(&store).expect("write seed b");
    let lib = Library::open(store, WorkspaceOptions::default()).expect("open workspace");

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
                book: Some(book_a.clone()),
                ..Default::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
        dr_view_material::init(cx);
        dr_view_shelf_review::init(cx);
    });

    let (shell, cx) = cx.add_window_view(Workspace::new);
    wait(cx, |cx| {
        shell.read_with(cx, |ws, _| {
            ws.book_id == book_a && ws.book.v3().is_some() && ws.book_memory_ready()
        })
    });

    // The view follows the workspace only while the stage shows it, and
    // opening a book closes the stage: show it again after every switch.
    let show = |cx: &mut VisualTestContext| {
        cx.update(|_, cx| {
            shell.update(cx, |ws, cx| {
                ws.super_view = Some(SuperView::ReviewMaterials);
                cx.notify();
            });
        });
    };
    show(cx);

    let view: Entity<ShelfReviewView> = cx.update(|window, cx| {
        let host = shell.read_with(cx, |ws, _| SuperViewHost {
            workspace: shell.downgrade(),
            library: ws.library.clone(),
            book_id: ws.book_id.clone(),
            book: ws.book.clone(),
            view: SuperView::ReviewMaterials,
        });
        cx.new(|cx| ShelfReviewView::new(&host, window, cx))
    });
    wait(cx, |cx| view.read_with(cx, |v, cx| v.is_ready(cx)));

    // Customize book A's rail width and entry filter.
    cx.update(|_, cx| {
        view.update(cx, |v, cx| {
            v.set_entry_filter(Some(entry_a.clone()), cx);
            v.resize_rail(Rail::Todos, 360.0, Some(1280.0), cx);
        });
    });
    wait(cx, |cx| {
        shell.read_with(cx, |ws, _| {
            ws.book_memory(MEMORY_KEY)
                .is_some_and(|val| ShelfMemory::from_json(val).todo_width == 360.0)
        })
    });

    // Switch to book B: selected_entry clears and rail width reverts to book B's default.
    cx.update(|window, cx| {
        shell.update(cx, |ws, cx| ws.open_book(&book_b, window, cx));
    });
    show(cx);
    wait(cx, |cx| {
        shell.read_with(cx, |ws, _| {
            ws.book_id == book_b && ws.book.v3().is_some() && ws.book_memory_ready()
        }) && view.read_with(cx, |v, cx| v.is_ready(cx))
    });
    cx.update(|_, cx| {
        assert_eq!(view.read(cx).selected_entry(), None);
        assert_eq!(view.read(cx).memory().todo_width, RAIL_DEFAULT_WIDTH);
    });

    // Switch back to book A: its 360.0px rail width returns intact.
    cx.update(|window, cx| {
        shell.update(cx, |ws, cx| ws.open_book(&book_a, window, cx));
    });
    show(cx);
    wait(cx, |cx| {
        shell.read_with(cx, |ws, _| {
            ws.book_id == book_a && ws.book.v3().is_some() && ws.book_memory_ready()
        }) && view.read_with(cx, |v, cx| v.is_ready(cx))
    });
    cx.update(|_, cx| {
        assert_eq!(view.read(cx).memory().todo_width, 360.0);
    });

    // Release barrier via real library::replace drains cleanly and resumes services.
    // The stage covers the window, so a library is replaced from outside it:
    // close it first. (Replacing while it is on screen fails today, with or
    // without this view following the workspace: m23 「待协调」.)
    cx.update(|_, cx| {
        shell.update(cx, |ws, cx| {
            ws.super_view = None;
            cx.notify();
        });
    });
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let dir_replacement = tempfile::tempdir().expect("replacement tempdir");
    let repl_path = dir_replacement.path().to_path_buf();
    let replaced = std::rc::Rc::new(std::cell::Cell::new(false));
    let replaced_done = replaced.clone();
    cx.update(|_, cx| {
        dr_shell::library::replace(
            cx,
            move |_, options| {
                dr_store::Library::open(&repl_path, options).map_err(|e| e.to_string())
            },
            move |res, _| {
                assert!(res.is_ok(), "library replacement failed: {res:?}");
                replaced_done.set(true);
            },
        );
    });
    wait(cx, |_| replaced.get());
    cx.update(|_, cx| {
        dr_view_review::release(cx);
    });
}

/// The stage keeps the view it made while it is closed. A kept view that is
/// not on screen does not follow the book, and catches up when shown again.
#[gpui::test]
fn a_closed_shelf_review_does_not_follow_the_book_and_catches_up_when_shown(
    cx: &mut TestAppContext,
) {
    cx.executor().allow_parking();
    let dir = tempfile::tempdir().expect("tempdir");
    let store =
        dr_store::Library::open(dir.path(), dr_workspace::library_options("test")).expect("store");
    let seed = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .expect("seed");
    let book_id = seed.books[0].book_id().to_string();
    seed.write_to(&store).expect("write seed");
    let lib = Library::open(store, WorkspaceOptions::default()).expect("open workspace");

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
                library: Some(lib.clone()),
                book: Some(book_id.clone()),
                ..Default::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
        dr_view_material::init(cx);
        dr_view_shelf_review::init(cx);
    });

    let (shell, cx) = cx.add_window_view(Workspace::new);
    wait(cx, |cx| {
        shell.read_with(cx, |ws, _| ws.book.v3().is_some() && ws.book_memory_ready())
    });
    let show = |cx: &mut VisualTestContext, view: Option<SuperView>| {
        cx.update(|_, cx| {
            shell.update(cx, |ws, cx| {
                ws.super_view = view;
                cx.notify();
            });
        });
    };
    show(cx, Some(SuperView::ReviewMaterials));

    let view: Entity<ShelfReviewView> = cx.update(|window, cx| {
        let host = shell.read_with(cx, |ws, _| SuperViewHost {
            workspace: shell.downgrade(),
            library: ws.library.clone(),
            book_id: ws.book_id.clone(),
            book: ws.book.clone(),
            view: SuperView::ReviewMaterials,
        });
        cx.new(|cx| ShelfReviewView::new(&host, window, cx))
    });
    wait(cx, |cx| view.read_with(cx, |v, cx| v.is_ready(cx)));

    show(cx, None);
    cx.run_until_parked();

    let added = dr_view_material::import::import_bytes(
        &lib,
        &book_id,
        None,
        dr_testkit::media::png(8, 8),
        "Synthetic media made while the stage is closed",
    )
    .expect("create a material while the stage is closed")
    .material;

    // The shell has the new book; the closed view still holds the old one.
    wait(cx, |cx| {
        shell.read_with(cx, |ws, _| {
            ws.book.material_items().iter().any(|m| m.id == added)
        })
    });
    cx.run_until_parked();
    cx.update(|_, cx| {
        view.update(cx, |v, cx| {
            assert!(v.orphan_materials(cx).iter().all(|m| m.id != added));
        });
    });

    show(cx, Some(SuperView::ReviewMaterials));
    wait(cx, |cx| {
        cx.update(|_, cx| {
            view.update(cx, |v, cx| {
                v.orphan_materials(cx).iter().any(|m| m.id == added)
            })
        })
    });

    show(cx, None);
    cx.run_until_parked();
    cx.update(|_, cx| {
        dr_view_review::release(cx);
    });
}

#[gpui::test]
fn shelf_review_counts_marker_and_checklist_todos_and_updates_on_resolve(cx: &mut TestAppContext) {
    use serde_json::json;

    cx.executor().allow_parking();
    let (_dir, lib, book_id, _) = setup_v3_fixture();
    let baseline = lib
        .call(&Actor::User, "comment.list", json!({"book": book_id}))
        .expect("list baseline")["output"]
        .as_array()
        .expect("comments array")
        .clone();
    let baseline_todos = baseline
        .iter()
        .filter(|c| c["status"] == "open" && (c["origin"] == "marker" || c["origin"] == "task"))
        .count();
    let baseline_comments = baseline
        .iter()
        .filter(|c| c["status"] == "open" && c["origin"] != "marker" && c["origin"] != "task")
        .count();

    let chapter_id = lib
        .call(
            &Actor::User,
            "entry.create",
            json!({
                "book": book_id,
                "template": "tpl-chapter",
                "title": "待办计数测试章",
                "bodies": {"mod-prose": "TODO: 核对灯塔燃料\n检查备件箱"}
            }),
        )
        .expect("create chapter")["output"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let doc = format!("body:{chapter_id}/mod-prose");
    let session = lib.prose_session(&doc).expect("prose session");
    session
        .edit(|t| {
            t.set_block_attrs(
                13,
                &dr_model::prose::BlockAttrs {
                    list: Some(dr_model::kind::ListKind::Task),
                    ..Default::default()
                },
            )
        })
        .expect("mark checklist task");
    let p0 = lib
        .call(&Actor::User, "prose.read", json!({"doc": doc}))
        .expect("read prose")["output"]["paragraphs"][0]["block_id"]
        .as_str()
        .unwrap()
        .to_owned();
    lib.call(
        &Actor::User,
        "comment.project",
        json!({
            "doc": doc,
            "markers": [{"block": p0, "task": "核对灯塔燃料"}],
            "tasks": []
        }),
    )
    .expect("project marker and checklist task");

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
                library: Some(lib.clone()),
                book: Some(book_id.clone()),
                ..Default::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
        dr_view_material::init(cx);
        dr_view_shelf_review::init(cx);
    });

    let (shell, cx) = cx.add_window_view(Workspace::new);
    wait(cx, |cx| {
        shell.read_with(cx, |ws, _| ws.book.v3().is_some() && ws.book_memory_ready())
    });
    cx.update(|_, cx| {
        shell.update(cx, |ws, cx| {
            ws.super_view = Some(SuperView::ReviewMaterials);
            cx.notify();
        });
    });

    let view: Entity<ShelfReviewView> = cx.update(|window, cx| {
        let host = shell.read_with(cx, |ws, _| SuperViewHost {
            workspace: shell.downgrade(),
            library: ws.library.clone(),
            book_id: ws.book_id.clone(),
            book: ws.book.clone(),
            view: SuperView::ReviewMaterials,
        });
        cx.new(|cx| ShelfReviewView::new(&host, window, cx))
    });
    wait(cx, |cx| view.read_with(cx, |v, cx| v.is_ready(cx)));

    // Both the marker TODO and the checklist task count in `open_todos`, while
    // `open_comments` stays at the book's manual/non-TODO count.
    cx.update(|_, cx| {
        view.update(cx, |v, cx| {
            assert_eq!(v.counts(cx).open_todos, baseline_todos + 2);
            assert_eq!(v.counts(cx).open_comments, baseline_comments);
        });
    });

    let task_id = lib
        .call(
            &Actor::User,
            "comment.list",
            json!({"book": book_id, "origin": "task"}),
        )
        .expect("list task comments")["output"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["body"]["text"] == "检查备件箱")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();

    cx.update(|_, cx| {
        view.update(cx, |v, cx| {
            let rv = v.review_view().expect("review view").clone();
            rv.update(cx, |r, cx| r.set_done(&task_id, true, cx));
        });
    });
    wait(cx, |cx| {
        cx.update(|_, cx| view.update(cx, |v, cx| v.counts(cx).open_todos == 1))
    });

    cx.update(|_, cx| {
        dr_view_review::release(cx);
    });
}

#[gpui::test]
#[ignore = "release reference benchmark over Preset::Heavy (100 chapters, 200 review items, 96 materials)"]
fn heavy_seed_reference_timings(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let dir = tempfile::tempdir().expect("tempdir");
    let store =
        dr_store::Library::open(dir.path(), dr_workspace::library_options("test")).expect("store");
    let seed = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Heavy,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .expect("seed heavy");
    let book_id = seed.books[0].book_id().to_string();
    seed.write_to(&store).expect("write seed");
    store.rebuild_stale_indexes().expect("rebuild indexes");
    let lib = Library::open(store, WorkspaceOptions::default()).expect("open workspace");

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
                book: Some(book_id.clone()),
                ..Default::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
        dr_view_material::init(cx);
        dr_view_shelf_review::init(cx);
    });

    let (shell, vcx) = cx.add_window_view(Workspace::new);
    wait(vcx, |cx| {
        shell.read_with(cx, |ws, _| {
            ws.book_id == book_id && ws.book.v3().is_some() && ws.book_memory_ready()
        })
    });

    let t_open = Instant::now();
    vcx.update(|window, cx| {
        shell.update(cx, |ws, cx| {
            ws.super_view = Some(SuperView::ReviewMaterials);
            cx.notify();
        });
        window.draw(cx).clear(cx);
    });
    let first_frame_ms = t_open.elapsed().as_secs_f64() * 1000.0;

    wait(vcx, |cx| {
        cx.update(|_, cx| {
            dr_view_shelf_review::current(cx).is_some_and(|v| v.read(cx).is_ready(cx))
        })
    });
    let ready_ms = t_open.elapsed().as_secs_f64() * 1000.0;

    let view =
        vcx.update(|_, cx| dr_view_shelf_review::current(cx).expect("mounted ShelfReviewView"));
    let counts = vcx.update(|_, cx| view.update(cx, |v, cx| v.counts(cx)));

    let mut frame_ms = Vec::with_capacity(20);
    for step in 0..20 {
        let t_f = Instant::now();
        vcx.update(|window, cx| {
            view.update(cx, |v, cx| {
                v.set_drawer_open(step >= 10, cx);
                v.resize_rail(Rail::Todos, 280.0 + (step as f32) * 4.0, Some(1440.0), cx);
            });
            window.draw(cx).clear(cx);
        });
        frame_ms.push(t_f.elapsed().as_secs_f64() * 1000.0);
    }
    frame_ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let p50_draw_ms = frame_ms[frame_ms.len() / 2];
    let p95_draw_ms = frame_ms[(frame_ms.len() * 95) / 100];

    vcx.update(|_, cx| {
        dr_view_review::release(cx);
    });

    eprintln!(
        "[m23-heavy-reference] todos={} comments={} materials={} first_frame_ms={first_frame_ms:.2} ready_ms={ready_ms:.2} draw_p50_ms={p50_draw_ms:.2} draw_p95_ms={p95_draw_ms:.2}",
        counts.open_todos, counts.open_comments, counts.materials,
    );
}
