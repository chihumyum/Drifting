//! The paint layers' state inside the editor: every chapter's decorations
//! (kept in step with the edits), their transitions, what the pointer is on,
//! block styles, immersive writing's paragraph focus, and the host's
//! methods on [`ProseEditor`].
//!
//! Hooks into the shared `editor.rs` (one line each): the `paint` field, the
//! [`PaintState::follow`] call for every applied change set in
//! `sync_chapter`, and the scrollbar ticks in `render`.

use std::{
    cell::RefCell,
    collections::HashSet,
    ops::Range,
    rc::Rc,
    time::{Duration, Instant},
};

use gpui::{App, Context, EventEmitter, Hsla, Pixels, Point, SharedString, Task};

use super::{
    blocks::{BlockLook, BlockStyle, ListItem, ListMark, linked_todo, list_item},
    decor::{Brush, Decoration, DecorationEvent, DecorationKey, Emphasis, Look, Strength, Touch},
    motion::{self, Level},
    sand::{self, SandTexture},
};
use crate::{
    ProseEditor,
    text::{ChangeSet, TextOp},
};

impl EventEmitter<DecorationEvent> for ProseEditor {}

/// Text outside the caret's paragraph in immersive writing: the ink at this
/// share of its strength (`hsl(var(--ink-1) / 0.26)`).
pub const FOCUS_DIM: f32 = 0.26;

/// A decoration as the editor keeps it.
pub(crate) struct Live {
    pub key: DecorationKey,
    pub deco: Decoration,
    /// 0 → 1 arriving, → 0 leaving.
    pub presence: Level,
    pub leaving: bool,
    /// 0 at rest, 1 hot.
    pub heat: Level,
    /// When its stroke started being drawn along its rows.
    pub draw: Option<Instant>,
    /// The `Drawn` number last seen, and whether the editor settled it.
    pub drawn: Option<u64>,
    pub settled: bool,
    pub pointed: bool,
    pub seed: u32,
}

impl Live {
    fn wants_heat(&self) -> bool {
        self.pointed
            || matches!(self.deco.emphasis, Emphasis::Hot)
            || (matches!(self.deco.emphasis, Emphasis::Drawn(_)) && !self.settled)
    }

    fn retarget_heat(&mut self, now: Instant, reduce: bool) {
        let to = if self.wants_heat() { 1. } else { 0. };
        self.heat.retarget(to, now, dur(motion::SHIFT, reduce));
    }

    /// Fading or changing strength (a stroke being drawn says so through
    /// its paragraph's `drawn`).
    pub(crate) fn moving(&self, now: Instant) -> bool {
        !self.presence.settled(now) || !self.heat.settled(now)
    }

    fn gone(&self, now: Instant) -> bool {
        self.leaving && self.presence.settled(now)
    }
}

/// One chapter's decorations, sorted by range start.
#[derive(Default)]
pub(crate) struct ChapterLayer {
    pub live: Vec<Live>,
    /// The longest range, bounding the search for a paragraph's decorations.
    pub max_len: usize,
    /// Touched ([`Touch::Fade`]) decorations not to show again until their
    /// group is submitted without them (the host has caught up).
    dismissed: HashSet<DecorationKey>,
}

impl ChapterLayer {
    fn reindex(&mut self) {
        self.live
            .sort_by_key(|live| (live.deco.range.start, live.deco.range.end));
        self.max_len = self
            .live
            .iter()
            .map(|live| live.deco.range.len())
            .max()
            .unwrap_or(0);
    }

    /// Decorations touching `start..end` (scalar offsets of the chapter).
    pub(crate) fn overlapping(&self, start: usize, end: usize) -> impl Iterator<Item = &Live> {
        let hi = self.live.partition_point(|l| l.deco.range.start < end);
        let reach = start.saturating_sub(self.max_len);
        let lo = self.live[..hi].partition_point(|l| l.deco.range.start < reach);
        self.live[lo..hi]
            .iter()
            .filter(move |l| l.deco.range.end > start && !l.deco.range.is_empty())
    }
}

