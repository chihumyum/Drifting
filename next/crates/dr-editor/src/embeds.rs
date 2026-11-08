//! A material note's embeds (M19's note profile): tables and materials
//! drawn in their embed paragraphs through gpui-prose's
//! [`EmbedViews`](gpui_prose::EmbedViews).
//!
//! [`NoteHost`] is what they share with the note's view: the workspace, the
//! note's session (their commits land on the note's one undo stack), the
//! body editor (they fold their commits into its history and hand the
//! caret back to it) and the body's look. [`NoteEmbeds`] keeps one view per
//! embed: a [`TableView`] or a [`MaterialBlock`], made when first drawn.
//!
//! Inserting embeds ([`insert_table`], [`insert_material`]): one commit
//! that puts the embed paragraph before an empty paragraph (the caret's own
//! when it is empty, else a new one after it), so text can always follow.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use dr_doc::prose::{BorrowedProse, EmbedKind, EmbedView};
use dr_model::id::{EmbedId, MaterialId};
use dr_store::DocHandle;
use dr_workspace::{ProseSession, Workspace};
use gpui::{AnyElement, App, AppContext, Entity, IntoElement, WeakEntity, Window};
use gpui_prose::{EmbedViews, ProseEditor, ProseExtension, ProseStyle};

use crate::material::MaterialBlock;
use crate::table::TableView;

/// What a note's embeds tell its view.
#[derive(Clone, Debug, PartialEq)]
pub enum NoteEvent {
    /// The author changed an embed (a cell, a row).
    Edited,
    /// Open material `id` (an embed's click).
    OpenMaterial(String),
    /// The author typed in a cell ([`gpui_prose::AuthorTyped`]).
    Typed,
}

/// How embeds report to the note's view.
pub(crate) type Notify = Rc<dyn Fn(NoteEvent, &mut App)>;

/// What a note's embeds share with its view.
pub struct NoteHost {
    pub(crate) ws: Workspace,
    pub(crate) book: String,
    pub(crate) doc_id: String,
    pub(crate) session: Arc<ProseSession>,
    pub(crate) handle: DocHandle,
    pub(crate) body: WeakEntity<ProseEditor>,
    pub(crate) chapter: usize,
    /// The body's look (the cells take its colours and font).
    pub(crate) style: RefCell<ProseStyle>,
    pub(crate) extension: Rc<dyn ProseExtension>,
    pub(crate) notify: Notify,
}

impl NoteHost {
    pub(crate) fn edited(&self, cx: &mut App) {
        (self.notify)(NoteEvent::Edited, cx);
    }

    pub(crate) fn typed(&self, cx: &mut App) {
        (self.notify)(NoteEvent::Typed, cx);
    }

    pub(crate) fn open_material(&self, id: &str, cx: &mut App) {
        (self.notify)(NoteEvent::OpenMaterial(id.to_owned()), cx);
    }

    /// The paragraph and first offset of embed `id` in the body.
    pub(crate) fn embed_line(&self, id: &str, cx: &App) -> Option<(usize, usize)> {
        let body = self.body.upgrade()?;
        let e = body.read(cx);
        let line = e.embed_line(self.chapter, id)?;
        Some((line, e.embed_at(self.chapter, line)?.1))
    }
}

#[derive(Clone, Debug, PartialEq)]
enum Kind {
    Table,
    Material(Option<MaterialId>),
}

/// The views of one note's embeds.
pub struct NoteEmbeds {
    host: Rc<NoteHost>,
    kinds: RefCell<HashMap<String, Kind>>,
    tables: RefCell<HashMap<String, Entity<TableView>>>,
    materials: RefCell<HashMap<String, Entity<MaterialBlock>>>,
}

impl NoteEmbeds {
    pub(crate) fn new(host: Rc<NoteHost>) -> NoteEmbeds {
        NoteEmbeds {
            host,
            kinds: RefCell::default(),
            tables: RefCell::default(),
            materials: RefCell::default(),
        }
    }

    pub fn host(&self) -> &Rc<NoteHost> {
        &self.host
    }

