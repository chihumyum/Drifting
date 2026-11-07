//! From an incremental update to a paragraph patch for dr-store.
//!
//! The update says which paragraphs are old ones kept whole and which were
//! re-read. A kept paragraph's row is unchanged unless the duplicate-id rule
//! now decides differently for it (an earlier paragraph with the same stored
//! id appeared or went away). Every run of rows between two unchanged ones
//! becomes a [`Splice`]; its ends are trimmed where a re-read paragraph came
//! out as it was (a style change that left the text alone, an embed re-read
//! after a change elsewhere in the embeds).

use dr_store::index::{BlockRow, DerivedPatch, RefRow, Splice};

use crate::incremental::{Slot, Update};
use crate::paragraphs::{Block, kept_ids, references};

/// What was derived from a document last: kept for the next diffs.
pub(crate) struct State {
    pub blocks: Vec<Block>,
    /// Whether each paragraph keeps its stored block id.
    pub kept: Vec<bool>,
    pub references: Vec<RefRow>,
}

/// The state after `update`, and the patch from `old` to it. `None` when
/// the update refers to an old paragraph twice or past the end (it cannot,
/// but then the caller reads the whole document).
pub(crate) fn next(old: State, update: Update) -> Option<(State, DerivedPatch)> {
    let slots = update.slots;
    let stored = slots.iter().map(|s| match s {
        Slot::Kept(i) => old.blocks.get(*i).and_then(|b| b.stored_id.as_ref()),
        Slot::Read(b) => b.stored_id.as_ref(),
    });
    let kept = kept_ids(stored);

    // Unchanged rows, as (old index, new index), in order.
    let same = slots.iter().enumerate().filter_map(|(j, s)| match s {
        Slot::Kept(i) if old.kept.get(*i) == Some(&kept[j]) => Some((*i, j)),
        _ => None,
    });
    let row = |j: usize| -> Option<BlockRow> {
        match &slots[j] {
            Slot::Kept(i) => old.blocks.get(*i).map(|b| b.row(kept[j])),
            Slot::Read(b) => Some(b.row(kept[j])),
        }
    };
    let mut splices = Vec::new();
    let (mut next_old, mut next_new) = (0usize, 0usize);
    let ends = same.chain(std::iter::once((old.blocks.len(), slots.len())));
    for (i, j) in ends {
        if i < next_old || j < next_new {
            return None;
        }
        if i > next_old || j > next_new {
            let rows: Vec<BlockRow> = (next_new..j).map(row).collect::<Option<_>>()?;
            if let Some(s) = trimmed(&old, next_old, i, rows) {
                splices.push(s);
            }
        }
        (next_old, next_new) = (i + 1, j + 1);
    }

    // The new paragraphs: kept ones move over from the old state.
    let mut olds: Vec<Option<Block>> = old.blocks.into_iter().map(Some).collect();
    let mut blocks = Vec::with_capacity(slots.len());
    for s in slots {
        blocks.push(match s {
            Slot::Kept(i) => olds.get_mut(i)?.take()?,
            Slot::Read(b) => b,
        });
    }
    let refs = references(blocks.iter().zip(kept.iter().copied()));
    let patch = DerivedPatch {
        base_paragraphs: olds.len() as u32,
        splices,
        references: (refs != old.references).then(|| refs.clone()),
        words: blocks.iter().map(|b| b.words).sum(),
        chars: blocks.iter().map(|b| b.chars).sum(),
    };
    Some((
        State {
            blocks,
            kept,
            references: refs,
        },
        patch,
    ))
}

/// Old rows `from..to` replaced by `rows`, without the rows at either end
/// that came out as they were; `None` when nothing is left.
fn trimmed(old: &State, from: usize, to: usize, mut rows: Vec<BlockRow>) -> Option<Splice> {
    let same = |k: usize, r: &BlockRow| old.blocks[k].has_row(old.kept[k], r);
    let mut start = 0usize;
    while from + start < to && start < rows.len() && same(from + start, &rows[start]) {
        start += 1;
    }
    let mut end = 0usize;
    while from + start + end < to
        && start + end < rows.len()
        && same(to - 1 - end, &rows[rows.len() - 1 - end])
    {
        end += 1;
    }
    rows.truncate(rows.len() - end);
    rows.drain(..start);
    let (at, removed) = (from + start, to - end - (from + start));
    (removed > 0 || !rows.is_empty()).then_some(Splice {
        at: at as u32,
        removed: removed as u32,
        blocks: rows,
    })
}
