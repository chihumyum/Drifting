//! The picture itself: an image decoded, or a PDF's pages rendered with
//! hayro, both off the main thread, both handed to GPUI as one bitmap.
//!
//! - An image is read from its display variant when the library has one
//!   (bounded by the image pipeline), otherwise from its source, and held
//!   under 4096 px a side.
//! - A PDF is read from its source and opened once; each page is rendered
//!   at the size it is shown at (see [`crate::viewport::render_scale`]) on
//!   white, as paper.
//! - PDF fonts: the fourteen standard ones come with hayro; a font the file
//!   does not carry falls back to the nearest standard one, and for
//!   Chinese, Japanese and Korean text to Drifting Sans, the interface's own
//!   face (Noto Sans SC's glyphs), so text that names a system font such as
//!   `STSong-Light` is still drawn.
//!
//! Why hayro and not pdfium-render: docs/rust-rewrite/modules/m19-materials.md.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use dr_store::asset::Variant;
use gpui::RenderImage;
use hayro::hayro_interpret::InterpreterSettings;
use hayro::hayro_interpret::font::{FontData, FontQuery};
use hayro::hayro_interpret::hayro_cmap::CidFamily;
use hayro::hayro_syntax::Pdf;
use hayro::vello_cpu::color::palette::css::WHITE;
use hayro::{PixmapSettings, RenderCache, RenderSettings};
use image::{Frame, RgbaImage};
use smallvec::SmallVec;

/// The longest side of an image as decoded.
pub const MAX_SIDE: u32 = 4096;

/// A bitmap for GPUI and its size in pixels.
#[derive(Clone)]
pub struct Picture {
    pub image: Arc<RenderImage>,
    pub width: u32,
    pub height: u32,
}

impl std::fmt::Debug for Picture {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Picture({}×{})", self.width, self.height)
    }
}

/// Why the picture is not there; each has its line on the stage.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Trouble {
    /// No bytes: the material has no asset, or this device does not hold
    /// it (yet).
    Missing,
    /// The image could not be decoded.
    Image(String),
    /// The PDF could not be opened (damaged, or encrypted).
    OpenPdf(String),
    /// A page could not be rendered.
    RenderPdf(String),
}

/// Straight RGBA as GPUI's BGRA.
fn bgra(mut rgba: RgbaImage) -> Picture {
    for px in rgba.pixels_mut() {
        px.0.swap(0, 2);
    }
    let (width, height) = rgba.dimensions();
    Picture {
        image: Arc::new(RenderImage::new(SmallVec::from_elem(Frame::new(rgba), 1))),
        width,
        height,
    }
}

/// The file of an asset's variant this device holds, if any.
fn variant_path(lib: &dr_store::Library, asset: &str, variant: Variant) -> Option<PathBuf> {
    match lib.asset(asset, variant) {
        Ok(Some(record)) => Some(record.path),
        Ok(None) => None,
        Err(e) => {
            log::warn!("material: asset {asset} ({}): {e}", variant.as_str());
            None
        }
    }
}

/// An image material's bytes: the display variant, else the source.
pub fn read_image(lib: &dr_store::Library, asset: &str) -> Result<Vec<u8>, Trouble> {
    let path = variant_path(lib, asset, Variant::Display)
        .or_else(|| variant_path(lib, asset, Variant::Source))
        .ok_or(Trouble::Missing)?;
    std::fs::read(&path).map_err(|e| {
        log::warn!("material: {}: {e}", path.display());
        Trouble::Missing
    })
}

/// A PDF material's bytes (its source).
pub fn read_pdf(lib: &dr_store::Library, asset: &str) -> Result<Vec<u8>, Trouble> {
    let path = variant_path(lib, asset, Variant::Source).ok_or(Trouble::Missing)?;
    std::fs::read(&path).map_err(|e| {
        log::warn!("material: {}: {e}", path.display());
        Trouble::Missing
    })
}

