//! Interactive force-directed relation graph rendered when the 「关系」 right
//! sidebar enters Fill (`铺满`) mode.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::rc::Rc;

use dr_i18n::keys;
use dr_model::v3::RelationDirection;
use dr_shell::strings::t;
use dr_ui::{
    Theme,
    components::{PanelIconButton, tooltip},
    fonts::{Role, weight},
    glass::{self, Kind, Mode, Spec, Tone},
    sand::{self, Icon, KindMark},
    style::DrStyled as _,
    tokens::{Rgb, radius},
};
use gpui::{
    AnyElement, Context, ElementId, InteractiveElement as _, IntoElement, MouseButton,
    MouseDownEvent, MouseMoveEvent, ParentElement as _, PathBuilder, Pixels, Point, ScrollDelta,
    ScrollEvent, SharedString, StatefulInteractiveElement as _, Styled as _, Window, canvas, div,
    point, prelude::FluentBuilder as _, px, size,
};

use crate::rail::{Card, RelationsRail};

/// Calm ink-wash relation hues (RGB) used to distinguish relation types on the
/// force-directed graph canvas.
const TYPE_HUES: [Rgb; 8] = [
    Rgb::hex(0x9A543E), // terracotta
    Rgb::hex(0x4A678A), // indigo
    Rgb::hex(0x4E7A5D), // sage
    Rgb::hex(0xA17A38), // ochre
    Rgb::hex(0x7B5683), // plum
    Rgb::hex(0x3F7A7D), // slate-teal
    Rgb::hex(0x8C6248), // bronze
    Rgb::hex(0x9C5368), // rose-ink
];

#[derive(Clone, PartialEq, Eq)]
struct LayoutKey {
    seed: u64,
    nodes: Vec<String>,
    edges: Vec<(String, String)>,
}

pub(crate) struct GraphState {
    pub pan: (f32, f32),
    pub zoom: f32,
    pub drag: Option<(Point<Pixels>, (f32, f32))>,
    pub hover_node: Option<String>,
    pub hidden_types: HashSet<String>,
    pub layout_seed: u64,
    pub viewport: Rc<RefCell<(f32, f32)>>,
    layout_key: Option<LayoutKey>,
    positions: HashMap<String, (f32, f32)>,
}

impl GraphState {
    pub fn new() -> Self {
        Self {
            pan: (0.0, 0.0),
            zoom: 1.0,
            drag: None,
            hover_node: None,
            hidden_types: HashSet::new(),
            layout_seed: 1,
            viewport: Rc::new(RefCell::new((640.0, 520.0))),
            layout_key: None,
            positions: HashMap::new(),
        }
    }

    pub fn reset(&mut self) {
        self.pan = (0.0, 0.0);
        self.zoom = 1.0;
        self.drag = None;
        self.hover_node = None;
        self.hidden_types.clear();
        self.layout_key = None;
        self.positions.clear();
    }

    fn ensure_layout(
        &mut self,
        nodes: &[String],
        edges: &[(String, String)],
    ) -> &HashMap<String, (f32, f32)> {
        let key = LayoutKey {
            seed: self.layout_seed,
            nodes: nodes.to_vec(),
            edges: edges.to_vec(),
        };
        if self.layout_key.as_ref() != Some(&key) {
            self.positions = compute_layout(nodes, edges, self.layout_seed);
            self.layout_key = Some(key);
        }
        &self.positions
    }
}

#[derive(Clone, Copy)]
struct PaintEdge {
    from: (f32, f32),
    to: (f32, f32),
    offset: f32,
    directed: bool,
    color: gpui::Hsla,
    width: f32,
}

#[derive(Clone)]
struct GraphEdge {
    from: String,
    to: String,
    relation_id: String,
    relation_name: String,
    directed: bool,
    color: Rgb,
    /// Offset index when multiple edges share the same unordered node pair.
    parallel_offset: f32,
}

