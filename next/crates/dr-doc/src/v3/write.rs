//! Typed writers for a universal kernel v3 book document (`kernel-v3.md`).

use dr_model::id::*;
use dr_model::kind::*;
use dr_model::pos::PosKey;
use dr_model::shared::{
    Asset, BlockSnapshot, EntityRef, KvEntry, MaterialRegion, PLOT_DEFAULT_LINES,
    normalize_relation_type_name,
};
use dr_model::v3::*;
use dr_model::{Day, DocId, Timestamp};
use loro::{
    CommitOptions, ContainerID, ContainerType, ExportMode, LoroDoc, LoroMap, LoroTree, LoroValue,
    TreeID, TreeParentId,
};

use crate::anchor::Anchor;
use crate::catalog::EntitySnapshot;
use crate::catalog::fields::set;
use crate::catalog::read::forest;
use crate::catalog::write::{MaterialWriter, MemoryWriter, PlotGridWriter, RelationWriter};
use crate::error::{DocError, Result};
use crate::peer::seed_peer;
use crate::schema::book_v3;
use crate::v3::CollectionV3;
use crate::v3::read::{BookViewV3, EntrySnapshotV3, RepairPlanV3, TimelineFieldV3};

const TODO_SEED_V3: &str = "todo-v3-1";
const PLOT_GRID_SEED_V3: &str = "plot-grid-v3-1";

const TODO_SEED_KEYS_V3: &[&str] = &[
    "kind",
    "target_kind",
    "target",
    "module",
    "target_block",
    "projection",
    "projection_block",
    "projection_text",
    "status",
];

/// Open transaction on a v3 book document; see [`crate::v3::BookDocV3::edit`].
pub struct BookTxnV3<'a> {
    pub(crate) view: BookViewV3<'a>,
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

pub(crate) fn encode_field_value(val: &FieldValue) -> LoroValue {
    match val {
        FieldValue::Bool(b) => LoroValue::Bool(*b),
        FieldValue::Number(n) => LoroValue::Double(if n.is_finite() { *n } else { 0.0 }),
        FieldValue::Text(s) => LoroValue::from(s.as_str()),
        FieldValue::List(items) => LoroValue::List(
            items
                .iter()
                .map(|s| LoroValue::from(s.as_str()))
                .collect::<Vec<_>>()
                .into(),
        ),
        FieldValue::Null => LoroValue::Null,
    }
}

pub(crate) fn write_level_settings_override(
    map: &LoroMap,
    ov: &LevelSettingsOverride,
) -> Result<()> {
    match &ov.default_template {
        Some(Some(t)) => {
            map.insert("default_template", t.as_str())?;
        }
        Some(None) => {
            map.insert("default_template", LoroValue::Null)?;
        }
        None => {
            if map.get("default_template").is_some() {
                map.delete("default_template")?;
            }
        }
    }
    match &ov.allow {
        Some(list) => {
            let lv = LoroValue::List(
                list.iter()
                    .map(|t| LoroValue::from(t.as_str()))
                    .collect::<Vec<_>>()
                    .into(),
            );
            map.insert("allow", lv)?;
        }
        None => {
            if map.get("allow").is_some() {
                map.delete("allow")?;
            }
        }
    }
    set(map, "display", ov.display.as_ref())?;
    set(map, "auto_link", ov.auto_link)?;
    set(map, "accept", ov.accept)?;
    match &ov.home {
        Some(Some(h)) => {
            map.insert("home", h.as_str())?;
        }
        Some(None) => {
            map.insert("home", LoroValue::Null)?;
        }
        None => {
            if map.get("home").is_some() {
                map.delete("home")?;
            }
        }
    }
    set(map, "is_manuscript", ov.is_manuscript)?;
    set(map, "format_shortcuts", ov.format_shortcuts.as_ref())?;
    Ok(())
}

/// Writes `meta` of a v3 book document.
pub struct MetaWriterV3 {
    map: LoroMap,
}

impl MetaWriterV3 {
    pub fn name(&self, v: &str) -> Result<&Self> {
        set(&self.map, "name", v)?;
        Ok(self)
    }

    pub fn summary(&self, v: &str) -> Result<&Self> {
        set(&self.map, "summary", v)?;
        Ok(self)
    }

    pub fn deleted_at(&self, v: Option<Timestamp>) -> Result<&Self> {
        set(&self.map, "deleted_at", v)?;
        Ok(self)
    }

    pub fn created_at(&self, v: Option<Timestamp>) -> Result<&Self> {
        set(&self.map, "created_at", v)?;
        Ok(self)
    }

    pub fn word_target(&self, v: Option<i64>) -> Result<&Self> {
        set(&self.map, "word_target", v)?;
        Ok(self)
    }

    pub fn daily_word_target(&self, v: Option<i64>) -> Result<&Self> {
        set(&self.map, "daily_word_target", v)?;
        Ok(self)
    }

    pub fn project_template(&self, pt: Option<&ProjectTemplateRef>) -> Result<&Self> {
        match pt {
            Some(pt) => {
                let m = self.map.ensure_mergeable_map("project_template")?;
                set(&m, "id", pt.id.as_str())?;
                set(&m, "version", pt.version)?;
            }
            None => {
                if self.map.get("project_template").is_some() {
                    self.map.delete("project_template")?;
                }
            }
        }
        Ok(self)
    }
}

/// Writes one entry template in `templates`.
pub struct TemplateWriterV3 {
    map: LoroMap,
}

impl TemplateWriterV3 {
    pub fn kind(&self, v: &TemplateKind) -> Result<&Self> {
        set(&self.map, "kind", v)?;
        Ok(self)
    }

    pub fn name(&self, v: &str) -> Result<&Self> {
        set(&self.map, "name", v)?;
        Ok(self)
    }

    pub fn mark(&self, v: Option<&str>) -> Result<&Self> {
        set(&self.map, "mark", v)?;
        Ok(self)
    }

    pub fn color(&self, v: Option<&str>) -> Result<&Self> {
        set(&self.map, "color", v)?;
        Ok(self)
    }

    pub fn agent(&self, cfg: Option<&TemplateAgentConfig>) -> Result<&Self> {
        match cfg {
            Some(cfg) => {
                let m = self.map.ensure_mergeable_map("agent")?;
                set(&m, "name", cfg.name.as_str())?;
                set(&m, "description", cfg.description.as_str())?;
                set(&m, "instructions", cfg.instructions.as_str())?;
            }
            None => {
                if self.map.get("agent").is_some() {
                    self.map.delete("agent")?;
                }
            }
        }
        Ok(self)
    }

    pub fn put_module(&self, spec: &ModuleSpec) -> Result<&Self> {
        let modules = self.map.ensure_mergeable_map("modules")?;
        let m = modules.ensure_mergeable_map(spec.id.as_str())?;
        set(&m, "kind", &spec.kind)?;
        set(&m, "name", spec.name.as_str())?;
        set(&m, "pos", spec.pos.as_ref())?;
        match &spec.agent {
            Some(a) => {
                let am = m.ensure_mergeable_map("agent")?;
                set(&am, "writable", a.writable)?;
                set(&am, "read_tier", a.read_tier.as_deref())?;
                set(&am, "instructions", a.instructions.as_str())?;
            }
            None => {
                if m.get("agent").is_some() {
                    m.delete("agent")?;
                }
            }
        }
        let cfg = m.ensure_mergeable_map("config")?;
        set(&cfg, "show_outline", spec.config.show_outline)?;
        set(&cfg, "task_todos", spec.config.task_todos)?;
        set(&cfg, "aliases_field", spec.config.aliases_field.as_deref())?;
        set(&cfg, "color_field", spec.config.color_field.as_deref())?;
        set(&cfg, "status_field", spec.config.status_field.as_deref())?;
        set(&cfg, "summary_field", spec.config.summary_field.as_deref())?;
        set(
            &cfg,
            "portrait_field",
            spec.config.portrait_field.as_deref(),
        )?;
        set(&cfg, "default_rows", spec.config.default_rows as i64)?;
        set(&cfg, "default_cols", spec.config.default_cols as i64)?;
        let defs_list: Vec<LoroValue> = spec
            .config
            .defs
            .iter()
            .map(|f| {
                let opts = LoroValue::List(
                    f.options
                        .iter()
                        .map(|o| LoroValue::from(o.as_str()))
                        .collect::<Vec<_>>()
                        .into(),
                );
                let mut pairs: Vec<(String, LoroValue)> = vec![
                    ("id".into(), f.id.as_str().into()),
                    ("name".into(), f.name.as_str().into()),
                    ("field_type".into(), f.field_type.as_str().into()),
                    ("options".into(), opts),
                ];
                if let Some(tt) = &f.target_template {
                    pairs.push(("target_template".into(), tt.as_str().into()));
                }
                if let Some(dv) = f
                    .default_value
                    .as_ref()
                    .filter(|v| !matches!(v, FieldValue::Null))
                {
                    pairs.push(("default_value".into(), encode_field_value(dv)));
                }
                if let Some(pos) = &f.pos {
                    pairs.push(("pos".into(), pos.as_str().into()));
                }
                LoroValue::Map(pairs.into())
            })
            .collect();
        cfg.insert("defs", LoroValue::List(defs_list.into()))?;
        let init_kv = cfg.ensure_mergeable_map("initial_kv")?;
        for k in init_kv.keys() {
            init_kv.delete(&k)?;
        }
        for kv in &spec.config.initial_kv {
            put_kv(&cfg, "initial_kv", kv)?;
        }
        Ok(self)
    }

