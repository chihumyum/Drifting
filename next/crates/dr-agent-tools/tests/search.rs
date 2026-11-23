//! The Agent's search tools: `entry.search` and `entry.mentions` reach the
//! model through the same catalog as every other registry query, resolve
//! names the same way, grant no read coverage, and a model that searches can
//! read and edit the paragraph it found. Synthetic text only.

use std::sync::{Arc, Mutex};

use dr_agent::driver::{Driver, DriverEvent, DriverRequest, FinishReason};
use dr_agent::{
    Cancellation, Event, Options, Provider, RunConfig, Runtime, Start, State, ToolAccess, ToolCall,
    ToolResult, ToolStatus, events,
};
use dr_agent_tools::catalog::{Catalog, Search};
use dr_agent_tools::{AgentTools, CallRequest, Error};
use dr_model::conversation::ConversationEntryKind;
use dr_model::id::{BookId, ConversationId};
use dr_testkit::seed::acceptance::novel_entry_as;
use dr_workspace::{Actor, Workspace};
use futures::StreamExt;
use futures::stream::BoxStream;
use serde_json::{Value, json};

struct Fixture {
    ws: Workspace,
    book: BookId,
    anna: String,
    chapter: String,
    _dir: tempfile::TempDir,
}

impl Fixture {
    /// A character 安娜 (alias 小安) and a chapter the Agent wrote, so its
    /// names are linked.
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::open_dir(dir.path(), "k6-search-test").unwrap();
        let book = ws
            .call(
                &Actor::User,
                "project.create",
                json!({"name": "Synthetic search book"}),
            )
            .unwrap()["output"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let id = |v: Value| v["id"].as_str().unwrap().to_owned();
        let anna = id(novel_entry_as(
            &Actor::User,
            &ws,
            &book,
            "tpl-character",
            "安娜",
            None,
        ));
        ws.call(
            &Actor::User,
            "module.set_field",
            json!({"book": book, "entry": anna, "module": "mod-fields",
                   "field": "aliases", "value": ["小安"]}),
        )
        .unwrap();
        let chapter = id(novel_entry_as(
            &Actor::agent("setup", 1, "write"),
            &ws,
            &book,
            "tpl-chapter",
            "第一章",
            Some("雨下了一整夜。\n小安在灯塔下等船回来。\n天亮时安娜睡着了。"),
        ));
        Self {
            ws,
            book: BookId::parse(&book).unwrap(),
            anna,
            chapter,
            _dir: dir,
        }
    }

    fn doc(&self) -> String {
        format!("body:{}/mod-prose", self.chapter)
    }

    fn invoke(
        &self,
        tools: &AgentTools,
        actor: &Actor,
        name: &str,
        arguments: Value,
    ) -> dr_agent_tools::Result<Value> {
        tools.invoke(
            &self.ws,
            &self.book,
            actor,
            CallRequest {
                name: name.into(),
                arguments,
                revision: None,
                edited_text: None,
            },
        )
    }

