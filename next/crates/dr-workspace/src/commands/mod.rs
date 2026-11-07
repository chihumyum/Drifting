//! The first batch of commands and queries: the book's structure.
//!
//! Names are `<thing>.<verb>`. Interface and Agent run the same command with
//! the interface's meaning (f1-model-doc.md "界面和 Agent 做法不一样的地方",
//! settled in f3-workspace.md):
//!
//! - deleting moves to the trash and never refuses; side effects wait for
//!   the purge; the result lists what was affected;
//! - a new or renamed chapter, idea, storyline or category gets a ` 2`
//!   suffix when its name is taken, and the result returns the final name;
//!   an element name that is taken is refused (automatic links identify
//!   people by name), except for a placeholder name asked to be numbered.

use std::collections::BTreeMap;
use std::sync::Arc;

use dr_doc::book::BookView;
use dr_model::book::*;
use dr_model::id::NodeId;
use dr_model::kind::EntityKind;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::cache::Key;
use crate::cx::{Cx, EffectAction};
use crate::error::{Result, WsError};
use crate::registry::Registry;
use crate::workspace::BookSlot;

pub mod book;
pub mod chapter;
pub mod comment;
pub mod element;
pub mod history;
pub mod idea;
pub mod material;
pub mod mention;
pub mod patch;
pub mod plot_grid;
pub mod points;
pub mod prose;
pub mod recent;
pub mod relation;
pub mod stats;
pub mod storyline;
pub mod template;
pub mod time_pin;

/// Define an [`crate::Op`].
macro_rules! op {
    (
        $(#[$m:meta])*
        $ty:ident = $name:literal, $access:ident, $conc:ident, $summary:literal,
        fn($cx:ident, $inp:ident: $input:ty) -> $output:ty $body:block
    ) => {
        $(#[$m])*
        pub struct $ty;
        impl $crate::registry::Op for $ty {
            const NAME: &'static str = $name;
            const ACCESS: $crate::registry::Access = $crate::registry::Access::$access;
            const CONCURRENCY: $crate::registry::Concurrency =
                $crate::registry::Concurrency::$conc;
            const SUMMARY: &'static str = $summary;
            type Input = $input;
            type Output = $output;
            #[allow(unused_variables)]
            fn run($cx: &$crate::cx::Cx<'_>, $inp: Self::Input) -> $crate::error::Result<$output> $body
        }
    };
}
pub(crate) use op;

/// Every command and query of this build.
pub(crate) fn register(r: &mut Registry) {
    book::register(r);
    chapter::register(r);
    storyline::register(r);
    element::register(r);
    relation::register(r);
    idea::register(r);
    comment::register(r);
    material::register(r);
    prose::register(r);
    history::register(r);
    points::register(r);
    patch::register(r);
    plot_grid::register(r);
    recent::register(r);
    stats::register(r);
    mention::register(r);
    time_pin::register(r);
    template::register(r);
}

// ---- shared inputs and outputs ------------------------------------------

/// No input.
#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct NoInput {}

/// A book.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct BookIn {
    pub book: String,
}

/// One entity of a book.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct EntityIn {
    pub book: String,
    pub id: String,
}

/// A list query's filter on the trash.
#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct ListIn {
    pub book: String,
    /// Include what is in the trash.
    #[serde(default)]
    pub trashed: bool,
}

/// The entity a command created or renamed, with its final name.
#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct Named {
    pub id: String,
    pub name: String,
}

/// The entity a command changed.
#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct Done {
    pub id: String,
}

// ---- helpers ------------------------------------------------------------

/// `Option<Option<T>>` from JSON: a missing field is `None` (leave it), an
/// explicit `null` is `Some(None)` (clear it), a value is `Some(Some(v))`.
/// Serde alone reads `null` as `None`, which would make "clear" a no-op and
/// break every undo that clears a field.
pub(crate) fn double_option<'de, T, D>(d: D) -> std::result::Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

pub(crate) fn pid<T: std::str::FromStr>(what: &'static str, s: &str) -> Result<T> {
    s.parse()
        .map_err(|_| WsError::invalid(format!("bad {what} id {s:?}")))
}

