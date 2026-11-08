//! Files into materials: what is dropped on the library or pasted into it,
//! and what the 「从文件导入图片或 PDF…」 picker brings (the 0.1 client's
//! `createLibraryItem` with a staged source).
//!
//! - An image (PNG, JPEG, GIF, WebP, BMP, TIFF) or a PDF is copied into the
//!   library as the asset's source (dr-store: an atomic write, its SHA-256),
//!   then its metadata goes into the book (`asset.put`) and a material is
//!   made on it (`material.create`), filed in the folder it was dropped on,
//!   titled with the file's name without its extension.
//! - Kept beside the source: for an image a display copy (at most 2048 px a
//!   side) and a thumbnail (at most 256 px); for a PDF a thumbnail of its
//!   first page. Failing to make them does not fail the import (the viewer
//!   falls back to the source).
//! - Anything else (a folder, a Word file, HEIC, which needs the system's
//!   decoder) is skipped and reported.
//!
//! Run these off the main thread.

use std::path::{Path, PathBuf};

use dr_store::asset::{
    Derived, ImageDeriver, MAX_COPY_BYTES, MAX_WRITE_BYTES, SourceImport, Variant, VariantBytes,
};
use dr_workspace::commands::material::{AssetPut, AssetPutIn, MaterialCreate, MaterialCreateIn};
use dr_workspace::{Actor, Workspace as Library};
use image::{DynamicImage, GenericImageView as _, ImageFormat};

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
        _ => return None,
    })
}

/// Bytes' kind by how they begin.
pub fn kind_of_bytes(bytes: &[u8]) -> Option<FileKind> {
    if bytes.starts_with(b"%PDF-") {
        return Some(PDF);
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

/// A material made from a file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Imported {
    pub material: String,
    pub title: String,
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
        let image = image::open(source).map_err(|e| e.to_string())?;
        Ok(Derived {
            display: encode(&bounded(&image, DISPLAY_SIDE))?,
            thumbnail: encode(&bounded(&image, THUMB_SIDE))?,
        })
    }
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
    lib.run::<AssetPut>(
        &Actor::User,
        AssetPutIn {
            book: book.to_owned(),
            id: asset.to_owned(),
            kind: kind.kind.to_owned(),
            mime: source.mime.clone(),
            size: source.size as i64,
            sha256: source.sha256.clone(),
            width: source.width.map(i64::from),
            height: source.height.map(i64::from),
        },
    )
    .map_err(|e| e.to_string())?;
    let made = lib
        .run::<MaterialCreate>(
            &Actor::User,
            MaterialCreateIn {
                book: book.to_owned(),
                kind: kind.kind.to_owned(),
                title: title.to_owned(),
                asset: Some(asset.to_owned()),
                folder: folder.map(str::to_owned),
                place: None,
                description: String::new(),
                text: None,
            },
        )
        .map_err(|e| e.to_string())?
        .output;
    Ok(Imported {
        material: made.id,
        title: made.name,
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
        .then(|| image::image_dimensions(path).ok())
        .flatten();
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
    let (width, height) = if kind.kind == "image" {
        image::load_from_memory(&bytes)
            .map(|i| i.dimensions())
            .map_err(|e| e.to_string())?
    } else {
        (0, 0)
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
        assert_eq!(kind_of_path(Path::new("photo.heic")), None);
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
}
