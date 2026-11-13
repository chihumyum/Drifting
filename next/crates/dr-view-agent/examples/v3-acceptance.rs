//! Real-window K6 smoke: v3 testkit book, memory-only synthetic credentials,
//! recorded model events. Every unused provider endpoint is loopback as well.
use std::sync::Arc;

use dr_agent::{
    DriverEvent as E, FinishReason, Provider, ToolCall,
    driver::scripted::{ScriptedDriver, Step},
};
use dr_agent_providers::{
    Endpoints, HttpClient, ProviderDriver, RetryPolicy, credentials::Credentials,
    oauth::OAuthEndpoints,
};
use dr_doc::v3::novel::{MOD_PROSE, TPL_CHAPTER};
use dr_shell::{
    Services, SettingsFile, ShellInfo,
    nav::{Open, Target},
    panes::PaneId,
    workspace::RightTab,
};
use dr_testkit::seed::{self, Preset};
use dr_workspace::Workspace;
use gpui::{App, Global};
use serde_json::{Value, json};

struct Fixture {
    _directory: tempfile::TempDir,
}
impl Global for Fixture {}
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
    let ws = Workspace::open_dir(directory.path(), "k6-v3-window-fixture")?;
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
    let parent_level = ws.call(
        &dr_workspace::Actor::User,
        "entry.create",
        json!({"book":book,"title":"V4 smoke parent","level":true}),
    )?["output"]["id"]
        .as_str()
        .expect("smoke parent id")
        .to_owned();
    ws.call(
        &dr_workspace::Actor::User,
        "entry.create",
        json!({"book":book,"title":"V4 smoke child","parent":parent_level,"level":false}),
    )?;
    let scripts = vec![
        call("book-read", "book.get", json!({})),
        call(
            "book-write",
            "book.update",
            json!({"summary":"K6 synthetic window update","word_target":0,"daily_word_target":240}),
        ),
        call("entry-read", "entry.get", json!({"id":entry})),
        call(
            "entry-write",
            "entry.update",
            json!({"id":entry,"title":"K6 checkpointed entry"}),
        ),
        call(
            "module-read",
            "module.read_prose",
            json!({"owner":entry,"module":MOD_PROSE}),
        ),
        call(
            "comment-write",
            "comment.create",
            json!({"target":{"kind":"entry","id":entry},"module":MOD_PROSE,"range":[0,3],"body":"K6 synthetic module comment"}),
        ),
        call(
            "comment-read",
            "comment.list",
            json!({"target":{"kind":"entry","id":entry},"module":MOD_PROSE}),
        ),
        call("level-read", "entry.get", json!({"id":"V4 smoke parent"})),
        call(
            "level-off",
            "entry.set_level",
            json!({"id":"V4 smoke parent","level":false}),
        ),
        vec![
            Step::Event(E::TextDelta {
                index: 0,
                text: "K6 synthetic flow complete".into(),
            }),
            Step::Event(E::Finish(FinishReason::Complete)),
        ],
    ];
    // Presence enables the composer; recorded runtime events never call this
    // provider. Even an accidental connection/catalog request cannot leave localhost.
    let base = "http://127.0.0.1:9";
    let provider = ProviderDriver::with_endpoints(
        HttpClient::new()?,
        Credentials::candidate(Provider::Deepseek, "synthetic-k6-window-credential")?,
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
                    version: "k6-v3-window-fixture",
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
            dr_view_agent::speech::install(
                dr_view_agent::speech::client::Client::new(
                    HttpClient::new().expect("synthetic speech HTTP"),
                    Arc::new(dr_platform::secrets::SecretStore::in_memory()),
                )
                .with_endpoint("http://127.0.0.1:9/asr")
                .expect("loopback speech"),
                cx,
            );
            dr_view_agent::init_with_service(
                connection,
                Arc::new(ScriptedDriver::new(scripts)),
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
