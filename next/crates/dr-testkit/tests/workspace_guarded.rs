//! Canonical observations and CAS at the F3/F2 holder boundary. All authored
//! text is taken from the shared seed, or transformed from that text.

use std::sync::mpsc;
use std::time::Duration;

use dr_store::{Library, OpenDoc};
use dr_testkit::seed::{self, Preset};
use dr_workspace::{Actor, Workspace, WorkspaceOptions, WritePreconditions, library_options};
use loro::ExportMode;
use serde_json::{Value, json};

struct Env {
    _dir: tempfile::TempDir,
    ws: Workspace,
    book: String,
    doc: String,
}
impl Env {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open(dir.path(), library_options("m29-guard-test")).unwrap();
        let seed = seed::generate(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        seed.write_to(&lib).unwrap();
        let book = seed.books[0].book_id().to_string();
        let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
        ws.set_auto_links(false);
        let chapters = out(&ws, "chapter.list", json!({"book":book}));
        let doc = format!("node:{}", chapters[0]["id"].as_str().unwrap());
        Self {
            _dir: dir,
            ws,
            book,
            doc,
        }
    }
    fn body(&self) -> Value {
        out(&self.ws, "prose.read", json!({"doc":self.doc}))
    }
    fn guards(&self, doc: &str) -> WritePreconditions {
        WritePreconditions::from_observations([self.ws.observe(doc).unwrap()])
    }
    fn bytes(&self, doc: &str) -> Vec<u8> {
        self.ws
            .library()
            .open_doc(doc, OpenDoc::Existing)
            .unwrap()
            .read(|doc| doc.export(ExportMode::all_updates()).unwrap())
            .unwrap()
    }
    fn receipts(&self) -> usize {
        self.ws
            .library()
            .settlements(Some("m29-guard"), None)
            .unwrap()
            .len()
    }
}
impl Drop for Env {
    fn drop(&mut self) {
        self.ws.close();
    }
}
fn out(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input).unwrap()["output"].clone()
}
fn agent() -> Actor {
    Actor::agent("m29-guard", 1, "guarded-write")
}
fn replacement(doc: &str, body: &Value) -> Value {
    let paragraph = &body["paragraphs"][1];
    let text = paragraph["text"].as_str().unwrap();
    json!({"doc":doc,"find":text,"replace":text.chars().rev().collect::<String>(),"block_id":paragraph["block_id"]})
}

#[test]
fn prose_read_and_observe_wait_for_a_whole_editor_commit() {
    let e = Env::new();
    let before = e.body();
    let text = before["paragraphs"][0]["text"].as_str().unwrap().to_owned();
    let editor = e.ws.prose_session(&e.doc).unwrap();
    let (entered, waiting) = mpsc::channel();
    let (release, blocked) = mpsc::channel();
    let writer = std::thread::spawn(move || {
        editor
            .edit(move |txn| {
                txn.insert_text(0, &text)?;
                entered.send(()).unwrap();
                blocked.recv().unwrap();
                txn.insert_text(0, &text)?;
                Ok(())
            })
            .unwrap()
    });
    waiting.recv_timeout(Duration::from_secs(2)).unwrap();
    let ws = e.ws.clone();
    let doc = e.doc.clone();
    let (read_done, read_result) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        read_done
            .send(out(&ws, "prose.read", json!({"doc":doc})))
            .unwrap();
    });
    let ws = e.ws.clone();
    let doc = e.doc.clone();
    let (observe_done, observe_result) = mpsc::channel();
    let observer = std::thread::spawn(move || {
        observe_done.send(ws.observe(&doc).unwrap()).unwrap();
    });
    assert!(read_result.recv_timeout(Duration::from_millis(30)).is_err());
    assert!(observe_result.try_recv().is_err());
    release.send(()).unwrap();
    writer.join().unwrap();
    let body = read_result.recv_timeout(Duration::from_secs(2)).unwrap();
    let observation = observe_result.recv_timeout(Duration::from_secs(2)).unwrap();
    reader.join().unwrap();
    observer.join().unwrap();
    assert_eq!(body, e.body());
    assert_eq!(body["version"], observation.version);
    let expected = before["paragraphs"][0]["text"].as_str().unwrap().repeat(3);
    assert_eq!(body["paragraphs"][0]["text"], expected);
    assert!(
        observation.value["body"]
            .as_str()
            .unwrap()
            .starts_with(&expected)
    );
}

