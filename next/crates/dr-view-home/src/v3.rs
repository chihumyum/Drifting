//! Versioned Project Home. Template actions create entries through F3; the
//! legacy chapter/idea/category routes are never used by this page.

use std::rc::Rc;

use dr_i18n::{keys, number::compact};
use dr_shell::{
    Services, Settings, Workspace,
    book::Book,
    nav::{Open, Target},
    t,
};
use dr_ui::{
    Theme,
    components::{Button, Dialog},
    fonts::Role,
    input::field::{FieldEvent, TextField},
    sand::KindMark,
    style::DrStyled,
};
use dr_view_stats::{
    LiveWords,
    v3::{Loaded, Scope},
};
use dr_workspace::{
    Actor, Workspace as Library, WsError,
    commands::v3::entry::{CreateIn, EntryCreate},
};
use gpui::{
    AppContext as _, Context, ElementId, Entity, Focusable, IntoElement, ParentElement, Render,
    Styled, Subscription, Task, WeakEntity, Window, div, prelude::*, px,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreateAction {
    pub level: String,
    pub level_title: String,
    pub id: String,
    pub name: String,
    pub template: Option<String>,
}

/// Resident levels only. Memberships do not duplicate an action and a hidden
/// ancestor cannot leave its descendants' create buttons on Home.
pub fn actions(book: &Book) -> Vec<CreateAction> {
    let Some(v) = book.v3() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut todo: Vec<_> = v.roots.iter().rev().cloned().collect();
    let mut seen = std::collections::HashSet::new();
    while let Some(id) = todo.pop() {
        if !seen.insert(id.clone()) {
            continue;
        }
        let Some(entry) = v.entry(&id) else {
            continue;
        };
        let Some(level) = v.levels.get(&id) else {
            continue;
        };
        if let Some(template) = v.template_of(&id) {
            for verb in &template.verbs {
                if verb
                    .target_template
                    .as_ref()
                    .is_none_or(|id| v.template(id).is_some())
                {
                    out.push(CreateAction {
                        level: id.clone(),
                        level_title: entry.title.clone(),
                        id: verb.id.clone(),
                        name: verb.name.clone(),
                        template: verb.target_template.clone(),
                    });
                }
            }
        }
        todo.extend(level.children.iter().rev().cloned());
    }
    out
}

/// A new entry is a partial operation. No read snapshot is ever written back.
/// Re-check a dialog's declaration before creating; changed actions keep the
/// title draft and report a conflict rather than silently choosing a new kind.
pub fn create(
    lib: &Library,
    book: &str,
    action: &CreateAction,
    title: &str,
) -> Result<String, WsError> {
    let current = Book::load(lib, book)?;
    if !actions(&current).iter().any(|a| a == action) {
        return Err(WsError::Conflict("home action changed".into()));
    }
    Ok(lib
        .run::<EntryCreate>(
            &Actor::User,
            CreateIn {
                book: book.into(),
                title: title.into(),
                parent: Some(action.level.clone()),
                template: action.template.clone(),
                bodies: Default::default(),
            },
        )?
        .output
        .id)
}

pub struct Home {
    ws: WeakEntity<Workspace>,
    lib: Option<Library>,
    source: Option<Rc<Book>>,
    pub loaded: Option<Loaded>,
    task: Option<Task<()>>,
    generation: u64,
    stale: bool,
    error: bool,
    _events: Option<dr_workspace::Subscription>,
}

impl Home {
    pub fn new(ws: WeakEntity<Workspace>, cx: &mut Context<Self>) -> Self {
        let lib = cx.try_global::<Services>().and_then(|s| s.library.clone());
        let mut this = Self {
            ws,
            lib,
            source: None,
            loaded: None,
            task: None,
            generation: 0,
            stale: false,
            error: false,
            _events: None,
        };
        if let Some(lib) = &this.lib {
            let (tx, mut rx) = futures::channel::mpsc::unbounded();
            this._events = Some(lib.subscribe(move |event| {
                let book = match event {
                    dr_workspace::WsEvent::Prose(p) => p.book.as_ref().map(ToString::to_string),
                    dr_workspace::WsEvent::Local(c) if c.table == "index" => Some(String::new()),
                    _ => None,
                };
                if let Some(book) = book {
                    let _ = tx.unbounded_send(book);
                }
            }));
            cx.spawn(async move |this, cx| {
                use futures::StreamExt as _;
                while let Some(book) = rx.next().await {
                    if this
                        .update(cx, |h, cx| {
                            if h.source
                                .as_ref()
                                .is_some_and(|b| book.is_empty() || b.id == book)
                            {
                                h.stale = true;
                                cx.notify();
                            }
                        })
                        .is_err()
                    {
                        break;
                    }
                }
            })
            .detach();
        }
        this
    }

    fn reload(&mut self, book: Rc<Book>, cx: &mut Context<Self>) {
        let Some(lib) = self.lib.clone() else {
            return;
        };
        if self.source.as_ref().is_none_or(|old| old.id != book.id) {
            self.loaded = None;
        }
        self.source = Some(book.clone());
        self.stale = false;
        self.error = false;
        self.generation += 1;
        let generation = self.generation;
        let id = book.id.clone();
        self.task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_millis(60))
                .await;
            let loaded = cx
                .background_executor()
                .spawn(async move { dr_view_stats::v3::load(&lib, &id, Scope::Book) })
                .await;
            this.update(cx, |h, cx| {
                if generation != h.generation {
                    return;
                }
                h.task = None;
                match loaded {
                    Ok(loaded) => h.loaded = Some(loaded),
                    Err(error) => {
                        log::warn!("v3 home read failed: {error}");
                        h.loaded = None;
                        h.error = true;
                    }
                }
                cx.notify();
            })
            .ok();
        }));
    }

    pub fn ask_create(
        &mut self,
        action: CreateAction,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<Entity<CreateDialog>> {
        let lib = self.lib.clone()?;
        let ws = self.ws.upgrade()?;
        let book = ws.read(cx).book_id.clone();
        let weak = self.ws.clone();
        let dialog = cx.new(|cx| CreateDialog::new(lib, weak, book, action, window, cx));
        dr_shell::dialogs::show_in(window.window_handle(), cx, dialog.clone().into());
        Some(dialog)
    }
}

