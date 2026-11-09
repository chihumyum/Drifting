//! The existing Stats visual vocabulary over v3 scopes.
use std::rc::Rc;

use dr_i18n::{I18n, Locale, Platform, keys};
use dr_ui::{Theme, style::DrStyled};
use dr_workspace::Workspace;
use gpui::{
    App, AppContext as _, Context, ElementId, Entity, InteractiveElement, IntoElement,
    ParentElement, Render, SharedString, StatefulInteractiveElement, Styled, Task, Window, div, px,
};

use crate::{
    LiveWords,
    sections::Ui,
    v3::{self, Loaded, Scope},
};

pub type Open = Rc<dyn Fn(Scope, &mut Window, &mut App)>;

pub struct View {
    id: SharedString,
    lib: Option<Workspace>,
    pub(crate) book: String,
    scope: Scope,
    i18n: I18n,
    open: Option<Open>,
    loaded: Option<Loaded>,
    task: Option<Task<()>>,
    revision: u64,
}

impl View {
    pub fn new(id: SharedString, lib: Option<Workspace>) -> Self {
        Self {
            id,
            lib,
            book: String::new(),
            scope: Scope::Book,
            i18n: I18n::new(Locale::En, Platform::Mac),
            open: None,
            loaded: None,
            task: None,
            revision: 0,
        }
    }
    pub fn loaded(&self) -> Option<&Loaded> {
        self.loaded.as_ref()
    }
    pub fn show(
        &mut self,
        book: &str,
        scope: Scope,
        locale: Locale,
        platform: Platform,
        open: Option<Open>,
        cx: &mut Context<Self>,
    ) {
        self.i18n = I18n::new(locale, platform);
        self.open = open;
        if self.book != book || self.scope != scope {
            self.book = book.into();
            self.scope = scope;
            self.loaded = None;
            self.reload(cx);
        }
    }
    pub(crate) fn reload(&mut self, cx: &mut Context<Self>) {
        let Some(lib) = self.lib.clone() else {
            return;
        };
        if self.book.is_empty() {
            return;
        }
        self.revision += 1;
        let revision = self.revision;
        let (book, scope) = (self.book.clone(), self.scope.clone());
        self.task = Some(cx.spawn(async move |this, cx| {
            // Coalesce a burst of prose/index/book events; a newer request
            // cancels this task and cannot receive this request's result.
            cx.background_executor()
                .timer(crate::panel::RELOAD_DELAY)
                .await;
            let result = cx
                .background_executor()
                .spawn(async move { v3::load(&lib, &book, scope) })
                .await;
            this.update(cx, |v, cx| {
                if v.revision != revision {
                    return;
                }
                v.task = None;
                match result {
                    Ok(data) => v.loaded = Some(data),
                    Err(error) => {
                        v.loaded = None;
                        log::warn!("v3 stats: {error}");
                    }
                }
                cx.notify();
            })
            .ok();
        }));
    }
}

