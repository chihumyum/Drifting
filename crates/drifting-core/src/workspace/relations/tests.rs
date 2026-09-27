use super::*;
use crate::original_operation::{verify_change_set, ChangeSetRef};
use base64::{engine::general_purpose::STANDARD, Engine};

const CLIENT: &str = "synthetic-relations";
const NOW: &str = "2026-09-27T00:00:00.000Z";
const SEED: &str =
    "AQPC7RoABwEHZGVmYXVsdAMJcGFyYWdyYXBoBwDC7RoABigAwu0aAAJpZAF3FXRyYXNoLXN5bnRoZXRpYy1ibG9jawA=";
const CACHE: &str =
    r#"{"type":"doc","content":[{"type":"paragraph","attrs":{"id":"trash-synthetic-block"}}]}"#;
const GENERIC: &str = "system:generic-association:rel-project";

fn context() -> AuthoredProseContext {
    AuthoredProseContext {
        project_id: "rel-project".into(),
        project_sync_id: "rel-project-sync".into(),
        sync_generation_id: "rel-generation".into(),
        installation_id: "rel-installation".into(),
        new_writer_id: "rel-writer".into(),
        new_writer_epoch: "rel-epoch".into(),
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
fn ids() -> impl FnMut() -> Result<String, String> {
    let mut counter = 0;
    move || {
        counter += 1;
        Ok(format!("rel-fact-{counter}"))
    }
}
fn database() -> (tempfile::TempDir, DatabaseGateway) {
    let dir = tempfile::tempdir().unwrap();
    let g = DatabaseGateway::new(dir.path().into()).unwrap();
    g.open("relations.db".into(), CLIENT.into(), false).unwrap();
    let store = WorkspaceStore::new(&g, CLIENT);
    let c = context();
    store
        .create_project(
            &c,
            CreateProject {
                user_id: "local-user".into(),
                name: "合成关系".into(),
                default_kv_ids: std::array::from_fn(|i| format!("rel-default-{i}")),
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
        .create_element_category(
            &c,
            NewElementCategory {
                id: "people".into(),
                name: "人物".into(),
                color: "#336699".into(),
                seed: seed(),
            },
        )
        .unwrap();
    for (id, name) in [("mira", "米拉"), ("oren", "奥伦"), ("ash", "灰")] {
        store
            .create_element(
                &c,
                NewElement {
                    id: id.into(),
                    category_id: "people".into(),
                    name: Some(name.into()),
                    group_name: None,
                    seed: seed(),
                    summary: String::new(),
                    aliases: Vec::new(),
                    facts: None,
                },
                &mut ids(),
            )
            .unwrap();
    }
    (dir, g)
}
fn state(g: &DatabaseGateway) -> Vec<Vec<Vec<V>>> {
    [
        "entity_relation",
        "entity_relation_type",
        "entity_relation_type_endpoint_kind",
        "element",
        "book_node",
        "storylines",
        "element_category",
        "sync_change_set",
        "sync_mutation",
        "sync_entity_lifecycle",
        "sync_field_clock",
    ]
    .iter()
    .map(|t| rows(g, &format!("SELECT * FROM {t} ORDER BY rowid")))
    .collect()
}
fn latest(g: &DatabaseGateway) -> Vec<(String, String, u64, Value)> {
    let c = context();
    let row = rows(g, "SELECT change_set_id,payload_sha256,encoded_bytes FROM sync_change_set ORDER BY device_seq DESC LIMIT 1")
        .remove(0);
    let V::Blob(bytes) = &row[2] else {
        panic!("original")
    };
    verify_change_set(
        bytes,
        &ChangeSetRef {
            project_id: c.project_id.clone(),
            project_sync_id: c.project_sync_id.clone(),
            sync_generation_id: c.sync_generation_id.clone(),
            change_set_id: string(&row, 0).unwrap(),
            original_envelope_sha256: string(&row, 1).unwrap(),
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
fn definition(
    name: &str,
    orientation: &str,
    roles: (&str, &str),
    source: &[&str],
    target: &[&str],
) -> RelationTypeDefinition {
    RelationTypeDefinition {
        name: name.into(),
        description: Some(" 师承 ".into()),
        orientation: orientation.into(),
        source_role: Some(roles.0.into()),
        target_role: Some(roles.1.into()),
        source_kinds: source.iter().map(|k| k.to_string()).collect(),
        target_kinds: target.iter().map(|k| k.to_string()).collect(),
    }
}

#[test]
fn workspace_relation_types_create_update_and_delete() {
    let (_dir, g) = database();
    let store = WorkspaceStore::new(&g, CLIENT);
    let c = context();
    let mentor = store
        .create_relation_type(
            &c,
            "mentor",
            &definition(
                " Mentor 师徒 ",
                "directed",
                ("师父", "徒弟"),
                &["storyline", "element", "element"],
                &["element"],
            ),
        )
        .unwrap();
    assert_eq!(
        (
            mentor.name.as_str(),
            mentor.normalized_name.as_str(),
            mentor.description.as_str()
        ),
        ("Mentor 师徒", "mentor 师徒", "师承")
    );
    assert_eq!(
        mentor.source_kinds,
        ["element", "storyline"],
        "canonical kind order, deduplicated"
    );
    assert_eq!(
        latest(&g),
        vec![(
            "entity.create".into(),
            "entity-relation-type:mentor".into(),
            0,
            json!({"seed":{"description":"师承","locked":false,"name":"Mentor 师徒","normalizedName":"mentor 师徒",
                "orientation":"directed","sourceKinds":["element","storyline"],"sourceRole":"师父","systemKey":null,
                "targetKinds":["element"],"targetRole":"徒弟"}})
        )]
    );
    let before = state(&g);
    for bad in [
        definition(
            "MENTOR 师徒",
            "directed",
            ("a", "b"),
            &["element"],
            &["element"],
        ),
        definition(" ", "directed", ("a", "b"), &["element"], &["element"]),
        definition("x", "directed", ("a", " "), &["element"], &["element"]),
        definition("x", "directed", ("a", "b"), &["element"], &["comment"]),
        definition("x", "directed", ("a", "b"), &[], &["element"]),
        definition("x", "symmetric", ("", ""), &["comment"], &["element"]),
        definition(
            "x",
            "symmetric",
            ("", ""),
            &["element"],
            &["element", "node"],
        ),
        definition("x", "sideways", ("a", "b"), &["element"], &["element"]),
    ] {
        assert!(
            store.create_relation_type(&c, "bad", &bad).is_err(),
            "{bad:?}"
        );
    }
    assert_eq!(state(&g), before, "refusals write nothing");
    let ally = store
        .create_relation_type(
            &c,
            "ally",
            &definition(
                "同盟",
                "symmetric",
                ("", ""),
                &["node", "element"],
                &["element", "node"],
            ),
        )
        .unwrap();
    assert_eq!(
        (ally.source_role.as_str(), ally.target_role.as_str()),
        ("端点", "端点")
    );
    // Update journals every authored field, in UTF-8 field order.
    let updated = store
        .update_relation_type(
            &c,
            "mentor",
            &definition(
                "师徒",
                "directed",
                ("师父", "学生"),
                &["element"],
                &["element"],
            ),
        )
        .unwrap();
    assert_eq!(updated.target_role, "学生");
    assert_eq!(
        latest(&g)
            .into_iter()
            .map(|m| m.3["field"].as_str().unwrap().to_string())
            .collect::<Vec<_>>(),
        [
            "description",
            "locked",
            "name",
            "normalizedName",
            "orientation",
            "sourceKinds",
            "sourceRole",
            "systemKey",
            "targetKinds",
            "targetRole"
        ]
    );
    let unchanged = state(&g);
    store
        .update_relation_type(
            &c,
            "mentor",
            &definition(
                "师徒",
                "directed",
                ("师父", "学生"),
                &["element"],
                &["element"],
            ),
        )
        .unwrap();
    assert_eq!(state(&g), unchanged, "an unchanged type writes nothing");
    // The built-in type is locked; a used type cannot be deleted.
    assert!(store
        .update_relation_type(
            &c,
            GENERIC,
            &definition("x", "directed", ("a", "b"), &["element"], &["element"])
        )
        .unwrap_err()
        .contains("内建"));
    assert!(store
        .delete_relation_type(&c, GENERIC)
        .unwrap_err()
        .contains("内建"));
    store
        .add_relation(
            &c,
            "edge",
            ("element", "mira"),
            ("element", "oren"),
            "mentor",
        )
        .unwrap();
    assert!(store
        .delete_relation_type(&c, "mentor")
        .unwrap_err()
        .contains("1 条关系"));
    // A used type cannot narrow its endpoints away from its relations.
    assert!(store
        .update_relation_type(
            &c,
            "mentor",
            &definition(
                "师徒",
                "directed",
                ("师父", "学生"),
                &["element"],
                &["node"]
            )
        )
        .unwrap_err()
        .contains("不符合新约束"));
    store.delete_relation_type(&c, "ally").unwrap();
    assert_eq!(latest(&g)[0].0, "entity.purge");
    assert!(rows(
        &g,
        "SELECT 1 FROM entity_relation_type_endpoint_kind WHERE relation_type_id='ally'"
    )
    .is_empty());
    store.delete_relation_type(&c, "ally").unwrap();
    assert_eq!(store.relation_types(&c.project_id).unwrap().len(), 2);
}

#[test]
fn workspace_relations_add_canonicalize_retype_and_remove() {
    let (_dir, g) = database();
    let store = WorkspaceStore::new(&g, CLIENT);
    let c = context();
    store
        .create_relation_type(
            &c,
            "mentor",
            &definition(
                "师徒",
                "directed",
                ("师父", "徒弟"),
                &["element"],
                &["element", "node"],
            ),
        )
        .unwrap();
    store
        .create_relation_type(
            &c,
            "ally",
            &definition(
                "同盟",
                "symmetric",
                ("", ""),
                &["element", "node"],
                &["element", "node"],
            ),
        )
        .unwrap();
    let edge = store
        .add_relation(
            &c,
            "edge",
            ("element", "mira"),
            ("element", "oren"),
            "mentor",
        )
        .unwrap();
    assert_eq!(
        latest(&g),
        vec![(
            "entity.create".into(),
            "entity-relation:edge".into(),
            0,
            json!({"seed":{"fromId":"mira","fromKind":"element","relationTypeId":"mentor","toId":"oren","toKind":"element"}})
        )]
    );
    let before = state(&g);
    assert_eq!(
        store
            .add_relation(
                &c,
                "again",
                ("element", "mira"),
                ("element", "oren"),
                "mentor"
            )
            .unwrap(),
        edge,
        "an identical edge is returned"
    );
    let reversed = store
        .add_relation(&c, "x", ("node", "chapter"), ("element", "mira"), "mentor")
        .unwrap_err();
    assert!(reversed.contains("方向相反"), "{reversed}");
    assert!(store
        .add_relation(
            &c,
            "x",
            ("element", "mira"),
            ("element", "missing"),
            "mentor"
        )
        .is_err());
    assert!(store
        .add_relation(&c, "x", ("element", "mira"), ("comment", "c"), "mentor")
        .is_err());
    assert!(store
        .add_relation(&c, "x", ("element", "mira"), ("element", "oren"), "unknown")
        .is_err());
    assert!(store
        .add_relation(&c, "x", ("element", "mira"), ("element", "mira"), "mentor")
        .unwrap_err()
        .contains("同一个实体"));
    assert_eq!(state(&g), before, "refusals write nothing");
    // Symmetric edges store the bytewise-smaller endpoint first.
    let ally = store
        .add_relation(&c, "pact", ("node", "chapter"), ("element", "ash"), "ally")
        .unwrap();
    assert_eq!(
        (
            ally.from_kind.as_str(),
            ally.from_id.as_str(),
            ally.to_id.as_str()
        ),
        ("element", "ash", "chapter")
    );
    // Retype with a swap journals all five endpoint fields.
    let swapped = store.retype_relation(&c, "edge", "mentor", true).unwrap();
    assert_eq!(
        (swapped.from_id.as_str(), swapped.to_id.as_str()),
        ("oren", "mira")
    );
    assert_eq!(
        latest(&g).into_iter().map(|m| m.3).collect::<Vec<_>>(),
        vec![
            json!({"field":"fromId","value":"oren"}),
            json!({"field":"fromKind","value":"element"}),
            json!({"field":"relationTypeId","value":"mentor"}),
            json!({"field":"toId","value":"mira"}),
            json!({"field":"toKind","value":"element"}),
        ]
    );
    store
        .add_relation(
            &c,
            "forward",
            ("element", "mira"),
            ("element", "oren"),
            "mentor",
        )
        .unwrap();
    assert!(store
        .retype_relation(&c, "forward", "mentor", true)
        .unwrap_err()
        .contains("已存在"));
    store.remove_relation(&c, "forward").unwrap();
    assert_eq!(latest(&g)[0].0, "entity.purge");
    let removed = state(&g);
    store.remove_relation(&c, "forward").unwrap();
    assert_eq!(
        state(&g),
        removed,
        "removing an unknown relation writes nothing"
    );
}

#[test]
fn workspace_relations_are_purged_by_trash_and_not_restored() {
    let (_dir, g) = database();
    let store = WorkspaceStore::new(&g, CLIENT);
    let c = context();
    store
        .create_relation_type(
            &c,
            "link",
            &definition(
                "关联",
                "directed",
                ("从", "到"),
                &["node", "element", "category", "storyline"],
                &["node", "element", "category", "storyline"],
            ),
        )
        .unwrap();
    store
        .create_storyline(
            &c,
            NewStoryline {
                id: "line".into(),
                name: "主线".into(),
                color: "#888888".into(),
                seed: seed(),
            },
            &mut ids(),
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
    for (id, from, to) in [
        ("e1", ("element", "mira"), ("node", "chapter")),
        ("e2", ("storyline", "line"), ("element", "mira")),
        ("e3", ("element", "oren"), ("category", "people")),
        ("e4", ("node", "drift"), ("storyline", "line")),
        ("e5", ("node", "chapter"), ("element", "ash")),
    ] {
        store.add_relation(&c, id, from, to, "link").unwrap();
    }
    let purges = |g: &DatabaseGateway| {
        latest(g)
            .into_iter()
            .map(|m| format!("{} {}", m.0, m.1))
            .collect::<Vec<_>>()
    };
    store.trash_element(&c, "mira").unwrap();
    assert_eq!(
        purges(&g),
        [
            "entity.purge entity-relation:e1",
            "entity.purge entity-relation:e2",
            "entity.trash element:mira"
        ]
    );
    store.trash_chapter(&c, "chapter").unwrap();
    assert_eq!(
        purges(&g),
        [
            "entity.purge entity-relation:e5",
            "entity.trash node:chapter"
        ]
    );
    store.trash_element_category(&c, "people").unwrap();
    assert_eq!(
        purges(&g),
        [
            "entity.purge entity-relation:e3",
            "entity.trash element-category:people"
        ]
    );
    store.trash_drift(&c, "drift").unwrap();
    assert_eq!(
        purges(&g),
        ["entity.purge entity-relation:e4", "entity.trash node:drift"]
    );
    assert!(store.relations(&c.project_id).unwrap().is_empty());
    let restored = store
        .restore_element(&c, "mira", |repo, tx, doc| {
            Ok(ChapterSeed {
                update: repo.list_updates(doc, None, Some(tx))?[0]
                    .update_blob
                    .clone(),
                content_json: CACHE.into(),
            })
        })
        .unwrap();
    assert_eq!(restored.id, "mira");
    assert!(
        store.relations(&c.project_id).unwrap().is_empty(),
        "restore does not bring relations back"
    );
    // A storyline without relations trashes as before.
    store.trash_storyline(&c, "line").unwrap();
    assert_eq!(purges(&g).last().unwrap(), "entity.trash storyline:line");
}
