//! ProseMirror JSON (the old `contentJson` / `bodyJson`, and the old client's
//! rendering of a Yjs document) to and from flat lines, the shape decision D3
//! gives a prose document: one text, one line per leaf block, block attributes
//! on the line, and the leaf's ancestors (block quote, list, list item, task,
//! callout, table cell) kept as a path so the tree can be rebuilt exactly.
//!
//! Nothing is dropped: an unknown block becomes a line or a container, an
//! unknown inline node becomes U+FFFC with an `inline` span holding its JSON.

use std::collections::BTreeMap;

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

/// A hard break inside a block. It must not end the line, so it is not `\n`.
pub const HARD_BREAK: char = '\u{2028}';
/// An inline node other than text or a hard break.
pub const INLINE_OBJECT: char = '\u{FFFC}';

/// Leaf blocks whose content is inline.
const TEXTBLOCKS: &[&str] = &["paragraph", "heading", "codeBlock"];

/// One ancestor of a line. `ordinal` is its index among its parent's children,
/// so two adjacent containers with equal attributes (table rows have no id)
/// stay apart.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Container {
    pub kind: String,
    pub attrs: BTreeMap<String, Value>,
    pub ordinal: usize,
}

/// One leaf block.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Line {
    /// `paragraph`, `heading`, `codeBlock`, or an atom such as `horizontalRule`
    /// and `materialEmbed`.
    pub kind: String,
    /// `id`, `level`, `indent`, `textAlign`, … without nulls and defaults.
    pub attrs: BTreeMap<String, Value>,
    pub path: Vec<Container>,
    /// Inline text; hard breaks are [`HARD_BREAK`].
    pub text: String,
    /// Sorted, merged, in chars of `text`.
    pub marks: Vec<Span>,
    /// Ordinal of this leaf among its parent's children.
    pub ordinal: usize,
    /// Leaf atoms have no `content` array; empty textblocks may or may not.
    pub atom: bool,
}

/// A mark over `start..end` (Unicode scalar values within the line).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct Span {
    pub start: usize,
    pub end: usize,
    /// Mark type (`bold`, `italic`, `entityLink`, …) or `inline` for an inline object.
    pub mark: String,
    /// Canonical JSON of the mark's attributes; empty when it has none.
    pub attrs: String,
}

impl Line {
    pub fn id(&self) -> Option<&str> {
        self.attrs.get("id").and_then(Value::as_str)
    }

    /// The block text as the old client counted offsets: DOM `textContent`,
    /// where a hard break and an inline object contribute nothing.
    pub fn legacy_text(&self) -> String {
        self.text
            .chars()
            .filter(|c| *c != HARD_BREAK && *c != INLINE_OBJECT)
            .collect()
    }
}

/// A parsed prose document plus what it contained.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Prose {
    pub lines: Vec<Line>,
}

impl Prose {
    pub fn chars(&self) -> usize {
        self.lines
            .iter()
            .map(|line| line.text.chars().count())
            .sum()
    }

    /// Every block id with the range of lines it covers (a leaf, or a container
    /// such as a block quote or list item that comments may also anchor to).
    pub fn block_ranges(&self) -> BTreeMap<String, (usize, usize)> {
        let mut ranges: BTreeMap<String, (usize, usize)> = BTreeMap::new();
        for (index, line) in self.lines.iter().enumerate() {
            let ids = line
                .path
                .iter()
                .filter_map(|c| c.attrs.get("id").and_then(Value::as_str))
                .chain(line.id());
            for id in ids {
                ranges
                    .entry(id.to_string())
                    .and_modify(|r| r.1 = index)
                    .or_insert((index, index));
            }
        }
        ranges
    }
}

fn canonical_attrs(node_type: &str, attrs: Option<&Value>) -> BTreeMap<String, Value> {
    let mut out = BTreeMap::new();
    if let Some(Value::Object(map)) = attrs {
        for (key, value) in map {
            if value.is_null() {
                continue;
            }
            // Schema defaults: one side may spell them out and the other omit them.
            if key == "indent" && value.as_i64() == Some(0) {
                continue;
            }
            if key == "textAlign" && value.as_str() == Some("left") {
                continue;
            }
            if node_type == "taskItem" && key == "checked" && value.as_bool() == Some(false) {
                continue;
            }
            out.insert(key.clone(), value.clone());
        }
    }
    out
}

fn canonical_json(value: &Value) -> String {
    // serde_json's Map is a BTreeMap here (no `preserve_order`), so keys are sorted.
    serde_json::to_string(value).unwrap_or_default()
}