fn splitmix64(mut x: u64) -> u64 {
    x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = x;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

fn hash_str(s: &str, seed: u64) -> u64 {
    let mut h = seed ^ 0xCBF2_9CE4_8422_2325;
    for b in s.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01B3);
    }
    splitmix64(h)
}

/// Deterministic Fruchterman-Reingold force-directed layout normalized into
/// `[-0.82, 0.82]` coordinate space.
fn compute_layout(
    nodes: &[String],
    edges: &[(String, String)],
    seed: u64,
) -> HashMap<String, (f32, f32)> {
    let n = nodes.len();
    let mut out = HashMap::with_capacity(n);
    if n == 0 {
        return out;
    }
    if n == 1 {
        out.insert(nodes[0].clone(), (0.0, 0.0));
        return out;
    }
    if n == 2 {
        out.insert(nodes[0].clone(), (-0.45, 0.0));
        out.insert(nodes[1].clone(), (0.45, 0.0));
        return out;
    }

    let index: HashMap<&str, usize> = nodes
        .iter()
        .enumerate()
        .map(|(i, id)| (id.as_str(), i))
        .collect();
    let edge_indices: Vec<(usize, usize)> = edges
        .iter()
        .filter_map(|(a, b)| {
            let i = *index.get(a.as_str())?;
            let j = *index.get(b.as_str())?;
            (i != j).then_some((i, j))
        })
        .collect();

    let mut pos: Vec<(f32, f32)> = Vec::with_capacity(n);
    let tau = std::f32::consts::TAU;
    for (i, id) in nodes.iter().enumerate() {
        let h = hash_str(id, seed);
        let jitter_a = ((h & 0xFFFF) as f32 / 65535.0 - 0.5) * 0.22;
        let jitter_r = (((h >> 16) & 0xFFFF) as f32 / 65535.0 - 0.5) * 0.16;
        let angle = (i as f32 / n as f32) * tau + jitter_a;
        let r = 0.68 + jitter_r;
        pos.push((angle.cos() * r, angle.sin() * r));
    }

    let k = (1.55 / (n as f32).sqrt()).max(0.18);
    let iters = 110usize;
    let mut disp = vec![(0.0f32, 0.0f32); n];

    for iter in 0..iters {
        disp.fill((0.0, 0.0));
        // Pairwise repulsion.
        for i in 0..n {
            for j in (i + 1)..n {
                let dx = pos[i].0 - pos[j].0;
                let dy = pos[i].1 - pos[j].1;
                let dist = (dx * dx + dy * dy).sqrt().max(0.035);
                let force = (k * k) / dist;
                let fx = (dx / dist) * force;
                let fy = (dy / dist) * force;
                disp[i].0 += fx;
                disp[i].1 += fy;
                disp[j].0 -= fx;
                disp[j].1 -= fy;
            }
        }
        // Spring attraction along edges.
        for &(u, v) in &edge_indices {
            let dx = pos[u].0 - pos[v].0;
            let dy = pos[u].1 - pos[v].1;
            let dist = (dx * dx + dy * dy).sqrt().max(0.035);
            let force = (dist * dist / k) * 0.65;
            let fx = (dx / dist) * force;
            let fy = (dy / dist) * force;
            disp[u].0 -= fx;
            disp[u].1 -= fy;
            disp[v].0 += fx;
            disp[v].1 += fy;
        }
        // Gentle pull toward center to keep disconnected components grouped.
        for i in 0..n {
            disp[i].0 -= pos[i].0 * 0.12;
            disp[i].1 -= pos[i].1 * 0.12;
        }
        let temp = 0.24 * (1.0 - iter as f32 / iters as f32).max(0.02);
        for i in 0..n {
            let mag = (disp[i].0 * disp[i].0 + disp[i].1 * disp[i].1).sqrt();
            if mag > 1e-6 {
                let step = mag.min(temp);
                pos[i].0 += (disp[i].0 / mag) * step;
                pos[i].1 += (disp[i].1 / mag) * step;
            }
        }
    }

    // Center & normalize uniformly into [-0.82, 0.82].
    let (mut min_x, mut max_x) = (f32::INFINITY, f32::NEG_INFINITY);
    let (mut min_y, mut max_y) = (f32::INFINITY, f32::NEG_INFINITY);
    for &(x, y) in &pos {
        min_x = min_x.min(x);
        max_x = max_x.max(x);
        min_y = min_y.min(y);
        max_y = max_y.max(y);
    }
    let cx = (min_x + max_x) * 0.5;
    let cy = (min_y + max_y) * 0.5;
    let half_span = ((max_x - min_x).max(max_y - min_y) * 0.5).max(0.25);
    let scale = 0.80 / half_span;

    for (i, id) in nodes.iter().enumerate() {
        out.insert(
            id.clone(),
            ((pos[i].0 - cx) * scale, (pos[i].1 - cy) * scale),
        );
    }
    out
}

