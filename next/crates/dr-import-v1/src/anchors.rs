//! Comment and element-patch anchors. The 0.1 client never stored Yjs
//! positions: an anchor is a block id plus offsets in that block's DOM
//! `textContent` (UTF-16, hard breaks count nothing) plus the quoted text.
//! Importing one means finding the block in the old lines, checking the
//! quote, relocating it the way the 0.1 renderer does
//! (`lib/comment-highlight.ts`) when the text moved, mapping the range to the
//! new body through the plan, and turning it into a pair of Loro cursors.
//! Ported from the P0-E spike (`next/spikes/import-v1/src/anchors.rs`).

use dr_model::book::{BlockSnapshot, MaterialRegion};
use dr_model::id::BlockId;
use serde::Serialize;
use serde_json::Value;

use crate::prose::plan::Plan;
use crate::prose::pm::{HARD_BREAK, INLINE_OBJECT, Prose};

/// `comment.anchor_json`: every version adds fields, none removes any.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Anchor {
    /// v1: the selected text (its ProseMirror positions are not portable).
    pub selected_text: Option<String>,
    /// v2: the block's whole text at creation.
    pub block_text: Option<String>,
    /// v3: every spanned block's text at creation.
    pub block_snapshots: Vec<BlockSnapshot>,
    /// v4: the precise range.
    pub text: Option<TextAnchor>,
    /// A rectangle on an image or PDF material.
    pub region: Option<MaterialRegion>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextAnchor {
    pub start_block: String,
    pub start_offset: usize,
    pub end_block: String,
    pub end_offset: usize,
    pub text: String,
}

impl Anchor {
    pub fn version(&self) -> &'static str {
        if self.region.is_some() {
            "region"
        } else if self.text.is_some() {
            "v4"
        } else if !self.block_snapshots.is_empty() {
            "v3"
        } else if self.block_text.is_some() {
            "v2"
        } else if self.selected_text.is_some() {
            "v1"
        } else {
            "none"
        }
    }

    /// The selected text as it was (schema v2 `quote`).
    pub fn quote(&self) -> Option<String> {
        self.text
            .as_ref()
            .map(|t| t.text.clone())
            .or_else(|| self.selected_text.clone())
            .filter(|q| !q.is_empty())
    }

    /// Every spanned block as it was (schema v2 `snapshots`): v3's list, or
    /// v2's single block (the 0.1 card's fallback, no block id).
    pub fn snapshots(&self) -> Vec<BlockSnapshot> {
        if !self.block_snapshots.is_empty() {
            return self.block_snapshots.clone();
        }
        self.block_text
            .iter()
            .map(|t| BlockSnapshot {
                block: None,
                text: t.clone(),
            })
            .collect()
    }
}

pub fn parse_text_anchor(value: &Value) -> Option<TextAnchor> {
    Some(TextAnchor {
        start_block: value.get("startBlockId")?.as_str()?.to_string(),
        start_offset: value.get("startOffset")?.as_u64()? as usize,
        end_block: value.get("endBlockId")?.as_str()?.to_string(),
        end_offset: value.get("endOffset")?.as_u64()? as usize,
        text: value.get("text")?.as_str()?.to_string(),
    })
}

/// The 0.1 `parseMaterialRegion`: version 1, each value 0–1, inside the box,
/// page ≥ 1.
fn parse_region(value: &Value) -> Option<MaterialRegion> {
    if value.get("v")?.as_i64()? != 1 {
        return None;
    }
    let f = |k: &str| value.get(k).and_then(Value::as_f64);
    let page = match value.get("page") {
        None => None,
        Some(p) => Some(u32::try_from(p.as_u64()?).ok()?),
    };
    MaterialRegion::new(page, f("x")?, f("y")?, f("w")?, f("h")?)
}

