//! The left column (`kernel-v5.md` §5, the second Tab prototype of
//! 2026-11-15): the project's Tabs and what the selected one shows, then the
//! template collection.
//!
//! A Tab is mounted on the root (「全部」, always there), an entry that holds
//! entries (living under it or attached to it), or the book, and is called by
//! what it is mounted on. It cannot mount a view (DV, 2026-11-16); one a book
//! stored from before reads as gone. The row scrolls sideways; the manage
//! button (筝柱) at its end turns managing on: the Tabs jiggle, each but
//! 「全部」 with a remove badge that stays still, they drag along the row to
//! reorder, the row wraps to show them all, and the column below shows the
//! project's structure (`manage.rs`), whose lit rows drag into the row to
//! add a Tab. The button again, Esc or a click outside the column ends it.
//! A Tab whose mount is gone stays, faded; it says so and offers to remove
//! it. Which Tab is selected goes with the project (`tab.select`).
use super::{
    DisplaySurface, LevelHost, ROOT_LEVEL, Rendered,
    manage::{MountDrag, Structure},
    tabs,
};
use crate::{
    nav::{Open, Target},
    pages::PageViewHost,
    strings::{t, tf},
};
use dr_i18n::keys;
use dr_ui::{
    Theme, anim,
    components::{Button, DraggedPill, IconButton, Pill, SandCell, Segmented, overlay},
    fonts::Role,
    sand::{self, Icon},
    style::DrStyled,
    tokens::radius,
};
use dr_workspace::commands::v3::types::{ProjectTab, TabMount};
use gpui::{prelude::*, *};
use serde_json::{Value, json};
use std::{collections::BTreeMap, f32::consts::TAU, rc::Rc, time::Duration, time::Instant};

/// A slot's width in the row while something is dragged to that place.
const SLOT_WIDTH: f32 = 40.0;
/// How often the jiggling Tabs are redrawn.
const JIGGLE_FRAME: Duration = Duration::from_millis(33);

/// A Tab dragged along the row while managing.
#[derive(Clone)]
struct TabDrag {
    owner: EntityId,
    tab: String,
    name: SharedString,
}

pub struct Sidebar {
    host: PageViewHost,
    selected: Option<String>,
    /// The selection the project remembers has been taken (once a book is
    /// open).
    restored: bool,
    /// Managing the Tabs, since when (the jiggle's clock).
    managing: Option<Instant>,
    /// Where something dragged over the row would land (an index into the
    /// Tabs), and the Tab being dragged.
    slot: Option<usize>,
    dragging: Option<String>,
    focus: FocusHandle,
    structure: Entity<Structure>,
    /// What a Tab on the root or an entry shows (its key: the mount and the
    /// display), made the first time it is selected.
    displays: BTreeMap<String, (String, Rendered)>,
}

impl Sidebar {
    pub fn new(host: PageViewHost, cx: &mut Context<Self>) -> Self {
        let owner = cx.entity_id();
        let structure = cx.new(|_| Structure::new(host.clone(), owner));
        Self {
            host,
            selected: None,
            restored: false,
            managing: None,
            slot: None,
            dragging: None,
            focus: cx.focus_handle(),
            structure,
            displays: BTreeMap::new(),
        }
    }

