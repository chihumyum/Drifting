//! Sand textures and how a stroke is laid along one visual row.
//!
//! The host hands the editor its textures (gpui-prose ships none and knows
//! no colours): a white alpha mask, tinted when painted, like Drifting's
//! `hl.png` (the dry highlighter swash under a comment), `hl-hot.png` (the
//! same swash, sparser, for a comment pointed at), `ul.png` (the dry
//! underline) and the six `blob-*` seals of the scrollbar ticks.
//!
//! GPUI tints monochrome sprites only through SVG, and rasterises an SVG at
//! its own aspect ratio. So a texture is wrapped in a small SVG (a PNG as an
//! embedded image, or the host's own SVG elements), and a stroke longer than
//! the texture's natural width uses a variant stretched by a whole number of
//! quarters: a handful of rasterisations per row height, each cached by the
//! sprite atlas.
//!
//! A row shorter than the stroke's natural width is cut from the stroke's
//! start (at an offset seeded by the decoration, so it never jumps), and
//! its last 12 px are the stroke's own dry end; a longer row stretches the
//! whole stroke. This is the old client's `swashFit`.

use std::{cell::RefCell, fmt::Write as _, sync::Arc};

use gpui::{
    App, Bounds, ContentMask, Hsla, Pixels, Point, Radians, SharedString, TransformationMatrix,
    Window, fill, point, px, size,
};

/// How many pixels at the end of a stroke are its own dry, thinning end.
pub const TAIL: f32 = 12.;
/// How far into the stroke a short row may start (texture pixels).
const MAX_CUT: f32 = 48.;

enum Source {
    /// A PNG, base64-encoded, embedded as an `<image>`.
    Png(String),
    /// SVG elements drawn in a `0 0 width height` box.
    Svg(String),
}

/// A stretched variant: its stretch in quarters, atlas key and SVG.
type Variant = (u16, SharedString, Arc<[u8]>);

/// A sand texture: a white alpha mask the editor tints.
pub struct SandTexture {
    key: SharedString,
    width: f32,
    height: f32,
    source: Source,
    /// Variants made so far: stretch in quarters → atlas key and SVG bytes.
    variants: RefCell<Vec<Variant>>,
}

impl std::fmt::Debug for SandTexture {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SandTexture")
            .field("key", &self.key)
            .field("width", &self.width)
            .field("height", &self.height)
            .finish()
    }
}

impl SandTexture {
    /// A texture from a PNG whose alpha is the grain (white on transparent).
    /// `key` names it in GPUI's sprite atlas and must be unique per texture.
    /// `None` if the bytes are not a PNG.
    pub fn from_png(key: impl Into<SharedString>, png: &[u8]) -> Option<SandTexture> {
        let (width, height) = png_size(png)?;
        Some(SandTexture {
            key: key.into(),
            width: width as f32,
            height: height as f32,
            source: Source::Png(base64(png)),
            variants: RefCell::default(),
        })
    }

    /// A texture drawn by SVG elements (`<circle …/>` and so on, white or
    /// any opaque colour: only alpha counts) in a `width` × `height` box.
    pub fn from_svg(
        key: impl Into<SharedString>,
        width: f32,
        height: f32,
        elements: impl Into<String>,
    ) -> SandTexture {
        SandTexture {
            key: key.into(),
            width,
            height,
            source: Source::Svg(elements.into()),
            variants: RefCell::default(),
        }
    }

    /// The natural size, in texture pixels.
    pub fn size(&self) -> (f32, f32) {
        (self.width, self.height)
    }

