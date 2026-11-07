//! The paint layers' public types: what a host hands the editor to draw
//! over a range of prose without changing the prose.
//!
//! A decoration is a range of one chapter (scalar offsets, like the
//! selection) and a look. Hosts submit them in groups (comments, find hits,
//! link suggestions, Agent changes …) with
//! [`crate::ProseEditor::set_decorations`]: each call replaces the whole group,
//! and the editor matches the new list against the old by id, so a
//! decoration that stays keeps its state, a new one fades in and a dropped
//! one fades out. Between submissions the editor moves every range with the
//! edits it sees (typing, undo, other devices, the Agent), so a decoration
//! never trails the text and the paragraphs are never laid out again for it.
//!
//! Three looks, in two layers:
//!
//! - under the words: [`Look::Wash`] (a comment's sand, a find hit);
//! - over the words: [`Look::Underline`] (an entity link's dry stroke, a
//!   suggested link's grains);
//! - the words themselves: [`Look::Ink`] (an Agent change's colour, a TODO
//!   keyword), eased in and out like the rest.
//!
//! Colours and textures come from the host; gpui-prose has none of its own.

use std::{ops::Range, rc::Rc, time::Duration};

use gpui::{Hsla, Pixels, SharedString, px};

use super::sand::SandTexture;

/// One decoration: a range of a chapter and how it looks.
#[derive(Clone, Debug)]
pub struct Decoration {
    /// Stable within its group (a comment id, `find:12`, a change id …).
    pub id: SharedString,
    /// Scalar offsets in the chapter. A range the edits collapse to nothing
    /// (its words deleted) is not drawn until the host submits it again.
    pub range: Range<usize>,
    pub look: Look,
    /// What the pointer does to it.
    pub touch: Touch,
    /// The host's state for it (a comment pointed at from its card, a
    /// comment jumped to).
    pub emphasis: Emphasis,
    /// A tick on the scrollbar.
    pub tick: Option<Tick>,
}

impl Decoration {
    pub fn new(id: impl Into<SharedString>, range: Range<usize>, look: Look) -> Decoration {
        Decoration {
            id: id.into(),
            range,
            look,
            touch: Touch::None,
            emphasis: Emphasis::Rest,
            tick: None,
        }
    }

    pub fn touch(mut self, touch: Touch) -> Decoration {
        self.touch = touch;
        self
    }

    pub fn emphasis(mut self, emphasis: Emphasis) -> Decoration {
        self.emphasis = emphasis;
        self
    }

    pub fn tick(mut self, tick: Tick) -> Decoration {
        self.tick = Some(tick);
        self
    }
}

#[derive(Clone, Debug)]
pub enum Look {
    /// Under the words, one stroke per visual row.
    Wash(Wash),
    /// Over the words, one stroke per visual row under the baseline.
    Underline(Underline),
    /// The words in another colour.
    Ink(Hsla),
}

/// How strong a stroke is at rest and when hot (pointed at, drawn).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Strength {
    pub rest: f32,
    pub hot: f32,
}

impl Strength {
    pub const fn new(rest: f32, hot: f32) -> Strength {
        Strength { rest, hot }
    }
}

/// What a stroke is drawn with.
#[derive(Clone, Debug)]
pub enum Brush {
    /// A flat tint with slightly rounded corners (a find hit).
    Flat,
    /// A dotted line of grains (only for underlines).
    Dotted,
    /// A sand texture from the host.
    Sand(Rc<SandTexture>),
}

/// Sand under the words: a comment anchor (Drifting: `hl.png` in the
/// comment colour at 0.27, `hl-hot.png` at 0.61 when pointed at), a find hit
/// (a flat accent tint).
#[derive(Clone, Debug)]
pub struct Wash {
    pub brush: Brush,
    /// The stroke when hot; the editor cross-fades the two. `None`: the same
    /// brush, only stronger.
    pub hot_brush: Option<Brush>,
    pub color: Hsla,
    /// Multiplies `color`'s alpha.
    pub strength: Strength,
    /// How far the stroke reaches past the words on either side.
    pub reach: Pixels,
}

impl Wash {
    /// A flat tint (a find hit): `rest` for the other hits, `hot` for the
    /// current one (give it [`Emphasis::Hot`]).
    pub fn flat(color: Hsla, strength: Strength) -> Wash {
        Wash {
            brush: Brush::Flat,
            hot_brush: None,
            color,
            strength,
            reach: px(1.),
        }
    }

