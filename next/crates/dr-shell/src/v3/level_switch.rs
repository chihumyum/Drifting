//! Guarded UI flow for the entry `层级` switch (`entry.set_level`,
//! `kernel-v5.md` §16 「关掉层级、删掉条目」).
//!
//! Turning the switch on, or off with nothing living under it, commits
//! immediately under record preconditions. Turning it off while live
//! entries live under it asks first, in one sentence (「下面的 N 个条目会放进最近删除。」),
//! N counting every live entry below it however deep: they go to Recently
//! Deleted with it. What is attached to it and its lanes are not touched,
//! so they are never asked about. If what the dialog said changes before
//! the author confirms, the dialog shows the new number and asks again,
//! with no further words; the write is guarded on the entry and on every
//! live entry below it and the order of what lives under each, so nothing
//! changes between the last read and the write either. After it is off, a
//! notice offers 「撤销」 (`workspace/toast.rs`).

use std::collections::{BTreeSet, HashMap};

use crate::{
    actions::Dismiss,
    pages::PageViewHost,
    strings::{t, tf, tp},
    workspace::toast::offer_undo_after,
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
use serde_json::{Value, json};

/// Consistent snapshot of an entry's `层级` switch and of what turning it
/// off puts in Recently Deleted, with the record preconditions, read from
/// the same Loro frontier.
#[derive(Clone, Debug)]
pub struct SwitchInspection {
    pub level: bool,
    /// The live entries living below it, at any depth, in tree order. An
    /// entry already in Recently Deleted, and what is under it, is not
    /// among them: it stays as it is.
    pub below: Vec<String>,
    /// For turning it off: the entry, and every live entry below it with
    /// the order of what lives under each.
    pub preconditions: WritePreconditions,
    /// For turning it on: the entry and the order of what lives under it.
    turn_on: WritePreconditions,
}

impl SwitchInspection {
    /// Turning it off puts something in Recently Deleted: the author is
    /// asked first.
    pub fn needs_confirmation(&self) -> bool {
        self.level && !self.below.is_empty()
    }

    /// Whether `self` and `other` would ask the author the same thing.
    fn asks_the_same(&self, other: &SwitchInspection) -> bool {
        self.level == other.level && self.below == other.below
    }

    /// How many entries the dialog says go to Recently Deleted.
    pub fn below_count(&self) -> u64 {
        self.below.len() as u64
    }

    /// The dialog's words for what turning it off does.
    pub fn body_text(&self, cx: &App) -> SharedString {
        let count = self.below_count();
        tp(
            cx,
            keys::v3_shell::TURN_OFF_LEVEL_BODY,
            count,
            &[("count", &count)],
        )
    }
}

/// Reads `entry_id`'s current switch and every live entry living below it
/// (what `entry.set_level` turns off: by stored residence, stopping at an
/// entry already in Recently Deleted), with the digests of the entry, of
/// each of them and of the order of what lives under each, in one holder
/// read job.
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
        let raw = view.entries_raw();
        let mut children: HashMap<&EntryId, Vec<&EntryId>> = HashMap::new();
        for e in raw.iter().filter(|e| !e.is_trashed()) {
            if let Some(parent) = &e.parent {
                children.entry(parent).or_default().push(&e.id);
            }
        }
        let mut live_below: BTreeSet<&EntryId> = BTreeSet::new();
        let mut frontier = vec![&eid];
        while let Some(cur) = frontier.pop() {
            for child in children.get(cur).into_iter().flatten() {
                if live_below.insert(child) {
                    frontier.push(child);
                }
            }
        }
        // Tree order: `entries_raw` walks the tree depth first.
        let mut seen = BTreeSet::new();
        let below: Vec<String> = raw
            .iter()
            .filter(|e| live_below.contains(&e.id) && seen.insert(e.id.clone()))
            .map(|e| e.id.to_string())
            .collect();
        let mut keys = vec![
            RecordKey::entry(&entry_key),
            RecordKey::children_of(Some(&entry_key)),
        ];
        for id in &below {
            keys.push(RecordKey::entry(id));
            keys.push(RecordKey::children_of(Some(id)));
        }
        let observations =
            dr_workspace::observe_records_in(&format!("book:{bid}"), doc, &bid, &keys)?;
        let turn_on = WritePreconditions::from_records(observations[..2].to_vec());
        Ok(SwitchInspection {
            level: entry.is_level(),
            below,
            preconditions: WritePreconditions::from_records(observations),
            turn_on,
        })
    })
}

/// How a turn-off went.
enum TurnOff {
    /// It is off: what `entry.set_level` returned.
    Done(Value),
    /// It was already off.
    Gone,
    /// It hides something other than `shown` said: ask again.
    Ask(SwitchInspection),
}

/// Turns `entry_id` off when it still hides what `shown` said (or nothing
/// that needs asking), reading again right before the guarded write; a
/// write refused because the book moved on in between reads and tries
/// again, up to three times.
fn turn_off(
    lib: &Workspace,
    book_id: &str,
    entry_id: &str,
    shown: &SwitchInspection,
) -> Result<TurnOff, WsError> {
    let mut fresh = inspect_level_switch(lib, book_id, entry_id)?;
    for _ in 0..3 {
        if !fresh.level {
            return Ok(TurnOff::Gone);
        }
        if fresh.needs_confirmation() && !fresh.asks_the_same(shown) {
            return Ok(TurnOff::Ask(fresh));
        }
        match lib.call_guarded(
            &Actor::User,
            "entry.set_level",
            json!({ "book": book_id, "id": entry_id, "level": false }),
            fresh.preconditions.clone(),
        ) {
            Ok(answer) => return Ok(TurnOff::Done(answer)),
            Err(WsError::Conflict(_)) => {
                fresh = inspect_level_switch(lib, book_id, entry_id)?;
            }
            Err(err) => return Err(err),
        }
    }
    Ok(if fresh.level {
        TurnOff::Ask(fresh)
    } else {
        TurnOff::Gone
    })
}

