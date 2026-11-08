//! The editor on the paper: one prose document of the workspace in a
//! gpui-prose editor, ready for the shell (F6) to place.
//!
//! ```ignore
//! let editor = cx.new(|cx| ChapterEditor::open(ws.clone(), &book, "node:<id>", settings, window, cx))?;
//! // in the page: editor.clone().into_any_element()
//! editor.update(cx, |e, cx| e.switch_to("node:<other>", window, cx))?;     // another chapter
//! editor.update(cx, |e, cx| e.set_settings(EditorSettings::from_values(..), cx));
//! cx.subscribe(&editor, |_, _, event: &ChapterEditorEvent, _| ..);          // edits, TODO markers, anchors
//! ```
//!
//! - The author's typing goes through the [`SessionSource`] (a workspace
//!   session): every keystroke is persisted, indexed for search and word
//!   counts and announced on the workspace's bus like a command's write.
//! - Someone else's change to the open document (an Agent's command, a sync,
//!   an undo of an Agent's turn) arrives as the workspace's `Prose` event on
//!   the holder thread; the view moves it to the main thread and folds it
//!   into the editor. A `Book` event makes entity links look their targets up
//!   again.
//! - Comment anchors on the document are loaded when it opens. When an undo
//!   brings anchored text back, the editor re-anchors them and the view
//!   reports the new anchors ([`ChapterEditorEvent::AnchorsChanged`]) for the
//!   book document (the command that stores them is F3's; see f4-editor.md).

use std::cell::RefCell;
use std::ops::Range;
use std::rc::Rc;

use dr_model::book::EncodedAnchor;
use dr_workspace::{BookCatalog, Workspace, WsError, WsEvent};
use futures::StreamExt;
use futures::channel::mpsc;
use gpui::{
    App, AppContext, Context, Entity, EventEmitter, IntoElement, Render, Subscription, Window,
};
use gpui_prose::{Book, Chapter, EditorEvent, ProseDoc, ProseEditor, ProseStyle};

use crate::anchors;
use crate::embeds::{NoteEmbeds, NoteEvent, NoteHost};
use crate::links::{DriftingExtension, LinkTargets};
use crate::settings::EditorSettings;
use crate::source::SessionSource;
use crate::todo::{self, TodoMarker};

/// What the view tells its host.
#[derive(Clone, Debug, PartialEq)]
pub enum ChapterEditorEvent {
    /// The author changed the document.
    Edited,
    /// The TODO markers in the document changed (for projecting them into
    /// TODOs).
    TodoMarkers(Vec<TodoMarker>),
    /// An undo re-anchored these comments: `(comment id, new anchor)`, to be
    /// stored in the book document.
    AnchorsChanged(Vec<(String, EncodedAnchor)>),
}

/// The selection bar's 添加批注: the host opens its comment composer on
/// `range` (characters) of document `doc`, which reads `text`. Its own event
/// type (both views emit it), so hosts matching every
/// [`ChapterEditorEvent`] are not broken by it.
#[derive(Clone, Debug, PartialEq)]
pub struct CommentRequested {
    pub doc: String,
    pub range: Range<usize>,
    pub text: String,
}

struct Catalog(BookCatalog);

/// A document's editor, its events, and a note's embeds.
type EditorParts = (Entity<ProseEditor>, Subscription, Option<Rc<NoteEmbeds>>);

impl LinkTargets for Catalog {
    fn alive(&self, kind: &dr_model::kind::EntityKind, id: &str) -> bool {
        self.0.alive(kind, id)
    }
}

/// One prose document of the workspace, being edited.
pub struct ChapterEditor {
    ws: Workspace,
    book: String,
    doc_id: String,
    title: String,
    base_style: ProseStyle,
    settings: EditorSettings,
    extension: Rc<DriftingExtension>,
    editor: Entity<ProseEditor>,
    todos: Vec<TodoMarker>,
    /// The page around the text: its facts and the host's chrome (M03).
    pages: crate::page::Pages,
    /// The pickers, automatic links and the selection bar.
    assist: Entity<crate::assist::Assist>,
    _assist_events: Subscription,
    /// The paint layers: comments, Agent changes, links (crate::decor).
    pub(crate) decor: crate::decor::Decor,
    /// A material note's tables and materials (`None` elsewhere).
    embeds: Option<Rc<NoteEmbeds>>,
    /// Immersive writing: typewriter scrolling forced on (M26).
    immersive: bool,
    _editor_events: Subscription,
    _ws_events: dr_workspace::events::Subscription,
}

