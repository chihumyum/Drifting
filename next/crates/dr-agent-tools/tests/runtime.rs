//! The real M27 scheduler calls the two M29 envelopes over a synthetic book.

use std::sync::Arc;
use std::time::{Duration, Instant};

use dr_agent::driver::scripted::{ScriptedDriver, Step};
use dr_agent::{
    DriverEvent, Event, FinishReason, Options, Provider, RunConfig, Runtime, Start, State,
    ToolAccess, ToolCall, ToolExecutor, ToolResult, ToolStatus, events,
};
use dr_agent_tools::{AgentTools, CallRequest, Error};
use dr_model::id::{BookId, ConversationId};
use dr_testkit::seed::{self, Preset};
use dr_workspace::{Actor, Workspace};
use futures::channel::oneshot;
use serde_json::{Value, json};

struct Fixture {
    ws: Workspace,
    book: BookId,
    doc: String,
    title: String,
    prose: Value,
    _dir: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::open_dir(dir.path(), "m29-runtime-test").unwrap();
        ws.set_auto_links(false);
        let seeded = seed::generate(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        seeded.write_to(ws.library()).unwrap();
        let book = seeded.books[0].book_id().clone();
        let chapters = ws
            .call(&Actor::User, "chapter.list", json!({"book":book}))
            .unwrap();
        let chapter = &chapters["output"][0];
        let doc = format!("node:{}", chapter["id"].as_str().unwrap());
        let prose = ws
            .call(
                &Actor::User,
                "prose.read",
                json!({"doc":doc,"limit":usize::MAX}),
            )
            .unwrap()["output"]
            .clone();
        Self {
            ws,
            book,
            doc,
            title: chapter["title"].as_str().unwrap().into(),
            prose,
            _dir: dir,
        }
    }

    fn selector(&self) -> Value {
        json!({"kind":"chapter","name":self.title})
    }

    fn text(&self) -> &str {
        self.prose["paragraphs"][1]["text"].as_str().unwrap()
    }

    fn start(&self) -> Start {
        Start {
            config: RunConfig::new(Provider::Openai, "synthetic-model"),
            book: self.book.clone(),
            conversation: ConversationId::new_v7(),
            input: self.text().into(),
        }
    }

    fn current(&self) -> Value {
        self.ws
            .call(
                &Actor::User,
                "prose.read",
                json!({"doc":self.doc,"limit":usize::MAX}),
            )
            .unwrap()["output"]
            .clone()
    }

    fn read_call(&self, id: &str) -> ToolCall {
        call(
            id,
            "prose.read",
            json!({"doc":self.selector(),"limit":usize::MAX}),
        )
    }

    fn write_call(&self, id: &str) -> ToolCall {
        call(
            id,
            "prose.replace",
            json!({
                "doc":self.selector(),"block_id":self.prose["paragraphs"][1]["block_id"],
                "find":self.text(),"replace":self.text().chars().rev().collect::<String>()
            }),
        )
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.ws.close();
    }
}

fn call(id: &str, name: &str, arguments: Value) -> ToolCall {
    ToolCall {
        id: id.into(),
        name: "call_tool".into(),
        arguments: json!({"name":name,"arguments":arguments}),
    }
}

