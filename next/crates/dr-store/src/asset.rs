//! Asset bytes this device holds, in three variants:
//!
//! - `source`: the imported file, byte for byte, immutable;
//! - `display`: a bounded image for showing in the app;
//! - `thumbnail`: a small image for lists and cards.
//!
//! The semantics are the 0.1 product's (`src-tauri/src/native_capabilities.rs`),
//! not the older `crates/drifting-core/src/asset_store.rs`:
//!
//! - Files live at `assets/<book>/<asset>/<variant>.<ext>`. Ids are turned
//!   into path segments the 0.1 way (characters outside `[A-Za-z0-9._-]`
//!   become `_`, a leading dot gets a `_` in front), so an imported 0.1 store
//!   maps one to one. Symlinks anywhere in a managed path are refused.
//! - An import first writes the marker `.drifting-import-v1` (atomically,
//!   naming this process), then the variants (atomic writes, size caps),
//!   then the rows in one transaction, and only then clears the marker.
//! - Garbage collection looks only at directories that still carry a marker:
//!   with rows, the marker is cleared; without rows and owned by another
//!   process, the directory is deleted; this process's imports in flight are
//!   kept. Directories without a marker are never collected.
//! - Deleting removes the rows first, then the directory durably: on Unix the
//!   asset directory goes, the book directory is synced, an empty book
//!   directory goes and the root is synced; on Windows the directories are
//!   first renamed to a deterministic tombstone with a write-through move.
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

use crate::digest::{file_sha256, sha256_hex};
use crate::error::{Result, StoreError};
use crate::events::{LocalChange, LocalChangeKind};
use crate::file_io::{atomic_copy_capped, atomic_write, sync_directory};
use crate::{Library, now_ms};

pub const IMPORT_MARKER: &str = ".drifting-import-v1";
const MAX_SEGMENT: usize = 128;
const MAX_EXTENSION_LEN: usize = 16;
const MAX_MARKER_BYTES: u64 = 256;
/// Largest asset written from memory (0.1: `MATERIAL_FILE_LIMIT`).
pub const MAX_WRITE_BYTES: usize = 64 * 1024 * 1024;
/// Largest file copied into the store (0.1: `LOCAL_ASSET_FILE_LIMIT`).
pub const MAX_COPY_BYTES: u64 = 512 * 1024 * 1024;
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

    pub(crate) fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "source" => Self::Source,
            "display" => Self::Display,
            "thumbnail" => Self::Thumbnail,
            _ => return None,
        })
    }

    fn write_limit(self) -> usize {
        match self {
            Self::Source => MAX_WRITE_BYTES,
            Self::Display => MAX_DISPLAY_BYTES,
            Self::Thumbnail => MAX_THUMBNAIL_BYTES,
        }
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
    pub uploaded_ms: Option<i64>,
    pub path: PathBuf,
}

/// What to import as a source in one call ([`Library::import_asset`]).
#[derive(Clone, Debug)]
pub struct SourceImport<'a> {
    pub book_id: &'a str,
    pub asset_id: &'a str,
    pub source: &'a Path,
    pub mime: &'a str,
    pub ext: &'a str,
    /// Pixel size of an image (None for a PDF).
    pub dimensions: Option<(u32, u32)>,
    /// Refuse files larger than this (at most [`MAX_COPY_BYTES`]).
    pub limit: u64,
}

/// An encoded variant.
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
    pub removed_orphans: u64,
    pub cleared_committed_markers: u64,
}

/// The 0.1 client's mapping from an id to one path segment.
pub fn sanitized_segment(value: &str) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_SEGMENT {
        return Err(StoreError::invalid("asset store identifier", value));
    }
    let mut safe: String = trimmed
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if safe == "."
        || safe == ".."
        || !matches!(
            Path::new(&safe).components().collect::<Vec<_>>()[..],
            [Component::Normal(_)]
        )
    {
        return Err(StoreError::invalid("asset store identifier", value));
    }
    if safe.starts_with('.') {
        safe.insert(0, '_');
    }
    Ok(safe)
}

