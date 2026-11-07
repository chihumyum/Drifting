//! History: restoring entities from an earlier version, and undoing an
//! Agent's changes by origin.
//!
//! - `history.restore_entities` makes named entities of a book equal to
//!   what they were at a version (F1's per-entity restore:
//!   `BookReader::load_at` → `entity_snapshot` → `BookTxn::restore_fields`),
//!   as a new commit; the rest of the book is untouched. It is the undo of
//!   every purge, and its own undo is the same command at the version just
//!   before it.
//! - `history.undo_agent` undoes what one Agent session (or one turn) wrote.
//!   Its writes are found by their settlement records (written in the same
//!   transaction as each write). Book entities are restored field by field,
//!   and only fields nobody changed since: a field the author edited after
//!   the Agent is left alone and reported as a conflict. Entities the Agent
//!   created go to the trash (or are deleted, where there is no trash);
//!   entities it deleted come back. A prose document is reverted to before
//!   the Agent's first write when no one else wrote to it since; otherwise
//!   it is left alone and reported (restore it from history instead).

use std::collections::{BTreeMap, BTreeSet, HashMap};

use dr_doc::book::{BookReader, BookView, Collection, EntitySnapshot};
use dr_model::DocId;
use dr_model::id::{BookId, DriftGroupId, MaterialFolderId};
use loro::{ExportMode, Frontiers, LoroDoc, LoroValue};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::*;
use crate::cx::{EffectAction, Invocation};
use crate::naming::{frontiers_from_hex, frontiers_hex};
use crate::registry::Registry;

pub(crate) fn register(r: &mut Registry) {
    r.add::<RestoreEntities>()
        .add::<UndoAgent>()
        .add::<AgentChanges>();
}

/// One entity of a book document: its collection (the root container's
/// name, e.g. `nodes`, `relations`, `drift_groups`; `meta` with a field name
/// as id) and id.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema)]
pub struct EntityKey {
    pub collection: String,
    pub id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct RestoreIn {
    pub book: String,
    /// The book document's version to restore from (hex of Loro frontiers).
    pub at: String,
    pub entities: Vec<EntityKey>,
}

pub(crate) fn restore_invocation(
    book: &str,
    at: &Frontiers,
    touched: Vec<(String, String)>,
) -> Invocation {
    let mut entities: Vec<EntityKey> = touched
        .into_iter()
        .map(|(collection, id)| EntityKey { collection, id })
        .collect();
    entities.sort();
    entities.dedup();
    Invocation::new(
        "history.restore_entities",
        RestoreIn {
            book: book.to_string(),
            at: frontiers_hex(at),
            entities,
        },
    )
}

/// A detached copy of `book`'s document at `at`, read from SQLite.
fn book_at(cx: &Cx<'_>, book: &BookId, blobs: &[Vec<u8>], at: &Frontiers) -> Result<BookReader> {
    let _ = cx;
    Ok(BookReader::load_at(book.clone(), blobs, at)?)
}

fn book_blobs(cx: &Cx<'_>, book: &BookId) -> Result<(LoroDoc, Vec<Vec<u8>>)> {
    let copy = cx
        .workspace()
        .library()
        .load_copy(&DocId::Book(book.clone()).to_string())?;
    let snap = copy.export(ExportMode::Snapshot)?;
    Ok((copy, vec![snap]))
}

/// Meta fields a restore may write back.
const META_FIELDS: &[&str] = &[
    "name",
    "summary",
    "word_target",
    "daily_word_target",
    "deleted_at",
];

/// What to write for one entity.
pub(crate) enum Plan {
    /// Make these fields equal to the snapshot's (absent ones removed).
    Fields(Collection, String, EntitySnapshot, Vec<String>),
    /// The entity did not exist then: delete it now.
    Purge(Collection, String),
    /// Move to the trash (an Agent-created entity of a collection that has one).
    Trash(Collection, String),
    Meta(String, LoroValue),
    Tree(Collection, Vec<TreeItem>, Vec<TreeItem>),
    /// Give a restored entity a free name (its old one was taken since).
    Rename(Collection, String, String),
    /// Drop an alias a restored element no longer may have.
    DropAlias(String, String),
}

/// What a restored entity will be called and whether it will be live.
pub(crate) struct Identity {
    c: Collection,
    id: String,
    name: String,
    aliases: Vec<String>,
    live: bool,
}

/// The identity of `id` once `keys` of it come back from `old`.
pub(crate) fn identity(
    old: &BookView<'_>,
    cur: &BookView<'_>,
    c: Collection,
    id: &str,
    keys: &[String],
) -> Option<Identity> {
    let has = |k: &str| keys.iter().any(|x| x == k);
    let pick = |name_key: &str,
                o: Option<(String, Vec<String>, bool)>,
                n: Option<(String, Vec<String>, bool)>| {
        let named = if has(name_key) {
            o.clone()
        } else {
            n.clone().or(o.clone())
        }?;
        let aliases = if has("aliases") {
            o.clone().map(|x| x.1)
        } else {
            n.clone().map(|x| x.1)
        }
        .unwrap_or_default();
        // Without `deleted_at` among the restored fields the trash state is
        // today's, or the old one for an entity that is gone today.
        let live = if has("deleted_at") {
            o.as_ref().map(|x| x.2)
        } else {
            n.as_ref().or(o.as_ref()).map(|x| x.2)
        }
        .unwrap_or(false);
        Some(Identity {
            c,
            id: id.to_string(),
            name: named.0,
            aliases,
            live,
        })
    };
    match c {
        Collection::Nodes => {
            let nid = dr_model::id::NodeId::parse(id).ok()?;
            let f = |v: &BookView<'_>| {
                v.node(&nid)
                    .map(|n| (n.title.clone(), Vec::new(), n.deleted_at.is_none()))
            };
            pick("title", f(old), f(cur))
        }
        Collection::Storylines => {
            let f = |v: &BookView<'_>| {
                v.storylines()
                    .into_iter()
                    .find(|s| s.id.as_str() == id)
                    .map(|s| (s.name, Vec::new(), s.deleted_at.is_none()))
            };
            pick("name", f(old), f(cur))
        }
        Collection::Categories => {
            let f = |v: &BookView<'_>| {
                v.categories()
                    .into_iter()
                    .find(|s| s.id.as_str() == id)
                    .map(|s| (s.name, Vec::new(), s.deleted_at.is_none()))
            };
            pick("name", f(old), f(cur))
        }
        Collection::Elements => {
            let eid = dr_model::id::ElementId::parse(id).ok()?;
            let f = |v: &BookView<'_>| {
                v.element(&eid).map(|e| {
                    (
                        e.name,
                        e.aliases.into_iter().collect(),
                        e.deleted_at.is_none(),
                    )
                })
            };
            pick("name", f(old), f(cur))
        }
        _ => None,
    }
}

