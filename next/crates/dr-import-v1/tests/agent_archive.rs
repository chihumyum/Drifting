//! M31 「0.1 的旧对话」: the archived 0.1 Agent conversations read back
//! (`agent_archive`) from an archive the importer wrote for the synthetic 0.1
//! library with conversations (`common::conversations`).

mod common;

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use common::conversations::{self as c, OTHER_BOOK};
use common::{BOOK, sha256_bytes, v3_choices};
use dr_import_v1::agent_archive::{self, Archive, Conversation, Error, Speaker, Turn};
use dr_import_v1::run::{self, Options, Outcome};

struct Imported {
    _dir: tempfile::TempDir,
    root: PathBuf,
    _old: common::Old,
}

fn imported() -> Imported {
    let old = c::build_v3(true);
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let mut o = Options::new("0.2.0-test");
    o.v3 = v3_choices();
    o.old_root = Some(old.root.clone());
    o.device_dir = Some(dir.path().join("device"));
    match run::import(&old.db, &root, &o).unwrap().0 {
        Outcome::Imported(_) => {}
        Outcome::Blocked(g) => panic!("blocked: {:?}", g.reasons),
        Outcome::Cancelled => panic!("cancelled"),
    }
    Imported {
        _dir: dir,
        root,
        _old: old,
    }
}

fn ids(list: &[Conversation]) -> Vec<&str> {
    list.iter().map(|c| c.id.as_str()).collect()
}

fn found_ids(archive: &Archive, book: &str, query: &str) -> Vec<String> {
    archive
        .search(book, query, &AtomicBool::new(false))
        .unwrap()
        .into_iter()
        .map(|f| f.conversation.id)
        .collect()
}

fn fingerprint(path: &Path) -> (String, std::time::SystemTime) {
    (
        sha256_bytes(&std::fs::read(path).unwrap()),
        std::fs::metadata(path).unwrap().modified().unwrap(),
    )
}

/// A library folder whose archive is a copy of `from`'s.
fn copy_library(from: &Path, into: &Path) -> PathBuf {
    let archive = agent_archive::path(into);
    std::fs::create_dir_all(archive.parent().unwrap()).unwrap();
    std::fs::copy(agent_archive::path(from), &archive).unwrap();
    archive
}