pub(crate) fn name_ok(s: &str) -> Result<()> {
    dr_model::check::non_empty_name(s)?;
    Ok(())
}

pub(crate) fn now() -> dr_model::Timestamp {
    dr_model::Timestamp::now()
}

/// What storage knows of a prose document without opening it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct ProseFacts {
    /// Its words in the derived index (0 until dr-index reaches it).
    pub words: u64,
    /// Its newest stored change (Unix seconds); `None` before any.
    pub edited_at: Option<i64>,
}

pub(crate) fn prose_facts(lib: &dr_store::Library, doc: &str) -> ProseFacts {
    ProseFacts {
        words: lib.doc_stats(doc).ok().flatten().map_or(0, |s| s.words),
        edited_at: lib.head(doc).ok().flatten().map(|h| h.ts.div_euclid(1000)),
    }
}

pub(crate) fn nodes(slot: &BookSlot) -> Arc<BTreeMap<NodeId, Node>> {
    slot.cache.nodes(&slot.reader.view())
}

/// Live chapters in reading order.
pub(crate) fn chapters(slot: &BookSlot) -> Vec<Node> {
    let mut v: Vec<Node> = nodes(slot)
        .values()
        .filter(|n| n.is_chapter() && !n.is_trashed())
        .cloned()
        .collect();
    v.sort_by(|a, b| dr_model::order::cmp_order((a.book_order, &a.id), (b.book_order, &b.id)));
    v
}

