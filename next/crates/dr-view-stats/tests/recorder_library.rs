//! The recorder over a real library: the author's prose change, once the
//! index has it, becomes this device's words for today in the book
//! document, under the 0.1 writing-day key; a body template's never does.

use std::time::{Duration, Instant};

use dr_view_stats::Recorder;
use dr_workspace::{Actor, Workspace, WorkspaceOptions};
use serde_json::{Value, json};

fn out(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input).expect(name)["output"].clone()
}

#[test]
fn the_authors_words_are_stored_for_today() {
    let dir = tempfile::tempdir().unwrap();
    let device = dr_store::Device::open_with_machine_id(dir.path().join("device"), None).unwrap();
    let key = device.writing_device_key();
    let mut options = dr_workspace::library_options("0.2.0-dev");
    options.device = Some(device);
    let lib = dr_store::Library::open(dir.path().join("library"), options).unwrap();
    let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
    assert_eq!(ws.writing_device().as_deref(), Some(key.as_str()));

    let book = out(&ws, "book.create", json!({"name": "Book"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let chapter = out(
        &ws,
        "chapter.create",
        json!({"book": book, "title": "One", "text": "钟楼在镇口。"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let doc = format!("node:{chapter}");
    ws.library().reindex_doc(&doc).unwrap();

    let recorder = Recorder::over(&ws, |_| {});
    recorder.track(&book);
    // The recorder reads the book's words on its own thread: wait until it
    // has, or that read could already include the edit below.
    let deadline = Instant::now() + Duration::from_secs(5);
    while recorder.today(&book).is_none() {
        assert!(Instant::now() < deadline, "the book was never followed");
        std::thread::sleep(Duration::from_millis(5));
    }
    // The author adds four characters; the index catches up.
    out(
        &ws,
        "prose.replace",
        json!({"doc": doc, "find": "镇口", "replace": "镇口的石桥边"}),
    );
    ws.library().reindex_doc(&doc).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while recorder.today(&book) != Some(4) {
        assert!(Instant::now() < deadline, "{:?}", recorder.today(&book));
        std::thread::sleep(Duration::from_millis(5));
    }
    // A body template is written like a page but is not the book's text:
    // neither today's words nor the book's change.
    let cat = out(
        &ws,
        "category.create",
        json!({"book": book, "name": "人物"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    out(
        &ws,
        "category_template.set_body",
        json!({"book": book, "category": cat, "paragraphs": [{"heading": 1, "text": "外貌与来历"}]}),
    );
    ws.library()
        .reindex_doc(&format!("template:category:{cat}"))
        .unwrap();
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(recorder.today(&book), Some(4));
    assert!(recorder.flush(Duration::from_secs(5)));
    let today = dr_view_stats::clock::today().to_string();
    let days = out(
        &ws,
        "book.writing_days",
        json!({"book": book, "today": today, "device": key}),
    );
    assert_eq!(days["mine_today"], 4);
    assert_eq!(days["today"], 4);
    let progress =
        dr_view_stats::load_progress(&ws, &book, &dr_view_stats::clock::today(), Some(4)).unwrap();
    assert_eq!((progress.today, progress.streak), (4, 1));
    assert_eq!(progress.words, 9, "钟楼在镇口的石桥边");
}
