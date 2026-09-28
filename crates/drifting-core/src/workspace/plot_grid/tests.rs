use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};

const CLIENT: &str = "synthetic-plot-grid";
const SEED: &str =
    "AQPC7RoABwEHZGVmYXVsdAMJcGFyYWdyYXBoBwDC7RoABigAwu0aAAJpZAF3FXRyYXNoLXN5bnRoZXRpYy1ibG9jawA=";
const CACHE: &str =
    r#"{"type":"doc","content":[{"type":"paragraph","attrs":{"id":"trash-synthetic-block"}}]}"#;

fn context() -> AuthoredProseContext {
    AuthoredProseContext {
        project_id: "plot-project".into(),
        project_sync_id: "plot-project-sync".into(),
        sync_generation_id: "plot-generation".into(),
        installation_id: "plot-installation".into(),
        new_writer_id: "plot-writer".into(),
        new_writer_epoch: "plot-epoch".into(),
        now_iso: "2026-09-01T00:00:00.000Z".into(),
        now_ms: 200,
    }
}

fn changes(g: &DatabaseGateway) -> String {
    match &g
        .query(
            "SELECT COUNT(*) FROM sync_change_set".into(),
            vec![],
            None,
            CLIENT.into(),
        )
        .unwrap()
        .rows[0][0]
    {
        V::Integer(value) => value.clone(),
        other => panic!("{other:?}"),
    }
}

fn row(id: &str, label: &str, after: Option<&str>) -> PlotGridOp {
    PlotGridOp::AddRow {
        id: id.into(),
        label: label.into(),
        after: after.map(String::from),
    }
}

#[test]
fn plot_grid_batches_orders_projects_and_refuses_atomically() {
    let dir = tempfile::tempdir().unwrap();
    let g = DatabaseGateway::new(dir.path().into()).unwrap();
    g.open("plot.db".into(), CLIENT.into(), false).unwrap();
    let store = WorkspaceStore::new(&g, CLIENT);
    let c = context();
    store
        .create_project(
            &c,
            CreateProject {
                user_id: "local-user".into(),
                name: "书".into(),
                default_kv_ids: std::array::from_fn(|i| format!("plot-fact-{i}")),
            },
        )
        .unwrap();
    store
        .create_chapter(
            &c,
            CreateChapter {
                id: "chapter".into(),
                title: "第一章".into(),
                book_order: Some(1.0),
                seed: ChapterSeed {
                    update: STANDARD.decode(SEED).unwrap(),
                    content_json: CACHE.into(),
                },
            },
        )
        .unwrap();
    assert_eq!(store.plot_grid(&c.project_id, "chapter").unwrap(), None);
    let before = changes(&g);
    let grid = store
        .apply_plot_grid(
            &c,
            "chapter",
            &[
                row("r1", "人物", None),
                row("r2", "地点", Some("r1")),
                PlotGridOp::AddColumn {
                    id: "c1".into(),
                    label: "开场".into(),
                    after: None,
                },
                PlotGridOp::SetCell {
                    row_id: "r1".into(),
                    column_id: "c1".into(),
                    value: "林岚".into(),
                },
            ],
        )
        .unwrap();
    assert_eq!(
        changes(&g).parse::<u64>().unwrap(),
        before.parse::<u64>().unwrap() + 1
    );
    let ids = |axes: &[PlotAxis]| axes.iter().map(|a| a.id.clone()).collect::<Vec<_>>();
    assert_eq!(ids(&grid.rows), ["r1", "r2"]);
    assert_eq!(
        grid.cells,
        vec![PlotCell {
            row_id: "r1".into(),
            column_id: "c1".into(),
            value: "林岚".into()
        }]
    );
    assert_eq!((grid.cell_width, grid.cell_height), (184.0, 96.0));
    let moved = store
        .apply_plot_grid(
            &c,
            "chapter",
            &[PlotGridOp::MoveRow {
                row_id: "r2".into(),
                after: None,
            }],
        )
        .unwrap();
    assert_eq!(ids(&moved.rows), ["r2", "r1"]);
    // Operations that change nothing write nothing.
    let quiet = changes(&g);
    store
        .apply_plot_grid(
            &c,
            "chapter",
            &[
                PlotGridOp::SetCell {
                    row_id: "r1".into(),
                    column_id: "c1".into(),
                    value: "林岚".into(),
                },
                PlotGridOp::SetRowLabel {
                    row_id: "r1".into(),
                    label: "人物".into(),
                },
                PlotGridOp::MoveRow {
                    row_id: "r2".into(),
                    after: None,
                },
                PlotGridOp::SetCell {
                    row_id: "r2".into(),
                    column_id: "c1".into(),
                    value: "".into(),
                },
            ],
        )
        .unwrap();
    assert_eq!(changes(&g), quiet);
    // A refusal anywhere rolls the whole batch back.
    for ops in [
        vec![
            row("r3", "时间", None),
            PlotGridOp::SetCell {
                row_id: "missing".into(),
                column_id: "c1".into(),
                value: "x".into(),
            },
        ],
        vec![PlotGridOp::SetSize {
            width: 500.0,
            height: 96.0,
        }],
        vec![row("r1", "重复", None)],
        vec![PlotGridOp::MoveRow {
            row_id: "r1".into(),
            after: Some("r1".into()),
        }],
    ] {
        assert!(store.apply_plot_grid(&c, "chapter", &ops).is_err());
    }
    assert_eq!(changes(&g), quiet);
    assert_eq!(
        ids(&store
            .plot_grid(&c.project_id, "chapter")
            .unwrap()
            .unwrap()
            .rows),
        ["r2", "r1"]
    );
    // Removing a row purges its cells; size and projection follow.
    let removed = store
        .apply_plot_grid(
            &c,
            "chapter",
            &[
                PlotGridOp::RemoveRow {
                    row_id: "r1".into(),
                },
                PlotGridOp::SetSize {
                    width: 240.0,
                    height: 120.0,
                },
            ],
        )
        .unwrap();
    assert!(removed.cells.is_empty());
    assert_eq!((removed.cell_width, removed.cell_height), (240.0, 120.0));
    let purges = g
        .query("SELECT target_kind FROM sync_mutation WHERE action='entity.purge' ORDER BY target_kind".into(), vec![], None, CLIENT.into())
        .unwrap()
        .rows;
    assert_eq!(
        purges,
        vec![
            vec![V::Text("plot-grid-cell".into())],
            vec![V::Text("plot-grid-row".into())]
        ]
    );
    let projection = g
        .query(
            "SELECT plot_grid_json FROM node_content WHERE node_id='chapter'".into(),
            vec![],
            None,
            CLIENT.into(),
        )
        .unwrap()
        .rows;
    let V::Text(json) = &projection[0][0] else {
        panic!("projection")
    };
    let value: Value = serde_json::from_str(json).unwrap();
    assert_eq!(value["rows"], json!([{"id":"r2","label":"地点"}]));
    assert_eq!(value["cellW"], 240.0);
    // A trashed or missing node refuses.
    assert!(store
        .apply_plot_grid(&c, "missing", &[row("r9", "x", None)])
        .is_err());
}
