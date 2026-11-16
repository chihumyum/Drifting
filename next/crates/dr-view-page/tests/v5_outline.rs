//! OL (`kernel-v5.md` §15 item 32, `handoff/v5-tracks.md` 「OL」): the
//! outline rail lists an entry page's modules, in the page's order, each
//! body's H1, H2 and H3 under its own module; every body is listed whatever
//! the template's `show_outline` says; the corner's one switch hides it;
//! when it does not fit it scrolls on its own, stays where the author left
//! it and follows the page again once the page scrolls; the whole book
//! lists each entry's modules before their headings.
use dr_shell::{
    Services, SettingsFile, ShellInfo, Workspace,
    nav::{Open, Target},
    workspace::outline::{self, MODULE, PITCH},
};
use dr_workspace::{Actor, Workspace as Library};
use gpui::{
    Entity, Modifiers, ScrollDelta, ScrollEvent, TestAppContext, VisualTestContext, point, px, size,
};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

fn call(lib: &Library, name: &str, input: Value) -> Value {
    lib.call(&Actor::User, name, input).unwrap()["output"].clone()
}

/// The tiny seed; its chapter template's modules made 「章节信息」
/// (fields), 「正文」 and a second body 「来历」, neither body with
/// `show_outline`; one chapter's two bodies written with `headings`
/// headings each (H1 and H2 by turns, `heading(n)` the words of the n-th
/// of the chapter), each followed by `paragraphs` paragraphs.
fn fixture(
    heading: &dyn Fn(usize) -> String,
    headings: usize,
    paragraphs: usize,
) -> (tempfile::TempDir, Library, String, String) {
    let dir = tempfile::tempdir().unwrap();
    let store = dr_store::Library::open(dir.path(), dr_workspace::library_options("test")).unwrap();
    let seed = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let book = seed.books[0].book_id().to_string();
    seed.write_to(&store).unwrap();
    store.close().unwrap();
    let lib = Library::open_dir(dir.path(), "test").unwrap();
    let templates = call(&lib, "entry_template.list", json!({"book": book}));
    let chapter_template = templates
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == "tpl-chapter")
        .unwrap()
        .clone();
    let module = |id: &str| {
        chapter_template["modules"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["id"] == id)
            .unwrap()
            .clone()
    };
    call(
        &lib,
        "entry_template.remove_module",
        json!({"book": book, "template": "tpl-chapter", "module": "mod-plot-grid"}),
    );
    let mut prose = module("mod-prose");
    prose["config"]["show_outline"] = false.into();
    call(
        &lib,
        "entry_template.put_module",
        json!({"book": book, "template": "tpl-chapter", "module": prose}),
    );
    let origin_pos = format!("{}V", prose["pos"].as_str().unwrap());
    call(
        &lib,
        "entry_template.put_module",
        json!({"book": book, "template": "tpl-chapter", "module": {
            "id": "mod-origin", "kind": "prose", "name": "来历", "pos": origin_pos,
            "config": {"show_outline": false}
        }}),
    );
    let chapter = call(&lib, "entry.list", json!({"book": book, "all": true}))
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["template"] == "tpl-chapter")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let body = |first: usize| -> Vec<Value> {
        let mut out = Vec::new();
        for n in first..first + headings {
            out.push(json!({"text": heading(n), "heading": if n % 2 == 0 { 1 } else { 2 }}));
            for k in 0..paragraphs {
                out.push(json!({"text": format!("第 {n} 节的第 {k} 段，写得长一些，好让这一页比窗口高出许多，滚得动。")}));
            }
        }
        out
    };
    for (module, first) in [("mod-prose", 0), ("mod-origin", headings)] {
        call(
            &lib,
            "module.set_prose",
            json!({"book": book, "owner": chapter, "module": module, "paragraphs": body(first)}),
        );
    }
    (dir, lib, book, chapter)
}

/// A debug selector built at run time (GPUI wants it for the whole test).
fn sel(name: String) -> &'static str {
    Box::leak(name.into_boxed_str())
}

fn pump(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|w, cx| {
        w.simulate_next_frame(cx);
        w.draw(cx).clear(cx);
    });
    cx.run_until_parked();
}

fn wait(
    cx: &mut VisualTestContext,
    what: &str,
    mut done: impl FnMut(&mut VisualTestContext) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        pump(cx);
        if done(cx) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(3));
    }
}

