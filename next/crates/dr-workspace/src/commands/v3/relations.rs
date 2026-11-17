//! Book-wide relations. Rows connect the Cartesian product of two entry sets.
//!
//! Every write's undo is `relation_type.restore` with only what that write
//! changed (`restore.rs`): the pairs it put into or took out of rows, the
//! definition values it wrote, a relation it made or removed. Writes plan
//! against the rows that count ([`BookViewV3::relations_kept`]) under the
//! relation each reads as after a merge (`RT-NAME`), and clean what a merge
//! left of the rows ([`dr_doc::v3::BookTxnV3::prune_relation_rows`]).

use super::*;
use crate::dto::LinkedTextIn;
use dr_model::shared::normalize_relation_type_name;
use dr_model::v3::{LinkedText, PairPlacement, RelationDirection, RelationRow, RelationSide};

mod restore;
pub use restore::{RelationRestore, RestoreIn, RowStep, StoredPair, StoredRelation, TypeStep};

pub(crate) fn register(r: &mut Registry) {
    r.add::<List>()
        .add::<RelationRestore>()
        .add::<Create>()
        .add::<Rename>()
        .add::<SetDescription>()
        .add::<SetDirection>()
        .add::<Delete>()
        .add::<CreatePair>()
        .add::<AddEntry>()
        .add::<RemoveEntry>()
        .add::<DeleteRow>();
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ListIn {
    pub book: String,
    /// Include only rows containing this live entry.
    #[serde(default)]
    pub entry: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct RelationInfo {
    pub id: String,
    pub name: String,
    pub description: LinkedText,
    pub direction: RelationDirection,
    pub created_at: Option<i64>,
    pub pair_count: usize,
    pub rows: Vec<RowInfo>,
    /// IDs of the relation's stored rows that are not shown (a side holds
    /// only entries in Recently Deleted, or a merge left a side without an
    /// entry). A write can still land in or remove them; their members are
    /// not listed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hidden_rows: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct RowInfo {
    pub id: String,
    pub left: Vec<String>,
    pub right: Vec<String>,
    pub created_at: Option<i64>,
}

impl From<RelationRow> for RowInfo {
    fn from(row: RelationRow) -> Self {
        Self {
            id: row.id.to_string(),
            left: row.left.iter().map(ToString::to_string).collect(),
            right: row.right.iter().map(ToString::to_string).collect(),
            created_at: row.created_at.map(|t| t.0),
        }
    }
}

op! {
    List = "relation_type.list", Read, Shared,
    "List each relation with its description, direction and rows of live entries. Each row relates every left entry to every right entry.",
    fn(cx, input: ListIn) -> Vec<RelationInfo> {
        let slot = cx.book_v3(&input.book)?;
        let view = slot.reader_v3.view();
        let entry = input.entry.as_deref().map(|id| pid("entry", id)).transpose()?;
        let mut rows: BTreeMap<RelationTypeId, Vec<RelationRow>> = BTreeMap::new();
        for row in view.relations() {
            if entry.as_ref().is_none_or(|entry| row.contains(entry)) {
                rows.entry(row.relation_type.clone()).or_default().push(row);
            }
        }
        // Every stored row by the relation it reads as, for the IDs of those
        // not shown (the Agent has to have seen a row a write touches).
        let winners = view.relation_type_winners();
        let mut hidden: BTreeMap<RelationTypeId, Vec<String>> = BTreeMap::new();
        for row in view.relations_raw() {
            if let Some(kind) = winners.get(&row.relation_type)
                && entry.as_ref().is_none_or(|entry| row.contains(entry))
                && !rows.get(kind).is_some_and(|shown| shown.iter().any(|r| r.id == row.id))
            {
                hidden.entry(kind.clone()).or_default().push(row.id.to_string());
            }
        }
        Ok(view.relation_types().into_iter().filter_map(|relation| {
            let rows = rows.remove(&relation.id).unwrap_or_default();
            if entry.is_some() && rows.is_empty() {
                return None;
            }
            let pairs: BTreeSet<_> = rows.iter().flat_map(RelationRow::pairs)
                .map(|(left, right)| relation.direction.pair(left, right))
                .collect();
            let pair_count = pairs.len();
            Some(RelationInfo {
                hidden_rows: hidden.remove(&relation.id).unwrap_or_default(),
                id: relation.id.to_string(),
                name: relation.name, description: relation.description, direction: relation.direction,
                created_at: relation.created_at.map(|t| t.0), pair_count,
                rows: rows.into_iter().map(RowInfo::from).collect(),
            })
        }).collect())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Definition {
    pub name: String,
    #[serde(default)]
    pub description: LinkedTextIn,
    #[serde(default)]
    pub direction: RelationDirection,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct CreateTypeIn {
    pub book: String,
    pub name: String,
    #[serde(default)]
    pub description: LinkedTextIn,
    #[serde(default)]
    pub direction: RelationDirection,
}

/// `name` is free: no stored relation outside `except`'s merge group has
/// its normalized name.
fn name_available(
    view: &BookViewV3<'_>,
    name: &str,
    except: Option<&RelationTypeId>,
) -> Result<()> {
    name_ok(name)?;
    let normalized = normalize_relation_type_name(name);
    let group = except.map(|id| group(view, id)).unwrap_or_default();
    if view
        .relation_types_raw()
        .iter()
        .any(|relation| !group.contains(&relation.id) && relation.normalized_name == normalized)
    {
        return Err(WsError::invalid("duplicate relation name"));
    }
    Ok(())
}

/// The relation `id` reads as: itself, or after a merge of two same-named
/// relations the earliest of them (`RT-NAME`), whose definition is shown.
fn require_type(view: &BookViewV3<'_>, id: &RelationTypeId) -> Result<m::RelationTypeV3> {
    view.relation_type_winners()
        .get(id)
        .and_then(|winner| view.relation_type_raw(winner))
        .ok_or_else(|| WsError::not_found("relation type", id.as_str()))
}

/// Every stored relation that reads as `kind`'s relation, the shown one
/// first.
fn group(view: &BookViewV3<'_>, kind: &RelationTypeId) -> Vec<RelationTypeId> {
    let winners = view.relation_type_winners();
    let Some(winner) = winners.get(kind) else {
        return Vec::new();
    };
    let mut ids = vec![winner.clone()];
    ids.extend(
        winners
            .iter()
            .filter(|(id, w)| *w == winner && *id != winner)
            .map(|(id, _)| id.clone()),
    );
    ids
}

/// The rows of `kind`'s relation that count, in creation order, with their
/// stored members (Recently Deleted included).
fn rows_for(view: &BookViewV3<'_>, kind: &RelationTypeId) -> Vec<RelationRow> {
    let Some(winner) = view.relation_type_winners().get(kind).cloned() else {
        return Vec::new();
    };
    view.relations_kept()
        .into_iter()
        .filter(|row| row.relation_type == winner)
        .collect()
}

/// Every stored row of `kind`'s relation as stored, the ones that do not
/// count included.
fn stored_rows(view: &BookViewV3<'_>, kind: &RelationTypeId) -> Vec<RelationRow> {
    let group = group(view, kind);
    view.relations_raw()
        .into_iter()
        .filter(|row| group.contains(&row.relation_type))
        .collect()
}

/// A row that counts, with its stored relation id.
fn require_row(view: &BookViewV3<'_>, id: &RelationId) -> Result<RelationRow> {
    let own = view
        .relations_raw()
        .into_iter()
        .find(|row| &row.id == id)
        .map(|row| row.relation_type);
    view.relations_kept()
        .into_iter()
        .find(|row| &row.id == id)
        .map(|mut row| {
            row.relation_type = own.unwrap_or(row.relation_type);
            row
        })
        .ok_or_else(|| WsError::not_found("relation row", id.as_str()))
}

fn linked_description(cx: &Cx<'_>, slot: &BookSlot, text: LinkedTextIn) -> Result<LinkedText> {
    crate::autolink::plan_book_text(
        &slot.reader_v3.view(),
        None,
        cx.workspace().auto_links(),
        &text.into(),
    )
}

op! {
    Create = "relation_type.create", Write, Book,
    "Create a named relation with a description and direction, initially without rows.",
    fn(cx, input: CreateTypeIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        let CreateTypeIn { name, description, direction, .. } = input;
        name_available(&slot.reader_v3.view(), &name, None)?;
        let description = linked_description(cx, &slot, description)?;
        let id = RelationTypeId::new_v7();
        let saved = id.clone();
        let book = input.book;
        let (receipt, _) = cx.write_book_v3(&slot, Replaces::nothing(), move |txn| {
            name_available(&txn.view(), &name, None)?;
            txn.relation_type(&saved)?.name(&name)?.description(&description)?
                .direction(direction)?.created_at(Some(now()))?;
            let mut receipt = RestoreIn::new(book);
            receipt.types.push(undefine(&txn.view(), &saved, false)?);
            Ok(receipt)
        })?;
        receipt.declare(cx);
        cx.effect(EffectAction::Created, "relation_type", id.as_str(), None);
        Ok(Done { id: id.to_string() })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct RenameIn {
    pub book: String,
    pub id: String,
    pub name: String,
}

op! {
    Rename = "relation_type.rename", Write, Book,
    "Rename a relation. Normalized names are unique within the project.",
    fn(cx, input: RenameIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        let id = require_type(&slot.reader_v3.view(), &pid("relation type", &input.id)?)?.id;
        // Same-named relations a merge read as one are renamed together, so
        // they keep reading as one (`RT-NAME`).
        let ids = group(&slot.reader_v3.view(), &id);
        let replaced = Replaces::records(ids.iter().map(|g| rec(CollectionV3::RelationTypes, g)));
        let saved = id.clone();
        let book = input.book;
        let (receipt, _) = cx.write_book_v3(&slot, replaced, move |txn| {
            let view = txn.view();
            require_type(&view, &saved)?;
            if group(&view, &saved) != ids {
                return Err(WsError::Conflict("relation definitions changed".into()));
            }
            name_available(&view, &input.name, Some(&saved))?;
            let before: Vec<_> = ids.iter().filter_map(|g| view.relation_type_raw(g)).collect();
            for g in &ids {
                txn.relation_type(g)?.name(&input.name)?;
            }
            let view = txn.view();
            let mut receipt = RestoreIn::new(book);
            for was in before {
                let now = view.relation_type_raw(&was.id).expect("written");
                if now.name != was.name {
                    receipt.types.push(TypeStep::Name { id: was.id.to_string(), from: now.name, to: was.name });
                }
            }
            Ok(receipt)
        })?;
        receipt.declare(cx);
        cx.effect(EffectAction::Updated, "relation_type", id.as_str(), None);
        Ok(Done { id: id.to_string() })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct DescriptionIn {
    pub book: String,
    pub id: String,
    pub description: LinkedTextIn,
}

op! {
    SetDescription = "relation_type.set_description", Write, Book,
    "Edit a relation's description, which can contain links to entries.",
    fn(cx, input: DescriptionIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        let id = require_type(&slot.reader_v3.view(), &pid("relation type", &input.id)?)?.id;
        let description = linked_description(cx, &slot, input.description)?;
        let saved = id.clone();
        let book = input.book;
        let (receipt, _) = cx.write_book_v3(&slot, Replaces::record(CollectionV3::RelationTypes, &id), move |txn| {
            let was = require_type(&txn.view(), &saved)?;
            txn.relation_type(&saved)?.description(&description)?;
            let now = txn.view().relation_type_raw(&saved).expect("written");
            let mut receipt = RestoreIn::new(book);
            if now.description != was.description {
                receipt.types.push(TypeStep::Description {
                    id: saved.to_string(), from: now.description, to: was.description,
                });
            }
            Ok(receipt)
        })?;
        receipt.declare(cx);
        cx.effect(EffectAction::Updated, "relation_type", id.as_str(), None);
        Ok(Done { id: id.to_string() })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct DirectionIn {
    pub book: String,
    pub id: String,
    pub direction: RelationDirection,
}

op! {
    SetDirection = "relation_type.set_direction", Write, Book,
    "Change the direction of every row of a relation, preserving its left and right entries.",
    fn(cx, input: DirectionIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        let id = require_type(&slot.reader_v3.view(), &pid("relation type", &input.id)?)?.id;
        let saved = id.clone();
        let book = input.book;
        let (receipt, _) = cx.write_book_v3(&slot, Replaces::record(CollectionV3::RelationTypes, &id), move |txn| {
            let was = require_type(&txn.view(), &saved)?;
            txn.relation_type(&saved)?.direction(input.direction)?;
            let mut receipt = RestoreIn::new(book);
            if was.direction != input.direction {
                receipt.types.push(TypeStep::Direction {
                    id: saved.to_string(), from: input.direction, to: was.direction,
                });
            }
            Ok(receipt)
        })?;
        receipt.declare(cx);
        cx.effect(EffectAction::Updated, "relation_type", id.as_str(), None);
        Ok(Done { id: id.to_string() })
    }
}

op! {
    Delete = "relation_type.delete", Write, Book,
    "Delete a relation and all its rows in one edit.",
    fn(cx, input: EntityIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        let view = slot.reader_v3.view();
        let id = require_type(&view, &pid("relation type", &input.id)?)?.id;
        // The relation with every stored definition and row a merge reads
        // as it (`RT-NAME`), the rows that do not count included.
        let ids = group(&view, &id);
        let rows = stored_rows(&view, &id);
        let replacements = Replaces::records(
            rows.iter().map(|row| rec(CollectionV3::Relations, &row.id))
                .chain(ids.iter().map(|g| rec(CollectionV3::RelationTypes, g)))
        );
        let saved = id.clone();
        let book = input.book;
        let (removed, _) = cx.write_book_v3(&slot, replacements, move |txn| {
            let view = txn.view();
            require_type(&view, &saved)?;
            if stored_rows(&view, &saved) != rows || group(&view, &saved) != ids {
                return Err(WsError::Conflict("relation rows changed".into()));
            }
            let mut receipt = RestoreIn::new(book);
            for g in &ids {
                let was = view.relation_type_raw(g).expect("in the group");
                receipt.types.push(TypeStep::Define {
                    id: g.to_string(), relation: StoredRelation::of(&was), keep_with_rows: false,
                });
            }
            for row in &rows {
                let pairs: Vec<_> = row.pairs().map(|(l, r)| (l.clone(), r.clone())).collect();
                receipt.put(row, pairs);
                txn.purge(CollectionV3::Relations, row.id.as_str())?;
            }
            for g in &ids {
                txn.purge(CollectionV3::RelationTypes, g.as_str())?;
            }
            Ok((rows, receipt))
        })?;
        let (removed, receipt) = removed;
        for row in removed {
            cx.effect(EffectAction::Purged, "relation_row", row.id.as_str(), None);
        }
        receipt.declare(cx);
        cx.effect(EffectAction::Purged, "relation_type", id.as_str(), None);
        Ok(Done { id: id.to_string() })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PairIn {
    pub book: String,
    /// The left live entry's ID.
    pub left: String,
    /// The right live entry's ID.
    pub right: String,
    /// An existing relation type. Supply exactly one of this and `new_type`.
    #[serde(default)]
    pub relation_type: Option<String>,
    /// Create the relation and the pair in the same edit.
    #[serde(default)]
    pub new_type: Option<Definition>,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct Placed {
    pub id: String,
    pub relation_type: String,
    pub existing: bool,
}

op! {
    CreatePair = "relation_row.create_pair", Write, Book,
    "Relate two distinct live entries. Reuse a matching row or start a new one. Return the row ID, with no write if the pair already exists.",
    fn(cx, input: PairIn) -> Placed {
        create_pair(cx, input)
    }
}

fn create_pair(cx: &Cx<'_>, input: PairIn) -> Result<Placed> {
    let slot = cx.book_v3(&input.book)?;
    let view = slot.reader_v3.view();
    let left = live(&view, &input.left)?.id;
    let right = live(&view, &input.right)?.id;
    if left == right {
        return Err(WsError::invalid("relation needs two distinct entries"));
    }
    let (id, direction, definition) = match (input.relation_type, input.new_type) {
        (Some(id), None) => {
            let kind = require_type(&view, &pid("relation type", &id)?)?;
            (kind.id, kind.direction, None)
        }
        (None, Some(d)) => {
            name_available(&view, &d.name, None)?;
            let description = linked_description(cx, &slot, d.description)?;
            (
                RelationTypeId::new_v7(),
                d.direction,
                Some((d.name, description)),
            )
        }
        _ => return Err(WsError::invalid("provide relation_type or new_type")),
    };
    let rows = rows_for(&view, &id);
    let placement = m::plan_relation_pair(&rows, direction, &left, &right);
    let replaces = match placement {
        PairPlacement::Existing(row) => {
            cx.undo_nothing();
            return Ok(Placed {
                id: row.to_string(),
                relation_type: id.to_string(),
                existing: true,
            });
        }
        PairPlacement::Add(row, _, _) => Replaces::record(CollectionV3::Relations, &row),
        PairPlacement::NewRow => Replaces::nothing(),
    };
    let saved = id.clone();
    let create_type = definition.is_some();
    let fresh = RelationId::new_v7();
    let fresh_again = fresh.clone();
    let book = input.book;
    let (row, _) = cx.write_book_v3(&slot, replaces, move |txn| {
        let current = txn.view();
        live(&current, left.as_str())?;
        live(&current, right.as_str())?;
        if let Some((name, _)) = &definition {
            name_available(&current, name, None)?;
        } else if require_type(&current, &saved)?.direction != direction
            || rows_for(&current, &saved) != rows
        {
            return Err(WsError::Conflict(
                "relation rows or direction changed".into(),
            ));
        }
        txn.prune_relation_rows()?;
        if let Some((name, description)) = &definition {
            txn.relation_type(&saved)?
                .name(name)?
                .description(description)?
                .direction(direction)?
                .created_at(Some(now()))?;
        }
        let (row, _) = txn.put_relation_pair(
            &saved,
            &rows,
            direction,
            (&left, &right),
            &fresh_again,
            Some(now()),
        )?;
        // The undo takes out only this pair, wherever the row has grown
        // since, and the relation it made only while no other row is in it.
        let view = txn.view();
        let mut receipt = RestoreIn::new(book);
        let written = require_row(&view, &row)?;
        receipt.take(
            &written,
            [(left.clone(), right.clone())]
                .into_iter()
                .chain([(right.clone(), left.clone())])
                .filter(|(l, r)| written.left.contains(l) && written.right.contains(r)),
        );
        if definition.is_some() {
            receipt.types.push(undefine(&view, &saved, true)?);
        }
        Ok((row, receipt))
    })?;
    let (row, receipt) = row;
    if create_type {
        cx.effect(EffectAction::Created, "relation_type", id.as_str(), None);
    }
    receipt.declare(cx);
    let effect = if row == fresh {
        EffectAction::Created
    } else {
        EffectAction::Updated
    };
    cx.effect(effect, "relation_row", row.as_str(), None);
    Ok(Placed {
        id: row.to_string(),
        relation_type: id.to_string(),
        existing: false,
    })
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct AddEntryIn {
    pub book: String,
    pub id: String,
    pub side: RelationSide,
    pub entry: String,
}

op! {
    AddEntry = "relation_row.add_entry", Write, Book,
    "Add a live entry to one side of a row. Every new pair must be unique within the relation.",
    fn(cx, input: AddEntryIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        let id: RelationId = pid("relation row", &input.id)?;
        let saved = id.clone();
        let book = input.book.clone();
        let (receipt, _) = cx.write_book_v3(&slot, Replaces::record(CollectionV3::Relations, &id), move |txn| {
            let view = txn.view();
            let row = require_row(&view, &saved)?;
            let entry = live(&view, &input.entry)?.id;
            if row.side(input.side).contains(&entry) {
                return Ok(None);
            }
            let opposite = row.opposite(input.side);
            if opposite.is_empty() || opposite.contains(&entry) {
                return Err(WsError::invalid("a row needs two disjoint, nonempty sides"));
            }
            let direction = require_type(&view, &row.relation_type)?.direction;
            let others = rows_for(&view, &row.relation_type);
            let mut pairs = Vec::new();
            for other in opposite {
                let (left, right) = match input.side {
                    RelationSide::Left => (&entry, other),
                    RelationSide::Right => (other, &entry),
                };
                if others.iter().any(|row| row.has_pair(left, right, direction)) {
                    return Err(WsError::invalid("the pair is already in another row"));
                }
                pairs.push((left.clone(), right.clone()));
            }
            txn.prune_relation_rows()?;
            txn.relation_row(&saved)?.member(input.side, &entry)?;
            // The undo takes out the pairs this made, and only them.
            let mut receipt = RestoreIn::new(book);
            receipt.take(&row, pairs);
            Ok(Some(receipt))
        })?;
        match receipt {
            Some(receipt) => {
                receipt.declare(cx);
                cx.effect(EffectAction::Updated, "relation_row", id.as_str(), None);
            }
            None => cx.undo_nothing(),
        }
        Ok(Done { id: id.to_string() })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct RemoveEntryIn {
    pub book: String,
    pub id: String,
    pub entry: String,
}

op! {
    RemoveEntry = "relation_row.remove_entry", Write, Book,
    "Remove an entry from a row. An empty side removes the row; removing the last row also removes the relation.",
    fn(cx, input: RemoveEntryIn) -> Done {
        remove_from_row(cx, &input.book, input.id, Some(pid("entry", &input.entry)?))
    }
}

op! {
    DeleteRow = "relation_row.delete", Write, Book,
    "Delete a row. Removing the last row also removes the relation.",
    fn(cx, input: EntityIn) -> Done {
        remove_from_row(cx, &input.book, input.id, None)
    }
}

fn remove_from_row(cx: &Cx<'_>, book: &str, id: String, entry: Option<EntryId>) -> Result<Done> {
    let slot = cx.book_v3(book)?;
    let view = slot.reader_v3.view();
    let row = require_row(&view, &pid("relation row", &id)?)?;
    let plan = Removal::plan(&view, &row, entry.as_ref())?;
    let replaced = Replaces::records(plan.records());
    let ty = plan.kind.clone();
    let book_id = book.to_owned();
    let (outcome, _) = cx.write_book_v3(&slot, replaced, move |txn| {
        let current = txn.view();
        let now = Removal::plan(&current, &require_row(&current, &row.id)?, entry.as_ref())?;
        if require_row(&current, &row.id)? != row || now != plan {
            return Err(WsError::Conflict("relation rows changed".into()));
        }
        let receipt = plan.receipt(&current, book_id)?;
        txn.prune_relation_rows()?;
        plan.apply(txn)?;
        Ok((plan, receipt))
    })?;
    let (plan, receipt) = outcome;
    receipt.declare(cx);
    cx.effect(
        if plan.delete_row {
            EffectAction::Purged
        } else {
            EffectAction::Updated
        },
        "relation_row",
        &id,
        None,
    );
    for (other, members) in &plan.others {
        let gone = !plan.after(other, members).is_whole();
        cx.effect(
            if gone {
                EffectAction::Purged
            } else {
                EffectAction::Updated
            },
            "relation_row",
            other.id.as_str(),
            None,
        );
    }
    if !plan.delete_types.is_empty() {
        cx.effect(EffectAction::Purged, "relation_type", ty.as_str(), None);
    }
    Ok(Done { id })
}

/// What taking `entry` out of a row (or the whole row) writes: the row, the
/// same pairs out of the relation's other rows (so a pair two rows held
/// after a merge does not come back from the second), and the relation
/// itself when no row that counts is left (`REL-TYPE-EXISTS`).
#[derive(Debug, PartialEq)]
struct Removal {
    /// The relation the row reads as.
    kind: RelationTypeId,
    row: RelationRow,
    entry: Option<EntryId>,
    delete_row: bool,
    /// Other rows (as they are) and the members they lose.
    others: Vec<(RelationRow, Vec<EntryId>)>,
    /// Every stored definition the relation reads as, when it goes.
    delete_types: Vec<RelationTypeId>,
}

impl Removal {
    fn plan(view: &BookViewV3<'_>, row: &RelationRow, entry: Option<&EntryId>) -> Result<Self> {
        let delete_row = match entry {
            Some(entry) if row.left.contains(entry) => row.left.len() == 1,
            Some(entry) if row.right.contains(entry) => row.right.len() == 1,
            Some(entry) => {
                return Err(WsError::not_found("entry in relation row", entry.as_str()));
            }
            None => true,
        };
        let relation = require_type(view, &row.relation_type)?;
        let pairs: BTreeSet<_> = match entry {
            Some(entry) => row.pairs_of(entry),
            None => row.pairs().map(|(l, r)| (l.clone(), r.clone())).collect(),
        }
        .into_iter()
        .map(|(l, r)| m::pair_key(relation.direction, &l, &r))
        .collect();
        let rows = rows_for(view, &relation.id);
        let by_id: BTreeMap<_, _> = rows.iter().map(|r| (r.id.clone(), r.clone())).collect();
        let own: BTreeMap<RelationId, RelationTypeId> = view
            .relations_raw()
            .into_iter()
            .map(|r| (r.id, r.relation_type))
            .collect();
        let others: Vec<_> = m::plan_pair_removal(&rows, relation.direction, &pairs, Some(&row.id))
            .into_iter()
            .map(|(id, members)| {
                let mut other = by_id[&id].clone();
                if let Some(kind) = own.get(&id) {
                    other.relation_type = kind.clone();
                }
                (other, members)
            })
            .collect();
        let mut plan = Self {
            kind: relation.id.clone(),
            row: row.clone(),
            entry: entry.cloned(),
            delete_row,
            others,
            delete_types: Vec::new(),
        };
        let remains = rows.iter().any(|r| {
            if r.id == row.id {
                return !delete_row;
            }
            match plan.others.iter().find(|(o, _)| o.id == r.id) {
                Some((o, members)) => plan.after(o, members).is_whole(),
                None => true,
            }
        });
        if !remains {
            plan.delete_types = group(view, &relation.id);
        }
        Ok(plan)
    }

    fn after(&self, row: &RelationRow, members: &[EntryId]) -> RelationRow {
        let mut after = row.clone();
        for member in members {
            after.left.remove(member);
            after.right.remove(member);
        }
        after
    }

    fn records(&self) -> Vec<dr_doc::v3::RecordKeyV3> {
        std::iter::once(rec(CollectionV3::Relations, &self.row.id))
            .chain(
                self.others
                    .iter()
                    .map(|(o, _)| rec(CollectionV3::Relations, &o.id)),
            )
            .chain(
                self.delete_types
                    .iter()
                    .map(|g| rec(CollectionV3::RelationTypes, g)),
            )
            .collect()
    }

    /// The undo: the pairs taken out of each row put back into it, and the
    /// relation brought back when it went (taken away again on redo only
    /// while no other row is in it).
    fn receipt(&self, view: &BookViewV3<'_>, book: String) -> Result<RestoreIn> {
        let mut receipt = RestoreIn::new(book);
        for g in &self.delete_types {
            let was = view
                .relation_type_raw(g)
                .ok_or_else(|| WsError::not_found("relation type", g.as_str()))?;
            receipt.types.push(TypeStep::Define {
                id: g.to_string(),
                relation: StoredRelation::of(&was),
                keep_with_rows: true,
            });
        }
        match &self.entry {
            Some(entry) => receipt.put(&self.row, self.row.pairs_of(entry)),
            None => receipt.put(
                &self.row,
                self.row.pairs().map(|(l, r)| (l.clone(), r.clone())),
            ),
        }
        for (other, members) in &self.others {
            let kept = self.after(other, members);
            let gone: Vec<_> = other
                .pairs()
                .filter(|(l, r)| !(kept.left.contains(*l) && kept.right.contains(*r)))
                .map(|(l, r)| (l.clone(), r.clone()))
                .collect();
            receipt.put(other, gone);
        }
        Ok(receipt)
    }

    fn apply(&self, txn: &mut dr_doc::v3::BookTxnV3<'_>) -> Result<()> {
        if self.delete_row {
            txn.purge(CollectionV3::Relations, self.row.id.as_str())?;
        } else {
            txn.relation_row(&self.row.id)?
                .remove_member(self.entry.as_ref().expect("member removal"))?;
        }
        for (other, members) in &self.others {
            if self.after(other, members).is_whole() {
                let w = txn.relation_row(&other.id)?;
                for member in members {
                    w.remove_member(member)?;
                }
            } else {
                txn.purge(CollectionV3::Relations, other.id.as_str())?;
            }
        }
        for g in &self.delete_types {
            txn.purge(CollectionV3::RelationTypes, g.as_str())?;
        }
        Ok(())
    }
}

// ---- for callers that read before they write (the Agent's resolver) ----

/// Every stored relation id that reads as `kind`'s relation after a merge
/// (`RT-NAME`), the shown one first: what renaming or deleting it writes.
pub fn relation_group(view: &BookViewV3<'_>, kind: &RelationTypeId) -> Vec<RelationTypeId> {
    group(view, kind)
}

/// The rows of `kind`'s relation that count, as `relation_row.create_pair`
/// plans its row against.
pub fn relation_rows(view: &BookViewV3<'_>, kind: &RelationTypeId) -> Vec<RelationRow> {
    rows_for(view, kind)
}

/// Every stored row of `kind`'s relation: what `relation_type.delete` takes out.
pub fn relation_stored_rows(view: &BookViewV3<'_>, kind: &RelationTypeId) -> Vec<RelationRow> {
    stored_rows(view, kind)
}

/// The rows and relations `relation_row.remove_entry` (`entry`) or
/// `relation_row.delete` (`None`) on `row` writes: the row, the other rows
/// the same pairs leave, and the relation's definitions when no row that
/// counts is left.
pub fn relation_removal_records(
    view: &BookViewV3<'_>,
    row: &RelationId,
    entry: Option<&EntryId>,
) -> Result<(Vec<RelationId>, Vec<RelationTypeId>)> {
    let plan = Removal::plan(view, &require_row(view, row)?, entry)?;
    Ok((
        std::iter::once(plan.row.id.clone())
            .chain(plan.others.iter().map(|(o, _)| o.id.clone()))
            .collect(),
        plan.delete_types,
    ))
}

/// The undo of making relation `id`: take it away while it reads as this
/// write left it, keeping it (`keep_with_rows`) or refusing when others put
/// rows in it since.
fn undefine(view: &BookViewV3<'_>, id: &RelationTypeId, keep_with_rows: bool) -> Result<TypeStep> {
    let now = view
        .relation_type_raw(id)
        .ok_or_else(|| WsError::not_found("relation type", id.as_str()))?;
    Ok(TypeStep::Undefine {
        id: id.to_string(),
        relation: StoredRelation::of(&now),
        keep_with_rows,
    })
}