fn mark_attrs(mark: &Value) -> String {
    let attrs = canonical_attrs("", mark.get("attrs"));
    if attrs.is_empty() {
        String::new()
    } else {
        canonical_json(&Value::Object(attrs.into_iter().collect()))
    }
}

fn is_inline(node: &Value) -> bool {
    matches!(
        node.get("type").and_then(Value::as_str),
        Some("text" | "hardBreak")
    ) || node.get("text").is_some()
}

/// Parse a ProseMirror document. `{}` and an empty string are an empty document.
pub fn parse(source: &str) -> Result<Prose> {
    let trimmed = source.trim();
    if trimmed.is_empty() || trimmed == "{}" {
        return Ok(Prose::default());
    }
    let value: Value = serde_json::from_str(trimmed)?;
    parse_value(&value)
}

pub fn parse_value(doc: &Value) -> Result<Prose> {
    if doc.get("type").is_none() && doc.as_object().is_some_and(Map::is_empty) {
        return Ok(Prose::default());
    }
    if doc.get("type").and_then(Value::as_str) != Some("doc") {
        bail!("not a ProseMirror document");
    }
    let mut prose = Prose::default();
    let mut path = Vec::new();
    for (ordinal, child) in children(doc).iter().enumerate() {
        visit_block(child, ordinal, &mut path, &mut prose.lines)?;
    }
    Ok(prose)
}

