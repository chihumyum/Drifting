//! Review regressions exercise the public facade against real F3 data. All
//! authored text comes from the shared tiny seed; automatic links stay on.

use std::collections::BTreeMap;

use dr_agent_tools::{AgentTools, CallRequest, Error, catalog::Search};
use dr_model::id::BookId;
use dr_testkit::seed::{self, Preset};
use dr_workspace::{Actor, Workspace, registry};
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
        let seeded = seed::generate(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
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
    for (index, read) in ["prose.shape", "prose.read"].into_iter().enumerate() {
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
    let chapter = f.author("chapter.list", json!({"book":f.book}))[0]["id"].clone();
    let comment = f.author("comment.create", json!({"book":f.book,"body":f.text}))["id"].clone();
    let relation = f.author(
        "relation.create",
        json!({"book":f.book,"from":{"kind":"comment","id":comment},"to":{"kind":"node","id":chapter}}),
    )["id"]
        .clone();
    let visible = f.author("relation.list", json!({"book":f.book}));
    let original = visible
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == relation)
        .unwrap()
        .clone();
    f.author("chapter.trash", json!({"book":f.book,"id":chapter}));
    assert!(
        f.author("relation.list", json!({"book":f.book}))
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["id"] != relation)
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
    f.author("chapter.restore", json!({"book":f.book,"id":chapter}));
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
fn new_idea_conversions_stay_unavailable_even_after_source_reads() {
    let f = Fixture::new();
    let tools = AgentTools::new();
    let actor = Actor::agent("review-idea-conversions", 1, "convert");
    let ideas = f.invoke(&tools, &actor, "idea.list", json!({})).unwrap();
    let idea = ideas["output"][0]["id"].clone();
    assert!(idea.is_string());
    f.invoke(
        &tools,
        &actor,
        "prose.read",
        json!({"doc":format!("node:{}",idea.as_str().unwrap()),"limit":usize::MAX}),
    )
    .unwrap();
    let before = f.documents();
    for name in ["idea.to_chapter", "idea.to_element"] {
        assert!(
            registry().get(name).is_some(),
            "the F3 owner already registered {name}"
        );
        assert!(tools.catalog().descriptor(name).is_none());
        assert!(
            tools
                .catalog()
                .exclusions()
                .iter()
                .any(|(excluded, _)| excluded == name)
        );
        let search = tools.catalog().search(Search {
            query: name.into(),
            ..Search::default()
        });
        assert_eq!(search["total"], 0);
        unavailable(f.invoke(&tools, &actor, name, json!({"id":idea})));
        assert_eq!(
            f.documents(),
            before,
            "{name} changed a document or created an orphan"
        );
    }
    assert!(
        f.ws.library()
            .settlements(Some("review-idea-conversions"), None)
            .unwrap()
            .is_empty()
    );
    assert!(
        f.ws.auto_links(),
        "exclusion must not depend on disabling automatic links"
    );
}

#[test]
fn chapter_creation_rejects_the_old_revision_before_creating_anything() {
    let f = Fixture::new();
    let tools = AgentTools::new();
    let actor = Actor::agent("review-chapter-revision", 1, "create");
    let descriptor = tools.catalog().descriptor("chapter.create").unwrap();
    assert_ne!(descriptor.revision, PRE_NARRATIVE_ORDER_REVISION);
    assert!(
        descriptor.input_schema["properties"]
            .get("narrative_order")
            .is_some()
    );
    let chapters = f.invoke(&tools, &actor, "chapter.list", json!({})).unwrap();
    let arguments = json!({"title":f.text,"text":f.text,"narrative_order":37.5});
    let before = f.documents();
    let mut old = request("chapter.create", arguments.clone());
    old.revision = Some(PRE_NARRATIVE_ORDER_REVISION.into());
    assert!(matches!(
        tools.invoke(&f.ws, &f.book, &actor, old),
        Err(Error::Invalid(message)) if message == "tool definition changed; search it again"
    ));
    assert_eq!(
        f.documents(),
        before,
        "the old schema must not create even the fresh prose document"
    );
    assert!(
        f.ws.library()
            .settlements(Some("review-chapter-revision"), None)
            .unwrap()
            .is_empty()
    );

    let mut current = request("chapter.create", arguments);
    current.revision = Some(descriptor.revision);
    let made = tools.invoke(&f.ws, &f.book, &actor, current).unwrap();
    let after = f.author("chapter.list", json!({"book":f.book}));
    assert_eq!(
        after.as_array().unwrap().len(),
        chapters["output"].as_array().unwrap().len() + 1
    );
    let created = after
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == made["output"]["id"])
        .unwrap();
    assert_eq!(created["narrative_order"], 37.5);
    assert!(
        !f.ws
            .library()
            .settlements(Some("review-chapter-revision"), None)
            .unwrap()
            .is_empty()
    );
}
