//! 「0.1 的旧对话」 (2026-11-21, the author chose 三甲, 四甲 and 五甲; see
//! `m31-agent-panel.md`): the 0.1 conversations an import archived beside
//! this library, read through `dr_import_v1::agent_archive`.
//!
//! - 「历史」 lists this book's new conversations, then a section headed
//!   「Drifting 0.1」 (the import dialog's eyebrow, never translated) with its
//!   count, folding like the material library's sections, listing the
//!   book's 0.1 conversations newest first. The section is there only when
//!   this library has an archive with conversations of this book; the
//!   archive is beside the library on the device that imported, so the
//!   conversations follow their book and only on that device.
//! - An opened old conversation is read only: the head is the back arrow
//!   and its title, then 「Drifting 0.1 · date」, then its turns; there is no
//!   input block. A tool call is one grey line with the 0.1 tool's name.
//! - One search box at the top of 「历史」, without placeholder text (the
//!   book search has none), searches the titles and what the author and
//!   the Agent wrote, new and old together, off the main thread; a new
//!   query cancels the one before. Pressing a hit opens that conversation;
//!   an old one opens at the turn the hit is in.
//!
//! Nothing of a conversation goes to a log.

use std::{
    ops::Range,
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

use dr_i18n::keys;
use dr_import_v1::agent_archive::{self as archive, Archive, Conversation, Matches, Speaker, Turn};
use dr_ui::{
    components::IconButton,
    fonts::weight,
    input::{FieldEvent, TextField},
    sand::Icon,
    tokens::radius,
};
use gpui::{HighlightStyle, ListAlignment, ListOffset, ListState, StyledText, list};

use super::*;
use crate::controller::AgentController;

/// The import dialog's eyebrow (`dr-view-import`), never translated.
pub const EYEBROW: &str = "Drifting 0.1";
/// How long typing pauses before a search runs (the book search's).
const DEBOUNCE: Duration = Duration::from_millis(90);
/// The text kept before and after the query in a hit's line.
const BEFORE: usize = 12;
const AFTER: usize = 16;

pub(super) struct Old {
    /// The book `list` is for; set when its reading starts.
    book: Option<BookId>,
    list: Option<std::rc::Rc<Vec<Conversation>>>,
    reading: bool,
    generation: u64,
    collapsed: bool,
    opened: Option<Opened>,
    opening: u64,
    field: Entity<TextField>,
    query: String,
    results: Option<std::rc::Rc<Results>>,
    searching: Option<Task<()>>,
    cancel: Arc<AtomicBool>,
    request: u64,
}

struct Opened {
    conversation: Conversation,
    turns: Option<std::rc::Rc<Vec<Turn>>>,
    list: ListState,
    /// The turn a search hit is in, to open at.
    reveal: Option<usize>,
    serial: u64,
}

/// A search's hits, new conversations first, each group in the list's order.
pub struct Results {
    pub query: String,
    pub new: Vec<(ConversationId, String, Matches)>,
    pub old: Vec<archive::Found>,
}

impl Results {
    fn occurrences(&self) -> usize {
        self.new.iter().map(|(.., m)| m.occurrences).sum::<usize>()
            + self
                .old
                .iter()
                .map(|f| f.matches.occurrences)
                .sum::<usize>()
    }
}

impl Old {
    pub(super) fn new(window: &mut Window, cx: &mut Context<AgentPanel>) -> (Self, Subscription) {
        let field =
            cx.new(|cx| TextField::new("agent-history-search", window, cx).icon(Icon::Search));
        let sub = cx.subscribe(&field, |panel, field, event, cx| match event {
            FieldEvent::Changed(text) => panel.history_query(text.clone(), DEBOUNCE, cx),
            FieldEvent::Cancelled if !field.read(cx).text().is_empty() => {
                field.update(cx, |f, cx| f.set_text("", cx));
                panel.history_query(String::new(), Duration::ZERO, cx);
            }
            _ => {}
        });
        (
            Self {
                book: None,
                list: None,
                reading: false,
                generation: 0,
                collapsed: false,
                opened: None,
                opening: 0,
                field,
                query: String::new(),
                results: None,
                searching: None,
                cancel: Arc::default(),
                request: 0,
            },
            sub,
        )
    }

    pub(super) fn is_open(&self) -> bool {
        self.opened.is_some()
    }

    /// Another conversation is shown: the old one closes.
    pub(super) fn leave(&mut self) {
        self.opened = None;
    }

    pub(super) fn settled(&self) -> bool {
        !self.reading
            && self.searching.is_none()
            && self.opened.as_ref().is_none_or(|o| o.turns.is_some())
    }
}

/// The library folder the controller's workspace is in.
fn library_root(controller: &AgentController) -> Option<PathBuf> {
    controller
        .with_workspace_read(|ws| Ok(ws.library().paths().root.clone()))
        .ok()
}

/// `None` (no section) when there is no archive or it cannot be read; the
/// log says why, without a word of a conversation.
fn open_archive(controller: &AgentController) -> Option<Archive> {
    match Archive::open(&library_root(controller)?) {
        Ok(archive) => archive,
        Err(error) => {
            log::warn!("the 0.1 Agent conversations could not be read: {error}");
            None
        }
    }
}

/// Where a query is in the new conversations, in the list's order.
fn search_new(
    controller: &AgentController,
    book: &BookId,
    conversations: Vec<(ConversationId, String)>,
    query: &str,
    cancel: &AtomicBool,
) -> Option<Vec<(ConversationId, String, Matches)>> {
    let mut found = Vec::new();
    for (id, title) in conversations {
        if cancel.load(Ordering::Relaxed) {
            return None;
        }
        let Ok(snapshot) = controller.snapshot(book, &id) else {
            continue;
        };
        let mut turns = Vec::new();
        for (i, message) in snapshot.messages.iter().enumerate() {
            match &message.content {
                MessageContent::User { text, .. } => turns.push((i, Speaker::User, text.as_str())),
                MessageContent::Assistant { message } => {
                    for block in &message.blocks {
                        if let ContentBlock::Text { text, .. } = block {
                            turns.push((i, Speaker::Agent, text.as_str()));
                        }
                    }
                }
                _ => {}
            }
        }
        if let Some(matches) = archive::find_in(&title, turns, query) {
            found.push((id, title, matches));
        }
    }
    Some(found)
}

/// What a new conversation is called in the list.
fn new_title(item: &ConversationSummary) -> String {
    dr_shell::review_agent::clean_conversation_title(&item.title).to_owned()
}

/// The local date of a 0.1 conversation's last change.
fn date(ms: Option<i64>) -> Option<String> {
    let at = chrono::DateTime::from_timestamp_millis(ms?)?;
    Some(
        at.with_timezone(&chrono::Local)
            .format("%Y-%m-%d")
            .to_string(),
    )
}

/// The line of a hit: some text around the first place the query is, with
/// every place it is in that line.
fn snippet(text: &str, at: &Range<usize>, query: &str) -> (String, Vec<Range<usize>>) {
    let line: String = text
        .chars()
        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
        .collect();
    let start = line[..at.start]
        .char_indices()
        .rev()
        .nth(BEFORE - 1)
        .map_or(0, |(i, _)| i);
    let end = line[at.end..]
        .char_indices()
        .nth(AFTER)
        .map_or(line.len(), |(i, _)| at.end + i);
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    let offset = out.len();
    out.push_str(&line[start..end]);
    if end < line.len() {
        out.push('…');
    }
    let hits = archive::find_all(&out[offset..], query)
        .into_iter()
        .map(|r| r.start + offset..r.end + offset)
        .collect();
    (out, hits)
}

struct Row {
    selector: String,
    title: SharedString,
    hits: Vec<Range<usize>>,
    line: Option<(SharedString, String, Vec<Range<usize>>)>,
}

impl AgentPanel {
    /// Reads this book's 0.1 conversations once per book and library.
    pub(super) fn load_old(&mut self, cx: &mut Context<Self>) {
        let (Some(controller), Some(book)) = (self.controller.clone(), self.book.clone()) else {
            return;
        };
        if self.old.book.as_ref() == Some(&book) || controller.is_closed() {
            return;
        }
        self.old.book = Some(book.clone());
        self.old.list = None;
        self.old.reading = true;
        let generation = self.old.generation;
        cx.spawn(async move |this, cx| {
            let list = cx
                .background_executor()
                .spawn(async move {
                    open_archive(&controller)
                        .and_then(|archive| match archive.conversations(book.as_str()) {
                            Ok(list) => Some(list),
                            Err(error) => {
                                log::warn!(
                                    "the 0.1 Agent conversations could not be listed: {error}"
                                );
                                None
                            }
                        })
                        .unwrap_or_default()
                })
                .await;
            let _ = this.update(cx, |panel, cx| {
                if panel.old.generation != generation {
                    return;
                }
                panel.old.reading = false;
                panel.old.list = Some(std::rc::Rc::new(list));
                cx.notify();
            });
        })
        .detach();
    }

    /// Forgets the list read for a book (another book or library).
    pub(super) fn forget_old_list(&mut self) {
        self.old.generation += 1;
        self.old.book = None;
        self.old.list = None;
        self.old.reading = false;
    }

    /// Another book: nothing of the last one's history stays.
    pub(super) fn reset_old(&mut self, cx: &mut Context<Self>) {
        self.forget_old_list();
        self.old.opened = None;
        self.old.collapsed = false;
        self.old.field.update(cx, |f, cx| {
            f.set_text("", cx);
            f.set_meta(None, cx);
        });
        self.history_query(String::new(), Duration::ZERO, cx);
    }

    /// This book's 0.1 conversations, newest first; `None` until read.
    pub fn old_conversations(&self) -> Option<&[Conversation]> {
        self.old.list.as_deref().map(Vec::as_slice)
    }

    /// The 0.1 conversation shown read only, and its turns once read.
    pub fn old_conversation(&self) -> Option<(&Conversation, Option<&[Turn]>)> {
        self.old
            .opened
            .as_ref()
            .map(|o| (&o.conversation, o.turns.as_deref().map(Vec::as_slice)))
    }

    /// The first item the opened old conversation's list shows (0 is
    /// 「Drifting 0.1 · date」, then one per turn).
    pub fn old_scroll_top(&self) -> Option<usize> {
        self.old
            .opened
            .as_ref()
            .map(|o| o.list.logical_scroll_top().item_ix)
    }

    /// The search box at the top of 「历史」.
    pub fn history_search(&self) -> Entity<TextField> {
        self.old.field.clone()
    }

    /// The hits of the last search that finished.
    pub fn history_results(&self) -> Option<&Results> {
        self.old.results.as_deref()
    }

    pub fn history_shown(&self) -> bool {
        self.show_list && self.old.opened.is_none()
    }

    /// 「历史」, as its button opens and closes it.
    pub fn show_history(&mut self, show: bool, cx: &mut Context<Self>) {
        self.show_list = show;
        self.old.opened = None;
        self.refresh(cx);
        cx.notify();
    }

    /// Types `text` into the search box and searches at once.
    pub fn set_history_query(&mut self, text: &str, cx: &mut Context<Self>) {
        self.old.field.update(cx, |f, cx| f.set_text(text, cx));
        self.history_query(text.to_owned(), Duration::ZERO, cx);
    }

    /// Opens the listed 0.1 conversation `id`; `false` when it is not listed.
    pub fn open_old_conversation(&mut self, id: &str, cx: &mut Context<Self>) -> bool {
        let Some(conversation) = self
            .old
            .list
            .as_ref()
            .and_then(|list| list.iter().find(|c| c.id == id).cloned())
        else {
            return false;
        };
        self.open_old(conversation, None, cx);
        true
    }

    fn open_old(
        &mut self,
        conversation: Conversation,
        reveal: Option<usize>,
        cx: &mut Context<Self>,
    ) {
        let (Some(controller), Some(book)) = (self.controller.clone(), self.book.clone()) else {
            return;
        };
        self.old.opening += 1;
        let serial = self.old.opening;
        self.expanded.retain(|key| !key.starts_with("old:"));
        self.old.opened = Some(Opened {
            conversation: conversation.clone(),
            turns: None,
            list: ListState::new(1, ListAlignment::Top, px(600.)),
            reveal,
            serial,
        });
        cx.spawn(async move |this, cx| {
            let turns = cx
                .background_executor()
                .spawn(async move {
                    let archive = open_archive(&controller)?;
                    match archive.turns(book.as_str(), &conversation) {
                        Ok(turns) => turns,
                        Err(error) => {
                            log::warn!("a 0.1 Agent conversation could not be read: {error}");
                            None
                        }
                    }
                })
                .await
                .unwrap_or_default();
            let _ = this.update(cx, |panel, cx| {
                let Some(opened) = panel.old.opened.as_mut().filter(|o| o.serial == serial) else {
                    return;
                };
                opened.list.reset(turns.len() + 1);
                if let Some(turn) = opened.reveal.filter(|t| *t < turns.len()) {
                    opened.list.scroll_to(ListOffset {
                        item_ix: turn + 1,
                        offset_in_item: px(0.),
                    });
                }
                opened.turns = Some(std::rc::Rc::new(turns));
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    /// Back from an old conversation to 「历史」 as it was.
    pub fn close_old(&mut self, cx: &mut Context<Self>) {
        self.old.opened = None;
        self.show_list = true;
        cx.notify();
    }

    fn history_query(&mut self, text: String, wait: Duration, cx: &mut Context<Self>) {
        self.old.request += 1;
        let request = self.old.request;
        self.old.cancel.store(true, Ordering::Relaxed);
        self.old.cancel = Arc::default();
        self.old.query = text.trim().to_owned();
        if self.old.query.is_empty() {
            self.old.searching = None;
            self.old.results = None;
            self.old.field.update(cx, |f, cx| f.set_meta(None, cx));
            cx.notify();
            return;
        }
        let (Some(controller), Some(book)) = (self.controller.clone(), self.book.clone()) else {
            self.old.searching = None;
            return;
        };
        let news: Vec<(ConversationId, String)> = self
            .conversations
            .iter()
            .map(|item| (item.id.clone(), new_title(item)))
            .collect();
        let (query, cancel) = (self.old.query.clone(), self.old.cancel.clone());
        // A newer query drops this one, waiting or running.
        self.old.searching = Some(cx.spawn(async move |this, cx| {
            if !wait.is_zero() {
                cx.background_executor().timer(wait).await;
            }
            let asked = query.clone();
            let results = cx
                .background_executor()
                .spawn(async move {
                    let new = search_new(&controller, &book, news, &query, &cancel)?;
                    let old = match open_archive(&controller)
                        .map(|archive| archive.search(book.as_str(), &query, &cancel))
                    {
                        None => Vec::new(),
                        Some(Ok(found)) => found,
                        Some(Err(archive::Error::Cancelled)) => return None,
                        Some(Err(error)) => {
                            log::warn!(
                                "the 0.1 Agent conversations could not be searched: {error}"
                            );
                            Vec::new()
                        }
                    };
                    Some(Results { query, new, old })
                })
                .await;
            let _ = this.update(cx, |panel, cx| {
                if panel.old.request != request || panel.old.query != asked {
                    return;
                }
                panel.old.searching = None;
                let Some(results) = results else {
                    return;
                };
                let groups = results.new.len() + results.old.len();
                let meta = (groups > 0).then(|| {
                    tf(
                        cx,
                        keys::global_search::STATS,
                        &[("groups", &groups), ("occurrences", &results.occurrences())],
                    )
                });
                panel.old.field.update(cx, |f, cx| f.set_meta(meta, cx));
                panel.old.results = Some(std::rc::Rc::new(results));
                cx.notify();
            });
        }));
        cx.notify();
    }

    fn hit_style(&self, window: &Window, cx: &App) -> HighlightStyle {
        HighlightStyle {
            font_weight: Some(weight::SEMIBOLD),
            color: Some(Theme::of(window, cx).palette.ink(1).solid()),
            ..Default::default()
        }
    }

    fn row(
        &self,
        row: Row,
        on_click: impl Fn(&mut Self, &mut Window, &mut Context<Self>) + 'static,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let hit = self.hit_style(window, cx);
        let lit = |hits: Vec<Range<usize>>| hits.into_iter().map(move |r| (r, hit));
        let selector = row.selector.clone();
        div()
            .id(SharedString::from(row.selector))
            .debug_selector(move || selector)
            .role(gpui::Role::Button)
            .aria_label(row.title.clone())
            .w_full()
            .min_w_0()
            .flex()
            .flex_col()
            .gap(px(2.))
            .px(px(6.))
            .py(px(5.))
            .rounded(px(radius::SM))
            .cursor_pointer()
            .text_color(p.ink(2).solid())
            .hover(move |st| st.bg(p.ink(1).alpha(0.04)).text_color(p.ink(1).solid()))
            .child(
                div()
                    .min_w_0()
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .text_ellipsis()
                    .child(StyledText::new(row.title).with_highlights(lit(row.hits))),
            )
            .when_some(row.line, |el, (who, text, hits)| {
                el.child(
                    div()
                        .flex()
                        .gap(px(8.))
                        .min_w_0()
                        .type_px(s.caption, s.line_caption)
                        .child(
                            div()
                                .flex_none()
                                .font_role(Role::Index)
                                .text_color(p.ink(4).solid())
                                .child(who),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .overflow_hidden()
                                .whitespace_nowrap()
                                .text_ellipsis()
                                .text_color(p.ink(3).solid())
                                .child(StyledText::new(text).with_highlights(lit(hits))),
                        ),
                )
            })
            .on_click(cx.listener(move |panel, _, window, cx| on_click(panel, window, cx)))
            .into_any_element()
    }

    /// The section's head: 「Drifting 0.1」 and its count; it folds the
    /// listing (as the material library's sections do), a search's is still.
    fn section(
        &self,
        count: usize,
        folds: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let collapsed = self.old.collapsed;
        div()
            .id("agent-history-old")
            .debug_selector(|| "agent-history-old".into())
            .role(if folds {
                gpui::Role::Button
            } else {
                gpui::Role::Heading
            })
            .aria_label(EYEBROW)
            .when(folds, |el| el.aria_expanded(!collapsed))
            .mt(px(10.))
            .h(px(24.))
            .px(px(6.))
            .rounded(px(radius::SM))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(5.))
            .child(
                div()
                    .font_role(Role::Ui)
                    .type_px(s.caption, s.line_caption)
                    .weight(weight::MEDIUM)
                    .text_color(p.ink(3).solid())
                    .child(EYEBROW),
            )
            .child(
                div()
                    .font_role(Role::Index)
                    .type_px(s.caption, s.line_caption)
                    .text_color(p.ink(4).solid())
                    .child(count.to_string()),
            )
            .when(folds, |el| {
                el.cursor_pointer()
                    .hover(move |st| st.bg(p.ink(1).alpha(0.04)))
                    .child(div().flex_1())
                    .child(sand::icon(
                        if collapsed {
                            Icon::ChevronRight
                        } else {
                            Icon::ChevronDown
                        },
                        11.,
                        p.ink(4).solid(),
                    ))
                    .on_click(cx.listener(|panel, _, _, cx| {
                        panel.old.collapsed = !panel.old.collapsed;
                        cx.notify();
                    }))
            })
            .into_any_element()
    }

    /// 「历史」: the search box, the new conversations, the 0.1 section.
    pub(super) fn history(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let mut column = div().flex().flex_col().gap(px(1.)).min_w_0().child(
            div()
                .debug_selector(|| "agent-history-search".into())
                .mb(px(6.))
                .child(self.old.field.clone()),
        );
        let untitled = t(cx, k::history::UNTITLED);
        let who = |speaker: Speaker, cx: &App| {
            t(
                cx,
                match speaker {
                    Speaker::User => k::working_memory::AUTHOR,
                    Speaker::Agent => k::working_memory::AGENT,
                },
            )
        };
        let line = |m: &Matches, query: &str, cx: &App| {
            m.first.as_ref().map(|hit| {
                let (text, hits) = snippet(&hit.text, &hit.at, query);
                (who(hit.speaker, cx), text, hits)
            })
        };
        if let Some(results) = self
            .old
            .results
            .clone()
            .filter(|_| !self.old.query.is_empty())
        {
            if results.new.is_empty() && results.old.is_empty() {
                return column
                    .child(
                        div()
                            .debug_selector(|| "agent-history-none".into())
                            .px(px(6.))
                            .text_color(Theme::of(window, cx).palette.ink(4).solid())
                            .child(t(cx, keys::global_search::NO_RESULTS)),
                    )
                    .into_any_element();
            }
            for (id, title, matches) in &results.new {
                let (title, hits) = if title.is_empty() {
                    (untitled.clone(), Vec::new())
                } else {
                    (title.clone().into(), matches.title.clone())
                };
                let id = id.clone();
                let row = Row {
                    selector: format!("agent-history-new-{id}"),
                    title,
                    hits,
                    line: line(matches, &results.query, cx),
                };
                column = column.child(self.row(
                    row,
                    move |panel, _, cx| panel.select_conversation(id.clone(), cx),
                    window,
                    cx,
                ));
            }
            if !results.old.is_empty() {
                column = column.child(self.section(results.old.len(), false, window, cx));
                for found in &results.old {
                    let (title, hits) = if found.conversation.title.is_empty() {
                        (untitled.clone(), Vec::new())
                    } else {
                        (
                            found.conversation.title.clone().into(),
                            found.matches.title.clone(),
                        )
                    };
                    let conversation = found.conversation.clone();
                    let reveal = found.matches.first.as_ref().map(|hit| hit.turn);
                    let row = Row {
                        selector: format!("agent-history-old-{}", conversation.id),
                        title,
                        hits,
                        line: line(&found.matches, &results.query, cx),
                    };
                    column = column.child(self.row(
                        row,
                        move |panel, _, cx| panel.open_old(conversation.clone(), reveal, cx),
                        window,
                        cx,
                    ));
                }
            }
            return column.into_any_element();
        }
        let old = self.old.list.clone().unwrap_or_default();
        if self.conversations.is_empty() && old.is_empty() {
            return column.child(t(cx, k::history::EMPTY)).into_any_element();
        }
        let items: Vec<(ConversationId, String, bool, bool, i64)> = self
            .conversations
            .iter()
            .map(|item| {
                (
                    item.id.clone(),
                    new_title(item),
                    self.selected.as_ref() == Some(&item.id),
                    !item.active.is_empty(),
                    item.last_created_ms,
                )
            })
            .collect();
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        for (id, title, is_current, is_running, last_ms) in items {
            let display_title: SharedString = if title.is_empty() {
                untitled.clone()
            } else {
                title.clone().into()
            };
            let date_label = (last_ms > 0).then(|| date(Some(last_ms))).flatten();
            let open_id = id.clone();
            let rename_id = id.clone();
            let rename_title = title.clone();
            let delete_id = id.clone();
            let selector = format!("agent-history-new-{id}");
            column = column.child(
                div()
                    .id(SharedString::from(selector.clone()))
                    .debug_selector(move || selector)
                    .w_full()
                    .min_w_0()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(4.0))
                    .px(px(6.))
                    .py(px(5.))
                    .rounded(px(radius::SM))
                    .when(is_current, |el| el.bg(p.accent.alpha(0.08)))
                    .hover(move |st| st.bg(p.ink(1).alpha(0.05)))
                    .child(
                        div()
                            .id(SharedString::from(format!("agent-history-open-{id}")))
                            .flex_1()
                            .min_w_0()
                            .cursor_pointer()
                            .role(gpui::Role::Button)
                            .aria_label(display_title.clone())
                            .flex()
                            .flex_col()
                            .gap(px(1.0))
                            .on_click(cx.listener(move |panel, _, _, cx| {
                                panel.select_conversation(open_id.clone(), cx)
                            }))
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(5.0))
                                    .min_w_0()
                                    .when(is_running, |el| {
                                        el.child(
                                            div()
                                                .flex_none()
                                                .size(px(6.0))
                                                .rounded_full()
                                                .bg(p.accent.solid()),
                                        )
                                    })
                                    .child(
                                        div()
                                            .flex_1()
                                            .min_w_0()
                                            .truncate()
                                            .text_color(if is_current {
                                                p.ink(1).solid()
                                            } else {
                                                p.ink(2).solid()
                                            })
                                            .child(display_title),
                                    ),
                            )
                            .when_some(date_label, |el, d| {
                                el.child(
                                    div()
                                        .font_role(Role::Index)
                                        .type_px(s.caption, s.line_caption)
                                        .text_color(p.ink(4).solid())
                                        .child(d),
                                )
                            }),
                    )
                    .child(
                        IconButton::new(
                            SharedString::from(format!("agent-history-rename-{id}")),
                            Icon::Edit,
                        )
                        .label(t(cx, k::history::RENAME))
                        .on_click(cx.listener(
                            move |panel, _, window, cx| {
                                panel.begin_rename(
                                    rename_id.clone(),
                                    rename_title.clone(),
                                    window,
                                    cx,
                                );
                            },
                        )),
                    )
                    .child(
                        IconButton::new(
                            SharedString::from(format!("agent-history-delete-{id}")),
                            Icon::Trash,
                        )
                        .label(t(cx, k::history::DELETE))
                        .on_click(cx.listener(move |panel, _, _, cx| {
                            panel.delete_conversation(delete_id.clone(), cx);
                        })),
                    ),
            );
        }
        if !old.is_empty() {
            column = column.child(self.section(old.len(), true, window, cx));
            if !self.old.collapsed {
                for conversation in old.iter() {
                    let row = Row {
                        selector: format!("agent-history-old-{}", conversation.id),
                        title: if conversation.title.is_empty() {
                            untitled.clone()
                        } else {
                            conversation.title.clone().into()
                        },
                        hits: Vec::new(),
                        line: None,
                    };
                    let conversation = conversation.clone();
                    column = column.child(self.row(
                        row,
                        move |panel, _, cx| panel.open_old(conversation.clone(), None, cx),
                        window,
                        cx,
                    ));
                }
            }
        }
        column.into_any_element()
    }

    /// An opened 0.1 conversation: 「Drifting 0.1 · date」, then its turns,
    /// in a list that lays out only what is on screen.
    pub(super) fn old_transcript(&mut self, _: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let Some(opened) = &self.old.opened else {
            return div().into_any_element();
        };
        let state = opened.list.clone();
        let panel = cx.entity().downgrade();
        div()
            .id("agent-old-transcript")
            .debug_selector(|| "agent-old-transcript".into())
            .flex_1()
            .min_h_0()
            .child(
                list(state, move |ix, window, cx| {
                    panel
                        .upgrade()
                        .map(|panel| panel.update(cx, |panel, cx| panel.old_item(ix, window, cx)))
                        .unwrap_or_else(|| div().into_any_element())
                })
                .size_full(),
            )
            .into_any_element()
    }

    fn old_item(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let Some(opened) = &self.old.opened else {
            return div().into_any_element();
        };
        let item = div().px(px(14.)).pb(px(18.)).min_w_0();
        if ix == 0 {
            let eyebrow = match date(opened.conversation.updated_ms) {
                Some(date) => format!("{EYEBROW} · {date}"),
                None => EYEBROW.to_owned(),
            };
            return item
                .pt(px(14.))
                .debug_selector(|| "agent-old-eyebrow".into())
                .font_role(Role::Index)
                .type_px(s.caption, s.line_caption)
                .text_color(p.ink(3).solid())
                .child(eyebrow)
                .into_any_element();
        }
        let Some(turn) = opened.turns.as_ref().and_then(|t| t.get(ix - 1)).cloned() else {
            return item.into_any_element();
        };
        let id = format!("agent-old-turn-{}", ix - 1);
        let item = item.id(SharedString::from(id.clone())).debug_selector({
            let id = id.clone();
            move || id
        });
        match turn {
            Turn::User(text) => item
                .child(
                    div()
                        .p(px(12.))
                        .rounded(px(12.))
                        .bg(p.paper.solid())
                        .child(text::wrapped(text)),
                )
                .into_any_element(),
            Turn::Agent(text) => item.child(text::wrapped(text)).into_any_element(),
            // One grey line with the 0.1 tool's name: no result, no
            // 「本轮改动」, nothing to press (what it touched may be gone).
            Turn::Tool(name) => item
                .font_role(Role::Index)
                .type_px(s.caption, s.line_caption)
                .text_color(p.ink(3).solid())
                .child(name)
                .into_any_element(),
            Turn::Thinking(text) => {
                let key = format!("old:{}:thinking:{}", opened.conversation.id, ix - 1);
                let open = self.expanded.contains(&key);
                let label = t(cx, k::thinking::DONE);
                item.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(6.))
                        .child(
                            self.disclosure(key.clone(), label.clone(), window, cx)
                                .flex()
                                .items_center()
                                .gap(px(7.))
                                .text_color(p.ink(3).solid())
                                .child(sand::thinking(16., p.ink(3).solid(), false, window))
                                .child(label),
                        )
                        .when(open, |el| {
                            el.child(
                                div()
                                    .text_color(p.ink(3).solid())
                                    .child(text::wrapped(text)),
                            )
                        }),
                )
                .into_any_element()
            }
            Turn::Error(text) => item
                .text_color(p.danger.solid())
                .child(text::wrapped(text))
                .into_any_element(),
        }
    }
}

/// The head of an opened old conversation: the back arrow and its title.
pub(super) fn head(
    panel: &Entity<AgentPanel>,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let title = {
        let state = panel.read(cx);
        let opened = state.old.opened.as_ref()?;
        opened.conversation.title.clone()
    };
    let title: SharedString = if title.is_empty() {
        t(cx, k::history::UNTITLED)
    } else {
        title.into()
    };
    let back = panel.clone();
    Some(
        div()
            .flex()
            .items_center()
            .gap(px(8.))
            .w_full()
            .min_w_0()
            .child(
                IconButton::new("agent-old-back", Icon::ArrowBack)
                    .label(t(cx, keys::auth::BACK))
                    .on_click(move |_, _, cx| back.update(cx, |p, cx| p.close_old(cx))),
            )
            .child(
                div()
                    .debug_selector(|| "agent-old-title".into())
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_color(Theme::of(window, cx).palette.ink(1).solid())
                    .child(title),
            )
            .into_any_element(),
    )
}
