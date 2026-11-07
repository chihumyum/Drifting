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
    /// The selection bar's 添加批注 on `range` (characters) of the text,
    /// which reads `text`: the host opens its comment composer there.
    CommentRequested { range: Range<usize>, text: String },
}

struct Catalog(BookCatalog);

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
    _editor_events: Subscription,
    _ws_events: dr_workspace::events::Subscription,
}

impl EventEmitter<ChapterEditorEvent> for ChapterEditor {}

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
        let (editor, editor_events) = Self::editor_on(
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
            a
        });
        let events = cx.subscribe(
            &assist,
            |this, _, event: &crate::assist::AssistEvent, cx| {
                let crate::assist::AssistEvent::Comment { range, .. } = event;
                let text = this.editor.read(cx).book().chapters[0]
                    .doc
                    .slice(range.clone());
                cx.emit(ChapterEditorEvent::CommentRequested {
                    range: range.clone(),
                    text,
                });
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
    ) -> Result<(Entity<ProseEditor>, Subscription), WsError> {
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
    ) -> (Entity<ProseEditor>, Subscription) {
        let mut doc = ProseDoc::open(Box::new(source));
        match anchors::comment_anchors(ws, book, doc_id) {
            Ok(found) => {
                for (id, anchor) in found {
                    doc.set_anchor(id, anchor);
                }
            }
            Err(e) => log::warn!("dr-editor: comment anchors of {doc_id}: {e}"),
        }
        let book = Book::new(vec![Chapter {
            title: title.to_owned().into(),
            doc,
        }]);
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
        (editor, events)
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
            self.extension.invalidate();
            self.assist.update(cx, |a, _| a.invalidate_names());
            if self.pages.has_chrome() {
                self.refresh_page(cx);
            }
            cx.notify();
        }
        if notices.contains(&Notice::Prose) {
            // The author's own edits are already folded in; this drains what
            // someone else committed.
            self.editor.update(cx, |e, cx| e.refresh_chapter(0, cx));
            self.update_todos(cx);
        }
    }

    fn on_editor(&mut self, event: &EditorEvent, cx: &mut Context<Self>) {
        match event {
            EditorEvent::Edited { .. } => {
                cx.emit(ChapterEditorEvent::Edited);
                self.update_todos(cx);
                self.pages.edited(0, &self.editor, cx);
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
        let style = self.settings.style(&self.base_style);
        let (editor, events) = Self::make_editor(
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
        self.doc_id = doc_id.to_owned();
        if self.pages.has_chrome() {
            self.pages.attach(&self.editor, cx);
            self.refresh_page(cx);
        }
        let (editor, docs) = (self.editor.clone(), vec![self.doc_id.clone()]);
        self.assist
            .update(cx, |a, cx| a.attach(editor, docs, window, cx));
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
        let style = self.settings.style(&self.base_style);
        self.editor.update(cx, |e, cx| e.set_style(style, cx));
        let auto = self.settings.auto_entity_links;
        self.assist.update(cx, |a, _| a.set_auto_links(auto));
        cx.notify();
    }

    /// Colours and fonts (the shell's theme); the settings still apply.
    pub fn set_base_style(&mut self, style: ProseStyle, cx: &mut Context<Self>) {
        self.base_style = style;
        let style = self.settings.style(&self.base_style);
        self.editor.update(cx, |e, cx| e.set_style(style, cx));
        cx.notify();
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Notice {
    Prose,
    Book,
}

impl Render for ChapterEditor {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        crate::assist::wrap(&self.assist, ProseEditor::element(&self.editor, cx))
    }
}
