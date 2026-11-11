mod common;
use common::*;
use dr_workspace::{Actor, WritePreconditions, WsError};
use serde_json::{Value, json};

struct Fixture {
    e: Env,
    book: String,
    other: String,
    lanes: Vec<String>,
    leaves: Vec<String>,
}
impl Fixture {
    fn new() -> Self {
        let e = env();
        let book = e.out("project.create", json!({"name":"Timeline field edits"}))["id"]
            .as_str()
            .unwrap()
            .to_string();
        let other = e.out("project.create", json!({"name":"Untouched book"}))["id"]
            .as_str()
            .unwrap()
            .to_string();
        let entries = e.out("entry.list", json!({"book":book}));
        let root = |template| {
            entries
                .as_array()
                .unwrap()
                .iter()
                .find(|x| x["template"] == template)
                .unwrap()["id"]
                .clone()
        };
        let create = |parent: Value, template, title| {
            e.out(
                "entry.create",
                json!({"book":book,"parent":parent,"template":template,"title":title}),
            )["id"]
                .as_str()
                .unwrap()
                .to_string()
        };
        let lanes = ["A", "B", "Hidden", "Added"]
            .into_iter()
            .map(|title| create(root("tpl-storylines"), "tpl-storyline", title))
            .collect::<Vec<_>>();
        let leaves = ["Orphan", "Shared", "Hidden backup", "Hidden entry"]
            .into_iter()
            .map(|title| create(root("tpl-manuscript"), "tpl-chapter", title))
            .collect::<Vec<_>>();
        for (i, hosts) in [vec![0], vec![0, 1], vec![0, 2], vec![0]]
            .into_iter()
            .enumerate()
        {
            for host in hosts {
                e.call(
                    "membership.add",
                    json!({"book":book,"host":lanes[host],"member":leaves[i]}),
                );
            }
        }
        for id in ["edit-view", "other-view"] {
            e.call("timeline_view.put",json!({"book":book,"view":{"id":id,"name":"Original",
                "lanes":[{"entry":lanes[0],"pos":"a0"},{"entry":lanes[1],"pos":"a1"},{"entry":lanes[2],"pos":"a2"}],
                "placements":leaves.iter().enumerate().map(|(i,id)|json!({"entry":id,"at":i,"span":2})).collect::<Vec<_>>(),
                "pins":[{"id":"bound-pin","at":2,"label":"Keep binding","entry":leaves[3]}]}}));
        }
        e.call("entry.trash", json!({"book":book,"id":lanes[2]}));
        e.call("entry.trash", json!({"book":book,"id":leaves[3]}));
        let f = Self {
            e,
            book,
            other,
            lanes,
            leaves,
        };
        let lane = f.lanes[0].clone();
        f.edit_raw(move |v| {
            v.insert("future", json!({"unknown":[1,2,3]}).to_string())
                .unwrap();
            v.ensure_mergeable_map("lanes")
                .unwrap()
                .ensure_mergeable_map(&lane)
                .unwrap()
                .insert("future", "lane data")
                .unwrap();
            v.ensure_mergeable_map("placements")
                .unwrap()
                .insert("future-record", "unreadable but retained")
                .unwrap();
            v.ensure_mergeable_map("pins")
                .unwrap()
                .ensure_mergeable_map("bound-pin")
                .unwrap()
                .insert("future", "pin data")
                .unwrap();
        });
        f
    }
    fn raw(&self) -> Value {
        self.e
            .ws()
            .observe(&format!("book:{}", self.book))
            .unwrap()
            .value
    }
    fn edit_raw(&self, f: impl FnOnce(loro::LoroMap) + Send + 'static) {
        self.e
            .ws()
            .library()
            .open_doc(&format!("book:{}", self.book), dr_store::OpenDoc::Existing)
            .unwrap()
            .write(dr_store::Origin::Import, move |doc| {
                f(doc
                    .get_map("timeline_views")
                    .ensure_mergeable_map("edit-view")
                    .unwrap())
            })
            .unwrap();
    }
    fn call(&self, name: &str, mut args: Value) -> Value {
        args["book"] = json!(self.book);
        args["view"] = json!("edit-view");
        self.e.call(name, args)
    }
    fn undo(&self) {
        self.e.ws().undo(&Actor::User).unwrap().expect("undoable");
    }
}

