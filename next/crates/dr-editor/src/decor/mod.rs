//! Drifting's paint layers on the open documents: what gpui-prose's
//! decorations (F4d) show in Drifting, and the two F3 commands that follow
//! the editor (F3 round three). One [`Layers`] per editor, one part per
//! chapter of it: a [`ChapterEditor`] has one, the whole book
//! ([`BookEditor`], M05) one per chapter.
//!
//! | group | what | from |
//! | --- | --- | --- |
//! | `comments` | each open comment's and TODO's dry swash, with a tick | the book document's comments, anchors resolved on each prose document's holder thread |
//! | `agent` | the Agent's words in green (new) or purple (rewritten), another editor's in blue; the pointer's touch lets them go | [`ledger::AgentMarks`] (settlement records) |
//! | `links` | entity links' dry underline (gone targets in grey) | the entity marks on the text |
//! | `suggestions` | names [`dr_text`]'s matcher finds that are not linked yet: grains only | `book_link_names` of the book |
//! | `todo-marks` | the `TODO` / `待办` keyword in the TODO colour | the TODO markers |
//! | find | F4c's matches, the current one stronger | gpui-prose reads them itself ([`DecorLooks::find_wash`]) |
//!
//! Comments talk to the Review panel through [`focus::ReviewFocus`]:
//! pointing at a card turns its sand hot, resting the pointer on sand in the
//! prose lights its card, and jumping to a comment (from its card or its
//! tick) shows it and draws it again along its rows until the author clicks
//! in the prose or types.
//!
//! The commands: an undo that brings anchored text back re-anchors the
//! comments (`comment.reanchor`, sent again freely); the TODO markers are
//! projected into TODOs whenever they change, the caret moves to another
//! paragraph or the editor loses focus (`todo.project`, always the whole
//! list of the chapter; `editing` names the caret's paragraph only while the
//! editor has focus). Nothing here decides authorship by an origin prefix:
//! Agent marks come from settlement records, which only Agent writes leave,
//! so the author's commands (`user:command`) are never coloured.
//!
//! In the whole book the links are found a slice of chapters at a time
//! (the caret's chapter first), so opening a long book does not stall a
//! frame.

pub mod focus;
pub mod ledger;
pub mod looks;
pub mod original;

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::ops::Range;
use std::rc::Rc;
use std::time::Duration;

use dr_doc::book::{BookReader, Collection};
use dr_model::book::EncodedAnchor;
use dr_model::id::BookId;
use dr_model::kind::{CommentKind, CommentStatus};
use dr_store::OpenDoc;
use dr_text::autolink::book_link_names;
use dr_text::{LinkMatcher, LinkTarget};
use dr_workspace::commands::comment::{
    CommentReanchor, CommentReanchorIn, CommentUpdate, CommentUpdateIn, TodoMarkerIn, TodoProject,
    TodoProjectIn,
};
use dr_workspace::dto::AnchorBytes;
use dr_workspace::{Actor, Workspace, WsEvent};
use futures::StreamExt;
use futures::channel::mpsc;
use gpui::{App, AppContext, Context, Entity, Focusable, Subscription, Task, WeakEntity, Window};
use gpui_prose::render::{Decoration, DecorationEvent, Emphasis, Look, Tick, TickLane, Touch};
use gpui_prose::schema::inline;
use gpui_prose::{EditorEvent, HostStep, ProseEditor, ProseExtension};

use crate::anchors;
use crate::book::{BookEditor, BookEditorEvent};
use crate::links::{DriftingExtension, link_kind};
use crate::source::{EventCount, SessionSource};
use crate::todo::{self, TodoMarker};
use crate::view::{ChapterEditor, ChapterEditorEvent};

pub use focus::ReviewFocus;
pub use ledger::{AgentMarks, Mark, MarkKind};
pub use looks::{DecorLooks, block_style};
pub use original::{Original, original};

/// How long the links wait after the last keystroke before they are found
/// again (the old client's anchors waited 150 ms).
const LINKS_SETTLE: Duration = Duration::from_millis(150);

/// How many characters the links are looked for in before the next slice
/// waits for a frame (the whole book is found a slice at a time).
const LINKS_SLICE: usize = 60_000;

/// Ranges are found on the documents' holder threads; when the editor shows
/// another state of a document by the time they arrive (an Agent's write
/// in between), they are found again after this long, a few times at most.
const RESOLVE_AGAIN: Duration = Duration::from_millis(20);
const RESOLVE_TRIES: u32 = 8;

/// An open comment on a document, where it is.
#[derive(Clone, Debug, PartialEq)]
struct CommentMark {
    id: String,
    todo: bool,
    /// Where it was found; once handed to the editor, the editor moves it
    /// with every edit and [`Layers::current_comments`] reads it back.
    range: Range<usize>,
    /// Handed to the editor.
    drawn: bool,
}

/// One chapter of the editor.
struct Part {
    doc: String,
    comments: Vec<CommentMark>,
    /// Comments or Agent marks were handed to the editor (so an empty list
    /// has to be handed too, to take them away).
    had_comments: bool,
    had_agent: bool,
    /// Its links are to be found again.
    links_dirty: bool,
}

impl Part {
    fn new(doc: String) -> Part {
        Part {
            doc,
            comments: Vec::new(),
            had_comments: false,
            had_agent: false,
            links_dirty: true,
        }
    }
}

/// What a host keeps: its editor's [`Layers`] and the forwarding of its own
/// events (the TODO markers) to them.
pub(crate) struct Decor {
    layers: Entity<Layers>,
    _host: Subscription,
}

