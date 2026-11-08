//! The plot planner: one chapter's (or idea's) grid under the paper.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::time::Duration;

use dr_i18n::keys;
use dr_i18n::keys::plot_grid as k;
use dr_model::id::{PlotColId, PlotRowId};
use dr_shell::strings::{t, tf};
use dr_ui::components::overlay::{self, Align, Layer, Place};
use dr_ui::components::{Button, Menu, MenuItem};
use dr_ui::fonts::{Role, weight};
use dr_ui::glass::{self, Kind as GlassKind, Mode, Spec, Tone};
use dr_ui::input::{FieldEvent, TextArea};
use dr_ui::sand::{self, Icon, KindMark};
use dr_ui::style::DrStyled as _;
use dr_ui::tokens::{Rgb, radius};
use dr_ui::{Theme, sand::Kind as MarkKind};
use dr_workspace::commands::plot_grid::{
    Axis, CellIn, GridIn, GridSizeIn, LineAddIn, LineIn, LineUpdateIn, PlotGridCell, PlotGridClear,
    PlotGridCreate, PlotGridGet, PlotGridInfo, PlotGridLineAdd, PlotGridLineRemove,
    PlotGridLineUpdate, PlotGridSize,
};
use dr_workspace::{Actor, Workspace as Library, WsEvent};
use gpui::{
    AnyElement, AnyWindowHandle, App, AppContext as _, Bounds, Context, DispatchPhase, Entity,
    FocusHandle, Focusable, InteractiveElement as _, IntoElement, MouseButton, MouseMoveEvent,
    MouseUpEvent, ParentElement as _, Pixels, Point, Render, ScrollHandle, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, Task, TextRun, Window, canvas, div,
    prelude::FluentBuilder as _, px,
};

use crate::model::{
    COL_HEADER_H, CellSize, Grid, Line, clamp_size, dragged, fit, row_header_width,
};

/// Typing is stored this long after the last key (the prose editor's
/// cadence in 0.1, `PERSIST_DEBOUNCE_MS`), and at once when the field is
/// left.
pub const STORE_AFTER: Duration = Duration::from_millis(400);
/// Where a grid's hand-set shape is kept on this device (dr-store's
/// `local_state`, never synced, as 0.1 kept it in localStorage per chapter):
/// scope [`RATIO_SCOPE`], key `ratio:<chapter>`, tied to the book so purging
/// it drops the row.
pub const RATIO_SCOPE: &str = "plot";

/// The `local_state` key of `node`'s hand-set shape.
pub fn ratio_key(node: &str) -> String {
    format!("ratio:{node}")
}

/// The panel's header row.
pub const BAR_H: f32 = 34.0;
/// The space right of and below the table (the grip sits on its corner).
const TABLE_MARGIN: f32 = 12.0;
/// Label type: lanes in the structure face, columns in the index face.
const ROW_LABEL_PX: f32 = 12.5;
const ROW_LABEL_LINE: f32 = 17.0;
const COL_LABEL_PX: f32 = 11.0;
const COL_LABEL_LINE: f32 = 15.0;
/// Slip type.
const CELL_PX: f32 = 12.5;
const CELL_LINE: f32 = 19.0;

/// What the planner shows: which grid, and what its header names.
#[derive(Clone)]
pub struct PlannerHost {
    pub library: Library,
    pub book: String,
    /// The chapter or idea.
    pub node: String,
    /// Its title (empty: 「未命名」).
    pub title: String,
    /// Its mark and its storyline's colour.
    pub mark: MarkKind,
    pub color: Option<Rgb>,
}

/// A text field of the grid.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Field {
    Cell(String, String),
    Row(String),
    Col(String),
}

impl Field {
    fn label(axis: Axis, id: &str) -> Field {
        match axis {
            Axis::Row => Field::Row(id.to_owned()),
            Axis::Column => Field::Col(id.to_owned()),
        }
    }

    fn renamed(&self, map: &BTreeMap<String, String>) -> Field {
        let id = |s: &String| map.get(s).cloned().unwrap_or_else(|| s.clone());
        match self {
            Field::Cell(r, c) => Field::Cell(id(r), id(c)),
            Field::Row(r) => Field::Row(id(r)),
            Field::Col(c) => Field::Col(id(c)),
        }
    }
}

/// One change for F3, in the order the author made them.
#[derive(Clone, Debug, PartialEq)]
pub enum Write {
    Cell {
        row: String,
        col: String,
        text: String,
    },
    Label {
        axis: Axis,
        id: String,
        label: String,
    },
    Add {
        axis: Axis,
        id: String,
        after: Option<String>,
    },
    Move {
        axis: Axis,
        id: String,
        after: Option<String>,
    },
    Remove {
        axis: Axis,
        id: String,
    },
    Size(CellSize),
    Clear,
}

impl Write {
    fn rename(&mut self, map: &BTreeMap<String, String>) {
        let fix = |s: &mut String| {
            if let Some(to) = map.get(s.as_str()) {
                *s = to.clone();
            }
        };
        match self {
            Write::Cell { row, col, .. } => {
                fix(row);
                fix(col);
            }
            Write::Label { id, .. } | Write::Remove { id, .. } => fix(id),
            Write::Add { id, after, .. } | Write::Move { id, after, .. } => {
                fix(id);
                if let Some(a) = after {
                    fix(a);
                }
            }
            Write::Size(_) | Write::Clear => {}
        }
    }
}

/// What a batch of writes left: whether it stored the grid and the ids
/// `plot_grid.create` gave its `~` lines, and the writes F3 refused.
#[derive(Default)]
struct Written {
    created: bool,
    stored: BTreeMap<String, String>,
    refused: Vec<String>,
}

/// The grip being dragged: where it started and the size then.
#[derive(Clone, Copy, Debug)]
struct Drag {
    from: Point<Pixels>,
    start: CellSize,
}

pub struct PlotPlanner {
    host: PlannerHost,
    grid: Grid,
    loaded: bool,
    focus: FocusHandle,
    fields: HashMap<Field, Entity<TextArea>>,
    subs: HashMap<Field, Subscription>,
    /// Typed and not yet queued (stored [`STORE_AFTER`] after the last key).
    typed: BTreeMap<Field, String>,
    store_timer: Option<Task<()>>,
    queue: VecDeque<Write>,
    writing: Option<Task<()>>,
    /// F3 said the grid changed while writes were out: read it after them.
    stale: bool,
    reading: Option<Task<()>>,
    /// The header whose ⋯ menu is open.
    menu: Option<(Axis, String)>,
    drag: Option<Drag>,
    /// The size while the grip is dragged.
    live: Option<CellSize>,
    /// The shape a hand-set size fixed (width over height), for 「适应」;
    /// kept on this device ([`RATIO_SCOPE`]).
    ratio: Option<f32>,
    /// The stored shape being read.
    ratio_io: Option<Task<()>>,
    body: Entity<Option<Bounds<Pixels>>>,
    scroll: ScrollHandle,
    /// A line added at an end: scroll it into view on the next frames.
    reveal: Option<(Axis, u8)>,
    /// The ids `plot_grid.create` gave the unstored grid's `~` lines: the
    /// fields made before keep reporting the old ones.
    aliases: BTreeMap<String, String>,
    /// The window the planner is drawn in (reads that finish later sync
    /// its fields there).
    window: AnyWindowHandle,
    _events: Option<dr_workspace::events::Subscription>,
    _receiver: Option<Task<()>>,
}

