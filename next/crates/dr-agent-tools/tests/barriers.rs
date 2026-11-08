//! Read coverage is established only by successful public tool calls. Fixture
//! discovery uses F3 as the author, so it cannot grant an Agent observations.

use std::collections::BTreeMap;

use dr_agent_tools::{AgentTools, CallRequest, Error};
use dr_model::id::BookId;
use dr_store::OpenDoc;
use dr_testkit::seed::{self, Preset};
use dr_workspace::{Actor, Workspace};
use loro::ExportMode;
use serde_json::{Value, json};

struct Fixture {
    ws: Workspace,
    book: BookId,
    chapters: Vec<Value>,
    elements: Vec<Value>,
    doc: String,
    prose: Value,
    _dir: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::open_dir(dir.path(), "m29-barriers-test").unwrap();
        ws.set_auto_links(false);
        let seeded = seed::generate(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        seeded.write_to(ws.library()).unwrap();
        let book = seeded.books[0].book_id().clone();
        let chapters = author(&ws, "chapter.list", json!({"book":book}))
            .as_array()
            .unwrap()
            .clone();
        let elements = author(&ws, "element.list", json!({"book":book}))
            .as_array()
            .unwrap()
            .clone();
        assert!(chapters.len() >= 2 && elements.len() >= 2);
        let doc = format!("node:{}", chapters[0]["id"].as_str().unwrap());
        let prose = author(&ws, "prose.read", json!({"doc":doc,"limit":usize::MAX}));
        assert!(prose["paragraphs"].as_array().unwrap().len() >= 2);
        Self {
            ws,
            book,
            chapters,
            elements,
            doc,
            prose,
            _dir: dir,
        }
    }

    fn invoke(
        &self,
        tools: &AgentTools,
        actor: &Actor,
        name: &str,
        arguments: Value,
    ) -> dr_agent_tools::Result<Value> {
        tools.invoke(&self.ws, &self.book, actor, request(name, arguments))
    }

    fn bytes(&self, doc: &str) -> Vec<u8> {
        self.ws
            .library()
            .open_doc(doc, OpenDoc::Existing)
            .unwrap()
            .read(|doc| doc.export(ExportMode::all_updates()).unwrap())
            .unwrap()
    }

    fn book_bytes(&self) -> Vec<u8> {
        self.bytes(&format!("book:{}", self.book))
    }

    fn receipts(&self) -> usize {
        self.ws.library().settlements(None, None).unwrap().len()
    }

    fn chapter_update(&self, chapter: usize) -> Value {
        json!({"id":self.chapters[chapter]["id"],"summary":self.text()})
    }

    fn text(&self) -> &str {
        self.prose["paragraphs"][1]["text"].as_str().unwrap()
    }

    fn replacement(&self, paragraph: usize) -> Value {
        let paragraph = &self.prose["paragraphs"][paragraph];
        let text = paragraph["text"].as_str().unwrap();
        json!({
            "doc":self.doc,
            "block_id":paragraph["block_id"],
            "find":text,
            "replace":text.chars().rev().collect::<String>()
        })
    }

    fn projection(&self, tools: &AgentTools, actor: &Actor) -> Value {
        self.invoke(
            tools,
            actor,
            "prose.read",
            json!({"doc":self.doc,"limit":usize::MAX}),
        )
        .unwrap()["output"]["projection"]
            .clone()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.ws.close();
    }
}

fn author(ws: &Workspace, name: &str, arguments: Value) -> Value {
    ws.call(&Actor::User, name, arguments).unwrap()["output"].clone()
}

fn request(name: &str, arguments: Value) -> CallRequest {
    CallRequest {
        name: name.into(),
        arguments,
        revision: None,
        edited_text: None,
    }
}

fn assert_read_required(result: dr_agent_tools::Result<Value>) {
    assert!(matches!(result, Err(Error::ReadRequired(_))), "{result:?}");
}