/// The 0.1 client's extension rule: trimmed, no leading dots, lower case,
/// ASCII letters and digits, at most 16.
pub fn sanitized_extension(value: &str) -> Result<String> {
    let e = value.trim().trim_start_matches('.').to_ascii_lowercase();
    if e.is_empty() || e.len() > MAX_EXTENSION_LEN || !e.chars().all(|c| c.is_ascii_alphanumeric())
    {
        return Err(StoreError::invalid("asset store extension", value));
    }
    Ok(e)
}

/// `<root>/<book>/<asset>/<variant>.<ext>`.
pub fn variant_path(
    root: &Path,
    book_id: &str,
    asset_id: &str,
    variant: Variant,
    ext: &str,
) -> Result<PathBuf> {
    Ok(root
        .join(sanitized_segment(book_id)?)
        .join(sanitized_segment(asset_id)?)
        .join(format!(
            "{}.{}",
            variant.as_str(),
            sanitized_extension(ext)?
        )))
}

pub(crate) fn reject_symlinks(
    root: &Path,
    book: &str,
    asset: &str,
    file: Option<&Path>,
) -> io::Result<()> {
    for candidate in [
        root.to_path_buf(),
        root.join(book),
        root.join(book).join(asset),
    ] {
        match fs::symlink_metadata(&candidate) {
            Ok(m) if m.file_type().is_symlink() => {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "refusing to access a symlinked asset store path",
                ));
            }
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => break,
            Err(e) => return Err(e),
        }
    }
    if let Some(file) = file {
        match fs::symlink_metadata(file) {
            Ok(m) if m.file_type().is_symlink() => {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "refusing to access a symlinked asset store file",
                ));
            }
            Ok(_) | Err(_) => {}
        }
    }
    Ok(())
}

fn marker(dir: &Path) -> PathBuf {
    dir.join(IMPORT_MARKER)
}

fn clear_marker(dir: &Path) -> io::Result<bool> {
    let m = marker(dir);
    match fs::symlink_metadata(&m) {
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_file() => Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "refusing to remove an invalid asset import marker",
        )),
        Ok(_) => {
            fs::remove_file(m)?;
            sync_directory(dir)?;
            Ok(true)
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

/// Check that `asset_dir` is `<root>/<book>/<asset>` with real directories;
/// returns the book directory.
fn validate_managed(root: &Path, asset_dir: &Path) -> io::Result<PathBuf> {
    let relative = asset_dir.strip_prefix(root).map_err(|_| {
        io::Error::new(
            io::ErrorKind::PermissionDenied,
            "asset directory is outside the managed root",
        )
    })?;
    let mut parts = relative.components();
    let book = match parts.next() {
        Some(Component::Normal(v)) => v,
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "asset directory has an invalid book path",
            ));
        }
    };
    if !matches!(parts.next(), Some(Component::Normal(_))) || parts.next().is_some() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "asset directory has an invalid managed path",
        ));
    }
    match fs::symlink_metadata(root) {
        Ok(m) if m.file_type().is_symlink() || !m.is_dir() => {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "asset root is not a real directory",
            ));
        }
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(root.join(book)),
        Err(e) => return Err(e),
    }
    let book_dir = root.join(book);
    for p in [&book_dir, &asset_dir.to_path_buf()] {
        match fs::symlink_metadata(p) {
            Ok(m) if m.file_type().is_symlink() || !m.is_dir() => {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "managed asset path is not a real directory",
                ));
            }
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    Ok(book_dir)
}

/// Unix deletion with an injectable directory barrier (tests).
#[cfg(unix)]
pub(crate) fn durable_delete_with_sync<S>(
    root: &Path,
    asset_dir: &Path,
    mut sync: S,
) -> io::Result<()>
where
    S: FnMut(&Path) -> io::Result<()>,
{
    let book_dir = validate_managed(root, asset_dir)?;
    if !root.exists() {
        return Ok(());
    }
    if !book_dir.exists() {
        // A retry after a barrier failure must be able to finish the previous
        // book-directory removal even though the logical target is gone.
        return sync(root);
    }
    match fs::symlink_metadata(asset_dir) {
        Ok(_) => fs::remove_dir_all(asset_dir)?,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    sync(&book_dir)?;
    match fs::remove_dir(&book_dir) {
        Ok(()) => sync(root),
        Err(e) if e.kind() == io::ErrorKind::NotFound => sync(root),
        Err(e) if e.kind() == io::ErrorKind::DirectoryNotEmpty => Ok(()),
        Err(e) => Err(e),
    }
}

#[cfg(unix)]
fn durable_delete(root: &Path, asset_dir: &Path) -> io::Result<()> {
    durable_delete_with_sync(root, asset_dir, sync_directory)
}

#[cfg(windows)]
fn remove_real_directory_if_present(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_symlink() || !m.is_dir() => Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "refusing to remove a non-directory asset tombstone",
        )),
        Ok(_) => fs::remove_dir_all(path),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

