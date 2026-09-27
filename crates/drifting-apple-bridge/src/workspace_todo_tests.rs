//! Project TODOs and notes outside a selection, their associations and
//! deletion, including an anchored comment whose chapter is open.
use super::*;

fn query(db: &DatabaseGateway, sql: &str) -> Vec<Vec<DatabaseValue>> {
    db.query(sql.into(), vec![], None, CLIENT.into())
        .unwrap()
        .rows
}
fn comments(fixture: &Fixture, command: Value) -> Value {
    json!({"operation":"workspaceComments","handle":fixture.workspace,"projectId":fixture.project,"command":command})
}
fn relations(fixture: &Fixture, command: Value) -> Value {
    json!({"operation":"workspaceRelations","handle":fixture.workspace,"projectId":fixture.project,"command":command})
}
fn change_sets(db: &DatabaseGateway) -> Vec<Vec<DatabaseValue>> {
    query(db, "SELECT COUNT(*) FROM sync_change_set")
}

#[test]
fn workspace_todos_create_update_associate_and_delete() {
    let mut fixture = Fixture::new();
    let db = gateway(fixture.open(0)["handle"].as_u64().unwrap());
    let floating = success(comments(
        &fixture,
        json!({"action":"create","kind":"todo","body":"补一场雨夜戏","priority":"high"}),
    ))["result"]
        .clone();
    assert_eq!(
        (
            &floating["kind"],
            &floating["targetKind"],
            &floating["priority"],
            &floating["status"]
        ),
        (&json!("todo"), &Value::Null, &json!("high"), &json!("open"))
    );
    let before = change_sets(&db);
    for command in [
        json!({"action":"create","kind":"note","body":"浮动批注"}),
        json!({"action":"create","kind":"todo","body":"x","priority":"urgent"}),
        json!({"action":"create","kind":"todo","body":"  "}),
        json!({"action":"create","kind":"todo","body":"x","targetKind":"node","targetId":"missing"}),
        json!({"action":"create","kind":"todo","body":"x","targetKind":"patch","targetId":"p"}),
        json!({"action":"create","kind":"todo","body":"x","targetKind":"node"}),
        json!({"action":"create","kind":"memo","body":"x"}),
        json!({"action":"update","commentId":floating["id"],"kind":"note"}),
        json!({"action":"update","commentId":floating["id"],"priority":"urgent"}),
    ] {
        rejected(comments(&fixture, command));
    }
    assert_eq!(change_sets(&db), before);
    let chapter = fixture.chapters[1].clone();
    let on_chapter = success(comments(
        &fixture,
        json!({"action":"create","kind":"todo","targetKind":"node","targetId":chapter,"body":"核对钟楼的高度"}),
    ));
    let todo = on_chapter["result"].clone();
    assert_eq!(
        (
            &todo["targetKind"],
            &todo["targetId"],
            &todo["targetBlockId"]
        ),
        (&json!("node"), &json!(chapter), &Value::Null)
    );
    assert_eq!(on_chapter["comments"].as_array().unwrap().len(), 2);
    let assistant = success(comments(
        &fixture,
        json!({"action":"create","kind":"todo","body":"助手记下的待办","byAssistant":true}),
    ))["result"]
        .clone();
    assert_eq!(
        (
            &assistant["authorKind"],
            &assistant["authorName"],
            &assistant["authorId"],
            &assistant["source"]
        ),
        (
            &json!("ai"),
            &json!("写作助手"),
            &Value::Null,
            &json!("api")
        )
    );
    success(comments(
        &fixture,
        json!({"action":"delete","commentId":assistant["id"]}),
    ));
    // Kind, priority and body change; an unchanged update writes nothing.
    let updated = success(comments(
        &fixture,
        json!({"action":"update","commentId":todo["id"],"kind":"note","priority":"low","body":"核对钟楼"}),
    ))["result"]
        .clone();
    assert_eq!(
        (&updated["kind"], &updated["priority"]),
        (&json!("note"), &json!("low"))
    );
    assert!(updated["bodyJson"].as_str().unwrap().contains("核对钟楼"));
    let after_update = change_sets(&db);
    success(comments(
        &fixture,
        json!({"action":"update","commentId":todo["id"],"kind":"note","priority":"low","body":"核对钟楼"}),
    ));
    assert_eq!(change_sets(&db), after_update);
    let cleared = success(comments(
        &fixture,
        json!({"action":"update","commentId":todo["id"],"priority":null}),
    ))["result"]
        .clone();
    assert_eq!(cleared["priority"], Value::Null);
    let resolved = success(comments(
        &fixture,
        json!({"action":"setResolved","commentId":floating["id"],"resolved":true}),
    ))["result"]
        .clone();
    assert_eq!(resolved["status"], "resolved");
    assert!(resolved["resolvedAt"].is_string());
    // TODOs and library items associate with structural entities.
    let association = format!("system:generic-association:{}", fixture.project);
    let linked = success(relations(
        &fixture,
        json!({"action":"addRelation","fromKind":"comment","fromId":floating["id"],
        "toKind":"node","toId":fixture.chapters[0],"relationTypeId":association}),
    ));
    assert!(!linked.to_string().is_empty());
    let note = success(
        json!({"operation":"workspaceLibrary","handle":fixture.workspace,
        "projectId":fixture.project,"command":{"action":"createText","title":"素材","body":"雨"}}),
    )["result"]["id"]
        .clone();
    success(relations(
        &fixture,
        json!({"action":"addRelation","fromKind":"library_item","fromId":note,
        "toKind":"node","toId":fixture.chapters[1],"relationTypeId":association}),
    ));
    rejected(relations(
        &fixture,
        json!({"action":"addRelation","fromKind":"comment","fromId":"missing",
        "toKind":"node","toId":fixture.chapters[0],"relationTypeId":association}),
    ));
    let count = |db: &DatabaseGateway, kind: &str| {
        query(
            db,
            &format!("SELECT COUNT(*) FROM entity_relation WHERE from_kind='{kind}'"),
        )
    };
    assert_eq!(
        count(&db, "comment"),
        vec![vec![DatabaseValue::Integer("1".into())]]
    );
    // Deleting a TODO purges it and its relations in one original.
    let deleted = success(comments(
        &fixture,
        json!({"action":"delete","commentId":floating["id"]}),
    ));
    assert_eq!(deleted["comments"].as_array().unwrap().len(), 1);
    assert_eq!(
        count(&db, "comment"),
        vec![vec![DatabaseValue::Integer("0".into())]]
    );
    assert_eq!(
        query(&db, &format!("SELECT state FROM sync_entity_lifecycle WHERE entity_kind='comment' AND entity_id='{}'", floating["id"].as_str().unwrap())),
        vec![vec![DatabaseValue::Text("purged".into())]]
    );
    assert_eq!(
        count(&db, "library_item"),
        vec![vec![DatabaseValue::Integer("1".into())]]
    );
    rejected(comments(
        &fixture,
        json!({"action":"delete","commentId":floating["id"]}),
    ));
    fixture.close();
    fixture.workspace = success(json!({"operation":"workspaceOpen","directory":fixture.directory}))
        ["handle"]
        .as_u64()
        .unwrap();
    let listed = success(comments(&fixture, json!({"action":"list"})))["comments"].clone();
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(listed[0]["kind"], "note");
    fixture.close();
}

