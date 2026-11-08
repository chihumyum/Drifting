//! The sea of one window: who holds it, the water, the rain, the word, the
//! characters and the glass lying on it (the 0.1 client's
//! `lib/char-sea/char-sea.ts` controller, `char-sea-registry.ts` and the
//! mode logic of `components/char-sea/CharSea.tsx`).
//!
//! - **Holds.** A full-window wait holds it as *loading* (past 240 ms the
//!   rain falls and 「Loading」 rises), a first run as *title* (the app's
//!   name rises at once), a page lying on it as a *surface* (it stays on,
//!   still until touched), a page waiting on the author as *rain* (rain
//!   round the page, no word). A [`Hold`] lets go when dropped. A page
//!   handing the sea to the next (the bookshelf to the wait for the book it
//!   opened) lets go and takes hold within [`HANDOVER`], and the water is
//!   not disturbed.
//! - **Modes.** Live while anything holds it; when the last hold goes it
//!   *ebbs*: no new rings, the resting dots fade, the rings already out run
//!   their course, then it is off and computes nothing.
//! - **The hand.** [`Sea::press`] drops one ring; moving the pointer leaves a
//!   light wake (the element listens for that itself).
//! - **Glass on the sea.** Elements wrapped in [`crate::on_sea`] report where
//!   they are each frame; the sea veils itself under them (12% shows), draws
//!   their resting line, and lets a crest thicken it and bleed inward.

use std::{
    cell::RefCell,
    collections::HashMap,
    rc::Rc,
    sync::Arc,
    time::{Duration, Instant},
};

use dr_i18n::Locale;
use gpui::{App, Bounds, Global, Pixels, RenderImage, Window, WindowId};

use crate::model::{
    Glyphs, Layout, Rain, Rand, STEP_RATE, WATER_CELL, Water, cells_covered, layout,
};
use crate::text::{Passage, passage};

/// A page handing the sea to the next lets go and takes hold within this.
pub const HANDOVER: Duration = Duration::from_millis(80);
/// A wait shorter than this shows nothing (`--motion-loading-delay`).
pub const LOADING_DELAY: Duration = dr_ui::tokens::motion::dwell::LOADING_DELAY;
/// The longest an ebb lasts; a single press is still water in about five
/// seconds. A hidden window draws no frames, so its water never stills:
/// it is put away anyway.
pub const EBB_LIMIT: Duration = Duration::from_millis(8000);

/// The word a first run raises, in the loading word's face and size.
pub const TITLE: &str = "Drifting";
const LOADING_WORD: &str = "Loading";

pub(crate) const DROP_RADIUS: f32 = 2.2;
// The word: an old serif (the system's Times New Roman, or its metric twin
// Tinos), about 30% of the window's height and at most 70% of its width.
// It rises to WORD_HEIGHT over WORD_RISE seconds and breathes ±WORD_SWELL
// every WORD_BREATH seconds. Let go, its silhouette is raised WORD_BURST
// times over and leaves as one ring from its outline.
pub(crate) const WORD_FONT: &str = "Times New Roman";
const WORD_FAMILIES: &str = "Times New Roman, Tinos, Times, serif";
const WORD_HEIGHT: f32 = 0.45;
const WORD_RISE: f32 = 0.7;
const WORD_BREATH: f32 = 2.6;
const WORD_SWELL: f32 = 0.12;
const WORD_BURST: f32 = 4.0;
/// A resting line that comes or goes eases to its strength at this rate a
/// second: two thirds of the way in a third of a second, settled in about
/// one.
const REST_EASE: f32 = 3.0;
/// At most this many pieces of glass are drawn on the sea.
pub const MAX_SHAPES: usize = 16;

/// What a page holds the sea as.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum HoldKind {
    /// A full-window wait: past [`LOADING_DELAY`] the rain falls and
    /// 「Loading」 rises until it ends.
    Loading,
    /// A first run: the app's name rises at once.
    Title,
    /// A page waiting on the author (the first-run card): the rain falls
    /// round it, no word.
    Rain,
    /// A page lying on the sea (the bookshelf): on, still until touched.
    Surface,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Holds {
    loading: u32,
    title: u32,
    rain: u32,
    surface: u32,
}

