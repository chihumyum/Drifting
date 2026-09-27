use super::*;

#[test]
fn purge_targets_cover_trashable_content_only() {
    for (kind, lifecycle, prefix) in [
        ("chapter", "node", "node-content"),
        ("drift", "node", "node-content"),
        ("element", "element", "element"),
        ("category", "element-category", "category"),
        ("storyline", "storyline", "storyline"),
    ] {
        let target = target(kind).unwrap();
        assert_eq!((target.lifecycle, target.prefix), (lifecycle, prefix));
    }
    for kind in ["comment", "project", "act", "library"] {
        assert!(target(kind).is_err(), "{kind}");
    }
}
