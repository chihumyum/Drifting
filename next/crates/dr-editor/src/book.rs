//! Flattened book view in one editor (M05, 整书视图): starting from any live
//! entry whose `level` switch is on, that entry and everything below it in one
//! continuous scroll (`kernel-v4.md` §7), each prose document edited in place.
//!
//! - Every prose module in the flattened sequence keeps its own workspace
//!   session ([`SessionSource`]): typing in chapter 7 writes chapter 7's
//!   document, and ⌘Z undoes in the chapter the caret is in (the chapters'
//!   undo stacks never mix).
//! - Sessions are opened in parallel across cores; gpui-prose virtualizes the
//!   scroll with its height index, so a 1.5-million-character book lays out
//!   only what is on screen.
//! - Entries without `in_book` prose (such as a manuscript root, 「第一卷」, or
//!   a storyline whose description has `in_book = false`) still appear with
//!   their title and hierarchy (`depth`).
//! - Jump to a chapter, reveal a line of a position link, save and restore the
//!   reading position.
//! - Someone else's change to any chapter arrives as the workspace's `Prose`
//!   event and is folded into that chapter; structural changes update titles
//!   and headings in place or rebuild the view at the same reading position.
//! - A selection may span chapters (drag, ⇧ with the arrows); copying joins
//!   the chapters' parts, deleting takes each chapter's part out of that
//!   chapter as a step of its own, undone together (gpui-prose's
//!   `input/span.rs`). The view reports the selection as a [`BookRange`].

use std::collections::HashMap;
use std::rc::Rc;

use dr_model::id::EntryId;
use dr_model::shared::EncodedAnchor;
use dr_workspace::{Workspace, WsError, WsEvent};
use futures::StreamExt;
use futures::channel::mpsc;
use gpui::prelude::FluentBuilder as _;
use gpui::{
    App, AppContext, Context, Entity, EventEmitter, Focusable, InteractiveElement, IntoElement,
    ListOffset, ParentElement, Render, ScrollHandle, StatefulInteractiveElement, Styled,
    Subscription, Window, div, point, px,
};
use gpui_prose::input::actions::{Redo, Undo};
use gpui_prose::layout::{BookRange, Item};
use gpui_prose::{Book, Chapter, EditorEvent, ProseDoc, ProseEditor, ProseStyle};

use crate::anchors;
use crate::links::{DriftingExtension, LinkTargets};
use crate::page::BookHeadings;
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

/// One entry (or additional book-prose module of an entry) in a flattened book
/// view (`kernel-v4.md` §7).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BookSection {
    /// Entry id (`EntryId`).
    pub entry: String,
    /// Heading text: the entry's title, or the prose module's name on
    /// subsequent book-prose modules of the same entry.
    pub title: String,
    /// Hierarchy depth relative to `from` (`0` is `from`).
    pub depth: u32,
    /// Prose document id (`body:<entry>/<module>`), or `None` when the entry
    /// carries no `in_book` prose.
    pub doc: Option<String>,
}

/// A prose-less entry's heading and hierarchy in the book scroll.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SectionHeading {
    pub entry: String,
    pub title: String,
    pub depth: u32,
}

/// Where the reader is: the paragraph or title at the top of the view.
/// Survives edits (it names the paragraph by its block id) and restarts (the
/// host stores it with the book's layout).
#[derive(Clone, Debug, PartialEq)]
pub struct ReadingPosition {
    /// The chapter's prose document (empty when the flattened view has no
    /// prose documents and is scrolled among section headings).
    pub doc: String,
    /// The paragraph's block id, if it has one.
    pub block: Option<String>,
    /// The paragraph's index (used when the block id is gone).
    pub paragraph: usize,
    /// Pixels of that item above the top of the view.
    pub offset: f32,
    /// Whether the top of the view sits on `doc`'s title / preceding section
    /// headings (`Item::Title`) rather than one of its paragraphs.
    pub at_title: bool,
}

/// One prose chapter as the flattened book lists it.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Listed {
    entry: String,
    doc: String,
    title: String,
    depth: u32,
}

