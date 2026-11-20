//! The import's own records:
//!
//! ```text
//! <library>/library.sqlite             the receipt: import_run, import_book,
//!                                      import_doc, import_anchor, import_original
//!                                      (dr-store migration 0001, written through
//!                                      Library::local_transaction)
//! <library>/import-v1/receipt.sqlite   the read-only Agent archive and the
//!                                      device-local 0.1 state (settings, MCP
//!                                      servers, working memory, Markdown folder
//!                                      ledger, flags), until their modules take
//!                                      them over (F6, M30, M31, M32, M40)
//! <library>/import-v1/summary.md       the receipt, for the author
//! ```
//!
//! The archive stays a file of its own because it is copied from the
//! staging database with `ATTACH`, which SQLite does not allow inside the
//! library's transactions. Everything here is device-local.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, params};
use serde::Serialize;

use crate::anchors::Resolution;
use crate::error::Result;
use crate::gate::Gate;
use crate::legacy::{Freshness, ProseKind};
use crate::prose::Notes;

pub const DIRECTORY: &str = "import-v1";
pub const DATABASE: &str = "receipt.sqlite";
pub const SUMMARY: &str = "summary.md";

/// Tables copied as they are into the archive (the 0.1 names prefixed).
pub const AGENT_ARCHIVE: &[&str] = &[
    "agent_conversation",
    "agent_runtime_session",
    "agent_runtime_turn",
    "agent_runtime_message",
    "agent_runtime_tool_call",
    "agent_runtime_result_artifact",
    "agent_runtime_result_blob",
];

/// Device-local 0.1 tables kept until their module takes them over.
pub const LOCAL: &[&str] = &[
    "agent_mcp_server",
    "agent_working_memory",
    "library_state",
    "markdown_mirror_file",
];

pub fn directory(root: &Path) -> PathBuf {
    root.join(DIRECTORY)
}

/// One imported prose body.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocRecord {
    pub doc_id: String,
    pub old_doc_id: String,
    pub book_id: String,
    pub kind: ProseKind,
    pub freshness: Freshness,
    pub revision: Option<i64>,
    pub cache_sha256: Option<String>,
    /// Snapshot-history versions replayed before the current body.
    pub history_versions: usize,
    pub paragraphs: usize,
    pub chars: usize,
    /// The stored body read back equals the plan.
    pub stored_exactly: bool,
    /// Exported and imported again, the body is the same.
    pub round_trips: bool,
    /// Block ids the dr-doc repair rewrote (duplicates in the 0.1 data).
    pub repaired_block_ids: usize,
    pub notes: Notes,
    pub dropped_inline: Vec<String>,
}

/// One anchor.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorRecord {
    pub entity: &'static str,
    pub id: String,
    pub doc_id: String,
    pub resolution: Resolution,
    /// The cursor pair was made and resolves to the intended range.
    pub cursor: bool,
}

/// A 0.1 `entityLink` pointing to an image or PDF material that has no file:
/// there is nothing to link to, so the words stay as plain text
/// (`kernel-v5.md` §13; a link to a material with a file points at it).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlinkedAssetLink {
    pub doc_id: String,
    pub old_doc_id: String,
    pub material_id: String,
    pub material_title: String,
    pub text: String,
}

fn is_zero(n: &usize) -> bool {
    *n == 0
}

/// A 0.1 `note-task` TODO whose status disagreed with its checklist item's
/// tick, so the imported comment followed the tick (`kernel-v5.md` §13).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStatusChange {
    pub comment_id: String,
    pub old_doc_id: String,
    pub body: String,
    pub checked: bool,
}

/// Something of the 0.1 materials that has no counterpart in the new book.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum MaterialDropped {
    /// A material folder that held nothing (no material, no folder with one).
    EmptyFolder { folder_id: String, name: String },
    /// A material folder whose materials (directly or below) all failed to
    /// come over (for example, missing files or unknown kinds).
    UnimportedFolder { folder_id: String, name: String },
    /// An image or PDF material whose file is not in the 0.1 library: its
    /// title, its description (if any, since there is no file to attach a
    /// comment to), and the relations and comments that pointed at it.
    WithoutFile {
        material_id: String,
        material_title: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        relations: Vec<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        comments: Vec<String>,
    },
    /// A material of a kind this version does not know.
    UnknownKind {
        material_id: String,
        material_title: String,
        material_kind: String,
    },
    /// A second material on the same file: one file in the library, named
    /// after the first; this one's title is not kept.
    SameFile {
        material_id: String,
        material_title: String,
        kept_title: String,
        asset_id: String,
    },
}

