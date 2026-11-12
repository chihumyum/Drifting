//! The final checkpoint observes settled writers and can still stop release.
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use dr_shell::{Services, SettingsFile, ShellInfo, library, quit, release};
use dr_workspace::{Actor, Workspace};
use futures::{FutureExt, channel::oneshot};
use gpui::TestAppContext;
use serde_json::json;

fn setup(cx: &mut TestAppContext) -> tempfile::TempDir {
    cx.executor().allow_parking();
    let dir = tempfile::tempdir().unwrap();
    let mut options = dr_workspace::library_options("test");
    options.device = Some(dr_store::Device::open(dir.path().join("device")).unwrap());
    let lib = Workspace::open(
        dr_store::Library::open(dir.path(), options).unwrap(),
        Default::default(),
    )
    .unwrap();
    dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap()
    .write_to(lib.library())
    .unwrap();
    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "0.2.0-dev",
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                library: Some(lib),
                ..Default::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
    });
    dir
}
fn wait(cx: &mut TestAppContext, done: impl Fn() -> bool) {
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        cx.run_until_parked();
        if done() {
            return;
        }
        assert!(Instant::now() < until, "release did not settle");
        std::thread::sleep(Duration::from_millis(2));
    }
}
fn close(cx: &mut TestAppContext) {
    cx.update(|cx| cx.global::<Services>().library.as_ref().unwrap().close());
}

fn entry(lib: &Workspace) -> dr_workspace::commands::v3::snapshots::EntryIn {
    let books = lib.call(&Actor::User, "book.list", json!({})).unwrap();
    let book = books["output"][0]["id"].as_str().unwrap().to_owned();
    let entries = lib
        .call(&Actor::User, "entry.list", json!({"book":book,"all":true}))
        .unwrap();
    let entry = entries["output"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["template"] == "tpl-chapter")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    dr_workspace::commands::v3::snapshots::EntryIn { book, entry }
}

fn register_real_checkpoint(cx: &mut gpui::App) {
    release::after_drain(cx, |cx| {
        let lib = cx.global::<Services>().library.clone().unwrap();
        Box::pin(
            cx.background_executor()
                .spawn(async move { dr_view_history::automatic::capture_on_close(&lib) }),
        )
    });
}

#[gpui::test]
fn real_g1_checkpoint_captures_a_write_after_its_worker_stops_and_reopens(cx: &mut TestAppContext) {
    use dr_workspace::commands::v3::snapshots as api;
    let _dir = setup(cx);
    let (target, doc, text) = cx.update(|cx| {
        let lib = cx.global::<Services>().library.as_ref().unwrap();
        let target = entry(lib);
        let doc = format!("body:{}/mod-prose", target.entry);
        let body = lib
            .call(&Actor::User, "prose.read", json!({"doc":doc}))
            .unwrap();
        (
            target,
            doc,
            format!(
                "After drain {}",
                body["output"]["paragraphs"][0]["text"].as_str().unwrap()
            ),
        )
    });
    let (done, waiting) = oneshot::channel();
    let mut waiting = Some(waiting);
    let stopped = Rc::new(Cell::new(false));
    let stop = stopped.clone();
    let complete = Rc::new(Cell::new(false));
    let completed = complete.clone();
    let wanted = text.clone();
    let write = target.clone();
    cx.update(|cx| {
        let mut history = Some(dr_view_history::automatic::AutomaticHistory::start(
            cx.global::<Services>().library.clone().unwrap(),
        ));
        release::before_release(cx, move |cx| {
            let history = history.take().unwrap();
            let task = cx
                .background_executor()
                .spawn(async move { history.finish() });
            let stop = stop.clone();
            async move {
                let result = task.await;
                stop.set(true);
                result
            }
            .boxed_local()
        });
        release::before_release(cx, move |cx| {
            let waiting = waiting.take().unwrap();
            let lib = cx.global::<Services>().library.clone().unwrap();
            let (target, text) = (write.clone(), wanted.clone());
            async move {
                waiting.await.unwrap();
                lib.call(
                    &Actor::User,
                    "module.set_prose",
                    json!({
                        "book":target.book, "owner":target.entry,
                        "module":"mod-prose", "paragraphs":[{"text":text}]
                    }),
                )
                .map_err(|e| e.to_string())?;
                Ok(())
            }
            .boxed_local()
        });
        register_real_checkpoint(cx);
        library::replace(
            cx,
            |root, options| dr_store::Library::open(root, options).map_err(|e| e.to_string()),
            move |result, _| {
                result.unwrap();
                completed.set(true)
            },
        );
    });
    wait(cx, || stopped.get());
    assert!(!complete.get());
    done.send(()).unwrap();
    wait(cx, || complete.get());
    cx.update(|cx| {
        let lib = cx.global::<Services>().library.as_ref().unwrap();
        let points = lib
            .run::<api::List>(&Actor::User, target.clone())
            .unwrap()
            .output;
        let current = lib.observe(&doc).unwrap().version;
        let point = points
            .iter()
            .find(|p| p.bodies.get(&doc) == Some(&current))
            .expect("close point contains the last writer's durable body frontier");
        let preview = lib
            .run::<api::Preview>(
                &Actor::User,
                api::PointIn {
                    target,
                    point: point.id.clone(),
                },
            )
            .unwrap()
            .output;
        assert_eq!(point.reason, "close");
        assert!(
            preview
                .bodies
                .iter()
                .any(|b| b.doc == doc && b.text == text)
        );
    });
    close(cx);
}

