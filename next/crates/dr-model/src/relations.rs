//! Relations and linked text in a current-format project.

use std::collections::BTreeSet;
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
                let label: String = if label.is_empty() { original.collect() } else {
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
            return Some(PairPlacement::Add(row.id.clone(), RelationSide::Right, right.clone()));
        }
        rows.iter()
            .find(|r| r.right.len() == 1 && r.right.contains(right) && !r.left.is_empty())
            .map(|row| PairPlacement::Add(row.id.clone(), RelationSide::Left, left.clone()))
    };
    find(left, right)
        .or_else(|| (direction == RelationDirection::Symmetric).then(|| find(right, left)).flatten())
        .unwrap_or(PairPlacement::NewRow)
}
