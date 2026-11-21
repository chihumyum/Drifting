//! Reading the 0.1 Agent conversations an import archived beside the
//! library (`<library>/import-v1/receipt.sqlite`, the `archive_agent_*`
//! tables `receipt::write_archive` copies as they were): M31's 「0.1 的旧对话」
//! (`m31-agent-panel.md`, `m10-import.md` 待协调 3). Read only: they can be
//! read and searched, never continued.
//!
//! - The file is opened read-only and `query_only`; nothing here writes it.
//!   No file is no archive (`Ok(None)`); a file that is not a whole SQLite
//!   database (truncated, overwritten) is [`Error::Damaged`].
//! - A conversation is listed as 0.1 listed it in its Agent panel
//!   (`agent-conversation-repo.ts` `listByProject`): its book's, a chat (not
//!   an external MCP client's session), not deleted, newest first; a branch
//!   0.1 replaced by the one continuing it on this device is left out (the
//!   rule there, over `archive_agent_chat_branch`; an archive written before
//!   that table was archived lists every branch).
//! - Its turns are the transcript 0.1 showed: the rendered messages it kept
//!   in `messages_json` (`AgentChatMessage`), or, when that is empty, the
//!   runtime journal's messages mapped the way 0.1's sync maps them
//!   (`visibleMessages`). Token usage and the plan list are not turns.
//! - The archive has no indexes (it was copied with `CREATE TABLE … AS`):
//!   a listing reads only the conversation rows' small columns, a
//!   conversation is read by its row id.
//!
//! Conversations are the author's: nothing of them goes to a log or a
//! report (errors carry SQLite's own words, never a value).

use std::collections::{HashMap, HashSet};
use std::io::Read as _;
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use rusqlite::{Connection, OpenFlags, OptionalExtension as _, params};
use serde_json::Value;

const CONVERSATIONS: &str = "archive_agent_conversation";
const BRANCHES: &str = "archive_agent_chat_branch";
const SESSIONS: &str = "archive_agent_runtime_session";
const MESSAGES: &str = "archive_agent_runtime_message";

/// The archive of the library at `library_root`.
pub fn path(library_root: &Path) -> PathBuf {
    crate::receipt::directory(library_root).join(crate::receipt::DATABASE)
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The file is not a whole SQLite database.
    #[error("the archive is damaged ({0})")]
    Damaged(&'static str),
    #[error("reading the archive: {0}")]
    Io(#[from] std::io::Error),
    #[error("reading the archive: {0}")]
    Sqlite(#[from] rusqlite::Error),
    /// The caller's cancel flag was raised.
    #[error("cancelled")]
    Cancelled,
}

pub type Result<T> = std::result::Result<T, Error>;

/// One listed 0.1 conversation (no transcript).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Conversation {
    pub id: String,
    /// As 0.1 kept it; empty for one without a title.
    pub title: String,
    /// When it last changed (`updated_at`), Unix milliseconds.
    pub updated_ms: Option<i64>,
    /// Its row in the archive, read directly (the archive has no index).
    row: i64,
}

/// One turn of a 0.1 conversation, as 0.1 showed it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Turn {
    /// What the author wrote.
    User(String),
    /// What the Agent answered.
    Agent(String),
    /// The Agent's reasoning, folded in 0.1.
    Thinking(String),
    /// A read or write tool call, by its 0.1 tool's name.
    Tool(String),
    /// An error 0.1 showed in the conversation.
    Error(String),
}

/// Who wrote a turn the search reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Speaker {
    User,
    Agent,
}

/// Where a query is in one conversation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Matches {
    /// In the title (byte ranges).
    pub title: Vec<Range<usize>>,
    /// Every occurrence, in the title and in what the author and the Agent
    /// wrote.
    pub occurrences: usize,
    /// The first turn of the author's or the Agent's that has it.
    pub first: Option<Hit>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hit {
    /// The turn's index (in [`Archive::turns`]'s order).
    pub turn: usize,
    pub speaker: Speaker,
    /// The whole turn, and where in it the query first is.
    pub text: String,
    pub at: Range<usize>,
}

/// A conversation the query is in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Found {
    pub conversation: Conversation,
    pub matches: Matches,
}

