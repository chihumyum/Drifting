//! K6 structure context uses only synthetic v3 books and recorded driver events.
use std::sync::Arc;

use dr_agent::driver::scripted::{ScriptedDriver, Step};
use dr_agent::{
    DriverEvent, FinishReason, Options, Provider, RunConfig, Runtime, Start, State, ToolExecutor,
};
use dr_agent_tools::{AgentTools, CallRequest, Error, FocusRequest, StructureContext};
use dr_doc::v3::novel::{MOD_PROSE, TPL_CHAPTER};
use dr_model::id::{BookId, ConversationId};
use dr_testkit::seed::{self, Preset};
use dr_workspace::{Actor, Workspace};
use serde_json::{Value, json};

struct Fixture {
    ws: Workspace,
    book: BookId,
    entry: String,
    doc: String,
    _dir: Arc<tempfile::TempDir>,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::open_dir(dir.path(), "k6-structure").unwrap();
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
        let doc = format!("body:{entry}/{MOD_PROSE}");
        seeded.write_to(ws.library()).unwrap();
        Self {
            ws,
            book,
            entry,
            doc,
            _dir: Arc::new(dir),
        }
    }
    fn out(&self, name: &str, args: Value) -> Value {
        self.ws.call(&Actor::User, name, args).unwrap()["output"].clone()
    }
    fn templates(&self) -> Vec<Value> {
        self.out("entry_template.list", json!({"book":self.book}))
            .as_array()
            .unwrap()
            .clone()
    }
    fn chapter(&self) -> Value {
        self.templates()
            .into_iter()
            .find(|t| t["id"] == TPL_CHAPTER)
            .unwrap()
    }
    fn put(&self, template: Value) {
        self.out(
            "entry_template.put",
            json!({"book":self.book,"template":template}),
        );
    }
    fn context(&self) -> StructureContext {
        StructureContext::for_book(
            &self.ws,
            &self.book,
            Some(&FocusRequest {
                entry: Some(self.entry.clone()),
                timeline_view: None,
            }),
        )
        .unwrap()
        .unwrap()
    }
    fn invoke(&self, tools: &AgentTools, name: &str, args: Value) -> dr_agent_tools::Result<Value> {
        tools.invoke(
            &self.ws,
            &self.book,
            &Actor::agent("structure-reader", 1, name),
            CallRequest {
                name: name.into(),
                arguments: args,
                revision: None,
                edited_text: None,
            },
        )
    }
    fn start(&self) -> Start {
        let mut config = RunConfig::new(Provider::Openai, "synthetic-model");
        config.capabilities = Some(dr_agent::ModelCapabilities {
            context_window: Some(128_000),
            ..Default::default()
        });
        Start {
            config,
            book: self.book.clone(),
            conversation: ConversationId::new_v7(),
            input: "Inspect this synthetic project.".into(),
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.ws.close();
    }
}

#[test]
fn guidance_is_exact_book_data_and_only_effective_templates_are_loaded() {
    let f = Fixture::new();
    let mut template = f.chapter();
    let guidance = "Synthetic guidance\n\"quoted\" \\ data — H1/H2/H3";
    template["agent"]["instructions"] = json!(guidance);
    template["modules"][0]["agent"] =
        json!({"instructions":"Synthetic module guidance","writable":false,"read_tier":"summary"});
    f.put(template.clone());
    let mut unused = template;
    unused["id"] = json!("synthetic-unused");
    unused["name"] = json!("Unused synthetic template");
    unused["agent"]["instructions"] = json!("UNUSED_GUIDANCE");
    f.put(unused);
    let context = f.context();
    let chapter = context
        .templates
        .iter()
        .find(|t| t.id == TPL_CHAPTER)
        .unwrap();
    assert_eq!(chapter.agent.instructions, guidance);
    assert!(!context.templates.iter().any(|t| t.id == "synthetic-unused"));
    let module = &chapter.modules[0];
    assert!(!module.capabilities.writable);
    assert!(module.capabilities.write_tools.is_empty());
    let catalog = AgentTools::new().catalog_for_book(&f.ws, &f.book).unwrap();
    assert_eq!(context.catalog_revision, catalog.revision());
    for module in context.templates.iter().flat_map(|t| &t.modules) {
        for tool in module
            .capabilities
            .read_tools
            .iter()
            .chain(&module.capabilities.write_tools)
        {
            assert!(catalog.descriptor(tool).is_some(), "{tool}");
        }
    }
    let wire = context.to_contribution().unwrap();
    let roundtrip: StructureContext = serde_json::from_str(&wire.text).unwrap();
    assert_eq!(context, roundtrip);
    assert!(!wire.text.contains("UNUSED_GUIDANCE"));
    let before = context.structure_revision;
    let mut edited = f.chapter();
    edited["agent"] = json!({"name":"","description":"","instructions":""});
    f.put(edited);
    let after = f.context();
    assert_ne!(before, after.structure_revision);
    assert!(
        after
            .templates
            .iter()
            .find(|t| t.id == TPL_CHAPTER)
            .unwrap()
            .agent
            .instructions
            .is_empty()
    );
}

