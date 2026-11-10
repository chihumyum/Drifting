use super::*;
use crate::{
    driver::scripted::{ScriptedDriver, Step as Script},
    tools::ToolOutput,
    *,
};
use dr_model::id::{BookId, ConversationId};
use dr_store::Library;
use dr_testkit::seed::{self, Preset};
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use futures::{FutureExt, future::BoxFuture};
use serde_json::json;
use std::sync::Arc;

struct NoTools;
impl ToolExecutor for NoTools {
    fn descriptors(&self) -> Vec<ToolDescriptor> {
        Vec::new()
    }
    fn execute(&self, _: ToolContext, _: ToolCall) -> BoxFuture<'static, Result<ToolOutput>> {
        async { panic!("no tools") }.boxed()
    }
}
struct Fixture {
    _dir: tempfile::TempDir,
    ws: Workspace,
    book: BookId,
    session: String,
    chain: String,
    store: Store,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open(dir.path(), library_options("m30-plan")).unwrap();
        let book = {
            let seed = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
            seed.write_to(&lib).unwrap();
            seed.books[0].book_id().clone()
        };
        let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
        let driver = Arc::new(ScriptedDriver::new(vec![vec![Script::Event(
            DriverEvent::Finish(FinishReason::Complete),
        )]]));
        let runtime =
            Runtime::new(ws.clone(), driver, Arc::new(NoTools), Options::default()).unwrap();
        let run = runtime
            .start(Start {
                book: book.clone(),
                conversation: ConversationId::new_v7(),
                input: "fixture request".into(),
                config: RunConfig::new(Provider::Openai, "synthetic-model"),
            })
            .unwrap();
        let session = run.session.clone();
        assert_eq!(run.join().unwrap(), State::Completed);
        drop(runtime);
        let store = Store::new(ws.library().clone());
        let chain = store.chain_for_session(&session).unwrap().unwrap();
        Self {
            _dir: dir,
            ws,
            book,
            session,
            chain,
            store,
        }
    }
    fn apply(&self, call: &str, command: Command) -> Result<CommandReceipt> {
        self.store.apply(&self.session, 1, call, command)
    }
    fn snapshot(&self) -> ChainSnapshot {
        self.store.snapshot(&self.chain).unwrap()
    }
    fn plan(&self) -> Plan {
        self.snapshot().plan.unwrap()
    }
    fn create(&self, kind: WorkKind) {
        self.apply(
            "create",
            Command::Create {
                objective: "fixture task".into(),
                scope: Scope::WholeBook,
                work_kind: kind,
                targets: vec![],
            },
        )
        .unwrap();
    }
    fn step(
        &self,
        call: &str,
        id: &str,
        status: StepStatus,
        review: Option<ReviewResult>,
    ) -> Result<CommandReceipt> {
        self.apply(
            call,
            Command::Step {
                expected_revision: self.plan().revision,
                step: id.into(),
                status,
                note: None,
                review,
            },
        )
    }
    fn read(&self, step: &Step, partial: bool) -> ReviewResult {
        let doc = step.target.doc.as_ref().unwrap();
        let copy = self.ws.library().load_copy(doc).unwrap();
        let version = crate::evidence::version(&copy.oplog_frontiers());
        let paragraphs = crate::evidence::paragraphs(self.ws.library(), doc, &version).unwrap();
        let quote = paragraphs.iter().find(|p| !p.text.is_empty()).unwrap();
        let review = ReviewResult {
            outcome: "reviewed".into(),
            claims: vec![ReviewClaim {
                text: "verified source".into(),
                citations: vec![Citation {
                    paragraph: quote.index,
                    quote: quote.text.clone(),
                }],
            }],
            findings: vec![],
        };
        let observation = crate::evidence::ReadObservation {
            doc: doc.clone(),
            version,
            total: paragraphs.len(),
            paragraphs: if partial {
                paragraphs.into_iter().take(1).collect()
            } else {
                paragraphs
            },
        };
        let proof = crate::evidence::verify_read(
            self.ws.library(),
            &self.book,
            &self.session,
            1,
            if partial { "partial" } else { "full" },
            observation,
        )
        .unwrap();
        self.ws
            .library()
            .local_write(|tx| persist_read(tx, &proof))
            .unwrap();
        review
    }
}

