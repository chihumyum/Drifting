//! Read the effective tree and memberships from one book snapshot.
use std::collections::{BTreeMap, HashMap};

use gpui::{Bounds, PathBuilder, Pixels, Window, point, px};

use crate::book::v3::BookV3;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum EdgeKind {
    Residence,
    Membership,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Edge {
    pub from: String,
    pub to: String,
    pub kind: EdgeKind,
    pub count: usize,
}

#[derive(Default)]
pub struct Graph {
    pub counts: BTreeMap<String, usize>,
    pub edges: Vec<Edge>,
    pub unused: Vec<String>,
    pub untemplated: Vec<String>,
    pub depth: BTreeMap<String, usize>,
}

impl Graph {
    pub fn read(book: &BookV3) -> Self {
        let mut graph = Self::default();
        let mut parents = HashMap::new();
        for (parent, level) in &book.levels {
            for child in &level.children {
                parents.insert(child.as_str(), parent.as_str());
            }
        }
        let mut depths: HashMap<&str, usize> = HashMap::new();
        let mut edges = BTreeMap::new();
        let template = |entry: &str| book.template_of(entry).map(|t| t.id.as_str());
        for entry in &book.entries {
            let parent = parents.get(entry.id.as_str()).copied();
            let depth = parent.and_then(|p| depths.get(p)).map_or(0, |n| n + 1);
            depths.insert(&entry.id, depth);
            if let Some(id) = template(&entry.id) {
                *graph.counts.entry(id.to_owned()).or_default() += 1;
                graph
                    .depth
                    .entry(id.to_owned())
                    .and_modify(|n| *n = (*n).min(depth))
                    .or_insert(depth);
                if let Some(from) = parent.and_then(template) {
                    *edges.entry((from, id, EdgeKind::Residence)).or_default() += 1;
                }
            } else {
                graph.untemplated.push(entry.id.clone());
            }
        }
        for membership in &book.memberships {
            if let (Some(from), Some(to)) =
                (template(&membership.host), template(&membership.member))
            {
                *edges.entry((from, to, EdgeKind::Membership)).or_default() += 1;
            }
        }
        graph.edges = edges
            .into_iter()
            .map(|((from, to, kind), count)| Edge {
                from: from.to_owned(),
                to: to.to_owned(),
                kind,
                count,
            })
            .collect();
        graph.unused = book
            .templates
            .iter()
            .filter(|t| t.deleted_at.is_none() && !graph.counts.contains_key(&t.id))
            .map(|t| t.id.clone())
            .collect();
        graph
    }

    pub fn position(&self, book: &BookV3) -> GraphLayout {
        let mut layout = GraphLayout::default();
        let mut heights = [12.0_f32; 5];
        for template in &book.templates {
            let Some(depth) = self.depth.get(&template.id) else {
                continue;
            };
            let column = (*depth).min(heights.len() - 1);
            let height = 57.0 + template.modules.len() as f32 * 19.0;
            let x = 12.0 + column as f32 * (CARD_W + 52.0);
            let y = heights[column];
            layout
                .cards
                .insert(template.id.clone(), [x, y, CARD_W, height]);
            layout.width = layout.width.max(x + CARD_W + 22.0);
            layout.height = layout.height.max(y + height + 18.0);
            heights[column] += height + 22.0;
        }
        layout
    }
}

pub const CARD_W: f32 = 160.0;

#[derive(Default)]
pub struct GraphLayout {
    pub cards: BTreeMap<String, [f32; 4]>,
    pub width: f32,
    pub height: f32,
}

pub fn paint_edges(
    layout: &GraphLayout,
    edges: &[Edge],
    bounds: Bounds<Pixels>,
    scale: f32,
    ink: dr_ui::tokens::Rgb,
    window: &mut Window,
) {
    for edge in edges {
        let (Some(a), Some(b)) = (layout.cards.get(&edge.from), layout.cards.get(&edge.to)) else {
            continue;
        };
        let ax = a[0] + a[2];
        let ay = a[1] + a[3] * 0.5;
        let shared_column = b[0] <= a[0];
        let bx = b[0] + if shared_column { b[2] } else { 0.0 };
        let by = b[1]
            + b[3] * 0.5
            + if edge.from == edge.to {
                a[3] * 0.28
            } else {
                0.0
            };
        let bridge = if shared_column {
            ax.max(bx) + 16.0
        } else {
            (ax + bx) * 0.5
        };
        let at = |x, y| bounds.origin + point(px(x * scale), px(y * scale));
        let points = [at(ax, ay), at(bridge, ay), at(bridge, by), at(bx, by)];
        let width = px(((1.0 + (edge.count as f32).ln() * 0.33) * scale).max(0.75));
        let mut path = PathBuilder::stroke(width);
        if edge.kind == EdgeKind::Residence {
            path.move_to(points[0]);
            for p in &points[1..] {
                path.line_to(*p);
            }
        } else {
            for segment in points.windows(2) {
                let delta = segment[1] - segment[0];
                let length = f32::from(delta.x.abs() + delta.y.abs());
                for dash in (0..length.ceil() as usize).step_by(5) {
                    path.move_to(segment[0] + delta * (dash as f32 / length));
                    path.line_to(segment[0] + delta * ((dash + 2) as f32 / length).min(1.0));
                }
            }
        }
        if let Ok(path) = path.build() {
            window.paint_path(path, ink.alpha(0.42));
        }
    }
}
