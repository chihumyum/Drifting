//! Complete pre-write checkpoints through the real facade and v3 testkit seed.
use dr_agent_tools::{AgentTools, CallRequest, Error};
use dr_doc::v3::novel::{MOD_PROSE, TPL_CHAPTER};
use dr_model::id::BookId;
use dr_store::Library;
use dr_testkit::seed::{self, Preset};
use dr_workspace::{
    Actor, Faults, Workspace, WorkspaceOptions, WritePreconditions, library_options,
};
use serde_json::{Value, json};
use std::sync::Arc;

struct Fixture {
    ws: Workspace,
    tools: AgentTools,
    book: BookId,
    entry: String,
    faults: Arc<Faults>,
    _dir: tempfile::TempDir,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open(dir.path(), library_options("k6-entry-checkpoints")).unwrap();
        let seeded = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        let book = seeded.books[0].book_id().clone();
        let entry = seeded.books[0]
            .book
            .view()
            .entries()
            .into_iter()
            .find(|e| {
                e.template
                    .as_ref()
                    .is_some_and(|t| t.as_str() == TPL_CHAPTER)
            })
            .unwrap()
            .id
            .to_string();
        seeded.write_to(&lib).unwrap();
        let faults = Arc::new(Faults::default());
        let ws = Workspace::open(
            lib,
            WorkspaceOptions {
                faults: Some(faults.clone()),
                ..Default::default()
            },
        )
        .unwrap();
        ws.set_auto_links(false);
        Self {
            ws,
            tools: AgentTools::new(),
            book,
            entry,
            faults,
            _dir: dir,
        }
    }
    fn call(&self, turn: u32, name: &str, args: Value) -> dr_agent_tools::Result<Value> {
        self.tools
            .invoke(
                &self.ws,
                &self.book,
                &Actor::agent("checkpoints", turn, name),
                CallRequest {
                    name: name.into(),
                    arguments: args,
                    revision: None,
                    edited_text: None,
                },
            )
            .map(|v| v["output"].clone())
    }
    fn author(&self, name: &str, mut args: Value) -> Value {
        if args.get("doc").is_none() {
            args["book"] = json!(self.book);
        }
        self.ws.call(&Actor::User, name, args).unwrap()["output"].clone()
    }
    fn points(&self) -> Value {
        self.author("entry_snapshot.list", json!({"entry":self.entry}))
    }
    fn body(&self) -> String {
        format!("body:{}/{}", self.entry, MOD_PROSE)
    }
    fn state(&self) -> Value {
        let docs = [format!("book:{}", self.book), self.body()];
        json!({"docs": docs.iter().map(|d| serde_json::to_value(self.ws.observe(d).unwrap()).unwrap()).collect::<Vec<_>>(),
            "journal":self.ws.journal(None,1000).unwrap().len(),
            "settlements":self.ws.library().settlements(Some("checkpoints"),None).unwrap().len()})
    }
    fn read_entry(&self, turn: u32) {
        self.call(turn, "entry.get", json!({"id":self.entry}))
            .unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.ws.close();
    }
}

