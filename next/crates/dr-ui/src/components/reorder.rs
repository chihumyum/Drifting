//! The geometry and timing of a pill row in motion (workspace.md, 「标签页在
//! 稿纸顶部」「拖拽排序有重量」): where a dragged pill would land and how the
//! others make way, how everything lands after the drop, and how a dock pill
//! grows out of its mark. Pure functions; [`PillGroup`](super::PillGroup)
//! and [`TabDock`](super::TabDock) apply them.

use std::time::{Duration, Instant};

use crate::tokens::motion;

/// One pill's place in its row: where it starts and how wide its slot is
/// (the gap after it included, so the slots tile the row).
pub type Slot = (f32, f32);

/// Where a dragged pill would land and how far each pill moves aside.
#[derive(Clone, Debug, PartialEq)]
pub struct Projection {
    pub to: usize,
    pub offsets: Vec<f32>,
}

/// The pill `from`, its leading edge at `left` (row coordinates), lands
/// where its edge crosses half of the next slot (only the centres would
/// keep a wide split from passing a narrow end tab). The pills between
/// move aside by its slot; the slots themselves never move, so neither do
/// the hit targets.
pub fn project(slots: &[Slot], from: usize, left: f32) -> Projection {
    let n = slots.len();
    let Some(&(start, width)) = slots.get(from) else {
        return Projection {
            to: from,
            offsets: vec![0.0; n],
        };
    };
    let mut to = from;
    if left > start {
        while to + 1 < n && left + width > slots[to + 1].0 + slots[to + 1].1 / 2.0 {
            to += 1;
        }
    } else {
        while to > 0 && left < slots[to - 1].0 + slots[to - 1].1 / 2.0 {
            to -= 1;
        }
    }
    let offsets = (0..n)
        .map(|i| {
            if i > from && i <= to {
                -width
            } else if i < from && i >= to {
                width
            } else {
                0.0
            }
        })
        .collect();
    Projection { to, offsets }
}

/// Every pill's offset once the dragged one's slot has closed: the pills
/// after it move up and join the ones before.
pub fn closed(slots: &[Slot], from: usize) -> Vec<f32> {
    let width = slots.get(from).map_or(0.0, |s| s.1);
    (0..slots.len())
        .map(|i| if i > from { -width } else { 0.0 })
        .collect()
}

/// Whether the pointer is a row's height or more away from the row (or past
/// either end): the pill has left the row. Nearer than that the row keeps
/// its last arrangement, so a wobble off the row closes nothing.
pub fn is_far(row: (f32, f32, f32, f32), pointer: (f32, f32)) -> bool {
    let (x, y, w, h) = row;
    let (px, py) = pointer;
    px < x - h || px > x + w + h || py < y - h || py > y + h + h
}

/// Whether the pointer is over the row itself.
pub fn is_inside(row: (f32, f32, f32, f32), pointer: (f32, f32)) -> bool {
    let (x, y, w, h) = row;
    let (px, py) = pointer;
    px >= x && px <= x + w && py >= y && py <= y + h
}

/// Where each pill (by its index before the move) starts once `from` has
/// moved to `to`.
pub fn starts_after(slots: &[Slot], from: usize, to: usize) -> Vec<f32> {
    let n = slots.len();
    let mut order: Vec<usize> = (0..n).collect();
    if from < n && to < n {
        let moved = order.remove(from);
        order.insert(to, moved);
    }
    let origin = slots.first().map_or(0.0, |s| s.0);
    let mut starts = vec![0.0; n];
    let mut at = origin;
    for old in order {
        starts[old] = at;
        at += slots[old].1;
    }
    starts
}

/// A move on the weighted spring (the bottom timeline's glass blocks, 520
/// ms) from one offset to another. Sent somewhere else mid-way, it starts
/// again from where it has got to.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Slide {
    from: (f32, f32),
    to: (f32, f32),
    start: Instant,
}

