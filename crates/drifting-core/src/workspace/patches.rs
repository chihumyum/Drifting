//! Element patches (设定补丁): how an element changes from a point in the
//! story. A patch may come from a chapter selection; its anchored text is
//! kept, and the patch is marked invalid while that text is gone from the
//! chapter (and valid again when it returns). Bodies are plain text stored as
//! a ProseMirror document; there is no Yjs body.
use super::comments::plain_comment_doc;
use super::facts::push_order;
use super::*;
use std::collections::HashMap;

#[cfg(test)]
mod tests;

const COLUMNS: &str = "p.id,p.element_id,p.source_node_id,n.title,p.source_block_id,p.source_block_text,\
    p.text_anchor_json,p.invalidated_at,p.title,p.content_json,p.order_key,p.created_at,p.updated_at";

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePatch {
    pub id: String,
    pub element_id: String,
    pub source_node_id: Option<String>,
    /// The source chapter's title while it is live.
    pub source_node_title: Option<String>,
    pub source_block_id: Option<String>,
    pub source_block_text: Option<String>,
    /// The chapter text the patch was made from.
    pub anchor_text: Option<String>,
    /// Set while the anchored text is missing from the source chapter.
    pub invalidated_at: Option<String>,
    pub title: Option<String>,
    pub body: String,
    pub order_key: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// Where a patch made from a chapter selection comes from.
pub struct PatchSource {
    pub node_id: String,
    pub block_id: Option<String>,
    pub block_text: Option<String>,
    pub anchor_text: Option<String>,
}

pub struct NewPatch {
    pub id: String,
    pub element_id: String,
    pub title: Option<String>,
    pub body: String,
    pub source: Option<PatchSource>,
}

/// Fields to change; absent fields stay, `title: Some(None)` clears it.
#[derive(Default)]
pub struct PatchChanges {
    pub title: Option<Option<String>>,
    pub body: Option<String>,
}

fn normalized(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn anchor_json(text: &str) -> String {
    json!({ "text": text }).to_string()
}

fn anchor_text(json: Option<&str>) -> Option<String> {
    json.and_then(|json| serde_json::from_str::<Value>(json).ok())
        .and_then(|value| value.get("text").and_then(Value::as_str).map(String::from))
        .filter(|text| !text.is_empty())
}

/// Plain text of a patch body: paragraphs joined by blank lines.
fn body_text(content_json: &str) -> String {
    fn collect(node: &Value, out: &mut String) {
        if let Some(text) = node.get("text").and_then(Value::as_str) {
            out.push_str(text);
        }
        if let Some(children) = node.get("content").and_then(Value::as_array) {
            for child in children {
                collect(child, out);
            }
        }
    }
    let Ok(doc) = serde_json::from_str::<Value>(content_json) else {
        return String::new();
    };
    doc.get("content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .map(|block| {
                    let mut text = String::new();
                    collect(block, &mut text);
                    text
                })
                .filter(|text| !text.is_empty())
                .collect::<Vec<_>>()
                .join("\n\n")
        })
        .unwrap_or_default()
}

fn optional(row: &[V], index: usize) -> Option<String> {
    match &row[index] {
        V::Text(value) => Some(value.clone()),
        _ => None,
    }
}

fn patch_from_row(row: &[V]) -> Result<WorkspacePatch, String> {
    Ok(WorkspacePatch {
        id: string(row, 0)?,
        element_id: string(row, 1)?,
        source_node_id: optional(row, 2),
        source_node_title: optional(row, 3),
        source_block_id: optional(row, 4),
        source_block_text: optional(row, 5),
        anchor_text: anchor_text(optional(row, 6).as_deref()),
        invalidated_at: optional(row, 7),
        title: optional(row, 8),
        body: body_text(&string(row, 9)?),
        order_key: match &row[10] {
            V::Integer(value) => value.parse().unwrap_or(0),
            _ => 0,
        },
        created_at: string(row, 11)?,
        updated_at: string(row, 12)?,
    })
}

fn clean_title(title: Option<&str>) -> Option<String> {
    title
        .map(js_trim)
        .filter(|title| !title.is_empty())
        .map(String::from)
}

