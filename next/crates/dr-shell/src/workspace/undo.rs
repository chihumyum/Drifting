//! Object-level undo and redo on [`Workspace`], stepping aside when a prose
//! editor or text input holds focus.

use dr_i18n::keys;
use dr_workspace::Actor;
use gpui::{Context, Window};

use super::{Workspace, find};
use crate::{actions as edit, keymap, strings::t};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum HistoryOp {
    Undo,
    Redo,
}

impl Workspace {
    pub(super) fn on_undo(&mut self, _: &edit::Undo, window: &mut Window, cx: &mut Context<Self>) {
        self.dispatch_history(HistoryOp::Undo, window, cx);
    }

    pub(super) fn on_redo(&mut self, _: &edit::Redo, window: &mut Window, cx: &mut Context<Self>) {
        self.dispatch_history(HistoryOp::Redo, window, cx);
    }

    fn dispatch_history(&mut self, op: HistoryOp, window: &mut Window, cx: &mut Context<Self>) {
        let stack = window.context_stack();
        if stack.iter().any(|c| c.contains(keymap::EDITOR)) {
            match op {
                HistoryOp::Undo => {
                    window.dispatch_action(Box::new(gpui_prose::input::actions::Undo), cx)
                }
                HistoryOp::Redo => {
                    window.dispatch_action(Box::new(gpui_prose::input::actions::Redo), cx)
                }
            }
            return;
        }
        if stack.iter().any(|c| {
            c.contains(dr_ui::input::field::KEY_CONTEXT)
                || c.contains(dr_ui::input::area::KEY_CONTEXT)
                || c.contains(find::KEY_CONTEXT)
        }) {
            return;
        }
        if self.covered() || self.search.is_some() || self.composer.is_some() {
            return;
        }
        if self.library.is_none() || self.book_id.is_empty() {
            return;
        }
        self.history_ops.push_back(op);
        self.drain_history_ops(cx);
    }

    pub(super) fn clear_history_ops(&mut self) {
        self.history_ops.clear();
        self.history_task = None;
    }

    fn drain_history_ops(&mut self, cx: &mut Context<Self>) {
        if self.history_task.is_some() {
            return;
        }
        let Some(op) = self.history_ops.pop_front() else {
            return;
        };
        let Some(lib) = self.library.clone() else {
            self.history_ops.clear();
            return;
        };
        let book = self.book_id.clone();
        let identity = lib.library() as *const _ as usize;
        self.history_task = Some(cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    match op {
                        HistoryOp::Undo => lib.undo(&Actor::User),
                        HistoryOp::Redo => lib.redo(&Actor::User),
                    }
                })
                .await;
            this.update(cx, |ws, cx| {
                ws.history_task = None;
                let same_lib = ws
                    .library
                    .as_ref()
                    .is_some_and(|cur| cur.library() as *const _ as usize == identity);
                if let Err(error) = result {
                    log::warn!("workspace {op:?}: {error}");
                    if same_lib && ws.book_id == book {
                        let text = t(cx, keys::common::SAVE_FAILED);
                        ws.toast(text, cx);
                    }
                }
                if same_lib && ws.book_id == book {
                    ws.drain_history_ops(cx);
                } else {
                    ws.history_ops.clear();
                }
            })
            .ok();
        }));
    }
}
