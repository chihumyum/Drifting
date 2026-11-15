//! File viewer (`MediaPage`) `⋯` menu actions: open the original file in the
//! system, move to an asset folder, or move directly to Recently Deleted
//! without a confirmation dialog (`v5-tracks.md` lines 399, 413, 414).

use std::{path::PathBuf, rc::Rc};

use dr_i18n::keys;
use dr_shell::{
    actions::Dismiss,
    nav::Target,
    pages::{PageMenuHost, PageMenuItem, PageMenuSection},
    strings::tf,
    t,
};
use dr_ui::{
    Theme,
    components::{Button, Dialog, menu::RowIcon},
    fonts::{Role, weight},
    input::field::{FieldEvent, TextField},
    sand::{self, Icon},
    style::DrStyled,
};
use gpui::{
    App, AppContext as _, Context, Entity, FocusHandle, Focusable as _, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, SharedString, StatefulInteractiveElement as _,
    Styled as _, Subscription, Window, div, prelude::FluentBuilder as _, px,
};

use crate::folders::{self, Selection, Tree};

pub(crate) fn register(cx: &mut App) {
    dr_shell::pages::add_page_menu(cx, sections);
}

/// The file viewer's own `⋯` menu section.
pub fn sections(target: &Target, host: &PageMenuHost, cx: &App) -> Vec<PageMenuSection> {
    let Target::Material(id) = target else {
        return Vec::new();
    };
    let id = id.to_string();
    let Some(material) = host.book.material_info(&id) else {
        return Vec::new();
    };
    if host.library.is_none() {
        return Vec::new();
    }
    let item = |name: &'static str, icon, label, danger, action: Action| {
        let (host, id) = (host.clone(), id.clone());
        PageMenuItem {
            id: name.into(),
            icon: RowIcon::Brush(icon),
            label,
            checked: false,
            danger,
            run: Rc::new(move |window, cx| {
                show(action.clone(), host.clone(), id.clone(), window, cx)
            }),
        }
    };
    let mut items = Vec::new();
    if matches!(material.kind.as_str(), "image" | "pdf") {
        items.push(item(
            "material-open-original",
            Icon::GateOut,
            t(cx, keys::v5_files::OPEN_IN_SYSTEM),
            false,
            Action::Open,
        ));
    }
    items.push(item(
        "material-move",
        Icon::Folder,
        t(cx, keys::v5_files::MOVE_TO_FOLDER),
        false,
        Action::Move,
    ));
    items.push(item(
        "material-delete",
        Icon::Trash,
        t(cx, keys::v5_files::MOVE_TO_TRASH),
        true,
        Action::Delete,
    ));
    vec![PageMenuSection { title: None, items }]
}

/// Resolves only the owned original, never the display or thumbnail.
pub fn source_path(
    lib: &dr_workspace::Workspace,
    book: &str,
    material: &str,
) -> Result<PathBuf, String> {
    let loaded = dr_shell::book::Book::load(lib, book).map_err(|e| e.to_string())?;
    let asset = loaded
        .material_info(material)
        .and_then(|m| m.asset.as_deref())
        .unwrap_or(material);
    let record = lib
        .library()
        .asset(asset, dr_store::asset::Variant::Source)
        .map_err(|e| e.to_string())?
        .ok_or("missing source file")?;
    if !record.path.is_file() {
        return Err("missing source file".into());
    }
    Ok(record.path)
}

#[derive(Clone)]
enum Action {
    Open,
    Move,
    Delete,
    Alert(SharedString),
}

