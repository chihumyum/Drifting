//! The timeline's arithmetic, without GPUI: which lanes there are and what
//! each holds, where a chapter sits on the axis, the dashed links between
//! lanes, and what a drop changes. The 0.1 client's
//! `useBottomTimelineSelectors`, the lanes and links of
//! `DesktopBottomTimeline` and `resolveChapterTimelineMembership`.

use std::collections::HashMap;

use dr_shell::book::Book;
use dr_workspace::dto::ChapterInfo;

/// Px per order unit at zoom 1 (`GRID_UNIT`).
pub const GRID_UNIT: f32 = 20.0;
/// A chapter's clip is this many order units wide (`NODE_DEFAULT_WIDTH`);
/// new chapters are 5 apart (`CHAPTER_ORDER_STRIDE`).
pub const CLIP_UNITS: f64 = 4.0;
/// A drag this close to the tracks' left or right edge scrolls them
/// (`MOBILE_PLANNING_EDGE_ZONE_PX`), at most this fast (18 px a frame at
/// 60 fps, `MOBILE_PLANNING_EDGE_MAX_STEP_PX`), faster the closer.
pub const EDGE_ZONE: f32 = 48.0;
pub const EDGE_SPEED: f32 = 18.0 * 60.0;

/// How far the tracks scroll in `dt` seconds with the pointer at `x`
/// between `left` and `right` (window px), scrolled `scroll` of at most
/// `max` (the 0.1 client's `mobilePlanningEdgeAutoscrollDelta`, by time).
pub fn edge_step(x: f32, left: f32, right: f32, scroll: f32, max: f32, dt: f32) -> f32 {
    if ![x, left, right, scroll, max, dt]
        .iter()
        .all(|v| v.is_finite())
    {
        return 0.0;
    }
    let (scroll, max) = (scroll.max(0.0), max.max(0.0));
    let step = EDGE_SPEED * dt.clamp(0.0, 1.0 / 20.0);
    if x < left + EDGE_ZONE && scroll > 0.0 {
        let pressure = ((left + EDGE_ZONE - x) / EDGE_ZONE).clamp(0.0, 1.0);
        return -(step * pressure).min(scroll);
    }
    if x > right - EDGE_ZONE && scroll < max {
        let pressure = ((x - (right - EDGE_ZONE)) / EDGE_ZONE).clamp(0.0, 1.0);
        return (step * pressure).min(max - scroll);
    }
    0.0
}

/// How far apart new chapters go (`CHAPTER_ORDER_STRIDE`).
pub const CHAPTER_STRIDE: f64 = 5.0;
/// Order units the axis runs past the last chapter or act (`RUNWAY_UNITS`).
pub const RUNWAY_UNITS: f64 = 12.0;
/// Px past the runway, so the last label is not cut (`extraSpace`).
pub const TRAILING: f32 = 240.0;
/// A lane is never lower than this (`NODE_MIN_HEIGHT`) …
pub const ROW_MIN_HEIGHT: f32 = 30.0;
/// … plus this, counted for the panel's least height (`STORYLINE_GAP`).
pub const ROW_GAP: f32 = 2.0;
/// The lanes' names (`RAIL_WIDTH`).
pub const RAIL_WIDTH: f32 = 148.0;
/// The panel's header row (`HEAD_HEIGHT`).
pub const HEAD_HEIGHT: f32 = 30.0;
/// The act rail (reading order) or the time axis (narrative order) above
/// the lanes (`FULL_BOOK_LANE_HEIGHT`, `AXIS_HEIGHT`).
pub const STRIP_HEIGHT: f32 = 22.0;
/// The Bottom Panel's height until the author drags it
/// (`BOTTOM_PANEL_DEFAULT_HEIGHT`).
pub const DEFAULT_HEIGHT: f32 = 180.0;
/// ⌘ or Ctrl and the wheel zoom between these (`EXPANDED_ZOOM_CONFIG`).
pub const MIN_ZOOM: f32 = 0.5;
pub const MAX_ZOOM: f32 = 3.0;
pub const WHEEL_SENSITIVITY: f32 = 0.002;
/// The glass of a chapter on a lane with no storyline colour (本书 / 未归属,
/// `SYNTHETIC_LANE_CLIP_COLOR`).
pub const SYNTHETIC_CLIP: u32 = 0x2D4A6B;

