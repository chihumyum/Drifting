//! The workspace on GPUI's test platform: shortcuts reach their actions
//! through the keymap, Esc closes layers one at a time, rebinding takes
//! effect at once, deep links open pages, the layout comes back; and over a
//! real library (the showcase's 《慢钟》, seeded through dr-testkit): the
//! panels list it from F3's queries, a chapter opens in its editor and what
//! is typed there (Enter, undo, redo, switching chapters) is kept through a
//! restart and reaches search and the word count, the whole book reads every
//! chapter, a chapter trashed through F3 closes its tab.

use std::sync::Arc;
use std::time::{Duration, Instant};

use dr_editor::ChapterEditor;
use dr_platform::DeepLinks;
use dr_shell::nav::{Open, Page, Target};
use dr_shell::panes::PaneId;
use dr_shell::settings::registry;
use dr_shell::workspace::editors::PageView;
use dr_shell::workspace::{Layer, SuperView};
use dr_shell::{Services, Settings, SettingsFile, ShellInfo, Workspace};
use dr_workspace::{Actor, Workspace as Library};
use gpui::{AppContext as _, Entity, Focusable as _, TestAppContext, VisualTestContext};
use serde_json::{Value, json};

const SCHEME: &str = "drifting-next-dev";

fn info() -> ShellInfo {
    ShellInfo {
        app_name: "Drifting Next",
        bundle_id: "cc.drifting.next.dev",
        version: "0.2.0-dev",
        url_scheme: SCHEME,
        forced_appearance: None,
    }
}

const VERSION: &str = "0.2.0-dev";

/// A library holding 《慢钟》 (dr-testkit's sample, written for Drifting).
fn slow_clock() -> (tempfile::TempDir, Library) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let lib = dr_store::Library::open(&root, dr_workspace::library_options(VERSION)).unwrap();
    let book = dr_testkit::samples::slow_clock().unwrap();
    dr_testkit::seed::write_book(&lib, &book).unwrap();
    lib.close().unwrap();
    (dir, Library::open_dir(&root, VERSION).unwrap())
}

fn setup(
    cx: &mut TestAppContext,
    file: SettingsFile,
    links: Option<Arc<DeepLinks>>,
) -> (Entity<Workspace>, &mut VisualTestContext) {
    setup_with(cx, file, links, None)
}

fn setup_with(
    cx: &mut TestAppContext,
    file: SettingsFile,
    links: Option<Arc<DeepLinks>>,
    library: Option<Library>,
) -> (Entity<Workspace>, &mut VisualTestContext) {
    if library.is_some() {
        // F3 reads and delivers events on its own threads.
        cx.executor().allow_parking();
    }
    cx.update(|cx| {
        dr_shell::init(
            info(),
            Services {
                deep_links: links,
                crash_reports: None,
                library,
                book: None,
            },
            file,
            cx,
        );
    });
    let (view, cx) = cx.add_window_view(Workspace::new);
    cx.run_until_parked();
    (view, cx)
}

/// Runs the app until `done` holds (F3's threads deliver in their own
/// time), at most five seconds.
fn wait_for(
    view: &Entity<Workspace>,
    cx: &mut VisualTestContext,
    done: impl Fn(&Workspace) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        cx.run_until_parked();
        if view.read_with(cx, |ws, _| done(ws)) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out");
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn chapter_of(ws: &Workspace, i: usize) -> Target {
    Target::Chapter(ws.book.chapters[i].id.parse().unwrap())
}

fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| window.draw(cx).clear(cx));
}

/// Draws until `target`'s editor is open and has the keyboard, and once more
/// so it is painted (an editor takes typing once it has painted focused).
fn open_editor(
    view: &Entity<Workspace>,
    cx: &mut VisualTestContext,
    target: &Target,
) -> Entity<ChapterEditor> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        draw(cx);
        cx.run_until_parked();
        let editor = view.read_with(cx, |ws, _| ws.editor_of(target).cloned());
        if let Some(editor) = editor {
            draw(cx);
            let focused = cx.update(|window, cx| {
                let prose = editor.read(cx).editor().focus_handle(cx);
                window.focused(cx) == Some(prose)
            });
            assert!(focused, "the open page's editor takes the keyboard");
            draw(cx);
            return editor;
        }
        assert!(Instant::now() < deadline, "the editor did not open");
        std::thread::sleep(Duration::from_millis(2));
    }
}

/// Types `text` a character at a time, the way the system's input method
/// hands it over.
fn type_text(cx: &mut VisualTestContext, text: &str) {
    for c in text.chars() {
        cx.simulate_input(&c.to_string());
    }
    cx.run_until_parked();
}

fn out(lib: &Library, name: &str, input: Value) -> Value {
    lib.call(&Actor::User, name, input)
        .unwrap_or_else(|e| panic!("{name}: {e}"))["output"]
        .clone()
}

/// A document's paragraphs as F3 reads them (what search, export and the
/// Agent see).
fn stored(lib: &Library, doc: &str) -> Vec<String> {
    out(lib, "prose.read", json!({"doc": doc}))["paragraphs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["text"].as_str().unwrap().to_owned())
        .collect()
}

/// [`counted`] once a new library's first indexing in the background has
/// settled (the same two answers 300 ms apart).
fn settled(lib: &Library, book: &str, query: &str) -> (u64, usize) {
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut last = counted(lib, book, query);
    loop {
        std::thread::sleep(Duration::from_millis(300));
        let now = counted(lib, book, query);
        if (now == last && now.0 > 0) || Instant::now() > deadline {
            return now;
        }
        last = now;
    }
}

/// The book's word count and the search hits for `query`, once F2 has
/// indexed the open documents (the quit hook makes it now) and the stale
/// rest (F2 catches those up only after 500 ms without a write, and each
/// call here writes, so it is made now too).
fn counted(lib: &Library, book: &str, query: &str) -> (u64, usize) {
    lib.before_quit();
    lib.library()
        .rebuild_stale_indexes()
        .expect("stale indexes rebuilt");
    let words = out(lib, "book.get", json!({"book": book}))["words"]
        .as_u64()
        .unwrap();
    let hits = out(lib, "book.search", json!({"book": book, "query": query}));
    let hits = hits
        .as_array()
        .or_else(|| hits["hits"].as_array())
        .map_or(0, Vec::len);
    (words, hits)
}

/// Presses `strokes` until `done` holds, at most `times` times.
fn press_until(
    cx: &mut VisualTestContext,
    strokes: &str,
    times: usize,
    mut done: impl FnMut() -> bool,
) -> bool {
    for _ in 0..times {
        if done() {
            return true;
        }
        keys(cx, strokes);
        cx.run_until_parked();
    }
    done()
}

/// The tests write the primary modifier as `cmd-`; elsewhere it is Ctrl.
fn keys(cx: &mut VisualTestContext, strokes: &str) {
    let strokes = if cfg!(target_os = "macos") {
        strokes.to_owned()
    } else {
        strokes.replace("cmd-", "ctrl-")
    };
    cx.simulate_keystrokes(&strokes);
}

fn chapter(n: u8) -> Target {
    Target::Chapter(format!("ch-{n}").parse().unwrap())
}

#[gpui::test]
fn shortcuts_go_back_and_forward_through_the_keymap(cx: &mut TestAppContext) {
    let (view, cx) = setup(cx, SettingsFile::in_memory(), None);
    view.update(cx, |ws, cx| {
        ws.open(chapter(1), Open::KEEP, cx);
        ws.open(chapter(2), Open::KEEP, cx);
    });
    keys(cx, "cmd-[");
    assert_eq!(
        view.read_with(cx, |ws, _| ws.nav.page()),
        Page::Target(chapter(1))
    );
    keys(cx, "cmd-]");
    assert_eq!(
        view.read_with(cx, |ws, _| ws.nav.page()),
        Page::Target(chapter(2))
    );
    // ⌘⌥← and ⇧⌘[ both go to the previous tab; ⌘W closes it.
    keys(cx, "cmd-alt-left");
    assert_eq!(
        view.read_with(cx, |ws, _| ws.nav.page()),
        Page::Target(chapter(1))
    );
    keys(cx, "cmd-shift-]");
    assert_eq!(
        view.read_with(cx, |ws, _| ws.nav.page()),
        Page::Target(chapter(2))
    );
    keys(cx, "cmd-w");
    assert_eq!(view.read_with(cx, |ws, _| ws.nav.tabs().len()), 1);
    // ⌘N goes home; ⌘⌥2 opens the whole book.
    keys(cx, "cmd-n");
    assert_eq!(view.read_with(cx, |ws, _| ws.nav.page()), Page::Home);
    keys(cx, "cmd-alt-2");
    assert_eq!(
        view.read_with(cx, |ws, _| ws.nav.page()),
        Page::Target(Target::Book)
    );
}

#[gpui::test]
fn escape_closes_one_layer_at_a_time(cx: &mut TestAppContext) {
    let (view, cx) = setup(cx, SettingsFile::in_memory(), None);
    keys(cx, "cmd-alt-4");
    assert_eq!(
        view.read_with(cx, |ws, _| ws.super_view),
        Some(SuperView::Elements)
    );
    view.update_in(cx, |ws, window, cx| ws.open_settings(window, cx));
    view.update(cx, |ws, cx| {
        ws.notifications_open = true;
        cx.notify();
    });
    cx.run_until_parked();
    let top = |cx: &mut VisualTestContext| view.read_with(cx, |ws, _| ws.top_layer());
    assert_eq!(top(cx), Some(Layer::Notifications));
    view.update_in(cx, |ws, window, cx| ws.dismiss(window, cx));
    assert_eq!(top(cx), Some(Layer::Settings));
    // The settings search field has the focus: its Esc clears, then closes.
    keys(cx, "escape");
    cx.run_until_parked();
    assert_eq!(top(cx), Some(Layer::SuperView));
    keys(cx, "escape");
    assert_eq!(top(cx), None);
    // ⌘⌥4 twice toggles; ⌘[ closes a Super View before going back.
    view.update(cx, |ws, cx| ws.open(chapter(1), Open::KEEP, cx));
    keys(cx, "cmd-alt-3");
    keys(cx, "cmd-[");
    assert_eq!(
        view.read_with(cx, |ws, _| (ws.super_view, ws.nav.page())),
        (None, Page::Target(chapter(1)))
    );
}

#[gpui::test]
fn a_rebound_shortcut_takes_effect_at_once_and_is_stored(cx: &mut TestAppContext) {
    let (view, cx) = setup(cx, SettingsFile::in_memory(), None);
    view.update(cx, |ws, cx| {
        ws.open(chapter(1), Open::KEEP, cx);
        ws.open(chapter(2), Open::KEEP, cx);
    });
    cx.update(|_, cx| {
        Settings::update(cx, |file| {
            file.set_key_binding("goBack", Some("alt-secondary-b"))
        });
        let overrides = Settings::read(cx).key_bindings();
        dr_shell::keymap::apply(&overrides, cx);
    });
    keys(cx, "cmd-[");
    assert_eq!(
        view.read_with(cx, |ws, _| ws.nav.page()),
        Page::Target(chapter(2)),
        "the old key no longer goes back"
    );
    keys(cx, "cmd-alt-b");
    assert_eq!(
        view.read_with(cx, |ws, _| ws.nav.page()),
        Page::Target(chapter(1))
    );
    let stored = cx.update(|_, cx| Settings::read(cx).key_bindings());
    assert_eq!(stored["goBack"], "alt-secondary-b");
    // A module's own key survives the keymap being rebuilt.
    cx.update(|_, cx| {
        dr_shell::keymap::add_bindings(cx, || {
            vec![gpui::KeyBinding::new(
                "cmd-alt-y",
                dr_shell::actions::ShowWholeBook,
                Some("Workspace"),
            )]
        });
        let overrides = Settings::read(cx).key_bindings();
        dr_shell::keymap::apply(&overrides, cx);
    });
    keys(cx, "cmd-alt-y");
    assert_eq!(
        view.read_with(cx, |ws, _| ws.nav.page()),
        Page::Target(Target::Book)
    );
}

#[gpui::test]
fn sidebars_open_with_their_shortcuts_and_slide(cx: &mut TestAppContext) {
    let (view, cx) = setup(cx, SettingsFile::in_memory(), None);
    assert!(
        !view.read_with(cx, |ws, _| ws.left.open),
        "new layouts start with both closed"
    );
    view.update_in(cx, |ws, window, cx| ws.toggle_left(window, cx));
    let (open, target) = view.read_with(cx, |ws, _| (ws.left.open, ws.left.reveal.to));
    assert!(open);
    assert_eq!(target, 1.0);
}

#[gpui::test]
fn a_deep_link_opens_its_page_on_the_main_thread(cx: &mut TestAppContext) {
    let (_dir, lib) = slow_clock();
    let links = DeepLinks::new(SCHEME);
    let (view, cx) = setup_with(
        cx,
        SettingsFile::in_memory(),
        Some(links.clone()),
        Some(lib),
    );
    wait_for(&view, cx, |ws| !ws.book.is_empty());
    let (book, third, fifth, fifth_title) = view.read_with(cx, |ws, _| {
        (
            ws.book_id.clone(),
            chapter_of(ws, 2),
            chapter_of(ws, 4),
            ws.book.chapters[4].title.clone(),
        )
    });
    let Target::Chapter(third_id) = &third else {
        unreachable!()
    };
    // In the app the waker fires on whichever thread delivered the link and
    // the channel brings it to the main thread; here the push happens on
    // the test's thread.
    links.push_all([format!(
        "{SCHEME}://open/{book}/chapters/id-{third_id}/prose.md#L5-L7"
    )]);
    cx.run_until_parked();
    assert_eq!(
        view.read_with(cx, |ws, _| ws.nav.page()),
        Page::Target(third.clone())
    );
    // The editor put the caret on the lines once it was open.
    let editor = open_editor(&view, cx, &third);
    let lines = view.update(cx, |ws, _| ws.nav.take_reveal(&third));
    assert_eq!(lines, None, "taken by the editor");
    let caret_line = editor.read_with(cx, |e, cx| {
        let prose = e.editor().read(cx);
        let doc = &prose.book().chapters[0].doc;
        doc.line_of(prose.selection().head)
    });
    assert_eq!(caret_line, 2, "L5 is the third paragraph");
    // A document-form link by name, from text (F3's catalog).
    let href = format!(
        "drifting:chapters/{}/prose.md",
        fifth_title.replace(' ', "%20")
    );
    let opened = view.update_in(cx, |ws, window, cx| ws.open_link(&href, window, cx));
    assert!(opened);
    assert_eq!(
        view.read_with(cx, |ws, _| ws.nav.page()),
        Page::Target(fifth)
    );
    // Another book's link does not navigate.
    let opened = view.update_in(cx, |ws, window, cx| {
        ws.open_link(
            &format!("{SCHEME}://open/other/chapters/id-{third_id}/prose.md"),
            window,
            cx,
        )
    });
    assert!(!opened);
}

#[gpui::test]
fn the_layout_is_stored_per_book_and_comes_back(cx: &mut TestAppContext) {
    let (lib_dir, lib) = slow_clock();
    let dir = tempfile::tempdir().unwrap();
    let (view, vcx) = setup_with(cx, SettingsFile::open(dir.path()), None, Some(lib.clone()));
    wait_for(&view, vcx, |ws| !ws.book.is_empty());
    let (book, second, fourth) = view.read_with(vcx, |ws, _| {
        (ws.book_id.clone(), chapter_of(ws, 1), chapter_of(ws, 3))
    });
    view.update_in(vcx, |ws, window, cx| {
        ws.open(second.clone(), Open::KEEP, cx);
        ws.open(fourth.clone(), Open::PREVIEW, cx);
        ws.toggle_right(window, cx);
    });
    // As ⌘Q does: after the dispatch, when no window is checked out.
    vcx.update(|_, cx| {
        cx.defer(|cx| {
            dr_shell::workspace::save_all_layouts(cx);
            Settings::flush(cx);
        })
    });
    vcx.run_until_parked();
    let saved = SettingsFile::open(dir.path());
    let layout = saved.layout(&book).cloned().expect("stored");
    assert_eq!(layout["right"]["open"], Value::Bool(true));
    assert_eq!(saved.last_book(), Some(book.as_str()));
    // A new window over the same file and library restores the book, the
    // tabs and the page.
    let mut fresh = cx.new_app();
    let (again, vcx2) = setup_with(&mut fresh, saved, None, Some(lib));
    wait_for(&again, vcx2, |ws| !ws.book.is_empty());
    let (tabs, page, right) = again.read_with(vcx2, |ws, _| {
        (ws.nav.tabs().len(), ws.nav.page(), ws.right.open)
    });
    assert_eq!((tabs, right), (2, true));
    assert_eq!(page, Page::Target(fourth));
    drop(lib_dir);
}

#[gpui::test]
fn the_panels_list_the_book_from_f3(cx: &mut TestAppContext) {
    let (_dir, lib) = slow_clock();
    let (view, cx) = setup_with(cx, SettingsFile::in_memory(), None, Some(lib));
    wait_for(&view, cx, |ws| !ws.book.is_empty());
    view.read_with(cx, |ws, _| {
        let b = &ws.book;
        assert_eq!(b.name, "慢钟");
        assert_eq!(b.chapters.len(), 24);
        assert_eq!(b.storylines.len(), 4);
        assert_eq!(b.categories.len(), 3);
        assert_eq!(b.elements.len(), 24);
        assert_eq!(b.ideas.len(), 4);
        assert!(!b.materials.is_empty());
        // Reading order, and each chapter's mark takes its storyline's colour.
        assert_eq!(b.chapters[0].title, "第一章 停摆");
        let first = Target::Chapter(b.chapters[0].id.parse().unwrap());
        assert!(b.mark(&first).1.is_some());
    });
    // Every panel draws with the real lists.
    view.update_in(cx, |ws, window, cx| {
        ws.toggle_left(window, cx);
        ws.toggle_right(window, cx);
    });
    for tab in dr_shell::workspace::LeftTab::ORDER {
        view.update(cx, |ws, cx| {
            ws.left.panes.panes[0].tab = tab;
            cx.notify();
        });
        cx.run_until_parked();
        cx.update(|window, cx| window.draw(cx).clear(cx));
    }
    view.update(cx, |ws, cx| {
        ws.right.panes.panes[0].tab = dr_shell::workspace::RightTab::Library;
        cx.notify();
    });
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear(cx));
}

