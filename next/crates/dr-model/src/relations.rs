//! Relations and linked text in a current-format project.

use std::collections::{BTreeMap, BTreeSet};
use std::ops::Range;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::check::Violation;
use crate::id::{EntryId, RelationId, RelationTypeId};
use crate::time::Timestamp;

/// One entry link, using half-open Unicode scalar offsets in the accompanying text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct EntryTextLink {
    pub start: usize,
    pub end: usize,
    #[schemars(with = "String")]
    pub entry: EntryId,
}

impl EntryTextLink {
    pub fn range(&self) -> Range<usize> {
        self.start..self.end
    }
}

/// Text with ordered, non-overlapping entry links. The saved spelling is the
/// fallback when an entry cannot be resolved.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LinkedText {
    pub text: String,
    #[serde(default)]
    pub links: Vec<EntryTextLink>,
}

impl LinkedText {
    pub fn plain(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            links: Vec::new(),
        }
    }

    pub fn validate(&self) -> Result<(), Violation> {
        let len = self.text.chars().count();
        let mut after = 0;
        for link in &self.links {
            if link.start < after || link.start >= link.end || link.end > len {
                return Err(Violation {
                    invariant: "ENTRY-TEXT-LINK-RANGES",
                    detail: "link ranges must be ordered, nonempty and inside the text".into(),
                });
            }
            after = link.end;
        }
        Ok(())
    }

    /// Keep or remap links, retaining all written characters. Used when
    /// carrying text across projects with only a subset of its targets.
    pub fn remap_links(&self, mut entry: impl FnMut(&EntryId) -> Option<EntryId>) -> Self {
        Self {
            text: self.text.clone(),
            links: self
                .links
                .iter()
                .filter_map(|link| {
                    Some(EntryTextLink {
                        entry: entry(&link.entry)?,
                        ..link.clone()
                    })
                })
                .collect(),
        }
    }

    /// Project live links using their target's current title. Characters under
    /// a missing link keep their saved spelling, with no exposed link.
    pub fn with_titles(&self, mut title: impl FnMut(&EntryId) -> Option<String>) -> Self {
        if self.links.is_empty() {
            return self.clone();
        }
        let mut chars = self.text.chars();
        let mut result = Self::default();
        let mut consumed = 0;
        let mut written = 0;
        for link in &self.links {
            let gap = link.start - consumed;
            result.text.extend(chars.by_ref().take(gap));
            written += gap;
            let original = chars.by_ref().take(link.end - link.start);
            if let Some(label) = title(&link.entry) {
                let label: String = if label.is_empty() {
                    original.collect()
                } else {
                    original.for_each(drop);
                    label
                };
                let end = written + label.chars().count();
                result.text.push_str(&label);
                result.links.push(EntryTextLink {
                    start: written,
                    end,
                    entry: link.entry.clone(),
                });
                written = end;
            } else {
                result.text.extend(original);
                written += link.end - link.start;
            }
            consumed = link.end;
        }
        result.text.extend(chars);
        result
    }
}

/// A relation's direction applies to all its rows. Switching it never moves a member.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RelationDirection {
    #[default]
    Directed,
    Symmetric,
}

