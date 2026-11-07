//! How a glass control answers the hand (materials.md, 「状态」).
//!
//! | State | Rim |
//! | --- | --- |
//! | Hidden at rest | nothing |
//! | Resting line | the uneven line only, a little fainter (strength 0.85, no bleed) |
//! | Hover / focus | bleed in over 0.24s (strength 1, bleed 1), the texture drifts one tile in 15s |
//! | Selected | the hover rim, still; hover does not set it drifting |
//! | Held | strength ×1.7, bleed ×1.3 within 40ms, drift stops; let go, 0.28s back |
//!
//! Glass never sinks, inverts or fills. Leaving pauses the drift where it
//! is; it does not rewind. Transitions change the whole rim at once.

use std::time::{Duration, Instant};

use crate::{
    anim::{self, Tween},
    tokens::{Easing, motion},
};

use super::{FLOW_PX_PER_S, Look, TILE};

/// What a glass control is at rest and how pressing treats it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Kind {
    /// `.glass`: nothing at rest (round buttons, short pills).
    #[default]
    Hidden,
    /// `.glass--rest`: the uneven line at rest (secondary buttons, fields,
    /// Dock pills, toggles).
    Rest,
    /// `.glass--rest.glass--surface`: a card or a long pill that holds
    /// buttons. It flows under the pointer and never deepens when pressed.
    Surface,
    /// `.glass--rest.glass--still`: only read; the pointer leaves it as is.
    Still,
}

/// Behaviours on top of the kind.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Mode {
    /// `.glass--primary`: the selected rim at rest (in the accent).
    pub primary: bool,
    /// `.glass--waiting`: drifts on its own until the author decides; the
    /// pointer stills it.
    pub waiting: bool,
    /// `.glass--loading`: a shade deeper, drifting fast on its own.
    pub loading: bool,
    /// Disabled: a faint clear line, nothing answers.
    pub disabled: bool,
}

/// The four states a rim can be held in for a picture.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Held {
    Rest,
    Hover,
    Pressed,
    Selected,
}

impl Held {
    pub const ALL: [Held; 4] = [Held::Rest, Held::Hover, Held::Pressed, Held::Selected];
}

/// Where a rim is heading.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Target {
    pub opacity: f32,
    pub g: f32,
    pub sp: f32,
    /// Drift speed in px/s, 0 when still.
    pub flow: f32,
}

/// The rim's state over time.
#[derive(Clone, Copy, Debug)]
pub struct GlassState {
    pub kind: Kind,
    pub mode: Mode,
    pub hover: bool,
    pub pressed: bool,
    pub selected: bool,
    opacity: Tween,
    g: Tween,
    sp: Tween,
    flow_base: f32,
    flowing: Option<(Instant, f32)>,
    reduce: bool,
}

impl GlassState {
    pub fn new(kind: Kind, mode: Mode, selected: bool) -> GlassState {
        let mut state = GlassState {
            kind,
            mode,
            hover: false,
            pressed: false,
            selected,
            opacity: Tween::still(0.0),
            g: Tween::still(1.0),
            sp: Tween::still(1.0),
            flow_base: 0.0,
            flowing: None,
            reduce: false,
        };
        state.jump();
        state
    }

    /// A rim held in one state, still, with its texture `flow` px along:
    /// the gallery's side-by-side strip and offscreen captures.
    pub fn held(kind: Kind, mode: Mode, held: Held, flow: f32) -> GlassState {
        let mut state = GlassState::new(kind, mode, false);
        match held {
            Held::Rest => {}
            Held::Hover => state.hover = true,
            Held::Pressed => state.pressed = true,
            Held::Selected => state.selected = true,
        }
        state.jump();
        state.flowing = None;
        state.flow_base = flow;
        state
    }

    /// Lands every value on the target at once (first paint, reduced motion).
    pub fn jump(&mut self) {
        let t = self.target();
        self.opacity.set(t.opacity);
        self.g.set(t.g);
        self.sp.set(t.sp);
        self.set_flow(t.flow, anim::now());
    }

