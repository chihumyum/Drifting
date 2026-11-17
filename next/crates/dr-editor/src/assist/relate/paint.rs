//! Painting the relation lines: dr-ui's dry underline bent along each arc
//! ([`dr_ui::sand::line`]) and laid straight under each joined name, the
//! same brush as the stroke under every entity link. Rasterised once per
//! shape and kept as images: a line only changes shape when the two names
//! move apart or together, not when the prose scrolls under both.

use std::collections::HashMap;
use std::sync::Arc;

use gpui::{App, Bounds, Hsla, PathBuilder, RenderImage, Window, point, px, size};

use super::geom::Curve;

/// Across a line between names, px.
pub const LINE_BREADTH: f32 = 4.5;
/// Across the stroke under a joined name, px.
pub const NAME_BREADTH: f32 = 4.0;

/// One thing to lay with the brush, in window px.
#[derive(Clone, Debug, PartialEq)]
pub enum Path {
    Arc(Curve),
    Straight((f32, f32), (f32, f32)),
}

impl Path {
    fn start(&self) -> (f32, f32) {
        match self {
            Path::Arc(c) => c.from,
            Path::Straight(a, _) => *a,
        }
    }

    fn points(&self) -> Vec<(f32, f32)> {
        match self {
            Path::Arc(c) => dr_ui::sand::line::quadratic(c.from, c.ctrl, c.to),
            Path::Straight(a, b) => vec![*a, *b],
        }
    }

    /// The shape relative to its start, a quarter px at a time.
    fn shape(&self) -> [i32; 4] {
        let q = |v: f32| (v * 4.0).round() as i32;
        match self {
            Path::Arc(c) => [
                q(c.ctrl.0 - c.from.0),
                q(c.ctrl.1 - c.from.1),
                q(c.to.0 - c.from.0),
                q(c.to.1 - c.from.1),
            ],
            Path::Straight(a, b) => [i32::MIN, i32::MIN, q(b.0 - a.0), q(b.1 - a.1)],
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct Key {
    shape: [i32; 4],
    breadth: u32,
    scale: u32,
    rgb: [u8; 3],
    opacity: u8,
}

struct Cached {
    image: Arc<RenderImage>,
    /// The image's top-left from the path's start, and its size, px.
    offset: (f32, f32),
    size: (f32, f32),
    used: u64,
}

/// The images of the lines drawn lately.
#[derive(Default)]
pub struct Strokes {
    cache: HashMap<Key, Cached>,
    frame: u64,
}

/// What one frame lays: brushed paths with their breadth and opacity, and
/// the dashed line to a chosen counterpart.
#[derive(Clone, Debug, Default)]
pub struct Scene {
    pub paths: Vec<(Path, f32, f32)>,
    pub dashed: Option<Curve>,
}

impl Strokes {
    /// Lays `scene` in `rgb` (already on the paper), the dashed line in
    /// `dash`, then lets go of images no line used for a while.
    pub fn paint(&mut self, scene: &Scene, rgb: [u8; 3], dash: Hsla, window: &mut Window, cx: &App) {
        let _ = cx;
        self.frame += 1;
        let scale = window.scale_factor();
        for (path, breadth, opacity) in &scene.paths {
            let key = Key {
                shape: path.shape(),
                breadth: (breadth * 10.0) as u32,
                scale: (scale * 100.0) as u32,
                rgb,
                opacity: (opacity.clamp(0.0, 1.0) * 255.0) as u8,
            };
            let frame = self.frame;
            let cached = match self.cache.get_mut(&key) {
                Some(c) => c,
                None => {
                    let start = path.start();
                    let pts: Vec<(f32, f32)> = path
                        .points()
                        .into_iter()
                        .map(|(x, y)| (x - start.0, y - start.1))
                        .collect();
                    // The seed follows the shape, so a line keeps its grain.
                    let seed = key.shape.iter().fold(0x2545_f491u32, |h, v| {
                        h.rotate_left(5) ^ (*v as u32)
                    });
                    let Some(line) = dr_ui::sand::line::along(&pts, *breadth, scale, seed) else {
                        continue;
                    };
                    let image = line.image(rgb, f32::from(key.opacity) / 255.0);
                    self.cache.entry(key).or_insert(Cached {
                        image,
                        offset: line.origin,
                        size: (
                            line.stroke.width as f32 / scale,
                            line.stroke.height as f32 / scale,
                        ),
                        used: frame,
                    })
                }
            };
            cached.used = frame;
            let start = path.start();
            let at = Bounds::new(
                point(px(start.0 + cached.offset.0), px(start.1 + cached.offset.1)),
                size(px(cached.size.0), px(cached.size.1)),
            );
            let _ = window.paint_image(
                at,
                at,
                gpui::Corners::default(),
                cached.image.clone(),
                0,
                false,
            );
        }
        if let Some(c) = scene.dashed {
            let mut b = PathBuilder::stroke(px(1.1)).dash_array(&[px(3.), px(4.)]);
            b.move_to(point(px(c.from.0), px(c.from.1)));
            b.curve_to(point(px(c.to.0), px(c.to.1)), point(px(c.ctrl.0), px(c.ctrl.1)));
            if let Ok(path) = b.build() {
                window.paint_path(path, dash);
            }
        }
        // Images unused for a second or so of frames go.
        let now = self.frame;
        let stale: Vec<Key> = self
            .cache
            .iter()
            .filter(|(_, c)| now.saturating_sub(c.used) > 90)
            .map(|(k, _)| *k)
            .collect();
        for key in stale {
            if let Some(c) = self.cache.remove(&key) {
                let _ = window.drop_image(c.image);
            }
        }
    }

    /// Lets go of every image (the lines are gone).
    pub fn clear(&mut self, window: &mut Window) {
        for (_, c) in self.cache.drain() {
            let _ = window.drop_image(c.image);
        }
    }

    pub fn is_empty(&self) -> bool {
        self.cache.is_empty()
    }
}
