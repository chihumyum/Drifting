use super::*;
use crate::{SettingsFile, library, quit};
use dr_model::id::BookId;
use dr_testkit::seed::{DEFAULT_SEED, Preset, generate_v3};
use dr_workspace::{Actor, Workspace};
use gpui::TestAppContext;
use serde_json::json;
use std::{cell::RefCell, fs, path::Path};

struct Fixture {
    _library: tempfile::TempDir,
    _output: tempfile::TempDir,
    root: PathBuf,
    file: PathBuf,
    book: String,
    entry: String,
}

fn setup(cx: &mut TestAppContext) -> Fixture {
    cx.executor().allow_parking();
    let library = tempfile::tempdir().unwrap();
    let output = tempfile::tempdir().unwrap();
    let root = output.path().join("markdown");
    fs::create_dir(&root).unwrap();
    let mut options = dr_workspace::library_options("mirror-lifecycle");
    options.device = Some(dr_store::Device::open(library.path().join("device")).unwrap());
    let ws = Workspace::open(
        dr_store::Library::open(library.path(), options).unwrap(),
        Default::default(),
    )
    .unwrap();
    let seeded = generate_v3(Preset::Tiny, DEFAULT_SEED).unwrap();
    let book = seeded.books[0].book_id().to_string();
    seeded.write_to(ws.library()).unwrap();
    seeded.write_files_to(ws.library()).unwrap();
    let entries = ws
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
    let file = cx.update(|cx| {
        crate::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "0.2.0-dev",
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                library: Some(ws),
                ..Default::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
        Settings::set_device_memory(
            cx,
            FOLDER_KEY,
            Some(root.to_string_lossy().into_owned().into()),
        );
        init(cx);
        let report = cx
            .global::<State>()
            .running
            .as_ref()
            .unwrap()
            .sync_now()
            .unwrap();
        assert!(report.issues.is_empty(), "{report:?}");
        let ws = cx.global::<Services>().library.as_ref().unwrap();
        let dir = dr_mirror::sync::Pass::new(ws, &Options::new(&root, "test", "test"))
            .folder(&book.parse::<BookId>().unwrap())
            .unwrap()
            .unwrap();
        find_file(&dir, &format!("{entry}/mod-prose")).unwrap()
    });
    Fixture {
        _library: library,
        _output: output,
        root,
        file,
        book,
        entry,
    }
}

fn find_file(dir: &Path, identity: &str) -> Option<PathBuf> {
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            if let Some(found) = find_file(&path, identity) {
                return Some(found);
            }
        } else if path.extension().is_some_and(|ext| ext == "md")
            && fs::read_to_string(&path).unwrap().contains(identity)
        {
            return Some(path);
        }
    }
    None
}

