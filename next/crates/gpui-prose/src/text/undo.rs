//! The author's undo history on top of the text source's Loro undo stack.
//!
//! Loro's own merge interval stays 0, so every commit is its own Loro item
//! (merging inside Loro, or `group_start` / `group_end`, hits Loro #1228 and
//! #1245); the source reports how many items each edit pushed. This module
//! groups items into *author steps* itself: edits within
//! [`UndoConfig::merge_interval`] of a step's first edit join it, and one
//! undo pops every item of the step. Enter, an input-method commit, a paste
//! or a format change start a new step ([`AuthorUndo::force_new_step`]).
//!
//! Each Loro item also records the text it deleted that held an edge of an
//! anchor. Undo puts deleted text back as new characters, which the anchor's
//! old cursors cannot find; after undoing an item the document finds where
//! its deleted text came back and re-anchors those anchors there.

use std::time::{Duration, Instant};

use super::{anchor::AnchorId, mirror::TextOp};

/// How the author's undo history is kept.
#[derive(Clone, Debug)]
pub struct UndoConfig {
    /// Edits closer than this to a step's first edit undo together.
    pub merge_interval: Duration,
    /// Commits whose origin starts with one of these are not the author's and
    /// never enter the history (Agent writes, seeding, sync bookkeeping). Used
    /// by [`crate::text::LoroSource`]; other sources apply their own list.
    pub exclude_origin_prefixes: Vec<String>,
    /// Loro items kept at most (by the source).
    pub max_items: usize,
}

impl Default for UndoConfig {
    fn default() -> Self {
        UndoConfig {
            merge_interval: Duration::from_millis(500),
            exclude_origin_prefixes: [
                crate::text::ORIGIN_AGENT_PREFIX,
                "seed",
                "genesis",
                "import",
                "mirror",
                "repair",
            ]
            .into_iter()
            .map(String::from)
            .collect(),
            max_items: 100_000,
        }
    }
}

/// An anchor edge that sat inside deleted text: where, from the start of the
/// deletion, the anchor started and ended (`None` for an edge outside it).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct AnchorRestore {
    pub id: AnchorId,
    pub start: Option<usize>,
    pub end: Option<usize>,
}

/// One deletion inside a commit.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct DeletionRecord {
    pub len: usize,
    pub restores: Vec<AnchorRestore>,
}

/// What one Loro undo item needs besides Loro's own record.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct ItemRecord {
    pub deletions: Vec<DeletionRecord>,
}

impl ItemRecord {
    fn has_restores(&self) -> bool {
        self.deletions.iter().any(|d| !d.restores.is_empty())
    }
}

#[derive(Clone, Debug)]
pub(crate) struct Step {
    pub items: Vec<ItemRecord>,
    pub started: Instant,
    /// The edit across chapters this step is part of (the editor undoes the
    /// group's steps in the other chapters with it).
    pub group: Option<u64>,
}

pub(crate) struct AuthorUndo {
    pub steps: Vec<Step>,
    pub redo: Vec<Step>,
    pub force_new_step: bool,
    /// The next commit joins the last step whatever the time (a host's
    /// derived edit, such as automatic links, undone with the typing).
    pub join_last_step: bool,
    /// Deletions made since the last commit.
    pub pending: ItemRecord,
    merge_interval: Duration,
}

impl AuthorUndo {
    pub fn new(config: &UndoConfig) -> AuthorUndo {
        AuthorUndo {
            steps: Vec::new(),
            redo: Vec::new(),
            force_new_step: false,
            join_last_step: false,
            pending: ItemRecord::default(),
            merge_interval: config.merge_interval,
        }
    }

    /// Folds `pushed` new Loro items (from the commit just made) into the
    /// steps; drops the pending record if the commit was not the author's.
    pub fn after_commit(&mut self, pushed: usize) {
        let split = std::mem::take(&mut self.force_new_step);
        let join = std::mem::take(&mut self.join_last_step);
        let record = std::mem::take(&mut self.pending);
        if pushed == 0 {
            return;
        }
        let mut items: Vec<ItemRecord> = (1..pushed).map(|_| ItemRecord::default()).collect();
        items.push(record);
        let now = Instant::now();
        match self.steps.last_mut() {
            Some(step) if join => step.items.extend(items),
            Some(step) if !split && now.duration_since(step.started) < self.merge_interval => {
                step.items.extend(items);
            }
            _ => self.steps.push(Step {
                items,
                started: now,
                group: None,
            }),
        }
        self.redo.clear();
    }

    /// A redone step never merges with later typing.
    pub fn long_ago() -> Instant {
        Instant::now()
            .checked_sub(Duration::from_secs(3600))
            .unwrap_or_else(Instant::now)
    }

    pub fn needs_ops(record: &ItemRecord) -> bool {
        record.has_restores()
    }
}

/// Where each deletion of an undone item came back: for each deletion (in
/// order), the position of an insert of exactly its length among the undo's
/// ops, matched from the last deletion backwards. `None` when no single
/// insert matches (a remote edit split it); those anchors stay collapsed.
pub(crate) fn restore_points(record: &ItemRecord, ops: &[TextOp]) -> Vec<Option<usize>> {
    let mut used = vec![false; ops.len()];
    let mut points = vec![None; record.deletions.len()];
    for (ix, deletion) in record.deletions.iter().enumerate().rev() {
        if deletion.len == 0 {
            continue;
        }
        if let Some(op_ix) = (0..ops.len())
            .rev()
            .find(|&k| !used[k] && ops[k].inserted == deletion.len && ops[k].deleted == 0)
        {
            used[op_ix] = true;
            points[ix] = Some(ops[op_ix].pos);
        }
    }
    points
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_inserts_by_length() {
        let record = ItemRecord {
            deletions: vec![
                DeletionRecord {
                    len: 3,
                    restores: vec![],
                },
                DeletionRecord {
                    len: 5,
                    restores: vec![],
                },
            ],
        };
        let ops = [
            TextOp {
                pos: 10,
                deleted: 0,
                inserted: 5,
            },
            TextOp {
                pos: 2,
                deleted: 0,
                inserted: 3,
            },
        ];
        assert_eq!(restore_points(&record, &ops), vec![Some(2), Some(10)]);
    }
}
