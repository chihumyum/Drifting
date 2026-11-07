//! Retired products stay out of `next/` (rule 6): the patterns of
//! `retired-client-integrations.acceptance.test.ts` and the two retired
//! product guards. A file that must name a retired value (the importer's
//! mapping of old stored values, this gate) is listed as a record.

use regex::Regex;

use super::Outcome;
use crate::repo::Repo;

/// (product, pattern). Assembled from pieces, like the 0.1 guards, so a
/// scanner of this file's text does not match it.
pub fn patterns() -> Vec<(&'static str, Regex)> {
    let p = |parts: &[&str]| parts.concat();
    vec![
        (
            "retired cloud-drive sync",
            p(&[
                "google[ _-]?",
                "drive|google",
                "drive|DRIFTING_",
                "GOOGLE_|app",
                "DataFolder",
            ]),
        ),
        ("retired Copilot", p(&[r"\bco", r"pilot\b"])),
        (
            "retired Google BYOK route",
            p(&["google[ _-]?", "byok|generativelanguage\\.", "googleapis"]),
        ),
        (
            "retired Shadow CI",
            p(&[
                "shadow[ _-]?",
                "ci\\b|shadow_",
                "job|Shadow",
                "Panel|eval:",
                "shadow",
            ]),
        ),
        (
            "retired Element Arc",
            p(&["element[ _-]?", "arc\\b|element_", "arc"]),
        ),
        (
            "retired Goal Evolve",
            p(&["goal[ _-]?", "evolve|goal_", "run_id|Evolve", "Section"]),
        ),
        (
            "retired standalone Apple front-end",
            p(&["drifting-apple-", "bridge|apple-native-", "paused"]),
        ),
        (
            "retired R2 storage",
            p(&["r2\\.cloudflare", "storage|\\bR2_", "[A-Z]"]),
        ),
        ("retired Claude SDK session", p(&["sdk_", "session_id"])),
    ]
    .into_iter()
    .map(|(label, re)| (label, Regex::new(&format!("(?i){re}")).expect("regex")))
    .collect()
}

/// Files that may name a retired value, and which product: the 0.1
/// importer and the data model keep the retired in-app AI's stored comment
/// values readable (AGENTS.md "Retired Agent Products").
const RECORDS: &[(&str, &str)] = &[
    ("next/xtask/src/gates/retired.rs", "*"),
    ("next/crates/dr-model/src/legacy.rs", "retired Copilot"),
    ("next/crates/dr-model/src/kind.rs", "retired Copilot"),
    ("next/crates/dr-model/src/invariant.rs", "retired Copilot"),
    (
        "next/crates/dr-doc/fuzz/fuzz_targets/bad_structure.rs",
        "retired Copilot",
    ),
    ("next/crates/dr-import-v1/src/book.rs", "retired Copilot"),
    ("next/crates/dr-import-v1/src/receipt.rs", "retired Copilot"),
    ("next/crates/dr-import-v1/src/tables.rs", "retired Copilot"),
    (
        "next/crates/dr-import-v1/tests/common/mod.rs",
        "retired Copilot",
    ),
    ("next/spikes/import-v1/src/tables.rs", "retired Copilot"),
];

fn is_record(path: &str, label: &str) -> bool {
    RECORDS
        .iter()
        .any(|(p, l)| *p == path && (*l == "*" || *l == label))
}

pub fn run(repo: &Repo) -> Result<Outcome, String> {
    let mut o = Outcome::default();
    let files = repo.files(&["next"])?;
    let patterns = patterns();
    for (path, _) in RECORDS {
        if !repo.path(path).exists() {
            o.note(format!("{path} is listed as a record but no longer exists"));
        }
    }
    for f in &files {
        let Some(text) = repo.text(&f.path) else {
            continue;
        };
        for (label, re) in &patterns {
            if is_record(&f.path, label) {
                continue;
            }
            if let Some(m) = re.find(&text) {
                let line = text[..m.start()].matches('\n').count() + 1;
                o.fail(format!("{}:{line}: {label} ({:?})", f.path, m.as_str()));
            }
        }
    }
    o.summary = format!(
        "{} files in next/, {} patterns",
        files.len(),
        patterns.len()
    );
    Ok(o)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patterns_match_retired_names_only() {
        let hit = |s: &str| patterns().iter().any(|(_, re)| re.is_match(s));
        let drive = ["Google", " ", "Drive"].concat();
        assert!(hit(&drive));
        assert!(hit(&["Co", "pilot"].concat()));
        assert!(hit(&["shadow", "_job"].concat()));
        assert!(hit(&["R2", "_BUCKET"].concat()));
        for ok in [
            "shadow migration",
            "box-shadow",
            "element archive",
            "goal",
            "r2d2",
            "pilot",
        ] {
            assert!(!hit(ok), "{ok}");
        }
    }
}