impl Render for Home {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let book = self
            .ws
            .upgrade()
            .map(|ws| ws.read(cx).book.clone())
            .unwrap_or_default();
        if book.v3().is_some()
            && (self.source.as_ref().is_none_or(|s| !Rc::ptr_eq(s, &book))
                || (self.stale && self.task.is_none()))
        {
            self.reload(book.clone(), cx);
        }
        let locale = Settings::locale(cx);
        let words = self
            .loaded
            .as_ref()
            .and_then(|s| s.book_words(LiveWords::read(cx)))
            .map(|m| {
                dr_shell::strings::tf(
                    cx,
                    keys::project_home::WORDS,
                    &[("words", &compact(m.words, locale))],
                )
            })
            .unwrap_or_else(|| t(cx, keys::common::COUNTING));
        let mut column = div()
            .w_full()
            .pt(px(64.0))
            .px(px(48.0))
            .pb(px(128.0))
            .flex()
            .flex_col()
            .gap(px(24.0))
            .child(
                div()
                    .font_role(Role::Index)
                    .child(t(cx, keys::project_home::KICKER)),
            )
            .child(
                div()
                    .font_role(Role::Prose)
                    .type_px(34.0, 44.0)
                    .child(book.name.clone()),
            );
        if !self.error {
            column = column.child(words);
        }
        if self.error {
            let home = cx.entity();
            column = column.child(
                Button::new("v3-home-retry", t(cx, keys::manuscript_export::RETRY)).on_click(
                    move |_, _, cx| {
                        home.update(cx, |h, cx| {
                            h.stale = true;
                            cx.notify();
                        })
                    },
                ),
            );
        }
        if let Some(loaded) = &self.loaded {
            let first = loaded
                .documents
                .iter()
                .filter_map(|d| Some((d, book.v3()?.entry(d.entry.as_deref()?)?)))
                .max_by_key(|(_, entry)| entry.updated_at.or(entry.created_at));
            if let Some((doc, entry)) = first {
                let target = Target::Entry {
                    id: entry.id.parse().expect("validated entry id"),
                    module: doc
                        .module
                        .as_deref()
                        .map(str::parse)
                        .transpose()
                        .expect("validated module id"),
                };
                let ws = self.ws.clone();
                column = column
                    .child(
                        div()
                            .font_role(Role::Structure)
                            .child(t(cx, keys::project_home::continue_::TITLE)),
                    )
                    .child(
                        Button::new("v3-home-continue", entry.title.clone())
                            .text()
                            .on_click(move |_, _, cx| {
                                ws.update(cx, |ws, cx| ws.open(target.clone(), Open::KEEP, cx))
                                    .ok();
                            }),
                    );
            }
        }
        column = column.child(
            Button::new("v3-home-all", t(cx, keys::manuscript_export::WHOLE_BOOK))
                .text()
                .on_click(|_, window, cx| {
                    window.dispatch_action(Box::new(dr_shell::actions::ShowWholeBook), cx)
                }),
        );
        let mut creations = div().flex().flex_wrap().gap(px(12.0));
        for action in actions(&book) {
            let home = cx.entity();
            creations = creations.child(
                Button::new(
                    ElementId::Name(
                        format!("v3-home-create-{}-{}", action.level, action.id).into(),
                    ),
                    action.name.clone(),
                )
                .on_click(move |_, window, cx| {
                    home.update(cx, |h, cx| {
                        h.ask_create(action.clone(), window, cx);
                    });
                }),
            );
        }
        column = column.child(creations).child(
            div()
                .font_role(Role::Structure)
                .child(t(cx, keys::project_home::book::TITLE)),
        );
        if let Some(v3) = book.v3() {
            for id in &v3.roots {
                let Some(entry) = v3.entry(id) else {
                    continue;
                };
                let target = Target::Entry {
                    id: id.parse().expect("validated entry id"),
                    module: None,
                };
                let ws = self.ws.clone();
                let mark = v3
                    .appearance(id)
                    .map(|a| a.sand)
                    .unwrap_or(dr_ui::sand::Kind::Element);
                column = column.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .child(KindMark::new(
                            ElementId::Name(format!("v3-home-mark-{id}").into()),
                            mark,
                        ))
                        .child(
                            Button::new(
                                ElementId::Name(format!("v3-home-entry-{id}").into()),
                                entry.title.clone(),
                            )
                            .text()
                            .on_click(move |_, _, cx| {
                                ws.update(cx, |ws, cx| ws.open(target.clone(), Open::KEEP, cx))
                                    .ok();
                            }),
                        ),
                );
            }
        }
        div()
            .id("project-home-v3")
            .size_full()
            .overflow_y_scroll()
            .child(column)
    }
}