#[test]
fn the_archive_lists_reads_and_searches_a_books_0_1_conversations_as_0_1_showed_them() {
    let new = imported();
    let file = agent_archive::path(&new.root);
    let before = fingerprint(&file);
    let archive = Archive::open(&new.root).unwrap().expect("an archive");

    // Listed: this book's chats, newest first. Not the one deleted in 0.1,
    // not the external MCP session, not the branch the conversation
    // continued here replaced, nor the other book's.
    let list = archive.conversations(BOOK).unwrap();
    assert_eq!(ids(&list), c::LISTED);
    assert_eq!(list[0].title, c::TITLED_TITLE);
    assert_eq!(list[1].title, "", "untitled in 0.1");
    assert_eq!(list[5].title, c::FORK_TITLE);
    assert_eq!(
        list[0].updated_ms,
        Some(1_791_795_600_000),
        "2026-10-12T09:00:00Z"
    );
    assert_eq!(ids(&archive.conversations(OTHER_BOOK).unwrap()), [c::OTHER]);
    assert!(archive.conversations("no-such-book").unwrap().is_empty());

    // The turns: the author's, the Agent's, reasoning, each tool call by its
    // 0.1 name, an error; no usage, no plan.
    let turns = |id: &str| {
        let conversation = list.iter().find(|c| c.id == id).unwrap();
        archive.turns(BOOK, conversation).unwrap().unwrap()
    };
    assert_eq!(
        turns(c::TOOLS),
        vec![
            Turn::User("第一章节奏太慢，帮我看看哪里可以删。".into()),
            Turn::Thinking("先读第一章，再看序和正文的比例。".into()),
            Turn::Tool("read_chapter".into()),
            Turn::Tool("create_material_note".into()),
            Turn::Agent("开头的序可以短一半：「我要给阿Q做正传」之后直接写赵太爷。".into()),
            Turn::Error("模型连接中断。".into()),
        ]
    );
    // The branch 0.1 showed: the remote turns, then this device's.
    let fork = turns(c::FORK);
    assert_eq!(fork.len(), 4);
    assert_eq!(fork[2], Turn::User("那秀才呢？".into()));
    // Only in the runtime journal: mapped as 0.1's sync shows it.
    assert_eq!(
        turns(c::RUNTIME),
        vec![
            Turn::User("阿Q该叫阿桂还是阿贵？".into()),
            Turn::Thinking("查一下别名。".into()),
            Turn::Tool("search_prose".into()),
            Turn::Agent("按序里的说法，写阿贵。".into()),
        ]
    );

    // Search: titles and what the author and the Agent wrote, this book
    // only, letter case ignored, in the listing's order.
    let found = archive
        .search(BOOK, "精神胜利法", &AtomicBool::new(false))
        .unwrap();
    assert_eq!(
        found.len(),
        1,
        "not the deleted one, the MCP one, the other book's"
    );
    let m = &found[0].matches;
    assert_eq!(found[0].conversation.id, c::TITLED);
    assert_eq!(m.title, vec![0..15]);
    assert_eq!(m.occurrences, 2);
    let first = m.first.as_ref().unwrap();
    assert_eq!((first.turn, first.speaker), (0, Speaker::User));
    assert_eq!(&first.text[first.at.clone()], "精神胜利法");
    assert_eq!(found_ids(&archive, BOOK, "todo"), [c::UNTITLED]);
    assert_eq!(found_ids(&archive, BOOK, "赵太爷"), [c::TOOLS, c::FORK]);
    let agent = archive
        .search(BOOK, "写阿贵", &AtomicBool::new(false))
        .unwrap();
    assert_eq!(agent[0].conversation.id, c::RUNTIME);
    assert_eq!(
        agent[0].matches.first.as_ref().unwrap().speaker,
        Speaker::Agent
    );
    assert_eq!(turns(c::LONG).len(), c::LONG_TURNS);
    let long = archive
        .search(BOOK, "王胡", &AtomicBool::new(false))
        .unwrap();
    assert_eq!(long[0].conversation.id, c::LONG);
    assert_eq!(
        long[0].matches.first.as_ref().unwrap().turn,
        c::LONG_TURNS - 1
    );
    assert!(
        found_ids(&archive, BOOK, "read_chapter").is_empty(),
        "tool names are not what anyone wrote"
    );
    assert!(found_ids(&archive, BOOK, "   ").is_empty());
    assert_eq!(found_ids(&archive, OTHER_BOOK, "精神胜利法"), [c::OTHER]);
    assert!(matches!(
        archive.search(BOOK, "赵太爷", &AtomicBool::new(true)),
        Err(Error::Cancelled)
    ));
    drop(archive);
    assert_eq!(
        fingerprint(&file),
        before,
        "reading never writes the archive"
    );

    // An archive written before the branches were archived lists both.
    let older = tempfile::tempdir().unwrap();
    let copy = copy_library(&new.root, older.path());
    rusqlite::Connection::open(&copy)
        .unwrap()
        .execute_batch("DROP TABLE archive_agent_chat_branch")
        .unwrap();
    let both = Archive::open(older.path()).unwrap().unwrap();
    let listed = both.conversations(BOOK).unwrap();
    assert!(ids(&listed).contains(&c::ROOT) && ids(&listed).contains(&c::FORK));

    // A truncated archive and one that is not a database are damaged.
    let cut = tempfile::tempdir().unwrap();
    let copy = copy_library(&new.root, cut.path());
    let len = std::fs::metadata(&copy).unwrap().len();
    std::fs::OpenOptions::new()
        .write(true)
        .open(&copy)
        .unwrap()
        .set_len(len / 2)
        .unwrap();
    assert!(matches!(Archive::open(cut.path()), Err(Error::Damaged(_))));
    std::fs::write(
        &copy,
        "这不是一个数据库，只是一段足够长的文字，用来顶替回执文件。".repeat(8),
    )
    .unwrap();
    assert!(matches!(Archive::open(cut.path()), Err(Error::Damaged(_))));
}

#[test]
fn a_library_without_an_archive_has_no_old_conversations() {
    let dir = tempfile::tempdir().unwrap();
    assert!(Archive::open(dir.path()).unwrap().is_none());
    // An archive file without the Agent tables (a library the import wrote
    // before conversations were archived) has none either.
    let path = agent_archive::path(dir.path());
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch("CREATE TABLE local_setting (key TEXT, value TEXT)")
        .unwrap();
    assert!(Archive::open(dir.path()).unwrap().is_none());
}