/// An open archive. One per thread: it holds a SQLite connection.
pub struct Archive {
    conn: Connection,
    /// `source` (0.1 migration 0005): chats and external sessions.
    source: bool,
    deleted: bool,
    runtime_session: bool,
    branches: bool,
    journal: bool,
}

impl Archive {
    /// Opens the archive of the library at `library_root`, read-only.
    /// `Ok(None)` when there is none, or it has no conversations table.
    pub fn open(library_root: &Path) -> Result<Option<Archive>> {
        let path = path(library_root);
        match std::fs::metadata(&path) {
            Ok(meta) if meta.is_file() => {}
            Ok(_) => return Ok(None),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        }
        whole(&path)?;
        let conn = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        conn.pragma_update(None, "query_only", true)?;
        let columns = |table: &str| -> Result<HashSet<String>> {
            let mut stmt =
                conn.prepare(&format!("SELECT name FROM pragma_table_info('{table}')"))?;
            let names = stmt
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<_>>()?;
            Ok(names)
        };
        let conversation = columns(CONVERSATIONS)?;
        if !["id", "project_id", "title", "updated_at", "messages_json"]
            .iter()
            .all(|c| conversation.contains(*c))
        {
            return Ok(None);
        }
        let branch = columns(BRANCHES)?;
        let session = columns(SESSIONS)?;
        let message = columns(MESSAGES)?;
        let has = |set: &HashSet<String>, names: &[&str]| names.iter().all(|n| set.contains(*n));
        Ok(Some(Archive {
            source: conversation.contains("source"),
            deleted: conversation.contains("deleted_at"),
            runtime_session: conversation.contains("runtime_session_id"),
            branches: has(
                &branch,
                &[
                    "id",
                    "project_id",
                    "parent_branch_id",
                    "fork_turn_id",
                    "head_turn_id",
                    "readiness",
                    "deleted_at",
                ],
            ),
            journal: has(
                &session,
                &["id", "project_id", "conversation_id", "created_at"],
            ) && has(&message, &["session_id", "ordinal", "role", "content_json"]),
            conn,
        }))
    }

    /// The conditions every listed conversation meets, after `project_id = ?1`.
    fn listed(&self) -> String {
        let mut sql = String::new();
        if self.deleted {
            sql.push_str(" AND deleted_at IS NULL");
        }
        if self.source {
            sql.push_str(" AND source = 'chat'");
        }
        sql
    }

