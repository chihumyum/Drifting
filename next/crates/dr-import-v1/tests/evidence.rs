//! The committed measurement (`docs/rust-rewrite/acceptance/m10-import.json`,
//! `m10-import measure`) still says what M10's first milestone promised.
//! A changed source only reports the evidence as stale; rerun the
//! measurement at the next milestone.

use serde_json::Value;

#[test]
fn committed_evidence_holds() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../docs/rust-rewrite/acceptance/m10-import.json");
    let e: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    if e["sourceFingerprint"] != dr_import_v1::source_fingerprint() {
        eprintln!("m10-import.json is stale: the sources changed since it was measured");
    }
    let libs = e["libraries"].as_array().unwrap();
    let names: Vec<&str> = libs.iter().filter_map(|l| l["name"].as_str()).collect();
    for want in ["sample", "sample-stale", "sample-handoff", "lite", "stress"] {
        assert!(names.contains(&want), "{want} measured");
    }
    for l in libs {
        let (i, t) = (&l["import"], &l["truth"]);
        let name = l["name"].as_str().unwrap();
        assert_eq!(i["outcome"], "imported", "{name}");
        assert_eq!(
            i["storedExactly"], i["bodies"],
            "{name}: every body stored exactly"
        );
        assert_eq!(
            i["roundTrips"], i["bodies"],
            "{name}: every body round-trips"
        );
        assert_eq!(
            i["anchorCursors"], i["anchors"],
            "{name}: every anchor is a cursor pair"
        );
        assert_eq!(
            t["provenFreshButDifferent"].as_array().map(Vec::len),
            Some(0),
            "{name}: nothing wrongly proven fresh"
        );
        assert_eq!(t["notImported"], 0, "{name}");
        assert_eq!(
            t["historyRowsWithLabels"], t["historyRows"],
            "{name}: history points"
        );
        let handed_off = !l["stoppedByGate"].is_array();
        if handed_off {
            assert_eq!(t["equalToYjs"], t["bodiesWithYjs"], "{name}: equal to Yjs");
        }
    }
    let stale = libs.iter().find(|l| l["name"] == "sample-stale").unwrap();
    assert!(
        stale["stoppedByGate"].is_array(),
        "the library without handoff is stopped"
    );
    let doubtful = stale["import"]["byFreshness"]
        .as_object()
        .unwrap()
        .iter()
        .filter(|(k, _)| {
            matches!(
                k.as_str(),
                "unproven" | "node-basis-behind" | "handoff-mismatch"
            )
        })
        .map(|(_, v)| v.as_u64().unwrap())
        .sum::<u64>();
    assert_eq!(
        stale["truth"]["doubtfulAndDifferent"].as_u64(),
        Some(doubtful),
        "every doubtful body really lags"
    );
}
