//! DW (`handoff/v5-tracks.md` items 8 and 9; `project-templates.md` §7,
//! §12, §13; contract `WORKING-COPY-LOCAL`): `project_template.save` takes
//! the words for the Agent and keeps a replaced template's name and
//! description; a template is edited in a working copy (a temporary
//! project) that is made the way `project.create` makes a project, stays
//! out of the lists, records no writing days, never syncs, and saves every
//! change over its template by itself (author 2026-11-15 night: 「改了什么就
//! 自动保存」); a copy left behind is used again or cleared, never losing a
//! change.
mod common;
use common::*;

use dr_model::project_template::StoredTemplateOrigin;
use dr_workspace::Actor;
use dr_workspace::commands::v3::project_template::store_project_template_value;
use serde_json::{Value, json};

fn id(v: &Value) -> String {
    v["id"].as_str().unwrap().to_owned()
}

fn save(e: &Env, input: Value) -> Value {
    e.out("project_template.save", input)
}

fn value(e: &Env, template: &str) -> Value {
    e.out("project_template.get", json!({"id": template}))["value"].clone()
}

fn titles(e: &Env, b: &str) -> Vec<String> {
    e.out("entry.list", json!({"book": b, "all": true}))
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["title"].as_str().unwrap().to_owned())
        .collect()
}

fn listed(e: &Env, name: &str) -> Vec<String> {
    e.out(name, json!({"trashed": true}))
        .as_array()
        .unwrap()
        .iter()
        .map(|b| {
            b["id"]
                .as_str()
                .or_else(|| b["info"]["id"].as_str())
                .unwrap()
                .to_owned()
        })
        .collect()
}

fn root(e: &Env, b: &str, template: &str) -> String {
    acceptance::novel_root(e.ws(), &b, template)
}

/// Words for the Agent given to the save go into the template only; the
/// project keeps its own. Without them the project's are taken.
#[test]
fn the_agents_words_given_to_a_save_go_into_the_template_only() {
    let e = env();
    let b = e.book();
    let before = e.out("project.get", json!({"book": b}))["agent"].clone();
    assert!(before.is_object());
    let words =
        json!({"name": "模板里的", "description": "只在模板里", "instructions": "照模板做"});
    let t = id(&save(
        &e,
        json!({"book": b, "name": "带话", "agent": words}),
    ));
    assert_eq!(value(&e, &t)["project"]["agent"], words);
    assert_eq!(e.out("project.get", json!({"book": b}))["agent"], before);

    let plain = id(&save(&e, json!({"book": b, "name": "不带话"})));
    assert_eq!(value(&e, &plain)["project"]["agent"], before);

    let none = id(&save(
        &e,
        json!({"book": b, "name": "不要话", "agent": null}),
    ));
    assert!(value(&e, &none)["project"].get("agent").is_none());
    assert_eq!(e.out("project.get", json!({"book": b}))["agent"], before);
}

/// Replacing a template without a name or a description keeps the ones it
/// had; only a new template needs a name.
#[test]
fn replacing_without_a_name_keeps_the_templates_name_and_description() {
    let e = env();
    let b = e.book();
    let first = save(
        &e,
        json!({"book": b, "name": "原来的名字", "description": "原来的描述"}),
    );
    let t = id(&first);
    assert_eq!(first["revision"], 1);
    let again = save(&e, json!({"book": b, "replace": t}));
    assert_eq!(again["id"], t);
    assert_eq!(again["revision"], 2);
    assert_eq!(again["name"], "原来的名字");
    assert_eq!(again["description"], "原来的描述");
    assert_eq!(value(&e, &t)["name"], "原来的名字");

    let renamed = save(&e, json!({"book": b, "replace": t, "name": "新名字"}));
    assert_eq!(renamed["name"], "新名字");
    assert_eq!(renamed["description"], "原来的描述");

    assert!(
        e.try_call("project_template.save", json!({"book": b}))
            .is_err(),
        "a new template needs a name"
    );
}

