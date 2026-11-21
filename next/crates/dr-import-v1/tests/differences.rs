//! What differs from 0.1, as the done dialog lists it (`receipt::differences`,
//! decisions 六 甲 / 七 甲 in `m10-import.md` 「导入界面」) and as summary.md
//! says it: per book, the same lines with the same counts, read back from
//! summary.md itself. Synthetic libraries only.

mod common;

use std::collections::BTreeMap;

use common::*;
use dr_i18n::{I18n, Locale, Platform};
use dr_import_v1::gate::{Accept, Gate};
use dr_import_v1::receipt::{
    self, Block, BookRecord, Difference, MaterialDropped, Receipt, TaskStatusChange,
    UnlinkedAssetLink,
};
use dr_import_v1::run::{self, Options, Outcome};

fn block_name(b: Block) -> &'static str {
    match b {
        Block::Assets => "assets",
        Block::Defaults => "defaults",
        Block::Lossy => "lossy",
        Block::Materials => "materials",
    }
}

/// Every book of `r` says in summary.md exactly what `differences` gives it:
/// the same lines in the same order, the same words (a material line names
/// its material) and the same counts.
fn summary_matches(summary: &str, r: &Receipt) {
    let zh = I18n::new(Locale::ZhCn, Platform::Mac);
    let parsed = parse_summary(summary);
    for b in &r.books {
        let have = parsed
            .get(&b.name)
            .unwrap_or_else(|| panic!("no section for {} in {summary}", b.name));
        let want = receipt::differences(b);
        assert_eq!(have.len(), want.len(), "{}: {have:#?} / {want:#?}", b.name);
        for (line, d) in have.iter().zip(&want) {
            assert_eq!(line.block, block_name(d.block), "{line:?}");
            assert_eq!(line.count, d.count, "{line:?}");
            match d.block {
                Block::Assets => assert_eq!(line.text, d.text(&zh)),
                Block::Defaults | Block::Lossy => {
                    assert_eq!(line.text, d.text(&zh));
                    assert_eq!(line.code, d.codes[0]);
                }
                Block::Materials => {
                    assert_eq!(line.code, d.codes[0]);
                    let name = &d.args.iter().find(|(n, _)| *n == "name").unwrap().1;
                    assert!(line.text.contains(name.as_str()), "{line:?}");
                }
            }
        }
        // What the dialog shows adds up to the same total.
        let shown = receipt::merged(want.clone());
        assert_eq!(
            receipt::total(&shown),
            have.iter().map(|l| l.count).sum::<usize>()
        );
    }
}

/// A receipt with every sentence there is: every kind of lossy key, every
/// default (and one this version has no sentence for), each material line,
/// the asset files, and the lines summary.md writes around them.
fn every_kind() -> Receipt {
    let mut book = BookRecord {
        book_id: "b1".into(),
        name: "慢钟".into(),
        status: "imported".into(),
        bodies: 3,
        assets_missing: 2,
        assets_mismatched: 1,
        templates: 1,
        history_meta_replayed: 1,
        anchors_without_cursors: 1,
        material_descriptions_to_comments: 1,
        ..Default::default()
    };
    for (i, k) in [
        "unknown-inline:footnote",
        "unknown-inline:mention",
        "unknown-mark:subscript",
        "unknown-block:callout",
        "unknown-atom:widget",
        "comment-action-dropped:accept_suggestion",
        "list-item-extra-paragraph",
        "table-header-cell",
        "table-cell-marks",
        "table-cell-span",
        "table-cell-paragraphs-joined",
        "ordered-list-start",
        "align-unsupported",
        "comment-body-formatting-kept-as-text",
        "patch-body-formatting-kept-as-text",
        "material-description-formatting-kept-as-text",
        "entity-link-same-target-overlap",
        "template-unreadable",
        "material-embed-dropped",
        "comment-priority-dropped",
        "heading-level-clamped",
        "indent-clamped",
        "built-in-relation-type-dropped",
        "relation-image-end-dropped",
        "relation-pdf-end-dropped",
        "relation-comment-end-dropped",
        "relation-todo-end-dropped",
        "relation-patch-end-dropped",
        "relation-other-end-dropped",
        "act-binding-shared-idea-split",
        "act-binding-kept-existing-placement",
        "entity-link-to-asset-kept-as-text",
        "task-todo-link-replaced-by-projection",
        "task-status-follows-tick",
        // Lossless bookkeeping: in neither.
        "block-id-assigned",
    ]
    .iter()
    .enumerate()
    {
        book.notes.0.insert((*k).to_string(), i + 1);
    }
    let codes = dr_import_v1::defaults::CODES
        .iter()
        .copied()
        .chain(["a-code-nobody-knows"]);
    for (i, code) in codes.enumerate() {
        for _ in 0..(i % 3 + 1) {
            book.adjustments.push(dr_import_v1::defaults::Adjustment {
                code: code.into(),
                book: "b1".into(),
                table: "t".into(),
                id: "x".into(),
                done: "d".into(),
                original: None,
            });
        }
    }
    book.task_status_changes.push(TaskStatusChange {
        comment_id: "c1".into(),
        old_doc_id: "library-item:n".into(),
        body: "核对称呼".into(),
        checked: true,
    });
    book.unlinked_asset_links.push(UnlinkedAssetLink {
        doc_id: "d".into(),
        old_doc_id: "node-content:c".into(),
        material_id: "m".into(),
        material_title: "插图".into(),
        text: "看图".into(),
    });
    book.materials_dropped = vec![
        MaterialDropped::EmptyFolder {
            folder_id: "f1".into(),
            name: "空夹".into(),
        },
        MaterialDropped::UnimportedFolder {
            folder_id: "f2".into(),
            name: "坏夹".into(),
        },
        MaterialDropped::WithoutFile {
            material_id: "m1".into(),
            material_title: "封面".into(),
            description: Some("说明".into()),
            relations: vec!["r1".into(), "r2".into()],
            comments: vec!["c1".into()],
        },
        MaterialDropped::UnknownKind {
            material_id: "m3".into(),
            material_title: "录音".into(),
            material_kind: "audio".into(),
        },
        MaterialDropped::SameFile {
            material_id: "m4".into(),
            material_title: "插图二".into(),
            kept_title: "插图".into(),
            asset_id: "a".into(),
        },
    ];
    let other = BookRecord {
        book_id: "b2".into(),
        name: "旧书".into(),
        status: "already-imported".into(),
        ..Default::default()
    };
    Receipt {
        importer: "t",
        started_ms: 0,
        finished_ms: 0,
        source_sha256: "0123456789abcdef".into(),
        source_bytes: 9,
        schema_level_before: 0,
        gate: Gate::decide(false, None, &[], Default::default()),
        accepted: Accept::NOTHING,
        books: vec![book, other],
        docs: Vec::new(),
        anchors: Vec::new(),
        originals: Vec::new(),
        orphan_yjs_docs: 0,
        archived_rows: BTreeMap::new(),
        local_rows: BTreeMap::new(),
        installation_id_adopted: false,
        history_retention: "kept",
        cancelled: false,
    }
}

