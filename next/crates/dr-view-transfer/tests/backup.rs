//! Backup and restore dialogs in the shell over a real library (GPUI's test
//! platform). The backup is a real `.drifting`; the restore checks it for
//! real, asks the 0.1 question, then hands the checked copy to the shell's
//! replace step (a stand-in here: the shell's library swap is F6's).

use std::cell::RefCell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use dr_shell::{Services, SettingsFile, ShellInfo, Workspace};
use dr_store::Library;
use dr_store::backup::{Progress, Step};
use dr_view_transfer::backup::{self, Replace};
use dr_view_transfer::{State, TransferDialog};
use dr_workspace::{Actor, Workspace as Lib, WorkspaceOptions, library_options};
use futures::StreamExt as _;
use gpui::{Entity, TestAppContext, VisualTestContext};
use serde_json::json;

const VERSION: &str = "0.2.0-dev";

fn library() -> (tempfile::TempDir, Lib) {
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(dir.path().join("library"), library_options(VERSION)).unwrap();
    let ws = Lib::open(lib, WorkspaceOptions::default()).unwrap();
    let book = ws
        .call(&Actor::User, "book.create", json!({"name": "慢钟"}))
        .unwrap()["output"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    ws.call(
        &Actor::User,
        "chapter.create",
        json!({"book": book, "title": "一", "text": "钟停了。"}),
    )
    .unwrap();
    (dir, ws)
}

fn setup(cx: &mut TestAppContext, lib: Lib) -> (Entity<Workspace>, &mut VisualTestContext) {
    cx.executor().allow_parking();
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
                library: Some(lib),
                ..Services::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
        dr_view_transfer::init(cx);
    });
    let (view, cx) = cx.add_window_view(Workspace::new);
    wait(cx, |cx| cx.read(|cx| !view.read(cx).book.is_empty()));
    (view, cx)
}