/// Draws until the page has stopped moving (a body corrects its estimated
/// heights as it lays paragraphs out, and the page takes the difference).
fn settle(view: &Entity<Workspace>, cx: &mut VisualTestContext, target: &Target) {
    let scroll = |cx: &mut VisualTestContext| {
        cx.update(|window, cx| {
            outline::rows(view.read(cx), view.entity_id(), target, window, cx).map(|r| r.scroll)
        })
    };
    let mut still = 0;
    let mut last = scroll(cx);
    let deadline = Instant::now() + Duration::from_secs(10);
    while still < 4 {
        pump(cx);
        let now = scroll(cx);
        still = if now == last { still + 1 } else { 0 };
        last = now;
        assert!(Instant::now() < deadline, "the page keeps moving");
    }
}

fn setup<'a>(
    cx: &'a mut TestAppContext,
    lib: &Library,
    book: &str,
    window: gpui::Size<gpui::Pixels>,
) -> (Entity<Workspace>, &'a mut VisualTestContext) {
    cx.executor().allow_parking();
    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "test",
                url_scheme: "drifting-next-dev",
                forced_appearance: Some(dr_ui::Appearance::Light),
            },
            Services {
                library: Some(lib.clone()),
                book: Some(book.into()),
                ..Default::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
        dr_shell::strings::Strings::install(dr_i18n::Locale::ZhCn, cx);
        dr_view_page::init(cx);
    });
    let (view, cx) = cx.add_window_view(Workspace::new);
    cx.simulate_resize(window);
    cx.update(|w, _| w.activate_window());
    wait(cx, "the book", |cx| {
        view.read_with(cx, |w, _| w.book.v3().is_some())
    });
    (view, cx)
}

/// Each row of the rail: its level and words.
type Listed = Vec<(u8, String)>;

/// What the rail lists for `target`, and the row being read.
fn rows(
    view: &Entity<Workspace>,
    cx: &mut VisualTestContext,
    target: &Target,
) -> Option<(Listed, Option<usize>)> {
    cx.update(|window, cx| {
        let rows = outline::rows(view.read(cx), view.entity_id(), target, window, cx)?;
        Some((
            rows.entries
                .iter()
                .map(|e| (e.level, e.text.clone()))
                .collect(),
            rows.active(),
        ))
    })
}

/// The module a row sits under: the nearest module row at or above it.
fn module_of(listed: &[(u8, String)], i: usize) -> &str {
    listed[..=i]
        .iter()
        .rev()
        .find(|(level, _)| *level == MODULE)
        .map(|(_, text)| text.as_str())
        .unwrap()
}

