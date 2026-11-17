//! The region composer in the shell (sc-scenarios-v5, 2026-11-16): a file
//! opened from the right column's library comes to the front while the
//! keyboard is still in that column, so the shell has not yet given the
//! page the keyboard. When a drawn region then opens the composer, the
//! shell must leave the keyboard in it rather than hand it to the page.
//! Synthetic images come from dr-testkit.

use std::time::{Duration, Instant};

use dr_shell::{
    Services, SettingsFile, ShellInfo, Workspace,
    nav::{Open, Target},
};
use dr_view_material::MediaPage;
use dr_workspace::{Actor, Workspace as Library};
use gpui::{
    Entity, Modifiers, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, PlatformInput,
    Point, TestAppContext, VisualTestContext, point, px,
};
use serde_json::json;

fn library() -> (tempfile::TempDir, Library, String, String) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let lib = dr_store::Library::open(&root, dr_workspace::library_options("test")).unwrap();
    let sample = dr_testkit::samples::slow_clock().unwrap();
    dr_testkit::seed::write_book_v3(&lib, &dr_testkit::seed::book_to_v3(&sample).unwrap()).unwrap();
    lib.close().unwrap();
    let book = sample.book.book_id().to_string();
    let lib = Library::open_dir(&root, "test").unwrap();
    let media = dr_view_material::import::import_bytes(
        &lib,
        &book,
        None,
        dr_testkit::media::png(640, 400),
        "海岸图",
    )
    .unwrap()
    .material;
    (dir, lib, book, media)
}

fn wait(cx: &mut VisualTestContext, done: impl Fn(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        cx.update(|w, cx| w.draw(cx).clear(cx));
        cx.run_until_parked();
        if done(cx) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out");
        std::thread::sleep(Duration::from_millis(2));
    }
}

/// The window point at fractions `(u, v)` of the picture.
fn at(
    page: &Entity<MediaPage>,
    cx: &mut VisualTestContext,
    (u, v): (f32, f32),
) -> Point<gpui::Pixels> {
    page.read_with(cx, |p, _| {
        let f = p.frame().unwrap();
        let (x, y) = p.stage_origin().unwrap();
        point(px(x + f.x + u * f.w), px(y + f.y + v * f.h))
    })
}

#[gpui::test]
fn a_region_composer_keeps_the_keyboard_on_a_page_opened_from_a_side_column(
    cx: &mut TestAppContext,
) {
    let (_dir, lib, book, media) = library();
    cx.executor().allow_parking();
    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "test",
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                library: Some(lib.clone()),
                ..Default::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
        dr_view_material::init(cx);
    });
    let (ws, cx) = cx.add_window_view(Workspace::new);
    cx.update(|w, _| w.activate_window());
    wait(cx, |cx| ws.read_with(cx, |w, _| !w.book.is_empty()));

    // The keyboard is somewhere the shell does not hand on from (the right
    // column's library, where the file was chosen).
    let elsewhere = cx.update(|_, cx| cx.focus_handle());
    cx.update(|w, cx| w.focus(&elsewhere, cx));
    let target = Target::Material(media.parse().unwrap());
    ws.update(cx, |w, cx| w.open(target.clone(), Open::KEEP, cx));
    wait(cx, |cx| {
        ws.read_with(cx, |w, _| w.module_page(&target).is_some())
    });
    let page = ws
        .read_with(cx, |w, _| w.module_page(&target).unwrap().clone())
        .downcast::<MediaPage>()
        .unwrap();
    wait(cx, |cx| {
        page.read_with(cx, |p, _| p.ready() && p.frame().is_some())
    });
    cx.update(|w, _| {
        assert!(
            elsewhere.is_focused(w),
            "the page came to the front without the keyboard"
        )
    });

    // A region drawn on the picture: the composer comes up with the keyboard.
    page.update(cx, |p, cx| p.set_drawing(true, cx));
    for _ in 0..3 {
        cx.update(|w, cx| w.draw(cx).clear(cx));
    }
    let (a, b) = (at(&page, cx, (0.2, 0.2)), at(&page, cx, (0.45, 0.5)));
    // Pressed, moved and let go in one go, with no frame between them (as
    // a quick drag, or the debug bridge's, arrives): the shell has not drawn
    // the page with the keyboard in it before the composer takes it.
    cx.update(|w, cx| {
        w.dispatch_event(
            PlatformInput::MouseDown(MouseDownEvent {
                position: a,
                button: MouseButton::Left,
                modifiers: Modifiers::none(),
                click_count: 1,
                first_mouse: false,
            }),
            cx,
        );
        w.dispatch_event(
            PlatformInput::MouseMove(MouseMoveEvent {
                position: b,
                pressed_button: Some(MouseButton::Left),
                modifiers: Modifiers::none(),
            }),
            cx,
        );
        w.dispatch_event(
            PlatformInput::MouseUp(MouseUpEvent {
                position: b,
                button: MouseButton::Left,
                modifiers: Modifiers::none(),
                click_count: 1,
            }),
            cx,
        );
    });
    let composer = page
        .read_with(cx, |p, _| p.composer().cloned())
        .expect("composer");
    // The shell draws again (in the app it does all the time: the sync
    // mark, a pane's motion): every view, not only the page.
    for _ in 0..3 {
        cx.update(|w, cx| {
            w.refresh();
            w.draw(cx).clear(cx)
        });
        cx.run_until_parked();
    }
    cx.simulate_input("潮位要核对");
    cx.run_until_parked();
    composer.update(cx, |c, cx| c.save(cx));
    wait(cx, |cx| page.read_with(cx, |p, _| p.comments().len() == 1));
    let listed = lib
        .call(&Actor::User, "comment.list", json!({"book": book}))
        .unwrap()["output"]
        .clone();
    let on_file: Vec<_> = listed
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["target"]["id"] == media.as_str())
        .collect();
    assert_eq!(on_file.len(), 1);
    assert_eq!(on_file[0]["body"]["text"], "潮位要核对");
    drop(elsewhere);
}
