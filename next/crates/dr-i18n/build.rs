//! Turns `locales/*.json` into Rust: one constant per key (so a key that
//! does not exist does not compile) and one static table per language.
//!
//! The build fails when a language lacks a key, when a translation's
//! `{{placeholders}}` differ from English, or when two keys would get the
//! same Rust name. These are the checks docs/rust-rewrite/simplifications.md
//! (section 6, rule 8) asks for.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use serde_json::Value;

/// The order of `Locale::ALL` in `src/lib.rs`.
const LOCALES: [&str; 9] = [
    "zh-CN", "zh-TW", "en", "ja", "ko", "es", "de", "fr", "pt-BR",
];
const EN: usize = 2;
/// i18next's plural suffixes, in `PluralForm` order.
const FORMS: [&str; 6] = ["zero", "one", "two", "few", "many", "other"];

fn main() {
    let dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    println!("cargo:rerun-if-changed=locales");
    println!("cargo:rerun-if-changed=build.rs");

    let mut base: Vec<BTreeMap<String, String>> = LOCALES
        .iter()
        .map(|l| read(&dir.join("locales").join(format!("{l}.json")), true))
        .collect();
    let windows: Vec<BTreeMap<String, String>> = LOCALES
        .iter()
        .map(|l| {
            read(
                &dir.join("locales/windows").join(format!("{l}.json")),
                false,
            )
        })
        .collect();

    // Group English keys into plain keys and plural keys (`x_one`, `x_other`).
    // A suffixed key whose stem is itself a key is plain: the old data has
    // `settings.editor.indent` next to `indent_one` ("1 char") and `indent_two`.
    let english = &base[EN];
    let is_plural_form = |key: &str| {
        split_plural(key).is_some_and(|(stem, _)| {
            !english.contains_key(stem) && english.contains_key(&format!("{stem}_other"))
        })
    };
    let mut plain: BTreeSet<String> = BTreeSet::new();
    let mut plural: BTreeSet<String> = BTreeSet::new();
    for key in english.keys() {
        match split_plural(key) {
            Some((stem, _)) if is_plural_form(key) => {
                plural.insert(stem.to_owned());
            }
            _ => {
                plain.insert(key.clone());
            }
        }
    }
    // A language with only the plain key where English has plural forms
    // (zh-CN's `projectPicker.desk.chaptersUnit`) uses it for every count,
    // as i18next falls back to the plain key: it is that language's `_other`.
    for table in base.iter_mut() {
        for stem in &plural {
            let other = format!("{stem}_other");
            if !table.contains_key(&other)
                && let Some(text) = table.remove(stem)
            {
                table.insert(other, text);
            }
        }
    }
    let mut errors = Vec::new();

    // Every language has every key, with English's placeholders.
    for (i, locale) in LOCALES.iter().enumerate() {
        for key in &plain {
            match base[i].get(key) {
                None => errors.push(format!("{locale}.json lacks {key}")),
                Some(text) => compare(locale, key, text, &base[EN][key], &mut errors),
            }
            if let Some(text) = windows[i].get(key) {
                compare(
                    &format!("windows/{locale}"),
                    key,
                    text,
                    &base[EN][key],
                    &mut errors,
                );
            }
        }
        for stem in &plural {
            let other = format!("{stem}_other");
            match base[i].get(&other) {
                None => errors.push(format!("{locale}.json lacks {other}")),
                Some(text) => compare(locale, &other, text, &base[EN][&other], &mut errors),
            }
            let allowed = placeholders(&base[EN][&other]);
            for form in FORMS {
                let key = format!("{stem}_{form}");
                if let Some(text) = base[i].get(&key) {
                    let extra: Vec<_> = placeholders(text).difference(&allowed).cloned().collect();
                    if !extra.is_empty() {
                        errors.push(format!(
                            "{locale}.json {key} has unknown placeholders {extra:?}"
                        ));
                    }
                }
            }
        }
        for key in base[i].keys() {
            let known = plain.contains(key)
                || split_plural(key)
                    .is_some_and(|(stem, _)| plural.contains(stem) && !plain.contains(stem));
            if !known {
                errors.push(format!("{locale}.json has {key}, which en.json lacks"));
            }
        }
        for key in windows[i].keys() {
            if !plain.contains(key) {
                errors.push(format!(
                    "windows/{locale}.json overrides {key}, which is not a plain key"
                ));
            }
        }
    }
    if !errors.is_empty() {
        panic!(
            "dr-i18n: the locales do not check out:\n  {}",
            errors.join("\n  ")
        );
    }

    let plain: Vec<String> = plain.into_iter().collect();
    let plural: Vec<String> = plural.into_iter().collect();
    let mut out = String::new();
    out.push_str("// Generated by build.rs from locales/*.json. Do not edit.\n\n");

    // The key constants, nested like the JSON.
    let mut tree = Node::default();
    for (index, key) in plain.iter().enumerate() {
        tree.insert(key, Leaf::Plain(index), &mut errors);
    }
    for (index, key) in plural.iter().enumerate() {
        tree.insert(key, Leaf::Plural(index), &mut errors);
    }
    if !errors.is_empty() {
        panic!("dr-i18n: key names collide:\n  {}", errors.join("\n  "));
    }
    out.push_str("/// Every string key, nested like the JSON (`leftSidebar.tabs.chapters` is\n");
    out.push_str("/// `keys::left_sidebar::tabs::CHAPTERS`).\n");
    out.push_str("#[allow(dead_code)]\npub mod keys {\n");
    tree.write(&mut out, 1);
    out.push_str("}\n\n");

    writeln!(
        out,
        "pub(crate) const PLAIN_COUNT: usize = {};",
        plain.len()
    )
    .unwrap();
    writeln!(
        out,
        "pub(crate) const PLURAL_COUNT: usize = {};",
        plural.len()
    )
    .unwrap();
    out.push_str("pub(crate) static PLAIN_NAMES: [&str; PLAIN_COUNT] = [\n");
    for key in &plain {
        writeln!(out, "    {key:?},").unwrap();
    }
    out.push_str("];\npub(crate) static PLURAL_NAMES: [&str; PLURAL_COUNT] = [\n");
    for key in &plural {
        writeln!(out, "    {key:?},").unwrap();
    }
    out.push_str("];\n\n");

    out.push_str("pub(crate) static PLAIN: [[&str; PLAIN_COUNT]; 9] = [\n");
    for table in &base {
        out.push_str("    [\n");
        for key in &plain {
            writeln!(out, "        {:?},", table[key]).unwrap();
        }
        out.push_str("    ],\n");
    }
    out.push_str("];\n\n");

    out.push_str("pub(crate) static WINDOWS: [[Option<&str>; PLAIN_COUNT]; 9] = [\n");
    for table in &windows {
        out.push_str("    [\n");
        for key in &plain {
            match table.get(key) {
                Some(text) => writeln!(out, "        Some({text:?}),").unwrap(),
                None => out.push_str("        None,\n"),
            }
        }
        out.push_str("    ],\n");
    }
    out.push_str("];\n\n");

    out.push_str("pub(crate) static PLURAL: [[[Option<&str>; 6]; PLURAL_COUNT]; 9] = [\n");
    for table in &base {
        out.push_str("    [\n");
        for stem in &plural {
            out.push_str("        [");
            for form in FORMS {
                match table.get(&format!("{stem}_{form}")) {
                    Some(text) => write!(out, "Some({text:?}), ").unwrap(),
                    None => out.push_str("None, "),
                }
            }
            out.push_str("],\n");
        }
        out.push_str("    ],\n");
    }
    out.push_str("];\n");

    let target = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("strings.rs");
    std::fs::write(target, out).unwrap();
}

