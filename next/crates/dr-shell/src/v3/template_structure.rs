//! The template graph and level table in the filled left sidebar.
mod graph;

pub use graph::{Edge, EdgeKind, Graph, GraphLayout, paint_edges};

use crate::{
    book::{Book, v3::SettingSource},
    nav::{Open, Target},
    pages::PageViewHost,
    strings::t,
    v3::{self, Rendered, entry_target, page::EntryPage, tabs},
};
use dr_i18n::keys::{self, common, v3_levels as levels, v5_fill as fill};
use dr_ui::{
    Theme,
    components::{Button, IconButton, Pill, Segmented},
    sand::{Icon, KindMark},
    tokens::radius,
};
use dr_workspace::commands::v3::types::{EntryTemplate, TabMount};
use gpui::{prelude::*, *};
use serde_json::{Value, json};
use std::{collections::BTreeMap, rc::Rc};

#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum Face {
    #[default]
    Templates,
    Levels,
}

#[derive(Clone)]
struct LevelDrag {
    owner: EntityId,
    id: String,
    name: String,
}

struct QuickEdit {
    target: Target,
    content: Rendered,
}

pub struct Structure {
    host: PageViewHost,
    graph: Graph,
    layout: GraphLayout,
    face: Face,
    edit: Option<QuickEdit>,
}

impl Structure {
    pub fn new(host: PageViewHost) -> Self {
        let graph = host.book.v3().map(Graph::read).unwrap_or_default();
        let layout = host
            .book
            .v3()
            .map(|v| graph.position(v))
            .unwrap_or_default();
        Self {
            host,
            graph,
            layout,
            face: Face::Templates,
            edit: None,
        }
    }

    pub fn refresh(&mut self, book: Rc<Book>, cx: &mut Context<Self>) {
        if Rc::ptr_eq(&book, &self.host.book) {
            return;
        }
        self.host.book = book;
        self.graph = self.host.book.v3().map(Graph::read).unwrap_or_default();
        self.layout = self
            .host
            .book
            .v3()
            .map(|v| self.graph.position(v))
            .unwrap_or_default();
        if let Some(edit) = &self.edit {
            if !self.host.book.exists(&edit.target) {
                self.edit = None;
            } else if let Some(refresh) = &edit.content.refresh {
                refresh(self.host.book.clone(), cx);
            }
        }
        cx.notify();
    }

    pub fn select_template(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if let Ok(id) = id.parse() {
            self.face = Face::Templates;
            self.select(Target::Template(id), window, cx);
        }
    }

    pub fn dismiss_editor(&mut self, cx: &mut Context<Self>) {
        if self.edit.take().is_some() {
            cx.notify();
        }
    }

    fn select(&mut self, target: Target, window: &mut Window, cx: &mut Context<Self>) {
        let full_target = target.clone();
        let weak = cx.weak_entity();
        let full = Rc::new(move |window: &mut Window, cx: &mut App| {
            let _ = weak.update(cx, |structure, cx| {
                structure.open_full(full_target.clone(), window, cx);
            });
        });
        let part = match &target {
            Target::Template(id) => {
                v3::compact_template_editor(self.host.clone(), id.as_str(), full, window, cx)
            }
            Target::Entry { .. } => {
                let view = cx
                    .new(|cx| EntryPage::new_settings(self.host.clone(), target.clone(), full, cx));
                let handle = view.downgrade();
                Some(Rendered::new(view).on_refresh(move |book, cx| {
                    let _ = handle.update(cx, |page, cx| page.refresh(book, cx));
                }))
            }
            _ => None,
        };
        self.edit = part.map(|content| QuickEdit { target, content });
        cx.notify();
    }

    fn open_full(&mut self, target: Target, window: &mut Window, cx: &mut Context<Self>) {
        self.dismiss_editor(cx);
        let _ = self.host.workspace.update(cx, |ws, cx| {
            ws.open_alongside_fill(target, Open::KEEP, window, cx);
        });
    }

    pub fn state(&self) -> Value {
        json!({
            "face": if self.face == Face::Templates { "templates" } else { "levels" },
            "edit": self.edit.as_ref().map(|edit| edit.target.key()),
        })
    }