#[test]
fn plan_cas_idempotency_atomicity_and_one_active_step() {
    let f = Fixture::new();
    f.create(WorkKind::Edit);
    let plan = f.plan();
    assert_eq!(plan.revision, 1);
    assert!(!plan.steps.is_empty());
    let first = &plan.steps[0];
    f.step("start", &first.id, StepStatus::InProgress, None)
        .unwrap();
    let at = f.plan().steps[0].started_ms;
    f.step("restate", &first.id, StepStatus::InProgress, None)
        .unwrap();
    assert_eq!(f.plan().steps[0].started_ms, at);
    if plan.steps.len() > 1 {
        assert!(
            f.step("second", &plan.steps[1].id, StepStatus::InProgress, None)
                .is_err()
        );
    }
    assert!(
        f.step("forge", &first.id, StepStatus::Completed, None)
            .is_err()
    );
    let revision = f.plan().revision;
    assert!(
        f.apply(
            "stale",
            Command::Update {
                expected_revision: 1,
                objective: None,
                status: Some(TaskStatus::Completed)
            }
        )
        .is_err()
    );
    assert_eq!(f.plan().revision, revision);
    let command = Command::Constraint {
        expected_revision: revision,
        id: None,
        text: "explicit constraint".into(),
        active: true,
    };
    let receipt = f.apply("constraint", command.clone()).unwrap();
    assert_eq!(f.apply("constraint", command).unwrap().id, receipt.id);
    assert_eq!(f.snapshot().constraints.len(), 1);
    assert!(
        f.apply(
            "constraint",
            Command::Update {
                expected_revision: revision,
                objective: Some("changed".into()),
                status: None
            }
        )
        .is_err()
    );
    let fingerprint = f.store.continuation(&f.session).unwrap().fingerprint;
    f.apply(
        "rename",
        Command::Update {
            expected_revision: f.plan().revision,
            objective: Some("rename only".into()),
            status: None,
        },
    )
    .unwrap();
    assert_eq!(
        f.store.continuation(&f.session).unwrap().fingerprint,
        fingerprint
    );
}

#[test]
fn review_rejects_partial_reads_forged_quotes_and_newer_content() {
    let f = Fixture::new();
    f.create(WorkKind::Review);
    let step = f.plan().steps[0].clone();
    let review = f.read(&step, true);
    assert!(
        f.step("partial", &step.id, StepStatus::Completed, Some(review))
            .is_err()
    );
    let review = f.read(&step, false);
    let mut forged = review.clone();
    forged.claims[0].citations[0].quote = "not present in the seeded source".into();
    assert!(
        f.step("forged", &step.id, StepStatus::Completed, Some(forged))
            .is_err()
    );
    f.step(
        "complete",
        &step.id,
        StepStatus::Completed,
        Some(review.clone()),
    )
    .unwrap();
    assert!(
        f.step("current", &step.id, StepStatus::Pending, None)
            .is_err()
    );
    let before = &review.claims[0].citations[0].quote;
    f.ws.call(&Actor::User,"prose.replace",json!({"doc":step.target.doc,"find":before,"replace":before.chars().rev().collect::<String>()})).unwrap();
    assert!(
        f.apply(
            "finalize",
            Command::Update {
                expected_revision: f.plan().revision,
                objective: None,
                status: Some(TaskStatus::Completed)
            }
        )
        .is_err()
    );
    f.step("reopen", &step.id, StepStatus::Pending, None)
        .unwrap();
    assert!(f.plan().steps[0].evidence.is_none());
}