/// Immersive writing's paragraph focus.
pub(crate) struct Focus {
    pub on: Level,
    pub current: Option<(usize, usize)>,
    pub previous: Option<(usize, usize)>,
    pub moved: Level,
}

impl Focus {
    fn new(now: Instant) -> Focus {
        Focus {
            on: Level::still(0., now),
            current: None,
            previous: None,
            moved: Level::still(1., now),
        }
    }

    /// The share of its ink a paragraph keeps.
    pub(crate) fn alpha(&self, at: (usize, usize), now: Instant) -> f32 {
        let on = self.on.value(now);
        if on <= 0. {
            return 1.;
        }
        let moved = self.moved.value(now);
        let weight = if self.current == Some(at) {
            moved
        } else if self.previous == Some(at) {
            1. - moved
        } else {
            0.
        };
        let a = FOCUS_DIM + (1. - FOCUS_DIM) * weight;
        1. - on * (1. - a)
    }

    pub(crate) fn moving(&self, now: Instant) -> bool {
        !self.on.settled(now) || (self.on.target() > 0. && !self.moved.settled(now))
    }
}

/// What the painted paragraphs share with the editor: where the pointer was,
/// and what it touched or rests on, gathered during paint and mouse events
/// and applied in the next update.
#[derive(Default)]
pub(crate) struct Shared {
    /// Frames painted.
    pub frame: u64,
    /// Each paragraph's pointer position (relative to its text origin) in
    /// the frame it was last painted: (frame, rev, point).
    pub last_local: std::collections::HashMap<(usize, usize), (u64, u64, Point<Pixels>)>,
    /// The pointer is over the window (a move came since it last left).
    pub pointer_in: bool,
    /// The pointer at the last mouse move, and the one before.
    pub pointer: Option<Point<Pixels>>,
    pub pointer_prev: Option<Point<Pixels>>,
    /// Point-decorations under the pointer for the mouse move being
    /// dispatched.
    pub hits: Vec<(usize, DecorationKey, Duration)>,
    /// A mouse move was dispatched since the last update (so `hits` says
    /// where the pointer rests).
    pub moved: bool,
    /// Fade-decorations the pointer touched.
    pub touched: Vec<(usize, DecorationKey)>,
    /// A deferred update is on its way.
    pub scheduled: bool,
}

/// The paint layers' state: a field of [`ProseEditor`].
pub struct PaintState {
    pub(crate) chapters: Vec<ChapterLayer>,
    pub(crate) block_style: BlockStyle,
    pub(crate) seals: Vec<Rc<SandTexture>>,
    pub(crate) reduce_motion: bool,
    pub(crate) focus: Focus,
    pub(crate) shared: Rc<RefCell<Shared>>,
    pub(crate) pending: Vec<DecorationEvent>,
    /// The decorations the pointer rests on (committed), and the ones it
    /// is waiting on.
    pub(crate) pointed: Vec<(usize, DecorationKey)>,
    candidate: Option<Vec<(usize, DecorationKey)>>,
    point_task: Option<Task<()>>,
    /// Bumped whenever a decoration is added or removed, or paragraphs
    /// come or go under them (what the scrollbar ticks are cached by).
    pub(crate) version: u64,
    pub(crate) hover_tick: Option<(usize, DecorationKey)>,
    pub(crate) ticks: super::ticks::TickCache,
    /// The visible paragraphs need another frame (a transition is running).
    pub(crate) animating: bool,
    /// A drawn decoration waits to be settled.
    waiting_drawn: bool,
    /// How find hits look (F4c's matches; the current one takes `hot`).
    pub(crate) find_look: Option<super::decor::Wash>,
}

impl Default for PaintState {
    fn default() -> Self {
        PaintState {
            chapters: Vec::new(),
            block_style: BlockStyle::default(),
            seals: Vec::new(),
            reduce_motion: false,
            focus: Focus::new(Instant::now()),
            shared: Rc::default(),
            pending: Vec::new(),
            pointed: Vec::new(),
            candidate: None,
            point_task: None,
            version: 0,
            hover_tick: None,
            ticks: Default::default(),
            animating: false,
            waiting_drawn: false,
            find_look: None,
        }
    }
}

