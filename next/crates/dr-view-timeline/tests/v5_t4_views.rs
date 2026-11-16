//! Kernel v5 Track T4 (`t4-views`) regression suite:
//! - UI scale copy never refers to the scale as "时间" / "time" across all 9 locales
//! - Dragging in a view keeps lane page, whole-book view, and manuscript sequence aligned
//! - Same-coordinate tie-breaking follows lane order top-to-bottom
//! - View & lane menus expose Whole-Book View and "设为成书起点" (`project.update { root }`)
//! - Dragging an existing folder (`has_below`) into a view places residents on the scale,
//!   updates sidebar/folder order on drag, and preserves scale order on removal
//! - Normal lane creation (`v3-lane-new-lane`), storyline with `level == false`,
//!   deduplicated resident+member count, and `host` vs `parent` in `create_entry_in_lane`.

use std::{
    rc::Rc,
    time::{Duration, Instant},
};

use dr_doc::v3::novel::{TPL_ACT_TRACK, TPL_CATEGORY, TPL_CHAPTER, TPL_GROUP, TPL_STORYLINE};
use dr_shell::{
    Services, SettingsFile, ShellInfo, Workspace,
    book::Book,
    nav::Target,
    pages::{BottomHost, PageViewHost},
    v3::EntryDrag,
};
use dr_view_timeline::v3::{Timeline, model};
use dr_workspace::{Actor, Workspace as Library};
use gpui::{
    Context, Entity, Modifiers, MouseButton, Render, TestAppContext, VisualTestContext, Window,
    div, point, prelude::*, px, size,
};
use serde_json::{Value, json};

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

struct Host {
    timeline: Entity<Timeline>,
    workspace: Entity<Workspace>,
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
                        .id("t4-test-drag-source")
                        .debug_selector(|| "t4-test-drag-source".into())
                        .w(px(200.))
                        .h(px(30.))
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
        div().size(px(1.))
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

fn refresh(host: &Entity<Host>, lib: &Library, id: &str, cx: &mut VisualTestContext) {
    let book = Rc::new(Book::load(lib, id).unwrap());
    let ws = host.read_with(cx, |h, _| h.workspace.downgrade());
    let bh = BottomHost {
        workspace: ws,
        library: Some(lib.clone()),
        book_id: id.to_owned(),
        book,
        target: None,
    };
    host.update(cx, |h, cx| {
        h.timeline.update(cx, |t, cx| t.refresh(&bh, cx));
    });
    frame(cx);
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
        );
    });
    let book = Rc::new(Book::load(lib, id).unwrap());
    let (host, vcx) = cx.add_window_view(|w, cx| {
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
            workspace: ws,
            drag: None,
        }
    });
    vcx.simulate_resize(size(px(1280.0), px(720.0)));
    (host, vcx)
}

fn sync_all(
    host: &Entity<Host>,
    ws: &Entity<Workspace>,
    lib: &Library,
    id: &str,
    cx: &mut VisualTestContext,
) {
    let target_rev = Book::load(lib, id).unwrap().v3().unwrap().revision.clone();
    wait(cx, |cx| {
        ws.read_with(cx, |ws, _| {
            ws.book.v3().is_some_and(|b| b.revision == target_rev)
        })
    });
    refresh(host, lib, id, cx);
}

fn page_host(
    ws: &Entity<Workspace>,
    lib: &Library,
    id: &str,
    cx: &mut VisualTestContext,
) -> PageViewHost {
    let book = ws.read_with(cx, |ws, _| ws.book.clone());
    PageViewHost {
        workspace: ws.downgrade(),
        library: lib.clone(),
        book_id: id.to_owned(),
        book,
    }
}

