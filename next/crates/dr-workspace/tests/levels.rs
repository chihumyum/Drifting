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
    // `tpl-group` takes no entries from elsewhere unless the entry says so
    // (kernel-v5 §16), so with `level == false` neither switch is on: no
    // `below`, before or after switching on to `tpl-idea`, and `overrides`
    // and child residence are refused.
    assert!(get(&e, &b, &chapter)["below"].is_null());
    e.call(
        "entry.update",
        json!({"book":b,"id":chapter,"template":"tpl-idea"}),
    );
    assert!(get(&e, &b, &chapter)["below"].is_null());
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
fn switching_level_off_trashes_live_descendants_in_place_and_restores_in_one_step() {
    let e = env();
    let b = e.book();
    let doc = format!("book:{b}");
    let ms = root(&e, &b, "tpl-manuscript");
    let vol = create(&e, &b, &ms, "卷", "tpl-group");
    e.call(
        "entry.update",
        json!({"book":b,"id":vol,"overrides":{"display":"grid","accept":false}}),
    );
    let c1 = create(&e, &b, &vol, "一", "tpl-chapter");
    let c2 = create(&e, &b, &vol, "二", "tpl-chapter");
    e.call("entry.trash", json!({"book":b,"id":c2}));
    let c2_deleted_before = get(&e, &b, &c2)["deleted_at"].clone();
    assert!(!c2_deleted_before.is_null());
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

    // Read again and continue: one commit trashes every live descendant in place,
    // leaving already-trashed `c2` and every parent pointer untouched.
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
        out["output"]["trashed"],
        json!([c1.clone(), c3.clone(), c3a.clone(), c4.clone()])
    );
    let fx = effects(&out);
    assert_eq!(fx.iter().filter(|f| *f == "updated entry").count(), 1);
    assert_eq!(fx.iter().filter(|f| *f == "trashed entry").count(), 4);
    assert_eq!(roots(&e, &b), roots_before);
    for id in [&c1, &c3, &c4] {
        let row = get(&e, &b, id);
        assert!(!row["deleted_at"].is_null());
        assert_eq!(row["parent"], json!(vol));
    }
    assert!(!get(&e, &b, &c3a)["deleted_at"].is_null());
    assert_eq!(get(&e, &b, &c3a)["parent"], json!(c3));
    assert_eq!(get(&e, &b, &c2)["deleted_at"], c2_deleted_before);
    // `vol` keeps its place and its overrides; with both `level` and `accept` off, `below` is null.
    let v = get(&e, &b, &vol);
    assert_eq!(v["level"], false);
    assert_eq!(v["parent"], json!(ms));
    assert_eq!(v["overrides"]["display"], "grid");
    assert!(v["below"].is_null());

    // One undo puts the switch and every live descendant back, leaving `c2` trashed.
    e.ws().undo(&Actor::User).unwrap();
    assert_eq!(roots(&e, &b), roots_before);
    let v = get(&e, &b, &vol);
    assert_eq!(v["level"], true);
    assert_eq!(
        ids(&v["below"]["children"]),
        vec![c1.clone(), c3.clone(), c4.clone()]
    );
    assert!(get(&e, &b, &c3a)["deleted_at"].is_null());
    assert_eq!(get(&e, &b, &c2)["deleted_at"], c2_deleted_before);
    assert_eq!(get(&e, &b, &c2)["parent"], json!(vol));

    // Turning off the top-level chapter folder (`书稿`) trashes its chapters; restoring one
    // chapter while `书稿` is off relocates it to root (`parent == null`).
    e.call("entry.set_level", json!({"book":b,"id":ms,"level":false}));
    assert!(!get(&e, &b, &c1)["deleted_at"].is_null());
    e.call("entry.restore", json!({"book":b,"id":c1}));
    let restored_c1 = get(&e, &b, &c1);
    assert!(restored_c1["deleted_at"].is_null());
    assert!(restored_c1["parent"].is_null());
    e.ws().undo(&Actor::User).unwrap();
    e.ws().undo(&Actor::User).unwrap();
    assert_eq!(get(&e, &b, &ms)["level"], true);
    assert_eq!(get(&e, &b, &c1)["parent"], json!(vol));

    // On again with nothing below: only the switch.
    let empty = create(&e, &b, &ms, "空卷", "tpl-group");
    let out = e.call(
        "entry.set_level",
        json!({"book":b,"id":empty,"level":false}),
    );
    assert_eq!(out["output"]["trashed"], json!([]));
    let out = e.call("entry.set_level", json!({"book":b,"id":empty,"level":true}));
    assert_eq!(out["output"]["level"], true);
    assert_eq!(get(&e, &b, &empty)["level"], true);
}

