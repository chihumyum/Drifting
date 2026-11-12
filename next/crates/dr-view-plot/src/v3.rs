//! V3 storage adapter for the existing plot planner and its interactions.
use crate::{Grid, Line, PlannerHost, PlotPlanner, Write};
use dr_model::pos::PosKey;
use dr_workspace::{
    Actor, RecordKey, Workspace, WritePreconditions, WsError,
    commands::v3::{
        content, module,
        plot::{Axis, CellInfo, LineInfo, PlotGridInfo},
    },
};
use gpui::{prelude::*, *};

fn target(book: &str, entry: &str, module: &str) -> module::In {
    module::In {
        book: book.into(),
        entry: entry.into(),
        module: module.into(),
    }
}
pub fn read(
    lib: &Workspace,
    book: &str,
    entry: &str,
    module: &str,
) -> Result<PlotGridInfo, WsError> {
    let data = lib
        .run::<module::ModuleRead>(&Actor::User, target(book, entry, module))?
        .output;
    let grid = data
        .grid
        .ok_or_else(|| WsError::Invalid("plot module has no grid".into()))?;
    let line = |l: content::Line| LineInfo {
        id: l.id,
        label: l.label,
        pos: Some(l.pos),
    };
    Ok(PlotGridInfo {
        node: entry.into(),
        exists: true,
        cell_w: grid.cell_w,
        cell_h: grid.cell_h,
        rows: grid.rows.into_iter().map(line).collect(),
        columns: grid.columns.into_iter().map(line).collect(),
        cells: grid
            .cells
            .into_iter()
            .map(|c| CellInfo {
                row: c.row,
                column: c.column,
                text: c.text,
            })
            .collect(),
    })
}
pub fn write(
    lib: &Workspace,
    book: &str,
    entry: &str,
    module: &str,
    writes: Vec<Write>,
) -> Result<(), WsError> {
    prepare(lib, book, entry, module, writes)?.commit(lib, &Actor::User)
}

struct PreparedWrite {
    input: content::GridIn,
    guard: WritePreconditions,
    grid: Grid,
}

impl PreparedWrite {
    fn commit(self, lib: &Workspace, actor: &Actor) -> Result<(), WsError> {
        lib.call_guarded(
            actor,
            "module.put_grid",
            serde_json::to_value(self.input).map_err(|e| WsError::Internal(e.to_string()))?,
            self.guard,
        )?;
        Ok(())
    }
}

fn prepare(
    lib: &Workspace,
    book: &str,
    entry: &str,
    module: &str,
    writes: Vec<Write>,
) -> Result<PreparedWrite, WsError> {
    prepare_from(lib, book, entry, module, writes, None)
}

pub(crate) fn write_from(
    lib: &Workspace,
    book: &str,
    entry: &str,
    module: &str,
    writes: Vec<Write>,
    base: Option<&Grid>,
) -> Result<Grid, WsError> {
    let prepared = prepare_from(lib, book, entry, module, writes, base)?;
    let saved = prepared.grid.clone();
    prepared.commit(lib, &Actor::User)?;
    Ok(saved)
}

