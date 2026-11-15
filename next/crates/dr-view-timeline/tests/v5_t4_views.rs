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

use dr_doc::v3::novel::{TPL_ACT_TRACK, TPL_CHAPTER, TPL_GROUP, TPL_STORYLINE};
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
fn view_drag_aligns_lane_whole_book_and_manuscript_and_menus_set_book_root_and_open_whole_book(
    cx: &mut TestAppContext,
) {
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

    // Set `t4-auth-view` as `project.book.root` via `set_view_as_book_root` (wired to `v3-view-set-book-root`).
    t.update(cx, |t, cx| t.set_view_as_book_root(cx));
    wait(cx, |_| {
        call(&lib, "project.get", json!({"book": id}))["book"]["root"]
            == json!({"kind": "view", "view": "t4-auth-view"})
    });
    sync_all(&host, &ws, &lib, &id, cx);

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

    // Verify all 3 surfaces agree: lane page, whole-book sequence, and manuscript sequence!
    let snap = Book::load(&lib, &id).unwrap();
    let v = snap.v3().unwrap();
    assert_eq!(
        v.levels[&lane_top].members,
        vec![ch_b.clone(), ch_a.clone()]
    );
    // `ch_b` is at `1.0`, `ch_c` is at `2.0`, and `ch_a` was dragged to `16.0`: `[ch_b, ch_c, ch_a]`.
    let manuscript_seq: Vec<String> = v.manuscript.iter().map(|m| m.entry.clone()).collect();
    assert_eq!(
        manuscript_seq,
        vec![ch_b.clone(), ch_c.clone(), ch_a.clone()]
    );
    let book_id_parsed: dr_model::id::BookId = id.parse().unwrap();
    let whole_view_seq: Vec<String> = lib
        .read_book_v3(&id, move |doc, _| {
            let bb = dr_doc::v3::BorrowedBookV3::new(doc, &book_id_parsed).unwrap();
            let view = bb.view();
            let s = view.structure_snapshot();
            Ok(s.sequence(
                &dr_model::v3::BookRoot::View {
                    view: "t4-auth-view".parse().unwrap(),
                },
                true,
            )
            .unwrap()
            .into_iter()
            .map(|f| f.entry.id.to_string())
            .collect())
        })
        .unwrap();
    assert_eq!(whole_view_seq, manuscript_seq);

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
    let tie_top_first: Vec<String> = Book::load(&lib, &id)
        .unwrap()
        .v3()
        .unwrap()
        .manuscript
        .iter()
        .map(|m| m.entry.clone())
        .collect();
    assert_eq!(
        tie_top_first,
        vec![ch_b.clone(), ch_a.clone(), ch_c.clone()]
    );

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
    let tie_bottom_first: Vec<String> = Book::load(&lib, &id)
        .unwrap()
        .v3()
        .unwrap()
        .manuscript
        .iter()
        .map(|m| m.entry.clone())
        .collect();
    assert_eq!(
        tie_bottom_first,
        vec![ch_b.clone(), ch_c.clone(), ch_a.clone()]
    );

    // Open Whole-Book View from the view and from a lane via the real LaneActions menu,
    // and set the lane as `project.book.root`!
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
    let set_lane_root_pt = cx.debug_bounds("v3-lane-set-book-root").unwrap().center();
    cx.simulate_click(set_lane_root_pt, Modifiers::none());
    wait(cx, |_| {
        call(&lib, "project.get", json!({"book": id}))["book"]["root"]
            == json!({"kind": "lane", "view": "t4-auth-view", "entry": lane_top})
    });
    let lane_root_manuscript: Vec<String> = Book::load(&lib, &id)
        .unwrap()
        .v3()
        .unwrap()
        .manuscript
        .iter()
        .map(|m| m.entry.clone())
        .collect();
    assert_eq!(lane_root_manuscript, vec![ch_b, ch_a]);
}

