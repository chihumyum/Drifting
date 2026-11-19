//! End-to-end M30 model tool contracts on Format-5 books: `read_task_plan`,
//! `update_task_plan`, `read_working_memory`, `edit_working_memory`, automatic
//! continuation slices, non-auto-resuming restart, and MCP isolation.

use std::sync::Arc;
use std::time::{Duration, Instant};

use dr_agent::{
    DriverEvent, ExternalCall, ExternalStart, FinishReason, ModelCapabilities, Provider, RunConfig,
    Start, State, ToolCall, ToolStatus,
    memory::{self, UpdatedBy},
};
use dr_model::id::{BookId, ConversationId};
use dr_store::Library;
use dr_testkit::seed::{self, Preset};
use dr_view_agent::{controller::AgentController, tools::CompanionTools};
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use futures::{StreamExt, executor::block_on};
use serde_json::{Value, json};

struct Fixture {
    _dir: tempfile::TempDir,
    ws: Workspace,
    book: BookId,
    chapters: Vec<Value>,
    character: Value,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open(dir.path(), library_options("m30-model-tools")).unwrap();
        let seeded = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        let book = seeded.books[0].book_id().clone();
        seeded.write_to(&lib).unwrap();
        let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
        ws.set_auto_links(false);
        let chapters = dr_testkit::seed::acceptance::entries_by_template(&ws, &book, "tpl-chapter");
        let character =
            dr_testkit::seed::acceptance::entries_by_template(&ws, &book, "tpl-character")[0]
                .clone();
        Self {
            _dir: dir,
            ws,
            book,
            chapters,
            character,
        }
    }

    fn config(&self, max_rounds: Option<u32>) -> RunConfig {
        let mut c = RunConfig::new(Provider::Openai, "synthetic-model");
        c.max_model_rounds = max_rounds;
        c.capabilities = Some(ModelCapabilities {
            context_window: Some(262_144),
            ..Default::default()
        });
        c
    }

    fn chapter_quote(&self, index: usize) -> (String, usize, String) {
        let id = self.chapters[index]["id"].as_str().unwrap();
        let doc = format!("body:{id}/mod-prose");
        let out = self
            .ws
            .call(&Actor::User, "prose.read", json!({"doc": doc}))
            .unwrap()["output"]
            .clone();
        let (para_idx, quote) = out["paragraphs"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .find_map(|(i, p)| {
                let t = p["text"].as_str().unwrap_or_default();
                (!t.is_empty()).then(|| (i, t.chars().take(12).collect::<String>()))
            })
            .expect("non-empty paragraph in seeded chapter");
        (doc, para_idx, quote)
    }
}

fn wait(mut ready: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !ready() {
        assert!(Instant::now() < deadline, "timed out waiting for Agent");
        std::thread::sleep(Duration::from_millis(2));
    }
}

