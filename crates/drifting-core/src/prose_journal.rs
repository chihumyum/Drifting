//! Atomic local yjs.update journal, compatible with the published SQLite and
//! CBOR contracts. This narrow writer does not implement the general reducer.
//! A mandatory validator checks the durable CRDT base and incoming update in
//! the same transaction; the native host supplies Yrs without raising this
//! crate's Rust 1.88 minimum or moving SQLite ownership out of the gateway.
pub(crate) mod encoding;
#[cfg(test)]
mod tests;
pub use encoding::EncodedProseChange;

use crate::database::{DatabaseGateway, DatabaseValue as V, TransactionBehavior};
use crate::prose::{ProseRepository, RevisionSource};

const MAX_SAFE: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug)]
pub struct AuthoredProseContext {
    pub project_id: String,
    pub project_sync_id: String,
    pub sync_generation_id: String,
    pub installation_id: String,
    /// Used only when no writer is active for this installation.
    pub new_writer_id: String,
    pub new_writer_epoch: String,
    pub now_ms: u64,
    pub now_iso: String,
}

#[derive(Clone, Debug)]
pub struct AuthoredProseCommit {
    pub update_id: u64,
    pub previous_revision: u64,
    pub revision: u64,
    pub writer_id: String,
    pub writer_epoch: String,
    pub device_seq: u64,
    pub hlc_wall_ms: u64,
    pub hlc_counter: u64,
    pub encoded: EncodedProseChange,
}

/// Optional neutral transaction evidence and a caller-declared command. This
/// does not certify command intent, retained source visibility, or authority.
/// The writer binds these exact fields to this exact event before persistence.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProseSourceOperationEvidence {
    pub before_snapshot: Vec<u8>,
    pub transaction_deletes: Vec<crate::original_operation::SourceRange>,
    pub intent: crate::original_operation::DeclaredTextDelete,
}

pub struct AuthoredProseJournal<'a> {
    gateway: &'a DatabaseGateway,
    client: &'a str,
}

fn text(value: &str) -> V {
    V::Text(value.into())
}
fn integer(value: u64) -> V {
    V::Integer(value.to_string())
}
fn read_text(row: &[V], column: usize) -> Result<&str, String> {
    match row.get(column) {
        Some(V::Text(value)) => Ok(value),
        _ => Err("Invalid persisted journal text".into()),
    }
}
fn read_uint(row: &[V], column: usize) -> Result<u64, String> {
    match row.get(column) {
        Some(V::Integer(value)) => value
            .parse::<u64>()
            .ok()
            .filter(|v| *v <= MAX_SAFE)
            .ok_or_else(|| "Invalid persisted journal integer".into()),
        _ => Err("Invalid persisted journal integer".into()),
    }
}
pub(crate) fn opaque(value: &str) -> bool {
    !value.is_empty()
        // The production TypeBox validator checks JavaScript string.length.
        && value.encode_utf16().count() <= 255
        && !value.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
}
pub(crate) fn token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
}

impl<'a> AuthoredProseJournal<'a> {
    pub fn new(gateway: &'a DatabaseGateway, client: &'a str) -> Self {
        Self { gateway, client }
    }
    fn query(&self, tx: u64, sql: &str, values: Vec<V>) -> Result<Vec<Vec<V>>, String> {
        Ok(self
            .gateway
            .query(sql.into(), values, Some(tx), self.client.into())?
            .rows)
    }
    fn execute(&self, tx: u64, sql: &str, values: Vec<V>) -> Result<u64, String> {
        Ok(self
            .gateway
            .execute(sql.into(), values, Some(tx), self.client.into())?
            .changes)
    }

