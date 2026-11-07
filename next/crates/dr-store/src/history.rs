//! History labels: the versions the author can go back to.
//!
//! The rules of the 0.1 client's snapshot history
//! (`src/renderer/services/snapshot-history.service.ts`,
//! `crates/drifting-core/src/workspace/history.rs`), applied to labels on
//! Loro versions instead of stored copies:
//!
//! - `periodic`: at most one per document per 15 minutes, after a commit;
//! - `close` and `restore` skip the interval; `close` only when that opening
//!   committed something that earns labels (not only genesis, the import,
//!   repairs or outside writes: [`records_periodic`]);
//! - `agent:<session>/<turn>` marks the version just before an Agent turn's
//!   first write (once per turn, whatever else is on that version), so the
//!   whole turn can be undone;
//! - otherwise never two labels in a row on the same version;
//! - every label of the last hour is kept, then one per hour within a day,
//!   one per day after that, and none older than 30 days.
//!
//! The history itself is never trimmed (no shallow snapshots), so a label is
//! only a pointer: a version is read with [`crate::Library::load_copy_at`].
//! Each label also records the book document's version at that moment
//! (`book_frontiers`), so one entity can be restored with its metadata.
//!
//! **Who changed what** is read from the Loro changes themselves (peer,
//! timestamp, commit message: [`changes_since`]), not from `loro_update`,
//! whose rows compaction deletes. Agent, Markdown-mirror and import commits
//! carry their origin as the commit message. All of this, like history
//! labels and Agent settlements, depends on never trimming history.

use loro::{Frontiers, ID, LoroDoc};
use rusqlite::{Connection, OptionalExtension, params};

use crate::Library;
use crate::error::{Result, StoreError};
use crate::origin::Origin;

pub mod labels {
    pub const PERIODIC: &str = "periodic";
    pub const CLOSE: &str = "close";
    pub const RESTORE: &str = "restore";
}

pub const PERIODIC_INTERVAL_MS: i64 = 15 * 60_000;
pub const HOUR_MS: i64 = 3_600_000;
pub const DAY_MS: i64 = 24 * HOUR_MS;
pub const RETENTION_MS: i64 = 30 * DAY_MS;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoryLabel {
    pub id: i64,
    pub doc_id: String,
    pub frontiers: Frontiers,
    /// The book document's stored version when the label was written, if
    /// the document belongs to a book whose document is stored.
    pub book_frontiers: Option<Frontiers>,
    pub label: String,
    pub ts: i64,
    /// Exempt from thinning and the 30-day retention.
    pub keep: bool,
}

/// Whether a label written with [`Library::label_at`] follows the usual
/// retention (thinned, gone after 30 days) or is kept.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum LabelRetention {
    #[default]
    Thinned,
    Kept,
}

/// A history point to write at a given version and time.
#[derive(Clone, Debug)]
pub struct NewLabel<'a> {
    pub doc_id: &'a str,
    pub frontiers: &'a Frontiers,
    pub label: &'a str,
    pub ts_ms: i64,
    pub retention: LabelRetention,
}

/// One Loro change: who wrote it (peer), when (seconds), with which commit
/// message (`agent:<s>/<t>`, `mirror`, `import`, or none for the author and
/// for remote authors).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChangeSummary {
    pub peer: u64,
    pub counter: i32,
    pub len: usize,
    pub timestamp: i64,
    pub message: Option<String>,
}

/// The changes in `doc` made at or after `since_s` (Unix seconds), oldest
/// first. Walks change metadata only; for an open document call it inside
/// `DocHandle::read`.
pub fn changes_since(doc: &LoroDoc, since_s: i64) -> Vec<ChangeSummary> {
    let mut out = Vec::new();
    for (peer, end) in doc.oplog_vv().iter() {
        let mut counter = 0;
        while counter < *end {
            let Some(change) = doc.get_change(ID::new(*peer, counter)) else {
                break;
            };
            let start = change.id.counter;
            if change.timestamp >= since_s {
                out.push(ChangeSummary {
                    peer: *peer,
                    counter: start,
                    len: change.len,
                    timestamp: change.timestamp,
                    message: change.message.as_deref().map(str::to_string),
                });
            }
            counter = start + change.len.max(1) as i32;
        }
    }
    out.sort_by_key(|c| (c.timestamp, c.peer, c.counter));
    out
}

/// Whether commits of `origin` earn periodic labels. Genesis, the 0.1
/// import, dr-doc's repairs and stray outside writes do not.
pub fn records_periodic(origin: &Origin) -> bool {
    !matches!(
        origin,
        Origin::Genesis | Origin::Import | Origin::Repair | Origin::Outside
    )
}

