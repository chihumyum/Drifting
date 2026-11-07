//! The motion vocabulary (docs/design-system/motion.md), with the same
//! values as the renderer's `src/renderer/lib/motion.ts` and the
//! `--motion-*` properties in `materials.css`. Each kind of movement has one
//! duration and one curve; components use these names, never numbers.
//! Under reduced motion every one of them skips straight to where it ends
//! (see [`crate::anim`]).

use std::time::Duration;

const fn ms(n: u64) -> Duration {
    Duration::from_millis(n)
}

/// A CSS `cubic-bezier(x1, y1, x2, y2)`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Easing {
    pub x1: f32,
    pub y1: f32,
    pub x2: f32,
    pub y2: f32,
}

impl Easing {
    pub const fn new(x1: f32, y1: f32, x2: f32, y2: f32) -> Easing {
        Easing { x1, y1, x2, y2 }
    }

    pub const LINEAR: Easing = Easing::new(0.0, 0.0, 1.0, 1.0);
    /// CSS `ease-out`.
    pub const EASE_OUT: Easing = Easing::new(0.0, 0.0, 0.58, 1.0);
    /// CSS `ease`.
    pub const EASE: Easing = Easing::new(0.25, 0.1, 0.25, 1.0);

    /// Progress at `t` (0–1 of the duration): solves x(s) = t, returns y(s).
    pub fn at(&self, t: f32) -> f32 {
        if t <= 0.0 {
            return 0.0;
        }
        if t >= 1.0 {
            return 1.0;
        }
        let bez = |a: f32, b: f32, s: f32| {
            let u = 1.0 - s;
            3.0 * u * u * s * a + 3.0 * u * s * s * b + s * s * s
        };
        let slope = |a: f32, b: f32, s: f32| {
            let u = 1.0 - s;
            3.0 * u * u * a + 6.0 * u * s * (b - a) + 3.0 * s * s * (1.0 - b)
        };
        // Newton first, bisection where the curve is too flat for it.
        let mut s = t;
        for _ in 0..8 {
            let x = bez(self.x1, self.x2, s) - t;
            if x.abs() < 1e-5 {
                return bez(self.y1, self.y2, s);
            }
            let d = slope(self.x1, self.x2, s);
            if d.abs() < 1e-6 {
                break;
            }
            s -= x / d;
        }
        let (mut lo, mut hi) = (0.0f32, 1.0f32);
        s = t;
        for _ in 0..40 {
            let x = bez(self.x1, self.x2, s);
            if (x - t).abs() < 1e-5 {
                break;
            }
            if x < t {
                lo = s;
            } else {
                hi = s;
            }
            s = (lo + hi) / 2.0;
        }
        bez(self.y1, self.y2, s)
    }
}

/// One named movement: how long it takes and how it moves.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Motion {
    pub duration: Duration,
    pub easing: Easing,
}

impl Motion {
    pub const fn new(duration: Duration, easing: Easing) -> Motion {
        Motion { duration, easing }
    }
}

/// Structural open and close: the workspace's structure changed (a sidebar
/// opens, a pane splits, the place under the paper opens).
pub const STRUCTURAL: Motion = Motion::new(ms(420), Easing::new(0.32, 0.72, 0.0, 1.0));

/// Heavy-ice push: a whole block of content is pushed away for another,
/// slow to start, then fast (a sidebar's panels, the Panel Tab square).
pub const PUSH: Motion = Motion::new(ms(265), Easing::new(0.8, 0.0, 0.66, 1.0));
/// The arriving block's outline fades this long after it lands.
pub const PUSH_OUTLINE_FADE: Duration = ms(340);

/// The page turn: the next page dissolves in, in place, over the one in
/// front, which stays whole underneath until it is covered.
pub const PAGE_BLEND: Motion = Motion::new(ms(180), Easing::new(0.4, 0.0, 0.2, 1.0));

/// A dock mark grows into its pill, a closed pill folds away.
pub const DOCK_PILL: Motion = Motion::new(ms(340), Easing::new(0.3, 0.7, 0.2, 1.0));

/// A tool floats up from what it serves (the selection bar): 160ms, 3px.
pub const FLOAT_IN: Motion = Motion::new(ms(160), Easing::new(0.3, 0.7, 0.2, 1.0));
pub const FLOAT_IN_RISE: f32 = 3.0;

/// The sweep of a step that has just arrived.
pub const SWEEP: Motion = Motion::new(ms(1125), Easing::new(0.4, 0.1, 0.35, 1.0));

/// Weighted spring: critically damped, a little behind the hand and never
/// springing back; normalised to land on [`SPRING_DURATION`].
pub const SPRING_K: f32 = 150.0;
pub const SPRING_DURATION: Duration = ms(520);

/// Progress of the weighted spring at `t` seconds, normalised to land on 1.
pub fn spring_progress(t: f32) -> f32 {
    let w = SPRING_K.sqrt();
    let end = SPRING_DURATION.as_secs_f32();
    if t >= end {
        return 1.0;
    }
    let settle = 1.0 - (1.0 + w * end) * (-w * end).exp();
    ((1.0 - (1.0 + w * t) * (-w * t).exp()) / settle).clamp(0.0, 1.0)
}

/// Glass: the bleed comes in under the pointer, the rim eases back to its
/// state, a press takes hold, the texture drifts one slow lap (one 150px
/// tile in 15s), a moving line fades once it stops.
pub mod glass {
    use super::*;