fn dur(d: Duration, reduce: bool) -> Duration {
    if reduce { Duration::ZERO } else { d }
}

/// Where the first character of a range goes over `op`: text inserted right
/// at it stays outside, and so does text replacing it.
fn start_over(op: &TextOp, s: usize) -> usize {
    if s < op.pos {
        s
    } else if s < op.pos + op.deleted {
        op.pos + op.inserted
    } else {
        s - op.deleted + op.inserted
    }
}

/// Where the (exclusive) end of a range goes over `op`: text inserted right
/// at it stays outside.
fn end_over(op: &TextOp, e: usize) -> usize {
    if e <= op.pos {
        e
    } else if e <= op.pos + op.deleted {
        op.pos
    } else {
        e - op.deleted + op.inserted
    }
}

/// Moves `range` over `op` (a range whose words are deleted collapses).
pub fn range_over(op: &TextOp, range: Range<usize>) -> Range<usize> {
    let start = start_over(op, range.start);
    let end = end_over(op, range.end).max(start);
    start..end
}

impl PaintState {
    fn layer(&mut self, chapter: usize) -> &mut ChapterLayer {
        if self.chapters.len() <= chapter {
            self.chapters
                .resize_with(chapter + 1, ChapterLayer::default);
        }
        &mut self.chapters[chapter]
    }

    pub(crate) fn layer_ref(&self, chapter: usize) -> Option<&ChapterLayer> {
        self.chapters.get(chapter).filter(|l| !l.live.is_empty())
    }

    /// Moves a chapter's decorations over one applied change set. Called by
    /// `sync_chapter` for every change: the author's typing (`own`), undo,
    /// other devices and the Agent alike. The author's typing also settles
    /// decorations that were drawn.
    pub fn follow(&mut self, chapter: usize, set: &ChangeSet, own: bool, cx: &App) {
        let Some(layer) = self.chapters.get_mut(chapter) else {
            return;
        };
        if layer.live.is_empty() || set.ops.is_empty() {
            return;
        }
        for live in &mut layer.live {
            for op in &set.ops {
                live.deco.range = range_over(op, live.deco.range.clone());
            }
        }
        layer.max_len = layer
            .live
            .iter()
            .map(|live| live.deco.range.len())
            .max()
            .unwrap_or(0);
        // Ticks sit at paragraphs: typing inside one moves no tick.
        if set.splices.iter().any(|s| s.old != 1 || s.new != 1) {
            self.version += 1;
        }
        if own {
            self.settle(cx.background_executor().now());
        }
    }

    /// Settles every drawn decoration back to rest (the author clicked in
    /// the prose or typed).
    pub(crate) fn settle(&mut self, now: Instant) {
        let reduce = self.reduce_motion;
        for (chapter, layer) in self.chapters.iter_mut().enumerate() {
            for live in &mut layer.live {
                if matches!(live.deco.emphasis, Emphasis::Drawn(_)) && !live.settled {
                    live.settled = true;
                    live.retarget_heat(now, reduce);
                    self.pending.push(DecorationEvent::Settled {
                        chapter,
                        key: live.key.clone(),
                    });
                }
            }
        }
        self.waiting_drawn = false;
    }

    pub(crate) fn any_unsettled_drawn(&self) -> bool {
        self.waiting_drawn
    }

    fn recount_drawn(&mut self) {
        self.waiting_drawn = self.chapters.iter().any(|layer| {
            layer
                .live
                .iter()
                .any(|l| !l.leaving && matches!(l.deco.emphasis, Emphasis::Drawn(_)) && !l.settled)
        });
    }

