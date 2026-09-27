//! Version restore: a CRDT cannot rewind, so restoring a past state is one
//! forward local edit that replaces the body with deep copies of the past
//! state's blocks, attributes and formatted runs. It is captured, journaled
//! and undone like any other local edit.
use super::*;

fn copy_children<T: ReadTxn>(
    source: &[XmlOut],
    source_txn: &T,
    target: &XmlElementRef,
    txn: &mut yrs::TransactionMut,
) -> Result<(), String> {
    for (index, child) in source.iter().enumerate() {
        match child {
            XmlOut::Element(element) => {
                let copy = target.insert(
                    txn,
                    index as u32,
                    XmlElementPrelim::empty(element.tag().as_ref()),
                );
                copy_element(element, source_txn, &copy, txn)?;
            }
            XmlOut::Text(text) => {
                let copy = target.insert(txn, index as u32, XmlTextPrelim::new(""));
                copy_text(text, source_txn, &copy, txn)?;
            }
            XmlOut::Fragment(_) => return Err("Nested fragments cannot be restored".into()),
        }
    }
    Ok(())
}

fn copy_element<T: ReadTxn>(
    source: &XmlElementRef,
    source_txn: &T,
    copy: &XmlElementRef,
    txn: &mut yrs::TransactionMut,
) -> Result<(), String> {
    for (key, value) in source.attributes(source_txn) {
        match value {
            Out::Any(value) => {
                copy.insert_attribute(txn, key, value);
            }
            _ => return Err("Shared attribute values cannot be restored".into()),
        }
    }
    let children: Vec<XmlOut> = source.children(source_txn).collect();
    copy_children(&children, source_txn, copy, txn)
}

fn copy_text<T: ReadTxn>(
    source: &XmlTextRef,
    source_txn: &T,
    copy: &XmlTextRef,
    txn: &mut yrs::TransactionMut,
) -> Result<(), String> {
    let mut at = 0u32;
    let mut previous: Vec<std::sync::Arc<str>> = Vec::new();
    for run in source.diff(source_txn, YChange::identity) {
        let Out::Any(Any::String(chunk)) = run.insert else {
            return Err("Embedded inline content cannot be restored".into());
        };
        // An insertion inherits the formatting on its left, so each run
        // closes the keys of the previous one it does not carry.
        let mut attributes = run
            .attributes
            .map(|attributes| *attributes)
            .unwrap_or_default();
        for key in &previous {
            attributes.entry(key.clone()).or_insert(Any::Null);
        }
        previous = attributes
            .iter()
            .filter(|(_, value)| !matches!(value, Any::Null))
            .map(|(key, _)| key.clone())
            .collect();
        copy.insert_with_attributes(txn, at, &chunk, attributes);
        at += chunk.encode_utf16().count() as u32;
    }
    Ok(())
}

impl DocumentSession {
    /// Replaces the whole body with a copy of `state`'s `default` fragment in
    /// one local, undoable edit. Comment anchors into removed text lapse.
    pub fn replace_with_state(&mut self, state: &[u8]) -> Result<(), String> {
        let mut past = DocumentSession::new();
        past.apply_remote(state, 1)?;
        if past.has_pending() {
            return Err("The restored version is incomplete".into());
        }
        let past_txn = past.doc.transact();
        let blocks: Vec<XmlOut> = past.root.children(&past_txn).collect();
        if blocks.is_empty()
            || blocks
                .iter()
                .any(|block| !matches!(block, XmlOut::Element(_)))
        {
            return Err("The restored version has no blocks".into());
        }
        let command = self
            .authored_capture
            .as_ref()
            .map(crate::native_command::NativeCommandScope::begin)
            .transpose()?;
        let before = self.comments.clone();
        let selections = self.selections.clone();
        let undo_count = self.undo.undo_stack().len();
        {
            let mut txn = self.doc.transact_mut_with(LOCAL);
            let length = self.root.len(&txn);
            if length > 0 {
                self.root.remove_range(&mut txn, 0, length);
            }
            for (index, block) in blocks.iter().enumerate() {
                let XmlOut::Element(element) = block else {
                    unreachable!()
                };
                let copy = self.root.insert(
                    &mut txn,
                    index as u32,
                    XmlElementPrelim::empty(element.tag().as_ref()),
                );
                copy_element(element, &past_txn, &copy, &mut txn)?;
            }
        }
        drop(past_txn);
        self.finish_local_edit(before, selections, undo_count, None, None);
        if let Some(command) = command {
            command.complete();
        }
        Ok(())
    }
}