macro_rules! cached {
    ($fn:ident, $key:ident, $ty:ty, $read:ident) => {
        pub(crate) fn $fn(slot: &BookSlot) -> Arc<$ty> {
            slot.cache
                .get(Key::$key, &slot.reader.view(), |v: &BookView<'_>| v.$read())
        }
    };
}
cached!(acts, Acts, Vec<Act>, acts);
cached!(storylines, Storylines, Vec<Storyline>, storylines);
cached!(categories, Categories, Vec<Category>, categories);
cached!(elements, Elements, Vec<Element>, elements);
cached!(
    relation_types,
    RelationTypes,
    Vec<RelationType>,
    relation_types
);
cached!(relations, Relations, Vec<Relation>, relations);
cached!(comments, Comments, Vec<Comment>, comments);
cached!(materials, Materials, Vec<Material>, materials);
cached!(assets, Assets, Vec<Asset>, assets);
cached!(drift_groups, DriftGroups, Vec<DriftGroup>, drift_groups);
cached!(
    material_folders,
    MaterialFolders,
    Vec<MaterialFolder>,
    material_folders
);
cached!(facts, Facts, Vec<KvEntry>, facts);
cached!(memory, Memory, Vec<Memory>, memory);
cached!(meta, Meta, BookMeta, meta);
cached!(time_pins, TimePins, Vec<TimePin>, time_pins);
cached!(patches, Patches, Vec<Patch>, patches);
cached!(relations_raw, RelationsRaw, Vec<Relation>, relations_raw);

/// Whether `r` names a live entity (not in the trash; a patch of an
/// existing element; a comment or material while stored): F1's key lookup
/// (`BookView::entity_exists`) on the holder's document, never a read of a
/// whole collection.
pub(crate) fn is_live(slot: &BookSlot, r: &EntityRef) -> bool {
    slot.reader.view().entity_exists(r)
}

/// Comments whose stored target is `target`, read from the raw entries (no
/// read tolerance needed: only the target fields).
pub(crate) fn comments_on(slot: &BookSlot, target: &EntityRef) -> Vec<dr_model::id::CommentId> {
    let mut out = Vec::new();
    slot.handle.doc().get_map("comments").for_each(|id, v| {
        if let loro::ValueOrContainer::Container(loro::Container::Map(m)) = v {
            let field = |k: &str| match m.get(k) {
                Some(loro::ValueOrContainer::Value(loro::LoroValue::String(s))) => {
                    Some(s.to_string())
                }
                _ => None,
            };
            if field("target").as_deref() == Some(target.id.as_str())
                && field("target_kind").map(|k| EntityKind::parse(&k)) == Some(target.kind.clone())
                && let Ok(cid) = dr_model::id::CommentId::parse(id)
            {
                out.push(cid);
            }
        }
    });
    out.sort();
    out
}

/// Titles of live chapters and ideas (one namespace, as the old client),
/// leaving out `except`.
pub(crate) fn node_titles(slot: &BookSlot, except: Option<&NodeId>) -> Vec<String> {
    nodes(slot)
        .values()
        .filter(|n| !n.is_trashed() && Some(&n.id) != except)
        .map(|n| n.title.clone())
        .collect()
}

/// Report what moving `target` to the trash hides (`trash = true`) or what
/// restoring it shows again: its visible relations, and the comments on it.
pub(crate) fn trash_effects(cx: &Cx<'_>, slot: &BookSlot, target: &EntityRef, trash: bool) {
    // The stored relations touching it whose other end is live: shown now
    // (trash) or shown again (restore).
    let types = relation_types(slot);
    let rels: Vec<Relation> = relations_raw(slot)
        .iter()
        .filter(|r| types.iter().any(|t| t.id == r.relation_type) && r.from != r.to)
        .filter(|r| {
            (&r.from == target && is_live(slot, &r.to))
                || (&r.to == target && is_live(slot, &r.from))
        })
        .cloned()
        .collect();
    for r in rels {
        cx.effect(
            if trash {
                EffectAction::Hidden
            } else {
                EffectAction::Shown
            },
            "relation",
            r.id.as_str(),
            None,
        );
    }
    for c in comments_on(slot, target) {
        cx.effect(
            if trash {
                EffectAction::Unlocated
            } else {
                EffectAction::Shown
            },
            "comment",
            c.as_str(),
            None,
        );
    }
}

/// What purging `target` must also change in the same commit: every stored
/// relation touching it (deleted) and every comment on it (becomes
/// floating). Returns (relation ids, comment ids).
pub(crate) fn purge_fallout(
    slot: &BookSlot,
    target: &EntityRef,
) -> (Vec<dr_model::id::RelationId>, Vec<dr_model::id::CommentId>) {
    let rels = relations_raw(slot)
        .iter()
        .filter(|r| &r.from == target || &r.to == target)
        .map(|r| r.id.clone())
        .collect();
    (rels, comments_on(slot, target))
}

/// Apply [`purge_fallout`] inside the book transaction.
pub(crate) fn apply_fallout(
    txn: &mut dr_doc::book::BookTxn<'_>,
    rels: &[dr_model::id::RelationId],
    cmts: &[dr_model::id::CommentId],
) -> Result<()> {
    for r in rels {
        txn.purge(dr_doc::book::Collection::Relations, r.as_str())?;
    }
    for c in cmts {
        let w = txn.comment(c)?;
        w.target(None)?.target_block(None)?.anchor(None)?;
    }
    Ok(())
}

pub(crate) fn report_fallout(
    cx: &Cx<'_>,
    rels: &[dr_model::id::RelationId],
    cmts: &[dr_model::id::CommentId],
) {
    for r in rels {
        cx.effect(EffectAction::Purged, "relation", r.as_str(), None);
    }
    for c in cmts {
        cx.effect(EffectAction::Detached, "comment", c.as_str(), None);
    }
}

/// The entity `kind` / `id` exists (live) in the book.
pub(crate) fn require_live(slot: &BookSlot, kind: EntityKind, id: &str) -> Result<()> {
    if is_live(slot, &EntityRef::new(kind.clone(), id)) {
        Ok(())
    } else {
        Err(WsError::not_found(
            match kind {
                EntityKind::Node => "node",
                EntityKind::Element => "element",
                EntityKind::Category => "category",
                EntityKind::Storyline => "storyline",
                EntityKind::Patch => "patch",
                EntityKind::Comment => "comment",
                EntityKind::Material => "material",
                EntityKind::Other(_) => "entity",
            },
            id,
        ))
    }
}
