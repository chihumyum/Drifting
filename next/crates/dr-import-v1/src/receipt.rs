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
/// `agent_chat_branch` says which of a continued conversation's branches 0.1
/// listed (`agent_archive`).
pub const AGENT_ARCHIVE: &[&str] = &[
    "agent_chat_branch",
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
    /// History rows written as entry checkpoints (`crate::checkpoints`), and
    /// of those, how many read back as their row (`Options::verify_history`).
    pub history_checkpoints: usize,
    pub history_checkpoints_checked: usize,
    /// History rows with a body version that did not become an entry
    /// checkpoint: row id → why (`crate::checkpoints::ENTRY_MISSING`, …).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub history_without_checkpoint: BTreeMap<String, String>,
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
    /// 0.1's display and thumbnail copies carried with a source the new
    /// client cannot decode itself (`crate::copies`): asset id → the
    /// variants now in the library (`display`, `thumbnail`).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub asset_copies_carried: BTreeMap<String, Vec<String>>,
    /// Those copies wanted and not carried: asset id → variant → why
    /// (`crate::copies::why`). The new client makes them itself when it
    /// can (the material library, the first time the image is shown).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub asset_copies_missing: BTreeMap<String, BTreeMap<String, String>>,
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

// What differs from 0.1.
//
// summary.md says it in three blocks and one line, and the done dialog lists
// the same things (`m10-import.md` 「导入界面」, decisions 六 甲 / 七 甲):
// the asset files that did not come over, what the import's defaults did
// (`crate::defaults`), the lossy normalisations of the bodies, and the
// materials that did not come over. The sentences are dr-i18n's
// `import.v1.differences` in all nine languages; summary.md reads them in
// Simplified Chinese, so the dialog and the file say the same.

use dr_i18n::keys::import::v1::differences as k;
use dr_i18n::{I18n, Key, Locale, Platform};

/// Which part of summary.md a difference is in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Block {
    /// 「有 N 个资源文件找不到、M 个和记录的哈希对不上，没有导入。」
    Assets,
    /// 「旧库里新版不能照原样收下的地方，导入替你这样处理了」: one line per
    /// code of [`BookRecord::adjustments`].
    Defaults,
    /// 「和旧版不完全一样的地方」: one line per key of [`BookRecord::notes`]
    /// that has a sentence ([`lossy_sentence`]).
    Lossy,
    /// 「旧版素材里没有带过来的」: one line per material or folder.
    Materials,
}

/// One line of what differs from 0.1: a sentence with what it names, and
/// how many places it stands for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Difference {
    pub block: Block,
    pub sentence: Key,
    /// What its `{{name}}`, `{{kind}}`, `{{missing}}` and `{{mismatched}}`
    /// are.
    pub args: Vec<(&'static str, String)>,
    /// How many places: the count summary.md gives the line (「N 处」), the
    /// asset files missing and mismatched, one for a material or a folder.
    pub count: usize,
    /// Whether the count is said beside the sentence; the asset sentence
    /// says its numbers itself, and a material line is one place.
    pub counted: bool,
    /// The receipt's codes behind it (summary.md names each).
    pub codes: Vec<String>,
}

impl Difference {
    /// The sentence in `strings`' language, as summary.md says it.
    pub fn text(&self, strings: &I18n) -> String {
        self.say(self.sentence, strings)
    }

    /// The sentence as the done dialog says it: summary.md's, but for the
    /// two that end in 「逐条列在下方」, which the dialog says without that
    /// clause, having no list below them ([`dialog_sentence`]).
    pub fn dialog_text(&self, strings: &I18n) -> String {
        self.say(dialog_sentence(self.sentence), strings)
    }

    fn say(&self, sentence: Key, strings: &I18n) -> String {
        let args: Vec<dr_i18n::Arg<'_>> = self
            .args
            .iter()
            .map(|(name, value)| (*name, value as &dyn std::fmt::Display))
            .collect();
        strings.fmt(sentence, &args)
    }
}

/// The dialog's form of `sentence`: the two lossy sentences that point at
/// summary.md's lists below them (「逐条列在下方」) without that clause
/// (2026-11-21, the author's decision); any other sentence as it is.
pub fn dialog_sentence(sentence: Key) -> Key {
    if sentence == k::lossy::ENTITY_LINK_TO_ASSET_KEPT_AS_TEXT {
        k::lossy_dialog::ENTITY_LINK_TO_ASSET_KEPT_AS_TEXT
    } else if sentence == k::lossy::TASK_STATUS_FOLLOWS_TICK {
        k::lossy_dialog::TASK_STATUS_FOLLOWS_TICK
    } else {
        sentence
    }
}