impl Slide {
    /// Standing still at `to`.
    pub fn still(to: (f32, f32), now: Instant) -> Slide {
        Slide {
            from: to,
            to,
            start: now,
        }
    }

    /// From `from` home to nothing.
    pub fn home_from(from: (f32, f32), now: Instant) -> Slide {
        Slide {
            from,
            to: (0.0, 0.0),
            start: now,
        }
    }

    pub fn value(&self, now: Instant) -> (f32, f32) {
        let k = motion::spring_progress(now.saturating_duration_since(self.start).as_secs_f32());
        (
            self.from.0 + (self.to.0 - self.from.0) * k,
            self.from.1 + (self.to.1 - self.from.1) * k,
        )
    }

    pub fn target(&self) -> (f32, f32) {
        self.to
    }

    pub fn retarget(&mut self, to: (f32, f32), now: Instant) {
        if self.to != to {
            *self = Slide {
                from: self.value(now),
                to,
                start: now,
            };
        }
    }

    pub fn settled(&self, now: Instant) -> bool {
        self.from == self.to || now.saturating_duration_since(self.start) >= motion::SPRING_DURATION
    }
}

/// A dock mark's width: a pill grows from it.
pub const MARK_WIDTH: f32 = 20.0;
/// How long a growing pill's words take to show (`dock-pill-content`).
pub const CONTENT_IN: Duration = Duration::from_millis(360);
/// How long the mark a pill grew from takes to spread away
/// (`dock-sand-spread`).
pub const SPREAD: Duration = Duration::from_millis(300);
const SPREAD_EASING: motion::Easing = motion::Easing::new(0.2, 0.6, 0.3, 1.0);
/// How far the spreading mark grows, across and up.
pub const SPREAD_SCALE: (f32, f32) = (2.8, 1.6);

fn progress(elapsed: Duration, over: Duration) -> f32 {
    (elapsed.as_secs_f32() / over.as_secs_f32()).clamp(0.0, 1.0)
}

/// A pill's width `elapsed` after the dock opened: from a mark's width to its
/// own on the dock pill's curve (340 ms).
pub fn grown_width(natural: f32, elapsed: Duration) -> f32 {
    let t = motion::DOCK_PILL
        .easing
        .at(progress(elapsed, motion::DOCK_PILL.duration));
    MARK_WIDTH + (natural - MARK_WIDTH) * t
}

/// Whether a pill that appeared `elapsed` ago is still growing.
pub fn growing(elapsed: Duration) -> bool {
    elapsed < CONTENT_IN.max(motion::DOCK_PILL.duration)
}

/// How much of a growing pill's words show: nothing for the first 45%, then
/// easing out (the same keyframes as the 0.1 client).
pub fn content_opacity(elapsed: Duration) -> f32 {
    let t = progress(elapsed, CONTENT_IN);
    if t <= 0.45 {
        0.0
    } else {
        motion::Easing::EASE_OUT.at((t - 0.45) / 0.55)
    }
}

