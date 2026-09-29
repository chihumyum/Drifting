//! Serial, shared prose durability owner. Hosts retain one owner per document;
//! remote reducers write SQLite first and notify it to replay. UI projections,
//! semantic revisions and SQLite replay watermarks are separate clocks.
use drifting_core::database::{DatabaseGateway, TransactionBehavior};
use drifting_core::original_body_archive::ArchiveScope;
use drifting_core::prose::{ProseRepository, RevisionSource};
use drifting_core::prose_journal::{AuthoredProseContext, AuthoredProseJournal};
use drifting_document::{
    AuthoredUpdateLog, CapturedAuthoredUpdate, DocumentSession, PreparedRemoteUpdate,
    REMOTE_TEXT_RETENTION_REQUIRED,
};
use std::ops::{Deref, DerefMut};
mod native_source;
pub mod remote_sync;
pub mod search;
pub mod workspace;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DurabilityPhase {
    AuthoredBeforeCommit,
    AuthoredAfterCommit,
    RemoteBeforeCommit,
    RemoteAfterCommit,
    ReplayAppliedBeforeCoverage,
    ReplayBeforeCommit,
    ReplayAfterCommit,
    CheckpointAfterSnapshot,
    CheckpointAfterPrune,
    CheckpointAfterCommit,
}

/// Hooks are synchronous observation points, also used by the process-kill
/// harness. They never decide whether a write is acknowledged or committed.
pub type PhaseObserver<'a> = dyn FnMut(DurabilityPhase) + 'a;

/// The bytes are already durable, but this row has not entered the live state.
/// No row at or after this ID may be covered by a compacting snapshot.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteBlock {
    pub update_id: u64,
    pub reason: String,
}

struct ReplayStep {
    /// Exact stored rows included by these prepared bytes, never an inferred MAX.
    update_ids: Vec<u64>,
    prepared: PreparedRemoteUpdate,
}

struct ReplayCandidate {
    document: DocumentSession,
    steps: Vec<ReplayStep>,
    repairs: Vec<Vec<u8>>,
}

const REPAIR_CONTEXT_REQUIRED: &str = "REMOTE_REPAIR_PERSISTENCE_REQUIRED";

pub struct DurableDocument {
    gateway: DatabaseGateway,
    client: String,
    doc_id: String,
    scope: Option<ArchiveScope>,
    document: DocumentSession,
    captured: AuthoredUpdateLog,
    pending: Vec<CapturedAuthoredUpdate>,
    covered: u64,
    remote_block: Option<RemoteBlock>,
}

impl Deref for DurableDocument {
    type Target = DocumentSession;
    fn deref(&self) -> &Self::Target {
        &self.document
    }
}
impl DerefMut for DurableDocument {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.document
    }
}

impl DurableDocument {
    /// Load the safe snapshot without claiming that any tail has been applied.
    /// A host can install its persisted comment anchors, then call
    /// `replay_with_context` before exposing the document. This also permits a
    /// cold restart to retry a repair whose earlier SQLite transaction failed.
    pub fn open_for_replay(
        gateway: DatabaseGateway,
        client: &str,
        doc_id: &str,
    ) -> Result<Self, String> {
        Self::open_internal(gateway, client, doc_id, None, true)
    }

    pub fn open(gateway: DatabaseGateway, client: &str, doc_id: &str) -> Result<Self, String> {
        Self::open_internal(gateway, client, doc_id, None, false)
    }

    /// Bind the full active identity before exposing an editable document. A
    /// later journal call cannot rebind already-captured commands after restore.
    pub fn open_with_scope(
        gateway: DatabaseGateway,
        client: &str,
        scope: ArchiveScope,
    ) -> Result<Self, String> {
        let doc_id = scope.document_id.clone();
        Self::open_internal(gateway, client, &doc_id, Some(scope), false)
    }

    pub fn open_for_replay_with_scope(
        gateway: DatabaseGateway,
        client: &str,
        scope: ArchiveScope,
    ) -> Result<Self, String> {
        let doc_id = scope.document_id.clone();
        Self::open_internal(gateway, client, &doc_id, Some(scope), true)
    }

