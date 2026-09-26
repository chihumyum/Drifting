//! Local positive materialization evidence. An applied change-set or source
//! body alone is not this evidence. No public receipt writer or constructor.
use crate::database::{DatabaseGateway, DatabaseValue as V, TransactionBehavior};
use crate::original_operation::{ChangeSetRef, OriginalOperationRef};
use crate::original_operation_store::OriginalOperationStore;
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedMaterializationAdmission {
    source: OriginalOperationRef,
    event_sha256: String,
    update_row_id: u64,
    document_revision: u64,
}
impl VerifiedMaterializationAdmission {
    pub fn source(&self) -> &OriginalOperationRef {
        &self.source
    }
    pub fn update_row_id(&self) -> u64 {
        self.update_row_id
    }
    pub fn document_revision(&self) -> u64 {
        self.document_revision
    }
    pub fn event_sha256(&self) -> &str {
        &self.event_sha256
    }
    pub fn matches(&self, source: &OriginalOperationRef, update: &[u8]) -> bool {
        &self.source == source && self.event_sha256 == event_hash(update)
    }
}
pub struct MaterializationAdmissionStore<'a> {
    db: &'a DatabaseGateway,
    client: &'a str,
}
impl<'a> MaterializationAdmissionStore<'a> {
    pub fn new(db: &'a DatabaseGateway, client: &'a str) -> Self {
        Self { db, client }
    }
    pub fn load_verified(
        &self,
        source: &OriginalOperationRef,
    ) -> Result<VerifiedMaterializationAdmission, String> {
        let tx = self
            .db
            .begin(TransactionBehavior::Deferred, self.client.into())?;
        let result = self.load_verified_in_transaction(source, tx);
        match result {
            Ok(value) => {
                if let Err(e) = self.db.commit(tx, self.client.into()) {
                    let _ = self.db.rollback(tx, self.client.into());
                    return Err(e);
                }
                Ok(value)
            }
            Err(e) => {
                let _ = self.db.rollback(tx, self.client.into());
                Err(e)
            }
        }
    }
    /// Same caller transaction; historical facts survive raw-row pruning and do
    /// not grant current-lifecycle permission. Owners separately check scope.
    pub fn load_verified_in_transaction(
        &self,
        source: &OriginalOperationRef,
        tx: u64,
    ) -> Result<VerifiedMaterializationAdmission, String> {
        let original = OriginalOperationStore::new(self.db, self.client)
            .load_change_set_in_transaction(&ChangeSetRef::from(source), tx)?;
        let m = original
            .mutations()
            .iter()
            .find(|m| m.index() == source.mutation_index)
            .ok_or("Materialization mutation missing")?;
        if m.target() != &source.target
            || m.action() != "yjs.update"
            || m.target().family != "yjs"
            || m.target().kind != "prose-document"
            || m.payload_sha256() != source.payload_sha256
        {
            return Err("Materialization original identity mismatch".into());
        }
        let update = m.original_yjs_update()?;
        let digest = event_hash(&update);
        let rows = self
            .db
            .query(
                r#"
                SELECT
                    admission_version,
                    CASE
                        WHEN typeof(original_envelope_sha256) = 'text'
                            AND length(CAST(original_envelope_sha256 AS BLOB)) = 64
                        THEN original_envelope_sha256 ELSE NULL
                    END,
                    CASE
                        WHEN typeof(document_id) = 'text'
                            AND length(CAST(document_id AS BLOB)) <= 1200
                        THEN document_id ELSE NULL
                    END,
                    incarnation,
                    CASE
                        WHEN typeof(event_sha256) = 'text'
                            AND length(CAST(event_sha256 AS BLOB)) = 64
                        THEN event_sha256 ELSE NULL
                    END,
                    update_row_id,
                    document_revision,
                    CASE
                        WHEN typeof(created_at) = 'text'
                            AND length(CAST(created_at AS BLOB)) > 0
                        THEN 1 ELSE 0
                    END
                FROM sync_yjs_materialization_receipt
                WHERE change_set_id = ? AND mutation_index = ?
                "#
                .into(),
                vec![
                    V::Text(source.change_set_id.clone()),
                    V::Integer(source.mutation_index.to_string()),
                ],
                Some(tx),
                self.client.into(),
            )?
            .rows;
        let [r] = rows.as_slice() else {
            return Err("Positive materialization admission is unavailable".into());
        };
        if uint(r, 0)? != 1
            || text(r, 1)? != source.original_envelope_sha256
            || text(r, 2)? != source.target.id
            || uint(r, 3)? != source.target.incarnation
            || text(r, 4)? != digest
            || uint(r, 7)? != 1
        {
            return Err("Materialization receipt disagrees with canonical original".into());
        }
        let update_row_id = uint(r, 5)?;
        let document_revision = uint(r, 6)?;
        if update_row_id == 0 || document_revision == 0 {
            return Err("Materialization receipt has invalid append identity".into());
        }
        // Missing historical raw rows are allowed; a different extant row is not.
        let raw = self
            .db
            .query(
                r#"
                SELECT
                    CASE
                        WHEN typeof(document_id) = 'text'
                            AND length(CAST(document_id AS BLOB)) <= 1200
                        THEN document_id ELSE NULL
                    END,
                    CASE
                        WHEN typeof(update_blob) = 'blob' AND length(update_blob) = ?2
                        THEN update_blob ELSE NULL
                    END
                FROM yjs_updates
                WHERE id = ?1
                "#
                .into(),
                vec![
                    V::Integer(update_row_id.to_string()),
                    V::Integer(update.len().to_string()),
                ],
                Some(tx),
                self.client.into(),
            )?
            .rows;
        match raw.as_slice() {
            [] => {}
            [row]
                if matches!(
                    row.as_slice(),
                    [V::Text(id), V::Blob(bytes)]
                        if id == &source.target.id && bytes == &update
                ) => {}
            _ => return Err("Materialization raw row disagrees with exact original event".into()),
        }
        Ok(VerifiedMaterializationAdmission {
            source: source.clone(),
            event_sha256: digest,
            update_row_id,
            document_revision,
        })
    }
}
pub(crate) fn event_hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn text(row: &[V], index: usize) -> Result<&str, String> {
    match row.get(index) {
        Some(V::Text(s)) => Ok(s),
        _ => Err("Invalid materialization text".into()),
    }
}
fn uint(row: &[V], index: usize) -> Result<u64, String> {
    match row.get(index) {
        Some(V::Integer(n)) => n
            .parse::<u64>()
            .ok()
            .filter(|n| *n <= 9_007_199_254_740_991)
            .ok_or_else(|| "Invalid materialization integer".into()),
        _ => Err("Invalid materialization integer".into()),
    }
}
#[cfg(test)]
mod tests;
