//! The left column (`kernel-v5.md` §5): the project's Tabs and what the
//! selected one shows, then the template collection.
//!
//! A Tab is mounted on the outermost entries, an entry that holds entries
//! (living under it or attached to it), a view, or the book. The row shows
//! as many Tabs as fit; the rest are under 「更多 N」. The 「⋯」 at its end
//! lists every Tab: drag a row to reorder, rename in place, the grey name
//! after it changes what it is mounted on, a row's end removes it, and the
//! last row adds one. A Tab whose mount is gone stays, faded, and says why.
//! Which Tab is selected stays on this device.
use super::{
    DisplaySurface, LevelHost, ROOT_LEVEL, Rendered,
    tabs::{self},
};
use crate::{
    nav::{Open, Target},
    pages::PageViewHost,
    strings::{t, tf},
};
use dr_i18n::keys;
use dr_ui::{
    Theme,
    components::{
        Button, DraggedPill, IconButton, Pill, SandCell, Segmented,
        menu::{Menu, MenuItem, MenuWidth, RowIcon, separator},
        overlay::{self, Layer, Place},
    },
    fonts::{Role, weight},
    input::{FieldEvent, TextField},
    sand::{self, Icon},
    style::DrStyled,
};
use dr_workspace::commands::v3::types::{ProjectTab, TabMount};
use gpui::{prelude::*, *};
use serde_json::json;
use std::{
    collections::{BTreeMap, HashMap},
    rc::Rc,
};

pub const MEMORY_KEY: &str = "v3.sidebar.tab";

/// A popover of the Tab row.
#[derive(Clone, Debug, PartialEq)]
enum Popup {
    /// The 「⋯」 list of every Tab.
    Manage(Point<Pixels>),
    /// What to mount a Tab on (`None`: the one being added).
    Mount {
        tab: Option<String>,
        at: Point<Pixels>,
    },
    /// The Tabs that do not fit in the row.
    More(Point<Pixels>),
}

/// A Tab dragged in the 「⋯」 list.
#[derive(Clone)]
struct TabDrag {
    owner: EntityId,
    tab: String,
    name: SharedString,
}

pub struct Sidebar {
    host: PageViewHost,
    /// The column's width, for how many Tabs fit in the row.
    width: f32,
    selected: Option<String>,
    restored: bool,
    /// A Tab being added: 「新 Tab」 shows selected at the row's end while
    /// its mount is picked.
    adding: bool,
    /// A Tab just added: selected once the book shows it.
    pending: Option<String>,
    popup: Option<Popup>,
    /// The 「条目」 and 「视图」 sections of the mount picker, folded.
    folded: (bool, bool),
    names: HashMap<String, (Entity<TextField>, Subscription)>,
    /// What a Tab on the root or an entry shows (its key: the mount and the
    /// display), made the first time it is selected.
    displays: BTreeMap<String, (String, Rendered)>,
}