    fn open_internal(
        gateway: DatabaseGateway,
        client: &str,
        doc_id: &str,
        scope: Option<ArchiveScope>,
        for_replay: bool,
    ) -> Result<Self, String> {
        // Identity and prose come from the same SQLite snapshot.
        let tx = gateway.begin(TransactionBehavior::Deferred, client.into())?;
        let loaded = (|| {
            if let Some(scope) = &scope {
                native_source::current_scope(&gateway, client, tx, scope)?;
            }
            let repo = ProseRepository::new(&gateway, client);
            if for_replay {
                load_snapshot(&repo, doc_id, tx).map(|doc| (doc, 0))
            } else {
                load_document(&repo, doc_id, tx)
            }
        })();
        let (mut document, covered) = match loaded {
            Ok(value) => {
                if let Err(error) = gateway.commit(tx, client.into()) {
                    let _ = gateway.rollback(tx, client.into());
                    return Err(error);
                }
                value
            }
            Err(error) => {
                let _ = gateway.rollback(tx, client.into());
                return Err(error);
            }
        };
        let captured = document.capture_authored_updates()?;
        Ok(Self {
            gateway,
            client: client.into(),
            doc_id: doc_id.into(),
            scope,
            document,
            captured,
            pending: Vec::new(),
            covered,
            remote_block: None,
        })
    }

    fn current_scope(&self, tx: u64) -> Result<(), String> {
        if let Some(scope) = &self.scope {
            native_source::current_scope(&self.gateway, &self.client, tx, scope)?;
        }
        Ok(())
    }

    pub fn covered_update_id(&self) -> u64 {
        self.covered
    }
    pub fn has_uncommitted_updates(&self) -> bool {
        !self.pending.is_empty() || !self.captured.is_empty()
    }

    pub fn remote_block(&self) -> Option<&RemoteBlock> {
        self.remote_block.as_ref()
    }

    /// Fixture transport receipt, not a production sync receipt/frontier. Wire
    /// validation precedes storage; semantic application happens only on replay.
    /// Retrying an uncovered payload returns its existing row ID, including when
    /// an earlier row prevents replay. Covered/pruned deliveries still rely on
    /// CRDT idempotence; production message deduplication belongs to the reducer.
    pub fn receive_remote(
        &mut self,
        bytes: &[u8],
        encoding: u8,
        now: &str,
        observer: &mut PhaseObserver<'_>,
    ) -> Result<u64, String> {
        let normalized = DocumentSession::normalize_update(bytes, encoding)?;
        let bytes = if encoding == 1 {
            bytes.to_vec()
        } else {
            normalized
        };
        let tx = self
            .gateway
            .begin(TransactionBehavior::Immediate, self.client.clone())?;
        let result = (|| {
            self.current_scope(tx)?;
            let repository = ProseRepository::new(&self.gateway, &self.client);
            let existing = repository
                .list_updates(&self.doc_id, Some(self.covered), Some(tx))?
                .into_iter()
                .find(|row| row.update_blob == bytes);
            let id = match existing {
                Some(row) => row.id,
                None => {
                    repository
                        .append_update(
                            &self.doc_id,
                            &bytes,
                            &RevisionSource::Remote,
                            now,
                            None,
                            Some(tx),
                        )?
                        .update_id
                }
            };
            observer(DurabilityPhase::RemoteBeforeCommit);
            self.gateway.commit(tx, self.client.clone())?;
            Ok(id)
        })();
        if result.is_err() {
            let _ = self.gateway.rollback(tx, self.client.clone());
        } else {
            observer(DurabilityPhase::RemoteAfterCommit);
        }
        result
    }

    /// Remote notifications are hints. Lost callbacks are repaired by the
    /// replay performed before a checkpoint/final release. Never acknowledge
    /// a supplied MAX(id) or local append result without reading intervening rows.
    pub fn replay(&mut self) -> Result<(), String> {
        self.replay_observed(None, &mut |_| {})
    }