    pub fn sync(&mut self, host: PageViewHost, cx: &mut Context<Self>) {
        let previous = self.selected.clone();
        if self.host.book_id != host.book_id {
            self.selected = None;
            self.restored = false;
            self.managing = None;
            self.slot = None;
            self.dragging = None;
            self.displays.clear();
        }
        let changed = !Rc::ptr_eq(&self.host.book, &host.book);
        self.host = host;
        self.structure
            .update(cx, |s, cx| s.sync(self.host.clone(), cx));
        let tabs = self.tab_ids();
        if !self.restored
            && let Some(v) = self.host.book.v3()
        {
            // Where the project was left (on any device); a Tab that is
            // gone since goes to the first Tab, never having chosen one to
            // 「全部」 (Tab prototype, 2026-11-15).
            self.selected = match v.stored_tab.clone() {
                Some(id) if tabs.contains(&id) => Some(id),
                Some(_) => tabs.first().cloned(),
                None => self.root_tab(),
            };
            self.restored = true;
        }
        if !self.selected.as_ref().is_some_and(|id| tabs.contains(id)) {
            self.selected = tabs.first().cloned();
        }
        if changed {
            let keys: BTreeMap<String, String> = self
                .tabs()
                .iter()
                .filter_map(|tab| Some((tab.id.clone(), self.display_key(tab)?)))
                .collect();
            self.displays
                .retain(|id, (key, _)| keys.get(id) == Some(key));
            for (_, part) in self.displays.values() {
                if let Some(refresh) = &part.refresh {
                    refresh(self.host.book.clone(), cx);
                }
            }
        }
        if changed || self.selected != previous {
            cx.notify();
        }
    }
    /// The project's Tabs, in order.
    pub fn tabs(&self) -> Vec<ProjectTab> {
        self.host
            .book
            .v3()
            .map(|v| v.project.tabs.clone())
            .unwrap_or_default()
    }
    fn tab_ids(&self) -> Vec<String> {
        self.tabs().into_iter().map(|t| t.id).collect()
    }
    /// The Tab on the root (「全部」).
    fn root_tab(&self) -> Option<String> {
        self.tabs()
            .into_iter()
            .find(|t| t.mount == TabMount::Root)
            .map(|t| t.id)
    }
    /// What a Tab is called: the name of what it is mounted on.
    fn name(&self, tab: &ProjectTab, cx: &App) -> SharedString {
        match self.host.book.v3() {
            Some(v) => tabs::mount_name(v, &tab.mount, cx),
            None => SharedString::default(),
        }
    }
    /// Selects the Tab `id`; the project remembers it for every device.
    pub fn choose(&mut self, id: &str, cx: &mut Context<Self>) {
        if !self.tab_ids().iter().any(|tab| tab == id) {
            return;
        }
        self.selected = Some(id.into());
        self.restored = true;
        let stored = self
            .host
            .book
            .v3()
            .and_then(|v| v.project.selected_tab.clone());
        if stored.as_deref() != Some(id) {
            tabs::write(&self.host, "tab.select", json!({ "id": id }), |_, _| {}, cx);
        }
        cx.notify();
    }
    /// Selects the Tab with this id, or the Tab mounted on the entry `id`
    /// (the debug bridge's `select`, and tests).
    pub fn select(&mut self, id: &str, cx: &mut Context<Self>) {
        let found = self.tabs().into_iter().find(|tab| {
            tab.id == id || matches!(&tab.mount, TabMount::Entry { entry } if entry == id)
        });
        if let Some(tab) = found {
            self.choose(&tab.id, cx);
        }
    }
    /// The display a Tab on the root or an entry shows, keyed by what it is
    /// mounted on and how that shows its entries.
    fn display_key(&self, tab: &ProjectTab) -> Option<String> {
        let v = self.host.book.v3()?;
        match &tab.mount {
            TabMount::Root => Some("root:list".into()),
            TabMount::Entry { entry } if !tabs::is_gone(v, &tab.mount) => {
                let display = &v.levels.get(entry)?.settings.display;
                Some(format!("entry:{entry}:{display}"))
            }
            _ => None,
        }
    }
    pub fn state(&self, cx: &App) -> Value {
        let v = self.host.book.v3();
        let tabs: Vec<Value> = self
            .tabs()
            .iter()
            .map(|tab| {
                json!({
                    "id": tab.id, "name": self.name(tab, cx), "mount": tab.mount,
                    "gone": v.is_some_and(|v| tabs::is_gone(v, &tab.mount)),
                    "root": tab.mount == TabMount::Root,
                })
            })
            .collect();
        let selected = self
            .selected
            .as_ref()
            .and_then(|id| self.tabs().into_iter().find(|t| &t.id == id));
        let entry = selected.as_ref().and_then(|t| match &t.mount {
            TabMount::Entry { entry } => Some(entry.clone()),
            _ => None,
        });
        let display = match selected.as_ref().map(|t| &t.mount) {
            Some(TabMount::Root) => Some("list".to_owned()),
            Some(TabMount::Entry { entry }) => v
                .and_then(|v| v.levels.get(entry))
                .map(|l| l.settings.display.clone()),
            _ => None,
        };
        json!({
            "tabs": tabs,
            "selected": self.selected,
            "entry": entry,
            "display": display,
            "managing": self.managing.is_some(),
            "slot": self.slot,
            "structure": self.managing.map(|_| self.structure.read(cx).state()),
            "registered": self.selected.as_ref().is_some_and(|id| self.displays.contains_key(id)),
            "templates": v.map(|v| v.templates.iter().filter(|t| t.deleted_at.is_none()).map(|t| &t.id).collect::<Vec<_>>()).unwrap_or_default()
        })
    }

