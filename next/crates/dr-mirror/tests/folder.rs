//! The Markdown folder over a real library: chapters and ideas are written
//! where they belong; a file edited elsewhere is merged back (text, status,
//! summary), alongside edits made in Drifting; an edit not read yet is
//! never written over; files that cannot be merged are reported, kept and
//! replaced (a broken frontmatter waits); renamed and trashed chapters
//! leave no stale file; a folder another installation keeps is left alone;
//! reading the same file twice changes the prose once; names are linked.

use std::path::{Path, PathBuf};
use std::time::Duration;

use dr_mirror::sync::{Pass, Problem, Report};
use dr_store::Library;
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use serde_json::{Value, json};

struct Env {
    dir: tempfile::TempDir,
    ws: Workspace,
}

impl Drop for Env {
    fn drop(&mut self) {
        self.ws.close();
    }
}

fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(dir.path().join("library"), library_options("test")).unwrap();
    let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
    Env { dir, ws }
}

impl Env {
    fn out(&self, name: &str, input: Value) -> Value {
        self.ws
            .call(&Actor::User, name, input)
            .unwrap_or_else(|e| panic!("{name}: {e}"))["output"]
            .clone()
    }

    fn root(&self) -> PathBuf {
        self.dir.path().join("Markdown")
    }

    fn pass(&self, installation: &str) -> Report {
        Pass {
            ws: &self.ws,
            root: &self.root(),
            installation,
            app: "cc.drifting.next.dev",
            settle: Duration::ZERO,
            thorough: false,
        }
        .run()
        .unwrap()
    }

    fn sync(&self) -> Report {
        self.pass("this-device")
    }

    fn texts(&self, node: &str) -> Vec<String> {
        self.out("prose.read", json!({"doc": format!("node:{node}")}))["paragraphs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["text"].as_str().unwrap().to_owned())
            .collect()
    }
}

fn id(v: &Value) -> String {
    v["id"].as_str().unwrap().to_owned()
}

fn files(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    fn walk(dir: &Path, base: &Path, out: &mut Vec<String>) {
        for e in std::fs::read_dir(dir).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                walk(&p, base, out);
            } else {
                out.push(
                    p.strip_prefix(base)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/"),
                );
            }
        }
    }
    if root.exists() {
        walk(root, root, &mut out);
    }
    out.sort();
    out
}

/// 慢钟: an act with two chapters, a chapter after it, an idea in a group.
struct Book {
    id: String,
    one: String,
    two: String,
    three: String,
}

fn book(e: &Env) -> Book {
    let b = id(&e.out("book.create", json!({"name": "慢钟"})));
    let one = id(&e.out(
        "chapter.create",
        json!({"book": b, "title": "钟楼", "text": "钟楼在镇口。\n她没回头。"}),
    ));
    let two = id(&e.out(
        "chapter.create",
        json!({"book": b, "title": "雨夜", "text": "雨下了一夜。"}),
    ));
    let three = id(&e.out(
        "chapter.create",
        json!({"book": b, "title": "尾声", "text": "钟又走了。"}),
    ));
    e.out(
        "act.create",
        json!({"book": b, "name": "上部", "start_chapter": one}),
    );
    e.out(
        "act.create",
        json!({"book": b, "name": "下部", "start_chapter": three}),
    );
    let g = id(&e.out("idea_group.create", json!({"book": b, "name": "伏笔"})));
    e.out(
        "idea.create",
        json!({"book": b, "title": "修理单", "text": "第三张单子上写着日期。", "group": g}),
    );
    e.out("element.create", json!({"book": b, "name": "安娜"}));
    Book {
        id: b,
        one,
        two,
        three,
    }
}

fn chapter_path(e: &Env, rel: &str) -> PathBuf {
    e.root().join("慢钟").join(rel)
}

