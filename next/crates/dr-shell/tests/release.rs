//! Shared library/quit admission and asynchronous shutdown, with the real F3
//! library and injectable services. Authored data comes from the tiny seed.

use std::cell::{Cell, RefCell};
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::time::{Duration, Instant};

use dr_shell::{Services, SettingsFile, ShellInfo, library, quit, release};
use dr_testkit::seed::{self, Preset};
use dr_workspace::{Actor, Workspace};
use futures::{FutureExt, channel::oneshot};
use gpui::TestAppContext;
use serde_json::json;

const VERSION: &str = "m31-release-test";

fn setup(cx: &mut TestAppContext) -> tempfile::TempDir {
    cx.executor().allow_parking();
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::open_dir(dir.path(), VERSION).unwrap();
    seed::generate(Preset::Tiny, seed::DEFAULT_SEED)
        .unwrap()
        .write_to(ws.library())
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
                library: Some(ws),
                ..Services::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
    });
    dir
}

fn root(cx: &gpui::App) -> PathBuf {
    cx.global::<Services>()
        .library
        .as_ref()
        .unwrap()
        .library()
        .paths()
        .root
        .clone()
}

fn usable(cx: &gpui::App) {
    let ws = cx.global::<Services>().library.as_ref().unwrap();
    let books = ws.call(&Actor::User, "book.list", json!({})).unwrap();
    let book = &books["output"][0];
    assert!(book["id"].is_string());
    // A failed release leaves commands usable too, not only cached views.
    ws.call(
        &Actor::User,
        "book.update",
        json!({"book":book["id"],"summary":book["name"]}),
    )
    .unwrap();
}