    pub fn target(&self) -> Target {
        let still = |opacity: f32, g: f32, sp: f32| Target {
            opacity,
            g,
            sp,
            flow: 0.0,
        };
        let drift = FLOW_PX_PER_S;
        if self.mode.disabled {
            return match self.kind {
                Kind::Hidden if !self.mode.primary => still(0.0, 1.0, 1.0),
                _ => still(1.0, 0.6, 0.0),
            };
        }
        if self.mode.loading {
            let lap = motion::glass::LOADING_LAP.as_secs_f32();
            return Target {
                opacity: 1.0,
                g: 1.15,
                sp: 1.1,
                flow: TILE / lap,
            };
        }
        let rest = match self.kind {
            Kind::Hidden => still(0.0, 1.0, 1.0),
            _ => still(1.0, 0.85, 0.0),
        };
        if self.pressed && self.kind != Kind::Still {
            if self.kind == Kind::Surface {
                return Target {
                    flow: drift,
                    ..still(1.0, 1.0, 1.0)
                };
            }
            return still(1.0, 1.7, 1.3);
        }
        if self.mode.waiting {
            return Target {
                flow: if self.hover { 0.0 } else { drift },
                ..still(1.0, 1.0, 1.0)
            };
        }
        if self.selected || self.mode.primary {
            return Target {
                flow: if self.mode.primary && self.hover {
                    drift
                } else {
                    0.0
                },
                ..still(1.0, 1.0, 1.0)
            };
        }
        if self.hover && self.kind != Kind::Still {
            return Target {
                flow: drift,
                ..still(1.0, 1.0, 1.0)
            };
        }
        rest
    }

    fn set_flow(&mut self, speed: f32, at: Instant) {
        match (self.flowing, speed > 0.0) {
            (Some((_, old)), true) if old == speed => {}
            (_, true) => {
                self.flow_base = self.flow(at);
                self.flowing = Some((at, speed));
            }
            (Some(_), false) => {
                self.flow_base = self.flow(at);
                self.flowing = None;
            }
            (None, false) => {}
        }
    }

    /// How far the texture has drifted, px along the diagonal.
    pub fn flow(&self, at: Instant) -> f32 {
        match self.flowing {
            Some((since, speed)) => {
                self.flow_base + at.saturating_duration_since(since).as_secs_f32() * speed
            }
            None => self.flow_base,
        }
    }

    /// Heads for the current target, timing each change as the renderer does.
    pub fn retarget(&mut self, at: Instant) {
        let t = self.target();
        let reduce = self.reduce;
        let d = |d: Duration| if reduce { Duration::ZERO } else { d };
        let pressing = t.g > self.g.to + 0.01 && self.pressed;
        let shadow = if pressing {
            motion::glass::PRESS
        } else if t.g < self.g.value(at) - 0.01 || self.selected {
            motion::glass::SETTLE
        } else {
            motion::glass::BLEED
        };
        self.opacity
            .retarget(t.opacity, at, d(motion::glass::BLEED), Easing::EASE_OUT);
        self.g.retarget(t.g, at, d(shadow), Easing::EASE_OUT);
        self.sp.retarget(t.sp, at, d(shadow), Easing::EASE_OUT);
        self.set_flow(if reduce { 0.0 } else { t.flow }, at);
    }

    pub fn set_reduce_motion(&mut self, reduce: bool) {
        self.reduce = reduce;
    }

    pub fn set_hover(&mut self, hover: bool) -> bool {
        self.change(|s| s.hover = hover)
    }

    pub fn set_pressed(&mut self, pressed: bool) -> bool {
        self.change(|s| s.pressed = pressed)
    }

    pub fn set_selected(&mut self, selected: bool) -> bool {
        self.change(|s| s.selected = selected)
    }

    pub fn set_mode(&mut self, mode: Mode) -> bool {
        self.change(|s| s.mode = mode)
    }

    pub fn set_kind(&mut self, kind: Kind) -> bool {
        self.change(|s| s.kind = kind)
    }

    fn change(&mut self, f: impl FnOnce(&mut GlassState)) -> bool {
        let before = (
            self.kind,
            self.mode,
            self.hover,
            self.pressed,
            self.selected,
        );
        f(self);
        let changed = before
            != (
                self.kind,
                self.mode,
                self.hover,
                self.pressed,
                self.selected,
            );
        if changed {
            self.retarget(anim::now());
        }
        changed
    }

