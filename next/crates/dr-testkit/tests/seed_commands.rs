//! The two ways of writing a seed agree: the direct writer (dr-doc, fast,
//! byte-reproducible) and F3's commands (every command-layer rule checked)
//! give the same digest.

use dr_testkit::seed::{self, DEFAULT_SEED, Preset};
use dr_workspace::{Actor, Workspace};
use serde_json::Value;

/// The first place two JSON values differ, for a readable failure.
fn first_difference(a: &Value, b: &Value, path: &str) -> Option<String> {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            for k in x.keys().chain(y.keys()) {
                let (p, q) = (
                    x.get(k).unwrap_or(&Value::Null),
                    y.get(k).unwrap_or(&Value::Null),
                );
                if let Some(d) = first_difference(p, q, &format!("{path}/{k}")) {
                    return Some(d);
                }
            }
            None
        }
        (Value::Array(x), Value::Array(y)) => {
            for i in 0..x.len().max(y.len()) {
                let (p, q) = (
                    x.get(i).unwrap_or(&Value::Null),
                    y.get(i).unwrap_or(&Value::Null),
                );
                if let Some(d) = first_difference(p, q, &format!("{path}/{i}")) {
                    return Some(d);
                }
            }
            None
        }
        _ if a == b => None,
        _ => Some(format!("{path}: direct {a} vs commands {b}")),
    }
}

fn both_ways(preset: Preset) -> (Value, seed::CommandBook) {
    let dir = tempfile::tempdir().unwrap();
    let direct = seed::generate(preset, DEFAULT_SEED).unwrap();
    let lib =
        dr_store::Library::open(dir.path().join("direct"), seed::library_options("test")).unwrap();
    direct.write_to(&lib).unwrap();
    let a = seed::digest(&lib, direct.books[0].book_id().as_str()).unwrap();
    lib.close().unwrap();

    let ws = Workspace::open_dir(dir.path().join("commands"), "test").unwrap();
    let made = seed::generate_via_commands(preset, DEFAULT_SEED, &ws, &Actor::Import).unwrap();
    let b = seed::digest(ws.library(), &made[0].book).unwrap();
    ws.shutdown().unwrap();
    if let Some(d) = first_difference(&a, &b, "") {
        panic!("{}: the two writers disagree at {d}", preset.name());
    }
    (a, made.into_iter().next().unwrap())
}

#[test]
fn tiny_written_by_commands_equals_tiny_written_directly() {
    let (digest, made) = both_ways(Preset::Tiny);
    assert_eq!(digest["chapters"].as_array().unwrap().len(), 4);
    // The digest compares real content, not empty shells.
    let body = &digest["chapters"][0]["body"];
    assert!(!body["paragraphs"].as_array().unwrap().is_empty());
    assert!(!body["links"].as_array().unwrap().is_empty());
    assert!(
        body["paragraphs"][0][0].is_number(),
        "the first paragraph is a heading"
    );
    for c in digest["comments"].as_array().unwrap() {
        assert_eq!(c["anchored"], true, "{c}");
        assert!(c["quote"].is_string(), "{c}");
    }
    assert!(made.commands > 30, "{made:?}");
    assert!(made.prose_edits > 0);
}

#[test]
fn lite_written_by_commands_equals_lite_written_directly() {
    let (digest, _) = both_ways(Preset::Lite);
    assert_eq!(digest["chapters"].as_array().unwrap().len(), 20);
    assert_eq!(digest["relations"].as_array().unwrap().len(), 40);
    assert_eq!(digest["comments"].as_array().unwrap().len(), 20);
}

#[test]
fn the_showcase_is_written_directly_only() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::open_dir(dir.path(), "test").unwrap();
    assert!(
        seed::generate_via_commands(Preset::Showcase, DEFAULT_SEED, &ws, &Actor::Import).is_err()
    );
    ws.shutdown().unwrap();
}
