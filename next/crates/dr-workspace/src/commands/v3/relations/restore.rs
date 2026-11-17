//! Undo and redo of the relation commands (`relation_type.restore`). Each
//! step names only what its write changed (the pairs it put into or took
//! out of rows, the definition fields it wrote, a relation it made or
//! removed) with the values that write left, and changes them back only
//! while they still read so: members, rows, names and descriptions that
//! others wrote since stay. A value someone else changed since refuses the
//! whole step (`Conflict`) and nothing is written; what already reads as
//! the step wants is left alone. The contract of `membership.restore`.
use super::*;

/// One pair as stored in a row: `(left entry, right entry)`.
pub type StoredPair = (String, String);

/// A relation's definition as stored.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct StoredRelation {
    pub name: String,
    pub description: LinkedText,
    pub direction: RelationDirection,
    #[serde(default)]
    pub created_at: Option<i64>,
}

impl StoredRelation {
    pub(super) fn of(relation: &m::RelationTypeV3) -> Self {
        Self {
            name: relation.name.clone(),
            description: relation.description.clone(),
            direction: relation.direction,
            created_at: relation.created_at.map(|t| t.0),
        }
    }

    fn reads_as(&self, relation: &m::RelationTypeV3) -> bool {
        self.name == relation.name
            && self.description == relation.description
            && self.direction == relation.direction
    }

    fn to_type(&self, id: &RelationTypeId) -> m::RelationTypeV3 {
        m::RelationTypeV3 {
            id: id.clone(),
            name: self.name.clone(),
            normalized_name: normalize_relation_type_name(&self.name),
            description: self.description.clone(),
            direction: self.direction,
            created_at: self.created_at.map(dr_model::time::Timestamp),
        }
    }
}

/// What one write did to a relation's definition, as its undo or redo.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum TypeStep {
    /// Bring the relation back as `relation` when it is not there.
    Define {
        id: String,
        relation: StoredRelation,
        /// Carried to the step that takes it away again.
        #[serde(default)]
        keep_with_rows: bool,
    },
    /// Take the relation away while it reads as `relation` and, once the
    /// rows of this step are done, no row of its own is left. With
    /// `keep_with_rows` a relation others put rows in stays; without it
    /// that refuses the step.
    Undefine {
        id: String,
        relation: StoredRelation,
        #[serde(default)]
        keep_with_rows: bool,
    },
    /// Set the name back to `to` while it reads `from`.
    Name {
        id: String,
        from: String,
        to: String,
    },
    Description {
        id: String,
        from: LinkedText,
        to: LinkedText,
    },
    Direction {
        id: String,
        from: RelationDirection,
        to: RelationDirection,
    },
}

