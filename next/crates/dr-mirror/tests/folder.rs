use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use dr_mirror::{
    Mirror, Options,
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
    let mut f = Fixture::new(Preset::Tiny);
    let (_, doc) = f.chapter("镜像雨夜", "她站在雨里。");
    f.pass().run().unwrap();
    let file = find(f.out.path(), "镜像雨夜.md");
    let moved = file.with_file_name("外面改的名.md");
    fs::rename(&file, &moved).unwrap();
    let edited = fs::read_to_string(&moved).unwrap().replace("雨里", "桥上");
    fs::write(&moved, edited).unwrap();
    f.options.settle = Duration::from_secs(10);
    assert!(f.pass().book(&f.book).unwrap().waiting);
    assert!(!file.exists());
    assert_eq!(f.texts(&doc), ["她站在雨里。"]);
    f.options.settle = Duration::ZERO;
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
fn a_file_event_ingests_external_changes_without_advancing_the_app_writeback() {
    check_external_save(|path, changed| {
        let temporary = path.with_extension("new");
        fs::write(&temporary, changed).unwrap();
        fs::rename(temporary, path).unwrap();
    });
}

#[test]
fn an_in_place_save_ingests_external_changes_without_advancing_the_app_writeback() {
    check_external_save(|path, changed| fs::write(path, changed).unwrap());
}

fn check_external_save(save: impl FnOnce(&Path, String)) {
    let mut f = Fixture::new(Preset::Tiny);
    let (_, local) = f.chapter("本机的一篇", "室内的灯还亮着。");
    let (_, outside) = f.chapter("外面的一篇", "天色早就暗了。");
    // Neither deadline expires during the test. The separate final pass
    // publishes the local change even while the timer is still pending.
    f.options.quiet = Duration::from_secs(60);
    f.options.max_wait = Duration::from_secs(60);
    f.options.settle = Duration::from_millis(60);
    let mirror = Mirror::start(f.ws.clone(), f.options.clone()).unwrap();
    mirror.sync_now().unwrap();
    let local_path = find(f.out.path(), "本机的一篇.md");
    let outside_path = find(f.out.path(), "外面的一篇.md");
    f.call(
        "prose.replace",
        json!({"doc":local,"find":"室内的灯","replace":"街上的灯"}),
    );
    let changed = fs::read_to_string(&outside_path)
        .unwrap()
        .replace("早就", "刚刚");
    save(&outside_path, changed);
    let start = std::time::Instant::now();
    while f.texts(&outside) != ["天色刚刚暗了。"] {
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "the external save did not merge: body {:?}, issues {:?}",
            f.texts(&outside),
            mirror.issues()
        );
        std::thread::sleep(Duration::from_millis(25));
    }
    assert!(
        fs::read_to_string(&local_path)
            .unwrap()
            .contains("室内的灯")
    );
    mirror.sync_now().unwrap();
    assert!(fs::read_to_string(local_path).unwrap().contains("街上的灯"));
    mirror.stop();
}