    fn paragraphs(&self) -> Vec<String> {
        self.ws
            .call(&Actor::User, "prose.read", json!({"doc": self.doc()}))
            .unwrap()["output"]["paragraphs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["text"].as_str().unwrap().to_owned())
            .collect()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.ws.close();
    }
}

#[test]
fn both_tools_are_book_reads_the_model_can_find() {
    let f = Fixture::new();
    let catalog = Catalog::for_book(&f.ws, &f.book).unwrap();
    for name in ["entry.search", "entry.mentions"] {
        let descriptor = catalog.descriptor(name).expect(name);
        assert_eq!(descriptor.access, ToolAccess::Read, "{name}");
        assert!(
            descriptor.input_schema["properties"].get("book").is_none(),
            "{name}"
        );
    }
    let mentions = catalog.descriptor("entry.mentions").unwrap();
    assert!(
        mentions.input_schema["properties"]["entry"]["description"]
            .as_str()
            .unwrap()
            .contains("exact author name")
    );
    // What a model looking for a way to search or for links types.
    for (query, name) in [
        ("search", "entry.search"),
        ("phrase", "entry.search"),
        ("link to an entry", "entry.mentions"),
        ("mentions", "entry.mentions"),
    ] {
        let found = catalog.search(Search {
            query: query.into(),
            offset: 0,
            limit: 50,
        });
        assert!(
            found["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|t| t["name"] == name),
            "{query} → {name}"
        );
    }
}

#[test]
fn mentions_take_an_entry_by_name_or_alias_and_search_grants_no_read() {
    let f = Fixture::new();
    let tools = AgentTools::new();
    let actor = Actor::agent("k6-search", 1, "call");
    for name in ["安娜", "小安", f.anna.as_str()] {
        let out = f
            .invoke(&tools, &actor, "entry.mentions", json!({"entry": name}))
            .unwrap();
        assert_eq!(out["output"]["entry"], f.anna, "{name}");
        assert_eq!(out["output"]["total"], 2, "{name}");
        assert_eq!(out["output"]["mentions"][0]["doc"], f.doc(), "{name}");
    }
    assert!(matches!(
        f.invoke(
            &tools,
            &actor,
            "entry.mentions",
            json!({"entry": "不存在的人"})
        ),
        Err(Error::Invalid(_))
    ));
    // A trashed entry is named only when the trash is asked for.
    f.ws.call(
        &Actor::User,
        "entry.trash",
        json!({"book": f.book.as_str(), "id": f.anna}),
    )
    .unwrap();
    assert!(
        f.invoke(&tools, &actor, "entry.mentions", json!({"entry": "安娜"}))
            .is_err()
    );
    let out = f
        .invoke(
            &tools,
            &actor,
            "entry.mentions",
            json!({"entry": "安娜", "trashed": true}),
        )
        .unwrap();
    assert_eq!(out["output"]["entry"], f.anna);
    // A search hit is not a read: the paragraph it shows cannot be edited
    // until it is read.
    let found = f
        .invoke(
            &tools,
            &actor,
            "entry.search",
            json!({"query": "灯塔下等船"}),
        )
        .unwrap();
    let hit = &found["output"]["hits"][0];
    assert_eq!(hit["doc"], f.doc());
    assert_eq!(hit["paragraph"], 1);
    assert!(matches!(
        f.invoke(
            &tools,
            &actor,
            "prose.replace",
            json!({"doc": f.doc(), "block_id": hit["block_id"], "find": "等船", "replace": "等渡船"}),
        ),
        Err(Error::ReadRequired(_))
    ));
}

/// A model that searches, reads the paragraph of the first hit and edits it:
/// each call is built from the tool result before it, as a model would.
struct Searcher {
    query: &'static str,
    /// Requests so far, and the first hit of the search.
    state: Mutex<(u32, Value)>,
}

fn last_output(request: &DriverRequest) -> Value {
    request
        .conversation
        .iter()
        .rev()
        .find(|e| e.kind == ConversationEntryKind::ToolResult)
        .map(|e| e.payload["output"]["output"].clone())
        .unwrap_or(Value::Null)
}

fn call_tool(id: &str, name: &str, arguments: Value) -> Vec<DriverEvent> {
    vec![
        DriverEvent::ToolCall(ToolCall {
            id: id.into(),
            name: "call_tool".into(),
            arguments: json!({"name": name, "arguments": arguments}),
        }),
        DriverEvent::Finish(FinishReason::Tools),
    ]
}

impl Driver for Searcher {
    fn stream(
        &self,
        request: DriverRequest,
        _cancel: Cancellation,
    ) -> BoxStream<'static, dr_agent::Result<DriverEvent>> {
        let last = last_output(&request);
        let mut state = self.state.lock().unwrap();
        state.0 += 1;
        let events = match state.0 {
            1 => call_tool("search", "entry.search", json!({"query": self.query})),
            2 => {
                state.1 = last["hits"][0].clone();
                let hit = &state.1;
                call_tool(
                    "read",
                    "prose.read",
                    json!({"doc": hit["doc"], "from": hit["paragraph"], "limit": 1}),
                )
            }
            3 => call_tool(
                "write",
                "prose.replace",
                json!({
                    "doc": state.1["doc"],
                    "block_id": last["paragraphs"][0]["block_id"],
                    "find": "等船",
                    "replace": "等渡船",
                }),
            ),
            _ => vec![
                DriverEvent::TextDelta {
                    index: 0,
                    text: "改好了。".into(),
                },
                DriverEvent::Finish(FinishReason::Complete),
            ],
        };
        futures::stream::iter(events.into_iter().map(Ok)).boxed()
    }
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

#[test]
fn a_scripted_model_searches_then_reads_and_edits_the_hit_it_found() {
    let f = Fixture::new();
    let tools = Arc::new(AgentTools::new());
    let driver = Arc::new(Searcher {
        query: "灯塔下等船",
        state: Mutex::new((0, Value::Null)),
    });
    let runtime = Runtime::new(
        f.ws.clone(),
        driver.clone(),
        tools.clone(),
        Options::default(),
    )
    .unwrap();
    let run = runtime
        .start(Start {
            config: {
                let mut c = RunConfig::new(Provider::Openai, "synthetic-model");
                c.capabilities = Some(dr_agent::ModelCapabilities {
                    context_window: Some(262_144),
                    ..Default::default()
                });
                c
            },
            book: f.book.clone(),
            conversation: ConversationId::new_v7(),
            input: "把小安等船那句改成等渡船。".into(),
        })
        .unwrap();
    let session = run.session.clone();
    assert_eq!(run.join().unwrap(), State::Completed);
    assert_eq!(driver.state.lock().unwrap().0, 4);
    let search = result(&f.ws, &session, "search");
    assert_eq!(search.status, ToolStatus::Success, "{:?}", search.output);
    let hits = search.output["output"]["hits"].as_array().unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0]["doc"], f.doc());
    assert_eq!(hits[0]["in"], "prose");
    assert_eq!(hits[0]["title"], "第一章");
    assert_eq!(hits[0]["snippet"], "小安在灯塔下等船回来。");
    let read = result(&f.ws, &session, "read");
    assert_eq!(read.status, ToolStatus::Success, "{:?}", read.output);
    assert_eq!(
        read.output["output"]["paragraphs"][0]["text"],
        "小安在灯塔下等船回来。"
    );
    assert_eq!(
        read.output["output"]["paragraphs"][0]["block_id"],
        hits[0]["block_id"]
    );
    let write = result(&f.ws, &session, "write");
    assert_eq!(write.status, ToolStatus::Success, "{:?}", write.output);
    assert_eq!(
        f.paragraphs(),
        [
            "雨下了一整夜。",
            "小安在灯塔下等渡船回来。",
            "天亮时安娜睡着了。"
        ]
    );
    // Searching again finds the new words at once, through the same tools.
    let actor = Actor::agent(&session, 2, "again");
    let again = f
        .invoke(&tools, &actor, "entry.search", json!({"query": "等渡船"}))
        .unwrap();
    assert_eq!(again["output"]["hits"][0]["paragraph"], 1);
}
