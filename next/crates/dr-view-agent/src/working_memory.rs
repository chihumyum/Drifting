//! Device-local author editing uses the shared chunk/CAS store.
//! Views retain a controller, never a Workspace; accepted jobs outlive a view.
use crate::controller::AgentController;
use dr_agent::memory::{self, Snapshot, UpdatedBy};
use dr_i18n::keys;
use dr_model::id::BookId;
use dr_shell::strings::{t, tf};
use dr_ui::{
    Theme,
    components::{Button, Dialog, Layer, Place, float},
    fonts::Role,
    input::{FieldEvent, TextArea},
    style::DrStyled,
};
use dr_workspace::WsEvent;
use futures::{StreamExt as _, channel::mpsc};
use gpui::{
    AppContext as _, Context, Entity, Focusable as _, InteractiveElement as _, IntoElement,
    ParentElement, Render, ScrollHandle, StatefulInteractiveElement as _, Styled, Subscription,
    Window, div, prelude::FluentBuilder as _, px,
};
use keys::agent_panel::working_memory as k;

pub struct WorkingMemoryView {
    controller: AgentController,
    book: BookId,
    snapshot: Option<Snapshot>,
    editor: Entity<TextArea>,
    editing: Option<u64>,
    busy: bool,
    loading: bool,
    visible: bool,
    closed: bool,
    serial: u64,
    error: Option<String>,
    notice: Option<dr_i18n::Key>,
    confirm: Option<u64>,
    scroll: ScrollHandle,
    _input: Subscription,
    subscription: Option<dr_workspace::Subscription>,
}
impl WorkingMemoryView {
    pub fn new(
        controller: AgentController,
        book: BookId,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let editor = cx.new(|cx| TextArea::new("working-memory-editor", window, cx).framed(14.0));
        let input = cx.subscribe(&editor, |view, _, event, cx| {
            if matches!(event, FieldEvent::Submitted(_)) {
                view.save(cx);
            }
        });
        cx.spawn(async move |this, cx| {
            let _ = this.update(cx, |view, cx| {
                view.watch(cx);
                view.refresh(cx);
            });
        })
        .detach();
        Self {
            controller,
            book,
            snapshot: None,
            editor,
            editing: None,
            busy: false,
            loading: false,
            visible: true,
            closed: false,
            serial: 0,
            error: None,
            notice: None,
            confirm: None,
            scroll: ScrollHandle::new(),
            _input: input,
            subscription: None,
        }
    }
    fn watch(&mut self, cx: &mut Context<Self>) {
        let book = self.book.clone();
        let prefix = format!("{}/{book}/manifest", memory::SCOPE);
        let (send, mut receive) = mpsc::unbounded();
        let job = self.controller.workspace_job(move |ws| {
            Ok(ws.subscribe(move |event| {
                let changed = match event {
                    WsEvent::Local(change) => change.table == "local_state" && change.key == prefix,
                    // The book itself (whether it is in the trash); a writing
                    // day or a saved checkpoint is no change to it.
                    WsEvent::Book(change) => change.book == book && change.touched.content,
                    _ => false,
                };
                if changed {
                    let _ = send.unbounded_send(());
                }
            }))
        });
        cx.spawn(async move |this, cx| {
            if let Ok(subscription) = job.await {
                let _ = this.update(cx, |view, cx| {
                    if !view.closed {
                        view.subscription = Some(subscription);
                        view.refresh(cx);
                    }
                });
                while receive.next().await.is_some() {
                    if this
                        .update(cx, |view, cx| {
                            if view.visible && !view.closed {
                                view.refresh(cx);
                            }
                        })
                        .is_err()
                    {
                        break;
                    }
                }
            }
        })
        .detach();
    }
    pub fn set_visible(&mut self, visible: bool, cx: &mut Context<Self>) {
        self.visible = visible;
        if !visible {
            self.confirm = None;
        } else if !self.closed {
            self.refresh(cx);
        }
        cx.notify();
    }
    pub fn close(&mut self, cx: &mut Context<Self>) {
        self.closed = true;
        self.visible = false;
        self.confirm = None;
        self.subscription = None;
        self.serial += 1;
        cx.notify();
    }
    fn refresh(&mut self, cx: &mut Context<Self>) {
        if self.closed || self.controller.is_closed() {
            return;
        }
        self.serial += 1;
        let serial = self.serial;
        let book = self.book.clone();
        let job = self
            .controller
            .workspace_job(move |ws| memory::load(ws.library(), &book).map_err(|e| e.to_string()));
        self.loading = true;
        cx.spawn(async move |this, cx| {
            let result = job.await;
            let _ = this.update(cx, |view, cx| {
                if view.closed || view.controller.is_closed() || view.serial != serial {
                    return;
                }
                view.loading = false;
                match result {
                    Ok(snapshot) => view.snapshot = Some(snapshot),
                    Err(error) => {
                        view.snapshot = None;
                        view.error = Some(error);
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    fn begin_edit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy || self.closed || self.controller.is_closed() {
            return;
        }
        let Some(snapshot) = &self.snapshot else {
            return;
        };
        self.editing = Some(snapshot.revision);
        let text = if snapshot.exists {
            snapshot.content_md.as_str()
        } else {
            memory::EMPTY_MARKDOWN
        };
        self.editor
            .update(cx, |editor, cx| editor.set_text(text, cx));
        window.focus(&self.editor.focus_handle(cx), cx);
        self.error = None;
        self.notice = None;
        cx.notify();
    }
    fn save(&mut self, cx: &mut Context<Self>) {
        let Some(revision) = self.editing else { return };
        if self.blocked(cx) || self.editor.read(cx).is_composing() {
            return;
        }
        let text = self.editor.read(cx).text();
        self.mutate(revision, Some(text), cx);
    }
    fn blocked(&self, cx: &gpui::App) -> bool {
        self.busy
            || self.closed
            || self.controller.is_closed()
            || dr_shell::release::is_releasing(cx)
    }
    fn mutate(&mut self, revision: u64, text: Option<String>, cx: &mut Context<Self>) {
        if self.blocked(cx) {
            return;
        }
        let clear = text.is_none();
        let book = self.book.clone();
        let job = self.controller.workspace_job(move |ws| {
            let result = match text {
                Some(text) => {
                    memory::replace(ws.library(), &book, revision, &text, UpdatedBy::Author)
                }
                None => memory::clear(ws.library(), &book, revision, UpdatedBy::Author),
            };
            Ok(result.map_err(|e| {
                (
                    matches!(e, memory::MemoryError::Conflict { .. }),
                    e.to_string(),
                )
            }))
        });
        self.busy = true;
        self.confirm = None;
        self.error = None;
        self.notice = None;
        self.editor
            .update(cx, |editor, cx| editor.set_disabled(true, cx));
        cx.spawn(async move |this, cx| {
            let result = job.await;
            let _ = this.update(cx, |view, cx| {
                if view.closed || view.controller.is_closed() {
                    return;
                }
                view.busy = false;
                view.editor
                    .update(cx, |editor, cx| editor.set_disabled(false, cx));
                match result {
                    Ok(Ok(snapshot)) => {
                        view.snapshot = Some(snapshot);
                        view.editing = None;
                        view.notice = Some(if clear { k::CLEARED } else { k::SAVED });
                    }
                    Ok(Err((conflict, error))) => {
                        view.error = Some(error);
                        view.notice = Some(if conflict {
                            if clear {
                                k::CONFLICT_CLEAR
                            } else {
                                k::CONFLICT_DRAFT_PRESERVED
                            }
                        } else {
                            k::FAILED
                        });
                        view.refresh(cx);
                    }
                    Err(error) => {
                        view.error = Some(error);
                        view.notice = Some(k::FAILED);
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
}
impl Render for WorkingMemoryView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let muted = theme.palette.muted().solid();
        let blocked = self.blocked(cx);
        let me = cx.entity();
        let mut body = div()
            .id("working-memory")
            .size_full()
            .flex()
            .flex_col()
            .gap(px(12.0))
            .p(px(16.0))
            .child(div().font_role(Role::Structure).child(t(cx, k::TITLE)))
            .child(
                div()
                    .font_role(Role::Index)
                    .text_color(muted)
                    .child(t(cx, k::FILENAME)),
            );
        if self.loading && self.snapshot.is_none() {
            body = body.child(t(cx, k::LOADING));
        }
        if let Some(snapshot) = &self.snapshot {
            let author = match snapshot.updated_by {
                Some(UpdatedBy::Author) => k::AUTHOR,
                Some(UpdatedBy::Agent) => k::AGENT,
                None => k::NEVER_UPDATED,
            };
            let updated = match snapshot
                .updated_ms
                .and_then(chrono::DateTime::from_timestamp_millis)
            {
                Some(time) => tf(
                    cx,
                    k::UPDATED,
                    &[
                        (
                            "time",
                            &time.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M"),
                        ),
                        ("by", &t(cx, author)),
                    ],
                ),
                None => t(cx, k::NEVER_UPDATED),
            };
            body = body
                .child(
                    div()
                        .font_role(Role::Index)
                        .text_color(muted)
                        .child(updated),
                )
                .child(div().font_role(Role::Index).text_color(muted).child(tf(
                    cx,
                    k::TOKENS,
                    &[("count", &snapshot.approx_tokens)],
                )));
            if self.editing.is_some() {
                body = body.child(self.editor.clone()).child(
                    div()
                        .flex()
                        .gap(px(8.0))
                        .child(
                            Button::new("working-save", t(cx, keys::common::SAVE))
                                .primary()
                                .disabled(blocked)
                                .on_click(cx.listener(|view, _, _, cx| view.save(cx))),
                        )
                        .child(
                            Button::new("working-cancel", t(cx, keys::common::CANCEL))
                                .disabled(blocked)
                                .on_click(cx.listener(|view, _, _, cx| {
                                    view.editing = None;
                                    view.notice = None;
                                    view.error = None;
                                    cx.notify();
                                })),
                        ),
                );
            } else {
                if !snapshot.exists {
                    body = body.child(t(cx, k::EMPTY_TITLE));
                }
                body = body
                    .child(
                        div()
                            .id("working-content")
                            .flex_1()
                            .min_h_0()
                            .overflow_y_scroll()
                            .track_scroll(&self.scroll)
                            .child(if snapshot.exists {
                                snapshot.content_md.clone()
                            } else {
                                String::new()
                            }),
                    )
                    .child(
                        div()
                            .flex()
                            .gap(px(8.0))
                            .child(
                                Button::new(
                                    "working-edit",
                                    t(cx, if snapshot.exists { k::EDIT } else { k::CREATE }),
                                )
                                .disabled(blocked)
                                .on_click(
                                    cx.listener(|view, _, window, cx| view.begin_edit(window, cx)),
                                ),
                            )
                            .when(snapshot.exists, |row| {
                                row.child(
                                    Button::new("working-clear", t(cx, k::CLEAR))
                                        .danger()
                                        .disabled(blocked)
                                        .on_click(cx.listener(|view, _, _, cx| {
                                            view.confirm =
                                                view.snapshot.as_ref().map(|s| s.revision);
                                            cx.notify();
                                        })),
                                )
                            }),
                    );
            }
        }
        if let Some(key) = self.notice {
            body = body.child(div().font_role(Role::Index).child(t(cx, key)));
        }
        if let Some(error) = &self.error {
            body = body.child(
                div()
                    .font_role(Role::Index)
                    .text_color(muted)
                    .child(error.clone()),
            );
        }
        if let Some(revision) = self.confirm {
            let cancel = me.clone();
            let close = me.clone();
            let confirm = me;
            body = body.child(float(
                Place::Center,
                Layer::Dialog,
                Dialog::new("working-clear-confirm", t(cx, k::CLEAR))
                    .body(div().child(t(cx, k::CLEAR_CONFIRM)))
                    .action(
                        Button::new("working-clear-cancel", t(cx, keys::common::CANCEL)).on_click(
                            move |_, _, cx| {
                                cancel.update(cx, |view, cx| {
                                    view.confirm = None;
                                    cx.notify();
                                })
                            },
                        ),
                    )
                    .action(
                        Button::new("working-clear-yes", t(cx, k::CLEAR))
                            .danger()
                            .on_click(move |_, _, cx| {
                                confirm.update(cx, |view, cx| view.mutate(revision, None, cx))
                            }),
                    )
                    .on_close(move |_, cx| {
                        close.update(cx, |view, cx| {
                            view.confirm = None;
                            cx.notify();
                        })
                    }),
            ));
        }
        body
    }
}