impl Focusable for PlotPlanner {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl PlotPlanner {
    pub fn new(host: PlannerHost, window: &mut Window, cx: &mut Context<Self>) -> PlotPlanner {
        let body = cx.new(|_| None);
        let mut planner = PlotPlanner {
            host,
            grid: Grid::unstored(),
            loaded: false,
            focus: cx.focus_handle(),
            fields: HashMap::new(),
            subs: HashMap::new(),
            typed: BTreeMap::new(),
            store_timer: None,
            queue: VecDeque::new(),
            writing: None,
            stale: false,
            reading: None,
            menu: None,
            drag: None,
            live: None,
            ratio: None,
            ratio_io: None,
            body,
            scroll: ScrollHandle::new(),
            reveal: None,
            aliases: BTreeMap::new(),
            window: window.window_handle(),
            _events: None,
            _receiver: None,
        };
        planner.listen(window, cx);
        planner.reload(window, cx);
        planner.read_ratio(cx);
        planner
    }

    /// The hand-set shape kept on this device for this grid; a size set by
    /// hand before it arrives wins.
    fn read_ratio(&mut self, cx: &mut Context<Self>) {
        let lib = self.host.library.clone();
        let key = ratio_key(&self.host.node);
        let read = cx.background_spawn(async move {
            lib.library()
                .local_get(RATIO_SCOPE, &key)
                .map_err(|e| e.to_string())
        });
        self.ratio_io = Some(cx.spawn(async move |this, cx| {
            let stored = read.await;
            this.update(cx, |p, _| {
                p.ratio_io = None;
                match stored {
                    Ok(Some(raw)) if p.ratio.is_none() => {
                        p.ratio = raw
                            .parse::<f32>()
                            .ok()
                            .filter(|r| r.is_finite() && *r > 0.0);
                    }
                    Ok(_) => {}
                    Err(error) => log::warn!("the plot grid's shape could not be read: {error}"),
                }
            })
            .ok();
        }));
    }

    /// Keep `ratio` as this grid's hand-set shape on this device (detached:
    /// the planner may be gone, another chapter in front, before it lands).
    fn store_ratio(&mut self, ratio: f32, cx: &mut Context<Self>) {
        // A stored shape still being read is older than this one.
        self.ratio_io = None;
        let lib = self.host.library.clone();
        let (book, key) = (self.host.book.clone(), ratio_key(&self.host.node));
        cx.background_spawn(async move {
            if let Err(error) =
                lib.library()
                    .local_set(RATIO_SCOPE, &key, &ratio.to_string(), Some(&book))
            {
                log::warn!("the plot grid's shape could not be kept: {error}");
            }
        })
        .detach();
    }

    /// The hand-set shape 「适应」 keeps (width over height), if any.
    pub fn ratio(&self) -> Option<f32> {
        self.ratio
    }

    /// Whether the kept shape is still being read.
    pub fn is_ratio_settled(&self) -> bool {
        self.ratio_io.is_none()
    }

    pub fn host(&self) -> &PlannerHost {
        &self.host
    }

    /// The grid as drawn (edits included before F3 has them).
    pub fn grid(&self) -> &Grid {
        &self.grid
    }

    /// Whether the grid was read from F3 at least once.
    pub fn is_loaded(&self) -> bool {
        self.loaded
    }

    /// Whether everything typed and done has reached F3.
    pub fn is_settled(&self) -> bool {
        self.typed.is_empty()
            && self.queue.is_empty()
            && self.writing.is_none()
            && self.reading.is_none()
    }

    /// The text field of `field` (tests type into it).
    pub fn field(&self, field: &Field) -> Option<Entity<TextArea>> {
        self.fields.get(field).cloned()
    }

    /// The header whose menu is open.
    pub fn menu(&self) -> Option<(Axis, &str)> {
        self.menu.as_ref().map(|(a, id)| (*a, id.as_str()))
    }

    /// The title the header names (the chapter was renamed).
    pub fn set_title(&mut self, title: String, cx: &mut Context<Self>) {
        self.host.title = title;
        cx.notify();
    }

    // ── reading ─────────────────────────────────────────────────────────

    /// F3's events for this grid read it again.
    fn listen(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (tx, mut rx) = futures::channel::mpsc::unbounded::<()>();
        let (book, node) = (self.host.book.clone(), self.host.node.clone());
        self._events = Some(self.host.library.subscribe(move |event| {
            if let WsEvent::Book(b) = event
                && b.book.as_str() == book
                && b.changes.iter().any(|c| {
                    c.collection == dr_doc::book::Collection::PlotGrids
                        && c.id.as_deref().is_none_or(|id| id == node)
                })
            {
                let _ = tx.unbounded_send(());
            }
        }));
        self._receiver = Some(cx.spawn_in(window, async move |this, cx| {
            use futures::StreamExt as _;
            while rx.next().await.is_some() {
                while rx.try_recv().is_ok() {}
                if this
                    .update_in(cx, |p, window, cx| p.reload(window, cx))
                    .is_err()
                {
                    break;
                }
            }
        }));
    }

    /// Reads the grid from F3, once nothing of the author's is on its way.
    pub fn reload(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.writing.is_some() || !self.queue.is_empty() || !self.typed.is_empty() {
            self.stale = true;
            return;
        }
        self.stale = false;
        let lib = self.host.library.clone();
        let input = GridIn {
            book: self.host.book.clone(),
            node: self.host.node.clone(),
        };
        let read = cx.background_spawn(async move {
            lib.run::<PlotGridGet>(&Actor::User, input)
                .map(|o| o.output)
        });
        self.reading = Some(cx.spawn_in(window, async move |this, cx| {
            let info = read.await;
            this.update_in(cx, |p, window, cx| {
                p.reading = None;
                match info {
                    Ok(info) => p.read(&info, window, cx),
                    Err(error) => log::warn!("the plot grid could not be read: {error}"),
                }
            })
            .ok();
        }));
    }