    /// True while a transition (not just the drift) is under way at `at`.
    pub fn changing(&self, at: Instant) -> bool {
        !self.opacity.settled(at) || !self.g.settled(at) || !self.sp.settled(at)
    }

    /// The drift's speed now, px/s (0 when still).
    pub fn drift_speed(&self) -> f32 {
        self.flowing.map_or(0.0, |(_, speed)| speed)
    }

    /// True while anything about the rim still changes at `at`.
    pub fn moving(&self, at: Instant) -> bool {
        self.flowing.is_some()
            || !self.opacity.settled(at)
            || !self.g.settled(at)
            || !self.sp.settled(at)
    }

    /// The rim at `at`, in `color` read from `origin` on the texture.
    pub fn look(&self, at: Instant, color: crate::tokens::Rgb, origin: (f32, f32)) -> Look {
        Look {
            opacity: self.opacity.value(at),
            g: self.g.value(at),
            sp: self.sp.value(at),
            flow: self.flow(at),
            rim: crate::tokens::glass::RIM,
            origin,
            color,
            bleed_lift: 0.0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn later(at: Instant, ms: u64) -> Instant {
        at + Duration::from_millis(ms)
    }

    #[test]
    fn resting_line_is_faint_and_has_no_bleed() {
        let s = GlassState::new(Kind::Rest, Mode::default(), false);
        let t = s.target();
        assert_eq!((t.opacity, t.g, t.sp, t.flow), (1.0, 0.85, 0.0, 0.0));
        let h = GlassState::new(Kind::Hidden, Mode::default(), false);
        assert_eq!(h.target().opacity, 0.0);
    }

    #[test]
    fn a_press_takes_hold_in_forty_milliseconds_and_stops_the_drift() {
        let t0 = anim::now();
        let mut s = GlassState::new(Kind::Rest, Mode::default(), false);
        s.hover = true;
        s.retarget(t0);
        let flowed = s.flow(later(t0, 500));
        assert!(flowed > 4.0, "{flowed}");
        s.pressed = true;
        s.retarget(later(t0, 500));
        let held = s.look(later(t0, 545), crate::tokens::Rgb::WHITE, (0.0, 0.0));
        assert!(held.g > 1.69, "{}", held.g);
        assert!((s.flow(later(t0, 900)) - flowed).abs() < 0.01);
        // Let go and leave: back to the line, the drift paused where it was.
        s.pressed = false;
        s.hover = false;
        s.retarget(later(t0, 900));
        let rest = s.look(later(t0, 1300), crate::tokens::Rgb::WHITE, (0.0, 0.0));
        assert!((rest.g - 0.85).abs() < 0.01 && rest.sp.abs() < 0.01);
        assert!((rest.flow - flowed).abs() < 0.01);
        assert!(!s.moving(later(t0, 1300)));
    }

    #[test]
    fn selected_glass_is_still_even_under_the_pointer() {
        let mut s = GlassState::new(Kind::Rest, Mode::default(), true);
        s.hover = true;
        let t = s.target();
        assert_eq!((t.g, t.sp, t.flow), (1.0, 1.0, 0.0));
        // Pressing wins over selected.
        s.pressed = true;
        assert_eq!(s.target().g, 1.7);
    }

    #[test]
    fn a_surface_keeps_flowing_when_pressed() {
        let mut s = GlassState::new(Kind::Surface, Mode::default(), false);
        s.pressed = true;
        let t = s.target();
        assert_eq!(t.g, 1.0);
        assert!(t.flow > 0.0);
    }

    #[test]
    fn waiting_glass_drifts_until_the_pointer_stills_it() {
        let mode = Mode {
            waiting: true,
            ..Mode::default()
        };
        let mut s = GlassState::new(Kind::Rest, mode, false);
        assert!(s.target().flow > 0.0);
        s.hover = true;
        assert_eq!(s.target().flow, 0.0);
    }

    #[test]
    fn still_glass_ignores_the_pointer() {
        let mut s = GlassState::new(Kind::Still, Mode::default(), false);
        s.hover = true;
        s.pressed = true;
        let t = s.target();
        assert_eq!((t.g, t.sp, t.flow), (0.85, 0.0, 0.0));
    }
}
