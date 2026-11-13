//! K4-0 contracts against the canonical seed; retired routes are rejected.
use dr_shell::{
    book::{Book, Snapshot, v3::SettingSource},
    nav::{Lines, Navigator, Open, Target},
};
use dr_workspace::{Actor, Workspace};
use serde_json::{Value, json};

fn call(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input).unwrap()["output"].clone()
}
fn seed() -> (tempfile::TempDir, Workspace, String) {
    let dir = tempfile::tempdir().unwrap();
    let store =
        dr_store::Library::open(dir.path(), dr_workspace::library_options("0.2.0-dev")).unwrap();
    let made = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let id = made.books[0].book_id().to_string();
    made.write_to(&store).unwrap();
    store.close().unwrap();
    let ws = Workspace::open_dir(dir.path(), "0.2.0-dev").unwrap();
    (dir, ws, id)
}
#[test]
fn versioned_snapshot_reads_queries_and_retains_setting_sources() {
    let (_dir, ws, id) = seed();
    let b = Book::load(&ws, &id).unwrap();
    assert!(matches!(b.snapshot, Snapshot::V3(_)));
    assert!(!b.v3().unwrap().manuscript.is_empty());
    let v = b.v3().unwrap();
    assert_eq!(v.roots.len(), 4);
    assert!(!v.timeline_views.is_empty());
    assert!(!v.memberships.is_empty());
    let root = v
        .entries
        .iter()
        .find(|e| e.template.as_deref() == Some("tpl-manuscript"))
        .unwrap();
    assert!(v.levels[&root.id].settings.is_manuscript);
    assert_eq!(
        v.levels[&root.id].sources["is_manuscript"],
        SettingSource::Template {
            entry: root.id.clone(),
            template: "tpl-manuscript".into()
        }
    );
    let child = call(
        &ws,
        "entry.create",
        json!({"book":id,"parent":root.id,"template":"tpl-group","title":"Synthetic nested level"}),
    );
    call(
        &ws,
        "entry.update",
        json!({"book":id,"id":child["id"],"overrides":{"display":"grid","default_template":null}}),
    );
    let again = Book::load(&ws, &id).unwrap();
    let v = again.v3().unwrap();
    let child = child["id"].as_str().unwrap();
    let level = &v.levels[child];
    assert_eq!(level.settings.display, "grid");
    assert_eq!(level.settings.default_template, None);
    assert_eq!(
        level.sources["display"],
        SettingSource::Override {
            entry: child.into()
        }
    );
    assert_eq!(
        level.sources["default_template"],
        SettingSource::Override {
            entry: child.into()
        }
    );
    assert_eq!(
        level.sources["is_manuscript"],
        SettingSource::Template {
            entry: root.id.clone(),
            template: "tpl-manuscript".into()
        }
    );
    assert_ne!(v.revision, b.v3().unwrap().revision);
    let legacy = dr_testkit::seed::acceptance::empty_source(ws.library());
    let before = ws.library().head(&format!("book:{legacy}")).unwrap();
    assert!(Book::load(&ws, &legacy).is_err());
    assert_eq!(
        ws.library().head(&format!("book:{legacy}")).unwrap(),
        before
    );
    assert_ne!(
        Book::load_any(&ws, Some(&legacy)).unwrap().unwrap().id,
        legacy
    );
    ws.shutdown().unwrap();
}
#[test]
fn material_targets_use_the_v3_book_metadata_and_refresh_after_removal() {
    let (_dir, ws, id) = seed();
    let before = ws.observe(&format!("book:{id}")).unwrap();
    let b = Book::load(&ws, &id).unwrap();
    let material = b
        .v3()
        .unwrap()
        .materials
        .first()
        .expect("shared seed material");
    let target = Target::Material(material.id.parse().unwrap());
    assert!(b.exists(&target));
    assert_eq!(b.title(&target), Some(material.title.as_str()));
    assert_eq!(b.mark(&target), (dr_ui::sand::Kind::Material, None));
    assert!(!b.exists(&Target::Material("missing-material".parse().unwrap())));
    assert_eq!(
        before.version,
        ws.observe(&format!("book:{id}")).unwrap().version
    );

    // Model a remote metadata removal while its prose still exists. The
    // shell must not infer a navigable material merely from that document.
    let book_id = id.parse().unwrap();
    let material_id = material.id.clone();
    ws.library()
        .open_doc(&format!("book:{id}"), dr_store::OpenDoc::Existing)
        .unwrap()
        .write(dr_store::Origin::Sync, move |doc| {
            dr_doc::v3::BorrowedBookV3::new(doc, &book_id)
                .unwrap()
                .txn()
                .purge(dr_doc::v3::CollectionV3::Materials, &material_id)
                .unwrap();
        })
        .unwrap();
    let after = Book::load(&ws, &id).unwrap();
    assert!(!after.exists(&target));
    assert_eq!(after.title(&target), None);
    assert_ne!(b.v3().unwrap().revision, after.v3().unwrap().revision);
    assert!(
        ws.library()
            .open_doc(&target.key(), dr_store::OpenDoc::Existing)
            .is_ok()
    );
    ws.shutdown().unwrap();
}

#[test]
fn entry_appearance_follows_valid_primary_lane_and_removals_close_targets() {
    let (_dir, ws, id) = seed();
    let b = Book::load(&ws, &id).unwrap();
    let v = b.v3().unwrap();
    let entry = v
        .entries
        .iter()
        .find(|e| e.template.as_deref() == Some("tpl-chapter") && e.primary.is_some())
        .unwrap();
    let lane = entry.primary.as_deref().unwrap();
    assert_eq!(
        v.appearance(&entry.id).unwrap().color,
        v.appearance(lane).unwrap().color
    );
    assert_eq!(
        v.appearance(&entry.id).unwrap().mark.as_deref(),
        Some("file-text")
    );
    let target = Target::from_key(&format!("entry:{}/mod-prose", entry.id)).unwrap();
    assert!(b.exists(&target));
    call(&ws, "entry.trash", json!({"book":id,"id":entry.id}));
    let after = Book::load(&ws, &id).unwrap();
    assert!(!after.exists(&target));
    ws.shutdown().unwrap();
}

