mod common;
use common::*;
use serde_json::json;

#[test]
fn writing_days_dispatch_by_version_preserve_other_books_and_do_not_enter_undo() {
    let mut e = env();
    let a = e.out("project.create", json!({"name":"Synthetic writing days A"}))["id"]
        .as_str()
        .unwrap()
        .to_string();
    let b = e.out("project.create", json!({"name":"Synthetic writing days B"}))["id"]
        .as_str()
        .unwrap()
        .to_string();
    let legacy = e.book();
    let device = "device-000000000000000000000001";
    let second = "device-000000000000000000000002";
    let before_b = e.ws().observe(&format!("book:{b}")).unwrap();
    let before_a = e.ws().observe(&format!("book:{a}")).unwrap();
    for (book, who, day, words) in [
        (&a, device, "2026-11-10", 12),
        (&a, second, "2026-11-10", 8),
        (&a, device, "2026-11-09", 4),
        (&legacy, device, "2026-11-10", 3),
    ] {
        let out = e.call(
            "writing_day.record",
            json!({"book":book,"device":who,"day":day,"words":words}),
        );
        assert!(out["journal"].is_null());
        assert!(out["undo"].is_null());
    }
    let after_a = e.ws().observe(&format!("book:{a}")).unwrap();
    let mut expected = before_a.value.clone();
    expected["writing_days"] = after_a.value["writing_days"].clone();
    assert_eq!(expected, after_a.value);
    let args = json!({"book":a,"device":device,"day":"2026-11-10","words":12});
    e.call("writing_day.record", args);
    assert_eq!(
        after_a.version,
        e.ws().observe(&format!("book:{a}")).unwrap().version
    );
    for (day, words) in [("2026-02-30", 1), ("2026-11-10", -1), ("2026-1日0", 1)] {
        assert!(
            e.try_call(
                "writing_day.record",
                json!({"book":a,"device":device,"day":day,"words":words})
            )
            .is_err()
        );
    }
    assert_eq!(
        after_a.version,
        e.ws().observe(&format!("book:{a}")).unwrap().version
    );
    let got = e.out(
        "book.writing_days",
        json!({"book":a,"today":"2026-11-10","device":device,"days":2}),
    );
    assert_eq!(got["today"], 20);
    assert_eq!(got["mine_today"], 12);
    assert_eq!(got["week"], 24);
    assert_eq!(got["streak"], 2);
    assert_eq!(got["daily_word_target"], 1500);
    assert_eq!(
        e.out(
            "book.writing_days",
            json!({"book":legacy,"today":"2026-11-10"})
        )["today"],
        3
    );
    assert_eq!(
        before_b.value,
        e.ws().observe(&format!("book:{b}")).unwrap().value
    );
    assert_eq!(
        before_b.version,
        e.ws().observe(&format!("book:{b}")).unwrap().version
    );
    // The compatibility allowance is exact, not a blanket book.* whitelist.
    assert!(
        e.try_call("book.search", json!({"book":a,"query":"Synthetic"}))
            .is_err()
    );
    assert!(e.try_call("book.word_counts", json!({"book":a})).is_err());
    e.reopen();
    assert_eq!(
        got,
        e.out(
            "book.writing_days",
            json!({"book":a,"today":"2026-11-10","device":device,"days":2})
        )
    );
}