/// summary.md's heading of the materials block (「旧版素材里没有带过来的」,
/// there followed by a colon); the done dialog says it above each book's
/// material lines.
pub const MATERIALS_HEADING: Key = k::MATERIALS_HEADING;

/// The sentence of a default of `crate::defaults` (its code); `None` for a
/// code this version has no sentence for (summary.md and the dialog then
/// say [`DEFAULT_FALLBACK`]).
pub fn default_sentence(code: &str) -> Option<Key> {
    Some(match code {
        "element-missing-category" => k::defaults::ELEMENT_MISSING_CATEGORY,
        "chapter-without-book-order" => k::defaults::CHAPTER_WITHOUT_BOOK_ORDER,
        "idea-has-legacy-book-order" => k::defaults::IDEA_HAS_LEGACY_BOOK_ORDER,
        "unknown-node-kind" => k::defaults::UNKNOWN_NODE_KIND,
        "incompatible-source-node-status" => k::defaults::INCOMPATIBLE_SOURCE_NODE_STATUS,
        "chapter-in-group-dropped" => k::defaults::CHAPTER_IN_GROUP_DROPPED,
        "idea-group-missing" => k::defaults::IDEA_GROUP_MISSING,
        "membership-target-missing" => k::defaults::MEMBERSHIP_TARGET_MISSING,
        "membership-target-trashed" => k::defaults::MEMBERSHIP_TARGET_TRASHED,
        "multiple-primary-memberships" => k::defaults::MULTIPLE_PRIMARY_MEMBERSHIPS,
        "act-binding-not-an-idea" => k::defaults::ACT_BINDING_NOT_AN_IDEA,
        "act-without-boundary" => k::defaults::ACT_WITHOUT_BOUNDARY,
        "duplicate-act-boundary" => k::defaults::DUPLICATE_ACT_BOUNDARY,
        "pin-binding-missing-idea" => k::defaults::PIN_BINDING_MISSING_IDEA,
        "source-tree-missing-parent" => k::defaults::SOURCE_TREE_MISSING_PARENT,
        "source-tree-cycle" => k::defaults::SOURCE_TREE_CYCLE,
        "unknown-category-layout"
        | "incomplete-category-grid-position"
        | "auto-category-has-grid-position" => k::defaults::CATEGORY_LAYOUT_INCOMPLETE,
        "unreadable-source-kv-projection" => k::defaults::UNREADABLE_SOURCE_KV_PROJECTION,
        "unreadable-source-aliases" => k::defaults::UNREADABLE_SOURCE_ALIASES,
        "ambiguous-template-field" => k::defaults::AMBIGUOUS_TEMPLATE_FIELD,
        "duplicate-value-for-template-field" => k::defaults::DUPLICATE_VALUE_FOR_TEMPLATE_FIELD,
        "duplicate-history-value-for-template-field" => {
            k::defaults::DUPLICATE_HISTORY_VALUE_FOR_TEMPLATE_FIELD
        }
        "writing-day-invalid" => k::defaults::WRITING_DAY_INVALID,
        "writing-day-duplicate" => k::defaults::WRITING_DAY_DUPLICATE,
        "history-preview-missing" => k::defaults::HISTORY_PREVIEW_MISSING,
        "history-preview-unreadable" => k::defaults::HISTORY_PREVIEW_UNREADABLE,
        "orphan-history-source" => k::defaults::ORPHAN_HISTORY_SOURCE,
        "unreadable-history-metadata" => k::defaults::UNREADABLE_HISTORY_METADATA,
        "incompatible-history-node-status" => k::defaults::INCOMPATIBLE_HISTORY_NODE_STATUS,
        "ambiguous-history-template-field" => k::defaults::AMBIGUOUS_HISTORY_TEMPLATE_FIELD,
        "comment-target-missing" => k::defaults::COMMENT_TARGET_MISSING,
        "plot-grid-position-key-regenerated" => k::defaults::PLOT_GRID_POSITION_KEY_REGENERATED,
        "unreadable-source-template" => k::defaults::UNREADABLE_SOURCE_TEMPLATE,
        "invalid-source-entity-link" | "unsupported-entity-link-target-kind" => {
            k::defaults::ENTITY_LINK_DROPPED
        }
        "unsupported-table-cell-mark" => k::defaults::UNSUPPORTED_TABLE_CELL_MARK,
        "unsupported-table-cell-content" => k::defaults::UNSUPPORTED_TABLE_CELL_CONTENT,
        _ => return None,
    })
}

/// What summary.md and the dialog say for a default this version has no
/// sentence for (「照原样导入，记在回执里」); every code of
/// `crate::defaults::CODES` has its own.
pub const DEFAULT_FALLBACK: Key = k::defaults::FALLBACK;

