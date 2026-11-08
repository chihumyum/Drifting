//! Tables in a material note (M19's note profile): one embed paragraph in
//! the body, the table's rows, columns and cells in the note's `embeds`
//! map (`loro-schema.md` 「表格和素材嵌入」).
//!
//! The body editor draws the table here ([`crate::embeds::NoteEmbeds`]).
//! Each cell is a small gpui-prose editor that fits its text
//! ([`gpui_prose::EditorOptions::fit_content`]) on its own text source
//! ([`CellSource`]): inline marks, line breaks as U+2028, IME, selection and
//! find as in the body. The 0.1 client's rules (`@tiptap/extension-table`
//! with the note's floating bar):
//!
//! - Tab: the next cell; in the last cell a new row. ⇧Tab: the previous
//!   cell. Enter: a line break in the cell.
//! - ← → at a cell's start or end, ↑ ↓ on its first or last row: the
//!   neighbouring cell; past the table's edge, the text before or after it.
//! - The bar above the focused cell (hidden while typing, back 600 ms after
//!   the last keystroke): 加一行, 加一列, 删除行, 删除列, 删除表格. No header
//!   row: the schema has none (0.1's header cells import as cells).
//! - Equal columns over the text's width, cells top-aligned, hairline rules.
//! - Undo: one history for the note. A cell's typing and the bar's changes
//!   are folded into the body editor's steps, and ⌘Z in a cell undoes there.
//! - Copy and paste ([`clip`]): a grid pasted into a cell fills the cells
//!   from there, adding rows and columns as needed.
//! - Whole cells selected by a drag across them, a shift-click or ⇧ arrows
//!   at a cell's edge ([`select`]): copied, emptied, filled, formatted and
//!   their rows and columns deleted together.

mod cell;
pub mod clip;
mod select;

use std::collections::HashMap;
use std::ops::Range;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use dr_doc::prose::TableWriter;
use dr_model::id::EmbedId;
use dr_model::pos::{PosKey, cmp_pos};
use dr_ui::components::{Button, Layer, Place};
use dr_ui::theme::Theme;
use gpui::{
    AnyElement, App, AppContext, Bounds, Context, Entity, EventEmitter, InteractiveElement,
    IntoElement, KeyDownEvent, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent,
    ParentElement, Pixels, Render, Styled, Subscription, Task, Window, canvas, div, point,
    prelude::FluentBuilder as _, px,
};
use gpui_prose::input::actions::{
    Backspace, Copy, Cut, Delete, DeleteToLineStart, DeleteWordBackward, DeleteWordForward,
    IndentListItem, MoveDown, MoveLeft, MoveRight, MoveUp, Newline, OutdentListItem, Paste, Redo,
    SelectAll, SelectDown, SelectLeft, SelectRight, SelectUp, ToggleBold, ToggleItalic,
    ToggleStrikethrough, ToggleTask, ToggleUnderline, Undo,
};
use gpui_prose::schema::inline;
use gpui_prose::{Book, Chapter, EditorEvent, EditorOptions, ProseDoc, ProseEditor, ProseStyle};
use loro::LoroDoc;

pub use cell::{CELL_BREAK, CellKey, CellSource, TableFeed, cell_line};
use select::{CellRange, Parked};

use crate::embeds::NoteHost;

/// How long after the last keystroke the bar comes back.
pub const BAR_RETURN: Duration = Duration::from_millis(600);

/// A table's row or column: its id and position key.
#[derive(Clone, Debug, PartialEq)]
pub struct TableLine {
    pub id: String,
    pub pos: Option<PosKey>,
}

fn lines_of(m: Option<loro::LoroMap>) -> Vec<TableLine> {
    let mut out = Vec::new();
    if let Some(m) = m {
        m.for_each(|k, v| {
            let pos = match &v {
                loro::ValueOrContainer::Container(loro::Container::Map(e)) => match e.get("pos") {
                    Some(loro::ValueOrContainer::Value(loro::LoroValue::String(s))) => {
                        PosKey::parse(&s).ok()
                    }
                    _ => None,
                },
                _ => None,
            };
            out.push(TableLine {
                id: k.to_string(),
                pos,
            });
        });
    }
    out.sort_by(|a, b| cmp_pos((a.pos.as_ref(), &a.id), (b.pos.as_ref(), &b.id)));
    out
}

fn sub_map(m: &loro::LoroMap, key: &str) -> Option<loro::LoroMap> {
    match m.get(key)? {
        loro::ValueOrContainer::Container(loro::Container::Map(m)) => Some(m),
        _ => None,
    }
}

/// Table `embed`'s columns and rows in order, if it is a table.
pub(crate) fn read_structure(
    doc: &LoroDoc,
    embed: &str,
) -> Option<(Vec<TableLine>, Vec<TableLine>)> {
    let entry = sub_map(&doc.get_map(cell::EMBEDS), embed)?;
    match entry.get("kind") {
        Some(loro::ValueOrContainer::Value(loro::LoroValue::String(k)))
            if k.as_str() == "table" => {}
        _ => return None,
    }
    Some((
        lines_of(sub_map(&entry, "cols")),
        lines_of(sub_map(&entry, "rows")),
    ))
}

/// Every cell's plain text, row by row (`""` for a missing cell).
pub(crate) fn read_cells(doc: &LoroDoc, embed: &str) -> Vec<Vec<String>> {
    read_grid(doc, embed).0
}