#[test]
fn manifest_reconciliation_retires_and_restores_without_false_completion() {
    let f = Fixture::new();
    f.create(WorkKind::Edit);
    let original = f.plan().steps[0].clone();
    f.ws.call(
        &Actor::User,
        "entry.update",
        json!({"book":f.book,"id":original.target.id.split('/').next().unwrap(),"title":"renamed fixture"}),
    )
    .unwrap();
    assert!(f.snapshot().manifest_state.drifted);
    f.apply(
        "reconcile",
        Command::ReconcileManifest {
            expected_revision: f.plan().revision,
        },
    )
    .unwrap();
    assert!(!f.snapshot().manifest_state.drifted);
    assert_eq!(f.plan().steps[0].id, original.id);
    f.ws.call(
        &Actor::User,
        "entry.trash",
        json!({"book":f.book,"id":original.target.id.split('/').next().unwrap()}),
    )
    .unwrap();
    if f.plan().steps.len() > 1 {
        f.apply(
            "remove",
            Command::ReconcileManifest {
                expected_revision: f.plan().revision,
            },
        )
        .unwrap();
        assert_eq!(
            f.plan()
                .steps
                .iter()
                .find(|s| s.id == original.id)
                .unwrap()
                .status,
            StepStatus::Retired
        );
    } else {
        assert!(
            f.apply(
                "empty",
                Command::ReconcileManifest {
                    expected_revision: f.plan().revision
                }
            )
            .is_err()
        );
    }
    f.ws.call(
        &Actor::User,
        "entry.restore",
        json!({"book":f.book,"id":original.target.id.split('/').next().unwrap()}),
    )
    .unwrap();
    f.apply(
        "restore",
        Command::ReconcileManifest {
            expected_revision: f.plan().revision,
        },
    )
    .unwrap();
    assert_eq!(
        f.plan()
            .steps
            .iter()
            .find(|s| s.id == original.id)
            .unwrap()
            .status,
        StepStatus::Pending
    );
}

#[test]
fn durable_writes_complete_only_the_exact_target_once_and_survive_reopen() {
    let f = Fixture::new();
    f.create(WorkKind::Edit);
    for (i, step) in f.plan().steps.iter().enumerate() {
        let doc = step.target.doc.as_ref().unwrap();
        let text =
            f.ws.call(&Actor::User, "prose.read", json!({"doc":doc}))
                .unwrap();
        let text = text["output"]["paragraphs"][1]["text"].as_str().unwrap();
        let call = format!("write-{i}");
        f.ws.call(
            &Actor::Agent {
                session: f.session.clone(),
                turn: 1,
                call: call.clone(),
            },
            "prose.replace",
            json!({"doc":doc,"find":text,"replace":text.chars().rev().collect::<String>()}),
        )
        .unwrap();
        let proof = crate::evidence::write_proof(f.ws.library(), &f.session, 1, &call)
            .unwrap()
            .unwrap();
        f.ws.library()
            .local_write(|tx| persist_writes(tx, &proof))
            .unwrap();
        f.step(&format!("done-{i}"), &step.id, StepStatus::Completed, None)
            .unwrap();
    }
    f.apply(
        "finish",
        Command::Update {
            expected_revision: f.plan().revision,
            objective: None,
            status: Some(TaskStatus::Completed),
        },
    )
    .unwrap();
    assert!(matches!(
        f.store.continuation(&f.session).unwrap().decision,
        Decision::Off { .. }
    ));
    assert!(
        f.apply(
            "late",
            Command::Update {
                expected_revision: f.plan().revision,
                objective: None,
                status: Some(TaskStatus::Active)
            }
        )
        .is_err()
    );
    let path = f._dir.path().to_owned();
    let chain = f.chain.clone();
    drop(f.store);
    f.ws.shutdown().unwrap();
    let lib = Library::open(&path, library_options("m30-plan")).unwrap();
    assert_eq!(
        Store::new(lib)
            .snapshot(&chain)
            .unwrap()
            .plan
            .unwrap()
            .status,
        TaskStatus::Completed
    );
}

