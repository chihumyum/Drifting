//! Automatic entity links and backlinks through the C ABI. With
//! NATIVE_WORKSPACE_LINK_EXPORT_DIR set, the linked Yjs states and name map
//! are exported for the renderer's decoder, matcher and reference projection.
use super::*;

fn command(fixture: &Fixture, command: Value) -> Value {
    success(
        json!({"operation":"workspaceElements","handle":fixture.workspace,
        "projectId":fixture.project,"command":command}),
    )
}
fn replace(handle: u64, location: u64, text: &str) -> Value {
    let current = state(handle);
    success(
        json!({"operation":"documentReplace","handle":handle,"edit":{
        "revision":current["projection"]["revision"],
        "range":{"location":location,"length":0},"text":text}}),
    )
}
fn link(handle: u64) -> Value {
    success(json!({"operation":"documentLinkEntities","handle":handle}))
}
/// (text, kind, id) for every linked run of a document state.
fn linked(state: &Value) -> Vec<(String, String, String)> {
    let text: Vec<u16> = state["projection"]["text"]
        .as_str()
        .unwrap()
        .encode_utf16()
        .collect();
    let mut found = Vec::new();
    for block in state["projection"]["blocks"].as_array().unwrap() {
        for run in block["runs"].as_array().unwrap() {
            let start = run["range"]["location"].as_u64().unwrap() as usize;
            let end = start + run["range"]["length"].as_u64().unwrap() as usize;
            for (key, value) in run["attributes"].as_object().unwrap() {
                if key.starts_with("entityLink") {
                    found.push((
                        String::from_utf16(&text[start..end]).unwrap(),
                        value["targetKind"].as_str().unwrap().into(),
                        value["targetId"].as_str().unwrap().into(),
                    ));
                }
            }
        }
    }
    found.sort();
    found
}

#[test]
fn workspace_links_chapters_and_element_bodies_and_reports_backlinks() {
    let mut fixture = Fixture::new();
    let first = fixture.open(0)["handle"].as_u64().unwrap();
    let db = gateway(first);
    let category =
        command(&fixture, json!({"action":"createCategory","name":"人物"}))["result"].clone();
    let hero = command(
        &fixture,
        json!({"action":"createElement","categoryId":category["id"],"name":"林凯"}),
    )["result"]
        .clone();
    command(
        &fixture,
        json!({"action":"updateElement","elementId":hero["id"],"aliases":["阿凯"]}),
    );
    let tower = command(
        &fixture,
        json!({"action":"createElement","categoryId":category["id"],"name":"北塔"}),
    )["result"]
        .clone();
    // Chapter 0 mentions both elements, an alias and chapter 1's title "归航".
    replace(first, 0, "林凯在北塔等信。\n阿凯想起归航🙂林凯");
    let changes = query_count(&db);
    let result = link(first);
    assert_eq!(result["linked"], 5);
    let hero_id = hero["id"].as_str().unwrap().to_owned();
    let tower_id = tower["id"].as_str().unwrap().to_owned();
    assert_eq!(
        linked(&result["state"]),
        vec![
            ("北塔".into(), "element".into(), tower_id.clone()),
            ("归航".into(), "node".into(), fixture.chapters[1].clone()),
            ("林凯".into(), "element".into(), hero_id.clone()),
            ("林凯".into(), "element".into(), hero_id.clone()),
            ("阿凯".into(), "element".into(), hero_id.clone()),
        ]
    );
    // One authored Yjs original; linking is not an undo step.
    assert_eq!(query_count(&db), changes + 1);
    assert_eq!(link(first)["linked"], 0);
    replace(first, 0, "序：北塔");
    assert_eq!(link(first)["linked"], 1);
    assert_eq!(
        success(json!({"operation":"documentUndo","handle":first}))["projection"]["text"],
        "林凯在北塔等信。\n阿凯想起归航🙂林凯"
    );
    // An element body never links itself, but links other elements.
    let body = command(
        &fixture,
        json!({"action":"openElement","elementId":hero["id"]}),
    )["handle"]
        .as_u64()
        .unwrap();
    replace(body, 0, "林凯常去北塔");
    let body_links = link(body);
    assert_eq!(
        linked(&body_links["state"]),
        vec![("北塔".into(), "element".into(), tower_id.clone())]
    );
    // Chapter 1 stays closed; its links come from a cold durable read.
    let second = fixture.open(1)["handle"].as_u64().unwrap();
    replace(second, 0, "林凯回来了");
    link(second);
    success(
        json!({"operation":"workspaceCloseChapter","handle":fixture.workspace,
        "projectId":fixture.project,"chapterId":fixture.chapters[1]}),
    );
    let backlinks = command(
        &fixture,
        json!({"action":"backlinks","elementId":hero["id"]}),
    );
    assert_eq!(backlinks["unavailable"], json!([]));
    let chapters = backlinks["chapters"].as_array().unwrap();
    assert_eq!(
        chapters
            .iter()
            .map(|c| (
                c["chapterId"].as_str().unwrap(),
                c["spans"].as_u64().unwrap(),
                c["blocks"].as_u64().unwrap()
            ))
            .collect::<Vec<_>>(),
        vec![
            (fixture.chapters[0].as_str(), 3, 2),
            (fixture.chapters[1].as_str(), 1, 1)
        ]
    );
    assert_eq!(chapters[0]["first"], json!({"location":0,"length":2}));
    if let Ok(directory) = std::env::var("NATIVE_WORKSPACE_LINK_EXPORT_DIR") {
        let export = |handle: u64| {
            let state = success(json!({"operation":"documentExport","handle":handle}));
            json!({"updateBase64": state["update"], "text": state_text(handle)})
        };
        let second = fixture.open(1)["handle"].as_u64().unwrap();
        let library = command(&fixture, json!({"action":"library"}))["library"].clone();
        let fixture_json = json!({
            "elements": library["elements"],
            "chapters": [
                {"id": fixture.chapters[0], "title": "初航", "document": export(first)},
                {"id": fixture.chapters[1], "title": "归航", "document": export(second)},
            ],
            "elementBody": {"id": hero["id"], "document": export(body)},
            "backlinks": backlinks,
        });
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            PathBuf::from(directory).join("entity-links.json"),
            serde_json::to_vec_pretty(&fixture_json).unwrap(),
        )
        .unwrap();
    }
    // Pages link too: the open 林凯 body links 北塔, live and then cold.
    let tower_sources = |fixture: &Fixture| {
        command(fixture, json!({"action":"backlinks","elementId":tower_id}))["sources"].clone()
    };
    let expected = json!([{"kind":"element","id":hero["id"],"title":"林凯","spans":1,"blocks":1,
        "first":{"location":4,"length":2}}]);
    assert_eq!(tower_sources(&fixture), expected);
    command(
        &fixture,
        json!({"action":"closeElement","elementId":hero["id"]}),
    );
    assert_eq!(tower_sources(&fixture), expected);
    assert_eq!(tower_sources(&fixture), expected, "cached cold read");
    // Links persist across a cold reopen.
    fixture.close();
    fixture.workspace = success(json!({"operation":"workspaceOpen","directory":fixture.directory}))
        ["handle"]
        .as_u64()
        .unwrap();
    let reopened = fixture.open(0);
    assert_eq!(linked(&reopened["document"]).len(), 5);
    fixture.close();
}

fn query_count(db: &DatabaseGateway) -> u64 {
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

fn state_text(handle: u64) -> Value {
    state(handle)["projection"]["text"].clone()
}