impl Decor {
    /// The paint layers of a chapter editor showing `doc` of `book`.
    pub(crate) fn new(
        ws: &Workspace,
        book: &str,
        doc: &str,
        editor: &Entity<ProseEditor>,
        extension: Rc<DriftingExtension>,
        window: &mut Window,
        cx: &mut Context<ChapterEditor>,
    ) -> Decor {
        let docs = vec![doc.to_owned()];
        let layers = cx.new(|cx| Layers::new(ws, book, docs, editor, extension, window, cx));
        let l = layers.clone();
        let host = cx.subscribe_self(move |_, e: &ChapterEditorEvent, cx| {
            if let ChapterEditorEvent::TodoMarkers(markers) = e {
                let markers = markers.clone();
                l.update(cx, |l, cx| l.markers_changed(0, &markers, cx));
            }
        });
        Decor {
            layers,
            _host: host,
        }
    }

    /// The paint layers of the whole book, one part per chapter (`docs` in
    /// reading order).
    pub(crate) fn for_book(
        ws: &Workspace,
        book: &str,
        docs: Vec<String>,
        editor: &Entity<ProseEditor>,
        extension: Rc<DriftingExtension>,
        window: &mut Window,
        cx: &mut Context<BookEditor>,
    ) -> Decor {
        let layers = cx.new(|cx| Layers::new(ws, book, docs, editor, extension, window, cx));
        let l = layers.clone();
        let host = cx.subscribe_self(move |_, e: &BookEditorEvent, cx| {
            if let BookEditorEvent::TodoMarkers { doc, markers } = e {
                let (doc, markers) = (doc.clone(), markers.clone());
                l.update(cx, |l, cx| {
                    if let Some(chapter) = l.index.get(&doc).copied() {
                        l.markers_changed(chapter, &markers, cx);
                    }
                });
            }
        });
        Decor {
            layers,
            _host: host,
        }
    }

    /// The same layers on another document (the chapter view switched).
    pub(crate) fn rebind(
        &mut self,
        ws: &Workspace,
        book: &str,
        doc: &str,
        editor: &Entity<ProseEditor>,
        window: &mut Window,
        cx: &mut Context<ChapterEditor>,
    ) {
        let (looks, extension) = self.carried(cx);
        *self = Decor::new(ws, book, doc, editor, extension, window, cx);
        self.keep_looks(looks, cx);
    }

    /// The same layers on a rebuilt book view.
    pub(crate) fn rebind_book(
        &mut self,
        ws: &Workspace,
        book: &str,
        docs: Vec<String>,
        editor: &Entity<ProseEditor>,
        window: &mut Window,
        cx: &mut Context<BookEditor>,
    ) {
        let (looks, extension) = self.carried(cx);
        *self = Decor::for_book(ws, book, docs, editor, extension, window, cx);
        self.keep_looks(looks, cx);
    }

    fn carried(&self, cx: &App) -> (Option<Rc<DecorLooks>>, Rc<DriftingExtension>) {
        let l = self.layers.read(cx);
        (l.looks.clone(), l.extension.clone())
    }

    fn keep_looks(&self, looks: Option<Rc<DecorLooks>>, cx: &mut App) {
        if let Some(looks) = looks {
            self.layers.update(cx, |l, cx| l.apply_looks(looks, cx));
        }
    }

    /// Takes the theme's looks and shows everything with them.
    pub(crate) fn set_looks(&self, looks: DecorLooks, cx: &mut App) {
        self.layers
            .update(cx, |l, cx| l.apply_looks(Rc::new(looks), cx));
    }

    /// The layers (tests and hosts that want to look).
    pub fn layers(&self) -> &Entity<Layers> {
        &self.layers
    }
}

/// The paint layers of one editor.
pub struct Layers {
    ws: Workspace,
    book: String,
    editor: WeakEntity<ProseEditor>,
    extension: Rc<DriftingExtension>,
    looks: Option<Rc<DecorLooks>>,
    marks: Entity<AgentMarks>,
    parts: Vec<Part>,
    index: HashMap<String, usize>,
    names: Option<Rc<LinkMatcher<LinkTarget>>>,
    /// The jump last shown, so a repeated notice does not scroll again.
    shown_jump: u64,
    /// The paragraph last sent as `editing` with `todo.project`, and its
    /// chapter.
    editing: Option<(usize, String)>,
    focused: bool,
    links_task: Option<Task<()>>,
    _subs: Vec<Subscription>,
    _ws: dr_workspace::events::Subscription,
}

/// What the workspace told the layers.
#[derive(Clone, PartialEq, Eq)]
enum Notice {
    Comments,
    Book,
    Prose(String),
}