fn read(path: &Path, required: bool) -> BTreeMap<String, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(_) if !required => return BTreeMap::new(),
        Err(error) => panic!("dr-i18n: cannot read {}: {error}", path.display()),
    };
    let value: Value = serde_json::from_str(&text)
        .unwrap_or_else(|error| panic!("dr-i18n: {} is not JSON: {error}", path.display()));
    let mut flat = BTreeMap::new();
    flatten(&value, String::new(), &mut flat, path);
    flat
}

fn flatten(value: &Value, prefix: String, out: &mut BTreeMap<String, String>, path: &Path) {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                let next = if prefix.is_empty() {
                    key.clone()
                } else {
                    format!("{prefix}.{key}")
                };
                flatten(child, next, out, path);
            }
        }
        Value::String(text) => {
            out.insert(prefix, text.clone());
        }
        other => panic!(
            "dr-i18n: {} has a non-string value at {prefix}: {other}",
            path.display()
        ),
    }
}

/// `x_one` → (`x`, one). Only i18next's suffixes count.
fn split_plural(key: &str) -> Option<(&str, &str)> {
    let (stem, form) = key.rsplit_once('_')?;
    FORMS.contains(&form).then_some((stem, form))
}

fn placeholders(text: &str) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else { break };
        found.insert(after[..end].trim().to_owned());
        rest = &after[end + 2..];
    }
    found
}

