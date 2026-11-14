//! Shared map writers for canonical book collections.
use super::fields::{IntoField, set};
use super::read::CatalogView;
use crate::error::{DocError, Result};
use crate::schema::book_v3 as book;
use dr_model::Timestamp;
use dr_model::id::*;
use dr_model::kind::*;
use dr_model::shared::{Asset, EntityRef, KvEntry};
use loro::{LoroMap, LoroValue};
pub(crate) struct CatalogTxn<'a> {
    pub(crate) view: CatalogView<'a>,
}
macro_rules! setters {
    ($w:ident { $( $(#[$m:meta])* $method:ident : $ty:ty => $key:literal ),* $(,)? }) => {
        impl $w {
            $(
                $(#[$m])*
                pub fn $method(&self, v: $ty) -> Result<&Self> {
                    set(&self.map, $key, v)?;
                    Ok(self)
                }
            )*
        }
    };
}

fn set_text(map: &LoroMap, key: &str, s: &str) -> Result<()> {
    let t = map.ensure_mergeable_text(key)?;
    t.update(s, Default::default())
        .map_err(|_| DocError::Loro(loro::LoroError::ArgErr("text update timed out".into())))?;
    Ok(())
}
fn set_ref(map: &LoroMap, kind_key: &str, id_key: &str, r: Option<&EntityRef>) -> Result<()> {
    set(map, kind_key, r.map(|r| &r.kind))?;
    set(map, id_key, r.map(|r| r.id.as_str()))?;
    Ok(())
}
pub struct RelationWriter {
    pub(crate) map: LoroMap,
}
setters!(RelationWriter {
    relation_type: &RelationTypeId => "type",
    created_at: Option<Timestamp> => "created_at",
});
impl RelationWriter {
    /// Both ends at once. For a symmetric type pass them through
    /// [`dr_model::shared::canonical_symmetric`] first.
    pub fn ends(&self, from: &EntityRef, to: &EntityRef) -> Result<&Self> {
        set_ref(&self.map, "from_kind", "from", Some(from))?;
        set_ref(&self.map, "to_kind", "to", Some(to))?;
        Ok(self)
    }
}

pub struct PlotGridWriter {
    pub(crate) map: LoroMap,
}
setters!(PlotGridWriter {
    cell_w: f64 => "cell_w",
    cell_h: f64 => "cell_h",
});
impl PlotGridWriter {
    fn line(&self, which: &str, id: &str, pos: &str, label: &str) -> Result<()> {
        let m = self
            .map
            .ensure_mergeable_map(which)?
            .ensure_mergeable_map(id)?;
        m.insert("pos", pos)?;
        m.insert("label", label)?;
        Ok(())
    }
    pub fn row(&self, id: &PlotRowId, pos: &str, label: &str) -> Result<&Self> {
        self.line("rows", id.as_str(), pos, label)?;
        Ok(self)
    }
    pub fn col(&self, id: &PlotColId, pos: &str, label: &str) -> Result<&Self> {
        self.line("cols", id.as_str(), pos, label)?;
        Ok(self)
    }
    pub fn remove_row(&self, id: &PlotRowId) -> Result<&Self> {
        let m = self.map.ensure_mergeable_map("rows")?;
        if m.get(id.as_str()).is_some() {
            m.delete(id.as_str())?;
        }
        Ok(self)
    }
    pub fn remove_col(&self, id: &PlotColId) -> Result<&Self> {
        let m = self.map.ensure_mergeable_map("cols")?;
        if m.get(id.as_str()).is_some() {
            m.delete(id.as_str())?;
        }
        Ok(self)
    }
    /// Set (or clear with `None`) one cell's text.
    pub fn cell(&self, row: &PlotRowId, col: &PlotColId, text: Option<&str>) -> Result<&Self> {
        let cells = self.map.ensure_mergeable_map("cells")?;
        set(&cells, &format!("{row}/{col}"), text)?;
        Ok(self)
    }
}

pub struct MemoryWriter {
    pub(crate) map: LoroMap,
}
setters!(MemoryWriter {
    kind: &MemoryKind => "kind",
    body: &str => "body",
    target_block: Option<&BlockId> => "target_block",
    source: &MemorySource => "source",
    origin_ref: Option<&str> => "origin_ref",
    status: &MemoryStatus => "status",
    supersedes: Option<&MemoryId> => "supersedes",
    deleted_at: Option<Timestamp> => "deleted_at",
});
impl MemoryWriter {
    pub fn target(&self, t: Option<&EntityRef>) -> Result<&Self> {
        set_ref(&self.map, "target_kind", "target", t)?;
        Ok(self)
    }
}

pub struct AssetWriter {
    pub(crate) map: LoroMap,
}
setters!(AssetWriter {
    name: &str => "name",
    folder: Option<&str> => "folder",
    created_at: Option<Timestamp> => "created_at",
    deleted_at: Option<Timestamp> => "deleted_at",
});

impl CatalogTxn<'_> {
    pub(super) fn entity(&self, root: &str, id: &str) -> Result<LoroMap> {
        Ok(self.view.doc.get_map(root).ensure_mergeable_map(id)?)
    }
    pub fn relation(&mut self, id: &RelationId) -> Result<RelationWriter> {
        Ok(RelationWriter {
            map: self.entity(book::RELATIONS, id.as_str())?,
        })
    }
    pub fn asset(&mut self, id: &AssetId) -> Result<AssetWriter> {
        Ok(AssetWriter {
            map: self.entity(book::ASSETS, id.as_str())?,
        })
    }
    pub fn put_asset(&mut self, a: &Asset) -> Result<()> {
        if let Some(have) = self.view.assets_raw().into_iter().find(|x| x.id == a.id) {
            if have.same_file(a) {
                let m = self.entity(book::ASSETS, a.id.as_str())?;
                if have.name.is_empty() && !a.name.is_empty() {
                    set(&m, "name", a.name.as_str())?;
                }
                if have.created_at.is_none() && a.created_at.is_some() {
                    set(&m, "created_at", a.created_at)?;
                }
                if have.folder.is_none() && a.folder.is_some() {
                    set(&m, "folder", a.folder.as_deref())?;
                }
                if have.is_trashed() && !a.is_trashed() {
                    set(&m, "deleted_at", None::<Timestamp>)?;
                }
                return Ok(());
            }
            return Err(DocError::Locked(format!("asset {}", a.id)));
        }
        let m = self.entity(book::ASSETS, a.id.as_str())?;
        set(&m, "name", a.name.as_str())?;
        set(&m, "kind", &a.kind)?;
        set(&m, "mime", a.mime.as_str())?;
        set(&m, "size", a.size)?;
        set(&m, "sha256", a.sha256.as_str())?;
        set(&m, "width", a.width)?;
        set(&m, "height", a.height)?;
        set(&m, "created_at", a.created_at)?;
        set(&m, "folder", a.folder.as_deref())?;
        set(&m, "deleted_at", a.deleted_at)?;
        Ok(())
    }
    pub fn memory(&mut self, id: &MemoryId) -> Result<MemoryWriter> {
        Ok(MemoryWriter {
            map: self.entity(book::MEMORY, id.as_str())?,
        })
    }
    pub fn put_fact(&mut self, e: &KvEntry) -> Result<()> {
        let m = self
            .view
            .doc
            .get_map(book::FACTS)
            .ensure_mergeable_map(e.id.as_str())?;
        m.insert("key", e.key.as_str())?;
        m.insert("value", e.value.as_str())?;
        set(&m, "pos", e.pos.as_ref())
    }
    pub fn remove_fact(&mut self, id: &KvEntryId) -> Result<()> {
        let m = self.view.doc.get_map(book::FACTS);
        if m.get(id.as_str()).is_some() {
            m.delete(id.as_str())?;
        }
        Ok(())
    }
    pub fn restore_fields(
        &mut self,
        root: &'static str,
        id: &str,
        old: &super::read::EntitySnapshot,
        keys: &[&str],
    ) -> Result<()> {
        let map = self.entity(root, id)?;
        for key in keys {
            match old.value(key) {
                None => set(&map, key, None::<&str>)?,
                Some(LoroValue::Map(want)) if root == book::COMMENTS && *key == "part" => {
                    map.insert(key, LoroValue::Map(want.clone()))?;
                }
                Some(LoroValue::Map(want)) => {
                    // A set or a key/value list: make the members equal.
                    let sub = map.ensure_mergeable_map(key)?;
                    let have: Vec<String> = sub.keys().map(|k| k.to_string()).collect();
                    for k in have {
                        if !want.contains_key(&k) {
                            sub.delete(&k)?;
                        }
                    }
                    for (k, v) in want.iter() {
                        match v {
                            LoroValue::Map(entry) => {
                                let e = sub.ensure_mergeable_map(k)?;
                                for (ek, ev) in entry.iter() {
                                    e.insert(ek, ev.clone())?;
                                }
                            }
                            v => sub.insert(k, v.clone())?,
                        }
                    }
                }
                Some(LoroValue::String(s)) if old.is_text(key) => set_text(&map, key, s)?,
                Some(v) => map.insert(key, v.clone())?,
            }
        }
        Ok(())
    }
}
impl IntoField for &&str {
    fn into_field(self) -> Option<LoroValue> {
        Some((*self).into())
    }
}
