//! The real controller selects project guidance without a real model or UI.
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use dr_agent::{
    driver::scripted::{ScriptedDriver, Step},
    *,
};
use dr_doc::v3::novel::{MOD_PROSE, TPL_CHAPTER};
use dr_model::id::{BookId, ConversationId};
use dr_testkit::seed::{self, Preset};
use dr_view_agent::{controller::AgentController, tools::CompanionTools};
use dr_workspace::{Actor, Workspace};
use futures::executor::block_on;
use serde_json::{Value, json};

struct Fixture {
    ws: Workspace,
    book: BookId,
    doc: String,
    _dir: tempfile::TempDir,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::open_dir(dir.path(), "k6-guidance-controller").unwrap();
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
            .unwrap();
        let doc = format!("body:{}/{MOD_PROSE}", entry.id);
        seeded.write_to(ws.library()).unwrap();
        Self {
            ws,
            book,
            doc,
            _dir: dir,
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
    fn put(&self, template: Value) {
        self.out(
            "entry_template.put",
            json!({"book":self.book,"template":template}),
        );
    }
    fn edit(&self) {
        let prose = self.out("prose.read", json!({"doc":self.doc,"limit":usize::MAX}));
        let p = &prose["paragraphs"][1];
        self.out("prose.replace", json!({"doc":self.doc,"block_id":p["block_id"],"find":p["text"],"replace":"Synthetic author revision for context evidence"}));
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.ws.close();
    }
}
fn config() -> RunConfig {
    let mut config = RunConfig::new(Provider::Openai, "synthetic-model");
    config.capabilities = Some(ModelCapabilities {
        context_window: Some(256_000),
        ..Default::default()
    });
    config.system_prompt = dr_agent::novel_template::OUTLINE_GUIDANCE.into();
    config
}
fn complete(text: &str) -> Vec<Step> {
    vec![
        Step::Event(DriverEvent::TextDelta {
            index: 0,
            text: text.into(),
        }),
        Step::Event(DriverEvent::Finish(FinishReason::Complete)),
    ]
}
fn wait(mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !condition() {
        assert!(Instant::now() < deadline, "controller did not settle");
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn author_and_resume_requests_use_current_book_guidance_without_legacy_prompt() {
    let f = Fixture::new();
    let driver = Arc::new(ScriptedDriver::new(vec![
        complete("Synthetic first response"),
        complete("Synthetic resumed response"),
    ]));
    let controller = AgentController::new(
        f.ws.clone(),
        driver.clone(),
        Arc::new(CompanionTools::default()),
    )
    .unwrap();
    let conversation = ConversationId::new_v7();
    let first = controller
        .start(Start {
            book: f.book.clone(),
            conversation: conversation.clone(),
            config: config(),
            input: "Inspect this synthetic project".into(),
        })
        .unwrap();
    wait(|| controller.control(&first).is_none());
    let chain = dr_agent::long_task::Store::new(f.ws.library().clone())
        .chain_for_session(&first)
        .unwrap()
        .unwrap();
    let mut template = f
        .templates()
        .into_iter()
        .find(|t| t["id"] == TPL_CHAPTER)
        .unwrap();
    template["agent"]["instructions"] = json!("AUTHOR_CHANGED_PROJECT_GUIDANCE");
    f.put(template);
    let resumed = block_on(controller.resume_job(
        conversation,
        chain,
        config(),
        Some("Continue the synthetic request".into()),
    ))
    .unwrap();
    wait(|| controller.control(&resumed).is_none());
    let requests = driver.requests();
    assert_eq!(requests.len(), 2);
    for request in &requests {
        assert!(!request.config.system_prompt.contains("act / chapter"));
        assert!(
            !request
                .config
                .system_prompt
                .contains("Work with the author's chapters")
        );
        assert!(request.config.system_prompt.contains("BOOK_STRUCTURE.json"));
    }
    assert!(
        !serde_json::to_string(&requests[0].conversation)
            .unwrap()
            .contains("AUTHOR_CHANGED_PROJECT_GUIDANCE")
    );
    assert!(
        serde_json::to_string(&requests[1].conversation)
            .unwrap()
            .contains("AUTHOR_CHANGED_PROJECT_GUIDANCE")
    );
    block_on(controller.close()).unwrap();
}

#[test]
fn v3_suggestions_are_generic_and_do_not_restore_cleared_novel_guidance() {
    let f = Fixture::new();
    for mut template in f.templates() {
        template["agent"] = Value::Null;
        for module in template["modules"].as_array_mut().unwrap() {
            module["agent"] = Value::Null;
        }
        f.put(template);
    }
    f.edit();
    let driver = Arc::new(ScriptedDriver::new(vec![complete("{\"cards\":[]}")]));
    let controller = AgentController::new(
        f.ws.clone(),
        driver.clone(),
        Arc::new(CompanionTools::default()),
    )
    .unwrap();
    controller.set_proactive_enabled(true);
    let now = chrono::Utc::now().timestamp_millis() + 2000;
    assert!(
        controller
            .suggestions(&f.book, now)
            .unwrap()
            .organize
            .is_none()
    );
    let writes = f.ws.library().write_seq().unwrap();
    block_on(controller.trigger_suggestions(f.book.clone(), Some(config()), now)).unwrap();
    let requests = driver.requests();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].tools.is_empty());
    assert!(requests[0].purpose.is_single());
    assert!(
        !requests[0]
            .config
            .system_prompt
            .contains("Literary choices")
    );
    assert!(
        !requests[0]
            .config
            .system_prompt
            .contains("elements and relations")
    );
    let context: Value = serde_json::from_str(
        requests[0].conversation[0].payload["text"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    let structure: dr_agent_tools::StructureContext =
        serde_json::from_str(context["book_structure"]["text"].as_str().unwrap()).unwrap();
    assert!(
        structure
            .templates
            .iter()
            .all(|t| t.agent.instructions.is_empty()
                && t.modules.iter().all(|m| m.agent.instructions.is_empty()))
    );
    assert_eq!(context["documents"][0]["target"]["kind"], "entry");
    assert_eq!(context["documents"][0]["doc"], f.doc);
    assert_eq!(writes, f.ws.library().write_seq().unwrap());
    block_on(controller.close()).unwrap();
}

#[test]
fn oversized_guidance_never_sends_a_truncated_suggestion_request() {
    let f = Fixture::new();
    let mut template = f
        .templates()
        .into_iter()
        .find(|t| t["id"] == TPL_CHAPTER)
        .unwrap();
    template["agent"]["instructions"] = json!("Synthetic fixed guidance ".repeat(30_000));
    f.put(template);
    f.edit();
    let driver = Arc::new(ScriptedDriver::new(vec![]));
    let controller = AgentController::new(
        f.ws.clone(),
        driver.clone(),
        Arc::new(CompanionTools::default()),
    )
    .unwrap();
    controller.set_proactive_enabled(true);
    block_on(controller.trigger_suggestions(
        f.book.clone(),
        Some(config()),
        chrono::Utc::now().timestamp_millis() + 2000,
    ))
    .unwrap();
    assert!(driver.requests().is_empty());
    let state = controller
        .suggestions(&f.book, chrono::Utc::now().timestamp_millis() + 3000)
        .unwrap();
    assert!(state.state.cards.is_empty());
    assert!(state.state.checkin_cursor.documents.is_empty());
    block_on(controller.close()).unwrap();
}