#[gpui::test]
fn book_and_material_pages_survive_a_reordered_snapshot(cx: &mut gpui::TestAppContext) {
    use dr_shell::{Services, SettingsFile, ShellInfo, Workspace as Shell};
    use gpui::{prelude::*, *};
    use std::time::{Duration, Instant};

    struct BookPage(FocusHandle);
    impl Render for BookPage {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div().track_focus(&self.0).size_full()
        }
    }

    let (_dir, lib, id) = seed();
    cx.executor().allow_parking();
    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "0.2.0-dev",
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                library: Some(lib.clone()),
                book: Some(id.clone()),
                ..Default::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
        // The shell owns the page's lifetime; the real G1 manuscript renderer
        // is exercised by k4-0-navigation.json in a native window.
        dr_shell::pages::add_page_view(cx, |target, _, _, cx| {
            matches!(target, Target::Book(_)).then(|| {
                let view = cx.new(|cx| BookPage(cx.focus_handle()));
                dr_shell::pages::ModulePage {
                    focus: view.read(cx).0.clone(),
                    view: view.into(),
                }
            })
        });
    });
    let (view, cx) = cx.add_window_view(Shell::new);
    let wait = |cx: &mut VisualTestContext, revision: Option<&str>| {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            cx.run_until_parked();
            if view.read_with(cx, |ws, _| {
                ws.book
                    .v3()
                    .is_some_and(|b| Some(b.revision.as_str()) != revision)
            }) {
                break;
            }
            assert!(Instant::now() < deadline, "book snapshot did not refresh");
            std::thread::sleep(Duration::from_millis(2));
        }
    };
    wait(cx, None);
    let (entry, material, book_target, revision) = view.read_with(cx, |ws, _| {
        let b = ws.book.v3().unwrap();
        (
            b.entries
                .iter()
                .find(|e| e.template.as_deref() == Some("tpl-chapter"))
                .unwrap()
                .clone(),
            Target::Material(b.materials[0].id.parse().unwrap()),
            Target::Book(b.roots[0].parse().unwrap()),
            b.revision.clone(),
        )
    });
    let module = Target::from_key(&format!("entry:{}/mod-prose", entry.id)).unwrap();
    for target in [&module, &material, &book_target] {
        view.update(cx, |ws, cx| ws.open(target.clone(), Open::KEEP, cx));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        cx.run_until_parked();
    }
    let book_key = book_target.key();
    let page = view.read_with(cx, |ws, _| {
        ws.editors[&book_key]
            .module
            .as_ref()
            .unwrap()
            .view
            .entity_id()
    });
    call(
        &lib,
        "entry.move",
        json!({"book":id,"id":entry.id,"parent":entry.parent}),
    );
    wait(cx, Some(&revision));
    view.read_with(cx, |ws, _| {
        assert_eq!(ws.nav.current(), Some(&book_target));
        assert_eq!(
            ws.editors[&book_key]
                .module
                .as_ref()
                .unwrap()
                .view
                .entity_id(),
            page,
            "snapshot refresh retains the mounted manuscript page"
        );
        for target in [&module, &material, &book_target] {
            assert!(ws.book.exists(target));
            assert!(ws.editors.contains_key(&target.key()));
            assert!(
                ws.nav
                    .tabs()
                    .iter()
                    .any(|t| t.leaves().any(|l| &l.target == target))
            );
        }
        assert!(Target::from_key("book").is_none());
        assert!(Target::from_key("book:").is_none());
        for kind in ["chapter", "idea", "element", "storyline", "category"] {
            assert!(
                Target::from_key(&format!("{kind}:{}", entry.id)).is_none(),
                "legacy routes cannot be constructed"
            );
        }
    });
}

#[test]
fn v3_targets_roundtrip_tabs_history_splits_and_location() {
    let targets = [
        "entry:one",
        "entry:one/prose-a",
        "entry:one/prose-b",
        "template:tpl-leaf",
    ];
    let mut nav = Navigator::default();
    for key in targets {
        let target = Target::from_key(key).unwrap();
        assert_eq!(target.key(), key);
        assert_eq!(
            serde_json::from_str::<Target>(&serde_json::to_string(&target).unwrap()).unwrap(),
            target
        );
        nav.open(target, Open::KEEP);
    }
    nav.back();
    assert_eq!(nav.current().unwrap().key(), "entry:one/prose-b");
    nav.forward();
    assert_eq!(nav.current().unwrap().key(), "template:tpl-leaf");
    let target = Target::from_key("entry:one/prose-a").unwrap();
    let lines = Lines {
        start: 12,
        end: Some(18),
    };
    nav.open_at(target.clone(), Some(lines));
    assert_eq!(nav.take_reveal(&target), Some(lines));
    assert_eq!(nav.take_reveal(&target), None);
    assert!(Target::from_key("entry:one/").is_none());
    assert!(Target::from_key("entry:one/p/extra").is_none());
}

#[gpui::test]
fn renderers_mount_in_template_order_refresh_and_receive_reveal(cx: &mut gpui::TestAppContext) {
    use dr_shell::{
        Services, SettingsFile, ShellInfo, Workspace as Shell,
        v3::{self, Rendered},
    };
    use gpui::{prelude::*, *};
    use std::{
        cell::Cell,
        rc::Rc,
        time::{Duration, Instant},
    };
    struct Probe {
        focus: FocusHandle,
    }
    impl Render for Probe {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div().track_focus(&self.focus).h_10()
        }
    }
    let (_dir, lib, id) = seed();
    let book = Book::load(&lib, &id).unwrap();
    let entry = book
        .v3()
        .unwrap()
        .entries
        .iter()
        .find(|e| e.template.as_deref() == Some("tpl-chapter"))
        .unwrap()
        .id
        .clone();
    let refreshes = Rc::new(Cell::new(0));
    let reveals = Rc::new(Cell::new(0));
    cx.executor().allow_parking();
    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "0.2.0-dev",
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                deep_links: None,
                crash_reports: None,
                library: Some(lib.clone()),
                book: Some(id.clone()),
            },
            SettingsFile::in_memory(),
            cx,
        );

        for kind in ["fields", "prose", "plot_grid"] {
            let refreshed = refreshes.clone();
            let revealed = reveals.clone();
            v3::add_module_view(cx, kind, move |_, _, cx| {
                let refreshed = refreshed.clone();
                let revealed = revealed.clone();
                let probe = cx.new(|cx| Probe {
                    focus: cx.focus_handle(),
                });
                let focus = probe.read(cx).focus.clone();
                Rendered::new(probe)
                    .focus(focus)
                    .on_refresh(move |_, _| refreshed.set(refreshed.get() + 1))
                    .on_reveal(move |lines, _, _| {
                        assert_eq!(lines.unwrap().start, 3);
                        revealed.set(revealed.get() + 1);
                    })
            });
        }
    });
    let (view, cx) = cx.add_window_view(Shell::new);
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        cx.run_until_parked();
        if view.read_with(cx, |ws, _| ws.book.v3().is_some()) {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(2));
    }
    let target = Target::from_key(&format!("entry:{entry}/mod-prose")).unwrap();
    view.update(cx, |ws, cx| {
        ws.open(target.clone(), Open::KEEP, cx);
        ws.nav.open_at(
            target.clone(),
            Some(Lines {
                start: 3,
                end: None,
            }),
        );
    });
    for _ in 0..4 {
        cx.update(|w, cx| w.draw(cx).clear(cx));
        cx.run_until_parked();
    }
    view.read_with(cx, |ws, cx| {
        assert!(ws.bottom_pane(cx).is_none());
        let page = ws.editors[&target.key()].v3.as_ref().unwrap().read(cx);
        assert_eq!(
            page.sections
                .iter()
                .map(|s| s.kind.as_str())
                .collect::<Vec<_>>(),
            vec!["fields", "prose", "plot_grid"]
        );
        assert!(page.sections.iter().all(|s| s.registered));
    });
    assert_eq!(reveals.get(), 1);
    cx.update(|window, cx| {
        let page = view.read(cx).editors[&target.key()]
            .v3
            .as_ref()
            .unwrap()
            .read(cx);
        assert!(
            page.preferred_focus().is_focused(window),
            "the module takes typing after it mounts"
        );
    });
    call(
        &lib,
        "entry.update",
        json!({"book":id,"id":entry,"title":"Synthetic renamed"}),
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        cx.run_until_parked();
        if refreshes.get() >= 3 {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(2));
    }
    assert_eq!(
        view.read_with(cx, |ws, _| ws.book.title(&target).unwrap().to_owned()),
        "Synthetic renamed"
    );
}