#[cfg(windows)]
fn tombstone(parent: &Path, dir: &Path) -> io::Result<PathBuf> {
    let name = dir.file_name().and_then(|v| v.to_str()).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "asset directory has no valid name",
        )
    })?;
    Ok(parent.join(format!(".{name}.deleting")))
}

#[cfg(windows)]
fn durable_delete(root: &Path, asset_dir: &Path) -> io::Result<()> {
    use crate::file_io::windows_move_write_through;
    let book_dir = validate_managed(root, asset_dir)?;
    if !root.exists() {
        return Ok(());
    }
    let book_tombstone = tombstone(root, &book_dir)?;
    if !book_dir.exists() {
        // A write-through rename from an interrupted attempt already made the
        // book directory logically absent; removing the tombstone is retryable.
        return remove_real_directory_if_present(&book_tombstone);
    }
    let asset_tombstone = tombstone(&book_dir, asset_dir)?;
    remove_real_directory_if_present(&asset_tombstone)?;
    if asset_dir.exists() {
        // Directory FlushFileBuffers is not a documented Windows contract:
        // persist the deletion by a write-through rename to a tombstone first.
        windows_move_write_through(asset_dir, &asset_tombstone, false)?;
    }
    remove_real_directory_if_present(&asset_tombstone)?;
    if fs::read_dir(&book_dir)?.next().transpose()?.is_some() {
        return Ok(());
    }
    remove_real_directory_if_present(&book_tombstone)?;
    windows_move_write_through(&book_dir, &book_tombstone, false)?;
    remove_real_directory_if_present(&book_tombstone)
}

/// Collect abandoned imports under `root` (see the module docs).
pub(crate) fn collect_imports(
    root: &Path,
    retained: &HashSet<(String, String)>,
    session: &str,
) -> io::Result<AssetGarbage> {
    let mut result = AssetGarbage::default();
    if !root.exists() {
        return Ok(result);
    }
    let meta = fs::symlink_metadata(root)?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "asset store root is not a real directory",
        ));
    }
    let canonical = |name: &str| sanitized_segment(name).map(|s| s == name).unwrap_or(false);
    for book in fs::read_dir(root)?.collect::<std::result::Result<Vec<_>, _>>()? {
        let kind = book.file_type()?;
        if kind.is_symlink() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "refusing to inspect a symlinked asset book directory",
            ));
        }
        if !kind.is_dir() {
            continue;
        }
        let book_name = book.file_name().into_string().map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidData, "asset book name is not UTF-8")
        })?;
        if !canonical(&book_name) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "asset book directory is not canonical",
            ));
        }
        for asset in fs::read_dir(book.path())?.collect::<std::result::Result<Vec<_>, _>>()? {
            let kind = asset.file_type()?;
            if kind.is_symlink() {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "refusing to inspect a symlinked asset directory",
                ));
            }
            if !kind.is_dir() {
                continue;
            }
            let asset_name = asset.file_name().into_string().map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidData, "asset name is not UTF-8")
            })?;
            if !canonical(&asset_name) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "asset directory is not canonical",
                ));
            }
            let dir = asset.path();
            let m = marker(&dir);
            let marker_meta = match fs::symlink_metadata(&m) {
                Ok(meta) if meta.file_type().is_symlink() || !meta.is_file() => {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "asset import marker is invalid",
                    ));
                }
                Ok(meta) => meta,
                Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e),
            };
            if marker_meta.len() > MAX_MARKER_BYTES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "asset import marker is too large",
                ));
            }
            let owner = fs::read_to_string(&m)?;
            if retained.contains(&(book_name.clone(), asset_name.clone())) {
                if clear_marker(&dir)? {
                    result.cleared_committed_markers += 1;
                }
            } else if owner.trim() != session {
                durable_delete(root, &dir)?;
                result.removed_orphans += 1;
            }
        }
    }
    Ok(result)
}

