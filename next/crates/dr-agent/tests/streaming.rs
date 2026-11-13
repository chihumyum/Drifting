//! Streamed text reaches the journal in batches (m27 "流式文字分批落盘"):
//! far fewer writes than deltas, the same message, written ahead of every
//! other event, and a crash between writes loses only the text streamed
//! since the last.

use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

use dr_agent::tools::ToolOutput;
use dr_agent::*;
use dr_model::DocId;
use dr_model::conversation::{ConversationEntry, ConversationEntryKind};
use dr_model::id::{BookId, ConversationId};
use dr_store::{Library, agent::AgentEventAppend};
use dr_testkit::seed::{self, Preset};
use dr_workspace::{Workspace, WorkspaceOptions, library_options};
use futures::channel::oneshot;
use futures::executor::block_on;
use futures::{FutureExt, StreamExt, future::BoxFuture, stream::BoxStream};
use serde_json::json;

const NAME: &str = "m27-streaming-test";
const HOUR: Duration = Duration::from_secs(3600);

struct Fixture {
    ws: Workspace,
    book: BookId,
    /// Seed prose, one character per delta.
    pieces: Vec<String>,
    dir: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open(dir.path(), library_options(NAME)).unwrap();
        let seeded = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        seeded.write_to(&lib).unwrap();
        let book = seeded.books[0].book_id().clone();
        let pieces: Vec<String> = seeded.books[0]
            .prose
            .iter()
            .flat_map(|prose| prose.view().paragraphs().map(|p| p.text()))
            .flat_map(|text| text.chars().map(String::from).collect::<Vec<_>>())
            .take(1200)
            .collect();
        assert!(pieces.len() >= 300, "seed prose is long enough to stream");
        let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
        Self {
            ws,
            book,
            pieces,
            dir,
        }
    }

    fn lib(&self) -> &Library {
        self.ws.library()
    }

    fn runtime(&self, streams: Vec<Script>, stream_flush: Duration) -> Runtime {
        runtime(&self.ws, streams, stream_flush)
    }

    fn start(&self, runtime: &Runtime, conversation: &ConversationId, input: &str) -> RunHandle {
        runtime
            .start(Start {
                config: RunConfig::new(Provider::Openai, "synthetic-model"),
                book: self.book.clone(),
                conversation: conversation.clone(),
                input: input.into(),
            })
            .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.ws.close();
    }
}

fn runtime(ws: &Workspace, streams: Vec<Script>, stream_flush: Duration) -> Runtime {
    Runtime::new(
        ws.clone(),
        Arc::new(Streams(Mutex::new(streams.into()))),
        Arc::new(ReadTool),
        Options {
            stream_flush,
            ..Options::default()
        },
    )
    .unwrap()
}

type Script = BoxStream<'static, Result<DriverEvent>>;

/// One prepared stream per model request.
struct Streams(Mutex<VecDeque<Script>>);

impl Driver for Streams {
    fn stream(&self, _: DriverRequest, _: Cancellation) -> Script {
        self.0.lock().unwrap().pop_front().unwrap_or_else(|| {
            futures::stream::once(async { Err(Error::Driver("no script left".into())) }).boxed()
        })
    }
}

/// Events, then a pause: `reached` is signalled once the runtime has handled
/// every event before it and asks for the next, then the stream waits for
/// `gate` (forever, if it is dropped) before the events after it.
fn paused(
    before: Vec<DriverEvent>,
    reached: mpsc::Sender<()>,
    gate: oneshot::Receiver<()>,
    after: Vec<DriverEvent>,
) -> Script {
    let pause = futures::stream::once(async move {
        reached.send(()).unwrap();
        if gate.await.is_err() {
            futures::future::pending::<()>().await;
        }
    })
    .filter_map(|()| async { None::<Result<DriverEvent>> });
    futures::stream::iter(before.into_iter().map(Ok))
        .chain(pause)
        .chain(futures::stream::iter(after.into_iter().map(Ok)))
        .boxed()
}

