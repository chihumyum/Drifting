//! Guarded UI flow for the entry `层级` switch (`entry.set_level`, kernel-v4 §3).
//!
//! Turning the switch on, or turning it off when nothing lives underneath,
//! commits immediately under record preconditions on `entries/<id>` and
//! `children_of(<id>)`. Turning it off when resident children exist opens a
//! confirmation dialog naming the exact count `N`; if another writer changes
//! those children before confirmation commits, the guarded write conflicts,
//! re-reads the live count and asks the author again without overwriting.

use crate::{
    actions::Dismiss,
    pages::PageViewHost,
    strings::{t, tp},
};
use dr_doc::v3::BorrowedBookV3;
use dr_i18n::keys;
use dr_model::id::{BookId, EntryId};
use dr_ui::{
    Theme,
    components::{Button, Dialog},
    text::wrapped,
};
use dr_workspace::{Actor, RecordKey, Workspace, WritePreconditions, WsError};
use gpui::{prelude::*, *};
use serde_json::json;

/// Consistent snapshot of an entry's `层级` switch, live direct resident child
/// count, and record preconditions read from the same Loro frontier.
#[derive(Clone, Debug)]
pub struct SwitchInspection {
    pub level: bool,
    pub child_count: u64,
    pub preconditions: WritePreconditions,
}

/// Reads `entry_id`'s current switch state, resident child count, and
/// `RecordKey::entry` + `RecordKey::children_of(Some(entry_id))` digests in one
/// holder read job.
pub fn inspect_level_switch(
    lib: &Workspace,
    book_id: &str,
    entry_id: &str,
) -> Result<SwitchInspection, WsError> {
    let bid = BookId::parse(book_id).map_err(|e| WsError::Invalid(e.to_string()))?;
    let eid = EntryId::parse(entry_id).map_err(|e| WsError::Invalid(e.to_string()))?;
    let entry_key = entry_id.to_owned();
    lib.read_book_v3(book_id, move |doc, _| {
        let bb = BorrowedBookV3::new(doc, &bid).map_err(|e| WsError::Invalid(e.to_string()))?;
        let view = bb.view();
        let entry = view
            .entry(&eid)
            .filter(|e| !e.is_trashed())
            .ok_or_else(|| WsError::NotFound {
                what: "entry",
                id: entry_key.clone(),
            })?;
        let child_count = view.structure_snapshot().children_of(Some(&eid)).len() as u64;
        let keys = [
            RecordKey::entry(&entry_key),
            RecordKey::children_of(Some(&entry_key)),
        ];
        let observations =
            dr_workspace::observe_records_in(&format!("book:{bid}"), doc, &bid, &keys)?;
        Ok(SwitchInspection {
            level: entry.is_level(),
            child_count,
            preconditions: WritePreconditions::from_records(observations),
        })
    })
}

fn host_still_valid(host: &PageViewHost, cx: &App) -> bool {
    let Some(ws) = host.workspace.upgrade() else {
        return true;
    };
    let ws = ws.read(cx);
    ws.book_id == host.book_id
        && ws
            .library
            .as_ref()
            .is_some_and(|lib| std::ptr::eq(lib.library(), host.library.library()))
}

fn toast_save_failed(host: &PageViewHost, cx: &mut App) {
    let Some(ws) = host.workspace.upgrade() else {
        return;
    };
    let book_id = host.book_id.clone();
    let ptr = host.library.library() as *const _ as usize;
    let text = t(cx, keys::common::SAVE_FAILED);
    ws.update(cx, |ws, cx| {
        if ws.book_id == book_id
            && ws
                .library
                .as_ref()
                .is_some_and(|lib| lib.library() as *const _ as usize == ptr)
        {
            ws.toast(text, cx);
        }
    });
}

fn show_dialog_in(
    handle: AnyWindowHandle,
    host: PageViewHost,
    entry_id: String,
    info: SwitchInspection,
    conflict: bool,
    window: &mut Window,
    cx: &mut App,
) {
    let view = cx.new(|cx| TurnOffLevelDialog::new(host, entry_id, info, conflict, cx));
    let focus = view.read(cx).focus.clone();
    window.focus(&focus, cx);
    crate::dialogs::show_in(handle, cx, view.into());
}