    fn read(&mut self, info: &PlotGridInfo, window: &mut Window, cx: &mut Context<Self>) {
        // Edits made while it was read go first; their events read again.
        if self.writing.is_some() || !self.queue.is_empty() || !self.typed.is_empty() {
            self.stale = true;
            return;
        }
        let grid = Grid::from_info(info);
        // A stored grid is never unstored again (it is only cleared).
        if grid.exists || !self.grid.exists {
            self.grid = grid;
        }
        self.loaded = true;
        self.sync_fields(window, cx);
        cx.notify();
    }

    // ── fields ──────────────────────────────────────────────────────────

    /// A text field for every label and cell; each shows the grid's text
    /// unless it holds the caret or has typing not yet stored.
    fn sync_fields(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let mut wanted: Vec<(Field, String)> = Vec::new();
        for l in &self.grid.rows {
            wanted.push((Field::Row(l.id.clone()), l.label.clone()));
        }
        for l in &self.grid.cols {
            wanted.push((Field::Col(l.id.clone()), l.label.clone()));
        }
        for r in &self.grid.rows {
            for c in &self.grid.cols {
                let text = self.grid.cell(&r.id, &c.id).to_owned();
                wanted.push((Field::Cell(r.id.clone(), c.id.clone()), text));
            }
        }
        let keep: std::collections::HashSet<&Field> = wanted.iter().map(|(f, _)| f).collect();
        self.fields.retain(|f, _| keep.contains(f));
        self.subs.retain(|f, _| keep.contains(f));
        for (field, text) in wanted {
            match self.fields.get(&field) {
                Some(area) => {
                    let typing = self.typed.contains_key(&field);
                    area.update(cx, |a, cx| {
                        let focused = a.focus_handle(cx).is_focused(window);
                        if !typing && !focused && a.text() != text {
                            a.set_text(text, cx);
                        }
                    });
                }
                None => {
                    let area = self.make_field(&field, text, window, cx);
                    self.fields.insert(field, area);
                }
            }
        }
    }

