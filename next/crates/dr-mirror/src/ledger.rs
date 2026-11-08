//! The ledger: what this device last wrote to or read from each file, in
//! dr-store's `local_state` (scope [`SCOPE`]; never synced, each device has
//! its own folder). Rows name their book, so they go when the book is
//! purged.
//!
//! - `file/<doc>`: the file's path in its book's folder, the SHA-256 of the
//!   bytes Drifting wrote or read, the version those bytes stand for (the
//!   base of the next merge), the fields as they were, and the bytes
//!   refused (a file that could not be merged) if any.
//! - `book/<book>`: the folder the book is written to.

use dr_store::Library;
use loro::Frontiers;

use crate::disk::Stat;
use crate::file::Fields;
use crate::sync::Problem;

pub const SCOPE: &str = "mirror";

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct FileRow {
    pub book: String,
    /// The root the row is about; a row of another root is not used.
    pub root: String,
    /// In the book's folder, `/`-separated.
    pub path: String,
    pub sha: String,
    /// `Frontiers::encode`, hex.
    pub base: String,
    pub fields: Fields,
    /// The title the file was written with.
    #[serde(default)]
    pub title: String,
    /// The file's size and time when Drifting wrote or read it: unchanged,
    /// it is not read again.
    #[serde(default)]
    pub stat: Option<Stat>,
    /// Bytes that could not be merged: reported, then replaced (after being
    /// kept) by the next write, except a broken frontmatter, which waits
    /// for the author.
    #[serde(default)]
    pub refused: Option<Refused>,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Refused {
    pub sha: String,
    pub problem: Problem,
}

impl FileRow {
    pub fn base(&self) -> Option<Frontiers> {
        Frontiers::decode(&unhex(&self.base)?).ok()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct BookRow {
    pub root: String,
    /// The folder's name under the root.
    pub folder: String,
}

pub fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok())
        .collect()
}

pub fn encode(f: &Frontiers) -> String {
    hex(&f.encode())
}

fn file_key(doc: &str) -> String {
    format!("file/{doc}")
}

fn book_key(book: &str) -> String {
    format!("book/{book}")
}

/// The book's file rows, by doc.
pub fn files(lib: &Library, book: &str) -> dr_store::Result<Vec<(String, FileRow)>> {
    Ok(lib
        .local_entries(SCOPE, Some(book))?
        .into_iter()
        .filter_map(|e| {
            let doc = e.key.strip_prefix("file/")?.to_owned();
            let row: FileRow = serde_json::from_str(&e.value).ok()?;
            Some((doc, row))
        })
        .collect())
}

pub fn put_file(lib: &Library, doc: &str, row: &FileRow) -> dr_store::Result<()> {
    let value = serde_json::to_string(row).expect("serialises");
    lib.local_set(SCOPE, &file_key(doc), &value, Some(&row.book))
}

pub fn remove_file(lib: &Library, doc: &str) -> dr_store::Result<()> {
    lib.local_remove(SCOPE, &file_key(doc)).map(|_| ())
}

pub fn book(lib: &Library, book: &str) -> dr_store::Result<Option<BookRow>> {
    Ok(lib
        .local_get(SCOPE, &book_key(book))?
        .and_then(|v| serde_json::from_str(&v).ok()))
}

pub fn put_book(lib: &Library, book_id: &str, row: &BookRow) -> dr_store::Result<()> {
    let value = serde_json::to_string(row).expect("serialises");
    lib.local_set(SCOPE, &book_key(book_id), &value, Some(book_id))
}

/// Every book's folder under `root`, by book.
pub fn books(lib: &Library, root: &str) -> dr_store::Result<Vec<(String, BookRow)>> {
    Ok(lib
        .local_entries(SCOPE, None)?
        .into_iter()
        .filter_map(|e| {
            let id = e.key.strip_prefix("book/")?.to_owned();
            let row: BookRow = serde_json::from_str(&e.value).ok()?;
            (row.root == root).then_some((id, row))
        })
        .collect())
}