impl Layers {
    fn new(
        ws: &Workspace,
        book: &str,
        docs: Vec<String>,
        editor: &Entity<ProseEditor>,
        extension: Rc<DriftingExtension>,
        window: &mut Window,
        cx: &mut Context<Layers>,
    ) -> Layers {
        let marks = AgentMarks::of(ws, cx);
        let focus = editor.read(cx).focus_handle(cx);
        let subs = vec![
            cx.subscribe_in(
                editor,
                window,
                |this, _, e: &DecorationEvent, window, cx| this.on_decoration(e, window, cx),
            ),
            cx.subscribe_in(
                editor,
                window,
                |this, _, e: &EditorEvent, window, cx| match e {
                    EditorEvent::SelectionChanged => this.on_selection(cx),
                    EditorEvent::Edited { chapter } => this.links_soon(Some(*chapter), window, cx),
                    // An undo brought anchored text back: the comments' new
                    // anchors are stored.
                    EditorEvent::AnchorsChanged { changes, .. } => {
                        let changes: Vec<(String, EncodedAnchor)> = changes
                            .iter()
                            .map(|c| (c.id.to_string(), anchors::encode(&c.anchor)))
                            .collect();
                        this.reanchor(&changes, cx);
                    }
                },
            ),
            cx.subscribe(&marks, |this, _, e: &ledger::MarksChanged, cx| {
                if let Some(chapter) = this.index.get(&e.doc).copied() {
                    this.load_agent(chapter, 0, cx);
                }
            }),
            cx.observe_global_in::<ReviewFocus>(window, |this, window, cx| {
                this.on_review_focus(window, cx)
            }),
            cx.on_focus_in(&focus, window, |this, _, cx| {
                this.focused = true;
                this.on_selection(cx);
            }),
            cx.on_focus_out(&focus, window, |this, _, _, cx| {
                this.focused = false;
                if let Some((chapter, _)) = this.editing.take() {
                    let markers = this.markers(chapter, cx);
                    this.send_projection(chapter, &markers, None, cx);
                }
            }),
        ];
        let index = docs
            .iter()
            .enumerate()
            .map(|(i, d)| (d.clone(), i))
            .collect();
        let ws_sub = Self::watch(ws, book, &docs, window, cx);
        let mut layers = Layers {
            ws: ws.clone(),
            book: book.to_owned(),
            editor: editor.downgrade(),
            extension,
            looks: None,
            marks,
            parts: docs.into_iter().map(Part::new).collect(),
            index,
            names: None,
            shown_jump: 0,
            editing: None,
            focused: false,
            links_task: None,
            _subs: subs,
            _ws: ws_sub,
        };
        layers.load_comments(0, cx);
        layers.load_names(cx);
        layers
    }

