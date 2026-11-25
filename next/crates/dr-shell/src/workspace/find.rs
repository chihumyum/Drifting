//! The find bar over the page (⌘F / Ctrl+F; the 0.1 client's `findPanel`):
//! a glass bar at the paper's top right with the query, where the current
//! match stands (「3 / 12」), and previous, next and close.
//!
//! Finding itself is F4c's ([`gpui_prose::ProseEditor::set_find`] and the
//! steps): typing sets the query and selects the first match at or after
//! the caret; Enter and ⌘G go to the next, ⇧Enter and ⇧⌘G to the previous
//! (F3 and ⇧F3 on Windows); Esc closes the bar, drops the query and gives
//! the page the keyboard back. In a chapter it looks in that chapter; in
//! the whole book (M05) in every chapter. The current match is the
//! selection, so the editor scrolls to it; drawing every match is F4d's
//! highlight layer. ⌘E in the editor ("use the selection for find") fills
//! the bar.
//!
//! Replace (⌥⌘F / Ctrl+H, or the bar's swap button) opens a second row: the
//! replacement, 替换 (the current match, then on to the next) and 全部替换
//! (every match of the scope; one undo step per chapter). Enter in that
//! field replaces the current match.

use dr_i18n::keys;
use dr_ui::{
    Theme,
    components::{Button, IconButton},
    fonts::Role,
    glass::{self, Ground, Kind, Mode, Spec, Tone},
    input::field::{FieldEvent, TextField},
    sand::Icon,
    style::DrStyled,
    tokens::{glass as g, radius},
};
use gpui::{
    AppContext as _, Context, ElementId, Entity, EventEmitter, Focusable as _, InteractiveElement,
    IntoElement, KeyBinding, ParentElement, Render, SharedString, StatefulInteractiveElement as _,
    Styled, Subscription, Window, div, prelude::FluentBuilder as _, px,
};
use gpui_prose::ProseEditor;
use gpui_prose::input::find::{FindEvent, FindOptions, FindScope, FindStatus};

use crate::strings::t;

/// The bar's key context.
pub const KEY_CONTEXT: &str = "DrFind";

type FindExcerpt = (
    usize,
    Option<SharedString>,
    std::ops::Range<usize>,
    String,
    bool,
);

gpui::actions!(
    find,
    [
        /// The next match.
        Next,
        /// The previous match.
        Previous,
    ]
);

/// The bar's own keys (bound through `keymap::add_bindings`): ⇧Enter for
/// the previous match, ⌘G / ⇧⌘G (F3 / ⇧F3 on Windows) while its field has
/// the keyboard.
pub fn key_bindings() -> Vec<KeyBinding> {
    let c = Some(KEY_CONTEXT);
    let mut keys = vec![KeyBinding::new("shift-enter", Previous, c)];
    if cfg!(target_os = "macos") {
        keys.push(KeyBinding::new("cmd-g", Next, c));
        keys.push(KeyBinding::new("cmd-shift-g", Previous, c));
    } else {
        keys.push(KeyBinding::new("f3", Next, c));
        keys.push(KeyBinding::new("shift-f3", Previous, c));
    }
    keys
}

/// What the bar tells the workspace.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FindBarEvent {
    /// Esc or the close button: the bar goes, the page gets the keyboard.
    Close,
}