#[gpui::test]
fn pages_open_in_their_editors_and_the_book_reads_every_chapter(cx: &mut TestAppContext) {
    let (_dir, lib) = slow_clock();
    let (view, cx) = setup_with(cx, SettingsFile::in_memory(), None, Some(lib));
    wait_for(&view, cx, |ws| !ws.book.is_empty());
    let (first, title) = view.read_with(cx, |ws, _| {
        (chapter_of(ws, 0), ws.book.chapters[0].title.clone())
    });
    view.update(cx, |ws, cx| ws.open(first.clone(), Open::KEEP, cx));
    let editor = open_editor(&view, cx, &first);
    editor.read_with(cx, |e, cx| {
        let text = e.plain_text(cx);
        assert!(text.starts_with("推开怀山钟表铺的门时"), "{text}");
        let prose = e.editor().read(cx);
        assert_eq!(
            prose.book().chapters[0].title.as_ref(),
            title,
            "the title row"
        );
        assert_eq!(e.book_id(), view.read(cx).book_id);
    });
    // A material note with Markdown headings has them as H2.
    let note = view.read_with(cx, |ws, _| {
        let m = ws
            .book
            .materials
            .iter()
            .find(|m| m.title == "机械钟怎么走")
            .expect("the sample's note");
        Target::Material(m.id.parse().unwrap())
    });
    view.update(cx, |ws, cx| ws.open(note.clone(), Open::KEEP, cx));
    let editor = open_editor(&view, cx, &note);
    let headings: Vec<u8> = editor.read_with(cx, |e, cx| {
        let doc = &e.editor().read(cx).book().chapters[0].doc;
        doc.lines()[..doc.visible_lines()]
            .iter()
            .filter_map(|l| match l.kind {
                gpui_prose::text::BlockKind::Body => None,
                gpui_prose::text::BlockKind::H1 => Some(1),
                gpui_prose::text::BlockKind::H2 => Some(2),
                gpui_prose::text::BlockKind::H3 => Some(3),
            })
            .collect()
    });
    assert!(headings.contains(&2), "{headings:?}");
}

/// Draws until `target`'s page view (one document or the whole book) is
/// open and its editor has the keyboard.
fn open_page(view: &Entity<Workspace>, cx: &mut VisualTestContext, target: &Target) -> PageView {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        draw(cx);
        cx.run_until_parked();
        let page = view.read_with(cx, |ws, _| ws.page_view(target).cloned());
        if let Some(page) = page {
            draw(cx);
            let focused = cx.update(|window, cx| {
                let prose = page.prose(cx).focus_handle(cx);
                window.focused(cx) == Some(prose)
            });
            assert!(focused, "the open page's editor takes the keyboard");
            draw(cx);
            return page;
        }
        assert!(Instant::now() < deadline, "the page did not open");
        std::thread::sleep(Duration::from_millis(2));
    }
}

/// M05 in the shell: the whole book's tab is one editor over every
/// chapter. Its outline lists the three acts and the 24 chapters and jumps
/// to a chapter; typing there writes that chapter and ⌘Z undoes it there;
/// a location link to a chapter is shown in place; the reading position is
/// stored with the layout and comes back.
#[gpui::test]
fn the_whole_book_is_one_editor(cx: &mut TestAppContext) {
    use dr_shell::workspace::outline;
    let (_dir, lib) = slow_clock();
    let settings_dir = tempfile::tempdir().unwrap();
    let (view, cx) = setup_with(
        cx,
        SettingsFile::open(settings_dir.path()),
        None,
        Some(lib.clone()),
    );
    wait_for(&view, cx, |ws| !ws.book.is_empty());
    let (book, third, fifth_title) = view.read_with(cx, |ws, _| {
        (
            ws.book_id.clone(),
            chapter_of(ws, 2),
            ws.book.chapters[4].title.clone(),
        )
    });
    let Target::Chapter(third_id) = &third else {
        unreachable!()
    };
    let third_doc = format!("node:{third_id}");
    view.update(cx, |ws, cx| ws.open(Target::Book, Open::KEEP, cx));
    let page = open_page(&view, cx, &Target::Book);
    let PageView::Book(editor) = page.clone() else {
        panic!("the whole book's page is a BookEditor")
    };
    assert_eq!(editor.read_with(cx, |e, _| e.chapter_docs().count()), 24);
    // The outline: three acts, 24 chapters (no headings in 《慢钟》's chapters).
    let (entries, ..) = cx.update(|_, cx| outline::read(&page, cx));
    let tiers = |t: u8| entries.iter().filter(|e| e.level == t).count();
    assert_eq!((tiers(1), tiers(2)), (3, 24));
    // To the third chapter by the outline, then type there.
    let at = entries
        .iter()
        .find(|e| e.level == 2 && e.chapter == 2)
        .unwrap()
        .chapter;
    cx.update(|window, cx| outline::jump_to(&page, at, None, window, cx));
    draw(cx);
    let before = stored(&lib, &third_doc);
    type_text(cx, "钟");
    let after = stored(&lib, &third_doc);
    assert_eq!(after[0], format!("钟{}", before[0]), "typed into chapter 3");
    keys(cx, "cmd-z");
    cx.run_until_parked();
    assert_eq!(stored(&lib, &third_doc), before, "⌘Z undid it in chapter 3");
    // A location link while reading the book: shown in place, no new tab.
    let tabs = view.read_with(cx, |ws, _| ws.nav.tabs().len());
    let href = format!(
        "drifting:chapters/{}/prose.md#L3",
        fifth_title.replace(' ', "%20")
    );
    assert!(view.update_in(cx, |ws, window, cx| ws.open_link(&href, window, cx)));
    draw(cx);
    assert_eq!(view.read_with(cx, |ws, _| ws.nav.tabs().len()), tabs);
    let caret_chapter = editor.read_with(cx, |e, cx| e.editor().read(cx).selection().chapter);
    assert_eq!(caret_chapter, 4, "the fifth chapter's second paragraph");
    // The reading position goes into the book's layout.
    view.update(cx, |ws, cx| ws.store_layout(cx));
    let saved = cx.update(|_, cx| {
        Settings::read(cx).layout(&book).cloned().unwrap()["book_position"].clone()
    });
    assert_eq!(
        saved["doc"].as_str(),
        Some(
            format!(
                "node:{}",
                view.read_with(cx, |ws, _| ws.book.chapters[4].id.clone())
            )
            .as_str()
        )
    );
    // Closing the tab and opening it again comes back there.
    view.update(cx, |ws, cx| {
        let i = ws
            .nav
            .tabs()
            .iter()
            .position(|t| t.key() == "book")
            .unwrap();
        ws.nav.close(i);
        cx.notify();
    });
    draw(cx);
    view.update(cx, |ws, cx| ws.open(Target::Book, Open::KEEP, cx));
    let PageView::Book(again) = open_page(&view, cx, &Target::Book) else {
        unreachable!()
    };
    let position = again.read_with(cx, |e, cx| e.reading_position(cx)).unwrap();
    assert_eq!(position.doc, saved["doc"].as_str().unwrap());
}

/// ⌘F: the find bar over the page finds in the chapter, Enter steps to the
/// next match, Esc closes it and the page gets the keyboard back. M07's
/// live count follows typing.
#[gpui::test]
fn the_find_bar_steps_through_matches_and_live_words_follow(cx: &mut TestAppContext) {
    let (_dir, lib) = slow_clock();
    let (view, cx) = setup_with(cx, SettingsFile::in_memory(), None, Some(lib));
    wait_for(&view, cx, |ws| !ws.book.is_empty());
    let first = view.read_with(cx, |ws, _| chapter_of(ws, 0));
    let Target::Chapter(id) = &first else {
        unreachable!()
    };
    let doc = format!("node:{id}");
    view.update(cx, |ws, cx| ws.open(first.clone(), Open::KEEP, cx));
    let page = open_page(&view, cx, &first);
    // The live count is the chapter's.
    let live = cx.update(|_, cx| dr_view_stats::LiveWords::read(cx).docs.get(&doc).copied());
    let words = live.expect("the open chapter's live count").words;
    assert!(words > 100, "{words}");
    type_text(cx, "钟");
    let live = cx.update(|_, cx| dr_view_stats::LiveWords::read(cx).docs[&doc].words);
    assert_eq!(live, words + 1, "the live count follows typing");

    keys(cx, "cmd-f");
    draw(cx);
    assert!(view.read_with(cx, |ws, _| ws.find.is_some()));
    type_text(cx, "钟");
    draw(cx);
    let bar = view.read_with(cx, |ws, _| ws.find.clone().unwrap());
    let status = bar.read_with(cx, |b, _| b.status());
    assert!(status.total > 3, "{status:?}");
    let first_hit = status.current.unwrap();
    // Every match is washed in the accent, the current one deeper (F4d's
    // find layer, with the looks the shell gives the editor).
    let prose = cx.update(|_, cx| page.prose(cx));
    let current = prose.read_with(cx, |p, _| {
        p.painted_decoration(0, "find", &first_hit.to_string())
    });
    let current = current.expect("the current match is painted");
    assert!((current.alpha - 0.34).abs() < 1e-3, "{}", current.alpha);
    let others = prose.read_with(cx, |p, _| {
        (0..status.total)
            .filter(|ix| *ix != first_hit)
            .filter_map(|ix| p.painted_decoration(0, "find", &ix.to_string()))
            .map(|d| d.alpha)
            .collect::<Vec<_>>()
    });
    assert!(!others.is_empty(), "other matches are in view");
    assert!(others.iter().all(|a| (a - 0.16).abs() < 1e-3), "{others:?}");
    keys(cx, "enter");
    let next = bar.read_with(cx, |b, _| b.status()).current.unwrap();
    assert_eq!(
        next,
        (first_hit + 1) % status.total,
        "Enter goes to the next"
    );
    keys(cx, "shift-enter");
    assert_eq!(
        bar.read_with(cx, |b, _| b.status()).current,
        Some(first_hit)
    );
    keys(cx, "escape");
    draw(cx);
    assert!(view.read_with(cx, |ws, _| ws.find.is_none()));
    let back = cx.update(|window, cx| window.focused(cx) == Some(page.prose(cx).focus_handle(cx)));
    assert!(back, "the page has the keyboard again");
    let cleared = cx.update(|_, cx| page.prose(cx).read(cx).find_query().is_none());
    assert!(cleared, "the query went with the bar");
}

