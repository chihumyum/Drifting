//! The whole book in one editor (M05, 通览全书): every chapter of a book in
//! one scroll, laid out by the same engine, each chapter edited in place.
//!
//! - Every chapter is its own prose document with its own workspace session
//!   ([`SessionSource`]): typing in chapter 7 is a write to chapter 7's
//!   document, and ⌘Z undoes in the chapter the caret is in (the chapters'
//!   undo stacks never mix).
//! - The chapters are opened in parallel (one document holder each, as F3
//!   keeps a hundred documents open); gpui-prose virtualizes the scroll with
//!   its height index, so a 1.5-million-character book lays out only what is
//!   on screen.
//! - Acts: the chapters that open an act carry the act's name
//!   ([`gpui_prose::Book::act_opening`]) for the title pages.
//! - Jump to a chapter (the table of contents), reveal a line of a position
//!   link, save and restore the reading position.
//! - Someone else's change to any chapter arrives as the workspace's `Prose`
//!   event and is folded into that chapter; a change of the book's chapters
//!   (added, removed, reordered, renamed) reloads the view at the same
//!   reading position.
//! - A selection may span chapters (drag, ⇧ with the arrows); copying joins
//!   the chapters' parts, deleting takes each chapter's part out of that
//!   chapter as a step of its own, undone together (gpui-prose's
//!   `input/span.rs`). The view reports the selection as a [`BookRange`].

use std::collections::HashMap;
use std::rc::Rc;

use dr_model::book::EncodedAnchor;
use dr_workspace::{Actor, Workspace, WsError, WsEvent};
use futures::StreamExt;
use futures::channel::mpsc;
use gpui::{
    App, AppContext, Context, Entity, EventEmitter, InteractiveElement, IntoElement, ListOffset,
    ParentElement, Render, SharedString, Styled, Subscription, Window, div, px,
};
use gpui_prose::input::actions::{Redo, Undo};
use gpui_prose::layout::{BookRange, Item};
use gpui_prose::{Book, Chapter, EditorEvent, ProseDoc, ProseEditor, ProseStyle};
use serde_json::{Value, json};

use crate::anchors;
use crate::links::{DriftingExtension, LinkTargets};
use crate::settings::EditorSettings;
use crate::source::SessionSource;
use crate::todo::{self, TodoMarker};

/// What the whole-book view tells its host.
#[derive(Clone, Debug, PartialEq)]
pub enum BookEditorEvent {
    /// The author changed chapter `doc`.
    Edited { doc: String },
    /// The TODO markers of chapter `doc` changed.
    TodoMarkers {
        doc: String,
        markers: Vec<TodoMarker>,
    },
    /// An undo in chapter `doc` re-anchored these comments.
    AnchorsChanged {
        doc: String,
        changes: Vec<(String, EncodedAnchor)>,
    },
    /// The book's chapters changed and the view was rebuilt.
    Reloaded,
}

/// Where the reader is: the paragraph at the top of the view. Survives
/// edits (it names the paragraph by its block id) and restarts (the host
/// stores it with the book's layout).
#[derive(Clone, Debug, PartialEq)]
pub struct ReadingPosition {
    /// The chapter's prose document.
    pub doc: String,
    /// The paragraph's block id, if it has one.
    pub block: Option<String>,
    /// The paragraph's index (used when the block id is gone).
    pub paragraph: usize,
    /// Pixels of that paragraph above the top of the view.
    pub offset: f32,
}

/// One chapter as the book lists it.
#[derive(Clone, Debug, PartialEq)]
struct Listed {
    doc: String,
    title: String,
}

struct Catalog(dr_workspace::BookCatalog);

impl LinkTargets for Catalog {
    fn alive(&self, kind: &dr_model::kind::EntityKind, id: &str) -> bool {
        self.0.alive(kind, id)
    }
}

/// Acts as `(index of the act's first chapter, name)`.
type Acts = Vec<(usize, String)>;

