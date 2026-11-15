//! Compose dialogs for M23 (new TODO and new floating comment).

use dr_i18n::keys;
use dr_shell::t;
use dr_ui::{
    Theme,
    components::{Button, overlay::Dialog},
    fonts::Role,
    input::{area::TextArea, field::FieldEvent},
    style::DrStyled,
    tokens::radius,
};
use gpui::{
    AnyElement, AppContext as _, Context, Entity, Focusable as _, IntoElement, ParentElement,
    SharedString, Styled, Subscription, Window, div, prelude::FluentBuilder as _, px,
};

use crate::view::ShelfReviewView;

pub(crate) enum ActiveDialog {
    ComposeComment {
        todo: bool,
        area: Entity<TextArea>,
        busy: bool,
        error: Option<SharedString>,
        _sub: Subscription,
    },
}

impl ShelfReviewView {
    pub fn has_dialog(&self) -> bool {
        self.dialog.is_some()
    }

    pub fn open_new_todo_dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.open_compose_dialog(true, window, cx);
    }

    pub fn open_new_comment_dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.open_compose_dialog(false, window, cx);
    }

    fn open_compose_dialog(&mut self, todo: bool, window: &mut Window, cx: &mut Context<Self>) {
        if crate::is_frozen(cx) || self.lib.is_none() || self.book.v3().is_none() {
            return;
        }
        let placeholder = if todo {
            t(cx, keys::memo_material::dialog::TODO_PLACEHOLDER)
        } else {
            t(cx, keys::review_panel::COMMENT_PLACEHOLDER)
        };
        let area = cx.new(|cx| {
            TextArea::new("shelf-review-compose-body", window, cx)
                .framed(4.0)
                .placeholder(placeholder)
        });
        area.read(cx).focus_handle(cx).focus(window, cx);
        let sub = cx.subscribe_in(
            &area,
            window,
            move |this, _, ev: &FieldEvent, window, cx| match ev {
                FieldEvent::Submitted(_) => this.submit_compose_dialog(window, cx),
                FieldEvent::Cancelled => {
                    this.dialog = None;
                    cx.notify();
                }
                FieldEvent::Changed(_) => cx.notify(),
                FieldEvent::Blurred => {}
            },
        );
        self.dialog = Some(ActiveDialog::ComposeComment {
            todo,
            area,
            busy: false,
            error: None,
            _sub: sub,
        });
        cx.notify();
    }

    pub(crate) fn submit_compose_dialog(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        let (todo, body) = match &mut self.dialog {
            Some(ActiveDialog::ComposeComment {
                todo, area, busy, ..
            }) => {
                if *busy {
                    return;
                }
                let text = area.read(cx).text().trim().to_owned();
                if text.is_empty() {
                    return;
                }
                *busy = true;
                (*todo, text)
            }
            None => return,
        };
        let kind = if todo { "todo" } else { "note" };
        self.create_floating_comment(kind, body, cx);
    }

    pub(crate) fn render_dialog(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let dialog = self.dialog.as_ref()?;
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let entity = cx.entity();

        match dialog {
            ActiveDialog::ComposeComment {
                todo,
                area,
                busy,
                error,
                ..
            } => {
                let title = if *todo {
                    t(cx, keys::memo_material::dialog::NEW_TODO)
                } else {
                    t(cx, keys::review_panel::NEW_COMMENT)
                };
                let empty = area.read(cx).text().trim().is_empty();
                let (close_ent, cancel_ent, create_ent) =
                    (entity.clone(), entity.clone(), entity.clone());
                let body = div()
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .child(
                        div()
                            .px(px(10.0))
                            .py(px(8.0))
                            .rounded(px(radius::SM))
                            .bg(p.page.solid())
                            .border_1()
                            .border_color(p.hairline())
                            .font_role(Role::Ui)
                            .type_px(s.secondary, s.line_body)
                            .text_color(p.ink(1).solid())
                            .child(area.clone()),
                    )
                    .when_some(error.clone(), |el, err| {
                        el.child(
                            div()
                                .font_role(Role::Ui)
                                .type_px(s.caption, s.line_caption)
                                .text_color(p.danger.solid())
                                .child(err),
                        )
                    });
                Some(
                    Dialog::new("shelf-review-compose-dialog", title)
                        .width(420.0)
                        .body(body)
                        .on_close(move |_, cx| {
                            close_ent.update(cx, |this, cx| {
                                if !matches!(
                                    &this.dialog,
                                    Some(ActiveDialog::ComposeComment { busy: true, .. })
                                ) {
                                    this.dialog = None;
                                    cx.notify();
                                }
                            });
                        })
                        .on_mist(|_, _| {})
                        .action(
                            Button::new("shelf-review-compose-cancel", t(cx, keys::common::CANCEL))
                                .text()
                                .disabled(*busy)
                                .on_click(move |_, _, cx| {
                                    cancel_ent.update(cx, |this, cx| {
                                        this.dialog = None;
                                        cx.notify();
                                    });
                                }),
                        )
                        .action(
                            Button::new(
                                "shelf-review-compose-submit",
                                t(cx, keys::memo_material::dialog::CREATE),
                            )
                            .primary()
                            .busy(*busy)
                            .disabled(*busy || empty)
                            .on_click(move |_, window, cx| {
                                create_ent.update(cx, |this, cx| {
                                    this.submit_compose_dialog(window, cx);
                                });
                            }),
                        )
                        .into_any_element(),
                )
            }
        }
    }
}
