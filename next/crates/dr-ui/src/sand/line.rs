//! The dry underline laid along a path: the stroke under an entity link
//! (`ul.png`, [`super::SandMask::Ul`]) bent to follow a curve, so a line
//! drawn between two names is the same brush as the stroke under them
//! (`kernel-v5.md` §19, 「指针停在名字上」).
//!
//! The stroke is fitted to the path's length the way the editor fits it to
//! a row (gpui-prose's `sand::fit`, the old client's `swashFit`): a path
//! longer than the stroke's natural length stretches the whole stroke; a
//! shorter one is cut from the stroke's start, at an offset the seed fixes,
//! and its last 12 px are the stroke's own dry end. Across the path the
//! mask's rows are laid from one side to the other, so its grain and its
//! parted hairs follow the curve.
//!
//! Rasterised at the device scale into a [`Stroke`] (straight alpha, with
//! when the brush reached each pixel), painted as an image by the caller.
//! The shape only depends on the path relative to its own start, so a path
//! moved as a whole (the prose scrolled) keeps its pixels.

use std::sync::OnceLock;

use super::SandMask;
use super::stroke::Stroke;

/// How many px at the end of a short stroke are its own dry end.
const TAIL: f32 = 12.0;
/// How far into the mask a short stroke may start, in mask pixels.
const MAX_CUT: f32 = 48.0;

/// The mask's alpha, read once.
struct Mask {
    width: usize,
    height: usize,
    alpha: Vec<f32>,
}

fn mask() -> &'static Mask {
    static MASK: OnceLock<Mask> = OnceLock::new();
    MASK.get_or_init(|| {
        let image =
            image::load_from_memory_with_format(SandMask::Ul.png(), image::ImageFormat::Png)
                .expect("dr-ui's ul.png is a PNG")
                .to_rgba8();
        let (width, height) = (image.width() as usize, image.height() as usize);
        let alpha = image.pixels().map(|p| f32::from(p.0[3]) / 255.0).collect();
        Mask {
            width,
            height,
            alpha,
        }
    })
}

impl Mask {
    fn at(&self, x: usize, y: usize) -> f32 {
        self.alpha[y.min(self.height - 1) * self.width + x.min(self.width - 1)]
    }

    /// Bilinear sample at mask coordinates.
    fn sample(&self, u: f32, v: f32) -> f32 {
        let u = u.clamp(0.0, (self.width - 1) as f32);
        let v = v.clamp(0.0, (self.height - 1) as f32);
        let (x0, y0) = (u.floor() as usize, v.floor() as usize);
        let (fx, fy) = (u - x0 as f32, v - y0 as f32);
        let top = self.at(x0, y0) * (1.0 - fx) + self.at(x0 + 1, y0) * fx;
        let bottom = self.at(x0, y0 + 1) * (1.0 - fx) + self.at(x0 + 1, y0 + 1) * fx;
        top * (1.0 - fy) + bottom * fy
    }
}

/// A line rasterised for one path.
#[derive(Clone, Debug)]
pub struct Line {
    /// The pixels; `arrive` runs 0 → 1 from the path's start to its end.
    pub stroke: Stroke,
    /// Where the image's top-left corner is, in the path's coordinates (px).
    pub origin: (f32, f32),
}

impl Line {
    /// The whole line in `rgb` at `opacity`, as an image GPUI paints
    /// (`Window::paint_image`), `stroke.width / scale` px wide.
    pub fn image(&self, rgb: [u8; 3], opacity: f32) -> std::sync::Arc<gpui::RenderImage> {
        let image = self.stroke.paint(rgb, 1.0, opacity);
        std::sync::Arc::new(gpui::RenderImage::new(smallvec::SmallVec::from_elem(
            image::Frame::new(image),
            1,
        )))
    }
}

fn unit(seed: u32) -> f32 {
    let mut h = seed.wrapping_mul(0x9e37_79b9) ^ 0x85eb_ca6b;
    h = (h ^ (h >> 15)).wrapping_mul(0x2c1b_3c6d);
    h = (h ^ (h >> 12)).wrapping_mul(0x297a_2d39);
    ((h ^ (h >> 15)) as f64 / 4_294_967_296.0) as f32
}