/// Renames that keep names unique after restoring `ids` (`TITLE-SUFFIX`,
/// `ELEMENT-NAME-UNIQUE`): a restore must not fail on a name taken since.
pub(crate) fn name_fixes(cur: &BookView<'_>, ids: &[Identity]) -> Vec<Plan> {
    use crate::naming::unique_name;
    use dr_model::book::element_name_key;
    let restoring: BTreeSet<(Collection, &str)> =
        ids.iter().map(|i| (i.c, i.id.as_str())).collect();
    let others = |c: Collection, id: &str| !restoring.contains(&(c, id));
    let mut nodes: Vec<String> = cur
        .nodes()
        .into_iter()
        .filter(|n| !n.is_trashed() && others(Collection::Nodes, n.id.as_str()))
        .map(|n| n.title)
        .collect();
    let mut lines: Vec<String> = cur
        .storylines()
        .into_iter()
        .filter(|s| s.deleted_at.is_none() && others(Collection::Storylines, s.id.as_str()))
        .map(|s| s.name)
        .collect();
    let mut cats: Vec<String> = cur
        .categories()
        .into_iter()
        .filter(|s| s.deleted_at.is_none() && others(Collection::Categories, s.id.as_str()))
        .map(|s| s.name)
        .collect();
    let mut els: Vec<String> = cur
        .elements()
        .into_iter()
        .filter(|e| e.deleted_at.is_none() && others(Collection::Elements, e.id.as_str()))
        .flat_map(|e| std::iter::once(e.name).chain(e.aliases))
        .map(|n| element_name_key(&n))
        .collect();
    let mut out = Vec::new();
    for i in ids.iter().filter(|i| i.live) {
        let taken = match i.c {
            Collection::Nodes => &mut nodes,
            Collection::Storylines => &mut lines,
            Collection::Categories => &mut cats,
            _ => &mut els,
        };
        let name = unique_name(&i.name, "Untitled", taken.iter().map(String::as_str));
        if name != i.name.trim() {
            out.push(Plan::Rename(i.c, i.id.clone(), name.clone()));
        }
        if i.c == Collection::Elements {
            taken.push(element_name_key(&name));
            for a in &i.aliases {
                let k = element_name_key(a);
                if taken.contains(&k) {
                    out.push(Plan::DropAlias(i.id.clone(), a.clone()));
                } else {
                    taken.push(k);
                }
            }
        } else {
            taken.push(name);
        }
    }
    out
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct TreeItem {
    id: String,
    name: String,
    color: Option<String>,
    parent: Option<String>,
}

fn tree_items(view: &dr_doc::book::BookView<'_>, c: Collection) -> Vec<TreeItem> {
    match c {
        Collection::DriftGroups => view
            .drift_groups()
            .into_iter()
            .map(|g| TreeItem {
                id: g.id.to_string(),
                name: g.name,
                color: g.color,
                parent: g.parent.map(|p| p.to_string()),
            })
            .collect(),
        _ => view
            .material_folders()
            .into_iter()
            .map(|f| TreeItem {
                id: f.id.to_string(),
                name: f.name,
                color: None,
                parent: f.parent.map(|p| p.to_string()),
            })
            .collect(),
    }
}

fn meta_value(view: &dr_doc::book::BookView<'_>, key: &str) -> LoroValue {
    let m = view.meta();
    match key {
        "name" => m.name.into(),
        "summary" => m.summary.into(),
        "word_target" => m
            .word_target_set
            .map(LoroValue::from)
            .unwrap_or(LoroValue::Null),
        "daily_word_target" => m
            .daily_word_target_set
            .map(LoroValue::from)
            .unwrap_or(LoroValue::Null),
        "deleted_at" => m
            .deleted_at
            .map(|t| LoroValue::from(t.0))
            .unwrap_or(LoroValue::Null),
        _ => LoroValue::Null,
    }
}

/// Apply plans inside the book transaction.
pub(crate) fn apply(txn: &mut dr_doc::book::BookTxn<'_>, plans: Vec<Plan>) -> Result<()> {
    for p in plans {
        match p {
            Plan::Fields(c, id, snap, keys) => {
                let keys: Vec<&str> = keys.iter().map(String::as_str).collect();
                txn.restore_fields(c, &id, &snap, &keys)?;
            }
            Plan::Purge(c, id) => {
                if txn.view().entity_snapshot(c, &id).is_some() {
                    txn.purge(c, &id)?;
                }
            }
            Plan::Trash(c, id) => {
                let t = Some(now());
                match c {
                    Collection::Nodes => {
                        txn.node(&pid("node", &id)?)?.deleted_at(t)?;
                    }
                    Collection::Elements => {
                        txn.element(&pid("element", &id)?)?.deleted_at(t)?;
                    }
                    Collection::Categories => {
                        txn.category(&pid("category", &id)?)?.deleted_at(t)?;
                    }
                    Collection::Storylines => {
                        txn.storyline(&pid("storyline", &id)?)?.deleted_at(t)?;
                    }
                    Collection::Memory => {
                        txn.memory(&pid("memory", &id)?)?.deleted_at(t)?;
                    }
                    _ => txn.purge(c, &id)?,
                }
            }
            Plan::Meta(key, v) => {
                let w = txn.meta();
                let i = match &v {
                    LoroValue::I64(i) => Some(*i),
                    _ => None,
                };
                let s = match &v {
                    LoroValue::String(s) => s.to_string(),
                    _ => String::new(),
                };
                match key.as_str() {
                    "name" => {
                        w.name(&s)?;
                    }
                    "summary" => {
                        w.summary(&s)?;
                    }
                    "word_target" => {
                        w.word_target(i)?;
                    }
                    "daily_word_target" => {
                        w.daily_word_target(i)?;
                    }
                    "deleted_at" => {
                        w.deleted_at(i.map(dr_model::Timestamp))?;
                    }
                    _ => {}
                }
            }
            Plan::Tree(c, want, ids_now) => {
                restore_tree(txn, c, &want, &ids_now)?;
            }
            Plan::Rename(c, id, name) => match c {
                Collection::Nodes => {
                    txn.node(&pid("node", &id)?)?.title(&name)?;
                }
                Collection::Storylines => {
                    txn.storyline(&pid("storyline", &id)?)?.name(&name)?;
                }
                Collection::Categories => {
                    txn.category(&pid("category", &id)?)?.name(&name)?;
                }
                Collection::Elements => {
                    txn.element(&pid("element", &id)?)?.name(&name)?;
                }
                _ => {}
            },
            Plan::DropAlias(id, alias) => {
                txn.element(&pid("element", &id)?)?.remove_alias(&alias)?;
            }
        }
    }
    Ok(())
}

/// Make the tree items named in `now` (by id) equal to `want`: create the
/// missing (parents first), rename/recolour/move the present, delete the
/// ones `want` lacks. `want` and `now` are restricted to the ids restored.
fn restore_tree(
    txn: &mut dr_doc::book::BookTxn<'_>,
    c: Collection,
    want: &[TreeItem],
    now: &[TreeItem],
) -> Result<()> {
    fn tree<'a>(
        txn: &mut dr_doc::book::BookTxn<'a>,
        c: Collection,
    ) -> dr_doc::book::write::TreeWriter<'a> {
        match c {
            Collection::DriftGroups => txn.drift_groups(),
            _ => txn.material_folders(),
        }
    }
    let present: HashMap<&str, &TreeItem> = now.iter().map(|t| (t.id.as_str(), t)).collect();
    let exists_now = |txn: &mut dr_doc::book::BookTxn<'_>, id: &str| -> bool {
        tree_items(&txn.view(), c).iter().any(|t| t.id == id)
    };
    for w in want {
        let parent = match &w.parent {
            Some(p) if exists_now(txn, p) => Some(p.clone()),
            _ => None,
        };
        if present.contains_key(w.id.as_str()) && exists_now(txn, &w.id) {
            let t = tree(txn, c);
            t.rename(&w.id, &w.name)?;
            if c == Collection::DriftGroups {
                t.set_color(&w.id, w.color.as_deref())?;
            }
            t.move_to(&w.id, parent.as_deref())?;
        } else {
            let t = tree(txn, c);
            t.create(&w.id, parent.as_deref(), &w.name)?;
            if c == Collection::DriftGroups {
                t.set_color(&w.id, w.color.as_deref())?;
            }
        }
    }
    for n in now {
        if !want.iter().any(|w| w.id == n.id) && exists_now(txn, &n.id) {
            match c {
                Collection::DriftGroups => {
                    txn.delete_drift_group(&pid::<DriftGroupId>("idea group", &n.id)?)?
                }
                _ => {
                    txn.delete_material_folder(&pid::<MaterialFolderId>("material folder", &n.id)?)?
                }
            }
        }
    }
    Ok(())
}

