//! K4 G3 uses the shared v3 seed and real workspace commands. No second corpus.
use dr_shell::{Services, SettingsFile, ShellInfo, Workspace, book::Book, pages::BottomHost};
use dr_view_timeline::v3::{Timeline, model};
use dr_workspace::{Actor, Workspace as Library};
use gpui::{Context, Entity, Render, TestAppContext, VisualTestContext, Window, div, prelude::*};
use serde_json::{Value, json};
use std::{
    rc::Rc,
    time::{Duration, Instant},
};

fn seed() -> (tempfile::TempDir, Library, String) {
    let dir = tempfile::tempdir().unwrap();
    let store =
        dr_store::Library::open(dir.path(), dr_workspace::library_options("0.2.0-dev")).unwrap();
    let made = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let id = made.books[0].book_id().to_string();
    made.write_to(&store).unwrap();
    store.close().unwrap();
    let lib = Library::open_dir(dir.path(), "0.2.0-dev").unwrap();
    (dir, lib, id)
}
fn call(lib: &Library, name: &str, input: Value) -> Value {
    lib.call(&Actor::User, name, input).unwrap()["output"].clone()
}

#[test]
fn lanes_use_membership_and_each_views_shared_position_only() {
    let (_dir, lib, id) = seed();
    let book = Book::load(&lib, &id).unwrap();
    let b = book.v3().unwrap();
    let mut view = b.timeline_views[0].clone();
    let member = view.placements[0].entry.clone();
    let original = view.placements[0].clone();
    let other = view
        .lanes
        .iter()
        .find(|l| l.entry != view.lanes[0].entry)
        .unwrap()
        .entry
        .clone();
    call(
        &lib,
        "membership.add",
        json!({"book":id,"host":other,"member":member}),
    );
    let updated = Book::load(&lib, &id).unwrap();
    let b = updated.v3().unwrap();
    let lanes = model::lanes(b, &view);
    let copies: Vec<_> = lanes
        .iter()
        .flat_map(|l| &l.clips)
        .filter(|p| p.entry == member)
        .collect();
    assert!(copies.len() >= 2);
    assert!(copies.iter().all(|p| **p == original));
    let mut pruned = view.clone();
    let pin_count = pruned.pins.len();
    let lane = pruned.lanes[0].entry.clone();
    model::remove_lane(&mut pruned, &lane, &b.memberships);
    assert!(pruned.placements.iter().any(|p| p.entry == member));
    let last_lane = pruned.lanes[0].entry.clone();
    model::remove_lane(&mut pruned, &last_lane, &b.memberships);
    assert!(pruned.placements.is_empty());
    assert_eq!(pruned.pins.len(), pin_count);
    view.placements.clear();
    assert!(model::lanes(b, &view).iter().all(|l| l.clips.is_empty()));
    // Residents without memberships never become lane members.
    let lane = &view.lanes[0].entry;
    let resident = call(
        &lib,
        "entry.create",
        json!({"book":id,"parent":lane,"title":"Synthetic resident","template":"tpl-chapter"}),
    );
    let next = Book::load(&lib, &id).unwrap();
    assert!(
        !model::lanes(next.v3().unwrap(), &view)
            .iter()
            .any(|l| l.clips.iter().any(|p| p.entry == resident["id"]))
    );
    lib.shutdown().unwrap();
}

struct Host {
    timeline: Entity<Timeline>,
    _workspace: Entity<Workspace>,
}
impl Render for Host {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().child(self.timeline.clone())
    }
}
fn frame(cx: &mut VisualTestContext) {
    cx.update(|w, cx| w.draw(cx).clear(cx));
    cx.run_until_parked();
}
fn wait(cx: &mut VisualTestContext, done: impl Fn(&mut VisualTestContext) -> bool) {
    let until = Instant::now() + Duration::from_secs(15);
    loop {
        frame(cx);
        if done(cx) {
            break;
        }
        assert!(Instant::now() < until, "v3 timeline timed out");
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn visual<'a>(
    cx: &'a mut TestAppContext,
    lib: &Library,
    id: &str,
) -> (Entity<Host>, &'a mut VisualTestContext) {
    cx.executor().allow_parking();
    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "0.2.0-dev",
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                library: Some(lib.clone()),
                ..Services::default()
            },
            SettingsFile::in_memory(),
            cx,
        )
    });
    let book = Rc::new(Book::load(lib, id).unwrap());
    cx.add_window_view(|w, cx| {
        let ws = cx.new(|cx| Workspace::new(w, cx));
        let host = BottomHost {
            workspace: ws.downgrade(),
            library: Some(lib.clone()),
            book_id: id.to_owned(),
            book,
            target: None,
        };
        Host {
            timeline: cx.new(|_| Timeline::new(&host)),
            _workspace: ws,
        }
    })
}
fn refresh(host: &Entity<Host>, lib: &Library, id: &str, cx: &mut VisualTestContext) {
    let book = Rc::new(Book::load(lib, id).unwrap());
    let (timeline, workspace) =
        host.read_with(cx, |h, _| (h.timeline.clone(), h._workspace.downgrade()));
    timeline.update(cx, |t, cx| {
        t.refresh(
            &BottomHost {
                workspace,
                library: Some(lib.clone()),
                book_id: id.to_owned(),
                book,
                target: None,
            },
            cx,
        )
    });
}

