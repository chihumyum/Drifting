//! The template graph and level table in the filled left sidebar
//! (`W12Template`, `kernel-v5.md` §9).
mod graph;

pub use graph::{
    Below, CARD_W, Edge, EdgeKind, Graph, GraphLayout, Route, Stroke, below, card_height, line_ink,
    paint_route, width,
};

use crate::{
    book::{
        Book,
        v3::{BookV3, SettingSource},
    },
    nav::{Open, Target},
    pages::PageViewHost,
    strings::{t, tf, tp},
    v3::{self, CompactTemplate, Rendered, entry_target, page::EntryPage, tabs},
};
use dr_i18n::keys::{self, common, template_editor as k5, v3_levels as levels, v5_fill};
use dr_ui::{
    Theme,
    components::{Button, IconButton, Pill, Segmented},
    fonts::Role,
    glass::{self, Kind, Mode, Spec, Tone},
    sand::{self, Icon, KindMark, SandMask},
    style::DrStyled,
    tokens::radius,
};
use dr_workspace::commands::v3::types::{EntryTemplate, TabMount};
use gpui::{prelude::*, *};
use serde_json::{Value, json};
use std::{
    collections::{BTreeSet, HashSet},
    rc::Rc,
};

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
    /// `None`: a new template, not stored until the author changes
    /// something in it.
    target: Option<Target>,
    serial: u64,
    content: Rendered,
}

/// The floating panel's width (and how far the legend steps aside for it).
const PANEL_W: f32 = 362.0;

pub struct Structure {
    host: PageViewHost,
    graph: Graph,
    layout: GraphLayout,
    face: Face,
    edit: Option<QuickEdit>,
    serial: u64,
    /// The lines the legend hides (click a legend row, `W12Template`).
    hidden: BTreeSet<EdgeKind>,
    /// The card under the pointer: its lines come forward.
    hover: Option<String>,
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
            serial: 0,
            hidden: BTreeSet::new(),
            hover: None,
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
            match &edit.target {
                // Its thing is gone: nothing to store.
                Some(target) if !self.host.book.exists(target) => self.edit = None,
                _ => {
                    if let Some(refresh) = &edit.content.refresh {
                        refresh(self.host.book.clone(), cx);
                    }
                }
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

    /// 「新建模板」 (`kernel-v5.md` §9): a new template in the floating
    /// panel. Nothing is stored until the author changes something; closed
    /// untouched it leaves nothing behind.
    pub fn new_template(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.face = Face::Templates;
        self.dismiss_editor(cx);
        let serial = self.next_serial();
        let content = self.compact(None, serial, window, cx);
        self.edit = content.map(|content| QuickEdit {
            target: None,
            serial,
            content,
        });
        cx.notify();
    }

    /// Takes the floating panel away; what it holds is stored, not dropped
    /// (its `leave`).
    pub fn dismiss_editor(&mut self, cx: &mut Context<Self>) {
        if let Some(edit) = self.edit.take() {
            if let Some(leave) = &edit.content.leave {
                leave(cx);
            }
            cx.notify();
        }
    }

    /// Esc: the floating panel closes, and only it. Whether one was open.
    pub fn close_panel(&mut self, cx: &mut Context<Self>) -> bool {
        let open = self.edit.is_some();
        self.dismiss_editor(cx);
        open
    }

    /// What the floating panel shows, while it is open.
    pub fn panel(&self) -> Option<AnyView> {
        self.edit.as_ref().map(|edit| edit.content.view.clone())
    }

    /// 模板｜层级 (the header's switch).
    pub fn show_levels(&mut self, levels: bool, cx: &mut Context<Self>) {
        let face = if levels {
            Face::Levels
        } else {
            Face::Templates
        };
        if self.face != face {
            self.face = face;
            self.dismiss_editor(cx);
            cx.notify();
        }
    }

    /// The panel closes and the keyboard, which may have been in it, goes
    /// back to the workspace (so the next Esc reaches the fill).
    fn close_and_refocus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.close_panel(cx) {
            let _ = self
                .host
                .workspace
                .update(cx, |ws, cx| ws.refocus(window, cx));
        }
    }

    pub fn is_hidden(&self, kind: EdgeKind) -> bool {
        self.hidden.contains(&kind)
    }

    pub fn toggle_hidden(&mut self, kind: EdgeKind, cx: &mut Context<Self>) {
        if !self.hidden.remove(&kind) {
            self.hidden.insert(kind);
        }
        cx.notify();
    }

    fn next_serial(&mut self) -> u64 {
        self.serial += 1;
        self.serial
    }

