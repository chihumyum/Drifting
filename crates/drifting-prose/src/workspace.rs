//! Domain operations that need authoritative prose capture. The core owns the
//! transaction and lifecycle; this adapter supplies the shared Yrs document.
use drifting_core::database::DatabaseGateway;
use drifting_core::prose_journal::AuthoredProseContext;
use drifting_core::workspace::{
    ChapterSeed, WorkspaceChapter, WorkspaceDrift, WorkspaceElement, WorkspaceElementCategory,
    WorkspaceStore, WorkspaceStoryline,
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

/// Drift bodies restore the same way as chapter bodies.
pub fn restore_drift(
    gateway: &DatabaseGateway,
    client: &str,
    context: &AuthoredProseContext,
    drift_id: &str,
) -> Result<WorkspaceDrift, String> {
    WorkspaceStore::new(gateway, client).restore_drift(
        context,
        drift_id,
        |repository, tx, document_id| {
            let (document, _) = crate::load_document(repository, document_id, tx)?;
            if document.has_pending() {
                return Err("Drift has unresolved prose dependencies; restore is not ready".into());
            }
            document.native_projection()?;
            Ok(ChapterSeed {
                update: document.update(None, 1)?,
                content_json: document.semantic()?.to_string(),
            })
        },
    )
}

/// `reconcileProjectProseMetrics`: every live chapter and drift with durable
/// prose gets its canonical projection at its current revision, without
/// touching `updated_at`. Returns each node whose projection failed.
pub fn reconcile_node_projections(
    gateway: &DatabaseGateway,
    client: &str,
    project_id: &str,
    now: &str,
) -> Result<Vec<(String, String)>, String> {
    use drifting_core::database::TransactionBehavior;
    use drifting_core::prose::ProseRepository;
    use drifting_core::workspace::NodeProjection;
    let store = WorkspaceStore::new(gateway, client);
    let repository = ProseRepository::new(gateway, client);
    let mut failures = Vec::new();
    for node in store.node_word_counts(project_id)? {
        let doc_id = format!("node-content:{}", node.node_id);
        let result = (|| {
            let tx = gateway.begin(TransactionBehavior::Deferred, client.into())?;
            let captured = (|| {
                let revision = repository.get_revision(&doc_id, Some(tx))?;
                if revision == 0 {
                    // A body without Yjs state keeps its renderer seed basis.
                    return Ok(None);
                }
                let (document, _) = crate::load_document(&repository, &doc_id, tx)?;
                if document.has_pending() {
                    return Err("Node prose has unresolved dependencies".to_string());
                }
                Ok(Some((document.prose_projection()?, revision)))
            })();
            let _ = gateway.rollback(tx, client.into());
            let Some((projection, revision)) = captured? else {
                return Ok(());
            };
            store
                .materialize_node_projection(
                    project_id,
                    &node.node_id,
                    &NodeProjection {
                        content_json: projection.content_json,
                        outline_json: projection.outline_json,
                        word_count: projection.word_count,
                        basis_hash: projection.basis_hash,
                        revision,
                    },
                    now,
                    false,
                )
                .map(|_| ())
        })();
        if let Err(error) = result {
            failures.push((node.node_id, error));
        }
    }
    Ok(failures)
}
