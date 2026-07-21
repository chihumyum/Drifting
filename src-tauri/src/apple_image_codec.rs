//! Apple ImageIO adapter for HEIC/HEIF/AVIF.
//!
//! ImageIO performs runtime codec discovery, orientation transforms and
//! downsampled decode. Unsupported OS/codec combinations are reported through
//! the shared stable error contract.

use std::fs;
use std::path::Path;

use objc2_core_foundation::{
    CFBoolean, CFDictionary, CFMutableData, CFNumber, CFString, CFType, CFURL,
};
use objc2_core_graphics::CGImage;
use objc2_image_io::{
    kCGImageDestinationLossyCompressionQuality, kCGImagePropertyOrientation,
    kCGImagePropertyPixelHeight, kCGImagePropertyPixelWidth,
    kCGImageSourceCreateThumbnailFromImageAlways, kCGImageSourceCreateThumbnailWithTransform,
    kCGImageSourceThumbnailMaxPixelSize, CGImageDestination, CGImageSource,
};

use crate::image_pipeline::{
    validate_derivative_sizes, ImageInspection, ImagePipelineError, ImageVariant, PreparedImage,
    SystemImageCodec, MAX_IMAGE_ALLOC, MAX_IMAGE_DIMENSION,
};

fn property_number(properties: &CFDictionary<CFString, CFType>, key: &CFString) -> Option<i64> {
    properties.get(key)?.downcast::<CFNumber>().ok()?.as_i64()
}

fn source_dimensions(source: &CGImageSource) -> Result<(u32, u32), ImagePipelineError> {
    // SAFETY: ImageIO documents these property dictionary keys as CFNumber values.
    let properties = unsafe { source.properties_at_index(0, None) }
        .ok_or_else(|| ImagePipelineError::invalid("could not inspect native image metadata"))?;
    let properties: &CFDictionary<CFString, CFType> = unsafe { properties.cast_unchecked() };
    let width = property_number(properties, unsafe { kCGImagePropertyPixelWidth })
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| ImagePipelineError::invalid("native image width is invalid"))?;
    let height = property_number(properties, unsafe { kCGImagePropertyPixelHeight })
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| ImagePipelineError::invalid("native image height is invalid"))?;
    let orientation =
        property_number(properties, unsafe { kCGImagePropertyOrientation }).unwrap_or(1);
    let (width, height) = if (5..=8).contains(&orientation) {
        (height, width)
    } else {
        (width, height)
    };

    if width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION {
        return Err(ImagePipelineError::invalid(
            "image dimensions exceed the 16384 pixel limit",
        ));
    }
    if u64::from(width)
        .saturating_mul(u64::from(height))
        .saturating_mul(4)
        > MAX_IMAGE_ALLOC
    {
        return Err(ImagePipelineError::invalid(
            "decoded image exceeds the 256 MiB allocation limit",
        ));
    }
    Ok((width, height))
}

fn create_thumbnail(
    source: &CGImageSource,
    max_long_edge: u32,
) -> Result<objc2_core_foundation::CFRetained<CGImage>, ImagePipelineError> {
    let max_pixel_size = CFNumber::new_i64(i64::from(max_long_edge));
    let options = CFDictionary::<CFString, CFType>::from_slices(
        &[
            unsafe { kCGImageSourceCreateThumbnailFromImageAlways },
            unsafe { kCGImageSourceCreateThumbnailWithTransform },
            unsafe { kCGImageSourceThumbnailMaxPixelSize },
        ],
        &[
            CFBoolean::new(true).as_ref(),
            CFBoolean::new(true).as_ref(),
            max_pixel_size.as_ref(),
        ],
    );
    // SAFETY: Each option uses the exact CoreFoundation value type required by ImageIO.
    unsafe { source.thumbnail_at_index(0, Some(options.as_opaque())) }
        .ok_or_else(|| ImagePipelineError::invalid("native image decode failed"))
}