    fn select(&mut self, target: Target, window: &mut Window, cx: &mut Context<Self>) {
        // A second click on what is open closes it (`W12Template`).
        if self.edit.as_ref().and_then(|e| e.target.as_ref()) == Some(&target) {
            self.dismiss_editor(cx);
            return;
        }
        self.dismiss_editor(cx);
        let serial = self.next_serial();
        let part = match &target {
            Target::Template(id) => self.compact(Some(id.to_string()), serial, window, cx),
            Target::Entry { .. } => {
                let full_target = target.clone();
                let weak = cx.weak_entity();
                let full = Rc::new(move |window: &mut Window, cx: &mut App| {
                    let _ = weak.update(cx, |structure, cx| {
                        structure.open_full(full_target.clone(), window, cx);
                    });
                });
                let view = cx
                    .new(|cx| EntryPage::new_settings(self.host.clone(), target.clone(), full, cx));
                let handle = view.downgrade();
                Some(Rendered::new(view).on_refresh(move |book, cx| {
                    let _ = handle.update(cx, |page, cx| page.refresh(book, cx));
                }))
            }
            _ => None,
        };
        self.edit = part.map(|content| QuickEdit {
            target: Some(target),
            serial,
            content,
        });
        cx.notify();
    }

    fn compact(
        &self,
        template: Option<String>,
        serial: u64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<Rendered> {
        let weak = cx.weak_entity();
        let full = {
            let weak = weak.clone();
            Rc::new(move |id: String, window: &mut Window, cx: &mut App| {
                let Ok(id) = id.parse() else {
                    return;
                };
                let _ = weak.update(cx, |structure, cx| {
                    structure.open_full(Target::Template(id), window, cx);
                });
            })
        };
        let close = {
            let weak = weak.clone();
            Rc::new(move |window: &mut Window, cx: &mut App| {
                let _ = weak.update(cx, |structure, cx| structure.close_and_refocus(window, cx));
            })
        };
        let created = Rc::new(move |id: String, cx: &mut App| {
            let _ = weak.update(cx, |structure, cx| {
                if let Some(edit) = structure
                    .edit
                    .as_mut()
                    .filter(|edit| edit.serial == serial && edit.target.is_none())
                {
                    edit.target = id.parse().ok().map(Target::Template);
                    cx.notify();
                }
            });
        });
        v3::compact_template_editor(
            CompactTemplate {
                page: self.host.clone(),
                template,
                full,
                close,
                created,
            },
            window,
            cx,
        )
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
            "edit": self.edit.as_ref().map(|edit| {
                edit.target.as_ref().map_or_else(|| "template:new".to_owned(), Target::key)
            }),
            "hidden": self.hidden.iter().map(|kind| match kind {
                EdgeKind::Residence => "residence",
                EdgeKind::Membership => "membership",
            }).collect::<Vec<_>>(),
        })
    }

    fn selected_template(&self) -> Option<String> {
        match self.edit.as_ref()?.target.as_ref()? {
            Target::Template(id) => Some(id.to_string()),
            _ => None,
        }
    }

    /// The header beside the Tabs: 模板｜层级, the counts, 「新建模板」.
    pub(super) fn header(&self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let p = Theme::of(window, cx).palette;
        let host = self.host.clone();
        let weak = cx.weak_entity();
        let meta = self
            .host
            .book
            .v3()
            .map(|v| match self.face {
                Face::Templates => template_meta(v, cx),
                Face::Levels => level_meta(v, cx),
            })
            .unwrap_or_default();
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
            .child(
                div()
                    .id("v5-structure-meta")
                    .debug_selector(|| "v5-structure-meta".into())
                    .role(gpui::Role::Label)
                    .aria_label(meta.clone())
                    .ml(px(6.0))
                    .whitespace_nowrap()
                    .font_role(Role::Index)
                    .type_px(13.0, 18.0)
                    .text_color(p.ink(4).solid())
                    .child(meta),
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
        v: &BookV3,
        template: &EntryTemplate,
        far: bool,
        loose: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = Theme::of(window, cx).palette;
        let mark = crate::book::v3::mark(template.mark.as_deref(), &template.id);
        let color = template.color.as_deref().and_then(crate::book::color_of);
        let id = template.id.clone();
        let hover_id = template.id.clone();
        let node_id: SharedString = format!("v5-structure-template-{id}").into();
        let selector = node_id.clone();
        let selected = self.selected_template().as_deref() == Some(template.id.as_str());
        let mono = |text: SharedString, ink: usize| {
            div()
                .max_w_full()
                .truncate()
                .font_role(Role::Index)
                .type_px(12.0, 19.0)
                .text_color(p.ink(ink).solid())
                .child(text)
        };
        let mut card = glass::glass_box(
            node_id,
            Kind::Rest,
            Mode::default(),
            selected,
            Spec::new(Tone::Clear, 3.0).filled(p.page),
            window,
            cx,
        )
        .debug_selector(move || selector.to_string())
        .role(gpui::Role::Button)
        .aria_label(template.name.clone())
        .cursor_pointer()
        .flex()
        .flex_col()
        .w(px(graph::CARD_W))
        .pb(px(6.0))
        .rounded(px(3.0))
        .bg(p.page.solid())
        .when(far, |card| card.opacity(0.36))
        .on_click(cx.listener(move |this, _, window, cx| {
            cx.stop_propagation();
            this.select_template(&id, window, cx);
        }))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.0))
                .h(px(28.0))
                .px(px(10.0))
                .child(
                    div().when(loose, |el| el.opacity(0.55)).child(
                        KindMark::new(
                            SharedString::from(format!("template-mark-{}", template.id)),
                            mark,
                        )
                        .when_some(color, |mark, color| mark.color(color)),
                    ),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .font_role(Role::Ui)
                        .font_weight(FontWeight::SEMIBOLD)
                        .type_px(14.0, 20.0)
                        .text_color(p.ink(1).solid())
                        .child(template.name.clone()),
                )
                .child(
                    div()
                        .font_role(Role::Index)
                        .type_px(13.0, 13.0)
                        .text_color(p.ink(4).solid())
                        .child(
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
            let kind = module_kind(&module.kind, cx);
            card = card.child(
                div()
                    .flex()
                    .justify_between()
                    .gap(px(8.0))
                    .h(px(18.0))
                    .px(px(10.0))
                    .type_px(13.0, 18.0)
                    .text_color(p.ink(2).solid())
                    .child(div().min_w_0().truncate().child(module.name.clone()))
                    // The kind only where the name does not already say it.
                    .when(kind.as_ref() != module.name.as_str(), |row| {
                        row.child(mono(kind, 4).type_px(12.0, 18.0))
                    }),
            );
        }
        let switch = |on: bool, label| mono(t(cx, label), if on { 2 } else { 5 });
        card = card.child(
            div()
                .flex()
                .flex_wrap()
                .gap_x(px(10.0))
                .mt(px(4.0))
                .pt(px(4.0))
                .px(px(10.0))
                .border_t_1()
                .border_color(p.local_hairline())
                .child(switch(template.level, keys::v3_shell::LEVEL_SWITCH))
                .child(switch(
                    template.settings.accept == Some(true),
                    levels::ACCEPT,
                ))
                .children(graph::home(template).map(|home| {
                    let name = v.entry(home).map(|e| e.title.clone()).unwrap_or_default();
                    mono(tf(cx, v5_fill::LIVES_IN_NAME, &[("name", &name)]), 4)
                })),
        );
        let items = below(template);
        if !items.is_empty() {
            let mut row = div()
                .flex()
                .flex_wrap()
                .gap_x(px(10.0))
                .px(px(10.0))
                .child(mono(t(cx, v5_fill::BELOW), 4));
            for item in items {
                let text: SharedString = match item {
                    Below::New(id) => format!(
                        "＋{}",
                        v.template(&id).map(|t| t.name.as_str()).unwrap_or("·")
                    )
                    .into(),
                    Below::Display(display) => v3::page::display_name(&display, cx),
                    Below::AutoLink => t(cx, levels::AUTO_LINK),
                    Below::Inherit => t(cx, k5::INHERIT),
                };
                row = row.child(mono(text, 2));
            }
            card = card.child(row);
        }
        // The glass answers the pointer itself; the card's lines come
        // forward from a wrapper around it.
        div()
            .id(SharedString::from(format!(
                "v5-structure-template-hover-{hover_id}"
            )))
            .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                if *hovered {
                    this.hover = Some(hover_id.clone());
                } else if this.hover.as_deref() == Some(hover_id.as_str()) {
                    this.hover = None;
                }
                cx.notify();
            }))
            .child(card)
            .into_any_element()
    }

    fn templates(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let book = self.host.book.clone();
        let Some(v) = book.v3() else {
            return div().into_any_element();
        };
        let p = Theme::of(window, cx).palette;
        // The card under the pointer, else the one open in the panel, and
        // the cards its shown lines reach.
        let focus = self.hover.clone().or_else(|| self.selected_template());
        let mut near = HashSet::new();
        let mut lines = Vec::new();
        let mut labels = Vec::new();
        let ink = line_ink(p);
        for edge in &self.graph.edges {
            if self.hidden.contains(&edge.kind) {
                continue;
            }
            let Some(route) = Route::of(&self.layout, edge) else {
                continue;
            };
            let touch = focus
                .as_deref()
                .is_some_and(|f| edge.from == f || edge.to == f);
            if touch {
                near.insert(edge.from.clone());
                near.insert(edge.to.clone());
            }
            let (color, label_ink, label_alpha) = match (&focus, touch) {
                (Some(_), true) => (p.ink(1).solid(), 1, 1.0),
                (Some(_), false) => (ink.alpha(0.78 * 0.14), 3, 0.18),
                (None, _) => (ink.alpha(0.78), 3, 1.0),
            };
            lines.push((
                route,
                edge.kind,
                Stroke {
                    color,
                    width: width(edge),
                    dot: true,
                    thin: false,
                },
            ));
            labels.push((route.label, edge.count, label_ink, label_alpha));
        }
        let canvas = canvas(
            |_, _, _| (),
            move |bounds, _, window, _| {
                for (route, kind, stroke) in &lines {
                    paint_route(route, *kind, *stroke, bounds, 1.0, window);
                }
            },
        )
        .absolute()
        .inset_0();
        let mut board = div()
            .id("v5-structure-board")
            .relative()
            .flex_none()
            .w(px(self.layout.width.max(12.0)))
            .h(px(self.layout.height.max(32.0)))
            .child(canvas);
        for ((x, y), count, ink, alpha) in labels {
            board = board.child(
                div()
                    .absolute()
                    .left(px(x - 30.0))
                    .top(px(y - 7.0))
                    .w(px(60.0))
                    .flex()
                    .justify_center()
                    .opacity(alpha)
                    .child(
                        div()
                            .px(px(3.0))
                            .bg(p.desk.solid())
                            .font_role(Role::Index)
                            .type_px(11.0, 14.0)
                            .text_color(p.ink(ink).solid())
                            .child(count.to_string()),
                    ),
            );
        }
        let cards: Vec<_> = self
            .layout
            .cards
            .iter()
            .map(|(id, rect)| (id.clone(), *rect))
            .collect();
        for (id, [x, y, _, _]) in cards {
            if let Some(template) = v.template(&id) {
                let far = focus
                    .as_deref()
                    .is_some_and(|f| f != id && !near.contains(&id));
                let card = self.card(v, template, far, false, window, cx);
                board = board.child(div().absolute().left(px(x)).top(px(y)).child(card));
            }
        }
        let tray_label = |text: SharedString| {
            div()
                .font_role(Role::Index)
                .type_px(13.0, 18.0)
                .text_color(p.ink(4).solid())
                .whitespace_nowrap()
                .child(text)
        };
        let mut loose = div()
            .flex_none()
            .flex()
            .flex_col()
            .gap(px(8.0))
            .pt(px(12.0))
            .pr(px(20.0))
            .w(px(graph::CARD_W + 20.0));
        if !self.graph.unused.is_empty() {
            loose = loose.child(tray_label(t(cx, v5_fill::UNUSED_TEMPLATES)));
            for id in self.graph.unused.clone() {
                if let Some(template) = v.template(&id) {
                    let far = focus.as_deref().is_some_and(|f| f != id);
                    loose = loose.child(self.card(v, template, far, true, window, cx));
                }
            }
        }
        if !self.graph.untemplated.is_empty() {
            loose = loose.child(tray_label(t(cx, v5_fill::NO_TEMPLATE_ENTRIES)));
            for id in &self.graph.untemplated {
                let Some(entry) = v.entry(id) else {
                    continue;
                };
                let (mark, color) = entry_target(id)
                    .map(|target| book.mark(&target))
                    .unwrap_or((sand::Kind::Element, None));
                loose = loose.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .h(px(28.0))
                        .px(px(10.0))
                        .type_px(14.0, 20.0)
                        .text_color(p.ink(2).solid())
                        .child(
                            div().opacity(0.55).child(
                                KindMark::new(SharedString::from(format!("stray-{id}")), mark)
                                    .when_some(color, |mark, color| mark.color(color)),
                            ),
                        )
                        .child(div().min_w_0().truncate().child(entry.title.clone())),
                );
            }
        }
        div()
            .relative()
            .size_full()
            .min_h_0()
            .child(
                div()
                    .id("v5-structure-template-map")
                    .size_full()
                    .overflow_scroll()
                    // A click on the board's ground closes the panel.
                    .on_click(cx.listener(|this, _, _, cx| this.dismiss_editor(cx)))
                    .child(div().flex().items_start().child(board).child(loose)),
            )
            .child(self.legend(window, cx))
            .into_any_element()
    }

    /// Top right: a line of each kind, its name and how many there are;
    /// a click hides or shows them (`W12Template`).
    fn legend(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let p = Theme::of(window, cx).palette;
        let ink = line_ink(p);
        let right = if self.edit.is_some() {
            8.0 + PANEL_W + 14.0
        } else {
            16.0
        };
        let mut legend = glass::glass_box(
            "v5-structure-legend",
            Kind::Rest,
            Mode::default(),
            false,
            Spec::new(Tone::Clear, 3.0).filled(p.page),
            window,
            cx,
        )
        .absolute()
        .top(px(10.0))
        .right(px(right))
        .w(px(graph::CARD_W))
        .py(px(5.0))
        .rounded(px(3.0))
        .bg(p.page.solid())
        .occlude();
        for (kind, label, slug) in [
            (EdgeKind::Residence, v5_fill::RESIDES, "residence"),
            (EdgeKind::Membership, v5_fill::ATTACHED, "membership"),
        ] {
            let hidden = self.hidden.contains(&kind);
            let sample_alpha = if hidden { 0.25 } else { 1.0 };
            let sample = canvas(
                |_, _, _| (),
                move |bounds, _, window, _| {
                    let y = bounds.center().y;
                    let color = ink.alpha(sample_alpha);
                    if kind == EdgeKind::Residence {
                        window.paint_quad(gpui::fill(
                            Bounds::new(
                                point(bounds.origin.x, y - px(1.0)),
                                size(bounds.size.width, px(2.0)),
                            ),
                            color,
                        ));
                    } else {
                        let mut x = bounds.origin.x + px(1.0);
                        while x < bounds.right() {
                            window.paint_quad(
                                gpui::fill(
                                    Bounds::new(
                                        point(x - px(1.0), y - px(1.0)),
                                        size(px(2.0), px(2.0)),
                                    ),
                                    color,
                                )
                                .corner_radii(px(1.0)),
                            );
                            x += px(4.0);
                        }
                    }
                },
            )
            .flex_none()
            .w(px(22.0))
            .h(px(4.0));
            let label = t(cx, label);
            let selector: SharedString = format!("v5-structure-legend-{slug}").into();
            let debug = selector.clone();
            legend = legend.child(
                div()
                    .id(selector)
                    .debug_selector(move || debug.to_string())
                    .role(gpui::Role::CheckBox)
                    .aria_label(label.clone())
                    .aria_toggled(if hidden {
                        gpui::Toggled::False
                    } else {
                        gpui::Toggled::True
                    })
                    .cursor_pointer()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .h(px(26.0))
                    .px(px(10.0))
                    .type_px(14.0, 20.0)
                    .text_color(p.ink(if hidden { 4 } else { 2 }).solid())
                    .on_click(cx.listener(move |this, _, _, cx| this.toggle_hidden(kind, cx)))
                    .child(sample)
                    .child(label)
                    .child(
                        div()
                            .ml_auto()
                            .font_role(Role::Index)
                            .type_px(13.0, 13.0)
                            .text_color(p.ink(4).solid())
                            .child(self.graph.lines(kind).to_string()),
                    ),
            );
        }
        legend.into_any_element()
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

    fn levels(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let book = self.host.book.clone();
        let Some(v) = book.v3() else {
            return div().into_any_element();
        };
        let p = Theme::of(window, cx).palette;
        // `W12Template`: the name column has no heading.
        let headings = [
            keys::v3_shell::LEVEL_SWITCH,
            levels::ACCEPT,
            levels::HOME,
            v5_fill::BELOW,
            v5_fill::NEW_DEFAULT,
            levels::DISPLAY,
            levels::AUTO_LINK,
        ];
        const NAME_W: f32 = 230.0;
        const WIDTHS: [f32; 8] = [52.0, 100.0, 84.0, 150.0, 76.0, 56.0, 72.0, 60.0];
        let total = NAME_W + WIDTHS.iter().sum::<f32>() + 20.0;
        let row = || {
            div()
                .relative()
                .flex()
                .flex_none()
                .items_center()
                .w(px(total))
                .px(px(10.0))
                .rounded(px(2.0))
                .whitespace_nowrap()
        };
        let mut head = row()
            .h(px(26.0))
            .font_role(Role::Index)
            .type_px(12.0, 12.0)
            .text_color(p.ink(4).solid())
            .child(div().w(px(NAME_W)).flex_none());
        // A heading longer than its column (another language) is cut, not
        // laid over the next one.
        for (i, key) in headings.iter().enumerate() {
            head = head.child(
                div()
                    .w(px(WIDTHS[i]))
                    .flex_none()
                    .pr(px(4.0))
                    .truncate()
                    .child(t(cx, *key)),
            );
        }
        head = head.child(div().w(px(WIDTHS[7])).flex_none().child("Tab"));
        let mut table = div()
            .flex()
            .flex_col()
            .pl(px(24.0))
            .pt(px(14.0))
            .pb(px(24.0))
            .child(head);
        let owner = cx.entity_id();
        let rows = level_rows(v);
        let open = self.edit.as_ref().and_then(|e| e.target.as_ref()).cloned();
        let on = t(cx, v5_fill::CELL_ON);
        let off = t(cx, v5_fill::CELL_OFF);
        for (index, (id, depth)) in rows.iter().enumerate() {
            let Some(entry) = v.entry(id) else {
                continue;
            };
            let Some(level) = v.levels.get(id) else {
                continue;
            };
            // A new group of the outermost: a gap with a hairline in it.
            if *depth == 0 && index > 0 {
                table = table.child(
                    div()
                        .h(px(10.0))
                        .w(px(total))
                        .flex()
                        .items_center()
                        .child(div().w_full().h(px(0.5)).bg(p.local_hairline())),
                );
            }
            let target = entry_target(id);
            let selected = open.is_some() && open == target;
            let source = |key: &str| match level.sources.get(key) {
                Some(SettingSource::Override { entry }) if entry == id => Cell::Own,
                Some(SettingSource::Template { entry, .. }) if entry == id => Cell::Plain,
                _ => Cell::Up,
            };
            let title = |entry: &str| v.entry(entry).map(|e| e.title.clone()).unwrap_or_default();
            let tab = v.project.tabs.iter().find(|tab| {
                matches!(&tab.mount, TabMount::Entry { entry } if entry == id) && tab.mount_valid
            });
            let nil = || (SharedString::from("·"), Cell::No);
            let cells: [(SharedString, Cell); 8] = [
                (
                    if entry.level { on.clone() } else { off.clone() },
                    Cell::Plain,
                ),
                if level.settings.accept {
                    (on.clone(), source("accept"))
                } else {
                    nil()
                },
                match level.settings.home.as_deref() {
                    Some(home) => (title(home).into(), source("home")),
                    None => nil(),
                },
                match below_summary(v, id, cx) {
                    Some(text) => (text, Cell::Mono),
                    None => nil(),
                },
                match level
                    .settings
                    .default_template
                    .as_deref()
                    .and_then(|id| v.template(id))
                {
                    Some(template) => (template.name.clone().into(), source("default_template")),
                    None => nil(),
                },
                (
                    v3::page::display_name(&level.settings.display, cx),
                    source("display"),
                ),
                // A row whose level is off has nothing to link below it.
                if !entry.level {
                    (SharedString::default(), Cell::Plain)
                } else if level.settings.auto_link {
                    (on.clone(), source("auto_link"))
                } else {
                    nil()
                },
                match tab {
                    Some(tab) => (tabs::mount_name(v, &tab.mount, cx), Cell::Plain),
                    None => nil(),
                },
            ];
            let (mark, color) = target
                .as_ref()
                .map(|target| book.mark(target))
                .unwrap_or((sand::Kind::Element, None));
            let template_name = v
                .template_of(id)
                .map(|t| SharedString::from(t.name.clone()))
                .unwrap_or_default();
            let name_id: SharedString = format!("v5-structure-level-name-{id}").into();
            let name_selector = name_id.clone();
            let mut name = div()
                .id(name_id)
                .debug_selector(move || name_selector.to_string())
                .w(px(NAME_W))
                .flex_none()
                .flex()
                .items_center()
                .gap(px(7.0))
                .min_w_0()
                .overflow_hidden()
                .pl(px(20.0 * (*depth).min(2) as f32))
                .child({
                    let selector: SharedString = format!("v5-structure-level-mark-{id}").into();
                    div()
                        .id(selector.clone())
                        .debug_selector(move || selector.to_string())
                        .flex_none()
                        .child(
                            KindMark::new(SharedString::from(format!("level-mark-{id}")), mark)
                                .when_some(color, |mark, color| mark.color(color)),
                        )
                })
                .child(
                    div()
                        .min_w_0()
                        .truncate()
                        .text_color(p.ink(1).solid())
                        .when(*depth == 0, |el| {
                            el.font_role(Role::Structure).type_px(15.0, 20.0)
                        })
                        .child(entry.title.clone()),
                );
            if !template_name.is_empty() {
                name = name.child(
                    div()
                        .flex_none()
                        .font_role(Role::Index)
                        .type_px(12.0, 12.0)
                        .text_color(p.ink(4).solid())
                        .child(template_name),
                );
            }
            let mut line = row()
                .h(px(30.0))
                .type_px(13.0, 20.0)
                .text_color(p.ink(2).solid())
                .child(name);
            for (i, (value, cell)) in cells.into_iter().enumerate() {
                line = line.child(cell.draw(
                    SharedString::from(format!("v5-structure-cell-{id}-{i}")),
                    value,
                    WIDTHS[i],
                    p,
                ));
            }
            let to = id.clone();
            let can_parent = id.clone();
            let can_book = book.clone();
            let tag_parent = id.clone();
            let tag_book = book.clone();
            let row_id: SharedString = format!("v5-structure-level-{id}").into();
            let row_selector = row_id.clone();
            let group: SharedString = format!("v5-structure-level-group-{id}").into();
            let click_target = target.clone();
            table = table.child(
                line.id(row_id)
                    .group(group.clone())
                    .debug_selector(move || row_selector.to_string())
                    .role(gpui::Role::Button)
                    .aria_label(entry.title.clone())
                    .cursor_pointer()
                    .when(selected, |el| {
                        el.bg(p.page.solid())
                            .border_1()
                            .border_color(p.local_hairline())
                    })
                    .when(!selected, |el| el.hover(move |s| s.bg(p.page.alpha(0.6))))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        if let Some(target) = click_target.clone() {
                            this.select(target, window, cx);
                        }
                    }))
                    .on_drag(
                        LevelDrag {
                            owner,
                            id: id.clone(),
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
                    .drag_over::<LevelDrag>(move |s, _, _, _| {
                        s.bg(p.page.solid())
                            .border_1()
                            .border_color(p.ink(3).solid())
                    })
                    .on_drop(cx.listener(move |this, drag: &LevelDrag, _, cx| {
                        this.move_row(drag, Some(&to), cx)
                    }))
                    // 「搬到这里」 at the right of the row a drag would move into.
                    .child(
                        div()
                            .id(SharedString::from(format!("v5-structure-move-here-{id}")))
                            .absolute()
                            .right(px(10.0))
                            .top(px(5.0))
                            .invisible()
                            .can_drop(move |value, _, _| {
                                value.downcast_ref::<LevelDrag>().is_some_and(|drag| {
                                    drag.owner == owner
                                        && valid_move(&tag_book, &drag.id, Some(&tag_parent))
                                })
                            })
                            .group_drag_over::<LevelDrag>(group, |s| s.visible())
                            .flex()
                            .items_center()
                            .h(px(20.0))
                            .px(px(7.0))
                            .rounded(px(10.0))
                            .bg(p.desk.solid())
                            .border_1()
                            .border_color(p.local_hairline())
                            .font_role(Role::Index)
                            .type_px(12.0, 20.0)
                            .text_color(p.ink(2).solid())
                            .child(t(cx, v5_fill::MOVE_HERE)),
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
            .w(px(PANEL_W))
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
                    .on_click(
                        cx.listener(|this, _, window, cx| this.close_and_refocus(window, cx)),
                    ),
            ),
        );
        // Where the template's entries live and hang (`kernel-v5.md` §9:
        // the two groups are 「住在」「挂在」).
        if let Some(Target::Template(id)) = &edit.target {
            let book = self.host.book.clone();
            if let Some(v) = book.v3() {
                for (kind, label, slug) in [
                    (EdgeKind::Residence, v5_fill::LIVES_IN, "lives-in"),
                    (EdgeKind::Membership, v5_fill::HANGS_ON, "hangs-on"),
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
                    let label = t(cx, label);
                    let selector: SharedString = format!("v5-structure-panel-{slug}").into();
                    let debug = selector.clone();
                    card = card.child(
                        div()
                            .id(selector)
                            .debug_selector(move || debug.to_string())
                            .role(gpui::Role::Group)
                            .aria_label(label.clone())
                            .flex()
                            .gap_2()
                            .text_color(p.muted().solid())
                            .child(label)
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

/// How a level-table cell is drawn (`W12Template`): set on this level
/// (ink, the sand pen's underline), by its template (the row's ink), from
/// above (faint), nothing (a faint dot), or the 「下面」 counts.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Cell {
    Own,
    Plain,
    Up,
    No,
    Mono,
}

impl Cell {
    fn draw(
        self,
        id: SharedString,
        value: SharedString,
        width: f32,
        p: &dr_ui::tokens::Palette,
    ) -> AnyElement {
        let selector = id.clone();
        let text = div()
            .id(id)
            .debug_selector(move || selector.to_string())
            .relative()
            .min_w_0();
        let text = match self {
            // The sand pen's underline reaches past the text a little: the
            // text truncates inside, the line is not cut with it.
            Cell::Own => {
                let ink = p.ink(4).alpha(0.8 * p.pigment);
                text.child(
                    div()
                        .min_w_0()
                        .truncate()
                        .text_color(p.ink(1).solid())
                        .child(value),
                )
                .child(
                    canvas(
                        |_, _, _| (),
                        move |bounds, _, window, cx| {
                            sand::paint_mask(SandMask::Ul, bounds, ink, window, cx);
                        },
                    )
                    .absolute()
                    .left(px(-2.0))
                    .right(px(-2.0))
                    .bottom(px(-2.0))
                    .h(px(4.0)),
                )
            }
            Cell::Plain => text.truncate().child(value),
            Cell::Up => text.truncate().text_color(p.ink(4).solid()).child(value),
            Cell::No => text.truncate().text_color(p.ink(5).solid()).child(value),
            Cell::Mono => text
                .truncate()
                .font_role(Role::Index)
                .type_px(12.0, 20.0)
                .text_color(p.ink(3).solid())
                .child(value),
        };
        div()
            .w(px(width))
            .flex_none()
            .flex()
            .items_center()
            .min_w_0()
            .pr(px(4.0))
            .child(text)
            .into_any_element()
    }
}

/// 「16 模板 · 88 条目」: the structure's header on its templates, and the
/// Project Home's thumbnail (`W12Template`, `W30Home`).
pub fn template_meta(v: &BookV3, cx: &App) -> SharedString {
    let templates = v
        .templates
        .iter()
        .filter(|template| template.deleted_at.is_none())
        .count();
    counts(v5_fill::STRUCTURE_TEMPLATES, templates, v, cx)
}

/// 「19 层 · 88 条目」: the structure's header on its levels.
pub fn level_meta(v: &BookV3, cx: &App) -> SharedString {
    counts(v5_fill::STRUCTURE_LEVELS, level_rows(v).len(), v, cx)
}

fn counts(key: dr_i18n::PluralKey, count: usize, v: &BookV3, cx: &App) -> SharedString {
    let entries = v.entries.len();
    format!(
        "{} · {}",
        tp(cx, key, count as u64, &[("count", &count)]),
        tp(
            cx,
            v5_fill::STRUCTURE_ENTRIES,
            entries as u64,
            &[("count", &entries)]
        )
    )
    .into()
}

/// The level table's rows: every entry that is a level or takes entries
/// from elsewhere, in the tree's order, with how deep it sits among them.
pub fn level_rows(v: &BookV3) -> Vec<(String, usize)> {
    fn is_row(v: &BookV3, id: &str) -> bool {
        v.entry(id)
            .zip(v.levels.get(id))
            .is_some_and(|(entry, level)| entry.level || level.settings.accept)
    }
    fn visit(
        v: &BookV3,
        id: &str,
        depth: usize,
        seen: &mut HashSet<String>,
        out: &mut Vec<(String, usize)>,
    ) {
        if !is_row(v, id) || !seen.insert(id.to_owned()) {
            return;
        }
        out.push((id.to_owned(), depth));
        if let Some(level) = v.levels.get(id) {
            for child in &level.children {
                visit(v, child, depth + 1, seen, out);
            }
        }
    }
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for root in &v.roots {
        visit(v, root, 0, &mut seen, &mut out);
    }
    // A row the walk did not reach still gets its place, as deep as the
    // rows above it.
    for entry in &v.entries {
        if is_row(v, &entry.id) && !seen.contains(&entry.id) {
            let mut depth = 0;
            let mut steps = 0;
            let mut parent = entry.parent.as_deref();
            while let Some(id) = parent.filter(|_| steps < v.entries.len()) {
                if is_row(v, id) {
                    depth += 1;
                }
                steps += 1;
                parent = v.entry(id).and_then(|e| e.parent.as_deref());
            }
            seen.insert(entry.id.clone());
            out.push((entry.id.clone(), depth));
        }
    }
    out
}

/// The 「下面」 cell: who lives here by template (「分组 2 · 章 1」), then who
/// hangs here (「挂着 章 11」).
fn below_summary(v: &BookV3, id: &str, cx: &App) -> Option<SharedString> {
    let level = v.levels.get(id)?;
    let group = |ids: &[String]| {
        let mut counts: Vec<(String, usize)> = Vec::new();
        for child in ids {
            let name = v
                .template_of(child)
                .map(|t| t.name.clone())
                .unwrap_or_else(|| "·".to_owned());
            match counts.iter_mut().find(|(n, _)| *n == name) {
                Some((_, count)) => *count += 1,
                None => counts.push((name, 1)),
            }
        }
        counts
            .into_iter()
            .map(|(name, count)| format!("{name} {count}"))
            .collect::<Vec<_>>()
            .join(" · ")
    };
    let mut parts = Vec::new();
    if !level.children.is_empty() {
        parts.push(group(&level.children));
    }
    if !level.members.is_empty() {
        parts.push(
            tf(
                cx,
                v5_fill::HUNG_ITEMS,
                &[("items", &group(&level.members))],
            )
            .to_string(),
        );
    }
    (!parts.is_empty()).then(|| parts.join(" · ").into())
}

/// A module's kind as the template editor names it.
fn module_kind(kind: &str, cx: &App) -> SharedString {
    let key = match kind {
        "prose" => k5::PROSE,
        "fields" => k5::FIELDS,
        "kv" => k5::KV,
        "patches" => k5::PATCHES,
        "plot_grid" => k5::PLOT_GRID,
        "children" => k5::CHILDREN,
        _ => return kind.to_owned().into(),
    };
    t(cx, key)
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