/// The acceptance of F6's third milestone: a chapter written in the app is
/// kept. Typing, Enter, ⌘Z and ⌘⇧Z go through the keymap (the edit menu's
/// bindings, handed to the editor), switching chapters keeps the first
/// one's editor, search and the word count follow, and after quitting and
/// opening the library again the chapter comes back with its text.
#[gpui::test]
fn a_chapter_written_in_the_app_is_kept(cx: &mut TestAppContext, cx2: &mut TestAppContext) {
    let (lib_dir, lib) = slow_clock();
    let settings_dir = tempfile::tempdir().unwrap();
    let (view, vcx) = setup_with(
        cx,
        SettingsFile::open(settings_dir.path()),
        None,
        Some(lib.clone()),
    );
    wait_for(&view, vcx, |ws| !ws.book.is_empty());
    let (book, first, second) = view.read_with(vcx, |ws, _| {
        (ws.book_id.clone(), chapter_of(ws, 0), chapter_of(ws, 1))
    });
    let Target::Chapter(id) = &first else {
        unreachable!()
    };
    let doc = format!("node:{id}");
    let original = stored(&lib, &doc);
    let (words_before, hits_before) = settled(&lib, &book, "钟停了");
    assert_eq!(hits_before, 0);

    view.update(vcx, |ws, cx| ws.open(first.clone(), Open::KEEP, cx));
    let editor = open_editor(&view, vcx, &first);
    type_text(vcx, "钟停了。");
    keys(vcx, "enter");
    type_text(vcx, "夜里");
    let written = stored(&lib, &doc);
    assert_eq!(written[0], "钟停了。");
    assert_eq!(written[1], format!("夜里{}", original[0]));
    assert_eq!(written.len(), original.len() + 1);
    assert_eq!(
        editor.read_with(vcx, |e, cx| e.plain_text(cx)),
        format!(
            "{}
",
            written.join(
                "
"
            )
        )
    );

    // ⌘Z takes it all back, ⌘⇧Z brings it again.
    let undone = press_until(vcx, "cmd-z", 12, || stored(&lib, &doc) == original);
    assert!(
        undone,
        "undo reached the original: {:?}",
        stored(&lib, &doc)
    );
    let redone = press_until(vcx, "cmd-shift-z", 12, || stored(&lib, &doc) == written);
    assert!(redone, "redo reached the typing: {:?}", stored(&lib, &doc));

    // Another chapter, then back (⌘[): the first one's editor was kept.
    view.update(vcx, |ws, cx| ws.open(second.clone(), Open::KEEP, cx));
    open_editor(&view, vcx, &second);
    keys(vcx, "cmd-[");
    let back = open_editor(&view, vcx, &first);
    assert_eq!(back, editor, "the tab kept its editor");
    assert!(
        back.read_with(vcx, |e, cx| e.plain_text(cx))
            .starts_with("钟停了。\n夜里推开")
    );

    // Search and the word count follow (dr-text counts each Chinese
    // character as a word; 。 is not one).
    let (words_after, hits_after) = counted(&lib, &book, "钟停了");
    assert_eq!(words_after, words_before + 5);
    assert_eq!(hits_after, 1);

    // Quit (the hooks hand the library over and store the layout), let go
    // of the window and the library, and open it again in a new app.
    vcx.update(|_, cx| dr_shell::quit::request(cx));
    vcx.run_until_parked();
    let weak_ws = view.downgrade();
    let weak_editor = editor.downgrade();
    let weak_prose = editor.read_with(vcx, |e, _| e.editor().downgrade());
    vcx.update(|window, _| window.remove_window());
    cx.update(|cx| cx.remove_global::<Services>());
    drop((view, editor, back));
    for _ in 0..3 {
        cx.update(|_| {});
        cx.run_until_parked();
    }
    assert!(weak_ws.upgrade().is_none(), "the workspace is released");
    assert!(
        weak_editor.upgrade().is_none(),
        "the chapter's editor is released"
    );
    assert!(
        weak_prose.upgrade().is_none(),
        "its prose editor is released"
    );
    lib.close();
    drop(lib);
    let root = lib_dir.path().join("library");
    let deadline = Instant::now() + Duration::from_secs(5);
    let lib = loop {
        match Library::open_dir(&root, VERSION) {
            Ok(lib) => break lib,
            Err(error) => {
                assert!(
                    Instant::now() < deadline,
                    "the library stayed open: {error}"
                );
                cx.run_until_parked();
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    };
    assert_eq!(stored(&lib, &doc), written);
    let (view, vcx) = setup_with(
        cx2,
        SettingsFile::open(settings_dir.path()),
        None,
        Some(lib.clone()),
    );
    wait_for(&view, vcx, |ws| !ws.book.is_empty());
    assert_eq!(
        view.read_with(vcx, |ws, _| ws.nav.page()),
        Page::Target(first.clone()),
        "the layout came back"
    );
    let reopened = open_editor(&view, vcx, &first);
    assert!(
        reopened
            .read_with(vcx, |e, cx| e.plain_text(cx))
            .starts_with("钟停了。\n夜里推开")
    );
    let (words, hits) = counted(&lib, &book, "钟停了");
    assert_eq!((words, hits), (words_after, 1));
}

/// M03: the paper's corner sets a chapter's writing status through F3
/// (what its ⋯ menu's rows run), puts it in the trash, and the incense
/// stick's shortcut hides everything but the paper until Esc.
#[gpui::test]
fn the_corner_sets_the_status_and_immersive_writing_keeps_only_the_paper(cx: &mut TestAppContext) {
    let (_dir, lib) = slow_clock();
    let (view, cx) = setup_with(cx, SettingsFile::in_memory(), None, Some(lib));
    wait_for(&view, cx, |ws| !ws.book.is_empty());
    let (book, first, second) = view.read_with(cx, |ws, _| {
        (ws.book_id.clone(), chapter_of(ws, 0), chapter_of(ws, 1))
    });
    let (Target::Chapter(id), Target::Chapter(second_id)) = (&first, &second) else {
        unreachable!()
    };
    view.update(cx, |ws, cx| {
        ws.open(second.clone(), Open::KEEP, cx);
        ws.open(first.clone(), Open::KEEP, cx);
    });
    open_editor(&view, cx, &first);
    let was = view.read_with(cx, |ws, _| ws.book.chapters[0].status.clone());
    let want = if was == "discarded" {
        "draft"
    } else {
        "discarded"
    };
    view.update(cx, |ws, cx| {
        ws.run_command(
            "chapter.update",
            json!({"book": book, "id": id.to_string(), "status": want}),
            cx,
        )
    });
    wait_for(&view, cx, |ws| ws.book.chapters[0].status == want);
    // 删除节点: into the trash, and F3's event closes its tab.
    view.update(cx, |ws, cx| {
        ws.run_command(
            "chapter.trash",
            json!({"book": book, "id": second_id.to_string()}),
            cx,
        )
    });
    wait_for(&view, cx, |ws| !ws.nav.is_open(&second));

    // ⌘⇧↩: only the paper; Esc: everything back.
    keys(cx, "cmd-shift-enter");
    assert!(view.read_with(cx, |ws, _| ws.immersive));
    draw(cx);
    keys(cx, "escape");
    assert!(!view.read_with(cx, |ws, _| ws.immersive));
    keys(cx, "cmd-shift-enter");
    keys(cx, "cmd-shift-enter");
    assert!(!view.read_with(cx, |ws, _| ws.immersive));
    draw(cx);
}

/// M04: the chapter panel's whole-book view has the book's acts; a chapter
/// dropped on another moves there in reading order through F3; the outline
/// rail reads the page's headings and a click puts the caret on one.
#[gpui::test]
fn chapters_move_by_act_and_the_outline_jumps_to_a_heading(cx: &mut TestAppContext) {
    use dr_shell::workspace::outline;
    let (_dir, lib) = slow_clock();
    let (view, cx) = setup_with(cx, SettingsFile::in_memory(), None, Some(lib));
    wait_for(&view, cx, |ws| !ws.book.is_empty());
    let (acts, in_acts, chapters) = view.read_with(cx, |ws, _| {
        (
            ws.book.acts.len(),
            ws.book.acts.iter().map(|a| a.chapters.len()).sum::<usize>(),
            ws.book.chapters.len(),
        )
    });
    assert_eq!(
        (acts, in_acts),
        (3, chapters),
        "three volumes hold every chapter"
    );
    // The whole book's view, drawn.
    view.update_in(cx, |ws, window, cx| {
        ws.chapters_by_book = true;
        ws.toggle_left(window, cx);
    });
    draw(cx);
    // The first chapter dropped on the third goes after it; back again.
    let ids =
        |ws: &Workspace| -> Vec<String> { ws.book.chapters.iter().map(|c| c.id.clone()).collect() };
    let before = view.read_with(cx, |ws, _| ids(ws));
    view.update(cx, |ws, cx| ws.move_chapter(&before[0], &before[2], cx));
    wait_for(&view, cx, |ws| ids(ws)[2] == before[0]);
    assert_eq!(
        view.read_with(cx, |ws, _| ids(ws)[..3].to_vec()),
        [before[1].clone(), before[2].clone(), before[0].clone()]
    );
    view.update(cx, |ws, cx| ws.move_chapter(&before[0], &before[1], cx));
    wait_for(&view, cx, |ws| ids(ws) == before);

    // The outline of the material note: its two H2s.
    let note = view.read_with(cx, |ws, _| {
        let m = ws
            .book
            .materials
            .iter()
            .find(|m| m.title == "机械钟怎么走")
            .expect("the sample's note");
        Target::Material(m.id.parse().unwrap())
    });
    view.update_in(cx, |ws, window, cx| {
        ws.toggle_left(window, cx);
        ws.open(note.clone(), Open::KEEP, cx);
    });
    let editor = open_editor(&view, cx, &note);
    let view = view
        .read_with(cx, |ws, _| ws.page_view(&note).cloned())
        .unwrap();
    let (entries, total, _, _) = cx.update(|_, cx| outline::read(&view, cx));
    let names: Vec<(u8, &str)> = entries.iter().map(|e| (e.level, e.text.as_str())).collect();
    assert_eq!(
        names,
        [(4, "四个部分"), (4, "常见毛病")],
        "H2 is the fourth tier"
    );
    assert!(entries[0].top < entries[1].top && entries[1].top < total);
    let line = entries[1].line.unwrap();
    cx.update(|window, cx| outline::jump_to(&view, 0, Some(line), window, cx));
    let (caret, start) = editor.read_with(cx, |e, cx| {
        let prose = e.editor().read(cx);
        (
            prose.selection().head,
            prose.book().chapters[0].doc.line_start(line),
        )
    });
    assert_eq!(caret, start, "the caret at the heading's start");
    draw(cx);
}

#[gpui::test]
fn a_chapter_trashed_through_f3_closes_its_tab(cx: &mut TestAppContext) {
    use dr_workspace::commands::{EntityIn, chapter::ChapterTrash};
    let (_dir, lib) = slow_clock();
    let (view, cx) = setup_with(cx, SettingsFile::in_memory(), None, Some(lib.clone()));
    wait_for(&view, cx, |ws| !ws.book.is_empty());
    let (book, first, second) = view.read_with(cx, |ws, _| {
        (ws.book_id.clone(), chapter_of(ws, 0), chapter_of(ws, 1))
    });
    view.update(cx, |ws, cx| {
        ws.open(first.clone(), Open::KEEP, cx);
        ws.open(second.clone(), Open::KEEP, cx);
    });
    let Target::Chapter(id) = &second else {
        unreachable!()
    };
    // Trashed by anyone (here: straight through F3, as an Agent or another
    // device would): F3's bus says so from its holder thread.
    lib.run::<ChapterTrash>(
        &dr_workspace::Actor::User,
        EntityIn {
            book: book.clone(),
            id: id.to_string(),
        },
    )
    .unwrap();
    wait_for(&view, cx, |ws| !ws.nav.is_open(&second));
    wait_for(&view, cx, |ws| ws.book.chapters.len() == 23);
    let (tabs, page) = view.read_with(cx, |ws, _| (ws.nav.tabs().len(), ws.nav.page()));
    assert_eq!(tabs, 1);
    assert_eq!(page, Page::Target(first));
}

#[gpui::test]
fn quitting_hands_the_library_over(cx: &mut TestAppContext) {
    let (_dir, lib) = slow_clock();
    let (view, cx) = setup_with(cx, SettingsFile::in_memory(), None, Some(lib));
    wait_for(&view, cx, |ws| !ws.book.is_empty());
    let first = view.read_with(cx, |ws, _| chapter_of(ws, 0));
    view.update(cx, |ws, cx| ws.open(first.clone(), Open::KEEP, cx));
    open_editor(&view, cx, &first);
    // `Workspace::before_quit` runs from the quit flow; the library stays
    // usable after it.
    cx.update(|_, cx| dr_shell::quit::request(cx));
    cx.run_until_parked();
    let lib = cx.update(|_, cx| cx.global::<Services>().library.clone().unwrap());
    let book = view.read_with(cx, |ws, _| ws.book_id.clone());
    assert!(lib.catalog(&book).is_ok());
}

#[gpui::test]
fn settings_take_effect_and_reach_the_file(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (_view, cx) = setup(cx, SettingsFile::open(dir.path()), None);
    cx.update(|window, cx| {
        Settings::update(cx, |f| f.set(registry::THEME, Value::from("dark"), None)).unwrap();
        Settings::update(cx, |f| {
            f.set(registry::TEXT_SIZE, Value::from("large"), None)
        })
        .unwrap();
        Settings::update(cx, |f| f.set(registry::UI_LOCALE, Value::from("en"), None)).unwrap();
        let theme = dr_ui::Theme::of(window, cx);
        assert_eq!(theme.appearance, dr_ui::Appearance::Dark);
        assert_eq!(theme.scale, dr_ui::tokens::TextSize::Large.scale());
        assert_eq!(
            dr_shell::t(cx, dr_i18n::keys::right_sidebar::tabs::COMPANION),
            "Agent"
        );
    });
    // Written after the delay, not at once.
    assert!(!dir.path().join("settings.json").exists());
    cx.executor()
        .advance_clock(dr_shell::settings::SAVE_DELAY * 2);
    cx.run_until_parked();
    let raw: Value =
        serde_json::from_slice(&std::fs::read(dir.path().join("settings.json")).unwrap()).unwrap();
    assert_eq!(raw["account"]["appearance.theme"], "dark");
    assert_eq!(raw["device"]["appearance.interface_text_size"], "large");
}

/// M08: 还原推荐样式 puts every editor setting back; the diagnostics
/// summary names the version and the platform and nothing of the author's.
#[gpui::test]
fn settings_reset_the_editor_style_and_copy_a_plain_summary(cx: &mut TestAppContext) {
    use dr_shell::settings::panel::{diagnostics_summary, reset_editor_style, version_line};
    let (_view, cx) = setup(cx, SettingsFile::in_memory(), None);
    cx.update(|_, cx| {
        Settings::update(cx, |f| {
            f.set(registry::FONT_SIZE, Value::from(22), None).unwrap();
            f.set(registry::PAGE_WIDTH, Value::from(900), None).unwrap();
        });
        assert_eq!(Settings::read(cx).number(registry::FONT_SIZE), 22.0);
        reset_editor_style(cx);
        let file = Settings::read(cx);
        assert_eq!(file.number(registry::FONT_SIZE), 17.0);
        assert_eq!(file.number(registry::PAGE_WIDTH), 720.0);
        let summary = diagnostics_summary(cx);
        assert!(summary.starts_with("Drifting 0.2.0-dev"), "{summary}");
        assert!(summary.contains(std::env::consts::OS));
        assert!(!summary.contains('/'), "no paths: {summary}");
        assert!(version_line(cx).starts_with("0.2.0-dev · "));
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
}

#[gpui::test]
fn quitting_runs_the_hooks_and_writes_the_file_first(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (_view, cx) = setup(cx, SettingsFile::open(dir.path()), None);
    let ran = std::rc::Rc::new(std::cell::Cell::new(false));
    let seen = ran.clone();
    cx.update(|_, cx| {
        Settings::update(cx, |f| f.set(registry::TYPEWRITER, Value::Bool(true), None)).unwrap();
        dr_shell::quit::before_quit(cx, move |_| seen.set(true));
        dr_shell::quit::request(cx);
    });
    cx.run_until_parked();
    assert!(ran.get());
    let raw: Value =
        serde_json::from_slice(&std::fs::read(dir.path().join("settings.json")).unwrap()).unwrap();
    assert_eq!(
        raw["account"]["editor.typewriter_mode"], true,
        "written before the quit, not after"
    );
}

#[gpui::test]
fn the_shell_draws_every_layer(cx: &mut TestAppContext) {
    // A smoke test: render each state once without panicking.
    let (view, cx) = setup(cx, SettingsFile::in_memory(), None);
    view.update_in(cx, |ws, window, cx| {
        ws.toggle_left(window, cx);
        ws.toggle_right(window, cx);
        ws.open(chapter(1), Open::KEEP, cx);
        ws.open(chapter(2), Open::PREVIEW, cx);
        ws.nav.activate(0);
        ws.nav.split_with(1, dr_shell::nav::Side::Right);
        ws.dock_locked = true;
    });
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear(cx));
    view.update_in(cx, |ws, window, cx| {
        ws.toggle_super_view(SuperView::ReviewMaterials, cx);
        ws.open_settings(window, cx);
        ws.notifications_open = true;
    });
    cx.update(|_, cx| {
        dr_shell::notifications::Notifications::post(
            dr_shell::notifications::Source::Update,
            "Drifting 0.2.1",
            cx,
        );
    });
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear(cx));
}

#[gpui::test]
fn the_tabs_under_a_super_view_do_not_answer_the_keyboard(cx: &mut TestAppContext) {
    let (view, cx) = setup(cx, SettingsFile::in_memory(), None);
    view.update(cx, |ws, cx| {
        ws.open(chapter(1), Open::KEEP, cx);
        ws.open(chapter(2), Open::KEEP, cx);
    });
    keys(cx, "cmd-alt-5");
    keys(cx, "cmd-w");
    keys(cx, "cmd-alt-left");
    let (tabs, page) = view.read_with(cx, |ws, _| (ws.nav.tabs().len(), ws.nav.page()));
    assert_eq!((tabs, page), (2, Page::Target(chapter(2))));
}

/// M18 in the whole book: ⌘⌥M on a selection in chapter 3 brings up the
/// composer; ⌘↵ writes the comment on those words of chapter 3, and the
/// book view draws its sand there.
#[gpui::test]
fn a_comment_is_written_in_the_whole_book(cx: &mut TestAppContext) {
    use dr_shell::workspace::outline;
    let (_dir, lib) = slow_clock();
    let (view, cx) = setup_with(cx, SettingsFile::in_memory(), None, Some(lib.clone()));
    wait_for(&view, cx, |ws| !ws.book.is_empty());
    let (book, third) = view.read_with(cx, |ws, _| (ws.book_id.clone(), chapter_of(ws, 2)));
    let Target::Chapter(third_id) = &third else {
        unreachable!()
    };
    view.update(cx, |ws, cx| ws.open(Target::Book, Open::KEEP, cx));
    let page = open_page(&view, cx, &Target::Book);
    cx.update(|window, cx| outline::jump_to(&page, 2, None, window, cx));
    draw(cx);
    let prose = cx.update(|_, cx| page.prose(cx));
    prose.update_in(cx, |p, window, cx| p.select(2, 0..2, window, cx));
    draw(cx);
    keys(cx, "cmd-alt-m");
    draw(cx);
    assert!(view.read_with(cx, |ws, _| ws.composer.is_some()));
    type_text(cx, "要改");
    keys(cx, "cmd-enter");
    let written = |lib: &Library| {
        let listed = lib
            .call(&Actor::User, "comment.list", json!({"book": book}))
            .unwrap()["output"]
            .clone();
        listed
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["body"] == "要改")
            .cloned()
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    while written(&lib).is_none() && Instant::now() < deadline {
        cx.run_until_parked();
        std::thread::sleep(Duration::from_millis(10));
    }
    let made = written(&lib).expect("the comment is written");
    assert_eq!(made["target"]["id"], third_id.to_string().as_str());
    assert_eq!(made["anchored"], true);
    assert!(view.read_with(cx, |ws, _| ws.composer.is_none()));
    // Drawn in the book, on chapter 3's first two characters.
    let id = made["id"].as_str().unwrap().to_owned();
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut range = None;
    while range.is_none() && Instant::now() < deadline {
        cx.executor().advance_clock(Duration::from_millis(20));
        cx.run_until_parked();
        range = prose.read_with(cx, |p, _| p.decoration_range(2, "comments", &id));
    }
    assert_eq!(range, Some(0..2));
}

/// A view with nothing in it, to stand for a modal dialog.
struct Blank;

impl gpui::Render for Blank {
    fn render(
        &mut self,
        _: &mut gpui::Window,
        _: &mut gpui::Context<Self>,
    ) -> impl gpui::IntoElement {
        gpui::div()
    }
}

/// One modal mechanism (`dialogs::show`): while a dialog is open the
/// workspace's shortcuts are off; once it goes they work again.
#[gpui::test]
fn a_modal_dialog_turns_the_workspace_shortcuts_off(cx: &mut TestAppContext) {
    let (view, cx) = setup(cx, SettingsFile::in_memory(), None);
    let blank = cx.update(|_, cx| cx.new(|_| Blank));
    let id = blank.entity_id();
    // Outside the window's update, as the modules call it.
    TestAppContext::update(cx, |cx| dr_shell::dialogs::show(cx, blank.into()));
    cx.run_until_parked();
    assert!(view.read_with(cx, |ws, _| ws.modal()));
    keys(cx, "cmd-alt-4");
    view.update_in(cx, |ws, window, cx| ws.open_settings(window, cx));
    assert_eq!(
        view.read_with(cx, |ws, _| (ws.super_view, ws.settings.is_some())),
        (None, false),
        "no Super View and no settings under a dialog"
    );
    draw(cx);
    TestAppContext::update(cx, |cx| dr_shell::dialogs::hide(cx, id));
    cx.run_until_parked();
    assert!(!view.read_with(cx, |ws, _| ws.modal()));
    keys(cx, "cmd-alt-4");
    assert_eq!(
        view.read_with(cx, |ws, _| ws.super_view),
        Some(SuperView::Elements)
    );
}

/// M06's search panel is a layer: Esc closes it before what is under it.
#[gpui::test]
fn escape_closes_the_search_panel_first(cx: &mut TestAppContext) {
    let (_dir, lib) = slow_clock();
    let (view, cx) = setup_with(cx, SettingsFile::in_memory(), None, Some(lib));
    wait_for(&view, cx, |ws| !ws.book.is_empty());
    keys(cx, "cmd-alt-4");
    view.update_in(cx, |ws, window, cx| ws.toggle_search(window, cx));
    draw(cx);
    let top = |cx: &mut VisualTestContext| view.read_with(cx, |ws, _| ws.top_layer());
    assert_eq!(top(cx), Some(Layer::Search));
    view.update_in(cx, |ws, window, cx| ws.dismiss(window, cx));
    assert_eq!(top(cx), Some(Layer::SuperView));
}

/// The find bar's replace row (F4c's `replace_current` / `replace_all`):
/// ⌘⌥F opens it; 替换 replaces the current match and moves on, 全部替换 the
/// rest, and one ⌘Z on the page brings the rest back.
#[gpui::test]
fn the_find_bar_replaces_one_then_all_as_one_undo(cx: &mut TestAppContext) {
    let (_dir, lib) = slow_clock();
    let (view, cx) = setup_with(cx, SettingsFile::in_memory(), None, Some(lib.clone()));
    wait_for(&view, cx, |ws| !ws.book.is_empty());
    let first = view.read_with(cx, |ws, _| chapter_of(ws, 0));
    let Target::Chapter(id) = &first else {
        unreachable!()
    };
    let doc = format!("node:{id}");
    view.update(cx, |ws, cx| ws.open(first.clone(), Open::KEEP, cx));
    open_page(&view, cx, &first);
    let count = |lib: &Library, needle: &str| {
        stored(lib, &doc)
            .iter()
            .map(|p| p.matches(needle).count())
            .sum::<usize>()
    };
    let before = count(&lib, "钟");
    assert!(before > 3, "{before}");

    cx.simulate_keystrokes(if cfg!(target_os = "macos") {
        "cmd-alt-f"
    } else {
        "ctrl-h"
    });
    draw(cx);
    let bar = view
        .read_with(cx, |ws, _| ws.find.clone())
        .expect("the find bar");
    assert!(
        bar.read_with(cx, |b, _| b.replacing),
        "with its replace row"
    );
    bar.update_in(cx, |b, window, cx| b.set_query("钟", window, cx));
    draw(cx);
    assert_eq!(bar.read_with(cx, |b, _| b.status()).total, before);
    bar.update_in(cx, |b, window, cx| {
        b.set_replacement("铃", cx);
        b.replace_current(window, cx);
    });
    draw(cx);
    assert_eq!(count(&lib, "钟"), before - 1);
    assert_eq!(bar.read_with(cx, |b, _| b.status()).total, before - 1);
    let replaced = bar.update_in(cx, |b, window, cx| b.replace_all(window, cx));
    draw(cx);
    assert_eq!(replaced, before - 1);
    assert_eq!(count(&lib, "钟"), 0);
    assert_eq!(count(&lib, "铃"), before);

    keys(cx, "escape");
    draw(cx);
    assert!(view.read_with(cx, |ws, _| ws.find.is_none()));
    keys(cx, "cmd-z");
    draw(cx);
    assert_eq!(count(&lib, "钟"), before - 1, "全部替换 is one undo");
}

/// Switching the page in front tells F3 (`recent.touch`), which Project
/// Home's 「继续写」 reads.
#[gpui::test]
fn the_page_in_front_is_recorded_as_recent(cx: &mut TestAppContext) {
    let (_dir, lib) = slow_clock();
    let (view, cx) = setup_with(cx, SettingsFile::in_memory(), None, Some(lib.clone()));
    wait_for(&view, cx, |ws| !ws.book.is_empty());
    let (book, second) = view.read_with(cx, |ws, _| (ws.book_id.clone(), chapter_of(ws, 1)));
    view.update(cx, |ws, cx| ws.open(second.clone(), Open::KEEP, cx));
    draw(cx);
    let Target::Chapter(id) = &second else {
        unreachable!()
    };
    let id = id.to_string();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        cx.run_until_parked();
        let recent = out(&lib, "recent.list", json!({ "book": book }));
        let front = recent.as_array().and_then(|a| a.first()).cloned();
        if front
            .as_ref()
            .is_some_and(|e| e["target"]["id"] == id.as_str())
        {
            assert_eq!(front.unwrap()["target"]["kind"], "node");
            break;
        }
        assert!(Instant::now() < deadline, "not recorded: {recent}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// F4's selection bar asks for a comment (`CommentRequested`): the
/// composer comes up, and what is saved there is a comment on that range.
#[gpui::test]
fn a_comment_asked_for_from_the_selection_bar_is_written(cx: &mut TestAppContext) {
    let (_dir, lib) = slow_clock();
    let (view, cx) = setup_with(cx, SettingsFile::in_memory(), None, Some(lib.clone()));
    wait_for(&view, cx, |ws| !ws.book.is_empty());
    let first = view.read_with(cx, |ws, _| chapter_of(ws, 0));
    let book = view.read_with(cx, |ws, _| ws.book_id.clone());
    let Target::Chapter(id) = &first else {
        unreachable!()
    };
    let doc = format!("node:{id}");
    view.update(cx, |ws, cx| ws.open(first.clone(), Open::KEEP, cx));
    let editor = open_editor(&view, cx, &first);
    editor.update(cx, |_, cx| {
        cx.emit(dr_editor::CommentRequested {
            doc: doc.clone(),
            range: 0..2,
            text: String::new(),
        })
    });
    draw(cx);
    let composer = view
        .read_with(cx, |ws, _| ws.composer.as_ref().map(|c| c.view().clone()))
        .expect("the composer");
    composer.update(cx, |c, cx| {
        c.set_text("看这里", cx);
        c.save(cx);
    });
    wait_for(&view, cx, |ws| ws.composer.is_none());
    let list = out(&lib, "comment.list", json!({ "book": book }));
    let mine: Vec<_> = list
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["body"] == "看这里")
        .collect();
    assert_eq!(mine.len(), 1, "{list}");
    assert_eq!(mine[0]["target"]["id"], id.to_string());
}

/// M04: the chapter panel's sort and its cells' readout are the book's
/// layout; every view draws with each.
#[gpui::test]
fn the_chapter_sort_is_kept_with_the_layout(cx: &mut TestAppContext) {
    use dr_shell::workspace::chapter_sort::{BookSort, CellMeta, OuterSort};
    let (_dir, lib) = slow_clock();
    let (view, cx) = setup_with(cx, SettingsFile::in_memory(), None, Some(lib));
    wait_for(&view, cx, |ws| !ws.book.is_empty());
    view.update_in(cx, |ws, window, cx| {
        if !ws.left.open {
            ws.toggle_left(window, cx);
        }
        ws.chapter_sort_open = Some("primary".into());
    });
    draw(cx);
    for by_book in [true, false] {
        for meta in [
            CellMeta::Date,
            CellMeta::WordCount,
            CellMeta::Both,
            CellMeta::None,
        ] {
            view.update(cx, |ws, cx| {
                ws.chapters_by_book = by_book;
                ws.chapter_sort.meta = meta;
                ws.chapter_sort.book = BookSort::UpdatedAt;
                ws.chapter_sort.outer = OuterSort::Alphabet;
                ws.chapter_sort.primary_only = true;
                cx.notify();
            });
            draw(cx);
        }
    }
    let layout = view.read_with(cx, |ws, _| ws.layout());
    assert_eq!(layout.chapter_sort.book, BookSort::UpdatedAt);
    let value = serde_json::to_value(&layout).unwrap();
    assert_eq!(value["chapter_sort"]["book"], "updatedAt");
    assert_eq!(value["chapter_sort"]["primaryOnly"], true);
    // A layout stored before the sort existed reads as the default.
    let mut old = value.clone();
    old.as_object_mut().unwrap().remove("chapter_sort");
    let back: dr_shell::workspace::BookLayout = serde_json::from_value(old).unwrap();
    assert_eq!(back.chapter_sort, Default::default());
}

/// Round six: a page opened at its title (⁂ 新建下一章, `Open::at_title`)
/// leaves the keyboard to its head; a page opened as usual gives it to its
/// text.
#[gpui::test]
fn a_page_opened_at_its_title_leaves_the_keyboard_alone(cx: &mut TestAppContext) {
    let (_dir, lib) = slow_clock();
    let (view, cx) = setup_with(cx, SettingsFile::in_memory(), None, Some(lib));
    wait_for(&view, cx, |ws| !ws.book.is_empty());
    let (first, second) = view.read_with(cx, |ws, _| (chapter_of(ws, 0), chapter_of(ws, 1)));
    view.update(cx, |ws, cx| {
        ws.open(first.clone(), Open::KEEP.at_title(), cx)
    });
    let deadline = Instant::now() + Duration::from_secs(10);
    while view.read_with(cx, |ws, _| ws.page_view(&first).is_none()) {
        draw(cx);
        cx.run_until_parked();
        assert!(Instant::now() < deadline, "the page did not open");
        std::thread::sleep(Duration::from_millis(2));
    }
    draw(cx);
    draw(cx);
    let prose = view.read_with(cx, |ws, cx| ws.page_view(&first).unwrap().prose(cx));
    let focused = cx.update(|window, cx| window.focused(cx) == Some(prose.focus_handle(cx)));
    assert!(
        !focused,
        "the title's page does not hand its text the keyboard"
    );
    view.update(cx, |ws, cx| ws.open(second.clone(), Open::KEEP, cx));
    open_page(&view, cx, &second);
}

/// One list behind the ⋯ menu and the hover cards: share first, a
/// chapter's status, the modules' rows, 历史快照…, what deletes last.
#[gpui::test]
fn page_actions_put_share_first_and_what_deletes_last(cx: &mut TestAppContext) {
    use dr_shell::pages::{PageMenuHost, PageMenuItem, PageMenuSection};
    use dr_shell::workspace::page_actions::page_actions;
    let (_dir, lib) = slow_clock();
    let (view, cx) = setup_with(cx, SettingsFile::in_memory(), None, Some(lib));
    wait_for(&view, cx, |ws| !ws.book.is_empty());
    let ran = std::rc::Rc::new(std::cell::Cell::new(false));
    let seen = ran.clone();
    cx.update(|_, cx| {
        dr_shell::pages::add_page_menu(cx, move |target, _, _| {
            if !matches!(target, Target::Element(_)) {
                return Vec::new();
            }
            let seen = seen.clone();
            let row = |id: &'static str, danger: bool, run: dr_shell::pages::RunRow| PageMenuItem {
                id: id.into(),
                icon: dr_ui::components::menu::RowIcon::Mark(dr_ui::sand::Kind::Category, None),
                label: id.into(),
                checked: false,
                danger,
                run,
            };
            vec![PageMenuSection {
                title: None,
                items: vec![
                    row(
                        "module-category",
                        false,
                        std::rc::Rc::new(move |_, _| seen.set(true)),
                    ),
                    row("module-delete", true, std::rc::Rc::new(|_, _| {})),
                ],
            }]
        });
    });
    let host = view.read_with(cx, |ws, _| PageMenuHost {
        workspace: view.downgrade(),
        library: ws.library.clone(),
        book_id: ws.book_id.clone(),
        book: ws.book.clone(),
    });
    let ids = |sections: &[PageMenuSection]| -> Vec<Vec<String>> {
        sections
            .iter()
            .map(|s| s.items.iter().map(|i| i.id.to_string()).collect())
            .collect()
    };
    let (element, material, chapter) = view.read_with(cx, |ws, _| {
        (
            Target::Element(ws.book.elements[0].id.parse().unwrap()),
            Target::Material(ws.book.materials[0].id.parse().unwrap()),
            chapter_of(ws, 0),
        )
    });
    let on_element = cx.update(|_, cx| page_actions(&view, &host, &element, cx));
    assert_eq!(
        ids(&on_element),
        [
            vec!["page-share"],
            vec!["module-category"],
            vec!["page-history"],
            vec!["module-delete"],
        ]
    );
    assert!(on_element.last().unwrap().items.iter().all(|i| i.danger));
    let on_material = cx.update(|_, cx| page_actions(&view, &host, &material, cx));
    assert_eq!(ids(&on_material), [vec!["page-history"]], "no share");
    let on_chapter = cx.update(|_, cx| page_actions(&view, &host, &chapter, cx));
    let chapter_ids = ids(&on_chapter);
    assert_eq!(chapter_ids[0], ["page-share", "page-export"]);
    assert_eq!(
        chapter_ids[1],
        ["status-draft", "status-finished", "status-discarded"]
    );
    assert_eq!(on_chapter[1].items.iter().filter(|i| i.checked).count(), 1);
    assert_eq!(chapter_ids.last().unwrap(), &["chapter-trash"]);
    // A module's row runs.
    let run = on_element[1].items[0].run.clone();
    cx.update(|window, cx| run(window, cx));
    assert!(ran.get());
    // The menu draws on an element's page.
    view.update(cx, |ws, cx| {
        ws.open(element.clone(), Open::KEEP, cx);
        ws.corner_menu = Some(element.key());
    });
    draw(cx);
    draw(cx);
}

/// What the export dialog remembers goes into the settings file and comes
/// back after a restart (M41's 「待协调」1).
#[gpui::test]
fn the_export_choices_come_back_after_a_restart(cx: &mut TestAppContext, cx2: &mut TestAppContext) {
    use dr_view_export::Format;
    use dr_view_export::prefs::{BookPrefs, Prefs};
    let dir = tempfile::tempdir().unwrap();
    let (_view, vcx) = setup(cx, SettingsFile::open(dir.path()), None);
    let mine = BookPrefs {
        format: Format::Pdf,
        act_titles: false,
        chapter_titles: true,
        title: Some("慢钟（修订）".into()),
    };
    let book = mine.clone();
    vcx.update(|_, cx| {
        let mut prefs = Prefs::get(cx);
        prefs.author = "沈知微".into();
        prefs.books.insert("book-1".into(), book);
        Prefs::set(prefs, cx);
    });
    vcx.run_until_parked();
    vcx.executor()
        .advance_clock(dr_shell::settings::SAVE_DELAY * 2);
    vcx.run_until_parked();
    let raw: Value =
        serde_json::from_slice(&std::fs::read(dir.path().join("settings.json")).unwrap()).unwrap();
    assert_eq!(raw["account"]["export.author"], "沈知微");
    assert_eq!(raw["books"]["book-1"]["export"]["format"], "pdf");
    cx2.update(|cx| {
        dr_shell::init(
            info(),
            Services::default(),
            SettingsFile::open(dir.path()),
            cx,
        )
    });
    let back = cx2.update(|cx| Prefs::get(cx));
    assert_eq!(back.author, "沈知微");
    assert_eq!(back.books.get("book-1"), Some(&mine));
}

/// 自动要素链接 reaches F3, and the chapter panel's groups fold: one by its
/// chevron, all by the folding fan.
#[gpui::test]
fn auto_links_reach_f3_and_the_chapter_panel_folds(cx: &mut TestAppContext) {
    let (_dir, lib) = slow_clock();
    let (view, cx) = setup_with(cx, SettingsFile::in_memory(), None, Some(lib.clone()));
    wait_for(&view, cx, |ws| !ws.book.is_empty());
    assert!(lib.auto_links());
    cx.update(|_, cx| {
        Settings::update(cx, |f| {
            f.set(registry::AUTO_ENTITY_LINKS, Value::Bool(false), None)
        })
        .unwrap();
    });
    cx.run_until_parked();
    assert!(!lib.auto_links(), "the setting reached F3");
    let storylines = view.read_with(cx, |ws, _| ws.book.storylines.len());
    view.update_in(cx, |ws, window, cx| {
        if !ws.left.open {
            ws.toggle_left(window, cx);
        }
        ws.fold_all(PaneId::Primary, cx);
    });
    draw(cx);
    assert_eq!(
        view.read_with(cx, |ws, _| ws.folded_in(PaneId::Primary).len()),
        storylines + 1,
        "every storyline and 未归属"
    );
    view.update(cx, |ws, cx| ws.fold_all(PaneId::Primary, cx));
    assert!(view.read_with(cx, |ws, _| ws.folded_in(PaneId::Primary).is_empty()));
    let first = view.read_with(cx, |ws, _| ws.book.storylines[0].id.clone());
    view.update(cx, |ws, cx| ws.toggle_fold(PaneId::Primary, &first, cx));
    draw(cx);
    assert!(view.read_with(cx, |ws, _| ws.folded_in(PaneId::Primary).contains(&first)));
    // Another half keeps its own; the folds stay with the book.
    assert!(view.read_with(cx, |ws, _| ws.folded_in(PaneId::Secondary).is_empty()));
}

/// Writing away a patch's source passage marks the patch 失效 once the
/// caret leaves the paragraph (F3's `patch.check_sources`).
#[gpui::test]
fn a_patch_whose_passage_was_written_away_is_marked(cx: &mut TestAppContext) {
    let (_dir, lib) = slow_clock();
    let (view, cx) = setup_with(cx, SettingsFile::in_memory(), None, Some(lib.clone()));
    wait_for(&view, cx, |ws| !ws.book.is_empty());
    let (book, first, element) = view.read_with(cx, |ws, _| {
        (
            ws.book_id.clone(),
            chapter_of(ws, 0),
            ws.book.elements[0].id.clone(),
        )
    });
    let Target::Chapter(id) = &first else {
        unreachable!()
    };
    let doc = format!("node:{id}");
    let passage: String = stored(&lib, &doc)[0].chars().take(6).collect();
    let made = out(
        &lib,
        "patch.create",
        json!({
            "book": book,
            "element": element,
            "body": "补丁",
            "source": id.to_string(),
            "source_text": passage,
        }),
    );
    let patch = made["id"].as_str().unwrap().to_owned();
    view.update(cx, |ws, cx| ws.open(first.clone(), Open::KEEP, cx));
    let page = open_page(&view, cx, &first);
    let prose = cx.update(|_, cx| page.prose(cx));
    // Into the middle of the passage, then a word there.
    cx.update(|window, cx| {
        prose.update(cx, |p, cx| {
            let at = p.book().chapters[0].doc.line_start(0) + 3;
            p.select(0, at..at, window, cx)
        })
    });
    type_text(cx, "钟");
    let invalidated = |lib: &Library| {
        out(
            lib,
            "patch.list",
            json!({ "book": book, "element": element }),
        )
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["id"] == patch.as_str() && !p["invalidated_at"].is_null())
    };
    assert!(
        !invalidated(&lib),
        "not while the caret is in the paragraph"
    );
    // The caret leaves the paragraph.
    cx.update(|window, cx| {
        prose.update(cx, |p, cx| {
            let at = p.book().chapters[0].doc.line_start(2);
            p.select(0, at..at, window, cx)
        })
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        cx.run_until_parked();
        if invalidated(&lib) {
            break;
        }
        assert!(Instant::now() < deadline, "the patch was not marked");
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// Runs `replace` with `job` and waits for its outcome.
fn swap_library(
    cx: &mut VisualTestContext,
    job: impl FnOnce(&std::path::Path, dr_store::LibraryOptions) -> Result<dr_store::Library, String>
    + Send
    + 'static,
) -> Result<(), String> {
    let got = std::rc::Rc::new(std::cell::RefCell::new(None));
    let put = got.clone();
    cx.update(|_, cx| {
        dr_shell::library::replace(cx, job, move |result, _| *put.borrow_mut() = Some(result))
    });
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        // Frames go on as in the app: the last frame's handlers let go of
        // what they held (the editors) once the next one is drawn.
        draw(cx);
        cx.run_until_parked();
        if let Some(result) = got.borrow_mut().take() {
            return result;
        }
        assert!(Instant::now() < deadline, "the swap did not finish");
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// M41's restore swaps the library under the running app: the window lets
/// go of everything holding it (the job can open the library itself, so it
/// was closed), takes up what the job returns and reads its book again; a
/// job that fails leaves the old library in use again and says why.
#[gpui::test]
fn the_library_is_swapped_under_the_running_app(cx: &mut TestAppContext) {
    let (_dir, lib) = slow_clock();
    let root = lib.library().paths().root.clone();
    let (view, cx) = setup_with(cx, SettingsFile::in_memory(), None, Some(lib));
    wait_for(&view, cx, |ws| !ws.book.is_empty());
    let first = view.read_with(cx, |ws, _| chapter_of(ws, 0));
    view.update(cx, |ws, cx| ws.open(first.clone(), Open::KEEP, cx));
    open_page(&view, cx, &first);
    view.update_in(cx, |ws, window, cx| ws.toggle_search(window, cx));
    draw(cx);

    let seen = root.clone();
    let swapped = swap_library(cx, move |root, options| {
        assert_eq!(root, seen.as_path());
        // Only a closed library opens.
        dr_store::Library::open(root, options).map_err(|e| e.to_string())
    });
    assert_eq!(swapped, Ok(()));
    wait_for(&view, cx, |ws| ws.library.is_some() && !ws.book.is_empty());
    let (search, services) = view.read_with(cx, |ws, cx| {
        (
            ws.search.is_some(),
            cx.global::<Services>().library.is_some(),
        )
    });
    assert!(!search, "the search panel went with the old library");
    assert!(services, "Services offers the new library");
    // The new library is in use: a page opens in it.
    let first = view.read_with(cx, |ws, _| chapter_of(ws, 0));
    view.update(cx, |ws, cx| ws.open(first.clone(), Open::KEEP, cx));
    open_page(&view, cx, &first);

    let failed = swap_library(cx, |_, _| Err("备份坏了".into()));
    assert_eq!(failed, Err("备份坏了".into()));
    wait_for(&view, cx, |ws| ws.library.is_some() && !ws.book.is_empty());
    assert!(cx.update(|_, cx| cx.global::<Services>().library.is_some()));
}

/// workspace.md: a sidebar half keeps its list's scroll for the run, per
/// book, side, half and tab: closed with its sidebar and opened again, the
/// chapter list is where it was.
#[gpui::test]
fn a_sidebar_list_comes_back_where_it_was(cx: &mut TestAppContext) {
    let (_dir, lib) = slow_clock();
    let (view, cx) = setup_with(cx, SettingsFile::in_memory(), None, Some(lib));
    wait_for(&view, cx, |ws| !ws.book.is_empty());
    let open_left = |view: &Entity<Workspace>, cx: &mut VisualTestContext| {
        view.update_in(cx, |ws, window, cx| {
            if !ws.left.open {
                ws.toggle_left(window, cx);
            }
            ws.left.reveal.set(1.0);
        });
        draw(cx);
        draw(cx);
    };
    open_left(&view, cx);
    let list = "left-primary-chapters";
    let handle = view
        .read_with(cx, |ws, _| ws.list_scroll(list))
        .expect("the chapter list showed");
    handle.scroll_to_item(30, gpui::ScrollStrategy::Top);
    draw(cx);
    draw(cx);
    let scrolled = handle.0.borrow().base_handle.offset().y;
    assert!(scrolled < gpui::px(0.0), "{scrolled:?}");
    // Closed (the list is not drawn), then opened again.
    view.update_in(cx, |ws, window, cx| {
        ws.toggle_left(window, cx);
        ws.left.reveal.set(0.0);
    });
    draw(cx);
    draw(cx);
    open_left(&view, cx);
    let again = view
        .read_with(cx, |ws, _| ws.list_scroll(list))
        .unwrap()
        .0
        .borrow()
        .base_handle
        .offset()
        .y;
    assert_eq!(again, scrolled);
}

/// F4's link events: a click on a live entity link opens its page as a
/// preview; the slash menu's 位置链接 shows 「已复制位置链接」 for a moment.
#[gpui::test]
fn entity_links_open_and_a_copied_location_link_is_told(cx: &mut TestAppContext) {
    let (_dir, lib) = slow_clock();
    let (view, cx) = setup_with(cx, SettingsFile::in_memory(), None, Some(lib));
    wait_for(&view, cx, |ws| !ws.book.is_empty());
    let (first, element) = view.read_with(cx, |ws, _| {
        (chapter_of(ws, 0), ws.book.elements[0].id.clone())
    });
    let Target::Chapter(id) = &first else {
        unreachable!()
    };
    let doc = format!("node:{id}");
    view.update(cx, |ws, cx| ws.open(first.clone(), Open::KEEP, cx));
    let editor = open_editor(&view, cx, &first);
    editor.update(cx, |_, cx| {
        cx.emit(dr_editor::EntityLinkOpened {
            doc: doc.clone(),
            kind: dr_model::kind::EntityKind::Element,
            id: element.clone(),
        })
    });
    cx.run_until_parked();
    let opened = Target::Element(element.parse().unwrap());
    assert_eq!(
        view.read_with(cx, |ws, _| ws.nav.page()),
        Page::Target(opened),
        "the element's page is in front"
    );
    editor.update(cx, |_, cx| {
        cx.emit(dr_editor::PositionLinkCopied {
            doc,
            link: "drifting:chapters/x/prose.md#L1".into(),
        })
    });
    cx.run_until_parked();
    let shown = view.read_with(cx, |ws, _| {
        ws.toast.as_ref().map(|t| (t.text.clone(), t.shown))
    });
    let (text, on) = shown.expect("a notice");
    assert!(on && !text.is_empty());
    draw(cx);
    cx.executor()
        .advance_clock(dr_shell::workspace::toast::SHOWN + Duration::from_millis(500));
    cx.run_until_parked();
    assert!(
        view.read_with(cx, |ws, _| ws.toast.is_none()),
        "and it goes"
    );
}

/// F4c's selection across chapters in the whole book: its words count (each
/// chapter's part), not the empty range at the caret.
#[gpui::test]
fn a_selection_across_chapters_counts_its_words(cx: &mut TestAppContext) {
    let (_dir, lib) = slow_clock();
    let (view, cx) = setup_with(cx, SettingsFile::in_memory(), None, Some(lib));
    wait_for(&view, cx, |ws| !ws.book.is_empty());
    view.update(cx, |ws, cx| ws.open(Target::Book, Open::KEEP, cx));
    let page = open_page(&view, cx, &Target::Book);
    let prose = cx.update(|_, cx| page.prose(cx));
    cx.update(|window, cx| {
        prose.update(cx, |p, cx| {
            let end = p.book().chapters[1].doc.line_start(1);
            p.select_across(
                gpui_prose::layout::BookPos {
                    chapter: 0,
                    offset: 0,
                },
                gpui_prose::layout::BookPos {
                    chapter: 1,
                    offset: end,
                },
                window,
                cx,
            )
        })
    });
    cx.run_until_parked();
    let words = cx.update(|_, cx| dr_view_stats::LiveWords::read(cx).selection);
    assert!(words.is_some_and(|w| w > 100), "{words:?}");
}

/// A left tab a module draws (`pages::add_left_panel`): made once per half
/// the first time it shows, then kept; the shell's own rows are not drawn.
#[gpui::test]
fn a_module_draws_a_left_tab(cx: &mut TestAppContext) {
    use dr_shell::workspace::LeftTab;
    let (_dir, lib) = slow_clock();
    let (view, cx) = setup_with(cx, SettingsFile::in_memory(), None, Some(lib));
    wait_for(&view, cx, |ws| !ws.book.is_empty());
    let made = std::rc::Rc::new(std::cell::Cell::new(0));
    let count = made.clone();
    cx.update(|_, cx| {
        dr_shell::pages::add_left_panel(cx, move |tab, _, _, cx| {
            (tab == LeftTab::Drifts).then(|| {
                count.set(count.get() + 1);
                dr_shell::pages::LeftPanel {
                    head: cx.new(|_| Blank).into(),
                    body: cx.new(|_| Blank).into(),
                }
            })
        });
    });
    view.update_in(cx, |ws, window, cx| {
        if !ws.left.open {
            ws.toggle_left(window, cx);
        }
        ws.left.reveal.set(1.0);
        ws.left.panes.click(PaneId::Primary, LeftTab::Drifts);
    });
    draw(cx);
    draw(cx);
    draw(cx);
    assert_eq!(made.get(), 1, "made once for the half, then kept");
    view.update(cx, |ws, cx| {
        ws.left.panes.click(PaneId::Primary, LeftTab::Chapters);
        cx.notify();
    });
    draw(cx);
    assert_eq!(made.get(), 1, "another tab asks nobody");
}

/// Registers a stand-in timeline (dragged no lower than 260) and planner
/// (for chapters and ideas) in the Bottom Panel; returns what was made.
fn bottom_modules(cx: &mut VisualTestContext) -> std::rc::Rc<std::cell::RefCell<Vec<String>>> {
    use dr_shell::pages::{BottomPane, BottomPanel};
    let made = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    cx.update(|_, cx| {
        let log = made.clone();
        dr_shell::pages::add_bottom_panel(cx, BottomPane::Timeline, move |host, _, cx| {
            log.borrow_mut().push(format!("timeline {}", host.book_id));
            Some(BottomPanel::new(cx.new(|_| Blank)).min_height(|_| 260.0))
        });
        let log = made.clone();
        dr_shell::pages::add_bottom_panel(cx, BottomPane::Planner, move |host, _, cx| {
            let target = host.target.clone()?;
            matches!(target, Target::Chapter(_) | Target::Idea(_)).then(|| {
                log.borrow_mut().push(target.key());
                BottomPanel::new(cx.new(|_| Blank))
            })
        });
    });
    made
}

/// The Bottom Panel (M14, M15): the timeline at first, 180 tall; ⌘J puts it
/// away and brings it back (closing the planner); the planner shows with a
/// chapter in front and steps aside elsewhere, its choice kept; nothing in
/// immersive writing; what was chosen is kept with the book's layout.
#[gpui::test]
fn the_bottom_panel_holds_the_timeline_or_the_planner(cx: &mut TestAppContext) {
    use dr_shell::pages::BottomPane;
    use dr_shell::workspace::BottomLayout;
    let (_dir, lib) = slow_clock();
    let (view, cx) = setup_with(cx, SettingsFile::in_memory(), None, Some(lib));
    wait_for(&view, cx, |ws| !ws.book.is_empty());
    let pane = |cx: &mut VisualTestContext| view.read_with(cx, |ws, cx| ws.bottom_pane(cx));
    assert_eq!(pane(cx), None, "no module draws it: no panel");
    let made = bottom_modules(cx);
    draw(cx);
    assert_eq!(pane(cx), Some(BottomPane::Timeline));
    assert_eq!(view.read_with(cx, |ws, _| ws.bottom_height()), 180.0);
    assert!(view.read_with(cx, |ws, _| ws.bottom_view(BottomPane::Timeline).is_some()));

    keys(cx, "cmd-j");
    assert_eq!(pane(cx), None, "⌘J puts the timeline away");
    keys(cx, "cmd-j");
    assert_eq!(pane(cx), Some(BottomPane::Timeline));

    let first = view.read_with(cx, |ws, _| chapter_of(ws, 0));
    view.update(cx, |ws, cx| {
        ws.open(first.clone(), Open::KEEP, cx);
        ws.toggle_planner(cx);
    });
    draw(cx);
    assert_eq!(
        pane(cx),
        Some(BottomPane::Planner),
        "the timeline makes way"
    );
    view.update(cx, |ws, cx| ws.open(Target::Book, Open::KEEP, cx));
    draw(cx);
    assert_eq!(
        pane(cx),
        None,
        "no chapter in front: the planner steps aside"
    );
    view.update(cx, |ws, cx| ws.open(first.clone(), Open::KEEP, cx));
    draw(cx);
    assert_eq!(
        pane(cx),
        Some(BottomPane::Planner),
        "and comes back with it"
    );
    assert!(made.borrow().contains(&first.key()));

    keys(cx, "cmd-j");
    assert_eq!(
        pane(cx),
        Some(BottomPane::Timeline),
        "⌘J closes the planner"
    );
    view.update(cx, |ws, cx| ws.set_immersive(true, cx));
    assert_eq!(pane(cx), None, "immersive writing keeps only the paper");
    view.update(cx, |ws, cx| {
        ws.set_immersive(false, cx);
        ws.toggle_planner(cx);
        ws.set_bottom_height(300.0, cx);
    });
    let kept = view.read_with(cx, |ws, _| ws.layout().bottom);
    assert_eq!(
        kept,
        BottomLayout {
            timeline_hidden: true,
            planner_open: true,
            height: 300.0
        }
    );
    let value = serde_json::to_value(view.read_with(cx, |ws, _| ws.layout())).unwrap();
    assert_eq!(value["bottom"]["planner_open"], json!(true));
}

/// The panel's top edge drags its height: the grabbed point stays under
/// the pointer, no lower than the pane needs (the stand-in timeline's 260),
/// no higher than leaves the paper 240.
#[gpui::test]
fn the_bottom_panel_is_dragged_by_its_top_edge(cx: &mut TestAppContext) {
    use gpui::{Modifiers, MouseButton, point, px, size};
    let (_dir, lib) = slow_clock();
    let (view, cx) = setup_with(cx, SettingsFile::in_memory(), None, Some(lib));
    wait_for(&view, cx, |ws| !ws.book.is_empty());
    bottom_modules(cx);
    cx.simulate_resize(size(px(1200.0), px(800.0)));
    draw(cx);
    // Once it has slid open.
    dr_ui::anim::freeze(Some(Instant::now() + Duration::from_secs(2)));
    draw(cx);
    let height = |cx: &mut VisualTestContext| view.read_with(cx, |ws, _| ws.bottom_height());
    // The edge is at 800 - 180 = 620; taken 1px below it.
    let x = px(600.0);
    cx.simulate_mouse_down(point(x, px(621.0)), MouseButton::Left, Modifiers::none());
    cx.simulate_mouse_move(point(x, px(617.0)), MouseButton::Left, Modifiers::none());
    draw(cx);
    cx.simulate_mouse_move(point(x, px(521.0)), MouseButton::Left, Modifiers::none());
    draw(cx);
    assert_eq!(height(cx), 280.0);
    cx.simulate_mouse_move(point(x, px(760.0)), MouseButton::Left, Modifiers::none());
    draw(cx);
    assert_eq!(height(cx), 260.0, "no lower than the pane needs");
    cx.simulate_mouse_move(point(x, px(10.0)), MouseButton::Left, Modifiers::none());
    draw(cx);
    assert_eq!(height(cx), 560.0, "the paper keeps 240");
    cx.simulate_mouse_up(point(x, px(10.0)), MouseButton::Left, Modifiers::none());
    draw(cx);
    dr_ui::anim::freeze(None);
    assert_eq!(view.read_with(cx, |ws, _| ws.layout().bottom.height), 560.0);
}

/// What a module keeps for the book (`book_memory`, the timeline's order and
/// zoom) is in F2's `local_state`, tied to the book, and a workspace opened
/// on the book again reads it back.
#[gpui::test]
fn a_module_keeps_what_it_wants_for_the_book(cx: &mut TestAppContext) {
    let (_dir, lib) = slow_clock();
    let store = lib.clone();
    let (view, cx) = setup_with(cx, SettingsFile::in_memory(), None, Some(lib));
    wait_for(&view, cx, |ws| {
        !ws.book.is_empty() && ws.book_memory_ready()
    });
    let kept = json!({"axis": "narrative", "zoom": 2.0});
    view.update(cx, |ws, cx| {
        ws.set_book_memory("timeline", kept.clone(), cx)
    });
    assert_eq!(
        view.read_with(cx, |ws, _| ws.book_memory("timeline").cloned()),
        Some(kept.clone())
    );
    let book = view.read_with(cx, |ws, _| ws.book_id.clone());
    let deadline = Instant::now() + Duration::from_secs(5);
    let rows = loop {
        cx.run_until_parked();
        let rows = store
            .library()
            .local_entries(dr_shell::workspace::BOOK_MEMORY_SCOPE, Some(&book))
            .unwrap();
        if !rows.is_empty() {
            break rows;
        }
        assert!(Instant::now() < deadline, "not stored");
        std::thread::sleep(Duration::from_millis(5));
    };
    assert_eq!(rows[0].key, format!("memory:{book}:timeline"));
    assert_eq!(rows[0].book_id.as_deref(), Some(book.as_str()));
    let again = cx.update(|window, cx| cx.new(|cx| Workspace::new(window, cx)));
    wait_for(&again, cx, |ws| {
        ws.book_id == book && ws.book_memory_ready()
    });
    assert_eq!(
        again.read_with(cx, |ws, _| ws.book_memory("timeline").cloned()),
        Some(kept)
    );
}

/// A dialog closed from inside its own window's update (a click on its
/// button) goes once that update is over.
#[gpui::test]
fn a_dialog_closes_from_a_click_in_its_window(cx: &mut TestAppContext) {
    let (view, cx) = setup(cx, SettingsFile::in_memory(), None);
    let blank = cx.update(|_, cx| cx.new(|_| Blank));
    let id = blank.entity_id();
    TestAppContext::update(cx, |cx| dr_shell::dialogs::show(cx, blank.into()));
    cx.run_until_parked();
    assert!(view.read_with(cx, |ws, _| ws.modal()));
    view.update_in(cx, |_, _, cx| dr_shell::dialogs::hide(cx, id));
    cx.run_until_parked();
    assert!(!view.read_with(cx, |ws, _| ws.modal()));
}

/// A swap whose library cannot be closed (something still holds it) does
/// not run its job: F3 hands the workspace back and the window carries on
/// with it.
#[gpui::test]
fn a_library_that_will_not_close_is_kept(cx: &mut TestAppContext) {
    let (_dir, lib) = slow_clock();
    let held = lib.clone();
    let (view, cx) = setup_with(cx, SettingsFile::in_memory(), None, Some(lib));
    wait_for(&view, cx, |ws| !ws.book.is_empty());
    let ran = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let job_ran = ran.clone();
    let swapped = swap_library(cx, move |root, options| {
        job_ran.store(true, std::sync::atomic::Ordering::SeqCst);
        dr_store::Library::open(root, options).map_err(|e| e.to_string())
    });
    let why = swapped.unwrap_err();
    assert!(why.contains("could not be closed"), "{why}");
    assert!(
        !ran.load(std::sync::atomic::Ordering::SeqCst),
        "the job did not run"
    );
    wait_for(&view, cx, |ws| ws.library.is_some() && !ws.book.is_empty());
    // The same library, still open.
    let first = view.read_with(cx, |ws, _| chapter_of(ws, 0));
    view.update(cx, |ws, cx| ws.open(first.clone(), Open::KEEP, cx));
    open_page(&view, cx, &first);
    drop(held);
}

/// 「打开恢复前副本」 opens the folder M41's restore saves the library in
/// before replacing it, made if it is not there yet.
#[gpui::test]
fn the_pre_restore_folder_is_made_to_open(cx: &mut TestAppContext) {
    let (_dir, lib) = slow_clock();
    let root = lib.library().paths().root.clone();
    let (_view, cx) = setup_with(cx, SettingsFile::in_memory(), None, Some(lib));
    let folder = cx
        .update(|_, cx| dr_shell::settings::panel::pre_restore_folder(cx))
        .unwrap();
    assert_eq!(folder, dr_store::Library::pre_restore_dir(&root));
    assert!(folder.is_dir());
}

/// A module's own element with a page's hover card (M14's slabs).
struct Carded {
    ws: Entity<Workspace>,
    target: Target,
}

impl gpui::Render for Carded {
    fn render(
        &mut self,
        _: &mut gpui::Window,
        cx: &mut gpui::Context<Self>,
    ) -> impl gpui::IntoElement {
        use gpui::{ParentElement as _, Styled as _, div, px};
        let extra = dr_shell::pages::PageMenuSection {
            title: None,
            items: vec![dr_shell::pages::PageMenuItem {
                id: "to-unaffiliated".into(),
                icon: dr_ui::sand::Icon::Close.into(),
                label: "未归属".into(),
                checked: false,
                danger: false,
                run: std::rc::Rc::new(|_, _| {}),
            }],
        };
        div()
            .size_full()
            .child(dr_shell::workspace::page_hover_card(
                "slab",
                div().w(px(400.0)).h(px(60.0)).child("slab"),
                &self.target,
                &self.ws,
                dr_shell::pages::CardRows {
                    lead: vec![extra.clone()],
                    before_danger: vec![extra],
                },
                cx,
            ))
    }
}

/// `page_hover_card` in a module's own view (here the Bottom Panel's): it
/// reads the workspace while the module draws, and its card opens under
/// the pointer with the page's rows and the module's.
#[gpui::test]
fn a_module_draws_a_pages_hover_card(cx: &mut TestAppContext) {
    use dr_shell::pages::{BottomPane, BottomPanel};
    use gpui::{Modifiers, point, px, size};
    let (_dir, lib) = slow_clock();
    let (view, cx) = setup_with(cx, SettingsFile::in_memory(), None, Some(lib));
    wait_for(&view, cx, |ws| !ws.book.is_empty());
    let first = view.read_with(cx, |ws, _| chapter_of(ws, 0));
    let ws = view.clone();
    cx.update(|_, cx| {
        dr_shell::pages::add_bottom_panel(cx, BottomPane::Timeline, move |_, _, cx| {
            let (ws, target) = (ws.clone(), first.clone());
            Some(BottomPanel::new(cx.new(|_| Carded { ws, target })))
        });
    });
    cx.simulate_resize(size(px(1200.0), px(800.0)));
    draw(cx);
    dr_ui::anim::freeze(Some(Instant::now() + Duration::from_secs(2)));
    draw(cx);
    cx.simulate_mouse_move(point(px(500.0), px(650.0)), None, Modifiers::none());
    for _ in 0..10 {
        draw(cx);
        cx.executor().advance_clock(Duration::from_millis(100));
        cx.run_until_parked();
    }
    draw(cx);
    dr_ui::anim::freeze(None);
}

/// F4e's material notes: a click on an embedded material (`MaterialOpened`)
/// opens it as a preview tab; ⌘⇧H is bound to the editor's highlight, and
/// stays bound after the keymap is built again.
#[gpui::test]
fn an_embedded_material_opens_and_the_highlight_key_is_bound(cx: &mut TestAppContext) {
    let (_dir, lib) = slow_clock();
    let (view, cx) = setup_with(cx, SettingsFile::in_memory(), None, Some(lib));
    wait_for(&view, cx, |ws| !ws.book.is_empty());
    let (first, material) = view.read_with(cx, |ws, _| {
        (chapter_of(ws, 0), ws.book.materials[0].id.clone())
    });
    view.update(cx, |ws, cx| ws.open(first.clone(), Open::KEEP, cx));
    let editor = open_editor(&view, cx, &first);
    editor.update(cx, |_, cx| {
        cx.emit(dr_editor::MaterialOpened {
            doc: "material:note".into(),
            material: material.clone(),
        })
    });
    cx.run_until_parked();
    let opened = Target::from_key(&format!("material:{material}")).unwrap();
    let (page, previewed) = view.read_with(cx, |ws, _| {
        (
            ws.nav.page(),
            ws.nav.active_tab().is_some_and(|t| t.focused().preview),
        )
    });
    assert_eq!(page, Page::Target(opened));
    assert!(previewed, "a preview tab, as the 0.1 note opened it");
    let bound = |cx: &mut VisualTestContext| {
        cx.update(|_, cx| {
            cx.key_bindings()
                .borrow()
                .bindings_for_action(&dr_editor::highlight::ToggleHighlight)
                .count()
        })
    };
    assert_eq!(bound(cx), 1);
    cx.update(|_, cx| dr_shell::keymap::apply(&Default::default(), cx));
    assert_eq!(bound(cx), 1, "still bound after the keymap is rebuilt");
}

/// A page a module draws whole (M19's image and PDF materials): asked
/// before an editor is opened, it lies on the desk instead of the sheet,
/// and goes when its tab closes; the pages it does not take still open in
/// an editor.
#[gpui::test]
fn a_module_draws_a_whole_page_instead_of_an_editor(cx: &mut TestAppContext) {
    struct Whole;
    impl gpui::Render for Whole {
        fn render(
            &mut self,
            _: &mut gpui::Window,
            _: &mut gpui::Context<Self>,
        ) -> impl gpui::IntoElement {
            use gpui::Styled as _;
            gpui::div().size_full()
        }
    }
    let (_dir, lib) = slow_clock();
    let (view, cx) = setup_with(cx, SettingsFile::in_memory(), None, Some(lib));
    wait_for(&view, cx, |ws| !ws.book.is_empty());
    let asked = std::rc::Rc::new(std::cell::Cell::new(0));
    let seen = asked.clone();
    cx.update(|_, cx| {
        dr_shell::pages::add_page_view(cx, move |target, host, _, cx| {
            seen.set(seen.get() + 1);
            assert!(!host.book.is_empty(), "the maker sees the book's lists");
            matches!(target, Target::Material(_)).then(|| dr_shell::pages::ModulePage {
                view: cx.new(|_| Whole).into(),
                focus: cx.focus_handle(),
            })
        });
    });
    let (material, chapter) = view.read_with(cx, |ws, _| {
        (
            Target::Material(ws.book.materials[0].id.parse().unwrap()),
            chapter_of(ws, 0),
        )
    });
    view.update(cx, |ws, cx| ws.open(material.clone(), Open::KEEP, cx));
    let deadline = Instant::now() + Duration::from_secs(5);
    while view.read_with(cx, |ws, _| ws.module_page(&material).is_none()) {
        draw(cx);
        cx.run_until_parked();
        assert!(Instant::now() < deadline, "the module's page did not open");
    }
    draw(cx);
    assert!(
        view.read_with(cx, |ws, _| ws.page_view(&material).is_none()),
        "no editor"
    );
    // In front, the module's page has the keyboard, as an editor would.
    let module_focused = cx.update(|window, cx| {
        let ws = view.read(cx);
        let focus = ws.editors[&material.key()]
            .module
            .as_ref()
            .unwrap()
            .focus
            .clone();
        focus.is_focused(window)
    });
    assert!(module_focused, "the module's page takes the keyboard");
    assert!(asked.get() >= 1);
    // A chapter is not the module's: it opens in an editor, which gets the
    // keyboard back from the module's page.
    view.update(cx, |ws, cx| ws.open(chapter.clone(), Open::KEEP, cx));
    open_page(&view, cx, &chapter);
    assert!(view.read_with(cx, |ws, _| ws.module_page(&chapter).is_none()));
    // Closing the material's tab lets its page go.
    view.update(cx, |ws, cx| {
        ws.nav.forget(&material);
        cx.notify();
    });
    draw(cx);
    cx.run_until_parked();
    draw(cx);
    assert!(view.read_with(cx, |ws, _| ws.module_page(&material).is_none()));
}

/// M40: once a folder is chosen the library's books are written under it;
/// turned off it stops (the folder stays chosen), on again it starts.
#[gpui::test]
fn the_markdown_folder_follows_the_library(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let mut options = dr_workspace::library_options(VERSION);
    options.device = Some(dr_store::Device::open(dir.path().join("device")).unwrap());
    let store = dr_store::Library::open(&root, options.clone()).unwrap();
    dr_testkit::seed::write_book(&store, &dr_testkit::samples::slow_clock().unwrap()).unwrap();
    store.close().unwrap();
    let lib = Library::open(
        dr_store::Library::open(&root, options).unwrap(),
        dr_workspace::WorkspaceOptions::default(),
    )
    .unwrap();
    let (view, cx) = setup_with(cx, SettingsFile::in_memory(), None, Some(lib));
    wait_for(&view, cx, |ws| !ws.book.is_empty());
    let running = |cx: &mut VisualTestContext| cx.update(|_, cx| dr_shell::mirror::is_running(cx));
    assert!(!running(cx), "no folder chosen: nothing written");
    let folder = dir.path().join("markdown");
    let chosen = folder.clone();
    cx.update(|_, cx| dr_shell::mirror::set_folder(chosen, cx));
    assert!(running(cx));
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        cx.run_until_parked();
        let written = std::fs::read_dir(&folder)
            .map(|d| d.flatten().any(|e| e.path().join("正文").is_dir()))
            .unwrap_or(false);
        if written {
            break;
        }
        assert!(Instant::now() < deadline, "the book was not written");
        std::thread::sleep(Duration::from_millis(20));
    }
    cx.update(|_, cx| dr_shell::mirror::set_on(false, cx));
    assert!(!running(cx));
    assert_eq!(
        cx.update(|_, cx| dr_shell::mirror::folder(cx)),
        Some(folder.clone())
    );
    cx.update(|_, cx| dr_shell::mirror::set_on(true, cx));
    assert!(running(cx));
    cx.update(|_, cx| dr_shell::mirror::stop(cx));
}

/// A stand-in hold on the sea: it lets go when dropped.
struct Held(
    dr_shell::pages::SeaHold,
    std::rc::Rc<std::cell::RefCell<Vec<dr_shell::pages::SeaHold>>>,
);

impl Drop for Held {
    fn drop(&mut self) {
        let mut held = self.1.borrow_mut();
        if let Some(at) = held.iter().position(|k| *k == self.0) {
            held.remove(at);
        }
    }
}

/// M24 in the shell, with stand-ins for dr-view-sea: the bookshelf holds
/// the sea; opening a book holds it as a wait until the page is ready, then
/// both let go; the first run lies over the bookshelf until it is done (the
/// device remembers); the tour starts once for the book, and the closed
/// sidebar's toggle is marked for it.
#[gpui::test]
fn the_sea_lies_under_the_shelf_and_the_opening_wait(cx: &mut TestAppContext) {
    use dr_shell::pages::{self, SeaHold};
    use std::cell::RefCell;
    use std::rc::Rc;
    let (_dir, lib) = slow_clock();
    cx.executor().allow_parking();
    cx.update(|cx| {
        dr_shell::init(
            info(),
            Services {
                deep_links: None,
                crash_reports: None,
                library: Some(lib),
                book: None,
            },
            SettingsFile::in_memory(),
            cx,
        );
    });
    let held: Rc<RefCell<Vec<SeaHold>>> = Rc::default();
    let marked: Rc<RefCell<Vec<&'static str>>> = Rc::default();
    let started = Rc::new(std::cell::Cell::new(0));
    let finish: Rc<RefCell<Option<pages::FirstRunDone>>> = Rc::default();
    cx.update(|cx| {
        pages::set_shelf(cx, |_, _, cx| pages::ShelfPage {
            view: cx.new(|_| Blank).into(),
            bell: None,
        });
        let holds = held.clone();
        pages::set_backdrop(
            cx,
            pages::Backdrop {
                draw: Rc::new(|_, _| gpui::IntoElement::into_any_element(gpui::div())),
                hold: Rc::new(move |kind, _, _| {
                    holds.borrow_mut().push(kind);
                    Box::new(Held(kind, holds.clone()))
                }),
                ebbing: Rc::new(|_, _| false),
                on_sea: Rc::new(|_, el| el),
            },
        );
        let keep = finish.clone();
        pages::set_first_run(cx, move |done, _, cx| {
            *keep.borrow_mut() = Some(done);
            pages::FirstRunPage {
                view: cx.new(|_| Blank).into(),
                shows_shelf: Rc::new(|_| false),
            }
        });
        let (marks, starts) = (marked.clone(), started.clone());
        pages::set_guide(
            cx,
            pages::Guide {
                anchor: Rc::new(move |id, el| {
                    marks.borrow_mut().push(id);
                    el
                }),
                start: Rc::new(move |_, _| starts.set(starts.get() + 1)),
                layer: Rc::new(|_, _, _| None),
                reset: Rc::new(|_| {}),
            },
        );
    });
    let (view, cx) = cx.add_window_view(Workspace::new);
    cx.run_until_parked();
    draw(cx);
    assert!(view.read_with(cx, |ws, _| ws.shelf_open));
    assert_eq!(
        *held.borrow(),
        [SeaHold::Surface],
        "the bookshelf lies on the sea"
    );
    assert!(
        view.read_with(cx, |ws, _| ws.sea.first_run_shows()),
        "a first run"
    );
    let done = finish.borrow_mut().take().unwrap();
    cx.update(|window, cx| done(window, cx));
    cx.run_until_parked();
    assert!(view.read_with(cx, |ws, _| !ws.sea.first_run_shows()));
    let remembered =
        cx.update(|_, cx| Settings::device_memory(cx, dr_shell::workspace::FIRST_RUN_DONE));
    assert_eq!(remembered, Some(json!(true)));

    let book = cx.update(|_, cx| {
        cx.global::<Services>()
            .library
            .as_ref()
            .unwrap()
            .call(&Actor::User, "book.list", json!({}))
            .unwrap()["output"][0]["id"]
            .as_str()
            .unwrap()
            .to_owned()
    });
    view.update_in(cx, |ws, window, cx| ws.open_book(&book, window, cx));
    assert!(
        held.borrow().contains(&SeaHold::Loading),
        "opening waits on the sea"
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while !held.borrow().is_empty() {
        draw(cx);
        cx.run_until_parked();
        assert!(
            Instant::now() < deadline,
            "the wait never let go: {:?}",
            held.borrow()
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    draw(cx);
    draw(cx);
    assert_eq!(started.get(), 1, "the tour is offered once for the book");
    assert!(
        marked
            .borrow()
            .contains(&pages::anchors::LEFT_SIDEBAR_CLOSED_TOGGLE),
        "{:?}",
        marked.borrow()
    );
}

/// A Super View a module draws (`pages::add_super_view`): made once for the
/// book the first time the stage shows it, with its header slots; a view
/// nobody registered stays an empty sheet.
#[gpui::test]
fn a_module_draws_a_super_view(cx: &mut TestAppContext) {
    let (_dir, lib) = slow_clock();
    let (view, cx) = setup_with(cx, SettingsFile::in_memory(), None, Some(lib));
    wait_for(&view, cx, |ws| !ws.book.is_empty());
    let made = std::rc::Rc::new(std::cell::Cell::new(0));
    let count = made.clone();
    cx.update(|_, cx| {
        dr_shell::pages::add_super_view(cx, SuperView::Elements, move |host, _, cx| {
            assert!(!host.book_id.is_empty());
            count.set(count.get() + 1);
            dr_shell::pages::SuperViewPage::new(cx.new(|_| Blank))
                .head_start(cx.new(|_| Blank))
                .head_end(cx.new(|_| Blank))
        });
    });
    view.update(cx, |ws, cx| ws.toggle_super_view(SuperView::Elements, cx));
    draw(cx);
    draw(cx);
    assert_eq!(made.get(), 1);
    let page = view.read_with(cx, |ws, _| ws.super_view_content(SuperView::Elements));
    let page = page.expect("the module's content");
    assert!(page.head_start.is_some() && page.head_end.is_some());
    view.update(cx, |ws, cx| ws.toggle_super_view(SuperView::StoryGraph, cx));
    draw(cx);
    assert!(
        view.read_with(cx, |ws, _| ws.super_view_content(SuperView::StoryGraph))
            .is_none(),
        "nobody draws the story graph: an empty sheet"
    );
    view.update(cx, |ws, cx| ws.toggle_super_view(SuperView::Elements, cx));
    draw(cx);
    assert_eq!(made.get(), 1, "kept for the book");
}

/// The 素材库 tab a module draws (`pages::set_library`): made once for the
/// half the first time it shows, then kept; its head takes the header row.
#[gpui::test]
fn a_module_draws_the_library_tab(cx: &mut TestAppContext) {
    use dr_shell::workspace::RightTab;
    let (_dir, lib) = slow_clock();
    let (view, cx) = setup_with(cx, SettingsFile::in_memory(), None, Some(lib));
    wait_for(&view, cx, |ws| !ws.book.is_empty());
    let made = std::rc::Rc::new(std::cell::Cell::new(0));
    let count = made.clone();
    cx.update(|_, cx| {
        dr_shell::pages::set_library(cx, move |_, _, cx| {
            count.set(count.get() + 1);
            dr_shell::pages::LeftPanel {
                head: cx.new(|_| Blank).into(),
                body: cx.new(|_| Blank).into(),
            }
        });
    });
    view.update_in(cx, |ws, window, cx| {
        if !ws.right.open {
            ws.toggle_right(window, cx);
        }
        ws.right.reveal.set(1.0);
        ws.right.panes.click(PaneId::Primary, RightTab::Library);
    });
    draw(cx);
    draw(cx);
    assert_eq!(made.get(), 1, "made once for the half");
    view.update(cx, |ws, cx| {
        ws.right.panes.click(PaneId::Primary, RightTab::Review);
        cx.notify();
    });
    draw(cx);
    view.update(cx, |ws, cx| {
        ws.right.panes.click(PaneId::Primary, RightTab::Library);
        cx.notify();
    });
    draw(cx);
    assert_eq!(made.get(), 1, "then kept");
}

/// The 帮手 tab a module draws (`pages::set_companion`): made once for the
/// half the first time it shows, then kept.
#[gpui::test]
fn a_module_draws_the_companion_tab(cx: &mut TestAppContext) {
    use dr_shell::workspace::RightTab;
    let (_dir, lib) = slow_clock();
    let (view, cx) = setup_with(cx, SettingsFile::in_memory(), None, Some(lib));
    wait_for(&view, cx, |ws| !ws.book.is_empty());
    let made = std::rc::Rc::new(std::cell::Cell::new(0));
    let count = made.clone();
    cx.update(|_, cx| {
        dr_shell::pages::set_companion(cx, move |_, _, cx| {
            count.set(count.get() + 1);
            dr_shell::pages::LeftPanel {
                head: cx.new(|_| Blank).into(),
                body: cx.new(|_| Blank).into(),
            }
        });
    });
    view.update_in(cx, |ws, window, cx| {
        if !ws.right.open {
            ws.toggle_right(window, cx);
        }
        ws.right.reveal.set(1.0);
        ws.right.panes.click(PaneId::Primary, RightTab::Companion);
    });
    draw(cx);
    draw(cx);
    assert_eq!(made.get(), 1, "made once for the half");
    view.update(cx, |ws, cx| {
        ws.right.panes.click(PaneId::Primary, RightTab::Review);
        cx.notify();
    });
    draw(cx);
    view.update(cx, |ws, cx| {
        ws.right.panes.click(PaneId::Primary, RightTab::Companion);
        cx.notify();
    });
    draw(cx);
    assert_eq!(made.get(), 1, "then kept");
}

/// M26: with 「打字时自动沉浸」 on, the author typing (F4's `WritingTyped`)
/// enters immersive writing, every open editor runs its typewriter line,
/// and a press off the paper leaves; entered by hand, a press off the paper
/// does not. The top band brings the tab dots back; a plain key puts them
/// away.
#[gpui::test]
fn typing_enters_immersive_writing_and_a_press_off_the_paper_leaves(cx: &mut TestAppContext) {
    use gpui::{Modifiers, MouseButton, point, px, size};
    let (_dir, lib) = slow_clock();
    let (view, cx) = setup_with(cx, SettingsFile::in_memory(), None, Some(lib));
    wait_for(&view, cx, |ws| !ws.book.is_empty());
    cx.simulate_resize(size(px(1200.0), px(800.0)));
    let first = view.read_with(cx, |ws, _| chapter_of(ws, 0));
    view.update(cx, |ws, cx| ws.open(first.clone(), Open::KEEP, cx));
    let editor = open_editor(&view, cx, &first);
    let Target::Chapter(id) = &first else {
        unreachable!()
    };
    let doc = format!("node:{id}");
    let typed = |cx: &mut VisualTestContext| {
        editor.update(cx, |_, cx| {
            cx.emit(dr_editor::WritingTyped { doc: doc.clone() })
        });
        cx.run_until_parked();
    };
    let state = |cx: &mut VisualTestContext| {
        view.read_with(cx, |ws, _| (ws.immersive, ws.immersed_by_typing()))
    };
    typed(cx);
    assert_eq!(state(cx), (false, false), "the setting is off");
    cx.update(|_, cx| {
        Settings::update(cx, |f| {
            f.set(registry::AUTO_IMMERSIVE, Value::from(true), None)
        })
        .unwrap()
    });
    typed(cx);
    assert_eq!(state(cx), (true, true), "typing entered");
    draw(cx);
    assert!(
        editor.read_with(cx, |e, _| e.immersive()),
        "the typewriter line runs"
    );
    // The paper is centred; the desk at the left is off it.
    cx.simulate_mouse_down(
        point(px(20.0), px(400.0)),
        MouseButton::Left,
        Modifiers::none(),
    );
    cx.simulate_mouse_up(
        point(px(20.0), px(400.0)),
        MouseButton::Left,
        Modifiers::none(),
    );
    cx.run_until_parked();
    assert_eq!(state(cx), (false, false), "a press off the paper left");
    draw(cx);
    assert!(!editor.read_with(cx, |e, _| e.immersive()));

    view.update(cx, |ws, cx| ws.set_immersive(true, cx));
    draw(cx);
    cx.simulate_mouse_down(
        point(px(20.0), px(400.0)),
        MouseButton::Left,
        Modifiers::none(),
    );
    cx.simulate_mouse_up(
        point(px(20.0), px(400.0)),
        MouseButton::Left,
        Modifiers::none(),
    );
    cx.run_until_parked();
    assert_eq!(state(cx), (true, false), "entered by hand: still in");
    cx.simulate_mouse_move(point(px(600.0), px(10.0)), None, Modifiers::none());
    cx.run_until_parked();
    assert!(
        view.read_with(cx, |ws, _| ws.immersion.top),
        "the top band reveals"
    );
    keys(cx, "a");
    assert!(
        !view.read_with(cx, |ws, _| ws.immersion.top),
        "a plain key conceals"
    );
    view.update(cx, |ws, cx| ws.toggle_super_view(SuperView::Elements, cx));
    assert_eq!(state(cx), (false, false), "a Super View ends it");
}
