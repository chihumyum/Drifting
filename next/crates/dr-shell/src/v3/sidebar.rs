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
//!
//! The keyboard (KB, `kernel-v5.md` §15 item 48): ⌘⇧L gives the selected
//! Tab's tree the keyboard ([`Sidebar::take_keyboard`]; the tree lands on the
//! row of the page in front), or the Tab row when the Tab shows no tree the
//! keyboard walks (islands, the book, a gone mount; a board is drawn as the
//! list tree while the column is not filled, [`unfilled_display`]). On the
//! Tab row the selected Tab has the still ring; ← → choose the Tab before or after
//! (written with `tab.select`, like a click), stopping at the ends, the
//! manage button not on the way; ↓ goes back into the tree; Esc back to the
//! page. A click on a Tab leaves the keyboard where it was, a tree's going
//! into the new Tab's tree. Managing takes no keys; when it ends the
//! keyboard goes back to where it was when it began.
use super::{
    DisplaySurface, LevelHost, ROOT_LEVEL, Rendered,
    manage::{MountDrag, Structure},
    tab_fill::{FillLayout, TabCanvasHost},
    tabs,
};
use crate::{
    actions::left,
    pages::PageViewHost,
    strings::{t, tf},
};
use dr_i18n::keys;
use dr_ui::{
    Theme, anim,
    components::{
        Button, DraggedPill, IconButton, PanelIconButton, Pill, SandCell, Segmented, overlay,
    },
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
    /// Second pane in a dual-pane left sidebar: independent tab selection and
    /// distinct element-ID prefix so GPUI never sees colliding IDs.
    secondary: bool,
    selected: Option<String>,
    /// The selection the project remembers has been taken (once a book is
    /// open).
    restored: bool,
    /// Managing the Tabs, since when (the jiggle's clock).
    managing: Option<Instant>,
    /// Browsing templates inline inside the left sidebar (Smoke #11/#12).
    browsing_templates: bool,
    /// Whether the workspace offers a split button / close-pane button here.
    can_split: bool,
    is_split: bool,
    /// Where something dragged over the row would land (an index into the
    /// Tabs), and the Tab being dragged.
    slot: Option<usize>,
    dragging: Option<String>,
    focus: FocusHandle,
    /// The Tab row's own focus, while the keyboard is on it (KB).
    tab_focus: FocusHandle,
    /// The keyboard is to land in the selected Tab's tree once it is drawn
    /// (or on the Tab row, when the Tab shows no tree it walks).
    want_tree_keys: bool,
    /// Where the keyboard was when managing began: it goes back there.
    managing_return: Option<FocusHandle>,
    structure: Entity<Structure>,
    /// Whether the filled left sidebar is currently showing `模板结构` rather than `Tab`.
    in_structure: bool,
    filled: bool,
    template_structure: Option<Entity<super::template_structure::Structure>>,
    fill_layouts: BTreeMap<String, FillLayout>,
    /// A filled Tab's view, with the book it last showed: it catches up
    /// when it is drawn and the book has changed since, never while fill
    /// is closed and never on a redraw of the same book.
    filled_displays: BTreeMap<String, (TabMount, FillLayout, Rendered, Rc<crate::book::Book>)>,

    /// What a Tab on the root or an entry shows (its key: the mount and the
    /// display), made the first time it is selected.
    displays: BTreeMap<String, (String, Rendered)>,
}

impl Sidebar {
    pub fn new(host: PageViewHost, cx: &mut Context<Self>) -> Self {
        Self::new_with_role(host, false, cx)
    }

    pub fn new_secondary(host: PageViewHost, cx: &mut Context<Self>) -> Self {
        Self::new_with_role(host, true, cx)
    }

    fn new_with_role(host: PageViewHost, secondary: bool, cx: &mut Context<Self>) -> Self {
        let owner = cx.entity_id();
        let structure = cx.new(|_| Structure::new(host.clone(), owner));
        Self {
            host,
            secondary,
            selected: None,
            restored: false,
            managing: None,
            browsing_templates: false,
            can_split: false,
            is_split: false,
            slot: None,
            dragging: None,
            focus: cx.focus_handle(),
            tab_focus: cx.focus_handle(),
            want_tree_keys: false,
            managing_return: None,
            structure,
            in_structure: false,
            filled: false,
            template_structure: None,
            fill_layouts: BTreeMap::new(),
            filled_displays: BTreeMap::new(),

            displays: BTreeMap::new(),
        }
    }

    fn id_of(&self, base: &str) -> SharedString {
        if self.secondary {
            SharedString::from(format!("sec-{base}"))
        } else {
            SharedString::from(base.to_owned())
        }
    }

    pub fn is_browsing_templates(&self) -> bool {
        self.browsing_templates
    }

    pub fn set_pane_controls(&mut self, can_split: bool, is_split: bool, cx: &mut Context<Self>) {
        if self.can_split != can_split || self.is_split != is_split {
            self.can_split = can_split;
            self.is_split = is_split;
            cx.notify();
        }
    }

    pub fn is_in_structure(&self) -> bool {
        self.in_structure
    }

