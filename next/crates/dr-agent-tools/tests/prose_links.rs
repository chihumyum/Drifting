//! The Agent's `prose.link` (`kernel-v5.md` §16 「自动链接」): the link it
//! puts on an entry is the author's kind (`manual`), and the undo its result
//! carries — what the conversation keeps of the call — replays as it stands,
//! putting back what was there; replaying what that run says to undo puts
//! the link on again. The undo itself (`prose.restore_links`) is no tool.
use dr_agent_tools::catalog::Catalog;
use dr_agent_tools::{AgentTools, CallRequest};
use dr_doc::v3::novel::{MOD_PROSE, TPL_CHAPTER};
use dr_model::id::BookId;
use dr_store::Library;
use dr_testkit::seed::{self, Preset};
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use serde_json::{Value, json};

struct Fixture {
    ws: Workspace,
    tools: AgentTools,
    book: BookId,
    chapter: String,
    target: String,
    _dir: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open(dir.path(), library_options("ap-prose-links")).unwrap();
        let seeded = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        let book = seeded.books[0].book_id().clone();
        let entries = seeded.books[0].book.view().entries();
        let chapter = entries
            .iter()
            .find(|e| {
                e.template
                    .as_ref()
                    .is_some_and(|t| t.as_str() == TPL_CHAPTER)
            })
            .unwrap()
            .id
            .to_string();
        // An entry whose own 「自动链接」 is off: its automatic links read
        // as text, the ones made by hand do not.
        let target = entries
            .iter()
            .find(|e| e.id.as_str() != chapter && !e.auto_link && e.deleted_at.is_none())
            .unwrap()
            .id
            .to_string();
        seeded.write_to(&lib).unwrap();
        let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
        Self {
            ws,
            tools: AgentTools::new(),
            book,
            chapter,
            target,
            _dir: dir,
        }
    }

    fn actor() -> Actor {
        Actor::agent("ap-links", 1, "c")
    }

    fn invoke(&self, name: &str, arguments: Value) -> dr_agent_tools::Result<Value> {
        self.tools.invoke(
            &self.ws,
            &self.book,
            &Self::actor(),
            CallRequest {
                name: name.into(),
                arguments,
                revision: None,
                edited_text: None,
            },
        )
    }

    fn doc(&self) -> String {
        format!("body:{}/{MOD_PROSE}", self.chapter)
    }

    /// The body's whole stored state, every mark with its value.
    fn stored(&self) -> (loro::LoroValue, Vec<loro::TextDelta>) {
        let d = self.ws.library().load_copy(&self.doc()).unwrap();
        (
            d.get_deep_value(),
            d.get_text(dr_doc::schema::prose::BODY).to_delta(),
        )
    }

    /// The first two characters of the first paragraph with words, anchored.
    fn anchor(&self) -> (std::ops::Range<usize>, Value) {
        let session = self.ws.prose_session(&self.doc()).unwrap();
        let reader = session.reader();
        let view = reader.view();
        let p = view
            .paragraphs()
            .find(|p| p.text().chars().count() >= 2)
            .unwrap();
        let range = p.range.start..p.range.start + 2;
        let a = view.anchor(range.clone()).unwrap();
        (
            range,
            serde_json::to_value(dr_workspace::dto::AnchorBytes::from(&a.encode())).unwrap(),
        )
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.ws.close();
    }
}

#[test]
fn the_agents_link_is_made_by_hand_and_the_undo_in_its_result_replays() {
    let f = Fixture::new();
    let (range, anchor) = f.anchor();
    let before = f.stored();
    f.invoke("prose.read", json!({"doc": f.doc(), "limit": 10_000}))
        .unwrap();
    let result = f
        .invoke(
            "prose.link",
            json!({"links": [{"doc": f.doc(), "target": {"kind": "entry", "id": f.target}, "anchors": [anchor]}]}),
        )
        .unwrap();
    assert_eq!(result["output"]["ranges"], 1, "{result}");
    let after = f.stored();
    let session = f.ws.prose_session(&f.doc()).unwrap();
    let picked = dr_doc::prose::v3::encode_entity_link(
        &dr_model::v3::EntityLinkV3 {
            target: f.target.clone(),
            kind: dr_model::kind::EntityKind::Entry,
            module: None,
            block: None,
            end_block: None,
            manual: true,
        },
        None,
    )
    .unwrap();
    assert_eq!(
        session
            .reader()
            .view()
            .entity_link_values(range.clone(), &f.target)
            .unwrap(),
        vec![(range.clone(), Some(picked))]
    );

    // The undo, kept as JSON text the way the conversation keeps the result.
    let kept: Value = serde_json::from_str(&result["undo"].to_string()).unwrap();
    let undo = kept.as_array().unwrap();
    assert_eq!(undo.len(), 1, "{kept}");
    assert_eq!(undo[0]["command"], "prose.restore_links");
    let undone =
        f.ws.call(
            &Fixture::actor(),
            undo[0]["command"].as_str().unwrap(),
            undo[0]["input"].clone(),
        )
        .unwrap();
    assert_eq!(f.stored(), before);
    let redo = &undone["undo"][0];
    f.ws.call(
        &Fixture::actor(),
        redo["command"].as_str().unwrap(),
        redo["input"].clone(),
    )
    .unwrap();
    assert_eq!(f.stored(), after);

    // The undo is the workspace's, not a tool of the Agent's (nor MCP's).
    let catalog = Catalog::new();
    assert!(catalog.descriptor("prose.restore_links").is_none());
    assert!(
        catalog
            .exclusions()
            .iter()
            .any(|(name, _)| name == "prose.restore_links")
    );
    assert!(
        f.invoke("prose.restore_links", undo[0]["input"].clone())
            .is_err()
    );
    assert_eq!(f.stored(), after);
}
