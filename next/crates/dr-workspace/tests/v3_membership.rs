mod common;
use common::*;
use dr_workspace::Actor;
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
    use dr_workspace::{WritePreconditions, WsError};
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

#[test]
fn folder_in_view_reads_and_moves_by_scale_without_touching_manual_order() {
    let e = env();
    let b = item(e.out("project.create", json!({"name":"Folder scale order"})));
    let ms = root(&e, &b, "tpl-manuscript").as_str().unwrap().to_owned();
    let ms_id = dr_model::id::EntryId::parse(&ms).unwrap();
    let c1 = create(&e, &b, "tpl-chapter", "Ch 1");
    let c2 = create(&e, &b, "tpl-chapter", "Ch 2");
    let c3 = create(&e, &b, "tpl-chapter", "Ch 3");
    for (id, text) in [(&c1, "一"), (&c2, "二"), (&c3, "三")] {
        e.call(
            "module.set_prose",
            json!({"book":b,"owner":id,"module":"mod-prose","paragraphs":[{"text":text}]}),
        );
    }

    let manual_ids = |e: &Env| -> Vec<String> {
        let book_id = dr_model::id::BookId::parse(&b).unwrap();
        let ms_id = ms_id.clone();
        e.ws()
            .read_book_v3(&b, move |doc, _| {
                Ok(dr_doc::v3::BorrowedBookV3::new(doc, &book_id)
                    .unwrap()
                    .view()
                    .structure_snapshot()
                    .manual_children_of(Some(&ms_id))
                    .into_iter()
                    .map(|row| row.id.to_string())
                    .collect())
            })
            .unwrap()
    };
    let below_children = |e: &Env, folder: &str| -> Vec<String> {
        e.out("entry.get", json!({"book":b,"id":folder}))["below"]["children"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x["id"].as_str().unwrap().to_owned())
            .collect()
    };
    let list_below_children = |e: &Env, folder: &str| -> Vec<String> {
        e.out("entry.list", json!({"book":b,"all":true,"below":true}))
            .as_array()
            .unwrap()
            .iter()
            .find(|x| x["id"] == folder)
            .unwrap()["below"]["children"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x["id"].as_str().unwrap().to_owned())
            .collect()
    };
    let book_seq_chapters = |e: &Env| -> Vec<String> {
        e.out("book.sequence", json!({"book":b}))["entries"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|row| !row["prose"].as_array().unwrap().is_empty())
            .map(|row| row["entry"]["id"].as_str().unwrap().to_owned())
            .collect()
    };

    assert_eq!(manual_ids(&e), vec![c1.clone(), c2.clone(), c3.clone()]);

    // Put `书稿` folder into `v1`: chapters are placed in manual order `[c1, c2, c3]`.
    e.call(
        "timeline_view.put",
        json!({"book":b,"view":{"id":"v1","name":"V1","pos":"a0","lanes":[]}}),
    );
    e.call(
        "timeline_view.add_lane",
        json!({"book":b,"view":"v1","lane":ms}),
    );
    let state = raw(&e, &b);
    assert!(
        state["timeline_views"]["v1"]["placements"][&c1]["at"]
            .as_f64()
            .unwrap()
            < state["timeline_views"]["v1"]["placements"][&c2]["at"]
                .as_f64()
                .unwrap()
    );
    assert!(
        state["timeline_views"]["v1"]["placements"][&c2]["at"]
            .as_f64()
            .unwrap()
            < state["timeline_views"]["v1"]["placements"][&c3]["at"]
                .as_f64()
                .unwrap()
    );

    // Move `c3` before `c1` on `v1`'s scale: `entry.get`, `entry.list {below}`, and `book.sequence`
    // all follow scale `[c3, c1, c2]`, while manual folder order stays `[c1, c2, c3]`.
    e.call(
        "timeline_view.place",
        json!({"book":b,"view":"v1","entry":c3,"at":-10}),
    );
    assert_eq!(
        below_children(&e, &ms),
        vec![c3.clone(), c1.clone(), c2.clone()]
    );
    assert_eq!(
        list_below_children(&e, &ms),
        vec![c3.clone(), c1.clone(), c2.clone()]
    );
    assert_eq!(
        book_seq_chapters(&e),
        vec![c3.clone(), c1.clone(), c2.clone()]
    );
    assert_eq!(manual_ids(&e), vec![c1.clone(), c2.clone(), c3.clone()]);

    // Creating a new resident chapter lands at scale end `[c3, c1, c2, c4]`.
    let c4 = create(&e, &b, "tpl-chapter", "Ch 4");
    assert_eq!(
        below_children(&e, &ms),
        vec![c3.clone(), c1.clone(), c2.clone(), c4.clone()]
    );
    // `entry.move` with `index: 1` inside view-governed `ms` moves `c4` on the scale to
    // `[c3, c4, c1, c2]` without rewriting manual tree sibling order (`[c1, c2, c3, c4]`).
    e.call(
        "entry.move",
        json!({"book":b,"id":c4,"parent":ms,"index":1}),
    );
    assert_eq!(
        below_children(&e, &ms),
        vec![c3.clone(), c4.clone(), c1.clone(), c2.clone()]
    );
    assert_eq!(
        manual_ids(&e),
        vec![c1.clone(), c2.clone(), c3.clone(), c4.clone()]
    );

    // Moving `c4` out of `ms` prunes its orphaned placement in `v1`.
    let ideas = root(&e, &b, "tpl-ideas").as_str().unwrap().to_owned();
    e.call("entry.move", json!({"book":b,"id":c4,"parent":ideas}));
    assert!(
        raw(&e, &b)["timeline_views"]["v1"]["placements"]
            .get(&c4)
            .is_none()
    );

    // When `ms` is in two views (`v1`, `v2`), the first of them orders it:
    // `v2` once it comes first.
    e.call(
        "timeline_view.put",
        json!({"book":b,"view":{"id":"v2","name":"V2","pos":"a1","lanes":[{"entry":ms}],
            "placements":[{"entry":c2,"at":0},{"entry":c1,"at":5},{"entry":c3,"at":10}]}}),
    );
    assert_eq!(
        below_children(&e, &ms),
        vec![c3.clone(), c1.clone(), c2.clone()]
    );
    put_view_first(&e, &b, "v2");
    assert_eq!(
        below_children(&e, &ms),
        vec![c2.clone(), c1.clone(), c3.clone()]
    );
    // Removing `ms` from `v2` leaves it in `v1`, so manual order is still untouched.
    e.call(
        "timeline_view.remove_lane",
        json!({"book":b,"view":"v2","lane":ms}),
    );
    assert_eq!(manual_ids(&e), vec![c1.clone(), c2.clone(), c3.clone()]);

    // Leaving `v1` (its last live view) writes `[c3, c1, c2]` back to manual tree order in
    // the same commit; 1-step undo restores `v1` and the original manual order `[c1, c2, c3]`.
    e.call(
        "timeline_view.remove_lane",
        json!({"book":b,"view":"v1","lane":ms}),
    );
    assert_eq!(manual_ids(&e), vec![c3.clone(), c1.clone(), c2.clone()]);
    assert_eq!(
        below_children(&e, &ms),
        vec![c3.clone(), c1.clone(), c2.clone()]
    );
    e.ws()
        .undo(&Actor::User)
        .unwrap()
        .expect("undo folder remove_lane");
    assert_eq!(manual_ids(&e), vec![c1.clone(), c2.clone(), c3.clone()]);
    assert_eq!(
        below_children(&e, &ms),
        vec![c3.clone(), c1.clone(), c2.clone()]
    );

    // Dual `level == true && accept == true` swimlane (`tpl-group` with its own `accept`
    // override; the template takes no entries from elsewhere, kernel-v5 §16): an entry that
    // both resides under it and is a member gets ONE placement and appears ONCE in `below`
    // (`children`, not duplicated in `members`).
    let group = item(e.out(
        "entry.create",
        json!({"book":b,"parent":ms,"template":"tpl-group","title":"Dual Folder"}),
    ));
    e.call(
        "entry.update",
        json!({"book":b,"id":group,"overrides":{"accept":true}}),
    );
    let both = item(e.out(
        "entry.create",
        json!({"book":b,"parent":group,"template":"tpl-chapter","title":"Resident+Member"}),
    ));
    let member_only = item(e.out(
        "entry.create",
        json!({"book":b,"parent":ideas,"template":"tpl-chapter","title":"Member Only"}),
    ));
    e.call(
        "membership.add",
        json!({"book":b,"host":group,"member":both}),
    );
    e.call(
        "membership.add",
        json!({"book":b,"host":group,"member":member_only}),
    );
    e.call(
        "timeline_view.put",
        json!({"book":b,"view":{"id":"v-dual","name":"Dual","lanes":[]}}),
    );
    e.call(
        "timeline_view.add_lane",
        json!({"book":b,"view":"v-dual","lane":group}),
    );
    let dual_placements = raw(&e, &b)["timeline_views"]["v-dual"]["placements"]
        .as_object()
        .unwrap()
        .clone();
    assert_eq!(dual_placements.len(), 2);
    assert!(dual_placements.contains_key(&both));
    assert!(dual_placements.contains_key(&member_only));
    let dual_below = e.out("entry.get", json!({"book":b,"id":group}))["below"].clone();
    assert_eq!(dual_below["children"].as_array().unwrap().len(), 1);
    assert_eq!(dual_below["children"][0]["id"], both);
    assert_eq!(dual_below["members"].as_array().unwrap().len(), 1);
    assert_eq!(dual_below["members"][0]["id"], member_only);
}
