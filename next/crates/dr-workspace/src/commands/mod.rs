//! The canonical registry: generic entries/modules plus shared project, prose,
//! materials, comments, recent visits, statistics and raw history recovery.
//! Every caller uses the same validation and settlement pipeline.

use std::sync::Arc;

use dr_model::shared::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::cx::{Cx, EffectAction};
use crate::error::{Result, WsError};
pub(crate) use crate::guard::Replaces;
use crate::registry::Registry;
use crate::workspace::BookSlot;

pub mod book;
pub mod comment;
mod comment_shared;
pub mod material;
pub mod points;
pub mod prose;
pub mod prose_template;
pub mod recent;
pub mod stats;
pub mod v3;

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
    material::register(r);
    prose::register(r);
    points::register(r);
    stats::register(r);
    r.add::<v3::comment::CommentList>()
        .add::<v3::comment::CommentAnchors>()
        .add::<v3::comment::CommentCreate>()
        .add::<v3::comment::CommentUpdate>()
        .add::<v3::comment::CommentReanchor>()
        .add::<v3::comment::CommentDelete>()
        .add::<v3::comment::TodoProject>()
        .add::<v3::recent::RecentTouch>()
        .add::<v3::recent::RecentList>();
    v3::register(r);
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

/// Record `id` of `collection`, as the key of a write guard.
pub(crate) fn rec(
    collection: dr_doc::v3::CollectionV3,
    id: impl ToString,
) -> dr_doc::v3::RecordKeyV3 {
    dr_doc::v3::RecordKeyV3::record(collection, id.to_string())
}

pub(crate) fn name_ok(s: &str) -> Result<()> {
    dr_model::check::non_empty_name(s)?;
    Ok(())
}

pub(crate) fn now() -> dr_model::Timestamp {
    dr_model::Timestamp::now()
}

/// What storage knows of a prose document without opening it.
pub(crate) fn materials(slot: &BookSlot) -> Arc<Vec<Material>> {
    Arc::new(slot.reader_v3.view().materials())
}
pub(crate) fn assets(slot: &BookSlot) -> Arc<Vec<Asset>> {
    Arc::new(slot.reader_v3.view().assets())
}
pub(crate) fn material_folders(slot: &BookSlot) -> Arc<Vec<MaterialFolder>> {
    Arc::new(slot.reader_v3.view().material_folders())
}
pub(crate) fn relations_raw(slot: &BookSlot) -> Arc<Vec<Relation>> {
    Arc::new(slot.reader_v3.view().relations_raw())
}
pub(crate) fn purge_fallout(
    slot: &BookSlot,
    target: &EntityRef,
) -> (Vec<dr_model::id::RelationId>, Vec<dr_model::id::CommentId>) {
    (
        relations_raw(slot)
            .iter()
            .filter(|r| &r.from == target || &r.to == target)
            .map(|r| r.id.clone())
            .collect(),
        slot.reader_v3
            .view()
            .comments()
            .iter()
            .filter(|c| c.target.as_ref() == Some(target))
            .map(|c| c.id.clone())
            .collect(),
    )
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
