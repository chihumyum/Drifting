//! KB (`keyboard-nav`, `kernel-v5.md` §15 item 48, the author's whole-window
//! prototype of 2026-11-17): the left column's keyboard. ⌘⇧L in and out, the
//! tree walked with the arrows, a click or Enter previewing while the keys
//! stay in the tree, Space opening the row's card and the arrows walking
//! it, the Tab row taking ← →, the keyboard's row with a still ring.
use std::{
    rc::Rc,
    time::{Duration, Instant},
};

use dr_shell::{
    Services, Settings, SettingsFile, ShellInfo, Workspace as Shell,
    book::Book,
    nav::{Open, Target},
};
use dr_ui::components::CardKeys;
use dr_view_elements::panel::v3::LevelDisplay;
use dr_workspace::{Actor, Workspace};
use gpui::{
    App, Entity, Modifiers, MouseButton, MouseDownEvent, MouseUpEvent, Point, TestAppContext,
    VisualTestContext, point, px, size,
};
use serde_json::{Value, json};

const BODY: &str = "mod-prose";

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

fn call(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input)
        .unwrap_or_else(|e| panic!("{name}: {e}"))["output"]
        .clone()
}

/// The tiny seed's entries this file walks, by title.
struct Ids {
    manuscript: String,
    act1: String,
    act2: String,
    /// 第1章 … 第4章: two in each act.
    ch: Vec<String>,
    ideas: String,
    storylines: String,
    lighthouse: String,
    /// 「文本素材」: no chapter lives in it or hangs on it.
    texts: String,
}

fn ids(lib: &Workspace, book: &str) -> Ids {
    let snapshot = dr_shell::book::Book::load(lib, book).unwrap();
    let v = snapshot.v3().unwrap();
    let id = |title: &str| {
        v.entries
            .iter()
            .find(|e| e.title.starts_with(title))
            .unwrap_or_else(|| panic!("no entry {title}"))
            .id
            .clone()
    };
    Ids {
        manuscript: id("书稿"),
        act1: id("第一幕"),
        act2: id("第二幕"),
        ch: (1..=4).map(|n| id(&format!("第{n}章"))).collect(),
        ideas: id("构想"),
        storylines: id("故事线"),
        lighthouse: id("灯塔"),
        texts: id("文本素材"),
    }
}

fn open<'a>(
    cx: &'a mut TestAppContext,
    lib: &Workspace,
    book: &str,
) -> (Entity<Shell>, &'a mut VisualTestContext) {
    cx.executor().allow_parking();
    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "0.2.0-dev",
                url_scheme: "drifting-next-dev",
                forced_appearance: Some(dr_ui::Appearance::Light),
            },
            Services {
                library: Some(lib.clone()),
                book: Some(book.to_owned()),
                ..Services::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
        dr_shell::strings::Strings::install(dr_i18n::Locale::ZhCn, cx);
        dr_view_page::init(cx);
        dr_view_elements::init(cx);
    });
    let (ws, vcx) = cx.add_window_view(Shell::new);
    vcx.update(|window, _| window.activate_window());
    vcx.simulate_resize(size(px(1280.0), px(860.0)));
    wait(&ws, vcx, "the book", |w, _| {
        w.book.v3().is_some() && w.book_memory_ready()
    });
    (ws, vcx)
}

