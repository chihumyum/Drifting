//! Drifting's paint layers on the open document: what gpui-prose's
//! decorations (F4d) show in Drifting, and the two F3 commands that follow
//! the editor (F3 round three).
//!
//! | group | what | from |
//! | --- | --- | --- |
//! | `comments` | each open comment's and TODO's dry swash, with a tick | `comment.anchors`, resolved on the prose document's holder thread |
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
//! list; `editing` names the caret's paragraph only while the editor has
//! focus). Nothing here decides authorship by an origin prefix: Agent marks
//! come from settlement records, which only Agent writes leave, so the
//! author's commands (`user:command`) are never coloured.

pub mod focus;
pub mod ledger;
pub mod looks;

use std::cell::RefCell;
use std::collections::HashSet;
use std::ops::Range;
use std::rc::Rc;
use std::time::Duration;

use dr_doc::book::{BookReader, Collection};
use dr_model::book::EncodedAnchor;
use dr_model::id::BookId;
use dr_store::OpenDoc;
use dr_text::autolink::book_link_names;
use dr_text::{LinkMatcher, LinkTarget};
use dr_workspace::commands::comment::{
    CommentAnchors, CommentAnchorsIn, CommentReanchor, CommentReanchorIn, TodoMarkerIn,
    TodoProject, TodoProjectIn,
};
use dr_workspace::dto::{AnchorBytes, Target};
use dr_workspace::{Actor, Workspace, WsEvent};
use futures::StreamExt;
use futures::channel::mpsc;
use gpui::{App, Context, Entity, Focusable, Subscription, Task, WeakEntity, Window};
use gpui_prose::render::{Decoration, DecorationEvent, Emphasis, Look, Tick, TickLane, Touch};
use gpui_prose::schema::inline;
use gpui_prose::{EditorEvent, ProseEditor};

use crate::anchors;
use crate::links::{DriftingExtension, link_kind};
use crate::source::{EventCount, SessionSource};
use crate::todo::{self, TodoMarker};
use crate::view::{ChapterEditor, ChapterEditorEvent};

pub use focus::ReviewFocus;
pub use ledger::{AgentMarks, Mark, MarkKind};
pub use looks::DecorLooks;

/// How long the links wait after the last keystroke before they are found
/// again (the old client's anchors waited 150 ms).
const LINKS_SETTLE: Duration = Duration::from_millis(150);

/// Ranges are found on the document's holder thread; when the editor shows
/// another state of the document by the time they arrive (an Agent's write
/// in between), they are found again after this long, a few times at most.
const RESOLVE_AGAIN: Duration = Duration::from_millis(20);
const RESOLVE_TRIES: u32 = 8;

/// An open comment on the document, where it is.
#[derive(Clone, Debug, PartialEq)]
struct CommentMark {
    id: String,
    todo: bool,
    /// Where it was found; once handed to the editor, the editor moves it
    /// with every edit and [`Decor::current_comments`] reads it back.
    range: Range<usize>,
    /// Handed to the editor.
    drawn: bool,
}

/// The paint layers of one [`ChapterEditor`].
pub struct Decor {
    ws: Workspace,
    book: String,
    doc: String,
    editor: WeakEntity<ProseEditor>,
    extension: Rc<DriftingExtension>,
    looks: Option<Rc<DecorLooks>>,
    marks: Entity<AgentMarks>,
    comments: Vec<CommentMark>,
    names: Option<Rc<LinkMatcher<LinkTarget>>>,
    /// The jump last shown, so a repeated notice does not scroll again.
    shown_jump: u64,
    /// The `editing` paragraph last sent with `todo.project`.
    editing: Option<String>,
    focused: bool,
    links_task: Option<Task<()>>,
    _subs: Vec<Subscription>,
    _ws: dr_workspace::events::Subscription,
}

/// What the workspace told the decorations.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Notice {
    Comments,
    Book,
    Prose,
}

