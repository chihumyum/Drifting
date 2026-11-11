//! Floating Peek Card and expandable canonical v3 `EntryPage` Sheet (`SuperElementIsland`).
//!
//! Peek Cards present canonical v3 element or island summaries, true shared-paragraph
//! companions, and canonical relations (without any legacy chapter appearance strip).
//! Expanding into `Sheet` mounts the real G1 `dr_shell::v3::page::EntryPage`.

use std::rc::Rc;

use dr_i18n::keys::super_element as k_se;
use dr_i18n::keys::super_element::isles as k_isles;
use dr_i18n::keys::super_element::isles::detail as k_detail;
use dr_i18n::keys::super_element::isles::island as k_island;
use dr_model::id::EntryId;
use dr_shell::book::{Book, color_of};
use dr_shell::nav::Target;
use dr_shell::pages::PageViewHost;
use dr_shell::strings::{t, tf};
use dr_shell::v3::page::EntryPage;
use dr_ui::Theme;
use dr_ui::components::Button;
use dr_ui::sand::{self, Icon, KindMark};
use dr_ui::tokens::{Rgb, radius};
use gpui::prelude::FluentBuilder as _;
use gpui::{
    AnyElement, AppContext as _, Context, ElementId, Entity, InteractiveElement, IntoElement,
    MouseButton, ParentElement, Render, SharedString, StatefulInteractiveElement, Styled, Window,
    div, px, relative,
};

use super::ElementOverview;
use crate::isles::isle_companions;
use crate::relate::ElementLayoutMode;

#[derive(Clone, Copy)]
pub struct SheetResizeDrag;

impl Render for SheetResizeDrag {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        div().w(px(1.0)).h(px(1.0))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IslandMode {
    Peek,
    Sheet,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum IslandSubject {
    Element(String),
    Island(String),
}

#[derive(Clone)]
pub struct IslandEditorSheet {
    pub entry_id: String,
    pub page: Entity<EntryPage>,
}

impl IslandEditorSheet {
    pub fn new(
        entry_id: String,
        host: PageViewHost,
        cx: &mut Context<ElementOverview>,
    ) -> Option<Self> {
        let parsed_id = entry_id.parse::<EntryId>().ok()?;
        let target = Target::Entry {
            id: parsed_id,
            module: None,
        };
        let page = cx.new(|cx| EntryPage::new(host, target, cx));
        Some(Self { entry_id, page })
    }

    pub fn refresh(&self, book: Rc<Book>, cx: &mut Context<ElementOverview>) {
        self.page.update(cx, |p, cx| p.refresh(book, cx));
    }

    pub fn render(&self) -> AnyElement {
        div()
            .w_full()
            .flex_1()
            .min_h_0()
            .child(self.page.clone())
            .into_any_element()
    }
}

impl ElementOverview {
    pub fn island_subject(&self) -> Option<IslandSubject> {
        if let Some(eid) = &self.isle_focus
            && self.elements.iter().any(|e| &e.id == eid)
        {
            return Some(IslandSubject::Element(eid.clone()));
        }
        if let Some(iid) = &self.isle_island
            && self.island_models.iter().any(|m| &m.island_id == iid)
        {
            return Some(IslandSubject::Island(iid.clone()));
        }
        None
    }

    pub(crate) fn subject_entry_id(&self) -> Option<String> {
        match self.island_subject()? {
            IslandSubject::Element(eid) => Some(eid),
            IslandSubject::Island(iid) => self
                .island_models
                .iter()
                .find(|m| m.island_id == iid)
                .and_then(|m| m.creation_level_id.clone()),
        }
    }

    pub(crate) fn render_floating_island(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let subject = self.island_subject()?;
        match self.island_mode {
            IslandMode::Peek => Some(match subject {
                IslandSubject::Element(id) => self.render_element_peek(&id, window, cx),
                IslandSubject::Island(id) => self.render_island_peek(&id, window, cx),
            }),
            IslandMode::Sheet => Some(self.render_island_sheet(&subject, window, cx)),
        }
    }

