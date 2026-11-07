//! Scrollbar ticks: where the decorations that ask for one are, as sand
//! seals along the right edge (Drifting: comments across the bar, Agent
//! changes in three thin lanes; find hits too, if the host gives them a
//! tick).
//!
//! A tick sits at its decoration's paragraph by the editor's own height
//! index, the same one the scrollbar thumb uses, so the book never has to be
//! laid out for them. Each tick is pressed with one of the host's seals,
//! chosen and turned by its id (the same every time), fades in and out with
//! its decoration, darkens under the pointer, and a click scrolls to it and
//! tells the host ([`DecorationEvent::TickClicked`]).

use std::rc::Rc;

use gpui::{
    AnyElement, App, Bounds, Context, DispatchPhase, Hitbox, HitboxBehavior, Hsla, IntoElement,
    ListOffset, MouseButton, MouseDownEvent, MouseExitEvent, MouseMoveEvent, Pixels, Styled,
    WeakEntity, Window, canvas, div, fill, point, px, size,
};

use super::{
    decor::{DecorationEvent, DecorationKey, TickLane},
    sand::{self, paint_seal},
};
use crate::ProseEditor;

/// Width of the strip the ticks sit in, at the window's right edge.
pub const STRIP: f32 = 12.;

/// A tick's place, cached until a decoration comes or goes or paragraphs
/// come or go under it; where that is on the bar is read from the height
/// index each frame.
#[derive(Clone)]
pub(crate) struct Spot {
    pub(crate) chapter: usize,
    pub(crate) key: DecorationKey,
    /// Index into the chapter's decorations (valid for this version).
    pub(crate) live: usize,
    /// The list item (paragraph) it sits at.
    pub(crate) item: usize,
    pub(crate) start: usize,
    pub(crate) color: Hsla,
    pub(crate) lane: TickLane,
    pub(crate) seal: u32,
}

#[derive(Default)]
pub(crate) struct TickCache {
    key: Option<(u64, usize)>,
    pub(crate) spots: Rc<[Spot]>,
}

/// A tick as painted this frame: which spot, where.
#[derive(Clone, Copy)]
struct Painted {
    spot: usize,
    center: gpui::Point<Pixels>,
    diameter: Pixels,
}

fn lane_x(lane: TickLane) -> (f32, f32) {
    match lane {
        TickLane::Span => (STRIP / 2., 6.),
        TickLane::Lane(0) => (STRIP / 2. - 2.4, 3.4),
        TickLane::Lane(1) => (STRIP / 2., 3.4),
        TickLane::Lane(_) => (STRIP / 2. + 2.4, 3.4),
    }
}

impl ProseEditor {
    fn refresh_ticks(&mut self) {
        let key = (self.paint.version, self.book.item_count());
        if self.paint.ticks.key == Some(key) {
            return;
        }
        let mut spots = Vec::new();
        for (chapter, layer) in self.paint.chapters.iter().enumerate() {
            if chapter >= self.book.chapters.len() {
                break;
            }
            let doc = &self.book.chapters[chapter].doc;
            for (ix, live) in layer.live.iter().enumerate() {
                let Some(tick) = live.deco.tick else {
                    continue;
                };
                let line = doc.line_of(live.deco.range.start);
                if line >= self.book.listed[chapter] {
                    continue;
                }
                spots.push(Spot {
                    chapter,
                    key: live.key.clone(),
                    live: ix,
                    item: self.book.line_item(chapter, line),
                    start: live.deco.range.start,
                    color: tick.color,
                    lane: tick.lane,
                    seal: sand::seed(&live.key.id, 7),
                });
            }
        }
        // Comments over the lanes: paint lanes first.
        spots.sort_by_key(|s| matches!(s.lane, TickLane::Span));
        self.paint.ticks = TickCache {
            key: Some(key),
            spots: spots.into(),
        };
    }

