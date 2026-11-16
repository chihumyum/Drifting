use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use dr_mirror::{
    Options,
    sync::{Pass, Problem},
};
use dr_model::{DocId, id::BookId};
use dr_testkit::seed::{
    DEFAULT_SEED, Preset,
    acceptance::{entry_point, novel_entry, restore_entry},
    digest_v3, generate_v3,
};
use dr_workspace::{Actor, Workspace};
use serde_json::{Value, json};

struct Fixture {
    db: tempfile::TempDir,
    out: tempfile::TempDir,
    ws: Workspace,
    book: BookId,
    options: Options,
}

impl Fixture {
    fn new(preset: Preset) -> Self {
        let db = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        let ws = Workspace::open_dir(db.path(), "mirror-acceptance").unwrap();
        let seeded = generate_v3(preset, DEFAULT_SEED).unwrap();
        let book = seeded.books[0].book_id().clone();
        seeded.write_to(ws.library()).unwrap();
        seeded.write_files_to(ws.library()).unwrap();
        let mut options = Options::new(out.path(), "test-installation", "test-app");
        options.settle = Duration::ZERO;
        Self {
            db,
            out,
            ws,
            book,
            options,
        }
    }

    fn pass(&self) -> Pass<'_> {
        Pass::new(&self.ws, &self.options)
    }

    fn chapter(&self, title: &str, prose: &str) -> (String, String) {
        let row = novel_entry(
            &self.ws,
            self.book.as_str(),
            "tpl-chapter",
            title,
            Some(prose),
        );
        let id = row["id"].as_str().unwrap().to_owned();
        let doc = format!("body:{id}/mod-prose");
        (id, doc)
    }

    fn call(&self, command: &str, input: Value) -> Value {
        self.ws.call(&Actor::User, command, input).unwrap()["output"].clone()
    }

    fn texts(&self, doc: &str) -> Vec<String> {
        self.call("prose.read", json!({"doc":doc}))["paragraphs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["text"].as_str().unwrap().to_owned())
            .collect()
    }
}

fn files(path: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for entry in fs::read_dir(path).unwrap() {
        let path = entry.unwrap().path();
        if path.file_name().unwrap().to_string_lossy().starts_with('.') {
            continue;
        }
        if path.is_dir() {
            out.extend(files(&path));
        } else if path.extension().is_some_and(|ext| ext == "md") {
            out.push(path);
        }
    }
    out
}

fn find(root: &Path, filename: &str) -> PathBuf {
    files(root)
        .into_iter()
        .find(|p| p.file_name().unwrap() == filename)
        .unwrap()
}

#[test]
fn every_seed_round_trips_without_advancing_any_book_or_body() {
    for preset in [Preset::Tiny, Preset::Lite, Preset::Showcase] {
        let f = Fixture::new(preset);
        let before = digest_v3(f.ws.library(), f.book.as_str()).unwrap();
        let docs = f.ws.library().docs(Some(f.book.as_str()), None).unwrap();
        let versions = |f: &Fixture| {
            docs.iter()
                .filter(|d| matches!(DocId::parse(&d.doc_id), Ok(DocId::Book(_) | DocId::Body(_))))
                .map(|doc| {
                    (
                        doc.doc_id.clone(),
                        f.ws.library()
                            .head(&doc.doc_id)
                            .unwrap()
                            .map(|h| h.frontiers),
                    )
                })
                .collect::<Vec<_>>()
        };
        let original = versions(&f);
        f.pass().run().unwrap();
        for path in files(f.out.path()) {
            let bytes = fs::read_to_string(&path).unwrap();
            if bytes.starts_with("---\ndrifting-id: ") {
                fs::write(&path, format!("{bytes}\n")).unwrap();
            }
        }
        let report = f.pass().run().unwrap();
        assert!(report.issues.is_empty(), "{preset:?}: {:?}", report.issues);
        assert_eq!(versions(&f), original, "{preset:?}");
        assert_eq!(digest_v3(f.ws.library(), f.book.as_str()).unwrap(), before);
        assert!(f.db.path().is_dir());
    }
}

