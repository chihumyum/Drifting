//! One kind of entry with a switch for what lives below it
//! (`docs/rust-rewrite/kernel-v4.md`): the switch's default, turning it off,
//! and the command layer refusing only the violations a write itself makes.
mod common;
use common::*;
use dr_workspace::{Actor, RecordKey, Workspace, WritePreconditions, WsError};
use loro::ExportMode;
use serde_json::{Value, json};

fn root(e: &Env, b: &str, t: &str) -> String {
    acceptance::novel_root(e.ws(), &b, t)
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
fn rows(e: &Env, b: &str) -> Vec<Value> {
    e.out("entry.list", json!({"book":b,"all":true,"trashed":true}))
        .as_array()
        .unwrap()
        .clone()
}
fn roots(e: &Env, b: &str) -> Vec<String> {
    rows(e, b)
        .into_iter()
        .filter(|r| r["parent"].is_null())
        .map(|r| r["id"].as_str().unwrap().to_owned())
        .collect()
}
fn category(e: &Env, b: &str, title: &str) -> String {
    acceptance::entries_by_template(e.ws(), &b, "tpl-category")
        .into_iter()
        .find(|c| c["title"] == title)
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned()
}
fn template(e: &Env, b: &str, id: &str) -> Value {
    e.out("entry_template.list", json!({"book":b}))
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == id)
        .unwrap()
        .clone()
}
fn refused(e: &Env, name: &str, input: Value, invariant: &str) {
    match e.try_call(name, input.clone()) {
        Err(WsError::Violation(v)) => assert_eq!(v.invariant, invariant, "{name} {input}"),
        other => panic!("{name} {input}: expected {invariant}, got {other:?}"),
    }
}
/// Every stored document of `from`, the book first, imported into `to` as
/// another device's sync would.
fn sync(from: &Workspace, to: &Workspace) {
    let mut docs = from.library().docs(None, None).unwrap();
    docs.sort_by_key(|d| (d.kind != "book", d.doc_id.clone()));
    for d in docs {
        if from.library().head(&d.doc_id).unwrap().is_none() {
            continue;
        }
        let bytes = from
            .library()
            .load_copy(&d.doc_id)
            .unwrap()
            .export(ExportMode::all_updates())
            .unwrap();
        to.import_remote(
            &d.doc_id,
            Some((&d.kind, d.book_id.as_deref().unwrap_or(""))),
            bytes,
            &Actor::Sync,
        )
        .unwrap();
    }
}

#[test]
fn the_switch_starts_from_the_template_and_never_follows_it_afterwards() {
    let e = env();
    let b = e.book();
    let ms = root(&e, &b, "tpl-manuscript");
    // The template's default: a chapter starts off, a group on.
    let chapter = create(&e, &b, &ms, "第一章", "tpl-chapter");
    let group = create(&e, &b, &ms, "第一卷", "tpl-group");
    assert_eq!(get(&e, &b, &chapter)["level"], false);
    assert_eq!(get(&e, &b, &group)["level"], true);
    assert!(get(&e, &b, &chapter)["below"].is_null());
    assert_eq!(get(&e, &b, &group)["below"]["children"], json!([]));
    // entry.create may say otherwise.
    let open = e.out(
        "entry.create",
        json!({"book":b,"parent":ms,"title":"第二章","template":"tpl-chapter","level":true}),
    )["id"]
        .clone();
    assert_eq!(get(&e, &b, open.as_str().unwrap())["level"], true);
    // A template's default changes nothing that exists; new entries follow it.
    let mut t = template(&e, &b, "tpl-chapter");
    assert_eq!(t["level"], false);
    t["level"] = json!(true);
    e.call("entry_template.put", json!({"book":b,"template":t}));
    assert_eq!(get(&e, &b, &chapter)["level"], false);
    let later = create(&e, &b, &ms, "第三章", "tpl-chapter");
    assert_eq!(get(&e, &b, &later)["level"], true);
    // Switching templates keeps the switch either way.
    e.call(
        "entry.update",
        json!({"book":b,"id":group,"template":"tpl-idea"}),
    );
    assert_eq!(get(&e, &b, &group)["level"], true);
    e.call(
        "entry.update",
        json!({"book":b,"id":chapter,"template":"tpl-group"}),
    );
    assert_eq!(get(&e, &b, &chapter)["level"], false);
    // An entry whose switch is off takes no overrides, and nothing lives under it.
    assert!(
        e.try_call(
            "entry.update",
            json!({"book":b,"id":chapter,"overrides":{"auto_link":true}}),
        )
        .is_err()
    );
    refused(
        &e,
        "entry.create",
        json!({"book":b,"parent":chapter,"title":"子条目","template":"tpl-chapter"}),
        "V3-LEAF-NO-CHILDREN",
    );
    refused(
        &e,
        "entry.move",
        json!({"book":b,"id":later,"parent":chapter}),
        "V3-LEAF-NO-CHILDREN",
    );
}