    /// The 模板结构 view, once the left column has filled into it.
    pub fn template_structure(&self) -> Option<Entity<super::template_structure::Structure>> {
        self.template_structure.clone()
    }

    pub fn enter_structure(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        self.managing = None;
        self.slot = None;
        self.dragging = None;
        if self.template_structure.is_none() {
            self.template_structure =
                Some(cx.new(|_| super::template_structure::Structure::new(self.host.clone())));
        }
        if !self.in_structure {
            self.in_structure = true;
            cx.notify();
        }
    }

    /// A new template in the structure's floating panel (`kernel-v5.md`
    /// §9): nothing is stored until the author changes something in it.
    pub fn new_structure_template(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(structure) = &self.template_structure {
            structure.update(cx, |view, cx| view.new_template(window, cx));
        }
    }

    /// Esc: closes the structure's floating panel or an active filled canvas's
    /// inner overlay (relation mode / sheet / peek). Returns whether one was open.
    pub fn close_structure_panel(&mut self, cx: &mut Context<Self>) -> bool {
        if self.in_structure {
            return self
                .template_structure
                .as_ref()
                .is_some_and(|structure| structure.update(cx, |view, cx| view.close_panel(cx)));
        }
        if self.filled
            && let Some(id) = self.selected.as_deref()
            && let Some((_, _, part, _)) = self.filled_displays.get(id)
            && let Some(close) = &part.close_panel
        {
            return close(cx);
        }
        false
    }

    pub fn leave_fill(&mut self, cx: &mut Context<Self>) {
        if self.in_structure {
            self.in_structure = false;
            if let Some(structure) = &self.template_structure {
                structure.update(cx, |view, cx| view.dismiss_editor(cx));
            }
            cx.notify();
        }
    }

    pub(crate) fn sync_fill(
        &mut self,
        filled: bool,
        layouts: &BTreeMap<String, FillLayout>,
        cx: &mut Context<Self>,
    ) {
        if self.filled != filled || &self.fill_layouts != layouts {
            self.filled = filled;
            self.fill_layouts = layouts.clone();
            cx.notify();
        }
    }

    fn fill_layout(&self, tab: &ProjectTab) -> FillLayout {
        self.fill_layouts.get(&tab.id).copied().unwrap_or_else(|| {
            let TabMount::Entry { entry } = &tab.mount else {
                return FillLayout::List;
            };
            self.host
                .book
                .v3()
                .and_then(|book| book.levels.get(entry))
                .map_or(FillLayout::List, |level| {
                    FillLayout::default_for(&level.settings.display)
                })
        })
    }

    pub fn shows_canvas(&self, tab: &str, layout: FillLayout) -> bool {
        self.filled
            && !self.in_structure
            && !self.is_managing()
            && self.selected.as_deref() == Some(tab)
            && self
                .tabs()
                .iter()
                .find(|candidate| candidate.id == tab)
                .is_some_and(|candidate| self.fill_layout(candidate) == layout)
    }

    pub fn choose_fill_layout(&mut self, layout: FillLayout, cx: &mut Context<Self>) {
        let Some(tab) = self.selected.clone() else {
            return;
        };
        self.fill_layouts.insert(tab.clone(), layout);
        let _ = self.host.workspace.update(cx, |ws, cx| {
            ws.set_tab_fill_layout(tab, layout, cx);
        });
        cx.notify();
    }