fn pump(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| {
        window.simulate_next_frame(cx);
        window.draw(cx).clear(cx);
    });
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
        pump(cx);
        if view.read_with(cx, |ws, cx| done(ws, cx)) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn wait_until(
    cx: &mut VisualTestContext,
    what: &str,
    done: impl Fn(&mut VisualTestContext) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        pump(cx);
        if done(cx) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn keys(cx: &mut VisualTestContext, strokes: &str) {
    for stroke in strokes.split(' ') {
        cx.simulate_keystrokes(stroke);
        pump(cx);
    }
}

fn entry(id: &str) -> Target {
    Target::Entry {
        id: id.parse().unwrap(),
        module: None,
    }
}

fn body(id: &str) -> Target {
    Target::Entry {
        id: id.parse().unwrap(),
        module: Some(BODY.parse().unwrap()),
    }
}

/// Opens `id`'s page kept, its body's editor with the keyboard.
fn open_page(ws: &Entity<Shell>, cx: &mut VisualTestContext, id: &str) {
    ws.update(cx, |w, cx| w.open(body(id), Open::KEEP, cx));
    wait_until(cx, "the body's editor with the keyboard", |cx| {
        editor_has_keys(ws, cx, id)
    });
    pump(cx);
}

fn editor_has_keys(ws: &Entity<Shell>, cx: &mut VisualTestContext, id: &str) -> bool {
    cx.update(|window, cx| {
        ws.read(cx).editor_of(&body(id)).is_some_and(|e| {
            use gpui::Focusable as _;
            e.read(cx).editor().focus_handle(cx).is_focused(window)
        })
    })
}

fn selection(ws: &Entity<Shell>, cx: &mut VisualTestContext, id: &str) -> (usize, usize) {
    cx.update(|_, cx| {
        let s = ws
            .read(cx)
            .editor_of(&body(id))
            .unwrap()
            .read(cx)
            .editor()
            .read(cx)
            .selection();
        (s.anchor, s.head)
    })
}

fn stored(lib: &Workspace, id: &str) -> String {
    call(
        lib,
        "prose.read",
        json!({"doc": format!("body:{id}/{BODY}")}),
    )["paragraphs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["text"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>()
        .join("\n")
}

fn sidebar(
    ws: &Entity<Shell>,
    cx: &mut VisualTestContext,
) -> Entity<dr_shell::v3::sidebar::Sidebar> {
    if !ws.read_with(cx, |w, _| w.left.open) {
        ws.update_in(cx, |w, window, cx| w.toggle_left(window, cx));
    }
    // Open and done sliding in, so a press lands where it was drawn.
    wait(ws, cx, "the left column", |w, _| {
        w.v3_sidebar.is_some() && w.left.shown() >= 1.0
    });
    ws.read_with(cx, |w, _| w.v3_sidebar.clone().unwrap())
}

/// Selects the Tab on `entry` (or 「全部」 for `None`).
fn tab(ws: &Entity<Shell>, cx: &mut VisualTestContext, entry: Option<&str>) {
    let sb = sidebar(ws, cx);
    let id = match entry {
        Some(e) => e.to_owned(),
        None => "tab-all".to_owned(),
    };
    sb.update(cx, |s, cx| s.select(&id, cx));
    wait_until(cx, "the Tab's tree", |cx| tree_of(ws, cx).is_some());
}

fn tree_of(ws: &Entity<Shell>, cx: &mut VisualTestContext) -> Option<Entity<LevelDisplay>> {
    ws.read_with(cx, |w, cx| {
        w.v3_sidebar
            .as_ref()?
            .read(cx)
            .shown_display()?
            .downcast::<LevelDisplay>()
            .ok()
    })
}

fn tree(ws: &Entity<Shell>, cx: &mut VisualTestContext) -> Entity<LevelDisplay> {
    tree_of(ws, cx).expect("the selected Tab's tree")
}

/// The row the keyboard is on: its entry, and whether the tree has the
/// keyboard.
fn kb(ws: &Entity<Shell>, cx: &mut VisualTestContext) -> (Option<String>, bool) {
    let tree = tree(ws, cx);
    cx.update(|window, cx| {
        let t = tree.read(cx);
        let entry = t.keyboard_row().and_then(|key| {
            t.stops()
                .iter()
                .find(|s| s.key == key)
                .map(|s| s.id.clone())
        });
        (entry, t.has_keyboard(window, cx))
    })
}

fn kb_key(ws: &Entity<Shell>, cx: &mut VisualTestContext) -> Option<String> {
    let tree = tree(ws, cx);
    tree.read_with(cx, |t, _| t.keyboard_row().map(str::to_owned))
}

/// The keys of `id`'s rows in the selected Tab's tree, in order.
fn keys_of(ws: &Entity<Shell>, cx: &mut VisualTestContext, id: &str) -> Vec<String> {
    let tree = tree(ws, cx);
    tree.read_with(cx, |t, _| {
        t.stops()
            .iter()
            .filter(|s| s.id == id)
            .map(|s| s.key.clone())
            .collect()
    })
}

fn in_tree(ws: &Entity<Shell>, cx: &mut VisualTestContext, id: &str) -> bool {
    kb(ws, cx) == (Some(id.to_owned()), true)
}

fn card_keys(ws: &Entity<Shell>, cx: &mut VisualTestContext) -> Entity<CardKeys> {
    let tree = tree(ws, cx);
    tree.read_with(cx, |t, _| t.card_keys().expect("a tree the keyboard walks"))
}

fn tabs_have_keys(ws: &Entity<Shell>, cx: &mut VisualTestContext) -> bool {
    let sb = sidebar(ws, cx);
    cx.update(|window, cx| sb.read(cx).tabs_have_keyboard(window))
}

fn selected_tab(ws: &Entity<Shell>, cx: &mut VisualTestContext) -> Value {
    let sb = sidebar(ws, cx);
    sb.read_with(cx, |s, cx| s.state(cx)["selected"].clone())
}

fn click(cx: &mut VisualTestContext, at: Point<gpui::Pixels>, count: usize) {
    cx.simulate_event(MouseDownEvent {
        button: MouseButton::Left,
        position: at,
        modifiers: Modifiers::none(),
        click_count: count,
        first_mouse: false,
    });
    cx.simulate_event(MouseUpEvent {
        button: MouseButton::Left,
        position: at,
        modifiers: Modifiers::none(),
        click_count: count,
    });
    pump(cx);
}

/// Where the row `key` was drawn.
fn row_at(cx: &mut VisualTestContext, key: &str) -> Point<gpui::Pixels> {
    let bounds = cx
        .debug_bounds(Box::leak(format!("kb-row-{key}").into_boxed_str()))
        .unwrap_or_else(|| panic!("row {key} not drawn"));
    point(bounds.origin.x + px(60.0), bounds.center().y)
}

fn painted(cx: &mut VisualTestContext, selector: String) -> bool {
    cx.debug_bounds(Box::leak(selector.into_boxed_str()))
        .is_some()
}

/// ⌘⇧L from the page: the tree has the keyboard on the row of the page in
/// front; ⌘⇧L again, Esc and a press on the paper each give the page the
/// keyboard back, its caret and selection as they were, so typing goes on
/// where it was.
#[gpui::test]
fn cmd_shift_l_goes_in_on_the_page_in_front_and_three_ways_back(cx: &mut TestAppContext) {
    let (_dir, lib, book) = seed();
    let ids = ids(&lib, &book);
    let (ws, cx) = open(cx, &lib, &book);
    tab(&ws, cx, Some(&ids.manuscript));
    let ch1 = ids.ch[0].clone();
    open_page(&ws, cx, &ch1);
    cx.simulate_input("甲");
    pump(cx);
    let before = selection(&ws, cx, &ch1);
    // The page scrolled away from the caret: coming back does not scroll it.
    scroll_page(&ws, cx);
    let scrolled = page_scroll(&ws, cx);
    assert!(scrolled > 0.0, "the page scrolls");

    keys(cx, "cmd-shift-l");
    assert!(in_tree(&ws, cx, &ch1), "the tree, on the page in front");
    assert!(!editor_has_keys(&ws, cx, &ch1));
    keys(cx, "cmd-shift-l");
    assert!(editor_has_keys(&ws, cx, &ch1), "⌘⇧L again: the page");
    assert_eq!(selection(&ws, cx, &ch1), before);
    assert!(!kb(&ws, cx).1);
    assert_eq!(page_scroll(&ws, cx), scrolled, "the page did not scroll");

    keys(cx, "cmd-shift-l");
    assert!(in_tree(&ws, cx, &ch1));
    keys(cx, "escape");
    assert!(editor_has_keys(&ws, cx, &ch1), "Esc: the page");
    assert_eq!(selection(&ws, cx, &ch1), before);
    assert_eq!(page_scroll(&ws, cx), scrolled, "the page did not scroll");

    // A selection, not only a caret, comes back as it was.
    keys(cx, "shift-left");
    let selected = selection(&ws, cx, &ch1);
    assert_ne!(selected.0, selected.1);
    keys(cx, "cmd-shift-l");
    assert!(in_tree(&ws, cx, &ch1));
    // A press on the paper's margin, beside the text.
    let left = ws.read_with(cx, |w, _| w.left.width);
    let scrolled = page_scroll(&ws, cx);
    click(cx, point(px(left + 14.0), px(520.0)), 1);
    assert!(
        editor_has_keys(&ws, cx, &ch1),
        "a press on the paper: the page"
    );
    assert_eq!(selection(&ws, cx, &ch1), selected);
    assert_eq!(page_scroll(&ws, cx), scrolled, "the page did not scroll");
    keys(cx, "right");
    cx.simulate_input("乙");
    wait_until(cx, "the words typed where the caret was", |_| {
        stored(&lib, &ch1).starts_with("甲乙")
    });
}

/// It lands on the row of the page in front; folded away, on the nearest
/// row shown above it; not in the Tab (or nothing in front), on the first.
#[gpui::test]
fn the_keyboard_lands_on_the_page_in_front_or_nearest_or_first(cx: &mut TestAppContext) {
    let (_dir, lib, book) = seed();
    let ids = ids(&lib, &book);
    let (ws, cx) = open(cx, &lib, &book);
    tab(&ws, cx, Some(&ids.manuscript));
    let ch3 = ids.ch[2].clone();
    open_page(&ws, cx, &ch3);
    let t = tree(&ws, cx);
    t.update(cx, |t, cx| t.toggle(&ids.act2, cx));
    pump(cx);
    keys(cx, "cmd-shift-l");
    assert!(in_tree(&ws, cx, &ids.act2), "folded away: the act it is in");
    keys(cx, "escape");
    tab(&ws, cx, Some(&ids.texts));
    keys(cx, "cmd-shift-l");
    assert!(
        in_tree(&ws, cx, &ids.texts),
        "not in this Tab: the first row"
    );
    keys(cx, "escape");
    // A board's Tab (构想) walks no tree: the keyboard stops on the Tab row.
    tab(&ws, cx, Some(&ids.ideas));
    keys(cx, "cmd-shift-l");
    assert!(tabs_have_keys(&ws, cx), "a board: the Tab row");
    keys(cx, "escape");
    assert!(editor_has_keys(&ws, cx, &ch3));
    ws.update(cx, |w, cx| {
        w.nav.go_home();
        cx.notify();
    });
    tab(&ws, cx, Some(&ids.manuscript));
    keys(cx, "cmd-shift-l");
    assert!(
        in_tree(&ws, cx, &ids.manuscript),
        "nothing in front: the first row"
    );
}

/// ⌘⇧L on a closed column opens it and goes in; back on the page it stays
/// open. On a filled column it does nothing. Rebound in Settings, the new
/// keys work and the old do not.
#[gpui::test]
fn a_closed_column_opens_a_filled_one_ignores_and_the_key_rebinds(cx: &mut TestAppContext) {
    let (_dir, lib, book) = seed();
    let ids = ids(&lib, &book);
    let (ws, cx) = open(cx, &lib, &book);
    tab(&ws, cx, Some(&ids.manuscript));
    let ch1 = ids.ch[0].clone();
    open_page(&ws, cx, &ch1);
    ws.update_in(cx, |w, window, cx| w.toggle_left(window, cx));
    wait(&ws, cx, "the column closed", |w, _| !w.left.open);
    keys(cx, "cmd-shift-l");
    wait(&ws, cx, "the column open", |w, _| w.left.open);
    wait_until(cx, "the tree with the keyboard", |cx| {
        in_tree(&ws, cx, &ch1)
    });
    keys(cx, "escape");
    assert!(editor_has_keys(&ws, cx, &ch1));
    assert!(ws.read_with(cx, |w, _| w.left.open), "it stays open");

    ws.update_in(cx, |w, window, cx| {
        w.click_full_moon(dr_shell::workspace::Side::Left, window, cx)
    });
    wait(&ws, cx, "the column filled", |w, _| {
        w.is_filled(dr_shell::workspace::FillPlace::Left)
    });
    let focus_before = cx.update(|window, cx| window.focused(cx));
    keys(cx, "cmd-shift-l");
    assert_eq!(
        cx.update(|window, cx| window.focused(cx)),
        focus_before,
        "filled: nothing"
    );
    assert!(ws.read_with(cx, |w, _| w.is_filled(dr_shell::workspace::FillPlace::Left)));
    ws.update_in(cx, |w, window, cx| {
        w.exit_fill(window, cx);
        w.keyboard_to_page(window, cx);
    });
    wait_until(cx, "the page", |cx| editor_has_keys(&ws, cx, &ch1));

    cx.update(|_, cx| {
        Settings::update(cx, |file| {
            file.set_key_binding("focusLeftSidebar", Some("alt-secondary-k"))
        });
        let overrides = Settings::read(cx).key_bindings();
        dr_shell::keymap::apply(&overrides, cx);
    });
    keys(cx, "cmd-shift-l");
    assert!(editor_has_keys(&ws, cx, &ch1), "the old keys do nothing");
    keys(cx, "cmd-alt-k");
    assert!(in_tree(&ws, cx, &ch1), "the new keys go in");
    keys(cx, "cmd-alt-k");
    assert!(editor_has_keys(&ws, cx, &ch1), "and back");
}

/// ↑↓ go row by row and stop at either end; → unfolds, then goes to the
/// first row inside; ← folds, then goes out to the row it is under; the
/// pointer folding a row the keyboard is inside takes the keyboard to that
/// row.
#[gpui::test]
fn the_arrows_walk_fold_and_go_in_and_out(cx: &mut TestAppContext) {
    let (_dir, lib, book) = seed();
    let ids = ids(&lib, &book);
    let (ws, cx) = open(cx, &lib, &book);
    tab(&ws, cx, Some(&ids.manuscript));
    let ch = ids.ch.clone();
    open_page(&ws, cx, &ch[0]);
    keys(cx, "cmd-shift-l");
    assert!(in_tree(&ws, cx, &ch[0]));
    keys(cx, "down");
    assert!(in_tree(&ws, cx, &ch[1]));
    keys(cx, "down down down");
    assert!(in_tree(&ws, cx, &ch[3]), "the last row");
    keys(cx, "down");
    assert!(in_tree(&ws, cx, &ch[3]), "it stops at the end");
    keys(cx, "left");
    assert!(in_tree(&ws, cx, &ids.act2), "← on a row inside: out");
    keys(cx, "left");
    assert!(in_tree(&ws, cx, &ids.act2));
    let t = tree(&ws, cx);
    assert!(
        t.read_with(cx, |t, _| t.folded.contains(&ids.act2)),
        "← folds"
    );
    keys(cx, "left");
    assert!(in_tree(&ws, cx, &ids.manuscript), "← on a folded row: out");
    keys(cx, "left");
    assert!(
        in_tree(&ws, cx, &ids.manuscript),
        "nothing outside the Tab's own"
    );
    keys(cx, "up");
    assert!(tabs_have_keys(&ws, cx), "↑ on the first row: the Tab row");
    keys(cx, "down");
    // Back in the tree it lands as it comes in: the page in front.
    assert!(in_tree(&ws, cx, &ch[0]));
    keys(cx, "up up");
    assert!(in_tree(&ws, cx, &ids.manuscript));
    keys(cx, "right");
    assert!(
        in_tree(&ws, cx, &ids.act1),
        "→ on an open row: its first row"
    );
    keys(cx, "down");
    assert!(in_tree(&ws, cx, &ch[0]));
    keys(cx, "down down");
    assert!(in_tree(&ws, cx, &ids.act2));
    keys(cx, "right");
    assert!(in_tree(&ws, cx, &ids.act2));
    assert!(
        !t.read_with(cx, |t, _| t.folded.contains(&ids.act2)),
        "→ unfolds"
    );
    keys(cx, "right");
    assert!(in_tree(&ws, cx, &ch[2]), "→ again: the first row inside");
    keys(cx, "right");
    assert!(
        in_tree(&ws, cx, &ch[2]),
        "→ on a row holding nothing: nothing"
    );
    // The pointer folds the act the keyboard is in: the keyboard follows.
    t.update(cx, |t, cx| t.toggle(&ids.act2, cx));
    pump(cx);
    assert!(in_tree(&ws, cx, &ids.act2));
    assert!(!editor_has_keys(&ws, cx, &ch[0]));
}

/// An attached row (with the dotted guide) is walked like a living one: the
/// keyboard stops on it, opens its card and its page, and ← goes to the row
/// it is attached to.
#[gpui::test]
fn an_attached_row_is_walked_like_a_living_one(cx: &mut TestAppContext) {
    let (_dir, lib, book) = seed();
    let ids = ids(&lib, &book);
    // The seed hangs 第1章 on both lines and 第3章 on 灯塔.
    let (ch1, ch3) = (ids.ch[0].clone(), ids.ch[2].clone());
    let (ws, cx) = open(cx, &lib, &book);
    tab(&ws, cx, Some(&ids.storylines));
    open_page(&ws, cx, &ch1);
    let twice = keys_of(&ws, cx, &ch1);
    assert_eq!(twice.len(), 2, "{twice:?}");
    assert!(twice.iter().all(|k| k.contains('~')));
    keys(cx, "cmd-shift-l");
    assert_eq!(
        kb_key(&ws, cx).as_ref(),
        Some(&twice[0]),
        "shown twice: the first"
    );
    // Both rows of the page in front have the brush frame.
    let t = tree(&ws, cx);
    assert!(t.read_with(cx, |t, _| t.stops().iter().filter(|s| s.id == ch1).count()) == 2);
    keys(cx, "down");
    assert!(in_tree(&ws, cx, &ch3), "it stops on the attached row");
    keys(cx, "space");
    let card = card_keys(&ws, cx);
    assert!(card.read_with(cx, |k, _| k.is_open()), "its card opens");
    keys(cx, "escape");
    assert!(in_tree(&ws, cx, &ch3));
    keys(cx, "enter");
    wait(&ws, cx, "its page in front", |w, _| {
        w.nav.current().is_some_and(|t| t.same_page(&entry(&ch3)))
    });
    assert!(in_tree(&ws, cx, &ch3), "a preview: the keyboard stays");
    keys(cx, "left");
    assert!(in_tree(&ws, cx, &ids.lighthouse), "← : the row it hangs on");
}

/// Walking past what shows scrolls the tree, not the page.
#[gpui::test]
fn walking_past_what_shows_scrolls_the_tree(cx: &mut TestAppContext) {
    let (_dir, lib, book) = seed();
    let ids = ids(&lib, &book);
    for n in 0..40 {
        call(
            &lib,
            "entry.create",
            json!({"book": book, "parent": ids.act2, "template": "tpl-chapter", "title": format!("合成 {n}")}),
        );
    }
    let (ws, cx) = open(cx, &lib, &book);
    tab(&ws, cx, Some(&ids.manuscript));
    open_page(&ws, cx, &ids.ch[0]);
    let page = page_scroll(&ws, cx);
    keys(cx, "cmd-shift-l");
    let t = tree(&ws, cx);
    let top = t.read_with(cx, |t, _| t.scroll_state().logical_scroll_top().item_ix);
    assert_eq!(top, 0);
    for _ in 0..40 {
        cx.simulate_keystrokes("down");
    }
    pump(cx);
    pump(cx);
    let key = kb_key(&ws, cx).unwrap();
    assert!(painted(cx, format!("kb-row-{key}")), "the row is drawn");
    let top = t.read_with(cx, |t, _| t.scroll_state().logical_scroll_top().item_ix);
    assert!(top > 0, "the tree scrolled");
    assert_eq!(page_scroll(&ws, cx), page, "the page did not");
    assert!(kb(&ws, cx).1);
}

/// Enter: a preview with the keyboard still in the tree; again on the same
/// row, the page kept and the keyboard there; on a row already kept in
/// front, the page has the keyboard and no tab is added.
#[gpui::test]
fn enter_previews_then_keeps_and_goes_to_the_page(cx: &mut TestAppContext) {
    let (_dir, lib, book) = seed();
    let ids = ids(&lib, &book);
    let (ws, cx) = open(cx, &lib, &book);
    tab(&ws, cx, Some(&ids.manuscript));
    let ch = ids.ch.clone();
    open_page(&ws, cx, &ch[0]);
    keys(cx, "cmd-shift-l");
    keys(cx, "down enter");
    wait(&ws, cx, "a preview of 第2章", |w, _| {
        w.nav.current().is_some_and(|t| t.same_page(&entry(&ch[1])))
    });
    assert!(ws.read_with(cx, |w, _| w.nav.active_tab().unwrap().focused().preview));
    for _ in 0..4 {
        pump(cx);
    }
    assert!(in_tree(&ws, cx, &ch[1]), "the keyboard stays in the tree");
    keys(cx, "enter");
    wait_until(cx, "第2章's editor with the keyboard", |cx| {
        editor_has_keys(&ws, cx, &ch[1])
    });
    assert!(!ws.read_with(cx, |w, _| w.nav.active_tab().unwrap().focused().preview));
    let tabs = ws.read_with(cx, |w, _| w.nav.tabs().len());
    keys(cx, "cmd-shift-l");
    assert!(in_tree(&ws, cx, &ch[1]));
    keys(cx, "enter");
    wait_until(cx, "the editor again", |cx| {
        editor_has_keys(&ws, cx, &ch[1])
    });
    assert_eq!(ws.read_with(cx, |w, _| w.nav.tabs().len()), tabs);
    // The Tab's own row opens its page, not an unfolding.
    keys(cx, "cmd-shift-l up up up");
    assert!(in_tree(&ws, cx, &ids.manuscript));
    keys(cx, "enter");
    wait(&ws, cx, "书稿's page", |w, _| {
        w.nav
            .current()
            .is_some_and(|t| t.same_page(&entry(&ids.manuscript)))
    });
    assert!(in_tree(&ws, cx, &ids.manuscript));
}

/// A click previews and leaves the keyboard in the tree on that row; a
/// double click keeps the page and gives it the keyboard; a press on the
/// tree's blank space brings the keyboard in where it lands.
#[gpui::test]
fn a_click_previews_in_the_tree_a_double_click_goes_to_the_page(cx: &mut TestAppContext) {
    let (_dir, lib, book) = seed();
    let ids = ids(&lib, &book);
    let (ws, cx) = open(cx, &lib, &book);
    tab(&ws, cx, Some(&ids.manuscript));
    let ch = ids.ch.clone();
    open_page(&ws, cx, &ch[0]);
    let key = keys_of(&ws, cx, &ch[2]).remove(0);
    let at = row_at(cx, &key);
    click(cx, at, 1);
    wait(&ws, cx, "a preview of 第3章", |w, _| {
        w.nav.current().is_some_and(|t| t.same_page(&entry(&ch[2])))
    });
    for _ in 0..4 {
        pump(cx);
    }
    assert!(
        in_tree(&ws, cx, &ch[2]),
        "a click: the keyboard in the tree, on that row"
    );
    assert!(ws.read_with(cx, |w, _| w.nav.active_tab().unwrap().focused().preview));
    let key = keys_of(&ws, cx, &ch[3]).remove(0);
    let at = row_at(cx, &key);
    click(cx, at, 1);
    click(cx, at, 2);
    wait_until(cx, "第4章's editor with the keyboard", |cx| {
        editor_has_keys(&ws, cx, &ch[3])
    });
    assert!(!ws.read_with(cx, |w, _| w.nav.active_tab().unwrap().focused().preview));
    assert!(!kb(&ws, cx).1);
    // The blank space under the rows.
    let tree_bounds = cx
        .debug_bounds(Box::leak(
            format!("kb-tree-{}", ids.manuscript).into_boxed_str(),
        ))
        .unwrap();
    click(
        cx,
        point(tree_bounds.center().x, tree_bounds.bottom() - px(20.0)),
        1,
    );
    assert!(
        in_tree(&ws, cx, &ch[3]),
        "blank space: in, on the page in front"
    );
}

/// The ids of the card's rows for `id`, in the card's order.
fn card_rows(ws: &Entity<Shell>, cx: &mut VisualTestContext, id: &str) -> Vec<String> {
    cx.update(|_, cx| {
        let host = dr_shell::pages::PageMenuHost::of(ws, cx);
        dr_shell::v3::card::rows(&entry(id), &host, &Default::default(), cx)
            .iter()
            .map(|r| r.id.to_string())
            .collect()
    })
}

/// The keyboard in the tree onto `id`'s first row, with ↑↓.
fn walk_to(ws: &Entity<Shell>, cx: &mut VisualTestContext, id: &str) {
    let target = keys_of(ws, cx, id).remove(0);
    for _ in 0..40 {
        let t = tree(ws, cx);
        let (at, to) = t.read_with(cx, |t, _| {
            let stops = t.stops();
            let pos = |k: &str| stops.iter().position(|s| s.key == k);
            (t.keyboard_row().and_then(pos), pos(&target))
        });
        match (at, to) {
            (Some(a), Some(b)) if a == b => return,
            (Some(a), Some(b)) if a < b => keys(cx, "down"),
            (Some(_), Some(_)) => keys(cx, "up"),
            _ => panic!("the keyboard is not in the tree"),
        }
    }
    panic!("{id} cannot be reached");
}

fn card_at(ws: &Entity<Shell>, cx: &mut VisualTestContext) -> Option<usize> {
    let keys = card_keys(ws, cx);
    keys.read_with(cx, |k, _| k.at())
}

/// The keyboard in the card onto row `index`, with ↑↓.
fn card_to(ws: &Entity<Shell>, cx: &mut VisualTestContext, index: usize) {
    for _ in 0..20 {
        match card_at(ws, cx) {
            Some(at) if at == index => return,
            Some(at) if at < index => keys(cx, "down"),
            Some(_) => keys(cx, "up"),
            None => panic!("the card is closed"),
        }
    }
    panic!("row {index} cannot be reached");
}

/// A card row's debug selector: the card of the row in list row `row`.
fn card_row_selector(level: &str, row: usize, entry: &str, id: &str) -> String {
    format!("g2-card-{level}-row-{row}-{entry}-{id}")
}

fn list_row(ws: &Entity<Shell>, cx: &mut VisualTestContext, key: &str) -> usize {
    let t = tree(ws, cx);
    t.read_with(cx, |t, _| {
        t.stops()
            .iter()
            .find(|s| s.key == key)
            .and_then(|s| s.list_row)
            .unwrap()
    })
}

/// Space opens the row's card with its first row lit; ↑↓ walk it over the
/// hairline and stop at either end; the pointer moving onto a row takes the
/// keyboard there, one row lit at a time; Esc and Space close it, back on
/// the row; Enter on 「层级」 turns it with the card still open; on 「打开」
/// the page is kept and has the keyboard; on 「新建」 its dialog has it.
#[gpui::test]
fn space_opens_the_card_and_the_arrows_walk_it(cx: &mut TestAppContext) {
    let (_dir, lib, book) = seed();
    let ids = ids(&lib, &book);
    let (ws, cx) = open(cx, &lib, &book);
    tab(&ws, cx, Some(&ids.manuscript));
    let ch = ids.ch.clone();
    open_page(&ws, cx, &ch[0]);
    keys(cx, "cmd-shift-l down space");
    let keys_in = card_keys(&ws, cx);
    assert!(keys_in.read_with(cx, |k, _| k.is_open()));
    let rows = card_rows(&ws, cx, &ch[1]);
    let stops = keys_in.read_with(cx, |k, _| k.stops().to_vec());
    assert_eq!(stops.len(), rows.len());
    let first = stops.iter().position(|s| *s).unwrap();
    let last = stops.iter().rposition(|s| *s).unwrap();
    assert_eq!(card_at(&ws, cx), Some(first), "the first row is lit");
    assert_eq!(
        rows[last], "entry-trash",
        "the danger row last, past the hairline"
    );
    let key = kb_key(&ws, cx).unwrap();
    let row = list_row(&ws, cx, &key);
    let sel = |id: &str| card_row_selector(&ids.manuscript, row, &ch[1], id);
    assert!(painted(cx, format!("{}-keyboard", sel(&rows[first]))));
    keys(cx, "up");
    assert_eq!(card_at(&ws, cx), Some(first), "↑ on the first: it stays");
    for _ in 0..rows.len() + 2 {
        keys(cx, "down");
    }
    assert_eq!(
        card_at(&ws, cx),
        Some(last),
        "↓ to the end over the hairline, then it stays"
    );
    keys(cx, "left right");
    assert_eq!(card_at(&ws, cx), Some(last), "← → do nothing in the card");
    let card_focus = keys_in.read_with(cx, |k, _| k.focus_handle().clone());
    assert!(
        cx.update(|window, _| card_focus.is_focused(window)),
        "the card has the keyboard"
    );
    // The pointer onto 「打开」: the keyboard follows; one row lit.
    let open_row = rows.iter().position(|r| r == "entry-open").unwrap();
    let at = cx
        .debug_bounds(Box::leak(sel("entry-open").into_boxed_str()))
        .expect("the open row");
    cx.simulate_mouse_move(at.center(), None, Modifiers::none());
    pump(cx);
    assert_eq!(card_at(&ws, cx), Some(open_row));
    assert!(painted(cx, format!("{}-keyboard", sel("entry-open"))));
    assert!(!painted(cx, format!("{}-keyboard", sel("entry-trash"))));
    // Esc and Space close it, the keyboard back on its row.
    keys(cx, "escape");
    assert!(!keys_in.read_with(cx, |k, _| k.is_open()));
    assert!(in_tree(&ws, cx, &ch[1]));
    keys(cx, "space");
    assert!(keys_in.read_with(cx, |k, _| k.is_open()));
    keys(cx, "space");
    assert!(!keys_in.read_with(cx, |k, _| k.is_open()));
    assert!(in_tree(&ws, cx, &ch[1]));
    // 「层级」: it turns, the card stays open, the keyboard on it.
    let level = rows.iter().position(|r| r == "entry-toggle-level").unwrap();
    keys(cx, "space");
    card_to(&ws, cx, level);
    keys(cx, "enter");
    wait(&ws, cx, "第2章 a level", |w, _| {
        w.book.v3().unwrap().entry(&ch[1]).unwrap().level
    });
    assert!(
        keys_in.read_with(cx, |k, _| k.is_open()),
        "a switch leaves it open"
    );
    // A level now, the card has 「整书视图」 too: the keyboard stays on
    // 「层级」, wherever it now is.
    let rows = card_rows(&ws, cx, &ch[1]);
    assert!(rows.iter().any(|r| r == "entry-open-book"));
    let level_now = rows.iter().position(|r| r == "entry-toggle-level").unwrap();
    assert_ne!(level_now, level);
    assert_eq!(card_at(&ws, cx), Some(level_now));
    // 「打开」: kept, the page with the keyboard, the card gone.
    let open_row = card_rows(&ws, cx, &ch[1])
        .iter()
        .position(|r| r == "entry-open")
        .unwrap();
    card_to(&ws, cx, open_row);
    keys(cx, "enter");
    wait_until(cx, "第2章's editor with the keyboard", |cx| {
        editor_has_keys(&ws, cx, &ch[1])
    });
    assert!(!keys_in.read_with(cx, |k, _| k.is_open()));
    assert!(!ws.read_with(cx, |w, _| w.nav.active_tab().unwrap().focused().preview));
    // 「新建」: its dialog, with the keyboard.
    keys(cx, "cmd-shift-l space");
    let new = card_rows(&ws, cx, &ch[1])
        .iter()
        .position(|r| r == "entry-new")
        .unwrap();
    card_to(&ws, cx, new);
    keys(cx, "enter");
    wait(&ws, cx, "the new-entry dialog", |w, _| w.dialog.is_some());
    assert!(!kb(&ws, cx).1, "the dialog has the keyboard");
    assert!(!keys_in.read_with(cx, |k, _| k.is_open()));
    // As with the pointer: named in the dialog and made, it opens, its page
    // with the keyboard.
    cx.simulate_input("合成新条目");
    keys(cx, "enter");
    let made = |w: &Shell| {
        let v = w.book.v3()?;
        let e = v.entries.iter().find(|e| e.title == "合成新条目")?;
        w.nav
            .current()
            .is_some_and(|t| t.same_page(&entry(&e.id)))
            .then(|| e.id.clone())
    };
    wait(&ws, cx, "the new entry in front", move |w, _| {
        made(w).is_some()
    });
    let made_id = ws.read_with(cx, |w, _| made(w).unwrap());
    wait_until(cx, "its page with the keyboard", |cx| {
        cx.update(|window, cx| {
            ws.read(cx)
                .editors
                .get(&entry(&made_id).key())
                .and_then(|p| p.v3.as_ref())
                .is_some_and(|page| page.read(cx).focus.contains_focused(window, cx))
        })
    });
    assert!(!kb(&ws, cx).1);
}

/// 「放进最近删除」 in the card: the row goes, the keyboard on the row after
/// it (before it, at the end); ⌘Z brings it back.
#[gpui::test]
fn putting_a_row_away_leaves_the_keyboard_on_the_next(cx: &mut TestAppContext) {
    let (_dir, lib, book) = seed();
    let ids = ids(&lib, &book);
    let (ws, cx) = open(cx, &lib, &book);
    tab(&ws, cx, Some(&ids.manuscript));
    let ch = ids.ch.clone();
    open_page(&ws, cx, &ch[0]);
    let trash = |ws: &Entity<Shell>, cx: &mut VisualTestContext, id: &str| {
        keys(cx, "space");
        let rows = card_rows(ws, cx, id);
        card_to(
            ws,
            cx,
            rows.iter().position(|r| r == "entry-trash").unwrap(),
        );
        keys(cx, "enter");
        let id = id.to_owned();
        wait(ws, cx, "the row gone", move |w, _| {
            w.book.v3().unwrap().entry(&id).is_none()
        });
        pump(cx);
    };
    keys(cx, "cmd-shift-l down");
    assert!(in_tree(&ws, cx, &ch[1]));
    trash(&ws, cx, &ch[1]);
    assert!(in_tree(&ws, cx, &ids.act2), "the row after");
    keys(cx, "cmd-z");
    wait(&ws, cx, "第2章 back", |w, _| {
        w.book.v3().unwrap().entry(&ch[1]).is_some()
    });
    assert!(kb(&ws, cx).1);
    keys(cx, "down down");
    assert!(in_tree(&ws, cx, &ch[3]), "the last row");
    trash(&ws, cx, &ch[3]);
    assert!(in_tree(&ws, cx, &ch[2]), "at the end: the row before");
}

/// The tree's first row, ↑: the Tab row, the selected Tab with the ring;
/// ← → choose the Tab (written with the project) and stop at the ends; ↓
/// goes back into the tree where it lands; Esc goes to the page. A click
/// on a Tab from the tree takes the keyboard into the new Tab's tree; from
/// the page, it stays on the page.
#[gpui::test]
fn the_tab_row_takes_left_right_and_down(cx: &mut TestAppContext) {
    let (_dir, lib, book) = seed();
    let ids = ids(&lib, &book);
    let (ws, cx) = open(cx, &lib, &book);
    tab(&ws, cx, Some(&ids.manuscript));
    let ch1 = ids.ch[0].clone();
    open_page(&ws, cx, &ch1);
    let tab_ids: Vec<String> = ws.read_with(cx, |w, _| {
        w.book
            .v3()
            .unwrap()
            .project
            .tabs
            .iter()
            .map(|t| t.id.clone())
            .collect()
    });
    keys(cx, "cmd-shift-l up up up");
    assert!(tabs_have_keys(&ws, cx));
    assert!(painted(cx, "v3-level-tabs-keyboard".into()));
    assert!(!kb(&ws, cx).1);
    keys(cx, "right");
    assert_eq!(selected_tab(&ws, cx), json!(tab_ids[2]));
    let written = tab_ids[2].clone();
    wait(
        &ws,
        cx,
        "the choice written with the project",
        move |w, _| w.book.v3().unwrap().project.selected_tab.as_deref() == Some(written.as_str()),
    );
    assert!(tabs_have_keys(&ws, cx), "the keyboard stays on the row");
    keys(cx, "left left left");
    assert_eq!(
        selected_tab(&ws, cx),
        json!(tab_ids[0]),
        "it stops at the first"
    );
    for _ in 0..tab_ids.len() + 1 {
        keys(cx, "right");
    }
    assert_eq!(
        selected_tab(&ws, cx),
        json!(tab_ids.last().unwrap()),
        "it stops at the last: the manage button is not on the way"
    );
    assert!(tabs_have_keys(&ws, cx));
    keys(cx, "down");
    wait_until(cx, "the tree", |cx| in_tree(&ws, cx, &ids.texts));
    keys(cx, "up left");
    assert_eq!(selected_tab(&ws, cx), json!(tab_ids[4]));
    keys(cx, "down");
    wait_until(cx, "the story lines' tree", |cx| in_tree(&ws, cx, &ch1));
    keys(cx, "up");
    // The story lines' first row is the Tab's own; ↑ goes up to the row.
    keys(cx, "up up");
    assert!(tabs_have_keys(&ws, cx));
    keys(cx, "escape");
    assert!(
        editor_has_keys(&ws, cx, &ch1),
        "Esc on the Tab row: the page"
    );
    // A click on 「全部」 (the row's first Tab) from the page: the page keeps
    // the keyboard.
    let strip = cx.debug_bounds("v3-tab-strip").unwrap();
    let first_tab = point(strip.origin.x + px(16.0), strip.center().y);
    click(cx, first_tab, 1);
    assert_eq!(selected_tab(&ws, cx), json!(tab_ids[0]));
    assert!(
        editor_has_keys(&ws, cx, &ch1),
        "a click on a Tab: the page keeps it"
    );
    // From the tree: into the new Tab's tree, where it lands.
    tab(&ws, cx, Some(&ids.manuscript));
    keys(cx, "cmd-shift-l");
    assert!(in_tree(&ws, cx, &ch1));
    click(cx, first_tab, 1);
    assert_eq!(selected_tab(&ws, cx), json!(tab_ids[0]));
    wait_until(cx, "the keyboard in 「全部」", |cx| {
        in_tree(&ws, cx, &ids.manuscript)
    });
}

/// Managing takes no keys; Esc ends it and the keyboard is back where it
/// was before (the tree's row, or the page).
#[gpui::test]
fn managing_takes_no_keys_and_gives_the_keyboard_back(cx: &mut TestAppContext) {
    let (_dir, lib, book) = seed();
    let ids = ids(&lib, &book);
    let (ws, cx) = open(cx, &lib, &book);
    tab(&ws, cx, Some(&ids.manuscript));
    let ch1 = ids.ch[0].clone();
    open_page(&ws, cx, &ch1);
    let sb = sidebar(&ws, cx);
    let manage = |cx: &mut VisualTestContext| {
        let row = cx.debug_bounds("v3-tab-row").unwrap();
        click(cx, point(row.right() - px(18.0), row.center().y), 1);
    };
    keys(cx, "cmd-shift-l");
    assert!(in_tree(&ws, cx, &ch1));
    manage(cx);
    assert!(sb.read_with(cx, |s, _| s.is_managing()));
    let before = ws.read_with(cx, |w, _| {
        (
            w.nav.current().cloned(),
            w.book.v3().unwrap().project.clone(),
        )
    });
    let state = sb.read_with(cx, |s, cx| s.state(cx));
    keys(cx, "up down left right enter space");
    assert!(sb.read_with(cx, |s, _| s.is_managing()), "still managing");
    assert_eq!(
        ws.read_with(cx, |w, _| (
            w.nav.current().cloned(),
            w.book.v3().unwrap().project.clone()
        )),
        before,
        "the keys changed nothing"
    );
    assert_eq!(
        sb.read_with(cx, |s, cx| s.state(cx)["selected"].clone()),
        state["selected"]
    );
    keys(cx, "escape");
    assert!(!sb.read_with(cx, |s, _| s.is_managing()));
    assert!(in_tree(&ws, cx, &ch1), "back on the tree's row");
    keys(cx, "escape");
    assert!(editor_has_keys(&ws, cx, &ch1));
    manage(cx);
    assert!(sb.read_with(cx, |s, _| s.is_managing()));
    keys(cx, "escape");
    assert!(!sb.read_with(cx, |s, _| s.is_managing()));
    assert!(editor_has_keys(&ws, cx, &ch1), "back on the page");
}

/// A Tab shown as a grid goes by where its tiles were drawn: ← → one tile,
/// ← on the first out to the row it is under; ↑↓ the line above or below,
/// to the tile nearest across; past the top or bottom line, out of the grid
/// to the row before or after it.
#[gpui::test]
fn a_grid_is_walked_by_where_its_tiles_are(cx: &mut TestAppContext) {
    let (_dir, lib, book) = seed();
    let ids = ids(&lib, &book);
    let snapshot = dr_shell::book::Book::load(&lib, &book).unwrap();
    let v = snapshot.v3().unwrap();
    let people = v
        .entries
        .iter()
        .find(|e| e.title == "人物")
        .unwrap()
        .id
        .clone();
    // 苏竹 陆云水 / 韩水 and one more; then a folder after the grid.
    let mut tiles: Vec<String> = v.levels[&people].children.clone();
    tiles.push(
        call(
            &lib,
            "entry.create",
            json!({"book": book, "parent": people, "template": "tpl-character", "title": "合成人物"}),
        )["id"]
            .as_str()
            .unwrap()
            .to_owned(),
    );
    let after = call(
        &lib,
        "entry.create",
        json!({"book": book, "parent": people, "template": "tpl-group", "title": "合成分组", "level": true}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    call(
        &lib,
        "tab.put",
        json!({"book": book, "mount": {"kind": "entry", "entry": people}}),
    );
    let (ws, cx) = open(cx, &lib, &book);
    open_page(&ws, cx, &ids.ch[0]);
    tab(&ws, cx, Some(&people));
    assert_eq!(
        sidebar(&ws, cx).read_with(cx, |s, cx| s.state(cx)["display"].clone()),
        json!("grid")
    );
    let t = tree(&ws, cx);
    let stops = t.read_with(cx, |t, _| t.stops());
    assert_eq!(
        stops
            .iter()
            .filter(|s| s.tile)
            .map(|s| s.id.clone())
            .collect::<Vec<_>>(),
        tiles
    );
    keys(cx, "cmd-shift-l");
    assert!(in_tree(&ws, cx, &people));
    keys(cx, "down");
    assert!(in_tree(&ws, cx, &tiles[0]), "into the grid: its first tile");
    let tile_ring = |cx: &mut VisualTestContext, ws: &Entity<Shell>, id: &str| {
        let key = keys_of(ws, cx, id).remove(0);
        let row = list_row(ws, cx, &key);
        painted(cx, format!("g2-entry-{people}-row-{row}-{id}-keyboard"))
    };
    assert!(tile_ring(cx, &ws, &tiles[0]), "the tile has the ring");
    keys(cx, "right");
    assert!(in_tree(&ws, cx, &tiles[1]));
    keys(cx, "right");
    assert!(
        in_tree(&ws, cx, &tiles[2]),
        "→ at a line's end: the next line's first"
    );
    keys(cx, "left");
    assert!(
        in_tree(&ws, cx, &tiles[1]),
        "← at a line's start: the line above's last"
    );
    keys(cx, "down");
    assert!(in_tree(&ws, cx, &tiles[3]), "↓: the nearest tile across");
    keys(cx, "up");
    assert!(in_tree(&ws, cx, &tiles[1]));
    keys(cx, "up");
    assert!(
        in_tree(&ws, cx, &people),
        "↑ on the top line: out, the row before"
    );
    keys(cx, "down left");
    assert!(
        in_tree(&ws, cx, &people),
        "← on the first tile: the row it is under"
    );
    keys(cx, "down down down");
    assert!(
        in_tree(&ws, cx, &after),
        "↓ on the bottom line: out, the row after"
    );
    keys(cx, "up");
    assert!(
        in_tree(&ws, cx, &tiles[3]),
        "back into the grid: its last line"
    );
}

/// ⌘Z with the keyboard in the column (the tree, a card, the Tab row) undoes
/// the book's last step; typing there changes nothing.
#[gpui::test]
fn cmd_z_in_the_column_is_the_books_and_typing_does_nothing(cx: &mut TestAppContext) {
    let (_dir, lib, book) = seed();
    let ids = ids(&lib, &book);
    let (ws, cx) = open(cx, &lib, &book);
    tab(&ws, cx, Some(&ids.manuscript));
    let ch = ids.ch.clone();
    open_page(&ws, cx, &ch[0]);
    let text = stored(&lib, &ch[0]);
    let put_away = |ws: &Entity<Shell>, cx: &mut VisualTestContext, id: &str| {
        keys(cx, "space");
        let rows = card_rows(ws, cx, id);
        card_to(
            ws,
            cx,
            rows.iter().position(|r| r == "entry-trash").unwrap(),
        );
        keys(cx, "enter");
        let id = id.to_owned();
        wait(ws, cx, "the row gone", move |w, _| {
            w.book.v3().unwrap().entry(&id).is_none()
        });
    };
    let back = |ws: &Entity<Shell>, cx: &mut VisualTestContext, id: &str| {
        let id = id.to_owned();
        wait(ws, cx, "the row back", move |w, _| {
            w.book.v3().unwrap().entry(&id).is_some()
        });
    };
    keys(cx, "cmd-shift-l down down down");
    assert!(in_tree(&ws, cx, &ch[2]));
    put_away(&ws, cx, &ch[2]);
    assert!(in_tree(&ws, cx, &ch[3]));
    keys(cx, "up up");
    assert!(in_tree(&ws, cx, &ch[1]));
    put_away(&ws, cx, &ch[1]);
    keys(cx, "cmd-z");
    back(&ws, cx, &ch[1]);
    assert!(kb(&ws, cx).1, "in the tree: the book's ⌘Z");
    // With a card open.
    keys(cx, "up");
    assert!(in_tree(&ws, cx, &ch[1]));
    put_away(&ws, cx, &ch[1]);
    keys(cx, "space");
    assert!(card_keys(&ws, cx).read_with(cx, |k, _| k.is_open()));
    keys(cx, "cmd-z");
    back(&ws, cx, &ch[1]);
    // On the Tab row.
    let t = tree(&ws, cx);
    t.update_in(cx, |t, window, cx| t.land(window, cx));
    pump(cx);
    for _ in 0..8 {
        keys(cx, "up");
    }
    assert!(tabs_have_keys(&ws, cx));
    keys(cx, "cmd-z");
    back(&ws, cx, &ch[2]);
    // Typing in the column: nothing.
    keys(cx, "down");
    assert!(kb(&ws, cx).1);
    let (row, revision) = (
        kb_key(&ws, cx),
        ws.read_with(cx, |w, _| w.book.v3().unwrap().revision.clone()),
    );
    cx.simulate_input("字abc");
    for _ in 0..4 {
        pump(cx);
    }
    assert_eq!(kb_key(&ws, cx), row);
    assert!(kb(&ws, cx).1);
    assert_eq!(
        ws.read_with(cx, |w, _| w.book.v3().unwrap().revision.clone()),
        revision
    );
    assert_eq!(stored(&lib, &ch[0]), text, "typing reached no page");
}

/// The keyboard's row has the still ring, beside the brush frame of the
/// page in front; the pointer over another row leaves it there; out of the
/// column the ring goes; on the Tab row the ring is on the selected Tab.
#[gpui::test]
fn the_keyboards_row_has_the_ring_only_while_it_is_there(cx: &mut TestAppContext) {
    let (_dir, lib, book) = seed();
    let ids = ids(&lib, &book);
    let (ws, cx) = open(cx, &lib, &book);
    tab(&ws, cx, Some(&ids.manuscript));
    let ch = ids.ch.clone();
    open_page(&ws, cx, &ch[0]);
    let ring = |cx: &mut VisualTestContext, ws: &Entity<Shell>, id: &str| {
        let key = keys_of(ws, cx, id).remove(0);
        let row = list_row(ws, cx, &key);
        painted(
            cx,
            format!("g2-entry-{}-row-{row}-{id}-keyboard", ids.manuscript),
        )
    };
    assert!(!ring(cx, &ws, &ch[0]));
    keys(cx, "cmd-shift-l");
    assert!(ring(cx, &ws, &ch[0]), "on the page in front's row");
    assert!(
        ws.read_with(cx, |w, _| w.nav.is_selected(&entry(&ch[0]))),
        "with its frame"
    );
    keys(cx, "down");
    assert!(ring(cx, &ws, &ch[1]));
    assert!(!ring(cx, &ws, &ch[0]));
    let key = keys_of(&ws, cx, &ch[2]).remove(0);
    let at = row_at(cx, &key);
    cx.simulate_mouse_move(at, None, Modifiers::none());
    pump(cx);
    assert!(ring(cx, &ws, &ch[1]), "the pointer does not move it");
    assert!(!ring(cx, &ws, &ch[2]));
    keys(cx, "space");
    assert!(
        ring(cx, &ws, &ch[1]),
        "with its card open, the row keeps it"
    );
    keys(cx, "escape escape");
    assert!(editor_has_keys(&ws, cx, &ch[0]));
    for id in &ch {
        assert!(!ring(cx, &ws, id), "out of the column it goes");
    }
    assert!(!painted(cx, "v3-level-tabs-keyboard".into()));
    keys(cx, "cmd-shift-l up up up");
    assert!(
        painted(cx, "v3-level-tabs-keyboard".into()),
        "the Tab row's"
    );
    assert!(!ring(cx, &ws, &ch[0]));
}

/// Where the page in front is scrolled (the outline rail reads it).
fn page_scroll(ws: &Entity<Shell>, cx: &mut VisualTestContext) -> f64 {
    cx.update(|window, cx| {
        let w = ws.read(cx);
        let target = w.nav.current().cloned().expect("a page in front");
        dr_shell::workspace::outline::rows(w, ws.entity_id(), &target, window, cx)
            .expect("the page's rail")
            .scroll
    })
}

/// Scrolls the page in front down a little, over its middle.
fn scroll_page(ws: &Entity<Shell>, cx: &mut VisualTestContext) {
    let left = ws.read_with(cx, |w, _| w.left.width);
    cx.simulate_event(gpui::ScrollEvent {
        position: point(px(left + 400.0), px(500.0)),
        delta: gpui::ScrollDelta::Pixels(point(px(0.0), px(-240.0))),
        ..Default::default()
    });
    pump(cx);
    pump(cx);
}

/// A click on the row of the page already in front leaves no mark behind:
/// back on the page, ⌘[ and ⌘] to it again hand its editor the keyboard
/// (review, 1).
#[gpui::test]
fn a_click_on_the_page_in_front_leaves_no_stay_mark(cx: &mut TestAppContext) {
    let (_dir, lib, book) = seed();
    let ids = ids(&lib, &book);
    let (ws, cx) = open(cx, &lib, &book);
    tab(&ws, cx, Some(&ids.manuscript));
    let ch = ids.ch.clone();
    for id in &ch[..2] {
        ws.update(cx, |w, cx| w.open(entry(id), Open::KEEP, cx));
        let id = id.clone();
        wait_until(cx, "the editor with the keyboard", |cx| {
            editor_has_keys(&ws, cx, &id)
        });
    }
    let key = keys_of(&ws, cx, &ch[1]).remove(0);
    let at = row_at(cx, &key);
    click(cx, at, 1);
    for _ in 0..4 {
        pump(cx);
    }
    assert!(in_tree(&ws, cx, &ch[1]));
    keys(cx, "escape");
    assert!(editor_has_keys(&ws, cx, &ch[1]));
    keys(cx, "cmd-[");
    wait_until(cx, "第1章's editor with the keyboard", |cx| {
        editor_has_keys(&ws, cx, &ch[0])
    });
    keys(cx, "cmd-]");
    wait_until(cx, "第2章's editor with the keyboard again", |cx| {
        editor_has_keys(&ws, cx, &ch[1])
    });
    // And by the tab keys.
    keys(cx, "ctrl-tab");
    keys(cx, "cmd-alt-left");
    wait_until(cx, "第1章 by the tab key", |cx| {
        editor_has_keys(&ws, cx, &ch[0])
    });
    keys(cx, "cmd-alt-right");
    wait_until(cx, "第2章 by the tab key", |cx| {
        editor_has_keys(&ws, cx, &ch[1])
    });
}

/// On the Tab row the selected Tab has a ring of its own, laid over its
/// block: the row looks different with the keyboard on it (review, 2).
#[gpui::test]
fn the_tab_row_rings_the_selected_tab(cx: &mut TestAppContext) {
    let (_dir, lib, book) = seed();
    let ids = ids(&lib, &book);
    let (ws, cx) = open(cx, &lib, &book);
    tab(&ws, cx, Some(&ids.manuscript));
    open_page(&ws, cx, &ids.ch[0]);
    assert!(cx.debug_bounds("v3-level-tabs-keyboard-ring").is_none());
    keys(cx, "cmd-shift-l up up up");
    assert!(tabs_have_keys(&ws, cx));
    let sb = sidebar(&ws, cx);
    let (tabs, selected) = sb.read_with(cx, |s, cx| {
        let state = s.state(cx);
        (state["tabs"].clone(), state["selected"].clone())
    });
    let index = tabs
        .as_array()
        .unwrap()
        .iter()
        .position(|t| t["id"] == selected)
        .unwrap();
    assert_eq!(index, 1, "书稿 is selected");
    // The keyboard is on the selected option, and the ring lies on it.
    let option = cx
        .debug_bounds("v3-level-tabs-keyboard")
        .expect("the keyed Tab");
    let ring = cx
        .debug_bounds("v3-level-tabs-keyboard-ring")
        .expect("the ring is drawn on the selected Tab");
    assert_eq!(ring, option, "the ring covers the selected Tab");
    let strip = cx.debug_bounds("v3-tab-strip").unwrap();
    assert!(ring.origin.x > strip.origin.x, "not on 「全部」, the first");
    keys(cx, "right");
    let moved = cx.debug_bounds("v3-level-tabs-keyboard-ring").unwrap();
    assert!(
        moved.origin.x > ring.origin.x,
        "it moves with the selected Tab"
    );
    keys(cx, "escape");
    assert!(cx.debug_bounds("v3-level-tabs-keyboard-ring").is_none());
}

/// The keyboard's card floats beside its row, tops level, right of the left
/// column; the pointer's still opens below its row (review, 3).
#[gpui::test]
fn the_keyboards_card_floats_beside_its_row(cx: &mut TestAppContext) {
    let (_dir, lib, book) = seed();
    let ids = ids(&lib, &book);
    let (ws, cx) = open(cx, &lib, &book);
    tab(&ws, cx, Some(&ids.manuscript));
    let ch = ids.ch.clone();
    open_page(&ws, cx, &ch[0]);
    keys(cx, "cmd-shift-l down space");
    let key = kb_key(&ws, cx).unwrap();
    let row = list_row(&ws, cx, &key);
    let rows = card_rows(&ws, cx, &ch[1]);
    let first = card_row_selector(&ids.manuscript, row, &ch[1], &rows[0]);
    let lit = cx
        .debug_bounds(Box::leak(format!("{first}-keyboard").into_boxed_str()))
        .expect("the card's first row");
    let row_bounds = cx
        .debug_bounds(Box::leak(format!("kb-row-{key}").into_boxed_str()))
        .unwrap();
    let column = ws.read_with(cx, |w, _| w.left.width);
    assert!(
        lit.origin.x >= row_bounds.right() && lit.origin.x >= px(column),
        "right of the column: {lit:?} {row_bounds:?}"
    );
    assert!(
        lit.origin.y >= row_bounds.origin.y && lit.origin.y < row_bounds.origin.y + px(80.0),
        "its top level with the row's: {lit:?} {row_bounds:?}"
    );
}

/// The column closing with the keyboard in it (its crescent, the toggle
/// action, filling it) gives the page back the keyboard (review, 4).
#[gpui::test]
fn closing_the_column_gives_the_page_the_keyboard(cx: &mut TestAppContext) {
    let (_dir, lib, book) = seed();
    let ids = ids(&lib, &book);
    let (ws, cx) = open(cx, &lib, &book);
    tab(&ws, cx, Some(&ids.manuscript));
    let ch1 = ids.ch[0].clone();
    open_page(&ws, cx, &ch1);
    cx.simulate_input("甲");
    pump(cx);
    // The crescent.
    keys(cx, "cmd-shift-l");
    assert!(in_tree(&ws, cx, &ch1));
    ws.update_in(cx, |w, window, cx| {
        w.click_crescent(dr_shell::workspace::Side::Left, window, cx)
    });
    wait(&ws, cx, "the column closed", |w, _| !w.left.open);
    assert!(editor_has_keys(&ws, cx, &ch1), "the crescent: the page");
    // The toggle action.
    keys(cx, "cmd-shift-l");
    wait_until(cx, "the tree", |cx| in_tree(&ws, cx, &ch1));
    cx.dispatch_action(dr_shell::actions::ToggleLeftSidebar);
    pump(cx);
    wait(&ws, cx, "the column closed", |w, _| !w.left.open);
    assert!(editor_has_keys(&ws, cx, &ch1), "the toggle: the page");
    // Filling it.
    keys(cx, "cmd-shift-l");
    wait_until(cx, "the tree", |cx| in_tree(&ws, cx, &ch1));
    ws.update_in(cx, |w, window, cx| {
        w.click_full_moon(dr_shell::workspace::Side::Left, window, cx)
    });
    wait(&ws, cx, "the column filled", |w, _| {
        w.is_filled(dr_shell::workspace::FillPlace::Left)
    });
    assert!(!kb(&ws, cx).1, "out of the column");
    ws.update_in(cx, |w, window, cx| {
        w.click_full_moon(dr_shell::workspace::Side::Left, window, cx)
    });
    wait_until(cx, "the page once the fill goes", |cx| {
        editor_has_keys(&ws, cx, &ch1)
    });
    cx.simulate_input("乙");
    wait_until(cx, "typing reaching the page", |_| {
        stored(&lib, &ch1).starts_with("甲乙")
    });
}

/// 「层级」 off on a level with entries under it asks first; answered
/// either way, the card is back with the keyboard on 「层级」 (review, 5).
#[gpui::test]
fn the_card_is_back_after_the_level_switch_asks(cx: &mut TestAppContext) {
    let (_dir, lib, book) = seed();
    let ids = ids(&lib, &book);
    let (ws, cx) = open(cx, &lib, &book);
    tab(&ws, cx, Some(&ids.manuscript));
    open_page(&ws, cx, &ids.ch[0]);
    keys(cx, "cmd-shift-l up");
    assert!(in_tree(&ws, cx, &ids.act1));
    keys(cx, "space");
    let keys_in = card_keys(&ws, cx);
    let level = |ws: &Entity<Shell>, cx: &mut VisualTestContext| {
        card_rows(ws, cx, &ids.act1)
            .iter()
            .position(|r| r == "entry-toggle-level")
            .unwrap()
    };
    let to = level(&ws, cx);
    card_to(&ws, cx, to);
    let card_focused = |cx: &mut VisualTestContext, keys: &Entity<CardKeys>| {
        let focus = keys.read_with(cx, |k, _| k.focus_handle().clone());
        cx.update(|window, _| focus.is_focused(window))
    };
    // Asked, then cancelled.
    keys(cx, "enter");
    wait(&ws, cx, "the question", |w, _| w.dialog.is_some());
    keys(cx, "escape");
    wait(&ws, cx, "the question gone", |w, _| w.dialog.is_none());
    wait_until(cx, "the card back", |cx| {
        keys_in.read_with(cx, |k, _| k.is_open()) && card_focused(cx, &keys_in)
    });
    let to = level(&ws, cx);
    assert_eq!(card_at(&ws, cx), Some(to), "on 「层级」");
    assert!(ws.read_with(cx, |w, _| {
        w.book.v3().unwrap().entry(&ids.act1).unwrap().level
    }));
    // Asked, then confirmed.
    keys(cx, "enter");
    wait(&ws, cx, "the question again", |w, _| w.dialog.is_some());
    let dialog = ws.read_with(cx, |w, _| {
        w.dialog
            .clone()
            .unwrap()
            .downcast::<dr_shell::v3::level_switch::TurnOffLevelDialog>()
            .unwrap_or_else(|_| panic!("the level switch's question"))
    });
    dialog.update_in(cx, |d, window, cx| d.confirm(window, cx));
    wait(&ws, cx, "the level off", |w, _| {
        w.dialog.is_none() && !w.book.v3().unwrap().entry(&ids.act1).unwrap().level
    });
    wait_until(cx, "the card back", |cx| {
        keys_in.read_with(cx, |k, _| k.is_open()) && card_focused(cx, &keys_in)
    });
    let to = level(&ws, cx);
    assert_eq!(card_at(&ws, cx), Some(to), "on 「层级」");
}

/// Enter runs the row the keyboard is on by its id: rows that came in
/// since the card was drawn do not move it onto another row, and a row that
/// went runs nothing (review, 6). The shell has the new book before the
/// card is drawn again, and Enter comes then.
#[gpui::test]
fn enter_in_the_card_runs_the_row_by_its_id(cx: &mut TestAppContext) {
    let (_dir, lib, book) = seed();
    let ids = ids(&lib, &book);
    let (ws, cx) = open(cx, &lib, &book);
    tab(&ws, cx, Some(&ids.manuscript));
    let ch = ids.ch.clone();
    open_page(&ws, cx, &ch[0]);
    let enter_on = |cx: &mut VisualTestContext, fresh: Rc<Book>| {
        cx.update(|window, cx| {
            ws.update(cx, |w, _| w.book = fresh);
            window.dispatch_action(Box::new(dr_ui::components::hover_card::Confirm), cx)
        });
    };
    keys(cx, "cmd-shift-l down space");
    let rows = card_rows(&ws, cx, &ch[1]);
    let level = rows.iter().position(|r| r == "entry-toggle-level").unwrap();
    card_to(&ws, cx, level);
    // Another device makes 第2章 a level: 「整书视图」 comes in above
    // 「层级」.
    call(
        &lib,
        "entry.set_level",
        json!({"book": book, "id": ch[1], "level": true}),
    );
    let fresh = Rc::new(Book::load(&lib, &book).unwrap());
    let now = cx.update(|_, cx| {
        let mut host = dr_shell::pages::PageMenuHost::of(&ws, cx);
        host.book = fresh.clone();
        dr_shell::v3::card::rows(&entry(&ch[1]), &host, &Default::default(), cx)
            .iter()
            .map(|r| r.id.to_string())
            .collect::<Vec<_>>()
    });
    assert_ne!(now[level], "entry-toggle-level", "the rows moved under it");
    enter_on(cx, fresh);
    let ch2 = ch[1].clone();
    wait(
        &ws,
        cx,
        "「层级」 run: 第2章 no level again",
        move |w, _| !w.book.v3().unwrap().entry(&ch2).unwrap().level,
    );
    assert!(
        ws.read_with(cx, |w, _| w.dialog.is_none() && w.history.is_none()),
        "not the row now in its place (快照历史)"
    );
    // On 「整书视图」 of a level that stops being one before Enter: nothing.
    keys(cx, "escape escape");
    assert!(editor_has_keys(&ws, cx, &ch[0]));
    keys(cx, "cmd-shift-l");
    walk_to(&ws, cx, &ids.act2);
    keys(cx, "space");
    assert!(card_keys(&ws, cx).read_with(cx, |k, _| k.is_open()));
    let rows = card_rows(&ws, cx, &ids.act2);
    let book_row = rows.iter().position(|r| r == "entry-open-book").unwrap();
    card_to(&ws, cx, book_row);
    call(
        &lib,
        "entry.set_level",
        json!({"book": book, "id": ids.act2, "level": false}),
    );
    let fresh = Rc::new(Book::load(&lib, &book).unwrap());
    let page = ws.read_with(cx, |w, _| w.nav.current().cloned());
    assert!(page.as_ref().is_some_and(|p| p.same_page(&entry(&ch[0]))));
    enter_on(cx, fresh);
    for _ in 0..4 {
        pump(cx);
    }
    assert_eq!(
        ws.read_with(cx, |w, _| w.nav.current().cloned()),
        page,
        "a row that went runs nothing"
    );
    assert!(ws.read_with(cx, |w, _| w.dialog.is_none() && w.composer.is_none()));
}

/// Where the keyboard goes from the card's other rows: 「写批注」 into the
/// comment box, 「编辑模板」 into the template's page, 「快照历史」 into the
/// history, and back to the row when the history closes.
#[gpui::test]
fn the_keyboard_follows_the_cards_rows(cx: &mut TestAppContext) {
    let (_dir, lib, book) = seed();
    let ids = ids(&lib, &book);
    let (ws, cx) = open(cx, &lib, &book);
    tab(&ws, cx, Some(&ids.manuscript));
    let ch = ids.ch.clone();
    open_page(&ws, cx, &ch[0]);
    let run = |ws: &Entity<Shell>, cx: &mut VisualTestContext, row: &str| {
        keys(cx, "cmd-shift-l");
        walk_to(ws, cx, &ch[1]);
        keys(cx, "space");
        let rows = card_rows(ws, cx, &ch[1]);
        card_to(ws, cx, rows.iter().position(|r| r == row).unwrap());
        keys(cx, "enter");
    };
    run(&ws, cx, "entry-write-comment");
    wait(&ws, cx, "the comment box", |w, _| w.composer.is_some());
    let in_text = cx.update(|window, _| {
        window
            .context_stack()
            .iter()
            .any(|c| c.contains(dr_ui::input::area::KEY_CONTEXT))
    });
    assert!(in_text, "「写批注」: the comment box has the keyboard");
    assert!(!kb(&ws, cx).1);
    keys(cx, "escape");
    wait(&ws, cx, "the comment box gone", |w, _| w.composer.is_none());
    run(&ws, cx, "entry-edit-template");
    wait(&ws, cx, "the template's page", |w, _| {
        matches!(w.nav.current(), Some(Target::Template(_)))
    });
    wait_until(cx, "the template's page with the keyboard", |cx| {
        cx.update(|window, cx| {
            let w = ws.read(cx);
            let key = w.nav.current().unwrap().key();
            w.editors
                .get(&key)
                .and_then(|p| p.v3.as_ref())
                .is_some_and(|page| page.read(cx).focus.contains_focused(window, cx))
        })
    });
    assert!(!kb(&ws, cx).1);
    open_page(&ws, cx, &ch[0]);
    run(&ws, cx, "entry-snapshot-history");
    wait(&ws, cx, "the history", |w, _| w.dialog.is_some());
    wait_until(cx, "the history with the keyboard", |cx| {
        cx.update(|window, cx| {
            let w = ws.read(cx);
            !w.focus_handle().is_focused(window)
                && window.focused(cx).is_some()
                && !w
                    .v3_sidebar
                    .as_ref()
                    .is_some_and(|s| s.read(cx).has_keyboard(window, cx))
                && !w.editor_of(&body(&ch[0])).is_some_and(|e| {
                    use gpui::Focusable as _;
                    e.read(cx).editor().focus_handle(cx).is_focused(window)
                })
        })
    });
    // Closed, the history gives the keyboard back to the row it came from.
    keys(cx, "escape");
    wait(&ws, cx, "the history closed", |w, _| w.dialog.is_none());
    wait_until(cx, "the keyboard back on the row", |cx| {
        in_tree(&ws, cx, &ch[1])
    });
}
