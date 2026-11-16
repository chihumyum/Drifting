mod common;
use common::*;
use dr_workspace::{Actor, WsError};
use serde_json::{Value, json};

fn item(v: Value) -> String {
    v["id"].as_str().unwrap().into()
}
fn root(e: &Env, b: &str, t: &str) -> Value {
    e.out("entry.list", json!({"book":b}))
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["template"] == t)
        .unwrap()["id"]
        .clone()
}
fn create(e: &Env, b: &str, t: &str, title: &str) -> String {
    let parent = root(
        e,
        b,
        if t == "tpl-storyline" {
            "tpl-storylines"
        } else {
            "tpl-manuscript"
        },
    );
    item(e.out(
        "entry.create",
        json!({"book":b,"parent":parent,"template":t,"title":title}),
    ))
}
/// Put `view` before every other view (the first view an entry is in
/// orders it, `kernel-v5.md` §4).
fn put_view_first(e: &Env, b: &str, view: &str) {
    let mut tv = e
        .out("timeline_view.list", json!({"book":b}))
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == view)
        .unwrap()
        .clone();
    let a0 = dr_model::pos::PosKey::parse("a0").unwrap();
    let first = dr_model::pos::PosKey::between(None, Some(&a0)).unwrap();
    tv["pos"] = json!(first.as_str());
    e.call("timeline_view.put", json!({"book":b,"view":tv}));
}
fn raw(e: &Env, b: &str) -> Value {
    e.ws().observe(&format!("book:{b}")).unwrap().value
}
fn imported(e: &Env, book: &str, f: impl FnOnce(&loro::LoroDoc) + Send + 'static) {
    e.ws()
        .library()
        .open_doc(&format!("book:{book}"), dr_store::OpenDoc::Existing)
        .unwrap()
        .write(dr_store::Origin::Import, f)
        .unwrap();
}

#[test]
fn removing_and_undoing_membership_preserves_peer_entry_and_timeline_fields() {
    let mut e = env();
    let b = item(e.out("project.create", json!({"name":"Scoped membership undo"})));
    let lane = create(&e, &b, "tpl-storyline", "Lane");
    let member = create(&e, &b, "tpl-chapter", "Member");
    let other = create(&e, &b, "tpl-chapter", "Other member");
    e.call(
        "timeline_view.put",
        json!({"book":b,"view":{"id":"scoped-view","name":"Original","lanes":[{"entry":lane}]}}),
    );
    for (entry, at) in [(&member, 41), (&other, 2)] {
        e.call(
            "timeline_view.place",
            json!({"book":b,"view":"scoped-view","entry":entry,"lane":lane,"at":at,"span":7}),
        );
    }
    e.call(
        "membership.primary",
        json!({"book":b,"member":member,"host":lane}),
    );
    let (l, m) = (lane.clone(), member.clone());
    imported(&e, &b, move |d| {
        let relation = d
            .get_map("memberships")
            .ensure_mergeable_map(&format!("{l}|{m}"))
            .unwrap();
        relation
            .ensure_mergeable_map("future")
            .unwrap()
            .insert("kept", "membership metadata")
            .unwrap();
        let placement = d
            .get_map("timeline_views")
            .ensure_mergeable_map("scoped-view")
            .unwrap()
            .ensure_mergeable_map("placements")
            .unwrap()
            .ensure_mergeable_map(&m)
            .unwrap();
        placement
            .ensure_mergeable_map("future")
            .unwrap()
            .insert("kept", "placement metadata")
            .unwrap();
    });
    let before = raw(&e, &b);
    let removed = e.call(
        "membership.remove",
        json!({"book":b,"host":lane,"member":member}),
    );
    assert_eq!(removed["undo"][0]["command"], "membership.restore");
    let actor = Actor::agent("independent", 1, "write");
    e.ws()
        .call(
            &actor,
            "entry.update",
            json!({"book":b,"id":member,"title":"Peer title"}),
        )
        .unwrap();
    e.ws().call(&actor,"timeline_view.put_pin",json!({"book":b,"view":"scoped-view","pin":{"id":"peer-pin","at":91,"label":"Peer pin"}})).unwrap();
    e.ws()
        .call(
            &actor,
            "timeline_view.place",
            json!({"book":b,"view":"scoped-view","entry":other,"at":99,"span":11}),
        )
        .unwrap();
    let after_peer = raw(&e, &b);
    e.ws().undo(&Actor::User).unwrap().expect("undo");
    assert_eq!(
        e.out("entry.get", json!({"book":b,"id":member}))["title"],
        "Peer title"
    );
    let undone = raw(&e, &b);
    let mut wanted = after_peer["timeline_views"]["scoped-view"].clone();
    wanted["placements"][&member] =
        before["timeline_views"]["scoped-view"]["placements"][&member].clone();
    assert_eq!(undone["timeline_views"]["scoped-view"], wanted);
    assert_eq!(undone["memberships"], before["memberships"]);
    assert_eq!(
        e.out("entry.get", json!({"book":b,"id":member}))["primary"],
        lane
    );
    e.ws().redo(&Actor::User).unwrap().expect("redo");
    assert_eq!(raw(&e, &b), after_peer);
    e.reopen();
    assert_eq!(raw(&e, &b), after_peer);
    e.ws().undo(&Actor::User).unwrap().expect("reopened undo");
    assert_eq!(raw(&e, &b), undone);
    e.ws().redo(&Actor::User).unwrap().expect("reopened redo");
    assert_eq!(raw(&e, &b), after_peer);
}

