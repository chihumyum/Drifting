//! Field codecs between `dr-model` values and Loro values.

use std::collections::BTreeSet;

use dr_model::book::{BlockSnapshot, EncodedAnchor, EntityRef, KvEntry, MaterialRegion, sort_kv};
use dr_model::id::*;
use dr_model::kind::*;
use dr_model::pos::PosKey;
use dr_model::{Day, Timestamp};
use loro::{LoroMap, LoroValue};

use crate::error::Result;

/// A value that can be written into an entity field. `None` removes the key.
pub trait IntoField {
    fn into_field(self) -> Option<LoroValue>;
}

impl IntoField for &str {
    fn into_field(self) -> Option<LoroValue> {
        Some(self.into())
    }
}
impl IntoField for String {
    fn into_field(self) -> Option<LoroValue> {
        Some(self.into())
    }
}
impl IntoField for &String {
    fn into_field(self) -> Option<LoroValue> {
        Some(self.as_str().into())
    }
}
impl IntoField for f64 {
    fn into_field(self) -> Option<LoroValue> {
        // Non-finite numbers do not round-trip through every reader.
        self.is_finite().then_some(LoroValue::Double(self))
    }
}
impl IntoField for i64 {
    fn into_field(self) -> Option<LoroValue> {
        Some(LoroValue::I64(self))
    }
}
impl IntoField for bool {
    fn into_field(self) -> Option<LoroValue> {
        Some(LoroValue::Bool(self))
    }
}
impl IntoField for Timestamp {
    fn into_field(self) -> Option<LoroValue> {
        Some(LoroValue::I64(self.0))
    }
}
impl<T: IntoField> IntoField for Option<T> {
    fn into_field(self) -> Option<LoroValue> {
        self.and_then(IntoField::into_field)
    }
}
impl IntoField for &PosKey {
    fn into_field(self) -> Option<LoroValue> {
        Some(self.as_str().into())
    }
}
impl IntoField for &[EntityKind] {
    fn into_field(self) -> Option<LoroValue> {
        Some(LoroValue::List(
            self.iter()
                .map(|k| LoroValue::from(k.as_str()))
                .collect::<Vec<_>>()
                .into(),
        ))
    }
}

macro_rules! str_like {
    ($($t:ty),* $(,)?) => {$(
        impl IntoField for &$t {
            fn into_field(self) -> Option<LoroValue> {
                Some(self.as_str().into())
            }
        }
    )*};
}

str_like!(
    ProjectionKind,
    BookId,
    NodeId,
    ActId,
    StorylineId,
    CategoryId,
    ElementId,
    PatchId,
    RelationTypeId,
    RelationId,
    TimePinId,
    CommentId,
    MaterialId,
    AssetId,
    DriftGroupId,
    MaterialFolderId,
    KvEntryId,
    MemoryId,
    EmbedId,
    BlockId,
    PlotRowId,
    PlotColId,
    DeviceKey,
    Day,
    NodeKind,
    NodeStatus,
    EntityKind,
    RelationOrientation,
    SystemRelationKey,
    CategoryLayout,
    CommentKind,
    CommentStatus,
    CommentAuthorKind,
    CommentSource,
    CommentPriority,
    MaterialKind,
    AssetKind,
    MemoryKind,
    MemoryStatus,
    MemorySource,
);

/// Set `key` on `map` to `v` (or remove it).
pub(crate) fn set(map: &LoroMap, key: &str, v: impl IntoField) -> Result<()> {
    match v.into_field() {
        Some(v) => map.insert(key, v)?,
        None => {
            if map.get(key).is_some() {
                map.delete(key)?
            }
        }
    }
    Ok(())
}

/// Read access to one entity's deep value.
#[derive(Clone, Copy)]
pub(crate) struct F<'a>(pub(crate) &'a LoroValue);