    pub(super) fn header(&self, cx: &mut Context<Self>) -> AnyElement {
        let host = self.host.clone();
        let weak = cx.weak_entity();
        div()
            .flex_none()
            .flex()
            .items_center()
            .gap_2()
            .child(
                Segmented::new(
                    "v5-structure-face",
                    [
                        t(cx, keys::v3_shell::TEMPLATES),
                        t(cx, keys::v3_shell::LEVEL_SWITCH),
                    ],
                    usize::from(self.face == Face::Levels),
                )
                .report_selected()
                .on_change(move |index, _, cx| {
                    let _ = weak.update(cx, |this, cx| {
                        this.face = if index == 0 {
                            Face::Templates
                        } else {
                            Face::Levels
                        };
                        this.dismiss_editor(cx);
                        cx.notify();
                    });
                }),
            )
            .child(div().flex_1())
            .child(
                Button::new(
                    "v5-structure-new-template",
                    t(cx, keys::v3_shell::NEW_TEMPLATE),
                )
                .small()
                .icon(Icon::Plus)
                .disabled(!v3::has_template_creator(cx))
                .on_click(move |_, window, cx| v3::create_template(host.clone(), window, cx)),
            )
            .into_any_element()
    }

    fn card(
        &self,
        template: &EntryTemplate,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = Theme::of(window, cx).palette;
        let mark = crate::book::v3::mark(template.mark.as_deref(), &template.id);
        let color = template.color.as_deref().and_then(crate::book::color_of);
        let id = template.id.clone();
        let node_id: SharedString = format!("v5-structure-template-{id}").into();
        let mut card = div()
            .id(node_id.clone())
            .debug_selector(move || node_id.to_string())
            .role(gpui::Role::Button)
            .aria_label(template.name.clone())
            .cursor_pointer()
            .flex()
            .flex_col()
            .px_2()
            .py_1()
            .w(px(graph::CARD_W))
            .rounded(px(radius::SM))
            .bg(p.page.solid())
            .border_1()
            .border_color(p.local_hairline())
            .hover(|style| style.border_color(p.ink(3).solid()))
            .on_click(cx.listener(move |this, _, window, cx| this.select_template(&id, window, cx)))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_1()
                    .h(px(24.0))
                    .child(
                        KindMark::new("template-mark", mark)
                            .when_some(color, |mark, color| mark.color(color)),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .child(template.name.clone()),
                    )
                    .child(
                        div().text_color(p.muted().solid()).child(
                            self.graph
                                .counts
                                .get(&template.id)
                                .copied()
                                .unwrap_or(0)
                                .to_string(),
                        ),
                    ),
            );
        for module in &template.modules {
            card = card.child(
                div()
                    .h(px(19.0))
                    .truncate()
                    .text_color(p.ink(3).solid())
                    .child(module.name.clone()),
            );
        }
        card.child(
            div()
                .flex()
                .flex_wrap()
                .gap_x(px(6.0))
                .text_size(px(10.0))
                .child(
                    div()
                        .text_color(p.ink(if template.level { 1 } else { 4 }).solid())
                        .child(t(cx, keys::v3_shell::LEVEL_SWITCH)),
                )
                .child(
                    div()
                        .text_color(
                            p.ink(if template.settings.accept == Some(true) {
                                1
                            } else {
                                4
                            })
                            .solid(),
                        )
                        .child(t(cx, levels::ACCEPT)),
                ),
        )
        .into_any_element()
    }

    fn templates(&self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let book = self.host.book.clone();
        let Some(v) = book.v3() else {
            return div().into_any_element();
        };
        let p = Theme::of(window, cx).palette;
        let layout = self.layout.cards.clone();
        let shape = GraphLayout {
            cards: layout,
            width: self.layout.width,
            height: self.layout.height,
        };
        let edges = self
            .graph
            .edges
            .iter()
            .map(|edge| Edge {
                from: edge.from.clone(),
                to: edge.to.clone(),
                kind: edge.kind,
                count: edge.count,
            })
            .collect::<Vec<_>>();
        let lines = canvas(
            |_, _, _| (),
            move |bounds, _, window, _| {
                paint_edges(&shape, &edges, bounds, 1.0, p.ink(2), window);
            },
        )
        .absolute()
        .inset_0();
        let mut board = div()
            .relative()
            .flex_none()
            .w(px(self.layout.width.max(12.0)))
            .h(px(self.layout.height.max(32.0)))
            .child(lines);
        for (id, [x, y, _, _]) in &self.layout.cards {
            if let Some(template) = v.template(id) {
                board = board.child(
                    div()
                        .absolute()
                        .left(px(*x))
                        .top(px(*y))
                        .child(self.card(template, window, cx)),
                );
            }
        }
        let mut loose = div()
            .flex_none()
            .flex()
            .flex_col()
            .gap_2()
            .p_2()
            .w(px(184.0));
        if !self.graph.unused.is_empty() {
            loose = loose.child(t(cx, fill::UNUSED_TEMPLATES));
            for id in &self.graph.unused {
                if let Some(template) = v.template(id) {
                    loose = loose.child(self.card(template, window, cx));
                }
            }
        }
        if !self.graph.untemplated.is_empty() {
            loose = loose.child(t(cx, fill::NO_TEMPLATE_ENTRIES));
            for id in &self.graph.untemplated {
                if let Some(entry) = v.entry(id) {
                    loose = loose.child(div().truncate().child(entry.title.clone()));
                }
            }
        }
        div()
            .flex()
            .flex_col()
            .size_full()
            .min_h_0()
            .child(
                div()
                    .flex()
                    .justify_end()
                    .gap_3()
                    .px_2()
                    .text_color(p.muted().solid())
                    .child(format!("━ {}", t(cx, fill::RESIDES)))
                    .child(format!("┄ {}", t(cx, fill::ATTACHED))),
            )
            .child(
                div()
                    .id("v5-structure-template-map")
                    .flex_1()
                    .min_h_0()
                    .overflow_scroll()
                    .child(div().flex().items_start().child(board).child(loose)),
            )
            .into_any_element()
    }

    fn move_row(&self, drag: &LevelDrag, parent: Option<&str>, cx: &mut Context<Self>) {
        if drag.owner != cx.entity_id() || !valid_move(&self.host.book, &drag.id, parent) {
            return;
        }
        let input = json!({ "book": self.host.book_id, "id": drag.id, "parent": parent });
        let Some(book) = self.host.book.v3() else {
            return;
        };
        let guard = book.guard_for(&input);
        let host = self.host.clone();
        let library = host.library.clone();
        let job = cx.background_spawn(async move {
            library.call_guarded(&dr_workspace::Actor::User, "entry.move", input, guard)
        });
        cx.spawn(async move |_, cx| {
            if let Err(error) = job.await {
                log::warn!("structure level move failed: {error}");
                cx.update(|cx| v3::level_switch::toast_save_failed(&host, cx));
            }
        })
        .detach();
    }

    fn levels(&self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let book = self.host.book.clone();
        let Some(v) = book.v3() else {
            return div().into_any_element();
        };
        let p = Theme::of(window, cx).palette;
        let headings = [
            keys::template_editor::NAME,
            keys::v3_shell::LEVEL_SWITCH,
            levels::ACCEPT,
            levels::HOME,
            keys::template_editor::CHILDREN,
            levels::DEFAULT_TEMPLATE,
            levels::DISPLAY,
            levels::AUTO_LINK,
        ];
        let widths = [152.0, 55.0, 120.0, 120.0, 140.0, 120.0, 90.0, 95.0, 103.0];
        let cell = |i: usize, text: SharedString, color: gpui::Hsla| {
            div()
                .w(px(widths[i]))
                .flex_none()
                .truncate()
                .px_1()
                .text_color(color)
                .child(text)
        };
        let row = || div().flex().items_center().gap_1().h(px(30.0));
        let mut table = div()
            .flex()
            .flex_col()
            .w(px(widths.iter().sum::<f32>() + 42.0))
            .child(
                row()
                    .children(
                        headings
                            .iter()
                            .enumerate()
                            .map(|(i, key)| cell(i, t(cx, *key), p.muted().solid())),
                    )
                    .child(cell(8, "Tab".into(), p.muted().solid())),
            );
        let owner = cx.entity_id();
        let moving_book = book.clone();
        table = table.child(
            row()
                .id("v5-structure-root")
                .role(gpui::Role::Group)
                .aria_label(t(cx, fill::TOP_LEVEL))
                .can_drop(move |value, _, _| {
                    value.downcast_ref::<LevelDrag>().is_some_and(|drag| {
                        drag.owner == owner && valid_move(&moving_book, &drag.id, None)
                    })
                })
                .drag_over::<LevelDrag>(move |s, _, _, _| s.bg(p.ink(4).alpha(0.12)))
                .on_drop(cx.listener(|this, drag: &LevelDrag, _, cx| this.move_row(drag, None, cx)))
                .child(t(cx, fill::TOP_LEVEL)),
        );
        for entry in &v.entries {
            let Some(level) = v
                .levels
                .get(&entry.id)
                .filter(|level| entry.level || level.settings.accept)
            else {
                continue;
            };
            let id = entry.id.clone();
            let to = id.clone();
            let can_parent = id.clone();
            let can_book = book.clone();
            let target = entry_target(&id);
            let mut counts = BTreeMap::new();
            for child in &level.children {
                let name = v.template_of(child).map(|t| t.name.as_str()).unwrap_or("·");
                *counts.entry(name).or_insert(0usize) += 1;
            }
            let below = counts
                .into_iter()
                .map(|(name, count)| format!("{name} {count}"))
                .chain((!level.members.is_empty()).then(|| format!("┄ {}", level.members.len())))
                .collect::<Vec<_>>()
                .join(" · ");
            let on = |state| t(cx, if state { levels::ON } else { levels::OFF });
            let title = |entry: &str| v.entry(entry).map(|e| e.title.clone()).unwrap_or_default();
            let tab = v.project.tabs.iter().find(|tab| {
                matches!(&tab.mount, TabMount::Entry { entry } if entry == &id) && tab.mount_valid
            });
            let values: [SharedString; 9] = [
                entry.title.clone().into(),
                on(entry.level),
                on(level.settings.accept),
                level
                    .settings
                    .home
                    .as_deref()
                    .map(title)
                    .unwrap_or_default()
                    .into(),
                below.into(),
                level
                    .settings
                    .default_template
                    .as_deref()
                    .and_then(|id| v.template(id))
                    .map(|t| t.name.clone())
                    .unwrap_or_default()
                    .into(),
                v3::page::display_name(&level.settings.display, cx),
                if entry.level {
                    on(level.settings.auto_link)
                } else {
                    "".into()
                },
                tab.map(|tab| tabs::mount_name(v, &tab.mount, cx))
                    .unwrap_or_default(),
            ];
            let color = |key| {
                match level.sources.get(key) {
                    Some(SettingSource::Override { entry }) if entry == &id => p.ink(1),
                    Some(SettingSource::Template { entry, .. }) if entry == &id => p.ink(2),
                    _ => p.ink(4),
                }
                .solid()
            };
            let colors = [
                p.ink(1).solid(),
                p.ink(1).solid(),
                color("accept"),
                color("home"),
                p.muted().solid(),
                color("default_template"),
                color("display"),
                color("auto_link"),
                p.ink(2).solid(),
            ];
            let row_id: SharedString = format!("v5-structure-level-{id}").into();
            table = table.child(
                row()
                    .id(row_id.clone())
                    .debug_selector(move || row_id.to_string())
                    .role(gpui::Role::Button)
                    .aria_label(entry.title.clone())
                    .cursor_pointer()
                    .border_t_1()
                    .border_color(p.local_hairline())
                    .on_click(cx.listener(move |this, _, window, cx| {
                        if let Some(target) = target.clone() {
                            this.select(target, window, cx);
                        }
                    }))
                    .on_drag(
                        LevelDrag {
                            owner,
                            id,
                            name: entry.title.clone(),
                        },
                        |drag, at, _, cx| {
                            let name: SharedString = drag.name.clone().into();
                            cx.new(|_| dr_ui::components::DraggedPill::new(Pill::new(name), at))
                        },
                    )
                    .can_drop(move |value, _, _| {
                        value.downcast_ref::<LevelDrag>().is_some_and(|drag| {
                            drag.owner == owner
                                && valid_move(&can_book, &drag.id, Some(&can_parent))
                        })
                    })
                    .drag_over::<LevelDrag>(move |s, _, _, _| s.bg(p.ink(4).alpha(0.12)))
                    .on_drop(cx.listener(move |this, drag: &LevelDrag, _, cx| {
                        this.move_row(drag, Some(&to), cx)
                    }))
                    .children(
                        values
                            .into_iter()
                            .enumerate()
                            .map(|(i, value)| cell(i, value, colors[i])),
                    ),
            );
        }
        div()
            .id("v5-structure-level-table")
            .size_full()
            .overflow_scroll()
            .child(table)
            .into_any_element()
    }

    fn edit_panel(&self, window: &Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let edit = self.edit.as_ref()?;
        let p = Theme::of(window, cx).palette;
        let mut card = div()
            .id("v5-structure-quick-editor")
            .absolute()
            .right_2()
            .top_2()
            .bottom_2()
            .w(px(362.0))
            .max_w_full()
            .flex()
            .flex_col()
            .occlude()
            .rounded(px(radius::SM))
            .bg(p.page.solid())
            .border_1()
            .border_color(p.local_hairline())
            .p_2();
        card = card.child(
            div().flex_none().flex().justify_end().child(
                IconButton::new("v5-structure-close-editor", Icon::Close)
                    .label(t(cx, common::CLOSE))
                    .on_click(cx.listener(|this, _, _, cx| this.dismiss_editor(cx))),
            ),
        );
        if let Target::Template(id) = &edit.target {
            let book = self.host.book.clone();
            if let Some(v) = book.v3() {
                for (kind, label) in [
                    (EdgeKind::Residence, fill::RESIDES),
                    (EdgeKind::Membership, fill::ATTACHED),
                ] {
                    let names = self
                        .graph
                        .edges
                        .iter()
                        .filter(|edge| edge.to == id.as_str() && edge.kind == kind)
                        .filter_map(|edge| {
                            v.template(&edge.from)
                                .map(|template| template.name.as_str())
                        })
                        .collect::<Vec<_>>()
                        .join(" · ");
                    card = card.child(
                        div()
                            .flex()
                            .gap_2()
                            .text_color(p.muted().solid())
                            .child(t(cx, label))
                            .child(if names.is_empty() {
                                "·".to_owned()
                            } else {
                                names
                            }),
                    );
                }
            }
        }
        Some(
            card.child(div().flex_1().min_h_0().child(edit.content.view.clone()))
                .into_any_element(),
        )
    }
}

impl Render for Structure {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let content = match self.face {
            Face::Templates => self.templates(window, cx),
            Face::Levels => self.levels(window, cx),
        };
        div()
            .id("v5-template-structure")
            .size_full()
            .flex()
            .flex_col()
            .min_h_0()
            .child(
                div()
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .child(content)
                    .children(self.edit_panel(window, cx)),
            )
    }
}

fn valid_move(book: &Book, entry: &str, parent: Option<&str>) -> bool {
    let Some(v) = book.v3() else {
        return false;
    };
    let Some(moving) = v.entry(entry) else {
        return false;
    };
    if moving.parent.as_deref() == parent {
        return false;
    }
    let Some(parent) = parent else {
        return true;
    };
    if !v.entry(parent).is_some_and(|entry| entry.level) {
        return false;
    }
    let mut ancestor = Some(parent);
    // Guard against a malformed chain before the command validates the move.
    for _ in 0..v.entries.len() {
        match ancestor {
            None => return true,
            Some(id) if id == entry => return false,
            Some(id) => ancestor = v.entry(id).and_then(|e| e.parent.as_deref()),
        }
    }
    ancestor.is_none()
}
