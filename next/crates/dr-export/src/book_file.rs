//! One book in one file: `.driftingbook`, versions 2 (legacy) and 3 (v3 books). The 0.1 client
//! wrote version 1; docs/book-transfer.md).
//!
//! ```text
//! manifest.json                          format, version, title, checksums
//! docs/<n>.loro                          each document's Loro snapshot
//! assets/<asset>/<variant>.<ext>         every stored variant, as stored
//! ```
//!
//! The 0.1 rules, on Loro:
//!
//! - **The whole book travels**: the book document (chapters, ideas,
//!   storylines, elements, categories, relations, comments, materials,
//!   Plot Grids, acts, time pins, facts, Project Memory, writing days, and
//!   what is in the book's trash) and every prose document of it, with
//!   their history; images and PDFs with every stored variant. Device-local
//!   state (recently opened, layout), history labels and the derived index
//!   stay behind; the index is rebuilt.
//! - **An import always adds a new book** and never touches another one,
//!   even the book it came from: every id is new. Inside each document's
//!   changes (Loro's JSON form), the book's ids, those that name a document,
//!   and the ids derived from them (`rt-generic:<book>`, a generated TODO's
//!   `todo:…:<document>#<block>`, location links) are rewritten, and the
//!   deterministic first change of each document is moved onto the new
//!   document's genesis peer, so it is exactly what this build writes for
//!   the new id. The text of the prose is never touched. Comment anchors and
//!   block ids keep working: the changes keep their ids.
//! - **Nothing half-imported is left**: prose documents are written first
//!   and the book document last (the book appears with it); on any failure
//!   whatever was written is removed again.
//! - Version 1 files (a CBOR map holding a 0.1 sync package with Yjs state)
//!   cannot be read here: import them into Drifting 0.1, then hand the
//!   library over (P0-E). A file is at most 1 GiB, as in 0.1.

use std::collections::{BTreeMap, HashMap};
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use dr_doc::peer::genesis_peer;
use dr_doc::schema::{self, GENESIS_VERSION};
use dr_model::id::{DocId, DocKind, new_uuid_v7};
use dr_store::asset::{Variant, VariantBytes};
use dr_workspace::Workspace;
use loro::json::{JsonChange, JsonOpContent, ListOp, MapOp, MovableListOp, TextOp, TreeOp};
use loro::{ContainerID, ExportMode, LoroDoc, LoroValue, VersionVector};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::files::readable_stem;

mod v3;

pub const FORMAT: &str = "drifting.book";
/// 4 from `kernel-v4.md`: the book's writing days and checkpoint manifests
/// travel in `stats:<book>` and `checkpoints:<book>`. Only this version is
/// read; 3 was written only by development builds before it.
pub const FORMAT_VERSION: u32 = 4;
pub const EXTENSION: &str = "driftingbook";
/// The largest book file read or written (the 0.1 limit).
pub const MAX_BYTES: u64 = 1024 * 1024 * 1024;

const MANIFEST: &str = "manifest.json";

