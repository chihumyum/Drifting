//! Bounded image inspection and derivative generation.
//!
//! Ordinary formats are decoded by the Rust `image` crate. HEIC/HEIF/AVIF are
//! detected here, but intentionally routed to a platform codec by the command
//! layer because `image` does not provide a portable HEIC decoder and its AVIF
//! decoder would add a second native codec stack to mobile builds.

use std::fmt;
use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::Path;

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::metadata::Orientation;
use image::{DynamicImage, GenericImageView, ImageDecoder, ImageFormat, ImageReader, Limits};

pub(crate) const MAX_IMAGE_DIMENSION: u32 = 16_384;
pub(crate) const MAX_IMAGE_ALLOC: u64 = 256 * 1024 * 1024;
pub(crate) const MAX_DISPLAY_BYTES: u64 = 8 * 1024 * 1024;
pub(crate) const MAX_THUMBNAIL_BYTES: u64 = 1024 * 1024;
pub(crate) const IMAGE_CODEC_UNAVAILABLE_CODE: &str = "IMAGE_CODEC_UNAVAILABLE";
pub(crate) const IMAGE_INVALID_CODE: &str = "IMAGE_INVALID";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SystemImageCodec {
    Heic,
    Heif,
    Avif,
}

impl SystemImageCodec {
    pub(crate) fn extension(self) -> &'static str {
        match self {
            Self::Heic => "heic",
            Self::Heif => "heif",
            Self::Avif => "avif",
        }
    }

    pub(crate) fn mime(self) -> &'static str {
        match self {
            Self::Heic => "image/heic",
            Self::Heif => "image/heif",
            Self::Avif => "image/avif",
        }
    }
}

#[derive(Debug)]
pub(crate) struct ImagePipelineError {
    pub(crate) code: &'static str,
    pub(crate) codec: Option<SystemImageCodec>,
    pub(crate) message: String,
}

impl ImagePipelineError {
    pub(crate) fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: IMAGE_INVALID_CODE,
            codec: None,
            message: message.into(),
        }
    }

    pub(crate) fn codec_unavailable(codec: SystemImageCodec) -> Self {
        Self {
            code: IMAGE_CODEC_UNAVAILABLE_CODE,
            codec: Some(codec),
            message: format!(
                "{} decoding is unavailable on this operating system version",
                codec.extension().to_ascii_uppercase()
            ),
        }
    }
}

impl fmt::Display for ImagePipelineError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

#[derive(Debug)]
pub(crate) struct ImageInspection {
    pub(crate) mime: String,
    pub(crate) size_bytes: u64,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

#[derive(Debug)]
pub(crate) struct ImageVariant {
    pub(crate) bytes: Vec<u8>,
    pub(crate) mime: String,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

impl ImageVariant {
    pub(crate) fn size_bytes(&self) -> u64 {
        self.bytes.len() as u64
    }
}

#[derive(Debug)]
pub(crate) struct PreparedImage {
    pub(crate) source: ImageInspection,
    pub(crate) display: ImageVariant,
    pub(crate) thumbnail: ImageVariant,
}

fn ftyp_brands(bytes: &[u8]) -> Option<impl Iterator<Item = &[u8]>> {
    if bytes.len() < 16 || &bytes[4..8] != b"ftyp" {
        return None;
    }
    let declared_size = u32::from_be_bytes(bytes[..4].try_into().ok()?) as usize;
    let box_end = if declared_size == 0 {
        bytes.len()
    } else {
        declared_size.min(bytes.len())
    };
    if box_end < 16 {
        return None;
    }

    // Major brand, followed by compatible brands after the four-byte minor version.
    Some(
        std::iter::once(&bytes[8..12]).chain(
            bytes[16..box_end]
                .chunks_exact(4)
                .map(|brand| brand as &[u8]),
        ),
    )
}

pub(crate) fn sniff_system_codec(bytes: &[u8]) -> Option<SystemImageCodec> {
    let brands = ftyp_brands(bytes)?.collect::<Vec<_>>();
    if brands
        .iter()
        .any(|brand| matches!(*brand, b"avif" | b"avis"))
    {
        return Some(SystemImageCodec::Avif);
    }
    if brands.iter().any(|brand| {
        matches!(
            *brand,
            b"heic" | b"heix" | b"hevc" | b"hevx" | b"hevm" | b"hevs"
        )
    }) {
        return Some(SystemImageCodec::Heic);
    }
    if brands
        .iter()
        .any(|brand| matches!(*brand, b"mif1" | b"msf1"))
    {
        return Some(SystemImageCodec::Heif);
    }
    None
}

pub(crate) fn sniff_extension(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(b"%PDF-") {
        "pdf"
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "png"
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        "jpg"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "gif"
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "webp"
    } else if bytes.starts_with(b"BM") {
        "bmp"
    } else if bytes.starts_with(b"II*\0") || bytes.starts_with(b"MM\0*") {
        "tiff"
    } else if bytes.starts_with(b"\0\0\x01\0") {
        "ico"
    } else {
        sniff_system_codec(bytes)
            .map(SystemImageCodec::extension)
            .unwrap_or("bin")
    }
}

pub(crate) fn detect_system_codec(
    path: &Path,
) -> Result<Option<SystemImageCodec>, ImagePipelineError> {
    let mut signature = [0_u8; 512];
    let signature_length = File::open(path)
        .and_then(|mut file| file.read(&mut signature))
        .map_err(|_| ImagePipelineError::invalid("could not open image file"))?;
    if let Some(codec) = sniff_system_codec(&signature[..signature_length]) {
        return Ok(Some(codec));
    }
    if sniff_extension(&signature[..signature_length]) != "bin" {
        return Ok(None);
    }

    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase);
    Ok(match extension.as_deref() {
        Some("heic") => Some(SystemImageCodec::Heic),
        Some("heif") => Some(SystemImageCodec::Heif),
        Some("avif") => Some(SystemImageCodec::Avif),
        _ => None,
    })
}

fn image_limits() -> Limits {
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_IMAGE_DIMENSION);
    limits.max_alloc = Some(MAX_IMAGE_ALLOC);
    limits
}

