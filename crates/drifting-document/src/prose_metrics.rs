//! The renderer's derived prose projection of a node body: y-prosemirror's
//! `yDocToProsemirrorJSON` over the `default` fragment, the heading outline
//! (`extractOutline`) and `@drifting/prose-metrics` (word count and the
//! canonical-JSON basis hash). Hashes and counts are exact; `content_json`
//! keeps node keys in JavaScript order and attributes sorted.
use super::*;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::sync::Arc;

/// Mark rank in the editor schema (`Object.keys(schema.marks)`): marks that
/// open at the same position are ordered as y-prosemirror inserts them.
const MARK_RANK: [&str; 7] = [
    "link",
    "bold",
    "code",
    "italic",
    "strike",
    "underline",
    "entityLink",
];

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProseProjection {
    pub content_json: String,
    pub outline_json: String,
    pub word_count: u64,
    pub basis_hash: String,
}

/// A JSON value that remembers object key order.
#[derive(Clone, Debug, PartialEq)]
enum Json {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Json>),
    Object(Vec<(String, Json)>),
}

impl Json {
    fn from_any(value: &Any) -> Json {
        match value {
            Any::Null | Any::Undefined => Json::Null,
            Any::Bool(value) => Json::Bool(*value),
            Any::Number(value) => Json::Number(value.as_f64().unwrap_or(f64::NAN)),
            Any::String(value) => Json::String(value.to_string()),
            Any::Buffer(bytes) => {
                Json::Array(bytes.iter().map(|b| Json::Number(*b as f64)).collect())
            }
            Any::Array(values) => Json::Array(values.iter().map(Json::from_any).collect()),
            Any::Map(map) => Json::Object(sorted(
                map.iter().map(|(k, v)| (k.to_string(), Json::from_any(v))),
            )),
        }
    }

    fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Object(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    fn str(&self) -> Option<&str> {
        match self {
            Json::String(value) => Some(value),
            _ => None,
        }
    }

    /// `JSON.stringify` with this value's key order.
    fn write(&self, out: &mut String, canonical: bool) {
        match self {
            Json::Null => out.push_str("null"),
            Json::Bool(value) => out.push_str(if *value { "true" } else { "false" }),
            Json::Number(value) => out.push_str(&js_number(*value)),
            Json::String(value) => out.push_str(&serde_json::to_string(value).unwrap_or_default()),
            Json::Array(values) => {
                out.push('[');
                for (index, value) in values.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    value.write(out, canonical);
                }
                out.push(']');
            }
            Json::Object(entries) => {
                let mut refs: Vec<&(String, Json)> = entries.iter().collect();
                if canonical {
                    // JavaScript's default sort compares UTF-16 code units.
                    refs.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
                }
                out.push('{');
                for (index, (key, value)) in refs.into_iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    out.push_str(&serde_json::to_string(key).unwrap_or_default());
                    out.push(':');
                    value.write(out, canonical);
                }
                out.push('}');
            }
        }
    }

    fn to_string(&self, canonical: bool) -> String {
        let mut out = String::new();
        self.write(&mut out, canonical);
        out
    }
}

/// Attribute keys in the editor schema's declaration order, which is the
/// order y-prosemirror sets them; any other key follows, sorted.
const ATTRIBUTE_ORDER: [&str; 15] = [
    "id",
    "level",
    "language",
    "start",
    "type",
    "textAlign",
    "indent",
    "href",
    "target",
    "rel",
    "class",
    "title",
    "targetKind",
    "targetId",
    "targetBlockId",
];

fn sorted(entries: impl Iterator<Item = (String, Json)>) -> Vec<(String, Json)> {
    let mut entries: Vec<_> = entries.collect();
    let rank = |key: &str| {
        ATTRIBUTE_ORDER
            .iter()
            .position(|k| *k == key)
            .unwrap_or(ATTRIBUTE_ORDER.len())
    };
    entries.sort_by(|a, b| rank(&a.0).cmp(&rank(&b.0)).then_with(|| a.0.cmp(&b.0)));
    entries
}

/// `Number.prototype.toString` for the finite values prose attributes hold.
fn js_number(value: f64) -> String {
    if !value.is_finite() {
        return "null".into();
    }
    if value == value.trunc() && value.abs() < 1e21 {
        return format!("{}", value as i128);
    }
    let text = serde_json::to_string(&value).unwrap_or_default();
    match text.split_once('e') {
        Some((mantissa, exponent)) if !exponent.starts_with(['-', '+']) => {
            format!("{mantissa}e+{exponent}")
        }
        _ => text,
    }
}

