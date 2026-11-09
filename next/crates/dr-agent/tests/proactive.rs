use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use dr_agent::{proactive::*, *};
use dr_doc::prose::BorrowedProse;
use dr_model::{DocId, id::BookId, prose::InlineStyle};
use dr_store::{Library, OpenDoc, Origin};
use dr_testkit::seed::{self, Preset};
use futures::{StreamExt, channel::oneshot, stream::BoxStream};
use serde_json::json;

fn setup(preset: Preset) -> (tempfile::TempDir, Library, BookId, Vec<String>) {
    let temp = tempfile::tempdir().unwrap();
    let lib = Library::open(temp.path(), seed::library_options("m30-proactive")).unwrap();
    let seeded = seed::generate(preset, seed::DEFAULT_SEED).unwrap();
    let book = seeded.books[0].book_id().clone();
    seeded.write_to(&lib).unwrap();
    let nodes = lib
        .docs(Some(book.as_str()), None)
        .unwrap()
        .into_iter()
        .filter(|d| d.doc_id.starts_with("node:"))
        .map(|d| d.doc_id)
        .collect();
    (temp, lib, book, nodes)
}

fn cursor(lib: &Library, book: &BookId) -> DeltaCursor {
    DeltaCursor {
        since_ms: Some(0),
        documents: lib
            .docs(Some(book.as_str()), None)
            .unwrap()
            .into_iter()
            .filter(|d| !d.doc_id.starts_with("book:"))
            .map(|info| {
                let copy = lib.load_copy(&info.doc_id).unwrap();
                (
                    info.doc_id,
                    DocumentCursor {
                        frontiers: copy.oplog_frontiers().encode(),
                        counters: copy.oplog_vv().iter().map(|(p, c)| (*p, *c)).collect(),
                    },
                )
            })
            .collect(),
    }
}

fn insert(lib: &Library, doc: &str, origin: Origin) {
    let id: DocId = doc.parse().unwrap();
    let handle = lib.open_doc(doc, OpenDoc::Existing).unwrap();
    handle
        .write(origin, move |raw| {
            let prose = BorrowedProse::new(raw, &id).unwrap();
            let text = prose
                .view()
                .paragraphs()
                .find(|p| !p.is_empty())
                .unwrap()
                .text();
            prose.txn().insert_text(0, &text).unwrap();
        })
        .unwrap();
}

fn request(book: &BookId, cursor: DeltaCursor, mode: DeltaMode, limit: usize) -> DeltaRequest {
    DeltaRequest {
        book: book.clone(),
        since_ms: 0,
        captured_ms: dr_store::now_ms(),
        mode,
        cursor,
        limit,
    }
}

#[test]
fn provenance_uses_existing_local_peer_and_survives_compaction() {
    let (_temp, lib, book, nodes) = setup(Preset::Tiny);
    let before = cursor(&lib, &book);
    insert(&lib, &nodes[0], Origin::User);
    insert(&lib, &nodes[1], Origin::agent("fixture", 1));
    let remote = lib.load_copy(&nodes[2]).unwrap();
    remote.set_peer_id(42).unwrap();
    let remote_id: DocId = nodes[2].parse().unwrap();
    let prose = BorrowedProse::new(&remote, &remote_id).unwrap();
    let text = prose
        .view()
        .paragraphs()
        .find(|p| !p.is_empty())
        .unwrap()
        .text();
    prose.txn().insert_text(0, &text).unwrap();
    remote.commit_with(
        loro::CommitOptions::new()
            .origin("user")
            .timestamp(dr_store::now_ms() / 1000),
    );
    lib.open_doc(&nodes[2], OpenDoc::Existing)
        .unwrap()
        .import(
            remote.export(loro::ExportMode::all_updates()).unwrap(),
            Origin::Sync,
        )
        .unwrap();
    insert(&lib, &nodes[3], Origin::Repair);
    insert(&lib, &nodes[4], Origin::Mirror);
    insert(&lib, &nodes[5], Origin::Import);
    insert(&lib, &nodes[6], Origin::Outside);
    for node in &nodes {
        lib.open_doc(node, OpenDoc::Existing)
            .unwrap()
            .compact_now()
            .unwrap();
    }
    let writes = lib.write_seq().unwrap();
    let peers_before: i64 = lib
        .local_read(|conn| Ok(conn.query_row("SELECT count(*) FROM loro_peer", [], |r| r.get(0))?))
        .unwrap();
    let all = collect_delta(
        &lib,
        &request(&book, before.clone(), DeltaMode::AllProse, 8),
    )
    .unwrap();
    assert_eq!(all.documents.len(), 4);
    assert_eq!(
        all.documents
            .iter()
            .map(|d| d.sources.author)
            .sum::<usize>(),
        2
    );
    assert_eq!(
        all.documents.iter().map(|d| d.sources.agent).sum::<usize>(),
        1
    );
    assert_eq!(
        all.documents
            .iter()
            .map(|d| d.sources.remote)
            .sum::<usize>(),
        1
    );
    let author = collect_delta(
        &lib,
        &request(&book, before, DeltaMode::LocalAuthorNodes, 12),
    )
    .unwrap();
    assert_eq!(author.documents.len(), 2);
    assert!(
        author
            .documents
            .iter()
            .all(|d| d.sources.author > 0 && d.sources.agent == 0 && d.sources.remote == 0)
    );
    assert_eq!(lib.write_seq().unwrap(), writes);
    let peers_after: i64 = lib
        .local_read(|conn| Ok(conn.query_row("SELECT count(*) FROM loro_peer", [], |r| r.get(0))?))
        .unwrap();
    assert_eq!(peers_before, peers_after);
}