impl RelationDirection {
    pub fn pair<'a>(self, left: &'a EntryId, right: &'a EntryId) -> (&'a EntryId, &'a EntryId) {
        if self == Self::Symmetric && right < left {
            (right, left)
        } else {
            (left, right)
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RelationSide {
    Left,
    Right,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RelationTypeV3 {
    pub id: RelationTypeId,
    pub name: String,
    pub normalized_name: String,
    pub description: LinkedText,
    pub direction: RelationDirection,
    pub created_at: Option<Timestamp>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RelationRow {
    pub id: RelationId,
    pub relation_type: RelationTypeId,
    pub left: BTreeSet<EntryId>,
    pub right: BTreeSet<EntryId>,
    pub created_at: Option<Timestamp>,
}

impl RelationRow {
    pub fn side(&self, side: RelationSide) -> &BTreeSet<EntryId> {
        match side {
            RelationSide::Left => &self.left,
            RelationSide::Right => &self.right,
        }
    }

    pub fn opposite(&self, side: RelationSide) -> &BTreeSet<EntryId> {
        match side {
            RelationSide::Left => &self.right,
            RelationSide::Right => &self.left,
        }
    }

    pub fn contains(&self, entry: &EntryId) -> bool {
        self.left.contains(entry) || self.right.contains(entry)
    }

    pub fn pairs(&self) -> impl Iterator<Item = (&EntryId, &EntryId)> {
        self.left
            .iter()
            .flat_map(|left| self.right.iter().map(move |right| (left, right)))
    }

    pub fn has_pair(&self, left: &EntryId, right: &EntryId, direction: RelationDirection) -> bool {
        (self.left.contains(left) && self.right.contains(right))
            || (direction == RelationDirection::Symmetric
                && self.left.contains(right)
                && self.right.contains(left))
    }

    /// The side `entry` is on, if it is in the row.
    pub fn side_of(&self, entry: &EntryId) -> Option<RelationSide> {
        if self.left.contains(entry) {
            Some(RelationSide::Left)
        } else if self.right.contains(entry) {
            Some(RelationSide::Right)
        } else {
            None
        }
    }

    /// The pairs `entry` makes in this row, as stored `(left, right)`.
    pub fn pairs_of(&self, entry: &EntryId) -> Vec<(EntryId, EntryId)> {
        match self.side_of(entry) {
            Some(RelationSide::Left) => self
                .right
                .iter()
                .map(|right| (entry.clone(), right.clone()))
                .collect(),
            Some(RelationSide::Right) => self
                .left
                .iter()
                .map(|left| (left.clone(), entry.clone()))
                .collect(),
            None => Vec::new(),
        }
    }

    /// Both sides hold at least one entry: the row relates something.
    pub fn is_whole(&self) -> bool {
        !self.left.is_empty() && !self.right.is_empty()
    }
}

/// The key one pair of a relation is counted by: `(left, right)` for a
/// directed relation, the two entries in id order for a symmetric one.
pub fn pair_key(
    direction: RelationDirection,
    left: &EntryId,
    right: &EntryId,
) -> (EntryId, EntryId) {
    let (left, right) = direction.pair(left, right);
    (left.clone(), right.clone())
}

/// `RT-NAME`'s read rule. Two devices can each create (or rename to) the
/// same normalized name; after the merge those relations read as one: the
/// earliest by `(created_at, id)`, whose name, description and direction
/// are shown and under which the rows of the others are read. Maps every
/// relation id to the id it reads as (itself for the earliest).
pub fn relation_type_winners(types: &[RelationTypeV3]) -> BTreeMap<RelationTypeId, RelationTypeId> {
    let mut first: BTreeMap<&str, &RelationTypeV3> = BTreeMap::new();
    for relation in types {
        let slot = first
            .entry(relation.normalized_name.as_str())
            .or_insert(relation);
        if (relation.created_at, &relation.id) < (slot.created_at, &slot.id) {
            *slot = relation;
        }
    }
    types
        .iter()
        .map(|relation| {
            (
                relation.id.clone(),
                first[relation.normalized_name.as_str()].id.clone(),
            )
        })
        .collect()
}

/// The rows of a relation that count, from the stored rows in creation
/// order: each read under the relation it belongs to after `RT-NAME`'s
/// merge (`winners`; a row of an unknown relation is dropped), without
/// members that are no longer stored at all (`stored`: purged on another
/// device while this one added them), and only while both sides keep an
/// entry. A row that does not count is not "the last row" of its relation
/// and the next relation write cleans it (`REL-ROW-SIDES`). Members in
/// Recently Deleted are kept: they come back on restore.
pub fn kept_relation_rows(
    rows: Vec<RelationRow>,
    winners: &BTreeMap<RelationTypeId, RelationTypeId>,
    stored: impl Fn(&EntryId) -> bool,
) -> Vec<RelationRow> {
    rows.into_iter()
        .filter_map(|mut row| {
            row.relation_type = winners.get(&row.relation_type)?.clone();
            row.left.retain(&stored);
            row.right.retain(&stored);
            row.is_whole().then_some(row)
        })
        .collect()
}

/// The rows a reader shows, from the rows that count ([`kept_relation_rows`],
/// in creation order): only live members, both sides nonempty. A pair two
/// rows of one relation hold (two devices opened a row for it at once, or a
/// switch to symmetric met a reversed pair) stays in both rows, is counted
/// once by [`pair_key`] (`REL-SEMANTIC-UNIQUE`), and taking it out of one
/// takes it out of both ([`plan_pair_removal`]).
pub fn visible_relation_rows(
    kept: Vec<RelationRow>,
    live: impl Fn(&EntryId) -> bool,
) -> Vec<RelationRow> {
    kept.into_iter()
        .filter_map(|mut row| {
            row.left.retain(&live);
            row.right.retain(&live);
            row.is_whole().then_some(row)
        })
        .collect()
}

/// The members to take out of the other rows of a relation when `pairs`
/// (by [`pair_key`]) leave it, so a pair two rows hold does not come back
/// from the second one: in each row but `except`, every member all of whose
/// pairs there are among `pairs`. Only those pairs go. A row that cannot
/// drop such a pair alone (both of its entries are paired with others in
/// that row) keeps it, and then reads as a row of its own. Rows in the
/// order given; members in id order per side, left first.
pub fn plan_pair_removal(
    rows: &[RelationRow],
    direction: RelationDirection,
    pairs: &BTreeSet<(EntryId, EntryId)>,
    except: Option<&RelationId>,
) -> Vec<(RelationId, Vec<EntryId>)> {
    rows.iter()
        .filter(|row| Some(&row.id) != except)
        .filter_map(|row| {
            let removed: Vec<EntryId> = row
                .left
                .iter()
                .chain(&row.right)
                .filter(|member| {
                    let own = row.pairs_of(member);
                    !own.is_empty()
                        && own
                            .iter()
                            .all(|(left, right)| pairs.contains(&pair_key(direction, left, right)))
                })
                .cloned()
                .collect();
            (!removed.is_empty()).then(|| (row.id.clone(), removed))
        })
        .collect()
}

#[derive(Debug, PartialEq, Eq)]
pub enum PairPlacement {
    Existing(RelationId),
    Add(RelationId, RelationSide, EntryId),
    NewRow,
}

/// `rows` are the stored rows of one relation, in creation order (id breaks ties).
/// Use stored memberships here so restoring a trashed entry cannot add pairs
/// the author never asked for. Import and live commands use the same rules.
pub fn plan_relation_pair(
    rows: &[RelationRow],
    direction: RelationDirection,
    left: &EntryId,
    right: &EntryId,
) -> PairPlacement {
    if let Some(row) = rows.iter().find(|r| r.has_pair(left, right, direction)) {
        return PairPlacement::Existing(row.id.clone());
    }
    let find = |left: &EntryId, right: &EntryId| {
        if let Some(row) = rows
            .iter()
            .find(|r| r.left.len() == 1 && r.left.contains(left) && !r.right.is_empty())
        {
            return Some(PairPlacement::Add(
                row.id.clone(),
                RelationSide::Right,
                right.clone(),
            ));
        }
        rows.iter()
            .find(|r| r.right.len() == 1 && r.right.contains(right) && !r.left.is_empty())
            .map(|row| PairPlacement::Add(row.id.clone(), RelationSide::Left, left.clone()))
    };
    find(left, right)
        .or_else(|| {
            (direction == RelationDirection::Symmetric)
                .then(|| find(right, left))
                .flatten()
        })
        .unwrap_or(PairPlacement::NewRow)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::time::Timestamp;

    fn e(id: &str) -> EntryId {
        EntryId::parse(id).unwrap()
    }

    fn row(id: &str, kind: &str, at: i64, left: &[&str], right: &[&str]) -> RelationRow {
        RelationRow {
            id: RelationId::parse(id).unwrap(),
            relation_type: RelationTypeId::parse(kind).unwrap(),
            left: left.iter().map(|x| e(x)).collect(),
            right: right.iter().map(|x| e(x)).collect(),
            created_at: Some(Timestamp(at)),
        }
    }

    fn kind(id: &str, name: &str, at: i64) -> RelationTypeV3 {
        RelationTypeV3 {
            id: RelationTypeId::parse(id).unwrap(),
            name: name.into(),
            normalized_name: crate::shared::normalize_relation_type_name(name),
            description: LinkedText::default(),
            direction: RelationDirection::Directed,
            created_at: Some(Timestamp(at)),
        }
    }

    #[test]
    fn same_named_relations_read_as_the_earliest() {
        let types = [
            kind("later", "Allies", 20),
            kind("earlier", " allies ", 10),
            kind("other", "Rivals", 5),
        ];
        let winners = relation_type_winners(&types);
        let id = |s: &str| RelationTypeId::parse(s).unwrap();
        assert_eq!(winners[&id("later")], id("earlier"));
        assert_eq!(winners[&id("earlier")], id("earlier"));
        assert_eq!(winners[&id("other")], id("other"));
        // Rows of both read under the earliest; a row of an unknown relation
        // and one whose side has no stored entry left do not count.
        let kept = kept_relation_rows(
            vec![
                row("r1", "later", 1, &["a"], &["b"]),
                row("r2", "gone", 2, &["a"], &["c"]),
                row("r3", "earlier", 3, &["a"], &["purged"]),
                row("r4", "earlier", 4, &["c", "purged"], &["d"]),
            ],
            &winners,
            |entry| entry.as_str() != "purged",
        );
        assert_eq!(
            kept,
            vec![
                row("r1", "earlier", 1, &["a"], &["b"]),
                row("r4", "earlier", 4, &["c"], &["d"]),
            ]
        );
    }

    #[test]
    fn shown_rows_keep_repeated_pairs_and_drop_a_side_left_in_the_trash() {
        let shown = visible_relation_rows(
            vec![
                row("r1", "t", 1, &["a"], &["b"]),
                // The same pair again: shown, counted once by its key.
                row("r2", "t", 2, &["a"], &["b"]),
                row("r3", "t", 3, &["a"], &["c", "trashed"]),
                row("r4", "t", 4, &["a"], &["trashed"]),
            ],
            |entry| entry.as_str() != "trashed",
        );
        assert_eq!(
            shown,
            vec![
                row("r1", "t", 1, &["a"], &["b"]),
                row("r2", "t", 2, &["a"], &["b"]),
                row("r3", "t", 3, &["a"], &["c"]),
            ]
        );
        let keys: BTreeSet<_> = shown
            .iter()
            .flat_map(RelationRow::pairs)
            .map(|(l, r)| pair_key(RelationDirection::Symmetric, l, r))
            .collect();
        assert_eq!(keys.len(), 2);
    }

    #[test]
    fn a_pair_leaves_every_row_that_holds_it_alone() {
        let rows = [
            row("r1", "t", 1, &["a"], &["b"]),
            row("r2", "t", 2, &["a"], &["b"]),
            row("r3", "t", 3, &["a", "d"], &["b"]),
            row("r4", "t", 4, &["a", "d"], &["b", "e"]),
        ];
        let pairs = [pair_key(RelationDirection::Directed, &e("a"), &e("b"))].into();
        let plan = plan_pair_removal(
            &rows,
            RelationDirection::Directed,
            &pairs,
            Some(&RelationId::parse("r1").unwrap()),
        );
        let plan: Vec<_> = plan
            .iter()
            .map(|(id, members)| {
                (
                    id.as_str(),
                    members.iter().map(EntryId::as_str).collect::<Vec<_>>(),
                )
            })
            .collect();
        // r2 goes whole; r3 loses a (d–b stays); r4 cannot drop a–b alone.
        assert_eq!(plan, [("r2", vec!["a", "b"]), ("r3", vec!["a"])]);
    }
}