/// One book.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookRecord {
    pub book_id: String,
    pub name: String,
    /// `imported`, or why not.
    pub status: String,
    pub trashed: bool,
    /// Rows read, by 0.1 table.
    pub rows: BTreeMap<String, usize>,
    pub notes: Notes,
    pub bodies: usize,
    pub history_points: usize,
    /// History rows whose metadata (title, summary, …) was replayed into
    /// the book document, and of those, how many hold at their point.
    pub history_meta_replayed: usize,
    pub history_meta_checked: usize,
    pub assets_copied: usize,
    pub assets_missing: usize,
    pub assets_mismatched: usize,
    /// The 0.1 assets of [`Self::assets_missing`] and
    /// [`Self::assets_mismatched`], by id: their records came over, their
    /// bytes did not.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub asset_files_missing: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub asset_files_mismatched: Vec<String>,
    /// A second 0.1 asset with the bytes of an earlier one is that earlier
    /// file (`kernel-v5.md` §11): merged asset id → the id kept.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub merged_assets: BTreeMap<String, String>,
    pub projected_todos: usize,
    pub anchors_with_cursors: usize,
    pub anchors_without_cursors: usize,
    /// 0.1 body templates (a category's element template, a storyline's
    /// chapter template) written into their template documents.
    pub templates: usize,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub task_status_changes: Vec<TaskStatusChange>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unlinked_asset_links: Vec<UnlinkedAssetLink>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub material_assets: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub non_text_materials: BTreeMap<String, String>,
    /// 0.1 material descriptions and provenances converted into resolved
    /// manual comments (`kernel-v5.md` §15 #19).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub material_descriptions_to_comments: usize,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub material_provenances_to_comments: usize,
    /// What of the 0.1 materials did not come over, one line each.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub materials_dropped: Vec<MaterialDropped>,
    /// What the import's defaults did for this book (`crate::defaults`),
    /// one line per row.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub adjustments: Vec<crate::defaults::Adjustment>,
}

/// Everything one import did.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub importer: &'static str,
    pub started_ms: i64,
    pub finished_ms: i64,
    pub source_sha256: String,
    pub source_bytes: u64,
    pub schema_level_before: usize,
    pub gate: Gate,
    pub accepted: crate::gate::Accept,
    pub books: Vec<BookRecord>,
    pub docs: Vec<DocRecord>,
    pub anchors: Vec<AnchorRecord>,
    /// (collection, id, field, original JSON) of bodies kept as plain text and
    /// legacy relation metadata preserved for future reference.
    pub originals: Vec<(String, String, String, String)>,
    pub orphan_yjs_docs: usize,
    pub archived_rows: BTreeMap<String, i64>,
    pub local_rows: BTreeMap<String, i64>,
    pub installation_id_adopted: bool,
    /// `kept` (the default) or `thinned`: whether the history points brought
    /// from 0.1 are exempt from the 30-day retention.
    pub history_retention: &'static str,
    /// Stopped before the end (`run::Cancel`): books not started are
    /// `cancelled`; one stopped while it was written stays `importing`, and
    /// the next import carries it on.
    pub cancelled: bool,
}

/// The archive's own table (the other archive tables are copies).
const ARCHIVE_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS local_setting (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
) STRICT;
";

fn kebab<T: Serialize>(v: &T) -> String {
    serde_json::to_value(v)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

fn json<T: Serialize>(v: &T) -> rusqlite::Result<String> {
    serde_json::to_string(v).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))
}

/// What the receipt knows when an import starts.
pub struct RunStart<'a> {
    pub started_ms: i64,
    /// Where the 0.1 library is on this device: its database and data root.
    /// Recorded in the run's `summary_json` (`source`) when it begins, so a
    /// book left `importing` can be carried on from the same library
    /// ([`unfinished`]). The receipt tables are device-local; nothing else
    /// keeps a path.
    pub source_database: &'a Path,
    pub source_root: Option<&'a Path>,
    pub source_sha256: &'a str,
    pub source_bytes: u64,
    pub schema_level_before: usize,
    pub gate: &'a Gate,
    pub accepted: crate::gate::Accept,
}

