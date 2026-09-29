//! Block quotes and bullet or ordered lists around top-level paragraphs and
//! headings. Wrapping reconstructs the selected leaves inside a new root
//! container; lifting reconstructs them at the root beside theirs. Only the
//! selected leaves are rebuilt (with their public IDs, typed metadata and
//! exact marks), never an unselected sibling, so lifting takes the start,
//! the end or all of a container. The lineage machinery remaps local anchors
//! as for heading changes. One local transaction and one undo unit.
use super::*;
use crate::formatting::selected_blocks;
use crate::structure::{
    block_attributes, insert_runs, preserve_text_attributes, tail_runs, text_attributes, Parent,
    TailRun,
};

struct LeafCopy {
    tag: String,
    attrs: Attrs,
    text: Option<(Attrs, Vec<TailRun>)>,
}

enum Change {
    /// Wrap root children `index..index + copies.len()` in a new container,
    /// or join the container of the same kind right before them (appending)
    /// or right after them (prepending).
    Wrap {
        index: u32,
        join: Option<(XmlElementRef, bool)>,
    },
    /// Lift children `start..start + copies.len()` of the root container at
    /// `container_index`, which holds `length` children.
    Lift {
        container: XmlElementRef,
        container_index: u32,
        start: u32,
        length: u32,
    },
}

fn root_index<T: ReadTxn>(root: &XmlFragmentRef, txn: &T, element: &XmlElementRef) -> Option<u32> {
    root.children(txn)
        .position(|node| matches!(node, XmlOut::Element(ref e) if e == element))
        .map(|index| index as u32)
}

fn child_index<T: ReadTxn>(
    parent: &XmlElementRef,
    txn: &T,
    element: &XmlElementRef,
) -> Option<u32> {
    parent
        .children(txn)
        .position(|node| matches!(node, XmlOut::Element(ref e) if e == element))
        .map(|index| index as u32)
}

fn is_root(element: &XmlElementRef) -> bool {
    matches!(element.parent(), Some(XmlOut::Fragment(_)))
}

fn parent_element(element: &XmlElementRef) -> Option<XmlElementRef> {
    match element.parent() {
        Some(XmlOut::Element(parent)) => Some(parent),
        _ => None,
    }
}

/// Consecutive indices, returning the first.
fn consecutive(indices: &[u32]) -> Option<u32> {
    let first = *indices.first()?;
    indices
        .iter()
        .enumerate()
        .all(|(n, index)| *index == first + n as u32)
        .then_some(first)
}