/// Which order the axis follows.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Axis {
    /// 书序: reading order (`bookOrder`).
    #[default]
    Book,
    /// 叙事时: the story's own time (`narrativeOrder`); a chapter without
    /// one waits in 未放置.
    Narrative,
}

impl Axis {
    /// Where `chapter` sits on this axis, if it is placed.
    pub fn order(self, chapter: &ChapterInfo) -> Option<f64> {
        match self {
            Axis::Book => chapter.book_order,
            Axis::Narrative => chapter.narrative_order,
        }
        .filter(|o| o.is_finite())
    }
}

/// A lane: a storyline, or one of the two with no storyline behind them.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum LaneId {
    Storyline(String),
    /// 本书: the one lane of a book with no storylines.
    Book,
    /// 未归属: chapters on no storyline (shown on request).
    Unaffiliated,
}

impl LaneId {
    pub fn storyline(&self) -> Option<&str> {
        match self {
            LaneId::Storyline(id) => Some(id),
            _ => None,
        }
    }

    pub fn synthetic(&self) -> bool {
        !matches!(self, LaneId::Storyline(_))
    }
}

#[derive(Clone, Debug)]
pub struct Lane {
    pub id: LaneId,
    /// The storyline's name and `#RRGGBB` colour; `None` on 本书 and 未归属.
    pub name: Option<String>,
    pub color: Option<String>,
    /// The placed chapters on this lane's storyline, main or not: the
    /// count beside its name.
    pub members: usize,
    /// What the lane draws: the placed chapters whose main storyline it is,
    /// in axis order.
    pub clips: Vec<ChapterInfo>,
}

/// Order units to px and back.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Scale {
    pub min_order: f64,
    pub max_order: f64,
    pub zoom: f32,
}

impl Scale {
    /// The axis run on to `order` too (a time pin past the last chapter),
    /// with the runway after it.
    pub fn reaching(mut self, order: f64) -> Scale {
        if order.is_finite() {
            self.max_order = self.max_order.max(order + RUNWAY_UNITS);
        }
        self
    }

    /// The axis for chapters at `orders`, reaching `extra` (the furthest act
    /// boundary or time pin) when that is further.
    pub fn new(orders: impl IntoIterator<Item = f64>, extra: Option<f64>, zoom: f32) -> Scale {
        let orders: Vec<f64> = orders.into_iter().collect();
        // A stable baseline: moving the first chapter right does not zoom
        // the whole axis.
        let first = orders.iter().copied().fold(f64::INFINITY, f64::min);
        let min_order = if first.is_finite() {
            first.min(1.0)
        } else {
            1.0
        };
        let last = orders.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let last = if last.is_finite() {
            last
        } else {
            min_order + CLIP_UNITS
        };
        let content = (last + CLIP_UNITS).max(extra.unwrap_or(f64::NEG_INFINITY));
        Scale {
            min_order,
            max_order: content.max(min_order + CLIP_UNITS) + RUNWAY_UNITS,
            zoom,
        }
    }

    /// Px per order unit.
    pub fn unit(&self) -> f32 {
        GRID_UNIT * self.zoom
    }

    pub fn x(&self, order: f64) -> f32 {
        ((order - self.min_order) * self.unit() as f64) as f32
    }

    pub fn order_at(&self, x: f32) -> f64 {
        self.min_order + (x.max(0.0) / self.unit()) as f64
    }

    /// The track's width.
    pub fn width(&self) -> f32 {
        (self.max_order - self.min_order).max(CLIP_UNITS) as f32 * self.unit() + TRAILING
    }

    pub fn clip_width(&self) -> f32 {
        CLIP_UNITS as f32 * self.unit()
    }
}

/// A dashed curve from one chapter to the next on a storyline when either
/// sits on another lane (`crossStorylineLinks`): from `from`'s clip on its
/// main lane to `to`'s on its own, in the storyline's colour.
#[derive(Clone, Debug, PartialEq)]
pub struct Link {
    pub color: Option<String>,
    /// (order, lane index) of each end.
    pub from: (f64, usize),
    pub to: (f64, usize),
}

/// An act boundary on the reading axis.
#[derive(Clone, Debug, PartialEq)]
pub struct ActMark {
    pub name: String,
    /// `None`: the book-head act, from the axis's start.
    pub start: Option<f64>,
}

