//! The existing generic association picker, scoped to one v3 material.
use dr_i18n::keys::{self, references_panel as rp};
use dr_shell::{pages::PageMenuHost, t};
use dr_ui::{
    Theme,
    components::{Button, Dialog, Select, select::Choice},
    sand::Icon,
};
use dr_workspace::{
    Actor, Workspace,
    commands::v3::material_links::{SetEntryLink, SetEntryLinkIn},
};
use gpui::{
    App, AppContext as _, Context, IntoElement, ParentElement, Render, SharedString, Styled,
    Window, div, px,
};

/// The tallest the open entry list gets, so a long book's list stays in the window.
const LIST_MAX_HEIGHT: f32 = 280.0;

/// The entry choice of the dialog: its list floats above the dialog.
fn entry_choice(labels: Vec<Choice>, selected: usize) -> Select {
    Select::new("material-entry-choice", labels, selected)
        .in_dialog()
        .max_menu_height(LIST_MAX_HEIGHT)
}

pub(crate) fn show(host: PageMenuHost, material: String, window: &mut Window, cx: &mut App) {
    if host
        .workspace
        .upgrade()
        .is_none_or(|ws| ws.read(cx).book_id != host.book_id)
    {
        return;
    }
    let Some(lib) = host.library else { return };
    let view = cx.new(|cx| Associations::new(lib, host.book_id, material, cx));
    dr_shell::dialogs::show_in(window.window_handle(), cx, view.into());
}

struct Associations {
    lib: Workspace,
    book: String,
    material: String,
    entries: Vec<crate::v3::EntryLink>,
    selected: Option<String>,
    reading: bool,
    stale: bool,
    busy: bool,
    error: bool,
    _events: dr_workspace::Subscription,
}

