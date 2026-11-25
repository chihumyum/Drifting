//! The dropdown select (components.md, 「下拉选择」): for more than four
//! choices, or choices that are things (storylines, categories). The
//! trigger is a single-line field holding the current choice's mark, its
//! name and a brush fold at the end; opened, it floats a menu list as wide
//! as the trigger and never narrower than 240, each choice with its mark,
//! the current one in medium weight with a tick.
//!
//! Choices that are words, not things (a field's values, a field's type, a
//! template's level settings), are [`Choice::plain`]: no mark on the
//! trigger, only its name and the fold, and plain rows in the list. A
//! select's choices all have a mark or none do.

use std::rc::Rc;

use gpui::{
    App, AppContext as _, Bounds, ElementId, Entity, FocusHandle, Focusable as _,
    InteractiveElement, IntoElement, KeyDownEvent, ParentElement, Pixels, RenderOnce, SharedString,
    StatefulInteractiveElement, Styled, Subscription, Window, div, prelude::FluentBuilder as _, px,
};

use crate::{
    fonts::Role,
    glass::{self, Kind, Mode, Spec, Tone},
    input::{FieldEvent, TextField},
    sand::{self, Icon},
    style::{DrStyled, child_id},
    theme::Theme,
    tokens::radius,
};

use super::{
    menu::{Menu, MenuItem, RowIcon, row_icon},
    overlay::{self, Layer, Place},
};

#[derive(Clone, Debug)]
pub struct Choice {
    pub label: SharedString,
    /// `None`: words alone ([`Choice::plain`]).
    pub icon: Option<RowIcon>,
}

impl Choice {
    pub fn new(icon: impl Into<RowIcon>, label: impl Into<SharedString>) -> Choice {
        Choice {
            label: label.into(),
            icon: Some(icon.into()),
        }
    }

    /// A choice of words alone, for choices that are not things (a field's
    /// values, a template's levels): the trigger shows the name and its
    /// fold, the list rows are words alone ([`MenuItem::plain`]). A select's
    /// choices all have an icon or none do.
    pub fn plain(label: impl Into<SharedString>) -> Choice {
        Choice {
            label: label.into(),
            icon: None,
        }
    }
}

pub struct SelectState {
    open: bool,
    bounds: Option<Bounds<Pixels>>,
    focus: FocusHandle,
    highlighted: usize,
    query: String,
    filter: Option<Entity<TextField>>,
    _filter_sub: Option<Subscription>,
}

type SelectHandles = (
    gpui::WeakEntity<SelectState>,
    gpui::WeakEntity<Option<Bounds<Pixels>>>,
);

#[derive(Default)]
struct OpenSelectLists(std::collections::HashMap<(gpui::WindowId, ElementId), SelectHandles>);
impl gpui::Global for OpenSelectLists {}

/// Auto-enable search filtering when a select has more than this many options.
const AUTO_SEARCH_THRESHOLD: usize = 8;

#[derive(IntoElement)]
pub struct Select {
    id: ElementId,
    choices: Vec<Choice>,
    selected: usize,
    open: Option<bool>,
    disabled: bool,
    in_dialog: bool,
    searchable: Option<bool>,
    on_change: Option<super::OnIndex>,
    menu_height: Option<f32>,
}

impl Select {
    pub fn new(id: impl Into<ElementId>, choices: Vec<Choice>, selected: usize) -> Select {
        Select {
            id: id.into(),
            choices,
            selected,
            open: None,
            disabled: false,
            in_dialog: false,
            searchable: None,
            on_change: None,
            menu_height: None,
        }
    }

    /// Force search filtering on or off (defaults to automatic when > 8 choices).
    pub fn searchable(mut self, searchable: bool) -> Self {
        self.searchable = Some(searchable);
        self
    }