    /// Comment and book changes, and others' writes to the documents, moved
    /// to the main thread.
    fn watch(
        ws: &Workspace,
        book: &str,
        docs: &[String],
        window: &mut Window,
        cx: &mut Context<Layers>,
    ) -> dr_workspace::events::Subscription {
        let (tx, mut rx) = mpsc::unbounded::<Notice>();
        let book = book.to_owned();
        let docs: HashSet<String> = docs.iter().cloned().collect();
        let sub = ws.subscribe(move |e| {
            let notice = match e {
                WsEvent::Book(b) if b.book.to_string() == book => {
                    if b.changes
                        .iter()
                        .any(|c| c.collection == Collection::Comments)
                    {
                        Some(Notice::Comments)
                    } else {
                        Some(Notice::Book)
                    }
                }
                WsEvent::Prose(p) => {
                    let doc = p.doc.to_string();
                    docs.contains(&doc).then_some(Notice::Prose(doc))
                }
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
                    if notices.contains(&Notice::Comments) {
                        this.load_comments(0, cx);
                    }
                    if notices.contains(&Notice::Book) || notices.contains(&Notice::Comments) {
                        this.load_names(cx);
                    }
                    for n in &notices {
                        if let Notice::Prose(doc) = n
                            && let Some(chapter) = this.index.get(doc).copied()
                        {
                            this.links_soon(Some(chapter), window, cx);
                        }
                    }
                });
                if alive.is_err() {
                    break;
                }
            }
        })
        .detach();
        sub
    }

    fn apply_looks(&mut self, looks: Rc<DecorLooks>, cx: &mut Context<Layers>) {
        self.extension.set_dry_underline(true);
        if let Some(editor) = self.editor.upgrade() {
            let l = looks.clone();
            editor.update(cx, |e, cx| {
                e.set_tick_seals(l.seals(), cx);
                e.set_block_style(l.block.clone(), cx);
                e.set_reduce_motion(l.reduce_motion, cx);
                e.set_find_look(Some(l.find_wash()), cx);
            });
        }
        self.looks = Some(looks);
        for chapter in 0..self.parts.len() {
            self.submit_comments(chapter, cx);
            self.load_agent(chapter, 0, cx);
            self.parts[chapter].links_dirty = true;
        }
        self.run_links_now(cx);
    }

    /// The chapter of `doc`.
    pub fn chapter_of(&self, doc: &str) -> Option<usize> {
        self.index.get(doc).copied()
    }

    // ----- comments -------------------------------------------------------------------

    /// Reads every open comment's anchor and where it is now.
    fn load_comments(&mut self, tried: u32, cx: &mut Context<Layers>) {
        let (ws, book) = (self.ws.clone(), self.book.clone());
        let docs: Vec<(String, Option<EventCount>)> = (0..self.parts.len())
            .map(|c| (self.parts[c].doc.clone(), self.event_count(c, cx)))
            .collect();
        cx.spawn(async move |this, cx| {
            if tried > 0 {
                cx.background_executor().timer(RESOLVE_AGAIN).await;
            }
            let found = cx
                .background_executor()
                .spawn(async move { comment_ranges(&ws, &book, docs) })
                .await;
            this.update(cx, |this, cx| match found {
                Ok(read) => {
                    // Task items linked to a TODO show its state.
                    if this.extension.set_todos(read.todos)
                        && let Some(editor) = this.editor.upgrade()
                    {
                        editor.update(cx, |_, cx| cx.notify());
                    }
                    let stale = read
                        .chapters
                        .iter()
                        .any(|(chapter, (_, seen))| !this.shows(*chapter, *seen, cx));
                    if stale && tried < RESOLVE_TRIES {
                        this.load_comments(tried + 1, cx);
                    } else {
                        this.took_comments(read.chapters, cx);
                    }
                }
                Err(e) => log::warn!("dr-editor: comment anchors: {e}"),
            })
            .ok();
        })
        .detach();
    }

    /// The holder's event count of chapter `chapter`'s document.
    fn event_count(&self, chapter: usize, cx: &App) -> Option<EventCount> {
        let editor = self.editor.upgrade()?;
        editor
            .read(cx)
            .book()
            .chapters
            .get(chapter)?
            .doc
            .source_as::<SessionSource>()
            .map(SessionSource::event_count)
    }

    /// Whether the editor shows the state of a chapter's document a holder
    /// job saw (`seen` events); positions found in that job fit only then.
    fn shows(&self, chapter: usize, seen: Option<u64>, cx: &App) -> bool {
        let Some(seen) = seen else {
            return true;
        };
        self.editor
            .upgrade()
            .and_then(|e| {
                e.read(cx)
                    .book()
                    .chapters
                    .get(chapter)?
                    .doc
                    .source_as::<SessionSource>()
                    .map(|s| s.taken() == seen)
            })
            .unwrap_or(true)
    }

    fn took_comments(&mut self, found: Vec<(usize, Seen<CommentFound>)>, cx: &mut Context<Layers>) {
        let mut found: HashMap<usize, CommentFound> =
            found.into_iter().map(|(c, (f, _))| (c, f)).collect();
        // The editor carries the anchors through deletions and undo.
        if let Some(editor) = self.editor.upgrade() {
            editor.update(cx, |e, _| {
                for (chapter, list) in &found {
                    let Some(c) = e.book_mut().chapters.get_mut(*chapter) else {
                        continue;
                    };
                    for (id, _, anchor, _) in list {
                        if let Some(a) = anchors::decode(anchor) {
                            c.doc.set_anchor(id.clone(), a);
                        }
                    }
                }
            });
        }
        for chapter in 0..self.parts.len() {
            let list = found.remove(&chapter).unwrap_or_default();
            let part = &mut self.parts[chapter];
            if list.is_empty() && !part.had_comments && part.comments.is_empty() {
                continue;
            }
            part.comments = list
                .into_iter()
                .filter_map(|(id, todo, _, range)| {
                    Some(CommentMark {
                        id,
                        todo,
                        range: range?,
                        drawn: false,
                    })
                })
                .collect();
            self.submit_comments(chapter, cx);
        }
    }

    /// Brings a chapter's comment ranges up to where the editor has moved
    /// them (typing, undo, an Agent's write); one whose words the edits took
    /// away is dropped, as the editor dropped it.
    fn current_comments(&mut self, chapter: usize, cx: &App) {
        let Some(editor) = self.editor.upgrade() else {
            return;
        };
        let e = editor.read(cx);
        self.parts[chapter].comments.retain_mut(|c| {
            if !c.drawn {
                return true;
            }
            match e.decoration_range(chapter, "comments", &c.id) {
                Some(r) => {
                    c.range = r;
                    true
                }
                None => false,
            }
        });
    }

    fn submit_comments(&mut self, chapter: usize, cx: &mut Context<Layers>) {
        let (Some(looks), Some(editor)) = (self.looks.clone(), self.editor.upgrade()) else {
            return;
        };
        if self.parts[chapter].comments.is_empty() && !self.parts[chapter].had_comments {
            return;
        }
        self.current_comments(chapter, cx);
        let part = &mut self.parts[chapter];
        for c in &mut part.comments {
            c.drawn = true;
        }
        part.had_comments = !part.comments.is_empty();
        let focus = ReviewFocus::get(cx);
        let decorations: Vec<Decoration> = part
            .comments
            .iter()
            .map(|c| {
                let (wash, color) = if c.todo {
                    (looks.todo_wash(), looks.todo_ink)
                } else {
                    (looks.comment_wash(), looks.comment)
                };
                let emphasis = match &focus.jump {
                    Some(j) if j.comment == c.id => Emphasis::Drawn(j.serial),
                    _ if focus.cards.contains(&c.id) => Emphasis::Hot,
                    _ => Emphasis::Rest,
                };
                Decoration::new(c.id.clone(), c.range.clone(), Look::Wash(wash))
                    .touch(Touch::POINT)
                    .emphasis(emphasis)
                    .tick(Tick {
                        color,
                        lane: TickLane::Span,
                    })
            })
            .collect();
        editor.update(cx, |e, cx| {
            e.set_decorations(chapter, "comments", decorations, cx)
        });
    }

    fn on_review_focus(&mut self, window: &mut Window, cx: &mut Context<Layers>) {
        for chapter in 0..self.parts.len() {
            self.submit_comments(chapter, cx);
        }
        let focus = ReviewFocus::get(cx);
        let Some(jump) = focus.jump.filter(|j| j.serial != self.shown_jump) else {
            return;
        };
        let found = (0..self.parts.len()).find_map(|chapter| {
            self.current_comments(chapter, cx);
            self.parts[chapter]
                .comments
                .iter()
                .find(|c| c.id == jump.comment)
                .map(|c| (chapter, c.range.clone()))
        });
        let Some((chapter, range)) = found else {
            return;
        };
        self.shown_jump = jump.serial;
        if let Some(editor) = self.editor.upgrade() {
            editor.update(cx, |e, cx| {
                // The caret at its start brings it into view; the sand is
                // drawn along its rows (`Emphasis::Drawn`).
                e.select(chapter, range.start..range.start, window, cx);
            });
        }
    }

    fn on_decoration(
        &mut self,
        e: &DecorationEvent,
        window: &mut Window,
        cx: &mut Context<Layers>,
    ) {
        match e {
            DecorationEvent::TaskClicked { chapter, line } => {
                self.tick_task(*chapter, *line, window, cx)
            }
            DecorationEvent::Pointed { ids } => {
                let comments = ids
                    .iter()
                    .filter(|(_, k)| k.group == "comments")
                    .map(|(_, k)| k.id.to_string())
                    .collect();
                ReviewFocus::point_prose(comments, cx);
            }
            DecorationEvent::Touched { chapter, key } if key.group == "agent" => {
                let Some(doc) = self.parts.get(*chapter).map(|p| p.doc.clone()) else {
                    return;
                };
                let id = key.id.to_string();
                self.marks
                    .update(cx, |m, cx| m.forget(&doc, &[id.as_str()], cx));
            }
            DecorationEvent::Settled { key, .. } if key.group == "comments" => {
                ReviewFocus::settle(&key.id, cx);
            }
            DecorationEvent::TickClicked { key, .. } if key.group == "comments" => {
                ReviewFocus::jump(&key.id, cx);
            }
            _ => {}
        }
    }

    /// A task item's box was clicked: a task linked to a TODO completes or
    /// reopens that TODO (`comment.update`); any other task flips its
    /// `checked` (one undo step of its own).
    fn tick_task(
        &mut self,
        chapter: usize,
        line: usize,
        window: &mut Window,
        cx: &mut Context<Layers>,
    ) {
        let Some(editor) = self.editor.upgrade() else {
            return;
        };
        let (todo, checked) = {
            let e = editor.read(cx);
            let Some(c) = e.book().chapters.get(chapter) else {
                return;
            };
            if line >= c.doc.visible_lines() {
                return;
            }
            let attrs = &c.doc.line(line).block;
            let todo = match attrs.get(gpui_prose::schema::block::TODO) {
                Some(loro::LoroValue::String(id)) if !id.is_empty() => Some(id.to_string()),
                _ => None,
            };
            let checked = matches!(
                attrs.get(gpui_prose::schema::block::CHECKED),
                Some(loro::LoroValue::Bool(true))
            );
            (todo, checked)
        };
        if let Some(id) = todo {
            let done = self.extension.task_done(&id).unwrap_or(false);
            let input = CommentUpdateIn {
                book: self.book.clone(),
                id: id.clone(),
                body: None,
                status: Some(if done { "open" } else { "resolved" }.into()),
                priority: None,
                kind: None,
                agent_conversation: None,
            };
            let ws = self.ws.clone();
            cx.background_executor()
                .spawn(async move {
                    if let Err(e) = ws.run::<CommentUpdate>(&Actor::User, input) {
                        log::warn!("dr-editor: comment.update {id}: {e}");
                    }
                })
                .detach();
            return;
        }
        editor.update(cx, |e, cx| {
            e.edit_chapter(chapter, HostStep::Own, window, cx, |doc| {
                let value = (!checked).then_some(loro::LoroValue::Bool(true));
                doc.set_block_attr(
                    line,
                    gpui_prose::schema::block::CHECKED,
                    value,
                    gpui_prose::text::ORIGIN_USER,
                );
                None
            });
        });
    }

    // ----- Agent marks ----------------------------------------------------------------

    fn load_agent(&mut self, chapter: usize, tried: u32, cx: &mut Context<Layers>) {
        if self.looks.is_none() {
            return;
        }
        let part = &self.parts[chapter];
        let marks: Vec<Mark> = self.marks.read(cx).marks(&part.doc).to_vec();
        if marks.is_empty() && !part.had_agent {
            return;
        }
        let (ws, doc) = (self.ws.clone(), part.doc.clone());
        let count = self.event_count(chapter, cx);
        cx.spawn(async move |this, cx| {
            if tried > 0 {
                cx.background_executor().timer(RESOLVE_AGAIN).await;
            }
            let found = cx
                .background_executor()
                .spawn(async move { resolve_marks(&ws, &doc, marks, count) })
                .await;
            this.update(cx, |this, cx| match found {
                Ok((_, seen)) if !this.shows(chapter, seen, cx) && tried < RESOLVE_TRIES => {
                    this.load_agent(chapter, tried + 1, cx);
                }
                Ok((found, _)) => this.took_agent(chapter, found, cx),
                Err(e) => log::warn!("dr-editor: Agent marks: {e}"),
            })
            .ok();
        })
        .detach();
    }

    fn took_agent(&mut self, chapter: usize, found: Vec<Placed>, cx: &mut Context<Layers>) {
        let (Some(looks), Some(editor)) = (self.looks.clone(), self.editor.upgrade()) else {
            return;
        };
        // Words edited away, and older marks a newer Agent change covers.
        let mut gone: Vec<String> = Vec::new();
        let mut kept: Vec<(Mark, Range<usize>)> = Vec::new();
        for (mark, range) in found {
            match range {
                Some(r) if !r.is_empty() => kept.push((mark, r)),
                _ => gone.push(mark.id.clone()),
            }
        }
        let serial = |m: &Mark| m.id.trim_start_matches('m').parse::<u64>().unwrap_or(0);
        let covered: HashSet<String> = kept
            .iter()
            .filter(|(old, r)| {
                kept.iter()
                    .any(|(new, s)| serial(new) > serial(old) && s.start < r.end && r.start < s.end)
            })
            .map(|(m, _)| m.id.clone())
            .collect();
        gone.extend(covered.iter().cloned());
        kept.retain(|(m, _)| !covered.contains(&m.id));
        let doc = self.parts[chapter].doc.clone();
        if !gone.is_empty() {
            let ids: Vec<&str> = gone.iter().map(String::as_str).collect();
            self.marks.update(cx, |m, cx| m.forget(&doc, &ids, cx));
        }
        self.parts[chapter].had_agent = !kept.is_empty();
        let decorations = kept
            .into_iter()
            .map(|(mark, range)| {
                let (color, lane) = match mark.kind {
                    MarkKind::New => (looks.agent_new, 0),
                    MarkKind::Changed => (looks.agent_changed, 1),
                    MarkKind::External => (looks.external, 1),
                };
                Decoration::new(mark.id, range, Look::Ink(color))
                    .touch(Touch::Fade)
                    .tick(Tick {
                        color,
                        lane: TickLane::Lane(lane),
                    })
            })
            .collect();
        editor.update(cx, |e, cx| {
            e.set_decorations(chapter, "agent", decorations, cx)
        });
    }

    // ----- links, suggestions, TODO keywords ---------------------------------------------

    fn load_names(&mut self, cx: &mut Context<Layers>) {
        let (ws, book) = (self.ws.clone(), self.book.clone());
        // A single document's own entity is not suggested in its own text.
        let own = match self.parts.as_slice() {
            [one] => one.doc.clone(),
            _ => String::new(),
        };
        cx.spawn(async move |this, cx| {
            let found = cx
                .background_executor()
                .spawn(async move { link_names(&ws, &book, &own) })
                .await;
            this.update(cx, |this, cx| match found {
                Ok(matcher) => {
                    this.names = Some(Rc::new(matcher));
                    for part in &mut this.parts {
                        part.links_dirty = true;
                    }
                    this.run_links_now(cx);
                }
                Err(e) => log::warn!("dr-editor: link names: {e}"),
            })
            .ok();
        })
        .detach();
    }

    /// Finds a chapter's links again (`None`: every chapter's) once the
    /// typing settles.
    fn links_soon(
        &mut self,
        chapter: Option<usize>,
        window: &mut Window,
        cx: &mut Context<Layers>,
    ) {
        match chapter {
            Some(c) if c < self.parts.len() => self.parts[c].links_dirty = true,
            Some(_) => return,
            None => self.parts.iter_mut().for_each(|p| p.links_dirty = true),
        }
        self.links_task = Some(cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(LINKS_SETTLE).await;
            Self::links_slices(this, cx).await;
        }));
    }

    /// Finds the dirty chapters' links now, a slice at a time.
    fn run_links_now(&mut self, cx: &mut Context<Layers>) {
        if self.looks.is_none() || !self.parts.iter().any(|p| p.links_dirty) {
            return;
        }
        if self.parts.len() == 1 {
            // One chapter: at once (its marks show with the looks).
            self.links_slice(cx);
            return;
        }
        self.links_task = Some(cx.spawn(async move |this, cx| {
            Self::links_slices(this, cx).await;
        }));
    }

    async fn links_slices(this: WeakEntity<Layers>, cx: &mut gpui::AsyncApp) {
        loop {
            let more = this.update(cx, |this, cx| this.links_slice(cx));
            match more {
                Ok(true) => {
                    cx.background_executor()
                        .timer(Duration::from_millis(1))
                        .await
                }
                _ => break,
            }
        }
    }

    /// One slice of dirty chapters, the caret's first. Whether any are left.
    fn links_slice(&mut self, cx: &mut Context<Layers>) -> bool {
        let (Some(looks), Some(editor)) = (self.looks.clone(), self.editor.upgrade()) else {
            return false;
        };
        let caret = editor.read(cx).selection().chapter;
        let mut order: Vec<usize> = (0..self.parts.len())
            .filter(|c| self.parts[*c].links_dirty)
            .collect();
        order.sort_by_key(|c| (*c != caret, c.abs_diff(caret)));
        let mut budget = LINKS_SLICE;
        for chapter in order {
            if budget == 0 {
                return true;
            }
            let found = {
                let e = editor.read(cx);
                let Some(c) = e.book().chapters.get(chapter) else {
                    continue;
                };
                budget = budget.saturating_sub(c.doc.len_chars().max(1));
                find_links(e, chapter, &self.extension, self.names.as_deref())
            };
            self.parts[chapter].links_dirty = false;
            let links = found
                .links
                .into_iter()
                .enumerate()
                .map(|(ix, (range, alive))| {
                    Decoration::new(
                        format!("l{ix}"),
                        range,
                        Look::Underline(looks.entity_underline(alive)),
                    )
                    .touch(Touch::HOVER)
                })
                .collect();
            let suggestions = found
                .suggestions
                .into_iter()
                .enumerate()
                .map(|(ix, range)| {
                    Decoration::new(format!("s{ix}"), range, Look::Underline(looks.suggestion()))
                })
                .collect();
            let keywords = found
                .keywords
                .into_iter()
                .enumerate()
                .map(|(ix, range)| {
                    Decoration::new(format!("t{ix}"), range, Look::Ink(looks.todo_ink))
                })
                .collect();
            editor.update(cx, |e, cx| {
                e.set_decorations(chapter, "links", links, cx);
                e.set_decorations(chapter, "suggestions", suggestions, cx);
                e.set_decorations(chapter, "todo-marks", keywords, cx);
            });
        }
        false
    }

    // ----- the F3 commands ----------------------------------------------------------------

    fn reanchor(&self, changes: &[(String, EncodedAnchor)], cx: &mut Context<Layers>) {
        let (ws, book) = (self.ws.clone(), self.book.clone());
        let changes = changes.to_vec();
        cx.background_executor()
            .spawn(async move {
                for (id, anchor) in changes {
                    let input = CommentReanchorIn {
                        book: book.clone(),
                        id: id.clone(),
                        anchor: Some(Some(AnchorBytes::from(&anchor))),
                    };
                    if let Err(e) = ws.run::<CommentReanchor>(&Actor::User, input) {
                        log::warn!("dr-editor: comment.reanchor {id}: {e}");
                    }
                }
            })
            .detach();
    }

    /// The caret's chapter and paragraph, while the editor has focus.
    fn caret_block(&self, cx: &App) -> Option<(usize, String)> {
        if !self.focused {
            return None;
        }
        let editor = self.editor.upgrade()?;
        let e = editor.read(cx);
        let sel = e.selection();
        let doc = &e.book().chapters.get(sel.chapter)?.doc;
        let line = doc.line_of(sel.head);
        let block = doc.lines().get(line)?.bid()?.to_owned();
        Some((sel.chapter, block))
    }

    /// A chapter's TODO markers, as the editor holds the text.
    fn markers(&self, chapter: usize, cx: &App) -> Vec<TodoMarker> {
        let Some(editor) = self.editor.upgrade() else {
            return Vec::new();
        };
        let e = editor.read(cx);
        let Some(c) = e.book().chapters.get(chapter) else {
            return Vec::new();
        };
        let doc = &c.doc;
        todo::markers(
            doc.lines()[..doc.visible_lines()]
                .iter()
                .map(|l| (l.text.as_ref(), l.bid())),
        )
    }

    /// The caret moved (or the editor got focus): a TODO typed in the
    /// paragraph it left is written now.
    fn on_selection(&mut self, cx: &mut Context<Layers>) {
        let editing = self.caret_block(cx);
        if editing == self.editing {
            return;
        }
        let left = std::mem::replace(&mut self.editing, editing.clone());
        let Some((chapter, block)) = left else {
            return;
        };
        let markers = self.markers(chapter, cx);
        if markers
            .iter()
            .any(|m| m.block.as_deref() == Some(block.as_str()))
        {
            let still = editing.filter(|(c, _)| *c == chapter).map(|(_, b)| b);
            self.send_projection(chapter, &markers, still, cx);
        }
    }

    /// A chapter's TODO markers changed: projected with the whole list.
    fn markers_changed(
        &mut self,
        chapter: usize,
        markers: &[TodoMarker],
        cx: &mut Context<Layers>,
    ) {
        if chapter >= self.parts.len() {
            return;
        }
        let editing = self.caret_block(cx);
        self.editing = editing.clone();
        let still = editing.filter(|(c, _)| *c == chapter).map(|(_, b)| b);
        self.send_projection(chapter, markers, still, cx);
        // The keyword's colour at once.
        self.parts[chapter].links_dirty = true;
        self.run_links_now(cx);
    }

    fn send_projection(
        &self,
        chapter: usize,
        markers: &[TodoMarker],
        editing: Option<String>,
        cx: &mut Context<Layers>,
    ) {
        let Some(part) = self.parts.get(chapter) else {
            return;
        };
        let input = TodoProjectIn {
            doc: part.doc.clone(),
            markers: markers
                .iter()
                .filter_map(|m| {
                    Some(TodoMarkerIn {
                        block: m.block.clone()?,
                        task: m.task.clone(),
                    })
                })
                .collect(),
            editing,
        };
        let ws = self.ws.clone();
        cx.background_executor()
            .spawn(async move {
                if let Err(e) = ws.run::<TodoProject>(&Actor::User, input) {
                    log::warn!("dr-editor: todo.project: {e}");
                }
            })
            .detach();
    }
}