    /// The tick strip, laid over the editor's right edge (under the thumb).
    pub(crate) fn scroll_ticks(&mut self, cx: &mut Context<Self>) -> AnyElement {
        if self.paint.chapters.iter().all(|l| l.live.is_empty()) {
            return div().into_any_element();
        }
        self.refresh_ticks();
        let now = cx.background_executor().now();
        let hover = self.paint.hover_tick.clone();
        let spots = self.paint.ticks.spots.clone();
        let mut moving = false;
        // Strength and height are read each frame; the rest is cached.
        let mut heights = self.heights.borrow_mut();
        let total = heights.total().max(1.);
        let levels: Vec<(usize, f32, f32)> = spots
            .iter()
            .enumerate()
            .filter_map(|(ix, spot)| {
                let live = self.paint.chapters.get(spot.chapter)?.live.get(spot.live)?;
                moving |= !live.presence.settled(now);
                let level = live.presence.value(now);
                let at = (heights.top(spot.item) / total) as f32;
                (level > 0.002).then_some((ix, level, at))
            })
            .collect();
        drop(heights);
        let hovered =
            hover.and_then(|(c, k)| spots.iter().position(|s| s.chapter == c && s.key == k));
        let seals = self.paint.seals.clone();
        let editor = cx.weak_entity();
        let shared = self.paint.shared.clone();
        canvas(
            |bounds, window, _| window.insert_hitbox(bounds, HitboxBehavior::Normal),
            move |bounds, hitbox: Hitbox, window, cx| {
                track_pointer(shared, window);
                if levels.is_empty() {
                    return;
                }
                if moving {
                    window.request_animation_frame();
                }
                let height = f32::from(bounds.size.height);
                let painted: Vec<Painted> = levels
                    .iter()
                    .map(|&(ix, _, at)| {
                        let (x, d) = lane_x(spots[ix].lane);
                        let y = (at * height).clamp(d / 2. + 1., height - d / 2. - 1.);
                        Painted {
                            spot: ix,
                            center: bounds.origin + point(px(x), px(y)),
                            diameter: px(d),
                        }
                    })
                    .collect();
                // The lanes, then comments over them: one ordering each.
                for span in [false, true] {
                    window.paint_layer(bounds, |window| {
                        for (tick, &(ix, level, _)) in painted.iter().zip(&levels) {
                            let spot = &spots[ix];
                            if matches!(spot.lane, TickLane::Span) != span {
                                continue;
                            }
                            let strength = if hovered == Some(ix) { 1. } else { 0.72 };
                            let color = spot.color.alpha(spot.color.a * strength * level);
                            match seals.get(spot.seal as usize % seals.len().max(1)) {
                                Some(seal) => {
                                    let turn = ((spot.seal / 7) % 360) as f32
                                        * std::f32::consts::PI
                                        / 180.;
                                    paint_seal(
                                        seal,
                                        tick.center,
                                        tick.diameter,
                                        turn,
                                        color,
                                        window,
                                        cx,
                                    );
                                }
                                None => window.paint_quad(
                                    fill(
                                        Bounds::new(
                                            tick.center
                                                - point(tick.diameter / 2., tick.diameter / 2.),
                                            size(tick.diameter, tick.diameter),
                                        ),
                                        color,
                                    )
                                    .corner_radii(tick.diameter / 2.),
                                ),
                            }
                        }
                    });
                }
                listen(painted, spots.clone(), hitbox, editor.clone(), window);
            },
        )
        .absolute()
        .top_0()
        .right_0()
        .w(px(STRIP))
        .h_full()
        .into_any_element()
    }

    /// Where each tick sits on the bar (0–1).
    #[cfg(test)]
    pub(crate) fn tick_fractions(&mut self) -> Vec<f64> {
        self.refresh_ticks();
        let mut heights = self.heights.borrow_mut();
        let total = heights.total().max(1.);
        self.paint
            .ticks
            .spots
            .iter()
            .map(|s| heights.top(s.item) / total)
            .collect()
    }

    fn hover_tick(&mut self, tick: Option<(usize, DecorationKey)>, cx: &mut Context<Self>) {
        if self.paint.hover_tick != tick {
            self.paint.hover_tick = tick;
            cx.notify();
        }
    }

