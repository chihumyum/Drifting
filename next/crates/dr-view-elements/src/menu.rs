//! Canonical v3 level surface.
pub mod v3 {
    use crate::dialogs::v3::EntryMode;
    use dr_shell::{
        nav::Target,
        pages::{PageViewHost, RunRow},
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
    }
}