fn partition(sections: &[BookSection]) -> (Vec<Listed>, BookHeadings) {
    let mut listed = Vec::new();
    let mut before = Vec::new();
    let mut chapters = Vec::new();
    let mut pending = Vec::new();
    for section in sections {
        match &section.doc {
            None => pending.push(SectionHeading {
                entry: section.entry.clone(),
                title: section.title.clone(),
                depth: section.depth,
            }),
            Some(doc) => {
                before.push(std::mem::take(&mut pending));
                chapters.push((section.title.clone(), section.depth));
                listed.push(Listed {
                    entry: section.entry.clone(),
                    doc: doc.clone(),
                    title: section.title.clone(),
                    depth: section.depth,
                });
            }
        }
    }
    (
        listed,
        BookHeadings {
            before,
            chapters,
            after_last: pending,
        },
    )
}

/// Flattens `from` and everything below it in reading order (`kernel-v4.md` §7).
fn list(ws: &Workspace, book: &str, from: &EntryId) -> Result<Vec<BookSection>, WsError> {
    let from = from.clone();
    let res = crate::v3::read(ws, book, move |v| crate::v3::flatten_book(&v, &from))?;
    res.map_err(|e| WsError::Invalid(e.to_string()))
}

/// Opens every chapter's session and document, on all cores.
fn open_all(ws: &Workspace, book: &str, listed: &[Listed]) -> Result<Vec<ProseDoc>, WsError> {
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
                    let source = match crate::v3::body(&chapter.doc) {
                        Some((entry, module)) => {
                            match ws.library().doc_info(&chapter.doc).map_err(WsError::from) {
                                Ok(Some(info)) if info.book_id.as_deref() == Some(book) => {
                                    SessionSource::open_verified_v3(ws, &chapter.doc)
                                }
                                Ok(Some(_)) => Err(WsError::Invalid(
                                    "manuscript document belongs to another book".into(),
                                )),
                                Ok(None) => crate::v3::prepare_body(ws, book, &entry, &module),
                                Err(error) => Err(error),
                            }
                        }
                        None => SessionSource::open(ws, &chapter.doc),
                    };
                    let opened = source.map(|source| ProseDoc::open(Box::new(source)));
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

/// What opening a flattened book view needs from the workspace, read off the
/// main thread ([`BookEditor::prepare`], the slow half: every chapter's session
/// and document, loaded from SQLite when cold; the flattened sections; the
/// comment anchors). `Send`: prepare it on a background thread, then install it
/// on the main thread with [`BookEditor::with_prepared`], which cannot fail.
pub struct PreparedBook {
    book: String,
    from: EntryId,
    sections: Vec<BookSection>,
    listed: Vec<Listed>,
    headings: BookHeadings,
    docs: Vec<ProseDoc>,
}

impl PreparedBook {
    /// The book's id.
    pub fn book(&self) -> &str {
        &self.book
    }

    /// The starting level entry's id.
    pub fn from_entry(&self) -> &str {
        self.from.as_str()
    }

    /// Every section in flattened reading order, including prose-less entries.
    pub fn sections(&self) -> &[BookSection] {
        &self.sections
    }

    /// The prose documents in flattened reading order.
    pub fn chapter_docs(&self) -> impl Iterator<Item = &str> {
        self.listed.iter().map(|c| c.doc.as_str())
    }
}

/// A flattened book view, being read and edited.
pub struct BookEditor {
    ws: Workspace,
    book: String,
    from: EntryId,
    sections: Vec<BookSection>,
    headings: BookHeadings,
    chapters: Vec<Listed>,
    index: HashMap<String, usize>,
    base_style: ProseStyle,
    settings: EditorSettings,
    extension: Rc<DriftingExtension>,
    editor: Entity<ProseEditor>,
    empty_scroll: ScrollHandle,
    todos: HashMap<usize, Vec<TodoMarker>>,
    /// Each chapter page's facts, section headings and the host's chrome (M03).
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
    /// Opens `from` and everything below it in `book` (`kernel-v4.md` §7):
    /// [`BookEditor::prepare`] and [`BookEditor::with_prepared`] in one go, on
    /// the calling thread.
    pub fn open(
        ws: Workspace,
        book: &str,
        from: &str,
        settings: EditorSettings,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Result<BookEditor, WsError> {
        let prepared = Self::prepare(&ws, book, from)?;
        Ok(Self::with_prepared(ws, prepared, settings, window, cx))
    }

    /// The slow half of opening `from` in `book`, for any thread: the flattened
    /// sections, every prose module's session and document (on all cores), and
    /// the comment anchors. Fails when `book`, `from`, or a chapter cannot be
    /// read, or when `from` is not a live entry with its switch on.
    pub fn prepare(ws: &Workspace, book: &str, from: &str) -> Result<PreparedBook, WsError> {
        let from = EntryId::parse(from).map_err(|e| WsError::Invalid(e.to_string()))?;
        let sections = list(ws, book, &from)?;
        let (listed, headings) = partition(&sections);
        let mut docs = open_all(ws, book, &listed)?;
        if !docs.is_empty() {
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
        }
        Ok(PreparedBook {
            book: book.to_owned(),
            from,
            sections,
            listed,
            headings,
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
        let book_id = prepared.book.clone();
        let book = book_id.as_str();
        let from = prepared.from.clone();
        let sections = prepared.sections.clone();
        let headings = prepared.headings.clone();
        let base_style = ProseStyle::default();
        let style = settings.style(&base_style);
        let targets = Some(Box::new(crate::v3::LinkTargets {
            workspace: ws.clone(),
            book: book.to_owned(),
        }) as Box<dyn LinkTargets>);
        let extension = Rc::new(DriftingExtension::new(targets));
        let (chapters, editor, events) = Self::install(prepared, &style, &extension, window, cx);
        let pages: crate::page::Pages = Default::default();
        pages.set_style(style, &editor, cx);
        pages.set_headings(headings.clone(), &editor, cx);
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
                crate::assist::AssistEvent::OpenLink {
                    chapter, target, ..
                } => {
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
            book: book_id,
            from,
            sections,
            headings,
            chapters,
            index,
            base_style,
            settings,
            immersive: false,
            extension,
            editor,
            empty_scroll: ScrollHandle::new(),
            todos: HashMap::new(),
            pages,
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
    fn install(
        prepared: PreparedBook,
        style: &ProseStyle,
        extension: &Rc<DriftingExtension>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> (Vec<Listed>, Entity<ProseEditor>, Subscription) {
        let PreparedBook { listed, docs, .. } = prepared;
        let book = Book::new(
            docs.into_iter()
                .zip(&listed)
                .map(|(doc, c)| Chapter {
                    title: c.title.clone().into(),
                    doc,
                })
                .collect(),
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
                // The chapters, their titles and the names are the book's
                // content: a writing day or a saved checkpoint changes none.
                WsEvent::Book(_) => Some(Notice::Book),
                WsEvent::Removed(_) => Some(Notice::Book),
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

    /// The book's entries changed: titles and prose-less headings are updated
    /// in place when the prose document sequence is unchanged; added, removed
    /// or reordered prose documents rebuild the view where the reader was.
    fn follow_book(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let sections = match list(&self.ws, &self.book, &self.from) {
            Ok(sections) => sections,
            Err(_) => {
                // `from` was trashed or its switch was turned off; clear any
                // stale content until the host closes this view.
                if !self.sections.is_empty() || !self.chapters.is_empty() {
                    self.install_sections(Vec::new(), Vec::new(), window, cx);
                }
                return;
            }
        };
        let (listed, headings) = partition(&sections);
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
                    cx.notify();
                });
                self.chapters = listed;
            }
            if sections != self.sections {
                self.sections = sections;
                self.headings = headings.clone();
                self.pages.set_headings(headings, &self.editor, cx);
                cx.notify();
            }
            return;
        }
        if let Err(e) = self.reload(window, cx) {
            log::error!("dr-editor: reloading {}: {e}", self.book);
        }
    }

    fn install_sections(
        &mut self,
        sections: Vec<BookSection>,
        docs: Vec<ProseDoc>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let at = self.reading_position(cx);
        let style = self.settings.style_for(&self.base_style, self.immersive);
        let selection = self.editor.read(cx).selection();
        let selected_docs = (
            self.chapters
                .get(selection.anchor_chapter)
                .map(|c| c.doc.clone()),
            self.chapters.get(selection.chapter).map(|c| c.doc.clone()),
        );
        let focused = self.editor.read(cx).focus_handle(cx).is_focused(window);
        let (listed, headings) = partition(&sections);
        let (chapters, editor, events) = Self::install(
            PreparedBook {
                book: self.book.clone(),
                from: self.from.clone(),
                sections: sections.clone(),
                listed,
                headings: headings.clone(),
                docs,
            },
            &style,
            &self.extension,
            window,
            cx,
        );
        self.sections = sections;
        self.headings = headings.clone();
        self.index = chapters
            .iter()
            .enumerate()
            .map(|(i, c)| (c.doc.clone(), i))
            .collect();
        self.chapters = chapters;
        self.editor = editor;
        self._editor_events = events;
        self.todos.clear();
        self.pages.set_style(style, &self.editor, cx);
        self.pages.set_headings(headings, &self.editor, cx);
        self.pages.attach(&self.editor, cx);
        if self.pages.has_chrome() {
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

        if let (Some(anchor), Some(head)) = (
            selected_docs.0.as_deref().and_then(|d| self.chapter_of(d)),
            selected_docs.1.as_deref().and_then(|d| self.chapter_of(d)),
        ) {
            self.editor.update(cx, |e, cx| {
                e.select_across(
                    gpui_prose::layout::BookPos {
                        chapter: anchor,
                        offset: selection.anchor,
                    },
                    gpui_prose::layout::BookPos {
                        chapter: head,
                        offset: selection.head,
                    },
                    window,
                    cx,
                )
            });
        }
        if focused {
            self.editor.read(cx).focus_handle(cx).focus(window, cx);
        }

        if let Some(at) = at {
            self.restore(&at, cx);
        }
        cx.emit(BookEditorEvent::Reloaded);
        cx.notify();
    }

    /// Rebuilds the view (reusing already open sessions) at the same reading
    /// position.
    pub fn reload(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Result<(), WsError> {
        let sections = list(&self.ws, &self.book, &self.from)?;
        let (listed, _) = partition(&sections);
        let missing: Vec<Listed> = listed
            .iter()
            .filter(|c| !self.index.contains_key(&c.doc))
            .cloned()
            .collect();
        // Finish every fallible read before taking ownership of the live sessions.
        let mut fresh = open_all(&self.ws, &self.book, &missing)?;
        if !fresh.is_empty() {
            match anchors::book_comment_anchors(&self.ws, &self.book) {
                Ok(mut by_doc) => {
                    for (doc, listed) in fresh.iter_mut().zip(&missing) {
                        for (id, anchor) in by_doc.remove(&listed.doc).unwrap_or_default() {
                            doc.set_anchor(id, anchor);
                        }
                    }
                }
                Err(error) => log::warn!("dr-editor: new manuscript comment anchors: {error}"),
            }
        }
        let held = self
            .editor
            .update(cx, |e, _| std::mem::take(&mut e.book_mut().chapters));
        let mut docs: HashMap<String, ProseDoc> = self
            .chapters
            .iter()
            .zip(held)
            .map(|(l, c)| (l.doc.clone(), c.doc))
            .collect();
        docs.extend(missing.into_iter().zip(fresh).map(|(l, d)| (l.doc, d)));
        let docs = listed
            .iter()
            .map(|l| {
                docs.remove(&l.doc)
                    .expect("every listed document was opened")
            })
            .collect();
        self.install_sections(sections, docs, window, cx);
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

    /// The starting level entry's id.
    pub fn from_entry(&self) -> &str {
        self.from.as_str()
    }

    /// Every flattened section in reading order, including prose-less entries.
    pub fn sections(&self) -> &[BookSection] {
        &self.sections
    }

    /// Prose-less section headings rendered immediately before chapter `chapter`.
    pub fn headings_before(&self, chapter: usize) -> &[SectionHeading] {
        self.headings
            .before
            .get(chapter)
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    /// Prose-less section headings rendered after the last prose chapter.
    pub fn headings_after(&self) -> &[SectionHeading] {
        &self.headings.after_last
    }

    /// Hierarchy depth of prose chapter `chapter` relative to `from`.
    pub fn chapter_depth(&self, chapter: usize) -> Option<u32> {
        self.chapters.get(chapter).map(|c| c.depth)
    }

    /// Entry id owning prose chapter `chapter`.
    pub fn chapter_entry(&self, chapter: usize) -> Option<&str> {
        self.chapters.get(chapter).map(|c| c.entry.as_str())
    }

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

    /// The paragraph or title at the top of the view.
    pub fn reading_position(&self, cx: &App) -> Option<ReadingPosition> {
        let editor = self.editor.read(cx);
        let book = editor.book();
        if book.chapters.is_empty() {
            if !self.sections.is_empty() {
                let offset = (-f32::from(self.empty_scroll.offset().y)).max(0.);
                if offset > 0. {
                    return Some(ReadingPosition {
                        doc: String::new(),
                        block: None,
                        paragraph: 0,
                        offset,
                        at_title: true,
                    });
                }
            }
            return None;
        }
        let top = editor.list_state().logical_scroll_top();
        match book.item(top.item_ix.min(book.item_count().saturating_sub(1))) {
            Item::Title(c) => Some(ReadingPosition {
                doc: self.chapters.get(c)?.doc.clone(),
                block: None,
                paragraph: 0,
                offset: f32::from(top.offset_in_item),
                at_title: true,
            }),
            Item::Line(c, l) => {
                let doc = &book.chapters[c].doc;
                Some(ReadingPosition {
                    doc: self.chapters.get(c)?.doc.clone(),
                    block: doc
                        .lines()
                        .get(l)
                        .and_then(|ln| ln.bid())
                        .map(str::to_owned),
                    paragraph: l,
                    offset: f32::from(top.offset_in_item),
                    at_title: false,
                })
            }
            // Past a chapter's text, at its end: its last paragraph.
            Item::End(c) => {
                let doc = &book.chapters[c].doc;
                let paragraph = doc.visible_lines().saturating_sub(1);
                Some(ReadingPosition {
                    doc: self.chapters.get(c)?.doc.clone(),
                    block: doc
                        .lines()
                        .get(paragraph)
                        .and_then(|ln| ln.bid())
                        .map(str::to_owned),
                    paragraph,
                    offset: 0.,
                    at_title: false,
                })
            }
        }
    }

    /// Scrolls back to a reading position (by block id, else by paragraph
    /// index, or to the chapter's title / preceding headings when `at_title`
    /// is set; a chapter that is gone leaves the view where it is).
    pub fn restore(&mut self, at: &ReadingPosition, cx: &mut Context<Self>) -> bool {
        if at.doc.is_empty() && self.chapters.is_empty() && !self.sections.is_empty() {
            self.empty_scroll.set_offset(point(px(0.), px(-at.offset)));
            cx.notify();
            return true;
        }
        let Some(chapter) = self.chapter_of(&at.doc) else {
            return false;
        };
        self.editor.update(cx, |e, cx| {
            let item = if at.at_title {
                e.book().chapter_item(chapter)
            } else {
                let doc = &e.book().chapters[chapter].doc;
                let paragraph = at
                    .block
                    .as_deref()
                    .and_then(|b| doc.line_by_bid(b))
                    .unwrap_or(at.paragraph)
                    .min(doc.visible_lines().saturating_sub(1));
                e.book().line_item(chapter, paragraph)
            };
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
        self.pages.set_style(style.clone(), &self.editor, cx);
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
        self.pages.set_style(style.clone(), &self.editor, cx);
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
        self.pages.set_style(style.clone(), &self.editor, cx);
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
        let style = self.settings.style_for(&self.base_style, self.immersive);
        let empty_sections = self.chapters.is_empty() && !self.sections.is_empty();
        div()
            .size_full()
            .relative()
            .bg(style.background)
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
            .child({
                crate::assist::wrap_module(&self.assist, ProseEditor::element(&self.editor, cx))
                    .into_any_element()
            })
            .when(empty_sections, |el| {
                let headings: Vec<gpui::AnyElement> = self
                    .sections
                    .iter()
                    .enumerate()
                    .map(|(ix, s)| {
                        crate::page::render_section_heading(
                            &SectionHeading {
                                entry: s.entry.clone(),
                                title: s.title.clone(),
                                depth: s.depth,
                            },
                            &style,
                            ix == 0,
                            ix > 0,
                        )
                    })
                    .collect();
                el.child(
                    div()
                        .id("book-editor-empty-sections")
                        .absolute()
                        .inset_0()
                        .overflow_y_scroll()
                        .track_scroll(&self.empty_scroll)
                        .pb(px(80.))
                        .children(headings),
                )
            })
    }
}