/// Toggles `entry_id`'s `层级` switch from the entry page or sidebar card.
pub fn toggle_level(host: PageViewHost, entry_id: String, window: &mut Window, cx: &mut App) {
    if !host_still_valid(&host, cx) {
        return;
    }
    let handle = window.window_handle();
    let lib = host.library.clone();
    let book_id = host.book_id.clone();
    let eid = entry_id.clone();
    let read_job = cx
        .background_executor()
        .spawn(async move { inspect_level_switch(&lib, &book_id, &eid) });
    window
        .spawn(cx, async move |cx| {
            let inspected = read_job.await;
            cx.update(|window, cx| {
                if !host_still_valid(&host, cx) {
                    return;
                }
                let info = match inspected {
                    Ok(info) => info,
                    Err(error) => {
                        log::warn!("v4 level switch inspect failed: {error}");
                        toast_save_failed(&host, cx);
                        return;
                    }
                };
                if info.level && info.child_count > 0 {
                    show_dialog_in(handle, host, entry_id, info, false, window, cx);
                    return;
                }
                let target_level = !info.level;
                let preconditions = info.preconditions;
                let lib = host.library.clone();
                let book_id = host.book_id.clone();
                let eid = entry_id.clone();
                let write_job = cx.background_executor().spawn(async move {
                    let res = lib.call_guarded(
                        &Actor::User,
                        "entry.set_level",
                        json!({ "book": book_id, "id": eid, "level": target_level }),
                        preconditions,
                    );
                    match res {
                        Ok(_) => Ok(None),
                        Err(WsError::Conflict(_)) if !target_level => {
                            inspect_level_switch(&lib, &book_id, &eid).map(Some)
                        }
                        Err(err) => Err(err),
                    }
                });
                window
                    .spawn(cx, async move |cx| {
                        let outcome = write_job.await;
                        cx.update(|window, cx| {
                            if !host_still_valid(&host, cx) {
                                return;
                            }
                            match outcome {
                                Ok(None) => {}
                                Ok(Some(next)) if next.level && next.child_count > 0 => {
                                    show_dialog_in(handle, host, entry_id, next, true, window, cx);
                                }
                                Ok(Some(_)) => toast_save_failed(&host, cx),
                                Err(error) => {
                                    log::warn!("v4 level switch write failed: {error}");
                                    toast_save_failed(&host, cx);
                                }
                            }
                        })
                        .ok();
                    })
                    .detach();
            })
            .ok();
        })
        .detach();
}

/// Confirmation modal shown when turning off `层级` on an entry with resident
/// children underneath (`kernel-v4.md` §3).
pub struct TurnOffLevelDialog {
    host: PageViewHost,
    entry_id: String,
    child_count: u64,
    preconditions: WritePreconditions,
    focus: FocusHandle,
    busy: bool,
    conflict: bool,
    error: bool,
}

impl TurnOffLevelDialog {
    pub fn new(
        host: PageViewHost,
        entry_id: String,
        info: SwitchInspection,
        conflict: bool,
        cx: &mut Context<Self>,
    ) -> Self {
        Self {
            host,
            entry_id,
            child_count: info.child_count,
            preconditions: info.preconditions,
            focus: cx.focus_handle(),
            busy: false,
            conflict,
            error: false,
        }
    }

    pub fn entry_id(&self) -> &str {
        &self.entry_id
    }

    pub fn child_count(&self) -> u64 {
        self.child_count
    }

    pub fn has_conflict(&self) -> bool {
        self.conflict
    }

    pub fn is_busy(&self) -> bool {
        self.busy
    }

    pub fn cancel(&mut self, cx: &mut Context<Self>) {
        let id = cx.entity_id();
        crate::dialogs::hide(cx, id);
    }

