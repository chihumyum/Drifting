//! The element and category pages' dialogs, shown as the shell's modal
//! dialog (`dr_shell::dialogs::show`): the 0.1 client's alerts, its
//! 「更改类目」 and 「新建类目」 modals, the 「分组」 modal and the delete
//! confirmations (the page's ⋯ menu opens the last four).
//!
//! One dialog at a time, for the whole app ([`ElementDialogs`], made by
//! [`crate::init`]). Opening one gives it the keyboard; Esc, the mist and
//! its buttons close it, and the shell gives the page the keyboard back.
//!
//! The 0.1 rules:
//!
//! - **更改类目**: the categories (mark and name; the current one bold with
//!   a tick), then 「新建类目…」, which asks a name and moves the element
//!   into the new category. A click on a category moves it there.
//! - **分组 · 类目**: a field filters the category's groups (and names a new
//!   one); Enter saves what is typed (empty: no group). Rows: 「（不分组）」,
//!   the groups alphabetically (the current one bold with a tick), then
//!   「新建分组「x」」 when the typed name is new.
//! - **删除**: asks with the 0.1 sentence; the element (or category) goes to
//!   the trash, and the shell closes its tab. A category's elements become
//!   uncategorized.
//!
//! Four 0.1 strings were left in English in Chinese (the category modal's
//! title, the new category modal's title, its placeholder and its button);
//! their translated neighbours stand in (m11-elements.md).

use std::collections::BTreeSet;

use dr_i18n::keys;
use dr_shell::actions::Dismiss;
use dr_shell::book::{Book, color_of};
use dr_shell::strings::tf;
use dr_shell::{Services, Workspace, t};
use dr_ui::{
    Theme,
    components::{Button, Dialog},
    fonts::{Role, weight},
    input::field::{FieldEvent, TextField},
    sand::{self, Icon, KindMark},
    style::DrStyled,
};
use dr_workspace::{
    Actor, Workspace as Library, WsError,
    commands::{
        EntityIn,
        element::{CategoryCreate, CategoryCreateIn, CategoryTrash, ElementTrash},
        storyline::StorylineTrash,
    },
};
use gpui::{
    AnyElement, App, AppContext as _, Context, ElementId, Entity, FocusHandle, Focusable, Global,
    InteractiveElement as _, IntoElement, ParentElement as _, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, WeakEntity, Window, div,
    prelude::FluentBuilder as _, px,
};

use crate::data;

/// What the dialog asks.
pub enum Ask {
    /// A message and 「关闭」 (the 0.1 `alert()`).
    Alert(SharedString),
    ChangeCategory {
        element: String,
    },
    NewCategory {
        element: String,
        name: Entity<TextField>,
    },
    ChangeGroup {
        element: String,
        filter: Entity<TextField>,
    },
    DeleteElement {
        element: String,
    },
    DeleteCategory {
        category: String,
    },
    DeleteStoryline {
        storyline: String,
    },
}

/// Which dialog is open (tests and the debug bridge).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Asking {
    Alert(String),
    ChangeCategory(String),
    NewCategory(String),
    ChangeGroup(String),
    DeleteElement(String),
    DeleteCategory(String),
    DeleteStoryline(String),
}

/// The app's one element dialog.
pub struct ElementDialogs {
    focus: FocusHandle,
    lib: Option<Library>,
    /// The workspace window that asked (its book is the one shown).
    ws: WeakEntity<Workspace>,
    pub ask: Option<Ask>,
    busy: bool,
    _field: Option<Subscription>,
}

struct Shared(Entity<ElementDialogs>);

impl Global for Shared {}

/// Whether the dialog is shown (so the observer shows or hides it once).
struct Shown(bool);

impl Global for Shown {}

/// Makes the dialog and shows it as the shell's dialog whenever it asks.
pub(crate) fn init(cx: &mut App) {
    let entity = cx.new(|cx| ElementDialogs {
        focus: cx.focus_handle(),
        lib: None,
        ws: WeakEntity::new_invalid(),
        ask: None,
        busy: false,
        _field: None,
    });
    cx.observe(&entity, |dialogs, cx| {
        let open = dialogs.read(cx).ask.is_some();
        let shown = cx.try_global::<Shown>().is_some_and(|s| s.0);
        if open != shown {
            cx.set_global(Shown(open));
            if open {
                dr_shell::dialogs::show(cx, dialogs.into());
            } else {
                dr_shell::dialogs::hide(cx, dialogs.entity_id());
            }
        }
    })
    .detach();
    cx.set_global(Shared(entity));
}

