use super::*;

#[test]
fn patch_bodies_anchors_and_whitespace() {
    assert_eq!(
        body_text(&plain_comment_doc("左臂有疤\n\n右手完好")),
        "左臂有疤\n\n右手完好"
    );
    assert_eq!(body_text("{}"), "");
    assert_eq!(body_text("not json"), "");
    assert_eq!(
        anchor_text(Some(&anchor_json("失去了\n左臂"))).as_deref(),
        Some("失去了\n左臂")
    );
    assert_eq!(anchor_text(Some(r#"{"text":""}"#)), None);
    assert_eq!(anchor_text(None), None);
    // A block split or reflow keeps the anchor present.
    assert!(normalized("林岚失去了\n  左臂。").contains(&normalized("失去了 左臂")));
    assert_eq!(clean_title(Some("  断臂 ")).as_deref(), Some("断臂"));
    assert_eq!(clean_title(Some("   ")), None);
}