/// What one write did to one row: the pairs to put back into it (the row
/// is made again, with `relation_type` and `created_at`, when it is gone)
/// and the pairs to take out of it. Putting a pair back adds no other pair;
/// taking one out takes no other pair (a member goes only when all its
/// pairs in the row go, the row when a side is left empty).
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct RowStep {
    pub id: String,
    pub relation_type: String,
    #[serde(default)]
    pub created_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub put: Vec<StoredPair>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub take: Vec<StoredPair>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct RestoreIn {
    pub book: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub types: Vec<TypeStep>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rows: Vec<RowStep>,
}

impl RestoreIn {
    pub(super) fn new(book: impl ToString) -> Self {
        Self {
            book: book.to_string(),
            types: Vec::new(),
            rows: Vec::new(),
        }
    }

    pub(super) fn is_empty(&self) -> bool {
        self.types.is_empty() && self.rows.is_empty()
    }

    /// The pairs `pairs` of `row` (as it was) to put back.
    pub(super) fn put(
        &mut self,
        row: &RelationRow,
        pairs: impl IntoIterator<Item = (EntryId, EntryId)>,
    ) {
        self.row(row, pairs, true);
    }

    /// The pairs `pairs` of `row` to take out again.
    pub(super) fn take(
        &mut self,
        row: &RelationRow,
        pairs: impl IntoIterator<Item = (EntryId, EntryId)>,
    ) {
        self.row(row, pairs, false);
    }

    fn row(
        &mut self,
        row: &RelationRow,
        pairs: impl IntoIterator<Item = (EntryId, EntryId)>,
        put: bool,
    ) {
        let pairs: Vec<StoredPair> = pairs
            .into_iter()
            .map(|(l, r)| (l.to_string(), r.to_string()))
            .collect();
        if pairs.is_empty() {
            return;
        }
        let id = row.id.to_string();
        let step = match self.rows.iter_mut().find(|s| s.id == id) {
            Some(step) => step,
            None => {
                self.rows.push(RowStep {
                    id,
                    relation_type: row.relation_type.to_string(),
                    created_at: row.created_at.map(|t| t.0),
                    put: Vec::new(),
                    take: Vec::new(),
                });
                self.rows.last_mut().expect("pushed")
            }
        };
        let list = if put { &mut step.put } else { &mut step.take };
        for pair in pairs {
            if !list.contains(&pair) {
                list.push(pair);
            }
        }
    }

    /// Declare this as the command's undo (or nothing when it is empty).
    pub(super) fn declare(self, cx: &Cx<'_>) {
        if self.is_empty() {
            cx.undo_nothing();
        } else {
            cx.undo_with(Invocation::new("relation_type.restore", self));
        }
    }
}

op! {
    RelationRestore = "relation_type.restore", Write, Book,
    "Undo or redo one relation write: put back or take out the pairs, definition values and relations it names while they still read as that write left them. Anything changed since refuses the whole step; what others added stays.",
    fn(cx, input: RestoreIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        let book = input.book.clone();
        let id = input.types.first().map(|t| match t {
            TypeStep::Define { id, .. } | TypeStep::Undefine { id, .. } | TypeStep::Name { id, .. }
            | TypeStep::Description { id, .. } | TypeStep::Direction { id, .. } => id.clone(),
        }).or_else(|| input.rows.first().map(|r| r.id.clone())).unwrap_or_default();
        let ((redo, effects), _) = cx.write_book_v3(&slot, Replaces::nothing(), move |txn| {
            let plan = Plan::make(&txn.view(), &input)?;
            let effects = plan.effects();
            plan.apply(txn)?;
            Ok((plan.receipt(book), effects))
        })?;
        for (action, kind, id) in effects {
            cx.effect(action, kind, id, None);
        }
        redo.declare(cx);
        Ok(Done { id })
    }
}

fn changed(what: &str) -> WsError {
    WsError::Conflict(format!("{what} changed after the recorded relation write"))
}

fn parse_pairs(pairs: &[StoredPair]) -> Result<BTreeSet<(EntryId, EntryId)>> {
    pairs
        .iter()
        .map(|(l, r)| Ok((pid("entry", l)?, pid("entry", r)?)))
        .collect()
}

fn pair_set(row: &RelationRow) -> BTreeSet<(EntryId, EntryId)> {
    row.pairs().map(|(l, r)| (l.clone(), r.clone())).collect()
}

enum Field {
    Name(String),
    Description(LinkedText),
    Direction(RelationDirection),
}

/// The checked plan of one restore, made from the document as it is,
/// before anything is written.
struct Plan {
    /// Every row that counts now, by id, as stored (its own relation id).
    kept: BTreeMap<RelationId, RelationRow>,
    /// The rows this restore changes, as they will be.
    rows: BTreeMap<RelationId, RelationRow>,
    defines: Vec<(RelationTypeId, StoredRelation)>,
    fields: Vec<(RelationTypeId, Field)>,
    undefines: Vec<RelationTypeId>,
    redo_types: Vec<TypeStep>,
    redo_rows: Vec<RowStep>,
}

impl Plan {
    fn make(view: &BookViewV3<'_>, input: &RestoreIn) -> Result<Self> {
        let mut types: BTreeMap<RelationTypeId, m::RelationTypeV3> = view
            .relation_types_raw()
            .into_iter()
            .map(|t| (t.id.clone(), t))
            .collect();
        // Rows that count, under their own stored relation id.
        let raw_types: BTreeMap<RelationId, RelationTypeId> = view
            .relations_raw()
            .into_iter()
            .map(|row| (row.id, row.relation_type))
            .collect();
        let kept: BTreeMap<RelationId, RelationRow> = view
            .relations_kept()
            .into_iter()
            .map(|mut row| {
                if let Some(own) = raw_types.get(&row.id) {
                    row.relation_type = own.clone();
                }
                (row.id.clone(), row)
            })
            .collect();
        let mut plan = Plan {
            kept,
            rows: BTreeMap::new(),
            defines: Vec::new(),
            fields: Vec::new(),
            undefines: Vec::new(),
            redo_types: Vec::new(),
            redo_rows: Vec::new(),
        };

        // 1. Relations brought back.
        let defining: BTreeSet<String> = input
            .types
            .iter()
            .filter_map(|t| match t {
                TypeStep::Define { id, .. } => Some(id.clone()),
                _ => None,
            })
            .collect();
        for step in &input.types {
            let TypeStep::Define {
                id,
                relation,
                keep_with_rows,
            } = step
            else {
                continue;
            };
            let id: RelationTypeId = pid("relation type", id)?;
            if let Some(stored) = types.get(&id) {
                if relation.reads_as(stored) {
                    continue;
                }
                return Err(changed("the relation"));
            }
            name_ok(&relation.name)?;
            let normalized = normalize_relation_type_name(&relation.name);
            if types
                .values()
                .any(|t| t.normalized_name == normalized && !defining.contains(t.id.as_str()))
            {
                return Err(WsError::Conflict(
                    "another relation has this name now".into(),
                ));
            }
            types.insert(id.clone(), relation.to_type(&id));
            plan.defines.push((id.clone(), relation.clone()));
            plan.redo_types.push(TypeStep::Undefine {
                id: id.to_string(),
                relation: relation.clone(),
                keep_with_rows: *keep_with_rows,
            });
        }

        // 2. Rows.
        let winners = m::relation_type_winners(&types.values().cloned().collect::<Vec<_>>());
        let mut stored_entries: BTreeMap<EntryId, bool> = BTreeMap::new();
        let mut stored = |entry: &EntryId| {
            *stored_entries
                .entry(entry.clone())
                .or_insert_with(|| view.entry_raw(entry).is_some())
        };
        // Rows this step puts pairs back into: a pair one of them gets back
        // is not "already in another row" for the others (the same pair
        // taken out of two rows goes back into both).
        let restoring: BTreeSet<&str> = input
            .rows
            .iter()
            .filter(|step| !step.put.is_empty())
            .map(|step| step.id.as_str())
            .collect();
        for step in &input.rows {
            let id: RelationId = pid("relation row", &step.id)?;
            let kind: RelationTypeId = pid("relation type", &step.relation_type)?;
            let mut row = plan.current(&id);
            if !step.take.is_empty()
                && let Some(before) = row.clone()
            {
                let take = parse_pairs(&step.take)?;
                let pairs = pair_set(&before);
                if !pairs.is_disjoint(&take) {
                    let mut after = before.clone();
                    for member in before.left.iter().chain(&before.right) {
                        let own = before.pairs_of(member);
                        if !own.is_empty() && own.iter().all(|pair| take.contains(pair)) {
                            after.left.remove(member);
                            after.right.remove(member);
                        }
                    }
                    let left = pair_set(&after);
                    if !left.is_disjoint(&take) {
                        return Err(changed("the relation row"));
                    }
                    let removed = pairs.difference(&left).cloned().collect::<Vec<_>>();
                    plan.record(&before, removed, true);
                    plan.rows.insert(id.clone(), after.clone());
                    row = Some(after);
                }
            }
            if !step.put.is_empty() {
                let mut put = parse_pairs(&step.put)?;
                // An entry purged since cannot come back, nor its pairs.
                put.retain(|(l, r)| stored(l) && stored(r));
                let before = match row {
                    Some(row) if row.is_whole() => row,
                    _ => {
                        if !types.contains_key(&kind) {
                            return Err(changed("the relation"));
                        }
                        RelationRow {
                            id: id.clone(),
                            relation_type: kind.clone(),
                            left: BTreeSet::new(),
                            right: BTreeSet::new(),
                            created_at: step.created_at.map(dr_model::time::Timestamp),
                        }
                    }
                };
                let canonical = winners
                    .get(&before.relation_type)
                    .ok_or_else(|| changed("the relation"))?;
                let direction = types[canonical].direction;
                let others: Vec<RelationRow> = plan
                    .all_rows()
                    .into_iter()
                    .filter(|r| {
                        r.id != id
                            && !restoring.contains(r.id.as_str())
                            && winners.get(&r.relation_type) == Some(canonical)
                    })
                    .collect();
                let pairs = pair_set(&before);
                let missing: Vec<_> = put
                    .iter()
                    .filter(|(l, r)| {
                        !pairs.contains(&(l.clone(), r.clone()))
                            && !others.iter().any(|o| o.has_pair(l, r, direction))
                    })
                    .cloned()
                    .collect();
                if missing.is_empty() {
                    continue;
                }
                let mut after = before.clone();
                for (l, r) in &missing {
                    if after.right.contains(l) || after.left.contains(r) {
                        return Err(changed("the relation row"));
                    }
                    after.left.insert(l.clone());
                    after.right.insert(r.clone());
                }
                let created: Vec<_> = pair_set(&after).difference(&pairs).cloned().collect();
                if created.iter().any(|pair| !put.contains(pair)) {
                    return Err(changed("the relation row"));
                }
                plan.record(&after, created, false);
                plan.rows.insert(id, after);
            }
        }

        // 3. Definition values.
        let renaming: BTreeSet<String> = input
            .types
            .iter()
            .filter_map(|t| match t {
                TypeStep::Name { id, .. } => Some(id.clone()),
                _ => None,
            })
            .collect();
        for step in &input.types {
            let (id, from, to, redo): (&String, Field, Field, TypeStep) = match step {
                TypeStep::Name { id, from, to } => (
                    id,
                    Field::Name(from.clone()),
                    Field::Name(to.clone()),
                    TypeStep::Name {
                        id: id.clone(),
                        from: to.clone(),
                        to: from.clone(),
                    },
                ),
                TypeStep::Description { id, from, to } => (
                    id,
                    Field::Description(from.clone()),
                    Field::Description(to.clone()),
                    TypeStep::Description {
                        id: id.clone(),
                        from: to.clone(),
                        to: from.clone(),
                    },
                ),
                TypeStep::Direction { id, from, to } => (
                    id,
                    Field::Direction(*from),
                    Field::Direction(*to),
                    TypeStep::Direction {
                        id: id.clone(),
                        from: *to,
                        to: *from,
                    },
                ),
                _ => continue,
            };
            let kind: RelationTypeId = pid("relation type", id)?;
            let current = types.get(&kind).ok_or_else(|| changed("the relation"))?;
            let reads = |field: &Field| match field {
                Field::Name(name) => &current.name == name,
                Field::Description(text) => &current.description == text,
                Field::Direction(direction) => &current.direction == direction,
            };
            if reads(&to) {
                continue;
            }
            if !reads(&from) {
                return Err(changed("the relation"));
            }
            if let Field::Name(name) = &to {
                name_ok(name)?;
                let normalized = normalize_relation_type_name(name);
                if types.values().any(|t| {
                    t.id != kind
                        && t.normalized_name == normalized
                        && !renaming.contains(t.id.as_str())
                }) {
                    return Err(WsError::Conflict(
                        "another relation has this name now".into(),
                    ));
                }
            }
            let entry = types.get_mut(&kind).expect("checked");
            match &to {
                Field::Name(name) => {
                    entry.name = name.trim().to_owned();
                    entry.normalized_name = normalize_relation_type_name(name);
                }
                Field::Description(text) => entry.description = text.clone(),
                Field::Direction(direction) => entry.direction = *direction,
            }
            plan.fields.push((kind, to));
            plan.redo_types.push(redo);
        }

        // 4. Relations taken away, after the rows.
        for step in &input.types {
            let TypeStep::Undefine {
                id,
                relation,
                keep_with_rows,
            } = step
            else {
                continue;
            };
            let kind: RelationTypeId = pid("relation type", id)?;
            let Some(current) = types.get(&kind) else {
                continue;
            };
            if !relation.reads_as(current) {
                return Err(changed("the relation"));
            }
            let has_rows = plan
                .all_rows()
                .iter()
                .any(|row| row.relation_type == kind && row.is_whole());
            if has_rows {
                if *keep_with_rows {
                    continue;
                }
                return Err(changed("the rows of the relation"));
            }
            plan.redo_types.push(TypeStep::Define {
                id: kind.to_string(),
                relation: StoredRelation::of(current),
                keep_with_rows: *keep_with_rows,
            });
            plan.undefines.push(kind.clone());
            types.remove(&kind);
        }
        Ok(plan)
    }

    /// A row as this restore has it so far.
    fn current(&self, id: &RelationId) -> Option<RelationRow> {
        self.rows.get(id).or_else(|| self.kept.get(id)).cloned()
    }

    fn all_rows(&self) -> Vec<RelationRow> {
        let mut all = self.kept.clone();
        all.extend(self.rows.clone());
        all.into_values().collect()
    }

    fn record(&mut self, row: &RelationRow, pairs: Vec<(EntryId, EntryId)>, put: bool) {
        let mut redo = RestoreIn::new("");
        redo.rows = std::mem::take(&mut self.redo_rows);
        redo.row(row, pairs, put);
        self.redo_rows = redo.rows;
    }

    fn effects(&self) -> Vec<(EffectAction, &'static str, String)> {
        let mut out = Vec::new();
        for (id, _) in &self.defines {
            out.push((EffectAction::Created, "relation_type", id.to_string()));
        }
        for (id, row) in &self.rows {
            let action = match (self.kept.contains_key(id), row.is_whole()) {
                (false, true) => EffectAction::Created,
                (true, true) => EffectAction::Updated,
                (true, false) => EffectAction::Purged,
                (false, false) => continue,
            };
            out.push((action, "relation_row", id.to_string()));
        }
        for (id, _) in &self.fields {
            out.push((EffectAction::Updated, "relation_type", id.to_string()));
        }
        for id in &self.undefines {
            out.push((EffectAction::Purged, "relation_type", id.to_string()));
        }
        out
    }

    fn apply(&self, txn: &mut dr_doc::v3::BookTxnV3<'_>) -> Result<()> {
        txn.prune_relation_rows()?;
        for (id, relation) in &self.defines {
            txn.relation_type(id)?
                .name(&relation.name)?
                .description(&relation.description)?
                .direction(relation.direction)?
                .created_at(relation.created_at.map(dr_model::time::Timestamp))?;
        }
        for (id, after) in &self.rows {
            match (self.kept.get(id), after.is_whole()) {
                (_, false) => txn.purge(CollectionV3::Relations, id.as_str())?,
                (None, true) => {
                    let w = txn.fresh_relation_row(id, &after.relation_type, after.created_at)?;
                    for entry in &after.left {
                        w.member(RelationSide::Left, entry)?;
                    }
                    for entry in &after.right {
                        w.member(RelationSide::Right, entry)?;
                    }
                }
                (Some(before), true) => {
                    let w = txn.relation_row(id)?;
                    for entry in before.left.iter().chain(&before.right) {
                        if !after.contains(entry) {
                            w.remove_member(entry)?;
                        }
                    }
                    for entry in after.left.difference(&before.left) {
                        w.member(RelationSide::Left, entry)?;
                    }
                    for entry in after.right.difference(&before.right) {
                        w.member(RelationSide::Right, entry)?;
                    }
                }
            }
        }
        for (id, field) in &self.fields {
            let w = txn.relation_type(id)?;
            match field {
                Field::Name(name) => w.name(name)?,
                Field::Description(text) => w.description(text)?,
                Field::Direction(direction) => w.direction(*direction)?,
            };
        }
        for id in &self.undefines {
            txn.purge(CollectionV3::RelationTypes, id.as_str())?;
        }
        Ok(())
    }

    fn receipt(&self, book: String) -> RestoreIn {
        RestoreIn {
            book,
            types: self.redo_types.clone(),
            rows: self.redo_rows.clone(),
        }
    }
}
