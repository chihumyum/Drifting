//! Defaults for 0.1 data the new book cannot take as it is (2026-11-21,
//! decided on the author's behalf, awaiting his review: `m10-import.md`
//! 「替作者定的，等作者过目」).
//!
//! The rule: the import never refuses a library for something the 0.1
//! client opens and shows. Each case gets a default that keeps the author's
//! text, puts what moved somewhere visible and recoverable, and is recorded
//! here as an [`Adjustment`] (into the receipt, `summary.md` and the
//! `import_original` table), so `verify::check_catalog` counts it as
//! explained by id. Where 0.1 had a behaviour, the default mirrors it.
//!
//! The defaults are applied to the staging copy, before anything reads it:
//! every later step (the gate, the preflight, the book writer, the history
//! replay) sees one consistent, repaired library. The original library is
//! never written. Prose caches and Yjs tables are never changed (the gate's
//! proofs hash them); what prose needs is done while it is planned
//! ([`crate::prose`]) and recorded per body.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::Result;

/// Every code an [`Adjustment`] can carry: the defaults here and the ones
/// `crate::v3::findings` records while it plans the bodies and the history.
/// Each has its own sentence in summary.md and the done dialog
/// (`crate::receipt::default_sentence`, in all nine languages); a test
/// fails for a code recorded in the source and missing here, or listed
/// here without a sentence.
pub const CODES: &[&str] = &[
    "act-binding-not-an-idea",
    "act-without-boundary",
    "ambiguous-history-template-field",
    "ambiguous-template-field",
    "auto-category-has-grid-position",
    "chapter-in-group-dropped",
    "chapter-without-book-order",
    "comment-target-missing",
    "duplicate-act-boundary",
    "duplicate-history-value-for-template-field",
    "duplicate-value-for-template-field",
    "element-missing-category",
    "history-preview-missing",
    "history-preview-unreadable",
    "idea-group-missing",
    "idea-has-legacy-book-order",
    "incompatible-history-node-status",
    "incompatible-source-node-status",
    "incomplete-category-grid-position",
    "invalid-source-entity-link",
    "membership-target-missing",
    "membership-target-trashed",
    "multiple-primary-memberships",
    "orphan-history-source",
    "pin-binding-missing-idea",
    "plot-grid-position-key-regenerated",
    "source-tree-cycle",
    "source-tree-missing-parent",
    "unknown-category-layout",
    "unknown-node-kind",
    "unreadable-history-metadata",
    "unreadable-source-aliases",
    "unreadable-source-kv-projection",
    "unreadable-source-template",
    "unsupported-entity-link-target-kind",
    "unsupported-table-cell-content",
    "unsupported-table-cell-mark",
    "writing-day-duplicate",
    "writing-day-invalid",
];

/// One thing the import changed on its copy of the 0.1 library so the book
/// could take it, with what it was.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Adjustment {
    /// The case (the code the import used to stop on).
    pub code: String,
    /// The 0.1 book (`project.id`).
    pub book: String,
    /// The 0.1 table and row.
    pub table: String,
    pub id: String,
    /// What the import did (`kept`: nothing changed, the book takes it).
    pub done: String,
    /// The original value(s), as JSON.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original: Option<String>,
}

struct Log(Vec<Adjustment>);

impl Log {
    fn add(&mut self, code: &str, book: &str, table: &str, id: &str, done: &str, original: Value) {
        self.0.push(Adjustment {
            code: code.into(),
            book: book.into(),
            table: table.into(),
            id: id.into(),
            done: done.into(),
            original: (!original.is_null()).then(|| original.to_string()),
        });
    }
}

fn rows<T>(
    conn: &Connection,
    sql: &str,
    p: impl rusqlite::Params,
    f: impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
) -> Result<Vec<T>> {
    let mut stmt = conn.prepare(sql)?;
    let v = stmt
        .query_map(p, f)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(v)
}

/// Whether `json` is what 0.1's `stringifyKv` writes: an array of
/// `{key: string, value: string}`.
pub(crate) fn valid_kv_json(json: &str) -> bool {
    serde_json::from_str::<Vec<Value>>(json).is_ok_and(|rows| {
        rows.iter().all(|row| {
            row.get("key").and_then(Value::as_str).is_some()
                && row.get("value").and_then(Value::as_str).is_some()
        })
    })
}

