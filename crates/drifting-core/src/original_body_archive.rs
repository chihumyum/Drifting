//! Read-only, bounded original body collection. This verifies the retained set,
//! not that historical source bodies are complete or CRDT-reconstructible.
use crate::database::{DatabaseGateway, DatabaseValue as V, TransactionBehavior};
use crate::original_operation::{
    verify_change_set, ChangeSetRef, OriginalOperationRef, MAX_ORIGINAL_ENVELOPE_BYTES,
};
use crate::original_operation_store::OriginalOperationStore;
use std::collections::{BTreeMap, BTreeSet};

pub const MAX_ARCHIVE_CHANGE_SETS: usize = 4096;
pub const MAX_ARCHIVE_ENCODED_BYTES: usize = 64 * 1024 * 1024;
const MAX_ARCHIVE_BODIES: usize = 100_000;
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArchiveScope {
    pub project_id: String,
    pub project_sync_id: String,
    pub sync_generation_id: String,
    pub document_id: String,
    pub incarnation: u64,
}
#[derive(Debug)]
pub struct VerifiedYjsBody {
    source: OriginalOperationRef,
    update: Vec<u8>,
}
impl VerifiedYjsBody {
    pub fn source(&self) -> &OriginalOperationRef {
        &self.source
    }
    pub fn update(&self) -> &[u8] {
        &self.update
    }
}
#[derive(Debug)]
pub struct VerifiedBodyArchive {
    scope: ArchiveScope,
    bodies: Vec<VerifiedYjsBody>,
}
impl VerifiedBodyArchive {
    pub fn scope(&self) -> &ArchiveScope {
        &self.scope
    }
    pub fn bodies(&self) -> &[VerifiedYjsBody] {
        &self.bodies
    }
}
pub struct OriginalBodyArchiveStore<'a> {
    gateway: &'a DatabaseGateway,
    client: &'a str,
}
struct ReadTransaction<'a> {
    gateway: &'a DatabaseGateway,
    client: &'a str,
    id: Option<u64>,
}
impl Drop for ReadTransaction<'_> {
    fn drop(&mut self) {
        if let Some(id) = self.id.take() {
            let _ = self.gateway.rollback(id, self.client.into());
        }
    }
}
fn refused(message: &str) -> String {
    format!("ORIGINAL_BODY_ARCHIVE_UNAVAILABLE: {message}")
}
fn text(row: &[V], index: usize) -> Result<&str, String> {
    match row.get(index) {
        Some(V::Text(value)) => Ok(value),
        _ => Err(refused("invalid bounded original identity")),
    }
}
fn uint(row: &[V], index: usize) -> Result<u64, String> {
    match row.get(index) {
        Some(V::Integer(value)) => value.parse().map_err(|_| refused("invalid original count")),
        _ => Err(refused("invalid original count")),
    }
}
fn bounded(column: &str) -> String {
    format!("CASE WHEN typeof({column})='text' AND length(CAST({column} AS BLOB))<=1200 THEN {column} ELSE NULL END")
}
fn same_scope(reference: &ChangeSetRef, scope: &ArchiveScope) -> bool {
    reference.project_id == scope.project_id
        && reference.project_sync_id == scope.project_sync_id
        && reference.sync_generation_id == scope.sync_generation_id
}
impl<'a> OriginalBodyArchiveStore<'a> {
    pub fn new(gateway: &'a DatabaseGateway, client: &'a str) -> Self {
        Self { gateway, client }
    }
    /// Required immutable references can only tighten this collection. Their
    /// absence rejects; supplying none cannot prove that missing history exists.
    pub fn load_original_bodies(
        &self,
        scope: &ArchiveScope,
        required_originals: &[ChangeSetRef],
    ) -> Result<VerifiedBodyArchive, String> {
        let id = self
            .gateway
            .begin(TransactionBehavior::Deferred, self.client.into())?;
        let mut guard = ReadTransaction {
            gateway: self.gateway,
            client: self.client,
            id: Some(id),
        };
        let result = self.load_original_bodies_in_transaction(scope, required_originals, id)?;
        self.gateway.commit(id, self.client.into())?;
        guard.id = None;
        Ok(result)
    }
    /// Caller owns commit/rollback. No partial archive is returned on any error.
    pub fn load_original_bodies_in_transaction(
        &self,
        scope: &ArchiveScope,
        required_originals: &[ChangeSetRef],
        transaction: u64,
    ) -> Result<VerifiedBodyArchive, String> {
        self.load_with_hook(scope, required_originals, transaction, || Ok(()))
    }
    fn query(&self, transaction: u64, sql: String, values: Vec<V>) -> Result<Vec<Vec<V>>, String> {
        Ok(self
            .gateway
            .query(sql, values, Some(transaction), self.client.into())?
            .rows)
    }
    fn load_with_hook<F>(
        &self,
        scope: &ArchiveScope,
        required_originals: &[ChangeSetRef],
        transaction: u64,
        between: F,
    ) -> Result<VerifiedBodyArchive, String>
    where
        F: FnOnce() -> Result<(), String>,
    {
        if required_originals.len() > MAX_ARCHIVE_CHANGE_SETS
            || scope.incarnation > 9_007_199_254_740_991
            || [
                &scope.project_id,
                &scope.project_sync_id,
                &scope.sync_generation_id,
                &scope.document_id,
            ]
            .iter()
            .any(|value| {
                value.is_empty()
                    || value.encode_utf16().count() > 255
                    || value.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
            })
        {
            return Err(refused("invalid or over-budget archive scope"));
        }
        let mut required = BTreeMap::new();
        for reference in required_originals {
            if !same_scope(reference, scope) {
                return Err(refused("required original has a different scope"));
            }
            if let Some(old) = required.insert(reference.change_set_id.as_str(), reference) {
                if old != reference {
                    return Err(refused("conflicting required original identity"));
                }
            }
        }
        // Validate the requested catalog association, not just row-local copies.
        let catalog = self.query(
            transaction,
            format!(
                "SELECT {},{} FROM sync_generation WHERE sync_generation_id=?1",
                bounded("project_id"),
                bounded("project_sync_id")
            ),
            vec![V::Text(scope.sync_generation_id.clone())],
        )?;
        let [catalog] = catalog.as_slice() else {
            return Err(refused("generation catalog is unavailable"));
        };
        if text(catalog, 0)? != scope.project_id || text(catalog, 1)? != scope.project_sync_id {
            return Err(refused("generation catalog disagrees with project scope"));
        }
        let projects = self.query(
            transaction,
            "SELECT count(*) FROM project WHERE id=?1".into(),
            vec![V::Text(scope.project_id.clone())],
        )?;
        if projects.len() != 1 || uint(&projects[0], 0)? != 1 {
            return Err(refused("project catalog is unavailable"));
        }
        // Scan canonical originals, never a mutable materialized target index.
        // Whole-local-envelope scan also catches a corrupted header moved out
        // of this scope. Limits fail closed instead of returning a truncated set.
        let counts = self.query(transaction,
            "SELECT count(*),coalesce(sum(CASE WHEN typeof(encoded_bytes)='blob' THEN length(encoded_bytes) ELSE 9007199254740991 END),0),coalesce(max(CASE WHEN typeof(encoded_bytes)='blob' THEN length(encoded_bytes) ELSE 9007199254740991 END),0) FROM sync_change_set".into(),vec![])?;
        let [counts] = counts.as_slice() else {
            return Err(refused("invalid original catalog"));
        };
        if uint(counts, 0)? > MAX_ARCHIVE_CHANGE_SETS as u64
            || uint(counts, 1)? > MAX_ARCHIVE_ENCODED_BYTES as u64
            || uint(counts, 2)? > MAX_ORIGINAL_ENVELOPE_BYTES as u64
        {
            return Err(refused("original collection exceeds local read budget"));
        }
        let columns = [
            "project_id",
            "project_sync_id",
            "sync_generation_id",
            "change_set_id",
            "payload_sha256",
        ]
        .map(bounded)
        .join(",");
        let rows = self.query(transaction,format!("SELECT {columns},encoded_bytes FROM sync_change_set ORDER BY change_set_id COLLATE BINARY"),vec![])?;
        between()?;
        let store = OriginalOperationStore::new(self.gateway, self.client);
        let mut bodies = Vec::new();
        let mut found = BTreeSet::new();
        for row in rows {
            let reference = ChangeSetRef {
                project_id: text(&row, 0)?.into(),
                project_sync_id: text(&row, 1)?.into(),
                sync_generation_id: text(&row, 2)?.into(),
                change_set_id: text(&row, 3)?.into(),
                original_envelope_sha256: text(&row, 4)?.into(),
            };
            let Some(V::Blob(encoded)) = row.get(5) else {
                return Err(refused("original encoded body is unavailable"));
            };
            let original = verify_change_set(encoded, &reference)?;
            if !same_scope(&reference, scope) {
                continue;
            }
            let matches = |m: &crate::original_operation::VerifiedMutation| {
                let target = m.target();
                m.action() == "yjs.update"
                    && target.family == "yjs"
                    && target.kind == "prose-document"
                    && target.id == scope.document_id
                    && target.incarnation == scope.incarnation
            };
            if !original.mutations().iter().any(matches) {
                continue;
            }
            // Same SQLite snapshot; revalidates immutable bytes, every stored
            // mutation (also unrelated siblings), applied state, and receipt.
            let applied = store.load_change_set_in_transaction(&reference, transaction)?;
            if let Some(expected) = required.get(reference.change_set_id.as_str()) {
                if **expected != reference {
                    return Err(refused("required original hash/identity mismatch"));
                }
            }
            found.insert(reference.change_set_id.clone());
            for mutation in applied.mutations().iter().filter(|m| matches(m)) {
                if bodies.len() >= MAX_ARCHIVE_BODIES {
                    return Err(refused("too many original body mutations"));
                }
                bodies.push(VerifiedYjsBody {
                    source: OriginalOperationRef {
                        project_id: reference.project_id.clone(),
                        project_sync_id: reference.project_sync_id.clone(),
                        sync_generation_id: reference.sync_generation_id.clone(),
                        change_set_id: reference.change_set_id.clone(),
                        mutation_index: mutation.index(),
                        target: mutation.target().clone(),
                        payload_sha256: mutation.payload_sha256().into(),
                        original_envelope_sha256: reference.original_envelope_sha256.clone(),
                    },
                    update: mutation.original_yjs_update()?,
                });
            }
        }
        if bodies.is_empty() {
            return Err(refused("no retained original body matches document scope"));
        }
        if required.keys().any(|id| !found.contains(*id)) {
            return Err(refused(
                "required original is missing from the retained document set",
            ));
        }
        Ok(VerifiedBodyArchive {
            scope: scope.clone(),
            bodies,
        })
    }
}
#[cfg(test)]
mod tests;