#[test]
fn empty_manuscript_keeps_default_guidance_and_level_sources_are_canonical() {
    let f = Fixture::new();
    let entries = f.out("entry.list", json!({"book":f.book,"all":true}));
    for entry in entries
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["template"] == TPL_CHAPTER)
    {
        f.out("entry.trash", json!({"book":f.book,"id":entry["id"]}));
    }
    let context = StructureContext::for_book(&f.ws, &f.book, None)
        .unwrap()
        .unwrap();
    assert!(context.templates.iter().any(|t| t.id == TPL_CHAPTER));
    for level in &context.levels {
        let canonical = f.out("level.get", json!({"book":f.book,"id":level.id}));
        assert_eq!(
            serde_json::to_value(&level.effective_settings.values).unwrap(),
            canonical["settings"]
        );
        if level.lane {
            assert_eq!(level.effective_settings.sources.accept, "lane_invariant");
        }
    }
}

#[test]
fn focus_retains_old_module_identity_and_rejects_missing_focus() {
    let f = Fixture::new();
    let before = f.context();
    assert_eq!(
        before.focus.as_ref().unwrap().entry.as_deref(),
        Some(f.entry.as_str())
    );
    f.out(
        "entry_template.remove_module",
        json!({"book":f.book,"template":TPL_CHAPTER,"module":MOD_PROSE}),
    );
    let context = f.context();
    let retained = context
        .focus
        .unwrap()
        .modules
        .into_iter()
        .find(|m| m.id == MOD_PROSE)
        .unwrap();
    assert!(retained.retained);
    assert_eq!(retained.prose_doc.as_deref(), Some(f.doc.as_str()));
    assert!(retained.document_revision.is_some());
    assert!(
        context
            .diagnostics
            .iter()
            .any(|d| d.kind == "retained_module" && d.module.as_deref() == Some(MOD_PROSE))
    );
    assert!(
        StructureContext::for_book(
            &f.ws,
            &f.book,
            Some(&FocusRequest {
                entry: Some("foreign-entry".into()),
                timeline_view: None
            })
        )
        .is_err()
    );
}

#[test]
fn structure_does_not_grant_or_refresh_prose_read_authority() {
    let f = Fixture::new();
    let tools = AgentTools::new();
    let paragraphs = f.out("prose.read", json!({"doc":f.doc,"limit":usize::MAX}));
    let paragraph = &paragraphs["paragraphs"][1];
    let change = json!({"doc":f.doc,"block_id":paragraph["block_id"],"find":paragraph["text"],"replace":"Synthetic revision"});
    tools.set_focus(
        "structure-reader",
        Some(FocusRequest {
            entry: Some(f.entry.clone()),
            timeline_view: None,
        }),
    );
    tools.context(&f.ws, &f.book, "structure-reader").unwrap();
    assert!(matches!(
        f.invoke(&tools, "prose.replace", change.clone()),
        Err(Error::ReadRequired(_))
    ));
    f.invoke(
        &tools,
        "prose.read",
        json!({"doc":f.doc,"offset":0,"limit":1}),
    )
    .unwrap();
    assert!(matches!(
        f.invoke(&tools, "prose.replace", change.clone()),
        Err(Error::ReadRequired(_))
    ));
    f.invoke(
        &tools,
        "prose.read",
        json!({"doc":f.doc,"limit":usize::MAX}),
    )
    .unwrap();
    f.out("prose.replace", change.clone());
    // Getting fresh structure references must not bless the stale prose read.
    tools.context(&f.ws, &f.book, "structure-reader").unwrap();
    assert!(matches!(
        f.invoke(&tools, "prose.replace", change),
        Err(Error::Conflict(_))
    ));
    tools.forget_session("structure-reader");
    let wire = tools.context(&f.ws, &f.book, "structure-reader").unwrap();
    let context: StructureContext = serde_json::from_str(&wire[0].text).unwrap();
    assert!(context.focus.is_none());
}

