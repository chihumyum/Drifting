//! Real shell selection and F6 replacement, without ever opening the Agent
//! panel. MCP must not depend on whether a companion view was mounted.
use std::{
    cell::RefCell,
    rc::Rc,
    sync::Arc,
    time::{Duration, Instant},
};

use dr_agent::driver::scripted::ScriptedDriver;
use dr_agent_providers::{HttpClient, ProviderDriver, credentials::Credentials};
use dr_mcp::{ClientPaths, GrantPaths};
use dr_platform::secrets::SecretStore;
use dr_shell::{Services, SettingsFile, ShellInfo, Workspace as ShellWorkspace};
use dr_testkit::seed::{self, Preset};
use dr_view_agent::{
    AgentViews,
    mcp::{self, McpGlobal},
    tools::CompanionTools,
};
use dr_workspace::Workspace;
use gpui::{Entity, TestAppContext, VisualTestContext};

fn draw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| {
        window.simulate_next_frame(cx);
        window.draw(cx).clear(cx);
    });
    cx.run_until_parked();
}
fn wait(cx: &mut VisualTestContext, mut done: impl FnMut(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        draw(cx);
        if done(cx) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "MCP shell lifecycle did not settle"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn setup(cx: &mut TestAppContext) -> (tempfile::TempDir, Vec<String>) {
    cx.executor().allow_parking();
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::open_dir(dir.path().join("library"), "m32-shell").unwrap();
    let mut books = Vec::new();
    for number in 0..2 {
        let seeded = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED + number).unwrap();
        books.push(seeded.books[0].book_id().to_string());
        seeded.write_to(ws.library()).unwrap();
    }
    let paths = GrantPaths::new(
        dir.path().join("app/mcp"),
        dir.path().join("Drifting"),
        ClientPaths::from_home(dir.path().join("home"), None, None),
    )
    .with_socket_root(dir.path().join("sockets"));
    let secrets = Arc::new(SecretStore::in_memory());
    cx.update(|cx| {
        let mut settings = SettingsFile::in_memory();
        settings.set_last_book(&books[0]);
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "m32-shell",
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                library: Some(ws),
                book: Some(books[0].clone()),
                ..Services::default()
            },
            settings,
            cx,
        );
        mcp::init_with(Ok(paths), secrets.clone(), cx);
    });
    // Native module initializers can flush deferred effects independently.
    // Publishing AgentViews must attach MCP even after its own init returned.
    cx.run_until_parked();
    cx.update(|cx| {
        let provider = ProviderDriver::new(HttpClient::new().unwrap(), Credentials::new(secrets));
        let tools = Arc::new(CompanionTools::with_plugins(
            cx.global::<McpGlobal>().slot.clone(),
        ));
        dr_view_agent::init_with(provider, Arc::new(ScriptedDriver::new(vec![])), tools, cx);
    });
    (dir, books)
}

fn ready(cx: &mut VisualTestContext, book: &str) -> bool {
    cx.read(|cx| {
        let service = cx.global::<McpGlobal>().service.read(cx);
        service.grants().is_some()
            && service.manager().is_some()
            && service
                .host()
                .unwrap()
                .selection()
                .book
                .as_ref()
                .map(|id| id.as_str())
                == Some(book)
    })
}

fn close(cx: &mut VisualTestContext, shell: Entity<ShellWorkspace>) {
    let (plugins, agent) = cx.update(|_, cx| {
        let service = cx.global::<McpGlobal>().service.clone();
        let hub = cx.global::<AgentViews>().hub.clone();
        (
            service.update(cx, |service, cx| service.prepare_close(cx)),
            hub.update(cx, |hub, cx| hub.prepare_close(cx)),
        )
    });
    futures::executor::block_on(async {
        plugins.await.unwrap();
        agent.await.unwrap();
    });
    shell.update(cx, |shell, _| {
        if let Some(ws) = &shell.library {
            ws.close();
        }
    });
}

#[gpui::test]
fn selection_tracks_book_loading_shelf_and_return_without_a_companion(cx: &mut TestAppContext) {
    let (_dir, books) = setup(cx);
    let (shell, cx) = cx.add_window_view(ShellWorkspace::new);
    wait(cx, |cx| ready(cx, &books[0]));
    assert!(cx.read(|cx| dr_view_agent::panels(cx).is_empty()));
    let host = cx.read(|cx| cx.global::<McpGlobal>().service.read(cx).host().unwrap());
    let initial = host.selection().epoch;
    shell.update_in(cx, |shell, window, cx| {
        shell.open_book(&books[1], window, cx)
    });
    cx.run_until_parked();
    assert_ne!(
        host.selection().book.as_ref().map(|id| id.as_str()),
        Some(books[0].as_str())
    );
    wait(cx, |cx| ready(cx, &books[1]));
    assert!(host.selection().epoch > initial);
    // Model the shell's explicit shelf state; no fake book is published under
    // it even though the previous Book snapshot is still cached for reopening.
    shell.update(cx, |shell, cx| {
        shell.shelf_open = true;
        cx.notify();
    });
    draw(cx);
    assert!(host.selection().book.is_none());
    shell.update_in(cx, |shell, window, cx| {
        shell.open_book(&books[0], window, cx)
    });
    wait(cx, |cx| ready(cx, &books[0]));
    assert!(host.selection().epoch >= initial + 3);
    close(cx, shell);
}

#[gpui::test]
fn library_replacement_settles_old_manager_and_rebuilds_under_the_same_endpoint(
    cx: &mut TestAppContext,
) {
    let (_dir, books) = setup(cx);
    let (shell, cx) = cx.add_window_view(ShellWorkspace::new);
    wait(cx, |cx| ready(cx, &books[0]));
    let (old, endpoint, generation) = cx.read(|cx| {
        let service = cx.global::<McpGlobal>().service.read(cx);
        (
            service.manager().unwrap(),
            service.grants().unwrap().endpoint().clone(),
            service.generation(),
        )
    });
    let finished = Rc::new(RefCell::new(None));
    let result = finished.clone();
    cx.update(|_, cx| {
        dr_shell::library::replace(
            cx,
            |path, options| {
                dr_store::Library::open(path, options).map_err(|error| error.to_string())
            },
            move |done, _| {
                *result.borrow_mut() = Some(done);
            },
        )
    });
    assert!(old.is_closed());
    wait(cx, |_| finished.borrow().is_some());
    finished.borrow_mut().take().unwrap().unwrap();
    wait(cx, |cx| ready(cx, &books[0]));
    cx.read(|cx| {
        let service = cx.global::<McpGlobal>().service.read(cx);
        assert!(service.generation() > generation);
        assert_eq!(service.grants().unwrap().endpoint(), &endpoint);
        assert!(!service.manager().unwrap().is_closed());
        assert!(old.snapshot().closed);
    });
    // Retaining an old UI handle must not retain a Library and block F6.
    drop(old);
    close(cx, shell);
}
