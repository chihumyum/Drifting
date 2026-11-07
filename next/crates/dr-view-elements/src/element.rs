//! The element page's head, above its text (the 0.1 client's
//! `ElementEditorView`, `elem-overview`): the folio, the name, the aliases,
//! the summary, then the head of 「记 · 传」 (the text is the editor's).
//!
//! The 0.1 rules:
//!
//! - **Name**: Enter leaves the field, Esc puts the stored name back and
//!   leaves, leaving saves. Trimmed; empty or unchanged writes nothing (the
//!   field keeps what was typed and shows 「未命名要素」 when empty). A name
//!   another element has as its name or an alias is refused: an alert says
//!   whose, and the stored name comes back.
//! - **Aliases**: flat words joined by 「·」; the one under the pointer gets
//!   a cell's ring and a ×. The input at the end has no frame: Enter or
//!   leaving adds what is typed, Esc clears it. An alias the element already
//!   has is ignored; one another element uses is refused with an alert.
//! - **Summary**: Enter starts a new line, Esc puts the stored summary back,
//!   leaving saves (not trimmed).

use std::rc::Rc;

use dr_i18n::keys;
use dr_shell::book::{Book, color_of};
use dr_shell::strings::tf;
use dr_shell::{Services, Workspace, t};
use dr_ui::{
    Theme,
    components::cell::{RING_RIM, ring_tone},
    fonts::{Role, weight},
    glass::{self, Kind as GlassKind, Mode, Spec},
    input::{
        area::TextArea,
        field::{FieldEvent, TextField},
    },
    sand::{self, Icon},
    style::DrStyled,
    tokens::radius,
};
use dr_workspace::{Workspace as Library, WsError, commands::element::ElementUpdateIn};
use gpui::{
    AnyElement, App, AppContext as _, Context, ElementId, Entity, Focusable as _,
    InteractiveElement as _, IntoElement, ParentElement as _, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, WeakEntity, Window, div, px,
};

use crate::data;
use crate::page;

/// The element page's head.
pub struct ElementHead {
    ws: WeakEntity<Workspace>,
    lib: Option<Library>,
    /// The element's id.
    pub id: String,
    /// The shell's book snapshot last drawn.
    book: Rc<Book>,
    name: Entity<TextArea>,
    alias: Entity<TextField>,
    summary: Entity<TextArea>,
    /// The stored values the fields were last given: only a new stored value
    /// replaces what is in a field (never the author's unsaved typing).
    shown_name: Option<String>,
    shown_summary: Option<String>,
    /// The alias input's placeholder is 「添加别名」 while there are none.
    alias_first: bool,
    _subs: Vec<Subscription>,
}

