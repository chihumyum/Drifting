//! The shelf's pictures over a real workspace (a temporary library) and on
//! GPUI's test platform: a cover is read from F3 as the shelf reads it and
//! lands once drawn off the main thread; the year is read from the writing
//! days; pointing at a day in the heat map opens its card.

use std::{rc::Rc, time::Duration};

use dr_shell::{Services, SettingsFile, ShellInfo};
use dr_store::Library;
use dr_ui::{Appearance, tokens::color::Rgb};
use dr_view_shelf_art::{
    CoverStyle, HeatmapBook, ShelfCover, WritingHeatmap, WritingYear, art, cover_is_dark,
    cover_key, cover_request, heat::HEAT_STEP,
};
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use gpui::{
    Context, IntoElement, Modifiers, ParentElement as _, Render, Styled as _, TestAppContext,
    VisualTestContext, Window, div, point, px,
};
use serde_json::{Value, json};

const DEVICE: &str = "device-0123456789abcdef01234567";

fn out(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input)
        .unwrap_or_else(|e| panic!("{name}: {e}"))["output"]
        .clone()
}

fn id(v: &Value) -> String {
    v["id"].as_str().unwrap().to_owned()
}

/// A book of three chapters on two storylines; the second storyline only
/// in the last chapter.
fn book() -> (tempfile::TempDir, Workspace, String) {
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(dir.path(), library_options("test")).unwrap();
    let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
    let book = id(&out(&ws, "book.create", json!({"name": "封面"})));
    let a = id(&out(
        &ws,
        "storyline.create",
        json!({"book": book, "name": "甲", "color": "#b5654a"}),
    ));
    let b = id(&out(
        &ws,
        "storyline.create",
        json!({"book": book, "name": "乙", "color": "#4f7cac"}),
    ));
    for (title, text, lines) in [
        ("一", "雨落在码头上。", vec![a.clone()]),
        ("二", "", vec![a.clone()]),
        (
            "三",
            "灯塔又亮了一次，雾里有人敲钟。",
            vec![a.clone(), b.clone()],
        ),
    ] {
        let chapter = id(&out(
            &ws,
            "chapter.create",
            json!({"book": book, "title": title, "text": text}),
        ));
        out(
            &ws,
            "chapter.update",
            json!({"book": book, "id": chapter, "add_storylines": lines}),
        );
    }
    ws.library().rebuild_stale_indexes().unwrap();
    (dir, ws, book)
}

#[test]
fn a_cover_is_read_from_the_book() {
    let (_dir, ws, book) = book();
    let request = cover_request(&ws, &book, "封面");
    assert_eq!(request.chapters, 3);
    assert_eq!(request.seed, art::cover_seed(&book));
    assert!(!request.latin);
    let lines: Vec<(&str, Vec<usize>)> = request
        .storylines
        .iter()
        .map(|l| (l.color.as_str(), l.chapters.clone()))
        .collect();
    assert_eq!(lines, [("#b5654a", vec![0, 1, 2]), ("#4f7cac", vec![2])]);
    assert_eq!(request.words.len(), 3);
    assert_eq!(request.words[1], 0);
    assert!(request.words[2] > request.words[0], "{:?}", request.words);
    // Every style draws it, the same each time.
    for style in CoverStyle::ALL {
        let a = art::flatten(&art::draw(style, &request), art::paint::PAPER, [85, 82, 78]);
        let b = art::flatten(&art::draw(style, &request), art::paint::PAPER, [85, 82, 78]);
        assert!(a == b, "{} is not the same twice", style.slug());
        assert!(
            a.as_chunks::<4>()
                .0
                .iter()
                .any(|p| p[..3] != art::paint::PAPER),
            "{} drew nothing",
            style.slug()
        );
    }
}

#[test]
fn the_year_is_read_from_the_writing_days() {
    let (_dir, ws, book) = book();
    for (day, words) in [("2026-11-08", 500), ("2026-11-07", 300), ("2025-01-01", 99)] {
        out(
            &ws,
            "writing_day.record",
            json!({"book": book, "device": DEVICE, "day": day, "words": words}),
        );
    }
    let year = WritingYear::load(&ws, std::slice::from_ref(&book), "2026-11-08");
    assert_eq!(year.days.len(), 371);
    assert_eq!(year.total.iter().sum::<u64>(), 800);
    assert_eq!(year.recent(&book, 3), [0, 300, 500]);
}

fn info() -> ShellInfo {
    ShellInfo {
        app_name: "Drifting Next",
        bundle_id: "cc.drifting.next.dev",
        version: "0.2.0-dev",
        url_scheme: "drifting-next-dev",
        forced_appearance: Some(Appearance::Light),
    }
}

fn shell(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    cx.update(|cx| {
        let mut file = SettingsFile::in_memory();
        file.set(
            dr_shell::settings::registry::UI_LOCALE,
            "zh-CN".into(),
            None,
        )
        .ok();
        dr_shell::init(info(), Services::default(), file, cx);
    });
}

fn draw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear(cx);
    });
    cx.run_until_parked();
}

struct Board {
    book: String,
    request: Rc<art::CoverRequest>,
    style: CoverStyle,
    year: Rc<WritingYear>,
}

impl Render for Board {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let books = Rc::new(vec![HeatmapBook {
            id: self.book.clone().into(),
            name: "封面".into(),
            color: Rgb::hex(0xb5654a),
        }]);
        div()
            .size_full()
            .flex()
            .flex_col()
            .child(div().w(px(1100.0)).child(WritingHeatmap::new(
                "heat",
                self.year.clone(),
                books,
                None,
            )))
            .child(ShelfCover::new(
                "cover",
                self.book.clone(),
                self.style,
                self.request.clone(),
            ))
    }
}

#[gpui::test]
fn a_cover_lands_and_a_day_opens_its_card(cx: &mut TestAppContext) {
    let (_dir, ws, book) = book();
    out(
        &ws,
        "writing_day.record",
        json!({"book": book, "device": DEVICE, "day": "2026-11-08", "words": 420}),
    );
    shell(cx);
    let request = Rc::new(cover_request(&ws, &book, "封面"));
    let year = Rc::new(WritingYear::load(
        &ws,
        std::slice::from_ref(&book),
        "2026-11-08",
    ));
    let (view, cx) = cx.add_window_view(|_, _| Board {
        book: book.clone(),
        request: request.clone(),
        style: CoverStyle::Topo,
        year,
    });
    cx.update(|window, _| window.activate_window());
    // Drawn off the main thread, then shown.
    for style in [CoverStyle::Topo, CoverStyle::Sand] {
        view.update(cx, |b, cx| {
            b.style = style;
            cx.notify();
        });
        let key = cover_key(&book, style, &request);
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        while cx.update(|_, cx| cover_is_dark(&key, cx)).is_none()
            && std::time::Instant::now() < deadline
        {
            draw(cx);
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(cx.update(|_, cx| cover_is_dark(&key, cx)), Some(false));
    }
    // Today is the last day: its cell is the last column's seventh row
    // (2026-11-08 is a Sunday).
    draw(cx);
    let cells = cx.debug_bounds("heat-cells").expect("the map is drawn");
    assert!(cx.debug_bounds("heat-day-card").is_none());
    let at = cells.origin + point(px(52.0 * HEAT_STEP + 5.0), px(6.0 * HEAT_STEP + 5.0));
    cx.simulate_mouse_move(at, None, Modifiers::none());
    draw(cx);
    assert!(cx.debug_bounds("heat-day-card").is_some());
}