pub(crate) fn host_still_valid(host: &PageViewHost, cx: &App) -> bool {
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

pub(crate) fn toast_save_failed(host: &PageViewHost, cx: &mut App) {
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

/// 「撤销」 for the turn-off `answer` recorded.
fn offer_undo(host: &PageViewHost, entry_id: &str, answer: &Value, cx: &mut App) {
    let label = t(cx, keys::v3_shell::TURN_OFF_LEVEL_TITLE);
    offer_undo_after(host, label, entry_id, answer, cx);
}

fn show_dialog_in(
    handle: AnyWindowHandle,
    host: PageViewHost,
    entry_id: String,
    info: SwitchInspection,
    refreshed: bool,
    window: &mut Window,
    cx: &mut App,
) {
    let view = cx.new(|cx| TurnOffLevelDialog::new(host, entry_id, info, refreshed, cx));
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
                        log::warn!("level switch inspect failed: {error}");
                        toast_save_failed(&host, cx);
                        return;
                    }
                };
                if info.needs_confirmation() {
                    show_dialog_in(handle, host, entry_id, info, false, window, cx);
                    return;
                }
                let turning_on = !info.level;
                let lib = host.library.clone();
                let book_id = host.book_id.clone();
                let eid = entry_id.clone();
                let write_job = cx.background_executor().spawn(async move {
                    if turning_on {
                        lib.call_guarded(
                            &Actor::User,
                            "entry.set_level",
                            json!({ "book": book_id, "id": eid, "level": true }),
                            info.turn_on.clone(),
                        )
                        .map(TurnOff::Done)
                    } else {
                        turn_off(&lib, &book_id, &eid, &info)
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
                                Ok(TurnOff::Done(answer)) => {
                                    if !turning_on {
                                        offer_undo(&host, &entry_id, &answer, cx);
                                    }
                                }
                                Ok(TurnOff::Gone) => {}
                                Ok(TurnOff::Ask(next)) => {
                                    show_dialog_in(handle, host, entry_id, next, true, window, cx);
                                }
                                Err(error) => {
                                    log::warn!("level switch write failed: {error}");
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

/// Confirmation modal shown when turning off `层级` puts the entries living
/// below it in Recently Deleted (`kernel-v5.md` §16).
pub struct TurnOffLevelDialog {
    host: PageViewHost,
    entry_id: String,
    info: SwitchInspection,
    focus: FocusHandle,
    busy: bool,
    refreshed: bool,
    error: bool,
}

impl TurnOffLevelDialog {
    pub fn new(
        host: PageViewHost,
        entry_id: String,
        info: SwitchInspection,
        refreshed: bool,
        cx: &mut Context<Self>,
    ) -> Self {
        Self {
            host,
            entry_id,
            info,
            focus: cx.focus_handle(),
            busy: false,
            refreshed,
            error: false,
        }
    }

    pub fn entry_id(&self) -> &str {
        &self.entry_id
    }

    /// How many entries the dialog says go to Recently Deleted: every live
    /// entry below it, however deep.
    pub fn below_count(&self) -> u64 {
        self.info.below_count()
    }

    /// The dialog's words, as it shows them.
    pub fn body_text(&self, cx: &App) -> SharedString {
        self.info.body_text(cx)
    }

    /// The dialog's title: 「关掉「人物」的层级？」.
    pub fn title_text(&self, cx: &App) -> SharedString {
        let name = self
            .host
            .book
            .v3()
            .and_then(|v| v.entry(&self.entry_id))
            .map(|e| e.title.clone())
            .unwrap_or_default();
        tf(
            cx,
            keys::v3_shell::TURN_OFF_LEVEL_QUESTION,
            &[("name", &name)],
        )
    }

    /// What it said changed before the author confirmed, and it shows the
    /// new numbers (no words of its own about that).
    pub fn has_conflict(&self) -> bool {
        self.refreshed
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
        let shown = self.info.clone();
        let (tx, rx) = futures::channel::oneshot::channel();
        cx.background_executor()
            .spawn(async move {
                let _ = tx.send(turn_off(&lib, &book_id, &eid, &shown));
            })
            .detach();
        cx.spawn_in(window, async move |this, cx| {
            let outcome = rx
                .await
                .unwrap_or_else(|_| Err(WsError::Internal("level switch worker stopped".into())));
            let _ = this.update(cx, |this, cx| {
                this.busy = false;
                match outcome {
                    Ok(TurnOff::Done(answer)) => {
                        this.cancel(cx);
                        offer_undo(&this.host, &this.entry_id, &answer, cx);
                    }
                    Ok(TurnOff::Gone) => this.cancel(cx),
                    Ok(TurnOff::Ask(next)) => {
                        this.info = next;
                        this.refreshed = true;
                        cx.notify();
                    }
                    Err(error) => {
                        log::warn!("turn off level failed: {error}");
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
        let body_copy = self.info.body_text(cx);
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
        let dialog = Dialog::new("v3-turn-off-level-dialog", self.title_text(cx))
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
                .danger()
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