/// A cell's text and its inline marks (adjacent runs of one mark joined).
fn cell_content(t: &loro::LoroText) -> (String, Vec<clip::CellMark>) {
    let mut text = String::new();
    let mut marks: Vec<clip::CellMark> = Vec::new();
    let mut at = 0;
    for d in t.to_delta() {
        let loro::TextDelta::Insert { insert, attributes } = d else {
            continue;
        };
        let n = insert.chars().count();
        let mut attrs: Vec<(String, loro::LoroValue)> = attributes
            .into_iter()
            .flatten()
            .filter(|(_, v)| !matches!(v, loro::LoroValue::Null))
            .collect();
        attrs.sort_by(|a, b| a.0.cmp(&b.0));
        for (key, value) in attrs {
            match marks
                .iter_mut()
                .rev()
                .find(|m| m.1 == at && m.2 == key && m.3 == value)
            {
                Some(m) => m.1 = at + n,
                None => marks.push((at, at + n, key, value)),
            }
        }
        text.push_str(&insert);
        at += n;
    }
    marks.sort_by(|a, b| (a.0, a.1, &a.2).cmp(&(b.0, b.1, &b.2)));
    (text, marks)
}

/// Every cell's text and marks, row by row.
pub(crate) fn read_grid(doc: &LoroDoc, embed: &str) -> (Vec<Vec<String>>, clip::GridMarks) {
    let Some((cols, rows)) = read_structure(doc, embed) else {
        return Default::default();
    };
    let mut cells = Vec::with_capacity(rows.len());
    let mut marks = Vec::with_capacity(rows.len());
    for r in &rows {
        let (texts, row_marks): (Vec<String>, Vec<Vec<clip::CellMark>>) = cols
            .iter()
            .map(|c| {
                cell::cell_text(doc, embed, &r.id, &c.id)
                    .map(|t| cell_content(&t))
                    .unwrap_or_default()
            })
            .unzip();
        cells.push(texts);
        marks.push(row_marks);
    }
    (cells, marks)
}

/// Replaces cell (`row`, `col`)'s text and marks: the old formatting goes
/// with the old text. A mark the document does not know is left off.
fn put_cell(
    w: &TableWriter,
    row: &str,
    col: &str,
    text: &str,
    marks: &[clip::CellMark],
) -> dr_doc::Result<()> {
    let t = w.cell(row, col)?;
    let len = t.len_unicode();
    if len > 0 {
        t.delete(0, len)?;
    }
    let text = cell_line(text);
    if text.is_empty() {
        return Ok(());
    }
    t.insert(0, &text)?;
    let n = text.chars().count();
    for (start, end, key, value) in marks {
        let range = (*start).min(n)..(*end).min(n);
        if range.is_empty() || key == gpui_prose::schema::inline::EMBED {
            continue;
        }
        if let Err(e) = t.mark(range, key, value.clone()) {
            log::warn!("dr-editor: a pasted cell's {key} mark: {e}");
        }
    }
    Ok(())
}

/// `n` position keys after `after` and before `before`.
fn keys_between(after: Option<&PosKey>, before: Option<&PosKey>, n: usize) -> Vec<PosKey> {
    let mut out = Vec::with_capacity(n);
    let mut last = after.cloned();
    for _ in 0..n {
        let key = PosKey::between(last.as_ref(), before)
            .or_else(|_| PosKey::between(last.as_ref(), None))
            .unwrap_or_else(|_| PosKey::first());
        last = Some(key.clone());
        out.push(key);
    }
    out
}

/// A new row or column id.
fn line_id() -> String {
    dr_model::id::new_uuid_v7()
}

/// Fills table `w` with `cells` (rows of column texts) and their `marks`,
/// creating every cell.
pub(crate) fn write_grid(
    w: &TableWriter,
    cells: &[Vec<String>],
    marks: &clip::GridMarks,
) -> dr_doc::Result<()> {
    let ncols = cells.iter().map(Vec::len).max().unwrap_or(0).max(1);
    let nrows = cells.len().max(1);
    let cols: Vec<String> = (0..ncols).map(|_| line_id()).collect();
    let rows: Vec<String> = (0..nrows).map(|_| line_id()).collect();
    for (id, pos) in cols.iter().zip(keys_between(None, None, ncols)) {
        w.add_col(id, &pos)?;
    }
    for (id, pos) in rows.iter().zip(keys_between(None, None, nrows)) {
        w.add_row(id, &pos)?;
    }
    for (r, row) in rows.iter().enumerate() {
        for (c, col) in cols.iter().enumerate() {
            let text = cells
                .get(r)
                .and_then(|cells| cells.get(c))
                .map(String::as_str)
                .unwrap_or_default();
            put_cell(w, row, col, text, clip::marks_at(marks, r, c))?;
        }
    }
    Ok(())
}

struct CellView {
    editor: Entity<ProseEditor>,
    items: Arc<AtomicUsize>,
    bounds: Rc<std::cell::Cell<Option<Bounds<Pixels>>>>,
    _events: Subscription,
}

/// What a table tells the note's view.
#[derive(Clone, Debug, PartialEq)]
pub enum TableEvent {
    /// The author changed the table (a cell, a row, a column).
    Edited,
}

/// One table of a note, drawn in its embed paragraph.
pub struct TableView {
    host: Rc<NoteHost>,
    embed: EmbedId,
    feed: Arc<TableFeed>,
    _subscription: Option<loro::Subscription>,
    cols: Vec<TableLine>,
    rows: Vec<TableLine>,
    cells: HashMap<CellKey, CellView>,
    /// The feed's commit count the cells last caught up with.
    seen: u64,
    style: Option<ProseStyle>,
    /// The cell whose typing the history's last step holds.
    last_edited: Option<CellKey>,
    typed_at: Option<Instant>,
    _bar_timer: Option<Task<()>>,
    /// Where the table was drawn (the bar goes above it).
    bounds: Rc<std::cell::Cell<Option<Bounds<Pixels>>>>,
    pub(crate) selected: bool,
    /// Whole cells selected ([`select`]).
    cell_sel: Option<CellRange>,
    /// The cell a press went down in, while the button is down.
    drag_from: Option<CellKey>,
    /// The focused cell's caret while cells are selected.
    parked: Option<Parked>,
}

