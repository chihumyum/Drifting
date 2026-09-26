//! Elements library commands and element body owners through the C ABI.
//! Optional SQLite exports feed the production TypeScript reducer.
use super::*;
use std::collections::BTreeMap;

const FILE: &str = "apple-native-workspace.db";
const FAULT: &str = "CREATE TRIGGER fail_element_receipt BEFORE INSERT ON sync_apply_receipt BEGIN SELECT RAISE(ABORT, 'synthetic element receipt fault'); END";

fn query(db: &DatabaseGateway, sql: &str) -> Vec<Vec<DatabaseValue>> {
    db.query(sql.into(), vec![], None, CLIENT.into())
        .unwrap()
        .rows
}
fn rows(db: &DatabaseGateway) -> BTreeMap<String, Vec<Vec<DatabaseValue>>> {
    [
        "element",
        "element_category",
        "book_node",
        "sync_change_set",
        "sync_mutation",
        "sync_apply_receipt",
        "sync_generation_writer_state",
        "sync_entity_lifecycle",
        "sync_field_clock",
        "sync_set_tag",
        "yjs_updates",
        "yjs_document_revision",
    ]
    .into_iter()
    .map(|table| {
        (
            table.into(),
            query(db, &format!("SELECT * FROM {table} ORDER BY rowid")),
        )
    })
    .collect()
}
fn unchanged(db: &DatabaseGateway, before: &BTreeMap<String, Vec<Vec<DatabaseValue>>>) {
    let after = rows(db);
    for (table, expected) in before {
        assert!(
            after.get(table) == Some(expected),
            "table {table} changed on failure"
        );
    }
}
fn workspace_gateway(fixture: &Fixture) -> DatabaseGateway {
    let owner = fixture.open(0)["handle"].as_u64().unwrap();
    gateway(owner)
}
fn actions(db: &DatabaseGateway) -> Vec<String> {
    query(db, "SELECT m.action||' '||m.target_kind FROM sync_mutation m JOIN sync_change_set c USING(change_set_id) WHERE c.rowid=(SELECT MAX(rowid) FROM sync_change_set) ORDER BY m.mutation_index")
        .into_iter()
        .map(|row| match &row[0] {
            DatabaseValue::Text(value) => value.clone(),
            _ => panic!("action"),
        })
        .collect()
}
fn latest(db: &DatabaseGateway) -> Value {
    let values = query(db, "SELECT encoded_bytes,mutation_count,created_at FROM sync_change_set WHERE origin='local' ORDER BY rowid DESC LIMIT 1");
    let DatabaseValue::Blob(bytes) = &values[0][0] else {
        panic!("original bytes")
    };
    let DatabaseValue::Integer(count) = &values[0][1] else {
        panic!("mutation count")
    };
    let DatabaseValue::Text(created) = &values[0][2] else {
        panic!("created at")
    };
    json!({"encodedBase64":STANDARD.encode(bytes),"mutationCount":count.parse::<u64>().unwrap(),"createdAt":created})
}
struct Export {
    directory: PathBuf,
    name: &'static str,
    fixture: Value,
}
impl Export {
    fn start(name: &'static str, fixture: &Fixture, db: &DatabaseGateway) -> Option<Self> {
        let directory = PathBuf::from(std::env::var("NATIVE_WORKSPACE_ELEMENT_EXPORT_DIR").ok()?);
        std::fs::create_dir_all(&directory).unwrap();
        let file = format!("{name}-before.db");
        Self::copy(fixture, db, &directory.join(&file));
        let writer = query(
            db,
            "SELECT installation_id,writer_id,writer_epoch FROM sync_generation_writer_state",
        );
        assert_eq!(writer.len(), 1);
        let string = |index| match &writer[0][index] {
            DatabaseValue::Text(value) => value.clone(),
            _ => panic!("writer"),
        };
        Some(Self {
            directory,
            name,
            fixture: json!({"name":name,"beforeDatabase":file,"projectId":fixture.project,
            "identity":{"installationId":string(0),"writerId":string(1),"writerEpoch":string(2)},"steps":[]}),
        })
    }
    fn copy(fixture: &Fixture, db: &DatabaseGateway, path: &PathBuf) {
        assert_eq!(
            serde_json::to_value(db.checkpoint(CLIENT.into()).unwrap()).unwrap()["busy"],
            0
        );
        std::fs::copy(fixture.directory.join(FILE), path).unwrap();
    }
    fn step(
        &mut self,
        fixture: &Fixture,
        db: &DatabaseGateway,
        operation: &str,
        result: &Value,
        fault: bool,
    ) {
        let index = self.fixture["steps"].as_array().unwrap().len();
        let file = format!("{}-after-{index}.db", self.name);
        Self::copy(fixture, db, &self.directory.join(&file));
        let mut step = latest(db);
        step["afterDatabase"] = json!(file);
        step["operation"] = json!(operation);
        step["result"] = result.clone();
        step["faultBeforeApply"] = json!(fault);
        self.fixture["steps"].as_array_mut().unwrap().push(step);
        std::fs::write(
            self.directory.join(format!("{}.json", self.name)),
            serde_json::to_vec_pretty(&self.fixture).unwrap(),
        )
        .unwrap();
    }
}
fn command(fixture: &Fixture, command: Value) -> Value {
    success(
        json!({"operation":"workspaceElements","handle":fixture.workspace,
        "projectId":fixture.project,"command":command}),
    )
}
fn refused(fixture: &Fixture, command: Value) -> String {
    rejected(
        json!({"operation":"workspaceElements","handle":fixture.workspace,
        "projectId":fixture.project,"command":command}),
    )
}
fn replace(handle: u64, location: u64, length: u64, text: &str) -> Value {
    let current = state(handle);
    success(
        json!({"operation":"documentReplace","handle":handle,"edit":{
        "revision":current["projection"]["revision"],
        "range":{"location":location,"length":length},"text":text}}),
    )
}