    fn make_field(
        &mut self,
        field: &Field,
        text: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<TextArea> {
        let id = SharedString::from(match field {
            Field::Cell(r, c) => format!("plot-cell-{r}-{c}"),
            Field::Row(r) => format!("plot-row-{r}"),
            Field::Col(c) => format!("plot-col-{c}"),
        });
        let label = !matches!(field, Field::Cell(..));
        let placeholder = match field {
            Field::Row(_) => Some(t(cx, k::ROW_PLACEHOLDER)),
            Field::Col(_) => Some(t(cx, k::COLUMN_PLACEHOLDER)),
            Field::Cell(..) => None,
        };
        let area = cx.new(|cx| {
            let a = TextArea::new(id, window, cx).with_text(text);
            match placeholder {
                // A label is one paragraph that wraps; Enter leaves it.
                Some(placeholder) if label => a.placeholder(placeholder).submit_on_enter(),
                _ => a.wrap_punctuation(),
            }
        });
        let key = field.clone();
        let sub = cx.subscribe_in(&area, window, move |p, _, event, window, cx| {
            p.field_event(&key, event, window, cx)
        });
        self.subs.insert(field.clone(), sub);
        area
    }

    fn field_event(
        &mut self,
        field: &Field,
        event: &FieldEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let field = &field.renamed(&self.aliases);
        match event {
            FieldEvent::Changed(text) => {
                match field {
                    Field::Cell(r, c) => self.grid.set_cell(r, c, text),
                    Field::Row(id) => self.grid.set_label(Axis::Row, id, text),
                    Field::Col(id) => self.grid.set_label(Axis::Column, id, text),
                }
                self.typed.insert(field.clone(), text.clone());
                self.store_timer = Some(cx.spawn_in(window, async move |this, cx| {
                    cx.background_executor().timer(STORE_AFTER).await;
                    this.update(cx, |p, cx| p.store_typed(cx)).ok();
                }));
                cx.notify();
            }
            FieldEvent::Blurred => self.store_typed(cx),
            FieldEvent::Submitted(_) | FieldEvent::Cancelled => {
                self.store_typed(cx);
                window.focus(&self.focus, cx);
            }
        }
    }

    /// Queues what was typed, in the order of the fields (each holds its
    /// latest text).
    pub fn store_typed(&mut self, cx: &mut Context<Self>) {
        self.store_timer = None;
        for (field, text) in std::mem::take(&mut self.typed) {
            self.queue.push_back(match field {
                Field::Cell(row, col) => Write::Cell { row, col, text },
                Field::Row(id) => Write::Label {
                    axis: Axis::Row,
                    id,
                    label: text,
                },
                Field::Col(id) => Write::Label {
                    axis: Axis::Column,
                    id,
                    label: text,
                },
            });
        }
        self.pump(cx);
    }

    /// Paste a spreadsheet block at a slip, as 0.1's `PlotGrid` did:
    /// tabs divide columns, newlines divide rows, and one final newline
    /// is ignored. A plain string still belongs to the field's ordinary
    /// paste (inserting at the caret, not replacing the slip).
    pub fn paste_block(
        &mut self,
        field: &Field,
        text: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if !text.contains(['\t', '\n']) {
            return false;
        }
        let Field::Cell(row, col) = field.renamed(&self.aliases) else {
            return false;
        };
        let (Some(row), Some(col)) = (
            self.grid.index(Axis::Row, &row),
            self.grid.index(Axis::Column, &col),
        ) else {
            return false;
        };
        let text = text.replace("\r\n", "\n").replace('\r', "\n");
        let mut rows: Vec<&str> = text.split('\n').collect();
        if rows.len() > 1 && rows.last() == Some(&"") {
            rows.pop();
        }
        let cells: Vec<Vec<&str>> = rows.iter().map(|r| r.split('\t').collect()).collect();
        let width = cells.iter().map(Vec::len).max().unwrap_or(0);

        // Earlier typing must reach F3 before the block overwrites it.
        // Queue all new lines before their cells, including the first
        // edit of a still-unstored grid (whose ids `pump` will adopt).
        self.store_typed(cx);
        for (axis, count) in [(Axis::Row, row + cells.len()), (Axis::Column, col + width)] {
            while self.grid.lines(axis).len() < count {
                let at = self.grid.lines(axis).len();
                let after = self.grid.after_for(axis, at);
                let id = new_id(axis);
                self.grid.insert(
                    axis,
                    at,
                    Line {
                        id: id.clone(),
                        label: String::new(),
                    },
                );
                self.queue.push_back(Write::Add { axis, id, after });
            }
        }
        let mut pasted = Vec::new();
        for (dr, cells) in cells.iter().enumerate() {
            for (dc, text) in cells.iter().enumerate() {
                let row = self.grid.rows[row + dr].id.clone();
                let col = self.grid.cols[col + dc].id.clone();
                self.grid.set_cell(&row, &col, text);
                pasted.push((Field::Cell(row.clone(), col.clone()), (*text).to_owned()));
                self.queue.push_back(Write::Cell {
                    row,
                    col,
                    text: (*text).to_owned(),
                });
            }
        }
        self.sync_fields(window, cx);
        // `sync_fields` protects the focused field from outside writes;
        // this is the author's own paste, so it replaces that field too.
        for (field, text) in pasted {
            if let Some(area) = self.fields.get(&field) {
                area.update(cx, |a, cx| a.set_text(text, cx));
            }
        }
        self.pump(cx);
        cx.notify();
        true
    }

    // ── writing ─────────────────────────────────────────────────────────

    fn push(&mut self, write: Write, window: &mut Window, cx: &mut Context<Self>) {
        // What was typed goes first.
        self.store_typed(cx);
        self.queue.push_back(write);
        self.pump(cx);
        self.sync_fields(window, cx);
        cx.notify();
    }

    /// Sends the queued writes to F3 on a background thread, one batch at a
    /// time, in order. An unstored grid is stored first
    /// (`plot_grid.create`) and its `~` lines take the ids it was given.
    fn pump(&mut self, cx: &mut Context<Self>) {
        if self.writing.is_some() || self.queue.is_empty() {
            return;
        }
        let batch: Vec<Write> = self.queue.drain(..).collect();
        let lib = self.host.library.clone();
        let (book, node) = (self.host.book.clone(), self.host.node.clone());
        let create = !self.grid.exists;
        let job =
            cx.background_spawn(async move { write_batch(&lib, &book, &node, create, batch) });
        self.writing = Some(cx.spawn(async move |this, cx| {
            let written = job.await;
            this.update(cx, |p, cx| p.written(written, cx)).ok();
        }));
    }

    fn written(&mut self, written: Written, cx: &mut Context<Self>) {
        self.writing = None;
        if written.created {
            self.adopt_ids(&written.stored);
        }
        for refused in &written.refused {
            log::warn!("the plot grid refused a change: {refused}");
        }
        if !written.refused.is_empty() {
            self.stale = true;
        }
        self.pump(cx);
        if self.writing.is_none() && self.queue.is_empty() && self.typed.is_empty() && self.stale {
            // Read again, in the window the planner is drawn in.
            let (handle, this) = (self.window, cx.entity().downgrade());
            App::defer(cx, move |cx| {
                handle
                    .update(cx, |_, window, cx| {
                        this.update(cx, |p, cx| p.reload(window, cx)).ok();
                    })
                    .ok();
            });
        }
        cx.notify();
    }

    /// The grid is stored: its `~` lines are now the ids F3 gave them.
    fn adopt_ids(&mut self, map: &BTreeMap<String, String>) {
        self.grid.exists = true;
        if map.is_empty() {
            return;
        }
        self.grid.rename(map);
        for w in self.queue.iter_mut() {
            w.rename(map);
        }
        self.fields = std::mem::take(&mut self.fields)
            .into_iter()
            .map(|(f, a)| (f.renamed(map), a))
            .collect();
        // The fields' subscriptions keep reporting the old ids:
        // `field_event` reads them through `aliases`.
        self.subs = std::mem::take(&mut self.subs)
            .into_iter()
            .map(|(f, s)| (f.renamed(map), s))
            .collect();
        self.typed = std::mem::take(&mut self.typed)
            .into_iter()
            .map(|(f, t)| (f.renamed(map), t))
            .collect();
        self.aliases
            .extend(map.iter().map(|(a, b)| (a.clone(), b.clone())));
        if let Some((_, id)) = &mut self.menu
            && let Some(to) = map.get(id.as_str())
        {
            *id = to.clone();
        }
    }
}

/// Runs `batch` against F3, in order (on a background thread).
fn write_batch(lib: &Library, book: &str, node: &str, create: bool, batch: Vec<Write>) -> Written {
    let mut out = Written::default();
    let grid_in = || GridIn {
        book: book.to_owned(),
        node: node.to_owned(),
    };
    if create {
        match lib.run::<PlotGridCreate>(&Actor::User, grid_in()) {
            Ok(o) => {
                out.created = true;
                // `~r0` → the first stored row, and so on (the unstored
                // grid's own order, whatever the author did since).
                out.stored = Grid::unstored().stored_ids(&Grid::from_info(&o.output));
            }
            Err(error) => {
                out.refused.push(format!("plot_grid.create: {error}"));
                return out;
            }
        }
    }
    let (book, node) = (book.to_owned(), node.to_owned());
    for mut write in batch {
        write.rename(&out.stored);
        let user = &Actor::User;
        let result = match write.clone() {
            Write::Cell { row, col, text } => lib
                .run::<PlotGridCell>(
                    user,
                    CellIn {
                        book: book.clone(),
                        node: node.clone(),
                        row,
                        column: col,
                        text,
                    },
                )
                .map(drop),
            Write::Label { axis, id, label } => lib
                .run::<PlotGridLineUpdate>(
                    user,
                    LineUpdateIn {
                        book: book.clone(),
                        node: node.clone(),
                        axis,
                        id,
                        label: Some(label),
                        after: None,
                        pos: None,
                    },
                )
                .map(drop),
            Write::Add { axis, id, after } => lib
                .run::<PlotGridLineAdd>(
                    user,
                    LineAddIn {
                        book: book.clone(),
                        node: node.clone(),
                        axis,
                        after,
                        label: String::new(),
                        id: Some(id),
                        pos: None,
                    },
                )
                .map(drop),
            Write::Move { axis, id, after } => lib
                .run::<PlotGridLineUpdate>(
                    user,
                    LineUpdateIn {
                        book: book.clone(),
                        node: node.clone(),
                        axis,
                        id,
                        label: None,
                        after: Some(after),
                        pos: None,
                    },
                )
                .map(drop),
            Write::Remove { axis, id } => lib
                .run::<PlotGridLineRemove>(
                    user,
                    LineIn {
                        book: book.clone(),
                        node: node.clone(),
                        axis,
                        id,
                    },
                )
                .map(drop),
            Write::Size(size) => lib
                .run::<PlotGridSize>(
                    user,
                    GridSizeIn {
                        book: book.clone(),
                        node: node.clone(),
                        cell_w: f64::from(size.w),
                        cell_h: f64::from(size.h),
                    },
                )
                .map(drop),
            Write::Clear => lib.run::<PlotGridClear>(user, grid_in()).map(drop),
        };
        if let Err(error) = result {
            out.refused.push(format!("{write:?}: {error}"));
        }
    }
    out
}

/// A new row's or column's id.
fn new_id(axis: Axis) -> String {
    match axis {
        Axis::Row => PlotRowId::new_v7().to_string(),
        Axis::Column => PlotColId::new_v7().to_string(),
    }
}

impl PlotPlanner {
    // ── what the author does ────────────────────────────────────────────

