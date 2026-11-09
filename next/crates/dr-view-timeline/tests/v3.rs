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
