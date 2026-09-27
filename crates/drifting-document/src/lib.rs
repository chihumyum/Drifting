//! Shared document owner. XML CRDT state is authoritative; JSON is a projection.
//! This first P2 slice validates the wire/semantic boundary before UI binding.
use serde::Deserialize;
mod capture;
#[cfg(test)]
mod comment_tests;
mod comments;
#[cfg(test)]
mod entity_link_tests;
mod entity_links;
pub use capture::AuthoredUpdateLog;
mod concurrent;
#[cfg(test)]
mod concurrent_draft_tests;
#[cfg(test)]
mod draft_tests;
mod drafts;
mod formatting;
pub use formatting::{NativeFormatAction, NativeFormatting};
#[cfg(test)]
mod formatting_tests;
mod history;
mod inputs;
pub use inputs::NativeInputEdit;
#[cfg(test)]
mod input_tests;
pub use drafts::{NativeDraftCommit, NativeDraftSelection, NativeDraftStart};
#[cfg(test)]
mod draft_evidence_tests;
mod lineage;
mod native;
mod prose_export;
pub use prose_export::{prose_markdown, prose_plain_text};
mod prose_metrics;
pub use prose_metrics::{count_words, ProseProjection};
mod native_command;
#[cfg(test)]
mod native_command_tests;
#[cfg(test)]
mod prose_metrics_tests;
pub use native_command::{
    CapturedAuthoredUpdate, NativeDeletionEvidence, NativeSourceId, NativeSourceRange,
    NativeTextDeleteIntent, NativeTransactionEvidence,
};
mod relocation_alias;
mod relocation_history;
#[cfg(test)]
mod relocation_history_tests;
mod remote;
mod restore;
#[cfg(test)]
mod restore_tests;
pub use remote::PreparedRemoteUpdate;
mod retention;
pub use retention::REMOTE_TEXT_RETENTION_REQUIRED;
#[cfg(test)]
mod replay_tests;
#[cfg(test)]
mod retention_tests;
mod search;
pub use search::{native_search_preview, native_search_ranges, NativeSearchHit, NativeSearchMatch};
#[cfg(test)]
mod search_tests;
#[cfg(test)]
mod selection_tests;
mod selections;
mod structure;
mod undo_policy;
#[cfg(test)]
mod undo_policy_tests;
mod wire;
pub use comments::{CommentAnchorRecord, CommentAnchorView, NewCommentAnchor};
pub use entity_links::{EntityLinkSpan, EntityLinkTarget};
pub use native::{
    NativeBlock, NativeOutlineItem, NativeProjection, NativeRange, NativeReplacement, NativeRun,
};
#[cfg(test)]
mod outline_tests;
pub use selections::{NativeSelectionRequest, NativeSelectionView};
use serde_json::{json, Map, Value};
pub use structure::{NativeEditMap, NativeMappedPoint};
use yrs::types::{text::YChange, Attrs, ToJson};
use yrs::updates::{decoder::Decode, encoder::Encode};
use yrs::{
    Any, Assoc, Doc, IndexedSequence, OffsetKind, Options, Out, ReadTxn, StateVector, StickyIndex,
    Text, Transact, Update, Xml, XmlElementPrelim, XmlElementRef, XmlFragment, XmlFragmentRef,
    XmlOut, XmlTextPrelim, XmlTextRef,
};

const LOCAL: &str = "native-local";
const REMOTE: &str = "native-remote";
pub(crate) const HISTORY_REPAIR: &str = "native-relocation-history";
pub const NATIVE_HISTORY_UNAVAILABLE: &str = "NATIVE_HISTORY_UNAVAILABLE";
pub const YRS_VERSION: &str = "0.28.0";

