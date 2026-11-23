//! The defaults for 0.1 data the new book cannot take as it is (decided on
//! the author's behalf, awaiting his review: `m10-import.md`
//! 「替作者定的，等作者过目」). One synthetic case per code, each written
//! the way 0.1 (or its sync) leaves the rows: the import completes without
//! explicit choices, every body's text is the source's, the adjustment is
//! recorded by id, and the loss detector counts it as explained. Then the
//! refusals that remain, each with the data that still produces it.

mod common;

use std::collections::BTreeMap;

use common::{v3_fixture as fixture, *};
use dr_doc::peer::random_device_peer;
use dr_doc::v3::{BookDocV3, BookViewV3};
use dr_import_v1::gate::Accept;
use dr_import_v1::receipt::Receipt;
use dr_import_v1::run::{self, Options, Outcome};
use dr_import_v1::verify;
use dr_model::DocId;
use dr_model::id::*;
use dr_store::{Library, LibraryOptions};
use serde_json::Value;

fn options(old: &Old) -> Options {
    let mut options = Options::new("defaults-test");
    options.old_root = Some(old.root.clone());
    options.verify_history = true;
    options.index = false;
    // Every case keeps the product's default mapping: no explicit choices.
    options.v3 = dr_import_v1::v3::MappingChoices::default();
    // Cases that change a body's cache also break its handoff proof.
    options.accept = Accept::EVERYTHING;
    options
}

fn open(root: &std::path::Path) -> Library {
    let start = std::time::Instant::now();
    loop {
        let mut o = LibraryOptions::new("defaults-test");
        o.configure_doc = Some(std::sync::Arc::new(dr_doc::schema::configure));
        match Library::open(root, o) {
            Ok(lib) => return lib,
            // m10-import.md 待协调 12.
            Err(error)
                if error.to_string().contains("already open") && start.elapsed().as_secs() < 5 =>
            {
                std::thread::sleep(std::time::Duration::from_millis(20))
            }
            Err(error) => panic!("{error}"),
        }
    }
}

fn sql(old: &Old, statements: &[String]) {
    let c = rusqlite::Connection::open(&old.db).unwrap();
    c.pragma_update(None, "foreign_keys", false).unwrap();
    for s in statements {
        c.execute_batch(s).unwrap_or_else(|e| panic!("{e}: {s}"));
    }
}

/// The text of an editor JSON body in document order, without whitespace.
fn json_text(json: &str) -> String {
    fn walk(v: &Value, out: &mut String) {
        match v {
            Value::Object(m) => {
                if let Some(t) = m.get("text").and_then(Value::as_str) {
                    out.push_str(t);
                }
                if let Some(c) = m.get("content") {
                    walk(c, out);
                }
            }
            Value::Array(a) => a.iter().for_each(|x| walk(x, out)),
            _ => {}
        }
    }
    let mut out = String::new();
    if let Ok(v) = serde_json::from_str::<Value>(json) {
        walk(&v, &mut out);
    }
    squash(&out)
}

fn squash(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_whitespace() && !matches!(c, '\u{2028}' | '\u{fffc}'))
        .collect()
}

/// Every body's text in the library equals its 0.1 cache's.
fn bodies_intact(old: &Old, lib: &Library, receipt: &Receipt) {
    let c = rusqlite::Connection::open(&old.db).unwrap();
    let cache = |old_doc: &str| -> Option<String> {
        let (kind, id) = old_doc.split_once(':')?;
        let sql = match kind {
            "node-content" => "SELECT content_json FROM node_content WHERE node_id = ?1",
            "element" => "SELECT content_json FROM element WHERE id = ?1",
            "storyline" => "SELECT content_json FROM storylines WHERE id = ?1",
            "category" => "SELECT content_json FROM element_category WHERE id = ?1",
            "library-item" => "SELECT body_json FROM library_item WHERE id = ?1",
            _ => return None,
        };
        c.query_row(sql, [id], |r| r.get::<_, Option<String>>(0))
            .ok()
            .flatten()
    };
    assert!(!receipt.docs.is_empty());
    for d in &receipt.docs {
        let want = cache(&d.old_doc_id)
            .map(|j| json_text(&j))
            .unwrap_or_default();
        let id = DocId::parse(&d.doc_id).unwrap();
        let snap = lib
            .load_copy(&d.doc_id)
            .unwrap()
            .export(loro::ExportMode::Snapshot)
            .unwrap();
        let doc = dr_doc::prose::ProseDoc::load(id, random_device_peer(), &[snap]).unwrap();
        let mut have = String::new();
        for p in dr_import_v1::prose::read::read_paras_v3(&doc.view()) {
            have.push_str(&p.text());
            for cell in p.table_cells.values() {
                for r in &cell.runs {
                    have.push_str(&r.text);
                }
            }
        }
        assert_eq!(squash(&have), want, "{} lost text", d.old_doc_id);
        assert!(d.stored_exactly && d.round_trips, "{}", d.old_doc_id);
    }
}

