//! Where the relation lines go (`kernel-v5.md` §19 「指针停在名字上」), as
//! plain geometry on what the prose painted, so it is tested without a
//! window. The rules are the chosen prototype's (第 3 版, `edgesOnScreen`,
//! `curve`, the label placement in `draw` and the card side in
//! `openHover`):
//!
//! - **One place per entry.** An entry named several times on screen is
//!   joined at one of them: the pointed one keeps its own; every other entry
//!   the occurrence nearest to it (vertical distance counts 1.4 times).
//!   With nothing pointed (a rail row), the one nearest the middle of the
//!   view.
//! - **One line per pair.** Every relation between the two (any row, either
//!   way) is one name on that line, joined by 「·」.
//! - **The arc.** On one row: from under the first name to under the second,
//!   sagging 20 px. Otherwise from under the upper name to over the lower,
//!   bowed to the right by 16 % of its length (6–44 px).
//! - **Its name** sits where the arc crosses a blank between two rows of
//!   text (a row's top), the blank nearest the arc's middle that is free;
//!   two names that would touch take the next blank.
//! - **The card** goes to the side with fewer lines: above the name when
//!   more of its lines go down.

use std::collections::{BTreeMap, HashMap};

use gpui::{Bounds, Pixels, SharedString};

/// A linked name painted on screen: its entry, where its link is
/// (chapter and decoration id) and the box of its words.
#[derive(Clone, Debug, PartialEq)]
pub struct Name {
    pub entry: String,
    pub chapter: usize,
    pub id: SharedString,
    pub rect: Bounds<Pixels>,
}

impl Name {
    fn center(&self) -> (f32, f32) {
        let c = self.rect.center();
        (f32::from(c.x), f32::from(c.y))
    }
}

/// One relation's name on a line, and the entry it points at (a directed
/// relation; `None` for a symmetric one).
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Label {
    pub name: String,
    pub to: Option<String>,
}

/// A line between two names on screen (indices into the names).
#[derive(Clone, Debug, PartialEq)]
pub struct Edge {
    pub a: usize,
    pub b: usize,
    pub labels: Vec<Label>,
}

fn distance(a: &Name, b: &Name) -> f32 {
    let (ax, ay) = a.center();
    let (bx, by) = b.center();
    (ax - bx).hypot((ay - by) * 1.4)
}

/// The occurrence each entry is joined at: `focus` (an index into `names`)
/// for its own entry, and for the others the one nearest it; without a
/// focus, the one nearest `middle`.
pub fn anchors(names: &[Name], focus: Option<usize>, middle: (f32, f32)) -> BTreeMap<String, usize> {
    let mut out: BTreeMap<String, usize> = BTreeMap::new();
    let focus_name = focus.and_then(|f| names.get(f));
    for (ix, name) in names.iter().enumerate() {
        if let Some(f) = focus_name
            && f.entry == name.entry
        {
            out.insert(name.entry.clone(), focus.expect("focus"));
            continue;
        }
        let better = |known: usize| -> bool {
            let other = &names[known];
            match focus_name {
                Some(f) => distance(name, f) < distance(other, f),
                None => {
                    let d = |n: &Name| {
                        let (x, y) = n.center();
                        (x - middle.0).hypot((y - middle.1) * 1.4)
                    };
                    d(name) < d(other)
                }
            }
        };
        match out.get(&name.entry) {
            Some(&known) if !better(known) => {}
            _ => {
                out.insert(name.entry.clone(), ix);
            }
        }
    }
    out
}

/// The unordered key a pair of entries is kept under.
pub fn pair_key(a: &str, b: &str) -> (String, String) {
    if a <= b {
        (a.to_owned(), b.to_owned())
    } else {
        (b.to_owned(), a.to_owned())
    }
}

/// The lines between the names on screen: every pair of entries shown that
/// `pairs` relates, joined at their anchors.
pub fn edges(
    names: &[Name],
    anchors: &BTreeMap<String, usize>,
    pairs: &HashMap<(String, String), Vec<Label>>,
) -> Vec<Edge> {
    let entries: Vec<(&String, &usize)> = anchors.iter().collect();
    let mut out = Vec::new();
    for i in 0..entries.len() {
        for j in i + 1..entries.len() {
            let (x, &a) = entries[i];
            let (y, &b) = entries[j];
            if let Some(labels) = pairs.get(&pair_key(x, y))
                && !labels.is_empty()
                && a < names.len()
                && b < names.len()
            {
                out.push(Edge {
                    a,
                    b,
                    labels: labels.clone(),
                });
            }
        }
    }
    out
}

/// An arc: a quadratic curve from `from` through `ctrl` to `to`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Curve {
    pub from: (f32, f32),
    pub ctrl: (f32, f32),
    pub to: (f32, f32),
}

impl Curve {
    pub fn at(&self, t: f32) -> (f32, f32) {
        let u = 1.0 - t;
        (
            u * u * self.from.0 + 2.0 * u * t * self.ctrl.0 + t * t * self.to.0,
            u * u * self.from.1 + 2.0 * u * t * self.ctrl.1 + t * t * self.to.1,
        )
    }

