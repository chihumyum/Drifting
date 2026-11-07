//! Asset bytes this device holds, in three variants:
//!
//! - `source`: the imported file, byte for byte, immutable;
//! - `display`: a bounded JPEG for showing in the app;
//! - `thumbnail`: a small JPEG for lists and cards.
//!
//! Files live at `assets/<book>/<asset>/<variant>.<ext>`; the `asset` table
//! has one row per variant. The commit protocol is the 0.1 client's
//! (`crates/drifting-core/src/asset_store.rs`): an import writes a marker
//! naming this process before any byte, copies the source atomically under a
//! size cap, inserts the row, and only then clears the marker. Removal
//! deletes the rows first and the directory after. Garbage collection
//! removes every directory no row keeps, except this process's unfinished
//! imports, so an interrupted import or removal converges.
//!
//! Making display and thumbnail images (decoding, orientation, resizing,
//! HEIC through the system codec) is the image pipeline's job
//! (`src-tauri/src/image_pipeline.rs` in 0.1); here it is only the
//! [`ImageDeriver`] interface.

use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use rusqlite::{OptionalExtension, params};

use crate::error::{Result, StoreError};
use crate::file_io::{atomic_copy_capped, atomic_write, file_sha256, sha256_hex, sync_directory};
use crate::{Library, now_ms};

const MARKER: &str = ".importing";
const MAX_SEGMENT: usize = 128;
/// Largest display image the pipeline may produce (0.1: 8 MiB).
pub const MAX_DISPLAY_BYTES: usize = 8 * 1024 * 1024;
/// Largest thumbnail the pipeline may produce (0.1: 1 MiB).
pub const MAX_THUMBNAIL_BYTES: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Variant {
    Source,
    Display,
    Thumbnail,
}

impl Variant {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Source => "source",
            Self::Display => "display",
            Self::Thumbnail => "thumbnail",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "source" => Self::Source,
            "display" => Self::Display,
            "thumbnail" => Self::Thumbnail,
            _ => return None,
        })
    }
}

/// One stored variant.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetRecord {
    pub asset_id: String,
    pub variant: Variant,
    pub book_id: String,
    pub mime: String,
    pub ext: String,
    pub size: u64,
    pub sha256: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub created_ms: i64,
    pub path: PathBuf,
}

/// What to import as a source.
#[derive(Clone, Debug)]
pub struct SourceImport<'a> {
    pub book_id: &'a str,
    pub asset_id: &'a str,
    pub source: &'a Path,
    pub mime: &'a str,
    pub ext: &'a str,
    /// Pixel size of an image (None for a PDF).
    pub dimensions: Option<(u32, u32)>,
    /// Refuse files larger than this.
    pub limit: u64,
}

/// An encoded derived image.
#[derive(Clone, Debug)]
pub struct VariantBytes {
    pub bytes: Vec<u8>,
    pub mime: String,
    pub ext: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug)]
pub struct Derived {
    pub display: VariantBytes,
    pub thumbnail: VariantBytes,
}

/// Makes the display and thumbnail variants of an image. Implemented by the
/// image pipeline (decoders, EXIF orientation, bounded resizing).
pub trait ImageDeriver {
    fn derive(&self, source: &Path, mime: &str) -> std::result::Result<Derived, String>;
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AssetGarbage {
    pub removed: u64,
    pub cleared_markers: u64,
}

fn segment(value: &str) -> Result<&str> {
    let ok = !value.is_empty()
        && value.len() <= MAX_SEGMENT
        && !value.starts_with('.')
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        && matches!(
            Path::new(value).components().collect::<Vec<_>>()[..],
            [Component::Normal(_)]
        );
    if ok {
        Ok(value)
    } else {
        Err(StoreError::invalid("asset path segment", value))
    }
}

fn extension(value: &str) -> Result<String> {
    let e = value.trim_start_matches('.').to_ascii_lowercase();
    if e.is_empty() || e.len() > 8 || !e.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err(StoreError::invalid("asset extension", value));
    }
    Ok(e)
}

