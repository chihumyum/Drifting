//! Review regressions exercise the public facade against real F3 data. All
//! authored text comes from the shared tiny seed; automatic links stay on.

use std::collections::BTreeMap;

use dr_agent_tools::{AgentTools, CallRequest, Error, catalog::Search};
use dr_model::id::BookId;
use dr_testkit::seed::{self, Preset};
use dr_workspace::{Actor, Workspace};
use loro::ExportMode;
use serde_json::{Value, json};

// The chapter.create revision in the previous pre-F3-10 directory snapshot,
// before the input schema gained narrative_order. Keep this historical value
// so a model's previously discovered tool contract cannot silently change.
const PRE_NARRATIVE_ORDER_REVISION: &str =
    "39973049c7515d17c3cc5ac6acce6645cee63857285f9c3d8d7eae1388856f9e";

struct Fixture {
    ws: Workspace,
    book: BookId,
    text: String,
    _dir: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::open_dir(dir.path(), "m29-review-regressions").unwrap();
        let seeded = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        let book = seeded.books[0].book_id().clone();
        let text = seeded.books[0].prose[0]
            .view()
            .plain_text()
            .chars()
            .take(24)
            .collect();
        seeded.write_to(ws.library()).unwrap();
        assert!(ws.auto_links());
        Self {
            ws,
            book,
            text,
            _dir: dir,
        }
    }

    fn author(&self, name: &str, arguments: Value) -> Value {
        self.ws.call(&Actor::User, name, arguments).unwrap()["output"].clone()
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

    fn documents(&self) -> BTreeMap<String, Vec<u8>> {
        self.ws
            .library()
            .docs(Some(self.book.as_str()), None)
            .unwrap()
            .into_iter()
            .filter(|info| self.ws.library().head(&info.doc_id).unwrap().is_some())
            .map(|info| {
                let bytes = self
                    .ws
                    .library()
                    .load_copy(&info.doc_id)
                    .unwrap()
                    .export(ExportMode::all_updates())
                    .unwrap();
                (info.doc_id, bytes)
            })
            .collect()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.ws.close();
    }
}

fn request(name: &str, arguments: Value) -> CallRequest {
    CallRequest {
        name: name.into(),
        arguments,
        revision: None,
        edited_text: None,
    }
}

fn unavailable(result: dr_agent_tools::Result<Value>) {
    assert!(matches!(result, Err(Error::Invalid(message)) if message == "unknown book tool"));
}

#[test]
fn internal_note_task_projection_is_never_discovered_or_authorized_by_prose_reads() {
    let f = Fixture::new();
    let material = f.author(
        "material.create",
        json!({"book":f.book,"kind":"text","title":f.text,"text":f.text}),
    );
    let doc = format!("material:{}", material["id"].as_str().unwrap());
    let tools = AgentTools::new();
    assert!(tools.catalog().descriptor("note_tasks.project").is_none());
    assert_eq!(
        tools.catalog().search(Search {
            query: "note_tasks.project".into(),
            ..Search::default()
        })["total"],
        0
    );
    // Before M19 lands this checks the unavailable name; once it is registered
    // the same public-facade test must still reject before parsing or mutation.
    for (index, read) in ["prose.read"].into_iter().enumerate() {
        let session = format!("review-note-maintenance-{index}");
        let actor = Actor::agent(&session, 1, "project");
        let arguments = if read == "prose.read" {
            json!({"doc":doc,"limit":usize::MAX})
        } else {
            json!({"doc":doc})
        };
        f.invoke(&tools, &actor, read, arguments).unwrap();
        let before = f.documents();
        unavailable(f.invoke(&tools, &actor, "note_tasks.project", json!({"doc":doc})));
        assert_eq!(
            f.documents(),
            before,
            "{read} cannot authorize maintenance writes"
        );
        assert!(
            f.ws.library()
                .settlements(Some(&session), None)
                .unwrap()
                .is_empty()
        );
    }
}

