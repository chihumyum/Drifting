//! The image and PDF material page on GPUI's test platform, on a real
//! workspace with synthetic pictures (dr-testkit's media): fitting, zoom at
//! the pointer (⌘ + wheel, a pinch, the toolbar), pan by dragging, a double
//! click back to fitted; a PDF's pages turned and rendered again at the size
//! they are shown; a rectangle drawn and written as a region comment; the
//! column's order and choosing a comment on another page.

use std::rc::Rc;
use std::time::{Duration, Instant};

use dr_shell::book::Book;
use dr_shell::pages::PageViewHost;
use dr_shell::{Services, SettingsFile, ShellInfo};
use dr_store::Library;
use dr_store::asset::{SourceImport, Variant};
use dr_ui::Appearance;
use dr_view_material::{MediaKind, MediaPage};
use dr_view_review::Anchor;
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use gpui::{
    Entity, Modifiers, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, PinchEvent,
    Point, ScrollDelta, ScrollEvent, ScrollSource, TestAppContext, TouchPhase, VisualTestContext,
    WeakEntity, point, px, size,
};
use serde_json::{Value, json};

struct Env {
    _dir: tempfile::TempDir,
    ws: Workspace,
    book: String,
}

fn out(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input)
        .unwrap_or_else(|e| panic!("{name}: {e}"))["output"]
        .clone()
}

fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(dir.path(), library_options("test")).unwrap();
    let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
    let book = out(&ws, "book.create", json!({"name": "素材"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    Env {
        _dir: dir,
        ws,
        book,
    }
}

/// A material of `kind` whose source is `bytes`.
fn material(e: &Env, kind: &str, title: &str, bytes: Vec<u8>, size: (u32, u32)) -> String {
    let (mime, ext) = match kind {
        "image" => ("image/png", "png"),
        _ => ("application/pdf", "pdf"),
    };
    let asset = dr_model::id::new_uuid_v7();
    let lib = e.ws.library();
    let file = e._dir.path().join(format!("{asset}.{ext}"));
    std::fs::write(&file, &bytes).unwrap();
    lib.import_asset(&SourceImport {
        book_id: &e.book,
        asset_id: &asset,
        source: &file,
        mime,
        ext,
        dimensions: (kind == "image").then_some(size),
        limit: 64 << 20,
    })
    .unwrap();
    let sha = lib.asset(&asset, Variant::Source).unwrap().unwrap().sha256;
    let mut put = json!({"book": e.book, "id": asset, "kind": kind, "mime": mime,
                         "size": bytes.len(), "sha256": sha});
    if kind == "image" {
        put["width"] = json!(size.0);
        put["height"] = json!(size.1);
    }
    out(&e.ws, "asset.put", put);
    out(
        &e.ws,
        "material.create",
        json!({"book": e.book, "kind": kind, "title": title, "asset": asset}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn region_comment(e: &Env, on: &str, page: Option<u32>, y: f64, body: &str) -> String {
    let mut region = json!({"x": 0.1, "y": y, "w": 0.3, "h": 0.1});
    if let Some(page) = page {
        region["page"] = json!(page);
    }
    out(
        &e.ws,
        "comment.create",
        json!({"book": e.book, "target": {"kind": "material", "id": on},
               "region": region, "body": body}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned()
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

fn draw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| {
        window.simulate_next_frame(cx);
        window.draw(cx).clear(cx);
    });
    cx.run_until_parked();
}

/// Draws (and lets time pass) until `done`.
fn wait_for(cx: &mut VisualTestContext, mut done: impl FnMut(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        cx.executor().advance_clock(Duration::from_millis(40));
        draw(cx);
        if done(cx) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out");
        std::thread::sleep(Duration::from_millis(2));
    }
}

/// The page of material `id` in a 1000 × 760 window, its picture shown.
fn open(cx: &mut TestAppContext, e: &Env, id: &str) -> (Entity<MediaPage>, VisualTestContext) {
    cx.executor().allow_parking();
    cx.update(|cx| {
        if cx.try_global::<dr_shell::strings::Strings>().is_none() {
            let mut file = SettingsFile::in_memory();
            file.set(
                dr_shell::settings::registry::UI_LOCALE,
                "zh-CN".into(),
                None,
            )
            .ok();
            dr_shell::init(info(), Services::default(), file, cx);
        }
    });
    let book = Rc::new(Book::load(&e.ws, &e.book).unwrap());
    let kind = book
        .materials
        .iter()
        .find(|m| m.id == id)
        .and_then(|m| MediaKind::parse(&m.kind))
        .unwrap();
    let host = PageViewHost {
        workspace: WeakEntity::new_invalid(),
        library: e.ws.clone(),
        book_id: e.book.clone(),
        book,
    };
    let id = id.to_owned();
    let window = cx.add_window(move |window, cx| MediaPage::new(id, kind, host, window, cx));
    let page = window.root(cx).unwrap();
    let mut vcx = VisualTestContext::from_window(window.into(), cx);
    vcx.update(|window, _| window.activate_window());
    vcx.simulate_resize(size(px(1000.), px(760.)));
    wait_for(&mut vcx, |cx| page.read_with(cx, |p, _| p.ready()));
    (page, vcx)
}

/// The window point at fractions `(u, v)` of the picture.
fn at(
    page: &Entity<MediaPage>,
    cx: &mut VisualTestContext,
    (u, v): (f32, f32),
) -> Point<gpui::Pixels> {
    let stage = cx.update(|_, cx| {
        let p = page.read(cx);
        let f = p.frame().unwrap();
        (f.x + u * f.w, f.y + v * f.h)
    });
    // The stage's origin: the frame is in stage coordinates; the stage
    // starts under the head, at the window's left edge.
    let origin = page.read_with(cx, |p, _| p.stage_origin().unwrap());
    point(px(origin.0 + stage.0), px(origin.1 + stage.1))
}

#[gpui::test]
fn an_image_fits_zooms_at_the_pointer_and_pans(cx: &mut TestAppContext) {
    let e = env();
    let id = material(
        &e,
        "image",
        "海岸图",
        dr_testkit::media::png(640, 400),
        (640, 400),
    );
    let (page, mut cx) = open(cx, &e, &id);
    let cx = &mut cx;
    // Fitted: never larger than its pixels, centred.
    let f = page.read_with(cx, |p, _| p.frame().unwrap());
    assert_eq!((f.w, f.h), (640.0, 400.0));
    assert_eq!(page.read_with(cx, |p, _| p.page_count()), 1);
    assert_eq!(
        page.read_with(cx, |p, _| p.page()),
        None,
        "an image has no pages"
    );

    // ⌘ + wheel zooms in about the pointer: the point under it stays.
    let pointer = at(&page, cx, (0.25, 0.25));
    cx.simulate_event(ScrollEvent {
        position: pointer,
        delta: ScrollDelta::Pixels(point(px(0.0), px(200.0))),
        modifiers: Modifiers::command(),
        touch_phase: TouchPhase::Moved,
        source: ScrollSource::default(),
    });
    draw(cx);
    let v = page.read_with(cx, |p, _| p.viewport());
    assert!((v.scale - (200.0f32 * 0.002).exp()).abs() < 1e-3, "{v:?}");
    assert_eq!(at(&page, cx, (0.25, 0.25)), pointer);

    // A pinch zooms too.
    cx.simulate_event(PinchEvent {
        position: pointer,
        delta: 0.5,
        modifiers: Modifiers::none(),
        phase: TouchPhase::Moved,
    });
    draw(cx);
    let pinched = page.read_with(cx, |p, _| p.viewport());
    assert!((pinched.scale - v.scale * 1.5).abs() < 1e-3);

    // Dragging the zoomed picture moves it by the drag.
    let from = at(&page, cx, (0.5, 0.5));
    let before = page.read_with(cx, |p, _| p.viewport());
    cx.simulate_event(MouseDownEvent {
        position: from,
        button: MouseButton::Left,
        modifiers: Modifiers::none(),
        click_count: 1,
        first_mouse: false,
    });
    draw(cx);
    let to = point(from.x + px(-60.0), from.y + px(25.0));
    cx.simulate_event(MouseMoveEvent {
        position: to,
        pressed_button: Some(MouseButton::Left),
        modifiers: Modifiers::none(),
    });
    cx.simulate_event(MouseUpEvent {
        position: to,
        button: MouseButton::Left,
        modifiers: Modifiers::none(),
        click_count: 1,
    });
    draw(cx);
    let after = page.read_with(cx, |p, _| p.viewport());
    assert_eq!(
        (after.pan_x - before.pan_x, after.pan_y - before.pan_y),
        (-60.0, 25.0)
    );

    // The toolbar's − and +, and a double click back to fitted.
    page.update(cx, |p, cx| {
        p.zoom_by(dr_view_material::viewport::STEP, None, cx)
    });
    assert!(page.read_with(cx, |p, _| p.viewport().scale) > after.scale);
    let middle = at(&page, cx, (0.5, 0.5));
    cx.simulate_event(MouseDownEvent {
        position: middle,
        button: MouseButton::Left,
        modifiers: Modifiers::none(),
        click_count: 2,
        first_mouse: false,
    });
    cx.simulate_event(MouseUpEvent {
        position: middle,
        button: MouseButton::Left,
        modifiers: Modifiers::none(),
        click_count: 2,
    });
    draw(cx);
    assert_eq!(
        page.read_with(cx, |p, _| p.viewport()),
        dr_view_material::viewport::Viewport::FIT
    );
    // Plain wheel does nothing at the fitted size.
    cx.simulate_event(ScrollEvent {
        position: middle,
        delta: ScrollDelta::Pixels(point(px(30.0), px(30.0))),
        modifiers: Modifiers::none(),
        touch_phase: TouchPhase::Moved,
        source: ScrollSource::default(),
    });
    draw(cx);
    assert_eq!(
        page.read_with(cx, |p, _| p.viewport()),
        dr_view_material::viewport::Viewport::FIT
    );
}

#[gpui::test]
fn a_pdf_turns_pages_and_renders_at_the_size_shown(cx: &mut TestAppContext) {
    let e = env();
    let id = material(
        &e,
        "pdf",
        "潮汐笔记",
        dr_testkit::media::sample_pdf(),
        (0, 0),
    );
    let (page, mut cx) = open(cx, &e, &id);
    let cx = &mut cx;
    assert_eq!(
        page.read_with(cx, |p, _| (p.page_count(), p.page())),
        (3, Some(1))
    );
    // The page fills the stage's height less the pager's room, and the
    // rendering has the pixels it is shown at.
    let (f, rendered) = page.read_with(cx, |p, _| (p.frame().unwrap(), p.rendered_size().unwrap()));
    let scale = cx.update(|window, _| window.scale_factor());
    assert!(
        (rendered.0 as f32 - f.w * scale).abs() <= 2.0,
        "{rendered:?} {f:?}"
    );
    // → turns the page.
    cx.update(|window, cx| {
        let focus = gpui::Focusable::focus_handle(page.read(cx), cx);
        window.focus(&focus, cx);
    });
    cx.simulate_keystrokes("right");
    wait_for(cx, |cx| {
        page.read_with(cx, |p, _| p.page() == Some(2) && p.ready())
    });
    page.update(cx, |p, cx| p.turn_to(9, cx));
    assert_eq!(
        page.read_with(cx, |p, _| p.page()),
        Some(3),
        "held to the last page"
    );
    cx.simulate_keystrokes("left");
    draw(cx);
    assert_eq!(page.read_with(cx, |p, _| p.page()), Some(2));
    // Zoomed in, the page is rendered again, larger, once the zoom rests.
    let before = page.read_with(cx, |p, _| p.rendered_size().unwrap());
    page.update(cx, |p, cx| p.zoom_by(2.0, None, cx));
    wait_for(cx, |cx| {
        page.read_with(cx, |p, _| {
            p.rendered_size().is_some_and(|s| s.0 > before.0 * 3 / 2)
        })
    });
}

#[gpui::test]
fn a_rectangle_drawn_on_a_page_becomes_a_region_comment(cx: &mut TestAppContext) {
    let e = env();
    let id = material(
        &e,
        "pdf",
        "潮汐笔记",
        dr_testkit::media::sample_pdf(),
        (0, 0),
    );
    let (page, mut cx) = open(cx, &e, &id);
    let cx = &mut cx;
    page.update(cx, |p, cx| p.turn_to(2, cx));
    wait_for(cx, |cx| page.read_with(cx, |p, _| p.ready()));
    // Not drawing: a drag on the fitted picture marks nothing.
    let drag = |cx: &mut VisualTestContext, a: Point<gpui::Pixels>, b: Point<gpui::Pixels>| {
        cx.simulate_event(MouseDownEvent {
            position: a,
            button: MouseButton::Left,
            modifiers: Modifiers::none(),
            click_count: 1,
            first_mouse: false,
        });
        draw(cx);
        cx.simulate_event(MouseMoveEvent {
            position: b,
            pressed_button: Some(MouseButton::Left),
            modifiers: Modifiers::none(),
        });
        draw(cx);
        cx.simulate_event(MouseUpEvent {
            position: b,
            button: MouseButton::Left,
            modifiers: Modifiers::none(),
            click_count: 1,
        });
        draw(cx);
    };
    let (a, b) = (at(&page, cx, (0.1, 0.2)), at(&page, cx, (0.4, 0.5)));
    drag(cx, a, b);
    assert!(page.read_with(cx, |p, _| p.composer().is_none()));
    // Drawing: a drag too small is no region.
    page.update(cx, |p, cx| p.set_drawing(true, cx));
    draw(cx);
    // The column comes up beside the stage while drawing: the picture moved.
    draw(cx);
    let (a, b) = (at(&page, cx, (0.1, 0.2)), at(&page, cx, (0.4, 0.5)));
    let tiny = at(&page, cx, (0.102, 0.204));
    drag(cx, a, tiny);
    assert!(page.read_with(cx, |p, _| p.composer().is_none()));
    // A real one: the composer comes up for that rectangle on page 2.
    drag(cx, a, b);
    let composer = page
        .read_with(cx, |p, _| p.composer().cloned())
        .expect("composer");
    let anchor = composer.read_with(cx, |c, _| c.anchor());
    let Anchor::Region(region) = anchor else {
        panic!("{anchor:?}")
    };
    assert_eq!(region.page, Some(2));
    assert!(
        (region.x - 0.1).abs() < 0.01 && (region.y - 0.2).abs() < 0.01,
        "{region:?}"
    );
    assert!(
        (region.w - 0.3).abs() < 0.01 && (region.h - 0.3).abs() < 0.01,
        "{region:?}"
    );
    composer.update(cx, |c, cx| {
        c.set_text("这一段潮位要核对", cx);
        c.save(cx);
    });
    wait_for(cx, |cx| page.read_with(cx, |p, _| p.comments().len() == 1));
    let listed = out(&e.ws, "comment.list", json!({"book": e.book}));
    let stored = &listed.as_array().unwrap()[0];
    assert_eq!(stored["body"], "这一段潮位要核对");
    assert_eq!(stored["region"]["page"], 2);
    assert!(page.read_with(cx, |p, _| p.composer().is_none() && !p.drawing()));
    let new = stored["id"].as_str().unwrap().to_owned();
    assert_eq!(
        page.read_with(cx, |p, _| p.selected().map(str::to_owned)),
        Some(new)
    );
}

#[gpui::test]
fn the_column_reads_in_page_order_and_a_choice_turns_to_its_page(cx: &mut TestAppContext) {
    let e = env();
    let id = material(
        &e,
        "pdf",
        "潮汐笔记",
        dr_testkit::media::sample_pdf(),
        (0, 0),
    );
    let late = region_comment(&e, &id, Some(3), 0.1, "三页的礁石");
    let early = region_comment(&e, &id, Some(1), 0.6, "一页的海岸");
    out(
        &e.ws,
        "comment.create",
        json!({"book": e.book, "target": {"kind": "material", "id": id}, "body": "整份"}),
    );
    let (page, mut cx) = open(cx, &e, &id);
    let cx = &mut cx;
    wait_for(cx, |cx| page.read_with(cx, |p, _| p.comments().len() == 3));
    let bodies: Vec<String> = page.read_with(cx, |p, _| {
        p.comments().iter().map(|l| l.item.body.clone()).collect()
    });
    assert_eq!(bodies, ["一页的海岸", "三页的礁石", "整份"]);
    // Choosing the one on page 3 turns to it.
    page.update(cx, |p, cx| p.select(&late, cx));
    assert_eq!(page.read_with(cx, |p, _| p.page()), Some(3));
    wait_for(cx, |cx| page.read_with(cx, |p, _| p.ready()));
    // Its rectangle is under the pointer there: pointing lights it, a click
    // on it chooses it.
    page.update(cx, |p, cx| p.select(&early, cx));
    wait_for(cx, |cx| {
        page.read_with(cx, |p, _| p.ready() && p.page() == Some(1))
    });
    let on = at(&page, cx, (0.2, 0.65));
    cx.simulate_mouse_move(on, None, Modifiers::none());
    draw(cx);
    assert_eq!(
        page.read_with(cx, |p, _| p.pointed().map(str::to_owned)),
        Some(early.clone())
    );
    page.update(cx, |p, cx| p.select(&late, cx));
    page.update(cx, |p, cx| p.turn_to(1, cx));
    wait_for(cx, |cx| page.read_with(cx, |p, _| p.ready()));
    let on = at(&page, cx, (0.2, 0.65));
    cx.simulate_click(on, Modifiers::none());
    draw(cx);
    assert_eq!(
        page.read_with(cx, |p, _| p.selected().map(str::to_owned)),
        Some(early)
    );
}

#[gpui::test]
fn a_material_without_its_file_says_so(cx: &mut TestAppContext) {
    let e = env();
    let id = material(&e, "image", "缺图", dr_testkit::media::png(8, 8), (8, 8));
    // The bytes go; the material stays.
    let asset = out(&e.ws, "material.list", json!({"book": e.book}))[0]["asset"]
        .as_str()
        .unwrap()
        .to_owned();
    e.ws.library().remove_asset(&asset).unwrap();
    cx.executor().allow_parking();
    cx.update(|cx| {
        if cx.try_global::<dr_shell::strings::Strings>().is_none() {
            dr_shell::init(info(), Services::default(), SettingsFile::in_memory(), cx);
        }
    });
    let book = Rc::new(Book::load(&e.ws, &e.book).unwrap());
    let host = PageViewHost {
        workspace: WeakEntity::new_invalid(),
        library: e.ws.clone(),
        book_id: e.book.clone(),
        book,
    };
    let window =
        cx.add_window(move |window, cx| MediaPage::new(id, MediaKind::Image, host, window, cx));
    let page = window.root(cx).unwrap();
    let mut vcx = VisualTestContext::from_window(window.into(), cx);
    wait_for(&mut vcx, |cx| {
        page.read_with(cx, |p, _| p.trouble().is_some())
    });
    assert!(!page.read_with(&vcx, |p, _| p.ready()));
}
