//! The Project Home view.

use std::rc::Rc;

use dr_i18n::keys;
use dr_i18n::number::{compact, grouped};
use dr_shell::actions::{ShowWholeBook, ToggleElementOverview, ToggleStoryGraph};
use dr_shell::book::{Book, color_of};
use dr_shell::nav::{Open, Target};
use dr_shell::strings::tf;
use dr_shell::{Services, Settings, Workspace, t};
use dr_ui::{
    Theme,
    components::{
        EmptyState, NumberField, SandCell, Segmented,
        cell::{RING_RIM, ring_tone},
    },
    fonts::{Role, weight},
    glass::{self, Kind as GlassKind, Mode, Spec},
    input::{
        area::TextArea,
        field::{FieldEvent, TextField},
    },
    sand::{self, Icon, KindMark, Readout},
    style::DrStyled,
    tokens::radius,
};
use dr_view_shelf::format;
use dr_workspace::{
    Actor, Workspace as Library, WsEvent,
    commands::book::{BookUpdate, BookUpdateIn},
    dto::ChapterInfo,
};
use gpui::{
    Action, AnyElement, App, AppContext as _, ClickEvent, Context, ElementId, Entity, Focusable,
    InteractiveElement, IntoElement, ParentElement, Render, SharedString,
    StatefulInteractiveElement, Styled, Subscription, Task, WeakEntity, Window, div,
    prelude::FluentBuilder as _, px,
};

use crate::data::{HomeStats, Page};

/// Project Home's two views (the multiple choice beside the title).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HomeView {
    Overview,
    Settings,
}

/// What an F3 event touched, as far as Project Home cares.
enum Touched {
    /// Prose of this book changed, or what was opened in it.
    Book(String),
    /// This document's derived index was written.
    Doc(String),
}

/// How many pages opened recently show under the one to continue.
const MORE_RECENT: usize = 3;

/// The book's name when it has none (the 0.1 title's placeholder).
const NAME_PLACEHOLDER: &str = "Drifting";

pub struct Home {
    ws: WeakEntity<Workspace>,
    lib: Option<Library>,
    pub view: HomeView,
    /// The numbers, for the book in `read_for`.
    pub stats: Option<Rc<HomeStats>>,
    /// The shell's book snapshot the numbers were last read against: a new
    /// snapshot (the book changed, or another book opened) reads them again.
    read_for: Option<Rc<Book>>,
    task: Option<Task<()>>,
    /// A prose change since the last read (words, the last edit).
    stale: bool,
    /// The book's name, a frameless field always (the 0.1 title): a press
    /// puts the caret in it.
    title: Entity<TextField>,
    /// The name last saved from it, until the book's snapshot has it.
    saved_name: Option<String>,
    /// The stored name the field was last given: only a new one replaces
    /// what is in the field (never the author's unsaved typing).
    shown_name: String,
    /// 本书简介 in 设定, and the stored summary it was last given.
    summary: Option<Entity<TextArea>>,
    shown_summary: String,
    _title: Subscription,
    _summary: Option<Subscription>,
    _events: Option<dr_workspace::Subscription>,
}

impl Home {
    pub fn new(ws: WeakEntity<Workspace>, window: &mut Window, cx: &mut Context<Self>) -> Home {
        let lib = cx.try_global::<Services>().and_then(|s| s.library.clone());
        let title = cx.new(|cx| {
            TextField::new("home-title", window, cx)
                .bare()
                .placeholder(NAME_PLACEHOLDER)
        });
        // The 0.1 title: Enter saves and leaves, Esc puts the name back and
        // leaves, leaving saves.
        let sub = cx.subscribe_in(&title, window, |home, field, e, window, cx| match e {
            FieldEvent::Submitted(_) => {
                let text = field.read(cx).text();
                home.finish_rename(Some(text), window, cx);
            }
            FieldEvent::Cancelled => home.finish_rename(None, window, cx),
            FieldEvent::Blurred => {
                let text = field.read(cx).text();
                home.save_name(text, cx);
            }
            FieldEvent::Changed(_) => {}
        });
        let mut home = Home {
            ws,
            lib,
            view: HomeView::Overview,
            stats: None,
            read_for: None,
            task: None,
            stale: false,
            title,
            saved_name: None,
            shown_name: String::new(),
            summary: None,
            shown_summary: String::new(),
            _title: sub,
            _summary: None,
            _events: None,
        };
        home.listen(cx);
        home
    }

