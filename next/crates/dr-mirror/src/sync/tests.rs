use super::*;
use dr_testkit::seed::{DEFAULT_SEED, Preset, acceptance::novel_entry, generate_v3};
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
    mpsc,
};
use std::time::Duration;

struct Fixture {
    _db: tempfile::TempDir,
    out: tempfile::TempDir,
    ws: Workspace,
    book: BookId,
    id: BodyDocId,
    options: Options,
}
impl Fixture {
    fn new() -> Self {
        let db = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        let ws = Workspace::open_dir(db.path(), "mirror-regression").unwrap();
        let seed = generate_v3(Preset::Tiny, DEFAULT_SEED).unwrap();
        let book = seed.books[0].book_id().clone();
        seed.write_to(ws.library()).unwrap();
        seed.write_files_to(ws.library()).unwrap();
        let entry = novel_entry(
            &ws,
            book.as_str(),
            "tpl-chapter",
            "测试正文",
            Some("灯还亮着。"),
        );
        let id = BodyDocId::parse(&format!("{}/mod-prose", entry["id"].as_str().unwrap())).unwrap();
        let mut options = Options::new(out.path(), "test-installation", "test-app");
        options.settle = Duration::ZERO;
        let f = Self {
            _db: db,
            out,
            ws,
            book,
            id,
            options,
        };
        f.pass().run().unwrap();
        f
    }
    fn pass(&self) -> Pass<'_> {
        Pass::new(&self.ws, &self.options)
    }
    fn ledger(&self) -> Ledger<'_> {
        Ledger::new(
            self.ws.library(),
            &self.book,
            &self.out.path().canonicalize().unwrap(),
        )
    }
    fn row(&self) -> Row {
        self.ledger().files().unwrap()[&self.id].clone()
    }
    fn path(&self) -> PathBuf {
        self.pass()
            .folder(&self.book)
            .unwrap()
            .unwrap()
            .join(self.row().current.path)
    }
    fn text(&self) -> String {
        self.ws
            .call(
                &Actor::User,
                "prose.read",
                json!({"doc":DocId::Body(self.id.clone()).to_string()}),
            )
            .unwrap()["output"]["paragraphs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["text"].as_str().unwrap())
            .collect::<Vec<_>>()
            .join("\n")
    }
    fn outside(&self, text: &str) -> Vec<u8> {
        let bytes = fs::read_to_string(self.path())
            .unwrap()
            .replace("灯还亮着。", text);
        fs::write(self.path(), &bytes).unwrap();
        bytes.into_bytes()
    }
}

#[test]
fn a_third_version_after_an_interrupted_write_is_preserved_not_replayed() {
    let f = Fixture::new();
    let mut row = f.row();
    let mut intended = row.current.clone();
    intended.disk.as_mut().unwrap().sha = disk::sha256_hex(b"unacknowledged app version");
    row.outgoing = Some(intended);
    f.ledger().put_file(&f.id, &row).unwrap();
    let outside = f.outside("外面的另一稿。");
    let report = f.pass().run().unwrap();
    assert_eq!(f.text(), "灯还亮着。");
    let issue = report
        .issues
        .iter()
        .find(|i| i.problem == Problem::StaleBase)
        .expect("third version is not based on a known file");
    assert_eq!(fs::read(issue.kept.as_ref().unwrap()).unwrap(), outside);
    assert_eq!(f.pass().run().unwrap().merged.len(), 0);
    assert_eq!(f.text(), "灯还亮着。");
}

#[test]
fn composition_starting_during_merge_waits_at_the_commit_boundary() {
    let mut f = Fixture::new();
    let calls = Arc::new(AtomicUsize::new(0));
    let seen = calls.clone();
    // The first check lets parsing/merge proceed; composition starts before
    // the second check under the book lease.
    f.options.composing = Arc::new(move || seen.fetch_add(1, Ordering::SeqCst) > 0);
    let outside = f.outside("外面已经熄灯。");
    let report = f.pass().run().unwrap();
    assert!(report.composing.contains(&f.book));
    assert_eq!(f.text(), "灯还亮着。");
    assert_eq!(fs::read(f.path()).unwrap(), outside);
    f.options.composing = Arc::new(|| false);
    assert_eq!(f.pass().run().unwrap().merged.len(), 1);
    assert_eq!(f.text(), "外面已经熄灯。");
}

