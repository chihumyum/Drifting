use super::{DeltaBatch, DeltaCursor};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrganizeTask {
    pub title: String,
    pub prompt: String,
    pub coverage: DeltaCursor,
}

/// A local card, without a model request. Its caller starts an ordinary
/// read/write session only after the author opens it.
pub fn prepare_organize(batch: &DeltaBatch) -> Option<OrganizeTask> {
    if batch.documents.is_empty() {
        return None;
    }
    let (title, prompt) = crate::novel_template::organize(&batch.documents);
    Some(OrganizeTask {
        title,
        prompt,
        coverage: batch.coverage.clone(),
    })
}