/// Open this import's run in the library's receipt tables (dr-store `0001`),
/// before anything is written: a book whose row still says `importing`
/// later was interrupted on this device. Returns the run's id.
pub fn begin_run(tx: &rusqlite::Transaction<'_>, start: &RunStart<'_>) -> rusqlite::Result<i64> {
    let source = serde_json::json!({
        "source": {
            "database": start.source_database.to_string_lossy(),
            "root": start.source_root.map(|r| r.to_string_lossy()),
        }
    });
    tx.execute(
        "INSERT INTO import_run (importer, started_ms, finished_ms, source_sha256, source_bytes, schema_level_before, gate_json, accepted_json, summary_json) VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            crate::run::IMPORTER,
            start.started_ms,
            start.source_sha256,
            start.source_bytes as i64,
            start.schema_level_before as i64,
            json(start.gate)?,
            json(&start.accepted)?,
            json(&source)?,
        ],
    )?;
    Ok(tx.last_insert_rowid())
}

/// Mark `book` as being imported by run `run` (before its first document
/// is stored).
pub fn begin_book(
    tx: &rusqlite::Transaction<'_>,
    run: i64,
    book: &str,
    name: &str,
) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT OR REPLACE INTO import_book VALUES (?1, ?2, ?3, 'importing', '{}')",
        params![run, book, name],
    )?;
    Ok(())
}

/// What earlier imports on this device did with `book`: (finished it,
/// started it and were interrupted).
pub fn book_state(conn: &Connection, book: &str) -> rusqlite::Result<(bool, bool)> {
    conn.query_row(
        "SELECT coalesce(max(status = 'imported'), 0), coalesce(max(status = 'importing'), 0) FROM import_book WHERE book_id = ?1",
        [book],
        |r| Ok((r.get::<_, bool>(0)?, r.get::<_, bool>(1)?)),
    )
}

/// A book an import on this device started and never finished: the app quit
/// or stopped while it was written. Importing the same 0.1 library again
/// carries it on ([`book_state`] says so to the import).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Unfinished {
    pub book_id: String,
    /// The book's name when it was imported.
    pub name: String,
    /// The 0.1 library it came from, as the latest run that started it
    /// recorded ([`RunStart`]); `None` from a run that recorded none.
    pub database: Option<PathBuf>,
    pub root: Option<PathBuf>,
}