/// Why a book file could not be written or read, by the 0.1 dialog's
/// reasons (`projectPicker.bookTransfer.*`).
#[derive(Debug, thiserror::Error)]
pub enum BookFileError {
    /// Not a Drifting book at all.
    #[error("the file is not a Drifting book")]
    NotABook,
    /// A 0.1 book (version 1): import it into Drifting 0.1 first.
    #[error("the book was exported by Drifting 0.1; open it there and hand the library over")]
    Legacy,
    /// Made by a newer Drifting.
    #[error("the book was exported by a newer Drifting")]
    Newer,
    /// Exported by an earlier development build of this client, in a format
    /// this build no longer reads (format 3 and before).
    #[error("the book was exported by an earlier build, in a format no longer read")]
    Older,
    #[error("the book is larger than a book file can hold")]
    TooLarge,
    /// Damaged: a checksum, a document or the manifest does not hold up.
    #[error("the book file is damaged: {0}")]
    Damaged(String),
    #[error(transparent)]
    Workspace(#[from] dr_workspace::WsError),
    #[error(transparent)]
    Store(#[from] dr_store::StoreError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("{import}; incomplete import cleanup failed: {cleanup}")]
    Rollback {
        import: Box<BookFileError>,
        cleanup: dr_store::StoreError,
    },
}

pub type Result<T, E = BookFileError> = std::result::Result<T, E>;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DocEntry {
    id: String,
    path: String,
    sha256: String,
    size_bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AssetEntry {
    asset: String,
    variant: String,
    mime: String,
    ext: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    height: Option<u32>,
    path: String,
    sha256: String,
    size_bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    format: String,
    format_version: u32,
    app_version: String,
    exported_at_ms: i64,
    title: String,
    book: String,
    documents: Vec<DocEntry>,
    assets: Vec<AssetEntry>,
}

/// Enough of a manifest to tell the version apart.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Header {
    format: String,
    format_version: u32,
}

/// What a book file holds (written or read).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BookFileSummary {
    /// The book's id in the library it was written from or read into.
    pub book: String,
    pub title: String,
    pub documents: usize,
    /// Asset variant files.
    pub assets: usize,
    pub bytes: u64,
}

/// How far an export or import is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Progress {
    pub done: usize,
    pub total: usize,
}

/// `<title>.driftingbook`, named as the book's Markdown folder is.
pub fn book_filename(title: &str) -> String {
    format!("{}.{EXTENSION}", readable_stem(title))
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// The book's title for the native save panel, on either supported schema.
pub fn book_title(ws: &Workspace, book: &str) -> Result<String> {
    v3::title(ws, book)
}

/// Writes book `book` of `ws` to `dest` (whole or not at all). `progress`
/// hears each document and asset file as it is written.
pub fn export_book(
    ws: &Workspace,
    book: &str,
    dest: &Path,
    progress: &dyn Fn(Progress),
) -> Result<BookFileSummary> {
    let before = Some(v3::State::read(ws.library(), book)?);
    let title = book_title(ws, book)?;
    let lib = ws.library();
    let book_doc = DocId::Book(book.parse().map_err(|_| BookFileError::NotABook)?).to_string();
    let mut docs: Vec<String> = lib
        .docs(Some(book), None)?
        .into_iter()
        .map(|d| d.doc_id)
        .filter(|d| d != &book_doc)
        .collect();
    docs.sort();
    // The book document last: an import writes it last too.
    docs.push(book_doc);
    let assets = lib.assets_of_book(book)?;
    let total = docs.len() + assets.len();

    let dir = match dest.parent() {
        Some(d) if !d.as_os_str().is_empty() => d.to_path_buf(),
        _ => PathBuf::from("."),
    };
    let name = dest
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| book_filename(&title));
    let temp = dir.join(format!(".{name}.{}.part", std::process::id()));
    let written = (|| -> Result<Manifest> {
        let mut zip = ZipWriter::new(File::create(&temp)?);
        let deflated = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .large_file(true);
        let stored = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Stored)
            .large_file(true);
        let mut size = 0u64;
        let mut documents = Vec::new();
        for (i, id) in docs.iter().enumerate() {
            // A document registered but never written has nothing to carry
            // (it is created again when first opened).
            let doc = match lib.load_copy(id) {
                Ok(doc) => doc,
                Err(dr_store::StoreError::NotFound(_)) => continue,
                Err(e) => return Err(e.into()),
            };
            let bytes = doc
                .export(ExportMode::Snapshot)
                .map_err(|e| BookFileError::Damaged(format!("{id}: {e}")))?;
            let path = format!("docs/{}.loro", documents.len());
            zip.start_file(&path, deflated)
                .map_err(|e| BookFileError::Damaged(e.to_string()))?;
            zip.write_all(&bytes)?;
            size += bytes.len() as u64;
            documents.push(DocEntry {
                id: id.clone(),
                path,
                sha256: sha256_hex(&bytes),
                size_bytes: bytes.len() as u64,
            });
            progress(Progress { done: i + 1, total });
        }
        let mut files = Vec::new();
        for (i, a) in assets.iter().enumerate() {
            let bytes = std::fs::read(&a.path)?;
            let path = format!("assets/{}/{}.{}", a.asset_id, a.variant.as_str(), a.ext);
            zip.start_file(&path, stored)
                .map_err(|e| BookFileError::Damaged(e.to_string()))?;
            zip.write_all(&bytes)?;
            size += bytes.len() as u64;
            if size > MAX_BYTES {
                return Err(BookFileError::TooLarge);
            }
            files.push(AssetEntry {
                asset: a.asset_id.clone(),
                variant: a.variant.as_str().to_owned(),
                mime: a.mime.clone(),
                ext: a.ext.clone(),
                width: a.width,
                height: a.height,
                path,
                sha256: sha256_hex(&bytes),
                size_bytes: bytes.len() as u64,
            });
            progress(Progress {
                done: docs.len() + i + 1,
                total,
            });
        }
        let manifest = Manifest {
            format: FORMAT.into(),
            format_version: FORMAT_VERSION,
            app_version: lib.options().app_version.clone(),
            exported_at_ms: now_ms(),
            title: title.clone(),
            book: book.to_owned(),
            documents,
            assets: files,
        };
        zip.start_file(MANIFEST, deflated)
            .map_err(|e| BookFileError::Damaged(e.to_string()))?;
        zip.write_all(&serde_json::to_vec_pretty(&manifest).expect("a manifest serializes"))?;
        let file = zip
            .finish()
            .map_err(|e| BookFileError::Damaged(e.to_string()))?;
        file.sync_all()?;
        if let Some(before) = &before
            && before != &v3::State::read(lib, book)?
        {
            return Err(
                dr_workspace::WsError::Conflict("book changed during export".into()).into(),
            );
        }
        Ok(manifest)
    })();
    let manifest = match written {
        Ok(m) => m,
        Err(e) => {
            let _ = std::fs::remove_file(&temp);
            return Err(e);
        }
    };
    if let Err(e) = std::fs::rename(&temp, dest) {
        let _ = std::fs::remove_file(&temp);
        return Err(e.into());
    }
    let bytes = std::fs::metadata(dest)?.len();
    Ok(BookFileSummary {
        book: book.to_owned(),
        title,
        documents: manifest.documents.len(),
        assets: manifest.assets.len(),
        bytes,
    })
}