#[test]
fn formatting_and_whitespace_are_not_organize_work_and_new_edits_remain() {
    let (_temp, lib, book, nodes) = setup(Preset::Tiny);
    let before = cursor(&lib, &book);
    let id: DocId = nodes[0].parse().unwrap();
    lib.open_doc(&nodes[0], OpenDoc::Existing)
        .unwrap()
        .write(Origin::User, move |raw| {
            let prose = BorrowedProse::new(raw, &id).unwrap();
            prose.txn().set_style(0..1, &InlineStyle::Bold).unwrap();
            prose.txn().insert_text(0, " ").unwrap();
        })
        .unwrap();
    let formatting = collect_delta(
        &lib,
        &request(&book, before, DeltaMode::LocalAuthorNodes, 12),
    )
    .unwrap();
    assert!(formatting.documents.is_empty());
    assert!(prepare_organize(&formatting).is_none());
    insert(&lib, &nodes[0], Origin::Command);
    let first = collect_delta(
        &lib,
        &request(&book, formatting.coverage, DeltaMode::LocalAuthorNodes, 12),
    )
    .unwrap();
    assert_eq!(first.documents.len(), 1);
    insert(&lib, &nodes[0], Origin::User);
    let overlapping = collect_delta(
        &lib,
        &request(&book, first.coverage, DeltaMode::LocalAuthorNodes, 12),
    )
    .unwrap();
    assert_eq!(
        overlapping.documents.len(),
        1,
        "post-capture edit, even in the same second"
    );
    assert!(overlapping.documents[0].has_baseline);
}

#[test]
fn bounded_batches_leave_the_thirteenth_document_unconsumed() {
    let (_temp, lib, book, nodes) = setup(Preset::Lite);
    for node in nodes.iter().take(13) {
        insert(&lib, node, Origin::User);
    }
    let first = collect_delta(
        &lib,
        &request(
            &book,
            DeltaCursor::default(),
            DeltaMode::LocalAuthorNodes,
            12,
        ),
    )
    .unwrap();
    assert_eq!(first.documents.len(), 12);
    assert_eq!(first.omitted, 1);
    assert!(
        first
            .documents
            .iter()
            .all(|d| d.digest.chars().count() <= DIGEST_CHAR_LIMIT + 1)
    );
    let mut next = request(&book, first.coverage, DeltaMode::LocalAuthorNodes, 12);
    next.since_ms = dr_store::now_ms() + 60_000;
    let second = collect_delta(&lib, &next).unwrap();
    assert_eq!(
        second.documents.len(),
        1,
        "new display horizon cannot hide omitted prose"
    );
    assert_eq!(second.omitted, 0);
    next.cursor = second.coverage;
    assert!(collect_delta(&lib, &next).unwrap().documents.is_empty());
}

fn start(revision: u64, id: &str, now: i64) -> SuggestionStart {
    SuggestionStart {
        expected_revision: revision,
        id: id.into(),
        now_ms: now,
        enabled: true,
        coverage: DeltaCursor::default(),
    }
}

