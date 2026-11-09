//! Read-tolerant views of a universal kernel v3 book document (`kernel-v3.md`).

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use dr_model::book::*;
use dr_model::id::*;
use dr_model::kind::*;
use dr_model::pos::cmp_pos;
use dr_model::v3::*;
use dr_model::{DocId, Timestamp};
use loro::{LoroDoc, LoroMap, LoroTree, LoroValue, TreeID};

use crate::book::EntitySnapshot;
use crate::book::fields::{F, kv_entries};
use crate::book::read::{ForestNode, forest};
use crate::schema::book_v3;
use crate::v3::CollectionV3;
use crate::{DocError, Result};

/// Stored metadata of a v3 [`Entry`] at a history point (`BookReaderV3::load_at`),
/// for restoring per-entry metadata (`BookTxnV3::restore_entry`).
#[derive(Clone, Debug, PartialEq)]
pub struct EntrySnapshotV3 {
    pub(crate) value: LoroValue,
}

impl EntrySnapshotV3 {
    pub fn field(&self, key: &str) -> Option<&LoroValue> {
        F(&self.value).get(key)
    }

    pub fn keys(&self) -> Vec<String> {
        match &self.value {
            LoroValue::Map(m) => {
                let mut v: Vec<String> = m.keys().cloned().collect();
                v.sort();
                v
            }
            _ => Vec::new(),
        }
    }

    pub fn diff(
        &self,
        after: &EntrySnapshotV3,
    ) -> Vec<(String, Option<LoroValue>, Option<LoroValue>)> {
        let mut keys = self.keys();
        keys.extend(after.keys());
        keys.sort();
        keys.dedup();
        keys.into_iter()
            .filter_map(|k| {
                let (a, b) = (self.field(&k), after.field(&k));
                (a != b).then(|| (k, a.cloned(), b.cloned()))
            })
            .collect()
    }
}

/// Deterministic background repair plan for a v3 book document.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RepairPlanV3 {
    /// Semantic duplicate relations beyond the smallest `RelationId`.
    pub duplicate_relations: Vec<RelationId>,
}

impl RepairPlanV3 {
    pub fn is_empty(&self) -> bool {
        self.duplicate_relations.is_empty()
    }
}

fn entities(doc: &LoroDoc, root: &str) -> Vec<(String, LoroValue)> {
    match doc.get_map(root).get_deep_value() {
        LoroValue::Map(m) => {
            let mut v: Vec<(String, LoroValue)> =
                m.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
            v.sort_by(|a, b| a.0.cmp(&b.0));
            v
        }
        _ => Vec::new(),
    }
}

fn entity(doc: &LoroDoc, root: &str, id: &str) -> Option<LoroValue> {
    match doc.get_map(root).get(id)? {
        loro::ValueOrContainer::Container(loro::Container::Map(m)) => Some(m.get_deep_value()),
        _ => None,
    }
}

pub(crate) fn decode_level_settings_override(f: F<'_>) -> LevelSettingsOverride {
    // The v2 field codec treats null as absent. In a v3 override it means
    // explicitly clear, so inspect these two keys without that normalization.
    let raw = |key: &str| match f.0 {
        LoroValue::Map(map) => map.get(key),
        _ => None,
    };
    let default_template = match raw("default_template") {
        Some(LoroValue::Null) => Some(None),
        Some(LoroValue::String(s)) => EntryTemplateId::parse(s).ok().map(Some),
        _ => None,
    };
    let allow = match f.get("allow") {
        Some(LoroValue::List(l)) => Some(
            l.iter()
                .filter_map(|v| match v {
                    LoroValue::String(s) => EntryTemplateId::parse(s).ok(),
                    _ => None,
                })
                .collect(),
        ),
        _ => None,
    };
    let home = match raw("home") {
        Some(LoroValue::Null) => Some(None),
        Some(LoroValue::String(s)) => EntryId::parse(s).ok().map(Some),
        _ => None,
    };
    LevelSettingsOverride {
        default_template,
        allow,
        display: f.kind("display"),
        auto_link: f.bool("auto_link"),
        accept: f.bool("accept"),
        home,
        is_manuscript: f.bool("is_manuscript"),
        format_shortcuts: f.kind("format_shortcuts"),
    }
}

