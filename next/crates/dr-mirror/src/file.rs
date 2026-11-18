//! Frontmatter for one active prose module. The identity is independent of
//! the filename. YAML validates the whole header; unmanaged properties retain
//! their source text instead of being serialized again.

mod yaml;

use std::borrow::Cow;
use std::collections::HashMap;
use std::fmt::Write as _;

use dr_export::Labels;
use dr_model::id::{BodyDocId, ModuleId};
use dr_model::v3::{Entry, EntryTemplate, FieldType, FieldValue, ModuleKind};
use serde::{Deserialize, Serialize};

use self::yaml::{Mapping, Scalar, Value};
use crate::sync::Problem;

pub const ID_KEY: &str = "drifting-id";
const ALIASES_KEY: &str = "aliases";
const HOSTS_KEY: &str = "挂在";

#[derive(Debug, thiserror::Error)]
#[error("unreadable Markdown frontmatter")]
pub struct BrokenFrontmatter;

/// Why the App cannot write a file's frontmatter. The file is held.
#[derive(Debug, thiserror::Error)]
pub enum Unwritable {
    /// A property kept from the file has the key of a field added since.
    /// Keep the file until the property can be adopted or the collision
    /// goes away.
    #[error("the kept property {0:?} has the key of a field")]
    KeyCollision(String),
    /// The header would not read back, e.g. a kept alias whose anchor was on
    /// a value the App regenerates.
    #[error(transparent)]
    Broken(#[from] BrokenFrontmatter),
}

impl Unwritable {
    pub fn problem(&self) -> Problem {
        match self {
            Self::KeyCollision(_) => Problem::KeyCollision,
            Self::Broken(_) => Problem::Frontmatter,
        }
    }
}

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
            return self
                .reference
                .clone()
                .map_or_else(Value::null, Value::string);
        }
        match &self.value {
            FieldValue::Text(value) if self.kind == FieldType::Select => {
                Value::string(self.label(value))
            }
            FieldValue::List(values) if self.kind == FieldType::MultiSelect => {
                Value::strings(values.iter().map(|value| self.label(value).to_owned()))
            }
            FieldValue::Bool(value) => Value::bool(*value),
            FieldValue::Number(value) if value.is_finite() => Value::number(*value),
            FieldValue::Text(value) => Value::string(value),
            FieldValue::List(values) => Value::strings(values.iter().cloned()),
            FieldValue::Number(_) | FieldValue::Null => Value::null(),
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

    /// The file's value for this field, in the spellings other editors use:
    /// a number or a boolean written for text is that text, a single value
    /// is a one-item list, a quoted number is a number. `None`: it does not
    /// fit the field.
    fn decode(&self, value: &Value) -> Option<FieldValue> {
        use FieldType as T;
        use FieldValue as V;
        let text = matches!(self.kind, T::Text | T::LongText);
        if value.is_null() || (!text && value.as_str() == Some("")) {
            return Some(V::Null);
        }
        let items = || match value.as_seq() {
            Some(items) => items.iter().map(Value::text).collect::<Option<Vec<_>>>(),
            None => value.text().map(|one| vec![one]),
        };
        match self.kind {
            T::Text | T::LongText => Some(V::Text(value.text()?.to_owned())),
            T::Number => {
                let number = match value.scalar()? {
                    Scalar::Number(n) => n,
                    Scalar::Text(quoted) => match yaml::resolve(quoted.trim()) {
                        Scalar::Number(n) => n,
                        _ => return None,
                    },
                    _ => return None,
                };
                number.is_finite().then_some(V::Number(number))
            }
            T::Date => {
                let raw = value.text()?;
                if !raw.is_ascii() {
                    return None;
                }
                Some(V::Text(dr_model::Day::parse(raw)?.as_str().to_owned()))
            }
            T::Select => Some(V::Text(self.choice(value.text()?)?)),
            T::MultiSelect => Some(V::List(
                items()?
                    .into_iter()
                    .map(|item| self.choice(item))
                    .collect::<Option<_>>()?,
            )),
            T::Toggle => match value.scalar()? {
                Scalar::Bool(on) => Some(V::Bool(on)),
                Scalar::Text(quoted) => match yaml::resolve(quoted) {
                    Scalar::Bool(on) => Some(V::Bool(on)),
                    _ => None,
                },
                _ => None,
            },
            T::Aliases => Some(V::List(items()?.into_iter().map(str::to_owned).collect())),
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

    /// Adopt properties which were unmanaged when the current file was
    /// read. A read-only reference may already match its projected value,
    /// but the file cannot select a different referenced item.
    pub(crate) fn adopt_extra(
        &self,
        base: &Header,
        extra: &str,
    ) -> Result<Option<Adoption>, Unwritable> {
        if !extra
            .lines()
            .filter_map(property_key)
            .any(|key| self.owns(&key))
        {
            return Ok(None);
        }
        let (values, properties) = read_properties(extra)?;
        let mut edits = Vec::new();
        let mut fields = base.clone();
        for field in &self.fields {
            let Some(external) = values.get(field.key.as_str()) else {
                continue;
            };
            let matches_projection = external == &field.emitted();
            let value = if matches_projection {
                Some(field.value.clone())
            } else if field.read_only() {
                None
            } else {
                field.decode(external)
            };
            let value = value.ok_or_else(|| Unwritable::KeyCollision(field.key.clone()))?;
            if !field.read_only() {
                edits.push(FieldEdit {
                    slot: field.slot.clone(),
                    expected: field.value.clone(),
                    value: Some(value.clone()),
                });
            }
            fields
                .fields
                .retain(|old| old.slot != field.slot && old.key != field.key);
            let mut adopted = field.clone();
            adopted.value = value;
            fields.fields.push(adopted);
        }
        Ok(Some(Adoption {
            edits,
            extra: unmanaged_properties(&properties, self),
            fields,
        }))
    }

    fn hosts(&self) -> Option<Value> {
        (!self.hosts.is_empty()).then(|| Value::strings(self.hosts.iter().cloned()))
    }
}

pub(crate) struct Adoption {
    pub edits: Vec<FieldEdit>,
    pub extra: String,
    pub fields: Header,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FieldEdit {
    pub slot: FieldSlot,
    pub expected: FieldValue,
    /// `None`: the file's value does not fit the field. Nothing is written
    /// and the slot is refused, like one whose guard failed.
    pub value: Option<FieldValue>,
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
    /// Only keys present in the file can change a stored field. A changed
    /// value that does not fit its field is an edit without a value, so the
    /// file is kept aside before the App's value is written back. Invalid
    /// YAML does not get here.
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
            } else if let Some(external) = external.filter(|external| *external != &emitted) {
                let value = field.decode(external);
                if value.as_ref() != Some(&field.value) {
                    edits.fields.push(FieldEdit {
                        slot: field.slot.clone(),
                        expected: field.value.clone(),
                        value,
                    });
                }
            }
        }
        edits
    }

    pub fn extra(&self, header: &Header) -> String {
        unmanaged_properties(&self.properties, header)
    }
}