fn book(lib: &Library) -> BookDocV3 {
    let snap = lib
        .load_copy(&format!("book:{BOOK}"))
        .unwrap()
        .export(loro::ExportMode::Snapshot)
        .unwrap();
    BookDocV3::load(BookId::parse(BOOK).unwrap(), random_device_peer(), &[snap]).unwrap()
}

struct Case {
    name: &'static str,
    statements: Vec<String>,
    /// (code, 0.1 table, row id) the receipt must record.
    recorded: Vec<(&'static str, &'static str, String)>,
    /// What the book must then hold.
    check: fn(&BookViewV3<'_>, &Receipt),
}

fn s(v: &str) -> String {
    v.to_string()
}

fn entry(view: &BookViewV3<'_>, id: &str) -> dr_model::v3::Entry {
    view.entries_map()
        .remove(&EntryId::parse(id).unwrap())
        .unwrap_or_else(|| panic!("no entry {id}"))
}

fn nothing(_: &BookViewV3<'_>, _: &Receipt) {}

fn cases() -> Vec<Case> {
    let drop_unique_indexes = "SELECT 1".to_string();
    vec![
        Case {
            name: "a category deleted the 0.1 way (its elements' category cleared)",
            statements: vec![
                format!("UPDATE element SET category_id = NULL WHERE category_id = '{CATEGORY}'"),
                format!("UPDATE element_category SET deleted_at = '{T2}' WHERE id = '{CATEGORY}'"),
            ],
            recorded: vec![("element-missing-category", "element", s(ELEMENT))],
            check: |v, _| {
                let e = entry(v, ELEMENT);
                let home = v.entry(e.parent.as_ref().unwrap()).unwrap();
                let home = if home.title == "未分类" {
                    home
                } else {
                    v.entry(home.parent.as_ref().unwrap()).unwrap()
                };
                assert_eq!(home.title, "未分类");
                assert!(!e.is_trashed());
            },
        },
        Case {
            name: "a category trashed on another device (its elements keep its id)",
            statements: vec![format!(
                "UPDATE element_category SET deleted_at = '{T2}' WHERE id = '{CATEGORY}'"
            )],
            recorded: vec![("element-missing-category", "element", s(ELEMENT))],
            check: nothing,
        },
        Case {
            name: "a chapter without a book order",
            statements: vec![format!(
                "UPDATE book_node SET book_order = NULL WHERE id = '{CHAPTER}'"
            )],
            recorded: vec![("chapter-without-book-order", "book_node", s(CHAPTER))],
            check: nothing,
        },
        Case {
            name: "an idea with a book order",
            statements: vec![format!(
                "UPDATE book_node SET book_order = 4 WHERE id = '{IDEA}'"
            )],
            recorded: vec![("idea-has-legacy-book-order", "book_node", s(IDEA))],
            check: nothing,
        },
        Case {
            name: "a node kind 0.1 reads as an idea",
            statements: vec![format!(
                "UPDATE book_node SET kind = 'outline-card' WHERE id = '{}'",
                fixture::IDEA_LINKED
            )],
            recorded: vec![("unknown-node-kind", "book_node", s(fixture::IDEA_LINKED))],
            check: nothing,
        },
        Case {
            name: "a status of the other kind",
            statements: vec![format!(
                "UPDATE book_node SET writing_status = 'drifting' WHERE id = '{CHAPTER}'"
            )],
            recorded: vec![("incompatible-source-node-status", "book_node", s(CHAPTER))],
            check: nothing,
        },
        Case {
            name: "a chapter in an idea group, an idea in a group that is gone",
            statements: vec![
                format!("UPDATE book_node SET drift_group_id = '{GROUP}' WHERE id = '{CHAPTER}'"),
                format!("UPDATE book_node SET drift_group_id = 'gone-group' WHERE id = '{IDEA}'"),
            ],
            recorded: vec![
                ("chapter-in-group-dropped", "book_node", s(CHAPTER)),
                ("idea-group-missing", "book_node", s(IDEA)),
            ],
            check: nothing,
        },
        Case {
            name: "storyline links to a storyline that is gone, and to one in Recently Deleted",
            statements: vec![
                format!(
                    "INSERT INTO node_storyline_link (node_id, storyline_id, is_primary) VALUES ('{}', 'gone-storyline', 0)",
                    fixture::CHAPTER_UNPLACED
                ),
                format!(
                    "UPDATE storylines SET deleted_at = '{T2}' WHERE id = '{}'",
                    fixture::STORYLINE_OTHER
                ),
            ],
            recorded: vec![
                (
                    "membership-target-missing",
                    "node_storyline_link",
                    format!("{}|gone-storyline", fixture::CHAPTER_UNPLACED),
                ),
                (
                    "membership-target-trashed",
                    "node_storyline_link",
                    format!("{CHAPTER}|{}", fixture::STORYLINE_OTHER),
                ),
            ],
            check: |v, _| {
                let host = EntryId::parse(fixture::STORYLINE_OTHER).unwrap();
                assert!(v.memberships_raw().iter().any(|m| m.host == host));
                assert!(v.memberships().iter().all(|m| m.host != host));
            },
        },
        Case {
            name: "two primary storylines",
            statements: vec![
                drop_unique_indexes.clone(),
                format!(
                    "UPDATE node_storyline_link SET is_primary = 1 WHERE node_id = '{CHAPTER}'"
                ),
            ],
            recorded: vec![("multiple-primary-memberships", "book_node", s(CHAPTER))],
            check: |v, _| {
                // The last in storyline order (辅助线 has order_key -10, 主线 0).
                assert_eq!(
                    entry(v, CHAPTER).primary.map(|p| p.to_string()),
                    Some(s(STORYLINE))
                );
            },
        },
        Case {
            name: "an act bound to a chapter",
            statements: vec![format!(
                "UPDATE book_act SET drift_node_id = '{CHAPTER}' WHERE id = 'act-1'"
            )],
            recorded: vec![("act-binding-not-an-idea", "book_act", s("act-1"))],
            check: nothing,
        },
        Case {
            name: "an act without a boundary",
            statements: vec![s(
                "UPDATE book_act SET start_order = NULL WHERE id = 'act-2'",
            )],
            recorded: vec![("act-without-boundary", "book_act", s("act-2"))],
            check: nothing,
        },
        Case {
            name: "two acts on one boundary (0.1's 打散)",
            statements: vec![s("UPDATE book_act SET start_order = 0")],
            recorded: vec![
                ("duplicate-act-boundary", "book_act", s("act-1")),
                ("duplicate-act-boundary", "book_act", s("act-2")),
            ],
            check: nothing,
        },
        Case {
            name: "time pins bound to what is gone and to a chapter",
            statements: vec![
                s("UPDATE timeline_marker SET drift_node_id = 'gone' WHERE id = 'pin-1'"),
                format!(
                    "UPDATE timeline_marker SET drift_node_id = '{CHAPTER}' WHERE id = 'pin-2'"
                ),
            ],
            recorded: vec![
                ("pin-binding-missing-idea", "timeline_marker", s("pin-1")),
                ("pin-binding-missing-idea", "timeline_marker", s("pin-2")),
            ],
            check: |v, _| {
                let pins: Vec<_> = v
                    .timeline_views_raw()
                    .into_iter()
                    .flat_map(|t| t.pins)
                    .collect();
                assert_eq!(pins.len(), 2);
            },
        },
        Case {
            name: "groups and folders whose parent is gone",
            statements: vec![
                format!("UPDATE drift_group SET parent_group_id = 'gone' WHERE id = '{SUBGROUP}'"),
                format!(
                    "UPDATE material_folder SET parent_folder_id = 'gone' WHERE id = '{FOLDER}'"
                ),
            ],
            recorded: vec![
                ("source-tree-missing-parent", "drift_group", s(SUBGROUP)),
                ("source-tree-missing-parent", "material_folder", s(FOLDER)),
            ],
            check: nothing,
        },
        Case {
            name: "two idea groups each other's parent",
            statements: vec![format!(
                "UPDATE drift_group SET parent_group_id = '{SUBGROUP}' WHERE id = '{GROUP}'"
            )],
            recorded: vec![("source-tree-cycle", "drift_group", s(GROUP))],
            check: |v, _| {
                assert!(entry(v, SUBGROUP).parent == Some(EntryId::parse(GROUP).unwrap()));
            },
        },
        Case {
            name: "category layouts 0.1 places itself",
            statements: vec![
                format!(
                    "UPDATE element_category SET layout_mode = 'spiral' WHERE id = '{CATEGORY}'"
                ),
                format!(
                    "UPDATE element_category SET grid_x = 1, grid_y = 2 WHERE id = '{}'",
                    fixture::CATEGORY_OTHER
                ),
            ],
            recorded: vec![
                ("unknown-category-layout", "element_category", s(CATEGORY)),
                (
                    "auto-category-has-grid-position",
                    "element_category",
                    s(fixture::CATEGORY_OTHER),
                ),
            ],
            check: nothing,
        },
        Case {
            name: "a pinned category with one coordinate",
            statements: vec![format!(
                "UPDATE element_category SET grid_y = NULL WHERE id = '{CATEGORY}'"
            )],
            recorded: vec![(
                "incomplete-category-grid-position",
                "element_category",
                s(CATEGORY),
            )],
            check: nothing,
        },
        Case {
            name: "unreadable key/value and alias projections",
            statements: vec![
                format!("UPDATE element SET kv_json = '{{broken' WHERE id = '{ELEMENT}'"),
                format!("UPDATE element SET aliases_json = '[\"阿贵\", 3]' WHERE id = '{ELEMENT}'"),
            ],
            recorded: vec![
                ("unreadable-source-kv-projection", "element", s(ELEMENT)),
                ("unreadable-source-aliases", "element", s(ELEMENT)),
            ],
            check: |v, _| {
                let e = entry(v, ELEMENT);
                let aliases = e
                    .fields
                    .get(&dr_model::v3::ModuleId::parse("mod-fields").unwrap())
                    .and_then(|f| f.get("aliases"))
                    .cloned();
                assert_eq!(
                    aliases,
                    Some(dr_model::v3::FieldValue::List(vec![s("阿贵")]))
                );
            },
        },
        Case {
            name: "two template fields of one name, one with a built-in field's id",
            statements: vec![
                format!(
                    "INSERT INTO entity_kv_entry (id, project_id, owner_kind, owner_id, namespace, key, value) VALUES ('kv-9', '{BOOK}', 'element-category', '{CATEGORY}', 'element-template', '年龄', '老')"
                ),
                s("UPDATE entity_kv_entry SET id = 'summary' WHERE id = 'kv-7'"),
            ],
            recorded: vec![
                ("ambiguous-template-field", "entity_kv_entry", s("kv-9")),
                ("ambiguous-template-field", "entity_kv_entry", s("summary")),
            ],
            check: nothing,
        },
        Case {
            name: "two values of an element under one field name",
            statements: vec![format!(
                "INSERT INTO entity_kv_entry (id, project_id, owner_kind, owner_id, namespace, key, value) VALUES ('kv-10', '{BOOK}', 'element', '{ELEMENT}', 'facts', '年龄', '36')"
            )],
            recorded: vec![(
                "duplicate-value-for-template-field",
                "entity_kv_entry",
                s("kv-10"),
            )],
            check: |v, _| {
                let e = entry(v, ELEMENT);
                let kv = &e.kv[&dr_model::v3::ModuleId::parse("mod-kv").unwrap()];
                assert!(
                    kv.iter()
                        .any(|k| k.id.as_str() == "kv-10" && k.value == "36")
                );
            },
        },
        Case {
            name: "a malformed writing day and two rows of one device and day",
            statements: vec![
                format!(
                    "INSERT INTO writing_day (id, project_id, day, device_key, words, created_at, updated_at) VALUES ('wd-2', '{BOOK}', '2026-02-31', '{DEVICE_KEY}', 5, '{T1}', '{T1}')"
                ),
                format!(
                    "INSERT INTO writing_day (id, project_id, day, device_key, words, created_at, updated_at) VALUES ('wd-3', '{BOOK}', '2026-10-02', '{DEVICE_KEY}', 66, '{T1}', '{T1}')"
                ),
            ],
            recorded: vec![
                ("writing-day-invalid", "writing_day", s("wd-2")),
                ("writing-day-duplicate", "writing_day", s("wd-3")),
            ],
            check: nothing,
        },
        Case {
            name: "history without a preview, without an owner, with metadata 0.1 cannot read",
            statements: vec![
                s("UPDATE entity_snapshot_history SET content_json = NULL WHERE id = 'h-1'"),
                s("UPDATE entity_snapshot_history SET entity_id = 'gone' WHERE id = 'h-3'"),
                s("UPDATE entity_snapshot_history SET meta_json = '{broken' WHERE id = 'h-2'"),
            ],
            recorded: vec![
                (
                    "history-preview-missing",
                    "entity_snapshot_history",
                    s("h-1"),
                ),
                ("orphan-history-source", "entity_snapshot_history", s("h-3")),
                (
                    "unreadable-history-metadata",
                    "entity_snapshot_history",
                    s("h-2"),
                ),
            ],
            check: nothing,
        },
        Case {
            name: "history metadata of the other kind, and a preview that is not JSON",
            statements: vec![
                s(
                    "UPDATE entity_snapshot_history SET meta_json = '{\"writingStatus\":\"drifting\"}' WHERE id = 'h-1'",
                ),
                s("UPDATE entity_snapshot_history SET content_json = '{broken' WHERE id = 'h-2'"),
            ],
            recorded: vec![
                (
                    "incompatible-history-node-status",
                    "entity_snapshot_history",
                    s("h-1"),
                ),
                (
                    "history-preview-unreadable",
                    "entity_snapshot_history",
                    s("h-2"),
                ),
            ],
            check: nothing,
        },
        Case {
            name: "history with duplicate field names",
            statements: vec![
                format!(
                    "UPDATE entity_snapshot_history SET meta_json = '{}' WHERE id = 'h-3'",
                    serde_json::json!({"kvJson": serde_json::json!([{"key":"年龄","value":"1"},{"key":"年龄","value":"2"}]).to_string()})
                ),
                format!(
                    "UPDATE entity_snapshot_history SET entity_kind = 'category', entity_id = '{CATEGORY}', meta_json = '{}' WHERE id = 'h-2'",
                    serde_json::json!({"elementTemplateKvJson": serde_json::json!([{"key":"年龄","value":""},{"key":"年龄","value":""}]).to_string()})
                ),
            ],
            recorded: vec![
                (
                    "duplicate-history-value-for-template-field",
                    "entity_snapshot_history",
                    s("h-3"),
                ),
                (
                    "ambiguous-history-template-field",
                    "entity_snapshot_history",
                    s("h-2"),
                ),
            ],
            check: |_, r| {
                assert_eq!(
                    r.books[0].history_meta_checked,
                    r.books[0].history_meta_replayed
                );
            },
        },
        Case {
            name: "a comment on something deleted for good",
            statements: vec![format!(
                "UPDATE comment SET target_id = 'gone-chapter' WHERE id = '{BLOCK_COMMENT}'"
            )],
            recorded: vec![("comment-target-missing", "comment", s(BLOCK_COMMENT))],
            check: |v, _| {
                let c = v
                    .comment(&CommentId::parse(BLOCK_COMMENT).unwrap())
                    .unwrap();
                assert!(c.target_missing);
            },
        },
        Case {
            name: "plot-grid lines with sync's placeholder position key",
            statements: vec![s(
                "UPDATE plot_grid_row SET position_key = 'pending' WHERE id = 'r1'",
            )],
            recorded: vec![(
                "plot-grid-position-key-regenerated",
                "plot_grid_row",
                s("r1"),
            )],
            check: nothing,
        },
        Case {
            name: "a body template that is not JSON",
            statements: vec![format!(
                "UPDATE storylines SET node_content_template_json = '{{broken' WHERE id = '{STORYLINE}'"
            )],
            recorded: vec![("unreadable-source-template", "storylines", s(STORYLINE))],
            check: nothing,
        },
    ]
}

/// The prose cases: links the book cannot keep and table cells it flattens.
fn prose_cases() -> Vec<(&'static str, Value)> {
    use serde_json::json;
    let para = |text: &str, mark: Value| json!({"type":"doc","content":[{"type":"paragraph","attrs":{"id":"e-p1"},"content":[{"type":"text","text":text,"marks":[mark]}]}]});
    let cell = |content: Value| json!({"type":"doc","content":[{"type":"table","content":[{"type":"tableRow","content":[{"type":"tableCell","content":[content]}]}]}]});
    vec![
        (
            "unsupported-entity-link-target-kind",
            para(
                "批注链接",
                json!({"type":"entityLink","attrs":{"targetKind":"comment","targetId":COMMENT}}),
            ),
        ),
        (
            "invalid-source-entity-link",
            para(
                "非法模块标识",
                json!({"type":"entityLink","attrs":{"targetKind":"library_item","targetId":NOTE,"targetModule":"bad/module"}}),
            ),
        ),
        (
            "invalid-source-entity-link",
            para(
                "粘贴来的空链接",
                json!({"type":"entityLink","attrs":{"targetKind":"element","targetId":""}}),
            ),
        ),
        (
            "unsupported-table-cell-mark",
            cell(
                json!({"type":"paragraph","content":[{"type":"text","text":"表格里的下标","marks":[{"type":"subscript"}]}]}),
            ),
        ),
        (
            "unsupported-table-cell-content",
            cell(
                json!({"type":"codeBlock","attrs":{"language":"rust"},"content":[{"type":"text","text":"fn main() {}"}]}),
            ),
        ),
        (
            "unsupported-table-cell-content",
            cell(
                json!({"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"格子里的列表"}]}]}]}),
            ),
        ),
    ]
}

fn import_and_check(
    old: &Old,
    recorded: &[(&str, &str, String)],
    check: fn(&BookViewV3<'_>, &Receipt),
    name: &str,
) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("library");
    let (outcome, _) = run::import(&old.db, &root, &options(old))
        .unwrap_or_else(|e| panic!("{name}: refused: {e}"));
    let Outcome::Imported(receipt) = outcome else {
        panic!("{name}: not imported")
    };
    assert!(
        receipt.books.iter().all(|b| b.status == "imported"),
        "{name}"
    );
    let adjustments: BTreeMap<(String, String, String), String> = receipt.books[0]
        .adjustments
        .iter()
        .map(|a| {
            (
                (a.code.clone(), a.table.clone(), a.id.clone()),
                a.done.clone(),
            )
        })
        .collect();
    for (code, table, id) in recorded {
        assert!(
            adjustments.contains_key(&(code.to_string(), table.to_string(), id.clone())),
            "{name}: {code} {table} {id} not recorded; recorded: {adjustments:#?}"
        );
        // Also in the receipt tables and the author's summary.
        assert!(
            receipt
                .originals
                .iter()
                .any(|(c, i, f, _)| c == &format!("adjusted:{table}") && i == id && f == code),
            "{name}: {code} {id} not in import_original"
        );
    }
    let summary = std::fs::read_to_string(root.join("import-v1").join("summary.md")).unwrap();
    for (code, _, _) in recorded {
        assert!(
            summary.contains(&format!("`{code}`")),
            "{name}: {code} not in summary.md"
        );
    }
    // Each says a sentence of its own in summary.md and the done dialog
    // (`receipt::differences`), not the fallback.
    for a in &receipt.books[0].adjustments {
        assert!(
            dr_import_v1::receipt::default_sentence(&a.code).is_some(),
            "{name}: {} has no sentence",
            a.code
        );
    }
    let parsed = parse_summary(&summary);
    let defaults: usize = parsed[&receipt.books[0].name]
        .iter()
        .filter(|l| l.block == "defaults")
        .map(|l| l.count)
        .sum();
    assert_eq!(
        defaults,
        receipt.books[0].adjustments.len(),
        "{name}: summary.md counts every adjustment"
    );
    let lib = open(&root);
    bodies_intact(old, &lib, &receipt);
    let doc = book(&lib);
    check(&doc.view(), &receipt);
    let catalog = verify::check_catalog_in(&old.db, &lib).unwrap();
    assert!(catalog.is_clean(), "{name}: {:#?}", catalog.unexplained);
    lib.close().unwrap();
}

#[test]
fn every_default_imports_records_and_keeps_every_body() {
    for case in cases() {
        let old = fixture::build();
        let mut statements = case.statements.clone();
        if statements.first().map(String::as_str) == Some("SELECT 1") {
            // 0.1's partial unique index on primary storylines: what sync
            // from another device does not check (corruption otherwise).
            let c = rusqlite::Connection::open(&old.db).unwrap();
            let names: Vec<String> = c
                .prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'node_storyline_link' AND sql LIKE '%UNIQUE%'")
                .unwrap()
                .query_map([], |r| r.get(0))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap();
            statements[0] = names
                .iter()
                .map(|n| format!("DROP INDEX \"{n}\";"))
                .collect::<String>();
            if statements[0].is_empty() {
                statements[0] = "SELECT 1".into();
            }
        }
        sql(&old, &statements);
        import_and_check(&old, &case.recorded, case.check, case.name);
    }
}

#[test]
fn links_the_book_cannot_keep_and_flattened_table_cells_keep_their_text() {
    for (code, body) in prose_cases() {
        let old = fixture::build();
        sql(
            &old,
            &[format!(
                "UPDATE element SET content_json = '{}' WHERE id = '{ELEMENT}'",
                body.to_string().replace('\'', "''")
            )],
        );
        import_and_check(
            &old,
            &[(code, "prose", format!("element:{ELEMENT}"))],
            nothing,
            code,
        );
    }
}

/// An author's relation with nothing at one end, or the same thing at both:
/// dropped with its pair kept in the receipt (`relations / dropped`); one to
/// a chapter in Recently Deleted is kept.
#[test]
fn relations_with_nothing_at_an_end_are_dropped_and_recorded() {
    for (statement, reason) in [
        (
            format!("UPDATE entity_relation SET from_id = '{ELEMENT}' WHERE id = 'rel-1'"),
            "relation-self-end-dropped",
        ),
        (
            s("UPDATE entity_relation SET from_id = 'gone' WHERE id = 'rel-1'"),
            "relation-missing-entry-dropped",
        ),
    ] {
        let old = fixture::build();
        sql(&old, &[statement]);
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("library");
        let (outcome, _) = run::import(&old.db, &root, &options(&old)).unwrap();
        let Outcome::Imported(receipt) = outcome else {
            panic!("not imported")
        };
        let (_, _, _, json) = receipt
            .originals
            .iter()
            .find(|(c, i, f, _)| c == "relations" && i == "rel-1" && f == "dropped")
            .expect("recorded");
        assert!(json.contains(reason), "{json}");
        let lib = open(&root);
        bodies_intact(&old, &lib, &receipt);
        let catalog = verify::check_catalog_in(&old.db, &lib).unwrap();
        assert!(catalog.is_clean(), "{:#?}", catalog.unexplained);
        lib.close().unwrap();
    }
    let old = fixture::build();
    sql(
        &old,
        &[format!(
            "UPDATE element SET deleted_at = '{T2}' WHERE id = '{}'",
            fixture::ELEMENT_OTHER
        )],
    );
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("library");
    run::import(&old.db, &root, &options(&old)).unwrap();
    let lib = open(&root);
    let catalog = verify::check_catalog_in(&old.db, &lib).unwrap();
    assert!(catalog.is_clean(), "{:#?}", catalog.unexplained);
    assert_eq!(
        catalog.tables["entity_relation"].dropped, 2,
        "only the retired ends"
    );
    lib.close().unwrap();
}

/// Every table that names the book, renamed together (a project id 0.1's
/// own writers never make; sync admits any opaque id).
fn rename_book(old: &Old, new: &str) {
    let c = rusqlite::Connection::open(&old.db).unwrap();
    c.pragma_update(None, "foreign_keys", false).unwrap();
    let tables: Vec<String> = c
        .prepare("SELECT m.name FROM sqlite_schema m WHERE m.type = 'table' AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) p WHERE p.name = 'project_id')")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    for t in tables {
        c.execute(
            &format!("UPDATE \"{t}\" SET project_id = ?1 WHERE project_id = ?2"),
            [new, BOOK],
        )
        .unwrap();
    }
    c.execute("UPDATE project SET id = ?1 WHERE id = ?2", [new, BOOK])
        .unwrap();
}

/// What still stops the import, each with the data that produces it; nothing
/// is written and the source is untouched.
#[test]
fn what_cannot_be_read_or_named_still_refuses() {
    type Damage = Box<dyn Fn(&Old)>;
    let cases: Vec<(&str, Damage)> = vec![
        (
            "entry-id-invalid-or-colliding",
            Box::new(|old: &Old| {
                // An idea group with a chapter's id (an imported package that
                // already had the collision).
                sql(
                    old,
                    &[format!(
                        "INSERT INTO drift_group (id, project_id, name, parent_group_id, color, sort_order, created_at, updated_at) VALUES ('{CHAPTER}', '{BOOK}', '撞号', NULL, NULL, 3, '{T0}', '{T0}')"
                    )],
                )
            }),
        ),
        (
            "entry-id-invalid-or-colliding",
            Box::new(|old: &Old| {
                // A group id with a separator the book's ids reserve.
                sql(
                    old,
                    &[
                        format!("UPDATE drift_group SET id = 'a|b' WHERE id = '{SUBGROUP}'"),
                        format!(
                            "UPDATE book_node SET drift_group_id = 'a|b' WHERE drift_group_id = '{SUBGROUP}'"
                        ),
                    ],
                )
            }),
        ),
        (
            "template-prose-id-not-representable",
            Box::new(|old: &Old| rename_book(old, "book/with/slashes")),
        ),
        (
            "invalid-book-id",
            Box::new(|old: &Old| rename_book(old, "bad\u{7}book")),
        ),
        (
            "unreadable-source-prose",
            Box::new(|old: &Old| {
                sql(
                    old,
                    &[format!(
                        "UPDATE node_content SET content_json = '{{broken' WHERE node_id = '{CHAPTER}'"
                    )],
                )
            }),
        ),
    ];
    for (code, damage) in cases {
        let old = fixture::build();
        damage(&old);
        let before = std::fs::read(&old.db).unwrap();
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("library");
        let error = run::import(&old.db, &root, &options(&old)).unwrap_err();
        assert!(
            matches!(&error, dr_import_v1::ImportError::V3Pending(p) if p.iter().any(|p| p.code == code)),
            "{code}: {error}"
        );
        assert!(!root.join("library.sqlite").exists(), "{code}");
        assert_eq!(std::fs::read(&old.db).unwrap(), before, "{code}");
    }
}

/// A long category id (sync admits up to 255 bytes) gets a hashed template id
/// and imports; nothing in 0.1 refers to template ids.
#[test]
fn a_long_category_id_gets_a_hashed_template_and_imports() {
    let old = fixture::build();
    let long = "c".repeat(220);
    let c = rusqlite::Connection::open(&old.db).unwrap();
    c.pragma_update(None, "foreign_keys", false).unwrap();
    for sql in [
        "UPDATE element_category SET id = ?1 WHERE id = ?2",
        "UPDATE element SET category_id = ?1 WHERE category_id = ?2",
        "UPDATE entity_kv_entry SET owner_id = ?1 WHERE owner_id = ?2",
        "UPDATE entity_snapshot_history SET entity_id = ?1 WHERE entity_id = ?2",
    ] {
        c.execute(sql, [&long, CATEGORY]).unwrap();
    }
    c.execute(
        "UPDATE yjs_updates SET document_id = ?1 WHERE document_id = ?2",
        [format!("category:{long}"), format!("category:{CATEGORY}")],
    )
    .unwrap();
    drop(c);
    import_and_check(&old, &[], nothing, "long category id");
}