/// Whether a snapshot history row's `meta_json` cannot be read the way 0.1
/// wrote it (`snapshot-history.service.ts` `entityMeta`).
pub(crate) fn meta_unreadable(json: &str) -> bool {
    if crate::meta::parse(json).is_none() {
        return true;
    }
    let Ok(value) = serde_json::from_str::<Value>(json) else {
        return true;
    };
    ["kvJson", "elementTemplateKvJson"].iter().any(|key| {
        value
            .get(*key)
            .is_some_and(|v| v.as_str().is_none_or(|text| !valid_kv_json(text)))
    }) || ["title", "summary", "name", "writingStatus"]
        .iter()
        .any(|key| value.get(*key).is_some_and(|v| !v.is_string()))
        || value.get("aliases").is_some_and(|v| {
            v.as_array()
                .is_none_or(|aliases| aliases.iter().any(|a| !a.is_string()))
        })
        || value
            .get("groupName")
            .is_some_and(|v| !v.is_null() && !v.is_string())
}

/// The rank 0.1's lists give a key/value row: its place in the owner's
/// projection (the exact pair first, then the key), then its id (uuidv7, so
/// creation order). The importer orders key/value lists the same way
/// (`book::kv_ordered`).
fn kv_rank<'a>(rows: &[&'a KvRow], projection: &str) -> Vec<&'a KvRow> {
    let listed: Vec<(String, String)> = serde_json::from_str::<Vec<Value>>(projection)
        .unwrap_or_default()
        .iter()
        .filter_map(|e| {
            Some((
                e.get("key")?.as_str()?.to_string(),
                e.get("value")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            ))
        })
        .collect();
    let mut left: Vec<&KvRow> = rows.to_vec();
    let mut ordered = Vec::new();
    for (k, v) in &listed {
        let at = left
            .iter()
            .position(|r| &r.key == k && &r.value == v)
            .or_else(|| left.iter().position(|r| &r.key == k));
        if let Some(i) = at {
            ordered.push(left.remove(i));
        }
    }
    left.sort_by(|a, b| a.id.cmp(&b.id));
    ordered.extend(left);
    ordered
}

#[derive(Clone, Debug)]
struct KvRow {
    id: String,
    project: String,
    owner_kind: String,
    owner: String,
    namespace: String,
    key: String,
    value: String,
}

/// Template field ids the book's own fields use (`category_template`'s
/// built-in fields of the element template).
const BUILT_IN_FIELD_IDS: [&str; 3] = ["aliases", "summary", "portrait"];

/// Apply every default to the staging copy `conn`, in one transaction.
pub fn apply(conn: &Connection) -> Result<Vec<Adjustment>> {
    let tx = conn.unchecked_transaction()?;
    let mut log = Log(Vec::new());
    nodes(&tx, &mut log)?;
    links(&tx, &mut log)?;
    acts_and_pins(&tx, &mut log)?;
    trees(&tx, &mut log)?;
    categories(&tx, &mut log)?;
    projections(&tx, &mut log)?;
    kv(&tx, &mut log)?;
    writing_days(&tx, &mut log)?;
    history(&tx, &mut log)?;
    recorded_only(&tx, &mut log)?;
    tx.commit()?;
    Ok(log.0)
}