#[gpui::test]
fn sidebar_delegates_displays_and_cards_keep_common_actions_and_extensions(
    cx: &mut gpui::TestAppContext,
) {
    use dr_shell::{
        Services, SettingsFile, ShellInfo, Workspace as Shell,
        pages::{CardRows, PageMenuHost, PageMenuItem, PageMenuSection, PageViewHost},
        v3::{self, DisplaySurface, Rendered, card::EntryAction},
    };
    use gpui::{prelude::*, *};
    use std::{
        cell::{Cell, RefCell},
        rc::Rc,
        time::{Duration, Instant},
    };
    struct Probe;
    impl Render for Probe {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div().h_10()
        }
    }
    let (_dir, lib, book_id) = seed();
    let made = Rc::new(RefCell::new(Vec::new()));
    let refreshed = Rc::new(Cell::new(0));
    cx.executor().allow_parking();
    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "0.2.0-dev",
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                deep_links: None,
                crash_reports: None,
                library: Some(lib.clone()),
                book: Some(book_id.clone()),
            },
            SettingsFile::in_memory(),
            cx,
        );
        for kind in ["list", "grid", "board", "island"] {
            let made = made.clone();
            let refreshed = refreshed.clone();
            v3::add_level_display(cx, kind, move |host, _, cx| {
                made.borrow_mut().push((host.level, kind, host.surface));
                let refreshed = refreshed.clone();
                Rendered::new(cx.new(|_| Probe))
                    .on_refresh(move |_, _| refreshed.set(refreshed.get() + 1))
            });
        }
    });
    let (view, cx) = cx.add_window_view(Shell::new);
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        cx.run_until_parked();
        if view.read_with(cx, |ws, _| ws.book.v3().is_some() && ws.book_memory_ready()) {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(2));
    }
    cx.update(|window, cx| view.update(cx, |ws, cx| ws.toggle_left(window, cx)));
    for _ in 0..4 {
        cx.update(|w, cx| w.draw(cx).clear(cx));
        cx.run_until_parked();
    }
    let (panel, roots, target) = view.read_with(cx, |ws, _| {
        let v = ws.book.v3().unwrap();
        let entry = v
            .entries
            .iter()
            .find(|e| e.template.as_deref() == Some("tpl-chapter"))
            .unwrap();
        (
            ws.v3_sidebar.clone().unwrap(),
            v.roots.clone(),
            v3::entry_target(&entry.id).unwrap(),
        )
    });
    assert_eq!(roots.len(), 4);
    assert!(
        made.borrow()
            .iter()
            .any(|(_, kind, surface)| *kind == "list" && *surface == DisplaySurface::Sidebar)
    );
    for id in &roots {
        panel.update(cx, |s, cx| s.select(id, cx));
        for _ in 0..2 {
            cx.update(|w, cx| w.draw(cx).clear(cx));
            cx.run_until_parked();
        }
    }
    assert!(
        made.borrow()
            .iter()
            .all(|(_, _, surface)| *surface == DisplaySurface::Sidebar)
    );
    assert_eq!(
        view.read_with(cx, |ws, _| ws.book_memory(v3::sidebar::MEMORY_KEY).cloned()),
        Some(json!(roots[3]))
    );
    let count = made.borrow().len();
    call(
        &lib,
        "entry.update",
        json!({"book":book_id,"id":roots[3],"title":"Synthetic updated level","overrides":{"display":"grid"}}),
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        cx.run_until_parked();
        cx.update(|w, cx| w.draw(cx).clear(cx));
        if made.borrow().len() > count {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(2));
    }
    assert_eq!(panel.read_with(cx, |s, _| s.state())["display"], "grid");
    assert!(refreshed.get() > 0);
    let invoked = Rc::new(Cell::new(0));
    cx.update(|window, cx| {
        let host = PageMenuHost::of(&view, cx);
        let rows = v3::card::rows(&target, &host, &CardRows::default(), cx);
        assert_eq!(
            rows.iter().map(|r| r.id.as_ref()).collect::<Vec<_>>(),
            vec![
                "entry-open",
                "entry-new",
                "entry-edit-template",
                "entry-change-template",
                "entry-belong-to",
                "entry-trash"
            ]
        );
        assert_eq!(rows.iter().filter(|r| r.run.is_none()).count(), 3);
        for action in [
            EntryAction::New,
            EntryAction::ChangeTemplate,
            EntryAction::BelongTo,
        ] {
            let invoked = invoked.clone();
            v3::add_entry_action(cx, action, move |_, _, _| {
                let invoked = invoked.clone();
                Some(Rc::new(move |_, _| invoked.set(invoked.get() + 1)))
            });
        }
        let item = |id: &str, danger| PageMenuItem {
            id: id.to_owned().into(),
            label: id.to_owned().into(),
            icon: dr_ui::sand::Icon::Plus.into(),
            checked: false,
            danger,
            run: Rc::new(|_, _| {}),
        };
        v3::add_entry_card_rows(cx, move |_, _, _| CardRows {
            lead: vec![PageMenuSection {
                title: None,
                items: vec![item("g3-extra", false), item("g3-danger", true)],
            }],
            ..Default::default()
        });
        let rows = v3::card::rows(&target, &host, &CardRows::default(), cx);
        assert_eq!(rows[0].id, "g3-extra");
        let danger_at = rows.iter().position(|r| r.danger).unwrap();
        assert!(rows[danger_at..].iter().all(|r| r.danger));
        for id in ["entry-new", "entry-change-template", "entry-belong-to"] {
            rows.iter()
                .find(|r| r.id == id)
                .unwrap()
                .run
                .as_ref()
                .unwrap()(window, cx);
        }
        assert_eq!(invoked.get(), 3);
        rows.iter()
            .find(|r| r.id == "entry-edit-template")
            .unwrap()
            .run
            .as_ref()
            .unwrap()(window, cx);
        assert_eq!(
            view.read(cx).nav.current().unwrap().key(),
            "template:tpl-chapter"
        );
        let created = invoked.clone();
        assert!(!v3::has_template_creator(cx));
        v3::add_template_creator(cx, move |host, _, _| {
            assert!(host.book.v3().is_some());
            created.set(created.get() + 1);
        });
        assert!(v3::has_template_creator(cx));
        v3::create_template(
            PageViewHost {
                workspace: host.workspace,
                library: lib.clone(),
                book_id: book_id.clone(),
                book: host.book,
            },
            window,
            cx,
        );
        assert_eq!(invoked.get(), 4);
    });
    call(&lib, "entry.trash", json!({"book":book_id,"id":roots[3]}));
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        cx.run_until_parked();
        cx.update(|w, cx| w.draw(cx).clear(cx));
        if panel.read_with(cx, |s, _| s.state())["selected"] == roots[0] {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(2));
    }
}

