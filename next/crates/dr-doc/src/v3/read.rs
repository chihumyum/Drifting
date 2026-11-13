//! Read-tolerant views of a book document (`kernel-v4.md`).

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use dr_model::id::*;
use dr_model::kind::*;
use dr_model::pos::cmp_pos;
use dr_model::shared::*;
use dr_model::v3::*;
use dr_model::{DocId, Timestamp};
use loro::{LoroDoc, LoroMap, LoroTree, LoroValue, TreeID};

use crate::catalog::EntitySnapshot;
use crate::catalog::fields::{F, kv_entries};
use crate::catalog::read::{
    ForestNode, forest, forest_entry_headers, forest_entry_status, forest_ids, forest_node,
};
use crate::schema::book_v3;
use crate::v3::CollectionV3;
use crate::{DocError, Result};

/// Stored metadata of a v3 [`Entry`] at a history point (`BookReaderV3::load_at`),
/// for restoring per-entry metadata (`BookTxnV3::restore_entry`).
#[derive(Clone, Debug, PartialEq)]
pub struct EntrySnapshotV3 {
    pub(crate) value: LoroValue,
}

/// The only paths changed by a timeline's local edits and their inverses.
/// A lane's position is separate from its record so ordering never restores
/// unrelated metadata from an older snapshot.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum TimelineFieldV3 {
    Name,
    Lane(EntryId),
    LanePosition(EntryId),
    LaneActTrack(EntryId),
    Placement(EntryId),
}
impl TimelineFieldV3 {
    pub(crate) fn path(&self) -> Vec<&str> {
        match self {
            Self::Name => vec!["name"],
            Self::Lane(id) => vec!["lanes", id.as_str()],
            Self::LanePosition(id) => vec!["lanes", id.as_str(), "pos"],
            Self::LaneActTrack(id) => vec!["lanes", id.as_str(), "act_track"],
            Self::Placement(id) => vec!["placements", id.as_str()],
        }
    }
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
    let home = match raw("home") {
        Some(LoroValue::Null) => Some(None),
        Some(LoroValue::String(s)) => EntryId::parse(s).ok().map(Some),
        _ => None,
    };
    LevelSettingsOverride {
        default_template,
        display: f.kind("display"),
        auto_link: f.bool("auto_link"),
        accept: f.bool("accept"),
        home,
        is_manuscript: f.bool("is_manuscript"),
        format_shortcuts: f.kind("format_shortcuts"),
        lane: f.bool("lane"),
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

/// One structural read of a book ([`BookViewV3::graph`]): entry headers,
/// templates and stored memberships. Clone it, apply a planned write, and
/// compare with [`dr_model::v3::check_new_violations`].
#[derive(Clone, Debug, PartialEq)]
pub struct BookGraphV3 {
    pub entries: BTreeMap<EntryId, Entry>,
    pub templates: BTreeMap<EntryTemplateId, EntryTemplate>,
    pub memberships: Vec<Membership>,
}

impl BookGraphV3 {
    pub fn as_graph(&self) -> BookGraph<'_> {
        BookGraph {
            entries: &self.entries,
            templates: &self.templates,
            memberships: &self.memberships,
        }
    }

    /// Refuse `self` (the book after a planned write) only for a violation
    /// `before` did not have.
    pub fn check_against(
        &self,
        before: &BookGraphV3,
    ) -> std::result::Result<(), dr_model::check::Violation> {
        check_new_violations(before.as_graph(), self.as_graph())
    }
}

/// Read-only view of a v3 book document.
#[derive(Clone, Copy)]
pub struct BookViewV3<'a> {
    pub(crate) doc: &'a LoroDoc,
    pub(crate) book: &'a BookId,
}

impl<'a> BookViewV3<'a> {
    /// A selected native field, preflighted without decoding the whole view.
    /// Records must be mergeable maps; scalars preserve absence/null/string.
    pub fn timeline_field_snapshot(
        &self,
        id: &TimelineViewId,
        field: &TimelineFieldV3,
    ) -> Result<Option<LoroValue>> {
        use loro::{Container, ValueOrContainer};
        let (parent, key) = self.timeline_field_parent(id, field)?;
        let Some(parent) = parent else {
            return Ok(None);
        };
        let value = parent.get(&key);
        match field {
            TimelineFieldV3::Name | TimelineFieldV3::LanePosition(_) => match &value {
                None | Some(ValueOrContainer::Value(LoroValue::Null | LoroValue::String(_))) => {}
                _ => {
                    return Err(DocError::NotInProfile(
                        "timeline scalar uses an unsupported representation",
                    ));
                }
            },
            TimelineFieldV3::LaneActTrack(_) => match &value {
                None | Some(ValueOrContainer::Value(LoroValue::Null | LoroValue::Bool(_))) => {}
                _ => {
                    return Err(DocError::NotInProfile(
                        "timeline scalar uses an unsupported representation",
                    ));
                }
            },
            TimelineFieldV3::Lane(_) | TimelineFieldV3::Placement(_) => match &value {
                None => {}
                Some(ValueOrContainer::Container(Container::Map(_))) => {
                    check_restorable_field(&parent, &key)?
                }
                _ => {
                    return Err(DocError::NotInProfile(
                        "timeline record is not a restorable map",
                    ));
                }
            },
        }
        Ok(value.map(|v| match v {
            ValueOrContainer::Value(v) => v,
            ValueOrContainer::Container(Container::Map(m)) => m.get_deep_value(),
            _ => unreachable!("preflighted field"),
        }))
    }