#[test]
fn fields_and_their_undo_preserve_hidden_data_peer_edits_and_other_books() {
    let mut f = Fixture::new();
    let other = f.e.ws().observe(&format!("book:{}", f.other)).unwrap();
    let mut expected = f.raw();
    f.call("timeline_view.rename", json!({"name":"Renamed"}));
    expected["timeline_views"]["edit-view"]["name"] = json!("Renamed");
    assert_eq!(expected, f.raw());
    f.e.ws().call(&Actor::agent("peer",1,"pin"),"timeline_view.put_pin",json!({"book":f.book,"view":"edit-view","pin":{"id":"peer-pin","at":12,"label":"Independent"}})).unwrap();
    expected["timeline_views"]["edit-view"]["pins"]["peer-pin"] =
        f.raw()["timeline_views"]["edit-view"]["pins"]["peer-pin"].clone();
    f.undo();
    expected["timeline_views"]["edit-view"]["name"] = json!("Original");
    assert_eq!(expected, f.raw());

    f.call(
        "timeline_view.add_lane",
        json!({"lane":f.lanes[3],"place":{"before":f.lanes[1]}}),
    );
    expected["timeline_views"]["edit-view"]["lanes"][&f.lanes[3]] =
        f.raw()["timeline_views"]["edit-view"]["lanes"][&f.lanes[3]].clone();
    assert_eq!(expected, f.raw());
    f.undo();
    expected["timeline_views"]["edit-view"]["lanes"]
        .as_object_mut()
        .unwrap()
        .remove(&f.lanes[3]);
    assert_eq!(expected, f.raw());

    let old_pos = expected["timeline_views"]["edit-view"]["lanes"][&f.lanes[1]]["pos"].clone();
    f.call(
        "timeline_view.move_lane",
        json!({"lane":f.lanes[1],"place":"first"}),
    );
    expected["timeline_views"]["edit-view"]["lanes"][&f.lanes[1]]["pos"] =
        f.raw()["timeline_views"]["edit-view"]["lanes"][&f.lanes[1]]["pos"].clone();
    assert_eq!(expected, f.raw());
    let lane = f.lanes[1].clone();
    f.edit_raw(move |v| {
        let r = v
            .ensure_mergeable_map("lanes")
            .unwrap()
            .ensure_mergeable_map(&lane)
            .unwrap();
        let text = r.ensure_mergeable_text("peer").unwrap();
        text.insert(0, "retained on undo").unwrap();
        text.mark(0..4, "bold", true).unwrap();
    });
    expected["timeline_views"]["edit-view"]["lanes"][&f.lanes[1]]["peer"] =
        json!("retained on undo");
    f.undo();
    expected["timeline_views"]["edit-view"]["lanes"][&f.lanes[1]]["pos"] = old_pos;
    assert_eq!(expected, f.raw());

    let before_remove = expected.clone();
    f.call("timeline_view.remove_lane", json!({"lane":f.lanes[0]}));
    expected["timeline_views"]["edit-view"]["lanes"]
        .as_object_mut()
        .unwrap()
        .remove(&f.lanes[0]);
    expected["timeline_views"]["edit-view"]["placements"]
        .as_object_mut()
        .unwrap()
        .remove(&f.leaves[0]);
    // A raw hidden backup lane, an already hidden entry, unknown placement,
    // both pins, memberships and the other view all survive unchanged.
    assert_eq!(expected, f.raw());
    f.undo();
    assert_eq!(before_remove, f.raw());
    f.e.ws().redo(&Actor::User).unwrap().expect("redoable");
    assert_eq!(expected, f.raw());
    f.e.reopen();
    assert_eq!(expected, f.raw());
    let after_other = f.e.ws().observe(&other.doc).unwrap();
    assert_eq!(other.version, after_other.version);
    assert_eq!(other.value, after_other.value);
}

