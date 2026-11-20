//! Files into the asset library: what is dropped on the library or pasted
//! into it, and what the 「从文件导入图片或 PDF…」 picker brings.
//!
//! - An image (PNG, JPEG, GIF, WebP, BMP, TIFF; HEIC, HEIF and AVIF) or a
//!   PDF is copied into the library as the asset's source (dr-store: an
//!   atomic write, its SHA-256), byte for byte, then its record goes into
//!   the book's asset library (`asset.put`), named with the file's name
//!   without its extension. Nothing else is made: no template, no entry
//!   (`kernel-v5.md` §6 素材库).
//! - Kept beside the source: for an image a display copy (at most 2048 px a
//!   side) and a thumbnail (at most 256 px); for a PDF a thumbnail of its
//!   first page. Failing to make them does not fail the import (the viewer
//!   falls back to the source).
//! - HEIC, HEIF and AVIF are decoded by the system (dr-platform's
//!   `image_codec`: ImageIO on macOS, WIC on Windows with the Store's
//!   extensions); their display copy and thumbnail are JPEG (PNG when
//!   transparent), so every view and every device can show them. Where the
//!   system cannot decode them, adding one is refused and reported as a
//!   damaged image is (the library takes no image without its size).
//!   [`make_missing_copies`] makes the copies later for such a file that
//!   came without them (a 0.1 import, a sync from a device that could not
//!   make them); where the system cannot decode it, it shows as any image
//!   that cannot be decoded.
//! - Anything else (a folder, a Word file) and an image whose size cannot be
//!   read are skipped and reported.
//!
//! Run these off the main thread.

use std::io::Read as _;
use std::path::{Path, PathBuf};

use dr_platform::image_codec::{self, SystemFormat};
use dr_store::asset::{
    Derived, ImageDeriver, MAX_COPY_BYTES, MAX_WRITE_BYTES, SourceImport, Variant, VariantBytes,
};
use dr_workspace::commands::asset::{AssetPut, AssetPutIn};
use dr_workspace::{Actor, Workspace as Library};
use image::{DynamicImage, GenericImageView as _, ImageFormat, RgbaImage};

use crate::media::PdfDoc;

/// The longest side of an image's display copy.
pub const DISPLAY_SIDE: u32 = 2048;
/// The longest side of a thumbnail.
pub const THUMB_SIDE: u32 = 256;

/// What a file is, as a material.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileKind {
    /// `image` or `pdf`.
    pub kind: &'static str,
    pub mime: &'static str,
    pub ext: &'static str,
}

const PDF: FileKind = FileKind {
    kind: "pdf",
    mime: "application/pdf",
    ext: "pdf",
};

fn image_kind(mime: &'static str, ext: &'static str) -> FileKind {
    FileKind {
        kind: "image",
        mime,
        ext,
    }
}

/// A file's kind by its extension.
pub fn kind_of_path(path: &Path) -> Option<FileKind> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "pdf" => PDF,
        "png" => image_kind("image/png", "png"),
        "jpg" | "jpeg" => image_kind("image/jpeg", "jpg"),
        "gif" => image_kind("image/gif", "gif"),
        "webp" => image_kind("image/webp", "webp"),
        "bmp" => image_kind("image/bmp", "bmp"),
        "tif" | "tiff" => image_kind("image/tiff", "tiff"),
        other => return SystemFormat::from_extension(other).map(system_kind),
    })
}

fn system_kind(format: SystemFormat) -> FileKind {
    image_kind(format.mime(), format.ext())
}

/// Bytes' kind by how they begin.
pub fn kind_of_bytes(bytes: &[u8]) -> Option<FileKind> {
    if bytes.starts_with(b"%PDF-") {
        return Some(PDF);
    }
    if let Some(format) = SystemFormat::sniff(bytes) {
        return Some(system_kind(format));
    }
    Some(match image::guess_format(bytes).ok()? {
        ImageFormat::Png => image_kind("image/png", "png"),
        ImageFormat::Jpeg => image_kind("image/jpeg", "jpg"),
        ImageFormat::Gif => image_kind("image/gif", "gif"),
        ImageFormat::WebP => image_kind("image/webp", "webp"),
        ImageFormat::Bmp => image_kind("image/bmp", "bmp"),
        ImageFormat::Tiff => image_kind("image/tiff", "tiff"),
        _ => return None,
    })
}