    /// Selected-field CAS state: parent presence, key presence, and value.
    /// For whole records the value includes their retained native map even
    /// after deletion, so offline peer writes cannot be erased by undo.
    pub fn timeline_field_restore_state(
        &self,
        id: &TimelineViewId,
        field: &TimelineFieldV3,
    ) -> Result<(bool, bool, Option<LoroValue>)> {
        let value = self.timeline_field_snapshot(id, field)?;
        let (parent, key) = self.timeline_field_parent(id, field)?;
        let Some(parent) = parent else {
            // An absent empty parent can still retain this deleted child's
            // map. Inspect it before a first add could resurrect unknown data.
            use loro::{Container, ContainerID, ContainerTrait, ContainerType};
            let parent_key = match field {
                TimelineFieldV3::Lane(_) => "lanes",
                TimelineFieldV3::Placement(_) => "placements",
                _ => unreachable!("required scalar parent"),
            };
            let root = self.doc.get_map(book_v3::TIMELINE_VIEWS);
            let view = ContainerID::new_mergeable(&root.id(), id.as_str(), ContainerType::Map);
            let parent_id = ContainerID::new_mergeable(&view, parent_key, ContainerType::Map);
            let retained = match self.doc.get_container(parent_id) {
                Some(Container::Map(parent)) => retained_record_state(self.doc, &parent, &key)?.1,
                _ => None,
            };
            return Ok((false, false, retained));
        };
        match field {
            TimelineFieldV3::Lane(_) | TimelineFieldV3::Placement(_) => {
                let (present, retained) = retained_record_state(self.doc, &parent, &key)?;
                Ok((true, present, retained))
            }
            _ => Ok((true, value.is_some(), value)),
        }
    }

    fn timeline_field_parent(
        &self,
        id: &TimelineViewId,
        field: &TimelineFieldV3,
    ) -> Result<(Option<LoroMap>, String)> {
        let root = self.doc.get_map(book_v3::TIMELINE_VIEWS);
        let view =
            selected_timeline_map(self.doc, &root, id.as_str(), false)?.expect("required view");
        match field {
            TimelineFieldV3::Name => Ok((Some(view), "name".into())),
            TimelineFieldV3::Lane(lane) => Ok((
                selected_timeline_map(self.doc, &view, "lanes", true)?,
                lane.to_string(),
            )),
            TimelineFieldV3::Placement(entry) => Ok((
                selected_timeline_map(self.doc, &view, "placements", true)?,
                entry.to_string(),
            )),
            TimelineFieldV3::LanePosition(lane) => {
                let lanes = selected_timeline_map(self.doc, &view, "lanes", false)?
                    .expect("required lanes");
                Ok((
                    selected_timeline_map(self.doc, &lanes, lane.as_str(), false)?,
                    "pos".into(),
                ))
            }
            TimelineFieldV3::LaneActTrack(lane) => {
                let lanes = selected_timeline_map(self.doc, &view, "lanes", false)?
                    .expect("required lanes");
                Ok((
                    selected_timeline_map(self.doc, &lanes, lane.as_str(), false)?,
                    "act_track".into(),
                ))
            }
        }
    }

    pub fn book_id(&self) -> &BookId {
        self.book
    }

    /// Current applied frontier, including pending operations. Read on the
    /// holder thread when capturing a command's expected post-write state;
    /// this does not commit or claim authority over a later read.
    pub fn state_frontiers(&self) -> loro::Frontiers {
        self.doc.state_frontiers()
    }

    /// Whether a membership snapshot can be restored without flattening an
    /// unknown CRDT container. This is a read-only preflight, not a decoder.
    pub fn check_membership_snapshot_restore(
        &self,
        host: &EntryId,
        member: &EntryId,
    ) -> Result<()> {
        use loro::{Container, ValueOrContainer};
        let root = self.doc.get_map(book_v3::MEMBERSHIPS);
        let key = Membership::key(host, member);
        match root.get(&key) {
            None => Ok(()),
            Some(ValueOrContainer::Container(Container::Map(_))) => {
                check_restorable_field(&root, &key)
            }
            // map_snapshot intentionally filters these out. Never use its
            // absence as proof that a raw key is absent or safe to delete.
            Some(_) => Err(DocError::NotInProfile(
                "membership record is not a restorable map",
            )),
        }
    }

    /// CAS state for a selected membership, including its retained map after
    /// deletion. A peer can edit that map concurrently before receiving the
    /// cancellation; sync keeps those operations even while its key is absent.
    pub fn membership_restore_state(
        &self,
        host: &EntryId,
        member: &EntryId,
    ) -> Result<(bool, Option<LoroValue>)> {
        self.check_membership_snapshot_restore(host, member)?;
        retained_record_state(
            self.doc,
            &self.doc.get_map(book_v3::MEMBERSHIPS),
            &Membership::key(host, member),
        )
    }

    /// Only the selected primary field is inspected, never other entry data.
    /// The inverse preserves absence/null/string; future representations must
    /// be handled explicitly before a cancellation may overwrite them.
    pub fn check_primary_restore(&self, member: &EntryId) -> Result<()> {
        use loro::ValueOrContainer;
        let tree = self.tree(book_v3::ENTRIES);
        let node = forest(&tree)
            .into_iter()
            .find(|n| n.id == member.as_str())
            .ok_or_else(|| DocError::Missing {
                collection: book_v3::ENTRIES,
                id: member.to_string(),
            })?;
        for node in node.tree_ids {
            match tree.get_meta(node)?.get("primary") {
                None | Some(ValueOrContainer::Value(LoroValue::Null | LoroValue::String(_))) => {}
                _ => {
                    return Err(DocError::NotInProfile(
                        "primary uses an unsupported representation",
                    ));
                }
            }
        }
        Ok(())
    }

