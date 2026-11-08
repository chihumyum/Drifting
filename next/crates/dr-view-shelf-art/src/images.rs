//! Pixels to GPUI images: straight RGBA as GPUI's BGRA, and alpha masks in
//! a colour (GPUI cannot tint an image, so the colour is baked in; a theme
//! change makes a new one).

use std::sync::Arc;

use dr_ui::tokens::color::Rgb;
use gpui::RenderImage;
use image::{Frame, RgbaImage};
use smallvec::SmallVec;

fn frame(image: RgbaImage) -> Arc<RenderImage> {
    Arc::new(RenderImage::new(SmallVec::from_elem(Frame::new(image), 1)))
}

/// `width` × `height` straight RGBA bytes.
pub fn rgba(bytes: &[u8], width: usize, height: usize) -> Arc<RenderImage> {
    let mut image = RgbaImage::new(width as u32, height as u32);
    let (pixels, _) = bytes.as_chunks::<4>();
    for (dst, src) in image.pixels_mut().zip(pixels) {
        dst.0 = [src[2], src[1], src[0], src[3]];
    }
    frame(image)
}

fn channel(c: f32) -> u8 {
    (c.clamp(0.0, 1.0) * 255.0).round() as u8
}

/// An alpha mask (0–255) in `color` at `opacity`.
pub fn tinted(
    alpha: &[u8],
    width: usize,
    height: usize,
    color: Rgb,
    opacity: f32,
) -> Arc<RenderImage> {
    let (r, g, b) = (channel(color.r), channel(color.g), channel(color.b));
    let mut image = RgbaImage::new(width as u32, height as u32);
    for (dst, &a) in image.pixels_mut().zip(alpha) {
        dst.0 = [b, g, r, (f32::from(a) * opacity).round() as u8];
    }
    frame(image)
}

/// Masks (0–1) laid one over another, each in its colour, at `opacity`:
/// straight alpha over a transparent ground.
pub fn layered(
    masks: &[(&[f32], Rgb)],
    width: usize,
    height: usize,
    opacity: f32,
) -> Arc<RenderImage> {
    let mut px = vec![[0f32; 4]; width * height];
    for (mask, color) in masks {
        for (p, &a) in px.iter_mut().zip(mask.iter()) {
            let a = a.clamp(0.0, 1.0) * opacity;
            if a <= 0.0 {
                continue;
            }
            // `a` of colour over what is there (straight alpha).
            let out = a + p[3] * (1.0 - a);
            for (k, c) in [color.r, color.g, color.b].into_iter().enumerate() {
                p[k] = (c * a + p[k] * p[3] * (1.0 - a)) / out;
            }
            p[3] = out;
        }
    }
    let mut image = RgbaImage::new(width as u32, height as u32);
    for (dst, p) in image.pixels_mut().zip(px) {
        dst.0 = [channel(p[2]), channel(p[1]), channel(p[0]), channel(p[3])];
    }
    frame(image)
}