#[test]
fn guard_is_checked_after_an_already_entered_editor_job_not_before_queueing() {
    let e = Env::new();
    let body = e.body();
    let guards = e.guards(&e.doc);
    let input = replacement(&e.doc, &body);
    let prefix = body["paragraphs"][0]["text"].as_str().unwrap().to_owned();
    let editor = e.ws.prose_session(&e.doc).unwrap();
    let (entered, waiting) = mpsc::channel();
    let (release, blocked) = mpsc::channel();
    let writer = std::thread::spawn(move || {
        editor
            .edit(move |txn| {
                // The replacement target in paragraph 1 remains identical. A
                // comparison before entering the holder would wrongly allow it.
                txn.insert_text(0, &prefix)?;
                entered.send(()).unwrap();
                blocked.recv().unwrap();
                Ok(())
            })
            .unwrap()
    });
    waiting.recv_timeout(Duration::from_secs(2)).unwrap();
    let ws = e.ws.clone();
    let (done, result) = mpsc::channel();
    let command = std::thread::spawn(move || {
        done.send(ws.call_guarded(&agent(), "prose.replace", input, guards))
            .unwrap();
    });
    assert!(result.recv_timeout(Duration::from_millis(30)).is_err());
    release.send(()).unwrap();
    writer.join().unwrap();
    let error = result
        .recv_timeout(Duration::from_secs(2))
        .unwrap()
        .unwrap_err();
    command.join().unwrap();
    assert_eq!(error.code(), "conflict");
    assert!(error.to_string().contains("stale observation:"));
    assert_eq!(e.body()["paragraphs"][1], body["paragraphs"][1]);
    assert_eq!(e.receipts(), 0);
}

#[test]
fn missing_guards_and_stale_book_observations_make_no_changes_or_receipts() {
    let e = Env::new();
    let body = e.body();
    let before = e.bytes(&e.doc);
    let error =
        e.ws.call_guarded(
            &agent(),
            "prose.replace",
            replacement(&e.doc, &body),
            WritePreconditions::default(),
        )
        .unwrap_err();
    assert_eq!(error.code(), "conflict");
    assert!(error.to_string().contains("read required:"));
    assert_eq!(e.bytes(&e.doc), before);
    let book_doc = format!("book:{}", e.book);
    let old = e.ws.observe(&book_doc).unwrap();
    let name = old.value["meta"]["name"].as_str().unwrap().to_owned();
    let renamed = name.chars().rev().collect::<String>();
    out(&e.ws, "book.update", json!({"book":e.book,"name":renamed}));
    let current = e.ws.observe(&book_doc).unwrap();
    let error =
        e.ws.call_guarded(
            &agent(),
            "book.update",
            json!({"book":e.book,"name":name}),
            WritePreconditions::from_observations([old]),
        )
        .unwrap_err();
    assert_eq!(error.code(), "conflict");
    assert_eq!(e.ws.observe(&book_doc).unwrap().value, current.value);
    assert_eq!(e.receipts(), 0);
}

#[test]
fn guarded_write_settles_and_identical_replacement_is_byte_identical() {
    let e = Env::new();
    let body = e.body();
    let mut input = replacement(&e.doc, &body);
    input["replace"] = input["find"].clone();
    let before = e.bytes(&e.doc);
    let unchanged =
        e.ws.call_guarded(&agent(), "prose.replace", input, e.guards(&e.doc))
            .unwrap();
    assert_eq!(e.bytes(&e.doc), before);
    assert_eq!(unchanged["effects"], json!([]));
    assert!(unchanged["journal"].is_null());
    assert_eq!(e.receipts(), 0);
    let input = replacement(&e.doc, &body);
    e.ws.call_guarded(&agent(), "prose.replace", input.clone(), e.guards(&e.doc))
        .unwrap();
    assert_eq!(e.body()["paragraphs"][1]["text"], input["replace"]);
    assert_eq!(e.receipts(), 1);
    let undone = out(
        &e.ws,
        "history.undo_agent",
        json!({"session":"m29-guard","turn":1}),
    );
    assert_eq!(undone["reverted_prose"], json!([e.doc]));
    assert_eq!(e.body()["paragraphs"], body["paragraphs"]);
}

