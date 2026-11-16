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
        let canonical = f.out("entry.get", json!({"book":f.book,"id":level.id}));
        assert_eq!(
            serde_json::to_value(&level.effective_settings.values).unwrap(),
            canonical["below"]["settings"]
        );
        let batch = f.out("entry.list", json!({"book":f.book,"all":true,"below":true}));
        let resolved = batch
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["id"] == level.id)
            .unwrap();
        assert_eq!(
            serde_json::to_value(&level.effective_settings.sources).unwrap(),
            resolved["below"]["sources"],
        );
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
    let id = dr_testkit::seed::acceptance::empty_source(ws.library());
    let book = BookId::parse(&id).unwrap();
    assert!(
        AgentTools::new()
            .context(&ws, &book, "compatibility")
            .is_err()
    );
    ws.close();
}

#[test]
fn novel_guidance_is_copied_once_and_clearing_it_survives_reopen() {
    let f = Fixture::new();
    let project_agent = dr_doc::v3::novel::novel_project_agent();
    let guidance = &project_agent.instructions;
    assert!(guidance.contains("书稿 / 章 / H1 / H2 / H3"));
    assert!(guidance.contains("仅在这种整理任务中不修改正文"));
    assert!(guidance.contains("不限制作者另行明确要求"));
    let initial_project =
        f.ws.call(&Actor::User, "project.get", json!({"book": f.book}))
            .unwrap()["output"]
            .clone();
    assert_eq!(initial_project["agent"]["instructions"], *guidance);

    let builtins = dr_doc::v3::novel::novel_project_templates();
    let manuscript = builtins
        .iter()
        .find(|t| t.id.as_str() == dr_doc::v3::novel::TPL_MANUSCRIPT)
        .unwrap();
    let initial = f.context();
    // The Agent's context carries the project's guidance, copied once.
    assert_eq!(
        initial.project_agent.as_ref().unwrap().instructions,
        *guidance
    );
    assert_eq!(
        initial
            .templates
            .iter()
            .find(|t| t.id == manuscript.id.as_str())
            .unwrap()
            .agent
            .instructions,
        manuscript.agent.as_ref().unwrap().instructions
    );
    f.ws.call(
        &Actor::User,
        "project.update",
        json!({"book": f.book, "agent": null}),
    )
    .unwrap();
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
    // Clearing the guidance leaves where the project came from as it was.
    let project = f.out("project.get", json!({"book": f.book}));
    assert_eq!(project["source"]["id"], "builtin:novel");
    assert_eq!(
        serde_json::to_value(&cleared).unwrap()["project_source"],
        serde_json::to_value(&initial).unwrap()["project_source"]
    );
    assert!(cleared.project_agent.is_none());
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
    let reopened_project = reopened
        .call(&Actor::User, "project.get", json!({"book": book}))
        .unwrap()["output"]
        .clone();
    assert!(reopened_project["agent"].is_null());
    assert_eq!(
        StructureContext::for_book(&reopened, &book, None)
            .unwrap()
            .unwrap(),
        cleared
    );
    reopened.close();
}

/// The structure names the book format the book is in, and the project's
/// guidance follows `project.update` (its revision too).
#[test]
fn structure_names_the_book_format_and_follows_the_project_guidance() {
    let f = Fixture::new();
    let before = f.context();
    assert_eq!(before.schema_version, dr_doc::schema::BOOK_SCHEMA_VERSION);
    let parsed: Value = serde_json::from_str(&before.to_contribution().unwrap().text).unwrap();
    assert_eq!(parsed["schema_version"], 5);
    assert_eq!(
        parsed["project_agent"]["instructions"],
        dr_doc::v3::novel::novel_project_agent().instructions
    );
    f.out(
        "project.update",
        json!({"book": f.book, "agent": {"name": "合成项目", "description": "合成说明", "instructions": "先读目录。"}}),
    );
    let after = f.context();
    assert_eq!(
        after.project_agent,
        Some(dr_agent_tools::structure::TemplateAgentSummary {
            name: "合成项目".into(),
            description: "合成说明".into(),
            instructions: "先读目录。".into(),
        })
    );
    assert_ne!(after.structure_revision, before.structure_revision);
}

