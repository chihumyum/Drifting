//! The YAML of a frontmatter, read with yaml-rust2's event parser (pure
//! Rust). A scalar keeps the characters as written: a number or a boolean
//! written into a text field reads back as typed. One document, keys unique
//! in each mapping, aliases replaced by what their anchor names. Nesting and
//! the nodes aliases expand to are bounded, since outside files are read.

use std::collections::HashMap;

use yaml_rust2::Yaml;
use yaml_rust2::parser::{Event, MarkedEventReceiver, Parser, Tag};
use yaml_rust2::scanner::{Marker, TScalarStyle};

/// Deeper YAML is not a frontmatter an editor writes.
const MAX_DEPTH: usize = 64;
/// Nodes in a document, aliases counted as often as they are used.
const MAX_NODES: usize = 100_000;

#[derive(Clone, Debug)]
pub(crate) enum Value {
    /// `typed` is false for a quoted or block scalar and for `!!str`: those
    /// are strings whatever their text.
    Scalar {
        text: String,
        typed: bool,
    },
    Seq(Vec<Value>),
    Map(Mapping),
}

/// A mapping in the order written.
#[derive(Clone, Debug, Default)]
pub(crate) struct Mapping(Vec<(Value, Value)>);

/// A scalar read with YAML 1.2's core schema.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Scalar<'a> {
    Null,
    Bool(bool),
    Number(f64),
    Text(&'a str),
}

impl Value {
    pub fn string(text: impl Into<String>) -> Self {
        Self::Scalar {
            text: text.into(),
            typed: false,
        }
    }

    pub fn null() -> Self {
        Self::Scalar {
            text: String::new(),
            typed: true,
        }
    }

    pub fn bool(value: bool) -> Self {
        Self::Scalar {
            text: value.to_string(),
            typed: true,
        }
    }

    /// Rust's `Display` of a finite number has no exponent, and YAML reads
    /// it back as the same number.
    pub fn number(value: f64) -> Self {
        Self::Scalar {
            text: value.to_string(),
            typed: true,
        }
    }

    pub fn strings(values: impl IntoIterator<Item = String>) -> Self {
        Self::Seq(values.into_iter().map(Self::string).collect())
    }

    pub fn scalar(&self) -> Option<Scalar<'_>> {
        match self {
            Self::Scalar { text, typed: true } => Some(resolve(text)),
            Self::Scalar { text, typed: false } => Some(Scalar::Text(text)),
            _ => None,
        }
    }

    pub fn is_null(&self) -> bool {
        self.scalar() == Some(Scalar::Null)
    }

    /// A string: quoted, or plain text YAML reads as no other type.
    pub fn as_str(&self) -> Option<&str> {
        match self.scalar()? {
            Scalar::Text(text) => Some(text),
            _ => None,
        }
    }

    /// Any scalar but null, as written.
    pub fn text(&self) -> Option<&str> {
        match self {
            Self::Scalar { text, .. } if !self.is_null() => Some(text),
            _ => None,
        }
    }

    pub fn as_seq(&self) -> Option<&[Value]> {
        match self {
            Self::Seq(items) => Some(items),
            _ => None,
        }
    }

    fn nodes(&self) -> usize {
        match self {
            Self::Scalar { .. } => 1,
            Self::Seq(items) => 1 + items.iter().map(Self::nodes).sum::<usize>(),
            Self::Map(map) => {
                1 + map
                    .0
                    .iter()
                    .map(|(k, v)| k.nodes() + v.nodes())
                    .sum::<usize>()
            }
        }
    }
}

/// Equal in meaning: `1.0` is `1`, a quoted `"2026-11-16"` is the plain one.
impl PartialEq for Value {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Scalar { .. }, Self::Scalar { .. }) => self.scalar() == other.scalar(),
            (Self::Seq(a), Self::Seq(b)) => a == b,
            (Self::Map(a), Self::Map(b)) => a.0 == b.0,
            _ => false,
        }
    }
}

impl Mapping {
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.0
            .iter()
            .find(|(k, _)| k.as_str() == Some(key))
            .map(|(_, v)| v)
    }

    /// Each key as a string; `None` for a key of another type.
    pub fn keys(&self) -> impl Iterator<Item = Option<&str>> {
        self.0.iter().map(|(k, _)| k.as_str())
    }
}

