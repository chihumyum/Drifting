//! The copies in `locales/` still match the 0.1 client's locales they were
//! taken from (until stage 7 deletes those and the copies become the source).
//! The new client's own strings (`own/`) are merged in by the same script
//! and are not the 0.1 client's, so they are left out here.

use std::path::PathBuf;

use serde_json::Value;

fn lookup<'a>(tree: &'a Value, path: &str) -> Option<&'a Value> {
    path.split('.').try_fold(tree, |node, part| node.get(part))
}

fn walk(tree: &Value, prefix: String, out: &mut Vec<(String, String)>) {
    if let Value::Object(map) = tree {
        for (key, child) in map {
            let path = if prefix.is_empty() {
                key.clone()
            } else {
                format!("{prefix}.{key}")
            };
            match child {
                Value::String(text) => out.push((path, text.clone())),
                other => walk(other, path, out),
            }
        }
    }
}

#[test]
fn the_copies_match_the_0_1_locales() {
    let crate_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let source = crate_dir.join("../../../src/renderer/locales");
    if !source.join("en.json").exists() {
        eprintln!("the 0.1 locales are gone; the copies are the source now");
        return;
    }
    let mut checked = 0;
    for folder in ["", "windows/"] {
        for locale in [
            "zh-CN", "zh-TW", "en", "ja", "ko", "es", "de", "fr", "pt-BR",
        ] {
            let read = |dir: &PathBuf| -> Value {
                let file = dir.join(format!("{folder}{locale}.json"));
                serde_json::from_str(&std::fs::read_to_string(&file).unwrap_or("{}".into()))
                    .unwrap()
            };
            let copy = read(&crate_dir.join("locales"));
            let original = read(&source);
            let own = if folder.is_empty() {
                read(&crate_dir.join("own"))
            } else {
                Value::Null
            };
            let mut entries = Vec::new();
            walk(&copy, String::new(), &mut entries);
            for (path, text) in entries {
                if lookup(&own, &path).is_some() {
                    continue;
                }
                let found = lookup(&original, &path).and_then(Value::as_str);
                assert_eq!(
                    found,
                    Some(text.as_str()),
                    "{folder}{locale}.json {path} changed in the 0.1 client; \
                     run python3 crates/dr-i18n/script/sync-locales.py"
                );
                checked += 1;
            }
        }
    }
    assert!(checked > 900, "only {checked} strings compared");
}
