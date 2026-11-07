//! How long the paint layers take to change, and the one tween they use.
//!
//! The durations are Drifting's motion vocabulary (`docs/design-system/
//! motion.md`): sand appears and goes as a whole over 0.3 s, a change of
//! strength (pointing at it) takes 0.24 s, a stroke the author's own action
//! draws runs along its rows (0.38 s for the first row, 0.12 s more for each
//! further one, easing out). Nothing switches in one frame. With reduced
//! motion every change lands at once.
//!
//! Time comes from GPUI's executor clock, so tests (and offscreen captures)
//! drive it with `advance_clock`.

use std::time::{Duration, Instant};

/// Sand fading in or out as a whole.
pub const FADE: Duration = Duration::from_millis(300);
/// A change of strength: rest → hot (pointed at) and back.
pub const SHIFT: Duration = Duration::from_millis(240);
/// Drawing a stroke along its first row.
pub const DRAW: Duration = Duration::from_millis(380);
/// Each further row of a drawn stroke.
pub const DRAW_PER_ROW: Duration = Duration::from_millis(120);
/// How long the pointer rests on a decoration before it counts as pointed.
pub const POINT_REST: Duration = Duration::from_millis(120);
/// Touched words going back to the text colour.
pub const TOUCH_FADE: Duration = Duration::from_millis(300);
/// A scrollbar tick arriving (the `sand-arrive` fade).
pub const TICK_IN: Duration = Duration::from_millis(340);
/// Immersive writing: the paragraph the caret leaves fading, the one it
/// enters coming back (the glass bleed, `--motion-glass-bleed`).
pub const FOCUS_SHIFT: Duration = Duration::from_millis(240);

/// Ease-out cubic: fast start, gentle landing.
pub fn ease_out(t: f32) -> f32 {
    let t = t.clamp(0., 1.);
    1. - (1. - t).powi(3)
}

/// How much of a drawn stroke's length is down at `t` (0–1) of its time:
/// the inverse of the old client's `sandDrawTimeAt`, one movement easing
/// out across every row.
pub fn drawn_at(t: f32) -> f32 {
    1. - (1. - t.clamp(0., 1.)).powf(2.2)
}

/// The whole time of a stroke drawn over `rows` rows.
pub fn draw_time(rows: usize) -> Duration {
    DRAW + DRAW_PER_ROW * rows.saturating_sub(1) as u32
}

/// A value easing from where it was to a target.
#[derive(Clone, Copy, Debug)]
pub struct Level {
    from: f32,
    to: f32,
    start: Instant,
    duration: Duration,
}

impl Level {
    /// Already at `value`.
    pub fn still(value: f32, now: Instant) -> Level {
        Level {
            from: value,
            to: value,
            start: now,
            duration: Duration::ZERO,
        }
    }

    pub fn value(&self, now: Instant) -> f32 {
        if self.duration.is_zero() {
            return self.to;
        }
        let t =
            now.saturating_duration_since(self.start).as_secs_f32() / self.duration.as_secs_f32();
        if t >= 1. {
            self.to
        } else {
            self.from + (self.to - self.from) * ease_out(t)
        }
    }

    pub fn target(&self) -> f32 {
        self.to
    }

    pub fn settled(&self, now: Instant) -> bool {
        self.duration.is_zero() || now.saturating_duration_since(self.start) >= self.duration
    }

    /// Heads for `to` from wherever it is now (no jump back), over
    /// `duration`.
    pub fn retarget(&mut self, to: f32, now: Instant, duration: Duration) {
        if to == self.to {
            return;
        }
        *self = Level {
            from: self.value(now),
            to,
            start: now,
            duration,
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levels_ease_and_retarget_from_where_they_are() {
        let t0 = Instant::now();
        let mut level = Level::still(0., t0);
        level.retarget(1., t0, FADE);
        assert_eq!(level.value(t0), 0.);
        let mid = level.value(t0 + FADE / 2);
        assert!(mid > 0.5 && mid < 1., "{mid}");
        assert!(!level.settled(t0 + FADE / 2));
        // Turning back half-way starts from the value it had reached.
        level.retarget(0., t0 + FADE / 2, FADE);
        assert!((level.value(t0 + FADE / 2) - mid).abs() < 1e-6);
        assert_eq!(level.value(t0 + FADE * 2), 0.);
        assert!(level.settled(t0 + FADE * 2));
    }

    #[test]
    fn a_drawn_stroke_eases_out_over_its_rows() {
        assert_eq!(draw_time(1), DRAW);
        assert_eq!(draw_time(3), DRAW + DRAW_PER_ROW * 2);
        assert_eq!(drawn_at(0.), 0.);
        assert_eq!(drawn_at(1.), 1.);
        // Most of the length is down early.
        assert!(drawn_at(0.3) > 0.5);
    }
}