impl DocumentSession {
    /// Toggles `tag` (`blockquote`, `bulletList` or `orderedList`) around the
    /// selected paragraphs and headings (a caret takes its block): all in
    /// one such root container lift out of it, all at the root wrap into a
    /// new one. Anything else refuses before mutation.
    pub(crate) fn format_container(
        &mut self,
        request: NativeFormatting,
        tag: &'static str,
    ) -> Result<(), String> {
        let view = self.native_projection()?;
        let (first, last) = selected_blocks(&view, &request.range)?;
        let blocks = &view.blocks[first..=last];
        let txn = self.doc.transact();
        let mut leaves = Vec::new();
        for block in blocks {
            if !block.editable {
                return Err("Unsupported block is preserved read-only".into());
            }
            if !matches!(block.kind.as_str(), "paragraph" | "heading") {
                return Err("Quotes and lists apply to paragraphs and headings".into());
            }
            if tag != "blockquote" && block.kind == "heading" {
                return Err("A heading cannot become a list item".into());
            }
            leaves.push(self.editable_block(&txn, block.id.as_deref().ok_or("Missing block ID")?)?);
        }
        let list = tag != "blockquote";
        // The direct children of one root container that hold the leaves.
        let held: Option<(XmlElementRef, Vec<XmlElementRef>)> = (|| {
            let mut container: Option<XmlElementRef> = None;
            let mut items = Vec::new();
            for leaf in &leaves {
                let (item, owner) = if list {
                    let item = parent_element(leaf)?;
                    if item.tag().as_ref() != "listItem" || item.len(&txn) != 1 {
                        return None;
                    }
                    let owner = parent_element(&item)?;
                    (item, owner)
                } else {
                    (leaf.clone(), parent_element(leaf)?)
                };
                if owner.tag().as_ref() != tag || !is_root(&owner) {
                    return None;
                }
                if container.as_ref().is_some_and(|c| *c != owner) {
                    return None;
                }
                container = Some(owner);
                items.push(item);
            }
            Some((container?, items))
        })();
        let change = if let Some((container, items)) = held {
            let indices: Vec<u32> = items
                .iter()
                .map(|item| child_index(&container, &txn, item))
                .collect::<Option<_>>()
                .ok_or("Container child moved")?;
            let start = consecutive(&indices).ok_or("Select consecutive blocks")?;
            let length = container.len(&txn);
            let count = indices.len() as u32;
            if start != 0 && start + count != length {
                return Err(
                    "Lift the first or last blocks of a quote or list, or all of it".into(),
                );
            }
            let container_index =
                root_index(&self.root, &txn, &container).ok_or("Container left the root")?;
            Change::Lift {
                container,
                container_index,
                start,
                length,
            }
        } else if leaves.iter().all(is_root) {
            let indices: Vec<u32> = leaves
                .iter()
                .map(|leaf| root_index(&self.root, &txn, leaf))
                .collect::<Option<_>>()
                .ok_or("Block left the root")?;
            let index = consecutive(&indices).ok_or("Select consecutive blocks")?;
            let same = |at: u32| match self.root.get(&txn, at) {
                Some(XmlOut::Element(element)) if element.tag().as_ref() == tag => Some(element),
                _ => None,
            };
            let join = index
                .checked_sub(1)
                .and_then(same)
                .map(|element| (element, true))
                .or_else(|| same(index + indices.len() as u32).map(|element| (element, false)));
            Change::Wrap { index, join }
        } else {
            return Err("Quotes and lists wrap top-level paragraphs and headings".into());
        };
        let mut copies = Vec::new();
        for (block, leaf) in blocks.iter().zip(&leaves) {
            let text = match (leaf.len(&txn), leaf.get(&txn, 0)) {
                (0, None) => None,
                (1, Some(XmlOut::Text(_))) => Some((
                    text_attributes(std::slice::from_ref(leaf), &txn)?,
                    tail_runs(block, leaf, &txn, block.range.location)?,
                )),
                _ => {
                    return Err(
                        "Text block requires exactly one XML text child in this slice".into(),
                    )
                }
            };
            copies.push(LeafCopy {
                tag: leaf.tag().to_string(),
                attrs: block_attributes(leaf, &txn)?,
                text,
            });
        }
        drop(txn);
        let before = self.capture_lineage(blocks)?;
        let comments = self.comments.clone();
        let selections = self.selections.clone();
        let undo_count = self.undo.undo_stack().len();
        {
            let mut txn = self.doc.transact_mut_with(LOCAL);
            let root = Parent(XmlOut::Fragment(self.root.clone()));
            let count = copies.len() as u32;
            let build = |txn: &mut yrs::TransactionMut,
                         host: &dyn Fn(&mut yrs::TransactionMut, &str) -> XmlElementRef,
                         copy: LeafCopy| {
                let target = host(txn, &copy.tag);
                for (key, value) in copy.attrs {
                    target.insert_attribute(txn, key, value);
                }
                if let Some((attrs, runs)) = copy.text {
                    let text = target.push_back(txn, XmlTextPrelim::new(""));
                    preserve_text_attributes(&text, txn, &attrs);
                    insert_runs(&text, txn, 0, runs);
                }
            };
            match change {
                Change::Wrap { index, join } => {
                    let (wrapper, first_at, originals) = match join {
                        Some((container, true)) => {
                            let end = container.len(&txn);
                            (container, end, index)
                        }
                        Some((container, false)) => (container, 0, index),
                        None => (
                            root.insert(&mut txn, index, XmlElementPrelim::empty(tag)),
                            0,
                            index + 1,
                        ),
                    };
                    for (n, copy) in copies.into_iter().enumerate() {
                        let wrapper = wrapper.clone();
                        let at = first_at + n as u32;
                        build(
                            &mut txn,
                            &move |txn, leaf_tag| {
                                if list {
                                    let item = wrapper.insert(
                                        txn,
                                        at,
                                        XmlElementPrelim::empty("listItem"),
                                    );
                                    item.push_back(txn, XmlElementPrelim::empty(leaf_tag))
                                } else {
                                    wrapper.insert(txn, at, XmlElementPrelim::empty(leaf_tag))
                                }
                            },
                            copy,
                        );
                    }
                    root.remove_range(&mut txn, originals, count);
                }
                Change::Lift {
                    container,
                    container_index,
                    start,
                    length,
                } => {
                    let all = count == length;
                    // A leading run goes before the container, a trailing one after.
                    let at = if start == 0 {
                        container_index
                    } else {
                        container_index + 1
                    };
                    for (n, copy) in copies.into_iter().enumerate() {
                        let root = Parent(XmlOut::Fragment(self.root.clone()));
                        build(
                            &mut txn,
                            &move |txn, leaf_tag| {
                                root.insert(txn, at + n as u32, XmlElementPrelim::empty(leaf_tag))
                            },
                            copy,
                        );
                    }
                    if all {
                        root.remove(&mut txn, container_index + count);
                    } else {
                        container.remove_range(&mut txn, start, count);
                    }
                }
            }
        }
        self.undo.reset();
        self.revision += 1;
        let after = self.native_projection()?;
        let mapping = NativeEditMap::new(
            &view,
            &after,
            &NativeReplacement {
                revision: request.revision,
                range: NativeRange {
                    location: 0,
                    length: 0,
                },
                text: String::new(),
            },
        );
        let lineage = crate::lineage::Lineage {
            before,
            after: self.capture_lineage(&after.blocks[first..=last])?,
            forward: mapping.clone(),
            relocation: None,
            rebuilt: true,
        };
        self.finish_local_edit(
            comments,
            selections,
            undo_count,
            Some(&mapping),
            Some(lineage),
        );
        Ok(())
    }