/// Editing a template makes a working copy the way `project.create` makes
/// a project from that template, named and described as the template; it
/// remembers what it edits and is in none of the lists.
#[test]
fn a_working_copy_is_made_like_a_project_and_kept_out_of_the_lists() {
    let e = env();
    let source = e.book();
    let t = id(&save(
        &e,
        json!({"book": source, "name": "双线长篇", "description": "两条线"}),
    ));
    let made = e.out(
        "project.create",
        json!({"name": "照模板建", "template_id": t}),
    );
    let copy = e.out("project_template.edit", json!({"id": t}));
    let w = copy["book"].as_str().unwrap().to_owned();
    assert_eq!(copy["template"], t);
    assert_eq!(copy["name"], "双线长篇");

    assert_eq!(titles(&e, &w), titles(&e, &id(&made)));
    let meta = e.out("book.get", json!({"book": w}));
    assert_eq!(meta["name"], "双线长篇");
    assert_eq!(meta["summary"], "两条线");
    assert_eq!(
        e.out("project.get", json!({"book": w}))["editing_template"],
        t
    );
    assert!(e.out("project.get", json!({"book": source}))["editing_template"].is_null());

    for list in ["book.list", "book.shelf"] {
        let books = listed(&e, list);
        assert!(!books.contains(&w), "{list} lists the working copy");
        assert!(books.contains(&source), "{list} lost a project");
    }
    let copies = e.out("project_template.working_copies", json!({}));
    assert_eq!(copies.as_array().unwrap().len(), 1);
    assert_eq!(copies[0]["book"], w);
    assert_eq!(copies[0]["template"], t);
    assert!(e.ws().is_working_copy(&w).unwrap());
    assert!(!e.ws().is_working_copy(&source).unwrap());
}

/// Typing in a working copy records no writing day.
#[test]
fn a_working_copy_records_no_writing_day() {
    let e = env();
    let source = e.book();
    let t = id(&save(&e, json!({"book": source, "name": "模板"})));
    let w = e.out("project_template.edit", json!({"id": t}))["book"]
        .as_str()
        .unwrap()
        .to_owned();
    let device = "device-000000000000000000000001";
    for book in [&source, &w] {
        e.call(
            "writing_day.record",
            json!({"book": book, "device": device, "day": "2026-11-15", "words": 120}),
        );
    }
    let today = |book: &str| {
        e.out(
            "book.writing_days",
            json!({"book": book, "today": "2026-11-15", "days": 1}),
        )["today"]
            .clone()
    };
    assert_eq!(today(&source), 120);
    assert_eq!(today(&w), 0);
}

