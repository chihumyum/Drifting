//! gpui-prose's edits (raw Loro keys and values) as `dr-doc` transactions.
//!
//! The editor speaks the storage format's keys (`bold`, `heading`,
//! `entity:<id>` …) because it reads the body text raw. Every write still
//! goes through `dr-doc`'s typed transaction, so the rules live in one place:
//! Enter moves the block id, a pasted paragraph gets a fresh id, inline marks
//! never sit on a newline, a style the profile does not allow is refused.

use std::ops::Range;

use dr_doc::prose::{ProseTxn, StyleKey};
use dr_doc::schema::{block, inline};
use dr_model::id::{BlockId, CommentId};
use dr_model::kind::{EntityKind, ListKind};
use dr_model::prose::{Align, EntityLink, Heading, InlineStyle, MAX_INDENT};
use gpui_prose::text::{Edit, EditResult, source::MarkOverride};
use loro::LoroValue;

/// An [`Edit`] that owns its data, so it can travel to the document holder's
/// thread.
#[derive(Clone, Debug)]
pub enum OwnedEdit {
    Replace {
        range: Range<usize>,
        text: String,
        overrides: Vec<MarkOverride>,
    },
    Delete {
        range: Range<usize>,
    },
    Split {
        at: usize,
    },
    SetBlockAttr {
        newline: usize,
        key: String,
        value: Option<LoroValue>,
    },
    Mark {
        range: Range<usize>,
        key: String,
        value: LoroValue,
    },
    Unmark {
        range: Range<usize>,
        key: String,
    },
}

impl From<Edit<'_>> for OwnedEdit {
    fn from(edit: Edit<'_>) -> Self {
        match edit {
            Edit::Replace {
                range,
                text,
                overrides,
            } => OwnedEdit::Replace {
                range,
                text: text.to_owned(),
                overrides: overrides.to_vec(),
            },
            Edit::Delete { range } => OwnedEdit::Delete { range },
            Edit::Split { at } => OwnedEdit::Split { at },
            Edit::SetBlockAttr {
                newline,
                key,
                value,
            } => OwnedEdit::SetBlockAttr {
                newline,
                key: key.to_owned(),
                value,
            },
            Edit::Mark { range, key, value } => OwnedEdit::Mark {
                range,
                key: key.to_owned(),
                value,
            },
            Edit::Unmark { range, key } => OwnedEdit::Unmark {
                range,
                key: key.to_owned(),
            },
        }
    }
}

/// Applies `edit` in a `dr-doc` transaction. `undo_items` is left for the
/// caller (it counts commits).
pub fn apply(txn: &mut ProseTxn<'_>, edit: OwnedEdit) -> dr_doc::Result<EditResult> {
    let mut result = EditResult::default();
    match edit {
        OwnedEdit::Replace {
            range,
            text,
            overrides,
        } => {
            let deleted = delete(txn, range)?;
            if !deleted.is_empty() {
                result.deleted.push((deleted.start, deleted.len()));
            }
            let at = deleted.start;
            let end = if text.is_empty() {
                at
            } else {
                txn.insert_paragraphs(at, &text)?
            };
            for (key, value) in &overrides {
                match value {
                    Some(value) => mark(txn, at..end, key, value)?,
                    None => unmark(txn, at..end, key)?,
                }
            }
            result.inserted = at..end;
            result.caret = end;
        }
        OwnedEdit::Delete { range } => {
            let deleted = delete(txn, range)?;
            if !deleted.is_empty() {
                result.deleted.push((deleted.start, deleted.len()));
            }
            result.inserted = deleted.start..deleted.start;
            result.caret = deleted.start;
        }
        OwnedEdit::Split { at } => {
            let caret = txn.split(at)?;
            result.inserted = at..caret;
            result.caret = caret;
        }
        OwnedEdit::SetBlockAttr {
            newline,
            key,
            value,
        } => {
            set_block_attr(txn, newline, &key, value.as_ref())?;
            result.caret = newline;
        }
        OwnedEdit::Mark { range, key, value } => {
            mark(txn, range.clone(), &key, &value)?;
            result.caret = range.end;
        }
        OwnedEdit::Unmark { range, key } => {
            unmark(txn, range.clone(), &key)?;
            result.caret = range.end;
        }
    }
    Ok(result)
}

/// Deletes `range`, clamped so the final newline stays; returns what was
/// deleted.
fn delete(txn: &mut ProseTxn<'_>, range: Range<usize>) -> dr_doc::Result<Range<usize>> {
    let last = txn.view().len().saturating_sub(1);
    let end = range.end.min(last);
    let start = range.start.min(end);
    if start < end {
        txn.delete(start..end)?;
    }
    Ok(start..end)
}

fn truthy(v: &LoroValue) -> bool {
    !matches!(v, LoroValue::Null | LoroValue::Bool(false))
}

fn as_i64(v: &LoroValue) -> Option<i64> {
    match v {
        LoroValue::I64(i) => Some(*i),
        LoroValue::Double(d) if d.fract() == 0.0 && d.is_finite() => Some(*d as i64),
        _ => None,
    }
}

fn as_str(v: &LoroValue) -> Option<&str> {
    match v {
        LoroValue::String(s) => Some(s.as_str()),
        _ => None,
    }
}