impl Holds {
    fn slot(&mut self, kind: HoldKind) -> &mut u32 {
        match kind {
            HoldKind::Loading => &mut self.loading,
            HoldKind::Title => &mut self.title,
            HoldKind::Rain => &mut self.rain,
            HoldKind::Surface => &mut self.surface,
        }
    }

    fn any(&self) -> bool {
        self.loading + self.title + self.rain + self.surface > 0
    }
}

/// Live: a page lies on the sea or a wait holds it. Ebb: the last hold let
/// go; the rings already out run their course, untouchable, then it goes
/// off. Off: computing nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Off,
    Live,
    Ebb,
}

/// The word standing on the water.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Word {
    None,
    Loading,
    Title,
}

/// A piece of glass lying on the sea this frame ([`crate::on_sea`]).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Shape {
    pub id: u64,
    /// In window coordinates.
    pub bounds: Bounds<Pixels>,
    pub radius: f32,
    /// Strength of the resting line: the app's resting glass is 0.85; 0
    /// shows only what the water brings; below 0 no line at all, only the
    /// veil.
    pub rest: f32,
    /// The pointer is on it: its bleed comes in, its unevenness drifts.
    pub hover: bool,
    /// Set down on the sea: its resting line starts from nothing.
    pub arrive: bool,
    /// Waiting on the author (the sample until it is opened): its rim flows
    /// as under the pointer.
    pub waiting: bool,
}

/// One shaped character, ready for `paint_glyph`.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Glyph {
    pub font: gpui::FontId,
    pub id: gpui::GlyphId,
    pub advance: f32,
    pub ascent: f32,
    pub descent: f32,
}

/// The word's motion: `held` while the spring holds it up; `time` since it
/// began to rise; `shown` is the height the painter takes as the word's own
/// (its slope moves no glyph), which eases away once it is let go.
#[derive(Clone, Copy, Debug, Default)]
struct WordMotion {
    held: bool,
    time: f32,
    height: f32,
    shown: f32,
}

/// Who holds the sea, kept apart from the water so a [`Hold`] dropped while
/// the sea is being drawn still lets go.
#[derive(Debug, Default)]
pub(crate) struct HoldState {
    holds: Holds,
    /// When the last hold went (for the hand-over latch).
    let_go_at: Option<Instant>,
    loading_let_go_at: Option<Instant>,
    /// When the current run of loading holds began (hand-overs do not
    /// break it).
    loading_since: Option<Instant>,
}

impl HoldState {
    fn held(&self, now: Instant) -> bool {
        self.holds.any() || self.let_go_at.is_some_and(|at| now - at < HANDOVER)
    }

    fn loading_held(&self, now: Instant) -> bool {
        self.holds.loading > 0 || self.loading_let_go_at.is_some_and(|at| now - at < HANDOVER)
    }

    fn take(&mut self, kind: HoldKind, now: Instant) {
        if kind == HoldKind::Loading
            && self.holds.loading == 0
            && (self.loading_since.is_none()
                || self.loading_let_go_at.is_none_or(|at| now - at > HANDOVER))
        {
            self.loading_since = Some(now);
        }
        *self.holds.slot(kind) += 1;
    }

    fn give_back(&mut self, kind: HoldKind, now: Instant) {
        let slot = self.holds.slot(kind);
        *slot = slot.saturating_sub(1);
        if kind == HoldKind::Loading && self.holds.loading == 0 {
            self.loading_let_go_at = Some(now);
        }
        if !self.holds.any() {
            self.let_go_at = Some(now);
        }
    }

    /// Which word should stand now: the app's name while a first run holds
    /// it; 「Loading」 once a wait has lasted [`LOADING_DELAY`].
    fn wanted_word(&self, now: Instant) -> Word {
        if self.holds.title > 0 {
            Word::Title
        } else if self.loading_held(now)
            && self
                .loading_since
                .is_some_and(|since| now - since >= LOADING_DELAY)
        {
            Word::Loading
        } else {
            Word::None
        }
    }

