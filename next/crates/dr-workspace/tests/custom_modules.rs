//! Custom modules end to end (`custom-modules.md` §7, §11, §13, §14): my
//! modules, a book's copies following them, the values an entry keeps, and
//! a project template carrying modules. The sample modules are dr-testkit's
//! fixtures (`dr_testkit::samples::MODULE_FILES`), read by path.

mod common;
use common::*;

use dr_workspace::Actor;
use loro::ExportMode;
use serde_json::{Value, json};

const FORESHADOWING: &str =
    include_str!("../../dr-testkit/fixtures/modules/foreshadowing.driftingmodule");
const CHRONOLOGY: &str =
    include_str!("../../dr-testkit/fixtures/modules/world-chronology.driftingmodule");
const MAGIC: &str = include_str!("../../dr-testkit/fixtures/modules/magic-rule.driftingmodule");

fn module(raw: &str) -> Value {
    serde_json::from_str(raw).unwrap()
}

/// One of my modules made from `raw`; its id.
fn create(e: &Env, raw: &str) -> String {
    e.out("custom_module.create", json!({"value": module(raw)}))["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// A template `tpl-mod` with custom module `mod-c` drawing `module`, and an
/// entry of it; (entry id).
fn entry_with(e: &Env, book: &str, module: &str) -> String {
    e.call(
        "entry_template.put",
        json!({"book": book, "template": {
            "id": "tpl-mod", "name": "有模块的", "modules": [
                {"id": "mod-text", "kind": "prose", "name": "正文"},
                {"id": "mod-c", "kind": "custom", "name": "自定义", "config": {"module": module}}
            ]
        }}),
    );
    e.out(
        "entry.create",
        json!({"book": book, "title": "第一个", "template": "tpl-mod"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn read(e: &Env, book: &str, entry: &str) -> Value {
    e.out(
        "module.read_custom",
        json!({"book": book, "entry": entry, "module": "mod-c"}),
    )
}

fn target(book: &str, entry: &str) -> Value {
    json!({"book": book, "entry": entry, "module": "mod-c"})
}

fn with(mut base: Value, extra: Value) -> Value {
    for (k, v) in extra.as_object().unwrap() {
        base[k] = v.clone();
    }
    base
}

#[test]
fn my_modules_list_get_update_rename_remove() {
    let e = env();
    assert_eq!(e.out("custom_module.list", json!({})), json!([]));
    let id = create(&e, FORESHADOWING);
    let list = e.out("custom_module.list", json!({}));
    assert_eq!(list[0]["id"], id);
    assert_eq!(list[0]["name"], "伏笔追踪");
    assert_eq!(list[0]["origin"], "own");
    assert_eq!(list[0]["blocks"], 4);
    assert_eq!(list[0]["author"], "示例作者");
    let got = e.out("custom_module.get", json!({"id": id}));
    assert_eq!(got["value"], module(FORESHADOWING));

    let renamed = e.out("custom_module.rename", json!({"id": id, "name": " 伏笔 "}));
    assert_eq!(renamed["name"], "伏笔");
    // ⌘Z puts the name back.
    e.ws().undo(&Actor::User).unwrap().unwrap();
    assert_eq!(
        e.out("custom_module.get", json!({"id": id}))["value"]["name"],
        "伏笔追踪"
    );
    // The same value again is no change.
    let outcome = e.call(
        "custom_module.update",
        json!({"id": id, "value": module(FORESHADOWING)}),
    );
    assert!(
        outcome["effects"].as_array().unwrap().is_empty(),
        "{outcome}"
    );

    e.call("custom_module.remove", json!({"id": id}));
    assert_eq!(e.out("custom_module.list", json!({})), json!([]));
    assert!(e.try_call("custom_module.get", json!({"id": id})).is_err());
}

#[test]
fn every_entrance_refuses_what_the_validator_refuses() {
    let e = env();
    let id = create(&e, FORESHADOWING);
    let mut colour = module(FORESHADOWING);
    colour["look"]["line"]["color"] = json!("#ff0000");
    let mut by_id = module(FORESHADOWING);
    by_id["sample"]["items"][0]["back"] = json!(["0192f3a4-5b6c-7d8e-9f00-112233445566"]);
    let mut newer = module(FORESHADOWING);
    newer["formatVersion"] = json!(2);
    let book = e.book();
    let entry = entry_with(&e, &book, &id);
    let _ = entry;
    let dir = tempfile::tempdir().unwrap();
    for (i, bad) in [colour, by_id, newer].into_iter().enumerate() {
        assert!(
            e.try_call("custom_module.create", json!({"value": bad}))
                .is_err(),
            "{i}"
        );
        assert!(
            e.try_call("custom_module.update", json!({"id": id, "value": bad}))
                .is_err()
        );
        assert!(
            e.try_call(
                "custom_module.save_as",
                json!({"book": book, "module": id, "value": bad})
            )
            .is_err()
        );
        let path = dir.path().join(format!("bad-{i}.driftingmodule"));
        std::fs::write(&path, bad.to_string()).unwrap();
        assert!(
            e.try_call(
                "custom_module.import",
                json!({"path": path.to_str().unwrap()})
            )
            .is_err()
        );
    }
    // Nothing was added, nothing changed.
    assert_eq!(
        e.out("custom_module.list", json!({}))
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        e.out("custom_module.get", json!({"id": id}))["value"],
        module(FORESHADOWING)
    );
}

#[test]
fn a_template_module_takes_a_copy_and_values_are_written_by_path() {
    let e = env();
    let id = create(&e, CHRONOLOGY);
    let book = e.book();
    let entry = entry_with(&e, &book, &id);
    let r = read(&e, &book, &entry);
    assert_eq!(r["copy"]["id"], id);
    assert_eq!(r["copy"]["follows"], true);
    assert_eq!(r["copy"]["broken"], false);
    assert_eq!(r["copy"]["source"], "library");
    assert_eq!(r["value"], module(CHRONOLOGY));
    assert_eq!(r["values"], json!({}));
    // Never part of the book, whatever was asked.
    let tpls = e.out("entry_template.list", json!({"book": book}));
    let spec = tpls
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == "tpl-mod")
        .unwrap()["modules"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == "mod-c")
        .cloned()
        .unwrap();
    assert_eq!(spec["config"]["in_book"], false);
    assert_eq!(spec["config"]["module"], id);

    let t = target(&book, &entry);
    let era = e.out(
        "module.add_custom_item",
        with(t.clone(), json!({"list": "eras"})),
    )["item"]
        .as_str()
        .unwrap()
        .to_owned();
    let into_era = json!([{"list": "eras", "item": era}]);
    e.call(
        "module.set_custom_value",
        with(
            t.clone(),
            json!({"path": into_era, "block": "era", "value": "雾纪"}),
        ),
    );
    let ev = e.out(
        "module.add_custom_item",
        with(t.clone(), json!({"path": into_era, "list": "events"})),
    )["item"]
        .as_str()
        .unwrap()
        .to_owned();
    let into_ev = json!([{"list": "eras", "item": era}, {"list": "events", "item": ev}]);
    e.call(
        "module.set_custom_value",
        with(
            t.clone(),
            json!({"path": into_ev, "block": "year", "value": 12}),
        ),
    );
    e.call(
        "module.set_custom_value",
        with(
            t.clone(),
            json!({"path": into_ev, "block": "where", "value": [entry]}),
        ),
    );
    let r = read(&e, &book, &entry);
    assert_eq!(r["values"]["eras"]["type"], "list");
    let eras = r["values"]["eras"]["value"].as_array().unwrap();
    assert_eq!(eras[0]["id"], era);
    assert_eq!(
        eras[0]["values"]["era"],
        json!({"type": "text", "value": "雾纪"})
    );
    let events = eras[0]["values"]["events"]["value"].as_array().unwrap();
    assert_eq!(
        events[0]["values"]["year"],
        json!({"type": "number", "value": 12.0})
    );
    assert_eq!(
        events[0]["values"]["where"],
        json!({"type": "entry", "value": [entry]})
    );

    // Checked against the kind, the path, the book.
    for (bad, why) in [
        (
            json!({"path": into_ev, "block": "year", "value": "十二"}),
            "kind",
        ),
        (json!({"path": [], "block": "year", "value": 12}), "path"),
        (
            json!({"path": into_era, "block": "events", "value": 1}),
            "list",
        ),
        (
            json!({"path": into_ev, "block": "where", "value": ["no-such-entry"]}),
            "entry",
        ),
        (
            json!({"path": [{"list": "eras", "item": "gone"}], "block": "era", "value": "x"}),
            "item",
        ),
    ] {
        assert!(
            e.try_call("module.set_custom_value", with(t.clone(), bad))
                .is_err(),
            "{why}"
        );
    }
    // Undo: one step back each.
    let before_clear = read(&e, &book, &entry)["values"].clone();
    e.call(
        "module.set_custom_value",
        with(
            t.clone(),
            json!({"path": into_era, "block": "era", "value": null}),
        ),
    );
    assert!(read(&e, &book, &entry)["values"]["eras"]["value"][0]["values"]["era"].is_null());
    e.ws().undo(&Actor::User).unwrap().unwrap();
    assert_eq!(read(&e, &book, &entry)["values"], before_clear);
    e.call(
        "module.remove_custom_item",
        with(t.clone(), json!({"list": "eras", "item": era})),
    );
    assert_eq!(
        read(&e, &book, &entry)["values"]["eras"]["value"],
        json!([])
    );
    e.ws().undo(&Actor::User).unwrap().unwrap();
    assert_eq!(read(&e, &book, &entry)["values"], before_clear);
    // Moving items keeps their values.
    let second = e.out(
        "module.add_custom_item",
        with(t.clone(), json!({"list": "eras", "index": 0})),
    )["item"]
        .as_str()
        .unwrap()
        .to_owned();
    e.call(
        "module.move_custom_item",
        with(t.clone(), json!({"list": "eras", "item": era, "to": 0})),
    );
    let eras = read(&e, &book, &entry)["values"]["eras"]["value"].clone();
    assert_eq!(eras[0]["id"], era);
    assert_eq!(eras[1]["id"], second);
    assert_eq!(eras[0]["values"]["era"]["value"], "雾纪");
}

#[test]
fn values_survive_deleting_a_block_changing_its_kind_and_replacing_the_copy() {
    let e = env();
    let id = create(&e, MAGIC);
    let book = e.book();
    let entry = entry_with(&e, &book, &id);
    let t = target(&book, &entry);
    e.call(
        "module.set_custom_value",
        with(t.clone(), json!({"block": "price", "value": "一段记忆"})),
    );
    e.call(
        "module.set_custom_value",
        with(t.clone(), json!({"block": "power", "value": 4})),
    );
    let full = read(&e, &book, &entry)["values"].clone();
    assert_eq!(full["price"]["value"], "一段记忆");
    // My module changes: `price` taken out of the group, `power` now text.
    let mut changed = module(MAGIC);
    changed["blocks"][3]["blocks"] = json!([changed["blocks"][3]["blocks"][1]]);
    changed["blocks"][0]["type"] = json!("text");
    changed["look"]["block"] = json!({"box": "col"});
    // Written the canonical way: an empty sample or per-block words are left out.
    changed.as_object_mut().unwrap().remove("sample");
    changed["agent"].as_object_mut().unwrap().remove("blocks");
    e.call("custom_module.update", json!({"id": id, "value": changed}));
    // The open book took the new copy at once; what is stored stays.
    let r = read(&e, &book, &entry);
    assert_eq!(r["value"], changed);
    assert!(
        r["values"].get("price").is_none(),
        "a deleted block is not shown"
    );
    assert!(
        r["values"].get("power").is_none(),
        "4 does not read as text"
    );
    // Back: everything shows again.
    e.call(
        "custom_module.update",
        json!({"id": id, "value": module(MAGIC)}),
    );
    assert_eq!(read(&e, &book, &entry)["values"], full);
    // Undo of the update replaced the copy too.
    e.ws().undo(&Actor::User).unwrap().unwrap();
    assert_eq!(read(&e, &book, &entry)["value"], changed);
}

#[test]
fn a_closed_project_takes_the_new_copy_when_it_is_opened() {
    let mut e = env();
    let id = create(&e, FORESHADOWING);
    let book = e.book();
    let entry = entry_with(&e, &book, &id);
    e.reopen();
    // Only the library is open: the book is not.
    let mut renamed = module(FORESHADOWING);
    renamed["name"] = json!("伏笔追踪（新）");
    e.call("custom_module.update", json!({"id": id, "value": renamed}));
    let raw = e.ws().library().load_copy(&format!("book:{book}")).unwrap();
    let book_id = dr_model::id::BookId::parse(&book).unwrap();
    let held = dr_doc::v3::BorrowedBookV3::new(&raw, &book_id)
        .unwrap()
        .view()
        .module_copy(&dr_model::id::CustomModuleId::parse(&id).unwrap())
        .unwrap();
    assert_eq!(
        held.name().as_deref(),
        Some("伏笔追踪"),
        "a book nobody opened keeps its copy until it is opened"
    );
    assert_eq!(read(&e, &book, &entry)["value"]["name"], "伏笔追踪（新）");
    assert_eq!(read(&e, &book, &entry)["copy"]["follows"], true);
}

fn sync_kind(from: &Env, to: &Env, kind: &str) {
    for d in from.ws().library().docs(None, Some(kind)).unwrap() {
        if from.ws().library().head(&d.doc_id).unwrap().is_none() {
            continue;
        }
        let bytes = from
            .ws()
            .library()
            .load_copy(&d.doc_id)
            .unwrap()
            .export(ExportMode::all_updates())
            .unwrap();
        let book = d.book_id.clone().unwrap_or_default();
        to.ws()
            .import_remote(&d.doc_id, Some((kind, &book)), bytes, &Actor::Sync)
            .unwrap();
    }
    for p in from.ws().library().purged_docs(None).unwrap() {
        if p.doc_id.starts_with(&format!("{kind}:")) {
            to.ws().release_idle_doc_for_remote_purge(&p.doc_id);
            let _ = to.ws().library().purge_doc(&p.doc_id);
        }
    }
}

#[test]
fn two_devices_keep_one_whole_module_and_an_open_project_takes_it_at_once() {
    let a = env();
    let b = env();
    let id = create(&a, FORESHADOWING);
    sync_kind(&a, &b, "module");
    assert_eq!(
        b.out("custom_module.get", json!({"id": id}))["value"],
        module(FORESHADOWING)
    );
    let book = b.book();
    let entry = entry_with(&b, &book, &id);
    assert_eq!(read(&b, &book, &entry)["copy"]["follows"], true);
    // A and B change it at once; both end with one whole module.
    let mut on_a = module(FORESHADOWING);
    on_a["name"] = json!("甲改的");
    let mut on_b = module(FORESHADOWING);
    on_b["blocks"][0]["blocks"][1]["options"] = json!(["埋着", "收了"]);
    on_b.as_object_mut().unwrap().remove("sample");
    a.call("custom_module.update", json!({"id": id, "value": on_a}));
    std::thread::sleep(std::time::Duration::from_millis(5));
    b.call("custom_module.update", json!({"id": id, "value": on_b}));
    sync_kind(&a, &b, "module");
    sync_kind(&b, &a, "module");
    let va = a.out("custom_module.get", json!({"id": id}))["value"].clone();
    let vb = b.out("custom_module.get", json!({"id": id}))["value"].clone();
    assert_eq!(va, vb);
    assert!(va == on_a || va == on_b, "{va}");
    // B's open project took the merged module at once.
    assert_eq!(read(&b, &book, &entry)["value"], vb);
    // Removed on A: B's project keeps its copy and stops following.
    a.call("custom_module.remove", json!({"id": id}));
    sync_kind(&a, &b, "module");
    assert!(b.try_call("custom_module.get", json!({"id": id})).is_err());
    let r = read(&b, &book, &entry);
    assert_eq!(r["copy"]["follows"], false);
    assert_eq!(r["value"], vb);
}

#[test]
fn save_as_adopt_and_import_always_make_a_new_id() {
    let e = env();
    let id = create(&e, FORESHADOWING);
    let book = e.book();
    let entry = entry_with(&e, &book, &id);
    let t = target(&book, &entry);
    let item = e.out(
        "module.add_custom_item",
        with(t.clone(), json!({"list": "items"})),
    )["item"]
        .as_str()
        .unwrap()
        .to_owned();
    e.call(
        "module.set_custom_value",
        with(
            t.clone(),
            json!({"path": [{"list": "items", "item": item}], "block": "line", "value": "旧照片"}),
        ),
    );
    let values = read(&e, &book, &entry)["values"].clone();

    // 另存一份: a new id; the project uses it; the old one is not changed.
    let mut mine = module(FORESHADOWING);
    mine["name"] = json!("这本书的伏笔");
    let saved = e.out(
        "custom_module.save_as",
        json!({"book": book, "module": id, "value": mine}),
    );
    let new_id = saved["module"]["id"].as_str().unwrap().to_owned();
    assert_ne!(new_id, id);
    assert_eq!(saved["templates"], json!(["tpl-mod"]));
    let r = read(&e, &book, &entry);
    assert_eq!(r["copy"]["id"], new_id);
    assert_eq!(r["value"]["name"], "这本书的伏笔");
    assert_eq!(r["values"], values, "the entry's values stay");
    assert_eq!(
        e.out("custom_module.get", json!({"id": id}))["value"],
        module(FORESHADOWING)
    );
    // Changing the old one leaves this project alone now.
    let mut old_changed = module(FORESHADOWING);
    old_changed["name"] = json!("改了旧的");
    e.call(
        "custom_module.update",
        json!({"id": id, "value": old_changed}),
    );
    assert_eq!(read(&e, &book, &entry)["value"]["name"], "这本书的伏笔");
    assert_eq!(
        e.out("custom_module.uses", json!({"id": new_id}))[0]["book"],
        book
    );
    assert_eq!(e.out("custom_module.uses", json!({"id": id})), json!([]));

    // Export, import: always a new module, never over the one exported.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("a.driftingmodule");
    e.call(
        "custom_module.export",
        json!({"id": new_id, "path": path.to_str().unwrap(), "author": "林岬"}),
    );
    let first = std::fs::read(&path).unwrap();
    e.call(
        "custom_module.export",
        json!({"id": new_id, "path": path.to_str().unwrap(), "author": "林岬"}),
    );
    assert_eq!(std::fs::read(&path).unwrap(), first, "byte for byte");
    let text = String::from_utf8(first).unwrap();
    assert!(text.contains("\"author\": \"林岬\""));
    assert!(!text.contains("示例作者"), "credit is the exporter's only");
    let a = e.out(
        "custom_module.import",
        json!({"path": path.to_str().unwrap()}),
    );
    let b = e.out(
        "custom_module.import",
        json!({"path": path.to_str().unwrap()}),
    );
    assert_ne!(a["id"], b["id"]);
    assert_ne!(a["id"], new_id);
    assert_eq!(a["origin"], "file");

    // 存进我的模块: only for a module my modules do not have.
    assert!(
        e.try_call(
            "custom_module.adopt",
            json!({"book": book, "module": new_id})
        )
        .is_err()
    );
}

#[test]
fn a_project_template_carries_modules_and_a_new_project_follows_by_id() {
    let e = env();
    let id = create(&e, MAGIC);
    let book = e.book();
    entry_with(&e, &book, &id);
    let tpl = e.out(
        "project_template.save",
        json!({"book": book, "name": "带模块的模板"}),
    );
    let got = e.out("project_template.get", json!({"id": tpl["id"]}));
    assert_eq!(got["value"]["modules"][&id], module(MAGIC));
    // Same library: the new project follows my module.
    let made = e.out(
        "project.create",
        json!({"name": "新书", "template_id": tpl["id"]}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let entry = e.out(
        "entry.create",
        json!({"book": made, "title": "条目", "template": "tpl-mod"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let r = read(&e, &made, &entry);
    assert_eq!(r["copy"]["source"], "template");
    assert_eq!(r["copy"]["follows"], true);
    let mut changed = module(MAGIC);
    changed["name"] = json!("魔法规则卡（改）");
    e.call("custom_module.update", json!({"id": id, "value": changed}));
    assert_eq!(read(&e, &made, &entry)["value"]["name"], "魔法规则卡（改）");

    // Another library imports the template file: the module came with it,
    // is not one of its modules and follows nothing.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("t.driftingtemplate");
    e.call(
        "project_template.export",
        json!({"id": tpl["id"], "path": path.to_str().unwrap()}),
    );
    let other = env();
    let imported = other.out(
        "project_template.import",
        json!({"path": path.to_str().unwrap()}),
    );
    let theirs = other.out(
        "project.create",
        json!({"name": "别人的", "template_id": imported["id"]}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let their_entry = other.out(
        "entry.create",
        json!({"book": theirs, "title": "条目", "template": "tpl-mod"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let r = read(&other, &theirs, &their_entry);
    assert_eq!(r["copy"]["follows"], false);
    assert_eq!(other.out("custom_module.list", json!({})), json!([]));
    // 存进我的模块: a new id; the project follows it from now on.
    let adopted = other.out("custom_module.adopt", json!({"book": theirs, "module": id}));
    let mine = adopted["module"]["id"].as_str().unwrap().to_owned();
    assert_ne!(mine, id);
    let r = read(&other, &theirs, &their_entry);
    assert_eq!(r["copy"]["id"], mine);
    assert_eq!(r["copy"]["follows"], true);
}

#[test]
fn a_broken_copy_reads_as_broken_keeps_its_values_and_refuses_writes() {
    let e = env();
    let id = create(&e, FORESHADOWING);
    let book = e.book();
    let entry = entry_with(&e, &book, &id);
    let t = target(&book, &entry);
    let item = e.out(
        "module.add_custom_item",
        with(t.clone(), json!({"list": "items"})),
    )["item"]
        .as_str()
        .unwrap()
        .to_owned();
    let path = json!([{"list": "items", "item": item}]);
    e.call(
        "module.set_custom_value",
        with(
            t.clone(),
            json!({"path": path, "block": "line", "value": "旧照片"}),
        ),
    );
    // A newer build's copy arrives from another device (a book update
    // written outside this build), and my modules no longer have it.
    e.call("custom_module.remove", json!({"id": id}));
    let raw = e.ws().library().load_copy(&format!("book:{book}")).unwrap();
    let before = raw.oplog_vv();
    raw.set_peer_id(4242).unwrap();
    let newer = FORESHADOWING.replace("\"formatVersion\": 1", "\"formatVersion\": 3");
    let record: std::collections::HashMap<String, loro::LoroValue> = [
        ("value".to_owned(), loro::LoroValue::from(newer.as_str())),
        ("source".to_owned(), loro::LoroValue::from("library")),
    ]
    .into_iter()
    .collect();
    raw.get_map("modules")
        .insert(&id, loro::LoroValue::from(record))
        .unwrap();
    raw.commit();
    let bytes = raw.export(ExportMode::updates(&before)).unwrap();
    e.ws()
        .import_remote(&format!("book:{book}"), None, bytes, &Actor::Sync)
        .unwrap();
    let r = read(&e, &book, &entry);
    assert_eq!(r["copy"]["broken"], true);
    assert_eq!(r["copy"]["name"], "伏笔追踪");
    assert!(r.get("value").is_none());
    assert!(
        e.try_call(
            "module.set_custom_value",
            with(
                t.clone(),
                json!({"path": path, "block": "line", "value": "新"})
            )
        )
        .is_err()
    );
    // The values are still in the book.
    let stored = e.ws().library().load_copy(&format!("book:{book}")).unwrap();
    let dump = serde_json::to_string(&stored.get_deep_value()).unwrap();
    assert!(dump.contains("旧照片"));
}

#[test]
fn my_modules_are_not_the_content_of_any_book() {
    let e = env();
    let book = e.book();
    let words_before = e.out("book.shelf", json!({}));
    let book_version = e.ws().library().head(&format!("book:{book}")).unwrap();
    let id = create(&e, FORESHADOWING);
    let mut renamed = module(FORESHADOWING);
    renamed["name"] = json!("伏笔追踪（二）");
    e.call("custom_module.update", json!({"id": id, "value": renamed}));
    // No book changed, none lists the module's document, none counts it.
    assert_eq!(
        e.ws().library().head(&format!("book:{book}")).unwrap(),
        book_version
    );
    assert!(
        e.ws()
            .library()
            .docs(Some(&book), None)
            .unwrap()
            .iter()
            .all(|d| !d.doc_id.starts_with("module:"))
    );
    let info = e
        .ws()
        .library()
        .doc_info(&format!("module:{id}"))
        .unwrap()
        .unwrap();
    assert_eq!(info.book_id, None);
    assert_eq!(e.out("book.shelf", json!({})), words_before);
    let hits = e.out("entry.search", json!({"book": book, "query": "伏笔追踪"}));
    assert_eq!(hits["hits"].as_array().map_or(0, Vec::len), 0, "{hits}");
    let kind = dr_model::DocId::parse(&format!("module:{id}"))
        .unwrap()
        .kind();
    assert!(!kind.is_book_text());
    assert_eq!(kind.profile(), None);
}

#[test]
fn an_older_copy_from_a_book_update_is_brought_up_to_date_on_request() {
    let e = env();
    let id = create(&e, FORESHADOWING);
    let book = e.book();
    let entry = entry_with(&e, &book, &id);
    // Another device that had not seen the latest module writes the older
    // copy into the book; a book update alone does not replace it.
    let raw = e.ws().library().load_copy(&format!("book:{book}")).unwrap();
    let before = raw.oplog_vv();
    raw.set_peer_id(4343).unwrap();
    let mut older = module(FORESHADOWING);
    older["name"] = json!("旧名字");
    let older = serde_json::to_string_pretty(&older).unwrap() + "\n";
    let record: std::collections::HashMap<String, loro::LoroValue> = [
        ("value".to_owned(), loro::LoroValue::from(older.as_str())),
        ("source".to_owned(), loro::LoroValue::from("library")),
    ]
    .into_iter()
    .collect();
    raw.get_map("modules")
        .insert(&id, loro::LoroValue::from(record))
        .unwrap();
    raw.commit();
    e.ws()
        .import_remote(
            &format!("book:{book}"),
            None,
            raw.export(ExportMode::updates(&before)).unwrap(),
            &Actor::Sync,
        )
        .unwrap();
    assert_eq!(read(&e, &book, &entry)["value"]["name"], "旧名字");
    let synced = e.out("custom_module.sync_copies", json!({"book": book}));
    assert_eq!(synced["replaced"], json!([id]));
    assert_eq!(read(&e, &book, &entry)["value"], module(FORESHADOWING));
    // Nothing left to do the second time.
    let again = e.out("custom_module.sync_copies", json!({"book": book}));
    assert_eq!(again["replaced"], json!([]));
}

#[test]
fn an_entry_checkpoint_brings_custom_values_back() {
    let e = env();
    let id = create(&e, CHRONOLOGY);
    let book = e.book();
    let entry = entry_with(&e, &book, &id);
    let t = target(&book, &entry);
    let era = e.out(
        "module.add_custom_item",
        with(t.clone(), json!({"list": "eras"})),
    )["item"]
        .as_str()
        .unwrap()
        .to_owned();
    e.call(
        "module.set_custom_value",
        with(
            t.clone(),
            json!({"path": [{"list": "eras", "item": era}], "block": "era", "value": "雾纪"}),
        ),
    );
    let before = read(&e, &book, &entry)["values"].clone();
    let point = e.out(
        "entry_snapshot.create",
        json!({"book": book, "entry": entry}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    e.call(
        "module.remove_custom_item",
        with(t.clone(), json!({"list": "eras", "item": era})),
    );
    e.call(
        "module.add_custom_item",
        with(t.clone(), json!({"list": "eras"})),
    );
    let after = read(&e, &book, &entry)["values"].clone();
    assert_ne!(after, before);
    let expected = e.out(
        "entry_snapshot.preview",
        json!({"book": book, "entry": entry, "point": point}),
    )["expected"]
        .clone();
    e.out(
        "entry_snapshot.restore",
        json!({"book": book, "entry": entry, "point": point, "expected": expected}),
    );
    assert_eq!(read(&e, &book, &entry)["values"], before);
    e.ws().undo(&Actor::User).unwrap().unwrap();
    assert_eq!(read(&e, &book, &entry)["values"], after);
}

/// The ids of template `tpl`'s modules, in the template's order (the order
/// every place that draws an entry's modules reads them in).
fn module_order(e: &Env, book: &str, tpl: &str) -> Vec<String> {
    e.out("entry_template.list", json!({"book": book}))
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == tpl)
        .unwrap()["modules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["id"].as_str().unwrap().to_owned())
        .collect()
}

/// A template's modules keep the order they were given in (CR), built-in
/// and custom ones alike: the book keeps them in the order of their
/// positions, and a module given without a position gets one where it was
/// given (before, they read back in the order of their ids). A module put
/// again keeps its place; a new one goes last; positions given win.
#[test]
fn a_templates_modules_keep_the_order_they_were_given_in() {
    let e = env();
    let book = e.book();
    let fore = create(&e, FORESHADOWING);
    let magic = create(&e, MAGIC);
    let chrono = create(&e, CHRONOLOGY);
    e.call(
        "entry_template.put",
        json!({"book": book, "template": {
            "id": "tpl-order", "name": "排序", "modules": [
                {"id": "z-fore", "kind": "custom", "name": "伏笔追踪", "config": {"module": fore}},
                {"id": "m-text", "kind": "prose", "name": "正文"},
                {"id": "b-magic", "kind": "custom", "name": "魔法规则卡", "config": {"module": magic}},
                {"id": "a-facts", "kind": "fields", "name": "字段"}
            ]
        }}),
    );
    assert_eq!(
        module_order(&e, &book, "tpl-order"),
        ["z-fore", "m-text", "b-magic", "a-facts"]
    );
    // Put again (renamed), a module keeps its place; a new one goes last.
    e.call(
        "entry_template.put_module",
        json!({"book": book, "template": "tpl-order",
            "module": {"id": "m-text", "kind": "prose", "name": "正文二"}}),
    );
    e.call(
        "entry_template.put_module",
        json!({"book": book, "template": "tpl-order",
            "module": {"id": "aa-chrono", "kind": "custom", "name": "世界观年表",
                "config": {"module": chrono}}}),
    );
    assert_eq!(
        module_order(&e, &book, "tpl-order"),
        ["z-fore", "m-text", "b-magic", "a-facts", "aa-chrono"]
    );
    // Given in another order with their positions, the positions win;
    // without them, the order given.
    let listed = e.out("entry_template.list", json!({"book": book}));
    let mut template = listed
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == "tpl-order")
        .unwrap()
        .clone();
    template["modules"].as_array_mut().unwrap().reverse();
    e.call(
        "entry_template.put",
        json!({"book": book, "template": template.clone()}),
    );
    assert_eq!(
        module_order(&e, &book, "tpl-order"),
        ["z-fore", "m-text", "b-magic", "a-facts", "aa-chrono"]
    );
    for module in template["modules"].as_array_mut().unwrap() {
        module.as_object_mut().unwrap().remove("pos");
    }
    e.call(
        "entry_template.put",
        json!({"book": book, "template": template}),
    );
    assert_eq!(
        module_order(&e, &book, "tpl-order"),
        ["aa-chrono", "a-facts", "b-magic", "m-text", "z-fore"]
    );
    // Taking one away leaves the others where they are.
    e.call(
        "entry_template.remove_module",
        json!({"book": book, "template": "tpl-order", "module": "b-magic"}),
    );
    assert_eq!(
        module_order(&e, &book, "tpl-order"),
        ["aa-chrono", "a-facts", "m-text", "z-fore"]
    );
}

/// CW: what my module was before the Agent's latest changes, read back from
/// the Agent's settlement receipts on this device and the module's history:
/// newest first, whole, only while each is the module's latest change, not
/// past a change of the author's, another device's, or the one that made
/// the module.
#[test]
fn the_agents_changes_to_my_module_read_back_from_its_receipts() {
    use dr_model::custom_module::ModuleValue;
    use dr_model::id::CustomModuleId;
    use dr_workspace::commands::v3::custom_module::agent_changes;

    let e = env();
    let id = create(&e, FORESHADOWING);
    let mid: CustomModuleId = id.parse().unwrap();
    let original: ModuleValue = serde_json::from_str(FORESHADOWING).unwrap();
    let renamed = |name: &str| {
        let mut v = original.clone();
        v.name = name.into();
        v
    };
    let agent = |turn: u32| Actor::agent("cw-receipts", turn, format!("c{turn}"));
    let update = |actor: &Actor, value: &ModuleValue| {
        call(
            e.ws(),
            actor,
            "custom_module.update",
            json!({"id": id, "value": serde_json::to_value(value).unwrap()}),
        );
    };
    let changes = |back_to: Option<&ModuleValue>, limit| {
        agent_changes(e.ws(), &mid, back_to, limit)
            .unwrap()
            .unwrap()
    };
    // Made by the author: nothing of the Agent's.
    let c = changes(None, 10);
    assert_eq!(c.now, original);
    assert!(c.before.is_empty());
    // Two changes of the Agent's: newest first, back to the original.
    let (one, two) = (renamed("一"), renamed("二"));
    update(&agent(1), &one);
    update(&agent(2), &two);
    let c = changes(None, 10);
    assert_eq!(c.now, two);
    assert_eq!(c.before, vec![one.clone(), original.clone()]);
    assert_eq!(changes(None, 1).before, vec![one.clone()]);
    assert_eq!(changes(Some(&one), 10).before, vec![one.clone()]);
    assert!(changes(Some(&two), 10).before.is_empty());
    // A change of the author's after them: nothing to take back.
    let three = renamed("三");
    update(&Actor::User, &three);
    assert!(changes(None, 10).before.is_empty());
    // The Agent again: back to the author's, not past it.
    let four = renamed("四");
    update(&agent(3), &four);
    assert_eq!(changes(None, 10).before, vec![three.clone()]);
    // A module the Agent made has nothing before it.
    let made = e
        .ws()
        .call(
            &agent(4),
            "custom_module.create",
            json!({"value": module(MAGIC)}),
        )
        .unwrap()["output"]["id"]
        .as_str()
        .unwrap()
        .parse::<CustomModuleId>()
        .unwrap();
    let c = agent_changes(e.ws(), &made, None, 10).unwrap().unwrap();
    assert!(c.before.is_empty());
    // Another device has none of this device's receipts.
    let b = env();
    sync_kind(&e, &b, "module");
    let c = agent_changes(b.ws(), &mid, None, 10).unwrap().unwrap();
    assert_eq!(c.now, four);
    assert!(c.before.is_empty());
    // Not one of my modules.
    e.call("custom_module.remove", json!({"id": id}));
    assert!(agent_changes(e.ws(), &mid, None, 10).unwrap().is_none());
}