#[test]
fn draft_template_preview_uses_the_same_module_projection_without_read_coverage() {
    use dr_agent_tools::structure::TemplateSummary;
    let f = Fixture::new();
    let template: dr_model::v3::EntryTemplate = serde_json::from_value(f.chapter()).unwrap();
    let expected = f
        .context()
        .templates
        .into_iter()
        .find(|t| t.id == TPL_CHAPTER)
        .unwrap();
    let before = f.ws.observe(&format!("book:{}", f.book)).unwrap().version;
    let summary = TemplateSummary::from_v3_template(&template);
    assert_eq!(summary, expected);
    // An unused draft retains stable module ids, author labels and capability
    // fields; it does not need a book entry or a bound action to preview.
    let mut draft = template.clone();
    draft.id = "synthetic-unpublished-preview".parse().unwrap();
    draft.name = "Synthetic draft".into();
    draft.modules[0].name = "Draft module label".into();
    let projected = TemplateSummary::from_v3_template(&draft);
    assert_eq!(projected.id, draft.id.as_str());
    assert_eq!(projected.modules[0].id, expected.modules[0].id);
    assert_eq!(projected.modules[0].name, "Draft module label");
    assert_eq!(
        projected.modules[0].capabilities,
        expected.modules[0].capabilities
    );
    let wire = serde_json::to_value(&projected).unwrap();
    assert_eq!(
        serde_json::from_value::<TemplateSummary>(wire).unwrap(),
        projected
    );
    assert_eq!(
        f.ws.observe(&format!("book:{}", f.book)).unwrap().version,
        before
    );
    let tools = AgentTools::new();
    assert!(matches!(
        f.invoke(
            &tools,
            "entry.update",
            json!({"id":f.entry,"title":"unread"})
        ),
        Err(Error::ReadRequired(_))
    ));
}