impl Decor {
    /// The paint layers of `editor`, editing `doc` of `book`.
    pub(crate) fn new(
        ws: &Workspace,
        book: &str,
        doc: &str,
        editor: &Entity<ProseEditor>,
        extension: Rc<DriftingExtension>,
        window: &mut Window,
        cx: &mut Context<ChapterEditor>,
    ) -> Decor {
        let marks = AgentMarks::of(ws, cx);
        let focus = editor.read(cx).focus_handle(cx);
        let subs = vec![
            cx.subscribe(editor, |this, _, e: &DecorationEvent, cx| {
                this.decor.on_decoration(e, cx)
            }),
            cx.subscribe_in(editor, window, |this, _, e: &EditorEvent, window, cx| {
                if let EditorEvent::SelectionChanged = e {
                    let markers = this.todo_markers().to_vec();
                    this.decor.on_selection(&markers, cx);
                }
                if let EditorEvent::Edited { .. } = e {
                    this.decor.links_soon(window, cx);
                }
            }),
            cx.subscribe_self(|this, e: &ChapterEditorEvent, cx| match e {
                ChapterEditorEvent::TodoMarkers(markers) => {
                    let markers = markers.clone();
                    this.decor.project(&markers, cx);
                    this.decor.submit_links(cx);
                }
                ChapterEditorEvent::AnchorsChanged(changes) => this.decor.reanchor(changes, cx),
                ChapterEditorEvent::Edited => {}
            }),
            cx.subscribe(&marks, |this, _, e: &ledger::MarksChanged, cx| {
                if e.doc == this.decor.doc {
                    this.decor.load_agent(cx);
                }
            }),
            cx.observe_global_in::<ReviewFocus>(window, |this, window, cx| {
                this.decor.on_review_focus(window, cx)
            }),
            cx.on_focus_in(&focus, window, |this, _, cx| {
                this.decor.focused = true;
                let markers = this.todo_markers().to_vec();
                this.decor.on_selection(&markers, cx);
            }),
            cx.on_focus_out(&focus, window, |this, _, _, cx| {
                this.decor.focused = false;
                let markers = this.todo_markers().to_vec();
                if this.decor.editing.is_some() {
                    this.decor.editing = None;
                    this.decor.send_projection(&markers, None, cx);
                }
            }),
        ];
        let ws_sub = Self::watch(ws, book, doc, window, cx);
        let mut decor = Decor {
            ws: ws.clone(),
            book: book.to_owned(),
            doc: doc.to_owned(),
            editor: editor.downgrade(),
            extension,
            looks: None,
            marks,
            comments: Vec::new(),
            names: None,
            shown_jump: 0,
            editing: None,
            focused: false,
            links_task: None,
            _subs: subs,
            _ws: ws_sub,
        };
        decor.load_comments(cx);
        decor.load_names(cx);
        decor
    }