pub fn parse_anchor(json: &str) -> Anchor {
    let Ok(value) = serde_json::from_str::<Value>(json) else {
        return Anchor::default();
    };
    let s = |k: &str| value.get(k).and_then(Value::as_str).map(str::to_string);
    Anchor {
        selected_text: s("selectedText"),
        block_text: s("blockText"),
        block_snapshots: value
            .get("blockSnapshots")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|e| {
                        Some(BlockSnapshot {
                            block: e
                                .get("blockId")
                                .and_then(Value::as_str)
                                .and_then(|b| BlockId::parse(b).ok()),
                            text: e.get("blockText")?.as_str()?.to_string(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default(),
        text: value.get("textAnchor").and_then(parse_text_anchor),
        region: value.get("region").and_then(parse_region),
    }
}

/// What importing one anchor found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Resolution {
    /// The quote is exactly where the offsets say.
    Exact,
    /// The quote moved inside its block; found nearest the old offset.
    Relocated,
    /// The block is there but the quote is not: the passage was rewritten.
    /// The anchor falls back to the whole block, as the 0.1 card does.
    TextChanged,
    /// The block is gone; the comment keeps its stored snapshot text.
    BlockMissing,
    /// A whole-block anchor and every block is there.
    WholeBlock,
    /// Some of a whole-block anchor's blocks are gone.
    SomeBlocksMissing,
    /// The range is empty (an empty block): no cursors, the comment keeps
    /// its block.
    Empty,
}

/// Start of each old line in the old flat coordinates (a separator after
/// each line), as the spike measured them.
pub fn line_starts(prose: &Prose) -> Vec<usize> {
    let mut at = 0;
    prose
        .lines
        .iter()
        .map(|l| {
            let s = at;
            at += l.text.chars().count() + 1;
            s
        })
        .collect()
}

/// Map a UTF-16 offset in a block's legacy text (lines `first..=last`) to
/// an old (line, char).
fn old_position(prose: &Prose, first: usize, last: usize, utf16: usize) -> Option<(usize, usize)> {
    let mut remaining = utf16;
    for line_index in first..=last {
        let line = &prose.lines[line_index];
        for (ch, c) in line.text.chars().enumerate() {
            if c == HARD_BREAK || c == INLINE_OBJECT {
                continue;
            }
            if remaining == 0 {
                return Some((line_index, ch));
            }
            let width = c.len_utf16();
            if remaining < width {
                return None; // inside a surrogate pair
            }
            remaining -= width;
        }
        if remaining == 0 {
            return Some((line_index, line.text.chars().count()));
        }
    }
    None
}

fn block_legacy_text(prose: &Prose, first: usize, last: usize) -> String {
    (first..=last)
        .map(|i| prose.lines[i].legacy_text())
        .collect()
}

/// The UTF-16 offset of the occurrence of `needle` nearest `expected` (the
/// renderer's `findNearestTextOffset`).
fn nearest(haystack: &str, needle: &str, expected: usize) -> Option<usize> {
    if needle.is_empty() {
        return None;
    }
    let mut best: Option<usize> = None;
    for (byte, _) in haystack.match_indices(needle) {
        let utf16 = haystack[..byte].encode_utf16().count();
        if best.is_none_or(|b| utf16.abs_diff(expected) < b.abs_diff(expected)) {
            best = Some(utf16);
        }
    }
    best
}

fn utf16_slice(s: &str, start: usize, end: usize) -> Option<String> {
    let units: Vec<u16> = s.encode_utf16().collect();
    (start <= end && end <= units.len()).then(|| String::from_utf16_lossy(&units[start..end]))
}

/// A range in the new body (Unicode scalars).
pub type BodyRange = std::ops::Range<usize>;

fn to_body(
    plan: &Plan,
    starts: &[usize],
    a: (usize, usize),
    b: (usize, usize),
) -> Option<BodyRange> {
    let s = plan.body_pos(starts, a.0, a.1)?;
    let e = plan.body_pos(starts, b.0, b.1)?;
    (s <= e).then_some(s..e)
}

fn whole(prose: &Prose, first: usize, last: usize) -> ((usize, usize), (usize, usize)) {
    ((first, 0), (last, prose.lines[last].text.chars().count()))
}

/// Resolve a v4 text anchor against the old lines, as a range of the new
/// body.
pub fn resolve_text(
    prose: &Prose,
    plan: &Plan,
    starts: &[usize],
    anchor: &TextAnchor,
) -> (Resolution, Option<BodyRange>) {
    let ranges = prose.block_ranges();
    let (Some(&(s_first, s_last)), Some(&(e_first, e_last))) = (
        ranges.get(&anchor.start_block),
        ranges.get(&anchor.end_block),
    ) else {
        return (Resolution::BlockMissing, None);
    };
    let start = old_position(prose, s_first, s_last, anchor.start_offset);
    let end = old_position(prose, e_first, e_last, anchor.end_offset);
    if let (Some(start), Some(end)) = (start, end) {
        let quoted = if s_first == e_first {
            utf16_slice(
                &block_legacy_text(prose, s_first, s_last),
                anchor.start_offset,
                anchor.end_offset,
            )
        } else {
            let first = block_legacy_text(prose, s_first, s_last);
            let last = block_legacy_text(prose, e_first, e_last);
            let head = utf16_slice(&first, anchor.start_offset, first.encode_utf16().count());
            let tail = utf16_slice(&last, 0, anchor.end_offset);
            head.zip(tail).map(|(h, t)| format!("{h}{t}"))
        };
        // A cross-block quote may or may not contain the separator.
        let squash = |s: &str| s.chars().filter(|c| !c.is_whitespace()).collect::<String>();
        if quoted.is_some_and(|q| squash(&q) == squash(&anchor.text))
            && let Some(r) = to_body(plan, starts, start, end)
        {
            return (Resolution::Exact, Some(r));
        }
    }
    let text = block_legacy_text(prose, s_first, s_last);
    if let Some(found) = nearest(&text, &anchor.text, anchor.start_offset) {
        let length = anchor.text.encode_utf16().count();
        if let (Some(a), Some(b)) = (
            old_position(prose, s_first, s_last, found),
            old_position(prose, s_first, s_last, found + length),
        ) && let Some(r) = to_body(plan, starts, a, b)
        {
            return (Resolution::Relocated, Some(r));
        }
    }
    let (a, _) = whole(prose, s_first, s_last);
    let (_, b) = whole(prose, e_first, e_last.max(s_last));
    (Resolution::TextChanged, to_body(plan, starts, a, b))
}

/// Resolve a whole-block anchor (one or more consecutive block ids).
pub fn resolve_blocks(
    prose: &Prose,
    plan: &Plan,
    starts: &[usize],
    ids: &[String],
) -> (Resolution, Option<BodyRange>) {
    let ranges = prose.block_ranges();
    let found: Vec<(usize, usize)> = ids
        .iter()
        .filter_map(|id| ranges.get(id).copied())
        .collect();
    if found.is_empty() {
        return (Resolution::BlockMissing, None);
    }
    let first = found.iter().map(|r| r.0).min().unwrap_or(0);
    let last = found.iter().map(|r| r.1).max().unwrap_or(0);
    let (a, _) = whole(prose, first, last);
    let (_, b) = whole(prose, last, last);
    let resolution = if found.len() == ids.len() {
        Resolution::WholeBlock
    } else {
        Resolution::SomeBlocksMissing
    };
    (resolution, to_body(plan, starts, a, b))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prose::pm::parse;
    use crate::prose::{Context, doc_blocks, plan};
    use dr_model::ProseProfile;

    const DOC: &str = r#"{"type":"doc","content":[
      {"type":"paragraph","attrs":{"id":"a"},"content":[{"type":"text","text":"“你怎么会姓赵！"},{"type":"hardBreak"},{"type":"text","text":"——你那里配姓赵！”😀尾"},{"type":"mention","attrs":{}},{"type":"text","text":"完"}]},
      {"type":"blockquote","attrs":{"id":"q"},"content":[
        {"type":"paragraph","attrs":{"id":"q1"},"content":[{"type":"text","text":"第一段"}]},
        {"type":"paragraph","attrs":{"id":"q2"},"content":[{"type":"text","text":"第二段"}]}]}
    ]}"#;

    fn setup() -> (Prose, Plan, Vec<usize>) {
        let prose = parse(DOC).unwrap();
        let blocks = doc_blocks(&prose);
        let p = plan(
            &prose,
            &blocks,
            &Context {
                profile: ProseProfile::Prose,
                span: &|_| None,
                todo: &|_| None,
            },
        );
        let starts = p.starts();
        (prose, p, starts)
    }

    fn anchor(block: &str, start: usize, end: usize, text: &str) -> TextAnchor {
        TextAnchor {
            start_block: block.into(),
            start_offset: start,
            end_block: block.into(),
            end_offset: end,
            text: text.into(),
        }
    }

    #[test]
    fn utf16_offsets_skip_hard_breaks_and_dropped_objects() {
        let (prose, p, starts) = setup();
        let (r, range) = resolve_text(&prose, &p, &starts, &anchor("a", 10, 15, "你那里配姓"));
        assert_eq!(r, Resolution::Exact);
        // The hard break is one body character before “——”.
        assert_eq!(range, Some(11..16));
        let body: Vec<char> = p.body_text().chars().collect();
        assert_eq!(body[11..16].iter().collect::<String>(), "你那里配姓");
        // After the emoji (two UTF-16 units) and a dropped inline node.
        let (r, range) = resolve_text(&prose, &p, &starts, &anchor("a", 21, 22, "完"));
        assert_eq!(r, Resolution::Exact);
        let range = range.unwrap();
        assert_eq!(body[range].iter().collect::<String>(), "完");
    }

    #[test]
    fn containers_moved_quotes_and_missing_blocks() {
        let (prose, p, starts) = setup();
        let body: Vec<char> = p.body_text().chars().collect();
        let (r, range) = resolve_text(&prose, &p, &starts, &anchor("q", 2, 4, "段第"));
        assert_eq!(r, Resolution::Exact);
        let range = range.unwrap();
        assert_eq!(body[range].iter().collect::<String>(), "段\n第");
        let (r, _) = resolve_text(&prose, &p, &starts, &anchor("a", 0, 3, "那里配"));
        assert_eq!(r, Resolution::Relocated);
        let (r, range) = resolve_text(&prose, &p, &starts, &anchor("a", 0, 3, "哪里配"));
        assert_eq!(r, Resolution::TextChanged);
        assert_eq!(range.unwrap().start, 0);
        assert_eq!(
            resolve_text(&prose, &p, &starts, &anchor("gone", 0, 1, "x")),
            (Resolution::BlockMissing, None)
        );
        let (r, range) = resolve_blocks(&prose, &p, &starts, &["q1".into(), "q2".into()]);
        assert_eq!(r, Resolution::WholeBlock);
        let range = range.unwrap();
        assert_eq!(body[range].iter().collect::<String>(), "第一段\n第二段");
        let (r, _) = resolve_blocks(&prose, &p, &starts, &["q1".into(), "gone".into()]);
        assert_eq!(r, Resolution::SomeBlocksMissing);
    }

    #[test]
    fn anchor_versions_quotes_snapshots_and_regions() {
        assert_eq!(
            parse_anchor(r#"{"selectedText":"x","selectionFrom":1}"#).version(),
            "v1"
        );
        let v2 = parse_anchor(r#"{"selectedText":"x","blockText":"xy"}"#);
        assert_eq!(v2.version(), "v2");
        assert_eq!(
            v2.snapshots(),
            vec![BlockSnapshot {
                block: None,
                text: "xy".into()
            }]
        );
        let v3 = parse_anchor(
            r#"{"blockText":"xy","blockSnapshots":[{"blockId":"a","blockText":"xy"},{"blockId":null,"blockText":"z"}]}"#,
        );
        assert_eq!(v3.version(), "v3");
        assert_eq!(v3.snapshots().len(), 2);
        let v4 = parse_anchor(
            r#"{"selectedText":"old","textAnchor":{"startBlockId":"a","startOffset":0,"endBlockId":"a","endOffset":1,"text":"x"}}"#,
        );
        assert_eq!(v4.version(), "v4");
        assert_eq!(v4.quote().as_deref(), Some("x"));
        let region = parse_anchor(r#"{"region":{"v":1,"page":2,"x":0.1,"y":0.2,"w":0.3,"h":0.4}}"#);
        assert_eq!(region.version(), "region");
        assert_eq!(region.region.unwrap().page, Some(2));
        assert!(
            parse_anchor(r#"{"region":{"v":1,"x":0.9,"y":0,"w":0.5,"h":0.1}}"#)
                .region
                .is_none()
        );
        assert_eq!(parse_anchor("{}").version(), "none");
        assert_eq!(parse_anchor("not json"), Anchor::default());
    }
}
