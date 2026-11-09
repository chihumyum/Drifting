//! The production v3 Home must release its library with the window's other pages.
use std::{
    cell::RefCell,
    path::PathBuf,
    rc::Rc,
    time::{Duration, Instant},
};

use dr_shell::{Services, SettingsFile, ShellInfo, Workspace, library, release};
use dr_testkit::seed::{self, Preset};
use dr_view_home::v3::Home;
use dr_workspace::{Actor, Workspace as Library};
use gpui::{Entity, TestAppContext, VisualTestContext, WeakEntity};
use serde_json::{Value, json};

struct Fixture {
    dir: tempfile::TempDir,
    book: String,
    title: String,
}

impl Fixture {
    fn new(seed: u64, title: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let store =
            dr_store::Library::open(dir.path(), dr_workspace::library_options("test")).unwrap();
        let made = seed::generate_v3(Preset::Tiny, seed).unwrap();
        let book = made.books[0].book_id().to_string();
        made.write_to(&store).unwrap();
        store.close().unwrap();
        let lib = Library::open_dir(dir.path(), "test").unwrap();
        lib.call(
            &Actor::User,
            "book.update",
            json!({"book":book,"name":title}),
        )
        .unwrap();
        lib.close();
        Self {
            dir,
            book,
            title: title.into(),
        }
    }
}

fn setup<'a>(
    cx: &'a mut TestAppContext,
    original: &Fixture,
) -> (Entity<Workspace>, &'a mut VisualTestContext) {
    cx.executor().allow_parking();
    let lib = Library::open_dir(original.dir.path(), "test").unwrap();
    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "test",
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                library: Some(lib),
                book: Some(original.book.clone()),
                ..Default::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
        dr_view_home::init(cx);
    });
    let (ws, cx) = cx.add_window_view(Workspace::new);
    wait(cx, |cx| {
        ws.read_with(cx, |ws, _| {
            ws.book.id == original.book && ws.book.v3().is_some()
        })
    });
    ws.update(cx, |ws, cx| ws.open_home(cx));
    home_ready(&ws, cx, &original.title);
    (ws, cx)
}

fn wait(cx: &mut VisualTestContext, done: impl Fn(&mut VisualTestContext) -> bool) {
    let until = Instant::now() + Duration::from_secs(20);
    loop {
        cx.executor().advance_clock(Duration::from_millis(40));
        cx.run_until_parked();
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear(cx)
        });
        if done(cx) {
            return;
        }
        assert!(Instant::now() < until, "v3 Home release did not settle");
        std::thread::sleep(Duration::from_millis(3));
    }
}

fn home(ws: &Entity<Workspace>, cx: &mut VisualTestContext) -> WeakEntity<Home> {
    ws.read_with(cx, |ws, _| {
        ws.v3_home
            .clone()
            .unwrap()
            .downcast::<Home>()
            .unwrap()
            .downgrade()
    })
}

fn home_ready(ws: &Entity<Workspace>, cx: &mut VisualTestContext, title: &str) {
    wait(cx, |cx| {
        let h = home(ws, cx);
        h.upgrade().is_some_and(|h| {
            h.read_with(cx, |h, _| {
                h.loaded.as_ref().is_some_and(|data| data.title == title)
            })
        })
    });
}

fn replace(
    cx: &mut VisualTestContext,
    job: impl FnOnce(&std::path::Path, dr_store::LibraryOptions) -> Result<dr_store::Library, String>
    + Send
    + 'static,
) -> Result<(), String> {
    let completed = Rc::new(RefCell::new(None));
    let done = completed.clone();
    cx.update(|_, cx| {
        library::replace(cx, job, move |result, cx| {
            assert!(
                !release::is_releasing(cx),
                "recovery and admission precede completion"
            );
            *done.borrow_mut() = Some(result);
        })
    });
    wait(cx, |_| completed.borrow().is_some());
    completed.borrow_mut().take().unwrap()
}

fn root(cx: &mut VisualTestContext) -> PathBuf {
    cx.update(|_, cx| {
        cx.global::<Services>()
            .library
            .as_ref()
            .unwrap()
            .library()
            .paths()
            .root
            .clone()
    })
}

fn book(cx: &mut VisualTestContext, id: &str) -> Value {
    cx.update(|_, cx| {
        cx.global::<Services>()
            .library
            .as_ref()
            .unwrap()
            .call(&Actor::User, "book.get", json!({"book":id}))
            .unwrap()["output"]
            .clone()
    })
}

