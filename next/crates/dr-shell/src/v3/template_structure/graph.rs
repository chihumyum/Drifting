//! Read the effective tree and memberships from one book snapshot, lay the
//! template cards out and draw the lines between them (`W12Template`).
use std::collections::{BTreeMap, HashMap};

use dr_ui::tokens::{Palette, Rgb};
use dr_workspace::commands::v3::types::EntryTemplate;
use gpui::{Bounds, Hsla, PathBuilder, Pixels, Point, Window, point, px, size};

use crate::book::v3::BookV3;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum EdgeKind {
    Residence,
    Membership,
}

#[derive(Clone, Debug, PartialEq, Eq)]
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

/// One item of a card's 「下面」 row, in the board's order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Below {
    /// 「＋章」: the template new entries below get.
    New(String),
    /// The display entries below are shown as.
    Display(String),
    AutoLink,
    /// Nothing set on the template: all of it comes from above.
    Inherit,
}

/// The card's 「下面」 row (`W12Template`: drawn while either switch is on
/// and there is something to write).
pub fn below(template: &EntryTemplate) -> Vec<Below> {
    if !template.level && template.settings.accept != Some(true) {
        return Vec::new();
    }
    let s = &template.settings;
    if s.default_template.is_none() && s.display.is_none() && s.auto_link.is_none() {
        return vec![Below::Inherit];
    }
    let mut out = Vec::new();
    if let Some(Some(id)) = &s.default_template {
        out.push(Below::New(id.clone()));
    }
    if let Some(display) = &s.display {
        out.push(Below::Display(display.clone()));
    }
    if s.auto_link == Some(true) {
        out.push(Below::AutoLink);
    }
    out
}

/// The entry a card's 「住在…」 names: set while 收别处的条目 is on.
pub fn home(template: &EntryTemplate) -> Option<&str> {
    match (&template.settings.accept, &template.settings.home) {
        (Some(true), Some(Some(home))) => Some(home),
        _ => None,
    }
}

/// A card's height on the board: the head, a row per module, the switches
/// (「住在…」 on a second line), the 「下面」 row.
pub fn card_height(template: &EntryTemplate) -> f32 {
    28.0 + 18.0 * template.modules.len() as f32
        + 27.0
        + if home(template).is_some() { 19.0 } else { 0.0 }
        + if below(template).is_empty() {
            0.0
        } else {
            19.0
        }
        + 6.0
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

    /// The legend's count: how many lines of `kind` the board draws.
    pub fn lines(&self, kind: EdgeKind) -> usize {
        self.edges.iter().filter(|edge| edge.kind == kind).count()
    }

    /// The cards of the used templates, a column per depth (`W12Template`:
    /// 176 wide, columns 196 apart, 28 between cards).
    pub fn position(&self, book: &BookV3) -> GraphLayout {
        let mut layout = GraphLayout::default();
        let mut heights = [TOP; 4];
        for template in &book.templates {
            let Some(depth) = self.depth.get(&template.id) else {
                continue;
            };
            let column = (*depth).min(heights.len() - 1);
            let height = card_height(template);
            let x = LEFT + column as f32 * COLUMN;
            let y = heights[column];
            layout
                .cards
                .insert(template.id.clone(), [x, y, CARD_W, height]);
            layout.width = layout.width.max(x + CARD_W + LEFT);
            layout.height = layout.height.max(y + height + TOP);
            heights[column] += height + GAP;
        }
        layout
    }
}

pub const CARD_W: f32 = 176.0;
const COLUMN: f32 = 196.0;
const LEFT: f32 = 20.0;
const TOP: f32 = 12.0;
const GAP: f32 = 28.0;
/// Where a line meets a card: the middle of its head row.
const HEAD_Y: f32 = 14.0;

#[derive(Default)]
pub struct GraphLayout {
    pub cards: BTreeMap<String, [f32; 4]>,
    pub width: f32,
    pub height: f32,
}

/// The way one line goes, in board coordinates: a cubic from `from` to
/// `to`, its end dot and where its count is written.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Route {
    pub from: (f32, f32),
    pub c1: (f32, f32),
    pub c2: (f32, f32),
    pub to: (f32, f32),
    pub dot: (f32, f32),
    pub label: (f32, f32),
}

impl Route {
    /// From the right edge of the card above to the left edge of the one
    /// below (the board's curves). A card in the same column is reached
    /// straight up or down (the board's 分类 → 分组); one further left from
    /// its right edge; a template under itself loops back to its own card.
    pub fn of(layout: &GraphLayout, edge: &Edge) -> Option<Route> {
        let a = layout.cards.get(&edge.from)?;
        let b = layout.cards.get(&edge.to)?;
        let line = |from: (f32, f32), to: (f32, f32), dot: (f32, f32)| Route {
            from,
            c1: from,
            c2: to,
            to,
            dot,
            label: ((from.0 + to.0) * 0.5, (from.1 + to.1) * 0.5),
        };
        if edge.from == edge.to {
            let (x, y) = (a[0] + a[2], a[1] + HEAD_Y);
            return Some(Route {
                from: (x, y),
                c1: (x + 30.0, y - 10.0),
                c2: (x + 30.0, y + 22.0),
                to: (x, y + 12.0),
                dot: (x + 3.0, y + 12.0),
                label: (x + 24.0, y + 6.0),
            });
        }
        if (a[0] - b[0]).abs() < 0.5 {
            let x = a[0] + a[2] * 0.5;
            return Some(if b[1] < a[1] {
                line((x, a[1]), (x, b[1] + b[3]), (x, b[1] + b[3] + 2.6))
            } else {
                line((x, a[1] + a[3]), (x, b[1]), (x, b[1] - 2.6))
            });
        }
        let (from, to, dot) = if b[0] > a[0] {
            (
                (a[0] + a[2], a[1] + HEAD_Y),
                (b[0], b[1] + HEAD_Y),
                (b[0] - 3.0, b[1] + HEAD_Y),
            )
        } else {
            (
                (a[0], a[1] + HEAD_Y),
                (b[0] + b[2], b[1] + HEAD_Y),
                (b[0] + b[2] + 3.0, b[1] + HEAD_Y),
            )
        };
        let mx = (from.0 + to.0) * 0.5;
        Some(Route {
            from,
            c1: (mx, from.1),
            c2: (mx, to.1),
            to,
            dot,
            label: (mx, (from.1 + to.1) * 0.5),
        })
    }

