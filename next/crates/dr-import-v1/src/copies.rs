//! 0.1's display and thumbnail copies of an image the new client cannot
//! decode itself, carried beside its source (`m10-import.md` 「资源文件」).
//!
//! What 0.1 keeps (`src/renderer/services/asset-store.service.ts`,
//! `local-project-asset.service.ts`, `src-tauri/src/image_pipeline.rs`):
//! every asset is a folder `assets/<book>/<asset>/` holding
//! `source.<ext>` (the original, its extension from the MIME type) and the
//! derived copies, always JPEG and always named `<variant>.jpg`: an image
//! has `display.jpg` (longest side 1600 px, quality 82) and `thumbnail.jpg`
//! (512 px, quality 72), made by the `image` crate or, for HEIC, HEIF and
//! AVIF, by ImageIO or WIC; a PDF has `thumbnail.jpg` only (its first page,
//! 512 px). A library that received an asset by sync or from a book file
//! holds the source alone until 0.1 shows it and rebuilds them.
//!
//! The new client makes its own copies of what its `image` crate reads
//! (PNG, JPEG, GIF, WebP, BMP, TIFF) and renders PDFs itself, so only the
//! other images get 0.1's copies: HEIC, HEIF and AVIF, which it otherwise
//! decodes through the system on first view (not at all on Windows without
//! the Store's extensions), and anything else 0.1 accepted (an icon). A
//! copy is carried when it is a regular file within dr-store's size cap and
//! a whole JPEG (it begins with a JPEG header that gives its size and ends
//! with the end-of-image marker); otherwise the receipt says why.

use std::io::Cursor;
use std::path::Path;

use dr_store::asset::{MAX_DISPLAY_BYTES, MAX_THUMBNAIL_BYTES, Variant, VariantBytes};

/// The variants 0.1 derives for an image, in the order they are carried.
pub const VARIANTS: [Variant; 2] = [Variant::Display, Variant::Thumbnail];

/// The image types the new client decodes itself (dr-view-material's
/// `import::kind_of_path`).
const DECODED_BY_THE_NEW_CLIENT: &[&str] = &[
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/gif",
    "image/webp",
    "image/bmp",
    "image/tiff",
];

/// Whether a 0.1 asset of `kind` and `mime` (`project_asset.kind`,
/// `source_mime`) has its copies carried: an image the new client cannot
/// decode itself.
pub fn wanted(kind: &str, mime: &str) -> bool {
    let mime = mime
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    kind == "image" && !DECODED_BY_THE_NEW_CLIENT.contains(&mime.as_str())
}

/// Why a wanted copy was not carried (the receipt's words).
pub mod why {
    /// No such file in the 0.1 asset folder.
    pub const MISSING: &str = "missing";
    /// A folder, a link or something else that is not a regular file.
    pub const NOT_A_FILE: &str = "not-a-file";
    /// Larger than dr-store keeps for the variant (8 MiB, 1 MiB).
    pub const TOO_LARGE: &str = "too-large";
    /// Not a JPEG, or one whose size cannot be read.
    pub const NOT_JPEG: &str = "not-jpeg";
    /// A JPEG cut short (no end-of-image marker).
    pub const TRUNCATED: &str = "truncated";
    /// The file could not be read.
    pub const UNREADABLE: &str = "unreadable";
}

fn cap(variant: Variant) -> usize {
    match variant {
        Variant::Thumbnail => MAX_THUMBNAIL_BYTES,
        _ => MAX_DISPLAY_BYTES,
    }
}

/// 0.1's `variant` copy in the asset folder `dir`, checked; or why not.
/// Only reads.
pub fn read(dir: &Path, variant: Variant) -> Result<VariantBytes, &'static str> {
    let path = dir.join(format!("{}.jpg", variant.as_str()));
    let meta = match std::fs::symlink_metadata(&path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(why::MISSING),
        Err(_) => return Err(why::UNREADABLE),
    };
    if !meta.is_file() {
        return Err(why::NOT_A_FILE);
    }
    if meta.len() > cap(variant) as u64 {
        return Err(why::TOO_LARGE);
    }
    let bytes = std::fs::read(&path).map_err(|_| why::UNREADABLE)?;
    if bytes.is_empty() || bytes.len() > cap(variant) {
        return Err(why::TOO_LARGE);
    }
    let (width, height) = jpeg_size(&bytes)?;
    Ok(VariantBytes {
        bytes,
        mime: "image/jpeg".into(),
        ext: "jpg".into(),
        width,
        height,
    })
}

