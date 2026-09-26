//! The durable owner carries opaque command records through commit/retry.
//! The journal declaration is created here only from actual native capture;
//! receiver authorization still reconstructs it from immutable originals.
use drifting_core::original_operation::{DeclaredTextDelete, SourceId, SourceRange};
use drifting_core::prose::RevisionSource;
use drifting_core::prose_journal::{
    AuthoredProseContext, AuthoredProseJournal, ProseSourceOperationEvidence,
};
use drifting_document::{CapturedAuthoredUpdate, DocumentSession, NativeSourceRange};

pub(crate) fn current_scope(
    gateway: &drifting_core::database::DatabaseGateway,
    client: &str,
    transaction: u64,
    scope: &drifting_core::original_body_archive::ArchiveScope,
) -> Result<(), String> {
    let incarnation = AuthoredProseJournal::new(gateway, client).current_incarnation(
        transaction,
        &scope.project_id,
        &scope.project_sync_id,
        &scope.sync_generation_id,
        &scope.document_id,
    )?;
    if incarnation != scope.incarnation {
        return Err("Prose owner scope incarnation is not current".into());
    }
    Ok(())
}

fn range(value: &NativeSourceRange) -> SourceRange {
    SourceRange {
        client: value.client(),
        clock: value.clock(),
        length: value.length(),
    }
}

pub(crate) fn append(
    journal: &AuthoredProseJournal<'_>,
    context: &AuthoredProseContext,
    doc_id: &str,
    record: &CapturedAuthoredUpdate,
    source: &RevisionSource,
    transaction: u64,
    candidate: &DocumentSession,
) -> Result<(), String> {
    let update = record.update();
    let validate = |_: &drifting_core::prose::ProseRepository<'_>, _| {
        candidate.prepare_remote(update, 1).map(|_| ())
    };
    if let Some(captured) = record.deletion() {
        let intent = captured.intent();
        let evidence = ProseSourceOperationEvidence {
            before_snapshot: captured.transaction().before_snapshot().into(),
            transaction_deletes: captured
                .transaction()
                .transaction_deletes()
                .iter()
                .map(range)
                .collect(),
            intent: DeclaredTextDelete {
                target_text: SourceId {
                    client: intent.target_text().client(),
                    clock: intent.target_text().clock(),
                },
                offset_utf16: u64::from(intent.offset_utf16()),
                length_utf16: u64::from(intent.length_utf16()),
                selected_source_ranges: intent.selected_source_ranges().iter().map(range).collect(),
            },
        };
        journal.append_with_source_operation(
            context,
            doc_id,
            update,
            &evidence,
            source,
            None,
            Some(transaction),
            validate,
        )?;
    } else {
        journal.append(
            context,
            doc_id,
            update,
            source,
            None,
            Some(transaction),
            validate,
        )?;
    }
    Ok(())
}