fn wait(cx: &mut TestAppContext, done: impl Fn() -> bool) {
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        cx.run_until_parked();
        if done() {
            return;
        }
        assert!(Instant::now() < until, "Markdown lifecycle did not finish");
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn close(cx: &mut TestAppContext) {
    cx.update(|cx| {
        if let Some(mirror) = cx.global_mut::<State>().running.take() {
            mirror.stop();
        }
        cx.global::<Services>().library.as_ref().unwrap().close();
    });
}

fn block_folder(f: &Fixture) {
    // A disconnected/moved directory cannot be recreated over this path.
    fs::rename(&f.root, f.root.with_extension("moved")).unwrap();
    fs::write(&f.root, b"unavailable mount").unwrap();
}

fn late_writer(f: &Fixture, cx: &mut App) -> String {
    let (book, entry) = (f.book.clone(), f.entry.clone());
    let doc = format!("body:{entry}/mod-prose");
    let body = cx
        .global::<Services>()
        .library
        .as_ref()
        .unwrap()
        .call(&Actor::User, "prose.read", json!({"doc":doc}))
        .unwrap();
    let text = format!(
        "{} final accepted words",
        body["output"]["paragraphs"][0]["text"].as_str().unwrap()
    );
    let written = text.clone();
    release::before_release(cx, move |cx| {
        let ws = cx.global::<Services>().library.clone().unwrap();
        let (book, entry, text) = (book.clone(), entry.clone(), written.clone());
        async move {
            ws.call(
                &Actor::User,
                "module.set_prose",
                json!({
                    "book":book, "owner":entry, "module":"mod-prose", "paragraphs":[{"text":text}]
                }),
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        }
        .boxed_local()
    });
    text
}

#[gpui::test]
fn quitting_writes_the_last_accepted_prose_before_later_checkpoints(cx: &mut TestAppContext) {
    let f = setup(cx);
    let done = Rc::new(Cell::new(false));
    let completed = done.clone();
    cx.update(|cx| {
        let expected = late_writer(&f, cx);
        let file = f.file.clone();
        release::after_drain(cx, move |_| {
            assert!(fs::read_to_string(&file).unwrap().contains(&expected));
            async { Ok(()) }.boxed_local()
        });
        quit::before_quit(cx, move |_| completed.set(true));
        quit::request(cx);
    });
    wait(cx, || done.get());
    close(cx);
}

#[gpui::test]
fn replacing_the_library_writes_the_last_accepted_prose(cx: &mut TestAppContext) {
    let f = setup(cx);
    let result = Rc::new(RefCell::new(None));
    let completed = result.clone();
    cx.update(|cx| {
        let expected = late_writer(&f, cx);
        let file = f.file.clone();
        library::replace(
            cx,
            move |root, options| {
                assert!(fs::read_to_string(&file).unwrap().contains(&expected));
                dr_store::Library::open(root, options).map_err(|e| e.to_string())
            },
            move |result, _| *completed.borrow_mut() = Some(result),
        );
    });
    wait(cx, || result.borrow().is_some());
    assert!(
        result.borrow().as_ref().unwrap().is_ok(),
        "{:?}",
        result.borrow()
    );
    close(cx);
}

#[gpui::test]
fn an_unavailable_folder_does_not_block_quit_or_the_hosted_drain(cx: &mut TestAppContext) {
    let f = setup(cx);
    block_folder(&f);
    let hosted = Rc::new(Cell::new(false));
    let drained = hosted.clone();
    let done = Rc::new(Cell::new(false));
    let completed = done.clone();
    cx.update(|cx| {
        let expected = late_writer(&f, cx);
        let doc = format!("body:{}/mod-prose", f.entry);
        release::after_drain(cx, move |cx| {
            let ws = cx.global::<Services>().library.as_ref().unwrap();
            let body = ws
                .call(&Actor::User, "prose.read", json!({"doc":doc}))
                .unwrap();
            assert_eq!(body["output"]["paragraphs"][0]["text"], expected);
            drained.set(true);
            async { Ok(()) }.boxed_local()
        });
        quit::before_quit(cx, move |_| completed.set(true));
        quit::request(cx);
    });
    wait(cx, || done.get());
    assert!(hosted.get());
    cx.update(|cx| {
        assert!(
            Notifications::items(cx)
                .iter()
                .any(|n| n.source == Source::MarkdownFolder)
        )
    });
    close(cx);
}

#[gpui::test]
fn an_unavailable_folder_does_not_block_library_replacement(cx: &mut TestAppContext) {
    let f = setup(cx);
    block_folder(&f);
    let result = Rc::new(RefCell::new(None));
    let completed = result.clone();
    cx.update(|cx| {
        library::replace(
            cx,
            |root, options| dr_store::Library::open(root, options).map_err(|e| e.to_string()),
            move |result, _| *completed.borrow_mut() = Some(result),
        )
    });
    wait(cx, || result.borrow().is_some());
    assert!(
        result.borrow().as_ref().unwrap().is_ok(),
        "{:?}",
        result.borrow()
    );
    close(cx);
}

#[gpui::test]
fn an_unavailable_folder_can_be_disabled(cx: &mut TestAppContext) {
    let f = setup(cx);
    block_folder(&f);
    let done = Rc::new(Cell::new(false));
    let completed = done.clone();
    cx.update(|cx| {
        reconfigure(cx, move |cx| {
            Settings::set_device_memory(cx, OFF_KEY, Some(true.into()));
            completed.set(true);
        })
    });
    wait(cx, || done.get());
    cx.update(|cx| {
        assert!(!is_on(cx));
        assert!(cx.global::<State>().running.is_none());
    });
    close(cx);
}

#[gpui::test]
fn an_unavailable_folder_can_be_replaced(cx: &mut TestAppContext) {
    let f = setup(cx);
    block_folder(&f);
    let next = tempfile::tempdir().unwrap();
    let path = next.path().canonicalize().unwrap();
    cx.update(|cx| set_folder(path.clone(), cx));
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        cx.run_until_parked();
        if cx.update(|cx| {
            folder(cx).as_ref() == Some(&path) && cx.global::<State>().pending.is_none()
        }) {
            break;
        }
        assert!(
            Instant::now() < until,
            "unavailable folder prevented changing its location"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    cx.update(|cx| assert!(cx.global::<State>().running.is_some()));
    assert_eq!(fs::read(&f.root).unwrap(), b"unavailable mount");
    close(cx);
}

#[gpui::test]
fn an_unresolved_issue_keeps_one_pinned_notice_until_it_is_resolved(cx: &mut TestAppContext) {
    let f = setup(cx);
    let issue = Issue {
        book: f.book.clone(),
        doc: Some(format!("body:{}/mod-prose", f.entry)),
        title: "Markdown conflict".into(),
        path: f.file.clone(),
        problem: Problem::FieldConflict,
        kept: None,
    };
    cx.update(|cx| {
        tell(Heard::Issues(vec![issue.clone()]), cx);
        let id = Notifications::items(cx)
            .iter()
            .find(|n| n.source == Source::MarkdownFolder)
            .unwrap()
            .id;
        tell(Heard::Issues(vec![issue.clone()]), cx);
        let notices: Vec<_> = Notifications::items(cx)
            .iter()
            .filter(|n| n.source == Source::MarkdownFolder)
            .collect();
        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0].id, id);
        assert!(notices[0].pinned);
        tell(Heard::Issues(Vec::new()), cx);
        assert!(Notifications::items(cx).iter().all(|n| n.id != id));
    });
    close(cx);
}

#[gpui::test]
fn an_unresolved_notice_returns_after_older_issues_free_capacity(cx: &mut TestAppContext) {
    let f = setup(cx);
    let issues: Vec<_> = (0..51)
        .map(|index| Issue {
            book: f.book.clone(),
            doc: Some(format!("body:{}/mod-prose", f.entry)),
            title: format!("Markdown conflict {index}"),
            path: f.root.join(format!("conflict-{index}.md")),
            problem: Problem::FieldConflict,
            kept: None,
        })
        .collect();
    cx.update(|cx| {
        tell(Heard::Issues(issues.clone()), cx);
        assert_eq!(cx.global::<State>().told.len(), 51);
        assert_eq!(Notifications::items(cx).len(), 50);
        tell(Heard::Issues(vec![issues[50].clone()]), cx);
        let notices = Notifications::items(cx);
        assert_eq!(notices.len(), 1);
        assert!(notices[0].text.contains("Markdown conflict 50"));
        assert!(notices[0].pinned);
    });
    close(cx);
}