/// A file put into the asset library.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Imported {
    /// The file's asset id (the library's material id for it).
    pub material: String,
    pub title: String,
    /// True when the bytes matched an existing file in the book and `asset.put`
    /// returned that file's id instead of creating a new record.
    pub reused: bool,
}

/// Default name for a pasted image: replaces `{{stamp}}` with `MM-DD HH.mm` in
/// local time (or appends ` MM-DD HH.mm` when `prefix` carries no placeholder).
pub fn pasted_image_title(prefix: &str) -> String {
    use chrono::{Datelike as _, Local, Timelike as _};
    let now = Local::now();
    let stamp = format!(
        "{:02}-{:02} {:02}.{:02}",
        now.month(),
        now.day(),
        now.hour(),
        now.minute(),
    );
    if prefix.contains("{{stamp}}") {
        prefix.replace("{{stamp}}", &stamp)
    } else {
        format!("{prefix} {stamp}")
    }
}

/// What an import of several files came to.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Report {
    pub imported: Vec<Imported>,
    /// Files that are not images or PDFs, or could not be read.
    pub skipped: Vec<(PathBuf, String)>,
}

/// Makes display copies and thumbnails of images.
pub struct Deriver;

fn bounded(image: &DynamicImage, side: u32) -> DynamicImage {
    let (w, h) = image.dimensions();
    if w.max(h) <= side {
        return image.clone();
    }
    image.resize(side, side, image::imageops::FilterType::Triangle)
}

/// An image encoded for keeping: JPEG when nothing in it is transparent,
/// PNG when something is.
fn encode(image: &DynamicImage) -> Result<VariantBytes, String> {
    let (width, height) = image.dimensions();
    let mut bytes = Vec::new();
    // An alpha channel that is opaque everywhere (screenshots often have
    // one) is no transparency.
    let transparent =
        image.color().has_alpha() && image.to_rgba8().pixels().any(|p| p.0[3] < u8::MAX);
    let (mime, ext) = if transparent {
        image
            .write_to(&mut std::io::Cursor::new(&mut bytes), ImageFormat::Png)
            .map_err(|e| e.to_string())?;
        ("image/png", "png")
    } else {
        DynamicImage::ImageRgb8(image.to_rgb8())
            .write_to(&mut std::io::Cursor::new(&mut bytes), ImageFormat::Jpeg)
            .map_err(|e| e.to_string())?;
        ("image/jpeg", "jpg")
    };
    Ok(VariantBytes {
        bytes,
        mime: mime.into(),
        ext: ext.into(),
        width,
        height,
    })
}

impl ImageDeriver for Deriver {
    fn derive(&self, source: &Path, _mime: &str) -> Result<Derived, String> {
        let image = if system_format_of(source).is_some() {
            // Decoded by the system already bounded to the display size.
            let bytes = std::fs::read(source).map_err(|e| e.to_string())?;
            system_image(&bytes, DISPLAY_SIDE)?
        } else {
            image::open(source).map_err(|e| e.to_string())?
        };
        Ok(Derived {
            display: encode(&bounded(&image, DISPLAY_SIDE))?,
            thumbnail: encode(&bounded(&image, THUMB_SIDE))?,
        })
    }
}

/// The system format a file is in, by its first bytes.
fn system_format_of(path: &Path) -> Option<SystemFormat> {
    let mut head = [0u8; 512];
    let n = std::fs::File::open(path)
        .and_then(|mut f| f.read(&mut head))
        .ok()?;
    SystemFormat::sniff(&head[..n])
}

/// A HEIC, HEIF or AVIF decoded by the system, at most `side` a side.
fn system_image(bytes: &[u8], side: u32) -> Result<DynamicImage, String> {
    let decoded = image_codec::decode(bytes, side).map_err(|e| e.to_string())?;
    RgbaImage::from_raw(decoded.width, decoded.height, decoded.rgba)
        .map(DynamicImage::ImageRgba8)
        .ok_or_else(|| "decoded image is incomplete".into())
}