    pub fn replay_observed(
        &mut self,
        transaction: Option<u64>,
        observer: &mut PhaseObserver<'_>,
    ) -> Result<(), String> {
        if self.scope.is_some() && transaction.is_none() {
            let tx = self
                .gateway
                .begin(TransactionBehavior::Deferred, self.client.clone())?;
            let result = self.replay_observed(Some(tx), observer);
            return match result {
                Ok(()) => match self.gateway.commit(tx, self.client.clone()) {
                    Ok(()) => Ok(()),
                    Err(error) => {
                        let _ = self.gateway.rollback(tx, self.client.clone());
                        Err(error)
                    }
                },
                Err(error) => {
                    let _ = self.gateway.rollback(tx, self.client.clone());
                    Err(error)
                }
            };
        }
        if let Some(tx) = transaction {
            self.current_scope(tx)?;
        }
        let rows = ProseRepository::new(&self.gateway, &self.client).list_updates(
            &self.doc_id,
            Some(self.covered),
            transaction,
        )?;
        for row in rows {
            let applied = (|| {
                let prepared = self.document.prepare_remote(&row.update_blob, 1)?;
                if prepared.repair_update().is_some() {
                    return Err(format!(
                        "{REPAIR_CONTEXT_REQUIRED}: replay requires an authored context and projection transaction"
                    ));
                }
                self.document.apply_prepared_remote(&prepared)
            })();
            if let Err(reason) = applied {
                self.remote_block = Some(RemoteBlock {
                    update_id: row.id,
                    reason: reason.clone(),
                });
                return Err(format!(
                    "Stored prose update {} is unapplied; original bytes retained: {reason}",
                    row.id
                ));
            }
            observer(DurabilityPhase::ReplayAppliedBeforeCoverage);
            // A malformed row fails above. Its ID and all later IDs remain
            // uncovered, so the owner cannot persist a false compacting snapshot.
            self.covered = row.id;
        }
        self.remote_block = None;
        Ok(())
    }

    /// Prepare on an isolated candidate, then persist every derived repair as a
    /// local System journal event together with its covering snapshot and the
    /// caller's projections. The source remote row was committed independently;
    /// no remote production receipt/frontier is manufactured here. Only after
    /// COMMIT are the exact prepared bytes applied to the original live owner,
    /// preserving its history, and actual stored row IDs acknowledged.
    pub fn replay_with_context<F>(
        &mut self,
        context: &AuthoredProseContext,
        projections: F,
        observer: &mut PhaseObserver<'_>,
    ) -> Result<(), String>
    where
        F: FnOnce(&DatabaseGateway, u64, &DocumentSession) -> Result<(), String>,
    {
        if self.has_uncommitted_updates() {
            return Err(
                "Commit authored updates with persist_authored before isolated remote replay"
                    .into(),
            );
        }
        self.commit_prepared_replay(context, None, projections, observer)
    }

    fn prepare_replay(&mut self, transaction: u64) -> Result<ReplayCandidate, String> {
        let mut candidate = ReplayCandidate {
            document: self.document.fork_for_remote_replay()?,
            steps: Vec::new(),
            repairs: Vec::new(),
        };
        let rows = ProseRepository::new(&self.gateway, &self.client).list_updates(
            &self.doc_id,
            Some(self.covered),
            Some(transaction),
        )?;
        let mut index = 0;
        while index < rows.len() {
            let row = &rows[index];
            let mut closure = false;
            let prepared = match candidate.document.prepare_remote(&row.update_blob, 1) {
                Ok(prepared) => Ok(prepared),
                Err(reason)
                    if reason.starts_with(&format!("{REMOTE_TEXT_RETENTION_REQUIRED}:"))
                        && index + 1 < rows.len() =>
                {
                    // Only an atomic loss refusal is eligible. Later durable
                    // rows may contain the missing clock proofs/dependencies.
                    // No raw row is applied, removed, replaced or acknowledged
                    // independently while planning this complete closure.
                    closure = true;
                    let normalized = rows[index..]
                        .iter()
                        .map(|member| {
                            DocumentSession::normalize_update(&member.update_blob, 1).map_err(
                                |error| {
                                    format!(
                                "Stored dependency closure contains invalid row {}: {error}",
                                member.id
                            )
                                },
                            )
                        })
                        .collect::<Result<Vec<_>, _>>();
                    normalized.and_then(|bytes| {
                        candidate.document.prepare_remote_batch(
                            &bytes.iter().map(Vec::as_slice).collect::<Vec<_>>(),
                        )
                    })
                }
                Err(reason) => Err(reason),
            };
            let prepared = match prepared {
                Ok(prepared) => prepared,
                Err(reason) => {
                    self.remote_block = Some(RemoteBlock {
                        update_id: row.id,
                        reason: reason.clone(),
                    });
                    return Err(format!(
                        "Stored prose update {} is unapplied; original bytes retained: {reason}",
                        row.id
                    ));
                }
            };
            if closure && prepared.repair_update().is_none() {
                let reason = format!(
                    "{REMOTE_TEXT_RETENTION_REQUIRED}: stored dependency closure requires an explicit alias repair"
                );
                self.remote_block = Some(RemoteBlock {
                    update_id: row.id,
                    reason: reason.clone(),
                });
                return Err(format!(
                    "Stored prose update {} is unapplied; original bytes retained: {reason}",
                    row.id
                ));
            }
            if let Some(repair) = prepared.repair_update() {
                candidate.repairs.push(repair.to_vec());
            }
            candidate.document.apply_prepared_remote(&prepared)?;
            if closure && candidate.document.has_pending() {
                let reason = format!(
                    "{REMOTE_TEXT_RETENTION_REQUIRED}: stored dependency closure remains incomplete"
                );
                self.remote_block = Some(RemoteBlock {
                    update_id: row.id,
                    reason: reason.clone(),
                });
                return Err(format!(
                    "Stored prose update {} is unapplied; original bytes retained: {reason}",
                    row.id
                ));
            }
            let through = if closure { rows.len() } else { index + 1 };
            candidate.steps.push(ReplayStep {
                update_ids: rows[index..through].iter().map(|row| row.id).collect(),
                prepared,
            });
            index = through;
        }
        // Keep an existing retained-row status until projections and the
        // repair snapshot commit and the exact prepared bytes reach live state.
        Ok(candidate)
    }