pub struct FindBar {
    /// The active editor it searches.
    pub prose: Entity<ProseEditor>,
    /// All prose editors on this page (multi-prose EntryPage support).
    editors: Vec<(SharedString, Entity<ProseEditor>)>,
    active_editor: usize,
    field: Entity<TextField>,
    replace_field: Entity<TextField>,
    /// The replace row is open.
    pub replacing: bool,
    /// Collapsible results excerpt list dropdown is open.
    pub results_open: bool,
    scope: FindScope,
    status: FindStatus,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<FindBarEvent> for FindBar {}

impl FindBar {
    /// A bar searching `prose`; `book`: the whole book's editor (every
    /// chapter), else the chapter the caret is in.
    pub fn new(
        prose: Entity<ProseEditor>,
        book: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> FindBar {
        Self::new_multi(vec![(SharedString::default(), prose)], 0, book, window, cx)
    }

    pub fn new_multi(
        editors: Vec<(SharedString, Entity<ProseEditor>)>,
        active_editor: usize,
        book: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> FindBar {
        let active_editor = active_editor.min(editors.len().saturating_sub(1));
        let prose = editors[active_editor].1.clone();
        let placeholder = t(
            cx,
            if book {
                keys::find_panel::BOOK_PLACEHOLDER
            } else {
                keys::find_panel::CURRENT_PLACEHOLDER
            },
        );
        // Prefill from a non-empty single-line selection, else restore earlier query.
        let selected_seed = {
            let p = prose.read(cx);
            let sel = p.selection();
            (!sel.is_empty() && !sel.spans_chapters())
                .then(|| p.selected_text())
                .filter(|s| !s.is_empty() && !s.contains('\n') && s.chars().count() <= 120)
        };
        let query = selected_seed
            .clone()
            .or_else(|| prose.read(cx).find_query().map(|(q, _)| q.to_owned()))
            .unwrap_or_default();
        let field = cx.new(|cx| {
            TextField::new("find-field", window, cx)
                .placeholder(placeholder)
                .icon(Icon::Search)
                .small()
                .with_text(query)
        });
        let replace_hint = t(cx, keys::find_panel::REPLACE_PLACEHOLDER);
        let replace_field = cx.new(|cx| {
            TextField::new("replace-field", window, cx)
                .placeholder(replace_hint)
                .small()
        });
        let subscriptions = vec![
            cx.subscribe_in(
                &replace_field,
                window,
                |bar, _, event: &FieldEvent, window, cx| match event {
                    FieldEvent::Submitted(_) => bar.replace_current(window, cx),
                    FieldEvent::Cancelled => cx.emit(FindBarEvent::Close),
                    FieldEvent::Changed(_) | FieldEvent::Blurred => {}
                },
            ),
            cx.subscribe_in(
                &field,
                window,
                |bar, _, event: &FieldEvent, window, cx| match event {
                    FieldEvent::Changed(text) => bar.search(text, window, cx),
                    FieldEvent::Submitted(_) => bar.step(true, window, cx),
                    FieldEvent::Cancelled => cx.emit(FindBarEvent::Close),
                    FieldEvent::Blurred => {}
                },
            ),
            cx.subscribe_in(&prose, window, |bar, _, event: &FindEvent, _, cx| {
                if let FindEvent::QueryChanged(query) = event {
                    let query = query.clone();
                    bar.field.update(cx, |f, cx| f.set_text(query, cx));
                    bar.refresh(cx);
                }
            }),
            cx.observe(&prose, |bar, _, cx| bar.refresh(cx)),
        ];
        let mut bar = FindBar {
            prose,
            editors,
            active_editor,
            field,
            replace_field,
            replacing: false,
            results_open: false,
            scope: if book {
                FindScope::Book
            } else {
                FindScope::Chapter
            },
            status: FindStatus::default(),
            _subscriptions: subscriptions,
        };
        if let Some(seed) = selected_seed {
            bar.search(&seed, window, cx);
        } else {
            bar.refresh(cx);
        }
        bar
    }

    /// The field takes the keyboard (selecting any existing query so typing replaces it).
    pub fn focus(&self, window: &mut Window, cx: &mut Context<Self>) {
        self.field.focus_handle(cx).focus(window, cx);
        self.field.update(cx, |f, cx| f.select_all_text(cx));
    }

    pub fn select_editor(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        if index >= self.editors.len() || index == self.active_editor {
            return;
        }
        let query = self.field.read(cx).text();
        self.prose.update(cx, |p, cx| p.clear_find(cx));
        self.active_editor = index;
        self.prose = self.editors[index].1.clone();
        if !query.is_empty() {
            self.search(&query, window, cx);
        } else {
            self.refresh(cx);
        }
        cx.notify();
    }

    pub fn contains_editor(&self, id: gpui::EntityId) -> bool {
        self.editors.iter().any(|(_, e)| e.entity_id() == id)
    }

    pub fn status(&self) -> FindStatus {
        self.status
    }

    fn options(&self) -> FindOptions {
        FindOptions {
            scope: self.scope,
            ..FindOptions::default()
        }
    }

    /// Puts `query` in the field and searches for it (as typing it would).
    pub fn set_query(&mut self, query: &str, window: &mut Window, cx: &mut Context<Self>) {
        let text = query.to_owned();
        self.field.update(cx, |f, cx| f.set_text(text, cx));
        self.search(query, window, cx);
    }

    /// The query changed: the first match at or after the caret.
    pub fn search(&mut self, query: &str, window: &mut Window, cx: &mut Context<Self>) {
        let options = self.options();
        self.prose.update(cx, |p, cx| {
            if query.is_empty() {
                p.clear_find(cx);
            } else {
                p.set_find(query, options, window, cx);
            }
        });
        self.refresh(cx);
    }

    /// The next (`forward`) or previous match.
    pub fn step(&mut self, forward: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.prose.update(cx, |p, cx| {
            if forward {
                p.find_next(window, cx);
            } else {
                p.find_previous(window, cx);
            }
        });
        self.refresh(cx);
    }

    /// Opens or closes the replace row; opened, its field takes the
    /// keyboard.
    pub fn set_replacing(&mut self, on: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.replacing = on;
        if on {
            self.replace_field.focus_handle(cx).focus(window, cx);
        } else {
            self.field.focus_handle(cx).focus(window, cx);
        }
        cx.notify();
    }

    /// What the replace field holds.
    pub fn replacement(&self, cx: &gpui::App) -> String {
        self.replace_field.read(cx).text()
    }

    pub fn set_replacement(&mut self, text: &str, cx: &mut Context<Self>) {
        let text = text.to_owned();
        self.replace_field.update(cx, |f, cx| f.set_text(text, cx));
    }

    /// 替换: replaces the current match (`ProseEditor::replace_current` already
    /// steps to the next match; calling `find_next` again would skip one).
    pub fn replace_current(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let with = self.replacement(cx);
        self.prose.update(cx, |p, cx| {
            let _ = p.replace_current(&with, window, cx);
        });
        self.refresh(cx);
    }

    /// 全部替换: every match of the scope. Returns how many.
    pub fn replace_all(&mut self, window: &mut Window, cx: &mut Context<Self>) -> usize {
        let with = self.replacement(cx);
        let n = self
            .prose
            .update(cx, |p, cx| p.replace_all(&with, window, cx));
        self.refresh(cx);
        n
    }

    /// Drops the query (the bar is closing).
    pub fn clear(&mut self, cx: &mut Context<Self>) {
        for (_, editor) in &self.editors {
            editor.update(cx, |p, cx| p.clear_find(cx));
        }
    }

    fn collect_excerpts(&self, cx: &gpui::App) -> Vec<FindExcerpt> {
        let p = self.prose.read(cx);
        let current = p.find_current();
        let chapters: Vec<usize> = match self.scope {
            FindScope::Book => (0..p.book().chapters.len()).collect(),
            FindScope::Chapter => vec![
                p.selection()
                    .chapter
                    .min(p.book().chapters.len().saturating_sub(1)),
            ],
        };
        let mut out = Vec::new();
        for ch in chapters {
            let Some(chapter) = p.book().chapters.get(ch) else {
                continue;
            };
            let matches = p.find_matches(ch);
            if matches.is_empty() {
                continue;
            }
            let title = (self.scope == FindScope::Book && !chapter.title.is_empty())
                .then(|| chapter.title.clone());
            let doc = &chapter.doc;
            for range in matches.iter() {
                if out.len() >= 120 {
                    return out;
                }
                let start = range.start.saturating_sub(18);
                let end = (range.end + 28).min(doc.len_chars());
                let raw = doc.slice(start..end);
                let snippet: String = raw
                    .chars()
                    .map(|c| if c == '\n' || c.is_control() { ' ' } else { c })
                    .collect();
                let is_current = current
                    .as_ref()
                    .is_some_and(|hit| hit.chapter == ch && hit.range == *range);
                out.push((ch, title.clone(), range.clone(), snippet, is_current));
            }
        }
        out
    }

    fn refresh(&mut self, cx: &mut Context<Self>) {
        let status = self.prose.read(cx).find_status();
        if status != self.status {
            self.status = status;
            cx.notify();
        }
    }
}

impl Render for FindBar {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let status = match (self.status.current, self.status.total) {
            (_, 0) if self.prose.read(cx).find_query().is_none() => String::new(),
            (Some(i), n) => format!("{} / {n}", i + 1),
            (None, n) => format!("{n}"),
        };
        let entity = cx.entity();
        let (prev, next, close, swap) = (
            entity.clone(),
            entity.clone(),
            entity.clone(),
            entity.clone(),
        );
        let (one, all, toggle_list) = (entity.clone(), entity.clone(), entity.clone());
        let replacing = self.replacing;
        let has_hits = self.status.total > 0;
        let replace_row = replacing.then(|| {
            div()
                .w_full()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(6.0))
                .child(div().flex_1().min_w_0().child(self.replace_field.clone()))
                .child(
                    Button::new("replace-one", t(cx, keys::find_panel::REPLACE))
                        .small()
                        .disabled(!has_hits)
                        .on_click(move |_, window, cx| {
                            one.update(cx, |bar, cx| bar.replace_current(window, cx))
                        }),
                )
                .child(
                    Button::new("replace-all", t(cx, keys::find_panel::REPLACE_ALL))
                        .small()
                        .disabled(!has_hits)
                        .on_click(move |_, window, cx| {
                            all.update(cx, |bar, cx| {
                                bar.replace_all(window, cx);
                            })
                        }),
                )
        });
        let module_row = (self.editors.len() > 1).then(|| {
            let mut row = div()
                .w_full()
                .flex()
                .flex_row()
                .flex_wrap()
                .items_center()
                .gap(px(4.0))
                .px(px(4.0));
            for (i, (name, _)) in self.editors.iter().enumerate() {
                let sw = entity.clone();
                let label: SharedString = if name.is_empty() {
                    format!("#{}", i + 1).into()
                } else {
                    name.clone()
                };
                let btn = Button::new(ElementId::Name(format!("find-mod-{i}").into()), label)
                    .small()
                    .on_click(move |_, window, cx| {
                        sw.update(cx, |bar, cx| bar.select_editor(i, window, cx));
                    });
                row = row.child(if i == self.active_editor {
                    btn.primary()
                } else {
                    btn.text()
                });
            }
            row
        });
        let results_list = (self.results_open && has_hits).then(|| {
            let excerpts = self.collect_excerpts(cx);
            let mut list = div()
                .id("find-results-list")
                .w_full()
                .max_h(px(220.0))
                .overflow_y_scroll()
                .border_t(px(0.5))
                .border_color(p.subtle_hairline())
                .pt(px(4.0))
                .flex()
                .flex_col()
                .gap(px(2.0));
            let mut last_chapter: Option<usize> = None;
            for (idx, (ch, ch_title, range, snippet, is_current)) in
                excerpts.into_iter().enumerate()
            {
                if let Some(title) = ch_title
                    && last_chapter != Some(ch)
                {
                    last_chapter = Some(ch);
                    list = list.child(
                        div()
                            .px(px(8.0))
                            .pt(px(4.0))
                            .font_role(Role::Index)
                            .type_px(s.caption, s.line_caption)
                            .text_color(p.muted().solid())
                            .child(title),
                    );
                }
                let jumper = entity.clone();
                list = list.child(
                    div()
                        .id(ElementId::Name(format!("find-hit-{idx}").into()))
                        .w_full()
                        .px(px(8.0))
                        .py(px(4.0))
                        .rounded(px(radius::SM))
                        .cursor_pointer()
                        .when(is_current, |el| el.bg(p.accent.alpha(0.12)))
                        .hover(|st| st.bg(p.ink(1).alpha(0.05)))
                        .font_role(Role::Ui)
                        .type_px(s.caption, s.line_caption)
                        .text_color(p.ink(2).solid())
                        .truncate()
                        .on_click(move |_, window, cx| {
                            let range = range.clone();
                            jumper.update(cx, |bar, cx| {
                                bar.prose
                                    .update(cx, |p, cx| p.select(ch, range, window, cx));
                                bar.refresh(cx);
                            });
                        })
                        .child(snippet),
                );
            }
            list
        });
        let find_row = div().w_full().flex().flex_row().items_center().gap(px(2.0));
        let bar = glass::glass_box(
            "find-bar",
            Kind::Surface,
            Mode::default(),
            false,
            Spec::new(Tone::Clear, (g::PILL_HEIGHT + 2.0 * g::TRAY_PADDING) / 2.0)
                .origin(glass::SAMPLE_ORIGINS[0])
                .rim(12.0)
                .ground(Ground::Uneven)
                .filled(p.page),
            window,
            cx,
        )
        .key_context(KEY_CONTEXT)
        .on_action(cx.listener(|bar, _: &Previous, window, cx| bar.step(false, window, cx)))
        .on_action(cx.listener(|bar, _: &Next, window, cx| bar.step(true, window, cx)))
        .occlude()
        .w(px(if replacing || self.results_open {
            420.0
        } else {
            372.0
        }))
        .flex()
        .flex_col()
        .gap(px(4.0))
        .p(px(g::TRAY_PADDING))
        .rounded(px(if self.results_open {
            radius::SHEET
        } else {
            (g::PILL_HEIGHT + 2.0 * g::TRAY_PADDING) / 2.0
        }))
        .bg(p.page.solid());
        let find_row = find_row
            .child(div().flex_1().min_w_0().child(self.field.clone()))
            .child(
                div()
                    .px(px(6.0))
                    .min_w(px(44.0))
                    .flex()
                    .justify_end()
                    .font_role(Role::Index)
                    .type_px(s.caption, s.line_caption)
                    .text_color(p.muted().solid())
                    .child(status),
            )
            .child(
                IconButton::new("find-previous", Icon::ChevronUp)
                    .in_tray()
                    .disabled(!has_hits)
                    .label(t(cx, keys::find_panel::PREVIOUS_TITLE))
                    .on_click(move |_, window, cx| {
                        prev.update(cx, |bar, cx| bar.step(false, window, cx))
                    }),
            )
            .child(
                IconButton::new("find-next", Icon::ChevronDown)
                    .in_tray()
                    .disabled(!has_hits)
                    .label(t(cx, keys::find_panel::NEXT_TITLE))
                    .on_click(move |_, window, cx| {
                        next.update(cx, |bar, cx| bar.step(true, window, cx))
                    }),
            )
            .child(
                IconButton::new("find-results-toggle", Icon::ViewList)
                    .in_tray()
                    .disabled(!has_hits)
                    .selected(self.results_open && has_hits)
                    .label(t(cx, keys::shell_ui::FIND_RESULTS))
                    .on_click(move |_, _, cx| {
                        toggle_list.update(cx, |bar, cx| {
                            bar.results_open = !bar.results_open;
                            cx.notify();
                        })
                    }),
            )
            .child(
                IconButton::new("find-replace", Icon::Swap)
                    .in_tray()
                    .selected(replacing)
                    .label(t(cx, keys::find_panel::REPLACE))
                    .on_click(move |_, window, cx| {
                        swap.update(cx, |bar, cx| bar.set_replacing(!bar.replacing, window, cx))
                    }),
            )
            .child(
                IconButton::new("find-close", Icon::Close)
                    .in_tray()
                    .label(t(cx, keys::find_panel::CLOSE_TITLE))
                    .on_click(move |_, _, cx| {
                        close.update(cx, |_, cx| cx.emit(FindBarEvent::Close))
                    }),
            );
        bar.child(find_row)
            .children(module_row)
            .children(replace_row)
            .children(results_list)
    }
}

impl super::Workspace {
    /// ⌘F: the find bar over the focused page (its field takes the
    /// keyboard; open already, it takes it again).
    pub fn open_find(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(bar) = self.find.clone() {
            bar.update(cx, |bar, cx| bar.focus(window, cx));
            return;
        }
        let Some(target) = self.nav.active_tab().map(|t| t.focused().target.clone()) else {
            return;
        };
        let Some(view) = self.page_view(&target).cloned() else {
            return;
        };
        let book = matches!(view, super::editors::PageView::Book(_));
        let active_prose = view.prose(cx);
        // On multi-prose EntryPage, collect all mounted prose modules in order.
        let mut editors: Vec<(SharedString, Entity<ProseEditor>)> = Vec::new();
        if let Some(page) = self.page_of(&target)
            && !page.mounted.is_empty()
            && let Some(v3_page) = &page.v3
        {
            for section in &v3_page.read(cx).sections {
                if section.kind == "prose"
                    && let Some(m) = page.mounted.get(&section.id)
                {
                    editors.push((section.name.clone().into(), m.view.prose(cx)));
                }
            }
        }
        if editors.is_empty() {
            editors.push((SharedString::default(), active_prose.clone()));
        }
        let active_idx = editors
            .iter()
            .position(|(_, e)| e.entity_id() == active_prose.entity_id())
            .unwrap_or(0);
        let bar = cx.new(|cx| FindBar::new_multi(editors, active_idx, book, window, cx));
        cx.subscribe_in(
            &bar,
            window,
            |ws, _, event: &FindBarEvent, window, cx| match event {
                FindBarEvent::Close => ws.close_find(window, cx),
            },
        )
        .detach();
        bar.update(cx, |bar, cx| bar.focus(window, cx));
        self.find = Some(bar);
        cx.notify();
    }

