//! Domain operations that need authoritative prose capture. The core owns the
//! transaction and lifecycle; this adapter supplies the shared Yrs document.
use drifting_core::database::DatabaseGateway;
use drifting_core::prose_journal::AuthoredProseContext;
use drifting_core::workspace::{ChapterSeed, WorkspaceChapter, WorkspaceStore};

pub fn restore_chapter(
    gateway: &DatabaseGateway,
    client: &str,
    context: &AuthoredProseContext,
    chapter_id: &str,
) -> Result<WorkspaceChapter, String> {
    WorkspaceStore::new(gateway, client).restore_chapter(
        context,
        chapter_id,
        |repository, tx, document_id| {
            // A trashed chapter deliberately has no live scope. Read its
            // retained snapshot and tail inside the core's restore transaction.
            let (document, _) = crate::load_document(repository, document_id, tx)?;
            if document.has_pending() {
                return Err(
                    "Chapter has unresolved prose dependencies; restore is not ready".into(),
                );
            }
            document.native_projection()?;
            Ok(ChapterSeed {
                update: document.update(None, 1)?,
                content_json: document.semantic()?.to_string(),
            })
        },
    )
}