/// Chapters and ideas: what 0.1's `node-repo.ts` reads them as.
fn nodes(tx: &Connection, log: &mut Log) -> Result<()> {
    // Any kind that is not a chapter is read as an idea (node-repo.ts:107).
    for (id, book, kind) in rows(
        tx,
        "SELECT id, project_id, kind FROM book_node WHERE kind NOT IN ('chapter', 'drift')",
        [],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        },
    )? {
        tx.execute("UPDATE book_node SET kind = 'drift' WHERE id = ?1", [&id])?;
        log.add(
            "unknown-node-kind",
            &book,
            "book_node",
            &id,
            "kind = drift",
            Value::from(kind),
        );
    }
    // A chapter without a book order is read as order 0, ties by id
    // (node-repo.ts:118-123, book-node.ts:207-217).
    for (id, book) in rows(
        tx,
        "SELECT id, project_id FROM book_node WHERE kind = 'chapter' AND book_order IS NULL",
        [],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
    )? {
        tx.execute("UPDATE book_node SET book_order = 0 WHERE id = ?1", [&id])?;
        log.add(
            "chapter-without-book-order",
            &book,
            "book_node",
            &id,
            "book_order = 0",
            Value::Null,
        );
    }
    // An idea's book order is ignored (node-repo.ts:109-115).
    for (id, book, order) in rows(
        tx,
        "SELECT id, project_id, book_order FROM book_node WHERE kind = 'drift' AND book_order IS NOT NULL",
        [],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, f64>(2)?,
            ))
        },
    )? {
        tx.execute(
            "UPDATE book_node SET book_order = NULL WHERE id = ?1",
            [&id],
        )?;
        log.add(
            "idea-has-legacy-book-order",
            &book,
            "book_node",
            &id,
            "book_order = NULL",
            Value::from(order),
        );
    }
    // A chapter's group is ignored (only ideas live in groups).
    for (id, book, group) in rows(
        tx,
        "SELECT id, project_id, drift_group_id FROM book_node WHERE kind = 'chapter' AND drift_group_id IS NOT NULL",
        [],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        },
    )? {
        tx.execute(
            "UPDATE book_node SET drift_group_id = NULL WHERE id = ?1",
            [&id],
        )?;
        log.add(
            "chapter-in-group-dropped",
            &book,
            "book_node",
            &id,
            "drift_group_id = NULL",
            Value::from(group),
        );
    }
    // An idea whose group is gone shows at the root of the idea panel
    // (DriftPanel.tsx:176-190).
    for (id, book, group) in rows(
        tx,
        "SELECT n.id, n.project_id, n.drift_group_id FROM book_node n WHERE n.drift_group_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM drift_group g WHERE g.id = n.drift_group_id AND g.project_id = n.project_id)",
        [],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        },
    )? {
        tx.execute(
            "UPDATE book_node SET drift_group_id = NULL WHERE id = ?1",
            [&id],
        )?;
        log.add(
            "idea-group-missing",
            &book,
            "book_node",
            &id,
            "drift_group_id = NULL",
            Value::from(group),
        );
    }
    // A status of the other kind: the kind's own default, as 0.1 shows it
    // (book-node.ts:232-255).
    for (id, book, kind, status) in rows(
        tx,
        "SELECT id, project_id, kind, writing_status FROM book_node",
        [],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        },
    )? {
        let kind = dr_model::import_v1::NodeKind::parse(&kind);
        if dr_model::import_v1::NodeStatus::parse(&status).fits(&kind) {
            continue;
        }
        let want = dr_model::import_v1::NodeStatus::default_for(&kind);
        tx.execute(
            "UPDATE book_node SET writing_status = ?2 WHERE id = ?1",
            params![id, want.as_str()],
        )?;
        log.add(
            "incompatible-source-node-status",
            &book,
            "book_node",
            &id,
            &format!("writing_status = {}", want.as_str()),
            Value::from(status),
        );
    }
    Ok(())
}

/// Storyline links.
fn links(tx: &Connection, log: &mut Log) -> Result<()> {
    // A link with no chapter or no storyline row has nothing to attach to
    // (0.1's foreign keys make this corruption only).
    for (node, storyline, primary) in rows(
        tx,
        "SELECT l.node_id, l.storyline_id, l.is_primary FROM node_storyline_link l WHERE NOT EXISTS (SELECT 1 FROM book_node n WHERE n.id = l.node_id) OR NOT EXISTS (SELECT 1 FROM storylines s WHERE s.id = l.storyline_id)",
        [],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
            ))
        },
    )? {
        let book: Option<String> = tx
            .query_row(
                "SELECT project_id FROM book_node WHERE id = ?1 UNION SELECT project_id FROM storylines WHERE id = ?2",
                params![node, storyline],
                |r| r.get(0),
            )
            .optional()?;
        tx.execute(
            "DELETE FROM node_storyline_link WHERE node_id = ?1 AND storyline_id = ?2",
            params![node, storyline],
        )?;
        log.add(
            "membership-target-missing",
            book.as_deref().unwrap_or(""),
            "node_storyline_link",
            &format!("{node}|{storyline}"),
            "dropped",
            serde_json::json!({"node": node, "storyline": storyline, "primary": primary != 0}),
        );
    }
    // A link to a storyline in Recently Deleted is kept: format 5 keeps it
    // and reads it as absent until the storyline comes back, which is what
    // 0.1 showed (the chapter under no storyline, ChapterPanel.tsx:348-363).
    for (node, storyline, book) in rows(
        tx,
        "SELECT l.node_id, l.storyline_id, s.project_id FROM node_storyline_link l JOIN storylines s ON s.id = l.storyline_id WHERE s.deleted_at IS NOT NULL",
        [],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        },
    )? {
        log.add(
            "membership-target-trashed",
            &book,
            "node_storyline_link",
            &format!("{node}|{storyline}"),
            "kept",
            Value::Null,
        );
    }
    // Two primary storylines: the last one in storyline order wins, as in
    // 0.1 (node-storyline-state.ts:19-23); the others stay as storylines.
    for (node, book) in rows(
        tx,
        "SELECT l.node_id, n.project_id FROM node_storyline_link l JOIN book_node n ON n.id = l.node_id WHERE l.is_primary = 1 GROUP BY l.node_id HAVING count(*) > 1",
        [],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
    )? {
        let primaries: Vec<String> = rows(
            tx,
            "SELECT l.storyline_id FROM node_storyline_link l JOIN storylines s ON s.id = l.storyline_id WHERE l.node_id = ?1 AND l.is_primary = 1 ORDER BY s.order_key, s.id",
            [&node],
            |r| r.get(0),
        )?;
        let kept = primaries.last().cloned().unwrap_or_default();
        tx.execute(
            "UPDATE node_storyline_link SET is_primary = 0 WHERE node_id = ?1 AND storyline_id <> ?2",
            params![node, kept],
        )?;
        log.add(
            "multiple-primary-memberships",
            &book,
            "book_node",
            &node,
            &format!("primary storyline = {kept}"),
            Value::from(primaries),
        );
    }
    Ok(())
}