/// An image's pixel size without decoding it, by the `image` crate or, for
/// HEIC, HEIF and AVIF, by the system.
fn image_dimensions(path: &Path) -> Option<(u32, u32)> {
    if system_format_of(path).is_some() {
        let bytes = std::fs::read(path).ok()?;
        return image_codec::dimensions(&bytes).ok();
    }
    image::image_dimensions(path).ok()
}

/// The display copy and thumbnail of an image only the system can decode
/// (HEIC, HEIF, AVIF) that has neither or only one: one imported from 0.1
/// (whose import carries the source alone) or synced from a device that
/// could not make them. They are kept in the library like those made when a
/// file is added, so every view (prose embeds, entry media, link cards),
/// the export and every device then has a JPEG or PNG to show; the source
/// is left as it is. Other images are left alone (the `image` crate reads
/// their source wherever it is shown). `Ok(true)` when something was made.
/// Blocks: run it off the main thread, when the asset is about to be shown.
pub fn make_missing_copies(store: &dr_store::Library, asset: &str) -> Result<bool, String> {
    let held = |variant: Variant| -> Result<Option<dr_store::asset::AssetRecord>, String> {
        Ok(store
            .asset(asset, variant)
            .map_err(|e| e.to_string())?
            .filter(|r| r.path.is_file()))
    };
    let Some(source) = held(Variant::Source)? else {
        return Ok(false);
    };
    let (display, thumbnail) = (held(Variant::Display)?, held(Variant::Thumbnail)?);
    if (display.is_some() && thumbnail.is_some()) || system_format_of(&source.path).is_none() {
        return Ok(false);
    }
    let made = Deriver.derive(&source.path, &source.mime)?;
    if display.is_none() {
        store
            .put_variant(asset, Variant::Display, &made.display)
            .map_err(|e| e.to_string())?;
    }
    if thumbnail.is_none() {
        store
            .put_variant(asset, Variant::Thumbnail, &made.thumbnail)
            .map_err(|e| e.to_string())?;
    }
    Ok(true)
}

/// A PDF's first page as a thumbnail.
pub fn pdf_thumbnail(bytes: Vec<u8>) -> Result<VariantBytes, String> {
    let doc = PdfDoc::open(bytes).map_err(|e| format!("{e:?}"))?;
    let (w, h) = doc.pages[0];
    let scale = THUMB_SIDE as f32 / w.max(h).max(1.0);
    let picture = doc.render(0, scale).map_err(|e| format!("{e:?}"))?;
    // The bitmap is BGRA for GPUI; back to RGBA.
    let mut rgba = picture.image.as_bytes(0).ok_or("no page bitmap")?.to_vec();
    for px in rgba.as_chunks_mut::<4>().0 {
        px.swap(0, 2);
    }
    let image = image::RgbaImage::from_raw(picture.width, picture.height, rgba)
        .ok_or("page bitmap size")?;
    encode(&DynamicImage::ImageRgb8(
        DynamicImage::ImageRgba8(image).to_rgb8(),
    ))
}

