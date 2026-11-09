//! The search panel (components.md 「全局搜索与查找条」): a flat floating
//! sheet with the menus' shell; a single-line field with the brush's search
//! icon and the count at its end in index type; group headers are the
//! owner's sand mark and name, the count and kind in index type; every
//! header and hit is a menu row; the row the keyboard is on is the still
//! selected ring; the matched characters are deeper and heavier, never
//! filled.

use std::rc::Rc;
use std::time::Duration;

use dr_i18n::{I18n, Key, Locale, Platform, keys};
use dr_ui::{
    Theme,
    components::{
        Align, Layer, PanelIconButton, Place, float, menu::float_shadow, menu::slab_edge,
    },
    fonts::{Role, weight},
    glass::{self, Ground, Kind as GlassKind, Mode, Spec, Tone},
    input::{FieldEvent, TextField},
    sand::{self, Icon, KindMark},
    style::DrStyled,
    tokens::{Rgb, menu as m, radius},
};
use dr_workspace::commands::prose::{Search, SearchIn};
use dr_workspace::{Actor, NavTarget, Workspace, WsEvent};
use futures::StreamExt as _;
use gpui::{
    App, AppContext as _, Bounds, Context, ElementId, Entity, EventEmitter, FocusHandle, Focusable,
    HighlightStyle, InteractiveElement, IntoElement, ParentElement, Render, ScrollStrategy,
    SharedString, StatefulInteractiveElement, Styled, StyledText, Subscription, Task,
    UniformListScrollHandle, Window, div, point, px, size, uniform_list,
};

use crate::model::{self, Field, Group, Jump, Line, Owner};

#[cfg(test)]
#[path = "panel_tests.rs"]
mod tests;

/// The panel's key context.
pub const KEY_CONTEXT: &str = "DrSearch";

gpui::actions!(
    search,
    [
        /// The hit above the selected one.
        SelectPrevious,
        /// The hit below the selected one.
        SelectNext,
    ]
);

/// The panel's keys: ↑ and ↓ move through the hits while its field has the
/// keyboard. The shell binds them (`keymap::add_bindings`).
pub fn key_bindings() -> Vec<gpui::KeyBinding> {
    let c = Some(KEY_CONTEXT);
    vec![
        gpui::KeyBinding::new("up", SelectPrevious, c),
        gpui::KeyBinding::new("down", SelectNext, c),
    ]
}

/// The most hits one search reads (the count reads `N+` past it).
pub const LIMIT: usize = 500;
/// How long typing pauses before a search runs.
pub const DEBOUNCE: Duration = Duration::from_millis(90);
/// The sheet's width.
pub const WIDTH: f32 = 600.0;

/// What the panel asks of whoever shows it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SearchEvent {
    Jump(Jump),
    JumpV3(crate::v3::Jump),
    Close,
}

/// The sand mark and colour of a thing, as the shell's lists show it.
pub type Marks = Rc<dyn Fn(&NavTarget) -> (sand::Kind, Option<Rgb>)>;

pub struct SearchPanel {
    lib: Option<Workspace>,
    book: String,
    field: Entity<TextField>,
    query: String,
    groups: Rc<Vec<Group>>,
    v3: Option<V3State>,
    lines: Rc<Vec<Line>>,
    hits: usize,
    /// The line the keyboard is on (a hit).
    selected: Option<usize>,
    searched: bool,
    marks: Marks,
    i18n: I18n,
    scroll: UniformListScrollHandle,
    search: Option<Task<()>>,
    request: u64,
    _subscriptions: Vec<Subscription>,
}

struct V3State {
    /// The query that produced the displayed groups, not a pending query.
    query: String,
    groups: Rc<Vec<crate::v3::Group>>,
    marks: crate::v3::Marks,
    _subscription: Option<dr_workspace::Subscription>,
    _events: Task<()>,
}

enum Results {
    Legacy(Vec<dr_workspace::commands::prose::SearchHitInfo>),
    V3(Vec<crate::v3::Group>),
}

struct DisplayGroup {
    title: String,
    rows: Vec<model::Row>,
    mark: (sand::Kind, Option<Rgb>),
    kind: SharedString,
    fields: Vec<SharedString>,
}

impl EventEmitter<SearchEvent> for SearchPanel {}

impl Focusable for SearchPanel {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.field.focus_handle(cx)
    }
}