fn encode_jpeg(image: &CGImage, quality: u8) -> Result<ImageVariant, ImagePipelineError> {
    let data = CFMutableData::new(None, 0)
        .ok_or_else(|| ImagePipelineError::invalid("could not allocate JPEG output"))?;
    let jpeg_type = CFString::from_static_str("public.jpeg");
    // SAFETY: The destination UTI and mutable data are valid for one image.
    let destination = unsafe { CGImageDestination::with_data(&data, &jpeg_type, 1, None) }
        .ok_or_else(|| ImagePipelineError::invalid("could not create JPEG destination"))?;
    let compression = CFNumber::new_f64(f64::from(quality) / 100.0);
    let properties = CFDictionary::<CFString, CFNumber>::from_slices(
        &[unsafe { kCGImageDestinationLossyCompressionQuality }],
        &[&compression],
    );
    // SAFETY: The destination property is documented as a CFNumber in the range 0...1.
    unsafe {
        destination.add_image(image, Some(properties.as_opaque()));
        if !destination.finalize() {
            return Err(ImagePipelineError::invalid("could not encode JPEG variant"));
        }
    }
    let bytes = data.to_vec();
    if bytes.is_empty() {
        return Err(ImagePipelineError::invalid("native JPEG output is empty"));
    }
    Ok(ImageVariant {
        bytes,
        mime: "image/jpeg".into(),
        width: u32::try_from(CGImage::width(Some(image)))
            .map_err(|_| ImagePipelineError::invalid("native image width is invalid"))?,
        height: u32::try_from(CGImage::height(Some(image)))
            .map_err(|_| ImagePipelineError::invalid("native image height is invalid"))?,
    })
}

pub(crate) fn prepare(
    path: &Path,
    codec: SystemImageCodec,
    material_file_limit: u64,
    display_max_long_edge: u32,
    display_quality: u8,
    thumbnail_max_long_edge: u32,
    thumbnail_quality: u8,
) -> Result<PreparedImage, ImagePipelineError> {
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
    let url = CFURL::from_file_path(path)
        .ok_or_else(|| ImagePipelineError::invalid("could not create native image URL"))?;
    // SAFETY: The URL points at the app-owned imported source file and no untyped options are used.
    let source = unsafe { CGImageSource::with_url(&url, None) }
        .ok_or_else(|| ImagePipelineError::codec_unavailable(codec))?;
    let (width, height) = source_dimensions(&source)?;
    let display_image = create_thumbnail(&source, display_max_long_edge)?;
    let display = encode_jpeg(&display_image, display_quality)?;
    let thumbnail_image = create_thumbnail(&source, thumbnail_max_long_edge)?;
    let thumbnail = encode_jpeg(&thumbnail_image, thumbnail_quality)?;
    validate_derivative_sizes(&display, &thumbnail)?;

    Ok(PreparedImage {
        source: ImageInspection {
            mime: codec.mime().into(),
            size_bytes: metadata.len(),
            width,
            height,
        },
        display,
        thumbnail,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
    use std::process::Command;
    use tempfile::tempdir;

    #[test]
    fn imageio_prepares_supported_heic_and_avif_sources() {
        let directory = tempdir().unwrap();
        let png = directory.path().join("source.png");
        DynamicImage::ImageRgb8(RgbImage::from_pixel(96, 48, Rgb([90, 70, 120])))
            .save_with_format(&png, ImageFormat::Png)
            .unwrap();

        let mut exercised = 0;
        for (format, codec) in [
            ("heic", SystemImageCodec::Heic),
            ("avif", SystemImageCodec::Avif),
        ] {
            let source = directory.path().join(format!("source.{format}"));
            let status = Command::new("/usr/bin/sips")
                .args(["-s", "format", format])
                .arg(&png)
                .arg("--out")
                .arg(&source)
                .status()
                .unwrap();
            if !status.success() {
                continue;
            }
            exercised += 1;
            let prepared = prepare(&source, codec, 64 * 1024 * 1024, 80, 82, 32, 72).unwrap();
            assert_eq!(prepared.source.mime, codec.mime());
            assert_eq!((prepared.source.width, prepared.source.height), (96, 48));
            assert_eq!((prepared.display.width, prepared.display.height), (80, 40));
            assert_eq!(
                (prepared.thumbnail.width, prepared.thumbnail.height),
                (32, 16)
            );
            assert!(prepared.display.bytes.starts_with(b"\xff\xd8\xff"));
            assert!(prepared.thumbnail.bytes.starts_with(b"\xff\xd8\xff"));
        }
        assert!(
            exercised > 0,
            "ImageIO did not expose HEIC or AVIF on this macOS"
        );
    }
}