impl ChapterEditor {
    /// The theme's looks for the paint layers (call again when the theme or
    /// the reduce-motion setting changes). Until then nothing is drawn.
    pub fn set_decor_looks(&mut self, looks: DecorLooks, cx: &mut Context<Self>) {
        self.decor.set_looks(looks, cx);
    }

    /// The editor's paint layers.
    pub fn decor_layers(&self) -> &Entity<Layers> {
        self.decor.layers()
    }
}

impl BookEditor {
    /// The theme's looks for the paint layers of every chapter (call again
    /// when the theme or the reduce-motion setting changes).
    pub fn set_decor_looks(&mut self, looks: DecorLooks, cx: &mut Context<Self>) {
        self.decor.set_looks(looks, cx);
    }

    /// The book's paint layers.
    pub fn decor_layers(&self) -> &Entity<Layers> {
        self.decor.layers()
    }
}

// ----- work off the main thread ---------------------------------------------------------

/// `(id, is TODO, anchor, range now)` of every open anchored comment on a
/// document; ranges are resolved on the document's holder thread.
type CommentFound = Vec<(String, bool, EncodedAnchor, Option<Range<usize>>)>;

/// Found on the holder thread, with the event count it saw there.
type Seen<T> = (T, Option<u64>);

/// The open anchored comments of `docs` (one read of the book document),
/// each document's resolved on its holder: `(chapter, (found, seen))` for
/// every chapter, empty where there are none.
/// What one read of the comments gives: each chapter's open anchored
/// comments, and whether each TODO of the book is done.
struct CommentsRead {
    chapters: Vec<(usize, Seen<CommentFound>)>,
    todos: HashMap<String, bool>,
}

