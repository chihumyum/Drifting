//! Comment content stays in SQLite. This owner tracks only anchor fields and
//! local prose history; original quotes, snapshots and unknown fields survive.
use super::*;
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentAnchorRecord {
    pub id: String,
    pub anchor_json: String,
    pub target_block_id: Option<String>,
    pub target_block_ids_json: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentAnchorView {
    pub id: String,
    pub quote: String,
    pub status: String,
    pub ranges: Vec<NativeRange>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub(crate) struct RelativeRange {
    start: Vec<u8>,
    end: Vec<u8>,
}

#[derive(Clone, Debug)]
pub(crate) struct TrackedComment {
    record: CommentAnchorRecord,
    pub(crate) epoch: u64,
    relative: Option<RelativeRange>,
    writable: bool,
}

pub(crate) type CommentSet = BTreeMap<String, TrackedComment>;

fn payload(record: &CommentAnchorRecord) -> Option<Value> {
    let parsed: Value = serde_json::from_str(&record.anchor_json).ok()?;
    parsed.is_object().then_some(parsed)
}

fn block_ids(record: &CommentAnchorRecord) -> Vec<String> {
    let ids: Vec<String> = serde_json::from_str(&record.target_block_ids_json).unwrap_or_default();
    if ids.is_empty() {
        record.target_block_id.iter().cloned().collect()
    } else {
        ids
    }
}

fn point(anchor: &Value, side: &str) -> Option<(String, u32)> {
    Some((
        anchor[format!("{side}BlockId")].as_str()?.to_owned(),
        u32::try_from(anchor[format!("{side}Offset")].as_u64()?).ok()?,
    ))
}

fn global(view: &NativeProjection, block: &str, offset: u32) -> Option<u32> {
    let mut found = view
        .blocks
        .iter()
        .filter(|item| item.id.as_deref() == Some(block));
    let item = found.next()?;
    if found.next().is_some() || !item.editable || offset > item.range.length {
        return None;
    }
    Some(item.range.location + offset)
}

fn slice(text: &str, start: u32, end: u32) -> Option<String> {
    let units: Vec<_> = text.encode_utf16().collect();
    if start > end {
        return None;
    }
    String::from_utf16(units.get(start as usize..end as usize)?).ok()
}

fn matches_quote(actual: &str, expected: &str) -> bool {
    let normalize = |text: &str| text.split_whitespace().collect::<Vec<_>>().join(" ");
    !expected.trim().is_empty() && normalize(actual) == normalize(expected)
}

fn nearest(text: &str, needle: &str, expected: u32) -> Option<u32> {
    if needle.is_empty() {
        return None;
    }
    text.match_indices(needle)
        .map(|(at, _)| text[..at].encode_utf16().count() as u32)
        .min_by_key(|at| at.abs_diff(expected))
}

impl DocumentSession {
    /// A refreshed external anchor invalidates only its own old history. A
    /// body/status change is outside this record and never overwritten here.
    pub fn set_comment_anchors(&mut self, records: Vec<CommentAnchorRecord>) -> Result<(), String> {
        let view = self.native_projection()?;
        let mut next = CommentSet::new();
        for record in records {
            if record.id.is_empty() || next.contains_key(&record.id) {
                return Err("Duplicate or empty comment identity".into());
            }
            let tracked = if let Some(old) = self
                .comments
                .get(&record.id)
                .filter(|old| old.record == record)
            {
                old.clone()
            } else {
                self.comment_epoch += 1;
                let parsed = payload(&record);
                let extension = parsed
                    .as_ref()
                    .and_then(|value| value.get("nativeAnchorV1"));
                let relative = extension
                    .and_then(|value| serde_json::from_value::<RelativeRange>(value.clone()).ok())
                    .filter(|range| {
                        StickyIndex::decode_v1(&range.start).is_ok()
                            && StickyIndex::decode_v1(&range.end).is_ok()
                    });
                let writable = parsed.is_some() && (extension.is_none() || relative.is_some());
                let relative = relative.or_else(|| self.seed_comment_range(&record, &view));
                TrackedComment {
                    record,
                    epoch: self.comment_epoch,
                    relative,
                    writable,
                }
            };
            next.insert(tracked.record.id.clone(), tracked);
        }
        self.comments = next;
        self.refresh_comments(None);
        Ok(())
    }

    pub fn comment_anchor_records(&self) -> Vec<CommentAnchorRecord> {
        self.comments
            .values()
            .map(|item| item.record.clone())
            .collect()
    }

    fn seed_comment_range(
        &self,
        record: &CommentAnchorRecord,
        view: &NativeProjection,
    ) -> Option<RelativeRange> {
        let parsed = payload(record)?;
        let anchor = parsed.get("textAnchor")?;
        let (start_block, mut start_offset) = point(anchor, "start")?;
        let (end_block, mut end_offset) = point(anchor, "end")?;
        let expected = anchor["text"].as_str()?;
        let current_matches = global(view, &start_block, start_offset)
            .zip(global(view, &end_block, end_offset))
            .and_then(|(start, end)| slice(&view.text, start, end))
            .is_some_and(|text| matches_quote(&text, expected));
        if !current_matches {
            // Preserve the existing nearest-quote rule for stale single-block
            // offsets. Never attach a stale range to unrelated current prose.
            let first = view
                .blocks
                .iter()
                .find(|b| b.id.as_deref() == Some(&start_block))?;
            let first_text = slice(
                &view.text,
                first.range.location,
                first.range.location + first.range.length,
            )?;
            if start_block == end_block {
                start_offset = nearest(&first_text, expected, start_offset)?;
                end_offset = start_offset + expected.encode_utf16().count() as u32;
            } else {
                let snapshots = parsed["blockSnapshots"].as_array()?;
                let start_snapshot = snapshots.iter().find(|s| s["blockId"] == start_block)?
                    ["blockText"]
                    .as_str()?;
                let end_snapshot =
                    snapshots.iter().find(|s| s["blockId"] == end_block)?["blockText"].as_str()?;
                let start_needle = slice(
                    start_snapshot,
                    start_offset,
                    start_snapshot.encode_utf16().count() as u32,
                )?;
                let end_needle = slice(end_snapshot, 0, end_offset)?;
                let last = view
                    .blocks
                    .iter()
                    .find(|b| b.id.as_deref() == Some(&end_block))?;
                let last_text = slice(
                    &view.text,
                    last.range.location,
                    last.range.location + last.range.length,
                )?;
                start_offset = nearest(&first_text, &start_needle, start_offset)?;
                end_offset =
                    nearest(&last_text, &end_needle, 0)? + end_needle.encode_utf16().count() as u32;
            }
        }
        let start = global(view, &start_block, start_offset)?;
        let end = global(view, &end_block, end_offset)?;
        if start >= end {
            return None;
        }
        if !matches_quote(&slice(&view.text, start, end)?, expected) {
            return None;
        }
        Some(RelativeRange {
            start: self.anchor(&start_block, start_offset, false).ok()?,
            end: self.anchor(&end_block, end_offset, true).ok()?,
        })
    }

    fn resolved_comment(&self, relative: &RelativeRange) -> Option<Value> {
        let start = self.resolve_anchor(&relative.start).ok()??;
        let end = self.resolve_anchor(&relative.end).ok()??;
        Some(
            json!({"startBlockId": start["block"], "startOffset": start["offset"],
            "endBlockId": end["block"], "endOffset": end["offset"]}),
        )
    }

    pub(crate) fn refresh_comments(&mut self, mapping: Option<&NativeEditMap>) {
        if self.comments.is_empty() {
            return;
        }
        let mut comments = std::mem::take(&mut self.comments);
        let Ok(view) = self.native_projection() else {
            self.comments = comments;
            return;
        };
        for tracked in comments.values_mut() {
            if !tracked.writable {
                continue;
            }
            let Some(mut parsed) = payload(&tracked.record) else {
                continue;
            };
            if let Some(map) = mapping {
                if let Some(anchor) = parsed
                    .get("textAnchor")
                    .filter(|_| tracked.relative.is_some())
                    .and_then(|anchor| map.map_comment_anchor(anchor))
                {
                    if let (Some((block, offset)), Some((end_block, end_offset))) = (
                        point(&anchor["textAnchor"], "start"),
                        point(&anchor["textAnchor"], "end"),
                    ) {
                        if let (Ok(start), Ok(end)) = (
                            self.anchor(&block, offset, false),
                            self.anchor(&end_block, end_offset, true),
                        ) {
                            tracked.relative = Some(RelativeRange { start, end });
                        }
                    }
                } else if parsed.get("textAnchor").is_none() {
                    let ids = map.map_block_targets(&block_ids(&tracked.record));
                    if !ids.is_empty() {
                        tracked.record.target_block_id = ids.first().cloned();
                        tracked.record.target_block_ids_json = json!(ids).to_string();
                    }
                }
            }
            if tracked.relative.is_none() {
                tracked.relative = self.seed_comment_range(&tracked.record, &view);
            }
            // Redone links belong to the local undo manager and are not encoded
            // into Yjs updates. Persist positions on their current live items,
            // otherwise a redo looks correct until the checkpoint is reopened.
            if let Some(resolved) = tracked
                .relative
                .as_ref()
                .and_then(|r| self.resolved_comment(r))
            {
                if let (Some((block, offset)), Some((end_block, end_offset))) =
                    (point(&resolved, "start"), point(&resolved, "end"))
                {
                    if let (Ok(start), Ok(end)) = (
                        self.anchor(&block, offset, false),
                        self.anchor(&end_block, end_offset, true),
                    ) {
                        tracked.relative = Some(RelativeRange { start, end });
                    }
                }
            }
            if let Some(relative) = &tracked.relative {
                // Keep even currently unresolved bytes: undo or later causal
                // replay may restore the original item. Never flatten to JSON.
                let extension = parsed
                    .as_object_mut()
                    .unwrap()
                    .entry("nativeAnchorV1")
                    .or_insert_with(|| json!({}));
                if let Some(extension) = extension.as_object_mut() {
                    extension.insert("start".into(), json!(relative.start));
                    extension.insert("end".into(), json!(relative.end));
                }
                if let Some(resolved) = self.resolved_comment(relative) {
                    let anchor = parsed.get_mut("textAnchor").and_then(Value::as_object_mut);
                    if let Some(anchor) = anchor {
                        for (key, value) in resolved.as_object().unwrap() {
                            anchor.insert(key.clone(), value.clone());
                        }
                        if let (Some((block, offset)), Some((end_block, end_offset))) =
                            (point(&resolved, "start"), point(&resolved, "end"))
                        {
                            if let (Some(start), Some(end)) = (
                                global(&view, &block, offset),
                                global(&view, &end_block, end_offset),
                            ) {
                                if start <= end {
                                    let ids: Vec<_> = view
                                        .blocks
                                        .iter()
                                        .filter(|item| {
                                            item.range.location <= end
                                                && item.range.location + item.range.length >= start
                                        })
                                        .filter_map(|item| item.id.clone())
                                        .collect();
                                    tracked.record.target_block_id = ids.first().cloned();
                                    tracked.record.target_block_ids_json = json!(ids).to_string();
                                }
                            }
                        }
                    }
                }
                tracked.record.anchor_json = parsed.to_string();
            }
        }
        self.comments = comments;
    }

    pub(crate) fn comment_views(&self, view: &NativeProjection) -> Vec<CommentAnchorView> {
        self.comments
            .values()
            .map(|tracked| {
                let parsed = payload(&tracked.record);
                let quote = parsed
                    .as_ref()
                    .and_then(|p| p.get("textAnchor"))
                    .and_then(|a| a.get("text"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                let mut result = CommentAnchorView {
                    id: tracked.record.id.clone(),
                    quote,
                    status: "unresolved".into(),
                    ranges: Vec::new(),
                };
                if let Some(resolved) = tracked
                    .relative
                    .as_ref()
                    .and_then(|r| self.resolved_comment(r))
                {
                    if let (Some((block, offset)), Some((end_block, end_offset))) =
                        (point(&resolved, "start"), point(&resolved, "end"))
                    {
                        if let (Some(start), Some(end)) = (
                            global(view, &block, offset),
                            global(view, &end_block, end_offset),
                        ) {
                            if start < end {
                                if let Some(text) = slice(&view.text, start, end) {
                                    result.status = if matches_quote(&text, &result.quote) {
                                        "anchored"
                                    } else {
                                        "changed"
                                    }
                                    .into();
                                    result.ranges.push(NativeRange {
                                        location: start,
                                        length: end - start,
                                    });
                                }
                            } else {
                                result.status = "collapsed".into();
                            }
                        }
                    }
                } else if parsed
                    .as_ref()
                    .is_some_and(|p| p.get("textAnchor").is_none())
                {
                    for id in block_ids(&tracked.record) {
                        if let Some(block) = view
                            .blocks
                            .iter()
                            .find(|b| b.id.as_deref() == Some(&id) && b.editable)
                        {
                            result.ranges.push(block.range.clone());
                        }
                    }
                    if !result.ranges.is_empty() {
                        result.status = "whole-block".into();
                    }
                }
                result
            })
            .collect()
    }
}
