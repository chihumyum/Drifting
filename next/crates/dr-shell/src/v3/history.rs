//! Additive G1 entry-history registration. The legacy prose route stays intact.
use super::*;
use crate::{
    pages::{CardRows, PageMenuItem, PageMenuSection},
    strings::t,
};
use dr_i18n::keys;
use dr_ui::sand::Icon;
use gpui::{AppContext, Context};

pub fn register(cx: &mut App) {
    super::add_entry_card_rows(cx, |target, host, cx| {
        let Target::Entry { id, .. } = target else {
            return CardRows::default();
        };
        let Some(entry) = host.book.v3().and_then(|v| v.entry(id.as_str())) else {
            return CardRows::default();
        };
        let (weak, book, id, title) = (
            host.workspace.clone(),
            host.book_id.clone(),
            id.to_string(),
            entry.title.clone(),
        );
        CardRows {
            lead: Vec::new(),
            before_danger: vec![PageMenuSection {
                title: None,
                items: vec![PageMenuItem {
                    id: "entry-snapshot-history".into(),
                    label: t(cx, keys::entry_snapshot::TITLE),
                    icon: Icon::Rotate.into(),
                    checked: false,
                    danger: false,
                    run: Rc::new(move |window, cx| {
                        if let Some(ws) = weak.upgrade() {
                            ws.update(cx, |ws, cx| {
                                if ws.book_id == book {
                                    ws.open_entry_history(id.clone(), title.clone(), window, cx);
                                }
                            });
                        }
                    }),
                }],
            }],
        }
    });
}
impl crate::Workspace {
    pub fn open_entry_history(
        &mut self,
        entry: String,
        title: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(lib) = self.library.clone() else {
            return;
        };
        if self.book.v3().and_then(|v| v.entry(&entry)).is_none() {
            return;
        }
        let strings = crate::Strings::get(cx);
        let (locale, platform) = (strings.locale(), strings.platform());
        let target = dr_workspace::commands::v3::snapshots::EntryIn {
            book: self.book_id.clone(),
            entry,
        };
        let dialog = cx.new(|cx| {
            dr_view_history::EntryHistoryDialog::new(lib, target, title, locale, platform, cx)
        });
        cx.subscribe_in(&dialog, window, |ws, _, event, window, cx| {
            if *event == dr_view_history::HistoryEvent::Close {
                ws.dialog = None;
                ws.focus_handle().focus(window, cx);
                cx.notify();
            }
        })
        .detach();
        self.dialog = Some(dialog.into());
        cx.notify();
    }
}
