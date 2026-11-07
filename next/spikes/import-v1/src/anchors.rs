//! Comment and element-patch anchors. The old client never stored Yjs relative
//! positions: an anchor is a block id plus offsets in that block's DOM
//! `textContent` (UTF-16 code units) plus the quoted text. Importing one means
//! finding the block in the imported lines, checking the quote, relocating it
//! the way the old renderer does when the text moved, and turning the range
//! into a pair of Loro cursors.

use serde::Serialize;
use serde_json::Value;

use crate::prose::{HARD_BREAK, INLINE_OBJECT, Prose};

/// `comment.anchor_json`: every version adds fields; none removes any.
#[derive(Debug, Clone, Default)]
pub struct Anchor {
    /// v1: selected text and ProseMirror positions (positions are not portable).
    pub selected_text: Option<String>,
    /// v2: the block's text at creation.
    pub block_text: Option<String>,
    /// v3: every spanned block's original text.
    pub block_snapshots: usize,
    /// v4: the precise range.
    pub text: Option<TextAnchor>,
    /// Image or PDF material region.
    pub region: bool,
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
        if self.region {
            "region"
        } else if self.text.is_some() {
            "v4"
        } else if self.block_snapshots > 0 {
            "v3"
        } else if self.block_text.is_some() {
            "v2"
        } else if self.selected_text.is_some() {
            "v1"
        } else {
            "none"
        }
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

pub fn parse_anchor(json: &str) -> Anchor {
    let Ok(value) = serde_json::from_str::<Value>(json) else {
        return Anchor::default();
    };
    Anchor {
        selected_text: value
            .get("selectedText")
            .and_then(Value::as_str)
            .map(str::to_string),
        block_text: value
            .get("blockText")
            .and_then(Value::as_str)
            .map(str::to_string),
        block_snapshots: value
            .get("blockSnapshots")
            .and_then(Value::as_array)
            .map_or(0, Vec::len),
        text: value.get("textAnchor").and_then(parse_text_anchor),
        region: value.get("region").is_some(),
    }
}

/// What importing one anchor found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Resolution {
    /// The quote is exactly where the offsets say.
    Exact,
    /// The quote moved inside its block; found nearest the old offset.
    Relocated,
    /// The block is there but the quote is not: the author rewrote the passage.
    /// The anchor falls back to the whole block, as the old card does.
    TextChanged,
    /// The block is gone; the comment keeps its stored snapshot text.
    BlockMissing,
    /// Whole-block anchor and every block is present.
    WholeBlock,
}

/// A resolved range in body chars (the Loro text of D3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Range {
    pub start: usize,
    pub end: usize,
}

/// Map a UTF-16 offset in a block's legacy text to a body char position.
fn body_position(
    prose: &Prose,
    line_starts: &[usize],
    first: usize,
    last: usize,
    utf16: usize,
) -> Option<usize> {
    let mut remaining = utf16;
    for (line, &line_start) in prose.lines[first..=last]
        .iter()
        .zip(&line_starts[first..=last])
    {
        for (char_index, c) in line.text.chars().enumerate() {
            if c == HARD_BREAK || c == INLINE_OBJECT {
                continue;
            }
            if remaining == 0 {
                return Some(line_start + char_index);
            }
            let width = c.len_utf16();
            if remaining < width {
                return None; // inside a surrogate pair
            }
            remaining -= width;
        }
        if remaining == 0 {
            return Some(line_start + line.text.chars().count());
        }
    }
    None
}

fn block_legacy_text(prose: &Prose, first: usize, last: usize) -> String {
    (first..=last)
        .map(|i| prose.lines[i].legacy_text())
        .collect()
}

/// The UTF-16 offset of the occurrence of `needle` nearest `expected`, as the
/// old renderer's `findNearestTextOffset` does.
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

/// Resolve a v4 text anchor against imported prose.
pub fn resolve_text(
    prose: &Prose,
    line_starts: &[usize],
    anchor: &TextAnchor,
) -> (Resolution, Option<Range>) {
    let ranges = prose.block_ranges();
    let (Some(&(s_first, s_last)), Some(&(e_first, e_last))) = (
        ranges.get(&anchor.start_block),
        ranges.get(&anchor.end_block),
    ) else {
        return (Resolution::BlockMissing, None);
    };
    let start = body_position(prose, line_starts, s_first, s_last, anchor.start_offset);
    let end = body_position(prose, line_starts, e_first, e_last, anchor.end_offset);
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
        // A cross-block quote may or may not contain the separator, so compare without whitespace.
        let squash = |s: &str| s.chars().filter(|c| !c.is_whitespace()).collect::<String>();
        if quoted.is_some_and(|q| squash(&q) == squash(&anchor.text)) && start <= end {
            return (Resolution::Exact, Some(Range { start, end }));
        }
    }
    // Relocate inside the start block, like the renderer.
    let text = block_legacy_text(prose, s_first, s_last);
    if let Some(found) = nearest(&text, &anchor.text, anchor.start_offset) {
        let length = anchor.text.encode_utf16().count();
        if let (Some(start), Some(end)) = (
            body_position(prose, line_starts, s_first, s_last, found),
            body_position(prose, line_starts, s_first, s_last, found + length),
        ) {
            return (Resolution::Relocated, Some(Range { start, end }));
        }
    }
    let start = line_starts[s_first];
    let end = line_starts[e_last] + prose.lines[e_last].text.chars().count();
    (Resolution::TextChanged, Some(Range { start, end }))
}