    /// Replaces a group in a chapter (see [`ProseEditor::set_decorations`]).
    fn set_group(
        &mut self,
        chapter: usize,
        group: SharedString,
        decorations: Vec<Decoration>,
        now: Instant,
    ) {
        let reduce = self.reduce_motion;
        let layer = self.layer(chapter);
        let wanted: HashSet<SharedString> = decorations.iter().map(|d| d.id.clone()).collect();
        layer
            .dismissed
            .retain(|key| key.group != group || wanted.contains(&key.id));
        for decoration in decorations {
            let key = DecorationKey {
                group: group.clone(),
                id: decoration.id.clone(),
            };
            if layer.dismissed.contains(&key) {
                continue;
            }
            match layer
                .live
                .iter_mut()
                .find(|live| live.key == key && !live.leaving)
            {
                Some(live) => {
                    if let Emphasis::Drawn(n) = decoration.emphasis
                        && live.drawn != Some(n)
                    {
                        live.drawn = Some(n);
                        live.settled = false;
                        live.draw = (!reduce).then_some(now);
                    }
                    live.deco = decoration;
                    live.retarget_heat(now, reduce);
                }
                None => {
                    let drawn = match decoration.emphasis {
                        Emphasis::Drawn(n) => Some(n),
                        _ => None,
                    };
                    // A stroke the author's action drew arrives by being
                    // drawn; anything else fades in as a whole.
                    let mut presence = Level::still(if drawn.is_some() { 1. } else { 0. }, now);
                    presence.retarget(1., now, dur(motion::FADE, reduce));
                    let seed = sand::seed(&key.id, 0);
                    let mut live = Live {
                        key,
                        deco: decoration,
                        presence,
                        leaving: false,
                        heat: Level::still(0., now),
                        draw: drawn.filter(|_| !reduce).map(|_| now),
                        drawn,
                        settled: false,
                        pointed: false,
                        seed,
                    };
                    if live.wants_heat() {
                        live.heat = Level::still(1., now);
                    }
                    layer.live.push(live);
                }
            }
        }
        for live in &mut layer.live {
            if live.key.group == group && !live.leaving && !wanted.contains(&live.key.id) {
                live.leaving = true;
                live.presence.retarget(0., now, dur(motion::FADE, reduce));
            }
        }
        layer.live.retain(|live| !live.gone(now));
        layer.reindex();
        self.version += 1;
        self.recount_drawn();
    }

    /// Lets a touched decoration go.
    fn touch(&mut self, chapter: usize, key: &DecorationKey, now: Instant) -> bool {
        let reduce = self.reduce_motion;
        let layer = self.layer(chapter);
        let Some(live) = layer
            .live
            .iter_mut()
            .find(|l| &l.key == key && !l.leaving && l.deco.touch == Touch::Fade)
        else {
            return false;
        };
        live.leaving = true;
        live.presence
            .retarget(0., now, dur(motion::TOUCH_FADE, reduce));
        layer.dismissed.insert(key.clone());
        self.version += 1;
        true
    }

    fn set_pointed(&mut self, pointed: Vec<(usize, DecorationKey)>, now: Instant) {
        let reduce = self.reduce_motion;
        for (chapter, layer) in self.chapters.iter_mut().enumerate() {
            for live in &mut layer.live {
                let on = pointed.iter().any(|(c, k)| *c == chapter && *k == live.key);
                if live.pointed != on {
                    live.pointed = on;
                    live.retarget_heat(now, reduce);
                }
            }
        }
        self.pointed = pointed.clone();
        self.pending.push(DecorationEvent::Pointed { ids: pointed });
    }

    /// Follows the caret for immersive writing's paragraph focus.
    pub(crate) fn track_focus(&mut self, at: (usize, usize), now: Instant) {
        if self.focus.current == Some(at) {
            return;
        }
        let reduce = self.reduce_motion;
        self.focus.previous = self.focus.current;
        self.focus.current = Some(at);
        self.focus.moved = Level::still(0., now);
        self.focus
            .moved
            .retarget(1., now, dur(motion::FOCUS_SHIFT, reduce));
    }
}

/// A decoration as one paragraph paints it this frame.
#[derive(Clone, Debug)]
pub(crate) struct ParaDeco {
    pub key: DecorationKey,
    /// Bytes of the paragraph's display text.
    pub bytes: Range<usize>,
    pub kind: ParaKind,
    pub touch: Touch,
    pub seed: u32,
    /// How much of this paragraph's part of the stroke is drawn (0–1);
    /// `None` when it is all down.
    pub drawn: Option<f32>,
}

