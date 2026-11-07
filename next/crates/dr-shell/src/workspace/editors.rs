//! The editors on the paper (`dr-editor`, F4e and M05).
//!
//! Every open tab whose page is a prose document (a chapter, an idea, an
//! element, a storyline, a category, a material) gets its own
//! [`ChapterEditor`] the first time its page is shown; the whole book's tab
//! gets a [`BookEditor`] (every chapter in one scroll, each edited in its
//! own document). A tab keeps its editor while it stays open: switching back
//! finds the caret, the scroll and the undo steps where they were, and the
//! page turn (180 ms) can draw the old page and the new one at once.
//!
//! Opening runs in two halves. On a background thread F3 opens the
//! documents' editing sessions (reading them from SQLite when they are not
//! open yet, the slow part); back on the main thread the editor view is
//! built on the documents that are now open. Typing goes through the
//! sessions: every keystroke is persisted, indexed for search and word
//! counts and announced on F3's bus like a command's write.
//!
//! What the shell keeps in step for every open editor:
//! - settings and the theme ([`Workspace::style_editors`]): sizes, colours,
//!   the block style (quotes, rules) and reduced motion;
//! - the keyboard: the focused page's editor has it unless something over
//!   the workspace or in a sidebar does; immersive writing fades every
//!   paragraph but the caret's in that editor only;
//! - M07's live word counts: the open documents' counts and the
//!   selection's, reported to `LiveWords` as the author types;
//! - the whole book's reading position, stored with the book's layout;
//! - the edit menu's commands (`edit::Undo`, `edit::Copy` …), which a
//!   binding without a context would otherwise take from the editor
//!   ([`forward_edit_actions`]).

use std::collections::{HashMap, HashSet};
use std::time::Instant;

pub use dr_editor::{
    BookEditor, BookEditorEvent, ChapterEditor, ChapterEditorEvent, EditorSettings,
    ReadingPosition, decor::DecorLooks,
};
use dr_text::TextMetrics;
use dr_ui::{Theme, fonts::Role, tokens::motion};
use dr_view_stats::LiveWords;
use dr_workspace::ProseSession;
use gpui::{
    AnyView, App, AppContext as _, Context, Entity, Focusable as _, InteractiveElement as _,
    SharedString, Subscription, Task, Window, px,
};
use gpui_prose::render::BlockStyle;
use gpui_prose::{EditorEvent, ProseEditor, ProseStyle};
use serde::{Deserialize, Serialize};

use super::Workspace;
use crate::Settings;
use crate::actions as edit;
use crate::book;
use crate::nav::{Target, location};

/// The paper's side margins around the text (as the read-only page had them).
pub const PAGE_GUTTER: f32 = 64.0;
/// The 0.1 client's page title (`.page__title`: 42 px).
pub const TITLE_SIZE: f32 = 42.0;

/// A page's editor: one prose document, or the whole book.
#[derive(Clone)]
pub enum PageView {
    Doc(Entity<ChapterEditor>),
    Book(Entity<BookEditor>),
}

impl PageView {
    /// The gpui-prose editor inside.
    pub fn prose(&self, cx: &App) -> Entity<ProseEditor> {
        match self {
            PageView::Doc(e) => e.read(cx).editor().clone(),
            PageView::Book(e) => e.read(cx).editor().clone(),
        }
    }

    pub fn view(&self) -> AnyView {
        match self {
            PageView::Doc(e) => e.clone().into(),
            PageView::Book(e) => e.clone().into(),
        }
    }

    fn restyle(&self, base: Option<&ProseStyle>, settings: Option<&EditorSettings>, cx: &mut App) {
        match self {
            PageView::Doc(e) => e.update(cx, |e, cx| {
                if let Some(base) = base {
                    e.set_base_style(base.clone(), cx);
                }
                if let Some(settings) = settings {
                    e.set_settings(settings.clone(), cx);
                }
            }),
            PageView::Book(e) => e.update(cx, |e, cx| {
                if let Some(base) = base {
                    e.set_base_style(base.clone(), cx);
                }
                if let Some(settings) = settings {
                    e.set_settings(settings.clone(), cx);
                }
            }),
        }
    }
}