fn collection(name: &str) -> Result<Collection> {
    Collection::from_root(name)
        .ok_or_else(|| WsError::invalid(format!("unknown collection {name:?}")))
}

fn keys_of(snap: &Option<EntitySnapshot>) -> BTreeSet<String> {
    snap.as_ref()
        .map(|s| s.keys().into_iter().collect())
        .unwrap_or_default()
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct Restored {
    pub restored: Vec<EntityKey>,
}

op! {
    RestoreEntities = "history.restore_entities", Write, Book,
    "Make named entities of a book equal to an earlier version (one commit; the rest of the book is untouched). The undo of every purge.",
    fn(cx, input: RestoreIn) -> Restored {
        let slot = cx.book(&input.book)?;
        let at = frontiers_from_hex(&input.at)?;
        let (_copy, blobs) = book_blobs(cx, &slot.book)?;
        let old = book_at(cx, &slot.book, &blobs, &at)?;
        let ov = old.view();
        let cur = slot.reader.view();
        let mut plans = Vec::new();
        let mut idents = Vec::new();
        let mut trees: BTreeMap<Collection, BTreeSet<String>> = BTreeMap::new();
        for e in &input.entities {
            let c = collection(&e.collection)?;
            match c {
                Collection::Meta => {
                    if META_FIELDS.contains(&e.id.as_str()) {
                        plans.push(Plan::Meta(e.id.clone(), meta_value(&ov, &e.id)));
                    }
                }
                Collection::DriftGroups | Collection::MaterialFolders => {
                    trees.entry(c).or_default().insert(e.id.clone());
                }
                Collection::WritingDays => {}
                _ => {
                    let snap = ov.entity_snapshot(c, &e.id);
                    let now = cur.entity_snapshot(c, &e.id);
                    match snap {
                        None => plans.push(Plan::Purge(c, e.id.clone())),
                        Some(s) => {
                            let mut keys = keys_of(&Some(s.clone()));
                            keys.extend(keys_of(&now));
                            let keys: Vec<String> = keys.into_iter().collect();
                            idents.extend(identity(&ov, &cur, c, &e.id, &keys));
                            plans.push(Plan::Fields(c, e.id.clone(), s, keys));
                        }
                    }
                }
            }
        }
        for (c, ids) in trees {
            let want: Vec<TreeItem> = tree_items(&ov, c).into_iter().filter(|t| ids.contains(&t.id)).collect();
            let now: Vec<TreeItem> = tree_items(&cur, c).into_iter().filter(|t| ids.contains(&t.id)).collect();
            plans.push(Plan::Tree(c, want, now));
        }
        let fixes = name_fixes(&cur, &idents);
        report_renames(cx, &fixes);
        plans.extend(fixes);
        let (_, before) = cx.write_book(&slot, move |txn| apply(txn, plans))?;
        for e in &input.entities {
            cx.effect(EffectAction::Restored, &e.collection, &e.id, None);
        }
        cx.undo_with(restore_invocation(&input.book, &before,
            input.entities.iter().map(|e| (e.collection.clone(), e.id.clone())).collect()));
        Ok(Restored { restored: input.entities })
    }
}

// ---- Agent changes ------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct AgentIn {
    pub session: String,
    /// One turn; omitted: the whole session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn: Option<u32>,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct AgentWriteInfo {
    pub doc: String,
    pub turn: String,
    pub call: String,
    pub summary: String,
    pub ts: i64,
}