#[test]
fn independent_concurrent_edits_both_survive_and_stale_cas_refuses() {
    let f = Fixture::new();
    let before = f.raw();
    let stale = WritePreconditions::from_observations([f
        .e
        .ws()
        .observe(&format!("book:{}", f.book))
        .unwrap()]);
    let barrier = std::sync::Barrier::new(2);
    std::thread::scope(|s| {
        s.spawn(|| {
            barrier.wait();
            f.call("timeline_view.rename", json!({"name":"Concurrent rename"}));
        });
        s.spawn(|| {
            barrier.wait();
            f.e.ws()
                .call(
                    &Actor::agent("peer", 1, "add"),
                    "timeline_view.add_lane",
                    json!({"book":f.book,"view":"edit-view","lane":f.lanes[3]}),
                )
                .unwrap();
        });
    });
    let after = f.raw();
    let mut expected = before;
    expected["timeline_views"]["edit-view"]["name"] = json!("Concurrent rename");
    expected["timeline_views"]["edit-view"]["lanes"][&f.lanes[3]] =
        after["timeline_views"]["edit-view"]["lanes"][&f.lanes[3]].clone();
    assert_eq!(expected, after);
    for (name, args) in [
        ("timeline_view.rename", json!({"name":"Old input"})),
        ("timeline_view.add_lane", json!({"lane":f.lanes[3]})),
        (
            "timeline_view.move_lane",
            json!({"lane":f.lanes[0],"place":"last"}),
        ),
        ("timeline_view.remove_lane", json!({"lane":f.lanes[0]})),
    ] {
        let mut args = args;
        args["book"] = json!(f.book);
        args["view"] = json!("edit-view");
        assert!(matches!(
            f.e.ws()
                .call_guarded(&Actor::User, name, args, stale.clone()),
            Err(WsError::Conflict(_))
        ));
        assert_eq!(after, f.raw());
    }
}

#[test]
fn invalid_paths_and_unrepresentable_order_refuse_without_partial_writes() {
    let f = Fixture::new();
    let at =
        f.e.ws()
            .observe(&format!("book:{}", f.book))
            .unwrap()
            .version;
    f.call("timeline_view.rename", json!({"name":"Current"}));
    let before = f.raw();
    let result=f.e.try_call("timeline_view.restore_fields",json!({"book":f.book,"view":"edit-view","at":at,"expected":f.e.ws().observe(&format!("book:{}",f.book)).unwrap().version,"fields":[{"field":"name"},{"field":"lane_position","lane":"missing-lane"}]}));
    assert!(result.is_err());
    assert_eq!(before, f.raw());
    let lanes = f.lanes.clone();
    f.edit_raw(move |v| {
        let m = v.ensure_mergeable_map("lanes").unwrap();
        for lane in lanes.iter().take(2) {
            m.ensure_mergeable_map(lane)
                .unwrap()
                .insert("pos", "a0")
                .unwrap();
        }
    });
    let before = f.raw();
    // Equal neighbours leave no key between them; do not renumber either.
    let ordered = f.e.out("timeline_view.list", json!({"book":f.book}));
    let view = ordered
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == "edit-view")
        .unwrap();
    let second = view["lanes"][1]["entry"].clone();
    assert!(
        f.e.try_call(
            "timeline_view.add_lane",
            json!({"book":f.book,"view":"edit-view","lane":f.lanes[3],"place":{"before":second}})
        )
        .is_err()
    );
    assert_eq!(before, f.raw());
    f.e.ws()
        .library()
        .open_doc(&format!("book:{}", f.book), dr_store::OpenDoc::Existing)
        .unwrap()
        .write(dr_store::Origin::Import, |d| {
            d.get_map("timeline_views")
                .insert("edit-view", "future view format")
                .unwrap()
        })
        .unwrap();
    let before = f.raw();
    assert!(
        f.e.try_call(
            "timeline_view.rename",
            json!({"book":f.book,"view":"edit-view","name":"Do not replace unknown data"})
        )
        .is_err()
    );
    assert_eq!(before, f.raw());
}

fn no_change(f: &Fixture, action: impl FnOnce() -> dr_workspace::Result<serde_json::Value>) {
    let before = f.e.ws().observe(&format!("book:{}", f.book)).unwrap();
    let journal = serde_json::to_value(f.e.ws().journal(None, 100).unwrap()).unwrap();
    assert!(action().is_err());
    let after = f.e.ws().observe(&before.doc).unwrap();
    assert_eq!(before.version, after.version);
    assert_eq!(before.value, after.value);
    assert_eq!(
        journal,
        serde_json::to_value(f.e.ws().journal(None, 100).unwrap()).unwrap()
    );
}

