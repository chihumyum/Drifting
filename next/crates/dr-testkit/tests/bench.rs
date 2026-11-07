//! CI's part of benchmarking: every suite, quick, keeps its shape.

#[test]
fn every_suite_keeps_its_quick_shape() {
    assert_eq!(
        dr_testkit::bench::check_all().unwrap(),
        dr_testkit::bench::suites().len()
    );
}

#[test]
fn compare_lines_up_two_results() {
    let a = serde_json::json!({ "cases": { "x": { "ms": { "write": { "p50": 2.0 } } } } });
    let b = serde_json::json!({ "results": { "cases": { "x": { "ms": { "write": { "p50": 1.0 } } } } } });
    let lines = dr_testkit::bench::compare(&a, &b);
    assert_eq!(lines.len(), 1);
    assert!(lines[0].contains("0.50×"), "{}", lines[0]);
}