#[test]
fn remote_book_changes_wait_for_the_body_commit_lease() {
    let f = Fixture::new();
    let doc = DocId::Book(f.book.clone()).to_string();
    let bytes =
        f.ws.library()
            .load_copy(&doc)
            .unwrap()
            .export(loro::ExportMode::all_updates())
            .unwrap();
    let (attempt, attempted) = mpsc::channel();
    let (done, finished) = mpsc::channel();
    let mut worker = None;
    f.ws.with_book_lease(&f.book, || {
        let ws = f.ws.clone();
        worker = Some(std::thread::spawn(move || {
            attempt.send(()).unwrap();
            let result = ws.import_remote(&doc, None, bytes, &Actor::Sync);
            done.send(result).unwrap();
        }));
        attempted.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(
            matches!(
                finished.recv_timeout(Duration::from_millis(150)),
                Err(mpsc::RecvTimeoutError::Timeout)
            ),
            "remote import crossed a held book commit boundary"
        );
    });
    finished
        .recv_timeout(Duration::from_secs(5))
        .unwrap()
        .unwrap();
    worker.unwrap().join().unwrap();
}

#[test]
fn idle_restart_neither_reads_markdown_nor_renders_unchanged_bodies() {
    let f = Fixture::new();
    READS.set(0);
    RENDERS.set(0);
    let report = f.pass().run().unwrap();
    assert_eq!(report.written, 0);
    assert_eq!(READS.get(), 0);
    assert_eq!(RENDERS.get(), 0);
}

#[test]
fn preserved_problems_survive_idle_passes_and_a_project_rename() {
    let f = Fixture::new();
    let original = fs::read_to_string(f.path()).unwrap();
    let outside = original.replace(
        &format!("drifting-id: {}", f.id),
        "drifting-id: invalid-body",
    );
    fs::write(f.path(), &outside).unwrap();
    let first = f.pass().run().unwrap();
    assert!(first.issues.iter().any(|i| i.kept.is_some()));
    f.ws.call(
        &Actor::User,
        "book.update",
        json!({"book":f.book,"name":"改名后的项目"}),
    )
    .unwrap();
    for _ in 0..2 {
        let report = f.pass().run().unwrap();
        let issue = report
            .issues
            .iter()
            .find(|i| i.kept.is_some())
            .expect("unresolved preserved notice remains");
        assert_eq!(
            fs::read_to_string(issue.kept.as_ref().unwrap()).unwrap(),
            outside
        );
        assert!(
            issue
                .kept
                .as_ref()
                .unwrap()
                .starts_with(f.pass().folder(&f.book).unwrap().unwrap())
        );
    }
}

#[test]
fn a_save_racing_app_rename_is_kept_and_reported() {
    let f = Fixture::new();
    let old_path = f.path();
    f.ws.call(
        &Actor::User,
        "entry.update",
        json!({"book":f.book,"id":f.id.entry(),"title":"新文件名"}),
    )
    .unwrap();
    let target = old_path.clone();
    disk::seam::BEFORE_REMOVE.set(Some(Box::new(move |path| {
        if path == target {
            fs::write(path, b"outside save after hash").unwrap();
        }
    })));
    let report = f.pass().run().unwrap();
    disk::seam::BEFORE_REMOVE.set(None);
    let issue = report
        .issues
        .iter()
        .find(|i| {
            i.kept
                .as_ref()
                .is_some_and(|p| fs::read(p).unwrap() == b"outside save after hash")
        })
        .expect("racing old-path save must remain visible");
    assert_eq!(issue.problem, Problem::StaleBase);
    assert!(!old_path.exists());
    assert_eq!(f.text(), "灯还亮着。");
}

#[test]
fn later_body_merge_does_not_dismiss_a_preserved_problem() {
    let f = Fixture::new();
    let original = fs::read_to_string(f.path()).unwrap();
    fs::write(
        f.path(),
        original.replace(&format!("drifting-id: {}", f.id), "drifting-id: wrong"),
    )
    .unwrap();
    let first = f.pass().run().unwrap();
    let saved = first.issues.iter().find_map(|i| i.kept.clone()).unwrap();
    f.outside("正文另改一段。");
    let second = f.pass().run().unwrap();
    assert_eq!(second.merged.len(), 1);
    assert!(
        second
            .issues
            .iter()
            .any(|i| i.kept.as_ref() == Some(&saved))
    );
    fs::remove_file(&saved).unwrap();
    assert!(
        !f.pass()
            .run()
            .unwrap()
            .issues
            .iter()
            .any(|i| i.kept.as_ref() == Some(&saved))
    );
}