#[derive(Clone, Debug)]
pub(crate) enum ParaKind {
    Wash {
        brush: Brush,
        hot_brush: Option<Brush>,
        color: Hsla,
        /// The stroke's alpha now, and the hot brush's share of it.
        alpha: f32,
        heat: f32,
        reach: Pixels,
    },
    Underline {
        brush: Brush,
        color: Hsla,
        alpha: f32,
        height: Pixels,
        drop: Pixels,
    },
    Ink {
        color: Hsla,
        level: f32,
    },
}

fn strength(s: Strength, heat: f32) -> f32 {
    s.rest + (s.hot - s.rest) * heat
}

impl Live {
    /// This decoration's part of a paragraph `line_start..line_end`
    /// (`to_display` maps a byte of the committed text to the display
    /// text, which holds a composition).
    pub(crate) fn para(
        &self,
        line_start: usize,
        line_end: usize,
        chars_per_row: f32,
        byte_of: impl Fn(usize, bool) -> usize,
        line: usize,
        now: Instant,
    ) -> Option<ParaDeco> {
        let range = &self.deco.range;
        let start = range.start.max(line_start);
        let end = range.end.min(line_end);
        if start >= end {
            return None;
        }
        let presence = self.presence.value(now);
        if presence <= 0.002 {
            return None;
        }
        let heat = self.heat.value(now);
        let kind = match &self.deco.look {
            Look::Wash(w) => ParaKind::Wash {
                brush: w.brush.clone(),
                hot_brush: w.hot_brush.clone(),
                color: w.color,
                alpha: w.color.a * strength(w.strength, heat) * presence,
                heat: if w.hot_brush.is_some() { heat } else { 0. },
                reach: w.reach,
            },
            Look::Underline(u) => ParaKind::Underline {
                brush: u.brush.clone(),
                color: u.color,
                alpha: u.color.a * strength(u.strength, heat) * presence,
                height: u.height,
                drop: u.drop,
            },
            Look::Ink(color) => ParaKind::Ink {
                color: *color,
                level: presence,
            },
        };
        // A stroke being drawn: one easing movement across the whole range
        // (all its paragraphs), measured in characters; each paragraph draws
        // its share along its rows.
        let drawn = self.draw.and_then(|t0| {
            let total = range.len().max(1) as f32;
            let rows = (total / chars_per_row.max(1.)).ceil().max(1.) as usize;
            let t = now.saturating_duration_since(t0).as_secs_f32()
                / motion::draw_time(rows).as_secs_f32();
            if t >= 1. {
                return None;
            }
            let down = motion::drawn_at(t) * total;
            let before = (start - range.start) as f32;
            Some(((down - before) / (end - start) as f32).clamp(0., 1.))
        });
        Some(ParaDeco {
            key: self.key.clone(),
            bytes: byte_of(start - line_start, true)..byte_of(end - line_start, false),
            kind,
            touch: self.deco.touch,
            seed: self.seed ^ (line as u32).wrapping_mul(0x9e37_79b9),
            drawn,
        })
    }
}

// ----- the host's methods --------------------------------------------------------------

impl ProseEditor {
    /// Replaces the decorations of `group` in `chapter` with `decorations`.
    /// Ones that stay (same id) keep their state and take the new range and
    /// look; new ones fade in (or are drawn, for [`Emphasis::Drawn`]); the
    /// rest fade out. Ranges are then moved with every edit.
    pub fn set_decorations(
        &mut self,
        chapter: usize,
        group: impl Into<SharedString>,
        decorations: Vec<Decoration>,
        cx: &mut Context<Self>,
    ) {
        let now = cx.background_executor().now();
        self.paint
            .set_group(chapter, group.into(), decorations, now);
        cx.notify();
    }

    /// Drops every decoration at once (another book opened).
    pub fn clear_decorations(&mut self, cx: &mut Context<Self>) {
        self.paint.chapters.clear();
        self.paint.pointed.clear();
        self.paint.candidate = None;
        self.paint.point_task = None;
        self.paint.hover_tick = None;
        self.paint.waiting_drawn = false;
        self.paint.version += 1;
        cx.notify();
    }