fn settlements(cx: &Cx<'_>, input: &AgentIn) -> Result<Vec<dr_store::Settlement>> {
    let turn = input.turn.map(|t| t.to_string());
    Ok(cx
        .workspace()
        .library()
        .settlements(Some(&input.session), None)?
        .into_iter()
        .filter(|s| turn.as_ref().is_none_or(|t| &s.turn == t))
        .collect())
}

op! {
    AgentChanges = "history.agent_changes", Read, Shared,
    "List what an Agent session (or one turn) wrote: one entry per settled write, oldest first.",
    fn(cx, input: AgentIn) -> Vec<AgentWriteInfo> {
        Ok(settlements(cx, &input)?.into_iter().map(|s| AgentWriteInfo {
            doc: s.doc_id, turn: s.turn, call: s.call, summary: s.summary, ts: s.ts,
        }).collect())
    }
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct Conflict {
    /// A prose document id, or `<collection>/<id>` of a book entity.
    pub what: String,
    /// The field left alone, for a book entity.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    pub reason: String,
}

#[derive(Clone, Debug, Default, Serialize, JsonSchema)]
pub struct AgentUndone {
    pub restored: Vec<EntityKey>,
    pub trashed: Vec<EntityKey>,
    pub reverted_prose: Vec<String>,
    pub conflicts: Vec<Conflict>,
}

/// One Agent change of one field: (value before, value after, span index).
type Touch = (Option<LoroValue>, Option<LoroValue>, usize);

type Deep = BTreeMap<(Collection, String), BTreeMap<String, LoroValue>>;

/// Every entity's fields, by collection and id (entity-map collections only).
fn deep_entities(v: &LoroValue) -> Deep {
    let mut out = Deep::new();
    let LoroValue::Map(root) = v else { return out };
    for (name, coll) in root.iter() {
        let Some(c) = Collection::from_root(name) else {
            continue;
        };
        if matches!(
            c,
            Collection::Meta
                | Collection::DriftGroups
                | Collection::MaterialFolders
                | Collection::WritingDays
                | Collection::Assets
        ) {
            continue;
        }
        let LoroValue::Map(entities) = coll else {
            continue;
        };
        for (id, fields) in entities.iter() {
            let LoroValue::Map(f) = fields else { continue };
            out.insert(
                (c, id.clone()),
                f.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
            );
        }
    }
    out
}

/// One span of Agent writes on a document: from `before` to `after`.
struct Span {
    before: Frontiers,
    after: Frontiers,
}

op! {
    UndoAgent = "history.undo_agent", Write, Book,
    "Undo what an Agent session (or one turn) wrote: book fields nobody changed since go back, entities it created go to the trash, entities it deleted come back, and prose untouched since is reverted; the rest is reported as conflicts.",
    fn(cx, input: AgentIn) -> AgentUndone {
        let all = settlements(cx, &input)?;
        if all.is_empty() {
            return Err(WsError::not_found("agent writes", format!("{}{}", input.session,
                input.turn.map(|t| format!("/{t}")).unwrap_or_default())));
        }
        // Spans per document, in write order.
        let mut by_doc: BTreeMap<String, Vec<Span>> = BTreeMap::new();
        for s in &all {
            by_doc.entry(s.doc_id.clone()).or_default().push(Span { before: s.before.clone(), after: s.after.clone() });
        }
        let mut out = AgentUndone::default();
        let mut undo: Vec<Invocation> = Vec::new();
        // Prose first (write order).
        for (doc_id, spans) in by_doc.iter().filter(|(d, _)| !d.starts_with("book:")) {
            let doc = DocId::parse(doc_id).map_err(|e| WsError::invalid(e.to_string()))?;
            if let Some(info) = cx.workspace().library().doc_info(doc_id)?
                && let Some(b) = info.book_id { cx.book(&b)?; }
            let slot = match cx.prose(&doc) {
                Ok(s) => s,
                Err(WsError::NotFound { .. }) => continue,
                Err(e) => return Err(e),
            };
            let contiguous = spans.windows(2).all(|w| w[0].after == w[1].before);
            let target = spans[0].before.clone();
            let last = spans.last().expect("non-empty").after.clone();
            // Compare and revert in one job: the author's editor writes to
            // this document without the book's lease.
            let pre = if contiguous {
                cx.write_prose_raw(&slot, move |doc| {
                    let pre = doc.oplog_frontiers();
                    if pre != last {
                        return Ok(None);
                    }
                    doc.revert_to(&target)?;
                    Ok(Some(pre))
                })?
            } else {
                None
            };
            let Some(pre) = pre else {
                out.conflicts.push(Conflict { what: doc_id.clone(), field: None,
                    reason: "written by someone else since; restore it from history".into() });
                continue;
            };
            undo.push(Invocation::new("prose.restore", super::prose::ProseRestoreIn {
                doc: doc_id.clone(), at: frontiers_hex(&pre),
            }));
            cx.effect(EffectAction::Restored, "prose", doc_id.as_str(), None);
            out.reverted_prose.push(doc_id.clone());
        }
        // Then each book.
        for (doc_id, spans) in by_doc.iter().filter(|(d, _)| d.starts_with("book:")) {
            let book: BookId = pid("book", &doc_id["book:".len()..])?;
            let slot = cx.book(book.as_str())?;
            let (copy, blobs) = book_blobs(cx, &book)?;
            // Per field: the Agent's touches, in order, as (before, after).
            let mut touches: BTreeMap<(Collection, String, String), Vec<Touch>> = BTreeMap::new();
            let mut existed: BTreeMap<(Collection, String), (bool, bool, usize)> = BTreeMap::new();
            let mut tree_spans: BTreeMap<Collection, (usize, usize)> = BTreeMap::new();
            let mut meta_touch: BTreeMap<String, (LoroValue, LoroValue, usize, usize)> = BTreeMap::new();
            // Which entities each span touched (a diff on the copy), then
            // their values on either side of it: two checkouts per span, and
            // only the touched entities read.
            let mut last_after: BTreeMap<(Collection, String), Option<BTreeMap<String, LoroValue>>> = BTreeMap::new();
            let span_touches: Vec<SpanTouch> = spans.iter().map(|s| span_touch(&copy, s)).collect::<Result<_>>()?;
            for (i, (span, t)) in spans.iter().zip(&span_touches).enumerate() {
                copy.checkout(&span.before)?;
                let (db, mb) = read_touched(&copy, t);
                copy.checkout(&span.after)?;
                let (da, ma) = read_touched(&copy, t);
                let keys: BTreeSet<&(Collection, String)> = db.keys().chain(da.keys()).collect();
                for k in keys {
                    let (fb, fa) = (db.get(k), da.get(k));
                    if fb == fa { continue; }
                    last_after.insert(k.clone(), fa.cloned());
                    let e = existed.entry(k.clone()).or_insert((fb.is_some(), fa.is_some(), i));
                    e.1 = fa.is_some();
                    let fields: BTreeSet<&String> = fb.into_iter().flat_map(|m| m.keys()).chain(fa.into_iter().flat_map(|m| m.keys())).collect();
                    for f in fields {
                        let (vb, va) = (fb.and_then(|m| m.get(f)).cloned(), fa.and_then(|m| m.get(f)).cloned());
                        if vb != va {
                            touches.entry((k.0, k.1.clone(), f.clone())).or_default().push((vb, va, i));
                        }
                    }
                }
                for c in &t.trees {
                    let e = tree_spans.entry(*c).or_insert((i, i));
                    e.1 = i;
                }
                for f in META_FIELDS {
                    let (vb, va) = (field(&mb, f), field(&ma, f));
                    if vb != va {
                        let e = meta_touch.entry(f.to_string()).or_insert((vb.clone(), va.clone(), i, i));
                        e.1 = va;
                        e.3 = i;
                    }
                }
            }
            copy.checkout_to_latest();
            let now_value = slot.handle.doc().get_deep_value();
            let now_deep = deep_entities(&now_value);
            let now_meta = map_get(&now_value, Collection::Meta.root());
            // Which version each restored field comes from (a span's before).
            let mut readers: HashMap<usize, BookReader> = HashMap::new();
            let mut reader_at = |i: usize| -> Result<BookReader> {
                if let Some(r) = readers.get(&i) { return Ok(r.clone()); }
                let r = book_at(cx, &book, &blobs, &spans[i].before)?;
                readers.insert(i, r.clone());
                Ok(r)
            };
            let mut plans: Vec<Plan> = Vec::new();
            let mut idents: Vec<Identity> = Vec::new();
            let mut touched: Vec<(String, String)> = Vec::new();
            let mut handled: BTreeSet<(Collection, String)> = BTreeSet::new();
            // Whole entities the Agent created or deleted.
            for (k, (before, after, first)) in &existed {
                let now = now_deep.get(k);
                let last_after = last_after.get(k).cloned().flatten();
                match (before, after) {
                    (false, true) => {
                        if now.is_some() && now == last_after.as_ref() {
                            plans.push(Plan::Trash(k.0, k.1.clone()));
                            out.trashed.push(EntityKey { collection: k.0.root().into(), id: k.1.clone() });
                            touched.push((k.0.root().into(), k.1.clone()));
                            cx.effect(EffectAction::Trashed, k.0.root(), k.1.as_str(), None);
                        } else if now.is_some() {
                            out.conflicts.push(Conflict { what: format!("{}/{}", k.0.root(), k.1), field: None,
                                reason: "created by the Agent, then changed by someone else".into() });
                        }
                        handled.insert(k.clone());
                    }
                    (true, false) => {
                        if now.is_none() {
                            let r = reader_at(*first)?;
                            if let Some(snap) = r.view().entity_snapshot(k.0, &k.1) {
                                let keys = snap.keys();
                                idents.extend(identity(&r.view(), &slot.reader.view(), k.0, &k.1, &keys));
                                plans.push(Plan::Fields(k.0, k.1.clone(), snap, keys));
                                out.restored.push(EntityKey { collection: k.0.root().into(), id: k.1.clone() });
                                touched.push((k.0.root().into(), k.1.clone()));
                                cx.effect(EffectAction::Restored, k.0.root(), k.1.as_str(), None);
                            }
                        } else {
                            out.conflicts.push(Conflict { what: format!("{}/{}", k.0.root(), k.1), field: None,
                                reason: "deleted by the Agent, then recreated".into() });
                        }
                        handled.insert(k.clone());
                    }
                    _ => {}
                }
            }
            // Fields, each restored to the value before the Agent's unbroken
            // run of changes to it, if nobody changed it since.
            let mut fields_by: BTreeMap<(Collection, String, usize), Vec<String>> = BTreeMap::new();
            for ((c, id, f), list) in &touches {
                if handled.contains(&(*c, id.clone())) { continue; }
                let now = now_deep.get(&(*c, id.clone())).and_then(|m| m.get(f)).cloned();
                let last = list.last().expect("non-empty");
                if now != last.1 {
                    out.conflicts.push(Conflict { what: format!("{}/{}", c.root(), id), field: Some(f.clone()),
                        reason: "changed by someone else after the Agent".into() });
                    continue;
                }
                let mut j = list.len() - 1;
                while j > 0 && list[j - 1].1 == list[j].0 { j -= 1; }
                fields_by.entry((*c, id.clone(), list[j].2)).or_default().push(f.clone());
            }
            for ((c, id, span), fields) in fields_by {
                let r = reader_at(span)?;
                let snap = match r.view().entity_snapshot(c, &id) {
                    Some(s) => s,
                    None => continue,
                };
                idents.extend(identity(&r.view(), &slot.reader.view(), c, &id, &fields));
                plans.push(Plan::Fields(c, id.clone(), snap, fields));
                let key = EntityKey { collection: c.root().into(), id: id.clone() };
                if !out.restored.contains(&key) {
                    cx.effect(EffectAction::Restored, c.root(), id.as_str(), None);
                    out.restored.push(key);
                }
                touched.push((c.root().into(), id));
            }
            for (f, (vb, va, _, _)) in meta_touch {
                if field(&now_meta, &f) == va {
                    plans.push(Plan::Meta(f.clone(), vb));
                    touched.push(("meta".into(), f.clone()));
                } else {
                    out.conflicts.push(Conflict { what: "meta".into(), field: Some(f), reason: "changed by someone else after the Agent".into() });
                }
            }
            for (c, (first, last)) in tree_spans {
                let before = tree_items(&reader_at(first)?.view(), c);
                let after = tree_items(&book_at(cx, &book, &blobs, &spans[last].after)?.view(), c);
                let now = tree_items(&slot.reader.view(), c);
                let ids: BTreeSet<String> = before.iter().chain(after.iter()).map(|t| t.id.clone()).collect();
                let mut restore_ids = BTreeSet::new();
                for id in ids {
                    let (b, a, n) = (before.iter().find(|t| t.id == id), after.iter().find(|t| t.id == id), now.iter().find(|t| t.id == id));
                    if b == a { continue; }
                    if n == a { restore_ids.insert(id.clone()); touched.push((c.root().into(), id)); }
                    else { out.conflicts.push(Conflict { what: format!("{}/{}", c.root(), id), field: None, reason: "changed by someone else after the Agent".into() }); }
                }
                if !restore_ids.is_empty() {
                    let want = before.into_iter().filter(|t| restore_ids.contains(&t.id)).collect();
                    let now = now.into_iter().filter(|t| restore_ids.contains(&t.id)).collect();
                    plans.push(Plan::Tree(c, want, now));
                }
            }
            if plans.is_empty() { continue; }
            let fixes = name_fixes(&slot.reader.view(), &idents);
            report_renames(cx, &fixes);
            plans.extend(fixes);
            let (_, before) = cx.write_book(&slot, move |txn| apply(txn, plans))?;
            undo.push(restore_invocation(book.as_str(), &before, touched));
        }
        if undo.is_empty() { cx.undo_nothing(); }
        for u in undo { cx.undo_with(u); }
        Ok(out)
    }
}

pub(crate) fn report_renames(cx: &Cx<'_>, fixes: &[Plan]) {
    for f in fixes {
        if let Plan::Rename(c, id, name) = f {
            cx.effect(EffectAction::Renamed, c.root(), id.as_str(), Some(name));
        }
    }
}

fn map_get(v: &LoroValue, key: &str) -> LoroValue {
    match v {
        LoroValue::Map(m) => m.get(key).cloned().unwrap_or(LoroValue::Null),
        _ => LoroValue::Null,
    }
}

fn field(v: &LoroValue, key: &str) -> LoroValue {
    map_get(v, key)
}

/// What one span of Agent writes touched in the book document.
#[derive(Default)]
struct SpanTouch {
    entities: BTreeSet<(Collection, String)>,
    trees: BTreeSet<Collection>,
    meta: bool,
    /// A change could not be attributed: compare whole collections.
    whole: bool,
}

fn root_of(id: &loro::ContainerID) -> Option<&str> {
    match id {
        loro::ContainerID::Root { name, .. } => Some(name.as_str()),
        loro::ContainerID::Normal { .. } => None,
    }
}

/// Attribute the span's diff to entities (path[0] the collection, path[1]
/// the entity), as the event bus does.
fn span_touch(copy: &LoroDoc, s: &Span) -> Result<SpanTouch> {
    let mut t = SpanTouch::default();
    let diff = copy.diff(&s.before, &s.after)?;
    for (cid, d) in diff.iter() {
        let path = copy.get_path_to_container(cid).unwrap_or_default();
        let root = path
            .first()
            .and_then(|(id, _)| root_of(id))
            .or_else(|| root_of(cid));
        let Some(c) = root.and_then(Collection::from_root) else {
            t.whole = true;
            continue;
        };
        match c {
            Collection::Meta => t.meta = true,
            Collection::DriftGroups | Collection::MaterialFolders => {
                t.trees.insert(c);
            }
            Collection::WritingDays | Collection::Assets => {}
            _ => match path.get(1).map(|(_, i)| i) {
                Some(loro::Index::Key(k)) => {
                    t.entities.insert((c, k.to_string()));
                }
                _ => match d {
                    loro::event::Diff::Map(m) => {
                        for k in m.updated.keys() {
                            t.entities.insert((c, k.to_string()));
                        }
                    }
                    _ => t.whole = true,
                },
            },
        }
    }
    Ok(t)
}

/// The touched entities' fields and the meta map, as the copy is now.
fn read_touched(copy: &LoroDoc, t: &SpanTouch) -> (Deep, LoroValue) {
    let meta = copy.get_map(Collection::Meta.root()).get_deep_value();
    if t.whole {
        return (deep_entities(&copy.get_deep_value()), meta);
    }
    let mut out = Deep::new();
    for (c, id) in &t.entities {
        if let Some(loro::ValueOrContainer::Container(loro::Container::Map(m))) =
            copy.get_map(c.root()).get(id)
            && let LoroValue::Map(f) = m.get_deep_value()
        {
            out.insert(
                (*c, id.clone()),
                f.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
            );
        }
    }
    (out, meta)
}