    /// A sand swash.
    pub fn sand(
        texture: Rc<SandTexture>,
        hot: Option<Rc<SandTexture>>,
        color: Hsla,
        strength: Strength,
    ) -> Wash {
        Wash {
            brush: Brush::Sand(texture),
            hot_brush: hot.map(Brush::Sand),
            color,
            strength,
            reach: px(3.),
        }
    }
}

/// A stroke under the words, over the text layer (Drifting: an entity
/// link's dry underline `ul.png`, 7 px, 0.7 → 0.95 under the pointer; a
/// suggested link's grains).
#[derive(Clone, Debug)]
pub struct Underline {
    pub brush: Brush,
    pub color: Hsla,
    pub strength: Strength,
    /// Height of the stroke.
    pub height: Pixels,
    /// From the baseline down to the stroke's middle.
    pub drop: Pixels,
}

impl Underline {
    pub fn sand(texture: Rc<SandTexture>, color: Hsla, strength: Strength) -> Underline {
        Underline {
            brush: Brush::Sand(texture),
            color,
            strength,
            height: px(7.),
            drop: px(4.),
        }
    }

    pub fn dotted(color: Hsla, strength: Strength) -> Underline {
        Underline {
            brush: Brush::Dotted,
            color,
            strength,
            height: px(1.3),
            drop: px(4.),
        }
    }
}

/// What the pointer does to a decoration.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Touch {
    #[default]
    None,
    /// The pointer resting on it for `rest` (0 for at once) points at it:
    /// it turns hot, and the editor reports
    /// [`DecorationEvent::Pointed`] (so the host can light its card).
    /// Sweeping over it or dragging a selection points at nothing.
    Point { rest: Duration },
    /// The first touch of the pointer (moving onto it, or the prose
    /// scrolling under a pointer held still) lets it go: it fades over
    /// 0.3 s and is gone, and the editor reports
    /// [`DecorationEvent::Touched`] so the host can remember it was seen.
    Fade,
}

impl Touch {
    /// A comment's hover intent (0.12 s).
    pub const POINT: Touch = Touch::Point {
        rest: super::motion::POINT_REST,
    };
    /// At once (an entity link's underline deepening).
    pub const HOVER: Touch = Touch::Point {
        rest: Duration::ZERO,
    };
}

/// The host's state for a decoration.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Emphasis {
    #[default]
    Rest,
    /// Pointed at from elsewhere (its card), or the current find hit.
    Hot,
    /// The author's own action chose it (jumped to it, just wrote it): its
    /// stroke is drawn again along its rows, then stays hot until the author
    /// clicks in the prose or types; the editor then settles it back to rest
    /// and reports [`DecorationEvent::Settled`]. A new number draws it
    /// again; the same number again does nothing.
    Drawn(u64),
}

/// A tick on the scrollbar: Drifting's comment and Agent-change marks.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Tick {
    pub color: Hsla,
    pub lane: TickLane,
}

/// Where across the scrollbar a tick sits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TickLane {
    /// Across the whole bar, above the lanes (a comment, 6 px).
    Span,
    /// One of three thin lanes (an Agent change: new, changed, deleted;
    /// 3.4 px).
    Lane(u8),
}

/// What the paint layers report to the host (`EventEmitter`, alongside
/// [`crate::EditorEvent`]).
#[derive(Clone, Debug, PartialEq)]
pub enum DecorationEvent {
    /// The decorations the pointer now rests on, with their chapters
    /// (empty: none any more).
    Pointed { ids: Vec<(usize, DecorationKey)> },
    /// A [`Touch::Fade`] decoration was touched: it is fading and gone.
    Touched { chapter: usize, key: DecorationKey },
    /// A [`Emphasis::Drawn`] decoration went back to rest: the author
    /// clicked in the prose or typed.
    Settled { chapter: usize, key: DecorationKey },
    /// The author clicked a decoration's tick; the editor scrolled to it.
    TickClicked { chapter: usize, key: DecorationKey },
    /// The author clicked the box of the task item on paragraph `line`
    /// (the host ticks it: its `checked`, or the TODO it is linked to).
    TaskClicked { chapter: usize, line: usize },
}

/// A decoration's group and id.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct DecorationKey {
    pub group: SharedString,
    pub id: SharedString,
}
