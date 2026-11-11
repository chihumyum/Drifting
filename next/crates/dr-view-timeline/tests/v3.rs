//! K4 G3 uses the shared v3 seed and real workspace commands. No second corpus.
use dr_shell::{
    Services, SettingsFile, ShellInfo, Workspace,
    book::Book,
    pages::{BottomHost, PageViewHost},
    v3::EntryDrag,
};
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
    drag: Option<EntryDrag>,
}
impl Render for Host {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .flex()
            .flex_col()
            .when_some(self.drag.clone(), |el, drag| {
                el.child(
                    div()
                        .id("g3-test-drag-source")
                        .debug_selector(|| "g3-test-drag-source".into())
                        .w(gpui::px(200.))
                        .h(gpui::px(30.))
                        .flex_none()
                        .on_drag(drag, |_, _, _, cx| cx.new(|_| DragPreview)),
                )
            })
            .child(div().flex_1().min_h_0().child(self.timeline.clone()))
    }
}
struct DragPreview;
impl Render for DragPreview {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size(gpui::px(1.))
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
                book: Some(id.to_owned()),
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
            drag: None,
        }
    })
}

fn drag_to_lane(host: &Entity<Host>, drag: EntryDrag, lane: &str, cx: &mut VisualTestContext) {
    use gpui::{Modifiers, MouseButton, point, px};
    host.update(cx, |h, cx| {
        h.drag = Some(drag);
        cx.notify();
    });
    frame(cx);
    let source = cx.debug_bounds("g3-test-drag-source").unwrap().center();
    let target = cx
        .debug_bounds(Box::leak(format!("v3-track-{lane}").into_boxed_str()))
        .unwrap()
        .center();
    cx.simulate_mouse_down(source, MouseButton::Left, Modifiers::none());
    cx.simulate_mouse_move(
        source + point(px(8.), px(0.)),
        MouseButton::Left,
        Modifiers::none(),
    );
    frame(cx);
    cx.simulate_mouse_move(target, MouseButton::Left, Modifiers::none());
    frame(cx);
    cx.simulate_mouse_up(target, MouseButton::Left, Modifiers::none());
    frame(cx);
}

#[gpui::test]
fn shared_entry_drop_preserves_residence_and_rejects_other_libraries_owners_and_versions(
    cx: &mut TestAppContext,
) {
    let (_dir, lib, id) = seed();
    let (_other_dir, other_lib, same_id) = seed();
    assert_eq!(id, same_id);
    let before = Book::load(&lib, &id).unwrap();
    let b = before.v3().unwrap();
    let source = b
        .entries
        .iter()
        .find(|e| e.template.as_deref() == Some("tpl-idea"))
        .unwrap()
        .clone();
    let view = b.timeline_views[0].clone();
    let lane = view.lanes[0].entry.clone();
    let (host, cx) = visual(cx, &lib, &id);
    let ws = host.read_with(cx, |h, _| h._workspace.clone());
    wait(cx, |cx| ws.read_with(cx, |ws, _| ws.book.v3().is_some()));
    let page = PageViewHost {
        workspace: ws.downgrade(),
        library: lib.clone(),
        book_id: id.clone(),
        book: ws.read_with(cx, |ws, _| ws.book.clone()),
    };
    let other_owner = cx.update(|w, cx| cx.new(|cx| Workspace::new(w, cx)));
    for foreign in [
        PageViewHost {
            library: other_lib.clone(),
            ..page.clone()
        },
        PageViewHost {
            workspace: other_owner.downgrade(),
            ..page.clone()
        },
        PageViewHost {
            book_id: "different-book".into(),
            ..page.clone()
        },
    ] {
        let before = lib.observe(&format!("book:{id}")).unwrap();
        drag_to_lane(
            &host,
            EntryDrag::new(foreign, &source.id, &source.title),
            &lane,
            cx,
        );
        assert_eq!(
            lib.observe(&format!("book:{id}")).unwrap().version,
            before.version
        );
    }
    let mut drag = EntryDrag::new(page.clone(), &source.id, &source.title);
    drag.span = Some(7.);
    drag.set_grab(12.);
    drag_to_lane(&host, drag, &lane, cx);
    wait(cx, |_| {
        call(&lib, "timeline_view.list", json!({"book":id}))[0]["placements"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["entry"] == source.id && p["span"] == 7.)
    });
    let actual = call(&lib, "entry.get", json!({"book":id,"id":source.id}));
    assert_eq!(actual["parent"], json!(source.parent));
    assert_eq!(actual["pos"], source.pos);
    assert_eq!(actual["primary"], json!(source.primary));
    assert!(
        call(&lib, "membership.list", json!({"book":id}))
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["host"] == lane && m["member"] == source.id)
    );
    refresh(&host, &lib, &id, cx);
    let before = lib.observe(&format!("book:{id}")).unwrap();
    drag_to_lane(
        &host,
        EntryDrag::new(page, &source.id, &source.title),
        &view.lanes[1].entry,
        cx,
    );
    assert_eq!(
        lib.observe(&format!("book:{id}")).unwrap().version,
        before.version
    );
    assert_eq!(
        call(
            &other_lib,
            "entry.get",
            json!({"book":same_id,"id":source.id})
        )["title"],
        source.title
    );
}