#[test]
fn editing_then_moving_a_markdown_file_keeps_the_prose_and_puts_the_file_back() {
    let f = Fixture::new(Preset::Tiny);
    let (_, doc) = f.chapter("镜像雨夜", "她站在雨里。");
    f.pass().run().unwrap();
    let file = find(f.out.path(), "镜像雨夜.md");
    let moved = file.with_file_name("外面改的名.md");
    fs::rename(&file, &moved).unwrap();
    let edited = fs::read_to_string(&moved).unwrap().replace("雨里", "桥上");
    fs::write(&moved, edited).unwrap();
    let report = f.pass().run().unwrap();
    assert_eq!(f.texts(&doc), ["她站在桥上。"]);
    assert!(report.issues.iter().any(|i| i.problem == Problem::Moved));
    assert!(file.is_file());
    assert!(!moved.exists());
    let duplicate = file.with_file_name("另一个副本.md");
    fs::copy(&file, &duplicate).unwrap();
    let edited = fs::read_to_string(&duplicate)
        .unwrap()
        .replace("在桥上", "在别处");
    fs::write(&duplicate, &edited).unwrap();
    assert!(
        f.pass()
            .run()
            .unwrap()
            .issues
            .iter()
            .any(|i| i.problem == Problem::Duplicate)
    );
    assert_eq!(f.texts(&doc), ["她站在桥上。"]);
    assert_eq!(fs::read_to_string(duplicate).unwrap(), edited);
}

#[test]
fn a_file_cannot_switch_project_or_entry_by_changing_its_identity() {
    let f = Fixture::new(Preset::Tiny);
    let (first, first_doc) = f.chapter("甲文件", "甲写的字。");
    let other = generate_v3(Preset::Tiny, DEFAULT_SEED + 1).unwrap();
    let other_id = other.books[0].book_id().clone();
    other.write_to(f.ws.library()).unwrap();
    let other_entry = novel_entry(
        &f.ws,
        other_id.as_str(),
        "tpl-chapter",
        "乙文件",
        Some("乙写的字。"),
    );
    let second = other_entry["id"].as_str().unwrap();
    let second_doc = format!("body:{second}/mod-prose");
    f.pass().run().unwrap();
    let path = find(f.out.path(), "甲文件.md");
    let bytes = fs::read_to_string(&path)
        .unwrap()
        .replace(&first, second)
        .replace("甲写", "外面写");
    fs::write(&path, &bytes).unwrap();
    let report = f.pass().run().unwrap();
    assert!(
        report
            .issues
            .iter()
            .any(|row| row.problem == Problem::WrongId)
    );
    assert_eq!(f.texts(&first_doc), ["甲写的字。"]);
    assert_eq!(f.texts(&second_doc), ["乙写的字。"]);
    assert!(
        report
            .preserved
            .iter()
            .any(|path| fs::read_to_string(path).unwrap() == bytes)
    );
}

#[test]
fn a_snapshot_restore_or_trash_cannot_merge_old_file_bytes() {
    let f = Fixture::new(Preset::Tiny);
    let (entry, doc) = f.chapter("快照恢复", "原来的雨夜。");
    let point = entry_point(&f.ws, &f.book, &entry);
    f.call(
        "prose.replace",
        json!({"doc":doc,"find":"原来的","replace":"后来写的"}),
    );
    f.pass().run().unwrap();
    let path = find(f.out.path(), "快照恢复.md");
    let old = fs::read_to_string(&path)
        .unwrap()
        .replace("后来写的", "在磁盘上写的");
    fs::write(&path, &old).unwrap();
    restore_entry(&f.ws, &f.book, &entry, &point);
    let report = f.pass().run().unwrap();
    assert_eq!(f.texts(&doc), ["原来的雨夜。"]);
    assert!(
        report
            .preserved
            .iter()
            .any(|path| fs::read_to_string(path).unwrap() == old)
    );

    f.call("entry.trash", json!({"book":f.book,"id":entry}));
    f.pass().run().unwrap();
    assert!(!path.exists());
    fs::write(&path, &old).unwrap();
    f.pass().run().unwrap();
    assert_eq!(f.texts(&doc), ["原来的雨夜。"]);
}

#[test]
fn switching_templates_retires_the_previous_markdown_basis() {
    let f = Fixture::new(Preset::Tiny);
    let (id, doc) = f.chapter("换模板", "模板切换前写的字。");
    f.pass().run().unwrap();
    let path = find(f.out.path(), "换模板.md");
    let edited = fs::read_to_string(&path)
        .unwrap()
        .replace("模板切换前写的", "旧模板的外部编辑");
    fs::write(&path, &edited).unwrap();
    f.call(
        "entry.update",
        json!({"book":f.book,"id":id,"template":"tpl-idea"}),
    );
    let report = f.pass().run().unwrap();
    assert!(report.merged.is_empty());
    assert_eq!(f.texts(&doc), ["模板切换前写的字。"]);
    assert!(
        fs::read_to_string(&path)
            .unwrap()
            .contains("模板切换前写的字。")
    );
    assert!(
        report
            .preserved
            .iter()
            .any(|path| fs::read_to_string(path).unwrap() == edited)
    );
}