/// The app's element dialog, once [`crate::init`] ran.
pub fn dialogs(cx: &App) -> Option<Entity<ElementDialogs>> {
    cx.try_global::<Shared>().map(|s| s.0.clone())
}

/// Opens `ask` for the window of `ws` (any other dialog of these gives way).
pub fn open(ask: AskFor, ws: WeakEntity<Workspace>, window: &mut Window, cx: &mut App) {
    let Some(dialogs) = dialogs(cx) else {
        return;
    };
    dialogs.update(cx, |d, cx| d.open(ask, ws, window, cx));
}

/// What to open (the fields a dialog types into are made when it opens).
#[derive(Clone, Debug)]
pub enum AskFor {
    Alert(SharedString),
    ChangeCategory(String),
    NewCategory(String),
    ChangeGroup(String),
    DeleteElement(String),
    DeleteCategory(String),
    DeleteStoryline(String),
}

impl ElementDialogs {
    pub fn asking(&self) -> Option<Asking> {
        Some(match self.ask.as_ref()? {
            Ask::Alert(m) => Asking::Alert(m.to_string()),
            Ask::ChangeCategory { element } => Asking::ChangeCategory(element.clone()),
            Ask::NewCategory { element, .. } => Asking::NewCategory(element.clone()),
            Ask::ChangeGroup { element, .. } => Asking::ChangeGroup(element.clone()),
            Ask::DeleteElement { element } => Asking::DeleteElement(element.clone()),
            Ask::DeleteCategory { category } => Asking::DeleteCategory(category.clone()),
            Ask::DeleteStoryline { storyline } => Asking::DeleteStoryline(storyline.clone()),
        })
    }

    /// The field the open dialog types into, if it has one (tests).
    pub fn field(&self) -> Option<Entity<TextField>> {
        match self.ask.as_ref()? {
            Ask::NewCategory { name, .. } => Some(name.clone()),
            Ask::ChangeGroup { filter, .. } => Some(filter.clone()),
            _ => None,
        }
    }

    pub fn open(
        &mut self,
        ask: AskFor,
        ws: WeakEntity<Workspace>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.lib.is_none() {
            self.lib = cx.try_global::<Services>().and_then(|s| s.library.clone());
        }
        self.ws = ws;
        self.busy = false;
        self._field = None;
        let ask = match ask {
            AskFor::Alert(m) => Ask::Alert(m),
            AskFor::ChangeCategory(element) => Ask::ChangeCategory { element },
            AskFor::DeleteElement(element) => Ask::DeleteElement { element },
            AskFor::DeleteCategory(category) => Ask::DeleteCategory { category },
            AskFor::DeleteStoryline(storyline) => Ask::DeleteStoryline { storyline },
            AskFor::NewCategory(element) => {
                let hint = t(cx, keys::category_editor::UNTITLED);
                let name = cx
                    .new(|cx| TextField::new("element-new-category", window, cx).placeholder(hint));
                self._field =
                    Some(
                        cx.subscribe_in(&name, window, |d, field, e, window, cx| match e {
                            FieldEvent::Submitted(_) => {
                                let text = field.read(cx).text();
                                d.create_category(text, window, cx);
                            }
                            FieldEvent::Cancelled => d.close(window, cx),
                            _ => {}
                        }),
                    );
                Ask::NewCategory { element, name }
            }
            AskFor::ChangeGroup(element) => {
                let hint = t(cx, keys::element_editor::group::PLACEHOLDER);
                let filter = cx
                    .new(|cx| TextField::new("element-group-filter", window, cx).placeholder(hint));
                self._field = Some(cx.subscribe_in(&filter, window, |d, field, e, window, cx| {
                    match e {
                        // Enter saves what is typed; empty is no group.
                        FieldEvent::Submitted(_) => {
                            let text = field.read(cx).text().trim().to_owned();
                            d.set_group((!text.is_empty()).then_some(text), window, cx);
                        }
                        FieldEvent::Cancelled => d.close(window, cx),
                        FieldEvent::Changed(_) => cx.notify(),
                        FieldEvent::Blurred => {}
                    }
                }));
                Ask::ChangeGroup { element, filter }
            }
        };
        let field = match &ask {
            Ask::NewCategory { name, .. } => Some(name.focus_handle(cx)),
            Ask::ChangeGroup { filter, .. } => Some(filter.focus_handle(cx)),
            _ => None,
        };
        self.ask = Some(ask);
        field
            .unwrap_or_else(|| self.focus.clone())
            .focus(window, cx);
        cx.notify();
    }

