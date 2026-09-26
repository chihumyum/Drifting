//! Domain operations that need authoritative prose capture. The core owns the
//! transaction and lifecycle; this adapter supplies the shared Yrs document.
use drifting_core::database::DatabaseGateway;
use drifting_core::prose_journal::AuthoredProseContext;
use drifting_core::workspace::{
    ChapterSeed, WorkspaceChapter, WorkspaceElement, WorkspaceElementCategory, WorkspaceStore,
    WorkspaceStoryline,
};

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

/// Element bodies restore exactly like chapter prose: the retained snapshot and
/// ordered tail are merged and validated inside the core's transaction.
pub fn restore_element(
    gateway: &DatabaseGateway,
    client: &str,
    context: &AuthoredProseContext,
    element_id: &str,
) -> Result<WorkspaceElement, String> {
    WorkspaceStore::new(gateway, client).restore_element(
        context,
        element_id,
        |repository, tx, document_id| {
            let (document, _) = crate::load_document(repository, document_id, tx)?;
            if document.has_pending() {
                return Err(
                    "Element has unresolved prose dependencies; restore is not ready".into(),
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

/// Category bodies restore the same way as element and chapter bodies.
pub fn restore_element_category(
    gateway: &DatabaseGateway,
    client: &str,
    context: &AuthoredProseContext,
    category_id: &str,
) -> Result<WorkspaceElementCategory, String> {
    WorkspaceStore::new(gateway, client).restore_element_category(
        context,
        category_id,
        |repository, tx, document_id| {
            let (document, _) = crate::load_document(repository, document_id, tx)?;
            if document.has_pending() {
                return Err(
                    "Category has unresolved prose dependencies; restore is not ready".into(),
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

/// Storyline bodies restore the same way as chapter and element bodies.
pub fn restore_storyline(
    gateway: &DatabaseGateway,
    client: &str,
    context: &AuthoredProseContext,
    storyline_id: &str,
) -> Result<WorkspaceStoryline, String> {
    WorkspaceStore::new(gateway, client).restore_storyline(
        context,
        storyline_id,
        |repository, tx, document_id| {
            let (document, _) = crate::load_document(repository, document_id, tx)?;
            if document.has_pending() {
                return Err(
                    "Storyline has unresolved prose dependencies; restore is not ready".into(),
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
