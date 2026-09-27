//! Version history through the C ABI.
use super::*;

fn history(fixture: &Fixture, command: Value) -> Value {
    json!({"operation":"workspaceHistory","handle":fixture.workspace,"projectId":fixture.project,"command":command})
}
fn edit(handle: u64, text: &str) {
    let current = state(handle);
    success(
        json!({"operation":"documentReplace","handle":handle,"edit":{
        "revision":current["projection"]["revision"],"range":{"location":0,"length":0},"text":text}}),
    );
}
fn entries(fixture: &Fixture, chapter: &str) -> Vec<Value> {
    success(history(
        fixture,
        json!({"action":"list","target":{"kind":"chapter","id":chapter}}),
    ))["entries"]
        .as_array()
        .unwrap()
        .clone()
}

#[test]
fn workspace_history_captures_lists_and_restores_versions() {
    let fixture = Fixture::new();
    let chapter = fixture.chapters[0].clone();
    // Opening captures the first version; closing captures each draft (a
    // periodic save within 15 minutes of the last version captures nothing).
    let close = || {
        success(
            json!({"operation":"workspaceCloseChapter","handle":fixture.workspace,
            "projectId":fixture.project,"chapterId":chapter}),
        );
    };
    let handle = fixture.open(0)["handle"].as_u64().unwrap();
    edit(handle, "第一稿。");
    success(json!({"operation":"documentSave","handle":handle}));
    close();
    assert_eq!(entries(&fixture, &chapter)[0]["text"], "第一稿。");
    let handle = fixture.open(0)["handle"].as_u64().unwrap();
    edit(handle, "改写：");
    close();
    let versions = entries(&fixture, &chapter);
    assert_eq!(versions[0]["text"], "改写：第一稿。");
    let original = versions
        .iter()
        .find(|v| v["text"] == "第一稿。")
        .expect("the saved version")
        .clone();
    assert_eq!(original["meta"]["title"].as_str().is_some(), true);
    // Restoring a closed body goes through a temporary owner.
    let restored = success(history(
        &fixture,
        json!({"action":"restore","target":{"kind":"chapter","id":chapter},
        "snapshotId":original["id"]}),
    ));
    assert_eq!(
        (
            restored["handle"].clone(),
            restored["document"]["projection"]["text"].clone()
        ),
        (Value::Null, json!("第一稿。"))
    );
    let after = entries(&fixture, &chapter);
    assert!(
        after.iter().any(|v| v["text"] == "改写：第一稿。"),
        "the replaced state stays in history"
    );
    // Restoring into an open editor is one undo step.
    let handle = fixture.open(0)["handle"].as_u64().unwrap();
    let rewrite = after
        .iter()
        .find(|v| v["text"] == "改写：第一稿。")
        .unwrap()["id"]
        .clone();
    let live = success(history(
        &fixture,
        json!({"action":"restore","target":{"kind":"chapter","id":chapter},"snapshotId":rewrite}),
    ));
    assert_eq!(live["handle"].as_u64(), Some(handle));
    assert_eq!(state(handle)["projection"]["text"], "改写：第一稿。");
    success(json!({"operation":"documentUndo","handle":handle}));
    assert_eq!(state(handle)["projection"]["text"], "第一稿。");
    // A version of another body is refused.
    let other = fixture.chapters[1].clone();
    assert!(rejected(history(
        &fixture,
        json!({"action":"restore","target":{"kind":"chapter","id":other},"snapshotId":rewrite})
    ))
    .contains("不属于"));
    assert!(rejected(history(
        &fixture,
        json!({"action":"restore","target":{"kind":"chapter","id":chapter},"snapshotId":"missing"})
    ))
    .contains("不存在"));
    fixture.close();
}
