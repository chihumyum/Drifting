//! Every string dr-i18n copies for the shell (and the dr-view-* crates it
//! hosts) is used by them, so orphans do not pile up again (the 0.1 client
//! had about 220; simplifications.md, section 3). A key that does not exist
//! already fails to compile; this checks the other direction.

use std::path::Path;

fn sources(dir: &Path, out: &mut String) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            sources(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push_str(&std::fs::read_to_string(&path).unwrap());
        }
    }
}

/// `use keys::a::b as x;` → x stands for the module `b`. Every one is
/// kept: two files may use the same alias for different modules.
fn aliases(source: &str) -> Vec<(String, String)> {
    let mut map = Vec::new();
    for line in source.lines() {
        let line = line.trim();
        let Some(rest) = line
            .strip_prefix("use keys::")
            .or_else(|| line.strip_prefix("use dr_i18n::keys::"))
        else {
            continue;
        };
        if let Some((path, alias)) = rest.trim_end_matches(';').split_once(" as ") {
            let module = path.rsplit("::").next().unwrap_or(path);
            map.push((alias.trim().to_owned(), module.to_owned()));
        }
    }
    map
}

fn rust_name(part: &str, upper: bool) -> String {
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
    if upper { out.to_ascii_uppercase() } else { out }
}

#[test]
fn every_copied_key_is_used() {
    let mut source = String::new();
    let here = Path::new(env!("CARGO_MANIFEST_DIR"));
    sources(&here.join("src"), &mut source);
    // The views the shell hosts (dr-view-*: the bookshelf, Project Home, …)
    // take their strings from the same list; so does the Markdown folder's
    // service (M40's notification lines).
    for entry in std::fs::read_dir(here.parent().unwrap()).unwrap() {
        let path = entry.unwrap().path();
        let view = path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with("dr-view-") || n == "dr-mirror");
        if view && path.join("src").is_dir() {
            sources(&path.join("src"), &mut source);
        }
    }
    let aliases = aliases(&source);
    let names = dr_i18n::Key::all()
        .map(|k| k.name())
        .chain(dr_i18n::PluralKey::all().map(|k| k.name()));
    let mut unused = Vec::new();
    for name in names {
        let parts: Vec<&str> = name.split('.').collect();
        let leaf = rust_name(parts[parts.len() - 1], true);
        let parent = rust_name(parts[parts.len() - 2], false);
        let direct = format!("{parent}::{leaf}");
        // A module named after a Rust keyword gets a trailing `_`
        // (`project_home::continue_`).
        let escaped = format!("{parent}_::{leaf}");
        let used = source.contains(&direct)
            || source.contains(&escaped)
            || aliases.iter().any(|(alias, module)| {
                *module == parent && source.contains(&format!("{alias}::{leaf}"))
            });
        // Plural keys the shell does not post yet are exercised by dr-i18n.
        let plural = dr_i18n::PluralKey::all().any(|k| k.name() == name);
        if !used && !plural {
            unused.push(name);
        }
    }
    assert!(
        unused.is_empty(),
        "copied but unused (drop them from crates/dr-i18n/keys.txt): {unused:?}"
    );
}
