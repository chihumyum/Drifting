//! The plot planner on GPUI's test platform, over a real library (F3 over
//! dr-store) seeded with dr-testkit's 《阿Q正传》: its fourth chapter has a
//! 4 × 4 grid, the others none.
//!
//! - The grid is read: lanes, columns, slips; typing in a slip is stored
//!   400 ms after the last key, as typed.
//! - Headers: insert before and after, move back and forward, rename,
//!   delete with the slips (the last column stays); each reaches F3 in
//!   order.
//! - A chapter without a grid shows the empty 3 × 3 one; the first edits
//!   (typed before it is stored, and a new column) store it with the slip
//!   in the right place.
//! - The grip sizes the cells within the bounds and fixes their shape; 清空
//!   empties labels and slips, rows and columns stay.
//! - A shape set by hand is kept per grid on this device (`local_state`,
//!   tied to the book) and known when the grid opens again.
//! - Another writer's change shows (F3's events); a slip with typing not
//!   yet stored keeps it.
//! - 清空 asks first, as the workspace window's dialog; Esc closes the
//!   question and nothing is emptied.

use std::time::{Duration, Instant};

use dr_shell::{Services, SettingsFile, ShellInfo};
use dr_ui::sand;
use dr_view_plot::{
    CellSize, Field, PlannerHost, PlotPlanner, RATIO_SCOPE, STORE_AFTER, ratio_key,
};
use dr_workspace::commands::plot_grid::{
    Axis, CellIn, GridIn, PlotGridCell, PlotGridGet, PlotGridInfo,
};
use dr_workspace::{Actor, Workspace as Library};
use gpui::{Entity, Focusable as _, TestAppContext, VisualTestContext, point, px};

const VERSION: &str = "0.2.0-dev";

struct Setup {
    _dir: tempfile::TempDir,
    lib: Library,
    book: String,
    /// The chapters in reading order.
    chapters: Vec<String>,
}

fn seeded() -> Setup {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let store = dr_store::Library::open(&root, dr_workspace::library_options(VERSION)).unwrap();
    let book = dr_testkit::samples::a_q().unwrap();
    dr_testkit::seed::write_book(&store, &book).unwrap();
    let book_id = book.book_id().to_string();
    store.close().unwrap();
    let lib = Library::open_dir(&root, VERSION).unwrap();
    let list = lib
        .call(
            &Actor::User,
            "chapter.list",
            serde_json::json!({ "book": book_id }),
        )
        .unwrap();
    let chapters = list["output"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["id"].as_str().unwrap().to_owned())
        .collect();
    Setup {
        _dir: dir,
        lib,
        book: book_id,
        chapters,
    }
}

fn open<'a>(
    cx: &'a mut TestAppContext,
    s: &Setup,
    chapter: usize,
) -> (Entity<PlotPlanner>, &'a mut VisualTestContext) {
    init(cx, s);
    let host = host(s, chapter);
    let (view, cx) = cx.add_window_view(move |window, cx| PlotPlanner::new(host, window, cx));
    wait_for(cx, |cx| view.read_with(cx, |p, _| p.is_loaded()));
    (view, cx)
}

fn host(s: &Setup, chapter: usize) -> PlannerHost {
    PlannerHost {
        library: s.lib.clone(),
        book: s.book.clone(),
        node: s.chapters[chapter].clone(),
        title: "第四章".into(),
        mark: sand::Kind::Chapter(0),
        color: None,
    }
}

/// The shell over the seeded library (strings, settings, dialogs).
fn init(cx: &mut TestAppContext, s: &Setup) {
    cx.executor().allow_parking();
    let lib = s.lib.clone();
    cx.update(|cx| {
        let mut file = SettingsFile::in_memory();
        file.set(
            dr_shell::settings::registry::UI_LOCALE,
            "zh-CN".into(),
            None,
        )
        .ok();
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: VERSION,
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                library: Some(lib),
                ..Services::default()
            },
            file,
            cx,
        );
    });
}

/// Runs the app until `done` holds, at most thirty seconds.
fn wait_for(cx: &mut VisualTestContext, done: impl Fn(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        cx.run_until_parked();
        if done(cx) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out");
        std::thread::sleep(Duration::from_millis(2));
    }
}

/// Lets the typing be stored and every write reach F3.
fn settle(view: &Entity<PlotPlanner>, cx: &mut VisualTestContext) {
    cx.executor()
        .advance_clock(STORE_AFTER + Duration::from_millis(50));
    wait_for(cx, |cx| view.read_with(cx, |p, _| p.is_settled()));
}