#[derive(Debug, Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase", deny_unknown_fields)]
pub enum Edit {
    Insert {
        block: String,
        offset: u32,
        text: String,
    },
    Delete {
        block: String,
        offset: u32,
        length: u32,
    },
    Format {
        block: String,
        offset: u32,
        length: u32,
        attributes: Map<String, Value>,
    },
    SetAttribute {
        block: String,
        key: String,
        value: Value,
    },
    AppendParagraph {
        id: String,
        text: String,
    },
    DeleteBlock {
        block: String,
    },
}

pub struct DocumentSession {
    doc: Doc,
    root: XmlFragmentRef,
    undo: yrs::undo::UndoManager<history::HistoryMeta>,
    revision: u64,
    comments: comments::CommentSet,
    comment_epoch: u64,
    selections: selections::SelectionSet,
    drafts: drafts::DraftSet,
    inputs: inputs::InputSet,
    authored_capture: Option<std::sync::Arc<std::sync::Mutex<capture::CaptureState>>>,
    popped_history: std::sync::Arc<std::sync::Mutex<Option<history::HistoryMeta>>>,
}

impl Default for DocumentSession {
    fn default() -> Self {
        Self::new()
    }
}

impl DocumentSession {
    pub fn new() -> Self {
        Self::from_options(Options::default())
    }

    /// Fixed IDs are for independent synthetic peers only. Production uses `new`.
    pub fn with_test_client_id(id: u64) -> Result<Self, String> {
        if id == 0 || id >= (1u64 << 53) {
            return Err("Client ID must be a nonzero safe JS integer".into());
        }
        Ok(Self::from_options(Options::with_client_id(
            yrs::ClientID::new(id),
        )))
    }

    fn from_options(mut options: Options) -> Self {
        // Yjs and Apple NSRange both count UTF-16 code units.
        options.offset_kind = OffsetKind::Utf16;
        options.skip_gc = false;
        let doc = Doc::with_options(options);
        let root = doc.get_or_insert_xml_fragment("default");
        let mut undo: yrs::undo::UndoManager<history::HistoryMeta> =
            yrs::undo::UndoManager::with_options(yrs::undo::Options {
                capture_timeout_millis: 0,
                tracked_origins: [LOCAL.into()].into_iter().collect(),
                delete_filter: Some(std::sync::Arc::new(undo_policy::allow_delete)),
                ..Default::default()
            });
        undo.expand_scope(&doc, &root);
        let popped_history = std::sync::Arc::new(std::sync::Mutex::new(None));
        let popped = popped_history.clone();
        undo.observe_item_popped("native-history", move |_, event| {
            *popped.lock().unwrap() = Some(event.meta().clone());
        });
        Self {
            doc,
            root,
            undo,
            revision: 0,
            comments: Default::default(),
            comment_epoch: 0,
            selections: Default::default(),
            drafts: Default::default(),
            inputs: Default::default(),
            authored_capture: None,
            popped_history,
        }
    }

    /// Includes pending inserts/deletes, so out-of-order data survives a reload.
    /// P2c owns the separate SQLite tail/compaction acknowledgement protocol.
    pub fn update(&self, state_vector: Option<&[u8]>, encoding: u8) -> Result<Vec<u8>, String> {
        let vector = state_vector
            .map(StateVector::decode_v1)
            .transpose()
            .map_err(|e| e.to_string())?
            .unwrap_or_default();
        let txn = self.doc.transact();
        match encoding {
            1 => {
                let mut encoder = wire::CheckedEncoder::new();
                txn.encode_state_as_update(&vector, &mut encoder);
                let bytes = encoder.finish()?;
                if let Some(pending) = txn.store().pending_update() {
                    wire::validate_update(&pending.update)?;
                }
                // The generic encoder omits pending updates/delete sets. Keep
                // Yrs' existing full merge path after validating both sources.
                Ok(if txn.has_missing_updates() {
                    txn.encode_state_as_update_v1(&vector)
                } else {
                    bytes
                })
            }
            // Cross-language fixtures found corrupt binary array values in
            // Yrs 0.28 v2 emission. The published client uses v1. Keep writing
            // v1 explicitly until an upstream version passes that regression.
            2 => Err(
                "Native output is pinned to v1: Yrs v2 binary values fail interoperability".into(),
            ),
            _ => Err("Unsupported update encoding".into()),
        }
    }

