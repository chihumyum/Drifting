//! K4-0 contracts against the shared synthetic seed, plus the unchanged v2.2 path.
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
    assert!(b.chapters.is_empty());
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
    let legacy = call(&ws, "book.create", json!({"name":"Synthetic v2.2"}));
    let legacy = Book::load(&ws, legacy["id"].as_str().unwrap()).unwrap();
    assert!(matches!(legacy.snapshot, Snapshot::V22(_)));
    assert!(legacy.v3().is_none());
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
        dr_shell::pages::add_bottom_panel(cx, dr_shell::pages::BottomPane::Timeline, |_, _, _| {
            panic!("a v3 book must never mount the v2.2 timeline")
        });
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