impl SearchPanel {
    pub fn new(
        lib: Option<Workspace>,
        book: String,
        marks: Marks,
        locale: Locale,
        platform: Platform,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> SearchPanel {
        let field = cx.new(|cx| TextField::new("search-field", window, cx).icon(Icon::Search));
        let sub = cx.subscribe(&field, |panel, _, event, cx| match event {
            FieldEvent::Changed(text) => panel.query_changed(text.clone(), cx),
            FieldEvent::Submitted(_) => panel.choose_selected(cx),
            FieldEvent::Cancelled => cx.emit(SearchEvent::Close),
            FieldEvent::Blurred => {}
        });
        SearchPanel {
            lib,
            book,
            field,
            query: String::new(),
            groups: Rc::default(),
            v3: None,
            lines: Rc::default(),
            hits: 0,
            selected: None,
            searched: false,
            marks,
            i18n: I18n::new(locale, platform),
            scroll: UniformListScrollHandle::new(),
            search: None,
            request: 0,
            _subscriptions: vec![sub],
        }
    }

    /// Version-specific host entry point. The shell handles JumpV3 directly
    /// with Target::Entry { id, module } and open_at for its optional line.
    pub fn new_v3(
        lib: Option<Workspace>,
        book: String,
        marks: crate::v3::Marks,
        locale: Locale,
        platform: Platform,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut panel = Self::new(
            lib,
            book,
            Rc::new(|_| (sand::Kind::Element, None)),
            locale,
            platform,
            window,
            cx,
        );
        let (tx, mut rx) = futures::channel::mpsc::unbounded();
        let watched_book = panel.book.clone();
        let subscription = panel.lib.as_ref().map(|lib| {
            lib.subscribe(move |event| {
                // This callback can run on a document holder. Only enqueue;
                // do not read documents or run a query on the publisher.
                if matches!(event, WsEvent::Local(c) if c.table == "index")
                    || matches!(event, WsEvent::Book(b) if b.book.as_str() == watched_book)
                {
                    let _ = tx.unbounded_send(event.clone());
                }
            })
        });
        let lib = panel.lib.clone();
        let book = panel.book.clone();
        let events = cx.spawn(async move |this, cx| {
            while let Some(first) = rx.next().await {
                let mut batch = vec![first];
                while let Ok(event) = rx.try_recv() {
                    batch.push(event);
                }
                if !this
                    .read_with(cx, |p, _| !p.query.is_empty())
                    .unwrap_or(false)
                {
                    continue;
                }
                let Some(lib) = lib.clone() else { break };
                let book = book.clone();
                let relevant = cx
                    .background_executor()
                    .spawn(async move {
                        batch.iter().any(|event| match event {
                            WsEvent::Book(b) => b.book.as_str() == book,
                            WsEvent::Local(c) if c.table == "index" => lib
                                .library()
                                .doc_info(&c.key)
                                .ok()
                                .flatten()
                                .is_some_and(|d| d.book_id.as_deref() == Some(book.as_str())),
                            _ => false,
                        })
                    })
                    .await;
                if relevant {
                    let _ = this.update(cx, |panel, cx| {
                        // Read the current query now, not the text that was
                        // current when the index event arrived.
                        panel.run_query(panel.query.clone(), Duration::ZERO, cx);
                    });
                }
            }
        });
        panel.v3 = Some(V3State {
            query: String::new(),
            groups: Rc::default(),
            marks,
            _subscription: subscription,
            _events: events,
        });
        panel
    }

    pub fn v3_groups(&self) -> Option<&[crate::v3::Group]> {
        self.v3.as_ref().map(|s| s.groups.as_slice())
    }

    pub fn focus(&self, window: &mut Window, cx: &mut App) {
        self.field.focus_handle(cx).focus(window, cx);
    }

    /// The language changed while the panel is open.
    pub fn set_locale(&mut self, locale: Locale, platform: Platform) {
        if self.i18n.locale() != locale || self.i18n.platform() != platform {
            self.i18n = I18n::new(locale, platform);
        }
    }

    pub fn groups(&self) -> &[Group] {
        &self.groups
    }

    /// The line the keyboard is on.
    pub fn selected(&self) -> Option<Line> {
        self.selected.and_then(|i| self.lines.get(i).copied())
    }

    /// Types `text` into the field and searches at once (tests, captures,
    /// a query carried over from elsewhere).
    pub fn set_query(&mut self, text: &str, cx: &mut Context<Self>) {
        self.field.update(cx, |f, cx| f.set_text(text, cx));
        self.run_query(text.to_owned(), Duration::ZERO, cx);
    }

    /// Whether a search is waiting or running.
    pub fn is_searching(&self) -> bool {
        self.search.is_some()
    }

    fn query_changed(&mut self, text: String, cx: &mut Context<Self>) {
        self.run_query(text, DEBOUNCE, cx);
    }

    fn run_query(&mut self, text: String, wait: Duration, cx: &mut Context<Self>) {
        self.request += 1;
        let request = self.request;
        self.query = text.trim().to_owned();
        if self.query.is_empty() {
            self.search = None;
            if self.v3.is_some() {
                self.set_v3_results(Vec::new(), false, cx);
            } else {
                self.set_results(Vec::new(), false, cx);
            }
            return;
        }
        let (Some(lib), book, query) = (self.lib.clone(), self.book.clone(), self.query.clone())
        else {
            return;
        };
        // A newer search drops the one still waiting or running.
        let v3 = self.v3.is_some();
        self.search = Some(cx.spawn(async move |this, cx| {
            if !wait.is_zero() {
                cx.background_executor().timer(wait).await;
            }
            let asked = query.clone();
            let asked_book = book.clone();
            let hits = cx
                .background_executor()
                .spawn(async move {
                    if v3 {
                        return crate::v3::search(&lib, &book, &query, LIMIT).map(Results::V3);
                    }
                    lib.run::<Search>(
                        &Actor::User,
                        SearchIn {
                            book,
                            query,
                            limit: Some(LIMIT),
                        },
                    )
                    .map(|o| Results::Legacy(o.output))
                })
                .await;
            this.update(cx, |panel, cx| {
                // Equal text is insufficient for A → B → A or a requery
                // after indexing. Each panel is bound to one library/book;
                // replacing it also drops its subscription and task.
                if panel.request != request || panel.query != asked || panel.book != asked_book {
                    return;
                }
                panel.search = None;
                match hits {
                    Ok(Results::Legacy(hits)) => panel.set_results(hits, true, cx),
                    Ok(Results::V3(groups)) => panel.set_v3_results(groups, true, cx),
                    Err(error) => {
                        log::warn!("search failed: {error}");
                        if v3 {
                            panel.set_v3_results(Vec::new(), false, cx);
                        }
                    }
                }
            })
            .ok();
        }));
    }

    fn set_v3_results(
        &mut self,
        groups: Vec<crate::v3::Group>,
        searched: bool,
        cx: &mut Context<Self>,
    ) {
        let Some(state) = &mut self.v3 else {
            return;
        };
        let same_query = state.query == self.query;
        if same_query && state.groups.as_slice() == groups.as_slice() {
            // An unrelated index update must not change where Enter goes or
            // schedule a scroll on the next frame.
            self.searched = searched;
            cx.notify();
            return;
        }
        let previous = self.selected.and_then(|i| match self.lines.get(i) {
            Some(Line::Hit(g, r)) if same_query => {
                Some((&state.groups[*g].target, &state.groups[*g].rows[*r]))
            }
            _ => None,
        });
        let first_results = !same_query || state.groups.is_empty();
        self.hits = groups.iter().map(|g| g.rows.len()).sum();
        let mut lines = Vec::new();
        for (g, group) in groups.iter().enumerate() {
            lines.push(Line::Header(g));
            lines.extend((0..group.rows.len()).map(|r| Line::Hit(g, r)));
        }
        self.selected = if first_results {
            lines.iter().position(|l| matches!(l, Line::Hit(..)))
        } else {
            // Row equality includes field, paragraph, snippet and match
            // range, plus the exact entry/module or material target. If a
            // changed result no longer identifies one unique hit, require
            // an explicit arrow/click instead of choosing another target.
            let mut matches = lines.iter().enumerate().filter_map(|(i, line)| {
                let Line::Hit(g, r) = *line else { return None };
                (previous == Some((&groups[g].target, &groups[g].rows[r]))).then_some(i)
            });
            let first = matches.next();
            first.filter(|_| matches.next().is_none())
        };
        self.lines = Rc::new(lines);
        let meta = (self.hits > 0).then(|| {
            SharedString::from(self.i18n.fmt(
                keys::global_search::STATS,
                &[
                    ("groups", &groups.len()),
                    (
                        "occurrences",
                        &if self.hits >= LIMIT {
                            format!("{LIMIT}+")
                        } else {
                            self.hits.to_string()
                        },
                    ),
                ],
            ))
        });
        state.groups = Rc::new(groups);
        state.query = self.query.clone();
        self.searched = searched;
        self.field.update(cx, |f, cx| f.set_meta(meta, cx));
        if first_results {
            self.scroll.scroll_to_item(0, ScrollStrategy::Top);
        } else if let Some(selected) = self.selected {
            self.scroll
                .scroll_to_item(selected, ScrollStrategy::Nearest);
        }
        cx.notify();
    }

    /// Shows `hits` (in book order).
    pub fn set_results(
        &mut self,
        hits: Vec<dr_workspace::commands::prose::SearchHitInfo>,
        searched: bool,
        cx: &mut Context<Self>,
    ) {
        self.hits = hits.len();
        let groups = model::group(hits);
        let lines = model::lines(&groups);
        self.selected = lines.iter().position(|l| matches!(l, Line::Hit(..)));
        self.groups = Rc::new(groups);
        self.lines = Rc::new(lines);
        self.searched = searched;
        let meta = (self.hits > 0).then(|| {
            let occurrences = if self.hits >= LIMIT {
                format!("{LIMIT}+")
            } else {
                self.hits.to_string()
            };
            SharedString::from(self.i18n.fmt(
                keys::global_search::STATS,
                &[
                    ("groups", &self.groups.len()),
                    ("occurrences", &occurrences),
                ],
            ))
        });
        self.field.update(cx, |f, cx| f.set_meta(meta, cx));
        self.scroll.scroll_to_item(0, ScrollStrategy::Top);
        cx.notify();
    }

    fn step(&mut self, by: isize, cx: &mut Context<Self>) {
        let hits: Vec<usize> = (0..self.lines.len())
            .filter(|i| matches!(self.lines[*i], Line::Hit(..)))
            .collect();
        if hits.is_empty() {
            return;
        }
        let next = match self
            .selected
            .and_then(|s| hits.iter().position(|h| *h == s))
        {
            Some(at) => (at as isize + by).rem_euclid(hits.len() as isize) as usize,
            None if by < 0 => hits.len() - 1,
            None => 0,
        };
        self.selected = Some(hits[next]);
        self.scroll
            .scroll_to_item(hits[next], ScrollStrategy::Nearest);
        cx.notify();
    }

    fn choose_selected(&mut self, cx: &mut Context<Self>) {
        if let Some(i) = self.selected {
            self.choose(i, cx);
        }
    }

    fn choose(&mut self, line: usize, cx: &mut Context<Self>) {
        if let Some(state) = &self.v3 {
            let jump = match self.lines.get(line) {
                Some(Line::Header(g)) => crate::v3::jump(&state.groups[*g], None),
                Some(Line::Hit(g, r)) => {
                    crate::v3::jump(&state.groups[*g], state.groups[*g].rows.get(*r))
                }
                None => return,
            };
            cx.emit(SearchEvent::JumpV3(jump));
            return;
        }
        let jump = match self.lines.get(line) {
            Some(Line::Header(g)) => model::jump(&self.groups[*g], None),
            Some(Line::Hit(g, r)) => {
                let group = &self.groups[*g];
                model::jump(group, group.rows.get(*r))
            }
            None => return,
        };
        cx.emit(SearchEvent::Jump(jump));
    }
}

fn kind_label(owner: Owner) -> Key {
    use keys::project_home::create::kinds;
    match owner {
        Owner::Chapter => kinds::CHAPTER,
        Owner::Idea => kinds::DRIFT,
        Owner::Element => kinds::ELEMENT,
        Owner::Storyline => kinds::STORYLINE,
        Owner::Category => kinds::CATEGORY,
        Owner::Material => kinds::MATERIAL,
    }
}

fn field_label(owner: Owner, field: Field) -> Key {
    use keys::global_search::field as search_field;
    match field {
        Field::Title if matches!(owner, Owner::Chapter | Owner::Idea | Owner::Material) => {
            search_field::TITLE
        }
        Field::Title => search_field::NAME,
        Field::Summary => keys::project_picker::desk::form::SUMMARY_LABEL,
        Field::Body => search_field::BODY,
        Field::Description => keys::relation_types::DESCRIPTION,
        Field::Patch => keys::references_panel::kind::PATCH,
    }
}

/// Byte range of the first case-folded match of `query` in `text`.
fn find(text: &str, query: &str) -> Option<std::ops::Range<usize>> {
    let hay: Vec<char> = text.chars().collect();
    let needle: Vec<char> = query.chars().collect();
    if needle.is_empty() || needle.len() > hay.len() {
        return None;
    }
    let fold = |c: char| c.to_lowercase().next().unwrap_or(c);
    let at = (0..=hay.len() - needle.len()).find(|&i| {
        hay[i..i + needle.len()]
            .iter()
            .zip(&needle)
            .all(|(a, b)| fold(*a) == fold(*b))
    })?;
    Some(model::char_range(text, at, needle.len()))
}

impl Render for SearchPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let viewport = window.viewport_size();
        let row_h = s.menu_row.max(s.line_body + 2.0 * m::ROW_PAD_Y);
        let max_list = (f32::from(viewport.height) * 0.62).max(row_h * 4.0);
        let list_h = (self.lines.len() as f32 * row_h).min(max_list);
        let hit_style = HighlightStyle {
            font_weight: Some(weight::SEMIBOLD),
            color: Some(p.ink(1).solid()),
            ..Default::default()
        };

