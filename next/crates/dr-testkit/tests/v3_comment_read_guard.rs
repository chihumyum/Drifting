use dr_store::Library;
use dr_testkit::seed::{self, Preset};
use dr_workspace::{Actor, Workspace, WorkspaceOptions, WritePreconditions, library_options};
use serde_json::json;

#[test]
fn stale_prose_observation_cannot_anchor_a_comment_to_new_text() {
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(dir.path(), library_options("integrator-comment-guard")).unwrap();
    let seed = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
    seed.write_to(&lib).unwrap();
    let book = &seed.books[0];
    let bid = book.book_id().to_string();
    let view = book.book.view();
    let entry = view.structure_snapshot().manuscript_entries()[0]
        .id
        .to_string();
    let module = dr_doc::v3::novel::MOD_PROSE;
    let doc = format!("body:{entry}/{module}");
    let book_doc = format!("book:{bid}");
    let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
    ws.set_auto_links(false);
    let read = ws
        .call(&Actor::User, "prose.read", json!({"doc":doc}))
        .unwrap();
    let text = read["output"]["paragraphs"][0]["text"].as_str().unwrap();
    let first = text.chars().next().unwrap();
    let different = text.chars().find(|c| *c != first).unwrap();
    let inserted = different.to_string().repeat(4);
    let old_quote: String = text.chars().take(4).collect();
    assert_ne!(old_quote, inserted);
    let old_book = ws.observe(&book_doc).unwrap();
    let old_body = ws.observe(&doc).unwrap();
    ws.prose_session(&doc)
        .unwrap()
        .edit(move |txn| txn.insert_text(0, &inserted))
        .unwrap();
    assert_ne!(old_body.version, ws.observe(&doc).unwrap().version);
    assert_eq!(old_book.version, ws.observe(&book_doc).unwrap().version);
    let result = ws.call_guarded(
        &Actor::agent("integrator-comment-guard", 1, "comment-create"),
        "comment.create",
        json!({"book":bid,"target":{"kind":"entry","id":entry},"module":module,"range":[0,4],"body":old_quote}),
        WritePreconditions::from_observations([old_book.clone(), old_body]),
    );
    let comments = ws
        .call(&Actor::User, "comment.list", json!({"book":bid}))
        .unwrap();
    let after_book = ws.observe(&book_doc).unwrap();
    assert_eq!(
        comments["output"].as_array().unwrap().len(),
        old_book.value["comments"].as_object().unwrap().len()
    );
    ws.close();
    assert!(
        result.is_err(),
        "stale prose observation was accepted and anchored to changed text"
    );
    assert_eq!(
        old_book.version, after_book.version,
        "rejected stale source must not write book"
    );
}

struct Fixture {
    ws: Workspace,
    _dir: tempfile::TempDir,
    book: String,
    entry: String,
    doc: String,
    block: String,
    comment: String,
    anchor: serde_json::Value,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.ws.close();
    }
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open(dir.path(), library_options("comment-source-guards")).unwrap();
        let seed = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        seed.write_to(&lib).unwrap();
        let book = seed.books[0].book_id().to_string();
        let view = seed.books[0].book.view();
        let entry = view.structure_snapshot().manuscript_entries()[0]
            .id
            .to_string();
        let doc = format!("body:{entry}/{}", dr_doc::v3::novel::MOD_PROSE);
        let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
        ws.set_auto_links(false);
        let body = ws
            .call(&Actor::User, "prose.read", json!({"doc":doc}))
            .unwrap();
        let block = body["output"]["paragraphs"][0]["block_id"]
            .as_str()
            .unwrap()
            .to_string();
        let comment = ws
            .call(
                &Actor::User,
                "comment.create",
                json!({
                    "book":book,"target":{"kind":"entry","id":entry},"module":"mod-prose",
                    "range":[0,4],"body":"Preserve this comment",
                }),
            )
            .unwrap()["output"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let anchors = ws
            .call(
                &Actor::User,
                "comment.anchors",
                json!({
                    "book":book,"target":{"kind":"entry","id":entry},"module":"mod-prose",
                }),
            )
            .unwrap();
        let anchor = anchors["output"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["id"] == comment)
            .unwrap()["anchor"]
            .clone();
        Self {
            ws,
            _dir: dir,
            book,
            entry,
            doc,
            block,
            comment,
            anchor,
        }
    }
    fn guards(&self) -> WritePreconditions {
        WritePreconditions::from_observations([
            self.ws.observe(&format!("book:{}", self.book)).unwrap(),
            self.ws.observe(&self.doc).unwrap(),
        ])
    }
    fn writes(&self) -> Vec<(&str, serde_json::Value)> {
        let base = json!({"book":self.book,"target":{"kind":"entry","id":self.entry},
            "module":"mod-prose","body":"New review"});
        let mut range = base.clone();
        range["range"] = json!([0, 4]);
        let mut block = base;
        block["block_id"] = json!(self.block);
        let mut both = range.clone();
        both["block_id"] = json!(self.block);
        vec![
            ("comment.create", range),
            ("comment.create", block),
            ("comment.create", both),
            // A byte-identical reanchor still reads its source; it must not
            // silently bypass a stale observation by taking the no-op path.
            (
                "comment.reanchor",
                json!({"book":self.book,"id":self.comment,"anchor":self.anchor}),
            ),
        ]
    }
    fn refused_unchanged(&self, guards: WritePreconditions, stale_doc: &str) {
        let book = self.ws.observe(&format!("book:{}", self.book)).unwrap();
        let body = self.ws.observe(&self.doc).unwrap();
        let journal = serde_json::to_value(self.ws.journal(None, 100).unwrap()).unwrap();
        for (name, input) in self.writes() {
            let err = self
                .ws
                .call_guarded(
                    &Actor::agent("comment-source", 1, "write"),
                    name,
                    input,
                    guards.clone(),
                )
                .unwrap_err();
            assert!(matches!(err, dr_workspace::WsError::Conflict(_)), "{err:?}");
            assert!(err.to_string().contains(stale_doc), "{err:?}");
            let after_book = self.ws.observe(&book.doc).unwrap();
            assert_eq!(book.version, after_book.version);
            assert_eq!(book.value, after_book.value);
            let after_body = self.ws.observe(&body.doc).unwrap();
            assert_eq!(body.version, after_body.version);
            assert_eq!(body.value, after_body.value);
            assert_eq!(
                journal,
                serde_json::to_value(self.ws.journal(None, 100).unwrap()).unwrap()
            );
        }
    }
}

