//! The one validator and the canonical writer of [`ModuleValue`]
//! (`custom-modules.md` §6, §12).

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use serde::Deserialize;

use super::{
    Block, BlockKind, BoxDir, BoxNode, Column, INK_LEVELS, MAX_BLOCK_ID_LEN, MAX_GRID_COLUMNS,
    MAX_LOOK_TEXT_CHARS, MAX_MODULE_AGENT_CHARS, MAX_MODULE_BLOCKS, MAX_MODULE_BYTES,
    MAX_MODULE_LIST_DEPTH, MAX_MODULE_LOOK_NODES, MAX_SUFFIX_CHARS, MAX_VALUE_LINES, MODULE_FORMAT,
    MODULE_FORMAT_VERSION, MODULE_MARKS, ModuleCredit, ModuleValue, Node, RADIUS_STEPS,
    SPACING_STEPS, SampleValue, Show, is_width_step,
};
use crate::time::Day;

/// Why a module was refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ModuleError {
    /// More than [`MAX_MODULE_BYTES`].
    TooLarge { bytes: usize, max: usize },
    /// Not JSON, or a key, kind or value the closed format does not have.
    MalformedJson(String),
    /// `format` is not `drifting.module`.
    InvalidFormat(String),
    /// Made by a newer build: `formatVersion` above [`MODULE_FORMAT_VERSION`].
    UnsupportedFormatVersion { found: i64, supported: i64 },
    /// `formatVersion` below 1.
    InvalidFormatVersion(i64),
    /// A rule of §12: a limit, a step, a reference, a sample value.
    Invalid(String),
}

impl fmt::Display for ModuleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooLarge { bytes, max } => {
                write!(f, "module is {bytes} bytes, more than the {max}-byte limit")
            }
            Self::MalformedJson(msg) => write!(f, "invalid module JSON: {msg}"),
            Self::InvalidFormat(found) => {
                write!(f, "expected format {MODULE_FORMAT:?}, found {found:?}")
            }
            Self::UnsupportedFormatVersion { found, supported } => write!(
                f,
                "module uses newer formatVersion {found}; this build reads up to version {supported}"
            ),
            Self::InvalidFormatVersion(found) => {
                write!(f, "invalid module formatVersion {found}")
            }
            Self::Invalid(msg) => f.write_str(msg),
        }
    }
}

impl std::error::Error for ModuleError {}

fn inv<T>(msg: impl Into<String>) -> Result<T, ModuleError> {
    Err(ModuleError::Invalid(msg.into()))
}

fn one_line(s: &str) -> bool {
    !s.chars().any(char::is_control)
}

fn many_lines(s: &str) -> bool {
    !s.chars()
        .any(|c| c.is_control() && c != '\n' && c != '\r' && c != '\t')
}

fn named(s: &str) -> bool {
    !s.trim().is_empty() && one_line(s)
}

