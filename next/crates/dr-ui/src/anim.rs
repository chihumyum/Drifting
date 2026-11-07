//! Time for transitions.
//!
//! Every animated value in dr-ui is a [`Tween`] read at the moment it is
//! painted, not a value stepped once per frame. A view asks for the next
//! frame only while something it painted is still moving (see
//! [`keep_going`]), so a still window draws no frames at all and costs no
//! CPU.
//!
//! Retargeting a tween mid-way starts from where it is now, so nothing jumps
//! back (motion.md, 「约定」). Under reduced motion every tween lands at once.

use std::{
    cell::{Cell, RefCell},
    collections::HashSet,
    time::Duration,
    time::Instant,
};

use gpui::{App, EntityId, Window};

use crate::tokens::{Easing, Motion};

thread_local! {
    static FROZEN: Cell<Option<Instant>> = const { Cell::new(None) };
    static SLOW: RefCell<HashSet<EntityId>> = RefCell::new(HashSet::new());
}

/// The time transitions are read at. Offscreen captures freeze it so a
/// screenshot shows one exact moment.
pub fn now() -> Instant {
    FROZEN.with(|f| f.get()).unwrap_or_else(Instant::now)
}

/// Freezes [`now`] at `at` (or lets it run with `None`).
pub fn freeze(at: Option<Instant>) {
    FROZEN.with(|f| f.set(at));
}

/// One value easing from `from` to `to`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Tween {
    pub from: f32,
    pub to: f32,
    pub start: Instant,
    pub duration: Duration,
    pub easing: Easing,
}

impl Tween {
    pub fn still(value: f32) -> Tween {
        Tween {
            from: value,
            to: value,
            start: now(),
            duration: Duration::ZERO,
            easing: Easing::LINEAR,
        }
    }

    /// Progress 0–1 at `at`.
    pub fn progress(&self, at: Instant) -> f32 {
        if self.duration.is_zero() {
            return 1.0;
        }
        let t =
            at.saturating_duration_since(self.start).as_secs_f32() / self.duration.as_secs_f32();
        self.easing.at(t.clamp(0.0, 1.0))
    }

    pub fn value(&self, at: Instant) -> f32 {
        self.from + (self.to - self.from) * self.progress(at)
    }

    pub fn settled(&self, at: Instant) -> bool {
        self.from == self.to || at.saturating_duration_since(self.start) >= self.duration
    }

    /// Heads for `to` from wherever it is at `at`. A tween already heading
    /// there keeps its course.
    pub fn retarget(&mut self, to: f32, at: Instant, duration: Duration, easing: Easing) {
        if self.to == to {
            return;
        }
        let from = self.value(at);
        *self = Tween {
            from,
            to,
            start: at,
            duration,
            easing,
        };
    }

    pub fn retarget_motion(&mut self, to: f32, at: Instant, motion: Motion, reduce: bool) {
        let duration = if reduce {
            Duration::ZERO
        } else {
            motion.duration
        };
        self.retarget(to, at, duration, motion.easing);
    }

    /// Jumps straight to `to`.
    pub fn set(&mut self, to: f32) {
        *self = Tween::still(to);
    }
}

/// Asks for one more frame of the view being painted when `moving`. Call it
/// from paint with whatever is still in motion; once nothing is, frames stop.
pub fn keep_going(moving: bool, window: &Window) {
    if moving {
        window.request_animation_frame();
    }
}

/// The slowest a moving thing may be redrawn: below this a slow drift
/// would step visibly.
pub const SLOW_FRAME: Duration = Duration::from_millis(33);

/// Asks for a frame of the view being painted within `interval` instead of
/// on the next display refresh: for slow, steady movement (a rim drifting
/// one 150px tile in 15s moves a third of a pixel in 33ms), so a hovered
/// control costs a fraction of a 120Hz redraw. One request per view at a time.
pub fn keep_going_within(interval: Duration, window: &Window, cx: &App) {
    let view = window.current_view();
    if !SLOW.with(|s| s.borrow_mut().insert(view)) {
        return;
    }
    window
        .spawn(cx, async move |cx| {
            cx.background_executor().timer(interval).await;
            SLOW.with(|s| s.borrow_mut().remove(&view));
            cx.update(|_, cx| cx.notify(view)).ok();
        })
        .detach();
}

/// How often to redraw something moving at `speed` px/s so that each frame
/// moves it at most a third of a pixel, between the display rate and
/// [`SLOW_FRAME`].
pub fn interval_for(speed: f32) -> Option<Duration> {
    if speed <= 0.0 {
        return None;
    }
    let secs = (0.33 / speed).min(SLOW_FRAME.as_secs_f32());
    (secs >= 1.0 / 60.0).then(|| Duration::from_secs_f32(secs))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_retarget_continues_from_where_it_was() {
        let t0 = Instant::now();
        let mut tween = Tween::still(0.0);
        tween.start = t0;
        tween.retarget(1.0, t0, Duration::from_millis(100), Easing::LINEAR);
        let mid = t0 + Duration::from_millis(50);
        assert!((tween.value(mid) - 0.5).abs() < 0.01);
        tween.retarget(0.0, mid, Duration::from_millis(100), Easing::LINEAR);
        assert!((tween.value(mid) - 0.5).abs() < 0.01);
        assert!(tween.value(mid + Duration::from_millis(100)) == 0.0);
        assert!(tween.settled(mid + Duration::from_millis(100)));
    }

    #[test]
    fn a_slow_drift_is_redrawn_thirty_times_a_second_and_a_fast_one_every_refresh() {
        // Hover: one tile in 15s.
        assert_eq!(interval_for(10.0), Some(SLOW_FRAME));
        // Waiting on the app: one tile in 2.4s.
        assert_eq!(interval_for(62.5), None);
        assert_eq!(interval_for(0.0), None);
    }

    #[test]
    fn reduced_motion_lands_at_once() {
        let t0 = Instant::now();
        let mut tween = Tween::still(0.0);
        tween.retarget_motion(1.0, t0, crate::tokens::motion::PUSH, true);
        assert_eq!(tween.value(t0), 1.0);
    }
}