    // Managing.

    pub fn is_managing(&self) -> bool {
        self.managing.is_some()
    }
    /// Turns managing on (the column takes the keyboard, for Esc) or off.
    pub fn set_managing(&mut self, on: bool, window: &mut Window, cx: &mut Context<Self>) {
        if on == self.managing.is_some() {
            return;
        }
        self.managing = on.then(anim::now);
        self.slot = None;
        self.dragging = None;
        if on {
            window.focus(&self.focus, cx);
        }
        cx.notify();
    }

    // Tab writes.

    /// Adds a Tab on `mount` so that it lands at `index` in the row.
    pub fn add_at(&mut self, mount: TabMount, index: usize, cx: &mut Context<Self>) {
        let tabs = self.tabs();
        if tabs.iter().any(|t| t.mount == mount) {
            return;
        }
        let place = match tabs.get(index) {
            Some(next) => json!({ "before": next.id }),
            None => json!("last"),
        };
        tabs::write(
            &self.host,
            "tab.put",
            json!({ "mount": mount, "place": place }),
            |_, _| {},
            cx,
        );
    }
    /// Moves `tab` so that it lands at `index` in the row (counted with it
    /// still in its place).
    pub fn move_to(&mut self, tab: &str, index: usize, cx: &mut Context<Self>) {
        let tabs = self.tabs();
        let Some(from) = tabs.iter().position(|t| t.id == tab) else {
            return;
        };
        if index == from || index == from + 1 {
            return;
        }
        let place = match tabs.get(index) {
            Some(next) => json!({ "before": next.id }),
            None => json!("last"),
        };
        tabs::write(
            &self.host,
            "tab.move",
            json!({ "id": tab, "place": place }),
            |_, _| {},
            cx,
        );
    }
    /// Removes a Tab (not what it is mounted on). 「全部」 stays.
    pub fn remove(&mut self, tab: &str, cx: &mut Context<Self>) {
        if self.root_tab().as_deref() == Some(tab) {
            return;
        }
        tabs::write(
            &self.host,
            "tab.remove",
            json!({ "id": tab }),
            |_, _| {},
            cx,
        );
    }
    /// A gone Tab's 「去掉这个 Tab」: removes it and goes back to the first
    /// Tab.
    pub fn remove_gone(&mut self, tab: &str, cx: &mut Context<Self>) {
        self.remove(tab, cx);
        if let Some(first) = self.tab_ids().into_iter().find(|id| id != tab) {
            self.choose(&first, cx);
        }
    }

    // Dragging over the row.

    /// Where in the row a drop at `at` lands: before the first Tab it is
    /// above or to the left of the middle of, else at the end.
    pub fn index_at(rects: &[Option<Bounds<Pixels>>], at: Point<Pixels>) -> usize {
        for (i, rect) in rects.iter().enumerate() {
            let Some(rect) = rect else {
                continue;
            };
            if at.y < rect.top() || (at.y <= rect.bottom() && at.x < rect.center().x) {
                return i;
            }
        }
        rects.len()
    }
    fn drag_moved(
        &mut self,
        inside: bool,
        at: Point<Pixels>,
        rects: &[Option<Bounds<Pixels>>],
        tab: Option<&str>,
        cx: &mut Context<Self>,
    ) {
        let slot = inside.then(|| Self::index_at(rects, at)).filter(|&i| {
            // A Tab dropped next to itself does not move.
            let from = tab.and_then(|id| self.tabs().iter().position(|t| t.id == id));
            from.is_none_or(|from| i != from && i != from + 1)
        });
        if slot != self.slot {
            self.slot = slot;
            cx.notify();
        }
    }

