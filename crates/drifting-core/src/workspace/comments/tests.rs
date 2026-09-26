use super::*;
use crate::original_operation::{verify_change_set, ChangeSetRef};
use base64::{engine::general_purpose::STANDARD, Engine};

const CLIENT: &str = "synthetic-chapter-comments";
const NOW: &str = "2026-09-27T00:00:00.000Z";
// Synthetic Yjs client 440002, one empty paragraph with a stable block ID.
const SEED: &str =
    "AQPC7RoABwEHZGVmYXVsdAMJcGFyYWdyYXBoBwDC7RoABigAwu0aAAJpZAF3FXRyYXNoLXN5bnRoZXRpYy1ibG9jawA=";
const ANCHOR: &str = r#"{"selectedText":"雨夜🙂","createdAt":"2026-09-27T00:00:00.000Z","blockSnapshots":[{"blockId":"trash-synthetic-block","blockText":"雨夜🙂来信"}],"textAnchor":{"startBlockId":"trash-synthetic-block","startOffset":0,"endBlockId":"trash-synthetic-block","endOffset":4,"text":"雨夜🙂"},"unknownField":{"kept":true}}"#;

fn context() -> AuthoredProseContext {
    AuthoredProseContext {
        project_id: "comments-project".into(),
        project_sync_id: "comments-project-sync".into(),
        sync_generation_id: "comments-generation".into(),
        installation_id: "comments-installation".into(),
        new_writer_id: "comments-writer".into(),
        new_writer_epoch: "comments-epoch".into(),
        now_iso: NOW.into(),
        now_ms: 200,
    }
}
fn rows(g: &DatabaseGateway, sql: &str) -> Vec<Vec<V>> {
    g.query(sql.into(), vec![], None, CLIENT.into())
        .unwrap()
        .rows
}
fn exec(g: &DatabaseGateway, sql: &str) {
    g.execute(sql.into(), vec![], None, CLIENT.into()).unwrap();
}
fn database() -> (tempfile::TempDir, DatabaseGateway) {
    let dir = tempfile::tempdir().unwrap();
    let g = DatabaseGateway::new(dir.path().into()).unwrap();
    g.open("comments.db".into(), CLIENT.into(), false).unwrap();
    let store = WorkspaceStore::new(&g, CLIENT);
    let c = context();
    store
        .create_project(
            &c,
            CreateProject {
                user_id: "local-user".into(),
                name: "合成批注".into(),
                default_kv_ids: std::array::from_fn(|i| format!("comments-fact-{i}")),
            },
        )
        .unwrap();
    for id in ["chapter-a", "chapter-b"] {
        store.create_chapter(&c,CreateChapter {
            id:id.into(),title:id.into(),book_order:None,
            seed:ChapterSeed { update:STANDARD.decode(SEED).unwrap(),
                content_json:r#"{"type":"doc","content":[{"type":"paragraph","attrs":{"id":"trash-synthetic-block"}}]}"#.into() },
        }).unwrap();
    }
    (dir, g)
}
fn prose(g: &DatabaseGateway) -> Vec<Vec<Vec<V>>> {
    [
        "book_node",
        "node_content",
        "yjs_snapshots",
        "yjs_updates",
        "yjs_document_revision",
        "yjs_document_revision_provenance",
    ]
    .iter()
    .map(|table| rows(g, &format!("SELECT * FROM {table} ORDER BY rowid")))
    .collect()
}
fn state(g: &DatabaseGateway) -> Vec<Vec<Vec<V>>> {
    let mut value = prose(g);
    value.extend(
        [
            "comment",
            "sync_generation_writer_state",
            "sync_change_set",
            "sync_mutation",
            "sync_apply_receipt",
            "sync_entity_lifecycle",
            "sync_field_clock",
        ]
        .iter()
        .map(|table| rows(g, &format!("SELECT * FROM {table} ORDER BY rowid"))),
    );
    value
}
fn latest(g: &DatabaseGateway) -> crate::original_operation::VerifiedChangeSet {
    let row=&rows(g,"SELECT change_set_id,payload_sha256,encoded_bytes FROM sync_change_set ORDER BY device_seq DESC LIMIT 1")[0];
    let V::Blob(bytes) = &row[2] else {
        panic!("canonical original bytes")
    };
    let c = context();
    verify_change_set(
        bytes,
        &ChangeSetRef {
            project_id: c.project_id,
            project_sync_id: c.project_sync_id,
            sync_generation_id: c.sync_generation_id,
            change_set_id: string(row, 0).unwrap(),
            original_envelope_sha256: string(row, 1).unwrap(),
        },
    )
    .unwrap()
}
fn new_comment(id: &str, chapter: &str, body: &str) -> NewChapterComment {
    NewChapterComment {
        id: id.into(),
        chapter_id: chapter.into(),
        author_id: "local-user".into(),
        body_text: body.into(),
        anchor_json: ANCHOR.into(),
        target_block_ids: vec!["trash-synthetic-block".into()],
    }
}

#[test]
fn workspace_comments_plain_body_matches_renderer_document() {
    assert_eq!(
        plain_comment_doc("  第一段\n继续🙂\n\n\n  第二段 \"引号\"\t \n"),
        r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"第一段 继续🙂"}]},{"type":"paragraph","content":[{"type":"text","text":"第二段 \"引号\""}]}]}"#
    );
    assert_eq!(
        plain_comment_doc(" \n "),
        r#"{"type":"doc","content":[{"type":"paragraph","content":[]}]}"#
    );
}