/// The core schema (yaml-rust2's reading), with `Null` and `NULL` too.
pub(crate) fn resolve(text: &str) -> Scalar<'_> {
    match text {
        "Null" | "NULL" => return Scalar::Null,
        _ => {}
    }
    match Yaml::from_str(text) {
        Yaml::Null => Scalar::Null,
        Yaml::Boolean(value) => Scalar::Bool(value),
        Yaml::Integer(value) => Scalar::Number(value as f64),
        real @ Yaml::Real(_) => real.as_f64().map_or(Scalar::Text(text), Scalar::Number),
        _ => Scalar::Text(text),
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Invalid;

/// The document in `raw`: `None` when it has none (only blank lines and
/// comments).
pub(crate) fn parse(raw: &str) -> Result<Option<Value>, Invalid> {
    let mut builder = Builder::default();
    Parser::new_from_str(raw)
        .load(&mut builder, true)
        .map_err(|_| Invalid)?;
    if builder.failed || builder.documents > 1 || !builder.stack.is_empty() {
        return Err(Invalid);
    }
    Ok(builder.root)
}

enum Frame {
    Seq(Vec<Value>),
    Map(Vec<(Value, Value)>, Option<Value>),
}

#[derive(Default)]
struct Builder {
    stack: Vec<(Frame, usize)>,
    anchors: HashMap<usize, Value>,
    root: Option<Value>,
    documents: usize,
    nodes: usize,
    failed: bool,
}

impl Builder {
    fn open(&mut self, frame: Frame, anchor: usize) {
        if self.stack.len() >= MAX_DEPTH {
            self.failed = true;
        } else {
            self.stack.push((frame, anchor));
        }
    }

    fn close(&mut self) {
        let Some((frame, anchor)) = self.stack.pop() else {
            self.failed = true;
            return;
        };
        let value = match frame {
            Frame::Seq(items) => Value::Seq(items),
            Frame::Map(pairs, None) => Value::Map(Mapping(pairs)),
            Frame::Map(_, Some(_)) => {
                self.failed = true;
                return;
            }
        };
        self.node(value, anchor, 1);
    }

    /// `cost`: the nodes `value` adds that were not counted yet.
    fn node(&mut self, value: Value, anchor: usize, cost: usize) {
        self.nodes += cost;
        if self.nodes > MAX_NODES {
            self.failed = true;
            return;
        }
        if anchor > 0 {
            self.anchors.insert(anchor, value.clone());
        }
        match self.stack.last_mut() {
            None if self.root.is_none() => self.root = Some(value),
            None => self.failed = true,
            Some((Frame::Seq(items), _)) => items.push(value),
            Some((Frame::Map(pairs, pending), _)) => match pending.take() {
                None => *pending = Some(value),
                Some(key) => {
                    if pairs.iter().any(|(seen, _)| *seen == key) {
                        self.failed = true;
                    }
                    pairs.push((key, value));
                }
            },
        }
    }
}

fn is_str_tag(tag: &Tag) -> bool {
    tag.handle == "tag:yaml.org,2002:" && tag.suffix == "str"
}

impl MarkedEventReceiver for Builder {
    fn on_event(&mut self, event: Event, _: Marker) {
        if self.failed {
            return;
        }
        match event {
            Event::DocumentStart => self.documents += 1,
            Event::Scalar(text, style, anchor, tag) => {
                let typed = style == TScalarStyle::Plain && !tag.as_ref().is_some_and(is_str_tag);
                self.node(Value::Scalar { text, typed }, anchor, 1);
            }
            Event::SequenceStart(anchor, _) => self.open(Frame::Seq(Vec::new()), anchor),
            Event::MappingStart(anchor, _) => self.open(Frame::Map(Vec::new(), None), anchor),
            Event::SequenceEnd | Event::MappingEnd => self.close(),
            Event::Alias(anchor) => match self.anchors.get(&anchor).cloned() {
                Some(value) => {
                    let cost = value.nodes();
                    self.node(value, 0, cost);
                }
                // An alias of a node still being read (a cycle).
                None => self.failed = true,
            },
            Event::Nothing | Event::StreamStart | Event::StreamEnd | Event::DocumentEnd => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(raw: &str) -> Mapping {
        match parse(raw).unwrap() {
            Some(Value::Map(map)) => map,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn scalars_keep_their_text_and_resolve_by_the_core_schema() {
        let m = map(
            "a: 2026\nb: 007\nc: true\nd: '3000'\ne: 1.50\nf:\ng: ~\nh: !!str 12\ni: 2026-11-16\nj: NULL\n",
        );
        assert_eq!(m.get("a").unwrap().scalar(), Some(Scalar::Number(2026.0)));
        assert_eq!(m.get("b").unwrap().text(), Some("007"));
        assert_eq!(m.get("c").unwrap().scalar(), Some(Scalar::Bool(true)));
        assert_eq!(m.get("d").unwrap().as_str(), Some("3000"));
        assert_eq!(m.get("e").unwrap().text(), Some("1.50"));
        assert_eq!(*m.get("e").unwrap(), Value::number(1.5));
        assert!(m.get("f").unwrap().is_null() && m.get("g").unwrap().is_null());
        assert_eq!(m.get("h").unwrap().as_str(), Some("12"));
        assert_eq!(*m.get("i").unwrap(), Value::string("2026-11-16"));
        assert!(m.get("j").unwrap().is_null());
    }

    #[test]
    fn aliases_expand_and_repeated_keys_cycles_and_bombs_are_refused() {
        let m = map("a: &x [1, 2]\nb: *x\n");
        assert_eq!(m.get("a"), m.get("b"));
        assert_eq!(parse("a: 1\na: 2\n"), Err(Invalid));
        assert_eq!(parse("a: {b: 1, b: 2}\n"), Err(Invalid));
        assert_eq!(parse("a: *missing\n"), Err(Invalid));
        assert_eq!(parse("a: &x [*x]\n"), Err(Invalid));
        assert_eq!(parse("a: 1\n--- \nb: 2\n"), Err(Invalid));
        let mut bomb = String::from("a0: &a0 [x, x, x, x, x, x, x, x, x, x]\n");
        for i in 1..8 {
            let p = i - 1;
            bomb.push_str(&format!(
                "a{i}: &a{i} [*a{p}, *a{p}, *a{p}, *a{p}, *a{p}, *a{p}, *a{p}, *a{p}, *a{p}, *a{p}]\n"
            ));
        }
        assert_eq!(parse(&bomb), Err(Invalid));
        let deep = format!("a: {}{}\n", "[".repeat(200), "]".repeat(200));
        assert_eq!(parse(&deep), Err(Invalid));
        assert_eq!(parse("# only a comment\n\n"), Ok(None));
    }
}
