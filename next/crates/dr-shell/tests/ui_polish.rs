//! UP (visual polish) regressions in the shell.
use std::time::{Duration, Instant};

use dr_shell::{
    Services, SettingsFile, ShellInfo, Workspace as Shell,
    v3::{self, Rendered},
    workspace::FillPlace,
};
use dr_workspace::Workspace;
use gpui::{
    App, AppContext as _, Context, Entity, InteractiveElement as _, IntoElement, Render,
    Styled as _, TestAppContext, VisualTestContext, Window, div,
};

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

struct DummyPart;
impl Render for DummyPart {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
    }
}

fn open<'a>(
    cx: &'a mut TestAppContext,
    lib: &Workspace,
    id: &str,
) -> (Entity<Shell>, &'a mut VisualTestContext) {
    open_with_settings(cx, lib, id, SettingsFile::in_memory())
}

fn open_with_settings<'a>(
    cx: &'a mut TestAppContext,
    lib: &Workspace,
    id: &str,
    settings: SettingsFile,
) -> (Entity<Shell>, &'a mut VisualTestContext) {
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
                book: Some(id.to_owned()),
                ..Default::default()
            },
            settings,
            cx,
        );
        dr_shell::strings::Strings::install(dr_i18n::Locale::ZhCn, cx);
        for display in ["list", "board", "grid", "island"] {
            v3::add_level_display(cx, display, move |_, _, cx| {
                Rendered::new(cx.new(|_| KindPart(display)))
            });
        }
        v3::add_level_settings(cx, |_, _, cx| Rendered::new(cx.new(|_| DummyPart)));
        v3::set_tab_canvas(cx, |host, _, cx| {
            let kind = match host.layout {
                dr_shell::v3::tab_fill::FillLayout::Island => "canvas-island",
                dr_shell::v3::tab_fill::FillLayout::Relation => "canvas-relation",
                _ => panic!("only the two canvas layouts use this host"),
            };
            Rendered::new(cx.new(|_| KindPart(kind)))
        });
    });
    let (view, cx) = cx.add_window_view(Shell::new);
    cx.update(|window, _| window.activate_window());
    (view, cx)
}

fn pump(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.run_until_parked();
}

fn wait(
    view: &Entity<Shell>,
    cx: &mut VisualTestContext,
    what: &str,
    done: impl Fn(&Shell, &App) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        cx.executor().advance_clock(Duration::from_millis(40));
        pump(cx);
        if view.read_with(cx, |ws, cx| done(ws, cx)) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(2));
    }
}

/// The paper's corner (the timeline's bamboo, the page tools, the incense
/// stick) stands at the paper's bottom right. A side panel filled over the
/// whole middle column leaves no paper, and the corner stood on that panel's
/// own foot instead: over the left column's 进模板结构 and 新建模板.
#[gpui::test]
fn a_fill_over_the_paper_takes_the_corner_with_the_paper(cx: &mut TestAppContext) {
    let (_dir, lib, id) = seed();
    let (view, cx) = open(cx, &lib, &id);
    wait(&view, cx, "the book", |ws, _| ws.book.v3().is_some());
    assert!(
        cx.debug_bounds("paper-corner").is_some(),
        "the corner by the paper"
    );
    for place in [FillPlace::Left, FillPlace::Right] {
        cx.update(|window, cx| {
            view.update(cx, |ws, cx| {
                ws.enter_fill(place, window, cx);
            })
        });
        wait(&view, cx, "the filled column", |ws, _| {
            ws.is_filled(place) && ws.fill_progress(place) >= 1.0
        });
        assert!(
            cx.debug_bounds("paper-corner").is_none(),
            "{place:?} filled over the paper, the corner went with it"
        );
        cx.update(|window, cx| view.update(cx, |ws, cx| ws.exit_fill(window, cx)));
        wait(&view, cx, "the paper again", |ws, _| ws.filled().is_none());
        assert!(
            cx.debug_bounds("paper-corner").is_some(),
            "the corner is back"
        );
    }
}