#[test]
fn workspace_comments_create_list_and_cold_reopen() {
    let (_dir, g) = database();
    let store = WorkspaceStore::new(&g, CLIENT);
    let c = context();
    let before = prose(&g);
    exec(&g,"INSERT INTO comment(id,project_id,target_kind,target_id,anchor_json,body_json,created_at,updated_at) VALUES ('other-chapter-note','comments-project','node','chapter-b','{}','{}','2026-01-01','2026-01-01')");
    let created = store
        .create_chapter_comment(
            &c,
            new_comment("note-a", "chapter-a", " 核对雨夜🙂\n\n再看一遍 "),
        )
        .unwrap();
    assert_eq!(created.status, "open");
    assert_eq!(
        created.target_block_ids_json,
        r#"["trash-synthetic-block"]"#
    );
    let wire = latest(&g);
    assert_eq!(wire.mutations().len(), 1);
    let m = &wire.mutations()[0];
    assert_eq!(m.action(), "entity.create");
    assert_eq!(
        (
            m.target().kind.as_str(),
            m.target().id.as_str(),
            m.target().incarnation
        ),
        ("comment", "note-a", 0)
    );
    assert_eq!(
        m.payload_json().unwrap(),
        json!({"seed":{"kind":"note","targetKind":"node","targetId":"chapter-a",
            "targetBlockId":"trash-synthetic-block","anchorJson":ANCHOR,"authorKind":"user",
            "authorId":"local-user","authorName":null,"bodyJson":plain_comment_doc("核对雨夜🙂\n\n再看一遍"),
            "status":"open","priority":null,"source":"manual","metadataJson":null,
            "targetBlockIdsJson":"[\"trash-synthetic-block\"]","resolvedAt":null}})
    );
    assert_eq!(
        rows(&g, "SELECT state,incarnation FROM sync_entity_lifecycle WHERE entity_kind='comment' AND entity_id='note-a'"),
        vec![vec![text("live"), integer(0)]]
    );
    assert_eq!(prose(&g), before);
    g.close(CLIENT.into()).unwrap();
    g.open("comments.db".into(), CLIENT.into(), false).unwrap();
    assert_eq!(
        store.chapter_comments(&c.project_id, "chapter-a").unwrap(),
        vec![created]
    );
    assert_eq!(
        store.chapter_comments(&c.project_id, "chapter-b").unwrap()[0].id,
        "other-chapter-note"
    );
}