#[test]
fn host_accepts_members_and_serves_as_lane_without_level_switch() {
    let e = env();
    let b = e.book();
    let lines = root(&e, &b, "tpl-storylines");
    let ms = root(&e, &b, "tpl-manuscript");
    let lane = create(&e, &b, &lines, "主线", "tpl-storyline");
    assert_eq!(get(&e, &b, &lane)["level"], false);

    // Creating with `host` on a storyline (`level == false`, `accept == true`) places the new
    // chapter in `书稿` (`home`) and joins the storyline as primary host.
    let ch = e.out("entry.create", json!({"book":b,"host":lane,"title":"一"}));
    let ch_id = ch["id"].as_str().unwrap().to_owned();
    assert_eq!(ch["parent"], json!(ms));
    assert_eq!(ch["primary"], json!(lane));
    assert_eq!(ch["template"], "tpl-chapter");

    let members = |e: &Env| {
        e.out("membership.list", json!({"book":b}))
            .as_array()
            .unwrap()
            .len()
    };
    assert_eq!(members(&e), 1);
    assert_eq!(
        ids(&get(&e, &b, &lane)["below"]["members"]),
        vec![ch_id.clone()]
    );

    // A `level == false, accept == true` entry works as swimlane and Tab mount
    // (the book has no start, DW).
    let view = e.out("timeline_view.list", json!({"book":b}))[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    e.call(
        "timeline_view.add_lane",
        json!({"book":b,"view":view,"lane":lane}),
    );
    let tab = e.out(
        "tab.put",
        json!({"book":b,"mount":{"kind":"entry","entry":lane}}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        e.out("project.get", json!({"book":b}))["tabs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["id"] == tab)
            .unwrap()["mount_valid"],
        true
    );

    // Toggling `level` on and off leaves memberships and swimlane intact when `accept == true`.
    e.call("entry.set_level", json!({"book":b,"id":lane,"level":true}));
    e.call("entry.set_level", json!({"book":b,"id":lane,"level":false}));
    assert_eq!(members(&e), 1);

    // Turning `accept` off hides memberships and refuses new ones; clearing the override restores them.
    e.call(
        "entry.update",
        json!({"book":b,"id":lane,"overrides":{"accept":false}}),
    );
    assert_eq!(members(&e), 0);
    refused(
        &e,
        "membership.add",
        json!({"book":b,"host":lane,"member":ms}),
        "V3-MEMBERSHIP-RULES",
    );
    e.call("entry.update", json!({"book":b,"id":lane,"overrides":{}}));
    assert_eq!(members(&e), 1);

    // `accept` does NOT inherit down the tree: a child under `人物` (`tpl-category`, `accept: true`)
    // whose own template (`tpl-character`) does not set `accept` cannot accept memberships even with `level: true`.
    let people = category(&e, &b, "人物");
    let sub = e.out(
        "entry.create",
        json!({"book":b,"parent":people,"title":"子项","template":"tpl-character","level":true}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(get(&e, &b, &sub)["below"]["settings"]["accept"], false);
    refused(
        &e,
        "membership.add",
        json!({"book":b,"host":sub,"member":ch_id}),
        "V3-MEMBERSHIP-RULES",
    );

    // Deleting a storyline leaves the chapters on it untouched in `书稿`.
    e.call("entry.trash", json!({"book":b,"id":lane}));
    let ch_after = get(&e, &b, &ch_id);
    assert!(ch_after["deleted_at"].is_null());
    assert_eq!(ch_after["parent"], json!(ms));
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
fn project_tabs_mount_three_targets_and_keep_invalid_mounts() {
    let e = env();
    let b = e.book();
    let ms = root(&e, &b, "tpl-manuscript");
    let sl_root = root(&e, &b, "tpl-storylines");
    let chapter = create(&e, &b, &ms, "第一章", "tpl-chapter");
    e.call(
        "module.set_prose",
        json!({"book":b,"owner":chapter,"module":"mod-prose","paragraphs":[{"text":"潮水退去之后。"}]}),
    );
    let view = e.out("timeline_view.list", json!({"book":b}))[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let lane = e.out(
        "entry.create",
        json!({"book":b,"parent":sl_root,"title":"主线","template":"tpl-storyline"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    e.call(
        "timeline_view.add_lane",
        json!({"book":b,"view":view,"lane":lane}),
    );

    // Default novel project: the book (no start, DW), 「全部」 and 4 default
    // tabs, all valid.
    let proj = e.out("project.get", json!({"book":b}));
    assert_eq!(proj["source"]["id"], "builtin:novel");
    assert!(proj["book"].is_object());
    assert!(proj["book"].get("root").is_none(), "{proj}");
    assert_eq!(proj["tabs"].as_array().unwrap().len(), 5);
    assert!(
        proj["tabs"]
            .as_array()
            .unwrap()
            .iter()
            .all(|t| t["mount_valid"] == true)
    );

    // Tabs for the three mount targets: root (「全部」, already there), entry,
    // book. A Tab cannot mount a view (DV, `kernel-v5.md` §15 item 15), not
    // even one that is there.
    let t_root = proj["tabs"][0]["id"].as_str().unwrap().to_owned();
    assert_eq!(proj["tabs"][0]["mount"], json!({"kind":"root"}));
    refused(
        &e,
        "tab.put",
        json!({"book":b,"mount":{"kind":"view","view":view}}),
        "TAB-MOUNT-VALID",
    );
    let t_book = e.out("tab.put", json!({"book":b,"mount":{"kind":"book"}}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    e.call(
        "tab.move",
        json!({"book":b,"id":t_book,"place":{"before":proj["tabs"][0]["id"]}}),
    );
    let tabs_now = e.out("project.get", json!({"book":b}))["tabs"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(tabs_now[0]["id"], t_book);
    assert!(tabs_now.iter().all(|t| t["mount_valid"] == true));

    // Invalid mounts are refused on write.
    refused(
        &e,
        "tab.put",
        json!({"book":b,"mount":{"kind":"entry","entry":chapter}}),
        "TAB-MOUNT-VALID",
    );
    refused(
        &e,
        "tab.put",
        json!({"book":b,"mount":{"kind":"view","view":"tv-missing"}}),
        "TAB-MOUNT-VALID",
    );

    // The book reads from the root: 书稿, then its chapter, the only book
    // prose; nothing is numbered.
    let seq = e.out("book.sequence", json!({"book":b}));
    assert_eq!(seq["has_book"], true);
    assert_eq!(seq["entries"][0]["entry"]["id"], ms);
    assert_eq!(seq["entries"][1]["entry"]["id"], chapter);
    let with_prose: Vec<&Value> = seq["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| !row["prose"].as_array().unwrap().is_empty())
        .collect();
    assert_eq!(with_prose.len(), 1);
    assert_eq!(with_prose[0]["entry"]["id"], chapter);
    assert!(with_prose[0].get("ordinal").is_none());

    // Trashing an entry mounted on a tab keeps the tab stored, marks it
    // invalid on read, leaves the book alone, and blocks no unrelated write.
    let appendix = e.out(
        "entry.create",
        json!({"book":b,"title":"附录","template":"tpl-group"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let t_app = e.out(
        "tab.put",
        json!({"book":b,"mount":{"kind":"entry","entry":appendix}}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    e.call("entry.trash", json!({"book":b,"id":appendix}));
    let proj_trashed = e.out("project.get", json!({"book":b}));
    assert_eq!(
        proj_trashed["tabs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["id"] == t_app)
            .unwrap()["mount_valid"],
        false
    );
    let seq_after = e.out("book.sequence", json!({"book":b}));
    assert!(
        seq_after["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["entry"]["id"] == chapter)
    );
    // Unrelated writes and moving the invalid-mounted tab succeed.
    e.call(
        "entry.update",
        json!({"book":b,"id":chapter,"title":"第一章 改"}),
    );
    e.call("tab.move", json!({"book":b,"id":t_app,"place":"first"}));
    refused(
        &e,
        "tab.remove",
        json!({"book":b,"id":t_root}),
        "TAB-ROOT-ALWAYS",
    );
    e.call("tab.remove", json!({"book":b,"id":t_app}));

    // Turning the book off keeps `{kind: "book"}` tab stored with `mount_valid == false`,
    // hides shelf words & daily target, and makes `writing_day.record` a no-op.
    e.call("project.update", json!({"book":b,"has_book":false}));
    let proj_no_book = e.out("project.get", json!({"book":b}));
    assert!(proj_no_book["book"].is_null());
    assert_eq!(
        proj_no_book["tabs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["id"] == t_book)
            .unwrap()["mount_valid"],
        false
    );
    refused(
        &e,
        "tab.put",
        json!({"book":b,"mount":{"kind":"book"}}),
        "TAB-MOUNT-VALID",
    );
    let shelf = e.out("book.shelf", json!({}));
    assert!(
        shelf
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["id"] == b)
            .unwrap()["words"]
            .is_null()
    );
    let stats_before = e.ws().observe(&format!("stats:{b}")).unwrap().version;
    e.call(
        "writing_day.record",
        json!({"book":b,"device":"dev-1","day":"2026-11-13","words":500}),
    );
    assert_eq!(
        e.ws().observe(&format!("stats:{b}")).unwrap().version,
        stats_before,
        "writing_day.record does not write when project.book is off"
    );
    let days = e.out("book.writing_days", json!({"book":b,"today":"2026-11-13"}));
    assert!(days["daily_word_target"].is_null());
    assert_eq!(days["today"], 0);
    assert_eq!(days["week"], 0);

    // Undo turning the book off restores `project.book` and makes `t_book` valid again.
    e.ws().undo(&Actor::User).unwrap().unwrap();
    let restored = e.out("project.get", json!({"book":b}));
    assert!(!restored["book"].is_null());
    assert_eq!(
        restored["tabs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["id"] == t_book)
            .unwrap()["mount_valid"],
        true
    );

    // Custom non-book project template via `project.create`.
    let custom = e.out(
        "project.create",
        json!({
            "name": "研究卡片库",
            "template": {
                "project": {
                    "source": {"id": "research-cards", "version": 1},
                    "agent": {"name": "研究助手", "description": "整理文献", "instructions": "按主题归档"},
                    "book": null,
                    "tabs": [
                        {"id": "tab-all", "name": "全部卡片", "mount": {"kind": "root"}}
                    ]
                },
                "templates": [
                    {
                        "id": "tpl-card",
                        "name": "卡片",
                        "modules": [
                            {"id": "mod-prose", "kind": "prose", "name": "笔记", "config": {"in_book": false}}
                        ]
                    }
                ],
                "entries": [
                    {
                        "id": "ent-first-card",
                        "title": "第一张卡片",
                        "template": "tpl-card",
                        "level": false
                    }
                ],
                "views": []
            }
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let custom_proj = e.out("project.get", json!({"book":custom}));
    assert_eq!(custom_proj["source"]["id"], "research-cards");
    assert!(custom_proj["book"].is_null());
    // The template's root tab is 「全部」, under the fixed id; its old `name`
    // is read and ignored.
    assert_eq!(custom_proj["tabs"].as_array().unwrap().len(), 1);
    assert_eq!(custom_proj["tabs"][0]["id"], "tab-all");
    assert_eq!(custom_proj["tabs"][0]["mount"], json!({"kind":"root"}));
    assert!(custom_proj["tabs"][0].get("name").is_none());
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
