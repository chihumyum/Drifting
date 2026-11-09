//! V3 storage adapter for the existing plot planner and its interactions.
use crate::{Grid, Line, PlannerHost, PlotPlanner, Write};
use dr_model::pos::PosKey;
use dr_workspace::{
    Actor, Workspace, WsError,
    commands::{
        plot_grid::{Axis, CellInfo, LineInfo, PlotGridInfo},
        v3::{content, module},
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
    let mut grid = Grid::from_info(&read(lib, book, entry, module)?);
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
    lib.run::<content::GridPut>(
        &Actor::User,
        content::GridIn {
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
    )?;
    Ok(())
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
