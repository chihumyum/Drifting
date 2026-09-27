use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};

const CLIENT: &str = "synthetic-deletion";
const SEED: &str =
    "AQPC7RoABwEHZGVmYXVsdAMJcGFyYWdyYXBoBwDC7RoABigAwu0aAAJpZAF3FXRyYXNoLXN5bnRoZXRpYy1ibG9jawA=";
const CACHE: &str =
    r#"{"type":"doc","content":[{"type":"paragraph","attrs":{"id":"trash-synthetic-block"}}]}"#;

fn context(name: &str) -> AuthoredProseContext {
    AuthoredProseContext {
        project_id: format!("{name}-project"),
        project_sync_id: format!("{name}-project-sync"),
        sync_generation_id: format!("{name}-generation"),
        installation_id: "deletion-installation".into(),
        new_writer_id: format!("{name}-writer"),
        new_writer_epoch: "deletion-epoch".into(),
        now_iso: "2026-09-01T00:00:00.000Z".into(),
        now_ms: 200,
    }
}

fn count(g: &DatabaseGateway, sql: &str) -> i64 {
    match &g
        .query(sql.into(), vec![], None, CLIENT.into())
        .unwrap()
        .rows[0][0]
    {
        V::Integer(value) => value.parse().unwrap(),
        other => panic!("{other:?}"),
    }
}

#[test]
fn workspace_project_deletion_purges_one_project_and_keeps_the_journal() {
    let dir = tempfile::tempdir().unwrap();
    let g = DatabaseGateway::new(dir.path().into()).unwrap();
    g.open("deletion.db".into(), CLIENT.into(), false).unwrap();
    let store = WorkspaceStore::new(&g, CLIENT);
    let (doomed, kept) = (context("doomed"), context("kept"));
    for (c, chapter) in [(&doomed, "doomed-chapter"), (&kept, "kept-chapter")] {
        store
            .create_project(
                c,
                CreateProject {
                    user_id: "local-user".into(),
                    name: "书".into(),
                    default_kv_ids: std::array::from_fn(|i| format!("{chapter}-fact-{i}")),
                },
            )
            .unwrap();
        store
            .create_chapter(
                c,
                CreateChapter {
                    id: chapter.into(),
                    title: "第一章".into(),
                    book_order: Some(1.0),
                    seed: ChapterSeed {
                        update: STANDARD.decode(SEED).unwrap(),
                        content_json: CACHE.into(),
                    },
                },
            )
            .unwrap();
    }
    store
        .capture_snapshot(
            &doomed.project_id,
            SnapshotCapture {
                id: "doomed-version",
                entity_kind: "node",
                entity_id: "doomed-chapter",
                state: b"state",
                content_json: None,
                reason: "close",
                word_count: None,
                now_iso: "2026-09-01T01:00:00.000Z",
            },
        )
        .unwrap();
    store
        .create_comment(
            &doomed,
            NewComment {
                id: "doomed-todo".into(),
                author_id: "local-user".into(),
                kind: "todo".into(),
                target: None,
                target_block_ids: Vec::new(),
                anchor_json: None,
                body_text: "待办".into(),
                priority: None,
            },
        )
        .unwrap();
    let journal = count(
        &g,
        "SELECT COUNT(*) FROM sync_change_set WHERE sync_generation_id='doomed-generation'",
    );
    let deletion = store.delete_project(&doomed).unwrap();
    assert_eq!(deletion.document_ids, ["node-content:doomed-chapter"]);
    assert!(deletion.asset_ids.is_empty());
    for sql in [
        "SELECT COUNT(*) FROM project WHERE id='doomed-project'",
        "SELECT COUNT(*) FROM book_node WHERE project_id='doomed-project'",
        "SELECT COUNT(*) FROM comment WHERE project_id='doomed-project'",
        "SELECT COUNT(*) FROM entity_snapshot_history WHERE project_id='doomed-project'",
        "SELECT COUNT(*) FROM yjs_updates WHERE document_id='node-content:doomed-chapter'",
        "SELECT COUNT(*) FROM yjs_document_revision WHERE document_id='node-content:doomed-chapter'",
    ] {
        assert_eq!(count(&g, sql), 0, "{sql}");
    }
    // The other project is untouched.
    assert_eq!(store.list_projects("local-user").unwrap().len(), 1);
    assert_eq!(
        count(
            &g,
            "SELECT COUNT(*) FROM yjs_updates WHERE document_id='node-content:kept-chapter'"
        ),
        1
    );
    // The journal survives with one terminal purge, detached from the row.
    assert_eq!(
        count(
            &g,
            "SELECT COUNT(*) FROM sync_change_set WHERE sync_generation_id='doomed-generation'"
        ),
        journal + 1
    );
    assert_eq!(
        count(&g, "SELECT COUNT(*) FROM sync_mutation WHERE action='sync-generation.purge' AND target_id='doomed-generation'"),
        1
    );
    assert_eq!(
        count(&g, "SELECT COUNT(*) FROM sync_generation WHERE sync_generation_id='doomed-generation' AND status='purged' AND project_id IS NULL AND purged_at IS NOT NULL"),
        1
    );
    assert_eq!(
        count(&g, "SELECT COUNT(*) FROM sync_generation_purge WHERE sync_generation_id='doomed-generation'"),
        1
    );
    // A deleted project refuses every later command.
    assert!(store.delete_project(&doomed).is_err());
    assert!(store.rename_project(&doomed, "新名").is_err());
    store.rename_project(&kept, "留下").unwrap();
}