/// The dry underline, `height` px across, along `points` (px; at least two,
/// in order), at `scale` device px per px. `seed` picks where a short
/// stroke is cut from. `None` for a path shorter than a pixel.
pub fn along(points: &[(f32, f32)], height: f32, scale: f32, seed: u32) -> Option<Line> {
    if points.len() < 2 || height <= 0.0 || scale <= 0.0 {
        return None;
    }
    let mut lengths = Vec::with_capacity(points.len());
    lengths.push(0.0f32);
    for pair in points.windows(2) {
        let d = (pair[1].0 - pair[0].0).hypot(pair[1].1 - pair[0].1);
        lengths.push(lengths.last().copied().unwrap_or(0.0) + d);
    }
    let total = *lengths.last().expect("two points");
    if total < 1.0 {
        return None;
    }
    let m = mask();
    let (tex_w, tex_h) = (m.width as f32, m.height as f32);
    // Px of path per mask pixel.
    let k = height / tex_h;
    let natural = tex_w * k;
    let tail = TAIL.min(total / 3.0);
    let offset = if total > natural {
        0.0
    } else {
        let room = MAX_CUT.min(tex_w - total / k).max(0.0);
        (unit(seed) * room).floor()
    };
    let tex_u = |s: f32| -> f32 {
        if total > natural {
            s / total * (tex_w - 1.0)
        } else if s <= total - tail {
            offset + s / k
        } else {
            tex_w - 1.0 - (total - s) / k
        }
    };

    let reach = height / 2.0 + 2.0;
    let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    for &(x, y) in points {
        x0 = x0.min(x);
        y0 = y0.min(y);
        x1 = x1.max(x);
        y1 = y1.max(y);
    }
    let origin = (x0 - reach, y0 - reach);
    let pw = (((x1 - x0) + reach * 2.0) * scale).ceil().max(1.0) as usize;
    let ph = (((y1 - y0) + reach * 2.0) * scale).ceil().max(1.0) as usize;
    let mut alpha = vec![0.0f32; pw * ph];
    let mut arrive = vec![2.0f32; pw * ph];

    let step = 0.5 / scale;
    let mut seg = 0usize;
    let mut s = 0.0f32;
    while s <= total {
        while seg + 2 < lengths.len() && lengths[seg + 1] < s {
            seg += 1;
        }
        let (a, b) = (points[seg], points[seg + 1]);
        let len = (lengths[seg + 1] - lengths[seg]).max(f32::EPSILON);
        let t = ((s - lengths[seg]) / len).clamp(0.0, 1.0);
        let (px_, py_) = (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t);
        let (tx, ty) = ((b.0 - a.0) / len, (b.1 - a.1) / len);
        let (nx, ny) = (-ty, tx);
        let u = tex_u(s);
        let when = s / total;
        let mut v = -height / 2.0;
        while v <= height / 2.0 {
            let value = m.sample(u, (v / height + 0.5) * (tex_h - 1.0));
            if value > 0.0 {
                let gx = ((px_ + nx * v - origin.0) * scale).floor();
                let gy = ((py_ + ny * v - origin.1) * scale).floor();
                if gx >= 0.0 && gy >= 0.0 && (gx as usize) < pw && (gy as usize) < ph {
                    let at = gy as usize * pw + gx as usize;
                    if value > alpha[at] {
                        alpha[at] = value;
                    }
                    if when < arrive[at] {
                        arrive[at] = when;
                    }
                }
            }
            v += step;
        }
        s += step;
    }
    Some(Line {
        stroke: Stroke {
            width: pw as u32,
            height: ph as u32,
            alpha,
            arrive,
        },
        origin,
    })
}

/// A quadratic curve from `a` through control `c` to `b` as a polyline
/// with a point every 2 px or so.
pub fn quadratic(a: (f32, f32), c: (f32, f32), b: (f32, f32)) -> Vec<(f32, f32)> {
    let rough = (c.0 - a.0).hypot(c.1 - a.1) + (b.0 - c.0).hypot(b.1 - c.1);
    let n = (rough / 2.0).ceil().clamp(2.0, 512.0) as usize;
    (0..=n)
        .map(|i| {
            let t = i as f32 / n as f32;
            let u = 1.0 - t;
            (
                u * u * a.0 + 2.0 * u * t * c.0 + t * t * b.0,
                u * u * a.1 + 2.0 * u * t * c.1 + t * t * b.1,
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ink(line: &Line) -> f32 {
        line.stroke.alpha.iter().sum()
    }

    #[test]
    fn a_line_has_the_masks_grain_and_covers_its_path() {
        let line = along(&[(0.0, 0.0), (120.0, 0.0)], 4.0, 2.0, 7).expect("long enough");
        assert!(ink(&line) > 50.0, "the stroke is there");
        // As wide as the path plus its reach, at the device scale.
        assert_eq!(line.stroke.width, ((120.0 + 8.0) * 2.0f32).ceil() as u32);
        assert_eq!(line.origin, (-4.0, -4.0));
        // Dry grain: not every pixel inside the band is full.
        let full = line.stroke.alpha.iter().filter(|a| **a > 0.99).count();
        let some = line.stroke.alpha.iter().filter(|a| **a > 0.0).count();
        assert!(full < some, "a dry stroke, not a solid band");
    }

    #[test]
    fn the_same_path_and_seed_draw_the_same_stroke() {
        let curve = quadratic((0.0, 0.0), (40.0, 30.0), (90.0, 60.0));
        let a = along(&curve, 4.0, 2.0, 3).unwrap();
        let b = along(&curve, 4.0, 2.0, 3).unwrap();
        assert_eq!(a.stroke.alpha, b.stroke.alpha);
        assert_eq!(a.origin, b.origin);
        // A short path is cut from where its seed says.
        let short = [(0.0, 0.0), (60.0, 0.0)];
        let cuts: std::collections::BTreeSet<u32> = (0..8)
            .map(|seed| {
                let line = along(&short, 4.0, 1.0, seed).unwrap();
                (ink(&line) * 10.0) as u32
            })
            .collect();
        assert!(cuts.len() > 1, "different seeds cut different stretches");
    }

    #[test]
    fn arrival_runs_along_the_path() {
        let line = along(&[(0.0, 0.0), (200.0, 0.0)], 4.0, 1.0, 1).unwrap();
        let w = line.stroke.width as usize;
        let row = line.stroke.height as usize / 2;
        let first = (0..w)
            .find(|x| line.stroke.alpha[row * w + x] > 0.0)
            .expect("ink on the middle row");
        let last = (0..w)
            .rev()
            .find(|x| line.stroke.alpha[row * w + x] > 0.0)
            .unwrap();
        assert!(line.stroke.arrive[row * w + first] < line.stroke.arrive[row * w + last]);
    }

    #[test]
    fn a_point_is_no_line() {
        assert!(along(&[(3.0, 3.0), (3.2, 3.0)], 4.0, 2.0, 0).is_none());
        assert!(along(&[(3.0, 3.0)], 4.0, 2.0, 0).is_none());
    }
}
