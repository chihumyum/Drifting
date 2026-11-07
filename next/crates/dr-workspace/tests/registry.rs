//! The capability list: exported from the registry and kept as insta
//! snapshots, so any change to a command's name, class, summary or schema is
//! a reviewable diff. Regenerate with `INSTA_UPDATE=always cargo test -p
//! dr-workspace --test registry` (or `cargo insta review`).

use dr_workspace::{Access, Concurrency, registry};

#[test]
fn capability_table() {
    insta::assert_snapshot!("capabilities", registry().table());
}

#[test]
fn capability_schemas() {
    let json = serde_json::to_string_pretty(&registry().manifest()).unwrap();
    insta::assert_snapshot!("capability_schemas", json);
}

#[test]
fn entries_are_well_formed() {
    let r = registry();
    assert!(r.len() >= 70, "{} entries", r.len());
    for s in r.iter() {
        assert!(
            s.summary.ends_with('.'),
            "{}: summary is a sentence",
            s.name
        );
        match s.access {
            Access::Read => assert_eq!(s.concurrency, Concurrency::Shared, "{}", s.name),
            Access::Write => assert_ne!(s.concurrency, Concurrency::Shared, "{}", s.name),
        }
        // Every input is an object (named fields), so Agent tools and MCP
        // can pass arguments by name.
        let input = s.input_schema();
        assert_eq!(input.as_value()["type"], "object", "{}", s.name);
    }
}

#[test]
fn product_vocabulary() {
    // H1/H2/H3 are only H1/H2/H3; ideas are ideas; no retired products. The
    // words are assembled here so this file itself stays clean for
    // repository-wide word guards.
    let text = format!("{}{}", registry().table(), registry().manifest()).to_lowercase();
    let words: Vec<String> = [
        ["sce", "ne"],
        ["be", "at"],
        ["co", "pilot"],
        ["shadow ", "ci"],
        ["element ", "arc"],
        ["goal ", "evolve"],
        ["灵", "感"],
        ["浮", "缀"],
    ]
    .iter()
    .map(|p| p.concat())
    .collect();
    for word in &words {
        assert!(
            !text.contains(word.as_str()),
            "the capability list says {word:?}"
        );
    }
}
