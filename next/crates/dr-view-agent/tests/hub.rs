//! The real shell's release hooks own the library-scoped Agent service,
//! including an opening controller which no panel has received yet.

use std::{
    cell::{Cell, RefCell},
    path::PathBuf,
    rc::Rc,
    sync::Arc,
    time::{Duration, Instant},
};

use dr_agent::driver::scripted::ScriptedDriver;
use dr_shell::{Services, SettingsFile, ShellInfo, library, quit, release};
use dr_testkit::seed::{self, Preset};
use dr_view_agent::{
    hub::{self, AgentHub},
    tools::CompanionTools,
};
use dr_workspace::Workspace;
use futures::future::BoxFuture;
use gpui::{AppContext as _, Entity, TestAppContext};

const VERSION: &str = "m31-hub-test";

fn setup(cx: &mut TestAppContext) -> tempfile::TempDir {
    cx.executor().allow_parking();
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open_dir(dir.path(), VERSION).unwrap();
    seed::generate(Preset::Tiny, seed::DEFAULT_SEED)
        .unwrap()
        .write_to(workspace.library())
        .unwrap();
    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: VERSION,
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                library: Some(workspace),
                ..Services::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
    });
    dir
}

fn new_hub(cx: &mut gpui::App) -> Entity<AgentHub> {
    cx.new(|_| {
        AgentHub::new(
            Arc::new(ScriptedDriver::new(Vec::new())),
            Arc::new(CompanionTools::default()),
        )
    })
}

fn wait(cx: &mut TestAppContext, mut ready: impl FnMut(&mut TestAppContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        cx.run_until_parked();
        if ready(cx) {
            return;
        }
        assert!(Instant::now() < deadline, "Agent hub did not settle");
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn finish(cx: &mut TestAppContext, closing: BoxFuture<'static, Result<(), String>>) {
    let completed = Rc::new(RefCell::new(None));
    let result = completed.clone();
    cx.update(|cx| {
        cx.spawn(async move |_| *result.borrow_mut() = Some(closing.await))
            .detach();
    });
    wait(cx, |_| completed.borrow().is_some());
    assert_eq!(completed.borrow().as_ref().unwrap(), &Ok(()));
}

fn controller_ready(cx: &mut TestAppContext, hub: &Entity<AgentHub>) {
    wait(cx, |cx| {
        cx.update(|cx| {
            let hub = hub.read(cx);
            assert!(hub.error.is_none(), "Agent initialization: {:?}", hub.error);
            hub.controller.is_some()
        })
    });
}

fn shutdown_current(cx: &mut TestAppContext) {
    // Shell initialization (and take_up after replacement) also gives the
    // Stats recorder and Review service library handles. Release those via
    // the real quit hooks before asserting the Agent's ownership boundary.
    let quit_prepared = Rc::new(Cell::new(false));
    let prepared = quit_prepared.clone();
    cx.update(|cx| {
        quit::before_quit(cx, move |_| prepared.set(true));
        quit::request(cx);
    });
    wait(cx, |_| quit_prepared.get());
    let workspace = cx.update(|cx| cx.global_mut::<Services>().library.take().unwrap());
    // Outside an App update: this is a lifetime assertion, not a UI-thread
    // implementation of shutdown. Retained, closed controller clones must
    // not force F3 to return its still-open Workspace.
    workspace.try_shutdown().unwrap();
}

#[gpui::test]
fn close_awaits_an_opening_controller_before_its_first_ui_install(cx: &mut TestAppContext) {
    let _dir = setup(cx);
    let (hub, closing) = cx.update(|cx| {
        let hub = new_hub(cx);
        hub::install(&hub, cx);
        // Attach and prepare share one dispatch. The worker may already be
        // recovering, but its shared result cannot have been installed by
        // the foreground task. Closing must await that result and close it.
        assert!(hub.read(cx).controller.is_none());
        let closing = hub.update(cx, |hub, cx| hub.prepare_close(cx));
        assert!(hub.read(cx).controller.is_none());
        (hub, closing)
    });
    let retained_hub = hub.clone();
    finish(cx, closing);
    cx.run_until_parked();
    cx.update(|cx| {
        assert!(hub.read(cx).controller.is_none());
        assert!(hub.read(cx).error.is_none());
    });
    shutdown_current(cx);
    // Keep both handles alive beyond shutdown to detect a stale opening
    // future cached in the hub, rather than relying on entity destruction.
    cx.update(|cx| assert!(retained_hub.read(cx).controller.is_none()));
}

#[gpui::test]
fn after_release_attaches_to_the_current_library_and_closed_clones_hold_no_library(
    cx: &mut TestAppContext,
) {
    let original = setup(cx);
    let replacement = tempfile::tempdir().unwrap();
    let store = dr_store::Library::open(replacement.path(), dr_workspace::library_options(VERSION))
        .unwrap();
    seed::generate(Preset::Tiny, seed::DEFAULT_SEED + 31)
        .unwrap()
        .write_to(&store)
        .unwrap();
    store.close().unwrap();
    let hub = cx.update(|cx| {
        let hub = new_hub(cx);
        hub::install(&hub, cx);
        hub
    });
    controller_ready(cx, &hub);
    let old = cx.update(|cx| hub.read(cx).controller.clone().unwrap());
    let old_root = old
        .with_workspace_read(|ws| Ok(ws.library().paths().root.clone()))
        .unwrap();
    assert_eq!(old_root, original.path());

    let completed = Rc::new(RefCell::new(None));
    let done = completed.clone();
    let next_root: PathBuf = replacement.path().into();
    cx.update(|cx| {
        library::replace(
            cx,
            move |_, options| {
                dr_store::Library::open(&next_root, options).map_err(|error| error.to_string())
            },
            move |result, cx| {
                assert!(!release::is_releasing(cx));
                *done.borrow_mut() = Some(result);
            },
        );
        assert!(release::is_releasing(cx));
        assert!(old.is_closed(), "the registered hook freezes synchronously");
        assert!(hub.read(cx).controller.is_none());
    });
    wait(cx, |_| completed.borrow().is_some());
    assert_eq!(completed.borrow().as_ref().unwrap(), &Ok(()));
    controller_ready(cx, &hub);
    let current = cx.update(|cx| hub.read(cx).controller.clone().unwrap());
    assert!(!current.is_closed());
    assert!(old.is_closed());
    assert!(old.with_workspace_read(|_| Ok(())).is_err());
    assert_eq!(
        current
            .with_workspace_read(|ws| Ok(ws.library().paths().root.clone()))
            .unwrap(),
        replacement.path(),
        "after_release must rebuild from the installed Services library"
    );

    let closing = cx.update(|cx| hub.update(cx, |hub, cx| hub.prepare_close(cx)));
    finish(cx, closing);
    assert!(current.is_closed());
    shutdown_current(cx);
    // Both the pre-swap and post-swap controllers remain owned here. Their
    // close barriers must have released resources independently of Drop.
    assert!(old.is_closed());
    assert!(current.is_closed());
    cx.update(|cx| assert!(hub.read(cx).controller.is_none()));
}