/// Whether `s` is a block id: 1 to [`MAX_BLOCK_ID_LEN`] ASCII letters,
/// digits, `_` or `-`, and not `id` (a list item keeps its own id under
/// that key, beside its blocks' values).
pub fn is_block_id(s: &str) -> bool {
    !s.is_empty()
        && s != "id"
        && s.len() <= MAX_BLOCK_ID_LEN
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// A uuid in any spelling: what the ids of entries, templates, views, files,
/// books and devices look like. A sample's entry words may not be one.
fn looks_like_an_id(s: &str) -> bool {
    uuid::Uuid::try_parse(s.trim()).is_ok()
}

/// Write `value` the one way: UTF-8, fixed key order, two-space indent, one
/// `\n` at the end; refused past [`MAX_MODULE_BYTES`].
pub fn to_canonical_json(value: &ModuleValue) -> Result<String, ModuleError> {
    let mut json = serde_json::to_string_pretty(value)
        .map_err(|e| ModuleError::MalformedJson(e.to_string()))?;
    json.push('\n');
    if json.len() > MAX_MODULE_BYTES {
        return Err(ModuleError::TooLarge {
            bytes: json.len(),
            max: MAX_MODULE_BYTES,
        });
    }
    Ok(json)
}

#[derive(Deserialize)]
struct Header {
    #[serde(default)]
    format: Option<serde_json::Value>,
    #[serde(rename = "formatVersion", default)]
    format_version: Option<serde_json::Value>,
}

/// The name a module's JSON gives, read as leniently as possible: for a copy
/// that does not pass the validator (a newer build's, a damaged one), which
/// an entry page shows as an empty placeholder with only the module's name
/// (§16 item 6).
pub fn module_name_hint(raw: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct NameOnly {
        #[serde(default)]
        name: Option<serde_json::Value>,
    }
    let n: NameOnly = serde_json::from_str(raw).ok()?;
    match n.name? {
        serde_json::Value::String(s) => {
            let line: String = s.chars().filter(|c| !c.is_control()).collect();
            let line = line.trim();
            (!line.is_empty()).then(|| line.to_owned())
        }
        _ => None,
    }
}

/// Parse raw JSON and validate it. The size and the `(format,
/// formatVersion)` header are read first, so a newer module always says it
/// is newer even when its version adds keys this build does not know.
pub fn parse_module_json(raw: &str) -> Result<ModuleValue, ModuleError> {
    if raw.len() > MAX_MODULE_BYTES {
        return Err(ModuleError::TooLarge {
            bytes: raw.len(),
            max: MAX_MODULE_BYTES,
        });
    }
    if let Ok(header) = serde_json::from_str::<Header>(raw) {
        match header.format {
            Some(serde_json::Value::String(f)) if f != MODULE_FORMAT => {
                return Err(ModuleError::InvalidFormat(f));
            }
            Some(serde_json::Value::String(_)) | None => {}
            Some(other) => return Err(ModuleError::InvalidFormat(other.to_string())),
        }
        if let Some(v) = header.format_version.as_ref().and_then(|v| v.as_i64()) {
            if v > MODULE_FORMAT_VERSION {
                return Err(ModuleError::UnsupportedFormatVersion {
                    found: v,
                    supported: MODULE_FORMAT_VERSION,
                });
            }
            if v < 1 {
                return Err(ModuleError::InvalidFormatVersion(v));
            }
        }
    }
    let value: ModuleValue =
        serde_json::from_str(raw).map_err(|e| ModuleError::MalformedJson(e.to_string()))?;
    validate_module_value(&value)?;
    Ok(value)
}

/// Every rule of §6 and §12 on `value`.
pub fn validate_module_value(value: &ModuleValue) -> Result<(), ModuleError> {
    if value.format != MODULE_FORMAT {
        return Err(ModuleError::InvalidFormat(value.format.clone()));
    }
    if value.format_version > MODULE_FORMAT_VERSION {
        return Err(ModuleError::UnsupportedFormatVersion {
            found: value.format_version,
            supported: MODULE_FORMAT_VERSION,
        });
    }
    if value.format_version < 1 {
        return Err(ModuleError::InvalidFormatVersion(value.format_version));
    }
    if !named(&value.name) {
        return inv("a module needs a name on one line");
    }
    if !one_line(&value.locale) {
        return inv("the locale is one line");
    }
    if let Some(credit) = &value.credit {
        check_credit(credit)?;
    }

    // Blocks: ids, names, options, nesting, limits.
    let mut ids = BTreeSet::new();
    let mut count = 0usize;
    check_blocks(&value.blocks, 0, &mut ids, &mut count)?;
    if count > MAX_MODULE_BLOCKS {
        return inv(format!(
            "the module has {count} blocks (limit {MAX_MODULE_BLOCKS})"
        ));
    }

    // Look: three trees, every node drawable.
    let nodes: usize = value.look.trees().map(|(_, n)| n.count()).sum();
    if nodes > MAX_MODULE_LOOK_NODES {
        return inv(format!(
            "the look has {nodes} nodes (limit {MAX_MODULE_LOOK_NODES})"
        ));
    }
    let scopes: BTreeMap<&str, (&Block, Option<&str>)> = value
        .blocks_with_scope()
        .into_iter()
        .map(|(b, s)| (b.id.as_str(), (b, s)))
        .collect();
    for (_, tree) in value.look.trees() {
        check_node(tree, &scopes, &mut vec![None])?;
    }

    // Words for the Agent.
    let agent = &value.agent;
    if !one_line(&agent.name) || !many_lines(&agent.description) || !many_lines(&agent.instructions)
    {
        return inv("the words for the Agent hold control characters");
    }
    for (id, sentence) in &agent.blocks {
        if !scopes.contains_key(id.as_str()) {
            return inv(format!(
                "the words for the Agent name block {id:?}, which the module does not have"
            ));
        }
        if !one_line(sentence) {
            return inv(format!("the words for block {id:?} are one line"));
        }
    }
    let chars = agent.chars();
    if chars > MAX_MODULE_AGENT_CHARS {
        return inv(format!(
            "the words for the Agent are {chars} characters (limit {MAX_MODULE_AGENT_CHARS})"
        ));
    }

    // The sample.
    check_sample(value, None, &value.sample)?;

    // The whole, written out.
    to_canonical_json(value)?;
    Ok(())
}

fn check_credit(credit: &ModuleCredit) -> Result<(), ModuleError> {
    if credit.author.is_empty() || !named(&credit.author) {
        return inv("credit.author is a name on one line");
    }
    Ok(())
}

fn check_blocks<'a>(
    blocks: &'a [Block],
    list_depth: usize,
    ids: &mut BTreeSet<&'a str>,
    count: &mut usize,
) -> Result<(), ModuleError> {
    for b in blocks {
        *count += 1;
        if *count > MAX_MODULE_BLOCKS {
            return inv(format!(
                "the module has more than {MAX_MODULE_BLOCKS} blocks"
            ));
        }
        if !is_block_id(&b.id) {
            return inv(format!(
                "block id {:?} is 1 to {MAX_BLOCK_ID_LEN} letters, digits, _ or -",
                b.id
            ));
        }
        if !ids.insert(b.id.as_str()) {
            return inv(format!("two blocks have id {:?}", b.id));
        }
        if !named(&b.name) {
            return inv(format!("block {:?} needs a name on one line", b.id));
        }
        if b.kind.has_options() {
            if b.options.is_empty() {
                return inv(format!("block {:?} needs options", b.id));
            }
            let mut seen = BTreeSet::new();
            for o in &b.options {
                if !named(o) {
                    return inv(format!(
                        "an option of block {:?} is empty or not one line",
                        b.id
                    ));
                }
                if !seen.insert(o.as_str()) {
                    return inv(format!("block {:?} has option {o:?} twice", b.id));
                }
            }
        } else if !b.options.is_empty() {
            return inv(format!(
                "only a select or multi_select block has options ({:?})",
                b.id
            ));
        }
        match b.kind {
            BlockKind::Group => check_blocks(&b.blocks, list_depth, ids, count)?,
            BlockKind::List => {
                if list_depth + 1 > MAX_MODULE_LIST_DEPTH {
                    return inv(format!(
                        "lists are nested at most {MAX_MODULE_LIST_DEPTH} deep ({:?})",
                        b.id
                    ));
                }
                check_blocks(&b.blocks, list_depth + 1, ids, count)?;
            }
            _ if !b.blocks.is_empty() => {
                return inv(format!("only a group or a list holds blocks ({:?})", b.id));
            }
            _ => {}
        }
    }
    Ok(())
}

