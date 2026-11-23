//! Undoing the author's structure from the window (author 2026-11-13).
//!
//! - ⌘Z / ⇧⌘Z (`edit::Undo`, `edit::Redo`) stay the prose editor's while
//!   one has the keyboard: its own undo of its own typing, unchanged. In a
//!   text field, a text area or the find bar they do nothing, as before; a
//!   dialog, Settings, search, the comment composer and the notification
//!   center keep them too. Anywhere else in an open book they undo or redo
//!   the author's latest undoable command in this book
//!   ([`dr_workspace::Workspace::undo_in`]), in the journal's order whatever
//!   it was (a 层级 turned off, a move, a rename, a field), and a notice says
//!   what it was and offers the other direction.
//! - The notice after turning a 层级 off, moving an entry or changing its
//!   template ([`super::toast`]) undoes exactly that step, and nothing if a
//!   newer step of the author's came after it in the book.
//! - An Agent's commands are on its own journal stack (`agent:<session>`),
//!   never the author's: they are taken back through snapshot history.

use std::collections::VecDeque;

use dr_i18n::keys;
use dr_workspace::{Actor, EffectAction, journal::JournalEntry};
use gpui::{App, Context, SharedString, Task, Window};

use super::Workspace;
use super::toast::{Offer, offer_text};

/// Key contexts where ⌘Z is never the book's: typing in them is not a
/// journal step (dr-ui's inputs, the find bar), or a prose editor whose own
/// undo answers it.
const KEEP_CONTEXTS: &[&str] = &[
    dr_ui::input::field::KEY_CONTEXT,
    dr_ui::input::area::KEY_CONTEXT,
    super::find::KEY_CONTEXT,
    crate::keymap::EDITOR,
];

/// A committed new row of the workspace journal (`seq` in its key).
pub(super) fn is_journal_row(change: &dr_store::LocalChange) -> bool {
    change.table == dr_workspace::journal::TABLE && change.kind == dr_store::LocalChangeKind::Insert
}

/// One undo or redo the author asked for while another was still running.
#[derive(Clone, Debug)]
struct Request {
    redo: bool,
    only: Option<i64>,
    text: Option<SharedString>,
}

/// The window's undo and redo of book commands, one at a time.
#[derive(Default)]
pub struct StructureUndo {
    running: Option<Task<()>>,
    queued: VecDeque<Request>,
}

impl Workspace {
    /// `edit::Undo` / `edit::Redo` reached the workspace: the book's when no
    /// editor, input or dialog keeps it ([`structure_has_keyboard`]),
    /// otherwise passed on (the editor's own `Undo` binding comes next).
    ///
    /// [`structure_has_keyboard`]: Workspace::structure_has_keyboard
    pub(super) fn on_edit_undo(&mut self, redo: bool, window: &mut Window, cx: &mut Context<Self>) {
        if !self.structure_has_keyboard(window, cx) {
            // The caret is in a prose editor: hand it the editor's own
            // undo. A key would fall through to the editor's binding once
            // this propagates, but the edit menu's item has no key to fall
            // through with, and an entry page is not wrapped in
            // `forward_edit_actions` (its fields are the book's to undo).
            let prose_undo = gpui_prose::input::actions::Undo;
            if window.is_action_available(&prose_undo, cx) {
                if redo {
                    window.dispatch_action(Box::new(gpui_prose::input::actions::Redo), cx);
                } else {
                    window.dispatch_action(Box::new(prose_undo), cx);
                }
                return;
            }
            cx.propagate();
            return;
        }
        // Taken here, the key no longer reaches the entry page's own key
        // listener, which lets go of a section held in view when the author
        // presses a key in the page (`EntryPage::pinned`): let go for it, as
        // before, when the keyboard is in that page.
        let pages: Vec<_> = self.editors.values().filter_map(|p| p.v3.clone()).collect();
        for page in pages {
            if page.read(cx).focus.contains_focused(window, cx) {
                page.update(cx, |page, cx| page.release_pin(cx));
            }
        }
        self.undo_in_book(redo, None, None, cx);
    }