#[test]
fn a_restored_library_does_not_read_its_replaced_librarys_markdown_as_edits() {
    let f = Fixture::new(Preset::Tiny);
    let (_, doc) = f.chapter("整库恢复", "备份里的字。");
    f.pass().run().unwrap();
    let path = find(f.out.path(), "整库恢复.md");
    let package = f.out.path().join("backup.drifting");
    let store = f.ws.library();
    let options = store.options().clone();
    store.export_backup(&package, &Default::default()).unwrap();
    let staged = dr_store::backup::stage(f.db.path(), &package, &options.app_version).unwrap();

    f.call(
        "prose.replace",
        json!({"doc":doc,"find":"备份里的","replace":"换库前写的"}),
    );
    f.pass().run().unwrap();
    let before_restore = fs::read_to_string(&path).unwrap();
    assert!(before_restore.contains("换库前写的字。"));

    let Fixture {
        db,
        out,
        ws,
        book,
        options: mirror_options,
    } = f;
    ws.shutdown().unwrap();
    let (library, _) = dr_store::Library::restore_staged(db.path(), &staged, options).unwrap();
    let ws = Workspace::open(library, Default::default()).unwrap();
    let f = Fixture {
        db,
        out,
        ws,
        book,
        options: mirror_options,
    };
    let report = f.pass().run().unwrap();
    assert!(report.merged.is_empty());
    assert_eq!(f.texts(&doc), ["备份里的字。"]);
    assert!(fs::read_to_string(&path).unwrap().contains("备份里的字。"));
    assert!(
        report
            .preserved
            .iter()
            .any(|path| fs::read_to_string(path).unwrap() == before_restore)
    );
}

#[test]
fn bad_or_recent_files_are_held_and_failed_preservation_cannot_overwrite() {
    let mut f = Fixture::new(Preset::Tiny);
    let (_, doc) = f.chapter("磁盘边界", "她把灯关了。");
    f.pass().run().unwrap();
    let path = find(f.out.path(), "磁盘边界.md");
    let root = f.pass().folder(&f.book).unwrap().unwrap();
    let original = fs::read_to_string(&path).unwrap();
    let damaged = original.replace("\n---\n\n", "\ntags: [unfinished\n---\n\n");
    fs::write(&path, &damaged).unwrap();
    let report = f.pass().run().unwrap();
    assert!(
        report
            .issues
            .iter()
            .any(|i| i.problem == Problem::Frontmatter)
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), damaged);
    assert_eq!(f.texts(&doc), ["她把灯关了。"]);

    let change = original.replace("灯关了", "门关了");
    fs::write(&path, &change).unwrap();
    f.options.settle = Duration::from_secs(5);
    assert!(f.pass().run().unwrap().waiting);
    assert_eq!(f.texts(&doc), ["她把灯关了。"]);
    f.options.settle = Duration::ZERO;
    f.pass().run().unwrap();
    assert_eq!(f.texts(&doc), ["她把门关了。"]);

    fs::write(root.join(".drifting/preserved"), b"occupied").unwrap();
    fs::write(&path, [0xff, 0xfe, 0xf8]).unwrap();
    let result = f.pass().run();
    assert!(
        result.as_ref().is_err()
            || result
                .unwrap()
                .issues
                .iter()
                .any(|i| i.problem == Problem::NotUtf8)
    );
    assert_eq!(fs::read(&path).unwrap(), [0xff, 0xfe, 0xf8]);
}

#[test]
fn overlapping_edits_keep_both_words_and_one_comment_after_a_replayed_pass() {
    let f = Fixture::new(Preset::Tiny);
    let (id, doc) = f.chapter("并发", "安娜在镇口等车。\n响了一声。\n又响了一声。");
    f.pass().run().unwrap();
    let file = find(f.out.path(), "并发.md");
    let written = fs::read_to_string(&file).unwrap();
    let ledger =
        f.ws.library()
            .local_entries(dr_mirror::ledger::SCOPE, Some(f.book.as_str()))
            .unwrap()
            .into_iter()
            .find(|row| row.key.ends_with(&format!("/file/{id}/mod-prose")))
            .unwrap();
    f.call(
        "prose.replace",
        json!({"doc":doc,"find":"口等","replace":"口很久等"}),
    );
    let changed = written.replace("口等", "口一直等");
    fs::write(&file, &changed).unwrap();
    f.pass().run().unwrap();
    let body = f.texts(&doc);
    assert!(body[0].contains("很久") && body[0].contains("一直"));
    let comments = || {
        f.call(
            "comment.list",
            json!({"book":f.book, "target":{"kind":"entry","id":id}}),
        )
    };
    assert_eq!(comments().as_array().unwrap().len(), 1);

    // The body reached storage but this replica still has its old ledger.
    f.ws.library()
        .local_set(
            dr_mirror::ledger::SCOPE,
            &ledger.key,
            &ledger.value,
            Some(f.book.as_str()),
        )
        .unwrap();
    let version = f.ws.version(&doc).unwrap();
    fs::write(&file, changed).unwrap();
    f.pass().run().unwrap();
    assert_eq!(f.ws.version(&doc).unwrap(), version);
    assert_eq!(comments().as_array().unwrap().len(), 1);
}