#[test]
fn cancellation_only_prunes_newly_orphaned_visible_positions_and_keeps_hidden_raw_backups() {
    use dr_workspace::WritePreconditions;
    let mut e = env();
    let b = item(e.out("project.create", json!({"name":"Retained timeline data"})));
    let other_book = item(e.out("project.create", json!({"name":"Other retained book"})));
    let other_before = e.ws().observe(&format!("book:{other_book}")).unwrap();
    let a = create(&e, &b, "tpl-storyline", "Visible A");
    let hidden = create(&e, &b, "tpl-storyline", "Hidden B");
    let absent = create(&e, &b, "tpl-storyline", "Absent membership");
    let entry = create(&e, &b, "tpl-chapter", "Member");
    for host in [&a, &hidden] {
        e.call(
            "membership.add",
            json!({"book":b,"host":host,"member":entry}),
        );
    }
    for (view, lanes) in [
        ("orphan", vec![&a]),
        ("unrelated-hidden", vec![&hidden]),
        ("hidden-backup", vec![&a, &hidden]),
        ("trashed-view", vec![&a]),
        ("unknown-position", vec![&a]),
    ] {
        e.call(
            "timeline_view.put",
            json!({"book":b,"view":{"id":view,"name":view,
            "lanes":lanes.iter().map(|id|json!({"entry":id})).collect::<Vec<_>>(),
            "placements":[{"entry":entry,"at":41,"span":7}],
            "pins":[{"id":"bound-pin","at":9,"label":"Retain binding","entry":hidden}]}}),
        );
    }
    e.call("entry.trash", json!({"book":b,"id":hidden}));
    e.call(
        "timeline_view.delete",
        json!({"book":b,"id":"trashed-view"}),
    );
    let id = entry.clone();
    imported(&e, &b, move |d| {
        let views = d.get_map("timeline_views");
        for view in [
            "orphan",
            "unrelated-hidden",
            "hidden-backup",
            "trashed-view",
            "unknown-position",
        ] {
            views
                .ensure_mergeable_map(view)
                .unwrap()
                .insert("future", "retain unknown view field")
                .unwrap();
        }
        views
            .ensure_mergeable_map("unknown-position")
            .unwrap()
            .ensure_mergeable_map("placements")
            .unwrap()
            .ensure_mergeable_map(&id)
            .unwrap()
            .insert("at", "future coordinate type")
            .unwrap();
    });
    let before = e.ws().observe(&format!("book:{b}")).unwrap();
    let noop = e.call(
        "membership.remove",
        json!({"book":b,"host":absent,"member":entry}),
    );
    assert!(noop["journal"].is_null());
    assert_eq!(before.version, e.ws().observe(&before.doc).unwrap().version);
    // The timeline command is the second public entry point for cancellation.
    let result = e
        .ws()
        .call_guarded(
            &Actor::User,
            "timeline_view.remove",
            json!({"book":b,"view":"orphan","lane":a,"entry":entry}),
            WritePreconditions::from_observations([before.clone()]),
        )
        .unwrap();
    assert!(result["journal"].is_number());
    let mut expected = before.value.clone();
    expected["memberships"]
        .as_object_mut()
        .unwrap()
        .remove(&format!("{a}|{entry}"));
    expected["timeline_views"]["orphan"]["placements"]
        .as_object_mut()
        .unwrap()
        .remove(&entry);
    assert_eq!(expected, raw(&e, &b));
    e.ws().undo(&Actor::User).unwrap().expect("undo");
    assert_eq!(before.value, raw(&e, &b));
    e.ws().redo(&Actor::User).unwrap().expect("redo");
    assert_eq!(expected, raw(&e, &b));
    e.reopen();
    assert_eq!(expected, raw(&e, &b));
    e.call("entry.restore", json!({"book":b,"id":hidden}));
    let visible = e.out("timeline_view.list", json!({"book":b}));
    for id in ["unrelated-hidden", "hidden-backup"] {
        let v = visible
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == id)
            .unwrap();
        assert_eq!(v["placements"][0]["at"], 41.0);
        assert_eq!(v["placements"][0]["span"], 7.0);
        assert_eq!(v["pins"][0]["entry"], hidden);
    }
    let after_other = e.ws().observe(&other_before.doc).unwrap();
    assert_eq!(other_before.version, after_other.version);
    assert_eq!(other_before.value, after_other.value);
}

#[test]
fn restoration_and_cancellation_preflight_all_paths_before_any_write() {
    let e = env();
    let b = item(e.out("project.create", json!({"name":"Preflight cancellation"})));
    let lane = create(&e, &b, "tpl-storyline", "Lane");
    let entry = create(&e, &b, "tpl-chapter", "Member");
    e.call(
        "membership.add",
        json!({"book":b,"host":lane,"member":entry}),
    );
    e.call(
        "membership.primary",
        json!({"book":b,"member":entry,"host":lane}),
    );
    for view in ["first", "last"] {
        e.call("timeline_view.put",json!({"book":b,"view":{"id":view,"name":view,"lanes":[{"entry":lane}],"placements":[{"entry":entry,"at":4}]}}));
    }
    let at = e.ws().observe(&format!("book:{b}")).unwrap().version;
    let raw_positions = raw(&e, &b)["timeline_views"]["last"]["placements"].clone();
    imported(&e, &b, move |d| {
        // Readable deep map with an unknown storage representation. Reject
        // before deleting the relation, primary or any earlier placement.
        let value: loro::LoroValue = serde_json::from_value(raw_positions).unwrap();
        d.get_map("timeline_views")
            .ensure_mergeable_map("last")
            .unwrap()
            .insert("placements", value)
            .unwrap();
    });
    let before = e.ws().observe(&format!("book:{b}")).unwrap();
    for (name, input) in [
        (
            "membership.remove",
            json!({"book":b,"host":lane,"member":entry}),
        ),
        (
            "membership.restore",
            json!({"book":b,"host":lane,"member":entry,"at":at,"expected":at,"membership":true,"primary":true,"views":["first","last"]}),
        ),
    ] {
        assert!(e.try_call(name, input).is_err());
        assert_eq!(before.version, e.ws().observe(&before.doc).unwrap().version);
        assert_eq!(before.value, raw(&e, &b));
    }
}

#[test]
fn stale_cancellation_and_restore_refuse_before_validating_the_newer_member_state() {
    use dr_workspace::WritePreconditions;
    let e = env();
    let b = item(e.out("project.create", json!({"name":"Guarded cancellation"})));
    let lane = create(&e, &b, "tpl-storyline", "Lane");
    let member = create(&e, &b, "tpl-chapter", "Member");
    e.call(
        "membership.add",
        json!({"book":b,"host":lane,"member":member}),
    );
    let observation = e.ws().observe(&format!("book:{b}")).unwrap();
    let at = observation.version.clone();
    let guards = WritePreconditions::from_observations([observation]);
    e.ws()
        .call(
            &Actor::agent("peer", 1, "trash"),
            "entry.trash",
            json!({"book":b,"id":member}),
        )
        .unwrap();
    let newer = e.ws().observe(&format!("book:{b}")).unwrap();
    for (name, input) in [
        (
            "membership.remove",
            json!({"book":b,"host":lane,"member":member}),
        ),
        (
            "membership.restore",
            json!({"book":b,"host":lane,"member":member,"at":at,"expected":at,"membership":true,"primary":true,"views":[]}),
        ),
    ] {
        assert!(matches!(
            e.ws()
                .call_guarded(&Actor::User, name, input, guards.clone()),
            Err(WsError::Conflict(_))
        ));
        assert_eq!(newer.version, e.ws().observe(&newer.doc).unwrap().version);
        assert_eq!(newer.value, raw(&e, &b));
    }
}