/// The sync mark at the paper's bottom left (a sync under way, or one that
/// failed) is the paper's other corner: a fill over the paper takes it too,
/// or it stood on the filled panel.
#[gpui::test]
fn a_fill_over_the_paper_takes_the_sync_mark_with_the_paper(cx: &mut TestAppContext) {
    use dr_shell::sync::{MarkSpec, MarkVisual, set_mark_hook};
    let (_dir, lib, id) = seed();
    let (view, cx) = open(cx, &lib, &id);
    cx.update(|_, cx| {
        set_mark_hook(cx, |_, _, _, _, _| {
            Some(MarkSpec {
                visual: MarkVisual::DangerExclamation,
                faded_for_typing: false,
                title: "Synthetic sync failure".into(),
                detail: "Synthetic".into(),
                meta: None,
                progress: None,
                actions: Vec::new(),
            })
        });
    });
    wait(&view, cx, "the book", |ws, _| ws.book.v3().is_some());
    let deadline = Instant::now() + Duration::from_secs(10);
    while cx.debug_bounds("paper-sync-mark").is_none() {
        cx.executor().advance_clock(Duration::from_millis(40));
        pump(cx);
        assert!(Instant::now() < deadline, "the sync mark by the paper");
    }
    for place in [FillPlace::Left, FillPlace::Right] {
        cx.update(|window, cx| {
            view.update(cx, |ws, cx| {
                ws.enter_fill(place, window, cx);
            })
        });
        wait(&view, cx, "the filled column", |ws, _| {
            ws.is_filled(place) && ws.fill_progress(place) >= 1.0
        });
        assert!(
            cx.debug_bounds("paper-sync-mark").is_none(),
            "{place:?} filled over the paper, the sync mark went with it"
        );
        cx.update(|window, cx| view.update(cx, |ws, cx| ws.exit_fill(window, cx)));
        wait(&view, cx, "the paper again", |ws, _| ws.filled().is_none());
        let deadline = Instant::now() + Duration::from_secs(10);
        while cx.debug_bounds("paper-sync-mark").is_none() {
            cx.executor().advance_clock(Duration::from_millis(40));
            pump(cx);
            assert!(Instant::now() < deadline, "the sync mark is back");
        }
    }
}

/// A level display that says which kind it is, where it was drawn.
struct KindPart(&'static str);
impl Render for KindPart {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let kind = self.0;
        div()
            .debug_selector(move || format!("kind-part-{kind}"))
            .size_full()
    }
}

/// UP (kernel-v5 §15 item 50, P10): a Tab has its five displays only when
/// the left column is filled; unfilled, a board is drawn as the list tree
/// (grid and island both use the category-framed compact index).
#[gpui::test]
fn an_unfilled_column_draws_a_board_tab_as_the_list(cx: &mut TestAppContext) {
    use dr_workspace::Actor;
    use serde_json::json;
    let (_dir, lib, id) = seed();
    let root = {
        let book = dr_shell::book::Book::load(&lib, &id).unwrap();
        book.v3().unwrap().roots[0].clone()
    };
    lib.call(
        &Actor::User,
        "entry.update",
        json!({"book": id, "id": root, "overrides": {"display": "board"}}),
    )
    .unwrap();
    // The seed may have a Tab on it already (an entry has one Tab at most).
    if let Err(e) = lib.call(
        &Actor::User,
        "tab.put",
        json!({"book": id, "mount": {"kind": "entry", "entry": root}}),
    ) {
        assert!(format!("{e:?}").contains("TAB-MOUNT-ONCE"), "{e:?}");
    }
    let (view, cx) = open(cx, &lib, &id);
    cx.update(|_, cx| {
        for kind in ["list", "board", "grid", "island"] {
            v3::add_level_display(cx, kind, move |_, _, cx| {
                Rendered::new(cx.new(|_| KindPart(kind)))
            });
        }
    });
    wait(&view, cx, "the book", |ws, _| ws.book.v3().is_some());
    cx.update(|window, cx| {
        view.update(cx, |ws, cx| {
            if !ws.left.open {
                ws.toggle_left(window, cx);
            }
        })
    });
    wait(&view, cx, "the left column", |ws, _| {
        ws.v3_sidebar.is_some() && ws.left.shown() >= 1.0
    });
    let sidebar = view.read_with(cx, |ws, _| ws.v3_sidebar.clone().unwrap());
    let tab = root.clone();
    sidebar.update(cx, |s, cx| s.select(&tab, cx));
    wait(&view, cx, "the Tab's list", |_, _| true);
    let deadline = Instant::now() + Duration::from_secs(10);
    while cx.debug_bounds("kind-part-list").is_none() {
        cx.executor().advance_clock(Duration::from_millis(40));
        pump(cx);
        assert!(
            Instant::now() < deadline,
            "the board Tab drew {:?} unfilled",
            ["board", "grid", "island"].iter().find(|k| cx
                .debug_bounds(Box::leak(format!("kind-part-{k}").into_boxed_str()))
                .is_some())
        );
    }
    assert!(cx.debug_bounds("kind-part-board").is_none());
}

