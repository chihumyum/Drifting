//! Search reads current prose owners or scoped, temporary read-only owners.
//! Hits carry CRDT positions, never a temporary owner's revision or SQL cache.
use super::*;
use drifting_document::{native_search_ranges, NativeSearchMatch};
use serde::Serialize;

const HIT_LIMIT: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchScope {
    project_id: String,
    project_sync_id: String,
    sync_generation_id: String,
    pub(super) document_id: String,
    incarnation: u64,
}

impl From<&ArchiveScope> for SearchScope {
    fn from(scope: &ArchiveScope) -> Self {
        Self {
            project_id: scope.project_id.clone(),
            project_sync_id: scope.project_sync_id.clone(),
            sync_generation_id: scope.sync_generation_id.clone(),
            document_id: scope.document_id.clone(),
            incarnation: scope.incarnation,
        }
    }
}

impl SearchScope {
    pub(super) fn matches(&self, scope: &ArchiveScope) -> bool {
        self.project_id == scope.project_id
            && self.project_sync_id == scope.project_sync_id
            && self.sync_generation_id == scope.sync_generation_id
            && self.document_id == scope.document_id
            && self.incarnation == scope.incarnation
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SearchKind {
    Title,
    Prose,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchMatch {
    start_anchor: String,
    end_anchor: String,
    matched_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchHit {
    chapter_id: String,
    chapter_title: String,
    kind: SearchKind,
    preview: String,
    scope: SearchScope,
    #[serde(rename = "match")]
    matched: Option<SearchMatch>,
}

impl WorkspaceSession {
    pub(super) fn search(
        &self,
        documents: &HashMap<u64, LabSession>,
        project_id: &str,
        query: &str,
    ) -> Result<Value, String> {
        self.project(project_id)?;
        let query = query.trim();
        let mut hits = Vec::new();
        let mut unavailable = Vec::new();
        if query.is_empty() {
            return Ok(json!({"hits":hits,"unavailable":unavailable,"truncated":false}));
        }
        let store = WorkspaceStore::new(&self.gateway, CLIENT);
        for chapter in store.list_chapters(project_id)? {
            let read = (|| -> Result<(), String> {
                let scope = store.chapter_scope(project_id, &chapter.id)?;
                if !native_search_ranges(&chapter.title, query, 1).is_empty() {
                    hits.push(SearchHit {
                        chapter_id: chapter.id.clone(),
                        chapter_title: chapter.title.clone(),
                        kind: SearchKind::Title,
                        preview: chapter.title.clone(),
                        scope: SearchScope::from(&scope),
                        matched: None,
                    });
                }
                if hits.len() > HIT_LIMIT {
                    return Ok(());
                }
                let reader;
                let document = if let Some(handle) =
                    self.documents.get(&(project_id.into(), chapter.id.clone()))
                {
                    let owner = documents
                        .get(handle)
                        .ok_or("Workspace document owner is missing")?;
                    if owner.owner.scope != scope || owner.document.remote_block().is_some() {
                        return Err("Chapter has unresolved changes or changed scope".into());
                    }
                    &owner.document
                } else {
                    reader = DurableDocument::open_with_scope(
                        self.gateway.clone(),
                        CLIENT,
                        scope.clone(),
                    )?;
                    &reader
                };
                if document.has_pending() {
                    return Err("Chapter prose dependencies are unresolved".into());
                }
                for hit in document.search_native(query, HIT_LIMIT + 1 - hits.len())? {
                    hits.push(SearchHit {
                        chapter_id: chapter.id.clone(),
                        chapter_title: chapter.title.clone(),
                        kind: SearchKind::Prose,
                        preview: hit.preview,
                        scope: SearchScope::from(&scope),
                        matched: Some(SearchMatch {
                            start_anchor: STANDARD.encode(hit.matched.start_anchor),
                            end_anchor: STANDARD.encode(hit.matched.end_anchor),
                            matched_text: hit.matched.matched_text,
                        }),
                    });
                }
                Ok(())
            })();
            if read.is_err() {
                unavailable.push(json!({"chapterId":chapter.id,"chapterTitle":chapter.title,
                    "message":"此章节正文暂不可读取，请恢复后重试"}));
            }
            if hits.len() > HIT_LIMIT {
                break;
            }
        }
        let truncated = hits.len() > HIT_LIMIT;
        hits.truncate(HIT_LIMIT);
        Ok(json!({"hits":hits,"unavailable":unavailable,"truncated":truncated}))
    }

    pub(super) fn resolve_search_hit(
        &self,
        documents: &HashMap<u64, LabSession>,
        hit: &SearchHit,
    ) -> Result<Value, String> {
        self.project(&hit.scope.project_id)?;
        let store = WorkspaceStore::new(&self.gateway, CLIENT);
        let scope = store.chapter_scope(&hit.scope.project_id, &hit.chapter_id)?;
        if !hit.scope.matches(&scope) {
            return Err("搜索结果的章节已更改，请重新搜索".into());
        }
        let handle = self
            .documents
            .get(&(hit.scope.project_id.clone(), hit.chapter_id.clone()))
            .ok_or("请先打开搜索结果所在章节")?;
        let owner = documents
            .get(handle)
            .ok_or("Workspace document owner is missing")?;
        if owner.owner.scope != scope
            || owner.write_blocked()
            || owner.document.has_pending()
            || owner.document.active_drafts() > 0
            || owner.document.active_input_compositions() > 0
        {
            return Err("请先完成或恢复当前编辑，再定位搜索结果".into());
        }
        let range = match (&hit.kind, &hit.matched) {
            (SearchKind::Title, None) => {
                let chapter = store
                    .list_chapters(&hit.scope.project_id)?
                    .into_iter()
                    .find(|chapter| chapter.id == hit.chapter_id)
                    .ok_or("搜索结果所在章节已不可用")?;
                if chapter.title != hit.chapter_title {
                    return Err("章节标题已更改，请重新搜索".into());
                }
                None
            }
            (SearchKind::Prose, Some(matched)) => Some(
                owner
                    .document
                    .resolve_search_match(&NativeSearchMatch {
                        start_anchor: STANDARD
                            .decode(&matched.start_anchor)
                            .map_err(|error| error.to_string())?,
                        end_anchor: STANDARD
                            .decode(&matched.end_anchor)
                            .map_err(|error| error.to_string())?,
                        matched_text: matched.matched_text.clone(),
                    })?
                    .ok_or("搜索结果原文已更改，请重新搜索")?,
            ),
            _ => return Err("Invalid search result kind or match".into()),
        };
        Ok(json!({"revision":owner.document.native_projection()?.revision,"range":range}))
    }
}
