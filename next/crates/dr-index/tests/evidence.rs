//! The committed measurement (`docs/rust-rewrite/acceptance/dr-text-index-m1.json`,
//! `dr-index-bench`) still says what the milestone promised. A changed
//! source only reports it as stale; rerun the bench at the next milestone
//! (`simplifications.md`, section five).

use serde_json::Value;

#[test]
fn committed_evidence_holds() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../docs/rust-rewrite/acceptance/dr-text-index-m1.json");
    let e: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    if e["sourceFingerprint"] != dr_index::evidence::source_fingerprint() {
        eprintln!("dr-text-index-m1.json is stale: the sources changed since it was measured");
    }
    assert_eq!(e["milestone"], "dr-text-index-m1");

    let c = &e["chapter"];
    assert_eq!(c["chars"], 20_000);
    assert_eq!(
        c["holderDerivations"]["incremental"], 300,
        "keystrokes take the diffs"
    );
    assert_eq!(c["holderDerivations"]["fallbacks"], 0);
    assert!(c["incrementalParagraphsReadPerKeystroke"].as_f64().unwrap() <= 2.0);
    for key in [
        "fullDeriveWarmMs",
        "copyForDrDocMs",
        "copyAndFullDeriveMs",
        "incrementalAfterKeystrokeWarmMs",
        "writeRowsMs",
        "simulatedPatchWriteMs",
        "holderReindexAfterKeystrokeMs",
    ] {
        assert!(c[key]["p50"].is_number(), "chapter.{key}");
    }
    for key in ["withDeriver", "withoutDeriver"] {
        assert_eq!(e["keystrokeWriteMs"][key]["n"], 2000, "{key}");
    }

    let h = &e["heavySynthetic"];
    assert_eq!(h["chapters"], 100);
    assert_eq!(h["chars"], 1_500_000);
    assert_eq!(h["rebuilt"], 100);
    assert_eq!(h["bookStats"]["words"], h["wordsCountedDirectly"]);
    assert!(h["rebuildAllMs"].is_number());

    // The 0.1 stress seed imported by M10: every body indexed, and every
    // kind's words equal to what the 0.1 seed counted with the TypeScript
    // rule.
    let m = &e["m10Library"];
    assert_eq!(m["preset"], "stress");
    assert_eq!(m["rebuilt"], m["docs"]);
    assert_eq!(m["derivations"]["unreadable"], 0);
    let kinds = m["byKind"].as_array().unwrap();
    let mut compared = 0;
    for k in kinds {
        if k["seedWords0_1"].is_number() {
            assert_eq!(k["words"], k["seedWords0_1"], "{}", k["kind"]);
            compared += 1;
        }
    }
    assert_eq!(
        compared, 6,
        "chapters, ideas, elements, notes, storylines, categories"
    );
    for s in m["search"].as_array().unwrap() {
        assert!(s["hits"].as_u64().unwrap() > 0, "{s}");
    }
}