    /// Moves the caret's paragraph or heading, the last child of a list item
    /// of a root list and not its first, into a new list item right after
    /// that one: the second half of Enter in a list item. Only the moved leaf
    /// is rebuilt. One local transaction and one undo unit.
    pub(crate) fn split_list_item(&mut self, request: NativeFormatting) -> Result<(), String> {
        if request.range.length != 0 {
            return Err("Place the caret in the list item to split".into());
        }
        let view = self.native_projection()?;
        let (first, last) = selected_blocks(&view, &request.range)?;
        let block = &view.blocks[first];
        if !block.editable || !matches!(block.kind.as_str(), "paragraph" | "heading") {
            return Err("Quotes and lists apply to paragraphs and headings".into());
        }
        let txn = self.doc.transact();
        let leaf = self.editable_block(&txn, block.id.as_deref().ok_or("Missing block ID")?)?;
        let item = parent_element(&leaf)
            .filter(|item| item.tag().as_ref() == "listItem")
            .ok_or("The caret is not in a list item")?;
        let list = parent_element(&item)
            .filter(|list| {
                matches!(list.tag().as_ref(), "bulletList" | "orderedList") && is_root(list)
            })
            .ok_or("Only items of a top-level list split")?;
        let position = child_index(&item, &txn, &leaf).ok_or("Item child moved")?;
        if position == 0 || position + 1 != item.len(&txn) {
            return Err(
                "Only the last paragraph of a list item after its first becomes a new item".into(),
            );
        }
        let item_index = child_index(&list, &txn, &item).ok_or("List item moved")?;
        let text = match (leaf.len(&txn), leaf.get(&txn, 0)) {
            (0, None) => None,
            (1, Some(XmlOut::Text(_))) => Some((
                text_attributes(std::slice::from_ref(&leaf), &txn)?,
                tail_runs(block, &leaf, &txn, block.range.location)?,
            )),
            _ => return Err("Text block requires exactly one XML text child in this slice".into()),
        };
        let copy = LeafCopy {
            tag: leaf.tag().to_string(),
            attrs: block_attributes(&leaf, &txn)?,
            text,
        };
        drop(txn);
        let blocks = &view.blocks[first..=last];
        let before = self.capture_lineage(blocks)?;
        let comments = self.comments.clone();
        let selections = self.selections.clone();
        let undo_count = self.undo.undo_stack().len();
        {
            let mut txn = self.doc.transact_mut_with(LOCAL);
            let next = list.insert(
                &mut txn,
                item_index + 1,
                XmlElementPrelim::empty("listItem"),
            );
            let target = next.push_back(&mut txn, XmlElementPrelim::empty(copy.tag.as_str()));
            for (key, value) in copy.attrs {
                target.insert_attribute(&mut txn, key, value);
            }
            if let Some((attrs, runs)) = copy.text {
                let text = target.push_back(&mut txn, XmlTextPrelim::new(""));
                preserve_text_attributes(&text, &mut txn, &attrs);
                insert_runs(&text, &mut txn, 0, runs);
            }
            item.remove(&mut txn, position);
        }
        self.undo.reset();
        self.revision += 1;
        let after = self.native_projection()?;
        let mapping = NativeEditMap::new(
            &view,
            &after,
            &NativeReplacement {
                revision: request.revision,
                range: NativeRange {
                    location: 0,
                    length: 0,
                },
                text: String::new(),
            },
        );
        let lineage = crate::lineage::Lineage {
            before,
            after: self.capture_lineage(&after.blocks[first..=last])?,
            forward: mapping.clone(),
            relocation: None,
            rebuilt: true,
        };
        self.finish_local_edit(
            comments,
            selections,
            undo_count,
            Some(&mapping),
            Some(lineage),
        );
        Ok(())
    }
}