/// Whether a periodic label is due, given the latest label's time.
pub fn periodic_due(latest_ts: Option<i64>, now: i64) -> bool {
    latest_ts.is_none_or(|ts| now - ts >= PERIODIC_INTERVAL_MS)
}

/// Which labels thinning removes: `(id, ts)` rows of one document, any
/// order. Keeps the newest label of each hour (within a day) or day.
pub fn thinning_plan(rows: &[(i64, i64)], now: i64) -> Vec<i64> {
    let mut rows = rows.to_vec();
    rows.sort_by(|a, b| b.1.cmp(&a.1).then(b.0.cmp(&a.0)));
    let mut seen = std::collections::HashSet::new();
    let mut remove = Vec::new();
    for (id, ts) in rows {
        let age = now - ts;
        if age > RETENTION_MS {
            remove.push(id);
            continue;
        }
        let bucket = if age < HOUR_MS {
            continue;
        } else if age < DAY_MS {
            (0, ts.div_euclid(HOUR_MS))
        } else {
            (1, ts.div_euclid(DAY_MS))
        };
        if !seen.insert(bucket) {
            remove.push(id);
        }
    }
    remove
}

/// Insert a label, recording the book document's stored frontiers with it.
pub(crate) fn insert(
    conn: &Connection,
    doc_id: &str,
    book_doc: Option<&str>,
    frontiers: &[u8],
    label: &str,
    ts: i64,
) -> Result<()> {
    conn.prepare_cached(
        "INSERT INTO history_label (doc_id, frontiers, book_frontiers, label, ts)
         VALUES (?1, ?2, (SELECT frontiers FROM loro_head WHERE doc_id = ?3), ?4, ?5)",
    )?
    .execute(params![doc_id, frontiers, book_doc, label, ts])?;
    Ok(())
}

