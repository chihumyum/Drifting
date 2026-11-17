//! UP (visual polish): a grid tile is drawn wide enough for its name.
use std::time::{Duration, Instant};

use dr_shell::{Services, SettingsFile, ShellInfo, Workspace as Shell};
use dr_view_elements::panel::v3::LevelDisplay;
use dr_workspace::{Actor, Workspace};
use gpui::{App, Entity, TestAppContext, VisualTestContext, px, size};
use serde_json::{Value, json};

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

/// At the largest interface size: the old least width fell furthest short
/// of a CJK name there.
fn open<'a>(
    cx: &'a mut TestAppContext,
    lib: &Workspace,
    book: &str,
) -> (Entity<Shell>, &'a mut VisualTestContext) {
    open_at(cx, lib, book, "largest")
}

fn open_at<'a>(
    cx: &'a mut TestAppContext,
    lib: &Workspace,
    book: &str,
    text_size: &str,
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
            {
                let mut settings = SettingsFile::in_memory();
                settings
                    .set(
                        dr_shell::settings::registry::TEXT_SIZE,
                        text_size.into(),
                        None,
                    )
                    .unwrap();
                settings
            },
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

/// A grid tile is drawn wide enough for its name at a full em a character
/// (the CJK advance of the interface's faces). Its least width counted
/// 12.5px a character, short of the interface's body size, and 「周记面馆」
/// was cut to 「周记…」 with room beside it. At the largest size and with a
/// wide column (several tiles to a line, so what a line has left over cannot
/// make up the shortfall) the old width leaves a six-character name short.
#[gpui::test]
fn a_grid_tile_is_drawn_wide_enough_for_its_name(cx: &mut TestAppContext) {
    let (_dir, lib, book) = seed();
    let snapshot = dr_shell::book::Book::load(&lib, &book).unwrap();
    let v = snapshot.v3().unwrap();
    let people = v
        .entries
        .iter()
        .find(|e| e.title == "人物")
        .unwrap()
        .id
        .clone();
    // Six characters each, all different (auto-link names are unique).
    let names = [
        "广播站录音带",
        "旧火柴厂仓库",
        "县档案馆二楼",
        "怀山钟表铺子",
        "青梅镇老钟楼",
        "周记面馆后门",
        "镇广播站楼上",
        "河埠头石阶下",
        "十七张修理单",
        "刻字的旧怀表",
        "四点十七分钟",
        "九三年的大水",
    ];
    let mut tiles = v.levels[&people].children.clone();
    for i in 0..6 {
        tiles.push(
            call(
                &lib,
                "entry.create",
                json!({"book": book, "parent": people, "template": "tpl-character", "title": format!("合成人物{i}")}),
            )["id"]
                .as_str()
                .unwrap()
                .to_owned(),
        );
    }
    assert!(tiles.len() <= names.len());
    for (tile, name) in tiles.iter().zip(names) {
        call(
            &lib,
            "entry.update",
            json!({"book": book, "id": tile, "title": name}),
        );
    }
    call(
        &lib,
        "tab.put",
        json!({"book": book, "mount": {"kind": "entry", "entry": people}}),
    );
    let (ws, cx) = open(cx, &lib, &book);
    ws.update(cx, |w, cx| {
        w.left.width = 600.0;
        cx.notify();
    });
    tab(&ws, cx, Some(&people));
    let body = dr_ui::tokens::TypeScale::at(dr_ui::tokens::TextSize::Largest).body;
    let needed = px(6.0 * body);
    for (tile, name) in tiles.iter().zip(names) {
        let selector: &'static str = Box::leak(format!("g2-tile-name-{tile}").into_boxed_str());
        wait_until(cx, "the tile drawn", |cx| {
            cx.debug_bounds(selector).is_some()
        });
        let drawn = cx.debug_bounds(selector).unwrap();
        assert!(
            drawn.size.width >= needed,
            "{name} has {:?} to be drawn in, needs {needed:?}",
            drawn.size.width
        );
    }
}

