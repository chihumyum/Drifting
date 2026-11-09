use super::{DeltaBatch, DeltaCursor};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrganizeTask {
    pub title: String,
    pub prompt: String,
    pub coverage: DeltaCursor,
}

/// A v2.2 local card, without a model request. v3 maintenance intent must
/// come from book guidance in the check-in request. Its caller starts an ordinary
/// read/write session only after the author opens it.
pub fn prepare_organize(batch: &DeltaBatch) -> Option<OrganizeTask> {
    if batch.documents.is_empty()
        || batch
            .documents
            .iter()
            .any(|d| !matches!(d.target.kind.as_str(), "chapter" | "idea"))
    {
        return None;
    }
    let (title, prompt) = crate::novel_template::organize(&batch.documents);
    Some(OrganizeTask {
        title,
        prompt,
        coverage: batch.coverage.clone(),
    })
}