type Scopes<'a> = BTreeMap<&'a str, (&'a Block, Option<&'a str>)>;

fn step(name: &str, v: Option<u8>, steps: &[u8]) -> Result<(), ModuleError> {
    match v {
        Some(v) if !steps.contains(&v) => inv(format!("{name} {v} is not one of {steps:?}")),
        _ => Ok(()),
    }
}

fn ink(v: Option<u8>) -> Result<(), ModuleError> {
    match v {
        Some(v) if !INK_LEVELS.contains(&v) => inv(format!("ink {v} is not 1 to 4")),
        _ => Ok(()),
    }
}

fn check_box<'a>(
    b: &BoxNode,
    scopes: &Scopes<'a>,
    chain: &mut Vec<Option<&'a str>>,
) -> Result<(), ModuleError> {
    step("gap", b.gap, &SPACING_STEPS)?;
    step("pad", b.pad, &SPACING_STEPS)?;
    step("radius", b.radius, &RADIUS_STEPS)?;
    if let Some(max) = b.max
        && !is_width_step(max)
    {
        return inv(format!(
            "max {max} is not a width step (48 to 320, every 8)"
        ));
    }
    match b.dir {
        BoxDir::Grid => {
            if b.cols.is_empty() || b.cols.len() > MAX_GRID_COLUMNS {
                return inv(format!("a grid has 1 to {MAX_GRID_COLUMNS} columns"));
            }
            for c in &b.cols {
                if let Column::Fixed(w) = c
                    && !is_width_step(*w)
                {
                    return inv(format!(
                        "column width {w} is not a width step (48 to 320, every 8)"
                    ));
                }
            }
        }
        _ if !b.cols.is_empty() => return inv("only a grid box has columns"),
        _ => {}
    }
    for kid in &b.kids {
        check_node(kid, scopes, chain)?;
    }
    Ok(())
}

