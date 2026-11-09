use super::*;
use dr_shell::{Services, SettingsFile, ShellInfo};
use dr_ui::Appearance;
use dr_workspace::{Faults, WorkspaceOptions};
use gpui::{TestAppContext, VisualTestContext};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

fn wait(cx: &mut VisualTestContext, done: impl Fn(&mut VisualTestContext) -> bool) {
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        cx.run_until_parked();
        cx.update(|window, cx| window.draw(cx).clear(cx));
        if done(cx) {
            return;
        }
        assert!(Instant::now() < until, "material library timed out");
        std::thread::sleep(Duration::from_millis(3));
    }
}

#[gpui::test]
fn rename_failure_and_book_refresh_keep_the_draft(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let dir = tempfile::tempdir().unwrap();
    let store = dr_store::Library::open(dir.path(), dr_workspace::library_options("test")).unwrap();
    let seed = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let book = seed.books[0].book_id().to_string();
    let material = seed.books[0].book.view().materials().remove(0);
    seed.write_to(&store).unwrap();
    let faults = Arc::new(Faults::default());
    let ws = Library::open(
        store,
        WorkspaceOptions {
            faults: Some(faults.clone()),
            ..Default::default()
        },
    )
    .unwrap();
    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "0.2.0-dev",
                url_scheme: "drifting-next-dev",
                forced_appearance: Some(Appearance::Light),
            },
            Services::default(),
            SettingsFile::in_memory(),
            cx,
        )
    });
    let snapshot = Rc::new(Book::load(&ws, &book).unwrap());
    let lib = ws.clone();
    let window = cx.add_window(move |window, cx| {
        LibraryPanel::new(WeakEntity::new_invalid(), Some(lib), snapshot, window, cx)
    });
    let panel = window.root(cx).unwrap();
    let cx = &mut VisualTestContext::from_window(window.into(), cx);
    let key = folders::material_key(material.id.as_str());
    let draft = format!("{} {}", material.title, material.title);
    cx.update(|window, cx| {
        panel.update(cx, |p, cx| {
            p.start_rename(&key, window, cx);
            p.renaming
                .as_ref()
                .unwrap()
                .field
                .update(cx, |f, cx| f.set_text(&draft, cx));
            faults.arm("after_prose");
            p.finish_rename(&key, Some(draft.clone()), window, cx);
        })
    });
    wait(cx, |cx| {
        panel.read_with(cx, |p, _| {
            p.renaming.as_ref().is_some_and(|r| r.error && !r.busy)
        })
    });
    panel.update(cx, |p, cx| {
        p.set_book(Rc::new(Book::load(&ws, &book).unwrap()), cx)
    });
    assert_eq!(
        panel.read_with(cx, |p, cx| p
            .renaming
            .as_ref()
            .unwrap()
            .field
            .read(cx)
            .text()),
        draft
    );
    cx.update(|window, cx| {
        panel.update(cx, |p, cx| {
            p.finish_rename(&key, Some(draft.clone()), window, cx)
        })
    });
    wait(cx, |cx| panel.read_with(cx, |p, _| p.renaming.is_none()));
    assert_eq!(
        Book::load(&ws, &book)
            .unwrap()
            .material_items()
            .iter()
            .find(|m| m.id == material.id.as_str())
            .unwrap()
            .title,
        draft
    );
    // Even if an external deletion removes the row, its input stays until cancel.
    cx.update(|window, cx| panel.update(cx, |p, cx| p.start_rename(&key, window, cx)));
    ws.call(
        &Actor::User,
        "material.delete",
        serde_json::json!({"book":book,"id":material.id}),
    )
    .unwrap();
    panel.update(cx, |p, cx| {
        p.set_book(Rc::new(Book::load(&ws, &book).unwrap()), cx)
    });
    assert!(panel.read_with(cx, |p, _| p.renaming.is_some()));
    cx.update(|window, cx| panel.update(cx, |p, cx| p.finish_rename(&key, None, window, cx)));
    assert!(panel.read_with(cx, |p, _| p.renaming.is_none()));
    ws.close();
}

#[gpui::test]
fn a_completed_old_book_job_cannot_apply_to_the_next_book(cx: &mut TestAppContext) {
    use std::cell::Cell;
    cx.executor().allow_parking();
    let dir = tempfile::tempdir().unwrap();
    let ws = Library::open_dir(dir.path(), "v3-library-callback").unwrap();
    let first = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let second = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED + 1,
    )
    .unwrap();
    let a = first.books[0].book_id().to_string();
    let b = second.books[0].book_id().to_string();
    first.write_to(ws.library()).unwrap();
    second.write_to(ws.library()).unwrap();
    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "0.2.0-dev",
                url_scheme: "drifting-next-dev",
                forced_appearance: Some(Appearance::Light),
            },
            Services::default(),
            SettingsFile::in_memory(),
            cx,
        )
    });
    let snapshot = Rc::new(Book::load(&ws, &a).unwrap());
    let lib = ws.clone();
    let window = cx.add_window(move |window, cx| {
        LibraryPanel::new(WeakEntity::new_invalid(), Some(lib), snapshot, window, cx)
    });
    let panel = window.root(cx).unwrap();
    let cx = &mut VisualTestContext::from_window(window.into(), cx);
    struct Completed(Arc<std::sync::atomic::AtomicBool>);
    impl Drop for Completed {
        fn drop(&mut self) {
            self.0.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }
    let completed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let completion = completed.clone();
    let called = Rc::new(Cell::new(false));
    let observed = called.clone();
    panel.update(cx, |p, cx| {
        spawn_lib(
            p.lib.clone(),
            (a.clone(), p.book_epoch),
            cx,
            move |_| Completed(completion),
            move |_, _, _| observed.set(true),
        );
        // Switch inside this update, before the asynchronous continuation can run.
        p.set_book(Rc::new(Book::load(&ws, &b).unwrap()), cx);
        p.set_book(Rc::new(Book::load(&ws, &a).unwrap()), cx);
    });
    wait(cx, |_| completed.load(std::sync::atomic::Ordering::SeqCst));
    assert!(!called.get());
    assert_eq!(panel.read_with(cx, |p, _| p.book_id()), a);
    ws.close();
}