    // Drawing.

    /// The manage button at the row's end, pressed while managing.
    fn manage_button(&self, cx: &mut Context<Self>) -> AnyElement {
        IconButton::new("v3-tab-manage", Icon::Bridges)
            .label(t(cx, keys::v3_tabs::MANAGE))
            .selected(self.managing.is_some())
            .on_click(cx.listener(|this, _, window, cx| {
                let on = this.managing.is_none();
                this.set_managing(on, window, cx);
            }))
            .into_any_element()
    }

    /// The row as it usually is: the Tabs, scrolling sideways, and the
    /// manage button.
    fn tab_row(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let Some(v) = self.host.book.v3() else {
            return div().into_any_element();
        };
        let tabs = v.project.tabs.clone();
        let labels: Vec<SharedString> = tabs.iter().map(|t| self.name(t, cx)).collect();
        let selected = self
            .selected
            .as_ref()
            .and_then(|id| tabs.iter().position(|t| &t.id == id))
            .unwrap_or(0);
        let faint: Vec<usize> = tabs
            .iter()
            .enumerate()
            .filter(|(_, tab)| tabs::is_gone(v, &tab.mount))
            .map(|(i, _)| i)
            .collect();
        let ids: Vec<String> = tabs.iter().map(|t| t.id.clone()).collect();
        let weak = cx.entity().downgrade();
        div()
            .id("v3-tab-row")
            .flex_shrink_0()
            .px_2()
            .flex()
            .flex_row()
            .items_center()
            .gap_1()
            .child(
                div()
                    .id("v3-tab-strip")
                    .flex_1()
                    .min_w_0()
                    .overflow_x_scroll()
                    .child(
                        Segmented::new("v3-level-tabs", labels, selected)
                            .font(Role::Structure)
                            .faint(faint)
                            .on_change(move |index, _, cx| {
                                let _ = weak.update(cx, |this, cx| {
                                    if let Some(id) = ids.get(index) {
                                        this.choose(id, cx);
                                    }
                                });
                            }),
                    ),
            )
            .child(self.manage_button(cx))
            .into_any_element()
    }

