//! The story timeline through the C ABI.
use super::*;

fn timeline(fixture: &Fixture, command: Value) -> Value {
    json!({"operation":"workspaceTimeline","handle":fixture.workspace,"projectId":fixture.project,"command":command})
}

#[test]
fn workspace_timeline_orders_markers_positions_and_cold_reopen() {
    let mut fixture = Fixture::new();
    let chapter = fixture.chapters[0].clone();
    let placed = success(timeline(
        &fixture,
        json!({"action":"setNarrativeOrder","chapterId":chapter,"order":2.25}),
    ));
    assert_eq!(placed["result"]["narrativeOrder"], 2.25);
    let drift = success(
        json!({"operation":"workspaceDrifts","handle":fixture.workspace,"projectId":fixture.project,
        "command":{"action":"createDrift","title":"钟声"}}),
    )["result"]["id"]
        .clone();
    success(timeline(
        &fixture,
        json!({"action":"setPosition","nodeId":drift,"x":40,"y":-12.5}),
    ));
    let marker = success(timeline(
        &fixture,
        json!({"action":"createMarker","narrativeOrder":1,"label":"黎明"}),
    ))["result"]["id"]
        .clone();
    success(timeline(
        &fixture,
        json!({"action":"createMarker","narrativeOrder":3,"label":"","driftId":drift}),
    ));
    success(timeline(
        &fixture,
        json!({"action":"updateMarker","markerId":marker,"label":"拂晓","narrativeOrder":0.5}),
    ));
    assert!(rejected(timeline(
        &fixture,
        json!({"action":"createMarker","narrativeOrder":1,"label":" "})
    ))
    .contains("名称"));
    assert!(rejected(timeline(
        &fixture,
        json!({"action":"setNarrativeOrder","chapterId":drift,"order":1})
    ))
    .contains("章节"));
    // A graph drop moves the order and the lane in one original.
    let storyline = success(json!({"operation":"workspaceStorylines","handle":fixture.workspace,"projectId":fixture.project,
        "command":{"action":"createStoryline","name":"支线"}}))["result"]["id"].clone();
    let moved = success(timeline(
        &fixture,
        json!({"action":"moveChapter","chapterId":chapter,"order":4.5,"lane":storyline}),
    ));
    assert_eq!(moved["result"]["narrativeOrder"], 4.5);
    // A lane change returns the storyline library; an order-only move does not.
    let membership = moved["storylines"]["memberships"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["chapterId"] == json!(chapter))
        .unwrap()
        .clone();
    assert_eq!(membership["primary"], storyline);
    let order_only = success(timeline(
        &fixture,
        json!({"action":"moveChapter","chapterId":chapter,"order":4.75}),
    ));
    assert!(order_only.get("storylines").is_none());
    // A reading-order drop moves the book position with the lane in one
    // original; a refused destination leaves both unchanged.
    let changes = |fixture: &Fixture| {
        gateway(fixture.open(0)["handle"].as_u64().unwrap())
            .query(
                "SELECT COUNT(*) FROM sync_change_set".into(),
                vec![],
                None,
                CLIENT.into(),
            )
            .unwrap()
            .rows
    };
    let before = changes(&fixture);
    let first = fixture.chapters[0].clone();
    rejected(timeline(
        &fixture,
        json!({"action":"moveChapter","chapterId":chapter,"lane":null,"bookBefore":"missing"}),
    ));
    assert_eq!(changes(&fixture), before);
    let second = fixture.chapters[1].clone();
    let lane_and_book = success(timeline(
        &fixture,
        json!({"action":"moveChapter","chapterId":second,"lane":null,"bookBefore":first}),
    ));
    let membership = lane_and_book["storylines"]["memberships"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["chapterId"] == json!(second))
        .unwrap()
        .clone();
    assert_eq!(membership["storylineIds"], json!([]));
    let db = gateway(fixture.open(0)["handle"].as_u64().unwrap());
    let actions: Vec<String> = db
        .query(
            "SELECT action FROM sync_mutation WHERE change_set_id=(SELECT change_set_id FROM sync_change_set ORDER BY rowid DESC LIMIT 1) ORDER BY mutation_index".into(),
            vec![],
            None,
            CLIENT.into(),
        )
        .unwrap()
        .rows
        .iter()
        .map(|row| match &row[0] {
            DatabaseValue::Text(value) => value.clone(),
            _ => panic!("action"),
        })
        .collect();
    assert!(actions.iter().any(|a| a == "set.remove"), "{actions:?}");
    assert!(actions.iter().any(|a| a == "field.set"), "{actions:?}");
    let chapters = success(
        json!({"operation":"workspaceChapters","handle":fixture.workspace,
        "projectId":fixture.project}),
    );
    let list = chapters["chapters"]
        .as_array()
        .or(chapters.as_array())
        .unwrap();
    assert_eq!(list[0]["id"], json!(second));
    let count = |rows: &Vec<Vec<DatabaseValue>>| match &rows[0][0] {
        DatabaseValue::Integer(value) => value.parse::<u64>().unwrap(),
        _ => panic!("count"),
    };
    assert_eq!(count(&changes(&fixture)), count(&before) + 1);
    let nodes = success(json!({"operation":"workspaceMetadata","handle":fixture.workspace,"projectId":fixture.project,
        "command":{"action":"nodes"}}))["result"].clone();
    assert!(nodes
        .as_array()
        .unwrap()
        .iter()
        .any(|n| n["id"] == json!(chapter) && n["kind"] == "chapter"));
    success(timeline(
        &fixture,
        json!({"action":"moveChapter","chapterId":chapter,"order":2.25,"lane":null}),
    ));
    fixture.close();
    fixture.workspace = success(json!({"operation":"workspaceOpen","directory":fixture.directory}))
        ["handle"]
        .as_u64()
        .unwrap();
    let cold = success(timeline(&fixture, json!({"action":"timeline"})))["timeline"].clone();
    let markers: Vec<(String, f64)> = cold["markers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| {
            (
                m["label"].as_str().unwrap().to_string(),
                m["narrativeOrder"].as_f64().unwrap(),
            )
        })
        .collect();
    assert_eq!(markers, vec![("拂晓".into(), 0.5), (String::new(), 3.0)]);
    let node = |id: &Value| {
        cold["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["id"] == *id)
            .unwrap()
            .clone()
    };
    assert_eq!(node(&json!(chapter))["narrativeOrder"], 2.25);
    assert_eq!(
        (
            node(&drift)["positionX"].as_f64(),
            node(&drift)["positionY"].as_f64()
        ),
        (Some(40.0), Some(-12.5))
    );
    let unbound = success(timeline(
        &fixture,
        json!({"action":"updateMarker","markerId":cold["markers"][1]["id"],
        "label":"钟响","driftId":null}),
    ));
    assert_eq!(unbound["result"]["driftNodeId"], Value::Null);
    success(timeline(
        &fixture,
        json!({"action":"deleteMarker","markerId":marker}),
    ));
    assert_eq!(
        success(timeline(&fixture, json!({"action":"timeline"})))["timeline"]["markers"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    fixture.close();
}
