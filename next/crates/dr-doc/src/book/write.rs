//! Writing the book document: one typed writer per collection, field by
//! field. Each setter writes one key, so concurrent edits of different fields
//! of one entity both survive, and fields a newer version added are left
//! alone. `None` removes a key. Creating and updating are the same call (the
//! entity map is "get or create", mergeable): commands (F3) decide what a
//! create must set.
//!
//! What a writer refuses is what the data layer can refuse on its own: the
//! built-in relation type, note-only values, malformed keys. Everything that
//! needs the rest of the book (does the element exist? is the name unique?)
//! is the command layer's job, per the invariant checklist.

use dr_model::book::{
    Asset, BlockSnapshot, EntityRef, KvEntry, MaterialRegion, normalize_relation_type_name,
};
use dr_model::id::*;
use dr_model::kind::*;
use dr_model::pos::PosKey;
use dr_model::{Day, Timestamp};
use loro::{LoroMap, LoroTree, LoroValue, TreeParentId};

use super::Collection;
use super::fields::{IntoField, set};
use super::read::{BookView, RepairPlan};
use crate::anchor::Anchor;
use crate::error::{DocError, Result};
use crate::schema::book;

/// An open write on a book document; see `BookDoc::edit`.
pub struct BookTxn<'a> {
    pub(crate) view: BookView<'a>,
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

fn put_kv(map: &LoroMap, list: &str, e: &KvEntry) -> Result<()> {
    let entries = map.ensure_mergeable_map(list)?;
    let m = entries.ensure_mergeable_map(e.id.as_str())?;
    m.insert("key", e.key.as_str())?;
    m.insert("value", e.value.as_str())?;
    set(&m, "pos", e.pos.as_ref())?;
    Ok(())
}

fn remove_kv(map: &LoroMap, list: &str, id: &KvEntryId) -> Result<()> {
    let entries = map.ensure_mergeable_map(list)?;
    if entries.get(id.as_str()).is_some() {
        entries.delete(id.as_str())?;
    }
    Ok(())
}

fn set_member(map: &LoroMap, set_key: &str, member: &str, on: bool) -> Result<()> {
    let s = map.ensure_mergeable_map(set_key)?;
    if on {
        s.insert(member, true)?;
    } else if s.get(member).is_some() {
        s.delete(member)?;
    }
    Ok(())
}

