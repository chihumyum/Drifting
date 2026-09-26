//! UTF-16 projection for native text controls. The view never round-trips XML
//! through attributed strings: only validated operations mutate the CRDT.
use super::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeRange {
    pub location: u32,
    pub length: u32,
}

#[derive(Debug, Serialize)]
pub struct NativeRun {
    pub range: NativeRange,
    pub attributes: Map<String, Value>,
}

#[derive(Debug, Serialize)]
pub struct NativeBlock {
    pub id: Option<String>,
    pub kind: String,
    pub depth: u32,
    pub container: String,
    #[serde(rename = "structuralAttributes")]
    pub structural_attributes: std::collections::BTreeMap<String, String>,
    pub range: NativeRange,
    pub editable: bool,
    pub attributes: Map<String, Value>,
    pub runs: Vec<NativeRun>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeOutlineItem {
    pub block_id: String,
    pub level: u8,
    pub text: String,
    pub parent_id: Option<String>,
    pub range: NativeRange,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeProjection {
    /// A session-local optimistic concurrency token, not a persisted revision.
    pub revision: u64,
    pub text: String,
    pub blocks: Vec<NativeBlock>,
    pub outline: Vec<NativeOutlineItem>,
    pub can_undo: bool,
    pub can_redo: bool,
    pub comments: Vec<CommentAnchorView>,
    pub selections: Vec<NativeSelectionView>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeReplacement {
    pub revision: u64,
    pub range: NativeRange,
    pub text: String,
}

fn attributes<T: ReadTxn>(element: &XmlElementRef, txn: &T) -> Result<Map<String, Value>, String> {
    element
        .attributes(txn)
        .map(|(key, value)| {
            Ok((
                key.into(),
                serde_json::to_value(value.to_json(txn)).map_err(|e| e.to_string())?,
            ))
        })
        .collect()
}

impl DocumentSession {
    pub fn native_projection(&self) -> Result<NativeProjection, String> {
        let txn = self.doc.transact();
        let mut view = NativeProjection {
            revision: self.revision,
            text: String::new(),
            blocks: Vec::new(),
            outline: Vec::new(),
            can_undo: self.undo.can_undo(),
            can_redo: self.undo.can_redo(),
            comments: Vec::new(),
            selections: Vec::new(),
        };
        project_native(&self.root, &txn, 0, &mut view)?;
        // Missing or ambiguous identity is renderable, but never writable.
        let mut counts = HashMap::new();
        for node in self.root.successors(&txn) {
            if let XmlOut::Element(element) = node {
                if let Some(Out::Any(Any::String(id))) = element.get_attribute(&txn, "id") {
                    *counts.entry(id.to_string()).or_insert(0) += 1;
                }
            }
        }
        for block in &mut view.blocks {
            block.editable &= block
                .id
                .as_ref()
                .is_some_and(|id| !id.is_empty() && counts.get(id) == Some(&1));
        }
        // The XML walk collected text while it was already available. Filter
        // ambiguous IDs before nesting, so neither an invalid heading nor a
        // display-only placeholder can become a navigation target or parent.
        view.outline
            .retain(|item| counts.get(&item.block_id) == Some(&1));
        let mut parents: Vec<(u8, String)> = Vec::new();
        for item in &mut view.outline {
            while parents
                .last()
                .is_some_and(|(level, _)| *level >= item.level)
            {
                parents.pop();
            }
            item.parent_id = parents.last().map(|(_, id)| id.clone());
            parents.push((item.level, item.block_id.clone()));
        }
        view.comments = self.comment_views(&view);
        view.selections = self.selection_views(&view);
        Ok(view)
    }

    /// Inline edits and structural replacement of consecutive sibling blocks.
    /// One replacement is one local undo unit, even when it deletes and inserts.
    pub fn replace_native(
        &mut self,
        edit: NativeReplacement,
    ) -> Result<crate::NativeEditMap, String> {
        let command = self
            .authored_capture
            .as_ref()
            .map(crate::native_command::NativeCommandScope::begin)
            .transpose()?;
        let before = self.comments.clone();
        let selections = self.selections.clone();
        let undo_count = self.undo.undo_stack().len();
        let (map, lineage) = self.replace_native_prose_impl(edit, command.as_ref())?;
        self.finish_local_edit(before, selections, undo_count, Some(&map), lineage);
        if let Some(command) = command {
            command.complete();
        }
        Ok(map)
    }

    pub(crate) fn replace_native_prose(
        &mut self,
        edit: NativeReplacement,
    ) -> Result<(crate::NativeEditMap, Option<crate::lineage::Lineage>), String> {
        self.replace_native_prose_impl(edit, None)
    }

    fn replace_native_prose_impl(
        &mut self,
        edit: NativeReplacement,
        command: Option<&crate::native_command::NativeCommandScope>,
    ) -> Result<(crate::NativeEditMap, Option<crate::lineage::Lineage>), String> {
        if edit.revision != self.revision {
            return Err("Document changed; refresh the native selection before editing".into());
        }
        let view = self.native_projection()?;
        validate_range(&view.text, edit.range.location, edit.range.length)?;
        let end = edit.range.location + edit.range.length;
        let first = view
            .blocks
            .iter()
            .position(|block| {
                block.range.location <= edit.range.location
                    && edit.range.location <= block.range.location + block.range.length
            })
            .ok_or("No text block at selection start")?;
        let last = view
            .blocks
            .iter()
            .position(|block| {
                block.range.location <= end && end <= block.range.location + block.range.length
            })
            .ok_or("No text block at selection end")?;
        let block = &view.blocks[first];
        if !block.editable {
            return Err("Unsupported block is preserved read-only".into());
        }
        if first != last
            || (block.kind != "codeBlock" && edit.text.contains(['\n', '\r', '\u{2029}']))
        {
            let (before, after, relocation) = self.replace_structure(&view, &edit, first, last)?;
            let map = crate::NativeEditMap::new(&view, &self.native_projection()?, &edit);
            let lineage = crate::lineage::Lineage {
                before,
                after,
                forward: map.clone(),
                relocation,
            };
            return Ok((map, Some(lineage)));
        }
        let offset = edit.range.location - block.range.location;
        let txn = self.doc.transact();
        let element =
            self.editable_block(&txn, block.id.as_deref().ok_or("Missing block identity")?)?;
        let target = match element.get(&txn, 0) {
            Some(XmlOut::Text(text)) => Some(text),
            None => None,
            _ => return Err("Unsupported text representation".into()),
        };
        // Inherit the left run (first run at offset zero). Non-inclusive entity
        // links only continue in their interior, matching the old extension.
        let marks =
            crate::structure::replacement_marks(block, block, &edit, &element, &element, &txn)?;
        if edit.range.length == 0 && edit.text.is_empty() {
            return Ok((crate::NativeEditMap::new(&view, &view, &edit), None));
        }
        drop(txn);
        {
            let standalone = command.filter(|_| edit.range.length > 0 && edit.text.is_empty());
            let origin =
                standalone.map_or_else(|| yrs::Origin::from(LOCAL), |command| command.origin());
            let _tracked = standalone.map(|_| {
                crate::native_command::TrackedCommandOrigin::new(&mut self.undo, origin.clone())
            });
            let mut txn = self.doc.transact_mut_with(origin);
            let target =
                target.unwrap_or_else(|| element.push_back(&mut txn, XmlTextPrelim::new("")));
            if let Some(command) = standalone {
                command.prepare(&mut txn, &target, offset, edit.range.length);
            }
            if edit.range.length > 0 {
                target.remove_range(&mut txn, offset, edit.range.length);
            }
            if !edit.text.is_empty() {
                target.insert_with_attributes(&mut txn, offset, &edit.text, marks);
            }
        }
        self.undo.reset();
        self.revision += 1;
        Ok((
            crate::NativeEditMap::new(&view, &self.native_projection()?, &edit),
            None,
        ))
    }
}

fn project_native<T: ReadTxn>(
    parent: &impl XmlFragment,
    txn: &T,
    depth: u32,
    view: &mut NativeProjection,
) -> Result<(), String> {
    for child in parent.children(txn) {
        if let XmlOut::Element(element) = &child {
            if matches!(
                element.tag().as_ref(),
                "blockquote" | "bulletList" | "orderedList" | "listItem"
            ) && element.len(txn) > 0
            {
                project_native(element, txn, depth + 1, view)?;
                continue;
            }
        }
        if !view.blocks.is_empty() {
            view.text.push('\n');
        }
        let location = view
            .blocks
            .last()
            .map_or(0, |block| block.range.location + block.range.length + 1);
        let mut block = NativeBlock {
            id: None,
            kind: "unsupported".into(),
            depth,
            container: String::new(),
            structural_attributes: std::collections::BTreeMap::new(),
            range: NativeRange {
                location,
                length: 1,
            },
            editable: false,
            attributes: Map::new(),
            runs: Vec::new(),
        };
        let mut content = "\u{fffc}".to_owned();
        if let XmlOut::Element(element) = child {
            block.container = format!("{:?}", element.parent().map(|parent| parent.id()));
            block.kind = element.tag().to_string();
            block.attributes = attributes(&element, txn)?;
            block.structural_attributes = block
                .attributes
                .iter()
                .filter(|(key, _)| crate::structure::structural_attribute(key))
                .map(|(key, value)| (key.clone(), value.to_string()))
                .collect();
            block.id = block
                .attributes
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_owned);
            if matches!(
                element.tag().as_ref(),
                "paragraph" | "heading" | "codeBlock"
            ) {
                if element.len(txn) == 0 {
                    content.clear();
                    block.editable = true;
                } else if let (1, Some(XmlOut::Text(text))) =
                    (element.len(txn), element.get(txn, 0))
                {
                    if let Ok(plain) = plain_text(&text, txn) {
                        content = plain;
                        block.editable = true;
                        let mut at = location;
                        for part in text.diff(txn, YChange::identity) {
                            let Out::Any(Any::String(value)) = part.insert else {
                                unreachable!()
                            };
                            let length = value.encode_utf16().count() as u32;
                            let attributes = part
                                .attributes
                                .unwrap_or_default()
                                .into_iter()
                                .filter(|(_, value)| *value != Any::Null)
                                .map(|(key, value)| {
                                    Ok((
                                        key.to_string(),
                                        serde_json::to_value(value).map_err(|e| e.to_string())?,
                                    ))
                                })
                                .collect::<Result<_, String>>()?;
                            block.runs.push(NativeRun {
                                range: NativeRange {
                                    location: at,
                                    length,
                                },
                                attributes,
                            });
                            at += length;
                        }
                    }
                }
            }
        }
        block.range.length = content.encode_utf16().count() as u32;
        if block.editable && block.kind == "heading" {
            let title = content.trim_matches(|ch: char| ch.is_whitespace() || ch == '\u{feff}');
            if let (Some(id), Some(level)) = (
                block.id.as_ref().filter(|id| !id.is_empty()),
                block
                    .attributes
                    .get("level")
                    .and_then(Value::as_f64)
                    .filter(|level| matches!(*level, 1.0 | 2.0 | 3.0)),
            ) {
                if !title.is_empty() {
                    view.outline.push(NativeOutlineItem {
                        block_id: id.clone(),
                        level: level as u8,
                        text: title.into(),
                        parent_id: None,
                        range: block.range.clone(),
                    });
                }
            }
        }
        view.text.push_str(&content);
        view.blocks.push(block);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn doc() -> DocumentSession {
        let mut source = DocumentSession::new();
        for (id, text) in [("p", "甲👩🏽‍🚀乙"), ("q", "尾段")] {
            source
                .edit(Edit::AppendParagraph {
                    id: id.into(),
                    text: text.into(),
                })
                .unwrap();
        }
        let mut doc = DocumentSession::new();
        doc.apply_remote(&source.update(None, 1).unwrap(), 1)
            .unwrap();
        doc
    }
    #[test]
    fn native_replacement_is_one_undo_and_rejects_stale_or_structural_edits() {
        let mut doc = doc();
        let before = doc.native_projection().unwrap();
        assert_eq!(before.blocks[1].range.location, 10);
        doc.replace_native(NativeReplacement {
            revision: before.revision,
            range: NativeRange {
                location: 1,
                length: 7,
            },
            text: "星河".into(),
        })
        .unwrap();
        assert_eq!(doc.native_projection().unwrap().text, "甲星河乙\n尾段");
        let saved = doc.update(None, 1).unwrap();
        for (revision, location, length, text) in [
            (before.revision, 0, 0, "旧"),
            (before.revision + 1, 999, 1, ""),
            (before.revision + 1, 1, 0, "\r"),
        ] {
            assert!(doc
                .replace_native(NativeReplacement {
                    revision,
                    range: NativeRange { location, length },
                    text: text.into()
                })
                .is_err());
            assert_eq!(doc.update(None, 1).unwrap(), saved);
        }
        assert!(doc.undo());
        assert_eq!(doc.native_projection().unwrap().text, before.text);
        assert!(!doc.undo());
        assert!(doc.redo());
        assert_eq!(doc.native_projection().unwrap().text, "甲星河乙\n尾段");
    }
}