    fn commit_prepared_replay<F>(
        &mut self,
        context: &AuthoredProseContext,
        authored: Option<(&RevisionSource, &[CapturedAuthoredUpdate])>,
        projections: F,
        observer: &mut PhaseObserver<'_>,
    ) -> Result<(), String>
    where
        F: FnOnce(&DatabaseGateway, u64, &DocumentSession) -> Result<(), String>,
    {
        let tx = self
            .gateway
            .begin(TransactionBehavior::Immediate, self.client.clone())?;
        let result = (|| {
            self.current_scope(tx)?;
            if let Some(scope) = &self.scope {
                if context.project_id != scope.project_id
                    || context.project_sync_id != scope.project_sync_id
                    || context.sync_generation_id != scope.sync_generation_id
                {
                    return Err("Authored context differs from opened document scope".into());
                }
            }
            if self.scope.is_none()
                && authored.is_some_and(|(_, records)| {
                    records.iter().any(|record| record.deletion().is_some())
                })
            {
                return Err(
                    "Native source-operation capture requires a scope bound at open".into(),
                );
            }
            let mut candidate = self.prepare_replay(tx)?;
            let journal = AuthoredProseJournal::new(&self.gateway, &self.client);
            // The candidate already includes captured local edits. Journal
            // their original events before repairs that may reference them.
            if let Some((source, updates)) = authored {
                for record in updates {
                    native_source::append(
                        &journal,
                        context,
                        &self.doc_id,
                        record,
                        source,
                        tx,
                        &candidate.document,
                    )?;
                }
            }
            for bytes in &candidate.repairs {
                journal.append(
                    context,
                    &self.doc_id,
                    bytes,
                    &RevisionSource::System,
                    None,
                    Some(tx),
                    |_, _| candidate.document.prepare_remote(bytes, 1).map(|_| ()),
                )?;
            }
            let repository = ProseRepository::new(&self.gateway, &self.client);
            // Read every actual row, including this transaction's new local
            // and System rows. A returned append ID is not a coverage proof.
            let planned_through = candidate
                .steps
                .last()
                .and_then(|step| step.update_ids.last().copied())
                .unwrap_or(self.covered);
            for row in repository.list_updates(&self.doc_id, Some(planned_through), Some(tx))? {
                let prepared = candidate.document.prepare_remote(&row.update_blob, 1)?;
                if prepared.repair_update().is_some() {
                    return Err(
                        "A journaled replay unexpectedly required another derived repair".into(),
                    );
                }
                candidate.document.apply_prepared_remote(&prepared)?;
                candidate.steps.push(ReplayStep {
                    update_ids: vec![row.id],
                    prepared,
                });
            }
            projections(&self.gateway, tx, &candidate.document)?;
            self.current_scope(tx)?;
            if !candidate.repairs.is_empty() {
                // Without this snapshot, a crash could replay the raw input
                // before its derived row and generate a second repair event.
                // Alias coverage is part of the same CRDT state and update.
                repository.save_snapshot(
                    &self.doc_id,
                    &candidate.document.update(None, 1)?,
                    &context.now_iso,
                    Some(tx),
                )?;
            }
            observer(if authored.is_some() {
                DurabilityPhase::AuthoredBeforeCommit
            } else {
                DurabilityPhase::ReplayBeforeCommit
            });
            self.gateway.commit(tx, self.client.clone())?;
            Ok(candidate)
        })();
        let candidate = match result {
            Ok(candidate) => candidate,
            Err(error) => {
                let _ = self.gateway.rollback(tx, self.client.clone());
                return Err(error);
            }
        };
        if authored.is_some() {
            self.pending.clear();
        }
        observer(if authored.is_some() {
            DurabilityPhase::AuthoredAfterCommit
        } else {
            DurabilityPhase::ReplayAfterCommit
        });
        for step in candidate.steps {
            if let Err(reason) = self.document.apply_prepared_remote(&step.prepared) {
                self.remote_block = Some(RemoteBlock {
                    update_id: step.update_ids[0],
                    reason: reason.clone(),
                });
                return Err(format!(
                    "Committed prose update {} awaits live replay: {reason}",
                    step.update_ids[0]
                ));
            }
            for update_id in step.update_ids {
                observer(DurabilityPhase::ReplayAppliedBeforeCoverage);
                self.covered = update_id;
            }
        }
        self.remote_block = None;
        Ok(())
    }