    fn latched(&self, now: Instant) -> bool {
        let latch = |at: Option<Instant>| at.is_some_and(|at| now - at < HANDOVER);
        latch(self.let_go_at) || latch(self.loading_let_go_at)
    }
}

pub(crate) struct Inner {
    pub mode: Mode,
    ebb_since: Option<Instant>,
    applied_word: Word,
    applied_rain: bool,
    pub(crate) still: bool,

    // The sheet.
    pub(crate) size: (f32, f32),
    pub(crate) locale: Locale,
    pub(crate) passage: &'static Passage,
    pub(crate) water: Option<Water>,
    pub(crate) layout: Option<Layout>,
    pub(crate) rain: Option<Rain>,
    pub(crate) glyphs: Option<Glyphs>,
    rain_held: bool,
    word_text: &'static str,
    pub(crate) word_shape: Option<Vec<f32>>,
    word_cells: Option<Vec<u8>>,
    word: WordMotion,
    ebbing: bool,
    pub(crate) rest_scale: f32,
    last_move: Option<(f32, f32, Instant)>,
    pub(crate) running: bool,
    last: Option<Instant>,
    accumulated: f32,
    quiet_frames: u32,
    rand: Rand,

    // Glass.
    pub(crate) shapes: Vec<Shape>,
    pub(crate) next_shapes: Vec<Shape>,
    pub(crate) hover_amount: HashMap<u64, f32>,
    pub(crate) flow: HashMap<u64, f32>,
    pub(crate) rest_shown: HashMap<u64, f32>,

    // Paint caches.
    pub(crate) glyph_cache: HashMap<(u8, u8), Option<Glyph>>,
    pub(crate) dot_tile: Option<(DotKey, Arc<RenderImage>)>,
    pub(crate) stale_images: Vec<Arc<RenderImage>>,
    /// Characters drawn last frame, for measurement.
    pub(crate) drawn_cells: u32,
    /// The last frame's time moving the sea and drawing it, ms.
    pub(crate) times: (f32, f32),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct DotKey {
    pub dark: bool,
    pub scale: f32,
    pub cell: (f32, f32),
    pub rest: u16,
}

impl Inner {
    fn new() -> Inner {
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(7);
        Inner {
            mode: Mode::Off,
            ebb_since: None,
            applied_word: Word::None,
            applied_rain: false,
            still: false,
            size: (0.0, 0.0),
            locale: Locale::ZhCn,
            passage: passage(Locale::ZhCn),
            water: None,
            layout: None,
            rain: None,
            glyphs: None,
            rain_held: false,
            word_text: LOADING_WORD,
            word_shape: None,
            word_cells: None,
            word: WordMotion::default(),
            ebbing: false,
            rest_scale: 1.0,
            last_move: None,
            running: false,
            last: None,
            accumulated: 0.0,
            quiet_frames: 0,
            rand: Rand::new(seed),
            shapes: Vec::new(),
            next_shapes: Vec::new(),
            hover_amount: HashMap::new(),
            flow: HashMap::new(),
            rest_shown: HashMap::new(),
            glyph_cache: HashMap::new(),
            dot_tile: None,
            stale_images: Vec::new(),
            drawn_cells: 0,
            times: (0.0, 0.0),
        }
    }

    fn random(&mut self) -> Box<dyn FnMut() -> f32> {
        let seed = (self.rand.next() * 4_294_967_296.0) as u32;
        Rand::new(seed).boxed()
    }

    /// Whether something is waiting on time alone (a latch, the loading
    /// delay), so frames must keep coming even when the water is still.
    fn pending(&self, holds: &HoldState, now: Instant) -> bool {
        holds.latched(now)
            || (holds.holds.loading > 0 && self.applied_word != holds.wanted_word(now))
            || self.mode == Mode::Ebb
    }