    /// Where a decoration is now (after the edits since it was submitted),
    /// if it is shown.
    pub fn decoration_range(&self, chapter: usize, group: &str, id: &str) -> Option<Range<usize>> {
        self.paint
            .chapters
            .get(chapter)?
            .live
            .iter()
            .find_map(|live| {
                (!live.leaving && live.key.group == group && live.key.id == id)
                    .then(|| live.deco.range.clone())
            })
    }

    /// Where a decoration was painted in the last frame: the window bounds of
    /// the words it covers, row by row, across its paragraphs (empty when
    /// none of it is on screen). For placing a card next to it.
    pub fn painted_decoration(
        &self,
        chapter: usize,
        group: &str,
        id: &str,
    ) -> Option<super::frame::PaintedDecoration> {
        let frame = self.frame.borrow();
        let mut parts = frame
            .decorations
            .iter()
            .filter(|d| d.chapter == chapter && d.key.group == group && d.key.id == id);
        let mut first = parts.next()?.clone();
        for part in parts {
            first.boxes.extend(part.boxes.iter().copied());
        }
        Some(first)
    }

    /// How many decoration parts the last frame painted.
    pub fn painted_decorations(&self) -> usize {
        self.frame.borrow().decorations.len()
    }

    /// Draws F4c's find matches ([`ProseEditor::find_matches`]) with `look`:
    /// `strength.rest` for every match, `strength.hot` for the current one
    /// (the selection). Read every frame, so typing a query or stepping
    /// needs nothing more from the host. `None` draws no matches.
    pub fn set_find_look(&mut self, look: Option<super::decor::Wash>, cx: &mut Context<Self>) {
        self.paint.find_look = look;
        cx.notify();
    }

    /// The look of quotes, indents and rules.
    pub fn set_block_style(&mut self, style: BlockStyle, cx: &mut Context<Self>) {
        if style != self.paint.block_style {
            self.paint.block_style = style;
            // Insets, gaps and pads are layout: estimate again too.
            self.estimate_width = None;
            self.list.remeasure();
            cx.notify();
        }
    }

    pub fn block_style(&self) -> &BlockStyle {
        &self.paint.block_style
    }

    /// The seals scrollbar ticks are pressed with (Drifting: `blob-0..5`);
    /// each tick takes one by its id, turned by a fixed angle. Without seals
    /// ticks are round dots.
    pub fn set_tick_seals(&mut self, seals: Vec<Rc<SandTexture>>, cx: &mut Context<Self>) {
        self.paint.seals = seals;
        cx.notify();
    }

    /// Immersive writing: every paragraph but the caret's fades to
    /// [`FOCUS_DIM`] of its ink, easing as the caret moves between them.
    pub fn set_paragraph_focus(&mut self, on: bool, cx: &mut Context<Self>) {
        let now = cx.background_executor().now();
        let reduce = self.paint.reduce_motion;
        self.paint.focus.on.retarget(
            if on { 1. } else { 0. },
            now,
            dur(motion::FOCUS_SHIFT, reduce),
        );
        cx.notify();
    }

    pub fn paragraph_focus(&self) -> bool {
        self.paint.focus.on.target() > 0.
    }

    /// Reduced motion: every paint-layer change lands at once.
    pub fn set_reduce_motion(&mut self, reduce: bool, cx: &mut Context<Self>) {
        self.paint.reduce_motion = reduce;
        cx.notify();
    }

    /// The block look of a paragraph (its attributes, read through the
    /// block style).
    pub fn block_look(&self, chapter: usize, line: usize) -> BlockLook {
        let doc = &self.book.chapters[chapter].doc;
        let mut look = BlockLook::of(
            &doc.line(line).block,
            &self.paint.block_style,
            self.style.body_size,
        );
        if let Some(item) = look.list.as_mut() {
            match &mut item.mark {
                ListMark::Ordered(n) => *n = self.list_number(chapter, line, item.level),
                ListMark::Task { done } => {
                    if let Some(todo) = linked_todo(&doc.line(line).block) {
                        *done = self
                            .extension
                            .as_ref()
                            .and_then(|x| x.task_done(todo))
                            .unwrap_or(false);
                    }
                }
                ListMark::Bullet => {}
            }
        }
        let above = (line > 0).then(|| &doc.line(line - 1).block);
        let below = (line + 1 < doc.visible_lines()).then(|| &doc.line(line + 1).block);
        look.join(&doc.line(line).block, above, below);
        look
    }

