//! The production G1 lifecycle hook captures after all producers and gates failures.
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    time::{Duration, Instant},
};

use dr_shell::{Services, SettingsFile, ShellInfo, library, release};
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
    cx.update(dr_view_page::init);
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

#[gpui::test]
fn production_close_point_captures_last_producer_and_author_can_restore_after_reopen(
    cx: &mut TestAppContext,
) {
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
    let complete = Rc::new(Cell::new(false));
    let completed = complete.clone();
    let wanted = text.clone();
    let write = target.clone();
    cx.update(|cx| {
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
        library::replace(
            cx,
            |root, options| dr_store::Library::open(root, options).map_err(|e| e.to_string()),
            move |result, _| {
                result.unwrap();
                completed.set(true)
            },
        );
    });
    cx.run_until_parked();
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
                    target:target.clone(),
                    point: point.id.clone(),
                },
            )
            .unwrap()
            .output;
        assert_eq!(point.reason, "close");
        let point_id=point.id.clone();
        lib.call(&Actor::User,"module.set_prose",json!({"book":target.book,"owner":target.entry,"module":"mod-prose","paragraphs":[{"text":"later synthetic edit"}]})).unwrap();
        let expected=lib.call(&Actor::User,"entry_snapshot.preview",json!({"book":target.book,"entry":target.entry,"point":point_id})).unwrap()["output"]["expected"].clone();
        lib.call(&Actor::User,"entry_snapshot.restore",json!({"book":target.book,"entry":target.entry,"point":point_id,"expected":expected})).unwrap();
        assert_eq!(lib.call(&Actor::User,"prose.read",json!({"doc":doc})).unwrap()["output"]["paragraphs"][0]["text"],text);
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
fn production_final_checkpoint_fault_keeps_original_library_and_retries(cx: &mut TestAppContext) {
    use dr_workspace::commands::v3::snapshots as api;
    let dir = setup(cx);
    let target = cx.update(|cx| entry(cx.global::<Services>().library.as_ref().unwrap()));
    let doc = format!("body:{}/mod-prose", target.entry);
    let (send, recv) = oneshot::channel();
    let mut recv = Some(recv);
    let t = target.clone();
    let d = doc.clone();
    let result = Rc::new(RefCell::new(None));
    let seen = result.clone();
    cx.update(|cx| {
        release::before_release(cx,move |cx| {
            let Some(wait)=recv.take() else { return async { Ok(()) }.boxed_local(); };let lib=cx.global::<Services>().library.clone().unwrap();
            let (t,d)=(t.clone(),d.clone());
            async move {
                wait.await.unwrap();
                lib.call(&Actor::User,"module.set_prose",json!({"book":t.book,"owner":t.entry,"module":"mod-prose","paragraphs":[{"text":"last accepted author write"}]})).map_err(|e|e.to_string())?;
                assert!(lib.observe(&d).is_ok());
                lib.library().local_transaction(|tx| {
                    tx.execute_batch("CREATE TRIGGER final_checkpoint_fault BEFORE INSERT ON loro_update WHEN NEW.doc_id LIKE 'checkpoints:%' BEGIN SELECT RAISE(ABORT,'final checkpoint fault'); END;")?;Ok(())
                }).map_err(|e|e.to_string())?;
                Ok(())
            }.boxed_local()
        });
        library::replace(cx,|_,_|panic!("checkpoint failure must not release original library"),move |r,_|*seen.borrow_mut()=Some(r));
    });
    // Wait for the production AutomaticHistory::finish baseline. The late
    // writer installs the fault only after that checkpoint has committed.
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        cx.run_until_parked();
        if cx.update(|cx| {
            cx.global::<Services>()
                .library
                .as_ref()
                .unwrap()
                .run::<api::List>(&Actor::User, target.clone())
                .unwrap()
                .output
                .iter()
                .any(|p| p.reason == "close")
        }) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "production worker did not finish baseline"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    send.send(()).unwrap();
    wait(cx, || result.borrow().is_some());
    assert!(
        result
            .borrow()
            .as_ref()
            .unwrap()
            .as_ref()
            .unwrap_err()
            .contains("final checkpoint fault")
    );
    cx.update(|cx| {
        assert!(!release::is_releasing(cx));
        let lib = cx.global::<Services>().library.as_ref().unwrap();
        assert_eq!(lib.library().paths().root, dir.path());
        assert_eq!(
            lib.call(&Actor::User, "prose.read", json!({"doc":doc}))
                .unwrap()["output"]["paragraphs"][0]["text"],
            "last accepted author write"
        );
        lib.library()
            .local_transaction(|tx| {
                tx.execute_batch("DROP TRIGGER final_checkpoint_fault")?;
                Ok(())
            })
            .unwrap();
    });
    *result.borrow_mut() = None;
    let seen = result.clone();
    cx.update(|cx| {
        library::replace(
            cx,
            |root, options| dr_store::Library::open(root, options).map_err(|e| e.to_string()),
            move |r, _| *seen.borrow_mut() = Some(r),
        )
    });
    wait(cx, || result.borrow().is_some());
    assert!(result.borrow().as_ref().unwrap().is_ok());
    cx.update(|cx| {
        let lib = cx.global::<Services>().library.as_ref().unwrap();
        let current = lib.observe(&doc).unwrap().version;
        assert!(
            lib.run::<api::List>(&Actor::User, target)
                .unwrap()
                .output
                .iter()
                .any(|p| p.reason == "close" && p.bodies.get(&doc) == Some(&current))
        );
    });
    close(cx);
}