fn comment_ranges(
    ws: &Workspace,
    book: &str,
    docs: Vec<(String, Option<EventCount>)>,
) -> Result<CommentsRead, String> {
    let book_id = BookId::parse(book).map_err(|e| e.to_string())?;
    let handle = ws
        .library()
        .open_doc(&format!("book:{book}"), OpenDoc::Existing)
        .map_err(|e| e.to_string())?;
    let wanted: HashSet<String> = docs.iter().map(|(d, _)| d.clone()).collect();
    let (mut by_doc, todos) = handle
        .read(move |d| {
            let reader = BookReader::from_loro(book_id, d)?;
            let mut out: HashMap<String, Vec<(String, bool, EncodedAnchor)>> = HashMap::new();
            let mut todos = HashMap::new();
            for c in reader.view().comments() {
                if c.kind == CommentKind::Todo {
                    todos.insert(c.id.to_string(), c.is_done());
                }
                if c.status != CommentStatus::Open || c.target_missing {
                    continue;
                }
                let (Some(t), Some(a)) = (c.target.as_ref(), c.anchor.as_ref()) else {
                    continue;
                };
                let doc = format!("{}:{}", t.kind.as_str(), t.id);
                if wanted.contains(&doc) {
                    out.entry(doc).or_default().push((
                        c.id.to_string(),
                        c.kind == CommentKind::Todo,
                        a.clone(),
                    ));
                }
            }
            Ok::<_, dr_doc::DocError>((out, todos))
        })
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(docs.len());
    for (chapter, (doc, count)) in docs.into_iter().enumerate() {
        let Some(open) = by_doc.remove(&doc) else {
            out.push((chapter, (Vec::new(), None)));
            continue;
        };
        let handle = ws
            .library()
            .open_doc(&doc, OpenDoc::Existing)
            .map_err(|e| e.to_string())?;
        let found = handle
            .read(move |d| {
                let found = open
                    .into_iter()
                    .map(|(id, todo, enc)| {
                        let range = anchors::decode(&enc)
                            .and_then(|a| a.resolve(d))
                            .filter(|r| !r.collapsed)
                            .map(|r| r.range);
                        (id, todo, enc, range)
                    })
                    .collect();
                (found, count.as_ref().map(EventCount::now))
            })
            .map_err(|e| e.to_string())?;
        out.push((chapter, found));
    }
    Ok(CommentsRead {
        chapters: out,
        todos,
    })
}

