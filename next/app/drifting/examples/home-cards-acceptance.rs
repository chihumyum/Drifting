//! HC in a real window: the showcase library (《慢钟》) in a throwaway
//! folder, opened on Project Home, with the Agent's suggestion cards wired
//! as the app wires them and a scripted model stream (one look, then the
//! opened card's conversation). The route is "connected" through an
//! in-process candidate key; every provider and catalog address is
//! loopback and nothing is sent anywhere. Never built as the release app.
//!
//! DRIFTING_APPEARANCE picks the theme; HC2_FIXTURE picks a synthetic
//! timeout or a project whose context exceeds the selected model's capacity.

use std::sync::{Arc, mpsc};

use dr_agent::{
    Cancellation, Driver, DriverEvent as E, DriverRequest, FinishReason, ModelErrorCategory,
    ModelFailure, Provider,
    driver::scripted::{ScriptedDriver, Step},
};
use dr_agent_providers::{
    Endpoints, HttpClient, ProviderDriver, RetryPolicy, credentials::Credentials,
    oauth::OAuthEndpoints,
};
use dr_model::id::BookId;
use dr_shell::{Services, SettingsFile, ShellInfo};
use dr_testkit::seed::{self, Preset};
use dr_workspace::{Actor, Workspace};
use futures::{StreamExt as _, stream::BoxStream};
use gpui::{App, AppContext as _, Global};
use serde_json::{Value, json};

struct Fixture {
    _directory: tempfile::TempDir,
    writer_release: Option<mpsc::Sender<()>>,
}
impl Global for Fixture {}

gpui::actions!(hc2_fixture, [HoldWriter, ReleaseWriter]);

fn hold_writer(_: &HoldWriter, cx: &mut App) {
    let lib = cx
        .global::<Services>()
        .library
        .as_ref()
        .unwrap()
        .library()
        .clone();
    let (ready, acquired) = mpsc::sync_channel(0);
    let (release, held) = mpsc::channel();
    std::thread::spawn(move || {
        lib.local_write(|_| {
            if ready.send(()).is_ok() {
                let _ = held.recv();
            }
            Ok(())
        })
        .expect("hold the fixture writer");
    });
    acquired.recv().unwrap();
    cx.global_mut::<Fixture>().writer_release = Some(release);
}

fn release_writer(_: &ReleaseWriter, cx: &mut App) {
    drop(cx.global_mut::<Fixture>().writer_release.take());
}

struct TimeoutDriver;

impl Driver for TimeoutDriver {
    fn stream(
        &self,
        request: DriverRequest,
        _: Cancellation,
    ) -> BoxStream<'static, dr_agent::Result<E>> {
        assert!(request.purpose.is_single());
        futures::stream::iter([Err(ModelFailure {
            category: ModelErrorCategory::Network,
            message: "synthetic model request timed out".into(),
        }
        .into())])
        .boxed()
    }
}

fn out(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input).unwrap()["output"].clone()
}

fn text(text: String) -> Vec<Step> {
    vec![
        Step::Event(E::TextDelta { index: 0, text }),
        Step::Event(E::Finish(FinishReason::Complete)),
    ]
}