fn unmanaged_properties(properties: &[Property], header: &Header) -> String {
    let mut out = String::new();
    for property in properties {
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

/// Write managed keys first. Check the resulting header before handing it to
/// disk: an unmanaged key may now collide with a field, or refer to an anchor
/// a regenerated managed key no longer defines.
pub fn render(
    id: &BodyDocId,
    header: &Header,
    extra: &str,
    body: &str,
) -> Result<String, Unwritable> {
    if let Some(key) = extra
        .lines()
        .filter_map(property_key)
        .find(|key| header.owns(key))
    {
        return Err(Unwritable::KeyCollision(key));
    }
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

/// Fields project only scalars and lists of strings (`Field::emitted`).
fn write_value(out: &mut String, key: &str, value: &Value) {
    match value {
        Value::Seq(values) => {
            let strings: Vec<_> = values.iter().filter_map(Value::as_str).collect();
            let inline = serde_json::to_string(&strings).expect("list of strings");
            writeln!(out, "{key}: {inline}").unwrap();
        }
        Value::Scalar { text, typed: false } => {
            writeln!(out, "{key}: {}", yaml_string(text)).unwrap()
        }
        _ if value.is_null() => writeln!(out, "{key}:").unwrap(),
        Value::Scalar { text, typed: true } => writeln!(out, "{key}: {text}").unwrap(),
        Value::Map(_) => unreachable!("fields project no mappings"),
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
        && yaml::parse(value)
            .ok()
            .flatten()
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
            values: Mapping::default(),
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
    let values = match yaml::parse(raw).map_err(|_| BrokenFrontmatter)? {
        Some(Value::Map(map)) => map,
        None => Mapping::default(),
        Some(value)
            if value.is_null()
                && raw
                    .lines()
                    .all(|line| line.trim().is_empty() || line.trim_start().starts_with('#')) =>
        {
            Mapping::default()
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
        .eq(values.keys().map(|k| k.unwrap_or("")))
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
    yaml::parse(line[..colon].trim_end())
        .ok()??
        .as_str()
        .map(str::to_owned)
}
