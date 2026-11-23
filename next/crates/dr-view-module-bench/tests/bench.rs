//! CM3's workbench in a real workspace window on GPUI's test platform
//! (`custom-modules.md` §7, §8): the pill and the side columns it brings,
//! given back when another pill comes to the front, closed, or a fill
//! covers the paper; blocks added, moved and taken away with the entry's
//! values kept; the preview's four rows; a press on the preview picking a
//! node and only the vocabulary's steps offered for it; ⌘Z and ⇧⌘Z; a
//! change made elsewhere shown at once, and a write over it refused. The
//! modules are dr-testkit's samples (`fixtures/modules/`).

use std::time::{Duration, Instant};

use dr_model::custom_module::{LookSize, ModuleValue, validate_module_value};
use dr_shell::{
    Services, SettingsFile, ShellInfo,
    nav::{Open, Target},
    settings::registry,
    workspace::FillPlace,
};
use dr_ui::Appearance;
use dr_view_module_bench::{Bench, Breadth, Content, LOOK_TAB};
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use gpui::{Entity, Modifiers, TestAppContext, VisualTestContext, px, size};
use serde_json::{Value, json};

const FORESHADOWING: &str =
    include_str!("../../dr-testkit/fixtures/modules/foreshadowing.driftingmodule");

struct Env {
    _dir: tempfile::TempDir,
    ws: Workspace,
    book: String,
    entry: String,
    module: String,
}

fn call(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input)
        .unwrap_or_else(|e| panic!("{name}: {e}"))["output"]
        .clone()
}