    /// 「＋ 行」 / 「＋ 列」: a new row or column at the end, scrolled into
    /// view.
    pub fn add_line(&mut self, axis: Axis, window: &mut Window, cx: &mut Context<Self>) {
        let id = new_id(axis);
        let lines = self.grid.lines(axis);
        let after = lines.last().map(|l| l.id.clone());
        let at = lines.len();
        self.grid.insert(
            axis,
            at,
            Line {
                id: id.clone(),
                label: String::new(),
            },
        );
        self.reveal = Some((axis, 2));
        self.push(Write::Add { axis, id, after }, window, cx);
    }

    /// The header menu's 在上方插入 / 在下方插入 (左侧 / 右侧).
    pub fn insert_line(
        &mut self,
        axis: Axis,
        beside: &str,
        before: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.menu = None;
        let Some(i) = self.grid.index(axis, beside) else {
            return;
        };
        let at = if before { i } else { i + 1 };
        let after = self.grid.after_for(axis, at);
        let id = new_id(axis);
        self.grid.insert(
            axis,
            at,
            Line {
                id: id.clone(),
                label: String::new(),
            },
        );
        self.push(Write::Add { axis, id, after }, window, cx);
    }

    /// 上移 / 下移 (左移 / 右移): one place back (`-1`) or forward (`1`).
    pub fn move_line(
        &mut self,
        axis: Axis,
        id: &str,
        delta: isize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(i) = self.grid.index(axis, id) else {
            return;
        };
        let to = i as isize + delta;
        if to < 0 || to as usize >= self.grid.lines(axis).len() {
            return;
        }
        let to = to as usize;
        self.grid.move_to(axis, id, to);
        let after = self.grid.after_for(axis, to);
        self.push(
            Write::Move {
                axis,
                id: id.to_owned(),
                after,
            },
            window,
            cx,
        );
    }

    /// 删除此行 / 此列, with its cells; the last one stays.
    pub fn remove_line(
        &mut self,
        axis: Axis,
        id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.menu = None;
        if !self.grid.remove(axis, id) {
            return;
        }
        self.typed.retain(|f, _| match (f, axis) {
            (Field::Cell(r, _), Axis::Row) | (Field::Row(r), Axis::Row) => r != id,
            (Field::Cell(_, c), Axis::Column) | (Field::Col(c), Axis::Column) => c != id,
            _ => true,
        });
        self.push(
            Write::Remove {
                axis,
                id: id.to_owned(),
            },
            window,
            cx,
        );
    }

    /// 重命名: the label takes the caret, its text selected.
    pub fn rename_line(
        &mut self,
        axis: Axis,
        id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.menu = None;
        if let Some(area) = self.fields.get(&Field::label(axis, id)).cloned() {
            let handle = area.focus_handle(cx);
            window.focus(&handle, cx);
            area.update(cx, |a, cx| a.select_all_text(cx));
        }
        cx.notify();
    }

    /// 清空 pressed: asks first (`plotGrid.clearConfirm`), as a dialog over
    /// the window.
    pub fn ask_clear(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let planner = cx.entity().downgrade();
        let dialog = cx.new(|cx| ClearDialog::new(planner, cx));
        let handle = window.window_handle();
        let focus = dialog.read(cx).focus.clone();
        // The window is busy with this click; show it once it is over.
        App::defer(cx, move |cx| {
            dr_shell::dialogs::show_in(handle, cx, dialog.into());
            handle
                .update(cx, |_, window, cx| window.focus(&focus, cx))
                .ok();
        });
    }

    /// 清空: every label and every cell; rows, columns and size stay.
    pub fn clear(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.menu = None;
        self.typed.clear();
        self.store_timer = None;
        self.grid.clear();
        for area in self.fields.values() {
            area.update(cx, |a, cx| a.set_text("", cx));
        }
        self.push(Write::Clear, window, cx);
    }

    /// 适应: the cells sized so the table fills the panel (keeping a
    /// hand-set shape), stored.
    pub fn fit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(bounds) = *self.body.read(cx) else {
            return;
        };
        let head = self.row_header_w(window, cx);
        let size = fit(
            f32::from(bounds.size.width),
            f32::from(bounds.size.height),
            self.grid.rows.len(),
            self.grid.cols.len(),
            head,
            self.ratio,
        );
        self.set_size(size, false, window, cx);
    }

    /// Stores a cell size (within F3's bounds); `by_hand` also fixes the
    /// shape 「适应」 keeps.
    pub fn set_size(
        &mut self,
        size: CellSize,
        by_hand: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let size = clamp_size(size);
        if by_hand {
            let ratio = size.w / size.h;
            if self.ratio != Some(ratio) {
                self.ratio = Some(ratio);
                self.store_ratio(ratio, cx);
            }
        }
        if size == self.grid.size {
            cx.notify();
            return;
        }
        self.grid.size = size;
        self.push(Write::Size(size), window, cx);
    }

    /// The size while the grip is dragged (tests: a drag without a mouse).
    pub fn live_size(&self) -> Option<CellSize> {
        self.live
    }

    pub fn start_drag(&mut self, at: Point<Pixels>, cx: &mut Context<Self>) {
        self.drag = Some(Drag {
            from: at,
            start: self.grid.size,
        });
        self.live = Some(self.grid.size);
        cx.notify();
    }

    pub fn drag_to(&mut self, at: Point<Pixels>, cx: &mut Context<Self>) {
        let Some(drag) = self.drag else {
            return;
        };
        let d = at - drag.from;
        self.live = Some(dragged(
            drag.start,
            f32::from(d.x),
            f32::from(d.y),
            self.grid.rows.len(),
            self.grid.cols.len(),
        ));
        cx.notify();
    }

    pub fn end_drag(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.drag = None;
        if let Some(size) = self.live.take() {
            self.set_size(size, true, window, cx);
        }
        cx.notify();
    }

    /// The ⋯ of a header: opens its menu, or closes it when open.
    pub fn toggle_menu(&mut self, axis: Axis, id: &str, cx: &mut Context<Self>) {
        let same = self
            .menu
            .as_ref()
            .is_some_and(|(a, i)| *a == axis && i == id);
        self.menu = (!same).then(|| (axis, id.to_owned()));
        cx.notify();
    }

    // ── geometry ────────────────────────────────────────────────────────

