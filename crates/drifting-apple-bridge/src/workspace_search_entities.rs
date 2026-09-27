//! Search beyond chapter titles and prose: chapter summaries, drifts,
//! elements (name, aliases, summary, facts), categories, storylines and
//! materials, with anchored hits in their bodies. Bodies read their live
//! owner or a cold reader; a per-revision plain-text cache skips cold bodies
//! that cannot match, so repeated queries stay cheap.
use super::search::SearchScope;
use super::*;
use drifting_document::{native_search_preview, native_search_ranges, NativeSearchMatch};
use serde::Serialize;

const ENTITY_HIT_LIMIT: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EntityMatch {
    start_anchor: String,
    end_anchor: String,
    matched_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EntityHit {
    /// `chapter`, `drift`, `element`, `category`, `storyline` or `library`.
    kind: String,
    id: String,
    title: String,
    /// `title`, `name`, `alias`, `summary`, `fact`, `body`, `text` or `notes`.
    field: String,
    preview: String,
    /// Body hits only: the document scope and CRDT anchors.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    scope: Option<SearchScope>,
    #[serde(default, rename = "match", skip_serializing_if = "Option::is_none")]
    matched: Option<EntityMatch>,
}

/// One searchable entity: its fields and, for prose owners, its body.
struct Paper {
    kind: &'static str,
    id: String,
    title: String,
    fields: Vec<(&'static str, String)>,
    body: Option<String>,
}

impl WorkspaceSession {
    pub(super) fn body_owner(&self, kind: &str, key: &(String, String)) -> Option<u64> {
        match kind {
            "drift" => self.drift_bodies.get(key),
            "element" => self.elements.get(key),
            "category" => self.category_bodies.get(key),
            "storyline" => self.storyline_bodies.get(key),
            _ => None,
        }
        .copied()
    }

    pub(super) fn search_entities(
        &mut self,
        documents: &HashMap<u64, LabSession>,
        project_id: &str,
        query: &str,
    ) -> Result<Value, String> {
        self.project(project_id)?;
        let query = query.trim();
        let mut hits: Vec<EntityHit> = Vec::new();
        let mut unavailable = Vec::new();
        if query.is_empty() {
            return Ok(json!({"hits": hits, "unavailable": unavailable, "truncated": false}));
        }
        let store = WorkspaceStore::new(&self.gateway, CLIENT);
        let mut papers = Vec::new();
        for node in store.nodes_metadata(project_id)? {
            if node.kind == "chapter" {
                papers.push(Paper {
                    kind: "chapter",
                    id: node.id.clone(),
                    title: node.title.clone(),
                    fields: vec![("summary", node.summary.clone())],
                    body: None,
                });
            }
        }
        for drift in store.drifts(project_id)? {
            papers.push(Paper {
                kind: "drift",
                id: drift.id.clone(),
                title: drift.title.clone(),
                fields: vec![("title", drift.title), ("summary", drift.summary)],
                body: Some(drift.document_id),
            });
        }
        for element in store.elements(project_id)? {
            let mut fields = vec![("name", element.name.clone())];
            fields.extend(element.aliases.iter().map(|alias| ("alias", alias.clone())));
            fields.push(("summary", element.summary.clone()));
            fields.extend(
                element
                    .facts
                    .iter()
                    .map(|fact| ("fact", format!("{}：{}", fact.key, fact.value))),
            );
            papers.push(Paper {
                kind: "element",
                id: element.id,
                title: element.name,
                fields,
                body: Some(element.document_id),
            });
        }
        for category in store.element_categories(project_id)? {
            papers.push(Paper {
                kind: "category",
                id: category.id,
                title: category.name.clone(),
                fields: vec![("name", category.name)],
                body: Some(category.document_id),
            });
        }
        for storyline in store.storylines(project_id)? {
            papers.push(Paper {
                kind: "storyline",
                id: storyline.id,
                title: storyline.name.clone(),
                fields: vec![("name", storyline.name), ("summary", storyline.summary)],
                body: Some(storyline.document_id),
            });
        }
        for item in store.library_items(project_id)? {
            papers.push(Paper {
                kind: "library",
                id: item.id,
                title: item.title.clone(),
                fields: vec![
                    ("title", item.title),
                    ("text", item.text),
                    ("notes", item.notes),
                ],
                body: None,
            });
        }
        let revisions: HashMap<String, i64> = self
            .gateway
            .query(
                "SELECT document_id,revision FROM yjs_document_revision".into(),
                vec![],
                None,
                CLIENT.into(),
            )?
            .rows
            .iter()
            .filter_map(|row| match (&row[0], &row[1]) {
                (DatabaseValue::Text(id), DatabaseValue::Integer(revision)) => {
                    revision.parse().ok().map(|revision| (id.clone(), revision))
                }
                _ => None,
            })
            .collect();
        let mut cache = std::mem::take(&mut self.search_texts);
        'papers: for paper in papers {
            for (field, text) in &paper.fields {
                for range in native_search_ranges(text, query, 3) {
                    hits.push(EntityHit {
                        kind: paper.kind.into(),
                        id: paper.id.clone(),
                        title: paper.title.clone(),
                        field: (*field).into(),
                        preview: native_search_preview(text, &range),
                        scope: None,
                        matched: None,
                    });
                    if hits.len() > ENTITY_HIT_LIMIT {
                        break 'papers;
                    }
                }
            }
            let Some(document_id) = &paper.body else {
                continue;
            };
            let read = (|| -> Result<(), String> {
                let key = (project_id.to_owned(), paper.id.clone());
                let owner = self
                    .body_owner(paper.kind, &key)
                    .and_then(|handle| documents.get(&handle));
                let revision = revisions.get(document_id).copied().unwrap_or(-1);
                if owner.is_none() {
                    if let Some((cached, text)) = cache.get(document_id) {
                        if *cached == revision && native_search_ranges(text, query, 1).is_empty() {
                            return Ok(());
                        }
                    }
                }
                let scope = store.document_scope(project_id, document_id)?;
                let reader;
                let document = match owner {
                    Some(owner) => {
                        if owner.owner.scope != scope || owner.document.remote_block().is_some() {
                            return Err("Body has unresolved changes or changed scope".into());
                        }
                        &owner.document
                    }
                    None => {
                        reader = DurableDocument::open_with_scope(
                            self.gateway.clone(),
                            CLIENT,
                            scope.clone(),
                        )?;
                        if reader.has_pending() {
                            return Err("Body prose dependencies are unresolved".into());
                        }
                        cache.insert(
                            document_id.clone(),
                            (revision, reader.native_projection()?.text),
                        );
                        &reader
                    }
                };
                for hit in document.search_native(query, ENTITY_HIT_LIMIT + 1 - hits.len())? {
                    hits.push(EntityHit {
                        kind: paper.kind.into(),
                        id: paper.id.clone(),
                        title: paper.title.clone(),
                        field: "body".into(),
                        preview: hit.preview,
                        scope: Some(SearchScope::from(&scope)),
                        matched: Some(EntityMatch {
                            start_anchor: STANDARD.encode(hit.matched.start_anchor),
                            end_anchor: STANDARD.encode(hit.matched.end_anchor),
                            matched_text: hit.matched.matched_text,
                        }),
                    });
                }
                Ok(())
            })();
            if read.is_err() {
                unavailable.push(
                    json!({"kind": paper.kind, "id": paper.id, "title": paper.title,
                    "message": "此正文暂不可读取，请恢复后重试"}),
                );
            }
            if hits.len() > ENTITY_HIT_LIMIT {
                break;
            }
        }
        self.search_texts = cache;
        let truncated = hits.len() > ENTITY_HIT_LIMIT;
        hits.truncate(ENTITY_HIT_LIMIT);
        Ok(json!({"hits": hits, "unavailable": unavailable, "truncated": truncated}))
    }

    /// The current range of a body hit in its open owner.
    pub(super) fn resolve_entity_hit(
        &self,
        documents: &HashMap<u64, LabSession>,
        project_id: &str,
        hit: &EntityHit,
    ) -> Result<Value, String> {
        self.project(project_id)?;
        let (Some(expected), Some(matched)) = (&hit.scope, &hit.matched) else {
            return Err("Only body hits resolve to a text range".into());
        };
        let scope = WorkspaceStore::new(&self.gateway, CLIENT)
            .document_scope(project_id, &expected.document_id)?;
        if !expected.matches(&scope) {
            return Err("搜索结果的正文已更改，请重新搜索".into());
        }
        let handle = self
            .body_owner(&hit.kind, &(project_id.to_owned(), hit.id.clone()))
            .ok_or("请先打开搜索结果所在页面")?;
        let owner = documents
            .get(&handle)
            .ok_or("Workspace document owner is missing")?;
        if owner.owner.scope != scope
            || owner.write_blocked()
            || owner.document.has_pending()
            || owner.document.active_drafts() > 0
            || owner.document.active_input_compositions() > 0
        {
            return Err("请先完成或恢复当前编辑，再定位搜索结果".into());
        }
        let range = owner
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
            .ok_or("搜索结果原文已更改，请重新搜索")?;
        Ok(json!({"revision": owner.document.native_projection()?.revision, "range": range}))
    }
}