fn children(node: &Value) -> &[Value] {
    node.get("content")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn visit_block(
    node: &Value,
    ordinal: usize,
    path: &mut Vec<Container>,
    out: &mut Vec<Line>,
) -> Result<()> {
    let kind = node
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if kind.is_empty() {
        bail!("block without a type");
    }
    let content = children(node);
    let leaf =
        TEXTBLOCKS.contains(&kind.as_str()) || content.is_empty() || content.iter().all(is_inline);
    if leaf {
        let (text, marks) = inline_content(content);
        out.push(Line {
            attrs: canonical_attrs(&kind, node.get("attrs")),
            atom: node.get("content").is_none() && !TEXTBLOCKS.contains(&kind.as_str()),
            kind,
            path: path.clone(),
            text,
            marks,
            ordinal,
        });
        return Ok(());
    }
    path.push(Container {
        attrs: canonical_attrs(&kind, node.get("attrs")),
        kind,
        ordinal,
    });
    for (index, child) in content.iter().enumerate() {
        visit_block(child, index, path, out)?;
    }
    path.pop();
    Ok(())
}

fn inline_content(content: &[Value]) -> (String, Vec<Span>) {
    let mut text = String::new();
    let mut spans = Vec::new();
    let mut at = 0usize;
    for node in content {
        let (piece, extra) = match node.get("type").and_then(Value::as_str) {
            Some("text") => (
                node.get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                None,
            ),
            Some("hardBreak") => (HARD_BREAK.to_string(), None),
            _ => {
                let mut stored = node.clone();
                if let Some(map) = stored.as_object_mut() {
                    map.remove("marks");
                }
                (INLINE_OBJECT.to_string(), Some(canonical_json(&stored)))
            }
        };
        let len = piece.chars().count();
        if let Some(stored) = extra {
            spans.push(Span {
                start: at,
                end: at + len,
                mark: "inline".into(),
                attrs: stored,
            });
        }
        if let Some(marks) = node.get("marks").and_then(Value::as_array) {
            for mark in marks {
                let name = mark
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                spans.push(Span {
                    start: at,
                    end: at + len,
                    mark: name,
                    attrs: mark_attrs(mark),
                });
            }
        }
        text.push_str(&piece);
        at += len;
    }
    (text, normalize_spans(spans))
}

/// Sort, then merge touching or overlapping spans of the same mark and attributes.
pub fn normalize_spans(mut spans: Vec<Span>) -> Vec<Span> {
    spans.retain(|s| s.end > s.start);
    spans.sort_by(|a, b| {
        (&a.mark, &a.attrs, a.start, a.end).cmp(&(&b.mark, &b.attrs, b.start, b.end))
    });
    let mut merged: Vec<Span> = Vec::with_capacity(spans.len());
    for span in spans {
        if let Some(last) = merged.last_mut()
            && last.mark == span.mark
            && last.attrs == span.attrs
            && span.start <= last.end
            && span.mark != "inline"
        {
            last.end = last.end.max(span.end);
            continue;
        }
        merged.push(span);
    }
    merged.sort();
    merged
}

/// Rebuild the ProseMirror document from lines.
pub fn to_value(prose: &Prose) -> Value {
    let mut root: Vec<Value> = Vec::new();
    let mut stack: Vec<(Container, Vec<Value>)> = Vec::new();
    for line in &prose.lines {
        // Close containers that this line is not inside.
        let mut common = 0;
        while common < stack.len()
            && common < line.path.len()
            && stack[common].0 == line.path[common]
        {
            common += 1;
        }
        while stack.len() > common {
            let (container, content) = stack.pop().expect("non-empty");
            let node = container_node(&container, content);
            push(&mut stack, &mut root, node);
        }
        for container in &line.path[common..] {
            stack.push((container.clone(), Vec::new()));
        }
        push(&mut stack, &mut root, line_node(line));
    }
    while let Some((container, content)) = stack.pop() {
        let node = container_node(&container, content);
        push(&mut stack, &mut root, node);
    }
    json!({ "type": "doc", "content": root })
}

fn push(stack: &mut [(Container, Vec<Value>)], root: &mut Vec<Value>, node: Value) {
    match stack.last_mut() {
        Some((_, content)) => content.push(node),
        None => root.push(node),
    }
}

fn attrs_value(attrs: &BTreeMap<String, Value>) -> Option<Value> {
    (!attrs.is_empty())
        .then(|| Value::Object(attrs.iter().map(|(k, v)| (k.clone(), v.clone())).collect()))
}

fn container_node(container: &Container, content: Vec<Value>) -> Value {
    let mut node = Map::new();
    node.insert("type".into(), Value::String(container.kind.clone()));
    if let Some(attrs) = attrs_value(&container.attrs) {
        node.insert("attrs".into(), attrs);
    }
    node.insert("content".into(), Value::Array(content));
    Value::Object(node)
}

fn line_node(line: &Line) -> Value {
    let mut node = Map::new();
    node.insert("type".into(), Value::String(line.kind.clone()));
    if let Some(attrs) = attrs_value(&line.attrs) {
        node.insert("attrs".into(), attrs);
    }
    if !line.atom {
        node.insert("content".into(), Value::Array(inline_nodes(line)));
    }
    Value::Object(node)
}

fn inline_nodes(line: &Line) -> Vec<Value> {
    let chars: Vec<char> = line.text.chars().collect();
    let mut cuts: Vec<usize> = vec![0, chars.len()];
    for span in &line.marks {
        cuts.push(span.start);
        cuts.push(span.end);
    }
    for (index, c) in chars.iter().enumerate() {
        if *c == HARD_BREAK || *c == INLINE_OBJECT {
            cuts.push(index);
            cuts.push(index + 1);
        }
    }
    cuts.sort_unstable();
    cuts.dedup();
    let mut nodes = Vec::new();
    for window in cuts.windows(2) {
        let (start, end) = (window[0], window[1]);
        if start >= end {
            continue;
        }
        let covering: Vec<&Span> = line
            .marks
            .iter()
            .filter(|s| s.start <= start && s.end >= end)
            .collect();
        let marks: Vec<Value> = covering
            .iter()
            .filter(|s| s.mark != "inline")
            .map(|s| {
                let mut mark = Map::new();
                mark.insert("type".into(), Value::String(s.mark.clone()));
                if !s.attrs.is_empty() {
                    mark.insert(
                        "attrs".into(),
                        serde_json::from_str(&s.attrs).unwrap_or(Value::Null),
                    );
                }
                Value::Object(mark)
            })
            .collect();
        let piece: String = chars[start..end].iter().collect();
        let mut node = if piece == HARD_BREAK.to_string() {
            json!({ "type": "hardBreak" })
        } else if let Some(stored) = covering.iter().find(|s| s.mark == "inline") {
            serde_json::from_str(&stored.attrs).unwrap_or(Value::Null)
        } else {
            json!({ "type": "text", "text": piece })
        };
        if !marks.is_empty()
            && let Some(map) = node.as_object_mut()
        {
            map.insert("marks".into(), Value::Array(marks));
        }
        nodes.push(node);
    }
    nodes
}

/// Two documents are the same prose when their lines are equal.
pub fn same_prose(a: &Prose, b: &Prose) -> bool {
    a.lines == b.lines
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHAPTER: &str = r#"{"type":"doc","content":[
      {"type":"heading","attrs":{"id":"h1","level":1,"indent":0},"content":[{"type":"text","text":"第一章"}]},
      {"type":"paragraph","attrs":{"id":"p1","textAlign":"center"},"content":[
        {"type":"text","text":"我要给"},
        {"type":"text","text":"阿Q","marks":[{"type":"italic"},{"type":"entityLink","attrs":{"targetKind":"element","targetId":"e1","targetBlockId":null}}]},
        {"type":"text","text":"做正传"},{"type":"hardBreak"},{"type":"text","text":"第二行","marks":[{"type":"bold"}]}]},
      {"type":"blockquote","attrs":{"id":"q1"},"content":[
        {"type":"paragraph","attrs":{"id":"p2"},"content":[{"type":"text","text":"信的第一段"}]},
        {"type":"paragraph","attrs":{"id":"p3"}}]},
      {"type":"paragraph","attrs":{"id":"p4"},"content":[]}
    ]}"#;

    const NOTE: &str = r#"{"type":"doc","content":[
      {"type":"taskList","attrs":{"id":"t"},"content":[
        {"type":"taskItem","attrs":{"id":"ti1","checked":true,"todoId":"todo-1"},"content":[{"type":"paragraph","attrs":{"id":"tp1"},"content":[{"type":"text","text":"核对称呼"}]}]},
        {"type":"taskItem","attrs":{"id":"ti2","checked":false},"content":[{"type":"paragraph","attrs":{"id":"tp2"},"content":[{"type":"text","text":"补一条"}]}]}]},
      {"type":"table","attrs":{"id":"tb"},"content":[
        {"type":"tableRow","content":[{"type":"tableHeader","attrs":{"colspan":1,"rowspan":1,"colwidth":null},"content":[{"type":"paragraph","content":[{"type":"text","text":"人物"}]}]}]},
        {"type":"tableRow","content":[{"type":"tableCell","attrs":{"colspan":1,"rowspan":1,"colwidth":null},"content":[{"type":"paragraph","content":[{"type":"text","text":"赵太爷"}]}]}]}]},
      {"type":"materialEmbed","attrs":{"id":"m","libraryItemId":"lib-1"}},
      {"type":"paragraph","attrs":{"id":"x"},"content":[{"type":"mention","attrs":{"who":"z"}},{"type":"text","text":"尾"}]}
    ]}"#;

    #[test]
    fn chapter_lines_carry_ids_marks_and_breaks() {
        let prose = parse(CHAPTER).unwrap();
        assert_eq!(prose.lines.len(), 5);
        let p1 = &prose.lines[1];
        assert_eq!(p1.id(), Some("p1"));
        assert_eq!(p1.text, format!("我要给阿Q做正传{HARD_BREAK}第二行"));
        assert_eq!(p1.legacy_text(), "我要给阿Q做正传第二行");
        assert!(
            p1.marks
                .iter()
                .any(|s| s.mark == "entityLink" && s.start == 3 && s.end == 5)
        );
        assert!(!prose.lines[0].attrs.contains_key("indent"));
        assert_eq!(prose.lines[2].path[0].kind, "blockquote");
        let ranges = prose.block_ranges();
        assert_eq!(ranges["q1"], (2, 3));
        assert_eq!(ranges["p4"], (4, 4));
    }

    #[test]
    fn rebuilding_is_lossless_for_prose_and_notes() {
        for source in [CHAPTER, NOTE] {
            let prose = parse(source).unwrap();
            let rebuilt = parse_value(&to_value(&prose)).unwrap();
            assert_eq!(prose, rebuilt);
        }
        let note = parse(NOTE).unwrap();
        // Two table rows without ids stay two rows.
        let rebuilt = to_value(&note);
        assert_eq!(
            rebuilt["content"][1]["content"].as_array().unwrap().len(),
            2
        );
        // The unknown inline node survives as an inline object.
        assert!(
            note.lines
                .last()
                .unwrap()
                .marks
                .iter()
                .any(|s| s.mark == "inline")
        );
        assert_eq!(rebuilt["content"][3]["content"][0]["type"], "mention");
    }

    #[test]
    fn mark_order_and_split_text_nodes_do_not_matter() {
        let a = r#"{"type":"doc","content":[{"type":"paragraph","attrs":{"id":"p"},"content":[{"type":"text","text":"ab","marks":[{"type":"bold"},{"type":"italic"}]}]}]}"#;
        let b = r#"{"type":"doc","content":[{"type":"paragraph","attrs":{"id":"p","indent":0},"content":[{"type":"text","text":"a","marks":[{"type":"italic"},{"type":"bold"}]},{"type":"text","text":"b","marks":[{"type":"bold"},{"type":"italic"}]}]}]}"#;
        assert!(same_prose(&parse(a).unwrap(), &parse(b).unwrap()));
    }

    #[test]
    fn empty_documents() {
        assert!(parse("{}").unwrap().lines.is_empty());
        assert!(
            parse(r#"{"type":"doc","content":[]}"#)
                .unwrap()
                .lines
                .is_empty()
        );
        assert!(parse(r#"{"type":"paragraph"}"#).is_err());
    }
}