#[test]
fn selected_field_takeovers_refuse_undo_and_redo_without_mutation() {
    for redo in [false, true] {
        for operation in ["rename", "add_lane", "move_lane", "remove_lane"] {
            let f = Fixture::new();
            let (args, peer_op, peer_args) = match operation {
                "rename" => (
                    json!({"name":"Renamed"}),
                    "rename",
                    json!({"name":"Peer name"}),
                ),
                "add_lane" if redo => (
                    json!({"lane":f.lanes[3]}),
                    "add_lane",
                    json!({"lane":f.lanes[3],"place":"first"}),
                ),
                "add_lane" => (
                    json!({"lane":f.lanes[3]}),
                    "move_lane",
                    json!({"lane":f.lanes[3],"place":"first"}),
                ),
                "move_lane" => (
                    json!({"lane":f.lanes[1],"place":"first"}),
                    "move_lane",
                    json!({"lane":f.lanes[1],"place":"last"}),
                ),
                "remove_lane" if redo => (
                    json!({"lane":f.lanes[0]}),
                    "move_lane",
                    json!({"lane":f.lanes[0],"place":"last"}),
                ),
                "remove_lane" => (
                    json!({"lane":f.lanes[0]}),
                    "add_lane",
                    json!({"lane":f.lanes[0],"place":"last"}),
                ),
                _ => unreachable!(),
            };
            f.call(&format!("timeline_view.{operation}"), args);
            if redo {
                f.undo();
            }
            let mut peer_args = peer_args;
            peer_args["book"] = json!(f.book);
            peer_args["view"] = json!("edit-view");
            f.e.ws()
                .call(
                    &Actor::agent("takeover", 1, "write"),
                    &format!("timeline_view.{peer_op}"),
                    peer_args,
                )
                .unwrap();
            no_change(&f, || {
                let r = if redo {
                    f.e.ws().redo(&Actor::User)
                } else {
                    f.e.ws().undo(&Actor::User)
                };
                r.map(|v| serde_json::to_value(v).unwrap())
            });
        }
    }
}

#[test]
fn first_lane_on_empty_view_undo_redo_and_reopen_do_not_restore_deleted_parent_records() {
    let mut f = Fixture::new();
    f.e.call(
        "timeline_view.put",
        json!({"book":f.book,"view":{"id":"empty","name":"Empty"}}),
    );
    f.e.call(
        "timeline_view.add_lane",
        json!({"book":f.book,"view":"empty","lane":f.lanes[3]}),
    );
    f.undo();
    f.e.reopen();
    f.e.ws().redo(&Actor::User).unwrap().expect("redo");
    let stored = f.raw();
    assert!(stored["timeline_views"]["empty"]["lanes"][&f.lanes[3]].is_object());
    f.edit_raw(|v| {
        v.delete("lanes").unwrap();
    });
    no_change(&f, || {
        f.e.try_call(
            "timeline_view.add_lane",
            json!({"book":f.book,"view":"edit-view","lane":f.lanes[3]}),
        )
    });
}

fn unsupported(parent: &loro::LoroMap, key: &str, representation: &str) {
    parent.delete(key).unwrap();
    match representation {
        "text" => {
            let t = parent.ensure_mergeable_text(key).unwrap();
            t.insert(0, "memo").unwrap();
            t.mark(0..4, "bold", true).unwrap();
        }
        "list" => {
            parent
                .ensure_mergeable_movable_list(key)
                .unwrap()
                .insert(0, "memo")
                .unwrap();
        }
        "atomic-map" => parent
            .insert(
                key,
                loro::LoroValue::Map(vec![("pos".into(), "a0".into())].into()),
            )
            .unwrap(),
        "string" => parent.insert(key, "memo").unwrap(),
        "null" => parent.insert(key, loro::LoroValue::Null).unwrap(),
        _ => unreachable!(),
    }
}

