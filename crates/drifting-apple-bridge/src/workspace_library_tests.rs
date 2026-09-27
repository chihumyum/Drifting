//! The materials library and element portraits through the C ABI.
use super::*;

fn library(fixture: &Fixture, command: Value) -> Value {
    json!({"operation":"workspaceLibrary","handle":fixture.workspace,"projectId":fixture.project,"command":command})
}
fn items(reply: &Value) -> Vec<Value> {
    reply["library"]["items"].as_array().unwrap().clone()
}

#[test]
fn workspace_library_imports_edits_deletes_and_collects() {
    let mut fixture = Fixture::new();
    let sources = tempfile::tempdir().unwrap();
    let png = sources.path().join("北塔.png");
    std::fs::write(&png, b"synthetic png bytes").unwrap();
    let pdf = sources.path().join("notes.pdf");
    std::fs::write(&pdf, b"%PDF-1.4 synthetic").unwrap();
    let image = success(library(
        &fixture,
        json!({"action":"importFile","title":"北塔",
        "file":{"path":png,"mime":"image/png","extension":"png","width":320,"height":200}}),
    ));
    let image_item = image["result"].clone();
    assert_eq!(
        (
            image_item["kind"].as_str(),
            image_item["asset"]["width"].as_u64()
        ),
        (Some("image"), Some(320))
    );
    let stored = items(&image)[0]["assetPath"].as_str().unwrap().to_string();
    assert_eq!(std::fs::read(&stored).unwrap(), b"synthetic png bytes");
    assert!(
        stored.contains(&format!("/assets/{}/", fixture.project)),
        "{stored}"
    );
    success(library(
        &fixture,
        json!({"action":"importFile","title":"考据",
        "file":{"path":pdf,"mime":"application/pdf","extension":"pdf"}}),
    ));
    success(library(
        &fixture,
        json!({"action":"createLink","title":"资料","url":"https://example.invalid/a"}),
    ));
    let note = success(library(
        &fixture,
        json!({"action":"createText","title":"灵感","body":"雨夜\n钟声"}),
    ))["result"]
        .clone();
    let updated = success(library(
        &fixture,
        json!({"action":"updateItem","itemId":note["id"],"notes":"旧稿"}),
    ));
    assert_eq!(updated["result"]["notes"], "旧稿");
    assert_eq!(items(&updated).len(), 4);
    assert!(rejected(library(
        &fixture,
        json!({"action":"importFile","title":"x",
        "file":{"path":png,"mime":"text/plain","extension":"txt"}})
    ))
    .contains("图片或 PDF"));
    assert!(rejected(library(
        &fixture,
        json!({"action":"createLink","title":"x","url":"javascript:alert(1)"})
    ))
    .contains("http"));
    // Portraits bind an imported image to an element and release it again.
    let category = success(json!({"operation":"workspaceElements","handle":fixture.workspace,"projectId":fixture.project,
        "command":{"action":"createCategory","name":"人物"}}))["result"]["id"].clone();
    let element = success(json!({"operation":"workspaceElements","handle":fixture.workspace,"projectId":fixture.project,
        "command":{"action":"createElement","categoryId":category,"name":"米拉"}}))["result"]["id"].clone();
    let portrait = success(library(
        &fixture,
        json!({"action":"setPortrait","elementId":element,
        "file":{"path":png,"mime":"image/png","extension":"png","width":64,"height":64}}),
    ));
    let portrait_path = portrait["library"]["portraits"][0]["assetPath"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(std::path::Path::new(&portrait_path).exists());
    let cleared = success(library(
        &fixture,
        json!({"action":"setPortrait","elementId":element}),
    ));
    assert_eq!(cleared["library"]["portraits"], json!([]));
    assert!(!std::path::Path::new(&portrait_path).exists());
    // Deleting an item removes its bytes after the rows.
    let deleted = success(library(
        &fixture,
        json!({"action":"deleteItem","itemId":image_item["id"]}),
    ));
    assert_eq!(items(&deleted).len(), 3);
    assert!(!std::path::Path::new(&stored).exists());
    // A stray directory from an interrupted session is collected on open.
    let stray = fixture
        .directory
        .join("assets")
        .join(&fixture.project)
        .join("stray-asset");
    std::fs::create_dir_all(&stray).unwrap();
    std::fs::write(stray.join(".importing"), b"old-session").unwrap();
    fixture.close();
    fixture.workspace = success(json!({"operation":"workspaceOpen","directory":fixture.directory}))
        ["handle"]
        .as_u64()
        .unwrap();
    assert!(!stray.exists());
    let reopened = success(library(&fixture, json!({"action":"library"})));
    assert_eq!(items(&reopened).len(), 3);
    let pdf_path = items(&reopened)[0]["assetPath"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(
        std::path::Path::new(&pdf_path).exists(),
        "committed assets survive collection"
    );
    fixture.close();
}

#[test]
fn workspace_library_reorders_items_in_authored_order() {
    let mut fixture = Fixture::new();
    let db = gateway(fixture.open(0)["handle"].as_u64().unwrap());
    let changes = |db: &DatabaseGateway| {
        db.query(
            "SELECT COUNT(*) FROM sync_change_set".into(),
            vec![],
            None,
            CLIENT.into(),
        )
        .unwrap()
        .rows
    };
    let mut ids = Vec::new();
    for title in ["甲", "乙", "丙", "丁"] {
        let reply = success(library(
            &fixture,
            json!({"action":"createText","title":title,"body":title}),
        ));
        ids.push(reply["result"]["id"].as_str().unwrap().to_string());
    }
    let titles = |reply: &Value| -> Vec<String> {
        items(reply)
            .iter()
            .map(|item| item["title"].as_str().unwrap().to_string())
            .collect()
    };
    let moved = success(library(
        &fixture,
        json!({"action":"moveItem","itemId":ids[3],"before":ids[0]}),
    ));
    assert_eq!(titles(&moved), ["丁", "甲", "乙", "丙"]);
    let keys: Vec<i64> = items(&moved)
        .iter()
        .map(|item| item["orderKey"].as_i64().unwrap())
        .collect();
    assert_eq!(keys, [0, 1, 2, 3]);
    let after = changes(&db);
    // Moving to the current place writes nothing; bad targets are refused.
    success(library(
        &fixture,
        json!({"action":"moveItem","itemId":ids[3],"before":ids[0]}),
    ));
    for command in [
        json!({"action":"moveItem","itemId":ids[0],"before":ids[0]}),
        json!({"action":"moveItem","itemId":"missing","before":ids[0]}),
        json!({"action":"moveItem","itemId":ids[0],"before":"missing"}),
    ] {
        rejected(library(&fixture, command));
    }
    assert_eq!(changes(&db), after);
    let last = success(library(
        &fixture,
        json!({"action":"moveItem","itemId":ids[0]}),
    ));
    assert_eq!(titles(&last), ["丁", "乙", "丙", "甲"]);
    let registered = db
        .query(
            "SELECT COUNT(DISTINCT entity_id) FROM sync_order_register WHERE list_kind='library-item'".into(),
            vec![],
            None,
            CLIENT.into(),
        )
        .unwrap()
        .rows;
    assert_eq!(registered, vec![vec![DatabaseValue::Integer("4".into())]]);
    fixture.close();
    fixture.workspace = success(json!({"operation":"workspaceOpen","directory":fixture.directory}))
        ["handle"]
        .as_u64()
        .unwrap();
    let reopened = success(library(&fixture, json!({"action":"library"})));
    assert_eq!(titles(&reopened), ["丁", "乙", "丙", "甲"]);
    fixture.close();
}
