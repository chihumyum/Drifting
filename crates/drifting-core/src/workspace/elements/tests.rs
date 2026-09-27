use super::*;
use crate::original_operation::{verify_change_set, ChangeSetRef};
use base64::{engine::general_purpose::STANDARD, Engine};

const CLIENT: &str = "synthetic-elements";
const NOW: &str = "2026-09-27T00:00:00.000Z";
// Synthetic Yjs client 440002, one empty paragraph with a stable block ID.
const SEED: &str =
    "AQPC7RoABwEHZGVmYXVsdAMJcGFyYWdyYXBoBwDC7RoABigAwu0aAAJpZAF3FXRyYXNoLXN5bnRoZXRpYy1ibG9jawA=";
const CACHE: &str =
    r#"{"type":"doc","content":[{"type":"paragraph","attrs":{"id":"trash-synthetic-block"}}]}"#;

fn context() -> AuthoredProseContext {
    AuthoredProseContext {
        project_id: "elements-project".into(),
        project_sync_id: "elements-project-sync".into(),
        sync_generation_id: "elements-generation".into(),
        installation_id: "elements-installation".into(),
        new_writer_id: "elements-writer".into(),
        new_writer_epoch: "elements-epoch".into(),
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
    g.open("elements.db".into(), CLIENT.into(), false).unwrap();
    WorkspaceStore::new(&g, CLIENT)
        .create_project(
            &context(),
            CreateProject {
                user_id: "local-user".into(),
                name: "合成设定库".into(),
                default_kv_ids: std::array::from_fn(|i| format!("elements-fact-{i}")),
            },
        )
        .unwrap();
    (dir, g)
}
fn state(g: &DatabaseGateway) -> Vec<Vec<Vec<V>>> {
    [
        "element",
        "element_category",
        "yjs_updates",
        "yjs_document_revision",
        "sync_change_set",
        "sync_mutation",
        "sync_apply_receipt",
        "sync_entity_lifecycle",
        "sync_field_clock",
        "sync_set_tag",
        "sync_generation_writer_state",
    ]
    .iter()
    .map(|table| rows(g, &format!("SELECT * FROM {table} ORDER BY rowid")))
    .collect()
}
fn latest(g: &DatabaseGateway) -> Vec<(String, String, u64, Value)> {
    let row=&rows(g,"SELECT change_set_id,payload_sha256,encoded_bytes FROM sync_change_set ORDER BY device_seq DESC LIMIT 1")[0];
    let V::Blob(bytes) = &row[2] else {
        panic!("canonical original bytes")
    };
    let c = context();
    let verified = verify_change_set(
        bytes,
        &ChangeSetRef {
            project_id: c.project_id,
            project_sync_id: c.project_sync_id,
            sync_generation_id: c.sync_generation_id,
            change_set_id: string(row, 0).unwrap(),
            original_envelope_sha256: string(row, 1).unwrap(),
        },
    )
    .unwrap();
    verified
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
fn category(store: &WorkspaceStore<'_>, id: &str, name: &str) -> WorkspaceElementCategory {
    store
        .create_element_category(
            &context(),
            NewElementCategory {
                id: id.into(),
                name: name.into(),
                color: "#A1B2C3".into(),
                seed: seed(),
            },
        )
        .unwrap()
}
fn element(
    store: &WorkspaceStore<'_>,
    id: &str,
    name: Option<&str>,
) -> Result<WorkspaceElement, String> {
    store.create_element(
        &context(),
        NewElement {
            id: id.into(),
            category_id: "people".into(),
            name: name.map(Into::into),
            group_name: Some(" 主角 ".into()),
            seed: seed(),
        },
        &mut fact_ids(id),
    )
}
/// Deterministic fresh fact IDs per owner, like the host's generator.
fn fact_ids(owner: &str) -> impl FnMut() -> Result<String, String> {
    let owner = owner.to_owned();
    let mut next = 0;
    move || {
        next += 1;
        Ok(format!("{owner}-fact-{next}"))
    }
}
fn facts(pairs: &[(&str, &str)]) -> Vec<Fact> {
    pairs
        .iter()
        .map(|(key, value)| Fact {
            key: (*key).into(),
            value: (*value).into(),
        })
        .collect()
}
fn capture(repo: &ProseRepository<'_>, tx: u64, doc: &str) -> Result<ChapterSeed, String> {
    assert_eq!(doc, "element:hero");
    let updates = repo.list_updates(doc, None, Some(tx))?;
    Ok(ChapterSeed {
        update: updates[0].update_blob.clone(),
        content_json: CACHE.into(),
    })
}

#[test]
fn workspace_elements_categories_create_rename_and_recolour() {
    let (_dir, g) = database();
    let store = WorkspaceStore::new(&g, CLIENT);
    let c = context();
    let people = category(&store, "people", "  ");
    assert_eq!(people.name, "New Category");
    assert_eq!(
        latest(&g),
        vec![
            (
                "entity.create".into(),
                "element-category:people".into(),
                0,
                json!({"seed":{"color":"#A1B2C3","elementTemplateJson":"{}","gridX":null,"gridY":null,"layoutMode":"auto","name":"New Category"}})
            ),
            (
                "yjs.update".into(),
                "prose-document:category:people".into(),
                0,
                Value::Null
            ),
        ]
    );
    assert_eq!(
        rows(
            &g,
            "SELECT revision FROM yjs_document_revision WHERE document_id='category:people'"
        ),
        vec![vec![integer(1)]]
    );
    category(&store, "places", "地点");
    let renamed = store
        .update_element_category(&c, "people", Some(" 人物🙂 "), Some("#00ff7f"))
        .unwrap();
    assert_eq!(
        (renamed.name.as_str(), renamed.color.as_str()),
        ("人物🙂", "#00ff7f")
    );
    assert_eq!(
        latest(&g).into_iter().map(|m| m.3).collect::<Vec<_>>(),
        vec![
            json!({"field":"color","value":"#00ff7f"}),
            json!({"field":"name","value":"人物🙂"})
        ]
    );
    let unchanged = state(&g);
    store
        .update_element_category(&c, "people", Some("人物🙂"), None)
        .unwrap();
    assert_eq!(state(&g), unchanged);
    assert!(store
        .update_element_category(&c, "people", None, Some("red"))
        .is_err());
    assert!(store
        .update_element_category(&c, "people", Some(" "), None)
        .is_err());
    assert_eq!(
        store
            .element_categories(&c.project_id)
            .unwrap()
            .iter()
            .map(|c| c.name.as_str())
            .collect::<Vec<_>>(),
        ["人物🙂", "地点"]
    );
}

#[test]
fn workspace_elements_create_defaults_names_conflicts_and_seed() {
    let (_dir, g) = database();
    let store = WorkspaceStore::new(&g, CLIENT);
    let c = context();
    category(&store, "people", "人物");
    let first = element(&store, "first", None).unwrap();
    assert_eq!(
        (first.name.as_str(), first.group_name.as_deref()),
        ("New Element", Some("主角"))
    );
    assert_eq!(
        latest(&g),
        vec![
            (
                "entity.create".into(),
                "element:first".into(),
                0,
                json!({"seed":{"categoryId":"people","groupName":"主角","name":"New Element","summary":""}})
            ),
            (
                "yjs.update".into(),
                "prose-document:element:first".into(),
                0,
                Value::Null
            ),
        ]
    );
    assert_eq!(
        element(&store, "second", None).unwrap().name,
        "New Element 2"
    );
    store
        .update_element(
            &c,
            "second",
            ElementChanges {
                aliases: Some(vec!["阿凯".into()]),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(element(&store, "dup", Some(" new element "))
        .unwrap_err()
        .contains("already used"));
    assert!(element(&store, "dup", Some("阿凯"))
        .unwrap_err()
        .contains("already used"));
    let hero = element(&store, "hero", Some(" 林凯🙂 ")).unwrap();
    assert_eq!(hero.name, "林凯🙂");
    assert_eq!(
        rows(
            &g,
            "SELECT content_json,kv_json,aliases_json,summary FROM element WHERE id='hero'"
        ),
        vec![vec![
            V::Text(CACHE.into()),
            V::Text("[]".into()),
            V::Text("[]".into()),
            V::Text(String::new())
        ]]
    );
    assert!(
        element(&store, "hero", Some("另一个")).is_err(),
        "identity reuse"
    );
    // A category body template no longer blocks creation: the host fills the
    // new body from it after the create original.
    exec(&g, "UPDATE element_category SET element_template_json='{\"type\":\"doc\",\"content\":[]}' WHERE id='people'");
    element(&store, "templated", Some("模板")).unwrap();
    assert_eq!(
        store
            .category_element_template(&c.project_id, "people")
            .unwrap(),
        r#"{"type":"doc","content":[]}"#
    );
    let names: Vec<_> = store
        .elements(&c.project_id)
        .unwrap()
        .into_iter()
        .map(|e| e.name)
        .collect();
    assert_eq!(names.len(), 4, "including the templated element");
}

#[test]
fn workspace_elements_update_scalars_and_alias_set() {
    let (_dir, g) = database();
    let store = WorkspaceStore::new(&g, CLIENT);
    let c = context();
    category(&store, "people", "人物");
    category(&store, "places", "地点");
    element(&store, "hero", Some("林凯")).unwrap();
    element(&store, "rival", Some("对手")).unwrap();
    let updated = store
        .update_element(
            &c,
            "hero",
            ElementChanges {
                summary: Some("主角，雨夜来信".into()),
                group_name: Some(None),
                category_id: Some(Some("places".into())),
                aliases: Some(vec![
                    " Ｋａｉ ".into(),
                    "阿凯".into(),
                    "KAI".into(),
                    " ".into(),
                ]),
                ..Default::default()
            },
        )
        .unwrap();
    // Fullwidth NFKC folds into the same member; the last value wins.
    assert_eq!(updated.aliases, vec!["KAI", "阿凯"]);
    assert_eq!(
        latest(&g)
            .into_iter()
            .map(|m| (m.0, m.1, m.3))
            .collect::<Vec<_>>(),
        vec![
            (
                "set.add".into(),
                "alias:hero".into(),
                json!({"memberId":"kai","value":"KAI"})
            ),
            (
                "set.add".into(),
                "alias:hero".into(),
                json!({"memberId":"阿凯","value":"阿凯"})
            ),
            (
                "field.set".into(),
                "element:hero".into(),
                json!({"field":"categoryId","value":"places"})
            ),
            (
                "field.set".into(),
                "element:hero".into(),
                json!({"field":"groupName","value":null})
            ),
            (
                "field.set".into(),
                "element:hero".into(),
                json!({"field":"summary","value":"主角，雨夜来信"})
            ),
        ]
    );
    let add_tag = rows(&g, "SELECT add_tag FROM sync_set_tag WHERE value_key='kai'");
    assert_eq!(
        rows(&g, "SELECT owner_kind,owner_id,incarnation,set_key,value_key FROM sync_set_tag ORDER BY value_key"),
        vec![
            vec![text("alias"), text("hero"), integer(0), text("aliases"), text("kai")],
            vec![text("alias"), text("hero"), integer(0), text("aliases"), text("阿凯")],
        ]
    );
    // Changing a display and dropping a member removes exactly the observed tags.
    store
        .update_element(
            &c,
            "hero",
            ElementChanges {
                aliases: Some(vec!["Kai".into()]),
                ..Default::default()
            },
        )
        .unwrap();
    let wire = latest(&g);
    assert_eq!(
        wire.iter()
            .map(|m| (m.0.as_str(), m.3.clone()))
            .collect::<Vec<_>>(),
        vec![
            (
                "set.remove",
                json!({"memberId":"kai","observedAddTags":[string(&add_tag[0], 0).unwrap()]})
            ),
            (
                "set.remove",
                json!({"memberId":"阿凯","observedAddTags":[wire[1].3["observedAddTags"][0].clone()]})
            ),
            ("set.add", json!({"memberId":"kai","value":"Kai"})),
        ]
    );
    assert_eq!(
        rows(
            &g,
            "SELECT COUNT(*) FROM sync_set_tag WHERE removed_by_change_set_id IS NULL"
        ),
        vec![vec![integer(1)]]
    );
    assert_eq!(
        rows(&g, "SELECT aliases_json FROM element WHERE id='hero'"),
        vec![vec![text("[\"Kai\"]")]]
    );
    assert!(store
        .update_element(
            &c,
            "rival",
            ElementChanges {
                name: Some("kai".into()),
                ..Default::default()
            }
        )
        .unwrap_err()
        .contains("already used"));
    let unchanged = state(&g);
    let same = store
        .update_element(
            &c,
            "hero",
            ElementChanges {
                name: Some(" 林凯 ".into()),
                aliases: Some(vec!["Kai".into()]),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(same.name, "林凯");
    assert_eq!(state(&g), unchanged);
    let renamed = store
        .update_element(
            &c,
            "hero",
            ElementChanges {
                name: Some("林凯文".into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(renamed.aliases, vec!["Kai"]);
    assert_eq!(latest(&g).len(), 1);
    assert!(store
        .update_element(
            &c,
            "hero",
            ElementChanges {
                category_id: Some(Some("missing".into())),
                ..Default::default()
            }
        )
        .is_err());
}

#[test]
fn workspace_elements_trash_restore_and_failures() {
    let (_dir, g) = database();
    let store = WorkspaceStore::new(&g, CLIENT);
    let c = context();
    category(&store, "people", "人物");
    element(&store, "hero", Some("林凯")).unwrap();
    store
        .update_element(
            &c,
            "hero",
            ElementChanges {
                aliases: Some(vec!["阿凯".into()]),
                ..Default::default()
            },
        )
        .unwrap();
    for command in ["trash", "restore"] {
        exec(&g, "CREATE TRIGGER fail_element_receipt BEFORE INSERT ON sync_apply_receipt BEGIN SELECT RAISE(ABORT,'element receipt fault'); END");
        let before = state(&g);
        let apply = || match command {
            "trash" => store.trash_element(&c, "hero"),
            _ => store.restore_element(&c, "hero", capture),
        };
        assert!(apply().unwrap_err().contains("element receipt fault"));
        assert_eq!(state(&g), before);
        exec(&g, "DROP TRIGGER fail_element_receipt");
        apply().unwrap();
        if command == "trash" {
            assert_eq!(latest(&g)[0].0, "entity.trash");
            assert!(store.elements(&c.project_id).unwrap().is_empty());
            assert_eq!(store.trashed_elements(&c.project_id).unwrap()[0].id, "hero");
            assert!(store.element_scope(&c.project_id, "hero").is_err());
            assert!(store
                .update_element(
                    &c,
                    "hero",
                    ElementChanges {
                        summary: Some("x".into()),
                        ..Default::default()
                    }
                )
                .is_err());
        }
    }
    let wire = latest(&g);
    assert_eq!(
        wire.iter()
            .map(|m| (m.0.as_str(), m.1.as_str(), m.2))
            .collect::<Vec<_>>(),
        vec![
            ("entity.restore", "element:hero", 1),
            ("set.add", "alias:hero", 1),
            ("yjs.update", "prose-document:element:hero", 1),
        ]
    );
    assert_eq!(
        wire[0].3,
        json!({"seed":{"categoryId":"people","groupName":"主角","name":"林凯","summary":""}})
    );
    assert_eq!(
        rows(
            &g,
            "SELECT revision FROM yjs_document_revision WHERE document_id='element:hero'"
        ),
        vec![vec![integer(2)]]
    );
    assert_eq!(
        store
            .element_scope(&c.project_id, "hero")
            .unwrap()
            .incarnation,
        1
    );
    // The restored incarnation owns its aliases.
    store
        .update_element(
            &c,
            "hero",
            ElementChanges {
                aliases: Some(vec![]),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(
        latest(&g)
            .iter()
            .map(|m| (m.0.as_str(), m.2))
            .collect::<Vec<_>>(),
        vec![("set.remove", 1)]
    );
    exec(&g,"INSERT INTO entity_relation(id,project_id,from_kind,from_id,to_kind,to_id,relation_type_id,created_at,updated_at) SELECT 'rel','elements-project','element','hero','node','x',id,'t','t' FROM entity_relation_type LIMIT 1");
    // Trash purges relations; one without a lifecycle fails closed.
    let before = state(&g);
    assert!(store
        .trash_element(&c, "hero")
        .unwrap_err()
        .contains("no lifecycle"));
    assert_eq!(state(&g), before);
}

fn fact_rows(g: &DatabaseGateway, owner: &str) -> Vec<Vec<V>> {
    rows(g, &format!("SELECT e.id,e.key,e.value,r.position_key FROM entity_kv_entry e JOIN sync_order_register r ON r.entity_id=e.id WHERE e.owner_id='{owner}' ORDER BY r.position_key,e.id"))
}

#[test]
fn workspace_elements_facts_reconcile_ids_order_and_projection() {
    let (_dir, g) = database();
    let store = WorkspaceStore::new(&g, CLIENT);
    let c = context();
    category(&store, "people", "人物");
    element(&store, "hero", Some("林凯")).unwrap();
    let mut ids = fact_ids("hero");
    let set = |facts: Vec<Fact>, ids: &mut dyn FnMut() -> Result<String, String>| {
        store.set_element_facts(&c, "hero", &facts, ids).unwrap()
    };
    let hero = set(
        facts(&[("年龄", "二十七"), ("职业", "邮差"), (" ", " ")]),
        &mut ids,
    );
    assert_eq!(hero.facts, facts(&[("年龄", "二十七"), ("职业", "邮差")]));
    let scope = r#"["element","hero","facts"]"#;
    assert_eq!(
        latest(&g)
            .into_iter()
            .map(|m| (m.0, m.1, m.3))
            .collect::<Vec<_>>(),
        vec![
            (
                "entity.create".into(),
                "kv-entry:hero-fact-1".into(),
                json!({"seed":{"projectId":"elements-project","ownerKind":"element","ownerId":"hero","namespace":"facts","key":"年龄","value":"二十七"}})
            ),
            (
                "entity.create".into(),
                "kv-entry:hero-fact-2".into(),
                json!({"seed":{"projectId":"elements-project","ownerKind":"element","ownerId":"hero","namespace":"facts","key":"职业","value":"邮差"}})
            ),
            (
                "order.move".into(),
                "kv-entry:hero-fact-1".into(),
                json!({"scope":scope,"positionKey":"a0"})
            ),
            (
                "order.move".into(),
                "kv-entry:hero-fact-2".into(),
                json!({"scope":scope,"positionKey":"a1"})
            ),
        ]
    );
    assert_eq!(
        rows(&g, "SELECT kv_json FROM element WHERE id='hero'"),
        vec![vec![text(
            r#"[{"key":"年龄","value":"二十七"},{"key":"职业","value":"邮差"}]"#
        )]]
    );
    let unchanged = state(&g);
    set(facts(&[("年龄", "二十七"), ("职业", "邮差")]), &mut ids);
    assert_eq!(state(&g), unchanged);
    // Insert between: the new entry gets a key inside its neighbours' gap; an
    // edited value keeps its ID.
    set(
        facts(&[("年龄", "二十八"), ("住址", "北塔"), ("职业", "邮差")]),
        &mut ids,
    );
    assert_eq!(
        latest(&g)
            .into_iter()
            .map(|m| (m.0, m.1, m.3))
            .collect::<Vec<_>>(),
        vec![
            (
                "field.set".into(),
                "kv-entry:hero-fact-1".into(),
                json!({"field":"value","value":"二十八"})
            ),
            (
                "entity.create".into(),
                "kv-entry:hero-fact-3".into(),
                json!({"seed":{"projectId":"elements-project","ownerKind":"element","ownerId":"hero","namespace":"facts","key":"住址","value":"北塔"}})
            ),
            (
                "order.move".into(),
                "kv-entry:hero-fact-3".into(),
                json!({"scope":scope,"positionKey":"a0V"})
            ),
        ]
    );
    // Reorder and remove: one purge, then an atomic rebalance of every entry.
    let hero = set(facts(&[("职业", "邮差"), ("年龄", "二十八")]), &mut ids);
    assert_eq!(hero.facts, facts(&[("职业", "邮差"), ("年龄", "二十八")]));
    assert_eq!(
        latest(&g)
            .into_iter()
            .map(|m| (m.0, m.1, m.3))
            .collect::<Vec<_>>(),
        vec![
            (
                "entity.purge".into(),
                "kv-entry:hero-fact-3".into(),
                json!({})
            ),
            (
                "order.rebalance".into(),
                "kv-entry:hero-fact-2".into(),
                json!({"scope":scope,"entries":[{"entityId":"hero-fact-2","positionKey":"a0"}]})
            ),
            (
                "order.rebalance".into(),
                "kv-entry:hero-fact-1".into(),
                json!({"scope":scope,"entries":[{"entityId":"hero-fact-1","positionKey":"a1"}]})
            ),
        ]
    );
    assert_eq!(
        fact_rows(&g, "hero"),
        vec![
            vec![text("hero-fact-2"), text("职业"), text("邮差"), text("a0")],
            vec![
                text("hero-fact-1"),
                text("年龄"),
                text("二十八"),
                text("a1")
            ],
        ]
    );
    assert_eq!(
        rows(
            &g,
            "SELECT state FROM sync_entity_lifecycle WHERE entity_id='hero-fact-3'"
        ),
        vec![vec![text("purged")]]
    );
    // Same cardinality: a renamed key keeps its slot identity.
    set(facts(&[("身份", "邮差"), ("年龄", "二十八")]), &mut ids);
    assert_eq!(
        latest(&g)
            .into_iter()
            .map(|m| (m.0, m.1, m.3))
            .collect::<Vec<_>>(),
        vec![(
            "field.set".into(),
            "kv-entry:hero-fact-2".into(),
            json!({"field":"key","value":"身份"})
        )]
    );
}

#[test]
fn workspace_elements_category_template_facts_clone_into_new_elements() {
    let (_dir, g) = database();
    let store = WorkspaceStore::new(&g, CLIENT);
    let c = context();
    category(&store, "people", "人物");
    element(&store, "before", Some("先来者")).unwrap();
    let people = store
        .set_category_template_facts(
            &c,
            "people",
            &facts(&[("年龄", ""), ("阵营", "")]),
            &mut fact_ids("people"),
        )
        .unwrap();
    assert_eq!(people.template_facts, facts(&[("年龄", ""), ("阵营", "")]));
    assert_eq!(latest(&g)[0].3["seed"]["namespace"], "element-template");
    let hero = element(&store, "hero", Some("林凯")).unwrap();
    assert_eq!(hero.facts, facts(&[("年龄", ""), ("阵营", "")]));
    assert_eq!(
        latest(&g)
            .into_iter()
            .map(|m| (m.0, m.1))
            .collect::<Vec<_>>(),
        vec![
            ("entity.create".into(), "kv-entry:hero-fact-1".into()),
            ("entity.create".into(), "kv-entry:hero-fact-2".into()),
            ("order.move".into(), "kv-entry:hero-fact-1".into()),
            ("order.move".into(), "kv-entry:hero-fact-2".into()),
            ("entity.create".into(), "element:hero".into()),
            ("yjs.update".into(), "prose-document:element:hero".into()),
        ]
    );
    assert!(store
        .elements(&c.project_id)
        .unwrap()
        .iter()
        .find(|e| e.id == "before")
        .unwrap()
        .facts
        .is_empty());
    assert_eq!(
        rows(
            &g,
            "SELECT revision FROM yjs_document_revision WHERE document_id='element:hero'"
        ),
        vec![vec![integer(1)]]
    );
}

#[test]
fn workspace_elements_category_trash_detaches_elements_and_restores() {
    let (_dir, g) = database();
    let store = WorkspaceStore::new(&g, CLIENT);
    let c = context();
    category(&store, "people", "人物");
    element(&store, "hero", Some("林凯")).unwrap();
    exec(&g, "CREATE TRIGGER fail_category_receipt BEFORE INSERT ON sync_apply_receipt BEGIN SELECT RAISE(ABORT,'category receipt fault'); END");
    let before = state(&g);
    assert!(store
        .trash_element_category(&c, "people")
        .unwrap_err()
        .contains("category receipt fault"));
    assert_eq!(state(&g), before);
    exec(&g, "DROP TRIGGER fail_category_receipt");
    store.trash_element_category(&c, "people").unwrap();
    assert_eq!(
        latest(&g)
            .into_iter()
            .map(|m| (m.0, m.1))
            .collect::<Vec<_>>(),
        vec![("entity.trash".into(), "element-category:people".into())]
    );
    assert!(store.element_categories(&c.project_id).unwrap().is_empty());
    assert_eq!(
        store.trashed_element_categories(&c.project_id).unwrap()[0].id,
        "people"
    );
    assert_eq!(store.elements(&c.project_id).unwrap()[0].category_id, None);
    assert!(
        element(&store, "late", Some("迟到")).is_err(),
        "no new elements in a trashed category"
    );
    let restored = store
        .restore_element_category(&c, "people", |repo, tx, doc| {
            assert_eq!(doc, "category:people");
            Ok(ChapterSeed {
                update: repo.list_updates(doc, None, Some(tx))?[0]
                    .update_blob
                    .clone(),
                content_json: CACHE.into(),
            })
        })
        .unwrap();
    assert_eq!(restored.name, "人物");
    let wire = latest(&g);
    assert_eq!(
        wire.iter().map(|m| (m.0.as_str(), m.2)).collect::<Vec<_>>(),
        vec![("entity.restore", 1), ("yjs.update", 1)]
    );
    assert_eq!(
        wire[0].3,
        json!({"seed":{"color":"#A1B2C3","elementTemplateJson":"{}","gridX":null,"gridY":null,"layoutMode":"auto","name":"人物"}})
    );
    assert_eq!(
        store.elements(&c.project_id).unwrap()[0].category_id,
        None,
        "elements stay detached"
    );
    // Relations name categories with the entity kind `category`; trash
    // purges them, and one without a lifecycle fails closed.
    exec(&g,"INSERT INTO entity_relation(id,project_id,from_kind,from_id,to_kind,to_id,relation_type_id,created_at,updated_at) SELECT 'rel','elements-project','element','hero','category','people',id,'t','t' FROM entity_relation_type LIMIT 1");
    let before = state(&g);
    assert!(store
        .trash_element_category(&c, "people")
        .unwrap_err()
        .contains("no lifecycle"));
    assert_eq!(state(&g), before);
}