#[test]
fn fresh_prose_uses_parent_observation_but_stale_parent_registers_nothing() {
    let e = Env::new();
    let body = e.body();
    let book_doc = format!("book:{}", e.book);
    let stale = e.guards(&book_doc);
    let text = body["paragraphs"][1]["text"].as_str().unwrap();
    let created =
        e.ws.call_guarded(
            &agent(),
            "chapter.create",
            json!({"book":e.book,"title":text,"text":text}),
            e.guards(&book_doc),
        )
        .unwrap();
    let doc = format!("node:{}", created["output"]["id"].as_str().unwrap());
    assert_eq!(
        out(&e.ws, "prose.read", json!({"doc":doc}))["paragraphs"][0]["text"],
        text
    );
    assert_eq!(e.receipts(), 2);
    let count = e.ws.library().docs(Some(&e.book), None).unwrap().len();
    let error =
        e.ws.call_guarded(
            &agent(),
            "chapter.create",
            json!({"book":e.book,"title":text,"text":text}),
            stale,
        )
        .unwrap_err();
    assert_eq!(error.code(), "conflict");
    assert_eq!(
        e.ws.library().docs(Some(&e.book), None).unwrap().len(),
        count
    );
    assert_eq!(e.receipts(), 2);
}

#[test]
fn malformed_versions_and_library_writes_are_rejected_before_dispatch() {
    let e = Env::new();
    let mut guards = WritePreconditions::default();
    guards.versions.insert(e.doc.clone(), "你好".into());
    assert_eq!(
        e.ws.call_guarded(
            &agent(),
            "prose.replace",
            replacement(&e.doc, &e.body()),
            guards
        )
        .unwrap_err()
        .code(),
        "invalid"
    );
    let before = e.ws.library().docs(None, None).unwrap().len();
    let title = e.body()["paragraphs"][0]["text"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        e.ws.call_guarded(
            &agent(),
            "book.create",
            json!({"name":title}),
            WritePreconditions::default()
        )
        .unwrap_err()
        .code(),
        "invalid"
    );
    assert_eq!(e.ws.library().docs(None, None).unwrap().len(), before);
    assert!(e.ws.call_guarded(
        &agent(), "recent.touch",
        json!({"book":e.book,"target":{"kind":"node","id":e.doc.strip_prefix("node:").unwrap()}}),
        e.guards(&format!("book:{}", e.book)),
    ).is_err());
    assert!(e.ws.library().local_get("ws", "recent").unwrap().is_none());
    assert_eq!(e.receipts(), 0);
}

#[test]
fn parallel_prose_writer_keeps_the_same_guard_boundary() {
    let e = Env::new();
    let handle = e.ws.library().open_doc(&e.doc, OpenDoc::Existing).unwrap();
    let anchor = handle
        .read(|doc| {
            dr_doc::anchor::Anchor::new(&doc.get_text("body"), 0..2)
                .unwrap()
                .encode()
        })
        .unwrap();
    let input = json!({"links":[{
        "doc":e.doc,
        "target":{"kind":"node","id":e.doc.strip_prefix("node:").unwrap()},
        "anchors":[dr_workspace::dto::AnchorBytes::from(&anchor)]
    }]});
    let before = e.bytes(&e.doc);
    let error =
        e.ws.call_guarded(
            &agent(),
            "prose.link",
            input.clone(),
            WritePreconditions::default(),
        )
        .unwrap_err();
    assert_eq!(error.code(), "conflict");
    assert_eq!(e.bytes(&e.doc), before);
    assert_eq!(e.receipts(), 0);
    e.ws.call_guarded(&agent(), "prose.link", input, e.guards(&e.doc))
        .unwrap();
    assert_eq!(e.receipts(), 1);
}

#[test]
fn guarded_history_restore_cannot_label_before_rejecting_a_stale_observation() {
    let e = Env::new();
    let body = e.body();
    let original = e.ws.observe(&e.doc).unwrap();
    out(&e.ws, "prose.replace", replacement(&e.doc, &body));
    let labels = e.ws.library().history(&e.doc).unwrap();
    let before = e.bytes(&e.doc);
    let error =
        e.ws.call_guarded(
            &agent(),
            "history.restore_point",
            json!({"doc":e.doc,"at":original.version}),
            WritePreconditions::from_observations([original]),
        )
        .unwrap_err();
    assert_eq!(error.code(), "invalid");
    assert!(error.to_string().contains("atomic label-and-write"));
    assert_eq!(e.bytes(&e.doc), before);
    assert_eq!(e.ws.library().history(&e.doc).unwrap(), labels);
    assert_eq!(e.receipts(), 0);
}