    /// Whether ⌘Z here is the book's: a book is open and in front, nothing
    /// covers it that keeps the keys, and the keyboard is in no prose editor
    /// (the editor's own undo, `gpui_prose`'s `Undo`, is not available along
    /// the focus path) and no text input.
    pub fn structure_has_keyboard(&self, window: &Window, cx: &App) -> bool {
        if self.book_id.is_empty()
            || self.library.is_none()
            || self.book.v3().is_none()
            || self.shelf_open
            || self.modal()
            || self.settings.is_some()
            || self.search.is_some()
            || self.composer.is_some()
            || self.notifications_open
            || self.account_open
        {
            return false;
        }
        if window.is_action_available(&gpui_prose::input::actions::Undo, cx) {
            return false;
        }
        !window
            .context_stack()
            .iter()
            .any(|c| KEEP_CONTEXTS.iter().any(|name| c.contains(name)))
    }

    /// Undoes (or with `redo`, redoes) the author's latest command in the
    /// open book, or only journal row `only` when that is still the one.
    /// Then a notice says what (`text`, or the row described) and offers the
    /// other direction. One at a time: a request while one runs waits.
    pub(super) fn undo_in_book(
        &mut self,
        redo: bool,
        only: Option<i64>,
        text: Option<SharedString>,
        cx: &mut Context<Self>,
    ) {
        let request = Request { redo, only, text };
        if self.structure_undo.running.is_some() {
            self.structure_undo.queued.push_back(request);
            return;
        }
        self.run_undo(request, cx);
    }

    fn run_undo(&mut self, request: Request, cx: &mut Context<Self>) {
        let (Some(lib), false) = (self.library.clone(), self.book_id.is_empty()) else {
            self.structure_undo.queued.clear();
            return;
        };
        let book = self.book_id.clone();
        let Request { redo, only, text } = request;
        let job = cx.background_executor().spawn({
            let book = book.clone();
            async move {
                if redo {
                    lib.redo_in(&Actor::User, &book, only)
                } else {
                    lib.undo_in(&Actor::User, &book, only)
                }
            }
        });
        self.structure_undo.running = Some(cx.spawn(async move |this, cx| {
            let result = job.await;
            this.update(cx, |ws, cx| {
                ws.structure_undo.running = None;
                match result {
                    Ok(Some(done)) if ws.book_id == book => {
                        let text = text.unwrap_or_else(|| describe(&done.entry, &ws.book, cx));
                        let offer = Offer {
                            book: book.clone(),
                            seq: done.entry.seq,
                            redo: !redo,
                        };
                        ws.notice(text, Some(offer), cx);
                    }
                    Ok(_) => {}
                    Err(error) => {
                        log::warn!("undo in the book failed: {error}");
                        let text = crate::t(cx, keys::common::SAVE_FAILED);
                        ws.toast_error(text, cx);
                    }
                }
                if let Some(next) = ws.structure_undo.queued.pop_front() {
                    ws.run_undo(next, cx);
                }
            })
            .ok();
        }));
    }

    /// New journal rows (`ws_journal` inserts, their `seq`): a step of the
    /// author's makes an older offer stale, and a move of an entry in the
    /// open book offers its own 「撤销」 — wherever it was made from (the
    /// sidebar, a list, a board, the element overview).
    pub(super) fn journal_recorded(&mut self, seqs: Vec<i64>, cx: &mut Context<Self>) {
        let (Some(lib), Some(&newest)) = (self.library.clone(), seqs.iter().max()) else {
            return;
        };
        let job = cx
            .background_executor()
            .spawn(async move { lib.journal(Some("user"), 8) });
        cx.spawn(async move |this, cx| {
            let Ok(rows) = job.await else {
                return;
            };
            this.update(cx, |ws, cx| {
                // Newest first; only the author's rows are read.
                let Some(at) = rows.iter().position(|r| r.seq == newest) else {
                    return;
                };
                let row = &rows[at];
                ws.drop_stale_offer(row.seq, row.book.as_deref(), cx);
                let in_book = row.book.as_deref() == Some(ws.book_id.as_str());
                let made_with = rows.get(at + 1);
                if in_book && is_offered_move(row, made_with) {
                    let text = describe(row, &ws.book, cx);
                    let book = ws.book_id.clone();
                    ws.offer_undo(text, &book, row.seq, cx);
                }
            })
            .ok();
        })
        .detach();
    }
}

