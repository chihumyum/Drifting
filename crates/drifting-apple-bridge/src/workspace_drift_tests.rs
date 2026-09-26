//! Drift notes, drift groups, act binding and drift bodies through the C ABI.
//! Optional SQLite exports (every new original per step) feed the production
//! TypeScript reducer.
use super::*;
use std::collections::BTreeMap;

const FILE: &str = "apple-native-workspace.db";
const FAULT: &str = "CREATE TRIGGER fail_drift_receipt BEFORE INSERT ON sync_apply_receipt BEGIN SELECT RAISE(ABORT, 'synthetic drift receipt fault'); END";

fn query(db: &DatabaseGateway, sql: &str) -> Vec<Vec<DatabaseValue>> {
    db.query(sql.into(), vec![], None, CLIENT.into())
        .unwrap()
        .rows
}
fn rows(db: &DatabaseGateway) -> BTreeMap<String, Vec<Vec<DatabaseValue>>> {
    [
        "book_node",
        "node_content",
        "book_act",
        "drift_group",
        "sync_change_set",
        "sync_mutation",
        "sync_apply_receipt",
        "sync_generation_writer_state",
        "sync_entity_lifecycle",
        "sync_field_clock",
        "sync_order_register",
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
    fn start(name: &'static str, fixture: &Fixture, db: &DatabaseGateway) -> Option<Self> {
        let directory = PathBuf::from(std::env::var("NATIVE_WORKSPACE_DRIFT_EXPORT_DIR").ok()?);
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
            "projectId":fixture.project,"chapterIds":fixture.chapters,
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
            "originals":encoded,"result":reply["result"],"library":reply["library"],"faultBeforeApply":fault}));
        std::fs::write(
            self.directory.join(format!("{}.json", self.name)),
            serde_json::to_vec_pretty(&self.fixture).unwrap(),
        )
        .unwrap();
    }
}
fn command(fixture: &Fixture, command: Value) -> Value {
    success(
        json!({"operation":"workspaceDrifts","handle":fixture.workspace,"projectId":fixture.project,"command":command}),
    )
}
fn refused(fixture: &Fixture, command: Value) -> String {
    rejected(
        json!({"operation":"workspaceDrifts","handle":fixture.workspace,"projectId":fixture.project,"command":command}),
    )
}

#[test]
fn workspace_drifts_groups_bodies_links_and_cold_reopen() {
    let mut fixture = Fixture::new();
    let first = fixture.open(0)["handle"].as_u64().unwrap();
    let db = gateway(first);
    let mut export = Export::start("drift-groups-bodies-links-and-cold-reopen", &fixture, &db);
    let group = command(&fixture, json!({"action":"createGroup","name":"灵感"}));
    let group_id = group["result"]["id"].clone();
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "createGroup", &group, false);
    }
    let sub = command(
        &fixture,
        json!({"action":"createGroup","name":"细节","parentGroupId":group_id}),
    );
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "createGroup", &sub, false);
    }
    assert!(refused(
        &fixture,
        json!({"action":"createGroup","name":"太深","parentGroupId":sub["result"]["id"]})
    )
    .contains("one level"));
    let created = command(
        &fixture,
        json!({"action":"createDrift","title":"雨夜钟声","groupId":group_id}),
    );
    let drift = created["result"].clone();
    assert_eq!(drift["driftGroupId"], group_id);
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "createDrift", &created, false);
    }
    let other = command(
        &fixture,
        json!({"action":"createDrift","title":"北塔","groupId":group_id}),
    );
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "createDrift", &other, false);
    }
    // Title alone is renameNode: a colliding title is suffixed.
    let collided = command(
        &fixture,
        json!({"action":"updateDrift","driftId":drift["id"],"title":"北塔"}),
    );
    assert_eq!(collided["result"]["title"], "北塔 2");
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "renameDrift", &collided, false);
    }
    let renamed = command(
        &fixture,
        json!({"action":"updateDrift","driftId":drift["id"],"title":"雨夜钟声🙂","groupId":sub["result"]["id"]}),
    );
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "updateDrift", &renamed, false);
    }
    // Group alone is moveDriftToGroup; the deleted group then lifts both
    // member drifts.
    let moved = command(
        &fixture,
        json!({"action":"updateDrift","driftId":drift["id"],"groupId":group_id}),
    );
    assert_eq!(moved["result"]["driftGroupId"], group_id);
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "moveDrift", &moved, false);
    }
    let deleted = command(&fixture, json!({"action":"deleteGroup","groupId":group_id}));
    assert_eq!(deleted["library"]["groups"].as_array().unwrap().len(), 1);
    assert_eq!(
        deleted["library"]["groups"][0]["parentGroupId"],
        Value::Null
    );
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "deleteGroup", &deleted, false);
    }
    // The drift body is a durable owner of its own; chapters link drift titles.
    let body = command(
        &fixture,
        json!({"action":"openDrift","driftId":drift["id"]}),
    )["handle"]
        .as_u64()
        .unwrap();
    let current = state(body);
    success(
        json!({"operation":"documentReplace","handle":body,"edit":{"revision":current["projection"]["revision"],
        "range":{"location":0,"length":0},"text":"钟楼在北边"}}),
    );
    let current = state(first);
    success(
        json!({"operation":"documentReplace","handle":first,"edit":{"revision":current["projection"]["revision"],
        "range":{"location":0,"length":0},"text":"她想起雨夜钟声🙂。"}}),
    );
    assert_eq!(
        success(json!({"operation":"documentLinkEntities","handle":first}))["linked"],
        1
    );
    fixture.close();
    fixture.workspace = success(json!({"operation":"workspaceOpen","directory":fixture.directory}))
        ["handle"]
        .as_u64()
        .unwrap();
    let library = command(&fixture, json!({"action":"library"}));
    assert_eq!(library["library"]["drifts"][0]["title"], "雨夜钟声🙂");
    let body = command(
        &fixture,
        json!({"action":"openDrift","driftId":drift["id"]}),
    );
    assert_eq!(body["document"]["projection"]["text"], "钟楼在北边");
    fixture.close();
}