/// Everything the timeline draws for one book, axis and zoom.
#[derive(Clone, Debug)]
pub struct Layout {
    pub axis: Axis,
    pub lanes: Vec<Lane>,
    /// Chapters not on this axis (narrative order: 未放置), reading order.
    pub unplaced: Vec<ChapterInfo>,
    /// Placed chapters on no storyline (未归属's count), when the book has
    /// storylines.
    pub unaffiliated: usize,
    pub scale: Scale,
    pub links: Vec<Link>,
    /// Reading order only.
    pub acts: Vec<ActMark>,
    /// Placed chapters.
    pub placed: usize,
}

impl Layout {
    /// The lane `chapter` is drawn on.
    pub fn lane_of(&self, chapter: &str) -> Option<usize> {
        self.lanes
            .iter()
            .position(|l| l.clips.iter().any(|c| c.id == chapter))
    }

    /// The least height the panel can be dragged to before the lanes would
    /// crush their names (`minPanelHeight`).
    pub fn min_height(&self) -> f32 {
        HEAD_HEIGHT + STRIP_HEIGHT + self.lanes.len().max(1) as f32 * (ROW_MIN_HEIGHT + ROW_GAP)
    }
}

/// A chapter's main storyline: its primary, or else the first storyline it
/// is on (`resolvePrimaryStorylineId`); only storylines the book still has.
pub fn main_storyline<'a>(
    chapter: &'a ChapterInfo,
    live: &HashMap<&str, usize>,
) -> Option<&'a str> {
    chapter
        .primary_storyline
        .as_deref()
        .filter(|p| chapter.storylines.iter().any(|s| s == p))
        .filter(|p| live.contains_key(p))
        .or_else(|| {
            chapter
                .storylines
                .iter()
                .map(String::as_str)
                .find(|s| live.contains_key(s))
        })
}

fn by_order(axis: Axis) -> impl Fn(&ChapterInfo, &ChapterInfo) -> std::cmp::Ordering {
    move |a, b| {
        let (x, y) = (axis.order(a).unwrap_or(0.0), axis.order(b).unwrap_or(0.0));
        x.total_cmp(&y).then_with(|| a.id.cmp(&b.id))
    }
}

/// The lanes, links and axis of `book` on `axis`; 未归属 is a lane only when
/// `unaffiliated_shown` (and the book has storylines). `moved` stands in for
/// the chapter of its id (a move written but not yet read back).
pub fn layout(
    book: &Book,
    axis: Axis,
    unaffiliated_shown: bool,
    zoom: f32,
    moved: Option<&ChapterInfo>,
) -> Layout {
    let live: HashMap<&str, usize> = book
        .storylines
        .iter()
        .enumerate()
        .map(|(i, s)| (s.id.as_str(), i))
        .collect();
    let (placed, unplaced): (Vec<&ChapterInfo>, Vec<&ChapterInfo>) = book
        .chapters
        .iter()
        .map(|c| match moved {
            Some(m) if m.id == c.id => m,
            _ => c,
        })
        .filter(|c| !c.trashed)
        .partition(|c| axis.order(c).is_some());
    let mut lanes: Vec<Lane> = Vec::new();
    let mut unaffiliated = 0;
    if book.storylines.is_empty() {
        let mut clips: Vec<ChapterInfo> = placed.iter().map(|c| (*c).clone()).collect();
        clips.sort_by(by_order(axis));
        lanes.push(Lane {
            id: LaneId::Book,
            name: None,
            color: None,
            members: clips.len(),
            clips,
        });
    } else {
        for s in &book.storylines {
            let mut clips: Vec<ChapterInfo> = placed
                .iter()
                .filter(|c| main_storyline(c, &live) == Some(s.id.as_str()))
                .map(|c| (*c).clone())
                .collect();
            clips.sort_by(by_order(axis));
            lanes.push(Lane {
                id: LaneId::Storyline(s.id.clone()),
                name: Some(s.name.clone()),
                color: Some(s.color.clone()).filter(|c| !c.is_empty()),
                members: placed
                    .iter()
                    .filter(|c| c.storylines.iter().any(|x| x == &s.id))
                    .count(),
                clips,
            });
        }
        let mut loose: Vec<ChapterInfo> = placed
            .iter()
            .filter(|c| main_storyline(c, &live).is_none())
            .map(|c| (*c).clone())
            .collect();
        loose.sort_by(by_order(axis));
        unaffiliated = loose.len();
        if unaffiliated_shown {
            lanes.push(Lane {
                id: LaneId::Unaffiliated,
                name: None,
                color: None,
                members: loose.len(),
                clips: loose,
            });
        }
    }
    let links = links(book, axis, &placed, &live);
    let acts: Vec<ActMark> = match axis {
        Axis::Book => book
            .acts
            .iter()
            .map(|a| ActMark {
                name: a.name.clone(),
                start: a.start_order.filter(|o| o.is_finite()),
            })
            .collect(),
        Axis::Narrative => Vec::new(),
    };
    // Reading order reaches the furthest act boundary; the narrative axis
    // will reach the furthest time pin.
    let extra = acts
        .iter()
        .filter_map(|a| a.start)
        .fold(None, |m: Option<f64>, o| Some(m.map_or(o, |m| m.max(o))));
    let scale = Scale::new(placed.iter().filter_map(|c| axis.order(c)), extra, zoom);
    Layout {
        axis,
        placed: placed.len(),
        lanes,
        unplaced: unplaced.into_iter().cloned().collect(),
        unaffiliated,
        scale,
        links,
        acts,
    }
}

