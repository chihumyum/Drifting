//! One book in one file: `.driftingbook`, format version 2 (the 0.1 client
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
use dr_workspace::commands::BookIn;
use dr_workspace::commands::book::BookGet;
use dr_workspace::{Actor, Workspace};
use loro::json::{JsonChange, JsonOpContent, ListOp, MapOp, MovableListOp, TextOp, TreeOp};
use loro::{ContainerID, ExportMode, LoroDoc, LoroValue, VersionVector};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::files::readable_stem;

pub const FORMAT: &str = "drifting.book";
pub const FORMAT_VERSION: u32 = 2;
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

/// Writes book `book` of `ws` to `dest` (whole or not at all). `progress`
/// hears each document and asset file as it is written.
pub fn export_book(
    ws: &Workspace,
    book: &str,
    dest: &Path,
    progress: &dyn Fn(Progress),
) -> Result<BookFileSummary> {
    let title = ws
        .run::<BookGet>(
            &Actor::User,
            BookIn {
                book: book.to_owned(),
            },
        )?
        .output
        .info
        .name;
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

/// The book document's collections whose keys are ids (writing days and
/// the meta map are not).
const COLLECTIONS: &[&str] = &[
    schema::book::NODES,
    schema::book::ACTS,
    schema::book::STORYLINES,
    schema::book::CATEGORIES,
    schema::book::ELEMENTS,
    schema::book::PATCHES,
    schema::book::RELATION_TYPES,
    schema::book::RELATIONS,
    schema::book::TIME_PINS,
    schema::book::PLOT_GRIDS,
    schema::book::COMMENTS,
    schema::book::MATERIALS,
    schema::book::ASSETS,
    schema::book::DRIFT_GROUPS,
    schema::book::MATERIAL_FOLDERS,
    schema::book::FACTS,
    schema::book::MEMORY,
];

/// Old ids to new ones, and old genesis peers to new ones.
#[derive(Default)]
struct Rewrite {
    ids: HashMap<String, String>,
    peers: HashMap<u64, u64>,
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

    fn container(&self, c: &ContainerID) -> ContainerID {
        match c {
            ContainerID::Root {
                name,
                container_type,
            } => ContainerID::Root {
                name: self
                    .mergeable_name(name)
                    .unwrap_or_else(|| self.text(name))
                    .as_str()
                    .into(),
                container_type: *container_type,
            },
            ContainerID::Normal {
                peer,
                counter,
                container_type,
            } => ContainerID::Normal {
                peer: self.peer(*peer),
                counter: *counter,
                container_type: *container_type,
            },
        }
    }

    /// A mergeable child's root name (`🤝:$<parent>><key>…`, the keys
    /// escaped): each key mapped as a whole, so an id that is not a uuid is
    /// followed there too.
    fn mergeable_name(&self, name: &str) -> Option<String> {
        let rest = name.strip_prefix(loro_common::MERGEABLE_NAMESPACE_PREFIX)?;
        let mut segments = vec![String::new()];
        let mut chars = rest.chars();
        while let Some(c) = chars.next() {
            match c {
                '\\' => {
                    let last = segments.last_mut().expect("one segment");
                    last.push(c);
                    if let Some(n) = chars.next() {
                        last.push(n);
                    }
                }
                '>' => segments.push(String::new()),
                _ => segments.last_mut().expect("one segment").push(c),
            }
        }
        let mut out = String::from(loro_common::MERGEABLE_NAMESPACE_PREFIX);
        for (i, seg) in segments.iter().enumerate() {
            if i > 0 {
                out.push('>');
            }
            let (head, body) = match seg.strip_prefix('$') {
                Some(body) if i == 0 => ("$", body),
                // A normal parent (`@<peer>:<counter>`) stays.
                _ if i == 0 => {
                    out.push_str(seg);
                    continue;
                }
                _ => ("", seg.as_str()),
            };
            out.push_str(head);
            out.push_str(&escape(&self.text(&unescape(body))));
        }
        Some(out)
    }

    /// A value with its strings, map keys and container ids rewritten
    /// (binary values as they are).
    fn loro_value(&self, v: &LoroValue) -> LoroValue {
        match v {
            LoroValue::String(s) => match self.string(s) {
                Some(new) => LoroValue::from(new),
                None => v.clone(),
            },
            LoroValue::List(items) => LoroValue::List(
                items
                    .iter()
                    .map(|i| self.loro_value(i))
                    .collect::<Vec<_>>()
                    .into(),
            ),
            LoroValue::Map(map) => LoroValue::Map(
                map.iter()
                    .map(|(k, v)| (self.text(k), self.loro_value(v)))
                    .collect::<std::collections::HashMap<_, _>>()
                    .into(),
            ),
            LoroValue::Container(c) => LoroValue::Container(self.container(c)),
            _ => v.clone(),
        }
    }

    /// One change, rewritten in place: its ids, every container, key and
    /// value; the text a text insert carries (the prose itself) and binary
    /// values stay, except mergeable markers, which follow their key.
    fn change(&self, change: &mut JsonChange, conversation: bool) -> Result<()> {
        self.id(&mut change.id);
        change.deps.iter_mut().for_each(|d| self.id(d));
        for op in &mut change.ops {
            // Conversation roots are schema names, even if a legacy id
            // happens to be "entries" or "meta".
            let conversation_root = conversation
                && matches!(&op.container,
                ContainerID::Root { name, .. } if name.as_str() == schema::conversation::ENTRIES || name.as_str() == schema::conversation::META);
            if !conversation_root {
                op.container = self.container(&op.container);
            }
            match &mut op.content {
                JsonOpContent::Map(MapOp::Insert { key, value }) => {
                    if conversation
                        && key == schema::meta::DOC
                        && matches!(&op.container, ContainerID::Root { name, .. } if name.as_str() == schema::conversation::META)
                        && let LoroValue::String(old) = value
                    {
                        *value = self
                            .doc_id(old)
                            .ok_or_else(|| {
                                BookFileError::Damaged("conversation has no new id".into())
                            })?
                            .into();
                        continue;
                    }
                    if !conversation_root {
                        *key = self.text(key);
                    }
                    *value = match marker_kind(value) {
                        Some(kind) => loro_common::mergeable_marker(&op.container, key, kind),
                        None => self.loro_value(value),
                    };
                }
                JsonOpContent::Map(MapOp::Delete { key }) => *key = self.text(key),
                JsonOpContent::List(ListOp::Insert { value, .. })
                | JsonOpContent::MovableList(MovableListOp::Insert { value, .. }) => {
                    // Conversation entries are historical, immutable payloads:
                    // ids inside messages, signatures and tool arguments must
                    // remain exactly as recorded, not become new-book ids.
                    let transcript = conversation
                        && matches!(&op.container,
                        ContainerID::Root { name, .. } if name.as_str() == schema::conversation::ENTRIES);
                    if !transcript {
                        for v in value.iter_mut() {
                            *v = self.loro_value(v);
                        }
                    }
                }
                JsonOpContent::List(ListOp::Delete { start_id, .. })
                | JsonOpContent::MovableList(MovableListOp::Delete { start_id, .. })
                | JsonOpContent::Text(TextOp::Delete { start_id, .. }) => self.id(start_id),
                JsonOpContent::MovableList(MovableListOp::Move { elem_id, .. }) => {
                    elem_id.peer = self.peer(elem_id.peer);
                }
                JsonOpContent::MovableList(MovableListOp::Set { elem_id, value }) => {
                    elem_id.peer = self.peer(elem_id.peer);
                    *value = self.loro_value(value);
                }
                JsonOpContent::Text(TextOp::Mark {
                    style_key,
                    style_value,
                    ..
                }) => {
                    *style_key = self.text(style_key);
                    *style_value = self.loro_value(style_value);
                }
                JsonOpContent::Text(TextOp::Insert { .. } | TextOp::MarkEnd) => {}
                JsonOpContent::Tree(
                    TreeOp::Create { target, parent, .. } | TreeOp::Move { target, parent, .. },
                ) => {
                    target.peer = self.peer(target.peer);
                    if let Some(p) = parent {
                        p.peer = self.peer(p.peer);
                    }
                }
                JsonOpContent::Tree(TreeOp::Delete { target }) => {
                    target.peer = self.peer(target.peer);
                }
                JsonOpContent::Future(_) => {
                    return Err(BookFileError::Damaged(
                        "a change this version cannot read".into(),
                    ));
                }
            }
        }
        Ok(())
    }

    /// A document's changes with the ids and the genesis peer moved, as a
    /// new document.
    fn doc(&self, bytes: &[u8]) -> Result<LoroDoc> {
        let source = LoroDoc::new();
        source
            .import(bytes)
            .map_err(|e| BookFileError::Damaged(e.to_string()))?;
        let conversation = source.get_map(schema::conversation::META)
            .get(schema::meta::DOC)
            .is_some_and(|v| matches!(v, loro::ValueOrContainer::Value(LoroValue::String(id)) if id.starts_with("conversation:")));
        let mut json = source
            .export_json_updates_without_peer_compression(
                &VersionVector::default(),
                &source.oplog_vv(),
            )
            .map_err(|e| BookFileError::Damaged(e.to_string()))?;
        for change in &mut json.changes {
            self.change(change, conversation)?;
        }
        let out = LoroDoc::new();
        schema::configure(&out);
        out.import_json_updates(json)
            .map_err(|e| BookFileError::Damaged(e.to_string()))?;
        if out.len_ops() != source.len_ops() {
            return Err(BookFileError::Damaged("a document lost changes".into()));
        }
        Ok(out)
    }
}

/// Loro's escaping of a mergeable name's segment.
fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '>' => out.push_str("\\>"),
            '/' => out.push_str("\\s"),
            '\0' => out.push_str("\\0"),
            _ => out.push(c),
        }
    }
    out
}