impl Render for View {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        use keys::right_sidebar::stats;
        let theme = Theme::of(window, cx);
        let ui = Ui {
            theme,
            i18n: &self.i18n,
            id: self.id.clone(),
        };
        let live = LiveWords::read(cx);
        let data = self.loaded.as_ref();
        let words = |n: Option<u64>| {
            n.map_or_else(
                || ui.t(keys::workspace_word_tally::COUNTING),
                |n| ui.words(n),
            )
        };
        let label = match self.scope {
            Scope::Book => keys::workspace_word_tally::BOOK,
            Scope::Entry { .. } => keys::k4_book::ENTRY_WORDS,
            Scope::Material(_) => keys::k4_book::MATERIAL_WORDS,
        };
        let mut first = ui.section(None).child(ui.small(ui.t(label))).child(
            div()
                .font_role(dr_ui::fonts::Role::Ui)
                .type_px(theme.scale.heading, theme.scale.heading * 1.3)
                .text_color(theme.palette.ink(1).solid())
                .child(words(data.and_then(|d| d.words(live)).map(|n| n.words))),
        );
        if self.scope != Scope::Book {
            first = first.child(ui.row(
                ui.t(keys::workspace_word_tally::BOOK),
                words(data.and_then(|d| d.book_words(live)).map(|n| n.words)),
            ));
        }
        let mut progress = ui.section(Some(ui.t(stats::WRITING_PROGRESS)));
        if let Some(data) = data {
            progress =
                progress.child(ui.row(ui.t(keys::k4_book::LEAF_COUNT), data.leaves.to_string()));
            if let Some(f) = data
                .book_words(live)
                .and_then(|n| crate::model::progress(n.words, data.word_target))
            {
                progress = progress.child(ui.stroke("book", f, None));
            }
        }
        let mut body = div()
            .id(ElementId::Name(self.id.clone()))
            .size_full()
            .overflow_y_scroll()
            .px(px(16.0))
            .pt(px(10.0))
            .pb(px(24.0))
            .flex()
            .flex_col()
            .gap(px(22.0))
            .child(first);
        if let Some(data) = data {
            if let Some(shape) = data.shape {
                body = body.child(
                    ui.section(Some(ui.t(stats::WORD_RHYTHM)))
                        .child(ui.row(
                            ui.t(stats::PARAGRAPH_SENTENCE),
                            ui.fmt(
                                stats::PARAGRAPH_SENTENCE_VALUE,
                                &[
                                    ("paragraphs", &shape.paragraphs),
                                    ("sentences", &shape.sentences),
                                ],
                            ),
                        ))
                        .child(ui.row(
                            ui.t(stats::DIALOGUE_RATIO),
                            format!("{}%", (shape.dialogue * 100.0).round()),
                        ))
                        .child(ui.stroke("dialogue", shape.dialogue, None)),
                );
            }
            let mut modules = ui.section(None);
            for doc in &data.documents {
                let name = if doc.retained {
                    ui.t(keys::k4_book::RETAINED_CONTENT).to_string()
                } else {
                    doc.name.clone()
                };
                let name = if matches!(data.scope, Scope::Book) {
                    format!(
                        "{} · {}",
                        doc.entry_title.as_deref().unwrap_or_default(),
                        name
                    )
                } else {
                    name
                };
                let mut row = div()
                    .id(ElementId::Name(format!("{}-{}", self.id, doc.id).into()))
                    .child(
                        ui.row(
                            name,
                            words(
                                live.docs
                                    .get(&doc.id)
                                    .copied()
                                    .or(doc.metrics)
                                    .map(|n| n.words),
                            ),
                        ),
                    );
                if let (Some(open), Some(entry)) = (self.open.clone(), doc.entry.clone()) {
                    let module = doc.module.clone();
                    row = row.cursor_pointer().on_click(move |_, window, cx| {
                        open(
                            Scope::Entry {
                                id: entry.clone(),
                                module: module.clone(),
                            },
                            window,
                            cx,
                        )
                    });
                }
                modules = modules.child(row);
            }
            body = body.child(modules);
        }
        body.child(progress)
    }
}

/// Version-specific host API; the caller passes the actual entry/module
/// before any legacy nav_target conversion and maps Open directly to Target.
pub fn panel(
    id: &str,
    book: &str,
    scope: Scope,
    locale: Locale,
    platform: Platform,
    open: Option<Open>,
    cx: &mut App,
) -> gpui::AnyElement {
    let key: SharedString = id.to_owned().into();
    let Some(hub) = cx.try_global::<crate::Hub>() else {
        return gpui::Empty.into_any_element();
    };
    let lib = hub.lib.clone();
    let existing = hub.v3_views.get(&key).cloned();
    let view = existing.unwrap_or_else(|| {
        let v = cx.new(|_| View::new(key.clone(), lib));
        let weak = v.downgrade();
        cx.observe_global::<LiveWords>(move |cx| {
            if let Some(v) = weak.upgrade() {
                v.update(cx, |_, cx| cx.notify());
            }
        })
        .detach();
        cx.global_mut::<crate::Hub>()
            .v3_views
            .insert(key, v.clone());
        v
    });
    view.update(cx, |v, cx| v.show(book, scope, locale, platform, open, cx));
    view.into_any_element()
}

pub fn view(id: &str, cx: &App) -> Option<Entity<View>> {
    cx.try_global::<crate::Hub>()
        .and_then(|h| h.v3_views.get(&SharedString::from(id.to_owned())).cloned())
}