    /// An ordered item's number: one more than the ordered items of its
    /// level right above it (deeper items between them do not break the
    /// count; anything else does).
    fn list_number(&self, chapter: usize, line: usize, level: u8) -> u32 {
        let doc = &self.book.chapters[chapter].doc;
        let mut n = 1;
        let mut ix = line;
        while ix > 0 && n < 100_000 {
            ix -= 1;
            match list_item(&doc.line(ix).block) {
                Some(item) if item.level > level => {}
                Some(ListItem {
                    mark: ListMark::Ordered(_),
                    level: l,
                }) if l == level => n += 1,
                _ => break,
            }
        }
        n
    }

    /// The author clicked a task item's box.
    pub(crate) fn task_clicked(&mut self, chapter: usize, line: usize, cx: &mut Context<Self>) {
        self.paint
            .pending
            .push(DecorationEvent::TaskClicked { chapter, line });
        self.flush_decoration_events(cx);
    }

    /// Sends the events the paint layers queued.
    pub(crate) fn flush_decoration_events(&mut self, cx: &mut Context<Self>) {
        for event in std::mem::take(&mut self.paint.pending) {
            cx.emit(event);
        }
    }

    /// Applies what painting and mouse events found: touched decorations
    /// fade, and the pointer's resting place is weighed.
    pub(crate) fn take_pointer_findings(&mut self, cx: &mut Context<Self>) {
        let (hits, touched) = {
            let mut shared = self.paint.shared.borrow_mut();
            shared.scheduled = false;
            let moved = std::mem::take(&mut shared.moved);
            let hits = std::mem::take(&mut shared.hits);
            (moved.then_some(hits), std::mem::take(&mut shared.touched))
        };
        let now = cx.background_executor().now();
        let mut changed = false;
        for (chapter, key) in touched {
            if self.paint.touch(chapter, &key, now) {
                self.paint
                    .pending
                    .push(DecorationEvent::Touched { chapter, key });
                changed = true;
            }
        }
        if let Some(hits) = hits {
            self.weigh_pointer(hits, now, cx);
        }
        if changed {
            cx.notify();
        }
        self.flush_decoration_events(cx);
    }

