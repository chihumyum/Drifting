//! 砂笔图标 in a colour: three ways to tint the 96px white masks.
//!
//! 1. 内嵌位图: an SVG that only holds the PNG; GPUI's `svg()` rasterizes it
//!    once per size into an alpha sprite and tints it when it draws, so a
//!    colour change costs nothing.
//! 2. 转矢量: the mask traced into filled outlines at three alpha levels.
//! 3. 预着色: the mask turned into a coloured bitmap per colour, cached.

use std::{collections::HashMap, sync::Arc, time::Instant};

use gpui::RenderImage;
use image::RgbaImage;

use crate::{assets::Mask, glass::render_image, theme::Rgb};

/// Alpha thresholds of the traced layers and each layer's opacity, so the
/// layers stacked give 1/3, 2/3 and full ink.
const LEVELS: [(u8, f32); 3] = [(51, 0.333), (128, 0.4925), (204, 1.0)];
/// How far a traced outline may stray from the pixel boundary, in mask px.
const SIMPLIFY: f32 = 0.6;

/// Pixel-edge loops round every pixel at or above `threshold`, clockwise.
fn trace_loops(mask: &Mask, threshold: u8) -> Vec<Vec<(i32, i32)>> {
    let w = mask.width as i32;
    let h = mask.height as i32;
    let inside = |x: i32, y: i32| {
        x >= 0 && y >= 0 && x < w && y < h && mask.alpha[(y * w + x) as usize] >= threshold
    };
    // Directed edges keyed by their start corner; a corner may start two.
    let mut edges: HashMap<(i32, i32), Vec<(i32, i32)>> = HashMap::new();
    let mut add = |a: (i32, i32), b: (i32, i32)| edges.entry(a).or_default().push(b);
    for y in 0..h {
        for x in 0..w {
            if !inside(x, y) {
                continue;
            }
            if !inside(x, y - 1) {
                add((x, y), (x + 1, y));
            }
            if !inside(x + 1, y) {
                add((x + 1, y), (x + 1, y + 1));
            }
            if !inside(x, y + 1) {
                add((x + 1, y + 1), (x, y + 1));
            }
            if !inside(x - 1, y) {
                add((x, y + 1), (x, y));
            }
        }
    }
    let mut loops = Vec::new();
    while let Some((&start, _)) = edges.iter().next() {
        let mut lp = vec![start];
        let mut at = start;
        let mut prev_dir = (0, 0);
        while let Some(nexts) = edges.get_mut(&at) {
            // At a corner two loops touch: keep turning the same way.
            let pick = if nexts.len() > 1 {
                let right = (-prev_dir.1, prev_dir.0);
                nexts
                    .iter()
                    .position(|&n| (n.0 - at.0, n.1 - at.1) == right)
                    .unwrap_or(0)
            } else {
                0
            };
            let next = nexts.swap_remove(pick);
            if nexts.is_empty() {
                edges.remove(&at);
            }
            prev_dir = (next.0 - at.0, next.1 - at.1);
            at = next;
            if at == start {
                break;
            }
            lp.push(at);
        }
        if lp.len() >= 3 {
            loops.push(lp);
        }
    }
    loops
}

/// Ramer–Douglas–Peucker on a closed loop.
fn simplify(points: &[(i32, i32)], epsilon: f32) -> Vec<(f32, f32)> {
    fn rdp(points: &[(f32, f32)], epsilon: f32, out: &mut Vec<(f32, f32)>) {
        let (a, b) = (points[0], points[points.len() - 1]);
        let (dx, dy) = (b.0 - a.0, b.1 - a.1);
        let len = (dx * dx + dy * dy).sqrt().max(1e-6);
        let mut worst = (0.0, 0);
        for (i, p) in points.iter().enumerate().take(points.len() - 1).skip(1) {
            let d = ((p.0 - a.0) * dy - (p.1 - a.1) * dx).abs() / len;
            if d > worst.0 {
                worst = (d, i);
            }
        }
        if worst.0 > epsilon {
            rdp(&points[..=worst.1], epsilon, out);
            out.pop();
            rdp(&points[worst.1..], epsilon, out);
        } else {
            out.push(a);
            out.push(b);
        }
    }
    let mut pts: Vec<(f32, f32)> = points.iter().map(|&(x, y)| (x as f32, y as f32)).collect();
    pts.push(pts[0]);
    // A closed loop starts and ends on one point: split it at the point
    // farthest from there and simplify the two halves.
    let far = pts
        .iter()
        .enumerate()
        .max_by(|a, b| {
            let d = |p: &(f32, f32)| (p.0 - pts[0].0).powi(2) + (p.1 - pts[0].1).powi(2);
            d(a.1).total_cmp(&d(b.1))
        })
        .map_or(0, |(i, _)| i);
    if far == 0 || far == pts.len() - 1 {
        return Vec::new();
    }
    let mut out = Vec::new();
    rdp(&pts[..=far], epsilon, &mut out);
    out.pop();
    rdp(&pts[far..], epsilon, &mut out);
    out.pop();
    out
}