fn stored(s: &Setup, chapter: usize) -> PlotGridInfo {
    s.lib
        .run::<PlotGridGet>(
            &Actor::User,
            GridIn {
                book: s.book.clone(),
                node: s.chapters[chapter].clone(),
            },
        )
        .unwrap()
        .output
}

fn labels(lines: &[dr_workspace::commands::plot_grid::LineInfo]) -> Vec<String> {
    lines.iter().map(|l| l.label.clone()).collect()
}

fn cell_text(info: &PlotGridInfo, row: &str, col: &str) -> String {
    info.cells
        .iter()
        .find(|c| c.row == row && c.column == col)
        .map(|c| c.text.clone())
        .unwrap_or_default()
}

/// Types `text` into `field` as the keyboard would.
fn type_into(view: &Entity<PlotPlanner>, field: Field, text: &str, cx: &mut VisualTestContext) {
    let area = view
        .read_with(cx, |p, _| p.field(&field))
        .expect("the field is made");
    cx.update(|window, cx| {
        let handle = area.read(cx).focus_handle(cx);
        window.focus(&handle, cx);
    });
    cx.run_until_parked();
    cx.simulate_input(text);
}

#[gpui::test]
fn the_sample_grid_is_read_and_a_slip_is_stored_as_typed(cx: &mut TestAppContext) {
    let s = seeded();
    let (view, cx) = open(cx, &s, 3);
    let grid = view.read_with(cx, |p, _| p.grid().clone());
    assert!(grid.exists);
    let rows: Vec<&str> = grid.rows.iter().map(|l| l.label.as_str()).collect();
    assert_eq!(rows, ["阿Q", "吴妈", "赵家", "地保"]);
    let cols: Vec<&str> = grid.cols.iter().map(|l| l.label.as_str()).collect();
    assert_eq!(cols, ["舂米之前", "一跪", "竹杠", "五条件"]);
    let (r0, c1) = (grid.rows[0].id.clone(), grid.cols[1].id.clone());
    assert_eq!(grid.cell(&r0, &c1), "对吴妈跪下：“我和你困觉！”");
    // Every label and slip has its field, showing the grid's text.
    let area = view
        .read_with(cx, |p, _| p.field(&Field::Cell(r0.clone(), c1.clone())))
        .unwrap();
    assert_eq!(
        area.read_with(cx, |a, _| a.text()),
        "对吴妈跪下：“我和你困觉！”"
    );

    // An empty slip (吴妈 × 五条件): typed, stored after the pause.
    let (r1, c3) = (grid.rows[1].id.clone(), grid.cols[3].id.clone());
    type_into(&view, Field::Cell(r1.clone(), c3.clone()), "答应了", cx);
    assert_eq!(
        view.read_with(cx, |p, _| p.grid().cell(&r1, &c3).to_owned()),
        "答应了"
    );
    assert_eq!(cell_text(&stored(&s, 3), &r1, &c3), "");
    settle(&view, cx);
    assert_eq!(cell_text(&stored(&s, 3), &r1, &c3), "答应了");
}

#[gpui::test]
fn a_narrow_slip_wraps_its_closing_marks_and_resize_keeps_the_text(cx: &mut TestAppContext) {
    let s = seeded();
    let (view, cx) = open(cx, &s, 3);
    let grid = view.read_with(cx, |p, _| p.grid().clone());
    let (row, col) = (grid.rows[0].id.clone(), grid.cols[1].id.clone());
    let text = grid.cell(&row, &col).to_owned();
    assert_eq!(text, "对吴妈跪下：“我和你困觉！”");
    let area = view
        .read_with(cx, |p, _| p.field(&Field::Cell(row.clone(), col.clone())))
        .unwrap();
    for (w, rows) in [(120.0, 2), (184.0, 1), (120.0, 2)] {
        view.update_in(cx, |p, window, cx| {
            p.set_size(CellSize { w, h: 96.0 }, true, window, cx)
        });
        settle(&view, cx);
        cx.update(|window, cx| window.draw(cx).clear(cx));
        assert_eq!(area.read_with(cx, |a, _| a.rows()), rows);
        assert_eq!(area.read_with(cx, |a, _| a.text()), text);
        assert_eq!(cell_text(&stored(&s, 3), &row, &col), text);
    }
}