#[test]
fn stale_source_refuses_range_block_combined_and_reanchor_without_mutation() {
    let f = Fixture::new();
    let old = f.guards();
    let editor = f.ws.prose_session(&f.doc).unwrap();
    // A separate actual author edits only the body; the book guard is current.
    std::thread::spawn(move || editor.edit(|txn| txn.insert_text(0, "Changed ")).unwrap())
        .join()
        .unwrap();
    assert_eq!(
        old.versions[&format!("book:{}", f.book)],
        f.ws.observe(&format!("book:{}", f.book)).unwrap().version
    );
    f.refused_unchanged(old, &f.doc);
}

#[test]
fn source_observation_is_required_even_with_partial_write_guards() {
    let f = Fixture::new();
    for require_all in [true, false] {
        let mut guards = f.guards();
        guards.versions.remove(&f.doc);
        guards.require_all = require_all;
        f.refused_unchanged(guards, &f.doc);
    }
    // Clearing an anchor derives nothing from prose and only needs book CAS.
    let mut guards = f.guards();
    guards.versions.remove(&f.doc);
    let body = f.ws.observe(&f.doc).unwrap();
    let out =
        f.ws.call_guarded(
            &Actor::User,
            "comment.reanchor",
            json!({"book":f.book,"id":f.comment,"anchor":null}),
            guards,
        )
        .unwrap();
    assert!(out["journal"].is_null());
    assert_eq!(body.version, f.ws.observe(&f.doc).unwrap().version);
}

#[test]
fn refreshed_source_succeeds_but_stale_book_still_refuses_the_write() {
    let f = Fixture::new();
    let body = f.ws.observe(&f.doc).unwrap();
    let before = f.ws.observe(&format!("book:{}", f.book)).unwrap();
    let quote =
        f.ws.prose_session(&f.doc)
            .unwrap()
            .reader()
            .view()
            .text_in(0..4)
            .unwrap();
    let (_, input) = f.writes().remove(2);
    let out =
        f.ws.call_guarded(
            &Actor::agent("comment-source", 1, "write"),
            "comment.create",
            input,
            f.guards(),
        )
        .unwrap();
    let id = out["output"]["id"].as_str().unwrap();
    let after = f.ws.observe(&format!("book:{}", f.book)).unwrap();
    assert_eq!(after.value["comments"][id]["quote"], quote);
    let mut expected = before.value;
    expected["comments"][id] = after.value["comments"][id].clone();
    assert_eq!(expected, after.value);
    assert_eq!(body.version, f.ws.observe(&f.doc).unwrap().version);
    let mut guards = f.guards();
    guards.versions.insert(before.doc.clone(), before.version);
    // These creates reach the book CAS with a current source observation.
    let mut writes = f.writes();
    writes.pop();
    for (name, input) in writes {
        assert!(matches!(
            f.ws.call_guarded(&Actor::User, name, input, guards.clone()),
            Err(dr_workspace::WsError::Conflict(_))
        ));
    }
    assert_eq!(after.version, f.ws.observe(&before.doc).unwrap().version);
    assert_eq!(after.value, f.ws.observe(&before.doc).unwrap().value);
}
