//! Where the ring and the card go (the 0.1 client's
//! `features/guide/tour-geometry.ts`, with its numbers).

use dr_ui::components::overlay::{self, Align, Place};
use gpui::{Bounds, Pixels, Point, Size, point, px, size};

/// The ring stands this far outside what it points at (`GUIDE_RING_OUTSET`).
pub const RING_OUTSET: f32 = 4.0;
/// The card keeps this far from the ring (`GUIDE_CARD_GAP`).
pub const CARD_GAP: f32 = 10.0;
/// …and this far inside the window (`GUIDE_CARD_MARGIN`, the floating
/// layer's own margin).
pub const CARD_MARGIN: f32 = overlay::MARGIN;
/// The ring never runs past the window's edge: it stays this far in (the
/// tab rows run along the window's top).
const RING_EDGE: f32 = 1.0;
/// A target about square (within this) and no wider than [`ROUND_MAX`] is a
/// round button: its ring stays round.
const ROUND_SLACK: f32 = 2.0;
const ROUND_MAX: f32 = 40.0;
/// A wide target's ring has soft corners, at most this round.
const RING_CORNER: f32 = 12.0;

/// One box round everything a step points at; `None` when nothing of it
/// shows (`unionGuideRect`).
pub fn union(rects: impl IntoIterator<Item = Bounds<Pixels>>) -> Option<Bounds<Pixels>> {
    rects
        .into_iter()
        .filter(|r| r.size.width > px(0.0) && r.size.height > px(0.0))
        .reduce(|a, b| a.union(&b))
}

/// Whether any of `rect` lies inside the window.
pub fn on_screen(rect: Bounds<Pixels>, viewport: Size<Pixels>) -> bool {
    rect.size.width > px(0.0)
        && rect.size.height > px(0.0)
        && rect.right() > px(0.0)
        && rect.bottom() > px(0.0)
        && rect.left() < viewport.width
        && rect.top() < viewport.height
}

/// The ring round a target.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Ring {
    pub bounds: Bounds<Pixels>,
    pub radius: f32,
}

/// A little larger than the target; round targets stay round; never past
/// the window's edge (`guideRingRect`).
pub fn ring(target: Bounds<Pixels>, viewport: Size<Pixels>) -> Ring {
    let (x, y) = (f32::from(target.left()), f32::from(target.top()));
    let (w, h) = (f32::from(target.size.width), f32::from(target.size.height));
    let left = RING_EDGE.max(x - RING_OUTSET);
    let top = RING_EDGE.max(y - RING_OUTSET);
    let right = (f32::from(viewport.width) - RING_EDGE).min(x + w + RING_OUTSET);
    let bottom = (f32::from(viewport.height) - RING_EDGE).min(y + h + RING_OUTSET);
    let (rw, rh) = ((right - left).max(0.0), (bottom - top).max(0.0));
    let round = (w - h).abs() <= ROUND_SLACK && w <= ROUND_MAX;
    Ring {
        bounds: Bounds::new(point(px(left), px(top)), size(px(rw), px(rh))),
        radius: if round {
            rh / 2.0
        } else {
            RING_CORNER.min(rh / 2.0)
        },
    }
}

/// Where the card goes beside `ring` (`placeGuideCard`): under it when it
/// fits, left edges together; else above it, right edges together; else
/// beside it on the roomier side. The floating layer's placement
/// ([`overlay::place`]) does each of the three and keeps it in the window.
pub fn card_place(ring: Bounds<Pixels>, card: Size<Pixels>, viewport: Size<Pixels>) -> Place {
    let h = f32::from(card.height);
    let below = f32::from(ring.bottom()) + CARD_GAP;
    if below + h + CARD_MARGIN <= f32::from(viewport.height) {
        return Place::Rect {
            rect: ring,
            align: Align::Start,
            gap: CARD_GAP,
        };
    }
    let above = f32::from(ring.top()) - CARD_GAP - h;
    if above >= CARD_MARGIN {
        return Place::Rect {
            rect: ring,
            align: Align::End,
            gap: CARD_GAP,
        };
    }
    Place::Beside {
        rect: ring,
        gap: CARD_GAP,
    }
}

/// The card's top-left corner beside `ring`.
pub fn card_origin(
    ring: Bounds<Pixels>,
    card: Size<Pixels>,
    viewport: Size<Pixels>,
) -> Point<Pixels> {
    overlay::place(card_place(ring, card, viewport), card, viewport)
}
