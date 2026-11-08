//! M32 window acceptance: isolated client configuration directories, a tiny
//! synthetic library, memory secrets and no real provider or remote service.
use std::sync::Arc;

use dr_agent::driver::scripted::ScriptedDriver;
use dr_agent_providers::{
    Endpoints, HttpClient, ProviderDriver, RetryPolicy, credentials::Credentials,
    oauth::OAuthEndpoints,
};
use dr_mcp::{ClientPaths, GrantPaths};
use dr_platform::secrets::SecretStore;
use dr_shell::{
    Services, SettingsFile, ShellInfo,
    settings::{self, registry::Section},
};
use dr_testkit::seed::{self, Preset};
use dr_view_agent::{
    mcp::{self, McpGlobal},
    tools::CompanionTools,
};
use gpui::{App, Global};
use serde_json::json;

struct Fixture {
    _directory: tempfile::TempDir,
}
impl Global for Fixture {}

fn main() -> anyhow::Result<()> {
    if let dr_platform::cli::Launch::Mcp(connection) =
        dr_platform::cli::parse(&std::env::args().skip(1).collect::<Vec<_>>())
    {
        let connection = connection.map_err(anyhow::Error::msg)?;
        return dr_mcp::bridge::run(&connection).map_err(anyhow::Error::msg);
    }
    let directory = tempfile::tempdir()?;
    let workspace =
        dr_workspace::Workspace::open_dir(directory.path().join("library"), "m32-window-fixture")?;
    let seed = seed::generate(Preset::Tiny, seed::DEFAULT_SEED)?;
    seed.write_to(workspace.library())?;
    let book = seed.books[0].book_id().to_string();
    let paths = GrantPaths::new(
        directory.path().join("app/mcp"),
        std::env::current_exe()?,
        ClientPaths::from_home(directory.path().join("home"), None, None),
    )
    .with_socket_root(directory.path().join("sockets"));
    let secrets = Arc::new(SecretStore::in_memory());
    let base = "http://127.0.0.1:9";
    let provider = ProviderDriver::with_endpoints(
        HttpClient::new()?,
        Credentials::new(secrets.clone()),
        Endpoints {
            deepseek: format!("{base}/chat/completions"),
            anthropic: format!("{base}/messages"),
            openai: format!("{base}/responses"),
            chatgpt: format!("{base}/responses"),
        },
        OAuthEndpoints::at(base)?,
        RetryPolicy::default(),
    );
    gpui_platform::application()
        .with_assets(dr_ui::Assets::new())
        .run(move |cx: &mut App| {
            dr_ui::init(cx).expect("pinned fonts");
            let mut settings = SettingsFile::in_memory();
            settings
                .set(
                    dr_shell::settings::registry::UI_LOCALE,
                    json!("zh-CN"),
                    None,
                )
                .unwrap();
            dr_shell::init(
                ShellInfo {
                    app_name: "Drifting Next",
                    bundle_id: "cc.drifting.next.dev",
                    version: "m32-window-fixture",
                    url_scheme: "drifting-next-dev",
                    forced_appearance: Some(dr_ui::Appearance::Light),
                },
                Services {
                    library: Some(workspace),
                    book: Some(book),
                    ..Default::default()
                },
                settings,
                cx,
            );
            dr_view_page::init(cx);
            dr_view_elements::init(cx);
            mcp::init_with(Ok(paths), secrets, cx);
            let tools = Arc::new(CompanionTools::with_plugins(
                cx.global::<McpGlobal>().slot.clone(),
            ));
            dr_view_agent::init_with(provider, Arc::new(ScriptedDriver::new(vec![])), tools, cx);
            cx.set_global(Fixture {
                _directory: directory,
            });
            let handle =
                dr_shell::open_workspace(cx, |window, _| window.activate_window()).unwrap();
            handle
                .update(cx, |_, window, cx| {
                    settings::open_section(Section::Agent, window, cx)
                })
                .unwrap();
            dr_debug_bridge::start(cx);
        });
    Ok(())
}