    pub fn confirm(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        if !host_still_valid(&self.host, cx) {
            self.cancel(cx);
            return;
        }
        self.busy = true;
        self.error = false;
        let lib = self.host.library.clone();
        let book_id = self.host.book_id.clone();
        let eid = self.entry_id.clone();
        let preconditions = self.preconditions.clone();
        let (tx, rx) = futures::channel::oneshot::channel();
        cx.background_executor()
            .spawn(async move {
                let res = lib.call_guarded(
                    &Actor::User,
                    "entry.set_level",
                    json!({ "book": book_id, "id": eid, "level": false }),
                    preconditions,
                );
                let out = match res {
                    Ok(_) => Ok(None),
                    Err(WsError::Conflict(_)) => {
                        inspect_level_switch(&lib, &book_id, &eid).map(Some)
                    }
                    Err(err) => Err(err),
                };
                let _ = tx.send(out);
            })
            .detach();
        cx.spawn_in(window, async move |this, cx| {
            let outcome = rx
                .await
                .unwrap_or_else(|_| Err(WsError::Internal("level switch worker stopped".into())));
            let _ = this.update(cx, |this, cx| {
                this.busy = false;
                match outcome {
                    Ok(None) => this.cancel(cx),
                    Ok(Some(next)) => {
                        if !next.level {
                            this.cancel(cx);
                        } else {
                            this.child_count = next.child_count;
                            this.preconditions = next.preconditions;
                            this.conflict = true;
                            this.error = false;
                            cx.notify();
                        }
                    }
                    Err(error) => {
                        log::warn!("v4 turn off level failed: {error}");
                        this.error = true;
                        cx.notify();
                    }
                }
            });
        })
        .detach();
        cx.notify();
    }
}

impl Render for TurnOffLevelDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let body_copy = tp(
            cx,
            keys::v3_shell::TURN_OFF_LEVEL_BODY,
            self.child_count,
            &[("count", &self.child_count)],
        );
        let mut body = div()
            .id("v3-turn-off-level-body")
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .id("v3-turn-off-level-copy")
                    .role(gpui::Role::Label)
                    .aria_label(body_copy.clone())
                    .child(wrapped(body_copy)),
            );
        if self.conflict {
            let msg = t(cx, keys::v3_shell::TURN_OFF_LEVEL_CONFLICT);
            body = body.child(
                div()
                    .id("v3-turn-off-level-conflict")
                    .role(gpui::Role::Alert)
                    .aria_label(msg.clone())
                    .text_color(p.danger.solid())
                    .child(wrapped(msg)),
            );
        }
        if self.error {
            let msg = t(cx, keys::common::SAVE_FAILED);
            body = body.child(
                div()
                    .id("v3-turn-off-level-error")
                    .role(gpui::Role::Alert)
                    .aria_label(msg.clone())
                    .text_color(p.danger.solid())
                    .child(msg),
            );
        }
        let weak = cx.entity().downgrade();
        let cancel_weak = weak.clone();
        let confirm_weak = weak.clone();
        let dialog = Dialog::new(
            "v3-turn-off-level-dialog",
            t(cx, keys::v3_shell::TURN_OFF_LEVEL_TITLE),
        )
        .width(440.0)
        .body(body)
        .action(
            Button::new("v3-turn-off-level-cancel", t(cx, keys::common::CANCEL))
                .text()
                .disabled(self.busy)
                .on_click(move |_, _, cx| {
                    let _ = cancel_weak.update(cx, |this, cx| this.cancel(cx));
                }),
        )
        .action(
            Button::new(
                "v3-turn-off-level-confirm",
                t(cx, keys::v3_shell::TURN_OFF_LEVEL_CONFIRM),
            )
            .primary()
            .busy(self.busy)
            .disabled(self.busy)
            .on_click(move |_, window, cx| {
                let _ = confirm_weak.update(cx, |this, cx| this.confirm(window, cx));
            }),
        )
        .on_close(move |_, cx| {
            let _ = weak.update(cx, |this, cx| {
                if !this.busy {
                    this.cancel(cx);
                }
            });
        });

        div()
            .track_focus(&self.focus)
            .key_context("V3TurnOffLevelDialog")
            .on_action(cx.listener(|this, _: &Dismiss, _, cx| {
                if !this.busy {
                    this.cancel(cx);
                }
            }))
            .child(dialog)
    }
}