#[gpui::test]
fn level_settings_part_mounts_once_and_refreshes(cx: &mut gpui::TestAppContext) {
    use dr_shell::{
        Services, SettingsFile, ShellInfo, Workspace as Shell,
        v3::{self, Rendered},
    };
    use gpui::{prelude::*, *};
    use std::{
        cell::Cell,
        rc::Rc,
        time::{Duration, Instant},
    };
    struct Probe;
    impl Render for Probe {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div().h_10()
        }
    }
    let (_dir, lib, id) = seed();
    let book = Book::load(&lib, &id).unwrap();
    let level = book
        .v3()
        .unwrap()
        .entries
        .iter()
        .find(|e| e.template.as_deref() == Some("tpl-manuscript"))
        .unwrap()
        .id
        .clone();
    let made = Rc::new(Cell::new(0));
    let refreshed = Rc::new(Cell::new(0));
    cx.executor().allow_parking();
    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "0.2.0-dev",
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                deep_links: None,
                crash_reports: None,
                library: Some(lib.clone()),
                book: Some(id.clone()),
            },
            SettingsFile::in_memory(),
            cx,
        );
        let made = made.clone();
        let refreshed = refreshed.clone();
        v3::add_level_settings(cx, move |host, _, cx| {
            assert_eq!(host.surface, v3::DisplaySurface::Page);
            made.set(made.get() + 1);
            let refreshed = refreshed.clone();
            Rendered::new(cx.new(|_| Probe))
                .on_refresh(move |_, _| refreshed.set(refreshed.get() + 1))
        });
    });
    let (view, cx) = cx.add_window_view(Shell::new);
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        cx.run_until_parked();
        if view.read_with(cx, |ws, _| ws.book.v3().is_some()) {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(2));
    }
    let target = Target::from_key(&format!("entry:{level}")).unwrap();
    view.update(cx, |ws, cx| ws.open(target.clone(), Open::KEEP, cx));
    for _ in 0..4 {
        cx.update(|w, cx| w.draw(cx).clear(cx));
        cx.run_until_parked();
    }
    view.read_with(cx, |ws, cx| {
        let page = ws.editors[&target.key()].v3.as_ref().unwrap().read(cx);
        let settings = page.sections.iter().find(|s| s.id == "settings").unwrap();
        assert!(
            settings.registered,
            "the registered settings part is mounted"
        );
    });
    assert_eq!(made.get(), 1);
    call(
        &lib,
        "entry.update",
        json!({"book":id,"id":level,"title":"Synthetic level renamed"}),
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        cx.run_until_parked();
        cx.update(|w, cx| w.draw(cx).clear(cx));
        if refreshed.get() >= 1 {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(2));
    }
    assert_eq!(made.get(), 1, "the settings part is kept across refreshes");
}