    /// The row while managing: every Tab, wrapped onto as many lines as it
    /// takes, jiggling; a remove badge on each but 「全部」; dragging along
    /// the row reorders, and a row of the structure dropped on it adds a
    /// Tab where the slot opens.
    fn managed_row(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let Some(v) = self.host.book.v3() else {
            return div().into_any_element();
        };
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        if !cx.has_active_drag() {
            self.slot = None;
            self.dragging = None;
        }
        let tabs = v.project.tabs.clone();
        let owner = cx.entity_id();
        let elapsed = self
            .managing
            .map(|since| anim::now().saturating_duration_since(since).as_secs_f32())
            .unwrap_or(0.0);
        let still = theme.reduce_motion;
        let mut probes = Vec::with_capacity(tabs.len());
        let mut wrap = div()
            .id("v3-tab-wrap")
            .flex_1()
            .min_w_0()
            .pt(px(8.0))
            .flex()
            .flex_row()
            .flex_wrap()
            .items_center()
            .gap_x(px(4.0))
            .gap_y(px(10.0));
        let slot = || {
            div()
                .id("v3-tab-slot")
                .flex_none()
                .w(px(SLOT_WIDTH))
                .h(px(26.0))
                .rounded(px(radius::SM))
                .border_1()
                .border_dashed()
                .border_color(p.ink(3).alpha(0.55))
        };
        for (i, tab) in tabs.iter().enumerate() {
            if self.slot == Some(i) {
                wrap = wrap.child(slot());
            }
            let bounds = overlay::use_bounds(
                SharedString::from(format!("v3-tab-bounds-{}", tab.id)),
                window,
                cx,
            );
            probes.push(bounds.clone());
            let name = self.name(tab, cx);
            let root = tab.mount == TabMount::Root;
            let on = self.selected.as_ref() == Some(&tab.id);
            let gone = tabs::is_gone(v, &tab.mount);
            // Neighbours swing against each other, every third a little
            // slower; under reduced motion the Tabs stand still.
            let (dx, dy) = if still {
                (0.0, 0.0)
            } else {
                let period = if i % 3 == 2 { 0.6 } else { 0.52 };
                let side = if i % 2 == 0 { 1.0 } else { -1.0 };
                let a = (elapsed / period * TAU).sin() * side;
                (0.8 * a, 0.35 * (elapsed / period * TAU).cos() * side)
            };
            let id = tab.id.clone();
            let chip = div()
                .id(SharedString::from(format!("v3-tab-chip-{}", tab.id)))
                .relative()
                .left(px(dx))
                .top(px(dy))
                .h(px(26.0))
                .px(px(10.0))
                .flex()
                .items_center()
                .rounded(px(radius::SM))
                .font_role(Role::Structure)
                .type_px(s.secondary, s.line_body)
                .text_color(
                    if gone {
                        p.ink(4)
                    } else if on {
                        p.ink(1)
                    } else {
                        p.ink(3)
                    }
                    .solid(),
                )
                .when(on, |el| {
                    el.bg(p.page.solid())
                        .border(px(0.5))
                        .border_color(p.hairline())
                })
                .role(gpui::Role::RadioButton)
                .aria_label(name.clone())
                .aria_selected(on)
                .cursor_grab()
                .child(name.clone())
                .on_click(cx.listener(move |this, _, _, cx| this.choose(&id, cx)))
                .on_drag(
                    TabDrag {
                        owner,
                        tab: tab.id.clone(),
                        name: name.clone(),
                    },
                    |drag, _, window, cx| {
                        let at = window.mouse_position();
                        cx.new(|_| DraggedPill::new(Pill::new(drag.name.clone()), at))
                    },
                );
            let remove = tab.id.clone();
            let badge = div()
                .id(SharedString::from(format!("v3-tab-remove-{}", tab.id)))
                .absolute()
                .top(px(-6.0))
                .right(px(-6.0))
                .size(px(16.0))
                .rounded_full()
                .bg(p.desk.solid())
                .border(px(0.5))
                .border_color(p.ink(1).alpha(0.28))
                .flex()
                .items_center()
                .justify_center()
                .role(gpui::Role::Button)
                .aria_label(t(cx, keys::v3_tabs::REMOVE))
                .cursor_pointer()
                .child(sand::icon(Icon::Close, 8.0, p.ink(2).solid()))
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(cx.listener(move |this, _, _, cx| {
                    cx.stop_propagation();
                    this.remove(&remove, cx);
                }));
            wrap = wrap.child(
                div()
                    .id(SharedString::from(format!("v3-tab-{}", tab.id)))
                    .relative()
                    .flex_none()
                    .child(overlay::probe(bounds))
                    .child(chip)
                    .when(!root, |el| el.child(badge))
                    .when(self.dragging.as_ref() == Some(&tab.id), |el| {
                        el.opacity(0.3)
                    }),
            );
        }
        if self.slot == Some(tabs.len()) {
            wrap = wrap.child(slot());
        }
        let tab_probes = probes.clone();
        let mount_probes = probes;
        let wrap = wrap
            .on_drag_move::<TabDrag>(cx.listener(move |this, e: &DragMoveEvent<TabDrag>, _, cx| {
                let drag = e.drag(cx);
                if drag.owner != owner {
                    return;
                }
                let tab = drag.tab.clone();
                this.dragging = Some(tab.clone());
                let rects: Vec<_> = tab_probes.iter().map(|b| *b.read(cx)).collect();
                let inside = e.bounds.contains(&e.event.position);
                this.drag_moved(inside, e.event.position, &rects, Some(&tab), cx);
            }))
            .on_drag_move::<MountDrag>(cx.listener(
                move |this, e: &DragMoveEvent<MountDrag>, _, cx| {
                    if e.drag(cx).owner != owner {
                        return;
                    }
                    let rects: Vec<_> = mount_probes.iter().map(|b| *b.read(cx)).collect();
                    let inside = e.bounds.contains(&e.event.position);
                    this.drag_moved(inside, e.event.position, &rects, None, cx);
                },
            ))
            .can_drop(move |value, _, _| {
                value
                    .downcast_ref::<TabDrag>()
                    .is_some_and(|d| d.owner == owner)
                    || value
                        .downcast_ref::<MountDrag>()
                        .is_some_and(|d| d.owner == owner)
            })
            .on_drop(cx.listener(|this, drag: &TabDrag, _, cx| {
                if let Some(index) = this.slot.take() {
                    this.move_to(&drag.tab, index, cx);
                }
                this.dragging = None;
                cx.notify();
            }))
            .on_drop(cx.listener(|this, drag: &MountDrag, _, cx| {
                let index = this.slot.take().unwrap_or(usize::MAX);
                this.add_at(drag.mount.clone(), index, cx);
                cx.notify();
            }));
        let jiggling = !still;
        div()
            .id("v3-tab-row")
            .flex_shrink_0()
            .px_2()
            .pb_1()
            .flex()
            .flex_row()
            .items_start()
            .gap_1()
            .child(wrap)
            .child(div().pt(px(6.0)).child(self.manage_button(cx)))
            .child(
                canvas(
                    |_, _, _| (),
                    move |_, _, window, cx| {
                        if jiggling {
                            anim::keep_going_within(JIGGLE_FRAME, window, cx);
                        }
                    },
                )
                .absolute()
                .size_0(),
            )
            .into_any_element()
    }