    pub fn state_vector(&self) -> Vec<u8> {
        self.doc.transact().state_vector().encode_v1()
    }
    pub fn has_pending(&self) -> bool {
        self.doc.transact().has_missing_updates()
    }
    pub fn undo(&mut self) -> bool {
        self.try_undo().unwrap_or(false)
    }
    pub fn redo(&mut self) -> bool {
        self.try_redo().unwrap_or(false)
    }
    pub fn try_undo(&mut self) -> Result<bool, String> {
        self.apply_history(false)
    }
    pub fn try_redo(&mut self) -> Result<bool, String> {
        self.apply_history(true)
    }
    fn apply_history(&mut self, redo: bool) -> Result<bool, String> {
        let relocation = self
            .relocation_history_handle(redo)
            .map(|handle| relocation_history::prepare(self, &handle, redo))
            .transpose()
            .map_err(|error| format!("{NATIVE_HISTORY_UNAVAILABLE}: {error}"))?;
        self.prepare_selection_history(redo);
        self.begin_authored_group()?;
        let result = self.apply_history_group(redo, relocation);
        let grouped = self.finish_authored_group();
        let changed = result?;
        grouped?;
        Ok(changed)
    }
    fn apply_history_group(
        &mut self,
        redo: bool,
        relocation: Option<relocation_history::PreparedHistory>,
    ) -> Result<bool, String> {
        if let Some(plan) = &relocation {
            relocation_history::dematerialize(self, plan)?;
        }
        self.popped_history.lock().unwrap().take();
        let changed = if redo {
            self.undo.redo_blocking()
        } else {
            self.undo.undo_blocking()
        };
        if let Some(plan) = relocation {
            relocation_history::finish(self, plan, changed)?;
        }
        self.revision += u64::from(changed);
        if changed {
            self.restore_local_history(redo);
        }
        Ok(changed)
    }

    pub fn semantic(&self) -> Result<Value, String> {
        let txn = self.doc.transact();
        Ok(json!({ "type": "doc", "content": project_children(&self.root, &txn)? }))
    }

    pub fn edit(&mut self, edit: Edit) -> Result<(), String> {
        let before = self.comments.clone();
        let selections = self.selections.clone();
        let undo_count = self.undo.undo_stack().len();
        self.edit_prose(edit)?;
        self.finish_local_edit(before, selections, undo_count, None, None);
        Ok(())
    }