#[test]
fn deleting_a_read_comment_cannot_purge_its_unread_hidden_relation() {
    let f = Fixture::new();
    let chapter = dr_testkit::seed::acceptance::entries_by_template(&f.ws, &f.book, "tpl-chapter")
        [0]["id"]
        .clone();
    let comment = f.author("comment.create", json!({"book":f.book,"body":f.text}))["id"].clone();
    let relation=f.author("relation.create",json!({"book":f.book,"from":{"kind":"comment","id":comment},"to":{"kind":"entry","id":chapter}}))["id"].clone();
    let visible = f.author("relation.list", json!({"book":f.book}));
    let original = visible
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == relation)
        .unwrap()
        .clone();
    f.author("entry.trash", json!({"book":f.book,"id":chapter}));
    let copy =
        f.ws.library()
            .load_copy(&format!("book:{}", f.book))
            .unwrap();
    let borrowed = dr_doc::v3::BorrowedBookV3::new(&copy, &f.book).unwrap();
    assert!(
        borrowed
            .view()
            .relations()
            .iter()
            .all(|row| row.id.as_str() != relation.as_str().unwrap())
    );

    let tools = AgentTools::new();
    let actor = Actor::agent("review-hidden-comment", 1, "delete");
    let comments = f.invoke(&tools, &actor, "comment.list", json!({})).unwrap();
    assert!(
        comments["output"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["id"] == comment)
    );
    let before = f.documents();
    unavailable(f.invoke(&tools, &actor, "comment.delete", json!({"id":comment})));
    assert_eq!(f.documents(), before);
    assert!(
        f.ws.library()
            .settlements(Some("review-hidden-comment"), None)
            .unwrap()
            .is_empty()
    );

    // Restoring the endpoint makes the original edge visible again. This
    // would fail if deleting the comment had run F3's hidden purge_fallout.
    f.author("entry.restore", json!({"book":f.book,"id":chapter}));
    let restored = f.author("relation.list", json!({"book":f.book}));
    assert_eq!(
        restored
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["id"] == relation),
        Some(&original)
    );
    assert!(
        f.author("comment.list", json!({"book":f.book}))
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["id"] == comment)
    );
}

#[test]
fn entry_creation_rejects_the_old_revision_before_creating_anything() {
    let f = Fixture::new();
    let tools = AgentTools::new();
    let actor = Actor::agent("review-entry-revision", 1, "create");
    let descriptor = tools.catalog().descriptor("entry.create").unwrap();
    assert_ne!(descriptor.revision, PRE_NARRATIVE_ORDER_REVISION);
    let parent = dr_testkit::seed::acceptance::novel_root(&f.ws, &f.book, "tpl-manuscript");
    f.invoke(&tools, &actor, "entry.get", json!({"id":parent}))
        .unwrap();
    let args = json!({"parent":parent,"template":"tpl-chapter","title":f.text,"bodies":{"mod-prose":f.text}});
    let before = f.documents();
    let mut old = request("entry.create", args.clone());
    old.revision = Some(PRE_NARRATIVE_ORDER_REVISION.into());
    assert!(
        matches!(tools.invoke(&f.ws,&f.book,&actor,old),Err(Error::Invalid(message)) if message=="tool definition changed; search it again")
    );
    assert_eq!(f.documents(), before);
    assert!(
        f.ws.library()
            .settlements(Some("review-entry-revision"), None)
            .unwrap()
            .is_empty()
    );
    let mut current = request("entry.create", args);
    current.revision = Some(descriptor.revision);
    let made = tools.invoke(&f.ws, &f.book, &actor, current).unwrap();
    assert_eq!(
        f.author(
            "entry.get",
            json!({"book":f.book,"id":made["output"]["id"]})
        )["title"],
        f.text
    );
    assert!(
        !f.ws
            .library()
            .settlements(Some("review-entry-revision"), None)
            .unwrap()
            .is_empty()
    );
}
