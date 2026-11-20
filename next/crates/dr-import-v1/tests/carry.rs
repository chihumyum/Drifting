//! What the 0.1 library kept for this device, read back after the import
//! (`m10-import.md` 「0.1 的设置、快捷键和工作记忆（2026-11-21）」): the
//! captured settings, and each book's working memory carried into the
//! book's working memory here, never over one.

mod common;

use common::{device_state, *};
use dr_agent::memory::{self, UpdatedBy};
use dr_import_v1::carry;
use dr_import_v1::gate::Accept;
use dr_import_v1::receipt;
use dr_import_v1::run::{self, Options, Outcome};
use dr_model::id::BookId;
use dr_store::{Library, LibraryOptions};

/// The synthetic 0.1 library with its device state, imported into a fresh
/// library that stays open (the app's path, `import_into_library`).
fn imported(memory: Option<&str>) -> (tempfile::TempDir, Old, Library) {
    let old = build_v3(true);
    device_state::add(
        &old,
        &device_state::settings(),
        &device_state::shortcuts(),
        false,
        memory,
    );
    let dir = tempfile::tempdir().unwrap();
    let mut o = LibraryOptions::new("0.2.0-test");
    o.rebuild_indexes_on_open = false;
    let lib = Library::open(dir.path().join("library"), o).unwrap();
    let mut opts = Options::new("0.2.0-test");
    opts.accept = Accept::NOTHING;
    opts.v3 = v3_choices();
    opts.old_root = Some(old.root.clone());
    let (outcome, _) = run::import_into_library(&old.db, &lib, &opts, &mut |_| {}).unwrap();
    assert!(matches!(outcome, Outcome::Imported(_)));
    (dir, old, lib)
}

fn book() -> BookId {
    BookId::parse(BOOK).unwrap()
}

#[test]
fn the_captured_settings_are_read_back_from_the_archive() {
    let (_dir, _old, lib) = imported(None);
    let root = lib.paths().root.clone();
    let captured = carry::captured_settings(&root).unwrap();
    let settings: serde_json::Value = serde_json::from_str(&captured["settings-storage"]).unwrap();
    assert_eq!(settings["state"], device_state::settings());
    assert_eq!(settings["version"], 37);
    assert!(captured.contains_key("shortcuts-storage"));
    assert!(captured.contains_key("project-checkin"));
    // Nothing to carry: no row, and the summary is the import's.
    assert!(carry::carry_working_memory(&lib, &root).unwrap().is_empty());
    assert!(carry::rows(&root).unwrap().is_empty());
    let summary =
        std::fs::read_to_string(receipt::directory(&root).join(receipt::SUMMARY)).unwrap();
    assert!(!summary.contains("工作记忆："));
    lib.close().unwrap();
    // A library without an archive has nothing captured.
    let empty = tempfile::tempdir().unwrap();
    assert!(carry::captured_settings(empty.path()).unwrap().is_empty());
    assert!(carry::working_memories(empty.path()).unwrap().is_empty());
}

#[test]
fn a_books_working_memory_comes_over_once() {
    let (_dir, _old, lib) = imported(Some(device_state::WORKING_MEMORY));
    let root = lib.paths().root.clone();
    assert!(!memory::load(&lib, &book()).unwrap().exists);
    let rows = carry::carry_working_memory(&lib, &root).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].outcome, "adopted");
    assert_eq!(rows[0].label.as_deref(), Some("阿Q正传"));
    let here = memory::load(&lib, &book()).unwrap();
    assert_eq!(here.content_md, device_state::WORKING_MEMORY);
    assert_eq!(here.updated_by, Some(UpdatedBy::Author));
    let summary =
        std::fs::read_to_string(receipt::directory(&root).join(receipt::SUMMARY)).unwrap();
    assert!(summary.contains("- 带过来的工作记忆：《阿Q正传》"));
    assert_eq!(summary.matches("## 设置、快捷键和工作记忆").count(), 1);

    // Edited here afterwards; carrying again changes nothing and the record
    // still says it came over.
    memory::replace(
        &lib,
        &book(),
        here.revision,
        "# 新版里改过\n",
        UpdatedBy::Author,
    )
    .unwrap();
    assert!(carry::carry_working_memory(&lib, &root).unwrap().is_empty());
    assert_eq!(
        memory::load(&lib, &book()).unwrap().content_md,
        "# 新版里改过\n"
    );
    let recorded = carry::rows(&root).unwrap();
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0].outcome, "adopted");
    lib.close().unwrap();
}

#[test]
fn a_working_memory_here_is_never_overwritten() {
    let (_dir, _old, lib) = imported(Some(device_state::WORKING_MEMORY));
    let root = lib.paths().root.clone();
    memory::replace(&lib, &book(), 0, "# 已经有的\n", UpdatedBy::Agent).unwrap();
    let rows = carry::carry_working_memory(&lib, &root).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].outcome, "kept-here");
    let here = memory::load(&lib, &book()).unwrap();
    assert_eq!(here.content_md, "# 已经有的\n");
    assert_eq!(here.updated_by, Some(UpdatedBy::Agent));
    let summary =
        std::fs::read_to_string(receipt::directory(&root).join(receipt::SUMMARY)).unwrap();
    assert!(summary.contains("- 新版里已经有、没有覆盖的工作记忆：《阿Q正传》"));
    lib.close().unwrap();
}

#[test]
fn deleted_blank_and_unimported_working_memories_are_told_apart() {
    let (_dir, _old, lib) = imported(Some(device_state::WORKING_MEMORY));
    let root = lib.paths().root.clone();
    // Rows the archive could hold: a deleted one and a blank one (0.1 shows
    // neither) and one of a book this library does not have.
    let archive =
        rusqlite::Connection::open(receipt::directory(&root).join(receipt::DATABASE)).unwrap();
    for (book, content, deleted) in [
        (
            "01900000-0000-7000-8000-0000000000a9",
            "# 删掉的\n",
            Some(T2),
        ),
        ("01900000-0000-7000-8000-0000000000aa", "  \n", None),
        (
            "01900000-0000-7000-8000-0000000000ab",
            "# 别的库的书\n",
            None,
        ),
    ] {
        archive
            .execute(
                "INSERT INTO local_agent_working_memory (project_id, content_md, revision, approx_tokens, updated_by, last_compacted_at, deleted_at, created_at, updated_at) VALUES (?1, ?2, 1, 1, 'agent', NULL, ?3, ?4, ?4)",
                rusqlite::params![book, content, deleted, T1],
            )
            .unwrap();
    }
    drop(archive);
    let listed: Vec<String> = carry::working_memories(&root)
        .unwrap()
        .into_iter()
        .map(|m| m.book)
        .collect();
    assert_eq!(listed, [BOOK, "01900000-0000-7000-8000-0000000000ab"]);
    let rows = carry::carry_working_memory(&lib, &root).unwrap();
    let outcome = |book: &str| {
        rows.iter()
            .find(|r| r.old_key == book)
            .map(|r| (r.outcome.as_str(), r.detail.is_some()))
    };
    assert_eq!(outcome(BOOK), Some(("adopted", false)));
    assert_eq!(
        outcome("01900000-0000-7000-8000-0000000000ab"),
        Some(("not-carried", true))
    );
    let summary =
        std::fs::read_to_string(receipt::directory(&root).join(receipt::SUMMARY)).unwrap();
    assert!(summary.contains("- 没能带过来的工作记忆："));
    lib.close().unwrap();
}
