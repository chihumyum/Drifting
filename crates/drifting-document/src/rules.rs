//! Horizontal rules (分隔线) between top-level blocks. A rule is a read-only
//! block in the native projection (one U+FFFC unit), so it is inserted and
//! removed only through these commands, each one local transaction and one
//! undo unit.
use super::*;
use crate::structure::Parent;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NativeRuleAction {
    Insert,
    Remove,
}

/// `insert`: a rule after the top-level block holding the caret at
/// `location`, then an empty paragraph for the caret; an empty top-level
/// paragraph gets the rule before it instead. `remove`: the rule whose
/// projected block starts at `location`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRuleEdit {
    pub revision: u64,
    pub location: u32,
    pub action: NativeRuleAction,
}

fn root_ancestor(element: &XmlElementRef) -> XmlElementRef {
    let mut current = element.clone();
    while let Some(XmlOut::Element(parent)) = current.parent() {
        current = parent;
    }
    current
}

impl DocumentSession {
    /// Applies the rule edit and returns where the caret belongs afterwards.
    pub fn rule_native(&mut self, edit: NativeRuleEdit) -> Result<u32, String> {
        if edit.revision != self.revision {
            return Err("Document changed; refresh the native selection before editing".into());
        }
        if self.active_drafts() > 0 || self.active_input_compositions() > 0 {
            return Err("Commit or cancel active drafts before editing".into());
        }
        let view = self.native_projection()?;
        match edit.action {
            NativeRuleAction::Insert => self.insert_rule(&view, edit),
            NativeRuleAction::Remove => self.remove_rule(&view, edit),
        }
    }

    fn insert_rule(
        &mut self,
        view: &NativeProjection,
        edit: NativeRuleEdit,
    ) -> Result<u32, String> {
        let block = view
            .blocks
            .iter()
            .find(|block| {
                block.range.location <= edit.location
                    && edit.location <= block.range.location + block.range.length
            })
            .ok_or("No text block at the caret")?;
        if !block.editable {
            return Err("Unsupported block is preserved read-only".into());
        }
        let txn = self.doc.transact();
        let element = self.find_block(&txn, block.id.as_deref().ok_or("Missing block ID")?)?;
        let top = root_ancestor(&element);
        let index = self
            .root
            .children(&txn)
            .position(|node| matches!(node, XmlOut::Element(ref e) if *e == top))
            .ok_or("Block left the root")? as u32;
        // An empty top-level paragraph keeps the caret below a rule before it.
        let before_empty = top == element && block.kind == "paragraph" && block.range.length == 0;
        drop(txn);
        let comments = self.comments.clone();
        let selections = self.selections.clone();
        let undo_count = self.undo.undo_stack().len();
        let rule_id = Uuid::now_v7().to_string();
        {
            let mut txn = self.doc.transact_mut_with(LOCAL);
            let root = Parent(XmlOut::Fragment(self.root.clone()));
            let at = if before_empty { index } else { index + 1 };
            let rule = root.insert(&mut txn, at, XmlElementPrelim::empty("horizontalRule"));
            rule.insert_attribute(&mut txn, "id", rule_id.clone());
            if !before_empty {
                let paragraph = root.insert(&mut txn, at + 1, XmlElementPrelim::empty("paragraph"));
                paragraph.insert_attribute(&mut txn, "id", Uuid::now_v7().to_string());
            }
        }
        self.undo.reset();
        self.revision += 1;
        let after = self.native_projection()?;
        let rule = after
            .blocks
            .iter()
            .find(|block| block.id.as_deref() == Some(rule_id.as_str()))
            .ok_or("Inserted rule is missing")?;
        let (replacement, caret) = if before_empty {
            ((rule.range.location, "\u{fffc}\n"), rule.range.location + 2)
        } else {
            (
                (rule.range.location - 1, "\n\u{fffc}\n"),
                rule.range.location + 2,
            )
        };
        let map = NativeEditMap::new(
            view,
            &after,
            &NativeReplacement {
                revision: edit.revision,
                range: NativeRange {
                    location: replacement.0,
                    length: 0,
                },
                text: replacement.1.into(),
            },
        );
        self.finish_local_edit(comments, selections, undo_count, Some(&map), None);
        Ok(caret)
    }

    fn remove_rule(
        &mut self,
        view: &NativeProjection,
        edit: NativeRuleEdit,
    ) -> Result<u32, String> {
        let index = view
            .blocks
            .iter()
            .position(|block| {
                block.range.location == edit.location && block.kind == "horizontalRule"
            })
            .ok_or("No rule here")?;
        if view.blocks.len() == 1 {
            return Err("A body keeps at least one block".into());
        }
        let id = view.blocks[index]
            .id
            .clone()
            .ok_or("This rule has no identity and is preserved")?;
        let txn = self.doc.transact();
        let rule = self.find_block(&txn, &id)?;
        let parent = match rule.parent() {
            Some(XmlOut::Fragment(_)) => Parent(XmlOut::Fragment(self.root.clone())),
            Some(XmlOut::Element(container)) => {
                if container.len(&txn) == 1 {
                    return Err("A rule alone in a quote or list is preserved".into());
                }
                Parent(XmlOut::Element(container))
            }
            _ => return Err("Rule has no parent".into()),
        };
        let position = parent
            .children(&txn)
            .position(|node| matches!(node, XmlOut::Element(ref e) if *e == rule))
            .ok_or("Rule left its parent")? as u32;
        drop(txn);
        let comments = self.comments.clone();
        let selections = self.selections.clone();
        let undo_count = self.undo.undo_stack().len();
        {
            let mut txn = self.doc.transact_mut_with(LOCAL);
            parent.remove(&mut txn, position);
        }
        self.undo.reset();
        self.revision += 1;
        let after = self.native_projection()?;
        // The rule and one separator leave the text: the following newline,
        // or the preceding one for the last block.
        let last = index + 1 == view.blocks.len();
        let location = if last {
            edit.location - 1
        } else {
            edit.location
        };
        let map = NativeEditMap::new(
            view,
            &after,
            &NativeReplacement {
                revision: edit.revision,
                range: NativeRange {
                    location,
                    length: 2,
                },
                text: String::new(),
            },
        );
        self.finish_local_edit(comments, selections, undo_count, Some(&map), None);
        Ok(location)
    }
}