#[test]
fn raw_lane_records_and_rich_selected_metadata_refuse_before_any_write() {
    for representation in ["text", "list", "atomic-map", "string", "null"] {
        let f = Fixture::new();
        let lane = f.lanes[0].clone();
        f.edit_raw(move |v| {
            unsupported(
                &v.ensure_mergeable_map("lanes").unwrap(),
                &lane,
                representation,
            )
        });
        for op in ["add_lane", "move_lane", "remove_lane"] {
            no_change(&f, || {
                f.e.try_call(
                    &format!("timeline_view.{op}"),
                    json!({"book":f.book,"view":"edit-view","lane":f.lanes[0],"place":"last"}),
                )
            });
        }
    }
    // All positions scheduled for pruning are validated before deleting a lane.
    for placement in [false, true] {
        let f = Fixture::new();
        let id = if placement {
            f.leaves[0].clone()
        } else {
            f.lanes[0].clone()
        };
        f.edit_raw(move |v| {
            let record = v
                .ensure_mergeable_map(if placement { "placements" } else { "lanes" })
                .unwrap()
                .ensure_mergeable_map(&id)
                .unwrap();
            unsupported(&record, "future-rich", "text");
        });
        no_change(&f, || {
            f.e.try_call(
                "timeline_view.remove_lane",
                json!({"book":f.book,"view":"edit-view","lane":f.lanes[0]}),
            )
        });
    }
}

#[test]
fn offline_edits_to_deleted_lane_or_placement_are_not_erased_by_undo() {
    for placement in [false, true] {
        for rich in [false, true] {
            let f = Fixture::new();
            let handle =
                f.e.ws()
                    .library()
                    .open_doc(&format!("book:{}", f.book), dr_store::OpenDoc::Existing)
                    .unwrap();
            let peer = handle.read(|d| d.fork()).unwrap();
            let base = peer.oplog_vv();
            let key = if placement { &f.leaves[0] } else { &f.lanes[0] };
            let record = peer
                .get_map("timeline_views")
                .ensure_mergeable_map("edit-view")
                .unwrap()
                .ensure_mergeable_map(if placement { "placements" } else { "lanes" })
                .unwrap()
                .ensure_mergeable_map(key)
                .unwrap();
            if rich {
                unsupported(&record, "peer", "text");
            } else {
                record.insert("peer", "offline edit").unwrap();
            }
            peer.commit();
            let update = peer.export(loro::ExportMode::updates(&base)).unwrap();
            f.call("timeline_view.remove_lane", json!({"lane":f.lanes[0]}));
            handle
                .write(dr_store::Origin::Import, move |d| {
                    d.import(&update).unwrap();
                })
                .unwrap();
            assert!(
                f.raw()["timeline_views"]["edit-view"]
                    [if placement { "placements" } else { "lanes" }][key]
                    .is_null()
            );
            no_change(&f, || {
                f.e.ws()
                    .undo(&Actor::User)
                    .map(|v| serde_json::to_value(v).unwrap())
            });
        }
    }
}

#[test]
fn scalar_type_and_parent_identity_takeovers_refuse_even_with_identical_deep_values() {
    for mode in ["name", "position", "parent"] {
        let f = Fixture::new();
        f.call("timeline_view.rename", json!({"name":"memo"}));
        if mode == "name" {
            let before = f.raw();
            f.edit_raw(|v| unsupported(&v, "name", "text"));
            assert_eq!(before, f.raw());
        } else if mode == "position" {
            f.call(
                "timeline_view.move_lane",
                json!({"lane":f.lanes[1],"place":"first"}),
            );
            let before = f.raw();
            let lane = f.lanes[1].clone();
            let pos = before["timeline_views"]["edit-view"]["lanes"][&lane]["pos"]
                .as_str()
                .unwrap()
                .to_owned();
            f.edit_raw(move |v| {
                let r = v
                    .ensure_mergeable_map("lanes")
                    .unwrap()
                    .ensure_mergeable_map(&lane)
                    .unwrap();
                r.delete("pos").unwrap();
                let t = r.ensure_mergeable_text("pos").unwrap();
                t.insert(0, &pos).unwrap();
                t.mark(0..pos.len(), "bold", true).unwrap();
            });
            assert_eq!(before, f.raw());
        } else {
            f.call(
                "timeline_view.move_lane",
                json!({"lane":f.lanes[1],"place":"first"}),
            );
            let before = f.raw();
            f.edit_raw(|v| {
                let old = v.ensure_mergeable_map("lanes").unwrap().get_deep_value();
                let m = v.insert_container("lanes", loro::LoroMap::new()).unwrap();
                let loro::LoroValue::Map(records) = old else {
                    panic!("map")
                };
                for (key, val) in records.iter() {
                    let loro::LoroValue::Map(fields) = val else {
                        panic!("record")
                    };
                    let r = m.ensure_mergeable_map(key).unwrap();
                    for (k, v) in fields.iter() {
                        r.insert(k, v.clone()).unwrap();
                    }
                }
            });
            assert_eq!(before, f.raw());
        }
        no_change(&f, || {
            f.e.ws()
                .undo(&Actor::User)
                .map(|v| serde_json::to_value(v).unwrap())
        });
    }
}