#[gpui::test]
fn an_entry_page_lists_its_modules_with_each_bodys_headings(cx: &mut TestAppContext) {
    let heading = |n: usize| format!("标题{n}");
    let (_dir, lib, book, chapter) = fixture(&heading, 2, 30);
    let (view, cx) = setup(cx, &lib, &book, size(px(1800.), px(1000.)));
    let page = Target::Entry {
        id: chapter.parse().unwrap(),
        module: None,
    };
    view.update(cx, |w, cx| w.open(page.clone(), Open::KEEP, cx));
    let expected = vec![
        (MODULE, "章节信息".to_owned()),
        (MODULE, "正文".to_owned()),
        (4, heading(0)),
        (5, heading(1)),
        (MODULE, "来历".to_owned()),
        (4, heading(2)),
        (5, heading(3)),
    ];
    wait(cx, "the page's modules and both bodies' headings", |cx| {
        rows(&view, cx, &page).is_some_and(|(listed, _)| listed == expected)
    });
    let key = page.key();
    assert!(
        cx.debug_bounds(sel(format!("outline-rail-{key}")))
            .is_some(),
        "the rail is drawn"
    );
    // To the second body's H2 by the rail: it is the row read, under 「来历」.
    let row = cx
        .debug_bounds(sel(format!("outline-row-{key}-6")))
        .expect("the row of the second body's H2");
    cx.simulate_click(row.center(), Modifiers::default());
    wait(cx, "the second body's heading read", |cx| {
        rows(&view, cx, &page).is_some_and(|(_, active)| active == Some(6))
    });
    let (listed, active) = rows(&view, cx, &page).unwrap();
    assert_eq!(listed[active.unwrap()].1, heading(3));
    assert_eq!(module_of(&listed, active.unwrap()), "来历");
    // Back to the first body's H1: the reading follows into the first.
    let row = cx
        .debug_bounds(sel(format!("outline-row-{key}-2")))
        .expect("the row of the first body's H1");
    cx.simulate_click(row.center(), Modifiers::default());
    wait(cx, "the first body's heading read", |cx| {
        rows(&view, cx, &page).is_some_and(|(_, active)| active == Some(2))
    });
    let (listed, active) = rows(&view, cx, &page).unwrap();
    assert_eq!(module_of(&listed, active.unwrap()), "正文");
    // A module's row puts the module's top at the top of the page (its
    // first heading, just under its head, is then the row read).
    let row = cx
        .debug_bounds(sel(format!("outline-row-{key}-4")))
        .expect("the second body's module row");
    cx.simulate_click(row.center(), Modifiers::default());
    let module_at_top = |cx: &mut VisualTestContext| {
        cx.update(|window, cx| {
            let rows = outline::rows(view.read(cx), view.entity_id(), &page, window, cx).unwrap();
            (rows.entries[4].top - rows.scroll).abs() < 1.0
        })
    };
    wait(cx, "the second body's module at the top", module_at_top);
    let (listed, active) = rows(&view, cx, &page).unwrap();
    assert_eq!(module_of(&listed, active.unwrap()), "来历");
    // The corner's switch: the whole rail goes, and comes back.
    view.update(cx, |w, cx| {
        w.outline_hidden = true;
        cx.notify();
    });
    pump(cx);
    assert!(
        cx.debug_bounds(sel(format!("outline-rail-{key}")))
            .is_none(),
        "the switch hides the rail"
    );
    view.update(cx, |w, cx| {
        w.outline_hidden = false;
        cx.notify();
    });
    pump(cx);
    assert!(
        cx.debug_bounds(sel(format!("outline-rail-{key}")))
            .is_some()
    );
}

#[gpui::test]
fn a_rail_that_does_not_fit_scrolls_and_stays_until_the_page_scrolls(cx: &mut TestAppContext) {
    let heading = |n: usize| format!("第{n}个标题");
    let (_dir, lib, book, chapter) = fixture(&heading, 40, 4);
    let (view, cx) = setup(cx, &lib, &book, size(px(1800.), px(700.)));
    let page = Target::Entry {
        id: chapter.parse().unwrap(),
        module: None,
    };
    view.update(cx, |w, cx| w.open(page.clone(), Open::KEEP, cx));
    // Three modules and 80 headings: more than the rail holds.
    wait(cx, "every row", |cx| {
        rows(&view, cx, &page).is_some_and(|(listed, _)| listed.len() == 83)
    });
    let key = page.key();
    let rail = cx
        .debug_bounds(sel(format!("outline-rail-{key}")))
        .expect("the rail");
    assert!(
        rail.size.height < px(83. * PITCH),
        "the rows do not fit: {rail:?}"
    );
    let offset = |view: &Entity<Workspace>, cx: &mut VisualTestContext| {
        view.read_with(cx, |w, _| w.outline_scroll(&page).unwrap())
    };
    assert_eq!(
        offset(&view, cx),
        0.0,
        "reading the top: the rail at its top"
    );
    // Nothing is folded: the last row is laid out below the rail's bottom.
    let last = cx
        .debug_bounds(sel(format!("outline-row-{key}-82")))
        .expect("the last row is there");
    assert!(last.top() > rail.bottom());
    // The page scrolls far down: the rail follows the row read, keeping it
    // three rows or more from its edges.
    let body = cx
        .debug_bounds("v3-section-mod-prose")
        .expect("the first body");
    let at_page = point(body.center().x, rail.center().y);
    let wheel = |cx: &mut VisualTestContext, at, dy: f32| {
        cx.simulate_mouse_move(at, None, Modifiers::default());
        cx.simulate_event(ScrollEvent {
            position: at,
            delta: ScrollDelta::Pixels(point(px(0.), px(dy))),
            ..Default::default()
        });
        pump(cx);
        pump(cx);
    };
    wheel(cx, at_page, -40_000.);
    settle(&view, cx, &page);
    let followed = |view: &Entity<Workspace>, cx: &mut VisualTestContext| {
        let (_, active) = rows(view, cx, &page).unwrap();
        let active = active.unwrap();
        let rail = cx.debug_bounds(sel(format!("outline-rail-{key}"))).unwrap();
        let row = cx
            .debug_bounds(sel(format!("outline-row-{key}-{active}")))
            .unwrap();
        (active, rail, row)
    };
    // In view, and three rows from an edge unless the rail is at that end
    // (half a row of it is the label's own height).
    let kept = |cx: &mut VisualTestContext,
                row: gpui::Bounds<gpui::Pixels>,
                rail: gpui::Bounds<gpui::Pixels>| {
        let margin = px(2. * PITCH);
        let at_top = offset(&view, cx) == 0.0;
        let last = cx
            .debug_bounds(sel(format!("outline-row-{key}-82")))
            .unwrap();
        let at_end = last.bottom() <= rail.bottom() + px(1.);
        row.top() >= rail.top()
            && row.bottom() <= rail.bottom()
            && (at_top || row.top() >= rail.top() + margin)
            && (at_end || row.bottom() <= rail.bottom() - margin)
    };
    let (active, rail_now, row) = followed(&view, cx);
    assert!(active > 60, "read far down: row {active}");
    let followed_to = offset(&view, cx);
    assert!(followed_to > 0.0, "the rail followed");
    assert!(
        kept(cx, row, rail_now),
        "the row read keeps its distance from the edges: {row:?} in {rail_now:?}"
    );
    // The author scrolls the rail back up: it stays there, frame after
    // frame, while the page does not move.
    wheel(cx, rail_now.center(), 400.);
    let left_at = offset(&view, cx);
    assert!(
        left_at < followed_to,
        "the rail scrolled: {left_at} < {followed_to}"
    );
    for _ in 0..5 {
        pump(cx);
    }
    assert_eq!(offset(&view, cx), left_at, "it stays where it was left");
    // The page scrolls a little (back up: it is at its end): the rail
    // follows the row read again.
    wheel(cx, at_page, 120.);
    settle(&view, cx, &page);
    let (active, rail_now, row) = followed(&view, cx);
    assert_ne!(offset(&view, cx), left_at, "the rail came back to the page");
    assert!(
        kept(cx, row, rail_now),
        "row {active} read is in view again: {row:?} in {rail_now:?}"
    );
}

