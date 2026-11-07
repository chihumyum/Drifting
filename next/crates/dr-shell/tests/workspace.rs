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
use dr_shell::workspace::{Item, Layer, SuperView};
use dr_shell::{Services, Settings, SettingsFile, ShellInfo, Workspace};
use dr_workspace::{Actor, Workspace as Library};
use gpui::{Entity, Focusable as _, TestAppContext, VisualTestContext};
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
    // The whole book reads every chapter, titles first.
    view.update(cx, |ws, cx| ws.open(Target::Book, Open::KEEP, cx));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    wait_for(&view, cx, |ws| {
        ws.pages.get("book").is_some_and(|p| p.ready)
    });
    let sections = view.read_with(cx, |ws, _| {
        ws.pages["book"]
            .items
            .iter()
            .filter(|i| matches!(i, Item::Section(_)))
            .count()
    });
    assert_eq!(sections, 24);
    cx.update(|window, cx| window.draw(cx).clear(cx));
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
    let (entries, total, _, _) = cx.update(|_, cx| outline::read(&editor, cx));
    let names: Vec<(u8, &str)> = entries.iter().map(|e| (e.level, e.text.as_str())).collect();
    assert_eq!(names, [(2, "四个部分"), (2, "常见毛病")]);
    assert!(entries[0].top < entries[1].top && entries[1].top < total);
    let line = entries[1].line;
    cx.update(|window, cx| outline::jump_to(&editor, line, window, cx));
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
