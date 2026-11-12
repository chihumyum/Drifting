//! The author edits F3 memory entries directly. There is no second Markdown
//! document and no approval tier. Only active entries appear as instructions.
use crate::controller::AgentController;
use dr_agent::memory::{self, ProjectSnapshot};
use dr_i18n::keys;
use dr_model::id::{BookId, MemoryId};
use dr_shell::strings::{t, tf};
use dr_ui::{
    Theme,
    components::{Button, Dialog, Layer, Place, float},
    fonts::Role,
    input::{FieldEvent, TextArea},
    style::DrStyled,
};
use dr_workspace::{Actor, RecordKey, WritePreconditions, WsEvent};
use futures::{
    StreamExt as _,
    channel::{mpsc, oneshot},
};
use gpui::{
    AppContext as _, Context, Entity, Focusable as _, InteractiveElement as _, IntoElement,
    ParentElement, Render, ScrollHandle, StatefulInteractiveElement as _, Styled, Subscription,
    Window, canvas, div, prelude::FluentBuilder as _, px,
};
use keys::project_memory as k;
use serde_json::json;

struct Draft {
    id: Option<MemoryId>,
    /// The guard of the snapshot the author inspected.
    guard: WritePreconditions,
}
struct Reveal {
    id: MemoryId,
    serial: u64,
    loaded: bool,
    scrolled: bool,
    reply: oneshot::Sender<bool>,
}
pub struct ProjectMemoryView {
    controller: AgentController,
    book: BookId,
    snapshot: Option<ProjectSnapshot>,
    editor: Entity<TextArea>,
    draft: Option<Draft>,
    busy: bool,
    loading: bool,
    visible: bool,
    closed: bool,
    serial: u64,
    next_reveal: u64,
    reveal: Option<Reveal>,
    error: Option<String>,
    confirm: Option<(MemoryId, WritePreconditions)>,
    scroll: ScrollHandle,
    _input: Subscription,
    subscription: Option<dr_workspace::Subscription>,
}
impl ProjectMemoryView {
    pub fn new(
        controller: AgentController,
        book: BookId,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let editor = cx.new(|cx| {
            TextArea::new("project-memory-editor", window, cx)
                .framed(6.0)
                .placeholder(tf(
                    cx,
                    k::PLACEHOLDER,
                    &[(
                        "shortcut",
                        &if cfg!(target_os = "macos") {
                            "⌘↵"
                        } else {
                            "Ctrl+Enter"
                        },
                    )],
                ))
        });
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
            draft: None,
            busy: false,
            loading: false,
            visible: true,
            closed: false,
            serial: 0,
            next_reveal: 0,
            reveal: None,
            error: None,
            confirm: None,
            scroll: ScrollHandle::new(),
            _input: input,
            subscription: None,
        }
    }
    fn watch(&mut self, cx: &mut Context<Self>) {
        let book = self.book.clone();
        let (send, mut receive) = mpsc::unbounded();
        let job = self.controller.workspace_job(move |ws| {
            Ok(ws.subscribe(move |event| {
                // Project Memory is the book's content; a writing day or a
                // saved checkpoint is not.
                if matches!(event,WsEvent::Book(change) if change.book==book) {
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
        if visible && !self.closed {
            self.refresh(cx);
        } else {
            self.cancel_reveal();
            self.confirm = None;
        }
        cx.notify();
    }
    pub fn close(&mut self, cx: &mut Context<Self>) {
        self.closed = true;
        self.visible = false;
        self.serial += 1;
        self.cancel_reveal();
        self.confirm = None;
        self.subscription = None;
        cx.notify();
    }
    fn cancel_reveal(&mut self) {
        if let Some(request) = self.reveal.take() {
            let _ = request.reply.send(false);
        }
    }
    fn clean_reveal(&mut self) {
        if self.reveal.as_ref().is_some_and(|r| r.reply.is_canceled()) {
            self.reveal = None;
        }
    }
    pub fn reveal(&mut self, id: MemoryId, cx: &mut Context<Self>) -> oneshot::Receiver<bool> {
        self.cancel_reveal();
        let (send, receive) = oneshot::channel();
        if self.closed || !self.visible || self.controller.is_closed() {
            let _ = send.send(false);
            return receive;
        }
        self.next_reveal += 1;
        self.reveal = Some(Reveal {
            id,
            serial: self.next_reveal,
            loaded: false,
            scrolled: false,
            reply: send,
        });
        self.refresh(cx);
        receive
    }
    fn refresh(&mut self, cx: &mut Context<Self>) {
        self.clean_reveal();
        if self.closed || self.controller.is_closed() {
            self.cancel_reveal();
            return;
        }
        self.serial += 1;
        let serial = self.serial;
        let book = self.book.clone();
        let job = self
            .controller
            .workspace_job(move |ws| memory::project(ws, &book).map_err(|e| e.to_string()));
        self.loading = true;
        cx.spawn(async move |this, cx| {
            let result = job.await;
            let _ = this.update(cx, |view, cx| {
                if view.closed || view.controller.is_closed() || view.serial != serial {
                    return;
                }
                view.loading = false;
                view.clean_reveal();
                match result {
                    Ok(snapshot) => {
                        if let Some(request) = view.reveal.as_mut() {
                            if snapshot
                                .entries
                                .iter()
                                .any(|e| e.id == request.id && e.active())
                            {
                                request.loaded = true;
                            } else {
                                view.cancel_reveal();
                            }
                        }
                        view.snapshot = Some(snapshot);
                    }
                    Err(error) => {
                        view.snapshot = None;
                        view.error = Some(error);
                        view.cancel_reveal();
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    fn blocked(&self, cx: &gpui::App) -> bool {
        self.busy
            || self.closed
            || self.controller.is_closed()
            || dr_shell::release::is_releasing(cx)
    }
    fn begin_edit(&mut self, id: Option<MemoryId>, window: &mut Window, cx: &mut Context<Self>) {
        if self.blocked(cx) {
            return;
        }
        let Some(snapshot) = &self.snapshot else {
            return;
        };
        let text = if let Some(id) = &id {
            let Some(entry) = snapshot.entries.iter().find(|e| e.id == *id && e.active()) else {
                return;
            };
            entry.body.as_str()
        } else {
            ""
        };
        self.editor
            .update(cx, |editor, cx| editor.set_text(text, cx));
        self.draft = Some(Draft {
            id,
            guard: snapshot.guard.clone(),
        });
        self.error = None;
        window.focus(&self.editor.focus_handle(cx), cx);
        cx.notify();
    }
    fn save(&mut self, cx: &mut Context<Self>) {
        if self.blocked(cx) || self.editor.read(cx).is_composing() {
            return;
        }
        let Some(draft) = &self.draft else {
            return;
        };
        let body = self.editor.read(cx).text();
        if body.trim().is_empty() {
            return;
        }
        let (name, args) = if let Some(id) = &draft.id {
            (
                "memory.update",
                json!({"book":self.book,"id":id,"body":body}),
            )
        } else {
            ("memory.add", json!({"book":self.book,"body":body}))
        };
        self.mutate(name, args, draft.guard.clone(), cx);
    }
    fn mutate(
        &mut self,
        name: &'static str,
        args: serde_json::Value,
        guard: WritePreconditions,
        cx: &mut Context<Self>,
    ) {
        if self.blocked(cx) {
            return;
        }
        let book = self.book.clone();
        let job = self.controller.workspace_job(move |ws| {
            // Confirm this book is still live. The guard holds the write to
            // the entry as the author inspected it and to the book not being
            // in the trash, so a concurrent trash/edit fails atomically.
            memory::project(ws, &book).map_err(|e| e.to_string())?;
            ws.call_guarded(
                &Actor::User,
                name,
                args,
                guard.with_value(
                    format!("book:{book}"),
                    RecordKey::record("meta", "deleted_at"),
                    [serde_json::Value::Null],
                ),
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        });
        self.busy = true;
        self.error = None;
        self.confirm = None;
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
                    Ok(()) => view.draft = None,
                    Err(error) => view.error = Some(error),
                }
                view.refresh(cx);
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
}
impl Render for ProjectMemoryView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.clean_reveal();
        if !self.visible || self.closed || self.controller.is_closed() {
            self.cancel_reveal();
        }
        let muted = Theme::of(window, cx).palette.muted().solid();
        let blocked = self.blocked(cx);
        let mut rows = Vec::new();
        if let Some(snapshot) = &self.snapshot {
            for entry in snapshot.entries.iter().filter(|e| e.active()) {
                let id = entry.id.clone();
                let remove_id = id.clone();
                let guard = snapshot.guard.clone();
                let editing = self
                    .draft
                    .as_ref()
                    .is_some_and(|d| d.id.as_ref() == Some(&id));
                let mut row = div()
                    .id(format!("project-memory-{id}"))
                    .debug_selector(|| format!("project-memory-{id}"))
                    .relative()
                    .w_full()
                    .min_w_0()
                    .p(px(12.0))
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .child(div().child(entry.body.clone()))
                    .child(
                        div()
                            .flex()
                            .gap(px(8.0))
                            .child(
                                Button::new(format!("memory-edit-{id}"), t(cx, k::EDIT))
                                    .small()
                                    .text()
                                    .disabled(blocked || editing)
                                    .on_click(cx.listener(move |view, _, window, cx| {
                                        view.begin_edit(Some(id.clone()), window, cx)
                                    })),
                            )
                            .child(
                                Button::new(format!("memory-delete-{remove_id}"), t(cx, k::DELETE))
                                    .small()
                                    .text()
                                    .disabled(blocked)
                                    .on_click(cx.listener(move |view, _, _, cx| {
                                        view.confirm = Some((remove_id.clone(), guard.clone()));
                                        cx.notify();
                                    })),
                            ),
                    );
                if let Some(request) = self
                    .reveal
                    .as_mut()
                    .filter(|r| r.loaded && r.id == entry.id)
                {
                    if !request.scrolled {
                        self.scroll.scroll_to_top_of_item(rows.len());
                        request.scrolled = true;
                    }
                    let serial = request.serial;
                    let book = self.book.clone();
                    let view = cx.weak_entity();
                    row = row.child(
                        canvas(
                            |_, _, _| (),
                            move |bounds, _, window, cx| {
                                let mask = window.content_mask().bounds;
                                let shown = bounds.intersect(&mask);
                                // A very long entry need not fit: its heading/start must
                                // actually be painted inside the scroll viewport.
                                if !shown.is_empty()
                                    && bounds.top() >= mask.top() - px(1.0)
                                    && shown.size.height
                                        >= bounds.size.height.min(px(24.0)) - px(1.0)
                                {
                                    window.defer(cx, move |_, cx| {
                                        let _ = view.update(cx, |view, _| {
                                            if view.visible
                                                && !view.closed
                                                && !view.controller.is_closed()
                                                && view.book == book
                                                && view.reveal.as_ref().is_some_and(|r| {
                                                    r.serial == serial
                                                        && r.loaded
                                                        && !r.reply.is_canceled()
                                                })
                                                && let Some(request) = view.reveal.take()
                                            {
                                                let _ = request.reply.send(true);
                                            }
                                        });
                                    });
                                }
                            },
                        )
                        .absolute()
                        .top_0()
                        .left_0()
                        .size_full(),
                    );
                }
                rows.push(row.into_any_element());
            }
        }
        let mut body = div()
            .id("project-memory")
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
                    .child(t(cx, k::DESC)),
            )
            .child(
                div()
                    .id("project-memory-list")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll)
                    .when(rows.is_empty() && !self.loading, |list| {
                        list.child(t(cx, k::EMPTY))
                    })
                    .children(rows),
            );
        if self.draft.is_some() {
            body = body.child(self.editor.clone()).child(
                div()
                    .flex()
                    .gap(px(8.0))
                    .child(
                        Button::new("project-memory-save", t(cx, k::SAVE))
                            .primary()
                            .disabled(blocked)
                            .on_click(cx.listener(|view, _, _, cx| view.save(cx))),
                    )
                    .child(
                        Button::new("project-memory-cancel", t(cx, k::CANCEL))
                            .disabled(blocked)
                            .on_click(cx.listener(|view, _, _, cx| {
                                view.draft = None;
                                view.error = None;
                                cx.notify();
                            })),
                    ),
            );
        } else {
            body = body.child(
                Button::new("project-memory-add", t(cx, k::ADD))
                    .disabled(blocked || self.snapshot.is_none())
                    .on_click(cx.listener(|view, _, window, cx| view.begin_edit(None, window, cx))),
            );
        }
        if let Some(error) = &self.error {
            body = body.child(
                div()
                    .font_role(Role::Index)
                    .text_color(muted)
                    .child(format!("{}: {error}", t(cx, keys::common::SAVE_FAILED))),
            );
        }
        if let Some((id, guard)) = self.confirm.clone() {
            let cancel = cx.entity();
            let close = cx.entity();
            let confirm = cx.entity();
            let book = self.book.clone();
            body = body.child(float(
                Place::Center,
                Layer::Dialog,
                Dialog::new("project-memory-delete", t(cx, k::DELETE))
                    .body(div().child(t(cx, k::DELETE_CONFIRM)))
                    .action(
                        Button::new("project-memory-delete-cancel", t(cx, k::CANCEL)).on_click(
                            move |_, _, cx| {
                                cancel.update(cx, |view, cx| {
                                    view.confirm = None;
                                    cx.notify();
                                })
                            },
                        ),
                    )
                    .action(
                        Button::new("project-memory-delete-yes", t(cx, k::DELETE))
                            .danger()
                            .on_click(move |_, _, cx| {
                                confirm.update(cx, |view, cx| {
                                    view.mutate(
                                        "memory.remove",
                                        json!({"book":book,"id":id}),
                                        guard.clone(),
                                        cx,
                                    )
                                })
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