#[test]
fn workspace_element_library_create_update_and_cold_reopen() {
    let mut fixture = Fixture::new();
    let db = workspace_gateway(&fixture);
    let chapter = state(fixture.open(0)["handle"].as_u64().unwrap());
    let mut export = Export::start(
        "element-library-create-update-and-cold-reopen",
        &fixture,
        &db,
    );
    let people = command(&fixture, json!({"action":"createCategory","name":"人物"}));
    let category = people["result"].clone();
    assert!(category["color"].as_str().unwrap().starts_with('#'));
    assert_eq!(
        actions(&db),
        [
            "entity.create element-category",
            "yjs.update prose-document"
        ]
    );
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "createCategory", &category, false);
    }
    let created = command(
        &fixture,
        json!({"action":"createElement","categoryId":category["id"],"groupName":"主角"}),
    );
    let hero = created["result"].clone();
    assert_eq!(hero["name"], "New Element");
    assert_eq!(created["library"]["elements"][0]["id"], hero["id"]);
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "createElement", &hero, false);
    }
    let updated = command(&fixture, json!({"action":"updateElement","elementId":hero["id"],
        "name":"林凯🙂","summary":"雨夜来信的收件人","groupName":null,"aliases":["阿凯"," Ｋａｉ "]}))["result"].clone();
    assert_eq!(updated["aliases"], json!(["Kai", "阿凯"]));
    assert_eq!(updated["groupName"], Value::Null);
    assert_eq!(
        actions(&db),
        [
            "set.add alias",
            "set.add alias",
            "field.set element",
            "field.set element",
            "field.set element"
        ]
    );
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "updateElement", &updated, false);
    }
    let recoloured = command(&fixture, json!({"action":"updateCategory","categoryId":category["id"],"name":"主要人物","color":"#112233"}))["result"].clone();
    assert_eq!(recoloured["name"], "主要人物");
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "updateCategory", &recoloured, false);
    }
    // A display change removes the observed tag and re-adds the member.
    let realiased = command(
        &fixture,
        json!({"action":"updateElement","elementId":hero["id"],"aliases":["阿凯","KAI"]}),
    )["result"]
        .clone();
    assert_eq!(realiased["aliases"], json!(["KAI", "阿凯"]));
    assert_eq!(actions(&db), ["set.remove alias", "set.add alias"]);
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "updateElement", &realiased, false);
    }
    // The element body is a durable owner of its own.
    let opened = command(
        &fixture,
        json!({"action":"openElement","elementId":hero["id"]}),
    );
    let body = opened["handle"].as_u64().unwrap();
    assert_eq!(
        opened["document"]["projection"]["blocks"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    replace(body, 0, 0, "外貌：黑衣🙂");
    assert_eq!(
        success(json!({"operation":"documentUndo","handle":body}))["projection"]["text"],
        ""
    );
    assert_eq!(
        success(json!({"operation":"documentRedo","handle":body}))["projection"]["text"],
        "外貌：黑衣🙂"
    );
    assert_eq!(
        command(
            &fixture,
            json!({"action":"openElement","elementId":hero["id"]})
        )["handle"],
        json!(body)
    );
    assert!(refused(
        &fixture,
        json!({"action":"createElement","categoryId":category["id"],"name":"kai"})
    )
    .contains("already used"));
    fixture.close();
    fixture.workspace = success(json!({"operation":"workspaceOpen","directory":fixture.directory}))
        ["handle"]
        .as_u64()
        .unwrap();
    let library = command(&fixture, json!({"action":"library"}))["library"].clone();
    assert_eq!(library["elements"][0], realiased);
    assert_eq!(library["categories"][0]["color"], "#112233");
    let body = command(
        &fixture,
        json!({"action":"openElement","elementId":hero["id"]}),
    );
    assert_eq!(body["document"]["projection"]["text"], "外貌：黑衣🙂");
    assert_eq!(
        state(fixture.open(0)["handle"].as_u64().unwrap())["projection"]["text"],
        chapter["projection"]["text"]
    );
    fixture.close();
}

#[test]
fn workspace_element_trash_retires_owner_and_restore_reopens_body() {
    let fixture = Fixture::new();
    let db = workspace_gateway(&fixture);
    let category =
        command(&fixture, json!({"action":"createCategory","name":"地点"}))["result"].clone();
    let place = command(
        &fixture,
        json!({"action":"createElement","categoryId":category["id"],"name":"北塔"}),
    )["result"]
        .clone();
    command(
        &fixture,
        json!({"action":"updateElement","elementId":place["id"],"aliases":["灯塔"]}),
    );
    let body = command(
        &fixture,
        json!({"action":"openElement","elementId":place["id"]}),
    )["handle"]
        .as_u64()
        .unwrap();
    replace(body, 0, 0, "海岸线尽头");
    let mut export = Export::start(
        "element-trash-retires-owner-and-restore-reopens-body",
        &fixture,
        &db,
    );
    let trashed = command(
        &fixture,
        json!({"action":"trashElement","elementId":place["id"]}),
    );
    assert_eq!(actions(&db), ["entity.trash element"]);
    assert!(trashed["library"]["elements"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(trashed["library"]["trashedElements"][0]["id"], place["id"]);
    assert!(
        !rejected(json!({"operation":"documentRead","handle":body})).is_empty(),
        "owner retired"
    );
    assert!(!refused(
        &fixture,
        json!({"action":"openElement","elementId":place["id"]})
    )
    .is_empty());
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "trashElement", &trashed["result"], false);
    }
    let restored = command(
        &fixture,
        json!({"action":"restoreElement","elementId":place["id"]}),
    );
    assert_eq!(
        actions(&db),
        [
            "entity.restore element",
            "set.add alias",
            "yjs.update prose-document"
        ]
    );
    assert_eq!(restored["result"]["aliases"], json!(["灯塔"]));
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "restoreElement", &restored["result"], false);
    }
    let reopened = command(
        &fixture,
        json!({"action":"openElement","elementId":place["id"]}),
    );
    assert_eq!(reopened["document"]["projection"]["text"], "海岸线尽头");
    assert_eq!(reopened["document"]["projection"]["canUndo"], false);
    replace(reopened["handle"].as_u64().unwrap(), 0, 0, "北方");
    command(
        &fixture,
        json!({"action":"closeElement","elementId":place["id"]}),
    );
    let again = command(
        &fixture,
        json!({"action":"openElement","elementId":place["id"]}),
    );
    assert_eq!(again["document"]["projection"]["text"], "北方海岸线尽头");
    fixture.close();
}