fn main() -> anyhow::Result<()> {
    let case = std::env::var("HC2_FIXTURE").unwrap_or_default();
    let directory = tempfile::tempdir()?;
    let ws = Workspace::open_dir(directory.path(), "hc-window-fixture")?;
    ws.set_auto_links(false);
    let seeded = seed::generate_v3(Preset::Showcase, seed::DEFAULT_SEED)?;
    seeded.write_to(ws.library())?;
    ws.library().rebuild_stale_indexes()?;
    let book: BookId = seeded
        .books
        .iter()
        .find(|b| b.book.view().meta().name == "慢钟")
        .unwrap_or(&seeded.books[0])
        .book_id()
        .clone();
    // One chapter revised by the author: the changes the Agent looks at.
    let chapters = dr_testkit::seed::acceptance::entries_by_template(&ws, &book, "tpl-chapter");
    if case == "context" {
        let templates = out(&ws, "entry_template.list", json!({"book": book}));
        let mut chapter_template = templates
            .as_array()
            .unwrap()
            .iter()
            .find(|template| template["id"] == "tpl-chapter")
            .unwrap()
            .clone();
        chapter_template["agent"]["instructions"] =
            json!("Synthetic fixed guidance ".repeat(120_000));
        out(
            &ws,
            "entry_template.put",
            json!({"book": book, "template": chapter_template}),
        );
    }
    let chapter = chapters[0]["id"].as_str().unwrap().to_owned();
    let doc = format!("body:{chapter}/mod-prose");
    let body = out(&ws, "prose.read", json!({"doc": doc, "limit": 1000}));
    let paragraph = &body["paragraphs"][1];
    out(
        &ws,
        "prose.replace",
        json!({"doc": doc, "block_id": paragraph["block_id"], "find": paragraph["text"],
               "replace": "钟楼的指针又慢了七分钟，她数着台阶上去，第一次没有数错。"}),
    );
    let look = json!({"cards": [
        {"title": "这一章说钟慢了七分钟，前面写的是五分钟，要对一下吗？",
         "detail": "两处都是你写的；这一章是刚改的。",
         "instruction": "核对钟慢了几分钟：把两处原文摆出来，问我以哪个为准。", "target": "c1"},
        {"title": "这一章停在钟楼的台阶上，要我先读一遍、留几条批注吗？",
         "detail": "最后一次改是刚才，停在第 2 段。",
         "instruction": "读这一章到第 2 段，在拿不准的地方留批注，不改正文。", "target": "c1"},
        {"title": "项目记忆里有两条都在说对话不用引号，要合成一条吗？",
         "detail": "一条记于 11 月 3 日，一条记于 11 月 9 日。",
         "instruction": "把项目记忆里两条讲对话引号的合成一条，保留两条里所有的要求。"}
    ]});
    let scripts = vec![
        text(look.to_string()),
        text("好，我先把两处原文摆出来。".into()),
        text("好。".into()),
    ];
    let driver: Arc<dyn Driver> = if case == "timeout" {
        Arc::new(TimeoutDriver)
    } else if case == "context" {
        Arc::new(ScriptedDriver::new(vec![]))
    } else {
        Arc::new(ScriptedDriver::new(scripts))
    };
    let local = "http://127.0.0.1:9";
    let provider = ProviderDriver::with_endpoints(
        HttpClient::new()?,
        Credentials::candidate(Provider::Deepseek, "synthetic-hc-window-key")
            .map_err(|e| anyhow::anyhow!("{e}"))?,
        Endpoints {
            deepseek: local.into(),
            anthropic: local.into(),
            openai: local.into(),
            chatgpt: local.into(),
        },
        OAuthEndpoints::at(local)?,
        RetryPolicy {
            max_attempts: 1,
            ..Default::default()
        },
    );
    let mut connection = dr_view_agent::connection::ConnectionService::new(provider);
    for provider in [
        Provider::Deepseek,
        Provider::Anthropic,
        Provider::Openai,
        Provider::Chatgpt,
    ] {
        connection = connection.with_catalog_endpoint(provider, format!("{local}/models"));
    }
    let appearance = match std::env::var("DRIFTING_APPEARANCE").as_deref() {
        Ok("dark") => dr_ui::Appearance::Dark,
        _ => dr_ui::Appearance::Light,
    };
    gpui_platform::application()
        .with_assets(dr_ui::Assets::new())
        .run(move |cx: &mut App| {
            if cx.displays().len() < 2 {
                eprintln!("home-cards-acceptance needs a secondary display");
                cx.quit();
                return;
            }
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
                    version: "hc-window-fixture",
                    url_scheme: "drifting-next-dev",
                    forced_appearance: Some(appearance),
                },
                Services {
                    library: Some(ws),
                    book: Some(book.to_string()),
                    ..Default::default()
                },
                file,
                cx,
            );
            dr_view_page::init(cx);
            dr_view_elements::init(cx);
            dr_view_agent::init_with_service(
                connection,
                driver,
                Arc::new(dr_view_agent::tools::CompanionTools::default()),
                cx,
            );
            dr_view_home::init(cx);
            // As `main.rs` wires them.
            dr_view_home::set_agent_cards(cx, |host, _, cx| {
                let cards =
                    cx.new(|cx| dr_view_agent::home_cards::HomeCards::new(host.workspace, cx));
                dr_view_home::AgentCards::new(
                    cards,
                    dr_view_agent::home_cards::HomeCards::drawn,
                    dr_view_agent::home_cards::HomeCards::shown,
                )
            });
            cx.set_global(Fixture {
                _directory: directory,
                writer_release: None,
            });
            cx.on_action(hold_writer);
            cx.on_action(release_writer);
            dr_shell::open_workspace(cx, |window, _| window.activate_window()).unwrap();
            dr_debug_bridge::start(cx);
        });
    Ok(())
}
