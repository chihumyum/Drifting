//! Caller-supplied relation identities cannot turn creation into an unread edit.

use dr_agent_tools::{AgentTools, CallRequest, Error};
use dr_doc::book::BorrowedBook;
use dr_model::{book::Relation, id::BookId};
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
    types: Vec<Value>,
    _dir: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::open_dir(dir.path(), "m29-relation-identity-test").unwrap();
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
        let types = chapters[..2]
            .iter()
            .map(|chapter| {
                author(
                    &ws,
                    "relation_type.create",
                    json!({
                        "book":book,
                        "name":chapter["title"],
                        "source_role":chapter["title"],
                        "target_role":elements[0]["name"],
                        "source_kinds":["node"],
                        "target_kinds":["element"]
                    }),
                )["id"]
                    .clone()
            })
            .collect();
        Self {
            ws,
            book,
            chapters,
            elements,
            types,
            _dir: dir,
        }
    }

    fn relation(&self, index: usize) -> Value {
        json!({
            "book":self.book,
            "from":{"kind":"node","id":self.chapters[index]["id"]},
            "to":{"kind":"element","id":self.elements[index]["id"]},
            "relation_type":self.types[index]
        })
    }

    fn invoke(
        &self,
        tools: &AgentTools,
        actor: &Actor,
        name: &str,
        arguments: Value,
    ) -> dr_agent_tools::Result<Value> {
        tools.invoke(
            &self.ws,
            &self.book,
            actor,
            CallRequest {
                name: name.into(),
                arguments,
                revision: None,
                edited_text: None,
            },
        )
    }

    fn stored_relations(&self) -> Vec<Relation> {
        let book = self.book.clone();
        self.ws
            .library()
            .open_doc(&format!("book:{book}"), OpenDoc::Existing)
            .unwrap()
            .read(move |doc| {
                BorrowedBook::new(doc, &book)
                    .unwrap()
                    .view()
                    .relations_raw()
            })
            .unwrap()
    }

    fn book_bytes(&self) -> Vec<u8> {
        self.ws
            .library()
            .open_doc(&format!("book:{}", self.book), OpenDoc::Existing)
            .unwrap()
            .read(|doc| doc.export(ExportMode::all_updates()).unwrap())
            .unwrap()
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

fn assert_id_rejected(result: dr_agent_tools::Result<Value>) {
    assert!(
        matches!(&result, Err(Error::Invalid(message)) if message == "relation.create assigns its own id; omit id"),
        "{result:?}"
    );
}

#[test]
fn a_visible_relation_list_cannot_authorize_overwriting_a_hidden_relation_id() {
    let f = Fixture::new();
    let made = author(&f.ws, "relation.create", f.relation(0));
    assert_eq!(made["existing"], false);
    let id = made["id"].as_str().unwrap();
    let original = f
        .stored_relations()
        .into_iter()
        .find(|relation| relation.id.as_str() == id)
        .unwrap();
    author(
        &f.ws,
        "chapter.trash",
        json!({"book":f.book,"id":f.chapters[0]["id"]}),
    );

    let tools = AgentTools::new();
    let actor = Actor::agent("hidden-relation", 1, "overwrite");
    // Fixture setup and raw-state inspection are author reads. This is the
    // only successful read that establishes coverage for the new Agent turn.
    let listed = f
        .invoke(&tools, &actor, "relation.list", json!({}))
        .unwrap();
    assert!(
        listed["output"]
            .as_array()
            .unwrap()
            .iter()
            .all(|relation| relation["id"] != made["id"])
    );
    let before = f.book_bytes();
    let receipts = f.ws.library().settlements(None, None).unwrap();
    let mut replacement = f.relation(1);
    replacement["id"] = made["id"].clone();
    assert_ne!(replacement["from"]["id"], original.from.id);
    assert_ne!(replacement["to"]["id"], original.to.id);
    assert_ne!(
        replacement["relation_type"],
        original.relation_type.as_str()
    );
    assert_id_rejected(f.invoke(&tools, &actor, "relation.create", replacement));

    let retained = f
        .stored_relations()
        .into_iter()
        .find(|relation| relation.id.as_str() == id)
        .unwrap();
    assert_eq!(
        retained, original,
        "hidden endpoints and type are immutable"
    );
    assert_eq!(f.book_bytes(), before);
    assert_eq!(
        f.ws.library().settlements(None, None).unwrap().len(),
        receipts.len()
    );

    // Refusing the supplied id does not consume the successful read, and an
    // ordinary creation still receives a fresh identity from F3.
    let created = f
        .invoke(&tools, &actor, "relation.create", f.relation(1))
        .unwrap();
    assert_eq!(created["output"]["existing"], false);
    assert_ne!(created["output"]["id"], made["id"]);
    let stored = f.stored_relations();
    assert!(stored.contains(&original));
    let new_id = created["output"]["id"].as_str().unwrap();
    let new_relation = stored
        .iter()
        .find(|relation| relation.id.as_str() == new_id)
        .unwrap();
    assert_eq!(new_relation.from.id, f.chapters[1]["id"]);
    assert_eq!(new_relation.to.id, f.elements[1]["id"]);
    assert_eq!(new_relation.relation_type.as_str(), f.types[1]);
    assert_eq!(
        f.ws.library().settlements(None, None).unwrap().len(),
        receipts.len() + 1
    );
}

#[test]
fn relation_create_rejects_any_supplied_identity_even_if_unused_or_null() {
    let f = Fixture::new();
    let tools = AgentTools::new();
    let actor = Actor::agent("new-relation-id", 1, "create");
    f.invoke(&tools, &actor, "relation.list", json!({}))
        .unwrap();
    let before = f.book_bytes();
    let receipts = f.ws.library().settlements(None, None).unwrap().len();
    for id in [
        json!(dr_model::id::RelationId::new_v7()),
        json!(""),
        Value::Null,
    ] {
        let mut input = f.relation(0);
        input["id"] = id;
        assert_id_rejected(f.invoke(&tools, &actor, "relation.create", input));
    }
    assert_eq!(f.book_bytes(), before);
    assert_eq!(
        f.ws.library().settlements(None, None).unwrap().len(),
        receipts
    );
}
