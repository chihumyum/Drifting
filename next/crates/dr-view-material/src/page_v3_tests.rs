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

fn place_in_media_entry(
    lib: &Library,
    book: &str,
    asset: &str,
    title: &str,
) -> Result<(String, String, String), String> {
    let call = |name: &str, input: Value| {
        lib.call(&Actor::User, name, input)
            .map(|v| v["output"].clone())
            .map_err(|e| format!("{name}: {e}"))
    };
    call(
        "entry_template.put",
        json!({"book": book, "template": {"id": "test-media-template", "name": "媒体",
            "modules": [{"id": "mod-media", "kind": "media", "name": "附件"}]}}),
    )?;
    let entry = call(
        "entry.create",
        json!({"book": book, "template": "test-media-template", "title": title}),
    )?["id"]
        .as_str()
        .ok_or("entry.create gave no id")?
        .to_owned();
    let item = dr_model::id::new_uuid_v7();
    call(
        "module.put_media",
        json!({"book": book, "entry": entry, "module": "mod-media",
            "item": {"id": item, "asset": asset, "caption": ""}}),
    )?;
    Ok((entry, "mod-media".to_owned(), item))
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
    // The import puts the file into the asset library only; the page under
    // test shows it as an item of an entry's media module.
    let host_asset = imported.material.clone();
    let (host_entry, host_module, id) =
        place_in_media_entry(&ws, &book_id, &host_asset, &sample_title).unwrap();
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
    let loaded = Book::load(&ws, &book_id).unwrap();
    let rows = loaded.material_items().to_vec();
    let row = loaded.material_info(&id).unwrap();
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
    // A media module region names the file (it is in the module once).
    assert_eq!(comments[0]["part"]["asset"], host_asset);
    assert!((comments[0]["part"]["region"]["y"].as_f64().unwrap() - 0.2).abs() < 0.0001);
    assert_eq!(comments[0]["body"]["text"], sample_title);
    let loaded = Book::load(&ws, &book_id).unwrap();
    let row = loaded.material_info(&id).unwrap();
    assert_eq!(row.title, draft);
    assert_eq!(row.description, failed);
    ws.close();
}

/// A workspace on the tiny seed, the shell initialised, and its book id.
fn tiny(cx: &mut TestAppContext) -> (tempfile::TempDir, Library, String) {
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
    let ws = Library::open(store, WorkspaceOptions::default()).unwrap();
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
    (dir, ws, book_id)
}

/// The material page `id` (a media item, or a file only in the library).
fn open_page(
    cx: &mut TestAppContext,
    ws: &Library,
    book_id: &str,
    id: &str,
) -> (Entity<MediaPage>, VisualTestContext) {
    let host = PageViewHost {
        workspace: WeakEntity::new_invalid(),
        library: ws.clone(),
        book_id: book_id.to_owned(),
        book: Rc::new(Book::load(ws, book_id).unwrap()),
    };
    let page_id = id.to_owned();
    let window = cx
        .add_window(move |window, cx| MediaPage::new(page_id, MediaKind::Image, host, window, cx));
    let page = window.root(cx).unwrap();
    let mut cx = VisualTestContext::from_window(window.into(), cx);
    wait(&mut cx, |cx| page.read_with(cx, |p, _| p.ready()));
    (page, cx)
}

/// Draws a rectangle on the page's picture and saves a comment `body` on it.
fn draw_and_save(page: &Entity<MediaPage>, cx: &mut VisualTestContext, body: &str) {
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
        c.set_text(body, cx);
        c.save(cx);
    });
    wait(cx, |cx| page.read_with(cx, |p, _| p.composer().is_none()));
}

/// A file only in the asset library (dropped in, in no entry): a rectangle
/// drawn on its page is a comment straight on the file (a region, no
/// entry, no module), and it is there when the page is opened again; its
/// name is saved as the file's name (review items 2 and 3 of the DY
/// hand-back).
#[gpui::test]
fn a_file_only_in_the_library_takes_a_region_comment_and_a_new_name(cx: &mut TestAppContext) {
    let (_dir, ws, book_id) = tiny(cx);
    let file =
        crate::import::import_bytes(&ws, &book_id, None, dr_testkit::media::png(20, 14), "海图")
            .unwrap()
            .material;
    let (page, mut vcx) = open_page(cx, &ws, &book_id, &file);
    let vcx = &mut vcx;
    draw_and_save(&page, vcx, "礁石在这里");
    wait(vcx, |cx| page.read_with(cx, |p, _| p.comments().len() == 1));
    let on_file = call(
        &ws,
        "comment.list",
        json!({"book": book_id, "target": {"kind": "asset", "id": file}}),
    );
    assert_eq!(on_file.as_array().unwrap().len(), 1, "{on_file}");
    assert_eq!(on_file[0]["module"], Value::Null);
    assert_eq!(on_file[0]["part"]["kind"], "region");
    assert!((on_file[0]["part"]["region"]["y"].as_f64().unwrap() - 0.2).abs() < 0.0001);
    assert_eq!(
        on_file[0]["part"]["region"]["page"],
        Value::Null,
        "an image"
    );
    // The new name is the file's, and stays when the book changes.
    let renamed = "东岸海图";
    page.update(vcx, |p, cx| {
        p.title.update(cx, |f, cx| f.set_text(renamed, cx));
        p.dirty_title = true;
        p.save_title(renamed.to_owned(), cx);
    });
    wait(vcx, |cx| page.read_with(cx, |p, _| !p.saving_title));
    assert!(page.read_with(vcx, |p, _| p.title_error.is_none()));
    assert_eq!(
        call(
            &ws,
            "asset.get",
            json!({"book": book_id, "id": file, "usages": false})
        )["name"],
        renamed
    );
    vcx.update(|window, cx| {
        page.update(cx, |p, cx| {
            p.book = Rc::new(Book::load(&ws, &book_id).unwrap());
            p.sync_fields(window, cx);
            assert_eq!(p.title.read(cx).text(), renamed);
        })
    });
    // Opened again: the rectangle is still drawn.
    let (again, mut vcx2) = open_page(cx, &ws, &book_id, &file);
    let vcx2 = &mut vcx2;
    wait(vcx2, |cx| {
        again.read_with(cx, |p, _| p.comments().len() == 1)
    });
    let listed = again.read_with(vcx2, |p, _| p.comments().to_vec());
    assert_eq!(listed[0].item.body.text, "礁石在这里");
    assert!(listed[0].region().is_some());
    ws.close();
}

