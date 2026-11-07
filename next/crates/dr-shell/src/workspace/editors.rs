//! The editors on the paper (`dr-editor`, F4e).
//!
//! Every open tab whose page is a prose document (a chapter, an idea, an
//! element, a storyline, a category, a material) gets its own
//! [`ChapterEditor`] the first time its page is shown, and keeps it while the
//! tab stays open: switching back finds the caret, the scroll and the undo
//! steps where they were, and the page turn (180 ms) can draw the old page
//! and the new one at once. The whole book stays the read-only page of F6's
//! second milestone.
//!
//! Opening runs in two halves. On a background thread F3 opens the
//! document's editing session (reading it from SQLite when it is not open
//! yet, the slow part); back on the main thread the editor view is built on
//! the document that is now open, which takes well under a millisecond.
//! Typing goes through the session: every keystroke is persisted, indexed for
//! search and word counts and announced on F3's bus like a command's write.
//!
//! Settings and the theme reach every open editor when they change
//! ([`Workspace::style_editors`]); the edit menu's commands (`edit::Undo`,
//! `edit::Copy` …), which a binding without a context would otherwise take
//! from the editor, are handed on to it ([`forward_edit_actions`]).

use std::time::Instant;

pub use dr_editor::{ChapterEditor, ChapterEditorEvent, EditorSettings, decor::DecorLooks};
use dr_ui::{Theme, fonts::Role, tokens::motion};
use dr_workspace::ProseSession;
use gpui::{
    App, AppContext as _, Context, Entity, Focusable as _, InteractiveElement as _, Subscription,
    Task, Window, px,
};
use gpui_prose::ProseStyle;

use super::Workspace;
use crate::Settings;
use crate::actions as edit;
use crate::book;
use crate::nav::{Target, location};

/// The paper's side margins around the text (as the read-only page had them).
pub const PAGE_GUTTER: f32 = 64.0;
/// The 0.1 client's page title (`.page__title`: 42 px).
pub const TITLE_SIZE: f32 = 42.0;

/// One tab's editor.
pub struct PageEditor {
    /// The prose document (`node:<id>`, `element:<id>` …).
    pub doc: String,
    /// `None` while the document is being opened, or when it could not be.
    pub editor: Option<Entity<ChapterEditor>>,
    /// Being opened; since when.
    pub loading: Option<Instant>,
    /// It could not be opened (logged). Tried again when the tab reopens.
    pub failed: bool,
    _prepare: Option<Task<()>>,
    _timer: Option<Task<()>>,
    _events: Option<Subscription>,
}