#[test]
fn bounded_context_keeps_pins_and_never_splits_call_result_groups() {
    use dr_model::conversation::{ConversationEntry, ConversationEntryKind as Kind};
    let f = Fixture::new();
    f.create(WorkKind::Review);
    f.apply(
        "constraint",
        Command::Constraint {
            expected_revision: 1,
            id: None,
            text: "persistent constraint".into(),
            active: true,
        },
    )
    .unwrap();
    let snapshot = f.snapshot();
    let call = ToolCall {
        id: "read".into(),
        name: "fixture".into(),
        arguments: json!({}),
    };
    let row = |id: &str, kind, payload| ConversationEntry {
        id: id.into(),
        session: f.session.clone(),
        turn: 1,
        kind,
        payload,
    };
    let history = vec![
        row(
            "assistant",
            Kind::Assistant,
            serde_json::to_value(AssistantMessage {
                complete: true,
                blocks: vec![ContentBlock::ToolCall { call }],
                ..Default::default()
            })
            .unwrap(),
        ),
        row(
            "result",
            Kind::ToolResult,
            json!({"call":"read","output":"a".repeat(20000)}),
        ),
        row("recent", Kind::User, json!({"text":"recent steering"})),
    ];
    let mut config = RunConfig::new(Provider::Openai, "synthetic-model");
    config.capabilities = Some(ModelCapabilities {
        context_window: Some(10_000),
        ..Default::default()
    });
    config.max_output_tokens = Some(4096);
    let crate::context::Prepared::Ready {
        conversation,
        checkpoint,
    } = crate::context::prepare(&config, &snapshot, history.clone(), &[], vec![]).unwrap()
    else {
        panic!("bounded context")
    };
    assert_eq!(checkpoint.covered_count, 2);
    assert!(
        !conversation
            .iter()
            .any(|e| matches!(e.kind, Kind::Assistant | Kind::ToolResult))
    );
    let pins = conversation[0].payload["text"].as_str().unwrap();
    assert!(pins.contains("persistent constraint"));
    assert!(pins.contains("fixture request"));
    assert!(!pins.contains(snapshot.book.as_str()));
    assert!(crate::context::validate_checkpoint(&checkpoint, &snapshot, &history, &[]).unwrap());
    let mut tampered = history;
    tampered[0].payload["changed"] = true.into();
    assert!(!crate::context::validate_checkpoint(&checkpoint, &snapshot, &tampered, &[]).unwrap());
    let mut large = snapshot;
    large.original_request = "a".repeat(20000);
    assert!(matches!(
        crate::context::prepare(&config, &large, vec![], &[], vec![]).unwrap(),
        crate::context::Prepared::TooLarge { .. }
    ));
}

#[test]
fn v3_manifest_keeps_each_body_and_retained_module_as_a_distinct_target() {
    use dr_doc::v3::novel::{MOD_PROSE, TPL_CHAPTER};
    let f = Fixture::new();
    f.create(WorkKind::Review);
    let plan = f.plan();
    assert!(plan.manifest.iter().all(|m| m.target.kind == "module"));
    let original = plan.steps[0].clone();
    let entry = original.target.id.split('/').next().unwrap();
    let templates =
        f.ws.call(&Actor::User, "entry_template.list", json!({"book":f.book}))
            .unwrap();
    let template = templates["output"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == TPL_CHAPTER)
        .unwrap();
    let mut module = template["modules"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == MOD_PROSE)
        .unwrap()
        .clone();
    module["id"] = json!("synthetic-second-body");
    f.ws.call(
        &Actor::User,
        "entry_template.put_module",
        json!({"book":f.book,"template":TPL_CHAPTER,"module":module}),
    )
    .unwrap();
    assert!(f.snapshot().manifest_state.drifted);
    f.apply(
        "reconcile-v3",
        Command::ReconcileManifest {
            expected_revision: f.plan().revision,
        },
    )
    .unwrap();
    let plan = f.plan();
    assert!(
        plan.manifest
            .iter()
            .any(|m| m.target.id == format!("{entry}/{MOD_PROSE}"))
    );
    assert!(
        plan.manifest
            .iter()
            .any(|m| m.target.id == format!("{entry}/synthetic-second-body"))
    );
    f.ws.call(
        &Actor::User,
        "entry_template.remove_module",
        json!({"book":f.book,"template":TPL_CHAPTER,"module":MOD_PROSE}),
    )
    .unwrap();
    // Original data stays named by its own module even after its definition goes.
    f.apply(
        "retained-v3",
        Command::ReconcileManifest {
            expected_revision: f.plan().revision,
        },
    )
    .unwrap();
    assert!(
        f.plan()
            .manifest
            .iter()
            .any(|m| m.target.doc == original.target.doc)
    );
    let review = f.read(&original, false);
    f.step(
        "review-v3",
        &original.id,
        StepStatus::Completed,
        Some(review),
    )
    .unwrap();
    let memory = crate::memory::project(&f.ws, &f.book).unwrap();
    assert_eq!(
        memory.version,
        f.ws.observe(&format!("book:{}", f.book)).unwrap().version
    );
    f.ws.close();
}