#[test]
fn checkin_cas_cooldown_applies_after_failure_organize_and_restart() {
    let (_temp, lib, book, _nodes) = setup(Preset::Tiny);
    let ticket = ProactiveStore::begin_checkin(&lib, &book, &start(0, "first", 100))
        .unwrap()
        .unwrap();
    assert!(
        ProactiveStore::begin_checkin(&lib, &book, &start(0, "second", 100))
            .unwrap()
            .is_none()
    );
    assert!(ProactiveStore::fail_checkin(&lib, &book, &ticket, "fixture failure").unwrap());
    let state = ProactiveStore::load(&lib, &book).unwrap();
    let organize =
        ProactiveStore::claim_organize(&lib, &book, &start(state.revision, "organize", 200))
            .unwrap()
            .unwrap();
    assert!(ProactiveStore::settle_organize(&lib, &book, &organize, true).unwrap());
    let state = ProactiveStore::load(&lib, &book).unwrap();
    assert!(
        ProactiveStore::begin_checkin(&lib, &book, &start(state.revision, "too-soon", 200))
            .unwrap()
            .is_none()
    );
    let later = ProactiveStore::begin_checkin(
        &lib,
        &book,
        &start(state.revision, "later", 100 + CHECKIN_COOLDOWN_MS),
    )
    .unwrap()
    .unwrap();
    assert!(ProactiveStore::recover(&lib, &book).unwrap());
    assert!(
        !ProactiveStore::complete_checkin(&lib, &book, &later, &CheckinOutcome::default()).unwrap()
    );
    let state = ProactiveStore::load(&lib, &book).unwrap();
    assert!(
        ProactiveStore::begin_checkin(
            &lib,
            &book,
            &start(state.revision, "restart", 101 + CHECKIN_COOLDOWN_MS)
        )
        .unwrap()
        .is_none()
    );
    let mut disabled = start(state.revision, "disabled", 100 + CHECKIN_COOLDOWN_MS * 3);
    disabled.enabled = false;
    assert!(
        ProactiveStore::begin_checkin(&lib, &book, &disabled)
            .unwrap()
            .is_none()
    );
    assert_eq!(ProactiveStore::load(&lib, &book).unwrap(), state);
}

#[test]
fn card_claims_and_organize_settlement_are_idempotent() {
    let (_temp, lib, book, nodes) = setup(Preset::Tiny);
    let before = cursor(&lib, &book);
    insert(&lib, &nodes[0], Origin::User);
    let batch = collect_delta(
        &lib,
        &request(&book, before, DeltaMode::LocalAuthorNodes, 12),
    )
    .unwrap();
    let task = prepare_organize(&batch).unwrap();
    let mut begin = start(0, "organize", 100);
    begin.coverage = task.coverage;
    let ticket = ProactiveStore::claim_organize(&lib, &book, &begin)
        .unwrap()
        .unwrap();
    ProactiveStore::organize_started(&lib, &book, &ticket, "conversation").unwrap();
    ProactiveStore::settle_organize(&lib, &book, &ticket, false).unwrap();
    assert!(
        ProactiveStore::load(&lib, &book)
            .unwrap()
            .organize_cursor
            .documents
            .is_empty()
    );
    begin.expected_revision = ProactiveStore::load(&lib, &book).unwrap().revision;
    let ticket = ProactiveStore::claim_organize(&lib, &book, &begin)
        .unwrap()
        .unwrap();
    assert!(ProactiveStore::settle_organize(&lib, &book, &ticket, true).unwrap());
    assert!(!ProactiveStore::settle_organize(&lib, &book, &ticket, true).unwrap());
    assert_eq!(
        ProactiveStore::load(&lib, &book).unwrap().organize_cursor,
        batch.coverage
    );
    let state = ProactiveStore::load(&lib, &book).unwrap();
    let ticket = ProactiveStore::begin_checkin(&lib, &book, &start(state.revision, "cards", 200))
        .unwrap()
        .unwrap();
    let card = CheckinCard {
        id: "card".into(),
        title: nodes[0].clone(),
        detail: String::new(),
        instruction: "检查项目记忆".into(),
        target: None,
    };
    ProactiveStore::complete_checkin(
        &lib,
        &book,
        &ticket,
        &CheckinOutcome {
            cards: vec![card],
            ..CheckinOutcome::default()
        },
    )
    .unwrap();
    let claim = ProactiveStore::claim_card(&lib, &book, "card", "claim", true)
        .unwrap()
        .unwrap();
    assert!(
        ProactiveStore::claim_card(&lib, &book, "card", "duplicate", true)
            .unwrap()
            .is_none()
    );
    assert!(ProactiveStore::settle_card(&lib, &book, &claim, Some("opened-conversation")).unwrap());
    assert!(!ProactiveStore::settle_card(&lib, &book, &claim, None).unwrap());
    assert!(
        matches!(&ProactiveStore::load(&lib, &book).unwrap().cards[0].status, CardStatus::Started { conversation } if conversation == "opened-conversation")
    );
}

