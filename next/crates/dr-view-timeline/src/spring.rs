//! A chapter in the hand has weight (the 0.1 client's `weighted` slab in
//! `chapter-lane-drag.ts`): it follows the pointer on springs instead of
//! being glued to it.
//!
//! - Sideways it is heavy: critically damped (`SPRING_K` 150), a little
//!   behind the hand, no bounce.
//! - Across lanes it stays in its lane until the pointer is past the middle
//!   of the next one, then goes over in one quick snap (stiffer, slightly
//!   under-damped for 260 ms) that settles with a barely visible give; in
//!   its lane it leans at most 6 px towards the pointer.
//! - The drop lands on the lane the slab is in, not the one under the
//!   pointer.
//! - Carried well clear of the lanes (half a lane past the first or the
//!   last), it simply follows the hand.
//!
//! Positions are window pixels. Time is passed in (seconds), so tests can
//! step it.

/// The weighted spring (`lib/motion.ts`: `SPRING_K`, `SPRING_W = √K`).
pub const SPRING_K: f32 = 150.0;
/// Across lanes at rest, and while snapping over.
const ROW_K: f32 = 700.0;
const SNAP_K: f32 = 1100.0;
/// How long a snap stays stiff, s.
const SNAP_S: f32 = 0.26;
/// How far the slab leans towards the pointer in its lane, px, and how much.
const LEAN_MAX: f32 = 6.0;
const LEAN: f32 = 0.12;

/// A lane's box: its top and height.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Row {
    pub top: f32,
    pub height: f32,
}

#[derive(Clone, Debug)]
pub struct SlabSpring {
    /// Where the slab is drawn (its top left).
    pub x: f32,
    pub y: f32,
    vx: f32,
    vy: f32,
    /// Where it is going.
    pub tx: f32,
    pub ty: f32,
    /// The lane it is in (`None` until aimed, or carried clear of them).
    row: Option<usize>,
    /// How far below its lane's top the slab sat when it was taken.
    row_offset: f32,
    /// Stiff until then (s).
    snap_until: f32,
    /// The last step (s).
    last: Option<f32>,
}

impl SlabSpring {
    /// Taken at `(x, y)`, its top left.
    pub fn new(x: f32, y: f32) -> SlabSpring {
        SlabSpring {
            x,
            y,
            vx: 0.0,
            vy: 0.0,
            tx: x,
            ty: y,
            row: None,
            row_offset: 0.0,
            snap_until: 0.0,
            last: None,
        }
    }

    /// The lane the slab is in.
    pub fn row(&self) -> Option<usize> {
        self.row
    }

    /// Aims at the pointer `(px, py)`, the slab held `grab` in from its top
    /// left, over `rows` (top to bottom); `start_y` is where the pointer
    /// took it. Returns the lane it would land on (`None`: carried clear of
    /// the lanes, it lands where the pointer is).
    pub fn aim(
        &mut self,
        pointer: (f32, f32),
        grab: (f32, f32),
        rows: &[Row],
        start_y: f32,
        now: f32,
    ) -> Option<usize> {
        let (px, py) = pointer;
        self.tx = px - grab.0;
        if rows.is_empty() {
            self.ty = py - grab.1;
            return None;
        }
        let row = match self.row {
            Some(row) => row.min(rows.len() - 1),
            None => {
                let row = rows
                    .iter()
                    .position(|r| start_y >= r.top && start_y < r.top + r.height)
                    .unwrap_or(0);
                self.row_offset = self.y - rows[row].top;
                row
            }
        };
        let mut row = row;
        let mid = |r: &Row| r.top + r.height / 2.0;
        while row + 1 < rows.len() && py > mid(&rows[row + 1]) {
            row += 1;
            self.snap_until = now + SNAP_S;
        }
        while row > 0 && py < mid(&rows[row - 1]) {
            row -= 1;
            self.snap_until = now + SNAP_S;
        }
        self.row = Some(row);
        let r = rows[row];
        let first = rows[0];
        let last = rows[rows.len() - 1];
        if py < first.top - r.height / 2.0 || py > last.top + last.height + r.height / 2.0 {
            self.ty = py - grab.1;
            return None;
        }
        let rest = r.top + self.row_offset;
        self.ty = rest + ((py - grab.1 - rest) * LEAN).clamp(-LEAN_MAX, LEAN_MAX);
        Some(row)
    }

