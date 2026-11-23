//! What a 0.1 library kept for this device that the new client takes over
//! once its books are in (`m10-import.md`, 「0.1 的设置、快捷键和工作记忆
//! （2026-11-21）」):
//!
//! - the settings and shortcuts the 0.1 hand-over captured
//!   ([`captured_settings`]: the archive's `local_setting`), which the app
//!   takes into its own settings once per device (`dr-view-import`, with the
//!   table in `dr_shell::settings::v1`);
//! - each book's Agent working memory ([`carry_working_memory`]: the
//!   archive's `local_agent_working_memory`), which becomes that book's
//!   working memory here when it has none, never over one.
//!
//! What became of each is recorded beside the receipt ([`record`]): the
//! archive's `carried` table, one row per 0.1 value, and a section of
//! `summary.md` listing what came over and what did not.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use dr_agent::memory::{self, UpdatedBy};
use dr_model::id::BookId;
use dr_store::Library;
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};

use crate::error::Result;
use crate::receipt;

/// The archive's table of what was carried over.
const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS carried (
    kind TEXT NOT NULL,
    old_key TEXT NOT NULL,
    new_key TEXT,
    outcome TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    detail TEXT,
    label TEXT,
    at_ms INTEGER NOT NULL,
    PRIMARY KEY (kind, old_key)
) STRICT;
";

/// The heading of the section [`record`] keeps at the end of `summary.md`.
const SECTION: &str = "## 设置、快捷键和工作记忆";

/// One 0.1 value and what became of it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Row {
    /// `setting`, `shortcut` or `working-memory`.
    pub kind: String,
    /// `<store>.<field>` for a setting, the 0.1 id for a shortcut, the book
    /// id for a working memory.
    pub old_key: String,
    /// The key here, if there is one.
    pub new_key: Option<String>,
    /// `adopted`, `clamped`, `kept-here`, `default`, `no-equivalent`,
    /// `invalid`, `conflict`; for a working memory `adopted`, `kept-here` or
    /// `not-carried`.
    pub outcome: String,
    /// JSON.
    pub old_value: Option<String>,
    /// JSON.
    pub new_value: Option<String>,
    /// Why, when it was not taken over as it was.
    pub detail: Option<String>,
    /// A name for the author (a book's).
    pub label: Option<String>,
}

fn archive(root: &Path) -> PathBuf {
    receipt::directory(root).join(receipt::DATABASE)
}

fn has_table(conn: &Connection, table: &str) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?1",
            [table],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

fn read_only(root: &Path) -> Result<Option<Connection>> {
    let path = archive(root);
    if !path.is_file() {
        return Ok(None);
    }
    Ok(Some(Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?))
}

/// The WebView storage values the hand-over captured (`settings.entries`
/// of the stamp, `docs/v2-handoff.md`), by key, as the import archived them
/// for the library at `root`. Empty when the 0.1 library had no stamp.
pub fn captured_settings(root: &Path) -> Result<BTreeMap<String, String>> {
    let Some(conn) = read_only(root)? else {
        return Ok(BTreeMap::new());
    };
    if !has_table(&conn, "local_setting")? {
        return Ok(BTreeMap::new());
    }
    let mut stmt = conn.prepare("SELECT key, value FROM local_setting ORDER BY key")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// One book's 0.1 working memory.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkingMemory {
    pub book: String,
    pub content_md: String,
    /// `author` or `agent`.
    pub updated_by: String,
}