#[test]
fn whole_book_review_plan_and_working_memory_slice_and_keep_restart_manual() {
    let f = Fixture::new();
    assert!(f.chapters.len() >= 2, "Tiny seed has multiple chapters");
    let ch0_title = f.chapters[0]["title"].as_str().unwrap().to_owned();
    let ch1_title = f.chapters[1]["title"].as_str().unwrap().to_owned();

    // First run uses max_model_rounds = 4:
    // Round 1: read_working_memory -> edit_working_memory
    // Round 2: update_task_plan(create whole_book review)
    // Round 3: prose.read chapter 0
    // Round 4: update_task_plan(step 0 completed with cited quote)
    // -> hits model_round_limit checkpoint -> automatic slice 2.
    // Slice 2's request stays open until the author stops the conversation,
    // so the task is still active with steps left. Reopening the
    // AgentController must not resume it (2026-11-19 decision); a manual
    // resume reconciles the renamed chapter and finishes the remaining steps.
    type StepTargets = Vec<(String, String)>;
    type OneShot<T> = std::sync::Mutex<Option<std::sync::mpsc::Sender<T>>>;

    let (step0_tx, step0_rx) = std::sync::mpsc::channel::<String>();
    let (step_rest_tx, step_rest_rx) = std::sync::mpsc::channel::<StepTargets>();

    // Use a custom Driver that inspects actual tool outputs from conversation!
    struct PlanDriver {
        book_chapters: Vec<(String, usize, String)>,
        requests: std::sync::Mutex<Vec<dr_agent::DriverRequest>>,
        phase: std::sync::Mutex<usize>,
        step0_tx: OneShot<String>,
        step_rest_tx: OneShot<StepTargets>,
    }
    impl dr_agent::Driver for PlanDriver {
        fn stream(
            &self,
            request: dr_agent::DriverRequest,
            _cancel: dr_agent::Cancellation,
        ) -> futures::stream::BoxStream<'static, dr_agent::Result<DriverEvent>> {
            self.requests.lock().unwrap().push(request.clone());
            let mut phase = self.phase.lock().unwrap();
            let current = *phase;
            *phase += 1;

            let last_tool_output = |call_id: &str| -> Value {
                request
                    .conversation
                    .iter()
                    .rev()
                    .find(|e| {
                        e.kind == dr_model::conversation::ConversationEntryKind::ToolResult
                            && e.payload["call"].as_str() == Some(call_id)
                    })
                    .map(|e| e.payload["output"].clone())
                    .unwrap_or(Value::Null)
            };

            // Automatic slice 2 (slice 1 hit max_model_rounds = 4): held open
            // until the author's stop ends it.
            if current == 4 {
                return futures::stream::pending().boxed();
            }
            let events = match current {
                0 => vec![
                    DriverEvent::ToolCall(ToolCall {
                        id: "wm-read".into(),
                        name: "read_working_memory".into(),
                        arguments: json!({}),
                    }),
                    DriverEvent::Finish(FinishReason::Tools),
                ],
                1 => {
                    let page = last_tool_output("wm-read");
                    assert_eq!(page["exists"], false);
                    assert_eq!(page["revision"], 0);
                    vec![
                        DriverEvent::ToolCall(ToolCall {
                            id: "wm-edit".into(),
                            name: "edit_working_memory".into(),
                            arguments: json!({
                                "expected_revision": 0,
                                "edits": [{
                                    "oldText": "## Current\n",
                                    "newText": "## Current\n- Reviewing compiled book sequence\n"
                                }]
                            }),
                        }),
                        DriverEvent::ToolCall(ToolCall {
                            id: "plan-create".into(),
                            name: "update_task_plan".into(),
                            arguments: json!({
                                "operation": "create",
                                "objective": "Review whole book",
                                "scope": "whole_book",
                                "work_kind": "review"
                            }),
                        }),
                        DriverEvent::Finish(FinishReason::Tools),
                    ]
                }
                2 => {
                    let created = last_tool_output("plan-create");
                    let steps = created["state"]["plan"]["steps"].as_array().unwrap();
                    let first_id = steps[0]["id"].as_str().unwrap().to_owned();
                    let rest: Vec<(String, String)> = steps[1..]
                        .iter()
                        .map(|s| {
                            (
                                s["id"].as_str().unwrap().to_owned(),
                                s["target"]["name"].as_str().unwrap().to_owned(),
                            )
                        })
                        .collect();
                    if let Some(tx) = self.step0_tx.lock().unwrap().take() {
                        let _ = tx.send(first_id.clone());
                    }
                    if let Some(tx) = self.step_rest_tx.lock().unwrap().take() {
                        let _ = tx.send(rest);
                    }
                    let rev = created["receipt"]["revision"].as_u64().unwrap();
                    let (title, _, _) = &self.book_chapters[0];
                    vec![
                        DriverEvent::ToolCall(ToolCall {
                            id: "step0-start".into(),
                            name: "update_task_plan".into(),
                            arguments: json!({
                                "operation": "step",
                                "expected_revision": rev,
                                "step": first_id,
                                "status": "in_progress"
                            }),
                        }),
                        DriverEvent::ToolCall(ToolCall {
                            id: "read-ch0".into(),
                            name: "call_tool".into(),
                            arguments: json!({
                                "name": "prose.read",
                                "arguments": {"doc": {"kind": "entry", "module": "mod-prose", "name": title}}
                            }),
                        }),
                        DriverEvent::Finish(FinishReason::Tools),
                    ]
                }
                3 => {
                    let started = last_tool_output("step0-start");
                    let rev = started["receipt"]["revision"].as_u64().unwrap();
                    let step0_id = started["state"]["plan"]["steps"][0]["id"]
                        .as_str()
                        .unwrap()
                        .to_owned();
                    let (_, para, quote) = &self.book_chapters[0];
                    vec![
                        DriverEvent::ToolCall(ToolCall {
                            id: "step0-done".into(),
                            name: "update_task_plan".into(),
                            arguments: json!({
                                "operation": "step",
                                "expected_revision": rev,
                                "step": step0_id,
                                "status": "completed",
                                "reviewResult": {
                                    "outcome": "verified",
                                    "claims": [{"text": "checked opening", "citations": [{"paragraph": para, "quote": quote}]}]
                                }
                            }),
                        }),
                        DriverEvent::Finish(FinishReason::Tools),
                    ]
                }
                // Manual resume after the restart and a structural rename:
                // reconciles the manifest drift, reads and completes the
                // remaining chapters, and completes the task.
                5 => vec![
                    DriverEvent::ToolCall(ToolCall {
                        id: "resume-read".into(),
                        name: "read_task_plan".into(),
                        arguments: json!({}),
                    }),
                    DriverEvent::Finish(FinishReason::Tools),
                ],
                6 => {
                    let plan = last_tool_output("resume-read");
                    assert_eq!(plan["plan"]["status"], "active");
                    assert_eq!(plan["plan"]["completed"], 1);
                    assert_eq!(plan["manifest_state"]["drifted"], true);
                    let rev = plan["plan"]["revision"].as_u64().unwrap();
                    vec![
                        DriverEvent::ToolCall(ToolCall {
                            id: "reconcile".into(),
                            name: "update_task_plan".into(),
                            arguments: json!({
                                "operation": "reconcile_manifest",
                                "expected_revision": rev
                            }),
                        }),
                        DriverEvent::Finish(FinishReason::Tools),
                    ]
                }
                7 => {
                    let rec = last_tool_output("reconcile");
                    assert_eq!(rec["state"]["manifest_state"]["drifted"], false);
                    let mut calls = Vec::new();
                    for (i, (title, _, _)) in self.book_chapters.iter().enumerate().skip(1) {
                        calls.push(DriverEvent::ToolCall(ToolCall {
                            id: format!("read-ch{i}"),
                            name: "call_tool".into(),
                            arguments: json!({
                                "name": "prose.read",
                                "arguments": {"doc": {"kind": "entry", "module": "mod-prose", "name": title}}
                            }),
                        }));
                    }
                    calls.push(DriverEvent::Finish(FinishReason::Tools));
                    calls
                }
                8 => vec![
                    DriverEvent::ToolCall(ToolCall {
                        id: "plan-check-before-finish".into(),
                        name: "read_task_plan".into(),
                        arguments: json!({"from": 0, "limit": 50}),
                    }),
                    DriverEvent::Finish(FinishReason::Tools),
                ],
                9 => {
                    let state = last_tool_output("plan-check-before-finish");
                    let mut rev = state["plan"]["revision"].as_u64().unwrap();
                    let steps = state["plan"]["steps"].as_array().unwrap().clone();
                    let mut calls = Vec::new();
                    for (idx, step) in steps.iter().enumerate() {
                        if step["status"] == "completed" {
                            continue;
                        }
                        let step_id = step["id"].as_str().unwrap();
                        let (_, para, quote) = &self.book_chapters[idx];
                        calls.push(DriverEvent::ToolCall(ToolCall {
                            id: format!("complete-step-{idx}"),
                            name: "update_task_plan".into(),
                            arguments: json!({
                                "operation": "step",
                                "expected_revision": rev,
                                "step": step_id,
                                "status": "completed",
                                "reviewResult": {
                                    "outcome": "verified",
                                    "claims": [{"text": "checked chapter", "citations": [{"paragraph": para, "quote": quote}]}]
                                }
                            }),
                        }));
                        rev += 1;
                    }
                    calls.push(DriverEvent::ToolCall(ToolCall {
                        id: "finalize-plan".into(),
                        name: "update_task_plan".into(),
                        arguments: json!({
                            "operation": "update",
                            "expected_revision": rev,
                            "status": "completed"
                        }),
                    }));
                    calls.push(DriverEvent::Finish(FinishReason::Tools));
                    calls
                }
                _ => vec![
                    DriverEvent::TextDelta {
                        index: 0,
                        text: "All chapters reviewed.".into(),
                    },
                    DriverEvent::Finish(FinishReason::Complete),
                ],
            };
            futures::stream::iter(events.into_iter().map(Ok)).boxed()
        }
    }

    let mut book_chapters = Vec::new();
    for i in 0..f.chapters.len() {
        let title = if i == 1 {
            format!("{ch1_title}（改名）")
        } else {
            f.chapters[i]["title"].as_str().unwrap().to_owned()
        };
        let (_, p, q) = f.chapter_quote(i);
        book_chapters.push((title, p, q));
    }
    // Start with original ch1 title during slice 1; we rename ch1 before resume!
    book_chapters[0].0 = ch0_title;
    let renamed_ch1 = format!("{ch1_title}（改名）");
    book_chapters[1].0 = renamed_ch1.clone();

    let driver = Arc::new(PlanDriver {
        book_chapters,
        requests: Default::default(),
        phase: std::sync::Mutex::new(0),
        step0_tx: std::sync::Mutex::new(Some(step0_tx)),
        step_rest_tx: std::sync::Mutex::new(Some(step_rest_tx)),
    });

    let controller = AgentController::new(
        f.ws.clone(),
        driver.clone(),
        Arc::new(CompanionTools::default()),
    )
    .unwrap();
    let conversation = ConversationId::new_v7();
    let session = controller
        .start(Start {
            config: f.config(Some(4)),
            book: f.book.clone(),
            conversation: conversation.clone(),
            input: "请审阅整本书各章".into(),
        })
        .unwrap();
    // Slice 2 sends its request and is held there; the author stops it.
    wait(|| driver.requests.lock().unwrap().len() == 5);
    block_on(controller.stop_conversation(&conversation)).unwrap();
    wait(|| controller.active_count() == 0);

    let _step0 = step0_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let _rest = step_rest_rx.recv_timeout(Duration::from_secs(5)).unwrap();

    // Working memory was written by the model with UpdatedBy::Agent and injected into slice 2!
    let wm = memory::load(f.ws.library(), &f.book).unwrap();
    assert!(wm.exists);
    assert_eq!(wm.revision, 1);
    assert_eq!(wm.updated_by, Some(UpdatedBy::Agent));
    assert!(wm.content_md.contains("Reviewing compiled book sequence"));
    let reqs_before_reopen = driver.requests.lock().unwrap().len();
    assert_eq!(
        reqs_before_reopen, 5,
        "4 rounds in slice 1 + the held request of slice 2"
    );
    let slice2_pins = driver.requests.lock().unwrap()[4].conversation[0].payload["text"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(slice2_pins.contains("WORKING_MEMORY.md (revision 1"));

    let snap = controller.snapshot(&f.book, &conversation).unwrap();
    let latest_session = snap.runs.last().unwrap().session.clone();
    let stopped = controller.task_view(&latest_session).unwrap().unwrap();
    assert!(!stopped.authorized);
    let plan = stopped.snapshot.plan.as_ref().unwrap();
    assert_eq!(plan.status, dr_agent::long_task::TaskStatus::Active);
    assert!(
        plan.steps
            .iter()
            .any(|step| step.status != dr_agent::long_task::StepStatus::Completed),
        "the task still has steps to do"
    );
    let chain = stopped.snapshot.chain;

    // Close and reopen controller: restart MUST NOT auto-resume!
    block_on(controller.close()).unwrap();
    drop(controller);

    // Author renames chapter 1 while the task waits, causing manifest drift.
    f.ws.call(
        &Actor::User,
        "entry.update",
        json!({"book": f.book, "id": f.chapters[1]["id"], "title": renamed_ch1}),
    )
    .unwrap();

    let reopened = AgentController::new(
        f.ws.clone(),
        driver.clone(),
        Arc::new(CompanionTools::default()),
    )
    .unwrap();
    let view = reopened.task_view(&latest_session).unwrap().unwrap();
    assert_eq!(
        view.snapshot.plan.as_ref().unwrap().status,
        dr_agent::long_task::TaskStatus::Active
    );
    assert!(!view.authorized, "restart must never auto-arm continuation");
    assert_eq!(reopened.active_count(), 0, "reopening must not start a run");
    assert_eq!(
        driver.requests.lock().unwrap().len(),
        reqs_before_reopen,
        "reopening must not send model requests"
    );
    let _ = session;

    // Explicit manual resume ("继续") finishes reconciliation, remaining reads, and completion.
    let resumed =
        block_on(reopened.resume_job(conversation.clone(), chain, f.config(None), None)).unwrap();
    wait(|| reopened.active_count() == 0);

    let final_view = reopened.task_view(&resumed).unwrap().unwrap();
    assert_eq!(
        final_view.snapshot.plan.unwrap().status,
        dr_agent::long_task::TaskStatus::Completed
    );
    block_on(reopened.close()).unwrap();
    f.ws.shutdown().unwrap();
}

