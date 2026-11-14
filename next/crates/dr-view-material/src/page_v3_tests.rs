use super::*;
use dr_shell::{Services, SettingsFile, ShellInfo};
use dr_ui::Appearance;
use dr_workspace::{Faults, WorkspaceOptions};
use gpui::{TestAppContext, VisualTestContext};
use serde_json::{Value, json};
use std::time::Instant;

fn call(ws: &Library, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input).unwrap()["output"].clone()
}

fn wait(cx: &mut VisualTestContext, done: impl Fn(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        cx.executor().advance_clock(Duration::from_millis(40));
        cx.run_until_parked();
        cx.update(|window, cx| window.draw(cx).clear(cx));
        if done(cx) {
            return;
        }
        assert!(Instant::now() < deadline, "v3 material page timed out");
        std::thread::sleep(Duration::from_millis(3));
    }
}

#[gpui::test]
fn partial_metadata_and_region_comments_preserve_hidden_data_and_failed_drafts(
    cx: &mut TestAppContext,
) {
    cx.executor().allow_parking();
    let dir = tempfile::tempdir().unwrap();
    let store = dr_store::Library::open(dir.path(), dr_workspace::library_options("test")).unwrap();
    let seed = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let book_id = seed.books[0].book_id().to_string();
    seed.write_to(&store).unwrap();
    let faults = Arc::new(Faults::default());
    let ws = Library::open(
        store,
        WorkspaceOptions {
            faults: Some(faults.clone()),
            ..Default::default()
        },
    )
    .unwrap();
    crate::import::import_bytes(&ws, &book_id, None, dr_testkit::media::png(24, 24), "原图")
        .unwrap();
    let initial_book = Book::load(&ws, &book_id).unwrap();
    let sample_title = initial_book.material_items()[0].title.clone();
    let hidden = initial_book.material_items().to_vec();
    let imported = crate::import::import_bytes(
        &ws,
        &book_id,
        None,
        dr_testkit::media::png(16, 16),
        &sample_title,
    )
    .unwrap();
    let id = imported.material;
    let host_info = Book::load(&ws, &book_id)
        .unwrap()
        .material_items()
        .iter()
        .find(|m| m.id == id)
        .unwrap()
        .clone();
    let host_entry = host_info.entry.clone().unwrap();
    let host_module = host_info.module.clone().unwrap();
    let host_asset = host_info.asset.clone().unwrap();
    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "0.2.0-dev",
                url_scheme: "drifting-next-dev",
                forced_appearance: Some(Appearance::Light),
            },
            Services::default(),
            SettingsFile::in_memory(),
            cx,
        )
    });
    let host = PageViewHost {
        workspace: WeakEntity::new_invalid(),
        library: ws.clone(),
        book_id: book_id.clone(),
        book: Rc::new(Book::load(&ws, &book_id).unwrap()),
    };
    let page_id = id.clone();
    let window = cx
        .add_window(move |window, cx| MediaPage::new(page_id, MediaKind::Image, host, window, cx));
    let page = window.root(cx).unwrap();
    let cx = &mut VisualTestContext::from_window(window.into(), cx);
    wait(cx, |cx| page.read_with(cx, |p, _| p.ready()));
    // The title draft is independent of another writer's description.
    let draft = format!("{sample_title} {sample_title}");
    page.update(cx, |p, cx| {
        p.title.update(cx, |f, cx| f.set_text(&draft, cx));
        p.dirty_title = true;
    });
    call(
        &ws,
        "module.put_media",
        json!({"book":book_id,"entry":host_entry,"module":host_module,
        "item":{"id":id,"asset":host_asset,"caption":sample_title}}),
    );
    cx.update(|window, cx| {
        page.update(cx, |p, cx| {
            p.book = Rc::new(Book::load(&ws, &book_id).unwrap());
            p.sync_fields(window, cx);
            assert_eq!(p.title.read(cx).text(), draft);
            p.save_title(draft.clone(), cx);
        })
    });
    wait(cx, |cx| page.read_with(cx, |p, _| !p.saving_title));
    assert!(page.read_with(cx, |p, _| p.title_error.is_none()));
    let rows = Book::load(&ws, &book_id).unwrap().material_items().to_vec();
    let row = rows.iter().find(|m| m.id == id).unwrap();
    assert_eq!(row.title, draft);
    assert_eq!(row.description, sample_title);
    for original in &hidden {
        assert!(rows.contains(original), "unshown material changed");
    }
    // A rejected field write survives a blur and a fresh book snapshot.
    let failed = format!("{draft}\n{draft}");
    faults.arm("after_prose");
    page.update(cx, |p, cx| {
        p.description.update(cx, |f, cx| f.set_text(&failed, cx));
        p.dirty_description = true;
        p.save_description(failed.clone(), cx);
    });
    wait(cx, |cx| {
        page.read_with(cx, |p, _| p.description_error.is_some())
    });
    cx.update(|window, cx| {
        page.update(cx, |p, cx| {
            p.book = Rc::new(Book::load(&ws, &book_id).unwrap());
            p.sync_fields(window, cx);
            assert_eq!(p.description.read(cx).text(), failed);
            p.save_description(failed.clone(), cx);
        })
    });
    wait(cx, |cx| page.read_with(cx, |p, _| !p.saving_description));
    assert!(page.read_with(cx, |p, _| p.description_error.is_none()));
    // Mouse down/move/up can arrive before the next render (the bridge,
    // or a quick drag). The region still opens the real v3 composer.
    page.update(cx, |p, cx| p.set_drawing(true, cx));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.update(|window, cx| {
        use gpui::{
            Modifiers, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, PlatformInput,
        };
        let p = page.read(cx);
        let stage = p.stage.unwrap();
        let frame = p.frame().unwrap();
        let a = stage.origin + point(px(frame.x + frame.w * 0.1), px(frame.y + frame.h * 0.2));
        let b = stage.origin + point(px(frame.x + frame.w * 0.4), px(frame.y + frame.h * 0.4));
        window.dispatch_event(
            PlatformInput::MouseDown(MouseDownEvent {
                position: a,
                button: MouseButton::Left,
                modifiers: Modifiers::none(),
                click_count: 1,
                first_mouse: false,
            }),
            cx,
        );
        window.dispatch_event(
            PlatformInput::MouseMove(MouseMoveEvent {
                position: b,
                pressed_button: Some(MouseButton::Left),
                modifiers: Modifiers::none(),
            }),
            cx,
        );
        window.dispatch_event(
            PlatformInput::MouseUp(MouseUpEvent {
                position: b,
                button: MouseButton::Left,
                modifiers: Modifiers::none(),
                click_count: 1,
            }),
            cx,
        );
    });
    let composer = page.read_with(cx, |p, _| p.composer().unwrap().clone());
    composer.update(cx, |c, cx| {
        c.set_text(&sample_title, cx);
        c.save(cx);
    });
    wait(cx, |cx| {
        page.read_with(cx, |p, _| p.composer().is_none() && p.comments().len() == 1)
    });
    let comments = call(
        &ws,
        "comment.list",
        json!({"book":book_id,"target":{"kind":"entry","id":host_entry},"module":host_module}),
    );
    assert_eq!(comments[0]["target"]["id"], host_entry);
    assert_eq!(comments[0]["part"]["item"], id);
    assert!((comments[0]["part"]["region"]["y"].as_f64().unwrap() - 0.2).abs() < 0.0001);
    assert_eq!(comments[0]["body"], sample_title);
    let rows = Book::load(&ws, &book_id).unwrap().material_items().to_vec();
    let row = rows.iter().find(|m| m.id == id).unwrap();
    assert_eq!(row.title, draft);
    assert_eq!(row.description, failed);
    ws.close();
}