#[derive(Clone, Copy, Default, Debug)]
pub struct VectorStats {
    pub loops: usize,
    pub points: usize,
    pub bytes: usize,
}

/// The mask as an SVG of filled outlines at three levels.
pub fn vectorize(mask: &Mask) -> (Vec<u8>, VectorStats) {
    let mut svg = format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">"#,
        w = mask.width,
        h = mask.height
    );
    let mut stats = VectorStats::default();
    for (threshold, opacity) in LEVELS {
        let loops = trace_loops(mask, threshold);
        if loops.is_empty() {
            continue;
        }
        let mut d = String::new();
        for lp in &loops {
            let pts = simplify(lp, SIMPLIFY);
            if pts.len() < 3 {
                continue;
            }
            stats.loops += 1;
            stats.points += pts.len();
            for (i, (x, y)) in pts.iter().enumerate() {
                d.push(if i == 0 { 'M' } else { 'L' });
                d.push_str(&format!("{x} {y}"));
            }
            d.push('Z');
        }
        svg.push_str(&format!(
            r#"<path fill="white" fill-opacity="{opacity}" fill-rule="evenodd" d="{d}"/>"#
        ));
    }
    svg.push_str("</svg>");
    stats.bytes = svg.len();
    (svg.into_bytes(), stats)
}

/// 预着色: the mask in one colour, straight-alpha BGRA.
pub fn tint(mask: &Mask, color: Rgb, opacity: f32) -> RgbaImage {
    let [r, g, b] = color.to_u8();
    let mut image = RgbaImage::new(mask.width, mask.height);
    for (pixel, &a) in image.pixels_mut().zip(mask.alpha.iter()) {
        pixel.0 = [b, g, r, (a as f32 * opacity + 0.5) as u8];
    }
    image
}

/// Pre-tinted bitmaps, one per icon and colour.
#[derive(Default)]
pub struct TintCache {
    images: HashMap<(String, [u8; 3]), Arc<RenderImage>>,
    pub bytes: usize,
    pub tint_ms: f64,
    pub tints: usize,
}

impl TintCache {
    pub fn get(&mut self, name: &str, mask: &Mask, color: Rgb) -> Arc<RenderImage> {
        let key = (name.to_string(), color.to_u8());
        if let Some(image) = self.images.get(&key) {
            return image.clone();
        }
        let started = Instant::now();
        let image = render_image(tint(mask, color, 1.0));
        self.tint_ms += started.elapsed().as_secs_f64() * 1000.0;
        self.tints += 1;
        self.bytes += (mask.width * mask.height * 4) as usize;
        self.images.insert(key, image.clone());
        image
    }

    pub fn len(&self) -> usize {
        self.images.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(size: u32, from: u32, to: u32) -> Mask {
        let mut alpha = vec![0u8; (size * size) as usize];
        for y in from..to {
            for x in from..to {
                alpha[(y * size + x) as usize] = 255;
            }
        }
        Mask {
            width: size,
            height: size,
            alpha,
            png: Arc::new(Vec::new()),
        }
    }

    #[test]
    fn a_filled_square_traces_to_one_four_corner_loop() {
        let mask = square(8, 2, 6);
        let loops = trace_loops(&mask, 128);
        assert_eq!(loops.len(), 1);
        let pts = simplify(&loops[0], SIMPLIFY);
        // The four corners, and the loop's starting point on an edge.
        assert!(pts.len() <= 5, "{pts:?}");
        for corner in [(2.0, 2.0), (6.0, 2.0), (6.0, 6.0), (2.0, 6.0)] {
            assert!(pts.contains(&corner), "{pts:?}");
        }
    }

    #[test]
    fn tinting_keeps_the_mask_as_alpha() {
        let mask = square(4, 1, 3);
        let image = tint(&mask, Rgb::hex(0x336699), 1.0);
        assert_eq!(image.get_pixel(1, 1).0, [0x99, 0x66, 0x33, 255]);
        assert_eq!(image.get_pixel(0, 0).0[3], 0);
    }
}