fn script(events: Vec<DriverEvent>) -> Script {
    futures::stream::iter(events.into_iter().map(Ok)).boxed()
}

fn deltas(pieces: &[String], thinking: bool, index: u32) -> Vec<DriverEvent> {
    pieces
        .iter()
        .map(|text| {
            let text = text.clone();
            if thinking {
                DriverEvent::ThinkingDelta { index, text }
            } else {
                DriverEvent::TextDelta { index, text }
            }
        })
        .collect()
}

fn finish() -> DriverEvent {
    DriverEvent::Finish(FinishReason::Complete)
}

fn search(id: &str) -> DriverEvent {
    DriverEvent::ProviderTool {
        activity: ProviderTool {
            id: id.into(),
            action: ProviderToolAction::Search,
            status: ProviderToolStatus::Completed,
            query: None,
            url: None,
        },
    }
}

struct ReadTool;

impl ToolExecutor for ReadTool {
    fn descriptors(&self) -> Vec<ToolDescriptor> {
        vec![ToolDescriptor {
            name: "read".into(),
            description: "read".into(),
            revision: "1".into(),
            input_schema: json!({"type": "object"}),
            access: ToolAccess::Read,
            policy: ToolPolicy::Local,
        }]
    }

    fn execute(&self, _: ToolContext, call: ToolCall) -> BoxFuture<'static, Result<ToolOutput>> {
        futures::future::ready(Ok(ToolOutput::Value(json!({"call": call.id})))).boxed()
    }
}

fn is_delta(event: &Event) -> bool {
    matches!(event, Event::TextDelta { .. } | Event::ThinkingDelta { .. })
}

fn delta_rows(log: &[JournalEvent]) -> usize {
    log.iter().filter(|row| is_delta(&row.event)).count()
}

/// The text of the journal's deltas, block by block in order of creation,
/// as every reader folds them: `(thinking, index, text)`.
fn folded(log: &[JournalEvent]) -> Vec<(bool, u32, String)> {
    let mut blocks: Vec<(bool, u32, String)> = Vec::new();
    for row in log {
        let (thinking, index, text) = match &row.event {
            Event::TextDelta { index, text } => (false, *index, text),
            Event::ThinkingDelta { index, text } => (true, *index, text),
            Event::StateChanged {
                state: State::Streaming,
            } => {
                blocks.clear();
                continue;
            }
            _ => continue,
        };
        match blocks.iter_mut().find(|b| b.0 == thinking && b.1 == index) {
            Some(block) => block.2.push_str(text),
            None => blocks.push((thinking, index, text.clone())),
        }
    }
    blocks
}

fn assistant_messages(log: &[JournalEvent]) -> Vec<AssistantMessage> {
    log.iter()
        .filter_map(|row| match &row.event {
            Event::AssistantMessage { message } => Some(message.clone()),
            _ => None,
        })
        .collect()
}