impl EventEmitter<ChapterEditorEvent> for ChapterEditor {}
impl EventEmitter<CommentRequested> for ChapterEditor {}
impl EventEmitter<PositionLinkCopied> for ChapterEditor {}
impl EventEmitter<EntityLinkOpened> for ChapterEditor {}
impl EventEmitter<MaterialOpened> for ChapterEditor {}
impl EventEmitter<WritingTyped> for ChapterEditor {}

/// The author started writing in `doc`: typed text, an input method's
/// confirmed text, Enter (in a note's table cells too); not a paste, a
/// deletion or an undo ([`gpui_prose::AuthorTyped`]). The shell begins
/// immersive writing on it when 「打字时自动沉浸」 is on (M26). Both views
/// emit it; its own event type, like [`CommentRequested`].
#[derive(Clone, Debug, PartialEq)]
pub struct WritingTyped {
    pub doc: String,
}

/// A click on a material embedded in note `doc`: the host opens material
/// `material` (in a tab, as the 0.1 client did). Its own event type, like
/// [`CommentRequested`].
#[derive(Clone, Debug, PartialEq)]
pub struct MaterialOpened {
    pub doc: String,
    pub material: String,
}

/// A plain click on a live entity link in `doc`: the host opens what it
/// links to (`kind`, `id`), in a preview tab as the 0.1 client did. Its own
/// event type, like [`CommentRequested`].
#[derive(Clone, Debug, PartialEq)]
pub struct EntityLinkOpened {
    pub doc: String,
    pub kind: dr_model::kind::EntityKind,
    pub id: String,
}

/// The slash menu's 位置链接 put `link` (to a paragraph of `doc`) on the
/// clipboard: the host may say so (a toast). Its own event type, like
/// [`CommentRequested`].
#[derive(Clone, Debug, PartialEq)]
pub struct PositionLinkCopied {
    pub doc: String,
    pub link: String,
}

