use dr_mirror::apply::apply_fields;
use dr_mirror::file::{FieldEdit, FieldSlot};
use dr_model::id::{BodyDocId, BookId, EntryId, EntryTemplateId, ModuleId};
use dr_model::v3::FieldValue;
use dr_testkit::seed::{DEFAULT_SEED, Preset, acceptance::novel_entry, generate_v3};
use dr_workspace::{Actor, Workspace};
use serde_json::json;

#[test]
fn edits_to_distinct_fields_survive_and_a_third_value_is_left_alone() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::open_dir(dir.path(), "mirror-test").unwrap();
    let seeded = generate_v3(Preset::Tiny, DEFAULT_SEED).unwrap();
    let book = BookId::parse(seeded.books[0].book_id().as_str()).unwrap();
    seeded.write_to(ws.library()).unwrap();
    let entry = novel_entry(
        &ws,
        book.as_str(),
        "tpl-chapter",
        "雨夜",
        Some("雨落在窗台。"),
    );
    let id = EntryId::parse(entry["id"].as_str().unwrap()).unwrap();
    let body = BodyDocId::new(id.clone(), ModuleId::parse("mod-prose").unwrap());
    let module = ModuleId::parse("mod-fields").unwrap();
    let template = EntryTemplateId::parse("tpl-chapter").unwrap();
    let set = |field: &str, value: &str| {
        ws.call(
            &Actor::User,
            "module.set_field",
            json!({"book":book,"entry":id,"module":module,"field":field,"value":value}),
        )
        .unwrap();
    };
    set("summary", "旧梗概");
    set("status", "draft");
    let edit = FieldEdit {
        slot: FieldSlot {
            module: module.clone(),
            field: "summary".into(),
        },
        expected: FieldValue::Text("旧梗概".into()),
        value: FieldValue::Text("外面改的梗概".into()),
    };
    set("status", "finished");
    assert!(
        apply_fields(&ws, &book, &body, &template, std::slice::from_ref(&edit))
            .unwrap()
            .is_empty()
    );
    let state = ws
        .call(&Actor::User, "entry.get", json!({"book":book,"id":id}))
        .unwrap();
    let values = &state["output"]["fields"]["mod-fields"];
    assert_eq!(values["status"], "finished");
    assert_eq!(values["summary"], "外面改的梗概");
    set("summary", "App 后来的梗概");
    let refused = apply_fields(&ws, &book, &body, &template, &[edit]).unwrap();
    assert_eq!(refused.len(), 1);
    let state = ws
        .call(&Actor::User, "entry.get", json!({"book":book,"id":id}))
        .unwrap();
    assert_eq!(
        state["output"]["fields"]["mod-fields"]["summary"],
        "App 后来的梗概"
    );
}