/// An import in progress: the marker is written, variants are added, and
/// [`AssetImport::commit`] stores the rows and clears the marker. Dropping it
/// uncommitted leaves the directory for garbage collection (another process's
/// collection, or this one's after a restart).
pub struct AssetImport<'a> {
    lib: &'a Library,
    book_id: String,
    asset_id: String,
    dir: PathBuf,
    records: Vec<AssetRecord>,
}

impl AssetImport<'_> {
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    #[allow(clippy::too_many_arguments)]
    fn record(
        &mut self,
        variant: Variant,
        mime: &str,
        ext: String,
        size: u64,
        sha256: String,
        dims: Option<(u32, u32)>,
        path: PathBuf,
    ) -> AssetRecord {
        let record = AssetRecord {
            asset_id: self.asset_id.clone(),
            variant,
            book_id: self.book_id.clone(),
            mime: mime.into(),
            ext,
            size,
            sha256,
            width: dims.map(|d| d.0),
            height: dims.map(|d| d.1),
            created_ms: now_ms(),
            uploaded_ms: None,
            path,
        };
        self.records.retain(|r| r.variant != variant);
        self.records.push(record.clone());
        record
    }

    /// Copy a file in as a variant, refusing more than `limit` bytes.
    pub fn copy_variant(
        &mut self,
        variant: Variant,
        source: &Path,
        mime: &str,
        ext: &str,
        dimensions: Option<(u32, u32)>,
        limit: u64,
    ) -> Result<AssetRecord> {
        check_dimensions(dimensions)?;
        let ext = sanitized_extension(ext)?;
        let path = variant_path(
            &self.lib.paths().assets,
            &self.book_id,
            &self.asset_id,
            variant,
            &ext,
        )?;
        let copied = atomic_copy_capped(source, &path, limit.min(MAX_COPY_BYTES)).map_err(|e| {
            match e.kind() {
                io::ErrorKind::InvalidData => {
                    StoreError::Asset(format!("file exceeds the {limit} byte limit"))
                }
                io::ErrorKind::InvalidInput => StoreError::Asset("not a file".into()),
                _ => e.into(),
            }
        })?;
        let (sha256, size) = file_sha256(&path)?;
        debug_assert_eq!(size, copied);
        Ok(self.record(variant, mime, ext, size, sha256, dimensions, path))
    }

    /// Write bytes as a variant.
    pub fn write_variant(&mut self, variant: Variant, v: &VariantBytes) -> Result<AssetRecord> {
        let (ext, path) = write_variant_file(self.lib, &self.book_id, &self.asset_id, variant, v)?;
        let sha = sha256_hex(&v.bytes);
        Ok(self.record(
            variant,
            &v.mime,
            ext,
            v.bytes.len() as u64,
            sha,
            Some((v.width, v.height)),
            path,
        ))
    }

    /// Store the rows of every variant written, then clear the marker.
    pub fn commit(self) -> Result<Vec<AssetRecord>> {
        if !self.records.iter().any(|r| r.variant == Variant::Source) {
            return Err(StoreError::Asset(
                "an import needs its source variant".into(),
            ));
        }
        {
            let conn = self.lib.writer();
            let tx = conn.unchecked_transaction()?;
            for r in &self.records {
                insert_row(&tx, r, r.variant != Variant::Source)?;
            }
            tx.commit()?;
        }
        clear_marker(&self.dir)?;
        self.lib.notify_local(LocalChange::new(
            "asset",
            &self.asset_id,
            LocalChangeKind::Insert,
        ));
        Ok(self.records)
    }

    /// Give up: delete the directory now.
    pub fn abandon(self) -> Result<()> {
        durable_delete(&self.lib.paths().assets, &self.dir)?;
        Ok(())
    }
}