#[gpui::test]
fn real_checkpoint_failure_blocks_replacement_and_a_retry_preserves_author_text(
    cx: &mut TestAppContext,
) {
    use dr_workspace::commands::v3::snapshots as api;
    let dir = setup(cx);
    let (target, doc, before) = cx.update(|cx| {
        let lib = cx.global::<Services>().library.as_ref().unwrap();
        let target = entry(lib);
        let doc = format!("body:{}/mod-prose", target.entry);
        let body = lib
            .call(&Actor::User, "prose.read", json!({"doc":doc}))
            .unwrap();
        lib.library()
            .local_transaction(|tx| {
                tx.execute_batch(
                    "CREATE TRIGGER reject_checkpoint BEFORE INSERT ON loro_update \
                 WHEN NEW.doc_id LIKE 'checkpoints:%' \
                 BEGIN SELECT RAISE(ABORT,'checkpoint fault'); END;",
                )?;
                Ok(())
            })
            .unwrap();
        (target, doc, body["output"].clone())
    });
    let outcome = Rc::new(RefCell::new(None));
    let result = outcome.clone();
    cx.update(|cx| {
        register_real_checkpoint(cx);
        library::replace(
            cx,
            |_, _| panic!("failed checkpoint must not close or replace the library"),
            move |out, _| *result.borrow_mut() = Some(out),
        );
    });
    wait(cx, || outcome.borrow().is_some());
    assert!(
        outcome
            .borrow()
            .as_ref()
            .unwrap()
            .as_ref()
            .unwrap_err()
            .contains("checkpoint fault")
    );
    cx.update(|cx| {
        assert!(!release::is_releasing(cx));
        let lib = cx.global::<Services>().library.as_ref().unwrap();
        assert_eq!(lib.library().paths().root, dir.path());
        assert_eq!(
            lib.call(&Actor::User, "prose.read", json!({"doc":doc}))
                .unwrap()["output"],
            before
        );
        assert!(
            lib.run::<api::List>(&Actor::User, target.clone())
                .unwrap()
                .output
                .is_empty()
        );
        lib.library()
            .local_transaction(|tx| {
                tx.execute_batch("DROP TRIGGER reject_checkpoint")?;
                Ok(())
            })
            .unwrap();
    });
    *outcome.borrow_mut() = None;
    let result = outcome.clone();
    cx.update(|cx| {
        library::replace(
            cx,
            |root, options| dr_store::Library::open(root, options).map_err(|e| e.to_string()),
            move |out, _| *result.borrow_mut() = Some(out),
        )
    });
    wait(cx, || outcome.borrow().is_some());
    assert!(outcome.borrow().as_ref().unwrap().is_ok());
    cx.update(|cx| {
        let lib = cx.global::<Services>().library.as_ref().unwrap();
        assert_eq!(
            lib.call(&Actor::User, "prose.read", json!({"doc":doc}))
                .unwrap()["output"],
            before
        );
        assert!(
            !lib.run::<api::List>(&Actor::User, target)
                .unwrap()
                .output
                .is_empty()
        );
    });
    close(cx);
}

