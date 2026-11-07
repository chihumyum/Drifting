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
    /// The paint layers: comments, Agent changes, links (crate::decor).
    pub(crate) decor: crate::decor::Decor,
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
        let base_style = ProseStyle::default();
        let extension = Rc::new(Self::extension(&ws, book));
        let (editor, editor_events) = Self::make_editor(
            &ws,
            book,
            doc_id,
            "",
            &settings.style(&base_style),
            &extension,
            window,
            cx,
        )?;
        let ws_events = Self::watch(&ws, doc_id, window, cx);
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
            decor,
            _editor_events: editor_events,
            _ws_events: ws_events,
        };
        this.todos = this.find_todos(cx);
        Ok(this)
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
        Ok((editor, events))
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
        let style = self.settings.style(&self.base_style);
        self.editor.update(cx, |e, cx| e.set_style(style, cx));
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
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Notice {
    Prose,
    Book,
}

impl Render for ChapterEditor {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        ProseEditor::element(&self.editor, cx)
    }
}
