//! Reading the book document. Records come back **read-tolerant**: a merge
//! that broke an invariant (`dr_model::invariant`) is shown in its tolerated
//! form — a reference to an entity that is gone reads as none, a relation
//! whose end is gone is not listed, an idea's stray book order is ignored.
//! What is actually stored wrong is reported by [`BookView::repair_plan`].

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use dr_model::book::*;
use dr_model::id::*;
use dr_model::kind::*;
use dr_model::order::{CHAPTER_ORDER_STRIDE, cmp_order, sort_acts};
use dr_model::pos::cmp_pos;
use dr_model::{DocId, Timestamp};
use loro::{LoroDoc, LoroMap, LoroTree, LoroValue, TreeID, TreeParentId};

use super::fields::{F, kv_entries};
use crate::schema::book;

/// An entity's stored fields at some version, for restoring them
/// (`BookTxn::restore_fields`). Read from a detached copy at a history point.
#[derive(Clone, Debug)]
pub struct EntitySnapshot {
    value: LoroValue,
    texts: HashSet<String>,
}

impl EntitySnapshot {
    /// The stored value of one field (a set or a key/value list reads as a
    /// map, a rich text as its plain text). `None` when the field is absent.
    pub fn field(&self, key: &str) -> Option<&LoroValue> {
        F(&self.value).get(key)
    }

    pub(crate) fn value(&self, key: &str) -> Option<&LoroValue> {
        self.field(key)
    }

    pub(crate) fn is_text(&self, key: &str) -> bool {
        self.texts.contains(key)
    }

    /// The stored keys.
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

    /// The fields that differ between `self` (before) and `after`, by key:
    /// `(key, before, after)`, `None` for an absent field. For comparing an
    /// entity before an Agent write, after it, and now.
    pub fn diff(
        &self,
        after: &EntitySnapshot,
    ) -> Vec<(String, Option<LoroValue>, Option<LoroValue>)> {
        let mut keys: Vec<String> = self.keys();
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

/// The fields a history restore writes back per collection, as the old
/// `restoreMetadata` (node: title, summary, status; element: name, aliases,
/// summary, group, fields; storyline: name, summary, fields; category: name,
/// template fields). The body itself is restored on its prose document.
pub fn metadata_fields(collection: super::Collection) -> &'static [&'static str] {
    use super::Collection::*;
    match collection {
        Nodes => &["title", "summary", "status"],
        Elements => &["name", "aliases", "summary", "group_name", "facts"],
        Storylines => &["name", "summary", "facts"],
        Categories => &["name", "template_fields"],
        Materials => &["title", "description"],
        _ => &[],
    }
}

/// What reading a node needs from the rest of the book.
struct NodeCtx {
    groups: HashSet<String>,
    storylines: HashSet<String>,
}

/// A read-only view of a book document.
#[derive(Clone, Copy)]
pub struct BookView<'a> {
    pub(crate) doc: &'a LoroDoc,
    pub(crate) book: &'a BookId,
}

/// Background repairs the stored state needs. Deterministic: two devices
/// computing it from the same state write the same values.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RepairPlan {
    /// Semantic duplicates (same ends and type) beyond the smallest id.
    pub duplicate_relations: Vec<RelationId>,
    /// Chapters without a usable book order, and the order to give them
    /// (after every ordered chapter, in id order, one stride apart).
    pub chapters_without_order: Vec<(NodeId, f64)>,
    /// Ideas carrying a book order (only chapters have one).
    pub drifts_with_order: Vec<NodeId>,
    /// Chapters carrying an idea group (only ideas sit in groups).
    pub chapters_in_groups: Vec<NodeId>,
}