fn input(book: &BookId) -> CheckinInput {
    let mut config = RunConfig::new(Provider::Deepseek, "deepseek-v4-flash");
    config.route.thinking = ThinkingLevel::High;
    CheckinInput {
        book: book.clone(),
        attempt_id: "fixture-checkin".into(),
        config: Arc::new(config),
        context: CheckinContext {
            book_name: String::new(),
            now_ms: 1,
            since_ms: 0,
            mode: CheckinMode::Changes,
            documents: Vec::new(),
            project_memory: Vec::new(),
            working_memory: Some(String::new()),
            open_todos: Vec::new(),
            chapter_titles: Vec::new(),
        },
    }
}

#[test]
fn v3_delta_keeps_retained_bodies_without_inventing_a_novel_organize_task() {
    use dr_doc::v3::novel::{MOD_PROSE, TPL_CHARACTER};
    let dir = tempfile::tempdir().unwrap();
    let ws = dr_workspace::Workspace::open_dir(dir.path(), "k6-generic-delta").unwrap();
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
                .is_some_and(|t| t.as_str() == TPL_CHARACTER)
        })
        .unwrap();
    let doc = format!("body:{}/{MOD_PROSE}", entry.id);
    seeded.write_to(ws.library()).unwrap();
    let prose = ws
        .call(
            &dr_workspace::Actor::User,
            "prose.read",
            json!({"doc":doc,"limit":usize::MAX}),
        )
        .unwrap();
    let p = prose["output"]["paragraphs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["text"].as_str().is_some_and(|t| !t.is_empty()))
        .unwrap();
    ws.call(&dr_workspace::Actor::User, "prose.replace", json!({"doc":doc,"block_id":p["block_id"],"find":p["text"],"replace":"Synthetic retained-body edit"})).unwrap();
    ws.call(
        &dr_workspace::Actor::User,
        "entry_template.remove_module",
        json!({"book":book,"template":TPL_CHARACTER,"module":MOD_PROSE}),
    )
    .unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
        + 2000;
    let writes = ws.library().write_seq().unwrap();
    let batch = collect_delta(
        ws.library(),
        &DeltaRequest {
            book,
            since_ms: now - 86_400_000,
            captured_ms: now,
            mode: DeltaMode::LocalAuthorNodes,
            cursor: DeltaCursor::default(),
            limit: ORGANIZE_DOCUMENT_LIMIT,
        },
    )
    .unwrap();
    let changed = batch.documents.iter().find(|d| d.doc == doc).unwrap();
    assert_eq!(changed.target.kind, "entry");
    assert_eq!(changed.target.id, entry.id.as_str());
    assert!(prepare_organize(&batch).is_none());
    assert_eq!(writes, ws.library().write_seq().unwrap());
    ws.shutdown().unwrap();
}

fn call(arguments: serde_json::Value) -> DriverEvent {
    DriverEvent::TextDelta {
        index: 0,
        text: arguments.to_string(),
    }
}