impl ChapterEditor {
    /// Opens prose document `doc_id` of `book` for the author.
    pub fn open(
        ws: Workspace,
        book: &str,
        doc_id: &str,
        settings: EditorSettings,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Result<ChapterEditor, WsError> {
        let source = SessionSource::open(&ws, doc_id)?;
        Ok(Self::with_session(
            ws, book, doc_id, source, settings, window, cx,
        ))
    }

    /// [`ChapterEditor::open`] on a session the host already opened (on a
    /// background thread, say: the slow half, reading the document from
    /// SQLite). Cannot fail, so it fits in `cx.new`.
    pub fn with_session(
        ws: Workspace,
        book: &str,
        doc_id: &str,
        source: SessionSource,
        settings: EditorSettings,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> ChapterEditor {
        let base_style = ProseStyle::default();
        let extension = Rc::new(Self::extension(&ws, book));
        let (editor, editor_events, embeds) = Self::editor_on(
            &ws,
            book,
            doc_id,
            source,
            "",
            &settings.style(&base_style),
            &extension,
            window,
            cx,
        );
        let ws_events = Self::watch(&ws, doc_id, window, cx);
        let (assist, assist_events) =
            Self::make_assist(&ws, book, &editor, doc_id, &settings, window, cx);
        let decor =
            crate::decor::Decor::new(&ws, book, doc_id, &editor, extension.clone(), window, cx);
        let mut this = ChapterEditor {
            ws,
            book: book.to_owned(),
            doc_id: doc_id.to_owned(),
            title: String::new(),
            base_style,
            settings,
            extension,
            editor,
            todos: Vec::new(),
            pages: Default::default(),
            assist,
            _assist_events: assist_events,
            decor,
            embeds,
            immersive: false,
            _editor_events: editor_events,
            _ws_events: ws_events,
        };
        this.todos = this.find_todos(cx);
        this
    }

    #[allow(clippy::too_many_arguments)]
    fn make_assist(
        ws: &Workspace,
        book: &str,
        editor: &Entity<ProseEditor>,
        doc_id: &str,
        settings: &EditorSettings,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> (Entity<crate::assist::Assist>, Subscription) {
        let assist = cx.new(|cx| {
            let mut a = crate::assist::Assist::new(
                ws.clone(),
                book,
                editor.clone(),
                vec![doc_id.to_owned()],
                window,
                cx,
            );
            a.set_auto_links(settings.auto_entity_links);
            a.set_note(is_note(doc_id));
            a
        });
        let events = cx.subscribe_in(
            &assist,
            window,
            |this, _, event: &crate::assist::AssistEvent, window, cx| match event {
                crate::assist::AssistEvent::Comment { range, .. } => {
                    let text = this.editor.read(cx).book().chapters[0]
                        .doc
                        .slice(range.clone());
                    cx.emit(CommentRequested {
                        doc: this.doc_id.clone(),
                        range: range.clone(),
                        text,
                    });
                }
                crate::assist::AssistEvent::LinkCopied { link, .. } => {
                    cx.emit(PositionLinkCopied {
                        doc: this.doc_id.clone(),
                        link: link.clone(),
                    });
                }
                crate::assist::AssistEvent::OpenLink { target, .. } => {
                    cx.emit(EntityLinkOpened {
                        doc: this.doc_id.clone(),
                        kind: target.kind.clone(),
                        id: target.id.clone(),
                    });
                }
                crate::assist::AssistEvent::InsertTable { .. } => {
                    this.insert_table(window, cx);
                }
                crate::assist::AssistEvent::InsertMaterial { material, .. } => {
                    this.insert_material(material, window, cx);
                }
            },
        );
        (assist, events)
    }

    fn extension(ws: &Workspace, book: &str) -> DriftingExtension {
        let targets = ws
            .catalog(book)
            .ok()
            .map(|c| Box::new(Catalog(c)) as Box<dyn LinkTargets>);
        DriftingExtension::new(targets)
    }

    #[allow(clippy::too_many_arguments)]
    fn make_editor(
        ws: &Workspace,
        book: &str,
        doc_id: &str,
        title: &str,
        style: &ProseStyle,
        extension: &Rc<DriftingExtension>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Result<EditorParts, WsError> {
        let source = SessionSource::open(ws, doc_id)?;
        Ok(Self::editor_on(
            ws, book, doc_id, source, title, style, extension, window, cx,
        ))
    }

    #[allow(clippy::too_many_arguments)]
    fn editor_on(
        ws: &Workspace,
        book: &str,
        doc_id: &str,
        source: SessionSource,
        title: &str,
        style: &ProseStyle,
        extension: &Rc<DriftingExtension>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> EditorParts {
        // A material note draws its tables and materials (`embeds.rs`); they
        // write through the note's own session.
        let note = dr_model::DocId::parse(doc_id)
            .ok()
            .and_then(|d| d.profile())
            == Some(dr_model::ProseProfile::Note);
        let shared = note.then(|| (source.shared_session(), source.handle().clone()));
        extension.set_note(note);
        let mut doc = ProseDoc::open(Box::new(source));
        match anchors::comment_anchors(ws, book, doc_id) {
            Ok(found) => {
                for (id, anchor) in found {
                    doc.set_anchor(id, anchor);
                }
            }
            Err(e) => log::warn!("dr-editor: comment anchors of {doc_id}: {e}"),
        }
        let prose = Book::new(vec![Chapter {
            title: title.to_owned().into(),
            doc,
        }]);
        let body_style = style.clone();
        let ext = extension.clone();
        // Typed `- `, `1. `, `[ ] ` make list items where the document keeps
        // lists (material notes); never in chapters.
        let editor = cx.new(|cx| {
            let mut editor = ProseEditor::new(prose, body_style, window, cx);
            editor.set_extension(ext);
            editor.set_list_shortcuts(note);
            editor
        });
        let events = cx.subscribe(&editor, |this, _, event: &EditorEvent, cx| {
            this.on_editor(event, cx)
        });
        let typed = cx.subscribe(&editor, |this, _, _: &gpui_prose::AuthorTyped, cx| {
            cx.emit(WritingTyped {
                doc: this.doc_id.clone(),
            })
        });
        let events = Subscription::join(events, typed);
        let embeds = shared.map(|(session, handle)| {
            let weak = cx.weak_entity();
            let host = NoteHost {
                ws: ws.clone(),
                book: book.to_owned(),
                doc_id: doc_id.to_owned(),
                session,
                handle,
                body: editor.downgrade(),
                chapter: 0,
                style: RefCell::new(style.clone()),
                extension: extension.clone(),
                // Deferred: an embed may report from inside this view's own
                // update (inserting a table).
                notify: Rc::new(move |event: NoteEvent, cx: &mut App| {
                    let weak = weak.clone();
                    cx.defer(move |cx| {
                        if let Some(this) = weak.upgrade() {
                            this.update(cx, |this, cx| this.on_note(event, cx));
                        }
                    });
                }),
            };
            let embeds = Rc::new(NoteEmbeds::new(Rc::new(host)));
            let views: Rc<dyn gpui_prose::EmbedViews> = embeds.clone();
            editor.update(cx, |e, cx| {
                e.set_embed_views(Some(views), cx);
                crate::highlight::decorate(e, 0, cx);
            });
            embeds
        });
        (editor, events, embeds)
    }

    fn on_note(&mut self, event: NoteEvent, cx: &mut Context<Self>) {
        match event {
            NoteEvent::Edited => cx.emit(ChapterEditorEvent::Edited),
            NoteEvent::OpenMaterial(material) => cx.emit(MaterialOpened {
                doc: self.doc_id.clone(),
                material,
            }),
            NoteEvent::Typed => cx.emit(WritingTyped {
                doc: self.doc_id.clone(),
            }),
        }
    }

    /// The workspace's events, moved to the main thread.
    fn watch(
        ws: &Workspace,
        doc_id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> dr_workspace::events::Subscription {
        let (tx, mut rx) = mpsc::unbounded::<Notice>();
        let watched = doc_id.to_owned();
        let sub = ws.subscribe(move |e| {
            let notice = match e {
                WsEvent::Prose(p) if p.doc.to_string() == watched => Some(Notice::Prose),
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
                let alive = this.update(cx, |this, cx| this.on_workspace(&notices, cx));
                if alive.is_err() {
                    break;
                }
            }
        })
        .detach();
        sub
    }

    fn on_workspace(&mut self, notices: &[Notice], cx: &mut Context<Self>) {
        if notices.contains(&Notice::Book) {
            if let Some(embeds) = &self.embeds {
                embeds.book_changed(cx);
            }
            self.extension.invalidate();
            self.assist.update(cx, |a, cx| a.invalidate_names(cx));
            if self.pages.has_chrome() {
                self.refresh_page(cx);
            }
            cx.notify();
        }
        if notices.contains(&Notice::Prose) {
            // The author's own edits are already folded in; this drains what
            // someone else committed.
            self.editor.update(cx, |e, cx| e.refresh_chapter(0, cx));
            if let Some(embeds) = &self.embeds {
                embeds.refresh(cx);
                self.editor
                    .update(cx, |e, cx| crate::highlight::decorate(e, 0, cx));
            }
            self.update_todos(cx);
        }
    }

    fn on_editor(&mut self, event: &EditorEvent, cx: &mut Context<Self>) {
        match event {
            EditorEvent::Edited { .. } => {
                cx.emit(ChapterEditorEvent::Edited);
                self.update_todos(cx);
                self.pages.edited(0, &self.editor, cx);
                if let Some(embeds) = &self.embeds {
                    embeds.refresh(cx);
                    self.editor
                        .update(cx, |e, cx| crate::highlight::decorate(e, 0, cx));
                }
            }
            EditorEvent::AnchorsChanged { changes, .. } => {
                let changes = changes
                    .iter()
                    .map(|c| (c.id.to_string(), anchors::encode(&c.anchor)))
                    .collect();
                cx.emit(ChapterEditorEvent::AnchorsChanged(changes));
            }
            _ => {}
        }
    }

    fn find_todos(&self, cx: &App) -> Vec<TodoMarker> {
        let editor = self.editor.read(cx);
        let doc = &editor.book().chapters[0].doc;
        todo::markers(
            doc.lines()[..doc.visible_lines()]
                .iter()
                .map(|l| (l.text.as_ref(), l.bid())),
        )
    }

    fn update_todos(&mut self, cx: &mut Context<Self>) {
        let todos = self.find_todos(cx);
        if todos != self.todos {
            self.todos = todos.clone();
            cx.emit(ChapterEditorEvent::TodoMarkers(todos));
        }
    }

    /// Edits another prose document (another chapter, an idea …) in this view.
    pub fn switch_to(
        &mut self,
        doc_id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Result<(), WsError> {
        if doc_id == self.doc_id {
            return Ok(());
        }
        let style = self.settings.style_for(&self.base_style, self.immersive);
        let (editor, events, embeds) = Self::make_editor(
            &self.ws,
            &self.book,
            doc_id,
            &self.title,
            &style,
            &self.extension,
            window,
            cx,
        )?;
        self._ws_events = Self::watch(&self.ws, doc_id, window, cx);
        self.editor = editor;
        self._editor_events = events;
        self.embeds = embeds;
        self.doc_id = doc_id.to_owned();
        if self.pages.has_chrome() {
            self.pages.attach(&self.editor, cx);
            self.refresh_page(cx);
        }
        let (editor, docs) = (self.editor.clone(), vec![self.doc_id.clone()]);
        let note = is_note(doc_id);
        self.assist.update(cx, |a, cx| {
            a.attach(editor, docs, window, cx);
            a.set_note(note);
        });
        self.decor
            .rebind(&self.ws, &self.book, doc_id, &self.editor, window, cx);
        self.todos = self.find_todos(cx);
        cx.emit(ChapterEditorEvent::TodoMarkers(self.todos.clone()));
        cx.notify();
        Ok(())
    }

    /// Applies new settings (sizes, spacing, paper width).
    pub fn set_settings(&mut self, settings: EditorSettings, cx: &mut Context<Self>) {
        if settings == self.settings {
            return;
        }
        self.settings = settings;
        let style = self.settings.style_for(&self.base_style, self.immersive);
        if let Some(embeds) = &self.embeds {
            embeds.restyle(style.clone(), cx);
        }
        self.editor.update(cx, |e, cx| e.set_style(style, cx));
        let auto = self.settings.auto_entity_links;
        self.assist.update(cx, |a, _| a.set_auto_links(auto));
        cx.notify();
    }

    /// Colours and fonts (the shell's theme); the settings still apply.
    pub fn set_base_style(&mut self, style: ProseStyle, cx: &mut Context<Self>) {
        self.base_style = style;
        let style = self.settings.style_for(&self.base_style, self.immersive);
        if let Some(embeds) = &self.embeds {
            embeds.restyle(style.clone(), cx);
        }
        let note = self.embeds.is_some();
        self.editor.update(cx, |e, cx| {
            e.set_style(style, cx);
            if note {
                crate::highlight::decorate(e, 0, cx);
            }
        });
        cx.notify();
    }

    /// Immersive writing (M26), which the shell turns on and off with its
    /// chrome: typewriter scrolling is on whatever its setting says, on the
    /// setting's line (the caret goes there at once); off, the setting's own
    /// switch again. The paragraph fade stays with the editor that has the
    /// keyboard ([`ProseEditor::set_paragraph_focus`], the shell's call).
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

    pub fn doc_id(&self) -> &str {
        &self.doc_id
    }

    pub fn book_id(&self) -> &str {
        &self.book
    }

    pub fn settings(&self) -> &EditorSettings {
        &self.settings
    }

    /// The gpui-prose editor (selection, focus, reveal a paragraph …).
    pub fn editor(&self) -> &Entity<ProseEditor> {
        &self.editor
    }

    pub fn todo_markers(&self) -> &[TodoMarker] {
        &self.todos
    }

    /// The document's text as the editor holds it.
    pub fn plain_text(&self, cx: &App) -> String {
        self.editor.read(cx).book().chapters[0].doc.plain_text()
    }

    /// Draws the host's head and end around the text (M03: the folio line,
    /// the title, the synopsis, ⁂, the empty-chapter hint), or the editor's
    /// own title row again (`None`). See [`crate::page`].
    pub fn set_chrome(
        &mut self,
        chrome: Option<Rc<dyn crate::page::PageChrome>>,
        cx: &mut Context<Self>,
    ) {
        self.pages.set_chrome(chrome, &self.editor, cx);
        self.refresh_page(cx);
        cx.notify();
    }

    /// The page's facts as the chrome sees them.
    pub fn page_info(&self) -> Option<crate::page::PageInfo> {
        self.pages.info(0)
    }

    fn refresh_page(&mut self, cx: &mut Context<Self>) {
        self.pages.refresh(
            &self.ws,
            &self.book,
            std::slice::from_ref(&self.doc_id),
            &self.editor,
            cx,
        );
    }

    /// The pickers, automatic links and the selection bar (for tests and
    /// the shell's own checks).
    pub fn assist(&self) -> &Entity<crate::assist::Assist> {
        &self.assist
    }

    /// The caret at the start of the text, the editor focused (the title
    /// field's Enter, or ↓ at its end).
    pub fn focus_body(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.editor
            .update(cx, |e, cx| e.focus_chapter_start(0, window, cx));
    }
}

/// Whether `doc_id` is a material note (the note profile).
fn is_note(doc_id: &str) -> bool {
    dr_model::DocId::parse(doc_id)
        .ok()
        .and_then(|d| d.profile())
        == Some(dr_model::ProseProfile::Note)
}

impl ChapterEditor {
    /// A material note's tables and materials (`None` for other documents).
    pub fn note_embeds(&self) -> Option<&Rc<NoteEmbeds>> {
        self.embeds.as_ref()
    }

    /// The editor the author is typing in: the body, or a table's cell.
    pub fn focused_prose(&self, window: &Window, cx: &App) -> Option<Entity<ProseEditor>> {
        if gpui::Focusable::focus_handle(self.editor.read(cx), cx).is_focused(window) {
            return Some(self.editor.clone());
        }
        self.embeds
            .as_ref()?
            .tables()
            .into_iter()
            .find_map(|t| t.read(cx).focused_editor(window, cx))
    }

    /// The slash menu's 表格 in a material note: a 3 × 3 table at the caret,
    /// the caret in its first cell. Returns whether one was inserted.
    pub fn insert_table(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(embeds) = self.embeds.clone() else {
            return false;
        };
        let offset = self.editor.read(cx).selection().head;
        crate::embeds::insert_table(&embeds, offset, Vec::new(), Vec::new(), window, cx).is_some()
    }

    /// Embeds material `material` (an image or a PDF) at the caret of a
    /// material note. Returns whether it was.
    pub fn insert_material(
        &mut self,
        material: &str,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let (Some(embeds), Ok(id)) = (
            self.embeds.clone(),
            dr_model::id::MaterialId::parse(material),
        ) else {
            return false;
        };
        let offset = self.editor.read(cx).selection().head;
        crate::embeds::insert_material(&embeds, offset, id, cx).is_some()
    }

    /// ⌘⇧H in a material note: the highlight on the selection (or for what
    /// is typed next), in the body or the cell the author is in.
    pub fn toggle_highlight(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.embeds.is_none() {
            return;
        }
        let editor = self
            .focused_prose(window, cx)
            .unwrap_or_else(|| self.editor.clone());
        editor.update(cx, |e, cx| {
            e.toggle_mark_value(crate::highlight::KEY, crate::highlight::value(), window, cx)
        });
    }

    /// Copy or cut in a note's text over a selection holding embeds: a
    /// table alone goes as a table (tab-separated, its cells in the
    /// metadata); otherwise each embed as text (a table's rows, a
    /// material's title). Returns whether it handled the key.
    fn note_copy(&mut self, cut: bool, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(embeds) = self.embeds.clone() else {
            return false;
        };
        let e = self.editor.read(cx);
        if !gpui::Focusable::focus_handle(e, cx).is_focused(window) {
            return false;
        }
        let sel = e.selection();
        if sel.is_empty() || sel.spans_chapters() {
            return false;
        }
        let range = sel.range();
        let doc = &e.book().chapters[0].doc;
        let (first, _) = doc.locate(range.start);
        let (last, _) = doc.locate(range.end);
        let mut parts: Vec<(Option<String>, String)> = Vec::new();
        for line in first..=last.min(doc.visible_lines().saturating_sub(1)) {
            let start = doc.line_start(line);
            let l = doc.line(line);
            let from = range.start.max(start) - start;
            let to = range.end.min(start + l.chars).saturating_sub(start);
            match l.embed() {
                Some(id) if range.start <= start && range.end > start => {
                    parts.push((Some(id.to_owned()), String::new()))
                }
                _ => parts.push((
                    None,
                    l.text
                        .chars()
                        .skip(from)
                        .take(to.saturating_sub(from))
                        .collect(),
                )),
            }
        }
        if !parts.iter().any(|(id, _)| id.is_some()) {
            return false;
        }
        let item = match parts.as_slice() {
            [(Some(id), _)] => embeds
                .table_grid(id)
                .map(|(cells, marks)| crate::table::clip::table_item(&cells, &marks))
                .unwrap_or_else(|| gpui::ClipboardItem::new_string(embeds.embed_text(id))),
            _ => gpui::ClipboardItem::new_string(
                parts
                    .iter()
                    .map(|(id, text)| match id {
                        Some(id) => embeds.embed_text(id),
                        None => text.clone(),
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
            ),
        };
        cx.write_to_clipboard(item);
        if cut {
            self.editor
                .update(cx, |e, cx| e.press_backspace(window, cx));
        }
        true
    }

    /// Paste in a note's text: a copied table, or a tab-separated grid of
    /// at least 2 × 2, becomes a table at the caret. Returns whether it
    /// handled the key.
    fn note_paste(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(embeds) = self.embeds.clone() else {
            return false;
        };
        if !gpui::Focusable::focus_handle(self.editor.read(cx), cx).is_focused(window) {
            return false;
        }
        let Some(item) = cx.read_from_clipboard() else {
            return false;
        };
        let cells = crate::table::clip::table_from_clipboard(&item).or_else(|| {
            item.text()
                .and_then(|t| crate::table::clip::parse_grid(&t))
                .filter(|g| crate::table::clip::is_table(g))
        });
        let Some(cells) = cells else {
            return false;
        };
        if !self.editor.read(cx).selection().is_empty() {
            self.editor
                .update(cx, |e, cx| e.press_backspace(window, cx));
        }
        let offset = self.editor.read(cx).selection().head;
        let marks = crate::table::clip::marks_from_clipboard(&item);
        crate::embeds::insert_table(&embeds, offset, cells, marks, window, cx);
        true
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Notice {
    Prose,
    Book,
}

impl Render for ChapterEditor {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let inner = crate::assist::wrap(&self.assist, ProseEditor::element(&self.editor, cx));
        if self.embeds.is_none() {
            return inner.into_any_element();
        }
        // A material note: tables on the clipboard and the highlight key.
        use gpui::{InteractiveElement as _, ParentElement as _, Styled as _};
        use gpui_prose::input::actions::{Copy, Cut, Paste};
        gpui::div()
            .size_full()
            .capture_action(cx.listener(|this, _: &Copy, window, cx| {
                if this.note_copy(false, window, cx) {
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|this, _: &Cut, window, cx| {
                if this.note_copy(true, window, cx) {
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|this, _: &Paste, window, cx| {
                if this.note_paste(window, cx) {
                    cx.stop_propagation();
                }
            }))
            .on_action(
                cx.listener(|this, _: &crate::highlight::ToggleHighlight, window, cx| {
                    this.toggle_highlight(window, cx)
                }),
            )
            .child(inner)
            .into_any_element()
    }
}