fn text_of(message: &AssistantMessage) -> String {
    message
        .blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

fn wait_until(mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !condition() {
        assert!(Instant::now() < deadline, "streaming condition timed out");
        std::thread::sleep(Duration::from_millis(2));
    }
}

/// The entries without their identities, which differ between libraries.
fn contents(entries: &[ConversationEntry]) -> Vec<(ConversationEntryKind, serde_json::Value)> {
    entries
        .iter()
        .map(|e| (e.kind.clone(), e.payload.clone()))
        .collect()
}

#[test]
fn a_stream_of_deltas_is_written_in_far_fewer_rows_with_the_same_message() {
    let (thinking, text) = {
        let f = Fixture::new();
        let half = f.pieces.len() / 3;
        (f.pieces[..half].to_vec(), f.pieces[half..].to_vec())
    };
    let n = thinking.len() + text.len();
    let run = |stream_flush: Duration| {
        let f = Fixture::new();
        let mut stream = deltas(&thinking, true, 0);
        stream.extend(deltas(&text, false, 1));
        stream.push(finish());
        let runtime = f.runtime(vec![script(stream)], stream_flush);
        let conversation = ConversationId::new_v7();
        let notified = Arc::new(Mutex::new(0_usize));
        let count = notified.clone();
        let _subscription = f.lib().subscribe(move |event| {
            if let dr_store::StoreEvent::Local(change) = event
                && change.table == dr_store::agent::EVENT_TABLE
            {
                *count.lock().unwrap() += 1;
            }
        });
        let handle = f.start(&runtime, &conversation, &text[0]);
        let session = handle.session.clone();
        assert_eq!(handle.join().unwrap(), State::Completed);
        let log = events(f.lib(), &session, 0).unwrap();
        let transcript = dr_agent::conversation(f.lib(), &conversation).unwrap();
        let rows = *notified.lock().unwrap();
        drop(runtime);
        (log, transcript, rows)
    };
    let (batched, batched_transcript, batched_rows) = run(Options::default().stream_flush);
    let (each, each_transcript, each_rows) = run(Duration::ZERO);

    // Unbatched, every delta is a row; batched, a handful for hundreds.
    assert_eq!(delta_rows(&each), n);
    assert!(
        delta_rows(&batched) * 10 <= n,
        "{} delta rows for {n} deltas",
        delta_rows(&batched)
    );
    assert_eq!(each_rows - batched_rows, n - delta_rows(&batched));
    assert_eq!(each.len() - batched.len(), n - delta_rows(&batched));

    // The same text in the journal, the same message, the same conversation.
    let expected = vec![(true, 0, thinking.concat()), (false, 1, text.concat())];
    assert_eq!(folded(&batched), expected);
    assert_eq!(folded(&each), expected);
    let message = assistant_messages(&batched);
    assert_eq!(message, assistant_messages(&each));
    assert!(message[0].complete);
    assert_eq!(text_of(&message[0]), text.concat());
    assert_eq!(contents(&batched_transcript), contents(&each_transcript));

    // Nothing but runs of one block's deltas were joined: the other events
    // are the same, in the same order.
    let others = |log: &[JournalEvent]| -> Vec<String> {
        log.iter()
            .filter(|row| !is_delta(&row.event))
            .map(|row| serde_json::to_string(&row.event).unwrap())
            .collect()
    };
    assert_eq!(others(&batched), others(&each));
}

/// With an interval that never elapses, the buffered text is written by
/// whatever ends it, in the same transaction, ahead of the event: the end of
/// the turn, a cancel (abort or stop), a driver error, and a protocol error
/// from the stream itself.
#[test]
fn buffered_text_is_written_when_the_turn_ends_is_cancelled_or_fails() {
    let f = Fixture::new();
    let piece = &f.pieces[..40];
    let text = piece.concat();
    let (reached, arrived) = mpsc::channel();
    let gates: Vec<_> = (0..2).map(|_| oneshot::channel::<()>()).collect();
    let mut gates = gates.into_iter();
    let (_keep_abort, abort_gate) = gates.next().unwrap();
    let (_keep_stop, stop_gate) = gates.next().unwrap();
    let mut conflicting = deltas(piece, false, 0);
    conflicting.extend(deltas(piece, true, 0));
    let runtime = f.runtime(
        vec![
            script([deltas(piece, false, 0), vec![finish()]].concat()),
            paused(deltas(piece, false, 0), reached.clone(), abort_gate, vec![]),
            paused(deltas(piece, false, 0), reached, stop_gate, vec![finish()]),
            futures::stream::iter(deltas(piece, false, 0).into_iter().map(Ok))
                .chain(futures::stream::once(async {
                    Err(Error::Driver("synthetic failure".into()))
                }))
                .boxed(),
            script(conflicting),
        ],
        HOUR,
    );
    let conversation = ConversationId::new_v7();
    // (outcome, the event the text must be written just ahead of)
    let mut sessions = Vec::new();

    let turn = f.start(&runtime, &conversation, &text);
    sessions.push((turn.session.clone(), "assistant_message"));
    assert_eq!(turn.join().unwrap(), State::Completed);

    let abort = f.start(&runtime, &conversation, &text);
    sessions.push((abort.session.clone(), "abort_requested"));
    arrived.recv_timeout(Duration::from_secs(10)).unwrap();
    let log = events(f.lib(), &abort.session, 0).unwrap();
    assert_eq!(
        delta_rows(&log),
        0,
        "an hour's interval: nothing written yet"
    );
    block_on(abort.control.abort()).unwrap();
    assert_eq!(abort.join().unwrap(), State::Aborted);

    let stop = f.start(&runtime, &conversation, &text);
    sessions.push((stop.session.clone(), "stop_requested"));
    arrived.recv_timeout(Duration::from_secs(10)).unwrap();
    block_on(stop.control.stop_after_tool()).unwrap();
    assert_eq!(stop.join().unwrap(), State::Stopped);

    let failed = f.start(&runtime, &conversation, &text);
    sessions.push((failed.session.clone(), "assistant_message"));
    assert!(matches!(failed.join(), Err(Error::Driver(_))));

    let protocol = f.start(&runtime, &conversation, &text);
    sessions.push((protocol.session.clone(), "assistant_message"));
    assert!(matches!(protocol.join(), Err(Error::Protocol(_))));

    for (session, next) in &sessions {
        let log = events(f.lib(), session, 0).unwrap();
        assert_eq!(delta_rows(&log), 1, "{next}: one row for forty deltas");
        let at = log.iter().position(|row| is_delta(&row.event)).unwrap();
        let following = serde_json::to_value(&log[at + 1].event).unwrap();
        assert_eq!(following["kind"], *next, "{next} follows the text");
        assert_eq!(folded(&log), vec![(false, 0, text.clone())]);
        let message = assistant_messages(&log);
        assert_eq!(message.len(), 1);
        assert_eq!(text_of(&message[0]), text);
    }
    // Every message is in the conversation with all its text.
    let transcript = dr_agent::conversation(f.lib(), &conversation).unwrap();
    let assistant: Vec<_> = transcript
        .iter()
        .filter(|e| e.kind == ConversationEntryKind::Assistant)
        .collect();
    assert_eq!(assistant.len(), sessions.len());
    for entry in assistant {
        let message: AssistantMessage = serde_json::from_value(entry.payload.clone()).unwrap();
        assert_eq!(text_of(&message), text);
    }
    assert!(runtime.recover().unwrap().is_empty());
    assert_eq!(
        dr_agent::conversation(f.lib(), &conversation).unwrap(),
        transcript
    );
}

/// While the stream is quiet, the buffered text is still written once its
/// interval is up, with no other event to carry it: the panel, which reads
/// the journal, sees it, and a crash would not lose it.
#[test]
fn a_quiet_stream_has_its_text_written_after_the_interval() {
    let f = Fixture::new();
    let piece = &f.pieces[..60];
    let (reached, arrived) = mpsc::channel();
    let (release, gate) = oneshot::channel();
    let runtime = f.runtime(
        vec![paused(
            deltas(piece, false, 0),
            reached,
            gate,
            vec![finish()],
        )],
        Duration::from_millis(20),
    );
    let conversation = ConversationId::new_v7();
    let run = f.start(&runtime, &conversation, &piece[0]);
    let session = run.session.clone();
    arrived.recv_timeout(Duration::from_secs(10)).unwrap();
    wait_until(|| delta_rows(&events(f.lib(), &session, 0).unwrap()) > 0);
    let log = events(f.lib(), &session, 0).unwrap();
    assert!(matches!(
        log[log.len() - 2].event,
        Event::StateChanged {
            state: State::Streaming
        }
    ));
    assert_eq!(folded(&log), vec![(false, 0, piece.concat())]);
    release.send(()).unwrap();
    assert_eq!(run.join().unwrap(), State::Completed);
    let log = events(f.lib(), &session, 0).unwrap();
    assert_eq!(folded(&log), vec![(false, 0, piece.concat())]);
    assert_eq!(text_of(&assistant_messages(&log)[0]), piece.concat());
}

/// What a crash leaves: SQLite's committed state, copied while the run is
/// paused between two writes of streamed text.
fn crash_copy(lib: &Library, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    let source = rusqlite::Connection::open_with_flags(
        &lib.paths().db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let target = to.join("library.sqlite");
    source
        .execute("VACUUM INTO ?1", [target.to_str().unwrap()])
        .unwrap();
}

/// A crash between two writes of streamed text: completed messages and tool
/// results survive whole, the journal is readable and in order, and the
/// recovered message has every character written before the last write,
/// only the text streamed since then missing.
#[test]
fn a_crash_between_writes_recovers_whole_messages_and_the_written_text() {
    let f = Fixture::new();
    let (first, rest) = f.pieces.split_at(80);
    let (written, unwritten) = rest.split_at(120);
    let unwritten = &unwritten[..unwritten.len().min(90)];
    let (reached, arrived) = mpsc::channel();
    let (release, gate) = oneshot::channel();
    let runtime = f.runtime(
        vec![
            script([deltas(first, false, 0), vec![finish()]].concat()),
            script(vec![
                DriverEvent::ToolCall(ToolCall {
                    id: "read-1".into(),
                    name: "read".into(),
                    arguments: json!({}),
                }),
                DriverEvent::Finish(FinishReason::Tools),
            ]),
            paused(
                [
                    deltas(written, false, 0),
                    vec![search("search-1")],
                    deltas(unwritten, false, 0),
                ]
                .concat(),
                reached,
                gate,
                vec![finish()],
            ),
        ],
        HOUR,
    );
    let conversation = ConversationId::new_v7();
    let one = f.start(&runtime, &conversation, &first[0]);
    assert_eq!(one.join().unwrap(), State::Completed);
    // The second request calls a tool, then streams `written`, which the
    // search event writes, then `unwritten`, still buffered (the interval is
    // an hour) when the copy is taken.
    let two = f.start(&runtime, &conversation, &written[0]);
    let session = two.session.clone();
    arrived.recv_timeout(Duration::from_secs(10)).unwrap();
    let crashed = f.dir.path().join("crashed");
    crash_copy(f.lib(), &crashed);
    release.send(()).unwrap();
    assert_eq!(two.join().unwrap(), State::Completed);
    let finished = dr_agent::conversation(f.lib(), &conversation).unwrap();

    let lib = Library::open(&crashed, library_options(NAME)).unwrap();
    let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
    {
        let log = events(ws.library(), &session, 0).unwrap();
        assert!(log.windows(2).all(|w| w[1].seq == w[0].seq + 1));
        assert_eq!(folded(&log), vec![(false, 0, written.concat())]);
        assert!(
            !matches!(
                log.last().unwrap().event,
                Event::StateChanged { state } if state.is_terminal()
            ),
            "the copy is of a run in flight"
        );
        let recovering = runtime_for(&ws);
        let recovered = recovering.recover().unwrap();
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].session, session);
        assert_eq!(recovered[0].state, State::Interrupted);
        let transcript = dr_agent::conversation(ws.library(), &conversation).unwrap();
        // Everything completed before the crash, whole and unchanged.
        assert_eq!(transcript[..5], finished[..5]);
        assert_eq!(transcript[4].kind, ConversationEntryKind::ToolResult);
        assert_eq!(transcript[4].payload["status"], "success");
        // The message in flight: all that was written, and only the text
        // streamed since the last write missing.
        assert_eq!(transcript.len(), 6);
        let partial: AssistantMessage =
            serde_json::from_value(transcript[5].payload.clone()).unwrap();
        assert!(!partial.complete);
        let full: AssistantMessage = serde_json::from_value(finished[5].payload.clone()).unwrap();
        assert!(full.complete);
        assert_eq!(text_of(&full), [written, unwritten].concat().concat());
        assert_eq!(text_of(&partial), written.concat());
        assert!(text_of(&full).starts_with(&text_of(&partial)));
        assert!(recovering.recover().unwrap().is_empty());
        drop(recovering);
    }
    ws.close();
}

