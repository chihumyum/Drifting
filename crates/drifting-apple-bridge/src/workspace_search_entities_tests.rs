//! Searching beyond chapters: summaries, names, aliases, facts, materials and
//! the bodies of drifts, elements, categories and storylines.
use super::*;

fn op(fixture: &Fixture, operation: &str, command: Value) -> Value {
    success(json!({"operation":operation,"handle":fixture.workspace,
        "projectId":fixture.project,"command":command}))
}
fn search(fixture: &Fixture, query: &str) -> Value {
    success(
        json!({"operation":"workspaceSearchEntities","handle":fixture.workspace,
        "projectId":fixture.project,"query":query}),
    )
}
fn type_into(handle: u64, text: &str) {
    let current = state(handle);
    success(
        json!({"operation":"documentReplace","handle":handle,"edit":{
        "revision":current["projection"]["revision"],"range":{"location":0,"length":0},"text":text}}),
    );
}
fn fields(result: &Value) -> Vec<(String, String)> {
    let mut found: Vec<(String, String)> = result["hits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|hit| {
            (
                hit["kind"].as_str().unwrap().to_string(),
                hit["field"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    found.sort();
    found
}

#[test]
fn workspace_search_entities_reads_fields_bodies_and_resolves() {
    let fixture = Fixture::new();
    let category = op(
        &fixture,
        "workspaceElements",
        json!({"action":"createCategory","name":"北塔地理"}),
    )["result"]["id"]
        .clone();
    let element = op(
        &fixture,
        "workspaceElements",
        json!({"action":"createElement","categoryId":category,"name":"林岚"}),
    )["result"]["id"]
        .clone();
    op(
        &fixture,
        "workspaceElements",
        json!({"action":"updateElement","elementId":element,"aliases":["守塔人"],"summary":"住在北塔的人"}),
    );
    op(
        &fixture,
        "workspaceElements",
        json!({"action":"setElementFacts","elementId":element,"facts":[{"key":"居所","value":"北塔顶层"}]}),
    );
    let opened = op(
        &fixture,
        "workspaceElements",
        json!({"action":"openElement","elementId":element}),
    );
    let handle = opened["handle"].as_u64().unwrap();
    type_into(handle, "她每夜登上北塔。");
    op(
        &fixture,
        "workspaceElements",
        json!({"action":"closeElement","elementId":element}),
    );
    op(
        &fixture,
        "workspaceStorylines",
        json!({"action":"createStoryline","name":"北塔之谜"}),
    );
    let drift = op(
        &fixture,
        "workspaceDrifts",
        json!({"action":"createDrift","title":"塔下的梦"}),
    )["result"]["id"]
        .clone();
    op(
        &fixture,
        "workspaceMetadata",
        json!({"action":"setNodeSummary","nodeId":drift,"summary":"梦见北塔倒塌"}),
    );
    op(
        &fixture,
        "workspaceMetadata",
        json!({"action":"setNodeSummary","nodeId":fixture.chapters[0],"summary":"初到北塔"}),
    );
    op(
        &fixture,
        "workspaceLibrary",
        json!({"action":"createText","title":"塔的草图","body":"北塔共九层"}),
    );
    let found = search(&fixture, " 北塔 ");
    assert_eq!(
        fields(&found),
        [
            ("category", "name"),
            ("chapter", "summary"),
            ("drift", "summary"),
            ("element", "body"),
            ("element", "fact"),
            ("element", "summary"),
            ("library", "text"),
            ("storyline", "name"),
        ]
        .map(|(a, b)| (a.to_string(), b.to_string()))
    );
    assert_eq!(found["truncated"], false);
    assert!(search(&fixture, "守塔")["hits"][0]["field"] == "alias");
    assert_eq!(search(&fixture, "   ")["hits"], json!([]));
    let db = gateway(fixture.open(0)["handle"].as_u64().unwrap());
    let changes = || {
        db.query(
            "SELECT COUNT(*) FROM sync_change_set".into(),
            vec![],
            None,
            CLIENT.into(),
        )
        .unwrap()
        .rows
    };
    let hit = found["hits"]
        .as_array()
        .unwrap()
        .iter()
        .find(|hit| hit["field"] == "body")
        .unwrap()
        .clone();
    assert_eq!(hit["match"]["matchedText"], "北塔");
    let resolve = |hit: &Value| {
        json!({"operation":"workspaceResolveEntityHit","handle":fixture.workspace,
            "projectId":fixture.project,"hit":hit})
    };
    // A body hit resolves only in its open owner, after edits before it.
    assert!(rejected(resolve(&hit)).contains("先打开"));
    let reopened = op(
        &fixture,
        "workspaceElements",
        json!({"action":"openElement","elementId":element}),
    )["handle"]
        .as_u64()
        .unwrap();
    type_into(reopened, "冬天，");
    let range = success(resolve(&hit))["range"].clone();
    assert_eq!(range, json!({"location":8,"length":2}));
    // The live owner is searched, including unsaved text.
    type_into(reopened, "北塔以北，");
    // Searching writes nothing.
    let before = changes();
    let live = search(&fixture, "北塔以北");
    assert_eq!(fields(&live), [("element".to_string(), "body".to_string())]);
    assert_eq!(changes(), before);
    op(
        &fixture,
        "workspaceElements",
        json!({"action":"closeElement","elementId":element}),
    );
    // After closing, the cached text follows the new revision.
    assert_eq!(fields(&search(&fixture, "北塔以北")).len(), 1);
    fixture.close();
}
