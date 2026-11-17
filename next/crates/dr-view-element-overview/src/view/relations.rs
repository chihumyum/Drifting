//! Relation graph curves and their shared legend.

use std::collections::HashMap;
use std::rc::Rc;

use dr_i18n::keys::edge_kind_manager as k_ekm;
use dr_i18n::keys::story_graph::edge as k_edge;
use dr_i18n::keys::super_element::isles as k_isles;
use dr_model::v3::RelationDirection;
use dr_shell::strings::{t, tf};
use dr_ui::{
    Theme,
    tokens::{Rgb, radius},
};
use dr_view_relations::legend::{Legend, Row as LegendRow, render as render_shared_legend};
use dr_workspace::commands::v3::relations::RelationInfo;
use gpui::{
    AnyElement, Context, ElementId, InteractiveElement, IntoElement, MouseButton, ParentElement,
    SharedString, StatefulInteractiveElement, Styled, Window, div, px,
};

use super::ElementOverview;
use crate::relate::{
    ElementLayoutMode, RelateEdgeInput, RelatePoint, RelateRoleLabel, relate_bend,
    relate_cell_half, relate_edge_geometry, relate_role_half,
};

#[derive(Clone, Debug)]
pub struct GraphRelation {
    pub id: String,
    pub relation_type: String,
    pub from: String,
    pub to: String,
    pub directed: bool,
}

pub(super) fn graph_relations(types: &[RelationInfo]) -> Vec<GraphRelation> {
    let mut result = Vec::new();
    for relation in types {
        let directed = relation.direction == RelationDirection::Directed;
        let mut seen = std::collections::HashSet::new();
        for row in &relation.rows {
            for left in &row.left {
                for right in &row.right {
                    let key = if directed || left < right {
                        (left, right)
                    } else {
                        (right, left)
                    };
                    if seen.insert(key) {
                        result.push(GraphRelation {
                            id: format!("{}/{}/{}", row.id, left, right),
                            relation_type: relation.id.clone(),
                            from: left.clone(),
                            to: right.clone(),
                            directed,
                        });
                    }
                }
            }
        }
    }
    result
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

impl ElementOverview {
    pub(crate) fn relate_roles_for(&self, type_id: &str) -> Vec<String> {
        self.relation_types
            .iter()
            .find(|rt| rt.id == type_id)
            .map(|rt| vec![rt.name.clone()])
            .unwrap_or_default()
    }

    pub(crate) fn build_relate_edges(&self, ink: Rgb) -> Vec<RelateEdgeView> {
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
            if !present.contains(&r.from)
                || !present.contains(&r.to)
                || self.hidden_relation_type_ids.contains(&r.relation_type)
            {
                continue;
            }
            if !centers.contains_key(r.from.as_str()) || !centers.contains_key(r.to.as_str()) {
                continue;
            }
            let key = if r.from <= r.to {
                (r.from.clone(), r.to.clone())
            } else {
                (r.to.clone(), r.from.clone())
            };
            *pair_totals.entry(key).or_insert(0) += 1;
        }

        let mut pair_seen: HashMap<(String, String), usize> = HashMap::new();
        let mut out = Vec::new();
        let label_scale = (1.0 / f64::from(self.zoom.max(0.25))).clamp(0.5, 2.5);
        for r in &self.relations {
            if !present.contains(&r.from)
                || !present.contains(&r.to)
                || self.hidden_relation_type_ids.contains(&r.relation_type)
            {
                continue;
            }
            let Some(&from_pt) = centers.get(r.from.as_str()) else {
                continue;
            };
            let Some(&to_pt) = centers.get(r.to.as_str()) else {
                continue;
            };
            let key = if r.from <= r.to {
                (r.from.clone(), r.to.clone())
            } else {
                (r.to.clone(), r.from.clone())
            };
            let total = pair_totals.get(&key).copied().unwrap_or(1);
            let idx = *pair_seen
                .entry(key)
                .and_modify(|v| *v += 1)
                .or_insert(0usize);
            let bend = relate_bend(idx, total);
            let roles = self.relate_roles_for(&r.relation_type);
            let from_half = relate_cell_half(names_by_id.get(r.from.as_str()).unwrap_or(&""));
            let to_half = relate_cell_half(names_by_id.get(r.to.as_str()).unwrap_or(&""));
            let geom = relate_edge_geometry(RelateEdgeInput {
                from_id: &r.from,
                to_id: &r.to,
                from: from_pt,
                to: to_pt,
                from_half,
                to_half,
                bend,
                roles: &roles,
                label_scale,
            });

            out.push(RelateEdgeView {
                id: r.id.clone(),
                relation_type_id: r.relation_type.clone(),
                from_id: r.from.clone(),
                to_id: r.to.clone(),
                color: ink,
                p0: geom.p0,
                ctrl: geom.ctrl,
                p2: geom.p2,
                directed: r.directed,
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
            if present.contains(&r.from) && present.contains(&r.to) {
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
            let count = counts_by_type.get(rt.id.as_str()).copied().unwrap_or(0);
            if count == 0 && self.relation_types.len() > 6 {
                continue;
            }
            let hidden = self.hidden_relation_type_ids.contains(&rt.id);
            let rt_name = rt.name.as_str();
            let hint = if hidden {
                tf(cx, k_edge::SHOW_KIND, &[("label", &rt_name)])
            } else {
                tf(cx, k_edge::HIDE_KIND, &[("label", &rt_name)])
            };
            rows.push(LegendRow {
                id: format!("se-legend-type-{}", rt.id),
                label: SharedString::from(rt.name.clone()),
                count,
                color: p.ink(2),
                visible: !hidden,
                hint,
                sand: false,
            });
        }

        let weak_toggle = cx.entity().downgrade();
        let shared = render_shared_legend(
            Legend {
                id: "se-relation-legend",
                rows,
                empty: t(cx, k_ekm::EMPTY),
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
            .into_any_element()
    }
}