    /// Brings the modes, the word and the rain in line with the holds, the
    /// sheet with the size and language. Called before every frame.
    pub(crate) fn sync(
        &mut self,
        holds: &HoldState,
        now: Instant,
        size: (f32, f32),
        locale: Locale,
        still: bool,
    ) {
        self.still = still;
        let held = holds.held(now);
        match (held, self.mode) {
            (true, Mode::Off) => {
                self.mode = Mode::Live;
                self.set_active(true, size, locale);
            }
            (true, Mode::Ebb) => {
                self.mode = Mode::Live;
                self.ebb_since = None;
                self.live();
            }
            (false, Mode::Live) => {
                self.mode = Mode::Ebb;
                self.ebb_since = Some(now);
                self.ebb();
            }
            (false, Mode::Ebb) => {
                let still_water = !self.running;
                if still_water || self.ebb_since.is_some_and(|at| now - at > EBB_LIMIT) {
                    self.mode = Mode::Off;
                    self.ebb_since = None;
                    self.set_active(false, size, locale);
                }
            }
            _ => {}
        }
        if self.mode == Mode::Off {
            return;
        }
        if size != self.size {
            self.measure(size);
        }
        if locale != self.locale {
            self.set_script(locale);
        }
        let word = holds.wanted_word(now);
        if word != self.applied_word {
            self.applied_word = word;
            match word {
                Word::None => self.loading(false, None),
                Word::Loading => self.loading(true, Some(LOADING_WORD)),
                Word::Title => self.loading(true, Some(TITLE)),
            }
        }
        let rain = holds.holds.rain > 0;
        if rain != self.applied_rain {
            self.applied_rain = rain;
            self.set_rain(rain);
        }
        // Glass seen this frame.
        self.shapes = std::mem::take(&mut self.next_shapes);
        self.shapes.truncate(MAX_SHAPES);
        if self.note_rests() || self.shapes.iter().any(|s| s.hover || s.waiting) {
            self.kick();
        }
    }

    /// Whether another frame is needed after this one.
    pub(crate) fn wants_frame(&self, holds: &HoldState, now: Instant) -> bool {
        (self.mode != Mode::Off || holds.held(now)) && (self.running || self.pending(holds, now))
    }

    // The sheet (char-sea.ts `measure`, `lay`, `shapeWord`, `setScript`).

    fn measure(&mut self, size: (f32, f32)) {
        self.size = (size.0.max(1.0), size.1.max(1.0));
        let mut water = Water::new(self.size.0, self.size.1);
        // The word's shape belongs to the old grid: it is made again for
        // this one when the painter next has a window.
        self.word_shape = None;
        self.word_cells = None;
        if self.word.held {
            // Held again once the new shape is made.
            water.set_hold_height(self.word.height);
        }
        self.water = Some(water);
        self.lay();
    }

    fn lay(&mut self) {
        let sheet = layout(self.size.0, self.size.1, &self.passage.language);
        let raining = self.rain.as_ref().is_some_and(Rain::raining);
        let mut rain = Rain::new(sheet.cols, sheet.rows, self.random());
        if raining {
            rain.start();
        }
        self.glyphs = Some(Glyphs::new(&sheet, self.random()));
        if let (Some(shape), Some(water)) = (&self.word_shape, &self.water) {
            self.word_cells = Some(cells_covered(&sheet, shape, water.cols, water.rows, 0.35));
        }
        self.rain = Some(rain);
        self.layout = Some(sheet);
        self.glyph_cache.clear();
        self.retire_dots();
    }

    fn set_script(&mut self, locale: Locale) {
        self.locale = locale;
        self.passage = passage(locale);
        if self.water.is_some() {
            self.lay();
        }
    }

    pub(crate) fn retire_dots(&mut self) {
        if let Some((_, image)) = self.dot_tile.take() {
            self.stale_images.push(image);
        }
    }

    /// The word wants a shape on the current water: true when the painter
    /// should make one ([`Inner::set_word_shape`]).
    pub(crate) fn needs_word_shape(&self) -> Option<&'static str> {
        (self.word.held && self.word_shape.is_none() && self.water.is_some())
            .then_some(self.word_text)
    }