fn prepare_from(
    lib: &Workspace,
    book: &str,
    entry: &str,
    module: &str,
    writes: Vec<Write>,
    base: Option<&Grid>,
) -> Result<PreparedWrite, WsError> {
    // Observe before reading: any intervening change to this grid invalidates
    // the whole-grid replacement. Never retry a failed guarded command here.
    let stored = lib
        .observe_records(
            &format!("book:{book}"),
            &[RecordKey::plot_grid(entry, module)],
        )?
        .remove(0);
    let mut grid = Grid::from_info(&read(lib, book, entry, module)?);
    if base.is_some_and(|base| *base != grid) {
        return Err(WsError::Conflict("plot grid changed while editing".into()));
    }
    for write in writes {
        match write {
            Write::Cell { row, col, text } => {
                if grid.index(Axis::Row, &row).is_none() || grid.index(Axis::Column, &col).is_none()
                {
                    return Err(WsError::Invalid("plot cell was removed".into()));
                }
                grid.set_cell(&row, &col, &text);
            }
            Write::Label { axis, id, label } => grid.set_label(axis, &id, &label),
            Write::Add { axis, id, after } => {
                let index = after
                    .as_ref()
                    .and_then(|a| grid.index(axis, a))
                    .map_or(0, |n| n + 1);
                grid.insert(
                    axis,
                    index,
                    Line {
                        id,
                        label: String::new(),
                    },
                );
            }
            Write::Move { axis, id, after } => {
                let mut ids: Vec<_> = grid
                    .lines(axis)
                    .iter()
                    .filter(|l| l.id != id)
                    .map(|l| l.id.clone())
                    .collect();
                let index = after
                    .as_ref()
                    .and_then(|a| ids.iter().position(|x| x == a))
                    .map_or(0, |n| n + 1);
                ids.clear();
                grid.move_to(axis, &id, index);
            }
            Write::Remove { axis, id } => {
                grid.remove(axis, &id);
            }
            Write::Size(size) => grid.size = size,
            Write::Clear => grid.clear(),
        }
    }
    let lines = |xs: Vec<Line>| {
        let mut pos = PosKey::first();
        xs.into_iter()
            .map(|l| {
                let row = content::Line {
                    id: l.id,
                    label: l.label,
                    pos: pos.to_string(),
                };
                pos = pos.after();
                row
            })
            .collect()
    };
    Ok(PreparedWrite {
        grid: grid.clone(),
        input: content::GridIn {
            target: target(book, entry, module),
            grid: content::Grid {
                cell_w: grid.size.w as f64,
                cell_h: grid.size.h as f64,
                rows: lines(grid.rows),
                columns: lines(grid.cols),
                cells: grid
                    .cells
                    .into_iter()
                    .map(|((row, column), text)| content::Cell { row, column, text })
                    .collect(),
            },
        },
        guard: WritePreconditions::from_records([stored]),
    })
}
struct ModuleView(Entity<PlotPlanner>);
impl Render for ModuleView {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().h(px(400.)).w_full().child(self.0.clone())
    }
}
pub fn register(cx: &mut App) {
    dr_shell::v3::add_module_view(cx, "plot_grid", |host, window, cx| {
        let target = dr_shell::v3::entry_target(&host.entry).expect("validated entry id");
        let (mark, color) = host.page.book.mark(&target);
        let title = host.page.book.title(&target).unwrap_or_default().to_owned();
        let entry = host.entry.clone();
        let planner = cx.new(|cx| {
            PlotPlanner::for_module(
                PlannerHost {
                    library: host.page.library,
                    book: host.page.book_id,
                    node: host.entry,
                    title,
                    mark,
                    color,
                },
                host.module.id,
                window,
                cx,
            )
        });
        let focus = planner.focus_handle(cx);
        let weak = planner.downgrade();
        let view = cx.new(|_| ModuleView(planner));
        dr_shell::v3::Rendered::new(view)
            .focus(focus)
            .on_refresh(move |book, cx| {
                if let Some(e) = book.v3().and_then(|b| b.entry(&entry)) {
                    weak.update(cx, |p, cx| p.set_title(e.title.clone(), cx))
                        .ok();
                }
            })
    });
}

#[cfg(test)]
mod tests {
    use super::{prepare, read, write};
    use crate::Write;
    use dr_workspace::{Actor, Workspace, WsError};

    #[test]
    fn stale_whole_grid_never_overwrites_an_agents_committed_cell() {
        let dir = tempfile::tempdir().unwrap();
        let store =
            dr_store::Library::open(dir.path(), dr_workspace::library_options("test")).unwrap();
        let seed = dr_testkit::seed::generate_v3(
            dr_testkit::seed::Preset::Tiny,
            dr_testkit::seed::DEFAULT_SEED,
        )
        .unwrap();
        let book = seed.books[0].book_id().to_string();
        seed.write_to(&store).unwrap();
        store.close().unwrap();
        let ws = Workspace::open_dir(dir.path(), "test").unwrap();
        let entries = ws
            .call(
                &Actor::User,
                "entry.list",
                serde_json::json!({"book":book,"all":true}),
            )
            .unwrap();
        let entry = entries["output"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["template"] == "tpl-chapter")
            .unwrap()["id"]
            .as_str()
            .unwrap();
        let grid = read(&ws, &book, entry, "mod-plot-grid").unwrap();
        let row = &grid.rows[0].id;
        let columns = [&grid.columns[0].id, &grid.columns[1].id];
        let batch = |n: usize| {
            vec![Write::Cell {
                row: row.clone(),
                col: columns[n].clone(),
                text: format!("G1 {n}"),
            }]
        };
        let author = prepare(&ws, &book, entry, "mod-plot-grid", batch(0)).unwrap();
        let agent = prepare(&ws, &book, entry, "mod-plot-grid", batch(1)).unwrap();
        agent
            .commit(&ws, &Actor::agent("g1-grid", 1, "cell"))
            .unwrap();
        assert!(matches!(
            author.commit(&ws, &Actor::User),
            Err(WsError::Conflict(_))
        ));
        let after = read(&ws, &book, entry, "mod-plot-grid").unwrap();
        assert_eq!(
            after
                .cells
                .iter()
                .find(|c| c.row == *row && c.column == *columns[0]),
            grid.cells
                .iter()
                .find(|c| c.row == *row && c.column == *columns[0]),
        );
        assert!(
            after
                .cells
                .iter()
                .any(|c| c.row == *row && c.column == *columns[1] && c.text == "G1 1")
        );
        // Only an explicit new attempt reads and rebases the author's patch.
        write(&ws, &book, entry, "mod-plot-grid", batch(0)).unwrap();
        let after = read(&ws, &book, entry, "mod-plot-grid").unwrap();
        for (n, col) in columns.into_iter().enumerate() {
            assert!(
                after
                    .cells
                    .iter()
                    .any(|c| c.row == *row && c.column == *col && c.text == format!("G1 {n}"))
            );
        }
    }
}
