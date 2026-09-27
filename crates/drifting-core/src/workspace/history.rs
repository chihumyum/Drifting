//! Version history (时光机): device-local snapshots of a body's full Yjs
//! state with a preview and the entity's metadata at that moment. At most one
//! periodic capture per 15 minutes (closing and restoring bypass the interval),
//! never a byte-identical repeat; every version of the last hour survives,
//! then one per hour within 24 hours, one per day after that, and nothing
//! older than 30 days.
use super::*;

#[cfg(test)]
mod tests;

const INTERVAL_MS: i64 = 15 * 60_000;
const HOUR_MS: i64 = 3_600_000;
const DAY_MS: i64 = 24 * HOUR_MS;
/// Exact epoch milliseconds of an ISO timestamp column or parameter.
const EPOCH_MS: &str = "CAST(ROUND(unixepoch({},'subsec')*1000) AS INTEGER)";

fn epoch_ms(expression: &str) -> String {
    EPOCH_MS.replace("{}", expression)
}

fn integer_at(row: &[V], index: usize) -> Result<i64, String> {
    match &row[index] {
        V::Integer(value) => value.parse().map_err(|_| "Invalid timestamp".to_string()),
        _ => Err("Invalid timestamp".into()),
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub entity_kind: String,
    pub entity_id: String,
    pub created_at: String,
    pub meta: Value,
    /// The version's body as ProseMirror JSON, for previews.
    pub content_json: Option<String>,
}

pub struct SnapshotCapture<'a> {
    pub id: &'a str,
    pub entity_kind: &'a str,
    pub entity_id: &'a str,
    pub state: &'a [u8],
    pub content_json: Option<&'a str>,
    /// `periodic`, `close` or `restore`.
    pub reason: &'a str,
    pub now_iso: &'a str,
}

