//! Category pages: body owners and element body templates through the C ABI.
use super::*;

fn elements(fixture: &Fixture, command: Value) -> Value {
    json!({"operation":"workspaceElements","handle":fixture.workspace,"projectId":fixture.project,"command":command})
}

#[test]
fn workspace_category_bodies_and_element_templates() {
    let mut fixture = Fixture::new();
    let category = success(elements(
        &fixture,
        json!({"action":"createCategory","name":"人物"}),
    ))["result"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    // Without a template a new element starts with one empty paragraph.
    assert_eq!(
        success(elements(
            &fixture,
            json!({"action":"elementTemplate","categoryId":category})
        ))["result"],
        json!([])
    );
    let blocks = json!([
        {"kind":"heading","level":2,"text":"外貌","marks":[]},
        {"kind":"paragraph","level":null,"text":"身高与衣着","marks":[{"mark":"bold","location":0,"length":2}]},
        {"kind":"heading","level":2,"text":"动机","marks":[]}
    ]);
    success(elements(
        &fixture,
        json!({"action":"setElementTemplate","categoryId":category,"blocks":blocks}),
    ));
    let stored = success(elements(
        &fixture,
        json!({"action":"elementTemplate","categoryId":category}),
    ))["result"]
        .clone();
    assert_eq!(stored, blocks);
    // Summary, aliases and facts can come with the element in one original.
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
    let before = changes();
    let full = success(elements(
        &fixture,
        json!({"action":"createElement","categoryId":category,"name":"林岚","summary":"守塔人",
            "aliases":["阿岚"],"facts":[{"key":"年龄","value":"十七"}]}),
    ))["result"]
        .clone();
    assert_eq!(
        (&full["summary"], &full["aliases"], &full["facts"]),
        (
            &json!("守塔人"),
            &json!(["阿岚"]),
            &json!([{"key":"年龄","value":"十七"}])
        )
    );
    let actions: Vec<String> = db
        .query(
            format!("SELECT m.target_kind||':'||m.action FROM sync_mutation m WHERE m.change_set_id=(
                SELECT change_set_id FROM sync_mutation WHERE action='entity.create' AND target_kind='element'
                AND target_id='{}') ORDER BY m.mutation_index", full["id"].as_str().unwrap()),
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
    for expected in [
        "element:entity.create",
        "alias:set.add",
        "kv-entry:entity.create",
    ] {
        assert!(
            actions.iter().any(|a| a == expected),
            "{expected} in {actions:?}"
        );
    }
    let after = changes();
    let count = |rows: &Vec<Vec<DatabaseValue>>| match &rows[0][0] {
        DatabaseValue::Integer(value) => value.parse::<u64>().unwrap(),
        _ => panic!("count"),
    };
    let _ = &before;
    assert!(rejected(elements(
        &fixture,
        json!({"action":"createElement","categoryId":category,"name":"新人","aliases":["林岚"]}),
    ))
    .len()
        > 0);
    assert_eq!(count(&changes()), count(&after));
    // A new element's body starts from the template.
    let element = success(elements(
        &fixture,
        json!({"action":"createElement","categoryId":category,"name":"米拉"}),
    ))["result"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let body = success(
        json!({"operation":"workspaceAgent","handle":fixture.workspace,"projectId":fixture.project,
        "command":{"action":"readProse","target":{"kind":"element","id":element}}}),
    );
    assert_eq!(body["text"], "外貌\n身高与衣着\n动机");
    let opened = success(elements(
        &fixture,
        json!({"action":"openElement","elementId":element}),
    ));
    let kinds: Vec<&str> = opened["document"]["projection"]["blocks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b["kind"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["heading", "paragraph", "heading"]);
    success(elements(
        &fixture,
        json!({"action":"closeElement","elementId":element}),
    ));
    assert!(rejected(elements(&fixture, json!({"action":"setElementTemplate","categoryId":category,
        "blocks":[{"kind":"paragraph","text":"短","marks":[{"mark":"bold","location":0,"length":3}]}]}))).contains("无效"));
    // The element overview pins a category to a grid cell and releases it.
    let pinned = success(elements(
        &fixture,
        json!({"action":"setCategoryLayout","categoryId":category,"gridX":-3,"gridY":2}),
    ));
    assert_eq!(
        pinned["result"],
        json!({"categoryId":category,"layoutMode":"pinned","gridX":-3,"gridY":2})
    );
    let layouts =
        success(elements(&fixture, json!({"action":"categoryLayouts"})))["result"].clone();
    assert_eq!(layouts[0]["layoutMode"], "pinned");
    assert!(rejected(elements(
        &fixture,
        json!({"action":"setCategoryLayout","categoryId":category,"gridX":1})
    ))
    .contains("both"));
    let auto = success(elements(
        &fixture,
        json!({"action":"setCategoryLayout","categoryId":category}),
    ));
    assert_eq!(auto["result"]["layoutMode"], "auto");
    assert_eq!(auto["result"]["gridX"], Value::Null);
    // Clearing the template.
    success(elements(
        &fixture,
        json!({"action":"setElementTemplate","categoryId":category,"blocks":[]}),
    ));
    assert_eq!(
        success(elements(
            &fixture,
            json!({"action":"elementTemplate","categoryId":category})
        ))["result"],
        json!([])
    );
    // The category body is an owner of its own; trash retires it.
    let owner = success(elements(
        &fixture,
        json!({"action":"openCategory","categoryId":category}),
    ))["handle"]
        .as_u64()
        .unwrap();
    let current = state(owner);
    success(json!({"operation":"documentReplace","handle":owner,"edit":{
        "revision":current["projection"]["revision"],"range":{"location":0,"length":0},"text":"故事里的人。"}}));
    assert_eq!(
        success(
            json!({"operation":"workspaceAgent","handle":fixture.workspace,"projectId":fixture.project,
        "command":{"action":"readProse","target":{"kind":"category","id":category}}})
        )["live"],
        true
    );
    success(elements(
        &fixture,
        json!({"action":"closeCategory","categoryId":category}),
    ));
    let versions = success(json!({"operation":"workspaceHistory","handle":fixture.workspace,"projectId":fixture.project,
        "command":{"action":"list","target":{"kind":"category","id":category}}}))["entries"].clone();
    assert_eq!(versions[0]["text"], "故事里的人。");
    success(elements(
        &fixture,
        json!({"action":"openCategory","categoryId":category}),
    ));
    success(elements(
        &fixture,
        json!({"action":"trashCategory","categoryId":category}),
    ));
    assert!(rejected(elements(
        &fixture,
        json!({"action":"closeCategory","categoryId":category})
    ))
    .contains("not open"));
    fixture.close();
    fixture.workspace = success(json!({"operation":"workspaceOpen","directory":fixture.directory}))
        ["handle"]
        .as_u64()
        .unwrap();
    success(elements(
        &fixture,
        json!({"action":"restoreCategory","categoryId":category}),
    ));
    let reopened = success(elements(
        &fixture,
        json!({"action":"openCategory","categoryId":category}),
    ));
    assert_eq!(reopened["document"]["projection"]["text"], "故事里的人。");
    fixture.close();
}