/// The typed style a raw inline key and value stand for (`None`: not a
/// style, or a value that clears it).
pub fn inline_style(key: &str, value: &LoroValue) -> Option<InlineStyle> {
    if !truthy(value) {
        return None;
    }
    Some(match key {
        inline::BOLD => InlineStyle::Bold,
        inline::ITALIC => InlineStyle::Italic,
        inline::UNDERLINE => InlineStyle::Underline,
        inline::STRIKE => InlineStyle::Strike,
        inline::LINK => InlineStyle::Link(as_str(value)?.to_owned()),
        inline::HIGHLIGHT => InlineStyle::Highlight(as_str(value)?.to_owned()),
        inline::CODE => InlineStyle::Code,
        _ => return None,
    })
}

fn style_key(key: &str) -> Option<StyleKey> {
    Some(match key {
        inline::BOLD => StyleKey::Bold,
        inline::ITALIC => StyleKey::Italic,
        inline::UNDERLINE => StyleKey::Underline,
        inline::STRIKE => StyleKey::Strike,
        inline::LINK => StyleKey::Link,
        inline::HIGHLIGHT => StyleKey::Highlight,
        inline::CODE => StyleKey::Code,
        _ => return None,
    })
}

/// An entity link from the raw value of an `entity:<id>` mark (the storage
/// format of `loro-schema.md`: a map with `kind`, `block`, `end_block`).
pub fn entity_link(target: &str, value: &LoroValue) -> EntityLink {
    let map = match value {
        LoroValue::Map(map) => Some(map),
        _ => None,
    };
    let get = |k: &str| map.and_then(|m| m.get(k)).and_then(as_str);
    let bid = |k: &str| get(k).and_then(|s| BlockId::parse(s).ok());
    EntityLink {
        target: target.to_owned(),
        kind: get("kind")
            .map(EntityKind::parse)
            .unwrap_or(EntityKind::Element),
        block: bid("block"),
        end_block: bid("end_block"),
    }
}

/// The raw value `dr-doc` stores for an entity link (for tests and for
/// building links in the editor).
pub fn entity_value(link: &EntityLink) -> LoroValue {
    let mut m: Vec<(String, LoroValue)> = vec![("kind".into(), link.kind.as_str().into())];
    if let Some(b) = &link.block {
        m.push(("block".into(), b.as_str().into()));
    }
    if let Some(b) = &link.end_block {
        m.push(("end_block".into(), b.as_str().into()));
    }
    LoroValue::Map(m.into())
}

fn mark(
    txn: &mut ProseTxn<'_>,
    range: Range<usize>,
    key: &str,
    value: &LoroValue,
) -> dr_doc::Result<()> {
    if range.is_empty() || block::is_block_key(key) {
        return Ok(());
    }
    if let Some(target) = inline::entity_target(key) {
        return txn.link_entity(range, &entity_link(target, value));
    }
    match inline_style(key, value) {
        Some(style) => txn.set_style(range, &style),
        None if !truthy(value) => unmark(txn, range, key),
        None => {
            log::warn!("dr-editor: no typed style for the mark {key:?}; not written");
            Ok(())
        }
    }
}

fn unmark(txn: &mut ProseTxn<'_>, range: Range<usize>, key: &str) -> dr_doc::Result<()> {
    if range.is_empty() || block::is_block_key(key) {
        return Ok(());
    }
    if let Some(target) = inline::entity_target(key) {
        return txn.unlink_entity(range, target);
    }
    match style_key(key) {
        Some(k) => txn.clear_style(range, k),
        None => {
            log::warn!("dr-editor: no typed style for the mark {key:?}; not cleared");
            Ok(())
        }
    }
}

/// Sets one paragraph attribute through `dr-doc`. The heading goes through
/// the narrowest write (`set_heading`); the others rewrite the paragraph's
/// typed attributes with one field changed.
fn set_block_attr(
    txn: &mut ProseTxn<'_>,
    newline: usize,
    key: &str,
    value: Option<&LoroValue>,
) -> dr_doc::Result<()> {
    if key == block::ID {
        return Ok(());
    }
    let mut attrs = txn.view().paragraph_at(newline)?.attrs;
    if key == block::HEADING {
        let level = value.and_then(as_i64).and_then(Heading::from_level);
        // Unchanged: no write, so no undo step that does nothing.
        if attrs.heading == level {
            return Ok(());
        }
        return txn.set_heading(newline, level);
    }
    let on = value.is_some_and(truthy);
    match key {
        block::QUOTE => attrs.quote = on,
        block::RULE => attrs.rule = on,
        block::INDENT => {
            attrs.indent = value
                .and_then(as_i64)
                .unwrap_or(0)
                .clamp(0, MAX_INDENT as i64) as u8;
        }
        block::ALIGN => {
            attrs.align = value
                .and_then(as_str)
                .map(Align::from_stored)
                .unwrap_or_default();
        }
        // Lists (material notes; dr-doc drops them elsewhere): the kind,
        // the level, a task's tick and the TODO it is linked to.
        block::LIST => attrs.list = value.and_then(as_str).map(ListKind::parse),
        block::LIST_LEVEL => {
            attrs.list_level = value.and_then(as_i64).unwrap_or(0).clamp(0, 8) as u32;
        }
        block::CHECKED => attrs.checked = on,
        block::TODO => {
            attrs.todo = value
                .and_then(as_str)
                .and_then(|s| CommentId::parse(s).ok());
        }
        // Code blocks (their language, maybe empty) and callouts (their
        // kind), also notes only.
        block::CODE_BLOCK => attrs.code_block = value.and_then(as_str).map(str::to_owned),
        block::CALLOUT => attrs.callout = value.and_then(as_str).map(str::to_owned),
        _ => {
            log::warn!("dr-editor: the paragraph attribute {key:?} is not editable here");
            return Ok(());
        }
    }
    // dr-doc writes only the keys that change.
    txn.set_block_attrs(newline, &attrs)
}