        let entity = cx.entity();
        let header = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .px(px(12.0))
            .pt(px(12.0))
            .pb(px(8.0))
            .child(div().flex_1().min_w_0().child(self.field.clone()))
            .child(
                PanelIconButton::new("search-close", Icon::Close)
                    .label(self.i18n.t(keys::global_search::CLOSE_TITLE))
                    .on_click({
                        let entity = entity.clone();
                        move |_, _, cx| entity.update(cx, |_, cx| cx.emit(SearchEvent::Close))
                    }),
            );

        let groups: Vec<DisplayGroup> = if let Some(state) = &self.v3 {
            state
                .groups
                .iter()
                .map(|g| DisplayGroup {
                    title: g.title.clone(),
                    rows: g.rows.clone(),
                    mark: (state.marks)(&g.target),
                    kind: g.module_name.clone().unwrap_or_default().into(),
                    fields: g
                        .rows
                        .iter()
                        .map(|r| self.i18n.t(field_label(Owner::Material, r.field)).into())
                        .collect(),
                })
                .collect()
        } else {
            self.groups
                .iter()
                .map(|g| DisplayGroup {
                    title: g.title.clone(),
                    rows: g.rows.clone(),
                    mark: (self.marks)(&g.target),
                    kind: self.i18n.t(kind_label(g.owner)).into(),
                    fields: g
                        .rows
                        .iter()
                        .map(|r| self.i18n.t(field_label(g.owner, r.field)).into())
                        .collect(),
                })
                .collect()
        };
        let lines = self.lines.clone();
        let selected = self.selected;
        let query = self.query.clone();
        let kinds: Vec<SharedString> = groups.iter().map(|g| g.kind.clone()).collect();
        let fields: Vec<Vec<SharedString>> = groups.iter().map(|g| g.fields.clone()).collect();
        let list_entity = entity.clone();
        let list = uniform_list("search-results", lines.len(), move |range, window, cx| {
            range
                .map(|i| {
                    let line = lines[i];
                    let current = selected == Some(i);
                    let id = ElementId::Name(format!("search-line-{i}").into());
                    let row = glass::glass_box(
                        id,
                        GlassKind::Hidden,
                        Mode::default(),
                        current,
                        Spec::new(Tone::Clear, radius::MENU_ROW).rim(3.0),
                        window,
                        cx,
                    )
                    .w_full()
                    .h(px(row_h))
                    .px(px(m::ROW_PAD_X))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(m::ICON_GAP))
                    .cursor_pointer()
                    .font_role(Role::Ui)
                    .type_px(s.menu_text, s.menu_line);
                    let entity = list_entity.clone();
                    let row = row.on_click(move |_, _, cx| {
                        entity.update(cx, |panel, cx| panel.choose(i, cx))
                    });
                    let row = match line {
                        Line::Header(g) => {
                            let group = &groups[g];
                            let (kind, color) = group.mark;
                            let mut mark = KindMark::new(
                                ElementId::Name(format!("search-mark-{i}").into()),
                                kind,
                            )
                            .scale(m::ICON / sand::MARK_SLOT);
                            if let Some(c) = color {
                                mark = mark.color(c);
                            }
                            let title: SharedString = group.title.clone().into();
                            let lit: Vec<_> = find(&title, &query)
                                .map(|r| (r, hit_style))
                                .into_iter()
                                .collect();
                            row.text_color(p.ink(2).solid())
                                .child(mark)
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w_0()
                                        .overflow_hidden()
                                        .whitespace_nowrap()
                                        .text_ellipsis()
                                        .weight(weight::MEDIUM)
                                        .child(StyledText::new(title).with_highlights(lit)),
                                )
                                .child(
                                    div()
                                        .flex_none()
                                        .font_role(Role::Index)
                                        .type_px(s.caption, s.line_caption)
                                        .text_color(p.ink(3).solid())
                                        .child(format!("{}  {}", group.rows.len(), kinds[g])),
                                )
                        }
                        Line::Hit(g, r) => {
                            let hit = &groups[g].rows[r];
                            let text: SharedString = hit.snippet.clone().into();
                            let lit = if hit.highlight.is_empty() {
                                Vec::new()
                            } else {
                                vec![(hit.highlight.clone(), hit_style)]
                            };
                            row.text_color(p.ink(2).solid())
                                .child(div().flex_none().w(px(m::ICON)).h(px(1.0)))
                                .child(
                                    div()
                                        .flex_none()
                                        .w(px(48.0))
                                        .overflow_hidden()
                                        .whitespace_nowrap()
                                        .font_role(Role::Index)
                                        .type_px(s.caption, s.line_caption)
                                        .text_color(p.ink(3).solid())
                                        .child(fields[g][r].clone()),
                                )
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w_0()
                                        .overflow_hidden()
                                        .whitespace_nowrap()
                                        .text_ellipsis()
                                        .child(StyledText::new(text).with_highlights(lit)),
                                )
                        }
                    };
                    div().w_full().px(px(m::ROW_INSET)).child(row)
                })
                .collect::<Vec<_>>()
        })
        .track_scroll(&self.scroll)
        .w_full()
        .h(px(list_h));

        let body = if !self.lines.is_empty() {
            div().pb(px(m::PAD_Y)).child(list).into_any_element()
        } else if self.searched && !self.query.is_empty() {
            div()
                .px(px(m::ROW_INSET + m::ROW_PAD_X))
                .pb(px(14.0))
                .font_role(Role::Ui)
                .type_px(s.secondary, s.line_body)
                .text_color(p.muted().solid())
                .child(self.i18n.t(keys::global_search::NO_RESULTS))
                .into_any_element()
        } else {
            div().into_any_element()
        };

        let close = entity.clone();
        let sheet = div()
            .id("search-panel")
            .key_context(KEY_CONTEXT)
            .occlude()
            .relative()
            .w(px(WIDTH.min(f32::from(viewport.width) - 32.0)))
            .rounded(px(radius::SHEET))
            .bg(p.desk.solid())
            .shadow(float_shadow(p))
            .child(slab_edge(p, radius::SHEET))
            // The arrows move through the hits while the field has focus
            // ([`key_bindings`]; the shell keeps them in its keymap).
            .on_action(cx.listener(|panel, _: &SelectPrevious, _, cx| panel.step(-1, cx)))
            .on_action(cx.listener(|panel, _: &SelectNext, _, cx| panel.step(1, cx)))
            .on_mouse_down_out(move |_, _, cx| {
                close.update(cx, |_, cx| cx.emit(SearchEvent::Close))
            })
            .child(header)
            .child(body);
        // Centred near the top, like the 0.1 client's search: below a band
        // a seventh of the window high.
        let band = Bounds {
            origin: point(px(0.0), px(0.0)),
            size: size(viewport.width, viewport.height * 0.14),
        };
        float(
            Place::Rect {
                rect: band,
                align: Align::Center,
                gap: 0.0,
            },
            Layer::Dialog,
            glass::surface(Ground::flat(p.desk), sheet),
        )
    }
}