/// The retired in-app AI whose comment actions 0.1 kept: a name, not
/// translated, given to its sentence's `{{product}}` here, among the files
/// that may name it (`xtask` gate `retired`), not in the language tables.
const RETIRED_COMMENT_ACTIONS_OF: &str = "Copilot";

/// What a lossy sentence names (only the retired comment actions' one
/// names anything).
fn lossy_args(key: &str) -> Vec<(&'static str, String)> {
    if key.starts_with("comment-action-dropped:") {
        vec![("product", RETIRED_COMMENT_ACTIONS_OF.to_owned())]
    } else {
        Vec::new()
    }
}

/// The sentence of a lossy normalisation (a key of [`BookRecord::notes`];
/// `m10-import.md` has the full list). Keys without one are lossless
/// bookkeeping, in neither summary.md nor the dialog.
pub fn lossy_sentence(key: &str) -> Option<Key> {
    Some(match key {
        n if n.starts_with("unknown-inline:") => k::lossy::UNKNOWN_INLINE,
        n if n.starts_with("unknown-mark:") => k::lossy::UNKNOWN_MARK,
        n if n.starts_with("unknown-block:") || n.starts_with("unknown-atom:") => {
            k::lossy::UNKNOWN_BLOCK
        }
        n if n.starts_with("comment-action-dropped:") => k::lossy::COMMENT_ACTION_DROPPED,
        "list-item-extra-paragraph" => k::lossy::LIST_ITEM_EXTRA_PARAGRAPH,
        "table-header-cell" => k::lossy::TABLE_HEADER_CELL,
        "table-cell-marks" => k::lossy::TABLE_CELL_MARKS,
        "table-cell-span" => k::lossy::TABLE_CELL_SPAN,
        "table-cell-paragraphs-joined" => k::lossy::TABLE_CELL_PARAGRAPHS_JOINED,
        "ordered-list-start" => k::lossy::ORDERED_LIST_START,
        "align-unsupported" => k::lossy::ALIGN_UNSUPPORTED,
        "comment-body-formatting-kept-as-text"
        | "patch-body-formatting-kept-as-text"
        | "material-description-formatting-kept-as-text" => k::lossy::FORMATTING_KEPT_AS_TEXT,
        "entity-link-same-target-overlap" => k::lossy::ENTITY_LINK_SAME_TARGET_OVERLAP,
        "template-unreadable" => k::lossy::TEMPLATE_UNREADABLE,
        "material-embed-dropped" => k::lossy::MATERIAL_EMBED_DROPPED,
        "comment-priority-dropped" => k::lossy::COMMENT_PRIORITY_DROPPED,
        "heading-level-clamped" | "indent-clamped" => k::lossy::HEADING_OR_INDENT_CLAMPED,
        "built-in-relation-type-dropped" => k::lossy::BUILT_IN_RELATION_TYPE_DROPPED,
        // Each relation not brought over is counted once, under the first
        // of its ends that cannot come (the source end first); each is in
        // the receipt's originals (`relations`, `dropped`).
        "relation-image-end-dropped" => k::lossy::RELATION_IMAGE_END_DROPPED,
        "relation-pdf-end-dropped" => k::lossy::RELATION_PDF_END_DROPPED,
        "relation-comment-end-dropped" => k::lossy::RELATION_COMMENT_END_DROPPED,
        "relation-todo-end-dropped" => k::lossy::RELATION_TODO_END_DROPPED,
        "relation-patch-end-dropped" => k::lossy::RELATION_PATCH_END_DROPPED,
        "relation-other-end-dropped" => k::lossy::RELATION_OTHER_END_DROPPED,
        // An author's relation with the same thing at both ends, or with
        // nothing at one (the defaults round; its pair is in the receipt's
        // originals, `relations`, `dropped`).
        "relation-self-end-dropped" => k::lossy::RELATION_SELF_END_DROPPED,
        "relation-missing-entry-dropped" => k::lossy::RELATION_MISSING_ENTRY_DROPPED,
        "act-binding-shared-idea-split" => k::lossy::ACT_BINDING_SHARED_IDEA_SPLIT,
        "act-binding-kept-existing-placement" => k::lossy::ACT_BINDING_KEPT_EXISTING_PLACEMENT,
        "entity-link-to-asset-kept-as-text" => k::lossy::ENTITY_LINK_TO_ASSET_KEPT_AS_TEXT,
        "task-todo-link-replaced-by-projection" => k::lossy::TASK_TODO_LINK_REPLACED_BY_PROJECTION,
        "task-status-follows-tick" => k::lossy::TASK_STATUS_FOLLOWS_TICK,
        _ => return None,
    })
}

