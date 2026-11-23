//! HEIC, HEIF and AVIF through ImageIO (macOS), as 0.1's
//! `apple_image_codec.rs`: the size from the source's properties, the
//! picture from `CGImageSourceCreateThumbnailAtIndex` (always from the full
//! image, turned upright, at most the size asked for), drawn into an sRGB
//! RGBA bitmap.

use objc2_core_foundation::{
    CFBoolean, CFData, CFDictionary, CFNumber, CFRetained, CFString, CFType, CGPoint, CGRect,
    CGSize,
};
use objc2_core_graphics::{
    CGBitmapContextCreate, CGColorSpace, CGContext, CGImage, CGImageAlphaInfo,
    CGImageByteOrderInfo, kCGColorSpaceSRGB,
};
use objc2_image_io::{
    CGImageSource, kCGImagePropertyOrientation, kCGImagePropertyPixelHeight,
    kCGImagePropertyPixelWidth, kCGImageSourceCreateThumbnailFromImageAlways,
    kCGImageSourceCreateThumbnailWithTransform, kCGImageSourceThumbnailMaxPixelSize,
};

use super::{CodecError, Decoded, SystemFormat, bounded, check_size};

/// The image source over `bytes`; `Unavailable` when ImageIO does not know
/// the format (an older macOS for AVIF).
fn source(bytes: &[u8], format: SystemFormat) -> Result<CFRetained<CGImageSource>, CodecError> {
    let data = CFData::from_bytes(bytes);
    // SAFETY: no options dictionary is passed.
    let source =
        unsafe { CGImageSource::with_data(&data, None) }.ok_or(CodecError::Unavailable(format))?;
    // SAFETY: `source` is a valid image source.
    if unsafe { source.r#type() }.is_none() {
        return Err(CodecError::Unavailable(format));
    }
    // SAFETY: as above.
    if unsafe { source.count() } == 0 {
        return Err(CodecError::Invalid("the image has no pictures".into()));
    }
    Ok(source)
}

fn number(properties: &CFDictionary<CFString, CFType>, key: &CFString) -> Option<i64> {
    properties.get(key)?.downcast::<CFNumber>().ok()?.as_i64()
}

/// The first picture's size, upright (orientations 5–8 swap the sides).
fn upright_size(source: &CGImageSource) -> Result<(u32, u32), CodecError> {
    // SAFETY: no options dictionary is passed.
    let properties = unsafe { source.properties_at_index(0, None) }
        .ok_or_else(|| CodecError::Invalid("could not read the image's properties".into()))?;
    // SAFETY: ImageIO's property dictionaries map CFString keys to CF values.
    let properties: &CFDictionary<CFString, CFType> = unsafe { properties.cast_unchecked() };
    let side = |key: &CFString| {
        number(properties, key)
            .and_then(|v| u32::try_from(v).ok())
            .filter(|&v| v > 0)
            .ok_or_else(|| CodecError::Invalid("the image's size is unreadable".into()))
    };
    // SAFETY: extern statics provided by ImageIO.
    let (width, height) = unsafe {
        (
            side(kCGImagePropertyPixelWidth)?,
            side(kCGImagePropertyPixelHeight)?,
        )
    };
    // SAFETY: as above.
    let orientation = number(properties, unsafe { kCGImagePropertyOrientation }).unwrap_or(1);
    let size = if (5..=8).contains(&orientation) {
        (height, width)
    } else {
        (width, height)
    };
    check_size(size.0, size.1)?;
    Ok(size)
}

pub(super) fn dimensions(bytes: &[u8], format: SystemFormat) -> Result<(u32, u32), CodecError> {
    let source = source(bytes, format)?;
    upright_size(&source)
}

pub(super) fn decode(
    bytes: &[u8],
    format: SystemFormat,
    max_side: u32,
) -> Result<Decoded, CodecError> {
    let source = source(bytes, format)?;
    let (width, height) = upright_size(&source)?;
    let (w, h) = bounded(width, height, max_side);
    let longest = CFNumber::new_i64(i64::from(w.max(h)));
    let yes = CFBoolean::new(true);
    // SAFETY: extern statics provided by ImageIO.
    let keys = unsafe {
        [
            kCGImageSourceCreateThumbnailFromImageAlways,
            kCGImageSourceCreateThumbnailWithTransform,
            kCGImageSourceThumbnailMaxPixelSize,
        ]
    };
    let options = CFDictionary::<CFString, CFType>::from_slices(
        &keys,
        &[yes.as_ref(), yes.as_ref(), longest.as_ref()],
    );
    // SAFETY: each option has the CoreFoundation type ImageIO documents.
    let image = unsafe { source.thumbnail_at_index(0, Some(options.as_opaque())) }
        .ok_or_else(|| CodecError::Invalid("ImageIO could not decode the image".into()))?;
    rgba(&image)
}

/// `image` drawn into an sRGB RGBA bitmap, then made straight alpha.
fn rgba(image: &CGImage) -> Result<Decoded, CodecError> {
    let (width, height) = (CGImage::width(Some(image)), CGImage::height(Some(image)));
    let (w, h) = (
        u32::try_from(width).map_err(|_| CodecError::Invalid("image too wide".into()))?,
        u32::try_from(height).map_err(|_| CodecError::Invalid("image too tall".into()))?,
    );
    check_size(w, h)?;
    let stride = width * 4;
    let mut pixels = vec![0u8; stride * height];
    // SAFETY: extern static provided by CoreGraphics.
    let space = CGColorSpace::with_name(Some(unsafe { kCGColorSpaceSRGB }))
        .ok_or_else(|| CodecError::Invalid("no sRGB colour space".into()))?;
    // R, G, B, A in memory: premultiplied alpha last, 32-bit big endian.
    let info = CGImageAlphaInfo::PremultipliedLast.0 | CGImageByteOrderInfo::Order32Big.0;
    {
        // SAFETY: `pixels` holds `stride × height` bytes and outlives the
        // context, which is dropped at the end of this block.
        let context = unsafe {
            CGBitmapContextCreate(
                pixels.as_mut_ptr().cast(),
                width,
                height,
                8,
                stride,
                Some(&space),
                info,
            )
        }
        .ok_or_else(|| CodecError::Invalid("could not make a bitmap to draw into".into()))?;
        let rect = CGRect::new(
            CGPoint::new(0.0, 0.0),
            CGSize::new(width as f64, height as f64),
        );
        CGContext::draw_image(Some(&context), rect, Some(image));
    }
    unpremultiply(&mut pixels);
    Ok(Decoded {
        width: w,
        height: h,
        rgba: pixels,
    })
}

fn unpremultiply(rgba: &mut [u8]) {
    for px in rgba.as_chunks_mut::<4>().0 {
        let a = u32::from(px[3]);
        if a == 0 || a == 255 {
            continue;
        }
        for c in &mut px[..3] {
            *c = ((u32::from(*c) * 255 + a / 2) / a).min(255) as u8;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn premultiplied_alpha_is_made_straight() {
        let mut px = [64, 32, 0, 128, 10, 20, 30, 255, 0, 0, 0, 0];
        unpremultiply(&mut px);
        assert_eq!(px, [128, 64, 0, 128, 10, 20, 30, 255, 0, 0, 0, 0]);
    }
}