fn show(mut action: Action, host: PageMenuHost, id: String, window: &mut Window, cx: &mut App) {
    match action {
        Action::Open => {
            let Some(lib) = &host.library else { return };
            match source_path(lib, &host.book_id, &id) {
                Ok(path) => {
                    cx.open_with_system(&path);
                    return;
                }
                Err(error) => {
                    action = Action::Alert(tf(
                        cx,
                        keys::memo_material::error::OPEN_FILE,
                        &[("error", &error)],
                    ))
                }
            }
        }
        Action::Delete => {
            let Some(lib) = host.library.clone() else {
                return;
            };
            let book = host.book_id.clone();
            let handle = window.window_handle();
            let host_for_err = host.clone();
            let id_for_err = id.clone();
            let task = cx
                .background_executor()
                .spawn(async move { folders::delete(&lib, &book, &Selection::material(&id)) });
            cx.spawn(async move |cx| {
                if let Err(error) = task.await {
                    log::warn!("material delete failed: {error}");
                    let _ = cx.update_window(handle, |_, window, cx| {
                        let msg = t(cx, keys::material_editor::DELETE_FAILED);
                        let dialog = cx.new(|cx| {
                            MaterialDialog::new(
                                Action::Alert(msg),
                                host_for_err,
                                id_for_err,
                                window,
                                cx,
                            )
                        });
                        dr_shell::dialogs::show_in(window.window_handle(), cx, dialog.into());
                    });
                }
            })
            .detach();
            return;
        }
        Action::Move | Action::Alert(_) => {}
    }
    let dialog = cx.new(|cx| MaterialDialog::new(action, host, id, window, cx));
    dr_shell::dialogs::show_in(window.window_handle(), cx, dialog.into());
}

/// One window's material dialog (folder move or error alert); writes finish
/// before it can be closed.
pub struct MaterialDialog {
    action: Action,
    host: PageMenuHost,
    material: String,
    focus: FocusHandle,
    field: Entity<TextField>,
    busy: bool,
    error: Option<SharedString>,
    _field: Subscription,
}

impl MaterialDialog {
    fn new(
        action: Action,
        host: PageMenuHost,
        material: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let hint = t(cx, keys::material_folders::picker::NEW_PLACEHOLDER);
        let field =
            cx.new(|cx| TextField::new("material-folder-name", window, cx).placeholder(hint));
        let subscription = cx.subscribe_in(&field, window, |d, _, e, window, cx| match e {
            FieldEvent::Submitted(_) => d.create_and_move(window, cx),
            FieldEvent::Cancelled => d.close(cx),
            FieldEvent::Changed(_) => cx.notify(),
            FieldEvent::Blurred => {}
        });
        let focus = cx.focus_handle();
        if matches!(action, Action::Move) {
            field.focus_handle(cx).focus(window, cx);
        } else {
            focus.focus(window, cx);
        }
        Self {
            action,
            host,
            material,
            focus,
            field,
            busy: false,
            error: None,
            _field: subscription,
        }
    }

    pub fn field(&self) -> Entity<TextField> {
        self.field.clone()
    }

    pub fn close(&mut self, cx: &mut Context<Self>) {
        if !self.busy {
            let id = cx.entity_id();
            dr_shell::dialogs::hide(cx, id);
        }
    }

    fn write(
        &mut self,
        write: impl FnOnce(&dr_workspace::Workspace, &str, &str) -> Result<(), String> + Send + 'static,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.busy {
            return;
        }
        let Some(lib) = self.host.library.clone() else {
            return;
        };
        let (book, material) = (self.host.book_id.clone(), self.material.clone());
        self.busy = true;
        self.error = None;
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { write(&lib, &book, &material) })
                .await;
            this.update_in(cx, |d, _, cx| {
                d.busy = false;
                match result {
                    Ok(()) => d.close(cx),
                    Err(error) => {
                        log::warn!("material page action failed: {error}");
                        d.error = Some(error.into());
                        cx.notify();
                    }
                }
            })
            .ok();
        })
        .detach();
    }

    pub fn move_to(&mut self, folder: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        if !matches!(self.action, Action::Move) {
            return;
        }
        self.write(
            move |lib, book, id| {
                folders::move_to(lib, book, &Selection::material(id), folder.as_deref())
            },
            window,
            cx,
        );
    }

    pub fn create_and_move(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !matches!(self.action, Action::Move) {
            return;
        }
        let name = self.field.read(cx).text().trim().to_owned();
        if name.is_empty() {
            return;
        }
        self.write(
            move |lib, book, id| {
                let folder = folders::create_folder(lib, book, &name, None)?;
                folders::move_to(lib, book, &Selection::material(id), Some(&folder))
            },
            window,
            cx,
        );
    }
}

