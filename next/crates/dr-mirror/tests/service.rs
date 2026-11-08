//! The Markdown folder running: the first pass writes every book; a file
//! saved in another editor is merged without being asked (file events);
//! the author's change in Drifting reaches the file after a pause; stopping
//! writes what is pending.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use dr_mirror::{Mirror, Options};
use dr_store::Library;
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use serde_json::{Value, json};

fn out(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input)
        .unwrap_or_else(|e| panic!("{name}: {e}"))["output"]
        .clone()
}

fn wait(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !done() {
        assert!(Instant::now() < deadline, "timed out: {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn texts(ws: &Workspace, node: &str) -> Vec<String> {
    out(ws, "prose.read", json!({"doc": format!("node:{node}")}))["paragraphs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["text"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn the_folder_follows_both_ways() {
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(dir.path().join("library"), library_options("test")).unwrap();
    let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
    let b = out(&ws, "book.create", json!({"name": "慢钟"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let c = out(
        &ws,
        "chapter.create",
        json!({"book": b, "title": "钟楼", "text": "钟楼在镇口。"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let root = dir.path().join("Markdown");
    let mut o = Options::new(&root, "this-device", "cc.drifting.next.dev");
    o.quiet = Duration::from_millis(100);
    o.max_wait = Duration::from_millis(500);
    o.settle = Duration::from_millis(50);
    let mirror = Mirror::start(ws.clone(), o).unwrap();
    let file: PathBuf = root.join("慢钟/正文/001 钟楼.md");
    wait("the first pass", || file.exists());

    // Saved in another editor.
    let text = std::fs::read_to_string(&file).unwrap();
    std::fs::write(&file, text.replace("钟楼在镇口。", "钟楼在镇口的石桥边。")).unwrap();
    wait("the file merged", || {
        texts(&ws, &c) == ["钟楼在镇口的石桥边。"]
    });

    // Typed in Drifting: written after a pause.
    out(
        &ws,
        "prose.replace",
        json!({"doc": format!("node:{c}"), "find": "石桥", "replace": "旧石桥"}),
    );
    wait("the file written", || {
        std::fs::read_to_string(&file).is_ok_and(|t| t.contains("钟楼在镇口的旧石桥边。"))
    });
    assert!(mirror.issues().is_empty());

    // Stopping writes what is pending.
    out(
        &ws,
        "prose.replace",
        json!({"doc": format!("node:{c}"), "find": "镇口", "replace": "镇子口"}),
    );
    mirror.stop();
    assert!(std::fs::read_to_string(&file).unwrap().contains("镇子口"));
    ws.close();
}
