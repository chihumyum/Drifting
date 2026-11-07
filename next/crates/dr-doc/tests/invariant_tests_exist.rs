//! Every test the invariant checklist (`dr_model::invariant`) names exists in
//! dr-model or dr-doc, so the checklist cannot claim a check nobody runs.

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
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut src = String::new();
    sources(root, &mut src);
    sources(&root.join("../dr-model"), &mut src);
    let mut missing = Vec::new();
    for inv in dr_model::invariant::INVARIANTS {
        for t in inv.tests {
            if !src.contains(&format!("fn {t}(")) {
                missing.push(format!("{} → {t}", inv.id));
            }
        }
    }
    assert!(
        missing.is_empty(),
        "named tests that do not exist: {missing:#?}"
    );
}