    /// F3's bus: a prose change in the book shown means a new last edit; a
    /// chapter's derived index written means new words (right after an
    /// import or seeding, dr-index builds the indexes in the background); a
    /// page of it recorded as opened changes 继续写. Changes to the book
    /// itself come as a new snapshot from the shell.
    fn listen(&mut self, cx: &mut Context<Self>) {
        let Some(lib) = self.lib.clone() else {
            return;
        };
        let (tx, mut rx) = futures::channel::mpsc::unbounded::<Touched>();
        self._events = Some(lib.subscribe(move |event| {
            let touched = match event {
                WsEvent::Prose(p) => p.book.as_ref().map(|b| Touched::Book(b.to_string())),
                WsEvent::Local(change) if change.table == "index" => {
                    Some(Touched::Doc(change.key.clone()))
                }
                // `recent.touch`: the key is the book.
                WsEvent::Local(change) if change.table == "recent" => {
                    Some(Touched::Book(change.key.clone()))
                }
                _ => None,
            };
            if let Some(touched) = touched {
                let _ = tx.unbounded_send(touched);
            }
        }));
        cx.spawn(async move |this, cx| {
            use futures::StreamExt as _;
            while let Some(first) = rx.next().await {
                let mut batch = vec![first];
                while let Ok(more) = rx.try_recv() {
                    batch.push(more);
                }
                let alive = this.update(cx, |home, cx| {
                    let Some(book) = home.book(cx) else {
                        return;
                    };
                    let ours = batch.iter().any(|t| match t {
                        Touched::Book(id) => *id == book.id,
                        Touched::Doc(doc) => doc
                            .strip_prefix("node:")
                            .is_some_and(|id| book.chapters.iter().any(|c| c.id == id)),
                    });
                    if ours {
                        home.stale = true;
                        cx.notify();
                    }
                });
                if alive.is_err() {
                    break;
                }
            }
        })
        .detach();
    }

    fn book(&self, cx: &App) -> Option<Rc<Book>> {
        Some(self.ws.upgrade()?.read(cx).book.clone())
    }

    /// Reads the numbers off the main thread for the book shown.
    fn reload(&mut self, book: Rc<Book>, cx: &mut Context<Self>) {
        let Some(lib) = self.lib.clone() else {
            return;
        };
        if self.task.is_some() {
            return;
        }
        self.stale = false;
        self.read_for = Some(book.clone());
        let id = book.id.clone();
        let today = crate::today(cx);
        self.task = Some(cx.spawn(async move |this, cx| {
            let stats = cx
                .background_executor()
                .spawn(async move { HomeStats::load(&lib, &id, today) })
                .await;
            this.update(cx, |home, cx| {
                home.task = None;
                match stats {
                    Ok(stats) => home.stats = Some(Rc::new(stats)),
                    Err(error) => log::warn!("Project Home's numbers were not read: {error}"),
                }
                cx.notify();
            })
            .ok();
        }));
    }

    /// The numbers for `book`, if they have been read for it.
    fn stats_for(&self, book: &Book) -> Option<Rc<HomeStats>> {
        self.stats.clone().filter(|s| s.book == book.id)
    }

    // Acting.

    fn open(&mut self, target: Target, how: Open, cx: &mut Context<Self>) {
        self.ws.update(cx, |ws, cx| ws.open(target, how, cx)).ok();
    }

    fn update_book(&self, input: BookUpdateIn, cx: &mut Context<Self>) {
        let Some(lib) = self.lib.clone() else {
            return;
        };
        cx.background_executor()
            .spawn(async move {
                if let Err(error) = lib.run::<BookUpdate>(&Actor::User, input) {
                    log::warn!("the book could not be updated: {error}");
                }
            })
            .detach();
    }

    fn edit_of(book: &str) -> BookUpdateIn {
        BookUpdateIn {
            book: book.to_owned(),
            name: None,
            summary: None,
            word_target: None,
            daily_word_target: None,
        }
    }

    /// The book's name field (frameless, always on the page).
    pub fn title_field(&self) -> Entity<TextField> {
        self.title.clone()
    }

    /// The caret is in the book's name.
    pub fn renaming(&self, window: &Window, cx: &App) -> bool {
        self.title.focus_handle(cx).is_focused(window)
    }

    /// Puts the caret in the book's name (a press on it does the same).
    pub fn start_rename(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.book(cx).is_none_or(|b| b.is_empty()) {
            return;
        }
        self.title.focus_handle(cx).focus(window, cx);
        cx.notify();
    }

    /// Leaves the book's name: `Some` saves it (an empty one keeps the
    /// old), `None` puts the old one back.
    pub fn finish_rename(
        &mut self,
        name: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match name {
            Some(name) => self.save_name(name, cx),
            None => {
                let old = self.book(cx).map(|b| b.name.clone()).unwrap_or_default();
                self.title.update(cx, |f, cx| f.set_text(old, cx));
            }
        }
        if let Some(ws) = self.ws.upgrade() {
            ws.read(cx).focus_handle().clone().focus(window, cx);
        }
        cx.notify();
    }

    /// Saves `name` as the book's name unless it is empty (the field gets
    /// the old one back) or already saved.
    fn save_name(&mut self, name: String, cx: &mut Context<Self>) {
        let Some(book) = self.book(cx).filter(|b| !b.is_empty()) else {
            return;
        };
        let name = name.trim().to_owned();
        if name.is_empty() {
            let old = book.name.clone();
            self.title.update(cx, |f, cx| f.set_text(old, cx));
            return;
        }
        if name == book.name || self.saved_name.as_ref() == Some(&name) {
            return;
        }
        self.saved_name = Some(name.clone());
        let mut edit = Home::edit_of(&book.id);
        edit.name = Some(name);
        self.update_book(edit, cx);
    }