/// An image file decoded (PNG, JPEG, GIF, WebP, BMP, TIFF), held under
/// [`MAX_SIDE`].
pub fn decode_image(bytes: &[u8]) -> Result<Picture, Trouble> {
    let decoded = image::load_from_memory(bytes).map_err(|e| Trouble::Image(e.to_string()))?;
    let mut rgba = decoded.to_rgba8();
    let (w, h) = rgba.dimensions();
    if w.max(h) > MAX_SIDE {
        let k = MAX_SIDE as f32 / w.max(h) as f32;
        let (nw, nh) = (
            ((w as f32 * k).round() as u32).max(1),
            ((h as f32 * k).round() as u32).max(1),
        );
        rgba = image::imageops::resize(&rgba, nw, nh, image::imageops::FilterType::Triangle);
    }
    Ok(bgra(rgba))
}

/// An image file decoded small, its longest side at most `side` (a
/// thumbnail of the library or a card).
pub fn decode_thumbnail(bytes: &[u8], side: u32) -> Result<Picture, Trouble> {
    let decoded = image::load_from_memory(bytes).map_err(|e| Trouble::Image(e.to_string()))?;
    let small = if decoded.width().max(decoded.height()) > side {
        decoded.thumbnail(side, side)
    } else {
        decoded
    };
    Ok(bgra(small.to_rgba8()))
}

/// The best file this device has to make a thumbnail of an asset from:
/// its thumbnail, else its display copy, else its source.
pub fn thumbnail_source(lib: &dr_store::Library, asset: &str) -> Option<PathBuf> {
    variant_path(lib, asset, Variant::Thumbnail)
        .or_else(|| variant_path(lib, asset, Variant::Display))
        .or_else(|| variant_path(lib, asset, Variant::Source))
}

/// An open PDF: its pages' sizes in points (as shown, rotation applied).
pub struct PdfDoc {
    pdf: Pdf,
    pub pages: Vec<(f32, f32)>,
}

impl std::fmt::Debug for PdfDoc {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "PdfDoc({} pages)", self.pages.len())
    }
}

impl PdfDoc {
    pub fn open(bytes: Vec<u8>) -> Result<PdfDoc, Trouble> {
        let pdf = Pdf::new(bytes).map_err(|e| Trouble::OpenPdf(format!("{e:?}")))?;
        let pages: Vec<(f32, f32)> = pdf.pages().iter().map(|p| p.render_dimensions()).collect();
        if pages.is_empty() {
            return Err(Trouble::OpenPdf("no pages".into()));
        }
        Ok(PdfDoc { pdf, pages })
    }

    /// Page `index` (from 0) at `scale` device pixels per point, on white.
    pub fn render(&self, index: usize, scale: f32) -> Result<Picture, Trouble> {
        let pages = self.pdf.pages();
        let page = pages
            .get(index)
            .ok_or_else(|| Trouble::RenderPdf(format!("no page {}", index + 1)))?;
        let (w, h) = page.render_dimensions();
        if (w * scale).round() < 1.0 || (h * scale).round() < 1.0 {
            return Err(Trouble::RenderPdf("empty page".into()));
        }
        let cache = RenderCache::new();
        let pixmap = hayro::render(
            page,
            &cache,
            interpreter(),
            &RenderSettings::default(),
            &PixmapSettings {
                x_scale: scale,
                y_scale: scale,
                bg_color: WHITE,
            },
        );
        let (pw, ph) = (u32::from(pixmap.width()), u32::from(pixmap.height()));
        // Opaque on white: premultiplied is straight.
        let rgba = RgbaImage::from_raw(pw, ph, pixmap.data_as_u8_slice().to_vec())
            .ok_or_else(|| Trouble::RenderPdf("pixmap size".into()))?;
        Ok(bgra(rgba))
    }
}

/// The interpreter's settings, made once: standard fonts from hayro,
/// CJK fallback from Drifting Sans when the fonts are there.
fn interpreter() -> &'static InterpreterSettings {
    static SETTINGS: OnceLock<InterpreterSettings> = OnceLock::new();
    SETTINGS.get_or_init(|| InterpreterSettings {
        font_resolver: Arc::new(|query| match query {
            FontQuery::Standard(s) => Some(s.get_font_data()),
            FontQuery::Fallback(f) => {
                let cjk = f.character_collection.as_ref().is_some_and(|c| {
                    matches!(
                        c.family,
                        CidFamily::AdobeGB1
                            | CidFamily::AdobeCNS1
                            | CidFamily::AdobeJapan1
                            | CidFamily::AdobeKorea1
                    )
                });
                if cjk && let Some(face) = cjk_face() {
                    return Some((face, 0));
                }
                Some(f.pick_standard_font().get_font_data())
            }
        }),
        ..Default::default()
    })
}