fn image_reader(
    path: &Path,
    material_file_limit: u64,
) -> Result<ImageReader<BufReader<File>>, ImagePipelineError> {
    let metadata = fs::metadata(path)
        .map_err(|_| ImagePipelineError::invalid("could not inspect image file"))?;
    if !metadata.is_file() {
        return Err(ImagePipelineError::invalid("path is not a file"));
    }
    if metadata.len() > material_file_limit {
        return Err(ImagePipelineError::invalid(
            "image file is too large (>64 MiB)",
        ));
    }
    if let Some(codec) = detect_system_codec(path)? {
        return Err(ImagePipelineError::codec_unavailable(codec));
    }
    let file =
        File::open(path).map_err(|_| ImagePipelineError::invalid("could not open image file"))?;
    let mut reader = ImageReader::new(BufReader::new(file))
        .with_guessed_format()
        .map_err(|_| ImagePipelineError::invalid("could not identify image format"))?;
    reader.limits(image_limits());
    Ok(reader)
}

fn decode_with_metadata(
    path: &Path,
    material_file_limit: u64,
) -> Result<(ImageInspection, DynamicImage), ImagePipelineError> {
    let size_bytes = fs::metadata(path)
        .map_err(|_| ImagePipelineError::invalid("could not inspect image file"))?
        .len();
    let reader = image_reader(path, material_file_limit)?;
    let format = reader
        .format()
        .ok_or_else(|| ImagePipelineError::invalid("unsupported or invalid image"))?;
    let mut decoder = reader
        .into_decoder()
        .map_err(|_| ImagePipelineError::invalid("unsupported or invalid image"))?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut image = DynamicImage::from_decoder(decoder)
        .map_err(|_| ImagePipelineError::invalid("unsupported or invalid image"))?;
    image.apply_orientation(orientation);
    let (width, height) = image.dimensions();
    Ok((
        ImageInspection {
            mime: image_format_mime(format).into(),
            size_bytes,
            width,
            height,
        },
        image,
    ))
}

pub(crate) fn inspect(
    path: &Path,
    material_file_limit: u64,
) -> Result<ImageInspection, ImagePipelineError> {
    let size_bytes = fs::metadata(path)
        .map_err(|_| ImagePipelineError::invalid("could not inspect image file"))?
        .len();
    let reader = image_reader(path, material_file_limit)?;
    let format = reader
        .format()
        .ok_or_else(|| ImagePipelineError::invalid("unsupported or invalid image"))?;
    let mut decoder = reader
        .into_decoder()
        .map_err(|_| ImagePipelineError::invalid("unsupported or invalid image"))?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let (width, height) = decoder.dimensions();
    let (width, height) = oriented_dimensions(width, height, orientation);
    Ok(ImageInspection {
        mime: image_format_mime(format).into(),
        size_bytes,
        width,
        height,
    })
}

