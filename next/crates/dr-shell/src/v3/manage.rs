//! What the left column shows while its Tabs are managed (`kernel-v5.md` §5,
//! the second Tab prototype, 2026-11-15): the project's structure.
//! 「全部」, the whole entry tree, and the book while the project has one.
//! What a Tab can be mounted on (the root, an entry with 「层级」 or
//! 「收别处的条目」 on, the book) and no Tab shows yet is lit with a glass
//! frame and drags into the Tab row to add a Tab; the rest is faint and does
//! not drag: leaves, and what a Tab already shows. A click adds nothing.
//! Views are not listed: a Tab cannot mount a view (DV, 2026-11-16, author:
//! 「左栏不能挂视图，视图和底栏是绑定的。」).
use super::entry_target;
use crate::{pages::PageViewHost, strings::t};
use dr_i18n::keys;
use dr_ui::{
    Theme,
    components::{DraggedPill, Pill, SandCell},
    fonts::{Role, weight},
    sand::{self, Icon},
    style::DrStyled,
};
use dr_workspace::commands::v3::types::TabMount;
use gpui::{prelude::*, *};
use std::{collections::BTreeSet, rc::Rc};

/// How far a level of the tree is indented.
const INDENT: f32 = 14.0;

/// Something from the structure dragged toward the Tab row.
#[derive(Clone)]
pub struct MountDrag {
    /// The column it came from.
    pub owner: EntityId,
    pub mount: TabMount,
    pub name: SharedString,
}

pub struct Structure {
    host: PageViewHost,
    /// The column this structure belongs to (what a drag carries).
    owner: EntityId,
    /// The 「条目」 section, folded.
    folded: bool,
    /// Entries whose own entries are folded away.
    shut: BTreeSet<String>,
}

impl Structure {
    pub fn new(host: PageViewHost, owner: EntityId) -> Self {
        Self {
            host,
            owner,
            folded: false,
            shut: BTreeSet::new(),
        }
    }

    /// Takes the latest book; redraws when it changed.
    pub fn sync(&mut self, host: PageViewHost, cx: &mut Context<Self>) {
        let changed = !Rc::ptr_eq(&self.host.book, &host.book) || self.host.book_id != host.book_id;
        if self.host.book_id != host.book_id {
            self.shut.clear();
            self.folded = false;
        }
        self.host = host;
        if changed {
            cx.notify();
        }
    }

    /// What the structure shows, for the debug bridge and tests: each row's
    /// id, whether it is lit (a Tab can be added from it) and its depth.
    pub fn state(&self) -> serde_json::Value {
        let Some(v) = self.host.book.v3() else {
            return serde_json::Value::Null;
        };
        let mut rows = vec![serde_json::json!({
            "row": "root", "lit": !self.mounted(&TabMount::Root), "depth": 0,
        })];
        if !self.folded {
            for (id, depth) in self.tree() {
                let lit = v.has_below(&id) && !self.mounted(&TabMount::Entry { entry: id.clone() });
                rows.push(serde_json::json!({ "row": id, "lit": lit, "depth": depth }));
            }
        }
        if v.project.book.is_some() {
            rows.push(serde_json::json!({
                "row": "book", "lit": !self.mounted(&TabMount::Book), "depth": 0,
            }));
        }
        serde_json::json!({ "rows": rows, "folded": [self.folded] })
    }

    /// Folds or opens the entry `id`'s own entries (tests and the bridge).
    pub fn toggle(&mut self, id: &str, cx: &mut Context<Self>) {
        if !self.shut.remove(id) {
            self.shut.insert(id.to_owned());
        }
        cx.notify();
    }

    fn mounted(&self, mount: &TabMount) -> bool {
        self.host
            .book
            .v3()
            .is_some_and(|v| v.project.tabs.iter().any(|t| &t.mount == mount))
    }

    /// The live entries in tree order, each with its depth, leaving out
    /// what lives under a folded entry. A cycle in the stored tree stops at
    /// the entry it comes back to.
    fn tree(&self) -> Vec<(String, usize)> {
        let Some(v) = self.host.book.v3() else {
            return Vec::new();
        };
        let mut out = Vec::new();
        let mut path: Vec<String> = Vec::new();
        fn walk(
            v: &crate::book::v3::BookV3,
            ids: &[String],
            depth: usize,
            shut: &BTreeSet<String>,
            path: &mut Vec<String>,
            out: &mut Vec<(String, usize)>,
        ) {
            for id in ids {
                if v.entry(id).is_none() || path.contains(id) {
                    continue;
                }
                out.push((id.clone(), depth));
                if shut.contains(id) {
                    continue;
                }
                if let Some(level) = v.levels.get(id) {
                    path.push(id.clone());
                    walk(v, &level.children, depth + 1, shut, path, out);
                    path.pop();
                }
            }
        }
        walk(v, &v.roots, 0, &self.shut, &mut path, &mut out);
        out
    }