/// The clipboard goes through the actual field shortcut; a module API
/// call alone would miss capture/bubble propagation and the focused field.
fn paste(text: &str, cx: &mut VisualTestContext) {
    cx.update(|_, cx| cx.write_to_clipboard(gpui::ClipboardItem::new_string(text.to_owned())));
    cx.simulate_keystrokes(if cfg!(target_os = "macos") {
        "cmd-v"
    } else {
        "ctrl-v"
    });
    cx.run_until_parked();
}

#[gpui::test]
fn spreadsheet_paste_grows_both_axes_and_replaces_the_focused_slip(cx: &mut TestAppContext) {
    let s = seeded();
    let (view, cx) = open(cx, &s, 3);
    let grid = view.read_with(cx, |p, _| p.grid().clone());
    let field = Field::Cell(grid.rows[3].id.clone(), grid.cols[3].id.clone());
    // Existing, still-unsaved typing must not overwrite the pasted block
    // when the debounce fires. Use the sample's existing labels as text.
    type_into(&view, field.clone(), &grid.rows[0].label, cx);
    let text = format!(
        "\t{}\r\n{}\t{}\t{}\r\n",
        grid.cols[1].label, grid.rows[0].label, grid.rows[1].label, grid.rows[2].label
    );
    paste(&text, cx);
    assert_eq!(
        view.read_with(cx, |p, cx| p.field(&field).unwrap().read(cx).text()),
        ""
    );
    settle(&view, cx);
    let info = stored(&s, 3);
    assert_eq!((info.rows.len(), info.columns.len()), (5, 6));
    let value = |r: usize, c: usize| cell_text(&info, &info.rows[r].id, &info.columns[c].id);
    assert_eq!(value(3, 3), "", "empty clipboard cell clears the old text");
    assert_eq!(value(3, 4), grid.cols[1].label);
    assert_eq!(value(4, 3), grid.rows[0].label);
    assert_eq!(value(4, 4), grid.rows[1].label);
    assert_eq!(value(4, 5), grid.rows[2].label);
    assert_eq!(value(0, 1), grid.cell(&grid.rows[0].id, &grid.cols[1].id));
    assert!(info.rows[4].label.is_empty());
    assert!(info.columns[4..].iter().all(|c| c.label.is_empty()));
}

#[gpui::test]
fn spreadsheet_paste_is_the_first_edit_and_plain_paste_still_inserts(cx: &mut TestAppContext) {
    let s = seeded();
    let (view, cx) = open(cx, &s, 0);
    let grid = view.read_with(cx, |p, _| p.grid().clone());
    assert!(!grid.exists);
    let field = Field::Cell(grid.rows[2].id.clone(), grid.cols[2].id.clone());
    // Focus without typing so the paste itself creates the grid.
    let area = view.read_with(cx, |p, _| p.field(&field).unwrap());
    cx.update(|window, cx| window.focus(&area.focus_handle(cx), cx));
    cx.run_until_parked();
    paste("阿Q\t吴妈\n赵家\t地保\n", cx);
    settle(&view, cx);
    let info = stored(&s, 0);
    assert_eq!((info.rows.len(), info.columns.len()), (4, 4));
    assert_eq!(
        cell_text(&info, &info.rows[2].id, &info.columns[2].id),
        "阿Q"
    );
    assert_eq!(
        cell_text(&info, &info.rows[3].id, &info.columns[3].id),
        "地保"
    );
    assert_eq!(area.read_with(cx, |a, _| a.text()), "阿Q");

    // The field's subscription began with temporary ids; both an ordinary
    // paste and the next block paste still address its adopted stored ids.
    cx.simulate_keystrokes(if cfg!(target_os = "macos") {
        "cmd-right"
    } else {
        "ctrl-end"
    });
    paste("吴妈", cx);
    settle(&view, cx);
    assert_eq!(area.read_with(cx, |a, _| a.text()), "阿Q吴妈");
    assert_eq!(
        cell_text(&stored(&s, 0), &info.rows[2].id, &info.columns[2].id),
        "阿Q吴妈"
    );
    cx.simulate_keystrokes(if cfg!(target_os = "macos") {
        "cmd-a"
    } else {
        "ctrl-a"
    });
    paste("地保", cx);
    settle(&view, cx);
    assert_eq!(area.read_with(cx, |a, _| a.text()), "地保");
    paste("赵家\n\n", cx);
    settle(&view, cx);
    let info = stored(&s, 0);
    assert_eq!((info.rows.len(), info.columns.len()), (4, 4));
    assert_eq!(
        cell_text(&info, &info.rows[2].id, &info.columns[2].id),
        "赵家"
    );
    assert_eq!(
        cell_text(&info, &info.rows[3].id, &info.columns[2].id),
        "",
        "only one trailing newline is ignored"
    );
    assert_eq!(
        cell_text(&info, &info.rows[2].id, &info.columns[3].id),
        "吴妈",
        "short clipboard rows leave other cells alone"
    );
}