    pub fn sync(&mut self, host: PageViewHost, cx: &mut Context<Self>) {
        let previous = self.selected.clone();
        if self.host.book_id != host.book_id {
            self.selected = None;
            self.restored = false;
            self.managing = None;
            self.slot = None;
            self.dragging = None;
            self.in_structure = false;
            self.displays.clear();
            self.filled_displays.clear();
            self.template_structure = None;
        }
        let changed = !Rc::ptr_eq(&self.host.book, &host.book);
        self.host = host;
        self.structure
            .update(cx, |s, cx| s.sync(self.host.clone(), cx));
        let tabs = self.tab_ids();
        if !self.restored
            && let Some(v) = self.host.book.v3()
        {
            if self.secondary {
                // Secondary pane defaults to the next tab after the stored one
                // so two panes immediately display distinct views.
                let primary = v.stored_tab.as_deref();
                self.selected = tabs
                    .iter()
                    .find(|id| Some(id.as_str()) != primary)
                    .or_else(|| tabs.first())
                    .cloned();
            } else {
                // Where the project was left (on any device); a Tab that is
                // gone since goes to the first Tab, never having chosen one to
                // 「全部」 (Tab prototype, 2026-11-15).
                self.selected = match v.stored_tab.clone() {
                    Some(id) if tabs.contains(&id) => Some(id),
                    Some(_) => tabs.first().cloned(),
                    None => self.root_tab(),
                };
            }
            self.restored = true;
        }
        if !self.selected.as_ref().is_some_and(|id| tabs.contains(id)) {
            self.selected = tabs.first().cloned();
        }
        if changed {
            if let Some(structure) = &self.template_structure {
                structure.update(cx, |view, cx| view.refresh(self.host.book.clone(), cx));
            }
            let keys: BTreeMap<String, String> = self
                .tabs()
                .iter()
                .filter_map(|tab| Some((tab.id.clone(), self.display_key(tab)?)))
                .collect();
            self.displays
                .retain(|id, (key, _)| keys.get(id) == Some(key));
            self.filled_displays.retain(|id, _| tabs.contains(id));
            // Only a new book snapshot refreshes what the Tabs show: the
            // column redraws every frame, and a refresh sorts the whole list
            // and may read update times (T9 review). A filled Tab's view
            // catches up in `filled_body` instead: only while it is shown,
            // and outside the workspace's update (the relations layout
            // writes the workspace's book memory as it refreshes).
            for part in self.displays.values().map(|(_, part)| part) {
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
            Some(v) => tabs::tab_name(v, tab, cx),
            None => SharedString::default(),
        }
    }
    /// Selects the Tab `id`; the project remembers it for every device.
    pub fn choose(&mut self, id: &str, cx: &mut Context<Self>) {
        if !self.tab_ids().iter().any(|tab| tab == id) {
            return;
        }
        self.selected = Some(id.into());
        self.browsing_templates = false;
        self.leave_fill(cx);
        self.restored = true;
        if !self.secondary {
            let stored = self
                .host
                .book
                .v3()
                .and_then(|v| v.project.selected_tab.clone());
            if stored.as_deref() != Some(id) {
                tabs::write(&self.host, "tab.select", json!({ "id": id }), |_, _| {}, cx);
            }
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
        // The selected Tab's 「最近删除」: how many entries, and its rows of
        // their own (`trash`).
        let trash = selected
            .as_ref()
            .zip(v)
            .filter(|(tab, v)| !tabs::is_gone(v, &tab.mount))
            .and_then(|(tab, v)| {
                super::trash::section(v, &tab.mount, &Default::default()).map(|(count, rows)| {
                    json!({
                        "count": count,
                        "rows": rows.iter().map(|r| r.id.clone()).collect::<Vec<_>>(),
                    })
                })
            });
        json!({
            "tabs": tabs,
            "selected": self.selected,
            "entry": entry,
            "display": display,
            "trash": trash,
            "managing": self.managing.is_some(),
            "filled": self.filled,
            "templateStructure": self.in_structure,
            "structureView": self.template_structure.as_ref().filter(|_| self.in_structure)
                .map(|view| view.read(cx).state()),
            "fillLayout": selected.as_ref().filter(|_| self.filled && !self.in_structure)
                .map(|tab| self.fill_layout(tab)),

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
    /// Off, the keyboard goes back to where it was when managing began (the
    /// tree's row, the Tab row or the page).
    pub fn set_managing(&mut self, on: bool, window: &mut Window, cx: &mut Context<Self>) {
        if on == self.managing.is_some() {
            return;
        }
        self.managing = on.then(anim::now);
        self.slot = None;
        self.dragging = None;
        if on {
            self.managing_return = window.focused(cx).filter(|f| *f != self.focus);
            window.focus(&self.focus, cx);
        } else if let Some(back) = self.managing_return.take()
            && self.focus.is_focused(window)
        {
            window.focus(&back, cx);
        }
        cx.notify();
    }

    // The keyboard (KB).

    /// Whether the keyboard is anywhere in the column: its tree, its Tab
    /// row, a row's card, or the column itself (while managing).
    pub fn has_keyboard(&self, window: &Window, cx: &App) -> bool {
        self.focus.contains_focused(window, cx)
    }

    /// Whether the keyboard is in what the column draws only while it
    /// fills: the Tab's filled layout or the template structure. Not the
    /// Tab row, nor the column itself (managing), which stay drawn.
    pub fn fill_has_keyboard(&self, window: &Window, cx: &App) -> bool {
        self.filled
            && self.managing.is_none()
            && self.has_keyboard(window, cx)
            && !self.focus.is_focused(window)
            && !self.tabs_have_keyboard(window)
    }

    /// What the selected Tab shows in the column as it usually is (not
    /// filled), once made: a tree's view (tests, the debug bridge).
    pub fn shown_display(&self) -> Option<AnyView> {
        let id = self.selected.as_ref()?;
        self.displays.get(id).map(|(_, part)| part.view.clone())
    }

    /// Whether the keyboard is on the Tab row.
    pub fn tabs_have_keyboard(&self, window: &Window) -> bool {
        self.tab_focus.is_focused(window)
    }

    /// ⌘⇧L: the selected Tab's tree takes the keyboard once drawn, or the
    /// Tab row when the Tab shows no tree the keyboard walks. Nothing while
    /// managing or filled.
    pub fn take_keyboard(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.managing.is_some() || self.filled || self.in_structure {
            return;
        }
        let _ = window;
        self.want_tree_keys = true;
        cx.notify();
    }

    /// The keyboard onto the Tab row (from the tree's first row, ↑).
    pub fn keyboard_to_tabs(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.managing.is_some() || self.filled {
            return;
        }
        window.focus(&self.tab_focus, cx);
        cx.notify();
    }

    /// Where the keyboard is in the column, for the debug bridge: `tabs`,
    /// `tree` (with the selected Tab's own reading of its row), `column`
    /// (managing) or nothing.
    pub fn keyboard_state(&self, window: &Window, cx: &App) -> Value {
        let tree = self
            .selected
            .as_ref()
            .and_then(|id| self.displays.get(id))
            .and_then(|(_, part)| part.keyboard_state.as_ref())
            .map(|state| state(window, cx));
        let place = if self.tab_focus.is_focused(window) {
            Some("tabs")
        } else if tree
            .as_ref()
            .is_some_and(|t| t["focused"].as_bool() == Some(true))
        {
            Some("tree")
        } else if self.has_keyboard(window, cx) {
            Some("column")
        } else {
            None
        };
        json!({ "in": place, "tree": tree })
    }

    /// The selected Tab's tree takes the keyboard now, if it walks one;
    /// else the Tab row does.
    fn land_keyboard(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let land = self
            .selected
            .as_ref()
            .and_then(|id| self.displays.get(id))
            .and_then(|(_, part)| part.land.clone());
        match land {
            Some(land) => {
                // Outside this view's update: the tree reads the workspace.
                window.defer(cx, move |window, cx| land(window, cx));
            }
            None => window.focus(&self.tab_focus, cx),
        }
    }

    /// The Tab row's keys (KB).
    fn tab_key(&mut self, step: isize, window: &mut Window, cx: &mut Context<Self>) {
        let ids = self.tab_ids();
        let Some(at) = self
            .selected
            .as_ref()
            .and_then(|id| ids.iter().position(|t| t == id))
        else {
            return;
        };
        let next = at as isize + step;
        if next < 0 || next as usize >= ids.len() {
            return;
        }
        let id = ids[next as usize].clone();
        self.choose(&id, cx);
        window.focus(&self.tab_focus, cx);
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
        IconButton::new(self.id_of("v3-tab-manage"), Icon::Bridges)
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
    fn tab_row(
        &mut self,
        controls: Option<AnyElement>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(v) = self.host.book.v3() else {
            return div().into_any_element();
        };
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        // The keyboard walks the row only in the column as it usually is.
        let keyed = !self.filled && !self.in_structure;
        let on_row = keyed && self.tab_focus.is_focused(window);
        let tabs = v.project.tabs.clone();
        let labels: Vec<SharedString> = tabs.iter().map(|t| self.name(t, cx)).collect();
        let selected = if self.in_structure || self.browsing_templates {
            tabs.len()
        } else {
            self.selected
                .as_ref()
                .and_then(|id| tabs.iter().position(|t| &t.id == id))
                .unwrap_or(0)
        };
        let faint: Vec<usize> = tabs
            .iter()
            .enumerate()
            .filter(|(_, tab)| tabs::is_gone(v, &tab.mount))
            .map(|(i, _)| i)
            .collect();
        let ids: Vec<String> = tabs.iter().map(|t| t.id.clone()).collect();
        let weak = cx.entity().downgrade();
        let split_btn = (self.can_split && !self.filled && !self.secondary).then(|| {
            let ws = self.host.workspace.clone();
            Button::new(
                self.id_of("v3-left-split"),
                t(cx, keys::sidebar_layout::SPLIT),
            )
            .text()
            .small()
            .on_click(move |_, _, cx| {
                let _ = ws.update(cx, |ws, cx| {
                    ws.left.panes.split(&crate::workspace::LeftTab::ORDER);
                    cx.notify();
                });
            })
        });
        let close_pane_btn = (self.is_split && !self.filled && self.secondary).then(|| {
            let ws = self.host.workspace.clone();
            IconButton::new(self.id_of("v3-left-close-pane"), Icon::Close)
                .label(t(cx, keys::common::CLOSE))
                .on_click(move |_, _, cx| {
                    let _ = ws.update(cx, |ws, cx| {
                        ws.left.panes.close_pane(crate::panes::PaneId::Secondary);
                        cx.notify();
                    });
                })
        });
        div()
            .id(self.id_of("v3-tab-row"))
            .debug_selector({
                let sel = self.id_of("v3-tab-row");
                move || sel.to_string()
            })
            .when(keyed, |el| {
                el.track_focus(&self.tab_focus)
                    .key_context(crate::keymap::LEFT_TABS)
                    // A press on a Tab or the manage button leaves the
                    // keyboard where it was (the prototype): no focus here.
                    .on_mouse_down(MouseButton::Left, |_, window, _| window.prevent_default())
                    .on_action(
                        cx.listener(|this, _: &left::Left, window, cx| {
                            this.tab_key(-1, window, cx)
                        }),
                    )
                    .on_action(
                        cx.listener(|this, _: &left::Right, window, cx| {
                            this.tab_key(1, window, cx)
                        }),
                    )
                    .on_action(cx.listener(|this, _: &left::Down, _, cx| {
                        this.want_tree_keys = true;
                        cx.notify();
                    }))
                    .on_action(cx.listener(|this, _: &left::Back, window, cx| {
                        let ws = this.host.workspace.clone();
                        let layer = ws
                            .upgrade()
                            .is_some_and(|ws| ws.read(cx).top_layer().is_some());
                        if layer {
                            cx.propagate();
                            return;
                        }
                        let _ = ws.update(cx, |ws, cx| ws.keyboard_to_page(window, cx));
                    }))
            })
            .flex_shrink_0()
            .px_2()
            .flex()
            .flex_row()
            .items_center()
            .gap_1()
            .child(
                // A row, not a block: a block stretches the Tabs to the
                // strip's width, so nothing would be left over to scroll.
                div()
                    .id(self.id_of("v3-tab-strip"))
                    .debug_selector({
                        let sel = self.id_of("v3-tab-strip");
                        move || sel.to_string()
                    })
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_row()
                    .items_center()
                    .overflow_x_scroll()
                    .child(
                        Segmented::new(self.id_of("v3-level-tabs"), labels, selected)
                            .font(Role::Structure)
                            .faint(faint)
                            .keyboard(on_row.then_some(selected))
                            .on_change(move |index, window, cx| {
                                let _ = weak.update(cx, |this, cx| {
                                    if let Some(id) = ids.get(index) {
                                        // The keyboard in the tree goes on
                                        // into the new Tab's tree.
                                        let in_tree = this.managing.is_none()
                                            && this.has_keyboard(window, cx)
                                            && !this.tab_focus.is_focused(window);
                                        this.choose(id, cx);
                                        if in_tree {
                                            this.want_tree_keys = true;
                                        }
                                    }
                                });
                            }),
                    ),
            )
            // Smoke #6/#10: clearly separate fill layout switcher from project tabs.
            .children(controls.map(|controls| {
                div()
                    .id(self.id_of("v5-left-fill-controls"))
                    .flex_none()
                    .max_w(relative(0.67))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.0))
                    .child(div().w(px(0.5)).h(px(16.0)).bg(p.local_hairline()))
                    .child(
                        div()
                            .id(self.id_of("v5-fill-layout-scroll"))
                            .px(px(3.0))
                            .py(px(1.0))
                            .rounded(px(radius::SM))
                            .bg(p.page.alpha(0.65))
                            .border(px(0.5))
                            .border_color(p.subtle_hairline())
                            .overflow_x_scroll()
                            .child(controls),
                    )
            }))
            .children(split_btn)
            .children(close_pane_btn)
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
            .id(self.id_of("v3-tab-wrap"))
            .flex_1()
            .min_w_0()
            .flex()
            .flex_row()
            .flex_wrap()
            .items_center()
            .gap_x(px(4.0))
            .gap_y(px(8.0));
        let slot = || {
            div()
                .id(self.id_of("v3-tab-slot"))
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
            let bounds =
                overlay::use_bounds(self.id_of(&format!("v3-tab-bounds-{}", tab.id)), window, cx);
            probes.push(bounds.clone());
            // Smoke #7: hide the dragged chip in place instead of leaving a faint ghost.
            if self.dragging.as_ref() == Some(&tab.id) {
                continue;
            }
            let name = self.name(tab, cx);
            let root = tab.mount == TabMount::Root;
            let on = self.selected.as_ref() == Some(&tab.id);
            let gone = tabs::is_gone(v, &tab.mount);
            // Smoke #7: gentle, unhurried jiggle; still under reduced motion.
            let (dx, dy) = if still {
                (0.0, 0.0)
            } else {
                let period = if i % 3 == 2 { 0.84 } else { 0.72 };
                let side = if i % 2 == 0 { 1.0 } else { -1.0 };
                let a = (elapsed / period * TAU).sin() * side;
                (0.35 * a, 0.15 * (elapsed / period * TAU).cos() * side)
            };
            let id = tab.id.clone();
            let chip = div()
                .id(self.id_of(&format!("v3-tab-chip-{}", tab.id)))
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
                .id(self.id_of(&format!("v3-tab-remove-{}", tab.id)))
                .absolute()
                .top(px(-5.0))
                .right(px(-5.0))
                .size(px(15.0))
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
                    .id(self.id_of(&format!("v3-tab-{}", tab.id)))
                    .relative()
                    .flex_none()
                    .child(overlay::probe(bounds))
                    .child(chip)
                    .when(!root, |el| el.child(badge)),
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
            .id(self.id_of("v3-tab-row"))
            .debug_selector({
                let sel = self.id_of("v3-tab-row");
                move || sel.to_string()
            })
            .flex_shrink_0()
            .px_2()
            .pb_1()
            .flex()
            .flex_row()
            .items_start()
            .gap_1()
            .child(wrap)
            .child(self.manage_button(cx))
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

    fn fill_layout_selector(&self, tab: ProjectTab, cx: &mut Context<Self>) -> AnyElement {
        let selected = FillLayout::ALL
            .iter()
            .position(|layout| *layout == self.fill_layout(&tab))
            .unwrap_or(0);
        let weak = cx.weak_entity();
        Segmented::new(
            "v5-tab-fill-layout",
            FillLayout::ALL.map(|layout| t(cx, layout.label())),
            selected,
        )
        .report_selected()
        .on_change(move |index, _, cx| {
            let _ = weak.update(cx, |this, cx| {
                this.choose_fill_layout(FillLayout::ALL[index], cx)
            });
        })
        .into_any_element()
    }

    fn filled_body(
        &mut self,
        tab: &ProjectTab,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let layout = self.fill_layout(tab);
        if matches!(tab.mount, TabMount::Book) && layout == FillLayout::List {
            return tabs::book_list(&self.host, window, cx);
        }
        let book = self.host.book.clone();
        if let Some((mount, saved, display, seen)) = self.filled_displays.get_mut(&tab.id)
            && mount == &tab.mount
            && *saved == layout
        {
            // Caught up only when the book changed since it last showed.
            if !Rc::ptr_eq(seen, &book) {
                *seen = book.clone();
                if let Some(refresh) = &display.refresh {
                    refresh(book, cx);
                }
            }
            return display.view.clone().into_any_element();
        }
        let display = if let Some(kind) = layout.display() {
            let (level, surface) = match &tab.mount {
                TabMount::Entry { entry } => (entry.clone(), DisplaySurface::Sidebar),
                TabMount::Book => (ROOT_LEVEL.into(), DisplaySurface::BookTab),
                _ => (ROOT_LEVEL.into(), DisplaySurface::Sidebar),
            };
            super::level_display_as(
                LevelHost {
                    page: self.host.clone(),
                    level,
                    surface,
                },
                kind,
                window,
                cx,
            )
        } else {
            super::tab_canvas(
                TabCanvasHost {
                    page: self.host.clone(),
                    tab: tab.clone(),
                    layout,
                },
                window,
                cx,
            )
        };
        let Some(display) = display else {
            return div().into_any_element();
        };
        let view = display.view.clone();
        self.filled_displays
            .insert(tab.id.clone(), (tab.mount.clone(), layout, display, book));
        view.into_any_element()
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
        if self.filled {
            return self.filled_body(tab, window, cx);
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
                                .map(|l| unfilled_display(&l.settings.display).to_owned())
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

    /// Creates a new entry under the selected tab's entry (or root).
    fn create_entry_here(&self, cx: &mut Context<Self>) {
        let Some(v) = self.host.book.v3() else {
            return;
        };
        let parent = self
            .selected
            .as_ref()
            .and_then(|id| v.project.tabs.iter().find(|t| &t.id == id))
            .and_then(|tab| match &tab.mount {
                TabMount::Entry { entry } => Some(entry.clone()),
                _ => None,
            });
        let template = parent
            .as_deref()
            .and_then(|pid| v.levels.get(pid))
            .and_then(|lvl| lvl.settings.default_template.clone())
            .filter(|tid| v.template(tid).is_some());
        let title = t(cx, keys::v3_shell::UNTITLED_ENTRY).to_string();
        let mut input = json!({
            "title": title,
            "parent": parent,
        });
        if let Some(tid) = template {
            input["template"] = json!(tid);
        }
        let ws = self.host.workspace.clone();
        let expected_book = self.host.book_id.clone();
        tabs::write(
            &self.host,
            "entry.create",
            input,
            move |out, cx| {
                if let Some(id) = out["output"]["id"].as_str()
                    && let Ok(eid) = id.parse()
                {
                    let _ = ws.update(cx, |ws, cx| {
                        if ws.book_id == expected_book {
                            ws.open(
                                crate::nav::Target::Entry {
                                    id: eid,
                                    module: None,
                                },
                                crate::nav::Open::KEEP.at_title(),
                                cx,
                            );
                        }
                    });
                }
            },
            cx,
        );
    }

    /// Inline template browser shown in the left sidebar when 「模板」 is active (Smoke #11/#12).
    fn template_list_body(&self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let Some(v) = self.host.book.v3() else {
            return div().into_any_element();
        };
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let current = self
            .host
            .workspace
            .upgrade()
            .and_then(|ws| ws.read(cx).nav.current().cloned());
        let templates: Vec<_> = v
            .templates
            .iter()
            .filter(|tpl| tpl.deleted_at.is_none())
            .collect();
        let mut list = div()
            .id(self.id_of("v5-template-list"))
            .size_full()
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap(px(2.0));
        for tpl in templates {
            let Ok(tid) = tpl.id.parse::<dr_model::id::EntryTemplateId>() else {
                continue;
            };
            let target = crate::nav::Target::Template(tid);
            let selected = current.as_ref() == Some(&target);
            let count = v
                .entries
                .iter()
                .filter(|e| e.template.as_deref() == Some(tpl.id.as_str()))
                .count();
            let (mark, color) = self.host.book.mark(&target);
            let ws = self.host.workspace.clone();
            let expected_book = self.host.book_id.clone();
            let cell = SandCell::new(
                self.id_of(&format!("v5-tpl-row-{}", tpl.id)),
                tpl.name.clone(),
            )
            .mark(mark)
            .color_opt(color)
            .selected(selected)
            .font(Role::Structure)
            .child(
                div()
                    .flex_none()
                    .font_role(Role::Index)
                    .type_px(s.caption, s.line_caption)
                    .text_color(p.muted().solid())
                    .child(count.to_string()),
            )
            .on_click(move |e, _, cx| {
                let how = if e.click_count() > 1 {
                    crate::nav::Open::KEEP
                } else {
                    crate::nav::Open::PREVIEW
                };
                let target = target.clone();
                let _ = ws.update(cx, |ws, cx| {
                    if ws.book_id == expected_book {
                        ws.open(target, how, cx);
                    }
                });
            });
            list = list.child(cell);
        }
        list.into_any_element()
    }

    /// Smoke #11 & #12: plain-text two-button footer.
    /// - Normal mode: 「新建条目」 + 「模板」 (no icons, no mixed CN/EN).
    /// - Template browsing / Template structure mode: template count + 「新建模板」 + 「返回」.
    fn templates(&self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let count = self.host.book.v3().map_or(0, |book| {
            book.templates
                .iter()
                .filter(|template| template.deleted_at.is_none())
                .count()
        });
        let host = self.host.clone();
        if self.browsing_templates || (self.filled && self.in_structure) {
            let in_structure = self.filled && self.in_structure;
            let ws_new = self.host.workspace.clone();
            let ws_back = self.host.workspace.clone();
            return div()
                .id(self.id_of("v5-template-collection"))
                .flex_none()
                .border_t(px(0.5))
                .border_color(p.subtle_hairline())
                .px_2()
                .py(px(6.0))
                .flex()
                .items_center()
                .gap_2()
                .child(
                    div()
                        .id(self.id_of("v5-template-collection-count"))
                        .debug_selector({
                            let sel = self.id_of("v5-template-collection-count");
                            move || sel.to_string()
                        })
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .font_role(Role::Index)
                        .type_px(12.0, 16.0)
                        .text_color(p.ink(3).solid())
                        .child(if in_structure {
                            format!(
                                "{} · {}",
                                t(cx, keys::v5_fill::TEMPLATE_STRUCTURE),
                                tf(cx, keys::v5_fill::TEMPLATE_COUNT, &[("count", &count)])
                            )
                            .into()
                        } else {
                            tf(cx, keys::v5_fill::TEMPLATE_COUNT, &[("count", &count)])
                        }),
                )
                .child(
                    Button::new(
                        self.id_of("v3-new-template"),
                        t(cx, keys::v3_shell::NEW_TEMPLATE),
                    )
                    .text()
                    .small()
                    .disabled(!in_structure && !super::has_template_creator(cx))
                    .on_click(move |_, window, cx| {
                        if in_structure {
                            let _ = ws_new
                                .update(cx, |ws, cx| ws.new_template_in_structure(window, cx));
                        } else {
                            super::create_template(host.clone(), window, cx);
                        }
                    }),
                )
                .child(
                    Button::new(
                        self.id_of("v5-templates-back"),
                        t(cx, keys::shell_ui::BACK_PLAIN),
                    )
                    .text()
                    .small()
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.browsing_templates = false;
                        if in_structure {
                            let _ = ws_back.update(cx, |ws, cx| {
                                ws.exit_fill(window, cx);
                            });
                        }
                        cx.notify();
                    })),
                )
                .into_any_element();
        }
        div()
            .id(self.id_of("v5-template-collection"))
            .flex_none()
            .border_t(px(0.5))
            .border_color(p.subtle_hairline())
            .px_2()
            .py(px(6.0))
            .flex()
            .items_center()
            .justify_between()
            .gap_2()
            .child(
                Button::new(
                    self.id_of("v5-new-entry-plain"),
                    t(cx, keys::shell_ui::NEW_ENTRY_PLAIN),
                )
                .text()
                .small()
                .on_click(cx.listener(|this, _, _, cx| this.create_entry_here(cx))),
            )
            .child(
                Button::new(
                    self.id_of("v5-templates-plain"),
                    t(cx, keys::shell_ui::TEMPLATES_PLAIN),
                )
                .text()
                .small()
                .on_click(cx.listener(|this, _, _, cx| {
                    this.browsing_templates = true;
                    cx.notify();
                })),
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
        let can_host = self.host.clone();
        let drop_host = self.host.clone();
        let wash = Theme::of(window, cx).palette.page.alpha(0.45);
        let mut content = div()
            .id(self.id_of("v3-sidebar"))
            .debug_selector({
                let sel = self.id_of("v3-sidebar");
                move || sel.to_string()
            })
            .track_focus(&self.focus)
            .flex()
            .flex_col()
            .min_h_0()
            .size_full()
            .can_drop(move |value, _, _| {
                value
                    .downcast_ref::<super::EntryDrag>()
                    .is_some_and(|drag| drag.timeline_clip.is_some() && drag.matches(&can_host))
            })
            .drag_over::<super::EntryDrag>(move |style, _, _, _| style.bg(wash))
            .on_drop(move |drag: &super::EntryDrag, _, cx| {
                let _ = tabs::detach_timeline_clip(&drop_host, drag, cx);
            })
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
        let selected = self
            .selected
            .as_ref()
            .and_then(|id| v.project.tabs.iter().find(|t| &t.id == id))
            .cloned();
        let controls = if self.filled && self.in_structure {
            self.template_structure
                .as_ref()
                .map(|view| view.update(cx, |view, cx| view.header(window, cx)))
        } else {
            selected
                .as_ref()
                .filter(|tab| self.filled && !tabs::is_gone(v, &tab.mount))
                .map(|tab| self.fill_layout_selector(tab.clone(), cx))
        };
        // The workspace tour's first step rings the row (M24).
        let row = self.tab_row(controls, window, cx);
        content = content.child(crate::pages::anchor(
            crate::pages::anchors::LEFT_PANEL_TAB,
            row,
            cx,
        ));
        let body = if self.filled && self.in_structure {
            self.template_structure.as_ref().map_or_else(
                || div().into_any_element(),
                |view| view.clone().into_any_element(),
            )
        } else if self.browsing_templates {
            self.template_list_body(window, cx)
        } else {
            selected.as_ref().map_or_else(
                || div().into_any_element(),
                |tab| self.body(tab, window, cx),
            )
        };
        // Per-tab count summary, unread Activity dot, and Collapse-All / Expand-All
        // utility strip when browsing entries in the regular sidebar.
        let utility_strip = (!self.filled && !self.in_structure && !self.browsing_templates)
            .then(|| {
                let tab = selected.as_ref()?;
                let v = self.host.book.v3()?;
                if tabs::is_gone(v, &tab.mount) {
                    return None;
                }
                let count = match &tab.mount {
                    TabMount::Root => v.entries.len(),
                    TabMount::Entry { entry } => {
                        let mut seen = std::collections::HashSet::new();
                        let mut stack = vec![entry.as_str()];
                        while let Some(cur) = stack.pop() {
                            if let Some(level) = v.levels.get(cur) {
                                for c in &level.children {
                                    if seen.insert(c.as_str()) {
                                        stack.push(c.as_str());
                                    }
                                }
                                for m in &level.members {
                                    seen.insert(m.as_str());
                                }
                            }
                        }
                        seen.len()
                    }
                    TabMount::Book => v.book_entries().len(),
                    TabMount::View { .. } => 0,
                };
                let badges = super::unread_badges(&self.host.library, cx);
                let has_unread = super::tab_has_unread(v, &tab.mount, &badges);
                let toggle_all = self
                    .displays
                    .get(&tab.id)
                    .and_then(|(_, part)| part.toggle_collapse_all.clone());
                let p = Theme::of(window, cx).palette;
                let s = Theme::of(window, cx).scale;
                Some(
                    div()
                        .flex_shrink_0()
                        .px(px(12.0))
                        .pt(px(2.0))
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(6.0))
                        .child(
                            div()
                                .font_role(Role::Index)
                                .type_px(s.caption, s.line_caption)
                                .text_color(p.ink(4).solid())
                                .child(tf(cx, keys::v3_shell::ENTRY_COUNT, &[("count", &count)])),
                        )
                        .when(has_unread, |el| {
                            el.child(div().size(px(6.0)).rounded_full().bg(p.accent.solid()))
                        })
                        .child(div().flex_1())
                        .when_some(toggle_all, |el, toggle| {
                            el.child(
                                PanelIconButton::new(self.id_of("v3-collapse-all"), Icon::ViewList)
                                    .label(t(cx, keys::left_sidebar::actions::COLLAPSE_ALL))
                                    .on_click(move |_, _, cx| toggle(cx)),
                            )
                        })
                        .into_any_element(),
                )
            })
            .flatten();
        if let Some(strip) = utility_strip {
            content = content.child(strip);
        }
        // The keyboard asked for (⌘⇧L, ↓ on the Tab row, a click on a Tab
        // from the tree): the Tab's tree is made by now.
        if std::mem::take(&mut self.want_tree_keys) && !self.filled && !self.in_structure {
            self.land_keyboard(window, cx);
        }
        let keyed = !self.filled && !self.in_structure;
        content
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .px_2()
                    .py_2()
                    // A press round the tree that nothing in it took: the
                    // tree's blank space too, the keyboard landing in it.
                    .when(keyed, |el| {
                        el.on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|this, _: &MouseDownEvent, window, cx| {
                                let walks = this
                                    .selected
                                    .as_ref()
                                    .and_then(|id| this.displays.get(id))
                                    .is_some_and(|(_, part)| part.land.is_some());
                                if window.default_prevented() || this.managing.is_some() || !walks {
                                    return;
                                }
                                this.want_tree_keys = true;
                                window.prevent_default();
                                cx.notify();
                            }),
                        )
                    })
                    .child(body),
            )
            .child(self.templates(window, cx))
            .into_any_element()
    }
}

/// How a Tab shows its entries while the column is not filled (UP,
/// kernel-v5 §15 item 50: 「Tab只有铺满状态，才有五种。非铺满，只有列表树和
/// 紧凑索引。」): grid and island both use the same category-framed compact
/// index. The other choices use the list tree. This does not change the
/// stored display or the Tab's independently remembered filled layout.
pub fn unfilled_display(display: &str) -> &str {
    match display {
        "grid" | "island" => "island",
        _ => "list",
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