#[test]
fn resolving_an_entity_does_not_authorize_an_unread_write() {
    let f = Fixture::new();
    let tools = AgentTools::new();
    let actor = Actor::agent("unread", 1, "write");
    let book = f.book_bytes();
    let prose = f.bytes(&f.doc);
    let receipts = f.receipts();

    // Resolving these ids reads F3 internally, but those reads are not a
    // successful observation returned to this Agent.
    for chapter in 0..2 {
        assert_read_required(f.invoke(&tools, &actor, "chapter.update", f.chapter_update(chapter)));
    }
    assert_read_required(f.invoke(&tools, &actor, "prose.replace", f.replacement(1)));
    assert_eq!(f.book_bytes(), book);
    assert_eq!(f.bytes(&f.doc), prose);
    assert_eq!(f.receipts(), receipts);
}

#[test]
fn a_book_frontier_does_not_grant_coverage_of_its_chapters() {
    let f = Fixture::new();
    let tools = AgentTools::new();
    let actor = Actor::agent("book-only", 1, "write");
    f.invoke(&tools, &actor, "book.get", json!({})).unwrap();
    let before = f.book_bytes();
    let receipts = f.receipts();
    for chapter in 0..2 {
        assert_read_required(f.invoke(&tools, &actor, "chapter.update", f.chapter_update(chapter)));
    }
    assert_eq!(f.book_bytes(), before);
    assert_eq!(f.receipts(), receipts);

    f.invoke(&tools, &actor, "chapter.list", json!({})).unwrap();
    f.invoke(&tools, &actor, "chapter.update", f.chapter_update(0))
        .unwrap();
    assert_eq!(f.receipts(), receipts + 1);
}

#[test]
fn element_body_coverage_does_not_authorize_element_metadata() {
    let f = Fixture::new();
    let tools = AgentTools::new();
    let actor = Actor::agent("body-only", 1, "write");
    let element = &f.elements[0]["id"];
    let doc = format!("element:{}", element.as_str().unwrap());
    f.invoke(&tools, &actor, "prose.read", json!({"doc":doc}))
        .unwrap();
    let before = f.book_bytes();
    let body = f.bytes(&doc);
    let receipts = f.receipts();
    let update = json!({"id":element,"summary":f.text()});
    assert_read_required(f.invoke(&tools, &actor, "element.update", update.clone()));
    assert_eq!(f.book_bytes(), before);
    assert_eq!(f.bytes(&doc), body);
    assert_eq!(f.receipts(), receipts);

    f.invoke(&tools, &actor, "element.list", json!({})).unwrap();
    f.invoke(&tools, &actor, "element.update", update).unwrap();
    assert_eq!(f.receipts(), receipts + 1);
}

#[test]
fn one_paragraph_read_cannot_edit_an_unshown_paragraph() {
    let f = Fixture::new();
    let tools = AgentTools::new();
    let actor = Actor::agent("window", 1, "write");
    let shown = f
        .invoke(&tools, &actor, "prose.read", json!({"doc":f.doc,"limit":1}))
        .unwrap();
    assert_eq!(shown["output"]["paragraphs"].as_array().unwrap().len(), 1);
    assert_ne!(
        shown["output"]["paragraphs"][0]["block_id"],
        f.prose["paragraphs"][1]["block_id"]
    );
    let before = f.bytes(&f.doc);
    let receipts = f.receipts();
    assert_read_required(f.invoke(&tools, &actor, "prose.replace", f.replacement(1)));
    assert_eq!(f.bytes(&f.doc), before);
    assert_eq!(f.receipts(), receipts);

    f.invoke(
        &tools,
        &actor,
        "prose.read",
        json!({"doc":f.doc,"from":1,"limit":1}),
    )
    .unwrap();
    f.invoke(&tools, &actor, "prose.replace", f.replacement(1))
        .unwrap();
    assert_eq!(f.receipts(), receipts + 1);
}

