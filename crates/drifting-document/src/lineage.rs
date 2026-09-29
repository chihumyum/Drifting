//! In-memory identity tapes for text reconstructed by a structural command.
//! One span per CRDT string item, not one allocation/lookup per UTF-16 unit.
//! Nothing here is serialized into prose, SQLite, or the public update format.
use super::*;
use crate::selections::{Point, TrackedSelection};
use yrs::ID;

#[derive(Clone)]
struct Span {
    id: ID,
    offset: u32,
    length: u32,
}

#[derive(Clone)]
struct Block {
    id: String,
    length: u32,
    start: StickyIndex,
    end: StickyIndex,
    spans: Vec<Span>,
}

#[derive(Clone)]
pub(crate) struct Layout(Vec<Block>);

impl Layout {
    pub(crate) fn block_ids(&self) -> Vec<String> {
        self.0.iter().map(|block| block.id.clone()).collect()
    }

    /// Whether any text item here was created by another client and is not
    /// among `earlier`'s items (text another writer added since `earlier`).
    pub(crate) fn has_new_foreign_items(&self, earlier: &Self, local: yrs::ClientID) -> bool {
        let known: Vec<(yrs::ClientID, u32, u32)> = earlier
            .0
            .iter()
            .flat_map(|block| &block.spans)
            .map(|span| (span.id.client, span.id.clock, span.id.clock + span.length))
            .collect();
        self.0.iter().flat_map(|block| &block.spans).any(|span| {
            if span.id.client == local {
                return false;
            }
            // Every unit of the span must lie in a known item run.
            (span.id.clock..span.id.clock + span.length).any(|clock| {
                !known.iter().any(|(client, start, end)| {
                    *client == span.id.client && *start <= clock && clock < *end
                })
            })
        })
    }

    /// Item splitting is an internal storage detail. Compare continuous clocks,
    /// text-type identities and lengths rather than the current run boundaries.
    pub(crate) fn same_items(&self, other: &Self) -> bool {
        let tape = |block: &Block| {
            let mut result: Vec<(ID, u32)> = Vec::new();
            for span in &block.spans {
                if let Some((id, length)) = result.last_mut() {
                    if id.client == span.id.client && id.clock + *length == span.id.clock {
                        *length += span.length;
                        continue;
                    }
                }
                result.push((span.id, span.length));
            }
            result
        };
        self.0.len() == other.0.len()
            && self.0.iter().zip(&other.0).all(|(left, right)| {
                left.id == right.id
                    && left.length == right.length
                    && left.start.encode_v1() == right.start.encode_v1()
                    && left.end.encode_v1() == right.end.encode_v1()
                    && tape(left) == tape(right)
            })
    }
}

#[derive(Clone)]
pub(crate) struct Lineage {
    pub before: Layout,
    pub after: Layout,
    pub forward: NativeEditMap,
    pub relocation: Option<crate::relocation_history::HistoryHandle>,
    /// The edit rebuilt whole leaves under their public IDs (heading, quote
    /// or list changes); undoing it restores the originals beside them.
    pub rebuilt: bool,
}

impl Span {
    fn position(&self, offset: u32, assoc: Assoc) -> StickyIndex {
        StickyIndex::from_id(ID::new(self.id.client, self.id.clock + offset), assoc)
    }
}

impl Block {
    fn anchor(&self, offset: u32, before: bool) -> Option<Vec<u8>> {
        if before && offset == 0 {
            return Some(self.start.encode_v1());
        }
        if !before && offset == self.length {
            return Some(self.end.encode_v1());
        }
        let character = offset.checked_sub(u32::from(before))?;
        let span = self
            .spans
            .iter()
            .find(|span| span.offset <= character && character < span.offset + span.length)?;
        Some(
            span.position(
                character - span.offset,
                if before { Assoc::Before } else { Assoc::After },
            )
            .encode_v1(),
        )
    }