impl RepairPlan {
    pub fn is_empty(&self) -> bool {
        self.duplicate_relations.is_empty()
            && self.chapters_without_order.is_empty()
            && self.drifts_with_order.is_empty()
            && self.chapters_in_groups.is_empty()
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

/// One node of a tree read at the domain level.
pub(crate) struct ForestNode {
    pub(crate) id: String,
    pub(crate) parent: Option<String>,
    pub(crate) meta: LoroValue,
    /// Every live tree node carrying this domain id (the kept one first).
    pub(crate) tree_ids: Vec<TreeID>,
}

/// A tree read by domain id. Normally each domain id has one tree node, but
/// two devices can create a node for the same id (two imports that did not
/// dedupe): then the first by tree id is kept for name and parent, and the
/// children of every copy are its children. Nodes are listed depth first from
/// the roots, parents before children, siblings in tree order; a node only
/// reachable through a cycle of copies (possible at the domain level, never in
/// Loro's own tree) is not listed, and readers treat it as missing.
pub(crate) fn forest(tree: &LoroTree) -> Vec<ForestNode> {
    let mut nodes = tree.get_nodes(false);
    nodes.sort_by_key(|n| n.id);
    let mut dom: HashMap<TreeID, String> = HashMap::new();
    let mut kept: HashMap<String, (TreeID, TreeParentId, LoroValue)> = HashMap::new();
    let mut copies: HashMap<String, Vec<TreeID>> = HashMap::new();
    for n in &nodes {
        let Ok(meta) = tree.get_meta(n.id) else {
            continue;
        };
        let v = meta.get_deep_value();
        let Some(id) = F(&v).opt_string("id") else {
            continue;
        };
        dom.insert(n.id, id.clone());
        copies.entry(id.clone()).or_default().push(n.id);
        kept.entry(id).or_insert((n.id, n.parent, v));
    }
    let parent_of = |id: &str| -> Option<String> {
        let (_, parent, _) = &kept[id];
        match parent {
            TreeParentId::Node(p) => dom.get(p).filter(|d| d.as_str() != id).cloned(),
            _ => None,
        }
    };
    // Children per parent domain id, in tree order (fractional index, then
    // tree id), merged over every copy of the parent.
    let mut children: HashMap<Option<String>, Vec<(String, TreeID, String)>> = HashMap::new();
    for (id, (t, _, _)) in &kept {
        let key = tree.fractional_index(*t).unwrap_or_default();
        children
            .entry(parent_of(id))
            .or_default()
            .push((key, *t, id.clone()));
    }
    for v in children.values_mut() {
        v.sort();
    }
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut stack: Vec<String> = children
        .get(&None)
        .map(|v| v.iter().rev().map(|(_, _, id)| id.clone()).collect())
        .unwrap_or_default();
    while let Some(id) = stack.pop() {
        if !seen.insert(id.clone()) {
            continue;
        }
        if let Some(kids) = children.get(&Some(id.clone())) {
            for (_, _, k) in kids.iter().rev() {
                stack.push(k.clone());
            }
        }
        let (_, _, meta) = kept[&id].clone();
        out.push(ForestNode {
            parent: parent_of(&id),
            tree_ids: copies.remove(&id).unwrap_or_default(),
            meta,
            id,
        });
    }
    out
}

impl<'a> BookView<'a> {
    pub fn book_id(&self) -> &BookId {
        self.book
    }

    pub fn meta(&self) -> BookMeta {
        let v = self.doc.get_map(book::META).get_deep_value();
        let f = F(&v);
        BookMeta {
            id: self.book.clone(),
            schema_version: f.i64("v").unwrap_or(0),
            name: f.string("name"),
            summary: f.string("summary"),
            deleted_at: f.ts("deleted_at"),
            created_at: f.ts("created_at"),
            storyline_template: f.kv("storyline_template"),
            word_target_set: f.i64("word_target"),
            daily_word_target_set: f.i64("daily_word_target"),
        }
    }

    // ---- nodes -------------------------------------------------------

    fn read_node(&self, id: &str, v: &LoroValue, ctx: &NodeCtx) -> Option<Node> {
        let f = F(v);
        let kind = f.kind::<NodeKind>("kind").unwrap_or(NodeKind::Drift);
        let mut n = Node {
            id: NodeId::parse(id).ok()?,
            kind,
            title: f.string("title"),
            summary: f.string("summary"),
            book_order: f.f64("book_order"),
            narrative_order: f.f64("narrative_order"),
            status: f.kind("status").unwrap_or(NodeStatus::Draft),
            group: f.id("group"),
            x: f.f64("x").unwrap_or(0.0),
            y: f.f64("y").unwrap_or(0.0),
            storylines: f
                .set::<StorylineId>("storylines")
                .into_iter()
                .filter(|s| ctx.storylines.contains(s.as_str()))
                .collect(),
            primary_storyline: f.id("primary_storyline"),
            deleted_at: f.ts("deleted_at"),
            created_at: f.ts("created_at"),
        };
        n.book_order = n.effective_book_order();
        n.status = n.effective_status();
        n.primary_storyline = n.effective_primary_storyline().cloned();
        if n.is_chapter()
            || n.group
                .as_ref()
                .is_some_and(|g| !ctx.groups.contains(g.as_str()))
        {
            n.group = None;
        }
        Some(n)
    }

    fn node_ctx(&self) -> NodeCtx {
        NodeCtx {
            groups: forest(&self.tree(book::DRIFT_GROUPS))
                .into_iter()
                .map(|n| n.id)
                .collect(),
            storylines: entities(self.doc, book::STORYLINES)
                .into_iter()
                .map(|(id, _)| id)
                .collect(),
        }
    }

    pub fn node(&self, id: &NodeId) -> Option<Node> {
        let v = entity(self.doc, book::NODES, id.as_str())?;
        self.read_node(id.as_str(), &v, &self.node_ctx())
    }

    /// Every node, trashed ones included, by id. Memberships of storylines
    /// that were purged are left out; a group that is gone reads as none.
    pub fn nodes(&self) -> Vec<Node> {
        let ctx = self.node_ctx();
        entities(self.doc, book::NODES)
            .iter()
            .filter_map(|(id, v)| self.read_node(id, v, &ctx))
            .collect()
    }

    /// Live chapters in reading order: by book order, ties by id; a chapter
    /// without a usable book order sorts last.
    pub fn chapters(&self) -> Vec<Node> {
        let mut v: Vec<Node> = self
            .nodes()
            .into_iter()
            .filter(|n| n.is_chapter() && !n.is_trashed())
            .collect();
        v.sort_by(|a, b| cmp_order((a.book_order, &a.id), (b.book_order, &b.id)));
        v
    }

    /// Live ideas, by id.
    pub fn drifts(&self) -> Vec<Node> {
        self.nodes()
            .into_iter()
            .filter(|n| n.is_drift() && !n.is_trashed())
            .collect()
    }

    /// Live nodes placed on the narrative axis, in narrative order.
    pub fn timeline(&self) -> Vec<Node> {
        let mut v: Vec<Node> = self
            .nodes()
            .into_iter()
            .filter(|n| !n.is_trashed() && n.narrative_order.is_some())
            .collect();
        v.sort_by(|a, b| cmp_order((a.narrative_order, &a.id), (b.narrative_order, &b.id)));
        v
    }

    fn drift_ids(&self) -> HashSet<String> {
        entities(self.doc, book::NODES)
            .into_iter()
            .filter(|(_, v)| F(v).str("kind") == Some("drift"))
            .map(|(id, _)| id)
            .collect()
    }

    // ---- acts and time pins -----------------------------------------

    /// Acts in reading order (head anchor first, then by start, ties by id).
    /// A bound idea that no longer exists reads as unbound.
    pub fn acts(&self) -> Vec<Act> {
        let drifts = self.drift_ids();
        let mut v: Vec<Act> = entities(self.doc, book::ACTS)
            .iter()
            .filter_map(|(id, v)| {
                let f = F(v);
                Some(Act {
                    id: ActId::parse(id).ok()?,
                    name: f.string("name"),
                    color: f.opt_string("color"),
                    start_order: f.f64("start_order"),
                    drift: f
                        .id::<NodeId>("drift")
                        .filter(|d| drifts.contains(d.as_str())),
                })
            })
            .collect();
        sort_acts(&mut v);
        v
    }

    /// Time pins in narrative order, ties by id.
    pub fn time_pins(&self) -> Vec<TimePin> {
        let drifts = self.drift_ids();
        let mut v: Vec<TimePin> = entities(self.doc, book::TIME_PINS)
            .iter()
            .filter_map(|(id, v)| {
                let f = F(v);
                Some(TimePin {
                    id: TimePinId::parse(id).ok()?,
                    narrative_order: f.f64("narrative_order")?,
                    label: f.string("label"),
                    drift: f
                        .id::<NodeId>("drift")
                        .filter(|d| drifts.contains(d.as_str())),
                })
            })
            .collect();
        v.sort_by(|a, b| {
            cmp_order(
                (Some(a.narrative_order), &a.id),
                (Some(b.narrative_order), &b.id),
            )
        });
        v
    }

    // ---- storylines, categories, elements, patches ------------------

    /// Storylines (trashed included) by position, ties by id.
    pub fn storylines(&self) -> Vec<Storyline> {
        let mut v: Vec<Storyline> = entities(self.doc, book::STORYLINES)
            .iter()
            .filter_map(|(id, v)| {
                let f = F(v);
                Some(Storyline {
                    id: StorylineId::parse(id).ok()?,
                    name: f.string("name"),
                    color: f.string("color"),
                    summary: f.string("summary"),
                    pos: f.pos("pos"),
                    facts: f.kv("facts"),
                    chapter_template: f.opt_string("chapter_template"),
                    deleted_at: f.ts("deleted_at"),
                })
            })
            .collect();
        v.sort_by(|a, b| cmp_pos((a.pos.as_ref(), &a.id), (b.pos.as_ref(), &b.id)));
        v
    }

    /// Categories (trashed included) by id.
    pub fn categories(&self) -> Vec<Category> {
        entities(self.doc, book::CATEGORIES)
            .iter()
            .filter_map(|(id, v)| {
                let f = F(v);
                Some(Category {
                    id: CategoryId::parse(id).ok()?,
                    name: f.string("name"),
                    color: f.string("color"),
                    layout: f.kind("layout").unwrap_or(CategoryLayout::Auto),
                    grid_x: f.i64("grid_x"),
                    grid_y: f.i64("grid_y"),
                    element_template: f.opt_string("element_template"),
                    template_fields: f.kv("template_fields"),
                    deleted_at: f.ts("deleted_at"),
                })
            })
            .collect()
    }

    fn live_ids(&self, root: &str) -> HashSet<String> {
        entities(self.doc, root)
            .into_iter()
            .filter(|(_, v)| F(v).ts("deleted_at").is_none())
            .map(|(id, _)| id)
            .collect()
    }

    fn read_element(
        &self,
        id: &str,
        v: &LoroValue,
        cats: &HashSet<String>,
        assets: &HashMap<String, AssetKind>,
    ) -> Option<Element> {
        let f = F(v);
        Some(Element {
            id: ElementId::parse(id).ok()?,
            name: f.string("name"),
            summary: f.string("summary"),
            category: f
                .id::<CategoryId>("category")
                .filter(|c| cats.contains(c.as_str())),
            aliases: match f.get("aliases") {
                Some(LoroValue::Map(m)) => m
                    .iter()
                    .filter(|(_, v)| !matches!(v, LoroValue::Null | LoroValue::Bool(false)))
                    .map(|(k, _)| k.clone())
                    .collect(),
                _ => BTreeSet::new(),
            },
            facts: f.kv("facts"),
            group_name: f.opt_string("group_name"),
            portrait: f
                .id::<AssetId>("portrait")
                .filter(|a| assets.get(a.as_str()) == Some(&AssetKind::Image)),
            relate_pin: match (f.f64("pin_x"), f.f64("pin_y")) {
                (Some(x), Some(y)) => Some((x, y)),
                _ => None,
            },
            deleted_at: f.ts("deleted_at"),
            created_at: f.ts("created_at"),
            name_conflict: None,
        })
    }

    fn asset_kinds(&self) -> HashMap<String, AssetKind> {
        entities(self.doc, book::ASSETS)
            .into_iter()
            .filter_map(|(id, v)| Some((id, F(&v).kind::<AssetKind>("kind")?)))
            .collect()
    }

    pub fn element(&self, id: &ElementId) -> Option<Element> {
        self.elements().into_iter().find(|e| &e.id == id)
    }

    /// Elements (trashed included) by id. A category that is gone or in the
    /// trash reads as none (the old client detached elements on category
    /// trash); a portrait that is not an image asset reads as none.
    ///
    /// Names and aliases are unique among live elements (trimmed,
    /// lowercased). When a merge breaks that, the element created first
    /// (ties by id) keeps the name and every later one gets `name_conflict`.
    pub fn elements(&self) -> Vec<Element> {
        let cats = self.live_ids(book::CATEGORIES);
        let assets = self.asset_kinds();
        let mut v: Vec<Element> = entities(self.doc, book::ELEMENTS)
            .iter()
            .filter_map(|(id, v)| self.read_element(id, v, &cats, &assets))
            .collect();
        let mut order: Vec<usize> = (0..v.len())
            .filter(|&i| v[i].deleted_at.is_none())
            .collect();
        let key = |e: &Element| (e.created_at.map(|t| t.0).unwrap_or(i64::MAX), e.id.clone());
        order.sort_by_key(|&i| key(&v[i]));
        let mut owner: HashMap<String, ElementId> = HashMap::new();
        for i in order {
            let names: Vec<String> = std::iter::once(v[i].name.as_str())
                .chain(v[i].aliases.iter().map(String::as_str))
                .map(element_name_key)
                .filter(|k| !k.is_empty())
                .collect();
            let id = v[i].id.clone();
            match names
                .iter()
                .find_map(|k| owner.get(k).filter(|o| **o != id).cloned())
            {
                Some(winner) => v[i].name_conflict = Some(winner),
                None => {
                    for k in names {
                        owner.entry(k).or_insert_with(|| id.clone());
                    }
                }
            }
        }
        v
    }

    /// Patches of elements that exist, by element then position then id. A
    /// source chapter that is gone reads as none, and so does its block.
    pub fn patches(&self) -> Vec<Patch> {
        let elements: HashSet<String> = entities(self.doc, book::ELEMENTS)
            .into_iter()
            .map(|(id, _)| id)
            .collect();
        let nodes: HashSet<String> = entities(self.doc, book::NODES)
            .into_iter()
            .map(|(id, _)| id)
            .collect();
        let mut v: Vec<Patch> = entities(self.doc, book::PATCHES)
            .iter()
            .filter_map(|(id, v)| {
                let f = F(v);
                let element: ElementId = f.id("element")?;
                if !elements.contains(element.as_str()) {
                    return None;
                }
                let source_node: Option<NodeId> = f
                    .id::<NodeId>("source_node")
                    .filter(|n| nodes.contains(n.as_str()));
                Some(Patch {
                    id: PatchId::parse(id).ok()?,
                    element,
                    source_block: source_node.as_ref().and_then(|_| f.id("source_block")),
                    source_node,
                    source_text: f.opt_string("source_text"),
                    anchor: f.anchor("anchor"),
                    invalidated_at: f.ts("invalidated_at"),
                    title: f.opt_string("title"),
                    body: f.string("body"),
                    pos: f.pos("pos"),
                })
            })
            .collect();
        v.sort_by(|a, b| {
            a.element
                .cmp(&b.element)
                .then_with(|| cmp_pos((a.pos.as_ref(), &a.id), (b.pos.as_ref(), &b.id)))
        });
        v
    }

    pub fn patches_of(&self, element: &ElementId) -> Vec<Patch> {
        self.patches()
            .into_iter()
            .filter(|p| &p.element == element)
            .collect()
    }

    // ---- relations ----------------------------------------------------

    fn read_relation_type(id: &str, v: &LoroValue) -> Option<RelationType> {
        let f = F(v);
        let name = f.string("name");
        Some(RelationType {
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
        })
    }

    pub fn relation_types(&self) -> Vec<RelationType> {
        entities(self.doc, book::RELATION_TYPES)
            .iter()
            .filter_map(|(id, v)| Self::read_relation_type(id, v))
            .collect()
    }

    pub fn relation_type(&self, id: &RelationTypeId) -> Option<RelationType> {
        let v = entity(self.doc, book::RELATION_TYPES, id.as_str())?;
        Self::read_relation_type(id.as_str(), &v)
    }

    /// Every stored relation, by id, unfiltered.
    pub fn relations_raw(&self) -> Vec<Relation> {
        entities(self.doc, book::RELATIONS)
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

    /// The entity map `root[id]`, if it exists.
    fn entity_map(&self, root: &str, id: &str) -> Option<LoroMap> {
        match self.doc.get_map(root).get(id)? {
            loro::ValueOrContainer::Container(loro::Container::Map(m)) => Some(m),
            _ => None,
        }
    }

    fn map_is_trashed(m: &LoroMap) -> bool {
        matches!(m.get("deleted_at"), Some(loro::ValueOrContainer::Value(v)) if !v.is_null())
    }

    /// Whether `r` names an entity that exists and is not in the trash: a
    /// key lookup, not a read of the collection. A patch counts while its
    /// element exists; comments and materials have no trash.
    pub fn entity_exists(&self, r: &EntityRef) -> bool {
        let live = |root: &str| {
            self.entity_map(root, &r.id)
                .is_some_and(|m| !Self::map_is_trashed(&m))
        };
        match r.kind {
            EntityKind::Node => live(book::NODES),
            EntityKind::Element => live(book::ELEMENTS),
            EntityKind::Category => live(book::CATEGORIES),
            EntityKind::Storyline => live(book::STORYLINES),
            EntityKind::Patch => self.entity_map(book::PATCHES, &r.id).is_some_and(|m| {
                matches!(m.get("element"), Some(loro::ValueOrContainer::Value(LoroValue::String(e)))
                    if self.doc.get_map(book::ELEMENTS).get(e.as_str()).is_some())
            }),
            EntityKind::Comment => self.entity_map(book::COMMENTS, &r.id).is_some(),
            EntityKind::Material => self.entity_map(book::MATERIALS, &r.id).is_some(),
            EntityKind::Other(_) => false,
        }
    }

    /// Relations to show: both ends live, type present and allowing the end
    /// kinds, no self-edge, and one per semantic edge (same ends and type,
    /// either order for a symmetric type; the smallest id wins).
    pub fn relations(&self) -> Vec<Relation> {
        self.visible_relations(|_| true)
    }

    /// The relations [`Self::relations`] shows that touch `end` (either side).
    /// Reads the relation map but checks liveness only for these.
    pub fn relations_of(&self, end: &EntityRef) -> Vec<Relation> {
        self.visible_relations(|r| &r.from == end || &r.to == end)
    }

    fn visible_relations(&self, keep: impl Fn(&Relation) -> bool) -> Vec<Relation> {
        let types: HashMap<RelationTypeId, RelationType> = self
            .relation_types()
            .into_iter()
            .map(|t| (t.id.clone(), t))
            .collect();
        let mut seen: HashSet<(EntityRef, EntityRef, RelationTypeId)> = HashSet::new();
        let mut alive_cache: HashMap<EntityRef, bool> = HashMap::new();
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
            let allowed =
                |kinds: &[EntityKind], k: &EntityKind| kinds.is_empty() || kinds.contains(k);
            let symmetric = t.orientation == RelationOrientation::Symmetric;
            let fits = if symmetric {
                allowed(&t.source_kinds, &r.from.kind) && allowed(&t.source_kinds, &r.to.kind)
            } else {
                allowed(&t.source_kinds, &r.from.kind) && allowed(&t.target_kinds, &r.to.kind)
            };
            if !fits {
                continue;
            }
            let mut alive = |e: &EntityRef| {
                *alive_cache
                    .entry(e.clone())
                    .or_insert_with(|| self.entity_exists(e))
            };
            if !alive(&r.from) || !alive(&r.to) {
                continue;
            }
            // relations_raw is sorted by id, so the first one kept is the
            // smallest.
            if seen.insert(Self::semantic_key(&r, symmetric)) {
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

    // ---- plot grids ----------------------------------------------------

    pub fn plot_grid(&self, chapter: &NodeId) -> Option<PlotGrid> {
        let v = entity(self.doc, book::PLOT_GRIDS, chapter.as_str())?;
        let f = F(&v);
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
        Some(PlotGrid {
            chapter: chapter.clone(),
            cell_w: clamp(f.f64("cell_w"), &PLOT_CELL_W, PLOT_DEFAULT_CELL.0),
            cell_h: clamp(f.f64("cell_h"), &PLOT_CELL_H, PLOT_DEFAULT_CELL.1),
            rows,
            cols,
            cells,
        })
    }

    // ---- comments ----------------------------------------------------

    fn read_comment(&self, id: &str, v: &LoroValue) -> Option<Comment> {
        let f = F(v);
        let target = f.entity_ref("target_kind", "target");
        let target_missing = target.as_ref().is_some_and(|t| !self.entity_exists(t));
        Some(Comment {
            id: CommentId::parse(id).ok()?,
            kind: f.kind("kind").unwrap_or(CommentKind::Note),
            target,
            target_missing,
            target_block: f.id("target_block"),
            anchor: f.anchor("anchor"),
            quote: f.opt_string("quote"),
            snapshots: f.snapshots("snapshots"),
            region: f.region("region"),
            author_kind: f.kind("author_kind").unwrap_or(CommentAuthorKind::User),
            author: f.opt_string("author"),
            author_name: f.opt_string("author_name"),
            // A TODO projected from a marker has no body text until the
            // author edits it: its body is the marker's text then (written
            // by the seed, `book::seed`).
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

    pub fn comment(&self, id: &CommentId) -> Option<Comment> {
        let v = entity(self.doc, book::COMMENTS, id.as_str())?;
        self.read_comment(id.as_str(), &v)
    }

    /// Comments and TODOs, by id. A target that is gone or in the trash is
    /// kept and flagged `target_missing` (shown as unlocated).
    pub fn comments(&self) -> Vec<Comment> {
        entities(self.doc, book::COMMENTS)
            .iter()
            .filter_map(|(id, v)| self.read_comment(id, v))
            .collect()
    }

    // ---- materials, assets, trees ---------------------------------------

    /// Materials by position, ties by id. A folder that is gone reads as the
    /// root; an image/PDF whose asset is missing or of another kind reads
    /// without one (shown as missing).
    pub fn materials(&self) -> Vec<Material> {
        let folders: HashSet<String> = forest(&self.tree(book::MATERIAL_FOLDERS))
            .into_iter()
            .map(|n| n.id)
            .collect();
        let assets = self.asset_kinds();
        let mut v: Vec<Material> = entities(self.doc, book::MATERIALS)
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
        entities(self.doc, book::ASSETS)
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

    pub(crate) fn tree(&self, root: &str) -> LoroTree {
        self.doc.get_tree(root)
    }

    /// Domain id → every tree node carrying it (the kept one first), for
    /// writers.
    pub(crate) fn tree_index(&self, root: &str) -> HashMap<String, Vec<TreeID>> {
        forest(&self.tree(root))
            .into_iter()
            .map(|n| (n.id, n.tree_ids))
            .collect()
    }

    /// Idea groups, parents before children, siblings in tree order.
    pub fn drift_groups(&self) -> Vec<DriftGroup> {
        forest(&self.tree(book::DRIFT_GROUPS))
            .into_iter()
            .filter_map(|n| {
                let f = F(&n.meta);
                Some(DriftGroup {
                    id: DriftGroupId::parse(&n.id).ok()?,
                    name: f.string("name"),
                    color: f.opt_string("color"),
                    parent: n.parent.and_then(|p| DriftGroupId::parse(&p).ok()),
                })
            })
            .collect()
    }

    pub fn material_folders(&self) -> Vec<MaterialFolder> {
        forest(&self.tree(book::MATERIAL_FOLDERS))
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

    // ---- facts, memory, writing days -------------------------------------

    /// Project facts (项目设定), sorted.
    pub fn facts(&self) -> Vec<KvEntry> {
        kv_entries(&self.doc.get_map(book::FACTS).get_deep_value())
    }

    /// Project Memory entries, by id (deleted ones included, flagged by
    /// `deleted_at`).
    pub fn memory(&self) -> Vec<Memory> {
        entities(self.doc, book::MEMORY)
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

    /// Every writing day, by key. Malformed keys and negative counts are
    /// skipped.
    pub fn writing_days(&self) -> Vec<WritingDay> {
        let LoroValue::Map(m) = self.doc.get_map(book::WRITING_DAYS).get_deep_value() else {
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

    /// Words written on `day`, summed over devices.
    pub fn words_on(&self, day: &dr_model::Day) -> i64 {
        self.writing_days()
            .iter()
            .filter(|w| &w.day == day)
            .map(|w| w.words)
            .sum()
    }

    // ---- documents and repairs -------------------------------------------

    /// Whether the prose document `doc` still has its owner in this book (a
    /// node, element, storyline, category or text material that exists, the
    /// trash included; for a template, its category or storyline). Storage
    /// drops prose documents without one; they appear when a purge races an
    /// edit on another device. A conversation belongs to the book itself
    /// (storage records which), like the book document: never an orphan.
    pub fn owns_prose(&self, doc: &DocId) -> bool {
        let has = |root: &str, id: &str| self.doc.get_map(root).get(id).is_some();
        match doc {
            DocId::Book(b) => b == self.book,
            DocId::Conversation(_) => true,
            DocId::Node(id) => has(book::NODES, id.as_str()),
            DocId::Element(id) => has(book::ELEMENTS, id.as_str()),
            DocId::Storyline(id) => has(book::STORYLINES, id.as_str()),
            DocId::Category(id) => has(book::CATEGORIES, id.as_str()),
            DocId::Material(id) => entity(self.doc, book::MATERIALS, id.as_str())
                .is_some_and(|v| F(&v).str("kind").is_none_or(|k| k == "text")),
            DocId::Template(id) => match id.owner() {
                Some(TemplateOwner::Category(c)) => has(book::CATEGORIES, c.as_str()),
                Some(TemplateOwner::Storyline(s)) => has(book::STORYLINES, s.as_str()),
                None => false,
            },
        }
    }

    /// Whether [`Self::repair_plan`] would be non-empty, stopping at the first
    /// thing to fix (cheap when nothing is wrong, the usual case).
    pub fn needs_repair(&self) -> bool {
        // Bulk values (one deep read per collection) are cheaper than field
        // by field reads; stop at the first finding.
        for (_, v) in entities(self.doc, book::NODES) {
            let f = F(&v);
            match f.str("kind") {
                Some("chapter") if f.f64("book_order").is_none() || f.get("group").is_some() => {
                    return true;
                }
                Some("drift") if f.get("book_order").is_some() => return true,
                _ => {}
            }
        }
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

    /// What the deterministic background repair would write.
    pub fn repair_plan(&self) -> RepairPlan {
        let mut plan = RepairPlan::default();
        // Relations: semantic duplicates beyond the smallest id. Duplicates
        // share ends and type, so they are shown or hidden together: the raw
        // relations are enough, no liveness needed.
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
        // Nodes: raw values.
        let raw = entities(self.doc, book::NODES);
        let mut max_order = 0.0f64;
        let mut unordered = Vec::new();
        for (id, v) in &raw {
            let f = F(v);
            let Ok(nid) = NodeId::parse(id) else { continue };
            let is_chapter = f.str("kind") == Some("chapter");
            let order = f.f64("book_order");
            if is_chapter {
                match order {
                    Some(o) => max_order = max_order.max(o),
                    None => unordered.push(nid.clone()),
                }
                if f.get("group").is_some() {
                    plan.chapters_in_groups.push(nid);
                }
            } else if f.str("kind") == Some("drift") && f.get("book_order").is_some() {
                plan.drifts_with_order.push(nid);
            }
        }
        for (i, id) in unordered.into_iter().enumerate() {
            plan.chapters_without_order
                .push((id, max_order + CHAPTER_ORDER_STRIDE * (i as f64 + 1.0)));
        }
        plan
    }

    /// An entity's stored fields as they are in this view, for
    /// `BookTxn::restore_fields`. Use it on `BookReader::load_at(…)`: the
    /// value of one entity at a history point.
    pub fn entity_snapshot(
        &self,
        collection: super::Collection,
        id: &str,
    ) -> Option<EntitySnapshot> {
        let loro::ValueOrContainer::Container(loro::Container::Map(m)) =
            self.doc.get_map(collection.root()).get(id)?
        else {
            return None;
        };
        let mut texts = HashSet::new();
        m.for_each(|k, v| {
            if matches!(
                v,
                loro::ValueOrContainer::Container(loro::Container::Text(_))
            ) {
                texts.insert(k.to_string());
            }
        });
        Some(EntitySnapshot {
            value: m.get_deep_value(),
            texts,
        })
    }

    /// Whether the TODO `id` is done. A task line linked to a TODO shows
    /// this instead of a state of its own; `None` when the TODO is not (yet)
    /// here, e.g. still arriving from another device.
    pub fn todo_done(&self, id: &CommentId) -> Option<bool> {
        self.comment(id).map(|c| c.is_done())
    }

    /// Elements whose name or an alias collides with an earlier element:
    /// `(element, the element that keeps the name)`.
    pub fn element_name_conflicts(&self) -> Vec<(ElementId, ElementId)> {
        self.elements()
            .into_iter()
            .filter_map(|e| e.name_conflict.clone().map(|w| (e.id, w)))
            .collect()
    }

    /// When the book was moved to the trash.
    pub fn trashed_at(&self) -> Option<Timestamp> {
        self.meta().deleted_at
    }
}