#[test]
fn workspace_element_failures_roll_back_and_retry() {
    let fixture = Fixture::new();
    let db = workspace_gateway(&fixture);
    let mut export = Export::start("element-failures-roll-back-and-retry", &fixture, &db);
    let mut category = Value::Null;
    let mut element = Value::Null;
    for step in [
        "createCategory",
        "createElement",
        "updateElement",
        "trashElement",
        "restoreElement",
    ] {
        let request = match step {
            "createCategory" => json!({"action":step,"name":"势力"}),
            "createElement" => {
                json!({"action":step,"categoryId":category["id"],"name":"北塔守夜人"})
            }
            "updateElement" => {
                json!({"action":step,"elementId":element["id"],"summary":"值夜","aliases":["守夜人"]})
            }
            _ => json!({"action":step,"elementId":element["id"]}),
        };
        let before = rows(&db);
        execute(&db, FAULT);
        assert!(refused(&fixture, request.clone()).contains("synthetic element receipt fault"));
        unchanged(&db, &before);
        execute(&db, "DROP TRIGGER fail_element_receipt");
        let result = command(&fixture, request)["result"].clone();
        match step {
            "createCategory" => category = result.clone(),
            "createElement" => element = result.clone(),
            _ => {}
        }
        if let Some(export) = &mut export {
            export.step(&fixture, &db, step, &result, true);
        }
    }
    let before = rows(&db);
    for request in [
        json!({"action":"createElement","categoryId":"missing-category","name":"x"}),
        json!({"action":"createElement","categoryId":category["id"],"name":" 守夜人 "}),
        json!({"action":"updateCategory","categoryId":category["id"],"color":"blue"}),
        json!({"action":"updateElement","elementId":element["id"],"categoryId":"missing-category"}),
        json!({"action":"restoreElement","elementId":element["id"]}),
        json!({"action":"closeElement","elementId":element["id"]}),
        json!({"action":"updateElement","elementId":element["id"],"unknown":true}),
    ] {
        assert!(!refused(&fixture, request).is_empty());
    }
    unchanged(&db, &before);
    fixture.close();
}

