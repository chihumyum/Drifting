//! CM4b real-window smoke: the Agent makes a custom module, puts it into
//! the chapter template and fills a chapter, the way 「跟 Agent 说」 goes
//! (`custom-modules.md` §8). Throwaway v3 Tiny testkit seed, a memory-only
//! synthetic credential, and a deterministic script standing in for a
//! model: each round is made from the results the run has so far, so the
//! ids a call returns reach the next call. Every provider address is
//! loopback and never asked. Never built into the App.
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use dr_agent::{
    Cancellation, Driver, DriverEvent as E, DriverRequest, FinishReason, Provider, ToolCall,
    driver::scripted::{ScriptedDriver, Step},
};
use dr_agent_providers::{
    Endpoints, HttpClient, ProviderDriver, RetryPolicy, credentials::Credentials,
    oauth::OAuthEndpoints,
};
use dr_doc::v3::novel::TPL_CHAPTER;
use dr_model::conversation::ConversationEntryKind;
use dr_shell::{
    Services, SettingsFile, ShellInfo,
    nav::{Open, Target},
    panes::PaneId,
    workspace::RightTab,
};
use dr_testkit::seed::{self, Preset};
use dr_workspace::Workspace;
use futures::stream::BoxStream;
use gpui::{App, Global};
use serde_json::{Value, json};

struct Fixture {
    _directory: tempfile::TempDir,
}
impl Global for Fixture {}

type Round = Box<dyn Fn(&[Value]) -> Vec<Step> + Send>;

/// One round per model request, made from the tool results so far.
struct Script {
    rounds: Mutex<VecDeque<Round>>,
}

impl Driver for Script {
    fn stream(
        &self,
        request: DriverRequest,
        cancel: Cancellation,
    ) -> BoxStream<'static, dr_agent::Result<E>> {
        let results: Vec<Value> = request
            .conversation
            .iter()
            .filter(|e| e.kind == ConversationEntryKind::ToolResult)
            .map(|e| e.payload.clone())
            .collect();
        let round = self.rounds.lock().expect("script").pop_front();
        let steps = round
            .map(|f| f(&results))
            .unwrap_or_else(|| vec![Step::Fail("script exhausted".into())]);
        ScriptedDriver::new(vec![steps]).stream(request, cancel)
    }
}

/// The output of tool call `id` among `results`.
fn of<'a>(results: &'a [Value], id: &str) -> &'a Value {
    results
        .iter()
        .find(|r| r["call"] == id)
        .map(|r| &r["output"]["output"])
        .unwrap_or(&Value::Null)
}

fn call(id: &str, name: &str, arguments: Value) -> Vec<Step> {
    vec![
        Step::Event(E::ToolCall(ToolCall {
            id: id.into(),
            name: "call_tool".into(),
            arguments: json!({"name":name,"arguments":arguments}),
        })),
        Step::Event(E::Finish(FinishReason::Tools)),
    ]
}