/// Acts and time pins.
fn acts_and_pins(tx: &Connection, log: &mut Log) -> Result<()> {
    // An act bound to a chapter, not an idea: 0.1 shows it unbound (its
    // tooltip falls back to 「幕笔记」, DesktopBottomTimeline.tsx:168-172).
    for (id, book, drift) in rows(
        tx,
        "SELECT a.id, a.project_id, a.drift_node_id FROM book_act a WHERE a.drift_node_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM book_node n WHERE n.id = a.drift_node_id AND n.kind = 'drift')",
        [],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        },
    )? {
        tx.execute(
            "UPDATE book_act SET drift_node_id = NULL WHERE id = ?1",
            [&id],
        )?;
        log.add(
            "act-binding-not-an-idea",
            &book,
            "book_act",
            &id,
            "drift_node_id = NULL",
            Value::from(drift),
        );
    }
    // An act without a boundary is the book's first act, from its start
    // (book-act.ts:63-70, 103-127): the book takes it as it is.
    for (id, book) in rows(
        tx,
        "SELECT id, project_id FROM book_act WHERE start_order IS NULL",
        [],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
    )? {
        log.add(
            "act-without-boundary",
            &book,
            "book_act",
            &id,
            "kept",
            Value::Null,
        );
    }
    // Two acts on one boundary (0.1's 「打散」 writes this): ties by id, the
    // later act owns the chapters and the earlier one is empty
    // (book-act.ts:66-69, 112-126). The book takes it as it is.
    for (id, book) in rows(
        tx,
        "SELECT a.id, a.project_id FROM book_act a WHERE EXISTS (SELECT 1 FROM book_act b WHERE b.project_id = a.project_id AND b.id <> a.id AND b.start_order IS a.start_order)",
        [],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
    )? {
        log.add(
            "duplicate-act-boundary",
            &book,
            "book_act",
            &id,
            "kept",
            Value::Null,
        );
    }
    // A pin bound to what is not a live idea: unbound, the pin stays.
    for (id, book, drift) in rows(
        tx,
        "SELECT m.id, m.project_id, m.drift_node_id FROM timeline_marker m WHERE m.drift_node_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM book_node n WHERE n.id = m.drift_node_id AND n.kind = 'drift' AND n.deleted_at IS NULL)",
        [],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        },
    )? {
        tx.execute(
            "UPDATE timeline_marker SET drift_node_id = NULL WHERE id = ?1",
            [&id],
        )?;
        log.add(
            "pin-binding-missing-idea",
            &book,
            "timeline_marker",
            &id,
            "drift_node_id = NULL",
            Value::from(drift),
        );
    }
    Ok(())
}

