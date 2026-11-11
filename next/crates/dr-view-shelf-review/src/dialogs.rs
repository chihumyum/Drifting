//! Compose and confirmation dialogs for M23 (new TODO, new floating comment,
//! new text material, and material deletion confirmation).

use dr_i18n::keys;
use dr_shell::{strings::tf, t};
use dr_ui::{
    Theme,
    components::{Button, overlay::Dialog},
    fonts::Role,
    input::{
        area::TextArea,
        field::{FieldEvent, TextField},
    },
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
    NewNote {
        field: Entity<TextField>,
        busy: bool,
        error: Option<SharedString>,
        _sub: Subscription,
    },
    DeleteMaterial {
        id: String,
        title: String,
        busy: bool,
        error: Option<SharedString>,
    },
}

impl ShelfReviewView {
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

    pub fn open_new_note_dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if crate::is_frozen(cx) || self.lib.is_none() || self.book.v3().is_none() {
            return;
        }
        self.add_menu_open = false;
        let placeholder = t(cx, keys::memo_material::dialog::TITLE_PLACEHOLDER);
        let field = cx.new(|cx| {
            TextField::new("shelf-review-new-note-title", window, cx).placeholder(placeholder)
        });
        field.read(cx).focus_handle(cx).focus(window, cx);
        let sub = cx.subscribe_in(
            &field,
            window,
            move |this, _, ev: &FieldEvent, window, cx| match ev {
                FieldEvent::Submitted(_) => this.submit_new_note_dialog(window, cx),
                FieldEvent::Cancelled => {
                    this.dialog = None;
                    cx.notify();
                }
                FieldEvent::Changed(_) => cx.notify(),
                FieldEvent::Blurred => {}
            },
        );
        self.dialog = Some(ActiveDialog::NewNote {
            field,
            busy: false,
            error: None,
            _sub: sub,
        });
        cx.notify();
    }

    pub(crate) fn open_delete_material_dialog(
        &mut self,
        id: String,
        title: String,
        cx: &mut Context<Self>,
    ) {
        if crate::is_frozen(cx) || self.lib.is_none() {
            return;
        }
        self.dialog = Some(ActiveDialog::DeleteMaterial {
            id,
            title,
            busy: false,
            error: None,
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
            _ => return,
        };
        let kind = if todo { "todo" } else { "note" };
        self.create_floating_comment(kind, body, cx);
    }

    pub(crate) fn submit_new_note_dialog(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        let title = match &mut self.dialog {
            Some(ActiveDialog::NewNote { field, busy, .. }) => {
                if *busy {
                    return;
                }
                *busy = true;
                let trimmed = field.read(cx).text().trim().to_owned();
                if trimmed.is_empty() {
                    t(cx, keys::material_folders::UNTITLED).to_string()
                } else {
                    trimmed
                }
            }
            _ => return,
        };
        self.create_text_material(title, cx);
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
            ActiveDialog::NewNote {
                field, busy, error, ..
            } => {
                let (close_ent, cancel_ent, create_ent) =
                    (entity.clone(), entity.clone(), entity.clone());
                let body = div()
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .child(field.clone())
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
                    Dialog::new(
                        "shelf-review-new-note-dialog",
                        t(cx, keys::memo_material::super_::NEW_MATERIAL_BUTTON),
                    )
                    .width(400.0)
                    .body(body)
                    .on_close(move |_, cx| {
                        close_ent.update(cx, |this, cx| {
                            if !matches!(
                                &this.dialog,
                                Some(ActiveDialog::NewNote { busy: true, .. })
                            ) {
                                this.dialog = None;
                                cx.notify();
                            }
                        });
                    })
                    .on_mist(|_, _| {})
                    .action(
                        Button::new("shelf-review-note-cancel", t(cx, keys::common::CANCEL))
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
                            "shelf-review-note-submit",
                            t(cx, keys::memo_material::dialog::CREATE),
                        )
                        .primary()
                        .busy(*busy)
                        .disabled(*busy)
                        .on_click(move |_, window, cx| {
                            create_ent.update(cx, |this, cx| {
                                this.submit_new_note_dialog(window, cx);
                            });
                        }),
                    )
                    .into_any_element(),
                )
            }
            ActiveDialog::DeleteMaterial {
                id,
                title,
                busy,
                error,
            } => {
                let mat_id = id.clone();
                let display_title = if title.trim().is_empty() {
                    t(cx, keys::material_folders::UNTITLED).to_string()
                } else {
                    title.clone()
                };
                let prompt = tf(
                    cx,
                    keys::material_editor::DELETE_CONFIRM,
                    &[("title", &display_title)],
                );
                let (close_ent, cancel_ent, del_ent) =
                    (entity.clone(), entity.clone(), entity.clone());
                let body = div()
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .font_role(Role::Ui)
                    .type_px(s.secondary, s.line_body)
                    .text_color(p.ink(2).solid())
                    .child(prompt)
                    .when_some(error.clone(), |el, err| {
                        el.child(
                            div()
                                .type_px(s.caption, s.line_caption)
                                .text_color(p.danger.solid())
                                .child(err),
                        )
                    });
                Some(
                    Dialog::new(
                        "shelf-review-delete-material-dialog",
                        t(cx, keys::editor_top_bar::menu::DELETE_MATERIAL),
                    )
                    .width(400.0)
                    .body(body)
                    .on_close(move |_, cx| {
                        close_ent.update(cx, |this, cx| {
                            if !matches!(
                                &this.dialog,
                                Some(ActiveDialog::DeleteMaterial { busy: true, .. })
                            ) {
                                this.dialog = None;
                                cx.notify();
                            }
                        });
                    })
                    .action(
                        Button::new("shelf-review-del-cancel", t(cx, keys::common::CANCEL))
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
                        Button::new("shelf-review-del-confirm", t(cx, keys::common::DELETE))
                            .danger()
                            .busy(*busy)
                            .disabled(*busy)
                            .on_click(move |_, _, cx| {
                                let mat_id = mat_id.clone();
                                del_ent.update(cx, |this, cx| {
                                    this.confirm_delete_material(mat_id, cx);
                                });
                            }),
                    )
                    .into_any_element(),
                )
            }
        }
    }
}
