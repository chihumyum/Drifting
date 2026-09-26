//! Read-only restoration of an applied original operation. This is not a
//! certificate for a document mutation: causal source and command-role checks
//! still belong to the document owner, as does the eventual atomic receipt.
use crate::database::{DatabaseGateway, DatabaseValue as V, TransactionBehavior};
use crate::original_operation::{
    select_original_operation, verify_change_set, ChangeSetRef, OriginalOperationRef,
    VerifiedChangeSet, VerifiedOriginalOperation, MAX_ORIGINAL_ENVELOPE_BYTES,
};

pub struct OriginalOperationStore<'a> {
    gateway: &'a DatabaseGateway,
    client: &'a str,
}

struct ReadTransaction<'a> {
    store: &'a OriginalOperationStore<'a>,
    id: Option<u64>,
}
impl Drop for ReadTransaction<'_> {
    fn drop(&mut self) {
        if let Some(id) = self.id.take() {
            let _ = self.store.gateway.rollback(id, self.store.client.into());
        }
    }
}

fn mismatch() -> String {
    "Applied original operation disagrees with its immutable envelope".into()
}
fn text(row: &[V], column: usize) -> Result<&str, String> {
    match row.get(column) {
        Some(V::Text(value)) => Ok(value),
        _ => Err(mismatch()),
    }
}
fn uint(row: &[V], column: usize) -> Result<u64, String> {
    match row.get(column) {
        Some(V::Integer(value)) => value
            .parse::<u64>()
            .ok()
            .filter(|v| *v <= 9_007_199_254_740_991)
            .ok_or_else(mismatch),
        _ => Err(mismatch()),
    }
}
fn blob(row: &[V], column: usize) -> Result<&[u8], String> {
    match row.get(column) {
        Some(V::Blob(value)) => Ok(value),
        _ => Err(mismatch()),
    }
}
// Column identifiers here are fixed implementation constants, never input.
// Protocol text is at most 300 UTF-16 units (change-set ID) and all current
// valid UTF-8 encodings fit 1200 bytes. Reject corrupt larger cells in SQLite
// before the gateway allocates/copies them into Rust.
fn bounded_text_columns(columns: &[&str]) -> String {
    columns.iter().map(|column| format!(
        "CASE WHEN typeof({column})='text' AND length(CAST({column} AS BLOB))<=1200 THEN {column} ELSE NULL END"
    )).collect::<Vec<_>>().join(",")
}

impl<'a> OriginalOperationStore<'a> {
    pub fn new(gateway: &'a DatabaseGateway, client: &'a str) -> Self {
        Self { gateway, client }
    }

    /// Read the envelope and EVERY materialized mutation in one SQLite snapshot.
    /// The applied state must have a matching published receipt. Errors release this read
    /// transaction, so a rejected original cannot block subsequent editing.
    pub fn load_verified(
        &self,
        reference: &OriginalOperationRef,
    ) -> Result<VerifiedOriginalOperation, String> {
        let id = self
            .gateway
            .begin(TransactionBehavior::Deferred, self.client.into())?;
        let mut guard = ReadTransaction {
            store: self,
            id: Some(id),
        };
        let verified = self.load_verified_in_transaction(reference, id)?;
        self.gateway.commit(id, self.client.into())?;
        guard.id = None;
        Ok(verified)
    }

    /// For an owner that already holds a SQLite transaction. This method never
    /// commits or rolls back the caller's work and does not authorize live apply.
    /// Only already-applied journal rows are currently supported; the incoming
    /// reducer's pending-operation admission requires a separate contract.
    pub fn load_verified_in_transaction(
        &self,
        reference: &OriginalOperationRef,
        transaction: u64,
    ) -> Result<VerifiedOriginalOperation, String> {
        self.load_with_hook(reference, transaction, || Ok(()))
    }

    fn query(
        &self,
        transaction: u64,
        sql: &str,
        parameters: Vec<V>,
    ) -> Result<Vec<Vec<V>>, String> {
        Ok(self
            .gateway
            .query(
                sql.into(),
                parameters,
                Some(transaction),
                self.client.into(),
            )?
            .rows)
    }

    pub(crate) fn load_change_set_in_transaction(
        &self,
        reference: &ChangeSetRef,
        transaction: u64,
    ) -> Result<VerifiedChangeSet, String> {
        self.load_change_set_with_hook(reference, transaction, || Ok(()))
    }

    fn load_with_hook<F>(
        &self,
        reference: &OriginalOperationRef,
        transaction: u64,
        between: F,
    ) -> Result<VerifiedOriginalOperation, String>
    where
        F: FnOnce() -> Result<(), String>,
    {
        let original =
            self.load_change_set_with_hook(&ChangeSetRef::from(reference), transaction, between)?;
        select_original_operation(original, reference)
    }