/// A move the notice offers to undo: an author's undoable `entry.move`,
/// not the second half of making an entry (`新建下一章` creates the entry,
/// then moves it into place: undoing only the move would be no undo of
/// what the author did).
fn is_offered_move(row: &JournalEntry, before: Option<&JournalEntry>) -> bool {
    if row.command != "entry.move" || !row.undoable || row.state != "live" {
        return false;
    }
    let moved: Vec<&str> = row
        .effects
        .iter()
        .filter(|e| e.kind == "entry" && e.action == EffectAction::Moved)
        .map(|e| e.id.as_str())
        .collect();
    let just_made = before.is_some_and(|b| {
        b.command == "entry.create"
            && b.book == row.book
            && b.effects.iter().any(|e| {
                e.kind == "entry"
                    && e.action == EffectAction::Created
                    && moved.contains(&e.id.as_str())
            })
    });
    !moved.is_empty() && !just_made
}

/// What a journal row did, for a notice: an existing label for the
/// structure commands (「层级」, 「移动」) and the name of what it touched,
/// `label · name`; the name alone for other commands; the command's own
/// name when it touched nothing with a name. An entry the row does not name
/// (`entry.move` names none) is named by its title in `book`.
pub fn describe(row: &JournalEntry, book: &crate::book::Book, cx: &App) -> SharedString {
    let label = match row.command.as_str() {
        "entry.set_level" => Some(crate::t(cx, keys::v3_shell::LEVEL_SWITCH)),
        "entry.set_auto_link" | "entry.set_below_auto_link" => {
            Some(crate::t(cx, keys::v3_levels::AUTO_LINK))
        }
        "entry.move" => Some(crate::t(cx, keys::plot_grid::MOVE)),
        _ => None,
    };
    let name = row.effects.iter().find_map(|e| {
        let name = match &e.name {
            Some(name) => name.clone(),
            None if e.kind == "entry" => book.v3()?.entry(&e.id)?.title.clone(),
            None => return None,
        };
        let name = name.trim().to_owned();
        (!name.is_empty()).then_some(name)
    });
    match (label, name) {
        (Some(label), name) => offer_text(label, name.as_deref().unwrap_or_default()),
        (None, Some(name)) => SharedString::from(name),
        (None, None) => SharedString::from(row.command.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dr_workspace::Effect;

    fn row(seq: i64, command: &str, effects: Vec<Effect>) -> JournalEntry {
        JournalEntry {
            seq,
            ts: 0,
            actor: "user".into(),
            command: command.into(),
            book: Some("b".into()),
            effects,
            state: "live".into(),
            undoable: true,
        }
    }

    fn effect(action: EffectAction, id: &str) -> Effect {
        Effect {
            action,
            kind: "entry".into(),
            id: id.into(),
            name: None,
        }
    }

    #[test]
    fn a_move_is_offered_unless_it_places_the_entry_just_made() {
        let moved = row(2, "entry.move", vec![effect(EffectAction::Moved, "e")]);
        assert!(is_offered_move(&moved, None));
        let other = row(1, "entry.update", vec![effect(EffectAction::Updated, "e")]);
        assert!(is_offered_move(&moved, Some(&other)));
        // 「新建下一章」: created, then moved into place.
        let made = row(1, "entry.create", vec![effect(EffectAction::Created, "e")]);
        assert!(!is_offered_move(&moved, Some(&made)));
        let made_other = row(1, "entry.create", vec![effect(EffectAction::Created, "f")]);
        assert!(is_offered_move(&moved, Some(&made_other)));
        // Not a move, or nothing to undo.
        assert!(!is_offered_move(&other, None));
        let mut undone = moved.clone();
        undone.state = "undone".into();
        assert!(!is_offered_move(&undone, None));
        let mut fixed = moved.clone();
        fixed.undoable = false;
        assert!(!is_offered_move(&fixed, None));
    }
}
