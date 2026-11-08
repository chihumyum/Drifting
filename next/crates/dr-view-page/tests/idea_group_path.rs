//! M03's idea breadcrumb follows the live book while its page stays open.
//! The corpus is dr-testkit's sample; only group metadata changes here.

use std::time::{Duration, Instant};

use dr_shell::nav::{Open, Target};
use dr_shell::{Services, SettingsFile, ShellInfo, Workspace};
use dr_view_page::page_views;
use dr_workspace::Actor;
use gpui::{Entity, TestAppContext, VisualTestContext, px, size};
use serde_json::{Value, json};

fn call(ws: &dr_workspace::Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input).unwrap()["output"].clone()
}

fn draw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| {
        window.simulate_next_frame(cx);
        window.draw(cx).clear(cx);
    });
    cx.run_until_parked();
}

fn wait(cx: &mut VisualTestContext, done: impl Fn(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        draw(cx);
        if done(cx) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out");
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn wait_path(
    cx: &mut VisualTestContext,
    head: &Entity<dr_view_page::PageHead>,
    expected: Option<&str>,
) {
    wait(cx, |cx| {
        head.read_with(cx, |head, _| head.group_path() == expected)
    });
}

#[gpui::test]
fn the_open_idea_follows_renamed_moved_and_deleted_groups(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let store = dr_store::Library::open(&root, dr_workspace::library_options("test")).unwrap();
    let sample = dr_testkit::samples::a_q().unwrap();
    let book = sample.book_id().to_string();
    dr_testkit::seed::write_book(&store, &sample).unwrap();
    store.close().unwrap();
    let lib = dr_workspace::Workspace::open_dir(&root, "test").unwrap();
    let idea = call(&lib, "idea.list", json!({"book": book}))[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let parent = call(
        &lib,
        "idea_group.create",
        json!({"book": book, "name": "分组"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let child = call(
        &lib,
        "idea_group.create",
        json!({"book": book, "name": "子组", "parent": parent}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    call(
        &lib,
        "idea.update",
        json!({"book": book, "id": idea, "group": child}),
    );
    cx.update(|cx| {
        let mut file = SettingsFile::in_memory();
        file.set(
            dr_shell::settings::registry::UI_LOCALE,
            "zh-CN".into(),
            None,
        )
        .unwrap();
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "0.2.0-dev",
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                library: Some(lib.clone()),
                ..Services::default()
            },
            file,
            cx,
        );
        dr_view_page::init(cx);
    });
    let window = cx.add_window(Workspace::new);
    let ws = window.root(cx).unwrap();
    let mut cx = VisualTestContext::from_window(window.into(), cx);
    cx.simulate_resize(size(px(1280.0), px(900.0)));
    wait(&mut cx, |cx| ws.read_with(cx, |ws, _| !ws.book.is_empty()));
    let target = Target::Idea(idea.parse().unwrap());
    cx.update(|_, cx| ws.update(cx, |ws, cx| ws.open(target, Open::KEEP, cx)));
    let doc = format!("node:{idea}");
    wait(&mut cx, |cx| {
        cx.update(|_, cx| page_views(&doc, cx).is_some())
    });
    let (head, _) = cx.update(|_, cx| page_views(&doc, cx)).unwrap();
    wait_path(&mut cx, &head, Some("分组 - 子组"));

    // Group metadata changes independently of PageInfo and the prose.
    call(
        &lib,
        "idea_group.update",
        json!({"book": book, "id": parent, "name": "结构"}),
    );
    wait_path(&mut cx, &head, Some("结构 - 子组"));
    call(
        &lib,
        "idea.update",
        json!({"book": book, "id": idea, "group": null}),
    );
    wait_path(&mut cx, &head, None);
    call(
        &lib,
        "idea.update",
        json!({"book": book, "id": idea, "group": child}),
    );
    wait_path(&mut cx, &head, Some("结构 - 子组"));
    call(
        &lib,
        "idea_group.delete",
        json!({"book": book, "id": child}),
    );
    wait_path(&mut cx, &head, Some("结构"));
    call(
        &lib,
        "idea_group.delete",
        json!({"book": book, "id": parent}),
    );
    wait_path(&mut cx, &head, None);

    // A chapter keeps its chapter/storyline folio, without an idea group.
    let chapter = call(&lib, "chapter.list", json!({"book": book}))[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    cx.update(|_, cx| {
        ws.update(cx, |ws, cx| {
            ws.open(Target::Chapter(chapter.parse().unwrap()), Open::KEEP, cx)
        })
    });
    let doc = format!("node:{chapter}");
    wait(&mut cx, |cx| {
        cx.update(|_, cx| page_views(&doc, cx).is_some())
    });
    let (head, _) = cx.update(|_, cx| page_views(&doc, cx)).unwrap();
    wait_path(&mut cx, &head, None);
}