fn unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('s') => out.push('/'),
            Some('0') => out.push('\0'),
            Some(other) => out.push(other),
            None => out.push(c),
        }
    }
    out
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

/// The peer that wrote `doc`'s first change, if it is a genesis peer of
/// `id`.
fn genesis_of(doc: &LoroDoc, id: &str) -> Option<u64> {
    let vv = doc.oplog_vv();
    (1..=GENESIS_VERSION)
        .rev()
        .map(|v| genesis_peer(id, v))
        .find(|p| vv.get(p).is_some())
}

/// The new id of each id the book's documents name.
fn rewrite_for(read: &Contents) -> Result<Rewrite> {
    let mut rw = Rewrite::default();
    let (_, book_bytes) = read.docs.last().expect("checked: the book document");
    let book = LoroDoc::new();
    book.import(book_bytes)
        .map_err(|e| BookFileError::Damaged(e.to_string()))?;
    let fresh = |old: &str, rw: &mut Rewrite| {
        if !old.contains(':') && !rw.ids.contains_key(old) {
            rw.ids.insert(old.to_owned(), new_uuid_v7());
        }
    };
    fresh(&read.manifest.book, &mut rw);
    for name in COLLECTIONS {
        for key in book.get_map(*name).keys() {
            fresh(&key, &mut rw);
        }
    }
    for (d, _) in &read.docs {
        if let Ok(id) = DocId::parse(&d.id) {
            fresh(id.entity_id(), &mut rw);
        }
    }
    for a in &read.assets {
        fresh(&a.0.asset, &mut rw);
    }
    // Each document's genesis peer moves to its new id's.
    for (d, bytes) in &read.docs {
        let doc = LoroDoc::new();
        doc.import(bytes)
            .map_err(|e| BookFileError::Damaged(e.to_string()))?;
        let new_id = rw
            .doc_id(&d.id)
            .ok_or_else(|| BookFileError::Damaged(format!("{}: no new id", d.id)))?;
        match genesis_of(&doc, &d.id) {
            Some(old) => {
                rw.peers.insert(old, genesis_peer(&new_id, GENESIS_VERSION));
            }
            None => {
                return Err(BookFileError::Damaged(format!(
                    "{}: not written by this version of Drifting",
                    d.id
                )));
            }
        }
    }
    Ok(rw)
}