fn wait(cx: &mut VisualTestContext, mut done: impl FnMut(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        cx.run_until_parked();
        if done(cx) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out");
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn state(d: &Entity<TransferDialog>, cx: &mut VisualTestContext) -> State {
    d.read_with(cx, |d, _| d.state.clone())
}

fn shown(view: &Entity<Workspace>, cx: &mut VisualTestContext) -> bool {
    cx.read(|cx| view.read(cx).dialog.is_some())
}

fn record_progress(
    d: &Entity<TransferDialog>,
    cx: &mut VisualTestContext,
) -> (Rc<RefCell<Vec<State>>>, gpui::Subscription) {
    let states = Rc::new(RefCell::new(Vec::new()));
    let recorded = states.clone();
    let subscription = cx.cx.update(|cx| {
        cx.observe(d, move |dialog, cx| {
            recorded.borrow_mut().push(dialog.read(cx).state.clone());
        })
    });
    (states, subscription)
}

/// A replace step that only records what it was handed.
fn recording(result: Result<(), String>) -> (Replace, Rc<RefCell<Vec<usize>>>) {
    let seen: Rc<RefCell<Vec<usize>>> = Rc::default();
    let s = seen.clone();
    let replace: Replace = Rc::new(move |staged, _, cx| {
        s.borrow_mut().push(staged.summary().books.len());
        let result = result.clone();
        cx.background_executor().spawn(async move { result })
    });
    (replace, seen)
}

#[gpui::test]
fn a_backup_is_written_then_checked_asked_about_and_handed_over(cx: &mut TestAppContext) {
    let (dir, lib) = library();
    let (view, cx) = setup(cx, lib.clone());
    let file = dir.path().join("Drifting-2026-11-08.drifting");

    let d = cx
        .cx
        .update(|cx| backup::backup_path(lib.clone(), file.clone(), cx));
    let (backup_states, _backup_subscription) = record_progress(&d, cx);
    assert!(shown(&view, cx));
    wait(cx, |cx| !d.read_with(cx, |d, _| d.is_working()));
    let State::Done { text, .. } = state(&d, cx) else {
        panic!("{:?}", state(&d, cx))
    };
    assert!(text.contains("Drifting-2026-11-08.drifting"), "{text}");
    assert!(file.exists());
    assert!(
        backup_states
            .borrow()
            .iter()
            .any(|s| { matches!(s, State::Working { progress: Some(p), .. } if *p > 0.0) }),
        "packing must report actual bytes before the result"
    );
    // Closed from inside the window, as its Close button's click runs.
    cx.update(|_, cx| d.update(cx, |d, cx| d.close(cx)));
    cx.run_until_parked();
    assert!(!shown(&view, cx));

    // Restore: checked, then the question, then the shell's step.
    let (replace, seen) = recording(Ok(()));
    let d = cx
        .cx
        .update(|cx| backup::restore_path(lib.clone(), file.clone(), replace, cx));
    let (inspect_states, _inspect_subscription) = record_progress(&d, cx);
    wait(cx, |cx| !d.read_with(cx, |d, _| d.is_working()));
    let State::Confirm { text, .. } = state(&d, cx) else {
        panic!("{:?}", state(&d, cx))
    };
    assert!(text.contains("慢钟"), "the books by name: {text}");
    assert!(
        inspect_states
            .borrow()
            .iter()
            .any(|s| { matches!(s, State::Working { progress: Some(p), .. } if *p > 0.0) }),
        "extraction must report actual bytes before confirmation"
    );
    cx.cx.update(|cx| d.update(cx, |d, cx| d.confirm(cx)));
    wait(cx, |cx| !shown(&view, cx));
    assert_eq!(*seen.borrow(), vec![1]);
}

#[gpui::test]
fn a_failed_replace_says_so_and_cancel_lets_the_copy_go(cx: &mut TestAppContext) {
    let (dir, lib) = library();
    let (view, cx) = setup(cx, lib.clone());
    let file = dir.path().join("b.drifting");
    let d = cx
        .cx
        .update(|cx| backup::backup_path(lib.clone(), file.clone(), cx));
    wait(cx, |cx| !d.read_with(cx, |d, _| d.is_working()));

    let (replace, _) = recording(Err("the library could not be closed".into()));
    let d = cx
        .cx
        .update(|cx| backup::restore_path(lib.clone(), file.clone(), replace, cx));
    wait(cx, |cx| matches!(state(&d, cx), State::Confirm { .. }));
    cx.cx.update(|cx| d.update(cx, |d, cx| d.confirm(cx)));
    wait(cx, |cx| matches!(state(&d, cx), State::Failed { .. }));
    let State::Failed { reason, text, .. } = state(&d, cx) else {
        unreachable!()
    };
    assert_eq!(
        reason,
        dr_i18n::keys::settings::sync::backup::errors::UNKNOWN
    );
    assert!(text.contains("the library could not be closed"), "{text}");

    // Asked again and cancelled: nothing is handed over.
    let (replace, seen) = recording(Ok(()));
    let d = cx
        .cx
        .update(|cx| backup::restore_path(lib.clone(), file, replace, cx));
    wait(cx, |cx| matches!(state(&d, cx), State::Confirm { .. }));
    cx.cx.update(|cx| d.update(cx, |d, cx| d.close(cx)));
    cx.run_until_parked();
    assert!(!shown(&view, cx));
    assert!(seen.borrow().is_empty());
}

#[gpui::test]
fn a_file_that_is_not_a_backup_is_refused(cx: &mut TestAppContext) {
    let (dir, lib) = library();
    let (_view, cx) = setup(cx, lib.clone());
    let file = dir.path().join("notes.drifting");
    std::fs::write(&file, "just text").unwrap();
    let (replace, seen) = recording(Ok(()));
    let d = cx
        .cx
        .update(|cx| backup::restore_path(lib.clone(), file, replace, cx));
    wait(cx, |cx| !d.read_with(cx, |d, _| d.is_working()));
    let State::Failed { reason, .. } = state(&d, cx) else {
        panic!("{:?}", state(&d, cx))
    };
    assert_eq!(
        reason,
        dr_i18n::keys::settings::sync::backup::errors::INVALID
    );
    assert!(seen.borrow().is_empty());
}

fn transfer_dialog(
    view: &Entity<Workspace>,
    cx: &mut VisualTestContext,
) -> Option<Entity<TransferDialog>> {
    cx.read(|cx| {
        view.read(cx)
            .dialog
            .clone()
            .and_then(|d| d.downcast::<TransferDialog>().ok())
    })
}

/// Settings' two rows dispatch the actions: 「导出备份…」 goes through the
/// save panel, 「选择备份…」 through the file panel to the registered replace
/// step (and without one, says it could not replace the library).
#[gpui::test]
fn the_settings_actions_back_up_and_restore(cx: &mut TestAppContext) {
    let (dir, lib) = library();
    let (view, cx) = setup(cx, lib);
    let file = dir.path().join("Drifting-backup.drifting");
    cx.update(|window, cx| window.dispatch_action(Box::new(dr_shell::actions::BackupLibrary), cx));
    cx.run_until_parked();
    assert!(cx.did_prompt_for_new_path());
    cx.simulate_new_path_selection({
        let file = file.clone();
        move |_| Some(file)
    });
    wait(cx, |cx| {
        transfer_dialog(&view, cx).is_some_and(|d| matches!(state(&d, cx), State::Done { .. }))
    });
    assert!(file.exists());
    let d = transfer_dialog(&view, cx).unwrap();
    cx.cx.update(|cx| d.update(cx, |d, cx| d.close(cx)));
    cx.run_until_parked();

    // No replace step registered yet: checked, asked, then it says so.
    let restore = |cx: &mut VisualTestContext| {
        cx.update(|window, cx| {
            window.dispatch_action(Box::new(dr_shell::actions::RestoreLibrary), cx)
        });
        cx.run_until_parked();
        assert!(cx.did_prompt_for_paths());
        cx.simulate_path_prompt_response({
            let file = file.clone();
            move |_| Some(vec![file])
        });
        wait(cx, |cx| {
            transfer_dialog(&view, cx)
                .is_some_and(|d| matches!(state(&d, cx), State::Confirm { .. }))
        });
        let d = transfer_dialog(&view, cx).unwrap();
        cx.cx.update(|cx| d.update(cx, |d, cx| d.confirm(cx)));
        d
    };
    let d = restore(cx);
    wait(cx, |cx| matches!(state(&d, cx), State::Failed { .. }));
    cx.cx.update(|cx| d.update(cx, |d, cx| d.close(cx)));
    cx.run_until_parked();

    // With the shell's step registered, the checked copy goes to it.
    let (replace, seen) = recording(Ok(()));
    cx.cx.update(|cx| backup::set_replace(cx, replace));
    restore(cx);
    wait(cx, |cx| !shown(&view, cx));
    assert_eq!(*seen.borrow(), vec![1]);
}

/// A restore reports the bytes of its current step, then returns to an
/// indeterminate bar for the atomic replacement. It is never considered
/// finished just because one step reached its byte total.
#[gpui::test]
fn restore_progress_crosses_steps_and_does_not_replace_the_outcome(cx: &mut TestAppContext) {
    let (dir, lib) = library();
    let (_view, cx) = setup(cx, lib.clone());
    let file = dir.path().join("progress.drifting");
    lib.library()
        .export_backup(&file, &Default::default())
        .unwrap();
    let (tx, rx) = futures::channel::mpsc::unbounded::<Progress>();
    let receiver = RefCell::new(Some(rx));
    let replace: Replace = Rc::new(move |_, mut report, cx| {
        let mut rx = receiver.borrow_mut().take().unwrap();
        cx.background_executor().spawn(async move {
            while let Some(p) = rx.next().await {
                assert!(report(&p), "closing a view must not cancel a restore");
            }
            Err("replace failed".into())
        })
    });
    let d = cx
        .cx
        .update(|cx| backup::restore_path(lib, file, replace, cx));
    wait(cx, |cx| matches!(state(&d, cx), State::Confirm { .. }));
    cx.cx.update(|cx| d.update(cx, |d, cx| d.confirm(cx)));

    use dr_i18n::keys::settings::sync::backup as k;
    for (step, done, total, fraction, label) in [
        (Step::SaveCurrent, 1, 4, Some(0.25), k::EXPORTING),
        (Step::SaveCurrent, 4, 4, Some(1.0), k::EXPORTING),
        (Step::CopyAssets, 1, 2, Some(0.5), k::RESTORING),
        (Step::Replace, 0, 0, None, k::RESTORING),
    ] {
        tx.unbounded_send(Progress { step, done, total }).unwrap();
        wait(
            cx,
            |cx| matches!(state(&d, cx), State::Working { progress, .. } if progress == fraction),
        );
        let State::Working { name, .. } = state(&d, cx) else {
            unreachable!()
        };
        let expected = cx.read(|cx| dr_shell::Strings::get(cx).t(label).to_owned());
        assert_eq!(name, expected);
    }
    drop(tx);
    wait(cx, |cx| matches!(state(&d, cx), State::Failed { .. }));
    cx.run_until_parked();
    assert!(matches!(state(&d, cx), State::Failed { text, .. } if text.contains("replace failed")));
}