#[test]
fn a_markdown_checklist_and_its_comments_stay_in_step_both_ways() {
    let f = Fixture::new(Preset::Tiny);
    let (id, _) = f.chapter("清单", "前文。\n后文。");
    f.pass().run().unwrap();
    let file = find(f.out.path(), "清单.md");
    let comments = || {
        f.call(
            "comment.list",
            json!({"book":f.book,"origin":"task","target":{"kind":"entry","id":id}}),
        )
    };
    let edit = |replace: &str, with: &str| {
        let body = fs::read_to_string(&file).unwrap().replace(replace, with);
        fs::write(&file, body).unwrap();
        f.pass().book(&f.book).unwrap();
    };
    edit("前文。", "前文。\n\n- [ ] 核对钟楼报时。");
    let comment = comments()[0]["id"].clone();
    assert_eq!(comments()[0]["status"], "open");
    edit("- [ ] 核对", "- [x] 再核对");
    assert_eq!(comments()[0]["id"], comment);
    assert_eq!(comments()[0]["status"], "resolved");
    assert_eq!(comments()[0]["body"], "再核对钟楼报时。");
    edit("- [x]", "- [ ]");
    assert_eq!(comments()[0]["status"], "open");
    f.call(
        "comment.update",
        json!({"book":f.book,"id":comment,"status":"resolved"}),
    );
    f.pass().book(&f.book).unwrap();
    assert!(fs::read_to_string(&file).unwrap().contains("- [x] 再核对"));
    edit("- [x] 再核对钟楼报时。\n\n", "");
    assert!(comments().as_array().unwrap().is_empty());
}

#[test]
fn wrong_installation_and_oversized_file_have_independent_boundaries() {
    let f = Fixture::new(Preset::Tiny);
    let (_, doc) = f.chapter("超大", "她望着钟楼。");
    let pass = f.pass();
    pass.book(&f.book).unwrap();
    let root = pass.folder(&f.book).unwrap().unwrap();
    let file = find(&root, "超大.md");
    let utf8 = fs::read(&file).unwrap();
    let foreign = json!({"installationId":"another","book":f.book,"app":"test-app"});
    fs::write(root.join(".drifting/owner.json"), foreign.to_string()).unwrap();
    fs::write(&file, b"still owned elsewhere").unwrap();
    let blocked = pass.book(&f.book).unwrap();
    assert!(
        blocked
            .issues
            .iter()
            .any(|i| i.problem == Problem::OwnedElsewhere)
    );
    assert_eq!(fs::read(&file).unwrap(), b"still owned elsewhere");

    fs::write(
        root.join(".drifting/owner.json"),
        foreign.to_string().replace("another", "test-installation"),
    )
    .unwrap();
    let limit = dr_mirror::disk::MAX_FILE_BYTES;
    fs::File::create(&file).unwrap().set_len(limit + 1).unwrap();
    let report = pass.book(&f.book).unwrap();
    assert!(report.issues.iter().any(|i| i.problem == Problem::TooLarge));
    assert!(
        report
            .preserved
            .iter()
            .any(|p| fs::metadata(p).unwrap().len() == limit + 1)
    );
    assert_eq!(fs::read(&file).unwrap(), utf8);
    assert_eq!(f.texts(&doc), ["她望着钟楼。"]);
}

#[cfg(unix)]
#[test]
fn a_symlink_at_the_expected_path_never_reads_or_writes_its_target() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new(Preset::Tiny);
    let (_entry, doc) = f.chapter("链接边界", "她看向海。");
    f.pass().run().unwrap();
    let path = find(f.out.path(), "链接边界.md");
    let target = f.db.path().join("external.md");
    let text = fs::read_to_string(&path).unwrap().replace("海。", "山。");
    fs::write(&target, &text).unwrap();
    fs::remove_file(&path).unwrap();
    symlink(&target, &path).unwrap();
    let report = f.pass().run().unwrap();
    assert!(
        report
            .issues
            .iter()
            .any(|i| i.problem == Problem::UnsafePath)
    );
    assert_eq!(f.texts(&doc), ["她看向海。"]);
    assert_eq!(fs::read_to_string(&target).unwrap(), text);
}