/// Idea groups and material folders: a missing parent is the root, as 0.1
/// shows it; a cycle is broken at its member with the smallest id, as 0.1's
/// material folders break it (material-folder.ts:25-57).
fn trees(tx: &Connection, log: &mut Log) -> Result<()> {
    for (table, parent_col) in [
        ("drift_group", "parent_group_id"),
        ("material_folder", "parent_folder_id"),
    ] {
        let all: Vec<(String, String, Option<String>)> = rows(
            tx,
            &format!("SELECT id, project_id, {parent_col} FROM {table} ORDER BY id"),
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        let by_id: HashMap<&str, (&str, Option<&str>)> = all
            .iter()
            .map(|(id, book, parent)| (id.as_str(), (book.as_str(), parent.as_deref())))
            .collect();
        let mut cut: BTreeMap<String, (String, String, &'static str)> = BTreeMap::new();
        for (id, book, parent) in &all {
            let Some(p) = parent else { continue };
            if by_id.get(p.as_str()).is_none_or(|(b, _)| b != book) {
                cut.insert(
                    id.clone(),
                    (book.clone(), p.clone(), "source-tree-missing-parent"),
                );
            }
        }
        for (id, _, _) in &all {
            let mut path: Vec<&str> = Vec::new();
            let mut at = Some(id.as_str());
            while let Some(x) = at {
                if cut.contains_key(x) {
                    break;
                }
                if let Some(i) = path.iter().position(|p| *p == x) {
                    let cycle = &path[i..];
                    let smallest = cycle.iter().min().expect("cycle");
                    let (book, parent) = by_id[smallest];
                    cut.insert(
                        smallest.to_string(),
                        (
                            book.to_string(),
                            parent.unwrap_or("").to_string(),
                            "source-tree-cycle",
                        ),
                    );
                    break;
                }
                path.push(x);
                at = by_id.get(x).and_then(|(_, p)| *p);
            }
        }
        for (id, (book, parent, code)) in cut {
            tx.execute(
                &format!("UPDATE {table} SET {parent_col} = NULL WHERE id = ?1"),
                [&id],
            )?;
            log.add(
                code,
                &book,
                table,
                &id,
                &format!("{parent_col} = NULL"),
                Value::from(parent),
            );
        }
    }
    Ok(())
}

/// Category layouts: 0.1 uses a grid position only when the layout is
/// `pinned` and both coordinates are set, otherwise it places the category
/// itself (DesktopSuperElementView.tsx:505-513).
fn categories(tx: &Connection, log: &mut Log) -> Result<()> {
    for (id, book, layout, x, y) in rows(
        tx,
        "SELECT id, project_id, layout_mode, grid_x, grid_y FROM element_category",
        [],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<i64>>(3)?,
                r.get::<_, Option<i64>>(4)?,
            ))
        },
    )? {
        let original = serde_json::json!({"layoutMode": layout, "gridX": x, "gridY": y});
        let code = if layout != "auto" && layout != "pinned" {
            "unknown-category-layout"
        } else if layout == "pinned" && (x.is_none() || y.is_none()) {
            "incomplete-category-grid-position"
        } else if layout == "auto" && (x.is_some() || y.is_some()) {
            if x.is_some() != y.is_some() {
                "incomplete-category-grid-position"
            } else {
                "auto-category-has-grid-position"
            }
        } else {
            continue;
        };
        tx.execute(
            "UPDATE element_category SET layout_mode = 'auto', grid_x = NULL, grid_y = NULL WHERE id = ?1",
            [&id],
        )?;
        log.add(
            code,
            &book,
            "element_category",
            &id,
            "layout_mode = auto, no grid position",
            original,
        );
    }
    Ok(())
}

