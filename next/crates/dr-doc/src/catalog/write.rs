//! Shared map writers and material-folder operations.
use super::fields::{IntoField, set};
use super::read::CatalogView;
use crate::error::{DocError, Result};
use crate::schema::book_v3 as book;
use dr_model::id::*;
use dr_model::kind::*;
use dr_model::pos::PosKey;
use dr_model::shared::{Asset, EntityRef, KvEntry};
use dr_model::{Day, Timestamp};
use loro::{LoroMap, LoroTree, LoroValue, TreeParentId};
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

pub struct MaterialWriter {
    pub(crate) map: LoroMap,
}
setters!(MaterialWriter {
    title: &str => "title",
    kind: &MaterialKind => "kind",
    asset: Option<&AssetId> => "asset",
    folder: Option<&MaterialFolderId> => "folder",
    pos: &PosKey => "pos",
    task_todos: bool => "task_todos",
    provenance: Option<&str> => "provenance",
});
impl MaterialWriter {
    /// What the material is about (plain text; a minimal diff, so concurrent
    /// edits merge).
    pub fn description(&self, s: &str) -> Result<&Self> {
        set_text(&self.map, "description", s)?;
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

pub struct TreeWriter<'a> {
    view: CatalogView<'a>,
    root: &'static str,
    tree: LoroTree,
}

impl TreeWriter<'_> {
    /// The kept tree node of a domain id.
    fn node(&self, id: &str) -> Result<loro::TreeID> {
        self.view
            .tree_index(self.root)
            .get(id)
            .and_then(|v| v.first().copied())
            .ok_or_else(|| DocError::Missing {
                collection: self.root,
                id: id.to_string(),
            })
    }

    fn parent(&self, parent: Option<&str>) -> Result<TreeParentId> {
        Ok(match parent {
            Some(p) => TreeParentId::Node(self.node(p)?),
            None => TreeParentId::Root,
        })
    }

    /// Create a node (`id` must be new) under `parent`.
    pub fn create(&self, id: &str, parent: Option<&str>, name: &str) -> Result<()> {
        if self.view.tree_index(self.root).contains_key(id) {
            return Err(DocError::Missing {
                collection: self.root,
                id: format!("{id} already exists"),
            });
        }
        let p = self.parent(parent)?;
        self.tree.enable_fractional_index(0);
        let t = self.tree.create(p)?;
        let meta = self.tree.get_meta(t)?;
        meta.insert("id", id)?;
        meta.insert("name", name)?;
        Ok(())
    }

    pub fn rename(&self, id: &str, name: &str) -> Result<()> {
        self.tree.get_meta(self.node(id)?)?.insert("name", name)?;
        Ok(())
    }

    pub fn set_color(&self, id: &str, color: Option<&str>) -> Result<()> {
        set(&self.tree.get_meta(self.node(id)?)?, "color", color)
    }

    /// Move under `parent` (`None`: the root). Loro refuses a cycle, and its
    /// merge never makes one.
    pub fn move_to(&self, id: &str, parent: Option<&str>) -> Result<()> {
        let p = self.parent(parent)?;
        self.tree.enable_fractional_index(0);
        self.tree.mov(self.node(id)?, p)?;
        Ok(())
    }

    /// Delete a node, moving its children up to its parent first (Loro would
    /// delete the whole subtree). Every tree node carrying the id goes, so a
    /// copy made by a concurrent import does not bring it back. Returns the
    /// parent's domain id, for moving the node's members (ideas, materials)
    /// up too.
    fn delete_keep_children(&self, id: &str) -> Result<Option<String>> {
        let forest = super::read::forest(&self.tree);
        let Some(me) = forest.iter().find(|n| n.id == id) else {
            return Err(DocError::Missing {
                collection: self.root,
                id: id.to_string(),
            });
        };
        let parent_id = me.parent.clone();
        let target = match &parent_id {
            Some(p) => match forest
                .iter()
                .find(|n| &n.id == p)
                .and_then(|n| n.tree_ids.first())
            {
                Some(t) => TreeParentId::Node(*t),
                None => TreeParentId::Root,
            },
            None => TreeParentId::Root,
        };
        let copies = me.tree_ids.clone();
        self.tree.enable_fractional_index(0);
        for t in &copies {
            for c in self
                .tree
                .children(TreeParentId::Node(*t))
                .unwrap_or_default()
            {
                if !copies.contains(&c) {
                    self.tree.mov(c, target)?;
                }
            }
        }
        for t in &copies {
            if !self.tree.is_node_deleted(t).unwrap_or(true) {
                self.tree.delete(*t)?;
            }
        }
        Ok(parent_id)
    }
}

impl<'a> CatalogTxn<'a> {
    pub(super) fn entity(&self, root: &str, id: &str) -> Result<LoroMap> {
        Ok(self.view.doc.get_map(root).ensure_mergeable_map(id)?)
    }
    pub fn relation(&mut self, id: &RelationId) -> Result<RelationWriter> {
        Ok(RelationWriter {
            map: self.entity(book::RELATIONS, id.as_str())?,
        })
    }
    pub fn material(&mut self, id: &MaterialId) -> Result<MaterialWriter> {
        Ok(MaterialWriter {
            map: self.entity(book::MATERIALS, id.as_str())?,
        })
    }
    pub fn put_asset(&mut self, a: &Asset) -> Result<()> {
        if let Some(have) = self.view.assets().into_iter().find(|x| x.id == a.id) {
            if &have == a {
                return Ok(());
            }
            return Err(DocError::Locked(format!("asset {}", a.id)));
        }
        let m = self.entity(book::ASSETS, a.id.as_str())?;
        set(&m, "kind", &a.kind)?;
        set(&m, "mime", a.mime.as_str())?;
        set(&m, "size", a.size)?;
        set(&m, "sha256", a.sha256.as_str())?;
        set(&m, "width", a.width)?;
        set(&m, "height", a.height)?;
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
    pub fn writing_day(&mut self, device: &DeviceKey, day: &Day, words: i64) -> Result<()> {
        let key = dr_model::shared::WritingDay::key(device, day);
        self.view
            .doc
            .get_map(book::WRITING_DAYS)
            .insert(&key, words.max(0))?;
        Ok(())
    }
    pub fn material_folders(&mut self) -> TreeWriter<'a> {
        TreeWriter {
            view: self.view,
            root: book::MATERIAL_FOLDERS,
            tree: self.view.tree(book::MATERIAL_FOLDERS),
        }
    }
    pub fn delete_material_folder(&mut self, id: &MaterialFolderId) -> Result<()> {
        let parent = self.material_folders().delete_keep_children(id.as_str())?;
        let parent = parent.and_then(|p| MaterialFolderId::parse(&p).ok());
        for m in self.view.doc.get_map(book::MATERIALS).keys() {
            let map = self.entity(book::MATERIALS, &m)?;
            if matches!(map.get("folder"), Some(loro::ValueOrContainer::Value(LoroValue::String(g))) if g.as_str() == id.as_str())
            {
                set(&map, "folder", parent.as_ref())?;
            }
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
