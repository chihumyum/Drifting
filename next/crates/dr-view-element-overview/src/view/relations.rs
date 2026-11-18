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
    AnyElement, Bounds, Context, ElementId, InteractiveElement, IntoElement, MouseButton,
    ParentElement, Pixels, Point, SharedString, StatefulInteractiveElement, Styled, Window, div,
    point, px, size,
};

use super::ElementOverview;
use crate::relate::{
    ElementLayoutMode, RelateEdgeInput, RelatePoint, RelateRoleLabel, on_quad, relate_bend,
    relate_edge_geometry, relate_role_half,
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

/// An explicit relation incident on a peeked entry. Same-side row members
/// never appear here; `graph_relations` has already expanded only cross pairs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PeekRelation {
    pub relation: String,
    pub name: String,
    pub other: String,
    pub direction: super::PairDirection,
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
    pub target_half: (f32, f32),
    pub labels: Vec<RelateRoleLabel>,
}

fn badge_bounds(label: &RelateRoleLabel, zoom: f32, pan: Point<f32>) -> Bounds<Pixels> {
    let (hw, hh) = relate_role_half(&label.text);
    let x = (label.x as f32) * zoom + pan.x;
    let y = (label.y as f32) * zoom + pan.y;
    Bounds::new(
        point(px(x - hw as f32), px(y - hh as f32)),
        size(px(2.0 * hw as f32), px(2.0 * hh as f32)),
    )
}

fn label_priority(
    edge: &RelateEdgeView,
    pointed: Option<&str>,
    selected: Option<&str>,
    focus: Option<&str>,
) -> (bool, bool) {
    let active = selected == Some(edge.id.as_str())
        || focus.is_some_and(|id| edge.from_id == id || edge.to_id == id);
    (pointed != Some(edge.id.as_str()), !active)
}

fn visible_labels<'a>(
    edges: impl IntoIterator<Item = &'a RelateEdgeView>,
    cards: &[Bounds<Pixels>],
    viewport: Bounds<Pixels>,
    zoom: f32,
    pan: Point<f32>,
) -> Vec<(&'a RelateEdgeView, usize, Bounds<Pixels>)> {
    let mut placed: Vec<(&RelateEdgeView, usize, Bounds<Pixels>)> = Vec::new();
    for edge in edges {
        for (index, label) in edge.labels.iter().enumerate() {
            let badge = badge_bounds(label, zoom, pan);
            if viewport.intersects(&badge)
                && !cards.iter().any(|card| card.intersects(&badge))
                && !placed.iter().any(|(_, _, other)| other.intersects(&badge))
            {
                placed.push((edge, index, badge));
            }
        }
    }
    placed
}

/// Pick the nearest curve in window pixels. Straight segments between samples
/// follow the painted quadratic without requiring a rectangular hit region.
fn curve_distance(edge: &RelateEdgeView, at: RelatePoint, zoom: f32) -> f64 {
    let margin = 5.0 / f64::from(zoom);
    let bounds = |a: f64, b: f64, c: f64| (a.min(b).min(c) - margin)..=(a.max(b).max(c) + margin);
    if !bounds(edge.p0.x, edge.ctrl.x, edge.p2.x).contains(&at.x)
        || !bounds(edge.p0.y, edge.ctrl.y, edge.p2.y).contains(&at.y)
    {
        return f64::INFINITY;
    }
    let span = (edge.p2.x - edge.p0.x).hypot(edge.p2.y - edge.p0.y);
    let steps = (span * f64::from(zoom) / 12.0).ceil().clamp(8.0, 128.0) as u32;
    let mut last = edge.p0;
    let mut best = f64::INFINITY;
    for i in 1..=steps {
        let next = on_quad(edge.p0, edge.ctrl, edge.p2, f64::from(i) / f64::from(steps));
        let (dx, dy) = (next.x - last.x, next.y - last.y);
        let squared = dx * dx + dy * dy;
        if squared > 0.0 {
            let t = (((at.x - last.x) * dx + (at.y - last.y) * dy) / squared).clamp(0.0, 1.0);
            best = best.min((at.x - last.x - t * dx).hypot(at.y - last.y - t * dy));
        }
        last = next;
    }
    best * f64::from(zoom)
}

