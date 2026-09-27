//! Relation types, curated relations and their removal by trash through the
//! C ABI. Optional SQLite exports (every new original per step) feed the
//! production TypeScript reducer.
use super::*;
use std::collections::BTreeMap;

const FILE: &str = "apple-native-workspace.db";
const FAULT: &str = "CREATE TRIGGER fail_relation_receipt BEFORE INSERT ON sync_apply_receipt BEGIN SELECT RAISE(ABORT, 'synthetic relation receipt fault'); END";

fn query(db: &DatabaseGateway, sql: &str) -> Vec<Vec<DatabaseValue>> {
    db.query(sql.into(), vec![], None, CLIENT.into())
        .unwrap()
        .rows
}
fn rows(db: &DatabaseGateway) -> BTreeMap<String, Vec<Vec<DatabaseValue>>> {
    [
        "entity_relation",
        "entity_relation_type",
        "entity_relation_type_endpoint_kind",
        "element",
        "book_node",
        "storylines",
        "node_storyline_link",
        "sync_change_set",
        "sync_mutation",
        "sync_apply_receipt",
        "sync_generation_writer_state",
        "sync_entity_lifecycle",
        "sync_field_clock",
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
fn last_rowid(db: &DatabaseGateway) -> i64 {
    match &query(db, "SELECT COALESCE(MAX(rowid),0) FROM sync_change_set")[0][0] {
        DatabaseValue::Integer(v) => v.parse().unwrap(),
        _ => panic!("rowid"),
    }
}
/// The actions of every change-set after `since`, one list per original.
fn originals(db: &DatabaseGateway, since: i64) -> Vec<Vec<String>> {
    query(db, &format!("SELECT change_set_id FROM sync_change_set WHERE rowid>{since} ORDER BY rowid"))
        .into_iter()
        .map(|row| {
            let DatabaseValue::Text(id) = &row[0] else { panic!("id") };
            query(db, &format!("SELECT action||' '||target_kind FROM sync_mutation WHERE change_set_id='{id}' ORDER BY mutation_index"))
                .into_iter()
                .map(|row| match &row[0] { DatabaseValue::Text(v) => v.clone(), _ => panic!("action") })
                .collect()
        })
        .collect()
}
struct Export {
    directory: PathBuf,
    name: &'static str,
    fixture: Value,
    since: i64,
}
impl Export {
    fn start(
        name: &'static str,
        fixture: &Fixture,
        db: &DatabaseGateway,
        entities: Value,
    ) -> Option<Self> {
        let directory = PathBuf::from(std::env::var("NATIVE_WORKSPACE_RELATION_EXPORT_DIR").ok()?);
        std::fs::create_dir_all(&directory).unwrap();
        let file = format!("{name}-before.db");
        Self::copy(fixture, db, &directory.join(&file));
        let writer = query(
            db,
            "SELECT installation_id,writer_id,writer_epoch FROM sync_generation_writer_state",
        );
        let string = |index| match &writer[0][index] {
            DatabaseValue::Text(value) => value.clone(),
            _ => panic!("writer"),
        };
        Some(Self {
            directory,
            name,
            since: last_rowid(db),
            fixture: json!({"name":name,"beforeDatabase":file,
            "projectId":fixture.project,"chapterIds":fixture.chapters,"entities":entities,
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
        request: &Value,
        reply: &Value,
        fault: bool,
    ) {
        let index = self.fixture["steps"].as_array().unwrap().len();
        let file = format!("{}-after-{index}.db", self.name);
        Self::copy(fixture, db, &self.directory.join(&file));
        let encoded: Vec<Value> = query(db, &format!("SELECT encoded_bytes,mutation_count,created_at FROM sync_change_set WHERE rowid>{} AND origin='local' ORDER BY rowid", self.since))
            .into_iter()
            .map(|row| {
                let DatabaseValue::Blob(bytes) = &row[0] else { panic!("original") };
                let DatabaseValue::Integer(count) = &row[1] else { panic!("count") };
                let DatabaseValue::Text(created) = &row[2] else { panic!("created") };
                json!({"encodedBase64":STANDARD.encode(bytes),"mutationCount":count.parse::<u64>().unwrap(),"createdAt":created})
            })
            .collect();
        self.since = last_rowid(db);
        self.fixture["steps"].as_array_mut().unwrap().push(json!({"afterDatabase":file,"operation":operation,
            "request":request,"originals":encoded,"result":reply["result"],"library":reply["library"],"faultBeforeApply":fault}));
        std::fs::write(
            self.directory.join(format!("{}.json", self.name)),
            serde_json::to_vec_pretty(&self.fixture).unwrap(),
        )
        .unwrap();
    }
}
fn relations(fixture: &Fixture, command: Value) -> Value {
    json!({"operation":"workspaceRelations","handle":fixture.workspace,"projectId":fixture.project,"command":command})
}
fn scoped(fixture: &Fixture, operation: &str, command: Value) -> Value {
    json!({"operation":operation,"handle":fixture.workspace,"projectId":fixture.project,"command":command})
}
fn definition(
    name: &str,
    orientation: &str,
    roles: (&str, &str),
    source: &[&str],
    target: &[&str],
) -> Value {
    json!({"name":name,"description":"","orientation":orientation,"sourceRole":roles.0,"targetRole":roles.1,
        "sourceKinds":source,"targetKinds":target})
}

#[test]
fn workspace_relations_types_edges_trash_and_cold_reopen() {
    let mut fixture = Fixture::new();
    let first = fixture.open(0)["handle"].as_u64().unwrap();
    let db = gateway(first);
    let category = success(scoped(
        &fixture,
        "workspaceElements",
        json!({"action":"createCategory","name":"人物"}),
    ))["result"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let element = |name: &str| {
        success(scoped(
            &fixture,
            "workspaceElements",
            json!({"action":"createElement","categoryId":category,"name":name}),
        ))["result"]["id"]
            .as_str()
            .unwrap()
            .to_string()
    };
    let (mira, oren, ash) = (element("米拉"), element("奥伦"), element("灰"));
    let storyline = success(scoped(
        &fixture,
        "workspaceStorylines",
        json!({"action":"createStoryline","name":"主线"}),
    ))["result"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let chapter = fixture.chapters[1].clone();
    let mut export = Export::start(
        "relations-types-edges-and-trash",
        &fixture,
        &db,
        json!({"category":category,"elements":[mira,oren,ash],"storyline":storyline}),
    );
    let mut since = last_rowid(&db);
    let mut step = |operation: &str,
                    request: Value,
                    expected: Vec<Vec<&str>>,
                    fault: bool,
                    export: &mut Option<Export>| {
        if fault {
            let before = rows(&db);
            execute(&db, FAULT);
            assert!(rejected(request.clone()).contains("synthetic relation receipt fault"));
            assert_eq!(rows(&db), before, "{operation} failure writes nothing");
            execute(&db, "DROP TRIGGER fail_relation_receipt");
        }
        let reply = success(request.clone());
        assert_eq!(originals(&db, since), expected, "{operation}");
        since = last_rowid(&db);
        if let Some(export) = export {
            export.step(&fixture, &db, operation, &request, &reply, fault);
        }
        reply
    };
    let mentor = step("createType",
        relations(&fixture, json!({"action":"createType","definition":definition(" 师徒 ","directed",("师父","徒弟"),&["element"],&["element","node"])})),
        vec![vec!["entity.create entity-relation-type"]], true, &mut export)["result"]["id"].as_str().unwrap().to_string();
    let ally = step("createType",
        relations(&fixture, json!({"action":"createType","definition":definition("同盟","symmetric",("",""),&["node","element"],&["element","node"])})),
        vec![vec!["entity.create entity-relation-type"]], false, &mut export)["result"]["id"].as_str().unwrap().to_string();
    let cast = step("createType",
        relations(&fixture, json!({"action":"createType","definition":definition("出场","directed",("故事线","角色"),&["storyline","node"],&["element"])})),
        vec![vec!["entity.create entity-relation-type"]], false, &mut export)["result"]["id"].as_str().unwrap().to_string();
    let edge = step("addRelation",
        relations(&fixture, json!({"action":"addRelation","fromKind":"element","fromId":mira,"toKind":"element","toId":oren,"relationTypeId":mentor})),
        vec![vec!["entity.create entity-relation"]], true, &mut export)["result"]["id"].as_str().unwrap().to_string();
    // A symmetric edge is stored with the bytewise-smaller endpoint first.
    let pact = step("addRelation",
        relations(&fixture, json!({"action":"addRelation","fromKind":"node","fromId":chapter,"toKind":"element","toId":ash,"relationTypeId":ally})),
        vec![vec!["entity.create entity-relation"]], false, &mut export)["result"].clone();
    assert_eq!(
        (pact["fromKind"].as_str(), pact["toKind"].as_str()),
        (Some("element"), Some("node"))
    );
    step(
        "addRelation",
        relations(
            &fixture,
            json!({"action":"addRelation","fromKind":"storyline","fromId":storyline,"toKind":"element","toId":mira,"relationTypeId":cast}),
        ),
        vec![vec!["entity.create entity-relation"]],
        false,
        &mut export,
    );
    step(
        "addRelation",
        relations(
            &fixture,
            json!({"action":"addRelation","fromKind":"storyline","fromId":storyline,"toKind":"element","toId":oren,"relationTypeId":cast}),
        ),
        vec![vec!["entity.create entity-relation"]],
        false,
        &mut export,
    );
    let swapped = step("retypeRelation",
        relations(&fixture, json!({"action":"retypeRelation","relationId":edge,"relationTypeId":mentor,"swap":true})),
        vec![vec!["field.set entity-relation"; 5]], false, &mut export)["result"].clone();
    assert_eq!(
        (swapped["fromId"].as_str(), swapped["toId"].as_str()),
        (Some(oren.as_str()), Some(mira.as_str()))
    );
    step(
        "updateType",
        relations(
            &fixture,
            json!({"action":"updateType","relationTypeId":ally,"definition":{"name":"同盟","description":"并肩作战","orientation":"symmetric","sourceKinds":["node","element"],"targetKinds":["node","element"]}}),
        ),
        vec![vec!["field.set entity-relation-type"; 10]],
        false,
        &mut export,
    );
    // Refusals and no-ops write nothing.
    let before = rows(&db);
    for command in [
        json!({"action":"addRelation","fromKind":"node","fromId":chapter,"toKind":"element","toId":mira,"relationTypeId":mentor}),
        json!({"action":"addRelation","fromKind":"element","fromId":mira,"toKind":"element","toId":"missing","relationTypeId":mentor}),
        json!({"action":"createType","definition":definition("师徒","directed",("a","b"),&["element"],&["element"])}),
        json!({"action":"deleteType","relationTypeId":mentor}),
        json!({"action":"deleteType","relationTypeId":format!("system:generic-association:{}", fixture.project)}),
        json!({"action":"retypeRelation","relationId":"missing","relationTypeId":mentor}),
        json!({"action":"addRelation","fromKind":"element","fromId":oren,"toKind":"element","toId":oren,"relationTypeId":mentor}),
        json!({"action":"addRelation","fromKind":"element","fromId":mira,"toKind":"element","toId":oren,"relationTypeId":mentor,"extra":1}),
    ] {
        rejected(relations(&fixture, command));
    }
    let same = success(relations(
        &fixture,
        json!({"action":"addRelation","fromKind":"element","fromId":oren,"toKind":"element","toId":mira,"relationTypeId":mentor}),
    ));
    assert_eq!(same["result"]["id"], edge, "an identical edge is returned");
    success(relations(
        &fixture,
        json!({"action":"removeRelation","relationId":"missing"}),
    ));
    assert_eq!(rows(&db), before);
    // Trash purges every relation touching the entity inside its original.
    step(
        "trashElement",
        scoped(
            &fixture,
            "workspaceElements",
            json!({"action":"trashElement","elementId":mira}),
        ),
        vec![vec![
            "entity.purge entity-relation",
            "entity.purge entity-relation",
            "entity.trash element",
        ]],
        true,
        &mut export,
    );
    step(
        "trashChapter",
        json!({"operation":"workspaceTrashChapter","handle":fixture.workspace,"projectId":fixture.project,"chapterId":chapter}),
        vec![vec!["entity.purge entity-relation", "entity.trash node"]],
        false,
        &mut export,
    );
    step(
        "trashStoryline",
        scoped(
            &fixture,
            "workspaceStorylines",
            json!({"action":"trashStoryline","storylineId":storyline}),
        ),
        // The live chapter it was primary for is projected, as without relations.
        vec![vec![
            "entity.purge entity-relation",
            "set.remove membership",
            "field.set node-storyline-primary",
            "entity.trash storyline",
        ]],
        false,
        &mut export,
    );
    let library = step(
        "deleteType",
        relations(
            &fixture,
            json!({"action":"deleteType","relationTypeId":cast}),
        ),
        vec![vec!["entity.purge entity-relation-type"]],
        false,
        &mut export,
    )["library"]
        .clone();
    assert!(library["relations"].as_array().unwrap().is_empty());
    assert_eq!(library["types"].as_array().unwrap().len(), 3);
    // Cold reopen.
    fixture.close();
    fixture.workspace = success(json!({"operation":"workspaceOpen","directory":fixture.directory}))
        ["handle"]
        .as_u64()
        .unwrap();
    let reopened = success(relations(&fixture, json!({"action":"library"})))["library"].clone();
    assert_eq!(reopened, library);
    fixture.close();
}