    /// Holds the list open (galleries, captures).
    pub fn force_open(mut self, open: bool) -> Self {
        self.open = Some(open);
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// Floats the open choice list above an enclosing [`super::Dialog`].
    pub fn in_dialog(mut self) -> Self {
        self.in_dialog = true;
        self
    }

    /// Whether the open list floats above an enclosing dialog
    /// ([`Self::in_dialog`]).
    pub fn is_in_dialog(&self) -> bool {
        self.in_dialog
    }

    /// Opt into a scrollable choice viewport. Existing selects keep their
    /// current layout; callers with author-sized inventories can reach every row.
    pub fn max_menu_height(mut self, height: f32) -> Self {
        self.menu_height = Some(height.max(32.0));
        self
    }

    /// Called with the chosen index when the author picks another.
    pub fn on_change(mut self, f: impl Fn(usize, &mut Window, &mut App) + 'static) -> Self {
        self.on_change = Some(Rc::new(f));
        self
    }

    /// Whether this select's open choice list contains `point`, so an
    /// enclosing popover's `on_mouse_down_out` does not close before a
    /// choice click finishes.
    pub fn open_list_contains(
        id: impl Into<ElementId>,
        point: gpui::Point<Pixels>,
        window: &Window,
        cx: &App,
    ) -> bool {
        let Some((state, list_bounds)) = cx.try_global::<OpenSelectLists>().and_then(|lists| {
            lists
                .0
                .get(&(window.window_handle().window_id(), id.into()))
        }) else {
            return false;
        };
        let Some(state) = state.upgrade() else {
            return false;
        };
        let Some(list_bounds) = list_bounds.upgrade() else {
            return false;
        };
        state.read(cx).open && list_bounds.read(cx).is_some_and(|b| b.contains(&point))
    }
}

impl RenderOnce for Select {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let state: Entity<SelectState> =
            window.use_keyed_state(child_id(&self.id, "select"), cx, |_, cx| SelectState {
                open: false,
                bounds: None,
                focus: cx.focus_handle(),
                highlighted: self.selected,
                query: String::new(),
                filter: None,
                _filter_sub: None,
            });
        if let Some(open) = self.open {
            state.update(cx, |st, _| st.open = open);
        }
        let open = state.read(cx).open;
        let current = self.choices.get(self.selected).cloned();
        let current_label = current.as_ref().map(|c| c.label.clone());
        let bounds_cell = overlay::use_bounds(child_id(&self.id, "bounds"), window, cx);
        let toggle = state.clone();
        let disabled = self.disabled;
        if disabled {
            state.update(cx, |st, _| st.open = false);
        }
        let open = open && !disabled;
        let searchable = self
            .searchable
            .unwrap_or(self.choices.len() > AUTO_SEARCH_THRESHOLD);
        if open && searchable && state.read(cx).filter.is_none() {
            let filter_id = child_id(&self.id, "filter");
            let filter = cx.new(|cx| {
                TextField::new(filter_id, window, cx)
                    .small()
                    .icon(Icon::Search)
            });
            let sub = state.update(cx, |st, cx| {
                st.filter = Some(filter.clone());
                cx.subscribe(&filter, |st, _, ev: &FieldEvent, cx| match ev {
                    FieldEvent::Changed(text) => {
                        st.query = text.clone();
                        st.highlighted = 0;
                        cx.notify();
                    }
                    FieldEvent::Cancelled => {
                        st.open = false;
                        st.query.clear();
                        cx.notify();
                    }
                    _ => {}
                })
            });
            state.update(cx, |st, _| st._filter_sub = Some(sub));
        }
        let query_lower = state.read(cx).query.trim().to_lowercase();
        let visible_indices: Vec<usize> = self
            .choices
            .iter()
            .enumerate()
            .filter(|(_, c)| {
                query_lower.is_empty() || c.label.to_lowercase().contains(&query_lower)
            })
            .map(|(i, _)| i)
            .collect();
        let highlighted = if visible_indices.is_empty() {
            0
        } else {
            state.read(cx).highlighted.min(visible_indices.len() - 1)
        };
        let trigger_focus = state.read(cx).focus.clone();
        let selected_index = self.selected;
        let visible_for_keys = visible_indices.clone();
        let key_state = state.clone();
        let key_change = self.on_change.clone();
        let key_focus_filter = state.read(cx).filter.clone();
        let sel_dbg = self.id.clone();
        let trigger = glass::glass_box(
            self.id.clone(),
            Kind::Rest,
            Mode {
                disabled,
                ..Mode::default()
            },
            open,
            Spec::new(Tone::Clear, radius::SM).filled(p.page),
            window,
            cx,
        )
        .debug_selector(move || sel_dbg.to_string())
        .h(px(s.control_height))
        .min_w(px(160.0))
        .px(px(10.0))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(8.0))
        .rounded(px(radius::SM))
        .bg(p.page.solid())
        .font_role(Role::Ui)
        .type_px(s.body, s.line_body)
        .text_color(if disabled { p.ink(4) } else { p.ink(1) }.solid())
        .when(!disabled, |el| {
            el.cursor_pointer()
                .track_focus(&trigger_focus)
                .tab_index(0)
                .on_key_down(move |e: &KeyDownEvent, w, cx| {
                    let m = &e.keystroke.modifiers;
                    if m.control || m.alt || m.platform || m.function {
                        return;
                    }
                    let is_open = key_state.read(cx).open;
                    match e.keystroke.key.as_str() {
                        "enter" | "space" if !is_open => {
                            cx.stop_propagation();
                            key_state.update(cx, |st, cx| {
                                st.open = true;
                                st.query.clear();
                                st.highlighted = selected_index;
                                if let Some(f) = &st.filter {
                                    f.update(cx, |f, cx| f.set_text("", cx));
                                }
                                cx.notify();
                            });
                            if let Some(f) = &key_focus_filter {
                                w.focus(&f.focus_handle(cx), cx);
                            }
                        }
                        "escape" if is_open => {
                            cx.stop_propagation();
                            key_state.update(cx, |st, cx| {
                                st.open = false;
                                st.query.clear();
                                cx.notify();
                            });
                        }
                        "down" if is_open && !visible_for_keys.is_empty() => {
                            cx.stop_propagation();
                            key_state.update(cx, |st, cx| {
                                st.highlighted =
                                    (st.highlighted + 1).min(visible_for_keys.len() - 1);
                                cx.notify();
                            });
                        }
                        "up" if is_open && !visible_for_keys.is_empty() => {
                            cx.stop_propagation();
                            key_state.update(cx, |st, cx| {
                                st.highlighted = st.highlighted.saturating_sub(1);
                                cx.notify();
                            });
                        }
                        "home" if is_open && !visible_for_keys.is_empty() => {
                            cx.stop_propagation();
                            key_state.update(cx, |st, cx| {
                                st.highlighted = 0;
                                cx.notify();
                            });
                        }
                        "end" if is_open && !visible_for_keys.is_empty() => {
                            cx.stop_propagation();
                            key_state.update(cx, |st, cx| {
                                st.highlighted = visible_for_keys.len() - 1;
                                cx.notify();
                            });
                        }
                        "enter" if is_open => {
                            cx.stop_propagation();
                            let picked = visible_for_keys.get(highlighted).copied();
                            key_state.update(cx, |st, cx| {
                                st.open = false;
                                st.query.clear();
                                cx.notify();
                            });
                            if let (Some(idx), Some(f)) = (picked, &key_change) {
                                f(idx, w, cx);
                            }
                        }
                        _ => {}
                    }
                })
        })
        // In the accessibility tree as a combo box named by its choice.
        .role(gpui::Role::ComboBox)
        .when_some(current_label, |el, l| el.aria_label(l))
        .child(overlay::probe(bounds_cell.clone()))
        .when_some(current, |el, c| {
            el.when_some(c.icon, |el, icon| {
                let mark_id = self.id.clone();
                el.child(
                    div()
                        .flex_none()
                        .debug_selector(move || format!("{mark_id}-mark"))
                        .child(row_icon(icon, &self.id, p.ink(2).solid())),
                )
            })
            .child(div().flex_1().min_w_0().truncate().child(c.label))
        })
        .child(sand::icon(Icon::ChevronDown, 14.0, p.ink(3).solid()))
        .on_click(move |_, w, cx| {
            if disabled {
                return;
            }
            let now_open = toggle.update(cx, |st, cx| {
                st.open = !st.open;
                st.query.clear();
                st.highlighted = selected_index;
                if let Some(f) = &st.filter {
                    f.update(cx, |f, cx| f.set_text("", cx));
                }
                cx.notify();
                st.open
            });
            if now_open {
                let focus_target = toggle
                    .read(cx)
                    .filter
                    .as_ref()
                    .map(|f| f.focus_handle(cx))
                    .unwrap_or_else(|| toggle.read(cx).focus.clone());
                w.focus(&focus_target, cx);
            }
        });
        let bounds = *bounds_cell.read(cx);
        let list_bounds_cell = overlay::use_bounds(child_id(&self.id, "list-bounds"), window, cx);
        if !open {
            list_bounds_cell.update(cx, |b, _| *b = None);
        }
        cx.default_global::<OpenSelectLists>().0.insert(
            (window.window_handle().window_id(), self.id.clone()),
            (state.downgrade(), list_bounds_cell.downgrade()),
        );
        state.update(cx, |st, _| st.bounds = bounds);
        let list = (open && bounds.is_some()).then(|| {
            let b = bounds.expect("checked");
            let mut menu = Menu::new(child_id(&self.id, "list")).at_least(f32::from(b.size.width));
            if searchable && let Some(filter) = state.read(cx).filter.clone() {
                menu = menu.child(div().px(px(6.0)).pt(px(2.0)).pb(px(6.0)).child(filter));
            }
            let mut items = Vec::new();
            for (pos, &i) in visible_indices.iter().enumerate() {
                let c = &self.choices[i];
                let f = self.on_change.clone();
                let close = state.clone();
                let row_id = child_id(&self.id, format!("choice-{i}"));
                items.push(
                    match c.icon {
                        Some(icon) => MenuItem::new(row_id, icon, c.label.clone()),
                        None => MenuItem::plain(row_id, c.label.clone()),
                    }
                    .checked(i == self.selected)
                    .current(
                        pos == highlighted
                            && (!query_lower.is_empty() || trigger_focus.is_focused(window)),
                    )
                    .on_click(move |_, w, cx| {
                        close.update(cx, |st, cx| {
                            st.open = false;
                            st.query.clear();
                            if let Some(filter) = &st.filter {
                                filter.update(cx, |f, cx| f.set_text("", cx));
                            }
                            cx.notify();
                        });
                        if let Some(f) = &f {
                            f(i, w, cx);
                        }
                    }),
                );
            }
            let dismiss = state.clone();
            let menu = if let Some(h) = self.menu_height {
                menu.child(
                    div()
                        .id(child_id(&self.id, "choice-scroll"))
                        .debug_selector(|| "select-choice-scroll".into())
                        .max_h(px(h
                            .min(f32::from(window.viewport_size().height) - 32.0)
                            .max(32.0)))
                        .overflow_y_scroll()
                        .children(items),
                )
                .into_any_element()
            } else {
                for item in items {
                    menu = menu.item(item);
                }
                menu.into_any_element()
            };
            let menu_key_state = state.clone();
            let menu_key_change = self.on_change.clone();
            let menu_visible = visible_indices.clone();
            let floated = div()
                .relative()
                .child(overlay::probe(list_bounds_cell.clone()))
                .on_key_down(move |e: &KeyDownEvent, w, cx| {
                    let m = &e.keystroke.modifiers;
                    if m.control || m.alt || m.platform || m.function {
                        return;
                    }
                    match e.keystroke.key.as_str() {
                        "down" if !menu_visible.is_empty() => {
                            cx.stop_propagation();
                            menu_key_state.update(cx, |st, cx| {
                                st.highlighted = (st.highlighted + 1).min(menu_visible.len() - 1);
                                cx.notify();
                            });
                        }
                        "up" if !menu_visible.is_empty() => {
                            cx.stop_propagation();
                            menu_key_state.update(cx, |st, cx| {
                                st.highlighted = st.highlighted.saturating_sub(1);
                                cx.notify();
                            });
                        }
                        "enter" => {
                            cx.stop_propagation();
                            let picked = menu_visible.get(highlighted).copied();
                            menu_key_state.update(cx, |st, cx| {
                                st.open = false;
                                st.query.clear();
                                if let Some(filter) = &st.filter {
                                    filter.update(cx, |f, cx| f.set_text("", cx));
                                }
                                cx.notify();
                            });
                            if let (Some(idx), Some(f)) = (picked, &menu_key_change) {
                                f(idx, w, cx);
                            }
                        }
                        "escape" => {
                            cx.stop_propagation();
                            menu_key_state.update(cx, |st, cx| {
                                st.open = false;
                                st.query.clear();
                                cx.notify();
                            });
                        }
                        _ => {}
                    }
                })
                .on_mouse_down_out(move |_, _, cx| {
                    dismiss.update(cx, |st, cx| {
                        st.open = false;
                        st.query.clear();
                        cx.notify();
                    })
                })
                .child(menu);
            if self.in_dialog {
                overlay::float_in_dialog(Place::below(b, 4.0), floated).into_any_element()
            } else {
                overlay::float(Place::below(b, 4.0), Layer::Popover, floated).into_any_element()
            }
        });
        div().relative().child(trigger).children(list)
    }
}