fn check_node<'a>(
    node: &Node,
    scopes: &Scopes<'a>,
    chain: &mut Vec<Option<&'a str>>,
) -> Result<(), ModuleError> {
    match node {
        Node::Box(b) => check_box(b, scopes, chain),
        Node::Each(e) => {
            step("gap", e.gap, &SPACING_STEPS)?;
            let Some((block, scope)) = scopes.get(e.list.as_str()) else {
                return inv(format!(
                    "each names block {:?}, which the module does not have",
                    e.list
                ));
            };
            if block.kind != BlockKind::List {
                return inv(format!("each names {:?}, which is not a list", e.list));
            }
            if !chain.contains(scope) {
                return inv(format!(
                    "each over {:?} is drawn outside the items that keep it",
                    e.list
                ));
            }
            chain.push(Some(block.id.as_str()));
            let r = check_box(&e.item, scopes, chain);
            chain.pop();
            r
        }
        Node::Value(v) => {
            let Some((block, scope)) = scopes.get(v.block.as_str()) else {
                return inv(format!(
                    "a value names block {:?}, which the module does not have",
                    v.block
                ));
            };
            if block.kind == BlockKind::Group {
                return inv(format!("a group ({:?}) has no value to draw", v.block));
            }
            if !chain.contains(scope) {
                return inv(format!(
                    "the value of {:?} is drawn outside the items that keep it",
                    v.block
                ));
            }
            let fits = match (v.show, block.kind) {
                (None, _) => true,
                (Some(Show::Count), BlockKind::List) => true,
                (Some(Show::Count), _) | (_, BlockKind::List) => false,
                (Some(Show::Dots), k) => k == BlockKind::Number,
                (Some(Show::Mark), k) => k == BlockKind::Select,
                (Some(Show::Text), k) => k != BlockKind::Image,
            };
            if !fits {
                return inv(format!(
                    "a {} block ({:?}) is not shown as {}",
                    block.kind.as_str(),
                    v.block,
                    v.show.map(Show::as_str).unwrap_or("")
                ));
            }
            ink(v.ink)?;
            if let Some(lines) = v.lines
                && !(1..=MAX_VALUE_LINES).contains(&lines)
            {
                return inv(format!("lines is 1 to {MAX_VALUE_LINES}"));
            }
            if let Some(suffix) = &v.suffix
                && (suffix.is_empty()
                    || !one_line(suffix)
                    || suffix.chars().count() > MAX_SUFFIX_CHARS)
            {
                return inv(format!(
                    "a suffix is one line of 1 to {MAX_SUFFIX_CHARS} characters"
                ));
            }
            Ok(())
        }
        Node::Text(t) => {
            if t.text.trim().is_empty()
                || !one_line(&t.text)
                || t.text.chars().count() > MAX_LOOK_TEXT_CHARS
            {
                return inv(format!(
                    "fixed text is one line of 1 to {MAX_LOOK_TEXT_CHARS} characters"
                ));
            }
            ink(t.ink)
        }
        Node::Mark(m) => {
            if !MODULE_MARKS.contains(&m.mark.as_str()) {
                return inv(format!("{:?} is not one of the sand marks", m.mark));
            }
            Ok(())
        }
    }
}

fn check_sample(
    value: &ModuleValue,
    scope: Option<&str>,
    sample: &BTreeMap<String, SampleValue>,
) -> Result<(), ModuleError> {
    let blocks = value.scope_blocks(scope);
    for (id, v) in sample {
        let Some(block) = blocks.iter().find(|b| b.id == *id) else {
            return inv(format!(
                "the sample has a value for {id:?}, which this part of the module does not keep"
            ));
        };
        let bad = || {
            inv(format!(
                "the sample value of {id:?} is not a {}",
                block.kind.as_str()
            ))
        };
        match (block.kind, v) {
            (BlockKind::Text, SampleValue::Text(s)) if one_line(s) => {}
            (BlockKind::LongText, SampleValue::Text(s)) if many_lines(s) => {}
            (BlockKind::Number, SampleValue::Number(n)) if n.is_finite() => {}
            (BlockKind::Date, SampleValue::Text(s)) if Day::parse(s).is_some() => {}
            (BlockKind::Select, SampleValue::Text(s)) if block.options.contains(s) => {}
            (BlockKind::MultiSelect, SampleValue::Texts(xs)) => {
                let mut seen = BTreeSet::new();
                if !xs
                    .iter()
                    .all(|x| block.options.contains(x) && seen.insert(x.as_str()))
                {
                    return bad();
                }
            }
            (BlockKind::Toggle, SampleValue::Bool(_)) => {}
            (BlockKind::Entry, SampleValue::Texts(xs)) => {
                for x in xs {
                    if !named(x) {
                        return bad();
                    }
                    if looks_like_an_id(x) {
                        return inv(format!(
                            "the sample of {id:?} names an entry by id; a sample entry is a few words"
                        ));
                    }
                }
            }
            (BlockKind::Image, _) => {
                return inv(format!(
                    "the sample has an image for {id:?}; a module carries no files"
                ));
            }
            (BlockKind::List, SampleValue::Texts(xs)) if xs.is_empty() => {}
            (BlockKind::List, SampleValue::Items(items)) => {
                for item in items {
                    check_sample(value, Some(block.id.as_str()), item)?;
                }
            }
            _ => return bad(),
        }
    }
    Ok(())
}
