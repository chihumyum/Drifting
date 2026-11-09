use super::*;
use dr_shell::{Services, SettingsFile, ShellInfo};
use dr_store::asset::{SourceImport, Variant};
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
    let sample_title = seed.books[0].book.view().materials()[0].title.clone();
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
    let hidden = call(&ws, "material.list", json!({"book":book_id}));
    let asset = dr_model::id::new_uuid_v7();
    let bytes = dr_testkit::media::png(16, 16);
    let path = dir.path().join("synthetic.png");
    std::fs::write(&path, &bytes).unwrap();
    ws.library()
        .import_asset(&SourceImport {
            book_id: &book_id,
            asset_id: &asset,
            source: &path,
            mime: "image/png",
            ext: "png",
            dimensions: Some((16, 16)),
            limit: 64 << 20,
        })
        .unwrap();
    let sha = ws
        .library()
        .asset(&asset, Variant::Source)
        .unwrap()
        .unwrap()
        .sha256;
    call(
        &ws,
        "asset.put",
        json!({"book":book_id,"id":asset,"kind":"image",
        "mime":"image/png","size":bytes.len(),"sha256":sha,"width":16,"height":16}),
    );
    let id = call(
        &ws,
        "material.create",
        json!({"book":book_id,"kind":"image",
        "title":sample_title,"asset":asset}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
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
        "material.update",
        json!({"book":book_id,"id":id,"description":sample_title}),
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
    let rows = call(&ws, "material.list", json!({"book":book_id}));
    let row = rows
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == id)
        .unwrap();
    assert_eq!(row["title"], draft);
    assert_eq!(row["description"], sample_title);
    for original in hidden.as_array().unwrap() {
        assert!(
            rows.as_array().unwrap().contains(original),
            "unshown material changed"
        );
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
        json!({"book":book_id,"target":{"kind":"material","id":id}}),
    );
    assert_eq!(comments[0]["target"]["id"], id);
    assert!((comments[0]["region"]["y"].as_f64().unwrap() - 0.2).abs() < 0.0001);
    assert_eq!(comments[0]["body"], sample_title);
    let row = call(&ws, "material.list", json!({"book":book_id}));
    let row = row
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == id)
        .unwrap();
    assert_eq!(row["title"], draft);
    assert_eq!(row["description"], failed);
    ws.close();
}