impl Render for MaterialDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let entity = cx.entity();
        let close = {
            let entity = entity.clone();
            move |_: &mut Window, cx: &mut App| entity.update(cx, |d, cx| d.close(cx))
        };
        let cancel = {
            let close = close.clone();
            move |_: &gpui::ClickEvent, w: &mut Window, cx: &mut App| close(w, cx)
        };
        let book = self
            .host
            .workspace
            .upgrade()
            .map(|w| w.read(cx).book.clone())
            .unwrap_or_else(|| self.host.book.clone());
        let asset_id = book
            .material_info(&self.material)
            .and_then(|m| m.asset.as_deref())
            .unwrap_or(&self.material);
        let mut dialog = match &self.action {
            Action::Move => {
                let current = book
                    .material_info(asset_id)
                    .and_then(|m| m.folder.as_deref());
                let choices =
                    Tree::new_ordered(book.material_folders(), book.material_items(), None)
                        .choices(
                            &Selection::material(asset_id),
                            current,
                            &t(cx, keys::v5_files::TOP_LEVEL),
                        );
                let p = Theme::of(window, cx).palette;
                let mut list = div()
                    .id("material-folder-choices")
                    .max_h(px(260.))
                    .overflow_y_scroll()
                    .flex()
                    .flex_col();
                for (i, choice) in choices.into_iter().enumerate() {
                    let pick = entity.clone();
                    let busy = self.busy;
                    let label: SharedString = choice.path.into();
                    list = list.child(
                        div()
                            .id(("material-folder-choice", i))
                            .min_h(px(30.))
                            .px(px(8.))
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .font_role(Role::Ui)
                            .type_px(14., 20.)
                            .text_color(p.ink(2).solid())
                            .cursor_pointer()
                            .role(gpui::Role::Button)
                            .aria_label(label.clone())
                            .hover(move |s| s.bg(p.ink(1).alpha(0.05)))
                            .when(choice.current, |d| d.weight(weight::SEMIBOLD))
                            .child(div().flex_1().min_w_0().truncate().child(label))
                            .when(choice.current, |d| {
                                d.child(sand::icon(Icon::Check, 11., p.ink(1).solid()))
                            })
                            .on_click(move |_, window, cx| {
                                if !busy {
                                    pick.update(cx, |d, cx| {
                                        d.move_to(choice.folder.clone(), window, cx)
                                    });
                                }
                            }),
                    );
                }
                let submit = entity.clone();
                Dialog::new("material-move", t(cx, keys::v5_files::MOVE_TO_FOLDER))
                    .width(380.)
                    .body(list)
                    .body(self.field.clone())
                    .action(
                        Button::new("material-move-cancel", t(cx, keys::common::CANCEL))
                            .disabled(self.busy)
                            .on_click(cancel),
                    )
                    .action(
                        Button::new(
                            "material-create-move",
                            t(cx, keys::material_folders::picker::CREATE_AND_MOVE),
                        )
                        .primary()
                        .busy(self.busy)
                        .disabled(self.busy || self.field.read(cx).text().trim().is_empty())
                        .on_click(move |_, w, cx| {
                            submit.update(cx, |d, cx| d.create_and_move(w, cx))
                        }),
                    )
            }
            Action::Alert(message) => Dialog::new("material-alert", "Drifting")
                .body(div().child(message.clone()))
                .action(
                    Button::new("material-alert-close", t(cx, keys::common::CLOSE))
                        .on_click(cancel),
                ),
            Action::Open | Action::Delete => {
                unreachable!("open and delete resolve before showing a dialog")
            }
        };
        if let Some(error) = &self.error {
            dialog = dialog.body(
                div()
                    .text_color(Theme::of(window, cx).palette.danger.solid())
                    .child(error.clone()),
            );
        }
        div()
            .absolute()
            .top_0()
            .left_0()
            .size_0()
            .track_focus(&self.focus)
            .key_context("MaterialDialog")
            .on_action(cx.listener(|d, _: &Dismiss, _, cx| d.close(cx)))
            .child(dialog.on_close(close))
    }
}