/// One tab's editor.
pub struct PageEditor {
    /// The prose document (`node:<id>`, `element:<id>` …); `None` for the
    /// whole book.
    pub doc: Option<String>,
    /// `None` while the documents are being opened, or when they could not
    /// be.
    pub view: Option<PageView>,
    /// Being opened; since when.
    pub loading: Option<Instant>,
    /// It could not be opened (logged). Tried again when the tab reopens.
    pub failed: bool,
    /// Live word counts, per document the editor holds.
    tallies: HashMap<String, Tally>,
    _prepare: Option<Task<()>>,
    _timer: Option<Task<()>>,
    _events: Vec<Subscription>,
}

impl PageEditor {
    fn opening(doc: Option<String>, prepare: Task<()>, timer: Task<()>) -> PageEditor {
        PageEditor {
            doc,
            view: None,
            loading: Some(Instant::now()),
            failed: false,
            tallies: HashMap::new(),
            _prepare: Some(prepare),
            _timer: Some(timer),
            _events: Vec::new(),
        }
    }

    /// The page is taking long to open: its pill drifts (`Pill::loading`).
    pub fn slow(&self) -> bool {
        self.loading
            .is_some_and(|since| since.elapsed() >= motion::dwell::LOADING_DELAY)
    }

    /// The documents this editor holds.
    fn docs(&self, cx: &App) -> Vec<String> {
        match &self.view {
            Some(PageView::Doc(e)) => vec![e.read(cx).doc_id().to_owned()],
            Some(PageView::Book(b)) => b.read(cx).chapter_docs().map(str::to_owned).collect(),
            None => Vec::new(),
        }
    }
}

/// What the background half of opening hands the main thread.
enum Prepared {
    /// One document's editing session.
    Doc(dr_editor::SessionSource),
    /// Every chapter's session, held while the whole book's editor opens.
    Book(Vec<ProseSession>),
}

/// One document's word count, per paragraph; only the paragraphs whose text
/// changed are counted again.
#[derive(Default)]
struct Tally {
    lines: Vec<(SharedString, TextMetrics)>,
}

impl Tally {
    fn update(&mut self, doc: &gpui_prose::ProseDoc) -> TextMetrics {
        let lines = &doc.lines()[..doc.visible_lines()];
        let mut total = TextMetrics::default();
        let mut next = Vec::with_capacity(lines.len());
        for (i, line) in lines.iter().enumerate() {
            let metrics = match self.lines.get(i) {
                Some((text, m)) if *text == line.text => *m,
                _ => dr_text::paragraph_metrics(line.text.trim_end_matches('\n')),
            };
            total += metrics;
            next.push((line.text.clone(), metrics));
        }
        self.lines = next;
        total
    }
}

/// The whole book's reading position as the layout stores it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SavedPosition {
    pub doc: String,
    #[serde(default)]
    pub block: Option<String>,
    #[serde(default)]
    pub paragraph: usize,
    #[serde(default)]
    pub offset: f32,
}

impl From<ReadingPosition> for SavedPosition {
    fn from(p: ReadingPosition) -> SavedPosition {
        SavedPosition {
            doc: p.doc,
            block: p.block,
            paragraph: p.paragraph,
            offset: p.offset,
        }
    }
}

impl From<&SavedPosition> for ReadingPosition {
    fn from(p: &SavedPosition) -> ReadingPosition {
        ReadingPosition {
            doc: p.doc.clone(),
            block: p.block.clone(),
            paragraph: p.paragraph,
            offset: p.offset,
        }
    }
}

/// The editor settings as the settings file has them. The editor is given
/// the text's width (the paper less its margins) as its widest: it lays
/// paragraphs out inside its gutter but its title row only inside that
/// width, so this keeps the title over the text.
pub fn editor_settings(cx: &App) -> EditorSettings {
    let file = Settings::read(cx);
    let mut settings = EditorSettings::from_values(|key| Some(file.get(key)));
    settings.page_width -= 2.0 * PAGE_GUTTER;
    settings
}

/// The theme's colours and the prose face, under the settings' sizes. The
/// editor draws no ground of its own: the paper under it is the page, with
/// its rounded corners.
pub fn base_style(theme: &Theme) -> ProseStyle {
    let p = theme.palette;
    ProseStyle {
        font_family: Role::Prose.shared_family(),
        gutter: px(PAGE_GUTTER),
        title_size: px(TITLE_SIZE),
        text: p.ink(1).solid(),
        muted: p.muted().solid(),
        background: gpui::transparent_black(),
        selection: p.accent.alpha(0.22),
        cursor: p.accent.solid(),
        link: p.accent.solid(),
        ..ProseStyle::default()
    }
}

