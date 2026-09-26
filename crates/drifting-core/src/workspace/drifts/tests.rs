use super::*;
use crate::original_operation::{verify_change_set, ChangeSetRef};
use base64::{engine::general_purpose::STANDARD, Engine};

const CLIENT: &str = "synthetic-drifts";
const NOW: &str = "2026-09-27T00:00:00.000Z";
const SEED: &str =
    "AQPC7RoABwEHZGVmYXVsdAMJcGFyYWdyYXBoBwDC7RoABigAwu0aAAJpZAF3FXRyYXNoLXN5bnRoZXRpYy1ibG9jawA=";
const CACHE: &str =
    r#"{"type":"doc","content":[{"type":"paragraph","attrs":{"id":"trash-synthetic-block"}}]}"#;

fn context() -> AuthoredProseContext {
    AuthoredProseContext {
        project_id: "drift-project".into(),
        project_sync_id: "drift-project-sync".into(),
        sync_generation_id: "drift-generation".into(),
        installation_id: "drift-installation".into(),
        new_writer_id: "drift-writer".into(),
        new_writer_epoch: "drift-epoch".into(),
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
    g.open("drifts.db".into(), CLIENT.into(), false).unwrap();
    let store = WorkspaceStore::new(&g, CLIENT);
    let c = context();
    store
        .create_project(
            &c,
            CreateProject {
                user_id: "local-user".into(),
                name: "合成漂流".into(),
                default_kv_ids: std::array::from_fn(|i| format!("drift-fact-{i}")),
            },
        )
        .unwrap();
    store
        .create_chapter(
            &c,
            CreateChapter {
                id: "chapter".into(),
                title: "New Drift".into(),
                book_order: Some(1.0),
                seed: seed(),
            },
        )
        .unwrap();
    (dir, g)
}
fn state(g: &DatabaseGateway) -> Vec<Vec<Vec<V>>> {
    [
        "book_node",
        "node_content",
        "book_act",
        "drift_group",
        "timeline_marker",
        "sync_change_set",
        "sync_mutation",
        "sync_entity_lifecycle",
        "sync_field_clock",
        "sync_order_register",
        "yjs_updates",
    ]
    .iter()
    .map(|t| rows(g, &format!("SELECT * FROM {t} ORDER BY rowid")))
    .collect()
}
fn changes(g: &DatabaseGateway, count: usize) -> Vec<Vec<(String, String, u64, Value)>> {
    let c = context();
    let mut sets: Vec<_> = rows(g, &format!("SELECT change_set_id,payload_sha256,encoded_bytes FROM sync_change_set ORDER BY device_seq DESC LIMIT {count}"))
        .iter()
        .map(|row| {
            let V::Blob(bytes) = &row[2] else { panic!("original") };
            verify_change_set(bytes, &ChangeSetRef { project_id: c.project_id.clone(), project_sync_id: c.project_sync_id.clone(),
                sync_generation_id: c.sync_generation_id.clone(), change_set_id: string(row, 0).unwrap(),
                original_envelope_sha256: string(row, 1).unwrap() }).unwrap()
                .mutations().iter()
                .map(|m| (m.action().to_string(), format!("{}:{}", m.target().kind, m.target().id), m.target().incarnation,
                    m.payload_json().unwrap_or(Value::Null)))
                .collect::<Vec<_>>()
        })
        .collect();
    sets.reverse();
    sets
}
fn latest(g: &DatabaseGateway) -> Vec<(String, String, u64, Value)> {
    changes(g, 1).remove(0)
}
fn drift(
    store: &WorkspaceStore<'_>,
    id: &str,
    title: Option<&str>,
    group: Option<&str>,
) -> Result<WorkspaceDrift, String> {
    store.create_drift(
        &context(),
        NewDrift {
            id: id.into(),
            title: title.map(Into::into),
            group_id: group.map(Into::into),
            seed: seed(),
        },
    )
}

#[test]
fn workspace_drifts_create_rename_and_group_moves() {
    let (_dir, g) = database();
    let store = WorkspaceStore::new(&g, CLIENT);
    let c = context();
    // Chapters and drifts share one title namespace.
    let first = drift(&store, "drift-a", None, None).unwrap();
    assert_eq!(first.title, "New Drift 2");
    assert_eq!(
        latest(&g)
            .into_iter()
            .map(|m| (m.0, m.1, m.3))
            .collect::<Vec<_>>(),
        vec![
            (
                "entity.create".into(),
                "node:drift-a".into(),
                json!({"seed":{"bookOrder":null,"driftGroupId":null,"kind":"drift",
            "narrativeOrder":null,"summary":"","title":"New Drift 2","writingStatus":"drifting"}})
            ),
            (
                "yjs.update".into(),
                "prose-document:node-content:drift-a".into(),
                Value::Null
            ),
        ]
    );
    assert_eq!(
        rows(
            &g,
            "SELECT kind,book_order,writing_status FROM book_node WHERE id='drift-a'"
        ),
        vec![vec![text("drift"), V::Null, text("drifting")]]
    );
    assert!(
        store
            .list_chapters(&c.project_id)
            .unwrap()
            .iter()
            .all(|ch| ch.id != "drift-a"),
        "drifts are not chapters"
    );
    store.create_drift_group(&c, "ideas", " ", None).unwrap();
    let ideas = store.drift_groups(&c.project_id).unwrap();
    assert_eq!(
        (ideas[0].name.as_str(), ideas[0].sort_order),
        ("新分组", Some(0.0))
    );
    let moved = store
        .update_drift(&c, "drift-a", Some("雨夜的灵感🙂"), Some(Some("ideas")))
        .unwrap();
    assert_eq!(
        (moved.title.as_str(), moved.drift_group_id.as_deref()),
        ("雨夜的灵感🙂", Some("ideas"))
    );
    assert_eq!(
        latest(&g).into_iter().map(|m| m.3).collect::<Vec<_>>(),
        vec![
            json!({"field":"driftGroupId","value":"ideas"}),
            json!({"field":"title","value":"雨夜的灵感🙂"})
        ]
    );
    let unchanged = state(&g);
    store
        .update_drift(&c, "drift-a", Some("雨夜的灵感🙂"), None)
        .unwrap();
    assert_eq!(state(&g), unchanged);
    let grouped = drift(&store, "drift-b", Some("北塔"), Some("ideas")).unwrap();
    assert_eq!(grouped.drift_group_id.as_deref(), Some("ideas"));
    // renameNode: a colliding title is suffixed and the node revision moves
    // past its previous stamp even within one millisecond.
    let renamed = store
        .update_drift(&c, "drift-b", Some("雨夜的灵感🙂"), None)
        .unwrap();
    assert_eq!(
        (renamed.title.as_str(), renamed.updated_at.as_str()),
        ("雨夜的灵感🙂 2", "2026-09-27T00:00:00.001Z")
    );
    assert_eq!(
        latest(&g).into_iter().map(|m| m.3).collect::<Vec<_>>(),
        vec![json!({"field":"title","value":"雨夜的灵感🙂 2"})]
    );
    // moveDriftToGroup: the wall-clock stamp and only the group field.
    let moved = store.update_drift(&c, "drift-b", None, Some(None)).unwrap();
    assert_eq!(
        (moved.drift_group_id.as_deref(), moved.updated_at.as_str()),
        (None, NOW)
    );
    assert_eq!(
        latest(&g).into_iter().map(|m| m.3).collect::<Vec<_>>(),
        vec![json!({"field":"driftGroupId","value":null})]
    );
    let unchanged = state(&g);
    store.update_drift(&c, "drift-b", None, Some(None)).unwrap();
    assert_eq!(state(&g), unchanged);
    // updateNode: both fields at once keep the title as given, journal both.
    let both = store
        .update_drift(&c, "drift-b", Some("雨夜的灵感🙂"), Some(None))
        .unwrap();
    assert_eq!(
        (both.title.as_str(), both.updated_at.as_str()),
        ("雨夜的灵感🙂", "2026-09-27T00:00:00.001Z")
    );
    assert_eq!(
        latest(&g).into_iter().map(|m| m.3).collect::<Vec<_>>(),
        vec![
            json!({"field":"driftGroupId","value":null}),
            json!({"field":"title","value":"雨夜的灵感🙂"})
        ]
    );
    assert!(drift(&store, "drift-c", None, Some("missing")).is_err());
}

#[test]
fn workspace_drifts_groups_nest_once_and_delete_lifts_children() {
    let (_dir, g) = database();
    let store = WorkspaceStore::new(&g, CLIENT);
    let c = context();
    store.create_drift_group(&c, "alpha", "甲", None).unwrap();
    assert_eq!(
        latest(&g)
            .into_iter()
            .map(|m| (m.0, m.3))
            .collect::<Vec<_>>(),
        vec![
            (
                "entity.create".into(),
                json!({"seed":{"color":null,"name":"甲","parentGroupId":null}})
            ),
            (
                "order.move".into(),
                json!({"scope":r#"["drift-project",null]"#,"positionKey":"a0"})
            ),
        ]
    );
    store.create_drift_group(&c, "beta", "乙", None).unwrap();
    store
        .create_drift_group(&c, "child", "子", Some("alpha"))
        .unwrap();
    assert_eq!(
        latest(&g)[1].3,
        json!({"scope":r#"["drift-project","alpha"]"#,"positionKey":"a0"})
    );
    assert!(store
        .create_drift_group(&c, "grandchild", "孙", Some("child"))
        .unwrap_err()
        .contains("one level"));
    store.rename_drift_group(&c, "beta", "乙组").unwrap();
    assert_eq!(latest(&g)[0].3, json!({"field":"name","value":"乙组"}));
    // renameGroup: a blank name falls back to the default name.
    assert_eq!(
        store.rename_drift_group(&c, "beta", " ").unwrap().name,
        "新分组"
    );
    assert_eq!(latest(&g)[0].3, json!({"field":"name","value":"新分组"}));
    // Members rise in the store's id order, not creation order.
    drift(&store, "member", Some("组内"), Some("alpha")).unwrap();
    drift(&store, "a-member", Some("组内二"), Some("alpha")).unwrap();
    store.delete_drift_group(&c, "alpha").unwrap();
    let scope = r#"["drift-project",null]"#;
    assert_eq!(
        latest(&g)
            .into_iter()
            .map(|m| (m.0, m.1, m.3))
            .collect::<Vec<_>>(),
        vec![
            (
                "field.set".into(),
                "drift-group:child".into(),
                json!({"field":"parentGroupId","value":null})
            ),
            (
                "order.rebalance".into(),
                "drift-group:beta".into(),
                json!({"scope":scope,"entries":[{"entityId":"beta","positionKey":"a0"}]})
            ),
            (
                "order.rebalance".into(),
                "drift-group:child".into(),
                json!({"scope":scope,"entries":[{"entityId":"child","positionKey":"a1"}]})
            ),
            (
                "field.set".into(),
                "node:a-member".into(),
                json!({"field":"driftGroupId","value":null})
            ),
            (
                "field.set".into(),
                "node:member".into(),
                json!({"field":"driftGroupId","value":null})
            ),
            ("entity.purge".into(), "drift-group:alpha".into(), json!({})),
        ]
    );
    let groups = store.drift_groups(&c.project_id).unwrap();
    assert_eq!(
        groups
            .iter()
            .map(|g| (g.id.as_str(), g.parent_group_id.as_deref(), g.sort_order))
            .collect::<Vec<_>>(),
        [("beta", None, Some(0.0)), ("child", None, Some(1.0))]
    );
    assert_eq!(
        store.drifts(&c.project_id).unwrap()[0].drift_group_id,
        None,
        "no drift is lost"
    );
}

#[test]
fn workspace_drifts_act_binding_trash_and_restore() {
    let (_dir, g) = database();
    let store = WorkspaceStore::new(&g, CLIENT);
    let c = context();
    drift(&store, "notes", Some("幕笔记"), None).unwrap();
    drift(&store, "other", Some("另一条"), None).unwrap();
    store
        .create_act_before_chapter(&c, "act", "chapter")
        .unwrap();
    let bound = store.bind_act_drift(&c, "act", Some("notes")).unwrap();
    assert_eq!(bound.drift_node_id.as_deref(), Some("notes"));
    assert_eq!(
        latest(&g)[0].3,
        json!({"field":"driftNodeId","value":"notes"})
    );
    assert_eq!(
        store.drifts(&c.project_id).unwrap()[0].act_id.as_deref(),
        Some("act")
    );
    store
        .create_chapter(
            &c,
            CreateChapter {
                id: "later".into(),
                title: "后章".into(),
                book_order: Some(2.0),
                seed: seed(),
            },
        )
        .unwrap();
    store
        .create_act_before_chapter(&c, "second-act", "later")
        .unwrap();
    assert!(store
        .bind_act_drift(&c, "second-act", Some("notes"))
        .unwrap_err()
        .contains("already bound"));
    assert!(
        store
            .bind_act_drift(&c, "second-act", Some("chapter"))
            .is_err(),
        "only drifts bind"
    );
    // Trash: markers, then the act, are unbound in originals of their own
    // (rowid order); a blank marker caption takes the drift title.
    exec(&g, "INSERT INTO timeline_marker(id,project_id,narrative_order,label,drift_node_id,created_at,updated_at) VALUES \
        ('z-marker','drift-project',1,' ','notes','t','t'),('a-marker','drift-project',2,'晨','notes','t','t'),\
        ('free-marker','drift-project',3,'','other','t','t')");
    exec(&g, "CREATE TRIGGER fail_drift_receipt BEFORE INSERT ON sync_apply_receipt BEGIN SELECT RAISE(ABORT,'drift receipt fault'); END");
    let before = state(&g);
    assert!(store
        .trash_drift(&c, "notes")
        .unwrap_err()
        .contains("drift receipt fault"));
    assert_eq!(state(&g), before);
    exec(&g, "DROP TRIGGER fail_drift_receipt");
    store.trash_drift(&c, "notes").unwrap();
    assert_eq!(
        changes(&g, 3)
            .into_iter()
            .map(|set| set.into_iter().map(|m| (m.0, m.1, m.3)).collect::<Vec<_>>())
            .collect::<Vec<_>>(),
        vec![
            vec![
                (
                    "field.set".into(),
                    "timeline-marker:z-marker".into(),
                    json!({"field":"driftNodeId","value":null})
                ),
                (
                    "field.set".into(),
                    "timeline-marker:z-marker".into(),
                    json!({"field":"label","value":"幕笔记"})
                ),
                (
                    "field.set".into(),
                    "timeline-marker:a-marker".into(),
                    json!({"field":"driftNodeId","value":null})
                ),
                (
                    "field.set".into(),
                    "timeline-marker:a-marker".into(),
                    json!({"field":"label","value":"晨"})
                ),
            ],
            vec![(
                "field.set".into(),
                "book-act:act".into(),
                json!({"field":"driftNodeId","value":null})
            )],
            vec![("entity.trash".into(), "node:notes".into(), json!({}))],
        ]
    );
    assert_eq!(
        rows(
            &g,
            "SELECT id,label,drift_node_id FROM timeline_marker ORDER BY rowid"
        ),
        [["z-marker", "幕笔记"], ["a-marker", "晨"]]
            .iter()
            .map(|[id, label]| vec![V::Text((*id).into()), V::Text((*label).into()), V::Null])
            .chain([vec![
                V::Text("free-marker".into()),
                V::Text(String::new()),
                V::Text("other".into())
            ]])
            .collect::<Vec<_>>()
    );
    assert_eq!(store.trashed_drifts(&c.project_id).unwrap()[0].id, "notes");
    assert!(store.update_drift(&c, "notes", Some("x"), None).is_err());
    let restored = store
        .restore_drift(&c, "notes", |repo, tx, doc| {
            assert_eq!(doc, "node-content:notes");
            Ok(ChapterSeed {
                update: repo.list_updates(doc, None, Some(tx))?[0]
                    .update_blob
                    .clone(),
                content_json: CACHE.into(),
            })
        })
        .unwrap();
    assert_eq!(restored.act_id, None, "restore does not rebind");
    assert_eq!(
        latest(&g)
            .into_iter()
            .map(|m| (m.0, m.2, m.3))
            .collect::<Vec<_>>(),
        vec![
            (
                "entity.restore".into(),
                1,
                json!({"seed":{"bookOrder":null,"driftGroupId":null,"kind":"drift","narrativeOrder":null,
            "summary":"","title":"幕笔记","writingStatus":"drifting"}})
            ),
            (
                "tuple.set".into(),
                1,
                json!({"tuple":"graph.position","value":{"x":0.0,"y":0.0}})
            ),
            ("yjs.update".into(), 1, Value::Null),
        ]
    );
    assert_eq!(
        store.bind_act_drift(&c, "act", None).unwrap().drift_node_id,
        None
    );
}
