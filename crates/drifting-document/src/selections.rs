//! Ephemeral per-view positions. They never enter SQLite or the Yjs document.
use super::*;
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeSelectionRequest {
    pub view_id: String,
    pub epoch: u64,
    pub revision: u64,
    pub range: NativeRange,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSelectionView {
    pub view_id: String,
    pub epoch: u64,
    pub range: Option<NativeRange>,
}

#[derive(Clone, Debug)]
pub(crate) struct Point {
    pub(crate) bytes: Vec<u8>,
    pub(crate) block: String,
    pub(crate) offset: u32,
}

#[derive(Clone, Debug)]
pub(crate) struct TrackedSelection {
    pub(crate) epoch: u64,
    pub(crate) start: Point,
    pub(crate) end: Point,
    pub(crate) collapsed: bool,
}
pub(crate) type SelectionSet = BTreeMap<String, TrackedSelection>;

fn global(view: &NativeProjection, block: &str, offset: u32) -> Option<u32> {
    let mut found = view
        .blocks
        .iter()
        .filter(|b| b.id.as_deref() == Some(block));
    let item = found.next()?;
    if found.next().is_some() || !item.editable || offset > item.range.length {
        return None;
    }
    Some(item.range.location + offset)
}

impl DocumentSession {
    pub fn set_selection(&mut self, request: NativeSelectionRequest) -> Result<(), String> {
        if request.view_id.is_empty() || request.epoch == 0 {
            return Err("A view selection requires an identity and nonzero epoch".into());
        }
        if request.revision != self.revision {
            return Err("Selection projection is stale".into());
        }
        if let Some(previous) = self.selections.get(&request.view_id) {
            if request.epoch < previous.epoch {
                return Err("Selection epoch is stale".into());
            }
            // Retrying a capture cannot replace positions already moved by the
            // document owner. Only a newer user-selection epoch can do that.
            if request.epoch == previous.epoch {
                return Ok(());
            }
        }
        let view = self.native_projection()?;
        validate_range(&view.text, request.range.location, request.range.length)?;
        let point = |at: u32, before: bool| -> Result<Point, String> {
            let block = view
                .blocks
                .iter()
                .find(|b| b.range.location <= at && at <= b.range.location + b.range.length)
                .filter(|b| b.editable)
                .ok_or("Selection endpoint is not in editable text")?;
            let id = block
                .id
                .as_deref()
                .ok_or("Selection block has no identity")?;
            let offset = at - block.range.location;
            Ok(Point {
                bytes: self.anchor(id, offset, before)?,
                block: id.into(),
                offset,
            })
        };
        let collapsed = request.range.length == 0;
        let start = point(request.range.location, false)?;
        let end = point(request.range.location + request.range.length, !collapsed)?;
        self.selections.insert(
            request.view_id,
            TrackedSelection {
                epoch: request.epoch,
                start,
                end,
                collapsed,
            },
        );
        Ok(())
    }

    pub fn drop_selection(&mut self, view_id: &str) {
        self.selections.remove(view_id);
    }

    fn resolve_selection_point(&self, point: &Point) -> Option<(String, u32)> {
        let resolved = self.resolve_anchor(&point.bytes).ok()??;
        Some((
            resolved["block"].as_str()?.to_owned(),
            u32::try_from(resolved["offset"].as_u64()?).ok()?,
        ))
    }

    pub(crate) fn selection_views(&self, view: &NativeProjection) -> Vec<NativeSelectionView> {
        self.selections
            .iter()
            .map(|(id, selection)| {
                let range = self
                    .resolve_selection_point(&selection.start)
                    .zip(self.resolve_selection_point(&selection.end))
                    .and_then(|((start_block, start_offset), (end_block, end_offset))| {
                        let start = global(view, &start_block, start_offset)?;
                        let end = global(view, &end_block, end_offset)?;
                        Some(NativeRange {
                            location: start,
                            length: end.saturating_sub(start),
                        })
                    });
                NativeSelectionView {
                    view_id: id.clone(),
                    epoch: selection.epoch,
                    range,
                }
            })
            .collect()
    }

    pub(crate) fn refresh_selections(&mut self, mapping: Option<&NativeEditMap>) {
        let mut selections = std::mem::take(&mut self.selections);
        let view = self.native_projection().ok();
        for selection in selections.values_mut() {
            for (point, before) in [
                (&mut selection.start, false),
                (&mut selection.end, !selection.collapsed),
            ] {
                let moved = mapping
                    .and_then(|map| map.map_point(&point.block, point.offset, before))
                    .map(|position| (position.block, position.offset))
                    .or_else(|| self.resolve_selection_point(point));
                if let Some((block, offset)) = moved {
                    // Persist the live item identity in memory, not a redone
                    // indirection. History retains the earlier anchors too.
                    if let Ok(bytes) = self.anchor(&block, offset, before) {
                        *point = Point {
                            bytes,
                            block,
                            offset,
                        };
                    }
                }
            }
            if let Some(view) = &view {
                if let Some((start, end)) = self
                    .resolve_selection_point(&selection.start)
                    .and_then(|(block, offset)| global(view, &block, offset))
                    .zip(
                        self.resolve_selection_point(&selection.end)
                            .and_then(|(block, offset)| global(view, &block, offset)),
                    )
                {
                    if end <= start {
                        selection.end = selection.start.clone();
                        selection.collapsed = true;
                    }
                }
            }
        }
        self.selections = selections;
    }
}