/// A whole JPEG's pixel size: its header read (nothing decoded) and its
/// end-of-image marker present.
fn jpeg_size(bytes: &[u8]) -> Result<(u32, u32), &'static str> {
    if !bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Err(why::NOT_JPEG);
    }
    let size = image::ImageReader::with_format(Cursor::new(bytes), image::ImageFormat::Jpeg)
        .into_dimensions()
        .map_err(|_| why::NOT_JPEG)?;
    if size.0 == 0 || size.1 == 0 {
        return Err(why::NOT_JPEG);
    }
    // Encoders end on FF D9; allow a little padding after it.
    let tail = &bytes[bytes.len().saturating_sub(32)..];
    if !tail.windows(2).any(|w| w == [0xFF, 0xD9]) {
        return Err(why::TRUNCATED);
    }
    Ok(size)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jpeg(width: u32, height: u32) -> Vec<u8> {
        let mut out = Vec::new();
        image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            width,
            height,
            image::Rgb([200, 40, 40]),
        ))
        .write_to(&mut Cursor::new(&mut out), image::ImageFormat::Jpeg)
        .unwrap();
        out
    }

    #[test]
    fn only_images_the_new_client_cannot_read_want_copies() {
        for mime in ["image/heic", "image/heif", "image/avif", "image/x-icon"] {
            assert!(wanted("image", mime), "{mime}");
        }
        for mime in [
            "image/png",
            "image/jpeg",
            "IMAGE/JPEG; charset=binary",
            "image/webp",
            "image/gif",
            "image/bmp",
            "image/tiff",
        ] {
            assert!(!wanted("image", mime), "{mime}");
        }
        assert!(!wanted("pdf", "application/pdf"));
    }

    #[test]
    fn a_copy_is_carried_whole_or_not_at_all() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read(dir.path(), Variant::Display).err(), Some(why::MISSING));
        let good = jpeg(64, 40);
        std::fs::write(dir.path().join("display.jpg"), &good).unwrap();
        let read_back = read(dir.path(), Variant::Display).unwrap();
        assert_eq!((read_back.width, read_back.height), (64, 40));
        assert_eq!(read_back.bytes, good);
        assert_eq!(read_back.mime, "image/jpeg");
        // Cut short in the picture's data: the header still reads.
        std::fs::write(dir.path().join("thumbnail.jpg"), &good[..good.len() - 40]).unwrap();
        assert_eq!(
            read(dir.path(), Variant::Thumbnail).err(),
            Some(why::TRUNCATED)
        );
        // Cut short in the header.
        std::fs::write(dir.path().join("thumbnail.jpg"), &good[..12]).unwrap();
        assert_eq!(
            read(dir.path(), Variant::Thumbnail).err(),
            Some(why::NOT_JPEG)
        );
        // Not a JPEG.
        std::fs::write(dir.path().join("thumbnail.jpg"), b"\x89PNG\r\n\x1a\n").unwrap();
        assert_eq!(
            read(dir.path(), Variant::Thumbnail).err(),
            Some(why::NOT_JPEG)
        );
        // A folder where the file should be.
        std::fs::remove_file(dir.path().join("thumbnail.jpg")).unwrap();
        std::fs::create_dir(dir.path().join("thumbnail.jpg")).unwrap();
        assert_eq!(
            read(dir.path(), Variant::Thumbnail).err(),
            Some(why::NOT_A_FILE)
        );
        // Larger than dr-store keeps for a thumbnail.
        std::fs::remove_dir(dir.path().join("thumbnail.jpg")).unwrap();
        let mut big = good.clone();
        big.splice(2..2, vec![0u8; MAX_THUMBNAIL_BYTES]);
        std::fs::write(dir.path().join("thumbnail.jpg"), &big).unwrap();
        assert_eq!(
            read(dir.path(), Variant::Thumbnail).err(),
            Some(why::TOO_LARGE)
        );
    }
}