/// Quotes, indents and rules in the theme's inks.
pub fn block_style(theme: &Theme) -> BlockStyle {
    let p = theme.palette;
    BlockStyle {
        quote_wash: Some(p.ink(1).alpha(if p.dark { 0.06 } else { 0.04 })),
        quote_ink: Some(p.ink(2).solid()),
        rule: p.rule_strong.solid(),
        ..BlockStyle::default()
    }
}

/// How comments, Agent changes, links and find hits look on the prose in
/// this theme (dr-editor's paint layers).
pub fn decor_looks(theme: &Theme, base: &ProseStyle) -> DecorLooks {
    DecorLooks::new(theme.palette, base.link, theme.reduce_motion)
}

impl Workspace {
    /// Starts opening `target`'s editor (its documents' sessions first, off
    /// the main thread).
    pub(super) fn prepare_editor(
        &mut self,
        target: &Target,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(lib) = self.library.clone() else {
            return;
        };
        let doc = book::doc_of(target);
        let docs: Vec<String> = match &doc {
            Some(doc) => vec![doc.clone()],
            None => self
                .book
                .chapters
                .iter()
                .map(|c| format!("node:{}", c.id))
                .collect(),
        };
        let key = target.key();
        let prepared = key.clone();
        let one = doc.is_some();
        let prepare = cx.spawn_in(window, async move |this, cx| {
            let started = Instant::now();
            let sessions = cx
                .background_executor()
                .spawn(async move {
                    if one {
                        // One document: its editor's own session, for
                        // `ChapterEditor::with_session`.
                        dr_editor::SessionSource::open(&lib, &docs[0]).map(Prepared::Doc)
                    } else {
                        docs.iter()
                            .map(|d| lib.prose_session(d))
                            .collect::<dr_workspace::Result<Vec<ProseSession>>>()
                            .map(Prepared::Book)
                    }
                })
                .await;
            let ms = started.elapsed().as_secs_f64() * 1e3;
            this.update_in(cx, |ws, window, cx| {
                ws.editor_prepared(&prepared, sessions, ms, window, cx)
            })
            .ok();
        });
        // Past the loading delay, the pill shows it.
        let timer = cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(motion::dwell::LOADING_DELAY)
                .await;
            this.update(cx, |_, cx| cx.notify()).ok();
        });
        self.editors
            .insert(key, PageEditor::opening(doc, prepare, timer));
    }

    fn editor_prepared(
        &mut self,
        key: &str,
        sessions: dr_workspace::Result<Prepared>,
        ms: f64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(lib) = self.library.clone() else {
            return;
        };
        let book = self.book_id.clone();
        let settings = self.editor_settings.clone();
        let base = self.editor_base.clone();
        let title = self.page_title(key, cx);
        let position = self.book_position.clone();
        // The tab may have closed meanwhile.
        let Some(page) = self.editors.get_mut(key) else {
            return;
        };
        page.loading = None;
        page._timer = None;
        page._prepare = None;
        let sessions = match sessions {
            Ok(sessions) => sessions,
            Err(error) => {
                log::warn!("{key}: the editor could not open it: {error}");
                page.failed = true;
                cx.notify();
                return;
            }
        };
        let opened = Instant::now();
        // One document's editor is built on the session opened above
        // (`with_session` cannot fail). `BookEditor::open` still returns a
        // `Result` inside `cx.new`; the sessions opened above hold every
        // chapter open, so short of the holder threads or the library being
        // gone it cannot fail (see f6-shell.md, 待协调 F4).
        let (doc, sessions) = match (page.doc.clone(), sessions) {
            (Some(doc), Prepared::Doc(source)) => (Some((doc, source)), Vec::new()),
            (_, Prepared::Book(sessions)) => (None, sessions),
            (None, Prepared::Doc(_)) => return,
        };
        let view = match doc {
            Some((doc, source)) => {
                let editor = cx.new(|cx| {
                    ChapterEditor::with_session(lib, &book, &doc, source, settings, window, cx)
                });
                let looks = decor_looks(&Theme::of(window, cx), &base);
                editor.update(cx, |e, cx| {
                    e.set_base_style(base, cx);
                    e.set_decor_looks(looks, cx);
                    set_title(e, title, cx);
                });
                let events = cx.subscribe(&editor, |ws, editor, event: &ChapterEditorEvent, cx| {
                    ws.on_editor_event(&editor, event, cx)
                });
                page._events.push(events);
                let comments = cx.subscribe_in(
                    &editor,
                    window,
                    |ws, editor, req: &dr_editor::CommentRequested, window, cx| {
                        let prose = editor.read(cx).editor().clone();
                        ws.on_comment_requested(req, prose, 0, window, cx)
                    },
                );
                page._events.push(comments);
                PageView::Doc(editor)
            }
            None => {
                let editor =
                    cx.new(
                        |cx| match BookEditor::open(lib, &book, settings, window, cx) {
                            Ok(editor) => editor,
                            Err(error) => {
                                panic!("{book}: the open book could not be edited: {error}")
                            }
                        },
                    );
                editor.update(cx, |e, cx| {
                    e.set_base_style(base, cx);
                    if let Some(at) = &position {
                        e.restore(&at.into(), cx);
                    }
                });
                let events = cx.subscribe(&editor, |ws, _, event: &BookEditorEvent, cx| {
                    ws.on_book_event(event, cx)
                });
                page._events.push(events);
                let comments = cx.subscribe_in(
                    &editor,
                    window,
                    |ws, editor, req: &dr_editor::CommentRequested, window, cx| {
                        let (prose, chapter) = {
                            let b = editor.read(cx);
                            (b.editor().clone(), b.chapter_of(&req.doc))
                        };
                        if let Some(chapter) = chapter {
                            ws.on_comment_requested(req, prose, chapter, window, cx)
                        }
                    },
                );
                page._events.push(comments);
                PageView::Book(editor)
            }
        };
        drop(sessions);
        let prose = view.prose(cx);
        let selection = cx.subscribe(&prose, |_, prose, event: &EditorEvent, cx| {
            if matches!(event, EditorEvent::SelectionChanged) {
                report_selection(&prose, cx);
            }
        });
        page._events.push(selection);
        page.view = Some(view);
        log::debug!(
            "{key}: sessions in {ms:.1} ms, editor in {:.2} ms",
            opened.elapsed().as_secs_f64() * 1e3
        );
        // Settings and the paint layers the theme sets.
        let theme = Theme::of(window, cx);
        let (blocks, reduce) = (block_style(&theme), theme.reduce_motion);
        prose.update(cx, |p, cx| {
            p.set_block_style(blocks, cx);
            p.set_reduce_motion(reduce, cx);
        });
        self.report_words(key, None, cx);
        cx.notify();
    }

    fn on_editor_event(
        &mut self,
        editor: &Entity<ChapterEditor>,
        event: &ChapterEditorEvent,
        cx: &mut Context<Self>,
    ) {
        let doc = editor.read(cx).doc_id().to_owned();
        match event {
            ChapterEditorEvent::Edited => {
                let key = self
                    .editors
                    .iter()
                    .find(|(_, p)| p.doc.as_deref() == Some(doc.as_str()))
                    .map(|(k, _)| k.clone());
                if let Some(key) = key {
                    self.report_words(&key, Some(&doc), cx);
                }
            }
            // The editor projects its TODO markers (`todo.project`) and
            // stores re-anchored comments (`comment.reanchor`) itself
            // (dr-editor's decor module).
            ChapterEditorEvent::TodoMarkers(markers) => {
                log::debug!("{doc}: {} TODO markers", markers.len());
            }
            ChapterEditorEvent::AnchorsChanged(changes) => {
                log::debug!("{doc}: {} anchors re-stored", changes.len());
            }
        }
    }

    fn on_book_event(&mut self, event: &BookEditorEvent, cx: &mut Context<Self>) {
        let key = Target::Book.key();
        match event {
            BookEditorEvent::Edited { doc } => self.report_words(&key, Some(doc), cx),
            BookEditorEvent::Reloaded => {
                if let Some(page) = self.editors.get_mut(&key) {
                    page.tallies.clear();
                }
                self.report_words(&key, None, cx);
            }
            BookEditorEvent::TodoMarkers { doc, markers } => {
                // TODO(F3 `todo.project`).
                log::debug!("{doc}: {} TODO markers", markers.len());
            }
            BookEditorEvent::AnchorsChanged { doc, changes } => {
                // TODO(F3 `comment.reanchor`).
                log::debug!("{doc}: {} comment anchors to store", changes.len());
            }
        }
    }

    /// Tells M07 the live word count of `doc` (or of every document the
    /// editor at `key` holds), counting only the paragraphs that changed.
    fn report_words(&mut self, key: &str, doc: Option<&str>, cx: &mut Context<Self>) {
        let Some(page) = self.editors.get_mut(key) else {
            return;
        };
        let Some(view) = page.view.clone() else {
            return;
        };
        let prose = view.prose(cx);
        let docs: Vec<String> = match doc {
            Some(d) => vec![d.to_owned()],
            None => page.docs(cx),
        };
        let mut counts = Vec::new();
        for d in docs {
            let chapter = match &view {
                PageView::Doc(_) => Some(0),
                PageView::Book(b) => b.read(cx).chapter_of(&d),
            };
            let Some(chapter) = chapter else {
                continue;
            };
            let tally = page.tallies.entry(d.clone()).or_default();
            let total = {
                let p = prose.read(cx);
                match p.book().chapters.get(chapter) {
                    Some(c) => tally.update(&c.doc),
                    None => continue,
                }
            };
            counts.push((d, total));
        }
        for (d, total) in counts {
            self.live_docs.insert(d.clone());
            LiveWords::set_doc(d, total, cx);
        }
    }

    /// Documents no open editor holds any more count from the index again.
    pub(super) fn release_words(&mut self, cx: &mut Context<Self>) {
        let held: HashSet<String> = self.editors.values().flat_map(|p| p.docs(cx)).collect();
        let gone: Vec<String> = self
            .live_docs
            .iter()
            .filter(|d| !held.contains(*d))
            .cloned()
            .collect();
        for d in gone {
            self.live_docs.remove(&d);
            LiveWords::clear_doc(&d, cx);
        }
    }

    /// The title a page's editor shows over the prose.
    fn page_title(&self, key: &str, cx: &App) -> gpui::SharedString {
        match Target::from_key(key) {
            Some(target) => super::title_of(&self.book, &target, cx),
            None => gpui::SharedString::default(),
        }
    }

    /// The book was read again: the editors' titles follow renames.
    pub(super) fn retitle_editors(&mut self, cx: &mut Context<Self>) {
        let pages: Vec<(String, Entity<ChapterEditor>)> = self
            .editors
            .iter()
            .filter_map(|(key, p)| match &p.view {
                Some(PageView::Doc(e)) => Some((key.clone(), e.clone())),
                _ => None,
            })
            .collect();
        for (key, editor) in pages {
            let title = self.page_title(&key, cx);
            editor.update(cx, |e, cx| set_title(e, title, cx));
        }
    }

    /// The editor of `target`'s page, once it is open (one document).
    pub fn editor_of(&self, target: &Target) -> Option<&Entity<ChapterEditor>> {
        match self.editors.get(&target.key())?.view.as_ref()? {
            PageView::Doc(e) => Some(e),
            PageView::Book(_) => None,
        }
    }

    /// The whole book's editor, once its tab has shown it.
    pub fn book_editor(&self) -> Option<&Entity<BookEditor>> {
        match self.editors.get(&Target::Book.key())?.view.as_ref()? {
            PageView::Book(e) => Some(e),
            PageView::Doc(_) => None,
        }
    }

    /// The editor of `target`'s page, whichever kind.
    pub fn page_view(&self, target: &Target) -> Option<&PageView> {
        self.editors.get(&target.key())?.view.as_ref()
    }

    /// The editors of the pages on screen: opened when first shown, a
    /// location link's line selected once open, the focused page's editor
    /// given the keyboard when it changes.
    pub(super) fn ensure_editors(
        &mut self,
        shown: &[Target],
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        for target in shown {
            if !self.editors.contains_key(&target.key()) {
                self.prepare_editor(target, window, cx);
                continue;
            }
            let Some(editor) = self.editor_of(target).cloned() else {
                continue;
            };
            if let Some(lines) = self.nav.take_reveal(target) {
                let block = location::line_to_block(lines.start) as usize;
                editor.update(cx, |e, cx| {
                    let prose = e.editor().clone();
                    prose.update(cx, |p, cx| {
                        let doc = &p.book().chapters[0].doc;
                        let last = doc.visible_lines().saturating_sub(1);
                        let at = doc.line_start(block.min(last));
                        p.select(0, at..at, window, cx);
                    });
                });
            }
        }
        self.keep_find_on_page(window, cx);
        self.focus_page(window, cx);
        self.dim_for_immersive(cx);
        self.repaint_turning(shown, cx);
    }

    /// While a page turns, its editor is drawn under a changing opacity; the
    /// editor is a cached view, which would keep the faint picture of its
    /// first frames. So the editors on screen are drawn again every frame of
    /// the turn and once after it.
    fn repaint_turning(&mut self, shown: &[Target], cx: &mut Context<Self>) {
        let keys: Vec<String> = shown.iter().map(Target::key).collect();
        if keys != self.shown_pages {
            self.shown_pages = keys;
            self.turning_until = Some(dr_ui::anim::now() + motion::PAGE_BLEND.duration);
            self.keep_reading_position(cx);
        }
        let Some(until) = self.turning_until else {
            return;
        };
        for target in shown {
            if let Some(view) = self.page_view(target) {
                view.prose(cx).update(cx, |_, cx| cx.notify());
            }
        }
        if dr_ui::anim::now() > until {
            self.turning_until = None;
        }
    }

    /// The whole book's reading position, for the layout. Returns whether
    /// it moved since it was last kept.
    pub(super) fn keep_reading_position(&mut self, cx: &App) -> bool {
        let Some(book) = self.book_editor() else {
            return false;
        };
        let Some(at) = book.read(cx).reading_position(cx).map(SavedPosition::from) else {
            return false;
        };
        if self.book_position.as_ref() == Some(&at) {
            return false;
        }
        self.book_position = Some(at);
        true
    }

    /// The prose editors of every open page.
    fn all_prose(&self, cx: &App) -> Vec<Entity<ProseEditor>> {
        self.editors
            .values()
            .filter_map(|p| p.view.as_ref())
            .map(|v| v.prose(cx))
            .collect()
    }

    /// The focused page's prose editor, if it is open.
    fn focused_prose(&self, cx: &App) -> Option<Entity<ProseEditor>> {
        let target = self.nav.active_tab()?.focused().target.clone();
        Some(self.page_view(&target)?.prose(cx))
    }

    /// Gives the focused page's editor the keyboard when the page (or its
    /// editor) changes, unless something over the workspace or in a sidebar
    /// has it.
    fn focus_page(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let focused = window.focused(cx);
        let in_editor = focused.as_ref().is_some_and(|handle| {
            self.all_prose(cx)
                .iter()
                .any(|p| p.focus_handle(cx) == *handle)
        });
        if self.covered() || self.search.is_some() || self.find.is_some() {
            // Nothing under Settings, a Super View or a search takes typing.
            if in_editor && self.find.is_none() && self.search.is_none() {
                self.focus.focus(window, cx);
            }
            if self.covered() {
                self.focused_editor = None;
            }
            return;
        }
        let editor = self.focused_prose(cx);
        let want = editor.as_ref().map(|e| e.entity_id());
        if want == self.focused_editor {
            return;
        }
        // Ours to move: an editor, the workspace or nothing has it, or the
        // editor we gave it to last (whose tab may have closed).
        let free = in_editor
            || focused.as_ref().is_none_or(|handle| {
                *handle == self.focus || self.gave_focus.as_ref() == Some(handle)
            });
        if !free {
            return;
        }
        self.focused_editor = want;
        match editor {
            Some(editor) => {
                let handle = editor.focus_handle(cx);
                window.focus(&handle, cx);
                self.gave_focus = Some(handle);
            }
            None => self.focus.focus(window, cx),
        }
    }

    /// Immersive writing fades every paragraph but the caret's, in the
    /// focused page's editor only.
    fn dim_for_immersive(&mut self, cx: &mut Context<Self>) {
        let want = if self.immersive {
            self.focused_prose(cx).map(|p| p.entity_id())
        } else {
            None
        };
        if want == self.dimmed {
            return;
        }
        self.dimmed = want;
        for prose in self.all_prose(cx) {
            let on = Some(prose.entity_id()) == want;
            if prose.read(cx).paragraph_focus() != on {
                prose.update(cx, |p, cx| p.set_paragraph_focus(on, cx));
            }
        }
    }

    /// The keyboard back to the page (closing Settings or a Super View).
    pub(crate) fn refocus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.focused_editor = None;
        self.focus.focus(window, cx);
        cx.notify();
    }

    /// New settings or a new theme: every open editor is restyled.
    pub(super) fn style_editors(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let theme = Theme::of(window, cx);
        let settings = editor_settings(cx);
        let base = base_style(&theme);
        let settings_changed = settings != self.editor_settings;
        let base_changed = base != self.editor_base;
        let reduce_changed = theme.reduce_motion != self.editor_reduce;
        if !settings_changed && !base_changed && !reduce_changed {
            return;
        }
        self.editor_settings = settings.clone();
        self.editor_base = base.clone();
        self.editor_reduce = theme.reduce_motion;
        let blocks = block_style(&theme);
        let views: Vec<PageView> = self
            .editors
            .values()
            .filter_map(|p| p.view.clone())
            .collect();
        for view in views {
            view.restyle(
                base_changed.then_some(&base),
                settings_changed.then_some(&settings),
                cx,
            );
            view.prose(cx).update(cx, |p, cx| {
                if base_changed {
                    p.set_block_style(blocks.clone(), cx);
                }
                if reduce_changed {
                    p.set_reduce_motion(theme.reduce_motion, cx);
                }
            });
            if let PageView::Doc(e) = &view
                && (base_changed || reduce_changed)
            {
                let looks = decor_looks(&theme, &base);
                e.update(cx, |e, cx| e.set_decor_looks(looks, cx));
            }
        }
    }
}