    /// What the selected Tab shows.
    fn body(
        &mut self,
        tab: &ProjectTab,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let book = self.host.book.clone();
        let Some(v) = book.v3() else {
            return div().into_any_element();
        };
        if tabs::is_gone(v, &tab.mount) {
            let text = tf(cx, keys::v3_tabs::GONE, &[("name", &self.name(tab, cx))]);
            let id = tab.id.clone();
            return div()
                .id("v3-tab-gone")
                .p_2()
                .flex()
                .flex_col()
                .items_start()
                .gap_2()
                .child(
                    div()
                        .id("v3-tab-gone-text")
                        .role(gpui::Role::Label)
                        .aria_label(text.clone())
                        .child(text),
                )
                .child(
                    Button::new("v3-tab-remove-gone", t(cx, keys::v3_tabs::REMOVE_TAB))
                        .small()
                        .on_click(cx.listener(move |this, _, _, cx| this.remove_gone(&id, cx))),
                )
                .into_any_element();
        }
        match &tab.mount {
            // A Tab on a view is always gone (handled above): a Tab cannot
            // mount a view (DV, 2026-11-16).
            TabMount::View { .. } => div().into_any_element(),
            TabMount::Book => tabs::book_list(&self.host, window, cx),
            TabMount::Root | TabMount::Entry { .. } => {
                let Some(key) = self.display_key(tab) else {
                    return div().into_any_element();
                };
                if !self.displays.contains_key(&tab.id) {
                    let (level, kind) = match &tab.mount {
                        TabMount::Entry { entry } => (
                            entry.clone(),
                            v.levels
                                .get(entry)
                                .map(|l| l.settings.display.clone())
                                .unwrap_or_else(|| "list".into()),
                        ),
                        _ => (ROOT_LEVEL.to_owned(), "list".to_owned()),
                    };
                    let host = LevelHost {
                        page: self.host.clone(),
                        level: level.clone(),
                        surface: DisplaySurface::Sidebar,
                    };
                    if let Some(part) = super::level_display_as(host, &kind, window, cx) {
                        self.displays.insert(tab.id.clone(), (key, part));
                    } else if level != ROOT_LEVEL {
                        return div()
                            .id("v3-sidebar-placeholder")
                            .overflow_y_scroll()
                            .size_full()
                            .child(super::page::placeholder_display(&self.host, &level, cx))
                            .into_any_element();
                    }
                }
                match self.displays.get(&tab.id) {
                    Some((_, part)) => part.view.clone().into_any_element(),
                    None => div().into_any_element(),
                }
            }
        }
    }