#[gpui::test]
fn placement_uses_the_displayed_frontier_before_the_backend_write(cx: &mut TestAppContext) {
    let (_dir, lib, id) = seed();
    let b = Book::load(&lib, &id).unwrap();
    let book = b.v3().unwrap();
    let view = book.timeline_views[0].clone();
    let entry = book
        .entries
        .iter()
        .find(|e| e.template.as_deref() == Some("tpl-idea"))
        .unwrap()
        .id
        .clone();
    let (host, cx) = visual(cx, &lib, &id);
    let t = host.read_with(cx, |h, _| h.timeline.clone());
    call(
        &lib,
        "timeline_view.rename",
        json!({"book":id,"view":view.id,"name":"Synthetic peer view name"}),
    );
    rejected_without_book_write(&host, &lib, &id, cx, |t, cx| {
        t.update(cx, |t, cx| {
            t.place(
                entry.clone(),
                Some(view.lanes[0].entry.clone()),
                23.,
                Some(5.),
                cx,
            )
        })
    });
    refresh(&host, &lib, &id, cx);
    t.update(cx, |t, cx| {
        t.place(
            entry.clone(),
            Some(view.lanes[0].entry.clone()),
            23.,
            Some(5.),
            cx,
        )
    });
    wait(cx, |_| {
        call(&lib, "timeline_view.list", json!({"book":id}))[0]["placements"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["entry"] == entry && p["at"] == 23.)
    });
    assert_eq!(
        call(&lib, "timeline_view.list", json!({"book":id}))[0]["name"],
        "Synthetic peer view name"
    );
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
            drag: None,
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
    // Each accepted action is followed by a fresh displayed snapshot.
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
    refresh(cx);
    t.update(cx, |t, cx| t.add_lane(original.lanes[1].entry.clone(), cx));
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
    // A local removal retains already-hidden positions and all pins.
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
    wait(cx, |_| {
        call(&lib, "timeline_view.list", json!({"book":id}))[0]["lanes"]
            .as_array()
            .unwrap()
            .len()
            == 1
    });
    let after =
        lib.observe(&format!("book:{id}")).unwrap().value["timeline_views"][&original.id].clone();
    assert_eq!(
        after["placements"][&original.placements[0].entry],
        before["placements"][&original.placements[0].entry]
    );
    assert_eq!(after["pins"], before["pins"]);
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

fn pin_only_target(
    lib: &Library,
    book: &str,
) -> (
    dr_workspace::commands::v3::types::TimelineView,
    String,
    String,
) {
    let before = Book::load(lib, book).unwrap();
    let view = before.v3().unwrap().timeline_views[0].clone();
    let target = call(lib, "entry.create", json!({"book":book,"parent":view.lanes[0].entry,"template":"tpl-chapter","title":"Synthetic pin-only target"}))["id"].as_str().unwrap().to_owned();
    let pin = "synthetic-hidden-binding".to_owned();
    call(
        lib,
        "timeline_view.put_pin",
        json!({"book":book,"view":view.id,"pin":{"id":pin,"at":3.,"label":"Synthetic recoverable pin","color":"#123456","entry":target}}),
    );
    let before = Book::load(lib, book).unwrap();
    (before.v3().unwrap().timeline_views[0].clone(), target, pin)
}

fn rejected_without_book_write(
    host: &Entity<Host>,
    lib: &Library,
    book: &str,
    cx: &mut VisualTestContext,
    action: impl FnOnce(&Entity<Timeline>, &mut VisualTestContext),
) {
    host.update(cx, |h, cx| {
        h._workspace.update(cx, |w, cx| {
            w.toast = None;
            cx.notify();
        })
    });
    let before = lib.observe(&format!("book:{book}")).unwrap();
    let timeline = host.read_with(cx, |h, _| h.timeline.clone());
    action(&timeline, cx);
    wait(cx, |cx| {
        host.read_with(cx, |h, cx| h._workspace.read(cx).toast.is_some())
    });
    let after = lib.observe(&format!("book:{book}")).unwrap();
    assert_eq!(
        after.version, before.version,
        "a rejected edit committed a book write"
    );
    assert_eq!(
        after.value, before.value,
        "a rejected edit changed retained data"
    );
}

#[gpui::test]
fn local_view_edits_keep_equal_count_hidden_pin_binding(cx: &mut TestAppContext) {
    let (_dir, lib, id) = seed();
    let (view, target, pin) = pin_only_target(&lib, &id);
    call(&lib, "entry.trash", json!({"book":id,"id":target}));
    let raw = lib.observe(&format!("book:{id}")).unwrap().value["timeline_views"][&view.id].clone();
    let listed = call(&lib, "timeline_view.list", json!({"book":id}));
    for field in ["lanes", "placements", "pins"] {
        assert_eq!(
            raw[field].as_object().unwrap().len(),
            listed[0][field].as_array().unwrap().len()
        );
    }
    assert!(
        listed[0]["pins"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == pin)
            .unwrap()["entry"]
            .is_null()
    );
    let (host, cx) = visual(cx, &lib, &id);
    let t = host.read_with(cx, |h, _| h.timeline.clone());
    t.update(cx, |t, cx| {
        t.reorder_lane(view.lanes[0].entry.clone(), 1, cx)
    });
    wait(cx, |_| {
        call(&lib, "timeline_view.list", json!({"book":id}))[0]["lanes"][0]["entry"]
            == view.lanes[1].entry
    });
    refresh(&host, &lib, &id, cx);
    t.update(cx, |t, cx| t.remove_lane(view.lanes[0].entry.clone(), cx));
    wait(cx, |_| {
        call(&lib, "timeline_view.list", json!({"book":id}))[0]["lanes"]
            .as_array()
            .unwrap()
            .len()
            == 1
    });
    refresh(&host, &lib, &id, cx);
    t.update(cx, |t, cx| t.add_lane(view.lanes[0].entry.clone(), cx));
    wait(cx, |_| {
        call(&lib, "timeline_view.list", json!({"book":id}))[0]["lanes"]
            .as_array()
            .unwrap()
            .len()
            == 2
    });
    refresh(&host, &lib, &id, cx);
    cx.update(|w, cx| t.update(cx, |t, cx| t.rename(false, w, cx)));
    frame(cx);
    cx.simulate_input("Synthetic local rename");
    cx.simulate_keystrokes("enter");
    wait(cx, |_| {
        call(&lib, "timeline_view.list", json!({"book":id}))[0]["name"] == "Synthetic local rename"
    });
    let after =
        lib.observe(&format!("book:{id}")).unwrap().value["timeline_views"][&view.id].clone();
    assert_eq!(after["pins"], raw["pins"]);
    call(&lib, "entry.restore", json!({"book":id,"id":target}));
    assert_eq!(
        call(&lib, "timeline_view.list", json!({"book":id}))[0]["pins"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == pin)
            .unwrap()["entry"],
        target
    );
}

#[gpui::test]
fn rename_keeps_its_displayed_guard_through_refresh_and_only_explicit_retry_rebases(
    cx: &mut TestAppContext,
) {
    let (_dir, lib, id) = seed();
    let (view, _target, pin) = pin_only_target(&lib, &id);
    let (host, cx) = visual(cx, &lib, &id);
    let t = host.read_with(cx, |h, _| h.timeline.clone());
    cx.update(|w, cx| t.update(cx, |t, cx| t.rename(false, w, cx)));
    frame(cx);
    cx.simulate_input("Synthetic retained draft");
    call(
        &lib,
        "timeline_view.put_pin",
        json!({"book":id,"view":view.id,"pin":{"id":pin,"at":42.,"label":"Synthetic external update","color":"#654321"}}),
    );
    refresh(&host, &lib, &id, cx);
    frame(cx);
    rejected_without_book_write(&host, &lib, &id, cx, |_, cx| {
        cx.simulate_keystrokes("enter")
    });
    let before = lib.observe(&format!("book:{id}")).unwrap();
    let focus = cx.update(|_, cx| cx.focus_handle());
    cx.update(|w, cx| focus.focus(w, cx));
    frame(cx);
    assert_eq!(
        lib.observe(&format!("book:{id}")).unwrap().version,
        before.version,
        "blur must not retry a failed draft"
    );
    cx.simulate_click(
        gpui::point(gpui::px(50.), gpui::px(15.)),
        gpui::Modifiers::none(),
    );
    cx.simulate_keystrokes("enter");
    wait(cx, |_| {
        call(&lib, "timeline_view.list", json!({"book":id}))[0]["name"]
            == "Synthetic retained draft"
    });
    let after =
        lib.observe(&format!("book:{id}")).unwrap().value["timeline_views"][&view.id].clone();
    assert_eq!(after["pins"][&pin]["label"], "Synthetic external update");
    assert_eq!(after["pins"][&pin]["at"], 42.);
}

#[gpui::test]
fn pin_edits_reject_hidden_fields_and_creation_cannot_replace_an_existing_pin(
    cx: &mut TestAppContext,
) {
    use dr_view_timeline::v3::PinEdit;
    let (_dir, lib, id) = seed();
    let (view, target, pin) = pin_only_target(&lib, &id);
    let original = view.pins.iter().find(|p| p.id == pin).unwrap().clone();
    call(&lib, "entry.trash", json!({"book":id,"id":target}));
    let (host, cx) = visual(cx, &lib, &id);
    for edit in [
        PinEdit::Label("Synthetic rejected rename".into()),
        PinEdit::Color(Some("#654321".into())),
        PinEdit::At(7.),
        PinEdit::Bind(None),
    ] {
        rejected_without_book_write(&host, &lib, &id, cx, |t, cx| {
            t.update(cx, |t, cx| t.edit_pin(pin.clone(), edit, cx));
        });
    }
    rejected_without_book_write(&host, &lib, &id, cx, |t, cx| {
        let mut stale = original.clone();
        stale.entry = None;
        t.update(cx, |t, cx| t.put_pin(stale, cx));
    });
    call(&lib, "entry.restore", json!({"book":id,"id":target}));
    refresh(&host, &lib, &id, cx);
    let t = host.read_with(cx, |h, _| h.timeline.clone());
    t.update(cx, |t, cx| {
        t.edit_pin(
            pin.clone(),
            PinEdit::Label("Synthetic accepted rename".into()),
            cx,
        )
    });
    wait(cx, |_| {
        lib.observe(&format!("book:{id}")).unwrap().value["timeline_views"][&view.id]["pins"][&pin]
            ["label"]
            == "Synthetic accepted rename"
    });
    let actual =
        lib.observe(&format!("book:{id}")).unwrap().value["timeline_views"][&view.id]["pins"][&pin]
            .clone();
    assert_eq!(actual["entry"], target);
    assert_eq!(actual["at"], original.at);
    assert_eq!(actual["color"], json!(original.color));
}

#[gpui::test]
fn hidden_lanes_and_placements_survive_local_rename_and_unrelated_pin_edits(
    cx: &mut TestAppContext,
) {
    use dr_view_timeline::v3::PinEdit;
    let (_dir, lib, id) = seed();
    let (view, _target, pin) = pin_only_target(&lib, &id);
    let (host, cx) = visual(cx, &lib, &id);
    let t = host.read_with(cx, |h, _| h.timeline.clone());
    for (i, hidden) in [&view.lanes[0].entry, &view.placements[0].entry]
        .into_iter()
        .enumerate()
    {
        call(&lib, "entry.trash", json!({"book":id,"id":hidden}));
        refresh(&host, &lib, &id, cx);
        let before =
            lib.observe(&format!("book:{id}")).unwrap().value["timeline_views"][&view.id].clone();
        cx.update(|w, cx| t.update(cx, |t, cx| t.rename(false, w, cx)));
        frame(cx);
        let name = format!("Synthetic hidden-data rename {i}");
        cx.simulate_input(&name);
        cx.simulate_keystrokes("enter");
        wait(cx, |_| {
            call(&lib, "timeline_view.list", json!({"book":id}))[0]["name"] == name
        });
        let after =
            lib.observe(&format!("book:{id}")).unwrap().value["timeline_views"][&view.id].clone();
        for field in ["lanes", "placements", "pins"] {
            assert_eq!(after[field], before[field]);
        }
        call(&lib, "entry.restore", json!({"book":id,"id":hidden}));
        refresh(&host, &lib, &id, cx);
    }
    call(
        &lib,
        "entry.trash",
        json!({"book":id,"id":view.placements[0].entry}),
    );
    refresh(&host, &lib, &id, cx);
    let before =
        lib.observe(&format!("book:{id}")).unwrap().value["timeline_views"][&view.id].clone();
    t.update(cx, |t, cx| {
        t.edit_pin(pin.clone(), PinEdit::Color(Some("#234567".into())), cx)
    });
    wait(cx, |_| {
        lib.observe(&format!("book:{id}")).unwrap().value["timeline_views"][&view.id]["pins"][&pin]
            ["color"]
            == "#234567"
    });
    call(
        &lib,
        "entry.restore",
        json!({"book":id,"id":view.placements[0].entry}),
    );
    assert_eq!(
        lib.observe(&format!("book:{id}")).unwrap().value["timeline_views"][&view.id]["placements"],
        before["placements"]
    );
}

#[gpui::test]
fn independently_successful_controls_merge_pin_fields_and_preserve_external_placements(
    cx: &mut TestAppContext,
) {
    use dr_view_timeline::v3::PinEdit;
    let (_dir, lib, id) = seed();
    let (view, _target, pin) = pin_only_target(&lib, &id);
    let (host, cx) = visual(cx, &lib, &id);
    let first = host.read_with(cx, |h, _| h.timeline.clone());
    let second = cx.update(|_, cx| {
        let host = BottomHost {
            workspace: host.read(cx)._workspace.downgrade(),
            library: Some(lib.clone()),
            book_id: id.clone(),
            book: Rc::new(Book::load(&lib, &id).unwrap()),
            target: None,
        };
        cx.new(|_| Timeline::new(&host))
    });
    first.update(cx, |t, cx| {
        t.edit_pin(
            pin.clone(),
            PinEdit::Label("Synthetic independent rename".into()),
            cx,
        )
    });
    wait(cx, |_| {
        lib.observe(&format!("book:{id}")).unwrap().value["timeline_views"][&view.id]["pins"][&pin]
            ["label"]
            == "Synthetic independent rename"
    });
    // The second control still has its earlier UI snapshot.
    second.update(cx, |t, cx| {
        t.edit_pin(pin.clone(), PinEdit::Color(Some("#456789".into())), cx)
    });
    wait(cx, |_| {
        lib.observe(&format!("book:{id}")).unwrap().value["timeline_views"][&view.id]["pins"][&pin]
            ["color"]
            == "#456789"
    });
    call(
        &lib,
        "timeline_view.place",
        json!({"book":id,"view":view.id,"entry":view.placements[0].entry,"at":42.,"span":9.}),
    );
    rejected_without_book_write(&host, &lib, &id, cx, |t, cx| {
        t.update(cx, |t, cx| {
            t.reorder_lane(view.lanes[0].entry.clone(), 1, cx)
        })
    });
    refresh(&host, &lib, &id, cx);
    first.update(cx, |t, cx| {
        t.reorder_lane(view.lanes[0].entry.clone(), 1, cx)
    });
    wait(cx, |_| {
        call(&lib, "timeline_view.list", json!({"book":id}))[0]["lanes"][0]["entry"]
            == view.lanes[1].entry
    });
    let raw = lib.observe(&format!("book:{id}")).unwrap().value["timeline_views"][&view.id].clone();
    assert_eq!(raw["pins"][&pin]["label"], "Synthetic independent rename");
    assert_eq!(raw["pins"][&pin]["color"], "#456789");
    assert_eq!(raw["placements"][&view.placements[0].entry]["at"], 42.);
    assert_eq!(raw["placements"][&view.placements[0].entry]["span"], 9.);
}

#[gpui::test]
fn local_lane_removal_keeps_hidden_backup_membership_positions_and_other_views(
    cx: &mut TestAppContext,
) {
    let (_dir, lib, id) = seed();
    let b = Book::load(&lib, &id).unwrap();
    let view = b.v3().unwrap().timeline_views[0].clone();
    let member = view.placements[0].entry.clone();
    let first = view.lanes[0].entry.clone();
    let backup = view.lanes[1].entry.clone();
    call(
        &lib,
        "membership.add",
        json!({"book":id,"host":backup,"member":member}),
    );
    call(
        &lib,
        "timeline_view.put",
        json!({"book":id,"view":{"id":"synthetic-other-view","name":"Synthetic independent view","lanes":[{"entry":first,"pos":"a0"}],"placements":[{"entry":member,"at":99.,"span":8.}]}}),
    );
    call(&lib, "entry.trash", json!({"book":id,"id":backup}));
    let before = lib.observe(&format!("book:{id}")).unwrap().value;
    let (host, cx) = visual(cx, &lib, &id);
    let t = host.read_with(cx, |h, _| h.timeline.clone());
    t.update(cx, |t, cx| {
        t.select(view.id.clone(), cx);
        t.remove_lane(first.clone(), cx);
    });
    wait(cx, |_| {
        lib.observe(&format!("book:{id}")).unwrap().value["timeline_views"][&view.id]["lanes"]
            .get(&first)
            .is_none()
    });
    let after = lib.observe(&format!("book:{id}")).unwrap().value;
    assert_eq!(after["memberships"], before["memberships"]);
    assert_eq!(
        after["timeline_views"]["synthetic-other-view"],
        before["timeline_views"]["synthetic-other-view"]
    );
    assert_eq!(
        after["timeline_views"][&view.id]["placements"][&member],
        before["timeline_views"][&view.id]["placements"][&member]
    );
    assert_eq!(
        after["timeline_views"][&view.id]["pins"],
        before["timeline_views"][&view.id]["pins"]
    );
    assert_eq!(
        after["timeline_views"][&view.id]["lanes"][&backup],
        before["timeline_views"][&view.id]["lanes"][&backup]
    );
    call(&lib, "entry.restore", json!({"book":id,"id":backup}));
    let shown = call(&lib, "timeline_view.list", json!({"book":id}));
    assert!(
        shown
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == view.id)
            .unwrap()["placements"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["entry"] == member)
    );
}