/// The books this device's imports left unfinished (`importing` and never
/// `imported`), the most recently started first.
pub fn unfinished(conn: &Connection) -> rusqlite::Result<Vec<Unfinished>> {
    let mut stmt = conn.prepare(
        "SELECT b.book_id, b.name, r.summary_json FROM import_book b JOIN import_run r ON r.id = b.run_id
         WHERE b.status = 'importing'
           AND NOT EXISTS (SELECT 1 FROM import_book d WHERE d.book_id = b.book_id AND d.status = 'imported')
         ORDER BY b.run_id DESC, b.book_id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for row in rows {
        let (book_id, name, summary) = row?;
        if !seen.insert(book_id.clone()) {
            continue;
        }
        let summary: serde_json::Value = serde_json::from_str(&summary).unwrap_or_default();
        let path = |key: &str| {
            summary["source"][key]
                .as_str()
                .filter(|p| !p.is_empty())
                .map(PathBuf::from)
        };
        out.push(Unfinished {
            book_id,
            name,
            database: path("database"),
            root: path("root"),
        });
    }
    Ok(out)
}

/// Finish run `run` in the library's receipt tables (dr-store `0001`), in
/// the transaction `tx` (from `Library::local_transaction`). (A JSON error
/// surfaces as a SQLite conversion error, so the transaction's error type
/// stays dr-store's.)
pub fn write_records(
    tx: &rusqlite::Transaction<'_>,
    run: i64,
    receipt: &Receipt,
) -> rusqlite::Result<()> {
    // Merged into what `begin_run` recorded (the source).
    tx.execute(
        "UPDATE import_run SET finished_ms = ?2, summary_json = json_patch(summary_json, ?3) WHERE id = ?1",
        params![
            run,
            receipt.finished_ms,
            json(&serde_json::json!({
                "orphanYjsDocs": receipt.orphan_yjs_docs,
                "archivedRows": receipt.archived_rows,
                "localRows": receipt.local_rows,
                "installationIdAdopted": receipt.installation_id_adopted,
                "historyRetention": receipt.history_retention,
                "cancelled": receipt.cancelled,
            }))?,
        ],
    )?;
    {
        let mut book =
            tx.prepare("INSERT OR REPLACE INTO import_book VALUES (?1, ?2, ?3, ?4, ?5)")?;
        for b in &receipt.books {
            book.execute(params![run, b.book_id, b.name, b.status, json(b)?])?;
        }
        let mut doc = tx.prepare(
            "INSERT INTO import_doc VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        )?;
        for d in &receipt.docs {
            doc.execute(params![
                run,
                d.doc_id,
                d.old_doc_id,
                d.book_id,
                kebab(&d.freshness),
                d.revision,
                d.cache_sha256,
                d.history_versions as i64,
                d.stored_exactly,
                d.round_trips,
                json(d)?
            ])?;
        }
        let mut anchor =
            tx.prepare("INSERT OR REPLACE INTO import_anchor VALUES (?1, ?2, ?3, ?4, ?5, ?6)")?;
        for a in &receipt.anchors {
            anchor.execute(params![
                run,
                a.entity,
                a.id,
                a.doc_id,
                kebab(&a.resolution),
                a.cursor
            ])?;
        }
        let mut original =
            tx.prepare("INSERT OR REPLACE INTO import_original VALUES (?1, ?2, ?3, ?4, ?5)")?;
        for (c, id, f, json) in &receipt.originals {
            original.execute(params![run, c, id, f, json])?;
        }
    }
    Ok(())
}

/// Copy the read-only Agent archive and the device-local 0.1 state from the
/// staging copy `staged` into `<library>/import-v1/receipt.sqlite`, and
/// write the author's summary beside it.
pub fn write_archive(
    root: &Path,
    staged: &Path,
    receipt: &Receipt,
    settings: &BTreeMap<String, String>,
) -> Result<PathBuf> {
    let dir = directory(root);
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(DATABASE);
    let conn = Connection::open(&path)?;
    conn.execute_batch(ARCHIVE_SCHEMA)?;
    conn.execute("ATTACH DATABASE ?1 AS old", [staged.to_string_lossy()])?;
    let tx = conn.unchecked_transaction()?;
    // The 0.1 rows as they are.
    for (prefix, tables) in [("archive_", AGENT_ARCHIVE), ("local_", LOCAL)] {
        for t in tables {
            tx.execute_batch(&format!(
                "DROP TABLE IF EXISTS main.{prefix}{t}; CREATE TABLE main.{prefix}{t} AS SELECT * FROM old.{t};"
            ))?;
        }
    }
    for (k, v) in settings {
        tx.execute(
            "INSERT OR REPLACE INTO local_setting VALUES (?1, ?2)",
            params![k, v],
        )?;
    }
    tx.commit()?;
    conn.execute("DETACH DATABASE old", [])?;
    let summary = dir.join(SUMMARY);
    std::fs::write(&summary, summary_zh(receipt))?;
    Ok(path)
}

/// What a default of `crate::defaults` did, in plain words.
fn adjusted(code: &str) -> Option<&'static str> {
    Some(match code {
        "element-missing-category" => {
            "没有分类（或分类已删除）的要素放进「要素」下的「未分类」，和旧版一样"
        }
        "chapter-without-book-order" => "没有书序的章节按旧版的读法排在最前（书序 0）",
        "idea-has-legacy-book-order" => "构想身上的书序旧版不用，没有带过来",
        "unknown-node-kind" => "旧版不认识种类的章节按构想导入，和旧版一样",
        "incompatible-source-node-status" => {
            "和种类对不上的写作状态换成这一种的默认状态，和旧版显示的一样"
        }
        "chapter-in-group-dropped" => "章节身上的构想分组旧版不用，没有带过来",
        "idea-group-missing" => "所在分组已不存在的构想放在构想的最外层，和旧版一样",
        "membership-target-missing" => "指向已不存在的章节或故事线的归属没有地方挂，没有带过来",
        "membership-target-trashed" => "已删除的故事线上的归属照留，故事线恢复时章节一起回来",
        "multiple-primary-memberships" => "有几条主故事线时，按旧版留最后一条，其余仍是故事线",
        "act-binding-not-an-idea" => "绑在章节上的幕按旧版当作没有绑构想",
        "act-without-boundary" => "没有起点的幕按旧版当作全书第一幕",
        "duplicate-act-boundary" => "起点相同的几幕按旧版照原样导入",
        "pin-binding-missing-idea" => "时间钉绑的构想已不在或在最近删除里，时间钉留着、不再绑",
        "source-tree-missing-parent" => "上级已不存在的分组、素材夹放到最外层，和旧版一样",
        "source-tree-cycle" => "互为上级的分组、素材夹在 id 最小的那一个断开，放到最外层",
        "unknown-category-layout"
        | "incomplete-category-grid-position"
        | "auto-category-has-grid-position" => "分类的摆放方式不完整时按旧版当作自动摆放",
        "unreadable-source-kv-projection" => "读不出来的字段顺序记录按建立先后排",
        "unreadable-source-aliases" => "读不出来的别名列表只留能读的",
        "ambiguous-template-field" => "分类模板里同名的字段只留旧版列在前面的那一个",
        "duplicate-value-for-template-field" => {
            "同名字段的几个值，第一个进字段，其余作为条目自己的键值留下"
        }
        "duplicate-history-value-for-template-field" => {
            "快照历史里同名字段的几个值，第一个进字段，其余作为键值留下"
        }
        "writing-day-invalid" => "日期或设备读不出来的写作日没有地方放，没有带过来",
        "writing-day-duplicate" => "同一台设备同一天的几行写作日加在一起，和旧版热力图一样",
        "history-preview-missing" => "没有预览的快照历史没法检出，跳过",
        "history-preview-unreadable" => "预览读不出来的快照历史没法检出，跳过",
        "orphan-history-source" => "所属对象已彻底删除的快照历史跳过",
        "unreadable-history-metadata" => "快照历史里读不出来的标题等字段不回放，正文版本照留",
        "incompatible-history-node-status" => "快照历史里和种类对不上的写作状态不回放",
        "ambiguous-history-template-field" => "快照历史里同名的模板字段只留第一个",
        "comment-target-missing" => "所属对象已彻底删除的批注照留，显示为找不到位置",
        "plot-grid-position-key-regenerated" => "情节规划里坏掉的位置键按旧版的顺序重新生成",
        "unreadable-source-template" => "读不出来的正文模板不写成模板，原文留在书目里",
        "invalid-source-entity-link" | "unsupported-entity-link-target-kind" => {
            "指不到条目的人物链接去掉链接，字留着"
        }
        "unsupported-table-cell-mark" => "表格格子里新版不认识的格式去掉，字留着",
        "unsupported-table-cell-content" => "表格格子里的列表、标题等只留文字",
        _ => return None,
    })
}

/// What a lossy normalisation means, in plain words (`m10-import.md` has
/// the full list). Keys not listed are lossless bookkeeping.
fn explain(key: &str) -> Option<&'static str> {
    Some(match key {
        k if k.starts_with("unknown-inline:") => {
            "正文里有新版不认识的行内对象，已从正文里去掉，原样记在回执里"
        }
        k if k.starts_with("unknown-mark:") => "有新版不认识的文字格式，文字保留，格式去掉",
        k if k.starts_with("unknown-block:") || k.starts_with("unknown-atom:") => {
            "有新版不认识的段落类型，按普通段落导入"
        }
        k if k.starts_with("comment-action-dropped:") => {
            "已退役的 Copilot 批注动作（采纳 / 拒绝）不再导入"
        }
        "list-item-extra-paragraph" => "一个列表项里有好几段，新版每段是一项",
        "table-header-cell" => "表格的表头格按普通格导入",
        "table-cell-marks" => "表格格子里的文字格式没有保留（新版格子只存文字）",
        "table-cell-span" => "表格的合并单元格和列宽没有保留",
        "table-cell-paragraphs-joined" => "表格格子里的几段合成一段，中间用段内换行",
        "ordered-list-start" => "编号列表的起始编号没有保留",
        "align-unsupported" => "两端对齐按左对齐导入",
        "comment-body-formatting-kept-as-text"
        | "patch-body-formatting-kept-as-text"
        | "material-description-formatting-kept-as-text" => {
            "批注、补丁或素材描述里的格式按纯文字导入，原文记在回执里"
        }
        "entity-link-same-target-overlap" => {
            "同一段文字上有两条指向同一对象、但范围不同的链接，保留了后一条"
        }
        "template-unreadable" => "有模板读不出来，没有导入（旧的字段原样留着）",
        "material-embed-dropped" => "素材嵌入找不到对应的素材，按空段落导入",
        "comment-priority-dropped" => "批注的优先级没有导入（批注不再分优先级）",
        "heading-level-clamped" | "indent-clamped" => "标题层级或缩进超出范围，已收进 H1–H3、0–8",
        "built-in-relation-type-dropped" => "内置的「关联」类型没有导入",
        // Each relation not brought over is counted once, under the first
        // of its ends that cannot come (the source end first); each is in
        // the receipt's originals (`relations`, `dropped`).
        "relation-image-end-dropped" => "一头是图片的关系没有导入",
        "relation-pdf-end-dropped" => "一头是 PDF 的关系没有导入",
        "relation-comment-end-dropped" => "一头是批注的关系没有导入",
        "relation-todo-end-dropped" => "一头是待办的关系没有导入",
        "relation-patch-end-dropped" => "一头是补丁的关系没有导入",
        "relation-other-end-dropped" => "一头是其他素材的关系没有导入",
        "act-binding-shared-idea-split" => {
            "同一个构想绑了多个幕：最早的一幕沿用该构想，其余各幕在「幕」下新建了同名条目"
        }
        "act-binding-kept-existing-placement" => {
            "幕绑定的构想在默认时间线视图里原本就有位置，保留了原位置而未用幕跨度覆盖"
        }
        "entity-link-to-asset-kept-as-text" => {
            "正文中指向图片或 PDF 素材的链接，素材没有文件、无处可链，已转为普通文字，逐条列在下方"
        }
        "task-todo-link-replaced-by-projection" => {
            "清单项不再单独链接旧版待办，保留自身的勾选并对应为清单批注"
        }
        "task-status-follows-tick" => {
            "清单项关联的待办状态与勾选不一致，已按清单项的勾选为准，逐条列在下方"
        }
        _ => return None,
    })
}