/// How far the mark a pill grew from has spread away, 0 to 1 (gone).
pub fn spread(elapsed: Duration) -> f32 {
    SPREAD_EASING.at(progress(elapsed, SPREAD))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Four pills 80 wide with a 4px gap: slots of 84.
    fn row() -> Vec<Slot> {
        (0..4).map(|i| (84.0 * i as f32, 84.0)).collect()
    }

    #[test]
    fn the_others_make_way_once_the_edge_passes_half_a_slot() {
        let slots = row();
        // Just picked up: nothing moves.
        assert_eq!(project(&slots, 0, 0.0).to, 0);
        assert_eq!(project(&slots, 0, 0.0).offsets, vec![0.0; 4]);
        // Its right edge (left + 84) past the middle of the second (126).
        let p = project(&slots, 0, 43.0);
        assert_eq!(p.to, 1);
        assert_eq!(p.offsets, vec![0.0, -84.0, 0.0, 0.0]);
        assert_eq!(project(&slots, 0, 41.0).to, 0);
        // Over the third.
        let p = project(&slots, 0, 168.0);
        assert_eq!(p.to, 2);
        assert_eq!(p.offsets, vec![0.0, -84.0, -84.0, 0.0]);
        // Back the other way: the last one to the front.
        let p = project(&slots, 3, 0.0);
        assert_eq!(p.to, 0);
        assert_eq!(p.offsets, vec![84.0, 84.0, 84.0, 0.0]);
        // Past the ends it stays at the ends.
        assert_eq!(project(&slots, 1, 999.0).to, 3);
        assert_eq!(project(&slots, 2, -999.0).to, 0);
    }

    #[test]
    fn a_wide_pill_passes_a_narrow_one() {
        // A split tab (200) and a short one (60).
        let slots = vec![(0.0, 200.0), (200.0, 60.0)];
        // Its edge passes the short one's middle (230) long before its own
        // centre reaches the short one's centre.
        assert_eq!(project(&slots, 0, 31.0).to, 1);
    }

    #[test]
    fn far_from_the_row_its_slot_closes() {
        let slots = row();
        assert_eq!(closed(&slots, 1), vec![0.0, 0.0, -84.0, -84.0]);
        let r = (100.0, 10.0, 336.0, 26.0);
        assert!(is_inside(r, (120.0, 20.0)));
        assert!(!is_inside(r, (120.0, 40.0)));
        // A wobble just under the row is not far.
        assert!(!is_far(r, (120.0, 60.0)));
        assert!(is_far(r, (120.0, 63.0)));
        assert!(is_far(r, (60.0, 20.0)));
        assert!(!is_far(r, (80.0, 20.0)));
    }

    #[test]
    fn after_the_drop_everyone_knows_where_it_lands() {
        let slots = vec![(10.0, 84.0), (94.0, 64.0), (158.0, 104.0)];
        // The first to the end: the others close up, it follows them.
        assert_eq!(starts_after(&slots, 0, 2), vec![178.0, 10.0, 74.0]);
        assert_eq!(starts_after(&slots, 2, 0), vec![114.0, 198.0, 10.0]);
        assert_eq!(starts_after(&slots, 1, 1), vec![10.0, 94.0, 158.0]);
    }

    #[test]
    fn a_slide_retargets_from_where_it_got_to() {
        let t0 = Instant::now();
        let mut s = Slide::still((0.0, 0.0), t0);
        assert!(s.settled(t0));
        s.retarget((-84.0, 0.0), t0);
        let mid = t0 + Duration::from_millis(100);
        let at = s.value(mid).0;
        assert!(at < 0.0 && at > -84.0, "{at}");
        s.retarget((0.0, 0.0), mid);
        assert_eq!(s.value(mid).0, at, "no jump when sent back");
        let end = mid + motion::SPRING_DURATION;
        assert_eq!(s.value(end), (0.0, 0.0));
        assert!(s.settled(end));
    }

    #[test]
    fn a_pill_grows_out_of_its_mark_and_its_words_come_last() {
        assert_eq!(grown_width(120.0, Duration::ZERO), MARK_WIDTH);
        assert_eq!(grown_width(120.0, Duration::from_millis(340)), 120.0);
        let mut last = MARK_WIDTH;
        for ms in (0..=340).step_by(10) {
            let w = grown_width(120.0, Duration::from_millis(ms));
            assert!(w >= last && w <= 120.0, "{ms}ms: {w}");
            last = w;
        }
        // The words are still hidden at 45% of 360 ms, there at the end.
        assert_eq!(content_opacity(Duration::from_millis(160)), 0.0);
        assert!(content_opacity(Duration::from_millis(250)) > 0.3);
        assert_eq!(content_opacity(CONTENT_IN), 1.0);
        assert_eq!(spread(Duration::ZERO), 0.0);
        assert_eq!(spread(SPREAD), 1.0);
        assert!(growing(Duration::from_millis(350)));
        assert!(!growing(Duration::from_millis(360)));
    }
}