#[test]
fn workspace_todos_delete_an_anchored_comment_under_an_open_owner() {
    let fixture = Fixture::new();
    let handle = fixture.open(0)["handle"].as_u64().unwrap();
    let current = state(handle);
    success(
        json!({"operation":"documentReplace","handle":handle,"edit":{
        "revision":current["projection"]["revision"],"range":{"location":0,"length":0},
        "text":"钟声在雨夜里响起。"}}),
    );
    let created = success(json!({"operation":"documentCreateComment","handle":handle,
        "revision":state(handle)["projection"]["revision"],
        "range":{"location":0,"length":2},"body":"改成更具体的声音"}));
    let id = created["comment"]["id"].clone();
    // The note becomes a TODO without touching its anchor.
    let todo = success(comments(
        &fixture,
        json!({"action":"update","commentId":id,"kind":"todo","priority":"med"}),
    ))["result"]
        .clone();
    assert_eq!(todo["targetBlockId"], created["comment"]["targetBlockId"]);
    success(comments(
        &fixture,
        json!({"action":"delete","commentId":id}),
    ));
    let listed =
        success(json!({"operation":"documentComments","handle":handle}))["comments"].clone();
    assert_eq!(listed.as_array().unwrap().len(), 0);
    // Editing before the old anchor still saves: the owner no longer
    // persists the deleted row's anchor.
    let current = state(handle);
    success(
        json!({"operation":"documentReplace","handle":handle,"edit":{
        "revision":current["projection"]["revision"],"range":{"location":0,"length":0},
        "text":"远处，"}}),
    );
    success(
        json!({"operation":"workspaceCloseChapter","handle":fixture.workspace,
        "projectId":fixture.project,"chapterId":fixture.chapters[0]}),
    );
    let reopened = fixture.open(0)["handle"].as_u64().unwrap();
    assert_eq!(
        state(reopened)["projection"]["text"],
        "远处，钟声在雨夜里响起。"
    );
    fixture.close();
}