    /// A section head: its name and the fold chevron at its right end.
    fn section_head(
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
            .px(px(10.0))
            .pt_2()
            .pb_1()
            .flex()
            .flex_row()
            .items_center()
            .cursor_pointer()
            .font_role(Role::Ui)
            .type_px(theme.scale.caption, theme.scale.line_caption)
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
                this.folded = !this.folded;
                cx.notify();
            }))
            .into_any_element()
    }

    /// One row: lit and draggable when `mount` can be added, faint
    /// otherwise. `fold` is `Some(open)` for an entry with entries under it.
    #[allow(clippy::too_many_arguments)]
    fn row(
        &self,
        id: String,
        cell: SandCell,
        depth: usize,
        fold: Option<bool>,
        mount: Option<TabMount>,
        name: SharedString,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let ink = theme.palette.ink(3).solid();
        let lit = mount.as_ref().is_some_and(|m| !self.mounted(m));
        let lead_id = SharedString::from(format!("v3-structure-fold-{id}"));
        let fold_id = id.clone();
        let lead = div()
            .id(lead_id)
            .w(px(12.0))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .when_some(fold, |el, open| {
                el.cursor_pointer()
                    .child(sand::icon(
                        if open {
                            Icon::ChevronDown
                        } else {
                            Icon::ChevronRight
                        },
                        10.0,
                        ink,
                    ))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        cx.stop_propagation();
                        this.toggle(&fold_id, cx);
                    }))
            });
        let owner = self.owner;
        div()
            .id(SharedString::from(format!("v3-structure-row-{id}")))
            // A row is read out by its name, like the rows of a level's list.
            .role(gpui::Role::Group)
            .aria_label(name.clone())
            .pl(px(depth.min(8) as f32 * INDENT))
            .child(cell.lead(lead).selected(lit))
            .when(!lit, |el| el.opacity(0.45))
            .when_some(mount.filter(|_| lit), |el, mount| {
                el.cursor_grab().on_drag(
                    MountDrag {
                        owner,
                        mount,
                        name: name.clone(),
                    },
                    |drag, _, window, cx| {
                        let at = window.mouse_position();
                        cx.new(|_| DraggedPill::new(Pill::new(drag.name.clone()), at))
                    },
                )
            })
            .into_any_element()
    }
}

impl Render for Structure {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let book = self.host.book.clone();
        let Some(v) = book.v3() else {
            return div().into_any_element();
        };
        let all = t(cx, keys::v3_shell::OUTERMOST);
        let mut list = div()
            .id("v3-structure")
            .size_full()
            .overflow_y_scroll()
            .px_2()
            .pb_2()
            .flex()
            .flex_col()
            .child(self.row(
                "root".into(),
                SandCell::new("v3-structure-root", all.clone()).icon(Icon::Layers),
                0,
                None,
                Some(TabMount::Root),
                all,
                window,
                cx,
            ));
        list = list.child(self.section_head(
            "v3-structure-entries",
            t(cx, keys::v3_tabs::ENTRIES),
            self.folded,
            window,
            cx,
        ));
        if !self.folded {
            for (id, depth) in self.tree() {
                let Some(entry) = v.entry(&id) else {
                    continue;
                };
                let (mark, color) = entry_target(&id)
                    .map(|target| book.mark(&target))
                    .unwrap_or((sand::Kind::Element, None));
                let has_children = v.levels.get(&id).is_some_and(|l| !l.children.is_empty());
                let mount = v
                    .has_below(&id)
                    .then(|| TabMount::Entry { entry: id.clone() });
                let cell = SandCell::new(
                    SharedString::from(format!("v3-structure-entry-{id}")),
                    entry.title.clone(),
                )
                .mark(mark)
                .color_opt(color);
                let name: SharedString = entry.title.clone().into();
                let fold = has_children.then(|| !self.shut.contains(&id));
                list = list.child(self.row(id, cell, depth, fold, mount, name, window, cx));
            }
        }
        if v.project.book.is_some() {
            let name = t(cx, keys::v3_tabs::BOOK);
            list = list.child(div().pt_2()).child(self.row(
                "book".into(),
                SandCell::new("v3-structure-book", name.clone()).mark(sand::Kind::All),
                0,
                None,
                Some(TabMount::Book),
                name,
                window,
                cx,
            ));
        }
        list.into_any_element()
    }
}