#[gpui::test]
fn act_track_creation_auto_numbers_places_at_top_toggles_and_renders_intervals_and_short_segments(
    cx: &mut TestAppContext,
) {
    use gpui::{Modifiers, MouseButton, point, px};
    let (_dir, lib, id) = seed();
    let initial = Book::load(&lib, &id).unwrap();
    let b0 = initial.v3().unwrap();
    let view0 = b0.timeline_views[0].clone();
    let storyline0 = view0.lanes[0].entry.clone();
    let source = b0
        .entries
        .iter()
        .find(|e| {
            e.template.as_deref() == Some("tpl-idea")
                && !view0.placements.iter().any(|p| p.entry == e.id)
        })
        .unwrap_or_else(|| {
            b0.entries
                .iter()
                .find(|e| e.template.as_deref() == Some("tpl-idea"))
                .unwrap()
        })
        .clone();
    assert!(!view0.placements.iter().any(|p| p.entry == source.id));

    let (host, cx) = visual(cx, &lib, &id);
    let ws = host.read_with(cx, |h, _| h._workspace.clone());
    wait(cx, |cx| ws.read_with(cx, |ws, _| ws.book.v3().is_some()));
    refresh(&host, &lib, &id, cx);
    let t = host.read_with(cx, |h, _| h.timeline.clone());
    assert!(t.read_with(cx, |t, _| t.lanes().iter().all(|l| !l.act_track)));

    // 1. Create first act track -> top-level "Acts" (`tpl-act-track`), placed first with `act_track = true`.
    t.update(cx, |t, cx| t.create_act_track(cx));
    wait(cx, |_| {
        call(&lib, "timeline_view.list", json!({"book":id}))[0]["lanes"][0]["act_track"]
            == json!(true)
    });
    refresh(&host, &lib, &id, cx);
    let act1 = t.read_with(cx, |t, _| {
        let lanes = t.lanes();
        assert!(lanes[0].act_track);
        assert_eq!(lanes[0].title, "Acts");
        assert!(!lanes[1].act_track);
        lanes[0].id.clone()
    });
    let act1_entry = call(&lib, "entry.get", json!({"book":id,"id":act1}));
    assert!(act1_entry["parent"].is_null());
    assert_eq!(act1_entry["template"], "tpl-act-track");
    let tpl =
        lib.observe(&format!("book:{id}")).unwrap().value["templates"]["tpl-act-track"].clone();
    assert_eq!(tpl["lane"], true);
    assert_eq!(tpl["settings"]["default_template"], "tpl-idea");
    assert_eq!(tpl["settings"]["allow"], json!([]));
    assert!(tpl["settings"]["home"].is_null());

    // 2. Create second act track -> auto-numbered "Acts 2", placed right after "Acts" and above normal lanes.
    t.update(cx, |t, cx| t.create_act_track(cx));
    wait(cx, |_| {
        call(&lib, "timeline_view.list", json!({"book":id}))[0]["lanes"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|l| l["act_track"] == json!(true))
            .count()
            == 2
    });
    refresh(&host, &lib, &id, cx);
    let act2 = t.read_with(cx, |t, _| {
        let lanes = t.lanes();
        assert_eq!(lanes[0].id, act1);
        assert!(lanes[1].act_track);
        assert_eq!(lanes[1].title, "Acts 2");
        assert!(!lanes[2].act_track);
        lanes[1].id.clone()
    });

    // 3. Reordering within act-track group stays above normal lanes.
    t.update(cx, |t, cx| t.reorder_lane(act1.clone(), 1, cx));
    wait(cx, |_| {
        call(&lib, "timeline_view.list", json!({"book":id}))[0]["lanes"][0]["entry"] == act2
    });
    refresh(&host, &lib, &id, cx);
    t.read_with(cx, |t, _| {
        let lanes = t.lanes();
        assert_eq!(lanes[0].id, act2);
        assert_eq!(lanes[1].id, act1);
        assert!(!lanes[2].act_track);
    });

    // 4. Create entry directly inside `act1` -> Idea leaf under `act1`, membership + interval `span = 4.0`.
    t.update(cx, |t, cx| t.create_entry_in_lane(act1.clone(), cx));
    wait(cx, |_| {
        call(&lib, "membership.list", json!({"book":id}))
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["host"] == act1)
    });
    refresh(&host, &lib, &id, cx);
    frame(cx);
    let created_id = call(&lib, "membership.list", json!({"book":id}))
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["host"] == act1)
        .unwrap()["member"]
        .as_str()
        .unwrap()
        .to_owned();
    let created_entry = call(&lib, "entry.get", json!({"book":id,"id":created_id}));
    assert_eq!(created_entry["parent"], act1);
    assert_eq!(created_entry["template"], "tpl-idea");
    let created_clip = cx
        .debug_bounds(Box::leak(
            format!("v3-clip-{act1}-{created_id}").into_boxed_str(),
        ))
        .unwrap();
    assert!(
        f32::from(created_clip.size.width) > 60.,
        "interval clip width = {:?}",
        created_clip.size.width
    );

    // 5. Drag external unplaced entry onto `act1` -> `span: None` short segment (14..=24 px), then resize into interval.
    let page = PageViewHost {
        workspace: ws.downgrade(),
        library: lib.clone(),
        book_id: id.clone(),
        book: Rc::new(Book::load(&lib, &id).unwrap()),
    };
    drag_to_lane(
        &host,
        EntryDrag::new(page, &source.id, &source.title),
        &act1,
        cx,
    );
    wait(cx, |_| {
        call(&lib, "membership.list", json!({"book":id}))
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["host"] == act1 && m["member"] == source.id)
    });
    refresh(&host, &lib, &id, cx);
    frame(cx);
    let source_after = call(&lib, "entry.get", json!({"book":id,"id":source.id}));
    assert_eq!(source_after["parent"], json!(source.parent));
    let short_clip = cx
        .debug_bounds(Box::leak(
            format!("v3-clip-{act1}-{}", source.id).into_boxed_str(),
        ))
        .unwrap();
    let short_w = f32::from(short_clip.size.width);
    assert!(
        (14.0..=24.0).contains(&short_w),
        "short segment width expected in 14..=24, got {short_w}"
    );
    let handle = cx
        .debug_bounds(Box::leak(
            format!("v3-resize-{act1}-{}", source.id).into_boxed_str(),
        ))
        .unwrap()
        .center();
    let stretched = handle + point(px(120.), px(0.));
    cx.simulate_mouse_down(handle, MouseButton::Left, Modifiers::none());
    cx.simulate_mouse_move(stretched, MouseButton::Left, Modifiers::none());
    frame(cx);
    cx.simulate_mouse_up(stretched, MouseButton::Left, Modifiers::none());
    wait(cx, |_| {
        call(&lib, "timeline_view.list", json!({"book":id}))[0]["placements"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["entry"] == source.id && p["span"].as_f64().is_some_and(|s| s > 2.0))
    });
    refresh(&host, &lib, &id, cx);
    frame(cx);
    let long_clip = cx
        .debug_bounds(Box::leak(
            format!("v3-clip-{act1}-{}", source.id).into_boxed_str(),
        ))
        .unwrap();
    assert!(f32::from(long_clip.size.width) > 60.);

    // 6. Toggle existing storyline lane into act track and back.
    t.update(cx, |t, cx| {
        t.set_lane_act_track(storyline0.clone(), true, cx)
    });
    wait(cx, |_| {
        call(&lib, "timeline_view.list", json!({"book":id}))[0]["lanes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|l| l["entry"] == storyline0 && l["act_track"] == json!(true))
    });
    refresh(&host, &lib, &id, cx);
    assert!(t.read_with(cx, |t, _| {
        t.lanes()
            .iter()
            .take(3)
            .any(|l| l.id == storyline0 && l.act_track)
    }));
    t.update(cx, |t, cx| {
        t.set_lane_act_track(storyline0.clone(), false, cx)
    });
    wait(cx, |_| {
        call(&lib, "timeline_view.list", json!({"book":id}))[0]["lanes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|l| l["entry"] == storyline0 && l["act_track"].is_null())
    });
    refresh(&host, &lib, &id, cx);
    t.read_with(cx, |t, _| {
        let lanes = t.lanes();
        let pos = lanes.iter().position(|l| l.id == storyline0).unwrap();
        assert!(pos >= 2 && !lanes[pos].act_track);
    });
}
