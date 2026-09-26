//! Project summary, facts and storyline template, and chapter or drift summary
//! and writing status through the C ABI. Optional SQLite exports (every new
//! original per step) feed the production TypeScript reducer.
use super::*;
use std::collections::BTreeMap;

const FILE: &str = "apple-native-workspace.db";
const FAULT: &str = "CREATE TRIGGER fail_metadata_receipt BEFORE INSERT ON sync_apply_receipt BEGIN SELECT RAISE(ABORT, 'synthetic metadata receipt fault'); END";

fn query(db: &DatabaseGateway, sql: &str) -> Vec<Vec<DatabaseValue>> {
    db.query(sql.into(), vec![], None, CLIENT.into())
        .unwrap()
        .rows
}
fn rows(db: &DatabaseGateway) -> BTreeMap<String, Vec<Vec<DatabaseValue>>> {
    [
        "project",
        "book_node",
        "entity_kv_entry",
        "sync_change_set",
        "sync_mutation",
        "sync_apply_receipt",
        "sync_generation_writer_state",
        "sync_entity_lifecycle",
        "sync_field_clock",
        "sync_order_register",
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
        drift_id: &str,
    ) -> Option<Self> {
        let directory = PathBuf::from(std::env::var("NATIVE_WORKSPACE_METADATA_EXPORT_DIR").ok()?);
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
            "projectId":fixture.project,"chapterIds":fixture.chapters,"driftId":drift_id,
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
        command: &Value,
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
            "command":command,"originals":encoded,"result":reply["result"],"faultBeforeApply":fault}));
        std::fs::write(
            self.directory.join(format!("{}.json", self.name)),
            serde_json::to_vec_pretty(&self.fixture).unwrap(),
        )
        .unwrap();
    }
}
fn request(fixture: &Fixture, command: &Value) -> Value {
    json!({"operation":"workspaceMetadata","handle":fixture.workspace,"projectId":fixture.project,"command":command})
}

