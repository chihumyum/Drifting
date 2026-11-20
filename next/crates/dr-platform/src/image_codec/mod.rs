//! Pictures only the system can decode: HEIC, HEIF and AVIF (iPhone photos
//! and what browsers save). The `image` crate has no HEIC decoder and, as
//! built here, no AVIF one, so these go through the system's codecs, as in
//! the 0.1 client (`src-tauri/src/apple_image_codec.rs`,
//! `windows_image_codec.rs`):
//!
//! - macOS: ImageIO, which decodes all three (AVIF from macOS 13). It turns
//!   the picture upright (EXIF / `irot` orientation) and downsamples while
//!   decoding, so a 12-megapixel photo asked for at 2048 px is never held at
//!   full size.
//! - Windows: the Windows Imaging Component, which decodes them only when the
//!   Microsoft Store's "HEIF Image Extensions" and "HEVC Video Extensions"
//!   (HEIC) or "AV1 Video Extension" (AVIF) are installed. Without them every
//!   call fails with [`CodecError::Unavailable`]. As in 0.1, the orientation
//!   is not applied there.
//! - Elsewhere: always [`CodecError::Unavailable`].
//!
//! Callers keep the original bytes as they are; what comes out is for
//! showing (display copies, thumbnails). Decoding blocks: run it off the
//! main thread.

#[cfg(target_os = "macos")]
mod imageio;
#[cfg(windows)]
mod wic;

/// The largest side accepted (0.1's `MAX_IMAGE_DIMENSION`).
pub const MAX_DIMENSION: u32 = 16_384;
/// The largest picture accepted, as RGBA (0.1's `MAX_IMAGE_ALLOC`).
pub const MAX_ALLOC: u64 = 256 * 1024 * 1024;

/// A format only the system decodes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SystemFormat {
    Heic,
    Heif,
    Avif,
}

impl SystemFormat {
    /// The format of bytes that begin with an ISO-BMFF `ftyp` box naming
    /// one of these brands (0.1's `sniff_system_codec`): AVIF before HEIC
    /// before plain HEIF, because files often list several.
    pub fn sniff(bytes: &[u8]) -> Option<Self> {
        let brands = ftyp_brands(bytes)?;
        let has = |want: &[&[u8; 4]]| brands.iter().any(|b| want.contains(b));
        if has(&[b"avif", b"avis"]) {
            Some(Self::Avif)
        } else if has(&[b"heic", b"heix", b"hevc", b"hevx", b"hevm", b"hevs"]) {
            Some(Self::Heic)
        } else if has(&[b"mif1", b"msf1"]) {
            Some(Self::Heif)
        } else {
            None
        }
    }

    /// The format a file extension names (`heic`, `HEIF`, `avif`).
    pub fn from_extension(ext: &str) -> Option<Self> {
        match ext.trim_start_matches('.').to_ascii_lowercase().as_str() {
            "heic" => Some(Self::Heic),
            "heif" => Some(Self::Heif),
            "avif" => Some(Self::Avif),
            _ => None,
        }
    }

    /// The format a MIME type names (`image/heic`, `image/heif`,
    /// `image/avif`, and their `-sequence` forms).
    pub fn from_mime(mime: &str) -> Option<Self> {
        match mime.trim().to_ascii_lowercase().as_str() {
            "image/heic" | "image/heic-sequence" => Some(Self::Heic),
            "image/heif" | "image/heif-sequence" => Some(Self::Heif),
            "image/avif" | "image/avif-sequence" => Some(Self::Avif),
            _ => None,
        }
    }

    pub fn mime(self) -> &'static str {
        match self {
            Self::Heic => "image/heic",
            Self::Heif => "image/heif",
            Self::Avif => "image/avif",
        }
    }

    pub fn ext(self) -> &'static str {
        match self {
            Self::Heic => "heic",
            Self::Heif => "heif",
            Self::Avif => "avif",
        }
    }
}