/// A checked book file in memory.
struct Contents {
    manifest: Manifest,
    docs: Vec<(DocEntry, Vec<u8>)>,
    assets: Vec<(AssetEntry, Vec<u8>)>,
}

/// An asset variant by its stored name.
fn variant(name: &str) -> Option<Variant> {
    [Variant::Source, Variant::Display, Variant::Thumbnail]
        .into_iter()
        .find(|v| v.as_str() == name)
}

/// Whether `head` looks like a 0.1 book file (a CBOR map naming the
/// format).
fn is_legacy(head: &[u8]) -> bool {
    let map = head.first().is_some_and(|b| (0xa0..=0xbf).contains(b));
    map && head.windows(FORMAT.len()).any(|w| w == FORMAT.as_bytes())
}

fn read_file(path: &Path) -> Result<Contents> {
    let size = std::fs::metadata(path)?.len();
    if size > MAX_BYTES {
        return Err(BookFileError::TooLarge);
    }
    let mut head = vec![0u8; 512];
    let n = File::open(path)?.read(&mut head)?;
    head.truncate(n);
    let mut zip = match ZipArchive::new(File::open(path)?) {
        Ok(z) => z,
        Err(_) if is_legacy(&head) => return Err(BookFileError::Legacy),
        Err(_) => return Err(BookFileError::NotABook),
    };
    let mut entry = |name: &str, limit: u64| -> Result<Vec<u8>> {
        let mut f = zip
            .by_name(name)
            .map_err(|_| BookFileError::Damaged(format!("{name} is missing")))?;
        if f.size() > limit {
            return Err(BookFileError::TooLarge);
        }
        let mut out = Vec::with_capacity(f.size() as usize);
        // A failed read here is a damaged entry (its CRC or its deflate
        // stream), not the disk.
        f.read_to_end(&mut out)
            .map_err(|e| BookFileError::Damaged(format!("{name}: {e}")))?;
        Ok(out)
    };
    let raw = entry(MANIFEST, 64 * 1024 * 1024).map_err(|e| match e {
        BookFileError::Damaged(_) => BookFileError::NotABook,
        e => e,
    })?;
    let header: Header = serde_json::from_slice(&raw).map_err(|_| BookFileError::NotABook)?;
    if header.format != FORMAT {
        return Err(BookFileError::NotABook);
    }
    if header.format_version > FORMAT_VERSION {
        return Err(BookFileError::Newer);
    }
    // 3: written by development builds of this client before `kernel-v4.md`.
    if header.format_version == 3 {
        return Err(BookFileError::Older);
    }
    if header.format_version < FORMAT_VERSION {
        return Err(BookFileError::Legacy);
    }
    let manifest: Manifest = serde_json::from_slice(&raw)
        .map_err(|e| BookFileError::Damaged(format!("manifest: {e}")))?;
    let mut checked = |path: &str, sha: &str, size: u64| -> Result<Vec<u8>> {
        let bytes = entry(path, MAX_BYTES)?;
        if bytes.len() as u64 != size || sha256_hex(&bytes) != sha {
            return Err(BookFileError::Damaged(format!(
                "{path} does not match its checksum"
            )));
        }
        Ok(bytes)
    };
    let mut docs = Vec::new();
    for d in &manifest.documents {
        DocId::parse(&d.id).map_err(|e| BookFileError::Damaged(format!("{}: {e}", d.id)))?;
        docs.push((d.clone(), checked(&d.path, &d.sha256, d.size_bytes)?));
    }
    let mut assets = Vec::new();
    for a in &manifest.assets {
        if variant(&a.variant).is_none() {
            return Err(BookFileError::Damaged(format!(
                "{}: unknown variant",
                a.path
            )));
        }
        assets.push((a.clone(), checked(&a.path, &a.sha256, a.size_bytes)?));
    }
    let book_doc = DocId::Book(
        manifest
            .book
            .parse()
            .map_err(|_| BookFileError::Damaged("the book id".into()))?,
    )
    .to_string();
    if docs.last().is_none_or(|(d, _)| d.id != book_doc) {
        return Err(BookFileError::Damaged(
            "the book document is missing".into(),
        ));
    }
    Ok(Contents {
        manifest,
        docs,
        assets,
    })
}