#[test]
fn v4_book_structure_json_omits_kind_allow_and_about_and_projects_description_as_prose_module() {
    use dr_doc::v3::novel::{MOD_DESCRIPTION, TPL_MANUSCRIPT};

    let f = Fixture::new();
    let manuscript_id = f
        .out("entry.list", json!({"book": f.book}))
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["template"] == TPL_MANUSCRIPT)
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let context = StructureContext::for_book(
        &f.ws,
        &f.book,
        Some(&FocusRequest {
            entry: Some(manuscript_id.clone()),
            timeline_view: None,
        }),
    )
    .unwrap()
    .unwrap();
    let contribution = context.to_contribution().unwrap();
    let parsed: Value = serde_json::from_str(&contribution.text).unwrap();

    // Templates carry `level` and `linkable`; never `kind`, `allow`, or `lane`.
    let templates = parsed["templates"].as_array().unwrap();
    assert!(!templates.is_empty());
    for tpl in templates {
        let obj = tpl.as_object().unwrap();
        assert!(!obj.contains_key("kind"), "template still has kind: {tpl}");
        assert!(
            !obj.contains_key("allow"),
            "template still has allow: {tpl}"
        );
        assert!(!obj.contains_key("lane"), "template still has lane: {tpl}");
        assert!(obj.get("level").and_then(Value::as_bool).is_some());
        assert!(obj.get("linkable").and_then(Value::as_bool).is_some());
    }

    // Levels never expose `allow` or `about`.
    let levels = parsed["levels"].as_array().unwrap();
    assert!(!levels.is_empty());
    for lvl in levels {
        let obj = lvl.as_object().unwrap();
        assert!(!obj.contains_key("about"), "level still has about: {lvl}");
        let eff = lvl["effective_settings"].as_object().unwrap();
        assert!(
            !eff.contains_key("allow"),
            "effective_settings still has allow: {lvl}"
        );
        let sources = eff["sources"].as_object().unwrap();
        assert!(
            !sources.contains_key("allow"),
            "sources still has allow: {lvl}"
        );
    }

    // Recursive walk: no object key anywhere in BOOK_STRUCTURE.json is `allow` or `about`,
    // and no string value references `/about`.
    fn assert_no_retired_fields(v: &Value) {
        match v {
            Value::Object(map) => {
                for (k, child) in map {
                    assert_ne!(k, "allow", "unexpected `allow` key in BOOK_STRUCTURE.json");
                    assert_ne!(k, "about", "unexpected `about` key in BOOK_STRUCTURE.json");
                    assert_no_retired_fields(child);
                }
            }
            Value::Array(items) => {
                for item in items {
                    assert_no_retired_fields(item);
                }
            }
            Value::String(s) => {
                assert!(
                    !s.ends_with("/about"),
                    "unexpected `/about` doc id in BOOK_STRUCTURE.json: {s}"
                );
            }
            _ => {}
        }
    }
    assert_no_retired_fields(&parsed);

    // 「说明」(`mod-description`) appears as an ordinary `prose` module on `tpl-manuscript`
    // and in `focus.modules` on `书稿`.
    let manuscript_tpl = templates
        .iter()
        .find(|t| t["ref"] == TPL_MANUSCRIPT)
        .expect("manuscript template present");
    let desc_mod = manuscript_tpl["modules"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["ref"] == MOD_DESCRIPTION)
        .expect("mod-description projected on manuscript template");
    assert_eq!(desc_mod["kind"], "prose");
    assert_eq!(desc_mod["name"], "说明");
    assert!(
        desc_mod["capabilities"]["read_tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t == "module.read_prose")
    );

    let focus_desc = parsed["focus"]["modules"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["ref"] == MOD_DESCRIPTION)
        .expect("mod-description projected in manuscript focus");
    assert_eq!(focus_desc["kind"], "prose");
    assert_eq!(focus_desc["name"], "说明");
    assert_eq!(
        focus_desc["prose_doc"],
        format!("body:{manuscript_id}/{MOD_DESCRIPTION}")
    );
}

/// PT4 (`project-templates.md` §10 rule 4, §15): the structure carries where
/// the project came from, the project template's name and its credit and
/// nothing else of `project.source` (no 「改自」, id, version or origin);
/// nothing at all when the project has no named source. The book start and
/// the numbering DW took out do not come back with it.
#[test]
fn structure_names_the_project_source_by_template_name_and_credit_only() {
    let f = Fixture::new();
    let structure = |book: &str| -> Value {
        let book = BookId::parse(book).unwrap();
        let context = StructureContext::for_book(&f.ws, &book, None)
            .unwrap()
            .unwrap();
        serde_json::from_str(&context.to_contribution().unwrap().text).unwrap()
    };
    let id = |value: &Value| value["id"].as_str().unwrap().to_owned();

    // The seed records the built-in template by id alone: no source is shown.
    let seeded = structure(f.book.as_str());
    assert!(seeded.get("project_source").is_none(), "{seeded}");
    assert!(seeded.get("project_template_source").is_none(), "{seeded}");

    // Made from the built-in 「写书」: its name, crediting no one.
    let builtin = id(&f.out("project.create", json!({"name": "合成新项目"})));
    let from_builtin = structure(&builtin);
    assert_eq!(from_builtin["project_source"], json!({"template": "写书"}));

    // Made from a saved template that credits someone: its name and that credit.
    let saved = f.out(
        "project_template.save",
        json!({"book": f.book, "name": "合成模板", "credit": {"author": "合成署名"}}),
    );
    let made = id(&f.out(
        "project.create",
        json!({"name": "从合成模板建", "template_id": saved["id"]}),
    ));
    let raw = structure(&made);
    assert_eq!(
        raw["project_source"],
        json!({"template": "合成模板", "author": "合成署名"})
    );
    // The project keeps its whole source; the structure shows two things of it.
    let project = f.out("project.get", json!({"book": made}));
    assert_eq!(project["source"]["id"], saved["id"]);
    assert_eq!(project["source"]["origin"], "own");
    let text = raw.to_string();
    for absent in [
        saved["id"].as_str().unwrap(),
        "derivedFrom",
        "derived_from",
        "改自",
        "project_template_source",
    ] {
        assert!(!text.contains(absent), "{absent} in {text}");
    }
    // No book start and no numbering (DW, kernel-v5 §18).
    assert!(raw["project_book"].get("root").is_none(), "{raw}");
    assert!(raw["project_book"].get("root_valid").is_none(), "{raw}");
    for absent in [
        "\"ordinal\"",
        "\"number\"",
        "manuscript_number",
        "manuscript_roots",
        "book_root",
    ] {
        assert!(!text.contains(absent), "{absent} in {text}");
    }
}