/// The projection columns 0.1 writes with `stringifyKv` / `encodeAliases`:
/// a malformed one reads as empty (`parseKv`), aliases keep their strings
/// (`decodeAliases`, book-element.ts:39-51). The rows of `entity_kv_entry`
/// are the facts; the projection only orders them, and without it they go
/// in creation order (their uuidv7 ids).
fn projections(tx: &Connection, log: &mut Log) -> Result<()> {
    for (table, col, key) in [
        ("project", "kv_json", "id"),
        ("project", "storyline_template_kv_json", "id"),
        ("element_category", "element_template_kv_json", "id"),
        ("element", "kv_json", "id"),
        ("storylines", "kv_json", "id"),
    ] {
        let book_col = if table == "project" {
            "id"
        } else {
            "project_id"
        };
        for (id, book, json) in rows(
            tx,
            &format!("SELECT {key}, {book_col}, {col} FROM {table}"),
            [],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            },
        )? {
            if valid_kv_json(&json) {
                continue;
            }
            tx.execute(
                &format!("UPDATE {table} SET {col} = '[]' WHERE {key} = ?1"),
                [&id],
            )?;
            log.add(
                "unreadable-source-kv-projection",
                &book,
                table,
                &id,
                &format!("{col} = []"),
                Value::from(json),
            );
        }
    }
    for (id, book, json) in rows(
        tx,
        "SELECT id, project_id, aliases_json FROM element",
        [],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        },
    )? {
        if serde_json::from_str::<Vec<String>>(&json).is_ok() {
            continue;
        }
        let kept: Vec<String> = serde_json::from_str::<Vec<Value>>(&json)
            .map(|v| {
                v.into_iter()
                    .filter_map(|a| a.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        tx.execute(
            "UPDATE element SET aliases_json = ?2 WHERE id = ?1",
            params![id, serde_json::to_string(&kept)?],
        )?;
        log.add(
            "unreadable-source-aliases",
            &book,
            "element",
            &id,
            &format!("aliases_json = {}", serde_json::to_string(&kept)?),
            Value::from(json),
        );
    }
    Ok(())
}

fn kv_rows(tx: &Connection) -> Result<Vec<KvRow>> {
    rows(
        tx,
        "SELECT id, project_id, owner_kind, owner_id, namespace, key, value FROM entity_kv_entry ORDER BY id",
        [],
        |r| {
            Ok(KvRow {
                id: r.get(0)?,
                project: r.get(1)?,
                owner_kind: r.get(2)?,
                owner: r.get(3)?,
                namespace: r.get(4)?,
                key: r.get(5)?,
                value: r.get(6)?,
            })
        },
    )
}

/// A deterministic replacement id for a key/value row whose id the book's
/// own fields use: nothing in 0.1 refers to a key/value row by id (values
/// follow their key), so every reference follows.
pub fn regenerated_kv_id(book: &str, old: &str) -> String {
    use sha2::{Digest, Sha256};
    let d = Sha256::digest(format!("drifting:import-v1:kv\0{book}\0{old}").as_bytes());
    format!(
        "import-kv-{}",
        d.iter()
            .take(16)
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    )
}

/// Category field templates and element values.
fn kv(tx: &Connection, log: &mut Log) -> Result<()> {
    let all = kv_rows(tx)?;
    let projection = |owner: &str| -> Result<String> {
        Ok(tx
            .query_row(
                "SELECT element_template_kv_json FROM element_category WHERE id = ?1",
                [owner],
                |r| r.get::<_, String>(0),
            )
            .optional()?
            .unwrap_or_else(|| "[]".into()))
    };
    let mut by_category: BTreeMap<(String, String), Vec<&KvRow>> = BTreeMap::new();
    for r in all
        .iter()
        .filter(|r| r.owner_kind == "element-category" && r.namespace == "element-template")
    {
        by_category
            .entry((r.project.clone(), r.owner.clone()))
            .or_default()
            .push(r);
    }
    let mut template_keys: HashMap<String, BTreeSet<String>> = HashMap::new();
    for ((book, category), list) in &by_category {
        let ordered = kv_rank(list, &projection(category)?);
        let mut seen = BTreeSet::new();
        for r in ordered {
            if !seen.insert(r.key.clone()) {
                // One field per name: the first one 0.1 lists is the field,
                // the others' values are kept in the receipt.
                tx.execute("DELETE FROM entity_kv_entry WHERE id = ?1", [&r.id])?;
                log.add(
                    "ambiguous-template-field",
                    book,
                    "entity_kv_entry",
                    &r.id,
                    "dropped (a field of this name comes first)",
                    serde_json::json!({"owner": category, "key": r.key, "value": r.value}),
                );
                continue;
            }
            if BUILT_IN_FIELD_IDS.contains(&r.id.as_str()) {
                let new = regenerated_kv_id(book, &r.id);
                tx.execute(
                    "UPDATE entity_kv_entry SET id = ?2 WHERE id = ?1",
                    params![r.id, new],
                )?;
                log.add(
                    "ambiguous-template-field",
                    book,
                    "entity_kv_entry",
                    &r.id,
                    &format!("id = {new}"),
                    Value::from(r.id.clone()),
                );
            }
        }
        template_keys.insert(category.clone(), seen);
    }
    // Two values of an element under one name its category has a field for:
    // the first one 0.1 lists fills the field, the others stay facts of the
    // element under the same name (`dr_samples::v3::sync_catalog`).
    let element_of: HashMap<String, (Option<String>, String)> = rows(
        tx,
        "SELECT id, category_id, kv_json FROM element",
        [],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                (r.get::<_, Option<String>>(1)?, r.get::<_, String>(2)?),
            ))
        },
    )?
    .into_iter()
    .collect();
    let mut by_element: BTreeMap<(String, String), Vec<&KvRow>> = BTreeMap::new();
    for r in all
        .iter()
        .filter(|r| r.owner_kind == "element" && r.namespace == "facts")
    {
        by_element
            .entry((r.project.clone(), r.owner.clone()))
            .or_default()
            .push(r);
    }
    for ((book, element), list) in by_element {
        let Some((Some(category), projection)) = element_of.get(&element) else {
            continue;
        };
        let Some(keys) = template_keys.get(category) else {
            continue;
        };
        let mut seen = BTreeSet::new();
        for r in kv_rank(&list, projection) {
            if keys.contains(&r.key) && !seen.insert(r.key.clone()) {
                log.add(
                    "duplicate-value-for-template-field",
                    &book,
                    "entity_kv_entry",
                    &r.id,
                    "kept as a fact of the element",
                    Value::Null,
                );
            }
        }
    }
    Ok(())
}