    pub fn remove_module(&self, id: &ModuleId) -> Result<&Self> {
        let modules = self.map.ensure_mergeable_map("modules")?;
        if modules.get(id.as_str()).is_some() {
            modules.delete(id.as_str())?;
        }
        Ok(self)
    }

    pub fn settings(&self, ov: &LevelSettingsOverride) -> Result<&Self> {
        let s = self.map.ensure_mergeable_map("settings")?;
        write_level_settings_override(&s, ov)?;
        Ok(self)
    }

    pub fn lane(&self, v: bool) -> Result<&Self> {
        set(&self.map, "lane", v)?;
        Ok(self)
    }

    pub fn put_verb(&self, verb: &TemplateVerb) -> Result<&Self> {
        let verbs = self.map.ensure_mergeable_map("verbs")?;
        let v = verbs.ensure_mergeable_map(&verb.id)?;
        set(&v, "name", verb.name.as_str())?;
        set(&v, "description", verb.description.as_str())?;
        set(&v, "target_template", verb.target_template.as_ref())?;
        set(&v, "pos", verb.pos.as_ref())?;
        Ok(self)
    }

    pub fn remove_verb(&self, verb_id: &str) -> Result<&Self> {
        let verbs = self.map.ensure_mergeable_map("verbs")?;
        if verbs.get(verb_id).is_some() {
            verbs.delete(verb_id)?;
        }
        Ok(self)
    }

    pub fn deleted_at(&self, v: Option<Timestamp>) -> Result<&Self> {
        set(&self.map, "deleted_at", v)?;
        Ok(self)
    }

    /// Write all fields of `tpl` into this template map.
    pub fn set_full(&self, tpl: &EntryTemplate) -> Result<&Self> {
        self.kind(&tpl.kind)?
            .name(&tpl.name)?
            .mark(tpl.mark.as_deref())?
            .color(tpl.color.as_deref())?
            .agent(tpl.agent.as_ref())?
            .settings(&tpl.settings)?
            .lane(tpl.lane)?
            .deleted_at(tpl.deleted_at)?;
        let modules = self.map.ensure_mergeable_map("modules")?;
        let want_mods: std::collections::HashSet<&str> =
            tpl.modules.iter().map(|m| m.id.as_str()).collect();
        let stale_mods: Vec<String> = modules
            .keys()
            .filter(|k| !want_mods.contains(k.as_ref()))
            .map(|k| k.to_string())
            .collect();
        for k in stale_mods {
            modules.delete(&k)?;
        }
        for m in &tpl.modules {
            self.put_module(m)?;
        }
        let verbs = self.map.ensure_mergeable_map("verbs")?;
        let want_verbs: std::collections::HashSet<&str> =
            tpl.verbs.iter().map(|v| v.id.as_str()).collect();
        let stale_verbs: Vec<String> = verbs
            .keys()
            .filter(|k| !want_verbs.contains(k.as_ref()))
            .map(|k| k.to_string())
            .collect();
        for k in stale_verbs {
            verbs.delete(&k)?;
        }
        for v in &tpl.verbs {
            self.put_verb(v)?;
        }
        Ok(self)
    }
}

/// Writes metadata on one node of the `entries` `LoroTree`.
pub struct EntryWriterV3 {
    pub(crate) map: LoroMap,
}

impl EntryWriterV3 {
    pub fn title(&self, v: &str) -> Result<&Self> {
        set(&self.map, "title", v)?;
        Ok(self)
    }

    pub fn template(&self, v: Option<&EntryTemplateId>) -> Result<&Self> {
        set(&self.map, "template", v)?;
        Ok(self)
    }

    pub fn overrides(&self, ov: Option<&LevelSettingsOverride>) -> Result<&Self> {
        match ov {
            Some(ov) if !ov.is_empty() => {
                let m = self.map.ensure_mergeable_map("overrides")?;
                write_level_settings_override(&m, ov)?;
            }
            _ => {
                if self.map.get("overrides").is_some() {
                    self.map.delete("overrides")?;
                }
            }
        }
        Ok(self)
    }

    pub fn set_field(
        &self,
        module: &ModuleId,
        field_id: &str,
        value: Option<&FieldValue>,
    ) -> Result<&Self> {
        let fields = self.map.ensure_mergeable_map("fields")?;
        let mod_map = fields.ensure_mergeable_map(module.as_str())?;
        match value {
            Some(v) => {
                mod_map.insert(field_id, encode_field_value(v))?;
            }
            None => {
                if mod_map.get(field_id).is_some() {
                    mod_map.delete(field_id)?;
                }
            }
        }
        Ok(self)
    }

    pub fn put_kv(&self, module: &ModuleId, entry: &KvEntry) -> Result<&Self> {
        put_kv(&self.map, &format!("kv:{module}"), entry)?;
        Ok(self)
    }

    pub fn remove_kv(&self, module: &ModuleId, id: &KvEntryId) -> Result<&Self> {
        remove_kv(&self.map, &format!("kv:{module}"), id)?;
        Ok(self)
    }

    pub fn primary(&self, host: Option<&EntryId>) -> Result<&Self> {
        set(&self.map, "primary", host)?;
        Ok(self)
    }

    /// Restore only the stored primary field, including absence/null, without
    /// restoring the entry's title, template, tree position or other metadata.
    pub fn restore_primary(&self, value: Option<&LoroValue>) -> Result<&Self> {
        match value {
            Some(value) => self.map.insert("primary", value.clone())?,
            None if self.map.get("primary").is_some() => self.map.delete("primary")?,
            None => {}
        }
        Ok(self)
    }

    pub fn layout(&self, layout: &EntryLayout) -> Result<&Self> {
        let s = layout.sanitized();
        let m = self.map.ensure_mergeable_map("layout")?;
        set(&m, "board_x", s.board.map(|p| p.0))?;
        set(&m, "board_y", s.board.map(|p| p.1))?;
        set(&m, "grid_x", s.grid.map(|p| p.0))?;
        set(&m, "grid_y", s.grid.map(|p| p.1))?;
        set(&m, "pin_x", s.relation_graph.map(|p| p.0))?;
        set(&m, "pin_y", s.relation_graph.map(|p| p.1))?;
        Ok(self)
    }

    pub fn board_pos(&self, pos: Option<(f64, f64)>) -> Result<&Self> {
        let m = self.map.ensure_mergeable_map("layout")?;
        set(&m, "board_x", pos.map(|p| p.0))?;
        set(&m, "board_y", pos.map(|p| p.1))?;
        Ok(self)
    }

    pub fn grid_pos(&self, pos: Option<(i64, i64)>) -> Result<&Self> {
        let m = self.map.ensure_mergeable_map("layout")?;
        set(&m, "grid_x", pos.map(|p| p.0))?;
        set(&m, "grid_y", pos.map(|p| p.1))?;
        Ok(self)
    }