/// The same file in the media modules of two entries: each entry's page
/// lists the comments on its own item and those straight on the file, not
/// the other entry's (review item 4 of the DY hand-back).
#[gpui::test]
fn a_media_page_lists_its_own_entrys_comments_and_the_files(cx: &mut TestAppContext) {
    let (_dir, ws, book_id) = tiny(cx);
    let file =
        crate::import::import_bytes(&ws, &book_id, None, dr_testkit::media::png(22, 18), "钟楼")
            .unwrap()
            .material;
    let (entry_a, module_a, item_a) = place_in_media_entry(&ws, &book_id, &file, "甲").unwrap();
    let (entry_b, module_b, item_b) = place_in_media_entry(&ws, &book_id, &file, "乙").unwrap();
    let region = json!({"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2});
    for (entry, module, body) in [(&entry_a, &module_a, "甲的"), (&entry_b, &module_b, "乙的")]
    {
        call(
            &ws,
            "comment.create",
            json!({"book": book_id, "target": {"kind": "entry", "id": entry}, "module": module,
                   "part": {"kind": "media", "asset": file, "region": region}, "body": body}),
        );
    }
    call(
        &ws,
        "comment.create",
        json!({"book": book_id, "target": {"kind": "asset", "id": file},
               "part": {"kind": "region", "region": region}, "body": "文件上的"}),
    );
    let bodies = |page: &Entity<MediaPage>, cx: &mut VisualTestContext| {
        let mut b: Vec<String> = page.read_with(cx, |p, _| {
            p.comments()
                .iter()
                .map(|l| l.item.body.text.clone())
                .collect()
        });
        b.sort();
        b
    };
    for (item, own) in [(&item_a, "甲的"), (&item_b, "乙的")] {
        let (page, mut vcx) = open_page(cx, &ws, &book_id, item);
        let vcx = &mut vcx;
        wait(vcx, |cx| {
            page.read_with(cx, |p, _| !p.comments().is_empty())
        });
        let mut want = vec![own.to_owned(), "文件上的".to_owned()];
        want.sort();
        assert_eq!(bodies(&page, vcx), want);
        let numbers: Vec<usize> =
            page.read_with(vcx, |p, _| p.comments().iter().map(|l| l.number).collect());
        assert_eq!(numbers, [1, 2]);
    }
    ws.close();
}

#[gpui::test]
fn media_page_lists_live_usages_and_updates_when_places_change(cx: &mut TestAppContext) {
    let (_dir, ws, book_id) = tiny(cx);
    let file =
        crate::import::import_bytes(&ws, &book_id, None, dr_testkit::media::png(20, 14), "城墙")
            .unwrap()
            .material;
    let (entry_a, _, _) = place_in_media_entry(&ws, &book_id, &file, "第四章").unwrap();
    let (page, mut vcx) = open_page(cx, &ws, &book_id, &file);
    let vcx = &mut vcx;
    wait(vcx, |cx| page.read_with(cx, |p, _| p.usages().len() == 1));
    assert_eq!(
        page.read_with(vcx, |p, _| p.usages()[0].entry_id.clone()),
        entry_a
    );
    assert_eq!(
        page.read_with(vcx, |p, _| p.usages()[0].entry_title.clone()),
        "第四章"
    );
    let (entry_b, _, _) = place_in_media_entry(&ws, &book_id, &file, "东岸").unwrap();
    wait(vcx, |cx| page.read_with(cx, |p, _| p.usages().len() == 2));
    let mut ids: Vec<String> = page.read_with(vcx, |p, _| {
        p.usages().iter().map(|u| u.entry_id.clone()).collect()
    });
    ids.sort();
    let mut want = vec![entry_a, entry_b];
    want.sort();
    assert_eq!(ids, want);
    ws.close();
}