    /// The point on the curve whose height is nearest `y` (of 31 along it),
    /// and how far off that height it is.
    fn nearest_to_height(&self, y: f32) -> ((f32, f32), f32) {
        let mut best = (self.at(0.0), f32::MAX);
        for s in 0..=30 {
            let p = self.at(s as f32 / 30.0);
            let d = (p.1 - y).abs();
            if d < best.1 {
                best = (p, d);
            }
        }
        best
    }
}

fn bounds(r: &Bounds<Pixels>) -> (f32, f32, f32, f32) {
    (
        f32::from(r.left()),
        f32::from(r.top()),
        f32::from(r.right()),
        f32::from(r.bottom()),
    )
}

/// The arc from name box `a` to name box `b`.
pub fn curve(a: &Bounds<Pixels>, b: &Bounds<Pixels>) -> Curve {
    let (al, at, ar, ab) = bounds(a);
    let (bl, bt, br, bb) = bounds(b);
    let (acx, acy) = ((al + ar) / 2.0, (at + ab) / 2.0);
    let (bcx, bcy) = ((bl + br) / 2.0, (bt + bb) / 2.0);
    if (acy - bcy).abs() < 8.0 {
        let y = ab.max(bb) + 2.0;
        return Curve {
            from: (acx, y),
            ctrl: ((acx + bcx) / 2.0, y + 20.0),
            to: (bcx, y),
        };
    }
    let ((tx, tb), (lx, lt)) = if acy < bcy {
        ((acx, ab), (bcx, bt))
    } else {
        ((bcx, bb), (acx, at))
    };
    let (x1, y1, x2, y2) = (tx, tb + 2.0, lx, lt - 2.0);
    let (dx, dy) = (x2 - x1, y2 - y1);
    let len = dx.hypot(dy).max(1.0);
    let (mut nx, mut ny) = (-dy / len, dx / len);
    if nx < 0.0 {
        nx = -nx;
        ny = -ny;
    }
    let bow = (len * 0.16).clamp(6.0, 44.0);
    Curve {
        from: (x1, y1),
        ctrl: ((x1 + x2) / 2.0 + nx * bow, (y1 + y2) / 2.0 + ny * bow),
        to: (x2, y2),
    }
}

/// The blanks between rows: each painted row's top and bottom, top to
/// bottom, those within a pixel of each other as one.
pub fn blanks(rows: &[Bounds<Pixels>]) -> Vec<f32> {
    let mut ys: Vec<f32> = rows
        .iter()
        .flat_map(|r| [f32::from(r.top()), f32::from(r.bottom())])
        .collect();
    ys.sort_by(f32::total_cmp);
    ys.dedup_by(|a, b| (*a - *b).abs() < 1.0);
    ys
}

/// How far apart two placed names must stay vertically.
const LABEL_CLEAR: f32 = 12.0;

/// Where each curve's name goes (its centre), `widths` its estimated
/// width: on a blank near the curve's middle that the curve crosses within
/// 4 px and no earlier name touches; else at the nearest blank's crossing.
pub fn place_labels(curves: &[Curve], widths: &[f32], blanks: &[f32]) -> Vec<(f32, f32)> {
    let mut placed: Vec<(f32, f32, f32)> = Vec::new();
    let mut out = Vec::with_capacity(curves.len());
    for (curve, &w) in curves.iter().zip(widths) {
        let mid = curve.at(0.5);
        let mut rows: Vec<f32> = blanks.to_vec();
        rows.sort_by(|p, q| (p - mid.1).abs().total_cmp(&(q - mid.1).abs()));
        rows.truncate(6);
        let at = |y: f32| {
            let (p, off) = curve.nearest_to_height(y);
            ((p.0, if off > 4.0 { p.1 } else { y }), off)
        };
        let mut pos = None;
        for &y in &rows {
            let (c, off) = at(y);
            if off > 4.0 {
                continue;
            }
            if placed.iter().any(|&(qx, qy, qw)| {
                (qy - c.1).abs() < LABEL_CLEAR && (qx - c.0).abs() < (qw + w) / 2.0 + 4.0
            }) {
                continue;
            }
            pos = Some(c);
            break;
        }
        let pos = pos.unwrap_or_else(|| match rows.first() {
            Some(&y) => at(y).0,
            None => mid,
        });
        placed.push((pos.0, pos.1, w));
        out.push(pos);
    }
    out
}

/// Whether the card goes above the pointed name: more of its lines go
/// down than up.
pub fn card_above(names: &[Name], edges: &[Edge], focus: usize) -> bool {
    let Some(me) = names.get(focus) else {
        return false;
    };
    let my_y = me.center().1;
    let (mut up, mut down) = (0, 0);
    for e in edges {
        let other = if e.a == focus {
            e.b
        } else if e.b == focus {
            e.a
        } else {
            continue;
        };
        if names[other].center().1 < my_y - 8.0 {
            up += 1;
        } else {
            down += 1;
        }
    }
    down > up
}

