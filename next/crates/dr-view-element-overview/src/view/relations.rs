//! Relation curves, role badges, shared top-right legend (`dr_view_relations::legend`),
//! Shift-click link creation modal, edge detail popover, and lightweight v3 relation-type
//! manager modal for M22 Element Overview.

use std::collections::HashMap;
use std::rc::Rc;

use dr_i18n::keys::edge_kind_manager as k_ekm;
use dr_i18n::keys::relation_types as k_rt;
use dr_i18n::keys::story_graph::edge as k_edge;
use dr_i18n::keys::super_element as k_se;
use dr_i18n::keys::super_element::isles as k_isles;
use dr_i18n::keys::super_element::isles::detail as k_detail;
use dr_model::id::RelationTypeId;
use dr_shell::book::color_of;
use dr_shell::strings::{t, tf};
use dr_ui::Theme;
use dr_ui::components::button::Variant;
use dr_ui::components::{Button, Segmented};
use dr_ui::input::field::TextField;
use dr_ui::sand::{self, Icon, KindMark};
use dr_ui::tokens::{Rgb, radius};
use dr_view_elements::data::v3 as g2_data;
use dr_view_relations::legend::{Legend, Row as LegendRow, render as render_shared_legend};
use dr_workspace::commands::v3::content::{RelationType, RelationTypeInfo};
use gpui::prelude::FluentBuilder as _;
use gpui::{
    AnyElement, App, AppContext as _, Context, ElementId, Entity, InteractiveElement, IntoElement,
    MouseButton, ParentElement, SharedString, StatefulInteractiveElement, Styled, Window, div, px,
};
use serde_json::json;

use super::ElementOverview;
use crate::relate::{
    ElementLayoutMode, RelateEdgeInput, RelatePoint, RelateRoleLabel, relate_bend,
    relate_cell_half, relate_edge_geometry, relate_role_half,
};

#[derive(Clone, Debug)]
pub struct PendingLink {
    pub source: (String, String),
    pub target: (String, String),
    pub relation_type_id: Option<String>,
    pub reversed: bool,
}

#[derive(Clone, Debug)]
pub struct RelateEdgeView {
    pub id: String,
    pub relation_type_id: String,
    pub from_id: String,
    pub to_id: String,
    pub color: Rgb,
    pub p0: RelatePoint,
    pub ctrl: RelatePoint,
    pub p2: RelatePoint,
    pub directed: bool,
    pub labels: Vec<RelateRoleLabel>,
}

pub struct TypeManagerState {
    pub name_field: Entity<TextField>,
    pub source_role_field: Entity<TextField>,
    pub target_role_field: Entity<TextField>,
    pub directed: bool,
    pub error: Option<String>,
}

impl TypeManagerState {
    pub fn new(window: &mut Window, cx: &mut Context<ElementOverview>) -> Self {
        let name_placeholder = t(cx, k_rt::NAME);
        let src_placeholder = t(cx, k_rt::SOURCE_ROLE);
        let dst_placeholder = t(cx, k_rt::TARGET_ROLE);
        let name_field =
            cx.new(|cx| TextField::new("se-rtm-name", window, cx).placeholder(name_placeholder));
        let source_role_field =
            cx.new(|cx| TextField::new("se-rtm-src", window, cx).placeholder(src_placeholder));
        let target_role_field =
            cx.new(|cx| TextField::new("se-rtm-dst", window, cx).placeholder(dst_placeholder));
        Self {
            name_field,
            source_role_field,
            target_role_field,
            directed: true,
            error: None,
        }
    }
}

impl ElementOverview {
    pub(crate) fn compatible_relation_types(
        &self,
        src_kind: &str,
        src_id: &str,
        dst_kind: &str,
        dst_id: &str,
    ) -> Vec<RelationTypeInfo> {
        let v3 = self.book.v3();
        let fits = |kind: &str, id: &str, kinds: &[String], templates: &[String]| -> bool {
            let kind_ok = kinds.is_empty() || kinds.iter().any(|k| k == kind);
            let tpl_ok = templates.is_empty()
                || (kind == "entry"
                    && v3
                        .and_then(|b| b.entry(id))
                        .and_then(|e| e.template.as_ref())
                        .is_some_and(|tpl| templates.contains(tpl)));
            kind_ok && tpl_ok
        };
        self.relation_types
            .iter()
            .filter(|rt| {
                fits(
                    src_kind,
                    src_id,
                    &rt.definition.source_kinds,
                    &rt.definition.source_templates,
                ) && fits(
                    dst_kind,
                    dst_id,
                    &rt.definition.target_kinds,
                    &rt.definition.target_templates,
                )
            })
            .cloned()
            .collect()
    }