fn title_of(name: &str) -> String {
    let stem = Path::new(name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(name)
        .trim();
    stem.to_owned()
}

/// The asset's metadata and a material on it, in `folder`.
fn record(
    lib: &Library,
    book: &str,
    folder: Option<&str>,
    asset: &str,
    kind: FileKind,
    title: &str,
) -> Result<Imported, String> {
    let store = lib.library();
    let source = store
        .asset(asset, Variant::Source)
        .map_err(|e| e.to_string())?
        .ok_or("the source was not kept")?;
    // Display copy and thumbnail: an image through the deriver, a PDF's
    // first page by hand. Not having them only costs speed.
    let made = match kind.kind {
        "image" => store
            .derive_variants(asset, &Deriver)
            .map(|_| ())
            .map_err(|e| e.to_string()),
        _ => std::fs::read(&source.path)
            .map_err(|e| e.to_string())
            .and_then(pdf_thumbnail)
            .and_then(|thumb| {
                store
                    .put_variant(asset, Variant::Thumbnail, &thumb)
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            }),
    };
    if let Err(e) = made {
        log::warn!("material: {asset}: no display copy or thumbnail: {e}");
    }
    // Only into the asset library (`kernel-v5.md` §6 素材库): no template,
    // no entry. Media modules and prose embeds use the file from there.
    let put = lib
        .run::<AssetPut>(
            &Actor::User,
            AssetPutIn {
                book: book.to_owned(),
                id: asset.to_owned(),
                name: title.to_owned(),
                kind: kind.kind.to_owned(),
                mime: source.mime.clone(),
                size: source.size as i64,
                sha256: source.sha256.clone(),
                width: (kind.kind == "image")
                    .then_some(source.width)
                    .flatten()
                    .filter(|&w| w > 0)
                    .map(i64::from),
                height: (kind.kind == "image")
                    .then_some(source.height)
                    .flatten()
                    .filter(|&h| h > 0)
                    .map(i64::from),
                folder: folder.map(str::to_owned),
            },
        )
        .map_err(|e| e.to_string())?;
    let reused = put.output.id != asset;
    Ok(Imported {
        material: put.output.id,
        title: title.to_owned(),
        reused,
    })
}

/// One file into a material in `folder`.
pub fn import_path(
    lib: &Library,
    book: &str,
    folder: Option<&str>,
    path: &Path,
) -> Result<Imported, String> {
    let kind = kind_of_path(path).ok_or("not an image or a PDF")?;
    let dimensions = (kind.kind == "image")
        .then(|| image_dimensions(path))
        .flatten();
    if kind.kind == "image" && dimensions.is_none() {
        // The asset library takes no image without its size (`asset.put`):
        // a damaged file, or a HEIC or AVIF this system cannot decode, is
        // skipped before its bytes are copied in, not after.
        return Err("the image's size cannot be read".into());
    }
    let asset = dr_model::id::new_uuid_v7();
    lib.library()
        .import_asset(&SourceImport {
            book_id: book,
            asset_id: &asset,
            source: path,
            mime: kind.mime,
            ext: kind.ext,
            dimensions,
            limit: MAX_COPY_BYTES,
        })
        .map_err(|e| e.to_string())?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    record(lib, book, folder, &asset, kind, &title_of(name))
}

/// Pasted bytes (an image or a PDF) into a material in `folder`, titled
/// `title`.
pub fn import_bytes(
    lib: &Library,
    book: &str,
    folder: Option<&str>,
    bytes: Vec<u8>,
    title: &str,
) -> Result<Imported, String> {
    let kind = kind_of_bytes(&bytes).ok_or("not an image or a PDF")?;
    if bytes.len() > MAX_WRITE_BYTES {
        return Err("too large".into());
    }
    let (width, height) = if SystemFormat::sniff(&bytes).is_some() {
        image_codec::dimensions(&bytes).map_err(|e| e.to_string())?
    } else if kind.kind == "image" {
        image::load_from_memory(&bytes)
            .map(|i| i.dimensions())
            .map_err(|e| e.to_string())?
    } else {
        let doc = PdfDoc::open(bytes.clone()).map_err(|e| format!("{e:?}"))?;
        let (w, h) = doc.pages.first().copied().unwrap_or((1.0, 1.0));
        (w.round().max(1.0) as u32, h.round().max(1.0) as u32)
    };
    let asset = dr_model::id::new_uuid_v7();
    let store = lib.library();
    let mut import = store
        .begin_asset_import(book, &asset)
        .map_err(|e| e.to_string())?;
    let written = import.write_variant(
        Variant::Source,
        &VariantBytes {
            bytes,
            mime: kind.mime.into(),
            ext: kind.ext.into(),
            width,
            height,
        },
    );
    if let Err(e) = written {
        let _ = import.abandon();
        return Err(e.to_string());
    }
    import.commit().map_err(|e| e.to_string())?;
    record(lib, book, folder, &asset, kind, title.trim())
}

/// Several files into materials in `folder`, in order; what is not an
/// image or a PDF is skipped.
pub fn import_paths(lib: &Library, book: &str, folder: Option<&str>, paths: &[PathBuf]) -> Report {
    let mut report = Report::default();
    for path in paths {
        match import_path(lib, book, folder, path) {
            Ok(done) => report.imported.push(done),
            Err(e) => {
                log::info!("material: {} not imported: {e}", path.display());
                report.skipped.push((path.clone(), e));
            }
        }
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_by_extension_and_by_first_bytes() {
        assert_eq!(
            kind_of_path(Path::new("a/Map.PNG")).unwrap().mime,
            "image/png"
        );
        assert_eq!(kind_of_path(Path::new("x.jpeg")).unwrap().ext, "jpg");
        assert_eq!(kind_of_path(Path::new("notes.pdf")).unwrap().kind, "pdf");
        assert_eq!(kind_of_path(Path::new("draft.docx")), None);
        // HEIC, HEIF and AVIF are images, decoded by the system.
        let heic = kind_of_path(Path::new("IMG_0001.HEIC")).unwrap();
        assert_eq!(
            (heic.kind, heic.mime, heic.ext),
            ("image", "image/heic", "heic")
        );
        assert_eq!(
            kind_of_path(Path::new("photo.heif")).unwrap().mime,
            "image/heif"
        );
        assert_eq!(
            kind_of_path(Path::new("photo.avif")).unwrap().mime,
            "image/avif"
        );
        assert_eq!(
            kind_of_bytes(dr_testkit::media::HEIC).unwrap().mime,
            "image/heic"
        );
        assert_eq!(
            kind_of_bytes(dr_testkit::media::AVIF).unwrap().mime,
            "image/avif"
        );
        assert_eq!(
            kind_of_bytes(&dr_testkit::media::png(4, 4)).unwrap().kind,
            "image"
        );
        assert_eq!(
            kind_of_bytes(&dr_testkit::media::sample_pdf())
                .unwrap()
                .kind,
            "pdf"
        );
        assert_eq!(kind_of_bytes(b"hello"), None);
        assert_eq!(title_of("东岸速写.final.png"), "东岸速写.final");
        let stamped = pasted_image_title("粘贴的图片 {{stamp}}");
        assert!(!stamped.contains("{{stamp}}"), "{stamped}");
        assert!(stamped.starts_with("粘贴的图片 "), "{stamped}");
    }

    #[test]
    fn display_copies_and_thumbnails_are_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.png");
        std::fs::write(&path, dr_testkit::media::png(3000, 1000)).unwrap();
        let derived = Deriver.derive(&path, "image/png").unwrap();
        assert_eq!(derived.display.width, DISPLAY_SIDE);
        assert!((682..=683).contains(&derived.display.height));
        assert_eq!(derived.thumbnail.width, THUMB_SIDE);
        // The synthetic map is opaque: kept as JPEG.
        assert_eq!(derived.display.mime, "image/jpeg");
        let thumb = pdf_thumbnail(dr_testkit::media::sample_pdf()).unwrap();
        assert!((THUMB_SIDE - 1..=THUMB_SIDE).contains(&thumb.height));
        assert!(thumb.width < THUMB_SIDE);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn heic_and_avif_get_jpeg_copies_through_the_system() {
        let dir = tempfile::tempdir().unwrap();
        for (name, bytes) in [
            ("photo.heic", dr_testkit::media::HEIC),
            ("photo.avif", dr_testkit::media::AVIF),
        ] {
            let path = dir.path().join(name);
            std::fs::write(&path, bytes).unwrap();
            assert_eq!(image_dimensions(&path), Some((600, 400)), "{name}");
            let derived = Deriver.derive(&path, "image/heic").unwrap();
            assert_eq!((derived.display.width, derived.display.height), (600, 400));
            assert_eq!(derived.display.mime, "image/jpeg");
            assert!(derived.display.bytes.starts_with(b"\xff\xd8\xff"));
            assert_eq!(derived.thumbnail.width, THUMB_SIDE);
            assert!((170..=171).contains(&derived.thumbnail.height));
            // The copy shows the picture: the top left quadrant is red.
            let shown = image::load_from_memory(&derived.thumbnail.bytes)
                .unwrap()
                .to_rgb8();
            let [r, g, b] = shown.get_pixel(40, 40).0;
            assert!(r > 150 && g < 90 && b < 90, "{name}: {r} {g} {b}");
        }
    }
}
