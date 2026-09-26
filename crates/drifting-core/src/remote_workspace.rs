//! One atomic receiver for canonical originals. Metadata and prose materialize
//! inside the same transaction; unsupported envelopes are rejected whole.
//! A mandatory host projector validates CRDT bytes before any receipt commits.
use crate::database::{DatabaseGateway, DatabaseValue as V, TransactionBehavior};
use crate::original_operation::{
    verify_change_set, ChangeSetRef, MutationTarget, VerifiedChangeSet,
};
use crate::original_operation_store::OriginalOperationStore;
use crate::prose::{ProseRepository, RevisionSource};
use crate::prose_journal::{opaque, token, AuthoredProseContext, AuthoredProseJournal};
use serde::Serialize;
use std::collections::HashSet;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteWorkspaceCommit {
    pub already_applied: bool,
    pub change_set_id: String,
    /// Also returned for duplicate delivery so a lost live notification can retry.
    pub affected_documents: Vec<String>,
}

pub struct RemoteWorkspaceJournal<'a> {
    gateway: &'a DatabaseGateway,
    client: &'a str,
}

fn text(value: &str) -> V {
    V::Text(value.into())
}
fn integer(value: u64) -> V {
    V::Integer(value.to_string())
}

impl<'a> RemoteWorkspaceJournal<'a> {
    pub fn new(gateway: &'a DatabaseGateway, client: &'a str) -> Self {
        Self { gateway, client }
    }