/// An arrow submitted by the most recent graph canvas paint, in window pixels.
/// This is paint evidence, not the set of directed relations in the book.
#[derive(Clone, Debug)]
pub struct PaintedRelationArrow {
    pub relation_type: String,
    pub from: String,
    pub to: String,
    pub tip: Point<Pixels>,
    pub wings: [Point<Pixels>; 2],
    pub color: Rgb,
}

impl RelateEdgeView {
    /// The graph curve is ordered by id for stable bends, independently of
    /// relation direction. Find where that curve leaves the target card, then
    /// point the old graph's 9 × 8 triangle back towards the target.
    pub(super) fn arrow(
        &self,
        to_screen: impl Fn(RelatePoint) -> Point<Pixels>,
        zoom: f32,
    ) -> Option<PaintedRelationArrow> {
        if !self.directed {
            return None;
        }
        let (target, source) = if self.from_id < self.to_id {
            (to_screen(self.p2), to_screen(self.p0))
        } else {
            (to_screen(self.p0), to_screen(self.p2))
        };
        let ctrl = to_screen(self.ctrl);
        // Match the rendered card's minimum dimensions, with a 2px gap so
        // the triangle is not painted underneath the card at low zoom.
        let half = (
            (self.target_half.0 * zoom).max(12.0) + 2.0,
            (self.target_half.1 * zoom).max(10.0) + 2.0,
        );
        let at = |t: f32| {
            let u = 1.0 - t;
            point(
                target.x * (u * u) + ctrl.x * (2.0 * u * t) + source.x * (t * t),
                target.y * (u * u) + ctrl.y * (2.0 * u * t) + source.y * (t * t),
            )
        };
        let outside = |p: Point<Pixels>| {
            f32::from(p.x - target.x).abs() >= half.0 || f32::from(p.y - target.y).abs() >= half.1
        };
        let step = (1..=32).find(|i| outside(at(*i as f32 / 32.0)))?;
        let (mut lo, mut hi) = ((step - 1) as f32 / 32.0, step as f32 / 32.0);
        for _ in 0..16 {
            let mid = (lo + hi) * 0.5;
            if outside(at(mid)) {
                hi = mid;
            } else {
                lo = mid;
            }
        }
        let tip = at(hi);
        let dx = f32::from((target.x - ctrl.x) * (1.0 - hi) + (ctrl.x - source.x) * hi);
        let dy = f32::from((target.y - ctrl.y) * (1.0 - hi) + (ctrl.y - source.y) * hi);
        let len = dx.hypot(dy);
        if len <= f32::EPSILON {
            return None;
        }
        let (ux, uy) = (dx / len, dy / len);
        let wing = |side: f32| {
            point(
                tip.x - px(ux * 9.0 + uy * 4.0 * side),
                tip.y - px(uy * 9.0 - ux * 4.0 * side),
            )
        };
        Some(PaintedRelationArrow {
            relation_type: self.relation_type_id.clone(),
            from: self.from_id.clone(),
            to: self.to_id.clone(),
            tip,
            wings: [wing(-1.0), wing(1.0)],
            color: self.color,
        })
    }
}

/// The same single-line display rule as TextField. Entry titles can legally
/// contain line breaks; keep the stored title intact and measure what we show.
pub(super) fn card_name(name: &str) -> String {
    name.replace(['\r', '\n'], " ")
}

impl ElementOverview {
    /// Cache the actual UI glyph advance once per book snapshot; camera changes
    /// reuse it and do not reshape names or restart the force layout.
    pub(super) fn measure_relate_names(&mut self, cx: &gpui::App) {
        use dr_ui::fonts::{Role, weight};
        let text_system = gpui::WindowTextSystem::new(cx.text_system().clone());
        self.relate_name_widths = self
            .elements
            .iter()
            .map(|el| {
                let text = card_name(&el.name);
                let run = gpui::TextRun {
                    len: text.len(),
                    font: Role::Ui.font(weight::REGULAR),
                    color: gpui::Hsla::default(),
                    background_color: None,
                    underline: None,
                    strikethrough: None,
                };
                let line = text_system.shape_line(text.into(), px(11.5), &[run], None);
                (el.id.clone(), f32::from(line.width()))
            })
            .collect();
    }

