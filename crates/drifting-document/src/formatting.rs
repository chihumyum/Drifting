//! Native formatting mutates authoritative XML in one local history unit.
//! Display projections locate blocks; typed runs and metadata come from Yrs.
use super::*;
use crate::structure::{
    block_attributes, insert_runs, preserve_text_attributes, tail_runs, text_attributes, Parent,
    TailRun,
};
use std::collections::BTreeSet;
use std::sync::Arc;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NativeFormatAction {
    Bold,
    Italic,
    Paragraph,
    Heading1,
    Heading2,
    Heading3,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeFormatting {
    pub revision: u64,
    pub range: NativeRange,
    pub action: NativeFormatAction,
}

impl NativeFormatAction {
    fn mark(self) -> Option<&'static str> {
        match self {
            Self::Bold => Some("bold"),
            Self::Italic => Some("italic"),
            _ => None,
        }
    }

    fn level(self) -> Option<i64> {
        match self {
            Self::Heading1 => Some(1),
            Self::Heading2 => Some(2),
            Self::Heading3 => Some(3),
            _ => None,
        }
    }
}

// y-prosemirror may suffix overlapping mark keys with an eight-byte hash.
// Other keys and every non-target payload stay authoritative and unchanged.
fn is_mark(key: &str, mark: &str) -> bool {
    key == mark
        || key
            .strip_prefix(mark)
            .and_then(|suffix| suffix.strip_prefix("--"))
            .is_some_and(|suffix| {
                suffix.len() == 8
                    && suffix
                        .bytes()
                        .all(|ch| ch.is_ascii_alphanumeric() || b"+/=".contains(&ch))
            })
}

struct MarkSpan {
    offset: u32,
    length: u32,
    keys: Vec<Arc<str>>,
}

fn mark_spans<T: ReadTxn>(
    text: &XmlTextRef,
    txn: &T,
    from: u32,
    to: u32,
    marks: &[&str],
) -> Result<Vec<MarkSpan>, String> {
    let mut at = 0;
    let mut result = Vec::new();
    for run in text.diff(txn, YChange::identity) {
        let Out::Any(Any::String(value)) = run.insert else {
            return Err("Embedded content cannot be formatted as plain text".into());
        };
        let end = at + value.encode_utf16().count() as u32;
        let start = at.max(from);
        let stop = end.min(to);
        if start < stop {
            let keys = run
                .attributes
                .iter()
                .flat_map(|attrs| attrs.keys())
                .filter(|key| marks.iter().any(|mark| is_mark(key, mark)))
                .cloned()
                .collect();
            result.push(MarkSpan {
                offset: start,
                length: stop - start,
                keys,
            });
        }
        at = end;
    }
    Ok(result)
}

struct BlockPlan {
    original: XmlElementRef,
    parent: Parent,
    // Replacing a tag reconstructs only the selected leaf, never its siblings
    // or container. The existing lineage machinery remaps local anchors.
    replacement: Option<(Attrs, Attrs, Vec<TailRun>)>,
    text: Option<XmlTextRef>,
    marks: Vec<MarkSpan>,
    change_level: bool,
}