#[test]
fn targets_edit_plan_accepts_entry_module_writes_and_working_memory_enforces_cas_and_mcp_isolation()
{
    let f = Fixture::new();
    let char_id = f.character["id"].as_str().unwrap().to_owned();
    let char_title = f.character["title"].as_str().unwrap().to_owned();

    // Seed >20_000 tokens in working memory to verify one-shot consolidation notice at turn start!
    let cjk = "记".repeat(20_005);
    let seeded_wm = memory::replace(f.ws.library(), &f.book, 0, &cjk, UpdatedBy::Author).unwrap();
    assert_eq!(seeded_wm.revision, 1);

    // Round 1: create targets edit plan on character entry, read patches module, add a patch,
    // then complete the step and finalize the plan. Also test stale working memory conflict x2 stops turn!
    struct EditAndConflictDriver {
        char_id: String,
        char_title: String,
        requests: std::sync::Mutex<Vec<dr_agent::DriverRequest>>,
        phase: std::sync::Mutex<usize>,
    }
    impl dr_agent::Driver for EditAndConflictDriver {
        fn stream(
            &self,
            request: dr_agent::DriverRequest,
            _cancel: dr_agent::Cancellation,
        ) -> futures::stream::BoxStream<'static, dr_agent::Result<DriverEvent>> {
            self.requests.lock().unwrap().push(request.clone());
            let mut phase = self.phase.lock().unwrap();
            let current = *phase;
            *phase += 1;
            let out = |id: &str| -> Value {
                request
                    .conversation
                    .iter()
                    .rev()
                    .find(|e| {
                        e.kind == dr_model::conversation::ConversationEntryKind::ToolResult
                            && e.payload["call"].as_str() == Some(id)
                    })
                    .map(|e| e.payload["output"].clone())
                    .unwrap_or(Value::Null)
            };
            let events = match current {
                0 => vec![
                    DriverEvent::ToolCall(ToolCall {
                        id: "create".into(),
                        name: "update_task_plan".into(),
                        arguments: json!({
                            "operation": "create",
                            "objective": "Add character patch",
                            "scope": "targets",
                            "work_kind": "edit",
                            "targets": [{"kind": "entry", "name": self.char_title}]
                        }),
                    }),
                    DriverEvent::ToolCall(ToolCall {
                        id: "read-mod".into(),
                        name: "call_tool".into(),
                        arguments: json!({
                            "name": "module.read",
                            "arguments": {"entry": self.char_id, "module": "mod-patches"}
                        }),
                    }),
                    DriverEvent::Finish(FinishReason::Tools),
                ],
                1 => {
                    let created = out("create");
                    let rev = created["receipt"]["revision"].as_u64().unwrap();
                    let step_id = created["state"]["plan"]["steps"][0]["id"]
                        .as_str()
                        .unwrap()
                        .to_owned();
                    vec![
                        // Premature step completion before write must fail with structured error.
                        DriverEvent::ToolCall(ToolCall {
                            id: "premature".into(),
                            name: "update_task_plan".into(),
                            arguments: json!({
                                "operation": "step",
                                "expected_revision": rev,
                                "step": step_id,
                                "status": "completed"
                            }),
                        }),
                        DriverEvent::ToolCall(ToolCall {
                            id: "put-patch".into(),
                            name: "call_tool".into(),
                            arguments: json!({
                                "name": "module.put_patch",
                                "arguments": {
                                    "entry": self.char_id,
                                    "module": "mod-patches",
                                    "body": "新增人物阶段记录"
                                }
                            }),
                        }),
                        DriverEvent::Finish(FinishReason::Tools),
                    ]
                }
                2 => {
                    assert_eq!(out("premature")["error"]["code"], "invalid");
                    let created = out("create");
                    let rev = created["receipt"]["revision"].as_u64().unwrap();
                    let step_id = created["state"]["plan"]["steps"][0]["id"]
                        .as_str()
                        .unwrap()
                        .to_owned();
                    vec![
                        DriverEvent::ToolCall(ToolCall {
                            id: "complete-step".into(),
                            name: "update_task_plan".into(),
                            arguments: json!({
                                "operation": "step",
                                "expected_revision": rev,
                                "step": step_id,
                                "status": "completed"
                            }),
                        }),
                        DriverEvent::ToolCall(ToolCall {
                            id: "complete-plan".into(),
                            name: "update_task_plan".into(),
                            arguments: json!({
                                "operation": "update",
                                "expected_revision": rev + 1,
                                "status": "completed"
                            }),
                        }),
                        DriverEvent::Finish(FinishReason::Tools),
                    ]
                }
                3 => vec![
                    DriverEvent::TextDelta {
                        index: 0,
                        text: "Done.".into(),
                    },
                    DriverEvent::Finish(FinishReason::Complete),
                ],
                // Second conversation: two stale working-memory edits stop the turn!
                4 => vec![
                    DriverEvent::ToolCall(ToolCall {
                        id: "stale-1".into(),
                        name: "edit_working_memory".into(),
                        arguments: json!({
                            "expected_revision": 0,
                            "edits": [{"oldText": "记", "newText": "改"}]
                        }),
                    }),
                    DriverEvent::Finish(FinishReason::Tools),
                ],
                5 => {
                    assert_eq!(out("stale-1")["error"]["code"], "conflict");
                    vec![
                        DriverEvent::ToolCall(ToolCall {
                            id: "stale-2".into(),
                            name: "edit_working_memory".into(),
                            arguments: json!({
                                "expected_revision": 0,
                                "edits": [{"oldText": "记", "newText": "改"}]
                            }),
                        }),
                        DriverEvent::Finish(FinishReason::Tools),
                    ]
                }
                _ => panic!("turn must stop after second working-memory conflict"),
            };
            futures::stream::iter(events.into_iter().map(Ok)).boxed()
        }
    }

    let driver = Arc::new(EditAndConflictDriver {
        char_id,
        char_title,
        requests: Default::default(),
        phase: std::sync::Mutex::new(0),
    });
    let controller = AgentController::new(
        f.ws.clone(),
        driver.clone(),
        Arc::new(CompanionTools::default()),
    )
    .unwrap();

    // First conversation consumes the >20k working-memory consolidation notice once.
    let conv1 = ConversationId::new_v7();
    let s1 = controller
        .start(Start {
            config: f.config(None),
            book: f.book.clone(),
            conversation: conv1.clone(),
            input: "补充人物阶段记录".into(),
        })
        .unwrap();
    wait(|| controller.active_count() == 0);
    assert!(
        driver.requests.lock().unwrap()[0]
            .config
            .system_prompt
            .contains("Consolidate it during this turn")
    );
    assert_eq!(
        controller
            .task_view(&s1)
            .unwrap()
            .unwrap()
            .snapshot
            .plan
            .unwrap()
            .status,
        dr_agent::long_task::TaskStatus::Completed
    );

    // Second conversation at the same tier does NOT repeat the notice, and stops after 2 stale WM conflicts.
    let conv2 = ConversationId::new_v7();
    controller
        .start(Start {
            config: f.config(None),
            book: f.book.clone(),
            conversation: conv2.clone(),
            input: "测试工作记忆冲突上限".into(),
        })
        .unwrap();
    wait(|| controller.active_count() == 0);
    let reqs = driver.requests.lock().unwrap().clone();
    assert!(
        !reqs[4]
            .config
            .system_prompt
            .contains("Consolidate it during this turn"),
        "notice at tier 1 fires once until shrunk and re-crossed"
    );
    assert_eq!(reqs.len(), 6, "no third model round after second conflict");
    let snap2 = controller.snapshot(&f.book, &conv2).unwrap();
    assert_eq!(snap2.runs[0].state, State::Stopped);

    // External MCP scope on the same controller cannot call session-bound plan or working-memory tools!
    let ext = controller
        .open_external(ExternalStart {
            client_id: "mcp-isolation-check".into(),
            book: f.book.clone(),
            connection_epoch: 1,
        })
        .unwrap();
    for (name, rev, args) in [
        ("read_task_plan", "m30-task-read-v1", json!({})),
        (
            "update_task_plan",
            "m30-task-update-v1",
            json!({"operation": "create", "objective": "x", "scope": "whole_book", "work_kind": "review"}),
        ),
        (
            "read_working_memory",
            "m30-working-memory-read-v1",
            json!({}),
        ),
        (
            "edit_working_memory",
            "m30-working-memory-edit-v1",
            json!({"expected_revision": 1, "edits": [{"oldText": "记", "newText": "改"}]}),
        ),
    ] {
        let res = block_on(
            ext.call(ExternalCall {
                name: name.into(),
                arguments: args,
                revision: rev.into(),
            })
            .unwrap()
            .finish(),
        )
        .unwrap();
        assert_eq!(
            res.status,
            ToolStatus::Error,
            "{name} must reject external scope"
        );
    }
    block_on(ext.close()).unwrap();
    assert_eq!(memory::load(f.ws.library(), &f.book).unwrap().revision, 1);

    block_on(controller.close()).unwrap();
    f.ws.shutdown().unwrap();
}