    pub(super) fn relate_name_shown(
        &self,
        id: &str,
        neighbours: &Option<std::collections::HashSet<String>>,
    ) -> bool {
        crate::isles::isles_lod(self.zoom) != crate::isles::IslesLod::Far
            || self.isle_focus.as_deref() == Some(id)
            || neighbours.as_ref().is_some_and(|n| n.contains(id))
            || self.cached_major_ids.contains(id)
    }

    /// Card half-size in world coordinates. Its fixed-size label, mark, gap,
    /// padding and border must still fit when the graph is zoomed out. Long
    /// names retain the existing 160px cap; hidden Far-LOD names need no floor.
    pub(super) fn relate_card_half(
        &self,
        el: &crate::isles::IslandItem,
        show_name: bool,
    ) -> (f64, f64) {
        let (hw, hh) = crate::relate::relate_cell_half(&el.name);
        let zoom = f64::from(self.zoom);
        let mut width = (hw * 2.0 * zoom).max(24.0);
        if show_name {
            // 2px border + 12px padding + 4px gap + the largest 13px mark.
            let text = f64::from(
                self.relate_name_widths
                    .get(&el.id)
                    .copied()
                    .unwrap_or_default(),
            );
            width = width.max((text.ceil() + 31.0).min(crate::relate::RELATE_CELL_MAX_W));
        }
        (
            width / (2.0 * zoom),
            (hh * 2.0 * zoom).max(20.0) / (2.0 * zoom),
        )
    }

    pub fn peek_relations(&self, entry: &str) -> Vec<PeekRelation> {
        self.relations
            .iter()
            .filter_map(|edge| {
                let (other, direction) = if edge.from == entry {
                    (&edge.to, super::PairDirection::Forward)
                } else if edge.to == entry {
                    (&edge.from, super::PairDirection::Reverse)
                } else {
                    return None;
                };
                self.book.v3()?.entry(other)?;
                let relation = self
                    .relation_types
                    .iter()
                    .find(|r| r.id == edge.relation_type)?;
                Some(PeekRelation {
                    relation: relation.id.clone(),
                    name: relation.name.clone(),
                    other: other.clone(),
                    direction: if edge.directed {
                        direction
                    } else {
                        super::PairDirection::Both
                    },
                })
            })
            .collect()
    }

    pub(crate) fn relate_roles_for(&self, type_id: &str) -> Vec<String> {
        self.relation_types
            .iter()
            .find(|rt| rt.id == type_id)
            .map(|rt| vec![rt.name.clone()])
            .unwrap_or_default()
    }