impl Associations {
    fn new(lib: Workspace, book: String, material: String, cx: &mut Context<Self>) -> Self {
        let (tx, mut rx) = futures::channel::mpsc::unbounded();
        let watched = book.clone();
        let events = lib.subscribe(move |event| {
            // A material's entries are the book's content; a writing day or
            // a saved checkpoint is not.
            if matches!(event, dr_workspace::WsEvent::Book(b) if b.book.as_str() == watched) {
                let _ = tx.unbounded_send(());
            }
        });
        cx.spawn(async move |this, cx| {
            use futures::StreamExt as _;
            while rx.next().await.is_some() {
                if this.update(cx, |v, cx| v.reload(cx)).is_err() {
                    break;
                }
            }
        })
        .detach();
        let mut view = Self {
            lib,
            book,
            material,
            entries: Vec::new(),
            selected: None,
            reading: false,
            stale: false,
            busy: false,
            error: false,
            _events: events,
        };
        view.reload(cx);
        view
    }
    fn reload(&mut self, cx: &mut Context<Self>) {
        if self.reading {
            self.stale = true;
            return;
        }
        self.reading = true;
        let (lib, book, material) = (self.lib.clone(), self.book.clone(), self.material.clone());
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { crate::v3::entry_links(&lib, &book, &material) })
                .await;
            this.update(cx, |v, cx| {
                v.reading = false;
                match result {
                    Ok(entries) => v.entries = entries,
                    Err(_) => v.error = true,
                }
                if v.stale {
                    v.stale = false;
                    v.reload(cx);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
    fn save(&mut self, entry: String, linked: bool, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.busy = true;
        self.error = false;
        let input = SetEntryLinkIn {
            book: self.book.clone(),
            material: self.material.clone(),
            entry,
            linked,
        };
        let lib = self.lib.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { lib.run::<SetEntryLink>(&Actor::User, input) })
                .await;
            this.update(cx, |v, cx| {
                v.busy = false;
                if result.is_ok() {
                    v.selected = None;
                    v.reload(cx);
                } else {
                    v.error = true;
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }
    fn close(&self, cx: &mut Context<Self>) {
        if !self.busy {
            let id = cx.entity_id();
            dr_shell::dialogs::hide(cx, id);
        }
    }
}

impl Render for Associations {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let mut rows = div().flex().flex_col().gap(px(8.0));
        for entry in self.entries.iter().filter(|e| e.linked) {
            let id = entry.id.clone();
            rows = rows.child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(entry.title.clone())
                    .child(
                        Button::new(
                            SharedString::from(format!("material-unlink-{id}")),
                            t(cx, rp::actions::REMOVE),
                        )
                        .disabled(self.busy)
                        .on_click(cx.listener(move |v, _, _, cx| v.save(id.clone(), false, cx))),
                    ),
            );
        }
        let choices: Vec<_> = self.entries.iter().filter(|e| !e.linked).cloned().collect();
        let selected = self
            .selected
            .as_ref()
            .and_then(|id| choices.iter().position(|e| &e.id == id))
            .map_or(0, |i| i + 1);
        let mut labels = vec![Choice::new(Icon::Plus, t(cx, rp::picker::PLACEHOLDER))];
        labels.extend(
            choices
                .iter()
                .map(|e| Choice::new(Icon::ChevronRight, e.title.clone())),
        );
        let pick = cx.entity();
        rows = rows.child(
            entry_choice(labels, selected)
                .disabled(self.busy)
                .on_change(move |i, _, cx| {
                    pick.update(cx, |v, cx| {
                        v.selected = i
                            .checked_sub(1)
                            .and_then(|i| choices.get(i))
                            .map(|e| e.id.clone());
                        cx.notify();
                    })
                }),
        );
        if self.error {
            rows = rows.child(
                div()
                    .text_color(Theme::of(window, cx).palette.danger.solid())
                    .child(t(cx, keys::common::SAVE_FAILED)),
            );
        }
        let close = cx.entity();
        Dialog::new("material-entry-links", t(cx, rp::sections::RELATIONS))
            .body(rows)
            .action(
                Button::new("material-link-cancel", t(cx, keys::common::CLOSE))
                    .disabled(self.busy)
                    .on_click(cx.listener(|v, _, _, cx| v.close(cx))),
            )
            .action(
                Button::new("material-link-save", t(cx, rp::actions::LINK_ENTITY))
                    .primary()
                    .disabled(self.busy || selected == 0)
                    .busy(self.busy)
                    .on_click(cx.listener(|v, _, _, cx| {
                        if let Some(id) = &v.selected {
                            v.save(id.clone(), true, cx);
                        }
                    })),
            )
            .on_close(move |_, cx| close.update(cx, |v, cx| v.close(cx)))
            .on_mist(|_, _| {})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dr_workspace::{Faults, WorkspaceOptions};
    use gpui::{Entity, TestAppContext, VisualTestContext};
    use std::{
        sync::Arc,
        time::{Duration, Instant},
    };
    struct Frame(Entity<Associations>);
    impl Render for Frame {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div().child(self.0.clone())
        }
    }
    fn wait(cx: &mut VisualTestContext, done: impl Fn(&mut VisualTestContext) -> bool) {
        let until = Instant::now() + Duration::from_secs(10);
        loop {
            cx.run_until_parked();
            cx.update(|w, cx| w.draw(cx).clear(cx));
            if done(cx) {
                return;
            }
            assert!(Instant::now() < until, "material association timed out");
            std::thread::sleep(Duration::from_millis(3));
        }
    }
    #[gpui::test]
    fn refused_link_keeps_selection_and_other_successful_links(cx: &mut TestAppContext) {
        cx.executor().allow_parking();
        let dir = tempfile::tempdir().unwrap();
        let store =
            dr_store::Library::open(dir.path(), dr_workspace::library_options("test")).unwrap();
        let seed = dr_testkit::seed::generate_v3(
            dr_testkit::seed::Preset::Tiny,
            dr_testkit::seed::DEFAULT_SEED,
        )
        .unwrap();
        let book = seed.books[0].book_id().to_string();
        let material = seed.books[0].book.view().materials()[0].id.to_string();
        seed.write_to(&store).unwrap();
        let faults = Arc::new(Faults::default());
        let lib = Workspace::open(
            store,
            WorkspaceOptions {
                faults: Some(faults.clone()),
                ..Default::default()
            },
        )
        .unwrap();
        cx.update(|cx| {
            dr_shell::init(
                dr_shell::ShellInfo {
                    app_name: "Drifting Next",
                    bundle_id: "cc.drifting.next.dev",
                    version: "0.2.0-dev",
                    url_scheme: "drifting-next-dev",
                    forced_appearance: Some(dr_ui::Appearance::Light),
                },
                dr_shell::Services::default(),
                dr_shell::SettingsFile::in_memory(),
                cx,
            )
        });
        let (frame, cx) = cx.add_window_view(|_, cx| {
            Frame(cx.new(|cx| Associations::new(lib.clone(), book.clone(), material.clone(), cx)))
        });
        let view = frame.read_with(cx, |f, _| f.0.clone());
        wait(cx, |cx| view.read_with(cx, |v, _| !v.reading));
        let choices = view.read_with(cx, |v, _| {
            v.entries
                .iter()
                .filter(|e| !e.linked)
                .take(2)
                .map(|e| e.id.clone())
                .collect::<Vec<_>>()
        });
        assert_eq!(choices.len(), 2);
        let a = choices[0].clone();
        let b = choices[1].clone();
        view.update(cx, |v, _| v.selected = Some(a.clone()));
        lib.run::<SetEntryLink>(
            &Actor::User,
            SetEntryLinkIn {
                book: book.clone(),
                material: material.clone(),
                entry: b.clone(),
                linked: true,
            },
        )
        .unwrap();
        view.update(cx, |v, cx| v.reload(cx));
        wait(cx, |cx| {
            view.read_with(cx, |v, _| {
                !v.reading && v.entries.iter().any(|e| e.id == b && e.linked)
            })
        });
        faults.arm("after_prose");
        view.update(cx, |v, cx| {
            v.save(a.clone(), true, cx);
            v.save(a.clone(), true, cx);
        });
        wait(cx, |cx| view.read_with(cx, |v, _| !v.busy));
        assert!(view.read_with(cx, |v, _| v.error && v.selected.as_ref() == Some(&a)));
        assert!(
            !crate::v3::entry_links(&lib, &book, &material)
                .unwrap()
                .iter()
                .find(|e| e.id == a)
                .unwrap()
                .linked
        );
        view.update(cx, |v, cx| v.save(a.clone(), true, cx));
        wait(cx, |cx| {
            view.read_with(cx, |v, _| {
                !v.busy && !v.reading && v.entries.iter().any(|e| e.id == a && e.linked)
            })
        });
        assert!(view.read_with(cx, |v, _| !v.error && v.selected.is_none()));
        assert!(
            crate::v3::entry_links(&lib, &book, &material)
                .unwrap()
                .iter()
                .find(|e| e.id == b)
                .unwrap()
                .linked
        );
        view.update(cx, |v, cx| v.save(a.clone(), false, cx));
        wait(cx, |cx| {
            view.read_with(cx, |v, _| {
                !v.busy && !v.reading && v.entries.iter().any(|e| e.id == a && !e.linked)
            })
        });
        assert!(
            crate::v3::entry_links(&lib, &book, &material)
                .unwrap()
                .iter()
                .find(|e| e.id == b)
                .unwrap()
                .linked
        );
        lib.close();
    }

    #[gpui::test]
    fn the_entry_list_floats_above_its_dialog(cx: &mut TestAppContext) {
        cx.executor().allow_parking();
        let dir = tempfile::tempdir().unwrap();
        let store =
            dr_store::Library::open(dir.path(), dr_workspace::library_options("test")).unwrap();
        let seed = dr_testkit::seed::generate_v3(
            dr_testkit::seed::Preset::Tiny,
            dr_testkit::seed::DEFAULT_SEED,
        )
        .unwrap();
        let book = seed.books[0].book_id().to_string();
        let material = seed.books[0].book.view().materials()[0].id.to_string();
        seed.write_to(&store).unwrap();
        let lib = Workspace::open(store, WorkspaceOptions::default()).unwrap();
        cx.update(|cx| {
            let _ = dr_ui::init(cx);
            dr_shell::init(
                dr_shell::ShellInfo {
                    app_name: "Drifting Next",
                    bundle_id: "cc.drifting.next.dev",
                    version: "0.2.0-dev",
                    url_scheme: "drifting-next-dev",
                    forced_appearance: Some(dr_ui::Appearance::Light),
                },
                dr_shell::Services::default(),
                dr_shell::SettingsFile::in_memory(),
                cx,
            )
        });
        let (frame, cx) = cx.add_window_view(|_, cx| {
            Frame(cx.new(|cx| Associations::new(lib.clone(), book.clone(), material.clone(), cx)))
        });
        cx.simulate_resize(gpui::size(px(900.), px(700.)));
        let view = frame.read_with(cx, |f, _| f.0.clone());
        wait(cx, |cx| view.read_with(cx, |v, _| !v.reading));
        let draw = |cx: &mut VisualTestContext| {
            for _ in 0..3 {
                cx.run_until_parked();
                cx.update(|w, cx| {
                    w.simulate_next_frame(cx);
                    w.draw(cx).clear(cx);
                });
            }
        };
        draw(cx);
        let trigger = cx.debug_bounds("material-entry-choice").unwrap();
        cx.simulate_click(trigger.center(), gpui::Modifiers::default());
        draw(cx);
        // A row near the bottom of the open list, past the dialog's card.
        let list = cx.debug_bounds("select-choice-scroll").unwrap();
        cx.simulate_click(
            gpui::point(list.center().x, list.bottom() - px(18.)),
            gpui::Modifiers::default(),
        );
        draw(cx);
        let unlinked: Vec<String> = view.read_with(cx, |v, _| {
            v.entries
                .iter()
                .filter(|e| !e.linked)
                .map(|e| e.id.clone())
                .collect()
        });
        let selected = view.read_with(cx, |v, _| v.selected.clone());
        assert!(selected.is_some_and(|id| unlinked.contains(&id)));
        // Clicks reach a list painted under the dialog too (GPUI hit-tests
        // nested floats on top): what keeps it visible is its layer, see
        // dr-ui's `tests/layers.rs`.
        assert!(super::entry_choice(Vec::new(), 0).is_in_dialog());
        lib.close();
    }
}