    /// `Some(transaction)` composes with comment/Agent writes in the caller's
    /// transaction. A savepoint rolls this operation back on failure; commit
    /// events must only be emitted after the outer transaction commits.
    pub fn append<F>(
        &self,
        context: &AuthoredProseContext,
        doc_id: &str,
        update: &[u8],
        source: &RevisionSource,
        expected_revision: Option<u64>,
        transaction: Option<u64>,
        validate: F,
    ) -> Result<AuthoredProseCommit, String>
    where
        F: FnOnce(&ProseRepository<'_>, u64) -> Result<(), String>,
    {
        self.append_optional(
            context,
            doc_id,
            update,
            None,
            source,
            expected_revision,
            transaction,
            validate,
        )
    }

    /// Persist one declared pure-delete event after checking the exact generated
    /// canonical original. The caller still owns command-role/source validation.
    pub fn append_with_source_operation<F>(
        &self,
        context: &AuthoredProseContext,
        doc_id: &str,
        update: &[u8],
        evidence: &ProseSourceOperationEvidence,
        source: &RevisionSource,
        expected_revision: Option<u64>,
        transaction: Option<u64>,
        validate: F,
    ) -> Result<AuthoredProseCommit, String>
    where
        F: FnOnce(&ProseRepository<'_>, u64) -> Result<(), String>,
    {
        if evidence.before_snapshot.len() > crate::original_operation::MAX_SNAPSHOT_BYTES
            || evidence.transaction_deletes.len() > crate::original_operation::MAX_RANGES
            || evidence.intent.selected_source_ranges.len() > crate::original_operation::MAX_RANGES
            || update.len() > crate::original_operation::MAX_ORIGINAL_ENVELOPE_BYTES
        {
            return Err("Source operation evidence exceeds encoding limits".into());
        }
        self.append_optional(
            context,
            doc_id,
            update,
            Some(evidence),
            source,
            expected_revision,
            transaction,
            validate,
        )
    }

    fn append_optional<F>(
        &self,
        context: &AuthoredProseContext,
        doc_id: &str,
        update: &[u8],
        evidence: Option<&ProseSourceOperationEvidence>,
        source: &RevisionSource,
        expected_revision: Option<u64>,
        transaction: Option<u64>,
        validate: F,
    ) -> Result<AuthoredProseCommit, String>
    where
        F: FnOnce(&ProseRepository<'_>, u64) -> Result<(), String>,
    {
        if !opaque(&context.project_id)
            || !opaque(&context.project_sync_id)
            || !opaque(&context.sync_generation_id)
            || !opaque(doc_id)
            || context.installation_id.is_empty()
            || context.now_iso.is_empty()
            || context.now_ms > MAX_SAFE
            || update.is_empty()
            || !token(&context.new_writer_id)
            || !token(&context.new_writer_epoch)
        {
            return Err("Invalid authored prose journal identity, update or clock".into());
        }
        let tx = match transaction {
            Some(tx) => {
                self.execute(tx, "SAVEPOINT native_prose_journal", vec![])?;
                tx
            }
            None => self
                .gateway
                .begin(TransactionBehavior::Immediate, self.client.into())?,
        };
        let result = self.append_in_transaction(
            tx,
            context,
            doc_id,
            update,
            evidence,
            source,
            expected_revision,
            validate,
        );
        match result {
            Ok(result) => {
                let committed = if transaction.is_some() {
                    self.execute(tx, "RELEASE SAVEPOINT native_prose_journal", vec![])
                        .map(|_| ())
                } else {
                    self.gateway.commit(tx, self.client.into())
                };
                if let Err(error) = committed {
                    return Err(self.abort_error(tx, transaction.is_some(), error));
                }
                Ok(result)
            }
            Err(error) => Err(self.abort_error(tx, transaction.is_some(), error)),
        }
    }

    fn abort_error(&self, tx: u64, nested: bool, original: String) -> String {
        let rollback = if nested {
            self.execute(tx, "ROLLBACK TO SAVEPOINT native_prose_journal", vec![])
                .and_then(|_| self.execute(tx, "RELEASE SAVEPOINT native_prose_journal", vec![]))
                .map(|_| ())
        } else {
            self.gateway.rollback(tx, self.client.into())
        };
        match rollback {
            Ok(()) => original,
            Err(rollback) => format!("{original}; journal rollback failed: {rollback}"),
        }
    }

    fn append_in_transaction<F>(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        doc_id: &str,
        update: &[u8],
        evidence: Option<&ProseSourceOperationEvidence>,
        source: &RevisionSource,
        expected_revision: Option<u64>,
        validate: F,
    ) -> Result<AuthoredProseCommit, String>
    where
        F: FnOnce(&ProseRepository<'_>, u64) -> Result<(), String>,
    {
        let incarnation = self.guard(tx, context, doc_id)?;
        let repository = ProseRepository::new(self.gateway, self.client);
        validate(&repository, tx)?;
        let (writer_id, writer_epoch, device_seq, wall_ms, counter) =
            self.reserve_writer(tx, context)?;
        let identity = encoding::ChangeIdentity {
            project_id: &context.project_id,
            project_sync_id: &context.project_sync_id,
            sync_generation_id: &context.sync_generation_id,
            writer_id: &writer_id,
            writer_epoch: &writer_epoch,
            device_seq,
            wall_ms,
            counter,
            doc_id,
            incarnation,
        };
        let encoded = match evidence {
            Some(evidence) => encoding::encode_optional(&identity, update, Some(evidence)),
            None => encoding::encode(&identity, update),
        };
        if evidence.is_some() {
            let reference = crate::original_operation::OriginalOperationRef {
                project_id: context.project_id.clone(),
                project_sync_id: context.project_sync_id.clone(),
                sync_generation_id: context.sync_generation_id.clone(),
                change_set_id: encoded.change_set_id.clone(),
                mutation_index: 0,
                target: crate::original_operation::MutationTarget {
                    family: "yjs".into(),
                    kind: "prose-document".into(),
                    id: doc_id.into(),
                    incarnation,
                },
                payload_sha256: format!("sha256:{}", encoded.payload_sha256),
                original_envelope_sha256: encoded.encoded_sha256.clone(),
            };
            crate::original_operation::verify_original_operation(
                &encoded.encoded_bytes,
                &reference,
            )?;
        }
        let appended = repository.append_update(
            doc_id,
            update,
            source,
            &context.now_iso,
            expected_revision,
            Some(tx),
        )?;
        self.execute(tx, "INSERT INTO sync_change_set (change_set_id,sync_generation_id,project_id,project_sync_id,writer_id,writer_epoch,device_seq,hlc_wall_ms,hlc_counter,protocol_version,payload_version,mutation_count,encoded_bytes,payload_sha256,origin,apply_state,created_at) VALUES (?,?,?,?,?,?,?,?,?,1,1,1,?,?,'local','applying',?)", vec![
            text(&encoded.change_set_id), text(&context.sync_generation_id), text(&context.project_id), text(&context.project_sync_id),
            text(&writer_id), text(&writer_epoch), integer(device_seq), integer(wall_ms), integer(counter),
            V::Blob(encoded.encoded_bytes.clone()), text(&encoded.encoded_sha256), text(&context.now_iso),
        ])?;
        self.execute(tx, "INSERT INTO sync_mutation (change_set_id,mutation_index,target_family,target_kind,target_id,incarnation,action,payload_version,payload_cbor,payload_sha256) VALUES (?,0,'yjs','prose-document',?,?,'yjs.update',1,?,?)", vec![
            text(&encoded.change_set_id), text(doc_id), integer(incarnation), V::Blob(encoded.payload_cbor.clone()), text(&encoded.payload_sha256),
        ])?;
        // A native journal entry owns this actual append. Never manufacture
        // admission from an existing matching byte row or an applied receipt.
        self.execute(
            tx,
            r#"
            INSERT INTO sync_yjs_materialization_receipt (
                change_set_id, mutation_index, admission_version,
                original_envelope_sha256, document_id, incarnation,
                event_sha256, update_row_id, document_revision, created_at
            )
            VALUES (?, 0, 1, ?, ?, ?, ?, ?, ?, ?)
            "#,
            vec![
                text(&encoded.change_set_id),
                text(&encoded.encoded_sha256),
                text(doc_id),
                integer(incarnation),
                text(&crate::materialization_admission::event_hash(update)),
                integer(appended.update_id),
                integer(appended.revision),
                text(&context.now_iso),
            ],
        )?;
        self.execute(tx, "INSERT INTO sync_apply_receipt (change_set_id,sync_generation_id,mutation_count,applied_at) VALUES (?,?,1,?)", vec![
            text(&encoded.change_set_id), text(&context.sync_generation_id), text(&context.now_iso),
        ])?;
        self.execute(
            tx,
            "UPDATE sync_change_set SET apply_state='applied',applied_at=? WHERE change_set_id=?",
            vec![text(&context.now_iso), text(&encoded.change_set_id)],
        )?;
        Ok(AuthoredProseCommit {
            update_id: appended.update_id,
            previous_revision: appended.previous_revision,
            revision: appended.revision,
            writer_id,
            writer_epoch,
            device_seq,
            hlc_wall_ms: wall_ms,
            hlc_counter: counter,
            encoded,
        })
    }

    fn guard(&self, tx: u64, context: &AuthoredProseContext, doc_id: &str) -> Result<u64, String> {
        self.current_incarnation(
            tx,
            &context.project_id,
            &context.project_sync_id,
            &context.sync_generation_id,
            doc_id,
        )
    }

    /// Read-only current editing scope, shared with the authored writer. Historical
    /// original verification deliberately does not impose this active-owner gate.
    /// The caller owns this transaction and must compare its expected incarnation.
    pub fn current_incarnation(
        &self,
        tx: u64,
        project_id: &str,
        project_sync_id: &str,
        sync_generation_id: &str,
        doc_id: &str,
    ) -> Result<u64, String> {
        if [project_id, project_sync_id, sync_generation_id, doc_id]
            .iter()
            .any(|value| !opaque(value))
        {
            return Err("Invalid current prose scope".into());
        }
        let generation = self.query(tx, "SELECT project_id,project_sync_id,status FROM sync_generation WHERE sync_generation_id=?", vec![text(sync_generation_id)])?;
        let row = generation
            .first()
            .ok_or("Authored prose sync generation does not exist")?;
        if read_text(row, 0)? != project_id
            || read_text(row, 1)? != project_sync_id
            || read_text(row, 2)? != "active"
        {
            return Err(
                "Authored prose project and active generation identity do not match".into(),
            );
        }
        if !self
            .query(
                tx,
                "SELECT 1 FROM sync_generation_purge WHERE sync_generation_id=?",
                vec![text(sync_generation_id)],
            )?
            .is_empty()
        {
            return Err("Authored prose generation has a durable purge".into());
        }
        let (prefix, owner_id) = doc_id
            .split_once(':')
            .ok_or("Noncanonical prose document ID")?;
        let (kind, table) = match prefix {
            "node-content" => ("node", "book_node"),
            "element" => ("element", "element"),
            "storyline" => ("storyline", "storylines"),
            "category" => ("element-category", "element_category"),
            _ => return Err("Noncanonical prose document ID".into()),
        };
        if owner_id.is_empty()
            || self
                .query(
                    tx,
                    &format!("SELECT 1 FROM {table} WHERE id=? AND project_id=?"),
                    vec![text(owner_id), text(project_id)],
                )?
                .is_empty()
        {
            return Err("Prose document owner does not exist in this project".into());
        }
        let lifecycle = self.query(tx, "SELECT incarnation,state FROM sync_entity_lifecycle WHERE sync_generation_id=? AND entity_kind=? AND entity_id=?", vec![text(sync_generation_id), text(kind), text(owner_id)])?;
        if let Some(row) = lifecycle.first() {
            if read_text(row, 1)? != "live" {
                return Err("Prose document owner lifecycle is not live".into());
            }
            read_uint(row, 0)
        } else {
            Ok(0)
        }
    }

    pub(crate) fn reserve_writer(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
    ) -> Result<(String, String, u64, u64, u64), String> {
        self.advance_writer(tx, context, None)
    }

    /// Observe an accepted remote clock without reserving a local sequence.
    /// Rotation and identity checks are shared with the authored writer.
    pub(crate) fn observe_remote_hlc(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        wall_ms: u64,
        counter: u64,
    ) -> Result<(), String> {
        self.advance_writer(tx, context, Some((wall_ms, counter)))?;
        Ok(())
    }

    fn advance_writer(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        remote: Option<(u64, u64)>,
    ) -> Result<(String, String, u64, u64, u64), String> {
        let active = self.query(tx, "SELECT writer_id,writer_epoch,installation_id,next_device_seq,hlc_wall_ms,hlc_counter FROM sync_generation_writer_state WHERE sync_generation_id=? AND retired_at IS NULL", vec![text(&context.sync_generation_id)])?;
        if active.len() > 1 {
            return Err("Multiple active sync writers".into());
        }
        let mut previous = (0, 0);
        if let Some(row) = active.first() { previous = (read_uint(row, 4)?, read_uint(row, 5)?); }
        else if let Some(row) = self.query(tx, "SELECT hlc_wall_ms,hlc_counter FROM sync_generation_writer_state WHERE sync_generation_id=? ORDER BY hlc_wall_ms DESC,hlc_counter DESC LIMIT 1", vec![text(&context.sync_generation_id)])?.first() {
            previous = (read_uint(row, 0)?, read_uint(row, 1)?);
        }
        let wall_ms = context
            .now_ms
            .max(previous.0)
            .max(remote.map_or(0, |value| value.0));
        let previous_counter = (wall_ms == previous.0).then_some(previous.1);
        let remote_counter = remote
            .filter(|value| value.0 == wall_ms)
            .map(|value| value.1);
        let counter = match previous_counter.into_iter().chain(remote_counter).max() {
            Some(value) if value >= MAX_SAFE => {
                return Err("Writer HLC counter cannot be incremented safely".into())
            }
            Some(value) => value + 1,
            None => 0,
        };
        let consumed = u64::from(remote.is_none());
        if let Some(row) = active.first() {
            let writer = read_text(row, 0)?;
            let epoch = read_text(row, 1)?;
            if !token(writer) || !token(epoch) {
                return Err("Invalid persisted sync writer identity".into());
            }
            if read_text(row, 2)? == context.installation_id {
                let seq = read_uint(row, 3)?;
                if seq == 0 || (consumed == 1 && seq == MAX_SAFE) {
                    return Err("Writer sequence cannot be incremented safely".into());
                }
                let changed = self.execute(tx, "UPDATE sync_generation_writer_state SET next_device_seq=?,hlc_wall_ms=?,hlc_counter=?,updated_at=? WHERE sync_generation_id=? AND writer_id=? AND writer_epoch=? AND retired_at IS NULL AND next_device_seq=?", vec![
                    integer(seq+consumed), integer(wall_ms), integer(counter), text(&context.now_iso), text(&context.sync_generation_id), text(writer), text(epoch), integer(seq),
                ])?;
                if changed != 1 {
                    return Err("Sync writer changed while reserving sequence".into());
                }
                return Ok((writer.into(), epoch.into(), seq, wall_ms, counter));
            }
            self.execute(tx, "UPDATE sync_generation_writer_state SET retired_at=?,updated_at=? WHERE sync_generation_id=? AND writer_id=? AND writer_epoch=? AND retired_at IS NULL", vec![text(&context.now_iso), text(&context.now_iso), text(&context.sync_generation_id), text(writer), text(epoch)])?;
        }
        // A restored or cloned database must never reuse an identity already
        // present in its immutable journal, even if its writer row is absent.
        if !self.query(tx, "SELECT 1 FROM sync_change_set WHERE sync_generation_id=? AND writer_id=? AND writer_epoch=? LIMIT 1", vec![text(&context.sync_generation_id), text(&context.new_writer_id), text(&context.new_writer_epoch)])?.is_empty() {
            return Err("Fresh writer identity already exists in source history".into());
        }
        self.execute(tx, "INSERT INTO sync_generation_writer_state (sync_generation_id,writer_id,writer_epoch,installation_id,next_device_seq,hlc_wall_ms,hlc_counter,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)", vec![
            text(&context.sync_generation_id), text(&context.new_writer_id), text(&context.new_writer_epoch), text(&context.installation_id), integer(1+consumed), integer(wall_ms), integer(counter), text(&context.now_iso), text(&context.now_iso),
        ])?;
        Ok((
            context.new_writer_id.clone(),
            context.new_writer_epoch.clone(),
            1,
            wall_ms,
            counter,
        ))
    }
}