/// Refuses a symlink anywhere in managed paths.
fn real_directory(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_symlink() => Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "asset paths may not be symlinks",
        )),
        Ok(m) => Ok(m.is_dir()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

fn remove_directory(directory: &Path) -> io::Result<()> {
    if !real_directory(directory)? {
        return Ok(());
    }
    fs::remove_dir_all(directory)?;
    if let Some(parent) = directory.parent() {
        sync_directory(parent)?;
    }
    Ok(())
}

impl Library {
    fn asset_dir(&self, book_id: &str, asset_id: &str) -> Result<PathBuf> {
        let root = &self.paths().assets;
        let book = root.join(segment(book_id)?);
        let dir = book.join(segment(asset_id)?);
        for p in [root, &book, &dir] {
            real_directory(p)?;
        }
        Ok(dir)
    }

    fn variant_path(
        &self,
        book_id: &str,
        asset_id: &str,
        variant: Variant,
        ext: &str,
    ) -> Result<PathBuf> {
        Ok(self.asset_dir(book_id, asset_id)?.join(format!(
            "{}.{}",
            variant.as_str(),
            extension(ext)?
        )))
    }

    /// Import a source file. The asset must be new: sources are immutable.
    pub fn import_asset(&self, import: &SourceImport<'_>) -> Result<AssetRecord> {
        let dir = self.asset_dir(import.book_id, import.asset_id)?;
        let ext = extension(import.ext)?;
        if real_directory(&dir)? || self.asset(import.asset_id, Variant::Source)?.is_some() {
            return Err(StoreError::Asset(format!(
                "asset {} already exists",
                import.asset_id
            )));
        }
        if let Some((w, h)) = import.dimensions
            && (w == 0 || h == 0)
        {
            return Err(StoreError::invalid("asset dimensions", format!("{w}x{h}")));
        }
        let path = dir.join(format!("source.{ext}"));
        let copied = (|| -> io::Result<(String, u64)> {
            fs::create_dir_all(&dir)?;
            if let Some(parent) = dir.parent() {
                sync_directory(parent)?;
            }
            let marker = dir.join(MARKER);
            fs::write(&marker, self.inner.session.as_bytes())?;
            crate::file_io::sync_file(&marker)?;
            sync_directory(&dir)?;
            atomic_copy_capped(import.source, &path, import.limit)?;
            file_sha256(&path)
        })();
        let (sha256, size) = match copied {
            Ok(v) => v,
            Err(e) => {
                let _ = remove_directory(&dir);
                return Err(match e.kind() {
                    io::ErrorKind::InvalidData => {
                        StoreError::Asset(format!("file exceeds the {} byte limit", import.limit))
                    }
                    io::ErrorKind::InvalidInput => StoreError::Asset("not a file".into()),
                    _ => e.into(),
                });
            }
        };
        let record = AssetRecord {
            asset_id: import.asset_id.into(),
            variant: Variant::Source,
            book_id: import.book_id.into(),
            mime: import.mime.into(),
            ext,
            size,
            sha256,
            width: import.dimensions.map(|d| d.0),
            height: import.dimensions.map(|d| d.1),
            created_ms: now_ms(),
            path,
        };
        if let Err(e) = self.insert_asset_row(&record, false) {
            let _ = remove_directory(&dir);
            return Err(e);
        }
        self.clear_marker(&dir)?;
        Ok(record)
    }

    fn insert_asset_row(&self, r: &AssetRecord, replace: bool) -> Result<()> {
        let verb = if replace {
            "INSERT OR REPLACE"
        } else {
            "INSERT"
        };
        self.writer().execute(
            &format!(
                "{verb} INTO asset (asset_id, variant, book_id, mime, ext, size, sha256, width, height, created_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)"
            ),
            params![
                r.asset_id,
                r.variant.as_str(),
                r.book_id,
                r.mime,
                r.ext,
                r.size as i64,
                r.sha256,
                r.width,
                r.height,
                r.created_ms
            ],
        )?;
        Ok(())
    }

    fn clear_marker(&self, dir: &Path) -> Result<()> {
        match fs::remove_file(dir.join(MARKER)) {
            Ok(()) => Ok(sync_directory(dir)?),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    /// Store (or replace) a display or thumbnail variant of an imported asset.
    pub fn put_variant(
        &self,
        asset_id: &str,
        variant: Variant,
        v: &VariantBytes,
    ) -> Result<AssetRecord> {
        let limit = match variant {
            Variant::Source => {
                return Err(StoreError::Asset("the source variant is immutable".into()));
            }
            Variant::Display => MAX_DISPLAY_BYTES,
            Variant::Thumbnail => MAX_THUMBNAIL_BYTES,
        };
        if v.bytes.is_empty() || v.bytes.len() > limit {
            return Err(StoreError::Asset(format!(
                "{} must be 1..={limit} bytes",
                variant.as_str()
            )));
        }
        if v.width == 0 || v.height == 0 {
            return Err(StoreError::invalid(
                "asset dimensions",
                format!("{}x{}", v.width, v.height),
            ));
        }
        let source = self
            .asset(asset_id, Variant::Source)?
            .ok_or_else(|| StoreError::NotFound(format!("asset {asset_id}")))?;
        let path = self.variant_path(&source.book_id, asset_id, variant, &v.ext)?;
        atomic_write(&path, &v.bytes)?;
        let record = AssetRecord {
            asset_id: asset_id.into(),
            variant,
            book_id: source.book_id,
            mime: v.mime.clone(),
            ext: extension(&v.ext)?,
            size: v.bytes.len() as u64,
            sha256: sha256_hex(&v.bytes),
            width: Some(v.width),
            height: Some(v.height),
            created_ms: now_ms(),
            path,
        };
        self.insert_asset_row(&record, true)?;
        Ok(record)
    }

    /// Make and store the display and thumbnail variants of an image.
    pub fn derive_variants(
        &self,
        asset_id: &str,
        deriver: &dyn ImageDeriver,
    ) -> Result<(AssetRecord, AssetRecord)> {
        let source = self
            .asset(asset_id, Variant::Source)?
            .ok_or_else(|| StoreError::NotFound(format!("asset {asset_id}")))?;
        let derived = deriver
            .derive(&source.path, &source.mime)
            .map_err(StoreError::Asset)?;
        Ok((
            self.put_variant(asset_id, Variant::Display, &derived.display)?,
            self.put_variant(asset_id, Variant::Thumbnail, &derived.thumbnail)?,
        ))
    }

    fn asset_rows(&self, clause: &str, args: &[&dyn rusqlite::ToSql]) -> Result<Vec<AssetRecord>> {
        let conn = self.reader();
        let sql = format!(
            "SELECT asset_id, variant, book_id, mime, ext, size, sha256, width, height, created_ms
             FROM asset WHERE {clause} ORDER BY book_id, asset_id, variant"
        );
        let rows = conn
            .prepare_cached(&sql)?
            .query_map(args, |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, i64>(5)?,
                    r.get::<_, String>(6)?,
                    r.get::<_, Option<u32>>(7)?,
                    r.get::<_, Option<u32>>(8)?,
                    r.get::<_, i64>(9)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(conn);
        rows.into_iter()
            .map(
                |(
                    asset_id,
                    variant,
                    book_id,
                    mime,
                    ext,
                    size,
                    sha256,
                    width,
                    height,
                    created_ms,
                )| {
                    let variant = Variant::parse(&variant)
                        .ok_or_else(|| StoreError::invalid("asset variant", variant))?;
                    let path = self.variant_path(&book_id, &asset_id, variant, &ext)?;
                    Ok(AssetRecord {
                        asset_id,
                        variant,
                        book_id,
                        mime,
                        ext,
                        size: size as u64,
                        sha256,
                        width,
                        height,
                        created_ms,
                        path,
                    })
                },
            )
            .collect()
    }

    pub fn asset(&self, asset_id: &str, variant: Variant) -> Result<Option<AssetRecord>> {
        Ok(self
            .asset_rows(
                "asset_id = ?1 AND variant = ?2",
                &[&asset_id, &variant.as_str()],
            )?
            .pop())
    }

    /// Every stored variant of every asset of a book.
    pub fn assets_of_book(&self, book_id: &str) -> Result<Vec<AssetRecord>> {
        self.asset_rows("book_id = ?1", &[&book_id])
    }

    /// The source of a book's asset with these bytes, if one exists (to reuse
    /// it instead of importing a duplicate).
    pub fn find_asset_by_sha256(&self, book_id: &str, sha256: &str) -> Result<Option<AssetRecord>> {
        Ok(self
            .asset_rows(
                "book_id = ?1 AND sha256 = ?2 AND variant = 'source'",
                &[&book_id, &sha256],
            )?
            .into_iter()
            .next())
    }

    /// Remove an asset: rows first, then its directory.
    pub fn remove_asset(&self, asset_id: &str) -> Result<bool> {
        let book: Option<String> = self
            .reader()
            .query_row(
                "SELECT book_id FROM asset WHERE asset_id = ?1 LIMIT 1",
                [asset_id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(book) = book else {
            return Ok(false);
        };
        self.writer()
            .execute("DELETE FROM asset WHERE asset_id = ?1", [asset_id])?;
        remove_directory(&self.asset_dir(&book, asset_id)?)?;
        Ok(true)
    }

    /// Remove every asset directory no row keeps, except this process's
    /// unfinished imports; clear markers left on kept ones.
    pub fn collect_asset_garbage(&self) -> Result<AssetGarbage> {
        let mut result = AssetGarbage::default();
        let root = self.paths().assets.clone();
        if !real_directory(&root)? {
            return Ok(result);
        }
        let retained: HashSet<(String, String)> = {
            let conn = self.reader();
            conn.prepare("SELECT DISTINCT book_id, asset_id FROM asset")?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?
        };
        let dirs = |path: &Path| -> Result<Vec<(String, PathBuf)>> {
            let mut found = Vec::new();
            for entry in fs::read_dir(path)? {
                let entry = entry?;
                let kind = entry.file_type()?;
                if kind.is_symlink() {
                    return Err(StoreError::Asset("asset store contains a symlink".into()));
                }
                if let Ok(name) = entry.file_name().into_string()
                    && kind.is_dir()
                    && segment(&name).is_ok()
                {
                    found.push((name, entry.path()));
                }
            }
            Ok(found)
        };
        for (book, book_path) in dirs(&root)? {
            for (asset, dir) in dirs(&book_path)? {
                let owner = fs::read_to_string(dir.join(MARKER)).ok();
                if retained.contains(&(book.clone(), asset.clone())) {
                    if owner.is_some() {
                        self.clear_marker(&dir)?;
                        result.cleared_markers += 1;
                    }
                } else if owner.as_deref().map(str::trim) != Some(self.inner.session.as_str()) {
                    remove_directory(&dir)?;
                    result.removed += 1;
                }
            }
        }
        Ok(result)
    }
}