/// UP (kernel-v5 §15 item 50, P4 甲): the compact index's tiles stand in
/// columns of one width, and a short last line keeps to them. A tile was as
/// wide as its own name, so names of different lengths stood off one
/// another's columns.
#[gpui::test]
fn the_compact_indexs_tiles_stand_in_columns(cx: &mut TestAppContext) {
    let (_dir, lib, book) = seed();
    let snapshot = dr_shell::book::Book::load(&lib, &book).unwrap();
    let v = snapshot.v3().unwrap();
    let people = v
        .entries
        .iter()
        .find(|e| e.title == "人物")
        .unwrap()
        .id
        .clone();
    // Names of different lengths, all different (auto-link names are
    // unique): a tile as wide as its own name stands off the columns.
    let names = [
        "钟楼",
        "周记面馆",
        "县档案馆",
        "怀表",
        "镇广播站",
        "河埠",
        "火柴厂",
    ];
    let mut tiles = v.levels[&people].children.clone();
    assert!(tiles.len() <= names.len());
    while tiles.len() < names.len() {
        tiles.push(
            call(
                &lib,
                "entry.create",
                json!({"book": book, "parent": people, "template": "tpl-character", "title": format!("合成{}", tiles.len())}),
            )["id"]
                .as_str()
                .unwrap()
                .to_owned(),
        );
    }
    for (tile, name) in tiles.iter().zip(names) {
        call(
            &lib,
            "entry.update",
            json!({"book": book, "id": tile, "title": name}),
        );
    }
    call(
        &lib,
        "tab.put",
        json!({"book": book, "mount": {"kind": "entry", "entry": people}}),
    );
    let (ws, cx) = open_at(cx, &lib, &book, "standard");
    tab(&ws, cx, Some(&people));
    let selectors: Vec<&'static str> = tiles
        .iter()
        .map(|tile| &*Box::leak(format!("g2-tile-name-{tile}").into_boxed_str()))
        .collect();
    let mut counts = Vec::new();
    for width in [600.0, 280.0, 600.0] {
        ws.update(cx, |w, cx| {
            w.left.width = width;
            cx.notify();
        });
        wait_until(cx, "the tiles drawn after resizing", |cx| {
            selectors.iter().all(|s| cx.debug_bounds(s).is_some())
        });
        // Reflow follows the real list body; let the deferred measurement
        // and the virtual list's new rows both reach paint.
        for _ in 0..4 {
            pump(cx);
        }
        let bounds: Vec<_> = selectors
            .iter()
            .map(|s| cx.debug_bounds(s).unwrap())
            .collect();
        let first_line = bounds
            .iter()
            .filter(|b| b.origin.y == bounds[0].origin.y)
            .count();
        counts.push(first_line);
        let last = bounds.last().unwrap();
        let last_line = bounds
            .iter()
            .filter(|b| b.origin.y == last.origin.y)
            .count();
        assert!(
            last_line < first_line,
            "a short last line at {width}: {first_line} then {last_line}"
        );
        let widths: Vec<f32> = bounds.iter().map(|b| f32::from(b.size.width)).collect();
        assert!(
            widths.iter().all(|w| (w - widths[0]).abs() <= 0.5),
            "unequal columns at {width}: {widths:?}"
        );
        assert!(
            (f32::from(bounds[bounds.len() - last_line].origin.x) - f32::from(bounds[0].origin.x))
                .abs()
                <= 0.5,
            "the last line stays in the left columns at {width}"
        );
    }
    assert!(
        counts[0] >= 4,
        "a 600px column can fit at least four of these names: {counts:?}"
    );
    assert_eq!(counts[1], 2, "the narrow column fits two: {counts:?}");
    assert_eq!(
        counts[2], counts[0],
        "growing again restores the columns: {counts:?}"
    );
}

/// The same categories and their drawn cells are used for both stored
/// compact choices. The entry settings themselves are left alone.
#[gpui::test]
fn grid_and_island_share_the_category_framed_compact_index(cx: &mut TestAppContext) {
    let (_dir, lib, book) = seed();
    let parent = call(
        &lib,
        "entry.create",
        json!({"book": book, "template": "tpl-group", "title": "合成索引", "level": true}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let group = call(&lib, "entry.create", json!({"book": book, "parent": parent, "template": "tpl-group", "title": "合成分类", "level": true}))["id"].as_str().unwrap().to_owned();
    let mut members = Vec::new();
    for title in ["钟楼", "周记面馆", "怀表"] {
        members.push(
            call(
                &lib,
                "entry.create",
                json!({"book": book, "parent": group, "template": "tpl-character", "title": title}),
            )["id"]
                .as_str()
                .unwrap()
                .to_owned(),
        );
    }
    call(
        &lib,
        "entry.update",
        json!({"book": book, "id": parent, "overrides": {"display": "grid"}}),
    );
    call(
        &lib,
        "tab.put",
        json!({"book": book, "mount": {"kind": "entry", "entry": parent}}),
    );
    let (ws, cx) = open_at(cx, &lib, &book, "standard");
    tab(&ws, cx, Some(&parent));
    let selectors: Vec<&'static str> = std::iter::once(format!("g2-island-{group}"))
        .chain(members.iter().map(|id| format!("g2-tile-name-{id}")))
        .map(|s| &*Box::leak(s.into_boxed_str()))
        .collect();
    let mut drawn = Vec::new();
    for display in ["grid", "island"] {
        if display == "island" {
            call(
                &lib,
                "entry.update",
                json!({"book": book, "id": parent, "overrides": {"display": display}}),
            );
        }
        wait(&ws, cx, "the stored display", |w, _| {
            w.book
                .v3()
                .is_some_and(|v| v.levels[&parent].settings.display == display)
        });
        wait_until(cx, "the category frame and all its tiles", |cx| {
            selectors.iter().all(|s| cx.debug_bounds(s).is_some())
        });
        for _ in 0..4 {
            pump(cx);
        }
        let tree = tree_of(&ws, cx).unwrap();
        assert_eq!(
            tree.read_with(cx, |t, _| t.display),
            dr_view_elements::panel::v3::Display::Islands
        );
        drawn.push(
            selectors
                .iter()
                .map(|s| cx.debug_bounds(s).unwrap())
                .collect::<Vec<_>>(),
        );
        assert_eq!(
            dr_shell::book::Book::load(&lib, &book)
                .unwrap()
                .v3()
                .unwrap()
                .levels[&parent]
                .settings
                .display,
            display
        );
    }
    assert_eq!(
        drawn[0], drawn[1],
        "both choices draw the same category frame and tiles"
    );
}