    pub fn relation_pin(&self, pos: Option<(f64, f64)>) -> Result<&Self> {
        let m = self.map.ensure_mergeable_map("layout")?;
        set(&m, "pin_x", pos.map(|p| p.0))?;
        set(&m, "pin_y", pos.map(|p| p.1))?;
        Ok(self)
    }

    pub fn created_at(&self, v: Option<Timestamp>) -> Result<&Self> {
        set(&self.map, "created_at", v)?;
        Ok(self)
    }

    pub fn updated_at(&self, v: Option<Timestamp>) -> Result<&Self> {
        set(&self.map, "updated_at", v)?;
        Ok(self)
    }

    pub fn deleted_at(&self, v: Option<Timestamp>) -> Result<&Self> {
        set(&self.map, "deleted_at", v)?;
        Ok(self)
    }
}

/// Writes the `entries` `LoroTree`.
pub struct EntriesTreeWriterV3<'a> {
    view: BookViewV3<'a>,
    tree: LoroTree,
}

impl EntriesTreeWriterV3<'_> {
    fn node(&self, id: &EntryId) -> Result<TreeID> {
        self.view
            .tree_index(book_v3::ENTRIES)
            .get(id.as_str())
            .and_then(|v| v.first().copied())
            .ok_or_else(|| DocError::Missing {
                collection: book_v3::ENTRIES,
                id: id.to_string(),
            })
    }

    fn parent(&self, parent: Option<&EntryId>) -> Result<TreeParentId> {
        Ok(match parent {
            Some(p) => TreeParentId::Node(self.node(p)?),
            None => TreeParentId::Root,
        })
    }

    /// Create a new entry at the end of `parent`'s children.
    pub fn create(
        &self,
        id: &EntryId,
        parent: Option<&EntryId>,
        title: &str,
        template: Option<&EntryTemplateId>,
    ) -> Result<EntryWriterV3> {
        if self
            .view
            .tree_index(book_v3::ENTRIES)
            .contains_key(id.as_str())
        {
            return Err(DocError::Missing {
                collection: book_v3::ENTRIES,
                id: format!("{id} already exists"),
            });
        }
        let p = self.parent(parent)?;
        self.tree.enable_fractional_index(0);
        let t = self.tree.create(p)?;
        let meta = self.tree.get_meta(t)?;
        meta.insert("id", id.as_str())?;
        meta.insert("title", title)?;
        set(&meta, "template", template)?;
        Ok(EntryWriterV3 { map: meta })
    }

    /// Create a new entry at `index` among `parent`'s children.
    pub fn create_at(
        &self,
        id: &EntryId,
        parent: Option<&EntryId>,
        index: usize,
        title: &str,
        template: Option<&EntryTemplateId>,
    ) -> Result<EntryWriterV3> {
        if self
            .view
            .tree_index(book_v3::ENTRIES)
            .contains_key(id.as_str())
        {
            return Err(DocError::Missing {
                collection: book_v3::ENTRIES,
                id: format!("{id} already exists"),
            });
        }
        let p = self.parent(parent)?;
        self.tree.enable_fractional_index(0);
        let t = self.tree.create_at(p, index)?;
        let meta = self.tree.get_meta(t)?;
        meta.insert("id", id.as_str())?;
        meta.insert("title", title)?;
        set(&meta, "template", template)?;
        Ok(EntryWriterV3 { map: meta })
    }

    /// Open a writer on an existing entry's metadata.
    pub fn entry(&self, id: &EntryId) -> Result<EntryWriterV3> {
        let t = self.node(id)?;
        let meta = self.tree.get_meta(t)?;
        Ok(EntryWriterV3 { map: meta })
    }

    /// Move `id` to the end of `parent`'s children (`None` = root).
    pub fn move_to(&self, id: &EntryId, parent: Option<&EntryId>) -> Result<()> {
        let p = self.parent(parent)?;
        self.tree.enable_fractional_index(0);
        self.tree.mov(self.node(id)?, p)?;
        Ok(())
    }

    /// Move `id` to `index` among `parent`'s children (`None` = root).
    pub fn move_to_at(&self, id: &EntryId, parent: Option<&EntryId>, index: usize) -> Result<()> {
        let p = self.parent(parent)?;
        let node = self.node(id)?;
        // Replaying an identical import/current order must preserve its tree
        // coordinate. Loro mov_to at the same index can mint a new fraction.
        if self.tree.parent(node) == Some(p)
            && self
                .tree
                .children(p)
                .is_some_and(|children| children.get(index) == Some(&node))
        {
            return Ok(());
        }
        self.tree.enable_fractional_index(0);
        self.tree.mov_to(node, p, index)?;
        Ok(())
    }

    /// Move `id` immediately before sibling `before`.
    pub fn move_before(&self, id: &EntryId, before: &EntryId) -> Result<()> {
        self.tree.enable_fractional_index(0);
        self.tree.mov_before(self.node(id)?, self.node(before)?)?;
        Ok(())
    }

    /// Move `id` immediately after sibling `after`.
    pub fn move_after(&self, id: &EntryId, after: &EntryId) -> Result<()> {
        self.tree.enable_fractional_index(0);
        self.tree.mov_after(self.node(id)?, self.node(after)?)?;
        Ok(())
    }

    /// Permanently delete `id`, lifting its children up to its parent first.
    pub fn delete_keep_children(&self, id: &EntryId) -> Result<Option<EntryId>> {
        let f = forest(&self.tree);
        let Some(me) = f.iter().find(|n| n.id == id.as_str()) else {
            return Err(DocError::Missing {
                collection: book_v3::ENTRIES,
                id: id.to_string(),
            });
        };
        let parent_id = me.parent.as_deref().and_then(|p| EntryId::parse(p).ok());
        let target = match &parent_id {
            Some(p) => match f
                .iter()
                .find(|n| n.id == p.as_str())
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

    /// Permanently delete `id` and its entire subtree from `entries`.
    pub fn purge_subtree(&self, id: &EntryId) -> Result<()> {
        let f = forest(&self.tree);
        let Some(me) = f.iter().find(|n| n.id == id.as_str()) else {
            return Err(DocError::Missing {
                collection: book_v3::ENTRIES,
                id: id.to_string(),
            });
        };
        for t in &me.tree_ids {
            if !self.tree.is_node_deleted(t).unwrap_or(true) {
                self.tree.delete(*t)?;
            }
        }
        Ok(())
    }
}

/// Writes one timeline view in `timeline_views`.
pub struct TimelineViewWriterV3 {
    map: LoroMap,
}

impl TimelineViewWriterV3 {
    /// Restore just the selected path after native/history/CAS preflight via
    /// `BookViewV3::timeline_field_restore_state`. No sibling record is replaced.
    pub fn restore_field(
        &self,
        field: &TimelineFieldV3,
        value: Option<&LoroValue>,
    ) -> Result<&Self> {
        let path = field.path();
        let mut map = self.map.clone();
        for key in &path[..path.len() - 1] {
            if value.is_none() && map.get(key).is_none() {
                return Ok(self);
            }
            map = map.ensure_mergeable_map(key)?;
        }
        restore_raw_field(&map, path[path.len() - 1], value)?;
        Ok(self)
    }

    /// Restore/delete one placement record; all other placements, lanes, pins
    /// and view fields are left alone. Preflight all views with the reader's
    /// `check_timeline_placement_write` before a multi-record mutation.
    pub fn restore_placement(&self, entry: &EntryId, value: Option<&LoroValue>) -> Result<&Self> {
        use loro::{Container, ValueOrContainer};
        let placements = match self.map.get("placements") {
            Some(ValueOrContainer::Container(Container::Map(map))) => map,
            None if value.is_none() => return Ok(self),
            None => self.map.ensure_mergeable_map("placements")?,
            _ => {
                return Err(DocError::NotInProfile(
                    "timeline placements are not a writable map",
                ));
            }
        };
        restore_raw_field(&placements, entry.as_str(), value)?;
        Ok(self)
    }
    pub fn name(&self, v: &str) -> Result<&Self> {
        set(&self.map, "name", v)?;
        Ok(self)
    }

    pub fn pos(&self, v: Option<&PosKey>) -> Result<&Self> {
        set(&self.map, "pos", v)?;
        Ok(self)
    }

    pub fn deleted_at(&self, v: Option<Timestamp>) -> Result<&Self> {
        set(&self.map, "deleted_at", v)?;
        Ok(self)
    }

    pub fn put_lane(&self, entry: &EntryId, pos: Option<&PosKey>) -> Result<&Self> {
        let lanes = self.map.ensure_mergeable_map("lanes")?;
        let l = lanes.ensure_mergeable_map(entry.as_str())?;
        set(&l, "pos", pos)?;
        Ok(self)
    }

    pub fn remove_lane(&self, entry: &EntryId) -> Result<&Self> {
        let lanes = self.map.ensure_mergeable_map("lanes")?;
        if lanes.get(entry.as_str()).is_some() {
            lanes.delete(entry.as_str())?;
        }
        Ok(self)
    }

    pub fn put_placement(&self, entry: &EntryId, at: f64, span: Option<f64>) -> Result<&Self> {
        let placements = self.map.ensure_mergeable_map("placements")?;
        let p = placements.ensure_mergeable_map(entry.as_str())?;
        set(&p, "at", at)?;
        set(&p, "span", span.filter(|s| *s >= 0.0))?;
        Ok(self)
    }

    pub fn remove_placement(&self, entry: &EntryId) -> Result<&Self> {
        let placements = self.map.ensure_mergeable_map("placements")?;
        if placements.get(entry.as_str()).is_some() {
            placements.delete(entry.as_str())?;
        }
        Ok(self)
    }

    pub fn put_pin(&self, pin: &TimelinePin) -> Result<&Self> {
        let pins = self.map.ensure_mergeable_map("pins")?;
        let p = pins.ensure_mergeable_map(pin.id.as_str())?;
        set(&p, "at", pin.at)?;
        set(&p, "label", pin.label.as_str())?;
        set(&p, "color", pin.color.as_deref())?;
        set(&p, "entry", pin.entry.as_ref())?;
        Ok(self)
    }

    pub fn remove_pin(&self, id: &TimePinId) -> Result<&Self> {
        let pins = self.map.ensure_mergeable_map("pins")?;
        if pins.get(id.as_str()).is_some() {
            pins.delete(id.as_str())?;
        }
        Ok(self)
    }
}

/// Writes one v3 patch (`patches` map).
pub struct PatchWriterV3 {
    map: LoroMap,
}

impl PatchWriterV3 {
    pub fn entry(&self, v: &EntryId) -> Result<&Self> {
        set(&self.map, "entry", v)?;
        Ok(self)
    }

    pub fn module(&self, v: &ModuleId) -> Result<&Self> {
        set(&self.map, "module", v)?;
        Ok(self)
    }

    pub fn source_entry(&self, v: Option<&EntryId>) -> Result<&Self> {
        set(&self.map, "source_entry", v)?;
        Ok(self)
    }

    pub fn source_module(&self, v: Option<&ModuleId>) -> Result<&Self> {
        set(&self.map, "source_module", v)?;
        Ok(self)
    }

    pub fn source_block(&self, v: Option<&BlockId>) -> Result<&Self> {
        set(&self.map, "source_block", v)?;
        Ok(self)
    }

    pub fn source_text(&self, v: Option<&str>) -> Result<&Self> {
        set(&self.map, "source_text", v)?;
        Ok(self)
    }

    pub fn invalidated_at(&self, v: Option<Timestamp>) -> Result<&Self> {
        set(&self.map, "invalidated_at", v)?;
        Ok(self)
    }

    pub fn title(&self, v: Option<&str>) -> Result<&Self> {
        set(&self.map, "title", v)?;
        Ok(self)
    }

    pub fn pos(&self, v: &PosKey) -> Result<&Self> {
        set(&self.map, "pos", v)?;
        Ok(self)
    }

    pub fn anchor(&self, a: Option<&Anchor>) -> Result<&Self> {
        put_anchor(&self.map, "anchor", a)?;
        Ok(self)
    }

    pub fn body(&self, s: &str) -> Result<&Self> {
        set_text(&self.map, "body", s)?;
        Ok(self)
    }
}

/// Writes one v3 relation type (`relation_types` map).
pub struct RelationTypeWriterV3 {
    map: LoroMap,
}

impl RelationTypeWriterV3 {
    pub fn name(&self, name: &str) -> Result<&Self> {
        set(&self.map, "name", name.trim())?;
        set(
            &self.map,
            "normalized_name",
            normalize_relation_type_name(name),
        )?;
        Ok(self)
    }

    pub fn description(&self, v: &str) -> Result<&Self> {
        set(&self.map, "description", v)?;
        Ok(self)
    }

    pub fn orientation(&self, v: &RelationOrientation) -> Result<&Self> {
        set(&self.map, "orientation", v)?;
        Ok(self)
    }

    pub fn source_role(&self, v: &str) -> Result<&Self> {
        set(&self.map, "source_role", v)?;
        Ok(self)
    }

    pub fn target_role(&self, v: &str) -> Result<&Self> {
        set(&self.map, "target_role", v)?;
        Ok(self)
    }

    pub fn color(&self, v: Option<&str>) -> Result<&Self> {
        set(&self.map, "color", v)?;
        Ok(self)
    }

    pub fn source_kinds(&self, v: &[EntityKind]) -> Result<&Self> {
        set(&self.map, "source_kinds", v)?;
        Ok(self)
    }

    pub fn target_kinds(&self, v: &[EntityKind]) -> Result<&Self> {
        set(&self.map, "target_kinds", v)?;
        Ok(self)
    }

    pub fn source_templates(&self, v: &[EntryTemplateId]) -> Result<&Self> {
        let lv = LoroValue::List(
            v.iter()
                .map(|t| LoroValue::from(t.as_str()))
                .collect::<Vec<_>>()
                .into(),
        );
        self.map.insert("source_templates", lv)?;
        Ok(self)
    }

    pub fn target_templates(&self, v: &[EntryTemplateId]) -> Result<&Self> {
        let lv = LoroValue::List(
            v.iter()
                .map(|t| LoroValue::from(t.as_str()))
                .collect::<Vec<_>>()
                .into(),
        );
        self.map.insert("target_templates", lv)?;
        Ok(self)
    }
}

/// Writes one v3 comment or TODO (`comments` map).
pub struct CommentWriterV3 {
    pub(crate) map: LoroMap,
}

impl CommentWriterV3 {
    pub fn kind(&self, v: &CommentKind) -> Result<&Self> {
        set(&self.map, "kind", v)?;
        Ok(self)
    }

    pub fn target(&self, t: Option<&EntityRef>) -> Result<&Self> {
        set_ref(&self.map, "target_kind", "target", t)?;
        Ok(self)
    }

    pub fn module(&self, m: Option<&ModuleId>) -> Result<&Self> {
        set(&self.map, "module", m)?;
        Ok(self)
    }

    pub fn target_block(&self, v: Option<&BlockId>) -> Result<&Self> {
        set(&self.map, "target_block", v)?;
        Ok(self)
    }

    pub fn author_kind(&self, v: &CommentAuthorKind) -> Result<&Self> {
        set(&self.map, "author_kind", v)?;
        Ok(self)
    }

    pub fn author(&self, v: Option<&str>) -> Result<&Self> {
        set(&self.map, "author", v)?;
        Ok(self)
    }

    pub fn author_name(&self, v: Option<&str>) -> Result<&Self> {
        set(&self.map, "author_name", v)?;
        Ok(self)
    }

    pub fn status(&self, v: &CommentStatus) -> Result<&Self> {
        set(&self.map, "status", v)?;
        Ok(self)
    }

    pub fn priority(&self, v: Option<&CommentPriority>) -> Result<&Self> {
        set(&self.map, "priority", v)?;
        Ok(self)
    }

    pub fn source(&self, v: &CommentSource) -> Result<&Self> {
        set(&self.map, "source", v)?;
        Ok(self)
    }

    pub fn metadata(&self, v: Option<&str>) -> Result<&Self> {
        set(&self.map, "metadata", v)?;
        Ok(self)
    }

    pub fn quote(&self, v: Option<&str>) -> Result<&Self> {
        set(&self.map, "quote", v)?;
        Ok(self)
    }

    pub fn agent_conversation(&self, v: Option<&str>) -> Result<&Self> {
        set(&self.map, "agent_conversation", v)?;
        Ok(self)
    }

    pub fn resolved_at(&self, v: Option<Timestamp>) -> Result<&Self> {
        set(&self.map, "resolved_at", v)?;
        Ok(self)
    }

    pub fn created_at(&self, v: Option<Timestamp>) -> Result<&Self> {
        set(&self.map, "created_at", v)?;
        Ok(self)
    }

    pub fn updated_at(&self, v: Option<Timestamp>) -> Result<&Self> {
        set(&self.map, "updated_at", v)?;
        Ok(self)
    }

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

    pub fn anchor(&self, a: Option<&Anchor>) -> Result<&Self> {
        put_anchor(&self.map, "anchor", a)?;
        Ok(self)
    }

    pub fn body(&self, s: &str) -> Result<&Self> {
        set_text(&self.map, "body", s)?;
        Ok(self)
    }
}

fn projection_target_v3(doc: &DocId) -> Result<(EntityRef, Option<ModuleId>)> {
    match doc {
        DocId::Body(b) => Ok((
            EntityRef::new(EntityKind::Entry, b.entry().as_str()),
            Some(b.module().clone()),
        )),
        DocId::Material(m) => Ok((EntityRef::new(EntityKind::Material, m.as_str()), None)),
        _ => Err(DocError::NotInProfile(
            "a v3 TODO projected from a document that is not body: or material:",
        )),
    }
}

fn write_todo_v3(
    w: &CommentWriterV3,
    kind: &ProjectionKind,
    doc: &DocId,
    block: &BlockId,
    task: &str,
) -> Result<()> {
    let (target, module) = projection_target_v3(doc)?;
    w.kind(&CommentKind::Todo)?
        .target(Some(&target))?
        .module(module.as_ref())?
        .target_block(Some(block))?
        .status(&CommentStatus::Open)?;
    set(&w.map, "projection", kind)?;
    set(&w.map, "projection_block", block)?;
    w.map.insert("projection_text", task)?;
    Ok(())
}

fn write_default_lines_v3(grid: &LoroMap, entry: &EntryId, module: &ModuleId) -> Result<()> {
    for (key, ids) in [
        (
            "rows",
            (1..=PLOT_DEFAULT_LINES)
                .map(|n| PlotRowId::default_for_entry(entry, module, n).to_string())
                .collect::<Vec<_>>(),
        ),
        (
            "cols",
            (1..=PLOT_DEFAULT_LINES)
                .map(|n| PlotColId::default_for_entry(entry, module, n).to_string())
                .collect(),
        ),
    ] {
        let lines = grid.ensure_mergeable_map(key)?;
        let mut pos = PosKey::first();
        for (i, id) in ids.iter().enumerate() {
            if i > 0 {
                pos = pos.after();
            }
            lines
                .ensure_mergeable_map(id)?
                .insert("pos", pos.as_str())?;
        }
    }
    Ok(())
}

impl<'a> BookTxnV3<'a> {
    pub fn view(&self) -> BookViewV3<'a> {
        self.view
    }

    pub(crate) fn entity(&self, root: &str, id: &str) -> Result<LoroMap> {
        Ok(self.view.doc.get_map(root).ensure_mergeable_map(id)?)
    }

    fn import_seed(&self, key: &str, write: impl FnOnce(&LoroDoc) -> Result<()>) -> Result<()> {
        let seed = LoroDoc::new();
        let doc_id = DocId::Book(self.view.book.clone()).to_string();
        seed.set_peer_id(seed_peer(&doc_id, key))?;
        write(&seed)?;
        seed.commit_with(CommitOptions::new().timestamp(0));
        let bytes = seed.export(ExportMode::all_updates())?;
        self.view.doc.import(&bytes)?;
        Ok(())
    }

    fn detached_entity(&self, root: &str, id: &str) -> Option<LoroMap> {
        let parent = ContainerID::new_root(root, ContainerType::Map);
        self.view
            .doc
            .try_get_map(ContainerID::new_mergeable(&parent, id, ContainerType::Map))
    }

    fn never_written(&self, root: &str, id: &str) -> bool {
        self.detached_entity(root, id).is_none_or(|m| m.is_empty())
    }

    pub fn meta(&mut self) -> MetaWriterV3 {
        MetaWriterV3 {
            map: self.view.doc.get_map(book_v3::META),
        }
    }

    pub fn template(&mut self, id: &EntryTemplateId) -> Result<TemplateWriterV3> {
        Ok(TemplateWriterV3 {
            map: self.entity(book_v3::TEMPLATES, id.as_str())?,
        })
    }

    pub fn entries(&mut self) -> EntriesTreeWriterV3<'a> {
        EntriesTreeWriterV3 {
            view: self.view,
            tree: self.view.tree(book_v3::ENTRIES),
        }
    }

    /// Add or update a membership `(host, member)` in `memberships`.
    pub fn put_membership(
        &mut self,
        host: &EntryId,
        member: &EntryId,
        pos: Option<&PosKey>,
        created_at: Option<Timestamp>,
    ) -> Result<()> {
        let key = Membership::key(host, member);
        let m = self.entity(book_v3::MEMBERSHIPS, &key)?;
        set(&m, "pos", pos)?;
        set(&m, "created_at", created_at)?;
        Ok(())
    }

    /// Remove a membership `(host, member)` from `memberships`.
    pub fn remove_membership(&mut self, host: &EntryId, member: &EntryId) -> Result<()> {
        let key = Membership::key(host, member);
        let m = self.view.doc.get_map(book_v3::MEMBERSHIPS);
        if m.get(&key).is_some() {
            m.delete(&key)?;
        }
        Ok(())
    }

    /// Restore only one original membership record (including unknown data).
    pub fn restore_membership_snapshot(
        &mut self,
        host: &EntryId,
        member: &EntryId,
        old: Option<&EntrySnapshotV3>,
    ) -> Result<()> {
        restore_raw_field(
            &self.view.doc.get_map(book_v3::MEMBERSHIPS),
            &Membership::key(host, member),
            old.map(|s| &s.value),
        )
    }

    pub fn timeline_view(&mut self, id: &TimelineViewId) -> Result<TimelineViewWriterV3> {
        Ok(TimelineViewWriterV3 {
            map: self.entity(book_v3::TIMELINE_VIEWS, id.as_str())?,
        })
    }

    pub fn patch(&mut self, id: &PatchId) -> Result<PatchWriterV3> {
        Ok(PatchWriterV3 {
            map: self.entity(book_v3::PATCHES, id.as_str())?,
        })
    }

    pub fn plot_grid(&mut self, entry: &EntryId, module: &ModuleId) -> Result<PlotGridWriter> {
        let key = PlotGridV3::key(entry, module);
        Ok(PlotGridWriter {
            map: self.entity(book_v3::PLOT_GRIDS, &key)?,
        })
    }

    /// Create `(entry, module)`'s plot grid with 3 default rows and 3 default
    /// columns as a deterministic seed change.
    pub fn create_plot_grid(
        &mut self,
        entry: &EntryId,
        module: &ModuleId,
    ) -> Result<PlotGridWriter> {
        let grid_key = PlotGridV3::key(entry, module);
        let live = self
            .view
            .doc
            .get_map(book_v3::PLOT_GRIDS)
            .get(&grid_key)
            .is_some();
        if !live && self.never_written(book_v3::PLOT_GRIDS, &grid_key) {
            let seed_key = format!("{PLOT_GRID_SEED_V3}\0{grid_key}\0{PLOT_DEFAULT_LINES}");
            self.import_seed(&seed_key, |seed| {
                let grid = seed
                    .get_map(book_v3::PLOT_GRIDS)
                    .ensure_mergeable_map(&grid_key)?;
                write_default_lines_v3(&grid, entry, module)
            })?;
        }
        self.plot_grid(entry, module)
    }

    fn refuse_locked(&self, id: &RelationTypeId) -> Result<()> {
        if self
            .view
            .relation_type(id)
            .is_some_and(|t| t.locked || t.system_key.is_some())
            || id == &crate::catalog::generic_relation_type_id(self.view.book)
        {
            return Err(DocError::Locked(id.to_string()));
        }
        Ok(())
    }

    pub fn relation_type(&mut self, id: &RelationTypeId) -> Result<RelationTypeWriterV3> {
        self.refuse_locked(id)?;
        Ok(RelationTypeWriterV3 {
            map: self.entity(book_v3::RELATION_TYPES, id.as_str())?,
        })
    }

    pub fn relation(&mut self, id: &RelationId) -> Result<RelationWriter> {
        crate::catalog::write::CatalogTxn {
            view: crate::catalog::read::CatalogView { doc: self.view.doc },
        }
        .relation(id)
    }

    pub fn comment(&mut self, id: &CommentId) -> Result<CommentWriterV3> {
        Ok(CommentWriterV3 {
            map: self.entity(book_v3::COMMENTS, id.as_str())?,
        })
    }

    /// Project a TODO from a marker or task line in `doc` (`body:<entry>/<module>`
    /// or `material:<id>`) as a deterministic seed change.
    pub fn project_todo(
        &mut self,
        kind: &ProjectionKind,
        doc: &DocId,
        block: &BlockId,
        task: &str,
    ) -> Result<(CommentId, CommentWriterV3)> {
        projection_target_v3(doc)?;
        let id = CommentId::for_projection(kind, doc, block);
        let live = self
            .view
            .doc
            .get_map(book_v3::COMMENTS)
            .get(id.as_str())
            .is_some();
        if !live {
            if self.never_written(book_v3::COMMENTS, id.as_str()) {
                let key = format!("{TODO_SEED_V3}\0{id}\0{doc}\0{block}\0{task}");
                self.import_seed(&key, |seed| {
                    let map = seed
                        .get_map(book_v3::COMMENTS)
                        .ensure_mergeable_map(id.as_str())?;
                    write_todo_v3(&CommentWriterV3 { map }, kind, doc, block, task)
                })?;
            }
            let seeded = self
                .detached_entity(book_v3::COMMENTS, id.as_str())
                .is_some_and(|m| m.get("projection").is_some())
                && self
                    .view
                    .doc
                    .get_map(book_v3::COMMENTS)
                    .get(id.as_str())
                    .is_some();
            if !seeded {
                let w = self.comment(&id)?;
                let stale: Vec<String> = w
                    .map
                    .keys()
                    .map(|k| k.to_string())
                    .filter(|k| !TODO_SEED_KEYS_V3.contains(&k.as_str()))
                    .collect();
                for k in &stale {
                    w.map.delete(k)?;
                }
                write_todo_v3(&w, kind, doc, block, task)?;
            }
        }
        Ok((id.clone(), self.comment(&id)?))
    }

    /// Write a projected TODO as ordinary changes (for deterministic imports).
    pub fn projected_todo(
        &mut self,
        kind: &ProjectionKind,
        doc: &DocId,
        block: &BlockId,
    ) -> Result<(CommentId, CommentWriterV3)> {
        let (target, module) = projection_target_v3(doc)?;
        let id = CommentId::for_projection(kind, doc, block);
        let w = self.comment(&id)?;
        w.kind(&CommentKind::Todo)?
            .target(Some(&target))?
            .module(module.as_ref())?
            .target_block(Some(block))?;
        set(&w.map, "projection", kind)?;
        set(&w.map, "projection_block", block)?;
        Ok((id, w))
    }

    pub fn material(&mut self, id: &MaterialId) -> Result<MaterialWriter> {
        crate::catalog::write::CatalogTxn {
            view: crate::catalog::read::CatalogView { doc: self.view.doc },
        }
        .material(id)
    }

    pub fn put_asset(&mut self, a: &Asset) -> Result<()> {
        crate::catalog::write::CatalogTxn {
            view: crate::catalog::read::CatalogView { doc: self.view.doc },
        }
        .put_asset(a)
    }

    pub fn memory(&mut self, id: &MemoryId) -> Result<MemoryWriter> {
        crate::catalog::write::CatalogTxn {
            view: crate::catalog::read::CatalogView { doc: self.view.doc },
        }
        .memory(id)
    }

    pub fn put_fact(&mut self, e: &KvEntry) -> Result<()> {
        crate::catalog::write::CatalogTxn {
            view: crate::catalog::read::CatalogView { doc: self.view.doc },
        }
        .put_fact(e)
    }

    pub fn remove_fact(&mut self, id: &KvEntryId) -> Result<()> {
        crate::catalog::write::CatalogTxn {
            view: crate::catalog::read::CatalogView { doc: self.view.doc },
        }
        .remove_fact(id)
    }

    pub fn writing_day(&mut self, device: &DeviceKey, day: &Day, words: i64) -> Result<()> {
        crate::catalog::write::CatalogTxn {
            view: crate::catalog::read::CatalogView { doc: self.view.doc },
        }
        .writing_day(device, day, words)
    }

    pub fn material_folders(&mut self) -> crate::catalog::write::TreeWriter<'a> {
        crate::catalog::write::CatalogTxn {
            view: crate::catalog::read::CatalogView { doc: self.view.doc },
        }
        .material_folders()
    }

    pub fn delete_material_folder(&mut self, id: &MaterialFolderId) -> Result<()> {
        crate::catalog::write::CatalogTxn {
            view: crate::catalog::read::CatalogView { doc: self.view.doc },
        }
        .delete_material_folder(id)
    }

    /// Restore an entry's metadata (`title`, `template`, `primary`, timestamps,
    /// `layout`, `overrides`, `fields`, and all `kv:<module_id>` tables) from
    /// `old` (`BookViewV3::entry_snapshot`).
    pub fn restore_entry(&mut self, id: &EntryId, old: &EntrySnapshotV3) -> Result<()> {
        let w = match self.entries().entry(id) {
            Ok(w) => w,
            Err(_) => self.entries().create(id, None, "", None)?,
        };
        let map = &w.map;

        for scalar_key in [
            "title",
            "template",
            "primary",
            "created_at",
            "updated_at",
            "deleted_at",
        ] {
            match old.field(scalar_key) {
                Some(v) => map.insert(scalar_key, v.clone())?,
                None => set(map, scalar_key, None::<&str>)?,
            }
        }

        // Restore `layout`
        match old.field("layout") {
            Some(LoroValue::Map(want)) => {
                let sub = map.ensure_mergeable_map("layout")?;
                sync_nested_map(&sub, want)?;
            }
            _ => {
                if map.get("layout").is_some() {
                    map.delete("layout")?;
                }
            }
        }

        // Restore `overrides`
        match old.field("overrides") {
            Some(LoroValue::Map(want)) => {
                let sub = map.ensure_mergeable_map("overrides")?;
                sync_nested_map(&sub, want)?;
            }
            _ => {
                if map.get("overrides").is_some() {
                    map.delete("overrides")?;
                }
            }
        }

        // Restore `fields` (`module_id -> { field_id -> value }`)
        match old.field("fields") {
            Some(LoroValue::Map(want_mods)) => {
                let fields_map = map.ensure_mergeable_map("fields")?;
                let have_mods: Vec<String> = fields_map.keys().map(|k| k.to_string()).collect();
                for m in have_mods {
                    if !want_mods.contains_key(&m) {
                        fields_map.delete(&m)?;
                    }
                }
                for (m, mv) in want_mods.iter() {
                    if let LoroValue::Map(want_fields) = mv {
                        let sub = fields_map.ensure_mergeable_map(m)?;
                        sync_nested_map(&sub, want_fields)?;
                    }
                }
            }
            _ => {
                if map.get("fields").is_some() {
                    map.delete("fields")?;
                }
            }
        }

        // Restore all `kv:<module_id>` maps
        let have_kv_keys: Vec<String> = map
            .keys()
            .filter(|k| k.starts_with("kv:"))
            .map(|k| k.to_string())
            .collect();
        let want_kv_keys: Vec<String> = old
            .keys()
            .into_iter()
            .filter(|k| k.starts_with("kv:"))
            .collect();
        for k in &have_kv_keys {
            if !want_kv_keys.contains(k) {
                map.delete(k)?;
            }
        }
        for k in &want_kv_keys {
            if let Some(LoroValue::Map(want_rows)) = old.field(k) {
                let sub = map.ensure_mergeable_map(k)?;
                sync_nested_map(&sub, want_rows)?;
            }
        }
        Ok(())
    }

    /// Restore raw entry metadata and owned records from a historical view of
    /// this document. Applies scoped CRDT diffs, preserving container types,
    /// unknown nested data and rich-text attributes. Never restores shared
    /// templates, other entries or timeline views. The caller validates tree
    /// placement and record ownership first; parent/order remain its plan.
    pub fn restore_entry_owned_at(&mut self, id: &EntryId, old: &BookViewV3<'_>) -> Result<()> {
        use loro::{
            ContainerTrait, ValueOrContainer,
            event::{Diff, DiffBatch},
        };
        use std::collections::{BTreeMap, BTreeSet, HashSet};
        let mut ancestors = HashSet::new();
        let mut selected: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        for view in [self.view, *old] {
            let node = view
                .tree_index(book_v3::ENTRIES)
                .get(id.as_str())
                .and_then(|nodes| nodes.first().copied())
                .ok_or_else(|| DocError::Missing {
                    collection: book_v3::ENTRIES,
                    id: id.to_string(),
                })?;
            ancestors.insert(view.doc.get_tree(book_v3::ENTRIES).get_meta(node)?.id());
            for (collection, rows) in view.entry_owned_records(id) {
                for key in rows.keys() {
                    selected
                        .entry(collection.root().to_owned())
                        .or_default()
                        .insert(key.clone());
                }
            }
        }
        for view in [self.view, *old] {
            for (root, keys) in &selected {
                let map = view.doc.get_map(root.as_str());
                for key in keys {
                    if let Some(ValueOrContainer::Container(c)) = map.get(key) {
                        ancestors.insert(c.id());
                    }
                }
            }
        }
        let diff = self
            .view
            .doc
            .diff(&self.view.doc.oplog_frontiers(), &old.doc.state_frontiers())?;
        let mut scoped = DiffBatch::default();
        scoped.set_full_state(diff.is_full_state());
        for (cid, change) in diff.iter() {
            if let ContainerID::Root { name, .. } = cid
                && let Some(keys) = selected.get(name.as_str())
            {
                if let Diff::Map(mut map) = change.clone() {
                    map.updated.retain(|key, _| keys.contains(key.as_ref()));
                    if !map.updated.is_empty() {
                        scoped
                            .push(cid.clone(), Diff::Map(map))
                            .expect("unique diff container");
                    }
                }
                continue;
            }
            let belongs = ancestors.contains(cid)
                || [self.view.doc, old.doc].iter().any(|doc| {
                    doc.get_path_to_container(cid).is_some_and(|path| {
                        path.iter().any(|(parent, _)| ancestors.contains(parent))
                    })
                });
            if belongs {
                if matches!(change, Diff::Unknown) {
                    return Err(DocError::NotInProfile(
                        "history contains an unsupported CRDT container",
                    ));
                }
                scoped
                    .push(cid.clone(), change.clone())
                    .expect("unique diff container");
            }
        }
        self.view.doc.apply_diff(scoped)?;
        Ok(())
    }

    /// Restore selected shared records from their real historical containers.
    /// A detached replay validates the entire diff and raw state before the
    /// live document changes; deep-value reconstruction would flatten future
    /// fields, atomic maps, rich text and list identities.
    pub fn restore_shared_records_at(
        &mut self,
        records: &[(CollectionV3, String)],
        old: &BookViewV3<'_>,
    ) -> Result<()> {
        use loro::{
            Container, ContainerTrait, ValueOrContainer,
            event::{Diff, DiffBatch},
        };
        use std::collections::{BTreeMap, BTreeSet, HashSet};
        let mut selected: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
        let mut ancestors = HashSet::new();
        for (collection, id) in records {
            if !matches!(
                collection,
                CollectionV3::Facts | CollectionV3::Memory | CollectionV3::Relations
            ) {
                return Err(DocError::NotInProfile("not a shared history record"));
            }
            selected.entry(collection.root()).or_default().insert(id);
            for view in [self.view, *old] {
                match view.doc.get_map(collection.root()).get(id) {
                    Some(ValueOrContainer::Container(Container::Map(map))) => {
                        ancestors.insert(map.id());
                    }
                    None => {}
                    Some(_) => {
                        return Err(DocError::NotInProfile("shared history record is not a map"));
                    }
                }
            }
        }
        let diff = self
            .view
            .doc
            .diff(&self.view.doc.oplog_frontiers(), &old.doc.state_frontiers())?;
        let mut scoped = DiffBatch::default();
        scoped.set_full_state(diff.is_full_state());
        for (cid, change) in diff.iter() {
            if let ContainerID::Root { name, .. } = cid
                && let Some(keys) = selected.get(name.as_str())
            {
                if let Diff::Map(mut map) = change.clone() {
                    map.updated.retain(|key, _| keys.contains(key.as_ref()));
                    if !map.updated.is_empty() {
                        scoped
                            .push(cid.clone(), Diff::Map(map))
                            .expect("unique diff container");
                    }
                }
                continue;
            }
            if ancestors.contains(cid)
                || [self.view.doc, old.doc].iter().any(|doc| {
                    doc.get_path_to_container(cid).is_some_and(|path| {
                        path.iter().any(|(parent, _)| ancestors.contains(parent))
                    })
                })
            {
                if matches!(change, Diff::Unknown) {
                    return Err(DocError::NotInProfile(
                        "shared history contains an unsupported CRDT container",
                    ));
                }
                scoped
                    .push(cid.clone(), change.clone())
                    .expect("unique diff container");
            }
        }
        // Applying a tree diff can allocate new node identities. Verify the
        // real result on a detached copy, never after a partial live write.
        let probe = loro::LoroDoc::new();
        probe.config_text_style(crate::schema::style_config());
        probe.import(&self.view.doc.export(loro::ExportMode::Snapshot)?)?;
        probe.apply_diff(scoped.clone())?;
        for (collection, id) in records {
            let raw = |doc: &loro::LoroDoc| {
                doc.get_map(collection.root())
                    .get(id)
                    .map(super::raw::raw_value)
            };
            if raw(&probe) != raw(old.doc) {
                return Err(DocError::NotInProfile(
                    "shared history cannot preserve retained container identities",
                ));
            }
        }
        self.view.doc.apply_diff(scoped)?;
        Ok(())
    }

    /// Append an immutable complete-entry checkpoint. The manifest is versioned
    /// by its owner in dr-workspace and references durable Loro frontiers.
    pub fn put_entry_checkpoint(&mut self, id: &str, manifest: &str) -> Result<()> {
        let root = self.view.doc.get_map("entry_checkpoints");
        if root.get(id).is_some() {
            return Err(DocError::NotInProfile("checkpoint already exists"));
        }
        root.insert(id, manifest)?;
        Ok(())
    }

    /// Remove a checkpoint selected by the owner's retention plan. Manifests
    /// are never replaced; complete history remains in the Loro log.
    pub fn remove_entry_checkpoint(&mut self, id: &str) -> Result<()> {
        self.view.doc.get_map("entry_checkpoints").delete(id)?;
        Ok(())
    }

    /// Restore an entry's metadata and tree parent (falling back to root if
    /// `parent` no longer exists in `entries`).
    pub fn restore_entry_with_parent(
        &mut self,
        id: &EntryId,
        parent: Option<&EntryId>,
        old: &EntrySnapshotV3,
    ) -> Result<()> {
        let target_parent =
            parent.filter(|p| self.view.entry(p).is_some() && p.as_str() != id.as_str());
        if self.view.entry(id).is_some() {
            if self.view.entry(id).and_then(|e| e.parent).as_ref() != target_parent {
                self.entries().move_to(id, target_parent)?;
            }
        } else {
            self.entries().create(id, target_parent, "", None)?;
        }
        self.restore_entry(id, old)
    }

    /// Restore a folder's metadata and parent without changing unselected children.
    pub fn restore_material_folder(
        &mut self,
        id: &MaterialFolderId,
        parent: Option<&MaterialFolderId>,
        old: &EntrySnapshotV3,
    ) -> Result<()> {
        let LoroValue::Map(want) = &old.value else {
            return Err(DocError::NotInProfile("folder snapshot is not a map"));
        };
        if self.view.material_folder_snapshot(id).is_some() {
            self.material_folders()
                .move_to(id.as_str(), parent.map(|p| p.as_str()))?;
        } else {
            self.material_folders()
                .create(id.as_str(), parent.map(|p| p.as_str()), "")?;
        }
        let tree = self.view.doc.get_tree(book_v3::MATERIAL_FOLDERS);
        let node = self.view.tree_index(book_v3::MATERIAL_FOLDERS)[id.as_str()][0];
        sync_record(&tree.get_meta(node)?, want, None)
    }

    /// Restore the selected folder's order relative to surviving historical siblings.
    pub fn move_material_folder_to_at(
        &mut self,
        id: &MaterialFolderId,
        parent: Option<&MaterialFolderId>,
        index: usize,
    ) -> Result<()> {
        let nodes = self.view.tree_index(book_v3::MATERIAL_FOLDERS);
        let node = |id: &MaterialFolderId| {
            nodes
                .get(id.as_str())
                .and_then(|ids| ids.first())
                .copied()
                .ok_or_else(|| DocError::Missing {
                    collection: book_v3::MATERIAL_FOLDERS,
                    id: id.to_string(),
                })
        };
        let p = parent
            .map(node)
            .transpose()?
            .map_or(TreeParentId::Root, TreeParentId::Node);
        let tree = self.view.doc.get_tree(book_v3::MATERIAL_FOLDERS);
        tree.enable_fractional_index(0);
        tree.mov_to(node(id)?, p, index)?;
        Ok(())
    }

    /// Restore one structural v3 record, keeping mergeable nested map identities.
    pub fn restore_map_snapshot(
        &mut self,
        collection: CollectionV3,
        id: &str,
        old: Option<&EntrySnapshotV3>,
    ) -> Result<()> {
        if !matches!(
            collection,
            CollectionV3::Templates
                | CollectionV3::Memberships
                | CollectionV3::TimelineViews
                | CollectionV3::Patches
                | CollectionV3::PlotGrids
                | CollectionV3::Relations
                | CollectionV3::RelationTypes
                | CollectionV3::Materials
                | CollectionV3::Comments
        ) {
            return Err(DocError::NotInProfile("not a structural v3 map"));
        }
        let root = self.view.doc.get_map(collection.root());
        if let Some(old) = old {
            let LoroValue::Map(want) = &old.value else {
                return Err(DocError::NotInProfile("snapshot is not a map"));
            };
            if collection == CollectionV3::RelationTypes {
                self.refuse_locked(
                    &RelationTypeId::parse(id)
                        .map_err(|_| DocError::NotInProfile("invalid relation type"))?,
                )?;
            }
            let map = root.ensure_mergeable_map(id)?;
            sync_record_with_values(
                &map,
                want,
                match collection {
                    CollectionV3::Patches | CollectionV3::Comments => Some("body"),
                    CollectionV3::Materials => Some("description"),
                    _ => None,
                },
                if collection == CollectionV3::Comments {
                    &["region"]
                } else {
                    &[]
                },
            )?;
        } else if root.get(id).is_some() {
            if collection == CollectionV3::RelationTypes {
                self.refuse_locked(
                    &RelationTypeId::parse(id)
                        .map_err(|_| DocError::NotInProfile("invalid relation type"))?,
                )?;
            }
            root.delete(id)?;
        }
        Ok(())
    }

    pub fn restore_fields(
        &mut self,
        collection: CollectionV3,
        id: &str,
        old: &EntitySnapshot,
        keys: &[&str],
    ) -> Result<()> {
        if !matches!(
            collection,
            CollectionV3::Materials
                | CollectionV3::RelationTypes
                | CollectionV3::Relations
                | CollectionV3::Comments
                | CollectionV3::Assets
                | CollectionV3::Memory
        ) {
            return Err(DocError::NotInProfile("restore of a tree or meta"));
        }
        if collection == CollectionV3::RelationTypes {
            self.refuse_locked(
                &RelationTypeId::parse(id)
                    .map_err(|_| DocError::NotInProfile("invalid relation type"))?,
            )?;
        }
        crate::catalog::write::CatalogTxn {
            view: crate::catalog::read::CatalogView { doc: self.view.doc },
        }
        .restore_fields(collection.root(), id, old, keys)
    }

    pub fn purge(&mut self, collection: CollectionV3, id: &str) -> Result<()> {
        if collection == CollectionV3::RelationTypes {
            self.refuse_locked(&RelationTypeId::parse(id).map_err(|_| DocError::Missing {
                collection: book_v3::RELATION_TYPES,
                id: id.to_string(),
            })?)?;
        }
        if collection.is_tree() || collection == CollectionV3::Meta {
            return Err(DocError::NotInProfile("purge of a tree or meta"));
        }
        let m = self.view.doc.get_map(collection.root());
        if m.get(id).is_some() {
            m.delete(id)?;
        }
        Ok(())
    }

    pub fn apply_repair(&mut self, plan: &RepairPlanV3) -> Result<()> {
        for id in &plan.duplicate_relations {
            self.purge(CollectionV3::Relations, id.as_str())?;
        }
        Ok(())
    }
}