    /// Scrolls to a tick's decoration and tells the host.
    fn tick_clicked(
        &mut self,
        chapter: usize,
        key: DecorationKey,
        start: usize,
        cx: &mut Context<Self>,
    ) {
        if let Some(c) = self.book.chapters.get(chapter) {
            // By the editor's own heights (the list counts paragraphs it has
            // never laid out as empty), with a third of the view above it.
            let line = c
                .doc
                .line_of(start)
                .min(self.book.listed[chapter].saturating_sub(1));
            let item = self.book.line_item(chapter, line);
            let view = f64::from(f32::from(self.list.viewport_bounds().size.height));
            let mut heights = self.heights.borrow_mut();
            let y = (heights.top(item) - view / 3.).max(0.);
            let (item_ix, offset) = heights.item_at(y);
            drop(heights);
            self.list.scroll_to(ListOffset {
                item_ix,
                offset_in_item: px(offset as f32),
            });
        }
        cx.emit(DecorationEvent::TickClicked { chapter, key });
        cx.notify();
    }
}

/// Whether the pointer is over the window, for decorations the prose
/// scrolls under a still pointer (macOS has no hover state of its own for
/// a window: GPUI reports whether it is active). Registered every frame the
/// editor has decorations.
fn track_pointer(
    shared: std::rc::Rc<std::cell::RefCell<super::state::Shared>>,
    window: &mut Window,
) {
    {
        let shared = shared.clone();
        window.on_mouse_event(move |_: &MouseMoveEvent, phase, _, _| {
            if phase == DispatchPhase::Capture {
                shared.borrow_mut().pointer_in = true;
            }
        });
    }
    window.on_mouse_event(move |_: &MouseExitEvent, phase, _, _| {
        if phase == DispatchPhase::Capture {
            shared.borrow_mut().pointer_in = false;
        }
    });
}

/// The tick under `position`, if any (a little slack around small seals).
fn tick_at(painted: &[Painted], position: gpui::Point<Pixels>) -> Option<&Painted> {
    painted
        .iter()
        .rev()
        .filter(|t| {
            let r = (t.diameter / 2.).max(px(4.));
            (t.center.y - position.y).abs() <= r && (t.center.x - position.x).abs() <= px(STRIP)
        })
        .min_by_key(|t| (f32::from((t.center.y - position.y).abs()) * 100.) as i64)
}

fn listen(
    painted: Vec<Painted>,
    spots: Rc<[Spot]>,
    hitbox: Hitbox,
    editor: WeakEntity<ProseEditor>,
    window: &mut Window,
) {
    let painted = Rc::new(painted);
    {
        let (painted, spots, hitbox, editor) = (
            painted.clone(),
            spots.clone(),
            hitbox.clone(),
            editor.clone(),
        );
        window.on_mouse_event(move |event: &MouseMoveEvent, phase, window, cx: &mut App| {
            if phase != DispatchPhase::Bubble {
                return;
            }
            let tick = hitbox
                .is_hovered(window)
                .then(|| tick_at(&painted, event.position))
                .flatten()
                .map(|t| (spots[t.spot].chapter, spots[t.spot].key.clone()));
            if let Some(editor) = editor.upgrade() {
                let changed = editor.read(cx).paint.hover_tick != tick;
                if changed {
                    editor.update(cx, |editor, cx| editor.hover_tick(tick, cx));
                }
            }
        });
    }
    window.on_mouse_event(move |event: &MouseDownEvent, phase, window, cx: &mut App| {
        if phase != DispatchPhase::Bubble
            || event.button != MouseButton::Left
            || !hitbox.is_hovered(window)
        {
            return;
        }
        if let Some(tick) = tick_at(&painted, event.position) {
            let spot = &spots[tick.spot];
            let (chapter, key, start) = (spot.chapter, spot.key.clone(), spot.start);
            cx.stop_propagation();
            if let Some(editor) = editor.upgrade() {
                editor.update(cx, |editor, cx| {
                    editor.tick_clicked(chapter, key, start, cx)
                });
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tick_nearest_the_pointer_is_found() {
        let tick = |spot: usize, y: f32| Painted {
            spot,
            center: point(px(6.), px(y)),
            diameter: px(6.),
        };
        let painted = [tick(0, 100.), tick(1, 106.)];
        assert_eq!(tick_at(&painted, point(px(6.), px(105.))).unwrap().spot, 1);
        assert_eq!(tick_at(&painted, point(px(6.), px(99.))).unwrap().spot, 0);
        assert!(tick_at(&painted, point(px(6.), px(150.))).is_none());
    }
}