fn wait(cx: &mut TestAppContext, done: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        cx.run_until_parked();
        if done() {
            return;
        }
        assert!(Instant::now() < deadline, "release did not finish");
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn close(cx: &mut TestAppContext) {
    cx.update(|cx| {
        if let Some(ws) = cx.global::<Services>().library.as_ref() {
            ws.close();
        }
    });
}

#[gpui::test]
fn failed_preparation_waits_for_every_service_and_keeps_the_original_library(
    cx: &mut TestAppContext,
) {
    let dir = setup(cx);
    let order = Rc::new(RefCell::new(Vec::new()));
    let (release_waiter, waiter) = oneshot::channel();
    let mut waiter = Some(waiter);
    let first = order.clone();
    let second = order.clone();
    let resumed = order.clone();
    let completed = Rc::new(RefCell::new(None));
    let result = completed.clone();
    let job_calls = Arc::new(AtomicUsize::new(0));
    let job = job_calls.clone();
    let quit_ran = Rc::new(Cell::new(false));
    let quit_hook = quit_ran.clone();
    let rejected = Rc::new(RefCell::new(None));
    let duplicate = rejected.clone();
    cx.update(|cx| {
        release::before_release(cx, move |_| {
            first.borrow_mut().push("freeze first");
            async { Err("prepare failed".into()) }.boxed_local()
        });
        release::before_release(cx, move |_| {
            second.borrow_mut().push("freeze second");
            let waiter = waiter.take().unwrap();
            async move { waiter.await.unwrap() }.boxed_local()
        });
        release::after_release(cx, move |cx| {
            assert!(!release::is_releasing(cx));
            usable(cx);
            resumed.borrow_mut().push("resume");
        });
        quit::before_quit(cx, move |_| quit_hook.set(true));
        library::replace(
            cx,
            move |_, _| {
                job.fetch_add(1, Ordering::SeqCst);
                unreachable!("failed preparation cannot run the disk job")
            },
            move |outcome, _| {
                *result.borrow_mut() = Some(outcome);
            },
        );
        // Freeze happens before the current dispatch ends.
        assert!(release::is_releasing(cx));
        assert_eq!(*order.borrow(), ["freeze first", "freeze second"]);
        library::replace(
            cx,
            |_, _| unreachable!("duplicate job"),
            move |outcome, _| {
                *duplicate.borrow_mut() = Some(outcome);
            },
        );
        quit::request(cx);
    });
    cx.run_until_parked();
    assert!(
        completed.borrow().is_none(),
        "first error must not detach the other service"
    );
    assert!(rejected.borrow().as_ref().unwrap().is_err());
    assert!(!quit_ran.get());
    assert_eq!(job_calls.load(Ordering::SeqCst), 0);
    cx.update(|cx| {
        assert!(release::is_releasing(cx));
        assert_eq!(root(cx), dir.path());
        usable(cx);
    });
    release_waiter.send(Ok(())).unwrap();
    wait(cx, || completed.borrow().is_some());
    assert_eq!(
        completed.borrow().as_ref().unwrap(),
        &Err("prepare failed".into())
    );
    assert_eq!(*order.borrow(), ["freeze first", "freeze second", "resume"]);
    cx.update(|cx| {
        assert!(!release::is_releasing(cx));
        assert_eq!(root(cx), dir.path());
        usable(cx);
    });
    close(cx);
}

#[gpui::test]
fn quitting_waits_without_blocking_ui_and_does_not_resume_after_success(cx: &mut TestAppContext) {
    let _dir = setup(cx);
    let (finish, waiting) = oneshot::channel();
    let mut waiting = Some(waiting);
    let starts = Rc::new(Cell::new(0));
    let frozen = starts.clone();
    let hooks = Rc::new(Cell::new(0));
    let quit_hook = hooks.clone();
    let resumes = Rc::new(Cell::new(0));
    let resumed = resumes.clone();
    let tick = Rc::new(Cell::new(false));
    let ticked = tick.clone();
    let rejected = Rc::new(Cell::new(false));
    let duplicate = rejected.clone();
    cx.update(|cx| {
        release::before_release(cx, move |_| {
            frozen.set(frozen.get() + 1);
            let waiting = waiting.take().unwrap();
            async move { waiting.await.unwrap() }.boxed_local()
        });
        release::after_release(cx, move |_| resumed.set(resumed.get() + 1));
        quit::before_quit(cx, move |cx| {
            assert!(release::is_releasing(cx));
            assert!(cx.global::<Services>().library.is_some());
            quit_hook.set(quit_hook.get() + 1);
        });
        quit::request(cx);
        quit::request(cx);
        library::replace(
            cx,
            |_, _| unreachable!("replacement during quit"),
            move |outcome, _| {
                duplicate.set(outcome.is_err());
            },
        );
        assert!(release::is_releasing(cx));
        assert_eq!(starts.get(), 1);
        cx.spawn(async move |_| ticked.set(true)).detach();
    });
    cx.run_until_parked();
    assert!(
        tick.get(),
        "another foreground task runs while shutdown waits"
    );
    assert!(rejected.get());
    assert_eq!(hooks.get(), 0);
    assert_eq!(resumes.get(), 0);
    finish.send(Ok(())).unwrap();
    wait(cx, || hooks.get() == 1);
    assert_eq!(resumes.get(), 0);
    cx.update(|cx| {
        assert!(release::is_releasing(cx));
        quit::request(cx);
    });
    cx.run_until_parked();
    assert_eq!(starts.get(), 1);
    assert_eq!(hooks.get(), 1);
    close(cx);
}

#[gpui::test]
fn failed_quit_resumes_the_service_and_allows_a_later_request(cx: &mut TestAppContext) {
    let _dir = setup(cx);
    let attempts = Rc::new(Cell::new(0));
    let prepare = attempts.clone();
    let resumed = Rc::new(Cell::new(0));
    let resume = resumed.clone();
    let quit_calls = Rc::new(Cell::new(0));
    let hook = quit_calls.clone();
    cx.update(|cx| {
        release::before_release(cx, move |_| {
            prepare.set(prepare.get() + 1);
            let first = prepare.get() == 1;
            async move {
                if first {
                    Err("prepare failed".into())
                } else {
                    Ok(())
                }
            }
            .boxed_local()
        });
        release::after_release(cx, move |cx| {
            assert!(!release::is_releasing(cx));
            usable(cx);
            resume.set(resume.get() + 1);
        });
        quit::before_quit(cx, move |_| hook.set(hook.get() + 1));
        quit::request(cx);
    });
    wait(cx, || resumed.get() == 1);
    assert_eq!(quit_calls.get(), 0);
    cx.update(|cx| {
        assert!(!release::is_releasing(cx));
        usable(cx);
        quit::request(cx);
    });
    wait(cx, || quit_calls.get() == 1);
    assert_eq!(attempts.get(), 2);
    assert_eq!(resumed.get(), 1);
    close(cx);
}

#[gpui::test]
fn replacement_resumes_after_the_failed_or_new_library_is_installed(cx: &mut TestAppContext) {
    let original = setup(cx);
    let new = tempfile::tempdir().unwrap();
    let new_store =
        dr_store::Library::open(new.path(), dr_workspace::library_options(VERSION)).unwrap();
    seed::generate(Preset::Tiny, seed::DEFAULT_SEED)
        .unwrap()
        .write_to(&new_store)
        .unwrap();
    new_store.close().unwrap();
    let seen = Rc::new(RefCell::new(Vec::new()));
    let resumed = seen.clone();
    let first = Rc::new(RefCell::new(None));
    let done = first.clone();
    let called = seen.clone();
    cx.update(|cx| {
        release::before_release(cx, |_| async { Ok(()) }.boxed_local());
        release::after_release(cx, move |cx| {
            assert!(!release::is_releasing(cx));
            usable(cx);
            resumed.borrow_mut().push(root(cx));
        });
        library::replace(
            cx,
            |_, _| Err("swap failed".into()),
            move |outcome, cx| {
                assert_eq!(
                    called.borrow().last(),
                    Some(&root(cx)),
                    "resume precedes done"
                );
                *done.borrow_mut() = Some(outcome);
            },
        );
    });
    wait(cx, || first.borrow().is_some());
    assert_eq!(first.borrow().as_ref().unwrap(), &Err("swap failed".into()));
    assert_eq!(seen.borrow().as_slice(), [original.path()]);

    let second = Rc::new(RefCell::new(None));
    let done = second.clone();
    let called = seen.clone();
    let new_root = new.path().to_owned();
    cx.update(|cx| {
        library::replace(
            cx,
            move |_, options| {
                dr_store::Library::open(&new_root, options).map_err(|error| error.to_string())
            },
            move |outcome, cx| {
                assert_eq!(
                    called.borrow().last(),
                    Some(&root(cx)),
                    "new services precede done"
                );
                *done.borrow_mut() = Some(outcome);
            },
        );
    });
    wait(cx, || second.borrow().is_some());
    assert_eq!(second.borrow().as_ref().unwrap(), &Ok(()));
    assert_eq!(seen.borrow().as_slice(), [original.path(), new.path()]);
    cx.update(|cx| assert!(!release::is_releasing(cx)));
    close(cx);
}

#[gpui::test]
fn refused_shutdown_restores_the_gate_and_service_without_running_the_job(cx: &mut TestAppContext) {
    let original = setup(cx);
    let held = cx.update(|cx| cx.global::<Services>().library.clone().unwrap());
    let resumed = Rc::new(Cell::new(false));
    let resume = resumed.clone();
    let completed = Rc::new(RefCell::new(None));
    let done = completed.clone();
    cx.update(|cx| {
        release::after_release(cx, move |cx| {
            assert!(!release::is_releasing(cx));
            usable(cx);
            resume.set(true);
        });
        library::replace(
            cx,
            |_, _| unreachable!("held workspace prevents shutdown"),
            move |outcome, _| {
                *done.borrow_mut() = Some(outcome);
            },
        );
    });
    wait(cx, || completed.borrow().is_some());
    assert!(
        completed
            .borrow()
            .as_ref()
            .unwrap()
            .as_ref()
            .unwrap_err()
            .contains("could not be closed")
    );
    assert!(resumed.get());
    cx.update(|cx| {
        assert_eq!(root(cx), original.path());
        usable(cx);
    });
    drop(held);
    close(cx);
}