/// Every change in a working copy saves itself over the template it edits
/// (gathered for a moment; `flush_working_copies` saves what still waits):
/// every live entry with its content, every time pin, the copy's name and
/// profile as the template's name and description, the Agent's words of its
/// definition; one revision more each time, and the template's own history
/// (origin, credit) as it was. An undo is a change like any:
/// the template follows it back. Making the copy saves nothing.
#[test]
fn every_write_in_a_working_copy_lands_in_its_template() {
    let e = env();
    let source = e.book();
    let credit = json!({"author": "某作者"});
    let t = id(&save(
        &e,
        json!({"book": source, "name": "旧名", "description": "旧描述", "credit": credit}),
    ));
    let before = e.out("project_template.get", json!({"id": t}));
    let w = e.out("project_template.edit", json!({"id": t}))["book"]
        .as_str()
        .unwrap()
        .to_owned();
    e.ws().flush_working_copies().unwrap();
    assert_eq!(
        e.out("project_template.get", json!({"id": t}))["summary"]["revision"],
        before["summary"]["revision"],
        "making the copy saves nothing"
    );

    let ideas = root(&e, &w, "tpl-ideas");
    let idea = id(&e.out(
        "entry.create",
        json!({"book": w, "parent": ideas, "template": "tpl-idea", "title": "新构想"}),
    ));
    e.call(
        "module.set_prose",
        json!({"book": w, "owner": idea, "module": "mod-prose", "paragraphs": [{"text": "工作区里写的"}]}),
    );
    let view = e.out("timeline_view.list", json!({"book": w}))[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    e.call(
        "timeline_view.put_pin",
        json!({"book": w, "view": view, "pin": {"id": "pin-dw", "at": 3.0, "label": "钉子"}}),
    );
    e.call(
        "project.update",
        json!({"book": w, "name": "新名", "summary": "新描述",
               "agent": {"name": "工作区", "description": "改过", "instructions": "新的话"}}),
    );
    e.ws().flush_working_copies().unwrap();

    let now = e.out("project_template.get", json!({"id": t}));
    let saved = &now["summary"];
    assert!(saved["revision"].as_i64().unwrap() > before["summary"]["revision"].as_i64().unwrap());
    assert_eq!(saved["name"], "新名");
    assert_eq!(saved["description"], "新描述");
    assert_eq!(saved["origin"], before["summary"]["origin"]);
    let got = &now["value"];
    assert_eq!(got["credit"], before["value"]["credit"]);
    assert_eq!(got["project"]["agent"]["instructions"], "新的话");
    let entry = got["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["title"] == "新构想")
        .expect("the new entry is in the template");
    assert_eq!(
        entry["prose"]["mod-prose"][0]["runs"][0]["text"],
        "工作区里写的"
    );
    assert_eq!(got["views"][0]["pins"][0]["label"], "钉子");
    // The copy is still there, and still out of the lists.
    assert!(e.ws().is_working_copy(&w).unwrap());
    assert!(!listed(&e, "book.list").contains(&w));

    // Undo the last change: the template follows.
    let revision = saved["revision"].as_i64().unwrap();
    e.ws().undo(&Actor::User).unwrap().expect("an undo");
    e.ws().flush_working_copies().unwrap();
    let undone = e.out("project_template.get", json!({"id": t}));
    assert_eq!(undone["summary"]["name"], "旧名");
    assert_eq!(undone["summary"]["revision"], revision + 1);
    assert_ne!(
        undone["value"]["project"]["agent"]["instructions"],
        "新的话"
    );

    // An explicit save of the copy is the same save; with nothing new it
    // changes nothing.
    let again = save(&e, json!({"book": w}));
    assert_eq!(again["id"], t);
    assert_eq!(again["revision"], revision + 1);
}

/// A template that came from a file and has no credit: its working copy
/// saves over it without one and keeps its origin.
#[test]
fn a_working_copy_of_an_imported_template_keeps_its_origin_and_takes_no_credit() {
    let e = env();
    let source = e.book();
    let t = id(&save(&e, json!({"book": source, "name": "来的模板"})));
    let mut imported = value(&e, &t);
    imported["name"] = json!("文件里来的");
    let parsed = dr_model::project_template::parse_project_template_json(
        &serde_json::to_string(&imported).unwrap(),
    )
    .unwrap();
    let file = store_project_template_value(
        e.ws(),
        &Actor::User,
        StoredTemplateOrigin::File,
        &parsed,
        None,
    )
    .unwrap();
    let w = e.out("project_template.edit", json!({"id": file.id}))["book"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        e.out("project.get", json!({"book": w}))["source"]["origin"],
        "file"
    );
    e.call("project.update", json!({"book": w, "summary": "改了简介"}));
    e.ws().flush_working_copies().unwrap();
    let now = e.out("project_template.get", json!({"id": file.id}));
    assert_eq!(now["summary"]["description"], "改了简介");
    assert_eq!(now["summary"]["origin"], "file");
    assert!(now["value"].get("credit").is_none(), "{}", now["value"]);
}

/// A working copy saves everything and only over the template it edits.
#[test]
fn a_working_copy_saves_only_over_its_own_template() {
    let e = env();
    let source = e.book();
    let t = id(&save(&e, json!({"book": source, "name": "甲"})));
    let other = id(&save(&e, json!({"book": source, "name": "乙"})));
    let w = e.out("project_template.edit", json!({"id": t}))["book"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(
        e.try_call(
            "project_template.save",
            json!({"book": w, "replace": other})
        )
        .is_err()
    );
    let ms = root(&e, &w, "tpl-manuscript");
    assert!(
        e.try_call(
            "project_template.save",
            json!({"book": w, "exclude_skeleton": [ms]})
        )
        .is_err()
    );
    assert_eq!(value(&e, &other)["name"], "乙");
}

fn edit(e: &Env, template: &str) -> String {
    e.out("project_template.edit", json!({"id": template}))["book"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn copies(e: &Env) -> Vec<String> {
    e.out("project_template.working_copies", json!({}))
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["book"].as_str().unwrap().to_owned())
        .collect()
}

/// Write the copy's name straight into its book while no workspace is open
/// (what is left when the App stopped before a write was saved).
fn rename_while_closed(e: &mut Env, book: &str, name: &str) {
    e.close_for_raw();
    let lib = dr_store::Library::open(e.dir.path(), dr_workspace::library_options("test")).unwrap();
    let name = name.to_owned();
    lib.open_doc(&format!("book:{book}"), dr_store::OpenDoc::Existing)
        .unwrap()
        .write(dr_store::Origin::User, move |doc| {
            doc.get_map("meta").insert("name", name.as_str()).unwrap();
        })
        .unwrap();
    lib.close().unwrap();
    e.open_again();
}

/// A working copy left when the App quit is listed after the library opens
/// again, and editing the same template uses it again: its writes are in
/// the template already (the workspace saved them on the way out).
#[test]
fn a_working_copy_left_behind_is_used_again() {
    let mut e = env();
    let source = e.book();
    let t = id(&save(&e, json!({"book": source, "name": "模板"})));
    let w = edit(&e, &t);
    e.call(
        "project.update",
        json!({"book": w, "summary": "退出前改的"}),
    );
    e.reopen();
    assert_eq!(copies(&e), vec![w.clone()]);
    assert!(!listed(&e, "book.list").contains(&w));
    assert_eq!(value(&e, &t)["description"], "退出前改的");
    assert_eq!(edit(&e, &t), w);
    assert_eq!(copies(&e), vec![w]);
}

/// A write the App did not get to save (it stopped first) goes over the
/// template when the template is edited again, and that copy is used.
#[test]
fn a_write_left_unsaved_goes_over_the_template_when_it_is_edited_again() {
    let mut e = env();
    let source = e.book();
    let t = id(&save(&e, json!({"book": source, "name": "模板"})));
    let w = edit(&e, &t);
    rename_while_closed(&mut e, &w, "没来得及存的名字");
    assert_eq!(value(&e, &t)["name"], "模板");
    assert_eq!(edit(&e, &t), w);
    assert_eq!(value(&e, &t)["name"], "没来得及存的名字");
}

/// The template moved on elsewhere (another device, a save from another
/// project): a copy with nothing of its own is cleared and a fresh one made
/// from the template as it is; a copy holding a change the template does
/// not have stays, listed, beside the fresh one.
#[test]
fn a_copy_the_template_moved_past_is_cleared_unless_it_holds_a_change() {
    let mut e = env();
    let source = e.book();
    let t = id(&save(&e, json!({"book": source, "name": "模板"})));
    let w = edit(&e, &t);
    e.ws().flush_working_copies().unwrap();
    save(
        &e,
        json!({"book": source, "replace": t, "description": "别处改的"}),
    );
    let fresh = edit(&e, &t);
    assert_ne!(fresh, w);
    assert_eq!(copies(&e), vec![fresh.clone()]);
    assert!(e.ws().library().docs(Some(&w), None).unwrap().is_empty());
    assert_eq!(
        e.out("book.get", json!({"book": fresh}))["summary"],
        "别处改的"
    );

    // Now the copy holds a change of its own, and the template moves again.
    rename_while_closed(&mut e, &fresh, "这边改的");
    save(
        &e,
        json!({"book": source, "replace": t, "description": "又在别处改"}),
    );
    let third = edit(&e, &t);
    assert_ne!(third, fresh);
    assert_eq!(copies(&e), vec![fresh.clone(), third]);
    assert_eq!(
        e.out("book.get", json!({"book": fresh}))["name"],
        "这边改的"
    );
    assert_eq!(value(&e, &t)["description"], "又在别处改");
}