#[test]
fn v5_structure_projects_book_and_tabs_and_bounds_heavy_seed_size() {
    let f = Fixture::new();
    let initial = f.context();
    let initial_book = initial
        .project_book
        .as_ref()
        .expect("novel project starts with a book");
    // DW: the book reads from the root; the structure names no start.
    let raw = serde_json::to_value(&initial).unwrap();
    assert!(
        raw["project_book"].get("root").is_none(),
        "{}",
        raw["project_book"]
    );
    assert!(
        raw["project_book"].get("root_valid").is_none(),
        "{}",
        raw["project_book"]
    );
    assert!(raw.get("manuscript_roots").is_none());
    assert_eq!(initial_book.word_target, Some(3000));
    assert!(!initial.project_tabs.is_empty());
    assert!(initial.project_tabs.iter().all(|t| t.mount_valid));
    assert!(initial.entry_count > 0);
    assert_eq!(
        initial.entries_by_template.values().copied().sum::<usize>(),
        initial.entry_count
    );

    // Media module write_tools include `module.set_arrangement`.
    f.out(
        "entry_template.put_module",
        json!({
            "book": f.book,
            "template": TPL_CHAPTER,
            "module": {"id": "mod-media-v5", "kind": "media", "name": "插图"}
        }),
    );
    let with_media = f.context();
    let media_mod = with_media
        .templates
        .iter()
        .find(|t| t.id == TPL_CHAPTER)
        .unwrap()
        .modules
        .iter()
        .find(|m| m.id == "mod-media-v5")
        .unwrap();
    assert!(
        media_mod
            .capabilities
            .write_tools
            .contains(&"module.set_arrangement".to_string())
    );

    // Project book and tab updates bump structure_revision and reflect exact state.
    f.out(
        "project.update",
        json!({"book": f.book, "word_target": 12000, "daily_word_target": 1500}),
    );
    let after_book = f.context();
    assert_ne!(after_book.structure_revision, with_media.structure_revision);
    assert_eq!(
        after_book.project_book.as_ref().unwrap().word_target,
        Some(12000)
    );
    assert_eq!(
        after_book.project_book.as_ref().unwrap().daily_word_target,
        Some(1500)
    );

    let made_tab = f.out(
        "tab.put",
        json!({
            "book": f.book,
            "mount": {"kind": "book"}
        }),
    );
    let after_tab = f.context();
    assert_ne!(after_tab.structure_revision, after_book.structure_revision);
    assert!(
        after_tab
            .project_tabs
            .iter()
            // A tab is called by what it shows (`kernel-v5.md` §5).
            .any(|t| t.id == made_tab["id"] && t.name == "成书" && t.mount_valid)
    );

    // Heavy seed: StructureContext stays bounded by summarizing omitted levels by depth & template.
    let heavy_dir = tempfile::tempdir().unwrap();
    let heavy_ws = Workspace::open_dir(heavy_dir.path(), "v5-heavy-structure").unwrap();
    let heavy_seed = seed::generate_v3(Preset::Heavy, seed::DEFAULT_SEED).unwrap();
    let heavy_book = heavy_seed.books[0].book_id().clone();
    heavy_seed.write_to(heavy_ws.library()).unwrap();
    // Turn on `level` across entries so the book has far more than 32 levels.
    let all_entries = heavy_ws
        .call(
            &Actor::User,
            "entry.list",
            json!({"book": heavy_book, "all": true}),
        )
        .unwrap()["output"]
        .as_array()
        .unwrap()
        .clone();
    for item in all_entries.iter().take(60) {
        if item["level"] == false {
            let _ = heavy_ws.call(
                &Actor::User,
                "entry.set_level",
                json!({"book": heavy_book, "id": item["id"], "level": true}),
            );
        }
    }

    let heavy_ctx = StructureContext::for_book(&heavy_ws, &heavy_book, None)
        .unwrap()
        .unwrap();
    let heavy_contrib = heavy_ctx.to_contribution().unwrap();
    assert!(
        heavy_contrib.text.len() < 64 * 1024,
        "heavy StructureContext JSON exceeded 64 KiB: {} bytes",
        heavy_contrib.text.len()
    );
    assert!(heavy_ctx.levels.len() <= 32);
    assert!(heavy_ctx.levels_omitted > 0);
    let depth_sum: usize = heavy_ctx.levels_by_depth.iter().map(|d| d.total).sum();
    assert_eq!(depth_sum, heavy_ctx.levels.len() + heavy_ctx.levels_omitted);
    assert!(heavy_ctx.project_agent.is_some());
    assert!(!heavy_ctx.templates.is_empty());
    heavy_ws.close();
}

