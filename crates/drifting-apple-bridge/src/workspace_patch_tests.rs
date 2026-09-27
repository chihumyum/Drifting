//! Element patches (设定补丁) through the C ABI: create, edit, order, delete,
//! and anchored patches following their chapter text.
use super::*;

fn patches(fixture: &Fixture, command: Value) -> Value {
    json!({"operation":"workspacePatches","handle":fixture.workspace,"projectId":fixture.project,"command":command})
}
fn elements(fixture: &Fixture, command: Value) -> Value {
    json!({"operation":"workspaceElements","handle":fixture.workspace,"projectId":fixture.project,"command":command})
}
fn replace(handle: u64, location: u64, length: u64, text: &str) {
    let current = state(handle);
    success(
        json!({"operation":"documentReplace","handle":handle,"edit":{
        "revision":current["projection"]["revision"],"range":{"location":location,"length":length},"text":text}}),
    );
}
fn titles(reply: &Value) -> Vec<String> {
    reply["patches"]
        .as_array()
        .unwrap()
        .iter()
        .map(|patch| patch["title"].as_str().unwrap_or("").to_string())
        .collect()
}

#[test]
fn workspace_patches_create_edit_order_follow_text_and_delete() {
    let mut fixture = Fixture::new();
    let category = success(elements(
        &fixture,
        json!({"action":"createCategory","name":"人物"}),
    ))["result"]["id"]
        .clone();
    let element = success(elements(
        &fixture,
        json!({"action":"createElement","categoryId":category,"name":"林岚"}),
    ))["result"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let chapter = fixture.chapters[0].clone();
    let handle = fixture.open(0)["handle"].as_u64().unwrap();
    replace(handle, 0, 0, "林岚失去了左臂。她在北塔。");
    let block = state(handle)["projection"]["blocks"][0]["id"].clone();
    let db = gateway(handle);
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
    let floating = success(patches(
        &fixture,
        json!({"action":"createPatch","elementId":element,"title":"旧伤","body":"左臂有疤"}),
    ));
    assert_eq!(floating["result"]["body"], "左臂有疤");
    assert_eq!(floating["result"]["sourceNodeId"], Value::Null);
    let anchored = success(patches(
        &fixture,
        json!({"action":"createPatch","elementId":element,"title":"断臂","body":"第一章起只剩右臂",
        "source":{"nodeId":chapter,"blockId":block,"blockText":"林岚失去了左臂。她在北塔。","anchorText":"失去了左臂"}}),
    ));
    let anchored_id = anchored["result"]["id"].clone();
    assert_eq!(
        (
            &anchored["result"]["anchorText"],
            &anchored["result"]["sourceNodeTitle"],
            &anchored["result"]["invalidatedAt"]
        ),
        (&json!("失去了左臂"), &json!("初航"), &Value::Null)
    );
    assert_eq!(titles(&anchored), ["旧伤", "断臂"]);
    // Refusals write nothing.
    let before = changes();
    for command in [
        json!({"action":"createPatch","elementId":element,"title":"  ","body":" "}),
        json!({"action":"createPatch","elementId":"missing","title":"x"}),
        json!({"action":"createPatch","elementId":element,"title":"x","source":{"nodeId":"missing"}}),
        json!({"action":"updatePatch","patchId":floating["result"]["id"],"title":null,"body":""}),
        json!({"action":"movePatch","patchId":anchored_id,"before":anchored_id}),
        json!({"action":"deletePatch","patchId":"missing"}),
    ] {
        rejected(patches(&fixture, command));
    }
    assert_eq!(changes(), before);
    // Edits; an unchanged edit writes nothing.
    let edited = success(patches(
        &fixture,
        json!({"action":"updatePatch","patchId":floating["result"]["id"],"title":"旧伤疤","body":"左臂有一道疤"}),
    ));
    assert_eq!(edited["result"]["title"], "旧伤疤");
    let after_edit = changes();
    success(patches(
        &fixture,
        json!({"action":"updatePatch","patchId":floating["result"]["id"],"title":"旧伤疤","body":"左臂有一道疤"}),
    ));
    assert_eq!(changes(), after_edit);
    let moved = success(patches(
        &fixture,
        json!({"action":"movePatch","patchId":anchored_id,"before":floating["result"]["id"]}),
    ));
    assert_eq!(titles(&moved), ["断臂", "旧伤疤"]);
    // Deleting the anchored text invalidates the patch on save; undo restores it.
    replace(handle, 2, 5, "");
    let listed = success(patches(
        &fixture,
        json!({"action":"nodePatches","nodeId":chapter}),
    ));
    assert!(
        listed["patches"][0]["invalidatedAt"].is_string(),
        "{listed}"
    );
    success(json!({"operation":"documentUndo","handle":handle}));
    let restored = success(patches(
        &fixture,
        json!({"action":"patches","elementId":element}),
    ));
    assert_eq!(restored["patches"][0]["invalidatedAt"], Value::Null);
    // Delete keeps the other patch.
    let deleted = success(patches(
        &fixture,
        json!({"action":"deletePatch","patchId":floating["result"]["id"]}),
    ));
    assert_eq!(titles(&deleted), ["断臂"]);
    success(
        json!({"operation":"workspaceCloseChapter","handle":fixture.workspace,
        "projectId":fixture.project,"chapterId":chapter}),
    );
    fixture.close();
    fixture.workspace = success(json!({"operation":"workspaceOpen","directory":fixture.directory}))
        ["handle"]
        .as_u64()
        .unwrap();
    let cold = success(patches(
        &fixture,
        json!({"action":"patches","elementId":element}),
    ));
    assert_eq!(titles(&cold), ["断臂"]);
    assert_eq!(cold["patches"][0]["body"], "第一章起只剩右臂");
    fixture.close();
}