#[test]
fn cancellation_preserves_selected_container_types_or_refuses_before_removing_anything() {
    use loro::{Container, ValueOrContainer};
    let mut lost = Vec::new();
    for in_placement in [false, true] {
        for text_container in [false, true] {
            let e = env();
            let b = item(e.out("project.create", json!({"name":"Typed unknown containers"})));
            let lane = create(&e, &b, "tpl-storyline", "Lane");
            let member = create(&e, &b, "tpl-chapter", "Member");
            e.call("timeline_view.put", json!({"book":b,"view":{"id":"typed-view","name":"Typed","lanes":[{"entry":lane}]}}));
            e.call(
                "timeline_view.place",
                json!({"book":b,"view":"typed-view","entry":member,"lane":lane,"at":41,"span":7}),
            );
            e.call(
                "membership.primary",
                json!({"book":b,"member":member,"host":lane}),
            );
            let (l, m) = (lane.clone(), member.clone());
            imported(&e, &b, move |d| {
                let record = if in_placement {
                    d.get_map("timeline_views")
                        .ensure_mergeable_map("typed-view")
                        .unwrap()
                        .ensure_mergeable_map("placements")
                        .unwrap()
                        .ensure_mergeable_map(&m)
                        .unwrap()
                } else {
                    d.get_map("memberships")
                        .ensure_mergeable_map(&format!("{l}|{m}"))
                        .unwrap()
                };
                let future = record.ensure_mergeable_map("future").unwrap();
                if text_container {
                    let note = future.ensure_mergeable_text("note").unwrap();
                    note.insert(0, "memo").unwrap();
                    note.mark(0..4, "bold", true).unwrap();
                } else {
                    let list = future.ensure_mergeable_movable_list("ordered").unwrap();
                    list.insert(0, "first").unwrap();
                    list.insert(1, "second").unwrap();
                    list.mov(1, 0).unwrap();
                }
            });
            let before = e.ws().observe(&format!("book:{b}")).unwrap();
            let result = e.try_call(
                "membership.remove",
                json!({"book":b,"host":lane,"member":member}),
            );
            if result.is_ok() {
                e.ws()
                    .undo(&Actor::User)
                    .unwrap()
                    .expect("undo cancellation");
            } else {
                let after = e.ws().observe(&before.doc).unwrap();
                assert_eq!(after.version, before.version);
                assert_eq!(after.value, before.value);
            }
            // Verify real container types and formatting, not just deep JSON.
            let faithful = e
                .ws()
                .library()
                .open_doc(&before.doc, dr_store::OpenDoc::Existing)
                .unwrap()
                .read(move |d| {
                    let record = if in_placement {
                        d.get_map("timeline_views")
                            .ensure_mergeable_map("typed-view")
                            .unwrap()
                            .ensure_mergeable_map("placements")
                            .unwrap()
                            .ensure_mergeable_map(&member)
                            .unwrap()
                    } else {
                        d.get_map("memberships")
                            .ensure_mergeable_map(&format!("{lane}|{member}"))
                            .unwrap()
                    };
                    let future = record.ensure_mergeable_map("future").unwrap();
                    if text_container {
                        let Some(ValueOrContainer::Container(Container::Text(note))) =
                            future.get("note")
                        else {
                            return false;
                        };
                        note.to_string() == "memo"
                            && format!("{:?}", note.to_delta()).contains("bold")
                    } else {
                        let Some(ValueOrContainer::Container(Container::MovableList(list))) =
                            future.get("ordered")
                        else {
                            return false;
                        };
                        list.get(0).unwrap().get_deep_value() == loro::LoroValue::from("second")
                    }
                })
                .unwrap();
            if !faithful {
                lost.push((in_placement, text_container));
            }
        }
    }
    assert!(
        lost.is_empty(),
        "lost actual container type/formatting (placement,text): {lost:?}"
    );
}

#[test]
fn redo_refuses_a_rich_container_takeover_even_when_deep_json_is_identical() {
    let e = env();
    let b = item(e.out("project.create", json!({"name":"Typed takeover"})));
    let lane = create(&e, &b, "tpl-storyline", "Lane");
    let member = create(&e, &b, "tpl-chapter", "Member");
    e.call(
        "timeline_view.put",
        json!({"book":b,"view":{"id":"typed-takeover","name":"Typed","lanes":[{"entry":lane}]}}),
    );
    e.call(
        "timeline_view.place",
        json!({"book":b,"view":"typed-takeover","entry":member,"lane":lane,"at":41,"span":7}),
    );
    let m = member.clone();
    imported(&e, &b, move |d| {
        d.get_map("timeline_views")
            .ensure_mergeable_map("typed-takeover")
            .unwrap()
            .ensure_mergeable_map("placements")
            .unwrap()
            .ensure_mergeable_map(&m)
            .unwrap()
            .insert("future", "memo")
            .unwrap();
    });
    e.call(
        "membership.remove",
        json!({"book":b,"host":lane,"member":member}),
    );
    e.ws().undo(&Actor::User).unwrap().expect("undo");
    let before_typed = raw(&e, &b);
    let m = member.clone();
    imported(&e, &b, move |d| {
        let record = d
            .get_map("timeline_views")
            .ensure_mergeable_map("typed-takeover")
            .unwrap()
            .ensure_mergeable_map("placements")
            .unwrap()
            .ensure_mergeable_map(&m)
            .unwrap();
        record.delete("future").unwrap();
        let note = record.ensure_mergeable_text("future").unwrap();
        note.insert(0, "memo").unwrap();
        note.mark(0..4, "bold", true).unwrap();
    });
    let before = e.ws().observe(&format!("book:{b}")).unwrap();
    assert_eq!(
        before.value, before_typed,
        "deep JSON cannot detect this takeover"
    );
    assert!(e.ws().redo(&Actor::User).is_err());
    let after = e.ws().observe(&before.doc).unwrap();
    assert_eq!(after.version, before.version);
    assert_eq!(after.value, before.value);
}