/// For each storyline, each pair of neighbours on it where one sits on
/// another lane: one curve from the one's clip to the other's. A pair both on
/// the storyline's own lane needs none (their order already shows).
fn links(
    book: &Book,
    axis: Axis,
    placed: &[&ChapterInfo],
    live: &HashMap<&str, usize>,
) -> Vec<Link> {
    let mut out = Vec::new();
    for s in &book.storylines {
        let mut on: Vec<&ChapterInfo> = placed
            .iter()
            .copied()
            .filter(|c| c.storylines.iter().any(|x| x == &s.id))
            .collect();
        on.sort_by(|a, b| by_order(axis)(a, b));
        for pair in on.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            let (Some(am), Some(bm)) = (main_storyline(a, live), main_storyline(b, live)) else {
                continue;
            };
            if am == s.id && bm == s.id {
                continue;
            }
            let (Some(ao), Some(bo)) = (axis.order(a), axis.order(b)) else {
                continue;
            };
            out.push(Link {
                color: Some(s.color.clone()).filter(|c| !c.is_empty()),
                from: (ao, live[am]),
                to: (bo, live[bm]),
            });
        }
    }
    out
}

/// What a drop on `target` changes in a chapter's storylines
/// (`resolveChapterTimelineMembership`): onto a storyline, that storyline
/// becomes its main one in place of the old main one (the others stay);
/// onto 未归属 it leaves every storyline; onto 本书 nothing changes.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Membership {
    pub add: Vec<String>,
    pub remove: Vec<String>,
    /// `Some(None)` clears the primary storyline.
    pub primary: Option<Option<String>>,
}

impl Membership {
    pub fn is_empty(&self) -> bool {
        self.add.is_empty() && self.remove.is_empty() && self.primary.is_none()
    }
}

