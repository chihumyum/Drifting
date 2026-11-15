//! A lane's colour on its entry page (`kernel-v5.md` §16 「泳道」): the
//! colour a view draws it in, under the page's head.
use std::rc::Rc;

use dr_i18n::keys;
use dr_shell::book::{Book, color_of};
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
    use dr_shell::{pages::PageViewHost, v3::Rendered};
    use dr_ui::{
        components::color::{hex, parse_hex},
        input::field::TextField,
    };
    use futures::StreamExt as _;
    type WriteJob = Box<dyn FnOnce() + Send>;

    fn slot(book: &Book, id: &str) -> Option<(String, String)> {
        let b = book.v3()?;
        if !b.is_lane(id) {
            return None;
        }
        let t = b.template_of(id)?;
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
    /// A lane's colour, under its page's head: what the view draws it in.
    /// The page itself is the shell's entry page, its bodies the shell's
    /// like any entry's (find, live counts, comments).
    struct LaneColor {
        host: PageViewHost,
        id: String,
        color: Entity<TextField>,
        dirty: bool,
        pending: Option<String>,
        _subs: Vec<Subscription>,
        writer: futures::channel::mpsc::UnboundedSender<WriteJob>,
    }
    pub(super) fn init(cx: &mut App) {
        dr_shell::v3::add_entry_head_part(cx, |host, window, cx| {
            slot(&host.page.book, &host.entry)?;
            let view = cx.new(|cx| LaneColor::new(host.page, host.entry, window, cx));
            let weak = view.downgrade();
            Some(Rendered::new(view).on_refresh(move |book, cx| {
                let _ = weak.update(cx, |this, cx| this.refresh(book, cx));
            }))
        });
    }
    impl LaneColor {
        fn new(
            host: PageViewHost,
            id: String,
            window: &mut Window,
            cx: &mut Context<Self>,
        ) -> Self {
            let color = cx.new(|cx| {
                TextField::new("v3-lane-color-value", window, cx)
                    .small()
                    .with_text(stored(&host.book, &id))
            });
            let subs =
                vec![cx.subscribe_in(
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
                )];
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
                color,
                dirty: false,
                pending: None,
                _subs: subs,
                writer,
            }
        }
        fn refresh(&mut self, book: Rc<Book>, cx: &mut Context<Self>) {
            if Rc::ptr_eq(&book, &self.host.book) {
                return;
            }
            self.host.book = book;
            let text = stored(&self.host.book, &self.id);
            if self.pending.as_deref() == Some(&text) {
                self.pending = None;
            }
            if !self.dirty {
                self.color.update(cx, |f, cx| f.set_text(text, cx));
            }
            cx.notify();
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
    impl Render for LaneColor {
        fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            let p = Theme::of(window, cx).palette;
            let entity = cx.entity();
            if slot(&self.host.book, &self.id).is_none() {
                return div().into_any_element();
            }
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
            div()
                .flex_none()
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
                )
                .into_any_element()
        }
    }
}