    pub fn set_view(&mut self, view: HomeView, window: &mut Window, cx: &mut Context<Self>) {
        self.view = view;
        if view == HomeView::Settings && self.summary.is_none() {
            let hint = t(cx, keys::dashboard::PROFILE_PLACEHOLDER);
            let text = self
                .book(cx)
                .and_then(|b| self.stats_for(&b))
                .map(|s| s.summary.clone())
                .unwrap_or_default();
            self.shown_summary = text.clone();
            let field = cx.new(|cx| {
                TextArea::new("home-summary", window, cx)
                    .framed(4.0)
                    .placeholder(hint)
                    .with_text(text)
            });
            // Saved when the caret leaves (the 0.1 profile), or on ⌘↵.
            let sub = cx.subscribe_in(&field, window, |home, field, e, _, cx| {
                if matches!(e, FieldEvent::Submitted(_) | FieldEvent::Blurred) {
                    let text = field.read(cx).text().trim().to_owned();
                    if let Some(book) = home.book(cx)
                        && home.stats_for(&book).is_some_and(|s| s.summary != text)
                    {
                        let mut edit = Home::edit_of(&book.id);
                        edit.summary = Some(text);
                        home.update_book(edit, cx);
                    }
                }
            });
            self._summary = Some(sub);
            self.summary = Some(field);
        }
        cx.notify();
    }

    fn set_target(&mut self, daily: bool, value: f64, cx: &mut Context<Self>) {
        let Some(book) = self.book(cx) else {
            return;
        };
        let value = value.round().max(0.0) as i64;
        let mut edit = Home::edit_of(&book.id);
        if daily {
            edit.daily_word_target = Some(value);
        } else {
            edit.word_target = Some(value);
        }
        self.update_book(edit, cx);
    }
}

impl Render for Home {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let book = self.book(cx).unwrap_or_default();
        let fresh = self.read_for.as_ref().is_some_and(|r| Rc::ptr_eq(r, &book));
        if !book.is_empty() && (!fresh || self.stale) && self.task.is_none() {
            self.reload(book.clone(), cx);
        }
        // Another book: its summary field starts again.
        if self
            .stats
            .as_ref()
            .is_some_and(|s| s.book != book.id && self.summary.is_some())
        {
            self.summary = None;
            self._summary = None;
        }
        // Without the caret the fields take a new stored value (renamed or
        // rewritten elsewhere, another book). Only a new one: the frame
        // after the caret leaves is drawn before the field reports it, and
        // the typing it saves must still be there.
        if self.saved_name.as_ref() == Some(&book.name) {
            self.saved_name = None;
        }
        if book.name != self.shown_name && !self.title.focus_handle(cx).is_focused(window) {
            self.shown_name = book.name.clone();
            let name = book.name.clone();
            self.title.update(cx, |f, cx| f.set_text(name, cx));
        }
        if let (Some(field), Some(stats)) = (&self.summary, self.stats_for(&book))
            && stats.summary != self.shown_summary
            && !field.focus_handle(cx).is_focused(window)
        {
            self.shown_summary = stats.summary.clone();
            let text = stats.summary.clone();
            field.update(cx, |f, cx| f.set_text(text, cx));
        }
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let stats = self.stats_for(&book);
        let mut column = div()
            .w_full()
            .pt(px(64.0))
            .px(px(48.0))
            .pb(px(128.0))
            .flex()
            .flex_col()
            .gap(px(44.0))
            .child(title(self, &book, stats.as_deref(), window, cx));
        if !book.is_empty() {
            column = match self.view {
                HomeView::Overview => column
                    .child(continue_section(&book, stats.as_deref(), window, cx))
                    .child(book_section(&book, stats.as_deref(), window, cx)),
                // The create row (M02's second milestone) and the Agent's
                // check-in cards (stage 5) go after these.
                HomeView::Settings => column.child(settings(self, stats.as_deref(), window, cx)),
            };
        }
        div()
            .id("project-home")
            .size_full()
            .overflow_y_scroll()
            .text_color(p.ink(1).solid())
            .child(column)
    }
}

/// A readout in the index face (`.dash-ro`).
fn readout(text: impl Into<SharedString>, window: &Window, cx: &App) -> gpui::Div {
    let theme = Theme::of(window, cx);
    let s = theme.scale;
    div()
        .font_role(Role::Index)
        .type_px(s.caption, s.caption * 1.45)
        .text_color(theme.palette.muted().solid())
        .child(text.into())
}