#[test]
fn one_request_accepts_zero_to_four_cards_without_writes_or_config_mutation() {
    use dr_agent::driver::scripted::{ScriptedDriver, Step};
    let (_temp, lib, book, nodes) = setup(Preset::Tiny);
    let writes = lib.write_seq().unwrap();
    for count in 0..=4 {
        let cards: Vec<_> = (0..count).map(|_| json!({"title":"项目记忆", "instruction":"检查项目记忆中重复的内容", "target":null, "unexpected":"ignored"})).collect();
        let driver = Arc::new(ScriptedDriver::new(vec![vec![
            Step::Event(call(json!({"cards":cards,"maxItems":4}))),
            Step::Event(DriverEvent::Finish(FinishReason::Complete)),
        ]]));
        let mut input = input(&book);
        input.context.book_name = nodes[0].clone();
        let original = input.config.clone();
        let outcome = futures::executor::block_on(run_checkin(
            driver.clone(),
            input,
            Cancellation::default(),
        ))
        .unwrap();
        assert_eq!(outcome.cards.len(), count);
        let requests = driver.requests();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].purpose.is_single());
        assert!(requests[0].tools.is_empty());
        assert!(!requests[0].config.web_search);
        assert_eq!(requests[0].config.route.thinking, ThinkingLevel::High);
        assert!(original.web_search);
        assert!(original.system_prompt.is_empty());
    }
    assert_eq!(lib.write_seq().unwrap(), writes);
    assert!(
        lib.docs(Some(book.as_str()), Some("conversation"))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn invalid_cards_and_unknown_refs_never_authorize_internal_targets() {
    assert!(parse_checkin_cards(&json!({"cards":[{"title":"x"}]}), &[]).is_err());
    let too_many = vec![json!({"title":"x","instruction":"y"}); 5];
    assert!(parse_checkin_cards(&json!({"cards":too_many}), &[]).is_err());
    let cards = parse_checkin_cards(
        &json!({"cards":[{"title":"x","instruction":"y","target":"element:arbitrary"}]}),
        &[],
    )
    .unwrap();
    assert!(cards[0].target.is_none());
}

struct WaitingDriver {
    gate: Mutex<Option<oneshot::Receiver<()>>>,
    entered: Mutex<Option<std::sync::mpsc::Sender<()>>>,
    calls: AtomicUsize,
}

impl Driver for WaitingDriver {
    fn stream(
        &self,
        _request: DriverRequest,
        _cancel: Cancellation,
    ) -> BoxStream<'static, Result<DriverEvent>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let gate = self.gate.lock().unwrap().take().unwrap();
        self.entered
            .lock()
            .unwrap()
            .take()
            .unwrap()
            .send(())
            .unwrap();
        futures::stream::iter([
            Ok(call(json!({"cards":[]}))),
            Ok(DriverEvent::Finish(FinishReason::Complete)),
        ])
        .chain(
            futures::stream::once(async move {
                let _ = gate.await;
                None
            })
            .filter_map(futures::future::ready),
        )
        .boxed()
    }
}

#[test]
fn cancellation_still_waits_for_actual_stream_eof() {
    let (_temp, _lib, book, _nodes) = setup(Preset::Tiny);
    let (release, gate) = oneshot::channel();
    let (entered_tx, entered) = std::sync::mpsc::channel();
    let driver = Arc::new(WaitingDriver {
        gate: Mutex::new(Some(gate)),
        entered: Mutex::new(Some(entered_tx)),
        calls: AtomicUsize::new(0),
    });
    let cancel = Cancellation::default();
    let worker_cancel = cancel.clone();
    let worker_driver = driver.clone();
    let (done_tx, done) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        done_tx
            .send(futures::executor::block_on(run_checkin(
                worker_driver,
                input(&book),
                worker_cancel,
            )))
            .unwrap();
    });
    entered.recv_timeout(Duration::from_secs(5)).unwrap();
    cancel.cancel();
    assert!(done.recv_timeout(Duration::from_millis(50)).is_err());
    release.send(()).unwrap();
    assert!(done.recv_timeout(Duration::from_secs(5)).unwrap().is_err());
    worker.join().unwrap();
    assert_eq!(driver.calls.load(Ordering::SeqCst), 1);
}

#[test]
fn deleted_book_cannot_be_recreated_by_late_completion() {
    let (_temp, lib, book, _nodes) = setup(Preset::Tiny);
    let ticket = ProactiveStore::begin_checkin(&lib, &book, &start(0, "pending", 1))
        .unwrap()
        .unwrap();
    for doc in lib.docs(Some(book.as_str()), None).unwrap() {
        lib.purge_doc(&doc.doc_id).unwrap();
    }
    assert!(
        ProactiveStore::complete_checkin(&lib, &book, &ticket, &CheckinOutcome::default()).is_err()
    );
    assert!(
        lib.local_entries("agent.proactive", Some(book.as_str()))
            .unwrap()
            .is_empty()
    );
}