#[gpui::test]
fn level_refresh_retains_live_prose_input_selection_scroll_and_page_instance(
    cx: &mut gpui::TestAppContext,
) {
    use dr_editor::{ChapterEditor, EditorSettings};
    use dr_shell::{
        Services, SettingsFile, ShellInfo, Workspace as Shell,
        v3::{self, Rendered},
    };
    use gpui::{prelude::*, *};
    use std::{
        cell::RefCell,
        rc::Rc,
        time::{Duration, Instant},
    };

    let (_dir, lib, id) = seed();
    let book = Book::load(&lib, &id).unwrap();
    let b = book.v3().unwrap();
    let entry = b
        .entries
        .iter()
        .find(|e| e.template.as_deref() == Some("tpl-chapter"))
        .unwrap()
        .id
        .clone();
    let level = b
        .entries
        .iter()
        .find(|e| e.template.as_deref() == Some("tpl-manuscript"))
        .unwrap()
        .id
        .clone();
    let mounted = Rc::new(RefCell::new(Vec::new()));
    cx.executor().allow_parking();
    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "0.2.0-dev",
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                library: Some(lib.clone()),
                book: Some(id.clone()),
                ..Default::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
        let mounted = mounted.clone();
        v3::add_module_view(cx, "prose", move |host, window, cx| {
            let doc = format!("body:{}/{}", host.entry, host.module.id);
            let editor = cx.new(|cx| {
                ChapterEditor::open(
                    host.page.library.clone(),
                    &host.page.book_id,
                    &doc,
                    EditorSettings::default(),
                    window,
                    cx,
                )
                .unwrap()
            });
            mounted.borrow_mut().push(editor.clone());
            let focus = editor.read(cx).editor().focus_handle(cx);
            // As dr-view-page's body module: the body is part of the page and
            // scrolls it.
            let page_editor = editor.clone();
            Rendered::new(editor)
                .focus(focus)
                .on_page_scroll(move |page, cx| {
                    page_editor.update(cx, |e, cx| e.set_page_scroll(Some(page), cx));
                })
        });
    });
    // A body several windows long, so scrolling moves its text.
    let paragraphs: Vec<Value> = (0..80)
        .map(|i| json!({ "text": format!("第{i}段。潮水退去以后，堤岸上的水线还会留下片刻。") }))
        .collect();
    call(
        &lib,
        "module.set_prose",
        json!({"book":id,"owner":entry,"module":"mod-prose","paragraphs":paragraphs}),
    );
    let (view, cx) = cx.add_window_view(Shell::new);
    cx.simulate_resize(size(px(1100.), px(800.)));
    let wait = |cx: &mut VisualTestContext, revision: Option<&str>| {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            cx.run_until_parked();
            cx.update(|window, cx| window.draw(cx).clear(cx));
            if view.read_with(cx, |ws, _| {
                ws.book
                    .v3()
                    .is_some_and(|b| Some(b.revision.as_str()) != revision)
            }) {
                break;
            }
            assert!(Instant::now() < deadline, "book did not refresh");
            std::thread::sleep(Duration::from_millis(2));
        }
    };
    wait(cx, None);
    let target = Target::from_key(&format!("entry:{entry}/mod-prose")).unwrap();
    view.update(cx, |ws, cx| ws.open(target.clone(), Open::KEEP, cx));
    for _ in 0..4 {
        cx.update(|window, cx| window.draw(cx).clear(cx));
        cx.run_until_parked();
    }
    let editor = mounted.borrow()[0].clone();
    let prose = editor.read_with(cx, |e, _| e.editor().clone());
    cx.update(|window, cx| {
        prose.update(cx, |p, cx| {
            p.select(0, 8..8, window, cx);
            p.replace_text_in_range(None, "结构刷新", window, cx);
        })
    });
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear(cx));
    // The page scrolls the body's text up by more than what is above it.
    prose.update(cx, |p, cx| {
        p.scroll_by_estimate(1200.0, cx);
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let (text, selection, scroll) = prose.read_with(cx, |p, _| {
        (
            p.book().chapters[0].doc.plain_text(),
            p.selection(),
            p.scroll_y().0,
        )
    });
    assert!(text.contains("结构刷新"));
    assert!(scroll > 0.0, "the editor must actually be scrolled");
    let (page, revision) = view.read_with(cx, |ws, _| {
        (
            ws.editors[&target.key()].v3.as_ref().unwrap().entity_id(),
            ws.book.v3().unwrap().revision.clone(),
        )
    });
    call(
        &lib,
        "entry.update",
        json!({"book":id,"id":level,"overrides":{"accept":true}}),
    );
    wait(cx, Some(&revision));
    view.read_with(cx, |ws, _| {
        assert_eq!(ws.nav.current(), Some(&target));
        assert_eq!(
            ws.editors[&target.key()].v3.as_ref().unwrap().entity_id(),
            page
        );
        let refreshed = &ws.book.v3().unwrap().levels[&level];
        assert!(refreshed.settings.accept);
        assert_eq!(
            refreshed.sources["accept"],
            SettingSource::Override {
                entry: level.clone()
            }
        );
    });
    assert_eq!(
        mounted.borrow().len(),
        1,
        "the live module editor is retained"
    );
    prose.read_with(cx, |p, _| {
        assert_eq!(p.book().chapters[0].doc.plain_text(), text);
        assert_eq!(p.selection(), selection);
        assert_eq!(p.scroll_y().0, scroll);
    });
    let stored = call(
        &lib,
        "module.read_prose",
        json!({"book":id,"owner":entry,"module":"mod-prose"}),
    );
    assert!(
        stored["paragraphs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["text"].as_str().unwrap().contains("结构刷新"))
    );
}

#[gpui::test]
fn v4_level_switch_toggle_confirmation_conflict_and_undo(cx: &mut gpui::TestAppContext) {
    use dr_shell::{
        Services, SettingsFile, ShellInfo, Workspace as Shell,
        pages::PageViewHost,
        v3::{
            self, Rendered,
            page::{TurnOffLevelDialog, toggle_level},
        },
    };
    use gpui::{prelude::*, *};
    use std::time::{Duration, Instant};

    struct DummyPart;
    impl Render for DummyPart {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div()
        }
    }

    let (_dir, lib, id) = seed();
    let initial = Book::load(&lib, &id).unwrap();
    let b0 = initial.v3().unwrap();
    let chapter_id = b0
        .entries
        .iter()
        .find(|e| e.template.as_deref() == Some("tpl-chapter"))
        .unwrap()
        .id
        .clone();
    let member_id = b0
        .entries
        .iter()
        .find(|e| e.template.as_deref() == Some("tpl-idea"))
        .unwrap()
        .id
        .clone();

    cx.executor().allow_parking();
    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "0.2.0-dev",
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                library: Some(lib.clone()),
                book: Some(id.clone()),
                ..Default::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
        for display in ["list", "board", "grid", "table"] {
            v3::add_level_display(cx, display, |_, _, cx| Rendered::new(cx.new(|_| DummyPart)));
        }
        v3::add_level_settings(cx, |_, _, cx| Rendered::new(cx.new(|_| DummyPart)));
    });

    let (view, cx) = cx.add_window_view(Shell::new);
    let pump = |cx: &mut VisualTestContext| {
        cx.run_until_parked();
        cx.update(|window, cx| window.draw(cx).clear(cx));
        cx.run_until_parked();
    };
    let wait_book = |cx: &mut VisualTestContext,
                     pred: &dyn Fn(&dr_shell::book::v3::BookV3) -> bool| {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            pump(cx);
            if view.read_with(cx, |ws, _| ws.book.v3().is_some_and(pred)) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for book refresh"
            );
            std::thread::sleep(Duration::from_millis(2));
        }
    };
    wait_book(cx, &|_| true);

    let make_host = |cx: &VisualTestContext| {
        let book = view.read_with(cx, |ws, _| ws.book.clone());
        PageViewHost {
            workspace: view.downgrade(),
            library: lib.clone(),
            book_id: id.clone(),
            book,
        }
    };

    // 1. Turning `层级` ON and OFF when N == 0 commits directly with no dialog.
    let chapter_target = Target::from_key(&format!("entry:{chapter_id}")).unwrap();
    view.update(cx, |ws, cx| ws.open(chapter_target.clone(), Open::KEEP, cx));
    pump(cx);
    view.read_with(cx, |ws, cx| {
        let page = ws.editors[&chapter_target.key()]
            .v3
            .as_ref()
            .unwrap()
            .read(cx);
        assert!(
            !page
                .sections
                .iter()
                .any(|s| s.id == "display" || s.id == "settings")
        );
    });

    let host = make_host(cx);
    let ch = chapter_id.clone();
    cx.update(|window, cx| toggle_level(host, ch, window, cx));
    wait_book(cx, &|v| v.levels.contains_key(&chapter_id));
    view.read_with(cx, |ws, cx| {
        assert!(
            ws.dialog.is_none(),
            "opening level switch never shows a dialog"
        );
        let page = ws.editors[&chapter_target.key()]
            .v3
            .as_ref()
            .unwrap()
            .read(cx);
        let ids: Vec<_> = page.sections.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids[ids.len() - 2..], ["display", "settings"]);
    });

    let host = make_host(cx);
    let ch = chapter_id.clone();
    cx.update(|window, cx| toggle_level(host, ch, window, cx));
    wait_book(cx, &|v| !v.levels.contains_key(&chapter_id));
    view.read_with(cx, |ws, cx| {
        assert!(
            ws.dialog.is_none(),
            "closing level switch with N == 0 never shows a dialog"
        );
        let page = ws.editors[&chapter_target.key()]
            .v3
            .as_ref()
            .unwrap()
            .read(cx);
        assert!(
            !page
                .sections
                .iter()
                .any(|s| s.id == "display" || s.id == "settings")
        );
    });

    // 2. Root organizing entry with N > 0 children (one itself a level with a grandchild),
    //    overrides, swimlane identity, and an affiliated member.
    let group = call(
        &lib,
        "entry.create",
        json!({"book": id, "parent": null, "template": "tpl-group", "title": "卷一", "level": true}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    call(
        &lib,
        "entry.update",
        json!({"book": id, "id": group, "overrides": {"lane": true, "accept": true, "display": "board"}}),
    );
    call(
        &lib,
        "membership.add",
        json!({"book": id, "host": group, "member": member_id}),
    );
    let c1 = call(
        &lib,
        "entry.create",
        json!({"book": id, "parent": group, "template": "tpl-group", "title": "上篇", "level": true}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let gc1 = call(
        &lib,
        "entry.create",
        json!({"book": id, "parent": c1, "template": "tpl-chapter", "title": "楔子"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let c2 = call(
        &lib,
        "entry.create",
        json!({"book": id, "parent": group, "template": "tpl-chapter", "title": "终章"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    wait_book(cx, &|v| {
        v.levels.get(&group).is_some_and(|l| l.children.len() == 2)
    });

    let group_target = Target::from_key(&format!("entry:{group}")).unwrap();
    view.update(cx, |ws, cx| ws.open(group_target.clone(), Open::KEEP, cx));
    pump(cx);

    // Cancel leaves everything untouched.
    let host = make_host(cx);
    let g = group.clone();
    cx.update(|window, cx| toggle_level(host, g, window, cx));
    let wait_dialog = |cx: &mut VisualTestContext| -> Entity<TurnOffLevelDialog> {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            pump(cx);
            if let Some(d) = view.read_with(cx, |ws, _| {
                ws.dialog
                    .as_ref()
                    .and_then(|d| d.clone().downcast::<TurnOffLevelDialog>().ok())
            }) {
                return d;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for TurnOffLevelDialog"
            );
            std::thread::sleep(Duration::from_millis(2));
        }
    };
    let dialog = wait_dialog(cx);
    dialog.read_with(cx, |d, _| {
        assert_eq!(d.entry_id(), group);
        assert_eq!(d.child_count(), 2);
        assert!(!d.has_conflict());
    });
    dialog.update(cx, |d, cx| d.cancel(cx));
    pump(cx);
    view.read_with(cx, |ws, _| {
        assert!(ws.dialog.is_none());
        assert!(ws.book.v3().unwrap().levels.contains_key(&group));
    });

    // Re-open dialog, mutate direct children concurrently -> confirm conflicts, re-reads N == 3, asks again.
    let host = make_host(cx);
    let g = group.clone();
    cx.update(|window, cx| toggle_level(host, g, window, cx));
    let dialog = wait_dialog(cx);
    assert_eq!(dialog.read_with(cx, |d, _| d.child_count()), 2);

    let c3 = call(
        &lib,
        "entry.create",
        json!({"book": id, "parent": group, "template": "tpl-chapter", "title": "附录"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    dialog.update_in(cx, |d, window, cx| d.confirm(window, cx));
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        pump(cx);
        if dialog.read_with(cx, |d, _| !d.is_busy() && d.has_conflict()) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for conflict refresh"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    dialog.read_with(cx, |d, _| {
        assert_eq!(
            d.child_count(),
            3,
            "dialog re-read live child count after conflict"
        );
        assert!(d.has_conflict());
    });
    assert!(
        Book::load(&lib, &id)
            .unwrap()
            .v3()
            .unwrap()
            .levels
            .contains_key(&group),
        "conflicted confirm must not turn off level"
    );

    // Confirming after re-read moves direct children [c1, c2, c3] to root right after `group`,
    // keeps `gc1` under `c1`, and hides dormant swimlane / settings.
    dialog.update_in(cx, |d, window, cx| d.confirm(window, cx));
    wait_book(cx, &|v| !v.levels.contains_key(&group));
    view.read_with(cx, |ws, cx| {
        assert!(ws.dialog.is_none());
        let v = ws.book.v3().unwrap();
        assert!(!v.entry(&group).unwrap().level);
        assert!(!v.is_lane(&group));
        let pos = v.roots.iter().position(|r| r == &group).unwrap();
        assert_eq!(
            &v.roots[pos..pos + 4],
            &[group.clone(), c1.clone(), c2.clone(), c3.clone()]
        );
        assert_eq!(v.entry(&gc1).unwrap().parent.as_deref(), Some(c1.as_str()));
        assert!(v.levels.contains_key(&c1));
        let page = ws.editors[&group_target.key()]
            .v3
            .as_ref()
            .unwrap()
            .read(cx);
        assert!(
            !page
                .sections
                .iter()
                .any(|s| s.id == "display" || s.id == "settings")
        );
    });

    // Single-step Undo restores `level == true`, all children's parent + order, lane, and overrides.
    lib.undo(&Actor::User).unwrap();
    wait_book(cx, &|v| v.levels.contains_key(&group));
    view.read_with(cx, |ws, _| {
        let v = ws.book.v3().unwrap();
        assert!(v.entry(&group).unwrap().level);
        assert!(v.is_lane(&group));
        assert_eq!(v.levels[&group].settings.display, "board");
        assert_eq!(
            v.levels[&group].children,
            vec![c1.clone(), c2.clone(), c3.clone()]
        );
        assert!(
            v.memberships
                .iter()
                .any(|m| m.host == group && m.member == member_id)
        );
    });

    // Turning off and back on restores preserved overrides and memberships.
    call(
        &lib,
        "entry.set_level",
        json!({"book": id, "id": group, "level": false}),
    );
    call(
        &lib,
        "entry.set_level",
        json!({"book": id, "id": group, "level": true}),
    );
    wait_book(cx, &|v| {
        v.levels.contains_key(&group) && v.levels[&group].children.is_empty()
    });
    view.read_with(cx, |ws, _| {
        let v = ws.book.v3().unwrap();
        assert!(v.is_lane(&group));
        assert_eq!(v.levels[&group].settings.display, "board");
        assert!(
            v.memberships
                .iter()
                .any(|m| m.host == group && m.member == member_id)
        );
    });
}

#[gpui::test]
fn v4_children_module_placement_and_mod_description_ordinary_prose(cx: &mut gpui::TestAppContext) {
    use dr_editor::{ChapterEditor, EditorSettings};
    use dr_shell::{
        Services, SettingsFile, ShellInfo, Workspace as Shell,
        v3::{self, Rendered},
    };
    use gpui::{prelude::*, *};
    use std::{
        cell::RefCell,
        rc::Rc,
        time::{Duration, Instant},
    };

    struct DummyPart;
    impl Render for DummyPart {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div()
        }
    }

    let (_dir, lib, id) = seed();
    call(
        &lib,
        "entry_template.put",
        json!({
            "book": id,
            "template": {
                "id": "custom-hub",
                "name": "枢纽",
                "level": true,
                "modules": [
                    {"id": "mod-lead", "kind": "prose", "name": "引言", "pos": "a0", "config": {"in_book": false}},
                    {"id": "mod-kids", "kind": "children", "name": "下属条目", "pos": "a1"},
                    {"id": "mod-meta", "kind": "fields", "name": "属性", "pos": "a2"}
                ]
            }
        }),
    );
    let hub = call(
        &lib,
        "entry.create",
        json!({"book": id, "parent": null, "template": "custom-hub", "title": "北城枢纽"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let ms = Book::load(&lib, &id)
        .unwrap()
        .v3()
        .unwrap()
        .entries
        .iter()
        .find(|e| e.template.as_deref() == Some("tpl-manuscript"))
        .unwrap()
        .id
        .clone();

    let mounted = Rc::new(RefCell::new(Vec::new()));
    cx.executor().allow_parking();
    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "0.2.0-dev",
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                library: Some(lib.clone()),
                book: Some(id.clone()),
                ..Default::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
        let mounted = mounted.clone();
        v3::add_module_view(cx, "prose", move |host, window, cx| {
            let doc = format!("body:{}/{}", host.entry, host.module.id);
            let source = dr_editor::v3::prepare_body(
                &host.page.library,
                &host.page.book_id,
                &host.entry,
                &host.module.id,
            )
            .unwrap();
            let editor = cx.new(|cx| {
                ChapterEditor::with_session(
                    host.page.library.clone(),
                    &host.page.book_id,
                    &doc,
                    source,
                    EditorSettings::default(),
                    window,
                    cx,
                )
            });
            mounted
                .borrow_mut()
                .push((host.entry, host.module.id, editor.clone()));
            let focus = editor.read(cx).editor().focus_handle(cx);
            Rendered::new(editor).focus(focus)
        });
        v3::add_module_view(cx, "fields", |_, _, cx| {
            Rendered::new(cx.new(|_| DummyPart))
        });
        v3::add_level_display(cx, "list", |_, _, cx| Rendered::new(cx.new(|_| DummyPart)));
        v3::add_level_settings(cx, |_, _, cx| Rendered::new(cx.new(|_| DummyPart)));
    });

    let (view, cx) = cx.add_window_view(Shell::new);
    let pump = |cx: &mut VisualTestContext| {
        cx.run_until_parked();
        cx.update(|window, cx| window.draw(cx).clear(cx));
        cx.run_until_parked();
    };
    let wait_book = |cx: &mut VisualTestContext,
                     pred: &dyn Fn(&dr_shell::book::v3::BookV3) -> bool| {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            pump(cx);
            if view.read_with(cx, |ws, _| ws.book.v3().is_some_and(pred)) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for book refresh"
            );
            std::thread::sleep(Duration::from_millis(2));
        }
    };
    wait_book(cx, &|_| true);

    // Template WITH `children` module mounts it in template order (between mod-lead and mod-meta)
    // and omits it + settings when `level` is turned off.
    let hub_target = Target::from_key(&format!("entry:{hub}")).unwrap();
    view.update(cx, |ws, cx| ws.open(hub_target.clone(), Open::KEEP, cx));
    pump(cx);
    view.read_with(cx, |ws, cx| {
        let page = ws.editors[&hub_target.key()].v3.as_ref().unwrap().read(cx);
        let summary: Vec<_> = page
            .sections
            .iter()
            .map(|s| (s.id.as_str(), s.kind.as_str(), s.name.as_str()))
            .collect();
        let settings_label =
            dr_shell::strings::t(cx, dr_i18n::keys::v3_shell::SETTINGS).to_string();
        assert_eq!(
            summary,
            vec![
                ("mod-lead", "prose", "引言"),
                ("mod-kids", "list", "下属条目"),
                ("mod-meta", "fields", "属性"),
                ("settings", "settings", settings_label.as_str()),
            ]
        );
    });

    call(
        &lib,
        "entry.set_level",
        json!({"book": id, "id": hub, "level": false}),
    );
    wait_book(cx, &|v| !v.levels.contains_key(&hub));
    view.read_with(cx, |ws, cx| {
        let page = ws.editors[&hub_target.key()].v3.as_ref().unwrap().read(cx);
        let ids: Vec<_> = page.sections.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, vec!["mod-lead", "mod-meta"]);
    });

    // Former organizing levels render `mod-description` (`说明`) as ordinary prose, with no synthetic `about`.
    let ms_target = Target::from_key(&format!("entry:{ms}/mod-description")).unwrap();
    view.update(cx, |ws, cx| ws.open(ms_target.clone(), Open::KEEP, cx));
    for _ in 0..3 {
        pump(cx);
    }
    view.read_with(cx, |ws, cx| {
        let page = ws.editors[&ms_target.key()].v3.as_ref().unwrap().read(cx);
        assert!(
            !page
                .sections
                .iter()
                .any(|s| s.id == "about" || s.kind == "about")
        );
        assert_eq!(page.sections[0].id, "mod-description");
        assert_eq!(page.sections[0].kind, "prose");
    });

    let ms_editor = mounted
        .borrow()
        .iter()
        .find(|(e, m, _)| e == &ms && m == "mod-description")
        .unwrap()
        .2
        .clone();
    let prose = ms_editor.read_with(cx, |e, _| e.editor().clone());
    cx.update(|window, cx| {
        prose.update(cx, |p, cx| {
            p.select(0, 0..0, window, cx);
            p.replace_text_in_range(None, "书稿层级说明正文", window, cx);
        });
    });
    pump(cx);
    let stored = call(
        &lib,
        "module.read_prose",
        json!({"book": id, "owner": ms, "module": "mod-description"}),
    );
    assert!(
        stored["paragraphs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["text"].as_str().unwrap().contains("书稿层级说明正文"))
    );
}

#[gpui::test]
fn level_entries_expose_book_view_on_card_and_page_and_close_when_level_turns_off(
    cx: &mut gpui::TestAppContext,
) {
    use dr_shell::{
        Services, SettingsFile, ShellInfo, Workspace as Shell,
        pages::{CardRows, ModulePage, PageMenuHost},
        v3,
    };
    use gpui::{AppContext as _, IntoElement, Modifiers, Render, VisualTestContext, div};
    use std::time::{Duration, Instant};

    struct BookStub(gpui::FocusHandle);
    impl Render for BookStub {
        fn render(
            &mut self,
            _: &mut gpui::Window,
            _: &mut gpui::Context<Self>,
        ) -> impl IntoElement {
            div()
        }
    }

    let (_dir, lib, id) = seed();
    cx.executor().allow_parking();
    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "0.2.0-dev",
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                library: Some(lib.clone()),
                book: Some(id.clone()),
                ..Default::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
        dr_shell::pages::add_page_view(cx, |target, host, _, cx| {
            if !matches!(target, Target::Book(_)) || !host.book.exists(target) {
                return None;
            }
            let view = cx.new(|cx| BookStub(cx.focus_handle()));
            Some(ModulePage {
                focus: view.read(cx).0.clone(),
                view: view.into(),
            })
        });
    });

    let (view, cx) = cx.add_window_view(Shell::new);
    let pump = |cx: &mut VisualTestContext| {
        cx.run_until_parked();
        cx.update(|window, cx| window.draw(cx).clear(cx));
        cx.run_until_parked();
    };
    let wait_book = |cx: &mut VisualTestContext,
                     pred: &dyn Fn(&dr_shell::book::v3::BookV3) -> bool| {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            pump(cx);
            if view.read_with(cx, |ws, _| ws.book.v3().is_some_and(pred)) {
                return;
            }
            assert!(Instant::now() < deadline, "timed out waiting for book");
            std::thread::sleep(Duration::from_millis(2));
        }
    };
    wait_book(cx, &|_| true);

    let (roots, chapter_id, storyline_id) = view.read_with(cx, |ws, _| {
        let v = ws.book.v3().unwrap();
        let ch = v.entries.iter().find(|e| !e.level).unwrap().id.clone();
        let sl = v
            .entries
            .iter()
            .find(|e| e.level && e.parent.as_deref() == Some(v.roots[1].as_str()))
            .unwrap()
            .id
            .clone();
        (v.roots.clone(), ch, sl)
    });

    let card_ids = |cx: &mut VisualTestContext, entry_id: &str| -> Vec<String> {
        cx.update(|_, cx| {
            let book = view.read(cx).book.clone();
            let host = PageMenuHost {
                workspace: view.downgrade(),
                library: Some(lib.clone()),
                book_id: id.clone(),
                book,
            };
            let target = Target::from_key(&format!("entry:{entry_id}")).unwrap();
            v3::card::rows(&target, &host, &CardRows::default(), cx)
                .into_iter()
                .map(|r| r.id.to_string())
                .collect()
        })
    };

    // Every root level (`书稿`, `故事线`, `设定`, `漂流`) and nested level (`故事线` child)
    // exposes `"entry-open-book"` right after `"entry-open"`.
    for level_id in roots.iter().chain(std::iter::once(&storyline_id)) {
        let ids = card_ids(cx, level_id);
        assert_eq!(ids[0], "entry-open");
        assert_eq!(ids[1], "entry-open-book", "missing on level {level_id}");
    }

    // Non-level entries omit `"entry-open-book"` on both card and EntryPage.
    assert!(
        !card_ids(cx, &chapter_id)
            .iter()
            .any(|r| r == "entry-open-book")
    );
    assert!(view.read_with(cx, |ws, _| {
        !ws.book.exists(&Target::Book(chapter_id.parse().unwrap()))
    }));
    let chapter_target = Target::from_key(&format!("entry:{chapter_id}")).unwrap();
    view.update(cx, |ws, cx| ws.open(chapter_target.clone(), Open::KEEP, cx));
    pump(cx);
    assert!(
        cx.debug_bounds("v3-entry-open-book").is_none(),
        "non-level EntryPage must not render v3-entry-open-book"
    );

    // Turning `level` ON immediately exposes `v3-entry-open-book` and `"entry-open-book"`.
    call(
        &lib,
        "entry.set_level",
        json!({"book": id, "id": chapter_id, "level": true}),
    );
    wait_book(cx, &|v| v.levels.contains_key(&chapter_id));
    pump(cx);
    assert!(
        card_ids(cx, &chapter_id)
            .iter()
            .any(|r| r == "entry-open-book")
    );
    let btn = cx
        .debug_bounds("v3-entry-open-book")
        .expect("v3-entry-open-book appears when level is true");
    cx.simulate_click(btn.center(), Modifiers::none());
    pump(cx);
    let chapter_book = Target::Book(chapter_id.parse().unwrap());
    assert_eq!(
        view.read_with(cx, |ws, _| ws.nav.current().cloned()),
        Some(chapter_book.clone())
    );

    // Opening another flattened book view via `card::rows`'s `"entry-open-book"` works alongside it.
    cx.update(|window, cx| {
        let book = view.read(cx).book.clone();
        let host = PageMenuHost {
            workspace: view.downgrade(),
            library: Some(lib.clone()),
            book_id: id.clone(),
            book,
        };
        let target = Target::from_key(&format!("entry:{storyline_id}")).unwrap();
        let row = v3::card::rows(&target, &host, &CardRows::default(), cx)
            .into_iter()
            .find(|r| r.id.as_ref() == "entry-open-book")
            .unwrap();
        (row.run.unwrap())(window, cx);
    });
    pump(cx);
    let storyline_book = Target::Book(storyline_id.parse().unwrap());
    assert_eq!(
        view.read_with(cx, |ws, _| ws.nav.current().cloned()),
        Some(storyline_book.clone())
    );
    assert!(view.read_with(cx, |ws, _| ws.editors.contains_key(&chapter_book.key())));
    assert!(view.read_with(cx, |ws, _| ws.editors.contains_key(&storyline_book.key())));

    // Turning `level` OFF on `chapter_id` invalidates `Target::Book(chapter_id)` and drops its tab,
    // while keeping `Target::Book(storyline_id)` open.
    call(
        &lib,
        "entry.set_level",
        json!({"book": id, "id": chapter_id, "level": false}),
    );
    wait_book(cx, &|v| !v.levels.contains_key(&chapter_id));
    pump(cx);
    view.read_with(cx, |ws, _| {
        assert!(!ws.book.exists(&chapter_book));
        assert!(!ws.editors.contains_key(&chapter_book.key()));
        assert!(
            !ws.nav
                .tabs()
                .iter()
                .any(|t| t.leaves().any(|l| l.target == chapter_book))
        );
        assert!(ws.editors.contains_key(&storyline_book.key()));
    });

    // Trashing `storyline_id` closes its flattened book view tab too.
    call(&lib, "entry.trash", json!({"book": id, "id": storyline_id}));
    wait_book(cx, &|v| v.entry(&storyline_id).is_none());
    pump(cx);
    view.read_with(cx, |ws, _| {
        assert!(!ws.book.exists(&storyline_book));
        assert!(!ws.editors.contains_key(&storyline_book.key()));
        assert!(
            !ws.nav
                .tabs()
                .iter()
                .any(|t| t.leaves().any(|l| l.target == storyline_book))
        );
    });
}