fn title(
    home: &mut Home,
    book: &Book,
    stats: Option<&HomeStats>,
    window: &mut Window,
    cx: &mut Context<Home>,
) -> AnyElement {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let locale = Settings::locale(cx);
    let kicker = match stats.and_then(|s| s.created) {
        Some(day) => tf(
            cx,
            keys::project_home::SINCE,
            &[("date", &since(day, locale))],
        ),
        None => t(cx, keys::project_home::KICKER),
    };
    // The name is its own frameless field, in the title's type
    // (`.dash-title__name`: the content face, 34px, regular).
    let name = div()
        .id("home-name")
        // The 0.1 title's label for screen readers.
        .aria_label(t(cx, keys::dashboard::hero::PROJECT_NAME))
        .font_role(Role::Prose)
        .type_px(34.0, 34.0 * 1.3)
        .weight(weight::REGULAR)
        .text_color(p.ink(1).solid())
        .child(home.title.clone());
    let views = {
        let entity = cx.entity();
        Segmented::new(
            "home-views",
            [
                t(cx, keys::project_home::views::OVERVIEW),
                t(cx, keys::project_home::views::SETTINGS),
            ],
            match home.view {
                HomeView::Overview => 0,
                HomeView::Settings => 1,
            },
        )
        .on_change(move |i, window, cx| {
            let view = if i == 0 {
                HomeView::Overview
            } else {
                HomeView::Settings
            };
            entity.update(cx, |home, cx| home.set_view(view, window, cx));
        })
    };
    let top = div()
        .flex()
        .flex_row()
        .items_start()
        .gap(px(20.0))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .gap(px(8.0))
                .child(readout(kicker, window, cx))
                .child(name),
        )
        .when(!book.is_empty(), |el| {
            el.child(div().mt(px(2.0)).child(views))
        });
    let readouts = (home.view == HomeView::Overview && !book.is_empty()).then(|| {
        let counts = tf(
            cx,
            keys::project_home::READOUT,
            &[
                ("chapters", &book.chapters.len()),
                ("storylines", &book.storylines.len()),
                ("elements", &book.elements.len()),
            ],
        );
        let words = match stats {
            None => t(cx, keys::common::COUNTING),
            Some(s) => match s.word_target.filter(|t| *t > 0) {
                Some(target) => tf(
                    cx,
                    keys::project_home::WORDS_OF_TARGET,
                    &[
                        ("words", &compact(s.words, locale)),
                        ("target", &compact(target as u64, locale)),
                    ],
                ),
                None => tf(
                    cx,
                    keys::project_home::WORDS,
                    &[("words", &compact(s.words, locale))],
                ),
            },
        };
        let today = match stats {
            None => t(cx, keys::common::COUNTING),
            Some(s) => match s.daily_target.filter(|g| *g > 0) {
                Some(goal) => tf(
                    cx,
                    keys::project_home::TODAY,
                    &[
                        ("today", &grouped(s.today.max(0) as u64, locale)),
                        ("goal", &grouped(goal as u64, locale)),
                        ("streak", &s.streak),
                    ],
                ),
                None => tf(
                    cx,
                    keys::project_home::TODAY_NO_GOAL,
                    &[
                        ("today", &grouped(s.today.max(0) as u64, locale)),
                        ("streak", &s.streak),
                    ],
                ),
            },
        };
        let progress = stats.and_then(|s| dr_view_shelf::data::progress(s.words, s.word_target));
        div()
            .mt(px(14.0))
            .flex()
            .flex_col()
            .gap(px(10.0))
            .child(readout(format!("{counts} · {words}"), window, cx))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(14.0))
                    .when_some(progress, |el, value| {
                        el.child(
                            div()
                                .flex_1()
                                .min_w(px(80.0))
                                .child(Readout::new("home-progress", value).color(p.ink(2))),
                        )
                    })
                    .child(readout(today, window, cx)),
            )
    });
    div()
        .flex()
        .flex_col()
        .child(top)
        .children(readouts)
        .into_any_element()
}

/// 「2025年11月」, 「November 2025」: the month the book was started.
fn since(day: chrono::NaiveDate, locale: dr_i18n::Locale) -> String {
    use chrono::Datelike as _;
    use dr_i18n::Locale::*;
    let (y, m) = (day.year(), day.month());
    match locale {
        ZhCn | ZhTw | Ja => format!("{y}年{m}月"),
        Ko => format!("{y}년 {m}월"),
        _ => {
            let months: [&str; 12] = match locale {
                De => [
                    "Januar",
                    "Februar",
                    "März",
                    "April",
                    "Mai",
                    "Juni",
                    "Juli",
                    "August",
                    "September",
                    "Oktober",
                    "November",
                    "Dezember",
                ],
                Es => [
                    "enero",
                    "febrero",
                    "marzo",
                    "abril",
                    "mayo",
                    "junio",
                    "julio",
                    "agosto",
                    "septiembre",
                    "octubre",
                    "noviembre",
                    "diciembre",
                ],
                Fr => [
                    "janvier",
                    "février",
                    "mars",
                    "avril",
                    "mai",
                    "juin",
                    "juillet",
                    "août",
                    "septembre",
                    "octobre",
                    "novembre",
                    "décembre",
                ],
                PtBr => [
                    "janeiro",
                    "fevereiro",
                    "março",
                    "abril",
                    "maio",
                    "junho",
                    "julho",
                    "agosto",
                    "setembro",
                    "outubro",
                    "novembro",
                    "dezembro",
                ],
                _ => [
                    "January",
                    "February",
                    "March",
                    "April",
                    "May",
                    "June",
                    "July",
                    "August",
                    "September",
                    "October",
                    "November",
                    "December",
                ],
            };
            let month = months[(m as usize).saturating_sub(1).min(11)];
            match locale {
                Es | PtBr => format!("{month} de {y}"),
                _ => format!("{month} {y}"),
            }
        }
    }
}

