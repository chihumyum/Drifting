use super::*;
use crate::original_operation::{verify_change_set, ChangeSetRef};
use base64::{engine::general_purpose::STANDARD, Engine};

const CLIENT: &str = "synthetic-metadata";
const NOW: &str = "2026-09-27T00:00:00.000Z";
const SEED: &str =
    "AQPC7RoABwEHZGVmYXVsdAMJcGFyYWdyYXBoBwDC7RoABigAwu0aAAJpZAF3FXRyYXNoLXN5bnRoZXRpYy1ibG9jawA=";
const CACHE: &str =
    r#"{"type":"doc","content":[{"type":"paragraph","attrs":{"id":"trash-synthetic-block"}}]}"#;

fn context() -> AuthoredProseContext {
    AuthoredProseContext {
        project_id: "meta-project".into(),
        project_sync_id: "meta-project-sync".into(),
        sync_generation_id: "meta-generation".into(),
        installation_id: "meta-installation".into(),
        new_writer_id: "meta-writer".into(),
        new_writer_epoch: "meta-epoch".into(),
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
fn database() -> (tempfile::TempDir, DatabaseGateway) {
    let dir = tempfile::tempdir().unwrap();
    let g = DatabaseGateway::new(dir.path().into()).unwrap();
    g.open("metadata.db".into(), CLIENT.into(), false).unwrap();
    let store = WorkspaceStore::new(&g, CLIENT);
    let c = context();
    store
        .create_project(
            &c,
            CreateProject {
                user_id: "local-user".into(),
                name: "合成元数据".into(),
                default_kv_ids: std::array::from_fn(|i| format!("meta-fact-{i}")),
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
    (dir, g)
}
fn state(g: &DatabaseGateway) -> Vec<Vec<Vec<V>>> {
    [
        "project",
        "book_node",
        "entity_kv_entry",
        "sync_change_set",
        "sync_mutation",
        "sync_entity_lifecycle",
        "sync_field_clock",
        "sync_order_register",
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
fn fact(key: &str, value: &str) -> Fact {
    Fact {
        key: key.into(),
        value: value.into(),
    }
}

#[test]
fn workspace_metadata_node_summary_and_status() {
    let (_dir, g) = database();
    let store = WorkspaceStore::new(&g, CLIENT);
    let c = context();
    let chapter = store
        .set_node_summary(&c, "chapter", "她回到北塔。")
        .unwrap();
    assert_eq!(
        (chapter.summary.as_str(), chapter.updated_at.as_str()),
        ("她回到北塔。", NOW)
    );
    assert_eq!(
        latest(&g)[0].3,
        json!({"field":"summary","value":"她回到北塔。"})
    );
    let unchanged = state(&g);
    store
        .set_node_summary(&c, "chapter", "她回到北塔。")
        .unwrap();
    assert_eq!(state(&g), unchanged, "no change writes nothing");
    // updateNode floors the revision at previous + 1 ms.
    let finished = store.set_node_status(&c, "chapter", "finished").unwrap();
    assert_eq!(
        (
            finished.writing_status.as_str(),
            finished.updated_at.as_str()
        ),
        ("finished", "2026-09-27T00:00:00.001Z")
    );
    assert_eq!(
        latest(&g)[0].3,
        json!({"field":"writingStatus","value":"finished"})
    );
    let before = state(&g);
    assert!(store.set_node_status(&c, "chapter", "resting").is_err());
    assert!(store.set_node_status(&c, "drift", "finished").is_err());
    assert!(store.set_node_status(&c, "missing", "draft").is_err());
    assert_eq!(state(&g), before, "refusals write nothing");
    let resting = store.set_node_status(&c, "drift", "resting").unwrap();
    assert_eq!(
        (resting.kind.as_str(), resting.writing_status.as_str()),
        ("drift", "resting")
    );
    store.set_node_summary(&c, "drift", "钟声的来历").unwrap();
    assert_eq!(
        store.node_metadata(&c.project_id, "drift").unwrap().summary,
        "钟声的来历"
    );
}

#[test]
fn workspace_metadata_project_summary_facts_and_template() {
    let (_dir, g) = database();
    let store = WorkspaceStore::new(&g, CLIENT);
    let c = context();
    let initial = store.project_details(&c.project_id).unwrap();
    let mut counter = 0;
    let mut ids = || {
        counter += 1;
        Ok::<_, String>(format!("new-fact-{counter}"))
    };
    let unchanged = state(&g);
    store
        .update_project(
            &c,
            ProjectChanges {
                summary: Some(initial.project.summary.clone()),
                facts: Some(initial.facts.clone()),
                storyline_template: Some(initial.storyline_template.clone()),
            },
            &mut ids,
        )
        .unwrap();
    assert_eq!(state(&g), unchanged, "an unchanged project writes nothing");
    let updated = store
        .update_project(
            &c,
            ProjectChanges {
                summary: Some("一座钟楼的故事".into()),
                facts: Some(vec![fact("时代", "近未来"), fact(" ", " ")]),
                storyline_template: Some(vec![fact("主题", "")]),
            },
            &mut ids,
        )
        .unwrap();
    assert_eq!(updated.project.summary, "一座钟楼的故事");
    assert_eq!(
        updated.facts,
        vec![fact("时代", "近未来")],
        "blank rows are dropped"
    );
    assert_eq!(updated.storyline_template, vec![fact("主题", "")]);
    let mutations = latest(&g);
    let facts_scope = json!(["project", c.project_id, "facts"]).to_string();
    let template_scope = json!(["project", c.project_id, "storyline-template"]).to_string();
    assert_eq!(
        mutations.last().unwrap().3,
        json!({"field":"summary","value":"一座钟楼的故事"})
    );
    let scopes: Vec<String> = mutations
        .iter()
        .filter_map(|m| m.3.get("scope").and_then(Value::as_str).map(Into::into))
        .collect();
    let first_template = scopes.iter().position(|s| *s == template_scope).unwrap();
    assert!(
        scopes[..first_template].iter().all(|s| *s == facts_scope),
        "facts precede the template"
    );
    assert_eq!(
        rows(
            &g,
            "SELECT kv_json,storyline_template_kv_json,updated_at FROM project"
        ),
        vec![vec![
            V::Text(r#"[{"key":"时代","value":"近未来"}]"#.into()),
            V::Text(r#"[{"key":"主题","value":""}]"#.into()),
            V::Text(NOW.into()),
        ]]
    );
    // New storylines clone the edited template.
    let storyline = store
        .create_storyline(
            &c,
            NewStoryline {
                id: "line".into(),
                name: "主线".into(),
                color: "#888888".into(),
                seed: seed(),
            },
            &mut ids,
        )
        .unwrap();
    assert_eq!(storyline.facts, vec![fact("主题", "")]);
}
