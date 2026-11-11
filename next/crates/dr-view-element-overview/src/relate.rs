//! Deterministic force-directed relation layout for M22 Element Overview (`关系`).
//!
//! Pure ID-neutral simulation, curve geometry, and per-book `book_memory` persistence.
//! Author-pinned coordinates live on `Entry.layout.relation_graph` in the canonical v3
//! book document; `book_memory` remembers only the last selected layout mode (`isles`
//! vs `relate`) and settled unpinned simulation positions.

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Key under `Workspace::book_memory` storing per-book Element Overview view state.
pub const MEMORY_KEY: &str = "element-overview";

/// Duration of structural transition between known layouts (`群岛` ↔ remembered `关系`).
pub const RELATE_MOVE_MS: u64 = 520;

/// Past this many visible relation lines, role names only render on edges of the active/focused element.
pub const RELATE_LABEL_BUDGET: usize = 60;

const CELL_PAD_X: f64 = 8.0;
const CELL_MARK: f64 = 12.0;
const CELL_GAP: f64 = 5.0;
const CELL_FONT: f64 = 12.0;
pub const RELATE_CELL_MAX_W: f64 = 160.0;
pub const RELATE_CELL_H: f64 = 26.0;
pub const RELATE_ROLE_FONT: f64 = 11.5;