fn sync_nested_map(sub: &LoroMap, want: &loro::LoroMapValue) -> Result<()> {
    sync_record(sub, want, None)
}

// History explicitly replaces this selected field, not its parent record.
// Keep supported map containers editable and retain historical leaf values.
// Callers must preflight actual selected containers before snapshotting: deep
// values alone cannot preserve unknown rich text or list container identities.
// A different current value kind must not cause a failure halfway through a
// multi-field restore; replacing that selected value is the requested edit.
fn restore_raw_field(parent: &LoroMap, key: &str, value: Option<&LoroValue>) -> Result<()> {
    use loro::{Container, ValueOrContainer};
    match value {
        Some(LoroValue::Map(want)) => {
            let map = match parent.get(key) {
                Some(ValueOrContainer::Container(Container::Map(map))) => map,
                old => {
                    if old.is_some() {
                        parent.delete(key)?;
                    }
                    parent.ensure_mergeable_map(key)?
                }
            };
            let keys: Vec<_> = map.keys().map(|k| k.to_string()).collect();
            for key in keys {
                if !want.contains_key(&key) {
                    map.delete(&key)?;
                }
            }
            for (key, value) in want.iter() {
                restore_raw_field(&map, key, Some(value))?;
            }
        }
        Some(value) => parent.insert(key, value.clone())?,
        None if parent.get(key).is_some() => parent.delete(key)?,
        None => {}
    }
    Ok(())
}

