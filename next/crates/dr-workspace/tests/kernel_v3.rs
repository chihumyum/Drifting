mod common;
use common::*;
use serde_json::{Value, json};
fn project(e: &Env) -> String {
    e.out("project.create", json!({"name":"Synthetic novel"}))["id"]
        .as_str()
        .unwrap()
        .into()
}
fn entries(e: &Env, b: &str) -> Value {
    e.out("entry.list", json!({"book":b,"all":true,"trashed":true}))
}
fn root(e: &Env, b: &str, t: &str) -> String {
    entries(e, b)
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["template"] == t && e["parent"].is_null())
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .into()
}
fn create(e: &Env, b: &str, parent: &str, title: &str, t: &str) -> String {
    e.out(
        "entry.create",
        json!({"book":b,"parent":parent,"title":title,"template":t}),
    )["id"]
        .as_str()
        .unwrap()
        .into()
}
fn get(e: &Env, b: &str, id: &str) -> Value {
    e.out("entry.get", json!({"book":b,"id":id}))
}
fn version(e: &Env, b: &str) -> String {
    e.out("entry_history.version", json!({"book":b}))["version"]
        .as_str()
        .unwrap()
        .into()
}
fn tpl(e: &Env, b: &str, id: &str) -> Value {
    e.out("entry_template.list", json!({"book":b}))
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == id)
        .unwrap()
        .clone()
}
#[test]
fn v3_project_ids_and_legacy_isolation() {
    let e = env();
    let old = e.book();
    let b = project(&e);
    let c = project(&e);
    let a = entries(&e, &b);
    let z = entries(&e, &c);
    for id in ids(&a) {
        assert!(!ids(&z).contains(&id));
        assert!(dr_model::id::is_uuid_v7(&id));
    }
    assert!(
        e.try_call("entry.create", json!({"book":old,"title":"refused"}))
            .is_err()
    );
    assert!(
        e.out("chapter.list", json!({"book":old}))
            .as_array()
            .unwrap()
            .is_empty()
    );
    // A v3 typed operation must refuse v2.2 before any commit or document registration.
    let before = e
        .ws()
        .library()
        .load_copy(&format!("book:{old}"))
        .unwrap()
        .get_deep_value();
    for op in [
        "entry.list",
        "entry_template.list",
        "timeline_view.list",
        "membership.list",
    ] {
        assert!(e.try_call(op, json!({"book":old})).is_err());
    }
    assert_eq!(
        before,
        e.ws()
            .library()
            .load_copy(&format!("book:{old}"))
            .unwrap()
            .get_deep_value()
    );
}
#[test]
fn v3_creation_obeys_home_template_and_retains_module_data() {
    let mut e = env();
    let b = project(&e);
    let ms = root(&e, &b, "tpl-manuscript");
    let lines = root(&e, &b, "tpl-storylines");
    let lane = create(&e, &b, &lines, "Lane", "tpl-storyline");
    let chapter=e.out("entry.create",json!({"book":b,"parent":lane,"title":"Draft","bodies":{"mod-prose":"Synthetic first paragraph"}}));
    let id = chapter["id"].as_str().unwrap();
    assert_eq!(chapter["parent"], ms);
    assert_eq!(chapter["template"], "tpl-chapter");
    assert_eq!(chapter["primary"], lane);
    assert_eq!(
        e.out("membership.list", json!({"book":b}))
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let prose = json!({"book":b,"owner":id,"module":"mod-prose"});
    let read = e.out("module.read_prose", prose.clone());
    let block = read["paragraphs"][0]["block_id"].clone();
    e.call("module.replace_prose",json!({"book":b,"owner":id,"module":"mod-prose","block_id":block,"find":"first","replace":"second"}));
    assert!(
        e.out("module.read_prose", prose.clone())["paragraphs"][0]["text"]
            .as_str()
            .unwrap()
            .contains("second")
    );
    e.ws().undo(&dr_workspace::Actor::User).unwrap();
    assert!(
        e.out("module.read_prose", prose.clone())["paragraphs"][0]["text"]
            .as_str()
            .unwrap()
            .contains("first")
    );
    let mut custom = tpl(&e, &b, "tpl-chapter");
    custom["id"] = json!("alternate");
    custom["modules"] = json!([]);
    e.call("entry_template.put", json!({"book":b,"template":custom}));
    // Permit the alternate template on the manuscript before switching.
    e.call(
        "entry.update",
        json!({"book":b,"id":ms,"overrides":{"allow":[]}}),
    );
    e.call(
        "entry.update",
        json!({"book":b,"id":id,"template":"alternate"}),
    );
    e.call(
        "entry.update",
        json!({"book":b,"id":id,"template":"tpl-chapter"}),
    );
    assert!(
        e.out("module.read_prose", prose.clone())["paragraphs"][0]["text"]
            .as_str()
            .unwrap()
            .contains("first")
    );
    e.reopen();
    assert_eq!(get(&e, &b, id)["parent"], ms);
    assert!(
        e.out("module.read_prose", prose)["paragraphs"][0]["text"]
            .as_str()
            .unwrap()
            .contains("first")
    );
}
#[test]
fn v3_template_prose_is_book_scoped_and_copied_once() {
    let e = env();
    let b = project(&e);
    let other = project(&e);
    let ms = root(&e, &b, "tpl-manuscript");
    e.call("module.set_prose",json!({"book":b,"owner":"tpl-chapter","module":"mod-prose","template":true,"paragraphs":[{"heading":1,"text":"Synthetic template"}]}));
    let a = create(&e, &b, &ms, "A", "tpl-chapter");
    let read = |id: &str| {
        e.out(
            "module.read_prose",
            json!({"book":b,"owner":id,"module":"mod-prose"}),
        )
    };
    assert_eq!(read(&a)["paragraphs"][0]["heading"], 1);
    assert_eq!(read(&a)["paragraphs"][0]["text"], "Synthetic template");
    e.call("module.set_prose",json!({"book":b,"owner":"tpl-chapter","module":"mod-prose","template":true,"paragraphs":[{"text":"Later"}]}));
    assert_eq!(read(&a)["paragraphs"][0]["text"], "Synthetic template");
    assert_eq!(
        e.out(
            "module.read_prose",
            json!({"book":other,"owner":"tpl-chapter","module":"mod-prose","template":true})
        )["total"],
        0
    );
    // A level always has a description, independent of declared modules.
    e.call(
        "module.set_prose",
        json!({"book":b,"owner":ms,"module":"about","paragraphs":[{"text":"Folder description"}]}),
    );
    assert_eq!(
        e.out(
            "module.read_prose",
            json!({"book":b,"owner":ms,"module":"about"})
        )["paragraphs"][0]["text"],
        "Folder description"
    );
}
#[test]
fn v3_structure_validation_happens_before_writes() {
    let e = env();
    let b = project(&e);
    let ms = root(&e, &b, "tpl-manuscript");
    let a = create(&e, &b, &ms, "A", "tpl-chapter");
    let at = version(&e, &b);
    assert!(
        e.try_call(
            "entry.create",
            json!({"book":b,"parent":a,"title":"illegal"})
        )
        .is_err()
    );
    assert!(
        e.try_call("entry.move", json!({"book":b,"id":ms,"parent":a}))
            .is_err()
    );
    assert!(
        e.try_call(
            "entry_template.delete",
            json!({"book":b,"id":"tpl-chapter"})
        )
        .is_err()
    );
    assert!(
        e.try_call(
            "entry.update",
            json!({"book":b,"id":a,"overrides":{"auto_link":true}})
        )
        .is_err()
    );
    assert_eq!(at, version(&e, &b));
    let group = create(&e, &b, &ms, "Group", "tpl-group");
    assert!(
        e.try_call(
            "entry.update",
            json!({"book":b,"id":group,"overrides":{"is_manuscript":true}})
        )
        .is_err()
    );
}
#[test]
fn v3_history_restores_only_selected_entry_and_undo_survives_restart() {
    let mut e = env();
    let b = project(&e);
    let ms = root(&e, &b, "tpl-manuscript");
    let a = create(&e, &b, &ms, "A", "tpl-chapter");
    let z = create(&e, &b, &ms, "Z", "tpl-chapter");
    let at = version(&e, &b);
    e.call("entry.update", json!({"book":b,"id":a,"title":"Changed A"}));
    e.call("entry.update", json!({"book":b,"id":z,"title":"Changed Z"}));
    e.call("entry.move", json!({"book":b,"id":a,"parent":ms,"index":1}));
    e.call(
        "entry_history.restore",
        json!({"book":b,"at":at,"targets":[{"collection":"entries","id":a}]}),
    );
    assert_eq!(get(&e, &b, &a)["title"], "A");
    assert_eq!(get(&e, &b, &z)["title"], "Changed Z");
    assert_eq!(
        e.out("entry.list", json!({"book":b,"parent":ms}))[0]["id"],
        a
    );
    e.reopen();
    e.ws().undo(&dr_workspace::Actor::User).unwrap();
    assert_eq!(get(&e, &b, &a)["title"], "Changed A");
    assert_eq!(get(&e, &b, &z)["title"], "Changed Z");
    e.ws().redo(&dr_workspace::Actor::User).unwrap();
    assert_eq!(get(&e, &b, &a)["title"], "A");
}
#[test]
fn v3_membership_and_timeline_are_independent_of_residence() {
    let e = env();
    let b = project(&e);
    let ms = root(&e, &b, "tpl-manuscript");
    let ls = root(&e, &b, "tpl-storylines");
    let l = create(&e, &b, &ls, "First lane", "tpl-storyline");
    let r = create(&e, &b, &ls, "Second lane", "tpl-storyline");
    let a = create(&e, &b, &ms, "A", "tpl-chapter");
    for view in ["one", "two"] {
        e.call(
            "timeline_view.put",
            json!({"book":b,"view":{"id":view,"name":view,"lanes":[{"entry":l},{"entry":r}]}}),
        );
    }
    e.call(
        "timeline_view.place",
        json!({"book":b,"view":"one","entry":a,"lane":l,"at":10.5,"span":2}),
    );
    e.call(
        "timeline_view.place",
        json!({"book":b,"view":"two","entry":a,"at":99}),
    );
    e.call("membership.add", json!({"book":b,"host":r,"member":a}));
    e.call(
        "timeline_view.remove",
        json!({"book":b,"view":"one","entry":a,"lane":l}),
    );
    let views = e.out("timeline_view.list", json!({"book":b}));
    assert_eq!(
        views
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == "two")
            .unwrap()["placements"][0]["at"],
        99.0
    );
    e.call("membership.remove", json!({"book":b,"host":r,"member":a}));
    for v in e
        .out("timeline_view.list", json!({"book":b}))
        .as_array()
        .unwrap()
    {
        assert!(v["placements"].as_array().unwrap().is_empty());
    }
    e.ws().undo(&dr_workspace::Actor::User).unwrap();
    assert_eq!(get(&e, &b, &a)["parent"], ms);
    e.call("entry.trash", json!({"book":b,"id":ls}));
    assert!(get(&e, &b, &a)["deleted_at"].is_null());
}
#[test]
fn v3_fields_validate_and_autolink_checks_memberships() {
    let e = env();
    let b = project(&e);
    let all = entries(&e, &b);
    let cat = all
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["overrides"]["default_template"] == "tpl-character")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let a = create(&e, &b, &cat, "Person A", "tpl-character");
    let z = create(&e, &b, &cat, "Person Z", "tpl-character");
    e.call(
        "module.set_field",
        json!({"book":b,"entry":a,"module":"mod-fields","field":"aliases","value":["Alias"]}),
    );
    let at = version(&e, &b);
    assert!(
        e.try_call(
            "module.set_field",
            json!({"book":b,"entry":z,"module":"mod-fields","field":"aliases","value":["Alias"]})
        )
        .is_err()
    );
    assert_eq!(at, version(&e, &b));
    e.call("module.put_kv",json!({"book":b,"entry":a,"module":"mod-kv","row":{"id":"row","key":"fact","value":"synthetic"}}));
    assert_eq!(
        e.out("module.read", json!({"book":b,"entry":a,"module":"mod-kv"}))["kv"][0]["value"],
        "synthetic"
    );
    e.ws().undo(&dr_workspace::Actor::User).unwrap();
    assert!(
        e.out("module.read", json!({"book":b,"entry":a,"module":"mod-kv"}))["kv"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn v3_null_clears_inherited_defaults_and_template_undo_keeps_nested_maps_writable() {
    let e = env();
    let b = project(&e);
    let ms = root(&e, &b, "tpl-manuscript");
    let group = create(&e, &b, &ms, "Group", "tpl-group");
    assert_eq!(
        e.out("level.get", json!({"book":b,"id":group}))["settings"]["default_template"],
        "tpl-chapter"
    );
    e.call(
        "entry.update",
        json!({"book":b,"id":group,"overrides":{"default_template":null,"home":null,"allow":[]}}),
    );
    let settings = e.out("level.get", json!({"book":b,"id":group}));
    assert!(settings["settings"]["default_template"].is_null());
    e.call("entry.update", json!({"book":b,"id":group,"overrides":{}}));
    assert_eq!(
        e.out("level.get", json!({"book":b,"id":group}))["settings"]["default_template"],
        "tpl-chapter"
    );
    let original = tpl(&e, &b, "tpl-chapter");
    let mut changed = original.clone();
    changed["modules"][0]["name"] = json!("Changed");
    e.call("entry_template.put", json!({"book":b,"template":changed}));
    e.ws().undo(&dr_workspace::Actor::User).unwrap();
    assert_eq!(tpl(&e, &b, "tpl-chapter"), original);
    let mut changed = original;
    changed["modules"][0]["name"] = json!("Writable again");
    e.call("entry_template.put", json!({"book":b,"template":changed}));
    assert_eq!(
        tpl(&e, &b, "tpl-chapter")["modules"][0]["name"],
        "Writable again"
    );
}
#[test]
fn v3_invalid_initial_body_leaves_no_documents_and_fault_keeps_no_dangling_entry() {
    let e = env();
    let b = project(&e);
    let ms = root(&e, &b, "tpl-manuscript");
    let count = e.ws().library().docs(Some(&b), None).unwrap().len();
    let before = entries(&e, &b);
    assert!(
        e.try_call(
            "entry.create",
            json!({"book":b,"parent":ms,"title":"bad","bodies":{"mod-prose":"\u{fffc}"}})
        )
        .is_err()
    );
    assert_eq!(count, e.ws().library().docs(Some(&b), None).unwrap().len());
    assert_eq!(before, entries(&e, &b));
    e.faults.arm("after_prose");
    assert!(
        e.try_call(
            "entry.create",
            json!({"book":b,"parent":ms,"title":"fault","bodies":{"mod-prose":"Synthetic orphan"}})
        )
        .is_err()
    );
    assert_eq!(before, entries(&e, &b));
    assert_eq!(
        count + 1,
        e.ws().library().docs(Some(&b), None).unwrap().len()
    );
    e.call(
        "entry.create",
        json!({"book":b,"parent":ms,"title":"retry","bodies":{"mod-prose":"Synthetic retry"}}),
    );
    assert_eq!(
        entries(&e, &b).as_array().unwrap().len(),
        before.as_array().unwrap().len() + 1
    );
}
#[test]
fn v3_history_handles_parent_reversal_without_transient_cycles() {
    let e = env();
    let b = project(&e);
    let ms = root(&e, &b, "tpl-manuscript");
    let a = create(&e, &b, &ms, "A", "tpl-group");
    let z = create(&e, &b, &a, "Z", "tpl-group");
    let at = version(&e, &b);
    e.call("entry.move", json!({"book":b,"id":z,"parent":ms}));
    e.call("entry.move", json!({"book":b,"id":a,"parent":z}));
    e.call("entry_history.restore",json!({"book":b,"at":at,"targets":[{"collection":"entries","id":z},{"collection":"entries","id":a}]}));
    assert_eq!(get(&e, &b, &a)["parent"], ms);
    assert_eq!(get(&e, &b, &z)["parent"], a);
}
#[test]
fn v3_multiple_prose_modules_copy_blocks_independently_and_trash_keeps_prior_trash() {
    let e = env();
    let b = project(&e);
    let ms = root(&e, &b, "tpl-manuscript");
    let module = json!({"id":"second-prose","kind":"prose","name":"正文"});
    e.call(
        "entry_template.put_module",
        json!({"book":b,"template":"tpl-chapter","module":module}),
    );
    for m in ["mod-prose", "second-prose"] {
        e.call("module.set_prose",json!({"book":b,"owner":"tpl-chapter","module":m,"template":true,"paragraphs":[{"text":"Synthetic shared starter"}]}));
    }
    let group = create(&e, &b, &ms, "Group", "tpl-group");
    let a = create(&e, &b, &group, "A", "tpl-chapter");
    let z = create(&e, &b, &group, "Z", "tpl-chapter");
    let mut ids = std::collections::BTreeSet::new();
    for owner in [&a, &z] {
        for module in ["mod-prose", "second-prose"] {
            let body = e.out(
                "module.read_prose",
                json!({"book":b,"owner":owner,"module":module}),
            );
            assert_eq!(body["paragraphs"][0]["text"], "Synthetic shared starter");
            assert!(
                ids.insert(
                    body["paragraphs"][0]["block_id"]
                        .as_str()
                        .unwrap()
                        .to_owned()
                )
            );
        }
    }
    e.call("entry.trash", json!({"book":b,"id":a}));
    let old = get(&e, &b, &a);
    e.call("entry.trash", json!({"book":b,"id":group}));
    assert_eq!(get(&e, &b, &a), old);
    e.ws().undo(&dr_workspace::Actor::User).unwrap();
    assert!(get(&e, &b, &z)["deleted_at"].is_null());
    assert_eq!(get(&e, &b, &a), old);
}

#[test]
fn v3_content_modules_roundtrip_and_restore_independently() {
    let e = env();
    let b = project(&e);
    let ms = root(&e, &b, "tpl-manuscript");
    for (id, kind) in [
        ("test-patches", "patches"),
        ("test-grid", "plot_grid"),
        ("test-relations", "relations"),
    ] {
        e.call(
            "entry_template.put_module",
            json!({"book":b,"template":"tpl-chapter","module":{"id":id,"kind":kind,"name":id}}),
        );
    }
    let a = create(&e, &b, &ms, "A", "tpl-chapter");
    let z = create(&e, &b, &ms, "Z", "tpl-chapter");
    let target = |module: &str| json!({"book":b,"entry":a,"module":module});
    let patch=e.out("module.put_patch",json!({"book":b,"entry":a,"module":"test-patches","title":"Synthetic patch","body":"Before"}))["id"].as_str().unwrap().to_owned();
    e.call(
        "module.put_patch",
        json!({"book":b,"entry":a,"module":"test-patches","id":patch,"title":null,"body":"After"}),
    );
    e.ws().undo(&dr_workspace::Actor::User).unwrap();
    assert_eq!(
        e.out("module.read", target("test-patches"))["patches"][0]["body"],
        "Before"
    );
    e.call("module.put_patch",json!({"book":b,"entry":a,"module":"test-patches","id":patch,"title":null,"body":"Writable after restore"}));
    let mut grid = e.out("module.read", target("test-grid"))["grid"].clone();
    assert_eq!(grid["rows"].as_array().unwrap().len(), 3);
    grid["cells"] = json!([{"row":grid["rows"][0]["id"],"column":grid["columns"][0]["id"],"text":"Synthetic cell"}]);
    e.call(
        "module.put_grid",
        json!({"book":b,"entry":a,"module":"test-grid","grid":grid}),
    );
    assert_eq!(
        e.out("module.read", target("test-grid"))["grid"]["cells"][0]["text"],
        "Synthetic cell"
    );
    e.ws().undo(&dr_workspace::Actor::User).unwrap();
    assert!(
        e.out("module.read", target("test-grid"))["grid"]["cells"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    e.call("entry_relation_type.put",json!({"book":b,"definition":{"id":"test-relation","name":"Synthetic association","source_kinds":["entry"],"target_kinds":["entry"],"source_templates":["tpl-chapter"],"target_templates":["tpl-chapter"]}}));
    let request = json!({"book":b,"entry":a,"module":"test-relations","other":{"kind":"entry","id":z},"relation_type":"test-relation"});
    let r = e.out("module.put_relation", request.clone());
    assert_eq!(e.out("module.put_relation", request), r);
    assert_eq!(
        e.out("module.read", target("test-relations"))["relations"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(
        e.try_call(
            "entry_relation_type.delete",
            json!({"book":b,"id":"test-relation"})
        )
        .is_err()
    );
    e.call(
        "module.remove_relation",
        json!({"book":b,"entry":a,"module":"test-relations","id":r["id"]}),
    );
    e.ws().undo(&dr_workspace::Actor::User).unwrap();
    assert_eq!(
        e.out("module.read", target("test-relations"))["relations"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        e.out("module.read", target("test-patches"))["patches"][0]["body"],
        "Writable after restore"
    );
}
#[test]
fn v3_autolinks_use_memberships_and_invalidate_after_alias_edits() {
    let e = env();
    let b = project(&e);
    let ms = root(&e, &b, "tpl-manuscript");
    let host = e.out(
        "entry.create",
        json!({"book":b,"title":"External names","template":"tpl-group"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    e.call(
        "entry.update",
        json!({"book":b,"id":host,"overrides":{"accept":true,"auto_link":true}}),
    );
    let person = e.out(
        "entry.create",
        json!({"book":b,"title":"Synthetic Person","template":"tpl-character"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    e.call(
        "membership.add",
        json!({"book":b,"host":host,"member":person}),
    );
    let chapter = create(&e, &b, &ms, "Draft", "tpl-chapter");
    e.call("module.set_prose",json!({"book":b,"owner":chapter,"module":"mod-prose","paragraphs":[{"text":"placeholder"}]}));
    let read = e.out(
        "module.read_prose",
        json!({"book":b,"owner":chapter,"module":"mod-prose"}),
    );
    let block = read["paragraphs"][0]["block_id"].clone();
    for (old, new) in [("placeholder", "FirstAlias"), ("FirstAlias", "SecondAlias")] {
        e.call(
            "module.set_field",
            json!({"book":b,"entry":person,"module":"mod-fields","field":"aliases","value":[new]}),
        );
        e.ws().call(&dr_workspace::Actor::Import,"module.replace_prose",json!({"book":b,"owner":chapter,"module":"mod-prose","block_id":block,"find":old,"replace":new})).unwrap();
        let doc = dr_model::DocId::parse(&format!("body:{chapter}/mod-prose")).unwrap();
        let state = e.ws().library().load_copy(&doc.to_string()).unwrap();
        let p = dr_doc::prose::ProseReader::from_loro(doc, &state).unwrap();
        assert!(
            p.view()
                .paragraphs()
                .flat_map(|p| p.runs)
                .flat_map(|r| r.marks.entities)
                .any(|l| l.target == person && l.kind == dr_model::kind::EntityKind::Entry)
        );
    }
    let duplicate = e.out(
        "entry.create",
        json!({"book":b,"title":"SecondAlias","template":"tpl-character"}),
    )["id"]
        .clone();
    assert!(
        e.try_call(
            "membership.add",
            json!({"book":b,"host":host,"member":duplicate})
        )
        .is_err()
    );
}
#[test]
fn v3_workspace_purge_keeps_the_other_book_and_legacy_commands_refuse_v3() {
    let e = env();
    let b = project(&e);
    let c = project(&e);
    let before = e
        .ws()
        .library()
        .docs(Some(&c), None)
        .unwrap()
        .into_iter()
        .map(|d| d.doc_id)
        .collect::<std::collections::BTreeSet<_>>();
    assert!(
        e.try_call(
            "chapter.create",
            json!({"book":b,"title":"must not create a node"})
        )
        .is_err()
    );
    e.call("book.trash", json!({"book":b}));
    e.call("book.purge", json!({"book":b}));
    let after = e
        .ws()
        .library()
        .docs(Some(&c), None)
        .unwrap()
        .into_iter()
        .map(|d| d.doc_id)
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(before, after);
    assert!(e.ws().library().docs(Some(&b), None).unwrap().is_empty());
}

#[test]
fn v3_retained_module_queries_find_content_after_template_removal() {
    let e = env();
    let b = project(&e);
    let ms = root(&e, &b, "tpl-manuscript");
    let a = create(&e, &b, &ms, "A", "tpl-chapter");
    e.call("module.set_prose",json!({"book":b,"owner":a,"module":"mod-prose","paragraphs":[{"text":"Synthetic retained text"}]}));
    e.call(
        "entry_template.remove_module",
        json!({"book":b,"template":"tpl-chapter","module":"mod-prose"}),
    );
    let modules = e.out("module.list", json!({"book":b,"id":a}));
    let prose = modules
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == "mod-prose")
        .unwrap();
    assert_eq!(prose["retained"], true);
    assert!(prose["prose_doc"].as_str().unwrap().contains(&a));
    assert_eq!(
        e.out(
            "module.read_prose",
            json!({"book":b,"owner":a,"module":"mod-prose"})
        )["paragraphs"][0]["text"],
        "Synthetic retained text"
    );
    assert!(
        e.out(
            "module.read",
            json!({"book":b,"entry":a,"module":"mod-prose"})
        )["module"]["definition"]
            .is_null()
    );
    assert!(
        e.try_call(
            "module.prose_document",
            json!({"book":b,"owner":a,"module":"never-declared"})
        )
        .is_err()
    );
}

#[test]
fn v3_initial_prose_links_names_and_new_module_copies_template_on_first_open() {
    let e = env();
    let b = project(&e);
    let ms = root(&e, &b, "tpl-manuscript");
    let cat = entries(&e, &b)
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["overrides"]["default_template"] == "tpl-character")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let person = create(&e, &b, &cat, "Synthetic Name", "tpl-character");
    let a=e.ws().call(&dr_workspace::Actor::Import,"entry.create",json!({"book":b,"parent":ms,"title":"Synthetic draft","bodies":{"mod-prose":"Synthetic Name enters"}})).unwrap()["output"]["id"].as_str().unwrap().to_owned();
    let doc = dr_model::DocId::parse(&format!("body:{a}/mod-prose")).unwrap();
    let state = e.ws().library().load_copy(&doc.to_string()).unwrap();
    let p = dr_doc::prose::ProseReader::from_loro(doc, &state).unwrap();
    assert!(
        p.view()
            .paragraphs()
            .flat_map(|p| p.runs)
            .flat_map(|r| r.marks.entities)
            .any(|l| l.target == person)
    );
    e.call("entry_template.put_module",json!({"book":b,"template":"tpl-chapter","module":{"id":"later-prose","kind":"prose","name":"Later"}}));
    e.call("module.set_prose",json!({"book":b,"owner":"tpl-chapter","module":"later-prose","template":true,"paragraphs":[{"text":"Later starter"}]}));
    e.call(
        "module.prose_document",
        json!({"book":b,"owner":a,"module":"later-prose"}),
    );
    assert_eq!(
        e.out(
            "module.read_prose",
            json!({"book":b,"owner":a,"module":"later-prose"})
        )["paragraphs"][0]["text"],
        "Later starter"
    );
}

#[test]
fn v3_restore_primary_pins_and_record_deletion_have_real_inverses() {
    let e = env();
    let b = project(&e);
    let ms = root(&e, &b, "tpl-manuscript");
    let ls = root(&e, &b, "tpl-storylines");
    let a = create(&e, &b, &ms, "A", "tpl-chapter");
    let lane = create(&e, &b, &ls, "Lane", "tpl-storyline");
    e.call("entry.trash", json!({"book":b,"id":a}));
    e.call("entry.restore", json!({"book":b,"id":a}));
    assert!(get(&e, &b, &a)["deleted_at"].is_null());
    e.call(
        "membership.add",
        json!({"book":b,"host":lane,"member":a,"pos":"a1"}),
    );
    e.call(
        "membership.primary",
        json!({"book":b,"member":a,"host":lane}),
    );
    assert_eq!(get(&e, &b, &a)["primary"], lane);
    let membership = e.out("membership.list", json!({"book":b}));
    e.call("timeline_view.put",json!({"book":b,"view":{"id":"test-view","name":"Synthetic view","lanes":[{"entry":lane}]}}));
    e.call(
        "timeline_view.place",
        json!({"book":b,"view":"test-view","entry":a,"lane":lane,"at":3.0}),
    );
    assert_eq!(e.out("membership.list", json!({"book":b})), membership);
    e.call("timeline_view.put_pin",json!({"book":b,"view":"test-view","pin":{"id":"pin","at":-2.0,"label":"Synthetic pin","entry":a}}));
    let view = || {
        e.out("timeline_view.list", json!({"book":b}))
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == "test-view")
            .unwrap()
            .clone()
    };
    assert_eq!(view()["pins"][0]["entry"], a);
    e.call(
        "timeline_view.remove_pin",
        json!({"book":b,"view":"test-view","pin":"pin"}),
    );
    assert!(view()["pins"].as_array().unwrap().is_empty());
    e.ws().undo(&dr_workspace::Actor::User).unwrap();
    assert_eq!(view()["pins"][0]["label"], "Synthetic pin");
    e.call("timeline_view.delete", json!({"book":b,"id":"test-view"}));
    assert!(!view()["deleted_at"].is_null());
    e.ws().undo(&dr_workspace::Actor::User).unwrap();
    assert!(view()["deleted_at"].is_null());
    assert_eq!(get(&e, &b, &a)["parent"], ms);
    e.call(
        "entry_relation_type.put",
        json!({"book":b,"definition":{"id":"unused","name":"Synthetic unused type"}}),
    );
    let types = e.out("entry_relation_type.list", json!({"book":b}));
    let locked = types
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["locked"] == true)
        .unwrap()["id"]
        .clone();
    assert!(
        e.try_call("entry_relation_type.delete", json!({"book":b,"id":locked}))
            .is_err()
    );
    e.call(
        "entry_relation_type.delete",
        json!({"book":b,"id":"unused"}),
    );
    assert!(
        !ids(&e.out("entry_relation_type.list", json!({"book":b}))).contains(&"unused".to_owned())
    );
    e.ws().undo(&dr_workspace::Actor::User).unwrap();
    assert!(
        ids(&e.out("entry_relation_type.list", json!({"book":b}))).contains(&"unused".to_owned())
    );
    for (id, kind) in [("test-kv", "kv"), ("test-patch", "patches")] {
        e.call(
            "entry_template.put_module",
            json!({"book":b,"template":"tpl-chapter","module":{"id":id,"kind":kind,"name":id}}),
        );
    }
    e.call(
        "module.put_kv",
        json!({"book":b,"entry":a,"module":"test-kv","row":{"id":"row","key":"K","value":"V"}}),
    );
    e.call(
        "module.remove_kv",
        json!({"book":b,"entry":a,"module":"test-kv","row":"row"}),
    );
    assert!(
        e.out(
            "module.read",
            json!({"book":b,"entry":a,"module":"test-kv"})
        )["kv"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    e.ws().undo(&dr_workspace::Actor::User).unwrap();
    assert_eq!(
        e.out(
            "module.read",
            json!({"book":b,"entry":a,"module":"test-kv"})
        )["kv"][0]["value"],
        "V"
    );
    let patch = e.out(
        "module.put_patch",
        json!({"book":b,"entry":a,"module":"test-patch","title":null,"body":"Synthetic patch"}),
    )["id"]
        .clone();
    e.call(
        "module.remove_patch",
        json!({"book":b,"entry":a,"module":"test-patch","id":patch}),
    );
    assert!(
        e.out(
            "module.read",
            json!({"book":b,"entry":a,"module":"test-patch"})
        )["patches"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    e.ws().undo(&dr_workspace::Actor::User).unwrap();
    assert_eq!(
        e.out(
            "module.read",
            json!({"book":b,"entry":a,"module":"test-patch"})
        )["patches"][0]["body"],
        "Synthetic patch"
    );
}

#[test]
fn v3_level_batch_matches_individual_queries_and_reports_canonical_sources() {
    let e = env();
    let b = project(&e);
    let other = project(&e);
    let ms = root(&e, &b, "tpl-manuscript");
    let group = create(&e, &b, &ms, "Group", "tpl-group");
    create(&e, &b, &group, "One", "tpl-chapter");
    let lines = root(&e, &b, "tpl-storylines");
    let lane = create(&e, &b, &lines, "Lane", "tpl-storyline");
    e.call(
        "entry.update",
        json!({"book":b,"id":group,"overrides":{"home":null,"auto_link":false}}),
    );
    let batch = e.out("level.list", json!({"book":b}));
    assert_eq!(batch["version"], version(&e, &b));
    let levels = batch["levels"].as_array().unwrap();
    let templates = e.out("entry_template.list", json!({"book":b}));
    let level_templates: Vec<_> = templates
        .as_array()
        .unwrap()
        .iter()
        .filter(|t| t["kind"] == "level")
        .map(|t| t["id"].clone())
        .collect();
    let expected: Vec<_> = entries(&e, &b)
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| {
            e["deleted_at"].is_null()
                && (e["template"].is_null() || level_templates.contains(&e["template"]))
        })
        .map(|e| e["id"].clone())
        .collect();
    assert_eq!(
        levels.iter().map(|r| r["id"].clone()).collect::<Vec<_>>(),
        expected
    );
    for row in levels {
        let single = e.out("level.get", json!({"book":b,"id":row["id"]}));
        for field in ["settings", "children", "members"] {
            assert_eq!(row[field], single[field]);
        }
        assert_eq!(row["sources"].as_object().unwrap().len(), 8);
    }
    let g = levels.iter().find(|r| r["id"] == group).unwrap();
    assert_eq!(g["settings"]["home"], Value::Null);
    assert_eq!(
        g["sources"]["home"],
        json!({"kind":"override","entry":group})
    );
    assert_eq!(
        g["sources"]["is_manuscript"],
        json!({"kind":"template","entry":ms,"template":"tpl-manuscript"})
    );
    let l = levels.iter().find(|r| r["id"] == lane).unwrap();
    assert_eq!(
        l["sources"]["accept"],
        json!({"kind":"lane","entry":lane,"template":"tpl-storyline"})
    );
    assert_eq!(l["settings"]["accept"], true);
    let second = e.out("level.list", json!({"book":other}));
    assert!(
        !second["levels"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["id"] == group)
    );
    e.call("entry.trash", json!({"book":b,"id":group}));
    let after = e.out("level.list", json!({"book":b}));
    assert_ne!(batch["version"], after["version"]);
    assert!(
        !after["levels"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["id"] == group)
    );
    assert!(e.try_call("level.list", json!({"book":e.book()})).is_err());
}