#[test]
fn undo_name_preserves_an_independent_view_trash() {
    let f = Fixture::new();
    f.call("timeline_view.rename", json!({"name":"Renamed"}));
    f.e.ws()
        .call(
            &Actor::agent("trash", 1, "write"),
            "timeline_view.delete",
            json!({"book":f.book,"id":"edit-view"}),
        )
        .unwrap();
    let mut expected = f.raw();
    expected["timeline_views"]["edit-view"]["name"] = json!("Original");
    f.undo();
    assert_eq!(expected, f.raw());
}

#[test]
fn a_hidden_empty_parent_does_not_bypass_retained_child_preflight() {
    let f = Fixture::new();
    let lane = f.lanes[3].clone();
    f.edit_raw(move |v| {
        let lanes = v.ensure_mergeable_map("lanes").unwrap();
        let record = lanes.ensure_mergeable_map(&lane).unwrap();
        unsupported(&record, "future", "text");
        let keys: Vec<_> = lanes.keys().collect();
        for key in keys {
            lanes.delete(&key).unwrap();
        }
        v.delete("lanes").unwrap();
    });
    no_change(&f, || {
        f.e.try_call(
            "timeline_view.add_lane",
            json!({"book":f.book,"view":"edit-view","lane":f.lanes[3]}),
        )
    });
}

#[test]
fn set_lane_act_track_round_trips_preserves_siblings_and_undoes() {
    let f = Fixture::new();
    let lane = f.lanes[0].clone();
    let lane_clone = lane.clone();
    f.edit_raw(move |v| {
        v.ensure_mergeable_map("lanes")
            .unwrap()
            .ensure_mergeable_map(&lane_clone)
            .unwrap()
            .insert("future_lane_key", "retained")
            .unwrap();
    });
    let mut before = f.raw();
    f.call(
        "timeline_view.set_lane_act_track",
        json!({"lane": lane, "act_track": true}),
    );
    let mut toggled = before.clone();
    toggled["timeline_views"]["edit-view"]["lanes"][&lane]["act_track"] = json!(true);
    assert_eq!(toggled, f.raw());

    let listed = f.e.out("timeline_view.list", json!({"book": f.book}));
    let view = listed
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == "edit-view")
        .unwrap();
    let dto_lane = view["lanes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|l| l["entry"] == lane)
        .unwrap();
    assert_eq!(dto_lane["act_track"], json!(true));

    f.undo();
    assert_eq!(before, f.raw());
    f.e.ws().redo(&Actor::User).unwrap().expect("redoable");
    assert_eq!(toggled, f.raw());

    f.call(
        "timeline_view.set_lane_act_track",
        json!({"lane": lane, "act_track": false}),
    );
    assert_eq!(before, f.raw());

    // Adding a lane directly as an act track sets `act_track: true` in the same commit.
    f.call(
        "timeline_view.add_lane",
        json!({"lane": f.lanes[3], "place": "first", "act_track": true}),
    );
    let after_add = f.raw();
    assert_eq!(
        after_add["timeline_views"]["edit-view"]["lanes"][&f.lanes[3]]["act_track"],
        json!(true)
    );
    f.undo();
    assert_eq!(before, f.raw());
    before["timeline_views"]["edit-view"]["lanes"][&f.lanes[3]] =
        after_add["timeline_views"]["edit-view"]["lanes"][&f.lanes[3]].clone();
    f.e.ws().redo(&Actor::User).unwrap().expect("redoable");
    assert_eq!(before, f.raw());
}