    /// The template collection under the Tabs.
    fn templates(&self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = Theme::of(window, cx);
        let book = self.host.book.clone();
        let Some(v) = book.v3() else {
            return div().into_any_element();
        };
        let mut templates = div()
            .id("v3-template-list")
            .overflow_y_scroll()
            .max_h(px(168.0))
            .flex()
            .flex_col();
        for template in v.templates.iter().filter(|t| t.deleted_at.is_none()) {
            let Ok(id) = template.id.parse() else {
                continue;
            };
            let target = Target::Template(id);
            let (mark, color) = book.mark(&target);
            let weak = self.host.workspace.clone();
            let selected = weak
                .upgrade()
                .is_some_and(|ws| ws.read(cx).nav.is_selected(&target));
            templates = templates.child(
                SandCell::new(
                    SharedString::from(format!("v3-template-{}", template.id)),
                    template.name.clone(),
                )
                .mark(mark)
                .color_opt(color)
                .selected(selected)
                .on_click(move |_, _, cx| {
                    if let Some(ws) = weak.upgrade() {
                        ws.update(cx, |ws, cx| ws.open(target.clone(), Open::KEEP, cx));
                    }
                }),
            );
        }
        let host = self.host.clone();
        div()
            .flex_shrink_0()
            .flex()
            .flex_col()
            .gap_2()
            .p_2()
            .child(
                div()
                    .text_color(theme.palette.muted().solid())
                    .child(t(cx, keys::v3_shell::TEMPLATES)),
            )
            .child(templates)
            .child(
                Button::new("v3-new-template", t(cx, keys::v3_shell::NEW_TEMPLATE))
                    .disabled(!super::has_template_creator(cx))
                    .on_click(move |_, window, cx| {
                        super::create_template(host.clone(), window, cx)
                    }),
            )
            .into_any_element()
    }
}

impl Render for Sidebar {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let book = self.host.book.clone();
        let Some(v) = book.v3() else {
            return div().into_any_element();
        };
        let mut content = div()
            .id("v3-sidebar")
            .track_focus(&self.focus)
            .flex()
            .flex_col()
            .min_h_0()
            .size_full()
            .on_key_down(cx.listener(|this, e: &KeyDownEvent, window, cx| {
                if this.managing.is_some() && e.keystroke.key == "escape" {
                    cx.stop_propagation();
                    this.set_managing(false, window, cx);
                }
            }))
            .on_mouse_down_out(cx.listener(|this, _: &MouseDownEvent, window, cx| {
                if this.managing.is_some() && !cx.has_active_drag() {
                    this.set_managing(false, window, cx);
                }
            }));
        if self.managing.is_some() {
            let row = self.managed_row(window, cx);
            // Not a cached view: a reused one leaves its rows out of the
            // accessibility tree.
            return content
                .child(row)
                .child(div().flex_1().min_h_0().child(self.structure.clone()))
                .into_any_element();
        }
        content = content.child(self.tab_row(cx));
        let selected = self
            .selected
            .as_ref()
            .and_then(|id| v.project.tabs.iter().find(|t| &t.id == id))
            .cloned();
        let body = match selected {
            Some(tab) => self.body(&tab, window, cx),
            None => div().into_any_element(),
        };
        content
            .child(div().flex_1().min_h_0().px_2().py_2().child(body))
            .child(self.templates(window, cx))
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::Sidebar;
    use gpui::{Bounds, point, px, size};

    fn rect(x: f32, y: f32, w: f32) -> Option<Bounds<gpui::Pixels>> {
        Some(Bounds::new(point(px(x), px(y)), size(px(w), px(26.0))))
    }

    #[test]
    fn a_drop_lands_before_the_first_tab_it_is_above_or_left_of_the_middle_of() {
        // Two lines: three Tabs, then one.
        let rects = [
            rect(0.0, 0.0, 40.0),
            rect(44.0, 0.0, 40.0),
            rect(88.0, 0.0, 40.0),
            rect(0.0, 36.0, 40.0),
        ];
        let at = |x: f32, y: f32| Sidebar::index_at(&rects, point(px(x), px(y)));
        assert_eq!(at(5.0, 10.0), 0);
        assert_eq!(at(30.0, 10.0), 1);
        assert_eq!(
            at(120.0, 10.0),
            3,
            "past the first line's end: before the next line"
        );
        assert_eq!(at(5.0, 45.0), 3);
        assert_eq!(at(30.0, 45.0), 4, "the end");
    }
}
