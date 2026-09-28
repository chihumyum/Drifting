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
    /// Wrap root children `index..index + copies.len()` in a new container.
    Wrap { index: u32 },
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
            Change::Wrap {
                index: consecutive(&indices).ok_or("Select consecutive blocks")?,
            }
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
                Change::Wrap { index } => {
                    let wrapper = root.insert(&mut txn, index, XmlElementPrelim::empty(tag));
                    for copy in copies {
                        let wrapper = wrapper.clone();
                        build(
                            &mut txn,
                            &move |txn, leaf_tag| {
                                let host = if list {
                                    wrapper.push_back(txn, XmlElementPrelim::empty("listItem"))
                                } else {
                                    wrapper.clone()
                                };
                                host.push_back(txn, XmlElementPrelim::empty(leaf_tag))
                            },
                            copy,
                        );
                    }
                    root.remove_range(&mut txn, index + 1, count);
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