fn main() -> anyhow::Result<()> {
    let directory = tempfile::tempdir()?;
    let ws = Workspace::open_dir(directory.path(), "cm4b-modules-window-fixture")?;
    ws.set_auto_links(false);
    let seeded = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED)?;
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
        .id;
    seeded.write_to(ws.library())?;
    // Names the scenario finds the chapter and the entry it links to by.
    ws.call(
        &dr_workspace::Actor::User,
        "entry.update",
        json!({"book":book,"id":entry,"title":"CM4b chapter"}),
    )?;
    ws.call(
        &dr_workspace::Actor::User,
        "entry.create",
        json!({"book":book,"title":"CM4b clock tower","level":false}),
    )?;
    let mut module: Value = serde_json::from_str(include_str!(
        "../../dr-testkit/fixtures/modules/foreshadowing.driftingmodule"
    ))?;
    module.as_object_mut().expect("a module").remove("credit");
    let target = |extra: Value| {
        let mut base = json!({"entry":"CM4b chapter","module":"伏笔"});
        for (k, v) in extra.as_object().expect("extra") {
            base[k] = v.clone();
        }
        base
    };
    let item = |r: &[Value]| of(r, "add")["item"].clone();
    let rounds: Vec<Round> = vec![
        Box::new(move |_| call("create", "custom_module.create", json!({"value":module}))),
        Box::new(|_| call("templates", "entry_template.list", json!({}))),
        Box::new(|r| {
            call(
                "place",
                "entry_template.put_module",
                json!({"template":"tpl-chapter","module":{
                    "id":"mod-foreshadow","kind":"custom","name":"伏笔",
                    "config":{"module":of(r, "create")["id"]}
                }}),
            )
        }),
        Box::new(move |_| call("read-1", "module.read_custom", target(json!({})))),
        Box::new(move |_| {
            call(
                "add",
                "module.add_custom_item",
                target(json!({"list":"items"})),
            )
        }),
        Box::new(move |_| call("read-2", "module.read_custom", target(json!({})))),
        Box::new(move |r| {
            call(
                "line",
                "module.set_custom_value",
                target(json!({"path":[{"list":"items","item":item(r)}],
                    "block":"line","value":"钟楼的钟慢了七分钟"})),
            )
        }),
        Box::new(move |_| call("read-3", "module.read_custom", target(json!({})))),
        Box::new(move |r| {
            call(
                "state",
                "module.set_custom_value",
                target(json!({"path":[{"list":"items","item":item(r)}],
                    "block":"st","value":"埋着"})),
            )
        }),
        Box::new(move |_| call("read-4", "module.read_custom", target(json!({})))),
        Box::new(move |r| {
            call(
                "back",
                "module.set_custom_value",
                target(json!({"path":[{"list":"items","item":item(r)}],
                    "block":"back","value":"CM4b clock tower"})),
            )
        }),
        Box::new(|_| {
            vec![
                Step::Event(E::TextDelta {
                    index: 0,
                    text: "建好了「伏笔追踪」，放进了章节模板，填了这一章的一条伏笔。".into(),
                }),
                Step::Event(E::Finish(FinishReason::Complete)),
            ]
        }),
    ];
    // Presence enables the composer; the script never calls this provider.
    // Even an accidental connection/catalog request cannot leave localhost.
    let base = "http://127.0.0.1:9";
    let provider = ProviderDriver::with_endpoints(
        HttpClient::new()?,
        Credentials::candidate(Provider::Deepseek, "synthetic-cm4b-window-credential")?,
        Endpoints {
            deepseek: format!("{base}/chat/completions"),
            anthropic: format!("{base}/messages"),
            openai: format!("{base}/responses"),
            chatgpt: format!("{base}/responses"),
        },
        OAuthEndpoints::at(base)?,
        RetryPolicy::default(),
    );
    let mut connection = dr_view_agent::connection::ConnectionService::new(provider);
    for provider in [
        Provider::Deepseek,
        Provider::Anthropic,
        Provider::Openai,
        Provider::Chatgpt,
    ] {
        connection = connection.with_catalog_endpoint(provider, format!("{base}/models"));
    }
    gpui_platform::application()
        .with_assets(dr_ui::Assets::new())
        .run(move |cx: &mut App| {
            dr_ui::init(cx).expect("pinned fonts");
            let mut file = SettingsFile::in_memory();
            file.set(
                dr_shell::settings::registry::UI_LOCALE,
                json!("zh-CN"),
                None,
            )
            .unwrap();
            dr_shell::init(
                ShellInfo {
                    app_name: "Drifting Next",
                    bundle_id: "cc.drifting.next.dev",
                    version: "cm4b-modules-window-fixture",
                    url_scheme: "drifting-next-dev",
                    forced_appearance: Some(dr_ui::Appearance::Light),
                },
                Services {
                    library: Some(ws),
                    book: Some(book.to_string()),
                    ..Default::default()
                },
                file,
                cx,
            );
            dr_view_agent::init_with_service(
                connection,
                Arc::new(Script {
                    rounds: Mutex::new(rounds.into()),
                }),
                Arc::new(dr_view_agent::tools::CompanionTools::default()),
                cx,
            );
            cx.set_global(Fixture {
                _directory: directory,
            });
            let handle =
                dr_shell::open_workspace(cx, |window, _| window.activate_window()).unwrap();
            handle
                .update(cx, |workspace, _, cx| {
                    workspace.open(
                        Target::Entry {
                            id: entry,
                            module: None,
                        },
                        Open::KEEP,
                        cx,
                    );
                    workspace
                        .right
                        .panes
                        .click(PaneId::Primary, RightTab::Companion);
                    cx.notify();
                })
                .unwrap();
            dr_debug_bridge::start(cx);
        });
    Ok(())
}