    pub const BLEED: Duration = ms(240);
    pub const SETTLE: Duration = ms(280);
    pub const PRESS: Duration = ms(40);
    pub const DRIFT_LAP: Duration = ms(15_000);
    /// Glass waiting on the app drifts faster (`--motion-glass-loading`).
    pub const LOADING_LAP: Duration = ms(2400);
    pub const FLOW_FADE: Duration = ms(320);
    /// A press this long before a selection lands counts as the press that
    /// made it, so the press goes straight into the selected state.
    pub const PRESS_WINDOW: Duration = ms(1500);
}

/// Water wave: a selection flows from the old item to the new one, taking a
/// little longer for each item it crosses (up to four), then fades.
pub mod wave {
    use super::*;

    pub const BASE: Duration = ms(230);
    pub const PER_ITEM: Duration = ms(70);
    pub const MAX_ITEMS: u32 = 4;
    pub const SETTLE: Duration = ms(300);
    /// Midway the band is this much wider, this much fainter, and its soft
    /// edges go from 2px to 16px.
    pub const WIDEN: f32 = 1.35;
    pub const FADE: f32 = 0.18;
    pub const EDGE_FROM: f32 = 2.0;
    pub const EDGE_TO: f32 = 16.0;

    /// How long a wave across `items` items takes.
    pub fn duration(items: u32) -> Duration {
        BASE + PER_ITEM * items.min(MAX_ITEMS)
    }

    /// `outCubic`.
    pub fn ease(t: f32) -> f32 {
        let t = t.clamp(0.0, 1.0);
        1.0 - (1.0 - t).powi(3)
    }
}

/// Sand: a trace the author's own action leaves is drawn along its path;
/// sand that comes or goes for any other reason fades as a whole; a change
/// of its strength shifts.
pub mod sand {
    use super::*;

    pub const DRAW: Duration = ms(380);
    pub const DRAW_PER_LINE: Duration = ms(120);
    pub const FADE: Duration = ms(300);
    pub const SHIFT: Duration = ms(240);
    /// A sand seal arriving (`sand-arrive`): fades in from 0.8×.
    pub const ARRIVE: Duration = ms(340);
    /// A readout's stroke fades in and slides to a new length.
    pub const READOUT_IN: Duration = ms(240);
    pub const READOUT_SLIDE: Duration = ms(250);
    /// The brush's ease along a frame: an out-curve with exponent 2.2.
    pub fn drawn_at(t: f32) -> f32 {
        1.0 - (1.0 - t.clamp(0.0, 1.0)).powf(2.2)
    }
}

/// Dwell and grace.
pub mod dwell {
    use super::*;

    /// How long the pointer rests on a thing before its hover card shows.
    pub const HOVER_CARD_DELAY: Duration = ms(220);
    /// How long leaving a thing gives the pointer to reach its card.
    pub const HOVER_CARD_GRACE: Duration = ms(220);
    /// How long a list must have stopped scrolling before rows under a
    /// resting pointer count as pointed at.
    pub const SCROLL_REST: Duration = ms(180);
    /// A wait shorter than this shows nothing.
    pub const LOADING_DELAY: Duration = ms(240);
    /// The loading mark's fade-in and its lap.
    pub const LOADING_FADE: Duration = ms(160);
    pub const LOADING_LAP: Duration = ms(900);
    /// How long leaving a collapsed choice and its list waits before folding.
    pub const OPTIONS_CLOSE: Duration = ms(160);
    /// A notification pill stays this long before it fades.
    pub const TOAST: Duration = ms(4000);
    /// How long the tab dock stays open after the pointer leaves it before
    /// its pills fold back into marks (`DOCK_COLLAPSE_DELAY_MS`).
    pub const DOCK_COLLAPSE: Duration = ms(260);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn curves_start_at_zero_and_land_on_one() {
        for m in [STRUCTURAL, PUSH, PAGE_BLEND, DOCK_PILL, SWEEP] {
            assert_eq!(m.easing.at(0.0), 0.0);
            assert_eq!(m.easing.at(1.0), 1.0);
            let mut last = 0.0;
            for i in 1..100 {
                let v = m.easing.at(i as f32 / 100.0);
                assert!(v + 1e-4 >= last, "{m:?} not monotonic at {i}");
                last = v;
            }
        }
    }

    #[test]
    fn ice_starts_slow_and_structural_starts_fast() {
        assert!(PUSH.easing.at(0.25) < 0.1);
        assert!(STRUCTURAL.easing.at(0.25) > 0.5);
    }

    #[test]
    fn the_page_turn_matches_css_at_its_midpoint() {
        // cubic-bezier(0.4, 0, 0.2, 1) at x = 0.5 is about 0.774.
        assert!((PAGE_BLEND.easing.at(0.5) - 0.774).abs() < 0.01);
    }

    #[test]
    fn the_spring_lands_without_overshoot() {
        let mut last = 0.0;
        for i in 0..=52 {
            let v = spring_progress(i as f32 / 100.0);
            assert!(v >= last && v <= 1.0);
            last = v;
        }
        assert_eq!(spring_progress(0.52), 1.0);
    }

    #[test]
    fn waves_take_longer_for_each_item_up_to_four() {
        assert_eq!(wave::duration(1), ms(300));
        assert_eq!(wave::duration(4), ms(510));
        assert_eq!(wave::duration(9), ms(510));
    }
}