    pub(crate) fn relation_type_label(&self, type_id: &str) -> String {
        self.relation_types
            .iter()
            .find(|rt| rt.definition.id == type_id)
            .map(|rt| rt.definition.name.clone())
            .unwrap_or_else(|| "关联".to_owned())
    }

    pub(crate) fn relation_type_color(&self, type_id: &str, window: &Window, cx: &App) -> Rgb {
        self.relation_types
            .iter()
            .find(|rt| rt.definition.id == type_id)
            .and_then(|rt| rt.definition.color.as_deref())
            .and_then(color_of)
            .unwrap_or_else(|| Theme::of(window, cx).palette.ink(2))
    }

    pub(crate) fn relate_roles_for(&self, type_id: &str) -> Vec<String> {
        let Some(rt) = self
            .relation_types
            .iter()
            .find(|rt| rt.definition.id == type_id)
        else {
            return Vec::new();
        };
        let d = &rt.definition;
        let s = d.source_role.trim();
        let tg = d.target_role.trim();
        if d.orientation == "directed" && !s.is_empty() && !tg.is_empty() && s != tg {
            vec![s.to_owned(), tg.to_owned()]
        } else if !d.name.trim().is_empty() {
            vec![d.name.trim().to_owned()]
        } else {
            Vec::new()
        }
    }

    pub(crate) fn endpoint_label(&self, kind: &str, id: &str) -> String {
        if let Some(v3) = self.book.v3() {
            match kind {
                "entry" => {
                    if let Some(e) = v3.entry(id) {
                        return e.title.clone();
                    }
                }
                "material" => {
                    if let Some(m) = v3.materials.iter().find(|m| m.id == id) {
                        return m.title.clone();
                    }
                }
                _ => {}
            }
        }
        id.to_owned()
    }

    pub fn confirm_pending_link(&mut self, cx: &mut Context<Self>) -> Option<String> {
        if crate::is_frozen(cx) {
            return None;
        }
        let pending = self.pending_link.clone()?;
        let lib = self.lib.clone()?;
        let (from, to) = if pending.reversed {
            (pending.target, pending.source)
        } else {
            (pending.source, pending.target)
        };
        let compatible = self.compatible_relation_types(&from.0, &from.1, &to.0, &to.1);
        let type_id = pending
            .relation_type_id
            .filter(|tid| compatible.iter().any(|rt| &rt.definition.id == tid))
            .or_else(|| compatible.first().map(|rt| rt.definition.id.clone()))?;

        match g2_data::prepare(
            &self.book,
            "relation.create",
            json!({
                "from": { "kind": from.0, "id": from.1 },
                "to": { "kind": to.0, "id": to.1 },
                "relation_type": type_id,
            }),
        )
        .and_then(|m| m.commit(&lib))
        {
            Ok(val) => {
                let rel_id = val["id"].as_str().map(str::to_owned);
                self.pending_link = None;
                self.sync_workspace_book(cx);
                cx.notify();
                rel_id
            }
            Err(err) => {
                log::warn!("failed to create canonical relation: {err}");
                None
            }
        }
    }

    pub fn delete_relation(&mut self, relation_id: &str, cx: &mut Context<Self>) -> bool {
        if crate::is_frozen(cx) {
            return false;
        }
        let Some(lib) = self.lib.clone() else {
            return false;
        };
        match g2_data::prepare(&self.book, "relation.delete", json!({ "id": relation_id }))
            .and_then(|m| m.commit(&lib))
        {
            Ok(_) => {
                if self.selected_edge_id.as_deref() == Some(relation_id) {
                    self.selected_edge_id = None;
                }
                self.sync_workspace_book(cx);
                cx.notify();
                true
            }
            Err(err) => {
                log::warn!("failed to delete canonical relation {relation_id}: {err}");
                false
            }
        }
    }

    pub fn create_relation_type(
        &mut self,
        name: &str,
        directed: bool,
        source_role: &str,
        target_role: &str,
        cx: &mut Context<Self>,
    ) -> Result<String, String> {
        if crate::is_frozen(cx) {
            return Err("library releasing".into());
        }
        let lib = self.lib.clone().ok_or_else(|| "no library".to_owned())?;
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err("empty name".into());
        }
        let id = RelationTypeId::new_v7().to_string();
        let def = RelationType {
            id: id.clone(),
            name: trimmed.to_owned(),
            description: String::new(),
            orientation: if directed {
                "directed".to_owned()
            } else {
                "symmetric".to_owned()
            },
            source_role: source_role.trim().to_owned(),
            target_role: target_role.trim().to_owned(),
            color: Some("#c26d4a".to_owned()),
            source_kinds: vec!["entry".to_owned()],
            target_kinds: vec!["entry".to_owned()],
            source_templates: Vec::new(),
            target_templates: Vec::new(),
        };
        g2_data::prepare(
            &self.book,
            "entry_relation_type.put",
            json!({ "definition": def }),
        )
        .and_then(|m| m.commit(&lib))
        .map_err(|e| e.to_string())?;

