//! The bridge on GPUI's test platform, over a real library (the showcase's
//! 《慢钟》, seeded through dr-testkit): it reads the shell's state and a
//! page's text, opens pages, presses keys through the keymap, types into a
//! focused field and nowhere else, calls F3's commands on the window's
//! library (and the page follows the change), and answers over the socket
//! with the token only. With M03's page chrome registered it reads the
//! chapter page's head and reaches its title field the way a click would.

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
    wait_for(&view, cx, |ws, _| !ws.book.is_empty());
    (view, cx, dir)
}

/// Runs the app until `done` holds, at most ten seconds.
fn wait_for(
    view: &Entity<Workspace>,
    cx: &mut VisualTestContext,
    done: impl Fn(&Workspace, &gpui::App) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        cx.run_until_parked();
        if cx.update(|_, cx| done(view.read(cx), cx)) {
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

/// The page on the paper has its editor.
fn editor_ready(ws: &Workspace, _: &gpui::App) -> bool {
    ws.nav.current().and_then(|t| ws.editor_of(t)).is_some()
}

/// Calls `method` until `done` holds for its answer (F3's holder threads
/// and the editor's events land in their own time).
fn call_until(
    cx: &mut VisualTestContext,
    method: &'static str,
    params: Value,
    done: impl Fn(&Value) -> bool,
) -> Value {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let out = call(cx, method, params.clone()).unwrap();
        if done(&out) {
            return out;
        }
        assert!(Instant::now() < deadline, "timed out: {out}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn texts(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|p| p["text"].as_str().unwrap().to_owned())
        .collect()
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
    // On the Project Home no text field has the keyboard.
    assert_eq!(
        call(cx, "input.type", json!({"text": "字"}))
            .unwrap_err()
            .code,
        codes::NO_INPUT
    );

    // Open the first chapter by its title: its editor opens and takes the
    // keyboard; the page reads what F3 has.
    let chapters = call(
        cx,
        "command.call",
        json!({"name": "chapter.list", "input": {"book": s["book"]["id"]}}),
    )
    .unwrap();
    let first = &chapters["output"][0];
    let second = &chapters["output"][1];
    let first_doc = format!("node:{}", first["id"].as_str().unwrap());
    let opened = call(cx, "nav.open", json!({"chapter": first["title"]})).unwrap();
    let key = format!("chapter:{}", first["id"].as_str().unwrap());
    assert_eq!(opened["opened"], json!(key));
    wait_for(&view, cx, editor_ready);
    // The shell hands the opened page's editor the keyboard (F6).
    call_until(cx, "state.get", json!({}), |s| {
        s["focus"]["editor"] == json!(true)
    });
    let waited = call(
        cx,
        "ui.wait",
        json!({"until": "ready", "state": {"/focus/editor": true}}),
    )
    .unwrap();
    assert_eq!(waited["polls"], 1);
    let page = call(cx, "page.text", json!({})).unwrap();
    assert_eq!(
        (page["target"].clone(), page["source"].clone()),
        (json!(key), json!("editor"))
    );
    assert_eq!(page["title"], first["title"]);
    let read = |cx: &mut VisualTestContext| {
        call(
            cx,
            "command.call",
            json!({"name": "prose.read", "input": {"doc": first_doc}}),
        )
        .unwrap()
    };
    let before = texts(&read(cx)["output"]["paragraphs"]);
    assert!(!before.is_empty());
    assert_eq!(page["text"], json!(before.join("\n")));

    // Type a sentence, press Enter, undo: through GPUI's input path into the
    // editor, persisted through F3's session.
    let typed = call(cx, "input.type", json!({"text": "验收打字一句。"})).unwrap();
    assert_eq!(typed["typed"], 7);
    let page = call(cx, "page.text", json!({})).unwrap();
    assert!(
        page["text"].as_str().unwrap().starts_with("验收打字一句。"),
        "{page}"
    );
    assert_eq!(page["selection"], json!({"anchor": 7, "head": 7}));
    call_until(
        cx,
        "command.call",
        json!({"name": "prose.read", "input": {"doc": first_doc}}),
        |o| {
            o["output"]["paragraphs"][0]["text"]
                .as_str()
                .is_some_and(|t| t.starts_with("验收打字一句。"))
        },
    );
    let enter = call(cx, "input.key", json!({"keys": "enter"})).unwrap();
    assert_eq!(enter["handled"], json!([true]));
    let split = call(cx, "page.text", json!({})).unwrap();
    assert_eq!(
        split["paragraphs"].as_array().unwrap().len(),
        before.len() + 1
    );
    assert_eq!(split["paragraphs"][0]["text"], "验收打字一句。");
    let undo = call(cx, "input.key", json!({"keys": "secondary-z"})).unwrap();
    assert_eq!(undo["handled"], json!([true]));
    let undone = call(cx, "page.text", json!({})).unwrap();
    assert_eq!(
        undone["paragraphs"].as_array().unwrap().len(),
        before.len(),
        "{undone}"
    );
    // ⌘Z takes back the Enter only; the sentence typed before it stays.
    assert_eq!(
        undone["paragraphs"][0]["text"],
        json!(format!("验收打字一句。{}", before[0]))
    );
    let after = call_until(
        cx,
        "command.call",
        json!({"name": "prose.read", "input": {"doc": first_doc}}),
        |o| o["output"]["total"] == json!(before.len()),
    );
    assert_eq!(
        texts(&after["output"]["paragraphs"]).join("\n"),
        undone["text"].as_str().unwrap()
    );

    // A change through F3 (as the author, from outside the window) reaches
    // the open editor through the workspace's events.
    let second_doc = format!("node:{}", second["id"].as_str().unwrap());
    let theirs = call(
        cx,
        "command.call",
        json!({"name": "prose.read", "input": {"doc": second_doc}}),
    )
    .unwrap();
    let p0 = theirs["output"]["paragraphs"][0]["text"]
        .as_str()
        .unwrap()
        .to_owned();
    call(
        cx,
        "nav.open",
        json!({"target": format!("chapter:{}", second["id"].as_str().unwrap())}),
    )
    .unwrap();
    wait_for(&view, cx, editor_ready);
    call(
        cx,
        "command.call",
        json!({"name": "prose.replace", "input": {
            "doc": second_doc, "find": p0, "replace": format!("灯塔亮了。{p0}"),
        }}),
    )
    .unwrap();
    call_until(cx, "page.text", json!({}), |p| {
        p["text"]
            .as_str()
            .is_some_and(|t| t.starts_with("灯塔亮了。"))
    });
    call(cx, "ui.wait", json!({"text": "灯塔亮了。"})).unwrap();
    // The seed's stale indexes catch up once the typing has been quiet for
    // a moment (F2's `background_quiet`): ask until the count is in.
    call_until(
        cx,
        "command.call",
        json!({"name": "book.get", "input": {"book": s["book"]["id"]}}),
        |w| w["output"]["words"].as_u64().is_some_and(|n| n > 1000),
    );

    // ⌘[ goes back through the keymap, from inside the editor too.
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

    // Settings' search field takes typing too.
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
fn the_chapter_page_head_is_read_and_its_title_reached(cx: &mut TestAppContext) {
    cx.update(dr_view_page::init);
    let (view, cx, _dir) = setup(cx);
    let book = cx.update(|_, cx| view.read(cx).book_id.clone());
    let chapters = call(
        cx,
        "command.call",
        json!({ "name": "chapter.list", "input": { "book": book } }),
    )
    .unwrap();
    let first = chapters["output"][0].clone();
    let id = first["id"].as_str().unwrap().to_owned();
    call(cx, "nav.open", json!({ "chapter": id })).unwrap();
    wait_for(&view, cx, editor_ready);

    // The head is drawn with the editor's first frame.
    let page = call_until(cx, "page.text", json!({}), |p| !p["head"].is_null());
    assert_eq!(page["head"]["title"], first["title"]);
    assert_eq!(page["head"]["number"], json!(1));
    assert_eq!(page["head"]["focus"], Value::Null);

    // Into the title, everything selected; typing replaces it; Enter hands
    // the caret to the text.
    call(
        cx,
        "ui.focus",
        json!({ "field": "page.title", "select_all": true }),
    )
    .unwrap();
    assert_eq!(
        call(cx, "page.text", json!({})).unwrap()["head"]["focus"],
        json!("title")
    );
    call(cx, "input.type", json!({ "text": "桥改的标题" })).unwrap();
    let head = call(cx, "page.text", json!({})).unwrap()["head"].clone();
    assert_eq!(
        head["title"],
        json!("桥改的标题"),
        "the whole title was replaced"
    );
    call(cx, "input.key", json!({ "keys": "enter" })).unwrap();
    // Enter leaves the field for the text (storing it is the page's own
    // business, checked on the real window by scenarios/page-chrome.json).
    let state = call_until(cx, "state.get", json!({}), |s| {
        s["focus"]["editor"] == json!(true)
    });
    assert_eq!(state["selection"]["head"], json!(0));
    assert_eq!(
        call(cx, "page.text", json!({})).unwrap()["head"]["focus"],
        Value::Null
    );

    // Fields the page does not have, and settings.
    let err = call(cx, "ui.focus", json!({ "field": "element.name" })).unwrap_err();
    assert_eq!(err.code, codes::NOT_FOUND);
    let settings = call(cx, "settings.get", json!({ "keys": ["editor.font_size"] })).unwrap();
    assert_eq!(settings["values"]["editor.font_size"], json!(17.0));
    // GPUI's test platform has no accessibility adapter: nothing is found.
    let err = call(cx, "ui.find", json!({ "label": "x", "timeout_ms": 30 })).unwrap_err();
    assert!(
        [codes::NOT_FOUND, codes::UNSUPPORTED].contains(&err.code.as_str()),
        "{err:?}"
    );
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

#[gpui::test]
fn the_transfer_dialog_files_and_panels_are_read(cx: &mut TestAppContext) {
    let (view, cx, dir) = setup(cx);
    let empty = call(cx, "state.get", json!({})).unwrap();
    assert_eq!(empty["transfer"], Value::Null);
    assert_eq!(empty["panel"]["last"], Value::Null);
    assert_eq!(
        call(cx, "library.info", json!({})).unwrap()["preRestore"],
        json!([])
    );

    // M41's backup as the save panel's answer would start it: the dialog
    // works, then says what it wrote; the file is there whole.
    let path = dir.path().join("library.drifting");
    let lib = cx.update(|_, cx| view.read(cx).library.clone().unwrap());
    let target = path.clone();
    // Outside the window's update, as the panel's answer arrives (the
    // dialog is put into the window's workspace).
    cx.update(|_, cx| {
        cx.defer(move |cx| {
            dr_view_transfer::backup::backup_path(lib, target, cx);
        })
    });
    let done = call_until(cx, "state.get", json!({}), |s| {
        s["transfer"]["state"] == json!("done")
    });
    assert_eq!(done["dialog"], json!(true));
    assert_eq!(done["transfer"]["title"], json!("Library backup"));
    assert!(
        done["transfer"]["text"]
            .as_str()
            .unwrap()
            .contains("library.drifting"),
        "{done}"
    );
    let file = call(
        cx,
        "ui.wait",
        json!({ "until": "file", "path": path.to_string_lossy(), "timeout_ms": 1000 }),
    )
    .unwrap();
    assert!(file["bytes"].as_u64().unwrap() > 0);
    let err = call(
        cx,
        "ui.wait",
        json!({ "until": "file", "path": dir.path().join("none").to_string_lossy(), "timeout_ms": 60 }),
    )
    .unwrap_err();
    assert_eq!(err.code, codes::TIMEOUT);

    // The system panels: nothing asked for yet; an answer is armed for
    // the next one (GPUI's test platform never begins an AppKit panel).
    let state = call(cx, "panel.state", json!({})).unwrap();
    assert_eq!(state["armed"], Value::Null);
    assert_eq!(state["last"], Value::Null);
    assert_eq!(state["shown"], json!(false));
    let err = call(cx, "panel.answer", json!({ "path": "relative.drifting" })).unwrap_err();
    assert_eq!(err.code, codes::BAD_REQUEST);
    match call(
        cx,
        "panel.answer",
        json!({ "path": path.to_string_lossy() }),
    ) {
        Ok(armed) => {
            assert_eq!(armed["armed"], json!(path.to_string_lossy()));
            let armed = call(cx, "panel.cancel", json!({})).unwrap();
            assert_eq!(armed["armed"], json!("cancel"));
            assert_eq!(
                call(cx, "state.get", json!({})).unwrap()["panel"]["armed"],
                json!("cancel")
            );
        }
        Err(err) => assert_eq!(err.code, codes::UNSUPPORTED),
    }
}