/// Old ids to new ones, and old genesis peers to new ones.
#[derive(Default)]
struct Rewrite {
    ids: HashMap<String, String>,
    peers: HashMap<u64, u64>,
    checkpoints: HashMap<String, String>,
}

fn is_hex(b: u8) -> bool {
    b.is_ascii_hexdigit()
}

/// A uuid (any version, lower or upper hex) at the start of `s`.
fn uuid_at(s: &[u8]) -> bool {
    s.len() >= 36
        && s[..36].iter().enumerate().all(|(i, &b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => is_hex(b),
        })
}

impl Rewrite {
    /// A document's new id: its owner's id swapped (`node:<id>`,
    /// `template:category:<id>`…), whatever form the owner's id takes.
    fn doc_id(&self, id: &str) -> Option<String> {
        match DocId::parse(id).ok()? {
            DocId::Body(body) => {
                return Some(format!(
                    "body:{}/{}",
                    self.ids.get(body.entry().as_str())?,
                    body.module()
                ));
            }
            DocId::Template(t) if t.entry_module().is_some() => {
                let (book, template, module) = t.entry_module()?;
                return Some(format!(
                    "template:{}/{template}/{module}",
                    self.ids.get(book.as_str())?
                ));
            }
            _ => {}
        }

        let (prefix, owner) = id.rsplit_once(':')?;
        let new = self.ids.get(owner)?;
        Some(format!("{prefix}:{new}"))
    }

