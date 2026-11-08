//! Every test the invariant checklist (`dr_model::invariant`) names exists
//! in a crate of the workspace (`next/crates/*`), so the checklist cannot
//! claim a check nobody runs.

use std::path::Path;

fn sources(dir: &Path, out: &mut String) {
    for e in std::fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        if p.is_dir() {
            if p.file_name().is_some_and(|n| n == "fuzz" || n == "target") {
                continue;
            }
            sources(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push_str(&std::fs::read_to_string(&p).unwrap());
        }
    }
}

#[test]
fn every_named_test_exists() {
    // dr-model and dr-doc hold the rules' own tests; the command layer
    // (dr-workspace), storage (dr-store) and the pages (dr-view-*) hold the
    // rest.
    let crates = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let mut src = String::new();
    sources(&crates, &mut src);
    let mut missing = Vec::new();
    let named = dr_model::invariant::INVARIANTS
        .iter()
        .flat_map(|i| i.tests.iter().map(move |t| (i.id, *t)))
        .chain(
            dr_model::invariant::DIVERGENCES
                .iter()
                .flat_map(|d| d.tests.iter().map(move |t| (d.id, *t))),
        );
    for (id, t) in named {
        if !src.contains(&format!("fn {t}(")) {
            missing.push(format!("{id} → {t}"));
        }
    }
    assert!(
        missing.is_empty(),
        "named tests that do not exist: {missing:#?}"
    );
}