    // Find the original character referenced by a live position. Undo may have
    // redone it under another ID, and remote input may split/shift the span.
    // Binary search resolves original item clocks through Yrs' redone chain;
    // equal positions from deleted characters are skipped using both affinities.
    fn original_offset<T: ReadTxn>(&self, txn: &T, point: &StickyIndex) -> Option<u32> {
        let at = point.get_offset(txn)?;
        if self.start.get_offset(txn)?.branch != at.branch {
            return None;
        }
        if point.is_nested() {
            let before = point.assoc == Assoc::Before;
            if self.length == 0 {
                return (at.branch.content_len() == 0).then_some(0);
            }
            let span = if before {
                self.spans.first()?
            } else {
                self.spans.last()?
            };
            let character = if before { 0 } else { span.length - 1 };
            let left = span.position(character, Assoc::After).get_offset(txn)?;
            let right = span.position(character, Assoc::Before).get_offset(txn)?;
            // A branch endpoint beyond remote text must remain with that text
            // if undo protects its parent. It is not the old copy's boundary.
            let boundary = if before { left.index } else { right.index };
            return (right.index == left.index + 1 && boundary == at.index).then_some(if before {
                0
            } else {
                self.length
            });
        }
        for span in &self.spans {
            let mut low = 0;
            let mut high = span.length;
            while low < high {
                let mid = low + (high - low) / 2;
                let found = span.position(mid, point.assoc).get_offset(txn)?;
                let advance = if point.assoc == Assoc::After {
                    found.index <= at.index
                } else {
                    found.index < at.index
                };
                if advance {
                    low = mid + 1;
                } else {
                    high = mid;
                }
            }
            let candidate = if point.assoc == Assoc::After {
                low.checked_sub(1)
            } else {
                Some(low)
            };
            let Some(candidate) = candidate.filter(|at| *at < span.length) else {
                continue;
            };
            let left = span.position(candidate, Assoc::After).get_offset(txn)?;
            let right = span.position(candidate, Assoc::Before).get_offset(txn)?;
            // Deleted text has no width. A newer remote character has no entry
            // in this tape and keeps its own anchor instead of borrowing one.
            let index = if point.assoc == Assoc::Before {
                right.index
            } else {
                left.index
            };
            if right.index == left.index + 1 && index == at.index {
                return Some(span.offset + candidate + u32::from(point.assoc == Assoc::Before));
            }
        }
        None
    }
}

impl DocumentSession {
    pub(crate) fn capture_lineage(&self, blocks: &[NativeBlock]) -> Result<Layout, String> {
        let mut result = Vec::new();
        let mut txn = self.doc.transact_mut_with("native-history-index");
        let current = txn.snapshot();
        let empty = yrs::Snapshot::default();
        for block in blocks {
            let id = block.id.as_deref().ok_or("Missing structural identity")?;
            let element = self.editable_block(&txn, id)?;
            let (start, end, spans) = if let Some(XmlOut::Text(text)) = element.get(&txn, 0) {
                let mut offset = 0;
                let mut spans = Vec::new();
                // Comparing the current snapshot with an empty snapshot exposes
                // every visible item ID, even adjacent equally formatted items.
                for run in
                    text.diff_range(&mut txn, Some(&current), Some(&empty), YChange::identity)
                {
                    let Out::Any(Any::String(value)) = run.insert else {
                        return Err("Non-text lineage item".into());
                    };
                    let length = value.encode_utf16().count() as u32;
                    let change = run.ychange.ok_or("Missing lineage item identity")?;
                    spans.push(Span {
                        id: change.id,
                        offset,
                        length,
                    });
                    offset += length;
                }
                if offset != block.range.length {
                    return Err("Lineage text length mismatch".into());
                }
                (
                    StickyIndex::from_type(&txn, &text, Assoc::Before),
                    StickyIndex::from_type(&txn, &text, Assoc::After),
                    spans,
                )
            } else {
                (
                    StickyIndex::from_type(&txn, &element, Assoc::Before),
                    StickyIndex::from_type(&txn, &element, Assoc::After),
                    Vec::new(),
                )
            };
            result.push(Block {
                id: id.into(),
                length: block.range.length,
                start,
                end,
                spans,
            });
        }
        Ok(Layout(result))
    }

    pub(crate) fn map_selection_lineage(
        &self,
        selection: &TrackedSelection,
        lineage: &Lineage,
        redo: bool,
    ) -> TrackedSelection {
        let (source, target, map) = if redo {
            (&lineage.before, &lineage.after, lineage.forward.clone())
        } else {
            (&lineage.after, &lineage.before, lineage.forward.reversed())
        };
        let txn = self.doc.transact();
        let mapped = |point: &Point, before: bool| -> Option<Point> {
            let sticky = StickyIndex::decode_v1(&point.bytes).ok()?;
            let (block, offset) = source.0.iter().find_map(|block| {
                block
                    .original_offset(&txn, &sticky)
                    .map(|offset| (block, offset))
            })?;
            let moved = map.map_point(&block.id, offset, before)?;
            let destination = target.0.iter().find(|b| b.id == moved.block)?;
            Some(Point {
                bytes: destination.anchor(moved.offset, before)?,
                block: moved.block,
                offset: moved.offset,
            })
        };
        let mut next = selection.clone();
        if let Some(point) = mapped(&selection.start, false) {
            next.start = point;
        }
        if let Some(point) = mapped(&selection.end, !selection.collapsed) {
            next.end = point;
        }
        next
    }
}
