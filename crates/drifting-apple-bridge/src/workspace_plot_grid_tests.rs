//! The plot planner and drift conversions through the C ABI.
use super::*;

fn op(fixture: &Fixture, operation: &str, command: Value) -> Value {
    success(json!({"operation":operation,"handle":fixture.workspace,
        "projectId":fixture.project,"command":command}))
}
fn grid(fixture: &Fixture, node: &str, ops: Value) -> Value {
    json!({"operation":"workspacePlotGrid","handle":fixture.workspace,
        "projectId":fixture.project,"nodeId":node,"ops":ops})
}
fn changes(db: &DatabaseGateway) -> u64 {
    match &db
        .query(
            "SELECT COUNT(*) FROM sync_change_set".into(),
            vec![],
            None,
            CLIENT.into(),
        )
        .unwrap()
        .rows[0][0]
    {
        DatabaseValue::Integer(value) => value.parse().unwrap(),
        _ => panic!("count"),
    }
}
fn type_text(handle: u64, text: &str) {
    let current = state(handle);
    success(
        json!({"operation":"documentReplace","handle":handle,"edit":{
        "revision":current["projection"]["revision"],"range":{"location":0,"length":0},"text":text}}),
    );
}

#[test]
fn workspace_plot_grid_reads_batches_and_survives_reopen() {
    let mut fixture = Fixture::new();
    let chapter = fixture.chapters[0].clone();
    let db = gateway(fixture.open(0)["handle"].as_u64().unwrap());
    assert_eq!(
        success(grid(&fixture, &chapter, json!([])))["grid"],
        Value::Null
    );
    let before = changes(&db);
    let written = success(grid(
        &fixture,
        &chapter,
        json!([{"op":"addRow","label":"人物"},{"op":"addRow","id":"r2","label":"地点"},
            {"op":"addColumn","id":"c1","label":"开场"},{"op":"setCell","rowId":"r2","columnId":"c1","value":"北塔"}]),
    ));
    assert_eq!(changes(&db), before + 1);
    let generated = written["created"][0].as_str().unwrap().to_string();
    assert_eq!(
        written["grid"]["rows"],
        json!([{"id":"r2","label":"地点"},{"id":generated,"label":"人物"}])
    );
    let moved = success(grid(
        &fixture,
        &chapter,
        json!([{"op":"moveRow","rowId":generated}]),
    ));
    assert_eq!(moved["grid"]["rows"][0]["id"], json!(generated));
    rejected(grid(
        &fixture,
        &chapter,
        json!([{"op":"setSize","width":10,"height":96}]),
    ));
    rejected(grid(&fixture, &chapter, json!([{"op":"explode"}])));
    // A drift has a planner too.
    let drift = op(
        &fixture,
        "workspaceDrifts",
        json!({"action":"createDrift","title":"梦"}),
    )["result"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    success(grid(
        &fixture,
        &drift,
        json!([{"op":"addColumn","id":"d1","label":"线索"}]),
    ));
    fixture.close();
    fixture.workspace = success(json!({"operation":"workspaceOpen","directory":fixture.directory}))
        ["handle"]
        .as_u64()
        .unwrap();
    let cold = success(grid(&fixture, &chapter, json!([])))["grid"].clone();
    assert_eq!(
        cold["cells"],
        json!([{"rowId":"r2","columnId":"c1","value":"北塔"}])
    );
    assert_eq!(cold["rows"][0]["id"], json!(generated));
    fixture.close();
}

#[test]
fn workspace_drift_converts_to_chapter_and_element() {
    let fixture = Fixture::new();
    let db = gateway(fixture.open(0)["handle"].as_u64().unwrap());
    let storyline = op(
        &fixture,
        "workspaceStorylines",
        json!({"action":"createStoryline","name":"主线"}),
    )["result"]["id"]
        .clone();
    let letter = op(
        &fixture,
        "workspaceDrifts",
        json!({"action":"createDrift","title":"旧信"}),
    )["result"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let body = op(
        &fixture,
        "workspaceDrifts",
        json!({"action":"openDrift","driftId":letter}),
    )["handle"]
        .as_u64()
        .unwrap();
    type_text(body, "信里提到北塔。");
    let marker = success(json!({"operation":"workspaceTimeline","handle":fixture.workspace,
        "projectId":fixture.project,"command":{"action":"createMarker","narrativeOrder":2,"label":"","driftId":letter}}))
        ["result"]["id"]
        .clone();
    let before = changes(&db);
    let chapter = op(
        &fixture,
        "workspaceDrifts",
        json!({"action":"convertToChapter","driftId":letter,"storylineId":storyline}),
    )["result"]
        .clone();
    assert_eq!(
        changes(&db),
        before + 1,
        "one conversion original (typing was saved as it happened)"
    );
    assert_eq!(
        (&chapter["title"], &chapter["writingStatus"]),
        (&json!("旧信"), &json!("draft"))
    );
    let chapters = success(
        json!({"operation":"workspaceChapters","handle":fixture.workspace,"projectId":fixture.project}),
    );
    let list = chapters["chapters"]
        .as_array()
        .or(chapters.as_array())
        .unwrap()
        .clone();
    assert_eq!(
        list.last().unwrap()["id"],
        json!(letter),
        "appended at the end of the book"
    );
    let drifts = op(&fixture, "workspaceDrifts", json!({"action":"library"}));
    assert!(
        !drifts.to_string().contains(&format!("\"id\":\"{letter}\""))
            || drifts["library"]["drifts"]
                .as_array()
                .unwrap()
                .iter()
                .all(|d| d["id"] != json!(letter))
    );
    let timeline = success(
        json!({"operation":"workspaceTimeline","handle":fixture.workspace,
        "projectId":fixture.project,"command":{"action":"timeline"}}),
    )["timeline"]
        .clone();
    let released = timeline["markers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == marker)
        .unwrap()
        .clone();
    assert_eq!(
        (&released["driftId"], &released["label"]),
        (&Value::Null, &json!("旧信"))
    );
    let opened = success(
        json!({"operation":"workspaceOpenChapter","handle":fixture.workspace,
        "projectId":fixture.project,"chapterId":letter}),
    );
    assert_eq!(opened["document"]["projection"]["text"], "信里提到北塔。");
    // A title a chapter already uses is numbered.
    let twin = op(
        &fixture,
        "workspaceDrifts",
        json!({"action":"createDrift","title":"初航"}),
    )["result"]["id"]
        .clone();
    let numbered = op(
        &fixture,
        "workspaceDrifts",
        json!({"action":"convertToChapter","driftId":twin}),
    )["result"]
        .clone();
    assert_ne!(numbered["title"], "初航");
    // To an element: title, summary and body move; the drift goes to the trash.
    let category = op(
        &fixture,
        "workspaceElements",
        json!({"action":"createCategory","name":"地点"}),
    )["result"]["id"]
        .clone();
    let lighthouse = op(
        &fixture,
        "workspaceDrifts",
        json!({"action":"createDrift","title":"灯塔"}),
    )["result"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    success(
        json!({"operation":"workspaceMetadata","handle":fixture.workspace,"projectId":fixture.project,
        "command":{"action":"setNodeSummary","nodeId":lighthouse,"summary":"海边的灯塔"}}),
    );
    let lighthouse_body = op(
        &fixture,
        "workspaceDrifts",
        json!({"action":"openDrift","driftId":lighthouse}),
    )["handle"]
        .as_u64()
        .unwrap();
    type_text(lighthouse_body, "灯塔在北岸。");
    let converted = op(
        &fixture,
        "workspaceDrifts",
        json!({"action":"convertToElement","driftId":lighthouse,"categoryId":category}),
    )["result"]
        .clone();
    let element = converted["element"].clone();
    assert_eq!(
        (&element["name"], &element["summary"]),
        (&json!("灯塔"), &json!("海边的灯塔"))
    );
    let read = success(
        json!({"operation":"workspaceAgent","handle":fixture.workspace,"projectId":fixture.project,
        "command":{"action":"readProse","target":{"kind":"element","id":element["id"]}}}),
    );
    assert_eq!(read["text"], "灯塔在北岸。");
    let trashed = op(&fixture, "workspaceDrifts", json!({"action":"library"}));
    assert!(trashed["library"]["trashedDrifts"]
        .as_array()
        .unwrap()
        .iter()
        .any(|d| d["id"] == json!(lighthouse)));
    // An element name already in use refuses before anything is written.
    let clash = op(
        &fixture,
        "workspaceDrifts",
        json!({"action":"createDrift","title":"灯塔"}),
    )["result"]["id"]
        .clone();
    let before = changes(&db);
    rejected(
        json!({"operation":"workspaceDrifts","handle":fixture.workspace,"projectId":fixture.project,
        "command":{"action":"convertToElement","driftId":clash,"categoryId":category}}),
    );
    assert_eq!(changes(&db), before);
    fixture.close();
}
