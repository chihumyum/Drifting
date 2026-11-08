//! The Agent's editable view of `prose.read`, without another prose store.
//!
//! The current F3 query returns text, block ids and H1/H2/H3 only. Markers
//! preserve that identity and supplied comment associations; they are never
//! written into prose. Inline formatting, cursor-based comment locations and
//! embed contents are not available in that query. This module does not infer
//! them or reconstruct Loro from its text projection.
//!
//! For now an edit can change the text of exactly one existing, nonempty
//! paragraph through `prose.replace`. Structure, heading levels, formatting
//! and embeds require a richer F3 query and registered structural command.
//! The caller must apply the document-version guard using `Projection::version`
//! before executing the returned input through F3; this module never writes.

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{Error, Result};

/// A supplied association, from comments already filtered to this document.
/// `None` preserves a document-level or unresolved cursor anchor without
/// pretending that `prose.read` can resolve it to a paragraph.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommentAnchor {
    pub id: String,
    pub block_id: Option<String>,
}

/// Associations from the output array of the registered `comment.list`.
/// Compare both target kind and id: unrelated entities may share an id.
/// Floating, unlocated and image/PDF-region comments are not prose anchors.
/// A cursor anchor without `target_block` remains at document level; only
/// F3/the editor can resolve its Loro cursors, so no text-match guess is made.
pub fn comment_anchors(doc: &str, list: &Value) -> Vec<CommentAnchor> {
    let Some(doc) = dr_model::DocId::parse(doc)
        .ok()
        .filter(|doc| doc.profile().is_some())
    else {
        return Vec::new();
    };
    let Some(comments) = list.as_array() else {
        return Vec::new();
    };
    comments
        .iter()
        .filter_map(|comment| {
            if comment["target"]["kind"].as_str() != Some(doc.kind().prefix())
                || comment["target"]["id"].as_str() != Some(doc.entity_id())
                || comment["unlocated"] != false
                || comment
                    .get("region")
                    .is_some_and(|region| !region.is_null())
            {
                return None;
            }
            let id = comment["id"].as_str().filter(|id| !id.is_empty())?;
            let block_id = match comment.get("target_block")? {
                Value::Null => None,
                Value::String(id) if !id.is_empty() => Some(id.clone()),
                _ => return None,
            };
            Some(CommentAnchor {
                id: id.to_owned(),
                block_id,
            })
        })
        .collect()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct BlockAnchor {
    pub index: usize,
    pub block_id: Option<String>,
    /// 0 for a paragraph, 1–3 for H1/H2/H3.
    pub heading: u8,
    /// The content line in `Projection::text`, one-based.
    pub line: usize,
    pub comments: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Projection {
    pub doc: String,
    pub version: String,
    pub text: String,
    /// Total paragraphs in the document, including ones outside this page.
    pub total: usize,
    pub blocks: Vec<BlockAnchor>,
    pub comments: Vec<CommentAnchor>,
    #[serde(skip)]
    paragraphs: Vec<Paragraph>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Replacement {
    pub doc: String,
    pub find: String,
    pub replace: String,
    pub block_id: String,
}

impl Replacement {
    /// Exactly the registered `prose.replace` input. Revision guarding stays
    /// in the facade, rather than inventing another F3 input field.
    pub fn input(&self) -> Value {
        json!({"doc":self.doc,"find":self.find,"replace":self.replace,"block_id":self.block_id})
    }
}

#[derive(Clone, Debug, Deserialize)]
struct Paragraph {
    index: usize,
    block_id: Option<String>,
    heading: u8,
    text: String,
}

#[derive(Deserialize)]
struct Read {
    paragraphs: Vec<Paragraph>,
    total: usize,
    version: String,
}

/// Render a complete `prose.read` result, or one contiguous page of it.
/// Text is escaped, so Markdown punctuation in the manuscript remains text.
/// Comments and block markers are immutable projection metadata.
pub fn project(
    doc: impl Into<String>,
    read: &Value,
    comments: &[CommentAnchor],
) -> Result<Projection> {
    let doc = doc.into();
    if doc.trim().is_empty() {
        return Err(Error::Invalid("the prose document is missing".into()));
    }
    let read: Read = serde_json::from_value(read.clone())
        .map_err(|_| Error::Invalid("invalid prose.read result".into()))?;
    let mut ids = HashSet::new();
    let mut previous = None;
    for paragraph in &read.paragraphs {
        if paragraph.heading > 3
            || paragraph.index >= read.total
            || previous.is_some_and(|index| paragraph.index != index + 1)
            || paragraph.text.contains(['\n', '\r'])
        {
            return Err(Error::Invalid("invalid prose.read paragraph".into()));
        }
        if let Some(id) = &paragraph.block_id
            && (id.is_empty() || !ids.insert(id.clone()))
        {
            return Err(Error::Invalid("invalid or duplicate prose block id".into()));
        }
        previous = Some(paragraph.index);
    }
    let mut comments = comments.to_vec();
    comments.sort_by(|a, b| (&a.block_id, &a.id).cmp(&(&b.block_id, &b.id)));
    let mut comment_ids = HashSet::new();
    if comments
        .iter()
        .any(|comment| comment.id.is_empty() || !comment_ids.insert(comment.id.clone()))
    {
        return Err(Error::Invalid("invalid or duplicate comment id".into()));
    }
    let mut lines = Vec::new();
    let mut blocks = Vec::new();
    for paragraph in &read.paragraphs {
        lines.push(marker(
            "block",
            &json!({"index":paragraph.index,"id":paragraph.block_id}),
        ));
        let line = lines.len() + 1;
        lines.push(format!(
            "{}{}",
            heading_prefix(paragraph.heading),
            escape(&paragraph.text)
        ));
        let attached: Vec<_> = comments
            .iter()
            .filter(|comment| {
                paragraph.block_id.is_some() && comment.block_id == paragraph.block_id
            })
            .collect();
        for comment in &attached {
            lines.push(marker(
                "comment",
                &json!({"id":comment.id,"block_id":comment.block_id}),
            ));
        }
        blocks.push(BlockAnchor {
            index: paragraph.index,
            block_id: paragraph.block_id.clone(),
            heading: paragraph.heading,
            line,
            comments: attached.iter().map(|comment| comment.id.clone()).collect(),
        });
        lines.push(String::new());
    }
    for comment in &comments {
        if comment.block_id.as_ref().is_none_or(|id| !ids.contains(id)) {
            lines.push(marker(
                "comment",
                &json!({"id":comment.id,"block_id":comment.block_id}),
            ));
        }
    }
    Ok(Projection {
        doc,
        version: read.version,
        text: lines.join("\n"),
        total: read.total,
        blocks,
        comments,
        paragraphs: read.paragraphs,
    })
}

/// Plan one text replacement. An exact round trip performs no parsing and
/// returns no command, leaving all Loro bytes and invisible marks untouched.
pub fn plan(projection: &Projection, edited: &str) -> Result<Option<Replacement>> {
    if edited == projection.text {
        return Ok(None);
    }
    let original: Vec<_> = projection.text.split('\n').collect();
    let edited: Vec<_> = edited.split('\n').collect();
    if edited.len() != original.len() {
        return Err(unsupported("adding, deleting or splitting paragraphs"));
    }
    let content_lines: BTreeMap<_, _> = projection
        .blocks
        .iter()
        .enumerate()
        .map(|(index, block)| (block.line - 1, index))
        .collect();
    let mut changed = None;
    for (line, (before, after)) in original.iter().zip(&edited).enumerate() {
        if before == after {
            continue;
        }
        let Some(&paragraph) = content_lines.get(&line) else {
            return Err(unsupported("changing block or comment anchors"));
        };
        if changed.is_some() {
            return Err(unsupported("editing more than one paragraph"));
        }
        changed = Some((paragraph, *after));
    }
    let Some((index, rendered)) = changed else {
        return Ok(None);
    };
    let paragraph = &projection.paragraphs[index];
    let prefix = heading_prefix(paragraph.heading);
    let body = rendered
        .strip_prefix(&prefix)
        .ok_or_else(|| unsupported("changing H1/H2/H3 levels"))?;
    let desired = unescape(body)?;
    if desired == paragraph.text {
        return Ok(None);
    }
    if paragraph.text.contains('\u{FFFC}') || desired.contains('\u{FFFC}') {
        return Err(unsupported("editing a paragraph containing an embed"));
    }
    let block_id = paragraph
        .block_id
        .clone()
        .ok_or_else(|| unsupported("editing a paragraph without a stable block id"))?;
    let (find, replace) = minimal_replacement(&paragraph.text, &desired)?;
    Ok(Some(Replacement {
        doc: projection.doc.clone(),
        find,
        replace,
        block_id,
    }))
}

fn unsupported(operation: &str) -> Error {
    Error::Invalid(format!(
        "The current prose tool does not support {operation}; it can change text in one existing paragraph. Structural and formatting edits need the F3 prose interface."
    ))
}

fn marker(kind: &str, value: &Value) -> String {
    // JSON ids cannot introduce a new line or close a marker.
    let value = value
        .to_string()
        .replace('<', "\\u003c")
        .replace('>', "\\u003e");
    format!("<!-- drifting:{kind} {value} -->")
}

fn heading_prefix(heading: u8) -> String {
    if heading == 0 {
        String::new()
    } else {
        format!("{} ", "#".repeat(heading as usize))
    }
}

fn reserved(c: char) -> bool {
    matches!(
        c,
        '\\' | '*' | '_' | '~' | '`' | '[' | ']' | '<' | '>' | '#' | '|'
    )
}

fn block_prefix(text: &str) -> bool {
    let text = text.trim_start();
    text.starts_with(['-', '+', '='])
        || text
            .find(['.', ')'])
            .is_some_and(|end| end > 0 && text[..end].bytes().all(|c| c.is_ascii_digit()))
}

fn escape(text: &str) -> String {
    let prefix = block_prefix(text);
    let first = text.find(|c: char| !c.is_whitespace());
    let mut out = String::new();
    for (at, c) in text.char_indices() {
        if reserved(c) || (prefix && Some(at) == first) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn unescape(text: &str) -> Result<String> {
    if block_prefix(text) {
        return Err(unsupported("introducing Markdown block formatting"));
    }
    let mut out = String::new();
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            let next = chars
                .next()
                .ok_or_else(|| unsupported("an incomplete text escape"))?;
            if !reserved(next) && !matches!(next, '-' | '+' | '=' | '0'..='9') {
                return Err(unsupported("an unsupported text escape"));
            }
            out.push(next);
        } else if reserved(c) {
            return Err(unsupported(
                "introducing Markdown inline or heading formatting",
            ));
        } else if c == '\r' {
            return Err(unsupported("changing paragraph line endings"));
        } else {
            out.push(c);
        }
    }
    Ok(out)
}

fn minimal_replacement(before: &str, after: &str) -> Result<(String, String)> {
    let old: Vec<_> = before.chars().collect();
    let new: Vec<_> = after.chars().collect();
    if old.is_empty() {
        return Err(unsupported("inserting into an empty paragraph"));
    }
    let mut start = old.iter().zip(&new).take_while(|(a, b)| a == b).count();
    let suffix = old[start..]
        .iter()
        .rev()
        .zip(new[start..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    let (mut old_end, mut new_end) = (old.len() - suffix, new.len() - suffix);
    loop {
        if let Some(find) = unique_find(before, &old, start, old_end) {
            return Ok((find, new[start..new_end].iter().collect()));
        }
        // Include unchanged context only when F3 needs it to identify the
        // exact occurrence (or to anchor an insertion's nonempty `find`).
        // Try both adjacent characters before widening further: a repeated
        // prefix must not hide a unique, shorter suffix anchor.
        if start > 0
            && let Some(find) = unique_find(before, &old, start - 1, old_end)
        {
            return Ok((find, new[start - 1..new_end].iter().collect()));
        }
        if old_end < old.len()
            && let Some(find) = unique_find(before, &old, start, old_end + 1)
        {
            return Ok((find, new[start..new_end + 1].iter().collect()));
        }
        if start > 0 {
            start -= 1;
        } else if old_end < old.len() {
            old_end += 1;
            new_end += 1;
        } else {
            return Err(unsupported("finding a unique passage in this paragraph"));
        }
    }
}

fn unique_find(before: &str, old: &[char], start: usize, end: usize) -> Option<String> {
    if start == end {
        return None;
    }
    let find: String = old[start..end].iter().collect();
    let mut hits = before.match_indices(&find);
    let at = hits.next()?.0;
    (before[..at].chars().count() == start && hits.next().is_none()).then_some(find)
}