impl RelationsRail {
    pub(crate) fn render_graph_fill(
        &mut self,
        cards: &[Card],
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);

        // Assign deterministic colors per relation type present in `cards`.
        let mut type_entries: Vec<(String, String, usize, Rgb)> = Vec::new();
        let mut type_color: HashMap<String, Rgb> = HashMap::new();
        for card in cards {
            if let Some(rel) = &card.relation {
                let idx = type_entries.len();
                let color = if idx == 0 {
                    p.accent
                } else {
                    TYPE_HUES[(idx - 1) % TYPE_HUES.len()]
                };
                type_color.insert(rel.id.clone(), color);
                type_entries.push((rel.id.clone(), rel.name.clone(), rel.pair_count, color));
            }
        }

        // Collect all nodes & layout edges across cards (so toggling a relation
        // type keeps node layout stable instead of jumping around).
        let mut all_node_set: BTreeSet<String> = BTreeSet::new();
        let mut layout_edges: Vec<(String, String)> = Vec::new();
        let mut visible_edges: Vec<GraphEdge> = Vec::new();
        let mut pair_totals: BTreeMap<(String, String), usize> = BTreeMap::new();

        for card in cards {
            let Some(rel) = &card.relation else {
                continue;
            };
            let hidden = self.graph.hidden_types.contains(&rel.id);
            let color = type_color.get(&rel.id).copied().unwrap_or(p.accent);
            let directed = rel.direction == RelationDirection::Directed;
            for row in &card.rows {
                for l in &row.left {
                    for r in &row.right {
                        if l == r || self.entry_look(l).is_none() || self.entry_look(r).is_none() {
                            continue;
                        }
                        all_node_set.insert(l.clone());
                        all_node_set.insert(r.clone());
                        let canonical = if l <= r {
                            (l.clone(), r.clone())
                        } else {
                            (r.clone(), l.clone())
                        };
                        layout_edges.push(canonical.clone());
                        if !hidden {
                            *pair_totals.entry(canonical).or_default() += 1;
                            visible_edges.push(GraphEdge {
                                from: l.clone(),
                                to: r.clone(),
                                relation_id: rel.id.clone(),
                                relation_name: rel.name.clone(),
                                directed,
                                color,
                                parallel_offset: 0.0,
                            });
                        }
                    }
                }
            }
        }

        // Assign parallel curve offsets when multiple edges share two nodes.
        let mut pair_seen: BTreeMap<(String, String), usize> = BTreeMap::new();
        for edge in &mut visible_edges {
            let canonical = if edge.from <= edge.to {
                (edge.from.clone(), edge.to.clone())
            } else {
                (edge.to.clone(), edge.from.clone())
            };
            let total = pair_totals.get(&canonical).copied().unwrap_or(1);
            let idx = *pair_seen
                .entry(canonical)
                .and_modify(|c| *c += 1)
                .or_insert(0);
            if total > 1 {
                let centered = idx as f32 - (total as f32 - 1.0) * 0.5;
                let sign = if edge.from <= edge.to { 1.0 } else { -1.0 };
                edge.parallel_offset = centered * 28.0 * sign;
            }
        }