/// Writing days: one value per device and day in the book. A malformed day
/// or device key has no place to go and is dropped with its row kept here.
/// Several rows for one device and day (0.1 has no unique index on them)
/// are added up, as 0.1's heatmap adds them (writing-day-repo.ts:76-95).
fn writing_days(tx: &Connection, log: &mut Log) -> Result<()> {
    for (id, book, day, device, words) in rows(
        tx,
        "SELECT id, project_id, day, device_key, words FROM writing_day ORDER BY id",
        [],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
            ))
        },
    )? {
        if dr_model::id::DeviceKey::parse(&device).is_ok() && dr_model::Day::parse(&day).is_some() {
            continue;
        }
        tx.execute("DELETE FROM writing_day WHERE id = ?1", [&id])?;
        log.add(
            "writing-day-invalid",
            &book,
            "writing_day",
            &id,
            "dropped",
            serde_json::json!({"day": day, "deviceKey": device, "words": words}),
        );
    }
    for (book, day, device) in rows(
        tx,
        "SELECT project_id, day, device_key FROM writing_day GROUP BY project_id, day, device_key HAVING count(*) > 1",
        [],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        },
    )? {
        let dups: Vec<(String, i64)> = rows(
            tx,
            "SELECT id, words FROM writing_day WHERE project_id = ?1 AND day = ?2 AND device_key = ?3 ORDER BY id",
            params![book, day, device],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let total: i64 = dups.iter().map(|(_, w)| w).sum();
        let (kept, _) = &dups[0];
        tx.execute(
            "UPDATE writing_day SET words = ?2 WHERE id = ?1",
            params![kept, total],
        )?;
        for (id, words) in &dups {
            if id != kept {
                tx.execute("DELETE FROM writing_day WHERE id = ?1", [id])?;
            }
            log.add(
                "writing-day-duplicate",
                &book,
                "writing_day",
                id,
                &format!("added into {kept} ({total} words)"),
                serde_json::json!({"words": words}),
            );
        }
    }
    Ok(())
}

/// Snapshot history: a row is never a reason to stop. Its body version is
/// a history point whenever it has a preview; what of its metadata cannot be
/// replayed is left out and kept here.
fn history(tx: &Connection, log: &mut Log) -> Result<()> {
    let kinds: HashMap<String, String> = rows(tx, "SELECT id, kind FROM book_node", [], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?
    .into_iter()
    .collect();
    for (id, book, kind, entity, preview, meta) in rows(
        tx,
        "SELECT id, project_id, entity_kind, entity_id, content_json IS NOT NULL, meta_json FROM entity_snapshot_history ORDER BY id",
        [],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, bool>(4)?,
                r.get::<_, Option<String>>(5)?,
            ))
        },
    )? {
        // Whose body it is: 0.1 keeps the rows of what it deleted for good
        // (project-deletion-repo.ts:94-96); such a row has no body to be a
        // version of.
        let owner_sql = match kind.as_str() {
            "node" => "SELECT 1 FROM book_node WHERE id = ?1 AND project_id = ?2",
            "element" => "SELECT 1 FROM element WHERE id = ?1 AND project_id = ?2",
            "storyline" => "SELECT 1 FROM storylines WHERE id = ?1 AND project_id = ?2",
            "category" => "SELECT 1 FROM element_category WHERE id = ?1 AND project_id = ?2",
            "library_item" | "library-item" => {
                "SELECT 1 FROM library_item WHERE id = ?1 AND project_id = ?2 AND kind = 'text'"
            }
            _ => "SELECT 1 WHERE 0 AND ?1 AND ?2",
        };
        let owned = tx
            .query_row(owner_sql, params![entity, book], |_| Ok(()))
            .optional()?
            .is_some();
        if !owned {
            log.add(
                "orphan-history-source",
                &book,
                "entity_snapshot_history",
                &id,
                "skipped",
                Value::Null,
            );
            continue;
        }
        if !preview {
            // 0.1 lists it with no excerpt (EntitySnapshotHistoryModal.tsx:64-68);
            // with no preview there is no version to check out.
            log.add(
                "history-preview-missing",
                &book,
                "entity_snapshot_history",
                &id,
                "skipped",
                Value::Null,
            );
            continue;
        }
        let Some(meta) = meta else { continue };
        if meta_unreadable(&meta) {
            tx.execute(
                "UPDATE entity_snapshot_history SET meta_json = NULL WHERE id = ?1",
                [&id],
            )?;
            log.add(
                "unreadable-history-metadata",
                &book,
                "entity_snapshot_history",
                &id,
                "meta_json = NULL (the version is kept)",
                Value::from(meta),
            );
            continue;
        }
        let mut value: Value = serde_json::from_str(&meta)?;
        let mut changed = None;
        if let (Some(status), Some(node_kind)) = (
            value.get("writingStatus").and_then(Value::as_str),
            kinds.get(&entity),
        ) && kind == "node"
            && !dr_model::import_v1::NodeStatus::parse(status)
                .fits(&dr_model::import_v1::NodeKind::parse(node_kind))
        {
            value
                .as_object_mut()
                .expect("object")
                .remove("writingStatus");
            changed = Some("incompatible-history-node-status");
        }
        if let Some(text) = value.get("elementTemplateKvJson").and_then(Value::as_str) {
            let list: Vec<Value> = serde_json::from_str(text)?;
            let mut seen = BTreeSet::new();
            let kept: Vec<Value> = list
                .iter()
                .filter(|e| seen.insert(e["key"].as_str().unwrap_or("").to_string()))
                .cloned()
                .collect();
            if kept.len() != list.len() {
                value["elementTemplateKvJson"] = Value::from(serde_json::to_string(&kept)?);
                changed = Some("ambiguous-history-template-field");
            }
        }
        if let Some(code) = changed {
            tx.execute(
                "UPDATE entity_snapshot_history SET meta_json = ?2 WHERE id = ?1",
                params![id, value.to_string()],
            )?;
            log.add(
                code,
                &book,
                "entity_snapshot_history",
                &id,
                "metadata field left out (the version is kept)",
                Value::from(meta),
            );
        }
    }
    Ok(())
}