/// y-prosemirror `yattr2markname`: strip an overlapping mark's `--<hash>`.
fn mark_name(key: &str) -> &str {
    let bytes = key.as_bytes();
    if bytes.len() >= 10 && key.is_char_boundary(bytes.len() - 10) {
        let (base, suffix) = key.split_at(bytes.len() - 10);
        let hash = &suffix.as_bytes()[2..];
        if suffix.starts_with("--")
            && hash
                .iter()
                .all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(b))
        {
            return base;
        }
    }
    key
}

fn rank(key: &str) -> usize {
    let name = mark_name(key);
    MARK_RANK
        .iter()
        .position(|mark| *mark == name)
        .unwrap_or(MARK_RANK.len())
}

fn serialize<T: ReadTxn>(node: &XmlOut, txn: &T) -> Result<Vec<Json>, String> {
    match node {
        XmlOut::Text(text) => {
            // Each Y.XmlText computes its own delta and attribute map.
            let mut open: Vec<Arc<str>> = Vec::new();
            let mut result = Vec::new();
            for run in text.diff(txn, YChange::identity) {
                let Out::Any(Any::String(insert)) = run.insert else {
                    return Err("Embedded inline content cannot be projected".into());
                };
                let attributes = run.attributes.as_deref();
                // A JavaScript Map keeps the order keys were first set and
                // forgets removed keys; keys opening together follow rank.
                open.retain(|key| attributes.is_some_and(|attrs| attrs.contains_key(key)));
                let mut opened: Vec<Arc<str>> = attributes
                    .map(|attrs| {
                        attrs
                            .keys()
                            .filter(|key| !open.contains(key))
                            .cloned()
                            .collect()
                    })
                    .unwrap_or_default();
                opened.sort_by(|a, b| rank(a).cmp(&rank(b)).then_with(|| a.cmp(b)));
                open.extend(opened);
                let mut text_node = vec![
                    ("type".to_string(), Json::String("text".into())),
                    ("text".to_string(), Json::String(insert.to_string())),
                ];
                if let Some(attrs) = attributes {
                    let marks = open
                        .iter()
                        .map(|key| {
                            Json::Object(vec![
                                ("type".into(), Json::String(mark_name(key).into())),
                                ("attrs".into(), Json::from_any(&attrs[key])),
                            ])
                        })
                        .collect();
                    text_node.push(("marks".into(), Json::Array(marks)));
                }
                result.push(Json::Object(text_node));
            }
            Ok(result)
        }
        XmlOut::Element(element) => {
            let mut object = vec![("type".to_string(), Json::String(element.tag().to_string()))];
            let attrs = sorted(
                element
                    .attributes(txn)
                    .map(|(key, value)| match value {
                        Out::Any(value) => Ok((key.to_string(), Json::from_any(&value))),
                        _ => Err("Shared attribute values cannot be projected".to_string()),
                    })
                    .collect::<Result<Vec<_>, _>>()?
                    .into_iter(),
            );
            if !attrs.is_empty() {
                object.push(("attrs".into(), Json::Object(attrs)));
            }
            // `children.length`, not the flattened content, decides the key.
            let children: Vec<XmlOut> = element.children(txn).collect();
            if !children.is_empty() {
                let mut content = Vec::new();
                for child in &children {
                    content.extend(serialize(child, txn)?);
                }
                object.push(("content".into(), Json::Array(content)));
            }
            Ok(vec![Json::Object(object)])
        }
        XmlOut::Fragment(_) => Err("Nested fragments cannot be projected".into()),
    }
}

/// `extractProseText`: text, with a space after every child of a container.
fn prose_text(node: &Json, out: &mut String) {
    if node.get("type").and_then(Json::str) == Some("text") {
        if let Some(text) = node.get("text").and_then(Json::str) {
            out.push_str(text);
        }
    }
    if let Some(Json::Array(children)) = node.get("content") {
        for child in children {
            prose_text(child, out);
            out.push(' ');
        }
    }
}

/// JavaScript `\s` and `String.prototype.trim` whitespace.
fn js_space(c: char) -> bool {
    c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}')
}