impl std::fmt::Display for SystemFormat {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Heic => "HEIC",
            Self::Heif => "HEIF",
            Self::Avif => "AVIF",
        })
    }
}

/// The major brand and the compatible brands of a leading `ftyp` box.
fn ftyp_brands(bytes: &[u8]) -> Option<Vec<&[u8; 4]>> {
    if bytes.len() < 16 || &bytes[4..8] != b"ftyp" {
        return None;
    }
    let declared = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    let end = if declared == 0 {
        bytes.len()
    } else {
        declared.min(bytes.len())
    };
    if end < 16 {
        return None;
    }
    let major = bytes[8..12].as_chunks::<4>().0;
    let compatible = bytes[16..end].as_chunks::<4>().0;
    Some(major.iter().chain(compatible).collect())
}

/// Why a picture could not be decoded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CodecError {
    /// The bytes are not HEIC, HEIF or AVIF.
    NotSystemFormat,
    /// This system has no decoder for the format (Windows without the Store
    /// extensions, a macOS too old for AVIF, any other platform).
    Unavailable(SystemFormat),
    /// The system has the decoder and the file is damaged, too large, or
    /// otherwise refused.
    Invalid(String),
}

impl std::fmt::Display for CodecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotSystemFormat => f.write_str("not a HEIC, HEIF or AVIF image"),
            Self::Unavailable(format) => {
                write!(f, "{format} decoding is not available on this system")
            }
            Self::Invalid(why) => f.write_str(why),
        }
    }
}

impl std::error::Error for CodecError {}

/// A decoded picture: straight (not premultiplied) RGBA, 8 bits a channel,
/// rows from the top, upright where the platform applies orientation.
#[derive(Clone, PartialEq, Eq)]
pub struct Decoded {
    pub width: u32,
    pub height: u32,
    /// `width × height × 4` bytes.
    pub rgba: Vec<u8>,
}

impl std::fmt::Debug for Decoded {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Decoded({}×{})", self.width, self.height)
    }
}

/// Whether a picture of `width × height` is within the limits.
pub(crate) fn check_size(width: u32, height: u32) -> Result<(), CodecError> {
    if width == 0 || height == 0 {
        return Err(CodecError::Invalid("the image has no pixels".into()));
    }
    if width > MAX_DIMENSION || height > MAX_DIMENSION {
        return Err(CodecError::Invalid(format!(
            "image dimensions exceed the {MAX_DIMENSION} pixel limit"
        )));
    }
    if u64::from(width) * u64::from(height) * 4 > MAX_ALLOC {
        return Err(CodecError::Invalid(
            "decoded image exceeds the 256 MiB allocation limit".into(),
        ));
    }
    Ok(())
}

/// `width × height` scaled so the longest side is at most `max_side`
/// (never enlarged), rounded, at least 1.
pub fn bounded(width: u32, height: u32, max_side: u32) -> (u32, u32) {
    let (width, height, max_side) = (width.max(1), height.max(1), max_side.max(1));
    let longest = width.max(height);
    if longest <= max_side {
        return (width, height);
    }
    let scale = |v: u32| {
        ((u64::from(v) * u64::from(max_side) + u64::from(longest) / 2) / u64::from(longest)).max(1)
            as u32
    };
    (scale(width), scale(height))
}

/// The pixel size of a HEIC, HEIF or AVIF, upright, without decoding it.
pub fn dimensions(bytes: &[u8]) -> Result<(u32, u32), CodecError> {
    let format = SystemFormat::sniff(bytes).ok_or(CodecError::NotSystemFormat)?;
    platform_dimensions(bytes, format)
}

