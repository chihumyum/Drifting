//! A sidebar draft describes an exact new row, not a pair to fit into an
//! existing row. Validate its entire Cartesian product before writing it.
use super::*;

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GroupIn {
    pub book: String,
    /// The displayed (canonical) relation ID when the draft was submitted.
    pub relation_type: String,
    /// Refuse a draft whose left/right meaning changed since it was shown.
    pub expected_direction: RelationDirection,
    /// Duplicate IDs are treated as one member; no missing or trashed entry
    /// is silently dropped from either side.
    pub left: Vec<String>,
    pub right: Vec<String>,
}

op! {
    CreateGroup = "relation_row.create_group", Write, Book,
    "Create one exact relation row from two nonempty disjoint live-entry sets, in one undo step. Refuse stale direction or any pair already in another row.",
    fn(cx, input: GroupIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        let relation: RelationTypeId = pid("relation type", &input.relation_type)?;
        let id = RelationId::new_v7();
        let saved = id.clone();
        let (receipt, _) = cx.write_book_v3(&slot, Replaces::nothing(), move |txn| {
            // All reads and business validation happen in the same book
            // write job. In particular no first pair is published before
            // learning that a later member is gone or duplicates a pair.
            let view = txn.view();
            let kind = require_type(&view, &relation)?;
            if kind.id != relation || kind.direction != input.expected_direction {
                return Err(WsError::Conflict("the selected relation or direction changed".into()));
            }
            let members = |ids: &[String]| -> Result<BTreeSet<EntryId>> {
                ids.iter().map(|id| live(&view, id).map(|entry| entry.id)).collect()
            };
            let left = members(&input.left)?;
            let right = members(&input.right)?;
            if left.is_empty() || right.is_empty() || !left.is_disjoint(&right) {
                return Err(WsError::invalid("a row needs two disjoint, nonempty sides"));
            }
            let rows = rows_for(&view, &relation);
            for left in &left {
                for right in &right {
                    if rows.iter().any(|row| row.has_pair(left, right, kind.direction)) {
                        return Err(WsError::invalid("the pair is already in another row"));
                    }
                }
            }
            let row = RelationRow {
                id: saved,
                relation_type: relation,
                left,
                right,
                created_at: Some(now()),
            };
            let mut receipt = RestoreIn::new(input.book);
            receipt.take(&row, row.pairs().map(|(left, right)| (left.clone(), right.clone())));

            txn.prune_relation_rows()?;
            let writer = txn.relation_row(&row.id)?;
            writer.relation_type(&row.relation_type)?.created_at(row.created_at)?;
            for entry in &row.left {
                writer.member(RelationSide::Left, entry)?;
            }
            for entry in &row.right {
                writer.member(RelationSide::Right, entry)?;
            }
            Ok(receipt)
        })?;
        receipt.declare(cx);
        cx.effect(EffectAction::Created, "relation_row", id.as_str(), None);
        Ok(Done { id: id.to_string() })
    }
}