    /// The word's ink on this water, for the spring, the painter and the
    /// cells whose characters change in it.
    pub(crate) fn set_word_shape(&mut self, shape: Vec<f32>) {
        let (Some(water), Some(sheet)) = (&mut self.water, &self.layout) else {
            return;
        };
        self.word_cells = Some(cells_covered(sheet, &shape, water.cols, water.rows, 0.35));
        if self.word.held {
            water.hold(Some(shape.clone()), 1.0);
            water.set_hold_height(self.word.height);
        }
        self.word_shape = Some(shape);
        self.kick();
    }

    // The controller (char-sea.ts).

    fn kick(&mut self) {
        if self.mode == Mode::Off || self.running {
            return;
        }
        self.running = true;
        self.quiet_frames = 0;
    }

    fn set_active(&mut self, active: bool, size: (f32, f32), locale: Locale) {
        if active {
            self.ebbing = false;
            self.rest_scale = 1.0;
            self.last = None;
            self.locale = locale;
            self.passage = passage(locale);
            self.measure(size);
            if self.rain_held
                && !self.still
                && let Some(rain) = &mut self.rain
            {
                rain.start();
            }
            self.kick();
        } else {
            self.let_loading_go();
            self.word.shown = 0.0;
            // Put away with nothing lit: the next wait's rain starts on a
            // dry sheet.
            if let Some(sheet) = &self.layout {
                let (cols, rows) = (sheet.cols, sheet.rows);
                self.rain = Some(Rain::new(cols, rows, self.random()));
            }
            if let Some(sheet) = self.layout.take() {
                self.glyphs = Some(Glyphs::new(&sheet, self.random()));
                self.layout = Some(sheet);
            }
            if let Some(water) = &mut self.water {
                water.clear();
            }
            self.running = false;
            self.applied_word = Word::None;
            self.applied_rain = false;
            self.rain_held = false;
        }
    }

    fn ebb(&mut self) {
        self.ebbing = true;
        if self.still {
            self.rest_scale = 0.0;
        }
        self.kick();
    }

    fn live(&mut self) {
        self.ebbing = false;
        if self.still {
            self.rest_scale = 1.0;
        }
        self.kick();
    }

    /// Something is loading: the rain falls and the word rises; `false`
    /// lets both go. A word already standing gives way to a new one, which
    /// rises in its place.
    fn loading(&mut self, on: bool, named: Option<&'static str>) {
        if !on {
            self.let_loading_go();
            self.kick();
            return;
        }
        if self.still || self.water.is_none() {
            return;
        }
        let next = named.unwrap_or(LOADING_WORD);
        if next != self.word_text {
            self.word_text = next;
            // The word standing lets go as the spring takes the new one.
            self.word_shape = None;
            self.word_cells = None;
            if self.word.held {
                self.word.time = 0.0;
            }
        }
        if let Some(rain) = &mut self.rain {
            rain.start();
        }
        if !self.word.held {
            self.word.held = true;
            self.word.time = 0.0;
            if let (Some(water), Some(shape)) = (&mut self.water, &self.word_shape) {
                water.hold(Some(shape.clone()), 1.0);
            }
        }
        self.kick();
    }

    fn set_rain(&mut self, on: bool) {
        self.rain_held = on;
        if !on {
            if !self.word.held
                && let Some(rain) = &mut self.rain
            {
                rain.stop();
            }
            self.kick();
            return;
        }
        if self.still {
            return;
        }
        if let Some(rain) = &mut self.rain {
            rain.start();
        }
        self.kick();
    }

    fn let_loading_go(&mut self) {
        if !self.rain_held
            && let Some(rain) = &mut self.rain
        {
            rain.stop();
        }
        if self.word.held
            && let Some(water) = &mut self.water
        {
            water.hold(None, WORD_BURST);
        }
        self.word.held = false;
    }

    /// One ring from (x, y), sea coordinates.
    pub(crate) fn drop_at(&mut self, x: f32, y: f32, amplitude: f32) {
        if self.still || self.ebbing || self.mode != Mode::Live {
            return;
        }
        if let Some(water) = &mut self.water {
            water.splash(x, y, amplitude, DROP_RADIUS);
            self.kick();
        }
    }