    fn render_element_peek(
        &self,
        element_id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = Theme::of(window, cx).palette;
        let Some(element) = self.elements.iter().find(|e| e.id == element_id) else {
            return div().into_any_element();
        };
        let home_model = self
            .island_models
            .iter()
            .find(|m| m.island_id == element.home_island_id);
        let cat_name: SharedString = home_model
            .filter(|m| !m.is_uncategorized && !m.title.trim().is_empty())
            .map(|m| SharedString::from(m.title.clone()))
            .unwrap_or_else(|| t(cx, k_se::UNCATEGORIZED));
        let color: Rgb = self.element_color(element).unwrap_or_else(|| p.ink(2));

        let mentions = self
            .cooccurrences
            .mentions
            .get(element_id)
            .copied()
            .unwrap_or(0);
        let mentions_label = tf(cx, k_island::MENTIONS, &[("count", &mentions)]);

        let present = self.present_element_ids();
        let companions = isle_companions(element_id, &self.cooccurrences.pairs, present, 5);
        let companion_rows: Vec<AnyElement> = companions
            .into_iter()
            .filter_map(|(cid, count)| {
                let other = self.elements.iter().find(|e| e.id == cid)?;
                let other_color = self.element_color(other).unwrap_or_else(|| p.ink(2));
                let other_name = other.name.clone();
                let times_label = tf(cx, k_detail::TIMES, &[("count", &count)]);
                let target_id = cid.clone();
                let comp_mark_id = format!("se-comp-mark-{cid}");
                Some(
                    div()
                        .id(ElementId::Name(format!("se-companion-{cid}").into()))
                        .w_full()
                        .px(px(6.0))
                        .py(px(3.0))
                        .rounded(px(radius::SM))
                        .cursor_pointer()
                        .hover(|s| s.bg(p.ink(4).alpha(0.12)))
                        .flex()
                        .flex_row()
                        .items_center()
                        .justify_between()
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.focus_element(Some(target_id.clone()), window, cx);
                        }))
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .items_center()
                                .gap(px(5.0))
                                .child(
                                    KindMark::new(
                                        ElementId::Name(comp_mark_id.into()),
                                        other.sand_kind,
                                    )
                                    .color(other_color)
                                    .scale(11.0 / 14.0),
                                )
                                .child(
                                    div()
                                        .text_size(px(11.5))
                                        .text_color(p.ink(1).solid())
                                        .child(SharedString::from(other_name)),
                                ),
                        )
                        .child(
                            div()
                                .text_size(px(11.0))
                                .text_color(p.ink(3).solid())
                                .child(times_label),
                        )
                        .into_any_element(),
                )
            })
            .collect();

        let rel_rows: Vec<AnyElement> = self
            .relations
            .iter()
            .filter(|r| {
                (r.from.kind == "entry" && r.from.id == element_id)
                    || (r.to.kind == "entry" && r.to.id == element_id)
            })
            .map(|r| {
                let incoming = !(r.from.kind == "entry" && r.from.id == element_id);
                let other = if incoming { &r.from } else { &r.to };
                let type_label = self.relation_type_label(&r.relation_type);
                let type_color = self.relation_type_color(&r.relation_type, window, cx);
                let other_name = self.endpoint_label(&other.kind, &other.id);
                let other_kind = other.kind.clone();
                let other_id = other.id.clone();
                let rel_id = r.id.clone();
                let is_canvas_element =
                    other_kind == "entry" && present.contains(other_id.as_str());
                let dir_text = if incoming {
                    format!("{type_label} ←")
                } else {
                    type_label
                };
                div()
                    .id(ElementId::Name(format!("se-detail-rel-{rel_id}").into()))
                    .w_full()
                    .px(px(6.0))
                    .py(px(3.0))
                    .rounded(px(radius::SM))
                    .cursor_pointer()
                    .hover(|s| s.bg(p.ink(4).alpha(0.12)))
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .on_click(cx.listener(move |this, _, window, cx| {
                        if is_canvas_element {
                            this.focus_element(Some(other_id.clone()), window, cx);
                        } else {
                            this.selected_edge_id = Some(rel_id.clone());
                            cx.notify();
                        }
                    }))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(5.0))
                            .child(
                                KindMark::new(
                                    ElementId::Name(format!("se-detail-rel-mark-{}", r.id).into()),
                                    sand::Kind::Storyline,
                                )
                                .color(type_color)
                                .scale(10.0 / 14.0),
                            )
                            .child(
                                div()
                                    .text_size(px(11.0))
                                    .text_color(p.ink(3).solid())
                                    .child(SharedString::from(dir_text)),
                            ),
                    )
                    .child(
                        div()
                            .text_size(px(11.5))
                            .text_color(p.ink(1).solid())
                            .child(SharedString::from(other_name)),
                    )
                    .into_any_element()
            })
            .collect();

        let is_pinned =
            self.layout_mode == ElementLayoutMode::Relate && element.relation_pin.is_some();
        let eid_unpin = element_id.to_owned();
        let eid_edge = element_id.to_owned();
        let isolate_label = if self.isolated {
            t(cx, k_detail::SHOW_ALL)
        } else {
            t(cx, k_detail::ISOLATE)
        };

        div()
            .id("se-island-peek")
            .absolute()
            .top(px(16.0))
            .right(px(16.0))
            .w(px(268.0))
            .p(px(12.0))
            .rounded(px(radius::MD))
            .bg(p.paper.solid())
            .border_1()
            .border_color(p.hairline())
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .flex()
            .flex_col()
            .gap(px(10.0))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(6.0))
                            .child(
                                KindMark::new("se-peek-el-mark", element.sand_kind)
                                    .color(color)
                                    .scale(13.0 / 14.0),
                            )
                            .child(
                                div()
                                    .text_size(px(13.5))
                                    .font_weight(gpui::FontWeight::SEMIBOLD)
                                    .text_color(p.ink(1).solid())
                                    .child(SharedString::from(element.name.clone())),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(6.0))
                            .child(
                                div()
                                    .text_size(px(11.0))
                                    .text_color(p.ink(3).solid())
                                    .child(mentions_label),
                            )
                            .child(
                                Button::new("se-peek-close", t(cx, k_detail::CLOSE))
                                    .text()
                                    .small()
                                    .icon(Icon::Close)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.close_island(cx);
                                    })),
                            ),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.0))
                    .child(
                        KindMark::new("se-peek-cat-mark", sand::Kind::Category)
                            .color(color)
                            .scale(10.0 / 14.0),
                    )
                    .child(
                        div()
                            .text_size(px(11.0))
                            .text_color(p.ink(2).solid())
                            .child(cat_name),
                    )
                    .when(is_pinned, |d| {
                        d.child(
                            div()
                                .px(px(5.0))
                                .py(px(1.0))
                                .rounded(px(radius::SM))
                                .bg(p.ink(4).alpha(0.16))
                                .text_size(px(10.5))
                                .text_color(p.ink(2).solid())
                                .child(t(cx, k_isles::PINNED)),
                        )
                        .child(
                            Button::new("se-detail-unpin", t(cx, k_isles::UNPIN))
                                .text()
                                .small()
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.unpin_element_in_relate(&eid_unpin, cx);
                                })),
                        )
                    }),
            )
            .when(!element.summary.trim().is_empty(), |d| {
                d.child(
                    div()
                        .text_size(px(11.5))
                        .text_color(p.ink(2).solid())
                        .child(SharedString::from(element.summary.clone())),
                )
            })
            .when(!companion_rows.is_empty(), |d| {
                d.child(
                    div()
                        .pt(px(6.0))
                        .border_t_1()
                        .border_color(p.hairline())
                        .flex()
                        .flex_col()
                        .gap(px(3.0))
                        .child(
                            div()
                                .text_size(px(10.5))
                                .text_color(p.ink(3).solid())
                                .child(t(cx, k_detail::COMPANIONS)),
                        )
                        .children(companion_rows),
                )
            })
            .when(!rel_rows.is_empty(), |d| {
                d.child(
                    div()
                        .pt(px(6.0))
                        .border_t_1()
                        .border_color(p.hairline())
                        .flex()
                        .flex_col()
                        .gap(px(3.0))
                        .child(
                            div()
                                .text_size(px(10.5))
                                .text_color(p.ink(3).solid())
                                .child(t(cx, k_detail::RELATIONS)),
                        )
                        .children(rel_rows),
                )
            })
            .child(
                div()
                    .pt(px(6.0))
                    .border_t_1()
                    .border_color(p.hairline())
                    .flex()
                    .flex_wrap()
                    .gap(px(6.0))
                    .child(
                        Button::new("se-detail-start-edge", t(cx, k_se::START_EDGE_FROM_ELEMENT))
                            .text()
                            .small()
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.start_edge_from("entry", &eid_edge, cx);
                            })),
                    )
                    .child(
                        Button::new("se-detail-isolate", isolate_label)
                            .text()
                            .small()
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.toggle_isolated(cx);
                            })),
                    )
                    .child(
                        Button::new("se-detail-open-tab", t(cx, k_island::OPEN_IN_TAB))
                            .text()
                            .small()
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.open_island_in_tab(window, cx);
                            })),
                    )
                    .child(
                        Button::new("se-detail-edit", t(cx, k_detail::EDIT))
                            .text()
                            .small()
                            .icon(Icon::Edit)
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.grow_island(window, cx);
                            })),
                    ),
            )
            .into_any_element()
    }

    fn render_island_peek(
        &self,
        island_id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = Theme::of(window, cx).palette;
        let Some(model) = self.island_models.iter().find(|m| m.island_id == island_id) else {
            return div().into_any_element();
        };
        let color = model
            .color
            .as_deref()
            .and_then(color_of)
            .unwrap_or_else(|| p.ink(2));
        let title_str = if model.title.trim().is_empty() {
            t(cx, k_se::UNNAMED_CATEGORY)
        } else {
            SharedString::from(model.title.clone())
        };

        let mut seen = std::collections::HashSet::new();
        let mut members: Vec<(&str, &str, sand::Kind, u32)> = Vec::new();
        for g in &model.groups {
            for item in &g.items {
                if seen.insert(item.id.as_str()) {
                    let m = self
                        .cooccurrences
                        .mentions
                        .get(&item.id)
                        .copied()
                        .unwrap_or(0);
                    members.push((item.id.as_str(), item.name.as_str(), item.sand_kind, m));
                }
            }
        }
        members.sort_by(|a, b| b.3.cmp(&a.3).then_with(|| a.1.cmp(b.1)));

        let member_count = members.len();
        let meta_label = tf(cx, k_island::CATEGORY_META, &[("count", &member_count)]);

        let member_rows: Vec<AnyElement> = members
            .iter()
            .take(8)
            .map(|&(eid, ename, skind, mentions)| {
                let aside = if mentions > 0 {
                    tf(cx, k_island::MENTIONS, &[("count", &mentions)])
                } else {
                    t(cx, k_island::UNMENTIONED)
                };
                let target_id = eid.to_owned();
                let mem_mark_id = format!("se-cat-mem-mark-{eid}");
                div()
                    .id(ElementId::Name(format!("se-cat-member-{eid}").into()))
                    .w_full()
                    .px(px(6.0))
                    .py(px(3.0))
                    .rounded(px(radius::SM))
                    .cursor_pointer()
                    .hover(|s| s.bg(p.ink(4).alpha(0.12)))
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.focus_element(Some(target_id.clone()), window, cx);
                    }))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(5.0))
                            .child(
                                KindMark::new(ElementId::Name(mem_mark_id.into()), skind)
                                    .color(color)
                                    .scale(11.0 / 14.0),
                            )
                            .child(
                                div()
                                    .text_size(px(11.5))
                                    .text_color(p.ink(1).solid())
                                    .child(SharedString::from(ename.to_owned())),
                            ),
                    )
                    .child(
                        div()
                            .text_size(px(11.0))
                            .text_color(p.ink(3).solid())
                            .child(aside),
                    )
                    .into_any_element()
            })
            .collect();

        let create_level_opt = model.creation_level_id.clone().filter(|lid| {
            !model.is_uncategorized
                && dr_view_elements::data::v3::creation(&self.book, lid).is_some()
        });
        let can_open_entry = model.creation_level_id.is_some();

        div()
            .id("se-island-category-peek")
            .absolute()
            .top(px(16.0))
            .right(px(16.0))
            .w(px(268.0))
            .p(px(12.0))
            .rounded(px(radius::MD))
            .bg(p.paper.solid())
            .border_1()
            .border_color(p.hairline())
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .flex()
            .flex_col()
            .gap(px(10.0))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(6.0))
                            .child(
                                KindMark::new("se-cat-peek-head-mark", model.sand_kind)
                                    .color(color)
                                    .scale(13.0 / 14.0),
                            )
                            .child(
                                div()
                                    .text_size(px(13.5))
                                    .font_weight(gpui::FontWeight::SEMIBOLD)
                                    .text_color(p.ink(1).solid())
                                    .child(title_str),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(6.0))
                            .child(
                                div()
                                    .text_size(px(11.0))
                                    .text_color(p.ink(3).solid())
                                    .child(meta_label),
                            )
                            .child(
                                Button::new("se-cat-peek-close", t(cx, k_detail::CLOSE))
                                    .text()
                                    .small()
                                    .icon(Icon::Close)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.close_island(cx);
                                    })),
                            ),
                    ),
            )
            .when(!member_rows.is_empty(), |d| {
                d.child(
                    div()
                        .pt(px(6.0))
                        .border_t_1()
                        .border_color(p.hairline())
                        .flex()
                        .flex_col()
                        .gap(px(2.0))
                        .children(member_rows),
                )
            })
            .when(create_level_opt.is_some() || can_open_entry, |d| {
                d.child(
                    div()
                        .pt(px(6.0))
                        .border_t_1()
                        .border_color(p.hairline())
                        .flex()
                        .flex_wrap()
                        .gap(px(6.0))
                        .when_some(create_level_opt, |bar, level_id| {
                            bar.child(
                                Button::new("se-cat-new-element", t(cx, k_isles::NEW_ELEMENT))
                                    .text()
                                    .small()
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.open_new_element_dialog(&level_id, window, cx);
                                    })),
                            )
                        })
                        .when(can_open_entry, |bar| {
                            bar.child(
                                Button::new("se-cat-open-tab", t(cx, k_island::OPEN_IN_TAB))
                                    .text()
                                    .small()
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.open_island_in_tab(window, cx);
                                    })),
                            )
                            .child(
                                Button::new("se-cat-edit", t(cx, k_detail::EDIT))
                                    .text()
                                    .small()
                                    .icon(Icon::Edit)
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.grow_island(window, cx);
                                    })),
                            )
                        }),
                )
            })
            .into_any_element()
    }

    fn render_island_sheet(
        &self,
        subject: &IslandSubject,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = Theme::of(window, cx).palette;
        let (title_text, kind_label, mark_kind, color) = match subject {
            IslandSubject::Element(eid) => {
                let el = self.elements.iter().find(|e| &e.id == eid);
                let home = el.and_then(|e| {
                    self.island_models
                        .iter()
                        .find(|m| m.island_id == e.home_island_id)
                });
                let cat_name = home
                    .filter(|m| !m.is_uncategorized && !m.title.trim().is_empty())
                    .map(|m| m.title.clone())
                    .unwrap_or_else(|| t(cx, k_se::UNCATEGORIZED).to_string());
                let kind_str = format!("{} · {}", t(cx, k_island::ELEMENT), cat_name);
                let c = el
                    .and_then(|e| self.element_color(e))
                    .unwrap_or_else(|| p.ink(2));
                (
                    el.map(|e| e.name.clone()).unwrap_or_default(),
                    SharedString::from(kind_str),
                    el.map_or(sand::Kind::Element, |e| e.sand_kind),
                    c,
                )
            }
            IslandSubject::Island(iid) => {
                let isl = self.island_models.iter().find(|m| &m.island_id == iid);
                let c = isl
                    .and_then(|m| m.color.as_deref())
                    .and_then(color_of)
                    .unwrap_or_else(|| p.ink(2));
                (
                    isl.map(|m| m.title.clone()).unwrap_or_default(),
                    t(cx, k_island::CATEGORY),
                    isl.map_or(sand::Kind::Category, |m| m.sand_kind),
                    c,
                )
            }
        };

        let editor_view = self
            .island_sheet
            .as_ref()
            .map(IslandEditorSheet::render)
            .unwrap_or_else(|| div().into_any_element());

        div()
            .id("se-island-sheet")
            .absolute()
            .top(px(12.0))
            .bottom(px(12.0))
            .right(px(12.0))
            .w(relative(self.island_width_ratio))
            .rounded(px(radius::MD))
            .bg(p.paper.solid())
            .border_1()
            .border_color(p.hairline())
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .flex()
            .flex_row()
            .overflow_hidden()
            .child(
                div()
                    .id("se-sheet-resize-handle")
                    .role(gpui::Role::Button)
                    .aria_label(t(cx, k_island::RESIZE))
                    .w(px(6.0))
                    .h_full()
                    .cursor_col_resize()
                    .hover(|s| s.bg(p.rule.alpha(0.32)))
                    .on_drag(SheetResizeDrag, |drag, _, _, cx| cx.new(|_| *drag)),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .flex()
                    .flex_col()
                    .overflow_hidden()
                    .child(
                        div()
                            .px(px(12.0))
                            .py(px(8.0))
                            .border_b_1()
                            .border_color(p.hairline())
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(8.0))
                            .child(
                                KindMark::new("se-sheet-head-mark", mark_kind)
                                    .color(color)
                                    .scale(13.0 / 14.0),
                            )
                            .child(
                                div()
                                    .text_size(px(13.0))
                                    .font_weight(gpui::FontWeight::SEMIBOLD)
                                    .text_color(p.ink(1).solid())
                                    .child(SharedString::from(title_text)),
                            )
                            .child(
                                div()
                                    .text_size(px(11.0))
                                    .text_color(p.ink(3).solid())
                                    .child(kind_label),
                            )
                            .child(div().flex_1())
                            .child(
                                Button::new("se-sheet-open-tab", t(cx, k_island::OPEN_IN_TAB))
                                    .text()
                                    .small()
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.open_island_in_tab(window, cx);
                                    })),
                            )
                            .child(
                                Button::new("se-sheet-collapse", t(cx, k_island::COLLAPSE))
                                    .text()
                                    .small()
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.collapse_island(cx);
                                    })),
                            )
                            .child(
                                Button::new("se-sheet-close", t(cx, k_detail::CLOSE))
                                    .text()
                                    .small()
                                    .icon(Icon::Close)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.close_island(cx);
                                    })),
                            ),
                    )
                    .child(
                        div()
                            .id("se-sheet-editor-scroll")
                            .flex_1()
                            .min_h_0()
                            .overflow_hidden()
                            .flex()
                            .flex_col()
                            .child(editor_view),
                    ),
            )
            .into_any_element()
    }
}
