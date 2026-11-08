//! A storyline's 「章节模版」 on its page (the 0.1 client's
//! `ElementTemplateEditor` under 「章节模版 · 新章节的默认骨架」): the body a
//! new chapter whose main storyline it is starts with.
//!
//! - The template is a prose document of its own (F3's
//!   `template:storyline:<id>`, `chapter_template.document`), edited with
//!   dr-editor's [`ChapterEditor`] like any page: H1/H2/H3 and body text,
//!   undo, the slash menu. Each change is stored as it is made (the 0.1
//!   editor persisted on every update).
//! - Until the storyline has a template, the place shows the 0.1
//!   placeholder; the document is made only when the author clicks into it
//!   (opening a page writes nothing). A template already there opens with
//!   the page, and one written meanwhile (the Agent, another window, sync)
//!   opens when it arrives. Both are asked of F3 directly: the book's
//!   `has_chapter_template` stays as it was while only the template's own
//!   document changes.
//! - The editor sits on the paper at the text's width (the page's gutter is
//!   its own), as high as its paragraphs: it never scrolls; the page does.

use std::rc::Rc;

use dr_editor::{ChapterEditor, PageChrome, PageInfo};
use dr_i18n::keys;
use dr_shell::workspace::editors::{base_style, editor_settings};
use dr_shell::{Services, t};
use dr_ui::{Theme, fonts::Role, style::DrStyled as _};
use dr_workspace::{
    Actor, Workspace as Library, WsEvent,
    commands::template::{ChapterTemplateBody, ChapterTemplateDocument, StorylineIn},
};
use gpui::{
    AnyElement, App, AppContext as _, Context, CursorStyle, Entity, InteractiveElement as _,
    IntoElement, ListOffset, MouseButton, ParentElement as _, Render, Styled as _, Subscription,
    Task, Window, div, prelude::FluentBuilder as _, px,
};

/// No head, no end: the template's paragraphs alone.
struct Bare;

impl PageChrome for Bare {
    fn head(&self, _: &PageInfo, _: &mut Window, _: &mut App) -> Option<AnyElement> {
        Some(div().h_0().into_any_element())
    }

    fn head_estimate(&self, _: &PageInfo) -> f32 {
        0.0
    }

    fn end_estimate(&self, _: &PageInfo) -> f32 {
        0.0
    }
}

enum State {
    /// No template yet: the placeholder.
    Closed,
    /// Its document is being made or read.
    Opening {
        _task: Task<()>,
    },
    Open {
        editor: Entity<ChapterEditor>,
        /// The theme the editor was styled for.
        dark: bool,
        _subs: Vec<Subscription>,
    },
    Failed,
}

pub struct ChapterTemplate {
    lib: Option<Library>,
    book: String,
    storyline: String,
    state: State,
    /// Put the caret in once open (the author clicked the placeholder).
    focus_when_open: bool,
    /// F3's bus: the template's own document changed.
    _events: Option<dr_workspace::Subscription>,
}