/// A material line of summary.md: its sentence, the material's (or
/// folder's) name, its kind for one of a kind this version does not know,
/// and its id. `None` for a second material on the same file, which came
/// over (summary.md lists those apart, not as missing).
fn material_line(d: &MaterialDropped) -> Option<(Key, &str, Option<&str>, &str)> {
    Some(match d {
        MaterialDropped::EmptyFolder { folder_id, name } => {
            (k::material::EMPTY_FOLDER, name, None, folder_id)
        }
        MaterialDropped::UnimportedFolder { folder_id, name } => {
            (k::material::UNIMPORTED_FOLDER, name, None, folder_id)
        }
        MaterialDropped::WithoutFile {
            material_id,
            material_title,
            ..
        } => (k::material::WITHOUT_FILE, material_title, None, material_id),
        MaterialDropped::UnknownKind {
            material_id,
            material_title,
            material_kind,
        } => (
            k::material::UNKNOWN_KIND,
            material_title,
            Some(material_kind),
            material_id,
        ),
        MaterialDropped::SameFile { .. } => return None,
    })
}

/// A name on one line, for the dialog (summary.md marks line breaks ↵).
fn one_line(s: &str) -> String {
    s.split(['\r', '\n'])
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// What differs from 0.1 in an imported book, one entry per line of its
/// summary.md and in that order (nothing for a book not imported). Read
/// from the book's record, the one written into `import_book`.
pub fn differences(b: &BookRecord) -> Vec<Difference> {
    let mut out = Vec::new();
    if b.status != "imported" {
        return out;
    }
    if b.assets_missing + b.assets_mismatched > 0 {
        out.push(Difference {
            block: Block::Assets,
            sentence: k::ASSETS,
            args: vec![
                ("missing", b.assets_missing.to_string()),
                ("mismatched", b.assets_mismatched.to_string()),
            ],
            count: b.assets_missing + b.assets_mismatched,
            counted: false,
            codes: Vec::new(),
        });
    }
    let mut by_code: BTreeMap<&str, usize> = BTreeMap::new();
    for a in &b.adjustments {
        *by_code.entry(a.code.as_str()).or_default() += 1;
    }
    for (code, count) in by_code {
        out.push(Difference {
            block: Block::Defaults,
            sentence: default_sentence(code).unwrap_or(DEFAULT_FALLBACK),
            args: Vec::new(),
            count,
            counted: true,
            codes: vec![code.to_owned()],
        });
    }
    for (key, count) in &b.notes.0 {
        if let Some(sentence) = lossy_sentence(key) {
            out.push(Difference {
                block: Block::Lossy,
                sentence,
                args: lossy_args(key),
                count: *count,
                counted: true,
                codes: vec![key.clone()],
            });
        }
    }
    for d in &b.materials_dropped {
        if let Some((sentence, name, kind, id)) = material_line(d) {
            let mut args = vec![("name", one_line(name))];
            if let Some(kind) = kind {
                args.push(("kind", one_line(kind)));
            }
            out.push(Difference {
                block: Block::Materials,
                sentence,
                args,
                count: 1,
                counted: false,
                codes: vec![id.to_owned()],
            });
        }
    }
    out
}

/// `lines` with the counted ones that read the same (same block and
/// sentence) merged into the first, their counts added: summary.md lists
/// each code, the dialog each sentence once. A material line stays one
/// line per material, whatever its name.
pub fn merged(lines: Vec<Difference>) -> Vec<Difference> {
    let mut out: Vec<Difference> = Vec::with_capacity(lines.len());
    for line in lines {
        match out.iter_mut().find(|o| {
            line.counted
                && o.counted
                && o.block == line.block
                && o.sentence == line.sentence
                && o.args == line.args
        }) {
            Some(same) => {
                same.count += line.count;
                same.codes.extend(line.codes);
            }
            None => out.push(line),
        }
    }
    out
}

/// How many places `lines` stand for.
pub fn total(lines: &[Difference]) -> usize {
    lines.iter().map(|d| d.count).sum()
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

/// The author's summary, in Simplified Chinese whatever the interface
/// language (it is written on the import's thread, beside the library). The
/// lines that say what differs from 0.1 read dr-i18n's zh-CN sentences
/// ([`differences`]); the done dialog shows the same sentences in the
/// author's language.
pub fn summary_zh(r: &Receipt) -> String {
    let zh = I18n::new(Locale::ZhCn, Platform::current());
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
            s.push_str(&zh.fmt(
                k::ASSETS,
                &[
                    ("missing", &b.assets_missing),
                    ("mismatched", &b.assets_mismatched),
                ],
            ));
            s.push_str("\n\n");
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
                let e = zh.t(default_sentence(code).unwrap_or(DEFAULT_FALLBACK));
                s.push_str(&format!("- {e}（{count} 处，`{code}`）\n"));
            }
            s.push('\n');
        }
        let lossy: Vec<(&str, usize, String)> = b
            .notes
            .0
            .iter()
            .filter_map(|(k, v)| {
                lossy_sentence(k).map(|e| {
                    let names = lossy_args(k);
                    let args: Vec<dr_i18n::Arg<'_>> = names
                        .iter()
                        .map(|(n, value)| (*n, value as &dyn std::fmt::Display))
                        .collect();
                    (k.as_str(), *v, zh.fmt(e, &args))
                })
            })
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
            s.push_str(&format!("{}：\n\n", zh.t(MATERIALS_HEADING)));
            for d in not_imported {
                let Some((sentence, name, kind, id)) = material_line(d) else {
                    continue;
                };
                let kind = kind.map(|kind| format!("`{}`", inline_code(kind)));
                let mut args: Vec<dr_i18n::Arg<'_>> = Vec::new();
                let name = inline_md(name);
                args.push(("name", &name));
                if let Some(kind) = &kind {
                    args.push(("kind", kind));
                }
                let mut line = format!("{}（`{}`）", zh.fmt(sentence, &args), inline_code(id));
                // What went with a material without a file: summary.md only.
                if let MaterialDropped::WithoutFile {
                    description,
                    relations,
                    comments,
                    ..
                } = d
                {
                    let l = &mut line;
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
                }
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

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    /// Kebab-case string literals (`"a-b"`) on a line of source.
    fn kebab_literals(line: &str) -> Vec<String> {
        line.split('"')
            .skip(1)
            .step_by(2)
            .filter(|s| {
                s.contains('-')
                    && s.chars()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
            })
            .map(str::to_owned)
            .collect()
    }

    /// What still stops the import (`m10-import.md` 「还会拒绝导入的」):
    /// codes of `crate::v3` that never become an adjustment.
    const STILL_REFUSED: [&str; 5] = [
        "invalid-id",
        "mapping-choice-invalid",
        "prose-not-writable",
        "unreadable-source-prose",
        "v3-invariant",
    ];

    /// The codes the defaults record, read from their source: every
    /// kebab-case literal of `defaults.rs` but three table and namespace
    /// names, and in `v3.rs` the findings' codes and the codes passed to
    /// `record`.
    fn recorded_codes() -> BTreeSet<String> {
        let mut codes = BTreeSet::new();
        for line in include_str!("defaults.rs").lines() {
            codes.extend(kebab_literals(line).into_iter().filter(|l| {
                !["element-category", "element-template", "library-item"].contains(&l.as_str())
            }));
        }
        let v3: Vec<&str> = include_str!("v3.rs").lines().collect();
        for (i, line) in v3.iter().enumerate() {
            if line.contains("code: \"")
                || (i > 0 && v3[i - 1].trim() == "&mut adjusted,")
                || line.contains("\"skipped\")")
            {
                codes.extend(kebab_literals(line).into_iter().take(1));
            }
        }
        codes.retain(|c| !STILL_REFUSED.contains(&c.as_str()));
        codes
    }

    /// Why the catalog drops a relation, read from its source: every
    /// `relation-…-dropped` literal of `book.rs` (a note of the book and
    /// the reason in the receipt's originals, `relations`, `dropped`).
    fn relation_drop_codes() -> BTreeSet<String> {
        include_str!("book.rs")
            .lines()
            .flat_map(kebab_literals)
            .filter(|l| l.starts_with("relation-") && l.ends_with("-dropped"))
            .collect()
    }

    #[test]
    fn every_code_a_default_or_the_catalog_records_has_a_sentence_of_its_own() {
        let recorded = recorded_codes();
        assert!(recorded.len() > 30, "{recorded:?}");
        for code in &recorded {
            assert!(
                crate::defaults::CODES.contains(&code.as_str()),
                "{code} is recorded but not in defaults::CODES"
            );
        }
        for code in crate::defaults::CODES {
            assert!(
                default_sentence(code).is_some(),
                "{code} has no sentence: summary.md and the dialog would only say the fallback"
            );
        }
        assert!(default_sentence("a-code-nobody-knows").is_none());
        // No exception: the two the defaults round added are among them.
        let relations = relation_drop_codes();
        for code in [
            "relation-self-end-dropped",
            "relation-missing-entry-dropped",
        ] {
            assert!(relations.contains(code), "{relations:?}");
        }
        assert!(relations.len() >= 8, "{relations:?}");
        for code in &relations {
            assert!(
                lossy_sentence(code).is_some(),
                "{code} is recorded but has no sentence: summary.md and the dialog would leave it out"
            );
        }
    }

    /// Every form of note key `lossy_sentence` knows.
    const LOSSY_KEYS: &[&str] = &[
        "unknown-inline:footnote",
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
        "relation-self-end-dropped",
        "relation-missing-entry-dropped",
        "act-binding-shared-idea-split",
        "act-binding-kept-existing-placement",
        "entity-link-to-asset-kept-as-text",
        "task-todo-link-replaced-by-projection",
        "task-status-follows-tick",
    ];

    /// The sentences of `import.v1.differences` are exactly the ones a code
    /// reaches, each in all nine languages and translated (English has no
    /// Chinese but the names of the levels the import makes: 要素, 未分类,
    /// 幕).
    #[test]
    fn every_sentence_is_reached_by_a_code_and_reads_in_all_nine_languages() {
        let mut reached: BTreeSet<&'static str> = BTreeSet::new();
        for code in crate::defaults::CODES {
            reached.insert(default_sentence(code).unwrap().name());
        }
        reached.insert(DEFAULT_FALLBACK.name());
        for key in LOSSY_KEYS {
            let sentence = lossy_sentence(key).expect(key);
            reached.insert(sentence.name());
            reached.insert(dialog_sentence(sentence).name());
        }
        reached.insert(k::ASSETS.name());
        reached.insert(MATERIALS_HEADING.name());
        for d in [
            MaterialDropped::EmptyFolder {
                folder_id: "f".into(),
                name: "n".into(),
            },
            MaterialDropped::UnimportedFolder {
                folder_id: "f".into(),
                name: "n".into(),
            },
            MaterialDropped::WithoutFile {
                material_id: "m".into(),
                material_title: "n".into(),
                description: None,
                relations: vec![],
                comments: vec![],
            },
            MaterialDropped::UnknownKind {
                material_id: "m".into(),
                material_title: "n".into(),
                material_kind: "url".into(),
            },
        ] {
            reached.insert(material_line(&d).unwrap().0.name());
        }
        let declared: BTreeSet<&'static str> = Key::all()
            .map(Key::name)
            .filter(|n| n.starts_with("import.v1.differences."))
            .collect();
        assert_eq!(
            reached, declared,
            "a sentence no code reaches, or the other way"
        );
        let zh = I18n::new(Locale::ZhCn, Platform::Mac);
        let level_names = ["要素", "未分类", "幕"];
        for key in Key::all().filter(|k| declared.contains(k.name())) {
            for locale in Locale::ALL {
                let text = I18n::new(locale, Platform::Mac).t(key);
                assert!(!text.trim().is_empty(), "{locale:?} {}", key.name());
                if !matches!(locale, Locale::ZhCn) {
                    assert_ne!(
                        text,
                        zh.t(key),
                        "{locale:?} {} is not translated",
                        key.name()
                    );
                }
            }
            let mut en = I18n::new(Locale::En, Platform::Mac).t(key).to_owned();
            for name in level_names {
                en = en.replace(name, "");
            }
            assert!(
                !en.chars().any(|c| ('\u{3400}'..='\u{9fff}').contains(&c)),
                "en {}: {en}",
                key.name()
            );
        }
    }

    /// summary.md's words did not change when they moved into the tables.
    #[test]
    fn the_chinese_sentences_are_the_ones_summary_md_had() {
        let zh = I18n::new(Locale::ZhCn, Platform::Mac);
        assert_eq!(
            zh.t(lossy_sentence("table-cell-span").unwrap()),
            "表格的合并单元格和列宽没有保留"
        );
        assert_eq!(
            zh.t(default_sentence("chapter-without-book-order").unwrap()),
            "没有书序的章节按旧版的读法排在最前（书序 0）"
        );
        assert_eq!(zh.t(DEFAULT_FALLBACK), "照原样导入，记在回执里");
        // The retired AI's name comes from here, not from the tables.
        let mut b = BookRecord {
            status: "imported".into(),
            ..Default::default()
        };
        b.notes
            .0
            .insert("comment-action-dropped:accept_suggestion".into(), 2);
        assert_eq!(
            differences(&b)[0].text(&zh),
            "已退役的 Copilot 批注动作（采纳 / 拒绝）不再导入"
        );
        assert!(summary_zh(&Receipt {
            importer: "t",
            started_ms: 0,
            finished_ms: 0,
            source_sha256: String::new(),
            source_bytes: 0,
            schema_level_before: 0,
            gate: Gate::decide(false, None, &[], Default::default()),
            accepted: Default::default(),
            books: vec![b],
            docs: Vec::new(),
            anchors: Vec::new(),
            originals: Vec::new(),
            orphan_yjs_docs: 0,
            archived_rows: BTreeMap::new(),
            local_rows: BTreeMap::new(),
            installation_id_adopted: false,
            history_retention: "kept",
            cancelled: false,
        })
        .contains(
            "- 已退役的 Copilot 批注动作（采纳 / 拒绝）不再导入（2 处，`comment-action-dropped:accept_suggestion`）"
        ));
        assert_eq!(
            zh.fmt(k::ASSETS, &[("missing", &2), ("mismatched", &1)]),
            "有 2 个资源文件找不到、1 个和记录的哈希对不上，没有导入。"
        );
        assert_eq!(
            zh.fmt(
                k::material::UNKNOWN_KIND,
                &[("kind", &"`url`"), ("name", &"怪东西")]
            ),
            "不认识种类（`url`）的素材「怪东西」"
        );
    }

    /// The author's decisions of 2026-11-21: the two relation codes' words,
    /// the materials' heading, and the dialog's two sentences without
    /// 「逐条列在下方」, which are the full sentences minus that last clause
    /// in every language while summary.md keeps the full ones.
    #[test]
    fn the_relation_sentences_the_heading_and_the_dialog_variants() {
        let zh = I18n::new(Locale::ZhCn, Platform::Mac);
        let en = I18n::new(Locale::En, Platform::Mac);
        let self_end = lossy_sentence("relation-self-end-dropped").unwrap();
        let missing = lossy_sentence("relation-missing-entry-dropped").unwrap();
        assert_eq!(zh.t(self_end), "两头是同一个对象的关系没有导入");
        assert_eq!(zh.t(missing), "一头已不存在的关系没有导入");
        assert_eq!(
            en.t(self_end),
            "Relations whose two ends are the same thing were not imported"
        );
        assert_eq!(
            en.t(missing),
            "Relations with an end that no longer exists were not imported"
        );
        assert_eq!(zh.t(MATERIALS_HEADING), "旧版素材里没有带过来的");
        assert_eq!(
            en.t(MATERIALS_HEADING),
            "Materials from 0.1 that did not come over"
        );
        let links = lossy_sentence("entity-link-to-asset-kept-as-text").unwrap();
        let ticks = lossy_sentence("task-status-follows-tick").unwrap();
        for (full, zh_dialog, en_dialog) in [
            (
                links,
                "正文中指向图片或 PDF 素材的链接，素材没有文件、无处可链，已转为普通文字",
                "Links in the text to image or PDF materials that have no file had nothing to point to and became plain text",
            ),
            (
                ticks,
                "清单项关联的待办状态与勾选不一致，已按清单项的勾选为准",
                "Where a checklist item's to-do status disagreed with its tick, the tick was followed",
            ),
        ] {
            let dialog = dialog_sentence(full);
            assert_ne!(dialog, full);
            assert_eq!(zh.t(dialog), zh_dialog);
            assert_eq!(en.t(dialog), en_dialog);
            assert_eq!(zh.t(full), format!("{zh_dialog}，逐条列在下方"));
            for locale in Locale::ALL {
                let s = I18n::new(locale, Platform::Mac);
                let (whole, short) = (s.t(full), s.t(dialog));
                assert!(
                    whole.starts_with(short) && whole.len() > short.len(),
                    "{locale:?}: {short:?} is not {whole:?} minus its last clause"
                );
            }
        }
        // Any other sentence, the dialog says as summary.md does.
        for key in LOSSY_KEYS.iter().filter(|k| {
            !matches!(
                **k,
                "entity-link-to-asset-kept-as-text" | "task-status-follows-tick"
            )
        }) {
            let sentence = lossy_sentence(key).unwrap();
            assert_eq!(dialog_sentence(sentence), sentence, "{key}");
        }
        // summary.md: the full sentences, the new relation lines, and the
        // heading with its colon; the dialog: the short ones.
        let mut b = BookRecord {
            name: "书".into(),
            status: "imported".into(),
            ..Default::default()
        };
        for key in [
            "entity-link-to-asset-kept-as-text",
            "task-status-follows-tick",
            "relation-self-end-dropped",
            "relation-missing-entry-dropped",
        ] {
            b.notes.0.insert(key.into(), 1);
        }
        b.materials_dropped.push(MaterialDropped::EmptyFolder {
            folder_id: "f".into(),
            name: "空夹".into(),
        });
        let lines = differences(&b);
        let shown: Vec<String> = lines.iter().map(|d| d.dialog_text(&zh)).collect();
        assert!(
            shown.contains(&"清单项关联的待办状态与勾选不一致，已按清单项的勾选为准".to_owned())
        );
        assert!(shown.contains(&"两头是同一个对象的关系没有导入".to_owned()));
        assert!(!shown.iter().any(|t| t.contains("逐条列在下方")));
        let summary = summary_zh(&Receipt {
            importer: "t",
            started_ms: 0,
            finished_ms: 0,
            source_sha256: String::new(),
            source_bytes: 0,
            schema_level_before: 0,
            gate: Gate::decide(false, None, &[], Default::default()),
            accepted: Default::default(),
            books: vec![b],
            docs: Vec::new(),
            anchors: Vec::new(),
            originals: Vec::new(),
            orphan_yjs_docs: 0,
            archived_rows: BTreeMap::new(),
            local_rows: BTreeMap::new(),
            installation_id_adopted: false,
            history_retention: "kept",
            cancelled: false,
        });
        for line in [
            "- 正文中指向图片或 PDF 素材的链接，素材没有文件、无处可链，已转为普通文字，逐条列在下方（1 处，`entity-link-to-asset-kept-as-text`）",
            "- 清单项关联的待办状态与勾选不一致，已按清单项的勾选为准，逐条列在下方（1 处，`task-status-follows-tick`）",
            "- 两头是同一个对象的关系没有导入（1 处，`relation-self-end-dropped`）",
            "- 一头已不存在的关系没有导入（1 处，`relation-missing-entry-dropped`）",
            "旧版素材里没有带过来的：\n\n- 空的素材夹「空夹」（`f`）",
        ] {
            assert!(summary.contains(line), "{line} in {summary}");
        }
    }

    fn adjustment(code: &str) -> crate::defaults::Adjustment {
        crate::defaults::Adjustment {
            code: code.into(),
            book: "b".into(),
            table: "t".into(),
            id: "x".into(),
            done: "d".into(),
            original: None,
        }
    }

    #[test]
    fn differences_follow_summary_md_and_merge_only_what_reads_the_same() {
        let mut b = BookRecord {
            book_id: "b".into(),
            name: "书".into(),
            status: "imported".into(),
            assets_missing: 2,
            assets_mismatched: 1,
            ..Default::default()
        };
        b.notes.0.insert("heading-level-clamped".into(), 3);
        b.notes.0.insert("indent-clamped".into(), 4);
        b.notes.0.insert("block-id-assigned".into(), 9);
        b.adjustments = vec![
            adjustment("writing-day-duplicate"),
            adjustment("writing-day-duplicate"),
            adjustment("a-code-nobody-knows"),
        ];
        let folder = |id: &str| MaterialDropped::EmptyFolder {
            folder_id: id.into(),
            name: "空夹\n第二行".into(),
        };
        b.materials_dropped = vec![
            folder("f1"),
            folder("f2"),
            MaterialDropped::SameFile {
                material_id: "m".into(),
                material_title: "同一张图".into(),
                kept_title: "插图".into(),
                asset_id: "a".into(),
            },
        ];
        let lines = differences(&b);
        let blocks: Vec<Block> = lines.iter().map(|d| d.block).collect();
        assert_eq!(
            blocks,
            [
                Block::Assets,
                Block::Defaults,
                Block::Defaults,
                Block::Lossy,
                Block::Lossy,
                Block::Materials,
                Block::Materials
            ]
        );
        // The unknown code says the fallback and is counted; the lossless
        // key and the merged file are in neither.
        assert_eq!(lines[1].sentence, DEFAULT_FALLBACK);
        assert_eq!(total(&lines), 3 + 1 + 2 + 3 + 4 + 1 + 1);
        let shown = merged(lines.clone());
        assert_eq!(total(&shown), total(&lines));
        // The two clamps read the same: one line of 7. Two folders of one
        // name stay two lines of one place each.
        assert_eq!(shown.len(), lines.len() - 1);
        let clamped = shown.iter().find(|d| d.block == Block::Lossy).unwrap();
        assert_eq!(clamped.count, 7);
        assert_eq!(clamped.codes, ["heading-level-clamped", "indent-clamped"]);
        let folders: Vec<_> = shown
            .iter()
            .filter(|d| d.block == Block::Materials)
            .collect();
        assert_eq!(folders.len(), 2);
        assert!(folders.iter().all(|d| d.count == 1 && !d.counted));
        let en = I18n::new(Locale::En, Platform::Mac);
        assert_eq!(folders[0].text(&en), "Empty material folder “空夹 第二行”");
        assert_eq!(
            shown[0].text(&en),
            "Asset files not found: 2; not matching their recorded hash: 1. They were not imported."
        );
        // A book not imported has nothing to say.
        b.status = "already-imported".into();
        assert!(differences(&b).is_empty());
    }
}
