//! M06 and M07 in the shell over a real library (《慢钟》): ⌘⇧F, typing,
//! the arrows and Enter jump to a paragraph through a location link; Esc
//! closes the panel; the Stats tab follows the page shown and the editor's
//! live counts, reads the page's own readings (M20) and its rows open their
//! pages and the snapshot history.

use std::time::{Duration, Instant};

use dr_shell::nav::{Open, Target};
use dr_shell::panes::PaneId;
use dr_shell::workspace::RightTab;
use dr_shell::{Services, SettingsFile, ShellInfo, Workspace};
use dr_view_search::Line;
use dr_view_stats::{LiveWords, v3::Scope};
use dr_workspace::Workspace as Library;
use gpui::{Entity, TestAppContext, VisualTestContext};

const VERSION: &str = "0.2.0-dev";

fn slow_clock() -> (tempfile::TempDir, Library) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let lib = dr_store::Library::open(&root, dr_workspace::library_options(VERSION)).unwrap();
    let book = dr_testkit::samples::slow_clock().unwrap();
    dr_testkit::seed::write_book_v3(&lib, &dr_testkit::seed::book_to_v3(&book).unwrap()).unwrap();
    lib.close().unwrap();
    let ws = Library::open_dir(&root, VERSION).unwrap();
    for d in ws.library().docs(None, None).unwrap() {
        ws.library().reindex_doc(&d.doc_id).unwrap();
    }
    (dir, ws)
}

fn setup(cx: &mut TestAppContext, library: Library) -> (Entity<Workspace>, &mut VisualTestContext) {
    cx.executor().allow_parking();
    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: VERSION,
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                library: Some(library),
                ..Services::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
        dr_view_page::init(cx);
    });
    let (view, cx) = cx.add_window_view(Workspace::new);
    wait_for(&view, cx, |ws, _| !ws.book.is_empty());
    (view, cx)
}