pub struct CreateDialog {
    lib: Library,
    ws: WeakEntity<Workspace>,
    book: String,
    pub action: CreateAction,
    pub title: Entity<TextField>,
    pub error: Option<String>,
    pub busy: bool,
    _field: Subscription,
}

impl CreateDialog {
    fn new(
        lib: Library,
        ws: WeakEntity<Workspace>,
        book: String,
        action: CreateAction,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let placeholder = t(cx, keys::k4_book::UNTITLED_ENTRY);
        let title =
            cx.new(|cx| TextField::new("v3-home-new-title", window, cx).placeholder(placeholder));
        title.focus_handle(cx).focus(window, cx);
        let sub = cx.subscribe_in(&title, window, |d, _, event, window, cx| match event {
            FieldEvent::Submitted(_) => d.submit(window, cx),
            FieldEvent::Cancelled => d.close(cx),
            FieldEvent::Changed(_) => cx.notify(),
            _ => {}
        });
        Self {
            lib,
            ws,
            book,
            action,
            title,
            error: None,
            busy: false,
            _field: sub,
        }
    }

    pub fn close(&mut self, cx: &mut Context<Self>) {
        if !self.busy {
            let id = cx.entity_id();
            dr_shell::dialogs::hide(cx, id);
        }
    }

    pub fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let title = self.title.read(cx).text().trim().to_owned();
        if self.busy || title.is_empty() {
            return;
        }
        self.busy = true;
        self.error = None;
        self.title.update(cx, |f, cx| f.set_disabled(true, cx));
        let (lib, book, action) = (self.lib.clone(), self.book.clone(), self.action.clone());
        cx.spawn_in(window, async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { create(&lib, &book, &action, &title) })
                .await;
            this.update_in(cx, |d, _, cx| {
                d.busy = false;
                d.title.update(cx, |f, cx| f.set_disabled(false, cx));
                match result {
                    Ok(id) => {
                        d.ws.update(cx, |ws, cx| {
                            if ws.book_id == d.book {
                                ws.open(
                                    Target::Entry {
                                        id: id.parse().expect("validated entry id"),
                                        module: None,
                                    },
                                    Open::KEEP,
                                    cx,
                                );
                            }
                        })
                        .ok();
                        d.close(cx);
                    }
                    Err(error) => {
                        d.error = Some(error.to_string());
                        cx.notify();
                    }
                }
            })
            .ok();
        })
        .detach();
        cx.notify();
    }
}

impl Render for CreateDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity();
        let cancel = me.clone();
        let close = me.clone();
        let error = self.error.as_ref().map(|_| {
            div()
                .text_color(Theme::of(window, cx).palette.danger.solid())
                .child(t(cx, keys::common::SAVE_FAILED))
        });
        Dialog::new("v3-home-create-dialog", self.action.name.clone())
            .eyebrow(self.action.level_title.clone())
            .body(self.title.clone())
            .body(div().children(error))
            .action(
                Button::new("v3-home-create-cancel", t(cx, keys::common::CANCEL))
                    .disabled(self.busy)
                    .on_click(move |_, _, cx| cancel.update(cx, |d, cx| d.close(cx))),
            )
            .action(
                Button::new("v3-home-create-submit", self.action.name.clone())
                    .primary()
                    .busy(self.busy)
                    .disabled(self.busy || self.title.read(cx).text().trim().is_empty())
                    .on_click(move |_, window, cx| me.update(cx, |d, cx| d.submit(window, cx))),
            )
            .on_close(move |_, cx| close.update(cx, |d, cx| d.close(cx)))
            .on_mist(|_, _| {})
    }
}
