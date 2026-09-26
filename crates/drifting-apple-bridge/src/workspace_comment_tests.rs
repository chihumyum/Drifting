//! Actual chapter comment commands through the C ABI. Optional SQLite exports
//! feed the production TypeScript reducer; tests always run without it.
use super::*;
use std::collections::BTreeMap;

const FILE: &str = "apple-native-workspace.db";
const FAULT: &str = "CREATE TRIGGER fail_comment_receipt BEFORE INSERT ON sync_apply_receipt BEGIN SELECT RAISE(ABORT, 'synthetic comment receipt fault'); END";

fn query(db: &DatabaseGateway, sql: &str) -> Vec<Vec<DatabaseValue>> {
    db.query(sql.into(), vec![], None, CLIENT.into())
        .unwrap()
        .rows
}
fn rows(db: &DatabaseGateway) -> BTreeMap<String, Vec<Vec<DatabaseValue>>> {
    [
        "comment",
        "comment_action",
        "book_node",
        "node_content",
        "sync_change_set",
        "sync_mutation",
        "sync_apply_receipt",
        "sync_generation_writer_state",
        "sync_entity_lifecycle",
        "sync_field_clock",
        "yjs_updates",
        "yjs_snapshots",
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
fn mutations(db: &DatabaseGateway) -> Vec<(String, String)> {
    query(db, "SELECT m.action,m.target_kind FROM sync_mutation m JOIN sync_change_set c USING(change_set_id) WHERE c.rowid=(SELECT MAX(rowid) FROM sync_change_set) ORDER BY m.mutation_index")
        .into_iter()
        .map(|row| match row.as_slice() {
            [DatabaseValue::Text(action), DatabaseValue::Text(kind)] => (action.clone(), kind.clone()),
            _ => panic!("mutation row"),
        })
        .collect()
}
struct Export {
    directory: PathBuf,
    name: &'static str,
    fixture: Value,
}
impl Export {
    fn start(name: &'static str, fixture: &Fixture, db: &DatabaseGateway) -> Option<Self> {
        let directory = PathBuf::from(std::env::var("NATIVE_WORKSPACE_COMMENT_EXPORT_DIR").ok()?);
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
        comment: &Value,
        fault: bool,
    ) {
        let index = self.fixture["steps"].as_array().unwrap().len();
        let file = format!("{}-after-{index}.db", self.name);
        Self::copy(fixture, db, &self.directory.join(&file));
        let mut step = latest(db);
        step["afterDatabase"] = json!(file);
        step["operation"] = json!(operation);
        step["comment"] = comment.clone();
        step["faultBeforeApply"] = json!(fault);
        self.fixture["steps"].as_array_mut().unwrap().push(step);
        std::fs::write(
            self.directory.join(format!("{}.json", self.name)),
            serde_json::to_vec_pretty(&self.fixture).unwrap(),
        )
        .unwrap();
    }
}
fn replace(handle: u64, location: u64, length: u64, text: &str) -> Value {
    let current = state(handle);
    success(
        json!({"operation":"documentReplace","handle":handle,"edit":{
        "revision":current["projection"]["revision"],
        "range":{"location":location,"length":length},"text":text}}),
    )
}
fn create_request(handle: u64, location: u64, length: u64, body: &str) -> Value {
    json!({"operation":"documentCreateComment","handle":handle,
        "revision":state(handle)["projection"]["revision"],
        "range":{"location":location,"length":length},"body":body})
}
fn comments(handle: u64) -> Value {
    success(json!({"operation":"documentComments","handle":handle}))["comments"].clone()
}
fn anchor(handle: u64, id: &Value) -> (String, Option<(u64, u64)>) {
    let state = state(handle);
    let view = state["projection"]["comments"]
        .as_array()
        .unwrap()
        .iter()
        .find(|comment| &comment["id"] == id)
        .unwrap()
        .clone();
    let range = view["ranges"].get(0).map(|range| {
        (
            range["location"].as_u64().unwrap(),
            range["length"].as_u64().unwrap(),
        )
    });
    (view["status"].as_str().unwrap().into(), range)
}
/// Two paragraphs: "雨夜🙂来信" (7 UTF-16 units) and "海岸线".
fn prose(handle: u64) {
    replace(handle, 0, 0, "雨夜🙂来信\n海岸线");
    assert_eq!(
        state(handle)["projection"]["blocks"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn workspace_comment_create_highlights_and_cold_reopen() {
    let mut fixture = Fixture::new();
    let owner = fixture.open(0)["handle"].as_u64().unwrap();
    prose(owner);
    let other = fixture.open(1)["handle"].as_u64().unwrap();
    replace(other, 0, 0, "另一章");
    let db = gateway(owner);
    let mut export = Export::start("comment-create-highlights-and-cold-reopen", &fixture, &db);
    let before_text = state(owner)["projection"]["text"].clone();
    // "🙂来信\n海" spans both paragraphs.
    let created = success(create_request(owner, 2, 6, "核对：🙂\n\n第二段"));
    let comment = created["comment"].clone();
    assert_eq!(comment["status"], "open");
    assert_eq!(
        (
            comment["kind"].as_str(),
            comment["source"].as_str(),
            comment["authorKind"].as_str()
        ),
        (Some("note"), Some("manual"), Some("user"))
    );
    assert_eq!(comment["targetId"], json!(fixture.chapters[0]));
    let payload: Value = serde_json::from_str(comment["anchorJson"].as_str().unwrap()).unwrap();
    assert_eq!(payload["selectedText"], "🙂来信\n海");
    assert!(payload["nativeAnchorV1"].is_object());
    assert_eq!(
        serde_json::from_str::<Value>(comment["targetBlockIdsJson"].as_str().unwrap())
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        mutations(&db),
        [("entity.create".to_string(), "comment".to_string())]
    );
    assert_eq!(created["state"]["projection"]["text"], before_text);
    assert_eq!(
        anchor(owner, &comment["id"]),
        ("anchored".into(), Some((2, 6)))
    );
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "create", &comment, false);
    }
    assert_eq!(comments(owner), json!([comment]));
    assert_eq!(comments(other), json!([]));
    // A same-chapter view shares the owner and its highlights.
    assert_eq!(fixture.open(0)["handle"], owner);
    fixture.close();
    fixture.workspace = success(json!({"operation":"workspaceOpen","directory":fixture.directory}))
        ["handle"]
        .as_u64()
        .unwrap();
    let owner = fixture.open(0)["handle"].as_u64().unwrap();
    assert_eq!(
        anchor(owner, &comment["id"]),
        ("anchored".into(), Some((2, 6)))
    );
    assert_eq!(comments(owner)[0]["bodyJson"], comment["bodyJson"]);
    fixture.close();
}

#[test]
fn workspace_comment_anchor_follows_edits_history_and_removal() {
    let fixture = Fixture::new();
    let owner = fixture.open(0)["handle"].as_u64().unwrap();
    prose(owner);
    let db = gateway(owner);
    let comment = success(create_request(owner, 2, 6, "锚点"))["comment"].clone();
    let id = comment["id"].clone();
    replace(owner, 0, 0, "序");
    assert_eq!(anchor(owner, &id), ("anchored".into(), Some((3, 6))));
    // The checkpoint moved the stored anchor, not the body or status.
    let stored = comments(owner)[0].clone();
    let payload: Value = serde_json::from_str(stored["anchorJson"].as_str().unwrap()).unwrap();
    assert_eq!(payload["textAnchor"]["startOffset"], 3);
    assert_eq!(
        (stored["bodyJson"].clone(), stored["status"].clone()),
        (comment["bodyJson"].clone(), comment["status"].clone())
    );
    success(json!({"operation":"documentUndo","handle":owner}));
    assert_eq!(anchor(owner, &id), ("anchored".into(), Some((2, 6))));
    success(json!({"operation":"documentRedo","handle":owner}));
    assert_eq!(anchor(owner, &id), ("anchored".into(), Some((3, 6))));
    // Remove the passage, then type equal text elsewhere: never re-attach.
    replace(owner, 3, 6, "");
    replace(owner, 0, 0, "🙂来信\n海");
    assert_ne!(anchor(owner, &id).0, "anchored");
    let changes = query(&db, "SELECT COUNT(*) FROM sync_change_set");
    success(json!({"operation":"documentUndo","handle":owner}));
    success(json!({"operation":"documentUndo","handle":owner}));
    assert_eq!(anchor(owner, &id), ("anchored".into(), Some((3, 6))));
    // Anchor movement is local owner state, never another comment original.
    assert_eq!(query(&db, "SELECT COUNT(*) FROM sync_change_set WHERE change_set_id IN (SELECT change_set_id FROM sync_mutation WHERE target_kind='comment')"), vec![vec![DatabaseValue::Integer("1".into())]]);
    assert_ne!(query(&db, "SELECT COUNT(*) FROM sync_change_set"), changes);
    let owner = fixture.reopen(0)["handle"].as_u64().unwrap();
    assert_eq!(anchor(owner, &id), ("anchored".into(), Some((3, 6))));
    fixture.close();
}

#[test]
fn workspace_comment_body_and_status_keep_anchor_and_history() {
    let mut fixture = Fixture::new();
    let owner = fixture.open(0)["handle"].as_u64().unwrap();
    prose(owner);
    let db = gateway(owner);
    let comment = success(create_request(owner, 0, 2, "原批注"))["comment"].clone();
    let id = comment["id"].as_str().unwrap().to_owned();
    let document = state(owner);
    let mut export = Export::start(
        "comment-body-and-status-keep-anchor-and-history",
        &fixture,
        &db,
    );
    let edited = success(json!({"operation":"documentUpdateCommentBody","handle":owner,"commentId":id,"body":"改后的批注🙂"}))["comment"].clone();
    assert_eq!(edited["anchorJson"], comment["anchorJson"]);
    assert_ne!(edited["bodyJson"], comment["bodyJson"]);
    assert_eq!(
        mutations(&db),
        [("field.set".to_string(), "comment".to_string())]
    );
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "body", &edited, false);
    }
    let resolved = success(json!({"operation":"documentSetCommentResolved","handle":owner,"commentId":id,"resolved":true}))["comment"].clone();
    assert_eq!(resolved["status"], "resolved");
    assert!(resolved["resolvedAt"].is_string());
    assert_eq!(mutations(&db).len(), 2);
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "resolve", &resolved, false);
    }
    let reopened = success(json!({"operation":"documentSetCommentResolved","handle":owner,"commentId":id,"resolved":false}))["comment"].clone();
    assert_eq!(
        (
            reopened["status"].as_str(),
            reopened["resolvedAt"].is_null()
        ),
        (Some("open"), true)
    );
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "reopen", &reopened, false);
    }
    let after = state(owner);
    assert_eq!(after["projection"]["text"], document["projection"]["text"]);
    assert_eq!(
        after["projection"]["comments"],
        document["projection"]["comments"]
    );
    assert_eq!(
        after["projection"]["canUndo"],
        document["projection"]["canUndo"]
    );
    assert_eq!(
        success(json!({"operation":"documentUndo","handle":owner}))["projection"]["text"],
        ""
    );
    fixture.close();
    fixture.workspace = success(json!({"operation":"workspaceOpen","directory":fixture.directory}))
        ["handle"]
        .as_u64()
        .unwrap();
    let owner = fixture.open(0)["handle"].as_u64().unwrap();
    let listed = comments(owner)[0].clone();
    assert_eq!(
        (listed["bodyJson"].clone(), listed["status"].clone()),
        (edited["bodyJson"].clone(), json!("open"))
    );
    fixture.close();
}