/// A book whose template `tpl-mod` draws 伏笔追踪 (`mod-c`), an entry of it
/// with one item kept, and my module.
fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let lib = dr_store::Library::open(dir.path().join("lib"), library_options("test")).unwrap();
    let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
    let book = call(&ws, "project.create", json!({"name": "工作台"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let module = call(
        &ws,
        "custom_module.create",
        json!({"value": serde_json::from_str::<Value>(FORESHADOWING).unwrap()}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    call(
        &ws,
        "entry_template.put",
        json!({"book": book, "template": {
            "id": "tpl-mod", "name": "章", "modules": [
                {"id": "mod-text", "kind": "prose", "name": "正文"},
                {"id": "mod-c", "kind": "custom", "name": "伏笔追踪", "config": {"module": module}}
            ]
        }}),
    );
    let entry = call(
        &ws,
        "entry.create",
        json!({"book": book, "title": "雾港", "template": "tpl-mod"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let item = call(
        &ws,
        "module.add_custom_item",
        json!({"book": book, "entry": entry, "module": "mod-c", "path": [], "list": "items"}),
    )["item"]
        .as_str()
        .unwrap()
        .to_owned();
    call(
        &ws,
        "module.set_custom_value",
        json!({"book": book, "entry": entry, "module": "mod-c",
               "path": [{"list": "items", "item": item}], "block": "line", "value": "墙上的旧照片"}),
    );
    Env {
        _dir: dir,
        ws,
        book,
        entry,
        module,
    }
}

fn mine(e: &Env) -> ModuleValue {
    let v = call(&e.ws, "custom_module.get", json!({"id": e.module}))["value"].clone();
    serde_json::from_value(v).unwrap()
}

fn line_value(e: &Env) -> Value {
    let r = call(
        &e.ws,
        "module.read_custom",
        json!({"book": e.book, "entry": e.entry, "module": "mod-c"}),
    );
    r["values"]["items"]["value"][0]["values"]["line"]["value"].clone()
}

fn draw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| {
        window.simulate_next_frame(cx);
        window.draw(cx).clear(cx);
    });
    cx.run_until_parked();
}

fn bounds(cx: &mut VisualTestContext, selector: &str) -> Option<gpui::Bounds<gpui::Pixels>> {
    let selector: &'static str = Box::leak(selector.to_owned().into_boxed_str());
    cx.debug_bounds(selector)
}

fn shown(cx: &mut VisualTestContext, selector: &str) -> bool {
    bounds(cx, selector).is_some()
}

fn click(cx: &mut VisualTestContext, selector: &str) {
    draw(cx);
    let at = bounds(cx, selector)
        .unwrap_or_else(|| panic!("{selector} is drawn"))
        .center();
    cx.simulate_mouse_move(at, None, Modifiers::none());
    draw(cx);
    cx.simulate_click(at, Modifiers::none());
    draw(cx);
}

fn until(cx: &mut VisualTestContext, what: &str, done: impl Fn(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        draw(cx);
        if done(cx) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn workspace<'a>(
    cx: &'a mut TestAppContext,
    e: &Env,
) -> (Entity<dr_shell::Workspace>, &'a mut VisualTestContext) {
    cx.executor().allow_parking();
    let lib = e.ws.clone();
    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "0.2.0-dev",
                url_scheme: "drifting-next-dev",
                forced_appearance: Some(Appearance::Light),
            },
            Services {
                deep_links: None,
                crash_reports: None,
                library: Some(lib),
                library_failure: None,
                book: Some(e.book.clone()),
            },
            SettingsFile::in_memory(),
            cx,
        );
        dr_view_module_bench::init(cx);
        dr_shell::Settings::update(cx, |f| f.set(registry::REDUCE_MOTION, json!(true), None))
            .unwrap();
    });
    let (view, cx) = cx.add_window_view(dr_shell::Workspace::new);
    cx.simulate_resize(size(px(1440.0), px(900.0)));
    let deadline = Instant::now() + Duration::from_secs(10);
    while view.read_with(cx, |ws, _| ws.book.v3().is_none()) {
        assert!(Instant::now() < deadline, "the book did not open");
        draw(cx);
        std::thread::sleep(Duration::from_millis(5));
    }
    // Both columns open (a new layout keeps them closed).
    view.update_in(cx, |ws, window, cx| {
        ws.toggle_left(window, cx);
        ws.toggle_right(window, cx);
    });
    draw(cx);
    (view, cx)
}

fn module_target(e: &Env) -> Target {
    Target::Module(e.module.parse().unwrap())
}

/// Opens the workbench and waits until it has read its module.
fn open_bench(
    view: &Entity<dr_shell::Workspace>,
    e: &Env,
    cx: &mut VisualTestContext,
) -> Entity<Bench> {
    let target = module_target(e);
    view.update(cx, |ws, cx| ws.open(target, Open::KEEP, cx));
    let id = e.module.parse().unwrap();
    until(cx, "the workbench", |cx| {
        let ws = view.clone();
        cx.update(|_, cx| {
            dr_view_module_bench::bench_of(&ws, &id, cx).is_some_and(|b| b.read(cx).value.is_some())
        })
    });
    let ws = view.clone();
    let bench = cx.update(|_, cx| dr_view_module_bench::bench_of(&ws, &id, cx).unwrap());
    settle(&bench, cx);
    bench
}

fn settle(bench: &Entity<Bench>, cx: &mut VisualTestContext) {
    let b = bench.clone();
    until(cx, "the workbench to store", move |cx| {
        b.read_with(cx, |b, _| b.is_settled())
    });
}

/// The workbench is a pill of the project; while it is in front the side
/// columns are its own, and they come back when another pill is in front,
/// when its pill closes and while a fill covers the paper. Its own columns
/// do not fill.
#[gpui::test]
fn the_side_columns_follow_the_workbench_pill(cx: &mut TestAppContext) {
    let e = env();
    let (view, cx) = workspace(cx, &e);
    let ours = |cx: &mut VisualTestContext| {
        shown(cx, "module-bench-left")
            && shown(cx, "right-page-tab-row")
            && shown(cx, "module-bench-look-panel")
    };
    let theirs =
        |cx: &mut VisualTestContext| shown(cx, "v3-sidebar") && !shown(cx, "module-bench-left");
    draw(cx);
    assert!(theirs(cx), "the project's columns before");
    let _bench = open_bench(&view, &e, cx);
    until(cx, "the workbench's columns", ours);
    assert!(!shown(cx, "v3-sidebar"));
    assert!(shown(cx, "module-bench"), "its paper");
    assert_eq!(
        view.read_with(cx, |ws, _| ws.page_tab()).as_deref(),
        Some(LOOK_TAB)
    );
    // Its own columns do not fill (the full moons are dimmed).
    let filled = view.update(cx, |ws, cx| {
        ws.enter_fill_with_motion(FillPlace::Left, true, cx)
    });
    assert!(!filled);
    let filled = view.update(cx, |ws, cx| {
        ws.enter_fill_with_motion(FillPlace::Right, true, cx)
    });
    assert!(!filled);
    // Another pill in front: the project's columns.
    let entry = Target::Entry {
        id: e.entry.parse().unwrap(),
        module: None,
    };
    view.update(cx, |ws, cx| ws.open(entry, Open::KEEP, cx));
    until(cx, "the project's columns", theirs);
    // Back to the workbench.
    view.update(cx, |ws, cx| {
        let i = ws
            .nav
            .tabs()
            .iter()
            .position(|t| t.key() == module_target(&e).key())
            .unwrap();
        ws.nav.activate(i);
        cx.notify();
    });
    until(cx, "the workbench's columns again", ours);
    // The bottom panel fills: the paper is covered, the columns are the
    // project's; leaving the fill brings the workbench's back.
    let filled = view.update(cx, |ws, cx| {
        ws.enter_fill_with_motion(FillPlace::Bottom, true, cx)
    });
    assert!(filled);
    until(cx, "the project's columns under a fill", |cx| {
        !shown(cx, "module-bench-left")
    });
    view.update(cx, |ws, cx| ws.exit_fill_with_motion(true, cx));
    until(cx, "the workbench's columns after the fill", ours);
    // The Agent is the right column's last tab: the same conversation.
    let target = module_target(&e);
    view.update(cx, |ws, cx| ws.show_page_tab(&target, "agent", cx));
    draw(cx);
    assert_eq!(
        view.read_with(cx, |ws, _| ws.page_tab()).as_deref(),
        Some("agent")
    );
    // Its pill closes: the project's columns.
    view.update(cx, |ws, cx| {
        ws.nav.forget(&module_target(&e));
        cx.notify();
    });
    until(cx, "the project's columns after closing", theirs);
}

/// Blocks added from 「积木」 go into the picked list; a block is renamed
/// and moved by id; one taken away takes its nodes but the entry keeps its
/// value, back with ⌘Z.
#[gpui::test]
fn blocks_change_and_entries_keep_their_values(cx: &mut TestAppContext) {
    let e = env();
    let (view, cx) = workspace(cx, &e);
    let bench = open_bench(&view, &e, cx);
    until(cx, "「装什么」", |cx| {
        shown(cx, "module-bench-block-items")
    });
    // Picked 「伏笔」 (a list), a 「数字」 goes into its items.
    click(cx, "module-bench-block-items");
    assert_eq!(
        bench.read_with(cx, |b, _| b.sel_block.clone()).as_deref(),
        Some("items")
    );
    click(cx, "module-bench-add-number");
    settle(&bench, cx);
    let v = mine(&e);
    validate_module_value(&v).unwrap();
    let items = &v.block("items").unwrap().blocks;
    assert_eq!(items.len(), 4);
    let added = items.last().unwrap().id.clone();
    assert_eq!(v.scope_of(&added), Some(Some("items")));
    // Taken away: gone from my module and from what the entry shows...
    click(cx, "module-bench-block-line");
    let at = bounds(cx, "module-bench-block-line").unwrap().center();
    cx.simulate_mouse_move(at, None, Modifiers::none());
    click(cx, "module-bench-block-delete-line");
    settle(&bench, cx);
    assert!(mine(&e).block("line").is_none());
    let deadline = Instant::now() + Duration::from_secs(10);
    while line_value(&e) != Value::Null {
        assert!(Instant::now() < deadline, "the copy follows my module");
        draw(cx);
    }
    // ...and back with ⌘Z, the entry's words with it.
    cx.update(|window, cx| {
        let focus = bench.read(cx).focus.clone();
        focus.focus(window, cx);
    });
    cx.dispatch_action(dr_shell::actions::Undo);
    settle(&bench, cx);
    assert!(mine(&e).block("line").is_some());
    let deadline = Instant::now() + Duration::from_secs(10);
    while line_value(&e) != json!("墙上的旧照片") {
        assert!(
            Instant::now() < deadline,
            "the value comes back with the block"
        );
        draw(cx);
    }
    // ⇧⌘Z takes it away again; ⌘Z twice more undoes the number too.
    cx.dispatch_action(dr_shell::actions::Redo);
    settle(&bench, cx);
    assert!(mine(&e).block("line").is_none());
    cx.dispatch_action(dr_shell::actions::Undo);
    cx.dispatch_action(dr_shell::actions::Undo);
    settle(&bench, cx);
    let v = mine(&e);
    assert_eq!(v.block("items").unwrap().blocks.len(), 3);
    assert_eq!(
        v,
        serde_json::from_str::<ModuleValue>(FORESHADOWING).unwrap()
    );
}

/// The preview's four rows set what it draws; a press on a node picks it
/// and the right column shows 「长什么样」 with it, offering only the
/// vocabulary's steps, and a step chosen is stored and valid.
#[gpui::test]
fn the_preview_picks_nodes_and_the_look_sets_steps(cx: &mut TestAppContext) {
    let e = env();
    let (view, cx) = workspace(cx, &e);
    let bench = open_bench(&view, &e, cx);
    until(cx, "the preview", |cx| shown(cx, "module-bench-preview"));
    let width = |cx: &mut VisualTestContext| {
        f32::from(bounds(cx, "module-bench-preview").unwrap().size.width)
    };
    let medium = width(cx);
    bench.update(cx, |b, cx| b.set_breadth(Breadth::Narrow, cx));
    draw(cx);
    let narrow = width(cx);
    bench.update(cx, |b, cx| b.set_breadth(Breadth::Wide, cx));
    draw(cx);
    let wide = width(cx);
    assert!(narrow < medium && medium < wide, "{narrow} {medium} {wide}");
    for content in [Content::Blank, Content::Real, Content::Sample] {
        bench.update(cx, |b, cx| b.set_content(content, cx));
        draw(cx);
        assert!(shown(cx, "module-bench-preview"));
    }
    bench.update(cx, |b, cx| b.set_dark(true, cx));
    draw(cx);
    assert!(shown(cx, "module-bench-preview"));
    bench.update(cx, |b, cx| b.set_dark(false, cx));
    // The borrowed entry is the book's 「雾港」.
    assert_eq!(
        bench
            .read_with(cx, |b, _| b.real.as_ref().map(|r| r.title.clone()))
            .as_deref(),
        Some("雾港")
    );
    // Show the right column's 「写给 Agent」, then press the list's first
    // item box in the preview: picked, and 「长什么样」 shows it.
    let target = module_target(&e);
    view.update(cx, |ws, cx| ws.show_page_tab(&target, "guide", cx));
    bench.update(cx, |b, cx| b.set_size(LookSize::Block, cx));
    draw(cx);
    let preview = bounds(cx, "module-bench-preview").unwrap();
    let at = preview.origin + gpui::point(px(40.0), px(56.0));
    cx.simulate_mouse_move(at, None, Modifiers::none());
    draw(cx);
    cx.simulate_click(at, Modifiers::none());
    draw(cx);
    let picked = bench.read_with(cx, |b, _| b.sel_node.clone());
    assert!(picked.is_some(), "a node is picked");
    assert_eq!(
        view.read_with(cx, |ws, _| ws.page_tab()).as_deref(),
        Some(LOOK_TAB)
    );
    // Pick the each node from the tree: its rows are the each's.
    click(cx, "module-bench-node-root");
    assert_eq!(bench.read_with(cx, |b, _| b.sel_node.clone()), Some(vec![]));
    assert!(shown(cx, "module-bench-prop-sep"));
    assert!(shown(cx, "module-bench-prop-link"));
    assert!(!shown(cx, "module-bench-prop-font"), "no type for a list");
    // Its gap, 24: stored, valid.
    bench.update(cx, |b, cx| {
        b.change(
            |v| {
                dr_view_module_bench::edit::set_prop(
                    v,
                    LookSize::Block,
                    &[],
                    dr_view_module_bench::edit::Prop::Gap(24),
                )
            },
            cx,
        )
    });
    settle(&bench, cx);
    let v = mine(&e);
    validate_module_value(&v).unwrap();
    let dr_model::custom_module::Node::Each(each) = &v.look.block else {
        panic!("the root is the list");
    };
    assert_eq!(each.gap, Some(24));
    // The item box: a box's rows, nothing outside the vocabulary.
    click(cx, "module-bench-node-0");
    for row in [
        "dir", "gap", "pad", "align", "width", "border", "bg", "radius", "deco",
    ] {
        assert!(shown(cx, &format!("module-bench-prop-{row}")), "{row}");
    }
    // 铺满 follows 一块 until laid out on its own.
    bench.update(cx, |b, cx| b.set_size(LookSize::Full, cx));
    draw(cx);
    assert!(!shown(cx, "module-bench-node-root"), "no tree of its own");
    bench.update(cx, |b, cx| {
        b.change(
            |v| dr_view_module_bench::edit::set_own(v, LookSize::Full, true),
            cx,
        )
    });
    settle(&bench, cx);
    draw(cx);
    assert!(shown(cx, "module-bench-node-root"));
    assert!(mine(&e).look.full.is_some());
}

/// My module changed elsewhere (the Agent, another device): the workbench
/// shows it at once; a change made here over one it had not seen is not
/// written, and the author hears so.
#[gpui::test]
fn a_change_made_elsewhere_shows_and_is_never_written_over(cx: &mut TestAppContext) {
    let e = env();
    let (view, cx) = workspace(cx, &e);
    let bench = open_bench(&view, &e, cx);
    let mut other = mine(&e);
    other.name = "伏笔（别处改的）".into();
    call(
        &e.ws,
        "custom_module.update",
        json!({"id": e.module, "value": serde_json::to_value(&other).unwrap()}),
    );
    let b = bench.clone();
    until(cx, "the change made elsewhere", move |cx| {
        b.read_with(cx, |b, _| b.name() == Some("伏笔（别处改的）"))
    });
    // The pill's name follows.
    let target = module_target(&e);
    let title = cx.update(|_, cx| dr_shell::workspace::title_of(&view.read(cx).book, &target, cx));
    assert_eq!(title.as_ref(), "伏笔（别处改的）");
    // Changed again elsewhere, and here before the workbench read it.
    let mut third = other.clone();
    third.name = "伏笔（第三处）".into();
    call(
        &e.ws,
        "custom_module.update",
        json!({"id": e.module, "value": serde_json::to_value(&third).unwrap()}),
    );
    bench.update(cx, |b, cx| {
        b.change(
            |v| dr_view_module_bench::edit::rename(v, "伏笔（这里改的）"),
            cx,
        )
    });
    settle(&bench, cx);
    assert_eq!(mine(&e).name, "伏笔（第三处）", "not written over");
    assert_eq!(
        bench
            .read_with(cx, |b, _| b.name().map(str::to_owned))
            .as_deref(),
        Some("伏笔（第三处）")
    );
    assert!(
        view.read_with(cx, |ws, _| ws.toast.is_some()),
        "the author hears it was not saved"
    );
}
