//! G1's existing plot UI storage adapter, using the shared v3 synthetic corpus.
use dr_view_plot::{Write, v3};
use dr_workspace::{Actor, commands::plot_grid::Axis};
use serde_json::json;
#[test]
fn changes_keep_other_cells_and_the_other_module_independent() {
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
        .unwrap();
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
