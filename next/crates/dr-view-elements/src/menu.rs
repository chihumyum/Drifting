//! Canonical v3 level surface.
pub mod v3 {
    use crate::{
        data::v3::{Creation, creation, creation_attached, fresh, prepare},
        dialogs::v3::EntryMode,
    };
    use dr_i18n::keys;
    use dr_shell::{
        book::Book,
        nav::{Open, Target},
        pages::{CardRows, PageMenuItem, PageMenuSection, PageViewHost, RunRow},
        strings::t,
        v3::{card::EntryAction, entry_target},
    };
    use dr_workspace::WsError;
    use gpui::{App, AppContext as _, Window};
    use serde_json::json;
    use std::rc::Rc;

    pub fn register(cx: &mut App) {
        for (action, context_for) in [
            (
                EntryAction::New,
                creation as fn(&Book, &str) -> Option<Creation>,
            ),
            (EntryAction::NewAttached, creation_attached),
        ] {
            dr_shell::v3::add_entry_action(cx, action, move |target, host, _| {
                let Target::Entry { id, .. } = target else {
                    return None;
                };
                let context = context_for(&host.book, id.as_str())?;
                if !context.blank && context.default.is_none() {
                    return None;
                }
                let page = PageViewHost {
                    workspace: host.workspace.clone(),
                    library: host.library.clone()?,
                    book_id: host.book_id.clone(),
                    book: host.book.clone(),
                };
                let id = id.to_string();
                Some(Rc::new(move |_: &mut Window, cx: &mut App| {
                    let Some(page) = fresh(&page, cx) else {
                        return;
                    };
                    if let Some(context) = context_for(&page.book, &id) {
                        create(page, context, cx);
                    }
                }) as RunRow)
            });
        }
        for (action, mode) in [
            (EntryAction::ChangeTemplate, EntryMode::Template),
            (EntryAction::BelongTo, EntryMode::Membership),
        ] {
            dr_shell::v3::add_entry_action(cx, action, move |target, host, _| {
                let Target::Entry { id, .. } = target else {
                    return None;
                };
                let v = host.book.v3()?;
                let entry = v.entry(id.as_str())?;
                let enabled = match mode {
                    EntryMode::Template => {
                        crate::data::v3::switch_templates(&host.book, id.as_str())
                            .iter()
                            .any(|id| Some(id) != entry.template.as_ref())
                    }
                    EntryMode::Membership => {
                        !crate::data::v3::membership_hosts(&host.book, id.as_str()).is_empty()
                    }
                };
                if !enabled {
                    return None;
                }
                let page = PageViewHost {
                    workspace: host.workspace.clone(),
                    library: host.library.clone()?,
                    book_id: host.book_id.clone(),
                    book: host.book.clone(),
                };
                let id = id.to_string();
                Some(Rc::new(move |window: &mut gpui::Window, cx: &mut App| {
                    crate::dialogs::v3::open_entry(page.clone(), id.clone(), mode, window, cx)
                }) as RunRow)
            });
        }
        dr_shell::v3::add_entry_card_rows(cx, |target, host, cx| {
            let Target::Entry { id, .. } = target else {
                return Default::default();
            };
            let Some(v) = host.book.v3() else {
                return Default::default();
            };
            let Some(entry) = v.entry(id.as_str()) else {
                return Default::default();
            };
            let Some(library) = host.library.clone() else {
                return Default::default();
            };
            let page = PageViewHost {
                workspace: host.workspace.clone(),
                library,
                book_id: host.book_id.clone(),
                book: host.book.clone(),
            };
            let id = id.to_string();
            CardRows {
                before_danger: vec![PageMenuSection {
                    title: None,
                    items: vec![PageMenuItem {
                        id: "entry-toggle-level".into(),
                        icon: dr_ui::sand::Icon::Layers.into(),
                        label: dr_shell::strings::t(cx, dr_i18n::keys::v3_shell::LEVEL_SWITCH),
                        checked: entry.level,
                        danger: false,
                        run: Rc::new(move |window, cx| {
                            dr_shell::v3::page::toggle_level(page.clone(), id.clone(), window, cx);
                        }),
                    }],
                }],
                ..Default::default()
            }
        });
    }
    fn create(host: PageViewHost, context: Creation, cx: &mut App) {
        if !context.blank && context.default.is_none() {
            return;
        }
        let title = t(cx, keys::common::UNTITLED).to_string();
        let placement = if context.attach { "host" } else { "parent" };
        let input =
            json!({ placement: context.context, "template": context.default, "title": title });
        let edit = match prepare(&host.book, "entry.create", input) {
            Ok(edit) => edit,
            Err(error) => {
                log::warn!("new entry: {error}");
                return;
            }
        };
        let lib = host.library.clone();
        let job = cx.background_spawn(async move {
            let created = edit.commit(&lib)?;
            created["id"]
                .as_str()
                .and_then(entry_target)
                .ok_or_else(|| WsError::Internal("entry.create returned no entry id".into()))
        });
        cx.spawn(async move |cx| match job.await {
            Ok(target) => cx.update(|cx| open_when_visible(host, target, cx)),
            Err(error) => log::warn!("new entry: {error}"),
        })
        .detach();
    }

    fn open_when_visible(host: PageViewHost, target: Target, cx: &mut App) {
        let Some(workspace) = host.workspace.upgrade() else {
            return;
        };
        // The command and the shell's event-driven snapshot can land in
        // either order. Mount the page only once the snapshot has the entry.
        let open = move |cx: &mut App| {
            let Some(host) = fresh(&host, cx) else {
                return true;
            };
            if !host.book.exists(&target) {
                return false;
            }
            dr_view_page::focus_new_title(target.key(), cx);
            let _ = host.workspace.update(cx, |ws, cx| {
                ws.open(target.clone(), Open::KEEP.at_title(), cx)
            });
            true
        };
        if open(cx) {
            return;
        }
        let (done, ready) = futures::channel::oneshot::channel();
        let mut done = Some(done);
        let watch = cx.observe(&workspace, move |_, cx| {
            if done.is_some()
                && open(cx)
                && let Some(done) = done.take()
            {
                let _ = done.send(());
            }
        });
        cx.spawn(async move |_| {
            let _ = ready.await;
            drop(watch);
        })
        .detach();
    }
}