/// A section's head: its name in the structure face, then text buttons on
/// the right.
fn section_head(
    name: SharedString,
    buttons: Vec<AnyElement>,
    window: &Window,
    cx: &App,
) -> gpui::Div {
    let theme = Theme::of(window, cx);
    div()
        .min_h(px(28.0))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(8.0))
        .child(
            div()
                .flex_1()
                .font_role(Role::Structure)
                .type_px(16.0, 16.0 * 1.3)
                .text_color(theme.palette.ink(2).solid())
                .child(name),
        )
        .children(buttons)
}

/// A text button in a section head (`.dash-text-button`): a mark or icon
/// and words; the pointer deepens them.
fn text_button(
    id: &'static str,
    lead: AnyElement,
    label: SharedString,
    action: Box<dyn Action>,
    window: &Window,
    cx: &App,
) -> AnyElement {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let s = theme.scale;
    div()
        .id(id)
        .group(id)
        .h(px(26.0))
        .px(px(6.0))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(6.0))
        .cursor_pointer()
        .role(gpui::Role::Button)
        .aria_label(label.clone())
        .font_role(Role::Ui)
        .type_px(s.secondary, s.line_body)
        .text_color(p.ink(3).solid())
        .group_hover(id, move |st| st.text_color(p.ink(1).solid()))
        .on_click(move |_, window, cx| window.dispatch_action(action.boxed_clone(), cx))
        .child(lead)
        .child(label)
        .into_any_element()
}

/// The chapters by their last change, newest first; reading order breaks
/// ties (and orders them all until the numbers arrive).
pub fn recent<'a>(book: &'a Book, stats: Option<&HomeStats>) -> Vec<&'a ChapterInfo> {
    let mut chapters: Vec<&ChapterInfo> = book.chapters.iter().collect();
    if let Some(stats) = stats {
        chapters.sort_by_key(|c| std::cmp::Reverse(stats.chapter_edited.get(&c.id).copied()));
    }
    chapters
}

/// A chapter or an idea of `book` (F3's `node`), if it is still there.
fn node_target(book: &Book, id: &str) -> Option<Target> {
    let parsed = id.parse().ok()?;
    if book.chapters.iter().any(|c| c.id == id) {
        Some(Target::Chapter(parsed))
    } else if book.ideas.iter().any(|i| i.id == id) {
        Some(Target::Idea(parsed))
    } else {
        None
    }
}

/// Where 继续写 starts (the 0.1 Project Home): the chapter or idea opened
/// last on this device, else the chapter changed last.
pub fn continue_page(book: &Book, stats: Option<&HomeStats>) -> Option<Target> {
    let opened = stats
        .into_iter()
        .flat_map(|s| s.opened.iter())
        .find_map(|o| match &o.page {
            Page::Node(id) => node_target(book, id),
            Page::Element(_) => None,
        });
    opened.or_else(|| {
        recent(book, stats)
            .first()
            .and_then(|c| c.id.parse().ok().map(Target::Chapter))
    })
}

/// The pages opened recently besides `first` (chapters, ideas, elements;
/// at most three), with when, ms since the epoch.
pub fn opened_more(
    book: &Book,
    stats: Option<&HomeStats>,
    first: Option<&Target>,
) -> Vec<(Target, i64)> {
    stats
        .into_iter()
        .flat_map(|s| s.opened.iter())
        .filter_map(|o| {
            let target = match &o.page {
                Page::Node(id) => node_target(book, id)?,
                Page::Element(id) => {
                    let target = Target::Element(id.parse().ok()?);
                    book.exists(&target).then_some(target)?
                }
            };
            (Some(&target) != first).then_some((target, o.used_ms))
        })
        .take(MORE_RECENT)
        .collect()
}

/// A page's name, 「未命名」 without one.
fn name_of(book: &Book, target: &Target, cx: &App) -> SharedString {
    match book.title(target).map(str::trim) {
        Some(name) if !name.is_empty() => SharedString::from(name.to_owned()),
        _ => t(cx, keys::common::UNTITLED),
    }
}

/// Opens `target` from Project Home: a click previews it, a double click
/// keeps it (as in the sidebars).
fn opener(
    entity: Entity<Home>,
    target: Target,
) -> impl Fn(&ClickEvent, &mut Window, &mut App) + 'static {
    move |e, _, cx| {
        let how = if e.click_count() > 1 {
            Open::KEEP
        } else {
            Open::PREVIEW
        };
        let target = target.clone();
        entity.update(cx, |home, cx| home.open(target, how, cx));
    }
}