#[test]
fn book_commands_and_remote_imports_cannot_cross_a_live_body_commit() {
    for remote in [false, true] {
        let f = Fixture::new();
        f.outside("提交中的正文。");
        let doc = DocId::Book(f.book.clone()).to_string();
        let bytes =
            f.ws.library()
                .load_copy(&doc)
                .unwrap()
                .export(loro::ExportMode::all_updates())
                .unwrap();
        let (at_commit, reached) = mpsc::channel();
        let (release, proceed) = mpsc::channel();
        *project::seam::BEFORE_COMMIT.lock().unwrap() = Some((
            f.id.clone(),
            Box::new(move || {
                at_commit.send(()).unwrap();
                proceed.recv_timeout(Duration::from_secs(5)).unwrap();
            }),
        ));
        let ws = f.ws.clone();
        let options = f.options.clone();
        let merge = std::thread::spawn(move || Pass::new(&ws, &options).run());
        reached.recv_timeout(Duration::from_secs(5)).unwrap();
        let (attempt, attempted) = mpsc::channel();
        let (done, finished) = mpsc::channel();
        let ws = f.ws.clone();
        let book = f.book.clone();
        let entry = f.id.entry().clone();
        let writer = std::thread::spawn(move || {
            attempt.send(()).unwrap();
            if remote {
                ws.import_remote(&doc, None, bytes, &Actor::Sync).unwrap();
            } else {
                ws.call(&Actor::User, "entry.trash", json!({"book":book,"id":entry}))
                    .unwrap();
            }
            done.send(()).unwrap();
        });
        attempted.recv_timeout(Duration::from_secs(2)).unwrap();
        let blocked = matches!(
            finished.recv_timeout(Duration::from_millis(150)),
            Err(mpsc::RecvTimeoutError::Timeout)
        );
        release.send(()).unwrap();
        let report = merge.join().unwrap().unwrap();
        *project::seam::BEFORE_COMMIT.lock().unwrap() = None;
        writer.join().unwrap();
        assert!(
            blocked,
            "book mutation crossed the last activity check and body commit"
        );
        assert_eq!(report.merged.len(), 1, "{report:?}");
        assert_eq!(f.text(), "提交中的正文。");
    }
}

#[test]
fn an_imported_file_still_rewrites_read_only_fields_before_becoming_a_base() {
    let f = Fixture::new();
    let original = fs::read_to_string(f.path()).unwrap();
    let mut outside = String::new();
    let mut replaced = false;
    for line in original.lines() {
        if line.starts_with("挂在:") {
            outside.push_str("挂在: [\"[[外部挂名]]\"]\n");
            replaced = true;
        } else {
            outside.push_str(line);
            outside.push('\n');
        }
    }
    if !replaced {
        outside = outside.replacen("\n---\n", "\n挂在: [\"[[外部挂名]]\"]\n---\n", 1);
    }
    assert!(outside.contains("外部挂名"));
    fs::write(f.path(), &outside).unwrap();
    let report = f.pass().run().unwrap();
    let issue = report
        .issues
        .iter()
        .find(|i| i.problem == Problem::ReadOnly)
        .unwrap();
    assert_eq!(
        fs::read_to_string(issue.kept.as_ref().unwrap()).unwrap(),
        outside
    );
    assert!(!fs::read_to_string(f.path()).unwrap().contains("外部挂名"));
    assert!(
        f.pass()
            .run()
            .unwrap()
            .issues
            .iter()
            .any(|i| i.problem == Problem::ReadOnly)
    );
}