    fn edit_prose(&mut self, edit: Edit) -> Result<(), String> {
        // Validate before entering a write transaction: rejected edits are atomic.
        match edit {
            Edit::Insert {
                block,
                offset,
                text,
            } => {
                let txn = self.doc.transact();
                let element = self.editable_block(&txn, &block)?;
                if element.len(&txn) == 0 {
                    validate_range("", offset, 0)?;
                    if text.is_empty() {
                        return Ok(());
                    }
                    drop(txn);
                    element.push_back(
                        &mut self.doc.transact_mut_with(LOCAL),
                        XmlTextPrelim::new(text),
                    );
                } else {
                    let target = self.editable_text(&txn, &block)?;
                    validate_range(&plain_text(&target, &txn)?, offset, 0)?;
                    drop(txn);
                    target.insert(&mut self.doc.transact_mut_with(LOCAL), offset, &text);
                }
            }
            Edit::Delete {
                block,
                offset,
                length,
            } => {
                let txn = self.doc.transact();
                if self.editable_block(&txn, &block)?.len(&txn) == 0 {
                    return validate_range("", offset, length);
                }
                let target = self.editable_text(&txn, &block)?;
                validate_range(&plain_text(&target, &txn)?, offset, length)?;
                drop(txn);
                target.remove_range(&mut self.doc.transact_mut_with(LOCAL), offset, length);
            }
            Edit::Format {
                block,
                offset,
                length,
                attributes,
            } => {
                let txn = self.doc.transact();
                if self.editable_block(&txn, &block)?.len(&txn) == 0 {
                    return validate_range("", offset, length);
                }
                let target = self.editable_text(&txn, &block)?;
                validate_range(&plain_text(&target, &txn)?, offset, length)?;
                let attributes: Attrs = attributes
                    .into_iter()
                    .map(|(key, value)| {
                        Ok((
                            key.into(),
                            Any::from_json(&value.to_string()).map_err(|e| e.to_string())?,
                        ))
                    })
                    .collect::<Result<_, String>>()?;
                drop(txn);
                target.format(
                    &mut self.doc.transact_mut_with(LOCAL),
                    offset,
                    length,
                    attributes,
                );
            }
            Edit::SetAttribute { block, key, value } => {
                if key == "id" {
                    return Err("Stable block identity cannot be replaced".into());
                }
                let target = self.find_block(&self.doc.transact(), &block)?;
                if !known_block(target.tag()) {
                    return Err("Unsupported block is preserved read-only".into());
                }
                let value = Any::from_json(&value.to_string()).map_err(|e| e.to_string())?;
                target.insert_attribute(&mut self.doc.transact_mut_with(LOCAL), key, value);
            }
            Edit::AppendParagraph { id, text } => {
                let txn = self.doc.transact();
                let exists = self.root.successors(&txn).any(|node| matches!(node,
                    XmlOut::Element(block) if block.get_attribute(&txn, "id").is_some_and(|value| value.to_json(&txn) == Any::from(id.as_str()))));
                if id.is_empty() || exists {
                    return Err("A new block needs a distinct nonempty ID".into());
                }
                drop(txn);
                let mut txn = self.doc.transact_mut_with(LOCAL);
                let block = self
                    .root
                    .push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
                block.insert_attribute(&mut txn, "id", id);
                block.push_back(&mut txn, XmlTextPrelim::new(text));
            }
            Edit::DeleteBlock { block } => {
                let txn = self.doc.transact();
                let target = self.find_block(&txn, &block)?;
                if !known_block(target.tag()) {
                    return Err("Unsupported block is preserved read-only".into());
                }
                let index = self
                    .root
                    .children(&txn)
                    .position(
                        |node| matches!(node, XmlOut::Element(ref element) if element == &target),
                    )
                    .ok_or("Only top-level block removal is implemented in this slice")?;
                drop(txn);
                self.root
                    .remove(&mut self.doc.transact_mut_with(LOCAL), index as u32);
            }
        }
        self.undo.reset();
        self.revision += 1;
        Ok(())
    }

    /// Wire-compatible Yjs relative position. UI affinity is explicit.
    pub fn anchor(
        &self,
        block: &str,
        offset: u32,
        associate_before: bool,
    ) -> Result<Vec<u8>, String> {
        let txn = self.doc.transact();
        let assoc = if associate_before {
            Assoc::Before
        } else {
            Assoc::After
        };
        let element = self.editable_block(&txn, block)?;
        if element.len(&txn) == 0 {
            validate_range("", offset, 0)?;
            return Ok(StickyIndex::from_type(&txn, &element, assoc).encode_v1());
        }
        let target = self.editable_text(&txn, block)?;
        validate_range(&plain_text(&target, &txn)?, offset, 0)?;
        // Yrs 0.28's indexed lookup returns None at the right-associated end.
        // Yjs encodes that case as the containing type, including empty text.
        let position = if offset == target.len(&txn) && assoc == Assoc::After {
            StickyIndex::from_type(&txn, &target, assoc)
        } else {
            target
                .sticky_index(&txn, offset, assoc)
                .ok_or("Anchor outside text")?
        };
        Ok(position.encode_v1())
    }

