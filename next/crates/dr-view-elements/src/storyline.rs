//! Lane colour chrome for v3 levels.
use std::rc::Rc;

use dr_i18n::keys;
use dr_shell::book::{Book, color_of};
use dr_shell::nav::Target;
use dr_shell::t;
use dr_ui::{
    Theme,
    components::ColorSwatch,
    input::field::FieldEvent,
    sand::{self},
};
use gpui::{
    App, AppContext as _, Context, Entity, Focusable as _, InteractiveElement as _, IntoElement,
    ParentElement as _, Render, StatefulInteractiveElement as _, Styled as _, Subscription, Window,
    div, px,
};

pub fn init_v3(cx: &mut App) {
    v3_lane::init(cx);
}
mod v3_lane {
    use super::*;
    use dr_shell::{
        pages::{ModulePage, PageViewHost},
        v3::page::EntryPage,
    };
    use dr_ui::{
        components::color::{hex, parse_hex},
        input::field::TextField,
    };
    use futures::StreamExt as _;
    use gpui::FocusHandle;
    type WriteJob = Box<dyn FnOnce() + Send>;

    fn slot(book: &Book, id: &str) -> Option<(String, String)> {
        let b = book.v3()?;
        let t = b.template_of(id)?;
        if t.kind != "level" || !t.lane {
            return None;
        }
        t.modules.iter().find_map(|m| {
            m.config
                .color_field
                .as_ref()
                .map(|f| (m.id.clone(), f.clone()))
        })
    }
    fn stored(book: &Book, id: &str) -> String {
        let Some((module, field)) = slot(book, id) else {
            return String::new();
        };
        match book
            .v3()
            .and_then(|b| b.entry(id))
            .and_then(|e| e.fields.get(&module))
            .and_then(|f| f.get(&field))
        {
            Some(dr_workspace::commands::v3::types::FieldValue::Text(s)) => s.clone(),
            _ => String::new(),
        }
    }
    struct LanePage {
        host: PageViewHost,
        id: String,
        page: Entity<EntryPage>,
        focus: FocusHandle,
        color: Entity<TextField>,
        dirty: bool,
        pending: Option<String>,
        _subs: Vec<Subscription>,
        writer: futures::channel::mpsc::UnboundedSender<WriteJob>,
    }
    pub(super) fn init(cx: &mut App) {
        dr_shell::pages::add_page_view(cx, |target, host, window, cx| {
            let Target::Entry { id, module: None } = target else {
                return None;
            };
            slot(&host.book, id.as_str())?;
            let view = cx.new(|cx| LanePage::new(host, id.to_string(), target.clone(), window, cx));
            let focus = view.read(cx).focus.clone();
            Some(ModulePage {
                view: view.into(),
                focus,
            })
        });
    }
    impl LanePage {
        fn new(
            host: PageViewHost,
            id: String,
            target: Target,
            window: &mut Window,
            cx: &mut Context<Self>,
        ) -> Self {
            let page = cx.new(|cx| EntryPage::new(host.clone(), target, cx));
            let color = cx.new(|cx| {
                TextField::new("v3-lane-color-value", window, cx)
                    .small()
                    .with_text(stored(&host.book, &id))
            });
            let focus = cx.focus_handle();
            let mut subs = vec![cx.on_focus(&focus, window, |this, w, cx| {
                this.page.read(cx).preferred_focus().focus(w, cx)
            })];
            subs.push(cx.subscribe_in(
                &color,
                window,
                |this, field, event, window, cx| match event {
                    FieldEvent::Changed(_) => {
                        this.dirty = field.focus_handle(cx).is_focused(window)
                    }
                    FieldEvent::Submitted(_) | FieldEvent::Blurred => {
                        let text = field.read(cx).text();
                        this.commit(&text, cx);
                    }
                    FieldEvent::Cancelled => {
                        this.color.update(cx, |f, cx| {
                            f.set_text(stored(&this.host.book, &this.id), cx)
                        });
                        this.dirty = false;
                    }
                },
            ));
            if let Some(ws) = host.workspace.upgrade() {
                subs.push(cx.observe_in(&ws, window, |this, ws, w, cx| {
                    let book = ws.read(cx).book.clone();
                    if Rc::ptr_eq(&book, &this.host.book) {
                        return;
                    }
                    this.host.book = book.clone();
                    this.page.update(cx, |page, cx| page.refresh(book, cx));
                    let text = stored(&this.host.book, &this.id);
                    if this.pending.as_deref() == Some(&text) {
                        this.pending = None;
                    }
                    if !this.dirty && !this.color.focus_handle(cx).is_focused(w) {
                        this.color.update(cx, |f, cx| f.set_text(text, cx));
                    }
                    cx.notify();
                }));
            }
            let (writer, mut jobs) = futures::channel::mpsc::unbounded::<WriteJob>();
            cx.background_executor()
                .spawn(async move {
                    while let Some(job) = jobs.next().await {
                        job();
                    }
                })
                .detach();
            Self {
                host,
                id,
                page,
                focus,
                color,
                dirty: false,
                pending: None,
                _subs: subs,
                writer,
            }
        }
        fn commit(&mut self, text: &str, cx: &mut Context<Self>) {
            let Some(color) = parse_hex(text) else {
                return;
            };
            let text = hex(color);
            if self.pending.as_ref() == Some(&text)
                || stored(&self.host.book, &self.id).eq_ignore_ascii_case(&text)
            {
                self.dirty = false;
                return;
            }
            let Some((module, field)) = slot(&self.host.book, &self.id) else {
                return;
            };
            let input = dr_workspace::commands::v3::module::FieldIn {
                target: dr_workspace::commands::v3::module::In {
                    book: self.host.book_id.clone(),
                    entry: self.id.clone(),
                    module,
                },
                field,
                value: dr_workspace::commands::v3::types::FieldValue::Text(text.clone()),
            };
            let book = self.host.book_id.clone();
            self.pending = Some(text);
            self.dirty = false;
            let library = self.host.library.clone();
            let (done, result) = futures::channel::oneshot::channel();
            let _ = self.writer.unbounded_send(Box::new(move || {
                let _ = done.send(library.run::<dr_workspace::commands::v3::module::FieldSet>(
                    &dr_workspace::Actor::User,
                    input,
                ));
            }));
            cx.spawn(async move |this, cx| {
                if let Ok(Err(error)) = result.await {
                    log::warn!("v3 lane colour write failed: {error}");
                    this.update(cx, |this, cx| {
                        this.pending = None;
                        let text = t(cx, keys::common::SAVE_FAILED);
                        this.host
                            .workspace
                            .update(cx, |ws, cx| {
                                if ws.book_id == book {
                                    ws.toast(text, cx);
                                }
                            })
                            .ok();
                        cx.notify();
                    })
                    .ok();
                }
            })
            .detach();
        }
    }
    impl Render for LanePage {
        fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            let p = Theme::of(window, cx).palette;
            let entity = cx.entity();
            let mut root = div().size_full().flex().flex_col();
            if slot(&self.host.book, &self.id).is_some() {
                let color = self
                    .pending
                    .as_deref()
                    .and_then(parse_hex)
                    .or_else(|| {
                        self.host
                            .book
                            .v3()
                            .and_then(|b| b.appearance(&self.id))
                            .and_then(|a| a.color.as_deref().and_then(color_of))
                    })
                    .unwrap_or(p.accent);
                root = root.child(
                    div()
                        .flex_none()
                        .px_4()
                        .py_2()
                        .flex()
                        .items_center()
                        .gap_3()
                        .child(t(cx, keys::storyline_editor::labels::COLOR))
                        .child(
                            ColorSwatch::new("v3-lane-color", color)
                                .mark(sand::Kind::Storyline)
                                .label(t(cx, keys::common::CUSTOM_COLOR))
                                .on_pick(move |color, _, cx| {
                                    entity.update(cx, |this, cx| {
                                        let text = hex(color);
                                        this.color.update(cx, |f, cx| f.set_text(text.clone(), cx));
                                        this.commit(&text, cx);
                                    });
                                }),
                        )
                        .child(
                            div()
                                .id("v3-lane-color-editor")
                                .role(gpui::Role::Button)
                                .aria_label(t(cx, keys::v3_timeline::COLOR_VALUE))
                                .w(px(110.))
                                .child(self.color.clone())
                                .on_click(cx.listener(|this, _, w, cx| {
                                    this.color.update(cx, |f, cx| f.select_all_text(cx));
                                    this.color.focus_handle(cx).focus(w, cx);
                                })),
                        ),
                )
            }
            root.child(div().flex_1().min_h_0().child(self.page.clone()))
        }
    }
}