impl PageEditor {
    /// The page is taking long to open: its pill drifts (`Pill::loading`).
    pub fn slow(&self) -> bool {
        self.loading
            .is_some_and(|since| since.elapsed() >= motion::dwell::LOADING_DELAY)
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

/// How comments, Agent changes, links and find hits look on the prose in
/// this theme (dr-editor's paint layers).
pub fn decor_looks(theme: &Theme, base: &ProseStyle) -> DecorLooks {
    DecorLooks::new(theme.palette, base.link, theme.reduce_motion)
}

impl Workspace {
    /// Starts opening `target`'s editor (its document's session first, off
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
        let Some(doc) = book::doc_of(target) else {
            return;
        };
        let key = target.key();
        let read = doc.clone();
        let prepared = key.clone();
        let prepare = cx.spawn_in(window, async move |this, cx| {
            let started = Instant::now();
            let session = cx
                .background_executor()
                .spawn(async move { lib.prose_session(&read) })
                .await;
            let ms = started.elapsed().as_secs_f64() * 1e3;
            this.update_in(cx, |ws, window, cx| {
                ws.editor_prepared(&prepared, session, ms, window, cx)
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
        self.editors.insert(
            key,
            PageEditor {
                doc,
                editor: None,
                loading: Some(Instant::now()),
                failed: false,
                _prepare: Some(prepare),
                _timer: Some(timer),
                _events: None,
            },
        );
    }

    fn editor_prepared(
        &mut self,
        key: &str,
        session: dr_workspace::Result<ProseSession>,
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
        // The tab may have closed meanwhile.
        let Some(page) = self.editors.get_mut(key) else {
            return;
        };
        page.loading = None;
        page._timer = None;
        page._prepare = None;
        let session = match session {
            Ok(session) => session,
            Err(error) => {
                log::warn!("{}: the editor could not open it: {error}", page.doc);
                page.failed = true;
                cx.notify();
                return;
            }
        };
        let doc = page.doc.clone();
        let opened = Instant::now();
        // `ChapterEditor::open` returns a `Result` but has to run inside
        // `cx.new`. The session opened above holds the document open, so the
        // editor finds it there; short of the holder thread or the library
        // being gone it cannot fail (see f6-shell.md, 待协调 F4).
        let editor =
            cx.new(
                |cx| match ChapterEditor::open(lib, &book, &doc, settings, window, cx) {
                    Ok(editor) => editor,
                    Err(error) => panic!("{doc}: the open document could not be edited: {error}"),
                },
            );
        drop(session);
        let looks = decor_looks(&Theme::of(window, cx), &base);
        editor.update(cx, |e, cx| {
            e.set_base_style(base, cx);
            e.set_decor_looks(looks, cx);
            set_title(e, title, cx);
        });
        log::debug!(
            "{doc}: session in {ms:.1} ms, editor in {:.2} ms",
            opened.elapsed().as_secs_f64() * 1e3
        );
        let events = cx.subscribe(&editor, |ws, editor, event: &ChapterEditorEvent, cx| {
            ws.on_editor_event(&editor, event, cx)
        });
        page.editor = Some(editor);
        page._events = Some(events);
        cx.notify();
    }

    fn on_editor_event(
        &mut self,
        editor: &Entity<ChapterEditor>,
        event: &ChapterEditorEvent,
        cx: &mut Context<Self>,
    ) {
        match event {
            ChapterEditorEvent::Edited => {}
            // The editor projects its TODO markers (`todo.project`) and
            // stores re-anchored comments (`comment.reanchor`) itself
            // (dr-editor's decor module).
            ChapterEditorEvent::TodoMarkers(markers) => {
                log::debug!(
                    "{}: {} TODO markers",
                    editor.read(cx).doc_id(),
                    markers.len()
                );
            }
            ChapterEditorEvent::AnchorsChanged(changes) => {
                log::debug!(
                    "{}: {} anchors re-stored",
                    editor.read(cx).doc_id(),
                    changes.len()
                );
            }
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
            .filter_map(|(key, p)| p.editor.clone().map(|e| (key.clone(), e)))
            .collect();
        for (key, editor) in pages {
            let title = self.page_title(&key, cx);
            editor.update(cx, |e, cx| set_title(e, title, cx));
        }
    }

    /// The editor of `target`'s page, once it is open.
    pub fn editor_of(&self, target: &Target) -> Option<&Entity<ChapterEditor>> {
        self.editors
            .get(&target.key())
            .and_then(|page| page.editor.as_ref())
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
            if book::doc_of(target).is_none() {
                continue;
            }
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
        self.focus_page(window, cx);
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
        }
        let Some(until) = self.turning_until else {
            return;
        };
        for target in shown {
            if let Some(editor) = self.editor_of(target) {
                let prose = editor.read(cx).editor().clone();
                prose.update(cx, |_, cx| cx.notify());
            }
        }
        if dr_ui::anim::now() > until {
            self.turning_until = None;
        }
    }

    /// Gives the focused page's editor the keyboard when the page changes,
    /// unless something over the workspace or in a sidebar has it.
    fn focus_page(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let in_editor = window.focused(cx).is_some_and(|handle| {
            self.editors
                .values()
                .filter_map(|p| p.editor.as_ref())
                .any(|e| e.read(cx).editor().focus_handle(cx) == handle)
        });
        if self.covered() {
            // Nothing under Settings or a Super View takes typing.
            if in_editor {
                self.focus.focus(window, cx);
            }
            self.focused_doc = None;
            return;
        }
        let focused = self
            .nav
            .active_tab()
            .map(|tab| tab.focused().target.clone());
        let editor = focused.as_ref().and_then(|t| self.editor_of(t)).cloned();
        let want = editor.as_ref().map(|e| e.read(cx).doc_id().to_owned());
        if want == self.focused_doc {
            return;
        }
        let free = in_editor || window.focused(cx).is_none_or(|handle| handle == self.focus);
        if !free {
            return;
        }
        self.focused_doc = want;
        match editor {
            Some(editor) => {
                let handle = editor.read(cx).editor().focus_handle(cx);
                window.focus(&handle, cx);
            }
            None => self.focus.focus(window, cx),
        }
    }

    /// The keyboard back to the page (closing Settings or a Super View).
    pub(super) fn refocus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.focused_doc = None;
        self.focus.focus(window, cx);
        cx.notify();
    }

    /// New settings or a new theme: every open editor is restyled.
    pub(super) fn style_editors(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let settings = editor_settings(cx);
        let theme = Theme::of(window, cx);
        let base = base_style(&theme);
        let settings_changed = settings != self.editor_settings;
        let base_changed = base != self.editor_base;
        if !settings_changed && !base_changed {
            return;
        }
        self.editor_settings = settings.clone();
        self.editor_base = base.clone();
        for editor in self.editors.values().filter_map(|p| p.editor.clone()) {
            editor.update(cx, |e, cx| {
                if base_changed {
                    e.set_base_style(base.clone(), cx);
                    e.set_decor_looks(decor_looks(&theme, &base), cx);
                }
                if settings_changed {
                    e.set_settings(settings.clone(), cx);
                }
            });
        }
    }
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
/// editor's own `ProseEditor` bindings in GPUI, so they arrive here.
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