impl EventEmitter<TableEvent> for TableView {}

impl TableView {
    /// Opens table `embed` of the note; `None` if it is not a table.
    pub(crate) fn open(host: Rc<NoteHost>, embed: EmbedId) -> Option<TableView> {
        let feed = Arc::new(TableFeed::default());
        let (subscription, structure) = {
            let (feed, embed) = (feed.clone(), embed.to_string());
            host.handle
                .read(move |doc| (feed.subscribe(doc, &embed), read_structure(doc, &embed)))
                .ok()?
        };
        let (cols, rows) = structure?;
        Some(TableView {
            host,
            embed,
            seen: feed.commits(),
            feed,
            _subscription: Some(subscription),
            cols,
            rows,
            cells: HashMap::new(),
            style: None,
            last_edited: None,
            typed_at: None,
            _bar_timer: None,
            bounds: Rc::default(),
            selected: false,
            cell_sel: None,
            drag_from: None,
            parked: None,
        })
    }

    pub fn embed(&self) -> &EmbedId {
        &self.embed
    }

    pub fn rows(&self) -> &[TableLine] {
        &self.rows
    }

    pub fn cols(&self) -> &[TableLine] {
        &self.cols
    }

    /// The editor of cell (`row`, `col`) (by index), once drawn.
    pub fn cell_editor(&self, row: usize, col: usize) -> Option<&Entity<ProseEditor>> {
        let key = (
            self.rows.get(row)?.id.clone(),
            self.cols.get(col)?.id.clone(),
        );
        self.cells.get(&key).map(|c| &c.editor)
    }

    /// Every cell's text as the editors hold it, row by row.
    pub fn texts(&self, cx: &App) -> Vec<Vec<String>> {
        self.rows
            .iter()
            .map(|r| {
                self.cols
                    .iter()
                    .map(|c| {
                        self.cells
                            .get(&(r.id.clone(), c.id.clone()))
                            .map(|v| v.editor.read(cx).book().chapters[0].doc.plain_text())
                            .map(|t| t.trim_end_matches('\n').to_owned())
                            .unwrap_or_default()
                    })
                    .collect()
            })
            .collect()
    }

    fn cell_style(&self) -> ProseStyle {
        let body = self.host.style.borrow();
        ProseStyle {
            body_size: px(14.5),
            body_line_height: 1.6,
            paragraph_spacing: 0.,
            heading_space_above: 0.,
            gutter: px(9.),
            max_width: px(4000.),
            first_line_indent: 0.,
            justify: false,
            typewriter: None,
            background: gpui::transparent_black(),
            ..body.clone()
        }
    }

    fn new_cell(&self, key: &CellKey, window: &mut Window, cx: &mut Context<Self>) -> CellView {
        let source = CellSource::new(
            &self.host.doc_id,
            self.embed.clone(),
            key,
            self.host.session.clone(),
            self.host.handle.clone(),
            self.feed.clone(),
        );
        let items = source.host_items();
        let book = Book::new(vec![Chapter {
            title: "".into(),
            doc: ProseDoc::open(Box::new(source)),
        }]);
        let style = self.cell_style();
        let extension = self.host.extension.clone();
        let editor = cx.new(|cx| {
            let mut e = ProseEditor::with_options(
                book,
                style,
                EditorOptions {
                    fit_content: true,
                    ..EditorOptions::default()
                },
                window,
                cx,
            );
            e.set_extension(extension);
            crate::highlight::decorate(&mut e, 0, cx);
            e
        });
        let watched = key.clone();
        let events = cx.subscribe(&editor, move |this, _, event: &EditorEvent, cx| {
            this.on_cell(&watched, event, cx)
        });
        let typed = cx.subscribe(&editor, |this, _, _: &gpui_prose::AuthorTyped, cx| {
            this.host.typed(cx)
        });
        let events = Subscription::join(events, typed);
        CellView {
            editor,
            items,
            bounds: Rc::default(),
            _events: events,
        }
    }