fn runtime_for(ws: &Workspace) -> Runtime {
    runtime(ws, Vec::new(), HOUR)
}

fn append(lib: &Library, session: &str, seq: i64, turn: u32, event: Event) {
    lib.agent_append_event(&AgentEventAppend {
        session: session.into(),
        expected_seq: seq,
        event_json: json!({"turn": turn, "event": event}).to_string(),
    })
    .unwrap();
}

/// A run the process lost before its journal ended: written straight to the
/// journal, nothing projected.
fn lost_run(f: &Fixture, conversation: &ConversationId, session: &str, thinking: bool) {
    f.lib()
        .agent_create_session(
            session,
            &DocId::Conversation(conversation.clone()).to_string(),
            f.book.as_str(),
        )
        .unwrap();
    let text = f.pieces[..30].concat();
    let mut log = vec![
        Event::Started {
            version: PROTOCOL_VERSION,
        },
        Event::UserMessage { text: text.clone() },
        Event::StateChanged {
            state: State::Streaming,
        },
    ];
    if thinking {
        log.push(Event::ThinkingDelta {
            index: 0,
            text: text.clone(),
        });
    }
    log.push(Event::TextDelta { index: 1, text });
    if !thinking {
        let call = ToolCall {
            id: format!("{session}-call"),
            name: "read".into(),
            arguments: json!({}),
        };
        log.push(Event::ToolProposed { call: call.clone() });
        log.push(Event::ToolStarted { call });
    }
    for (seq, event) in log.into_iter().enumerate() {
        append(f.lib(), session, seq as i64, 1, event);
    }
}