/// A label's width at 11.5 px: CJK and other wide characters a full em,
/// the rest about half; an arrow 12 px; 「·」 between names 9 px; 6 px of
/// padding.
pub fn label_width(labels: &[Label]) -> f32 {
    let mut w = 6.0;
    for (i, l) in labels.iter().enumerate() {
        if i > 0 {
            w += 9.0;
        }
        w += l
            .name
            .chars()
            .map(|c| if (c as u32) < 0x2e80 { 6.5 } else { 11.5 })
            .sum::<f32>();
        if l.to.is_some() {
            w += 12.0;
        }
    }
    w
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{point, px, size};

    fn name(entry: &str, x: f32, y: f32) -> Name {
        Name {
            entry: entry.into(),
            chapter: 0,
            id: SharedString::from(format!("{entry}@{x},{y}")),
            rect: Bounds::new(point(px(x), px(y)), size(px(34.), px(20.))),
        }
    }

    fn related(pairs: &[(&str, &str, &str)]) -> HashMap<(String, String), Vec<Label>> {
        let mut out: HashMap<(String, String), Vec<Label>> = HashMap::new();
        for (a, b, n) in pairs {
            out.entry(pair_key(a, b)).or_default().push(Label {
                name: (*n).into(),
                to: None,
            });
        }
        out
    }

    #[test]
    fn the_pointed_name_keeps_its_place_and_others_take_the_nearest() {
        let names = [
            name("aq", 100., 100.),
            name("wh", 100., 40.),
            name("wh", 100., 400.),
            name("aq", 300., 600.),
        ];
        let at = anchors(&names, Some(0), (0., 0.));
        assert_eq!(at["aq"], 0);
        assert_eq!(at["wh"], 1, "the occurrence nearer the pointed name");
        let at = anchors(&names, Some(3), (0., 0.));
        assert_eq!(at["aq"], 3);
        assert_eq!(at["wh"], 2);
    }

    #[test]
    fn one_line_per_pair_and_only_related_pairs() {
        let names = [name("aq", 0., 0.), name("wh", 0., 60.), name("xd", 0., 120.)];
        let at = anchors(&names, Some(0), (0., 0.));
        let mut pairs = related(&[("aq", "wh", "冤家"), ("wh", "aq", "欺辱")]);
        let e = edges(&names, &at, &pairs);
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].labels.len(), 2);
        pairs.extend(related(&[("wh", "xd", "冤家")]));
        let e = edges(&names, &at, &pairs);
        assert_eq!(e.len(), 2, "lines between names other than the pointed one too");
    }

    #[test]
    fn arcs_run_under_a_row_or_from_the_upper_name_down() {
        let a = Bounds::new(point(px(0.), px(0.)), size(px(40.), px(20.)));
        let b = Bounds::new(point(px(200.), px(0.)), size(px(40.), px(20.)));
        let c = curve(&a, &b);
        assert_eq!(c.from, (20., 22.));
        assert_eq!(c.to, (220., 22.));
        assert_eq!(c.ctrl.1, 42.);
        let low = Bounds::new(point(px(0.), px(300.)), size(px(40.), px(20.)));
        let c = curve(&low, &a);
        assert_eq!(c.from, (20., 22.), "from under the upper name");
        assert_eq!(c.to, (20., 298.), "to over the lower one");
        assert!(c.ctrl.0 > 20., "bowed to the right");
    }

    #[test]
    fn names_sit_on_blanks_and_do_not_touch() {
        let rows: Vec<Bounds<Pixels>> = (0..10)
            .map(|i| Bounds::new(point(px(0.), px(i as f32 * 33.)), size(px(500.), px(33.))))
            .collect();
        let blanks = blanks(&rows);
        assert_eq!(blanks.len(), 11);
        let c = Curve {
            from: (100., 10.),
            ctrl: (130., 160.),
            to: (100., 320.),
        };
        let at = place_labels(&[c, c], &[40., 40.], &blanks);
        for (x, y) in &at {
            assert!(blanks.iter().any(|b| (b - y).abs() < 0.01), "on a blank: {y}");
            assert!(*x > 100.);
        }
        assert!((at[0].1 - at[1].1).abs() >= LABEL_CLEAR, "the second moved to the next blank");
    }

    #[test]
    fn the_card_goes_where_fewer_lines_go() {
        let names = [name("aq", 0., 200.), name("wh", 0., 300.), name("xd", 0., 400.), name("jy", 0., 50.)];
        let at = anchors(&names, Some(0), (0., 0.));
        let pairs = related(&[("aq", "wh", "冤家"), ("aq", "xd", "冤家"), ("aq", "jy", "冤家")]);
        let e = edges(&names, &at, &pairs);
        assert!(card_above(&names, &e, 0), "two lines down, one up: above");
        let pairs = related(&[("aq", "jy", "冤家")]);
        let e = edges(&names, &at, &pairs);
        assert!(!card_above(&names, &e, 0));
    }
}
