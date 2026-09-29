//! Bounded, read-only search capture. Authoritative bytes and revisions share
//! one SQLite snapshot; CPU projection runs after releasing that transaction.
use drifting_core::database::{DatabaseGateway, TransactionBehavior};
use drifting_core::prose::ProseRepository;
use serde::Serialize;

pub const SEARCH_BATCH_SIZE: usize = 16;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchTextProjection {
    pub doc_id: String,
    pub revision: u64,
    /// None delegates seed-only or unsupported CRDT content to the renderer.
    pub blocks: Option<Vec<String>>,
}

pub fn read_search_text(
    gateway: &DatabaseGateway,
    client: &str,
    doc_ids: &[String],
) -> Result<Vec<SearchTextProjection>, String> {
    if doc_ids.is_empty() || doc_ids.len() > SEARCH_BATCH_SIZE {
        return Err("Search capture requires 1 to 16 document identities".into());
    }
    let repo = ProseRepository::new(gateway, client);
    let tx = gateway.begin(TransactionBehavior::Deferred, client.into())?;
    let captured = (|| {
        doc_ids
            .iter()
            .map(|doc_id| {
                let revision = repo.get_revision(doc_id, Some(tx))?;
                let snapshot = repo.get_snapshot(doc_id, Some(tx))?;
                let updates = repo.list_updates(doc_id, None, Some(tx))?;
                let bytes = snapshot
                    .into_iter()
                    .map(|row| row.state_blob)
                    .chain(updates.into_iter().map(|row| row.update_blob))
                    .collect::<Vec<_>>();
                Ok((doc_id.clone(), revision, bytes))
            })
            .collect::<Result<Vec<_>, String>>()
    })();
    let released = gateway.rollback(tx, client.into());
    let captured = captured?;
    released?;
    Ok(captured
        .into_iter()
        .map(|(doc_id, revision, bytes)| SearchTextProjection {
            doc_id,
            revision,
            blocks: if bytes.is_empty() {
                None
            } else {
                // Existing Yjs owns unsupported or unresolved representations. This
                // optional acceleration must never fabricate empty text for them.
                drifting_document::search_text_blocks(&bytes).ok()
            },
        })
        .collect())
}