fn settled(lib: &Library) -> HashMap<String, String> {
    lib.local_entries("agent.settled", None)
        .unwrap()
        .into_iter()
        .map(|entry| (entry.key, entry.value))
        .collect()
}

fn last_seqs(lib: &Library) -> HashMap<String, i64> {
    lib.agent_sessions(None)
        .unwrap()
        .into_iter()
        .map(|s| {
            let last = events(lib, &s.session, 0).unwrap().last().unwrap().seq;
            (s.session, last)
        })
        .collect()
}

/// Recovery of a library with several sessions in two conversations: runs
/// that completed, a run with a tool, and runs a crash left unfinished. A
/// session replayed in full is remembered and not replayed again while its
/// journal is unchanged; replaying everything again (as before marks
/// existed) finds nothing to change, so both give the same conversations.
#[test]
fn recovery_of_several_sessions_gives_the_same_conversations_and_settles_them() {
    let f = Fixture::new();
    let piece = &f.pieces[..50];
    let (x, y) = (ConversationId::new_v7(), ConversationId::new_v7());
    let runtime = f.runtime(
        vec![
            script([deltas(piece, false, 0), vec![finish()]].concat()),
            script(vec![
                DriverEvent::ToolCall(ToolCall {
                    id: "read-1".into(),
                    name: "read".into(),
                    arguments: json!({}),
                }),
                DriverEvent::Finish(FinishReason::Tools),
            ]),
            script(
                [
                    deltas(piece, true, 0),
                    deltas(piece, false, 1),
                    vec![finish()],
                ]
                .concat(),
            ),
            script([deltas(piece, false, 0), vec![finish()]].concat()),
        ],
        Options::default().stream_flush,
    );
    for conversation in [&x, &x, &y] {
        assert_eq!(
            f.start(&runtime, conversation, &piece[0]).join().unwrap(),
            State::Completed
        );
    }
    lost_run(&f, &x, "lost-with-a-call", false);
    lost_run(&f, &y, "lost-while-thinking", true);
    let sessions = f.lib().agent_sessions(None).unwrap();
    assert_eq!(sessions.len(), 5);
    let completed: Vec<_> = sessions
        .iter()
        .filter(|s| !s.session.starts_with("lost-"))
        .map(|s| s.session.clone())
        .collect();
    assert!(settled(f.lib()).is_empty());

    let recovered = runtime.recover().unwrap();
    let mut interrupted: Vec<_> = recovered.iter().map(|r| r.session.as_str()).collect();
    interrupted.sort();
    assert_eq!(interrupted, ["lost-while-thinking", "lost-with-a-call"]);
    assert!(recovered.iter().all(|r| r.state == State::Interrupted));
    let xs = dr_agent::conversation(f.lib(), &x).unwrap();
    let ys = dr_agent::conversation(f.lib(), &y).unwrap();
    let kinds = |entries: &[ConversationEntry]| -> Vec<String> {
        entries.iter().map(|e| e.kind.as_str().to_owned()).collect()
    };
    // Two completed requests, the second with a tool; then the lost run:
    // its author message, the partial message and the interrupted call.
    assert_eq!(
        kinds(&xs),
        [
            "user",
            "assistant",
            "user",
            "assistant",
            "tool_result",
            "assistant",
            "user",
            "assistant",
            "tool_result"
        ]
    );
    assert_eq!(xs[7].payload["complete"], false);
    assert_eq!(xs[8].payload["status"], "interrupted");
    assert_eq!(kinds(&ys), ["user", "assistant", "user", "assistant"]);
    let thought: AssistantMessage = serde_json::from_value(ys[3].payload.clone()).unwrap();
    assert!(!thought.complete);
    assert_eq!(thought.blocks.len(), 2);
    assert_eq!(text_of(&thought), f.pieces[..30].concat());

    // Every session is settled at the end of its journal.
    let seqs = last_seqs(f.lib());
    let marks = settled(f.lib());
    assert_eq!(marks.len(), 5);
    for (session, seq) in &seqs {
        assert_eq!(marks[session], format!("1:{PROTOCOL_VERSION}:{seq}"));
    }

    // Settled: nothing replayed, nothing written, the same conversations.
    assert!(runtime.recover().unwrap().is_empty());
    assert_eq!(dr_agent::conversation(f.lib(), &x).unwrap(), xs);
    assert_eq!(dr_agent::conversation(f.lib(), &y).unwrap(), ys);
    assert_eq!(last_seqs(f.lib()), seqs);

    // Without the marks every session is replayed in full, as before marks
    // existed; that changes nothing either, and settles them again.
    for session in seqs.keys() {
        assert!(f.lib().local_remove("agent.settled", session).unwrap());
    }
    assert!(runtime.recover().unwrap().is_empty());
    assert_eq!(dr_agent::conversation(f.lib(), &x).unwrap(), xs);
    assert_eq!(dr_agent::conversation(f.lib(), &y).unwrap(), ys);
    assert_eq!(last_seqs(f.lib()), seqs);
    assert_eq!(settled(f.lib()), marks);

    // A mark is only good for the journal it was taken at: a session whose
    // journal grew, or a mark of another format, is replayed again.
    let (grown, other) = (&completed[0], &completed[2]);
    append(
        f.lib(),
        grown,
        seqs[grown],
        1,
        Event::StateChanged {
            state: State::Streaming,
        },
    );
    f.lib()
        .local_set(
            "agent.settled",
            other,
            &format!("0:{PROTOCOL_VERSION}:{}", seqs[other]),
            None,
        )
        .unwrap();
    let recovered = runtime.recover().unwrap();
    assert_eq!(recovered.len(), 1);
    assert_eq!(&recovered[0].session, grown);
    let after = last_seqs(f.lib());
    assert_eq!(
        after[grown],
        seqs[grown] + 3,
        "Streaming, Recovered, Interrupted"
    );
    assert_eq!(after[other], seqs[other]);
    assert_eq!(settled(f.lib())[other], marks[other]);
    assert_eq!(dr_agent::conversation(f.lib(), &x).unwrap(), xs);
    assert_eq!(dr_agent::conversation(f.lib(), &y).unwrap(), ys);
    drop(runtime);
}