    /// Hover intent: the decorations under the pointer count as pointed once
    /// it has rested on them for their `rest`; leaving them all lets go at
    /// once.
    fn weigh_pointer(
        &mut self,
        hits: Vec<(usize, DecorationKey, Duration)>,
        now: Instant,
        cx: &mut Context<Self>,
    ) {
        let rest = hits.iter().map(|(_, _, r)| *r).max().unwrap_or_default();
        let ids: Vec<(usize, DecorationKey)> = hits.into_iter().map(|(c, k, _)| (c, k)).collect();
        if ids == self.paint.pointed {
            self.paint.candidate = None;
            self.paint.point_task = None;
            return;
        }
        if ids.is_empty() || rest.is_zero() {
            self.paint.candidate = None;
            self.paint.point_task = None;
            self.paint.set_pointed(ids, now);
            cx.notify();
            return;
        }
        if self.paint.candidate.as_ref() == Some(&ids) {
            return;
        }
        self.paint.candidate = Some(ids);
        self.paint.point_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(rest).await;
            this.update(cx, |this, cx| {
                if let Some(ids) = this.paint.candidate.take() {
                    let now = cx.background_executor().now();
                    this.paint.set_pointed(ids, now);
                    this.flush_decoration_events(cx);
                    cx.notify();
                }
            })
            .ok();
        }));
    }

    /// The author clicked in the prose: drawn decorations settle.
    pub(crate) fn settle_drawn(&mut self, cx: &mut Context<Self>) {
        let now = cx.background_executor().now();
        self.paint.settle(now);
        self.flush_decoration_events(cx);
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render::decor::{Look, Wash};
    use gpui::hsla;

    fn op(pos: usize, deleted: usize, inserted: usize) -> TextOp {
        TextOp {
            pos,
            deleted,
            inserted,
        }
    }

    #[test]
    fn ranges_follow_edits_without_swallowing_neighbours() {
        // Typing inside grows the range.
        assert_eq!(range_over(&op(5, 0, 2), 3..8), 3..10);
        // Typing right before it or right after it stays outside.
        assert_eq!(range_over(&op(3, 0, 2), 3..8), 5..10);
        assert_eq!(range_over(&op(8, 0, 2), 3..8), 3..8);
        // Text before it moves it.
        assert_eq!(range_over(&op(0, 1, 0), 3..8), 2..7);
        // Deleting its first characters.
        assert_eq!(range_over(&op(2, 3, 0), 3..8), 2..5);
        // Deleting its words collapses it; replacing them too.
        assert_eq!(range_over(&op(3, 5, 0), 3..8).len(), 0);
        assert_eq!(range_over(&op(2, 7, 4), 3..8).len(), 0);
    }

    #[test]
    fn groups_replace_by_id_and_fade() {
        let t0 = Instant::now();
        let mut state = PaintState::default();
        let wash = Look::Wash(Wash::flat(hsla(0., 0., 0., 1.), Strength::new(0.2, 0.4)));
        let d = |id: &str, r: Range<usize>| Decoration::new(id.to_string(), r, wash.clone());
        state.set_group(0, "c".into(), vec![d("a", 0..3), d("b", 5..9)], t0);
        assert_eq!(state.chapters[0].live.len(), 2);
        assert_eq!(state.chapters[0].live[0].presence.value(t0), 0.);
        let t1 = t0 + motion::FADE;
        assert_eq!(state.chapters[0].live[0].presence.value(t1), 1.);
        // "a" goes, "b" moves, "c" arrives.
        state.set_group(0, "c".into(), vec![d("b", 6..9), d("c", 1..2)], t1);
        let ids: Vec<&str> = state.chapters[0]
            .live
            .iter()
            .map(|l| l.key.id.as_ref())
            .collect();
        assert_eq!(ids, ["a", "c", "b"]);
        let a = &state.chapters[0].live[0];
        assert!(a.leaving);
        assert!(a.presence.value(t1 + motion::FADE / 2) > 0.);
        assert_eq!(state.chapters[0].live[2].deco.range, 6..9);
        // Another group in the same chapter is left alone, and once the
        // fade is over the leaving one is gone.
        let t2 = t1 + motion::FADE;
        state.set_group(0, "find".into(), vec![d("f", 0..1)], t2);
        assert_eq!(state.chapters[0].live.len(), 3);
        assert!(state.chapters[0].overlapping(0, 4).any(|l| l.key.id == "f"));
        assert!(state.chapters[0].overlapping(7, 8).all(|l| l.key.id == "b"));
    }

    #[test]
    fn a_touched_decoration_stays_dismissed_until_the_host_drops_it() {
        let t0 = Instant::now();
        let mut state = PaintState::default();
        let d = Decoration::new("x", 0..4, Look::Ink(hsla(0.4, 0.4, 0.3, 1.))).touch(Touch::Fade);
        state.set_group(0, "agent".into(), vec![d.clone()], t0);
        let key = state.chapters[0].live[0].key.clone();
        assert!(state.touch(0, &key, t0));
        // The host has not caught up and submits it again: still gone.
        state.set_group(0, "agent".into(), vec![d.clone()], t0 + motion::FADE);
        assert!(state.chapters[0].live.iter().all(|l| l.leaving));
        // The host drops it, later the Agent changes the words again.
        state.set_group(0, "agent".into(), vec![], t0 + motion::FADE * 2);
        state.set_group(0, "agent".into(), vec![d], t0 + motion::FADE * 3);
        assert!(state.chapters[0].live.iter().any(|l| !l.leaving));
    }
}
