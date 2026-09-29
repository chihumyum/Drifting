//! Native formatting mutates authoritative XML in one local history unit.
//! Display projections locate blocks; typed runs and metadata come from Yrs.
use super::*;
use crate::structure::{
    block_attributes, insert_runs, preserve_text_attributes, tail_runs, text_attributes, Parent,
    TailRun,
};
use std::collections::BTreeSet;
use std::sync::Arc;
use yrs::Number;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NativeFormatAction {
    Bold,
    Italic,
    Underline,
    Strike,
    Paragraph,
    Heading1,
    Heading2,
    Heading3,
    AlignLeft,
    AlignCenter,
    AlignRight,
    IndentIncrease,
    IndentDecrease,
    Blockquote,
    BulletList,
    OrderedList,
    /// The caret's paragraph, the last of its list item and not the first,
    /// becomes a new list item after it (Enter in a list item).
    SplitListItem,
    /// The caret's paragraph, the last of the last item of a top-level list,
    /// leaves the list to the top level right after it (Enter on an empty
    /// last paragraph ends the list).
    ExitList,
}

/// The deepest block indent, as the renderer's paragraph indent allows.
pub const MAX_INDENT: u32 = 8;

/// Sets (`href`) or removes (none or empty) the URL link of the selection;
/// removing at a caret takes the whole link around it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeLinking {
    pub revision: u64,
    pub range: NativeRange,
    #[serde(default)]
    pub href: Option<String>,
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
            Self::Underline => Some("underline"),
            Self::Strike => Some("strike"),
            _ => None,
        }
    }

    /// Alignment and indent change one attribute of each selected block.
    fn block_attribute(self) -> Option<&'static str> {
        match self {
            Self::AlignLeft | Self::AlignCenter | Self::AlignRight => Some("textAlign"),
            Self::IndentIncrease | Self::IndentDecrease => Some("indent"),
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
pub(crate) fn is_mark(key: &str, mark: &str) -> bool {
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

/// The first and last block a selection touches; a caret touches one.
pub(crate) fn selected_blocks(
    view: &NativeProjection,
    range: &NativeRange,
) -> Result<(usize, usize), String> {
    validate_range(&view.text, range.location, range.length)?;
    let end = range.location + range.length;
    let first = view
        .blocks
        .iter()
        .position(|block| {
            block.range.location <= range.location
                && range.location <= block.range.location + block.range.length
        })
        .ok_or("No text block at selection start")?;
    let last = if range.length == 0 {
        first
    } else {
        view.blocks
            .iter()
            .rposition(|block| block.range.location < end)
            .ok_or("No text block in selection")?
    };
    Ok((first, last))
}

/// A block's indent level from its stored attribute, 0 when absent.
fn indent_level(value: Option<Out>) -> u32 {
    match value {
        Some(Out::Any(Any::Number(n))) => n
            .as_f64()
            .filter(|n| n.is_finite())
            .map_or(0, |n| n.clamp(0.0, MAX_INDENT as f64) as u32),
        _ => 0,
    }
}

/// One text run of a block with the link it carries, if any.
struct LinkSpan {
    offset: u32,
    length: u32,
    keys: Vec<Arc<str>>,
    href: Option<String>,
}

fn link_spans<T: ReadTxn>(text: &XmlTextRef, txn: &T) -> Result<Vec<LinkSpan>, String> {
    let mut at = 0;
    let mut result = Vec::new();
    for run in text.diff(txn, YChange::identity) {
        let Out::Any(Any::String(value)) = run.insert else {
            return Err("Embedded content cannot be linked as plain text".into());
        };
        let length = value.encode_utf16().count() as u32;
        let mut keys = Vec::new();
        let mut href = None;
        for (key, value) in run.attributes.iter().flat_map(|attrs| attrs.iter()) {
            if is_mark(key, "link") {
                keys.push(key.clone());
                if let Any::Map(map) = value {
                    if let Some(Any::String(url)) = map.get("href") {
                        href = Some(url.to_string());
                    }
                }
            }
        }
        result.push(LinkSpan {
            offset: at,
            length,
            keys,
            href,
        });
        at += length;
    }
    Ok(result)
}

/// http, https and mailto addresses only, without spaces or controls.
fn valid_href(href: &str) -> Result<(), String> {
    let lower = href.to_ascii_lowercase();
    let scheme = ["http://", "https://", "mailto:"]
        .iter()
        .any(|scheme| lower.starts_with(scheme) && lower.len() > scheme.len());
    if !scheme || href.len() > 2048 || href.chars().any(|ch| ch.is_whitespace() || ch.is_control())
    {
        return Err("A link must be an http, https or mailto address".into());
    }
    Ok(())
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
        if let Some(key) = request.action.block_attribute() {
            return self.format_block_attribute(request, key);
        }
        let container = match request.action {
            NativeFormatAction::Blockquote => Some("blockquote"),
            NativeFormatAction::BulletList => Some("bulletList"),
            NativeFormatAction::OrderedList => Some("orderedList"),
            _ => None,
        };
        if let Some(tag) = container {
            return self.format_container(request, tag);
        }
        if matches!(
            request.action,
            NativeFormatAction::SplitListItem | NativeFormatAction::ExitList
        ) {
            return self.split_list_item(request);
        }
        let view = self.native_projection()?;
        let (first, last) = selected_blocks(&view, &request.range)?;
        let end = request.range.location + request.range.length;
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
                rebuilt: true,
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

    /// Alignment or indent of each selected paragraph or heading (a caret
    /// takes its block), set as one block attribute in one local
    /// transaction and one undo unit. Left alignment and indent 0 remove the
    /// attribute. Nothing changes when every block already has the value.
    fn format_block_attribute(
        &mut self,
        request: NativeFormatting,
        key: &'static str,
    ) -> Result<(), String> {
        let view = self.native_projection()?;
        let (first, last) = selected_blocks(&view, &request.range)?;
        let txn = self.doc.transact();
        let mut changes = Vec::new();
        for block in &view.blocks[first..=last] {
            if !block.editable {
                return Err("Unsupported block is preserved read-only".into());
            }
            if !matches!(block.kind.as_str(), "paragraph" | "heading") {
                return Err("Alignment and indent require a paragraph or heading".into());
            }
            let element =
                self.editable_block(&txn, block.id.as_deref().ok_or("Missing block ID")?)?;
            let current = element.get_attribute(&txn, key);
            // Compared as read: absent alignment is left, absent indent 0.
            let (unchanged, next): (bool, Option<Any>) = match request.action {
                NativeFormatAction::AlignLeft
                | NativeFormatAction::AlignCenter
                | NativeFormatAction::AlignRight => {
                    let target = match request.action {
                        NativeFormatAction::AlignCenter => "center",
                        NativeFormatAction::AlignRight => "right",
                        _ => "left",
                    };
                    let stored = match &current {
                        Some(Out::Any(Any::String(value))) => value.to_string(),
                        None => "left".into(),
                        Some(_) => String::new(),
                    };
                    (
                        stored == target,
                        (target != "left").then(|| Any::from(target)),
                    )
                }
                NativeFormatAction::IndentIncrease | NativeFormatAction::IndentDecrease => {
                    let level = indent_level(current.clone());
                    let target = if matches!(request.action, NativeFormatAction::IndentIncrease) {
                        (level + 1).min(MAX_INDENT)
                    } else {
                        level.saturating_sub(1)
                    };
                    (
                        target == level,
                        (target > 0).then(|| Any::Number(Number::Int(target as i64))),
                    )
                }
                _ => unreachable!("only block attribute actions reach here"),
            };
            if !unchanged {
                changes.push((element, next));
            }
        }
        if changes.is_empty() {
            return Ok(());
        }
        drop(txn);
        let comments = self.comments.clone();
        let selections = self.selections.clone();
        let undo_count = self.undo.undo_stack().len();
        {
            let mut txn = self.doc.transact_mut_with(LOCAL);
            for (element, next) in changes {
                match next {
                    Some(value) => {
                        element.insert_attribute(&mut txn, key, value);
                    }
                    None => element.remove_attribute(&mut txn, &key),
                }
            }
        }
        self.undo.reset();
        self.revision += 1;
        self.finish_local_edit(comments, selections, undo_count, None, None);
        Ok(())
    }

    /// Sets or removes the URL link of the selection in one local
    /// transaction and one undo unit; entity links and other marks stay.
    /// Setting needs selected text; removing at a caret removes the whole
    /// link around it. A selection that already reads so changes nothing.
    pub fn link_native(&mut self, request: NativeLinking) -> Result<(), String> {
        if request.revision != self.revision {
            return Err("Document changed; refresh the native selection before linking".into());
        }
        if self.active_drafts() > 0 || self.active_input_compositions() > 0 {
            return Err("Commit or cancel active drafts before linking".into());
        }
        let href = request
            .href
            .as_deref()
            .map(str::trim)
            .filter(|href| !href.is_empty())
            .map(str::to_owned);
        if let Some(href) = &href {
            valid_href(href)?;
            if request.range.length == 0 {
                return Err("Select text before adding a link".into());
            }
        }
        let view = self.native_projection()?;
        let (first, last) = selected_blocks(&view, &request.range)?;
        let end = request.range.location + request.range.length;
        let txn = self.doc.transact();
        let mut plans = Vec::new();
        for block in &view.blocks[first..=last] {
            if !block.editable {
                return Err("Unsupported block is preserved read-only".into());
            }
            let element =
                self.editable_block(&txn, block.id.as_deref().ok_or("Missing block ID")?)?;
            let text = match (element.len(&txn), element.get(&txn, 0)) {
                (0, None) => continue,
                (1, Some(XmlOut::Text(text))) => text,
                _ => {
                    return Err(
                        "Text block requires exactly one XML text child in this slice".into(),
                    )
                }
            };
            let spans = link_spans(&text, &txn)?;
            let start = request.range.location.max(block.range.location) - block.range.location;
            let stop = end
                .min(block.range.location + block.range.length)
                .saturating_sub(block.range.location);
            let mut selected = Vec::new();
            if request.range.length == 0 {
                // The linked runs around the caret, as one link.
                let Some(index) = spans.iter().position(|span| {
                    !span.keys.is_empty()
                        && span.offset <= start
                        && start <= span.offset + span.length
                }) else {
                    continue;
                };
                let mut from = index;
                while from > 0 && !spans[from - 1].keys.is_empty() {
                    from -= 1;
                }
                let mut to = index;
                while to + 1 < spans.len() && !spans[to + 1].keys.is_empty() {
                    to += 1;
                }
                for span in &spans[from..=to] {
                    selected.push((
                        span.offset,
                        span.length,
                        span.keys.clone(),
                        span.href.clone(),
                    ));
                }
            } else {
                for span in &spans {
                    let from = span.offset.max(start);
                    let to = (span.offset + span.length).min(stop);
                    if from < to {
                        selected.push((from, to - from, span.keys.clone(), span.href.clone()));
                    }
                }
            }
            if !selected.is_empty() {
                plans.push((text, selected));
            }
        }
        let unchanged = plans
            .iter()
            .flat_map(|(_, spans)| spans)
            .all(|(_, _, keys, current)| match &href {
                Some(href) => {
                    keys.len() == 1
                        && keys[0].as_ref() == "link"
                        && current.as_deref() == Some(href.as_str())
                }
                None => keys.is_empty(),
            });
        if unchanged {
            return Ok(());
        }
        drop(txn);
        let comments = self.comments.clone();
        let selections = self.selections.clone();
        let undo_count = self.undo.undo_stack().len();
        {
            let mut txn = self.doc.transact_mut_with(LOCAL);
            for (text, spans) in plans {
                for (offset, length, keys, _) in spans {
                    let mut attrs: Attrs = keys
                        .into_iter()
                        .filter(|key| href.is_none() || key.as_ref() != "link")
                        .map(|key| (key, Any::Null))
                        .collect();
                    if let Some(href) = &href {
                        attrs.insert(
                            "link".into(),
                            Any::from(std::collections::HashMap::from([(
                                "href".to_string(),
                                Any::from(href.as_str()),
                            )])),
                        );
                    }
                    if !attrs.is_empty() {
                        text.format(&mut txn, offset, length, attrs);
                    }
                }
            }
        }
        self.undo.reset();
        self.revision += 1;
        self.finish_local_edit(comments, selections, undo_count, None, None);
        Ok(())
    }
}
