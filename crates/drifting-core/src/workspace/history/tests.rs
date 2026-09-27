use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};

const CLIENT: &str = "synthetic-history";
const SEED: &str =
    "AQPC7RoABwEHZGVmYXVsdAMJcGFyYWdyYXBoBwDC7RoABigAwu0aAAJpZAF3FXRyYXNoLXN5bnRoZXRpYy1ibG9jawA=";
const CACHE: &str =
    r#"{"type":"doc","content":[{"type":"paragraph","attrs":{"id":"trash-synthetic-block"}}]}"#;

fn context(now: &str) -> AuthoredProseContext {
    AuthoredProseContext {
        project_id: "history-project".into(),
        project_sync_id: "history-project-sync".into(),
        sync_generation_id: "history-generation".into(),
        installation_id: "history-installation".into(),
        new_writer_id: "history-writer".into(),
        new_writer_epoch: "history-epoch".into(),
        now_iso: now.into(),
        now_ms: 200,
    }
}
fn capture<'a>(id: &'a str, state: &'a [u8], reason: &'a str, now: &'a str) -> SnapshotCapture<'a> {
    SnapshotCapture {
        id,
        entity_kind: "node",
        entity_id: "chapter",
        state,
        content_json: Some("{}"),
        reason,
        now_iso: now,
    }
}

#[test]
fn workspace_history_captures_thins_and_reads_versions() {
    let dir = tempfile::tempdir().unwrap();
    let g = DatabaseGateway::new(dir.path().into()).unwrap();
    g.open("history.db".into(), CLIENT.into(), false).unwrap();
    let store = WorkspaceStore::new(&g, CLIENT);
    let c = context("2026-09-01T00:00:00.000Z");
    store
        .create_project(
            &c,
            CreateProject {
                user_id: "local-user".into(),
                name: "历史".into(),
                default_kv_ids: std::array::from_fn(|i| format!("history-fact-{i}")),
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
    let p = &c.project_id;
    assert!(store
        .capture_snapshot(
            p,
            capture("s1", b"a", "periodic", "2026-09-01T10:00:00.000Z")
        )
        .unwrap());
    assert!(
        !store
            .capture_snapshot(p, capture("s2", b"a", "close", "2026-09-01T11:00:00.000Z"))
            .unwrap(),
        "identical"
    );
    assert!(
        !store
            .capture_snapshot(
                p,
                capture("s3", b"b", "periodic", "2026-09-01T10:10:00.000Z")
            )
            .unwrap(),
        "too soon"
    );
    assert!(
        store
            .capture_snapshot(p, capture("s4", b"b", "close", "2026-09-01T10:10:00.000Z"))
            .unwrap(),
        "close bypasses the interval"
    );
    // Within 24 hours (after the first hour), the newest row per hour survives.
    let ids = |store: &WorkspaceStore<'_>| -> Vec<String> {
        store
            .snapshot_history(p, "node", "chapter")
            .unwrap()
            .into_iter()
            .map(|e| e.id)
            .collect()
    };
    assert_eq!(
        ids(&store),
        ["s4", "s1"],
        "the last hour keeps every version"
    );
    assert!(store
        .capture_snapshot(
            p,
            capture("s5", b"c", "periodic", "2026-09-01T11:30:00.000Z")
        )
        .unwrap());
    assert_eq!(ids(&store), ["s5", "s4"]);
    // Older rows keep one per day; 30 days drops everything older.
    assert!(store
        .capture_snapshot(
            p,
            capture("s6", b"d", "periodic", "2026-09-03T09:00:00.000Z")
        )
        .unwrap());
    assert_eq!(ids(&store), ["s6", "s5"]);
    assert!(store
        .capture_snapshot(
            p,
            capture("s7", b"e", "periodic", "2026-10-15T09:00:00.000Z")
        )
        .unwrap());
    assert_eq!(ids(&store), ["s7"]);
    let entry = &store.snapshot_history(p, "node", "chapter").unwrap()[0];
    assert_eq!(entry.meta["title"], "第一章");
    assert_eq!(
        store.snapshot_state(p, "s7").unwrap(),
        ("node".into(), "chapter".into(), b"e".to_vec())
    );
    assert!(store.snapshot_state(p, "missing").is_err());
    // A trashed or unknown entity records nothing.
    store.trash_chapter(&c, "chapter").unwrap();
    assert!(!store
        .capture_snapshot(p, capture("s8", b"f", "close", "2026-10-15T10:00:00.000Z"))
        .unwrap());
}