#[test]
fn chapters_and_ideas_are_written_where_they_belong() {
    let e = env();
    let b = book(&e);
    let r = e.sync();
    assert!(r.issues.is_empty(), "{:?}", r.issues);
    assert_eq!(r.written, 4);
    assert_eq!(
        files(&e.root().join("慢钟")),
        [
            ".drifting/owner.json",
            "构想/伏笔/修理单.md",
            "正文/01 上部/001 钟楼.md",
            "正文/01 上部/002 雨夜.md",
            "正文/02 下部/003 尾声.md",
        ]
    );
    let one = std::fs::read_to_string(chapter_path(&e, "正文/01 上部/001 钟楼.md")).unwrap();
    assert_eq!(
        one,
        format!(
            "---\ndrifting-id: {}\n写作状态: 草稿\n摘要: \"\"\naliases: [\"钟楼\"]\n---\n\n钟楼在镇口。\n\n她没回头。\n",
            b.one
        )
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(chapter_path(&e, "正文/01 上部/001 钟楼.md"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    // Nothing changed: nothing written.
    assert_eq!(e.sync().written, 0);
    let _ = (b.two, b.three);
}

#[test]
fn an_edited_file_is_merged_with_what_drifting_wrote_meanwhile() {
    let e = env();
    let b = book(&e);
    e.sync();
    let path = chapter_path(&e, "正文/01 上部/001 钟楼.md");
    let text = std::fs::read_to_string(&path).unwrap();
    // Elsewhere: a word in the first paragraph, a new paragraph naming
    // 安娜, the status and the summary.
    let edited = text
        .replace("写作状态: 草稿", "写作状态: 已完成")
        .replace("摘要: \"\"", "摘要: 钟停了")
        .replace("钟楼在镇口。", "钟楼在镇口的石桥边。")
        .replace("她没回头。", "她没回头。\n\n安娜在桥上等。");
    std::fs::write(&path, &edited).unwrap();
    // Drifting meanwhile: the start of the same paragraph.
    e.out(
        "prose.replace",
        json!({"doc": format!("node:{}", b.one), "find": "钟楼在", "replace": "那天，钟楼在"}),
    );
    let r = e.sync();
    assert_eq!(r.merged, [format!("node:{}", b.one)]);
    assert_eq!(
        e.texts(&b.one),
        ["那天，钟楼在镇口的石桥边。", "她没回头。", "安娜在桥上等。"]
    );
    let chapter = &e.out("chapter.list", json!({"book": b.id}))[0];
    assert_eq!(chapter["status"], "finished");
    assert_eq!(chapter["summary"], "钟停了");
    // 安娜 is linked again.
    let doc =
        e.ws.prose_session(&format!("node:{}", b.one))
            .unwrap()
            .reader();
    let linked: Vec<String> = doc
        .view()
        .entity_links()
        .into_iter()
        .map(|(r, _)| doc.view().text_in(r).unwrap())
        .collect();
    assert_eq!(linked, ["安娜"]);
    // Written back with both edits; read again, nothing changes.
    let now = std::fs::read_to_string(&path).unwrap();
    assert!(now.contains("那天，钟楼在镇口的石桥边。"), "{now}");
    assert!(now.contains("写作状态: 已完成"));
    let again = e.sync();
    assert!(again.merged.is_empty() && again.written == 0, "{again:?}");
}

#[test]
fn an_edit_not_read_yet_is_never_written_over() {
    let e = env();
    let b = book(&e);
    e.sync();
    let path = chapter_path(&e, "正文/01 上部/002 雨夜.md");
    let edited = std::fs::read_to_string(&path)
        .unwrap()
        .replace("雨下了一夜。", "雨下了一整夜。");
    std::fs::write(&path, &edited).unwrap();
    e.out(
        "prose.replace",
        json!({"doc": format!("node:{}", b.two), "find": "雨", "replace": "大雨"}),
    );
    // Saved just now: left for the next pass, and not replaced.
    let r = Pass {
        ws: &e.ws,
        root: &e.root(),
        installation: "this-device",
        app: "app",
        settle: Duration::from_secs(3600),
        thorough: false,
    }
    .run()
    .unwrap();
    assert!(r.waiting);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), edited);
    // Later it is merged, and both edits are there.
    e.sync();
    assert_eq!(e.texts(&b.two), ["大雨下了一整夜。"]);
}

#[test]
fn files_that_cannot_be_merged_are_reported_and_kept() {
    let e = env();
    let b = book(&e);
    e.sync();
    let two = chapter_path(&e, "正文/01 上部/002 雨夜.md");
    let three = chapter_path(&e, "正文/02 下部/003 尾声.md");
    // Another chapter's id: reported, kept under .drifting/preserved,
    // written again.
    let wrong = std::fs::read_to_string(&two)
        .unwrap()
        .replace(&b.two, &b.one)
        .replace("雨下了一夜。", "被改错的。");
    std::fs::write(&two, &wrong).unwrap();
    // A broken frontmatter: reported, not replaced until fixed.
    let broken = std::fs::read_to_string(&three)
        .unwrap()
        .replace("摘要: \"\"", "摘要: [坏");
    std::fs::write(&three, &broken).unwrap();
    let r = e.sync();
    let mut problems: Vec<(String, Problem)> = r
        .issues
        .iter()
        .map(|i| (i.title.clone(), i.problem))
        .collect();
    problems.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(
        problems,
        [
            ("尾声".to_owned(), Problem::Frontmatter),
            ("雨夜".to_owned(), Problem::WrongId)
        ]
    );
    assert_eq!(r.preserved.len(), 1);
    assert_eq!(std::fs::read_to_string(&r.preserved[0]).unwrap(), wrong);
    assert!(
        std::fs::read_to_string(&two)
            .unwrap()
            .contains("雨下了一夜。")
    );
    assert_eq!(e.texts(&b.two), ["雨下了一夜。"], "nothing merged");
    // The broken one waits, even when Drifting changes the chapter.
    e.out(
        "prose.replace",
        json!({"doc": format!("node:{}", b.three), "find": "钟", "replace": "老钟"}),
    );
    let r = e.sync();
    assert_eq!(r.issues.len(), 1);
    assert_eq!(std::fs::read_to_string(&three).unwrap(), broken);
    // Fixed by the author: merged.
    std::fs::write(
        &three,
        broken
            .replace("摘要: [坏", "摘要: 好了")
            .replace("老钟", "钟"),
    )
    .unwrap();
    let r = e.sync();
    assert!(r.issues.is_empty(), "{:?}", r.issues);
    let chapters = e.out("chapter.list", json!({"book": b.id}));
    assert_eq!(chapters[2]["summary"], "好了");
}

#[test]
fn renamed_and_trashed_chapters_leave_no_stale_file() {
    let e = env();
    let b = book(&e);
    e.sync();
    let old = chapter_path(&e, "正文/01 上部/002 雨夜.md");
    // Edited elsewhere before the rename: merged first, then moved.
    let edited = std::fs::read_to_string(&old)
        .unwrap()
        .replace("雨下了一夜。", "雨下个不停。");
    std::fs::write(&old, edited).unwrap();
    e.out(
        "chapter.update",
        json!({"book": b.id, "id": b.two, "title": "暴雨"}),
    );
    e.out("chapter.trash", json!({"book": b.id, "id": b.three}));
    let r = e.sync();
    assert!(r.issues.is_empty(), "{:?}", r.issues);
    assert_eq!(e.texts(&b.two), ["雨下个不停。"]);
    assert_eq!(
        files(&e.root().join("慢钟")),
        [
            ".drifting/owner.json",
            "构想/伏笔/修理单.md",
            "正文/01 上部/001 钟楼.md",
            "正文/01 上部/002 暴雨.md",
        ]
    );
    assert!(r.preserved.is_empty());
    // The book renamed: its folder follows.
    e.out("book.update", json!({"book": b.id, "name": "慢钟（修订）"}));
    e.sync();
    // NFKC, as 0.1 named folders: 慢钟(修订).
    let folder = dr_mirror::layout::stem("慢钟（修订）");
    assert_eq!(folder, "慢钟(修订)");
    assert!(
        e.root()
            .join(folder)
            .join("正文/01 上部/001 钟楼.md")
            .exists()
    );
    assert!(!e.root().join("慢钟").exists());
}

#[test]
fn a_folder_kept_by_another_installation_is_left_alone() {
    let e = env();
    book(&e);
    // Another installation's 慢钟 is there already: this one writes beside
    // it and leaves it as it is.
    let theirs = e.root().join("慢钟");
    std::fs::create_dir_all(theirs.join(".drifting")).unwrap();
    std::fs::write(
        theirs.join(".drifting/owner.json"),
        r#"{"installationId": "another-device"}"#,
    )
    .unwrap();
    std::fs::write(theirs.join("笔记.md"), "别人的。").unwrap();
    let r = e.sync();
    assert!(r.issues.is_empty(), "{:?}", r.issues);
    assert!(e.root().join("慢钟 2/正文/01 上部/001 钟楼.md").exists());
    assert_eq!(files(&theirs), [".drifting/owner.json", "笔记.md"]);
    // Taken over by another installation later: reported, nothing written.
    std::fs::write(
        e.root().join("慢钟 2/.drifting/owner.json"),
        r#"{"installationId": "another-device"}"#,
    )
    .unwrap();
    let r = e.sync();
    assert_eq!(r.issues.len(), 1);
    assert_eq!(r.issues[0].problem, Problem::OwnedElsewhere);
    assert_eq!(r.written, 0);
}

#[test]
fn reading_the_same_file_twice_changes_the_prose_once() {
    let e = env();
    let b = book(&e);
    e.sync();
    let lib = e.ws.library();
    let doc = format!("node:{}", b.two);
    let before: Vec<(String, dr_mirror::ledger::FileRow)> = dr_mirror::ledger::files(lib, &b.id)
        .unwrap()
        .into_iter()
        .filter(|(d, _)| *d == doc)
        .collect();
    let path = chapter_path(&e, "正文/01 上部/002 雨夜.md");
    let edited = std::fs::read_to_string(&path)
        .unwrap()
        .replace("雨下了一夜。", "雨下了一夜。\n\n天亮了。");
    std::fs::write(&path, &edited).unwrap();
    e.sync();
    assert_eq!(e.texts(&b.two), ["雨下了一夜。", "天亮了。"]);
    // A crash before the ledger was written: the old row, the same file.
    dr_mirror::ledger::put_file(lib, &doc, &before[0].1).unwrap();
    std::fs::write(&path, &edited).unwrap();
    let r = e.sync();
    assert_eq!(r.merged, [doc]);
    assert_eq!(e.texts(&b.two), ["雨下了一夜。", "天亮了。"]);
}

#[test]
fn a_file_too_large_is_kept_and_written_again() {
    let e = env();
    let b = book(&e);
    e.sync();
    let path = chapter_path(&e, "正文/01 上部/002 雨夜.md");
    let big = "雨".repeat(6 * 1024 * 1024);
    std::fs::write(&path, &big).unwrap();
    let r = e.sync();
    assert_eq!(r.issues.len(), 1);
    assert_eq!(r.issues[0].problem, Problem::TooLarge);
    assert_eq!(
        std::fs::read_to_string(&r.preserved[0]).unwrap().len(),
        big.len()
    );
    assert!(
        std::fs::read_to_string(&path)
            .unwrap()
            .contains("雨下了一夜。")
    );
    assert_eq!(e.texts(&b.two), ["雨下了一夜。"]);
}

#[test]
fn every_problem_has_words() {
    let zh = dr_i18n::I18n::new(dr_i18n::Locale::ZhCn, dr_i18n::Platform::Mac);
    for p in [
        Problem::Frontmatter,
        Problem::WrongId,
        Problem::Emptied,
        Problem::UnknownBase,
        Problem::NotUtf8,
        Problem::TooLarge,
        Problem::OwnedElsewhere,
    ] {
        assert!(!zh.t(p.message()).is_empty(), "{p:?}");
    }
    assert_eq!(
        zh.t(Problem::WrongId.message()),
        "drifting-id 指向别的章节，未合并，原文件已另存"
    );
}

/// dr-testkit's seeded books (tables, links, headings, quotes, every
/// kind of text) written out and read back unchanged: reading every file
/// again changes nothing.
#[test]
fn seeded_books_read_back_unchanged() {
    let mut books = dr_testkit::seed::generate(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap()
    .books;
    books.push(dr_testkit::samples::slow_clock().unwrap());
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let lib = Library::open(&root, library_options("test")).unwrap();
    for b in &books {
        dr_testkit::seed::write_book(&lib, b).unwrap();
    }
    lib.close().unwrap();
    let ws = Workspace::open_dir(&root, "test").unwrap();
    let e = Env { dir, ws };
    let first = e.sync();
    assert!(first.issues.is_empty(), "{:?}", first.issues);
    assert!(first.written > 0);
    let digests: Vec<_> = books
        .iter()
        .map(|b| dr_testkit::seed::digest(e.ws.library(), b.book_id().as_str()).unwrap())
        .collect();
    // Forget what was written: every file is read back as if edited.
    let mut n = 0;
    for b in &books {
        for (doc, mut row) in
            dr_mirror::ledger::files(e.ws.library(), b.book_id().as_str()).unwrap()
        {
            row.sha = "read me again".into();
            row.stat = None;
            dr_mirror::ledger::put_file(e.ws.library(), &doc, &row).unwrap();
            n += 1;
        }
    }
    let again = e.sync();
    assert_eq!(again.merged.len(), n);
    assert!(again.issues.is_empty(), "{:?}", again.issues);
    assert_eq!(again.written, 0);
    for (b, want) in books.iter().zip(&digests) {
        assert_eq!(
            &dr_testkit::seed::digest(e.ws.library(), b.book_id().as_str()).unwrap(),
            want
        );
    }
}
