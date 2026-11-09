//! Stateful body-module host. One module, one session, one undo stack.
use dr_editor::ChapterEditor;
use dr_shell::{
    book::Book,
    nav::Lines,
    pages::{PageEditorRef, PageHost},
    v3::{ModuleHost, Rendered},
};
use gpui::{prelude::*, *};
use std::rc::Rc;

pub struct BodyModule {
    host: ModuleHost,
    focus: FocusHandle,
    title_first: bool,
    editor: Option<Entity<ChapterEditor>>,
    reveal: Option<Lines>,
    loading: Option<Task<()>>,
    error: Option<String>,
}

pub fn register(cx: &mut App) {
    dr_shell::v3::add_module_view(cx, "prose", |host, window, cx| {
        let view = cx.new(|cx| BodyModule::new(host, window, cx));
        let focus = view.read(cx).focus.clone();
        let refresh = view.downgrade();
        let reveal = view.downgrade();
        Rendered::new(view)
            .focus(focus)
            .on_refresh(move |book, cx| {
                refresh.update(cx, |v, cx| v.refresh(book, cx)).ok();
            })
            .on_reveal(move |lines, window, cx| {
                reveal
                    .update(cx, |v, cx| {
                        v.reveal = lines;
                        v.reveal_now(window, cx);
                    })
                    .ok();
            })
    });
}

impl BodyModule {
    pub fn new(host: ModuleHost, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus = cx.focus_handle();
        let title_first =
            crate::NewTitles::pending(&format!("body:{}/{}", host.entry, host.module.id), cx);
        cx.on_focus(&focus, window, |v, window, cx| {
            if !v.title_first
                && let Some(editor) = &v.editor
            {
                let prose = editor.read(cx).editor().clone();
                window.defer(cx, move |window, cx| {
                    prose.focus_handle(cx).focus(window, cx)
                });
            }
        })
        .detach();
        let mut view = Self {
            host,
            focus,
            title_first,
            editor: None,
            reveal: None,
            loading: None,
            error: None,
        };
        view.load(window, cx);
        view
    }

    pub fn editor(&self) -> Option<Entity<ChapterEditor>> {
        self.editor.clone()
    }

    fn load(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.error = None;
        let host = self.host.clone();
        let prepare = cx.background_spawn(async move {
            dr_editor::v3::prepare_body(
                &host.page.library,
                &host.page.book_id,
                &host.entry,
                &host.module.id,
            )
        });
        self.loading = Some(cx.spawn_in(window, async move |this, cx| {
            let ready = prepare.await;
            this.update_in(cx, |view, window, cx| {
                view.loading = None;
                match ready {
                    Ok(source) => {
                        let host = &view.host;
                        let doc = format!("body:{}/{}", host.entry, host.module.id);
                        let settings = dr_shell::workspace::editors::editor_settings(cx);
                        let editor = cx.new(|cx| {
                            ChapterEditor::with_session(
                                host.page.library.clone(),
                                &host.page.book_id,
                                &doc,
                                source,
                                settings,
                                window,
                                cx,
                            )
                        });
                        let page = PageHost {
                            workspace: host.page.workspace.clone(),
                            library: host.page.library.clone(),
                            book: host.page.book_id.clone(),
                            editor: PageEditorRef::Doc(editor.downgrade()),
                        };
                        let base =
                            dr_shell::workspace::editors::base_style(&dr_ui::Theme::of(window, cx));
                        let looks = dr_shell::workspace::editors::decor_looks(
                            &dr_ui::Theme::of(window, cx),
                            &base,
                        );
                        editor.update(cx, |e, cx| {
                            use dr_i18n::keys::k4_pages as k;
                            let labels = [k::BODY, k::H1, k::H2, k::H3, k::QUOTE, k::RULE]
                                .map(|key| dr_shell::t(cx, key));
                            e.assist().update(cx, |a, _| a.set_block_labels(labels));
                            e.set_base_style(base, cx);
                            e.set_decor_looks(looks, cx);
                            e.set_chrome(Some(Rc::new(crate::Chrome::new(page))), cx);
                        });
                        view.editor = Some(editor);
                        view.reveal_now(window, cx);
                        let workspace = view.host.page.workspace.clone();
                        window.defer(cx, move |_, cx| {
                            workspace.update(cx, |_, cx| cx.notify()).ok();
                        });
                    }
                    Err(error) => {
                        log::warn!("body module: {error}");
                        view.error = Some(error.to_string());
                    }
                }
                cx.notify();
            })
            .ok();
        }));
    }

    pub fn refresh(&mut self, book: Rc<Book>, cx: &mut Context<Self>) {
        if let Some(module) = book
            .v3()
            .and_then(|b| b.template_of(&self.host.entry))
            .and_then(|t| t.modules.iter().find(|m| m.id == self.host.module.id))
        {
            self.host.module = module.clone();
        }
        self.host.page.book = book;
        // ChapterEditor receives prose and catalogue events itself. Replacing it
        // here would destroy its selection and its author-only undo history.
        cx.notify();
    }

    fn reveal_now(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(editor) = &self.editor else {
            return;
        };
        if let Some(lines) = self.reveal.take() {
            let prose = editor.read(cx).editor().clone();
            prose.update(cx, |p, cx| {
                let doc = &p.book().chapters[0].doc;
                let line = dr_shell::nav::location::line_to_block(lines.start) as usize;
                let at = doc.line_start(line.min(doc.visible_lines().saturating_sub(1)));
                p.select(0, at..at, window, cx);
            });
        }
    }
}

impl Focusable for BodyModule {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for BodyModule {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // The shell may focus this wrapper before its asynchronous editor and
        // title exist. Do not queue prose focus over the new title's handoff.
        if self.title_first
            && let Some((head, _)) = crate::page_views(
                &format!("body:{}/{}", self.host.entry, self.host.module.id),
                cx,
            )
            && head.read(cx).title().focus_handle(cx).is_focused(window)
        {
            self.title_first = false;
        }
        if !self.title_first
            && self.focus.is_focused(window)
            && let Some(editor) = &self.editor
        {
            let prose = editor.read(cx).editor().clone();
            window.defer(cx, move |window, cx| {
                prose.focus_handle(cx).focus(window, cx)
            });
        }
        div()
            .id(SharedString::from(format!(
                "v3-body-{}-{}",
                self.host.entry, self.host.module.id
            )))
            .track_focus(&self.focus)
            .h((window.viewport_size().height * 0.5).clamp(px(240.), px(720.)))
            .w_full()
            .min_w_0()
            .children(self.editor.clone())
            .children(self.error.as_ref().map(|_| {
                div()
                    .child(dr_shell::t(cx, dr_i18n::keys::markdown_share::LOAD_FAILED))
                    .child(
                        dr_ui::components::Button::new(
                            "retry-body",
                            dr_shell::t(cx, dr_i18n::keys::markdown_share::RETRY),
                        )
                        .on_click(cx.listener(|v, _, window, cx| v.load(window, cx))),
                    )
            }))
    }
}