fn compare(locale: &str, key: &str, text: &str, english: &str, errors: &mut Vec<String>) {
    let (have, want) = (placeholders(text), placeholders(english));
    if have != want {
        errors.push(format!(
            "{locale}.json {key} has placeholders {have:?}, en has {want:?}"
        ));
    }
}

enum Leaf {
    Plain(usize),
    Plural(usize),
}

#[derive(Default)]
struct Node {
    leaves: BTreeMap<String, (String, Leaf)>,
    children: BTreeMap<String, (String, Node)>,
}

impl Node {
    fn insert(&mut self, key: &str, leaf: Leaf, errors: &mut Vec<String>) {
        let parts: Vec<&str> = key.split('.').collect();
        let mut node = self;
        for part in &parts[..parts.len() - 1] {
            let name = module_name(part);
            let entry = node
                .children
                .entry(name.clone())
                .or_insert_with(|| ((*part).to_owned(), Node::default()));
            if entry.0 != *part {
                errors.push(format!("{part} and {} both become `{name}`", entry.0));
            }
            node = &mut entry.1;
        }
        let last = parts[parts.len() - 1];
        let name = const_name(last);
        if let Some((other, _)) = node.leaves.get(&name) {
            errors.push(format!("{key}: {last} and {other} both become `{name}`"));
        }
        node.leaves.insert(name, (key.to_owned(), leaf));
    }

    fn write(&self, out: &mut String, depth: usize) {
        let pad = "    ".repeat(depth);
        for (name, (key, leaf)) in &self.leaves {
            writeln!(out, "{pad}/// `{key}`").unwrap();
            match leaf {
                Leaf::Plain(i) => {
                    writeln!(out, "{pad}pub const {name}: crate::Key = crate::Key({i});").unwrap()
                }
                Leaf::Plural(i) => writeln!(
                    out,
                    "{pad}pub const {name}: crate::PluralKey = crate::PluralKey({i});"
                )
                .unwrap(),
            }
        }
        for (name, (_, child)) in &self.children {
            writeln!(out, "{pad}pub mod {name} {{").unwrap();
            child.write(out, depth + 1);
            writeln!(out, "{pad}}}").unwrap();
        }
    }
}

/// `leftSidebar` → `left_sidebar`, `library_item` stays.
fn snake(part: &str) -> String {
    let mut out = String::new();
    let mut prev_lower = false;
    for c in part.chars() {
        if c.is_ascii_uppercase() {
            if prev_lower {
                out.push('_');
            }
            out.push(c.to_ascii_lowercase());
            prev_lower = false;
        } else if c.is_ascii_alphanumeric() {
            out.push(c);
            prev_lower = c.is_ascii_lowercase() || c.is_ascii_digit();
        } else {
            out.push('_');
            prev_lower = false;
        }
    }
    if out.starts_with(|c: char| c.is_ascii_digit()) {
        out.insert(0, '_');
    }
    out
}

fn module_name(part: &str) -> String {
    let name = snake(part);
    // Rust's keywords (strict and reserved) cannot name a module.
    const KEYWORDS: [&str; 49] = [
        "abstract", "as", "async", "await", "become", "box", "break", "const", "continue", "crate",
        "do", "dyn", "else", "enum", "extern", "false", "final", "fn", "for", "gen", "if", "impl",
        "in", "let", "loop", "macro", "match", "mod", "move", "mut", "override", "priv", "pub",
        "ref", "return", "self", "static", "struct", "super", "trait", "true", "try", "type",
        "typeof", "unsafe", "unsized", "use", "virtual", "where",
    ];
    if KEYWORDS.contains(&name.as_str()) {
        format!("{name}_")
    } else {
        name
    }
}

fn const_name(part: &str) -> String {
    snake(part).to_ascii_uppercase()
}