    /// `s` with every mapped id in it replaced (an id that is the whole
    /// string, or a uuid inside a longer one) and every `@<peer>` of a
    /// mapped genesis peer moved.
    fn string(&self, s: &str) -> Option<String> {
        if let Some(new) = self.ids.get(s) {
            return Some(new.clone());
        }
        let bytes = s.as_bytes();
        let mut out = String::new();
        let mut last = 0;
        let mut i = 0;
        while i < bytes.len() {
            if (i == 0 || !is_hex(bytes[i - 1]))
                && uuid_at(&bytes[i..])
                && bytes.get(i + 36).is_none_or(|b| !is_hex(*b))
                && let Some(new) = self.ids.get(&s[i..i + 36])
            {
                out.push_str(&s[last..i]);
                out.push_str(new);
                i += 36;
                last = i;
                continue;
            }
            if bytes[i] == b'@' {
                let start = i + 1;
                let mut end = start;
                while end < bytes.len() && bytes[end].is_ascii_digit() {
                    end += 1;
                }
                if end > start
                    && let Ok(peer) = s[start..end].parse::<u64>()
                    && let Some(new) = self.peers.get(&peer)
                {
                    out.push_str(&s[last..start]);
                    out.push_str(&new.to_string());
                    i = end;
                    last = end;
                    continue;
                }
            }
            i += 1;
        }
        if last == 0 {
            return None;
        }
        out.push_str(&s[last..]);
        Some(out)
    }

    fn peer(&self, p: u64) -> u64 {
        self.peers.get(&p).copied().unwrap_or(p)
    }

    fn id(&self, id: &mut loro::ID) {
        id.peer = self.peer(id.peer);
    }

    fn text(&self, s: &str) -> String {
        self.string(s).unwrap_or_else(|| s.to_owned())
    }

    /// Document `id`'s changes with the ids and the genesis peer moved, as a
    /// new document. How its contents are rewritten follows its kind.
    fn doc(&self, id: &str, bytes: &[u8]) -> Result<LoroDoc> {
        v3::rewrite_doc(self, id, bytes)
    }
}

/// The kind of mergeable child a map slot's marker activates
/// (`ensure_mergeable_*`): its checksum names the parent and the key, so a
/// rewritten one is computed again.
fn marker_kind(v: &LoroValue) -> Option<loro::ContainerType> {
    let LoroValue::Binary(b) = v else {
        return None;
    };
    let magic = loro_common::MERGEABLE_MARKER_MAGIC;
    (b.len() == magic.len() + 4 && b.starts_with(&magic))
        .then(|| loro::ContainerType::try_from_u8(b[magic.len()]).ok())
        .flatten()
}

/// The new id of each id the book's documents name.
fn rewrite_for(read: &Contents) -> Result<Rewrite> {
    let (_, bytes) = read.docs.last().expect("checked book document");
    let book = LoroDoc::new();
    book.import(bytes)
        .map_err(|e| BookFileError::Damaged(e.to_string()))?;
    if read.manifest.format_version != FORMAT_VERSION || !dr_doc::v3::is_book_doc(&book) {
        return Err(BookFileError::Damaged(
            "archive must contain a current-format book".into(),
        ));
    }
    v3::rewrite_for(read, &book)
}

/// What was written so far, removed again on failure.
#[derive(Default)]
struct Written {
    docs: Vec<String>,
    assets: Vec<String>,
}

impl Written {
    fn undo(&self, lib: &dr_store::Library) -> dr_store::Result<()> {
        let mut error = None;
        for id in self.docs.iter().rev() {
            if let Err(e) = lib.purge_doc(id).and_then(|()| lib.forget_purged(id)) {
                error.get_or_insert(e);
            }
        }
        for a in &self.assets {
            if let Err(e) = lib.remove_asset(a) {
                error.get_or_insert(e);
            }
        }
        error.map_or(Ok(()), Err)
    }
}