pub const RELATE_ALPHA_MIN: f64 = 0.002;
pub const RELATE_TICKS: usize = 90;
const VELOCITY_DECAY: f64 = 0.42;
const COLLIDE_MARGIN_X: f64 = 12.0;
const COLLIDE_MARGIN_Y: f64 = 8.0;
const COLLIDE_OUTRIGHT_ALPHA: f64 = 0.06;
const HUB_ROOM: f64 = 14.0;
const CELL_ROOM: f64 = 2.5;
const LARGE_BOOK: usize = 100;
pub const RELATE_DRAG_ALPHA: f64 = 0.3;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ElementLayoutMode {
    Isles,
    /// Default layout is `关系` unless the book remembered `群岛`.
    #[default]
    Relate,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RelatePoint {
    pub x: f64,
    pub y: f64,
}

impl RelatePoint {
    pub const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    pub fn x_f32(self) -> f32 {
        self.x as f32
    }

    pub fn y_f32(self) -> f32 {
        self.y as f32
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct RelateNodeInput {
    pub id: String,
    pub name: String,
    pub anchor: RelatePoint,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpringKind {
    Relation,
    Prose,
}

impl SpringKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Relation => "relation",
            Self::Prose => "prose",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct RelateSpring {
    pub a: String,
    pub b: String,
    pub kind: SpringKind,
    pub roles: Vec<String>,
    pub count: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RelateSimNode {
    pub id: String,
    pub index: usize,
    pub x: f64,
    pub y: f64,
    pub vx: f64,
    pub vy: f64,
    pub fx: Option<f64>,
    pub fy: Option<f64>,
    pub hw: f64,
    pub hh: f64,
    pub ax: f64,
    pub ay: f64,
    pub degree: usize,
}

#[derive(Clone, Debug)]
struct RelateSimLink {
    source: usize,
    target: usize,
    rest: f64,
    strength: f64,
    bias: f64,
}

#[derive(Clone, Copy, Debug)]
struct RelateForces {
    charge: f64,
    reach: f64,
    anchor: f64,
    area: f64,
}

const FORCES_SMALL: RelateForces = RelateForces {
    charge: -320.0,
    reach: 640.0,
    anchor: 0.03,
    area: 0.9,
};

const FORCES_LARGE: RelateForces = RelateForces {
    charge: -130.0,
    reach: 420.0,
    anchor: 0.06,
    area: 0.22,
};

fn forces_for(count: usize) -> RelateForces {
    if count > LARGE_BOOK {
        FORCES_LARGE
    } else {
        FORCES_SMALL
    }
}

pub fn text_width(text: &str, px: f64) -> f64 {
    let mut width = 0.0;
    for unit in text.encode_utf16() {
        width += if unit > 0x2e7f { px } else { px * 0.56 };
    }
    width
}

pub fn relate_cell_half(name: &str) -> (f64, f64) {
    let width = (CELL_PAD_X * 2.0 + CELL_MARK + CELL_GAP + text_width(name, CELL_FONT))
        .min(RELATE_CELL_MAX_W);
    (width / 2.0, RELATE_CELL_H / 2.0)
}

pub fn relate_role_half(text: &str) -> (f64, f64) {
    ((text_width(text, RELATE_ROLE_FONT) + 8.0) / 2.0, 8.0)
}

/// Scales the island anchors into a window-proportioned minimap.
pub fn relate_anchors(nodes: &[RelateNodeInput], aspect: f64) -> BTreeMap<String, RelatePoint> {
    let mut out = BTreeMap::new();
    if nodes.is_empty() {
        return out;
    }
    let aspect = aspect.clamp(0.4, 4.0);
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    let mut cells = 0.0;
    for node in nodes {
        min_x = min_x.min(node.anchor.x);
        max_x = max_x.max(node.anchor.x);
        min_y = min_y.min(node.anchor.y);
        max_y = max_y.max(node.anchor.y);
        let (hw, hh) = relate_cell_half(&node.name);
        cells += (hw * 2.0 + COLLIDE_MARGIN_X) * (hh * 2.0 + COLLIDE_MARGIN_Y);
    }
    let width = (max_x - min_x).max(1.0);
    let height = (max_y - min_y).max(1.0);
    let area = (width * height * forces_for(nodes.len()).area).max(cells * CELL_ROOM);
    let sx = (area * aspect).sqrt() / width;
    let sy = (area / aspect).sqrt() / height;
    let cx = (min_x + max_x) / 2.0;
    let cy = (min_y + max_y) / 2.0;
    for node in nodes {
        out.insert(
            node.id.clone(),
            RelatePoint::new(
                cx + (node.anchor.x - cx) * sx,
                cy + (node.anchor.y - cy) * sy,
            ),
        );
    }
    out
}

#[derive(Clone, Debug)]
struct Lcg {
    state: u64,
}

impl Lcg {
    const fn new(seed: u64) -> Self {
        Self {
            state: seed & 0xffff_ffff,
        }
    }

    fn next_f64(&mut self) -> f64 {
        self.state = (self
            .state
            .wrapping_mul(1_664_525)
            .wrapping_add(1_013_904_223))
            & 0xffff_ffff;
        (self.state as f64) / 4_294_967_296.0
    }

    fn jiggle(&mut self) -> f64 {
        (self.next_f64() - 0.5) * 1e-6
    }
}

#[derive(Clone, Debug)]
pub struct RelateSimulationInput<'a> {
    pub nodes: &'a [RelateNodeInput],
    pub springs: &'a [RelateSpring],
    pub start: &'a BTreeMap<String, RelatePoint>,
    pub pins: &'a BTreeMap<String, RelatePoint>,
    pub aspect: f64,
    pub alpha: f64,
}

#[derive(Clone, Debug)]
pub struct RelateSimulation {
    nodes: Vec<RelateSimNode>,
    links: Vec<RelateSimLink>,
    forces: RelateForces,
    alpha: f64,
    alpha_min: f64,
    alpha_decay: f64,
    alpha_target: f64,
    rng: Lcg,
    buckets: HashMap<i64, Vec<usize>>,
}

pub fn create_relate_simulation(input: RelateSimulationInput<'_>) -> RelateSimulation {
    let forces = forces_for(input.nodes.len());
    let anchors = relate_anchors(input.nodes, input.aspect);
    let mut nodes: Vec<RelateSimNode> = input
        .nodes
        .iter()
        .enumerate()
        .map(|(index, node)| {
            let start = input
                .pins
                .get(&node.id)
                .or_else(|| input.start.get(&node.id))
                .copied()
                .unwrap_or(node.anchor);
            let pin = input.pins.get(&node.id).copied();
            let anchor = anchors.get(&node.id).copied().unwrap_or(node.anchor);
            let (hw, hh) = relate_cell_half(&node.name);
            RelateSimNode {
                id: node.id.clone(),
                index,
                x: start.x,
                y: start.y,
                vx: 0.0,
                vy: 0.0,
                fx: pin.map(|p| p.x),
                fy: pin.map(|p| p.y),
                hw,
                hh,
                ax: anchor.x,
                ay: anchor.y,
                degree: 0,
            }
        })
        .collect();

    let by_id: HashMap<&str, usize> = input
        .nodes
        .iter()
        .enumerate()
        .map(|(idx, n)| (n.id.as_str(), idx))
        .collect();

    let mut raw_links: Vec<(usize, usize, f64, f64)> = Vec::new();
    for spring in input.springs {
        let Some(&s_idx) = by_id.get(spring.a.as_str()) else {
            continue;
        };
        let Some(&t_idx) = by_id.get(spring.b.as_str()) else {
            continue;
        };
        if s_idx == t_idx {
            continue;
        }
        nodes[s_idx].degree += 1;
        nodes[t_idx].degree += 1;
        let room = match spring.kind {
            SpringKind::Relation => {
                spring
                    .roles
                    .iter()
                    .map(|r| relate_role_half(r).0 * 2.0)
                    .sum::<f64>()
                    + 36.0
            }
            SpringKind::Prose => 40.0,
        };
        let base = match spring.kind {
            SpringKind::Relation => 1.0,
            SpringKind::Prose => 0.12 + 0.05 * f64::from(spring.count.clamp(1, 4)),
        };
        let rest = nodes[s_idx].hw + nodes[t_idx].hw + room;
        raw_links.push((s_idx, t_idx, rest, base));
    }

    let mut links = Vec::with_capacity(raw_links.len());
    for (source, target, mut rest, mut strength) in raw_links {
        let s_deg = nodes[source].degree.max(1);
        let t_deg = nodes[target].degree.max(1);
        let min_deg = s_deg.min(t_deg) as f64;
        let max_deg = s_deg.max(t_deg) as f64;
        strength /= min_deg;
        rest += HUB_ROOM * (max_deg - 4.0).max(0.0).sqrt();
        let bias = (s_deg as f64) / ((s_deg + t_deg) as f64);
        links.push(RelateSimLink {
            source,
            target,
            rest,
            strength,
            bias,
        });
    }

    let alpha_decay = 1.0 - RELATE_ALPHA_MIN.powf(1.0 / (RELATE_TICKS as f64));
    RelateSimulation {
        nodes,
        links,
        forces,
        alpha: input.alpha,
        alpha_min: RELATE_ALPHA_MIN,
        alpha_decay,
        alpha_target: 0.0,
        rng: Lcg::new(0x2d5e),
        buckets: HashMap::new(),
    }
}

impl RelateSimulation {
    pub fn nodes(&self) -> &[RelateSimNode] {
        &self.nodes
    }

    pub fn nodes_mut(&mut self) -> &mut [RelateSimNode] {
        &mut self.nodes
    }

    pub fn alpha(&self) -> f64 {
        self.alpha
    }

    pub fn alpha_min(&self) -> f64 {
        self.alpha_min
    }

    pub fn alpha_target(&self) -> f64 {
        self.alpha_target
    }

    pub fn set_alpha_target(&mut self, target: f64) {
        self.alpha_target = target;
    }

    pub fn set_alpha(&mut self, alpha: f64) {
        self.alpha = alpha;
    }

    pub fn cooled(&self) -> bool {
        self.alpha < self.alpha_min && self.alpha_target == 0.0
    }

    pub fn tick(&mut self) {
        self.alpha += (self.alpha_target - self.alpha) * self.alpha_decay;
        let alpha = self.alpha;

        for node in &mut self.nodes {
            if let Some(fx) = node.fx {
                node.x = fx;
                node.vx = 0.0;
            }
            if let Some(fy) = node.fy {
                node.y = fy;
                node.vy = 0.0;
            }
        }

        // 1. Link force
        for link in &self.links {
            let (s, t) = (link.source, link.target);
            let mut dx =
                (self.nodes[t].x + self.nodes[t].vx) - (self.nodes[s].x + self.nodes[s].vx);
            let mut dy =
                (self.nodes[t].y + self.nodes[t].vy) - (self.nodes[s].y + self.nodes[s].vy);
            if dx == 0.0 {
                dx = self.rng.jiggle();
            }
            if dy == 0.0 {
                dy = self.rng.jiggle();
            }
            let l = dx.hypot(dy).max(1e-9);
            let k = ((l - link.rest) / l) * alpha * link.strength;
            let fx = dx * k;
            let fy = dy * k;
            self.nodes[t].vx -= fx * link.bias;
            self.nodes[t].vy -= fy * link.bias;
            self.nodes[s].vx += fx * (1.0 - link.bias);
            self.nodes[s].vy += fy * (1.0 - link.bias);
        }

        // 2. Many-body repulsion
        let n = self.nodes.len();
        let reach_sq = self.forces.reach * self.forces.reach;
        let charge = self.forces.charge;
        for i in 0..n {
            for j in (i + 1)..n {
                let mut dx = self.nodes[j].x - self.nodes[i].x;
                let mut dy = self.nodes[j].y - self.nodes[i].y;
                if dx == 0.0 {
                    dx = self.rng.jiggle();
                }
                if dy == 0.0 {
                    dy = self.rng.jiggle();
                }
                let mut l2 = dx * dx + dy * dy;
                if l2 > reach_sq {
                    continue;
                }
                if l2 < 1.0 {
                    l2 = l2.sqrt();
                }
                let w = charge * alpha / l2;
                self.nodes[i].vx += dx * w;
                self.nodes[i].vy += dy * w;
                self.nodes[j].vx -= dx * w;
                self.nodes[j].vy -= dy * w;
            }
        }

        // 3. Weak anchor forceX / forceY
        let anchor_k = self.forces.anchor * alpha;
        for node in &mut self.nodes {
            node.vx += (node.ax - node.x) * anchor_k;
            node.vy += (node.ay - node.y) * anchor_k;
        }

        // 4. Rectangular box collision
        let outright = alpha < COLLIDE_OUTRIGHT_ALPHA;
        let passes = if outright { 4 } else { 2 };
        for _ in 0..passes {
            self.collide_pass(outright);
        }

        // 5. Velocity decay & position integration
        let keep = 1.0 - VELOCITY_DECAY;
        for node in &mut self.nodes {
            if let Some(fx) = node.fx {
                node.x = fx;
                node.vx = 0.0;
            } else {
                node.vx *= keep;
                node.x += node.vx;
            }
            if let Some(fy) = node.fy {
                node.y = fy;
                node.vy = 0.0;
            } else {
                node.vy *= keep;
                node.y += node.vy;
            }
        }
    }

    fn collide_pass(&mut self, outright: bool) {
        if self.nodes.is_empty() {
            return;
        }
        let mut max_w = 0.0f64;
        let mut max_h = 0.0f64;
        for node in &self.nodes {
            max_w = max_w.max(node.hw);
            max_h = max_h.max(node.hh);
        }
        let cell_w = (max_w * 2.0 + COLLIDE_MARGIN_X).max(1.0);
        let cell_h = (max_h * 2.0 + COLLIDE_MARGIN_Y).max(1.0);
        let keep = 1.0 - VELOCITY_DECAY;

        let key_of = |gx: i64, gy: i64| -> i64 { (gx + 32768) * 65536 + (gy + 32768) };
        let next_x = |node: &RelateSimNode| -> f64 { node.x + node.vx * keep };
        let next_y = |node: &RelateSimNode| -> f64 { node.y + node.vy * keep };

        let Self { nodes, buckets, .. } = self;
        for bucket in buckets.values_mut() {
            bucket.clear();
        }
        for (idx, node) in nodes.iter().enumerate() {
            let gx = (next_x(node) / cell_w).floor() as i64;
            let gy = (next_y(node) / cell_h).floor() as i64;
            buckets.entry(key_of(gx, gy)).or_default().push(idx);
        }

        let n = nodes.len();
        for p_idx in 0..n {
            let gx = (next_x(&nodes[p_idx]) / cell_w).floor() as i64;
            let gy = (next_y(&nodes[p_idx]) / cell_h).floor() as i64;
            for ix in (gx - 1)..=(gx + 1) {
                for iy in (gy - 1)..=(gy + 1) {
                    let Some(bucket) = buckets.get(&key_of(ix, iy)) else {
                        continue;
                    };
                    for &q_idx in bucket {
                        if q_idx <= p_idx {
                            continue;
                        }
                        let wp = if nodes[p_idx].fx.is_none() { 1.0 } else { 0.0 };
                        let wq = if nodes[q_idx].fx.is_none() { 1.0 } else { 0.0 };
                        if wp + wq == 0.0 {
                            continue;
                        }
                        let dx = next_x(&nodes[q_idx]) - next_x(&nodes[p_idx]);
                        let dy = next_y(&nodes[q_idx]) - next_y(&nodes[p_idx]);
                        let ox = nodes[p_idx].hw + nodes[q_idx].hw + COLLIDE_MARGIN_X - dx.abs();
                        if ox <= 0.0 {
                            continue;
                        }
                        let oy = nodes[p_idx].hh + nodes[q_idx].hh + COLLIDE_MARGIN_Y - dy.abs();
                        if oy <= 0.0 {
                            continue;
                        }
                        let along_x = ox < oy;
                        let sign = if (if along_x { dx } else { dy }) < 0.0 {
                            -1.0
                        } else {
                            1.0
                        };
                        let factor = if outright { 1.0 } else { 0.5 };
                        let push = ((if along_x { ox } else { oy }) / (wp + wq)) * sign * factor;
                        if along_x {
                            if outright {
                                nodes[p_idx].x -= push * wp;
                                nodes[q_idx].x += push * wq;
                            } else {
                                nodes[p_idx].vx -= push * wp;
                                nodes[q_idx].vx += push * wq;
                            }
                        } else if outright {
                            nodes[p_idx].y -= push * wp;
                            nodes[q_idx].y += push * wq;
                        } else {
                            nodes[p_idx].vy -= push * wp;
                            nodes[q_idx].vy += push * wq;
                        }
                    }
                }
            }
        }
    }
}

pub fn settle_relate(simulation: &mut RelateSimulation) -> usize {
    let mut ticks = 0;
    while !simulation.cooled() && ticks < 600 {
        simulation.tick();
        ticks += 1;
    }
    ticks
}

pub fn relate_positions(simulation: &RelateSimulation) -> BTreeMap<String, RelatePoint> {
    simulation
        .nodes()
        .iter()
        .map(|n| (n.id.clone(), RelatePoint::new(n.x, n.y)))
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RelateWorldBounds {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

pub fn relate_bounds(
    positions: &BTreeMap<String, RelatePoint>,
    names: &HashMap<String, String>,
) -> RelateWorldBounds {
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for (id, point) in positions {
        let name = names.get(id).map_or("", String::as_str);
        let (hw, hh) = relate_cell_half(name);
        min_x = min_x.min(point.x - hw);
        max_x = max_x.max(point.x + hw);
        min_y = min_y.min(point.y - hh);
        max_y = max_y.max(point.y + hh);
    }
    if !min_x.is_finite() {
        return RelateWorldBounds {
            min_x: 0.0,
            min_y: 0.0,
            max_x: 0.0,
            max_y: 0.0,
        };
    }
    RelateWorldBounds {
        min_x,
        min_y,
        max_x,
        max_y,
    }
}

/// FNV-1a 32-bit signature of the nodes and springs pulling on the layout.
pub fn relate_spring_signature(nodes: &[RelateNodeInput], springs: &[RelateSpring]) -> String {
    let mut parts: Vec<String> = springs
        .iter()
        .map(|s| {
            let (a, b) = if s.a < s.b {
                (s.a.as_str(), s.b.as_str())
            } else {
                (s.b.as_str(), s.a.as_str())
            };
            let count_str = if s.count > 0 {
                s.count.to_string()
            } else {
                String::new()
            };
            format!(
                "{}:{a}:{b}:{count_str}:{}",
                s.kind.as_str(),
                s.roles.join("/")
            )
        })
        .collect();
    parts.sort();
    let mut node_ids: Vec<&str> = nodes.iter().map(|n| n.id.as_str()).collect();
    node_ids.sort();
    let text = format!("{}#{}", node_ids.join(","), parts.join(";"));
    let mut h: u32 = 2_166_136_261;
    for unit in text.encode_utf16() {
        h = (h ^ u32::from(unit)).wrapping_mul(16_777_619);
    }
    format!("{h:08x}")
}

/// Structural ease (`cubic-bezier(0.32, 0.72, 0, 1)`), solved by bisection.
pub fn relate_ease(t: f32) -> f32 {
    if t <= 0.0 {
        return 0.0;
    }
    if t >= 1.0 {
        return 1.0;
    }
    let bezier = |s: f32, p1: f32, p2: f32| -> f32 {
        let u = 1.0 - s;
        3.0 * u * u * s * p1 + 3.0 * u * s * s * p2 + s * s * s
    };
    let mut lo = 0.0f32;
    let mut hi = 1.0f32;
    for _ in 0..22 {
        let mid = (lo + hi) * 0.5;
        if bezier(mid, 0.32, 0.0) < t {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    bezier((lo + hi) * 0.5, 0.72, 1.0)
}

pub fn relate_bend(index: usize, count: usize) -> f64 {
    if count > 1 {
        ((index as f64) - ((count - 1) as f64) / 2.0) * 0.16
    } else {
        0.07
    }
}

fn reach(hw: f64, hh: f64, ux: f64, uy: f64) -> f64 {
    let along = if ux.abs() > 1e-6 {
        hw / ux.abs()
    } else {
        f64::INFINITY
    };
    let across = if uy.abs() > 1e-6 {
        hh / uy.abs()
    } else {
        f64::INFINITY
    };
    along.min(across)
}

fn on_quad(p0: RelatePoint, ctrl: RelatePoint, p2: RelatePoint, t: f64) -> RelatePoint {
    let u = 1.0 - t;
    RelatePoint::new(
        u * u * p0.x + 2.0 * u * t * ctrl.x + t * t * p2.x,
        u * u * p0.y + 2.0 * u * t * ctrl.y + t * t * p2.y,
    )
}

#[derive(Clone, Debug, PartialEq)]
pub struct RelateRoleLabel {
    pub text: String,
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RelateEdgeGeometry {
    pub p0: RelatePoint,
    pub ctrl: RelatePoint,
    pub p2: RelatePoint,
    pub labels: Vec<RelateRoleLabel>,
    pub label_alpha: f32,
}

pub struct RelateEdgeInput<'a> {
    pub from_id: &'a str,
    pub to_id: &'a str,
    pub from: RelatePoint,
    pub to: RelatePoint,
    pub from_half: (f64, f64),
    pub to_half: (f64, f64),
    pub bend: f64,
    pub roles: &'a [String],
    pub label_scale: f64,
}

pub fn relate_edge_geometry(input: RelateEdgeInput<'_>) -> RelateEdgeGeometry {
    let scale = if input.label_scale > 0.0 {
        input.label_scale
    } else {
        1.0
    };
    let role_half = |text: &str| -> (f64, f64) {
        let (hw, hh) = relate_role_half(text);
        (hw * scale, hh * scale)
    };
    let forward = input.from_id < input.to_id;
    let p0 = if forward { input.from } else { input.to };
    let p2 = if forward { input.to } else { input.from };
    let dx = p2.x - p0.x;
    let dy = p2.y - p0.y;
    let len = dx.hypot(dy).max(1.0);
    let ctrl = RelatePoint::new(
        (p0.x + p2.x) * 0.5 - dy * input.bend,
        (p0.y + p2.y) * 0.5 + dx * input.bend,
    );
    let ux = dx / len;
    let uy = dy / len;
    const GAP: f64 = 6.0;

    let roles: Vec<&str> = input
        .roles
        .iter()
        .map(String::as_str)
        .filter(|s| !s.trim().is_empty())
        .collect();
    if roles.is_empty() {
        return RelateEdgeGeometry {
            p0,
            ctrl,
            p2,
            labels: Vec::new(),
            label_alpha: 0.0,
        };
    }
    if roles.len() == 1 {
        let (hw, hh) = role_half(roles[0]);
        let el = reach(hw, hh, ux, uy);
        let spare = len
            - reach(input.from_half.0, input.from_half.1, ux, uy)
            - reach(input.to_half.0, input.to_half.1, ux, uy)
            - 2.0 * (GAP + el);
        if spare <= 0.0 {
            return RelateEdgeGeometry {
                p0,
                ctrl,
                p2,
                labels: Vec::new(),
                label_alpha: 0.0,
            };
        }
        let mid = on_quad(p0, ctrl, p2, 0.5);
        return RelateEdgeGeometry {
            p0,
            ctrl,
            p2,
            labels: vec![RelateRoleLabel {
                text: roles[0].to_owned(),
                x: mid.x,
                y: mid.y,
            }],
            label_alpha: ((spare / 24.0).min(1.0)) as f32,
        };
    }

    let ends = [
        (true, roles[0], input.from_half),
        (false, roles[1], input.to_half),
    ];
    let mut computed = Vec::with_capacity(2);
    let mut total_used = 0.0;
    for (at_from, text, half) in ends {
        let (l_hw, l_hh) = role_half(text);
        let el = reach(l_hw, l_hh, ux, uy);
        let at = reach(half.0, half.1, ux, uy) + GAP + el;
        total_used += at + el;
        computed.push((at_from, text, at));
    }
    let spare = len - total_used - 6.0;
    if spare <= 0.0 {
        return RelateEdgeGeometry {
            p0,
            ctrl,
            p2,
            labels: Vec::new(),
            label_alpha: 0.0,
        };
    }
    let labels = computed
        .into_iter()
        .map(|(at_from, text, at)| {
            let from_p0 = at_from == forward;
            let t = if from_p0 { at / len } else { 1.0 - at / len };
            let pt = on_quad(p0, ctrl, p2, t.clamp(0.0, 1.0));
            RelateRoleLabel {
                text: text.to_owned(),
                x: pt.x,
                y: pt.y,
            }
        })
        .collect();
    RelateEdgeGeometry {
        p0,
        ctrl,
        p2,
        labels,
        label_alpha: ((spare / 24.0).min(1.0)) as f32,
    }
}

/// Per-book view memory persisted via `Workspace::set_book_memory`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct OverviewMemory {
    pub mode: ElementLayoutMode,
    pub positions: Option<BTreeMap<String, RelatePoint>>,
    pub signature: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct StoredOverviewMemory {
    #[serde(default)]
    v: u32,
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    positions: Option<BTreeMap<String, [f64; 2]>>,
    #[serde(default)]
    signature: Option<String>,
}

fn unpack_points(map: BTreeMap<String, [f64; 2]>) -> BTreeMap<String, RelatePoint> {
    map.into_iter()
        .filter(|(_, pt)| pt[0].is_finite() && pt[1].is_finite())
        .map(|(id, pt)| (id, RelatePoint::new(pt[0], pt[1])))
        .collect()
}

fn pack_points(map: &BTreeMap<String, RelatePoint>) -> BTreeMap<String, [f64; 2]> {
    map.iter()
        .map(|(id, pt)| {
            (
                id.clone(),
                [(pt.x * 10.0).round() / 10.0, (pt.y * 10.0).round() / 10.0],
            )
        })
        .collect()
}

pub fn parse_overview_memory(raw: Option<&Value>) -> OverviewMemory {
    let Some(raw) = raw else {
        return OverviewMemory::default();
    };
    let parsed: StoredOverviewMemory = match raw {
        Value::String(s) => match serde_json::from_str(s) {
            Ok(p) => p,
            Err(_) => return OverviewMemory::default(),
        },
        other => match serde_json::from_value(other.clone()) {
            Ok(p) => p,
            Err(_) => return OverviewMemory::default(),
        },
    };
    let mode = if parsed.mode.as_deref() == Some("isles") {
        ElementLayoutMode::Isles
    } else {
        ElementLayoutMode::Relate
    };
    let positions = parsed
        .positions
        .map(unpack_points)
        .filter(|m| !m.is_empty());
    OverviewMemory {
        mode,
        positions,
        signature: parsed.signature,
    }
}

pub fn serialize_overview_memory(record: &OverviewMemory) -> Value {
    let stored = StoredOverviewMemory {
        v: 1,
        mode: Some(match record.mode {
            ElementLayoutMode::Isles => "isles".to_owned(),
            ElementLayoutMode::Relate => "relate".to_owned(),
        }),
        positions: record.positions.as_ref().map(pack_points),
        signature: record.signature.clone(),
    };
    serde_json::to_value(stored).unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_nodes() -> Vec<RelateNodeInput> {
        vec![
            RelateNodeInput {
                id: "el-1".into(),
                name: "陈石".into(),
                anchor: RelatePoint::new(-180.0, -90.0),
            },
            RelateNodeInput {
                id: "el-2".into(),
                name: "沈青".into(),
                anchor: RelatePoint::new(160.0, -90.0),
            },
            RelateNodeInput {
                id: "el-3".into(),
                name: "北镇钟楼".into(),
                anchor: RelatePoint::new(-120.0, 110.0),
            },
            RelateNodeInput {
                id: "el-4".into(),
                name: "银怀表".into(),
                anchor: RelatePoint::new(140.0, 110.0),
            },
        ]
    }

    fn sample_springs() -> Vec<RelateSpring> {
        vec![
            RelateSpring {
                a: "el-1".into(),
                b: "el-2".into(),
                kind: SpringKind::Relation,
                roles: vec!["师父".into(), "徒弟".into()],
                count: 0,
            },
            RelateSpring {
                a: "el-1".into(),
                b: "el-3".into(),
                kind: SpringKind::Prose,
                roles: Vec::new(),
                count: 4,
            },
            RelateSpring {
                a: "el-2".into(),
                b: "el-4".into(),
                kind: SpringKind::Relation,
                roles: vec!["持有".into()],
                count: 0,
            },
        ]
    }

    #[test]
    fn simulation_is_bitwise_deterministic_across_runs() {
        let nodes = sample_nodes();
        let springs = sample_springs();
        let start = BTreeMap::new();
        let pins = BTreeMap::new();

        let mut sim1 = create_relate_simulation(RelateSimulationInput {
            nodes: &nodes,
            springs: &springs,
            start: &start,
            pins: &pins,
            aspect: 1.6,
            alpha: 1.0,
        });
        let ticks1 = settle_relate(&mut sim1);
        let pos1 = relate_positions(&sim1);

        let mut sim2 = create_relate_simulation(RelateSimulationInput {
            nodes: &nodes,
            springs: &springs,
            start: &start,
            pins: &pins,
            aspect: 1.6,
            alpha: 1.0,
        });
        let ticks2 = settle_relate(&mut sim2);
        let pos2 = relate_positions(&sim2);

        assert_eq!(ticks1, ticks2);
        assert_eq!(pos1.len(), pos2.len());
        for (id, p1) in &pos1 {
            let p2 = pos2.get(id).expect("same keys");
            assert_eq!(
                p1.x.to_bits(),
                p2.x.to_bits(),
                "x coordinates must be bit-identical for {id}"
            );
            assert_eq!(
                p1.y.to_bits(),
                p2.y.to_bits(),
                "y coordinates must be bit-identical for {id}"
            );
        }
    }

    #[test]
    fn pinned_node_stays_fixed_and_unpinning_allows_relayout() {
        let nodes = sample_nodes();
        let springs = sample_springs();
        let start = BTreeMap::new();
        let mut pins = BTreeMap::new();
        pins.insert("el-1".into(), RelatePoint::new(42.5, -77.5));

        let mut sim_pinned = create_relate_simulation(RelateSimulationInput {
            nodes: &nodes,
            springs: &springs,
            start: &start,
            pins: &pins,
            aspect: 1.6,
            alpha: 1.0,
        });
        settle_relate(&mut sim_pinned);
        let pos_pinned = relate_positions(&sim_pinned);
        assert_eq!(pos_pinned["el-1"], RelatePoint::new(42.5, -77.5));

        let empty_pins = BTreeMap::new();
        let mut sim_free = create_relate_simulation(RelateSimulationInput {
            nodes: &nodes,
            springs: &springs,
            start: &pos_pinned,
            pins: &empty_pins,
            aspect: 1.6,
            alpha: 1.0,
        });
        settle_relate(&mut sim_free);
        let pos_free = relate_positions(&sim_free);
        assert_ne!(pos_free["el-1"], RelatePoint::new(42.5, -77.5));
    }

    #[test]
    fn edge_geometry_places_directed_and_symmetric_role_labels() {
        let from_half = relate_cell_half("陈石");
        let to_half = relate_cell_half("沈青");
        let directed_roles = vec!["师父".to_owned(), "徒弟".to_owned()];
        let g_dir = relate_edge_geometry(RelateEdgeInput {
            from_id: "el-1",
            to_id: "el-2",
            from: RelatePoint::new(0.0, 0.0),
            to: RelatePoint::new(260.0, 0.0),
            from_half,
            to_half,
            bend: relate_bend(0, 1),
            roles: &directed_roles,
            label_scale: 1.0,
        });
        assert_eq!(g_dir.labels.len(), 2);
        assert_eq!(g_dir.labels[0].text, "师父");
        assert_eq!(g_dir.labels[1].text, "徒弟");
        assert!(g_dir.labels[0].x < g_dir.labels[1].x);
        assert!(g_dir.label_alpha > 0.0);

        let sym_roles = vec!["同盟".to_owned()];
        let g_sym = relate_edge_geometry(RelateEdgeInput {
            from_id: "el-1",
            to_id: "el-2",
            from: RelatePoint::new(0.0, 0.0),
            to: RelatePoint::new(260.0, 0.0),
            from_half,
            to_half,
            bend: relate_bend(0, 1),
            roles: &sym_roles,
            label_scale: 1.0,
        });
        assert_eq!(g_sym.labels.len(), 1);
        assert_eq!(g_sym.labels[0].text, "同盟");
        assert!((g_sym.labels[0].x - 130.0).abs() < 5.0);
    }

    #[test]
    fn memory_defaults_to_relate_and_roundtrips_isles_and_positions() {
        let def = parse_overview_memory(None);
        assert_eq!(def.mode, ElementLayoutMode::Relate);
        assert!(def.positions.is_none());

        let mut positions = BTreeMap::new();
        positions.insert("el-1".into(), RelatePoint::new(12.3, -45.6));
        let rec = OverviewMemory {
            mode: ElementLayoutMode::Isles,
            positions: Some(positions),
            signature: Some("abc12345".into()),
        };
        let val = serialize_overview_memory(&rec);
        let parsed = parse_overview_memory(Some(&val));
        assert_eq!(parsed, rec);
    }
}
