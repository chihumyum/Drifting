//! A book cover picked from disk: decoded, turned upright, bounded and
//! re-encoded as JPEG, as the 0.1 client's cover picker did
//! (`image_pipeline::create_variant(path, 64 MiB, 2560, 90)`).

use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::Path;

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::metadata::Orientation;
use image::{DynamicImage, GenericImageView, ImageDecoder, ImageReader, Limits};

use crate::manuscript::Cover;

/// The largest image file the picker reads.
pub const COVER_SOURCE_LIMIT: u64 = 64 * 1024 * 1024;
/// The cover's long edge is at most this many pixels.
pub const COVER_LONG_EDGE: u32 = 2560;
const COVER_QUALITY: u8 = 90;
const MAX_DIMENSION: u32 = 16_384;
const MAX_ALLOC: u64 = 256 * 1024 * 1024;

/// The file extensions the picker offers (0.1's list).
pub const COVER_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff"];

/// Reads `path` as a cover. Errors are short English sentences.
pub fn cover_from_path(path: &Path) -> Result<Cover, String> {
    let metadata = fs::metadata(path).map_err(|_| "could not inspect image file".to_string())?;
    if !metadata.is_file() {
        return Err("path is not a file".into());
    }
    if metadata.len() > COVER_SOURCE_LIMIT {
        return Err("image file is too large (>64 MiB)".into());
    }
    let mut signature = [0_u8; 512];
    let read = File::open(path)
        .and_then(|mut f| f.read(&mut signature))
        .map_err(|_| "could not open image file".to_string())?;
    if needs_system_codec(&signature[..read]) {
        return Err("HEIC, HEIF and AVIF images cannot be used as a cover yet".into());
    }
    let file = File::open(path).map_err(|_| "could not open image file".to_string())?;
    let mut reader = ImageReader::new(BufReader::new(file))
        .with_guessed_format()
        .map_err(|_| "could not identify image format".to_string())?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_DIMENSION);
    limits.max_image_height = Some(MAX_DIMENSION);
    limits.max_alloc = Some(MAX_ALLOC);
    reader.limits(limits);
    let mut decoder = reader
        .into_decoder()
        .map_err(|_| "unsupported or invalid image".to_string())?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut image =
        DynamicImage::from_decoder(decoder).map_err(|_| "unsupported or invalid image")?;
    image.apply_orientation(orientation);
    let (width, height) = bounded(image.width(), image.height(), COVER_LONG_EDGE);
    if (width, height) != image.dimensions() {
        image = image.resize_exact(width, height, FilterType::Lanczos3);
    }
    // JPEG has no alpha: a transparent cover is laid on white.
    let rgb = if image.color().has_alpha() {
        let rgba = image.to_rgba8();
        let mut rgb = image::RgbImage::new(width, height);
        for (x, y, p) in rgba.enumerate_pixels() {
            let a = u16::from(p[3]);
            let over = |c: u8| ((u16::from(c) * a + 255 * (255 - a)) / 255) as u8;
            rgb.put_pixel(x, y, image::Rgb([over(p[0]), over(p[1]), over(p[2])]));
        }
        DynamicImage::ImageRgb8(rgb)
    } else {
        DynamicImage::ImageRgb8(image.to_rgb8())
    };
    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, COVER_QUALITY)
        .encode_image(&rgb)
        .map_err(|_| "could not encode the cover".to_string())?;
    Ok(Cover {
        media_type: "image/jpeg".into(),
        data: BASE64_STANDARD.encode(bytes),
        width,
        height,
    })
}

impl Cover {
    /// The image bytes (for a thumbnail), `None` when `data` is not base64.
    pub fn bytes(&self) -> Option<Vec<u8>> {
        BASE64_STANDARD.decode(self.data.as_bytes()).ok()
    }
}

/// HEIC, HEIF and AVIF: an ISO-BMFF `ftyp` box with one of their brands.
fn needs_system_codec(bytes: &[u8]) -> bool {
    if bytes.len() < 16 || &bytes[4..8] != b"ftyp" {
        return false;
    }
    let size = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    let end = size.clamp(16, bytes.len());
    let major = &bytes[8..12];
    let compatible = bytes[16..end].as_chunks::<4>().0.iter().map(|b| &b[..]);
    std::iter::once(major).chain(compatible).any(|b| {
        matches!(
            b,
            b"avif"
                | b"avis"
                | b"heic"
                | b"heix"
                | b"hevc"
                | b"hevx"
                | b"hevm"
                | b"hevs"
                | b"mif1"
                | b"msf1"
        )
    })
}

/// `width × height` scaled so the long edge is at most `max`, rounded.
fn bounded(width: u32, height: u32, max: u32) -> (u32, u32) {
    let width = width.max(1);
    let height = height.max(1);
    let longest = width.max(height);
    if longest <= max {
        return (width, height);
    }
    let (scale, longest) = (u64::from(max), u64::from(longest));
    let w = ((u64::from(width) * scale + longest / 2) / longest).max(1) as u32;
    let h = ((u64::from(height) * scale + longest / 2) / longest).max(1) as u32;
    (w, h)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageFormat, Rgba, RgbaImage};

    #[test]
    fn bounds_keep_the_aspect_ratio() {
        assert_eq!(bounded(4032, 3024, 2560), (2560, 1920));
        assert_eq!(bounded(600, 900, 2560), (600, 900));
        assert_eq!(bounded(10, 40_000, 2560), (1, 2560));
    }

    #[test]
    fn covers_are_upright_bounded_jpegs() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cover.png");
        let mut img = RgbaImage::new(3000, 1500);
        for (x, _, p) in img.enumerate_pixels_mut() {
            *p = Rgba([(x % 256) as u8, 80, 160, if x < 100 { 0 } else { 255 }]);
        }
        img.save_with_format(&path, ImageFormat::Png).unwrap();
        let cover = cover_from_path(&path).unwrap();
        assert_eq!(cover.media_type, "image/jpeg");
        assert_eq!((cover.width, cover.height), (2560, 1280));
        let bytes = cover.bytes().unwrap();
        assert_eq!(image::guess_format(&bytes).unwrap(), ImageFormat::Jpeg);
        let back = image::load_from_memory(&bytes).unwrap();
        assert_eq!(back.dimensions(), (2560, 1280));
        // The transparent strip is laid on white.
        let p = back.to_rgb8().get_pixel(10, 600).0;
        assert!(p.iter().all(|&c| c > 230), "{p:?}");
    }

    #[test]
    fn refuses_what_is_not_a_picture() {
        let dir = tempfile::tempdir().unwrap();
        let text = dir.path().join("note.png");
        fs::write(&text, "not an image").unwrap();
        assert!(cover_from_path(&text).is_err());
        assert!(cover_from_path(dir.path()).is_err());
        let heic = dir.path().join("photo.heic");
        let mut bytes = vec![0, 0, 0, 24];
        bytes.extend_from_slice(b"ftypheic\0\0\0\0mif1heic");
        bytes.resize(64, 0);
        fs::write(&heic, bytes).unwrap();
        assert!(cover_from_path(&heic).unwrap_err().contains("HEIC"));
    }
}