#[test]
fn observations_belong_to_one_session_and_turn_but_not_one_call() {
    let f = Fixture::new();
    let tools = AgentTools::new();
    let reader = Actor::agent("reader", 1, "read");
    f.invoke(&tools, &reader, "chapter.list", json!({}))
        .unwrap();
    let before = f.book_bytes();
    let receipts = f.receipts();
    for actor in [
        Actor::agent("other", 1, "write"),
        Actor::agent("reader", 2, "write"),
    ] {
        assert_read_required(f.invoke(&tools, &actor, "chapter.update", f.chapter_update(0)));
    }
    assert_eq!(f.book_bytes(), before);
    assert_eq!(f.receipts(), receipts);
    f.invoke(
        &tools,
        &Actor::agent("reader", 1, "later-call"),
        "chapter.update",
        f.chapter_update(0),
    )
    .unwrap();
    assert_eq!(f.receipts(), receipts + 1);
}

#[test]
fn a_new_book_version_read_does_not_refresh_old_chapter_coverage() {
    let f = Fixture::new();
    let tools = AgentTools::new();
    let actor = Actor::agent("new-version", 1, "write");
    f.invoke(&tools, &actor, "chapter.list", json!({})).unwrap();
    let version = f.ws.observe(&format!("book:{}", f.book)).unwrap().version;
    author(
        &f.ws,
        "book.update",
        json!({"book":f.book,"summary":f.text()}),
    );
    assert_ne!(
        f.ws.observe(&format!("book:{}", f.book)).unwrap().version,
        version
    );
    f.invoke(&tools, &actor, "comment.list", json!({})).unwrap();
    let before = f.book_bytes();
    let receipts = f.receipts();
    assert_read_required(f.invoke(&tools, &actor, "chapter.update", f.chapter_update(0)));
    assert_eq!(f.book_bytes(), before);
    assert_eq!(f.receipts(), receipts);

    f.invoke(&tools, &actor, "chapter.list", json!({})).unwrap();
    f.invoke(&tools, &actor, "chapter.update", f.chapter_update(0))
        .unwrap();
    assert_eq!(f.receipts(), receipts + 1);
}

#[test]
fn unchanged_text_from_a_stale_projection_is_a_conflict_without_a_write() {
    let f = Fixture::new();
    let tools = AgentTools::new();
    let actor = Actor::agent("stale-projection", 1, "write");
    let projection = f.projection(&tools, &actor);
    let text = f.text().to_owned();
    f.ws.prose_session(&f.doc)
        .unwrap()
        .edit(move |txn| txn.insert_text(0, &text))
        .unwrap();
    let before = f.bytes(&f.doc);
    let book = f.book_bytes();
    let receipts = f.receipts();
    let result = tools.invoke(
        &f.ws,
        &f.book,
        &actor,
        CallRequest {
            edited_text: Some(projection["text"].as_str().unwrap().into()),
            ..request("prose.replace", json!({"doc":f.doc}))
        },
    );
    assert!(matches!(result, Err(Error::Conflict(_))), "{result:?}");
    assert_eq!(f.bytes(&f.doc), before);
    assert_eq!(f.book_bytes(), book);
    assert_eq!(f.receipts(), receipts);
}

#[test]
fn unchanged_text_from_a_current_projection_is_byte_identical() {
    let f = Fixture::new();
    let tools = AgentTools::new();
    let actor = Actor::agent("current-projection", 1, "write");
    let projection = f.projection(&tools, &actor);
    let before = f.bytes(&f.doc);
    let book = f.book_bytes();
    let receipts = f.receipts();
    let result = tools
        .invoke(
            &f.ws,
            &f.book,
            &actor,
            CallRequest {
                edited_text: Some(projection["text"].as_str().unwrap().into()),
                ..request("prose.replace", json!({"doc":f.doc}))
            },
        )
        .unwrap();
    assert_eq!(result["output"]["unchanged"], true);
    assert_eq!(result["effects"], json!([]));
    assert_eq!(f.bytes(&f.doc), before);
    assert_eq!(f.book_bytes(), book);
    assert_eq!(f.receipts(), receipts);
}