impl<'a> F<'a> {
    pub(crate) fn get(&self, key: &str) -> Option<&'a LoroValue> {
        match self.0 {
            LoroValue::Map(m) => m.get(key).filter(|v| !v.is_null()),
            _ => None,
        }
    }

    pub(crate) fn sub(&self, key: &str) -> Option<F<'a>> {
        self.get(key)
            .filter(|v| matches!(v, LoroValue::Map(_)))
            .map(F)
    }

    pub(crate) fn str(&self, key: &str) -> Option<&'a str> {
        match self.get(key)? {
            LoroValue::String(s) => Some(s.as_str()),
            _ => None,
        }
    }

    pub(crate) fn string(&self, key: &str) -> String {
        self.str(key).unwrap_or_default().to_string()
    }

    pub(crate) fn opt_string(&self, key: &str) -> Option<String> {
        self.str(key).map(str::to_string)
    }

    pub(crate) fn f64(&self, key: &str) -> Option<f64> {
        match self.get(key)? {
            LoroValue::Double(d) if d.is_finite() => Some(*d),
            LoroValue::I64(i) => Some(*i as f64),
            _ => None,
        }
    }

    pub(crate) fn i64(&self, key: &str) -> Option<i64> {
        match self.get(key)? {
            LoroValue::I64(i) => Some(*i),
            LoroValue::Double(d) if d.is_finite() && d.fract() == 0.0 => Some(*d as i64),
            _ => None,
        }
    }

    pub(crate) fn bool(&self, key: &str) -> Option<bool> {
        match self.get(key)? {
            LoroValue::Bool(b) => Some(*b),
            _ => None,
        }
    }

    pub(crate) fn ts(&self, key: &str) -> Option<Timestamp> {
        self.i64(key).map(Timestamp)
    }

    pub(crate) fn id<T: for<'s> TryFrom<&'s str>>(&self, key: &str) -> Option<T> {
        self.str(key).and_then(|s| T::try_from(s).ok())
    }

    pub(crate) fn kind<T: for<'s> From<&'s str>>(&self, key: &str) -> Option<T> {
        self.str(key).map(T::from)
    }

    /// Keys of a set field (a mergeable map whose members are keys).
    pub(crate) fn set<T: for<'s> TryFrom<&'s str> + Ord>(&self, key: &str) -> BTreeSet<T> {
        match self.get(key) {
            Some(LoroValue::Map(m)) => m
                .iter()
                .filter(|(_, v)| !matches!(v, LoroValue::Null | LoroValue::Bool(false)))
                .filter_map(|(k, _)| T::try_from(k.as_str()).ok())
                .collect(),
            _ => BTreeSet::new(),
        }
    }

    /// A key/value list field, sorted. Entries with both key and value empty
    /// are left out (the old `kv.ts` dropped them too).
    pub(crate) fn kv(&self, key: &str) -> Vec<KvEntry> {
        match self.get(key) {
            Some(v @ LoroValue::Map(_)) => kv_entries(v),
            _ => Vec::new(),
        }
    }

    /// A position key; a missing or malformed one reads as none (sorts last).
    pub(crate) fn pos(&self, key: &str) -> Option<PosKey> {
        self.str(key).and_then(|s| PosKey::parse(s).ok())
    }

    /// `[{block, text}]` snapshots; malformed entries are skipped.
    pub(crate) fn snapshots(&self, key: &str) -> Vec<BlockSnapshot> {
        match self.get(key) {
            Some(LoroValue::List(l)) => l
                .iter()
                .filter_map(|e| {
                    let e = F(e);
                    Some(BlockSnapshot {
                        block: e.id("block"),
                        text: e.str("text")?.to_string(),
                    })
                })
                .collect(),
            _ => Vec::new(),
        }
    }

    /// A material region; out-of-box or malformed reads as none.
    pub(crate) fn region(&self, key: &str) -> Option<MaterialRegion> {
        let r = self.sub(key)?;
        let page = match r.i64("page") {
            Some(p) if p >= 1 && p <= u32::MAX as i64 => Some(p as u32),
            Some(_) => return None,
            None => None,
        };
        MaterialRegion::new(page, r.f64("x")?, r.f64("y")?, r.f64("w")?, r.f64("h")?)
    }

    pub(crate) fn kinds(&self, key: &str) -> Vec<EntityKind> {
        match self.get(key) {
            Some(LoroValue::List(l)) => l
                .iter()
                .filter_map(|v| match v {
                    LoroValue::String(s) => Some(EntityKind::parse(s)),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        }
    }

    pub(crate) fn anchor(&self, key: &str) -> Option<EncodedAnchor> {
        let a = self.sub(key)?;
        let bin = |k: &str| match a.get(k) {
            Some(LoroValue::Binary(b)) => Some(b.to_vec()),
            _ => None,
        };
        Some(EncodedAnchor {
            start: bin("start")?,
            end: bin("end")?,
        })
    }

    pub(crate) fn entity_ref(&self, kind_key: &str, id_key: &str) -> Option<EntityRef> {
        Some(EntityRef {
            kind: EntityKind::parse(self.str(kind_key)?),
            id: self.str(id_key)?.to_string(),
        })
    }
}

/// Entries of a `{entry id → {key, value, order}}` map value, sorted.
pub(crate) fn kv_entries(v: &LoroValue) -> Vec<KvEntry> {
    let LoroValue::Map(m) = v else {
        return Vec::new();
    };
    let mut out: Vec<KvEntry> = m
        .iter()
        .filter_map(|(id, e)| {
            let f = F(e);
            let key = f.string("key");
            let value = f.string("value");
            if key.is_empty() && value.is_empty() {
                return None;
            }
            Some(KvEntry {
                id: KvEntryId::parse(id).ok()?,
                key,
                value,
                pos: f.pos("pos"),
            })
        })
        .collect();
    sort_kv(&mut out);
    out
}