/// A mark and where it is now (`None`: its words are gone).
type Placed = (Mark, Option<Range<usize>>);

fn resolve_marks(
    ws: &Workspace,
    doc: &str,
    marks: Vec<Mark>,
    count: Option<EventCount>,
) -> Result<Seen<Vec<Placed>>, String> {
    if marks.is_empty() {
        return Ok((Vec::new(), None));
    }
    let handle = ws
        .library()
        .open_doc(doc, OpenDoc::Existing)
        .map_err(|e| e.to_string())?;
    handle
        .read(move |d| {
            let placed = marks
                .into_iter()
                .map(|m| {
                    let range = anchors::decode(&m.anchor)
                        .and_then(|a| a.resolve(d))
                        .filter(|r| !r.collapsed)
                        .map(|r| r.range);
                    (m, range)
                })
                .collect();
            (placed, count.as_ref().map(EventCount::now))
        })
        .map_err(|e| e.to_string())
}

/// The names the book's links can go to, for suggestions (the document's own
/// entity left out).
fn link_names(ws: &Workspace, book: &str, doc: &str) -> Result<LinkMatcher<LinkTarget>, String> {
    let book_id = BookId::parse(book).map_err(|e| e.to_string())?;
    let own = doc
        .split_once(':')
        .map(|(_, id)| id.to_owned())
        .unwrap_or_default();
    let handle = ws
        .library()
        .open_doc(&format!("book:{book}"), OpenDoc::Existing)
        .map_err(|e| e.to_string())?;
    let names = handle
        .read(move |d| {
            BookReader::from_loro(book_id, d).map(|r| book_link_names(&r.view(), &[own.as_str()]))
        })
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    Ok(LinkMatcher::new(names))
}