    /// The pointer moved: a light wake, stronger the faster it goes.
    pub(crate) fn wake(&mut self, x: f32, y: f32, now: Instant) {
        if self.still || self.ebbing || self.mode != Mode::Live {
            return;
        }
        let Some(water) = &mut self.water else {
            return;
        };
        if let Some((lx, ly, at)) = self.last_move {
            let ms = (now - at).as_secs_f32() * 1000.0;
            if ms < 100.0 {
                let (dx, dy) = (x - lx, y - ly);
                let distance = (dx * dx + dy * dy).sqrt();
                let speed = distance / ms.max(1.0) * 1000.0;
                let amplitude = (speed * 0.00006).min(0.09);
                if amplitude > 0.006 {
                    let steps = (distance / WATER_CELL).ceil().max(1.0) as usize;
                    for i in 1..=steps {
                        let t = i as f32 / steps as f32;
                        water.splash(
                            lx + dx * t,
                            ly + dy * t,
                            amplitude / (steps as f32).sqrt(),
                            1.3,
                        );
                    }
                    self.kick();
                }
            }
        }
        self.last_move = Some((x, y, now));
    }

    /// Glass eases toward its state: the bleed comes in over about 0.24 s,
    /// a hovered rim's unevenness drifts 10 px a second (one 150 px lap in
    /// 15 s), and a resting line that comes or goes settles in about a
    /// second.
    fn ease_glass(&mut self, dt: f32) -> bool {
        let mut moving = false;
        let k = 1.0 - (-dt * 12.0).exp();
        let k_rest = 1.0 - (-dt * REST_EASE).exp();
        for shape in &self.shapes {
            let target = if shape.hover || shape.waiting {
                1.0
            } else {
                0.0
            };
            let amount = self.hover_amount.get(&shape.id).copied().unwrap_or(0.0);
            let next = amount + (target - amount) * k;
            self.hover_amount.insert(shape.id, next);
            if next > 0.001 {
                *self.flow.entry(shape.id).or_insert(0.0) += dt * 10.0 * next;
            }
            if target > 0.0 || (target - next).abs() > 0.01 {
                moving = true;
            }
            let rest = self
                .rest_shown
                .get(&shape.id)
                .copied()
                .unwrap_or(shape.rest);
            if rest != shape.rest {
                let eased = rest + (shape.rest - rest) * k_rest;
                let settled = if (shape.rest - eased).abs() < 0.005 {
                    shape.rest
                } else {
                    eased
                };
                self.rest_shown.insert(shape.id, settled);
                moving = true;
            }
        }
        moving
    }

    /// A shape seen for the first time draws its line at once, unless it
    /// arrives, when the line starts from nothing; shapes gone are
    /// forgotten.
    fn note_rests(&mut self) -> bool {
        let mut easing = false;
        for shape in &self.shapes {
            if self.still {
                self.rest_shown.insert(shape.id, shape.rest);
            } else {
                self.rest_shown.entry(shape.id).or_insert(if shape.arrive {
                    0.0
                } else {
                    shape.rest
                });
            }
            if self.rest_shown.get(&shape.id) != Some(&shape.rest) {
                easing = true;
            }
        }
        let present: Vec<u64> = self.shapes.iter().map(|s| s.id).collect();
        self.rest_shown.retain(|id, _| present.contains(id));
        self.hover_amount.retain(|id, _| present.contains(id));
        self.flow.retain(|id, _| present.contains(id));
        easing
    }