    /// Moves on to `now` (s). Returns whether it is still moving.
    pub fn step(&mut self, now: f32) -> bool {
        let dt = match self.last {
            Some(last) => (now - last).clamp(0.0, 1.0 / 30.0),
            None => 1.0 / 60.0,
        };
        self.last = Some(now);
        let snapping = now < self.snap_until;
        let ky = if snapping { SNAP_K } else { ROW_K };
        let damp_y = 2.0 * ky.sqrt() * if snapping { 0.6 } else { 1.0 };
        let w = SPRING_K.sqrt();
        for _ in 0..4 {
            let h = dt / 4.0;
            self.vx += (SPRING_K * (self.tx - self.x) - 2.0 * w * self.vx) * h;
            self.x += self.vx * h;
            self.vy += (ky * (self.ty - self.y) - damp_y * self.vy) * h;
            self.y += self.vy * h;
        }
        let resting = (self.tx - self.x).abs() < 0.05
            && self.vx.abs() < 0.5
            && (self.ty - self.y).abs() < 0.05
            && self.vy.abs() < 0.5;
        if resting {
            self.x = self.tx;
            self.y = self.ty;
            self.vx = 0.0;
            self.vy = 0.0;
            self.last = None;
        }
        !resting
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows() -> Vec<Row> {
        (0..3)
            .map(|i| Row {
                top: 100.0 + 40.0 * i as f32,
                height: 40.0,
            })
            .collect()
    }

    #[test]
    fn it_trails_the_hand_sideways_and_settles_without_bouncing() {
        let mut s = SlabSpring::new(0.0, 105.0);
        s.aim((110.0, 120.0), (10.0, 15.0), &rows(), 120.0, 0.0);
        assert_eq!(s.tx, 100.0);
        let mut t = 0.0;
        let mut beyond = false;
        for _ in 0..10 {
            t += 1.0 / 60.0;
            s.step(t);
        }
        // Behind the hand after a sixth of a second …
        assert!(s.x > 10.0 && s.x < 100.0, "{}", s.x);
        while s.step(t) {
            t += 1.0 / 60.0;
            beyond |= s.x > 100.5;
            assert!(t < 3.0, "settles");
        }
        // … there in the end, never past it.
        assert!(!beyond);
        assert_eq!(s.x, 100.0);
    }

    #[test]
    fn it_changes_lane_past_the_middle_of_the_next_and_leans_in_its_own() {
        let rows = rows();
        let mut s = SlabSpring::new(0.0, 105.0);
        // Taken in the first lane (100–140), 5 px below its top.
        assert_eq!(
            s.aim((50.0, 120.0), (10.0, 15.0), &rows, 120.0, 0.0),
            Some(0)
        );
        // Into the second lane's top half: still the first.
        assert_eq!(
            s.aim((50.0, 155.0), (10.0, 15.0), &rows, 120.0, 0.1),
            Some(0)
        );
        // It leans a little towards the pointer (6 px at most).
        assert!((s.ty - (105.0 + 35.0 * LEAN)).abs() < 1e-4, "{}", s.ty);
        // Past the second lane's middle (160): over it goes, 5 px below its top.
        assert_eq!(
            s.aim((50.0, 161.0), (10.0, 15.0), &rows, 120.0, 0.2),
            Some(1)
        );
        assert!((s.ty - 145.0).abs() <= LEAN_MAX);
        // Back up only past the first lane's middle (120).
        assert_eq!(
            s.aim((50.0, 125.0), (10.0, 15.0), &rows, 120.0, 0.3),
            Some(1)
        );
        assert_eq!(
            s.aim((50.0, 119.0), (10.0, 15.0), &rows, 120.0, 0.4),
            Some(0)
        );
        // Well clear of the lanes it follows the hand and lands nowhere.
        assert_eq!(s.aim((50.0, 20.0), (10.0, 15.0), &rows, 120.0, 0.5), None);
        assert_eq!(s.ty, 5.0);
    }
}