fn tool_round(call: ToolCall) -> Vec<Step> {
    vec![
        Step::Event(DriverEvent::ToolCall(call)),
        Step::Event(DriverEvent::Finish(FinishReason::Tools)),
    ]
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

fn result(ws: &Workspace, session: &str, call: &str) -> ToolResult {
    events(ws.library(), session, 0)
        .unwrap()
        .into_iter()
        .find_map(|row| match row.event {
            Event::ToolFinished { result } if result.call == call => Some(result),
            _ => None,
        })
        .unwrap_or_else(|| panic!("missing result for {call}"))
}

fn invoke(
    tools: &AgentTools,
    fixture: &Fixture,
    actor: &Actor,
    name: &str,
    arguments: Value,
) -> dr_agent_tools::Result<Value> {
    tools.invoke(
        &fixture.ws,
        &fixture.book,
        actor,
        CallRequest {
            name: name.into(),
            arguments,
            revision: None,
            edited_text: None,
        },
    )
}

fn wait_until(mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !condition() {
        assert!(
            Instant::now() < deadline,
            "scripted runtime condition timed out"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
}

#[test]
fn scripted_discovery_name_resolution_write_receipt_and_exact_turn_undo() {
    let fixture = Fixture::new();
    let tools = Arc::new(AgentTools::new());
    let descriptors = tools.descriptors();
    assert_eq!(descriptors.len(), 2);
    assert_eq!(
        descriptors
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>(),
        ["tool_search", "call_tool"]
    );
    let read_descriptor = tools.describe(&fixture.read_call("read")).unwrap();
    let write_descriptor = tools.describe(&fixture.write_call("write")).unwrap();
    assert_eq!(read_descriptor.name, "prose.read");
    assert_eq!(read_descriptor.access, ToolAccess::Read);
    assert_eq!(write_descriptor.name, "prose.replace");
    assert_eq!(write_descriptor.access, ToolAccess::Write);
    assert_ne!(read_descriptor.revision, write_descriptor.revision);
    let driver = Arc::new(ScriptedDriver::new(vec![
        tool_round(ToolCall {
            id: "search".into(),
            name: "tool_search".into(),
            arguments: json!({"query":"prose","limit":50}),
        }),
        tool_round(call("chapters", "chapter.list", json!({}))),
        tool_round(fixture.read_call("read")),
        tool_round(fixture.write_call("write")),
        complete(fixture.text()),
    ]));
    let runtime = Runtime::new(
        fixture.ws.clone(),
        driver.clone(),
        tools.clone(),
        Options::default(),
    )
    .unwrap();
    let run = runtime.start(fixture.start()).unwrap();
    let session = run.session.clone();
    assert_eq!(run.join().unwrap(), State::Completed);
    let requests = driver.requests();
    assert_eq!(requests.len(), 5);
    assert!(requests.iter().all(|request| request.tools == descriptors));
    let search = result(&fixture.ws, &session, "search");
    assert_eq!(search.status, ToolStatus::Success);
    assert!(
        search.output["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["name"] == "prose.replace")
    );
    let chapters = result(&fixture.ws, &session, "chapters");
    assert_eq!(chapters.status, ToolStatus::Success);
    assert!(
        chapters.output["output"]
            .as_array()
            .unwrap()
            .iter()
            .any(|chapter| chapter["title"] == fixture.title)
    );
    let read = result(&fixture.ws, &session, "read");
    assert_eq!(read.status, ToolStatus::Success);
    assert_eq!(read.output["output"]["projection"]["doc"], fixture.doc);
    let write = result(&fixture.ws, &session, "write");
    assert_eq!(write.status, ToolStatus::Success, "{:?}", write.output);
    assert_eq!(write.settlements.len(), 1);
    let receipts = fixture
        .ws
        .library()
        .settlements(Some(&session), None)
        .unwrap();
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0].doc_id, fixture.doc);
    assert_eq!(receipts[0].call, "write");
    assert_eq!(receipts[0].turn, "1");
    assert_eq!(
        fixture.current()["paragraphs"][1]["text"],
        fixture.text().chars().rev().collect::<String>()
    );
    assert!(
        !events(fixture.ws.library(), &session, 0)
            .unwrap()
            .iter()
            .any(|row| matches!(row.event, Event::PermissionAsked { .. }))
    );

    // chapter.list observed the book and chapter before the prose-only
    // write. Even that still-current observation is gone at run settlement.
    let finished_actor = Actor::agent(&session, 1, "after-completion");
    assert!(matches!(
        invoke(
            &tools,
            &fixture,
            &finished_actor,
            "chapter.update",
            json!({"id":fixture.doc.strip_prefix("node:").unwrap(),"title":fixture.title})
        ),
        Err(Error::ReadRequired(_))
    ));

    // A new turn cannot borrow the old turn's observations, even though it
    // deliberately requests the old turn's exact settlement scope.
    let actor = Actor::agent(&session, 2, "undo-first-turn");
    let scope = json!({"session":session,"turn":1});
    assert!(matches!(
        invoke(
            &tools,
            &fixture,
            &actor,
            "history.undo_agent",
            scope.clone()
        ),
        Err(Error::ReadRequired(_))
    ));
    let changes = invoke(
        &tools,
        &fixture,
        &actor,
        "history.agent_changes",
        scope.clone(),
    )
    .unwrap();
    assert_eq!(changes["output"].as_array().unwrap().len(), 1);
    assert_eq!(changes["output"][0]["turn"], "1");
    invoke(
        &tools,
        &fixture,
        &actor,
        "prose.read",
        json!({"doc":fixture.selector(),"limit":usize::MAX}),
    )
    .unwrap();
    let undone = invoke(&tools, &fixture, &actor, "history.undo_agent", scope).unwrap();
    assert_eq!(undone["output"]["reverted_prose"], json!([fixture.doc]));
    assert_eq!(undone["output"]["conflicts"], json!([]));
    assert_eq!(fixture.current()["paragraphs"], fixture.prose["paragraphs"]);
    let receipts = fixture
        .ws
        .library()
        .settlements(Some(&session), None)
        .unwrap();
    assert!(
        receipts
            .iter()
            .any(|receipt| receipt.turn == "2" && receipt.call == "undo-first-turn")
    );
}

#[test]
fn second_conflict_stops_the_turn_without_a_fifth_model_request_or_receipt() {
    let fixture = Fixture::new();
    let tools = Arc::new(AgentTools::new());
    let (release_first, wait_first) = oneshot::channel();
    let (release_second, wait_second) = oneshot::channel();
    let mut first_write = vec![Step::Wait(wait_first)];
    first_write.extend(tool_round(fixture.write_call("write-first")));
    let mut second_write = vec![Step::Wait(wait_second)];
    second_write.extend(tool_round(fixture.write_call("write-second")));
    let driver = Arc::new(ScriptedDriver::new(vec![
        tool_round(fixture.read_call("read-first")),
        first_write,
        tool_round(fixture.read_call("read-again")),
        second_write,
        complete(fixture.text()),
    ]));
    let runtime = Runtime::new(
        fixture.ws.clone(),
        driver.clone(),
        tools,
        Options::default(),
    )
    .unwrap();
    let run = runtime.start(fixture.start()).unwrap();
    let session = run.session.clone();
    // Mutate a different paragraph so the original exact replacement is
    // still present: only the document revision guard can detect staleness.
    let other = &fixture.prose["paragraphs"][0];
    let mut author_text = other["text"].as_str().unwrap().to_owned();
    assert!(!author_text.is_empty());
    wait_until(|| driver.requests().len() == 2);
    let after_first = format!("{author_text}{}", fixture.text().chars().next().unwrap());
    fixture.ws.call(&Actor::User, "prose.replace", json!({"doc":fixture.doc,"block_id":other["block_id"],"find":author_text,"replace":after_first})).unwrap();
    author_text = after_first;
    release_first.send(()).unwrap();
    wait_until(|| driver.requests().len() == 4);
    let first = result(&fixture.ws, &session, "write-first");
    assert_eq!(first.status, ToolStatus::Error);
    assert_eq!(first.output["error"]["code"], "conflict");
    assert!(first.settlements.is_empty());
    assert_eq!(
        result(&fixture.ws, &session, "read-again").status,
        ToolStatus::Success
    );
    let after_second = format!("{author_text}{}", fixture.text().chars().next().unwrap());
    fixture.ws.call(&Actor::User, "prose.replace", json!({"doc":fixture.doc,"block_id":other["block_id"],"find":author_text,"replace":after_second})).unwrap();
    release_second.send(()).unwrap();
    assert_eq!(run.join().unwrap(), State::Stopped);
    assert_eq!(
        driver.requests().len(),
        4,
        "a second conflict must not sample again"
    );
    let second = result(&fixture.ws, &session, "write-second");
    assert_eq!(second.status, ToolStatus::Error);
    assert_eq!(second.output["error"]["code"], "conflict_limit");
    assert!(second.settlements.is_empty());
    assert!(
        fixture
            .ws
            .library()
            .settlements(Some(&session), None)
            .unwrap()
            .is_empty()
    );
    let current = fixture.current();
    assert_eq!(current["paragraphs"][0]["text"], after_second);
    assert_eq!(current["paragraphs"][1]["text"], fixture.text());
    assert!(
        events(fixture.ws.library(), &session, 0)
            .unwrap()
            .iter()
            .any(|row| matches!(
                row.event,
                Event::StateChanged {
                    state: State::Stopped
                }
            ))
    );
}