    fn kind(&self, id: &str) -> Option<Kind> {
        if let Some(kind) = self.kinds.borrow().get(id) {
            return Some(kind.clone());
        }
        let (doc_id, embed) = (
            dr_model::DocId::parse(&self.host.doc_id).ok()?,
            EmbedId::parse(id).ok()?,
        );
        let kind = self
            .host
            .handle
            .read(move |doc| {
                let prose = BorrowedProse::new(doc, &doc_id).ok()?;
                match prose.view().embed(&embed)? {
                    EmbedView::Table { .. } => Some(Kind::Table),
                    EmbedView::Material { material, .. } => Some(Kind::Material(material)),
                    EmbedView::Other { .. } => None,
                }
            })
            .ok()
            .flatten()?;
        self.kinds.borrow_mut().insert(id.to_owned(), kind.clone());
        Some(kind)
    }

    /// The view of table `id` (made on first use).
    pub fn table(&self, id: &str, cx: &mut App) -> Option<Entity<TableView>> {
        if let Some(t) = self.tables.borrow().get(id) {
            return Some(t.clone());
        }
        if self.kind(id)? != Kind::Table {
            return None;
        }
        let view = TableView::open(self.host.clone(), EmbedId::parse(id).ok()?)?;
        let entity = cx.new(|_| view);
        self.tables
            .borrow_mut()
            .insert(id.to_owned(), entity.clone());
        Some(entity)
    }

    /// Table `id`'s cells as stored (plain text), row by row.
    pub fn table_cells(&self, id: &str) -> Option<Vec<Vec<String>>> {
        if self.kind(id)? != Kind::Table {
            return None;
        }
        let embed = id.to_owned();
        self.host
            .handle
            .read(move |doc| crate::table::read_cells(doc, &embed))
            .ok()
    }

    /// Table `id`'s cells and their inline marks, row by row.
    pub fn table_grid(
        &self,
        id: &str,
    ) -> Option<(Vec<Vec<String>>, crate::table::clip::GridMarks)> {
        if self.kind(id)? != Kind::Table {
            return None;
        }
        let embed = id.to_owned();
        self.host
            .handle
            .read(move |doc| crate::table::read_grid(doc, &embed))
            .ok()
    }

    /// Embed `id` as plain text: a table's rows (tab-separated), a
    /// material's title.
    pub fn embed_text(&self, id: &str) -> String {
        match self.kind(id) {
            Some(Kind::Table) => self
                .table_cells(id)
                .map(|cells| crate::table::clip::to_tsv(&cells))
                .unwrap_or_default(),
            Some(Kind::Material(Some(m))) => {
                crate::material::title_of(&self.host, m.as_str()).unwrap_or_default()
            }
            _ => String::new(),
        }
    }

    /// The view of embedded material `id`, once drawn.
    pub fn material_block(&self, id: &str) -> Option<Entity<MaterialBlock>> {
        self.materials.borrow().get(id).cloned()
    }

    /// The tables drawn so far.
    pub fn tables(&self) -> Vec<Entity<TableView>> {
        self.tables.borrow().values().cloned().collect()
    }

    fn material(
        &self,
        id: &str,
        material: Option<MaterialId>,
        cx: &mut App,
    ) -> Entity<MaterialBlock> {
        if let Some(b) = self.materials.borrow().get(id) {
            return b.clone();
        }
        let entity = cx.new(|_| MaterialBlock::new(self.host.clone(), id, material));
        self.materials
            .borrow_mut()
            .insert(id.to_owned(), entity.clone());
        entity
    }

    /// Commits made elsewhere (an undo, another device, an Agent): the
    /// tables catch up when drawn next; gone embeds' views are dropped.
    pub(crate) fn refresh(&self, cx: &mut App) {
        let present: Vec<String> = match self.host.body.upgrade() {
            Some(body) => {
                let e = body.read(cx);
                let doc = &e.book().chapters[self.host.chapter].doc;
                doc.lines()[..doc.visible_lines()]
                    .iter()
                    .filter_map(|l| l.embed().map(str::to_owned))
                    .collect()
            }
            None => return,
        };
        self.tables
            .borrow_mut()
            .retain(|id, _| present.contains(id));
        self.materials
            .borrow_mut()
            .retain(|id, _| present.contains(id));
        for table in self.tables() {
            table.update(cx, |t, cx| t.refresh(cx));
        }
    }

    /// The book changed: materials look their facts up again.
    pub(crate) fn book_changed(&self, cx: &mut App) {
        let blocks: Vec<_> = self.materials.borrow().values().cloned().collect();
        for block in blocks {
            block.update(cx, |b, cx| b.reload(cx));
        }
    }

