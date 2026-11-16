//! T9's 模板结构 (`kernel-v5.md` §9, `W12Template`): the level table is the
//! tree, a row dropped on a level moves under it, the floating panel's groups
//! are 「住在」「挂在」, the legend hides a kind of line, and Esc closes the
//! panel before it leaves the fill.
use std::{
    cell::Cell,
    collections::HashMap,
    rc::Rc,
    time::{Duration, Instant},
};

use dr_shell::{
    Services, SettingsFile, ShellInfo, Workspace as Shell,
    actions::Undo,
    book::v3::BookV3,
    strings::t,
    v3::{
        self, Rendered,
        template_structure::{EdgeKind, Graph, Structure, level_rows},
    },
    workspace::FillPlace,
};
use dr_workspace::Workspace;
use gpui::{
    App, AppContext as _, Context, Entity, IntoElement, Modifiers, MouseButton, Render,
    TestAppContext, VisualTestContext, Window, div, point, px, size,
};

fn seed() -> (tempfile::TempDir, Workspace, String) {
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
    let ws = Workspace::open_dir(dir.path(), "0.2.0-dev").unwrap();
    (dir, ws, id)
}

struct DummyPart;
impl Render for DummyPart {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
    }
}

/// A window on `id`'s book, with stand-in level displays and a stand-in
/// settings-only template editor that counts how often it was left.
fn open<'a>(
    cx: &'a mut TestAppContext,
    lib: &Workspace,
    id: &str,
    leaves: Rc<Cell<usize>>,
) -> (Entity<Shell>, &'a mut VisualTestContext) {
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
                ..Default::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
        dr_shell::strings::Strings::install(dr_i18n::Locale::ZhCn, cx);
        // Panels open and fill at once: the clicks land where they are drawn.
        dr_shell::Settings::update(cx, |f| {
            f.set(
                dr_shell::settings::registry::REDUCE_MOTION,
                serde_json::json!(true),
                None,
            )
        })
        .unwrap();
        for display in ["list", "board", "grid", "island"] {
            v3::add_level_display(cx, display, |_, _, cx| Rendered::new(cx.new(|_| DummyPart)));
        }
        v3::add_level_settings(cx, |_, _, cx| Rendered::new(cx.new(|_| DummyPart)));
        v3::add_compact_template_editor(cx, move |_, _, cx| {
            let leaves = leaves.clone();
            Some(
                Rendered::new(cx.new(|_| DummyPart))
                    .on_leave(move |_| leaves.set(leaves.get() + 1)),
            )
        });
    });
    let (view, cx) = cx.add_window_view(Shell::new);
    cx.update(|window, _| window.activate_window());
    cx.simulate_resize(size(px(1600.0), px(1000.0)));
    (view, cx)
}

fn pump(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.run_until_parked();
}

fn wait(
    view: &Entity<Shell>,
    cx: &mut VisualTestContext,
    what: &str,
    done: impl Fn(&Shell, &App) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        pump(cx);
        if view.read_with(cx, |ws, cx| done(ws, cx)) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(2));
    }
}

/// Fills the left column into 模板结构.
fn enter_structure(view: &Entity<Shell>, cx: &mut VisualTestContext) -> Entity<Structure> {
    wait(view, cx, "the book", |ws, _| ws.book.v3().is_some());
    cx.update(|window, cx| view.update(cx, |ws, cx| ws.open_template_structure(window, cx)));
    wait(view, cx, "模板结构", |ws, cx| {
        ws.is_filled(FillPlace::Left)
            && ws.v3_sidebar.as_ref().is_some_and(|sb| {
                sb.read(cx).is_in_structure() && sb.read(cx).template_structure().is_some()
            })
    });
    view.read_with(cx, |ws, cx| {
        ws.v3_sidebar
            .as_ref()
            .unwrap()
            .read(cx)
            .template_structure()
            .unwrap()
    })
}

fn bounds(cx: &mut VisualTestContext, selector: String) -> Option<gpui::Bounds<gpui::Pixels>> {
    cx.debug_bounds(Box::leak(selector.into_boxed_str()))
}

/// The nearest row above `id` in the tree, among `rows`.
fn row_parent(v: &BookV3, rows: &HashMap<String, usize>, id: &str) -> Option<String> {
    let mut parent = v.entry(id)?.parent.clone();
    while let Some(p) = parent {
        if rows.contains_key(&p) {
            return Some(p);
        }
        parent = v.entry(&p)?.parent.clone();
    }
    None
}

