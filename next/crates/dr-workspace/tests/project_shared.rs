//! Shared project commands on actual canonical catalogs, including their
//! raw-history inverses and prewrite refusal boundaries.
mod common;
use common::*;
use dr_workspace::Actor;
use serde_json::{Value, json};

fn entry(e: &Env, b: &str, title: &str) -> String {
    acceptance::novel_entry(e.ws(), b, "tpl-chapter", title, Some("Synthetic prose"))["id"]
        .as_str()
        .unwrap()
        .into()
}
fn raw(e: &Env, b: &str) -> Value {
    e.ws().observe(&format!("book:{b}")).unwrap().value
}
fn head(e: &Env, b: &str) -> String {
    e.ws().observe(&format!("book:{b}")).unwrap().version
}

#[test]
fn canonical_relations_validate_dedupe_filter_and_restore_without_losing_raw_values() {
    let e = env();
    let b = e.book();
    let a = entry(&e, &b, "A");
    let z = entry(&e, &b, "Z");
    e.call("entry_relation_type.put",json!({"book":b,"definition":{"id":"pair","name":" Pair ","orientation":"symmetric","source_kinds":["entry"],"target_kinds":["entry"],"source_templates":["tpl-chapter"],"target_templates":["tpl-chapter"]}}));
    let request = |from: &str, to: &str| json!({"book":b,"from":{"kind":"entry","id":from},"to":{"kind":"entry","id":to},"relation_type":"pair"});
    let made = e.out("relation.create", request(&a, &z));
    let before = head(&e, &b);
    assert_eq!(e.out("relation.create", request(&z, &a))["id"], made["id"]);
    assert_eq!(head(&e, &b), before, "semantic replay is not a write");
    for args in [
        request(&a, &a),
        request(&a, "missing"),
        json!({"book":b,"from":{"kind":"entry","id":a},"to":{"kind":"entry","id":z},"relation_type":"missing"}),
    ] {
        assert!(e.try_call("relation.create", args).is_err());
        assert_eq!(head(&e, &b), before);
    }
    for definition in [
        json!({"id":"duplicate","name":"PAIR"}),
        json!({"id":"bad","name":"Bad","orientation":"unknown"}),
        json!({"id":"bad","name":"Bad","source_kinds":["unknown"]}),
    ] {
        assert!(
            e.try_call(
                "entry_relation_type.put",
                json!({"book":b,"definition":definition})
            )
            .is_err()
        );
        assert_eq!(head(&e, &b), before);
    }
    let comment=e.out("comment.create",json!({"book":b,"target":{"kind":"entry","id":z},"module":"mod-prose","range":[0,4],"body":"Synthetic comment"}))["id"].clone();
    e.call("entry.trash", json!({"book":b,"id":z}));
    assert!(
        e.out("relation.list", json!({"book":b}))
            .as_array()
            .unwrap()
            .is_empty()
    );
    let comments = e.out("comment.list", json!({"book":b}));
    assert_eq!(comments[0]["id"], comment);
    assert_eq!(comments[0]["target"]["id"], z);
    assert_eq!(comments[0]["unlocated"], true);
    e.call("entry.restore", json!({"book":b,"id":z}));
    assert_eq!(
        e.out("relation.list", json!({"book":b}))
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let id = made["id"].as_str().unwrap().to_owned();
    let key = id.clone();
    e.ws()
        .library()
        .open_doc(&format!("book:{b}"), dr_store::OpenDoc::Existing)
        .unwrap()
        .write(dr_store::Origin::Sync, move |d| {
            use loro::ValueOrContainer;
            let ValueOrContainer::Container(loro::Container::Map(m)) =
                d.get_map("relations").get(&key).unwrap()
            else {
                panic!("relation map")
            };
            m.insert("future-field", "opaque").unwrap();
            // Imported/merged catalogs can store the opposite symmetric order.
            m.insert("from", z).unwrap();
            m.insert("to", a).unwrap();
        })
        .unwrap();
    let before = head(&e, &b);
    let list = e.out("relation.list", json!({"book":b}));
    let endpoints = &list[0];
    assert_eq!(
        e.out(
            "relation.create",
            json!({"book":b,"from":endpoints["to"],"to":endpoints["from"],"relation_type":"pair"})
        )["id"],
        made["id"]
    );
    assert_eq!(head(&e, &b), before);
    let expected = raw(&e, &b)["relations"][&id].clone();
    e.call("relation.delete", json!({"book":b,"id":id}));
    e.ws().undo(&Actor::User).unwrap();
    assert_eq!(raw(&e, &b)["relations"][&id], expected);
    assert!(
        e.try_call("entry_relation_type.delete", json!({"book":b,"id":"pair"}))
            .is_err()
    );
}

#[test]
fn facts_and_memory_history_keep_unknown_values_and_other_records() {
    let mut e = env();
    let b = e.book();
    let a = e.out("fact.put", json!({"book":b,"key":"One","value":"before"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let other = e.out(
        "fact.put",
        json!({"book":b,"key":"Other","value":"untouched"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let memory = e.out("memory.add", json!({"book":b,"body":"Synthetic memory"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let (fact, mem) = (a.clone(), memory.clone());
    e.ws()
        .library()
        .open_doc(&format!("book:{b}"), dr_store::OpenDoc::Existing)
        .unwrap()
        .write(dr_store::Origin::Sync, move |d| {
            for (root, id) in [("facts", fact), ("memory", mem)] {
                let loro::ValueOrContainer::Container(loro::Container::Map(m)) =
                    d.get_map(root).get(&id).unwrap()
                else {
                    panic!("record map")
                };
                m.insert("future-field", "opaque").unwrap();
            }
        })
        .unwrap();
    let before = raw(&e, &b);
    e.call(
        "fact.put",
        json!({"book":b,"id":a,"key":"One","value":"after"}),
    );
    e.ws().undo(&Actor::User).unwrap();
    assert_eq!(raw(&e, &b)["facts"][&a], before["facts"][&a]);
    assert_eq!(raw(&e, &b)["facts"][&other], before["facts"][&other]);
    e.call(
        "memory.update",
        json!({"book":b,"id":memory,"body":"Changed"}),
    );
    e.ws().undo(&Actor::User).unwrap();
    e.reopen();
    let after = raw(&e, &b);
    assert_eq!(after["memory"][&memory], before["memory"][&memory]);
    assert_eq!(after["facts"][&other], before["facts"][&other]);
    assert_eq!(
        e.out("memory.list", json!({"book":b}))
            .as_array()
            .unwrap()
            .len(),
        1
    );
    e.call("memory.remove", json!({"book":b,"id":memory}));
    assert!(
        e.out("memory.list", json!({"book":b}))
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        e.out("memory.list", json!({"book":b,"removed":true}))[0]["id"],
        memory
    );
    e.call("memory.restore", json!({"book":b,"id":memory}));
    assert_eq!(
        e.out("memory.list", json!({"book":b}))[0]["body"],
        "Synthetic memory"
    );
    assert_eq!(raw(&e, &b)["memory"][&memory]["future-field"], "opaque");
}

#[test]
fn shared_raw_history_preserves_atomic_maps_rich_text_lists_and_refuses_identity_changes_prewrite()
{
    let e = env();
    let b = e.book();
    let fact = e.out("fact.put", json!({"book":b,"key":"Raw","value":"before"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let h = e
        .ws()
        .library()
        .open_doc(&format!("book:{b}"), dr_store::OpenDoc::Existing)
        .unwrap();
    let id = fact.clone();
    h.write(dr_store::Origin::Sync, move |d| {
        let loro::ValueOrContainer::Container(loro::Container::Map(m)) =
            d.get_map("facts").get(&id).unwrap()
        else {
            panic!("map")
        };
        m.insert(
            "atomic",
            loro::LoroValue::Map(vec![("author".to_owned(), loro::LoroValue::from("keep"))].into()),
        )
        .unwrap();
        let text = m.ensure_mergeable_text("rich").unwrap();
        text.insert(0, "Retained").unwrap();
        text.mark(0..8, "bold", true).unwrap();
        let list = m.ensure_mergeable_movable_list("list").unwrap();
        list.insert(0, "Retained item").unwrap();
        m.ensure_mergeable_counter("counter")
            .unwrap()
            .increment(7.0)
            .unwrap();
    })
    .unwrap();
    let typed = || h.read(dr_doc::v3::raw_document_state).unwrap().unwrap()["facts"].clone();
    let before = typed();
    e.call("fact.remove", json!({"book":b,"id":fact}));
    e.ws().undo(&Actor::User).unwrap();
    assert_eq!(typed(), before);
    let id = fact.clone();
    h.write(dr_store::Origin::Sync, move |d| {
        let loro::ValueOrContainer::Container(loro::Container::Map(m)) =
            d.get_map("facts").get(&id).unwrap()
        else {
            panic!("map")
        };
        let tree = m
            .insert_container("future-tree", loro::LoroTree::new())
            .unwrap();
        let node = tree.create(None).unwrap();
        tree.get_meta(node)
            .unwrap()
            .insert("author", "Retained")
            .unwrap();
        m.insert("node_ref", node.to_string()).unwrap();
    })
    .unwrap();
    let old = e.out("entry_history.version", json!({"book":b}))["version"].clone();
    let id = fact.clone();
    h.write(dr_store::Origin::Sync, move |d| {
        let loro::ValueOrContainer::Container(loro::Container::Map(m)) =
            d.get_map("facts").get(&id).unwrap()
        else {
            panic!("map")
        };
        m.delete("future-tree").unwrap();
        m.insert("value", "new author value").unwrap();
    })
    .unwrap();
    let before = e.ws().observe(&format!("book:{b}")).unwrap();
    // A tree diff may need new node ids: reject the whole restore before any
    // live record changes rather than accepting a lossy raw reconstruction.
    assert!(
        e.try_call(
            "entry_history.restore",
            json!({"book":b,"at":old,"targets":[{"collection":"facts","id":fact}]})
        )
        .is_err()
    );
    let after = e.ws().observe(&format!("book:{b}")).unwrap();
    assert_eq!(after.version, before.version);
    assert_eq!(after.value, before.value);
}

#[test]
fn shared_anchored_links_are_canonical_and_refuse_foreign_or_richer_marks_prewrite() {
    let e = env();
    let b = e.book();
    let a = entry(&e, &b, "A");
    let z = entry(&e, &b, "Z");
    let doc = format!("body:{a}/mod-prose");
    let h = e
        .ws()
        .library()
        .open_doc(&doc, dr_store::OpenDoc::Existing)
        .unwrap();
    let anchor = h
        .read(|d| {
            dr_doc::Anchor::new(&d.get_text("body"), 0..4)
                .unwrap()
                .encode()
        })
        .unwrap();
    let args = json!({"links":[{"doc":doc,"target":{"kind":"entry","id":z},"anchors":[dr_workspace::dto::AnchorBytes::from(&anchor)]}]});
    assert_eq!(e.out("prose.link", args.clone())["ranges"], 1);
    assert!(
        e.out("prose.shape", json!({"doc":doc}))["paragraphs"]
            .as_u64()
            .unwrap()
            > 0
    );
    e.call("prose.unlink", args.clone());
    e.ws().undo(&Actor::User).unwrap();
    let material = e.out(
        "material.create",
        json!({"book":b,"kind":"text","title":"Synthetic link target","text":"Synthetic material"}),
    )["id"]
        .clone();
    let mut material_link = args.clone();
    material_link["links"][0]["target"] = json!({"kind":"material","id":material});
    assert_eq!(e.out("prose.link", material_link.clone())["ranges"], 1);
    let copied_doc = doc.clone();
    let copy = h
        .read(move |d| {
            let id = dr_model::DocId::parse(&copied_doc).unwrap();
            dr_doc::prose::BorrowedProse::new(d, &id)
                .unwrap()
                .view()
                .copy_entity_links_v3(0..4)
                .unwrap()
        })
        .unwrap();
    assert!(
        copy.marks()
            .iter()
            .any(|(_, key, _)| key == &format!("entity:{}", material.as_str().unwrap()))
    );
    e.call("prose.unlink", material_link);
    e.ws().undo(&Actor::User).unwrap();
    let foreign = e.book();
    let target = entry(&e, &foreign, "Foreign");
    let mut invalid = args.clone();
    invalid["links"][0]["target"]["id"] = json!(target);
    let before = e.ws().observe(&doc).unwrap();
    assert!(e.try_call("prose.link", invalid).is_err());
    assert_eq!(e.ws().observe(&doc).unwrap().version, before.version);
    let linked = z.clone();
    h.write(dr_store::Origin::Sync, move |d| {
        let t = d.get_text("body");
        let mut value = std::collections::BTreeMap::new();
        value.insert("kind".to_owned(), loro::LoroValue::from("entry"));
        value.insert("future-field".to_owned(), loro::LoroValue::from("opaque"));
        t.mark(
            0..4,
            &format!("entity:{linked}"),
            loro::LoroValue::Map(value.into_iter().collect::<Vec<_>>().into()),
        )
        .unwrap();
    })
    .unwrap();
    let before = e.ws().observe(&doc).unwrap();
    for command in ["prose.link", "prose.unlink"] {
        assert!(e.try_call(command, args.clone()).is_err());
        let after = e.ws().observe(&doc).unwrap();
        assert_eq!(
            (&after.version, &after.value),
            (&before.version, &before.value)
        );
    }
}