/// M07's selection reading: the words in the selection, or none.
fn report_selection(prose: &Entity<ProseEditor>, cx: &mut App) {
    let words = {
        let p = prose.read(cx);
        let sel = p.selection();
        (!sel.is_empty()).then(|| {
            let text = p.book().chapters[sel.chapter].doc.slice(sel.range());
            dr_text::count_words(&text)
        })
    };
    LiveWords::set_selection(words, cx);
}

/// Shows `title` in the editor's title row over the prose (it scrolls with
/// the text). Measured again only when it changed.
fn set_title(
    editor: &mut ChapterEditor,
    title: gpui::SharedString,
    cx: &mut Context<ChapterEditor>,
) {
    let prose = editor.editor().clone();
    prose.update(cx, |p, cx| {
        let chapter = &mut p.book_mut().chapters[0];
        if chapter.title != title {
            chapter.title = title;
            p.list_state().remeasure_items(0..1);
            cx.notify();
        }
    });
}

/// Hands the edit menu's commands to the editor inside `el`. They are bound
/// without a context (the menu shows their keys), which outranks the
/// editor's own `ProseEditor` bindings in GPUI, so they arrive here. In the
/// whole book, undo and redo reach `BookEditor`, which undoes in the
/// chapter the caret is in.
pub fn forward_edit_actions(el: gpui::Stateful<gpui::Div>) -> gpui::Stateful<gpui::Div> {
    use gpui_prose::input::actions as prose;
    fn hand_on(action: impl gpui::Action) -> impl Fn(&mut Window, &mut App) {
        let action = action.boxed_clone();
        move |window, cx| window.dispatch_action(action.boxed_clone(), cx)
    }
    let undo = hand_on(prose::Undo);
    let redo = hand_on(prose::Redo);
    let cut = hand_on(prose::Cut);
    let copy = hand_on(prose::Copy);
    let paste = hand_on(prose::Paste);
    let all = hand_on(prose::SelectAll);
    el.on_action(move |_: &edit::Undo, window, cx| undo(window, cx))
        .on_action(move |_: &edit::Redo, window, cx| redo(window, cx))
        .on_action(move |_: &edit::Cut, window, cx| cut(window, cx))
        .on_action(move |_: &edit::Copy, window, cx| copy(window, cx))
        .on_action(move |_: &edit::Paste, window, cx| paste(window, cx))
        .on_action(move |_: &edit::SelectAll, window, cx| all(window, cx))
}