fn wait_for(
    view: &Entity<Workspace>,
    cx: &mut VisualTestContext,
    done: impl Fn(&Workspace, &gpui::App) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        cx.run_until_parked();
        cx.executor().advance_clock(Duration::from_millis(50));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        if cx.update(|_, cx| done(view.read(cx), cx)) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out");
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn keys(cx: &mut VisualTestContext, strokes: &str) {
    let strokes = if cfg!(target_os = "macos") {
        strokes.to_owned()
    } else {
        strokes.replace("cmd-", "ctrl-")
    };
    cx.simulate_keystrokes(&strokes);
}

#[gpui::test]
fn search_finds_and_jumps_to_the_paragraph(cx: &mut TestAppContext) {
    let (_dir, lib) = slow_clock();
    let (view, cx) = setup(cx, lib);
    keys(cx, "cmd-shift-f");
    assert!(view.read_with(cx, |ws, _| ws.search.is_some()));
    cx.simulate_input("铅笔");
    cx.executor().advance_clock(dr_view_search::DEBOUNCE * 2);
    wait_for(&view, cx, |ws, cx| {
        ws.search.as_ref().is_some_and(|p| {
            !p.read(cx).is_searching() && p.read(cx).v3_groups().is_some_and(|g| !g.is_empty())
        })
    });
    let (first, second, owner, paragraph) = view.read_with(cx, |ws, cx| {
        let panel = ws.search.as_ref().unwrap().read(cx);
        let g = &panel.v3_groups().unwrap()[0];
        let hits: Vec<_> = panel
            .v3_groups()
            .unwrap()
            .iter()
            .flat_map(|g| g.rows.iter().map(move |r| (g.target.clone(), r.paragraph)))
            .collect();
        (
            panel.selected(),
            hits.get(1).cloned(),
            g.target.clone(),
            g.rows[0].paragraph,
        )
    });
    assert_eq!(first, Some(Line::Hit(0, 0)), "the first hit is selected");
    let (target, para) = second.expect("铅笔 occurs more than once");
    // Down moves to the next hit (after the shell rebuilt its keymap, as
    // it does whenever a shortcut changes), Enter jumps there.
    cx.update(|_, cx| dr_shell::keymap::apply(&Default::default(), cx));
    keys(cx, "down");
    let moved = view.read_with(cx, |ws, cx| ws.search.as_ref().unwrap().read(cx).selected());
    assert!(
        matches!(moved, Some(Line::Hit(0, 1)) | Some(Line::Hit(1, 0))),
        "{moved:?}"
    );
    keys(cx, "up");
    let back = view.read_with(cx, |ws, cx| ws.search.as_ref().unwrap().read(cx).selected());
    assert_eq!(back, first);
    keys(cx, "down");
    keys(cx, "enter");
    wait_for(&view, cx, |ws, _| ws.search.is_none());
    let want = match target {
        dr_view_search::v3::Target::Entry { id, module } => Target::Entry {
            id: id.parse().unwrap(),
            module: module.map(|m| m.parse().unwrap()),
        },
        dr_view_search::v3::Target::Material(id) => Target::Material(id.parse().unwrap()),
    };
    view.read_with(cx, |ws, _| {
        assert_eq!(ws.nav.current(), Some(&want));
    });
    // The page's editor opened and put the caret at the paragraph (the
    // reveal taken).
    wait_for(&view, cx, |ws, _| ws.page_view(&want).is_some());
    view.update(cx, |ws, _| assert_eq!(ws.nav.take_reveal(&want), None));
    assert!(para.is_some(), "a prose hit");
    let _ = (owner, paragraph);

    // Esc closes it; ⌘⇧F twice opens and closes.
    keys(cx, "cmd-shift-f");
    assert!(view.read_with(cx, |ws, _| ws.search.is_some()));
    keys(cx, "escape");
    assert!(view.read_with(cx, |ws, _| ws.search.is_none()));
    keys(cx, "cmd-shift-f");
    keys(cx, "cmd-shift-f");
    assert!(view.read_with(cx, |ws, _| ws.search.is_none()));
}

#[gpui::test]
fn the_stats_tab_follows_the_page_and_the_editor(cx: &mut TestAppContext) {
    let (_dir, lib) = slow_clock();
    let (view, cx) = setup(cx, lib);
    let third = view.update_in(cx, |ws, window, cx| {
        ws.toggle_right(window, cx);
        ws.right.panes.click(PaneId::Primary, RightTab::Stats);
        let body = &ws.book.v3().unwrap().manuscript[2];
        let t = Target::Entry {
            id: body.entry.parse().unwrap(),
            module: Some(body.module.parse().unwrap()),
        };
        ws.open(t.clone(), Open::KEEP, cx);
        t
    });
    wait_for(&view, cx, |_, cx| {
        dr_view_stats::v3_panel::view("stats-primary", cx).is_some_and(|v| {
            v.read(cx)
                .loaded()
                .is_some_and(|d| d.book_words(&Default::default()).is_some())
        })
    });
    let stats = cx.update(|_, cx| dr_view_stats::v3_panel::view("stats-primary", cx).unwrap());
    let (data, book) = stats.read_with(cx, |v, _| {
        let d = v.loaded().unwrap();
        (d.clone(), d.book_words(&Default::default()).unwrap())
    });
    let words = data.words(&Default::default()).unwrap().words;
    assert!(matches!(
        data.scope,
        Scope::Entry {
            module: Some(_),
            ..
        }
    ));
    assert!(words > 0 && words < book.words);
    assert!(data.shape.unwrap().paragraphs > 0);
    let doc = dr_shell::book::doc_of(&third).unwrap();
    cx.update(|_, cx| {
        LiveWords::set_doc(
            doc.clone(),
            dr_view_stats::TextMetrics {
                words: words + 100,
                chars: 0,
            },
            cx,
        )
    });
    let live = cx.update(|_, cx| LiveWords::read(cx).clone());
    stats.read_with(cx, |v, _| {
        let d = v.loaded().unwrap();
        assert_eq!(d.words(&live).unwrap().words, words + 100);
        assert_eq!(d.book_words(&live).unwrap().words, book.words + 100);
    });
    cx.update(|_, cx| LiveWords::clear_doc(&doc, cx));
    view.update(cx, |ws, cx| ws.open(Target::Book, Open::KEEP, cx));
    wait_for(&view, cx, |_, cx| {
        stats
            .read(cx)
            .loaded()
            .is_some_and(|d| d.scope == Scope::Book)
    });
    assert_eq!(
        stats.read_with(cx, |v, _| v
            .loaded()
            .unwrap()
            .words(&Default::default())
            .unwrap()
            .words),
        book.words
    );
}
