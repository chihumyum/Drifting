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
#[test]
fn relation_history_restores_the_row_members_and_unknown_fields() {
    let e = env();
    let b = e.book();
    let a = entry(&e, &b, "A");
    let z = entry(&e, &b, "Z");
    let pair = e.out(
        "relation_row.create_pair",
        json!({"book":b,"left":a,"right":z,"new_type":{"name":"Pair","direction":"symmetric"}}),
    );
    let id = pair["id"].as_str().unwrap().to_owned();
    let key = id.clone();
    e.ws()
        .library()
        .open_doc(&format!("book:{b}"), dr_store::OpenDoc::Existing)
        .unwrap()
        .write(dr_store::Origin::Sync, move |d| {
            let row = d.get_map("relations").ensure_mergeable_map(&key).unwrap();
            row.insert("future-field", "opaque").unwrap();
        })
        .unwrap();
    let expected = raw(&e, &b)["relations"][&id].clone();
    e.call("relation_row.delete", json!({"book":b,"id":id}));
    e.ws().undo(&Actor::User).unwrap().unwrap();
    assert_eq!(raw(&e, &b)["relations"][&id], expected);
    assert_eq!(
        e.out("relation_type.list", json!({"book":b}))[0]["pair_count"],
        1
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
    let note = e.out(
        "entry.create",
        json!({
            "book": b,
            "template": "tpl-note",
            "title": "Synthetic link target",
            "bodies": {"mod-prose": "Synthetic note"}
        }),
    )["id"]
        .clone();
    let mut note_link = args.clone();
    note_link["links"][0]["target"] = json!({"kind": "entry", "id": note});
    assert_eq!(e.out("prose.link", note_link.clone())["ranges"], 1);
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
            .any(|(_, key, _)| key == &format!("entity:{}", note.as_str().unwrap()))
    );
    e.call("prose.unlink", note_link);
    e.ws().undo(&Actor::User).unwrap();
    let mut retired_material_link = args.clone();
    retired_material_link["links"][0]["target"] = json!({"kind": "material", "id": note});
    assert!(e.try_call("prose.link", retired_material_link).is_err());
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