    /// Closes the dialog (not while it writes).
    pub fn close(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.ask = None;
        self._field = None;
        cx.notify();
    }

    fn book(&self, cx: &App) -> Option<std::rc::Rc<Book>> {
        Some(self.ws.upgrade()?.read(cx).book.clone())
    }

    /// Runs `write` off the main thread; on failure the 0.1 alert `failed`.
    fn write(
        &mut self,
        write: impl FnOnce(&Library) -> Result<(), WsError> + Send + 'static,
        failed: Option<dr_i18n::Key>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(lib) = self.lib.clone() else {
            return;
        };
        self.busy = true;
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { write(&lib) })
                .await;
            this.update_in(cx, |d, window, cx| {
                d.busy = false;
                match result {
                    Ok(()) => d.close(window, cx),
                    Err(error) => {
                        log::warn!("the element dialog's change failed: {error}");
                        match failed {
                            Some(key) => {
                                let ws = d.ws.clone();
                                let message = t(cx, key);
                                d.open(AskFor::Alert(message), ws, window, cx);
                            }
                            None => d.close(window, cx),
                        }
                    }
                }
            })
            .ok();
        })
        .detach();
    }

    /// Moves the element of the open dialog into `category` (`None`:
    /// uncategorized).
    pub fn set_category(
        &mut self,
        category: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(Ask::ChangeCategory { element }) = &self.ask else {
            return;
        };
        let Some(book) = self.book(cx) else {
            return;
        };
        let mut edit = data::element_edit(&book.id, element);
        edit.category = Some(category);
        self.write(move |lib| data::update_element(lib, edit), None, window, cx);
    }

    /// 「新建类目…」 from the category dialog.
    pub fn ask_new_category(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(Ask::ChangeCategory { element }) = &self.ask else {
            return;
        };
        let (element, ws) = (element.clone(), self.ws.clone());
        self.open(AskFor::NewCategory(element), ws, window, cx);
    }

    /// Makes a category named `name` and moves the element into it (a
    /// blank name does nothing).
    pub fn create_category(&mut self, name: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(Ask::NewCategory { element, .. }) = &self.ask else {
            return;
        };
        let name = name.trim().to_owned();
        if name.is_empty() {
            return;
        }
        let Some(book) = self.book(cx) else {
            return;
        };
        let (book, element) = (book.id.clone(), element.clone());
        self.write(
            move |lib| {
                let made = lib
                    .run::<CategoryCreate>(
                        &Actor::User,
                        CategoryCreateIn {
                            book: book.clone(),
                            name,
                            color: None,
                            text: None,
                        },
                    )?
                    .output;
                let mut edit = data::element_edit(&book, &element);
                edit.category = Some(Some(made.id));
                data::update_element(lib, edit)
            },
            None,
            window,
            cx,
        );
    }

    /// Puts the element of the group dialog in `group` (`None`: no group).
    pub fn set_group(
        &mut self,
        group: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(Ask::ChangeGroup { element, .. }) = &self.ask else {
            return;
        };
        let Some(book) = self.book(cx) else {
            return;
        };
        let mut edit = data::element_edit(&book.id, element);
        edit.group_name = Some(group);
        self.write(
            move |lib| data::update_element(lib, edit),
            Some(keys::element_editor::alerts::GROUP_UPDATE_FAILED),
            window,
            cx,
        );
    }

    /// Confirms the open delete dialog.
    pub fn confirm_delete(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(book) = self.book(cx) else {
            return;
        };
        let book = book.id.clone();
        match &self.ask {
            Some(Ask::DeleteElement { element }) => {
                let input = EntityIn {
                    book,
                    id: element.clone(),
                };
                self.write(
                    move |lib| lib.run::<ElementTrash>(&Actor::User, input).map(|_| ()),
                    Some(keys::element_editor::alerts::DELETE_FAILED),
                    window,
                    cx,
                );
            }
            Some(Ask::DeleteCategory { category }) => {
                let input = EntityIn {
                    book,
                    id: category.clone(),
                };
                self.write(
                    move |lib| lib.run::<CategoryTrash>(&Actor::User, input).map(|_| ()),
                    Some(keys::category_editor::alerts::DELETE_FAILED),
                    window,
                    cx,
                );
            }
            Some(Ask::DeleteStoryline { storyline }) => {
                let input = EntityIn {
                    book,
                    id: storyline.clone(),
                };
                self.write(
                    move |lib| lib.run::<StorylineTrash>(&Actor::User, input).map(|_| ()),
                    Some(keys::storyline_editor::alerts::DELETE_FAILED),
                    window,
                    cx,
                );
            }
            _ => {}
        }
    }
}