impl WorkspaceStore<'_> {
    fn patch_rows(
        &self,
        tx: Option<u64>,
        project_id: &str,
        condition: &str,
        value: &str,
    ) -> Result<Vec<WorkspacePatch>, String> {
        self.query(tx, &format!(r#"
            SELECT {COLUMNS} FROM element_patch p
            LEFT JOIN book_node n ON n.id=p.source_node_id AND n.project_id=p.project_id AND n.deleted_at IS NULL
            WHERE p.project_id=? AND {condition}=? ORDER BY p.order_key,p.created_at,p.id
        "#), vec![text(project_id), text(value)])?
        .iter()
        .map(|row| patch_from_row(row))
        .collect()
    }

    /// An element's patches in their authored order.
    pub fn element_patches(
        &self,
        project_id: &str,
        element_id: &str,
    ) -> Result<Vec<WorkspacePatch>, String> {
        self.patch_rows(None, project_id, "p.element_id", element_id)
    }

    /// Patches made from this chapter or drift.
    pub fn node_patches(
        &self,
        project_id: &str,
        node_id: &str,
    ) -> Result<Vec<WorkspacePatch>, String> {
        self.patch_rows(None, project_id, "p.source_node_id", node_id)
    }

    pub fn create_patch(
        &self,
        context: &AuthoredProseContext,
        input: NewPatch,
    ) -> Result<WorkspacePatch, String> {
        validate_context(context)?;
        if !opaque(&input.id) || !opaque(&input.element_id) {
            return Err("Invalid patch or element identity".into());
        }
        let title = clean_title(input.title.as_deref());
        if title.is_none() && js_trim(&input.body).is_empty() {
            return Err("补丁的标题和内容不能都为空".into());
        }
        let content_json = if js_trim(&input.body).is_empty() {
            "{}".to_string()
        } else {
            plain_comment_doc(&input.body)
        };
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            if self.query(Some(tx), "SELECT 1 FROM element WHERE id=? AND project_id=? AND deleted_at IS NULL",
                vec![text(&input.element_id), text(&context.project_id)])?.is_empty() {
                return Err("设定不存在或已在回收站".into());
            }
            if let Some(source) = &input.source {
                if self.query(Some(tx), "SELECT 1 FROM book_node WHERE id=? AND project_id=? AND kind IN ('chapter','drift') AND deleted_at IS NULL",
                    vec![text(&source.node_id), text(&context.project_id)])?.is_empty() {
                    return Err("补丁来源的章节不存在或已在回收站".into());
                }
            }
            let taken = self.query(Some(tx), r#"
                SELECT 1 FROM element_patch WHERE id=?
                UNION ALL SELECT 1 FROM sync_entity_lifecycle
                WHERE sync_generation_id=? AND entity_kind='element-patch' AND entity_id=?
            "#, vec![text(&input.id), text(&context.sync_generation_id), text(&input.id)])?;
            if !taken.is_empty() {
                return Err("Patch identity already exists".into());
            }
            let existing = self.patch_rows(Some(tx), &context.project_id, "p.element_id", &input.element_id)?;
            let order_key = existing.iter().map(|patch| patch.order_key).max().map_or(0, |key| key + 1);
            let source = input.source.as_ref();
            let anchor = source
                .and_then(|source| source.anchor_text.as_deref())
                .filter(|text| !text.is_empty())
                .map(anchor_json);
            self.execute(tx, r#"
                INSERT INTO element_patch(id,project_id,element_id,source_node_id,source_block_id,source_block_text,
                    text_anchor_json,invalidated_at,title,content_json,order_key,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,NULL,?,?,?,?,?)
            "#, vec![text(&input.id), text(&context.project_id), text(&input.element_id),
                source.map(|s| text(&s.node_id)).unwrap_or(V::Null),
                source.and_then(|s| s.block_id.as_deref()).map(text).unwrap_or(V::Null),
                source.and_then(|s| s.block_text.as_deref()).map(text).unwrap_or(V::Null),
                anchor.as_deref().map(text).unwrap_or(V::Null),
                title.as_deref().map(text).unwrap_or(V::Null), text(&content_json),
                V::Integer(order_key.to_string()), text(&context.now_iso), text(&context.now_iso)])?;
            let mut mutations = vec![journal::Mutation::create("element-patch", &input.id, json!({
                "id": input.id, "elementId": input.element_id,
                "sourceNodeId": source.map(|s| s.node_id.clone()),
                "sourceBlockId": source.and_then(|s| s.block_id.clone()),
                "sourceBlockText": source.and_then(|s| s.block_text.clone()),
                "textAnchorJson": anchor, "invalidatedAt": null, "title": title, "contentJson": content_json,
            }))];
            let positions = self.patch_positions(tx, context, &input.element_id)?;
            let mut desired: Vec<String> = existing.iter().map(|patch| patch.id.clone()).collect();
            desired.push(input.id.clone());
            push_order("element-patch", &input.element_id, &positions, &desired,
                &|id| if id == input.id {
                        0
                    } else { self.live_incarnation(tx, context, "element-patch", id).unwrap_or(0) },
                &mut mutations)?;
            self.commit_changes(tx, context, &mutations, None)?;
            Ok(self.patch_rows(Some(tx), &context.project_id, "p.id", &input.id)?.remove(0))
        })
    }

    pub fn update_patch(
        &self,
        context: &AuthoredProseContext,
        patch_id: &str,
        changes: PatchChanges,
    ) -> Result<WorkspacePatch, String> {
        validate_context(context)?;
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let current = self.live_patch(tx, context, patch_id)?;
            let incarnation = self.live_incarnation(tx, context, "element-patch", patch_id)?;
            let title = match &changes.title {
                Some(title) => clean_title(title.as_deref()),
                None => current.title.clone(),
            };
            let body = changes.body.clone().unwrap_or_else(|| current.body.clone());
            if title.is_none() && js_trim(&body).is_empty() {
                return Err("补丁的标题和内容不能都为空".into());
            }
            let mut mutations = Vec::new();
            if changes.body.is_some() && body != current.body {
                let content_json = if js_trim(&body).is_empty() { "{}".to_string() } else { plain_comment_doc(&body) };
                self.execute(tx, "UPDATE element_patch SET content_json=?,updated_at=? WHERE id=? AND project_id=?",
                    vec![text(&content_json), text(&context.now_iso), text(patch_id), text(&context.project_id)])?;
                mutations.push(journal::Mutation::field("element-patch", patch_id, incarnation, "contentJson", json!(content_json)));
            }
            if title != current.title {
                self.execute(tx, "UPDATE element_patch SET title=?,updated_at=? WHERE id=? AND project_id=?",
                    vec![title.as_deref().map(text).unwrap_or(V::Null), text(&context.now_iso), text(patch_id), text(&context.project_id)])?;
                mutations.push(journal::Mutation::field("element-patch", patch_id, incarnation, "title", json!(title)));
            }
            if !mutations.is_empty() {
                self.commit_changes(tx, context, &mutations, None)?;
            }
            self.live_patch(tx, context, patch_id)
        })
    }

    /// Moves a patch before `before` (or last) among its element's patches.
    pub fn move_patch(
        &self,
        context: &AuthoredProseContext,
        patch_id: &str,
        before: Option<&str>,
    ) -> Result<Vec<WorkspacePatch>, String> {
        validate_context(context)?;
        if before == Some(patch_id) {
            return Err("补丁不能移到自己前面".into());
        }
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let patch = self.live_patch(tx, context, patch_id)?;
            let current = self.patch_rows(
                Some(tx),
                &context.project_id,
                "p.element_id",
                &patch.element_id,
            )?;
            let ids: Vec<String> = current.iter().map(|patch| patch.id.clone()).collect();
            let mut desired: Vec<String> =
                ids.iter().filter(|id| *id != patch_id).cloned().collect();
            let at = match before {
                Some(before) => desired
                    .iter()
                    .position(|id| id == before)
                    .ok_or("目标位置的补丁不存在")?,
                None => desired.len(),
            };
            desired.insert(at, patch_id.to_string());
            if desired == ids {
                return Ok(current);
            }
            let mut mutations = Vec::new();
            let positions = self.patch_positions(tx, context, &patch.element_id)?;
            push_order(
                "element-patch",
                &patch.element_id,
                &positions,
                &desired,
                &|id| {
                    self.live_incarnation(tx, context, "element-patch", id)
                        .unwrap_or(0)
                },
                &mut mutations,
            )?;
            for (rank, id) in desired.iter().enumerate() {
                self.execute(
                    tx,
                    "UPDATE element_patch SET order_key=? WHERE id=? AND project_id=?",
                    vec![
                        V::Integer(rank.to_string()),
                        text(id),
                        text(&context.project_id),
                    ],
                )?;
            }
            self.commit_changes(tx, context, &mutations, None)?;
            self.patch_rows(
                Some(tx),
                &context.project_id,
                "p.element_id",
                &patch.element_id,
            )
        })
    }

    /// Deletes the row with its trash original, as the renderer does.
    pub fn delete_patch(
        &self,
        context: &AuthoredProseContext,
        patch_id: &str,
    ) -> Result<(), String> {
        validate_context(context)?;
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            self.live_patch(tx, context, patch_id)?;
            let incarnation = self.live_incarnation(tx, context, "element-patch", patch_id)?;
            let mut mutations = self.purge_relations(tx, context, "patch", patch_id)?;
            self.execute(
                tx,
                "DELETE FROM element_patch WHERE id=? AND project_id=?",
                vec![text(patch_id), text(&context.project_id)],
            )?;
            mutations.push(
                journal::Mutation::json(
                    "entity",
                    "element-patch",
                    patch_id,
                    "entity.trash",
                    json!({}),
                )
                .at_incarnation(incarnation),
            );
            self.commit_changes(tx, context, &mutations, None)
        })
    }

    /// Marks this node's anchored patches invalid while their text (with
    /// whitespace collapsed) is missing from `text`, and valid again when it
    /// returns. Writes only transitions; returns how many changed.
    pub fn recheck_patch_validity(
        &self,
        context: &AuthoredProseContext,
        node_id: &str,
        text_now: &str,
    ) -> Result<usize, String> {
        validate_context(context)?;
        let anchored: Vec<WorkspacePatch> = self
            .node_patches(&context.project_id, node_id)?
            .into_iter()
            .filter(|patch| patch.anchor_text.is_some())
            .collect();
        if anchored.is_empty() {
            return Ok(0);
        }
        let haystack = normalized(text_now);
        let transitions: Vec<(String, Option<String>)> = anchored
            .iter()
            .filter_map(|patch| {
                let present = haystack.contains(&normalized(
                    patch.anchor_text.as_deref().unwrap_or_default(),
                ));
                match (present, patch.invalidated_at.is_some()) {
                    (true, true) => Some((patch.id.clone(), None)),
                    (false, false) => Some((patch.id.clone(), Some(context.now_iso.clone()))),
                    _ => None,
                }
            })
            .collect();
        if transitions.is_empty() {
            return Ok(0);
        }
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let mut mutations = Vec::new();
            for (id, invalidated) in &transitions {
                let incarnation = self.live_incarnation(tx, context, "element-patch", id)?;
                self.execute(tx, "UPDATE element_patch SET invalidated_at=?,updated_at=? WHERE id=? AND project_id=?",
                    vec![invalidated.as_deref().map(text).unwrap_or(V::Null), text(&context.now_iso), text(id), text(&context.project_id)])?;
                mutations.push(journal::Mutation::field("element-patch", id, incarnation, "invalidatedAt", json!(invalidated)));
            }
            self.commit_changes(tx, context, &mutations, None)?;
            Ok(transitions.len())
        })
    }

    fn live_patch(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        patch_id: &str,
    ) -> Result<WorkspacePatch, String> {
        self.patch_rows(Some(tx), &context.project_id, "p.id", patch_id)?
            .pop()
            .ok_or_else(|| "这个补丁不存在".into())
    }

    fn patch_positions(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        element_id: &str,
    ) -> Result<HashMap<String, String>, String> {
        let mut positions = HashMap::new();
        for row in self.query(Some(tx), "SELECT entity_id,position_key FROM sync_order_register WHERE sync_generation_id=? AND list_kind='element-patch' AND owner_id=?",
            vec![text(&context.sync_generation_id), text(element_id)])? {
            positions.insert(string(&row, 0)?, string(&row, 1)?);
        }
        Ok(positions)
    }
}