#[test]
fn a_new_file_after_an_unacknowledged_import_cannot_replay_its_text() {
    let f = Fixture::new();
    let mut old = f.row();
    let first = f.outside("第一次外改已经落入正文。");
    f.pass().run().unwrap();
    let landed = f.row().current.base;
    old.applying = Some(Applying {
        sha: disk::sha256_hex(&first),
        conflicts: Vec::new(),
        path: None,
        frontiers: Some(landed),
    });
    f.ledger().put_file(&f.id, &old).unwrap();
    let newer = String::from_utf8(first)
        .unwrap()
        .replace("第一次外改已经落入正文。", "第三个版本不能按最旧基线重放。");
    fs::write(f.path(), &newer).unwrap();
    let report = f.pass().run().unwrap();
    assert_eq!(f.text(), "第一次外改已经落入正文。");
    let issue = report
        .issues
        .iter()
        .find(|i| i.problem == Problem::StaleBase)
        .unwrap();
    assert_eq!(
        fs::read_to_string(issue.kept.as_ref().unwrap()).unwrap(),
        newer
    );
    assert_eq!(f.pass().run().unwrap().merged.len(), 0);
}

#[test]
#[cfg(unix)]
fn a_raced_save_remains_visible_when_preservation_or_its_directory_sync_fails() {
    for sync_failure in [false, true] {
        let f = Fixture::new();
        let path = f.path();
        let folder = f.pass().folder(&f.book).unwrap().unwrap();
        if !sync_failure {
            fs::write(folder.join(".drifting/preserved"), b"blocked").unwrap();
        }
        f.ws.call(&Actor::User, "prose.replace", json!({
            "doc":DocId::Body(f.id.clone()).to_string(), "find":"灯还亮着。", "replace":"App已经改过。"
        })).unwrap();
        let target = path.clone();
        disk::seam::BEFORE_EXCHANGE.set(Some(Box::new(move |path| {
            if path == target {
                fs::write(path, b"outside after the final check").unwrap();
                disk::seam::PUBLISH_SYNC_FAILS.set(sync_failure);
            }
        })));
        let report = f.pass().run().unwrap();
        disk::seam::BEFORE_EXCHANGE.set(None);
        disk::seam::PUBLISH_SYNC_FAILS.set(false);
        let kept = report
            .issues
            .iter()
            .find_map(|issue| issue.kept.clone())
            .expect("captured bytes need a visible receipt even when moving them fails");
        assert_eq!(fs::read(&kept).unwrap(), b"outside after the final check");
        assert_eq!(
            kept.starts_with(folder.join(".drifting/preserved")),
            sync_failure
        );
        assert!(
            report.preserved.is_empty(),
            "a failed preservation is not counted as a completed move"
        );
        assert!(fs::read_to_string(&path).unwrap().contains("App已经改过。"));
        let again = f.pass().run().unwrap();
        assert!(
            again
                .issues
                .iter()
                .any(|issue| issue.kept.as_ref() == Some(&kept))
        );
        assert_eq!(fs::read(&kept).unwrap(), b"outside after the final check");
    }
}

#[test]
fn a_kept_receipt_survives_a_later_error_aborting_the_book_pass() {
    let f = Fixture::new();
    novel_entry(
        &f.ws,
        f.book.as_str(),
        "tpl-group",
        "等待校验的空分组",
        None,
    );
    f.pass().run().unwrap();
    let folder = f.pass().folder(&f.book).unwrap().unwrap();
    let directories = f.ledger().project().unwrap().unwrap().directories;
    let empty = directories
        .iter()
        .map(|rel| folder.join(rel))
        .find(|path| path.is_dir() && fs::read_dir(path).unwrap().next().is_none())
        .expect("the added empty level has its directory");
    fs::remove_dir(&empty).unwrap();
    fs::write(&empty, b"block directory recreation after prose processing").unwrap();
    let original = fs::read_to_string(f.path()).unwrap();
    let changed = original.replace(&format!("drifting-id: {}", f.id), "drifting-id: invalid");
    fs::write(f.path(), &changed).unwrap();
    let report = f.pass().run().unwrap();
    assert!(
        !report.seen.contains_key(&f.book),
        "the late directory error must abort settle"
    );
    let durable = f.ledger().standing().unwrap();
    assert_eq!(durable.len(), 1, "the kept receipt must precede settle");
    let kept = folder.join(&durable[0].kept);
    assert_eq!(fs::read_to_string(&kept).unwrap(), changed);
    fs::remove_file(&empty).unwrap();
    fs::create_dir(empty).unwrap();
    assert!(
        f.pass()
            .run()
            .unwrap()
            .issues
            .iter()
            .any(|issue| issue.kept.as_ref() == Some(&kept))
    );
}