impl Focusable for ElementDialogs {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

/// The groups of `category`'s elements (`None`: the uncategorized),
/// alphabetically.
pub fn groups_of(book: &Book, category: Option<&str>) -> Vec<String> {
    book.elements
        .iter()
        .filter(|e| e.category.as_deref() == category)
        .filter_map(|e| e.group_name.clone())
        .filter(|g| !g.trim().is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

impl Render for ElementDialogs {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let dialog = self
            .ask
            .is_some()
            .then(|| dialog(self, window, cx))
            .flatten();
        div()
            .id("element-dialogs")
            .absolute()
            .top_0()
            .left_0()
            .size_0()
            .track_focus(&self.focus)
            .key_context("ElementDialogs")
            .on_action(cx.listener(|d, _: &Dismiss, window, cx| d.close(window, cx)))
            .children(dialog)
    }
}

/// A row of a choice list (`.entity-choice`): a mark, words, a tick on the
/// current one.
#[allow(clippy::too_many_arguments)]
fn choice(
    id: impl Into<ElementId>,
    lead: Option<AnyElement>,
    label: SharedString,
    current: bool,
    style: ChoiceStyle,
    on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static,
    window: &Window,
    cx: &App,
) -> AnyElement {
    let p = Theme::of(window, cx).palette;
    let ink = match style {
        ChoiceStyle::Plain if current => p.ink(1),
        ChoiceStyle::Plain => p.ink(2),
        ChoiceStyle::None => p.ink(3),
        ChoiceStyle::Create => p.accent,
    };
    div()
        .id(id.into())
        .min_h(px(30.0))
        .px(px(8.0))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(8.0))
        .cursor_pointer()
        .rounded(px(3.0))
        .hover(move |st| st.bg(p.ink(1).alpha(0.05)))
        .role(gpui::Role::Button)
        .aria_label(label.clone())
        .font_role(Role::Ui)
        .type_px(14.0, 20.0)
        .text_color(ink.solid())
        .when(current, |el| el.weight(weight::SEMIBOLD))
        .when(style == ChoiceStyle::None, |el| el.italic())
        .on_click(on_click)
        .children(lead)
        .child(div().flex_1().min_w_0().truncate().child(label))
        .when(current, |el| {
            el.child(sand::icon(Icon::Check, 11.0, p.ink(1).solid()))
        })
        .into_any_element()
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ChoiceStyle {
    Plain,
    None,
    Create,
}

fn dialog(
    d: &mut ElementDialogs,
    window: &mut Window,
    cx: &mut Context<ElementDialogs>,
) -> Option<AnyElement> {
    let entity = cx.entity();
    let close = {
        let entity = entity.clone();
        move |window: &mut Window, cx: &mut App| entity.update(cx, |d, cx| d.close(window, cx))
    };
    let cancel = {
        let close = close.clone();
        move |_: &gpui::ClickEvent, window: &mut Window, cx: &mut App| close(window, cx)
    };
    let book = d.book(cx).unwrap_or_default();
    let busy = d.busy;
    let el = match d.ask.as_ref()? {
        Ask::Alert(message) => Dialog::new("element-alert", "Drifting")
            .width(420.0)
            .body(div().child(message.clone()))
            .action(Button::new("element-alert-close", t(cx, keys::common::CLOSE)).on_click(cancel))
            .on_close(close)
            .into_any_element(),
        Ask::ChangeCategory { element } => {
            let current = data::element(&book, element).and_then(|e| e.category.clone());
            let mut list = div()
                .id("element-category-choices")
                .max_h(px(260.0))
                .overflow_y_scroll()
                .flex()
                .flex_col()
                .gap(px(1.0));
            for category in &book.categories {
                let id = category.id.clone();
                let pick = entity.clone();
                let mark = KindMark::new(
                    ElementId::Name(format!("choice-mark-{}", category.id).into()),
                    sand::Kind::Category,
                );
                list = list.child(choice(
                    ElementId::Name(format!("choice-category-{}", category.id).into()),
                    Some(
                        match color_of(&category.color) {
                            Some(c) => mark.color(c),
                            None => mark,
                        }
                        .into_any_element(),
                    ),
                    category.name.clone().into(),
                    current.as_deref() == Some(category.id.as_str()),
                    ChoiceStyle::Plain,
                    move |_, window, cx| {
                        let id = id.clone();
                        pick.update(cx, |d, cx| d.set_category(Some(id), window, cx))
                    },
                    window,
                    cx,
                ));
            }
            let create = entity.clone();
            list = list.child(choice(
                "choice-new-category",
                Some(
                    sand::icon(
                        Icon::Plus,
                        11.0,
                        Theme::of(window, cx).palette.accent.solid(),
                    )
                    .into_any_element(),
                ),
                t(cx, keys::element_editor::category::NEW_OPTION),
                false,
                ChoiceStyle::Create,
                move |_, window, cx| create.update(cx, |d, cx| d.ask_new_category(window, cx)),
                window,
                cx,
            ));
            Dialog::new(
                "element-change-category",
                t(cx, keys::editor_top_bar::menu::CHANGE_CATEGORY),
            )
            .width(360.0)
            .body(list)
            .action(
                Button::new("element-category-cancel", t(cx, keys::common::CANCEL))
                    .text()
                    .on_click(cancel),
            )
            .on_close(close)
            .into_any_element()
        }
        Ask::NewCategory { name, .. } => {
            let field = name.clone();
            let submit = entity.clone();
            Dialog::new(
                "element-new-category",
                t(cx, keys::left_sidebar::actions::NEW_CATEGORY),
            )
            .width(360.0)
            .body(name.clone())
            .action(
                Button::new("element-new-category-cancel", t(cx, keys::common::CANCEL))
                    .text()
                    .disabled(busy)
                    .on_click(cancel),
            )
            .action(
                Button::new(
                    "element-new-category-create",
                    t(cx, keys::story_graph::edge::CREATE),
                )
                .primary()
                .disabled(busy)
                .on_click(move |_, window, cx| {
                    let text = field.read(cx).text();
                    submit.update(cx, |d, cx| d.create_category(text, window, cx))
                }),
            )
            .on_close(close)
            .into_any_element()
        }
        Ask::ChangeGroup { element, filter } => {
            let e = data::element(&book, element);
            let category = e.and_then(|e| e.category.clone());
            let current = e
                .and_then(|e| e.group_name.clone())
                .filter(|g| !g.is_empty());
            let category_name: SharedString = category
                .as_deref()
                .and_then(|c| data::category(&book, c))
                .map(|c| SharedString::from(c.name.clone()))
                .unwrap_or_else(|| t(cx, keys::left_sidebar::UNCATEGORIZED));
            let typed = filter.read(cx).text().trim().to_owned();
            let groups = groups_of(&book, category.as_deref());
            let shown: Vec<&String> = groups
                .iter()
                .filter(|g| typed.is_empty() || g.to_lowercase().contains(&typed.to_lowercase()))
                .collect();
            let is_new = !typed.is_empty()
                && !groups
                    .iter()
                    .any(|g| g.to_lowercase() == typed.to_lowercase());
            let mut list = div()
                .id("element-group-choices")
                .max_h(px(260.0))
                .overflow_y_scroll()
                .flex()
                .flex_col()
                .gap(px(1.0));
            let none = entity.clone();
            list = list.child(choice(
                "choice-no-group",
                None,
                t(cx, keys::element_editor::group::NO_GROUP),
                current.is_none(),
                ChoiceStyle::None,
                move |_, window, cx| none.update(cx, |d, cx| d.set_group(None, window, cx)),
                window,
                cx,
            ));
            for group in shown {
                let pick = entity.clone();
                let g = group.clone();
                list = list.child(choice(
                    ElementId::Name(format!("choice-group-{group}").into()),
                    None,
                    group.clone().into(),
                    current.as_deref() == Some(group.as_str()),
                    ChoiceStyle::Plain,
                    move |_, window, cx| {
                        let g = g.clone();
                        pick.update(cx, |d, cx| d.set_group(Some(g), window, cx))
                    },
                    window,
                    cx,
                ));
            }
            if is_new {
                let make = entity.clone();
                let g = typed.clone();
                list = list.child(choice(
                    "choice-create-group",
                    None,
                    tf(cx, keys::element_editor::group::CREATE, &[("name", &typed)]),
                    false,
                    ChoiceStyle::Create,
                    move |_, window, cx| {
                        let g = g.clone();
                        make.update(cx, |d, cx| d.set_group(Some(g), window, cx))
                    },
                    window,
                    cx,
                ));
            } else if groups.is_empty() {
                let p = Theme::of(window, cx).palette;
                list = list.child(
                    div()
                        .px(px(8.0))
                        .py(px(6.0))
                        .text_color(p.ink(4).solid())
                        .child(t(cx, keys::element_editor::group::EMPTY)),
                );
            }
            Dialog::new(
                "element-change-group",
                tf(
                    cx,
                    keys::element_editor::group::TITLE,
                    &[("category", &category_name)],
                ),
            )
            .width(420.0)
            .body(filter.clone())
            .body(list)
            .action(
                Button::new("element-group-cancel", t(cx, keys::common::CANCEL))
                    .text()
                    .on_click(cancel),
            )
            .on_close(close)
            .into_any_element()
        }
        Ask::DeleteElement { element } => {
            let name = data::element(&book, element)
                .map(|e| e.name.clone())
                .unwrap_or_default();
            let text = tf(cx, keys::element_editor::DELETE_CONFIRM, &[("name", &name)]);
            delete_dialog("element-delete", text, busy, &entity, cancel, close, cx)
        }
        Ask::DeleteCategory { category } => {
            let name = data::category(&book, category)
                .map(|c| c.name.clone())
                .unwrap_or_default();
            let text = tf(
                cx,
                keys::category_editor::DELETE_CONFIRM,
                &[("name", &name)],
            );
            delete_dialog("category-delete", text, busy, &entity, cancel, close, cx)
        }
        Ask::DeleteStoryline { storyline } => {
            let name = data::storyline(&book, storyline)
                .map(|l| l.name.clone())
                .unwrap_or_default();
            let text = tf(
                cx,
                keys::storyline_editor::DELETE_CONFIRM,
                &[("name", &name)],
            );
            delete_dialog("storyline-delete", text, busy, &entity, cancel, close, cx)
        }
    };
    Some(el)
}

/// The 0.1 `requestConfirmation` dialog: 「确认」 over the question (its
/// paragraphs as written), 「取消」 first, the danger's 「确认」 after.
fn delete_dialog(
    id: &'static str,
    question: SharedString,
    busy: bool,
    entity: &Entity<ElementDialogs>,
    cancel: impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static,
    close: impl Fn(&mut Window, &mut App) + 'static,
    cx: &mut Context<ElementDialogs>,
) -> AnyElement {
    let confirm = entity.clone();
    let mut dialog = Dialog::new(id, t(cx, keys::common::CONFIRM));
    for paragraph in question.split("\n\n") {
        dialog = dialog.body(div().child(SharedString::from(paragraph.to_owned())));
    }
    dialog
        .action(
            Button::new(
                SharedString::from(format!("{id}-cancel")),
                t(cx, keys::common::CANCEL),
            )
            .disabled(busy)
            .on_click(cancel),
        )
        .action(
            Button::new(
                SharedString::from(format!("{id}-confirm")),
                t(cx, keys::common::CONFIRM),
            )
            .danger()
            .busy(busy)
            .disabled(busy)
            .on_click(move |_, window, cx| {
                confirm.update(cx, |d, cx| d.confirm_delete(window, cx))
            }),
        )
        .on_close(close)
        .into_any_element()
}

/// V3-only level settings. Entry selectors extend this dialog in G2's final
/// batch; no legacy ElementDialogs state or commands are reused.
pub mod v3 {
    use dr_i18n::keys;
    use dr_shell::{actions::Dismiss, pages::PageViewHost, strings::t};
    use dr_ui::{
        components::{Button, Dialog, MenuItem},
        sand::Icon,
    };
    use gpui::{prelude::*, *};
    use serde_json::{Value, json};

    struct Choice {
        label: SharedString,
        value: Value,
        checked: bool,
    }
    pub struct Picker {
        host: PageViewHost,
        level: String,
        key: &'static str,
        focus: FocusHandle,
        busy: bool,
        error: bool,
        _workspace: Option<Subscription>,
    }
    pub fn open_setting(
        host: PageViewHost,
        level: String,
        key: &'static str,
        window: &mut Window,
        cx: &mut App,
    ) {
        let Some(host) = crate::data::v3::fresh(&host, cx) else {
            return;
        };
        if !host
            .book
            .v3()
            .is_some_and(|v| v.levels.contains_key(&level))
        {
            return;
        }
        let view = cx.new(|cx| Picker::new(host, level, key, cx));
        window.focus(&view.read(cx).focus.clone(), cx);
        dr_shell::dialogs::show(cx, view.into());
    }
    pub fn restore(
        host: PageViewHost,
        level: String,
        key: &'static str,
        window: &mut Window,
        cx: &mut App,
    ) {
        if crate::data::v3::fresh(&host, cx).is_none() {
            return;
        }
        let book = host.book.clone();
        let view = cx.new(|cx| Picker::new(host, level, key, cx));
        window.focus(&view.read(cx).focus.clone(), cx);
        dr_shell::dialogs::show(cx, view.clone().into());
        view.update(cx, |this, cx| this.apply(None, book, window, cx));
    }
    impl Picker {
        fn new(
            host: PageViewHost,
            level: String,
            key: &'static str,
            cx: &mut Context<Self>,
        ) -> Self {
            cx.spawn(async move |this, cx| {
                let _ = this.update(cx, |this, cx| this.follow(cx));
            })
            .detach();
            Self {
                host,
                level,
                key,
                focus: cx.focus_handle(),
                busy: false,
                error: false,
                _workspace: None,
            }
        }
        fn follow(&mut self, cx: &mut Context<Self>) {
            if let Some(ws) = self.host.workspace.upgrade() {
                self._workspace = Some(cx.observe(&ws, |this, ws, cx| {
                    let book = ws.read(cx).book.clone();
                    if book.id == this.host.book_id {
                        this.host.book = book;
                        cx.notify();
                    }
                }));
            }
        }
        fn close(&self, cx: &mut Context<Self>) {
            let id = cx.entity_id();
            dr_shell::dialogs::hide(cx, id);
        }
        fn apply(
            &mut self,
            value: Option<Value>,
            book: std::rc::Rc<dr_shell::book::Book>,
            window: &mut Window,
            cx: &mut Context<Self>,
        ) {
            if self.busy {
                return;
            }
            if crate::data::v3::fresh(&self.host, cx).is_none() {
                self.close(cx);
                return;
            }
            let host = PageViewHost {
                book,
                ..self.host.clone()
            };
            if !host
                .book
                .v3()
                .is_some_and(|v| v.levels.contains_key(&self.level))
            {
                self.close(cx);
                return;
            }
            self.busy = true;
            self.error = false;
            let (id, key) = (self.level.clone(), self.key);
            let close = key != "allow" || value.is_none();
            let edit = match crate::data::v3::prepare_override(&host.book, &id, key, value) {
                Ok(edit) => edit,
                Err(error) => {
                    log::warn!("v3 level setting: {error}");
                    self.busy = false;
                    self.error = true;
                    cx.notify();
                    return;
                }
            };
            let lib = host.library;
            // Admit the write now; closing the window cannot cancel its database job.
            let job = cx
                .background_executor()
                .spawn(async move { edit.commit(&lib) });
            cx.spawn_in(window, async move |this, cx| {
                let result = job.await;
                let _ = this.update(cx, |this, cx| {
                    this.busy = false;
                    this.error = result.is_err();
                    if let Err(error) = &result {
                        log::warn!("v3 level setting: {error}");
                    }
                    if result.is_ok() && close {
                        this.close(cx);
                    } else {
                        cx.notify();
                    }
                });
            })
            .detach();
            cx.notify();
        }
        fn choices(&self, cx: &App) -> Vec<Choice> {
            let Some(v) = self.host.book.v3() else {
                return vec![];
            };
            let Some(l) = v.levels.get(&self.level) else {
                return vec![];
            };
            let s = &l.settings;
            let choice = |label: SharedString, value: Value, current: Value| Choice {
                label,
                checked: value == current,
                value,
            };
            match self.key {
                "display" => ["list", "grid", "board", "island"]
                    .into_iter()
                    .map(|value| {
                        choice(
                            dr_shell::v3::page::display_name(value, cx),
                            json!(value),
                            json!(s.display),
                        )
                    })
                    .collect(),
                "auto_link" | "accept" | "is_manuscript" => {
                    let current = match self.key {
                        "auto_link" => s.auto_link,
                        "accept" => s.accept,
                        _ => s.is_manuscript,
                    };
                    [true, false]
                        .into_iter()
                        .map(|value| {
                            choice(
                                t(
                                    cx,
                                    if value {
                                        keys::v3_levels::ON
                                    } else {
                                        keys::v3_levels::OFF
                                    },
                                ),
                                json!(value),
                                json!(current),
                            )
                        })
                        .collect()
                }
                "default_template" => std::iter::once(choice(
                    t(cx, keys::v3_levels::NONE),
                    Value::Null,
                    json!(s.default_template),
                ))
                .chain(
                    v.templates
                        .iter()
                        .filter(|t| {
                            t.deleted_at.is_none()
                                && (s.allow.is_empty() || s.allow.contains(&t.id))
                        })
                        .map(|t| {
                            choice(
                                t.name.clone().into(),
                                json!(t.id),
                                json!(s.default_template),
                            )
                        }),
                )
                .collect(),
                "allow" => std::iter::once(Choice {
                    label: t(cx, keys::v3_levels::ALL_TEMPLATES),
                    value: json!([]),
                    checked: s.allow.is_empty(),
                })
                .chain(
                    v.templates
                        .iter()
                        .filter(|t| t.deleted_at.is_none())
                        .map(|template| {
                            let mut selected = s.allow.clone();
                            let checked = selected.contains(&template.id);
                            if checked {
                                selected.retain(|id| id != &template.id);
                            } else {
                                selected.push(template.id.clone());
                            }
                            Choice {
                                label: template.name.clone().into(),
                                value: json!(selected),
                                checked,
                            }
                        }),
                )
                .collect(),
                "home" => std::iter::once(choice(
                    t(cx, keys::v3_levels::THIS_LEVEL),
                    Value::Null,
                    json!(s.home),
                ))
                .chain(
                    v.entries
                        .iter()
                        .filter(|e| e.id != self.level && v.levels.contains_key(&e.id))
                        .map(|e| choice(e.title.clone().into(), json!(e.id), json!(s.home))),
                )
                .collect(),
                "format_shortcuts" => [
                    ("full", keys::v3_levels::FORMAT_FULL),
                    ("notes", keys::v3_levels::FORMAT_NOTES),
                    ("plain", keys::v3_levels::FORMAT_PLAIN),
                ]
                .into_iter()
                .map(|(value, label)| choice(t(cx, label), json!(value), json!(s.format_shortcuts)))
                .collect(),
                _ => vec![],
            }
        }
    }
    impl Render for Picker {
        fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            let weak = cx.entity().downgrade();
            let close = weak.clone();
            let mut list = div()
                .id("g2-setting-options")
                .max_h(px(360.0))
                .overflow_y_scroll()
                .flex()
                .flex_col();
            for (index, choice) in self.choices(cx).into_iter().enumerate() {
                let weak = weak.clone();
                let value = choice.value;
                let book = self.host.book.clone();
                list = list.child(
                    MenuItem::new(
                        SharedString::from(format!("g2-setting-choice-{index}")),
                        Icon::Check,
                        choice.label,
                    )
                    .checked(choice.checked)
                    .disabled(self.busy)
                    .on_click(move |_, window, cx| {
                        let _ = weak.update(cx, |this, cx| {
                            this.apply(Some(value.clone()), book.clone(), window, cx)
                        });
                    }),
                );
            }
            if self.error {
                let error = t(cx, keys::common::SAVE_FAILED);
                list = list.child(
                    div()
                        .id("g2-setting-error")
                        .role(gpui::Role::Alert)
                        .aria_label(error.clone())
                        .child(error),
                );
            }
            let dialog = Dialog::new(
                "g2-setting-dialog",
                crate::category::v3::label(self.key, cx),
            )
            .width(420.0)
            .body(list)
            .action(
                Button::new("g2-setting-close", t(cx, keys::common::CLOSE))
                    .text()
                    .disabled(self.busy)
                    .on_click(move |_, _, cx| {
                        let _ = close.update(cx, |this, cx| this.close(cx));
                    }),
            )
            .on_close(move |_, cx| {
                let _ = weak.update(cx, |this, cx| {
                    if !this.busy {
                        this.close(cx);
                    }
                });
            });
            div()
                .track_focus(&self.focus)
                .key_context("G2LevelPicker")
                .on_action(cx.listener(|this, _: &Dismiss, _, cx| {
                    if !this.busy {
                        this.close(cx);
                    }
                }))
                .child(dialog)
        }
    }
}