#[test]
fn writing_the_reserved_file_initializes_an_empty_level_prose_module() {
    let f = Fixture::new(Preset::Tiny);
    let entry = novel_entry(&f.ws, f.book.as_str(), "tpl-group", "卷首", None);
    let owner = entry["id"].as_str().unwrap();
    let doc = format!("body:{owner}/extra-prose");
    f.call(
        "entry_template.put_module",
        json!({"book":f.book,"template":"tpl-group","module":{
            "id":"extra-prose","kind":"prose","name":"续记"
        }}),
    );
    f.pass().book(&f.book).unwrap();
    let root = f.pass().folder(&f.book).unwrap().unwrap();
    let level = fs::read_dir(&root)
        .unwrap()
        .filter_map(|p| p.ok())
        .map(|p| p.path().join("卷首"))
        .find(|p| p.is_dir())
        .unwrap();
    let path = level.join("卷首 · 续记.md");
    assert!(!path.exists());
    assert!(f.ws.library().doc_info(&doc).unwrap().is_none());
    fs::write(&path, "她把记事本翻到最后一页。\n").unwrap();
    assert_eq!(
        f.pass().book(&f.book).unwrap().merged.as_slice(),
        std::slice::from_ref(&doc)
    );
    assert_eq!(f.texts(&doc), ["她把记事本翻到最后一页。"]);
    assert!(
        fs::read_to_string(path)
            .unwrap()
            .contains(&format!("drifting-id: {owner}/extra-prose"))
    );
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

    let blocked = root.join(".drifting/preserved");
    fs::write(&blocked, b"occupied").unwrap();
    fs::write(&path, [0xff, 0xfe, 0xf8]).unwrap();
    let report = f.pass().run().unwrap();
    assert!(
        report
            .issues
            .iter()
            .any(|i| i.problem == Problem::UnsafePath),
        "{report:?}"
    );
    assert_eq!(fs::read(&path).unwrap(), [0xff, 0xfe, 0xf8]);
    fs::remove_file(blocked).unwrap();
    let report = f.pass().run().unwrap();
    assert!(report.issues.iter().any(|i| i.problem == Problem::NotUtf8));
    assert_eq!(report.preserved.len(), 1);
    assert_eq!(fs::read(&report.preserved[0]).unwrap(), [0xff, 0xfe, 0xf8]);
    assert!(fs::read_to_string(path).unwrap().contains("她把门关了。"));
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
    assert_eq!(comments()[0]["body"]["text"], "再核对钟楼报时。");
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

impl Fixture {
    fn field(&self, entry: &str, module: &str, field: &str) -> Value {
        self.call("entry.get", json!({"book":self.book,"id":entry}))["fields"][module][field]
            .clone()
    }

    fn set_field(&self, entry: &str, module: &str, field: &str, value: Value) {
        self.call(
            "module.set_field",
            json!({"book":self.book,"entry":entry,"module":module,"field":field,"value":value}),
        );
    }

    /// A fields module on the chapter template with one field per kind the
    /// spellings below exercise.
    fn more_fields(&self) {
        self.call(
            "entry_template.put_module",
            json!({"book":self.book,"template":"tpl-chapter","module":{
                "id":"mf-more","kind":"fields","name":"更多","config":{"defs":[
                    {"id":"words","name":"字数目标","field_type":"number"},
                    {"id":"proofread","name":"已校对","field_type":"toggle"},
                    {"id":"names","name":"别名","field_type":"aliases"},
                ]}
            }}),
        );
    }
}

fn edit_file(path: &Path, from: &str, to: &str) -> String {
    let before = fs::read_to_string(path).unwrap();
    assert!(before.contains(from), "{from:?} not in {before}");
    let after = before.replacen(from, to, 1);
    fs::write(path, &after).unwrap();
    after
}

#[test]
fn other_editors_field_spellings_merge_and_values_that_do_not_fit_are_kept_aside() {
    let f = Fixture::new(Preset::Tiny);
    f.more_fields();
    let (id, _) = f.chapter("字段写法", "她数着钟声。");
    f.set_field(&id, "mod-fields", "summary", json!("旧梗概"));
    f.set_field(&id, "mf-more", "words", json!(1200));
    f.pass().run().unwrap();
    let path = find(f.out.path(), "字段写法.md");
    let written = fs::read_to_string(&path).unwrap();
    for line in [
        "梗概: 旧梗概\n",
        "字数目标: 1200\n",
        "已校对:\n",
        "aliases:\n",
    ] {
        assert!(written.contains(line), "{line:?} in {written}");
    }

    // Numbers and booleans for text, a quoted number, one alias without a
    // list: all read as the author meant them, nothing kept aside.
    edit_file(&path, "梗概: 旧梗概\n", "梗概: 2026\n");
    edit_file(&path, "字数目标: 1200\n", "字数目标: \"3000\"\n");
    edit_file(&path, "已校对:\n", "已校对: true\n");
    edit_file(&path, "aliases:\n", "aliases: 老王\n");
    let report = f.pass().run().unwrap();
    assert!(report.issues.is_empty(), "{:?}", report.issues);
    assert!(report.preserved.is_empty());
    assert_eq!(f.field(&id, "mod-fields", "summary"), json!("2026"));
    assert_eq!(f.field(&id, "mf-more", "words"), json!(3000.0));
    assert_eq!(f.field(&id, "mf-more", "proofread"), json!(true));
    assert_eq!(f.field(&id, "mf-more", "names"), json!(["老王"]));
    let rewritten = fs::read_to_string(&path).unwrap();
    assert!(rewritten.contains("梗概: \"2026\"\n"), "{rewritten}");
    assert!(rewritten.contains("aliases: [\"老王\"]\n"), "{rewritten}");

    // What still does not fit keeps the App's value; the file is kept aside
    // first and the author is told.
    let mut kept = Vec::new();
    for (from, to) in [
        ("梗概: \"2026\"\n", "梗概: [bad]\n"),
        ("已校对: true\n", "已校对: yes\n"),
    ] {
        let unfit = edit_file(&path, from, to);
        let report = f.pass().run().unwrap();
        let notice: Vec<_> = report
            .issues
            .iter()
            .filter(|i| i.problem == Problem::FieldConflict)
            .collect();
        assert_eq!(notice.len(), kept.len() + 1, "{:?}", report.issues);
        for issue in notice {
            assert_eq!(
                issue.doc.as_deref(),
                Some(format!("body:{id}/mod-prose").as_str())
            );
            assert_eq!(issue.path, path.canonicalize().unwrap());
        }
        assert_eq!(report.preserved.len(), 1);
        assert_eq!(fs::read_to_string(&report.preserved[0]).unwrap(), unfit);
        assert_eq!(fs::read_to_string(&path).unwrap(), rewritten);
        kept.extend(report.preserved);
    }
    assert_eq!(f.field(&id, "mod-fields", "summary"), json!("2026"));
    assert_eq!(f.field(&id, "mf-more", "proofread"), json!(true));
    // Editing prose or another field cannot resolve the preserved conflict.
    edit_file(&path, "她数着钟声。", "她又数了一遍钟声。");
    edit_file(&path, "字数目标: 3000\n", "字数目标: 3100\n");
    let pending = f.pass().run().unwrap();
    assert!(
        pending
            .issues
            .iter()
            .any(|i| i.problem == Problem::FieldConflict),
        "{:?}",
        pending.issues
    );
    assert!(pending.preserved.is_empty());
    assert_eq!(f.field(&id, "mf-more", "words"), json!(3100.0));
    assert!(kept.iter().all(|path| path.is_file()));
    for path in kept {
        fs::remove_file(path).unwrap();
    }
    let resolved = f.pass().run().unwrap();
    assert!(resolved.issues.is_empty(), "{:?}", resolved.issues);
    assert!(resolved.preserved.is_empty());
}

#[test]
fn compatible_outside_properties_become_fields_and_remain_editable() {
    let f = Fixture::new(Preset::Tiny);
    let (id, _) = f.chapter("接收属性", "她把钟拨慢了。");
    f.pass().run().unwrap();
    let path = find(f.out.path(), "接收属性.md");
    edit_file(
        &path,
        "\n---\n\n",
        "\n字数目标: \"3000\"\naliases: 老王\ntags: ['outside']\n---\n\n",
    );
    assert!(f.pass().run().unwrap().issues.is_empty());
    f.more_fields();
    let report = f.pass().run().unwrap();
    assert!(
        report.issues.is_empty() && report.preserved.is_empty(),
        "{report:?}"
    );
    assert_eq!(f.field(&id, "mf-more", "words"), json!(3000.0));
    assert_eq!(f.field(&id, "mf-more", "names"), json!(["老王"]));
    let written = fs::read_to_string(&path).unwrap();
    for label in ["字数目标:", "aliases:", "tags:"] {
        assert_eq!(written.matches(label).count(), 1, "{written}");
    }
    assert!(written.contains("字数目标: 3000\n"), "{written}");
    assert!(written.contains("aliases: [\"老王\"]\n"), "{written}");
    assert!(written.contains("tags: ['outside']\n"), "{written}");
    f.set_field(&id, "mf-more", "words", json!(3100));
    assert!(f.pass().run().unwrap().issues.is_empty());
    edit_file(&path, "字数目标: 3100\n", "字数目标: 3200\n");
    assert!(f.pass().run().unwrap().issues.is_empty());
    assert_eq!(f.field(&id, "mf-more", "words"), json!(3200.0));
}

#[test]
fn image_fields_use_project_relative_wikilinks_and_are_read_only() {
    let f = Fixture::new(Preset::Lite);
    let list = f.call("asset.list", json!({"book":f.book}));
    let asset = list
        .as_array()
        .unwrap()
        .iter()
        .find(|asset| asset["kind"] == "image")
        .unwrap()["id"]
        .as_str()
        .unwrap();
    let folder = f.call("asset_folder.create", json!({"book":f.book,"name":"人物"}));
    f.call(
        "asset.move",
        json!({"book":f.book,"id":asset,"folder":folder["id"]}),
    );
    f.call(
        "asset.rename",
        json!({"book":f.book,"id":asset,"name":"黛玉.png"}),
    );
    f.call(
        "entry_template.put_module",
        json!({"book":f.book,"template":"tpl-chapter","module":{
            "id":"mf-picture","kind":"fields","name":"更多","config":{"defs":[
                {"id":"portrait","name":"封面","field_type":"image"}
            ]}
        }}),
    );
    let (id, _) = f.chapter("文件字段", "她看着画像。");
    f.set_field(&id, "mf-picture", "portrait", json!(asset));
    let pass = f.pass();
    assert!(pass.run().unwrap().issues.is_empty());
    let project = pass.folder(&f.book).unwrap().unwrap();
    assert!(project.join("素材库/人物/黛玉.png").is_file());
    let path = find(&project, "文件字段.md");
    assert_ne!(path.parent(), Some(project.as_path()));
    let link = "封面: \"[[素材库/人物/黛玉.png]]\"\n";
    // Force a read of the exported link, then change it to an outside value.
    let original = fs::read_to_string(&path).unwrap();
    assert!(original.contains(link), "{original}");
    fs::write(&path, format!("{original}\n")).unwrap();
    let roundtrip = pass.run().unwrap();
    assert!(
        roundtrip.issues.is_empty() && roundtrip.preserved.is_empty(),
        "{roundtrip:?}"
    );
    assert_eq!(f.field(&id, "mf-picture", "portrait"), json!(asset));
    let external = edit_file(&path, link, "封面: \"[[素材库/另一张.png]]\"\n");
    let report = pass.run().unwrap();
    assert_eq!(report.issues[0].problem, Problem::ReadOnly);
    assert_eq!(report.preserved.len(), 1);
    assert_eq!(fs::read_to_string(&report.preserved[0]).unwrap(), external);
    assert_eq!(fs::read_to_string(&path).unwrap(), original);
    assert_eq!(f.field(&id, "mf-picture", "portrait"), json!(asset));
}

#[test]
fn acknowledging_one_preserved_copy_survives_restart_and_leaves_future_copies_active() {
    let f = Fixture::new(Preset::Tiny);
    let (id, _) = f.chapter("保全提醒", "她把钟拨慢了。");
    f.set_field(&id, "mod-fields", "summary", json!("梗概"));
    let mirror = Mirror::start(f.ws.clone(), f.options.clone()).unwrap();
    assert!(mirror.sync_now().unwrap().issues.is_empty());
    let path = find(f.out.path(), "保全提醒.md");
    let first = edit_file(&path, "梗概: 梗概\n", "梗概: [第一次]\n");
    let report = mirror.sync_now().unwrap();
    assert_eq!(report.issues.len(), 1, "{report:?}");
    let issue = &report.issues[0];
    assert_eq!(issue.problem, Problem::FieldConflict);
    assert!(mirror.can_acknowledge(issue));
    let first_copy = issue.kept.clone().unwrap();
    mirror.acknowledge(issue.clone());
    assert!(mirror.sync_now().unwrap().issues.is_empty());
    assert!(mirror.issues().is_empty());
    assert_eq!(fs::read_to_string(&first_copy).unwrap(), first);
    mirror.stop();

    let mirror = Mirror::start(f.ws.clone(), f.options.clone()).unwrap();
    assert!(mirror.sync_now().unwrap().issues.is_empty());
    let second = edit_file(&path, "梗概: 梗概\n", "梗概: [第二次]\n");
    let report = mirror.sync_now().unwrap();
    assert_eq!(report.issues.len(), 1, "{report:?}");
    assert_eq!(report.issues[0].problem, Problem::FieldConflict);
    let second_copy = report.issues[0].kept.as_ref().unwrap();
    assert_ne!(second_copy, &first_copy);
    assert_eq!(fs::read_to_string(second_copy).unwrap(), second);
    assert_eq!(fs::read_to_string(first_copy).unwrap(), first);
    fs::remove_file(second_copy).unwrap();
    assert!(mirror.sync_now().unwrap().issues.is_empty());
}

#[test]
fn a_kept_property_named_like_a_new_field_holds_the_file_with_its_own_notice() {
    let f = Fixture::new(Preset::Tiny);
    let (_, doc) = f.chapter("撞名", "她把钟拨慢了。");
    f.pass().run().unwrap();
    let path = find(f.out.path(), "撞名.md");
    edit_file(&path, "\n---\n\n", "\n字数目标: 外面记的三千\n---\n\n");
    assert!(f.pass().run().unwrap().issues.is_empty());
    f.more_fields();
    f.call(
        "prose.replace",
        json!({"doc":doc,"find":"拨慢","replace":"拨快"}),
    );
    let held = fs::read_to_string(&path).unwrap();
    for _ in 0..2 {
        let report = f.pass().run().unwrap();
        let problems: Vec<_> = report.issues.iter().map(|i| i.problem).collect();
        assert_eq!(problems, [Problem::KeyCollision], "{:?}", report.issues);
        assert_eq!(fs::read_to_string(&path).unwrap(), held);
        assert!(report.preserved.is_empty());
    }
    assert_eq!(f.texts(&doc), ["她把钟拨快了。"]);
    edit_file(&path, "字数目标: 外面记的三千", "外面的字数: 外面记的三千");
    let report = f.pass().run().unwrap();
    assert!(report.issues.is_empty(), "{:?}", report.issues);
    let now = fs::read_to_string(&path).unwrap();
    assert!(now.contains("她把钟拨快了。") && now.contains("外面的字数: 外面记的三千\n"));
    assert!(now.contains("字数目标:\n"), "{now}");
}

#[test]
fn a_paragraph_with_an_open_conflict_comment_gets_no_second_one_in_any_language() {
    let mut f = Fixture::new(Preset::Tiny);
    f.options.author = "Markdown 文件夹".into();
    f.options.conflict = "这一段同时在 Drifting 和外部文件里改过。".into();
    let (id, doc) = f.chapter("再次冲突", "安娜在镇口等车。\n钟响了。");
    f.pass().run().unwrap();
    let path = find(f.out.path(), "再次冲突.md");
    let comments = |f: &Fixture| {
        f.call(
            "comment.list",
            json!({"book":f.book,"origin":"manual","target":{"kind":"entry","id":id}}),
        )
        .as_array()
        .unwrap()
        .clone()
    };
    let clash = |f: &Fixture, app: (&str, &str), file: (&str, &str)| {
        f.call(
            "prose.replace",
            json!({"doc":doc,"find":app.0,"replace":app.1}),
        );
        edit_file(&path, file.0, file.1);
        f.pass().run().unwrap();
    };
    clash(&f, ("口等", "口很久等"), ("口等", "口一直等"));
    let first = comments(&f);
    assert_eq!(first.len(), 1);
    assert_eq!(
        first[0]["body"]["text"],
        "这一段同时在 Drifting 和外部文件里改过。"
    );
    assert_eq!(first[0]["author_name"], "Markdown 文件夹");
    assert_eq!(first[0]["status"], "open");

    // The interface language changed; the paragraph clashes again while the
    // first comment is still open.
    f.options.author = "Markdown folder".into();
    f.options.conflict = "This paragraph was changed both in Drifting and in the file.".into();
    clash(&f, ("车", "末班车"), ("车", "头班车"));
    let body = f.texts(&doc);
    assert!(
        body[0].contains("末班") && body[0].contains("头班"),
        "{body:?}"
    );
    assert_eq!(comments(&f), first);

    // Once resolved, a new clash gets a new comment.
    f.call(
        "comment.update",
        json!({"book":f.book,"id":first[0]["id"],"status":"resolved"}),
    );
    clash(&f, ("安娜", "安娜蒂"), ("安娜", "安娜卡"));
    let now = comments(&f);
    assert_eq!(now.len(), 2);
    let open: Vec<_> = now.iter().filter(|c| c["status"] == "open").collect();
    assert_eq!(open.len(), 1);
    assert_eq!(open[0]["author_name"], "Markdown folder");
    assert_eq!(
        open[0]["body"]["text"],
        "This paragraph was changed both in Drifting and in the file."
    );
}

#[cfg(unix)]
#[test]
fn a_directory_symlink_out_of_the_folder_is_neither_read_nor_written() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new(Preset::Tiny);
    let (_, doc) = f.chapter("目录链接", "她看向海。");
    f.pass().run().unwrap();
    let path = find(f.out.path(), "目录链接.md");
    let dir = path.parent().unwrap().to_path_buf();
    let outside = f.db.path().join("outside-dir");
    fs::create_dir(&outside).unwrap();
    let mut listing = Vec::new();
    for entry in fs::read_dir(&dir).unwrap() {
        let entry = entry.unwrap();
        if entry.file_type().unwrap().is_file() {
            fs::copy(entry.path(), outside.join(entry.file_name())).unwrap();
            listing.push(entry.file_name());
        }
    }
    let target = outside.join("目录链接.md");
    let text = fs::read_to_string(&target).unwrap().replace("海。", "山。");
    fs::write(&target, &text).unwrap();
    fs::remove_dir_all(&dir).unwrap();
    symlink(&outside, &dir).unwrap();
    let contents = |dir: &Path| {
        let mut all: Vec<_> = fs::read_dir(dir)
            .unwrap()
            .map(|e| {
                let e = e.unwrap();
                (e.file_name(), fs::read(e.path()).unwrap())
            })
            .collect();
        all.sort();
        all
    };
    let before = contents(&outside);
    f.call(
        "prose.replace",
        json!({"doc":doc,"find":"看向","replace":"望向"}),
    );
    let report = f.pass().run().unwrap();
    assert!(
        report
            .issues
            .iter()
            .any(|i| i.problem == Problem::UnsafePath),
        "{:?}",
        report.issues
    );
    assert_eq!(f.texts(&doc), ["她望向海。"]);
    assert_eq!(contents(&outside), before);
    assert!(fs::symlink_metadata(&dir).unwrap().file_type().is_symlink());
    assert!(!listing.is_empty());
}
