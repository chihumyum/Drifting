//! Frontmatter for one active prose module. The identity is independent of
//! the filename. YAML validates the whole header; unmanaged properties retain
//! their source text instead of being serialized again.

use std::borrow::Cow;
use std::collections::HashMap;
use std::fmt::Write as _;

use dr_export::Labels;
use dr_model::id::{BodyDocId, ModuleId};
use dr_model::v3::{Entry, EntryTemplate, FieldType, FieldValue, ModuleKind};
use serde::{Deserialize, Serialize};
use serde_yaml_ng::{Mapping, Value};

pub const ID_KEY: &str = "drifting-id";
const ALIASES_KEY: &str = "aliases";
const HOSTS_KEY: &str = "挂在";

#[derive(Debug, thiserror::Error)]
#[error("unreadable Markdown frontmatter")]
pub struct BrokenFrontmatter;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FieldSlot {
    pub module: ModuleId,
    pub field: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct Field {
    slot: FieldSlot,
    key: String,
    kind: FieldType,
    value: FieldValue,
    choices: Vec<(String, String)>,
    reference: Option<String>,
}

impl Field {
    fn read_only(&self) -> bool {
        matches!(self.kind, FieldType::Image | FieldType::EntityRef)
    }

    fn emitted(&self) -> Value {
        if self.read_only() {
            return self.reference.clone().map_or(Value::Null, Value::String);
        }
        match &self.value {
            FieldValue::Text(value) if self.kind == FieldType::Select => {
                Value::String(self.label(value).to_owned())
            }
            FieldValue::List(values) if self.kind == FieldType::MultiSelect => {
                sequence(values.iter().map(|value| self.label(value).to_owned()))
            }
            value => serde_yaml_ng::to_value(value).unwrap_or(Value::Null),
        }
    }

    fn label<'a>(&'a self, value: &'a str) -> &'a str {
        self.choices
            .iter()
            .find(|(stored, _)| stored == value)
            .map_or(value, |(_, label)| label)
    }

    fn choice(&self, value: &str) -> Option<String> {
        if let Some((stored, _)) = self.choices.iter().find(|(stored, _)| stored == value) {
            return Some(stored.clone());
        }
        let mut found = self.choices.iter().filter(|(_, label)| label == value);
        let (stored, _) = found.next()?;
        found.next().is_none().then(|| stored.clone())
    }

    fn decode(&self, value: &Value) -> Option<FieldValue> {
        use FieldType as T;
        use FieldValue as V;
        if value.is_null() {
            return Some(V::Null);
        }
        match self.kind {
            T::Text | T::LongText => Some(V::Text(value.as_str()?.to_owned())),
            T::Number => Some(V::Number(value.as_f64().filter(|n| n.is_finite())?)),
            T::Date => {
                let raw = value.as_str()?;
                if !raw.is_ascii() {
                    return None;
                }
                Some(V::Text(dr_model::Day::parse(raw)?.as_str().to_owned()))
            }
            T::Select => Some(V::Text(self.choice(value.as_str()?)?)),
            T::MultiSelect => Some(V::List(
                value
                    .as_sequence()?
                    .iter()
                    .map(|value| self.choice(value.as_str()?))
                    .collect::<Option<_>>()?,
            )),
            T::Toggle => Some(V::Bool(value.as_bool()?)),
            T::Aliases => Some(V::List(
                value
                    .as_sequence()?
                    .iter()
                    .map(|v| v.as_str().map(str::to_owned))
                    .collect::<Option<_>>()?,
            )),
            _ => None,
        }
    }
}

/// The projected fields, with the App values and labels as they were when the
/// file was written. This is the field baseline kept in the ledger.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Header {
    fields: Vec<Field>,
    hosts: Vec<String>,
}

impl Header {
    pub fn for_entry(
        entry: &Entry,
        template: &EntryTemplate,
        labels: &Labels,
        hosts: Vec<String>,
        reference: impl Fn(&FieldType, &str) -> Option<String>,
    ) -> Self {
        let all: Vec<_> = template
            .modules
            .iter()
            .filter(|module| module.kind == ModuleKind::Fields)
            .flat_map(|m| m.config.defs.iter().map(move |def| (&m.id, def)))
            .collect();
        let mut counts = HashMap::new();
        for (_, def) in &all {
            *counts.entry(def.name.as_str()).or_insert(0_usize) += 1;
        }
        let aliases = all
            .iter()
            .filter(|(_, def)| def.field_type == FieldType::Aliases)
            .count();
        let fields = all
            .into_iter()
            .filter_map(|(module, def)| {
                let name = def.name.as_str();
                if name.trim().is_empty() || counts[name] > 1 || matches!(name, ID_KEY | HOSTS_KEY)
                {
                    return None;
                }
                let key = if def.field_type == FieldType::Aliases {
                    if aliases != 1 {
                        return None;
                    }
                    ALIASES_KEY
                } else {
                    if name == ALIASES_KEY {
                        return None;
                    }
                    name
                };
                let value = entry
                    .fields
                    .get(module)
                    .and_then(|fields| fields.get(&def.id))
                    .cloned()
                    .unwrap_or(FieldValue::Null);
                let target = match def.field_type {
                    FieldType::Image | FieldType::EntityRef => value
                        .as_str()
                        .and_then(|raw| reference(&def.field_type, raw)),
                    _ => None,
                };
                Some(Field {
                    slot: FieldSlot {
                        module: module.clone(),
                        field: def.id.clone(),
                    },
                    key: key.to_owned(),
                    kind: def.field_type.clone(),
                    value,
                    choices: def
                        .options
                        .iter()
                        .map(|value| (value.clone(), labels.option(value).to_owned()))
                        .collect(),
                    reference: target,
                })
            })
            .collect();
        Self { fields, hosts }
    }

