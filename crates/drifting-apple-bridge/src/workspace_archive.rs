//! Relational Markdown export (关系型 Markdown): one file per chapter, drift,
//! element, category, storyline, note and material of a project, with YAML
//! front matter, bodies read from live Yjs (open owners or durable reads),
//! entity links as `[[path|text]]` wiki links, and a 关系 section of
//! forward and reverse references. For reading and migration; it cannot be
//! imported back. The host writes the files into a folder it chooses.
use super::*;
use std::collections::{BTreeMap, HashMap};

struct Document {
    kind: &'static str,
    id: String,
    title: String,
    path: String,
    metadata: Vec<(&'static str, String)>,
    body: String,
    /// The Yjs body to render after every path is known.
    prose: Option<(&'static str, String)>,
}

/// Portable file name segment, as the renderer's `safeSegment`.
fn safe_segment(value: &str) -> String {
    let mut cleaned = String::new();
    let mut previous_dot = false;
    for c in value.chars() {
        let c = if matches!(
            c,
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '#' | '[' | ']'
        ) {
            '-'
        } else if c.is_whitespace() {
            ' '
        } else {
            c
        };
        if c == '.' && previous_dot {
            cleaned.pop();
            cleaned.push('-');
            continue;
        }
        previous_dot = c == '.';
        if c == ' ' && cleaned.ends_with(' ') {
            continue;
        }
        cleaned.push(c);
    }
    let trimmed = cleaned.trim().trim_end_matches(['.', ' ']).to_string();
    let result = if trimmed.is_empty() {
        "Untitled".to_string()
    } else {
        trimmed
    };
    result.chars().take(80).collect()
}

fn yaml(value: &str) -> String {
    json!(value).to_string()
}

fn doc_text(json: &str) -> String {
    fn collect(node: &Value, out: &mut String) {
        if let Some(text) = node.get("text").and_then(Value::as_str) {
            out.push_str(text);
        }
        for child in node
            .get("content")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            collect(child, out);
        }
    }
    let Ok(doc) = serde_json::from_str::<Value>(json) else {
        return String::new();
    };
    doc.get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|block| {
            let mut text = String::new();
            collect(block, &mut text);
            text
        })
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn stem(path: &str) -> &str {
    path.strip_suffix(".md").unwrap_or(path)
}

impl WorkspaceSession {
    fn body_json(
        &self,
        documents: &HashMap<u64, LabSession>,
        project_id: &str,
        kind: &str,
        id: &str,
        document_id: &str,
    ) -> Result<String, String> {
        let key = (project_id.to_owned(), id.to_owned());
        let owner = match kind {
            "chapter" => self.documents.get(&key),
            _ => None,
        }
        .copied()
        .or_else(|| self.body_owner(kind, &key));
        if let Some(owner) = owner.and_then(|handle| documents.get(&handle)) {
            return Ok(owner.document.prose_projection()?.content_json);
        }
        let repository = ProseRepository::new(&self.gateway, CLIENT);
        let tx = self
            .gateway
            .begin(TransactionBehavior::Deferred, CLIENT.into())?;
        let loaded = drifting_prose::load_document(&repository, document_id, tx)
            .and_then(|(document, _)| document.prose_projection());
        let _ = self.gateway.rollback(tx, CLIENT.into());
        Ok(loaded?.content_json)
    }

