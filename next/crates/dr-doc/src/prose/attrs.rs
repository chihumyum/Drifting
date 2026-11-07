//! Typed block attributes and inline marks <-> Loro mark values.

use std::collections::BTreeMap;

use dr_model::ProseProfile;
use dr_model::id::{BlockId, CommentId, EmbedId};
use dr_model::kind::{EntityKind, ListKind};
use dr_model::prose::{Align, BlockAttrs, EntityLink, Heading, InlineMarks, MAX_INDENT};
use loro::LoroValue;

use crate::schema::{block, inline};

/// Raw attributes of a delta segment.
pub(crate) type RawAttrs = BTreeMap<String, LoroValue>;

pub(crate) fn raw<'a, I>(attrs: I) -> RawAttrs
where
    I: IntoIterator<Item = (&'a String, &'a LoroValue)>,
{
    attrs
        .into_iter()
        .filter(|(_, v)| !v.is_null())
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
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

fn truthy(v: &LoroValue) -> bool {
    !matches!(v, LoroValue::Null | LoroValue::Bool(false))
}

/// Block id and attributes from the attributes of a `\n`. Attributes the
/// profile does not allow are ignored; damaged values read as absent.
pub(crate) fn decode_block(a: &RawAttrs, profile: ProseProfile) -> (Option<BlockId>, BlockAttrs) {
    let id = a
        .get(block::ID)
        .and_then(as_str)
        .and_then(|s| BlockId::parse(s).ok());
    let mut b = BlockAttrs::default();
    if let Some(v) = a.get(block::HEADING) {
        b.heading = as_i64(v).and_then(Heading::from_level);
    }
    b.quote = a.get(block::QUOTE).is_some_and(truthy);
    if let Some(v) = a.get(block::INDENT).and_then(as_i64) {
        b.indent = v.clamp(0, MAX_INDENT as i64) as u8;
    }
    if let Some(s) = a.get(block::ALIGN).and_then(as_str) {
        b.align = Align::from_stored(s);
    }
    b.rule = a.get(block::RULE).is_some_and(truthy);
    b.list = a.get(block::LIST).and_then(as_str).map(ListKind::parse);
    if let Some(v) = a.get(block::LIST_LEVEL).and_then(as_i64) {
        b.list_level = v.clamp(0, u32::MAX as i64) as u32;
    }
    b.todo = a
        .get(block::TODO)
        .and_then(as_str)
        .and_then(|s| CommentId::parse(s).ok());
    // A task line linked to a TODO has no state of its own: the TODO is the
    // only truth (render `BookView::todo_done`).
    b.checked = b.todo.is_none() && a.get(block::CHECKED).is_some_and(truthy);
    b.code_block = a
        .get(block::CODE_BLOCK)
        .and_then(as_str)
        .map(str::to_string);
    b.callout = a.get(block::CALLOUT).and_then(as_str).map(str::to_string);
    (id, b.restricted_to(profile))
}

/// The stored value of every block key for `attrs` (and `id`); `None` means
/// the key must be absent.
pub(crate) fn encode_block(
    id: Option<&BlockId>,
    b: &BlockAttrs,
) -> Vec<(&'static str, Option<LoroValue>)> {
    let flag = |on: bool| on.then_some(LoroValue::Bool(true));
    vec![
        (block::ID, id.map(|i| LoroValue::from(i.as_str()))),
        (block::HEADING, b.heading.map(|h| LoroValue::I64(h.level()))),
        (block::QUOTE, flag(b.quote)),
        (
            block::INDENT,
            (b.indent > 0).then(|| LoroValue::I64(b.indent.min(MAX_INDENT) as i64)),
        ),
        (block::ALIGN, b.align.as_stored().map(LoroValue::from)),
        (block::RULE, flag(b.rule)),
        (
            block::LIST,
            b.list.as_ref().map(|l| LoroValue::from(l.as_str())),
        ),
        (
            block::LIST_LEVEL,
            (b.list_level > 0).then(|| LoroValue::I64(b.list_level as i64)),
        ),
        (block::CHECKED, flag(b.checked && b.todo.is_none())),
        (
            block::TODO,
            b.todo.as_ref().map(|t| LoroValue::from(t.as_str())),
        ),
        (
            block::CODE_BLOCK,
            b.code_block.as_deref().map(LoroValue::from),
        ),
        (block::CALLOUT, b.callout.as_deref().map(LoroValue::from)),
    ]
}

/// Whether `b` uses note-only attributes.
pub(crate) fn note_only_block(b: &BlockAttrs) -> Option<&'static str> {
    if b.list.is_some() {
        Some("list")
    } else if b.list_level > 0 {
        Some("list_level")
    } else if b.checked {
        Some("checked")
    } else if b.todo.is_some() {
        Some("todo")
    } else if b.code_block.is_some() {
        Some("code_block")
    } else if b.callout.is_some() {
        Some("callout")
    } else {
        None
    }
}

/// Inline marks from the attributes of a non-newline run. Block keys are
/// ignored (a paragraph mark that a concurrent insert left on ordinary
/// characters reads as nothing).
pub(crate) fn decode_inline(a: &RawAttrs, profile: ProseProfile) -> InlineMarks {
    let mut m = InlineMarks::default();
    for (k, v) in a {
        if block::is_block_key(k) {
            continue;
        }
        match k.as_str() {
            inline::BOLD => m.bold = truthy(v),
            inline::ITALIC => m.italic = truthy(v),
            inline::UNDERLINE => m.underline = truthy(v),
            inline::STRIKE => m.strike = truthy(v),
            inline::LINK => m.link = as_str(v).map(str::to_string),
            inline::HIGHLIGHT if profile == ProseProfile::Note => {
                m.highlight = as_str(v).map(str::to_string)
            }
            inline::CODE if profile == ProseProfile::Note => m.code = truthy(v),
            inline::EMBED => m.embed = as_str(v).and_then(|s| EmbedId::parse(s).ok()),
            key => {
                if let Some(target) = inline::entity_target(key)
                    && let Some(link) = decode_entity(target, v)
                {
                    m.entities.push(link);
                }
            }
        }
    }
    m.entities.sort();
    m
}

pub(crate) fn decode_entity(target: &str, v: &LoroValue) -> Option<EntityLink> {
    let LoroValue::Map(map) = v else {
        return None;
    };
    let kind = map
        .get("kind")
        .and_then(as_str)
        .map(EntityKind::parse)
        .unwrap_or(EntityKind::Element);
    let bid = |k: &str| {
        map.get(k)
            .and_then(as_str)
            .and_then(|s| BlockId::parse(s).ok())
    };
    Some(EntityLink {
        target: target.to_string(),
        kind,
        block: bid("block"),
        end_block: bid("end_block"),
    })
}

pub(crate) fn encode_entity(link: &EntityLink) -> LoroValue {
    let mut m: Vec<(String, LoroValue)> = vec![("kind".into(), link.kind.as_str().into())];
    if let Some(b) = &link.block {
        m.push(("block".into(), b.as_str().into()));
    }
    if let Some(b) = &link.end_block {
        m.push(("end_block".into(), b.as_str().into()));
    }
    LoroValue::Map(m.into())
}
