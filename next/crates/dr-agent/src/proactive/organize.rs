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
    let first = &batch.documents[0].target.title;
    let title = if batch.documents.len() == 1 {
        format!("整理：{}", super::delta::bounded(first, 30))
    } else {
        format!(
            "整理：{} 等 {} 篇",
            super::delta::bounded(first, 24),
            batch.documents.len()
        )
    };
    let changes = batch
        .documents
        .iter()
        .map(|document| {
            format!(
                "## {}「{}」\n目标：{}:{}\n{}\n{}",
                if document.target.kind == "chapter" {
                    "章节"
                } else {
                    "构想"
                },
                document.target.title,
                document.target.kind,
                document.target.id,
                if document.has_baseline {
                    "改动（只是摘录，需要时读全文）："
                } else {
                    "新写的，或此前没有本地版本；节选："
                },
                document.digest,
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let prompt = format!(
        "作者上次在 Drifting 里写了下面这些内容。请把其中新出现或发生变化的设定整理进项目，让要素跟上正文。\n\n{changes}\n\n先查已有要素和项目记忆，识别已有对象，不要重复新建。按正文给出的设定维护要素；状态有变化时在对应章节记录要素变更，整理正文写明的关系。项目记忆里作者对登记和整理的要求优先；拿不准的事不要替作者决定。不要修改正文，不要删除任何东西。这是一次就能做完的整理，不要建立任务计划。\n\n完成后简短说明更新了哪些要素、变更和关系，以及需要作者确认的事。"
    );
    Some(OrganizeTask {
        title,
        prompt,
        coverage: batch.coverage.clone(),
    })
}