#[gpui::test]
fn headers_insert_move_rename_and_delete(cx: &mut TestAppContext) {
    let s = seeded();
    let (view, cx) = open(cx, &s, 3);
    let grid = view.read_with(cx, |p, _| p.grid().clone());
    let wu = grid.rows[1].id.clone();
    let di = grid.rows[3].id.clone();

    // 在上方插入一行 beside 吴妈; 下移 the last row does nothing.
    cx.update(|window, cx| {
        view.update(cx, |p, cx| p.insert_line(Axis::Row, &wu, true, window, cx))
    });
    cx.update(|window, cx| view.update(cx, |p, cx| p.move_line(Axis::Row, &di, 1, window, cx)));
    // 上移 地保 once: before 赵家.
    cx.update(|window, cx| view.update(cx, |p, cx| p.move_line(Axis::Row, &di, -1, window, cx)));
    settle(&view, cx);
    let info = stored(&s, 3);
    assert_eq!(labels(&info.rows), ["阿Q", "", "吴妈", "地保", "赵家"]);
    let new_row = info.rows[1].id.clone();

    // 重命名: the label takes the caret, its text selected; typing replaces
    // it, Enter leaves it.
    cx.update(|window, cx| view.update(cx, |p, cx| p.rename_line(Axis::Row, &new_row, window, cx)));
    cx.simulate_input("村里人");
    cx.simulate_keystrokes("enter");
    settle(&view, cx);
    assert_eq!(
        labels(&stored(&s, 3).rows),
        ["阿Q", "村里人", "吴妈", "地保", "赵家"]
    );

    // 在右侧插入一列 beside the first, then delete 一跪 with its two slips.
    let first = grid.cols[0].id.clone();
    let kneel = grid.cols[1].id.clone();
    assert_eq!(
        view.read_with(cx, |p, _| p.grid().filled(Axis::Column, &kneel)),
        2
    );
    cx.update(|window, cx| {
        view.update(cx, |p, cx| {
            p.insert_line(Axis::Column, &first, false, window, cx)
        })
    });
    cx.update(|window, cx| {
        view.update(cx, |p, cx| p.remove_line(Axis::Column, &kneel, window, cx))
    });
    settle(&view, cx);
    let info = stored(&s, 3);
    assert_eq!(labels(&info.columns), ["舂米之前", "", "竹杠", "五条件"]);
    assert!(info.cells.iter().all(|c| c.column != kneel));

    // The last column stays.
    let cols: Vec<String> = info.columns.iter().map(|c| c.id.clone()).collect();
    for id in &cols {
        cx.update(|window, cx| {
            view.update(cx, |p, cx| p.remove_line(Axis::Column, id, window, cx))
        });
    }
    settle(&view, cx);
    let info = stored(&s, 3);
    assert_eq!(info.columns.len(), 1);
    assert_eq!(info.columns[0].id, *cols.last().unwrap());
    assert_eq!(view.read_with(cx, |p, _| p.grid().cols.len()), 1);
}

#[gpui::test]
fn a_chapter_without_a_grid_stores_it_with_the_first_edit(cx: &mut TestAppContext) {
    let s = seeded();
    let (view, cx) = open(cx, &s, 0);
    let grid = view.read_with(cx, |p, _| p.grid().clone());
    assert!(!grid.exists);
    assert_eq!((grid.rows.len(), grid.cols.len()), (3, 3));
    assert!(!stored(&s, 0).exists);

    // A slip typed into, then a column added, before anything is stored.
    type_into(&view, Field::Cell("~r1".into(), "~c2".into()), "未庄", cx);
    cx.update(|window, cx| view.update(cx, |p, cx| p.add_line(Axis::Column, window, cx)));
    settle(&view, cx);
    let info = stored(&s, 0);
    assert!(info.exists);
    assert_eq!((info.rows.len(), info.columns.len()), (3, 4));
    assert_eq!(
        cell_text(&info, &info.rows[1].id, &info.columns[2].id),
        "未庄"
    );
    // The planner's lines are the stored ids now.
    let grid = view.read_with(cx, |p, _| p.grid().clone());
    assert!(grid.exists);
    assert!(
        grid.rows
            .iter()
            .chain(&grid.cols)
            .all(|l| !l.id.starts_with('~'))
    );
    assert_eq!(grid.cols[3].id, info.columns[3].id);
    // Typing goes on in the same slip (the field made before still reports).
    cx.simulate_input("的");
    settle(&view, cx);
    assert_eq!(
        cell_text(&stored(&s, 0), &info.rows[1].id, &info.columns[2].id),
        "未庄的"
    );
}