#[test]
fn changing_prose_tools_does_not_reset_the_same_documents_conflict_budget() {
    let f = Fixture::new();
    let tools = AgentTools::new();
    let actor = Actor::agent("mixed-conflicts", 1, "write");
    let target = json!({"kind":"node","id":f.chapters[0]["id"]});
    let comment = author(
        &f.ws,
        "comment.create",
        json!({"book":f.book,"target":target,"range":[0,1],"body":f.text()}),
    );
    let anchors = author(
        &f.ws,
        "comment.anchors",
        json!({"book":f.book,"target":target}),
    );
    let anchor = anchors
        .as_array()
        .unwrap()
        .iter()
        .find(|anchor| anchor["id"] == comment["id"])
        .unwrap()["anchor"]
        .clone();
    let author_edit = || {
        let text = f.text().chars().next().unwrap().to_string();
        f.ws.prose_session(&f.doc)
            .unwrap()
            .edit(move |txn| txn.insert_text(0, &text))
            .unwrap();
    };

    f.projection(&tools, &actor);
    author_edit();
    let first = f.invoke(&tools, &actor, "prose.replace", f.replacement(1));
    assert!(
        matches!(&first, Err(Error::Conflict(doc)) if doc == &f.doc),
        "{first:?}"
    );

    f.projection(&tools, &actor);
    author_edit();
    let prose = f.bytes(&f.doc);
    let book = f.book_bytes();
    let receipts = f.receipts();
    let second = f.invoke(
        &tools,
        &actor,
        "prose.link",
        json!({"links":[{
            "doc":f.doc,"target":{"kind":"element","id":f.elements[0]["id"]},
            "anchors":[anchor]
        }]}),
    );
    assert!(
        matches!(&second, Err(Error::ConflictLimit(doc)) if doc == &f.doc),
        "{second:?}"
    );

    // A fresh read cannot reset the already exhausted per-turn budget.
    f.projection(&tools, &actor);
    let third = f.invoke(&tools, &actor, "prose.replace", f.replacement(1));
    assert!(
        matches!(&third, Err(Error::ConflictLimit(doc)) if doc == &f.doc),
        "{third:?}"
    );
    assert_eq!(f.bytes(&f.doc), prose);
    assert_eq!(f.book_bytes(), book);
    assert_eq!(f.receipts(), receipts);
}

#[test]
fn public_prose_projection_contains_only_the_targets_actual_comment_anchors() {
    let f = Fixture::new();
    let tools = AgentTools::new();
    let actor = Actor::agent("comments", 1, "read");
    let target = json!({"kind":"node","id":f.chapters[0]["id"]});
    let block = &f.prose["paragraphs"][1]["block_id"];
    let attached = author(
        &f.ws,
        "comment.create",
        json!({
            "book":f.book,"target":target,"block_id":block,"body":f.text()
        }),
    );
    let document = author(
        &f.ws,
        "comment.create",
        json!({
            "book":f.book,"target":target,"body":f.text()
        }),
    );
    let elsewhere = author(
        &f.ws,
        "comment.create",
        json!({
            "book":f.book,"target":{"kind":"node","id":f.chapters[1]["id"]},"body":f.text()
        }),
    );
    let comments = f
        .invoke(&tools, &actor, "comment.list", json!({"target":target}))
        .unwrap();
    let expected: BTreeMap<_, _> = comments["output"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|comment| comment["unlocated"] == false && comment["region"].is_null())
        .map(|comment| {
            (
                comment["id"].as_str().unwrap().to_owned(),
                comment["target_block"].clone(),
            )
        })
        .collect();
    let projection = f.projection(&tools, &actor);
    let actual: BTreeMap<_, _> = projection["comments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|comment| {
            (
                comment["id"].as_str().unwrap().to_owned(),
                comment["block_id"].clone(),
            )
        })
        .collect();
    assert_eq!(actual, expected);
    assert_eq!(actual[attached["id"].as_str().unwrap()], *block);
    assert!(actual[document["id"].as_str().unwrap()].is_null());
    assert!(!actual.contains_key(elsewhere["id"].as_str().unwrap()));
    let anchor = projection["blocks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|anchor| anchor["block_id"] == *block)
        .unwrap();
    assert!(
        anchor["comments"]
            .as_array()
            .unwrap()
            .contains(&attached["id"])
    );
    let text = projection["text"].as_str().unwrap();
    assert!(text.contains(attached["id"].as_str().unwrap()));
    assert!(text.contains(document["id"].as_str().unwrap()));
    assert!(!text.contains(elsewhere["id"].as_str().unwrap()));
}