#[test]
fn unsupported_membership_root_is_refused_before_primary_or_journal_changes() {
    let mut failures = Vec::new();
    for representation in ["text", "atomic-map", "string", "null", "list"] {
        for primary in [false, true] {
            let e = env();
            let b = item(e.out("project.create", json!({"name":"Raw membership root"})));
            let lane = create(&e, &b, "tpl-storyline", "Lane");
            let member = create(&e, &b, "tpl-chapter", "Member");
            e.call(
                "membership.add",
                json!({"book":b,"host":lane,"member":member}),
            );
            if primary {
                e.call(
                    "membership.primary",
                    json!({"book":b,"host":lane,"member":member}),
                );
            }
            let key = format!("{lane}|{member}");
            imported(&e, &b, move |d| {
                let root = d.get_map("memberships");
                root.delete(&key).unwrap();
                match representation {
                    "text" => {
                        let note = root.ensure_mergeable_text(&key).unwrap();
                        note.insert(0, "memo").unwrap();
                        note.mark(0..4, "bold", true).unwrap();
                    }
                    "atomic-map" => root
                        .insert(
                            &key,
                            loro::LoroValue::Map(vec![("future".into(), "preserve".into())].into()),
                        )
                        .unwrap(),
                    "string" => root.insert(&key, "future format").unwrap(),
                    "null" => root.insert(&key, loro::LoroValue::Null).unwrap(),
                    "list" => {
                        root.ensure_mergeable_movable_list(&key)
                            .unwrap()
                            .insert(0, "preserve")
                            .unwrap();
                    }
                    _ => unreachable!(),
                }
            });
            let before = e.ws().observe(&format!("book:{b}")).unwrap();
            let journal = serde_json::to_value(e.ws().journal(None, 100).unwrap()).unwrap();
            let result = e.try_call(
                "membership.remove",
                json!({"book":b,"host":lane,"member":member}),
            );
            let after = e.ws().observe(&before.doc).unwrap();
            let changed = before.version != after.version || before.value != after.value;
            let journal_changed =
                journal != serde_json::to_value(e.ws().journal(None, 100).unwrap()).unwrap();
            if result.is_ok() || changed || journal_changed {
                failures.push((representation, primary, changed, journal_changed));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "unsafe raw membership roots (representation, primary, data_changed, journal_changed): {failures:?}"
    );
}

#[test]
fn undo_keeps_concurrent_peer_edits_to_the_cancelled_record() {
    for placement in [false, true] {
        for rich in [false, true] {
            let e = env();
            let b = item(e.out(
                "project.create",
                json!({"name":"Concurrent record takeover"}),
            ));
            let lane = create(&e, &b, "tpl-storyline", "Lane");
            let member = create(&e, &b, "tpl-chapter", "Member");
            e.call("timeline_view.put", json!({"book":b,"view":{"id":"detached-view","name":"Detached","lanes":[{"entry":lane}]}}));
            e.call(
            "timeline_view.place",
            json!({"book":b,"view":"detached-view","entry":member,"lane":lane,"at":41,"span":7}),
        );
            let peer = e
                .ws()
                .library()
                .open_doc(&format!("book:{b}"), dr_store::OpenDoc::Existing)
                .unwrap()
                .read(|d| d.fork())
                .unwrap();
            let base = peer.oplog_vv();
            let record = if placement {
                peer.get_map("timeline_views")
                    .ensure_mergeable_map("detached-view")
                    .unwrap()
                    .ensure_mergeable_map("placements")
                    .unwrap()
                    .ensure_mergeable_map(&member)
                    .unwrap()
            } else {
                peer.get_map("memberships")
                    .ensure_mergeable_map(&format!("{lane}|{member}"))
                    .unwrap()
            };
            if rich {
                let note = record.ensure_mergeable_text("peer").unwrap();
                note.insert(0, "retained edit").unwrap();
                note.mark(0..4, "bold", true).unwrap();
            } else {
                record.insert("peer", "retained edit").unwrap();
            }
            peer.commit();
            let updates = peer.export(loro::ExportMode::updates(&base)).unwrap();
            e.call(
                "membership.remove",
                json!({"book":b,"host":lane,"member":member}),
            );
            imported(&e, &b, move |d| {
                d.import(&updates).unwrap();
            });
            let before = e.ws().observe(&format!("book:{b}")).unwrap();
            let result = e.ws().undo(&Actor::User);
            let after = e.ws().observe(&before.doc).unwrap();
            if result.is_ok() {
                let record = if placement {
                    &after.value["timeline_views"]["detached-view"]["placements"][&member]
                } else {
                    &after.value["memberships"][format!("{lane}|{member}")]
                };
                assert_eq!(
                    record["peer"], "retained edit",
                    "undo erased a concurrent peer edit, placement={placement}"
                );
            } else {
                assert_eq!(before.value, after.value);
                assert_eq!(before.version, after.version);
            }
        }
    }
}

#[test]
fn redo_refuses_replaced_placement_parent_identity_without_touching_other_positions() {
    let e = env();
    let b = item(e.out(
        "project.create",
        json!({"name":"Placement parent identity"}),
    ));
    let lane = create(&e, &b, "tpl-storyline", "Lane");
    let member = create(&e, &b, "tpl-chapter", "Member");
    e.call(
        "timeline_view.put",
        json!({"book":b,"view":{"id":"parent-view","name":"Parent","lanes":[{"entry":lane}]}}),
    );
    e.call(
        "timeline_view.place",
        json!({"book":b,"view":"parent-view","entry":member,"lane":lane,"at":41,"span":7}),
    );
    e.call(
        "membership.remove",
        json!({"book":b,"host":lane,"member":member}),
    );
    e.ws().undo(&Actor::User).unwrap().expect("undo");
    let value = raw(&e, &b);
    let position: loro::LoroValue = serde_json::from_value(
        value["timeline_views"]["parent-view"]["placements"][&member].clone(),
    )
    .unwrap();
    imported(&e, &b, move |d| {
        let view = d
            .get_map("timeline_views")
            .ensure_mergeable_map("parent-view")
            .unwrap();
        let parent = view
            .insert_container("placements", loro::LoroMap::new())
            .unwrap();
        let record = parent.ensure_mergeable_map(&member).unwrap();
        let loro::LoroValue::Map(fields) = position else {
            panic!("position map")
        };
        for (key, val) in fields.iter() {
            record.insert(key, val.clone()).unwrap();
        }
    });
    let before = e.ws().observe(&format!("book:{b}")).unwrap();
    assert_eq!(
        before.value, value,
        "same values, different parent identity"
    );
    assert!(e.ws().redo(&Actor::User).is_err());
    let after = e.ws().observe(&before.doc).unwrap();
    assert_eq!(after.version, before.version);
    assert_eq!(after.value, before.value);
}

#[test]
fn joining_a_lane_or_adding_a_lane_to_a_view_places_members_at_scale_end_without_pos() {
    let e = env();
    let b = item(e.out("project.create", json!({"name":"View scale end"})));
    let lane = create(&e, &b, "tpl-storyline", "Lane in two views");
    let plain_lane = create(&e, &b, "tpl-storyline", "Lane added later");
    let seed = create(&e, &b, "tpl-chapter", "Seed");
    let joined = create(&e, &b, "tpl-chapter", "Joined");
    let m1 = create(&e, &b, "tpl-chapter", "Existing 1");
    let m2 = create(&e, &b, "tpl-chapter", "Existing 2");

    // Plain host (not in any view yet) keeps `membership.pos` order (`m2` before `m1`).
    e.call(
        "membership.add",
        json!({"book":b,"host":plain_lane,"member":m1,"pos":"a9"}),
    );
    e.call(
        "membership.add",
        json!({"book":b,"host":plain_lane,"member":m2,"pos":"a0"}),
    );

    e.call(
        "timeline_view.put",
        json!({"book":b,"view":{"id":"v1","name":"V1","pos":"a0","lanes":[{"entry":lane,"pos":"a0"}]}}),
    );
    e.call(
        "timeline_view.put",
        json!({"book":b,"view":{"id":"v2","name":"V2","pos":"a1","lanes":[{"entry":lane,"pos":"a0"}]}}),
    );
    // `timeline_view.place` joining `lane` in `v1` at (10, span 4) also auto-places `seed` in `v2` at 0.0.
    e.call(
        "timeline_view.place",
        json!({"book":b,"view":"v1","entry":seed,"lane":lane,"at":10,"span":4}),
    );
    assert_eq!(
        raw(&e, &b)["timeline_views"]["v2"]["placements"][&seed]["at"],
        0.0
    );

    // 1. `membership.add` on `lane` (in `v1` and `v2`) ignores `pos` and places `joined`
    //    at scale end in both views (`15.0` in `v1`, `1.0` in `v2`).
    let added = e.call(
        "membership.add",
        json!({"book":b,"host":lane,"member":joined,"pos":"z9"}),
    );
    assert_eq!(added["undo"][0]["command"], "membership.restore");
    let state = raw(&e, &b);
    let mkey = format!("{lane}|{joined}");
    assert!(
        state["memberships"][&mkey].get("pos").is_none(),
        "lane in view must not write membership.pos"
    );
    assert_eq!(
        state["timeline_views"]["v1"]["placements"][&joined]["at"],
        15.0
    );
    assert_eq!(
        state["timeline_views"]["v2"]["placements"][&joined]["at"],
        1.0
    );

    // Re-calling `membership.add` with `pos` on a lane in views is a no-op.
    let noop = e.call(
        "membership.add",
        json!({"book":b,"host":lane,"member":joined,"pos":"a0"}),
    );
    assert!(noop["journal"].is_null());
    assert!(raw(&e, &b)["memberships"][&mkey].get("pos").is_none());

    // Field-scoped undo/redo preserves concurrent peer pins in `v1`.
    let peer = Actor::agent("peer", 1, "pin");
    e.ws()
        .call(
            &peer,
            "timeline_view.put_pin",
            json!({"book":b,"view":"v1","pin":{"id":"p1","at":3,"label":"Keep"}}),
        )
        .unwrap();
    e.ws().undo(&Actor::User).unwrap().expect("undo add");
    let undone = raw(&e, &b);
    assert!(undone["memberships"].get(&mkey).is_none());
    assert!(
        undone["timeline_views"]["v1"]["placements"]
            .get(&joined)
            .is_none()
    );
    assert!(
        undone["timeline_views"]["v2"]["placements"]
            .get(&joined)
            .is_none()
    );
    assert_eq!(
        undone["timeline_views"]["v1"]["pins"]["p1"]["label"],
        "Keep"
    );
    e.ws().redo(&Actor::User).unwrap().expect("redo add");
    assert_eq!(
        raw(&e, &b)["timeline_views"]["v1"]["placements"][&joined]["at"],
        15.0
    );
    assert_eq!(
        raw(&e, &b)["timeline_views"]["v2"]["placements"][&joined]["at"],
        1.0
    );

    // 2. `entry.create` hosted on `lane` auto-places the new entry at scale end in `v1` and `v2`.
    let direct = item(e.out(
        "entry.create",
        json!({"book":b,"host":lane,"template":"tpl-chapter","title":"Direct in lane"}),
    ));
    let state = raw(&e, &b);
    assert!(
        state["memberships"][format!("{lane}|{direct}")]
            .get("pos")
            .is_none()
    );
    assert_eq!(
        state["timeline_views"]["v1"]["placements"][&direct]["at"],
        16.0
    );
    assert_eq!(
        state["timeline_views"]["v2"]["placements"][&direct]["at"],
        2.0
    );

    // 3. `timeline_view.add_lane` places existing members (`m2`, `m1`) sequentially at scale end,
    //    and field-scoped undo/redo removes and restores both the lane and those placements.
    e.call(
        "timeline_view.add_lane",
        json!({"book":b,"view":"v1","lane":plain_lane}),
    );
    let state = raw(&e, &b);
    assert_eq!(state["timeline_views"]["v1"]["placements"][&m2]["at"], 17.0);
    assert_eq!(state["timeline_views"]["v1"]["placements"][&m1]["at"], 18.0);
    e.ws().undo(&Actor::User).unwrap().expect("undo add_lane");
    let undone = raw(&e, &b);
    assert!(
        undone["timeline_views"]["v1"]["lanes"]
            .get(&plain_lane)
            .is_none()
    );
    assert!(
        undone["timeline_views"]["v1"]["placements"]
            .get(&m2)
            .is_none()
    );
    assert!(
        undone["timeline_views"]["v1"]["placements"]
            .get(&m1)
            .is_none()
    );
    e.ws().redo(&Actor::User).unwrap().expect("redo add_lane");
    assert_eq!(
        raw(&e, &b)["timeline_views"]["v1"]["placements"][&m2]["at"],
        17.0
    );
    assert_eq!(
        raw(&e, &b)["timeline_views"]["v1"]["placements"][&m1]["at"],
        18.0
    );

    // 4. `entry.get` (`below.members`) follows `v1`, the first view the lane
    //    is in, and switches to `v2` when `v2` comes first.
    e.call(
        "timeline_view.place",
        json!({"book":b,"view":"v2","entry":direct,"at":-5}),
    );
    let below_ids = |host_id: &str| -> Vec<String> {
        e.out("entry.get", json!({"book":b,"id":host_id}))["below"]["members"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x["id"].as_str().unwrap().to_owned())
            .collect()
    };
    assert_eq!(
        below_ids(&lane),
        vec![seed.clone(), joined.clone(), direct.clone()]
    );
    put_view_first(&e, &b, "v2");
    assert_eq!(below_ids(&lane), vec![direct, seed, joined]);
}

#[test]
fn lane_entering_and_leaving_views_preserves_order_and_undoes_in_one_step() {
    let e = env();
    let b = item(e.out("project.create", json!({"name":"Lane enter/exit order"})));
    let cat = e
        .out("entry.list", json!({"book":b,"all":true}))
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["template"] == "tpl-category")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let m1 = create(&e, &b, "tpl-chapter", "First");
    let m2 = create(&e, &b, "tpl-chapter", "Second");
    let m3 = create(&e, &b, "tpl-chapter", "Third");
    let m4 = create(&e, &b, "tpl-chapter", "Fourth");

    // Manual membership order on `cat`: `[m2, m3, m1]`.
    e.call(
        "membership.add",
        json!({"book":b,"host":cat,"member":m1,"pos":"a2"}),
    );
    e.call(
        "membership.add",
        json!({"book":b,"host":cat,"member":m2,"pos":"a0"}),
    );
    e.call(
        "membership.add",
        json!({"book":b,"host":cat,"member":m3,"pos":"a1"}),
    );
    let below_members = |host: &str| -> Vec<String> {
        e.out("entry.get", json!({"book":b,"id":host}))["below"]["members"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x["id"].as_str().unwrap().to_owned())
            .collect()
    };
    assert_eq!(
        below_members(&cat),
        vec![m2.clone(), m3.clone(), m1.clone()]
    );

    // Entering `v1` places existing members on the scale in that exact manual order.
    e.call(
        "timeline_view.put",
        json!({"book":b,"view":{"id":"v1","name":"V1","pos":"a0","lanes":[]}}),
    );
    e.call(
        "timeline_view.add_lane",
        json!({"book":b,"view":"v1","lane":cat}),
    );
    let state = raw(&e, &b);
    let at_m2 = state["timeline_views"]["v1"]["placements"][&m2]["at"]
        .as_f64()
        .unwrap();
    let at_m3 = state["timeline_views"]["v1"]["placements"][&m3]["at"]
        .as_f64()
        .unwrap();
    let at_m1 = state["timeline_views"]["v1"]["placements"][&m1]["at"]
        .as_f64()
        .unwrap();
    assert!(at_m2 < at_m3 && at_m3 < at_m1);
    assert_eq!(
        below_members(&cat),
        vec![m2.clone(), m3.clone(), m1.clone()]
    );

    // Add `m4` and scramble placements to `[m4, m1, m2, m3]`.
    e.call("membership.add", json!({"book":b,"host":cat,"member":m4}));
    e.call(
        "timeline_view.place",
        json!({"book":b,"view":"v1","entry":m4,"at":-10}),
    );
    e.call(
        "timeline_view.place",
        json!({"book":b,"view":"v1","entry":m1,"at":-5}),
    );
    assert_eq!(
        below_members(&cat),
        vec![m4.clone(), m1.clone(), m2.clone(), m3.clone()]
    );

    // When `cat` is ALSO in `v2`, removing it from `v2` does NOT write `membership.pos`.
    e.call(
        "timeline_view.put",
        json!({"book":b,"view":{"id":"v2","name":"V2","pos":"a1","lanes":[{"entry":cat}]}}),
    );
    let pos_before_partial_exit = raw(&e, &b)["memberships"].clone();
    e.call(
        "timeline_view.remove_lane",
        json!({"book":b,"view":"v2","lane":cat}),
    );
    assert_eq!(raw(&e, &b)["memberships"], pos_before_partial_exit);

    // Removing `cat` from `v1` (its last live view) writes the scale order `[m4, m1, m2, m3]`
    // back to `membership.pos` in the same commit; 1-step undo puts `cat` and its placements
    // back in `v1` and restores previous `memberships`.
    let before_exit = raw(&e, &b);
    e.call(
        "timeline_view.remove_lane",
        json!({"book":b,"view":"v1","lane":cat}),
    );
    assert_eq!(
        below_members(&cat),
        vec![m4.clone(), m1.clone(), m2.clone(), m3.clone()]
    );
    assert!(
        raw(&e, &b)["memberships"][format!("{cat}|{m4}")]["pos"].is_string(),
        "leaving last view must write membership.pos for newly added member"
    );
    e.ws()
        .undo(&Actor::User)
        .unwrap()
        .expect("undo remove_lane");
    assert_eq!(raw(&e, &b), before_exit);
    assert_eq!(
        below_members(&cat),
        vec![m4.clone(), m1.clone(), m2.clone(), m3.clone()]
    );

    // Leaving the last live view via `timeline_view.delete` also writes back `pos` and undoes in 1 step.
    e.call("timeline_view.delete", json!({"book":b,"id":"v1"}));
    assert_eq!(
        below_members(&cat),
        vec![m4.clone(), m1.clone(), m2.clone(), m3.clone()]
    );
    e.ws()
        .undo(&Actor::User)
        .unwrap()
        .expect("undo delete view");
    assert_eq!(raw(&e, &b), before_exit);
}

// ---- T9: the workspace UI's re-hang and drag order -------------------------
//
// `membership.add { from_host | order }` and `timeline_view.place
// { from_host }` (`kernel-v5.md` §18 「T9 交回」): only the author's own UI may
// pass them; a re-hang is one commit and one narrow undo step.

/// Lanes `a`, `b`, `c` (storylines) in view `t9`; `m` and `n` hung on `a`
/// and placed at 10 and 20.
struct Hung {
    b: String,
    a: String,
    lb: String,
    lc: String,
    m: String,
    n: String,
}
fn hung(e: &Env) -> Hung {
    let b = item(e.out("project.create", json!({"name":"T9 re-hang"})));
    let a = create(e, &b, "tpl-storyline", "Lane A");
    let lb = create(e, &b, "tpl-storyline", "Lane B");
    let lc = create(e, &b, "tpl-storyline", "Lane C");
    let m = create(e, &b, "tpl-chapter", "Moving");
    let n = create(e, &b, "tpl-chapter", "Neighbour");
    e.call(
        "timeline_view.put",
        json!({"book":b,"view":{"id":"t9","name":"T9","lanes":[{"entry":a},{"entry":lb},{"entry":lc}]}}),
    );
    for (entry, at) in [(&m, 10), (&n, 20)] {
        e.call(
            "timeline_view.place",
            json!({"book":b,"view":"t9","entry":entry,"lane":a,"at":at}),
        );
    }
    Hung { b, a, lb, lc, m, n }
}
fn hosts_of(e: &Env, b: &str, member: &str) -> Vec<String> {
    let mut hosts: Vec<String> = e
        .out("membership.list", json!({"book":b}))
        .as_array()
        .unwrap()
        .iter()
        .filter(|ms| ms["member"] == member)
        .map(|ms| ms["host"].as_str().unwrap().to_owned())
        .collect();
    hosts.sort();
    hosts
}
fn sorted(mut ids: Vec<String>) -> Vec<String> {
    ids.sort();
    ids
}
fn placement(e: &Env, b: &str, view: &str, entry: &str) -> Value {
    raw(e, b)["timeline_views"][view]["placements"][entry].clone()
}
fn members_in_order(e: &Env, b: &str, host: &str) -> Vec<String> {
    e.out("entry.get", json!({"book":b,"id":host}))["below"]["members"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["id"].as_str().unwrap().to_owned())
        .collect()
}
fn journal_len(e: &Env) -> usize {
    e.ws().journal(None, 10_000).unwrap().len()
}

#[test]
fn ui_only_drag_parameters_are_refused_to_every_caller_but_the_author() {
    let e = env();
    let h = hung(&e);
    let (b, a, lb, m, n) = (&h.b, &h.a, &h.lb, &h.m, &h.n);
    // Hidden from the schema the Agent and MCP read.
    let registry = dr_workspace::registry();
    for (command, field) in [
        ("membership.add", "from_host"),
        ("membership.add", "order"),
        ("timeline_view.place", "from_host"),
    ] {
        let schema = serde_json::to_value(registry.get(command).unwrap().input_schema()).unwrap();
        assert!(
            !schema.to_string().contains(&format!("\"{field}\"")),
            "{command} must not show {field}: {schema}"
        );
    }
    let calls = [
        (
            "membership.add",
            json!({"book":b,"host":lb,"member":m,"from_host":a}),
        ),
        (
            "membership.add",
            json!({"book":b,"host":a,"member":m,"order":{"anchor":n,"after":true}}),
        ),
        (
            "timeline_view.place",
            json!({"book":b,"view":"t9","entry":m,"lane":lb,"from_host":a,"at":30}),
        ),
    ];
    let before = raw(&e, b);
    let journal = journal_len(&e);
    for actor in [
        Actor::agent("t9-refusal", 1, "write"),
        Actor::Mirror,
        Actor::Sync,
        Actor::Import,
    ] {
        for (command, input) in &calls {
            let result = e.ws().call(&actor, command, input.clone());
            assert!(
                matches!(result, Err(WsError::Invalid(ref message)) if message.contains("workspace UI operation")),
                "{actor:?} {command} {input}: {result:?}"
            );
            assert_eq!(raw(&e, b), before, "{actor:?} {command} wrote");
            assert_eq!(journal_len(&e), journal, "{actor:?} {command} journaled");
        }
    }
    // Without them the same commands are the Agent's as before.
    let agent = Actor::agent("t9-refusal", 2, "write");
    e.ws()
        .call(
            &agent,
            "membership.add",
            json!({"book":b,"host":lb,"member":m}),
        )
        .unwrap();
    e.ws()
        .call(
            &agent,
            "timeline_view.place",
            json!({"book":b,"view":"t9","entry":m,"at":30}),
        )
        .unwrap();
    assert_eq!(hosts_of(&e, b, m), sorted(vec![a.clone(), lb.clone()]));
    // And the author's own UI may pass them.
    let order = e.call(
        "membership.add",
        json!({"book":b,"host":a,"member":n,"order":{"anchor":m,"after":true}}),
    );
    assert_eq!(order["undo"][0]["command"], "membership.restore");
}

#[test]
fn a_stale_source_membership_refuses_the_whole_rehang() {
    let e = env();
    let h = hung(&e);
    let (b, a, lb, m) = (&h.b, &h.a, &h.lb, &h.m);
    // Another writer takes `m` off `a` after the UI read it.
    e.ws()
        .call(
            &Actor::agent("t9-stale", 1, "write"),
            "membership.remove",
            json!({"book":b,"host":a,"member":m}),
        )
        .unwrap();
    let before = raw(&e, b);
    let journal = journal_len(&e);
    for (command, input) in [
        (
            "membership.add",
            json!({"book":b,"host":lb,"member":m,"from_host":a}),
        ),
        (
            "timeline_view.place",
            json!({"book":b,"view":"t9","entry":m,"lane":lb,"from_host":a,"at":30}),
        ),
    ] {
        let result = e.try_call(command, input.clone());
        assert!(
            matches!(result, Err(WsError::Invalid(ref message)) if message.contains("no longer available")),
            "{command} {input}: {result:?}"
        );
        // Not even the new hang or the new position.
        assert_eq!(
            raw(&e, b),
            before,
            "{command} wrote part of a stale re-hang"
        );
        assert_eq!(journal_len(&e), journal);
        assert!(hosts_of(&e, b, m).is_empty());
    }
}

#[test]
fn a_rehang_clears_the_primary_membership_and_one_undo_brings_everything_back() {
    for via_place in [false, true] {
        let e = env();
        let h = hung(&e);
        let (b, a, lb, m) = (&h.b, &h.a, &h.lb, &h.m);
        e.call("membership.primary", json!({"book":b,"member":m,"host":a}));
        let before = raw(&e, b);
        let moved = if via_place {
            e.call(
                "timeline_view.place",
                json!({"book":b,"view":"t9","entry":m,"lane":lb,"from_host":a,"at":12}),
            )
        } else {
            e.call(
                "membership.add",
                json!({"book":b,"host":lb,"member":m,"from_host":a}),
            )
        };
        assert_eq!(moved["undo"].as_array().unwrap().len(), 1);
        assert_eq!(moved["undo"][0]["command"], "membership.restore");
        assert_eq!(hosts_of(&e, b, m), vec![lb.clone()]);
        assert!(e.out("entry.get", json!({"book":b,"id":m}))["primary"].is_null());
        let after = raw(&e, b);
        e.ws().undo(&Actor::User).unwrap().expect("one undo step");
        assert_eq!(hosts_of(&e, b, m), vec![a.clone()]);
        assert_eq!(
            e.out("entry.get", json!({"book":b,"id":m}))["primary"],
            json!(a)
        );
        assert_eq!(raw(&e, b), before, "via_place={via_place}");
        e.ws().redo(&Actor::User).unwrap().expect("redo");
        assert_eq!(raw(&e, b), after, "via_place={via_place}");
    }
}

/// Item 2 of the T9 review: undoing a re-hang or a drag order on the scale
/// takes back only the hang and the member's own position; a later title
/// edit and another card moved in the same view stay.
#[test]
fn undoing_a_rehang_or_an_order_keeps_later_edits_to_the_entry_and_the_view() {
    let peer = Actor::agent("t9-peer", 1, "write");
    for step in ["place", "add", "order"] {
        let e = env();
        let h = hung(&e);
        let (b, a, lb, m, n) = (&h.b, &h.a, &h.lb, &h.m, &h.n);
        // A third card in the view, hung elsewhere.
        let other = create(&e, b, "tpl-chapter", "Other card");
        e.call(
            "timeline_view.place",
            json!({"book":b,"view":"t9","entry":other,"lane":h.lc,"at":40}),
        );
        let m_before = placement(&e, b, "t9", m);
        let hosts_before = hosts_of(&e, b, m);
        let done = match step {
            "place" => e.call(
                "timeline_view.place",
                json!({"book":b,"view":"t9","entry":m,"lane":lb,"from_host":a,"at":33}),
            ),
            "add" => e.call(
                "membership.add",
                json!({"book":b,"host":lb,"member":m,"from_host":a}),
            ),
            _ => e.call(
                "membership.add",
                json!({"book":b,"host":a,"member":m,"order":{"anchor":n,"after":true}}),
            ),
        };
        assert_eq!(done["undo"][0]["command"], "membership.restore", "{step}");
        if step != "add" {
            assert_ne!(placement(&e, b, "t9", m), m_before, "{step} moved the card");
        }
        // Later: the Agent renames the member and moves another card in
        // the same view.
        e.ws()
            .call(
                &peer,
                "entry.update",
                json!({"book":b,"id":m,"title":"Peer title"}),
            )
            .unwrap();
        e.ws()
            .call(
                &peer,
                "timeline_view.place",
                json!({"book":b,"view":"t9","entry":other,"at":77}),
            )
            .unwrap();
        let other_after = placement(&e, b, "t9", &other);
        let n_after = placement(&e, b, "t9", n);
        e.ws().undo(&Actor::User).unwrap().expect("undo");
        assert_eq!(hosts_of(&e, b, m), hosts_before, "{step}");
        assert_eq!(placement(&e, b, "t9", m), m_before, "{step}");
        assert_eq!(
            e.out("entry.get", json!({"book":b,"id":m}))["title"],
            "Peer title",
            "{step} took back a later title edit"
        );
        assert_eq!(
            placement(&e, b, "t9", &other),
            other_after,
            "{step} took back another card"
        );
        assert_eq!(placement(&e, b, "t9", n), n_after, "{step}");
        e.ws().redo(&Actor::User).unwrap().expect("redo");
        assert_eq!(
            e.out("entry.get", json!({"book":b,"id":m}))["title"],
            "Peer title"
        );
        assert_eq!(placement(&e, b, "t9", &other), other_after);
    }
}

/// Item 3: "after X" where X and the next entry share a position on the
/// scale lands between them, moving what is tied after it by the smallest
/// steps (nothing visibly moves); undo puts every moved position back.
#[test]
fn an_order_beside_a_tie_on_the_scale_lands_between_the_tied_entries() {
    let e = env();
    let h = hung(&e);
    let (b, a, m, n) = (&h.b, &h.a, &h.m, &h.n);
    let x = create(&e, b, "tpl-chapter", "Tied X");
    let y = create(&e, b, "tpl-chapter", "Tied Y");
    for entry in [&x, &y] {
        e.call(
            "timeline_view.place",
            json!({"book":b,"view":"t9","entry":entry,"lane":a,"at":5}),
        );
    }
    // Along the scale: the tie at 5 (by id), then `m` at 10, `n` at 20.
    let order = members_in_order(&e, b, a);
    let (first, second) = (order[0].clone(), order[1].clone());
    assert_eq!(
        sorted(vec![first.clone(), second.clone()]),
        sorted(vec![x, y])
    );
    assert_eq!(&order[2..], &[m.clone(), n.clone()]);
    let before = raw(&e, b);
    for (anchor, after) in [(&first, true), (&second, false)] {
        e.call(
            "membership.add",
            json!({"book":b,"host":a,"member":n,"order":{"anchor":anchor,"after":after}}),
        );
        assert_eq!(
            members_in_order(&e, b, a),
            vec![first.clone(), n.clone(), second.clone(), m.clone()],
            "after {first} / before {second}"
        );
        let at = |id: &str| placement(&e, b, "t9", id)["at"].as_f64().unwrap();
        assert_eq!(at(&first), 5.0, "the entry before the slot stays put");
        assert!(5.0 < at(n) && at(n) < at(&second) && at(&second) - 5.0 < 1e-9);
        assert_eq!(at(m), 10.0);
        e.ws().undo(&Actor::User).unwrap().expect("one undo step");
        assert_eq!(raw(&e, b), before);
    }
    // Three tied: what is tied after the slot keeps its order.
    let z = create(&e, b, "tpl-chapter", "Tied Z");
    e.call(
        "timeline_view.place",
        json!({"book":b,"view":"t9","entry":z,"lane":a,"at":5}),
    );
    let tied: Vec<String> = members_in_order(&e, b, a)[..3].to_vec();
    let before = raw(&e, b);
    e.call(
        "membership.add",
        json!({"book":b,"host":a,"member":m,"order":{"anchor":tied[0],"after":true}}),
    );
    assert_eq!(
        members_in_order(&e, b, a),
        vec![
            tied[0].clone(),
            m.clone(),
            tied[1].clone(),
            tied[2].clone(),
            n.clone()
        ]
    );
    e.ws().undo(&Actor::User).unwrap().expect("one undo step");
    assert_eq!(raw(&e, b), before);
}

/// The manual-order branch (a host in no view): tied or missing `pos` keys
/// leave no gap, so the host's list gets explicit positions in one commit
/// and one undo step takes them all back.
#[test]
fn an_order_renumbers_a_list_with_tied_or_missing_positions() {
    let e = env();
    let b = item(e.out("project.create", json!({"name":"T9 renumber"})));
    let host = create(&e, &b, "tpl-storyline", "Plain host");
    let ms: Vec<String> = (1..=3)
        .map(|i| create(&e, &b, "tpl-chapter", &format!("Member {i}")))
        .collect();
    for member in &ms {
        e.call(
            "membership.add",
            json!({"book":b,"host":host,"member":member}),
        );
    }
    // Missing keys: the list reads by member id.
    let order = members_in_order(&e, &b, &host);
    assert_eq!(order, sorted(ms.clone()));
    let before = raw(&e, &b);
    // To the end: the one before the slot has no key to go after.
    let done = e.call(
        "membership.add",
        json!({"book":b,"host":host,"member":order[0],"order":{"anchor":order[2],"after":true}}),
    );
    assert_eq!(done["undo"].as_array().unwrap().len(), 1);
    assert_eq!(done["undo"][0]["command"], "membership.restore");
    assert_eq!(
        members_in_order(&e, &b, &host),
        vec![order[1].clone(), order[2].clone(), order[0].clone()]
    );
    for member in &ms {
        assert!(
            raw(&e, &b)["memberships"][format!("{host}|{member}")]["pos"].is_string(),
            "every member gets an explicit position"
        );
    }
    let after = raw(&e, &b);
    e.ws().undo(&Actor::User).unwrap().expect("one undo step");
    assert_eq!(raw(&e, &b), before);
    e.ws().redo(&Actor::User).unwrap().expect("redo");
    assert_eq!(raw(&e, &b), after);

    // Tied keys: two members on one position.
    for (member, pos) in [(&order[0], "a5"), (&order[1], "a5"), (&order[2], "a9")] {
        e.call(
            "membership.add",
            json!({"book":b,"host":host,"member":member,"pos":pos}),
        );
    }
    let tied = members_in_order(&e, &b, &host);
    assert_eq!(tied[2], order[2]);
    let before = raw(&e, &b);
    e.call(
        "membership.add",
        json!({"book":b,"host":host,"member":tied[2],"order":{"anchor":tied[0],"after":true}}),
    );
    assert_eq!(
        members_in_order(&e, &b, &host),
        vec![tied[0].clone(), tied[2].clone(), tied[1].clone()]
    );
    e.ws().undo(&Actor::User).unwrap().expect("one undo step");
    assert_eq!(raw(&e, &b), before);
}

/// Every stored document of `from`, the book first, imported into `to` as
/// another device's sync would.
fn sync_docs(from: &dr_workspace::Workspace, to: &dr_workspace::Workspace) {
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
            .export(loro::ExportMode::all_updates())
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

/// Two devices re-hang the same entry from the same host while apart: the
/// merge keeps both new hangs, the old one stays gone, the entry keeps one
/// position in the view, the primary stays valid, and each device's undo
/// still takes back only its own re-hang.
#[test]
fn two_devices_rehanging_one_entry_concurrently_merge_without_breaking_invariants() {
    let one = env();
    let two = env();
    let h = hung(&one);
    let (b, a, lb, lc, m) = (&h.b, &h.a, &h.lb, &h.lc, &h.m);
    one.call("membership.primary", json!({"book":b,"member":m,"host":a}));
    sync_docs(one.ws(), two.ws());
    one.call(
        "membership.add",
        json!({"book":b,"host":lb,"member":m,"from_host":a}),
    );
    two.call(
        "timeline_view.place",
        json!({"book":b,"view":"t9","entry":m,"lane":lc,"from_host":a,"at":25}),
    );
    sync_docs(one.ws(), two.ws());
    sync_docs(two.ws(), one.ws());
    assert_eq!(raw(&one, b), raw(&two, b), "the devices converge");
    for e in [&one, &two] {
        assert_eq!(hosts_of(e, b, m), sorted(vec![lb.clone(), lc.clone()]));
        assert!(e.out("entry.get", json!({"book":b,"id":m}))["primary"].is_null());
        let view = e
            .out("timeline_view.list", json!({"book":b}))
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == "t9")
            .unwrap()
            .clone();
        let placed: Vec<&Value> = view["placements"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|p| p["entry"] == m.as_str())
            .collect();
        assert_eq!(placed.len(), 1, "one position on the scale");
        assert_eq!(placed[0]["at"], 25.0);
        // Every membership listed is valid; both lanes list the entry.
        for lane in [lb, lc] {
            assert!(members_in_order(e, b, lane).contains(m));
        }
        assert!(!members_in_order(e, b, a).contains(m));
    }
    // Each device's undo takes back its own re-hang only, and the two
    // undos merge as well.
    one.ws().undo(&Actor::User).unwrap().expect("undo on one");
    assert_eq!(hosts_of(&one, b, m), sorted(vec![a.clone(), lc.clone()]));
    assert_eq!(
        one.out("entry.get", json!({"book":b,"id":m}))["primary"],
        json!(a)
    );
    two.ws().undo(&Actor::User).unwrap().expect("undo on two");
    assert_eq!(hosts_of(&two, b, m), sorted(vec![a.clone(), lb.clone()]));
    assert_eq!(placement(&two, b, "t9", m)["at"], 10.0);
    sync_docs(one.ws(), two.ws());
    sync_docs(two.ws(), one.ws());
    assert_eq!(raw(&one, b), raw(&two, b), "the devices converge again");
    for e in [&one, &two] {
        assert_eq!(hosts_of(e, b, m), vec![a.clone()]);
        assert_eq!(
            e.out("entry.get", json!({"book":b,"id":m}))["primary"],
            json!(a)
        );
        assert_eq!(placement(e, b, "t9", m)["at"], 10.0);
    }
}