    /// The row header hugs its widest label (placeholders count).
    pub fn row_header_w(&self, window: &Window, cx: &App) -> f32 {
        let placeholder = t(cx, k::ROW_PLACEHOLDER);
        let font = Role::Structure.font(weight::MEDIUM);
        let mut widest = 0.0_f32;
        for l in &self.grid.rows {
            let text: SharedString = if l.label.is_empty() {
                placeholder.clone()
            } else {
                l.label.clone().into()
            };
            for line in text.split('\n').filter(|l| !l.is_empty()) {
                let run = TextRun {
                    len: line.len(),
                    font: font.clone(),
                    color: gpui::black(),
                    background_color: None,
                    underline: None,
                    strikethrough: None,
                };
                let shaped = window.text_system().shape_line(
                    SharedString::from(line.to_owned()),
                    px(ROW_LABEL_PX),
                    &[run],
                    None,
                );
                widest = widest.max(f32::from(shaped.width));
            }
        }
        row_header_width(widest)
    }
}

impl Render for PlotPlanner {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let size = self.live.unwrap_or(self.grid.size);
        let head_w = self.row_header_w(window, cx);
        // A line added at an end: once it is laid out, scroll to it.
        if let Some((axis, frames)) = self.reveal {
            if frames > 0 {
                self.reveal = Some((axis, frames - 1));
                window.request_animation_frame();
            } else {
                self.reveal = None;
                let max = self.scroll.max_offset();
                let mut at = self.scroll.offset();
                match axis {
                    Axis::Row => at.y = -max.y,
                    Axis::Column => at.x = -max.x,
                }
                self.scroll.set_offset(at);
            }
        }
        let menu = self.menu_float(window, cx);
        let dragging = self.drag.is_some();
        div()
            .id("plot-planner")
            .key_context("PlotPlanner")
            .track_focus(&self.focus)
            .relative()
            .size_full()
            .flex()
            .flex_col()
            .overflow_hidden()
            .bg(p.desk.solid())
            .font_role(Role::Ui)
            .child(self.bar(window, cx))
            // The column heads sit on the header's colour: a hairline parts
            // them.
            .child(div().h(px(0.5)).w_full().flex_none().bg(p.hairline()))
            .child(self.body(size, head_w, window, cx))
            .children(menu)
            .when(dragging, |el| el.child(self.drag_capture(cx)))
    }
}