impl DocumentSession {
    /// One selection command, one LOCAL transaction and one undo unit.
    /// Inline formatting needs selected text; block formatting also accepts a
    /// caret. Paragraph clearing inside containers requires a separate unwrap
    /// operation and is rejected before mutation in this slice.
    pub fn format_native(&mut self, request: NativeFormatting) -> Result<(), String> {
        if request.revision != self.revision {
            return Err("Document changed; refresh the native selection before formatting".into());
        }
        if self.active_drafts() > 0 || self.active_input_compositions() > 0 {
            return Err("Commit or cancel active drafts before formatting".into());
        }
        let view = self.native_projection()?;
        validate_range(&view.text, request.range.location, request.range.length)?;
        let end = request.range.location + request.range.length;
        let first = view
            .blocks
            .iter()
            .position(|block| {
                block.range.location <= request.range.location
                    && request.range.location <= block.range.location + block.range.length
            })
            .ok_or("No text block at selection start")?;
        let last = if request.range.length == 0 {
            first
        } else {
            view.blocks
                .iter()
                .rposition(|block| block.range.location < end)
                .ok_or("No text block in selection")?
        };
        let blocks = &view.blocks[first..=last];
        let mark = request.action.mark();
        if mark.is_some() && request.range.length == 0 {
            return Err("Select text before applying inline formatting".into());
        }
        let paragraph = matches!(request.action, NativeFormatAction::Paragraph);
        let kind = if paragraph { "paragraph" } else { "heading" };
        let level = request.action.level().map(Any::from);
        let txn = self.doc.transact();
        let mut plans = Vec::new();
        for block in blocks {
            if !block.editable {
                return Err("Unsupported block is preserved read-only".into());
            }
            if mark.is_none() && !matches!(block.kind.as_str(), "paragraph" | "heading") {
                return Err("Block formatting requires a paragraph or heading".into());
            }
            let original =
                self.editable_block(&txn, block.id.as_deref().ok_or("Missing block ID")?)?;
            let parent = Parent(
                original
                    .parent()
                    .unwrap_or(XmlOut::Fragment(self.root.clone())),
            );
            if mark.is_none() {
                if paragraph && !matches!(parent.0, XmlOut::Fragment(_)) {
                    return Err(
                        "Clearing container formatting requires an unsupported unwrap operation"
                            .into(),
                    );
                }
                // A list item's first child must stay a paragraph in the old
                // schema. Headings in quotes or later list children are valid.
                if let XmlOut::Element(container) = &parent.0 {
                    if container.tag().as_ref() == "listItem"
                        && matches!(container.get(&txn, 0), Some(XmlOut::Element(first)) if first == original)
                    {
                        return Err("The first block of a list item must remain a paragraph".into());
                    }
                }
            }
            let text = match (original.len(&txn), original.get(&txn, 0)) {
                (0, None) => None,
                (1, Some(XmlOut::Text(text))) => Some(text),
                _ => {
                    return Err(
                        "Text block requires exactly one XML text child in this slice".into(),
                    )
                }
            };
            let start = request.range.location.max(block.range.location) - block.range.location;
            let stop = end
                .min(block.range.location + block.range.length)
                .saturating_sub(block.range.location);
            let marks = if let Some(text) = &text {
                let targets = if let Some(mark) = mark {
                    vec![mark]
                } else if paragraph {
                    vec!["bold", "italic", "strike"]
                } else {
                    Vec::new()
                };
                mark_spans(text, &txn, start, stop, &targets)?
            } else {
                Vec::new()
            };
            let replacement = if mark.is_none() && block.kind != kind {
                let mut attrs = block_attributes(&original, &txn)?;
                if let Some(level) = &level {
                    attrs.insert("level".into(), level.clone());
                } else {
                    attrs.remove("level");
                }
                Some((
                    attrs,
                    text_attributes(std::slice::from_ref(&original), &txn)?,
                    tail_runs(block, &original, &txn, block.range.location)?,
                ))
            } else {
                None
            };
            let change_level = mark.is_none()
                && match (&level, original.get_attribute(&txn, "level")) {
                    (Some(level), Some(Out::Any(value))) => *level != value,
                    (None, None) => false,
                    _ => true,
                };
            plans.push(BlockPlan {
                original,
                parent,
                replacement,
                text,
                marks,
                change_level,
            });
        }
        let remove = mark.is_none()
            || plans
                .iter()
                .flat_map(|plan| &plan.marks)
                .all(|span| !span.keys.is_empty());
        if mark.is_some() && plans.iter().all(|plan| plan.marks.is_empty()) {
            return Err("Select text before applying inline formatting".into());
        }
        if mark.is_none()
            && plans.iter().all(|plan| {
                plan.replacement.is_none()
                    && !plan.change_level
                    && plan.marks.iter().all(|span| span.keys.is_empty())
            })
        {
            return Ok(());
        }
        drop(txn);
        let reconstructed = plans.iter().any(|plan| plan.replacement.is_some());
        let before_layout = reconstructed
            .then(|| self.capture_lineage(blocks))
            .transpose()?;
        let comments = self.comments.clone();
        let selections = self.selections.clone();
        let undo_count = self.undo.undo_stack().len();
        {
            let mut txn = self.doc.transact_mut_with(LOCAL);
            for plan in plans {
                let text = if let Some((attrs, text_attrs, runs)) = plan.replacement {
                    let index = plan.parent.children(&txn).position(|node|
                        matches!(node, XmlOut::Element(ref element) if *element == plan.original))
                        .expect("Preflighted formatting block remains in its parent");
                    let target =
                        plan.parent
                            .insert(&mut txn, index as u32, XmlElementPrelim::empty(kind));
                    for (key, value) in attrs {
                        target.insert_attribute(&mut txn, key, value);
                    }
                    let text = if plan.text.is_some() {
                        let text = target.push_back(&mut txn, XmlTextPrelim::new(""));
                        preserve_text_attributes(&text, &mut txn, &text_attrs);
                        insert_runs(&text, &mut txn, 0, runs);
                        Some(text)
                    } else {
                        None
                    };
                    plan.parent.remove(&mut txn, index as u32 + 1);
                    text
                } else {
                    if plan.change_level {
                        if let Some(level) = &level {
                            plan.original
                                .insert_attribute(&mut txn, "level", level.clone());
                        } else {
                            plan.original.remove_attribute(&mut txn, &"level");
                        }
                    }
                    plan.text
                };
                if let Some(text) = text {
                    for span in plan.marks {
                        let attrs = if remove {
                            span.keys
                                .into_iter()
                                .collect::<BTreeSet<_>>()
                                .into_iter()
                                .map(|key| (key, Any::Null))
                                .collect::<Attrs>()
                        } else if span.keys.is_empty() {
                            [(mark.unwrap().into(), Any::Map(Default::default()))]
                                .into_iter()
                                .collect()
                        } else {
                            continue;
                        };
                        if !attrs.is_empty() {
                            text.format(&mut txn, span.offset, span.length, attrs);
                        }
                    }
                }
            }
        }
        self.undo.reset();
        self.revision += 1;
        let after = self.native_projection()?;
        // Text/IDs/order do not change. An empty replacement at zero expresses
        // that identity map without marking any copied character as deleted.
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
        let lineage = if let Some(before) = before_layout {
            Some(crate::lineage::Lineage {
                before,
                after: self.capture_lineage(&after.blocks[first..=last])?,
                forward: mapping.clone(),
                relocation: None,
            })
        } else {
            None
        };
        self.finish_local_edit(
            comments,
            selections,
            undo_count,
            reconstructed.then_some(&mapping),
            lineage,
        );
        Ok(())
    }
}
