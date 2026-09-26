use super::*;

fn source() -> DocumentSession {
    let mut seed = DocumentSession::new();
    seed.edit(Edit::AppendParagraph {
        id: "p".into(),
        text: "甲北塔乙".into(),
    })
    .unwrap();
    let mut owner = DocumentSession::new();
    owner
        .apply_remote(&seed.update(None, 1).unwrap(), 1)
        .unwrap();
    owner
}
fn input(key: &str, sequence: u64, at: u32, length: u32, text: &str) -> NativeInputEdit {
    NativeInputEdit {
        key: key.into(),
        sequence,
        range: NativeRange {
            location: at,
            length,
        },
        text: text.into(),
        selection: None,
    }
}

#[test]
fn queued_inputs_keep_their_visible_basis_across_overlapping_merges() {
    let mut owner = source();
    owner.fork_input("shared".into(), None).unwrap();
    owner.fork_input("ime".into(), Some("shared")).unwrap();
    owner.replace_input(input("shared", 0, 2, 0, "远")).unwrap();
    let authored = owner.replace_input(input("ime", 0, 1, 2, "新")).unwrap();
    assert_eq!(authored.text, "甲新乙");
    // This next input was already visible before the previous reply could show
    // the merged 远. Numeric offsets must resolve in the authored branch.
    assert_eq!(
        owner
            .replace_input(input("ime", 1, 2, 0, "续"))
            .unwrap()
            .text,
        "甲新续乙"
    );
    assert_eq!(
        owner
            .replace_input(input("shared", 1, 2, 1, "方"))
            .unwrap()
            .text,
        "甲北方塔乙"
    );
    let merged = owner.native_projection().unwrap().text;
    assert!(merged.contains("新续"));
    assert!(merged.contains('方'));
    assert!(!merged.contains('远'));
    assert!(!merged.contains('北'));
    assert!(!merged.contains('塔'));
    let snapshot = owner.update(None, 1).unwrap();
    assert!(owner.replace_input(input("ime", 1, 2, 0, "续")).is_err());
    assert_eq!(owner.update(None, 1).unwrap(), snapshot);
    assert!(owner.undo());
    assert!(owner.native_projection().unwrap().text.contains('远'));
    assert!(owner.undo());
    assert!(!owner.native_projection().unwrap().text.contains('续'));
    assert!(owner.undo());
    assert_eq!(owner.native_projection().unwrap().text, "甲北远塔乙");
    for _ in 0..3 {
        assert!(owner.redo());
    }
    assert_eq!(owner.native_projection().unwrap().text, merged);
    let mut reopened = DocumentSession::new();
    reopened.apply_remote(&snapshot, 1).unwrap();
    assert_eq!(reopened.native_projection().unwrap().text, merged);
}

#[test]
fn branch_lifetime_sequence_and_rejected_edits_are_atomic() {
    let mut owner = source();
    let bytes = owner.update(None, 1).unwrap();
    owner.fork_input("a".into(), None).unwrap();
    assert_eq!(owner.update(None, 1).unwrap(), bytes);
    assert!(owner.fork_input("a".into(), None).is_err());
    assert!(owner.fork_input("b".into(), Some("missing")).is_err());
    assert!(owner.replace_input(input("a", 0, 999, 1, "x")).is_err());
    owner.replace_input(input("a", 0, 0, 0, "一")).unwrap();
    owner.fork_input("b".into(), Some("a")).unwrap();
    owner.replace_input(input("a", 1, 0, 0, "二")).unwrap();
    let stable = owner.update(None, 1).unwrap();
    // The remote insert is exactly at this boundary. An interior Enter after
    // an otherwise unchanged prefix now merges, but this conflict stays atomic.
    assert!(owner.replace_input(input("b", 0, 0, 0, "\n")).is_err());
    assert_eq!(owner.update(None, 1).unwrap(), stable);
    owner.replace_input(input("b", 0, 1, 0, "三")).unwrap();
    assert!(owner.native_projection().unwrap().text.contains("一三"));
    owner.drop_input("a");
    owner.drop_input("b");
    owner.drop_input("b");
    assert_eq!(owner.active_inputs(), 0);
    assert!(owner.replace_input(input("b", 1, 0, 0, "四")).is_err());
}

#[test]
fn one_branch_reuses_its_author_clocks_for_rapid_typing() {
    let mut owner = source();
    let before = owner.doc.transact().state_vector().iter().count();
    owner.fork_input("typing".into(), None).unwrap();
    for sequence in 0..100 {
        owner
            .replace_input(input("typing", sequence, sequence as u32, 0, "字"))
            .unwrap();
    }
    assert_eq!(
        owner.doc.transact().state_vector().iter().count(),
        before + 1
    );
    assert!(owner
        .native_projection()
        .unwrap()
        .text
        .starts_with(&"字".repeat(100)));
}