fn drag_entry_to(
    host: &Entity<Host>,
    drag: EntryDrag,
    target_selector: &'static str,
    offset_x: f32,
    cx: &mut VisualTestContext,
) {
    host.update(cx, |h, cx| {
        h.drag = Some(drag);
        cx.notify();
    });
    frame(cx);
    let source = cx.debug_bounds("t4-test-drag-source").unwrap().center();
    let bounds = cx.debug_bounds(target_selector).unwrap();
    let target = point(bounds.origin.x + px(offset_x), bounds.center().y);
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

#[test]
fn scale_copy_never_calls_view_scale_time_across_all_locales() {
    let own_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../dr-i18n/own");
    let forbidden = [
        "时间",
        "時間",
        "time",
        "시간",
        "tiempo",
        "cronolog",
        "chronolog",
        "zeit",
        "temps",
        "tempo",
    ];
    let mut checked_locales = 0usize;
    for entry in std::fs::read_dir(&own_dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        checked_locales += 1;
        let raw = std::fs::read_to_string(&path).unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        let section = parsed["v3Timeline"]
            .as_object()
            .expect("v3Timeline object must exist in every locale");
        for (k, val) in section {
            let text = val.as_str().unwrap().to_lowercase();
            for bad in forbidden {
                assert!(
                    !text.contains(bad),
                    "locale {:?} key v3Timeline.{k} = {:?} must not call the view scale time ({bad:?})",
                    path.file_name().unwrap(),
                    val.as_str().unwrap()
                );
            }
        }
    }
    assert_eq!(checked_locales, 9);
}

#[gpui::test]
fn view_drag_aligns_lane_and_whole_book_and_menus_open_whole_book(cx: &mut TestAppContext) {
    let (_dir, lib, id) = seed();
    let initial = Book::load(&lib, &id).unwrap();
    let b0 = initial.v3().unwrap();
    let manuscript = b0
        .entries
        .iter()
        .find(|e| e.template.as_deref() == Some("tpl-manuscript"))
        .unwrap()
        .id
        .clone();

    let lane_top = call(
        &lib,
        "entry.create",
        json!({"book": id, "parent": null, "title": "Top Lane", "template": TPL_STORYLINE}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let lane_bottom = call(
        &lib,
        "entry.create",
        json!({"book": id, "parent": null, "title": "Bottom Lane", "template": TPL_STORYLINE}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let ch_a = call(
        &lib,
        "entry.create",
        json!({"book": id, "parent": manuscript, "title": "Scale Ch A", "template": TPL_CHAPTER}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let ch_b = call(
        &lib,
        "entry.create",
        json!({"book": id, "parent": manuscript, "title": "Scale Ch B", "template": TPL_CHAPTER}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let ch_c = call(
        &lib,
        "entry.create",
        json!({"book": id, "parent": manuscript, "title": "Scale Ch C", "template": TPL_CHAPTER}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    call(
        &lib,
        "timeline_view.put",
        json!({"book": id, "view": {"id": "t4-auth-view", "name": "Authoritative View"}}),
    );
    call(
        &lib,
        "timeline_view.add_lane",
        json!({"book": id, "view": "t4-auth-view", "lane": lane_top}),
    );
    call(
        &lib,
        "timeline_view.add_lane",
        json!({"book": id, "view": "t4-auth-view", "lane": lane_bottom}),
    );

    // Attach entries to lanes: each immediately appears at the end of the view's scale!
    for (lane, ch) in [
        (&lane_top, &ch_a),
        (&lane_top, &ch_b),
        (&lane_bottom, &ch_c),
    ] {
        call(
            &lib,
            "membership.add",
            json!({"book": id, "host": lane, "member": ch}),
        );
    }
    let after_attach = call(&lib, "timeline_view.list", json!({"book": id}));
    let v_after = after_attach
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == "t4-auth-view")
        .unwrap();
    let placed_ats: Vec<(String, f64)> = v_after["placements"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| {
            (
                p["entry"].as_str().unwrap().to_owned(),
                p["at"].as_f64().unwrap(),
            )
        })
        .collect();
    assert_eq!(placed_ats.len(), 3);
    assert!(placed_ats[0].1 < placed_ats[1].1 && placed_ats[1].1 < placed_ats[2].1);

    let (host, cx) = visual(cx, &lib, &id);
    let ws = host.read_with(cx, |h, _| h.workspace.clone());
    sync_all(&host, &ws, &lib, &id, cx);
    let t = host.read_with(cx, |h, _| h.timeline.clone());
    t.update(cx, |t, cx| t.select("t4-auth-view".into(), cx));
    sync_all(&host, &ws, &lib, &id, cx);

    // A whole-book view of `t4-auth-view` (or one of its lanes), read along
    // its scale. The book has no start, so no menu sets one (DW).
    let flat = |from: dr_model::v3::FlattenFrom| -> Vec<String> {
        let book_id_parsed: dr_model::id::BookId = id.parse().unwrap();
        lib.read_book_v3(&id, move |doc, _| {
            let bb = dr_doc::v3::BorrowedBookV3::new(doc, &book_id_parsed).unwrap();
            let view = bb.view();
            let s = view.structure_snapshot();
            Ok(s.sequence(&from, true)
                .unwrap()
                .into_iter()
                .map(|f| f.entry.id.to_string())
                .collect())
        })
        .unwrap()
    };
    let view_seq = || {
        flat(dr_model::v3::FlattenFrom::View {
            view: "t4-auth-view".parse().unwrap(),
        })
    };

    // Drag `ch_a` (initially at `at = 0.0`) rightward past `ch_b` (`offset_x = 320.0`, `at = 16.0`)
    // on `lane_top` so order on `lane_top` becomes `[ch_b, ch_a]`.
    let page = page_host(&ws, &lib, &id, cx);
    let top_track_sel: &'static str = Box::leak(format!("v3-track-{lane_top}").into_boxed_str());
    drag_entry_to(
        &host,
        EntryDrag::new(page, &ch_a, "Scale Ch A"),
        top_track_sel,
        320.0,
        cx,
    );
    wait(cx, |_| {
        let snap = Book::load(&lib, &id).unwrap();
        snap.v3().unwrap().levels[&lane_top].members == vec![ch_b.clone(), ch_a.clone()]
    });

    // The lane page and the whole-book view of the view agree.
    let snap = Book::load(&lib, &id).unwrap();
    let v = snap.v3().unwrap();
    assert_eq!(
        v.levels[&lane_top].members,
        vec![ch_b.clone(), ch_a.clone()]
    );
    // `ch_b` is at `1.0`, `ch_c` is at `2.0`, and `ch_a` was dragged to `16.0`: `[ch_b, ch_c, ch_a]`.
    assert_eq!(view_seq(), vec![ch_b.clone(), ch_c.clone(), ch_a.clone()]);

    // Same-coordinate tie-breaking: place `ch_a` (top lane) and `ch_c` (bottom lane) at exact `at = 50.0`.
    call(
        &lib,
        "timeline_view.place",
        json!({"book": id, "view": "t4-auth-view", "entry": ch_a, "at": 50.0}),
    );
    call(
        &lib,
        "timeline_view.place",
        json!({"book": id, "view": "t4-auth-view", "entry": ch_c, "at": 50.0}),
    );
    assert_eq!(view_seq(), vec![ch_b.clone(), ch_a.clone(), ch_c.clone()]);

    // Reorder `lane_bottom` above `lane_top`: tie-breaking flips to `[ch_b, ch_c, ch_a]`!
    sync_all(&host, &ws, &lib, &id, cx);
    t.update(cx, |t, cx| t.reorder_lane(lane_bottom.clone(), -1, cx));
    wait(cx, |_| {
        call(&lib, "timeline_view.list", json!({"book": id}))
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == "t4-auth-view")
            .unwrap()["lanes"][0]["entry"]
            == lane_bottom
    });
    assert_eq!(view_seq(), vec![ch_b.clone(), ch_c.clone(), ch_a.clone()]);

    // Open Whole-Book View from the view and from a lane via the real
    // LaneActions menu; neither menu sets a book start any more.
    sync_all(&host, &ws, &lib, &id, cx);
    t.update(cx, |t, cx| t.open_book_view(cx));
    let view_target = Target::BookView("t4-auth-view".parse().unwrap());
    wait(cx, |cx| {
        ws.read_with(cx, |ws, _| ws.nav.is_selected(&view_target))
    });

    let lane_actions_sel: &'static str =
        Box::leak(format!("v3-lane-actions-{lane_top}").into_boxed_str());
    let actions_pt = cx.debug_bounds(lane_actions_sel).unwrap().center();
    cx.simulate_click(actions_pt, Modifiers::none());
    frame(cx);
    let open_lane_book_pt = cx.debug_bounds("v3-lane-open-book").unwrap().center();
    cx.simulate_click(open_lane_book_pt, Modifiers::none());
    let lane_target = Target::BookLane {
        view: "t4-auth-view".parse().unwrap(),
        entry: lane_top.parse().unwrap(),
    };
    wait(cx, |cx| {
        ws.read_with(cx, |ws, _| ws.nav.is_selected(&lane_target))
    });

    let actions_pt = cx.debug_bounds(lane_actions_sel).unwrap().center();
    cx.simulate_click(actions_pt, Modifiers::none());
    frame(cx);
    assert!(cx.debug_bounds("v3-lane-open-book").is_some());
    assert!(cx.debug_bounds("v3-lane-set-book-root").is_none());
    assert_eq!(
        flat(dr_model::v3::FlattenFrom::Lane {
            view: "t4-auth-view".parse().unwrap(),
            entry: lane_top.parse().unwrap(),
        }),
        vec![ch_b, ch_a]
    );
}

/// The chapter folder (level on, 「收别处的条目」 off) does not go into a
/// view, dragged or picked from the lanes menu, and the new-lane menu offers
/// only templates that take entries from elsewhere (DV, `kernel-v5.md` §16
/// 「泳道」). A storyline dragged the same way goes in.
#[gpui::test]
fn the_chapter_folder_does_not_go_into_a_view_and_the_lane_menus_offer_only_what_takes_entries(
    cx: &mut TestAppContext,
) {
    let (_dir, lib, id) = seed();
    let book = Book::load(&lib, &id).unwrap();
    let v = book.v3().unwrap();
    let root_of = |template: &str| {
        v.entries
            .iter()
            .find(|e| e.template.as_deref() == Some(template) && e.parent.is_none())
            .unwrap()
            .id
            .clone()
    };
    let manuscript = root_of("tpl-manuscript");
    let storylines = root_of("tpl-storylines");
    let storyline = call(
        &lib,
        "entry.create",
        json!({"book": id, "parent": storylines, "title": "新故事线", "template": TPL_STORYLINE}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    call(
        &lib,
        "timeline_view.put",
        json!({"book": id, "view": {"id": "t4-folder-view", "name": "Folder Scale View"}}),
    );
    let lanes_of = |lib: &Library| -> Vec<String> {
        call(lib, "timeline_view.list", json!({"book": id}))
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == "t4-folder-view")
            .unwrap()["lanes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| l["entry"].as_str().unwrap().to_owned())
            .collect()
    };

    let (host, cx) = visual(cx, &lib, &id);
    let ws = host.read_with(cx, |h, _| h.workspace.clone());
    sync_all(&host, &ws, &lib, &id, cx);
    let t = host.read_with(cx, |h, _| h.timeline.clone());
    t.update(cx, |t, cx| t.select("t4-folder-view".into(), cx));
    sync_all(&host, &ws, &lib, &id, cx);

    let page = page_host(&ws, &lib, &id, cx);
    drag_entry_to(
        &host,
        EntryDrag::new(page, &manuscript, "书稿"),
        "v3-empty-lanes-drop",
        120.0,
        cx,
    );
    sync_all(&host, &ws, &lib, &id, cx);
    assert!(lanes_of(&lib).is_empty(), "the folder is not a lane");

    let page = page_host(&ws, &lib, &id, cx);
    drag_entry_to(
        &host,
        EntryDrag::new(page, &storyline, "新故事线"),
        "v3-empty-lanes-drop",
        120.0,
        cx,
    );
    wait(cx, |_| !lanes_of(&lib).is_empty());
    assert_eq!(lanes_of(&lib), vec![storyline.clone()]);
    sync_all(&host, &ws, &lib, &id, cx);

    // The lanes menu lists what can be a lane, and the new-lane menu the
    // templates whose entries take entries from elsewhere.
    let lanes_btn = cx.debug_bounds("v3-timeline-lanes").unwrap().center();
    cx.simulate_click(lanes_btn, Modifiers::none());
    frame(cx);
    let add = |id: &str| format!("v3-lane-add-{id}");
    assert!(
        cx.debug_bounds(Box::leak(add(&manuscript).into_boxed_str()))
            .is_none()
    );
    assert!(
        cx.debug_bounds(Box::leak(add(&storyline).into_boxed_str()))
            .is_some()
    );
    let new_lane_btn = cx.debug_bounds("v3-lane-new-lane").unwrap().center();
    cx.simulate_click(new_lane_btn, Modifiers::none());
    frame(cx);
    let template = |id: &str| format!("v3-lane-template-{id}");
    assert!(
        cx.debug_bounds(Box::leak(template(TPL_STORYLINE).into_boxed_str()))
            .is_some()
    );
    assert!(
        cx.debug_bounds(Box::leak(template(TPL_GROUP).into_boxed_str()))
            .is_none()
    );
    assert!(
        cx.debug_bounds(Box::leak(template("tpl-manuscript").into_boxed_str()))
            .is_none()
    );
}

#[gpui::test]
fn lane_creation_offers_only_lanes_that_take_entries_and_creates_on_them_by_hanging(
    cx: &mut TestAppContext,
) {
    let (_dir, lib, id) = seed();
    call(
        &lib,
        "timeline_view.put",
        json!({"book": id, "view": {"id": "t4-create-view", "name": "Creation View"}}),
    );

    let (host, cx) = visual(cx, &lib, &id);
    let ws = host.read_with(cx, |h, _| h.workspace.clone());
    wait(cx, |cx| ws.read_with(cx, |ws, _| ws.book.v3().is_some()));
    let t = host.read_with(cx, |h, _| h.timeline.clone());
    t.update(cx, |t, cx| t.select("t4-create-view".into(), cx));
    refresh(&host, &lib, &id, cx);

    // 1. Create a normal storyline lane (`level == false, accept == true`) via `v3-lane-new-lane`.
    let lanes_btn = cx.debug_bounds("v3-timeline-lanes").unwrap().center();
    cx.simulate_click(lanes_btn, Modifiers::none());
    frame(cx);
    let new_lane_btn = cx.debug_bounds("v3-lane-new-lane").unwrap().center();
    cx.simulate_click(new_lane_btn, Modifiers::none());
    frame(cx);
    let storyline_tpl_sel: &'static str =
        Box::leak(format!("v3-lane-template-{TPL_STORYLINE}").into_boxed_str());
    let storyline_tpl_pt = cx.debug_bounds(storyline_tpl_sel).unwrap().center();
    cx.simulate_click(storyline_tpl_pt, Modifiers::none());
    wait(cx, |_| {
        call(&lib, "timeline_view.list", json!({"book": id}))
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["id"] == "t4-create-view" && v["lanes"].as_array().unwrap().len() == 1)
    });
    refresh(&host, &lib, &id, cx);
    let storyline_lane = t.read_with(cx, |t, _| {
        let lanes = t.lanes();
        assert_eq!(lanes.len(), 1);
        assert!(!lanes[0].act_track);
        lanes[0].id.clone()
    });
    let sl_entry = call(&lib, "entry.get", json!({"book": id, "id": storyline_lane}));
    assert_eq!(sl_entry["level"], false);
    assert_eq!(sl_entry["below"]["settings"]["accept"], true);

    // Creating an entry on an `accept == true` storyline lane calls `entry.create { host }`,
    // attaching membership and placing it at scale end.
    t.update(cx, |t, cx| {
        t.create_entry_in_lane(storyline_lane.clone(), cx)
    });
    wait(cx, |_| {
        call(&lib, "membership.list", json!({"book": id}))
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["host"] == storyline_lane)
    });
    refresh(&host, &lib, &id, cx);
    t.read_with(cx, |t, _| {
        let lanes = t.lanes();
        assert_eq!(lanes[0].members, 1);
        assert_eq!(lanes[0].clips.len(), 1);
        assert_eq!(lanes[0].clips[0].span, None);
    });

    // 2. A template that only has its level on (`TPL_GROUP`) makes no lane:
    // a lane takes entries from elsewhere (DV, `kernel-v5.md` §16 「泳道」).
    let groups = |lib: &Library| {
        call(lib, "entry.list", json!({"book": id, "all": true}))
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["template"] == TPL_GROUP)
            .count()
    };
    let groups_before = groups(&lib);
    t.update(cx, |t, cx| t.create_lane(TPL_GROUP.into(), false, cx));
    refresh(&host, &lib, &id, cx);
    let lanes_now = |lib: &Library| {
        call(lib, "timeline_view.list", json!({"book": id}))
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == "t4-create-view")
            .unwrap()["lanes"]
            .as_array()
            .unwrap()
            .len()
    };
    assert_eq!(lanes_now(&lib), 1);
    assert_eq!(groups(&lib), groups_before, "no group was made for a lane");

    // A lane with both switches (`TPL_CATEGORY`) holds only what is hung on
    // it: an entry created on it lives under it and is hung on it, counted
    // once; one that only lives under it is not on the lane.
    t.update(cx, |t, cx| t.create_lane(TPL_CATEGORY.into(), false, cx));
    wait(cx, |_| lanes_now(&lib) == 2);
    refresh(&host, &lib, &id, cx);
    let group_lane = t.read_with(cx, |t, _| t.lanes()[1].id.clone());
    t.update(cx, |t, cx| t.create_entry_in_lane(group_lane.clone(), cx));
    wait(cx, |_| {
        call(&lib, "membership.list", json!({"book": id}))
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["host"] == group_lane)
    });
    // It lives under the lane and is hung on it: the entry page lists it
    // once, under what lives there; the membership says it is hung.
    let hung = call(&lib, "membership.list", json!({"book": id}))
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["host"] == group_lane)
        .unwrap()["member"]
        .as_str()
        .unwrap()
        .to_owned();
    let resident = call(
        &lib,
        "entry.create",
        json!({"book": id, "parent": group_lane, "title": "只住着的"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    refresh(&host, &lib, &id, cx);
    t.read_with(cx, |t, _| {
        let lane = t.lanes().into_iter().find(|l| l.id == group_lane).unwrap();
        assert_eq!(lane.members, 1);
        assert_eq!(lane.clips.len(), 1);
        assert_eq!(lane.clips[0].entry, hung);
        assert!(lane.clips.iter().all(|c| c.entry != resident));
    });
    let snap = Book::load(&lib, &id).unwrap();
    let tv = snap
        .v3()
        .unwrap()
        .timeline_views
        .iter()
        .find(|v| v.id == "t4-create-view")
        .unwrap();
    let rendered = model::lanes(snap.v3().unwrap(), tv);
    let group_rendered = rendered.iter().find(|l| l.id == group_lane).unwrap();
    assert_eq!(group_rendered.members, 1);
    assert_eq!(group_rendered.clips.len(), 1);

    // 3. Create an act track (`TPL_ACT_TRACK`) and create an entry on it: placed on the track with interval span!
    t.update(cx, |t, cx| t.create_act_track(TPL_ACT_TRACK.into(), cx));
    wait(cx, |_| {
        call(&lib, "timeline_view.list", json!({"book": id}))
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["id"] == "t4-create-view" && v["lanes"].as_array().unwrap().len() == 3)
    });
    refresh(&host, &lib, &id, cx);
    let act_lane = t.read_with(cx, |t, _| {
        let lanes = t.lanes();
        assert!(lanes[0].act_track);
        lanes[0].id.clone()
    });
    t.update(cx, |t, cx| t.create_entry_in_lane(act_lane.clone(), cx));
    wait(cx, |_| {
        call(&lib, "membership.list", json!({"book": id}))
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["host"] == act_lane)
    });
    refresh(&host, &lib, &id, cx);
    t.read_with(cx, |t, _| {
        let lane = t.lanes().into_iter().find(|l| l.id == act_lane).unwrap();
        assert_eq!(lane.members, 1);
        assert_eq!(lane.clips.len(), 1);
        assert_eq!(lane.clips[0].span, Some(model::DEFAULT_SPAN));
    });

    // 4. Turning off `accept` on the `level == false` storyline lane hides it and its orphan
    // placement in the view without deleting data; turning `accept` back on restores both!
    let placed_sl_before = t.read_with(cx, |t, _| {
        let sl = t
            .lanes()
            .into_iter()
            .find(|l| l.id == storyline_lane)
            .unwrap();
        (sl.clips[0].entry.clone(), sl.clips[0].at)
    });
    call(
        &lib,
        "timeline_view.place",
        json!({"book": id, "view": "t4-create-view", "entry": placed_sl_before.0, "at": 27.5}),
    );
    call(
        &lib,
        "entry.update",
        json!({"book": id, "id": storyline_lane, "overrides": {"accept": false}}),
    );
    sync_all(&host, &ws, &lib, &id, cx);
    t.read_with(cx, |t, _| {
        assert!(
            t.lanes().iter().all(|l| l.id != storyline_lane),
            "storyline lane with accept=false and level=false must not render in view"
        );
    });
    call(
        &lib,
        "entry.update",
        json!({"book": id, "id": storyline_lane, "overrides": {"accept": null}}),
    );
    sync_all(&host, &ws, &lib, &id, cx);
    t.read_with(cx, |t, _| {
        let sl = t
            .lanes()
            .into_iter()
            .find(|l| l.id == storyline_lane)
            .expect("storyline lane must return when accept is turned back on");
        assert_eq!(sl.clips.len(), 1);
        assert_eq!(sl.clips[0].entry, placed_sl_before.0);
        assert_eq!(sl.clips[0].at, 27.5);
    });
}

#[gpui::test]
fn cross_lane_drag_moves_hang_option_multi_hangs_sidebar_drop_detaches_and_narrow_cards_slice_whole_chars(
    cx: &mut TestAppContext,
) {
    let (_dir, lib, id) = seed();
    let book = Book::load(&lib, &id).unwrap();
    let v = book.v3().unwrap();
    let manuscript = v
        .entries
        .iter()
        .find(|e| e.template.as_deref() == Some("tpl-manuscript") && e.parent.is_none())
        .unwrap()
        .id
        .clone();
    let storylines = v
        .entries
        .iter()
        .find(|e| e.template.as_deref() == Some("tpl-storylines") && e.parent.is_none())
        .unwrap()
        .id
        .clone();
    let chapter = call(
        &lib,
        "entry.create",
        json!({"book": id, "parent": manuscript, "template": TPL_CHAPTER, "title": "第三章钟楼下"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let lane_a = call(
        &lib,
        "entry.create",
        json!({"book": id, "parent": storylines, "template": TPL_STORYLINE, "title": "主线甲"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let lane_b = call(
        &lib,
        "entry.create",
        json!({"book": id, "parent": storylines, "template": TPL_STORYLINE, "title": "支线乙"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    call(
        &lib,
        "timeline_view.put",
        json!({"book": id, "view": {"id": "t9-drag-view", "name": "Drag View"}}),
    );
    call(
        &lib,
        "timeline_view.add_lane",
        json!({"book": id, "view": "t9-drag-view", "lane": lane_a}),
    );
    call(
        &lib,
        "timeline_view.add_lane",
        json!({"book": id, "view": "t9-drag-view", "lane": lane_b}),
    );

    let (host, cx) = visual(cx, &lib, &id);
    let ws = host.read_with(cx, |h, _| h.workspace.clone());
    sync_all(&host, &ws, &lib, &id, cx);
    let t = host.read_with(cx, |h, _| h.timeline.clone());
    t.update(cx, |t, cx| t.select("t9-drag-view".into(), cx));
    sync_all(&host, &ws, &lib, &id, cx);

    let track_a: &'static str = Box::leak(format!("v3-track-{lane_a}").into_boxed_str());
    let track_b: &'static str = Box::leak(format!("v3-track-{lane_b}").into_boxed_str());
    let hosts_of = |lib: &Library, member: &str| -> Vec<String> {
        call(lib, "membership.list", json!({"book": id}))
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["member"] == member)
            .map(|m| m["host"].as_str().unwrap().to_owned())
            .collect()
    };

    // 1. Drag from left sidebar onto lane_a: hangs on lane_a, residence stays `manuscript`.
    let page = page_host(&ws, &lib, &id, cx);
    drag_entry_to(
        &host,
        EntryDrag::new(page, &chapter, "第三章钟楼下"),
        track_a,
        140.0,
        cx,
    );
    wait(cx, |_| hosts_of(&lib, &chapter) == vec![lane_a.clone()]);
    assert_eq!(
        Book::load(&lib, &id)
            .unwrap()
            .v3()
            .unwrap()
            .entry(&chapter)
            .unwrap()
            .parent
            .as_deref(),
        Some(manuscript.as_str())
    );
    sync_all(&host, &ws, &lib, &id, cx);

    let placements = || {
        Book::load(&lib, &id)
            .unwrap()
            .v3()
            .unwrap()
            .timeline_view("t9-drag-view")
            .unwrap()
            .placements
            .clone()
    };
    let before_move = placements();
    // 2. Drag clip from lane_a onto lane_b without ⌥: moves hang (`换一处挂`).
    let page = page_host(&ws, &lib, &id, cx);
    drag_entry_to(
        &host,
        EntryDrag::new(page, &chapter, "第三章钟楼下").with_timeline_clip("t9-drag-view", &lane_a),
        track_b,
        200.0,
        cx,
    );
    wait(cx, |_| hosts_of(&lib, &chapter) == vec![lane_b.clone()]);
    sync_all(&host, &ws, &lib, &id, cx);

    lib.undo(&Actor::User)
        .unwrap()
        .expect("one undo restores the hang and scale");
    assert_eq!(hosts_of(&lib, &chapter), vec![lane_a.clone()]);
    assert_eq!(placements(), before_move);
    sync_all(&host, &ws, &lib, &id, cx);

    // The hung row in the sidebar also transfers its hang to the other lane.
    let page = page_host(&ws, &lib, &id, cx);
    drag_entry_to(
        &host,
        EntryDrag::new(page, &chapter, "第三章钟楼下").with_hung_host(&lane_a),
        track_b,
        212.0,
        cx,
    );
    wait(cx, |_| hosts_of(&lib, &chapter) == vec![lane_b.clone()]);
    sync_all(&host, &ws, &lib, &id, cx);

    // 3. Drag clip from lane_b onto lane_a WITH ⌥: multi-hangs (`多挂一处`).
    let page = page_host(&ws, &lib, &id, cx);
    host.update(cx, |h, cx| {
        h.drag = Some(
            EntryDrag::new(page, &chapter, "第三章钟楼下")
                .with_timeline_clip("t9-drag-view", &lane_b),
        );
        cx.notify();
    });
    frame(cx);
    let source = cx.debug_bounds("t4-test-drag-source").unwrap().center();
    let bounds_a = cx.debug_bounds(track_a).unwrap();
    let drop_pt = point(bounds_a.origin.x + px(260.0), bounds_a.center().y);
    let alt = Modifiers {
        alt: true,
        ..Modifiers::none()
    };
    cx.simulate_mouse_down(source, MouseButton::Left, alt);
    cx.simulate_mouse_move(source + point(px(8.), px(0.)), MouseButton::Left, alt);
    frame(cx);
    cx.simulate_mouse_move(drop_pt, MouseButton::Left, alt);
    frame(cx);
    cx.simulate_mouse_up(drop_pt, MouseButton::Left, alt);
    frame(cx);
    wait(cx, |_| hosts_of(&lib, &chapter).len() == 2);
    sync_all(&host, &ws, &lib, &id, cx);

    // 4. Drag clip from lane_a back onto left sidebar: detaches from lane_a (`摘名`),
    // keeping lane_b and residence untouched.
    let page = page_host(&ws, &lib, &id, cx);
    let clip_drag = EntryDrag::new(page.clone(), &chapter, "第三章钟楼下")
        .with_timeline_clip("t9-drag-view", &lane_a);
    cx.update(|_, cx| {
        assert!(dr_shell::v3::tabs::detach_timeline_clip(
            &page, &clip_drag, cx
        ));
    });
    wait(cx, |_| hosts_of(&lib, &chapter) == vec![lane_b.clone()]);
    assert_eq!(
        Book::load(&lib, &id)
            .unwrap()
            .v3()
            .unwrap()
            .entry(&chapter)
            .unwrap()
            .parent
            .as_deref(),
        Some(manuscript.as_str())
    );

    // 5. Whole-char narrowest card slicing: never clips half a character, never adds `…`.
    cx.update(|window, _| {
        let font = dr_ui::fonts::Role::Ui.font(dr_ui::fonts::weight::REGULAR);
        let one_or_two =
            model::slice_whole_chars("第三章钟楼下", 14.0, px(11.0), font.clone(), window);
        assert!(!one_or_two.is_empty());
        assert!(!one_or_two.contains('…'));
        assert!("第三章钟楼下".starts_with(&one_or_two));
        assert!(one_or_two.chars().count() <= 2);
        let full = model::slice_whole_chars("第三章钟楼下", 200.0, px(13.0), font, window);
        assert_eq!(full, "第三章钟楼下");
    });

    // 6. Pinch zooms horizontal scale, and ⌥+pinch zooms vertical lane height.
    let track_center = cx.debug_bounds(track_b).unwrap().center();
    cx.simulate_event(gpui::PinchEvent {
        position: track_center,
        delta: 0.25,
        modifiers: Modifiers::none(),
        phase: gpui::TouchPhase::Moved,
    });
    frame(cx);
    assert!(t.read_with(cx, |t, _| t.zoom() > 1.1));
    cx.simulate_event(gpui::PinchEvent {
        position: track_center,
        delta: 0.30,
        modifiers: alt,
        phase: gpui::TouchPhase::Moved,
    });
    frame(cx);
    assert!(t.read_with(cx, |t, _| t.zoom_y() > 1.1));
}