#[gpui::test]
fn the_level_table_is_the_tree_and_a_row_dropped_on_a_level_moves_under_it_with_one_undo(
    cx: &mut TestAppContext,
) {
    let (_dir, lib, id) = seed();
    let (view, cx) = open(cx, &lib, &id, Rc::default());
    let structure = enter_structure(&view, cx);
    cx.update(|_, cx| structure.update(cx, |s, cx| s.show_levels(true, cx)));
    pump(cx);
    assert_eq!(structure.read_with(cx, |s, _| s.state())["face"], "levels");

    // Every entry that is a level or takes entries from elsewhere is a row,
    // in the tree's order: each row comes after the row it lives under,
    // one deeper.
    let (rows, parents) = view.read_with(cx, |ws, _| {
        let v = ws.book.v3().unwrap();
        let rows = level_rows(v);
        let index: HashMap<String, usize> = rows
            .iter()
            .enumerate()
            .map(|(i, (id, _))| (id.clone(), i))
            .collect();
        for entry in &v.entries {
            let level = v.levels.get(&entry.id);
            let is_row = level.is_some_and(|l| entry.level || l.settings.accept);
            assert_eq!(index.contains_key(&entry.id), is_row, "{}", entry.title);
        }
        let parents: Vec<Option<String>> = rows
            .iter()
            .map(|(id, _)| row_parent(v, &index, id))
            .collect();
        for (i, (id, depth)) in rows.iter().enumerate() {
            match &parents[i] {
                Some(parent) => {
                    assert!(index[parent] < i, "{id} after the level it lives under");
                    assert_eq!(*depth, rows[index[parent]].1 + 1);
                }
                None => assert_eq!(*depth, 0),
            }
        }
        (rows, parents)
    });
    assert!(rows.iter().any(|(_, depth)| *depth >= 1), "a nested level");

    // Drawn that way: top to bottom in that order, each mark indented 20
    // per level under the outermost (two at most).
    let mut above = None;
    for (id, depth) in &rows {
        let name = bounds(cx, format!("v5-structure-level-name-{id}")).expect("the row");
        let mark = bounds(cx, format!("v5-structure-level-mark-{id}")).expect("its mark");
        assert_eq!(
            mark.origin.x - name.origin.x,
            px(20.0 * (*depth).min(2) as f32),
            "indent of {id}"
        );
        if let Some(y) = above {
            assert!(name.origin.y > y, "{id} below the row before it");
        }
        above = Some(name.origin.y);
    }

    // Drop the second outermost row on the first (a level): it moves under
    // it, one `entry.move`, and one undo takes it back.
    let outermost: Vec<&String> = rows
        .iter()
        .zip(&parents)
        .filter(|((_, depth), _)| *depth == 0)
        .map(|((id, _), _)| id)
        .collect();
    let (target, moving) = view.read_with(cx, |ws, _| {
        let v = ws.book.v3().unwrap();
        let target = outermost
            .iter()
            .find(|id| v.entry(id).unwrap().level)
            .expect("an outermost level")
            .to_string();
        let moving = outermost
            .iter()
            .find(|id| ***id != target)
            .expect("another outermost row")
            .to_string();
        (target, moving)
    });
    let before = view.read_with(cx, |ws, _| {
        ws.book.v3().unwrap().entry(&moving).unwrap().parent.clone()
    });
    assert_eq!(before, None);
    let from = bounds(cx, format!("v5-structure-level-{moving}"))
        .unwrap()
        .center();
    let to = bounds(cx, format!("v5-structure-level-{target}"))
        .unwrap()
        .center();
    cx.simulate_mouse_down(from, MouseButton::Left, Modifiers::none());
    cx.simulate_mouse_move(
        from + point(px(0.), px(8.)),
        MouseButton::Left,
        Modifiers::none(),
    );
    pump(cx);
    cx.simulate_mouse_move(to, MouseButton::Left, Modifiers::none());
    pump(cx);
    cx.simulate_mouse_up(to, MouseButton::Left, Modifiers::none());
    wait(&view, cx, "the move under the level", |ws, _| {
        ws.book
            .v3()
            .unwrap()
            .entry(&moving)
            .unwrap()
            .parent
            .as_deref()
            == Some(target.as_str())
    });
    let moved = view.read_with(cx, |ws, _| level_rows(ws.book.v3().unwrap()));
    let at = moved.iter().position(|(id, _)| *id == moving).unwrap();
    let under = moved.iter().position(|(id, _)| *id == target).unwrap();
    assert!(at > under);
    assert_eq!(moved[at].1, moved[under].1 + 1, "drawn one deeper");

    cx.dispatch_action(Undo);
    wait(&view, cx, "one undo", |ws, _| {
        ws.book
            .v3()
            .unwrap()
            .entry(&moving)
            .unwrap()
            .parent
            .is_none()
    });
}

