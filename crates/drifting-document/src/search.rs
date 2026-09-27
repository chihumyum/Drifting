//! Read-only literal search over the native prose projection. Relative positions
//! identify a result across owners; its exact source text guards stale clicks.
use super::*;

#[derive(Debug, Clone)]
pub struct NativeSearchMatch {
    pub start_anchor: Vec<u8>,
    pub end_anchor: Vec<u8>,
    pub matched_text: String,
}

#[derive(Debug)]
pub struct NativeSearchHit {
    pub preview: String,
    pub matched: NativeSearchMatch,
}

struct FoldSpan {
    start: usize,
    end: usize,
    utf16_start: u32,
    utf16_end: u32,
}

/// Unicode scalar lowercase, without normalization or full case folding.
/// An expansion (for example İ -> i + combining dot) maps back to the complete
/// original scalar. Returned ranges are non-overlapping original UTF-16 ranges.
pub fn native_search_ranges(text: &str, query: &str, limit: usize) -> Vec<NativeRange> {
    let query: String = query.trim().chars().flat_map(char::to_lowercase).collect();
    if query.is_empty() || limit == 0 {
        return Vec::new();
    }
    let mut folded = String::new();
    let mut spans = Vec::new();
    let mut offset = 0;
    for ch in text.chars() {
        let start = folded.len();
        folded.extend(ch.to_lowercase());
        let end = offset + ch.len_utf16() as u32;
        spans.push(FoldSpan {
            start,
            end: folded.len(),
            utf16_start: offset,
            utf16_end: end,
        });
        offset = end;
    }
    let mut ranges: Vec<NativeRange> = Vec::new();
    for (start, _) in folded.match_indices(&query) {
        let end = start + query.len();
        let first = spans.partition_point(|span| span.end <= start);
        let last = spans.partition_point(|span| span.start < end) - 1;
        let location = spans[first].utf16_start;
        let length = spans[last].utf16_end - location;
        if ranges
            .last()
            .is_some_and(|range| location < range.location + range.length)
        {
            continue;
        }
        ranges.push(NativeRange { location, length });
        if ranges.len() == limit {
            break;
        }
    }
    ranges
}

/// A one-line excerpt around a match: up to 24 characters each side.
pub fn native_search_preview(text: &str, range: &NativeRange) -> String {
    let mut start = text.len();
    let mut end = text.len();
    let mut offset = 0;
    for (byte, ch) in text.char_indices() {
        if offset == range.location {
            start = byte;
        }
        if offset == range.location + range.length {
            end = byte;
            break;
        }
        offset += ch.len_utf16() as u32;
    }
    let prefix: String = text[..start]
        .chars()
        .rev()
        .take(24)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let matched: String = text[start..end].chars().take(80).collect();
    let suffix: String = text[end..].chars().take(24).collect();
    format!(
        "{}{}{}{}{}{}",
        if prefix.len() < start { "…" } else { "" },
        prefix,
        matched,
        if matched.len() < end - start {
            "…"
        } else {
            ""
        },
        suffix,
        if suffix.len() < text.len() - end {
            "…"
        } else {
            ""
        }
    )
}

impl DocumentSession {
    pub fn search_native(&self, query: &str, limit: usize) -> Result<Vec<NativeSearchHit>, String> {
        let view = self.native_projection()?;
        let units: Vec<_> = view.text.encode_utf16().collect();
        let mut hits = Vec::new();
        for block in &view.blocks {
            if hits.len() == limit {
                break;
            }
            if !block.editable {
                continue;
            }
            let Some(id) = &block.id else {
                continue;
            };
            let start = block.range.location as usize;
            let text = String::from_utf16(&units[start..start + block.range.length as usize])
                .map_err(|error| error.to_string())?;
            let block_units: Vec<_> = text.encode_utf16().collect();
            for range in native_search_ranges(&text, query, limit - hits.len()) {
                let start = range.location as usize;
                let end = start + range.length as usize;
                hits.push(NativeSearchHit {
                    preview: native_search_preview(&text, &range),
                    matched: NativeSearchMatch {
                        start_anchor: self.anchor(id, range.location, false)?,
                        end_anchor: self.anchor(id, range.location + range.length, true)?,
                        matched_text: String::from_utf16(&block_units[start..end])
                            .map_err(|error| error.to_string())?,
                    },
                });
            }
        }
        Ok(hits)
    }

    /// Resolve in this live owner, then compare the original scalar sequence.
    /// No fallback to a public block ID, old offset, or equal-looking occurrence.
    pub fn resolve_search_match(
        &self,
        matched: &NativeSearchMatch,
    ) -> Result<Option<NativeRange>, String> {
        let point = |bytes: &[u8]| -> Result<Option<(String, u32)>, String> {
            let Some(value) = self.resolve_anchor(bytes)? else {
                return Ok(None);
            };
            Ok(value["block"]
                .as_str()
                .zip(value["offset"].as_u64())
                .and_then(|(block, offset)| {
                    u32::try_from(offset)
                        .ok()
                        .map(|offset| (block.into(), offset))
                }))
        };
        let Some((start_id, start)) = point(&matched.start_anchor)? else {
            return Ok(None);
        };
        let Some((end_id, end)) = point(&matched.end_anchor)? else {
            return Ok(None);
        };
        if start_id != end_id || start >= end {
            return Ok(None);
        }
        let view = self.native_projection()?;
        let mut blocks = view
            .blocks
            .iter()
            .filter(|block| block.id.as_deref() == Some(&start_id));
        let Some(block) = blocks.next() else {
            return Ok(None);
        };
        if blocks.next().is_some() || !block.editable || end > block.range.length {
            return Ok(None);
        }
        let range = NativeRange {
            location: block.range.location + start,
            length: end - start,
        };
        validate_range(&view.text, range.location, range.length)?;
        let current: Vec<_> = view
            .text
            .encode_utf16()
            .skip(range.location as usize)
            .take(range.length as usize)
            .collect();
        let current = String::from_utf16(&current).map_err(|error| error.to_string())?;
        Ok((current == matched.matched_text).then_some(range))
    }
}