impl Sidebar {
    pub fn new(host: PageViewHost) -> Self {
        Self {
            host,
            width: 280.0,
            selected: None,
            restored: false,
            adding: false,
            pending: None,
            popup: None,
            folded: (false, false),
            names: HashMap::new(),
            displays: BTreeMap::new(),
        }
    }
    pub fn sync(
        &mut self,
        host: PageViewHost,
        width: f32,
        remembered: Option<String>,
        ready: bool,
        cx: &mut Context<Self>,
    ) {
        let previous = self.selected.clone();
        if self.host.book_id != host.book_id {
            self.selected = None;
            self.restored = false;
            self.adding = false;
            self.pending = None;
            self.popup = None;
            self.names.clear();
            self.displays.clear();
        }
        if !self.restored && ready {
            self.selected = remembered;
            self.restored = true;
        }
        let changed = !Rc::ptr_eq(&self.host.book, &host.book);
        let resized = (self.width - width).abs() > 0.5;
        self.width = width;
        self.host = host;
        let tabs = self.tab_ids();
        if let Some(pending) = self.pending.clone()
            && tabs.contains(&pending)
        {
            self.pending = None;
            self.choose(&pending, cx);
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
            self.names.retain(|id, _| tabs.contains(id));
        }
        if changed || resized || self.selected != previous {
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
    /// Selects the Tab `id` and keeps it on this device.
    pub fn choose(&mut self, id: &str, cx: &mut Context<Self>) {
        if !self.tab_ids().iter().any(|tab| tab == id) {
            return;
        }
        self.selected = Some(id.into());
        self.restored = true;
        if let Some(ws) = self.host.workspace.upgrade() {
            let id = id.to_owned();
            // Not while the workspace draws this column.
            cx.defer(move |cx| {
                ws.update(cx, |ws, cx| {
                    ws.set_book_memory(MEMORY_KEY, serde_json::json!(id), cx)
                });
            });
        }
        cx.notify();
    }
    /// Selects the Tab with this id, or the first Tab mounted on the entry
    /// `id` (the debug bridge's `select`, and tests).
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
            TabMount::Entry { entry } if tabs::gone(v, &tab.mount).is_none() => {
                let display = &v.levels.get(entry)?.settings.display;
                Some(format!("entry:{entry}:{display}"))
            }
            _ => None,
        }
    }
    pub fn state(&self) -> serde_json::Value {
        let v = self.host.book.v3();
        let tabs: Vec<serde_json::Value> = self
            .tabs()
            .iter()
            .map(|tab| {
                serde_json::json!({
                    "id": tab.id, "name": tab.name, "mount": tab.mount,
                    "gone": v.and_then(|v| tabs::gone(v, &tab.mount)).is_some(),
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
        serde_json::json!({
            "tabs": tabs,
            "selected": self.selected,
            "entry": entry,
            "display": display,
            "adding": self.adding,
            "popup": match &self.popup {
                None => None,
                Some(Popup::Manage(_)) => Some("manage"),
                Some(Popup::Mount { .. }) => Some("mount"),
                Some(Popup::More(_)) => Some("more"),
            },
            "registered": self.selected.as_ref().is_some_and(|id| self.displays.contains_key(id)),
            "templates": v.map(|v| v.templates.iter().filter(|t| t.deleted_at.is_none()).map(|t| &t.id).collect::<Vec<_>>()).unwrap_or_default()
        })
    }

    // Tab writes.

    /// Mounts the Tab `tab` (or a new one, named after the mount) on
    /// `mount`; a new Tab is selected once the book shows it.
    pub fn mount(&mut self, tab: Option<String>, mount: TabMount, cx: &mut Context<Self>) {
        let Some(v) = self.host.book.v3() else {
            return;
        };
        self.popup = None;
        self.adding = false;
        let weak = cx.entity().downgrade();
        let input = match &tab {
            Some(id) => json!({ "id": id, "mount": mount }),
            None => {
                let name = tabs::mount_name(v, &mount, cx);
                json!({ "name": name.as_ref(), "mount": mount })
            }
        };
        let new = tab.is_none();
        tabs::write(
            &self.host,
            "tab.put",
            input,
            move |out, cx| {
                if new && let Some(id) = out["id"].as_str() {
                    let id = id.to_owned();
                    let _ = weak.update(cx, |this, cx| {
                        // The book may already show it; otherwise the next
                        // snapshot does.
                        if this.tab_ids().contains(&id) {
                            this.choose(&id, cx);
                        } else {
                            this.pending = Some(id);
                        }
                        cx.notify();
                    });
                }
            },
            cx,
        );
        cx.notify();
    }
    pub fn rename(&mut self, tab: &str, name: &str, cx: &mut Context<Self>) {
        let name = name.trim();
        if name.is_empty() || self.tabs().iter().any(|t| t.id == tab && t.name == name) {
            return;
        }
        tabs::write(
            &self.host,
            "tab.put",
            json!({ "id": tab, "name": name }),
            |_, _| {},
            cx,
        );
    }
    pub fn remove(&mut self, tab: &str, cx: &mut Context<Self>) {
        tabs::write(
            &self.host,
            "tab.remove",
            json!({ "id": tab }),
            |_, _| {},
            cx,
        );
    }
    /// Moves `tab` before or after `onto`.
    pub fn reorder(&mut self, tab: &str, onto: &str, after: bool, cx: &mut Context<Self>) {
        if tab == onto {
            return;
        }
        let place = if after {
            json!({ "after": onto })
        } else {
            json!({ "before": onto })
        };
        tabs::write(
            &self.host,
            "tab.move",
            json!({ "id": tab, "place": place }),
            |_, _| {},
            cx,
        );
    }
    /// Starts adding a Tab: 「新 Tab」 in the row, and what to mount it on.
    pub fn start_adding(&mut self, at: Point<Pixels>, cx: &mut Context<Self>) {
        self.adding = true;
        self.popup = Some(Popup::Mount { tab: None, at });
        cx.notify();
    }
    /// Opens the 「⋯」 list (tests and the debug bridge).
    pub fn open_manage(&mut self, cx: &mut Context<Self>) {
        self.popup = Some(Popup::Manage(Point::default()));
        cx.notify();
    }
    fn close_popup(&mut self, cx: &mut Context<Self>) {
        if matches!(self.popup, Some(Popup::Mount { tab: None, .. })) {
            self.adding = false;
        }
        self.popup = None;
        cx.notify();
    }

    // Drawing.

    /// How wide a Tab's label is in the row (its words and the padding).
    fn label_width(label: &str, window: &Window, cx: &App) -> f32 {
        let theme = Theme::of(window, cx);
        let run = TextRun {
            len: label.len(),
            font: Role::Structure.font(weight::REGULAR),
            color: theme.palette.ink(1).solid(),
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        f32::from(
            window
                .text_system()
                .layout_line(label, px(theme.scale.secondary), &[run], None)
                .width,
        )
        .ceil()
            + 20.0
    }
    /// How many of `labels` fit in the row, leaving room for `extra` more
    /// labels at its end; all of them when they fit with no 「更多」.
    fn fitting(
        &self,
        labels: &[SharedString],
        extra: &[SharedString],
        window: &Window,
        cx: &App,
    ) -> usize {
        // The column's padding, the 「⋯」 button and the row's ends.
        let room = self.width - 16.0 - 36.0 - 12.0;
        let widths: Vec<f32> = labels
            .iter()
            .map(|l| Self::label_width(l, window, cx))
            .collect();
        let extra: f32 = extra.iter().map(|l| Self::label_width(l, window, cx)).sum();
        if widths.iter().sum::<f32>() + extra <= room {
            return labels.len();
        }
        let more = Self::label_width(
            &tf(cx, keys::v3_tabs::MORE, &[("count", &labels.len())]),
            window,
            cx,
        );
        let mut used = extra + more;
        let mut n = 0;
        for w in widths {
            if used + w > room {
                break;
            }
            used += w;
            n += 1;
        }
        n
    }

    fn tab_row(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let Some(v) = self.host.book.v3() else {
            return div().into_any_element();
        };
        let tabs = v.project.tabs.clone();
        let labels: Vec<SharedString> = tabs.iter().map(|t| t.name.clone().into()).collect();
        let new_label = t(cx, keys::v3_tabs::NEW_TAB);
        let extra: Vec<SharedString> = if self.adding {
            vec![new_label.clone()]
        } else {
            vec![]
        };
        let shown = self.fitting(&labels, &extra, window, cx);
        let hidden = tabs.len() - shown;
        let mut options: Vec<SharedString> = labels[..shown].to_vec();
        let new_ix = self.adding.then(|| {
            options.push(new_label);
            options.len() - 1
        });
        let more_ix = (hidden > 0).then(|| {
            options.push(tf(cx, keys::v3_tabs::MORE, &[("count", &hidden)]));
            options.len() - 1
        });
        let selected_ix = self
            .selected
            .as_ref()
            .and_then(|id| tabs.iter().position(|t| &t.id == id));
        let selected = match (new_ix, selected_ix, more_ix) {
            (Some(n), _, _) => n,
            (None, Some(i), _) if i < shown => i,
            (None, Some(_), Some(m)) => m,
            _ => 0,
        };
        let faint: Vec<usize> = tabs[..shown]
            .iter()
            .enumerate()
            .filter(|(_, tab)| tabs::gone(v, &tab.mount).is_some())
            .map(|(i, _)| i)
            .collect();
        let ids: Vec<String> = tabs.iter().map(|t| t.id.clone()).collect();
        let weak = cx.entity().downgrade();
        let manage = cx.entity().downgrade();
        let bounds = overlay::use_bounds("v3-tab-row-bounds", window, cx);
        div()
            .id("v3-tab-row")
            .relative()
            .child(overlay::probe(bounds))
            .flex_shrink_0()
            .px_2()
            .flex()
            .flex_row()
            .items_center()
            .gap_1()
            .child(
                div().flex_1().min_w_0().overflow_hidden().child(
                    Segmented::new("v3-level-tabs", options, selected)
                        .font(Role::Structure)
                        .faint(faint)
                        .report_selected()
                        .on_change(move |index, window, cx| {
                            let at = window.mouse_position();
                            let _ = weak.update(cx, |this, cx| {
                                if Some(index) == more_ix {
                                    this.popup = Some(Popup::More(at));
                                    cx.notify();
                                } else if Some(index) != new_ix
                                    && let Some(id) = ids.get(index)
                                {
                                    this.choose(id, cx);
                                }
                            });
                        }),
                ),
            )
            .child(
                IconButton::new("v3-tab-manage", Icon::More)
                    .label(t(cx, keys::v3_tabs::MANAGE))
                    .selected(matches!(self.popup, Some(Popup::Manage(_))))
                    .on_click(move |_, window, cx| {
                        let at = window.mouse_position();
                        let _ = manage.update(cx, |this, cx| {
                            this.popup = Some(Popup::Manage(at));
                            cx.notify();
                        });
                    }),
            )
            .into_any_element()
    }

    /// The rename field of `tab` in the 「⋯」 list.
    fn name_field(
        &mut self,
        tab: &ProjectTab,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<TextField> {
        if let Some((field, _)) = self.names.get(&tab.id) {
            let field = field.clone();
            if !field.focus_handle(cx).is_focused(window) && field.read(cx).text() != tab.name {
                let name = tab.name.clone();
                field.update(cx, |f, cx| f.set_text(name, cx));
            }
            return field;
        }
        let field = cx.new(|cx| {
            TextField::new(
                SharedString::from(format!("v3-tab-name-{}", tab.id)),
                window,
                cx,
            )
            .small()
            .with_text(tab.name.clone())
        });
        let id = tab.id.clone();
        let sub = cx.subscribe_in(
            &field,
            window,
            move |this, field, event, window, cx| match event {
                FieldEvent::Submitted(_) | FieldEvent::Blurred => {
                    let text = field.read(cx).text();
                    this.rename(&id, &text, cx);
                    if matches!(event, FieldEvent::Submitted(_)) {
                        window.blur(cx);
                    }
                }
                FieldEvent::Cancelled => {
                    let name = this
                        .tabs()
                        .into_iter()
                        .find(|t| t.id == id)
                        .map(|t| t.name)
                        .unwrap_or_default();
                    field.update(cx, |f, cx| f.set_text(name, cx));
                    window.blur(cx);
                }
                FieldEvent::Changed(_) => {}
            },
        );
        self.names.insert(tab.id.clone(), (field.clone(), sub));
        field
    }

    /// The 「⋯」 list: every Tab, then 「加一个 Tab」.
    fn manage_list(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let book = self.host.book.clone();
        let Some(v) = book.v3() else {
            return div().into_any_element();
        };
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let owner = cx.entity_id();
        let mut menu = Menu::new("v3-tab-list").width(MenuWidth::Wide);
        for tab in v.project.tabs.clone() {
            let field = self.name_field(&tab, window, cx);
            let mount = tabs::mount_name(v, &tab.mount, cx);
            let bounds = overlay::use_bounds(
                SharedString::from(format!("v3-tab-row-bounds-{}", tab.id)),
                window,
                cx,
            );
            let drop_bounds = bounds.clone();
            let drag = TabDrag {
                owner,
                tab: tab.id.clone(),
                name: tab.name.clone().into(),
            };
            let onto = tab.id.clone();
            let remount = tab.id.clone();
            let remove = tab.id.clone();
            let line = p.accent.alpha(0.55);
            let group = SharedString::from(format!("v3-tab-row-{}", tab.id));
            menu = menu.child(
                div()
                    .id(group.clone())
                    .group(group.clone())
                    .relative()
                    .mx_1()
                    .px_2()
                    .min_h(px(theme.scale.menu_row))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_2()
                    .child(overlay::probe(bounds))
                    .child(
                        div()
                            .id(SharedString::from(format!("v3-tab-grip-{}", tab.id)))
                            .role(gpui::Role::Button)
                            .aria_label(t(cx, keys::v3_tabs::REORDER))
                            .cursor_grab()
                            .child(sand::icon(Icon::Grip, 14.0, p.ink(3).solid()))
                            .on_drag(drag, |drag, _, window, cx| {
                                let at = window.mouse_position();
                                cx.new(|_| DraggedPill::new(Pill::new(drag.name.clone()), at))
                            }),
                    )
                    .child(div().flex_1().min_w_0().child(field))
                    .child(
                        div()
                            .id(SharedString::from(format!("v3-tab-mount-{}", tab.id)))
                            .role(gpui::Role::Button)
                            .aria_label(mount.clone())
                            .flex_none()
                            .cursor_pointer()
                            .font_role(Role::Ui)
                            .type_px(theme.scale.caption, theme.scale.line_caption)
                            .text_color(p.muted().solid())
                            .child(mount)
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.popup = Some(Popup::Mount {
                                    tab: Some(remount.clone()),
                                    at: window.mouse_position(),
                                });
                                cx.notify();
                            })),
                    )
                    .child(
                        div()
                            .id(SharedString::from(format!("v3-tab-remove-{}", tab.id)))
                            .role(gpui::Role::Button)
                            .aria_label(t(cx, keys::v3_tabs::REMOVE))
                            .flex_none()
                            .cursor_pointer()
                            .invisible()
                            .group_hover(group.clone(), |s| s.visible())
                            .child(sand::icon(Icon::Close, 12.0, p.ink(3).solid()))
                            .on_click(cx.listener(move |this, _, _, cx| this.remove(&remove, cx))),
                    )
                    .can_drop(move |value, _, _| {
                        value
                            .downcast_ref::<TabDrag>()
                            .is_some_and(|d| d.owner == owner)
                    })
                    .drag_over::<TabDrag>(move |style, _, _, _| {
                        style.border_b_1().border_color(line)
                    })
                    .on_drop(cx.listener(move |this, drag: &TabDrag, window, cx| {
                        if drag.owner != owner {
                            return;
                        }
                        let after = drop_bounds
                            .read(cx)
                            .is_some_and(|b| window.mouse_position().y > b.center().y);
                        this.reorder(&drag.tab, &onto, after, cx);
                    })),
            );
        }
        let menu = menu.child(separator(p)).item(
            MenuItem::new("v3-tab-add", Icon::Plus, t(cx, keys::v3_tabs::ADD)).on_click(
                cx.listener(|this, _, window, cx| this.start_adding(window.mouse_position(), cx)),
            ),
        );
        menu.into_any_element()
    }

    /// A foldable section head of the mount picker.
    fn fold_head(
        &self,
        id: &'static str,
        label: SharedString,
        folded: bool,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let ink = theme.palette.ink(3).solid();
        div()
            .id(id)
            .role(gpui::Role::Button)
            .aria_label(label.clone())
            .aria_expanded(!folded)
            .mx_1()
            .px_3()
            .pt_1()
            .flex()
            .flex_row()
            .items_center()
            .cursor_pointer()
            .font_role(Role::Ui)
            .type_px(theme.scale.caption - 2.0, theme.scale.line_caption)
            .weight(weight::MEDIUM)
            .text_color(ink)
            .child(div().flex_1().child(label))
            .child(sand::icon(
                if folded {
                    Icon::ChevronRight
                } else {
                    Icon::ChevronDown
                },
                11.0,
                ink,
            ))
            .on_click(cx.listener(move |this, _, _, cx| {
                if id == "v3-mount-entries" {
                    this.folded.0 = !this.folded.0;
                } else {
                    this.folded.1 = !this.folded.1;
                }
                cx.notify();
            }))
            .into_any_element()
    }

    /// What a Tab can be mounted on: the outermost entries, the entries
    /// that hold entries (as their tree), the views, and the book while the
    /// project has one.
    fn mount_picker(
        &mut self,
        tab: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let book = self.host.book.clone();
        let Some(v) = book.v3() else {
            return div().into_any_element();
        };
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let current = tab
            .as_ref()
            .and_then(|id| v.project.tabs.iter().find(|t| &t.id == id))
            .map(|t| t.mount.clone());
        let weak = cx.entity().downgrade();
        let pick = |mount: TabMount| {
            let tab = tab.clone();
            let weak = weak.clone();
            move |_: &ClickEvent, _: &mut Window, cx: &mut App| {
                let _ = weak.update(cx, |this, cx| this.mount(tab.clone(), mount.clone(), cx));
            }
        };
        let mut menu = Menu::new("v3-mount-picker").width(MenuWidth::Wide).item(
            MenuItem::new(
                "v3-mount-root",
                Icon::Layers,
                t(cx, keys::v3_shell::OUTERMOST),
            )
            .checked(current == Some(TabMount::Root))
            .on_click(pick(TabMount::Root)),
        );
        menu = menu.child(separator(p)).child(self.fold_head(
            "v3-mount-entries",
            t(cx, keys::v3_tabs::ENTRIES),
            self.folded.0,
            window,
            cx,
        ));
        if !self.folded.0 {
            for e in v.entries.iter().filter(|e| v.has_below(&e.id)) {
                let mut depth = 0usize;
                let mut parent = e.parent.as_deref();
                while let Some(id) = parent {
                    depth += 1;
                    parent = v.entry(id).and_then(|p| p.parent.as_deref());
                }
                let (mark, color) = super::entry_target(&e.id)
                    .map(|t| book.mark(&t))
                    .unwrap_or((sand::Kind::Element, None));
                let mount = TabMount::Entry {
                    entry: e.id.clone(),
                };
                menu = menu.child(
                    div().pl(px(depth.min(8) as f32 * 14.0)).child(
                        MenuItem::new(
                            SharedString::from(format!("v3-mount-entry-{}", e.id)),
                            RowIcon::Mark(mark, color),
                            e.title.clone(),
                        )
                        .checked(current.as_ref() == Some(&mount))
                        .on_click(pick(mount)),
                    ),
                );
            }
        }
        menu = menu.child(separator(p)).child(self.fold_head(
            "v3-mount-views",
            t(cx, keys::v3_tabs::VIEWS),
            self.folded.1,
            window,
            cx,
        ));
        if !self.folded.1 {
            for tv in v.timeline_views.iter().filter(|tv| tv.deleted_at.is_none()) {
                let mount = TabMount::View {
                    view: tv.id.clone(),
                };
                menu = menu.item(
                    MenuItem::new(
                        SharedString::from(format!("v3-mount-view-{}", tv.id)),
                        Icon::LanesStagger,
                        tv.name.clone(),
                    )
                    .checked(current.as_ref() == Some(&mount))
                    .on_click(pick(mount)),
                );
            }
        }
        if v.project.book.is_some() {
            menu = menu.child(separator(p)).item(
                MenuItem::new(
                    "v3-mount-book",
                    RowIcon::Mark(sand::Kind::All, None),
                    t(cx, keys::v3_tabs::BOOK),
                )
                .checked(current == Some(TabMount::Book))
                .on_click(pick(TabMount::Book)),
            );
        }
        div()
            .id("v3-mount-scroll")
            .max_h(px(480.0))
            .overflow_y_scroll()
            .child(menu)
            .into_any_element()
    }

    /// The Tabs under 「更多」.
    fn more_list(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let book = self.host.book.clone();
        let Some(v) = book.v3() else {
            return div().into_any_element();
        };
        let labels: Vec<SharedString> = v
            .project
            .tabs
            .iter()
            .map(|t| t.name.clone().into())
            .collect();
        let shown = self.fitting(&labels, &[], window, cx);
        let mut menu = Menu::new("v3-tab-more");
        for tab in v.project.tabs[shown..].iter() {
            let id = tab.id.clone();
            let icon = match &tab.mount {
                TabMount::Root => RowIcon::Brush(Icon::Layers),
                TabMount::View { .. } => RowIcon::Brush(Icon::LanesStagger),
                TabMount::Book => RowIcon::Mark(sand::Kind::All, None),
                TabMount::Entry { entry } => {
                    let (mark, color) = super::entry_target(entry)
                        .map(|t| book.mark(&t))
                        .unwrap_or((sand::Kind::Element, None));
                    RowIcon::Mark(mark, color)
                }
            };
            menu = menu.item(
                MenuItem::new(
                    SharedString::from(format!("v3-tab-more-{}", tab.id)),
                    icon,
                    tab.name.clone(),
                )
                .current(self.selected.as_ref() == Some(&tab.id))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.popup = None;
                    this.choose(&id, cx);
                })),
            );
        }
        menu.into_any_element()
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
        if let Some(gone) = tabs::gone(v, &tab.mount) {
            let text = gone.text(tab, cx);
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
                    Button::new("v3-tab-remount", t(cx, keys::v3_tabs::REMOUNT))
                        .small()
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.popup = Some(Popup::Mount {
                                tab: Some(id.clone()),
                                at: window.mouse_position(),
                            });
                            cx.notify();
                        })),
                )
                .into_any_element();
        }
        match &tab.mount {
            TabMount::View { view } => tabs::view_list(&self.host, view, window, cx),
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
}

