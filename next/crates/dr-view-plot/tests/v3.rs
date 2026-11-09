//! G1's existing plot UI storage adapter, using the shared v3 synthetic corpus.
use dr_view_plot::{Write, v3};
use dr_workspace::{Actor, commands::plot_grid::Axis};
use serde_json::json;
fn seeded() -> (tempfile::TempDir, dr_workspace::Workspace, String, String) {
    let dir = tempfile::tempdir().unwrap();
    let store = dr_store::Library::open(dir.path(), dr_workspace::library_options("test")).unwrap();
    let seed = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let book = seed.books[0].book_id().to_string();
    seed.write_to(&store).unwrap();
    store.close().unwrap();
    let ws = dr_workspace::Workspace::open_dir(dir.path(), "test").unwrap();
    let entries = ws
        .call(&Actor::User, "entry.list", json!({"book":book,"all":true}))
        .unwrap()["output"]
        .clone();
    let entry = entries
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["template"] == "tpl-chapter")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    (dir, ws, book, entry)
}

#[test]
fn changes_keep_other_cells_and_the_other_module_independent() {
    let (_dir, ws, book, entry) = seeded();
    let entry = entry.as_str();
    ws.call(&Actor::User,"entry_template.put_module",json!({"book":book,"template":"tpl-chapter","module":{"id":"other-plot","name":"Other","kind":"plot_grid"}})).unwrap();
    let first = v3::read(&ws, &book, entry, "mod-plot-grid").unwrap();
    let other = v3::read(&ws, &book, entry, "other-plot").unwrap();
    let (r, c) = (first.rows[0].id.clone(), first.columns[0].id.clone());
    v3::write(
        &ws,
        &book,
        entry,
        "mod-plot-grid",
        vec![
            Write::Cell {
                row: r.clone(),
                col: c.clone(),
                text: "G1".into(),
            },
            Write::Label {
                axis: Axis::Row,
                id: r.clone(),
                label: "G1 row".into(),
            },
        ],
    )
    .unwrap();
    let after = v3::read(&ws, &book, entry, "mod-plot-grid").unwrap();
    assert_eq!(after.rows[0].label, "G1 row");
    assert!(
        after
            .cells
            .iter()
            .any(|x| x.row == r && x.column == c && x.text == "G1")
    );
    for cell in first.cells.iter().filter(|x| x.row != r || x.column != c) {
        assert!(
            after
                .cells
                .iter()
                .any(|x| x.row == cell.row && x.column == cell.column && x.text == cell.text)
        );
    }
    assert_eq!(
        v3::read(&ws, &book, entry, "other-plot").unwrap().cells,
        other.cells
    );
    // A queued write whose cell disappeared fails without changing a remaining cell.
    let snapshot = v3::read(&ws, &book, entry, "mod-plot-grid").unwrap();
    assert!(
        v3::write(
            &ws,
            &book,
            entry,
            "mod-plot-grid",
            vec![Write::Cell {
                row: "gone".into(),
                col: c,
                text: "lost".into()
            }]
        )
        .is_err()
    );
    assert_eq!(
        v3::read(&ws, &book, entry, "mod-plot-grid").unwrap().cells,
        snapshot.cells
    );
}

#[test]
fn concurrent_windows_never_lose_a_successful_cell_write() {
    use std::sync::Barrier;
    let (_dir, ws, book, entry) = seeded();
    let initial = v3::read(&ws, &book, &entry, "mod-plot-grid").unwrap();
    let row = &initial.rows[0].id;
    let columns = [&initial.columns[0].id, &initial.columns[1].id];
    // Each window has its own workspace clone and starts from the same instant.
    // A rejected batch is explicitly retried, never silently considered saved.
    for round in 0..64 {
        let barrier = Barrier::new(2);
        let writes: [Vec<Write>; 2] = std::array::from_fn(|n| {
            vec![Write::Cell {
                row: row.clone(),
                col: columns[n].clone(),
                text: format!("G1 {round}/{n}"),
            }]
        });
        let results = std::thread::scope(|s| {
            let a = s.spawn(|| {
                barrier.wait();
                v3::write(
                    &ws.clone(),
                    &book,
                    &entry,
                    "mod-plot-grid",
                    writes[0].clone(),
                )
            });
            let b = s.spawn(|| {
                barrier.wait();
                v3::write(
                    &ws.clone(),
                    &book,
                    &entry,
                    "mod-plot-grid",
                    writes[1].clone(),
                )
            });
            [a.join().unwrap(), b.join().unwrap()]
        });
        let current = v3::read(&ws, &book, &entry, "mod-plot-grid").unwrap();
        for (n, result) in results.into_iter().enumerate() {
            match result {
                Ok(()) => assert!(current.cells.iter().any(|c| c.row == *row
                    && c.column == *columns[n]
                    && c.text == format!("G1 {round}/{n}"))),
                Err(dr_workspace::WsError::Conflict(_)) => {
                    v3::write(&ws, &book, &entry, "mod-plot-grid", writes[n].clone()).unwrap();
                }
                Err(e) => panic!("unexpected grid error: {e}"),
            }
        }
        let current = v3::read(&ws, &book, &entry, "mod-plot-grid").unwrap();
        for (n, column) in columns.iter().enumerate() {
            assert!(current.cells.iter().any(|c| c.row == *row
                && c.column == **column
                && c.text == format!("G1 {round}/{n}")));
        }
    }
}