impl ElementHead {
    pub fn new(
        id: String,
        ws: WeakEntity<Workspace>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> ElementHead {
        let lib = cx.try_global::<Services>().and_then(|s| s.library.clone());
        let untitled = t(cx, keys::element_editor::UNTITLED);
        let name = cx.new(|cx| {
            TextArea::new(field_id("element-name", &id), window, cx)
                .submit_on_enter()
                .placeholder(untitled)
        });
        let hint = t(cx, keys::element_editor::SUMMARY_PLACEHOLDER);
        let summary = cx.new(|cx| {
            TextArea::new(field_id("element-summary", &id), window, cx).placeholder(hint)
        });
        let alias = Self::alias_field(&id, true, window, cx);
        let mut head = ElementHead {
            ws,
            lib,
            id,
            book: Rc::default(),
            name,
            alias,
            summary,
            shown_name: None,
            shown_summary: None,
            alias_first: true,
            _subs: Vec::new(),
        };
        head.subscribe(window, cx);
        // The workspace is still opening the page: follow its book once
        // the page is there.
        cx.spawn(async move |this, cx| this.update(cx, |head, cx| head.follow(cx)).ok())
            .detach();
        head
    }

    fn alias_field(
        id: &str,
        first: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<TextField> {
        let hint = if first {
            t(cx, keys::element_editor::alias::ADD_FIRST)
        } else {
            t(cx, keys::element_editor::alias::ADD)
        };
        cx.new(|cx| {
            TextField::new(field_id("element-alias", id), window, cx)
                .bare()
                .placeholder(hint)
        })
    }

    fn subscribe(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let name = cx.subscribe_in(&self.name, window, |head, field, e, window, cx| match e {
            // Enter leaves; leaving saves.
            FieldEvent::Submitted(_) => head.leave(window, cx),
            FieldEvent::Cancelled => {
                let stored = head.stored_name();
                field.update(cx, |f, cx| f.set_text(stored, cx));
                head.leave(window, cx);
            }
            FieldEvent::Blurred => {
                let text = field.read(cx).text();
                head.save_name(text, window, cx);
            }
            FieldEvent::Changed(_) => {}
        });
        let summary = cx.subscribe_in(
            &self.summary,
            window,
            |head, field, e, window, cx| match e {
                FieldEvent::Submitted(_) => head.leave(window, cx),
                FieldEvent::Cancelled => {
                    let stored = head.stored_summary();
                    field.update(cx, |f, cx| f.set_text(stored, cx));
                    head.leave(window, cx);
                }
                FieldEvent::Blurred => {
                    let text = field.read(cx).text();
                    head.save_summary(text, window, cx);
                }
                FieldEvent::Changed(_) => {}
            },
        );
        self._subs = vec![name, summary, self.subscribe_alias(window, cx)];
    }

    fn subscribe_alias(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Subscription {
        cx.subscribe_in(&self.alias, window, |head, field, e, window, cx| match e {
            FieldEvent::Submitted(text) => {
                let text = text.clone();
                field.update(cx, |f, cx| f.set_text("", cx));
                head.add_alias(text, window, cx);
            }
            FieldEvent::Blurred => {
                let text = field.read(cx).text();
                if !text.trim().is_empty() {
                    field.update(cx, |f, cx| f.set_text("", cx));
                    head.add_alias(text, window, cx);
                }
            }
            FieldEvent::Cancelled => {
                field.update(cx, |f, cx| f.set_text("", cx));
                head.leave(window, cx);
            }
            FieldEvent::Changed(_) => {}
        })
    }

    /// Re-reads the shell's book each time the workspace swaps it.
    fn follow(&mut self, cx: &mut Context<Self>) {
        let Some(ws) = self.ws.upgrade() else {
            return;
        };
        self.book = ws.read(cx).book.clone();
        self._subs.push(cx.observe(&ws, |head, ws, cx| {
            let book = ws.read(cx).book.clone();
            if !Rc::ptr_eq(&book, &head.book) {
                head.book = book;
                cx.notify();
            }
        }));
        cx.notify();
    }

    fn book_id(&self) -> String {
        self.book.id.clone()
    }

    fn stored_name(&self) -> String {
        data::element(&self.book, &self.id)
            .map(|e| e.name.clone())
            .unwrap_or_default()
    }

    fn stored_summary(&self) -> String {
        data::element(&self.book, &self.id)
            .map(|e| e.summary.clone())
            .unwrap_or_default()
    }

    /// The caret leaves the page's fields (the 0.1 fields blur).
    fn leave(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(ws) = self.ws.upgrade() {
            ws.read(cx).focus_handle().clone().focus(window, cx);
        }
    }

    /// The name field, the alias input and the summary field (tests).
    pub fn fields(&self) -> (Entity<TextArea>, Entity<TextField>, Entity<TextArea>) {
        (self.name.clone(), self.alias.clone(), self.summary.clone())
    }

    fn save_name(&mut self, text: String, window: &mut Window, cx: &mut Context<Self>) {
        let name = text.trim().to_owned();
        if name.is_empty() || name == self.stored_name() {
            return;
        }
        let mut edit = data::element_edit(&self.book_id(), &self.id);
        edit.name = Some(name.clone());
        self.write(edit, Refused::Name(name), window, cx);
    }

    fn save_summary(&mut self, text: String, window: &mut Window, cx: &mut Context<Self>) {
        if text == self.stored_summary() {
            return;
        }
        let mut edit = data::element_edit(&self.book_id(), &self.id);
        edit.summary = Some(text);
        self.write(edit, Refused::Other, window, cx);
    }

    fn add_alias(&mut self, text: String, window: &mut Window, cx: &mut Context<Self>) {
        let alias = text.trim().to_owned();
        if alias.is_empty() {
            return;
        }
        // One the element already has (its name or an alias) adds nothing.
        let key = alias.to_lowercase();
        let own = data::element(&self.book, &self.id).is_some_and(|e| {
            e.name.trim().to_lowercase() == key
                || e.aliases.iter().any(|a| a.trim().to_lowercase() == key)
        });
        if own {
            return;
        }
        let mut edit = data::element_edit(&self.book_id(), &self.id);
        edit.add_aliases = vec![alias.clone()];
        self.write(edit, Refused::Alias(alias), window, cx);
    }

    /// Takes an alias off the element (the × on it).
    pub fn remove_alias(&mut self, alias: String, window: &mut Window, cx: &mut Context<Self>) {
        let mut edit = data::element_edit(&self.book_id(), &self.id);
        edit.remove_aliases = vec![alias];
        self.write(edit, Refused::Other, window, cx);
    }

    /// Writes `edit` off the main thread; a name or alias another element
    /// holds raises the 0.1 alert (the shell's dialog, [`crate::dialogs`]),
    /// and a refused name shows the stored one again.
    fn write(
        &mut self,
        edit: ElementUpdateIn,
        refused: Refused,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(lib) = self.lib.clone() else {
            return;
        };
        cx.spawn_in(window, async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { data::update_element(&lib, edit) })
                .await;
            this.update_in(cx, |head, window, cx| match result {
                Ok(()) => {}
                Err(WsError::NameTaken { id, .. }) => {
                    let conflicting = data::element(&head.book, &id)
                        .map(|e| e.name.clone())
                        .unwrap_or(id);
                    let message = match refused {
                        Refused::Name(name) => {
                            let stored = head.stored_name();
                            head.name.update(cx, |f, cx| f.set_text(stored, cx));
                            tf(
                                cx,
                                keys::element_editor::alerts::RENAME_CONFLICT,
                                &[("name", &name), ("conflicting", &conflicting)],
                            )
                        }
                        Refused::Alias(alias) => tf(
                            cx,
                            keys::element_editor::alerts::ALIAS_CONFLICT,
                            &[("name", &alias), ("conflicting", &conflicting)],
                        ),
                        Refused::Other => return,
                    };
                    let ws = head.ws.clone();
                    crate::dialogs::open(crate::dialogs::AskFor::Alert(message), ws, window, cx);
                }
                Err(error) => log::warn!("the element could not be saved: {error}"),
            })
            .ok();
        })
        .detach();
    }

    /// Gives the fields a new stored value, unless the caret is in them.
    fn sync(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(element) = data::element(&self.book, &self.id) else {
            return;
        };
        let (name, summary) = (element.name.clone(), element.summary.clone());
        let first = element.aliases.is_empty();
        if self.shown_name.as_ref() != Some(&name) && !self.name.focus_handle(cx).is_focused(window)
        {
            self.shown_name = Some(name.clone());
            self.name.update(cx, |f, cx| f.set_text(name, cx));
        }
        if self.shown_summary.as_ref() != Some(&summary)
            && !self.summary.focus_handle(cx).is_focused(window)
        {
            self.shown_summary = Some(summary.clone());
            self.summary.update(cx, |f, cx| f.set_text(summary, cx));
        }
        if first != self.alias_first && !self.alias.focus_handle(cx).is_focused(window) {
            self.alias_first = first;
            self.alias = Self::alias_field(&self.id, first, window, cx);
            let sub = self.subscribe_alias(window, cx);
            self._subs.push(sub);
        }
    }
}

/// What a refused write was, for its alert.
enum Refused {
    Name(String),
    Alias(String),
    Other,
}

/// A field's element id on this element's page.
pub(crate) fn field_id(name: &str, id: &str) -> ElementId {
    ElementId::Name(format!("{name}-{id}").into())
}

impl Render for ElementHead {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync(window, cx);
        let Some(element) = data::element(&self.book, &self.id).cloned() else {
            return div().into_any_element();
        };
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let look = page::look(cx);
        let category = element
            .category
            .as_deref()
            .and_then(|c| data::category(&self.book, c));
        let mut folio = vec![
            div()
                .child(t(cx, keys::element_editor::FOLIO))
                .into_any_element(),
        ];
        if let Some(category) = category {
            let mut label = category.name.clone();
            if let Some(group) = element.group_name.as_deref().filter(|g| !g.is_empty()) {
                label.push_str(" - ");
                label.push_str(group);
            }
            folio.push(page::folio_mark(
                "element-folio-category",
                sand::Kind::Category,
                color_of(&category.color),
                label.into(),
                window,
                cx,
            ));
        }
        let entity = cx.entity();
        let mut aliases = div()
            .mt(px(4.0))
            .flex()
            .flex_row()
            .flex_wrap()
            .items_center()
            .gap(px(2.0))
            .font_role(Role::Prose)
            .type_px(13.0, 24.0)
            .text_color(p.ink(2).solid());
        for (i, alias) in element.aliases.iter().enumerate() {
            if i > 0 {
                aliases = aliases.child(div().px(px(2.0)).text_color(p.ink(5).solid()).child("·"));
            }
            aliases = aliases.child(alias_chip(&entity, i, alias, window, cx));
        }
        let aliases = aliases.child(
            div()
                .min_w(px(80.0))
                .px(px(4.0))
                .py(px(2.0))
                .type_px(12.0, 18.0)
                .text_color(p.ink(3).solid())
                .child(self.alias.clone()),
        );
        let overview = div()
            .pb(px(22.0))
            .mb(px(24.0))
            .border_b_1()
            .border_color(p.rule.solid())
            .flex()
            .flex_col()
            .child(
                div()
                    .id("element-name")
                    .font_role(Role::Prose)
                    .type_px(38.0, 38.0 * 1.3)
                    .weight(weight::MEDIUM)
                    .text_color(p.ink(1).solid())
                    .child(self.name.clone()),
            )
            .child(aliases)
            .child(
                div()
                    .mt(px(12.0))
                    .font_role(Role::Prose)
                    .type_px(look.font_size - 2.0, (look.font_size - 2.0) * 1.5)
                    .text_color(p.ink(3).solid())
                    .child(self.summary.clone()),
            );
        let content = div()
            .flex()
            .flex_col()
            .child(page::folio(folio, window, cx))
            .child(overview)
            .child(page::section(
                t(cx, keys::element_editor::sections::BIO_TITLE),
                None,
                true,
                window,
                cx,
            ));
        page::column(look, content).pt(px(56.0)).into_any_element()
    }
}