/// The 0.1 working memories the import archived for the library at `root`
/// that hold anything: 0.1 shows one as there when it is not deleted and
/// not blank (`useAgentWorkingMemory.ts`).
pub fn working_memories(root: &Path) -> Result<Vec<WorkingMemory>> {
    let Some(conn) = read_only(root)? else {
        return Ok(Vec::new());
    };
    if !has_table(&conn, "local_agent_working_memory")? {
        return Ok(Vec::new());
    }
    let mut stmt = conn.prepare(
        "SELECT project_id, content_md, updated_by FROM local_agent_working_memory
         WHERE deleted_at IS NULL ORDER BY project_id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(WorkingMemory {
            book: r.get(0)?,
            content_md: r.get(1)?,
            updated_by: r.get(2)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        let row = row?;
        if !row.content_md.trim().is_empty() {
            out.push(row);
        }
    }
    Ok(out)
}

fn book_name(lib: &Library, book: &str) -> Option<String> {
    lib.local_read(|conn| {
        Ok(conn
            .query_row(
                "SELECT name FROM import_book WHERE book_id = ?1 ORDER BY run_id DESC LIMIT 1",
                [book],
                |r| r.get::<_, String>(0),
            )
            .optional()?)
    })
    .ok()
    .flatten()
}

/// Each book's 0.1 working memory into `lib` (the library at `root` the
/// import wrote), where that book has none yet; never over one. Records
/// what became of each ([`record`]) and returns the rows.
pub fn carry_working_memory(lib: &Library, root: &Path) -> Result<Vec<Row>> {
    // An import carried on: what an earlier pass brought over stays
    // recorded as brought over.
    let earlier: Vec<String> = rows(root)?
        .into_iter()
        .filter(|r| r.kind == "working-memory" && r.outcome == "adopted")
        .map(|r| r.old_key)
        .collect();
    let mut rows = Vec::new();
    for old in working_memories(root)? {
        if earlier.contains(&old.book) {
            continue;
        }
        let mut row = Row {
            kind: "working-memory".into(),
            old_key: old.book.clone(),
            new_key: Some(format!("{}/{}", memory::SCOPE, old.book)),
            outcome: "not-carried".into(),
            old_value: None,
            new_value: None,
            detail: None,
            label: book_name(lib, &old.book),
        };
        let by = if old.updated_by == "author" {
            UpdatedBy::Author
        } else {
            UpdatedBy::Agent
        };
        let outcome = BookId::parse(&old.book)
            .map_err(|e| e.to_string())
            .and_then(|book| {
                let here = memory::load(lib, &book).map_err(|e| e.to_string())?;
                if here.exists {
                    return Ok("kept-here");
                }
                memory::replace(lib, &book, here.revision, &old.content_md, by)
                    .map(|_| "adopted")
                    .map_err(|e| e.to_string())
            });
        match outcome {
            Ok(outcome) => row.outcome = outcome.into(),
            Err(why) => row.detail = Some(why),
        }
        rows.push(row);
    }
    if archive(root).is_file() {
        // Also when there is nothing new: the import that carried on wrote
        // `summary.md` again without the section.
        record(root, &rows)?;
    }
    Ok(rows)
}

/// What the archive of the library at `root` records as carried over.
pub fn rows(root: &Path) -> Result<Vec<Row>> {
    let Some(conn) = read_only(root)? else {
        return Ok(Vec::new());
    };
    if !has_table(&conn, "carried")? {
        return Ok(Vec::new());
    }
    read_rows(&conn)
}

fn read_rows(conn: &Connection) -> Result<Vec<Row>> {
    let mut stmt = conn.prepare(
        "SELECT kind, old_key, new_key, outcome, old_value, new_value, detail, label
         FROM carried ORDER BY kind, old_key",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Row {
            kind: r.get(0)?,
            old_key: r.get(1)?,
            new_key: r.get(2)?,
            outcome: r.get(3)?,
            old_value: r.get(4)?,
            new_value: r.get(5)?,
            detail: r.get(6)?,
            label: r.get(7)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Records `rows` in the archive of the library at `root` (a row for the
/// same 0.1 value replaces the earlier one) and writes the section of
/// `summary.md` again from everything recorded.
pub fn record(root: &Path, rows: &[Row]) -> Result<()> {
    let dir = receipt::directory(root);
    std::fs::create_dir_all(&dir)?;
    let conn = Connection::open(archive(root))?;
    conn.execute_batch(SCHEMA)?;
    let tx = conn.unchecked_transaction()?;
    {
        let mut insert = tx.prepare(
            "INSERT OR REPLACE INTO carried VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        )?;
        let now = dr_store::now_ms();
        for r in rows {
            insert.execute(params![
                r.kind,
                r.old_key,
                r.new_key,
                r.outcome,
                r.old_value,
                r.new_value,
                r.detail,
                r.label,
                now
            ])?;
        }
    }
    tx.commit()?;
    let all = read_rows(&conn)?;
    drop(conn);
    if all.is_empty() {
        return Ok(());
    }
    let path = dir.join(receipt::SUMMARY);
    let mut summary = std::fs::read_to_string(&path).unwrap_or_default();
    if let Some(at) = summary.find(&format!("\n{SECTION}\n")) {
        summary.truncate(at);
    }
    if !summary.is_empty() && !summary.ends_with('\n') {
        summary.push('\n');
    }
    summary.push_str(&section(&all));
    std::fs::write(&path, summary)?;
    Ok(())
}

fn code(s: &str) -> String {
    format!("`{}`", s.replace('`', "'").replace(['\r', '\n'], " "))
}

/// The section of `summary.md`: what came over and what did not, one line
/// per kind of outcome (a 0.1 default is nothing lost and is left out).
fn section(rows: &[Row]) -> String {
    let mut s = format!("\n{SECTION}\n\n");
    let item = |r: &Row| -> String {
        if r.kind == "working-memory" {
            let name = r.label.as_deref().unwrap_or(&r.old_key);
            return match &r.detail {
                Some(why) => format!("《{name}》（{}）", code(why)),
                None => format!("《{name}》"),
            };
        }
        let mut t = code(&r.old_key);
        if let Some(new) = &r.new_key {
            t.push_str(&format!(" → {}", code(new)));
        }
        match (&r.old_value, &r.new_value) {
            (Some(old), Some(new)) if old != new => {
                t.push_str(&format!("（{} → {}）", code(old), code(new)))
            }
            (Some(old), _) => t.push_str(&format!("（{}）", code(old))),
            _ => {}
        }
        t
    };
    let groups: [(&str, &str, &str); 10] = [
        ("setting", "adopted", "带过来的设置"),
        ("setting", "clamped", "超出新版范围、已收进范围的设置"),
        ("setting", "kept-here", "新版里已经设过、没有改的设置"),
        ("setting", "invalid", "新版不认这个值、没有带过来的设置"),
        ("setting", "no-equivalent", "新版没有对应、没有带过来的设置"),
        ("shortcut", "adopted", "带过来的快捷键"),
        ("shortcut", "kept-here", "新版里已经改过、没有动的快捷键"),
        (
            "shortcut",
            "conflict",
            "和新版别的命令冲突、保留默认的快捷键",
        ),
        ("shortcut", "invalid", "新版认不出、保留默认的快捷键"),
        ("shortcut", "no-equivalent", "新版没有这个命令的快捷键"),
    ];
    let mut any = false;
    for (kind, outcome, title) in groups {
        let items: Vec<String> = rows
            .iter()
            .filter(|r| r.kind == kind && r.outcome == outcome)
            .map(item)
            .collect();
        if !items.is_empty() {
            any = true;
            s.push_str(&format!("- {title}：{}\n", items.join("、")));
        }
    }
    for (outcome, title) in [
        ("adopted", "带过来的工作记忆"),
        ("kept-here", "新版里已经有、没有覆盖的工作记忆"),
        ("not-carried", "没能带过来的工作记忆"),
    ] {
        let items: Vec<String> = rows
            .iter()
            .filter(|r| r.kind == "working-memory" && r.outcome == outcome)
            .map(item)
            .collect();
        if !items.is_empty() {
            any = true;
            s.push_str(&format!("- {title}：{}\n", items.join("、")));
        }
    }
    if !any {
        s.push_str("- 旧版的设置都是默认值，没有要带过来的。\n");
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(kind: &str, key: &str, outcome: &str) -> Row {
        Row {
            kind: kind.into(),
            old_key: key.into(),
            new_key: None,
            outcome: outcome.into(),
            old_value: None,
            new_value: None,
            detail: None,
            label: None,
        }
    }

    #[test]
    fn the_section_is_written_again_from_every_row_and_stays_last() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(receipt::directory(root)).unwrap();
        let summary = receipt::directory(root).join(receipt::SUMMARY);
        std::fs::write(&summary, "# 旧书导入摘要\n\n正文。\n").unwrap();
        let mut theme = row("setting", "settings-storage.themeMode", "adopted");
        theme.new_key = Some("appearance.theme".into());
        theme.old_value = Some("\"dark\"".into());
        theme.new_value = Some("\"dark\"".into());
        record(
            root,
            &[
                theme,
                row("setting", "settings-storage.bodyFontSize", "default"),
            ],
        )
        .unwrap();
        let mut memory = row("working-memory", "b1", "adopted");
        memory.label = Some("阿Q正传".into());
        record(root, &[memory]).unwrap();
        let text = std::fs::read_to_string(&summary).unwrap();
        assert!(text.starts_with("# 旧书导入摘要\n\n正文。\n"));
        assert_eq!(text.matches(SECTION).count(), 1);
        assert!(text.contains(
            "- 带过来的设置：`settings-storage.themeMode` → `appearance.theme`（`\"dark\"`）"
        ));
        assert!(text.contains("- 带过来的工作记忆：《阿Q正传》"));
        assert!(
            !text.contains("bodyFontSize"),
            "a 0.1 default is nothing lost"
        );
        assert_eq!(rows(root).unwrap().len(), 3);
    }
}