impl WorkspaceStore<'_> {
    /// Returns whether a row was written.
    pub fn capture_snapshot(
        &self,
        project_id: &str,
        capture: SnapshotCapture<'_>,
    ) -> Result<bool, String> {
        if !matches!(capture.reason, "periodic" | "close" | "restore") || !opaque(capture.id) {
            return Err("Invalid snapshot capture".into());
        }
        self.transaction(TransactionBehavior::Immediate, |tx| {
            let meta = match self.snapshot_meta(tx, project_id, capture.entity_kind, capture.entity_id)? {
                Some(meta) => meta,
                None => return Ok(false),
            };
            let latest = self.query(Some(tx), &format!(r#"
                SELECT state_blob,{}-{} FROM entity_snapshot_history
                WHERE project_id=? AND entity_kind=? AND entity_id=? ORDER BY created_at DESC,id DESC LIMIT 1
            "#, epoch_ms("?"), epoch_ms("created_at")), vec![text(capture.now_iso), text(project_id), text(capture.entity_kind), text(capture.entity_id)])?;
            if let Some(row) = latest.first() {
                if matches!(&row[0], V::Blob(bytes) if bytes.as_slice() == capture.state) {
                    return Ok(false);
                }
                if capture.reason == "periodic" && integer_at(row, 1)? < INTERVAL_MS {
                    return Ok(false);
                }
            }
            self.execute(tx, r#"
                INSERT INTO entity_snapshot_history(id,project_id,entity_kind,entity_id,state_blob,content_json,meta_json,created_at)
                VALUES (?,?,?,?,?,?,?,?)
            "#, vec![text(capture.id), text(project_id), text(capture.entity_kind), text(capture.entity_id),
                V::Blob(capture.state.to_vec()), capture.content_json.map(text).unwrap_or(V::Null),
                text(&meta.to_string()), text(capture.now_iso)])?;
            self.thin_snapshots(tx, project_id, capture.entity_kind, capture.entity_id, capture.now_iso)?;
            Ok(true)
        })
    }

    /// Whether a periodic capture would be written now, without encoding the
    /// state: no earlier version, or the latest is at least 15 minutes old.
    pub fn snapshot_due(
        &self,
        project_id: &str,
        entity_kind: &str,
        entity_id: &str,
        now_iso: &str,
    ) -> Result<bool, String> {
        let rows = self.query(None, &format!(r#"
            SELECT {}-{} FROM entity_snapshot_history
            WHERE project_id=? AND entity_kind=? AND entity_id=? ORDER BY created_at DESC,id DESC LIMIT 1
        "#, epoch_ms("?"), epoch_ms("created_at")), vec![text(now_iso), text(project_id), text(entity_kind), text(entity_id)])?;
        match rows.first() {
            None => Ok(true),
            Some(row) => Ok(integer_at(row, 0)? >= INTERVAL_MS),
        }
    }

    /// Newest first.
    pub fn snapshot_history(
        &self,
        project_id: &str,
        entity_kind: &str,
        entity_id: &str,
    ) -> Result<Vec<HistoryEntry>, String> {
        self.query(None, r#"
            SELECT id,entity_kind,entity_id,created_at,meta_json,content_json FROM entity_snapshot_history
            WHERE project_id=? AND entity_kind=? AND entity_id=? ORDER BY created_at DESC,id DESC
        "#, vec![text(project_id), text(entity_kind), text(entity_id)])?
        .iter()
        .map(|row| {
            Ok(HistoryEntry {
                id: string(row, 0)?,
                entity_kind: string(row, 1)?,
                entity_id: string(row, 2)?,
                created_at: string(row, 3)?,
                meta: match &row[4] {
                    V::Text(json) => serde_json::from_str(json).unwrap_or(Value::Null),
                    _ => Value::Null,
                },
                content_json: match &row[5] {
                    V::Text(json) => Some(json.clone()),
                    _ => None,
                },
            })
        })
        .collect()
    }

    /// The full state of one version, with its owner.
    pub fn snapshot_state(
        &self,
        project_id: &str,
        snapshot_id: &str,
    ) -> Result<(String, String, Vec<u8>), String> {
        let rows = self.query(None, "SELECT entity_kind,entity_id,state_blob FROM entity_snapshot_history WHERE id=? AND project_id=?",
            vec![text(snapshot_id), text(project_id)])?;
        let row = rows.first().ok_or("这个历史版本不存在")?;
        let V::Blob(state) = &row[2] else {
            return Err("Invalid snapshot state".into());
        };
        Ok((string(row, 0)?, string(row, 1)?, state.clone()))
    }

    /// The metadata a version records, or `None` when the entity is gone.
    fn snapshot_meta(
        &self,
        tx: u64,
        project_id: &str,
        kind: &str,
        id: &str,
    ) -> Result<Option<Value>, String> {
        let (sql, fields): (&str, &[&str]) = match kind {
            "node" => ("SELECT title,summary,writing_status FROM book_node WHERE id=? AND project_id=? AND deleted_at IS NULL",
                &["title", "summary", "writingStatus"]),
            "element" => ("SELECT name,summary,group_name,kv_json FROM element WHERE id=? AND project_id=? AND deleted_at IS NULL",
                &["name", "summary", "groupName", "kvJson"]),
            "storyline" => ("SELECT name,summary,kv_json FROM storylines WHERE id=? AND project_id=? AND deleted_at IS NULL",
                &["name", "summary", "kvJson"]),
            _ => return Err(format!("No version history for {kind} bodies")),
        };
        let rows = self.query(Some(tx), sql, vec![text(id), text(project_id)])?;
        Ok(rows.first().map(|row| {
            let mut meta = serde_json::Map::new();
            for (index, field) in fields.iter().enumerate() {
                meta.insert(
                    (*field).into(),
                    match &row[index] {
                        V::Text(value) => json!(value),
                        _ => Value::Null,
                    },
                );
            }
            Value::Object(meta)
        }))
    }

    fn thin_snapshots(
        &self,
        tx: u64,
        project_id: &str,
        kind: &str,
        id: &str,
        now: &str,
    ) -> Result<(), String> {
        self.execute(
            tx,
            &format!(
                "DELETE FROM entity_snapshot_history WHERE project_id=? AND {}-{}>{}",
                epoch_ms("?"),
                epoch_ms("created_at"),
                30 * DAY_MS
            ),
            vec![text(project_id), text(now)],
        )?;
        let rows = self.query(Some(tx), &format!(r#"
            SELECT id,{}-{},{} FROM entity_snapshot_history WHERE project_id=? AND entity_kind=? AND entity_id=?
            ORDER BY created_at DESC,id DESC
        "#, epoch_ms("?"), epoch_ms("created_at"), epoch_ms("created_at")), vec![text(now), text(project_id), text(kind), text(id)])?;
        let mut seen = std::collections::HashSet::new();
        for row in &rows {
            let (age, at) = (integer_at(row, 1)?, integer_at(row, 2)?);
            let bucket = if age < HOUR_MS {
                // Every version of the last hour survives, so a restore or a
                // close never hides the state it replaced.
                continue;
            } else if age < DAY_MS {
                format!("h:{}", at.div_euclid(HOUR_MS))
            } else {
                format!("d:{}", at.div_euclid(DAY_MS))
            };
            if !seen.insert(bucket) {
                self.execute(
                    tx,
                    "DELETE FROM entity_snapshot_history WHERE id=?",
                    vec![text(&string(row, 0)?)],
                )?;
            }
        }
        Ok(())
    }
}