    pub(super) fn export_archive(
        &self,
        documents: &HashMap<u64, LabSession>,
        project_id: &str,
    ) -> Result<Value, String> {
        let store = WorkspaceStore::new(&self.gateway, CLIENT);
        let details = store.project_details(project_id)?;
        let mut docs: Vec<Document> = Vec::new();
        let mut keys: HashMap<(String, String), usize> = HashMap::new();
        let mut add = |docs: &mut Vec<Document>, doc: Document| {
            keys.insert((doc.kind.to_string(), doc.id.clone()), docs.len());
            docs.push(doc);
        };
        let nodes: HashMap<String, drifting_core::workspace::WorkspaceNodeMetadata> = store
            .nodes_metadata(project_id)?
            .into_iter()
            .map(|node| (node.id.clone(), node))
            .collect();
        let chapters = store.list_chapters(project_id)?;
        for (index, chapter) in chapters.iter().enumerate() {
            let node = nodes.get(&chapter.id);
            add(
                &mut docs,
                Document {
                    kind: "node",
                    id: chapter.id.clone(),
                    title: chapter.title.clone(),
                    path: format!(
                        "book/chapters/{:03}-{}-{}.md",
                        index + 1,
                        safe_segment(&chapter.title),
                        safe_segment(&chapter.id)
                    ),
                    metadata: vec![
                        ("node_kind", "chapter".into()),
                        ("writing_status", chapter.writing_status.clone()),
                        ("updated_at", chapter.updated_at.clone()),
                    ],
                    body: node.map(|node| node.summary.clone()).unwrap_or_default(),
                    prose: Some(("chapter", chapter.document_id.clone())),
                },
            );
        }
        for drift in store.drifts(project_id)? {
            add(
                &mut docs,
                Document {
                    kind: "node",
                    id: drift.id.clone(),
                    title: drift.title.clone(),
                    path: format!(
                        "book/drifts/{}-{}.md",
                        safe_segment(&drift.title),
                        safe_segment(&drift.id)
                    ),
                    metadata: vec![
                        ("node_kind", "drift".into()),
                        ("updated_at", drift.updated_at.clone()),
                    ],
                    body: drift.summary.clone(),
                    prose: Some(("drift", drift.document_id.clone())),
                },
            );
        }
        let elements = store.elements(project_id)?;
        for element in &elements {
            let mut body = element.summary.clone();
            if !element.facts.is_empty() {
                let facts: Vec<String> = element
                    .facts
                    .iter()
                    .map(|fact| format!("- {}：{}", fact.key, fact.value))
                    .collect();
                body = [body, format!("## 设定项\n\n{}", facts.join("\n"))]
                    .into_iter()
                    .filter(|part| !part.is_empty())
                    .collect::<Vec<_>>()
                    .join("\n\n");
            }
            add(
                &mut docs,
                Document {
                    kind: "element",
                    id: element.id.clone(),
                    title: element.name.clone(),
                    path: format!(
                        "elements/{}-{}.md",
                        safe_segment(&element.name),
                        safe_segment(&element.id)
                    ),
                    metadata: vec![
                        ("aliases", element.aliases.join(", ")),
                        ("group", element.group_name.clone().unwrap_or_default()),
                        ("updated_at", element.updated_at.clone()),
                    ],
                    body,
                    prose: Some(("element", element.document_id.clone())),
                },
            );
        }
        for category in store.element_categories(project_id)? {
            add(
                &mut docs,
                Document {
                    kind: "category",
                    id: category.id.clone(),
                    title: category.name.clone(),
                    path: format!(
                        "elements/categories/{}-{}.md",
                        safe_segment(&category.name),
                        safe_segment(&category.id)
                    ),
                    metadata: vec![
                        ("color", category.color.clone()),
                        ("updated_at", category.updated_at.clone()),
                    ],
                    body: String::new(),
                    prose: Some(("category", category.document_id.clone())),
                },
            );
        }
        for storyline in store.storylines(project_id)? {
            let facts: Vec<String> = storyline
                .facts
                .iter()
                .map(|fact| format!("- {}：{}", fact.key, fact.value))
                .collect();
            let body = [
                storyline.summary.clone(),
                if facts.is_empty() {
                    String::new()
                } else {
                    format!("## 设定项\n\n{}", facts.join("\n"))
                },
            ]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");
            add(
                &mut docs,
                Document {
                    kind: "storyline",
                    id: storyline.id.clone(),
                    title: storyline.name.clone(),
                    path: format!(
                        "storylines/{}-{}.md",
                        safe_segment(&storyline.name),
                        safe_segment(&storyline.id)
                    ),
                    metadata: vec![
                        ("color", storyline.color.clone()),
                        ("updated_at", storyline.updated_at.clone()),
                    ],
                    body,
                    prose: Some(("storyline", storyline.document_id.clone())),
                },
            );
        }
        let comments = store.project_comments(project_id)?;
        for comment in &comments {
            add(
                &mut docs,
                Document {
                    kind: "comment",
                    id: comment.id.clone(),
                    title: format!(
                        "{}：{}",
                        if comment.kind == "todo" {
                            "待办"
                        } else {
                            "批注"
                        },
                        doc_text(&comment.body_json)
                            .split_whitespace()
                            .collect::<Vec<_>>()
                            .join(" ")
                            .chars()
                            .take(24)
                            .collect::<String>()
                    ),
                    path: format!(
                        "notes/comments/{}-{}.md",
                        comment.kind,
                        safe_segment(&comment.id)
                    ),
                    metadata: vec![
                        ("note_kind", comment.kind.clone()),
                        ("status", comment.status.clone()),
                        ("priority", comment.priority.clone().unwrap_or_default()),
                        ("updated_at", comment.updated_at.clone()),
                    ],
                    body: doc_text(&comment.body_json),
                    prose: None,
                },
            );
        }
        for item in store.library_items(project_id)? {
            let mut metadata = vec![
                ("item_kind", item.kind.clone()),
                ("updated_at", item.updated_at.clone()),
            ];
            if let Some(url) = &item.external_url {
                metadata.push(("external_url", url.clone()));
            }
            add(
                &mut docs,
                Document {
                    kind: "library_item",
                    id: item.id.clone(),
                    title: item.title.clone(),
                    path: format!(
                        "notes/library/{}-{}.md",
                        safe_segment(&item.title),
                        safe_segment(&item.id)
                    ),
                    metadata,
                    body: [item.text.clone(), item.notes.clone()]
                        .into_iter()
                        .filter(|part| !part.is_empty())
                        .collect::<Vec<_>>()
                        .join("\n\n"),
                    prose: None,
                },
            );
        }
        let path_of = |kind: &str, id: &str| -> Option<String> {
            let kind = match kind {
                "chapter" | "drift" => "node",
                other => other,
            };
            keys.get(&(kind.to_string(), id.to_string()))
                .map(|index| stem(&docs[*index].path).to_string())
        };
        // Bodies after every path is known, so links resolve.
        let mut bodies = Vec::with_capacity(docs.len());
        for doc in &docs {
            let Some((kind, document_id)) = &doc.prose else {
                bodies.push(None);
                continue;
            };
            let json = self.body_json(documents, project_id, kind, &doc.id, document_id)?;
            let value: Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
            let resolve = |kind: &str, id: &str| path_of(kind, id);
            bodies.push(Some(drifting_document::prose_markdown_linked(
                &value,
                1,
                Some(&resolve),
            )));
        }
        // Relations, forward and reverse.
        let mut relations: BTreeMap<(String, String), Vec<(String, String, String)>> =
            BTreeMap::new();
        let mut relate = |from: (&str, &str), to: (&str, &str), label: String| {
            let (from_kind, to_kind) = [from.0, to.0]
                .map(|kind| match kind {
                    "chapter" | "drift" => "node".to_string(),
                    "library" => "library_item".to_string(),
                    other => other.to_string(),
                })
                .into();
            let bucket = relations
                .entry((from_kind, from.1.to_string()))
                .or_default();
            let entry = (to_kind, to.1.to_string(), label);
            if !bucket.contains(&entry) {
                bucket.push(entry);
            }
        };
        let types: HashMap<String, drifting_core::workspace::WorkspaceRelationType> = store
            .relation_types(project_id)?
            .into_iter()
            .map(|kind| (kind.id.clone(), kind))
            .collect();
        for relation in store.relations(project_id)? {
            let label = match types.get(&relation.relation_type_id) {
                Some(kind) if kind.system_key.as_deref() == Some("generic-association") => {
                    "关联".to_string()
                }
                Some(kind) => kind.name.clone(),
                None => continue,
            };
            relate(
                (&relation.from_kind, &relation.from_id),
                (&relation.to_kind, &relation.to_id),
                label.clone(),
            );
            relate(
                (&relation.to_kind, &relation.to_id),
                (&relation.from_kind, &relation.from_id),
                format!("反向：{label}"),
            );
        }
        for comment in &comments {
            if let (Some(kind), Some(id)) = (&comment.target_kind, &comment.target_id) {
                relate(("comment", &comment.id), (kind, id), "注释对象".into());
                relate((kind, id), ("comment", &comment.id), "被此注释引用".into());
            }
        }
        for membership in store.chapter_memberships(project_id)? {
            for storyline in &membership.storyline_ids {
                relate(
                    ("storyline", storyline),
                    ("node", &membership.chapter_id),
                    "包含章节".into(),
                );
                relate(
                    ("node", &membership.chapter_id),
                    ("storyline", storyline),
                    "所属故事线".into(),
                );
            }
        }
        for element in &elements {
            if let Some(category) = &element.category_id {
                relate(
                    ("element", &element.id),
                    ("category", category),
                    "所属分类".into(),
                );
                relate(
                    ("category", category),
                    ("element", &element.id),
                    "包含设定".into(),
                );
            }
        }
        let mut files = Vec::new();
        let mut index_links = Vec::new();
        for (position, doc) in docs.iter().enumerate() {
            let mut front = vec![
                format!("drifting_kind: {}", yaml(doc.kind)),
                format!("drifting_id: {}", yaml(&doc.id)),
            ];
            front.extend(
                doc.metadata
                    .iter()
                    .filter(|(_, value)| !value.is_empty())
                    .map(|(name, value)| format!("{name}: {}", yaml(value))),
            );
            let mut sections = vec![
                format!("---\n{}\n---", front.join("\n")),
                format!("# {}", doc.title),
            ];
            let body = [
                doc.body.trim().to_string(),
                bodies[position].clone().unwrap_or_default(),
            ]
            .into_iter()
            .filter(|part| !part.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");
            if !body.is_empty() {
                sections.push(body);
            }
            if doc.kind == "element" {
                let patches = store.element_patches(project_id, &doc.id)?;
                if !patches.is_empty() {
                    let lines: Vec<String> = patches
                        .iter()
                        .map(|patch| {
                            let title = patch.title.clone().unwrap_or_else(|| "补丁".into());
                            let source = patch
                                .source_node_id
                                .as_deref()
                                .and_then(|id| path_of("node", id))
                                .map(|path| {
                                    format!(
                                        "（来自 [[{path}|{}]]）",
                                        patch.source_node_title.clone().unwrap_or_default()
                                    )
                                })
                                .unwrap_or_default();
                            let invalid = if patch.invalidated_at.is_some() {
                                "（已失效）"
                            } else {
                                ""
                            };
                            [format!("### {title}{invalid}"), source, patch.body.clone()]
                                .into_iter()
                                .filter(|part| !part.is_empty())
                                .collect::<Vec<_>>()
                                .join("\n\n")
                        })
                        .collect();
                    sections.push(format!("## 补丁\n\n{}", lines.join("\n\n")));
                }
            }
            if let Some(entries) = relations.get(&(doc.kind.to_string(), doc.id.clone())) {
                let lines: Vec<String> = entries
                    .iter()
                    .filter_map(|(kind, id, label)| {
                        keys.get(&(kind.clone(), id.clone())).map(|target| {
                            let target = &docs[*target];
                            format!("- {label}: [[{}|{}]]", stem(&target.path), target.title)
                        })
                    })
                    .collect();
                if !lines.is_empty() {
                    sections.push(format!("## 关系\n\n{}", lines.join("\n")));
                }
            }
            files.push(json!({"path": doc.path, "text": sections.join("\n\n") + "\n"}));
            index_links.push(format!("- [[{}|{}]]", stem(&doc.path), doc.title));
        }
        let mut index = vec![format!("# {}", details.project.name)];
        if !details.project.summary.trim().is_empty() {
            index.push(details.project.summary.clone());
        }
        if details
            .facts
            .iter()
            .any(|fact| !fact.value.trim().is_empty())
        {
            index.push(format!(
                "## 设定项\n\n{}",
                details
                    .facts
                    .iter()
                    .filter(|fact| !fact.value.trim().is_empty())
                    .map(|fact| format!("- {}：{}", fact.key, fact.value))
                    .collect::<Vec<_>>()
                    .join("\n")
            ));
        }
        index.push(format!("## 内容索引\n\n{}", index_links.join("\n")));
        files.push(json!({"path": "index.md", "text": index.join("\n\n") + "\n"}));
        files.push(json!({"path": "README.md", "text": "# Drifting Markdown 导出\n\n这是一个项目的关系型 Markdown 导出，面向阅读与迁移。图片和 PDF 不包含在内，也不能重新导入 Drifting。`[[路径|标题]]` 是实体链接；每个文件末尾的“关系”同时列出正向与反向引用。\n"}));
        Ok(
            json!({"projectName": details.project.name, "documentCount": docs.len(), "files": files}),
        )
    }
}
