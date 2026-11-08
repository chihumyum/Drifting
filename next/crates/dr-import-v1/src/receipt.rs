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
    pub projected_todos: usize,
    pub anchors_with_cursors: usize,
    pub anchors_without_cursors: usize,
    /// 0.1 body templates (a category's element template, a storyline's
    /// chapter template) written into their template documents.
    pub templates: usize,
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
    /// (collection, id, field, original JSON) of bodies kept as plain text.
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
        "template-unreadable" => "有模版读不出来，没有导入（旧的字段原样留着）",
        "material-embed-dropped" => "素材嵌入找不到对应的素材，按空段落导入",
        "heading-level-clamped" | "indent-clamped" => "标题层级或缩进超出范围，已收进 H1–H3、0–8",
        "built-in-relation-color-dropped" => "内置关系类型的颜色没有导入（它不能改）",
        _ => return None,
    })
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
        s.push_str(&format!("## {}\n\n", b.name));
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
            "导入了 {} 个章节和构想、{} 个要素、{} 个分类、{} 条故事线、{} 条关系、{} 条批注和待办、{} 个补丁、{} 个素材；{} 篇正文，{} 个历史点，{} 个资源文件。\n\n",
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
        if b.templates > 0 {
            s.push_str(&format!(
                "{} 个要素模版和章节模版写成了模版文档，新建的要素和章节照它开头。\n\n",
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
    }
    s.push_str(
        "旧的帮手对话已只读搬过来，可以看、可以搜，不能接着聊；Agent 改动的结算记录留在旧库里。\n",
    );
    s
}
