//! History labels: the versions the author can go back to.
//!
//! The rules of the 0.1 client's snapshot history
//! (`src/renderer/services/snapshot-history.service.ts`,
//! `crates/drifting-core/src/workspace/history.rs`), applied to labels on
//! Loro versions instead of stored copies:
//!
//! - `periodic`: at most one per document per 15 minutes, after a commit;
//! - `close` and `restore` skip the interval;
//! - `agent:<session>/<turn>` marks the version just before an Agent turn's
//!   first write (once per turn, whatever else is on that version), so the
//!   whole turn can be undone;
//! - otherwise never two labels in a row on the same version;
//! - every label of the last hour is kept, then one per hour within a day,
//!   one per day after that, and none older than 30 days.
//!
//! The history itself is never trimmed (no shallow snapshots), so a label is
//! only a pointer: a version is read with [`crate::Library::load_copy_at`].

use loro::Frontiers;
use rusqlite::{Connection, OptionalExtension, params};

use crate::Library;
use crate::error::Result;
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
    pub label: String,
    pub ts: i64,
}

/// Whether commits of `origin` earn periodic labels. Genesis, the 0.1
/// import and stray outside writes do not.
pub fn records_periodic(origin: &Origin) -> bool {
    !matches!(origin, Origin::Genesis | Origin::Import | Origin::Outside)
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

pub(crate) fn insert(
    conn: &Connection,
    doc_id: &str,
    frontiers: &[u8],
    label: &str,
    ts: i64,
) -> Result<()> {
    conn.prepare_cached(
        "INSERT INTO history_label (doc_id, frontiers, label, ts) VALUES (?1, ?2, ?3, ?4)",
    )?
    .execute(params![doc_id, frontiers, label, ts])?;
    Ok(())
}

pub(crate) fn thin(conn: &Connection, doc_id: &str, now: i64) -> Result<usize> {
    let rows: Vec<(i64, i64)> = conn
        .prepare_cached("SELECT id, ts FROM history_label WHERE doc_id = ?1")?
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
            "SELECT id, doc_id, frontiers, label, ts FROM history_label
             WHERE doc_id = ?1 ORDER BY ts DESC, id DESC",
        )?;
        let rows = stmt
            .query_map([doc_id], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Vec<u8>>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|(id, doc_id, f, label, ts)| {
                Ok(HistoryLabel {
                    id,
                    doc_id,
                    frontiers: Frontiers::decode(&f)?,
                    label,
                    ts,
                })
            })
            .collect()
    }

    /// Drop labels past retention for every document (they also go each
    /// time a document gets a new label).
    pub fn prune_history(&self, now: i64) -> Result<usize> {
        Ok(self.writer().execute(
            "DELETE FROM history_label WHERE ts < ?1",
            [now - RETENTION_MS],
        )?)
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