#[gpui::test]
fn dragging_chapter_folder_into_view_places_chapters_updates_sidebar_and_preserves_order_when_removed(
    cx: &mut TestAppContext,
) {
    let (_dir, lib, id) = seed();
    let manuscript = Book::load(&lib, &id)
        .unwrap()
        .v3()
        .unwrap()
        .entries
        .iter()
        .find(|e| e.template.as_deref() == Some("tpl-manuscript"))
        .unwrap()
        .id
        .clone();
    // Ensure at least 3 direct chapters reside under `manuscript`.
    for idx in 1..=3 {
        call(
            &lib,
            "entry.create",
            json!({"book": id, "parent": manuscript, "title": format!("Folder Ch {idx}"), "template": TPL_CHAPTER}),
        );
    }
    let manual_chapters = Book::load(&lib, &id).unwrap().v3().unwrap().levels[&manuscript]
        .children
        .clone();
    assert!(manual_chapters.len() >= 3);

    call(
        &lib,
        "timeline_view.put",
        json!({"book": id, "view": {"id": "t4-folder-view", "name": "Folder Scale View"}}),
    );

    let (host, cx) = visual(cx, &lib, &id);
    let ws = host.read_with(cx, |h, _| h.workspace.clone());
    sync_all(&host, &ws, &lib, &id, cx);
    let t = host.read_with(cx, |h, _| h.timeline.clone());
    t.update(cx, |t, cx| t.select("t4-folder-view".into(), cx));
    sync_all(&host, &ws, &lib, &id, cx);

    // Drag the chapter folder (`manuscript`, `level == true, accept == false`) into the empty view!
    let page = page_host(&ws, &lib, &id, cx);
    drag_entry_to(
        &host,
        EntryDrag::new(page, &manuscript, "书稿"),
        "v3-empty-lanes-drop",
        120.0,
        cx,
    );
    wait(cx, |_| {
        call(&lib, "timeline_view.list", json!({"book": id}))
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["id"] == "t4-folder-view" && !v["lanes"].as_array().unwrap().is_empty())
    });
    sync_all(&host, &ws, &lib, &id, cx);

    // Chapters are placed onto the scale in manual order!
    let clip_order_before: Vec<String> = t.read_with(cx, |t, _| {
        let lanes = t.lanes();
        assert_eq!(lanes.len(), 1);
        assert_eq!(lanes[0].id, manuscript);
        lanes[0].clips.iter().map(|c| c.entry.clone()).collect()
    });
    assert_eq!(clip_order_before, manual_chapters);

    // Dragging the first chapter rightward past all others (`offset_x = 400.0`, `at = 20.0`)
    // updates the sidebar/folder order (`ws.book.v3().levels[&manuscript].children`)!
    let first_ch = manual_chapters[0].clone();
    let folder_track_sel: &'static str =
        Box::leak(format!("v3-track-{manuscript}").into_boxed_str());
    let page = page_host(&ws, &lib, &id, cx);
    drag_entry_to(
        &host,
        EntryDrag::new(page, &first_ch, "First Chapter"),
        folder_track_sel,
        400.0,
        cx,
    );
    wait(cx, |cx| {
        ws.read_with(cx, |ws, _| {
            ws.book
                .v3()
                .and_then(|b| b.levels.get(&manuscript))
                .and_then(|l| l.children.last())
                == Some(&first_ch)
        })
    });
    let reordered_children = ws.read_with(cx, |ws, _| {
        ws.book.v3().unwrap().levels[&manuscript].children.clone()
    });
    assert_eq!(reordered_children.last(), Some(&first_ch));

    // Remove the folder from the view: placements in `t4-folder-view` are cleared while
    // the folder's scale order is preserved!
    sync_all(&host, &ws, &lib, &id, cx);
    t.update(cx, |t, cx| t.remove_lane(manuscript.clone(), cx));
    wait(cx, |_| {
        call(&lib, "timeline_view.list", json!({"book": id}))
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["id"] == "t4-folder-view" && v["lanes"].as_array().unwrap().is_empty())
    });
    sync_all(&host, &ws, &lib, &id, cx);
    let after_remove = ws.read_with(cx, |ws, _| ws.book.clone());
    let v_after = after_remove.v3().unwrap();
    assert_eq!(v_after.levels[&manuscript].children, reordered_children);
    let tv_after = v_after
        .timeline_views
        .iter()
        .find(|v| v.id == "t4-folder-view")
        .unwrap();
    assert!(tv_after.placements.is_empty());
}

#[gpui::test]
fn normal_lane_creation_deduplicates_resident_and_member_and_dispatches_host_vs_parent(
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

    // 2. Create a `level == true, accept == false` folder lane (`TPL_GROUP`) and create an entry on it:
    // calls `entry.create { parent }` without creating any membership!
    t.update(cx, |t, cx| t.create_lane(TPL_GROUP.into(), false, cx));
    wait(cx, |_| {
        call(&lib, "timeline_view.list", json!({"book": id}))
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["id"] == "t4-create-view" && v["lanes"].as_array().unwrap().len() == 2)
    });
    refresh(&host, &lib, &id, cx);
    let group_lane = t.read_with(cx, |t, _| t.lanes()[1].id.clone());
    let memberships_before = call(&lib, "membership.list", json!({"book": id}));
    t.update(cx, |t, cx| t.create_entry_in_lane(group_lane.clone(), cx));
    wait(cx, |_| {
        !call(&lib, "entry.get", json!({"book": id, "id": group_lane}))["below"]["children"]
            .as_array()
            .unwrap()
            .is_empty()
    });
    assert_eq!(
        call(&lib, "membership.list", json!({"book": id})),
        memberships_before,
        "creating on a level-only lane must use `parent` without creating membership"
    );
    refresh(&host, &lib, &id, cx);
    let child_id = call(&lib, "entry.get", json!({"book": id, "id": group_lane}))["below"]["children"]
        [0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    t.read_with(cx, |t, _| {
        let lane = t.lanes().into_iter().find(|l| l.id == group_lane).unwrap();
        assert_eq!(lane.members, 1);
        assert_eq!(lane.clips.len(), 1);
        assert_eq!(lane.clips[0].entry, child_id);
    });

    // Enable `accept` on `group_lane` AND attach `child_id` (already residing in `group_lane`)
    // via `membership.add`: per §16, `lane.members` and `lane.clips` count `child_id` ONCE!
    call(
        &lib,
        "entry.update",
        json!({"book": id, "id": group_lane, "overrides": {"accept": true}}),
    );
    call(
        &lib,
        "membership.add",
        json!({"book": id, "host": group_lane, "member": child_id}),
    );
    let snap_dedup = Book::load(&lib, &id).unwrap();
    let tv_dedup = snap_dedup
        .v3()
        .unwrap()
        .timeline_views
        .iter()
        .find(|v| v.id == "t4-create-view")
        .unwrap();
    let rendered = model::lanes(snap_dedup.v3().unwrap(), tv_dedup);
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
