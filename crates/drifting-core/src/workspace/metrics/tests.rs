use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};

const CLIENT: &str = "synthetic-metrics";
const NOW: &str = "2026-09-27T00:00:00.000Z";
const LATER: &str = "2026-09-27T01:00:00.000Z";
const SEED: &str =
    "AQPC7RoABwEHZGVmYXVsdAMJcGFyYWdyYXBoBwDC7RoABigAwu0aAAJpZAF3FXRyYXNoLXN5bnRoZXRpYy1ibG9jawA=";
const CACHE: &str =
    r#"{"type":"doc","content":[{"type":"paragraph","attrs":{"id":"trash-synthetic-block"}}]}"#;
const HASH: &str = "sha256:99323af1384708a12786da7f2ded5e3db04159f7beb5ffd4a0be50c459225d57";

fn context() -> AuthoredProseContext {
    AuthoredProseContext {
        project_id: "metrics-project".into(),
        project_sync_id: "metrics-project-sync".into(),
        sync_generation_id: "metrics-generation".into(),
        installation_id: "metrics-installation".into(),
        new_writer_id: "metrics-writer".into(),
        new_writer_epoch: "metrics-epoch".into(),
        now_iso: NOW.into(),
        now_ms: 200,
    }
}
fn rows(g: &DatabaseGateway, sql: &str) -> Vec<Vec<V>> {
    g.query(sql.into(), vec![], None, CLIENT.into())
        .unwrap()
        .rows
}
fn projection(revision: u64) -> NodeProjection {
    NodeProjection {
        content_json: r#"{"type":"doc","content":[{"type":"paragraph","attrs":{"id":"p"},"content":[{"type":"text","text":"你好 world"}]}]}"#.into(),
        outline_json: "[]".into(),
        word_count: 3,
        basis_hash: HASH.into(),
        revision,
    }
}

#[test]
fn workspace_metrics_materialize_reuse_and_stale_revision() {
    let dir = tempfile::tempdir().unwrap();
    let g = DatabaseGateway::new(dir.path().into()).unwrap();
    g.open("metrics.db".into(), CLIENT.into(), false).unwrap();
    let store = WorkspaceStore::new(&g, CLIENT);
    let c = context();
    store
        .create_project(
            &c,
            CreateProject {
                user_id: "local-user".into(),
                name: "字数".into(),
                default_kv_ids: std::array::from_fn(|i| format!("metrics-fact-{i}")),
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
                seed: ChapterSeed {
                    update: STANDARD.decode(SEED).unwrap(),
                    content_json: CACHE.into(),
                },
            },
        )
        .unwrap();
    let journal = rows(&g, "SELECT count(*) FROM sync_change_set");
    // A freshly created chapter is at revision 1 with a zero seed count.
    assert!(store
        .materialize_node_projection(&c.project_id, "chapter", &projection(2), LATER, true)
        .unwrap_err()
        .contains("STALE_PROSE_METRIC_REVISION"));
    assert!(store
        .materialize_node_projection(&c.project_id, "chapter", &projection(1), LATER, true)
        .unwrap());
    assert_eq!(
        rows(&g, "SELECT n.word_count,n.word_count_basis_kind,n.word_count_basis_hash,n.word_count_basis_revision,n.updated_at,c.outline_json,c.updated_at FROM book_node n JOIN node_content c ON c.node_id=n.id"),
        vec![vec![V::Integer("3".into()), V::Text("yjs".into()), V::Text(HASH.into()), V::Integer("1".into()),
            V::Text(LATER.into()), V::Text("[]".into()), V::Text(LATER.into())]]
    );
    let before = rows(&g, "SELECT * FROM book_node");
    assert!(
        !store
            .materialize_node_projection(
                &c.project_id,
                "chapter",
                &projection(1),
                "2026-09-27T02:00:00.000Z",
                true
            )
            .unwrap(),
        "an exact projection is reused"
    );
    assert_eq!(rows(&g, "SELECT * FROM book_node"), before);
    // Reconciliation writes the projection without touching updated_at.
    let mut changed = projection(1);
    changed.word_count = 4;
    assert!(store
        .materialize_node_projection(
            &c.project_id,
            "chapter",
            &changed,
            "2026-09-27T03:00:00.000Z",
            false
        )
        .unwrap());
    assert_eq!(
        rows(&g, "SELECT n.word_count,n.updated_at,c.updated_at FROM book_node n JOIN node_content c ON c.node_id=n.id"),
        vec![vec![V::Integer("4".into()), V::Text(LATER.into()), V::Text(LATER.into())]]
    );
    assert_eq!(
        rows(&g, "SELECT count(*) FROM sync_change_set"),
        journal,
        "projections write no originals"
    );
    assert_eq!(
        store.node_word_counts(&c.project_id).unwrap(),
        vec![NodeWordCount {
            node_id: "chapter".into(),
            kind: "chapter".into(),
            word_count: Some(4)
        }]
    );
    store.trash_chapter(&c, "chapter").unwrap();
    assert!(store
        .materialize_node_projection(&c.project_id, "chapter", &projection(1), LATER, true)
        .is_err());
    assert!(store.node_word_counts(&c.project_id).unwrap().is_empty());
}