#[gpui::test]
fn the_grip_sizes_the_cells_and_clear_empties_them(cx: &mut TestAppContext) {
    let s = seeded();
    let (view, cx) = open(cx, &s, 3);
    let start = view.read_with(cx, |p, _| p.grid().size);
    assert_eq!(start, CellSize { w: 184.0, h: 96.0 });

    // Four rows and four columns: the corner travels four times as far.
    view.update(cx, |p, cx| p.start_drag(point(px(500.0), px(300.0)), cx));
    view.update(cx, |p, cx| p.drag_to(point(px(580.0), px(340.0)), cx));
    assert_eq!(
        view.read_with(cx, |p, _| p.live_size()),
        Some(CellSize { w: 204.0, h: 106.0 })
    );
    // Far past the bounds: held at the most.
    view.update(cx, |p, cx| p.drag_to(point(px(5000.0), px(5000.0)), cx));
    cx.update(|window, cx| view.update(cx, |p, cx| p.end_drag(window, cx)));
    settle(&view, cx);
    let info = stored(&s, 3);
    assert_eq!((info.cell_w, info.cell_h), (440.0, 380.0));
    assert_eq!(view.read_with(cx, |p, _| p.live_size()), None);

    // 清空: labels and slips go, rows, columns and size stay.
    cx.update(|window, cx| view.update(cx, |p, cx| p.clear(window, cx)));
    settle(&view, cx);
    let info = stored(&s, 3);
    assert_eq!((info.rows.len(), info.columns.len()), (4, 4));
    assert!(
        info.rows
            .iter()
            .chain(&info.columns)
            .all(|l| l.label.is_empty())
    );
    assert!(info.cells.is_empty());
    assert_eq!((info.cell_w, info.cell_h), (440.0, 380.0));
}

#[gpui::test]
fn a_hand_set_shape_is_kept_on_this_device(cx: &mut TestAppContext) {
    let s = seeded();
    let (view, cx) = open(cx, &s, 3);
    wait_for(cx, |cx| view.read_with(cx, |p, _| p.is_ratio_settled()));
    assert_eq!(view.read_with(cx, |p, _| p.ratio()), None);
    let key = ratio_key(&s.chapters[3]);
    let kept = || s.lib.library().local_get(RATIO_SCOPE, &key).unwrap();
    assert_eq!(kept(), None);

    // Sized by hand: three times as wide as high, kept for this grid and
    // tied to its book.
    cx.update(|window, cx| {
        view.update(cx, |p, cx| {
            p.set_size(CellSize { w: 300.0, h: 100.0 }, true, window, cx)
        })
    });
    settle(&view, cx);
    wait_for(cx, |_| kept().is_some());
    assert_eq!(kept().unwrap().parse::<f32>().unwrap(), 3.0);
    let rows = s
        .lib
        .library()
        .local_entries(RATIO_SCOPE, Some(&s.book))
        .unwrap();
    assert_eq!(rows.len(), 1);
    // A fit is not by hand: the shape stays.
    cx.update(|window, cx| {
        view.update(cx, |p, cx| {
            p.set_size(CellSize { w: 200.0, h: 200.0 }, false, window, cx)
        })
    });
    settle(&view, cx);
    assert_eq!(kept().unwrap().parse::<f32>().unwrap(), 3.0);

    // The grid opened again (another chapter came and went) knows it.
    let same = host(&s, 3);
    let again = cx.update(|window, cx| dr_view_plot::planner(same, window, cx));
    wait_for(cx, |cx| {
        again.read_with(cx, |p, _| p.is_loaded() && p.is_ratio_settled())
    });
    assert_eq!(again.read_with(cx, |p, _| p.ratio()), Some(3.0));
    // Another grid has its own.
    let other = host(&s, 2);
    let other = cx.update(|window, cx| dr_view_plot::planner(other, window, cx));
    wait_for(cx, |cx| other.read_with(cx, |p, _| p.is_ratio_settled()));
    assert_eq!(other.read_with(cx, |p, _| p.ratio()), None);
}