#[test]
fn every_sentence_of_summary_md_is_a_line_of_the_differences() {
    let r = every_kind();
    let summary = receipt::summary_zh(&r);
    summary_matches(&summary, &r);
    let lines = receipt::differences(&r.books[0]);
    // Each block, the fallback counted; the merged file and the lossless
    // key in neither.
    for block in [
        Block::Assets,
        Block::Defaults,
        Block::Lossy,
        Block::Materials,
    ] {
        assert!(lines.iter().any(|d| d.block == block), "{block:?}");
    }
    assert!(
        lines
            .iter()
            .any(|d| d.sentence == receipt::DEFAULT_FALLBACK && d.count > 0)
    );
    assert!(summary.contains("（1 处，`a-code-nobody-knows`）"));
    assert!(!lines.iter().any(|d| d.codes.iter().any(|c| c == "m4")));
    assert!(!summary.contains("`block-id-assigned`"));
    assert!(receipt::differences(&r.books[1]).is_empty());
}

fn options(old: &Old) -> Options {
    let mut options = Options::new("differences-test");
    options.old_root = Some(old.root.clone());
    options.index = false;
    options
}

/// A real import of a synthetic library with something of each kind: the
/// receipt's lines are summary.md's, book by book, and every block is there.
#[test]
fn a_library_with_differences_says_the_same_in_summary_md_and_the_receipt() {
    let old = build_differences();
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("library");
    let (outcome, _) = run::import(&old.db, &root, &options(&old)).unwrap();
    let Outcome::Imported(r) = outcome else {
        panic!("not imported")
    };
    assert!(r.books.iter().all(|b| b.status == "imported"), "{r:?}");
    let summary =
        std::fs::read_to_string(receipt::directory(&root).join(receipt::SUMMARY)).unwrap();
    summary_matches(&summary, &r);
    let by_id = |id: &str| r.books.iter().find(|b| b.book_id == id).unwrap();
    let first = receipt::differences(by_id(BOOK));
    let second = receipt::differences(by_id(SECOND_BOOK));
    let has = |lines: &[Difference], block: Block, code: &str| {
        lines
            .iter()
            .any(|d| d.block == block && (code.is_empty() || d.codes.iter().any(|c| c == code)))
    };
    for (block, code) in [
        (Block::Assets, ""),
        (Block::Defaults, "chapter-without-book-order"),
        (Block::Defaults, "idea-has-legacy-book-order"),
        (Block::Defaults, "writing-day-duplicate"),
        (Block::Lossy, "table-cell-span"),
        (Block::Lossy, "table-header-cell"),
        (Block::Materials, ""),
    ] {
        assert!(has(&first, block, code), "{block:?} {code}: {first:#?}");
    }
    assert!(has(&second, Block::Assets, "") && has(&second, Block::Materials, ""));
    let assets = first.iter().find(|d| d.block == Block::Assets).unwrap();
    assert_eq!(assets.count, 1);
    // Every default this import took has a sentence of its own.
    for b in &r.books {
        for a in &b.adjustments {
            assert!(receipt::default_sentence(&a.code).is_some(), "{}", a.code);
        }
    }
    // The receipt row of the book, as `import_book` keeps it, gives the same.
    let conn = rusqlite::Connection::open(dr_store::LibraryPaths::new(&root).db).unwrap();
    let json: String = conn
        .query_row(
            "SELECT record_json FROM import_book WHERE book_id = ?1",
            [BOOK],
            |r| r.get(0),
        )
        .unwrap();
    let stored: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(
        stored["assetsMissing"].as_u64(),
        Some(by_id(BOOK).assets_missing as u64)
    );
}
