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
use dr_view_stats::detail::Detail;
use dr_view_stats::{LiveWords, Scope, StatsAction};
use dr_workspace::Workspace as Library;
use gpui::{Entity, TestAppContext, VisualTestContext};

const VERSION: &str = "0.2.0-dev";

fn slow_clock() -> (tempfile::TempDir, Library) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let lib = dr_store::Library::open(&root, dr_workspace::library_options(VERSION)).unwrap();
    let book = dr_testkit::samples::slow_clock().unwrap();
    dr_testkit::seed::write_book(&lib, &book).unwrap();
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
        ws.search
            .as_ref()
            .is_some_and(|p| !p.read(cx).is_searching() && !p.read(cx).groups().is_empty())
    });
    let (first, second, owner, paragraph) = view.read_with(cx, |ws, cx| {
        let panel = ws.search.as_ref().unwrap().read(cx);
        let g = &panel.groups()[0];
        let hits: Vec<_> = panel
            .groups()
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
    let want = dr_shell::book::target(target);
    view.read_with(cx, |ws, _| {
        assert_eq!(ws.nav.current(), Some(&want));
    });
    // The page's editor opened and put the caret at the paragraph (the
    // reveal taken).
    wait_for(&view, cx, |ws, _| ws.editor_of(&want).is_some());
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
        let c = Target::Chapter(ws.book.chapters[2].id.parse().unwrap());
        ws.open(c.clone(), Open::KEEP, cx);
        c
    });
    let stats =
        |cx: &mut VisualTestContext| cx.update(|_, cx| dr_view_stats::view("stats-primary", cx));
    wait_for(&view, cx, |_, cx| {
        dr_view_stats::view("stats-primary", cx)
            .is_some_and(|v| v.read(cx).book_words(cx).is_some())
    });
    let s = stats(cx).unwrap();
    let (reading, book) = cx.update(|_, cx| (s.read(cx).reading(cx), s.read(cx).book_words(cx)));
    assert_eq!(reading.scope, Scope::Chapter);
    let words = reading.words.expect("counted");
    assert!(words > 0 && Some(words) < book);
    // The editor's own count wins over the index's, in the book's total too.
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
    let (live, live_book) = cx.update(|_, cx| (s.read(cx).reading(cx), s.read(cx).book_words(cx)));
    assert_eq!(live.words, Some(words + 100));
    assert_eq!(live_book, book.map(|b| b + 100));
    cx.update(|_, cx| LiveWords::set_selection(Some(7), cx));
    assert_eq!(
        cx.update(|_, cx| s.read(cx).reading(cx)).scope,
        Scope::Selection
    );
    cx.update(|_, cx| {
        LiveWords::set_selection(None, cx);
        LiveWords::clear_doc(&doc, cx);
    });
    // M20: the chapter's own readings, and its rows open what they name.
    wait_for(&view, cx, |_, cx| {
        dr_view_stats::view("stats-primary", cx).is_some_and(|v| v.read(cx).detail().is_some())
    });
    let (name, detail, hooks) = cx.update(|_, cx| {
        let v = s.read(cx);
        let d = v.detail().unwrap();
        (
            d.name.clone(),
            d.detail.clone(),
            v.hooks().cloned().expect("the shell's hooks"),
        )
    });
    let Detail::Page(page) = detail else {
        panic!("{detail:?}")
    };
    assert!(page.shape.paragraphs > 0 && page.shape.sentences >= page.shape.paragraphs);
    assert_eq!(page.number, Some(3));
    // The sample links its people in the prose and files chapters under
    // storylines: the row opens the storyline, or the first element.
    let row = page
        .storyline
        .clone()
        .map(|s| s.0)
        .or_else(|| page.elements.first().map(|r| r.target.clone()))
        .expect("a storyline or an element of the third chapter");
    cx.update(|window, cx| {
        (hooks.act)(
            StatsAction::Open {
                target: row.clone(),
                link: None,
            },
            window,
            cx,
        )
    });
    let opened = view.read_with(cx, |ws, _| ws.nav.current().map(dr_shell::book::nav_target));
    assert_eq!(opened, Some(row));
    cx.update(|window, cx| {
        (hooks.act)(
            StatsAction::History {
                doc: doc.clone(),
                name,
            },
            window,
            cx,
        )
    });
    assert!(
        view.read_with(cx, |ws, _| ws.history.is_some()),
        "M09's history opened"
    );
    view.update(cx, |ws, cx| {
        ws.history = None;
        cx.notify();
    });
    // The whole book's page reads the book.
    view.update(cx, |ws, cx| ws.open(Target::Book, Open::KEEP, cx));
    wait_for(&view, cx, |_, cx| {
        dr_view_stats::view("stats-primary", cx)
            .is_some_and(|v| v.read(cx).reading(cx).scope == Scope::Book)
    });
    assert_eq!(cx.update(|_, cx| s.read(cx).reading(cx)).words, book);
    wait_for(&view, cx, |_, cx| {
        dr_view_stats::view("stats-primary", cx).is_some_and(|v| {
            matches!(
                v.read(cx).detail().map(|d| &d.detail),
                Some(Detail::Book(_))
            )
        })
    });
    let Some(Detail::Book(whole)) =
        cx.update(|_, cx| s.read(cx).detail().map(|d| d.detail.clone()))
    else {
        unreachable!()
    };
    assert!(!whole.chapters.is_empty());
    assert_eq!(
        whole.statuses.active() + whole.statuses.discarded,
        whole.chapters.len() as u32
    );
}