#[gpui::test]
fn final_checkpoint_starts_after_the_last_writer_and_finishes_before_replacement(
    cx: &mut TestAppContext,
) {
    let dir = setup(cx);
    let (done_write, wait_write) = oneshot::channel();
    let mut wait_write = Some(wait_write);
    let (done_checkpoint, wait_checkpoint) = oneshot::channel();
    let mut wait_checkpoint = Some(wait_checkpoint);
    let captured = Rc::new(Cell::new(false));
    let saw = captured.clone();
    let second = Rc::new(Cell::new(false));
    let saw_second = second.clone();
    let job = Arc::new(AtomicUsize::new(0));
    let calls = job.clone();
    let outcome = Rc::new(RefCell::new(None));
    let result = outcome.clone();
    cx.update(|cx| {
        release::before_release(cx, move |cx| {
            let waiting = wait_write.take().unwrap();
            let lib = cx.global::<Services>().library.clone().unwrap();
            async move {
                waiting.await.unwrap();
                let books = lib.call(&Actor::User, "book.list", json!({})).unwrap();
                let id = &books["output"][0]["id"];
                lib.call(
                    &Actor::User,
                    "book.update",
                    json!({"book":id,"summary":"settled writer"}),
                )
                .unwrap();
                Ok(())
            }
            .boxed_local()
        });
        release::after_drain(cx, move |cx| {
            assert!(release::is_releasing(cx));
            let lib = cx.global::<Services>().library.as_ref().unwrap();
            let books = lib.call(&Actor::User, "book.list", json!({})).unwrap();
            let book = lib
                .call(
                    &Actor::User,
                    "book.get",
                    json!({"book":books["output"][0]["id"]}),
                )
                .unwrap();
            assert_eq!(book["output"]["summary"], "settled writer");
            saw.set(true);
            let waiting = wait_checkpoint.take().unwrap();
            async move { waiting.await.unwrap() }.boxed_local()
        });
        release::after_drain(cx, move |_| {
            saw_second.set(true);
            async { Ok(()) }.boxed_local()
        });
        library::replace(
            cx,
            move |_, _| {
                calls.fetch_add(1, Ordering::SeqCst);
                Err("test replacement stopped".into())
            },
            move |out, _| *result.borrow_mut() = Some(out),
        );
        assert!(
            !captured.get(),
            "the synchronous checkpoint prefix must wait too"
        );
    });
    cx.run_until_parked();
    assert!(!captured.get());
    done_write.send(()).unwrap();
    wait(cx, || captured.get());
    assert!(!second.get());
    assert_eq!(job.load(Ordering::SeqCst), 0);
    assert!(outcome.borrow().is_none());
    done_checkpoint.send(Ok(())).unwrap();
    wait(cx, || outcome.borrow().is_some());
    assert!(second.get());
    assert_eq!(job.load(Ordering::SeqCst), 1);
    assert_eq!(
        outcome.borrow().as_ref().unwrap(),
        &Err("test replacement stopped".into())
    );
    cx.update(|cx| {
        assert_eq!(
            cx.global::<Services>()
                .library
                .as_ref()
                .unwrap()
                .library()
                .paths()
                .root,
            dir.path()
        )
    });
    close(cx);
}

#[gpui::test]
fn failed_final_checkpoint_keeps_the_original_library_and_skips_the_disk_job(
    cx: &mut TestAppContext,
) {
    let dir = setup(cx);
    let resumed = Rc::new(Cell::new(false));
    let resume = resumed.clone();
    let outcome = Rc::new(RefCell::new(None));
    let result = outcome.clone();
    cx.update(|cx| {
        release::after_drain(cx, |_| {
            async { Err("checkpoint failed".into()) }.boxed_local()
        });
        release::after_release(cx, move |cx| {
            assert!(!release::is_releasing(cx));
            assert!(cx.global::<Services>().library.is_some());
            resume.set(true);
        });
        library::replace(
            cx,
            |_, _| panic!("checkpoint failure must stop replacement"),
            move |out, _| *result.borrow_mut() = Some(out),
        );
    });
    wait(cx, || outcome.borrow().is_some());
    assert!(resumed.get());
    assert_eq!(
        outcome.borrow().as_ref().unwrap(),
        &Err("checkpoint failed".into())
    );
    cx.update(|cx| {
        let lib = cx.global::<Services>().library.as_ref().unwrap();
        assert_eq!(lib.library().paths().root, dir.path());
        assert!(lib.call(&Actor::User, "book.list", json!({})).is_ok());
    });
    close(cx);
}