fn complete() -> Vec<Step> {
    vec![
        Step::Event(DriverEvent::TextDelta {
            index: 0,
            text: "Synthetic response".into(),
        }),
        Step::Event(DriverEvent::Finish(FinishReason::Complete)),
    ]
}

#[test]
fn recorded_runtime_refreshes_guidance_and_pauses_instead_of_truncating() {
    let f = Fixture::new();
    let driver = Arc::new(ScriptedDriver::new(vec![complete(), complete()]));
    let tools = Arc::new(AgentTools::new());
    let runtime = Runtime::new(f.ws.clone(), driver.clone(), tools, Options::default()).unwrap();
    assert_eq!(
        runtime.start(f.start()).unwrap().join().unwrap(),
        State::Completed
    );
    let mut template = f.chapter();
    template["agent"]["instructions"] = json!("CURRENT_SYNTHETIC_GUIDANCE");
    f.put(template.clone());
    assert_eq!(
        runtime.start(f.start()).unwrap().join().unwrap(),
        State::Completed
    );
    let requests = driver.requests();
    assert!(
        !serde_json::to_string(&requests[0].conversation)
            .unwrap()
            .contains("CURRENT_SYNTHETIC_GUIDANCE")
    );
    assert!(
        serde_json::to_string(&requests[1].conversation)
            .unwrap()
            .contains("CURRENT_SYNTHETIC_GUIDANCE")
    );
    template["agent"]["instructions"] = json!("Synthetic guidance ".repeat(50_000));
    f.put(template);
    assert_eq!(
        runtime.start(f.start()).unwrap().join().unwrap(),
        State::Checkpointed
    );
    assert_eq!(driver.requests().len(), 2);
}

#[test]
fn v2_books_receive_no_structure_context() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::open_dir(dir.path(), "k6-v2-context").unwrap();
    let seeded = seed::generate(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
    seeded.write_to(ws.library()).unwrap();
    assert!(
        AgentTools::new()
            .context(&ws, seeded.books[0].book_id(), "compatibility")
            .unwrap()
            .is_empty()
    );
    ws.close();
}

#[test]
fn novel_guidance_is_copied_once_and_clearing_it_survives_reopen() {
    let f = Fixture::new();
    let builtins = dr_doc::v3::novel::novel_project_templates();
    let manuscript = builtins
        .iter()
        .find(|t| t.id.as_str() == dr_doc::v3::novel::TPL_MANUSCRIPT)
        .unwrap();
    let guidance = &manuscript.agent.as_ref().unwrap().instructions;
    assert!(guidance.contains("书稿 / 章 / H1 / H2 / H3"));
    assert!(guidance.contains("仅在这种整理任务中不修改正文"));
    assert!(guidance.contains("不限制作者另行明确要求"));
    let initial = f.context();
    assert_eq!(
        initial
            .templates
            .iter()
            .find(|t| t.id == manuscript.id.as_str())
            .unwrap()
            .agent
            .instructions,
        *guidance
    );
    for mut template in f.templates() {
        template["agent"] = Value::Null;
        for module in template["modules"].as_array_mut().unwrap() {
            module["agent"] = Value::Null;
        }
        f.put(template);
    }
    let cleared = StructureContext::for_book(&f.ws, &f.book, None)
        .unwrap()
        .unwrap();
    assert_eq!(
        cleared.project_template_source.as_ref().unwrap().id,
        "builtin:novel"
    );
    assert!(
        cleared
            .templates
            .iter()
            .all(|t| t.agent.instructions.is_empty()
                && t.agent.description.is_empty()
                && t.modules.iter().all(|m| m.agent.instructions.is_empty()))
    );
    // Accessing current application defaults is not a template update action.
    assert!(!dr_doc::v3::novel::novel_project_templates().is_empty());
    f.ws.close();
    let directory = Arc::clone(&f._dir);
    let book = f.book.clone();
    drop(f);
    let reopened = Workspace::open_dir(directory.path(), "k6-structure-reopen").unwrap();
    assert_eq!(
        StructureContext::for_book(&reopened, &book, None)
            .unwrap()
            .unwrap(),
        cleared
    );
    reopened.close();
}