#[test]
fn workspace_element_facts_templates_and_category_trash() {
    let mut fixture = Fixture::new();
    let db = workspace_gateway(&fixture);
    let category =
        command(&fixture, json!({"action":"createCategory","name":"人物"}))["result"].clone();
    let mut export = Export::start("element-facts-templates-and-category-trash", &fixture, &db);
    let template = json!([{"key":"年龄","value":""},{"key":"阵营","value":""}]);
    let templated = command(
        &fixture,
        json!({"action":"setCategoryTemplateFacts","categoryId":category["id"],"facts":template}),
    )["result"]
        .clone();
    assert_eq!(templated["templateFacts"], template);
    assert_eq!(
        actions(&db),
        [
            "entity.create kv-entry",
            "entity.create kv-entry",
            "order.move kv-entry",
            "order.move kv-entry"
        ]
    );
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "setCategoryTemplateFacts", &templated, false);
    }
    let hero = command(
        &fixture,
        json!({"action":"createElement","categoryId":category["id"],"name":"林凯"}),
    )["result"]
        .clone();
    assert_eq!(hero["facts"], template);
    assert_eq!(
        actions(&db),
        [
            "entity.create kv-entry",
            "entity.create kv-entry",
            "order.move kv-entry",
            "order.move kv-entry",
            "entity.create element",
            "yjs.update prose-document"
        ]
    );
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "createElement", &hero, false);
    }
    let edited = command(&fixture, json!({"action":"setElementFacts","elementId":hero["id"],"facts":[
        {"key":"年龄","value":"二十七"},{"key":"住址","value":"北塔🙂"},{"key":"阵营","value":"邮局"}]}))["result"].clone();
    assert_eq!(
        actions(&db),
        [
            "field.set kv-entry",
            "entity.create kv-entry",
            "field.set kv-entry",
            "order.move kv-entry"
        ]
    );
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "setElementFacts", &edited, false);
    }
    let reordered = command(
        &fixture,
        json!({"action":"setElementFacts","elementId":hero["id"],"facts":[
        {"key":"阵营","value":"邮局"},{"key":"年龄","value":"二十七"}]}),
    )["result"]
        .clone();
    assert_eq!(
        actions(&db),
        [
            "entity.purge kv-entry",
            "order.rebalance kv-entry",
            "order.rebalance kv-entry"
        ]
    );
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "setElementFacts", &reordered, false);
    }
    let trashed = command(
        &fixture,
        json!({"action":"trashCategory","categoryId":category["id"]}),
    );
    assert_eq!(actions(&db), ["entity.trash element-category"]);
    assert_eq!(trashed["library"]["elements"][0]["categoryId"], Value::Null);
    assert_eq!(
        trashed["library"]["trashedCategories"][0]["id"],
        category["id"]
    );
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "trashCategory", &trashed["result"], false);
    }
    let restored = command(
        &fixture,
        json!({"action":"restoreCategory","categoryId":category["id"]}),
    );
    assert_eq!(
        actions(&db),
        [
            "entity.restore element-category",
            "yjs.update prose-document"
        ]
    );
    assert_eq!(restored["result"]["templateFacts"], template);
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "restoreCategory", &restored["result"], false);
    }
    let before = rows(&db);
    let request = json!({"action":"setElementFacts","elementId":hero["id"],"facts":[{"key":"阵营","value":"灯塔"}]});
    execute(&db, FAULT);
    assert!(refused(&fixture, request.clone()).contains("synthetic element receipt fault"));
    unchanged(&db, &before);
    execute(&db, "DROP TRIGGER fail_element_receipt");
    let retried = command(&fixture, request)["result"].clone();
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "setElementFacts", &retried, true);
    }
    assert_eq!(retried["facts"], json!([{"key":"阵营","value":"灯塔"}]));
    fixture.close();
    fixture.workspace = success(json!({"operation":"workspaceOpen","directory":fixture.directory}))
        ["handle"]
        .as_u64()
        .unwrap();
    let library = command(&fixture, json!({"action":"library"}))["library"].clone();
    assert_eq!(library["elements"][0]["facts"], retried["facts"]);
    assert_eq!(library["elements"][0]["categoryId"], Value::Null);
    assert_eq!(library["categories"][0]["templateFacts"], template);
    fixture.close();
}
