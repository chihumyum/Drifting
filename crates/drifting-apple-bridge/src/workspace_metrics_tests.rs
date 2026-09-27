//! Word counts and body projections of chapters and drifts through the C ABI.
//! Optional SQLite exports feed the TypeScript projection oracle.
use super::*;

const FILE: &str = "apple-native-workspace.db";

fn query(db: &DatabaseGateway, sql: &str) -> Vec<Vec<DatabaseValue>> {
    db.query(sql.into(), vec![], None, CLIENT.into())
        .unwrap()
        .rows
}
fn metrics(fixture: &Fixture, action: &str) -> Value {
    success(
        json!({"operation":"workspaceMetrics","handle":fixture.workspace,"projectId":fixture.project,
        "command":{"action":action}}),
    )
}
fn count(reply: &Value, node: &str) -> Value {
    reply["counts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["nodeId"] == node)
        .map(|row| row["wordCount"].clone())
        .unwrap_or(Value::Null)
}
fn node_row(db: &DatabaseGateway, node: &str) -> Vec<DatabaseValue> {
    query(db, &format!("SELECT n.word_count,n.word_count_basis_kind,n.word_count_basis_revision,n.updated_at,c.content_json,c.outline_json FROM book_node n JOIN node_content c ON c.node_id=n.id WHERE n.id='{node}'")).remove(0)
}
fn edit(handle: u64, text: &str) {
    let current = state(handle);
    success(
        json!({"operation":"documentReplace","handle":handle,"edit":{
        "revision":current["projection"]["revision"],"range":{"location":0,"length":0},"text":text}}),
    );
}
fn format(handle: u64, action: &str, location: usize, length: usize) {
    let current = state(handle);
    success(json!({"operation":"documentFormat","handle":handle,"edit":{
        "revision":current["projection"]["revision"],"range":{"location":location,"length":length},"action":action}}));
}
fn units(text: &str) -> usize {
    text.encode_utf16().count()
}
fn export(fixture: &Fixture, db: &DatabaseGateway, name: &str, nodes: &[&str]) {
    let Ok(directory) = std::env::var("NATIVE_WORKSPACE_METRICS_EXPORT_DIR") else {
        return;
    };
    let directory = PathBuf::from(directory);
    std::fs::create_dir_all(&directory).unwrap();
    assert_eq!(
        serde_json::to_value(db.checkpoint(CLIENT.into()).unwrap()).unwrap()["busy"],
        0
    );
    std::fs::copy(
        fixture.directory.join(FILE),
        directory.join(format!("{name}.db")),
    )
    .unwrap();
    std::fs::write(
        directory.join(format!("{name}.json")),
        serde_json::to_vec_pretty(
            &json!({"database":format!("{name}.db"),"projectId":fixture.project,"nodes":nodes}),
        )
        .unwrap(),
    )
    .unwrap();
}

#[test]
fn workspace_metrics_follow_saves_reconcile_and_cold_reopen() {
    let mut fixture = Fixture::new();
    let first = fixture.open(0)["handle"].as_u64().unwrap();
    let db = gateway(first);
    let chapter = fixture.chapters[0].clone();
    let other = fixture.chapters[1].clone();
    let untouched = node_row(&db, &other);
    let heading = "第一章 Start";
    let body = "他说 hello, world！钟楼🙂";
    edit(first, &format!("{heading}\n{body}\n结尾 end"));
    format(first, "heading1", 0, units(heading));
    let at = units(heading) + 1 + units("他说 ");
    format(first, "bold", at, units("hello"));
    format(first, "italic", at + units("hello, "), units("world"));
    let journal = query(&db, "SELECT count(*) FROM sync_change_set");
    success(json!({"operation":"documentSave","handle":first}));
    // A save materializes the projection and stamps the node, never a journal row.
    assert_eq!(query(&db, "SELECT count(*) FROM sync_change_set"), journal);
    let saved = node_row(&db, &chapter);
    assert_eq!(saved[0], DatabaseValue::Integer("13".into()));
    assert_eq!(saved[1], DatabaseValue::Text("yjs".into()));
    let DatabaseValue::Text(outline) = &saved[5] else {
        panic!("outline")
    };
    let outline: Value = serde_json::from_str(outline).unwrap();
    assert_eq!(
        (
            outline[0]["text"].as_str(),
            outline[0]["level"].as_u64(),
            outline[0]["paragraphsAfter"].as_u64()
        ),
        (Some(heading), Some(1), Some(2))
    );
    let DatabaseValue::Text(content) = &saved[4] else {
        panic!("content")
    };
    let content: Value = serde_json::from_str(content).unwrap();
    assert_eq!(content["content"][0]["type"], "heading");
    assert_eq!(
        content["content"][1]["content"][1]["marks"][0]["type"],
        "bold"
    );
    assert_eq!(count(&metrics(&fixture, "counts"), &chapter), 13);
    // An unchanged save keeps the stored projection and its stamp.
    success(json!({"operation":"documentSave","handle":first}));
    assert_eq!(node_row(&db, &chapter), saved);
    // A drift body counts on its own.
    let drift = success(
        json!({"operation":"workspaceDrifts","handle":fixture.workspace,"projectId":fixture.project,
        "command":{"action":"createDrift","title":"灵感"}}),
    )["result"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let owner = success(
        json!({"operation":"workspaceDrifts","handle":fixture.workspace,"projectId":fixture.project,
        "command":{"action":"openDrift","driftId":drift}}),
    )["handle"]
        .as_u64()
        .unwrap();
    edit(owner, "雨夜 bells ring");
    success(json!({"operation":"documentSave","handle":owner}));
    export(
        &fixture,
        &db,
        "metrics-after-saves",
        &[&chapter, &other, &drift],
    );
    // Reconciliation covers every live node without restamping it.
    let reconciled = metrics(&fixture, "reconcile");
    assert_eq!(reconciled["failures"], json!([]));
    assert_eq!(
        (
            count(&reconciled, &chapter),
            count(&reconciled, &drift),
            count(&reconciled, &other)
        ),
        (json!(13), json!(4), json!(0))
    );
    assert_eq!(
        node_row(&db, &other)[3],
        untouched[3],
        "reconcile keeps updated_at"
    );
    assert_eq!(node_row(&db, &chapter), saved);
    export(
        &fixture,
        &db,
        "metrics-after-reconcile",
        &[&chapter, &other, &drift],
    );
    fixture.close();
    fixture.workspace = success(json!({"operation":"workspaceOpen","directory":fixture.directory}))
        ["handle"]
        .as_u64()
        .unwrap();
    let cold = metrics(&fixture, "counts");
    assert_eq!(
        (count(&cold, &chapter), count(&cold, &drift)),
        (json!(13), json!(4))
    );
    assert!(rejected(json!({"operation":"workspaceMetrics","handle":fixture.workspace,"projectId":fixture.project,
        "command":{"action":"recount"}})).contains("unknown variant"));
    fixture.close();
}
