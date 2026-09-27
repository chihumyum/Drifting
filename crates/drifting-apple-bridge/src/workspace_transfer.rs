//! Import of external text into a new chapter, drift or element, and export
//! of the whole book as Markdown or plain text. Bodies are filled and read
//! through their document owners like any other prose.
use super::*;
use drifting_core::workspace::{NewDrift, NewElement};
use drifting_document::{NativeFormatAction, NativeFormatting, NativeRange};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImportTarget {
    kind: String,
    title: String,
    #[serde(default)]
    category_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImportBlock {
    kind: String,
    #[serde(default)]
    level: Option<u8>,
    text: String,
    /// Inline bold/italic ranges in the block's UTF-16 text.
    #[serde(default)]
    marks: Vec<ImportMark>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImportMark {
    mark: String,
    location: u32,
    length: u32,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum TransferCommand {
    ImportBlocks {
        target: ImportTarget,
        blocks: Vec<ImportBlock>,
    },
    ExportBook {
        format: String,
    },
}

impl LabSession {
    /// Replaces the empty seed paragraph with the imported blocks, one
    /// paragraph per block, then applies heading levels; saved as the
    /// author's input.
    pub(super) fn import_blocks(&mut self, blocks: &[ImportBlock]) -> Result<(), String> {
        let lines: Vec<String> = blocks
            .iter()
            .map(|block| block.text.replace(['\n', '\r', '\u{2029}'], " "))
            .collect();
        let view = self.document.native_projection()?;
        if !view.text.is_empty() || view.blocks.len() != 1 {
            return Err("Imported bodies must start empty".into());
        }
        self.document.replace_native(NativeReplacement {
            revision: view.revision,
            range: NativeRange {
                location: 0,
                length: 0,
            },
            text: lines.join("\n"),
        })?;
        for (index, block) in blocks.iter().enumerate() {
            let units = block.text.encode_utf16().count() as u32;
            for mark in &block.marks {
                let action = match mark.mark.as_str() {
                    "bold" => NativeFormatAction::Bold,
                    "italic" => NativeFormatAction::Italic,
                    other => return Err(format!("不支持导入 {other} 格式")),
                };
                if mark.length == 0 || mark.location + mark.length > units {
                    return Err("导入的格式范围超出段落".into());
                }
                let view = self.document.native_projection()?;
                let start = view
                    .blocks
                    .get(index)
                    .ok_or("Imported block is missing")?
                    .range
                    .location;
                self.document.format_native(NativeFormatting {
                    revision: view.revision,
                    range: NativeRange {
                        location: start + mark.location,
                        length: mark.length,
                    },
                    action,
                })?;
            }
            let action = match (block.kind.as_str(), block.level) {
                ("heading", Some(1)) => NativeFormatAction::Heading1,
                ("heading", Some(2)) => NativeFormatAction::Heading2,
                ("heading", _) => NativeFormatAction::Heading3,
                _ => continue,
            };
            let view = self.document.native_projection()?;
            let range = view
                .blocks
                .get(index)
                .ok_or("Imported block is missing")?
                .range
                .clone();
            if range.length == 0 {
                continue;
            }
            self.document.format_native(NativeFormatting {
                revision: view.revision,
                range,
                action,
            })?;
        }
        self.persist();
        match &self.save_error {
            Some(error) => Err(format!("导入的正文尚未保存：{error}")),
            None => Ok(()),
        }
    }
}

impl WorkspaceSession {
    pub(super) fn transfer(
        &mut self,
        documents: &mut HashMap<u64, LabSession>,
        project_id: &str,
        command: &TransferCommand,
    ) -> Result<Value, String> {
        let project = self.project(project_id)?;
        let store = WorkspaceStore::new(&self.gateway, CLIENT);
        match command {
            TransferCommand::ImportBlocks { target, blocks } => {
                if blocks.is_empty() || blocks.len() > 20_000 {
                    return Err("导入内容为空或过大".into());
                }
                let context = self.context(&project)?;
                let (entity, document_id, owner_kind, id) = match target.kind.as_str() {
                    "chapter" => {
                        let chapter = store.create_chapter(
                            &context,
                            drifting_core::workspace::CreateChapter {
                                id: identifier("chapter")?,
                                title: target.title.clone(),
                                book_order: None,
                                seed: super::elements::empty_body()?,
                            },
                        )?;
                        let id = chapter.id.clone();
                        (json!(chapter), format!("node-content:{id}"), "node", id)
                    }
                    "drift" => {
                        let drift = store.create_drift(
                            &context,
                            NewDrift {
                                id: identifier("drift")?,
                                title: Some(target.title.clone()),
                                group_id: None,
                                seed: super::elements::empty_body()?,
                            },
                        )?;
                        let id = drift.id.clone();
                        (json!(drift), format!("node-content:{id}"), "node", id)
                    }
                    "element" => {
                        let element = store.create_element(
                            &context,
                            NewElement {
                                id: identifier("element")?,
                                category_id: target
                                    .category_id
                                    .clone()
                                    .ok_or("导入设定需要选择分类")?,
                                name: Some(target.title.clone()),
                                group_name: None,
                                seed: super::elements::empty_body()?,
                            },
                            &mut || identifier("fact"),
                        )?;
                        let id = element.id.clone();
                        (json!(element), format!("element:{id}"), "element", id)
                    }
                    kind => return Err(format!("不能导入为 {kind}")),
                };
                let scope = store.document_scope(project_id, &document_id)?;
                let mut owner = LabSession::open_body(
                    self.directory.clone(),
                    self.gateway.clone(),
                    scope,
                    owner_kind,
                    id,
                    self.installation_id.clone(),
                )?;
                let result = owner.import_blocks(blocks);
                let released = owner.prepare_to_release();
                result?;
                released?;
                Ok(json!({"kind": target.kind, "entity": entity}))
            }
            TransferCommand::ExportBook { format } => {
                let markdown = match format.as_str() {
                    "markdown" => true,
                    "text" => false,
                    other => return Err(format!("不支持的导出格式：{other}")),
                };
                let details = store.project_details(project_id)?;
                let rows = store.outline(project_id)?;
                let has_acts = rows.iter().any(|row| row.kind == "act");
                let mut parts = Vec::new();
                parts.push(if markdown {
                    format!("# {}", details.project.name)
                } else {
                    details.project.name.clone()
                });
                if !details.project.summary.trim().is_empty() {
                    parts.push(details.project.summary.clone());
                }
                let repository = ProseRepository::new(&self.gateway, CLIENT);
                for row in rows {
                    if row.kind == "act" {
                        parts.push(if markdown {
                            format!("## {}", row.title)
                        } else {
                            row.title.clone()
                        });
                        continue;
                    }
                    let depth = if has_acts { 3 } else { 2 };
                    parts.push(if markdown {
                        format!("{} {}", "#".repeat(depth), row.title)
                    } else {
                        row.title.clone()
                    });
                    let key = (project_id.to_owned(), row.id.clone());
                    let projection = match self
                        .documents
                        .get(&key)
                        .and_then(|handle| documents.get(handle))
                    {
                        Some(owner) => owner.document.prose_projection()?,
                        None => {
                            let tx = self
                                .gateway
                                .begin(TransactionBehavior::Deferred, CLIENT.into())?;
                            let loaded = drifting_prose::load_document(
                                &repository,
                                &format!("node-content:{}", row.id),
                                tx,
                            )
                            .and_then(|(document, _)| document.prose_projection());
                            let _ = self.gateway.rollback(tx, CLIENT.into());
                            loaded?
                        }
                    };
                    let document: Value = serde_json::from_str(&projection.content_json)
                        .map_err(|e| e.to_string())?;
                    let body = if markdown {
                        drifting_document::prose_markdown(&document, depth)
                    } else {
                        drifting_document::prose_plain_text(&document)
                    };
                    if !body.is_empty() {
                        parts.push(body);
                    }
                }
                Ok(json!({"text": parts.join("\n\n") + "\n"}))
            }
        }
    }
}