/// 继续写: the page to continue, then a few more opened recently.
fn continue_section(
    book: &Book,
    stats: Option<&HomeStats>,
    window: &mut Window,
    cx: &mut Context<Home>,
) -> AnyElement {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let s = theme.scale;
    let locale = Settings::locale(cx);
    let now = format::now_ms();
    let all = text_button(
        "home-all-chapters",
        KindMark::new("home-all-mark", sand::Kind::All).into_any_element(),
        t(cx, keys::dashboard::actions::ALL_CHAPTERS),
        Box::new(ShowWholeBook),
        window,
        cx,
    );
    let head = section_head(
        t(cx, keys::project_home::continue_::TITLE),
        vec![all],
        window,
        cx,
    );
    let Some(first) = continue_page(book, stats) else {
        return div()
            .flex()
            .flex_col()
            .gap(px(12.0))
            .child(head)
            .child(
                EmptyState::new(
                    "home-continue-empty",
                    t(cx, keys::project_home::continue_::EMPTY),
                )
                .mark(sand::Kind::Chapter(0)),
            )
            .into_any_element();
    };
    let entity = cx.entity();
    let (kind, color) = book.mark(&first);
    let chapter = match &first {
        Target::Chapter(id) => book.chapters.iter().find(|c| c.id == id.as_str()),
        _ => None,
    };
    let idea = match &first {
        Target::Idea(id) => book.ideas.iter().find(|i| i.id == id.as_str()),
        _ => None,
    };
    let storyline = chapter
        .and_then(|c| c.primary_storyline.as_ref())
        .and_then(|id| book.storylines.iter().find(|l| &l.id == id));
    let id = chapter
        .map(|c| c.id.clone())
        .or_else(|| idea.map(|i| i.id.clone()))
        .unwrap_or_default();
    let (edited, words) = match stats {
        Some(s) if chapter.is_some() => (
            s.chapter_edited.get(&id).copied(),
            s.chapter_words.get(&id).copied(),
        ),
        Some(s) => (
            s.idea_edited.get(&id).copied(),
            s.idea_words.get(&id).copied(),
        ),
        None => (None, None),
    };
    let mut facts: Vec<String> = Vec::new();
    if let Some(l) = storyline {
        facts.push(l.name.clone());
    }
    if let Some(at) = edited {
        facts.push(format::ago(at, now, cx).to_string());
    }
    if let Some(words) = words {
        facts.push(
            tf(
                cx,
                keys::dashboard::WORD_COUNT,
                &[("count", &grouped(words, locale))],
            )
            .to_string(),
        );
    }
    let summary = chapter
        .map(|c| c.summary.clone())
        .or_else(|| idea.map(|i| i.summary.clone()))
        .unwrap_or_default();
    let title = name_of(book, &first, cx);
    let card = glass::glass_box(
        "home-continue",
        GlassKind::Hidden,
        Mode::default(),
        false,
        Spec::new(ring_tone(color, p.glass_clear), radius::SM).rim(RING_RIM),
        window,
        cx,
    )
    .mx(px(-10.0))
    .px(px(10.0))
    .py(px(12.0))
    .flex()
    .flex_col()
    .gap(px(8.0))
    .cursor_pointer()
    .role(gpui::Role::Button)
    .aria_label(title.clone())
    .on_click(opener(entity.clone(), first.clone()))
    .child(
        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .min_w_0()
            .child(
                color.map_or(KindMark::new("home-continue-mark", kind), |c| {
                    KindMark::new("home-continue-mark", kind).color(c)
                }),
            )
            .child(
                div()
                    .min_w_0()
                    .truncate()
                    .font_role(Role::Ui)
                    .type_px(15.0, 20.0)
                    .weight(weight::MEDIUM)
                    .text_color(p.ink(1).solid())
                    .child(title),
            )
            .child(div().flex_1())
            .when_some(storyline, |el, l| {
                let mark = KindMark::new("home-continue-line", sand::Kind::Storyline);
                el.child(match color_of(&l.color) {
                    Some(c) => mark.color(c),
                    None => mark,
                })
            })
            .child(readout(facts.join(" · "), window, cx).flex_none()),
    )
    .when(!summary.trim().is_empty(), |el| {
        el.child(
            div()
                .font_role(Role::Prose)
                .type_px(14.0, 14.0 * 1.75)
                .text_color(p.ink(3).solid())
                .line_clamp(2)
                .child(dr_ui::text::wrapped(summary)),
        )
    });
    let others: Vec<AnyElement> = opened_more(book, stats, Some(&first))
        .into_iter()
        .map(|(target, used_ms)| {
            let (kind, color) = book.mark(&target);
            let name = name_of(book, &target, cx);
            SandCell::new(
                ElementId::Name(format!("home-recent-{}", target.key()).into()),
                name,
            )
            .mark(kind)
            .color_opt(color)
            .on_click(opener(entity.clone(), target))
            .child(
                div()
                    .flex_none()
                    .font_role(Role::Index)
                    .type_px(s.caption, s.caption * 1.45)
                    .text_color(p.muted().solid())
                    .child(format::ago(used_ms, now, cx)),
            )
            .into_any_element()
        })
        .collect();
    div()
        .flex()
        .flex_col()
        .gap(px(12.0))
        .child(head)
        .child(card)
        .when(!others.is_empty(), |el| {
            el.child(
                div()
                    .ml(px(-10.0))
                    .flex()
                    .flex_row()
                    .flex_wrap()
                    .gap_x(px(4.0))
                    .gap_y(px(2.0))
                    .children(others),
            )
        })
        .into_any_element()
}