fn inline_md(s: &str) -> String {
    let trimmed = s.trim_matches(|c| c == '\r' || c == '\n');
    let mut out = String::with_capacity(trimmed.len());
    let mut chars = trimmed.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\r' {
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            out.push_str(" ↵ ");
        } else if c == '\n' {
            out.push_str(" ↵ ");
        } else {
            out.push(c);
        }
    }
    out
}

fn inline_code(s: &str) -> String {
    inline_md(s).replace('`', "'")
}

fn freshness_zh(f: Freshness) -> &'static str {
    match f {
        Freshness::SeedOnly => "从没打开过，缓存就是正文",
        Freshness::CreationSeed => "建好后没改过",
        Freshness::NodeBasisCurrent => "字数依据和缓存同版",
        Freshness::Handoff => "交接时核对过",
        Freshness::HandoffMismatch => "交接核对后缓存又被改过",
        Freshness::NodeBasisBehind => "缓存确定比正文旧",
        Freshness::Unproven => "无法证明是最新",
    }
}

/// The author's summary (Chinese; the app will render the receipt in the
/// author's language once dr-i18n exists).
pub fn summary_zh(r: &Receipt) -> String {
    let mut s = String::new();
    s.push_str("# 旧书导入摘要\n\n");
    s.push_str(&format!(
        "- 旧库：SHA-256 `{}`，{} 字节；原库没有被改动。\n",
        &r.source_sha256[..12.min(r.source_sha256.len())],
        r.source_bytes
    ));
    s.push_str(&format!(
        "- 交接：{}。\n",
        if r.gate.handed_off {
            "旧版最后一版交接过"
        } else {
            "没有经过旧版最后一版的交接"
        }
    ));
    let doubtful: Vec<&DocRecord> = r
        .docs
        .iter()
        .filter(|d| !d.freshness.proven_fresh())
        .collect();
    if doubtful.is_empty() {
        s.push_str("- 每一篇正文都能证明是最新的，导入一字不差。\n");
    } else {
        s.push_str(&format!(
            "- 有 {} 篇正文无法证明是最新，照旧版的缓存导入，可能少了最后几秒打的字：\n",
            doubtful.len()
        ));
        for d in &doubtful {
            s.push_str(&format!(
                "  - `{}`（{}）\n",
                d.old_doc_id,
                freshness_zh(d.freshness)
            ));
        }
    }
    s.push('\n');
    for b in &r.books {
        s.push_str(&format!("## {}\n\n", inline_md(&b.name)));
        if b.status != "imported" {
            let why = match b.status.as_str() {
                "cancelled" => "导入取消了，这本书还没开始",
                "importing" => "导入中途停下，这本书只写了一部分；再导入一次这个库会接着导完",
                "already-imported" => "这台设备以前导入过",
                "already-in-library" => "新库里已经有这本书（从别的设备同步来的，或在新版里建的）",
                other => other,
            };
            s.push_str(&format!("没有导入：{why}。\n\n"));
            continue;
        }
        if b.trashed {
            s.push_str("这本书在最近删除里，导入后仍在最近删除里。\n\n");
        }
        let n = |t: &str| b.rows.get(t).copied().unwrap_or(0);
        s.push_str(&format!(
            "旧库里有 {} 个章节和构想、{} 个要素、{} 个分类、{} 条故事线、{} 条关系、{} 条批注和待办、{} 个补丁、{} 个素材；共导入 {} 篇正文、{} 个历史点、{} 个资源文件。\n\n",
            n("book_node"),
            n("element"),
            n("element_category"),
            n("storylines"),
            n("entity_relation"),
            n("comment"),
            n("element_patch"),
            n("library_item"),
            b.bodies,
            b.history_points,
            b.assets_copied
        ));
        s.push_str(
            "旧版笔记归入「文本素材」层级下的条目，图片和 PDF 进素材库里同名的素材夹，正文中指向图片和 PDF 的链接转为指向文件的链接；故事线转为关着「层级」、开着「收别处的条目」的条目；待办转为批注（不带优先级），正文清单项均同步为清单批注。\n\n",
        );
        if b.templates > 0 {
            s.push_str(&format!(
                "{} 份旧版正文模板写成了条目模板的初始正文，新建条目照它开头。\n\n",
                b.templates
            ));
        }
        if b.history_meta_replayed > 0 {
            s.push_str("旧版快照历史里当时的标题、梗概等也一起搬了过来：从历史点恢复一个对象时，这些也会恢复。\n\n");
        }
        if b.assets_missing + b.assets_mismatched > 0 {
            s.push_str(&format!(
                "有 {} 个资源文件找不到、{} 个和记录的哈希对不上，没有导入。\n\n",
                b.assets_missing, b.assets_mismatched
            ));
        }
        if b.anchors_without_cursors > 0 {
            s.push_str(&format!(
                "有 {} 条批注或补丁锚住的段落已经不在，批注保留，卡片显示原文。\n\n",
                b.anchors_without_cursors
            ));
        }
        if !b.adjustments.is_empty() {
            let mut by_code: BTreeMap<&str, usize> = BTreeMap::new();
            for a in &b.adjustments {
                *by_code.entry(a.code.as_str()).or_default() += 1;
            }
            s.push_str(
                "旧库里新版不能照原样收下的地方，导入替你这样处理了（原值都记在回执里）：\n\n",
            );
            for (code, count) in by_code {
                let e = adjusted(code).unwrap_or("照原样导入，记在回执里");
                s.push_str(&format!("- {e}（{count} 处，`{code}`）\n"));
            }
            s.push('\n');
        }
        let lossy: Vec<(&str, usize, &str)> = b
            .notes
            .0
            .iter()
            .filter_map(|(k, v)| explain(k).map(|e| (k.as_str(), *v, e)))
            .collect();
        if !lossy.is_empty() {
            s.push_str("和旧版不完全一样的地方：\n\n");
            for (k, v, e) in lossy {
                s.push_str(&format!("- {e}（{v} 处，`{k}`）\n"));
            }
            s.push('\n');
        }
        if !b.task_status_changes.is_empty() {
            s.push_str("按清单项勾选调整了状态的待办明细：\n\n");
            for item in &b.task_status_changes {
                let (tick_str, status_str) = if item.checked {
                    ("已勾选", "已解决")
                } else {
                    ("未勾选", "未解决")
                };
                s.push_str(&format!(
                    "- `{}` 中「{}」（`{}`）：清单项{}，状态已按勾选设为{}\n",
                    inline_code(&item.old_doc_id),
                    inline_md(&item.body),
                    inline_code(&item.comment_id),
                    tick_str,
                    status_str
                ));
            }
            s.push('\n');
        }
        if !b.unlinked_asset_links.is_empty() {
            s.push_str("已转为普通文字的图片 / PDF 素材链接明细（素材没有文件）：\n\n");
            for item in &b.unlinked_asset_links {
                s.push_str(&format!(
                    "- `{}` 中「{}」→ 原素材「{}」（`{}`）\n",
                    inline_code(&item.old_doc_id),
                    inline_md(&item.text),
                    inline_md(&item.material_title),
                    inline_code(&item.material_id)
                ));
            }
            s.push('\n');
        }
        if b.material_descriptions_to_comments + b.material_provenances_to_comments > 0 {
            s.push_str(&format!(
                "旧版素材上的 {} 条说明、{} 条出处已转为已解决的批注（原始记录留在回执里）。\n\n",
                b.material_descriptions_to_comments, b.material_provenances_to_comments
            ));
        }
        let not_imported: Vec<&MaterialDropped> = b
            .materials_dropped
            .iter()
            .filter(|d| !matches!(d, MaterialDropped::SameFile { .. }))
            .collect();
        if !not_imported.is_empty() {
            s.push_str("旧版素材里没有带过来的：\n\n");
            for d in not_imported {
                let line = match d {
                    MaterialDropped::EmptyFolder { folder_id, name } => format!(
                        "空的素材夹「{}」（`{}`）",
                        inline_md(name),
                        inline_code(folder_id)
                    ),
                    MaterialDropped::UnimportedFolder { folder_id, name } => format!(
                        "里面的素材都没有带过来的素材夹「{}」（`{}`）",
                        inline_md(name),
                        inline_code(folder_id)
                    ),
                    MaterialDropped::WithoutFile {
                        material_id,
                        material_title,
                        description,
                        relations,
                        comments,
                    } => {
                        let mut l = format!(
                            "没有文件的素材「{}」（`{}`）",
                            inline_md(material_title),
                            inline_code(material_id)
                        );
                        if let Some(desc) = description {
                            l.push_str(&format!("，说明「{}」", inline_md(desc)));
                        }
                        let mut attached = Vec::new();
                        if !relations.is_empty() {
                            attached.push(format!(
                                "{} 条关系（{}）",
                                relations.len(),
                                relations
                                    .iter()
                                    .map(|r| format!("`{}`", inline_code(r)))
                                    .collect::<Vec<_>>()
                                    .join("、")
                            ));
                        }
                        if !comments.is_empty() {
                            attached.push(format!(
                                "{} 条批注（{}）",
                                comments.len(),
                                comments
                                    .iter()
                                    .map(|c| format!("`{}`", inline_code(c)))
                                    .collect::<Vec<_>>()
                                    .join("、")
                            ));
                        }
                        if !attached.is_empty() {
                            l.push_str(&format!("，连同指向它的 {}", attached.join("、")));
                        }
                        l
                    }
                    MaterialDropped::UnknownKind {
                        material_id,
                        material_title,
                        material_kind,
                    } => format!(
                        "不认识种类（`{}`）的素材「{}」（`{}`）",
                        inline_code(material_kind),
                        inline_md(material_title),
                        inline_code(material_id)
                    ),
                    MaterialDropped::SameFile { .. } => unreachable!(),
                };
                s.push_str(&format!("- {line}\n"));
            }
            s.push('\n');
        }
        let same_files: Vec<&MaterialDropped> = b
            .materials_dropped
            .iter()
            .filter(|d| matches!(d, MaterialDropped::SameFile { .. }))
            .collect();
        if !same_files.is_empty() {
            s.push_str("合并为同一个文件的旧版素材：\n\n");
            for d in same_files {
                if let MaterialDropped::SameFile {
                    material_id,
                    material_title,
                    kept_title,
                    ..
                } = d
                {
                    s.push_str(&format!(
                        "- 和「{}」是同一个文件的素材「{}」（`{}`）：素材库里只有一份，用了前者的名字\n",
                        inline_md(kept_title),
                        inline_md(material_title),
                        inline_code(material_id)
                    ));
                }
            }
            s.push('\n');
        }
    }
    s.push_str(
        "旧的帮手对话已只读搬过来，可以看、可以搜，不能接着聊；Agent 改动的结算记录留在旧库里。\n",
    );
    s
}