    fn owns(&self, key: &str) -> bool {
        matches!(key, ID_KEY | HOSTS_KEY) || self.fields.iter().any(|field| field.key == key)
    }

    fn hosts(&self) -> Option<Value> {
        (!self.hosts.is_empty()).then(|| sequence(self.hosts.iter().cloned()))
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct FieldEdit {
    pub slot: FieldSlot,
    pub expected: FieldValue,
    pub value: FieldValue,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Edits {
    pub fields: Vec<FieldEdit>,
    pub read_only_changed: bool,
}

pub struct Parsed {
    pub id: Option<String>,
    pub body: String,
    values: Mapping,
    properties: Vec<Property>,
}

impl Parsed {
    /// Only keys present in the file can change a stored field. A valid YAML
    /// value of the wrong type is ignored. Invalid YAML does not get here.
    pub fn edits(&self, base: &Header) -> Edits {
        let mut edits = Edits {
            read_only_changed: self.values.get(HOSTS_KEY) != base.hosts().as_ref(),
            ..Edits::default()
        };
        for field in &base.fields {
            let external = self.values.get(field.key.as_str());
            let emitted = field.emitted();
            if field.read_only() {
                edits.read_only_changed |= external != Some(&emitted);
            } else if let Some(external) = external.filter(|external| *external != &emitted)
                && let Some(value) = field.decode(external).filter(|value| *value != field.value)
            {
                edits.fields.push(FieldEdit {
                    slot: field.slot.clone(),
                    expected: field.value.clone(),
                    value,
                });
            }
        }
        edits
    }

    pub fn extra(&self, header: &Header) -> String {
        let mut out = String::new();
        for property in &self.properties {
            if property.key.as_deref().is_some_and(|key| header.owns(key)) {
                for comment in property
                    .raw
                    .split_inclusive('\n')
                    .skip(1)
                    .filter(|line| line.starts_with('#'))
                {
                    out.push_str(comment);
                }
            } else {
                out.push_str(&property.raw);
            }
        }
        out
    }
}

fn sequence(values: impl IntoIterator<Item = String>) -> Value {
    Value::Sequence(values.into_iter().map(Value::String).collect())
}

/// Write managed keys first. Check the resulting header before handing it to
/// disk: an unmanaged key may now collide with a field, or refer to an anchor
/// a regenerated managed key no longer defines.
pub fn render(
    id: &BodyDocId,
    header: &Header,
    extra: &str,
    body: &str,
) -> Result<String, BrokenFrontmatter> {
    let mut fields = String::new();
    writeln!(fields, "{ID_KEY}: {}", yaml_string(id.as_str())).unwrap();
    for field in &header.fields {
        let key = yaml_string(&field.key);
        let value = field.emitted();
        if field.kind == FieldType::LongText
            && let Some(text) = value.as_str()
            && text.contains('\n')
            && text.chars().all(|c| {
                matches!(c, '\t' | '\n')
                    || (!c.is_control() && !matches!(c, '\u{2028}' | '\u{2029}'))
            })
        {
            write_block(&mut fields, &key, text);
            continue;
        }
        write_value(&mut fields, &key, &value);
    }
    if let Some(hosts) = header.hosts() {
        write_value(&mut fields, HOSTS_KEY, &hosts);
    }
    fields.push_str(extra);
    if !fields.ends_with('\n') {
        fields.push('\n');
    }
    read_properties(&fields)?;
    let mut result = format!("---\n{fields}---\n\n{body}");
    if !result.ends_with('\n') {
        result.push('\n');
    }
    Ok(result)
}

fn write_value(out: &mut String, key: &str, value: &Value) {
    match value {
        Value::Null => writeln!(out, "{key}:").unwrap(),
        Value::String(text) => writeln!(out, "{key}: {}", yaml_string(text)).unwrap(),
        Value::Number(n) => writeln!(out, "{key}: {n}").unwrap(),
        Value::Bool(b) => writeln!(out, "{key}: {b}").unwrap(),
        Value::Sequence(values) => {
            let strings: Vec<_> = values.iter().filter_map(Value::as_str).collect();
            let inline = serde_json::to_string(&strings).expect("list of strings");
            writeln!(out, "{key}: {inline}").unwrap();
        }
        _ => unreachable!("fields project only scalars and lists of strings"),
    }
}

fn write_block(out: &mut String, key: &str, value: &str) {
    let tail = value.bytes().rev().take_while(|&b| b == b'\n').count();
    let chomp = match tail {
        0 => "-",
        1 if !value.trim_matches('\n').is_empty() => "",
        _ => "+",
    };
    writeln!(out, "{key}: |2{chomp}").unwrap();
    for line in value.strip_suffix('\n').unwrap_or(value).split('\n') {
        writeln!(out, "  {line}").unwrap();
    }
}

fn yaml_string(value: &str) -> Cow<'_, str> {
    let plain = !value.is_empty()
        && value.trim() == value
        && !value
            .chars()
            .any(|c| c.is_control() || ":#{}[],\\\"'".contains(c))
        && !matches!(value, "---" | "...")
        && serde_yaml_ng::from_str::<Value>(value)
            .ok()
            .as_ref()
            .and_then(Value::as_str)
            == Some(value);
    if plain {
        Cow::Borrowed(value)
    } else {
        Cow::Owned(serde_json::to_string(value).expect("a string"))
    }
}

/// The optional BOM/CRLF normalization matches the editor's line breaks.
pub fn parse(raw: &str) -> Result<Parsed, BrokenFrontmatter> {
    let text = raw
        .strip_prefix('\u{FEFF}')
        .unwrap_or(raw)
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let Some(after_open) = text.strip_prefix("---\n") else {
        return Ok(Parsed {
            id: None,
            body: text,
            values: Mapping::new(),
            properties: Vec::new(),
        });
    };
    let mut at = 0;
    for line in after_open.split_inclusive('\n') {
        if matches!(line.trim_end_matches(['\n', ' ', '\t']), "---" | "...") {
            let (values, properties) = read_properties(&after_open[..at])?;
            let id = values
                .get(ID_KEY)
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(str::to_owned);
            let body = &after_open[at + line.len()..];
            let body = body.strip_prefix('\n').unwrap_or(body).to_owned();
            return Ok(Parsed {
                id,
                body,
                values,
                properties,
            });
        }
        at += line.len();
    }
    Err(BrokenFrontmatter)
}

struct Property {
    key: Option<String>,
    raw: String,
}

fn read_properties(raw: &str) -> Result<(Mapping, Vec<Property>), BrokenFrontmatter> {
    let values = match serde_yaml_ng::from_str::<Value>(raw).map_err(|_| BrokenFrontmatter)? {
        Value::Mapping(map) => map,
        Value::Null
            if raw
                .lines()
                .all(|line| line.trim().is_empty() || line.trim_start().starts_with('#')) =>
        {
            Mapping::new()
        }
        _ => return Err(BrokenFrontmatter),
    };
    let mut chunks = vec![Property {
        key: None,
        raw: String::new(),
    }];
    for line in raw.split_inclusive('\n') {
        if let Some(key) = property_key(line.trim_end_matches('\n')) {
            chunks.push(Property {
                key: Some(key),
                raw: String::new(),
            });
        }
        chunks.last_mut().expect("leading chunk").raw.push_str(line);
    }
    // Keep only the representation whose individual properties we can safely
    // preserve. Complex YAML keys and flow-style root maps have no line slot.
    if !chunks
        .iter()
        .filter_map(|p| p.key.as_deref())
        .eq(values.keys().map(|k| k.as_str().unwrap_or("")))
    {
        return Err(BrokenFrontmatter);
    }
    Ok((values, chunks))
}

fn property_key(line: &str) -> Option<String> {
    let first = line.chars().next()?;
    if first.is_whitespace() || first == '#' || line.starts_with("- ") {
        return None;
    }
    let quote = matches!(first, '\'' | '"').then_some(first);
    let mut chars = line.char_indices().peekable();
    if let Some(quote) = quote {
        chars.next();
        while let Some((_, c)) = chars.next() {
            if c == '\\' && quote == '"' {
                chars.next();
            } else if c == quote {
                if quote == '\'' && chars.peek().is_some_and(|&(_, next)| next == quote) {
                    chars.next();
                } else {
                    break;
                }
            }
        }
    }
    let (colon, _) = chars
        .find(|&(i, c)| c == ':' && line[i + 1..].chars().next().is_none_or(char::is_whitespace))?;
    match serde_yaml_ng::from_str::<Value>(line[..colon].trim_end()).ok()? {
        Value::String(key) => Some(key),
        _ => None,
    }
}