/// Cases the book takes as they are, recorded so the receipt says where the
/// import departed from a plain copy.
fn recorded_only(tx: &Connection, log: &mut Log) -> Result<()> {
    // A comment on something deleted for good: 0.1 keeps it and lists it
    // under 「已删除」 (review-groups.ts:136-165); the book keeps it on its
    // target, shown as unlocated.
    for (id, book) in rows(
        tx,
        "SELECT c.id, c.project_id FROM comment c WHERE c.target_kind IN ('node', 'element', 'category', 'storyline') AND c.target_id IS NOT NULL AND c.target_id <> '' AND NOT EXISTS (
            SELECT 1 FROM book_node WHERE id = c.target_id UNION ALL SELECT 1 FROM element WHERE id = c.target_id
            UNION ALL SELECT 1 FROM element_category WHERE id = c.target_id UNION ALL SELECT 1 FROM storylines WHERE id = c.target_id)",
        [],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
    )? {
        log.add("comment-target-missing", &book, "comment", &id, "kept on its missing target", Value::Null);
    }
    // Elements without a live category: under 「未分类」, as 0.1 lists them.
    for (id, book, category) in rows(
        tx,
        "SELECT e.id, e.project_id, e.category_id FROM element e WHERE e.category_id IS NULL OR NOT EXISTS (SELECT 1 FROM element_category c WHERE c.id = e.category_id AND c.deleted_at IS NULL)",
        [],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        },
    )? {
        log.add(
            "element-missing-category",
            &book,
            "element",
            &id,
            "under 未分类",
            Value::from(category),
        );
    }
    // Plot-grid lines whose position key is not one (sync's `pending`
    // placeholder): new keys in 0.1's order, key then id.
    for table in ["plot_grid_row", "plot_grid_column"] {
        for (id, book, pos) in rows(
            tx,
            &format!(
                "SELECT x.id, n.project_id, x.position_key FROM {table} x JOIN plot_grid_document d ON d.id = x.document_id JOIN book_node n ON n.id = d.node_id"
            ),
            [],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            },
        )? {
            if dr_model::pos::PosKey::parse(&pos).is_err() {
                log.add(
                    "plot-grid-position-key-regenerated",
                    &book,
                    table,
                    &id,
                    "new position key, same order",
                    Value::from(pos),
                );
            }
        }
    }
    // A body template the import cannot read: no template document; the
    // raw text stays on the book (`template-unreadable`).
    for (table, col) in [
        ("element_category", "element_template_json"),
        ("storylines", "node_content_template_json"),
    ] {
        for (id, book, json) in rows(
            tx,
            &format!("SELECT id, project_id, {col} FROM {table} WHERE {col} IS NOT NULL"),
            [],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            },
        )? {
            if !json.trim().is_empty() && crate::prose::pm::parse(&json).is_err() {
                log.add(
                    "unreadable-source-template",
                    &book,
                    table,
                    &id,
                    "no template document",
                    Value::from(json),
                );
            }
        }
    }
    Ok(())
}
