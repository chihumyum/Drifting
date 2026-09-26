use super::entity_links::{detect, entity_link_key, matcher};
use super::*;

fn target(name: &str, kind: &str, id: &str) -> EntityLinkTarget {
    EntityLinkTarget {
        name: name.into(),
        kind: kind.into(),
        id: id.into(),
    }
}

fn doc(paragraphs: &[(&str, &str)]) -> DocumentSession {
    let mut doc = DocumentSession::with_test_client_id(51001).unwrap();
    for (id, text) in paragraphs {
        doc.edit(Edit::AppendParagraph {
            id: (*id).into(),
            text: (*text).into(),
        })
        .unwrap();
    }
    doc
}

fn links(doc: &DocumentSession) -> Vec<(u32, u32, String)> {
    doc.entity_link_spans()
        .unwrap()
        .into_iter()
        .map(|span| (span.range.location, span.range.length, span.id))
        .collect()
}

#[test]
fn entity_link_key_matches_y_tiptap_overlapping_mark_hash() {
    // Produced by y-tiptap's hashOfJSON over mark.toJSON() with lib0.
    for (kind, id, hash) in [
        ("element", "native-element-1", "kDRvc5Je"),
        ("element", "019a-uuid-🙂", "XdQ+viQg"),
        ("node", "chapter-9", "mxc2eYrK"),
        ("storyline", "s", "/128ALDE"),
    ] {
        assert_eq!(entity_link_key(kind, id), format!("entityLink--{hash}"));
    }
}

#[test]
fn entity_link_detection_matches_the_renderer_matcher() {
    let targets = [
        target("山", "element", "short"),
        target("远山", "element", "long"),
        target("A+B", "element", "literal"),
    ];
    let units: Vec<u16> = "远山 A+B 山".encode_utf16().collect();
    let found: Vec<_> = detect(&units, &matcher(&targets))
        .into_iter()
        .map(|(at, len, i)| (at, at + len, matcher(&targets)[i].1.id.clone()))
        .collect();
    assert_eq!(
        found,
        vec![
            (0, 2, "long".into()),
            (3, 6, "literal".into()),
            (7, 8, "short".into())
        ]
    );
    // Verbatim, case-sensitive, no word boundaries, UTF-16 offsets.
    let targets = [target("Mira", "element", "m")];
    let units: Vec<u16> = "🙂Miranda mira Mira".encode_utf16().collect();
    let found: Vec<_> = detect(&units, &matcher(&targets))
        .into_iter()
        .map(|(at, len, _)| (at, len))
        .collect();
    assert_eq!(found, vec![(2, 4), (15, 4)]);
}

#[test]
fn link_entities_is_idempotent_not_undoable_and_keeps_other_targets() {
    let mut doc = doc(&[("p", "林凯在北塔等信"), ("q", "北塔的灯")]);
    let targets = [
        target("林凯", "element", "hero"),
        target("北塔", "element", "tower"),
        target("", "element", "ignored"),
    ];
    let before = doc.native_projection().unwrap();
    assert_eq!(doc.link_entities(&targets).unwrap(), 3);
    let after = doc.native_projection().unwrap();
    assert_eq!(after.text, before.text);
    assert!(after.revision > before.revision);
    assert_eq!(
        links(&doc),
        vec![
            (0, 2, "hero".into()),
            (3, 2, "tower".into()),
            (8, 2, "tower".into())
        ]
    );
    let run = &after.blocks[0].runs[0];
    assert_eq!(
        run.attributes[&entity_link_key("element", "hero")],
        json!({"targetKind":"element","targetId":"hero","targetBlockId":null})
    );
    assert_eq!(doc.link_entities(&targets).unwrap(), 0, "already linked");
    // Automatic linking is not an undo step: undo reverts typing only.
    doc.replace_native(NativeReplacement {
        revision: doc.revision,
        range: NativeRange {
            location: 7,
            length: 0,
        },
        text: "，林凯".into(),
    })
    .unwrap();
    assert_eq!(doc.link_entities(&targets).unwrap(), 1);
    assert!(doc.undo());
    assert_eq!(doc.native_projection().unwrap().text, before.text);
    assert_eq!(links(&doc).len(), 3);
    // A different target on the same text is added alongside the first link.
    let other = [target("林凯", "node", "chapter-2")];
    assert_eq!(doc.link_entities(&other).unwrap(), 1);
    let spans = links(&doc);
    assert!(spans.contains(&(0, 2, "hero".into())) && spans.contains(&(0, 2, "chapter-2".into())));
    // Remote replicas receive the same attributes.
    let mut replica = DocumentSession::new();
    replica
        .apply_remote(&doc.update(None, 1).unwrap(), 1)
        .unwrap();
    assert_eq!(links(&replica), links(&doc));
}

#[test]
fn link_entities_waits_for_drafts_and_uses_renderer_name_collisions() {
    let mut doc = doc(&[("p", "灯塔")]);
    // Map semantics: the later target for the same name wins.
    let targets = [
        target("灯塔", "element", "first"),
        target("灯塔", "node", "chapter"),
    ];
    doc.begin_draft(NativeDraftStart {
        key: "ime".into(),
        revision: doc.revision,
        range: NativeRange {
            location: 0,
            length: 0,
        },
    })
    .unwrap();
    assert_eq!(doc.link_entities(&targets).unwrap(), 0);
    doc.cancel_draft("ime");
    assert_eq!(doc.link_entities(&targets).unwrap(), 1);
    assert_eq!(links(&doc), vec![(0, 2, "chapter".into())]);
}