/// What was written so far, removed again on failure.
#[derive(Default)]
struct Written {
    docs: Vec<String>,
    assets: Vec<String>,
}

impl Written {
    fn undo(&self, lib: &dr_store::Library) {
        for id in self.docs.iter().rev() {
            if lib.purge_doc(id).is_ok() {
                let _ = lib.forget_purged(id);
            }
        }
        for a in &self.assets {
            let _ = lib.remove_asset(a);
        }
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
            let doc = rw.doc(bytes)?;
            let update = doc
                .export(ExportMode::all_updates())
                .map_err(|e| BookFileError::Damaged(e.to_string()))?;
            let genesis = match doc_id.kind() {
                DocKind::Book => dr_doc::book::genesis(match &doc_id {
                    DocId::Book(b) => b,
                    _ => unreachable!(),
                }),
                DocKind::Conversation => dr_doc::conversation::genesis(match &doc_id {
                    DocId::Conversation(id) => id,
                    _ => unreachable!(),
                }),
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
            h.import(update, dr_store::Origin::Import)?;
            h.compact_now()?;
            h.close();
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
        written.undo(lib);
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
    fn ids_and_genesis_peers_are_rewritten_in_place() {
        let mut rw = Rewrite::default();
        let old = "0190f1e2-3a4b-7c5d-8e6f-0123456789ab";
        rw.ids.insert(old.into(), "NEW".into());
        rw.ids.insert("short".into(), "SHORT".into());
        rw.peers.insert(12345, 999);
        assert_eq!(rw.string(old).as_deref(), Some("NEW"));
        assert_eq!(rw.string("short").as_deref(), Some("SHORT"));
        assert_eq!(rw.string("a short one"), None, "short ids only as a whole");
        assert_eq!(
            rw.string(&format!("todo:todo-autoparse:node:{old}#0@12345"))
                .as_deref(),
            Some("todo:todo-autoparse:node:NEW#0@999")
        );
        assert_eq!(rw.string("3@123456"), None, "another peer stays");
        assert_eq!(
            rw.string("cid:7@12345:Map").as_deref(),
            Some("cid:7@999:Map")
        );
        let v = LoroValue::from(vec![LoroValue::from(old), LoroValue::from("plain")]);
        assert_eq!(
            rw.loro_value(&v),
            LoroValue::from(vec![LoroValue::from("NEW"), LoroValue::from("plain")])
        );
        assert_eq!(
            rw.mergeable_name("🤝:$facts>short").as_deref(),
            Some("🤝:$facts>SHORT")
        );
        assert_eq!(
            rw.mergeable_name(&format!("🤝:$nodes>{old}>a\\>b"))
                .as_deref(),
            Some("🤝:$nodes>NEW>a\\>b")
        );
        assert_eq!(rw.mergeable_name("meta"), None);
        let marker = LoroValue::Binary(vec![1, 2, 3].into());
        assert_eq!(rw.loro_value(&marker), marker, "binary values stay");
    }

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
