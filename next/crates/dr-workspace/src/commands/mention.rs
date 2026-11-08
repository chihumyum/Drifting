//! What prose mentions and how it is shaped (M20, the Stats tab;
//! docs/rust-rewrite/modules/m20-stats.md).
//!
//! - `mention.list`: entity links in prose (人物链接 and its siblings) and
//!   embedded materials, read from the derived index: what a document
//!   mentions (out), what mentions an entity (in), or a whole book's. One row
//!   per source, target and kind, with how many paragraphs and separate spans
//!   carry it; only live sources and targets.
//! - `prose.shape`: a prose document's paragraphs, sentences, share of
//!   dialogue (dr-text's `shape`, the 0.1 rules), its checklist and the
//!   materials it embeds, read from the document itself.

use std::collections::HashMap;

use dr_model::id::DocId;
use dr_model::id::DocKind;
use dr_model::kind::ListKind;
use dr_store::index::{RefKind, Reference};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::*;
use crate::dto::Target;
use crate::registry::Registry;
use crate::workspace::BookSlot;

pub(crate) fn register(r: &mut Registry) {
    r.add::<MentionList>().add::<ProseShapeOp>();
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct MentionListIn {
    pub book: String,
    /// Only what this entity's prose mentions (a chapter or idea is
    /// `node`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<Target>,
    /// Only what mentions this entity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<Target>,
    /// Only targets of this kind (`element`, `node`, `material`, …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_kind: Option<String>,
    /// At most this many rows, the most mentioned (a whole book has tens of
    /// thousands).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema)]
pub struct MentionInfo {
    /// The entity whose prose mentions.
    pub from: Target,
    pub to: Target,
    /// `link` (an entity link in the text) or `embed` (an embedded
    /// material).
    pub kind: String,
    /// Paragraphs that carry it.
    pub blocks: u32,
    /// Separate spans (an embed is one).
    pub count: u32,
}

/// The entity a prose document belongs to.
fn owner(doc: &str) -> Option<EntityRef> {
    let d = DocId::parse(doc).ok()?;
    let kind = match d.kind() {
        DocKind::Node => EntityKind::Node,
        DocKind::Element => EntityKind::Element,
        DocKind::Storyline => EntityKind::Storyline,
        DocKind::Category => EntityKind::Category,
        DocKind::Material => EntityKind::Material,
        DocKind::Book | DocKind::Template | DocKind::Conversation => return None,
    };
    Some(EntityRef::new(kind, d.entity_id().to_owned()))
}

/// The prose document of an entity that has one.
fn doc_of(t: &Target) -> Result<String> {
    let prefix = match EntityKind::parse(&t.kind) {
        EntityKind::Node => "node",
        EntityKind::Element => "element",
        EntityKind::Storyline => "storyline",
        EntityKind::Category => "category",
        EntityKind::Material => "material",
        _ => return Err(WsError::invalid(format!("a {} has no prose", t.kind))),
    };
    Ok(format!("{prefix}:{}", t.id))
}

op! {
    MentionList = "mention.list", Read, Shared,
    "List what prose mentions: entity links and embedded materials, from one entity's prose, to one entity, or in the whole book (live ends only, with paragraph and span counts, the most mentioned first; `limit` keeps the top rows).",
    fn(cx, input: MentionListIn) -> Vec<MentionInfo> {
        let slot = cx.book(&input.book)?;
        let lib = cx.workspace().library();
        let rows: Vec<Reference> = match (&input.from, &input.to) {
            (Some(from), _) => lib.references_from(&doc_of(from)?)?,
            (None, Some(to)) => lib.references_to(&to.id)?,
            (None, None) => lib.references_in_book(&input.book)?,
        };
        Ok(group(&slot, &input, &rows))
    }
}

/// `mention.list`'s rows from dr-store's: grouped first on the rows' own
/// strings (no allocation per row), then each group's ends looked up once
/// per entity, and only the rows kept turned into owned values.
fn group(slot: &BookSlot, input: &MentionListIn, rows: &[Reference]) -> Vec<MentionInfo> {
    // (source document, target kind, target id, kind) → (blocks, count).
    let mut grouped: HashMap<(&str, &str, &str, &'static str), (u32, u32)> = HashMap::new();
    for r in rows {
        if r.book_id.as_deref() != Some(input.book.as_str()) || r.kind == RefKind::Mention {
            continue;
        }
        let e = grouped
            .entry((
                r.source_doc.as_str(),
                r.target_kind.as_str(),
                r.target_id.as_str(),
                r.kind.as_str(),
            ))
            .or_default();
        e.0 += 1;
        e.1 += r.count;
    }
    let to_kind = input.to_kind.as_deref().map(EntityKind::parse);
    let only_to = input
        .to
        .as_ref()
        .map(|t| (EntityKind::parse(&t.kind), t.id.as_str()));
    let view = slot.reader.view();
    let mut live: HashMap<(EntityKind, &str), bool> = HashMap::new();
    let mut owners: HashMap<&str, Option<EntityKind>> = HashMap::new();
    // The groups kept, still borrowed: (count, blocks, source document,
    // target kind, target id, kind).
    let mut kept: Vec<(u32, u32, &str, EntityKind, &str, &'static str)> = Vec::new();
    for ((source, target_kind, target_id, kind), (blocks, count)) in grouped {
        let to_k = EntityKind::parse(target_kind);
        if only_to
            .as_ref()
            .is_some_and(|(k, id)| *k != to_k || *id != target_id)
            || to_kind.as_ref().is_some_and(|k| *k != to_k)
        {
            continue;
        }
        let Some(from_k) = owners
            .entry(source)
            .or_insert_with(|| owner(source).map(|o| o.kind))
            .clone()
        else {
            continue;
        };
        if !alive(&mut live, &view, from_k, source_id(source))
            || !alive(&mut live, &view, to_k.clone(), target_id)
        {
            continue;
        }
        kept.push((count, blocks, source, to_k, target_id, kind));
    }
    // Most mentioned first; ties in a fixed order (source document, then
    // target, then kind: a document id is its owner's kind and id).
    kept.sort_unstable_by(|a, b| {
        b.0.cmp(&a.0)
            .then(b.1.cmp(&a.1))
            .then_with(|| (a.2, a.3.as_str(), a.4, a.5).cmp(&(b.2, b.3.as_str(), b.4, b.5)))
    });
    kept.truncate(input.limit.unwrap_or(usize::MAX));
    kept.into_iter()
        .filter_map(|(count, blocks, source, to_k, target_id, kind)| {
            Some(MentionInfo {
                from: Target::from(&owner(source)?),
                to: Target {
                    kind: to_k.as_str().to_owned(),
                    id: target_id.to_owned(),
                },
                kind: kind.to_owned(),
                blocks,
                count,
            })
        })
        .collect()
}

/// Whether `kind`/`id` is live (`is_live`), asked once per entity.
fn alive<'r>(
    live: &mut HashMap<(EntityKind, &'r str), bool>,
    view: &dr_doc::book::BookView<'_>,
    kind: EntityKind,
    id: &'r str,
) -> bool {
    *live
        .entry((kind.clone(), id))
        .or_insert_with(|| view.entity_exists(&EntityRef::new(kind, id.to_owned())))
}

/// The entity id part of a prose document id (`node:<id>` → `<id>`).
fn source_id(doc: &str) -> &str {
    doc.split_once(':').map_or(doc, |(_, id)| id)
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ProseShapeIn {
    /// `node:<id>`, `material:<id>`, …
    pub doc: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema)]
pub struct ProseShapeOut {
    /// Paragraphs that are not blank.
    pub paragraphs: u64,
    /// Sentences (a paragraph with words is at least one).
    pub sentences: u64,
    /// The share of characters inside quotation marks, 0–1.
    pub dialogue: f32,
    /// Checklist items (a note's tasks) and how many are checked.
    pub tasks: u32,
    pub done: u32,
    /// The materials it embeds, in order (repeats kept).
    pub embeds: Vec<String>,
}

op! {
    ProseShapeOp = "prose.shape", Read, Shared,
    "Shape of a prose document: paragraphs, sentences, the share of dialogue, its checklist and the materials it embeds.",
    fn(cx, input: ProseShapeIn) -> ProseShapeOut {
        let doc = DocId::parse(&input.doc).map_err(|e| WsError::invalid(format!("{:?}: {e}", input.doc)))?;
        if doc.profile().is_none() {
            return Err(WsError::invalid(format!("{} is not a prose document", input.doc)));
        }
        let slot = cx.prose(&doc)?;
        let view = cx.prose_view(&slot);
        let mut texts = Vec::new();
        let (mut tasks, mut done) = (0u32, 0u32);
        let mut embeds = Vec::new();
        for p in view.paragraphs() {
            if p.attrs.list == Some(ListKind::Task) {
                tasks += 1;
                done += u32::from(p.attrs.checked);
            }
            if let Some(id) = p.embed()
                && let Some(dr_doc::prose::EmbedView::Material { material: Some(m), .. }) = view.embed(id)
            {
                embeds.push(m.as_str().to_owned());
            }
            texts.push(dr_text::block_text(&view, &p));
        }
        let shape = dr_text::prose_shape(texts.iter().map(String::as_str));
        Ok(ProseShapeOut {
            paragraphs: shape.paragraphs,
            sentences: shape.sentences,
            dialogue: shape.dialogue,
            tasks,
            done,
            embeds,
        })
    }
}