/// Drifting Sans, read once, if dr-ui's fonts can be found.
fn cjk_face() -> Option<FontData> {
    static FACE: OnceLock<Option<FontData>> = OnceLock::new();
    FACE.get_or_init(|| {
        let dir = dr_ui::fonts::locate().ok()?;
        let bytes = std::fs::read(dir.join("DriftingSans-Regular.ttf")).ok()?;
        Some(Arc::new(bytes) as FontData)
    })
    .clone()
}

/// Whether CJK text in PDFs that do not carry its font can be drawn here.
pub fn has_cjk_fallback() -> bool {
    cjk_face().is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bgra_at(p: &Picture, x: u32, y: u32) -> [u8; 4] {
        let bytes = p.image.as_bytes(0).unwrap();
        let i = ((y * p.width + x) * 4) as usize;
        [bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]
    }

    #[test]
    fn images_decode_as_bgra_within_bounds() {
        let png = dr_testkit::media::png(120, 80);
        let p = decode_image(&png).unwrap();
        assert_eq!((p.width, p.height), (120, 80));
        // The top left corner is paper: warm, so red over blue, here
        // stored blue first.
        let [b, _, r, a] = bgra_at(&p, 0, 0);
        assert!(r > b && a == 255, "{r} {b}");
        let big = dr_testkit::media::png(MAX_SIDE + 400, 200);
        let p = decode_image(&big).unwrap();
        assert_eq!(p.width, MAX_SIDE);
        assert!(matches!(
            decode_image(b"not an image"),
            Err(Trouble::Image(_))
        ));
    }

    #[test]
    fn pdf_pages_open_with_their_sizes_and_render_at_scale() {
        let doc = PdfDoc::open(dr_testkit::media::sample_pdf()).unwrap();
        assert_eq!(doc.pages, vec![dr_testkit::media::A5; 3]);
        let p = doc.render(2, 0.5).unwrap();
        assert_eq!((p.width, p.height), (210, 297));
        // Paper white at the corner; the first coloured box (red, from 50
        // to 145 pt across, 360 to 500 pt up) in the middle of it.
        assert_eq!(bgra_at(&p, 2, 2), [255, 255, 255, 255]);
        let [b, g, r, _] = bgra_at(&p, 48, 297 - 215);
        assert!(r > 150 && g < 120 && b < 120, "{r} {g} {b}");
        assert!(matches!(doc.render(9, 1.0), Err(Trouble::RenderPdf(_))));
        assert!(matches!(
            PdfDoc::open(b"%PDF-1.7 broken".to_vec()),
            Err(Trouble::OpenPdf(_))
        ));
    }

    #[test]
    fn pdf_text_is_drawn_in_standard_and_fallback_faces() {
        let doc = PdfDoc::open(dr_testkit::media::sample_pdf()).unwrap();
        let p = doc.render(0, 1.0).unwrap();
        // Ink in a band: the title in Helvetica (40–200 pt across, its
        // baseline at 250 pt up, 22 pt type).
        let dark = |x0: u32, x1: u32, y0: u32, y1: u32| {
            (y0..y1)
                .flat_map(|y| (x0..x1).map(move |x| (x, y)))
                .filter(|&(x, y)| bgra_at(&p, x, y)[1] < 100)
                .count()
        };
        assert!(dark(40, 200, 595 - 250 - 18, 595 - 250) > 100);
        // The Chinese line (STSong-Light, not in the file) is drawn only
        // when Drifting Sans can be found; without the fonts it is left
        // out rather than drawn as boxes.
        let chinese = dark(40, 280, 595 - 215 - 14, 595 - 215);
        if has_cjk_fallback() {
            assert!(chinese > 100, "{chinese}");
        }
    }
}