pub(crate) fn decode_field_value(v: &LoroValue) -> Option<FieldValue> {
    match v {
        LoroValue::Null => Some(FieldValue::Null),
        LoroValue::Bool(b) => Some(FieldValue::Bool(*b)),
        LoroValue::Double(d) if d.is_finite() => Some(FieldValue::Number(*d)),
        LoroValue::I64(i) => Some(FieldValue::Number(*i as f64)),
        LoroValue::String(s) => Some(FieldValue::Text(s.to_string())),
        LoroValue::List(l) => Some(FieldValue::List(
            l.iter()
                .filter_map(|x| match x {
                    LoroValue::String(s) => Some(s.to_string()),
                    _ => None,
                })
                .collect(),
        )),
        LoroValue::Map(m) => {
            // Also tolerate a `{ "t": ..., "v": ... }` wrapper if present.
            if let Some(val) = m.get("v") {
                decode_field_value(val)
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Read-only view of a v3 book document.
#[derive(Clone, Copy)]
pub struct BookViewV3<'a> {
    pub(crate) doc: &'a LoroDoc,
    pub(crate) book: &'a BookId,
}

impl<'a> BookViewV3<'a> {
    pub fn book_id(&self) -> &BookId {
        self.book
    }

    /// Capture one consistent deep value under Loro's state lock, then resolve
    /// the structure once. Unlike a live view this explicit snapshot never changes.
    /// This read neither commits pending writes nor caches across a transaction.
    pub fn structure_snapshot(&self) -> super::BookStructureV3 {
        super::BookStructureV3::from_value(self.book.clone(), &self.doc.get_deep_value())
    }

    pub fn meta(&self) -> BookMetaV3 {
        let v = self.doc.get_map(book_v3::META).get_deep_value();
        let f = F(&v);
        let project_template = f.sub("project_template").and_then(|pt| {
            let id = pt.string("id");
            if id.is_empty() {
                None
            } else {
                Some(ProjectTemplateRef {
                    id,
                    version: pt.i64("version").unwrap_or(1),
                })
            }
        });
        BookMetaV3 {
            id: self.book.clone(),
            schema_version: f.i64("v").unwrap_or(0),
            name: f.string("name"),
            summary: f.string("summary"),
            deleted_at: f.ts("deleted_at"),
            created_at: f.ts("created_at"),
            word_target_set: f.i64("word_target"),
            daily_word_target_set: f.i64("daily_word_target"),
            project_template,
        }
    }

    pub fn trashed_at(&self) -> Option<Timestamp> {
        self.meta().deleted_at
    }

    // ---- templates -------------------------------------------------------

    pub(super) fn read_template(id: &str, v: &LoroValue) -> Option<EntryTemplate> {
        let f = F(v);
        let tid = EntryTemplateId::parse(id).ok()?;
        let kind = f.kind::<TemplateKind>("kind").unwrap_or(TemplateKind::Leaf);
        let agent = f.sub("agent").and_then(|a| {
            let cfg = TemplateAgentConfig {
                name: a.string("name"),
                description: a.string("description"),
                instructions: a.string("instructions"),
            };
            if cfg.name.is_empty() && cfg.description.is_empty() && cfg.instructions.is_empty() {
                None
            } else {
                Some(cfg)
            }
        });
        let mut modules: Vec<ModuleSpec> = match f.get("modules") {
            Some(LoroValue::Map(m)) => m
                .iter()
                .filter_map(|(mid, mv)| {
                    let mf = F(mv);
                    let module_id = ModuleId::parse(mid).ok()?;
                    let mkind = mf.kind::<ModuleKind>("kind")?;
                    if kind == TemplateKind::Level && !mkind.allowed_on_level() {
                        return None;
                    }
                    let magent = mf.sub("agent").and_then(|a| {
                        let writable = a.bool("writable").unwrap_or(true);
                        let read_tier = a.opt_string("read_tier");
                        let instructions = a
                            .opt_string("instructions")
                            .or_else(|| a.opt_string("description"))
                            .unwrap_or_default();
                        if writable && read_tier.is_none() && instructions.is_empty() {
                            None
                        } else {
                            Some(ModuleAgentConfig {
                                writable,
                                read_tier,
                                instructions,
                            })
                        }
                    });
                    let cfg_f = mf.sub("config");
                    let raw_defs = cfg_f.and_then(|c| c.get("defs").or_else(|| c.get("fields")));
                    let mut defs: Vec<FieldDef> = match raw_defs {
                        Some(LoroValue::List(list)) => list
                            .iter()
                            .filter_map(|fv| {
                                let ff = F(fv);
                                let fid = ff.string("id");
                                if fid.is_empty() {
                                    return None;
                                }
                                let options = match ff.get("options") {
                                    Some(LoroValue::List(ol)) => ol
                                        .iter()
                                        .filter_map(|ov| match ov {
                                            LoroValue::String(s) => Some(s.to_string()),
                                            _ => None,
                                        })
                                        .collect(),
                                    _ => Vec::new(),
                                };
                                Some(FieldDef {
                                    id: fid,
                                    name: ff.string("name"),
                                    field_type: ff.kind("field_type").unwrap_or(FieldType::Text),
                                    options,
                                    target_template: ff.id("target_template"),
                                    pos: ff.pos("pos"),
                                })
                            })
                            .collect(),
                        Some(LoroValue::Map(fmap)) => fmap
                            .iter()
                            .filter_map(|(fid, fv)| {
                                if fid.is_empty() {
                                    return None;
                                }
                                let ff = F(fv);
                                let options = match ff.get("options") {
                                    Some(LoroValue::List(ol)) => ol
                                        .iter()
                                        .filter_map(|ov| match ov {
                                            LoroValue::String(s) => Some(s.to_string()),
                                            _ => None,
                                        })
                                        .collect(),
                                    _ => Vec::new(),
                                };
                                Some(FieldDef {
                                    id: fid.clone(),
                                    name: ff.string("name"),
                                    field_type: ff.kind("field_type").unwrap_or(FieldType::Text),
                                    options,
                                    target_template: ff.id("target_template"),
                                    pos: ff.pos("pos"),
                                })
                            })
                            .collect(),
                        _ => Vec::new(),
                    };
                    sort_field_defs(&mut defs);
                    let default_cfg = ModuleConfig::default();
                    let config = match cfg_f {
                        Some(c) => ModuleConfig {
                            show_outline: c
                                .bool("show_outline")
                                .unwrap_or(default_cfg.show_outline),
                            task_todos: c.bool("task_todos").unwrap_or(default_cfg.task_todos),
                            defs,
                            aliases_field: c.opt_string("aliases_field"),
                            color_field: c.opt_string("color_field"),
                            status_field: c.opt_string("status_field"),
                            summary_field: c.opt_string("summary_field"),
                            portrait_field: c.opt_string("portrait_field"),
                            initial_kv: c.kv("initial_kv"),
                            default_rows: c
                                .i64("default_rows")
                                .map(|n| n.max(1) as u32)
                                .unwrap_or(default_cfg.default_rows),
                            default_cols: c
                                .i64("default_cols")
                                .map(|n| n.max(1) as u32)
                                .unwrap_or(default_cfg.default_cols),
                        },
                        None => ModuleConfig {
                            defs,
                            ..default_cfg
                        },
                    };
                    Some(ModuleSpec {
                        id: module_id,
                        kind: mkind,
                        name: mf.string("name"),
                        pos: mf.pos("pos"),
                        config,
                        agent: magent,
                    })
                })
                .collect(),
            _ => Vec::new(),
        };
        sort_modules(&mut modules);

        let settings = if kind == TemplateKind::Level {
            f.sub("settings")
                .map(decode_level_settings_override)
                .unwrap_or_default()
        } else {
            LevelSettingsOverride::default()
        };
        let lane = kind == TemplateKind::Level && f.bool("lane").unwrap_or(false);
        let mut verbs: Vec<TemplateVerb> = if kind == TemplateKind::Level {
            match f.get("verbs") {
                Some(LoroValue::Map(vm)) => vm
                    .iter()
                    .filter_map(|(vid, vv)| {
                        if vid.is_empty() {
                            return None;
                        }
                        let vf = F(vv);
                        Some(TemplateVerb {
                            id: vid.clone(),
                            name: vf.string("name"),
                            description: vf.string("description"),
                            target_template: vf.id("target_template"),
                            pos: vf.pos("pos"),
                        })
                    })
                    .collect(),
                _ => Vec::new(),
            }
        } else {
            Vec::new()
        };
        sort_verbs(&mut verbs);

        Some(EntryTemplate {
            id: tid,
            kind,
            name: f.string("name"),
            mark: f.opt_string("mark"),
            color: f.opt_string("color"),
            agent,
            modules,
            settings,
            lane,
            verbs,
            deleted_at: f.ts("deleted_at"),
        })
    }

    /// All templates (including trashed ones), sorted by id.
    pub fn templates(&self) -> Vec<EntryTemplate> {
        entities(self.doc, book_v3::TEMPLATES)
            .iter()
            .filter_map(|(id, v)| Self::read_template(id, v))
            .collect()
    }

    pub fn templates_map(&self) -> BTreeMap<EntryTemplateId, EntryTemplate> {
        self.templates()
            .into_iter()
            .map(|t| (t.id.clone(), t))
            .collect()
    }

    pub fn template(&self, id: &EntryTemplateId) -> Option<EntryTemplate> {
        let v = entity(self.doc, book_v3::TEMPLATES, id.as_str())?;
        Self::read_template(id.as_str(), &v)
    }

    // ---- entries (LoroTree) ----------------------------------------------

    pub(crate) fn tree(&self, root: &str) -> LoroTree {
        self.doc.get_tree(root)
    }

    pub(crate) fn tree_index(&self, root: &str) -> HashMap<String, Vec<TreeID>> {
        forest(&self.tree(root))
            .into_iter()
            .map(|n| (n.id, n.tree_ids))
            .collect()
    }

    pub(super) fn read_entry_node(n: &ForestNode) -> Option<Entry> {
        let id = EntryId::parse(&n.id).ok()?;
        let parent = n.parent.as_deref().and_then(|p| EntryId::parse(p).ok());
        let pos = n.pos.clone();
        let f = F(&n.meta);
        let overrides = f
            .sub("overrides")
            .map(decode_level_settings_override)
            .filter(|o| !o.is_empty());

        let mut fields: BTreeMap<ModuleId, BTreeMap<String, FieldValue>> = BTreeMap::new();
        if let Some(LoroValue::Map(fmods)) = f.get("fields") {
            for (mid, mv) in fmods.iter() {
                let Ok(module_id) = ModuleId::parse(mid) else {
                    continue;
                };
                let LoroValue::Map(fmap) = mv else {
                    continue;
                };
                let mut mvals = BTreeMap::new();
                for (fk, fv) in fmap.iter() {
                    if let Some(val) = decode_field_value(fv) {
                        mvals.insert(fk.clone(), val);
                    }
                }
                if !mvals.is_empty() {
                    fields.insert(module_id, mvals);
                }
            }
        }

        let mut kv: BTreeMap<ModuleId, Vec<KvEntry>> = BTreeMap::new();
        if let LoroValue::Map(meta_map) = &n.meta {
            for (k, v) in meta_map.iter() {
                if let Some(mid) = k.strip_prefix("kv:")
                    && let Ok(module_id) = ModuleId::parse(mid)
                {
                    let rows = kv_entries(v);
                    if !rows.is_empty() {
                        kv.insert(module_id, rows);
                    }
                }
            }
        }

        let layout = f
            .sub("layout")
            .map(|l| {
                EntryLayout {
                    board: match (l.f64("board_x"), l.f64("board_y")) {
                        (Some(x), Some(y)) => Some((x, y)),
                        _ => None,
                    },
                    grid: match (l.i64("grid_x"), l.i64("grid_y")) {
                        (Some(x), Some(y)) => Some((x, y)),
                        _ => None,
                    },
                    relation_graph: match (l.f64("pin_x"), l.f64("pin_y")) {
                        (Some(x), Some(y)) => Some((x, y)),
                        _ => None,
                    },
                }
                .sanitized()
            })
            .unwrap_or_default();

        Some(Entry {
            id,
            parent,
            pos,
            title: f.string("title"),
            template: f.id("template"),
            overrides,
            fields,
            kv,
            primary: f.id("primary"),
            layout,
            created_at: f.ts("created_at"),
            updated_at: f.ts("updated_at"),
            deleted_at: f.ts("deleted_at"),
            name_conflict: None,
        })
    }

    /// Entries in depth-first tree order (parents before children, siblings in
    /// fractional-index manuscript order), without computing auto-link name conflicts.
    pub fn entries_raw(&self) -> Vec<Entry> {
        let tree = self.tree(book_v3::ENTRIES);
        forest(&tree)
            .iter()
            .filter_map(Self::read_entry_node)
            .collect()
    }

    /// Entries in depth-first tree order, with `V3-AUTOLINK-NAME-UNIQUE`
    /// conflicts resolved on live auto-link leaf entries.
    pub fn entries(&self) -> Vec<Entry> {
        let raw = self.entries_raw();
        let templates = self.templates_map();
        let raw_memberships = self.memberships_raw();
        let mut by_id: BTreeMap<EntryId, Entry> =
            raw.iter().map(|e| (e.id.clone(), e.clone())).collect();
        resolve_autolink_name_conflicts(&mut by_id, &raw_memberships, &templates);
        raw.into_iter()
            .map(|mut e| {
                if let Some(resolved) = by_id.get(&e.id) {
                    e.name_conflict = resolved.name_conflict.clone();
                }
                e
            })
            .collect()
    }

    pub fn entries_map(&self) -> BTreeMap<EntryId, Entry> {
        self.entries()
            .into_iter()
            .map(|e| (e.id.clone(), e))
            .collect()
    }

    pub fn entry(&self, id: &EntryId) -> Option<Entry> {
        self.entries().into_iter().find(|e| &e.id == id)
    }

    /// Effective parent of `id` after applying `V3-LEAF-NO-CHILDREN` tolerance
    /// (children placed under a leaf by a concurrent merge are lifted to the
    /// nearest non-leaf ancestor).
    pub fn effective_parent(&self, id: &EntryId) -> Option<EntryId> {
        let entries = self.entries_map();
        let templates = self.templates_map();
        let e = entries.get(id)?;
        effective_parent_id(e, &entries, &templates)
    }

    /// Live child entries whose effective parent is `parent`, in manuscript
    /// order (`entries` depth-first tree order).
    pub fn children_of(&self, parent: Option<&EntryId>) -> Vec<Entry> {
        let ordered = self.entries();
        let entries: BTreeMap<EntryId, Entry> =
            ordered.iter().map(|e| (e.id.clone(), e.clone())).collect();
        let templates = self.templates_map();
        ordered
            .into_iter()
            .filter(|e| {
                !e.is_trashed() && effective_parent_id(e, &entries, &templates).as_ref() == parent
            })
            .collect()
    }

    ///Resolved level settings for `level_id` (`entry.overrides > template.settings > nearest ancestor > default`).
    pub fn level_settings(&self, level_id: Option<&EntryId>) -> LevelSettings {
        let entries = self.entries_map();
        let templates = self.templates_map();
        resolve_level_settings(level_id, &entries, &templates)
    }

    /// Outermost live manuscript levels (`V3-MANUSCRIPT-NO-NEST`).
    pub fn manuscript_levels(&self) -> BTreeSet<EntryId> {
        let entries = self.entries_map();
        let templates = self.templates_map();
        effective_manuscript_levels(&entries, &templates)
    }

    /// Live leaf entries inside `manuscript_level` in depth-first manuscript order.
    pub fn manuscript_leaves(&self, manuscript_level: &EntryId) -> Vec<Entry> {
        let ordered = self.entries();
        let entries: BTreeMap<EntryId, Entry> =
            ordered.iter().map(|e| (e.id.clone(), e.clone())).collect();
        let templates = self.templates_map();
        if !effective_manuscript_levels(&entries, &templates).contains(manuscript_level) {
            return Vec::new();
        }
        ordered
            .into_iter()
            .filter(|e| {
                if e.is_trashed() || !e.is_leaf(&templates) {
                    return false;
                }
                let anc = effective_ancestors(&entries, &templates, &e.id);
                anc.contains(manuscript_level)
                    && anc
                        .iter()
                        .all(|a| entries.get(a).is_some_and(|ae| !ae.is_trashed()))
            })
            .collect()
    }

    /// Auto-link leaf entries whose title or alias collides with an earlier
    /// auto-link leaf: `(colliding_entry, winner_entry)`.
    pub fn autolink_name_conflicts(&self) -> Vec<(EntryId, EntryId)> {
        self.entries()
            .into_iter()
            .filter_map(|e| e.name_conflict.map(|w| (e.id, w)))
            .collect()
    }

    /// Find the first live root entry (`parent == None && !is_trashed()`) in
    /// manuscript order whose `template` equals `template_id`.
    pub fn root_entry_by_template(&self, template_id: &EntryTemplateId) -> Option<Entry> {
        self.children_of(None)
            .into_iter()
            .find(|e| e.template.as_ref() == Some(template_id))
    }

    /// Look up the novel root level entries (`书稿`, `构想`, `要素`, `故事线`),
    /// default category entries (`人物`, `地点`, `道具`, `组织`), and default
    /// timeline view by their templates.
    pub fn novel_roots(&self) -> Option<crate::v3::novel::NovelRootEntries> {
        crate::v3::novel::find_novel_roots(self)
    }

    // ---- memberships -----------------------------------------------------

    /// Every stored membership, unfiltered, sorted by `(host, pos, member)`.
    pub fn memberships_raw(&self) -> Vec<Membership> {
        Self::read_memberships(Some(
            &self.doc.get_map(book_v3::MEMBERSHIPS).get_deep_value(),
        ))
    }

    pub(super) fn read_memberships(value: Option<&LoroValue>) -> Vec<Membership> {
        let Some(LoroValue::Map(records)) = value else {
            return Vec::new();
        };
        let mut out: Vec<Membership> = records
            .iter()
            .filter_map(|(k, v)| {
                let (host, member) = Membership::parse_key(k)?;
                let f = F(v);
                Some(Membership {
                    host,
                    member,
                    pos: f.pos("pos"),
                    created_at: f.ts("created_at"),
                })
            })
            .collect();
        out.sort_by(|a, b| {
            a.host
                .cmp(&b.host)
                .then_with(|| cmp_pos((a.pos.as_ref(), &a.member), (b.pos.as_ref(), &b.member)))
        });
        out
    }

    /// Valid memberships (`V3-MEMBERSHIP-RULES`: both ends live, host is a
    /// level with `accept == true` and allows member's template).
    pub fn memberships(&self) -> Vec<Membership> {
        let raw = self.memberships_raw();
        let entries: BTreeMap<EntryId, Entry> = self
            .entries_raw()
            .into_iter()
            .map(|e| (e.id.clone(), e))
            .collect();
        let templates = self.templates_map();
        filter_valid_memberships(&raw, &entries, &templates)
    }

    pub fn memberships_of_host(&self, host: &EntryId) -> Vec<Membership> {
        let mut v: Vec<Membership> = self
            .memberships()
            .into_iter()
            .filter(|m| &m.host == host)
            .collect();
        sort_memberships_by_member(&mut v);
        v
    }

    pub fn memberships_of_member(&self, member: &EntryId) -> Vec<Membership> {
        let mut v: Vec<Membership> = self
            .memberships()
            .into_iter()
            .filter(|m| &m.member == member)
            .collect();
        sort_memberships_by_host(&mut v);
        v
    }

    // ---- timeline views --------------------------------------------------

    fn read_timeline_view_raw(id: &str, v: &LoroValue) -> Option<TimelineView> {
        let f = F(v);
        let vid = TimelineViewId::parse(id).ok()?;
        let mut lanes: Vec<TimelineLane> = match f.get("lanes") {
            Some(LoroValue::Map(m)) => m
                .iter()
                .filter_map(|(eid, lv)| {
                    Some(TimelineLane {
                        entry: EntryId::parse(eid).ok()?,
                        pos: F(lv).pos("pos"),
                    })
                })
                .collect(),
            _ => Vec::new(),
        };
        sort_timeline_lanes(&mut lanes);

        let mut placements: Vec<TimelinePlacement> = match f.get("placements") {
            Some(LoroValue::Map(m)) => m
                .iter()
                .filter_map(|(eid, pv)| {
                    let pf = F(pv);
                    Some(TimelinePlacement {
                        entry: EntryId::parse(eid).ok()?,
                        at: pf.f64("at")?,
                        span: pf.f64("span").filter(|s| *s >= 0.0),
                    })
                })
                .collect(),
            _ => Vec::new(),
        };
        sort_timeline_placements(&mut placements);

        let mut pins: Vec<TimelinePin> = match f.get("pins") {
            Some(LoroValue::Map(m)) => m
                .iter()
                .filter_map(|(pid, pv)| {
                    let pf = F(pv);
                    Some(TimelinePin {
                        id: TimePinId::parse(pid).ok()?,
                        at: pf.f64("at")?,
                        label: pf.string("label"),
                        color: pf.opt_string("color"),
                        entry: pf.id("entry"),
                    })
                })
                .collect(),
            _ => Vec::new(),
        };
        sort_timeline_pins(&mut pins);

        Some(TimelineView {
            id: vid,
            name: f.string("name"),
            pos: f.pos("pos"),
            lanes,
            placements,
            pins,
            deleted_at: f.ts("deleted_at"),
        })
    }

    /// Raw timeline views (trashed included), sorted by `(pos, id)`.
    pub fn timeline_views_raw(&self) -> Vec<TimelineView> {
        let mut out: Vec<TimelineView> = entities(self.doc, book_v3::TIMELINE_VIEWS)
            .iter()
            .filter_map(|(id, v)| Self::read_timeline_view_raw(id, v))
            .collect();
        sort_timeline_views(&mut out);
        out
    }

    /// Read-tolerant timeline views:
    /// - `lanes` filtered by `V3-TIMELINE-LANE-ENABLED` and `V3-TIMELINE-TARGETS-LIVE`;
    /// - `placements` filtered by `V3-TIMELINE-PLACEMENT-IN-LANE` and `V3-TIMELINE-TARGETS-LIVE`;
    /// - `pins` filtered by `V3-TIMELINE-TARGETS-LIVE`.
    pub fn timeline_views(&self) -> Vec<TimelineView> {
        let entries: BTreeMap<EntryId, Entry> = self
            .entries_raw()
            .into_iter()
            .map(|e| (e.id.clone(), e))
            .collect();
        let templates = self.templates_map();
        let memberships = self.memberships_raw();
        let mut out: Vec<TimelineView> = self
            .timeline_views_raw()
            .into_iter()
            .map(|mut v| {
                let placements =
                    effective_timeline_placements(&v, &memberships, &entries, &templates);
                let lanes = effective_timeline_lanes(&v.lanes, &entries, &templates);
                let pins = effective_timeline_pins(&v.pins, &entries);
                v.lanes = lanes;
                v.placements = placements;
                v.pins = pins;
                v
            })
            .collect();
        sort_timeline_views(&mut out);
        out
    }

    pub fn timeline_view(&self, id: &TimelineViewId) -> Option<TimelineView> {
        self.timeline_views().into_iter().find(|v| &v.id == id)
    }

    /// One stored placement, including unknown fields and values hidden by
    /// the effective view. Used by field-scoped history, never a view replacement.
    pub fn timeline_placement_snapshot(
        &self,
        view: &TimelineViewId,
        entry: &EntryId,
    ) -> Result<Option<LoroValue>> {
        let value = entity(self.doc, book_v3::TIMELINE_VIEWS, view.as_str()).ok_or_else(|| {
            DocError::Missing {
                collection: book_v3::TIMELINE_VIEWS,
                id: view.to_string(),
            }
        })?;
        let LoroValue::Map(record) = value else {
            return Err(DocError::NotInProfile("timeline view is not a map"));
        };
        match record.get("placements") {
            None => Ok(None),
            Some(LoroValue::Map(placements)) => Ok(placements.get(entry.as_str()).cloned()),
            _ => Err(DocError::NotInProfile("timeline placements are not a map")),
        }
    }

    /// Preflight a placement write without creating a missing container.
    /// Call for all affected views before changing a membership or primary.
    pub fn check_timeline_placement_write(&self, view: &TimelineViewId) -> Result<()> {
        use loro::{Container, ContainerID, ContainerTrait, ContainerType, ValueOrContainer};
        let root = self.doc.get_map(book_v3::TIMELINE_VIEWS);
        let expected = ContainerID::new_mergeable(&root.id(), view.as_str(), ContainerType::Map);
        let Some(ValueOrContainer::Container(Container::Map(record))) = root.get(view.as_str())
        else {
            return Err(DocError::NotInProfile(
                "timeline view is not a writable map",
            ));
        };
        if record.id() != expected {
            return Err(DocError::NotInProfile(
                "timeline view is not a mergeable map",
            ));
        }
        match record.get("placements") {
            None | Some(ValueOrContainer::Container(Container::Map(_))) => Ok(()),
            _ => Err(DocError::NotInProfile(
                "timeline placements are not a writable map",
            )),
        }
    }

    // ---- patches and plot grids ------------------------------------------

    /// Patches of entries that exist, sorted by `(entry, module, pos, id)`.
    pub fn patches(&self) -> Vec<PatchV3> {
        let entry_ids: HashSet<String> = forest(&self.tree(book_v3::ENTRIES))
            .into_iter()
            .map(|n| n.id)
            .collect();
        let mut v: Vec<PatchV3> = entities(self.doc, book_v3::PATCHES)
            .iter()
            .filter_map(|(id, v)| {
                let f = F(v);
                let entry: EntryId = f.id("entry")?;
                let module: ModuleId = f.id("module")?;
                if !entry_ids.contains(entry.as_str()) {
                    return None;
                }
                let source_entry = f
                    .id::<EntryId>("source_entry")
                    .filter(|n| entry_ids.contains(n.as_str()));
                let source_module = source_entry.as_ref().and_then(|_| f.id("source_module"));
                let source_block = source_entry.as_ref().and_then(|_| f.id("source_block"));
                Some(PatchV3 {
                    id: PatchId::parse(id).ok()?,
                    entry,
                    module,
                    source_entry,
                    source_module,
                    source_block,
                    source_text: f.opt_string("source_text"),
                    anchor: f.anchor("anchor"),
                    invalidated_at: f.ts("invalidated_at"),
                    title: f.opt_string("title"),
                    body: f.string("body"),
                    pos: f.pos("pos"),
                })
            })
            .collect();
        sort_patches_v3(&mut v);
        v
    }

    pub fn patches_of(&self, entry: &EntryId, module: &ModuleId) -> Vec<PatchV3> {
        self.patches()
            .into_iter()
            .filter(|p| &p.entry == entry && &p.module == module)
            .collect()
    }

    fn read_plot_grid(entry: EntryId, module: ModuleId, v: &LoroValue) -> PlotGridV3 {
        let f = F(v);
        fn lines<I: for<'s> TryFrom<&'s str> + Ord + Clone>(
            f: F<'_>,
            key: &str,
        ) -> Vec<PlotLine<I>> {
            let Some(LoroValue::Map(m)) = f.get(key) else {
                return Vec::new();
            };
            let mut v: Vec<PlotLine<I>> = m
                .iter()
                .filter_map(|(id, e)| {
                    let e = F(e);
                    Some(PlotLine {
                        id: I::try_from(id.as_str()).ok()?,
                        pos: e.pos("pos"),
                        label: e.string("label"),
                    })
                })
                .collect();
            v.sort_by(|a, b| cmp_pos((a.pos.as_ref(), &a.id), (b.pos.as_ref(), &b.id)));
            v
        }
        let rows: Vec<PlotLine<PlotRowId>> = lines(f, "rows");
        let cols: Vec<PlotLine<PlotColId>> = lines(f, "cols");
        let row_ids: HashSet<&PlotRowId> = rows.iter().map(|r| &r.id).collect();
        let col_ids: HashSet<&PlotColId> = cols.iter().map(|c| &c.id).collect();
        let mut cells = BTreeMap::new();
        if let Some(LoroValue::Map(m)) = f.get("cells") {
            for (k, v) in m.iter() {
                let Some((r, c)) = k.split_once('/') else {
                    continue;
                };
                let (Ok(r), Ok(c)) = (PlotRowId::parse(r), PlotColId::parse(c)) else {
                    continue;
                };
                if !row_ids.contains(&r) || !col_ids.contains(&c) {
                    continue;
                }
                if let LoroValue::String(s) = v {
                    cells.insert((r, c), s.to_string());
                }
            }
        }
        let clamp = |v: Option<f64>, r: &std::ops::RangeInclusive<f64>, d: f64| {
            v.unwrap_or(d).clamp(*r.start(), *r.end())
        };
        PlotGridV3 {
            entry,
            module,
            cell_w: clamp(f.f64("cell_w"), &PLOT_CELL_W, PLOT_DEFAULT_CELL.0),
            cell_h: clamp(f.f64("cell_h"), &PLOT_CELL_H, PLOT_DEFAULT_CELL.1),
            rows,
            cols,
            cells,
        }
    }

    pub fn plot_grid(&self, entry: &EntryId, module: &ModuleId) -> Option<PlotGridV3> {
        let key = PlotGridV3::key(entry, module);
        let v = entity(self.doc, book_v3::PLOT_GRIDS, &key)?;
        Some(Self::read_plot_grid(entry.clone(), module.clone(), &v))
    }

    pub fn plot_grids(&self) -> Vec<PlotGridV3> {
        entities(self.doc, book_v3::PLOT_GRIDS)
            .into_iter()
            .filter_map(|(k, v)| {
                let (entry, em) = PlotGridV3::parse_key(&k)?;
                Some(Self::read_plot_grid(entry, em.module, &v))
            })
            .collect()
    }

    // ---- relations and comments ------------------------------------------

    fn read_relation_type(id: &str, v: &LoroValue) -> Option<RelationTypeV3> {
        let f = F(v);
        let name = f.string("name");
        let tpl_list = |key: &str| -> Vec<EntryTemplateId> {
            match f.get(key) {
                Some(LoroValue::List(l)) => l
                    .iter()
                    .filter_map(|x| match x {
                        LoroValue::String(s) => EntryTemplateId::parse(s).ok(),
                        _ => None,
                    })
                    .collect(),
                _ => Vec::new(),
            }
        };
        Some(RelationTypeV3 {
            id: RelationTypeId::parse(id).ok()?,
            normalized_name: f
                .opt_string("normalized_name")
                .unwrap_or_else(|| normalize_relation_type_name(&name)),
            name,
            description: f.string("description"),
            orientation: f
                .kind("orientation")
                .unwrap_or(RelationOrientation::Directed),
            system_key: f.kind("system_key"),
            locked: f.bool("locked").unwrap_or(false),
            source_role: f.string("source_role"),
            target_role: f.string("target_role"),
            color: f.opt_string("color"),
            source_kinds: f.kinds("source_kinds"),
            target_kinds: f.kinds("target_kinds"),
            source_templates: tpl_list("source_templates"),
            target_templates: tpl_list("target_templates"),
        })
    }

    pub fn relation_types(&self) -> Vec<RelationTypeV3> {
        entities(self.doc, book_v3::RELATION_TYPES)
            .iter()
            .filter_map(|(id, v)| Self::read_relation_type(id, v))
            .collect()
    }

    pub fn relation_type(&self, id: &RelationTypeId) -> Option<RelationTypeV3> {
        let v = entity(self.doc, book_v3::RELATION_TYPES, id.as_str())?;
        Self::read_relation_type(id.as_str(), &v)
    }

    pub fn relations_raw(&self) -> Vec<Relation> {
        entities(self.doc, book_v3::RELATIONS)
            .iter()
            .filter_map(|(id, v)| {
                let f = F(v);
                Some(Relation {
                    id: RelationId::parse(id).ok()?,
                    from: f.entity_ref("from_kind", "from")?,
                    to: f.entity_ref("to_kind", "to")?,
                    relation_type: f.id("type")?,
                    created_at: f.ts("created_at"),
                })
            })
            .collect()
    }

    fn entity_map(&self, root: &str, id: &str) -> Option<LoroMap> {
        match self.doc.get_map(root).get(id)? {
            loro::ValueOrContainer::Container(loro::Container::Map(m)) => Some(m),
            _ => None,
        }
    }

    /// Whether `r` names an entity that exists and is not in the trash in v3.
    pub fn entity_exists(&self, r: &EntityRef) -> bool {
        match r.kind {
            EntityKind::Entry => forest(&self.tree(book_v3::ENTRIES))
                .into_iter()
                .find(|n| n.id == r.id)
                .is_some_and(|n| F(&n.meta).ts("deleted_at").is_none()),
            EntityKind::Patch => self.entity_map(book_v3::PATCHES, &r.id).is_some_and(|m| {
                matches!(
                    m.get("entry"),
                    Some(loro::ValueOrContainer::Value(LoroValue::String(e)))
                        if forest(&self.tree(book_v3::ENTRIES)).iter().any(|n| n.id == e.as_str())
                )
            }),
            EntityKind::Comment => self.entity_map(book_v3::COMMENTS, &r.id).is_some(),
            EntityKind::Material => self.entity_map(book_v3::MATERIALS, &r.id).is_some(),
            _ => false,
        }
    }

    pub fn relations(&self) -> Vec<Relation> {
        self.visible_relations(|_| true)
    }

    pub fn relations_of(&self, end: &EntityRef) -> Vec<Relation> {
        self.visible_relations(|r| &r.from == end || &r.to == end)
    }

    fn visible_relations(&self, keep: impl Fn(&Relation) -> bool) -> Vec<Relation> {
        let types: HashMap<RelationTypeId, RelationTypeV3> = self
            .relation_types()
            .into_iter()
            .map(|t| (t.id.clone(), t))
            .collect();
        let entries: HashMap<String, Entry> = self
            .entries_raw()
            .into_iter()
            .map(|e| (e.id.to_string(), e))
            .collect();
        let templates = self.templates_map();
        let mut seen: HashSet<(EntityRef, EntityRef, RelationTypeId)> = HashSet::new();
        let mut out = Vec::new();
        for r in self.relations_raw() {
            if !keep(&r) {
                continue;
            }
            let Some(t) = types.get(&r.relation_type) else {
                continue;
            };
            if r.from == r.to || !r.from.kind.may_start_relation() || !r.to.kind.is_structural() {
                continue;
            }
            let allowed_kind =
                |kinds: &[EntityKind], k: &EntityKind| kinds.is_empty() || kinds.contains(k);
            let allowed_tpl = |tpls: &[EntryTemplateId], end: &EntityRef| -> bool {
                if tpls.is_empty() || end.kind != EntityKind::Entry {
                    return true;
                }
                entries
                    .get(&end.id)
                    .and_then(|e| e.effective_template(&templates))
                    .is_some_and(|et| tpls.contains(&et.id))
            };
            let symmetric = t.orientation == RelationOrientation::Symmetric;
            let fits = if symmetric {
                allowed_kind(&t.source_kinds, &r.from.kind)
                    && allowed_kind(&t.source_kinds, &r.to.kind)
                    && allowed_tpl(&t.source_templates, &r.from)
                    && allowed_tpl(&t.source_templates, &r.to)
            } else {
                allowed_kind(&t.source_kinds, &r.from.kind)
                    && allowed_kind(&t.target_kinds, &r.to.kind)
                    && allowed_tpl(&t.source_templates, &r.from)
                    && allowed_tpl(&t.target_templates, &r.to)
            };
            if !fits {
                continue;
            }
            let alive = |end: &EntityRef| match end.kind {
                EntityKind::Entry => entries.get(&end.id).is_some_and(|e| !e.is_trashed()),
                _ => self.entity_exists(end),
            };
            if !alive(&r.from) || !alive(&r.to) {
                continue;
            }
            let key = Self::semantic_key(&r, symmetric);
            if seen.insert(key) {
                out.push(r);
            }
        }
        out
    }

    fn semantic_key(r: &Relation, symmetric: bool) -> (EntityRef, EntityRef, RelationTypeId) {
        if symmetric {
            let (a, b) = canonical_symmetric(r.from.clone(), r.to.clone());
            (a, b, r.relation_type.clone())
        } else {
            (r.from.clone(), r.to.clone(), r.relation_type.clone())
        }
    }

    fn read_comment(&self, id: &str, v: &LoroValue) -> Option<CommentV3> {
        let f = F(v);
        let target = f.entity_ref("target_kind", "target");
        let target_missing = target.as_ref().is_some_and(|t| !self.entity_exists(t));
        Some(CommentV3 {
            id: CommentId::parse(id).ok()?,
            kind: f.kind("kind").unwrap_or(CommentKind::Note),
            target,
            target_module: f.id("module"),
            target_missing,
            target_block: f.id("target_block"),
            anchor: f.anchor("anchor"),
            quote: f.opt_string("quote"),
            snapshots: f.snapshots("snapshots"),
            region: f.region("region"),
            author_kind: f.kind("author_kind").unwrap_or(CommentAuthorKind::User),
            author: f.opt_string("author"),
            author_name: f.opt_string("author_name"),
            body: f
                .opt_string("body")
                .unwrap_or_else(|| f.string("projection_text")),
            status: f.kind("status").unwrap_or(CommentStatus::Open),
            priority: f.kind("priority"),
            source: f.kind("source").unwrap_or(CommentSource::Manual),
            metadata: f.opt_string("metadata"),
            agent_conversation: f.opt_string("agent_conversation"),
            projection: match (
                f.kind::<ProjectionKind>("projection"),
                f.id::<BlockId>("projection_block"),
            ) {
                (Some(kind), Some(block)) => Some(TodoProjection { kind, block }),
                _ => None,
            },
            resolved_at: f.ts("resolved_at"),
            created_at: f.ts("created_at"),
            updated_at: f.ts("updated_at"),
        })
    }

    pub fn comment(&self, id: &CommentId) -> Option<CommentV3> {
        let v = entity(self.doc, book_v3::COMMENTS, id.as_str())?;
        self.read_comment(id.as_str(), &v)
    }

    pub fn comments(&self) -> Vec<CommentV3> {
        entities(self.doc, book_v3::COMMENTS)
            .iter()
            .filter_map(|(id, v)| self.read_comment(id, v))
            .collect()
    }

    pub fn todo_done(&self, id: &CommentId) -> Option<bool> {
        self.comment(id).map(|c| c.is_done())
    }

    // ---- materials, assets, folders, facts, memory, writing days ---------

    fn asset_kinds(&self) -> HashMap<String, AssetKind> {
        entities(self.doc, book_v3::ASSETS)
            .into_iter()
            .filter_map(|(id, v)| Some((id, F(&v).kind::<AssetKind>("kind")?)))
            .collect()
    }

    pub fn materials(&self) -> Vec<Material> {
        let folders: HashSet<String> = forest(&self.tree(book_v3::MATERIAL_FOLDERS))
            .into_iter()
            .map(|n| n.id)
            .collect();
        let assets = self.asset_kinds();
        let mut v: Vec<Material> = entities(self.doc, book_v3::MATERIALS)
            .iter()
            .filter_map(|(id, v)| {
                let f = F(v);
                let kind = f.kind::<MaterialKind>("kind").unwrap_or(MaterialKind::Text);
                let asset = f.id::<AssetId>("asset").filter(|a| {
                    let want = match kind {
                        MaterialKind::Image => AssetKind::Image,
                        MaterialKind::Pdf => AssetKind::Pdf,
                        _ => return false,
                    };
                    assets.get(a.as_str()) == Some(&want)
                });
                Some(Material {
                    id: MaterialId::parse(id).ok()?,
                    title: f.string("title"),
                    asset,
                    kind,
                    folder: f
                        .id::<MaterialFolderId>("folder")
                        .filter(|d| folders.contains(d.as_str())),
                    pos: f.pos("pos"),
                    task_todos: f.bool("task_todos").unwrap_or(true),
                    provenance: f.opt_string("provenance"),
                    description: f.string("description"),
                })
            })
            .collect();
        v.sort_by(|a, b| cmp_pos((a.pos.as_ref(), &a.id), (b.pos.as_ref(), &b.id)));
        v
    }

    pub fn assets(&self) -> Vec<Asset> {
        entities(self.doc, book_v3::ASSETS)
            .iter()
            .filter_map(|(id, v)| {
                let f = F(v);
                Some(Asset {
                    id: AssetId::parse(id).ok()?,
                    kind: f.kind("kind")?,
                    mime: f.string("mime"),
                    size: f.i64("size").unwrap_or(0),
                    sha256: f.string("sha256"),
                    width: f.i64("width"),
                    height: f.i64("height"),
                })
            })
            .collect()
    }

    pub fn material_folders(&self) -> Vec<MaterialFolder> {
        forest(&self.tree(book_v3::MATERIAL_FOLDERS))
            .into_iter()
            .filter_map(|n| {
                let f = F(&n.meta);
                Some(MaterialFolder {
                    id: MaterialFolderId::parse(&n.id).ok()?,
                    name: f.string("name"),
                    parent: n.parent.and_then(|p| MaterialFolderId::parse(&p).ok()),
                })
            })
            .collect()
    }

    pub fn facts(&self) -> Vec<KvEntry> {
        kv_entries(&self.doc.get_map(book_v3::FACTS).get_deep_value())
    }

    pub fn memory(&self) -> Vec<Memory> {
        entities(self.doc, book_v3::MEMORY)
            .iter()
            .filter_map(|(id, v)| {
                let f = F(v);
                Some(Memory {
                    id: MemoryId::parse(id).ok()?,
                    kind: f.kind("kind").unwrap_or(MemoryKind::Directive),
                    body: f.string("body"),
                    target: f.entity_ref("target_kind", "target"),
                    target_block: f.id("target_block"),
                    source: f.kind("source").unwrap_or(MemorySource::Author),
                    origin_ref: f.opt_string("origin_ref"),
                    status: f.kind("status").unwrap_or(MemoryStatus::Active),
                    supersedes: f.id("supersedes"),
                    deleted_at: f.ts("deleted_at"),
                })
            })
            .collect()
    }

    pub fn writing_days(&self) -> Vec<WritingDay> {
        let LoroValue::Map(m) = self.doc.get_map(book_v3::WRITING_DAYS).get_deep_value() else {
            return Vec::new();
        };
        let mut v: Vec<WritingDay> = m
            .iter()
            .filter_map(|(k, w)| {
                let (device, day) = WritingDay::parse_key(k)?;
                let words = match w {
                    LoroValue::I64(i) if *i >= 0 => *i,
                    _ => return None,
                };
                Some(WritingDay { device, day, words })
            })
            .collect();
        v.sort_by(|a, b| (&a.day, &a.device).cmp(&(&b.day, &b.device)));
        v
    }

    pub fn words_on(&self, day: &dr_model::Day) -> i64 {
        self.writing_days()
            .iter()
            .filter(|w| &w.day == day)
            .map(|w| w.words)
            .sum()
    }

    // ---- prose ownership, snapshots and repairs --------------------------

    /// Whether the prose document `doc` belongs to a live or trashed owner in
    /// this v3 book (`body:<entry>/<module>`, `body:<entry>/about`,
    /// `template:<book>/<template>/<module>`, `material:<id>`, `conversation:<id>`).
    ///
    /// Note that per `V3-TEMPLATE-SWITCH-KEEPS-DATA` and `V3-ENTRY-TEMPLATE-EXISTS`,
    /// any `body:<entry>/<module>` document remains owned as long as `<entry>`
    /// still exists in the `entries` tree (even if the entry switched templates
    /// or its template was deleted).
    pub fn owns_prose(&self, doc: &DocId) -> bool {
        match doc {
            DocId::Book(b) => b == self.book,
            DocId::Conversation(_) => true,
            DocId::Body(b) => forest(&self.tree(book_v3::ENTRIES))
                .iter()
                .any(|n| n.id == b.entry().as_str()),
            DocId::Template(t) => match t.entry_module() {
                Some((book_id, tpl_id, _)) => {
                    &book_id == self.book
                        && self
                            .doc
                            .get_map(book_v3::TEMPLATES)
                            .get(tpl_id.as_str())
                            .is_some()
                }
                None => false,
            },
            DocId::Material(id) => entity(self.doc, book_v3::MATERIALS, id.as_str())
                .is_some_and(|v| F(&v).str("kind").is_none_or(|k| k == "text")),
            DocId::Node(_) | DocId::Element(_) | DocId::Storyline(_) | DocId::Category(_) => false,
        }
    }

    /// Snapshot of an entry's metadata in `entries` at this view's frontiers,
    /// for `BookTxnV3::restore_entry`.
    pub fn entry_snapshot(&self, id: &EntryId) -> Option<EntrySnapshotV3> {
        let tree = self.tree(book_v3::ENTRIES);
        let node = forest(&tree).into_iter().find(|n| n.id == id.as_str())?;
        Some(EntrySnapshotV3 { value: node.meta })
    }

    /// Raw metadata of one material folder, for selected-record restoration.
    pub fn material_folder_snapshot(&self, id: &MaterialFolderId) -> Option<EntrySnapshotV3> {
        forest(&self.tree(book_v3::MATERIAL_FOLDERS))
            .into_iter()
            .find(|n| n.id == id.as_str())
            .map(|n| EntrySnapshotV3 { value: n.meta })
    }

    /// Snapshot of a v3 structural map record, including nested maps.
    /// Patch text is restored through its mergeable text container by the writer.
    pub fn map_snapshot(&self, collection: CollectionV3, id: &str) -> Option<EntrySnapshotV3> {
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
            return None;
        }
        entity(self.doc, collection.root(), id).map(|value| EntrySnapshotV3 { value })
    }

    /// Snapshot of a map-backed entity (e.g. `Materials`) at this view's frontiers.
    pub fn entity_snapshot(&self, collection: CollectionV3, id: &str) -> Option<EntitySnapshot> {
        let mapped = match collection {
            CollectionV3::Materials => crate::book::Collection::Materials,
            CollectionV3::RelationTypes => crate::book::Collection::RelationTypes,
            CollectionV3::Relations => crate::book::Collection::Relations,
            CollectionV3::Comments => crate::book::Collection::Comments,
            CollectionV3::Assets => crate::book::Collection::Assets,
            CollectionV3::Memory => crate::book::Collection::Memory,
            _ => return None,
        };
        crate::book::BookView {
            doc: self.doc,
            book: self.book,
        }
        .entity_snapshot(mapped, id)
    }

    pub fn needs_repair(&self) -> bool {
        let symmetric: HashSet<RelationTypeId> = self
            .relation_types()
            .into_iter()
            .filter(|t| t.orientation == RelationOrientation::Symmetric)
            .map(|t| t.id)
            .collect();
        let mut seen = HashSet::new();
        self.relations_raw()
            .iter()
            .any(|r| !seen.insert(Self::semantic_key(r, symmetric.contains(&r.relation_type))))
    }

    pub fn repair_plan(&self) -> RepairPlanV3 {
        let mut plan = RepairPlanV3::default();
        let symmetric: HashSet<RelationTypeId> = self
            .relation_types()
            .into_iter()
            .filter(|t| t.orientation == RelationOrientation::Symmetric)
            .map(|t| t.id)
            .collect();
        let mut kept: HashSet<(EntityRef, EntityRef, RelationTypeId)> = HashSet::new();
        for r in self.relations_raw() {
            let key = Self::semantic_key(&r, symmetric.contains(&r.relation_type));
            if !kept.insert(key) {
                plan.duplicate_relations.push(r.id.clone());
            }
        }
        plan
    }
}