    /// The 0.1 conversations of `book`, newest first.
    pub fn conversations(&self, book: &str) -> Result<Vec<Conversation>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT rowid, id, title, updated_at FROM {CONVERSATIONS} WHERE project_id = ?1{} ORDER BY updated_at DESC, id DESC",
            self.listed()
        ))?;
        let rows = stmt.query_map([book], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                text(r.get_ref(1)?),
                text(r.get_ref(2)?),
                text(r.get_ref(3)?),
            ))
        })?;
        let replaced = self.replaced(book)?;
        let mut out = Vec::new();
        for row in rows {
            let (row, id, title, updated) = row?;
            let Some(id) = id.filter(|id| !replaced.contains(id)) else {
                continue;
            };
            out.push(Conversation {
                id,
                title: title.unwrap_or_default(),
                updated_ms: updated.as_deref().and_then(crate::time::parse_iso_ms),
                row,
            });
        }
        Ok(out)
    }

    /// The branches of `book` 0.1 did not list: a branch whose one live
    /// child, ready, was forked at its head (the conversation continued on
    /// this device from another device's).
    fn replaced(&self, book: &str) -> Result<HashSet<String>> {
        if !self.branches {
            return Ok(HashSet::new());
        }
        struct Branch {
            id: String,
            parent: Option<String>,
            fork: Option<String>,
            head: Option<String>,
            ready: bool,
            live: bool,
        }
        let mut stmt = self.conn.prepare(&format!(
            "SELECT id, parent_branch_id, fork_turn_id, head_turn_id, readiness, deleted_at FROM {BRANCHES} WHERE project_id = ?1"
        ))?;
        let branches: Vec<Branch> = stmt
            .query_map([book], |r| {
                Ok(Branch {
                    id: text(r.get_ref(0)?).unwrap_or_default(),
                    parent: text(r.get_ref(1)?),
                    fork: text(r.get_ref(2)?),
                    head: text(r.get_ref(3)?),
                    ready: text(r.get_ref(4)?).as_deref() == Some("ready"),
                    live: matches!(r.get_ref(5)?, rusqlite::types::ValueRef::Null),
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        let mut children: HashMap<&str, Vec<&Branch>> = HashMap::new();
        for b in branches.iter().filter(|b| b.live) {
            if let Some(parent) = &b.parent {
                children.entry(parent).or_default().push(b);
            }
        }
        Ok(branches
            .iter()
            .filter(|b| {
                b.head.is_some()
                    && matches!(children.get(b.id.as_str()).map(Vec::as_slice),
                        Some([child]) if child.ready && child.fork == b.head)
            })
            .map(|b| b.id.clone())
            .collect())
    }

    /// The turns of `conversation` of `book` (one [`Self::conversations`]
    /// listed); `None` when it is no longer there.
    pub fn turns(&self, book: &str, conversation: &Conversation) -> Result<Option<Vec<Turn>>> {
        let session = if self.runtime_session {
            "runtime_session_id"
        } else {
            "NULL"
        };
        let select =
            format!("SELECT id, project_id, messages_json, {session} FROM {CONVERSATIONS}");
        let read = |r: &rusqlite::Row<'_>| {
            Ok((
                text(r.get_ref(0)?),
                text(r.get_ref(1)?),
                text(r.get_ref(2)?),
                text(r.get_ref(3)?),
            ))
        };
        let by_row = self
            .conn
            .query_row(
                &format!("{select} WHERE rowid = ?1{}", self.listed()),
                [conversation.row],
                read,
            )
            .optional()?
            .filter(|(id, project, ..)| {
                id.as_deref() == Some(conversation.id.as_str()) && project.as_deref() == Some(book)
            });
        // The archive is written again when an import carries on: look the
        // row up by its id then.
        let row = match by_row {
            Some(row) => Some(row),
            None => self
                .conn
                .query_row(
                    &format!(
                        "{select} WHERE id = ?1 AND project_id = ?2{}",
                        self.listed()
                    ),
                    params![conversation.id, book],
                    read,
                )
                .optional()?,
        };
        let Some((_, _, messages, session)) = row else {
            return Ok(None);
        };
        let turns = messages.as_deref().map(displayed).unwrap_or_default();
        if !turns.is_empty() || !self.journal {
            return Ok(Some(turns));
        }
        Ok(Some(self.journal_turns(book, &conversation.id, session)?))
    }

    /// A transcript 0.1 kept only in its runtime journal: the session the
    /// conversation names, or its latest one.
    fn journal_turns(
        &self,
        book: &str,
        conversation: &str,
        named: Option<String>,
    ) -> Result<Vec<Turn>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT id FROM {SESSIONS} WHERE conversation_id = ?1 AND project_id = ?2 ORDER BY created_at DESC, id DESC"
        ))?;
        let sessions: Vec<String> = stmt
            .query_map(params![conversation, book], |r| Ok(text(r.get_ref(0)?)))?
            .filter_map(|r| r.transpose())
            .collect::<rusqlite::Result<_>>()?;
        let Some(session) = named
            .filter(|n| sessions.contains(n))
            .or_else(|| sessions.into_iter().next())
        else {
            return Ok(Vec::new());
        };
        let mut stmt = self.conn.prepare(&format!(
            "SELECT role, content_json FROM {MESSAGES} WHERE session_id = ?1 ORDER BY ordinal"
        ))?;
        let rows = stmt.query_map([session], |r| {
            Ok((text(r.get_ref(0)?), text(r.get_ref(1)?)))
        })?;
        let mut turns = Vec::new();
        for row in rows {
            let (role, content) = row?;
            let content: Value = content
                .as_deref()
                .and_then(|c| serde_json::from_str(c).ok())
                .unwrap_or(Value::Null);
            journal_message(role.as_deref(), &content, &mut turns);
        }
        Ok(turns)
    }

    /// The conversations of `book` with `query` in their title or in what
    /// the author or the Agent wrote, in [`Self::conversations`]' order.
    /// Stops with [`Error::Cancelled`] as soon as `cancel` is raised.
    pub fn search(&self, book: &str, query: &str, cancel: &AtomicBool) -> Result<Vec<Found>> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let mut found = Vec::new();
        for conversation in self.conversations(book)? {
            if cancel.load(Ordering::Relaxed) {
                return Err(Error::Cancelled);
            }
            let turns = self.turns(book, &conversation)?.unwrap_or_default();
            let read = turns.iter().enumerate().filter_map(|(i, t)| match t {
                Turn::User(s) => Some((i, Speaker::User, s.as_str())),
                Turn::Agent(s) => Some((i, Speaker::Agent, s.as_str())),
                _ => None,
            });
            if let Some(matches) = find_in(&conversation.title, read, query) {
                found.push(Found {
                    conversation,
                    matches,
                });
            }
        }
        Ok(found)
    }
}