    /// The word rises and breathes while held, and its own height eases
    /// away once let go; the rain falls and breaks where the water knocks
    /// it. Returns whether either is still moving.
    fn move_loading(&mut self, dt: f32) -> bool {
        let (Some(water), Some(sheet)) = (&mut self.water, &self.layout) else {
            return false;
        };
        if self.word.held {
            self.word.time += dt;
            let rise = 1.0 - (1.0 - (self.word.time / WORD_RISE).min(1.0)).powi(3);
            self.word.height = WORD_HEIGHT
                * rise
                * (1.0 + WORD_SWELL * (std::f32::consts::TAU * self.word.time / WORD_BREATH).sin());
            self.word.shown = self.word.height;
            water.set_hold_height(self.word.height);
        } else if self.word.shown > 0.0 {
            self.word.shown *= (-dt / 0.15).exp();
            if self.word.shown < 0.002 {
                self.word.shown = 0.0;
            }
        }
        let mut raining = false;
        if let Some(rain) = &mut self.rain {
            let (ox, oy, cw, ch) = (
                sheet.origin_x,
                sheet.origin_y,
                sheet.cell_width,
                sheet.cell_height,
            );
            let sea: &Water = water;
            raining = rain.tick(dt, |col, row| {
                sea.off_rest(ox + (col as f32 + 0.5) * cw, oy + row * ch)
            });
        }
        let mut changing = false;
        if let Some(glyphs) = &mut self.glyphs {
            let word = if self.word.shown > 0.05 {
                self.word_cells.as_deref()
            } else {
                None
            };
            let swap = glyphs.tick(dt, self.rain.as_ref().map(|r| r.cells.as_slice()), word);
            changing = swap.changing;
        }
        self.word.held || self.word.shown > 0.0 || raining || changing
    }

    /// Moves the sea on to `now`.
    pub(crate) fn advance(&mut self, now: Instant) {
        if !self.running {
            return;
        }
        let dt = self
            .last
            .map_or(1.0 / 60.0, |last| (now - last).as_secs_f32())
            .min(0.05);
        self.last = Some(now);
        self.step(dt);
    }

    /// One frame of `dt` seconds (also what tests and captures run).
    pub(crate) fn step(&mut self, dt: f32) {
        if self.water.is_none() {
            return;
        }
        let loading_moving = self.move_loading(dt);
        let glass_moving = self.ease_glass(dt);
        // The resting dots come and go over about 0.3 s.
        let rest_target = if self.ebbing { 0.0 } else { 1.0 };
        let before = self.rest_scale;
        self.rest_scale += (rest_target - self.rest_scale) * (1.0 - (-dt * 10.0).exp());
        if (rest_target - self.rest_scale).abs() < 0.005 {
            self.rest_scale = rest_target;
        }
        let rest_moving = self.rest_scale != rest_target;
        if (before * 32.0).round() != (self.rest_scale * 32.0).round() {
            self.retire_dots();
        }
        self.accumulated += dt;
        let steps = ((self.accumulated * STEP_RATE).floor() as u32).min(6);
        self.accumulated -= steps as f32 / STEP_RATE;
        let mut peak = 0.0f32;
        if let Some(water) = &mut self.water {
            for _ in 0..steps {
                peak = peak.max(water.step());
            }
        }
        // Still water and still glass: one last frame, then nothing until
        // something touches it. Above 100 Hz a frame can fall between two
        // steps; it neither moves the water nor settles it.
        if glass_moving || rest_moving || loading_moving {
            self.quiet_frames = 0;
        } else if steps > 0 {
            self.quiet_frames = if peak < 0.004 {
                self.quiet_frames + 1
            } else {
                0
            };
        }
        if self.quiet_frames > 20 {
            if let Some(water) = &mut self.water {
                water.clear();
            }
            if let (Some(glyphs), true) = (&mut self.glyphs, true) {
                glyphs.live.copy_from_slice(&glyphs.own);
            }
            self.running = false;
            self.last = None;
            self.accumulated = 0.0;
        }
    }

    /// The water's height and the word's own at (x, y), sea coordinates.
    pub(crate) fn word_shown(&self) -> f32 {
        self.word.shown
    }
}

pub(crate) struct Shared {
    pub holds: RefCell<HoldState>,
    pub inner: RefCell<Inner>,
}

impl Shared {
    fn new() -> Rc<Shared> {
        Rc::new(Shared {
            holds: RefCell::new(HoldState::default()),
            inner: RefCell::new(Inner::new()),
        })
    }
}