#[gpui::test]
fn a_refused_batch_keeps_the_edit_visible_until_explicit_retry(cx: &mut gpui::TestAppContext) {
    use dr_view_plot::{Field, PlannerHost, PlotPlanner};
    use gpui::Focusable as _;
    let (_dir, ws, book, entry) = seeded();
    cx.executor().allow_parking();
    cx.update(|cx| {
        dr_shell::init(
            dr_shell::ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "0.2.0-dev",
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            dr_shell::Services {
                library: Some(ws.clone()),
                ..Default::default()
            },
            dr_shell::SettingsFile::in_memory(),
            cx,
        )
    });
    let host = PlannerHost {
        library: ws.clone(),
        book: book.clone(),
        node: entry.clone(),
        title: "G1".into(),
        mark: dr_ui::sand::Kind::Chapter(0),
        color: None,
    };
    let (view, cx) = cx
        .add_window_view(move |w, cx| PlotPlanner::for_module(host, "mod-plot-grid".into(), w, cx));
    fn wait(cx: &mut gpui::VisualTestContext, done: impl Fn(&mut gpui::VisualTestContext) -> bool) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            cx.run_until_parked();
            if done(cx) {
                break;
            }
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
    }
    wait(cx, |cx| view.read_with(cx, |p, _| p.is_loaded()));
    let grid = v3::read(&ws, &book, &entry, "mod-plot-grid").unwrap();
    let (row, col) = (grid.rows[0].id.clone(), grid.columns[0].id.clone());
    let field = Field::Cell(row.clone(), col.clone());
    let area = view.read_with(cx, |p, _| p.field(&field).unwrap());
    cx.update(|w, cx| {
        area.focus_handle(cx).focus(w, cx);
        area.update(cx, |a, cx| a.select_all_text(cx));
    });
    cx.simulate_input("Retained G1");
    // An outside writer removes the row while this window still has typing.
    v3::write(
        &ws,
        &book,
        &entry,
        "mod-plot-grid",
        vec![Write::Remove {
            axis: Axis::Row,
            id: row.clone(),
        }],
    )
    .unwrap();
    view.update(cx, |p, cx| p.store_typed(cx));
    wait(cx, |cx| view.read_with(cx, |p, _| p.save_failed()));
    assert_eq!(area.read_with(cx, |a, _| a.text()), "Retained G1");
    assert!(!view.read_with(cx, |p, _| p.is_settled()));
    // A refresh cannot clear the local draft or claim it has been saved.
    view.update_in(cx, |p, w, cx| p.reload(w, cx));
    cx.run_until_parked();
    assert_eq!(area.read_with(cx, |a, _| a.text()), "Retained G1");
    cx.simulate_input(" revised");
    view.update(cx, |p, cx| p.store_typed(cx));
    assert!(view.read_with(cx, |p, _| p.save_failed()));
    assert_eq!(area.read_with(cx, |a, _| a.text()), "Retained G1 revised");
    v3::write(
        &ws,
        &book,
        &entry,
        "mod-plot-grid",
        vec![Write::Add {
            axis: Axis::Row,
            id: row.clone(),
            after: None,
        }],
    )
    .unwrap();
    view.update(cx, |p, cx| p.retry_save(cx));
    wait(cx, |cx| view.read_with(cx, |p, _| p.is_settled()));
    assert!(!view.read_with(cx, |p, _| p.save_failed()));
    assert!(
        v3::read(&ws, &book, &entry, "mod-plot-grid")
            .unwrap()
            .cells
            .iter()
            .any(|c| c.row == row && c.column == col && c.text == "Retained G1 revised")
    );
}
