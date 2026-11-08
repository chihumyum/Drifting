use std::collections::BTreeMap;

use dr_doc::book::BorrowedBook;
use dr_model::id::BookId;
use dr_store::{Library, LocalTx, StoreError};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::*;

const CHUNK_BYTES: usize = 256 * 1024;
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    format: u32,
    revision: u64,
    chunks: usize,
    bytes: usize,
    hash: String,
    approx_tokens: u64,
    updated_by: Option<UpdatedBy>,
    updated_ms: Option<i64>,
    notice_tier: u8,
}
fn key(book: &BookId) -> String {
    format!("{book}/manifest")
}
fn chunk_key(book: &BookId, index: usize) -> String {
    format!("{book}/chunk/{index:016x}")
}
fn hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}
fn decode(raw: &str) -> MemoryResult<Manifest> {
    let m: Manifest = serde_json::from_str(raw).map_err(|_| MemoryError::Corrupt)?;
    if m.format != 1
        || m.revision == 0
        || m.notice_tier > 3
        || (m.chunks == 0) != (m.bytes == 0)
        || m.chunks > m.bytes
        || m.hash.len() != 64
        || !m.hash.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(MemoryError::Corrupt);
    }
    Ok(m)
}
fn empty(book: &BookId) -> Snapshot {
    Snapshot {
        book: book.clone(),
        revision: 0,
        exists: false,
        content_md: String::new(),
        approx_tokens: 0,
        updated_by: None,
        updated_ms: None,
    }
}
fn snapshot(book: &BookId, manifest: &Manifest, content: String) -> MemoryResult<Snapshot> {
    if content.len() != manifest.bytes || hash(&content) != manifest.hash {
        return Err(MemoryError::Corrupt);
    }
    Ok(Snapshot {
        book: book.clone(),
        revision: manifest.revision,
        exists: !content.is_empty(),
        content_md: content,
        approx_tokens: manifest.approx_tokens,
        updated_by: manifest.updated_by,
        updated_ms: manifest.updated_ms,
    })
}

/// A stable canonical book read; a later mutation checks the same head in
/// its SQLite transaction, so neither trash nor purge can race into an orphan.
fn live_head(lib: &Library, book: &BookId) -> MemoryResult<i64> {
    let id = format!("book:{book}");
    for _ in 0..3 {
        let before = lib
            .head(&id)?
            .ok_or_else(|| MemoryError::Invalid("book is unavailable".into()))?
            .seq;
        let doc = lib.load_copy(&id)?;
        let borrowed = BorrowedBook::new(&doc, book)
            .map_err(|_| MemoryError::Invalid("book is unavailable".into()))?;
        if borrowed.view().meta().deleted_at.is_some() {
            return Err(MemoryError::Invalid("book is in the trash".into()));
        }
        if lib.head(&id)?.is_some_and(|h| h.seq == before) {
            return Ok(before);
        }
    }
    Err(MemoryError::Invalid("book changed; read again".into()))
}
fn check_head(tx: &LocalTx<'_>, book: &BookId, expected: i64) -> MemoryResult<()> {
    let matches: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM loro_doc d JOIN loro_head h USING(doc_id) WHERE d.doc_id=?1 AND d.kind='book' AND h.seq=?2)",
        (format!("book:{book}"), expected), |r| r.get(0)
    ).map_err(StoreError::from)?;
    if !matches {
        return Err(MemoryError::Invalid(
            "book changed or was deleted; read again".into(),
        ));
    }
    Ok(())
}