impl ChapterTemplate {
    /// `storyline`'s template in `book`; `exists`: it has one already (open
    /// it now).
    pub fn new(
        book: String,
        storyline: String,
        exists: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> ChapterTemplate {
        let lib = cx.try_global::<Services>().and_then(|s| s.library.clone());
        let mut this = ChapterTemplate {
            lib,
            book,
            storyline,
            state: State::Closed,
            focus_when_open: false,
            _events: None,
        };
        if exists {
            this.open(false, window, cx);
        } else {
            this.ask(window, cx);
        }
        this.listen(window, cx);
        this
    }

    fn input(&self) -> StorylineIn {
        StorylineIn {
            book: self.book.clone(),
            storyline: self.storyline.clone(),
        }
    }

    /// Asks F3 whether there is a template now; opens it if so.
    fn ask(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(lib) = self.lib.clone() else {
            return;
        };
        let input = self.input();
        cx.spawn_in(window, async move |this, cx| {
            let body = cx
                .background_executor()
                .spawn(async move { lib.run::<ChapterTemplateBody>(&Actor::User, input) })
                .await;
            if body.is_ok_and(|b| !b.output.is_empty()) {
                this.update_in(cx, |this, window, cx| this.follow(true, window, cx))
                    .ok();
            }
        })
        .detach();
    }

    /// The template's document changed (written elsewhere): open it.
    fn listen(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(lib) = self.lib.clone() else {
            return;
        };
        let doc = format!("template:storyline:{}", self.storyline);
        let (tx, mut rx) = futures::channel::mpsc::unbounded::<()>();
        self._events = Some(lib.subscribe(move |event| {
            if let WsEvent::Prose(p) = event
                && p.doc.to_string() == doc
            {
                let _ = tx.unbounded_send(());
            }
        }));
        cx.spawn_in(window, async move |this, cx| {
            use futures::StreamExt as _;
            while rx.next().await.is_some() {
                while rx.try_recv().is_ok() {}
                let alive = this.update_in(cx, |this, window, cx| {
                    if matches!(this.state, State::Closed) {
                        this.ask(window, cx);
                    }
                });
                if alive.is_err() {
                    break;
                }
            }
        })
        .detach();
    }

    /// The editor, once open (tests).
    pub fn editor(&self) -> Option<Entity<ChapterEditor>> {
        match &self.state {
            State::Open { editor, .. } => Some(editor.clone()),
            _ => None,
        }
    }

    pub fn is_open(&self) -> bool {
        matches!(self.state, State::Open { .. })
    }

    /// The storyline's facts as the book has them now: a template that
    /// arrived since (written elsewhere, by the Agent, synced) opens.
    pub fn follow(&mut self, exists: bool, window: &mut Window, cx: &mut Context<Self>) {
        if exists && matches!(self.state, State::Closed) {
            self.open(false, window, cx);
        }
    }

    /// Makes (or finds) the template's document off the main thread and
    /// opens it; `focus`: the caret goes in.
    pub fn open(&mut self, focus: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.focus_when_open |= focus;
        if let State::Open { editor, .. } = &self.state {
            if focus {
                editor.update(cx, |e, cx| e.focus_body(window, cx));
            }
            return;
        }
        if matches!(self.state, State::Opening { .. }) {
            return;
        }
        let Some(lib) = self.lib.clone() else {
            return;
        };
        let input = self.input();
        let task = cx.spawn_in(window, async move |this, cx| {
            let opened = cx
                .background_executor()
                .spawn({
                    let lib = lib.clone();
                    async move {
                        let doc = lib
                            .run::<ChapterTemplateDocument>(&Actor::User, input)?
                            .output
                            .doc;
                        let source = dr_editor::SessionSource::open(&lib, &doc)?;
                        Ok::<_, dr_workspace::WsError>((doc, source))
                    }
                })
                .await;
            this.update_in(cx, |this, window, cx| match opened {
                Ok((doc, source)) => this.opened(lib, doc, source, window, cx),
                Err(error) => {
                    log::warn!("the chapter template could not be opened: {error}");
                    this.state = State::Failed;
                    cx.notify();
                }
            })
            .ok();
        });
        self.state = State::Opening { _task: task };
        cx.notify();
    }

    fn opened(
        &mut self,
        lib: Library,
        doc: String,
        source: dr_editor::SessionSource,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let settings = editor_settings(cx);
        let theme = Theme::of(window, cx);
        let base = base_style(&theme);
        let book = self.book.clone();
        let editor = cx.new(|cx| {
            let mut e = ChapterEditor::with_session(lib, &book, &doc, source, settings, window, cx);
            e.set_base_style(base, cx);
            e.set_chrome(Some(Rc::new(Bare)), cx);
            e
        });
        // A new paragraph, a reflow: the place grows with it.
        let prose = editor.read(cx).editor().clone();
        let subs = vec![
            cx.observe(&editor, |_, _, cx| cx.notify()),
            cx.observe(&prose, |_, _, cx| cx.notify()),
        ];
        if std::mem::take(&mut self.focus_when_open) {
            editor.update(cx, |e, cx| e.focus_body(window, cx));
        }
        self.state = State::Open {
            editor,
            dark: theme.palette.dark,
            _subs: subs,
        };
        cx.notify();
    }
}

impl Render for ChapterTemplate {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let look = crate::page::look(cx);
        let line = look.font_size * look.line_height;
        let placeholder = t(cx, keys::storyline_editor::NODE_TEMPLATE_PLACEHOLDER);
        let hint = |text| {
            div()
                .font_role(Role::Prose)
                .type_px(look.font_size, line)
                .text_color(p.ink(4).solid())
                .child(dr_ui::text::wrapped(text))
        };
        match &mut self.state {
            State::Open { editor, dark, .. } => {
                // Restyled when the theme turns (the shell does it for its
                // own editors).
                if *dark != p.dark {
                    *dark = p.dark;
                    let base = base_style(&theme);
                    editor.update(cx, |e, cx| e.set_base_style(base, cx));
                }
                let prose = editor.read(cx).editor().clone();
                // It never scrolls: a caret that ran ahead of a growing
                // place would hide the first line.
                let list = prose.read(cx).list_state().clone();
                if list.logical_scroll_top().item_ix != 0
                    || list.logical_scroll_top().offset_in_item != px(0.0)
                {
                    list.scroll_to(ListOffset::default());
                }
                let height = prose.read(cx).heights().borrow_mut().total() as f32;
                let empty = editor.read(cx).plain_text(cx).trim().is_empty();
                div()
                    .id("storyline-template")
                    .debug_selector(|| "storyline-template".into())
                    .relative()
                    .w_full()
                    .h(px(height.max(line) + 4.0))
                    .child(editor.clone())
                    .when(empty, |el| {
                        el.child(
                            crate::page::column(look, hint(placeholder))
                                .absolute()
                                .top_0(),
                        )
                    })
                    .into_any_element()
            }
            State::Failed => crate::page::column(look, hint(placeholder)).into_any_element(),
            State::Closed | State::Opening { .. } => {
                let entity = cx.entity();
                crate::page::column(
                    look,
                    div()
                        .id("storyline-template-closed")
                        .debug_selector(|| "storyline-template-closed".into())
                        .cursor(CursorStyle::IBeam)
                        .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                            entity.update(cx, |this, cx| this.open(true, window, cx))
                        })
                        .child(hint(placeholder)),
                )
                .into_any_element()
            }
        }
    }
}