pub(crate) fn thin(conn: &Connection, doc_id: &str, now: i64) -> Result<usize> {
    let rows: Vec<(i64, i64)> = conn
        .prepare_cached("SELECT id, ts FROM history_label WHERE doc_id = ?1 AND keep = 0")?
        .query_map([doc_id], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let remove = thinning_plan(&rows, now);
    let mut stmt = conn.prepare_cached("DELETE FROM history_label WHERE id = ?1")?;
    for id in &remove {
        stmt.execute([id])?;
    }
    Ok(remove.len())
}

/// The latest label of a document: (time, encoded frontiers, label).
pub(crate) fn latest(conn: &Connection, doc_id: &str) -> Result<Option<(i64, Vec<u8>, String)>> {
    Ok(conn
        .prepare_cached(
            "SELECT ts, frontiers, label FROM history_label WHERE doc_id = ?1 ORDER BY ts DESC, id DESC LIMIT 1",
        )?
        .query_row([doc_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .optional()?)
}

impl Library {
    /// A document's history labels, newest first.
    pub fn history(&self, doc_id: &str) -> Result<Vec<HistoryLabel>> {
        let conn = self.reader();
        let mut stmt = conn.prepare_cached(
            "SELECT id, doc_id, frontiers, book_frontiers, label, ts, keep FROM history_label
             WHERE doc_id = ?1 ORDER BY ts DESC, id DESC",
        )?;
        let rows = stmt
            .query_map([doc_id], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Vec<u8>>(2)?,
                    r.get::<_, Option<Vec<u8>>>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, i64>(5)?,
                    r.get::<_, bool>(6)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|(id, doc_id, f, bf, label, ts, keep)| {
                Ok(HistoryLabel {
                    id,
                    doc_id,
                    frontiers: Frontiers::decode(&f)?,
                    book_frontiers: bf.map(|b| Frontiers::decode(&b)).transpose()?,
                    label,
                    ts,
                    keep,
                })
            })
            .collect()
    }

    /// Drop labels past retention for every document (they also go each
    /// time a document gets a new label).
    pub fn prune_history(&self, now: i64) -> Result<usize> {
        Ok(self.writer().execute(
            "DELETE FROM history_label WHERE ts < ?1 AND keep = 0",
            [now - RETENTION_MS],
        )?)
    }

    /// Write a history point at `frontiers`, dated `ts_ms` (for example a
    /// version an import replays from 0.1). The book document's current
    /// stored version is recorded with it. With [`LabelRetention::Thinned`]
    /// the usual thinning runs at once, so a point older than 30 days is not
    /// kept. Returns whether the label is stored.
    pub fn label_at(
        &self,
        doc_id: &str,
        frontiers: &Frontiers,
        label: &str,
        ts_ms: i64,
        retention: LabelRetention,
    ) -> Result<bool> {
        Ok(self.label_many(&[NewLabel {
            doc_id,
            frontiers,
            label,
            ts_ms,
            retention,
        }])? == 1)
    }

    /// [`Self::label_at`] for many points, in one transaction. Returns how
    /// many are stored after thinning.
    pub fn label_many(&self, labels: &[NewLabel<'_>]) -> Result<usize> {
        let mut docs: Vec<&str> = Vec::new();
        let mut ids = Vec::with_capacity(labels.len());
        {
            let conn = self.writer();
            let tx = conn.unchecked_transaction()?;
            for l in labels {
                if l.label.is_empty() || l.label.chars().count() > 200 {
                    return Err(StoreError::invalid("history label", l.label));
                }
                let registered: bool = tx
                    .prepare_cached("SELECT EXISTS(SELECT 1 FROM loro_doc WHERE doc_id = ?1)")?
                    .query_row([l.doc_id], |r| r.get(0))?;
                if !registered {
                    return Err(StoreError::NotFound(l.doc_id.to_string()));
                }
                tx.prepare_cached(
                    "INSERT INTO history_label (doc_id, frontiers, book_frontiers, label, ts, keep)
                     VALUES (?1, ?2,
                       (SELECT h.frontiers FROM loro_doc d JOIN loro_head h ON h.doc_id = 'book:' || d.book_id
                        WHERE d.doc_id = ?1),
                       ?3, ?4, ?5)",
                )?
                .execute(params![
                    l.doc_id,
                    l.frontiers.encode(),
                    l.label,
                    l.ts_ms,
                    l.retention == LabelRetention::Kept
                ])?;
                ids.push(tx.last_insert_rowid());
                if !docs.contains(&l.doc_id) {
                    docs.push(l.doc_id);
                }
            }
            let now = crate::now_ms();
            for doc in &docs {
                thin(&tx, doc, now)?;
            }
            tx.commit()?;
        }
        let kept = {
            let conn = self.reader();
            let mut stmt =
                conn.prepare_cached("SELECT EXISTS(SELECT 1 FROM history_label WHERE id = ?1)")?;
            let mut n = 0;
            for id in &ids {
                if stmt.query_row([id], |r| r.get::<_, bool>(0))? {
                    n += 1;
                }
            }
            n
        };
        for doc in docs {
            self.notify_local(crate::LocalChange::new(
                "history_label",
                doc,
                crate::LocalChangeKind::Insert,
            ));
        }
        Ok(kept)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_000 * DAY_MS;

    #[test]
    fn periodic_interval() {
        assert!(periodic_due(None, NOW));
        assert!(!periodic_due(Some(NOW - PERIODIC_INTERVAL_MS + 1), NOW));
        assert!(periodic_due(Some(NOW - PERIODIC_INTERVAL_MS), NOW));
        assert!(records_periodic(&Origin::User));
        assert!(records_periodic(&Origin::agent("s", 1)));
        assert!(!records_periodic(&Origin::Import));
    }

    #[test]
    fn thinning_keeps_the_last_hour_then_one_per_hour_then_one_per_day() {
        let mut rows = Vec::new();
        let mut id = 0;
        let mut add = |ts: i64| {
            id += 1;
            rows.push((id, ts));
            id
        };
        // The last hour: all kept.
        let recent: Vec<i64> = (0..4).map(|i| add(NOW - i * 10 * 60_000)).collect();
        // Two in one hour two hours ago: the newer kept.
        let h_new = add(NOW - 2 * HOUR_MS - 60_000);
        let h_old = add(NOW - 2 * HOUR_MS - 20 * 60_000);
        // Two in one day five days ago: the newer kept.
        let day = (NOW - 5 * DAY_MS).div_euclid(DAY_MS) * DAY_MS;
        let d_new = add(day + 20 * HOUR_MS);
        let d_old = add(day + HOUR_MS);
        // Past retention.
        let old = add(NOW - 31 * DAY_MS);
        let remove = thinning_plan(&rows, NOW);
        for keep in recent.iter().chain([&h_new, &d_new]) {
            assert!(!remove.contains(keep), "{keep} kept");
        }
        for gone in [h_old, d_old, old] {
            assert!(remove.contains(&gone), "{gone} removed");
        }
    }
}