/// Whether the file is a whole SQLite database: its header, and as many
/// pages as the header says it has. A truncated file is refused before
/// SQLite reads a page that is not there.
fn whole(path: &Path) -> Result<()> {
    let mut file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    let mut header = [0u8; 100];
    if len < 100 || file.read_exact(&mut header).is_err() {
        return Err(Error::Damaged("no header"));
    }
    if &header[..16] != b"SQLite format 3\0" {
        return Err(Error::Damaged("not a database"));
    }
    let page = match u16::from_be_bytes([header[16], header[17]]) {
        1 => 65_536,
        n => u64::from(n),
    };
    let pages = u64::from(u32::from_be_bytes([
        header[28], header[29], header[30], header[31],
    ]));
    let counted = header[24..28] == header[92..96];
    if page < 512 || (counted && pages > 0 && len < pages * page) {
        return Err(Error::Damaged("truncated"));
    }
    Ok(())
}

fn text(v: rusqlite::types::ValueRef<'_>) -> Option<String> {
    match v {
        rusqlite::types::ValueRef::Text(t) => Some(String::from_utf8_lossy(t).into_owned()),
        _ => None,
    }
}

/// The turns of 0.1's rendered transcript (`messages_json`, an array of
/// `AgentChatMessage`). Anything else is no transcript.
fn displayed(json: &str) -> Vec<Turn> {
    let Ok(Value::Array(messages)) = serde_json::from_str::<Value>(json) else {
        return Vec::new();
    };
    let field = |m: &Value, k: &str| m.get(k).and_then(Value::as_str).map(str::to_owned);
    messages
        .iter()
        .filter_map(|m| {
            let turn = match m.get("kind").and_then(Value::as_str)? {
                "user" => Turn::User(field(m, "text")?),
                "assistant" => Turn::Agent(field(m, "text")?),
                "thinking" => Turn::Thinking(field(m, "text")?),
                "tool" => Turn::Tool(field(m, "name")?),
                "error" => Turn::Error(field(m, "text")?),
                // `todos` (the plan, replaced as it changed), `usage`.
                _ => return None,
            };
            (!blank(&turn)).then_some(turn)
        })
        .collect()
}

/// One runtime message as 0.1's sync shows it (`visibleMessages`): the
/// author's text, the assistant's blocks; tool results are not shown.
fn journal_message(role: Option<&str>, content: &Value, turns: &mut Vec<Turn>) {
    match role {
        Some("user") => {
            if let Some(text) = content.as_str() {
                turns.push(Turn::User(text.to_owned()));
            }
        }
        Some("assistant") => {
            for block in content.as_array().into_iter().flatten() {
                let s = |k: &str| block.get(k).and_then(Value::as_str).map(str::to_owned);
                let turn = match block.get("type").and_then(Value::as_str) {
                    Some("tool_call") => s("name").map(Turn::Tool),
                    Some("thinking") => s("text").map(Turn::Thinking),
                    Some("text") => s("text").map(Turn::Agent),
                    _ => None,
                };
                turns.extend(turn.filter(|t| !blank(t)));
            }
        }
        _ => {}
    }
}