/// The chapters of `book` in reading order, and the acts.
fn list(ws: &Workspace, book: &str) -> Result<(Vec<Listed>, Acts), WsError> {
    let out = |name: &str| -> Result<Value, WsError> {
        Ok(ws.call(&Actor::User, name, json!({ "book": book }))?["output"].clone())
    };
    let chapters: Vec<Listed> = out("chapter.list")?
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| !c["trashed"].as_bool().unwrap_or(false))
        .map(|c| Listed {
            doc: format!("node:{}", c["id"].as_str().unwrap_or_default()),
            title: c["title"].as_str().unwrap_or_default().to_owned(),
        })
        .collect();
    let index: HashMap<&str, usize> = chapters
        .iter()
        .enumerate()
        .map(|(i, c)| (c.doc.as_str(), i))
        .collect();
    let mut acts = Vec::new();
    for act in out("act.list")?.as_array().into_iter().flatten() {
        let first = act["chapters"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|id| {
                index
                    .get(format!("node:{}", id.as_str()?).as_str())
                    .copied()
            })
            .min();
        if let Some(first) = first {
            acts.push((first, act["name"].as_str().unwrap_or_default().to_owned()));
        }
    }
    Ok((chapters, acts))
}

/// Opens every chapter's session and document, on all cores.
fn open_all(ws: &Workspace, listed: &[Listed]) -> Result<Vec<ProseDoc>, WsError> {
    let workers = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(listed.len().max(1));
    let next = std::sync::atomic::AtomicUsize::new(0);
    let mut slots: Vec<Option<Result<ProseDoc, WsError>>> =
        (0..listed.len()).map(|_| None).collect();
    let results = std::sync::Mutex::new(&mut slots);
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| {
                loop {
                    let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    let Some(chapter) = listed.get(i) else { break };
                    let opened = SessionSource::open(ws, &chapter.doc)
                        .map(|source| ProseDoc::open(Box::new(source)));
                    results.lock().unwrap_or_else(|e| e.into_inner())[i] = Some(opened);
                }
            });
        }
    });
    slots
        .into_iter()
        .map(|r| {
            r.unwrap_or_else(|| {
                Err(WsError::from(dr_store::StoreError::Closed(
                    "chapter".into(),
                )))
            })
        })
        .collect()
}

/// What opening a book needs from the workspace, read off the main thread
/// ([`BookEditor::prepare`], the slow half: every chapter's session and
/// document, loaded from SQLite when cold; the acts; the comment anchors).
/// `Send`: prepare it on a background thread, then install it on the main
/// thread with [`BookEditor::with_prepared`], which cannot fail.
pub struct PreparedBook {
    book: String,
    listed: Vec<Listed>,
    acts: Acts,
    docs: Vec<ProseDoc>,
}

impl PreparedBook {
    /// The book's id.
    pub fn book(&self) -> &str {
        &self.book
    }

    /// The chapters' prose documents, in reading order.
    pub fn chapter_docs(&self) -> impl Iterator<Item = &str> {
        self.listed.iter().map(|c| c.doc.as_str())
    }
}

/// A whole book, being read and edited.
pub struct BookEditor {
    ws: Workspace,
    book: String,
    chapters: Vec<Listed>,
    index: HashMap<String, usize>,
    base_style: ProseStyle,
    settings: EditorSettings,
    extension: Rc<DriftingExtension>,
    editor: Entity<ProseEditor>,
    todos: HashMap<usize, Vec<TodoMarker>>,
    /// Each chapter page's facts and the host's chrome (M03).
    pages: crate::page::Pages,
    /// The pickers, automatic links and the selection bar.
    assist: Entity<crate::assist::Assist>,
    _assist_events: Subscription,
    /// The paint layers of every chapter (crate::decor).
    pub(crate) decor: crate::decor::Decor,
    /// Immersive writing: typewriter scrolling forced on (M26).
    immersive: bool,
    _editor_events: Subscription,
    _ws_events: dr_workspace::Subscription,
}

impl EventEmitter<BookEditorEvent> for BookEditor {}
impl EventEmitter<crate::view::CommentRequested> for BookEditor {}
impl EventEmitter<crate::view::PositionLinkCopied> for BookEditor {}
impl EventEmitter<crate::view::EntityLinkOpened> for BookEditor {}
impl EventEmitter<crate::view::WritingTyped> for BookEditor {}