/// Resolve a whole-block anchor (one or more consecutive block ids).
pub fn resolve_blocks(
    prose: &Prose,
    line_starts: &[usize],
    ids: &[String],
) -> (Resolution, Option<Range>) {
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
    let range = Range {
        start: line_starts[first],
        end: line_starts[last] + prose.lines[last].text.chars().count(),
    };
    let resolution = if found.len() == ids.len() {
        Resolution::WholeBlock
    } else {
        Resolution::TextChanged
    };
    (resolution, Some(range))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prose::parse;

    fn starts(prose: &Prose) -> Vec<usize> {
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

    const DOC: &str = r#"{"type":"doc","content":[
      {"type":"paragraph","attrs":{"id":"a"},"content":[{"type":"text","text":"“你怎么会姓赵！"},{"type":"hardBreak"},{"type":"text","text":"——你那里配姓赵！”😀尾"}]},
      {"type":"blockquote","attrs":{"id":"q"},"content":[
        {"type":"paragraph","attrs":{"id":"q1"},"content":[{"type":"text","text":"第一段"}]},
        {"type":"paragraph","attrs":{"id":"q2"},"content":[{"type":"text","text":"第二段"}]}]}
    ]}"#;

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
    fn utf16_offsets_skip_hard_breaks_and_count_surrogates() {
        let prose = parse(DOC).unwrap();
        let line_starts = starts(&prose);
        // Legacy text: “你怎么会姓赵！——你那里配姓赵！”😀尾 ; the break contributes nothing.
        let (resolution, range) =
            resolve_text(&prose, &line_starts, &anchor("a", 10, 15, "你那里配姓"));
        assert_eq!(resolution, Resolution::Exact);
        // Body chars: the hard break occupies one char before “——”.
        assert_eq!(range, Some(Range { start: 11, end: 16 }));
        // After the emoji (two UTF-16 units) comes 尾.
        let (resolution, range) = resolve_text(&prose, &line_starts, &anchor("a", 20, 21, "尾"));
        assert_eq!(resolution, Resolution::Exact);
        assert_eq!(range, Some(Range { start: 20, end: 21 }));
    }

    #[test]
    fn container_blocks_moved_quotes_and_missing_blocks() {
        let prose = parse(DOC).unwrap();
        let line_starts = starts(&prose);
        // A block quote's text is its paragraphs' text joined without separators.
        let (resolution, range) = resolve_text(&prose, &line_starts, &anchor("q", 2, 4, "段第"));
        assert_eq!(resolution, Resolution::Exact);
        // 段 is body char 24; the range runs over the line break to 第 (26), end exclusive.
        assert_eq!(range.map(|r| (r.start, r.end)), Some((24, 27)));
        let (resolution, _) = resolve_text(&prose, &line_starts, &anchor("a", 0, 3, "那里配"));
        assert_eq!(resolution, Resolution::Relocated);
        let (resolution, _) = resolve_text(&prose, &line_starts, &anchor("a", 0, 3, "哪里配"));
        assert_eq!(resolution, Resolution::TextChanged);
        let (resolution, range) = resolve_text(&prose, &line_starts, &anchor("gone", 0, 1, "x"));
        assert_eq!((resolution, range), (Resolution::BlockMissing, None));
        let (resolution, _) = resolve_blocks(&prose, &line_starts, &["q1".into(), "q2".into()]);
        assert_eq!(resolution, Resolution::WholeBlock);
    }

    #[test]
    fn anchor_versions() {
        assert_eq!(
            parse_anchor(r#"{"selectedText":"x","selectionFrom":1,"selectionTo":2}"#).version(),
            "v1"
        );
        assert_eq!(
            parse_anchor(r#"{"selectedText":"x","blockText":"xy"}"#).version(),
            "v2"
        );
        assert_eq!(
            parse_anchor(
                r#"{"blockText":"xy","blockSnapshots":[{"blockId":"a","blockText":"xy"}]}"#
            )
            .version(),
            "v3"
        );
        let v4 = r#"{"textAnchor":{"startBlockId":"a","startOffset":0,"endBlockId":"a","endOffset":1,"text":"x"}}"#;
        assert_eq!(parse_anchor(v4).version(), "v4");
        assert_eq!(
            parse_anchor(r#"{"region":{"v":1,"x":0,"y":0,"w":1,"h":1}}"#).version(),
            "region"
        );
        assert_eq!(
            parse_anchor(r#"{"createdAt":"2026-01-01"}"#).version(),
            "none"
        );
    }
}