#[gpui::test]
fn final_checkpoint_panics_resume_quit_and_the_registered_hook_can_retry(cx: &mut TestAppContext) {
    let _dir = setup(cx);
    let attempts = Rc::new(Cell::new(0));
    let attempt = attempts.clone();
    let resumes = Rc::new(Cell::new(0));
    let resume = resumes.clone();
    let quit_calls = Rc::new(Cell::new(0));
    let quit_call = quit_calls.clone();
    cx.update(|cx| {
        release::after_drain(cx, move |_| {
            let n = attempt.get();
            attempt.set(n + 1);
            assert_ne!(n, 0, "checkpoint prefix fault");
            async move {
                assert_ne!(n, 1, "checkpoint future fault");
                Ok(())
            }
            .boxed_local()
        });
        release::after_release(cx, move |_| resume.set(resume.get() + 1));
        quit::before_quit(cx, move |_| quit_call.set(quit_call.get() + 1));
    });
    for n in 1..=2 {
        cx.update(quit::request);
        wait(cx, || resumes.get() == n);
        assert_eq!(quit_calls.get(), 0);
    }
    cx.update(quit::request);
    wait(cx, || quit_calls.get() == 1);
    assert_eq!(attempts.get(), 3);
    assert_eq!(resumes.get(), 2);
    close(cx);
}

#[gpui::test]
fn any_failed_writer_skips_final_checkpoints_after_all_writers_settle(cx: &mut TestAppContext) {
    let _dir = setup(cx);
    let (done, waiting) = oneshot::channel();
    let mut waiting = Some(waiting);
    let resumed = Rc::new(Cell::new(false));
    let resume = resumed.clone();
    cx.update(|cx| {
        release::before_release(cx, |_| async { Err("writer failed".into()) }.boxed_local());
        release::before_release(cx, move |_| {
            let waiting = waiting.take().unwrap();
            async move { waiting.await.unwrap() }.boxed_local()
        });
        release::after_drain(cx, |_| panic!("failed writer cannot reach checkpoint"));
        release::after_release(cx, move |_| resume.set(true));
        quit::before_quit(cx, |_| panic!("failed writer cannot quit"));
        quit::request(cx);
    });
    cx.run_until_parked();
    assert!(!resumed.get());
    done.send(Ok(())).unwrap();
    wait(cx, || resumed.get());
    close(cx);
}

#[gpui::test]
fn producers_drain_before_checkpoint_and_resume_on_failure(cx: &mut TestAppContext) {
    let _dir = setup(cx);
    let (done, waiting) = oneshot::channel::<Result<(), String>>();
    let mut waiting = Some(waiting);
    let running = Rc::new(Cell::new(true));
    let finished = Rc::new(Cell::new(false));
    let finish = finished.clone();
    cx.update(|cx| {
        let producer = running.clone();
        release::before_release(cx, move |_| {
            let waiting = waiting.take().unwrap();
            let producer = producer.clone();
            async move {
                waiting.await.unwrap()?;
                producer.set(false);
                Ok(())
            }
            .boxed_local()
        });
        let producer = running.clone();
        release::after_drain(cx, move |cx| {
            assert!(release::is_releasing(cx));
            assert!(!producer.get());
            async { Err("checkpoint failed".into()) }.boxed_local()
        });
        let producer = running.clone();
        release::after_release(cx, move |_| producer.set(true));
        let producer = running.clone();
        library::replace(
            cx,
            |_, _| panic!("checkpoint failure"),
            move |result, cx| {
                assert_eq!(result, Err("checkpoint failed".into()));
                assert!(!release::is_releasing(cx));
                assert!(producer.get());
                finish.set(true);
            },
        );
    });
    cx.run_until_parked();
    assert!(
        running.get(),
        "producer stays active until its accepted work completes"
    );
    done.send(Ok(())).unwrap();
    wait(cx, || finished.get());
    close(cx);
}