fn check_dimensions(dims: Option<(u32, u32)>) -> Result<()> {
    if let Some((w, h)) = dims
        && (w == 0 || h == 0)
    {
        return Err(StoreError::invalid("asset dimensions", format!("{w}x{h}")));
    }
    Ok(())
}

fn write_variant_file(
    lib: &Library,
    book_id: &str,
    asset_id: &str,
    variant: Variant,
    v: &VariantBytes,
) -> Result<(String, PathBuf)> {
    let limit = variant.write_limit();
    if v.bytes.is_empty() || v.bytes.len() > limit {
        return Err(StoreError::Asset(format!(
            "{} must be 1..={limit} bytes",
            variant.as_str()
        )));
    }
    check_dimensions(Some((v.width, v.height)))?;
    let ext = sanitized_extension(&v.ext)?;
    let path = variant_path(&lib.paths().assets, book_id, asset_id, variant, &ext)?;
    reject_symlinks(
        &lib.paths().assets,
        &sanitized_segment(book_id)?,
        &sanitized_segment(asset_id)?,
        Some(&path),
    )?;
    atomic_write(&path, &v.bytes)?;
    Ok((ext, path))
}

fn insert_row(conn: &rusqlite::Connection, r: &AssetRecord, replace: bool) -> Result<()> {
    let verb = if replace {
        "INSERT OR REPLACE"
    } else {
        "INSERT"
    };
    conn.prepare_cached(&format!(
        "{verb} INTO asset (asset_id, variant, book_id, mime, ext, size, sha256, width, height, created_ms, uploaded_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)"
    ))?
    .execute(params![
        r.asset_id,
        r.variant.as_str(),
        r.book_id,
        r.mime,
        r.ext,
        r.size as i64,
        r.sha256,
        r.width,
        r.height,
        r.created_ms,
        r.uploaded_ms
    ])?;
    Ok(())
}