#[gpui::test]
fn another_writers_change_shows_and_typing_is_kept(cx: &mut TestAppContext) {
    let s = seeded();
    let (view, cx) = open(cx, &s, 3);
    let grid = view.read_with(cx, |p, _| p.grid().clone());
    let (r3, c0) = (grid.rows[3].id.clone(), grid.cols[0].id.clone());
    let (r2, c1) = (grid.rows[2].id.clone(), grid.cols[1].id.clone());

    // The author is typing in one slip (not stored yet) …
    type_into(&view, Field::Cell(r2.clone(), c1.clone()), "赵太爷", cx);
    // … while an Agent writes another.
    s.lib
        .run::<PlotGridCell>(
            &Actor::Agent {
                session: "test".into(),
                turn: 1,
                call: "plot_grid.cell".into(),
            },
            CellIn {
                book: s.book.clone(),
                node: s.chapters[3].clone(),
                row: r3.clone(),
                column: c0.clone(),
                text: "地保来了".into(),
            },
        )
        .unwrap();
    settle(&view, cx);
    let grid = view.read_with(cx, |p, _| p.grid().clone());
    assert_eq!(grid.cell(&r3, &c0), "地保来了");
    assert_eq!(grid.cell(&r2, &c1), "赵太爷");
    let info = stored(&s, 3);
    assert_eq!(cell_text(&info, &r2, &c1), "赵太爷");
    assert_eq!(cell_text(&info, &r3, &c0), "地保来了");
    let area = view
        .read_with(cx, |p, _| p.field(&Field::Cell(r3.clone(), c0.clone())))
        .unwrap();
    assert_eq!(area.read_with(cx, |a, _| a.text()), "地保来了");
}

#[gpui::test]
fn clear_asks_first_in_the_workspace_window(cx: &mut TestAppContext) {
    let s = seeded();
    init(cx, &s);
    let (ws, cx) = cx.add_window_view(dr_shell::Workspace::new);
    let host = host(&s, 3);
    let view = cx.update(|window, cx| dr_view_plot::planner(host, window, cx));
    wait_for(cx, |cx| view.read_with(cx, |p, _| p.is_loaded()));

    cx.update(|window, cx| view.update(cx, |p, cx| p.ask_clear(window, cx)));
    cx.run_until_parked();
    let dialog = ws
        .read_with(cx, |w, _| w.dialog.clone())
        .expect("the question shows");
    assert!(dialog.downcast::<dr_view_plot::ClearDialog>().is_ok());
    // Esc: the question goes, nothing is emptied.
    cx.dispatch_action(dr_shell::actions::Dismiss);
    cx.run_until_parked();
    assert!(ws.read_with(cx, |w, _| w.dialog.is_none()));
    assert_eq!(stored(&s, 3).cells.len(), 11);
}

/// In the shell's Bottom Panel ([`dr_view_plot::init`]): opened with a
/// chapter in front it is that chapter's planner; the chapter renamed, its
/// header follows.
#[gpui::test]
fn the_shell_shows_the_planner_of_the_chapter_in_front(cx: &mut TestAppContext) {
    use dr_shell::nav::{Open, Target};
    use dr_shell::pages::BottomPane;
    let s = seeded();
    init(cx, &s);
    cx.update(dr_view_plot::init);
    let (ws, cx) = cx.add_window_view(dr_shell::Workspace::new);
    wait_for(cx, |cx| ws.read_with(cx, |ws, _| !ws.book.is_empty()));
    let fourth = Target::Chapter(s.chapters[3].parse().unwrap());
    ws.update(cx, |ws, cx| {
        ws.open(fourth.clone(), Open::KEEP, cx);
        ws.toggle_planner(cx);
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let planner = ws
        .read_with(cx, |ws, _| ws.bottom_view(BottomPane::Planner))
        .expect("the planner is made")
        .downcast::<PlotPlanner>()
        .unwrap();
    assert_eq!(
        planner.read_with(cx, |p, _| p.host().node.clone()),
        s.chapters[3]
    );
    s.lib
        .call(
            &Actor::User,
            "chapter.update",
            serde_json::json!({"book": s.book, "id": s.chapters[3], "title": "改了名"}),
        )
        .unwrap();
    wait_for(cx, |cx| {
        cx.update(|window, cx| window.draw(cx).clear(cx));
        planner.read_with(cx, |p, _| p.host().title == "改了名")
    });
}
