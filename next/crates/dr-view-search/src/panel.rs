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
use dr_workspace::{Actor, NavTarget, Workspace};
use gpui::{
    App, AppContext as _, Bounds, Context, ElementId, Entity, EventEmitter, FocusHandle, Focusable,
    HighlightStyle, InteractiveElement, IntoElement, ParentElement, Render, ScrollStrategy,
    SharedString, StatefulInteractiveElement, Styled, StyledText, Subscription, Task,
    UniformListScrollHandle, Window, div, point, px, size, uniform_list,
};

use crate::model::{self, Field, Group, Jump, Line, Owner};

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
    lines: Rc<Vec<Line>>,
    hits: usize,
    /// The line the keyboard is on (a hit).
    selected: Option<usize>,
    searched: bool,
    marks: Marks,
    i18n: I18n,
    scroll: UniformListScrollHandle,
    search: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
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
            lines: Rc::default(),
            hits: 0,
            selected: None,
            searched: false,
            marks,
            i18n: I18n::new(locale, platform),
            scroll: UniformListScrollHandle::new(),
            search: None,
            _subscriptions: vec![sub],
        }
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
        self.query = text.trim().to_owned();
        if self.query.is_empty() {
            self.search = None;
            self.set_results(Vec::new(), false, cx);
            return;
        }
        let (Some(lib), book, query) = (self.lib.clone(), self.book.clone(), self.query.clone())
        else {
            return;
        };
        // A newer search drops the one still waiting or running.
        self.search = Some(cx.spawn(async move |this, cx| {
            if !wait.is_zero() {
                cx.background_executor().timer(wait).await;
            }
            let asked = query.clone();
            let hits = cx
                .background_executor()
                .spawn(async move {
                    lib.run::<Search>(
                        &Actor::User,
                        SearchIn {
                            book,
                            query,
                            limit: Some(LIMIT),
                        },
                    )
                    .map(|o| o.output)
                })
                .await;
            this.update(cx, |panel, cx| {
                if panel.query != asked {
                    return;
                }
                panel.search = None;
                match hits {
                    Ok(hits) => panel.set_results(hits, true, cx),
                    Err(error) => log::warn!("search failed: {error}"),
                }
            })
            .ok();
        }));
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
        let at = self
            .selected
            .and_then(|s| hits.iter().position(|h| *h == s))
            .unwrap_or(0) as isize;
        let next = (at + by).rem_euclid(hits.len() as isize) as usize;
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

        let groups = self.groups.clone();
        let lines = self.lines.clone();
        let selected = self.selected;
        let marks = self.marks.clone();
        let query = self.query.clone();
        let kinds: Vec<SharedString> = groups
            .iter()
            .map(|g| self.i18n.t(kind_label(g.owner)).into())
            .collect();
        let fields: Vec<Vec<SharedString>> = groups
            .iter()
            .map(|g| {
                g.rows
                    .iter()
                    .map(|r| self.i18n.t(field_label(g.owner, r.field)).into())
                    .collect()
            })
            .collect();
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
                            let (kind, color) = marks(&group.target);
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