    /// Comment and book changes, and others' writes to the document, moved
    /// to the main thread.
    fn watch(
        ws: &Workspace,
        book: &str,
        doc: &str,
        window: &mut Window,
        cx: &mut Context<ChapterEditor>,
    ) -> dr_workspace::events::Subscription {
        let (tx, mut rx) = mpsc::unbounded::<Notice>();
        let (book, doc) = (book.to_owned(), doc.to_owned());
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
                WsEvent::Prose(p) if p.doc.to_string() == doc => Some(Notice::Prose),
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
                        this.decor.load_comments(cx);
                    }
                    if notices.contains(&Notice::Book) || notices.contains(&Notice::Comments) {
                        this.decor.load_names(cx);
                    }
                    if notices.contains(&Notice::Prose) {
                        this.decor.links_soon(window, cx);
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

    /// The same layers on another document (the view switched to it).
    pub(crate) fn rebind(
        &mut self,
        ws: &Workspace,
        book: &str,
        doc: &str,
        editor: &Entity<ProseEditor>,
        window: &mut Window,
        cx: &mut Context<ChapterEditor>,
    ) {
        let looks = self.looks.take();
        *self = Decor::new(ws, book, doc, editor, self.extension.clone(), window, cx);
        if let Some(looks) = looks {
            self.apply_looks(looks, cx);
        }
    }

    /// Takes the theme's looks and shows everything with them.
    pub(crate) fn set_looks(&mut self, looks: DecorLooks, cx: &mut Context<ChapterEditor>) {
        self.apply_looks(Rc::new(looks), cx);
    }

    fn apply_looks(&mut self, looks: Rc<DecorLooks>, cx: &mut Context<ChapterEditor>) {
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
        self.submit_comments(cx);
        self.load_agent(cx);
        self.submit_links(cx);
    }

    // ----- comments -------------------------------------------------------------------

    fn target(&self) -> Option<Target> {
        let (kind, id) = self.doc.split_once(':')?;
        Some(Target {
            kind: kind.to_owned(),
            id: id.to_owned(),
        })
    }

    /// Reads the open comments' anchors and where they are now.
    fn load_comments(&mut self, cx: &mut Context<ChapterEditor>) {
        self.load_comments_try(0, cx);
    }

    fn load_comments_try(&mut self, tried: u32, cx: &mut Context<ChapterEditor>) {
        let Some(target) = self.target() else {
            return;
        };
        let (ws, book, doc) = (self.ws.clone(), self.book.clone(), self.doc.clone());
        let count = self.event_count(cx);
        cx.spawn(async move |this, cx| {
            if tried > 0 {
                cx.background_executor().timer(RESOLVE_AGAIN).await;
            }
            let found = cx
                .background_executor()
                .spawn(async move { comment_ranges(&ws, &book, &doc, target, count) })
                .await;
            this.update(cx, |this, cx| match found {
                Ok((_, seen)) if !this.decor.shows(seen, cx) && tried < RESOLVE_TRIES => {
                    this.decor.load_comments_try(tried + 1, cx);
                }
                Ok((found, _)) => this.decor.took_comments(found, cx),
                Err(e) => log::warn!("dr-editor: comment anchors: {e}"),
            })
            .ok();
        })
        .detach();
    }

    /// The holder's event count of the editor's document.
    fn event_count(&self, cx: &App) -> Option<EventCount> {
        let editor = self.editor.upgrade()?;
        editor.read(cx).book().chapters[0]
            .doc
            .source_as::<SessionSource>()
            .map(SessionSource::event_count)
    }

    /// Whether the editor shows the state of the document a holder job saw
    /// (`seen` events); positions found in that job fit the editor only then.
    fn shows(&self, seen: Option<u64>, cx: &App) -> bool {
        let Some(seen) = seen else {
            return true;
        };
        self.editor
            .upgrade()
            .and_then(|e| {
                e.read(cx).book().chapters[0]
                    .doc
                    .source_as::<SessionSource>()
                    .map(|s| s.taken() == seen)
            })
            .unwrap_or(true)
    }

    fn took_comments(
        &mut self,
        found: Vec<(String, bool, EncodedAnchor, Option<Range<usize>>)>,
        cx: &mut Context<ChapterEditor>,
    ) {
        // The editor carries the anchors through deletions and undo.
        if let Some(editor) = self.editor.upgrade() {
            editor.update(cx, |e, _| {
                let doc = &mut e.book_mut().chapters[0].doc;
                for (id, _, anchor, _) in &found {
                    if let Some(a) = anchors::decode(anchor) {
                        doc.set_anchor(id.clone(), a);
                    }
                }
            });
        }
        self.comments = found
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
        self.submit_comments(cx);
    }

    /// Brings the comments' ranges up to where the editor has moved them
    /// (typing, undo, an Agent's write); one whose words the edits took
    /// away is dropped, as the editor dropped it.
    fn current_comments(&mut self, cx: &App) {
        let Some(editor) = self.editor.upgrade() else {
            return;
        };
        let e = editor.read(cx);
        self.comments.retain_mut(|c| {
            if !c.drawn {
                return true;
            }
            match e.decoration_range(0, "comments", &c.id) {
                Some(r) => {
                    c.range = r;
                    true
                }
                None => false,
            }
        });
    }

    fn submit_comments(&mut self, cx: &mut Context<ChapterEditor>) {
        let (Some(looks), Some(editor)) = (self.looks.clone(), self.editor.upgrade()) else {
            return;
        };
        self.current_comments(cx);
        for c in &mut self.comments {
            c.drawn = true;
        }
        let focus = ReviewFocus::get(cx);
        let decorations: Vec<Decoration> = self
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
            e.set_decorations(0, "comments", decorations, cx)
        });
    }

    fn on_review_focus(&mut self, window: &mut Window, cx: &mut Context<ChapterEditor>) {
        self.submit_comments(cx);
        let focus = ReviewFocus::get(cx);
        let Some(jump) = focus.jump.filter(|j| j.serial != self.shown_jump) else {
            return;
        };
        self.current_comments(cx);
        let Some(range) = self
            .comments
            .iter()
            .find(|c| c.id == jump.comment)
            .map(|c| c.range.clone())
        else {
            return;
        };
        self.shown_jump = jump.serial;
        if let Some(editor) = self.editor.upgrade() {
            editor.update(cx, |e, cx| {
                // The caret at its start brings it into view; the sand is
                // drawn along its rows (`Emphasis::Drawn`).
                e.select(0, range.start..range.start, window, cx);
            });
        }
    }

    fn on_decoration(&mut self, e: &DecorationEvent, cx: &mut Context<ChapterEditor>) {
        match e {
            DecorationEvent::Pointed { ids } => {
                let comments = ids
                    .iter()
                    .filter(|(_, k)| k.group == "comments")
                    .map(|(_, k)| k.id.to_string())
                    .collect();
                ReviewFocus::point_prose(comments, cx);
            }
            DecorationEvent::Touched { key, .. } if key.group == "agent" => {
                let (doc, id) = (self.doc.clone(), key.id.to_string());
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

    // ----- Agent marks ----------------------------------------------------------------

    fn load_agent(&mut self, cx: &mut Context<ChapterEditor>) {
        self.load_agent_try(0, cx);
    }

    fn load_agent_try(&mut self, tried: u32, cx: &mut Context<ChapterEditor>) {
        if self.looks.is_none() {
            return;
        }
        let marks: Vec<Mark> = self.marks.read(cx).marks(&self.doc).to_vec();
        let (ws, doc) = (self.ws.clone(), self.doc.clone());
        let count = self.event_count(cx);
        cx.spawn(async move |this, cx| {
            if tried > 0 {
                cx.background_executor().timer(RESOLVE_AGAIN).await;
            }
            let found = cx
                .background_executor()
                .spawn(async move { resolve_marks(&ws, &doc, marks, count) })
                .await;
            this.update(cx, |this, cx| match found {
                Ok((_, seen)) if !this.decor.shows(seen, cx) && tried < RESOLVE_TRIES => {
                    this.decor.load_agent_try(tried + 1, cx);
                }
                Ok((found, _)) => this.decor.took_agent(found, cx),
                Err(e) => log::warn!("dr-editor: Agent marks: {e}"),
            })
            .ok();
        })
        .detach();
    }

    fn took_agent(&mut self, found: Vec<Placed>, cx: &mut Context<ChapterEditor>) {
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
        if !gone.is_empty() {
            let doc = self.doc.clone();
            let ids: Vec<&str> = gone.iter().map(String::as_str).collect();
            self.marks.update(cx, |m, cx| m.forget(&doc, &ids, cx));
        }
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
        editor.update(cx, |e, cx| e.set_decorations(0, "agent", decorations, cx));
    }

    // ----- links, suggestions, TODO keywords ---------------------------------------------

    fn load_names(&mut self, cx: &mut Context<ChapterEditor>) {
        let (ws, book, doc) = (self.ws.clone(), self.book.clone(), self.doc.clone());
        cx.spawn(async move |this, cx| {
            let found = cx
                .background_executor()
                .spawn(async move { link_names(&ws, &book, &doc) })
                .await;
            this.update(cx, |this, cx| match found {
                Ok(matcher) => {
                    this.decor.names = Some(Rc::new(matcher));
                    this.decor.submit_links(cx);
                }
                Err(e) => log::warn!("dr-editor: link names: {e}"),
            })
            .ok();
        })
        .detach();
    }

    /// Finds the links again once the typing settles.
    fn links_soon(&mut self, window: &mut Window, cx: &mut Context<ChapterEditor>) {
        self.links_task = Some(cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(LINKS_SETTLE).await;
            this.update(cx, |this, cx| this.decor.submit_links(cx)).ok();
        }));
    }

    fn submit_links(&mut self, cx: &mut Context<ChapterEditor>) {
        let (Some(looks), Some(editor)) = (self.looks.clone(), self.editor.upgrade()) else {
            return;
        };
        let found = {
            let e = editor.read(cx);
            find_links(e, &self.extension, self.names.as_deref())
        };
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
            .map(|(ix, range)| Decoration::new(format!("t{ix}"), range, Look::Ink(looks.todo_ink)))
            .collect();
        editor.update(cx, |e, cx| {
            e.set_decorations(0, "links", links, cx);
            e.set_decorations(0, "suggestions", suggestions, cx);
            e.set_decorations(0, "todo-marks", keywords, cx);
        });
    }

    // ----- the F3 commands ----------------------------------------------------------------

    fn reanchor(&self, changes: &[(String, EncodedAnchor)], cx: &mut Context<ChapterEditor>) {
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

    /// The caret's paragraph, while the editor has focus.
    fn caret_block(&self, cx: &App) -> Option<String> {
        if !self.focused {
            return None;
        }
        let editor = self.editor.upgrade()?;
        let e = editor.read(cx);
        let doc = &e.book().chapters[0].doc;
        let line = doc.line_of(e.selection().head);
        doc.lines().get(line)?.bid().map(str::to_owned)
    }

    /// The caret moved (or the editor got focus): a TODO typed in the
    /// paragraph it left is written now.
    fn on_selection(&mut self, markers: &[TodoMarker], cx: &mut Context<ChapterEditor>) {
        let editing = self.caret_block(cx);
        if editing != self.editing {
            let was_editing_a_marker = self
                .editing
                .as_ref()
                .is_some_and(|b| markers.iter().any(|m| m.block.as_ref() == Some(b)));
            self.editing = editing.clone();
            if was_editing_a_marker {
                self.send_projection(markers, editing, cx);
            }
        }
    }

    fn project(&mut self, markers: &[TodoMarker], cx: &mut Context<ChapterEditor>) {
        let editing = self.caret_block(cx);
        self.editing = editing.clone();
        self.send_projection(markers, editing, cx);
    }

    fn send_projection(
        &self,
        markers: &[TodoMarker],
        editing: Option<String>,
        cx: &mut Context<ChapterEditor>,
    ) {
        let input = TodoProjectIn {
            doc: self.doc.clone(),
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
}

// ----- work off the main thread ---------------------------------------------------------

/// `(id, is TODO, anchor, range now)` of every open anchored comment on
/// `doc`; ranges are resolved on the document's holder thread.
type CommentFound = Vec<(String, bool, EncodedAnchor, Option<Range<usize>>)>;

/// Found on the holder thread, with the event count it saw there.
type Seen<T> = (T, Option<u64>);

fn comment_ranges(
    ws: &Workspace,
    book: &str,
    doc: &str,
    target: Target,
    count: Option<EventCount>,
) -> Result<Seen<CommentFound>, String> {
    let listed = ws
        .run::<CommentAnchors>(
            &Actor::User,
            CommentAnchorsIn {
                book: book.to_owned(),
                target,
            },
        )
        .map_err(|e| e.to_string())?
        .output;
    let open: Vec<(String, bool, EncodedAnchor)> = listed
        .into_iter()
        .filter(|c| c.status == "open")
        .filter_map(|c| Some((c.id, c.kind == "todo", c.anchor.bytes()?)))
        .collect();
    let handle = ws
        .library()
        .open_doc(doc, OpenDoc::Existing)
        .map_err(|e| e.to_string())?;
    handle
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
        .map_err(|e| e.to_string())
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

/// One pass over the paragraphs (scalar offsets of the chapter).
pub(crate) fn find_links(
    editor: &ProseEditor,
    extension: &DriftingExtension,
    names: Option<&LinkMatcher<LinkTarget>>,
) -> FoundLinks {
    let doc = &editor.book().chapters[0].doc;
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