    /// The atlas key and SVG of the texture stretched `quarters / 4` times
    /// as wide.
    fn variant(&self, quarters: u16) -> (SharedString, Arc<[u8]>) {
        if let Some((_, key, bytes)) = self
            .variants
            .borrow()
            .iter()
            .find(|(q, _, _)| *q == quarters)
        {
            return (key.clone(), bytes.clone());
        }
        let stretch = f32::from(quarters) / 4.;
        let (w, h) = (self.width * stretch, self.height);
        let mut svg = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="{w}" height="{h}" viewBox="0 0 {w} {h}">"#
        );
        match &self.source {
            Source::Png(data) => {
                let _ = write!(
                    svg,
                    r#"<image width="{w}" height="{h}" preserveAspectRatio="none" xlink:href="data:image/png;base64,{data}"/>"#
                );
            }
            Source::Svg(elements) => {
                let _ = write!(svg, r#"<g transform="scale({stretch} 1)">{elements}</g>"#);
            }
        }
        svg.push_str("</svg>");
        let key = SharedString::from(format!("{}@{quarters}q.svg", self.key));
        let bytes: Arc<[u8]> = Arc::from(svg.into_bytes());
        self.variants
            .borrow_mut()
            .push((quarters, key.clone(), bytes.clone()));
        (key, bytes)
    }
}

/// How a stroke fits a row `width` × `height`: the stretch (in quarters),
/// the stroke's painted width, and how far left of the row it starts.
pub(crate) fn fit(tex: &SandTexture, width: f32, height: f32, seed: u32) -> (u16, f32, f32) {
    let scale = height / tex.height;
    let natural = tex.width * scale;
    if width > natural {
        let quarters = ((width / natural) * 4.).ceil().min(64.) as u16;
        (quarters, natural * f32::from(quarters) / 4., 0.)
    } else {
        let source = width / scale;
        let room = MAX_CUT.min(tex.width - source).max(0.);
        let offset = (unit(seed) * room).floor() * scale;
        (4, natural, offset)
    }
}

/// Lays `tex` along `rect` in `color`, drawn up to the window x `drawn_to`
/// (a stroke being drawn along its rows; `Pixels::MAX` when done).
pub(crate) fn paint_stroke(
    tex: &SandTexture,
    rect: Bounds<Pixels>,
    drawn_to: Pixels,
    color: Hsla,
    seed: u32,
    window: &mut Window,
    cx: &App,
) {
    let (w, h) = (f32::from(rect.size.width), f32::from(rect.size.height));
    if w < 0.5 || h < 0.5 || color.a <= 0.003 || drawn_to <= rect.left() {
        return;
    }
    let (quarters, stroke_w, offset) = fit(tex, w, h, seed);
    let (path, bytes) = tex.variant(quarters);
    let (top, bottom) = (rect.top(), rect.bottom());
    let (x0, x1) = (rect.left(), rect.right());
    let tail = px(TAIL.min(w / 3.));
    let end = drawn_to.min(x1);
    let stroke = |left: Pixels| Bounds::new(point(left, top), size(px(stroke_w), rect.size.height));
    let lay = |mask: Bounds<Pixels>, at: Bounds<Pixels>, window: &mut Window| {
        if mask.size.width <= px(0.) {
            return;
        }
        window.with_content_mask(Some(ContentMask { bounds: mask }), |window| {
            let _ = window.paint_svg(
                at,
                path.clone(),
                Some(&bytes),
                TransformationMatrix::unit(),
                color,
                cx,
            );
        });
    };
    // The stroke from its start (or the seeded cut), up to its dry end.
    lay(
        Bounds::from_corners(point(x0, top), point((x1 - tail).min(end), bottom)),
        stroke(x0 - px(offset)),
        window,
    );
    // The stroke's own end, so every row thins out where it stops.
    if end > x1 - tail {
        lay(
            Bounds::from_corners(point(x1 - tail, top), point(end, bottom)),
            stroke(x1 - px(stroke_w)),
            window,
        );
    }
}

/// A seal (a scrollbar tick) of `diameter` centred on `center`, turned by
/// `turn` radians.
pub(crate) fn paint_seal(
    tex: &SandTexture,
    center: Point<Pixels>,
    diameter: Pixels,
    turn: f32,
    color: Hsla,
    window: &mut Window,
    cx: &App,
) {
    let (path, bytes) = tex.variant(4);
    let bounds = Bounds::new(
        center - point(diameter / 2., diameter / 2.),
        size(diameter, diameter),
    );
    let scale = window.scale_factor();
    let matrix = TransformationMatrix::unit()
        .translate(center.scale(scale))
        .rotate(Radians(turn))
        .translate(center.scale(-scale));
    let _ = window.paint_svg(bounds, path, Some(&bytes), matrix, color, cx);
}