/// The whole book: a row per storyline, then the categories.
fn book_section(
    book: &Book,
    stats: Option<&HomeStats>,
    window: &mut Window,
    cx: &mut Context<Home>,
) -> AnyElement {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let s = theme.scale;
    let locale = Settings::locale(cx);
    let graph = text_button(
        "home-story-graph",
        sand::icon(Icon::Branch, 13.0, p.ink(3).solid()).into_any_element(),
        t(cx, keys::dashboard::actions::STORY_GRAPH),
        Box::new(ToggleStoryGraph),
        window,
        cx,
    );
    let overview = text_button(
        "home-element-overview",
        KindMark::new("home-element-mark", sand::Kind::Element).into_any_element(),
        t(cx, keys::dashboard::actions::ELEMENT_OVERVIEW),
        Box::new(ToggleElementOverview),
        window,
        cx,
    );
    let head = section_head(
        t(cx, keys::project_home::book::TITLE),
        vec![graph, overview],
        window,
        cx,
    );
    let entity = cx.entity();
    let lines: AnyElement = if book.storylines.is_empty() {
        div()
            .font_role(Role::Index)
            .type_px(s.caption, s.caption * 1.45)
            .text_color(p.ink(4).solid())
            .child(t(cx, keys::project_home::book::NO_STORYLINES))
            .into_any_element()
    } else {
        let rows: Vec<AnyElement> = book
            .storylines
            .iter()
            .map(|line| {
                let color = color_of(&line.color);
                let on_line: Vec<&ChapterInfo> = book
                    .chapters
                    .iter()
                    .filter(|c| c.storylines.contains(&line.id))
                    .collect();
                let total = on_line.len();
                let done = on_line.iter().filter(|c| c.status == "finished").count();
                let words: Option<u64> = stats.map(|s| {
                    on_line
                        .iter()
                        .map(|c| s.chapter_words.get(&c.id).copied().unwrap_or(0))
                        .sum()
                });
                let mut count = tf(
                    cx,
                    keys::project_home::book::STORYLINE_COUNT,
                    &[("done", &done), ("total", &total)],
                )
                .to_string();
                if let Some(words) = words {
                    count.push_str(" · ");
                    count.push_str(&tf(
                        cx,
                        keys::project_home::WORDS,
                        &[("words", &compact(words, locale))],
                    ));
                }
                let name: SharedString = if line.name.trim().is_empty() {
                    t(cx, keys::common::UNTITLED)
                } else {
                    line.name.clone().into()
                };
                let target = line.id.parse().ok().map(Target::Storyline);
                let entity = entity.clone();
                let mark = KindMark::new(
                    ElementId::Name(format!("home-line-mark-{}", line.id).into()),
                    sand::Kind::Storyline,
                );
                let stroke = Readout::new(
                    ElementId::Name(format!("home-line-stroke-{}", line.id).into()),
                    if total == 0 {
                        0.0
                    } else {
                        done as f32 / total as f32
                    },
                );
                glass::glass_box(
                    ElementId::Name(format!("home-line-{}", line.id).into()),
                    GlassKind::Hidden,
                    Mode::default(),
                    false,
                    Spec::new(ring_tone(color, p.glass_clear), radius::SM).rim(RING_RIM),
                    window,
                    cx,
                )
                .h(px(34.0))
                .px(px(10.0))
                .flex()
                .flex_row()
                .items_center()
                .gap(px(12.0))
                .cursor_pointer()
                .role(gpui::Role::Button)
                .aria_label(name.clone())
                .on_click(move |e, _, cx| {
                    if let Some(target) = target.clone() {
                        let how = if e.click_count() > 1 {
                            Open::KEEP
                        } else {
                            Open::PREVIEW
                        };
                        entity.update(cx, |home, cx| home.open(target, how, cx));
                    }
                })
                .child(div().w(px(16.0)).flex_none().child(match color {
                    Some(c) => mark.color(c),
                    None => mark,
                }))
                .child(
                    div()
                        .flex_none()
                        .max_w(px(132.0))
                        .min_w_0()
                        .truncate()
                        .font_role(Role::Structure)
                        .type_px(s.body, s.line_body)
                        .text_color(p.ink(1).solid())
                        .child(name),
                )
                .child(div().flex_1().min_w_0().child(match color {
                    Some(c) => stroke.color(c),
                    None => stroke,
                }))
                .child(readout(count, window, cx).flex_none())
                .into_any_element()
            })
            .collect();
        div()
            .mx(px(-10.0))
            .flex()
            .flex_col()
            .children(rows)
            .into_any_element()
    };
    let mut categories: Vec<_> = book.categories.iter().collect();
    categories.sort_by(|a, b| a.name.cmp(&b.name));
    let cells: Vec<AnyElement> = categories
        .into_iter()
        .map(|category| {
            let target = category.id.parse().ok().map(Target::Category);
            let entity = entity.clone();
            SandCell::new(
                ElementId::Name(format!("home-category-{}", category.id).into()),
                SharedString::from(category.name.clone()),
            )
            .mark(sand::Kind::Category)
            .color_opt(color_of(&category.color))
            .font(Role::Structure)
            .on_click(move |e, _, cx| {
                if let Some(target) = target.clone() {
                    let how = if e.click_count() > 1 {
                        Open::KEEP
                    } else {
                        Open::PREVIEW
                    };
                    entity.update(cx, |home, cx| home.open(target, how, cx));
                }
            })
            .child(
                div()
                    .flex_none()
                    .font_role(Role::Index)
                    .type_px(s.caption, s.caption * 1.45)
                    .text_color(p.muted().solid())
                    .child(grouped(category.elements as u64, locale)),
            )
            .into_any_element()
        })
        .collect();
    div()
        .flex()
        .flex_col()
        .gap(px(12.0))
        .child(head)
        .child(lines)
        .when(!cells.is_empty(), |el| {
            el.child(
                div()
                    .ml(px(-10.0))
                    .flex()
                    .flex_row()
                    .flex_wrap()
                    .gap_x(px(4.0))
                    .gap_y(px(2.0))
                    .children(cells),
            )
        })
        .into_any_element()
}

