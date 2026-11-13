//! Canonical v3 level surface.
pub mod v3 {
    use crate::dialogs::v3::EntryMode;
    use dr_shell::{
        nav::Target,
        pages::{CardRows, PageMenuItem, PageMenuSection, PageViewHost, RunRow},
        v3::card::EntryAction,
    };
    use gpui::App;
    use std::rc::Rc;

    pub fn register(cx: &mut App) {
        for (action, mode) in [
            (EntryAction::New, EntryMode::New),
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
                    EntryMode::New => crate::data::v3::creation(&host.book, id.as_str())
                        .is_some_and(|c| c.blank || !c.templates.is_empty()),
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
}
