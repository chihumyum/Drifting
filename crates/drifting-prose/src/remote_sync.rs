//! Canonical remote originals enter SQLite through the shared journal. This
//! adapter supplies its mandatory Yrs projection inside the same transaction;
//! it never publishes into a live owner's input branches or undo history.
use drifting_core::database::DatabaseGateway;
use drifting_core::original_body_archive::ArchiveScope;
use drifting_core::original_operation::ChangeSetRef;
use drifting_core::prose_journal::AuthoredProseContext;
use drifting_core::remote_prose::{RemoteProseCommit, RemoteProseJournal};
use drifting_document::DocumentSession;

/// Receive a complete canonical pure-prose envelope. With an outer transaction,
/// the caller must commit before notifying live owners to replay the returned
/// documents. Duplicates still return those documents, allowing notification
/// recovery without appending the original a second time.
pub fn receive_remote_prose(
    gateway: &DatabaseGateway,
    client: &str,
    context: &AuthoredProseContext,
    expected: &ChangeSetRef,
    envelope: &[u8],
    transaction: Option<u64>,
) -> Result<RemoteProseCommit, String> {
    RemoteProseJournal::new(gateway, client).receive(
        context,
        expected,
        envelope,
        transaction,
        |repository, tx, target, update| {
            let scope = ArchiveScope {
                project_id: expected.project_id.clone(),
                project_sync_id: expected.project_sync_id.clone(),
                sync_generation_id: expected.sync_generation_id.clone(),
                document_id: target.id.clone(),
                incarnation: target.incarnation,
            };
            crate::native_source::current_scope(gateway, client, tx, &scope)?;
            DocumentSession::validate_update_v1(update)?;
            // A later mutation in this envelope sees earlier appended rows in
            // this transaction, including when they target the same document.
            let (mut document, _) = crate::load_document(repository, &target.id, tx)?;
            let prepared = document.prepare_remote(update, 1)?;
            if prepared.repair_update().is_some() {
                return Err(format!(
                    "{}: remote original requires an authored repair transaction",
                    crate::REPAIR_CONTEXT_REQUIRED
                ));
            }
            document.apply_prepared_remote(&prepared)?;
            if document.has_pending() {
                return Err("Remote prose update has unresolved dependencies".into());
            }
            document.native_projection()?;
            Ok(document.semantic()?.to_string())
        },
    )
}