/// 设定: the word targets (a number field each, with a dry stroke of the
/// progress towards it) and the summary.
fn settings(
    home: &mut Home,
    stats: Option<&HomeStats>,
    window: &mut Window,
    cx: &mut Context<Home>,
) -> AnyElement {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let s = theme.scale;
    let Some(stats) = stats else {
        return div().into_any_element();
    };
    let target_row = |id: &'static str,
                      label: SharedString,
                      value: i64,
                      unit: SharedString,
                      progress: Option<f32>,
                      daily: bool,
                      cx: &mut Context<Home>| {
        let entity = cx.entity();
        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(14.0))
            .child(
                div()
                    .w(px(120.0))
                    .flex_none()
                    .font_role(Role::Ui)
                    .type_px(s.body, s.line_body)
                    .text_color(p.ink(2).solid())
                    .child(label.clone()),
            )
            // The unit stands beside the field: inside it, a six-figure
            // target would scroll its first digits out of sight.
            .child(
                div().flex_none().child(
                    NumberField::new(id, value as f64, 0.0, 10_000_000.0)
                        .label(label)
                        .on_change(move |v, _, cx| {
                            entity.update(cx, |home, cx| home.set_target(daily, v, cx))
                        }),
                ),
            )
            .child(
                div()
                    .w(px(64.0))
                    .flex_none()
                    .font_role(Role::Index)
                    .type_px(s.caption, s.caption * 1.45)
                    .text_color(p.muted().solid())
                    .child(unit),
            )
            .child(div().flex_1().min_w(px(80.0)).children(progress.map(|v| {
                Readout::new(ElementId::Name(format!("{id}-stroke").into()), v).color(p.ink(2))
            })))
            .into_any_element()
    };
    let words_unit = t(cx, keys::project_picker::desk::WORDS_UNIT);
    let per_day = t(cx, keys::dashboard::plan::WORDS_PER_DAY);
    let book_row = target_row(
        "home-target",
        t(cx, keys::project_home::settings::PROJECT_TARGET),
        stats.word_target.unwrap_or(0),
        words_unit,
        dr_view_shelf::data::progress(stats.words, stats.word_target),
        false,
        cx,
    );
    let daily_row = target_row(
        "home-daily",
        t(cx, keys::project_home::settings::DAILY_GOAL),
        stats.daily_target.unwrap_or(0),
        per_day,
        dr_view_shelf::data::progress(stats.today.max(0) as u64, stats.daily_target),
        true,
        cx,
    );
    let plan = div()
        .flex()
        .flex_col()
        .gap(px(12.0))
        .child(section_head(
            t(cx, keys::dashboard::sections::WRITING_PLAN),
            Vec::new(),
            window,
            cx,
        ))
        .child(book_row)
        .child(daily_row);
    let profile = div()
        .flex()
        .flex_col()
        .gap(px(12.0))
        .child(section_head(
            t(cx, keys::dashboard::sections::PROJECT_PROFILE),
            Vec::new(),
            window,
            cx,
        ))
        .children(home.summary.clone());
    div()
        .flex()
        .flex_col()
        .gap(px(44.0))
        .child(plan)
        .child(profile)
        .into_any_element()
}