    pub fn resolve_anchor(&self, bytes: &[u8]) -> Result<Option<Value>, String> {
        let anchor = StickyIndex::decode_v1(bytes).map_err(|e| e.to_string())?;
        let txn = self.doc.transact();
        let anchor = relocation_history::route_anchor(&txn, &anchor)?.unwrap_or(anchor);
        let Some(offset) = anchor.get_offset(&txn) else {
            return Ok(None);
        };
        // Resolve only live text children; tombstoned parent blocks are invalid.
        for node in self.root.successors(&txn) {
            if let XmlOut::Element(block) = node {
                let branch: &yrs::branch::Branch = block.as_ref();
                if branch.id() == offset.branch.id() {
                    let length = if offset.index == 0 {
                        0
                    } else {
                        match block.get(&txn, 0) {
                            Some(XmlOut::Text(text)) if block.len(&txn) == 1 => text.len(&txn),
                            _ => return Ok(None),
                        }
                    };
                    return Ok(Some(
                        json!({"block": block.get_attribute(&txn, "id").map(|id| id.to_json(&txn)), "offset": length}),
                    ));
                }
                for child in block.children(&txn) {
                    if let XmlOut::Text(text) = child {
                        let branch: &yrs::branch::Branch = text.as_ref();
                        if branch.id() == offset.branch.id() {
                            let id = block.get_attribute(&txn, "id").map(|id| id.to_json(&txn));
                            return Ok(Some(json!({"block": id, "offset": offset.index})));
                        }
                    }
                }
            }
        }
        Ok(None)
    }

    fn find_block<T: ReadTxn>(&self, txn: &T, id: &str) -> Result<XmlElementRef, String> {
        let matches: Vec<_> = self
            .root
            .successors(txn)
            .filter_map(|node| match node {
                XmlOut::Element(block)
                    if block
                        .get_attribute(txn, "id")
                        .is_some_and(|value| value.to_json(txn) == Any::from(id)) =>
                {
                    Some(block)
                }
                _ => None,
            })
            .collect();
        match matches.as_slice() {
            [block] => {
                let mut parent = block.parent();
                while let Some(XmlOut::Element(element)) = parent {
                    if !known_block(element.tag()) {
                        return Err("Unsupported ancestor is preserved read-only".into());
                    }
                    parent = element.parent();
                }
                Ok(block.clone())
            }
            [] => Err("Block not found".into()),
            _ => Err("Ambiguous duplicate block ID".into()),
        }
    }

    fn editable_block<T: ReadTxn>(&self, txn: &T, id: &str) -> Result<XmlElementRef, String> {
        let block = self.find_block(txn, id)?;
        if !matches!(block.tag().as_ref(), "paragraph" | "heading" | "codeBlock") {
            return Err("Unsupported text block is preserved read-only".into());
        }
        Ok(block)
    }

    fn editable_text<T: ReadTxn>(&self, txn: &T, id: &str) -> Result<XmlTextRef, String> {
        let block = self.editable_block(txn, id)?;
        match (block.len(txn), block.get(txn, 0)) {
            (1, Some(XmlOut::Text(text))) => Ok(text),
            _ => Err("Text block requires exactly one XML text child in this slice".into()),
        }
    }
}

fn known_block(tag: &str) -> bool {
    matches!(
        tag,
        "paragraph"
            | "heading"
            | "codeBlock"
            | "blockquote"
            | "bulletList"
            | "orderedList"
            | "listItem"
            | "horizontalRule"
    )
}