    pub(crate) fn build_relate_edges(&self, ink: Rgb) -> Vec<RelateEdgeView> {
        let present = self.present_element_ids();
        let neighbours = self.neighbourhood();
        let sizes: HashMap<&str, (f64, f64)> = self
            .elements
            .iter()
            .map(|el| {
                (
                    el.id.as_str(),
                    self.relate_card_half(el, self.relate_name_shown(&el.id, &neighbours)),
                )
            })
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
            let from_half = sizes[r.from.as_str()];
            let to_half = sizes[r.to.as_str()];
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
                target_half: (to_half.0 as f32, to_half.1 as f32),
                labels: geom.labels,
            });
        }
        out
    }

    fn touches_focus(&self, edge: &RelateEdgeView) -> bool {
        self.isle_focus
            .as_deref()
            .is_some_and(|id| edge.from_id == id || edge.to_id == id)
    }

    fn role_edge_visible(&self, edge: &RelateEdgeView) -> bool {
        !self.isolated || self.isle_focus.is_none() || self.touches_focus(edge)
    }

    pub(super) fn point_relation_edge(
        &mut self,
        position: Point<Pixels>,
        edges: &[RelateEdgeView],
        cards: &[Bounds<Pixels>],
        cx: &mut Context<Self>,
    ) {
        let hovered = self.viewport_bounds.and_then(|view| {
            let local = position - view.origin;
            if self.pan_drag.is_some() || cards.iter().any(|card| card.contains(&local)) {
                return None;
            }
            let world = RelatePoint::new(
                f64::from((f32::from(local.x) - self.pan.x) / self.zoom),
                f64::from((f32::from(local.y) - self.pan.y) / self.zoom),
            );
            edges
                .iter()
                .filter(|edge| self.role_edge_visible(edge))
                .filter_map(|edge| {
                    let distance = curve_distance(edge, world, self.zoom);
                    (distance <= 5.0).then_some((distance, &edge.id))
                })
                .min_by(|a, b| a.0.total_cmp(&b.0))
                .map(|(_, id)| id.clone())
        });
        if self.hovered_relation_edge != hovered {
            self.hovered_relation_edge = hovered;
            cx.notify();
        }
    }

    pub(crate) fn render_relate_role_labels(
        &self,
        edges: &[RelateEdgeView],
        cards: &[Bounds<Pixels>],
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let p = Theme::of(window, cx).palette;
        let mut order: Vec<_> = edges
            .iter()
            .filter(|edge| self.role_edge_visible(edge))
            .collect();
        order.sort_by_key(|edge| {
            label_priority(
                edge,
                self.hovered_relation_edge.as_deref(),
                self.selected_edge_id.as_deref(),
                self.isle_focus.as_deref(),
            )
        });
        let viewport = Bounds::new(
            point(px(0.), px(0.)),
            self.viewport_bounds
                .map_or(window.viewport_size(), |b| b.size),
        );
        let mut out = Vec::new();
        for (edge, idx, bounds) in visible_labels(order, cards, viewport, self.zoom, self.pan) {
            let lbl = &edge.labels[idx];
            let edge_id = edge.id.clone();
            let badge = div()
                .id(ElementId::Name(
                    format!("se-role-badge-{}-{idx}", edge.id).into(),
                ))
                .debug_selector({
                    let id = edge.id.clone();
                    move || format!("se-role-badge-{id}-{idx}")
                })
                .absolute()
                .left(bounds.origin.x)
                .top(bounds.origin.y)
                .w(bounds.size.width)
                .h(bounds.size.height)
                .px(px(4.0))
                .rounded(px(radius::SM))
                .bg(p.paper.alpha(0.92))
                .border_1()
                .border_color(edge.color.alpha(0.45))
                .cursor_pointer()
                .role(gpui::Role::Button)
                .aria_label(SharedString::from(lbl.text.clone()))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pointed_curve_replaces_an_overlapping_label_and_leaves_cards_clear() {
        let edge = |id: &str, y, from: &str, label_x| RelateEdgeView {
            id: id.into(),
            relation_type_id: id.into(),
            from_id: from.into(),
            to_id: "b".into(),
            color: Rgb::hex(0x303030),
            p0: RelatePoint::new(0., y),
            ctrl: RelatePoint::new(90., y),
            p2: RelatePoint::new(180., y),
            directed: false,
            target_half: (12., 10.),
            labels: vec![RelateRoleLabel {
                text: "相识".into(),
                x: label_x,
                y,
            }],
        };
        let edges = [
            edge("one", 24., "a", 90.),
            edge("two", 35., "c", 90.),
            edge("card", 52., "d", 90.),
        ];
        let cards = [Bounds::new(point(px(74.), px(44.)), size(px(32.), px(16.)))];
        let viewport = Bounds::new(point(px(0.), px(0.)), size(px(200.), px(100.)));
        let show = |pointed, focus| {
            let mut order: Vec<_> = edges.iter().collect();
            order.sort_by_key(|edge| label_priority(edge, pointed, None, focus));
            visible_labels(order, &cards, viewport, 1., point(0., 0.))
                .into_iter()
                .map(|(edge, _, _)| edge.id.as_str())
                .collect::<Vec<_>>()
        };
        assert_eq!(show(None, None), ["one"]);
        assert_eq!(show(None, Some("c")), ["two"]);
        let at = RelatePoint::new(100., 35.);
        let closest = edges
            .iter()
            .min_by(|a, b| curve_distance(a, at, 1.).total_cmp(&curve_distance(b, at, 1.)))
            .unwrap();
        assert_eq!(closest.id, "two");
        assert_eq!(show(Some(closest.id.as_str()), Some("a")), ["two"]);
    }
}