impl PlotPlanner {
    /// The panel's header row: the chapter's mark and title, 「情节」, and
    /// the text buttons.
    fn bar(&self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let title: SharedString = if self.host.title.trim().is_empty() {
            t(cx, keys::common::UNTITLED)
        } else {
            self.host.title.clone().into()
        };
        let mut mark = KindMark::new("plot-mark", self.host.mark);
        if let Some(color) = self.host.color {
            mark = mark.color(color);
        }
        div()
            .h(px(BAR_H))
            .flex_none()
            .pl(px(14.0))
            .pr(px(8.0))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(2.0))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.0))
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .type_px(s.secondary, s.line_body)
                    .text_color(p.muted().solid())
                    .child(mark)
                    .child(
                        div()
                            .min_w_0()
                            .overflow_hidden()
                            .text_ellipsis()
                            .text_color(p.ink(2).solid())
                            .font_weight(weight::MEDIUM)
                            .child(title),
                    )
                    .child(div().flex_none().child(t(cx, k::TITLE))),
            )
            .child(
                Button::new("plot-add-row", t(cx, k::ADD_ROW_SHORT))
                    .text()
                    .small()
                    .icon(Icon::Plus)
                    .on_click(cx.listener(|p, _, window, cx| p.add_line(Axis::Row, window, cx))),
            )
            .child(
                Button::new("plot-add-column", t(cx, k::ADD_COLUMN_SHORT))
                    .text()
                    .small()
                    .icon(Icon::Plus)
                    .on_click(cx.listener(|p, _, window, cx| p.add_line(Axis::Column, window, cx))),
            )
            .child(
                Button::new("plot-fit", t(cx, k::FIT))
                    .text()
                    .small()
                    .icon(Icon::Fullscreen)
                    .on_click(cx.listener(|p, _, window, cx| p.fit(window, cx))),
            )
            .child(
                Button::new("plot-clear", t(cx, k::CLEAR))
                    .text()
                    .small()
                    .icon(Icon::Eraser)
                    .on_click(cx.listener(|p, _, window, cx| p.ask_clear(window, cx))),
            )
    }

    /// The grid: column heads along the top, lanes down the left, the slips;
    /// both axes scroll; the grip on the table's corner.
    fn body(
        &self,
        size: CellSize,
        head_w: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let cols = self.grid.cols.clone();
        let rows = self.grid.rows.clone();
        let table_w = head_w + size.w * cols.len() as f32;
        let mut header = div()
            .flex()
            .flex_row()
            .h(px(COL_HEADER_H))
            .child(div().w(px(head_w)).h_full().flex_none());
        for c in &cols {
            header = header.child(self.col_head(c, size.w, window, cx));
        }
        let mut table = div()
            .relative()
            .w(px(table_w))
            .flex_none()
            .flex()
            .flex_col()
            .mr(px(TABLE_MARGIN))
            .mb(px(TABLE_MARGIN))
            .child(header);
        for (ri, r) in rows.iter().enumerate() {
            let mut row = div()
                .flex()
                .flex_row()
                .h(px(size.h))
                .child(self.row_head(r, head_w, size.h, window, cx));
            for c in &cols {
                row = row.child(self.cell(r, c, ri, size, window, cx));
            }
            table = table.child(row);
        }
        table = table.child(self.grip(window, cx));
        // The live size, in the table's empty corner.
        let badge = self.live.map(|live| {
            div()
                .absolute()
                .top(px(4.0))
                .left(px(2.0))
                .h(px(22.0))
                .px(px(4.0))
                .rounded(px(radius::XS))
                .bg(p.desk.solid())
                .font_role(Role::Index)
                .type_px(11.0, 22.0)
                .text_color(p.muted().solid())
                .child(format!("{} × {}", live.w, live.h))
        });
        div()
            .id("plot-body")
            .group("plot-body")
            .relative()
            .flex_1()
            .min_h_0()
            .w_full()
            .child(overlay::probe(self.body.clone()))
            .child(
                div()
                    .id("plot-scroll")
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full()
                    .overflow_scroll()
                    .track_scroll(&self.scroll)
                    .child(table),
            )
            .children(badge)
    }

    fn col_head(
        &self,
        line: &Line,
        w: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let group = SharedString::from(format!("plot-col-head-{}", line.id));
        let area = self.fields.get(&Field::Col(line.id.clone())).cloned();
        div()
            .id(group.clone())
            .group(group.clone())
            .relative()
            .w(px(w))
            .h_full()
            .flex_none()
            .pl(px(10.0))
            .pr(px(6.0))
            .flex()
            .items_center()
            .font_role(Role::Index)
            .type_px(COL_LABEL_PX, COL_LABEL_LINE)
            .text_color(p.muted().solid())
            .hover(|s| s.text_color(p.ink(1).solid()))
            .child(
                div()
                    .w_full()
                    .pr(px(18.0))
                    .max_h(px(2.0 * COL_LABEL_LINE + 2.0))
                    .overflow_hidden()
                    .children(area),
            )
            .child(self.menu_button(Axis::Column, &line.id, group, window, cx))
            .into_any_element()
    }

    fn row_head(
        &self,
        line: &Line,
        w: f32,
        h: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let group = SharedString::from(format!("plot-row-head-{}", line.id));
        let area = self.fields.get(&Field::Row(line.id.clone())).cloned();
        div()
            .id(group.clone())
            .group(group.clone())
            .relative()
            .w(px(w))
            .h(px(h))
            .flex_none()
            .pl(px(14.0))
            .pr(px(8.0))
            .flex()
            .items_center()
            .font_role(Role::Structure)
            .font_weight(weight::MEDIUM)
            .type_px(ROW_LABEL_PX, ROW_LABEL_LINE)
            .text_color(p.ink(2).solid())
            .hover(|s| s.text_color(p.ink(1).solid()))
            .child(
                div()
                    .w_full()
                    .max_h(px(3.0 * ROW_LABEL_LINE + 2.0))
                    .overflow_hidden()
                    .children(area),
            )
            .child(self.menu_button(Axis::Row, &line.id, group, window, cx))
            .into_any_element()
    }

    /// The header's ⋯: shows under the pointer (and while its menu is open)
    /// over the label's end, on the header's own colour.
    fn menu_button(
        &self,
        axis: Axis,
        id: &str,
        group: SharedString,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let anchor = overlay::use_bounds(menu_anchor_id(id), window, cx);
        let open = self
            .menu
            .as_ref()
            .is_some_and(|(a, i)| *a == axis && i == id);
        let line = id.to_owned();
        div()
            .absolute()
            .right(px(0.0))
            .top_0()
            .bottom_0()
            .flex()
            .items_center()
            .when(!open, |el| {
                el.invisible().group_hover(group, |s| s.visible())
            })
            .child(
                div()
                    .id(SharedString::from(format!("plot-menu-{id}")))
                    .relative()
                    .size(px(18.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(radius::XS))
                    .bg(p.desk.solid())
                    .cursor_pointer()
                    .child(overlay::probe(anchor))
                    .child(sand::icon(
                        Icon::More,
                        14.0,
                        if open { p.ink(1) } else { p.ink(4) }.solid(),
                    ))
                    .on_click(cx.listener(move |p, _, _, cx| p.toggle_menu(axis, &line, cx))),
            )
    }

    /// One slip: the page's white parted by half-pixel lines of the desk
    /// colour; the slip holds a resting line of clear glass (an empty one
    /// only under the pointer or the caret).
    fn cell(
        &self,
        row: &Line,
        col: &Line,
        row_index: usize,
        size: CellSize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let field = Field::Cell(row.id.clone(), col.id.clone());
        let area = self.fields.get(&field).cloned();
        let empty = self.grid.cell(&row.id, &col.id).is_empty();
        let focused = area
            .as_ref()
            .is_some_and(|a| a.focus_handle(cx).is_focused(window));
        let id = SharedString::from(format!("plot-slip-{}-{}", row.id, col.id));
        let kind = if empty {
            GlassKind::Hidden
        } else {
            GlassKind::Rest
        };
        let slip = glass::glass_box(
            id.clone(),
            kind,
            Mode::default(),
            focused,
            Spec::new(Tone::Clear, radius::SM).filled(p.page),
            window,
            cx,
        );
        let to_focus = area.as_ref().map(|a| a.focus_handle(cx));
        let placeholder = (empty && area.is_some()).then(|| {
            div()
                .absolute()
                .top(px(6.0))
                .left(px(9.0))
                .text_color(p.ink(5).solid())
                .when(!focused, |el| {
                    el.invisible().group_hover(id.clone(), |s| s.visible())
                })
                .child(t(cx, k::EMPTY_CELL))
        });
        div()
            .w(px(size.w))
            .h(px(size.h))
            .flex_none()
            .px(px(5.0))
            .py(px(3.0))
            .bg(p.page.solid())
            .border_l(px(0.5))
            .when(row_index > 0, |el| el.border_t(px(0.5)))
            .border_color(p.desk.solid())
            .child(
                slip.group(id)
                    .role(gpui::Role::Group)
                    .aria_label(if empty {
                        t(cx, k::EMPTY_CELL)
                    } else {
                        self.grid.cell(&row.id, &col.id).to_owned().into()
                    })
                    .relative()
                    .size_full()
                    .px(px(9.0))
                    .py(px(6.0))
                    .rounded(px(radius::SM))
                    // Long text is cut at the bottom. Closing punctuation
                    // wraps inside the slip, as in the old contenteditable.
                    .overflow_y_hidden()
                    .cursor_text()
                    .font_role(Role::Ui)
                    .type_px(CELL_PX, CELL_LINE)
                    .text_color(p.ink(2).solid())
                    .capture_action(cx.listener(
                        move |p, _: &dr_ui::input::field::Paste, window, cx| {
                            if let Some(text) =
                                cx.read_from_clipboard().and_then(|item| item.text())
                                && p.paste_block(&field, &text, window, cx)
                            {
                                cx.stop_propagation();
                            }
                        },
                    ))
                    .when_some(to_focus, |el, handle| {
                        el.on_mouse_down(MouseButton::Left, move |_, window, cx| {
                            if !handle.is_focused(window) {
                                window.focus(&handle, cx);
                            }
                        })
                    })
                    .children(placeholder)
                    .children(area),
            )
            .into_any_element()
    }

    /// The grip on the table's corner: drag to size the cells by hand.
    fn grip(&self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let dragging = self.drag.is_some();
        div()
            .id("plot-grip")
            .absolute()
            .right(px(-9.0))
            .bottom(px(-9.0))
            .size(px(18.0))
            .flex()
            .items_center()
            .justify_center()
            .cursor(gpui::CursorStyle::ResizeUpLeftDownRight)
            .when(!dragging, |el| {
                el.opacity(0.0)
                    .group_hover("plot-body", |s| s.opacity(0.75))
                    .hover(|s| s.opacity(1.0))
            })
            .child(sand::icon(
                Icon::Grip,
                12.0,
                if dragging { p.ink(1) } else { p.ink(4) }.solid(),
            ))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|p, e: &gpui::MouseDownEvent, _, cx| {
                    cx.stop_propagation();
                    p.start_drag(e.position, cx);
                }),
            )
    }

    /// While the grip is dragged: the pointer anywhere in the window moves
    /// it, letting go stores the size.
    fn drag_capture(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let this = cx.entity().downgrade();
        canvas(
            |_, _, _| {},
            move |_, _, window, _| {
                let moving = this.clone();
                window.on_mouse_event(move |e: &MouseMoveEvent, phase, _, cx| {
                    if phase == DispatchPhase::Bubble {
                        moving.update(cx, |p, cx| p.drag_to(e.position, cx)).ok();
                    }
                });
                let up = this.clone();
                window.on_mouse_event(move |e: &MouseUpEvent, phase, window, cx| {
                    if phase == DispatchPhase::Bubble && e.button == MouseButton::Left {
                        up.update(cx, |p, cx| p.end_drag(window, cx)).ok();
                    }
                });
            },
        )
        .absolute()
        .size_full()
    }

    /// The header menu: rename; move back and forward; insert before and
    /// after; delete (with how many slips it clears).
    fn menu_float(&self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let (axis, id) = self.menu.clone()?;
        let anchor = *overlay::use_bounds(menu_anchor_id(&id), window, cx).read(cx);
        let anchor = anchor?;
        let theme = Theme::of(window, cx);
        let i = self.grid.index(axis, &id)?;
        let n = self.grid.lines(axis).len();
        let filled = self.grid.filled(axis, &id);
        let row = axis == Axis::Row;
        let pick = |r: SharedString, c: SharedString| if row { r } else { c };
        let on = |f: fn(&mut PlotPlanner, Axis, &str, &mut Window, &mut Context<PlotPlanner>)| {
            let id = id.clone();
            cx.listener(move |p, _: &gpui::ClickEvent, window, cx| f(p, axis, &id, window, cx))
        };
        let mut delete = MenuItem::new(
            "plot-head-delete",
            Icon::Trash,
            pick(t(cx, k::DELETE_ROW), t(cx, k::DELETE_COLUMN)),
        )
        .danger()
        .disabled(n <= 1)
        .on_click(on(|p, a, id, w, cx| p.remove_line(a, id, w, cx)));
        if filled > 0 {
            delete = delete.trailing(tf(cx, k::DELETE_CLEARS, &[("count", &filled)]));
        }
        let menu = Menu::new("plot-head-menu")
            .item(
                MenuItem::new("plot-head-rename", Icon::Edit, t(cx, k::RENAME))
                    .on_click(on(|p, a, id, w, cx| p.rename_line(a, id, w, cx))),
            )
            .separator(&theme)
            .item(
                MenuItem::new(
                    "plot-head-back",
                    if row {
                        Icon::ChevronUp
                    } else {
                        Icon::ChevronLeft
                    },
                    pick(t(cx, k::MOVE_UP), t(cx, k::MOVE_LEFT)),
                )
                .disabled(i == 0)
                .on_click(on(|p, a, id, w, cx| p.move_line(a, id, -1, w, cx))),
            )
            .item(
                MenuItem::new(
                    "plot-head-forward",
                    if row {
                        Icon::ChevronDown
                    } else {
                        Icon::ChevronRight
                    },
                    pick(t(cx, k::MOVE_DOWN), t(cx, k::MOVE_RIGHT)),
                )
                .disabled(i + 1 >= n)
                .on_click(on(|p, a, id, w, cx| p.move_line(a, id, 1, w, cx))),
            )
            .separator(&theme)
            .item(
                MenuItem::new(
                    "plot-head-before",
                    if row {
                        Icon::InsertRow
                    } else {
                        Icon::InsertCol
                    },
                    pick(t(cx, k::INSERT_ROW_ABOVE), t(cx, k::INSERT_COLUMN_LEFT)),
                )
                .on_click(on(|p, a, id, w, cx| p.insert_line(a, id, true, w, cx))),
            )
            .item(
                MenuItem::new(
                    "plot-head-after",
                    if row {
                        Icon::InsertRow
                    } else {
                        Icon::InsertCol
                    },
                    pick(t(cx, k::INSERT_ROW_BELOW), t(cx, k::INSERT_COLUMN_RIGHT)),
                )
                .on_click(on(|p, a, id, w, cx| p.insert_line(a, id, false, w, cx))),
            )
            .separator(&theme)
            .item(delete);
        let close = cx.listener(move |p, e: &gpui::MouseDownEvent, _, cx| {
            // The ⋯ toggles it itself.
            if anchor.contains(&e.position) {
                return;
            }
            p.menu = None;
            cx.notify();
        });
        Some(
            overlay::float(
                Place::Rect {
                    rect: anchor,
                    align: Align::Start,
                    gap: 4.0,
                },
                Layer::Popover,
                div()
                    .id("plot-head-menu-float")
                    .occlude()
                    .on_mouse_down_out(close)
                    .child(menu),
            )
            .into_any_element(),
        )
    }
}