impl BookEditor {
    /// Opens every chapter of `book` for the author: [`BookEditor::prepare`]
    /// and [`BookEditor::with_prepared`] in one go, on the calling thread.
    pub fn open(
        ws: Workspace,
        book: &str,
        settings: EditorSettings,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Result<BookEditor, WsError> {
        let prepared = Self::prepare(&ws, book)?;
        Ok(Self::with_prepared(ws, prepared, settings, window, cx))
    }

    /// The slow half of opening `book`, for any thread: the chapters and
    /// acts, every chapter's session and document (on all cores), the
    /// comment anchors. Fails when the book or a chapter cannot be read.
    pub fn prepare(ws: &Workspace, book: &str) -> Result<PreparedBook, WsError> {
        let (listed, acts) = list(ws, book)?;
        let mut docs = open_all(ws, &listed)?;
        match anchors::book_comment_anchors(ws, book) {
            Ok(mut by_doc) => {
                for (doc, chapter) in docs.iter_mut().zip(&listed) {
                    for (id, anchor) in by_doc.remove(&chapter.doc).unwrap_or_default() {
                        doc.set_anchor(id, anchor);
                    }
                }
            }
            Err(e) => log::warn!("dr-editor: comment anchors of {book}: {e}"),
        }
        Ok(PreparedBook {
            book: book.to_owned(),
            listed,
            acts,
            docs,
        })
    }

    /// The fast half, on the main thread: the editor on a prepared book.
    /// Cannot fail, so it fits in `cx.new`.
    pub fn with_prepared(
        ws: Workspace,
        prepared: PreparedBook,
        settings: EditorSettings,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> BookEditor {
        let book = prepared.book.clone();
        let book = book.as_str();
        let base_style = ProseStyle::default();
        let targets = ws
            .catalog(book)
            .ok()
            .map(|c| Box::new(Catalog(c)) as Box<dyn LinkTargets>);
        let extension = Rc::new(DriftingExtension::new(targets));
        let (chapters, editor, events) = Self::install(
            prepared,
            &settings.style(&base_style),
            &extension,
            window,
            cx,
        );
        let ws_events = Self::watch(&ws, window, cx);
        let index = chapters
            .iter()
            .enumerate()
            .map(|(i, c)| (c.doc.clone(), i))
            .collect();
        let docs: Vec<String> = chapters.iter().map(|c| c.doc.clone()).collect();
        let assist = cx.new(|cx| {
            let mut a =
                crate::assist::Assist::new(ws.clone(), book, editor.clone(), docs, window, cx);
            a.set_auto_links(settings.auto_entity_links);
            a
        });
        let assist_events = cx.subscribe(
            &assist,
            |this: &mut BookEditor, _, event: &crate::assist::AssistEvent, cx| match event {
                crate::assist::AssistEvent::Comment { chapter, range } => {
                    let Some(doc) = this.chapters.get(*chapter).map(|c| c.doc.clone()) else {
                        return;
                    };
                    let text = this.editor.read(cx).book().chapters[*chapter]
                        .doc
                        .slice(range.clone());
                    cx.emit(crate::view::CommentRequested {
                        doc,
                        range: range.clone(),
                        text,
                    });
                }
                crate::assist::AssistEvent::LinkCopied { chapter, link } => {
                    if let Some(doc) = this.chapters.get(*chapter).map(|c| c.doc.clone()) {
                        cx.emit(crate::view::PositionLinkCopied {
                            doc,
                            link: link.clone(),
                        });
                    }
                }
                crate::assist::AssistEvent::OpenLink { chapter, target } => {
                    if let Some(doc) = this.chapters.get(*chapter).map(|c| c.doc.clone()) {
                        cx.emit(crate::view::EntityLinkOpened {
                            doc,
                            kind: target.kind.clone(),
                            id: target.id.clone(),
                        });
                    }
                }
                // A note's entries: the whole book has no notes.
                crate::assist::AssistEvent::InsertTable { .. }
                | crate::assist::AssistEvent::InsertMaterial { .. } => {}
            },
        );
        let decor = crate::decor::Decor::for_book(
            &ws,
            book,
            chapters.iter().map(|c| c.doc.clone()).collect(),
            &editor,
            extension.clone(),
            window,
            cx,
        );
        let mut this = BookEditor {
            ws,
            book: book.to_owned(),
            chapters,
            index,
            base_style,
            settings,
            immersive: false,
            extension,
            editor,
            todos: HashMap::new(),
            pages: Default::default(),
            assist,
            _assist_events: assist_events,
            decor,
            _editor_events: events,
            _ws_events: ws_events,
        };
        this.todos = (0..this.chapters.len())
            .map(|c| (c, this.find_todos(c, cx)))
            .filter(|(_, t)| !t.is_empty())
            .collect();
        this
    }

    #[allow(clippy::type_complexity)]
    fn build(
        ws: &Workspace,
        book: &str,
        style: &ProseStyle,
        extension: &Rc<DriftingExtension>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Result<(Vec<Listed>, Entity<ProseEditor>, Subscription), WsError> {
        let prepared = Self::prepare(ws, book)?;
        Ok(Self::install(prepared, style, extension, window, cx))
    }

    #[allow(clippy::type_complexity)]
    fn install(
        prepared: PreparedBook,
        style: &ProseStyle,
        extension: &Rc<DriftingExtension>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> (Vec<Listed>, Entity<ProseEditor>, Subscription) {
        let PreparedBook {
            listed, acts, docs, ..
        } = prepared;
        let mut book = Book::new(
            docs.into_iter()
                .zip(&listed)
                .map(|(doc, c)| Chapter {
                    title: c.title.clone().into(),
                    doc,
                })
                .collect(),
        );
        book.set_acts(
            acts.into_iter()
                .map(|(c, name)| (c, SharedString::from(name))),
        );
        let style = style.clone();
        let extension = extension.clone();
        let editor = cx.new(|cx| {
            let mut editor = ProseEditor::new(book, style, window, cx);
            editor.set_extension(extension);
            editor
        });
        let events = cx.subscribe(&editor, |this, _, event: &EditorEvent, cx| {
            this.on_editor(event, cx)
        });
        let typed = cx.subscribe(&editor, |this, _, e: &gpui_prose::AuthorTyped, cx| {
            if let Some(c) = this.chapters.get(e.chapter) {
                cx.emit(crate::view::WritingTyped { doc: c.doc.clone() });
            }
        });
        (listed, editor, Subscription::join(events, typed))
    }

    /// The workspace's events, moved to the main thread.
    fn watch(
        ws: &Workspace,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> dr_workspace::Subscription {
        let (tx, mut rx) = mpsc::unbounded::<Notice>();
        let sub = ws.subscribe(move |e| {
            let notice = match e {
                WsEvent::Prose(p) => Some(Notice::Prose(p.doc.to_string())),
                WsEvent::Book(_) | WsEvent::Removed(_) => Some(Notice::Book),
                _ => None,
            };
            if let Some(n) = notice {
                let _ = tx.unbounded_send(n);
            }
        });
        cx.spawn_in(window, async move |this, cx| {
            while let Some(first) = rx.next().await {
                let mut notices = vec![first];
                while let Ok(n) = rx.try_recv() {
                    notices.push(n);
                }
                let alive = this.update_in(cx, |this, window, cx| {
                    this.on_workspace(&notices, window, cx)
                });
                if alive.is_err() {
                    break;
                }
            }
        })
        .detach();
        sub
    }

    fn on_workspace(&mut self, notices: &[Notice], window: &mut Window, cx: &mut Context<Self>) {
        let mut touched: Vec<usize> = notices
            .iter()
            .filter_map(|n| match n {
                Notice::Prose(doc) => self.index.get(doc).copied(),
                Notice::Book => None,
            })
            .collect();
        touched.sort_unstable();
        touched.dedup();
        for chapter in touched {
            // The author's own edits are already in; this drains the rest.
            self.editor
                .update(cx, |e, cx| e.refresh_chapter(chapter, cx));
            self.update_todos(chapter, cx);
            self.pages.edited(chapter, &self.editor, cx);
        }
        if notices.contains(&Notice::Book) {
            self.extension.invalidate();
            self.assist.update(cx, |a, cx| a.invalidate_names(cx));
            self.follow_book(window, cx);
            if self.pages.has_chrome() {
                self.refresh_pages(cx);
            }
            cx.notify();
        }
    }

    /// The book's chapters changed: titles are updated in place; added,
    /// removed or reordered chapters rebuild the view where the reader was.
    fn follow_book(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Ok((listed, acts)) = list(&self.ws, &self.book) else {
            return;
        };
        let same_docs = listed.len() == self.chapters.len()
            && listed
                .iter()
                .zip(&self.chapters)
                .all(|(a, b)| a.doc == b.doc);
        if same_docs {
            if listed != self.chapters {
                self.editor.update(cx, |e, cx| {
                    for (chapter, l) in e.book_mut().chapters.iter_mut().zip(&listed) {
                        chapter.title = l.title.clone().into();
                    }
                    e.book_mut()
                        .set_acts(acts.into_iter().map(|(c, n)| (c, SharedString::from(n))));
                    cx.notify();
                });
                self.chapters = listed;
            }
            return;
        }
        if let Err(e) = self.reload(window, cx) {
            log::error!("dr-editor: reloading {}: {e}", self.book);
        }
    }

    /// Rebuilds the view (every chapter reopened) at the same reading
    /// position.
    pub fn reload(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Result<(), WsError> {
        let at = self.reading_position(cx);
        let style = self.settings.style_for(&self.base_style, self.immersive);
        let (chapters, editor, events) =
            Self::build(&self.ws, &self.book, &style, &self.extension, window, cx)?;
        self.index = chapters
            .iter()
            .enumerate()
            .map(|(i, c)| (c.doc.clone(), i))
            .collect();
        self.chapters = chapters;
        self.editor = editor;
        self._editor_events = events;
        self.todos.clear();
        if self.pages.has_chrome() {
            self.pages.attach(&self.editor, cx);
            self.refresh_pages(cx);
        }
        let (editor, docs) = (
            self.editor.clone(),
            self.chapters.iter().map(|c| c.doc.clone()).collect(),
        );
        self.assist
            .update(cx, |a, cx| a.attach(editor, docs, window, cx));
        let docs = self.chapters.iter().map(|c| c.doc.clone()).collect();
        self.decor
            .rebind_book(&self.ws, &self.book, docs, &self.editor, window, cx);
        if let Some(at) = at {
            self.restore(&at, cx);
        }
        cx.emit(BookEditorEvent::Reloaded);
        cx.notify();
        Ok(())
    }

    fn on_editor(&mut self, event: &EditorEvent, cx: &mut Context<Self>) {
        match event {
            EditorEvent::Edited { chapter } => {
                if let Some(doc) = self.chapters.get(*chapter).map(|c| c.doc.clone()) {
                    cx.emit(BookEditorEvent::Edited { doc });
                }
                self.update_todos(*chapter, cx);
                self.pages.edited(*chapter, &self.editor, cx);
            }
            EditorEvent::AnchorsChanged { chapter, changes } => {
                if let Some(doc) = self.chapters.get(*chapter).map(|c| c.doc.clone()) {
                    let changes = changes
                        .iter()
                        .map(|c| (c.id.to_string(), anchors::encode(&c.anchor)))
                        .collect();
                    cx.emit(BookEditorEvent::AnchorsChanged { doc, changes });
                }
            }
            _ => {}
        }
    }

    fn find_todos(&self, chapter: usize, cx: &App) -> Vec<TodoMarker> {
        let editor = self.editor.read(cx);
        let Some(c) = editor.book().chapters.get(chapter) else {
            return Vec::new();
        };
        let doc = &c.doc;
        todo::markers(
            doc.lines()[..doc.visible_lines()]
                .iter()
                .map(|l| (l.text.as_ref(), l.bid())),
        )
    }

    fn update_todos(&mut self, chapter: usize, cx: &mut Context<Self>) {
        let found = self.find_todos(chapter, cx);
        let before = self.todos.get(&chapter).cloned().unwrap_or_default();
        if found != before {
            if found.is_empty() {
                self.todos.remove(&chapter);
            } else {
                self.todos.insert(chapter, found.clone());
            }
            if let Some(doc) = self.chapters.get(chapter).map(|c| c.doc.clone()) {
                cx.emit(BookEditorEvent::TodoMarkers {
                    doc,
                    markers: found,
                });
            }
        }
    }

    // ----- the chapter pages (M03) -----------------------------------------------

    /// Draws the host's head and end around every chapter (see
    /// [`crate::page`]), or the editor's own title rows again (`None`). The
    /// list starts over: set it right after opening.
    pub fn set_chrome(
        &mut self,
        chrome: Option<Rc<dyn crate::page::PageChrome>>,
        cx: &mut Context<Self>,
    ) {
        self.pages.set_chrome(chrome, &self.editor, cx);
        self.refresh_pages(cx);
        cx.notify();
    }

    /// Chapter `doc`'s page facts.
    pub fn page_info(&self, doc: &str) -> Option<crate::page::PageInfo> {
        self.pages.info(self.chapter_of(doc)?)
    }

    fn refresh_pages(&mut self, cx: &mut Context<Self>) {
        let docs: Vec<String> = self.chapters.iter().map(|c| c.doc.clone()).collect();
        self.pages
            .refresh(&self.ws, &self.book, &docs, &self.editor, cx);
    }

    /// The caret at the start of chapter `doc`'s text, the editor focused
    /// (its title field's Enter).
    pub fn focus_body(&mut self, doc: &str, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(chapter) = self.chapter_of(doc) else {
            return false;
        };
        self.editor
            .update(cx, |e, cx| e.focus_chapter_start(chapter, window, cx));
        true
    }

    // ----- navigation ---------------------------------------------------------

    /// The chapters' prose documents, in reading order.
    pub fn chapter_docs(&self) -> impl Iterator<Item = &str> {
        self.chapters.iter().map(|c| c.doc.as_str())
    }

    /// The index of chapter `doc` in the view.
    pub fn chapter_of(&self, doc: &str) -> Option<usize> {
        self.index.get(doc).copied()
    }

    /// Scrolls to chapter `doc`'s title (the table of contents) and puts the
    /// caret at its start.
    pub fn jump_to(&mut self, doc: &str, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(chapter) = self.chapter_of(doc) else {
            return false;
        };
        self.editor
            .update(cx, |e, cx| e.jump_to_chapter(chapter, window, cx));
        true
    }

    /// Shows line `line` (1-based) of chapter `doc`'s Markdown projection, as
    /// a position link names it: paragraph N starts at line 2N + 1. The
    /// paragraph goes to the top of the view, with the caret at its start.
    pub fn reveal_line(
        &mut self,
        doc: &str,
        line: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(chapter) = self.chapter_of(doc) else {
            return false;
        };
        let paragraph = line.saturating_sub(1) / 2;
        self.editor.update(cx, |e, cx| {
            let doc = &e.book().chapters[chapter].doc;
            let paragraph = paragraph.min(doc.visible_lines().saturating_sub(1));
            let at = doc.line_start(paragraph);
            let item = e.book().line_item(chapter, paragraph);
            e.select(chapter, at..at, window, cx);
            e.list_state().scroll_to(ListOffset {
                item_ix: item,
                offset_in_item: px(0.),
            });
            cx.notify();
        });
        true
    }

    /// The paragraph at the top of the view.
    pub fn reading_position(&self, cx: &App) -> Option<ReadingPosition> {
        let editor = self.editor.read(cx);
        let top = editor.list_state().logical_scroll_top();
        let book = editor.book();
        if book.chapters.is_empty() {
            return None;
        }
        let (chapter, paragraph, offset) =
            match book.item(top.item_ix.min(book.item_count().saturating_sub(1))) {
                Item::Title(c) => (c, 0, 0.),
                Item::Line(c, l) => (c, l, f32::from(top.offset_in_item)),
                // Past a chapter's text, at its end: its last paragraph.
                Item::End(c) => (
                    c,
                    book.chapters[c].doc.visible_lines().saturating_sub(1),
                    0.,
                ),
            };
        let doc = &book.chapters[chapter].doc;
        Some(ReadingPosition {
            doc: self.chapters.get(chapter)?.doc.clone(),
            block: doc
                .lines()
                .get(paragraph)
                .and_then(|l| l.bid())
                .map(str::to_owned),
            paragraph,
            offset,
        })
    }

    /// Scrolls back to a reading position (by block id, else by paragraph
    /// index; a chapter that is gone leaves the view where it is).
    pub fn restore(&mut self, at: &ReadingPosition, cx: &mut Context<Self>) -> bool {
        let Some(chapter) = self.chapter_of(&at.doc) else {
            return false;
        };
        self.editor.update(cx, |e, cx| {
            let doc = &e.book().chapters[chapter].doc;
            let paragraph = at
                .block
                .as_deref()
                .and_then(|b| doc.line_by_bid(b))
                .unwrap_or(at.paragraph)
                .min(doc.visible_lines().saturating_sub(1));
            let item = e.book().line_item(chapter, paragraph);
            e.list_state().scroll_to(ListOffset {
                item_ix: item,
                offset_in_item: px(at.offset),
            });
            cx.notify();
        });
        true
    }

    /// The chapter the caret is in.
    pub fn current_doc(&self, cx: &App) -> Option<&str> {
        let chapter = self.editor.read(cx).selection().chapter;
        self.chapters.get(chapter).map(|c| c.doc.as_str())
    }

    /// The selection as a book range (it may span chapters).
    pub fn selection(&self, cx: &App) -> BookRange {
        self.editor.read(cx).selection().book_range()
    }

    /// The text of a book range (chapters joined by a newline).
    pub fn text_in(&self, range: BookRange, cx: &App) -> String {
        self.editor.read(cx).book().text_in(range)
    }

    // ----- editing ------------------------------------------------------------

    /// Undoes the author's last step in the chapter the caret is in.
    pub fn undo(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let chapter = self.editor.read(cx).selection().chapter;
        self.editor
            .update(cx, |e, cx| e.undo_in(chapter, window, cx))
    }

    pub fn redo(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let chapter = self.editor.read(cx).selection().chapter;
        self.editor
            .update(cx, |e, cx| e.redo_in(chapter, window, cx))
    }

    pub fn set_settings(&mut self, settings: EditorSettings, cx: &mut Context<Self>) {
        if settings == self.settings {
            return;
        }
        self.settings = settings;
        let style = self.settings.style_for(&self.base_style, self.immersive);
        self.editor.update(cx, |e, cx| e.set_style(style, cx));
        let auto = self.settings.auto_entity_links;
        self.assist.update(cx, |a, _| a.set_auto_links(auto));
        cx.notify();
    }

    /// The pickers, automatic links and the selection bar.
    pub fn assist(&self) -> &Entity<crate::assist::Assist> {
        &self.assist
    }

    pub fn set_base_style(&mut self, style: ProseStyle, cx: &mut Context<Self>) {
        self.base_style = style;
        let style = self.settings.style_for(&self.base_style, self.immersive);
        self.editor.update(cx, |e, cx| e.set_style(style, cx));
        cx.notify();
    }

    /// Immersive writing (M26): as [`crate::ChapterEditor::set_immersive`].
    pub fn set_immersive(&mut self, on: bool, cx: &mut Context<Self>) {
        if self.immersive == on {
            return;
        }
        self.immersive = on;
        let style = self.settings.style_for(&self.base_style, on);
        self.editor.update(cx, |e, cx| e.set_style(style, cx));
        cx.notify();
    }

    pub fn immersive(&self) -> bool {
        self.immersive
    }

    pub fn book_id(&self) -> &str {
        &self.book
    }

    pub fn editor(&self) -> &Entity<ProseEditor> {
        &self.editor
    }

    /// TODO markers of every chapter that has some, by document.
    pub fn todo_markers(&self) -> Vec<(&str, &[TodoMarker])> {
        let mut out: Vec<(usize, &[TodoMarker])> =
            self.todos.iter().map(|(c, t)| (*c, t.as_slice())).collect();
        out.sort_by_key(|(c, _)| *c);
        out.into_iter()
            .filter_map(|(c, t)| Some((self.chapters.get(c)?.doc.as_str(), t)))
            .collect()
    }

    /// Chapter `doc`'s text as the editor holds it.
    pub fn plain_text(&self, doc: &str, cx: &App) -> Option<String> {
        let chapter = self.chapter_of(doc)?;
        Some(
            self.editor.read(cx).book().chapters[chapter]
                .doc
                .plain_text(),
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Notice {
    Prose(String),
    Book,
}

impl Render for BookEditor {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            // ⌘Z / ⌘⇧Z undo in the caret's chapter, before gpui-prose's own
            // handler (which undoes the latest step in any chapter).
            .capture_action(cx.listener(|this, _: &Undo, window, cx| {
                this.undo(window, cx);
                cx.stop_propagation();
            }))
            .capture_action(cx.listener(|this, _: &Redo, window, cx| {
                this.redo(window, cx);
                cx.stop_propagation();
            }))
            .child(crate::assist::wrap(
                &self.assist,
                ProseEditor::element(&self.editor, cx),
            ))
    }
}
