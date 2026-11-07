//! The bridge on GPUI's test platform, over a real library (the showcase's
//! 《慢钟》, seeded through dr-testkit): it reads the shell's state and a
//! page's text, opens pages, presses keys through the keymap, types into a
//! focused field and nowhere else, calls F3's commands on the window's
//! library (and the page follows the change), and answers over the socket
//! with the token only.

use std::sync::Arc;
use std::time::{Duration, Instant};

use dr_debug_bridge::protocol::wire::codes;
use dr_debug_bridge::protocol::{BridgeError, Client, Paths};
use dr_shell::{Services, SettingsFile, ShellInfo, Workspace};
use dr_workspace::Workspace as Library;
use gpui::{Entity, TestAppContext, VisualTestContext};
use serde_json::{Value, json};

const VERSION: &str = "0.2.0-dev";

fn info() -> ShellInfo {
    ShellInfo {
        app_name: "Drifting Next",
        bundle_id: "cc.drifting.next.dev",
        version: VERSION,
        url_scheme: "drifting-next-dev",
        forced_appearance: None,
    }
}

fn slow_clock() -> (tempfile::TempDir, Library) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let lib = dr_store::Library::open(&root, dr_workspace::library_options(VERSION)).unwrap();
    let book = dr_testkit::samples::slow_clock().unwrap();
    dr_testkit::seed::write_book(&lib, &book).unwrap();
    lib.close().unwrap();
    (dir, Library::open_dir(&root, VERSION).unwrap())
}

fn setup(
    cx: &mut TestAppContext,
) -> (Entity<Workspace>, &mut VisualTestContext, tempfile::TempDir) {
    let (dir, library) = slow_clock();
    // F3 reads and delivers events on its own threads.
    cx.executor().allow_parking();
    cx.update(|cx| {
        dr_shell::init(
            info(),
            Services {
                deep_links: None,
                crash_reports: None,
                library: Some(library),
                book: None,
            },
            SettingsFile::in_memory(),
            cx,
        );
    });
    let (view, cx) = cx.add_window_view(Workspace::new);
    wait_for(&view, cx, |ws| !ws.book.is_empty());
    (view, cx, dir)
}

