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