/// `countWords`: CJK ideographs plus whitespace-separated tokens holding an
/// ASCII letter or digit once CJK characters and punctuation become spaces.
pub fn count_words(text: &str) -> u64 {
    let trimmed = text.trim_matches(js_space);
    if trimmed.is_empty() {
        return 0;
    }
    let ideograph = |c: char| matches!(c, '\u{3400}'..='\u{4DBF}' | '\u{4E00}'..='\u{9FFF}');
    let strippable =
        |c: char| ideograph(c) || matches!(c, '\u{3000}'..='\u{303F}' | '\u{FF00}'..='\u{FFEF}');
    let cjk = trimmed.chars().filter(|c| ideograph(*c)).count() as u64;
    let replaced: String = trimmed
        .chars()
        .map(|c| if strippable(c) { ' ' } else { c })
        .collect();
    let latin = replaced
        .split(js_space)
        .filter(|token| token.bytes().any(|b| b.is_ascii_alphanumeric()))
        .count() as u64;
    cjk + latin
}

fn heading_text(node: &Json, out: &mut String) {
    if node.get("type").and_then(Json::str) == Some("text") {
        out.push_str(node.get("text").and_then(Json::str).unwrap_or(""));
    }
    if let Some(Json::Array(children)) = node.get("content") {
        for child in children {
            heading_text(child, out);
        }
    }
}

/// `serializeOutline(extractOutline(contentJson))`. Headings without a block
/// ID get a positional ID where the renderer draws a random one.
fn outline(document: &Json) -> String {
    let mut items: Vec<Json> = Vec::new();
    let mut current: Option<usize> = None;
    fn visit(node: &Json, items: &mut Vec<Json>, current: &mut Option<usize>) {
        let kind = node.get("type").and_then(Json::str);
        let level = match node.get("attrs").and_then(|attrs| attrs.get("level")) {
            Some(Json::Number(level)) if [1.0, 2.0, 3.0].contains(level) => Some(*level),
            _ => None,
        };
        if kind == Some("heading") && level.is_some() {
            let mut text = String::new();
            heading_text(node, &mut text);
            let text = text.trim_matches(js_space);
            if !text.is_empty() {
                let position = items.len();
                let id = match node.get("attrs").and_then(|attrs| attrs.get("id")) {
                    Some(Json::String(id)) => id.clone(),
                    _ => format!("outline_native_{position}"),
                };
                items.push(Json::Object(vec![
                    ("id".into(), Json::String(id)),
                    ("level".into(), Json::Number(level.unwrap_or(1.0))),
                    ("text".into(), Json::String(text.into())),
                    ("position".into(), Json::Number(position as f64)),
                    ("paragraphsAfter".into(), Json::Number(0.0)),
                ]));
                *current = Some(position);
            }
        } else if kind == Some("paragraph") {
            if let Some(index) = *current {
                if let Json::Object(entries) = &mut items[index] {
                    if let Some((_, Json::Number(count))) =
                        entries.iter_mut().find(|(k, _)| k == "paragraphsAfter")
                    {
                        *count += 1.0;
                    }
                }
            }
        }
        if let Some(Json::Array(children)) = node.get("content") {
            for child in children {
                visit(child, items, current);
            }
        }
    }
    visit(document, &mut items, &mut current);
    Json::Array(items).to_string(false)
}

impl DocumentSession {
    /// The renderer's canonical node projection of this exact document state.
    pub fn prose_projection(&self) -> Result<ProseProjection, String> {
        let txn = self.doc.transact();
        // The fragment's items are not flattened: a top-level text becomes
        // a nested array, as `items.map(serialize)` returns.
        let mut content = Vec::new();
        for child in self.root.children(&txn) {
            let mut nodes = serialize(&child, &txn)?;
            content.push(match child {
                XmlOut::Text(_) => Json::Array(nodes),
                _ => nodes.pop().ok_or("Empty projected element")?,
            });
        }
        let document = Json::Object(vec![
            ("type".into(), Json::String("doc".into())),
            ("content".into(), Json::Array(content)),
        ]);
        let mut text = String::new();
        prose_text(&document, &mut text);
        let digest = Sha256::digest(document.to_string(true).as_bytes());
        Ok(ProseProjection {
            content_json: document.to_string(false),
            outline_json: outline(&document),
            word_count: count_words(&text),
            basis_hash: format!(
                "sha256:{}",
                digest
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>()
            ),
        })
    }
}