impl Library {
    /// Start importing an asset: create its directory and the import marker.
    /// The asset must be new (sources are immutable).
    pub fn begin_asset_import(&self, book_id: &str, asset_id: &str) -> Result<AssetImport<'_>> {
        let root = &self.paths().assets;
        let book = sanitized_segment(book_id)?;
        let asset = sanitized_segment(asset_id)?;
        reject_symlinks(root, &book, &asset, None)?;
        let dir = root.join(&book).join(&asset);
        if dir.exists() || self.asset(asset_id, Variant::Source)?.is_some() {
            return Err(StoreError::Asset(format!(
                "asset {asset_id} already exists"
            )));
        }
        fs::create_dir_all(&dir)?;
        atomic_write(&marker(&dir), self.inner.session.as_bytes())?;
        Ok(AssetImport {
            lib: self,
            book_id: book_id.into(),
            asset_id: asset_id.into(),
            dir,
            records: Vec::new(),
        })
    }

    /// Import a source file in one go (begin, copy, commit). A failed import
    /// leaves nothing behind.
    pub fn import_asset(&self, import: &SourceImport<'_>) -> Result<AssetRecord> {
        let mut pending = self.begin_asset_import(import.book_id, import.asset_id)?;
        let copied = pending.copy_variant(
            Variant::Source,
            import.source,
            import.mime,
            import.ext,
            import.dimensions,
            import.limit,
        );
        if let Err(e) = copied {
            let _ = pending.abandon();
            return Err(e);
        }
        let dir = pending.dir.clone();
        match pending.commit() {
            Ok(mut records) => Ok(records.remove(0)),
            Err(e) => {
                let _ = durable_delete(&self.paths().assets, &dir);
                Err(e)
            }
        }
    }

    /// Store (or replace) a display or thumbnail variant of an imported asset.
    pub fn put_variant(
        &self,
        asset_id: &str,
        variant: Variant,
        v: &VariantBytes,
    ) -> Result<AssetRecord> {
        if variant == Variant::Source {
            return Err(StoreError::Asset("the source variant is immutable".into()));
        }
        let source = self
            .asset(asset_id, Variant::Source)?
            .ok_or_else(|| StoreError::NotFound(format!("asset {asset_id}")))?;
        let (ext, path) = write_variant_file(self, &source.book_id, asset_id, variant, v)?;
        let record = AssetRecord {
            asset_id: asset_id.into(),
            variant,
            book_id: source.book_id,
            mime: v.mime.clone(),
            ext,
            size: v.bytes.len() as u64,
            sha256: sha256_hex(&v.bytes),
            width: Some(v.width),
            height: Some(v.height),
            created_ms: now_ms(),
            uploaded_ms: None,
            path,
        };
        insert_row(&self.writer(), &record, true)?;
        self.notify_local(LocalChange::new("asset", asset_id, LocalChangeKind::Update));
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
            "SELECT asset_id, variant, book_id, mime, ext, size, sha256, width, height, created_ms, uploaded_ms
             FROM asset WHERE {clause} ORDER BY book_id, asset_id, variant"
        );
        type Row = (
            String,
            String,
            String,
            String,
            String,
            i64,
            String,
            Option<u32>,
            Option<u32>,
            i64,
            Option<i64>,
        );
        let rows = conn
            .prepare_cached(&sql)?
            .query_map(args, |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                    r.get(8)?,
                    r.get(9)?,
                    r.get(10)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<Row>>>()?;
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
                    uploaded_ms,
                )| {
                    let variant = Variant::parse(&variant)
                        .ok_or_else(|| StoreError::invalid("asset variant", variant))?;
                    let path =
                        variant_path(&self.paths().assets, &book_id, &asset_id, variant, &ext)?;
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
                        uploaded_ms,
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

    /// Variants the sync service has not confirmed yet.
    pub fn assets_pending_upload(&self) -> Result<Vec<AssetRecord>> {
        self.asset_rows("uploaded_ms IS NULL", &[])
    }

    /// Record that the sync service holds a variant's bytes.
    pub fn mark_asset_uploaded(&self, asset_id: &str, variant: Variant) -> Result<bool> {
        let n = self.writer().execute(
            "UPDATE asset SET uploaded_ms = ?3 WHERE asset_id = ?1 AND variant = ?2",
            params![asset_id, variant.as_str(), now_ms()],
        )?;
        if n > 0 {
            self.notify_local(LocalChange::new("asset", asset_id, LocalChangeKind::Update));
        }
        Ok(n > 0)
    }

    /// Remove an asset: rows first, then its directory, durably.
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
        let root = &self.paths().assets;
        let dir = root
            .join(sanitized_segment(&book)?)
            .join(sanitized_segment(asset_id)?);
        durable_delete(root, &dir)?;
        self.notify_local(LocalChange::new("asset", asset_id, LocalChangeKind::Delete));
        Ok(true)
    }

    /// Collect abandoned imports: clear markers of directories with rows,
    /// delete marked directories without rows that another process left.
    pub fn collect_asset_garbage(&self) -> Result<AssetGarbage> {
        let retained: HashSet<(String, String)> = {
            let conn = self.reader();
            let pairs: Vec<(String, String)> = conn
                .prepare("SELECT DISTINCT book_id, asset_id FROM asset")?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?;
            pairs
                .into_iter()
                .filter_map(|(b, a)| {
                    Some((sanitized_segment(&b).ok()?, sanitized_segment(&a).ok()?))
                })
                .collect()
        };
        Ok(collect_imports(
            &self.paths().assets,
            &retained,
            &self.inner.session,
        )?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segments_and_extensions_cannot_escape_the_store_root() {
        assert_eq!(
            sanitized_segment("project/../../asset").unwrap(),
            "project_.._.._asset"
        );
        assert_eq!(sanitized_segment(".hidden").unwrap(), "_.hidden");
        assert!(sanitized_segment("..").is_err());
        assert!(sanitized_segment("  ").is_err());
        assert_eq!(sanitized_extension(".JpG").unwrap(), "jpg");
        assert!(sanitized_extension("../jpg").is_err());
        assert!(sanitized_extension("svg+xml").is_err());
        let root = Path::new("/tmp/asset-store-root");
        let path = variant_path(
            root,
            "project/../../asset",
            "asset/../../../id",
            Variant::Thumbnail,
            "jpg",
        )
        .unwrap();
        assert!(path.starts_with(root));
        assert_eq!(path.file_name().unwrap(), "thumbnail.jpg");
    }

    #[test]
    fn paths_are_stable_and_variant_specific() {
        let root = Path::new("/tmp/asset-store-root");
        let source = variant_path(root, "project-a", "asset-a", Variant::Source, "PNG").unwrap();
        let display = variant_path(root, "project-a", "asset-a", Variant::Display, "png").unwrap();
        assert_eq!(source, root.join("project-a/asset-a/source.png"));
        assert_eq!(display, root.join("project-a/asset-a/display.png"));
    }

    #[test]
    fn restart_gc_preserves_commits_active_imports_and_unmarked_directories() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("assets");
        let committed = root.join("book-a/asset-committed");
        let orphan = root.join("book-a/asset-orphan");
        let active = root.join("book-a/asset-active");
        let unmarked = root.join("book-a/asset-unmarked");
        for a in [&committed, &orphan, &active, &unmarked] {
            fs::create_dir_all(a).unwrap();
            fs::write(a.join("source.bin"), b"bytes").unwrap();
        }
        fs::write(marker(&committed), b"previous-session").unwrap();
        fs::write(marker(&orphan), b"previous-session").unwrap();
        fs::write(marker(&active), b"current-session").unwrap();
        let retained = HashSet::from([("book-a".to_string(), "asset-committed".to_string())]);
        let r = collect_imports(&root, &retained, "current-session").unwrap();
        assert_eq!(r.removed_orphans, 1);
        assert_eq!(r.cleared_committed_markers, 1);
        assert!(committed.join("source.bin").exists());
        assert!(!marker(&committed).exists());
        assert!(!orphan.exists());
        assert!(active.join("source.bin").exists());
        assert!(marker(&active).exists());
        assert!(unmarked.join("source.bin").exists());
    }

    #[test]
    fn gc_refuses_non_canonical_names_and_oversized_markers() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("assets");
        fs::create_dir_all(root.join("book-a/has space")).unwrap();
        assert!(collect_imports(&root, &HashSet::new(), "s").is_err());
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("assets");
        fs::create_dir_all(root.join("book-a/asset")).unwrap();
        fs::write(marker(&root.join("book-a/asset")), vec![b'x'; 300]).unwrap();
        assert!(collect_imports(&root, &HashSet::new(), "s").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_book_directories_are_refused() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("assets");
        let outside = dir.path().join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, root.join("book-a")).unwrap();
        assert!(reject_symlinks(&root, "book-a", "asset-a", None).is_err());
        assert!(outside.exists());
    }

    #[cfg(unix)]
    #[test]
    fn delete_syncs_book_then_root_and_removes_empty_directories() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("assets");
        let book = root.join("book-a");
        let asset = book.join("asset-a");
        fs::create_dir_all(&asset).unwrap();
        fs::write(asset.join("source.bin"), b"asset").unwrap();
        let mut barriers = Vec::new();
        durable_delete_with_sync(&root, &asset, |p| {
            barriers.push(p.to_path_buf());
            sync_directory(p)
        })
        .unwrap();
        assert_eq!(barriers, vec![book.clone(), root.clone()]);
        assert!(!asset.exists());
        assert!(!book.exists());
        assert!(root.is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn delete_fails_closed_when_the_book_barrier_fails() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("assets");
        let book = root.join("book-a");
        let asset = book.join("asset-a");
        fs::create_dir_all(&asset).unwrap();
        fs::write(asset.join("source.bin"), b"asset").unwrap();
        let error = durable_delete_with_sync(&root, &asset, |p| {
            assert_eq!(p, book);
            Err(io::Error::other("injected delete barrier failure"))
        })
        .unwrap_err();
        assert_eq!(error.to_string(), "injected delete barrier failure");
        assert!(!asset.exists());
        assert!(book.is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn delete_rejects_paths_outside_the_managed_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("assets");
        let outside = dir.path().join("outside/asset-a");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("keep.bin"), b"keep").unwrap();
        let error = durable_delete_with_sync(&root, &outside, |_| Ok(())).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(fs::read(outside.join("keep.bin")).unwrap(), b"keep");
    }
}
