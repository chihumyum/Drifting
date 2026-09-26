//! SQLite primitives shared by native prose owners and the authored journal.
//! This layer does not interpret Yjs bytes or prove live-document coverage.
//! Ordinary authored writes must append their immutable sync mutation in the
//! same caller transaction; remote reducers must not use the authored journal.
use crate::database::{DatabaseGateway, DatabaseValue, TransactionBehavior};
use std::sync::atomic::{AtomicU64, Ordering};

const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
static NEXT_SAVEPOINT: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProseSnapshot {
    pub doc_id: String,
    pub state_blob: Vec<u8>,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProseUpdate {
    pub id: u64,
    pub doc_id: String,
    pub update_blob: Vec<u8>,
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentIdentity {
    pub session_id: String,
    pub turn_id: String,
    pub call_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RevisionSource {
    User,
    Remote,
    System,
    Legacy,
    Agent { collaborator: Option<AgentIdentity> },
}

impl RevisionSource {
    fn fields(&self) -> Result<(&str, Option<&AgentIdentity>), String> {
        match self {
            Self::User => Ok(("user", None)),
            Self::Remote => Ok(("remote", None)),
            Self::System => Ok(("system", None)),
            Self::Legacy => Ok(("legacy", None)),
            Self::Agent { collaborator } => {
                if let Some(identity) = collaborator {
                    for value in [&identity.session_id, &identity.turn_id, &identity.call_id] {
                        nonempty(value, "Agent revision identity")?;
                    }
                }
                Ok(("agent", collaborator.as_ref()))
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RevisionProvenance {
    pub doc_id: String,
    pub revision: u64,
    pub source: RevisionSource,
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppendedUpdate {
    pub update_id: u64,
    pub previous_revision: u64,
    pub revision: u64,
}

pub struct ProseRepository<'a> {
    gateway: &'a DatabaseGateway,
    client: &'a str,
}

impl<'a> ProseRepository<'a> {
    pub fn new(gateway: &'a DatabaseGateway, client: &'a str) -> Self {
        Self { gateway, client }
    }

    pub fn get_snapshot(
        &self,
        doc_id: &str,
        transaction: Option<u64>,
    ) -> Result<Option<ProseSnapshot>, String> {
        nonempty(doc_id, "Document identity")?;
        let rows = self.gateway.query(
            "SELECT document_id, state_blob, updated_at FROM yjs_snapshots WHERE document_id = ?".into(),
            vec![text(doc_id)], transaction, self.client.into(),
        )?.rows;
        rows.into_iter().next().map(|row| {
            let [DatabaseValue::Text(doc_id), DatabaseValue::Blob(state_blob), DatabaseValue::Text(updated_at)] = row.as_slice() else {
                return Err("Invalid persisted prose snapshot".into());
            };
            Ok(ProseSnapshot { doc_id: doc_id.clone(), state_blob: state_blob.clone(), updated_at: updated_at.clone() })
        }).transpose()
    }

    /// Actual stored row IDs, in ascending order. IDs are global and may have
    /// gaps; they are replay watermarks, never semantic document revisions.
    pub fn list_updates(
        &self,
        doc_id: &str,
        since_id: Option<u64>,
        transaction: Option<u64>,
    ) -> Result<Vec<ProseUpdate>, String> {
        nonempty(doc_id, "Document identity")?;
        if let Some(id) = since_id {
            safe(id, "Update watermark")?;
        }
        let (predicate, mut parameters) = ("document_id = ?", vec![text(doc_id)]);
        let predicate = if let Some(id) = since_id {
            parameters.push(integer(id));
            format!("{predicate} AND id > ?")
        } else {
            predicate.into()
        };
        self.gateway.query(
            format!("SELECT id, document_id, update_blob, created_at FROM yjs_updates WHERE {predicate} ORDER BY id ASC"),
            parameters, transaction, self.client.into(),
        )?.rows.into_iter().map(|row| {
            let [id, DatabaseValue::Text(doc_id), DatabaseValue::Blob(update_blob), DatabaseValue::Text(created_at)] = row.as_slice() else {
                return Err("Invalid persisted prose update".into());
            };
            let id = read_integer(id, "Update row identity")?;
            if id == 0 { return Err("Update row identity must be positive".into()); }
            Ok(ProseUpdate { id, doc_id: doc_id.clone(), update_blob: update_blob.clone(), created_at: created_at.clone() })
        }).collect()
    }

    pub fn get_revision(&self, doc_id: &str, transaction: Option<u64>) -> Result<u64, String> {
        nonempty(doc_id, "Document identity")?;
        let rows = self
            .gateway
            .query(
                "SELECT revision FROM yjs_document_revision WHERE document_id = ?".into(),
                vec![text(doc_id)],
                transaction,
                self.client.into(),
            )?
            .rows;
        match rows.as_slice() {
            [] => Ok(0),
            [row] if row.len() == 1 => read_integer(&row[0], "Document revision"),
            _ => Err("Invalid persisted document revision".into()),
        }
    }

    pub fn list_revision_provenance(
        &self,
        doc_id: &str,
        after_revision: u64,
        transaction: Option<u64>,
    ) -> Result<Vec<RevisionProvenance>, String> {
        nonempty(doc_id, "Document identity")?;
        safe(after_revision, "Revision watermark")?;
        self.gateway.query(
            "SELECT document_id, revision, source_kind, agent_session_id, agent_turn_id, agent_call_id, created_at FROM yjs_document_revision_provenance WHERE document_id = ? AND revision > ? ORDER BY revision ASC".into(),
            vec![text(doc_id), integer(after_revision)], transaction, self.client.into(),
        )?.rows.into_iter().map(|row| {
            let [DatabaseValue::Text(doc_id), revision, DatabaseValue::Text(kind), session, turn, call, DatabaseValue::Text(created_at)] = row.as_slice() else {
                return Err("Invalid persisted prose revision provenance".into());
            };
            let collaborator = match (optional_text(session)?, optional_text(turn)?, optional_text(call)?) {
                (Some(session_id), Some(turn_id), Some(call_id)) => Some(AgentIdentity { session_id, turn_id, call_id }),
                _ => None,
            };
            // Match the existing reader's treatment of older/unknown source
            // labels without rewriting the underlying provenance row.
            let source = match kind.as_str() {
                "user" => RevisionSource::User,
                "remote" => RevisionSource::Remote,
                "system" => RevisionSource::System,
                "agent" => RevisionSource::Agent { collaborator },
                _ => RevisionSource::Legacy,
            };
            Ok(RevisionProvenance { doc_id: doc_id.clone(), revision: read_integer(revision, "Provenance revision")?, source, created_at: created_at.clone() })
        }).collect()
    }

    /// Low-level append. The supplied transaction lets an authored journal or
    /// remote reducer commit its receipt/mutation atomically with these rows.
    /// Passing None creates only a storage transaction, not an authored journal.
    pub fn append_update(
        &self,
        doc_id: &str,
        bytes: &[u8],
        source: &RevisionSource,
        now: &str,
        expected_revision: Option<u64>,
        transaction: Option<u64>,
    ) -> Result<AppendedUpdate, String> {
        validate_write(doc_id, bytes, now)?;
        let (kind, collaborator) = source.fields()?;
        if let Some(expected) = expected_revision {
            safe(expected, "Expected revision")?;
        }
        self.atomic(transaction, |transaction| {
            self.ensure_revision(doc_id, now, transaction)?;
            let previous_revision = self.get_revision(doc_id, Some(transaction))?;
            if expected_revision.is_some_and(|expected| expected != previous_revision) {
                return Err(format!("STALE_REVISION: document {doc_id} expected {}, received {previous_revision}", expected_revision.unwrap()));
            }
            let revision = previous_revision.checked_add(1).ok_or("Document revision overflow")?;
            safe(revision, "Document revision")?;
            let advanced = self.gateway.execute(
                "UPDATE yjs_document_revision SET revision = ?, updated_at = ? WHERE document_id = ? AND revision = ?".into(),
                vec![integer(revision), text(now), text(doc_id), integer(previous_revision)], Some(transaction), self.client.into(),
            )?;
            if advanced.changes != 1 { return Err("Document revision changed during append".into()); }
            let inserted = self.gateway.execute(
                "INSERT INTO yjs_updates (document_id, update_blob, created_at) VALUES (?, ?, ?)".into(),
                vec![text(doc_id), DatabaseValue::Blob(bytes.to_vec()), text(now)], Some(transaction), self.client.into(),
            )?;
            let update_id = read_integer(&inserted.last_insert_rowid, "Update row identity")?;
            if update_id == 0 { return Err("Update row identity must be positive".into()); }
            self.gateway.execute(
                "INSERT INTO yjs_document_revision_provenance (document_id, revision, source_kind, agent_session_id, agent_turn_id, agent_call_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)".into(),
                vec![text(doc_id), integer(revision), text(kind), nullable(collaborator.map(|a| a.session_id.as_str())), nullable(collaborator.map(|a| a.turn_id.as_str())), nullable(collaborator.map(|a| a.call_id.as_str())), text(now)], Some(transaction), self.client.into(),
            )?;
            Ok(AppendedUpdate { update_id, previous_revision, revision })
        })
    }

    /// A durability snapshot never advances semantic revision or provenance.
    /// Only a first snapshot without an append initializes revision zero.
    pub fn save_snapshot(
        &self,
        doc_id: &str,
        bytes: &[u8],
        now: &str,
        transaction: Option<u64>,
    ) -> Result<(), String> {
        validate_write(doc_id, bytes, now)?;
        self.atomic(transaction, |transaction| {
            self.write_snapshot(doc_id, bytes, now, transaction)
        })
    }

    /// The caller must have replayed every stored row <= covered_id into these
    /// exact snapshot bytes and committed their immutable journal/receipts.
    /// Requiring the caller's transaction allows comment CAS and other owned
    /// projections to succeed or roll back with both snapshot and narrow prune.
    pub fn snapshot_and_prune(
        &self,
        doc_id: &str,
        bytes: &[u8],
        covered_id: u64,
        now: &str,
        transaction: u64,
    ) -> Result<u64, String> {
        validate_write(doc_id, bytes, now)?;
        safe(covered_id, "Snapshot coverage watermark")?;
        self.atomic(Some(transaction), |transaction| {
            self.write_snapshot(doc_id, bytes, now, transaction)?;
            self.delete_updates_up_to(doc_id, covered_id, transaction)
        })
    }

    /// Explicit phase of a caller-controlled snapshot transaction, for owners
    /// that need observable crash boundaries between snapshot and pruning.
    /// The caller must save the exact covering snapshot in this transaction
    /// before invoking this method, and roll back the whole transaction on
    /// failure. Coverage comes from replay, never a MAX(id) query alone.
    pub fn delete_updates_up_to(
        &self,
        doc_id: &str,
        covered_id: u64,
        transaction: u64,
    ) -> Result<u64, String> {
        nonempty(doc_id, "Document identity")?;
        safe(covered_id, "Snapshot coverage watermark")?;
        if covered_id == 0 {
            return Ok(0);
        }
        Ok(self
            .gateway
            .execute(
                "DELETE FROM yjs_updates WHERE document_id = ? AND id <= ?".into(),
                vec![text(doc_id), integer(covered_id)],
                Some(transaction),
                self.client.into(),
            )?
            .changes)
    }

    fn ensure_revision(&self, doc_id: &str, now: &str, transaction: u64) -> Result<(), String> {
        self.gateway.execute(
            "INSERT INTO yjs_document_revision (document_id, revision, updated_at) VALUES (?, 0, ?) ON CONFLICT(document_id) DO NOTHING".into(),
            vec![text(doc_id), text(now)], Some(transaction), self.client.into(),
        )?;
        Ok(())
    }

    fn write_snapshot(
        &self,
        doc_id: &str,
        bytes: &[u8],
        now: &str,
        transaction: u64,
    ) -> Result<(), String> {
        self.gateway.execute(
            "INSERT INTO yjs_snapshots (document_id, state_blob, updated_at) VALUES (?, ?, ?) ON CONFLICT(document_id) DO UPDATE SET state_blob = excluded.state_blob, updated_at = excluded.updated_at".into(),
            vec![text(doc_id), DatabaseValue::Blob(bytes.to_vec()), text(now)], Some(transaction), self.client.into(),
        )?;
        self.ensure_revision(doc_id, now, transaction)
    }

    fn atomic<T>(
        &self,
        caller: Option<u64>,
        work: impl FnOnce(u64) -> Result<T, String>,
    ) -> Result<T, String> {
        if let Some(transaction) = caller {
            let name = format!("prose_{}", NEXT_SAVEPOINT.fetch_add(1, Ordering::Relaxed));
            let statement = |sql| {
                self.gateway
                    .execute(sql, vec![], Some(transaction), self.client.into())
            };
            statement(format!("SAVEPOINT {name}"))?;
            let result = work(transaction).and_then(|value| {
                statement(format!("RELEASE SAVEPOINT {name}"))?;
                Ok(value)
            });
            if result.is_err() {
                let _ = statement(format!("ROLLBACK TO SAVEPOINT {name}"));
                let _ = statement(format!("RELEASE SAVEPOINT {name}"));
            }
            result
        } else {
            let transaction = self
                .gateway
                .begin(TransactionBehavior::Immediate, self.client.into())?;
            let result = work(transaction).and_then(|value| {
                self.gateway.commit(transaction, self.client.into())?;
                Ok(value)
            });
            if result.is_err() {
                let _ = self.gateway.rollback(transaction, self.client.into());
            }
            result
        }
    }
}

fn text(value: &str) -> DatabaseValue {
    DatabaseValue::Text(value.into())
}
fn integer(value: u64) -> DatabaseValue {
    DatabaseValue::Integer(value.to_string())
}
fn nullable(value: Option<&str>) -> DatabaseValue {
    value.map(text).unwrap_or(DatabaseValue::Null)
}
fn nonempty(value: &str, label: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err(format!("{label} must not be empty"))
    } else {
        Ok(())
    }
}
fn safe(value: u64, label: &str) -> Result<(), String> {
    if value > MAX_SAFE_INTEGER {
        Err(format!("{label} exceeds the safe integer range"))
    } else {
        Ok(())
    }
}
fn read_integer(value: &DatabaseValue, label: &str) -> Result<u64, String> {
    let DatabaseValue::Integer(value) = value else {
        return Err(format!("Invalid {label}"));
    };
    let value = value
        .parse::<u64>()
        .map_err(|_| format!("Invalid {label}"))?;
    safe(value, label)?;
    Ok(value)
}
fn optional_text(value: &DatabaseValue) -> Result<Option<String>, String> {
    match value {
        DatabaseValue::Null => Ok(None),
        DatabaseValue::Text(value) => Ok(Some(value.clone())),
        _ => Err("Invalid Agent provenance identity".into()),
    }
}
fn validate_write(doc_id: &str, bytes: &[u8], now: &str) -> Result<(), String> {
    nonempty(doc_id, "Document identity")?;
    nonempty(now, "Prose timestamp")?;
    if bytes.is_empty() {
        return Err("Prose bytes must not be empty".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const CLIENT: &str = "synthetic-prose-repository";
    const NOW: &str = "2026-09-25T00:00:00.000Z";
    fn setup() -> (tempfile::TempDir, DatabaseGateway) {
        let directory = tempfile::tempdir().unwrap();
        let gateway = DatabaseGateway::new(directory.path().to_path_buf()).unwrap();
        gateway
            .open("synthetic-prose.db".into(), CLIENT.into(), false)
            .unwrap();
        (directory, gateway)
    }
    fn append(repo: &ProseRepository, doc: &str, value: u8) -> AppendedUpdate {
        repo.append_update(doc, &[value], &RevisionSource::User, NOW, None, None)
            .unwrap()
    }

    #[test]
    fn append_revision_provenance_and_cas_share_one_atomic_write() {
        let (_directory, gateway) = setup();
        let repo = ProseRepository::new(&gateway, CLIENT);
        let first = append(&repo, "node-content:a", 1);
        assert_eq!((first.previous_revision, first.revision), (0, 1));
        let source = RevisionSource::Agent {
            collaborator: Some(AgentIdentity {
                session_id: "session".into(),
                turn_id: "turn".into(),
                call_id: "call".into(),
            }),
        };
        let second = repo
            .append_update("node-content:a", &[2], &source, NOW, Some(1), None)
            .unwrap();
        assert_eq!((second.previous_revision, second.revision), (1, 2));
        assert_eq!(
            repo.list_revision_provenance("node-content:a", 1, None)
                .unwrap()[0]
                .source,
            source
        );
        let before = repo.list_updates("node-content:a", None, None).unwrap();
        assert!(repo
            .append_update(
                "node-content:a",
                &[3],
                &RevisionSource::User,
                NOW,
                Some(1),
                None
            )
            .unwrap_err()
            .contains("STALE_REVISION"));
        gateway.execute("CREATE TRIGGER fail_prose_provenance BEFORE INSERT ON yjs_document_revision_provenance WHEN NEW.source_kind = 'remote' BEGIN SELECT RAISE(ABORT, 'synthetic provenance failure'); END".into(), vec![], None, CLIENT.into()).unwrap();
        assert!(repo
            .append_update(
                "node-content:a",
                &[4],
                &RevisionSource::Remote,
                NOW,
                None,
                None
            )
            .is_err());
        assert_eq!(repo.get_revision("node-content:a", None).unwrap(), 2);
        assert_eq!(
            repo.list_updates("node-content:a", None, None).unwrap(),
            before
        );
        assert_eq!(
            repo.list_revision_provenance("node-content:a", 0, None)
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn caller_rollback_and_failed_nested_append_leave_no_partial_prose_rows() {
        let (_directory, gateway) = setup();
        let repo = ProseRepository::new(&gateway, CLIENT);
        let tx = gateway
            .begin(TransactionBehavior::Immediate, CLIENT.into())
            .unwrap();
        repo.append_update(
            "node-content:a",
            &[1],
            &RevisionSource::User,
            NOW,
            None,
            Some(tx),
        )
        .unwrap();
        assert_eq!(repo.get_revision("node-content:a", Some(tx)).unwrap(), 1);
        gateway.rollback(tx, CLIENT.into()).unwrap();
        assert_eq!(repo.get_revision("node-content:a", None).unwrap(), 0);
        assert!(repo
            .list_updates("node-content:a", None, None)
            .unwrap()
            .is_empty());
        assert!(repo
            .list_revision_provenance("node-content:a", 0, None)
            .unwrap()
            .is_empty());
        gateway.execute("CREATE TRIGGER fail_prose_append BEFORE INSERT ON yjs_updates WHEN NEW.document_id = 'node-content:bad' BEGIN SELECT RAISE(ABORT, 'synthetic append failure'); END".into(), vec![], None, CLIENT.into()).unwrap();
        let tx = gateway
            .begin(TransactionBehavior::Immediate, CLIENT.into())
            .unwrap();
        repo.append_update(
            "node-content:kept",
            &[2],
            &RevisionSource::User,
            NOW,
            None,
            Some(tx),
        )
        .unwrap();
        assert!(repo
            .append_update(
                "node-content:bad",
                &[3],
                &RevisionSource::User,
                NOW,
                None,
                Some(tx)
            )
            .is_err());
        gateway.commit(tx, CLIENT.into()).unwrap();
        assert_eq!(repo.get_revision("node-content:kept", None).unwrap(), 1);
        assert_eq!(repo.get_revision("node-content:bad", None).unwrap(), 0);
        assert!(repo
            .list_updates("node-content:bad", None, None)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn snapshots_preserve_revision_and_prune_only_exact_document_coverage() {
        let (_directory, gateway) = setup();
        let repo = ProseRepository::new(&gateway, CLIENT);
        repo.save_snapshot("node-content:empty", &[0, 0], NOW, None)
            .unwrap();
        assert_eq!(repo.get_revision("node-content:empty", None).unwrap(), 0);
        assert!(repo
            .list_revision_provenance("node-content:empty", 0, None)
            .unwrap()
            .is_empty());
        let one = append(&repo, "node-content:a", 1);
        let foreign = append(&repo, "node-content:b", 2);
        let three = append(&repo, "node-content:a", 3);
        let four = append(&repo, "node-content:a", 4);
        assert!(one.update_id < foreign.update_id && foreign.update_id < three.update_id);
        assert_eq!(
            repo.list_updates("node-content:a", Some(one.update_id), None)
                .unwrap()
                .iter()
                .map(|r| r.id)
                .collect::<Vec<_>>(),
            vec![three.update_id, four.update_id]
        );
        let tx = gateway
            .begin(TransactionBehavior::Immediate, CLIENT.into())
            .unwrap();
        assert_eq!(
            repo.snapshot_and_prune("node-content:a", &[1, 3], three.update_id, NOW, tx)
                .unwrap(),
            2
        );
        gateway.commit(tx, CLIENT.into()).unwrap();
        assert_eq!(
            repo.get_snapshot("node-content:a", None)
                .unwrap()
                .unwrap()
                .state_blob,
            vec![1, 3]
        );
        assert_eq!(repo.get_revision("node-content:a", None).unwrap(), 3);
        assert_eq!(
            repo.list_revision_provenance("node-content:a", 0, None)
                .unwrap()
                .len(),
            3
        );
        assert_eq!(
            repo.list_updates("node-content:a", None, None).unwrap()[0].id,
            four.update_id
        );
        assert_eq!(
            repo.list_updates("node-content:b", None, None).unwrap()[0].id,
            foreign.update_id
        );
        repo.save_snapshot("node-content:a", &[1, 3, 4], NOW, None)
            .unwrap();
        assert_eq!(repo.get_revision("node-content:a", None).unwrap(), 3);
        assert_eq!(
            repo.list_updates("node-content:a", None, None)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn failed_prune_rolls_back_snapshot_inside_the_callers_transaction() {
        let (_directory, gateway) = setup();
        let repo = ProseRepository::new(&gateway, CLIENT);
        repo.save_snapshot("node-content:a", &[0, 0], NOW, None)
            .unwrap();
        let update = append(&repo, "node-content:a", 1);
        gateway.execute("CREATE TRIGGER fail_prose_prune BEFORE DELETE ON yjs_updates BEGIN SELECT RAISE(ABORT, 'synthetic prune failure'); END".into(), vec![], None, CLIENT.into()).unwrap();
        let tx = gateway
            .begin(TransactionBehavior::Immediate, CLIENT.into())
            .unwrap();
        repo.save_snapshot("node-content:sentinel", &[9], NOW, Some(tx))
            .unwrap();
        assert!(repo
            .snapshot_and_prune("node-content:a", &[1], update.update_id, NOW, tx)
            .is_err());
        gateway.commit(tx, CLIENT.into()).unwrap();
        assert_eq!(
            repo.get_snapshot("node-content:a", None)
                .unwrap()
                .unwrap()
                .state_blob,
            vec![0, 0]
        );
        assert_eq!(
            repo.get_snapshot("node-content:sentinel", None)
                .unwrap()
                .unwrap()
                .state_blob,
            vec![9]
        );
        assert_eq!(
            repo.list_updates("node-content:a", None, None)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(repo.get_revision("node-content:a", None).unwrap(), 1);
    }

    #[test]
    fn invalid_provenance_or_precision_is_rejected_before_any_write() {
        let (_directory, gateway) = setup();
        let repo = ProseRepository::new(&gateway, CLIENT);
        let invalid = RevisionSource::Agent {
            collaborator: Some(AgentIdentity {
                session_id: "session".into(),
                turn_id: " ".into(),
                call_id: "call".into(),
            }),
        };
        assert!(repo
            .append_update("node-content:a", &[1], &invalid, NOW, None, None)
            .is_err());
        assert!(repo
            .append_update(
                "node-content:a",
                &[1],
                &RevisionSource::User,
                NOW,
                Some(MAX_SAFE_INTEGER + 1),
                None
            )
            .is_err());
        assert!(repo
            .append_update(
                "node-content:a",
                &[],
                &RevisionSource::User,
                NOW,
                None,
                None
            )
            .is_err());
        assert_eq!(repo.get_revision("node-content:a", None).unwrap(), 0);
        assert!(repo.get_snapshot("node-content:a", None).unwrap().is_none());
        assert!(repo
            .list_updates("node-content:a", None, None)
            .unwrap()
            .is_empty());
        gateway.execute("INSERT INTO yjs_document_revision (document_id, revision, updated_at) VALUES (?, ?, ?)".into(), vec![text("node-content:a"), integer(MAX_SAFE_INTEGER), text(NOW)], None, CLIENT.into()).unwrap();
        assert!(repo
            .append_update(
                "node-content:a",
                &[1],
                &RevisionSource::User,
                NOW,
                None,
                None
            )
            .is_err());
        assert_eq!(
            repo.get_revision("node-content:a", None).unwrap(),
            MAX_SAFE_INTEGER
        );
        assert!(repo
            .list_updates("node-content:a", None, None)
            .unwrap()
            .is_empty());
    }
}