#[test]
fn workspace_comment_failures_leave_owner_unchanged_and_retry() {
    let fixture = Fixture::new();
    let owner = fixture.open(0)["handle"].as_u64().unwrap();
    prose(owner);
    let db = gateway(owner);
    let mut export = Export::start(
        "comment-failures-leave-owner-unchanged-and-retry",
        &fixture,
        &db,
    );
    let before = rows(&db);
    let document = state(owner);
    let mut stale = create_request(owner, 0, 2, "过期");
    stale["revision"] = json!(document["projection"]["revision"].as_u64().unwrap() + 1);
    assert!(rejected(stale).contains("changed"));
    assert!(!rejected(create_request(owner, 6, 1, "只有换行")).is_empty());
    assert!(!rejected(create_request(owner, 0, 2, " \n ")).is_empty());
    success(
        json!({"operation":"documentBeginDraft","handle":owner,"start":{
        "key":"composition","revision":document["projection"]["revision"],"range":{"location":0,"length":0}}}),
    );
    assert!(!rejected(create_request(owner, 0, 2, "输入中")).is_empty());
    success(json!({"operation":"documentCancelDraft","handle":owner,"key":"composition"}));
    execute(&db, FAULT);
    assert!(
        rejected(create_request(owner, 0, 2, "重试")).contains("synthetic comment receipt fault")
    );
    unchanged(&db, &before);
    assert_eq!(state(owner)["projection"]["comments"], json!([]));
    execute(&db, "DROP TRIGGER fail_comment_receipt");
    // The failed attempt left the owner's CAS baseline usable.
    replace(owner, 0, 0, "序");
    let comment = success(create_request(owner, 1, 2, "重试"))["comment"].clone();
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "create", &comment, true);
    }
    let id = comment["id"].clone();
    // Opening a chapter checkpoints it; do so before capturing the baseline.
    let other = fixture.open(1)["handle"].as_u64().unwrap();
    let created = rows(&db);
    for request in [
        json!({"operation":"documentUpdateCommentBody","handle":owner,"commentId":id,"body":"失败后才改"}),
        json!({"operation":"documentSetCommentResolved","handle":owner,"commentId":id,"resolved":true}),
    ] {
        execute(&db, FAULT);
        assert!(rejected(request.clone()).contains("synthetic comment receipt fault"));
        unchanged(&db, &created);
        execute(&db, "DROP TRIGGER fail_comment_receipt");
    }
    assert!(!rejected(json!({"operation":"documentUpdateCommentBody","handle":owner,"commentId":"missing-comment","body":"x"})).is_empty());
    assert!(rejected(json!({"operation":"documentSetCommentResolved","handle":other,"commentId":id,"resolved":true})).contains("not on this chapter"));
    unchanged(&db, &created);
    let edited = success(json!({"operation":"documentUpdateCommentBody","handle":owner,"commentId":id,"body":"失败后才改"}))["comment"].clone();
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "body", &edited, true);
    }
    let resolved = success(json!({"operation":"documentSetCommentResolved","handle":owner,"commentId":id,"resolved":true}))["comment"].clone();
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "resolve", &resolved, true);
    }
    assert_eq!(anchor(owner, &id), ("anchored".into(), Some((1, 2))));
    fixture.close();
}