    // The hook lets a file-backed WAL test commit on a second connection between
    // the two reads. It is private and production callers only pass a no-op.
    fn load_change_set_with_hook<F>(
        &self,
        reference: &ChangeSetRef,
        transaction: u64,
        between: F,
    ) -> Result<VerifiedChangeSet, String>
    where
        F: FnOnce() -> Result<(), String>,
    {
        if reference.change_set_id.is_empty() || reference.change_set_id.len() > 1200 {
            return Err(mismatch());
        }
        let key = V::Text(reference.change_set_id.clone());
        let header_sql = format!(
            "SELECT {identity},device_seq,hlc_wall_ms,hlc_counter,
             protocol_version,payload_version,mutation_count,
             CASE WHEN typeof(encoded_bytes)='blob' AND length(encoded_bytes)<=?2 THEN encoded_bytes ELSE NULL END,
             {status}
             FROM sync_change_set WHERE change_set_id=?1",
            identity=bounded_text_columns(&["change_set_id","sync_generation_id","project_id","project_sync_id","writer_id","writer_epoch"]),
            status=bounded_text_columns(&["payload_sha256","origin","apply_state"]));
        let rows = self.query(
            transaction,
            &header_sql,
            vec![
                key.clone(),
                V::Integer(MAX_ORIGINAL_ENVELOPE_BYTES.to_string()),
            ],
        )?;
        let [row] = rows.as_slice() else {
            return Err("Original operation is unavailable".into());
        };
        let encoded = blob(row, 12)?;
        let verified = verify_change_set(encoded, reference).map_err(|error| error.to_string())?;
        if text(row, 0)? != reference.change_set_id
            || text(row, 1)? != reference.sync_generation_id
            || text(row, 2)? != reference.project_id
            || text(row, 3)? != reference.project_sync_id
            || text(row, 4)? != verified.writer_id()
            || text(row, 5)? != verified.writer_epoch()
            || uint(row, 6)? != verified.device_seq()
            || uint(row, 7)? != verified.hlc_wall_ms()
            || uint(row, 8)? != verified.hlc_counter()
            || uint(row, 9)? != verified.protocol_version()
            || uint(row, 10)? != verified.payload_version()
            || uint(row, 11)? != verified.mutations().len() as u64
            || text(row, 13)? != reference.original_envelope_sha256
            || !matches!(text(row, 14)?, "local" | "remote")
            || text(row, 15)? != "applied"
        {
            return Err(mismatch());
        }

        between()?;
        let receipt_sql = format!(
            "SELECT {},mutation_count,CASE WHEN typeof(applied_at)='text' AND length(applied_at)>0 THEN 1 ELSE 0 END FROM sync_apply_receipt WHERE change_set_id=?1",
            bounded_text_columns(&["sync_generation_id"]));
        let receipts = self.query(transaction, &receipt_sql, vec![key.clone()])?;
        let [receipt] = receipts.as_slice() else {
            return Err("Applied original receipt is unavailable".into());
        };
        if text(receipt, 0)? != reference.sync_generation_id
            || uint(receipt, 1)? != verified.mutations().len() as u64
            || uint(receipt, 2)? != 1
        {
            return Err(mismatch());
        }
        // Check aggregate size before fetching any row payloads. Each payload
        // occurs inside the immutable envelope, so their sum cannot exceed it.
        // This also rejects extra rows without an unbounded result allocation.
        let counts = self.query(transaction,
            "SELECT count(*),coalesce(sum(CASE WHEN typeof(payload_cbor)='blob' THEN length(payload_cbor) ELSE 9007199254740991 END),0)
             FROM sync_mutation WHERE change_set_id=?1", vec![key.clone()])?;
        let [counts] = counts.as_slice() else {
            return Err(mismatch());
        };
        if uint(counts, 0)? != verified.mutations().len() as u64
            || uint(counts, 1)? > encoded.len() as u64
        {
            return Err(mismatch());
        }
        let mutation_sql = format!(
            "SELECT mutation_index,{target},incarnation,{action},payload_version,payload_cbor,{hash}
             FROM sync_mutation WHERE change_set_id=?1 ORDER BY mutation_index",
            target=bounded_text_columns(&["target_family","target_kind","target_id"]),
            action=bounded_text_columns(&["action"]),hash=bounded_text_columns(&["payload_sha256"]));
        let mutations = self.query(transaction, &mutation_sql, vec![key])?;
        if mutations.len() != verified.mutations().len() {
            return Err(mismatch());
        }
        for (stored, original) in mutations.iter().zip(verified.mutations()) {
            let target = original.target();
            if uint(stored, 0)? != original.index()
                || text(stored, 1)? != target.family
                || text(stored, 2)? != target.kind
                || text(stored, 3)? != target.id
                || uint(stored, 4)? != target.incarnation
                || text(stored, 5)? != original.action()
                || uint(stored, 6)? != original.payload_version()
                || blob(stored, 7)? != original.canonical_payload_bytes()
                || text(stored, 8)?
                    != original
                        .payload_sha256()
                        .strip_prefix("sha256:")
                        .ok_or_else(mismatch)?
            {
                return Err(mismatch());
            }
        }
        Ok(verified)
    }
}

#[cfg(test)]
mod tests;