/// One alias: flat words; under the pointer a cell's ring and a ×.
fn alias_chip(
    entity: &Entity<ElementHead>,
    ix: usize,
    alias: &str,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let p = Theme::of(window, cx).palette;
    let group: SharedString = format!("element-alias-{ix}").into();
    let remove = {
        let entity = entity.clone();
        let alias = alias.to_owned();
        move |_: &gpui::ClickEvent, window: &mut Window, cx: &mut App| {
            let alias = alias.clone();
            entity.update(cx, |head, cx| head.remove_alias(alias, window, cx));
        }
    };
    let label = t(cx, keys::element_editor::alias::REMOVE);
    glass::glass_box(
        ElementId::Name(group.clone()),
        GlassKind::Hidden,
        Mode::default(),
        false,
        Spec::new(ring_tone(None, p.glass_clear), radius::SM).rim(RING_RIM),
        window,
        cx,
    )
    .group(group.clone())
    .h(px(24.0))
    .pl(px(7.0))
    .pr(px(4.0))
    .flex()
    .flex_row()
    .items_center()
    .gap(px(2.0))
    .child(SharedString::from(alias.to_owned()))
    .child(
        div()
            .id(ElementId::Name(format!("{group}-remove").into()))
            .size(px(14.0))
            .flex()
            .items_center()
            .justify_center()
            .cursor_pointer()
            .role(gpui::Role::Button)
            .aria_label(label)
            .invisible()
            .group_hover(group.clone(), |st| st.visible())
            .on_click(remove)
            .child(sand::icon(Icon::Close, 9.0, p.ink(4).solid())),
    )
    .into_any_element()
}