fn switch(cx: &mut VisualTestContext, original: &Fixture, next: &Fixture) -> Result<(), String> {
    let expected = original.dir.path().to_owned();
    let next_root = next.dir.path().to_owned();
    replace(cx, move |root, options| {
        assert_eq!(root, expected);
        // The old store lock is available before the replacement job starts.
        let old = dr_store::Library::open(root, options.clone()).map_err(|e| e.to_string())?;
        old.close().map_err(|e| e.to_string())?;
        dr_store::Library::open(next_root, options).map_err(|e| e.to_string())
    })
}

fn close(cx: &mut VisualTestContext) {
    cx.update(|_, cx| cx.global::<Services>().library.as_ref().unwrap().close());
}

#[gpui::test]
fn the_real_v3_home_releases_the_old_library_before_switching(cx: &mut TestAppContext) {
    let original = Fixture::new(seed::DEFAULT_SEED, "Original v3 book");
    let next = Fixture::new(seed::DEFAULT_SEED + 1, "Replacement v3 book");
    let (ws, cx) = setup(cx, &original);
    let old_home = home(&ws, cx);
    let before = book(cx, &original.book);
    assert_eq!(switch(cx, &original, &next), Ok(()));
    assert!(
        old_home.upgrade().is_none(),
        "the old production Home was dropped"
    );
    assert_eq!(root(cx), next.dir.path());
    home_ready(&ws, cx, &next.title);
    assert_eq!(book(cx, &next.book)["name"], next.title);
    // Success also releases the original store for an independent reopening.
    let old = Library::open_dir(original.dir.path(), "test").unwrap();
    assert_eq!(
        old.call(&Actor::User, "book.get", json!({"book":original.book}))
            .unwrap()["output"],
        before
    );
    old.close();
    close(cx);
}

#[gpui::test]
fn a_failed_job_recreates_home_on_the_original_library_and_allows_retry(cx: &mut TestAppContext) {
    let original = Fixture::new(seed::DEFAULT_SEED, "Original v3 book");
    let next = Fixture::new(seed::DEFAULT_SEED + 1, "Replacement v3 book");
    let (ws, cx) = setup(cx, &original);
    let old_home = home(&ws, cx);
    let before = book(cx, &original.book);
    assert_eq!(
        replace(cx, |root, options| {
            dr_store::Library::open(root, options)
                .unwrap()
                .close()
                .unwrap();
            Err("replacement job failed".into())
        }),
        Err("replacement job failed".into())
    );
    assert!(old_home.upgrade().is_none());
    assert_eq!(root(cx), original.dir.path());
    home_ready(&ws, cx, &original.title);
    assert_eq!(book(cx, &original.book), before);
    // A recreated Home follows the recovered Services and can still query/write.
    cx.update(|_, cx| {
        cx.global::<Services>()
            .library
            .as_ref()
            .unwrap()
            .call(
                &Actor::User,
                "book.update",
                json!({"book":original.book,"summary":"Recovered v3 book"}),
            )
            .unwrap();
    });
    wait(cx, |cx| {
        home(&ws, cx).upgrade().unwrap().read_with(cx, |h, _| {
            h.loaded
                .as_ref()
                .is_some_and(|data| data.summary == "Recovered v3 book")
        })
    });
    assert_eq!(switch(cx, &original, &next), Ok(()));
    home_ready(&ws, cx, &next.title);
    close(cx);
}

#[gpui::test]
fn another_holder_refuses_shutdown_then_recreated_home_releases_on_retry(cx: &mut TestAppContext) {
    let original = Fixture::new(seed::DEFAULT_SEED, "Original v3 book");
    let next = Fixture::new(seed::DEFAULT_SEED + 1, "Replacement v3 book");
    let (ws, cx) = setup(cx, &original);
    let held = cx.update(|_, cx| cx.global::<Services>().library.clone().unwrap());
    let old_home = home(&ws, cx);
    let before = book(cx, &original.book);
    let failed = replace(cx, |_, _| panic!("another holder must prevent the job"));
    assert!(
        failed
            .unwrap_err()
            .contains("other clones of the workspace are alive")
    );
    assert!(old_home.upgrade().is_none());
    assert_eq!(root(cx), original.dir.path());
    home_ready(&ws, cx, &original.title);
    assert_eq!(book(cx, &original.book), before);
    drop(held);
    assert_eq!(switch(cx, &original, &next), Ok(()));
    home_ready(&ws, cx, &next.title);
    close(cx);
}
