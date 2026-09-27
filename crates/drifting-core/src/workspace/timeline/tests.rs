use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};

const CLIENT: &str = "synthetic-timeline";
const NOW: &str = "2026-09-27T00:00:00.000Z";
const SEED: &str =
    "AQPC7RoABwEHZGVmYXVsdAMJcGFyYWdyYXBoBwDC7RoABigAwu0aAAJpZAF3FXRyYXNoLXN5bnRoZXRpYy1ibG9jawA=";
const CACHE: &str =
    r#"{"type":"doc","content":[{"type":"paragraph","attrs":{"id":"trash-synthetic-block"}}]}"#;

fn context() -> AuthoredProseContext {
    AuthoredProseContext {
        project_id: "timeline-project".into(),
        project_sync_id: "timeline-project-sync".into(),
        sync_generation_id: "timeline-generation".into(),
        installation_id: "timeline-installation".into(),
        new_writer_id: "timeline-writer".into(),
        new_writer_epoch: "timeline-epoch".into(),
        now_iso: NOW.into(),
        now_ms: 200,
    }
}
fn seed() -> ChapterSeed {
    ChapterSeed {
        update: STANDARD.decode(SEED).unwrap(),
        content_json: CACHE.into(),
    }
}
fn count(g: &DatabaseGateway) -> Vec<Vec<V>> {
    g.query(
        "SELECT count(*) FROM sync_change_set".into(),
        vec![],
        None,
        CLIENT.into(),
    )
    .unwrap()
    .rows
}

#[test]
fn workspace_timeline_orders_markers_and_positions() {
    let dir = tempfile::tempdir().unwrap();
    let g = DatabaseGateway::new(dir.path().into()).unwrap();
    g.open("timeline.db".into(), CLIENT.into(), false).unwrap();
    let store = WorkspaceStore::new(&g, CLIENT);
    let c = context();
    store
        .create_project(
            &c,
            CreateProject {
                user_id: "local-user".into(),
                name: "时间".into(),
                default_kv_ids: std::array::from_fn(|i| format!("timeline-fact-{i}")),
            },
        )
        .unwrap();
    store
        .create_chapter(
            &c,
            CreateChapter {
                id: "chapter".into(),
                title: "第一章".into(),
                book_order: Some(1.0),
                seed: seed(),
            },
        )
        .unwrap();
    store
        .create_drift(
            &c,
            NewDrift {
                id: "drift".into(),
                title: Some("灵感".into()),
                group_id: None,
                seed: seed(),
            },
        )
        .unwrap();
    // Narrative order: set, unchanged, cleared; drifts have none.
    let placed = store.set_narrative_order(&c, "chapter", Some(3.5)).unwrap();
    assert_eq!(placed.narrative_order, Some(3.5));
    let before = count(&g);
    store.set_narrative_order(&c, "chapter", Some(3.5)).unwrap();
    assert_eq!(count(&g), before, "unchanged writes nothing");
    assert!(store.set_narrative_order(&c, "drift", Some(1.0)).is_err());
    assert!(store
        .set_narrative_order(&c, "chapter", Some(f64::NAN))
        .is_err());
    assert_eq!(
        store
            .set_narrative_order(&c, "chapter", None)
            .unwrap()
            .narrative_order,
        None
    );
    // Drift cards move on the graph.
    let moved = store.set_node_position(&c, "drift", 120.0, -40.5).unwrap();
    assert_eq!((moved.position_x, moved.position_y), (120.0, -40.5));
    // Markers: labelled, drift-bound without a label, edited, deleted.
    let dawn = store
        .create_marker(&c, "dawn", 1.0, " 黎明 ", None)
        .unwrap();
    assert_eq!(dawn.label, "黎明");
    let bound = store
        .create_marker(&c, "bound", 2.0, "", Some("drift"))
        .unwrap();
    assert_eq!(bound.drift_node_id.as_deref(), Some("drift"));
    assert!(store.create_marker(&c, "blank", 3.0, " ", None).is_err());
    assert!(
        store
            .create_marker(&c, "chapter-bound", 3.0, "x", Some("chapter"))
            .is_err(),
        "only drifts bind"
    );
    let edited = store
        .update_marker(&c, "dawn", Some(0.5), Some("拂晓"), None)
        .unwrap();
    assert_eq!(
        (edited.narrative_order, edited.label.as_str()),
        (0.5, "拂晓")
    );
    let before = count(&g);
    store
        .update_marker(&c, "dawn", Some(0.5), Some("拂晓"), None)
        .unwrap();
    assert_eq!(count(&g), before);
    assert!(
        store
            .update_marker(&c, "bound", None, None, Some(None))
            .is_err(),
        "an unbound marker needs a label"
    );
    store
        .update_marker(&c, "bound", None, Some("钟声"), Some(None))
        .unwrap();
    let timeline = store.timeline(&c.project_id).unwrap();
    assert_eq!(
        timeline
            .markers
            .iter()
            .map(|m| m.id.as_str())
            .collect::<Vec<_>>(),
        ["dawn", "bound"]
    );
    assert_eq!(timeline.nodes.len(), 2);
    store.delete_marker(&c, "dawn").unwrap();
    assert!(store.delete_marker(&c, "dawn").is_err());
    // Trashing a bound drift unbinds its markers (captioned by the title).
    store
        .update_marker(&c, "bound", None, Some(" "), Some(Some("drift")))
        .unwrap();
    store.trash_drift(&c, "drift").unwrap();
    let marker = store.timeline(&c.project_id).unwrap().markers.remove(0);
    assert_eq!(
        (marker.drift_node_id, marker.label.as_str()),
        (None, "灵感")
    );
}