fn menu_anchor_id(line: &str) -> SharedString {
    SharedString::from(format!("plot-menu-anchor-{line}"))
}

/// 清空's question: everything typed in the grid goes; rows, columns and
/// size stay.
pub struct ClearDialog {
    planner: gpui::WeakEntity<PlotPlanner>,
    focus: FocusHandle,
}

impl ClearDialog {
    /// The question for `planner`'s 清空 (shown by [`PlotPlanner::ask_clear`]).
    pub fn new(planner: gpui::WeakEntity<PlotPlanner>, cx: &mut Context<Self>) -> ClearDialog {
        ClearDialog {
            planner,
            focus: cx.focus_handle(),
        }
    }
}

impl Focusable for ClearDialog {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for ClearDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity().entity_id();
        // The window is busy with the click or key; close once it is over.
        let close = move |_: &mut Window, cx: &mut App| {
            cx.defer(move |cx| dr_shell::dialogs::hide(cx, me));
        };
        let cancel = close;
        let planner = self.planner.clone();
        div()
            .track_focus(&self.focus)
            .key_context("PlotClearDialog")
            .on_action(move |_: &dr_shell::actions::Dismiss, window, cx| close(window, cx))
            .child(
                dr_ui::components::Dialog::new("plot-clear-dialog", t(cx, k::CLEAR_TITLE))
                    .body(
                        div()
                            .text_color(Theme::of(window, cx).palette.ink(2).solid())
                            .child(t(cx, k::CLEAR_CONFIRM)),
                    )
                    .on_close(close)
                    .action(
                        Button::new("plot-clear-cancel", t(cx, keys::common::CANCEL))
                            .on_click(move |_, window, cx| cancel(window, cx)),
                    )
                    .action(
                        Button::new("plot-clear-confirm", t(cx, k::CLEAR))
                            .danger()
                            .on_click(move |_, window, cx| {
                                planner.update(cx, |p, cx| p.clear(window, cx)).ok();
                                close(window, cx);
                            }),
                    ),
            )
    }
}
