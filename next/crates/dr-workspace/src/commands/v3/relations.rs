//! Book-wide relations. Rows connect the Cartesian product of two entry sets.

use super::*;
use crate::dto::LinkedTextIn;
use dr_model::shared::normalize_relation_type_name;
use dr_model::v3::{LinkedText, PairPlacement, RelationDirection, RelationRow, RelationSide};

pub(crate) fn register(r: &mut Registry) {
    r.add::<List>()
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

fn name_available(
    view: &BookViewV3<'_>,
    name: &str,
    except: Option<&RelationTypeId>,
) -> Result<()> {
    name_ok(name)?;
    let normalized = normalize_relation_type_name(name);
    if view
        .relation_types_raw()
        .iter()
        .any(|relation| Some(&relation.id) != except && relation.normalized_name == normalized)
    {
        return Err(WsError::invalid("duplicate relation name"));
    }
    Ok(())
}

fn require_type(view: &BookViewV3<'_>, id: &RelationTypeId) -> Result<m::RelationTypeV3> {
    view.relation_type_raw(id)
        .ok_or_else(|| WsError::not_found("relation type", id.as_str()))
}

fn rows_for(view: &BookViewV3<'_>, kind: &RelationTypeId) -> Vec<RelationRow> {
    view.relations_raw()
        .into_iter()
        .filter(|row| &row.relation_type == kind)
        .collect()
}

fn require_row(view: &BookViewV3<'_>, id: &RelationId) -> Result<RelationRow> {
    view.relations_raw()
        .into_iter()
        .find(|row| &row.id == id)
        .ok_or_else(|| WsError::not_found("relation row", id.as_str()))
}

/// The links a relation's description gets (`autolink::plan_book_text`):
/// `stored` is the description it replaces (`None` for a new relation).
fn linked_description(
    cx: &Cx<'_>,
    slot: &BookSlot,
    stored: Option<&LinkedText>,
    text: &LinkedTextIn,
) -> Result<LinkedText> {
    let names = cx
        .workspace()
        .auto_links()
        .then(|| crate::autolink::book_cache(slot).2);
    crate::autolink::plan_book_text(&slot.reader_v3.view(), None, names.as_deref(), stored, text)
}

op! {
    Create = "relation_type.create", Write, Book,
    "Create a named relation with a description and direction, initially without rows.",
    fn(cx, input: CreateTypeIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        let CreateTypeIn { name, description, direction, .. } = input;
        name_available(&slot.reader_v3.view(), &name, None)?;
        let description = linked_description(cx, &slot, None, &description)?;
        let id = RelationTypeId::new_v7();
        let saved = id.clone();
        let (_, at) = cx.write_book_v3(&slot, Replaces::nothing(), move |txn| {
            name_available(&txn.view(), &name, None)?;
            txn.relation_type(&saved)?.name(&name)?.description(&description)?
                .direction(direction)?.created_at(Some(now()))?;
            Ok(())
        })?;
        undo(cx, &slot, &at, vec![key("relation_types", &id)]);
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
        let id: RelationTypeId = pid("relation type", &input.id)?;
        let saved = id.clone();
        let (_, at) = cx.write_book_v3(&slot, Replaces::record(CollectionV3::RelationTypes, &id), move |txn| {
            require_type(&txn.view(), &saved)?;
            name_available(&txn.view(), &input.name, Some(&saved))?;
            txn.relation_type(&saved)?.name(&input.name)?;
            Ok(())
        })?;
        undo(cx, &slot, &at, vec![key("relation_types", &id)]);
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
        let id: RelationTypeId = pid("relation type", &input.id)?;
        let stored = slot.reader_v3.view().relation_type_raw(&id).map(|r| r.description);
        let description = linked_description(cx, &slot, stored.as_ref(), &input.description)?;
        let saved = id.clone();
        let (_, at) = cx.write_book_v3(&slot, Replaces::record(CollectionV3::RelationTypes, &id), move |txn| {
            require_type(&txn.view(), &saved)?;
            txn.relation_type(&saved)?.description(&description)?;
            Ok(())
        })?;
        undo(cx, &slot, &at, vec![key("relation_types", &id)]);
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
        let id: RelationTypeId = pid("relation type", &input.id)?;
        let saved = id.clone();
        let (_, at) = cx.write_book_v3(&slot, Replaces::record(CollectionV3::RelationTypes, &id), move |txn| {
            require_type(&txn.view(), &saved)?;
            txn.relation_type(&saved)?.direction(input.direction)?;
            Ok(())
        })?;
        undo(cx, &slot, &at, vec![key("relation_types", &id)]);
        cx.effect(EffectAction::Updated, "relation_type", id.as_str(), None);
        Ok(Done { id: id.to_string() })
    }
}

op! {
    Delete = "relation_type.delete", Write, Book,
    "Delete a relation and all its rows in one edit.",
    fn(cx, input: EntityIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        let id: RelationTypeId = pid("relation type", &input.id)?;
        let rows = rows_for(&slot.reader_v3.view(), &id);
        let replacements = Replaces::records(
            rows.iter().map(|row| rec(CollectionV3::Relations, &row.id))
                .chain([rec(CollectionV3::RelationTypes, &id)])
        );
        let saved = id.clone();
        let (removed, at) = cx.write_book_v3(&slot, replacements, move |txn| {
            require_type(&txn.view(), &saved)?;
            if rows_for(&txn.view(), &saved) != rows {
                return Err(WsError::Conflict("relation rows changed".into()));
            }
            for row in &rows {
                txn.purge(CollectionV3::Relations, row.id.as_str())?;
            }
            txn.purge(CollectionV3::RelationTypes, saved.as_str())?;
            Ok(rows)
        })?;
        let mut keys = vec![key("relation_types", &id)];
        for row in removed {
            cx.effect(EffectAction::Purged, "relation_row", row.id.as_str(), None);
            keys.push(key("relations", &row.id));
        }
        undo(cx, &slot, &at, keys);
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
            let description = linked_description(cx, &slot, None, &d.description)?;
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
    let (row, at) = cx.write_book_v3(&slot, replaces, move |txn| {
        let current = txn.view();
        live(&current, left.as_str())?;
        live(&current, right.as_str())?;
        if let Some((name, description)) = &definition {
            name_available(&current, name, None)?;
            txn.relation_type(&saved)?
                .name(name)?
                .description(description)?
                .direction(direction)?
                .created_at(Some(now()))?;
        } else if require_type(&current, &saved)?.direction != direction
            || rows_for(&current, &saved) != rows
        {
            return Err(WsError::Conflict(
                "relation rows or direction changed".into(),
            ));
        }
        Ok(txn
            .put_relation_pair(
                &saved,
                &rows,
                direction,
                (&left, &right),
                &fresh_again,
                Some(now()),
            )?
            .0)
    })?;
    let mut keys = vec![key("relations", &row)];
    if create_type {
        keys.push(key("relation_types", &id));
        cx.effect(EffectAction::Created, "relation_type", id.as_str(), None);
    }
    undo(cx, &slot, &at, keys);
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
        let (changed, at) = cx.write_book_v3(&slot, Replaces::record(CollectionV3::Relations, &id), move |txn| {
            let view = txn.view();
            let row = require_row(&view, &saved)?;
            let entry = live(&view, &input.entry)?.id;
            if row.side(input.side).contains(&entry) {
                return Ok(false);
            }
            let opposite = row.opposite(input.side);
            if opposite.is_empty() || opposite.contains(&entry) {
                return Err(WsError::invalid("a row needs two disjoint, nonempty sides"));
            }
            let direction = require_type(&view, &row.relation_type)?.direction;
            let others = rows_for(&view, &row.relation_type);
            for other in opposite {
                let (left, right) = match input.side {
                    RelationSide::Left => (&entry, other),
                    RelationSide::Right => (other, &entry),
                };
                if others.iter().any(|row| row.has_pair(left, right, direction)) {
                    return Err(WsError::invalid("the pair is already in another row"));
                }
            }
            txn.relation_row(&saved)?.member(input.side, &entry)?;
            Ok(true)
        })?;
        if changed {
            undo(cx, &slot, &at, vec![key("relations", &id)]);
            cx.effect(EffectAction::Updated, "relation_row", id.as_str(), None);
        } else {
            cx.undo_nothing();
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
    let delete_row = match &entry {
        Some(entry) if row.left.contains(entry) => row.left.len() == 1,
        Some(entry) if row.right.contains(entry) => row.right.len() == 1,
        Some(entry) => return Err(WsError::not_found("entry in relation row", entry.as_str())),
        None => true,
    };
    let ty = row.relation_type.clone();
    let delete_type = delete_row && rows_for(&view, &ty).len() == 1;
    let mut records = vec![rec(CollectionV3::Relations, &row.id)];
    let mut keys = vec![key("relations", &row.id)];
    if delete_type {
        records.push(rec(CollectionV3::RelationTypes, &ty));
        keys.push(key("relation_types", &ty));
    }
    let kind = ty.clone();
    let (_, at) = cx.write_book_v3(&slot, Replaces::records(records), move |txn| {
        let current = txn.view();
        if require_row(&current, &row.id)? != row
            || delete_row && (rows_for(&current, &kind).len() == 1) != delete_type
        {
            return Err(WsError::Conflict("relation rows changed".into()));
        }
        if delete_row {
            txn.purge(CollectionV3::Relations, row.id.as_str())?;
            if delete_type {
                txn.purge(CollectionV3::RelationTypes, kind.as_str())?;
            }
        } else {
            txn.relation_row(&row.id)?
                .remove_member(entry.as_ref().expect("member removal"))?;
        }
        Ok(())
    })?;
    undo(cx, &slot, &at, keys);
    cx.effect(
        if delete_row {
            EffectAction::Purged
        } else {
            EffectAction::Updated
        },
        "relation_row",
        &id,
        None,
    );
    if delete_type {
        cx.effect(EffectAction::Purged, "relation_type", ty.as_str(), None);
    }
    Ok(Done { id })
}