pub(crate) fn decode(
    path: &Path,
    material_file_limit: u64,
) -> Result<DynamicImage, ImagePipelineError> {
    decode_with_metadata(path, material_file_limit).map(|(_, image)| image)
}

pub(crate) fn prepare(
    path: &Path,
    material_file_limit: u64,
    display_max_long_edge: u32,
    display_quality: u8,
    thumbnail_max_long_edge: u32,
    thumbnail_quality: u8,
) -> Result<PreparedImage, ImagePipelineError> {
    let (source, image) = decode_with_metadata(path, material_file_limit)?;
    let display = variant_from_decoded(&image, display_max_long_edge, display_quality)?;
    let thumbnail = variant_from_decoded(&image, thumbnail_max_long_edge, thumbnail_quality)?;
    validate_derivative_sizes(&display, &thumbnail)?;
    Ok(PreparedImage {
        source,
        display,
        thumbnail,
    })
}

pub(crate) fn validate_derivative_sizes(
    display: &ImageVariant,
    thumbnail: &ImageVariant,
) -> Result<(), ImagePipelineError> {
    if display.size_bytes() == 0 || display.size_bytes() > MAX_DISPLAY_BYTES {
        return Err(ImagePipelineError::invalid(
            "display JPEG exceeds the 8 MiB output limit",
        ));
    }
    if thumbnail.size_bytes() == 0 || thumbnail.size_bytes() > MAX_THUMBNAIL_BYTES {
        return Err(ImagePipelineError::invalid(
            "thumbnail JPEG exceeds the 1 MiB output limit",
        ));
    }
    Ok(())
}

pub(crate) fn create_variant(
    path: &Path,
    material_file_limit: u64,
    max_long_edge: u32,
    quality: u8,
) -> Result<ImageVariant, ImagePipelineError> {
    let image = decode(path, material_file_limit)?;
    variant_from_decoded(&image, max_long_edge, quality)
}

fn variant_from_decoded(
    image: &DynamicImage,
    max_long_edge: u32,
    quality: u8,
) -> Result<ImageVariant, ImagePipelineError> {
    let (width, height) = bounded_dimensions(image.width(), image.height(), max_long_edge);
    let bytes = if (width, height) == image.dimensions() {
        encode_jpeg(image, quality)?
    } else {
        let variant = image.resize_exact(width, height, FilterType::Lanczos3);
        encode_jpeg(&variant, quality)?
    };
    Ok(ImageVariant {
        bytes,
        mime: "image/jpeg".into(),
        width,
        height,
    })
}

pub(crate) fn thumbnail_data_url(
    path: &Path,
    material_file_limit: u64,
    size: u32,
) -> Result<String, ImagePipelineError> {
    let image = decode(path, material_file_limit)?;
    let thumbnail = image.resize(size, size, FilterType::Lanczos3);
    let bytes = encode_jpeg(&thumbnail, 80)?;
    Ok(format!(
        "data:image/jpeg;base64,{}",
        BASE64_STANDARD.encode(bytes)
    ))
}

pub(crate) fn oriented_dimensions(width: u32, height: u32, orientation: Orientation) -> (u32, u32) {
    if matches!(
        orientation,
        Orientation::Rotate90
            | Orientation::Rotate270
            | Orientation::Rotate90FlipH
            | Orientation::Rotate270FlipH
    ) {
        (height, width)
    } else {
        (width, height)
    }
}

fn image_format_mime(format: ImageFormat) -> &'static str {
    match format {
        ImageFormat::Png => "image/png",
        ImageFormat::Jpeg => "image/jpeg",
        ImageFormat::Gif => "image/gif",
        ImageFormat::WebP => "image/webp",
        ImageFormat::Bmp => "image/bmp",
        ImageFormat::Ico => "image/x-icon",
        ImageFormat::Tiff => "image/tiff",
        ImageFormat::Avif => "image/avif",
        _ => "application/octet-stream",
    }
}