/// A HEIC, HEIF or AVIF decoded with its longest side at most `max_side`
/// (smaller pictures keep their size).
pub fn decode(bytes: &[u8], max_side: u32) -> Result<Decoded, CodecError> {
    let format = SystemFormat::sniff(bytes).ok_or(CodecError::NotSystemFormat)?;
    let decoded = platform_decode(bytes, format, max_side.max(1))?;
    if decoded.rgba.len() as u64 != u64::from(decoded.width) * u64::from(decoded.height) * 4 {
        return Err(CodecError::Invalid("decoded image is incomplete".into()));
    }
    Ok(decoded)
}

#[cfg(target_os = "macos")]
fn platform_dimensions(bytes: &[u8], format: SystemFormat) -> Result<(u32, u32), CodecError> {
    imageio::dimensions(bytes, format)
}

#[cfg(target_os = "macos")]
fn platform_decode(bytes: &[u8], format: SystemFormat, max: u32) -> Result<Decoded, CodecError> {
    imageio::decode(bytes, format, max)
}

#[cfg(windows)]
fn platform_dimensions(bytes: &[u8], format: SystemFormat) -> Result<(u32, u32), CodecError> {
    wic::dimensions(bytes, format)
}

#[cfg(windows)]
fn platform_decode(bytes: &[u8], format: SystemFormat, max: u32) -> Result<Decoded, CodecError> {
    wic::decode(bytes, format, max)
}

#[cfg(not(any(target_os = "macos", windows)))]
fn platform_dimensions(_bytes: &[u8], format: SystemFormat) -> Result<(u32, u32), CodecError> {
    Err(CodecError::Unavailable(format))
}

#[cfg(not(any(target_os = "macos", windows)))]
fn platform_decode(_bytes: &[u8], format: SystemFormat, _max: u32) -> Result<Decoded, CodecError> {
    Err(CodecError::Unavailable(format))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn brands_name_the_format_and_other_bytes_are_not_one() {
        assert_eq!(
            SystemFormat::sniff(b"\0\0\0\x18ftypheic\0\0\0\0mif1"),
            Some(SystemFormat::Heic)
        );
        assert_eq!(
            SystemFormat::sniff(b"\0\0\0\x18ftypmif1\0\0\0\0avif"),
            Some(SystemFormat::Avif)
        );
        assert_eq!(
            SystemFormat::sniff(b"\0\0\0\x18ftypmif1\0\0\0\0heic"),
            Some(SystemFormat::Heic)
        );
        assert_eq!(
            SystemFormat::sniff(b"\0\0\0\x14ftypmif1\0\0\0\0"),
            Some(SystemFormat::Heif)
        );
        assert_eq!(SystemFormat::sniff(b"\0\0\0\x18ftypisom\0\0\0\0mp41"), None);
        assert_eq!(SystemFormat::sniff(b"\x89PNG\r\n\x1a\n\0\0\0\0IHDR"), None);
        assert_eq!(SystemFormat::sniff(b"ftyp"), None);
        assert_eq!(
            SystemFormat::from_extension(".HEIC"),
            Some(SystemFormat::Heic)
        );
        assert_eq!(
            SystemFormat::from_extension("avif"),
            Some(SystemFormat::Avif)
        );
        assert_eq!(SystemFormat::from_extension("png"), None);
        assert_eq!(
            SystemFormat::from_mime("image/heif"),
            Some(SystemFormat::Heif)
        );
        assert_eq!(SystemFormat::from_mime("image/png"), None);
        assert_eq!(
            decode(b"\x89PNG\r\n\x1a\n", 64),
            Err(CodecError::NotSystemFormat)
        );
    }

    #[test]
    fn sizes_are_bounded_without_enlarging() {
        assert_eq!(bounded(600, 400, 256), (256, 171));
        assert_eq!(bounded(400, 600, 256), (171, 256));
        assert_eq!(bounded(600, 400, 2048), (600, 400));
        assert_eq!(bounded(4032, 3024, 2048), (2048, 1536));
        assert!(check_size(MAX_DIMENSION + 1, 10).is_err());
        assert!(check_size(0, 10).is_err());
        assert!(check_size(4032, 3024).is_ok());
    }
}