    /// Some(transaction) is isolated by a savepoint. The result does not imply
    /// outer COMMIT or live reconciliation; the caller publishes only afterwards.
    pub fn receive<F>(
        &self,
        context: &AuthoredProseContext,
        expected: &ChangeSetRef,
        envelope: &[u8],
        transaction: Option<u64>,
        project: F,
    ) -> Result<RemoteWorkspaceCommit, String>
    where
        F: FnMut(&ProseRepository<'_>, u64, &MutationTarget, &[u8]) -> Result<String, String>,
    {
        self.receive_verified(
            context,
            verify_change_set(envelope, expected)?,
            envelope,
            transaction,
            project,
        )
    }

    pub(crate) fn receive_verified<F>(
        &self,
        context: &AuthoredProseContext,
        original: VerifiedChangeSet,
        envelope: &[u8],
        transaction: Option<u64>,
        mut project: F,
    ) -> Result<RemoteWorkspaceCommit, String>
    where
        F: FnMut(&ProseRepository<'_>, u64, &MutationTarget, &[u8]) -> Result<String, String>,
    {
        let expected = original.source();
        if context.project_id != expected.project_id
            || context.project_sync_id != expected.project_sync_id
            || context.sync_generation_id != expected.sync_generation_id
            || !opaque(&context.installation_id)
            || context.now_iso.is_empty()
            || context.now_ms > 9_007_199_254_740_991
            || !token(&context.new_writer_id)
            || !token(&context.new_writer_epoch)
        {
            return Err("Remote prose context does not match its expected scope or clock".into());
        }
        crate::remote_workspace_metadata::validate(&original)?;
        let tx = match transaction {
            Some(tx) => {
                self.execute(tx, "SAVEPOINT native_remote_workspace", vec![])?;
                tx
            }
            None => self
                .gateway
                .begin(TransactionBehavior::Immediate, self.client.into())?,
        };
        let result = self.receive_in_transaction(tx, context, &original, envelope, &mut project);
        match result {
            Ok(result) => {
                let committed = if transaction.is_some() {
                    self.execute(tx, "RELEASE SAVEPOINT native_remote_workspace", vec![])
                        .map(|_| ())
                } else {
                    self.gateway.commit(tx, self.client.into())
                };
                match committed {
                    Ok(()) => Ok(result),
                    Err(error) => Err(self.abort(tx, transaction.is_some(), error)),
                }
            }
            Err(error) => Err(self.abort(tx, transaction.is_some(), error)),
        }
    }

    fn receive_in_transaction<F>(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        original: &VerifiedChangeSet,
        envelope: &[u8],
        project: &mut F,
    ) -> Result<RemoteWorkspaceCommit, String>
    where
        F: FnMut(&ProseRepository<'_>, u64, &MutationTarget, &[u8]) -> Result<String, String>,
    {
        let source = original.source();
        let journal = AuthoredProseJournal::new(self.gateway, self.client);
        self.guard_project(tx, source)?;
        let exists = !self
            .gateway
            .query(
                "SELECT 1 FROM sync_change_set WHERE change_set_id=?".into(),
                vec![text(&source.change_set_id)],
                Some(tx),
                self.client.into(),
            )?
            .rows
            .is_empty();
        if exists {
            // This checks the immutable bytes, ALL rows, header and apply receipt.
            // Never infer delivery from raw byte equality or retrofit admission.
            OriginalOperationStore::new(self.gateway, self.client)
                .load_change_set_in_transaction(source, tx)?;
            return Ok(RemoteWorkspaceCommit {
                already_applied: true,
                change_set_id: source.change_set_id.clone(),
                affected_documents: self.prose_documents(tx, original)?,
            });
        }
        self.execute(tx, "INSERT INTO sync_change_set (change_set_id,sync_generation_id,project_id,project_sync_id,writer_id,writer_epoch,device_seq,hlc_wall_ms,hlc_counter,protocol_version,payload_version,mutation_count,encoded_bytes,payload_sha256,origin,apply_state,created_at) VALUES (?,?,?,?,?,?,?,?,?,1,1,?,?,?,'remote','applying',?)", vec![
            text(&source.change_set_id), text(&source.sync_generation_id), text(&source.project_id), text(&source.project_sync_id),
            text(original.writer_id()), text(original.writer_epoch()), integer(original.device_seq()),
            integer(original.hlc_wall_ms()), integer(original.hlc_counter()), integer(original.mutations().len() as u64),
            V::Blob(envelope.to_vec()), text(&source.original_envelope_sha256), text(&context.now_iso),
        ])?;
        for mutation in original.mutations() {
            let target = mutation.target();
            self.execute(tx, "INSERT INTO sync_mutation (change_set_id,mutation_index,target_family,target_kind,target_id,incarnation,action,payload_version,payload_cbor,payload_sha256) VALUES (?,?,?,?,?,?,?,1,?,?)", vec![
                text(&source.change_set_id), integer(mutation.index()), text(&target.family), text(&target.kind), text(&target.id), integer(target.incarnation), text(mutation.action()),
                V::Blob(mutation.canonical_payload_bytes().to_vec()), text(mutation.payload_sha256().strip_prefix("sha256:").ok_or("Invalid mutation hash")?),
            ])?;
        }
        // Chapter creation and its prose seed are one original. Establish the
        // winning metadata owners before checking and projecting prose scopes.
        crate::remote_workspace_metadata::apply(self.gateway, self.client, tx, context, original)?;
        let documents = self.prose_documents(tx, original)?;
        let repository = ProseRepository::new(self.gateway, self.client);
        let winning_iso = utc_iso(original.hlc_wall_ms());
        for mutation in original
            .mutations()
            .iter()
            .filter(|m| m.action() == "yjs.update")
        {
            let target = mutation.target();
            let update = mutation.original_yjs_update()?;
            let content = project(&repository, tx, target, &update)?;
            let json: serde_json::Value =
                serde_json::from_str(&content).map_err(|error| error.to_string())?;
            if json.get("type").and_then(serde_json::Value::as_str) != Some("doc") {
                return Err("Remote prose projector must return a semantic document".into());
            }
            let appended = repository.append_update(
                &target.id,
                &update,
                &RevisionSource::Remote,
                &context.now_iso,
                None,
                Some(tx),
            )?;
            self.execute(tx, "INSERT INTO sync_yjs_materialization_receipt (change_set_id,mutation_index,admission_version,original_envelope_sha256,document_id,incarnation,event_sha256,update_row_id,document_revision,created_at) VALUES (?,?,1,?,?,?,?,?,?,?)", vec![
                text(&source.change_set_id), integer(mutation.index()), text(&source.original_envelope_sha256),
                text(&target.id), integer(target.incarnation), text(&crate::materialization_admission::event_hash(&update)),
                integer(appended.update_id), integer(appended.revision), text(&winning_iso),
            ])?;
            self.cache(tx, &source.project_id, target, &content, &winning_iso)?;
        }
        journal.observe_remote_hlc(tx, context, original.hlc_wall_ms(), original.hlc_counter())?;
        self.execute(tx, "INSERT INTO sync_apply_receipt (change_set_id,sync_generation_id,mutation_count,applied_at) VALUES (?,?,?,?)", vec![
            text(&source.change_set_id), text(&source.sync_generation_id), integer(original.mutations().len() as u64), text(&context.now_iso),
        ])?;
        self.execute(
            tx,
            "UPDATE sync_change_set SET apply_state='applied',applied_at=? WHERE change_set_id=?",
            vec![text(&context.now_iso), text(&source.change_set_id)],
        )?;
        Ok(RemoteWorkspaceCommit {
            already_applied: false,
            change_set_id: source.change_set_id.clone(),
            affected_documents: documents,
        })
    }

    fn guard_project(&self, tx: u64, source: &ChangeSetRef) -> Result<(), String> {
        let rows = self.gateway.query(
            "SELECT 1 FROM sync_generation g JOIN project p ON p.id=g.project_id WHERE g.sync_generation_id=? AND g.project_id=? AND g.project_sync_id=? AND g.status='active' AND NOT EXISTS (SELECT 1 FROM sync_generation_purge x WHERE x.sync_generation_id=g.sync_generation_id) AND NOT EXISTS (SELECT 1 FROM sync_entity_lifecycle l WHERE l.sync_generation_id=g.sync_generation_id AND l.entity_kind='project' AND l.entity_id=g.project_id AND l.state!='live')".into(),
            vec![text(&source.sync_generation_id), text(&source.project_id), text(&source.project_sync_id)],
            Some(tx), self.client.into(),
        )?.rows;
        if rows.len() != 1 {
            return Err("Remote original does not belong to an active project generation".into());
        }
        Ok(())
    }

    fn prose_documents(
        &self,
        tx: u64,
        original: &VerifiedChangeSet,
    ) -> Result<Vec<String>, String> {
        let source = original.source();
        let journal = AuthoredProseJournal::new(self.gateway, self.client);
        let mut documents = Vec::new();
        let mut seen = HashSet::new();
        for mutation in original
            .mutations()
            .iter()
            .filter(|m| m.action() == "yjs.update")
        {
            let target = mutation.target();
            let incarnation = journal.current_incarnation(
                tx,
                &source.project_id,
                &source.project_sync_id,
                &source.sync_generation_id,
                &target.id,
            )?;
            if incarnation != target.incarnation {
                return Err("Remote prose incarnation is stale".into());
            }
            if seen.insert(target.id.clone()) {
                documents.push(target.id.clone());
            }
        }
        Ok(documents)
    }

    fn cache(
        &self,
        tx: u64,
        project_id: &str,
        target: &MutationTarget,
        content: &str,
        now: &str,
    ) -> Result<(), String> {
        let (kind, id) = target
            .id
            .split_once(':')
            .ok_or("Invalid prose document ID")?;
        if kind == "node-content" {
            self.execute(tx, "INSERT INTO node_content(node_id,content_json,created_at,updated_at) VALUES (?,?,?,?) ON CONFLICT(node_id) DO UPDATE SET content_json=excluded.content_json,updated_at=excluded.updated_at",
                vec![text(id),text(content),text(now),text(now)])?;
        } else {
            let table = match kind {
                "element" => "element",
                "storyline" => "storylines",
                "category" => "element_category",
                _ => return Err("Invalid prose owner".into()),
            };
            if self.execute(
                tx,
                &format!(
                    "UPDATE {table} SET content_json=?,updated_at=? WHERE id=? AND project_id=?"
                ),
                vec![text(content), text(now), text(id), text(project_id)],
            )? != 1
            {
                return Err("Remote prose owner changed during materialization".into());
            }
        }
        Ok(())
    }

    fn execute(&self, tx: u64, sql: &str, values: Vec<V>) -> Result<u64, String> {
        Ok(self
            .gateway
            .execute(sql.into(), values, Some(tx), self.client.into())?
            .changes)
    }
    fn abort(&self, tx: u64, nested: bool, original: String) -> String {
        let rollback = if nested {
            self.execute(tx, "ROLLBACK TO SAVEPOINT native_remote_workspace", vec![])
                .and_then(|_| self.execute(tx, "RELEASE SAVEPOINT native_remote_workspace", vec![]))
                .map(|_| ())
        } else {
            self.gateway.rollback(tx, self.client.into())
        };
        match rollback {
            Ok(()) => original,
            Err(error) => format!("{original}; remote prose rollback failed: {error}"),
        }
    }
}

// Match the renderer's Date(wallMs).toISOString(), including its invalid-date
// fallback, without adding a time/runtime dependency to the shared core.
pub(crate) fn utc_iso(wall_ms: u64) -> String {
    let ms = if wall_ms <= 8_640_000_000_000_000 {
        wall_ms
    } else {
        0
    };
    let days = (ms / 86_400_000) as i64 + 719_468;
    let era = days / 146_097;
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36524 - day_of_era / 146096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = month_index + if month_index < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    let year = if year <= 9999 {
        format!("{year:04}")
    } else {
        format!("+{year:06}")
    };
    format!(
        "{year}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        (ms / 3_600_000) % 24,
        (ms / 60_000) % 60,
        (ms / 1000) % 60,
        ms % 1000
    )
}