impl Render for Sidebar {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let book = self.host.book.clone();
        let Some(v) = book.v3() else {
            return div().into_any_element();
        };
        let mut content = div().flex().flex_col().min_h_0().size_full();
        content = content.child(self.tab_row(window, cx));
        let selected = self
            .selected
            .as_ref()
            .and_then(|id| v.project.tabs.iter().find(|t| &t.id == id))
            .cloned();
        let body = match selected {
            Some(tab) => self.body(&tab, window, cx),
            None => div().into_any_element(),
        };
        content = content.child(div().flex_1().min_h_0().px_2().py_2().child(body));
        if let Some(popup) = self.popup.clone() {
            let (at, inner) = match popup {
                Popup::Manage(at) => (at, self.manage_list(window, cx)),
                Popup::Mount { tab, at } => (at, self.mount_picker(tab, window, cx)),
                Popup::More(at) => (at, self.more_list(window, cx)),
            };
            // The Tab row's lists open under the row, so a long one has the
            // window's height to show in; 「更多」's under the pointer.
            let row = *overlay::use_bounds("v3-tab-row-bounds", window, cx).read(cx);
            let place = match (&self.popup, row) {
                (Some(Popup::Manage(_) | Popup::Mount { .. }), Some(row)) => Place::below(row, 4.0),
                _ => Place::Point(at),
            };
            let weak = cx.entity().downgrade();
            content = content.child(overlay::float(
                place,
                Layer::Popover,
                div()
                    .occlude()
                    .on_mouse_down_out(move |_, _, cx| {
                        let _ = weak.update(cx, |this, cx| this.close_popup(cx));
                    })
                    .child(inner),
            ));
        }
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
        content
            .child(
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
                    ),
            )
            .into_any_element()
    }
}