    fn polyline(&self) -> Vec<(f32, f32)> {
        const STEPS: usize = 24;
        (0..=STEPS)
            .map(|i| {
                let t = i as f32 / STEPS as f32;
                let u = 1.0 - t;
                let (a, b, c, d) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
                (
                    a * self.from.0 + b * self.c1.0 + c * self.c2.0 + d * self.to.0,
                    a * self.from.1 + b * self.c1.1 + c * self.c2.1 + d * self.to.1,
                )
            })
            .collect()
    }
}

/// The board's three widths for 住 (1.3; 1.9 from three entries; 2.7 from
/// ten), and 挂's dots, 1.9 across.
pub fn width(edge: &Edge) -> f32 {
    match edge.kind {
        EdgeKind::Membership => 1.9,
        EdgeKind::Residence if edge.count >= 10 => 2.7,
        EdgeKind::Residence if edge.count >= 3 => 1.9,
        EdgeKind::Residence => 1.3,
    }
}

/// The lines' ink at rest: halfway between ink 3 and ink 4.
pub fn line_ink(palette: &Palette) -> Rgb {
    palette.ink(3).mix(palette.ink(4), 0.5)
}

/// The sand pen's uneven solid line (`stroke-dasharray: 17 1.6 9 1.2 26 2
/// 13 1.4`).
const SAND_DASH: [f32; 8] = [17.0, 1.6, 9.0, 1.2, 26.0, 2.0, 13.0, 1.4];
/// 挂's dots, centre to centre (`stroke-dasharray: 0.5 6`, round caps).
const DOT_STEP: f32 = 6.5;

/// How one line is painted.
#[derive(Clone, Copy)]
pub struct Stroke {
    pub color: Hsla,
    pub width: f32,
    /// The end dot (the board; the thumbnail has none).
    pub dot: bool,
    /// The thumbnail's thin lines: 住 plain, 挂 in `1 2.5` dashes.
    pub thin: bool,
}

/// Paints `route` into `bounds`, board coordinates times `scale`.
pub fn paint_route(
    route: &Route,
    kind: EdgeKind,
    stroke: Stroke,
    bounds: Bounds<Pixels>,
    scale: f32,
    window: &mut Window,
) {
    let at = |(x, y): (f32, f32)| bounds.origin + point(px(x * scale), px(y * scale));
    let points: Vec<Point<Pixels>> = route.polyline().into_iter().map(at).collect();
    let width = px(stroke.width);
    match (kind, stroke.thin) {
        (EdgeKind::Residence, true) => {
            let mut path = PathBuilder::stroke(width);
            path.move_to(points[0]);
            for p in &points[1..] {
                path.line_to(*p);
            }
            if let Ok(path) = path.build() {
                window.paint_path(path, stroke.color);
            }
        }
        (EdgeKind::Residence, false) => dashed(&points, &SAND_DASH, width, stroke.color, window),
        (EdgeKind::Membership, true) => dashed(&points, &[1.0, 2.5], width, stroke.color, window),
        (EdgeKind::Membership, false) => {
            let mut walked = 0.0;
            let mut next = 0.0;
            for pair in points.windows(2) {
                let delta = pair[1] - pair[0];
                let length = f32::from(delta.x).hypot(f32::from(delta.y));
                while next <= walked + length {
                    let t = if length > 0.0 {
                        (next - walked) / length
                    } else {
                        0.0
                    };
                    circle(
                        pair[0] + delta * t,
                        stroke.width * 0.5,
                        stroke.color,
                        window,
                    );
                    next += DOT_STEP;
                }
                walked += length;
            }
        }
    }
    if stroke.dot {
        circle(at(route.dot), 2.6, stroke.color, window);
    }
}

/// Strokes the runs of `pattern` (on, off, on, …) along `points`.
fn dashed(
    points: &[Point<Pixels>],
    pattern: &[f32],
    width: Pixels,
    color: Hsla,
    window: &mut Window,
) {
    let mut path = PathBuilder::stroke(width);
    let mut index = 0;
    let mut left = pattern[0];
    let mut drawing = false;
    for pair in points.windows(2) {
        let delta = pair[1] - pair[0];
        let length = f32::from(delta.x).hypot(f32::from(delta.y));
        let mut done = 0.0;
        while done < length {
            let step = left.min(length - done);
            if index % 2 == 0 {
                if !drawing {
                    path.move_to(pair[0] + delta * (done / length));
                    drawing = true;
                }
                path.line_to(pair[0] + delta * ((done + step) / length));
            }
            done += step;
            left -= step;
            if left <= 0.0 {
                index = (index + 1) % pattern.len();
                left = pattern[index];
                drawing = false;
            }
        }
    }
    if let Ok(path) = path.build() {
        window.paint_path(path, color);
    }
}

fn circle(centre: Point<Pixels>, radius: f32, color: Hsla, window: &mut Window) {
    let r = px(radius);
    window.paint_quad(
        gpui::fill(
            Bounds::new(centre - point(r, r), size(r * 2.0, r * 2.0)),
            color,
        )
        .corner_radii(r),
    );
}