#[test]
fn switching_off_moves_direct_children_after_the_top_level_ancestor_in_one_undoable_commit() {
    let e = env();
    let b = e.book();
    let doc = format!("book:{b}");
    let ms = root(&e, &b, "tpl-manuscript");
    let vol = create(&e, &b, &ms, "卷", "tpl-group");
    e.call(
        "entry.update",
        json!({"book":b,"id":vol,"overrides":{"display":"grid"}}),
    );
    let c1 = create(&e, &b, &vol, "一", "tpl-chapter");
    let c2 = create(&e, &b, &vol, "二", "tpl-chapter");
    e.call("entry.trash", json!({"book":b,"id":c2}));
    let c3 = e.out(
        "entry.create",
        json!({"book":b,"parent":vol,"title":"三","template":"tpl-chapter","level":true}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let c3a = create(&e, &b, &c3, "三之一", "tpl-chapter");
    let roots_before = roots(&e, &b);

    // A caller that read what lies below is held to it: one more entry
    // added since, and the write is refused and writes nothing.
    let keys = [RecordKey::entry(&vol), RecordKey::children_of(Some(&vol))];
    let seen = e.ws().observe_records(&doc, &keys).unwrap();
    let c4 = create(&e, &b, &vol, "四", "tpl-chapter");
    let before = e.ws().observe(&doc).unwrap();
    let off = json!({"book":b,"id":vol,"level":false});
    assert!(matches!(
        e.ws().call_guarded(
            &Actor::User,
            "entry.set_level",
            off.clone(),
            WritePreconditions::from_records(seen)
        ),
        Err(WsError::Conflict(_))
    ));
    assert_eq!(e.ws().observe(&doc).unwrap().version, before.version);

    // Read again and continue: one commit moves every direct child, the
    // trashed one included, in order, right after `书稿`, the top-level
    // entry `vol` lives under.
    let seen = e.ws().observe_records(&doc, &keys).unwrap();
    let out = e
        .ws()
        .call_guarded(
            &Actor::User,
            "entry.set_level",
            off,
            WritePreconditions::from_records(seen),
        )
        .unwrap();
    assert_eq!(
        out["output"]["moved"],
        json!([c1.clone(), c2.clone(), c3.clone(), c4.clone()])
    );
    let fx = effects(&out);
    assert_eq!(fx.iter().filter(|f| *f == "updated entry").count(), 1);
    assert_eq!(fx.iter().filter(|f| *f == "moved entry").count(), 4);
    let mut want = roots_before.clone();
    want.splice(1..1, [c1.clone(), c2.clone(), c3.clone(), c4.clone()]);
    assert_eq!(roots(&e, &b), want);
    // Subtrees go along; the trashed one stays trashed.
    assert_eq!(get(&e, &b, &c3a)["parent"], json!(c3));
    assert!(!get(&e, &b, &c2)["deleted_at"].is_null());
    // `vol` keeps its place and its overrides; nothing reads below it.
    let v = get(&e, &b, &vol);
    assert_eq!(v["level"], false);
    assert_eq!(v["parent"], json!(ms));
    assert_eq!(v["overrides"]["display"], "grid");
    assert!(v["below"].is_null());

    // One undo puts the switch and every child back.
    e.ws().undo(&Actor::User).unwrap();
    assert_eq!(roots(&e, &b), roots_before);
    let v = get(&e, &b, &vol);
    assert_eq!(v["level"], true);
    assert_eq!(
        ids(&v["below"]["children"]),
        vec![c1.clone(), c3.clone(), c4.clone()]
    );
    assert_eq!(get(&e, &b, &c2)["parent"], json!(vol));
    // On again with nothing below: only the switch.
    let empty = create(&e, &b, &ms, "空卷", "tpl-group");
    let out = e.call(
        "entry.set_level",
        json!({"book":b,"id":empty,"level":false}),
    );
    assert_eq!(out["output"]["moved"], json!([]));
    let out = e.call("entry.set_level", json!({"book":b,"id":empty,"level":true}));
    assert_eq!(out["output"]["level"], true);
    assert_eq!(get(&e, &b, &empty)["level"], true);
}

#[test]
fn switching_a_lane_off_hides_it_and_on_brings_it_back() {
    let e = env();
    let b = e.book();
    let lines = root(&e, &b, "tpl-storylines");
    let ms = root(&e, &b, "tpl-manuscript");
    let lane = create(&e, &b, &lines, "主线", "tpl-storyline");
    let ch = create(&e, &b, &ms, "一", "tpl-chapter");
    e.call("membership.add", json!({"book":b,"host":lane,"member":ch}));
    let members = |e: &Env| {
        e.out("membership.list", json!({"book":b}))
            .as_array()
            .unwrap()
            .len()
    };
    assert_eq!(members(&e), 1);
    e.call("entry.set_level", json!({"book":b,"id":lane,"level":false}));
    assert_eq!(members(&e), 0);
    refused(
        &e,
        "membership.add",
        json!({"book":b,"host":lane,"member":ms}),
        "V3-MEMBERSHIP-RULES",
    );
    e.call("entry.set_level", json!({"book":b,"id":lane,"level":true}));
    assert_eq!(members(&e), 1);
}

#[test]
fn a_duplicate_name_a_merge_left_blocks_no_unrelated_write_and_a_rename_resolves_it() {
    let a = env();
    let z = env();
    let b = a.book();
    sync(a.ws(), z.ws());
    let people = category(&a, &b, "人物");
    let ms = root(&a, &b, "tpl-manuscript");
    let chapter = create(&a, &b, &ms, "第一章", "tpl-chapter");
    let other = create(&a, &b, &people, "阿Q", "tpl-character");
    sync(a.ws(), z.ws());
    // Each device names a person 苏竹 while apart.
    let first = create(&a, &b, &people, "苏竹", "tpl-character");
    let second = create(&z, &b, &people, "苏竹", "tpl-character");
    sync(z.ws(), a.ws());
    let marked = [&first, &second]
        .into_iter()
        .filter(|id| !get(&a, &b, id)["name_conflict"].is_null())
        .count();
    assert_eq!(marked, 1, "readers mark the later one");
    // Writes that make no new duplicate go through.
    a.call(
        "entry.update",
        json!({"book":b,"id":chapter,"title":"第一章 序"}),
    );
    a.call(
        "module.set_field",
        json!({"book":b,"entry":other,"module":"mod-fields","field":"aliases","value":["阿桂"]}),
    );
    create(&a, &b, &people, "赵太爷", "tpl-character");
    // A third 苏竹, or an alias claiming it, is new: refused.
    refused(
        &a,
        "entry.create",
        json!({"book":b,"parent":people,"title":"苏竹","template":"tpl-character"}),
        "V3-AUTOLINK-NAME-UNIQUE",
    );
    refused(
        &a,
        "module.set_field",
        json!({"book":b,"entry":other,"module":"mod-fields","field":"aliases","value":["苏竹"]}),
        "V3-AUTOLINK-NAME-UNIQUE",
    );
    // Renaming one of the pair resolves it; renaming the other then passes.
    a.call(
        "entry.update",
        json!({"book":b,"id":second,"title":"苏竹二"}),
    );
    assert!(get(&a, &b, &second)["name_conflict"].is_null());
    assert!(get(&a, &b, &first)["name_conflict"].is_null());
    a.call(
        "entry.update",
        json!({"book":b,"id":first,"title":"苏竹一"}),
    );
}

#[test]
fn a_nested_manuscript_a_merge_left_blocks_no_unrelated_write() {
    let a = env();
    let z = env();
    let b = a.book();
    let ms = root(&a, &b, "tpl-manuscript");
    let chapter = create(&a, &b, &ms, "第一章", "tpl-chapter");
    let appendix = a.out(
        "entry.create",
        json!({"book":b,"title":"附录","template":"tpl-group"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    sync(a.ws(), z.ws());
    // Apart: one device makes 附录 a manuscript of its own (allowed, it is at
    // the root), the other moves it into 书稿 (allowed, it is no manuscript
    // there). Together they make a nested pair.
    z.call(
        "entry.update",
        json!({"book":b,"id":appendix,"overrides":{"is_manuscript":true}}),
    );
    a.call("entry.move", json!({"book":b,"id":appendix,"parent":ms}));
    sync(z.ws(), a.ws());
    let manuscripts = |e: &Env| -> Vec<String> {
        e.out("entry.list", json!({"book":b,"all":true,"below":true}))
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r["below"]["settings"]["is_manuscript"] == true)
            .map(|r| r["id"].as_str().unwrap().to_owned())
            .collect()
    };
    assert_eq!(get(&a, &b, &appendix)["parent"], json!(ms));
    assert!(manuscripts(&a).contains(&appendix));
    // Unrelated writes go through, the nested one too.
    a.call(
        "entry.update",
        json!({"book":b,"id":chapter,"title":"第一章 改"}),
    );
    a.call(
        "entry.update",
        json!({"book":b,"id":appendix,"title":"附录一"}),
    );
    let inner = create(&a, &b, &appendix, "分卷", "tpl-group");
    // Another nested pair is new: refused.
    refused(
        &a,
        "entry.update",
        json!({"book":b,"id":inner,"overrides":{"is_manuscript":true}}),
        "V3-MANUSCRIPT-NO-NEST",
    );
    // Turning the inner manuscript off resolves the old pair.
    a.call(
        "entry.update",
        json!({"book":b,"id":appendix,"overrides":{"is_manuscript":false}}),
    );
    assert!(!manuscripts(&a).contains(&appendix));
}

#[test]
fn writes_that_change_many_entries_refuse_only_the_duplicates_they_make() {
    let e = env();
    let b = e.book();
    let people = category(&e, &b, "人物");
    let ideas = root(&e, &b, "tpl-ideas");
    let person = create(&e, &b, &people, "苏竹", "tpl-character");
    // An idea and a group named 苏竹 claim nothing: ideas do not auto-link
    // under the idea board, groups are not linkable.
    let idea = create(&e, &b, &ideas, "苏竹", "tpl-idea");
    let group = create(&e, &b, &people, "苏竹", "tpl-group");
    // Moving the idea into the category makes it claim the name.
    refused(
        &e,
        "entry.move",
        json!({"book":b,"id":idea,"parent":people}),
        "V3-AUTOLINK-NAME-UNIQUE",
    );
    // So does turning auto-link on for the idea board.
    refused(
        &e,
        "entry.update",
        json!({"book":b,"id":ideas,"overrides":{"auto_link":true}}),
        "V3-AUTOLINK-NAME-UNIQUE",
    );
    // Or making groups linkable.
    let mut t = template(&e, &b, "tpl-group");
    t["linkable"] = json!(true);
    refused(
        &e,
        "entry_template.put",
        json!({"book":b,"template":t}),
        "V3-AUTOLINK-NAME-UNIQUE",
    );
    // Or switching the group to a linkable template.
    refused(
        &e,
        "entry.update",
        json!({"book":b,"id":group,"template":"tpl-character"}),
        "V3-AUTOLINK-NAME-UNIQUE",
    );
    // Restoring a trashed person of the same name, while the first lives.
    e.call("entry.trash", json!({"book":b,"id":person}));
    let again = create(&e, &b, &people, "苏竹", "tpl-character");
    refused(
        &e,
        "entry.restore",
        json!({"book":b,"id":person}),
        "V3-AUTOLINK-NAME-UNIQUE",
    );
    // Nothing was written by any of them; the same writes pass once the
    // name is free.
    e.call(
        "entry.update",
        json!({"book":b,"id":again,"title":"苏竹新"}),
    );
    e.call("entry.restore", json!({"book":b,"id":person}));
    e.call(
        "entry.update",
        json!({"book":b,"id":group,"title":"主要人物"}),
    );
    e.call(
        "entry.update",
        json!({"book":b,"id":group,"template":"tpl-character"}),
    );
}
