//! The materials library (素材库) and element portraits: images and PDFs
//! imported into the app-owned asset store, links and text notes, each an
//! ordered `library_item`; portraits are image assets bound to an element.
//! Rows and bytes follow the asset store's import/commit/delete protocol.
use super::*;
use crate::asset_store::AssetStore;
use std::collections::{HashMap, HashSet};
use std::path::Path;

#[cfg(test)]
mod tests;

/// The largest source file the library accepts.
pub const MAX_ASSET_BYTES: u64 = 200 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceAsset {
    pub id: String,
    pub kind: String,
    pub mime: String,
    pub extension: String,
    pub size_bytes: u64,
    pub width: Option<u64>,
    pub height: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceLibraryItem {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub asset: Option<WorkspaceAsset>,
    pub external_url: Option<String>,
    /// Plain text of a text note's body.
    pub text: String,
    /// Plain text of the author's notes on any item.
    pub notes: String,
    pub order_key: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ElementPortrait {
    pub element_id: String,
    pub asset: WorkspaceAsset,
}

/// A local file to import. The host reads the image size; the stored file's
/// extension always follows the MIME type, so hosts and paths agree.
pub struct NewAssetFile<'a> {
    pub asset_id: String,
    pub mime: String,
    pub extension: String,
    pub width: Option<u64>,
    pub height: Option<u64>,
    pub source: &'a Path,
}

/// Library body text as the `{type:"doc"}` JSON the schema requires: one
/// paragraph per line.
fn doc_json(text: &str) -> String {
    let paragraphs: Vec<Value> = text
        .split('\n')
        .map(|line| {
            if line.is_empty() {
                json!({"type":"paragraph"})
            } else {
                json!({"type":"paragraph","content":[{"type":"text","text":line}]})
            }
        })
        .collect();
    json!({"type":"doc","content":paragraphs}).to_string()
}

fn doc_text(json: Option<&str>) -> String {
    fn visit(node: &Value, out: &mut String) {
        if let Some(text) = node.get("text").and_then(Value::as_str) {
            out.push_str(text);
        }
        if let Some(children) = node.get("content").and_then(Value::as_array) {
            for child in children {
                visit(child, out);
            }
        }
    }
    let Some(document) = json.and_then(|json| serde_json::from_str::<Value>(json).ok()) else {
        return String::new();
    };
    document
        .get("content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .map(|block| {
                    let mut line = String::new();
                    visit(block, &mut line);
                    line
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn asset_kind(file: &NewAssetFile<'_>) -> Result<&'static str, String> {
    match (file.mime.as_str(), file.width, file.height) {
        ("application/pdf", None, None) => Ok("pdf"),
        (mime, Some(w), Some(h)) if mime.starts_with("image/") && w > 0 && h > 0 => Ok("image"),
        _ => Err("只能导入图片或 PDF".into()),
    }
}

const ITEM_COLUMNS: &str = "i.id,i.title,i.kind,i.external_url,i.body_json,i.notes_json,i.order_key,i.created_at,i.updated_at,\
    a.id,a.kind,a.source_mime,a.source_size_bytes,a.width,a.height";

fn optional_u64(value: &V) -> Option<u64> {
    match value {
        V::Integer(value) => value.parse().ok(),
        V::Real(value) => Some(*value as u64),
        _ => None,
    }
}

fn optional_string(value: &V) -> Option<String> {
    match value {
        V::Text(value) => Some(value.clone()),
        _ => None,
    }
}

fn extension_for(mime: &str) -> String {
    match mime {
        "application/pdf" => "pdf".into(),
        "image/jpeg" => "jpg".into(),
        "image/svg+xml" => "svg".into(),
        mime => mime
            .strip_prefix("image/")
            .filter(|ext| {
                !ext.is_empty() && ext.len() <= 8 && ext.bytes().all(|b| b.is_ascii_alphanumeric())
            })
            .unwrap_or("bin")
            .into(),
    }
}

fn asset_from_row(row: &[V], at: usize) -> Result<Option<WorkspaceAsset>, String> {
    if row[at] == V::Null {
        return Ok(None);
    }
    let mime = string(row, at + 2)?;
    Ok(Some(WorkspaceAsset {
        id: string(row, at)?,
        kind: string(row, at + 1)?,
        extension: extension_for(&mime),
        mime,
        size_bytes: optional_u64(&row[at + 3]).unwrap_or(0),
        width: optional_u64(&row[at + 4]),
        height: optional_u64(&row[at + 5]),
    }))
}

impl WorkspaceStore<'_> {
    pub fn library_items(&self, project_id: &str) -> Result<Vec<WorkspaceLibraryItem>, String> {
        self.library_rows(None, project_id, None)
    }

    pub fn element_portraits(&self, project_id: &str) -> Result<Vec<ElementPortrait>, String> {
        self.query(None, r#"
            SELECT e.id,a.id,a.kind,a.source_mime,a.source_size_bytes,a.width,a.height
            FROM element e JOIN project_asset a ON a.id=e.portrait_asset_id AND a.project_id=e.project_id
            WHERE e.project_id=? ORDER BY e.id
        "#, vec![text(project_id)])?
        .iter()
        .map(|row| {
            Ok(ElementPortrait {
                element_id: string(row, 0)?,
                asset: asset_from_row(row, 1)?.ok_or("Portrait asset missing")?,
            })
        })
        .collect()
    }

    /// Every asset a committed row retains, for the store's collection.
    pub fn retained_assets(&self) -> Result<HashSet<(String, String)>, String> {
        self.query(None, "SELECT project_id,id FROM project_asset", vec![])?
            .iter()
            .map(|row| Ok((string(row, 0)?, string(row, 1)?)))
            .collect()
    }

    pub fn import_library_file(
        &self,
        context: &AuthoredProseContext,
        store: &AssetStore,
        item_id: &str,
        title: &str,
        file: NewAssetFile<'_>,
    ) -> Result<WorkspaceLibraryItem, String> {
        validate_context(context)?;
        let kind = asset_kind(&file)?;
        if !opaque(item_id) || !opaque(&file.asset_id) {
            return Err("Invalid library identity".into());
        }
        let imported = store.import(
            &context.project_id,
            &file.asset_id,
            &extension_for(&file.mime),
            file.source,
            MAX_ASSET_BYTES,
        )?;
        let result = self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            self.insert_asset(
                tx,
                context,
                &file,
                kind,
                imported.size_bytes,
                &imported.sha256,
            )?;
            self.insert_item(
                tx,
                context,
                item_id,
                title,
                kind,
                Some(&file.asset_id),
                None,
                None,
            )
        });
        match result {
            Ok(item) => {
                store.commit(&context.project_id, &file.asset_id)?;
                Ok(item)
            }
            Err(error) => {
                let _ = store.remove(&context.project_id, &file.asset_id);
                Err(error)
            }
        }
    }

    pub fn create_library_link(
        &self,
        context: &AuthoredProseContext,
        item_id: &str,
        title: &str,
        url: &str,
    ) -> Result<WorkspaceLibraryItem, String> {
        validate_context(context)?;
        let url = js_trim(url);
        if !(url.starts_with("https://") || url.starts_with("http://")) || url.len() > 4096 {
            return Err("链接必须以 http:// 或 https:// 开头".into());
        }
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            self.insert_item(tx, context, item_id, title, "url", None, Some(url), None)
        })
    }

    pub fn create_library_text(
        &self,
        context: &AuthoredProseContext,
        item_id: &str,
        title: &str,
        body: &str,
    ) -> Result<WorkspaceLibraryItem, String> {
        validate_context(context)?;
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            self.insert_item(
                tx,
                context,
                item_id,
                title,
                "text",
                None,
                None,
                Some(&doc_json(body)),
            )
        })
    }

    /// Title, notes and (for text notes) body; unchanged fields write nothing.
    pub fn update_library_item(
        &self,
        context: &AuthoredProseContext,
        item_id: &str,
        title: Option<&str>,
        notes: Option<&str>,
        body: Option<&str>,
    ) -> Result<WorkspaceLibraryItem, String> {
        validate_context(context)?;
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let current = self.library_item(tx, context, item_id)?;
            let incarnation = self.library_incarnation(tx, context, item_id)?;
            let mut changes: Vec<(&str, &str, Value)> = Vec::new();
            if let Some(title) = title.map(js_trim) {
                if title != current.title {
                    changes.push(("title", "title", json!(title)));
                }
            }
            if let Some(notes) = notes {
                if notes != current.notes {
                    let value = if notes.is_empty() { Value::Null } else { json!(doc_json(notes)) };
                    changes.push(("notes_json", "notesJson", value));
                }
            }
            if let Some(body) = body {
                if current.kind != "text" {
                    return Err("只有文字素材有正文".into());
                }
                if body != current.text {
                    changes.push(("body_json", "bodyJson", json!(doc_json(body))));
                }
            }
            if changes.is_empty() {
                return Ok(current);
            }
            let mut mutations = Vec::new();
            for (column, field, value) in &changes {
                let sql_value = match value {
                    Value::Null => V::Null,
                    Value::String(value) => text(value),
                    _ => unreachable!(),
                };
                self.execute(tx, &format!("UPDATE library_item SET {column}=?,updated_at=? WHERE id=? AND project_id=?"),
                    vec![sql_value, text(&context.now_iso), text(item_id), text(&context.project_id)])?;
                mutations.push(journal::Mutation::field("library-item", item_id, incarnation, field, value.clone()));
            }
            self.commit_changes(tx, context, &mutations, None)?;
            self.library_item(tx, context, item_id)
        })
    }

    /// Moves an item before `before` (or to the end) in the library's
    /// authored order and renumbers the `order_key` projection by rank. An
    /// unchanged order writes nothing. Returns the library in its new order.
    pub fn move_library_item(
        &self,
        context: &AuthoredProseContext,
        item_id: &str,
        before: Option<&str>,
    ) -> Result<Vec<WorkspaceLibraryItem>, String> {
        validate_context(context)?;
        if before == Some(item_id) {
            return Err("素材不能移到自己前面".into());
        }
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let current = self.library_rows(Some(tx), &context.project_id, None)?;
            let ids: Vec<String> = current.iter().map(|item| item.id.clone()).collect();
            if !ids.iter().any(|id| id == item_id) {
                return Err("素材不存在".into());
            }
            let mut desired: Vec<String> = ids.iter().filter(|id| *id != item_id).cloned().collect();
            let at = match before {
                Some(before) => desired
                    .iter()
                    .position(|id| id == before)
                    .ok_or("目标位置的素材不存在")?,
                None => desired.len(),
            };
            desired.insert(at, item_id.to_string());
            if desired == ids {
                return Ok(current);
            }
            let mut incarnations = HashMap::new();
            for id in &desired {
                incarnations.insert(id.clone(), self.library_incarnation(tx, context, id)?);
            }
            let mut positions = HashMap::new();
            for row in self.query(Some(tx), "SELECT entity_id,incarnation,position_key FROM sync_order_register WHERE sync_generation_id=? AND list_kind='library-item' AND owner_id=?",
                vec![text(&context.sync_generation_id), text(&context.project_id)])? {
                let id = string(&row, 0)?;
                if incarnations.get(&id).is_some_and(|incarnation| optional_u64(&row[1]) == Some(*incarnation)) {
                    positions.insert(id, string(&row, 2)?);
                }
            }
            let mut mutations = Vec::new();
            super::facts::push_order("library-item", &context.project_id, &positions, &desired,
                &|id| incarnations.get(id).copied().unwrap_or(0), &mut mutations)?;
            for (rank, id) in desired.iter().enumerate() {
                self.execute(tx, "UPDATE library_item SET order_key=? WHERE id=? AND project_id=? AND order_key IS NOT ?",
                    vec![V::Integer(rank.to_string()), text(id), text(&context.project_id), V::Integer(rank.to_string())])?;
            }
            self.execute(tx, "UPDATE library_item SET updated_at=? WHERE id=? AND project_id=?",
                vec![text(&context.now_iso), text(item_id), text(&context.project_id)])?;
            self.commit_changes(tx, context, &mutations, None)?;
            self.library_rows(Some(tx), &context.project_id, None)
        })
    }

    /// Removes the item, its relations and its asset row in one transaction,
    /// then the asset's bytes.
    pub fn delete_library_item(
        &self,
        context: &AuthoredProseContext,
        store: &AssetStore,
        item_id: &str,
    ) -> Result<(), String> {
        validate_context(context)?;
        let asset = self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let item = self.library_item(tx, context, item_id)?;
            let incarnation = self.library_incarnation(tx, context, item_id)?;
            let mut mutations = self.purge_relations(tx, context, "library_item", item_id)?;
            self.execute(
                tx,
                "DELETE FROM library_item WHERE id=? AND project_id=?",
                vec![text(item_id), text(&context.project_id)],
            )?;
            if let Some(asset) = &item.asset {
                self.execute(
                    tx,
                    "DELETE FROM project_asset WHERE id=? AND project_id=?",
                    vec![text(&asset.id), text(&context.project_id)],
                )?;
            }
            mutations.push(
                journal::Mutation::json(
                    "entity",
                    "library-item",
                    item_id,
                    "entity.purge",
                    json!({}),
                )
                .at_incarnation(incarnation),
            );
            self.commit_changes(tx, context, &mutations, None)?;
            Ok(item.asset)
        })?;
        if let Some(asset) = asset {
            // A failure here leaves unreferenced bytes for the collection.
            let _ = store.remove(&context.project_id, &asset.id);
        }
        Ok(())
    }

    /// Imports an image and binds it as the element's portrait; the previous
    /// portrait's row and bytes are released.
    pub fn set_element_portrait(
        &self,
        context: &AuthoredProseContext,
        store: &AssetStore,
        element_id: &str,
        file: Option<NewAssetFile<'_>>,
    ) -> Result<Option<ElementPortrait>, String> {
        validate_context(context)?;
        let imported = match &file {
            Some(file) => {
                if asset_kind(file)? != "image" || !opaque(&file.asset_id) {
                    return Err("肖像必须是图片".into());
                }
                Some(store.import(
                    &context.project_id,
                    &file.asset_id,
                    &extension_for(&file.mime),
                    file.source,
                    MAX_ASSET_BYTES,
                )?)
            }
            None => None,
        };
        let result = self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let rows = self.query(
                Some(tx),
                r#"
                SELECT e.portrait_asset_id,l.incarnation FROM element e
                JOIN sync_entity_lifecycle l ON l.sync_generation_id=? AND l.entity_kind='element'
                    AND l.entity_id=e.id AND l.state='live'
                WHERE e.id=? AND e.project_id=? AND e.deleted_at IS NULL
            "#,
                vec![
                    text(&context.sync_generation_id),
                    text(element_id),
                    text(&context.project_id),
                ],
            )?;
            let row = rows.first().ok_or("设定不存在或已在回收站")?;
            let previous = optional_string(&row[0]);
            let incarnation = optional_u64(&row[1]).ok_or("Invalid element incarnation")?;
            if file.is_none() && previous.is_none() {
                return Ok(None);
            }
            let next = match (&file, &imported) {
                (Some(file), Some(imported)) => {
                    self.insert_asset(
                        tx,
                        context,
                        file,
                        "image",
                        imported.size_bytes,
                        &imported.sha256,
                    )?;
                    Some(file.asset_id.clone())
                }
                _ => None,
            };
            self.execute(
                tx,
                "UPDATE element SET portrait_asset_id=?,updated_at=? WHERE id=? AND project_id=?",
                vec![
                    next.as_deref().map(text).unwrap_or(V::Null),
                    text(&context.now_iso),
                    text(element_id),
                    text(&context.project_id),
                ],
            )?;
            if let Some(previous) = &previous {
                self.execute(
                    tx,
                    "DELETE FROM project_asset WHERE id=? AND project_id=?",
                    vec![text(previous), text(&context.project_id)],
                )?;
            }
            self.commit_changes(
                tx,
                context,
                &[journal::Mutation::field(
                    "element",
                    element_id,
                    incarnation,
                    "portraitAssetId",
                    json!(next),
                )],
                None,
            )?;
            Ok(Some(previous))
        });
        match result {
            Ok(released) => {
                if let Some(file) = &file {
                    store.commit(&context.project_id, &file.asset_id)?;
                }
                if let Some(Some(previous)) = released {
                    let _ = store.remove(&context.project_id, &previous);
                }
                Ok(self
                    .element_portraits(&context.project_id)?
                    .into_iter()
                    .find(|p| p.element_id == element_id))
            }
            Err(error) => {
                if let Some(file) = &file {
                    let _ = store.remove(&context.project_id, &file.asset_id);
                }
                Err(error)
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_item(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        item_id: &str,
        title: &str,
        kind: &str,
        asset_id: Option<&str>,
        url: Option<&str>,
        body_json: Option<&str>,
    ) -> Result<WorkspaceLibraryItem, String> {
        if !opaque(item_id) {
            return Err("Invalid library identity".into());
        }
        let title = js_trim(title);
        let order = self.query(
            Some(tx),
            "SELECT COALESCE(MAX(order_key),0)+1 FROM library_item WHERE project_id=?",
            vec![text(&context.project_id)],
        )?;
        let order_key = optional_u64(&order[0][0]).unwrap_or(1);
        self.execute(tx, r#"
            INSERT INTO library_item(id,project_id,title,kind,asset_id,external_url,body_json,notes_json,
                preview_image_url,order_key,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,NULL,NULL,?,?,?)
        "#, vec![text(item_id), text(&context.project_id), text(title), text(kind),
            asset_id.map(text).unwrap_or(V::Null), url.map(text).unwrap_or(V::Null),
            body_json.map(text).unwrap_or(V::Null), V::Integer(order_key.to_string()),
            text(&context.now_iso), text(&context.now_iso)])?;
        self.commit_changes(tx, context, &[journal::Mutation::create("library-item", item_id, json!({
            "title": title, "kind": kind, "assetId": asset_id, "externalUrl": url, "bodyJson": body_json,
            "notesJson": null, "orderKey": order_key,
        }))], None)?;
        self.library_item(tx, context, item_id)
    }

    fn insert_asset(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        file: &NewAssetFile<'_>,
        kind: &str,
        size: u64,
        sha256: &str,
    ) -> Result<(), String> {
        self.execute(tx, r#"
            INSERT INTO project_asset(id,project_id,kind,source_mime,source_size_bytes,source_sha256,width,height,created_at)
            VALUES (?,?,?,?,?,?,?,?,?)
        "#, vec![text(&file.asset_id), text(&context.project_id), text(kind), text(&file.mime),
            V::Integer(size.to_string()), text(sha256),
            file.width.map(|w| V::Integer(w.to_string())).unwrap_or(V::Null),
            file.height.map(|h| V::Integer(h.to_string())).unwrap_or(V::Null), text(&context.now_iso)])?;
        Ok(())
    }

    fn library_item(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        item_id: &str,
    ) -> Result<WorkspaceLibraryItem, String> {
        self.library_rows(Some(tx), &context.project_id, Some(item_id))?
            .pop()
            .ok_or_else(|| "素材不存在".into())
    }

    fn library_incarnation(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        item_id: &str,
    ) -> Result<u64, String> {
        let rows = self.query(Some(tx), "SELECT incarnation FROM sync_entity_lifecycle WHERE sync_generation_id=? AND entity_kind='library-item' AND entity_id=? AND state='live'",
            vec![text(&context.sync_generation_id), text(item_id)])?;
        rows.first()
            .and_then(|row| optional_u64(&row[0]))
            .ok_or_else(|| "素材不存在".into())
    }

    fn library_rows(
        &self,
        tx: Option<u64>,
        project_id: &str,
        id: Option<&str>,
    ) -> Result<Vec<WorkspaceLibraryItem>, String> {
        let mut values = vec![text(project_id)];
        if let Some(id) = id {
            values.push(text(id));
        }
        self.query(tx, &format!(r#"
            SELECT {ITEM_COLUMNS} FROM library_item i LEFT JOIN project_asset a ON a.id=i.asset_id AND a.project_id=i.project_id
            WHERE i.project_id=?{} ORDER BY i.order_key,i.created_at,i.id
        "#, if id.is_some() { " AND i.id=?" } else { "" }), values)?
        .iter()
        .map(|row| {
            Ok(WorkspaceLibraryItem {
                id: string(row, 0)?,
                title: string(row, 1)?,
                kind: string(row, 2)?,
                external_url: optional_string(&row[3]),
                text: doc_text(optional_string(&row[4]).as_deref()),
                notes: doc_text(optional_string(&row[5]).as_deref()),
                order_key: optional_u64(&row[6]).unwrap_or(0) as i64,
                created_at: string(row, 7)?,
                updated_at: string(row, 8)?,
                asset: asset_from_row(row, 9)?,
            })
        })
        .collect()
    }
}