        if let Some(pl) = &mut self.pending_link {
            pl.relation_type_id = Some(id.clone());
        }
        self.sync_workspace_book(cx);
        cx.notify();
        Ok(id)
    }

    pub fn delete_relation_type(&mut self, type_id: &str, cx: &mut Context<Self>) -> bool {
        if crate::is_frozen(cx) {
            return false;
        }
        let Some(lib) = self.lib.clone() else {
            return false;
        };
        match g2_data::prepare(
            &self.book,
            "entry_relation_type.delete",
            json!({ "id": type_id }),
        )
        .and_then(|m| m.commit(&lib))
        {
            Ok(_) => {
                self.hidden_relation_type_ids.remove(type_id);
                self.sync_workspace_book(cx);
                cx.notify();
                true
            }
            Err(err) => {
                log::warn!("failed to delete relation type {type_id}: {err}");
                false
            }
        }
    }

    pub fn open_type_manager(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.type_manager = Some(TypeManagerState::new(window, cx));
        cx.notify();
    }

    pub(crate) fn build_relate_edges(&self) -> Vec<RelateEdgeView> {
        let present = self.present_element_ids();
        let names_by_id: HashMap<&str, &str> = self
            .elements
            .iter()
            .map(|e| (e.id.as_str(), e.name.as_str()))
            .collect();
        let centers: HashMap<&str, RelatePoint> = match self.layout_mode {
            ElementLayoutMode::Isles => self
                .element_centers
                .iter()
                .map(|(id, c)| {
                    (
                        id.as_str(),
                        RelatePoint::new(f64::from(c.x), f64::from(c.y)),
                    )
                })
                .collect(),
            ElementLayoutMode::Relate => self
                .relate_live
                .iter()
                .map(|(id, pt)| (id.as_str(), *pt))
                .collect(),
        };

        let mut pair_totals: HashMap<(String, String), usize> = HashMap::new();
        for r in &self.relations {
            if r.from.kind != "entry"
                || r.to.kind != "entry"
                || !present.contains(&r.from.id)
                || !present.contains(&r.to.id)
                || self.hidden_relation_type_ids.contains(&r.relation_type)
            {
                continue;
            }
            if !centers.contains_key(r.from.id.as_str()) || !centers.contains_key(r.to.id.as_str())
            {
                continue;
            }
            let key = if r.from.id <= r.to.id {
                (r.from.id.clone(), r.to.id.clone())
            } else {
                (r.to.id.clone(), r.from.id.clone())
            };
            *pair_totals.entry(key).or_insert(0) += 1;
        }

        let mut pair_seen: HashMap<(String, String), usize> = HashMap::new();
        let mut out = Vec::new();
        let label_scale = (1.0 / f64::from(self.zoom.max(0.25))).clamp(0.5, 2.5);
        for r in &self.relations {
            if r.from.kind != "entry"
                || r.to.kind != "entry"
                || !present.contains(&r.from.id)
                || !present.contains(&r.to.id)
                || self.hidden_relation_type_ids.contains(&r.relation_type)
            {
                continue;
            }
            let Some(&from_pt) = centers.get(r.from.id.as_str()) else {
                continue;
            };
            let Some(&to_pt) = centers.get(r.to.id.as_str()) else {
                continue;
            };
            let key = if r.from.id <= r.to.id {
                (r.from.id.clone(), r.to.id.clone())
            } else {
                (r.to.id.clone(), r.from.id.clone())
            };
            let total = pair_totals.get(&key).copied().unwrap_or(1);
            let idx = *pair_seen
                .entry(key)
                .and_modify(|v| *v += 1)
                .or_insert(0usize);
            let bend = relate_bend(idx, total);
            let roles = self.relate_roles_for(&r.relation_type);
            let from_half = relate_cell_half(names_by_id.get(r.from.id.as_str()).unwrap_or(&""));
            let to_half = relate_cell_half(names_by_id.get(r.to.id.as_str()).unwrap_or(&""));
            let geom = relate_edge_geometry(RelateEdgeInput {
                from_id: &r.from.id,
                to_id: &r.to.id,
                from: from_pt,
                to: to_pt,
                from_half,
                to_half,
                bend,
                roles: &roles,
                label_scale,
            });

            let rt = self
                .relation_types
                .iter()
                .find(|rt| rt.definition.id == r.relation_type);
            let color = rt
                .and_then(|rt| rt.definition.color.as_deref())
                .and_then(color_of)
                .unwrap_or(Rgb::hex(0xC26D4A));
            let directed = rt.is_none_or(|rt| rt.definition.orientation == "directed");

            out.push(RelateEdgeView {
                id: r.id.clone(),
                relation_type_id: r.relation_type.clone(),
                from_id: r.from.id.clone(),
                to_id: r.to.id.clone(),
                color,
                p0: geom.p0,
                ctrl: geom.ctrl,
                p2: geom.p2,
                directed,
                labels: geom.labels,
            });
        }
        out
    }

    pub(crate) fn render_relate_role_labels(
        &self,
        edges: &[RelateEdgeView],
        role_labels_all: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let p = Theme::of(window, cx).palette;
        let mut out = Vec::new();
        for edge in edges {
            let touches_focus = self
                .isle_focus
                .as_deref()
                .is_some_and(|aid| edge.from_id == aid || edge.to_id == aid);
            let is_selected = self.selected_edge_id.as_deref() == Some(edge.id.as_str());
            if !role_labels_all && !touches_focus && !is_selected {
                continue;
            }
            if self.isolated && self.isle_focus.is_some() && !touches_focus {
                continue;
            }
            for (idx, lbl) in edge.labels.iter().enumerate() {
                let (hw, hh) = relate_role_half(&lbl.text);
                let sx = (lbl.x as f32) * self.zoom + self.pan.x;
                let sy = (lbl.y as f32) * self.zoom + self.pan.y;
                let bw = (hw as f32) * 2.0;
                let bh = (hh as f32) * 2.0;
                let edge_id = edge.id.clone();
                let badge = div()
                    .id(ElementId::Name(
                        format!("se-role-badge-{}-{idx}", edge.id).into(),
                    ))
                    .absolute()
                    .left(px(sx - bw * 0.5))
                    .top(px(sy - bh * 0.5))
                    .w(px(bw))
                    .h(px(bh))
                    .px(px(4.0))
                    .rounded(px(radius::SM))
                    .bg(p.paper.alpha(0.92))
                    .border_1()
                    .border_color(edge.color.alpha(0.45))
                    .cursor_pointer()
                    .flex()
                    .items_center()
                    .justify_center()
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(cx.listener(move |this, _, _window, cx| {
                        cx.stop_propagation();
                        this.selected_edge_id = Some(edge_id.clone());
                        cx.notify();
                    }))
                    .child(
                        div()
                            .text_size(px(10.0))
                            .text_color(p.ink(2).solid())
                            .truncate()
                            .child(SharedString::from(lbl.text.clone())),
                    )
                    .into_any_element();
                out.push(badge);
            }
        }
        out
    }

    pub(crate) fn render_legend(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let p = Theme::of(window, cx).palette;
        let present = self.present_element_ids();
        let sand_count = self.threshold_sand_pairs().len();

        let mut counts_by_type: HashMap<&str, usize> = HashMap::new();
        for r in &self.relations {
            if r.from.kind == "entry"
                && r.to.kind == "entry"
                && present.contains(&r.from.id)
                && present.contains(&r.to.id)
            {
                *counts_by_type.entry(r.relation_type.as_str()).or_insert(0) += 1;
            }
        }

        let mut rows = Vec::with_capacity(1 + self.relation_types.len());
        rows.push(LegendRow {
            id: "se-legend-sand-lines".to_owned(),
            label: t(cx, k_isles::LINES),
            count: sand_count,
            color: p.ink(3),
            visible: self.lines_on,
            hint: t(cx, k_isles::LINES_TITLE),
            sand: true,
        });

        for rt in &self.relation_types {
            let count = counts_by_type
                .get(rt.definition.id.as_str())
                .copied()
                .unwrap_or(0);
            if count == 0 && self.relation_types.len() > 6 {
                continue;
            }
            let hidden = self.hidden_relation_type_ids.contains(&rt.definition.id);
            let color = rt
                .definition
                .color
                .as_deref()
                .and_then(color_of)
                .unwrap_or_else(|| p.ink(2));
            let rt_name = rt.definition.name.as_str();
            let hint = if hidden {
                tf(cx, k_edge::SHOW_KIND, &[("label", &rt_name)])
            } else {
                tf(cx, k_edge::HIDE_KIND, &[("label", &rt_name)])
            };
            rows.push(LegendRow {
                id: format!("se-legend-type-{}", rt.definition.id),
                label: SharedString::from(rt.definition.name.clone()),
                count,
                color,
                visible: !hidden,
                hint,
                sand: false,
            });
        }

        let weak_toggle = cx.entity().downgrade();
        let weak_edit = cx.entity().downgrade();
        let shared = render_shared_legend(
            Legend {
                id: "se-relation-legend",
                rows,
                empty: t(cx, k_ekm::EMPTY),
                edit_label: t(cx, k_ekm::EDIT_TYPES),
                edit_id: "se-legend-edit-types",
                toggle: Rc::new(move |row_id, _window, cx| {
                    if let Some(ov) = weak_toggle.upgrade() {
                        ov.update(cx, |this, cx| {
                            if row_id == "se-legend-sand-lines" {
                                this.toggle_sand_lines(cx);
                            } else if let Some(tid) = row_id.strip_prefix("se-legend-type-") {
                                this.toggle_relation_type(tid, cx);
                            }
                        });
                    }
                }),
                edit: Rc::new(move |window, cx| {
                    if let Some(ov) = weak_edit.upgrade() {
                        ov.update(cx, |this, cx| {
                            this.open_type_manager(window, cx);
                        });
                    }
                }),
            },
            window,
            cx,
        );

        let right_offset = match (self.island_subject().is_some(), self.island_mode) {
            (false, _) => px(16.0),
            (true, super::IslandMode::Peek) => px(296.0),
            (true, super::IslandMode::Sheet) => px(436.0),
        };

        div()
            .id("se-relation-legend-wrap")
            .absolute()
            .top(px(16.0))
            .right(right_offset)
            .flex()
            .flex_col()
            .items_end()
            .gap(px(6.0))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(shared)
            .child(
                Button::new("se-legend-link-mode", t(cx, k_se::MANUAL_RELATION_TITLE))
                    .variant(if self.link_mode || self.link_source.is_some() {
                        Variant::Primary
                    } else {
                        Variant::Text
                    })
                    .small()
                    .on_click(cx.listener(|this, _, _window, cx| {
                        this.link_mode = !this.link_mode;
                        if !this.link_mode {
                            this.link_source = None;
                        }
                        cx.notify();
                    })),
            )
            .into_any_element()
    }

    pub(crate) fn render_pending_link_modal(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let pending = self.pending_link.as_ref()?;
        let p = Theme::of(window, cx).palette;
        let (from, to) = if pending.reversed {
            (&pending.target, &pending.source)
        } else {
            (&pending.source, &pending.target)
        };
        let from_name = self.endpoint_label(&from.0, &from.1);
        let to_name = self.endpoint_label(&to.0, &to.1);
        let compatible = self.compatible_relation_types(&from.0, &from.1, &to.0, &to.1);
        let selected_tid = pending
            .relation_type_id
            .clone()
            .filter(|tid| compatible.iter().any(|rt| &rt.definition.id == tid))
            .or_else(|| compatible.first().map(|rt| rt.definition.id.clone()));

        let type_buttons: Vec<AnyElement> = compatible
            .iter()
            .map(|rt| {
                let tid = rt.definition.id.clone();
                let is_sel = selected_tid.as_deref() == Some(tid.as_str());
                let c = rt
                    .definition
                    .color
                    .as_deref()
                    .and_then(color_of)
                    .unwrap_or_else(|| p.ink(2));
                let mark_id = format!("se-pending-type-mark-{tid}");
                div()
                    .id(ElementId::Name(format!("se-pending-type-{tid}").into()))
                    .px(px(8.0))
                    .py(px(4.0))
                    .rounded(px(radius::SM))
                    .border_1()
                    .border_color(if is_sel { c.solid() } else { p.hairline() })
                    .when(is_sel, |d| d.bg(c.alpha(0.14)))
                    .cursor_pointer()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(5.0))
                    .on_click(cx.listener(move |this, _, _window, cx| {
                        if let Some(pl) = &mut this.pending_link {
                            pl.relation_type_id = Some(tid.clone());
                            cx.notify();
                        }
                    }))
                    .child(
                        KindMark::new(ElementId::Name(mark_id.into()), sand::Kind::Storyline)
                            .color(c)
                            .scale(10.0 / 14.0),
                    )
                    .child(
                        div()
                            .text_size(px(11.5))
                            .text_color(p.ink(1).solid())
                            .child(SharedString::from(rt.definition.name.clone())),
                    )
                    .into_any_element()
            })
            .collect();

        let no_types = compatible.is_empty();

        Some(
            div()
                .id("se-pending-link-modal")
                .absolute()
                .inset_0()
                .bg(p.ink(1).alpha(0.18))
                .flex()
                .items_center()
                .justify_center()
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .child(
                    div()
                        .w(px(348.0))
                        .p(px(16.0))
                        .rounded(px(radius::MD))
                        .bg(p.paper.solid())
                        .border_1()
                        .border_color(p.hairline())
                        .flex()
                        .flex_col()
                        .gap(px(12.0))
                        .child(
                            div()
                                .text_size(px(13.0))
                                .font_weight(gpui::FontWeight::SEMIBOLD)
                                .text_color(p.ink(1).solid())
                                .child(t(cx, k_se::MANUAL_RELATION_TITLE)),
                        )
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .items_center()
                                .justify_between()
                                .gap(px(8.0))
                                .child(
                                    div()
                                        .text_size(px(12.0))
                                        .text_color(p.ink(1).solid())
                                        .child(SharedString::from(format!(
                                            "{from_name} → {to_name}"
                                        ))),
                                )
                                .child(
                                    Button::new("se-pending-swap", t(cx, k_rt::SWAP))
                                        .text()
                                        .small()
                                        .on_click(cx.listener(|this, _, _window, cx| {
                                            if let Some(pl) = &mut this.pending_link {
                                                pl.reversed = !pl.reversed;
                                                cx.notify();
                                            }
                                        })),
                                ),
                        )
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .gap(px(6.0))
                                .child(
                                    div()
                                        .text_size(px(11.0))
                                        .text_color(p.ink(3).solid())
                                        .child(t(cx, k_edge::KIND_LABEL)),
                                )
                                .when(no_types, |d| {
                                    d.child(
                                        Button::new(
                                            "se-pending-create-type",
                                            t(cx, k_rt::CREATE_INLINE),
                                        )
                                        .text()
                                        .small()
                                        .on_click(
                                            cx.listener(|this, _, window, cx| {
                                                this.open_type_manager(window, cx);
                                            }),
                                        ),
                                    )
                                })
                                .when(!no_types, |d| {
                                    d.child(
                                        div()
                                            .flex()
                                            .flex_wrap()
                                            .gap(px(6.0))
                                            .children(type_buttons),
                                    )
                                }),
                        )
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .justify_end()
                                .gap(px(8.0))
                                .child(
                                    Button::new("se-pending-cancel", t(cx, k_detail::CLOSE))
                                        .text()
                                        .small()
                                        .on_click(cx.listener(|this, _, _window, cx| {
                                            this.pending_link = None;
                                            cx.notify();
                                        })),
                                )
                                .child(
                                    Button::new("se-pending-confirm", t(cx, k_edge::CREATE))
                                        .small()
                                        .disabled(selected_tid.is_none())
                                        .on_click(cx.listener(|this, _, _window, cx| {
                                            let _ = this.confirm_pending_link(cx);
                                        })),
                                ),
                        ),
                )
                .into_any_element(),
        )
    }

    pub(crate) fn render_selected_edge_popover(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let edge_id = self.selected_edge_id.as_deref()?;
        let rel = self.relations.iter().find(|r| r.id == edge_id)?;
        let p = Theme::of(window, cx).palette;
        let from_name = self.endpoint_label(&rel.from.kind, &rel.from.id);
        let to_name = self.endpoint_label(&rel.to.kind, &rel.to.id);
        let type_label = self.relation_type_label(&rel.relation_type);
        let color = self.relation_type_color(&rel.relation_type, window, cx);
        let del_id = rel.id.clone();

        Some(
            div()
                .id("se-edge-popover")
                .absolute()
                .bottom(px(16.0))
                .left(px(16.0))
                .w(px(280.0))
                .p(px(12.0))
                .rounded(px(radius::MD))
                .bg(p.paper.solid())
                .border_1()
                .border_color(p.hairline())
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .flex()
                .flex_col()
                .gap(px(8.0))
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
                                    KindMark::new("se-edge-popover-mark", sand::Kind::Storyline)
                                        .color(color)
                                        .scale(11.0 / 14.0),
                                )
                                .child(
                                    div()
                                        .text_size(px(12.0))
                                        .font_weight(gpui::FontWeight::SEMIBOLD)
                                        .text_color(p.ink(1).solid())
                                        .child(SharedString::from(type_label)),
                                ),
                        )
                        .child(
                            Button::new("se-edge-popover-close", t(cx, k_detail::CLOSE))
                                .text()
                                .small()
                                .icon(Icon::Close)
                                .on_click(cx.listener(|this, _, _window, cx| {
                                    this.selected_edge_id = None;
                                    cx.notify();
                                })),
                        ),
                )
                .child(
                    div()
                        .text_size(px(11.5))
                        .text_color(p.ink(2).solid())
                        .child(SharedString::from(format!("{from_name} → {to_name}"))),
                )
                .child(
                    div().flex().flex_row().justify_end().child(
                        Button::new("se-edge-delete", t(cx, k_edge::DELETE))
                            .danger()
                            .small()
                            .icon(Icon::Trash)
                            .on_click(cx.listener(move |this, _, _window, cx| {
                                let _ = this.delete_relation(&del_id, cx);
                            })),
                    ),
                )
                .into_any_element(),
        )
    }

    pub(crate) fn render_type_manager_modal(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let state = self.type_manager.as_ref()?;
        let p = Theme::of(window, cx).palette;

        let mut in_use_counts: HashMap<&str, usize> = HashMap::new();
        for r in &self.relations {
            *in_use_counts.entry(r.relation_type.as_str()).or_insert(0) += 1;
        }

        let existing_rows: Vec<AnyElement> = self
            .relation_types
            .iter()
            .map(|rt| {
                let tid = rt.definition.id.clone();
                let count = in_use_counts.get(tid.as_str()).copied().unwrap_or(0);
                let locked = rt.locked || rt.system_key.is_some();
                let can_delete = !locked && count == 0;
                let color = rt
                    .definition
                    .color
                    .as_deref()
                    .and_then(color_of)
                    .unwrap_or_else(|| p.ink(2));
                let del_id = tid.clone();
                let rtm_mark_id = format!("se-rtm-mark-{tid}");
                div()
                    .id(ElementId::Name(format!("se-rtm-row-{tid}").into()))
                    .px(px(8.0))
                    .py(px(5.0))
                    .rounded(px(radius::SM))
                    .border_1()
                    .border_color(p.hairline())
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .gap(px(8.0))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(6.0))
                            .child(
                                KindMark::new(
                                    ElementId::Name(rtm_mark_id.into()),
                                    sand::Kind::Storyline,
                                )
                                .color(color)
                                .scale(10.0 / 14.0),
                            )
                            .child(
                                div()
                                    .text_size(px(11.5))
                                    .text_color(p.ink(1).solid())
                                    .child(SharedString::from(rt.definition.name.clone())),
                            )
                            .when(locked, |d| {
                                d.child(
                                    div()
                                        .px(px(4.0))
                                        .rounded(px(radius::SM))
                                        .bg(p.ink(4).alpha(0.14))
                                        .text_size(px(10.0))
                                        .text_color(p.ink(3).solid())
                                        .child(t(cx, k_rt::BUILT_IN)),
                                )
                            }),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(6.0))
                            .child(
                                div()
                                    .text_size(px(10.5))
                                    .text_color(p.ink(3).solid())
                                    .child(SharedString::from(count.to_string())),
                            )
                            .when(can_delete, |d| {
                                d.child(
                                    Button::new(
                                        ElementId::Name(format!("se-rtm-del-{tid}").into()),
                                        t(cx, k_rt::DELETE),
                                    )
                                    .text()
                                    .small()
                                    .icon(Icon::Trash)
                                    .on_click(cx.listener(
                                        move |this, _, _window, cx| {
                                            let _ = this.delete_relation_type(&del_id, cx);
                                        },
                                    )),
                                )
                            }),
                    )
                    .into_any_element()
            })
            .collect();

        let dir_labels = vec![t(cx, k_rt::DIRECTED), t(cx, k_rt::SYMMETRIC)];
        let dir_idx = if state.directed { 0 } else { 1 };
        let weak_dir = cx.entity().downgrade();
        let dir_seg = Segmented::new("se-rtm-direction", dir_labels, dir_idx).on_change(
            move |idx, _window, cx| {
                if let Some(ov) = weak_dir.upgrade() {
                    ov.update(cx, |this, cx| {
                        if let Some(st) = &mut this.type_manager {
                            st.directed = idx == 0;
                            cx.notify();
                        }
                    });
                }
            },
        );

        let name_field = state.name_field.clone();
        let src_field = state.source_role_field.clone();
        let dst_field = state.target_role_field.clone();
        let directed = state.directed;

        Some(
            div()
                .id("se-type-manager-modal")
                .absolute()
                .inset_0()
                .bg(p.ink(1).alpha(0.18))
                .flex()
                .items_center()
                .justify_center()
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .child(
                    div()
                        .w(px(380.0))
                        .max_h(px(520.0))
                        .p(px(16.0))
                        .rounded(px(radius::MD))
                        .bg(p.paper.solid())
                        .border_1()
                        .border_color(p.hairline())
                        .flex()
                        .flex_col()
                        .gap(px(12.0))
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .items_center()
                                .justify_between()
                                .child(
                                    div()
                                        .text_size(px(13.0))
                                        .font_weight(gpui::FontWeight::SEMIBOLD)
                                        .text_color(p.ink(1).solid())
                                        .child(t(cx, k_rt::TITLE)),
                                )
                                .child(
                                    Button::new("se-rtm-close", t(cx, k_detail::CLOSE))
                                        .text()
                                        .small()
                                        .icon(Icon::Close)
                                        .on_click(cx.listener(|this, _, _window, cx| {
                                            this.type_manager = None;
                                            cx.notify();
                                        })),
                                ),
                        )
                        .child(
                            div()
                                .id("se-rtm-list")
                                .max_h(px(220.0))
                                .overflow_y_scroll()
                                .flex()
                                .flex_col()
                                .gap(px(4.0))
                                .children(existing_rows),
                        )
                        .child(
                            div()
                                .pt(px(8.0))
                                .border_t_1()
                                .border_color(p.hairline())
                                .flex()
                                .flex_col()
                                .gap(px(8.0))
                                .child(
                                    div()
                                        .text_size(px(11.0))
                                        .text_color(p.ink(3).solid())
                                        .child(t(cx, k_rt::CREATE_INLINE)),
                                )
                                .child(
                                    div()
                                        .h(px(28.0))
                                        .px(px(8.0))
                                        .rounded(px(radius::SM))
                                        .border_1()
                                        .border_color(p.hairline())
                                        .flex()
                                        .items_center()
                                        .child(name_field),
                                )
                                .child(dir_seg)
                                .when(directed, |d| {
                                    d.child(
                                        div()
                                            .flex()
                                            .flex_row()
                                            .gap(px(6.0))
                                            .child(
                                                div()
                                                    .flex_1()
                                                    .h(px(28.0))
                                                    .px(px(8.0))
                                                    .rounded(px(radius::SM))
                                                    .border_1()
                                                    .border_color(p.hairline())
                                                    .flex()
                                                    .items_center()
                                                    .child(src_field),
                                            )
                                            .child(
                                                div()
                                                    .flex_1()
                                                    .h(px(28.0))
                                                    .px(px(8.0))
                                                    .rounded(px(radius::SM))
                                                    .border_1()
                                                    .border_color(p.hairline())
                                                    .flex()
                                                    .items_center()
                                                    .child(dst_field),
                                            ),
                                    )
                                })
                                .child(
                                    div().flex().flex_row().justify_end().child(
                                        Button::new("se-rtm-create-btn", t(cx, k_rt::CREATE))
                                            .small()
                                            .on_click(cx.listener(|this, _, _window, cx| {
                                                let Some(st) = &this.type_manager else {
                                                    return;
                                                };
                                                let name =
                                                    st.name_field.read(cx).text().to_string();
                                                let srole = st
                                                    .source_role_field
                                                    .read(cx)
                                                    .text()
                                                    .to_string();
                                                let trole = st
                                                    .target_role_field
                                                    .read(cx)
                                                    .text()
                                                    .to_string();
                                                let dir = st.directed;
                                                match this.create_relation_type(
                                                    &name, dir, &srole, &trole, cx,
                                                ) {
                                                    Ok(_) => {
                                                        if let Some(st) = &this.type_manager {
                                                            st.name_field.update(cx, |f, cx| {
                                                                f.set_text("", cx)
                                                            });
                                                            st.source_role_field
                                                                .update(cx, |f, cx| {
                                                                    f.set_text("", cx)
                                                                });
                                                            st.target_role_field
                                                                .update(cx, |f, cx| {
                                                                    f.set_text("", cx)
                                                                });
                                                        }
                                                        if this.pending_link.is_some() {
                                                            this.type_manager = None;
                                                        }
                                                        cx.notify();
                                                    }
                                                    Err(err) => {
                                                        if let Some(st) = &mut this.type_manager {
                                                            st.error = Some(err);
                                                        }
                                                        cx.notify();
                                                    }
                                                }
                                            })),
                                    ),
                                ),
                        ),
                )
                .into_any_element(),
        )
    }
}