fn project_children<T: ReadTxn>(parent: &impl XmlFragment, txn: &T) -> Result<Vec<Value>, String> {
    let mut children = Vec::new();
    for child in parent.children(txn) {
        match child {
            XmlOut::Element(block) => {
                let attrs: Map<String, Value> = block
                    .attributes(txn)
                    .map(|(key, value)| {
                        Ok((
                            key.into(),
                            serde_json::to_value(value.to_json(txn)).map_err(|e| e.to_string())?,
                        ))
                    })
                    .collect::<Result<_, String>>()?;
                let mut node = json!({ "type": block.tag() });
                if !attrs.is_empty() {
                    node["attrs"] = Value::Object(attrs);
                }
                let content = project_children(&block, txn)?;
                if block.len(txn) > 0 {
                    node["content"] = Value::Array(content);
                }
                children.push(node);
            }
            XmlOut::Text(text) => {
                for part in text.diff(txn, YChange::identity) {
                    let Out::Any(Any::String(value)) = part.insert else {
                        return Err(
                            "Embedded XML text value requires an explicit native projection".into(),
                        );
                    };
                    if value.is_empty() {
                        continue;
                    }
                    let mut node = json!({ "type": "text", "text": value });
                    if let Some(attrs) = part.attributes {
                        let mut marks: Vec<_> = attrs
                            .iter()
                            .filter(|(_, value)| **value != Any::Null)
                            .map(|(key, value)| json!({"type": key, "attrs": value}))
                            .collect();
                        marks.sort_by(|a, b| a["type"].as_str().cmp(&b["type"].as_str()));
                        if !marks.is_empty() {
                            node["marks"] = json!(marks);
                        }
                    }
                    children.push(node);
                }
            }
            XmlOut::Fragment(_) => {
                return Err("Nested XML fragment requires an explicit projection".into())
            }
        }
    }
    Ok(children)
}

fn plain_text<T: ReadTxn>(text: &XmlTextRef, txn: &T) -> Result<String, String> {
    let mut result = String::new();
    for part in text.diff(txn, YChange::identity) {
        if let Out::Any(Any::String(value)) = part.insert {
            result.push_str(&value);
        } else {
            return Err("Embedded content cannot be edited as plain text".into());
        }
    }
    Ok(result)
}

/// Reject ranges that split surrogate pairs. Grapheme policy belongs to the UI.
fn validate_range(text: &str, offset: u32, length: u32) -> Result<(), String> {
    let end = offset.checked_add(length).ok_or("Text range overflow")?;
    let mut index = 0;
    let mut start_valid = offset == 0;
    let mut end_valid = end == 0;
    for ch in text.chars() {
        index += ch.len_utf16() as u32;
        start_valid |= index == offset;
        end_valid |= index == end;
    }
    if start_valid && end_valid {
        Ok(())
    } else {
        Err("Invalid UTF-16 range or split surrogate pair".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalid_ranges_leave_content_and_history_unchanged() {
        let mut doc = DocumentSession::new();
        doc.edit(Edit::AppendParagraph {
            id: "p".into(),
            text: "a👩🏽‍🚀e\u{301}𠮷".into(),
        })
        .unwrap();
        let before = doc.update(None, 1).unwrap();
        for (offset, length) in [(2, 0), (10, 1), (99, 0), (u32::MAX, 1)] {
            assert!(doc
                .edit(Edit::Delete {
                    block: "p".into(),
                    offset,
                    length
                })
                .is_err());
            assert_eq!(doc.update(None, 1).unwrap(), before);
        }
        assert!(doc.undo());
        assert_eq!(
            doc.semantic().unwrap(),
            json!({"type": "doc", "content": []})
        );
        assert!(!doc.undo());
    }
    #[test]
    fn malformed_update_and_duplicate_block_ids_are_rejected() {
        let mut doc = DocumentSession::new();
        assert!(doc.apply_remote(&[255], 1).is_err());
        assert!(doc.apply_remote(&[], 3).is_err());
        doc.edit(Edit::AppendParagraph {
            id: "p".into(),
            text: "text".into(),
        })
        .unwrap();
        assert!(doc
            .edit(Edit::AppendParagraph {
                id: "p".into(),
                text: "again".into()
            })
            .is_err());
        assert!(doc
            .edit(Edit::SetAttribute {
                block: "p".into(),
                key: "id".into(),
                value: json!("other")
            })
            .is_err());
    }
}
