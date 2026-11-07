//! The workspace on GPUI's test platform: shortcuts reach their actions
//! through the keymap, Esc closes layers one at a time, rebinding takes
//! effect at once, deep links open pages, the layout comes back; and over a
//! real library (the showcase's 《慢钟》, seeded through dr-testkit): the
//! panels list it from F3's queries, a page reads its prose, a chapter
//! trashed through F3 closes its tab.

use std::sync::Arc;
use std::time::{Duration, Instant};

use dr_platform::DeepLinks;
use dr_shell::nav::{Open, Page, Target};
use dr_shell::settings::registry;
use dr_shell::workspace::{Item, Layer, SuperView};
use dr_shell::{Services, Settings, SettingsFile, ShellInfo, Workspace};
use dr_workspace::Workspace as Library;
use gpui::{Entity, TestAppContext, VisualTestContext};
use serde_json::Value;

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
    // The page scrolled to the lines once it was read.
    wait_for(&view, cx, |ws| {
        ws.pages.get(&third.key()).is_some_and(|p| p.ready)
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let lines = view.update(cx, |ws, _| ws.nav.take_reveal(&third));
    assert_eq!(lines, None, "taken by the page");
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
fn a_page_reads_its_prose_and_headings_from_f3(cx: &mut TestAppContext) {
    let (_dir, lib) = slow_clock();
    let (view, cx) = setup_with(cx, SettingsFile::in_memory(), None, Some(lib));
    wait_for(&view, cx, |ws| !ws.book.is_empty());
    let first = view.read_with(cx, |ws, _| chapter_of(ws, 0));
    view.update(cx, |ws, cx| ws.open(first.clone(), Open::KEEP, cx));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    wait_for(&view, cx, |ws| {
        ws.pages.get(&first.key()).is_some_and(|p| p.ready)
    });
    view.read_with(cx, |ws, _| {
        let items = &ws.pages[&first.key()].items;
        assert_eq!(items[0], Item::Head);
        let Item::Para(p) = &items[1] else {
            panic!("{:?}", items[1])
        };
        assert!(p.text.starts_with("推开怀山钟表铺的门时"), "{}", p.text);
        assert_eq!(p.heading, 0);
    });
    // A material note with Markdown headings reads them as H2.
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
    cx.update(|window, cx| window.draw(cx).clear(cx));
    wait_for(&view, cx, |ws| {
        ws.pages.get(&note.key()).is_some_and(|p| p.ready)
    });
    let headings: Vec<u8> = view.read_with(cx, |ws, _| {
        ws.pages[&note.key()]
            .items
            .iter()
            .filter_map(|i| match i {
                Item::Para(p) if p.heading > 0 => Some(p.heading),
                _ => None,
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
    cx.update(|window, cx| window.draw(cx).clear(cx));
    wait_for(&view, cx, |ws| {
        ws.pages.get(&first.key()).is_some_and(|p| p.ready)
    });
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