#[gpui::test]
fn the_whole_book_lists_each_entrys_modules_then_their_headings(cx: &mut TestAppContext) {
    let heading = |n: usize| format!("全书标题{n}");
    let (_dir, lib, book, chapter) = fixture(&heading, 2, 2);
    let entries = call(&lib, "entry.list", json!({"book": book, "all": true}));
    let entries = entries.as_array().unwrap();
    let title = entries
        .iter()
        .find(|e| e["id"] == chapter.as_str())
        .unwrap()["title"]
        .as_str()
        .unwrap()
        .to_owned();
    let manuscript = entries
        .iter()
        .find(|e| e["template"] == "tpl-manuscript")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let (view, cx) = setup(cx, &lib, &book, size(px(1800.), px(1000.)));
    let whole = Target::Book(manuscript.parse().unwrap());
    view.update(cx, |w, cx| w.open(whole.clone(), Open::KEEP, cx));
    wait(cx, "the whole book's rows", |cx| {
        rows(&view, cx, &whole)
            .is_some_and(|(listed, _)| listed.iter().any(|(_, t)| *t == heading(3)))
    });
    let (listed, _) = rows(&view, cx, &whole).unwrap();
    let at = listed
        .iter()
        .position(|(level, text)| *level == outline::CHAPTER && *text == title)
        .expect("the chapter's row");
    assert_eq!(
        listed[at + 1..at + 7].to_vec(),
        vec![
            (MODULE, "正文".to_owned()),
            (4, heading(0)),
            (5, heading(1)),
            (MODULE, "来历".to_owned()),
            (4, heading(2)),
            (5, heading(3)),
        ],
        "under the chapter: each module's name, then its headings"
    );
    if let Some(next) = listed.get(at + 7) {
        assert!(
            next.0 <= outline::CHAPTER,
            "the next chapter (or act) follows: {next:?}"
        );
    }
    // Every chapter of the book lists its two modules.
    let chapters = listed
        .iter()
        .filter(|(level, _)| *level == outline::CHAPTER)
        .count();
    let modules = listed.iter().filter(|(level, _)| *level == MODULE).count();
    assert_eq!(modules, 2 * chapters, "two bodies a chapter: {listed:?}");
}