/// A book turned off keeps its two targets: the structure has none while it
/// is off, and the Agent turning it on again (after the project was opened
/// anew) brings them back (T2, `kernel-v5.md` §2 「项目定义里有什么」).
#[test]
fn the_agent_turning_the_book_on_again_brings_its_targets_back() {
    let f = Fixture::new();
    f.out(
        "project.update",
        json!({"book": f.book, "word_target": 90_000, "daily_word_target": 2_400}),
    );
    f.out("project.update", json!({"book": f.book, "has_book": false}));
    assert!(f.context().project_book.is_none());
    assert!(f.out("project.get", json!({"book": f.book}))["book"].is_null());
    f.ws.close();
    let directory = Arc::clone(&f._dir);
    let book = f.book.clone();
    drop(f);
    let ws = Workspace::open_dir(directory.path(), "k6-structure-reopen").unwrap();
    let reopened = Fixture {
        ws,
        book,
        entry: String::new(),
        doc: String::new(),
        _dir: directory,
    };
    assert!(
        StructureContext::for_book(&reopened.ws, &reopened.book, None)
            .unwrap()
            .unwrap()
            .project_book
            .is_none()
    );
    let tools = AgentTools::new();
    reopened
        .invoke(&tools, "project.get", json!({"book": reopened.book}))
        .unwrap();
    reopened
        .invoke(
            &tools,
            "project.update",
            json!({"book": reopened.book, "has_book": true}),
        )
        .unwrap();
    let project = reopened.out("project.get", json!({"book": reopened.book}));
    assert_eq!(project["book"]["word_target"], 90_000);
    assert_eq!(project["book"]["daily_word_target"], 2_400);
    assert_eq!(
        StructureContext::for_book(&reopened.ws, &reopened.book, None)
            .unwrap()
            .unwrap()
            .project_book,
        Some(dr_agent_tools::structure::ProjectBookSummary {
            word_target: Some(90_000),
            daily_word_target: Some(2_400),
        })
    );
    reopened.ws.close();
}