fn sync_record(sub: &LoroMap, want: &loro::LoroMapValue, text_key: Option<&str>) -> Result<()> {
    sync_record_with_values(sub, want, text_key, &[])
}

fn sync_record_with_values(
    sub: &LoroMap,
    want: &loro::LoroMapValue,
    text_key: Option<&str>,
    value_keys: &[&str],
) -> Result<()> {
    let have: Vec<String> = sub.keys().map(|k| k.to_string()).collect();
    for k in have {
        if !want.contains_key(&k) {
            sub.delete(&k)?;
        }
    }
    for (k, v) in want.iter() {
        // A region is an atomic value; anchors and structural child records
        // retain their mergeable map containers.
        if value_keys.contains(&k.as_str()) {
            sub.insert(k, v.clone())?;
            continue;
        }
        if text_key == Some(k.as_str())
            && let LoroValue::String(text) = v
        {
            set_text(sub, k, text)?;
            continue;
        }
        match v {
            LoroValue::Map(entry) => {
                // Only use a mergeable sub-map for kv rows (`{key, value, pos}`);
                // tagged FieldValues (`{"t": ..., "v": ...}`) and `allow` lists
                // are stored as plain LoroValue::Map values.
                if entry.contains_key("t") && entry.contains_key("v") {
                    sub.insert(k, v.clone())?;
                } else {
                    let e = sub.ensure_mergeable_map(k)?;
                    sync_nested_map(&e, entry)?;
                }
            }
            v => sub.insert(k, v.clone())?,
        }
    }
    Ok(())
}