#[test]
fn workspace_drifts_act_binding_trash_restore_and_failures() {
    let fixture = Fixture::new();
    let first = fixture.open(0)["handle"].as_u64().unwrap();
    let db = gateway(first);
    let act = success(
        json!({"operation":"workspaceCreateAct","handle":fixture.workspace,"projectId":fixture.project,"chapterId":fixture.chapters[1]}),
    );
    let drift = command(
        &fixture,
        json!({"action":"createDrift","title":"第一幕笔记"}),
    )["result"]
        .clone();
    let body = command(
        &fixture,
        json!({"action":"openDrift","driftId":drift["id"]}),
    )["handle"]
        .as_u64()
        .unwrap();
    let current = state(body);
    success(
        json!({"operation":"documentReplace","handle":body,"edit":{"revision":current["projection"]["revision"],
        "range":{"location":0,"length":0},"text":"幕前提要"}}),
    );
    let mut export = Export::start(
        "drift-act-binding-trash-restore-and-failures",
        &fixture,
        &db,
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
            assert!(refused(&fixture, request.clone()).contains("synthetic drift receipt fault"));
            unchanged(&db, &before);
            execute(&db, "DROP TRIGGER fail_drift_receipt");
        }
        let reply = command(&fixture, request);
        assert_eq!(originals(&db, since), expected, "{operation}");
        since = last_rowid(&db);
        if let Some(export) = export {
            export.step(&fixture, &db, operation, &reply, fault);
        }
        reply
    };
    let bound = step(
        "bindAct",
        json!({"action":"bindAct","actId":act["id"],"driftId":drift["id"]}),
        vec![vec!["field.set book-act"]],
        true,
        &mut export,
    );
    assert_eq!(bound["library"]["drifts"][0]["actId"], act["id"]);
    // Trash retires the open body and unbinds the act in its own original first.
    let trashed = step(
        "trashDrift",
        json!({"action":"trashDrift","driftId":drift["id"]}),
        vec![vec!["field.set book-act"], vec!["entity.trash node"]],
        true,
        &mut export,
    );
    assert!(!rejected(json!({"operation":"documentRead","handle":body})).is_empty());
    assert_eq!(trashed["library"]["trashedDrifts"][0]["id"], drift["id"]);
    let restored = step(
        "restoreDrift",
        json!({"action":"restoreDrift","driftId":drift["id"]}),
        vec![vec![
            "entity.restore node",
            "tuple.set node",
            "yjs.update prose-document",
        ]],
        true,
        &mut export,
    );
    assert_eq!(restored["result"]["actId"], Value::Null);
    let reopened = command(
        &fixture,
        json!({"action":"openDrift","driftId":drift["id"]}),
    );
    assert_eq!(reopened["document"]["projection"]["text"], "幕前提要");
    let before = rows(&db);
    for request in [
        json!({"action":"bindAct","actId":"missing","driftId":drift["id"]}),
        json!({"action":"bindAct","actId":act["id"],"driftId":fixture.chapters[0]}),
        json!({"action":"createDrift","groupId":"missing"}),
        json!({"action":"restoreDrift","driftId":drift["id"]}),
        json!({"action":"renameGroup","groupId":"missing","name":"x"}),
        json!({"action":"createDrift","unknown":1}),
    ] {
        assert!(!refused(&fixture, request).is_empty());
    }
    unchanged(&db, &before);
    fixture.close();
}