    fn on_cell(&mut self, key: &CellKey, event: &EditorEvent, cx: &mut Context<Self>) {
        match event {
            EditorEvent::Edited { .. } => {
                if let Some(view) = self.cells.get(key) {
                    view.editor
                        .update(cx, |e, cx| crate::highlight::decorate(e, 0, cx));
                }
                let items = self
                    .cells
                    .get(key)
                    .map_or(0, |c| c.items.swap(0, Ordering::Relaxed));
                let new_step = self.last_edited.as_ref() != Some(key);
                self.fold(items, new_step, cx);
                self.last_edited = Some(key.clone());
                self.typed_at = Some(Instant::now());
                self._bar_timer = Some(cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(BAR_RETURN).await;
                    let _ = this.update(cx, |_, cx| cx.notify());
                }));
                self.host.edited(cx);
                if !self.typed_over(key, cx) {
                    self.end_cell_selection(cx);
                }
                cx.emit(TableEvent::Edited);
                cx.notify();
            }
            EditorEvent::SelectionChanged => {
                self.cell_selection_moved(key, cx);
                cx.notify()
            }
            EditorEvent::AnchorsChanged { .. } => {}
        }
    }

    /// Folds `items` pushed by the table's own commits into the body
    /// editor's history.
    fn fold(&self, items: usize, new_step: bool, cx: &mut App) {
        if items == 0 {
            return;
        }
        let chapter = self.host.chapter;
        if let Some(body) = self.host.body.upgrade() {
            body.update(cx, |e, _| e.record_host_items(chapter, items, new_step));
        }
    }

    /// Catches the cells up: the structure if it changed, new and gone
    /// cells, events queued for each, a new style.
    pub(crate) fn sync(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.feed.take_structure() {
            let embed = self.embed.to_string();
            if let Ok(Some((cols, rows))) = self
                .host
                .handle
                .read(move |doc| read_structure(doc, &embed))
            {
                self.cols = cols;
                self.rows = rows;
            }
        }
        let style = self.cell_style();
        let restyle = self.style.as_ref() != Some(&style);
        let keys: Vec<CellKey> = self
            .rows
            .iter()
            .flat_map(|r| self.cols.iter().map(|c| (r.id.clone(), c.id.clone())))
            .collect();
        self.cells.retain(|k, _| keys.contains(k));
        for key in &keys {
            if !self.cells.contains_key(key) {
                let view = self.new_cell(key, window, cx);
                self.cells.insert(key.clone(), view);
            }
        }
        let commits = self.feed.commits();
        if commits != self.seen || restyle {
            self.seen = commits;
            for view in self.cells.values() {
                view.editor.update(cx, |e, cx| {
                    e.refresh_chapter(0, cx);
                    if restyle {
                        e.set_style(style.clone(), cx);
                    }
                    crate::highlight::decorate(e, 0, cx);
                });
            }
            // The table's own writes move the parked caret (its text was
            // emptied or filled): the cells stay selected.
            if let Some(p) = self.parked.as_mut() {
                match self.cells.get(&p.key) {
                    Some(v) => {
                        let e = v.editor.read(cx);
                        p.sel = e.selection();
                        p.len = e.book().chapters[0].doc.max_cursor();
                    }
                    None => {
                        self.cell_sel = None;
                        self.parked = None;
                    }
                }
            }
        }
        if self.cell_sel.is_some() && self.selected_cells().is_none() {
            // A row or column of the selection went.
            self.cell_sel = None;
            self.parked = None;
        }
        self.style = Some(style);
    }

    /// Catches the cells up with commits made elsewhere (an undo, another
    /// device, an Agent).
    pub(crate) fn refresh(&mut self, cx: &mut Context<Self>) {
        cx.notify();
    }

    /// The cell editor that has the focus, if any.
    pub fn focused_editor(&self, window: &Window, cx: &App) -> Option<Entity<ProseEditor>> {
        let key = self.focused(window, cx)?;
        self.cells.get(&key).map(|c| c.editor.clone())
    }

    fn focused(&self, window: &Window, cx: &App) -> Option<CellKey> {
        self.cells
            .iter()
            .find(|(_, v)| gpui::Focusable::focus_handle(v.editor.read(cx), cx).is_focused(window))
            .map(|(k, _)| k.clone())
    }

    fn index_of(&self, key: &CellKey) -> Option<(usize, usize)> {
        let r = self.rows.iter().position(|l| l.id == key.0)?;
        let c = self.cols.iter().position(|l| l.id == key.1)?;
        Some((r, c))
    }

    fn key_at(&self, row: usize, col: usize) -> Option<CellKey> {
        Some((
            self.rows.get(row)?.id.clone(),
            self.cols.get(col)?.id.clone(),
        ))
    }

    /// Puts the caret in cell (`row`, `col`): at its start or its end.
    pub fn focus_cell(
        &mut self,
        row: usize,
        col: usize,
        at_end: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.sync(window, cx);
        let Some(view) = self.key_at(row, col).and_then(|k| self.cells.get(&k)) else {
            return;
        };
        view.editor.update(cx, |e, cx| {
            let at = if at_end {
                e.book().chapters[0].doc.max_cursor()
            } else {
                0
            };
            e.focus_at(0, at, window, cx);
        });
        cx.notify();
    }

    /// The caret back in the text: after the table (`down`) or before it.
    fn leave(&mut self, down: bool, window: &mut Window, cx: &mut Context<Self>) {
        let (chapter, embed) = (self.host.chapter, self.embed.to_string());
        let Some(body) = self.host.body.upgrade() else {
            return;
        };
        body.update(cx, |e, cx| {
            let Some(line) = e.embed_line(chapter, &embed) else {
                return;
            };
            let Some((_, start)) = e.embed_at(chapter, line) else {
                return;
            };
            let visible = e.book().chapters[chapter].doc.visible_lines();
            if down && line + 1 < visible {
                e.focus_at(chapter, start + 2, window, cx);
            } else if !down && line > 0 {
                e.focus_at(chapter, start - 1, window, cx);
            } else {
                e.select_embed(chapter, line, window, cx);
            }
        });
    }

    fn step(&mut self, forward: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some((r, c)) = self.focused(window, cx).and_then(|k| self.index_of(&k)) else {
            return;
        };
        let ncols = self.cols.len();
        let flat = r * ncols + c;
        if forward {
            if flat + 1 < self.rows.len() * ncols {
                let next = flat + 1;
                self.focus_cell(next / ncols, next % ncols, false, window, cx);
            } else {
                // Tab in the last cell: a new row.
                self.add_row(r, window, cx);
                self.focus_cell(r + 1, 0, false, window, cx);
            }
        } else if flat > 0 {
            let prev = flat - 1;
            self.focus_cell(prev / ncols, prev % ncols, true, window, cx);
        }
    }

    /// ← → ↑ ↓ at a cell's edge: the neighbouring cell, or out of the
    /// table. Returns whether the key was taken.
    fn arrow(&mut self, dir: Dir, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.collapse(dir, window, cx) {
            return true;
        }
        let Some(key) = self.focused(window, cx) else {
            return false;
        };
        let Some((r, c)) = self.index_of(&key) else {
            return false;
        };
        let view = &self.cells[&key];
        let (at_start, at_end, first_row, last_row) = {
            let e = view.editor.read(cx);
            let sel = e.selection();
            let max = e.book().chapters[0].doc.max_cursor();
            let caret = e.caret_bounds();
            let text = e.range_bounds(0, 0..max.max(1));
            let line = px(14.5 * 1.6 / 2.);
            let (first, last) = match (caret, text) {
                (Some(caret), Some(text)) => (
                    caret.top() - text.top() < line,
                    text.bottom() - caret.bottom() < line,
                ),
                _ => (true, true),
            };
            (
                sel.is_empty() && sel.head == 0,
                sel.is_empty() && sel.head >= max,
                sel.is_empty() && first,
                sel.is_empty() && last,
            )
        };
        let (rows, cols) = (self.rows.len(), self.cols.len());
        match dir {
            Dir::Left if at_start => {
                if c > 0 {
                    self.focus_cell(r, c - 1, true, window, cx);
                } else if r > 0 {
                    self.focus_cell(r - 1, cols - 1, true, window, cx);
                } else {
                    self.leave(false, window, cx);
                }
                true
            }
            Dir::Right if at_end => {
                if c + 1 < cols {
                    self.focus_cell(r, c + 1, false, window, cx);
                } else if r + 1 < rows {
                    self.focus_cell(r + 1, 0, false, window, cx);
                } else {
                    self.leave(true, window, cx);
                }
                true
            }
            Dir::Up if first_row => {
                if r > 0 {
                    self.focus_cell(r - 1, c, true, window, cx);
                } else {
                    self.leave(false, window, cx);
                }
                true
            }
            Dir::Down if last_row => {
                if r + 1 < rows {
                    self.focus_cell(r + 1, c, false, window, cx);
                } else {
                    self.leave(true, window, cx);
                }
                true
            }
            _ => false,
        }
    }

    /// One commit on the table's structure, folded into the history as its
    /// own step.
    fn write<R: Send + 'static>(
        &mut self,
        cx: &mut Context<Self>,
        f: impl FnOnce(&TableWriter) -> dr_doc::Result<R> + Send + 'static,
    ) -> Option<R> {
        self.write_step(cx, true, f)
    }

    /// [`TableView::write`], as a step of its own or joined to the last.
    fn write_step<R: Send + 'static>(
        &mut self,
        cx: &mut Context<Self>,
        new_step: bool,
        f: impl FnOnce(&TableWriter) -> dr_doc::Result<R> + Send + 'static,
    ) -> Option<R> {
        let before = self.feed.user_commits();
        let embed = self.embed.clone();
        let written = self.host.session.edit(move |txn| {
            let w = txn.table(&embed)?;
            f(&w)
        });
        let pushed = (self.feed.user_commits() - before) as usize;
        self.fold(pushed, new_step, cx);
        self.last_edited = None;
        self.host.edited(cx);
        cx.emit(TableEvent::Edited);
        cx.notify();
        match written {
            Ok(r) => Some(r),
            Err(e) => {
                log::error!("dr-editor: table edit failed: {e}");
                None
            }
        }
    }

    /// 加一行: a row after row `row`.
    pub fn add_row(&mut self, row: usize, window: &mut Window, cx: &mut Context<Self>) {
        let after = self.rows.get(row).and_then(|l| l.pos.clone());
        let before = self.rows.get(row + 1).and_then(|l| l.pos.clone());
        let cols: Vec<String> = self.cols.iter().map(|c| c.id.clone()).collect();
        self.write(cx, move |w| {
            let id = line_id();
            let pos = keys_between(after.as_ref(), before.as_ref(), 1).remove(0);
            w.add_row(&id, &pos)?;
            for col in &cols {
                w.cell(&id, col)?;
            }
            Ok(())
        });
        self.sync(window, cx);
    }

    /// 加一列: a column after column `col`.
    pub fn add_col(&mut self, col: usize, window: &mut Window, cx: &mut Context<Self>) {
        let after = self.cols.get(col).and_then(|l| l.pos.clone());
        let before = self.cols.get(col + 1).and_then(|l| l.pos.clone());
        let rows: Vec<String> = self.rows.iter().map(|r| r.id.clone()).collect();
        self.write(cx, move |w| {
            let id = line_id();
            let pos = keys_between(after.as_ref(), before.as_ref(), 1).remove(0);
            w.add_col(&id, &pos)?;
            for row in &rows {
                w.cell(row, &id)?;
            }
            Ok(())
        });
        self.sync(window, cx);
    }

    /// 删除行: row `row` (the last row takes the table with it).
    pub fn delete_row(&mut self, row: usize, window: &mut Window, cx: &mut Context<Self>) {
        self.delete_rows(row..row + 1, window, cx);
    }

    /// 删除行 with cells selected: their rows, as one step (all of them
    /// take the table with them).
    pub fn delete_rows(&mut self, rows: Range<usize>, window: &mut Window, cx: &mut Context<Self>) {
        let rows = rows.start.min(self.rows.len())..rows.end.min(self.rows.len());
        if rows.is_empty() {
            return;
        }
        if rows.len() >= self.rows.len() {
            self.delete_table(window, cx);
            return;
        }
        let ids: Vec<String> = self.rows[rows.clone()]
            .iter()
            .map(|l| l.id.clone())
            .collect();
        let col = self
            .focused(window, cx)
            .and_then(|k| self.index_of(&k))
            .map_or(0, |(_, c)| c);
        self.end_cell_selection(cx);
        self.write(cx, move |w| {
            for id in &ids {
                w.remove_row(id)?;
            }
            Ok(())
        });
        self.sync(window, cx);
        let row = rows.start.min(self.rows.len().saturating_sub(1));
        self.focus_cell(
            row,
            col.min(self.cols.len().saturating_sub(1)),
            false,
            window,
            cx,
        );
    }

    /// 删除列: column `col` (the last column takes the table with it).
    pub fn delete_col(&mut self, col: usize, window: &mut Window, cx: &mut Context<Self>) {
        self.delete_cols(col..col + 1, window, cx);
    }

    /// 删除列 with cells selected: their columns, as one step.
    pub fn delete_cols(&mut self, cols: Range<usize>, window: &mut Window, cx: &mut Context<Self>) {
        let cols = cols.start.min(self.cols.len())..cols.end.min(self.cols.len());
        if cols.is_empty() {
            return;
        }
        if cols.len() >= self.cols.len() {
            self.delete_table(window, cx);
            return;
        }
        let ids: Vec<String> = self.cols[cols.clone()]
            .iter()
            .map(|l| l.id.clone())
            .collect();
        let row = self
            .focused(window, cx)
            .and_then(|k| self.index_of(&k))
            .map_or(0, |(r, _)| r);
        self.end_cell_selection(cx);
        self.write(cx, move |w| {
            for id in &ids {
                w.remove_col(id)?;
            }
            Ok(())
        });
        self.sync(window, cx);
        let col = cols.start.min(self.cols.len().saturating_sub(1));
        self.focus_cell(
            row.min(self.rows.len().saturating_sub(1)),
            col,
            false,
            window,
            cx,
        );
    }

    /// 删除表格: the embed paragraph goes (its entry stays for undo).
    pub fn delete_table(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (chapter, embed) = (self.host.chapter, self.embed.to_string());
        if let Some(body) = self.host.body.upgrade() {
            body.update(cx, |e, cx| {
                if let Some(line) = e.embed_line(chapter, &embed) {
                    e.select_embed(chapter, line, window, cx);
                    e.press_backspace(window, cx);
                }
            });
        }
    }

    /// Pastes `grid` from cell (`row`, `col`) on, adding rows and columns
    /// as needed; one step.
    pub fn paste_grid(
        &mut self,
        row: usize,
        col: usize,
        grid: Vec<Vec<String>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.paste_marked(row, col, grid, Vec::new(), window, cx);
    }

    /// [`TableView::paste_grid`] with each cell's `marks` (a table Drifting
    /// copied): pasted cells take the pasted text's formatting.
    pub fn paste_marked(
        &mut self,
        row: usize,
        col: usize,
        grid: Vec<Vec<String>>,
        marks: clip::GridMarks,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let need_rows = (row + grid.len()).saturating_sub(self.rows.len());
        let width = grid.iter().map(Vec::len).max().unwrap_or(0);
        let need_cols = (col + width).saturating_sub(self.cols.len());
        let (rows, cols) = (self.rows.clone(), self.cols.clone());
        self.write(cx, move |w| {
            let mut row_ids: Vec<String> = rows.iter().map(|l| l.id.clone()).collect();
            let mut col_ids: Vec<String> = cols.iter().map(|l| l.id.clone()).collect();
            for pos in keys_between(cols.last().and_then(|l| l.pos.as_ref()), None, need_cols) {
                let id = line_id();
                w.add_col(&id, &pos)?;
                col_ids.push(id);
            }
            for pos in keys_between(rows.last().and_then(|l| l.pos.as_ref()), None, need_rows) {
                let id = line_id();
                w.add_row(&id, &pos)?;
                row_ids.push(id);
            }
            for r in &row_ids {
                for c in &col_ids {
                    w.cell(r, c)?;
                }
            }
            for (dr, line) in grid.iter().enumerate() {
                for (dc, text) in line.iter().enumerate() {
                    put_cell(
                        w,
                        &row_ids[row + dr],
                        &col_ids[col + dc],
                        text,
                        clip::marks_at(&marks, dr, dc),
                    )?;
                }
            }
            Ok(())
        });
        self.sync(window, cx);
    }

    fn on_paste(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(item) = cx.read_from_clipboard() else {
            return false;
        };
        if self.paste_cells(&item, window, cx) {
            return true;
        }
        let grid = clip::table_from_clipboard(&item).or_else(|| {
            item.text()
                .and_then(|t| clip::parse_grid(&t))
                .filter(|g| g.len() > 1 || g.first().is_some_and(|r| r.len() > 1))
        });
        let Some(grid) = grid else {
            return false;
        };
        let Some((r, c)) = self.focused(window, cx).and_then(|k| self.index_of(&k)) else {
            return false;
        };
        self.paste_marked(r, c, grid, clip::marks_from_clipboard(&item), window, cx);
        true
    }

    fn history(&mut self, redo: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.end_cell_selection(cx);
        let chapter = self.host.chapter;
        if let Some(body) = self.host.body.upgrade() {
            body.update(cx, |e, cx| {
                if redo {
                    e.redo_in(chapter, window, cx);
                } else {
                    e.undo_in(chapter, window, cx);
                }
            });
        }
        self.last_edited = None;
        self.sync(window, cx);
        cx.notify();
    }

    fn bar(
        &self,
        key: &CellKey,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        if self.typed_at.is_some_and(|at| at.elapsed() < BAR_RETURN) {
            return None;
        }
        let (r, c) = self.index_of(key)?;
        let bounds = self.cells.get(key)?.bounds.get()?;
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let this = cx.entity();
        let button = |id: &'static str, label: &'static str, f: fn(&mut TableView, usize, usize, &mut Window, &mut Context<TableView>)| {
            let this = this.clone();
            Button::new(id, label)
                .text()
                .small()
                .on_click(move |_, window, cx| this.update(cx, |t, cx| f(t, r, c, window, cx)))
        };
        let row = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(2.))
            .p(px(4.))
            .child(button(
                "dr-editor-table-add-row",
                "加一行",
                |t, r, c, w, cx| {
                    let (rows, _) = t.bar_span(r, c);
                    t.end_cell_selection(cx);
                    t.add_row(rows.end - 1, w, cx);
                    t.focus_cell(rows.end, 0, false, w, cx);
                },
            ))
            .child(button(
                "dr-editor-table-add-col",
                "加一列",
                |t, r, c, w, cx| {
                    let (_, cols) = t.bar_span(r, c);
                    t.end_cell_selection(cx);
                    t.add_col(cols.end - 1, w, cx);
                    t.focus_cell(r, cols.end, false, w, cx);
                },
            ))
            .child(button(
                "dr-editor-table-delete-row",
                "删除行",
                |t, r, c, w, cx| {
                    let (rows, _) = t.bar_span(r, c);
                    t.delete_rows(rows, w, cx)
                },
            ))
            .child(button(
                "dr-editor-table-delete-col",
                "删除列",
                |t, r, c, w, cx| {
                    let (_, cols) = t.bar_span(r, c);
                    t.delete_cols(cols, w, cx)
                },
            ))
            .child(
                Button::new("dr-editor-table-delete", "删除表格")
                    .text()
                    .small()
                    .danger()
                    .on_click({
                        let this = this.clone();
                        move |_, window, cx| this.update(cx, |t, cx| t.delete_table(window, cx))
                    }),
            );
        let bar = dr_ui::glass::surface(
            dr_ui::glass::Ground::flat(p.desk),
            div()
                .id("dr-editor-table-bar")
                .relative()
                .rounded(px(dr_ui::tokens::radius::SHEET))
                .shadow(dr_ui::components::menu::float_shadow(p))
                .occlude()
                .child(dr_ui::components::menu::slab_edge(
                    p,
                    dr_ui::tokens::radius::SHEET,
                ))
                .child(row),
        );
        // Above the table (never over a cell), 16 px left of the cell;
        // below the table when there is no room above.
        let table = self.bounds.get().unwrap_or(bounds);
        let height = px(38.);
        let above = table.top() - px(8.) - height;
        let y = if above >= px(dr_ui::components::overlay::MARGIN) {
            above
        } else {
            table.bottom() + px(8.)
        };
        Some(
            dr_ui::components::float(
                Place::Point(point(bounds.left() - px(16.), y)),
                Layer::Popover,
                bar,
            )
            .into_any_element(),
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Dir {
    Left,
    Right,
    Up,
    Down,
}

impl Render for TableView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync(window, cx);
        let style = self.style.clone().unwrap_or_default();
        let rule = style.text.opacity(0.14);
        let focused = self.focused(window, cx);
        if focused.is_none() && self.cell_sel.is_some() {
            // The author went elsewhere.
            self.cell_sel = None;
            self.parked = None;
        }
        let hide_caret = self.hides_caret();
        let mut grid = div()
            .w_full()
            .border_t_1()
            .border_l_1()
            .border_color(rule)
            .flex()
            .flex_col();
        for row in &self.rows {
            let mut line = div().w_full().flex().flex_row();
            for col in &self.cols {
                let key = (row.id.clone(), col.id.clone());
                let Some(view) = self.cells.get(&key) else {
                    continue;
                };
                let bounds = view.bounds.clone();
                let me = cx.entity().downgrade();
                let editor = view.editor.clone();
                let washed = self.is_cell_selected(&key);
                let pressed = {
                    let (this, key) = (cx.entity().downgrade(), key.clone());
                    move |event: &MouseDownEvent, window: &mut Window, cx: &mut App| {
                        if event.button != MouseButton::Left {
                            return;
                        }
                        let taken = this
                            .update(cx, |t, cx| t.press(&key, event.modifiers.shift, window, cx))
                            .unwrap_or(false);
                        if taken {
                            cx.stop_propagation();
                        }
                    }
                };
                let text = if hide_caret {
                    // The caret stays in its cell, unseen.
                    div()
                        .w_full()
                        .relative()
                        .child(view.editor.clone())
                        .into_any_element()
                } else {
                    ProseEditor::element(&view.editor, cx).into_any_element()
                };
                line = line.child(
                    div()
                        .flex_1()
                        .min_w(px(42.))
                        .py(px(6.))
                        .border_r_1()
                        .border_b_1()
                        .border_color(rule)
                        .relative()
                        .capture_any_mouse_down(pressed)
                        .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                            // The cell's padding: the caret at its end.
                            if !gpui::Focusable::focus_handle(editor.read(cx), cx)
                                .is_focused(window)
                            {
                                editor.update(cx, |e, cx| {
                                    let end = e.book().chapters[0].doc.max_cursor();
                                    e.focus_at(0, end, window, cx);
                                });
                            }
                        })
                        // Under the text and the rules, as a text selection is.
                        .when(washed, |cell| cell.bg(style.selection))
                        .child(text)
                        .child(
                            canvas(
                                move |b, _, cx| {
                                    // The bar is placed from these: draw again
                                    // once they settle.
                                    if bounds.replace(Some(b)) != Some(b) {
                                        let _ = me.update(cx, |_, cx| cx.notify());
                                    }
                                },
                                |_, _, _, _| {},
                            )
                            .absolute()
                            .top_0()
                            .left_0()
                            .size_full(),
                        ),
                );
            }
            grid = grid.child(line);
        }
        let this = cx.entity();
        let arrow = |dir: Dir| {
            let this = this.clone();
            move |window: &mut Window, cx: &mut App| {
                this.update(cx, |t, cx| t.arrow(dir, window, cx))
            }
        };
        let (left, right, up, down) = (
            arrow(Dir::Left),
            arrow(Dir::Right),
            arrow(Dir::Up),
            arrow(Dir::Down),
        );
        let bar = focused.and_then(|key| self.bar(&key, window, cx));
        div()
            .id(gpui::SharedString::from(format!(
                "dr-editor-table-{}",
                self.embed
            )))
            .key_context("DriftingTable")
            .relative()
            .w_full()
            .my(px(4.))
            .capture_action(cx.listener(|t, _: &Undo, window, cx| {
                t.history(false, window, cx);
                cx.stop_propagation();
            }))
            .capture_action(cx.listener(|t, _: &Redo, window, cx| {
                t.history(true, window, cx);
                cx.stop_propagation();
            }))
            .capture_action(cx.listener(|t, _: &IndentListItem, window, cx| {
                t.step(true, window, cx);
                cx.stop_propagation();
            }))
            .capture_action(cx.listener(|t, _: &OutdentListItem, window, cx| {
                t.step(false, window, cx);
                cx.stop_propagation();
            }))
            .capture_action(|_: &ToggleTask, _, cx| cx.stop_propagation())
            .capture_action(cx.listener(|t, _: &Paste, window, cx| {
                if t.on_paste(window, cx) {
                    cx.stop_propagation();
                }
            }))
            .capture_action(move |_: &MoveLeft, window, cx| {
                if left(window, cx) {
                    cx.stop_propagation();
                }
            })
            .capture_action(move |_: &MoveRight, window, cx| {
                if right(window, cx) {
                    cx.stop_propagation();
                }
            })
            .capture_action(move |_: &MoveUp, window, cx| {
                if up(window, cx) {
                    cx.stop_propagation();
                }
            })
            .capture_action(move |_: &MoveDown, window, cx| {
                if down(window, cx) {
                    cx.stop_propagation();
                }
            })
            .capture_action(cx.listener(|t, _: &SelectLeft, window, cx| {
                if t.extend(Dir::Left, window, cx) {
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|t, _: &SelectRight, window, cx| {
                if t.extend(Dir::Right, window, cx) {
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|t, _: &SelectUp, window, cx| {
                if t.extend(Dir::Up, window, cx) {
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|t, _: &SelectDown, window, cx| {
                if t.extend(Dir::Down, window, cx) {
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|t, _: &Newline, _, cx| {
                if t.newline(cx) {
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|t, _: &SelectAll, window, cx| {
                if t.select_all(window, cx) {
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|t, _: &Copy, _, cx| {
                if t.copy_cells(false, cx) {
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|t, _: &Cut, _, cx| {
                if t.copy_cells(true, cx) {
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|t, _: &Backspace, _, cx| {
                if t.clear_cells(cx) {
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|t, _: &Delete, _, cx| {
                if t.clear_cells(cx) {
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|t, _: &DeleteWordBackward, _, cx| {
                if t.clear_cells(cx) {
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|t, _: &DeleteWordForward, _, cx| {
                if t.clear_cells(cx) {
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|t, _: &DeleteToLineStart, _, cx| {
                if t.clear_cells(cx) {
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|t, _: &ToggleBold, _, cx| {
                if t.format_cells(inline::BOLD, true.into(), cx) {
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|t, _: &ToggleItalic, _, cx| {
                if t.format_cells(inline::ITALIC, true.into(), cx) {
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|t, _: &ToggleUnderline, _, cx| {
                if t.format_cells(inline::UNDERLINE, true.into(), cx) {
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|t, _: &ToggleStrikethrough, _, cx| {
                if t.format_cells(inline::STRIKE, true.into(), cx) {
                    cx.stop_propagation();
                }
            }))
            .capture_action(
                cx.listener(|t, _: &crate::highlight::ToggleHighlight, _, cx| {
                    if t.format_cells(crate::highlight::KEY, crate::highlight::value(), cx) {
                        cx.stop_propagation();
                    }
                }),
            )
            .capture_key_down(cx.listener(|t, e: &KeyDownEvent, _, cx| {
                if e.keystroke.key == "escape" && t.escape(cx) {
                    cx.stop_propagation();
                }
            }))
            .on_mouse_move(cx.listener(|t, e: &MouseMoveEvent, window, cx| {
                if e.pressed_button == Some(MouseButton::Left) {
                    t.drag_over(e.position, window, cx);
                }
            }))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|t, _: &MouseUpEvent, _, _| t.release()),
            )
            .on_mouse_up_out(
                MouseButton::Left,
                cx.listener(|t, _: &MouseUpEvent, _, _| t.release()),
            )
            .child(grid)
            .child({
                let bounds = self.bounds.clone();
                let me = cx.entity().downgrade();
                canvas(
                    move |b, _, cx| {
                        if bounds.replace(Some(b)) != Some(b) {
                            let _ = me.update(cx, |_, cx| cx.notify());
                        }
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .top_0()
                .left_0()
                .size_full()
            })
            .when(self.selected, |root| {
                root.child(
                    div()
                        .absolute()
                        .top(px(-3.))
                        .left(px(-3.))
                        .right(px(-3.))
                        .bottom(px(-3.))
                        .rounded(px(4.))
                        .border_2()
                        .border_color(style.cursor.opacity(0.5))
                        .bg(style.selection.opacity(0.35)),
                )
            })
            .children(bar)
    }
}