pub(crate) fn bounded_dimensions(width: u32, height: u32, max_long_edge: u32) -> (u32, u32) {
    let width = width.max(1);
    let height = height.max(1);
    let longest = width.max(height);
    if longest <= max_long_edge {
        return (width, height);
    }

    let scale = max_long_edge as u64;
    let longest = longest as u64;
    let resized_width = ((width as u64 * scale + longest / 2) / longest).max(1) as u32;
    let resized_height = ((height as u64 * scale + longest / 2) / longest).max(1) as u32;
    (resized_width, resized_height)
}

fn encode_jpeg(image: &DynamicImage, quality: u8) -> Result<Vec<u8>, ImagePipelineError> {
    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, quality)
        .encode_image(image)
        .map_err(|_| ImagePipelineError::invalid("could not encode JPEG variant"))?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};
    use tempfile::tempdir;

    #[test]
    fn bounded_dimensions_preserve_aspect_ratio() {
        assert_eq!(bounded_dimensions(4000, 2000, 1600), (1600, 800));
        assert_eq!(bounded_dimensions(1000, 2000, 512), (256, 512));
        assert_eq!(bounded_dimensions(200, 100, 1600), (200, 100));
    }

    #[test]
    fn sniffs_major_and_compatible_iso_bmff_brands() {
        assert_eq!(sniff_extension(b"%PDF-1.7"), "pdf");
        assert_eq!(sniff_extension(b"\0\0\0\x18ftypheic\0\0\0\0mif1"), "heic");
        assert_eq!(sniff_extension(b"\0\0\0\x18ftypmif1\0\0\0\0avif"), "avif");
        assert_eq!(sniff_extension(b"\0\0\0\x18ftypmif1\0\0\0\0heic"), "heic");
    }

    #[test]
    fn reports_oriented_dimensions() {
        assert_eq!(
            oriented_dimensions(4032, 3024, Orientation::Rotate90),
            (3024, 4032)
        );
        assert_eq!(
            oriented_dimensions(4032, 3024, Orientation::Rotate90FlipH),
            (3024, 4032)
        );
        assert_eq!(
            oriented_dimensions(4032, 3024, Orientation::FlipHorizontal),
            (4032, 3024)
        );
    }

    #[test]
    fn prepares_source_and_two_jpeg_derivatives_from_one_decoded_image() {
        let directory = tempdir().unwrap();
        let source_path = directory.path().join("source.png");
        let source = RgbImage::from_pixel(2400, 1200, Rgb([70, 90, 120]));
        DynamicImage::ImageRgb8(source)
            .save_with_format(&source_path, ImageFormat::Png)
            .unwrap();

        let prepared = prepare(&source_path, 64 * 1024 * 1024, 1600, 82, 512, 72).unwrap();
        assert_eq!(prepared.source.mime, "image/png");
        assert_eq!(
            (prepared.source.width, prepared.source.height),
            (2400, 1200)
        );
        assert_eq!(
            (prepared.display.width, prepared.display.height),
            (1600, 800)
        );
        assert_eq!(
            (prepared.thumbnail.width, prepared.thumbnail.height),
            (512, 256)
        );
        for variant in [&prepared.display, &prepared.thumbnail] {
            assert_eq!(variant.mime, "image/jpeg");
            assert!(variant.bytes.starts_with(b"\xff\xd8\xff"));
            assert!(!variant.bytes.is_empty());
        }
    }

    #[test]
    fn returns_stable_codec_error_for_system_formats() {
        let directory = tempdir().unwrap();
        let source_path = directory.path().join("source.avif");
        fs::write(&source_path, b"\0\0\0\x18ftypmif1\0\0\0\0avif").unwrap();
        let error = prepare(&source_path, 64 * 1024 * 1024, 1600, 82, 512, 72).unwrap_err();
        assert_eq!(error.code, IMAGE_CODEC_UNAVAILABLE_CODE);
        assert_eq!(error.codec, Some(SystemImageCodec::Avif));
    }

    #[test]
    fn content_signature_wins_over_a_misleading_system_codec_extension() {
        let directory = tempdir().unwrap();
        let source_path = directory.path().join("renamed.heic");
        fs::write(&source_path, b"\xff\xd8\xffplaceholder").unwrap();
        assert_eq!(detect_system_codec(&source_path).unwrap(), None);
    }
}