/// A dotted line of grains from `x0` to `x1` at `y`: the suggestion's
/// underline when the host gives no texture.
pub(crate) fn paint_dots(
    x0: Pixels,
    x1: Pixels,
    y: Pixels,
    drawn_to: Pixels,
    color: Hsla,
    seed: u32,
    window: &mut Window,
) {
    let end = x1.min(drawn_to);
    let mut x = x0 + px(0.6);
    let mut i = seed;
    while x + px(1.2) <= end {
        i = i.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let jitter = ((i >> 24) % 5) as f32 * 0.2 - 0.4;
        window.paint_quad(
            fill(
                Bounds::new(point(x, y + px(jitter)), size(px(1.3), px(1.3))),
                color,
            )
            .corner_radii(px(0.65)),
        );
        x += px(3.2);
    }
}

/// A stable 32-bit hash (FNV-1a) of a decoration id and a few numbers.
pub(crate) fn seed(id: &str, salt: u32) -> u32 {
    let mut hash: u32 = 2_166_136_261;
    for byte in id.bytes().chain(salt.to_le_bytes()) {
        hash ^= u32::from(byte);
        hash = hash.wrapping_mul(16_777_619);
    }
    hash
}

/// A number in 0..1 from a seed (mulberry32).
pub(crate) fn unit(seed: u32) -> f32 {
    let mut t = seed.wrapping_add(0x6d2b_79f5);
    t = (t ^ (t >> 15)).wrapping_mul(1 | t);
    t = (t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t))) ^ t;
    ((t ^ (t >> 14)) as f64 / 4_294_967_296.0) as f32
}

fn png_size(png: &[u8]) -> Option<(u32, u32)> {
    const SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
    if png.len() < 24 || &png[..8] != SIGNATURE {
        return None;
    }
    let w = u32::from_be_bytes([png[16], png[17], png[18], png[19]]);
    let h = u32::from_be_bytes([png[20], png[21], png[22], png[23]]);
    (w > 0 && h > 0).then_some((w, h))
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for (i, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            if i <= chunk.len() {
                out.push(ALPHABET[(n >> shift) as usize & 63] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_the_standard_alphabet() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn short_rows_cut_from_the_start_long_rows_stretch() {
        // The swash's own proportions: 720 × 64.
        let tex = SandTexture::from_svg("t", 720., 64., "");
        // A 32 px row: natural width 360 px.
        let (q, w, offset) = fit(&tex, 100., 32., seed("c1", 0));
        assert_eq!((q, w), (4, 360.));
        assert!((0. ..=24.).contains(&offset), "{offset}");
        // The same decoration and row cut at the same place every time.
        assert_eq!(fit(&tex, 100., 32., seed("c1", 0)).2, offset);
        // Longer than natural: stretched by whole quarters, never short.
        let (q, w, offset) = fit(&tex, 500., 32., 7);
        assert_eq!((q, offset), (6, 0.));
        assert!(w >= 500.);
        // Variants are made once and keyed by their stretch.
        let (a, _) = tex.variant(6);
        let (b, _) = tex.variant(6);
        assert_eq!(a, b);
        assert_eq!(tex.variants.borrow().len(), 1);
        assert!(a.ends_with("@6q.svg"));
    }

    #[test]
    fn pngs_are_read_by_their_header() {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend(720u32.to_be_bytes());
        png.extend(26u32.to_be_bytes());
        let tex = SandTexture::from_png("ul", &png).unwrap();
        assert_eq!(tex.size(), (720., 26.));
        assert!(SandTexture::from_png("x", b"not a png at all, no").is_none());
        let (_, svg) = tex.variant(4);
        let svg = std::str::from_utf8(&svg).unwrap();
        assert!(svg.contains("data:image/png;base64,iVBORw0KGgo"));
        assert!(svg.contains(r#"preserveAspectRatio="none""#));
    }
}