fn drawn_kind(cx: &mut VisualTestContext, kind: &'static str) {
    let selector: &'static str = Box::leak(format!("kind-part-{kind}").into_boxed_str());
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        cx.executor().advance_clock(Duration::from_millis(40));
        pump(cx);
        if cx
            .debug_bounds(selector)
            .is_some_and(|b| b.size.width > gpui::px(0.0) && b.size.height > gpui::px(0.0))
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the routed {kind} surface was not drawn"
        );
    }
    for other in [
        "list",
        "board",
        "grid",
        "island",
        "canvas-island",
        "canvas-relation",
    ] {
        if other != kind {
            let selector: &'static str = Box::leak(format!("kind-part-{other}").into_boxed_str());
            assert!(
                cx.debug_bounds(selector).is_none(),
                "{other} was also drawn with {kind}"
            );
        }
    }
}

/// Actual shell routing through fill / exit / refill for all five choices,
/// followed by a fresh app context using the saved device settings. The
/// registered parts identify their real host; compact frame geometry is
/// exercised with the real display in dr-view-elements::ui_polish.
#[gpui::test]
fn all_five_filled_choices_survive_compact_round_trips_and_device_restore(
    cx: &mut TestAppContext,
    again: &mut TestAppContext,
) {
    use dr_shell::v3::tab_fill::FillLayout;
    use dr_workspace::Actor;
    use serde_json::json;
    let (_dir, lib, book) = seed();
    let settings = tempfile::tempdir().unwrap();
    let raw = ["list", "grid", "board", "island", "list"];
    let unfilled = ["list", "island", "list", "island", "list"];
    let filled = ["list", "grid", "board", "canvas-island", "canvas-relation"];
    let mut entries = Vec::new();
    for (i, display) in raw.iter().enumerate() {
        let made = lib.call(&Actor::User, "entry.create", json!({"book": book, "template": "tpl-group", "title": format!("合成摆法{i}"), "level": true})).unwrap();
        let entry = made["output"]["id"].as_str().unwrap().to_owned();
        lib.call(
            &Actor::User,
            "entry.update",
            json!({"book": book, "id": entry, "overrides": {"display": display}}),
        )
        .unwrap();
        lib.call(
            &Actor::User,
            "tab.put",
            json!({"book": book, "mount": {"kind": "entry", "entry": entry}}),
        )
        .unwrap();
        entries.push(entry);
    }
    let (view, cx) = open_with_settings(cx, &lib, &book, SettingsFile::open(settings.path()));
    wait(&view, cx, "the loaded book", |ws, _| {
        ws.book.v3().is_some() && ws.book_memory_ready()
    });
    view.update_in(cx, |ws, window, cx| {
        if !ws.left.open {
            ws.toggle_left(window, cx);
        }
    });
    wait(&view, cx, "the open left column", |ws, _| {
        ws.v3_sidebar.is_some() && ws.left.shown() >= 1.0
    });
    let sidebar = view.read_with(cx, |ws, _| ws.v3_sidebar.clone().unwrap());
    let mut tab_ids = Vec::new();
    for (i, layout) in FillLayout::ALL.into_iter().enumerate() {
        sidebar.update(cx, |s, cx| s.select(&entries[i], cx));
        tab_ids.push(sidebar.read_with(cx, |s, cx| {
            s.state(cx)["selected"].as_str().unwrap().to_owned()
        }));
        drawn_kind(cx, unfilled[i]);
        view.update_in(cx, |ws, window, cx| {
            ws.enter_fill(FillPlace::Left, window, cx)
        });
        wait(&view, cx, "filled", |ws, _| {
            ws.is_filled(FillPlace::Left) && ws.fill_progress(FillPlace::Left) >= 1.0
        });
        if raw[i] == "island" {
            drawn_kind(cx, "canvas-relation");
            assert_eq!(
                sidebar.read_with(cx, |s, cx| s.state(cx)["fillLayout"].clone()),
                json!(FillLayout::Relation),
                "island's original default remains Relation"
            );
        }
        sidebar.update(cx, |s, cx| s.choose_fill_layout(layout, cx));
        drawn_kind(cx, filled[i]);
        view.update_in(cx, |ws, window, cx| ws.exit_fill(window, cx));
        wait(&view, cx, "unfilled", |ws, _| ws.filled().is_none());
        drawn_kind(cx, unfilled[i]);
        view.update_in(cx, |ws, window, cx| {
            ws.enter_fill(FillPlace::Left, window, cx)
        });
        wait(&view, cx, "refilled", |ws, _| {
            ws.is_filled(FillPlace::Left) && ws.fill_progress(FillPlace::Left) >= 1.0
        });
        drawn_kind(cx, filled[i]);
        view.update_in(cx, |ws, window, cx| ws.exit_fill(window, cx));
        wait(&view, cx, "unfilled again", |ws, _| ws.filled().is_none());
    }
    view.update(cx, |ws, cx| ws.store_layout(cx));
    cx.update(|_, cx| dr_shell::Settings::flush(cx));
    let saved = SettingsFile::open(settings.path());
    for (i, layout) in FillLayout::ALL.into_iter().enumerate() {
        assert_eq!(
            saved.layout(&book).unwrap()["tab_fill_layouts"][&tab_ids[i]],
            json!(layout)
        );
    }
    let (restored, again) = open_with_settings(again, &lib, &book, saved);
    wait(&restored, again, "the restored book", |ws, _| {
        ws.book.v3().is_some() && ws.book_memory_ready() && ws.v3_sidebar.is_some()
    });
    let sidebar = restored.read_with(again, |ws, _| ws.v3_sidebar.clone().unwrap());
    for (i, layout) in FillLayout::ALL.into_iter().enumerate() {
        sidebar.update(again, |s, cx| s.select(&entries[i], cx));
        drawn_kind(again, unfilled[i]);
        restored.update_in(again, |ws, window, cx| {
            ws.enter_fill(FillPlace::Left, window, cx)
        });
        wait(&restored, again, "restored fill", |ws, _| {
            ws.is_filled(FillPlace::Left) && ws.fill_progress(FillPlace::Left) >= 1.0
        });
        drawn_kind(again, filled[i]);
        assert_eq!(
            sidebar.read_with(again, |s, cx| s.state(cx)["fillLayout"].clone()),
            json!(layout)
        );
        restored.update_in(again, |ws, window, cx| ws.exit_fill(window, cx));
        wait(&restored, again, "restored compact", |ws, _| {
            ws.filled().is_none()
        });
        drawn_kind(again, unfilled[i]);
    }
    let snapshot = dr_shell::book::Book::load(&lib, &book).unwrap();
    for (i, entry) in entries.iter().enumerate() {
        assert_eq!(
            snapshot.v3().unwrap().levels[entry].settings.display,
            raw[i],
            "fill choice never writes the entry's display"
        );
    }
}
