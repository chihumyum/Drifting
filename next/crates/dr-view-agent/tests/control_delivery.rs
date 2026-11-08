//! A real terminal journal append is held in F2's post-commit delivery.
//! GPUI must still enqueue controls and freeze the service without waiting
//! for that append to return; only the asynchronous close barrier waits.

use std::{
    cell::RefCell,
    rc::Rc,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

use dr_agent::{
    DriverEvent, Error, Event, FinishReason, Provider, RequestId, RunConfig, Start, State,
    driver::scripted::{ScriptedDriver, Step},
};
use dr_agent_tools::AgentTools;
use dr_model::id::ConversationId;
use dr_shell::{
    Services, SettingsFile, ShellInfo, Workspace as ShellWorkspace, workspace::SuperView,
};
use dr_store::StoreEvent;
use dr_testkit::seed::{self, Preset};
use dr_view_agent::controller::AgentController;
use dr_workspace::Workspace;
use futures::{FutureExt, channel::oneshot, executor::block_on};
use gpui::{TestAppContext, VisualTestContext};
use serde_json::json;

fn draw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| {
        window.simulate_next_frame(cx);
        window.draw(cx).clear(cx);
    });
    cx.run_until_parked();
}

#[gpui::test]
fn terminal_append_cannot_block_control_delivery_close_or_the_window(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::open_dir(dir.path(), "m31-control-delivery").unwrap();
    let seeded = seed::generate(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
    let book = seeded.books[0].book_id().clone();
    let text = seeded.books[0].prose[0].view().plain_text();
    seeded.write_to(ws.library()).unwrap();
    cx.update(|cx| {
        let mut settings = SettingsFile::in_memory();
        settings.set_last_book(book.as_str());
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "m31-control-delivery",
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                library: Some(ws.clone()),
                ..Services::default()
            },
            settings,
            cx,
        );
    });
    let (shell, cx) = cx.add_window_view(ShellWorkspace::new);
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        draw(cx);
        if shell.read_with(cx, |shell, _| !shell.book.is_empty() && !shell.covered()) {
            break;
        }
        assert!(Instant::now() < deadline, "synthetic book did not open");
        std::thread::sleep(Duration::from_millis(2));
    }
    shell.update_in(cx, |shell, window, cx| {
        shell.focus_handle().focus(window, cx)
    });
    draw(cx);

    let (resume, waiting) = oneshot::channel();
    let driver = Arc::new(ScriptedDriver::new(vec![vec![
        Step::Wait(waiting),
        Step::Event(DriverEvent::TextDelta {
            index: 0,
            text: text.clone(),
        }),
        Step::Event(DriverEvent::Finish(FinishReason::Complete)),
    ]]));
    let controller = AgentController::new(ws.clone(), driver, Arc::new(AgentTools::new())).unwrap();
    let session = controller
        .start(Start {
            book,
            conversation: ConversationId::new_v7(),
            input: text.clone(),
            config: RunConfig::new(Provider::Openai, "synthetic-model"),
        })
        .unwrap();
    let control = controller.control(&session).unwrap();
    let (entered, entered_rx) = mpsc::channel();
    let (release, blocked) = mpsc::channel();
    let blocked = Mutex::new(blocked);
    let armed = AtomicBool::new(true);
    let source = ws.library().clone();
    let observed_session = session.clone();
    let subscription = ws.library().subscribe(move |event| {
        if !matches!(event, StoreEvent::Local(change) if change.table == dr_store::agent::EVENT_TABLE)
            || !armed.load(Ordering::SeqCst)
        {
            return;
        }
        let log = dr_agent::events(&source, &observed_session, 0).unwrap();
        if log.last().is_some_and(|entry| matches!(entry.event, Event::StateChanged {state:State::Completed}))
            && armed.swap(false, Ordering::SeqCst)
        {
            entered.send(()).unwrap();
            blocked.lock().unwrap().recv_timeout(Duration::from_secs(10)).unwrap();
        }
    });
    resume.send(()).unwrap();
    entered_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    assert_eq!(
        control.state(),
        State::Streaming,
        "terminal append has not returned"
    );

    // Even the regression must release the runtime: otherwise a blocked UI
    // call would strand the test in the same way as the affected application.
    let (finish_watchdog, watching) = mpsc::channel();
    let timed_out = Arc::new(AtomicBool::new(false));
    let timeout = timed_out.clone();
    let watchdog = std::thread::spawn(move || {
        if watching.recv_timeout(Duration::from_secs(2)).is_err() {
            timeout.store(true, Ordering::SeqCst);
        }
        let _ = release.send(());
    });
    let began = Instant::now();
    let mut closing = cx.update(|_, _| controller.close());
    let close_elapsed = began.elapsed();
    let closed_early = closing.as_mut().now_or_never();
    let waiting_for_terminal = closed_early.is_none();
    let request = RequestId {
        session: session.clone(),
        turn: 1,
        call: "question".into(),
        nonce: "synthetic".into(),
    };
    let control_began = Instant::now();
    let control_results = [
        control.steer(text).boxed(),
        control.stop_after_tool().boxed(),
        control.answer(request.clone(), json!("answer")).boxed(),
        control.permit(request, true).boxed(),
        control.abort().boxed(),
    ]
    .into_iter()
    .map(|action| action.now_or_never())
    .collect::<Vec<_>>();
    let control_elapsed = control_began.elapsed();
    cx.simulate_keystrokes(if cfg!(target_os = "macos") {
        "cmd-alt-4"
    } else {
        "ctrl-alt-4"
    });
    draw(cx);
    let opened = shell.read_with(cx, |shell, _| shell.super_view);
    cx.simulate_keystrokes("escape");
    draw(cx);
    let dismissed = shell.read_with(cx, |shell, _| shell.super_view.is_none());
    let _ = finish_watchdog.send(());
    watchdog.join().unwrap();
    match closed_early {
        Some(result) => result.unwrap(),
        None => block_on(closing).unwrap(),
    }
    drop(subscription);
    let log = dr_agent::events(ws.library(), &session, 0).unwrap();
    assert!(matches!(
        log.last().unwrap().event,
        Event::StateChanged {
            state: State::Completed
        }
    ));
    // Use the actual shell release path: its Stats/Review globals and the
    // last rendered frame also own the old library. The replacement job is
    // reached only after F3 try_shutdown succeeds and the library lock goes.
    drop(ws);
    let swapped = Rc::new(RefCell::new(None));
    let result = swapped.clone();
    cx.update(|_, cx| {
        dr_shell::library::replace(
            cx,
            |root, options| {
                dr_store::Library::open(root, options).map_err(|error| error.to_string())
            },
            move |outcome, _| *result.borrow_mut() = Some(outcome),
        );
    });
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        draw(cx);
        if let Some(result) = swapped.borrow_mut().take() {
            result.unwrap();
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the settled library did not release"
        );
        std::thread::sleep(Duration::from_millis(2));
    }

    assert!(
        close_elapsed < Duration::from_millis(500),
        "close blocked the UI for {close_elapsed:?}"
    );
    assert!(
        control_elapsed < Duration::from_millis(500),
        "controls blocked the UI for {control_elapsed:?}"
    );
    assert!(
        control_results
            .iter()
            .all(|result| matches!(result, Some(Err(Error::Closed)))),
        "terminal requests must be explicitly closed: {control_results:?}"
    );
    assert!(
        waiting_for_terminal,
        "close cannot finish before the terminal append returns"
    );
    assert_eq!(opened, Some(SuperView::Elements));
    assert!(dismissed);
    assert!(
        !timed_out.load(Ordering::SeqCst),
        "the UI needed the watchdog to release it"
    );
}