    /// Commit captured event bytes, provenance, immutable journal, receipt and
    /// caller-owned projections (for example comment CAS) in one transaction.
    /// Failure retains the original bytes; after COMMIT, retries only replay.
    pub fn persist_authored<F>(
        &mut self,
        context: &AuthoredProseContext,
        source: &RevisionSource,
        projections: F,
        observer: &mut PhaseObserver<'_>,
    ) -> Result<(), String>
    where
        F: FnOnce(&DatabaseGateway, u64, &DocumentSession) -> Result<(), String>,
    {
        self.pending.extend(self.captured.drain_records());
        let pending = self.pending.clone();
        self.commit_prepared_replay(context, Some((source, &pending)), projections, observer)
    }

    /// Atomically save the exact replayed state, caller-owned projections, and
    /// remove only its covered tail. No semantic revision or journal is created.
    /// A failure leaves the tail recoverable and this owner available for retry.
    pub fn checkpoint<F>(
        &mut self,
        now: &str,
        projections: F,
        observer: &mut PhaseObserver<'_>,
    ) -> Result<(), String>
    where
        F: FnOnce(&DatabaseGateway, u64, &DocumentSession) -> Result<(), String>,
    {
        if self.has_uncommitted_updates() {
            return Err("Commit authored updates before checkpointing".into());
        }
        let tx = self
            .gateway
            .begin(TransactionBehavior::Immediate, self.client.clone())?;
        let result = (|| {
            self.current_scope(tx)?;
            self.replay_observed(Some(tx), observer)?;
            let bytes = self.document.update(None, 1)?;
            let repo = ProseRepository::new(&self.gateway, &self.client);
            repo.save_snapshot(&self.doc_id, &bytes, now, Some(tx))?;
            observer(DurabilityPhase::CheckpointAfterSnapshot);
            projections(&self.gateway, tx, &self.document)?;
            self.current_scope(tx)?;
            repo.delete_updates_up_to(&self.doc_id, self.covered, tx)?;
            observer(DurabilityPhase::CheckpointAfterPrune);
            self.gateway.commit(tx, self.client.clone())
        })();
        if let Err(error) = result {
            let _ = self.gateway.rollback(tx, self.client.clone());
            return Err(error);
        }
        observer(DurabilityPhase::CheckpointAfterCommit);
        Ok(())
    }
}

/// Load only from a consistent database transaction. Validation uses the same
/// path as reopening, including pending Yrs dependencies retained in snapshots.
pub fn load_document(
    repo: &ProseRepository<'_>,
    doc_id: &str,
    transaction: u64,
) -> Result<(DocumentSession, u64), String> {
    let mut document = load_snapshot(repo, doc_id, transaction)?;
    let mut covered = 0;
    for row in repo.list_updates(doc_id, None, Some(transaction))? {
        (|| {
            let prepared = document.prepare_remote(&row.update_blob, 1)?;
            if prepared.repair_update().is_some() {
                return Err(format!("{REPAIR_CONTEXT_REQUIRED}: cold replay requires an authored context and projection transaction"));
            }
            document.apply_prepared_remote(&prepared)
        })()
            .map_err(|reason| {
                format!(
                    "Stored prose update {} is unapplied; original bytes retained: {reason}",
                    row.id
                )
            })?;
        covered = row.id;
    }
    Ok((document, covered))
}

fn load_snapshot(
    repo: &ProseRepository<'_>,
    doc_id: &str,
    transaction: u64,
) -> Result<DocumentSession, String> {
    let mut document = DocumentSession::new();
    if let Some(snapshot) = repo.get_snapshot(doc_id, Some(transaction))? {
        document.apply_remote(&snapshot.state_blob, 1)?;
    }
    Ok(document)
}