#[gpui::test]
fn the_panel_names_its_groups_lives_in_and_hangs_on_and_esc_closes_only_it(
    cx: &mut TestAppContext,
) {
    let (_dir, lib, id) = seed();
    let leaves = Rc::new(Cell::new(0));
    let (view, cx) = open(cx, &lib, &id, leaves.clone());
    let structure = enter_structure(&view, cx);
    // A template whose entries hang somewhere (章 on the storylines).
    let hung = view.read_with(cx, |ws, _| {
        Graph::read(ws.book.v3().unwrap())
            .edges
            .into_iter()
            .find(|edge| edge.kind == EdgeKind::Membership)
            .expect("a line of 挂")
            .to
    });
    cx.update(|window, cx| structure.update(cx, |s, cx| s.select_template(&hung, window, cx)));
    pump(cx);
    assert_eq!(
        structure.read_with(cx, |s, _| s.state())["edit"],
        format!("template:{hung}")
    );
    assert!(cx.debug_bounds("v5-structure-panel-lives-in").is_some());
    assert!(cx.debug_bounds("v5-structure-panel-hangs-on").is_some());
    cx.update(|_, cx| {
        use dr_i18n::keys::v5_fill;
        // The card's groups (§9), not the legend's 「住在下面」「挂在上面」.
        assert_eq!(t(cx, v5_fill::LIVES_IN).as_ref(), "住在");
        assert_eq!(t(cx, v5_fill::HANGS_ON).as_ref(), "挂在");
        assert_eq!(t(cx, v5_fill::RESIDES).as_ref(), "住在下面");
        assert_eq!(t(cx, v5_fill::ATTACHED).as_ref(), "挂在上面");
    });

    // The first Esc closes the panel only; what it held is handed back to
    // be stored (its `leave`), the fill stays.
    cx.simulate_keystrokes("escape");
    pump(cx);
    assert!(structure.read_with(cx, |s, _| s.state())["edit"].is_null());
    assert_eq!(leaves.get(), 1);
    assert!(view.read_with(cx, |ws, _| ws.is_filled(FillPlace::Left)));
    assert!(cx.debug_bounds("v5-structure-panel-lives-in").is_none());

    // The next leaves the fill.
    cx.simulate_keystrokes("escape");
    pump(cx);
    assert!(!view.read_with(cx, |ws, _| ws.is_filled(FillPlace::Left)));
    assert_eq!(leaves.get(), 1);
}

#[gpui::test]
fn a_click_on_the_legend_hides_and_shows_its_kind_of_line(cx: &mut TestAppContext) {
    let (_dir, lib, id) = seed();
    let (view, cx) = open(cx, &lib, &id, Rc::default());
    let structure = enter_structure(&view, cx);
    for (kind, slug) in [
        (EdgeKind::Membership, "membership"),
        (EdgeKind::Residence, "residence"),
    ] {
        let row = bounds(cx, format!("v5-structure-legend-{slug}")).expect("the legend row");
        cx.simulate_click(row.center(), Modifiers::default());
        pump(cx);
        assert!(structure.read_with(cx, |s, _| s.is_hidden(kind)));
        assert_eq!(
            structure.read_with(cx, |s, _| s.state())["hidden"],
            serde_json::json!([slug])
        );
        // Hiding lines opens no panel.
        assert!(structure.read_with(cx, |s, _| s.state())["edit"].is_null());
        cx.simulate_click(row.center(), Modifiers::default());
        pump(cx);
        assert!(!structure.read_with(cx, |s, _| s.is_hidden(kind)));
        assert_eq!(
            structure.read_with(cx, |s, _| s.state())["hidden"],
            serde_json::json!([])
        );
    }
}
