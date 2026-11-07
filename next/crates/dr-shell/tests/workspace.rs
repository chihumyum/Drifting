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
/// indexed the open documents (it catches up in the background; the quit
/// hook makes it now).
fn counted(lib: &Library, book: &str, query: &str) -> (u64, usize) {
    lib.before_quit();
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