    /// The body's look changed.
    pub(crate) fn restyle(&self, style: ProseStyle, cx: &mut App) {
        *self.host.style.borrow_mut() = style;
        for table in self.tables() {
            table.update(cx, |_, cx| cx.notify());
        }
    }
}

impl EmbedViews for NoteEmbeds {
    fn view(
        &self,
        _chapter: usize,
        id: &str,
        selected: bool,
        _window: &mut Window,
        cx: &mut App,
    ) -> Option<AnyElement> {
        match self.kind(id)? {
            Kind::Table => {
                let table = self.table(id, cx)?;
                table.update(cx, |t, cx| {
                    if t.selected != selected {
                        t.selected = selected;
                        cx.notify();
                    }
                });
                Some(table.into_any_element())
            }
            Kind::Material(material) => {
                let block = self.material(id, material, cx);
                block.update(cx, |b, cx| {
                    if b.selected != selected {
                        b.selected = selected;
                        cx.notify();
                    }
                });
                Some(block.into_any_element())
            }
        }
    }

    fn enter(
        &self,
        _chapter: usize,
        id: &str,
        from_below: bool,
        window: &mut Window,
        cx: &mut App,
    ) -> bool {
        let Some(table) = self.table(id, cx) else {
            return false;
        };
        table.update(cx, |t, cx| {
            let row = if from_below {
                t.rows().len().saturating_sub(1)
            } else {
                0
            };
            t.focus_cell(row, 0, from_below, window, cx);
        });
        true
    }
}

/// Where a new embed goes for a caret at `offset` of `view`: before the
/// caret's paragraph when it is empty, else before a new empty paragraph
/// after it. Returns `(split at, embed at)`: split first if `Some`.
fn embed_place(view: &dr_doc::prose::ProseView<'_>, offset: usize) -> (Option<usize>, usize) {
    let start = view.paragraph_start(offset);
    let end = view.next_newline(start).unwrap_or(start);
    if end == start {
        (None, start)
    } else {
        (Some(end), end + 1)
    }
}

/// Inserts embed `kind` at the body caret (`offset`) in one commit, with
/// `fill` writing its contents; folds the commit into the body's history and
/// folds the new text into the body editor. Returns the new embed's id.
fn insert_embed(
    host: &NoteHost,
    offset: usize,
    kind: EmbedKind,
    fill: impl FnOnce(&dr_doc::prose::TableWriter) -> dr_doc::Result<()> + Send + 'static,
    cx: &mut App,
) -> Option<EmbedId> {
    let id = EmbedId::new_v7();
    let embed = id.clone();
    let written = host.session.edit(move |txn| {
        let (split, at) = embed_place(&txn.view(), offset);
        if let Some(at) = split {
            txn.split(at)?;
        }
        let w = txn.insert_embed(at, &embed, &kind)?;
        fill(&w)
    });
    if let Err(e) = written {
        log::error!("dr-editor: inserting an embed failed: {e}");
        return None;
    }
    let body = host.body.upgrade()?;
    let chapter = host.chapter;
    body.update(cx, |e, cx| {
        e.refresh_chapter(chapter, cx);
        e.record_host_items(chapter, 1, true);
    });
    host.edited(cx);
    Some(id)
}

/// Inserts a table of `cells` (rows of cell texts; empty: 3 × 3) with
/// their `marks` (none: plain) at the body caret and puts the caret in its
/// first cell.
pub fn insert_table(
    embeds: &NoteEmbeds,
    offset: usize,
    cells: Vec<Vec<String>>,
    marks: crate::table::clip::GridMarks,
    window: &mut Window,
    cx: &mut App,
) -> Option<EmbedId> {
    let cells = if cells.is_empty() {
        vec![vec![String::new(); 3]; 3]
    } else {
        cells
    };
    let id = insert_embed(
        &embeds.host,
        offset,
        EmbedKind::Table,
        move |w| crate::table::write_grid(w, &cells, &marks),
        cx,
    )?;
    if let Some(table) = embeds.table(id.as_str(), cx) {
        table.update(cx, |t, cx| t.focus_cell(0, 0, false, window, cx));
    }
    Some(id)
}

/// Inserts material `material` (an image or a PDF) at the body caret.
pub fn insert_material(
    embeds: &NoteEmbeds,
    offset: usize,
    material: MaterialId,
    cx: &mut App,
) -> Option<EmbedId> {
    insert_embed(
        &embeds.host,
        offset,
        EmbedKind::Material(material),
        |_| Ok(()),
        cx,
    )
}