    /// ⌥⌘F / Ctrl+H: the find bar with its replace row open.
    pub fn open_replace(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.open_find(window, cx);
        if let Some(bar) = self.find.clone() {
            bar.update(cx, |bar, cx| bar.set_replacing(true, window, cx));
        }
    }

    /// Closes the find bar: its query goes, the page gets the keyboard.
    pub fn close_find(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(bar) = self.find.take() else {
            return;
        };
        let prose = bar.read(cx).prose.clone();
        bar.update(cx, |bar, cx| bar.clear(cx));
        window.focus(&prose.focus_handle(cx), cx);
        cx.notify();
    }

    /// The bar searches the page that was in front when it opened; another
    /// page in front closes it.
    pub(super) fn keep_find_on_page(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(bar) = &self.find else {
            return;
        };
        let front = self
            .nav
            .active_tab()
            .map(|t| t.focused().target.clone())
            .and_then(|t| self.page_view(&t).map(|v| v.prose(cx).entity_id()));
        if !front.is_some_and(|id| bar.read(cx).contains_editor(id)) {
            self.close_find(window, cx);
            // The searched editor may have been replaced inside a stable
            // renderer (whole-book reload). Do not leave focus on its old
            // prose, or let the unchanged renderer id suppress the handoff.
            self.refocus(window, cx);
        }
    }
}