        let all_nodes: Vec<String> = all_node_set.into_iter().collect();
        let positions = self.graph.ensure_layout(&all_nodes, &layout_edges).clone();

        // Visible nodes: nodes participating in at least one visible edge, or
        // all nodes if all relation types are hidden so canvas stays clear.
        let visible_node_set: HashSet<&str> = visible_edges
            .iter()
            .flat_map(|e| [e.from.as_str(), e.to.as_str()])
            .collect();

        let hover_node = self.graph.hover_node.clone();
        let mut hover_neighbors: HashSet<String> = HashSet::new();
        if let Some(ref h) = hover_node {
            hover_neighbors.insert(h.clone());
            for e in &visible_edges {
                if &e.from == h {
                    hover_neighbors.insert(e.to.clone());
                } else if &e.to == h {
                    hover_neighbors.insert(e.from.clone());
                }
            }
        }

        // Toolbar with per-relation-type filter chips + zoom/relayout controls.
        let mut chips = div()
            .flex_1()
            .min_w_0()
            .flex()
            .flex_row()
            .flex_wrap()
            .items_center()
            .gap(px(6.0));
        for (rel_id, rel_name, pair_count, color) in &type_entries {
            let hidden = self.graph.hidden_types.contains(rel_id);
            let toggle_id = rel_id.clone();
            let chip_id = ElementId::Name(format!("relations-graph-type-{rel_id}").into());
            chips = chips.child(
                div()
                    .id(chip_id)
                    .px(px(8.0))
                    .py(px(3.0))
                    .rounded(px(radius::SM))
                    .border_1()
                    .border_color(if hidden {
                        p.hairline()
                    } else {
                        color.alpha(0.35)
                    })
                    .bg(if hidden {
                        p.page.alpha(0.25)
                    } else {
                        color.alpha(0.10)
                    })
                    .cursor_pointer()
                    .hover(|st| st.bg(color.alpha(0.16)))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(5.0))
                    .font_role(Role::Ui)
                    .type_px(s.caption, s.line_caption)
                    .text_color(if hidden {
                        p.ink(4).solid()
                    } else {
                        p.ink(1).solid()
                    })
                    .child(
                        div()
                            .size(px(7.0))
                            .rounded_full()
                            .bg(color.alpha(if hidden { 0.25 } else { 0.9 })),
                    )
                    .child(rel_name.clone())
                    .child(
                        div()
                            .font_role(Role::Index)
                            .text_color(p.ink(4).solid())
                            .child(pair_count.to_string()),
                    )
                    .on_click(cx.listener(move |rail, _, _, cx| {
                        if !rail.graph.hidden_types.remove(&toggle_id) {
                            rail.graph.hidden_types.insert(toggle_id.clone());
                        }
                        cx.notify();
                    })),
            );
        }

        let zoom_pct = format!("{}%", (self.graph.zoom * 100.0).round() as i32);
        let zoom_out_tip = t(cx, keys::material_editor::ZOOM_OUT);
        let zoom_in_tip = t(cx, keys::material_editor::ZOOM_IN);
        let zoom_reset_tip = t(cx, keys::material_editor::ZOOM_RESET);
        let relayout_tip = t(cx, keys::super_element::relate::RELAYOUT);

        let toolbar = div()
            .flex_none()
            .w_full()
            .px(px(12.0))
            .py(px(8.0))
            .border_b(px(0.5))
            .border_color(p.hairline())
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .child(chips)
            .child(
                div()
                    .flex_none()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(2.0))
                    .child(
                        div()
                            .id("relations-graph-zoom-out-tip")
                            .tooltip(tooltip(zoom_out_tip.clone()))
                            .child(
                                PanelIconButton::new("relations-graph-zoom-out", Icon::Minus)
                                    .label(zoom_out_tip)
                                    .on_click(cx.listener(|rail, _, _, cx| {
                                        rail.graph.zoom = (rail.graph.zoom / 1.2).clamp(0.4, 2.4);
                                        cx.notify();
                                    })),
                            ),
                    )
                    .child(
                        div()
                            .id("relations-graph-zoom-reset")
                            .px(px(6.0))
                            .h(px(24.0))
                            .rounded(px(radius::SM))
                            .flex()
                            .items_center()
                            .cursor_pointer()
                            .hover(|st| st.bg(p.ink(1).alpha(0.06)))
                            .font_role(Role::Index)
                            .type_px(s.caption, s.line_caption)
                            .text_color(p.ink(2).solid())
                            .tooltip(tooltip(zoom_reset_tip))
                            .child(zoom_pct)
                            .on_click(cx.listener(|rail, _, _, cx| {
                                rail.graph.pan = (0.0, 0.0);
                                rail.graph.zoom = 1.0;
                                cx.notify();
                            })),
                    )
                    .child(
                        div()
                            .id("relations-graph-zoom-in-tip")
                            .tooltip(tooltip(zoom_in_tip.clone()))
                            .child(
                                PanelIconButton::new("relations-graph-zoom-in", Icon::Plus)
                                    .label(zoom_in_tip)
                                    .on_click(cx.listener(|rail, _, _, cx| {
                                        rail.graph.zoom = (rail.graph.zoom * 1.2).clamp(0.4, 2.4);
                                        cx.notify();
                                    })),
                            ),
                    )
                    .child(
                        div()
                            .id("relations-graph-relayout-tip")
                            .tooltip(tooltip(relayout_tip.clone()))
                            .child(
                                PanelIconButton::new("relations-graph-relayout", Icon::Rotate)
                                    .label(relayout_tip)
                                    .on_click(cx.listener(|rail, _, _, cx| {
                                        rail.graph.layout_seed =
                                            rail.graph.layout_seed.wrapping_add(1);
                                        rail.graph.layout_key = None;
                                        rail.graph.pan = (0.0, 0.0);
                                        cx.notify();
                                    })),
                            ),
                    ),
            );

        // Compute screen positions using recorded viewport size.
        let (vw, vh) = *self.graph.viewport.borrow();
        let zoom = self.graph.zoom;
        let pan = self.graph.pan;
        let half_w = vw * 0.5;
        let half_h = vh * 0.5;
        let radius_x = (vw * 0.42).max(120.0);
        let radius_y = (vh * 0.40).max(120.0);

        let to_screen = |norm: (f32, f32)| -> (f32, f32) {
            (
                half_w + norm.0 * radius_x * zoom + pan.0,
                half_h + norm.1 * radius_y * zoom + pan.1,
            )
        };

        let mut screen_pos: HashMap<String, (f32, f32)> = HashMap::with_capacity(all_nodes.len());
        for id in &all_nodes {
            if let Some(&norm) = positions.get(id) {
                screen_pos.insert(id.clone(), to_screen(norm));
            }
        }

        // Paint data for canvas (dot grid + curved/straight edges + arrowheads).
        let paint_edges: Vec<PaintEdge> = visible_edges
            .iter()
            .filter_map(|e| {
                let from = *screen_pos.get(&e.from)?;
                let to = *screen_pos.get(&e.to)?;
                let incident = hover_node
                    .as_deref()
                    .is_none_or(|h| e.from == h || e.to == h);
                let alpha = if hover_node.is_some() {
                    if incident { 0.88 } else { 0.14 }
                } else {
                    0.56
                };
                let width = if hover_node.is_some() && incident {
                    2.0
                } else {
                    1.35
                };
                Some(PaintEdge {
                    from,
                    to,
                    offset: e.parallel_offset * zoom,
                    directed: e.directed,
                    color: e.color.alpha(alpha),
                    width,
                })
            })
            .collect();

        let dot_color = p.ink(4).alpha(0.18);
        let viewport_ref = self.graph.viewport.clone();
        let me = cx.weak_entity();
        let edge_canvas = canvas(
            move |bounds, window, cx| {
                let next = (
                    f32::from(bounds.size.width).max(100.0),
                    f32::from(bounds.size.height).max(100.0),
                );
                let prev = *viewport_ref.borrow();
                if (next.0 - prev.0).abs() > 1.5 || (next.1 - prev.1).abs() > 1.5 {
                    *viewport_ref.borrow_mut() = next;
                    let me = me.clone();
                    window.defer(cx, move |_, cx| {
                        me.update(cx, |_, cx| cx.notify()).ok();
                    });
                }
            },
            move |bounds, _, window, _| {
                let origin = bounds.origin;
                let bw = f32::from(bounds.size.width);
                let bh = f32::from(bounds.size.height);

                // Subtle sand dot grid.
                let step = (28.0 * zoom).clamp(16.0, 56.0);
                let off_x = pan.0.rem_euclid(step);
                let off_y = pan.1.rem_euclid(step);
                let mut gx = off_x;
                while gx < bw {
                    let mut gy = off_y;
                    while gy < bh {
                        window.paint_quad(gpui::fill(
                            gpui::Bounds {
                                origin: origin + point(px(gx), px(gy)),
                                size: size(px(1.5), px(1.5)),
                            },
                            dot_color,
                        ));
                        gy += step;
                    }
                    gx += step;
                }

                // Relation edges + arrowheads.
                for edge in &paint_edges {
                    let PaintEdge {
                        from: p0,
                        to: p1,
                        offset,
                        directed,
                        color,
                        width,
                    } = *edge;
                    let dx = p1.0 - p0.0;
                    let dy = p1.1 - p0.1;
                    let len = (dx * dx + dy * dy).sqrt().max(1.0);
                    let nx = -dy / len;
                    let ny = dx / len;
                    let ctrl = (
                        (p0.0 + p1.0) * 0.5 + nx * offset,
                        (p0.1 + p1.1) * 0.5 + ny * offset,
                    );

                    let mut path = PathBuilder::stroke(px(width));
                    path.move_to(origin + point(px(p0.0), px(p0.1)));
                    if offset.abs() > 0.5 {
                        path.curve_to(
                            origin + point(px(p1.0), px(p1.1)),
                            origin + point(px(ctrl.0), px(ctrl.1)),
                        );
                    } else {
                        path.line_to(origin + point(px(p1.0), px(p1.1)));
                    }
                    if let Ok(built) = path.build() {
                        window.paint_path(built, color);
                    }

                    // Arrowhead at t = 0.64 along the edge so it stays clear of node pills.
                    if directed && len > 32.0 {
                        let t_val = 0.64f32;
                        let inv = 1.0 - t_val;
                        let tip_x =
                            inv * inv * p0.0 + 2.0 * inv * t_val * ctrl.0 + t_val * t_val * p1.0;
                        let tip_y =
                            inv * inv * p0.1 + 2.0 * inv * t_val * ctrl.1 + t_val * t_val * p1.1;
                        // Tangent of quadratic Bezier at t_val.
                        let tx = 2.0 * inv * (ctrl.0 - p0.0) + 2.0 * t_val * (p1.0 - ctrl.0);
                        let ty = 2.0 * inv * (ctrl.1 - p0.1) + 2.0 * t_val * (p1.1 - ctrl.1);
                        let tlen = (tx * tx + ty * ty).sqrt().max(1e-3);
                        let ux = tx / tlen;
                        let uy = ty / tlen;
                        let arrow_len = 7.5;
                        let arrow_half = 4.2;
                        let base_x = tip_x - ux * arrow_len;
                        let base_y = tip_y - uy * arrow_len;
                        let left_x = base_x - uy * arrow_half;
                        let left_y = base_y + ux * arrow_half;
                        let right_x = base_x + uy * arrow_half;
                        let right_y = base_y - ux * arrow_half;

                        let mut arrow = PathBuilder::fill();
                        arrow.move_to(origin + point(px(tip_x), px(tip_y)));
                        arrow.line_to(origin + point(px(left_x), px(left_y)));
                        arrow.line_to(origin + point(px(right_x), px(right_y)));
                        arrow.close();
                        if let Ok(built) = arrow.build() {
                            window.paint_path(built, color);
                        }
                    }
                }
            },
        )
        .absolute()
        .inset_0()
        .size_full();

        // Edge midpoint labels (shown for hovered node's edges, or all edges when graph is concise).
        let show_all_labels = visible_edges.len() <= 24;
        let mut edge_labels: Vec<AnyElement> = Vec::new();
        for (idx, e) in visible_edges.iter().enumerate() {
            let incident = hover_node
                .as_deref()
                .is_some_and(|h| e.from == h || e.to == h);
            if !show_all_labels && !incident {
                continue;
            }
            if hover_node.is_some() && !incident {
                continue;
            }
            let (Some(&p0), Some(&p1)) = (screen_pos.get(&e.from), screen_pos.get(&e.to)) else {
                continue;
            };
            let dx = p1.0 - p0.0;
            let dy = p1.1 - p0.1;
            let len = (dx * dx + dy * dy).sqrt().max(1.0);
            let nx = -dy / len;
            let ny = dx / len;
            let offset = e.parallel_offset * zoom;
            let mx = (p0.0 + p1.0) * 0.5 + nx * offset * 0.5;
            let my = (p0.1 + p1.1) * 0.5 + ny * offset * 0.5;
            edge_labels.push(
                div()
                    .id(ElementId::Name(
                        format!("relations-graph-edge-label-{}-{idx}", e.relation_id).into(),
                    ))
                    .absolute()
                    .left(px(mx - 48.0))
                    .top(px(my - 9.0))
                    .w(px(96.0))
                    .flex()
                    .justify_center()
                    .child(
                        div()
                            .px(px(5.0))
                            .py(px(1.0))
                            .rounded(px(4.0))
                            .bg(p.paper.alpha(0.88))
                            .border_1()
                            .border_color(e.color.alpha(0.28))
                            .font_role(Role::Index)
                            .type_px(10.5, 14.0)
                            .text_color(e.color.alpha(0.95))
                            .truncate()
                            .child(e.relation_name.clone()),
                    )
                    .into_any_element(),
            );
        }

        // Interactive entry node pills positioned centered at (sx, sy).
        let open = self.entry_opener(cx);
        let mut node_els: Vec<AnyElement> = Vec::new();
        for id in &all_nodes {
            if !visible_node_set.is_empty() && !visible_node_set.contains(id.as_str()) {
                continue;
            }
            let (Some(&(sx, sy)), Some(look)) = (screen_pos.get(id), self.entry_look(id)) else {
                continue;
            };
            let is_hovered = hover_node.as_deref() == Some(id.as_str());
            let is_dimmed = hover_node.is_some() && !hover_neighbors.contains(id);
            let hover_id = id.clone();
            let click_id = id.clone();
            let open_cb = open.clone();
            let node_elem_id = ElementId::Name(format!("relations-graph-node-{id}").into());
            let mark_id = ElementId::Name(format!("relations-graph-mark-{id}").into());

            let pill = glass::glass_box(
                node_elem_id,
                if is_hovered {
                    Kind::Rest
                } else {
                    Kind::Surface
                },
                Mode::default(),
                false,
                Spec::new(
                    if is_hovered {
                        Tone::Accent
                    } else {
                        Tone::Clear
                    },
                    radius::MD,
                ),
                window,
                cx,
            )
            .max_w(px(172.0))
            .px(px(9.0))
            .py(px(4.0))
            .border_1()
            .border_color(if is_hovered {
                p.accent.alpha(0.55)
            } else {
                p.hairline()
            })
            .bg(p.paper.alpha(if is_dimmed { 0.45 } else { 0.94 }))
            .cursor_pointer()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(5.0))
            .font_role(Role::Ui)
            .type_px(13.0, 18.0)
            .when(is_hovered, |d| d.weight(weight::MEDIUM))
            .text_color(p.ink(1).alpha(if is_dimmed { 0.36 } else { 1.0 }))
            .role(gpui::Role::Button)
            .aria_label(look.title.clone())
            .child(
                div().flex_none().child(
                    KindMark::new(mark_id, look.mark)
                        .color(if is_hovered { p.accent } else { p.ink(3) })
                        .scale(10.0 / sand::MARK_SLOT),
                ),
            )
            .child(div().min_w_0().truncate().child(look.title.clone()))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click(move |_, window, cx| open_cb(&click_id, window, cx));

            let wrap_id = ElementId::Name(format!("relations-graph-node-wrap-{id}").into());
            node_els.push(
                div()
                    .absolute()
                    .left(px(sx - 90.0))
                    .top(px(sy - 14.0))
                    .w(px(180.0))
                    .flex()
                    .justify_center()
                    .child(
                        div()
                            .id(wrap_id)
                            .on_hover(cx.listener(move |rail, hovered: &bool, _, cx| {
                                if *hovered {
                                    rail.graph.hover_node = Some(hover_id.clone());
                                    cx.notify();
                                } else if rail.graph.hover_node.as_deref()
                                    == Some(hover_id.as_str())
                                {
                                    rail.graph.hover_node = None;
                                    cx.notify();
                                }
                            }))
                            .child(pill),
                    )
                    .into_any_element(),
            );
        }

        let dragging = self.graph.drag.is_some();
        let viewport = div()
            .id("relations-graph-viewport")
            .debug_selector(|| "relations-graph-viewport".into())
            .flex_1()
            .min_h_0()
            .w_full()
            .relative()
            .overflow_hidden()
            .bg(p.page.alpha(0.35))
            .when(dragging, |d| d.cursor_grabbing())
            .when(!dragging, |d| d.cursor_grab())
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|rail, e: &MouseDownEvent, _, cx| {
                    rail.graph.drag = Some((e.position, rail.graph.pan));
                    cx.notify();
                }),
            )
            .on_mouse_move(cx.listener(|rail, e: &MouseMoveEvent, _, cx| {
                if let Some((start, origin)) = rail.graph.drag {
                    if e.pressed_button == Some(MouseButton::Left) {
                        rail.graph.pan = (
                            origin.0 + f32::from(e.position.x - start.x),
                            origin.1 + f32::from(e.position.y - start.y),
                        );
                        cx.notify();
                    } else {
                        rail.graph.drag = None;
                        cx.notify();
                    }
                }
            }))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|rail, _, _, cx| {
                    if rail.graph.drag.take().is_some() {
                        cx.notify();
                    }
                }),
            )
            .on_scroll(cx.listener(|rail, ev: &ScrollEvent, _, cx| {
                let dy = match ev.delta {
                    ScrollDelta::Lines(pt) => pt.y * 0.12,
                    ScrollDelta::Pixels(pt) => f32::from(pt.y) / 240.0,
                };
                if dy.abs() > 1e-4 {
                    rail.graph.zoom = (rail.graph.zoom * (1.0 + dy)).clamp(0.4, 2.4);
                    cx.notify();
                }
            }))
            .child(edge_canvas)
            .children(edge_labels)
            .children(node_els)
            .when(all_nodes.is_empty(), |d| {
                d.flex().items_center().justify_center().child(
                    div()
                        .font_role(Role::Ui)
                        .type_px(s.secondary, s.line_body)
                        .text_color(p.ink(4).solid())
                        .child(SharedString::from(format!(
                            "{} · {}",
                            t(cx, keys::v5_relations::TAB),
                            t(cx, keys::v5_relations::NEW_RELATION)
                        ))),
                )
            });

        div()
            .id("relations-graph-fill")
            .debug_selector(|| "relations-graph-fill".into())
            .flex_1()
            .min_w_0()
            .h_full()
            .flex()
            .flex_col()
            .child(toolbar)
            .child(viewport)
            .into_any_element()
    }
}