#[test]
fn workspace_suggestions_create_resolve_list_and_delete() {
    let mut fixture = Fixture::new();
    let handle = fixture.open(0)["handle"].as_u64().unwrap();
    let current = state(handle);
    success(
        json!({"operation":"documentReplace","handle":handle,"edit":{
        "revision":current["projection"]["revision"],"range":{"location":0,"length":0},"text":"林岚走上北塔。"}}),
    );
    let db = gateway(handle);
    let suggest = |location: u64, length: u64, metadata: Value| {
        success(json!({"operation":"documentCreateComment","handle":handle,
            "revision":state(handle)["projection"]["revision"],
            "range":{"location":location,"length":length},"body":"新人物？",
            "suggestion":{"metadata":metadata,"priority":"med"}}))["comment"]
            .clone()
    };
    let person = suggest(
        0,
        2,
        json!({"type":"element","name":"林岚","category":"人物"}),
    );
    assert_eq!(
        (
            &person["source"],
            &person["authorKind"],
            &person["authorName"],
            &person["priority"]
        ),
        (
            &json!("copilot"),
            &json!("copilot"),
            &json!("Copilot"),
            &json!("med")
        )
    );
    let place = suggest(
        4,
        2,
        json!({"type":"element","name":"北塔","category":"地点"}),
    );
    let manual = success(comments(
        &fixture,
        json!({"action":"create","kind":"todo","body":"普通待办"}),
    ))["result"]
        .clone();
    let resolve = |id: &Value, accepted: bool, result: Value| {
        comments(
            &fixture,
            json!({"action":"resolveSuggestion","commentId":id,"accepted":accepted,"result":result}),
        )
    };
    assert!(rejected(resolve(&manual["id"], true, Value::Null)).contains("不是"));
    let rejected_action = success(resolve(&place["id"], false, Value::Null))["result"].clone();
    assert_eq!(rejected_action["kind"], "reject_suggestion");
    assert_eq!(
        serde_json::from_str::<Value>(rejected_action["payloadJson"].as_str().unwrap()).unwrap()
            ["name"],
        "北塔"
    );
    assert!(rejected(resolve(&place["id"], true, Value::Null)).contains("处理过"));
    let accepted = success(resolve(
        &person["id"],
        true,
        json!({"elementId":"synthetic-element"}),
    ))["result"]
        .clone();
    assert_eq!(accepted["kind"], "accept_suggestion");
    let listed =
        success(comments(&fixture, json!({"action":"suggestionActions"})))["result"].clone();
    assert_eq!(listed.as_array().unwrap().len(), 2);
    let statuses = success(comments(&fixture, json!({"action":"list"})))["comments"].clone();
    assert!(statuses
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["source"] == "copilot")
        .all(|c| c["status"] == "converted"));
    // Deleting a suggestion trashes its review action too.
    success(comments(
        &fixture,
        json!({"action":"delete","commentId":place["id"]}),
    ));
    let lifecycle = db
        .query(
            format!("SELECT state FROM sync_entity_lifecycle WHERE entity_kind='comment-action' AND entity_id='{}'",
                rejected_action["id"].as_str().unwrap()),
            vec![],
            None,
            CLIENT.into(),
        )
        .unwrap()
        .rows;
    assert_eq!(lifecycle, vec![vec![DatabaseValue::Text("trashed".into())]]);
    success(
        json!({"operation":"workspaceCloseChapter","handle":fixture.workspace,
        "projectId":fixture.project,"chapterId":fixture.chapters[0]}),
    );
    fixture.close();
    fixture.workspace = success(json!({"operation":"workspaceOpen","directory":fixture.directory}))
        ["handle"]
        .as_u64()
        .unwrap();
    let cold = success(comments(&fixture, json!({"action":"suggestionActions"})))["result"].clone();
    assert_eq!(cold.as_array().unwrap().len(), 1);
    assert_eq!(
        cold[0]["resultJson"],
        json!("{\"elementId\":\"synthetic-element\"}")
    );
    fixture.close();
}