fn put_anchor(map: &LoroMap, key: &str, a: Option<&Anchor>) -> Result<()> {
    match a {
        Some(a) => {
            let e = a.encode();
            let m = map.ensure_mergeable_map(key)?;
            m.insert("start", LoroValue::from(e.start))?;
            m.insert("end", LoroValue::from(e.end))?;
        }
        None => {
            if map.get(key).is_some() {
                map.delete(key)?;
            }
        }
    }
    Ok(())
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

/// Writes `meta`.
pub struct MetaWriter {
    map: LoroMap,
}
setters!(MetaWriter {
    name: &str => "name",
    summary: &str => "summary",
    deleted_at: Option<Timestamp> => "deleted_at",
    created_at: Option<Timestamp> => "created_at",
    /// The book's word target; 0 turns it off, `None` returns to the default.
    word_target: Option<i64> => "word_target",
    /// Words per day; 0 turns it off, `None` returns to the default.
    daily_word_target: Option<i64> => "daily_word_target",
});
impl MetaWriter {
    pub fn put_storyline_template_field(&self, e: &KvEntry) -> Result<&Self> {
        put_kv(&self.map, "storyline_template", e)?;
        Ok(self)
    }
    pub fn remove_storyline_template_field(&self, id: &KvEntryId) -> Result<&Self> {
        remove_kv(&self.map, "storyline_template", id)?;
        Ok(self)
    }
}

/// Writes one chapter or idea.
pub struct NodeWriter {
    map: LoroMap,
}
setters!(NodeWriter {
    kind: &NodeKind => "kind",
    title: &str => "title",
    summary: &str => "summary",
    /// Chapters only; NaN reads as none.
    book_order: Option<f64> => "book_order",
    narrative_order: Option<f64> => "narrative_order",
    status: &NodeStatus => "status",
    /// Ideas only.
    group: Option<&DriftGroupId> => "group",
    x: f64 => "x",
    y: f64 => "y",
    /// Must be one of the node's storylines (readers ignore it otherwise).
    primary_storyline: Option<&StorylineId> => "primary_storyline",
    deleted_at: Option<Timestamp> => "deleted_at",
    created_at: Option<Timestamp> => "created_at",
});
impl NodeWriter {
    pub fn add_storyline(&self, s: &StorylineId) -> Result<&Self> {
        set_member(&self.map, "storylines", s.as_str(), true)?;
        Ok(self)
    }
    pub fn remove_storyline(&self, s: &StorylineId) -> Result<&Self> {
        set_member(&self.map, "storylines", s.as_str(), false)?;
        Ok(self)
    }
}

pub struct ActWriter {
    map: LoroMap,
}
setters!(ActWriter {
    name: &str => "name",
    color: Option<&str> => "color",
    /// `None` is the book-head anchor.
    start_order: Option<f64> => "start_order",
    drift: Option<&NodeId> => "drift",
});

pub struct StorylineWriter {
    map: LoroMap,
}
setters!(StorylineWriter {
    name: &str => "name",
    color: &str => "color",
    summary: &str => "summary",
    pos: &PosKey => "pos",
    chapter_template: Option<&str> => "chapter_template",
    deleted_at: Option<Timestamp> => "deleted_at",
});
impl StorylineWriter {
    pub fn put_fact(&self, e: &KvEntry) -> Result<&Self> {
        put_kv(&self.map, "facts", e)?;
        Ok(self)
    }
    pub fn remove_fact(&self, id: &KvEntryId) -> Result<&Self> {
        remove_kv(&self.map, "facts", id)?;
        Ok(self)
    }
}

pub struct CategoryWriter {
    map: LoroMap,
}
setters!(CategoryWriter {
    name: &str => "name",
    color: &str => "color",
    layout: &CategoryLayout => "layout",
    grid_x: Option<i64> => "grid_x",
    grid_y: Option<i64> => "grid_y",
    element_template: Option<&str> => "element_template",
    deleted_at: Option<Timestamp> => "deleted_at",
});
impl CategoryWriter {
    pub fn put_template_field(&self, e: &KvEntry) -> Result<&Self> {
        put_kv(&self.map, "template_fields", e)?;
        Ok(self)
    }
    pub fn remove_template_field(&self, id: &KvEntryId) -> Result<&Self> {
        remove_kv(&self.map, "template_fields", id)?;
        Ok(self)
    }
}

pub struct ElementWriter {
    map: LoroMap,
}
setters!(ElementWriter {
    name: &str => "name",
    summary: &str => "summary",
    category: Option<&CategoryId> => "category",
    group_name: Option<&str> => "group_name",
    portrait: Option<&AssetId> => "portrait",
    deleted_at: Option<Timestamp> => "deleted_at",
    created_at: Option<Timestamp> => "created_at",
});
impl ElementWriter {
    /// Pin the element in the relation graph at `(x, y)`, or unpin (`None`).
    pub fn relate_pin(&self, pin: Option<(f64, f64)>) -> Result<&Self> {
        set(&self.map, "pin_x", pin.map(|p| p.0))?;
        set(&self.map, "pin_y", pin.map(|p| p.1))?;
        Ok(self)
    }
    /// Aliases are trimmed; an empty alias is ignored.
    pub fn add_alias(&self, alias: &str) -> Result<&Self> {
        let a = alias.trim();
        if !a.is_empty() {
            set_member(&self.map, "aliases", a, true)?;
        }
        Ok(self)
    }
    pub fn remove_alias(&self, alias: &str) -> Result<&Self> {
        set_member(&self.map, "aliases", alias.trim(), false)?;
        Ok(self)
    }
    pub fn put_fact(&self, e: &KvEntry) -> Result<&Self> {
        put_kv(&self.map, "facts", e)?;
        Ok(self)
    }
    pub fn remove_fact(&self, id: &KvEntryId) -> Result<&Self> {
        remove_kv(&self.map, "facts", id)?;
        Ok(self)
    }
}

pub struct PatchWriter {
    map: LoroMap,
}
setters!(PatchWriter {
    /// Set once, when the patch is created.
    element: &ElementId => "element",
    source_node: Option<&NodeId> => "source_node",
    /// Needs `source_node`.
    source_block: Option<&BlockId> => "source_block",
    source_text: Option<&str> => "source_text",
    invalidated_at: Option<Timestamp> => "invalidated_at",
    title: Option<&str> => "title",
    pos: &PosKey => "pos",
});
impl PatchWriter {
    /// Re-anchor; see [`CommentWriter::anchor`].
    pub fn anchor(&self, a: Option<&Anchor>) -> Result<&Self> {
        put_anchor(&self.map, "anchor", a)?;
        Ok(self)
    }
    /// Replace the body text (a minimal diff, so concurrent edits merge).
    pub fn body(&self, s: &str) -> Result<&Self> {
        set_text(&self.map, "body", s)?;
        Ok(self)
    }
}

pub struct RelationTypeWriter {
    map: LoroMap,
}
setters!(RelationTypeWriter {
    description: &str => "description",
    orientation: &RelationOrientation => "orientation",
    source_role: &str => "source_role",
    target_role: &str => "target_role",
    source_kinds: &[EntityKind] => "source_kinds",
    target_kinds: &[EntityKind] => "target_kinds",
    /// Edge colour; `None` returns to the default.
    color: Option<&str> => "color",
});
impl RelationTypeWriter {
    /// Sets the name and its normalized form together.
    pub fn name(&self, name: &str) -> Result<&Self> {
        set(&self.map, "name", name.trim())?;
        set(
            &self.map,
            "normalized_name",
            normalize_relation_type_name(name),
        )?;
        Ok(self)
    }
}

pub struct RelationWriter {
    map: LoroMap,
}
setters!(RelationWriter {
    relation_type: &RelationTypeId => "type",
    created_at: Option<Timestamp> => "created_at",
});
impl RelationWriter {
    /// Both ends at once. For a symmetric type pass them through
    /// [`dr_model::book::canonical_symmetric`] first.
    pub fn ends(&self, from: &EntityRef, to: &EntityRef) -> Result<&Self> {
        set_ref(&self.map, "from_kind", "from", Some(from))?;
        set_ref(&self.map, "to_kind", "to", Some(to))?;
        Ok(self)
    }
}

pub struct TimePinWriter {
    map: LoroMap,
}
setters!(TimePinWriter {
    narrative_order: f64 => "narrative_order",
    label: &str => "label",
    drift: Option<&NodeId> => "drift",
});

pub struct PlotGridWriter {
    pub(super) map: LoroMap,
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

pub struct CommentWriter {
    pub(super) map: LoroMap,
}
setters!(CommentWriter {
    kind: &CommentKind => "kind",
    target_block: Option<&BlockId> => "target_block",
    author_kind: &CommentAuthorKind => "author_kind",
    author: Option<&str> => "author",
    author_name: Option<&str> => "author_name",
    status: &CommentStatus => "status",
    priority: Option<&CommentPriority> => "priority",
    source: &CommentSource => "source",
    metadata: Option<&str> => "metadata",
    /// The selected text, as it was.
    quote: Option<&str> => "quote",
    /// The Agent conversation started from this TODO.
    agent_conversation: Option<&str> => "agent_conversation",
    resolved_at: Option<Timestamp> => "resolved_at",
    created_at: Option<Timestamp> => "created_at",
    updated_at: Option<Timestamp> => "updated_at",
});
impl CommentWriter {
    /// The blocks the selection spanned, as they were. Written once, when the
    /// comment is made.
    pub fn snapshots(&self, snaps: &[BlockSnapshot]) -> Result<&Self> {
        let list: Vec<LoroValue> = snaps
            .iter()
            .map(|s| {
                let mut m: Vec<(String, LoroValue)> = vec![("text".into(), s.text.as_str().into())];
                if let Some(b) = &s.block {
                    m.push(("block".into(), b.as_str().into()));
                }
                LoroValue::Map(m.into())
            })
            .collect();
        self.map.insert("snapshots", LoroValue::List(list.into()))?;
        Ok(self)
    }
    /// A region on an image or a PDF page (`None` removes it).
    pub fn region(&self, r: Option<&MaterialRegion>) -> Result<&Self> {
        match r {
            Some(r) => {
                let mut m: Vec<(String, LoroValue)> = vec![
                    ("x".into(), r.x.into()),
                    ("y".into(), r.y.into()),
                    ("w".into(), r.w.into()),
                    ("h".into(), r.h.into()),
                ];
                if let Some(p) = r.page {
                    m.push(("page".into(), (p as i64).into()));
                }
                self.map.insert("region", LoroValue::Map(m.into()))?;
            }
            None => set(&self.map, "region", None::<&str>)?,
        }
        Ok(self)
    }
    /// Target kind and id together (`None`: a floating comment).
    pub fn target(&self, t: Option<&EntityRef>) -> Result<&Self> {
        set_ref(&self.map, "target_kind", "target", t)?;
        Ok(self)
    }
    /// Re-anchor: the author moved it, or the editor's undo put back
    /// anchored text that had been deleted (F4's `AnchorsChanged`; decode
    /// its bytes with [`Anchor::decode`]). Either is the author's own write
    /// and syncs like any other. Replacement cursors found while resolving go
    /// to [`crate::AnchorCache`], not here.
    pub fn anchor(&self, a: Option<&Anchor>) -> Result<&Self> {
        put_anchor(&self.map, "anchor", a)?;
        Ok(self)
    }
    pub fn body(&self, s: &str) -> Result<&Self> {
        set_text(&self.map, "body", s)?;
        Ok(self)
    }
}

pub struct MaterialWriter {
    map: LoroMap,
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
    map: LoroMap,
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

/// Writes one tree (idea groups or material folders).
pub struct TreeWriter<'a> {
    view: BookView<'a>,
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

impl<'a> BookTxn<'a> {
    pub fn view(&self) -> BookView<'a> {
        self.view
    }

    pub(super) fn entity(&self, root: &str, id: &str) -> Result<LoroMap> {
        Ok(self.view.doc.get_map(root).ensure_mergeable_map(id)?)
    }

    pub fn meta(&mut self) -> MetaWriter {
        MetaWriter {
            map: self.view.doc.get_map(book::META),
        }
    }

    pub fn node(&mut self, id: &NodeId) -> Result<NodeWriter> {
        Ok(NodeWriter {
            map: self.entity(book::NODES, id.as_str())?,
        })
    }

    pub fn act(&mut self, id: &ActId) -> Result<ActWriter> {
        Ok(ActWriter {
            map: self.entity(book::ACTS, id.as_str())?,
        })
    }

    pub fn storyline(&mut self, id: &StorylineId) -> Result<StorylineWriter> {
        Ok(StorylineWriter {
            map: self.entity(book::STORYLINES, id.as_str())?,
        })
    }

    pub fn category(&mut self, id: &CategoryId) -> Result<CategoryWriter> {
        Ok(CategoryWriter {
            map: self.entity(book::CATEGORIES, id.as_str())?,
        })
    }

    pub fn element(&mut self, id: &ElementId) -> Result<ElementWriter> {
        Ok(ElementWriter {
            map: self.entity(book::ELEMENTS, id.as_str())?,
        })
    }

    pub fn patch(&mut self, id: &PatchId) -> Result<PatchWriter> {
        Ok(PatchWriter {
            map: self.entity(book::PATCHES, id.as_str())?,
        })
    }

    /// A user-defined relation type. The built-in, locked one is refused.
    pub fn relation_type(&mut self, id: &RelationTypeId) -> Result<RelationTypeWriter> {
        self.refuse_locked(id)?;
        Ok(RelationTypeWriter {
            map: self.entity(book::RELATION_TYPES, id.as_str())?,
        })
    }

    fn refuse_locked(&self, id: &RelationTypeId) -> Result<()> {
        if self
            .view
            .relation_type(id)
            .is_some_and(|t| t.locked || t.system_key.is_some())
            || id == &super::generic_relation_type_id(self.view.book)
        {
            return Err(DocError::Locked(id.to_string()));
        }
        Ok(())
    }

    pub fn relation(&mut self, id: &RelationId) -> Result<RelationWriter> {
        Ok(RelationWriter {
            map: self.entity(book::RELATIONS, id.as_str())?,
        })
    }

    pub fn time_pin(&mut self, id: &TimePinId) -> Result<TimePinWriter> {
        Ok(TimePinWriter {
            map: self.entity(book::TIME_PINS, id.as_str())?,
        })
    }

    /// The plot grid of `chapter`.
    pub fn plot_grid(&mut self, chapter: &NodeId) -> Result<PlotGridWriter> {
        Ok(PlotGridWriter {
            map: self.entity(book::PLOT_GRIDS, chapter.as_str())?,
        })
    }

    pub fn comment(&mut self, id: &CommentId) -> Result<CommentWriter> {
        Ok(CommentWriter {
            map: self.entity(book::COMMENTS, id.as_str())?,
        })
    }

    /// The TODO generated from prose, written as ordinary changes: a `TODO:`
    /// marker in a chapter (`ProjectionKind::Marker`) or a material-note
    /// task line (`ProjectionKind::NoteTask`) in block `block` of `doc`. Its
    /// id is [`CommentId::for_projection`]. Sets kind, target, block and
    /// projection; the caller sets the body.
    ///
    /// For importing an old library, whose writes are deterministic on their
    /// own (the import peer). A device projecting a marker it found uses
    /// [`Self::project_todo`], which merges with the same projection made on
    /// another device.
    pub fn projected_todo(
        &mut self,
        kind: &ProjectionKind,
        doc: &dr_model::DocId,
        block: &BlockId,
    ) -> Result<(CommentId, CommentWriter)> {
        let target = super::seed::projection_target(doc)?;
        let id = CommentId::for_projection(kind, doc, block);
        let w = self.comment(&id)?;
        w.kind(&CommentKind::Todo)?
            .target(Some(&target))?
            .target_block(Some(block))?;
        set(&w.map, "projection", kind)?;
        set(&w.map, "projection_block", block)?;
        Ok((id, w))
    }

    /// Write back fields of an entity as they were in `old` (read from a
    /// detached copy at a history point, `BookReader::load_at`), as new
    /// changes: the per-entity metadata restore (old
    /// `snapshot-restore.service.ts` `restoreMetadata`). Only `keys` are
    /// touched; sets and key/value lists are made equal to the old ones; a
    /// key missing in `old` is removed. The rest of the book is not reverted.
    pub fn restore_fields(
        &mut self,
        collection: Collection,
        id: &str,
        old: &super::read::EntitySnapshot,
        keys: &[&str],
    ) -> Result<()> {
        if collection.is_tree() || collection == Collection::Meta {
            return Err(DocError::NotInProfile("restore of a tree or meta"));
        }
        if collection == Collection::RelationTypes {
            self.refuse_locked(&RelationTypeId::parse(id).map_err(|_| DocError::Missing {
                collection: book::RELATION_TYPES,
                id: id.to_string(),
            })?)?;
        }
        let map = self.entity(collection.root(), id)?;
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

    pub fn material(&mut self, id: &MaterialId) -> Result<MaterialWriter> {
        Ok(MaterialWriter {
            map: self.entity(book::MATERIALS, id.as_str())?,
        })
    }

    /// Record an asset's metadata. Assets are immutable: a second call for
    /// the same id with different values is refused.
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

    /// A project fact (项目设定).
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

    /// This device's word count for `day`. Each device writes only its own
    /// key, so the last write is always this device's.
    pub fn writing_day(&mut self, device: &DeviceKey, day: &Day, words: i64) -> Result<()> {
        let key = dr_model::book::WritingDay::key(device, day);
        self.view
            .doc
            .get_map(book::WRITING_DAYS)
            .insert(&key, words.max(0))?;
        Ok(())
    }

    pub fn drift_groups(&mut self) -> TreeWriter<'a> {
        TreeWriter {
            view: self.view,
            root: book::DRIFT_GROUPS,
            tree: self.view.tree(book::DRIFT_GROUPS),
        }
    }

    pub fn material_folders(&mut self) -> TreeWriter<'a> {
        TreeWriter {
            view: self.view,
            root: book::MATERIAL_FOLDERS,
            tree: self.view.tree(book::MATERIAL_FOLDERS),
        }
    }

    /// Delete an idea group the way the old client did: its child groups and
    /// its ideas move up to its parent.
    pub fn delete_drift_group(&mut self, id: &DriftGroupId) -> Result<()> {
        let parent = self.drift_groups().delete_keep_children(id.as_str())?;
        let parent = parent.and_then(|p| DriftGroupId::parse(&p).ok());
        for n in self.view.doc.get_map(book::NODES).keys() {
            let map = self.entity(book::NODES, &n)?;
            if matches!(map.get("group"), Some(loro::ValueOrContainer::Value(LoroValue::String(g))) if g.as_str() == id.as_str())
            {
                set(&map, "group", parent.as_ref())?;
            }
        }
        Ok(())
    }

    /// Delete a material folder: sub-folders and materials move up.
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

    /// Delete an entity for good (the id is never reused). The trash is the
    /// `deleted_at` field instead. Trees use `delete_drift_group` /
    /// `delete_material_folder`; the built-in relation type is refused.
    pub fn purge(&mut self, collection: Collection, id: &str) -> Result<()> {
        if collection == Collection::RelationTypes {
            self.refuse_locked(&RelationTypeId::parse(id).map_err(|_| DocError::Missing {
                collection: book::RELATION_TYPES,
                id: id.to_string(),
            })?)?;
        }
        if collection.is_tree() || collection == Collection::Meta {
            return Err(DocError::NotInProfile("purge of a tree or meta"));
        }
        let m = self.view.doc.get_map(collection.root());
        if m.get(id).is_some() {
            m.delete(id)?;
        }
        Ok(())
    }

    /// Apply a [`RepairPlan`] computed from this state.
    pub fn apply_repair(&mut self, plan: &RepairPlan) -> Result<()> {
        for id in &plan.duplicate_relations {
            self.purge(Collection::Relations, id.as_str())?;
        }
        for (id, order) in &plan.chapters_without_order {
            self.node(id)?.book_order(Some(*order))?;
        }
        for id in &plan.drifts_with_order {
            self.node(id)?.book_order(None)?;
        }
        for id in &plan.chapters_in_groups {
            self.node(id)?.group(None)?;
        }
        Ok(())
    }
}

impl IntoField for &&str {
    fn into_field(self) -> Option<LoroValue> {
        Some((*self).into())
    }
}
