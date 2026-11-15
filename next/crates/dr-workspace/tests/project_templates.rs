//! End-to-end workspace tests for user project templates (`project-templates.md` §5, §7, §8, §14, §15;
//! `handoff/v5-tracks.md` PT1).

mod common;
use common::*;
use dr_workspace::Actor;
use serde_json::{Value, json};

#[test]
fn project_template_crud_lifecycle() {
    let e = env();
    assert_eq!(e.out("project_template.list", json!({})), json!([]));

    let b = e.book();
    let saved = e.out(
        "project_template.save",
        json!({
            "book": b,
            "name": "  我的写书模板  ",
            "description": "从默认项目另存"
        }),
    );
    let tpl_id = saved["id"].as_str().unwrap().to_owned();
    assert_eq!(saved["name"], "我的写书模板");
    assert_eq!(saved["description"], "从默认项目另存");
    assert_eq!(saved["origin"], "own");
    assert_eq!(saved["revision"], 1);
    assert_eq!(saved["has_book"], true);

    let list = e.out("project_template.list", json!({}));
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["id"], tpl_id);

    let got = e.out("project_template.get", json!({"id": tpl_id}));
    assert_eq!(got["summary"]["id"], tpl_id);
    assert_eq!(got["value"]["format"], "drifting.project-template");
    assert_eq!(got["value"]["formatVersion"], 1);
    assert_eq!(got["value"]["name"], "我的写书模板");

    let updated = e.out(
        "project_template.update",
        json!({
            "id": tpl_id,
            "name": "改名后的模板",
            "description": "新的描述"
        }),
    );
    assert_eq!(updated["name"], "改名后的模板");
    assert_eq!(updated["description"], "新的描述");
    assert_eq!(updated["revision"], 1);

    // Library-level undo restores the rename.
    e.ws().undo(&Actor::User).unwrap().unwrap();
    let reverted = e.out("project_template.get", json!({"id": tpl_id}));
    assert_eq!(reverted["summary"]["name"], "我的写书模板");
    assert_eq!(reverted["value"]["name"], "我的写书模板");

    // Replacing increments `revision` while keeping the same ID.
    let replaced = e.out(
        "project_template.save",
        json!({
            "book": b,
            "name": "我的写书模板 v2",
            "description": "替换保存",
            "replace": tpl_id
        }),
    );
    assert_eq!(replaced["id"], tpl_id);
    assert_eq!(replaced["revision"], 2);

    // Removing purges directly without trash.
    e.call("project_template.remove", json!({"id": tpl_id}));
    assert_eq!(e.out("project_template.list", json!({})), json!([]));
    assert!(
        e.try_call("project_template.get", json!({"id": tpl_id}))
            .is_err()
    );
    let _: Value = got;
}
