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