    /// Inspect just this member's placement. Other positions, pins, hidden
    /// entries and future view fields do not constrain a scoped cancellation.
    pub fn check_timeline_placement_restore(
        &self,
        view: &TimelineViewId,
        member: &EntryId,
    ) -> Result<()> {
        use loro::{Container, ContainerID, ContainerTrait, ContainerType, ValueOrContainer};
        self.check_timeline_placement_write(view)?;
        let Some(ValueOrContainer::Container(Container::Map(record))) =
            self.doc.get_map(book_v3::TIMELINE_VIEWS).get(view.as_str())
        else {
            unreachable!("preflighted view")
        };
        let Some(ValueOrContainer::Container(Container::Map(placements))) =
            record.get("placements")
        else {
            return Err(DocError::NotInProfile(
                "selected placements parent is absent",
            ));
        };
        if placements.id()
            != ContainerID::new_mergeable(&record.id(), "placements", ContainerType::Map)
        {
            return Err(DocError::NotInProfile(
                "selected placements parent is not mergeable",
            ));
        }
        check_restorable_field(&placements, member.as_str())
    }

    /// CAS state for just this placement's live/retained record. The selected
    /// parent path must keep its known identity; never resurrect a replaced
    /// parent map and with it other entries that the inverse did not select.
    pub fn timeline_placement_restore_state(
        &self,
        view: &TimelineViewId,
        member: &EntryId,
    ) -> Result<(bool, Option<LoroValue>)> {
        use loro::{Container, ValueOrContainer};
        self.check_timeline_placement_restore(view, member)?;
        let Some(ValueOrContainer::Container(Container::Map(record))) =
            self.doc.get_map(book_v3::TIMELINE_VIEWS).get(view.as_str())
        else {
            unreachable!("preflighted view")
        };
        let Some(ValueOrContainer::Container(Container::Map(placements))) =
            record.get("placements")
        else {
            unreachable!("preflighted placements")
        };
        retained_record_state(self.doc, &placements, member.as_str())
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
                                let default_value = ff
                                    .get("default_value")
                                    .and_then(decode_field_value)
                                    .filter(|v| !matches!(v, FieldValue::Null));
                                Some(FieldDef {
                                    id: fid,
                                    name: ff.string("name"),
                                    field_type: ff.kind("field_type").unwrap_or(FieldType::Text),
                                    options,
                                    target_template: ff.id("target_template"),
                                    default_value,
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
                                let default_value = ff
                                    .get("default_value")
                                    .and_then(decode_field_value)
                                    .filter(|v| !matches!(v, FieldValue::Null));
                                Some(FieldDef {
                                    id: fid.clone(),
                                    name: ff.string("name"),
                                    field_type: ff.kind("field_type").unwrap_or(FieldType::Text),
                                    options,
                                    target_template: ff.id("target_template"),
                                    default_value,
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
                            in_book: c.bool("in_book").unwrap_or(default_cfg.in_book),
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

        // Settings and actions are kept whatever the default switch says:
        // they apply to entries of this template whose switch is on.
        let settings = f
            .sub("settings")
            .map(decode_level_settings_override)
            .unwrap_or_default();
        let mut verbs: Vec<TemplateVerb> = match f.get("verbs") {
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
        };
        sort_verbs(&mut verbs);

        Some(EntryTemplate {
            id: tid,
            name: f.string("name"),
            mark: f.opt_string("mark"),
            color: f.opt_string("color"),
            agent,
            modules,
            level: f.bool("level").unwrap_or(false),
            linkable: f.bool("linkable").unwrap_or(true),
            settings,
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

    /// Every reachable domain id of the tree at `root` with its tree nodes
    /// (the kept one first), reading only each node's `id`.
    pub(crate) fn tree_index(&self, root: &str) -> HashMap<String, Vec<TreeID>> {
        forest_ids(&self.tree(root))
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
            level: f.bool("level").unwrap_or(false),
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

    /// One entry with its auto-link name conflict, without reading every
    /// entry in full: the conflict comes from the book's name table over the
    /// structural [`Self::graph`].
    pub fn entry(&self, id: &EntryId) -> Option<Entry> {
        let mut e = self.entry_raw(id)?;
        let mut g = self.graph();
        resolve_autolink_name_conflicts(&mut g.entries, &g.memberships, &g.templates);
        e.name_conflict = g.entries.get(id).and_then(|h| h.name_conflict.clone());
        Some(e)
    }

    /// Single-entry lookup without computing book-wide auto-link name conflicts.
    pub fn entry_raw(&self, id: &EntryId) -> Option<Entry> {
        forest_node(&self.tree(book_v3::ENTRIES), id.as_str())
            .as_ref()
            .and_then(Self::read_entry_node)
    }

    /// Structural entry headers keyed by `EntryId`: `id`, `parent`, `title`,
    /// `template`, `level`, `overrides`, `created_at`, `deleted_at`, and the
    /// alias fields `templates` declare (the only `fields` values decoded);
    /// no `kv:*` or `layout`. Exact for the switch, settings inheritance,
    /// memberships, auto-linking and name keys (`entry_autolink_keys`).
    pub fn entry_headers_with(
        &self,
        templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
    ) -> BTreeMap<EntryId, Entry> {
        let mut alias_fields: BTreeSet<(String, String)> = BTreeSet::new();
        for t in templates.values() {
            for m in t.modules.iter().filter(|m| m.kind == ModuleKind::Fields) {
                if let Some(f) = &m.config.aliases_field {
                    alias_fields.insert((m.id.to_string(), f.clone()));
                }
                for d in m
                    .config
                    .defs
                    .iter()
                    .filter(|d| d.field_type == FieldType::Aliases)
                {
                    alias_fields.insert((m.id.to_string(), d.id.clone()));
                }
            }
        }
        let alias_fields: Vec<_> = alias_fields.into_iter().collect();
        let headers = forest_entry_headers(&self.tree(book_v3::ENTRIES), &alias_fields);
        let valid_ids: HashSet<&str> = headers
            .iter()
            .filter(|h| EntryId::parse(&h.id).is_ok())
            .map(|h| h.id.as_str())
            .collect();
        let mut out = BTreeMap::new();
        for h in &headers {
            let Ok(id) = EntryId::parse(&h.id) else {
                continue;
            };
            let parent = h
                .parent
                .as_deref()
                .filter(|p| valid_ids.contains(*p))
                .and_then(|p| EntryId::parse(p).ok());
            let template = h
                .template
                .as_deref()
                .and_then(|t| EntryTemplateId::parse(t).ok());
            let overrides = h
                .overrides
                .as_ref()
                .map(|v| decode_level_settings_override(F(v)))
                .filter(|o| !o.is_empty());
            let mut fields: BTreeMap<ModuleId, BTreeMap<String, FieldValue>> = BTreeMap::new();
            for (module, field, value) in &h.fields {
                if let (Ok(module), Some(value)) =
                    (ModuleId::parse(module), decode_field_value(value))
                {
                    fields
                        .entry(module)
                        .or_default()
                        .insert(field.clone(), value);
                }
            }
            out.insert(
                id.clone(),
                Entry {
                    id,
                    parent,
                    pos: String::new(),
                    title: h.title.clone(),
                    template,
                    level: h.level,
                    overrides,
                    fields,
                    kv: BTreeMap::new(),
                    primary: None,
                    layout: EntryLayout::default(),
                    created_at: h.created_at,
                    updated_at: None,
                    deleted_at: h.deleted_at,
                    name_conflict: None,
                },
            );
        }
        out
    }

    /// [`Self::entry_headers_with`] this book's own templates.
    pub fn entry_headers(&self) -> BTreeMap<EntryId, Entry> {
        self.entry_headers_with(&self.templates_map())
    }

    /// What the structural invariants look at, in one read: the entry
    /// headers ([`Self::entry_headers_with`]), every template and every stored
    /// membership. Compare two with [`dr_model::v3::check_new_violations`].
    pub fn graph(&self) -> BookGraphV3 {
        let templates = self.templates_map();
        BookGraphV3 {
            entries: self.entry_headers_with(&templates),
            templates,
            memberships: self.memberships_raw(),
        }
    }

    /// Effective parent of `id` after applying `V3-LEAF-NO-CHILDREN` tolerance
    /// (children placed under a leaf by a concurrent merge are lifted to the
    /// nearest non-leaf ancestor).
    pub fn effective_parent(&self, id: &EntryId) -> Option<EntryId> {
        let entries = self.entry_headers_with(&BTreeMap::new());
        let e = entries.get(id)?;
        effective_parent_id(e, &entries)
    }

    /// Live child entries whose effective parent is `parent`, in manuscript
    /// order (`entries` depth-first tree order).
    pub fn children_of(&self, parent: Option<&EntryId>) -> Vec<Entry> {
        let ordered = self.entries();
        let entries: BTreeMap<EntryId, Entry> =
            ordered.iter().map(|e| (e.id.clone(), e.clone())).collect();
        ordered
            .into_iter()
            .filter(|e| !e.is_trashed() && effective_parent_id(e, &entries).as_ref() == parent)
            .collect()
    }

    ///Resolved level settings for `level_id` (`entry.overrides > template.settings > nearest ancestor > default`).
    pub fn level_settings(&self, level_id: Option<&EntryId>) -> LevelSettings {
        let templates = self.templates_map();
        let entries = self.entry_headers_with(&templates);
        resolve_level_settings(level_id, &entries, &templates)
    }

    /// Outermost live manuscript levels (`V3-MANUSCRIPT-NO-NEST`).
    pub fn manuscript_levels(&self) -> BTreeSet<EntryId> {
        let templates = self.templates_map();
        let entries = self.entry_headers_with(&templates);
        effective_manuscript_levels(&entries, &templates)
    }

    /// Auto-linked entries whose title or alias collides with an earlier
    /// auto-linked entry: `(colliding_entry, winner_entry)`.
    pub fn autolink_name_conflicts(&self) -> Vec<(EntryId, EntryId)> {
        let mut g = self.graph();
        resolve_autolink_name_conflicts(&mut g.entries, &g.memberships, &g.templates)
            .into_iter()
            .collect()
    }

    /// Find the first live root entry (`parent == None && !is_trashed()`) in
    /// manuscript order whose `template` equals `template_id`.
    pub fn root_entry_by_template(&self, template_id: &EntryTemplateId) -> Option<Entry> {
        self.children_of(None)
            .into_iter()
            .find(|e| e.template.as_ref() == Some(template_id))
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

    /// Valid memberships (`V3-MEMBERSHIP-RULES`: both ends live, the host's
    /// switch on and its `accept` resolved on).
    pub fn memberships(&self) -> Vec<Membership> {
        let g = self.graph();
        filter_valid_memberships(&g.memberships, &g.entries, &g.templates)
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
                    let lf = F(lv);
                    Some(TimelineLane {
                        entry: EntryId::parse(eid).ok()?,
                        pos: lf.pos("pos"),
                        act_track: lf.bool("act_track"),
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
        self.timeline_views_with(&entries, &templates, &memberships)
    }

    /// Read-tolerant timeline views resolved against already-loaded `entries`,
    /// `templates` and `memberships` from the same book snapshot.
    pub fn timeline_views_with(
        &self,
        entries: &BTreeMap<EntryId, Entry>,
        templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
        memberships: &[Membership],
    ) -> Vec<TimelineView> {
        let mut out: Vec<TimelineView> = self
            .timeline_views_raw()
            .into_iter()
            .map(|mut v| {
                let placements = effective_timeline_placements(&v, memberships, entries, templates);
                let lanes = effective_timeline_lanes(&v.lanes, entries, templates);
                let pins = effective_timeline_pins(&v.pins, entries);
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
        let (_, entry_ids) = forest_entry_status(&self.tree(book_v3::ENTRIES));
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
        use loro::{Container, ValueOrContainer};
        let str_val = |m: &LoroMap, key: &str| -> Option<String> {
            match m.get(key)? {
                ValueOrContainer::Value(LoroValue::String(s)) if !s.is_empty() => {
                    Some(s.to_string())
                }
                _ => None,
            }
        };
        let ts_val = |m: &LoroMap, key: &str| -> Option<Timestamp> {
            match m.get(key)? {
                ValueOrContainer::Value(LoroValue::I64(i)) => Some(Timestamp(i)),
                ValueOrContainer::Value(LoroValue::Double(d))
                    if d.is_finite() && d.fract() == 0.0 =>
                {
                    Some(Timestamp(d as i64))
                }
                _ => None,
            }
        };
        let mut out = Vec::new();
        self.doc.get_map(book_v3::RELATIONS).for_each(|id, val| {
            let ValueOrContainer::Container(Container::Map(m)) = val else {
                return;
            };
            let Some(rel_id) = RelationId::parse(id).ok() else {
                return;
            };
            let (Some(fk), Some(fid), Some(tk), Some(tid), Some(ty)) = (
                str_val(&m, "from_kind"),
                str_val(&m, "from"),
                str_val(&m, "to_kind"),
                str_val(&m, "to"),
                str_val(&m, "type").and_then(|s| RelationTypeId::parse(&s).ok()),
            ) else {
                return;
            };
            out.push(Relation {
                id: rel_id,
                from: EntityRef::new(EntityKind::from(fk.as_str()), fid),
                to: EntityRef::new(EntityKind::from(tk.as_str()), tid),
                relation_type: ty,
                created_at: ts_val(&m, "created_at"),
            });
        });
        out.sort_by(|a, b| a.id.cmp(&b.id));
        out
    }

    fn entity_map(&self, root: &str, id: &str) -> Option<LoroMap> {
        match self.doc.get_map(root).get(id)? {
            loro::ValueOrContainer::Container(loro::Container::Map(m)) => Some(m),
            _ => None,
        }
    }

    fn entry_existence_sets(&self) -> (HashSet<String>, HashSet<String>) {
        forest_entry_status(&self.tree(book_v3::ENTRIES))
    }

    fn entity_exists_with(
        &self,
        r: &EntityRef,
        entries: Option<&(HashSet<String>, HashSet<String>)>,
    ) -> bool {
        match r.kind {
            EntityKind::Entry => match entries {
                Some((live, _)) => live.contains(&r.id),
                None => forest_node(&self.tree(book_v3::ENTRIES), &r.id)
                    .is_some_and(|n| F(&n.meta).ts("deleted_at").is_none()),
            },
            EntityKind::Patch => self.entity_map(book_v3::PATCHES, &r.id).is_some_and(|m| {
                matches!(
                    m.get("entry"),
                    Some(loro::ValueOrContainer::Value(LoroValue::String(e)))
                        if match entries {
                            Some((_, all)) => all.contains(e.as_str()),
                            None => forest_node(&self.tree(book_v3::ENTRIES), e.as_str())
                                .is_some(),
                        }
                )
            }),
            EntityKind::Comment => self.entity_map(book_v3::COMMENTS, &r.id).is_some(),
            EntityKind::Material => self.entity_map(book_v3::MATERIALS, &r.id).is_some(),
            _ => false,
        }
    }

    /// Whether `r` names an entity that exists and is not in the trash in v3.
    pub fn entity_exists(&self, r: &EntityRef) -> bool {
        self.entity_exists_with(r, None)
    }

    pub fn relations(&self) -> Vec<Relation> {
        self.visible_relations(None, |_| true)
    }

    pub fn relations_of(&self, end: &EntityRef) -> Vec<Relation> {
        self.visible_relations(None, |r| &r.from == end || &r.to == end)
    }

    pub fn relations_matching(&self, keep: impl Fn(&Relation) -> bool) -> Vec<Relation> {
        self.visible_relations(None, keep)
    }

    pub fn relations_matching_with_entries(
        &self,
        entries: &(HashSet<String>, HashSet<String>),
        keep: impl Fn(&Relation) -> bool,
    ) -> Vec<Relation> {
        self.visible_relations(Some(entries), keep)
    }

    fn visible_relations(
        &self,
        precomputed_entries: Option<&(HashSet<String>, HashSet<String>)>,
        keep: impl Fn(&Relation) -> bool,
    ) -> Vec<Relation> {
        let raw: Vec<Relation> = self
            .relations_raw()
            .into_iter()
            .filter(|r| keep(r))
            .collect();
        if raw.is_empty() {
            return Vec::new();
        }
        let types: HashMap<RelationTypeId, RelationTypeV3> = self
            .relation_types()
            .into_iter()
            .map(|t| (t.id.clone(), t))
            .collect();
        let needs_templates = raw.iter().any(|r| {
            types
                .get(&r.relation_type)
                .is_some_and(|t| !t.source_templates.is_empty() || !t.target_templates.is_empty())
        });
        let full_entries_and_tpls: Option<(
            HashMap<String, Entry>,
            BTreeMap<EntryTemplateId, EntryTemplate>,
        )> = needs_templates.then(|| {
            let entries = self
                .entry_headers()
                .into_iter()
                .map(|(k, e)| (k.to_string(), e))
                .collect();
            (entries, self.templates_map())
        });
        let owned_entry_sets = if full_entries_and_tpls.is_none() && precomputed_entries.is_none() {
            Some(self.entry_existence_sets())
        } else {
            None
        };
        let entry_sets = precomputed_entries.or(owned_entry_sets.as_ref());
        let mut seen: HashSet<(EntityRef, EntityRef, RelationTypeId)> = HashSet::new();
        let mut out = Vec::new();
        for r in raw {
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
                let Some((entries, templates)) = full_entries_and_tpls.as_ref() else {
                    return true;
                };
                entries
                    .get(&end.id)
                    .and_then(|e| e.effective_template(templates))
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
                EntityKind::Entry => match (&full_entries_and_tpls, entry_sets) {
                    (Some((entries, _)), _) => {
                        entries.get(&end.id).is_some_and(|e| !e.is_trashed())
                    }
                    (_, Some((live, _))) => live.contains(&end.id),
                    _ => false,
                },
                _ => self.entity_exists_with(end, entry_sets),
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

    fn read_comment_with(
        &self,
        id: &str,
        v: &LoroValue,
        entries: Option<&(HashSet<String>, HashSet<String>)>,
    ) -> Option<CommentV3> {
        let f = F(v);
        let target = f.entity_ref("target_kind", "target");
        let target_missing = target
            .as_ref()
            .is_some_and(|t| !self.entity_exists_with(t, entries));
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
        self.read_comment_with(id.as_str(), &v, None)
    }

    pub fn comments(&self) -> Vec<CommentV3> {
        let raw = entities(self.doc, book_v3::COMMENTS);
        if raw.is_empty() {
            return Vec::new();
        }
        let needs_entries = raw.iter().any(|(_, v)| {
            F(v).entity_ref("target_kind", "target")
                .is_some_and(|t| matches!(t.kind, EntityKind::Entry | EntityKind::Patch))
        });
        let entries = needs_entries.then(|| self.entry_existence_sets());
        raw.iter()
            .filter_map(|(id, v)| self.read_comment_with(id, v, entries.as_ref()))
            .collect()
    }

    pub fn comments_with_entries(
        &self,
        entries: &(HashSet<String>, HashSet<String>),
    ) -> Vec<CommentV3> {
        let raw = entities(self.doc, book_v3::COMMENTS);
        if raw.is_empty() {
            return Vec::new();
        }
        raw.iter()
            .filter_map(|(id, v)| self.read_comment_with(id, v, Some(entries)))
            .collect()
    }

    /// `(id, target, target_module, anchor)` for every anchored comment without
    /// scanning the entry tree (`target_missing` is not needed to carry anchors).
    pub fn anchored_comments(
        &self,
    ) -> Vec<(CommentId, EntityRef, Option<ModuleId>, EncodedAnchor)> {
        entities(self.doc, book_v3::COMMENTS)
            .into_iter()
            .filter_map(|(id, v)| {
                let f = F(&v);
                let anchor = f.anchor("anchor")?;
                let target = f.entity_ref("target_kind", "target")?;
                Some((CommentId::parse(&id).ok()?, target, f.id("module"), anchor))
            })
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

    pub fn material_titles(&self) -> HashMap<String, String> {
        use loro::{Container, ValueOrContainer};
        let mut out = HashMap::new();
        self.doc.get_map(book_v3::MATERIALS).for_each(|id, val| {
            let ValueOrContainer::Container(Container::Map(m)) = val else {
                return;
            };
            if MaterialId::parse(id).is_err() {
                return;
            }
            let title = match m.get("title") {
                Some(ValueOrContainer::Value(LoroValue::String(s))) => s.to_string(),
                _ => String::new(),
            };
            out.insert(id.to_owned(), title);
        });
        out
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

    // ---- prose ownership, snapshots and repairs --------------------------

    /// Whether the prose document `doc` belongs to a live or trashed owner in
    /// this book (`body:<entry>/<module>`, `template:<book>/<template>/<module>`,
    /// `material:<id>`, `conversation:<id>`, and the two documents beside the book).
    ///
    /// Note that per `V3-TEMPLATE-SWITCH-KEEPS-DATA` and `V3-ENTRY-TEMPLATE-EXISTS`,
    /// any `body:<entry>/<module>` document remains owned as long as `<entry>`
    /// still exists in the `entries` tree (even if the entry switched templates
    /// or its template was deleted).
    pub fn owns_prose(&self, doc: &DocId) -> bool {
        match doc {
            DocId::Book(b) | DocId::Stats(b) | DocId::Checkpoints(b) => b == self.book,
            DocId::Conversation(_) => true,
            DocId::Body(b) => {
                forest_node(&self.tree(book_v3::ENTRIES), b.entry().as_str()).is_some()
            }
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

    /// Complete raw records owned by an entry, including hidden/retained data.
    /// Templates, child entries and timeline views belong to the book, not this entry.
    pub fn entry_owned_records(
        &self,
        id: &EntryId,
    ) -> BTreeMap<CollectionV3, BTreeMap<String, EntrySnapshotV3>> {
        let patches = entities(self.doc, book_v3::PATCHES)
            .into_iter()
            .filter(|(_, v)| F(v).str("entry") == Some(id.as_str()))
            .collect::<BTreeMap<_, _>>();
        let mut result = BTreeMap::new();
        for collection in [
            CollectionV3::Patches,
            CollectionV3::PlotGrids,
            CollectionV3::Memberships,
            CollectionV3::Relations,
        ] {
            let rows = entities(self.doc, collection.root())
                .into_iter()
                .filter(|(key, value)| {
                    let f = F(value);
                    match collection {
                        CollectionV3::Patches => patches.contains_key(key),
                        CollectionV3::PlotGrids => key.starts_with(&format!("{id}/")),
                        CollectionV3::Memberships => {
                            f.str("member") == Some(id.as_str())
                                || f.str("host") == Some(id.as_str())
                                || key
                                    .split_once('|')
                                    .is_some_and(|(h, m)| h == id.as_str() || m == id.as_str())
                        }
                        CollectionV3::Relations => [("from_kind", "from"), ("to_kind", "to")]
                            .iter()
                            .any(|(kind, end)| {
                                f.str(kind) == Some("entry") && f.str(end) == Some(id.as_str())
                                    || f.str(kind) == Some("patch")
                                        && f.str(end).is_some_and(|p| patches.contains_key(p))
                            }),
                        _ => false,
                    }
                })
                .map(|(id, value)| (id, EntrySnapshotV3 { value }))
                .collect();
            result.insert(collection, rows);
        }
        result
    }

    /// Raw owned content with explicit container kinds and rich-text deltas.
    /// Unlike deep JSON, this also distinguishes a text/list/map container
    /// from a plain value and retains future nested text attributes.
    ///
    /// For previews and for checking a restoration. Its `siblings` list every
    /// entry beside this one, so it is not what decides whether the entry
    /// changed ([`Self::entry_change_state`] is), and it reads the whole
    /// book: ask for one entry, never for each in turn.
    pub fn entry_owned_raw_state(&self, id: &EntryId) -> Option<serde_json::Value> {
        use super::raw::raw_value as raw;
        use loro::{Container, ValueOrContainer};
        let e = self.entry(id)?;
        let node = *self
            .tree_index(book_v3::ENTRIES)
            .get(id.as_str())?
            .first()?;
        let metadata = raw(ValueOrContainer::Container(Container::Map(
            self.doc.get_tree(book_v3::ENTRIES).get_meta(node).ok()?,
        )));
        let records: BTreeMap<_, _> = self
            .entry_owned_records(id)
            .into_iter()
            .map(|(c, rows)| {
                let map = self.doc.get_map(c.root());
                let rows: BTreeMap<_, _> = rows
                    .into_keys()
                    .filter_map(|key| map.get(&key).map(|v| (key, raw(v))))
                    .collect();
                (c.root().to_owned(), rows)
            })
            .collect();
        let siblings: Vec<_> = self
            .entries_raw()
            .into_iter()
            .filter(|s| s.parent == e.parent)
            .map(|s| s.id)
            .collect();
        let mut value = serde_json::json!({"metadata":metadata,"records":records,"parent":e.parent,"siblings":siblings});
        value.sort_all_objects();
        Some(value)
    }

    /// What decides whether an entry changed (the automatic checkpoints'
    /// fingerprint): its raw metadata and the raw records it owns, exactly as
    /// in [`Self::entry_owned_raw_state`], where it lives (`parent`) and its
    /// own place among its siblings (`position`).
    ///
    /// It names no entry but this one and its parent. The place is the
    /// entry's own position key (the fractional index of its tree node), not
    /// the list of its siblings: moving the entry among its siblings or to
    /// another parent changes the state, and another entry created, deleted
    /// or moved beside it does not. Loro gives a neighbour a new key only
    /// when two siblings hold the same key and a third goes between them;
    /// those neighbours' own keys then did change.
    ///
    /// When two devices each made a tree node for one entry id, metadata,
    /// parent and position are those of the node every reader keeps (the
    /// first by tree id), whose key is also the one that orders the entry.
    /// Tree ids themselves are left out, so a second node arriving with the
    /// same content is no change.
    pub fn entry_change_state(&self, id: &EntryId) -> Option<serde_json::Value> {
        self.change_states(Some(id)).pop().map(|(_, state)| state)
    }

    /// [`Self::entry_change_state`] of every entry, in tree order, from one
    /// pass over the tree and the four record collections: linear in the
    /// book, where asking entry by entry reads the whole book for each.
    pub fn entry_change_states(&self) -> Vec<(EntryId, serde_json::Value)> {
        self.change_states(None)
    }

    fn change_states(&self, only: Option<&EntryId>) -> Vec<(EntryId, serde_json::Value)> {
        use super::raw::raw_value as raw;
        use loro::{Container, ValueOrContainer};
        // The collections of `entry_owned_records`, in its order.
        const OWNED: [CollectionV3; 4] = [
            CollectionV3::Patches,
            CollectionV3::PlotGrids,
            CollectionV3::Memberships,
            CollectionV3::Relations,
        ];
        let tree = self.tree(book_v3::ENTRIES);
        let nodes = match only {
            Some(id) => forest_node(&tree, id.as_str()).into_iter().collect(),
            None => forest(&tree),
        };
        let entries: Vec<(EntryId, &ForestNode, TreeID)> = nodes
            .iter()
            .filter_map(|n| Some((EntryId::parse(&n.id).ok()?, n, *n.tree_ids.first()?)))
            .collect();
        let slot: HashMap<&str, usize> = entries
            .iter()
            .enumerate()
            .map(|(i, (_, n, _))| (n.id.as_str(), i))
            .collect();
        // Every record's owners, by the rules of `entry_owned_records` read
        // from the record's side.
        let mut owned: Vec<[BTreeSet<String>; 4]> = vec![Default::default(); entries.len()];
        let mut own = |collection: usize, owner: &str, key: &str| {
            if let Some(&i) = slot.get(owner) {
                owned[i][collection].insert(key.to_owned());
            }
        };
        let patches = entities(self.doc, book_v3::PATCHES);
        let mut patch_owner: HashMap<&str, &str> = HashMap::new();
        for (key, value) in &patches {
            if let Some(owner) = F(value).str("entry") {
                patch_owner.insert(key, owner);
                own(0, owner, key);
            }
        }
        for (key, _) in entities(self.doc, OWNED[1].root()) {
            // `<entry>/<module>`: every prefix that ends before a slash.
            for (at, _) in key.match_indices('/') {
                own(1, &key[..at], &key);
            }
        }
        for (key, value) in entities(self.doc, OWNED[2].root()) {
            let f = F(&value);
            let (host, member) = key.split_once('|').unzip();
            for owner in [f.str("member"), f.str("host"), host, member]
                .into_iter()
                .flatten()
            {
                own(2, owner, &key);
            }
        }
        for (key, value) in entities(self.doc, OWNED[3].root()) {
            let f = F(&value);
            for (kind, end) in [("from_kind", "from"), ("to_kind", "to")] {
                let owner = match (f.str(kind), f.str(end)) {
                    (Some("entry"), Some(entry)) => Some(entry),
                    (Some("patch"), Some(patch)) => patch_owner.get(patch).copied(),
                    _ => None,
                };
                if let Some(owner) = owner {
                    own(3, owner, &key);
                }
            }
        }
        let roots = OWNED.map(|c| self.doc.get_map(c.root()));
        entries
            .iter()
            .zip(owned)
            .filter_map(|((id, n, node), owned)| {
                let metadata = raw(ValueOrContainer::Container(Container::Map(
                    tree.get_meta(*node).ok()?,
                )));
                let records: BTreeMap<_, _> = OWNED
                    .iter()
                    .zip(&roots)
                    .zip(owned)
                    .map(|((c, map), keys)| {
                        let rows: BTreeMap<_, _> = keys
                            .into_iter()
                            .filter_map(|key| map.get(&key).map(|v| (key, raw(v))))
                            .collect();
                        (c.root().to_owned(), rows)
                    })
                    .collect();
                let parent = n.parent.as_deref().and_then(|p| EntryId::parse(p).ok());
                let mut value = serde_json::json!({"metadata":metadata,"records":records,"parent":parent,"position":n.pos});
                value.sort_all_objects();
                Some((id.clone(), value))
            })
            .collect()
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
                | CollectionV3::Facts
                | CollectionV3::Memory
        ) {
            return None;
        }
        entity(self.doc, collection.root(), id).map(|value| EntrySnapshotV3 { value })
    }

    /// Snapshot of a map-backed entity (e.g. `Materials`) at this view's frontiers.
    pub fn entity_snapshot(&self, collection: CollectionV3, id: &str) -> Option<EntitySnapshot> {
        if !matches!(
            collection,
            CollectionV3::Materials
                | CollectionV3::RelationTypes
                | CollectionV3::Relations
                | CollectionV3::Comments
                | CollectionV3::Assets
                | CollectionV3::Memory
        ) {
            return None;
        }
        crate::catalog::read::CatalogView { doc: self.doc }.entity_snapshot(collection.root(), id)
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

// Deep values omit container type, rich-text attributes and list identities.
// The selected-record inverse supports mergeable maps and atomic leaf values
// only; reject every unsupported actual representation before removing data.
fn check_restorable_field(parent: &LoroMap, key: &str) -> Result<()> {
    use loro::{Container, ContainerID, ContainerTrait, ContainerType, ValueOrContainer};
    match parent.get(key) {
        None => Ok(()),
        Some(ValueOrContainer::Value(LoroValue::Map(_))) => {
            Err(DocError::NotInProfile("snapshot contains an atomic map"))
        }
        Some(ValueOrContainer::Value(_)) => Ok(()),
        Some(ValueOrContainer::Container(Container::Map(map))) => {
            if map.id() != ContainerID::new_mergeable(&parent.id(), key, ContainerType::Map) {
                return Err(DocError::NotInProfile(
                    "snapshot contains a non-mergeable map",
                ));
            }
            for key in map.keys() {
                check_restorable_field(&map, key.as_str())?;
            }
            Ok(())
        }
        Some(ValueOrContainer::Container(_)) => Err(DocError::NotInProfile(
            "snapshot contains an unsupported CRDT container",
        )),
    }
}

fn retained_record_state(
    doc: &LoroDoc,
    parent: &LoroMap,
    key: &str,
) -> Result<(bool, Option<LoroValue>)> {
    use loro::{Container, ContainerID, ContainerTrait, ContainerType};
    let id = ContainerID::new_mergeable(&parent.id(), key, ContainerType::Map);
    let retained = match doc.get_container(id) {
        Some(Container::Map(map)) => {
            for key in map.keys() {
                check_restorable_field(&map, key.as_str())?;
            }
            Some(map.get_deep_value())
        }
        None => None,
        Some(_) => unreachable!("map container id"),
    };
    Ok((parent.get(key).is_some(), retained))
}

// An absent empty parent can be created for a new view's first lane. Never
// resurrect a removed nonempty parent: that would restore unselected records.
fn selected_timeline_map(
    doc: &LoroDoc,
    parent: &LoroMap,
    key: &str,
    optional: bool,
) -> Result<Option<LoroMap>> {
    use loro::{Container, ContainerID, ContainerTrait, ContainerType, ValueOrContainer};
    let expected = ContainerID::new_mergeable(&parent.id(), key, ContainerType::Map);
    match parent.get(key) {
        Some(ValueOrContainer::Container(Container::Map(m))) if m.id() == expected => Ok(Some(m)),
        None if optional => {
            if let Some(Container::Map(retained)) = doc.get_container(expected)
                && retained.keys().next().is_some()
            {
                return Err(DocError::NotInProfile(
                    "timeline parent has hidden retained records",
                ));
            }
            Ok(None)
        }
        _ => Err(DocError::NotInProfile(
            "timeline parent is absent or not a mergeable map",
        )),
    }
}