#[test]
fn workspace_metadata_project_facts_template_and_node_edits() {
    let mut fixture = Fixture::new();
    let first = fixture.open(0)["handle"].as_u64().unwrap();
    let db = gateway(first);
    let drift = success(
        json!({"operation":"workspaceDrifts","handle":fixture.workspace,"projectId":fixture.project,
            "command":{"action":"createDrift","title":"钟楼灵感"}}),
    )["result"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let initial = success(request(&fixture, &json!({"action":"project"})))["result"].clone();
    let facts = initial["facts"].as_array().unwrap().clone();
    assert!(facts.len() >= 2, "a new project seeds its default facts");
    let mut export = Export::start("metadata-project-and-nodes", &fixture, &db, &drift);
    let mut since = last_rowid(&db);
    let mut step = |operation: &str,
                    command: Value,
                    expected: Vec<Vec<&str>>,
                    fault: bool,
                    export: &mut Option<Export>| {
        if fault {
            let before = rows(&db);
            execute(&db, FAULT);
            assert!(
                rejected(request(&fixture, &command)).contains("synthetic metadata receipt fault")
            );
            assert_eq!(rows(&db), before, "{operation} failure writes nothing");
            execute(&db, "DROP TRIGGER fail_metadata_receipt");
        }
        let reply = success(request(&fixture, &command));
        assert_eq!(originals(&db, since), expected, "{operation}");
        since = last_rowid(&db);
        if let Some(export) = export {
            export.step(&fixture, &db, operation, &command, &reply, fault);
        }
        reply["result"].clone()
    };
    // Edit one fact's value, drop another, add a new one; set a template and
    // the summary: one original, facts before the template before the summary.
    let mut edited: Vec<Value> = facts.clone();
    edited[0]["value"] = json!("近未来的北方小城🙂");
    edited.remove(1);
    edited.push(json!({"key":"基调","value":"安静"}));
    let project = step(
        "updateProject",
        json!({"action":"updateProject","summary":"一座钟楼与它的守夜人。","facts":edited,
            "storylineTemplate":[{"key":"主题","value":""},{"key":"节奏","value":"慢"}]}),
        vec![vec![
            "entity.purge kv-entry",
            "field.set kv-entry",
            "entity.create kv-entry",
            "order.move kv-entry",
            "entity.create kv-entry",
            "entity.create kv-entry",
            "order.move kv-entry",
            "order.move kv-entry",
            "field.set project",
        ]],
        true,
        &mut export,
    );
    assert_eq!(project["summary"], "一座钟楼与它的守夜人。");
    assert_eq!(project["facts"], json!(edited));
    // Reordering the facts rebalances the whole scope, as the renderer plans
    // any reorder; nothing else is written.
    let mut reordered = edited.clone();
    let last = reordered.pop().unwrap();
    reordered.insert(0, last);
    step(
        "reorderFacts",
        json!({"action":"updateProject","facts":reordered}),
        vec![vec!["order.rebalance kv-entry"; reordered.len()]],
        false,
        &mut export,
    );
    let chapter = &fixture.chapters[0];
    let summary = step(
        "setNodeSummary",
        json!({"action":"setNodeSummary","nodeId":chapter,"summary":"她在雨夜回到北塔。"}),
        vec![vec!["field.set node"]],
        false,
        &mut export,
    );
    assert_eq!(summary["summary"], "她在雨夜回到北塔。");
    let status = step(
        "setNodeStatus",
        json!({"action":"setNodeStatus","nodeId":chapter,"status":"finished"}),
        vec![vec!["field.set node"]],
        true,
        &mut export,
    );
    assert_eq!(status["writingStatus"], "finished");
    let resting = step(
        "setNodeStatus",
        json!({"action":"setNodeStatus","nodeId":drift,"status":"resting"}),
        vec![vec!["field.set node"]],
        false,
        &mut export,
    );
    assert_eq!(
        (resting["kind"].as_str(), resting["writingStatus"].as_str()),
        (Some("drift"), Some("resting"))
    );
    step(
        "setNodeSummary",
        json!({"action":"setNodeSummary","nodeId":drift,"summary":"钟声从哪里来"}),
        vec![vec!["field.set node"]],
        false,
        &mut export,
    );
    // Refusals and unchanged edits write nothing.
    let before = rows(&db);
    for command in [
        json!({"action":"setNodeStatus","nodeId":chapter,"status":"resting"}),
        json!({"action":"setNodeStatus","nodeId":drift,"status":"finished"}),
        json!({"action":"setNodeStatus","nodeId":"missing","status":"draft"}),
        json!({"action":"setNodeSummary","nodeId":"missing","summary":"x"}),
        json!({"action":"updateProject","name":"x"}),
    ] {
        rejected(request(&fixture, &command));
    }
    success(request(
        &fixture,
        &json!({"action":"setNodeStatus","nodeId":drift,"status":"resting"}),
    ));
    success(request(
        &fixture,
        &json!({"action":"updateProject","summary":"一座钟楼与它的守夜人。","facts":reordered}),
    ));
    assert_eq!(rows(&db), before);
    // Cold reopen.
    fixture.close();
    fixture.workspace = success(json!({"operation":"workspaceOpen","directory":fixture.directory}))
        ["handle"]
        .as_u64()
        .unwrap();
    let reopened = success(request(&fixture, &json!({"action":"project"})))["result"].clone();
    assert_eq!(reopened["facts"], json!(reordered));
    assert_eq!(
        reopened["storylineTemplate"],
        json!([{"key":"主题","value":""},{"key":"节奏","value":"慢"}])
    );
    assert_eq!(reopened["summary"], "一座钟楼与它的守夜人。");
    let node =
        success(request(&fixture, &json!({"action":"node","nodeId":drift})))["result"].clone();
    assert_eq!(
        (node["summary"].as_str(), node["writingStatus"].as_str()),
        (Some("钟声从哪里来"), Some("resting"))
    );
    fixture.close();
}