pub fn membership(chapter: &ChapterInfo, target: &LaneId) -> Membership {
    match target {
        LaneId::Book => Membership::default(),
        LaneId::Unaffiliated => Membership {
            add: Vec::new(),
            remove: chapter.storylines.clone(),
            primary: chapter.primary_storyline.as_ref().map(|_| None),
        },
        LaneId::Storyline(to) => {
            let old = chapter.primary_storyline.as_deref();
            let mut m = Membership::default();
            if !chapter.storylines.iter().any(|s| s == to) {
                m.add.push(to.clone());
            }
            if let Some(old) = old.filter(|o| o != to)
                && chapter.storylines.iter().any(|s| s == old)
            {
                m.remove.push(old.to_owned());
            }
            if old != Some(to.as_str()) {
                m.primary = Some(Some(to.clone()));
            }
            m
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chapter(id: &str, order: f64, storylines: &[&str], primary: Option<&str>) -> ChapterInfo {
        ChapterInfo {
            id: id.into(),
            title: id.into(),
            summary: String::new(),
            number: None,
            book_order: Some(order),
            narrative_order: None,
            status: "draft".into(),
            act: None,
            storylines: storylines.iter().map(|s| s.to_string()).collect(),
            primary_storyline: primary.map(str::to_owned),
            trashed: false,
            words: 0,
            created_at: None,
            updated_at: None,
        }
    }

    #[test]
    fn a_drag_at_an_edge_scrolls_faster_the_closer() {
        let dt = 1.0 / 60.0;
        // In the middle: nothing.
        assert_eq!(edge_step(500.0, 100.0, 900.0, 200.0, 1000.0, dt), 0.0);
        // At the right edge: a whole step; halfway into the zone, half.
        assert!((edge_step(900.0, 100.0, 900.0, 200.0, 1000.0, dt) - 18.0).abs() < 1e-3);
        assert!((edge_step(876.0, 100.0, 900.0, 200.0, 1000.0, dt) - 9.0).abs() < 1e-3);
        // Left, back towards the start, never past it.
        assert!((edge_step(100.0, 100.0, 900.0, 200.0, 1000.0, dt) + 18.0).abs() < 1e-3);
        assert_eq!(edge_step(100.0, 100.0, 900.0, 5.0, 1000.0, dt), -5.0);
        assert_eq!(edge_step(100.0, 100.0, 900.0, 0.0, 1000.0, dt), 0.0);
        // Never past the end.
        assert_eq!(edge_step(900.0, 100.0, 900.0, 995.0, 1000.0, dt), 5.0);
    }

    #[test]
    fn the_axis_starts_at_one_and_runs_past_the_last_clip() {
        let s = Scale::new([5.0, 10.0, 15.0], None, 1.0);
        assert_eq!(s.min_order, 1.0);
        assert_eq!(s.max_order, 15.0 + CLIP_UNITS + RUNWAY_UNITS);
        assert_eq!(s.x(5.0), 80.0);
        assert_eq!(s.order_at(80.0), 5.0);
        assert_eq!(s.order_at(-10.0), 1.0);
        assert_eq!(s.clip_width(), 80.0);
        assert_eq!(s.width(), (31.0 - 1.0) * 20.0 + TRAILING);
        // An act boundary further out takes the axis with it.
        let s = Scale::new([5.0], Some(40.0), 2.0);
        assert_eq!(s.max_order, 40.0 + RUNWAY_UNITS);
        assert_eq!(s.unit(), 40.0);
        // A chapter before 1 moves the start.
        assert_eq!(Scale::new([-4.0, 5.0], None, 1.0).min_order, -4.0);
    }

    #[test]
    fn the_main_storyline_falls_back_to_the_first() {
        let live: HashMap<&str, usize> = [("a", 0), ("b", 1)].into();
        assert_eq!(
            main_storyline(&chapter("1", 5.0, &["a", "b"], Some("b")), &live),
            Some("b")
        );
        assert_eq!(
            main_storyline(&chapter("1", 5.0, &["a", "b"], None), &live),
            Some("a")
        );
        assert_eq!(
            main_storyline(&chapter("1", 5.0, &["gone", "b"], None), &live),
            Some("b")
        );
        assert_eq!(main_storyline(&chapter("1", 5.0, &[], None), &live), None);
    }

    #[test]
    fn a_drop_moves_the_main_storyline_and_keeps_the_others() {
        let c = chapter("1", 5.0, &["a", "b"], Some("a"));
        assert_eq!(
            membership(&c, &LaneId::Storyline("c".into())),
            Membership {
                add: vec!["c".into()],
                remove: vec!["a".into()],
                primary: Some(Some("c".into())),
            }
        );
        // Onto a storyline it is already on: that one becomes the main one.
        assert_eq!(
            membership(&c, &LaneId::Storyline("b".into())),
            Membership {
                add: vec![],
                remove: vec!["a".into()],
                primary: Some(Some("b".into())),
            }
        );
        // Its own lane: nothing changes.
        assert!(membership(&c, &LaneId::Storyline("a".into())).is_empty());
        // 未归属: off every storyline.
        assert_eq!(
            membership(&c, &LaneId::Unaffiliated),
            Membership {
                add: vec![],
                remove: vec!["a".into(), "b".into()],
                primary: Some(None),
            }
        );
        assert!(membership(&c, &LaneId::Book).is_empty());
        // No declared primary: nothing is removed.
        let loose = chapter("2", 5.0, &["a"], None);
        assert_eq!(
            membership(&loose, &LaneId::Storyline("b".into())),
            Membership {
                add: vec!["b".into()],
                remove: vec![],
                primary: Some(Some("b".into())),
            }
        );
    }
}