/// Runs the app until `done` holds, at most five seconds.
fn wait_for(
    view: &Entity<Workspace>,
    cx: &mut VisualTestContext,
    done: impl Fn(&Workspace) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        cx.run_until_parked();
        if view.read_with(cx, |ws, _| done(ws)) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out");
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn call(
    cx: &mut VisualTestContext,
    method: &'static str,
    params: Value,
) -> Result<Value, BridgeError> {
    let task = cx
        .update(|_, cx| cx.spawn(async move |cx| dr_debug_bridge::call(method, params, cx).await));
    let out = cx.foreground_executor().block_test(task);
    cx.run_until_parked();
    out
}

fn page_ready(ws: &Workspace) -> bool {
    ws.nav
        .current()
        .and_then(|t| ws.pages.get(&t.key()))
        .is_some_and(|s| s.ready && s.loading.is_none())
}

#[gpui::test]
fn the_shell_is_read_and_driven(cx: &mut TestAppContext) {
    let (view, cx, _dir) = setup(cx);

    let s = call(cx, "state.get", json!({})).unwrap();
    assert_eq!(s["book"]["name"], "慢钟");
    assert_eq!(s["book"]["chapters"], 24);
    assert_eq!(s["page"], "home");
    assert_eq!(s["library"], true);
    let methods = call(cx, "methods", Value::Null).unwrap();
    assert_eq!(
        methods.as_array().unwrap().len(),
        dr_debug_bridge::METHODS.len()
    );
    assert_eq!(
        call(cx, "no.such", json!({})).unwrap_err().code,
        codes::UNKNOWN_METHOD
    );

    // Open the first chapter by its title; the page reads its prose.
    let chapters = call(
        cx,
        "command.call",
        json!({"name": "chapter.list", "input": {"book": s["book"]["id"]}}),
    )
    .unwrap();
    let first = &chapters["output"][0];
    let second = &chapters["output"][1];
    let opened = call(cx, "nav.open", json!({"chapter": first["title"]})).unwrap();
    let key = format!("chapter:{}", first["id"].as_str().unwrap());
    assert_eq!(opened["opened"], json!(key));
    wait_for(&view, cx, page_ready);
    let waited = call(cx, "ui.wait", json!({"until": "ready"})).unwrap();
    assert_eq!(waited["polls"], 1);
    let page = call(cx, "page.text", json!({})).unwrap();
    assert_eq!(page["target"], json!(key));
    assert_eq!(page["title"], first["title"]);
    let prose = call(
        cx,
        "command.call",
        json!({"name": "prose.read", "input": {"doc": format!("node:{}", first["id"].as_str().unwrap())}}),
    )
    .unwrap();
    let paragraphs: Vec<&str> = prose["output"]["paragraphs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["text"].as_str().unwrap())
        .collect();
    assert_eq!(page["text"], json!(paragraphs.join("\n")));
    assert!(!paragraphs.is_empty());

    // A change through F3 (as the author, from outside the window) reaches
    // the page through the workspace's events.
    let old = paragraphs[0].chars().take(4).collect::<String>();
    call(
        cx,
        "command.call",
        json!({"name": "prose.replace", "input": {
            "doc": format!("node:{}", first["id"].as_str().unwrap()),
            "find": old, "replace": "灯塔亮了。",
        }}),
    )
    .unwrap();
    wait_for(&view, cx, |ws| {
        page_ready(ws)
            && ws.pages.values().any(|s| {
                s.items.iter().any(|i| matches!(i, dr_shell::workspace::Item::Para(p) if p.text.starts_with("灯塔亮了。")))
            })
    });
    call(
        cx,
        "ui.wait",
        json!({"text": "灯塔亮了。", "state": {"/page": key}}),
    )
    .unwrap();
    let words = call(
        cx,
        "command.call",
        json!({"name": "book.get", "input": {"book": s["book"]["id"]}}),
    )
    .unwrap();
    assert!(words["output"]["words"].as_u64().unwrap() > 1000);

    // Keys go through the keymap: open a second chapter, then ⌘[ goes back.
    call(
        cx,
        "nav.open",
        json!({"target": format!("chapter:{}", second["id"].as_str().unwrap())}),
    )
    .unwrap();
    let back = call(cx, "input.key", json!({"keys": "secondary-["})).unwrap();
    assert_eq!(back["handled"], json!([true]));
    assert_eq!(
        call(cx, "state.get", json!({})).unwrap()["page"],
        json!(key)
    );
    assert_eq!(
        call(cx, "nav.open", json!({"chapter": "没有这一章"}))
            .unwrap_err()
            .code,
        codes::NOT_FOUND
    );

    // An action by name.
    let left = call(cx, "state.get", json!({})).unwrap()["left"]["open"].clone();
    call(
        cx,
        "action.dispatch",
        json!({"name": "workspace::ToggleLeftSidebar"}),
    )
    .unwrap();
    assert_ne!(
        call(cx, "state.get", json!({})).unwrap()["left"]["open"],
        left
    );

    // Typing needs a text field with the focus: the paper is read-only
    // until the editor is on it (F6), Settings' search field takes it.
    assert_eq!(
        call(cx, "input.type", json!({"text": "字"}))
            .unwrap_err()
            .code,
        codes::NO_INPUT
    );
    call(cx, "action.dispatch", json!({"name": "app::OpenSettings"})).unwrap();
    assert_eq!(
        call(cx, "state.get", json!({})).unwrap()["layer"],
        "settings"
    );
    let typed = call(cx, "input.type", json!({"text": "字体"})).unwrap();
    assert_eq!(typed["typed"], 2);
    // Esc clears the search first, then closes Settings (the shell's rule).
    call(cx, "input.key", json!({"keys": "escape"})).unwrap();
    assert_eq!(
        call(cx, "state.get", json!({})).unwrap()["layer"],
        "settings"
    );
    call(cx, "input.key", json!({"keys": "escape"})).unwrap();
    assert_eq!(
        call(cx, "state.get", json!({})).unwrap()["layer"],
        Value::Null
    );

    let shot = call(cx, "ui.screenshot", json!({"settle_ms": 0}));
    if !cfg!(feature = "screenshot") {
        assert_eq!(shot.unwrap_err().code, codes::UNSUPPORTED);
    }
    let info = call(cx, "app.info", json!({})).unwrap();
    assert_eq!(info["library"], true);
    assert_eq!(info["windows"][0]["workspace"], true);
}

#[gpui::test]
fn the_socket_answers_with_the_token_only(cx: &mut TestAppContext) {
    let (_view, cx, dir) = setup(cx);
    let paths = Paths::under(&dir.path().join("bridge"));
    let connection = cx
        .update(|_, cx| dr_debug_bridge::start_at(&paths, "cc.drifting.next.dev.test", cx))
        .unwrap();
    assert_eq!(connection.pid, std::process::id());
    let client_paths = paths.clone();
    let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let finished = done.clone();
    let client = std::thread::spawn(move || {
        let out = (|| -> Result<Vec<Value>, BridgeError> {
            let mut c = Client::open(&client_paths)?;
            let hello = c.hello.clone();
            let state = c.call("state.get", json!({}))?;
            let opened = c.call("nav.open", json!({"chapter": "没有这一章"}));
            let mut forged = dr_debug_bridge::protocol::Connection::read(&client_paths.connection)?;
            forged.token = "nope".into();
            let refused = Client::connect(&forged).err().map(|e| e.code);
            Ok(vec![
                json!(hello.instance),
                state,
                json!(opened.err().map(|e| e.code)),
                json!(refused),
            ])
        })();
        finished.store(true, std::sync::atomic::Ordering::SeqCst);
        out
    });
    let deadline = Instant::now() + Duration::from_secs(10);
    while !done.load(std::sync::atomic::Ordering::SeqCst) {
        cx.run_until_parked();
        assert!(Instant::now() < deadline, "timed out");
        std::thread::sleep(Duration::from_millis(2));
    }
    let out = client.join().unwrap().unwrap();
    assert_eq!(out[0], "cc.drifting.next.dev.test");
    assert_eq!(out[1]["book"]["name"], "慢钟");
    assert_eq!(out[2], codes::NOT_FOUND);
    assert_eq!(out[3], codes::UNAUTHORIZED);
    cx.update(|_, cx| dr_debug_bridge::stop(cx));
    assert!(!paths.connection.exists());
}