fn transaction<T>(
    lib: &Library,
    f: impl FnOnce(&mut LocalTx<'_>) -> MemoryResult<T>,
) -> MemoryResult<T> {
    let mut failure = None;
    let result = lib.local_write(|tx| match f(tx) {
        Ok(value) => Ok(value),
        Err(error) => {
            failure = Some(error);
            Err(StoreError::Invalid {
                what: "working memory transaction",
                value: "aborted".into(),
            })
        }
    });
    match failure {
        Some(error) => Err(error),
        None => result.map_err(MemoryError::Store),
    }
}

/// One SELECT reads the entire scope from a single SQLite snapshot. In
/// particular, do not assemble chunks using separate Library::local_get calls.
pub fn load(lib: &Library, book: &BookId) -> MemoryResult<Snapshot> {
    let head = live_head(lib, book)?;
    let (current_head, rows) = lib.local_read(|conn| {
        let tx = conn.unchecked_transaction()?;
        let current: Option<i64> = tx.query_row(
            "SELECT (SELECT seq FROM loro_head WHERE doc_id=?1)",
            [format!("book:{book}")],
            |r| r.get(0),
        )?;
        let rows = {
            let mut query = tx.prepare(
                "SELECT key,value FROM local_state WHERE scope=?1 AND book_id=?2 AND (key=?3 OR key LIKE ?4) ORDER BY key",
            )?;
            query
                .query_map((SCOPE, book.as_str(), key(book), format!("{book}/chunk/%")), |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?
        };
        tx.commit()?;
        Ok((current, rows))
    })?;
    if current_head != Some(head) {
        return Err(MemoryError::Invalid("book changed; read again".into()));
    }
    let rows: BTreeMap<_, _> = rows.into_iter().collect();
    let Some(raw) = rows.get(&key(book)) else {
        if rows
            .keys()
            .any(|k| k.starts_with(&format!("{book}/chunk/")))
        {
            return Err(MemoryError::Corrupt);
        }
        return Ok(empty(book));
    };
    let manifest = decode(raw)?;
    let prefix = format!("{book}/chunk/");
    if rows.keys().filter(|k| k.starts_with(&prefix)).count() != manifest.chunks {
        return Err(MemoryError::Corrupt);
    }
    let mut content = String::new();
    for index in 0..manifest.chunks {
        let part = rows
            .get(&chunk_key(book, index))
            .ok_or(MemoryError::Corrupt)?;
        if part.is_empty() || part.len() > CHUNK_BYTES {
            return Err(MemoryError::Corrupt);
        }
        content.push_str(part);
    }
    snapshot(book, &manifest, content)
}

fn read_tx(tx: &LocalTx<'_>, book: &BookId) -> MemoryResult<(Manifest, Snapshot)> {
    let Some(raw) = tx.get_state(SCOPE, &key(book))? else {
        let count: i64 = tx
            .query_row(
                "SELECT count(*) FROM local_state WHERE scope=?1 AND book_id=?2 AND key LIKE ?3",
                (SCOPE, book.as_str(), format!("{book}/chunk/%")),
                |r| r.get(0),
            )
            .map_err(StoreError::from)?;
        if count != 0 {
            return Err(MemoryError::Corrupt);
        }
        return Ok((Manifest::default(), empty(book)));
    };
    let manifest = decode(&raw)?;
    let mut content = String::new();
    let count: i64 = tx
        .query_row(
            "SELECT count(*) FROM local_state WHERE scope=?1 AND book_id=?2 AND key LIKE ?3",
            (SCOPE, book.as_str(), format!("{book}/chunk/%")),
            |r| r.get(0),
        )
        .map_err(StoreError::from)?;
    if usize::try_from(count).ok() != Some(manifest.chunks) {
        return Err(MemoryError::Corrupt);
    }
    for i in 0..manifest.chunks {
        let part = tx
            .get_state(SCOPE, &chunk_key(book, i))?
            .ok_or(MemoryError::Corrupt)?;
        if part.is_empty() || part.len() > CHUNK_BYTES {
            return Err(MemoryError::Corrupt);
        }
        content.push_str(&part);
    }
    let value = snapshot(book, &manifest, content)?;
    Ok((manifest, value))
}
fn cas(snapshot: &Snapshot, expected: u64) -> MemoryResult<()> {
    if snapshot.revision != expected {
        Err(MemoryError::Conflict {
            expected,
            actual: snapshot.revision,
        })
    } else {
        Ok(())
    }
}
fn estimate(text: &str) -> u64 {
    // Conservative display estimate, not a provider tokenizer or a quota.
    let mut ascii = 0u64;
    let mut unicode = 0u64;
    for c in text.chars() {
        if c.is_ascii() {
            ascii += 1;
        } else {
            unicode += 1;
        }
    }
    ascii.div_ceil(4) + unicode
}
fn tier(tokens: u64) -> u8 {
    if tokens > 80_000 {
        3
    } else if tokens > 40_000 {
        2
    } else if tokens > 20_000 {
        1
    } else {
        0
    }
}
fn write_tx(
    tx: &mut LocalTx<'_>,
    book: &BookId,
    old: &Manifest,
    content: &str,
    by: UpdatedBy,
) -> MemoryResult<Snapshot> {
    let revision = old
        .revision
        .checked_add(1)
        .ok_or_else(|| MemoryError::Invalid("revision exhausted".into()))?;
    let mut parts = Vec::new();
    let mut remaining = content;
    while !remaining.is_empty() {
        let mut end = remaining.len().min(CHUNK_BYTES);
        while !remaining.is_char_boundary(end) {
            end -= 1;
        }
        parts.push(&remaining[..end]);
        remaining = &remaining[end..];
    }
    let tokens = estimate(content);
    let next = Manifest {
        format: 1,
        revision,
        chunks: parts.len(),
        bytes: content.len(),
        hash: hash(content),
        approx_tokens: tokens,
        updated_by: Some(by),
        updated_ms: Some(dr_store::now_ms()),
        notice_tier: old.notice_tier.min(tier(tokens)),
    };
    for (i, part) in parts.iter().enumerate() {
        tx.set_state(SCOPE, &chunk_key(book, i), part, Some(book.as_str()))?;
    }
    for i in parts.len()..old.chunks {
        tx.remove_state(SCOPE, &chunk_key(book, i))?;
    }
    tx.set_state(
        SCOPE,
        &key(book),
        &serde_json::to_string(&next).map_err(|_| MemoryError::Corrupt)?,
        Some(book.as_str()),
    )?;
    snapshot(book, &next, content.to_owned())
}
pub fn replace(
    lib: &Library,
    book: &BookId,
    expected_revision: u64,
    content: &str,
    by: UpdatedBy,
) -> MemoryResult<Snapshot> {
    let head = live_head(lib, book)?;
    transaction(lib, |tx| {
        check_head(tx, book, head)?;
        let (m, current) = read_tx(tx, book)?;
        cas(&current, expected_revision)?;
        write_tx(tx, book, &m, content, by)
    })
}
pub fn clear(
    lib: &Library,
    book: &BookId,
    expected_revision: u64,
    by: UpdatedBy,
) -> MemoryResult<Snapshot> {
    replace(lib, book, expected_revision, "", by)
}
fn apply(content: &str, edits: &[Edit]) -> MemoryResult<String> {
    if edits.is_empty() {
        return Err(MemoryError::Invalid("edits must not be empty".into()));
    }
    let mut next = content.to_owned();
    for edit in edits {
        let Some(start) = (!edit.old_text.is_empty())
            .then(|| next.find(&edit.old_text))
            .flatten()
        else {
            return Err(MemoryError::Invalid(
                "oldText does not occur; read again".into(),
            ));
        };
        // Include overlapping occurrences (match_indices alone misses these).
        let after = start
            + next[start..]
                .chars()
                .next()
                .expect("nonempty match")
                .len_utf8();
        if next[after..].contains(&edit.old_text) {
            return Err(MemoryError::Invalid(
                "oldText is ambiguous; include more context".into(),
            ));
        }
        next.replace_range(start..start + edit.old_text.len(), &edit.new_text);
    }
    Ok(next)
}
pub fn edit(
    lib: &Library,
    book: &BookId,
    expected_revision: u64,
    edits: &[Edit],
    by: UpdatedBy,
) -> MemoryResult<Snapshot> {
    let head = live_head(lib, book)?;
    transaction(lib, |tx| {
        check_head(tx, book, head)?;
        let (m, current) = read_tx(tx, book)?;
        cas(&current, expected_revision)?;
        let next = apply(
            if current.exists {
                &current.content_md
            } else {
                EMPTY_MARKDOWN
            },
            edits,
        )?;
        write_tx(tx, book, &m, &next, by)
    })
}

pub fn read_page(
    lib: &Library,
    book: &BookId,
    start: usize,
    limit: usize,
    expected_revision: Option<u64>,
) -> MemoryResult<Page> {
    if limit == 0 || limit > MAX_PAGE_CHARS {
        return Err(MemoryError::Invalid(
            "limit must be 1..64000 characters".into(),
        ));
    }
    let s = load(lib, book)?;
    if let Some(expected) = expected_revision {
        cas(&s, expected)?;
    }
    let text = if s.exists {
        s.content_md.as_str()
    } else {
        EMPTY_MARKDOWN
    };
    let total_chars = text.chars().count();
    if start > total_chars {
        return Err(MemoryError::Invalid("start exceeds document length".into()));
    }
    let content_md: String = text.chars().skip(start).take(limit).collect();
    let end = start + content_md.chars().count();
    Ok(Page {
        filename: FILENAME.into(),
        book: book.clone(),
        info: MutationInfo::from(&s),
        start,
        end,
        total_chars,
        has_more: end < total_chars,
        content_md,
    })
}

/// Claim only at an actual turn boundary. Reads and proactive previews never
/// consume a notice or mutate the document. Shrinking rearms crossed tiers.
pub fn take_notice(lib: &Library, book: &BookId, expected_revision: u64) -> MemoryResult<bool> {
    let head = live_head(lib, book)?;
    transaction(lib, |tx| {
        check_head(tx, book, head)?;
        let (mut m, s) = read_tx(tx, book)?;
        cas(&s, expected_revision)?;
        let current = tier(s.approx_tokens);
        let notice = current == 3 || current > m.notice_tier;
        if m.revision > 0 && m.notice_tier != current {
            m.notice_tier = current;
            tx.set_state(
                SCOPE,
                &key(book),
                &serde_json::to_string(&m).map_err(|_| MemoryError::Corrupt)?,
                Some(book.as_str()),
            )?;
        }
        Ok(notice)
    })
}

#[derive(Serialize, Deserialize)]
struct Receipt {
    request: String,
    result: MutationInfo,
}
pub fn edit_once(
    lib: &Library,
    book: &BookId,
    actor: &dr_workspace::Actor,
    expected: u64,
    edits: &[Edit],
) -> MemoryResult<MutationInfo> {
    let dr_workspace::Actor::Agent {
        session,
        turn,
        call,
    } = actor
    else {
        return Err(MemoryError::Invalid(
            "memory tool requires runtime actor".into(),
        ));
    };
    let identity =
        serde_json::to_string(&(book, session, turn, call)).map_err(|_| MemoryError::Corrupt)?;
    let receipt_key = format!("{book}/receipt/{}", hash(&identity));
    let request =
        hash(&serde_json::to_string(&(expected, edits)).map_err(|_| MemoryError::Corrupt)?);
    let head = live_head(lib, book)?;
    transaction(lib, |tx| {
        check_head(tx, book, head)?;
        if let Some(raw) = tx.get_state(SCOPE, &receipt_key)? {
            let old: Receipt = serde_json::from_str(&raw).map_err(|_| MemoryError::Corrupt)?;
            if old.request != request {
                return Err(MemoryError::Invalid(
                    "runtime call identity reused with different edits".into(),
                ));
            }
            return Ok(old.result);
        }
        let (m, s) = read_tx(tx, book)?;
        cas(&s, expected)?;
        let next = apply(
            if s.exists {
                &s.content_md
            } else {
                EMPTY_MARKDOWN
            },
            edits,
        )?;
        let result = MutationInfo::from(&write_tx(tx, book, &m, &next, UpdatedBy::Agent)?);
        let receipt = Receipt {
            request,
            result: result.clone(),
        };
        tx.set_state(
            SCOPE,
            &receipt_key,
            &serde_json::to_string(&receipt).map_err(|_| MemoryError::Corrupt)?,
            Some(book.as_str()),
        )?;
        Ok(result)
    })
}