fn blank(turn: &Turn) -> bool {
    match turn {
        Turn::User(s) | Turn::Agent(s) | Turn::Thinking(s) | Turn::Tool(s) | Turn::Error(s) => {
            s.trim().is_empty()
        }
    }
}

fn fold(c: char) -> char {
    c.to_lowercase().next().unwrap_or(c)
}

/// Every place `query` is in `text`, left to right, not overlapping, letter
/// case ignored (byte ranges of `text`).
pub fn find_all(text: &str, query: &str) -> Vec<Range<usize>> {
    let needle: Vec<char> = query.chars().map(fold).collect();
    if needle.is_empty() {
        return Vec::new();
    }
    let hay: Vec<(usize, char)> = text.char_indices().map(|(i, c)| (i, fold(c))).collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i + needle.len() <= hay.len() {
        if needle.iter().enumerate().all(|(k, c)| hay[i + k].1 == *c) {
            let end = hay.get(i + needle.len()).map_or(text.len(), |(at, _)| *at);
            out.push(hay[i].0..end);
            i += needle.len();
        } else {
            i += 1;
        }
    }
    out
}

/// Where `query` is in a conversation titled `title` whose turns of the
/// author and the Agent are `turns` (index, speaker, text); `None` where it
/// is not. The new conversations' search uses it too, so both read alike.
pub fn find_in<'a>(
    title: &str,
    turns: impl IntoIterator<Item = (usize, Speaker, &'a str)>,
    query: &str,
) -> Option<Matches> {
    let query = query.trim();
    let title_hits = find_all(title, query);
    let mut occurrences = title_hits.len();
    let mut first = None;
    for (turn, speaker, text) in turns {
        let hits = find_all(text, query);
        if hits.is_empty() {
            continue;
        }
        occurrences += hits.len();
        if first.is_none() {
            first = Some(Hit {
                turn,
                speaker,
                text: text.to_owned(),
                at: hits[0].clone(),
            });
        }
    }
    (occurrences > 0).then_some(Matches {
        title: title_hits,
        occurrences,
        first,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_every_place_ignoring_case_and_never_inside_a_character() {
        assert_eq!(find_all("TODO 和 todo", "todo"), vec![0..4, 9..13]);
        assert_eq!(find_all("精神胜利法，精神", "精神"), vec![0..6, 18..24]);
        assert_eq!(find_all("aaa", "aa"), vec![0..2]);
        assert!(find_all("阿Q", "").is_empty());
        assert!(find_all("阿", "阿Q").is_empty());
    }

    #[test]
    fn a_transcript_is_what_0_1_rendered_without_usage_or_the_plan() {
        let turns = displayed(
            r#"[{"kind":"user","text":"问"},{"kind":"thinking","text":"想"},
                {"kind":"tool","id":"1","name":"read_chapter","status":"ok"},
                {"kind":"todos","items":[]},{"kind":"assistant","text":"答"},
                {"kind":"assistant","text":"  "},{"kind":"error","text":"错"},
                {"kind":"usage","inputTokens":1},{"kind":"future","text":"x"}]"#,
        );
        assert_eq!(
            turns,
            vec![
                Turn::User("问".into()),
                Turn::Thinking("想".into()),
                Turn::Tool("read_chapter".into()),
                Turn::Agent("答".into()),
                Turn::Error("错".into()),
            ]
        );
        assert!(displayed("{").is_empty());
        assert!(displayed(r#"{"kind":"user"}"#).is_empty());
    }

    #[test]
    fn the_first_hit_is_the_first_turn_with_the_query() {
        let m = find_in(
            "赵太爷",
            [
                (0, Speaker::User, "没有"),
                (2, Speaker::Agent, "赵太爷，赵太爷"),
            ],
            " 赵太爷 ",
        )
        .unwrap();
        assert_eq!(m.title, vec![0..9]);
        assert_eq!(m.occurrences, 3);
        let first = m.first.unwrap();
        assert_eq!(
            (first.turn, first.speaker, first.at),
            (2, Speaker::Agent, 0..9)
        );
        assert!(find_in("无", [(0, Speaker::User, "无")], "有").is_none());
    }
}