#[test]
fn first_successful_write_per_turn_captures_all_retained_bodies_and_restores_them() {
    let f = Fixture::new();
    let before = f.author("entry.get", json!({"id":f.entry}));
    f.author("entry_template.put_module",json!({"template":TPL_CHAPTER,"module":{"id":"retained-body","kind":"prose","name":"Retained body"}}));
    // A second body uses seed prose, then becomes retained when the module is removed.
    let original = f.author(
        "module.read_prose",
        json!({"owner":f.entry,"module":MOD_PROSE}),
    );
    let paragraphs: Vec<_> = original["paragraphs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| json!({"text":p["text"]}))
        .collect();
    f.author(
        "module.set_prose",
        json!({"owner":f.entry,"module":"retained-body","paragraphs":paragraphs}),
    );
    f.author(
        "entry_template.remove_module",
        json!({"template":TPL_CHAPTER,"module":"retained-body"}),
    );
    let retained = format!("body:{}/retained-body", f.entry);
    let retained_before = f.ws.observe(&retained).unwrap();
    f.read_entry(1);
    f.call(
        1,
        "entry.update",
        json!({"id":f.entry,"title":"Agent title"}),
    )
    .unwrap();
    let points = f.points();
    assert_eq!(points.as_array().unwrap().len(), 1);
    let point = points[0]["id"].clone();
    assert!(points[0]["bodies"].get(&retained).is_some());
    assert_ne!(
        points[0]["book_version"],
        f.ws.observe(&format!("book:{}", f.book)).unwrap().version
    );
    let prose = f
        .call(
            1,
            "module.read_prose",
            json!({"owner":f.entry,"module":MOD_PROSE}),
        )
        .unwrap();
    let p = &prose["paragraphs"][0];
    f.call(1,"module.replace_prose",json!({"owner":f.entry,"module":MOD_PROSE,"block_id":p["block_id"],"find":p["text"],"replace":"Agent revision"})).unwrap();
    assert_eq!(f.points().as_array().unwrap().len(), 1);
    assert_eq!(
        f.ws.observe(&retained).unwrap().version,
        retained_before.version
    );
    let preview = f.author(
        "entry_snapshot.preview",
        json!({"entry":f.entry,"point":point}),
    );
    f.author(
        "entry_snapshot.restore",
        json!({"entry":f.entry,"point":point,"expected":preview["expected"]}),
    );
    assert_eq!(
        f.author("entry.get", json!({"id":f.entry}))["title"],
        before["title"]
    );
    assert_eq!(
        f.author(
            "module.read_prose",
            json!({"owner":f.entry,"module":MOD_PROSE})
        )["paragraphs"],
        original["paragraphs"]
    );
    f.read_entry(2);
    let n = f.points().as_array().unwrap().len();
    f.call(2, "entry.update", json!({"id":f.entry,"title":"Next turn"}))
        .unwrap();
    assert_eq!(f.points().as_array().unwrap().len(), n + 1);
    for spec in dr_workspace::registry()
        .iter()
        .filter(|s| s.name.starts_with("entry_snapshot."))
    {
        assert!(
            f.tools
                .catalog_for_book(&f.ws, &f.book)
                .unwrap()
                .descriptor(spec.name)
                .is_none()
        );
        assert!(matches!(
            f.call(2, spec.name, json!({"entry":f.entry})),
            Err(Error::Invalid(_))
        ));
    }
}

#[test]
fn unread_stale_and_failed_checkpoints_leave_no_write_or_receipts() {
    let f = Fixture::new();
    let before = f.state();
    assert!(matches!(
        f.call(1, "entry.update", json!({"id":f.entry,"title":"unread"})),
        Err(Error::ReadRequired(_))
    ));
    assert_eq!(f.state(), before);
    f.read_entry(1);
    f.author("entry.update", json!({"id":f.entry,"title":"Author wins"}));
    let before = f.state();
    assert!(matches!(
        f.call(1, "entry.update", json!({"id":f.entry,"title":"stale"})),
        Err(Error::Conflict(_))
    ));
    assert_eq!(f.state(), before);
    f.author("entry_template.put_module",json!({"template":TPL_CHAPTER,"module":{"id":"unwritten-body","kind":"prose","name":"Unwritten seed body"}}));
    let unwritten = format!("body:{}/unwritten-body", f.entry);
    assert!(f.ws.library().doc_info(&unwritten).unwrap().is_none());
    let before = f.state();
    f.read_entry(2);
    f.faults.arm("snapshot_create_after_manifest");
    assert!(
        f.call(2, "entry.update", json!({"id":f.entry,"title":"failed"}))
            .is_err()
    );
    assert_eq!(f.state(), before);
    assert!(f.points().as_array().unwrap().is_empty());
    assert!(f.ws.library().doc_info(&unwritten).unwrap().is_none());
    f.read_entry(2);
    f.call(
        2,
        "entry.update",
        json!({"id":f.entry,"title":"Retry after reread"}),
    )
    .unwrap();
    assert_eq!(f.points().as_array().unwrap().len(), 1);
}

#[test]
fn checkpoint_receipt_is_exact_and_does_not_rebase_an_intervening_author_write() {
    let f = Fixture::new();
    let book = format!("book:{}", f.book);
    let old = f.ws.observe(&book).unwrap();
    let guards = WritePreconditions {
        versions: [(book.clone(), old.version.clone())].into(),
        records: Vec::new(),
        require_all: false,
    };
    let receipt =
        f.ws.call_guarded(
            &Actor::agent("checkpoints", 1, "capture"),
            "entry_snapshot.create_with_receipt",
            json!({"book":f.book,"entry":f.entry}),
            guards,
        )
        .unwrap()["output"]
            .clone();
    assert_eq!(receipt["point"]["book_version"], old.version);
    assert_eq!(
        receipt["versions"][&book],
        f.ws.observe(&book).unwrap().version
    );
    f.author(
        "entry.update",
        json!({"id":f.entry,"title":"Author after checkpoint"}),
    );
    let before = f.state();
    let versions = serde_json::from_value(receipt["versions"].clone()).unwrap();
    assert!(
        f.ws.call_guarded(
            &Actor::agent("checkpoints", 1, "write"),
            "entry.update",
            json!({"book":f.book,"id":f.entry,"title":"Must conflict"}),
            WritePreconditions {
                versions,
                records: Vec::new(),
                require_all: true
            }
        )
        .is_err()
    );
    assert_eq!(f.state(), before);
    assert!(
        f.ws.library()
            .settlements(Some("checkpoints"), None)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn partial_read_cannot_gain_more_prose_coverage_from_a_complete_checkpoint() {
    let f = Fixture::new();
    let full = f.author("prose.read", json!({"doc":f.body(),"limit":100}));
    assert!(full["paragraphs"].as_array().unwrap().len() > 1);
    let part = f
        .call(1, "prose.read", json!({"doc":f.body(),"limit":1}))
        .unwrap();
    let p = &part["paragraphs"][0];
    f.call(1,"prose.replace",json!({"doc":f.body(),"block_id":p["block_id"],"find":p["text"],"replace":"Read paragraph revision"})).unwrap();
    assert_eq!(f.points().as_array().unwrap().len(), 1);
    f.call(1, "prose.read", json!({"doc":f.body(),"limit":1}))
        .unwrap();
    let before = f.state();
    let unseen = &full["paragraphs"][1];
    assert!(matches!(f.call(1,"prose.replace",json!({"doc":f.body(),"block_id":unseen["block_id"],"find":unseen["text"],"replace":"unseen"})),Err(Error::ReadRequired(_))));
    assert_eq!(f.state(), before);
}

#[test]
fn agent_checkpoint_with_unrestorable_future_tree_refuses_restore_without_losing_current_values() {
    let f = Fixture::new();
    let h =
        f.ws.library()
            .open_doc(&f.body(), dr_store::OpenDoc::Existing)
            .unwrap();
    h.write(dr_store::Origin::User, |d| {
        let future = d.get_map("future-checkpoint");
        let tree = future
            .insert_container("tree", loro::LoroTree::new())
            .unwrap();
        let node = tree.create(None).unwrap();
        tree.get_meta(node)
            .unwrap()
            .insert("author", "Synthetic future metadata")
            .unwrap();
        future.insert("node_ref", node.to_string()).unwrap();
    })
    .unwrap();
    f.read_entry(1);
    f.call(
        1,
        "entry.update",
        json!({"id":f.entry,"title":"Agent after checkpoint"}),
    )
    .unwrap();
    let point = f.points()[0]["id"].clone();
    h.write(dr_store::Origin::User, |d| {
        let future = d.get_map("future-checkpoint");
        future.delete("tree").unwrap();
        future.insert("author-current", "Keep this value").unwrap();
    })
    .unwrap();
    let preview = f.author(
        "entry_snapshot.preview",
        json!({"entry":f.entry,"point":point}),
    );
    let before = f.state();
    let points = f.points();
    let raw =
        dr_doc::v3::raw_document_state(&f.ws.library().load_copy(&f.body()).unwrap()).unwrap();
    let result = f.ws.call(
        &Actor::User,
        "entry_snapshot.restore",
        json!({"book":f.book,"entry":f.entry,"point":point,"expected":preview["expected"]}),
    );
    assert!(
        matches!(result,Err(dr_workspace::WsError::Invalid(message)) if message.contains("container identities"))
    );
    assert_eq!(f.state(), before);
    assert_eq!(f.points(), points);
    assert_eq!(
        dr_doc::v3::raw_document_state(&f.ws.library().load_copy(&f.body()).unwrap()).unwrap(),
        raw
    );
}