/// What the text says about links, suggestions and TODO keywords.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct FoundLinks {
    /// Entity-linked runs and whether their target is alive.
    pub links: Vec<(Range<usize>, bool)>,
    /// Names not linked yet.
    pub suggestions: Vec<Range<usize>>,
    /// TODO keywords.
    pub keywords: Vec<Range<usize>>,
}

/// One pass over a chapter's paragraphs (scalar offsets of the chapter).
pub(crate) fn find_links(
    editor: &ProseEditor,
    chapter: usize,
    extension: &DriftingExtension,
    names: Option<&LinkMatcher<LinkTarget>>,
) -> FoundLinks {
    let doc = &editor.book().chapters[chapter].doc;
    let mut found = FoundLinks::default();
    let mut start = 0;
    let alive_memo: RefCell<std::collections::HashMap<String, bool>> = RefCell::default();
    for line in &doc.lines()[..doc.visible_lines()] {
        let mut linked: Vec<Range<usize>> = Vec::new();
        for span in line.spans.iter() {
            let mut target = None;
            for (key, value) in span.marks.iter() {
                if let Some(id) = inline::entity_target(key) {
                    let kind = link_kind(value);
                    let alive = *alive_memo
                        .borrow_mut()
                        .entry(id.to_owned())
                        .or_insert_with(|| extension.alive(&kind, id));
                    target = Some(target.unwrap_or(false) || alive);
                }
            }
            if let Some(alive) = target {
                let range = line.char_of_byte(span.range.start)..line.char_of_byte(span.range.end);
                found
                    .links
                    .push((start + range.start..start + range.end, alive));
                linked.push(range);
            }
        }
        if let Some(matcher) = names {
            for m in matcher.find(&line.text) {
                if !linked
                    .iter()
                    .any(|l| l.start < m.range.end && m.range.start < l.end)
                {
                    found
                        .suggestions
                        .push(start + m.range.start..start + m.range.end);
                }
            }
        }
        if let Some((marker, _)) = todo::parse(&line.text) {
            let keyword_end = line
                .text
                .chars()
                .skip(marker.start)
                .take(marker.len())
                .take_while(|c| c.is_alphanumeric())
                .count();
            found
                .keywords
                .push(start + marker.start..start + marker.start + keyword_end.max(1));
        }
        start += line.chars + 1;
    }
    found
}
