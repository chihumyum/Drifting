use super::*;
use crate::original_operation::{verify_change_set, ChangeSetRef};
use base64::{engine::general_purpose::STANDARD, Engine};

const CLIENT: &str = "synthetic-storylines";
const NOW: &str = "2026-09-27T00:00:00.000Z";
const SEED: &str =
    "AQPC7RoABwEHZGVmYXVsdAMJcGFyYWdyYXBoBwDC7RoABigAwu0aAAJpZAF3FXRyYXNoLXN5bnRoZXRpYy1ibG9jawA=";
const CACHE: &str =
    r#"{"type":"doc","content":[{"type":"paragraph","attrs":{"id":"trash-synthetic-block"}}]}"#;

fn context() -> AuthoredProseContext {
    AuthoredProseContext {
        project_id: "lines-project".into(),
        project_sync_id: "lines-project-sync".into(),
        sync_generation_id: "lines-generation".into(),
        installation_id: "lines-installation".into(),
        new_writer_id: "lines-writer".into(),
        new_writer_epoch: "lines-epoch".into(),
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
    g.open("lines.db".into(), CLIENT.into(), false).unwrap();
    let store = WorkspaceStore::new(&g, CLIENT);
    let c = context();
    store
        .create_project(
            &c,
            CreateProject {
                user_id: "local-user".into(),
                name: "合成故事线".into(),
                default_kv_ids: std::array::from_fn(|i| format!("lines-fact-{i}")),
            },
        )
        .unwrap();
    for (id, order) in [("chapter-b", 2.0), ("chapter-a", 1.0)] {
        store
            .create_chapter(
                &c,
                CreateChapter {
                    id: id.into(),
                    title: id.into(),
                    book_order: Some(order),
                    seed: seed(),
                },
            )
            .unwrap();
    }
    (dir, g)
}
fn state(g: &DatabaseGateway) -> Vec<Vec<Vec<V>>> {
    [
        "storylines",
        "node_storyline_link",
        "sync_change_set",
        "sync_mutation",
        "sync_entity_lifecycle",
        "sync_set_tag",
        "sync_order_register",
        "sync_field_clock",
        "yjs_updates",
    ]
    .iter()
    .map(|t| rows(g, &format!("SELECT * FROM {t} ORDER BY rowid")))
    .collect()
}
fn latest(g: &DatabaseGateway) -> Vec<(String, String, u64, Value)> {
    let row = &rows(g, "SELECT change_set_id,payload_sha256,encoded_bytes FROM sync_change_set ORDER BY device_seq DESC LIMIT 1")[0];
    let V::Blob(bytes) = &row[2] else {
        panic!("original")
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
    .mutations()
    .iter()
    .map(|m| {
        (
            m.action().to_string(),
            format!("{}:{}", m.target().kind, m.target().id),
            m.target().incarnation,
            m.payload_json().unwrap_or(Value::Null),
        )
    })
    .collect()
}
fn create(store: &WorkspaceStore<'_>, id: &str, name: &str) -> Result<WorkspaceStoryline, String> {
    let mut n = 0;
    store.create_storyline(
        &context(),
        NewStoryline {
            id: id.into(),
            name: name.into(),
            color: "#AA3311".into(),
            seed: seed(),
        },
        &mut || {
            n += 1;
            Ok(format!("{id}-fact-{n}"))
        },
    )
}
fn capture(repo: &ProseRepository<'_>, tx: u64, doc: &str) -> Result<ChapterSeed, String> {
    Ok(ChapterSeed {
        update: repo.list_updates(doc, None, Some(tx))?[0]
            .update_blob
            .clone(),
        content_json: CACHE.into(),
    })
}

#[test]
fn workspace_storylines_first_storyline_becomes_every_chapter_primary() {
    let (_dir, g) = database();
    let store = WorkspaceStore::new(&g, CLIENT);
    let c = context();
    let main = create(&store, "main", " ").unwrap();
    assert_eq!((main.name.as_str(), main.order_key), ("New Storyline", 0));
    let scope = "lines-project";
    assert_eq!(
        latest(&g)
            .into_iter()
            .map(|m| (m.0, m.1, m.3))
            .collect::<Vec<_>>(),
        vec![
            (
                "entity.create".into(),
                "storyline:main".into(),
                json!({"seed":{"color":"#AA3311","name":"New Storyline","nodeContentTemplateJson":"{}","summary":""}})
            ),
            (
                "yjs.update".into(),
                "prose-document:storyline:main".into(),
                Value::Null
            ),
            (
                "order.move".into(),
                "storyline:main".into(),
                json!({"scope":scope,"positionKey":"a0"})
            ),
            (
                "set.add".into(),
                "membership:main".into(),
                json!({"memberId":"chapter-a","value":null})
            ),
            (
                "field.set".into(),
                "node-storyline-primary:chapter-a".into(),
                json!({"field":"storylineId","value":"main"})
            ),
            (
                "set.add".into(),
                "membership:main".into(),
                json!({"memberId":"chapter-b","value":null})
            ),
            (
                "field.set".into(),
                "node-storyline-primary:chapter-b".into(),
                json!({"field":"storylineId","value":"main"})
            ),
        ]
    );
    let second = create(&store, "second", "new storyline").unwrap();
    assert_eq!(
        (second.name.as_str(), second.order_key),
        ("new storyline 2", 1)
    );
    assert_eq!(
        latest(&g).iter().map(|m| m.0.as_str()).collect::<Vec<_>>(),
        ["entity.create", "yjs.update", "order.move"]
    );
    assert_eq!(latest(&g)[2].3, json!({"scope":scope,"positionKey":"a1"}));
    assert_eq!(
        store.chapter_memberships(&c.project_id).unwrap(),
        vec![
            ChapterMembership {
                chapter_id: "chapter-a".into(),
                storyline_ids: vec!["main".into()],
                primary: Some("main".into())
            },
            ChapterMembership {
                chapter_id: "chapter-b".into(),
                storyline_ids: vec!["main".into()],
                primary: Some("main".into())
            },
        ]
    );
    let renamed = store
        .update_storyline(
            &c,
            "second",
            StorylineChanges {
                name: Some("NEW STORYLINE".into()),
                color: Some("#123456".into()),
                summary: Some("支线🙂".into()),
            },
        )
        .unwrap();
    assert_eq!(renamed.name, "NEW STORYLINE 2");
    assert_eq!(
        latest(&g).into_iter().map(|m| m.3).collect::<Vec<_>>(),
        vec![
            json!({"field":"color","value":"#123456"}),
            json!({"field":"name","value":"NEW STORYLINE 2"}),
            json!({"field":"summary","value":"支线🙂"})
        ]
    );
    let unchanged = state(&g);
    store
        .update_storyline(
            &c,
            "second",
            StorylineChanges {
                summary: Some("支线🙂".into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(state(&g), unchanged);
    // Reorder: one rebalance per storyline, ranks follow.
    let ordered = store.move_storyline(&c, "second", Some("main")).unwrap();
    assert_eq!(
        ordered
            .iter()
            .map(|s| (s.id.as_str(), s.order_key))
            .collect::<Vec<_>>(),
        [("second", 0), ("main", 1)]
    );
    assert_eq!(
        latest(&g)
            .into_iter()
            .map(|m| (m.0, m.1, m.3))
            .collect::<Vec<_>>(),
        vec![
            (
                "order.rebalance".into(),
                "storyline:second".into(),
                json!({"scope":scope,"entries":[{"entityId":"second","positionKey":"a0"}]})
            ),
            (
                "order.rebalance".into(),
                "storyline:main".into(),
                json!({"scope":scope,"entries":[{"entityId":"main","positionKey":"a1"}]})
            ),
        ]
    );
}

#[test]
fn workspace_storylines_chapter_membership_projection_and_primary() {
    let (_dir, g) = database();
    let store = WorkspaceStore::new(&g, CLIENT);
    let c = context();
    create(&store, "main", "主线").unwrap();
    create(&store, "side", "支线").unwrap();
    let main_tag = string(
        &rows(
            &g,
            "SELECT add_tag FROM sync_set_tag WHERE value_key='chapter-a'",
        )[0],
        0,
    )
    .unwrap();
    let set = |ids: &[&str], primary: Option<Option<&str>>| {
        let ids: Vec<String> = ids.iter().map(|id| (*id).into()).collect();
        store.set_chapter_storylines(&c, "chapter-a", &ids, primary)
    };
    let both = set(&["side", "main"], Some(Some("side"))).unwrap();
    assert_eq!(
        (both.storyline_ids, both.primary.as_deref()),
        (vec!["main".to_string(), "side".into()], Some("side"))
    );
    assert_eq!(
        latest(&g)
            .into_iter()
            .map(|m| (m.0, m.1, m.3))
            .collect::<Vec<_>>(),
        vec![
            (
                "set.add".into(),
                "membership:side".into(),
                json!({"memberId":"chapter-a","value":null})
            ),
            (
                "field.set".into(),
                "node-storyline-primary:chapter-a".into(),
                json!({"field":"storylineId","value":"side"})
            ),
        ]
    );
    let side_tag = string(
        &rows(
            &g,
            "SELECT add_tag FROM sync_set_tag WHERE value_key='chapter-a' AND owner_id='side'",
        )[0],
        0,
    )
    .unwrap();
    let unchanged = state(&g);
    set(&["main", "side"], Some(Some("side"))).unwrap();
    assert_eq!(state(&g), unchanged);
    // An explicit null primary falls back to the first listed storyline.
    assert_eq!(
        set(&["main", "side"], Some(None))
            .unwrap()
            .primary
            .as_deref(),
        Some("main")
    );
    assert_eq!(
        latest(&g).into_iter().map(|m| m.0).collect::<Vec<_>>(),
        ["field.set"]
    );
    // An absent primary keeps the current one, prepending it when unlisted.
    let kept = set(&[], None).unwrap();
    assert_eq!(
        (kept.storyline_ids, kept.primary.as_deref()),
        (vec!["main".to_string()], Some("main"))
    );
    assert_eq!(
        latest(&g)[0],
        (
            "set.remove".into(),
            "membership:side".into(),
            0,
            json!({"memberId":"chapter-a","observedAddTags":[side_tag]})
        )
    );
    let none = set(&[], Some(None)).unwrap();
    assert_eq!(none.primary, None);
    let wire = latest(&g);
    assert_eq!(
        wire[0],
        (
            "set.remove".into(),
            "membership:main".into(),
            0,
            json!({"memberId":"chapter-a","observedAddTags":[main_tag]})
        )
    );
    assert_eq!(wire[1].3, json!({"field":"storylineId","value":null}));
    // A primary missing from the list joins it.
    assert_eq!(
        set(&["main"], Some(Some("side"))).unwrap().storyline_ids,
        vec!["main".to_string(), "side".into()]
    );
    assert!(set(&["missing"], None).is_err());
}

#[test]
fn workspace_storylines_trash_restore_and_chapter_restore_reauthor_membership() {
    let (_dir, g) = database();
    let store = WorkspaceStore::new(&g, CLIENT);
    let c = context();
    create(&store, "main", "主线").unwrap();
    create(&store, "side", "支线").unwrap();
    store
        .set_chapter_storylines(
            &c,
            "chapter-b",
            &["main".into(), "side".into()],
            Some(Some("side")),
        )
        .unwrap();
    // chapter-a's primary is main: it loses every link; chapter-b loses main only.
    exec(&g, "CREATE TRIGGER fail_line_receipt BEFORE INSERT ON sync_apply_receipt BEGIN SELECT RAISE(ABORT,'line receipt fault'); END");
    let before = state(&g);
    assert!(store
        .trash_storyline(&c, "main")
        .unwrap_err()
        .contains("line receipt fault"));
    assert_eq!(state(&g), before);
    exec(&g, "DROP TRIGGER fail_line_receipt");
    store.trash_storyline(&c, "main").unwrap();
    assert_eq!(
        latest(&g)
            .iter()
            .map(|m| (m.0.as_str(), m.1.as_str()))
            .collect::<Vec<_>>(),
        [
            ("set.remove", "membership:main"),
            ("field.set", "node-storyline-primary:chapter-a"),
            ("set.remove", "membership:main"),
            ("field.set", "node-storyline-primary:chapter-b"),
            ("entity.trash", "storyline:main"),
        ]
    );
    assert_eq!(
        store.chapter_memberships(&c.project_id).unwrap(),
        vec![
            ChapterMembership {
                chapter_id: "chapter-a".into(),
                storyline_ids: vec![],
                primary: None
            },
            ChapterMembership {
                chapter_id: "chapter-b".into(),
                storyline_ids: vec!["side".into()],
                primary: Some("side".into())
            },
        ]
    );
    assert_eq!(store.storylines(&c.project_id).unwrap()[0].order_key, 0);
    // Like the renderer, the restored row is placed by its stale numeric order
    // (tied at 0, then by id), so it is inserted before the survivor.
    let restored = store.restore_storyline(&c, "main", capture).unwrap();
    assert_eq!(restored.order_key, 0);
    let wire = latest(&g);
    assert_eq!(
        wire.iter().map(|m| (m.0.as_str(), m.2)).collect::<Vec<_>>(),
        [("entity.restore", 1), ("order.move", 1), ("yjs.update", 1)]
    );
    assert_eq!(wire[1].3["positionKey"], "a0");
    assert!(
        store.chapter_memberships(&c.project_id).unwrap()[0]
            .storyline_ids
            .is_empty(),
        "links are not restored"
    );
    // Chapter trash keeps links; restore re-adds its membership in the new incarnation.
    store.trash_chapter(&c, "chapter-b").unwrap();
    let side_tag = string(&rows(&g, "SELECT add_tag FROM sync_set_tag WHERE value_key='chapter-b' AND owner_id='side' AND removed_by_change_set_id IS NULL")[0], 0).unwrap();
    store
        .restore_chapter(&c, "chapter-b", |repo, tx, doc| {
            Ok(ChapterSeed {
                update: repo.list_updates(doc, None, Some(tx))?[0]
                    .update_blob
                    .clone(),
                content_json: CACHE.into(),
            })
        })
        .unwrap();
    assert_eq!(
        latest(&g)
            .into_iter()
            .map(|m| (m.0, m.1, m.2, m.3))
            .collect::<Vec<_>>()[2..5]
            .to_vec(),
        vec![
            (
                "set.remove".into(),
                "membership:side".into(),
                0,
                json!({"memberId":"chapter-b","observedAddTags":[side_tag]})
            ),
            (
                "set.add".into(),
                "membership:side".into(),
                0,
                json!({"memberId":"chapter-b","value":null})
            ),
            (
                "field.set".into(),
                "node-storyline-primary:chapter-b".into(),
                1,
                json!({"field":"storylineId","value":"side"})
            ),
        ]
    );
}