#[test]
fn workspace_comments_body_and_status_keep_anchor_metadata_and_prose() {
    let (_dir, g) = database();
    let store = WorkspaceStore::new(&g, CLIENT);
    let c = context();
    store
        .create_chapter_comment(&c, new_comment("note-a", "chapter-a", "旧正文"))
        .unwrap();
    // A pre-lifecycle row with metadata written by another source.
    exec(&g,"INSERT INTO comment(id,project_id,kind,target_kind,target_id,anchor_json,author_kind,body_json,source,metadata_json,created_at,updated_at) VALUES ('legacy-note','comments-project','note','node','chapter-a','{\"kept\":1}','ai','{}','api','{\"x\":2}','2026-01-01','2026-01-01')");
    let before = prose(&g);
    let edited = store
        .update_chapter_comment_body(&c, "chapter-a", "note-a", "新正文\n第二行")
        .unwrap();
    assert_eq!(edited.anchor_json, ANCHOR);
    let wire = latest(&g);
    assert_eq!(wire.mutations().len(), 1);
    assert_eq!(wire.mutations()[0].action(), "field.set");
    assert_eq!(
        wire.mutations()[0].payload_json().unwrap(),
        json!({"field":"bodyJson","value":plain_comment_doc("新正文 第二行")})
    );
    let unchanged = state(&g);
    store
        .update_chapter_comment_body(&c, "chapter-a", "note-a", " 新正文\n第二行 ")
        .unwrap();
    assert_eq!(state(&g), unchanged);

    let resolved = store
        .set_chapter_comment_resolved(&c, "chapter-a", "note-a", true)
        .unwrap();
    assert_eq!(
        (resolved.status.as_str(), resolved.resolved_at.as_deref()),
        ("resolved", Some(NOW))
    );
    let wire = latest(&g);
    assert_eq!(
        wire.mutations()
            .iter()
            .map(|m| m.payload_json().unwrap())
            .collect::<Vec<_>>(),
        vec![
            json!({"field":"resolvedAt","value":NOW}),
            json!({"field":"status","value":"resolved"})
        ]
    );
    let unchanged = state(&g);
    store
        .set_chapter_comment_resolved(&c, "chapter-a", "note-a", true)
        .unwrap();
    assert_eq!(state(&g), unchanged);
    let reopened = store
        .set_chapter_comment_resolved(&c, "chapter-a", "note-a", false)
        .unwrap();
    assert_eq!(
        (reopened.status.as_str(), reopened.resolved_at),
        ("open", None)
    );
    assert_eq!(
        latest(&g)
            .mutations()
            .iter()
            .map(|m| m.payload_json().unwrap())
            .collect::<Vec<_>>(),
        vec![
            json!({"field":"resolvedAt","value":null}),
            json!({"field":"status","value":"open"})
        ]
    );

    let legacy = store
        .set_chapter_comment_resolved(&c, "chapter-a", "legacy-note", true)
        .unwrap();
    assert_eq!(legacy.anchor_json, r#"{"kept":1}"#);
    assert_eq!(legacy.metadata_json.as_deref(), Some(r#"{"x":2}"#));
    assert_eq!(
        (legacy.author_kind.as_str(), legacy.source.as_str()),
        ("ai", "api")
    );
    assert!(latest(&g)
        .mutations()
        .iter()
        .all(|m| m.target().incarnation == 0));
    assert_eq!(prose(&g), before);
    let comments = store.chapter_comments(&c.project_id, "chapter-a").unwrap();
    assert_eq!(
        comments.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
        ["legacy-note", "note-a"]
    );
}

#[test]
fn workspace_comments_receipt_failures_and_invalid_targets_rollback() {
    let (_dir, g) = database();
    let store = WorkspaceStore::new(&g, CLIENT);
    let c = context();
    for command in ["create", "body", "resolve"] {
        exec(&g,"CREATE TRIGGER fail_comment_receipt BEFORE INSERT ON sync_apply_receipt BEGIN SELECT RAISE(ABORT,'comment receipt fault'); END");
        let before = state(&g);
        let apply = || match command {
            "create" => {
                store.create_chapter_comment(&c, new_comment("retry-note", "chapter-a", "重试"))
            }
            "body" => store.update_chapter_comment_body(&c, "chapter-a", "retry-note", "改后"),
            _ => store.set_chapter_comment_resolved(&c, "chapter-a", "retry-note", true),
        };
        assert!(apply().unwrap_err().contains("comment receipt fault"));
        assert_eq!(state(&g), before);
        exec(&g, "DROP TRIGGER fail_comment_receipt");
        apply().unwrap();
    }
    exec(&g,"INSERT INTO comment(id,project_id,target_kind,target_id,anchor_json,body_json,status,source,created_at,updated_at) VALUES ('converted-note','comments-project','node','chapter-a','{}','{}','converted','copilot','2026-01-01','2026-01-01')");
    let before = state(&g);
    let mut wrong = c.clone();
    wrong.project_sync_id = "wrong-sync".into();
    assert!(store
        .update_chapter_comment_body(&wrong, "chapter-a", "retry-note", "x")
        .is_err());
    assert!(store
        .create_chapter_comment(&c, new_comment("retry-note", "chapter-a", "重复"))
        .unwrap_err()
        .contains("already exists"));
    assert!(store
        .create_chapter_comment(&c, new_comment("foreign-note", "missing-chapter", "x"))
        .is_err());
    assert!(store
        .create_chapter_comment(&c, new_comment("empty-note", "chapter-a", " \n\t"))
        .is_err());
    let mut bad_anchor = new_comment("bad-anchor", "chapter-a", "x");
    bad_anchor.anchor_json = "[]".into();
    assert!(store.create_chapter_comment(&c, bad_anchor).is_err());
    assert!(store
        .update_chapter_comment_body(&c, "chapter-b", "retry-note", "x")
        .unwrap_err()
        .contains("not on this chapter"));
    assert!(store
        .set_chapter_comment_resolved(&c, "chapter-a", "converted-note", false)
        .unwrap_err()
        .contains("converted"));
    assert!(store
        .update_chapter_comment_body(&c, "chapter-a", "retry-note", "  ")
        .is_err());
    assert_eq!(state(&g), before);
}