/// The sea under one window. Cheap to clone; every clone is the same sea.
#[derive(Clone)]
pub struct Sea(pub(crate) Rc<Shared>);

#[derive(Default)]
struct Seas(HashMap<WindowId, Sea>);

impl Global for Seas {}

impl Sea {
    /// The sea under `window` (made the first time it is asked for).
    pub fn of(window: &Window, cx: &mut App) -> Sea {
        let id = window.window_handle().window_id();
        cx.default_global::<Seas>()
            .0
            .entry(id)
            .or_insert_with(|| Sea(Shared::new()))
            .clone()
    }

    /// A sea not tied to a window, for tests.
    pub fn detached() -> Sea {
        Sea(Shared::new())
    }

    /// Holds the sea on as `kind` until the [`Hold`] is dropped.
    pub fn hold(&self, kind: HoldKind, window: &mut Window) -> Hold {
        self.0.holds.borrow_mut().take(kind, dr_ui::anim::now());
        window.refresh();
        Hold {
            sea: Rc::downgrade(&self.0),
            kind,
        }
    }

    /// One ring from `at` (window coordinates; the sea lies under the whole
    /// window), as a press makes: 1.2 on the bare desk, 1.3 on a book.
    /// Only a live sea takes it.
    pub fn press(&self, at: gpui::Point<Pixels>, amplitude: f32, window: &mut Window) {
        self.0
            .inner
            .borrow_mut()
            .drop_at(f32::from(at.x), f32::from(at.y), amplitude);
        window.refresh();
    }

    /// Off, live or ebbing.
    pub fn mode(&self) -> Mode {
        self.0.inner.borrow().mode
    }

    /// Whether the sea lies under the window now (a page lying on it should
    /// leave its own ground clear).
    pub fn is_on(&self) -> bool {
        self.mode() != Mode::Off
    }

    /// Whether the water or anything on it is moving.
    pub fn is_moving(&self) -> bool {
        self.0.inner.borrow().running
    }

    /// The word standing on the water (「Loading」 or the app's name), once
    /// the spring holds it.
    pub fn word(&self) -> Option<&'static str> {
        let inner = self.0.inner.borrow();
        (inner.word.held && inner.word_shape.is_some()).then_some(inner.word_text)
    }

    /// How many characters the last frame drew over their dots.
    pub fn drawn_characters(&self) -> u32 {
        self.0.inner.borrow().drawn_cells
    }

    /// The last frame's time moving the sea (water, rain, characters) and
    /// drawing it (dots, characters, glass), ms.
    pub fn frame_times(&self) -> (f32, f32) {
        self.0.inner.borrow().times
    }

    /// How many pieces of glass lay on the sea last frame.
    pub fn glass_count(&self) -> usize {
        self.0.inner.borrow().shapes.len()
    }

    /// Runs the sea `seconds` forward in steps of 1/60 s without drawing
    /// (tests and captures; the clock frozen by `dr_ui::anim::freeze`).
    pub fn run_for(&self, seconds: f32) {
        let mut inner = self.0.inner.borrow_mut();
        let frames = (seconds * 60.0).round() as usize;
        for _ in 0..frames {
            if !inner.running {
                break;
            }
            inner.step(1.0 / 60.0);
        }
    }
}

/// A page holding the sea; dropping it lets go.
pub struct Hold {
    sea: std::rc::Weak<Shared>,
    kind: HoldKind,
}

impl Hold {
    pub fn kind(&self) -> HoldKind {
        self.kind
    }
}

impl Drop for Hold {
    fn drop(&mut self) {
        if let Some(sea) = self.sea.upgrade() {
            sea.holds
                .borrow_mut()
                .give_back(self.kind, dr_ui::anim::now());
        }
    }
}

impl std::fmt::Debug for Hold {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Hold").field("kind", &self.kind).finish()
    }
}

/// The word's families, for the SVG the painter rasterizes.
pub(crate) fn word_families() -> &'static str {
    WORD_FAMILIES
}