#[gpui::test]
fn placement_is_one_undo_preserves_residence_and_removes_only_orphaned_view_positions(
    cx: &mut TestAppContext,
) {
    let (_dir, lib, id) = seed();
    let before = Book::load(&lib, &id).unwrap();
    let b = before.v3().unwrap();
    let entry = b
        .entries
        .iter()
        .find(|e| e.template.as_deref() == Some("tpl-idea"))
        .unwrap()
        .clone();
    let view = b.timeline_views[0].clone();
    let first = view.lanes[0].entry.clone();
    let second = view.lanes[1].entry.clone();
    let (host, cx) = visual(cx, &lib, &id);
    let t = host.read_with(cx, |h, _| h.timeline.clone());
    t.update(cx, |t, cx| {
        t.place(entry.id.clone(), Some(first.clone()), 12.5, Some(8.), cx)
    });
    wait(cx, |_| {
        call(&lib, "timeline_view.list", json!({"book":id}))[0]["placements"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["entry"] == entry.id)
    });
    let actual = call(&lib, "entry.get", json!({"book":id,"id":entry.id}));
    assert_eq!(actual["parent"], json!(entry.parent));
    assert_eq!(actual["pos"], entry.pos);
    assert_eq!(actual["primary"], json!(entry.primary));
    lib.undo(&Actor::User).unwrap().unwrap();
    assert!(
        !call(&lib, "membership.list", json!({"book":id}))
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["member"] == entry.id && m["host"] == first)
    );
    assert!(
        !call(&lib, "timeline_view.list", json!({"book":id}))[0]["placements"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["entry"] == entry.id)
    );
    lib.redo(&Actor::User).unwrap().unwrap();
    refresh(&host, &lib, &id, cx);
    t.update(cx, |t, cx| {
        t.place(entry.id.clone(), Some(second.clone()), 33., Some(12.), cx)
    });
    wait(cx, |_| {
        call(&lib, "timeline_view.list", json!({"book":id}))[0]["placements"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["entry"] == entry.id && p["at"] == 33.)
    });
    refresh(&host, &lib, &id, cx);
    let copies = t.read_with(cx, |t, _| {
        t.lanes()
            .into_iter()
            .flat_map(|l| l.clips)
            .filter(|p| p.entry == entry.id)
            .collect::<Vec<_>>()
    });
    assert_eq!(copies.len(), 2);
    assert!(copies.iter().all(|p| p.at == 33. && p.span == Some(12.)));
    call(
        &lib,
        "timeline_view.put",
        json!({"book":id,"view":{"id":"independent-view","name":"Synthetic independent view","lanes":[{"entry":first,"pos":"a0"}],"placements":[{"entry":entry.id,"at":99.,"span":4.}]}}),
    );
    t.update(cx, |t, cx| {
        t.remove_entry(entry.id.clone(), first.clone(), cx)
    });
    wait(cx, |_| {
        !call(&lib, "membership.list", json!({"book":id}))
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["member"] == entry.id && m["host"] == first)
    });
    let views = call(&lib, "timeline_view.list", json!({"book":id}));
    let views = views.as_array().unwrap();
    assert!(
        views.iter().find(|v| v["id"] == view.id).unwrap()["placements"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["entry"] == entry.id)
    );
    assert!(
        views
            .iter()
            .find(|v| v["id"] == "independent-view")
            .unwrap()["placements"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    t.update(cx, |t, cx| {
        t.remove_entry(entry.id.clone(), second.clone(), cx)
    });
    wait(cx, |_| {
        !call(&lib, "timeline_view.list", json!({"book":id}))
            .as_array()
            .unwrap()
            .iter()
            .any(|v| {
                v["placements"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|p| p["entry"] == entry.id)
            })
    });
    let after = call(&lib, "entry.get", json!({"book":id,"id":entry.id}));
    assert_eq!(after["parent"], actual["parent"]);
    assert_eq!(after["pos"], actual["pos"]);
}

#[gpui::test]
fn time_pin_fields_merge_in_order_without_losing_label_colour_or_binding(cx: &mut TestAppContext) {
    use dr_view_timeline::v3::PinEdit;
    use dr_workspace::commands::v3::types::TimelinePin;
    let (_dir, lib, id) = seed();
    let before = Book::load(&lib, &id).unwrap();
    let b = before.v3().unwrap();
    let count = b.timeline_views[0].pins.len();
    let entry = b.entries[0].id.clone();
    let (host, cx) = visual(cx, &lib, &id);
    let t = host.read_with(cx, |h, _| h.timeline.clone());
    let pin = "synthetic-g3-pin".to_owned();
    t.update(cx, |t, cx| {
        t.put_pin(
            TimelinePin {
                id: pin.clone(),
                at: 1.,
                label: "Synthetic pin".into(),
                color: None,
                entry: None,
            },
            cx,
        );
        t.edit_pin(
            pin.clone(),
            PinEdit::Label("Synthetic renamed pin".into()),
            cx,
        );
        t.edit_pin(pin.clone(), PinEdit::Color(Some("#123456".into())), cx);
        t.edit_pin(pin.clone(), PinEdit::Bind(Some(entry.clone())), cx);
        t.edit_pin(pin.clone(), PinEdit::At(-3.5), cx);
    });
    wait(cx, |_| {
        call(&lib, "timeline_view.list", json!({"book":id}))[0]["pins"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["id"] == pin && p["at"] == -3.5)
    });
    let pins = call(&lib, "timeline_view.list", json!({"book":id}));
    let pins = pins[0]["pins"].as_array().unwrap();
    let actual = pins.iter().find(|p| p["id"] == pin).unwrap();
    assert_eq!(actual["label"], "Synthetic renamed pin");
    assert_eq!(actual["color"], "#123456");
    assert_eq!(actual["entry"], entry);
    lib.undo(&Actor::User).unwrap().unwrap();
    let pins = call(&lib, "timeline_view.list", json!({"book":id}));
    let actual = pins[0]["pins"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == pin)
        .unwrap();
    assert_eq!(actual["at"], 1.);
    assert_eq!(actual["label"], "Synthetic renamed pin");
    assert_eq!(actual["entry"], entry);
    t.update(cx, |t, cx| t.edit_pin(pin.clone(), PinEdit::Bind(None), cx));
    wait(cx, |_| {
        call(&lib, "timeline_view.list", json!({"book":id}))[0]["pins"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["id"] == pin && p["entry"].is_null())
    });
    t.update(cx, |t, cx| t.delete_pin(pin.clone(), cx));
    wait(cx, |_| {
        call(&lib, "timeline_view.list", json!({"book":id}))[0]["pins"]
            .as_array()
            .unwrap()
            .len()
            == count
    });
}

#[gpui::test]
fn queued_view_and_lane_edits_preserve_memberships_and_other_views(cx: &mut TestAppContext) {
    let (_dir, lib, id) = seed();
    cx.executor().allow_parking();
    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "0.2.0-dev",
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                library: Some(lib.clone()),
                ..Services::default()
            },
            SettingsFile::in_memory(),
            cx,
        )
    });
    let book = Rc::new(Book::load(&lib, &id).unwrap());
    let original = book.v3().unwrap().timeline_views[0].clone();
    let memberships = book.v3().unwrap().memberships.clone();
    let (host, cx) = cx.add_window_view(|w, cx| {
        let ws = cx.new(|cx| Workspace::new(w, cx));
        let host = BottomHost {
            workspace: ws.downgrade(),
            library: Some(lib.clone()),
            book_id: id.clone(),
            book: book.clone(),
            target: None,
        };
        Host {
            timeline: cx.new(|_| Timeline::new(&host)),
            _workspace: ws,
        }
    });
    let t = host.read_with(cx, |h, _| h.timeline.clone());
    t.update(cx, |t, cx| {
        t.create_view("synthetic-view".into(), "Synthetic view".into(), cx)
    });
    wait(cx, |_| {
        call(&lib, "timeline_view.list", json!({"book":id}))
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["id"] == "synthetic-view")
    });
    // Refresh the retained instance, then enqueue two adds before either snapshot arrives.
    let refresh = |cx: &mut VisualTestContext| {
        let book = Rc::new(Book::load(&lib, &id).unwrap());
        let ws = host.read_with(cx, |h, _| h._workspace.downgrade());
        let host = BottomHost {
            workspace: ws,
            library: Some(lib.clone()),
            book_id: id.clone(),
            book,
            target: None,
        };
        t.update(cx, |t, cx| t.refresh(&host, cx));
    };
    refresh(cx);
    t.update(cx, |t, cx| {
        t.add_lane(original.lanes[0].entry.clone(), cx);
        t.add_lane(original.lanes[1].entry.clone(), cx);
    });
    wait(cx, |_| {
        call(&lib, "timeline_view.list", json!({"book":id}))
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == "synthetic-view")
            .unwrap()["lanes"]
            .as_array()
            .unwrap()
            .len()
            == 2
    });
    refresh(cx);
    t.update(cx, |t, cx| {
        t.reorder_lane(original.lanes[1].entry.clone(), -1, cx)
    });
    wait(cx, |_| {
        call(&lib, "timeline_view.list", json!({"book":id}))
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == "synthetic-view")
            .unwrap()["lanes"][0]["entry"]
            == original.lanes[1].entry
    });
    refresh(cx);
    t.update(cx, |t, cx| {
        t.remove_lane(original.lanes[0].entry.clone(), cx)
    });
    wait(cx, |_| {
        call(&lib, "timeline_view.list", json!({"book":id}))
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == "synthetic-view")
            .unwrap()["lanes"]
            .as_array()
            .unwrap()
            .len()
            == 1
    });
    let book = Book::load(&lib, &id).unwrap();
    assert_eq!(book.v3().unwrap().memberships, memberships);
    assert_eq!(
        book.v3()
            .unwrap()
            .timeline_views
            .iter()
            .find(|v| v.id == original.id)
            .unwrap(),
        &original
    );
    t.update(cx, |t, cx| t.delete_view(cx));
    wait(cx, |_| {
        call(&lib, "timeline_view.list", json!({"book":id}))
            .as_array()
            .unwrap()
            .iter()
            .filter(|v| v["deleted_at"].is_null())
            .count()
            == 1
    });
    // A read-tolerant query must not cause a later whole-view edit to erase
    // a placement hidden by a trashed target. Refuse and retain the raw data.
    call(
        &lib,
        "entry.trash",
        json!({"book":id,"id":original.placements[0].entry}),
    );
    let before =
        lib.observe(&format!("book:{id}")).unwrap().value["timeline_views"][&original.id].clone();
    refresh(cx);
    t.update(cx, |t, cx| {
        t.select(original.id.clone(), cx);
        t.remove_lane(original.lanes[0].entry.clone(), cx);
    });
    wait(cx, |cx| {
        host.read_with(cx, |h, cx| h._workspace.read(cx).toast.is_some())
    });
    assert_eq!(
        lib.observe(&format!("book:{id}")).unwrap().value["timeline_views"][&original.id],
        before
    );
    cx.update(|_, cx| {
        let temporary_host = BottomHost {
            workspace: host.read(cx)._workspace.downgrade(),
            library: Some(lib.clone()),
            book_id: id.clone(),
            book: Rc::new(Book::load(&lib, &id).unwrap()),
            target: None,
        };
        let temporary = cx.new(|_| Timeline::new(&temporary_host));
        temporary.update(cx, |t, cx| {
            t.create_view("drained-one".into(), "Synthetic queued one".into(), cx);
            t.create_view("drained-two".into(), "Synthetic queued two".into(), cx);
        });
        // Dropping the last view handle must not cancel either accepted write.
    });
    wait(cx, |_| {
        call(&lib, "timeline_view.list", json!({"book":id}))
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["id"] == "drained-two")
    });
    let views = call(&lib, "timeline_view.list", json!({"book":id}));
    assert!(
        views
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["id"] == "drained-one")
    );
}