/// Imports the book in `path` into `ws` as a new book (never replacing
/// one). `progress` hears each document and asset file as it is stored.
pub fn import_book(
    ws: &Workspace,
    path: &Path,
    progress: &dyn Fn(Progress),
) -> Result<BookFileSummary> {
    let read = read_file(path)?;
    let rw = rewrite_for(&read)?;
    let lib = ws.library();
    let new_book = rw.ids[&read.manifest.book].clone();
    let total = read.docs.len() + read.assets.len();
    let mut written = Written::default();
    let result = (|| -> Result<()> {
        // Assets, then prose, then the book document.
        let mut by_asset: BTreeMap<&str, Vec<&(AssetEntry, Vec<u8>)>> = BTreeMap::new();
        for a in &read.assets {
            by_asset.entry(a.0.asset.as_str()).or_default().push(a);
        }
        let mut done = 0;
        for (old, variants) in by_asset {
            let new = &rw.ids[old];
            let mut import = lib.begin_asset_import(&new_book, new)?;
            // The source first: the others hang on it.
            let mut ordered = variants.clone();
            ordered.sort_by_key(|a| a.0.variant != "source");
            for (a, bytes) in ordered {
                let variant = variant(&a.variant).expect("checked");
                import.write_variant(
                    variant,
                    &VariantBytes {
                        bytes: bytes.clone(),
                        mime: a.mime.clone(),
                        ext: a.ext.clone(),
                        width: a.width.unwrap_or(0),
                        height: a.height.unwrap_or(0),
                    },
                )?;
                done += 1;
                progress(Progress { done, total });
            }
            import.commit()?;
            written.assets.push(new.clone());
        }
        for (d, bytes) in &read.docs {
            let new_id = rw.doc_id(&d.id).expect("mapped");
            let doc_id =
                DocId::parse(&new_id).map_err(|e| BookFileError::Damaged(e.to_string()))?;
            let doc = rw.doc(&d.id, bytes)?;
            let update = doc
                .export(ExportMode::all_updates())
                .map_err(|e| BookFileError::Damaged(e.to_string()))?;
            let genesis = match doc_id.kind() {
                DocKind::Book => dr_doc::v3::book_genesis(match &doc_id {
                    DocId::Book(b) => b,
                    _ => unreachable!(),
                }),
                DocKind::Conversation => dr_doc::conversation::genesis(match &doc_id {
                    DocId::Conversation(id) => id,
                    _ => unreachable!(),
                }),
                DocKind::Stats | DocKind::Checkpoints => {
                    dr_doc::side::genesis(&doc_id).expect("a document beside the book")
                }
                _ => dr_doc::prose::genesis(&doc_id),
            };
            let h = lib.open_doc(
                &new_id,
                dr_store::OpenDoc::CreateIfMissing {
                    kind: doc_id.kind().prefix(),
                    book_id: Some(&new_book),
                    genesis: &move |d: &LoroDoc| {
                        d.import(&genesis)
                            .expect("dr-doc's genesis imports into an empty document");
                    },
                },
            )?;
            written.docs.push(new_id.clone());
            // Ordinary handle drop only queues Close. Even on an import or
            // compaction error, wait for this holder to finish and release its
            // slot before rollback tries to purge its document.
            let imported = h
                .import(update, dr_store::Origin::Import)
                .and_then(|_| h.compact_now());
            h.close();
            imported?;
            // The stored document is exactly the rewritten one: its genesis
            // and this build's were one and the same change.
            let stored = lib.load_copy(&new_id)?;
            if stored.len_ops() != doc.len_ops() {
                return Err(BookFileError::Damaged(format!(
                    "{}: the first change did not line up",
                    d.id
                )));
            }
            done += 1;
            progress(Progress { done, total });
        }
        Ok(())
    })();
    if let Err(e) = result {
        if let Err(cleanup) = written.undo(lib) {
            return Err(BookFileError::Rollback {
                import: Box::new(e),
                cleanup,
            });
        }
        return Err(e);
    }
    let bytes = std::fs::metadata(path).map_or(0, |m| m.len());
    Ok(BookFileSummary {
        book: new_book,
        title: read.manifest.title.clone(),
        documents: read.docs.len(),
        assets: read.assets.len(),
        bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_legacy_file_is_told_apart() {
        let mut head = vec![0xa7];
        head.extend_from_slice(b"\x66format\x6ddrifting.book");
        assert!(is_legacy(&head));
        assert!(!is_legacy(b"PK\x03\x04"));
    }

    #[test]
    fn file_names_are_readable() {
        assert_eq!(book_filename("慢钟"), "慢钟.driftingbook");
    }
}
