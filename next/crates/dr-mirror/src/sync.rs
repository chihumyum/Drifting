//! One pass over a book's folder: files changed elsewhere are merged back,
//! then every chapter and idea is written where it belongs, and files
//! Drifting no longer keeps are put away.
//!
//! Reading first, writing second: a file is only replaced when its bytes
//! are the ones the ledger has (Drifting wrote or read them), so an edit
//! made in another editor is never written over; it is merged on the next
//! pass when it is still too fresh to read (saved less than
//! [`Pass::settle`] ago).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use dr_doc::book::BookReader;
use dr_doc::prose::ProseReader;
use dr_model::DocId;
use dr_model::id::BookId;
use dr_workspace::commands::BookIn;
use dr_workspace::commands::book::{BookGet, BookList, ListBooksIn};
use dr_workspace::{Actor, Workspace};
use serde_json::json;

use crate::body::{self, Para};
use crate::disk;
use crate::file::{self, Fields};
use crate::layout::{self, Entry, EntryKind};
use crate::ledger::{self, BookRow, FileRow, Refused};
use crate::merge::{self, Refusal};

/// Why a file was not merged.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Problem {
    /// The frontmatter is broken; nothing is merged or written until the
    /// author fixes it.
    Frontmatter,
    /// `drifting-id` names another chapter or idea.
    WrongId,
    /// The body was emptied.
    Emptied,
    /// The file's base is not in this document's history.
    UnknownBase,
    /// Not UTF-8 text.
    NotUtf8,
    /// Larger than [`disk::MAX_FILE_BYTES`]: kept, not read, written
    /// again.
    TooLarge,
    /// Another installation of Drifting keeps this book's folder.
    OwnedElsewhere,
}

impl Problem {
    /// What the notification says (0.1's strings; the folder's is new).
    pub fn message(self) -> dr_i18n::Key {
        use dr_i18n::keys::notifications::markdown_folder::issue as k;
        match self {
            Problem::Frontmatter => k::FRONTMATTER,
            Problem::WrongId => k::IDENTITY,
            Problem::Emptied => k::EMPTY,
            Problem::UnknownBase => k::LINEAGE,
            Problem::NotUtf8 => k::ENCODING,
            Problem::TooLarge => k::TOO_LARGE,
            Problem::OwnedElsewhere => k::OWNED,
        }
    }
}

/// A file Drifting could not merge (or a folder it may not use).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Issue {
    pub book: String,
    /// `node:<id>`; `None` for the folder.
    pub doc: Option<String>,
    pub title: String,
    pub path: PathBuf,
    pub problem: Problem,
}

/// What a pass did.
#[derive(Clone, Debug, Default)]
pub struct Report {
    /// Documents whose file was merged back (`node:<id>`).
    pub merged: Vec<String>,
    /// Files written.
    pub written: usize,
    /// Files kept under `.drifting/preserved` before being replaced or
    /// dropped.
    pub preserved: Vec<PathBuf>,
    pub issues: Vec<Issue>,
    /// A file was saved too recently to read: pass again soon.
    pub waiting: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    #[error("{0}")]
    Workspace(#[from] dr_workspace::WsError),
    #[error("{0}")]
    Store(#[from] dr_store::StoreError),
    #[error("{0}")]
    Merge(#[from] merge::MergeError),
    #[error("{0}")]
    Doc(#[from] dr_doc::DocError),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Invalid(String),
}

pub type Result<T> = std::result::Result<T, SyncError>;

/// Where and as whom a pass runs.
pub struct Pass<'a> {
    pub ws: &'a Workspace,
    pub root: &'a Path,
    /// This installation (the folder's owner).
    pub installation: &'a str,
    /// The application's bundle id, written beside it.
    pub app: &'a str,
    /// A file saved more recently than this is left for the next pass.
    pub settle: Duration,
    /// Read every file and render every document (the first pass, and when
    /// asked); otherwise a file whose size and time are as recorded is not
    /// read, and a document whose stored version, title, fields and file
    /// are as recorded is not rendered.
    pub thorough: bool,
}

impl Pass<'_> {
    fn root_key(&self) -> String {
        self.root.to_string_lossy().into_owned()
    }

    /// Every live book.
    pub fn run(&self) -> Result<Report> {
        let books = self
            .ws
            .run::<BookList>(&Actor::Mirror, ListBooksIn { trashed: false })?
            .output;
        let mut report = Report::default();
        for b in books.into_iter().filter(|b| !b.trashed) {
            let r = self.book(&b.id)?;
            report.merged.extend(r.merged);
            report.written += r.written;
            report.preserved.extend(r.preserved);
            report.issues.extend(r.issues);
            report.waiting |= r.waiting;
        }
        Ok(report)
    }

    /// The book's folder under the root, chosen once (its name; ` 2`, ` 3`
    /// when another book has it) and renamed with the book.
    pub fn book_dir(&self, book: &str) -> Result<PathBuf> {
        let lib = self.ws.library();
        let root = self.root_key();
        let name = self
            .ws
            .run::<BookGet>(
                &Actor::Mirror,
                BookIn {
                    book: book.to_owned(),
                },
            )?
            .output
            .info
            .name;
        let want = layout::stem(&name);
        let taken: HashSet<String> = ledger::books(lib, &root)?
            .into_iter()
            .filter(|(id, _)| id != book)
            .map(|(_, r)| r.folder.to_lowercase())
            .collect();
        let current = ledger::book(lib, book)?.filter(|r| r.root == root);
        // Still named after the book (with its number, if any): keep it.
        if let Some(r) = &current {
            let same = r.folder == want
                || r.folder
                    .strip_prefix(&want)
                    .and_then(|s| s.strip_prefix(' '))
                    .is_some_and(|n| n.parse::<u32>().is_ok());
            if same {
                return Ok(self.root.join(&r.folder));
            }
        }
        let mut folder = want.clone();
        let mut n = 2;
        while taken.contains(&folder.to_lowercase())
            || (current.as_ref().is_none_or(|r| r.folder != folder)
                && self.root.join(&folder).exists()
                && !owned_by(&self.root.join(&folder), self.installation))
        {
            folder = format!("{want} {n}");
            n += 1;
        }
        if let Some(r) = &current
            && r.folder != folder
        {
            let from = self.root.join(&r.folder);
            let to = self.root.join(&folder);
            if from.exists() && !to.exists() {
                std::fs::rename(&from, &to)?;
            }
        }
        ledger::put_book(
            lib,
            book,
            &BookRow {
                root,
                folder: folder.clone(),
            },
        )?;
        Ok(self.root.join(folder))
    }

    /// One book.
    pub fn book(&self, book: &str) -> Result<Report> {
        let mut report = Report::default();
        let lib = self.ws.library();
        let root = self.root_key();
        let dir = self.book_dir(book)?;
        if disk::claim(&dir, self.installation, self.app)?.is_err() {
            report.issues.push(Issue {
                book: book.to_owned(),
                doc: None,
                title: String::new(),
                path: dir,
                problem: Problem::OwnedElsewhere,
            });
            return Ok(report);
        }
        let mut entries = layout::entries(self.ws, book)?;
        let mut rows: HashMap<String, FileRow> = ledger::files(lib, book)?
            .into_iter()
            .filter(|(_, r)| r.root == root)
            .collect();
        let stamp = chrono::Local::now().format("%Y-%m-%dT%H-%M-%S").to_string();
        let mut book_reader: Option<BookReader> = None;
        // Documents not to write this pass.
        let mut hold: HashSet<String> = HashSet::new();

        // 1. Read back what changed elsewhere.
        let mut docs: Vec<String> = rows.keys().cloned().collect();
        docs.sort();
        let by_doc: HashMap<String, Entry> =
            entries.iter().map(|e| (e.doc.clone(), e.clone())).collect();
        for doc in docs {
            let Some(entry) = by_doc.get(doc.as_str()) else {
                continue;
            };
            let row = rows[&doc].clone();
            let path = dir.join(&row.path);
            if !self.thorough && row.stat.is_some() && disk::stat(&path)? == row.stat {
                continue;
            }
            let (bytes, modified, stat) = match disk::read(&path) {
                Ok(Some(f)) => f,
                Ok(None) => continue,
                Err(e) if e.kind() == std::io::ErrorKind::FileTooLarge => {
                    // Not read; kept as it is, then written again.
                    let kept = dir
                        .join(disk::META_DIR)
                        .join("preserved")
                        .join(&stamp)
                        .join(&row.path);
                    if let Some(parent) = kept.parent() {
                        std::fs::create_dir_all(parent)?;
                    }
                    std::fs::copy(&path, &kept)?;
                    report.preserved.push(kept);
                    std::fs::remove_file(&path)?;
                    self.refuse(
                        &mut report,
                        &mut rows,
                        book,
                        entry,
                        &path,
                        Problem::TooLarge,
                        None,
                    )?;
                    continue;
                }
                Err(e) => return Err(e.into()),
            };
            let sha = disk::sha256_hex(&bytes);
            if sha == row.sha {
                continue;
            }
            if let Some(r) = row.refused.as_ref().filter(|r| r.sha == sha) {
                if r.problem == Problem::Frontmatter {
                    hold.insert(doc.clone());
                }
                report.issues.push(issue(book, entry, &path, r.problem));
                continue;
            }
            if SystemTime::now()
                .duration_since(modified)
                .is_ok_and(|age| age < self.settle)
            {
                report.waiting = true;
                hold.insert(doc.clone());
                continue;
            }
            let Ok(text) = String::from_utf8(bytes.clone()) else {
                self.refuse(
                    &mut report,
                    &mut rows,
                    book,
                    entry,
                    &path,
                    Problem::NotUtf8,
                    Some(sha),
                )?;
                continue;
            };
            let Some(parsed) = file::parse(&text) else {
                self.refuse(
                    &mut report,
                    &mut rows,
                    book,
                    entry,
                    &path,
                    Problem::Frontmatter,
                    Some(sha),
                )?;
                hold.insert(doc.clone());
                continue;
            };
            if parsed.id.as_deref().is_some_and(|id| id != entry.id) {
                self.refuse(
                    &mut report,
                    &mut rows,
                    book,
                    entry,
                    &path,
                    Problem::WrongId,
                    Some(sha),
                )?;
                continue;
            }
            let doc_id = DocId::parse(&doc).map_err(|e| SyncError::Invalid(e.to_string()))?;
            if !doc_id.kind().is_book_text() {
                continue;
            }
            let Some(base) = row.base() else {
                self.refuse(
                    &mut report,
                    &mut rows,
                    book,
                    entry,
                    &path,
                    Problem::UnknownBase,
                    Some(sha),
                )?;
                continue;
            };
            let copy = match lib.load_copy(&doc) {
                Ok(c) => c,
                Err(dr_store::StoreError::NotFound(_)) => loro::LoroDoc::new(),
                Err(e) => return Err(e.into()),
            };
            if book_reader.is_none() {
                book_reader = Some(self.book_reader(book)?);
            }
            let names = book_reader
                .as_ref()
                .map(|r| dr_workspace::autolink::matcher(&r.view(), &doc_id));
            let paras = body::parse(&parsed.body);
            let peer = merge::merge_peer(&doc_id, &base, &bytes);
            let merged = match merge::merge(&copy, &doc_id, &base, &paras, peer, names.as_ref())? {
                Ok(m) => m,
                Err(r) => {
                    let p = match r {
                        Refusal::UnknownBase => Problem::UnknownBase,
                        Refusal::Emptied => Problem::Emptied,
                    };
                    self.refuse(&mut report, &mut rows, book, entry, &path, p, Some(sha))?;
                    continue;
                }
            };
            if !merged.update.is_empty() {
                self.ws
                    .import_remote(&doc, None, merged.update, &Actor::Mirror)?;
            }
            // The fields: what the file changed since the base.
            let mut fields = row.fields.clone();
            let mut update = serde_json::Map::new();
            if let Some(s) = parsed.status
                && s != row.fields.status
                && valid_status(entry.kind, s)
            {
                update.insert("status".into(), json!(s));
                fields.status = s.to_owned();
            }
            if let Some(s) = &parsed.summary
                && *s != row.fields.summary
            {
                update.insert("summary".into(), json!(s));
                fields.summary = s.clone();
            }
            fields.extra = parsed.extra.clone();
            if !update.is_empty() {
                update.insert("book".into(), json!(book));
                update.insert("id".into(), json!(entry.id));
                let op = match entry.kind {
                    EntryKind::Chapter => "chapter.update",
                    EntryKind::Idea => "idea.update",
                };
                self.ws
                    .call(&Actor::Mirror, op, serde_json::Value::Object(update))?;
            }
            let next = FileRow {
                sha,
                base: ledger::encode(&merged.frontiers),
                fields,
                stat: Some(stat),
                refused: None,
                ..row
            };
            ledger::put_file(lib, &doc, &next)?;
            rows.insert(doc.clone(), next);
            report.merged.push(doc.clone());
        }

        // The fields a merge changed (and anything else since) are what
        // gets written.
        if !report.merged.is_empty() {
            entries = layout::entries(self.ws, book)?;
        }
        let by_doc: HashMap<&str, &Entry> = entries.iter().map(|e| (e.doc.as_str(), e)).collect();

        // 2. Put away files of what is gone, and old places of what moved.
        let mut gone: Vec<(String, FileRow)> = rows
            .iter()
            .filter(|(doc, row)| by_doc.get(doc.as_str()).is_none_or(|e| e.path != row.path))
            .map(|(d, r)| (d.clone(), r.clone()))
            .collect();
        gone.sort_by(|a, b| a.0.cmp(&b.0));
        for (doc, row) in gone {
            if hold.contains(&doc) {
                continue;
            }
            let path = dir.join(&row.path);
            if let Some((bytes, _, _)) = disk::read(&path).ok().flatten() {
                if disk::sha256_hex(&bytes) != row.sha {
                    report
                        .preserved
                        .push(disk::preserve(&dir, &row.path, &bytes, &stamp)?);
                }
                disk::remove(&path, &dir)?;
            }
            if by_doc.contains_key(doc.as_str()) {
                // Moved: written at its new place below, from the same base.
                rows.insert(
                    doc.clone(),
                    FileRow {
                        path: by_doc[doc.as_str()].path.clone(),
                        sha: String::new(),
                        stat: None,
                        ..row
                    },
                );
            } else {
                ledger::remove_file(lib, &doc)?;
                rows.remove(&doc);
            }
        }

        // 3. Write.
        for e in &entries {
            if hold.contains(&e.doc) {
                continue;
            }
            let path = dir.join(&e.path);
            if !self.thorough
                && let Some(r) = rows.get(&e.doc)
                && r.refused.is_none()
                && r.path == e.path
                && r.title == e.title
                && r.fields.status == e.status
                && r.fields.summary == e.summary
                && r.stat.is_some()
                && disk::stat(&path)? == r.stat
                && lib
                    .head(&e.doc)?
                    .map_or(String::new(), |h| ledger::encode(&h.frontiers))
                    == r.base
            {
                continue;
            }
            let doc_id = DocId::parse(&e.doc).map_err(|x| SyncError::Invalid(x.to_string()))?;
            let (paras, frontiers) = match lib.load_copy(&e.doc) {
                Ok(copy) => {
                    let reader = ProseReader::from_loro(doc_id, &copy)?;
                    let paras: Vec<Para> =
                        reader.view().paragraphs().map(|p| Para::of(&p)).collect();
                    (paras, copy.state_frontiers())
                }
                Err(dr_store::StoreError::NotFound(_)) => (Vec::new(), loro::Frontiers::default()),
                Err(x) => return Err(x.into()),
            };
            let row = rows.get(&e.doc).cloned();
            let fields = Fields {
                status: e.status.clone(),
                summary: e.summary.clone(),
                extra: row
                    .as_ref()
                    .map(|r| r.fields.extra.clone())
                    .unwrap_or_default(),
            };
            let text = file::render(&e.id, &e.title, &fields, &body::render(&paras));
            let sha = disk::sha256_hex(text.as_bytes());
            let current = disk::read(&path).ok().flatten();
            let current_sha = current.as_ref().map(|(b, _, _)| disk::sha256_hex(b));
            let mut next = FileRow {
                book: book.to_owned(),
                root: root.clone(),
                path: e.path.clone(),
                sha: sha.clone(),
                base: ledger::encode(&frontiers),
                fields,
                title: e.title.clone(),
                stat: current.as_ref().map(|(_, _, s)| *s),
                refused: None,
            };
            if current_sha.as_deref() == Some(sha.as_str()) {
                if row.as_ref() != Some(&next) {
                    ledger::put_file(lib, &e.doc, &next)?;
                }
                continue;
            }
            if let (Some((bytes, _, _)), Some(cur)) = (&current, &current_sha) {
                let ours = row.as_ref().is_some_and(|r| r.sha == *cur);
                let given_up = row
                    .as_ref()
                    .and_then(|r| r.refused.as_ref())
                    .is_some_and(|r| r.sha == *cur);
                if !ours {
                    if row.is_some() && !given_up && !row.as_ref().is_some_and(|r| r.sha.is_empty())
                    {
                        // Changed elsewhere and not read yet.
                        continue;
                    }
                    // No base for these bytes (a file left from before, or
                    // one that could not be merged): kept, then replaced.
                    report
                        .preserved
                        .push(disk::preserve(&dir, &e.path, bytes, &stamp)?);
                }
            }
            disk::write(&path, text.as_bytes())?;
            next.stat = disk::stat(&path)?;
            ledger::put_file(lib, &e.doc, &next)?;
            report.written += 1;
        }
        Ok(report)
    }

    /// The book document, read for the names prose links to.
    fn book_reader(&self, book: &str) -> Result<BookReader> {
        let id = BookId::parse(book).map_err(|e| SyncError::Invalid(e.to_string()))?;
        let copy = self
            .ws
            .library()
            .load_copy(&DocId::Book(id.clone()).to_string())?;
        Ok(BookReader::from_loro(id, &copy)?)
    }

    #[allow(clippy::too_many_arguments)]
    fn refuse(
        &self,
        report: &mut Report,
        rows: &mut HashMap<String, FileRow>,
        book: &str,
        entry: &Entry,
        path: &Path,
        problem: Problem,
        sha: Option<String>,
    ) -> Result<()> {
        report.issues.push(issue(book, entry, path, problem));
        if let (Some(sha), Some(row)) = (sha, rows.get_mut(&entry.doc)) {
            row.refused = Some(Refused { sha, problem });
            ledger::put_file(self.ws.library(), &entry.doc, row)?;
        }
        Ok(())
    }
}

fn issue(book: &str, e: &Entry, path: &Path, problem: Problem) -> Issue {
    Issue {
        book: book.to_owned(),
        doc: Some(e.doc.clone()),
        title: e.title.clone(),
        path: path.to_path_buf(),
        problem,
    }
}

fn valid_status(kind: EntryKind, s: &str) -> bool {
    match kind {
        EntryKind::Chapter => matches!(s, "draft" | "finished" | "discarded"),
        EntryKind::Idea => matches!(s, "drifting" | "resting"),
    }
}

/// Whether `dir` is a book folder this installation keeps (or no one's).
fn owned_by(dir: &Path, installation: &str) -> bool {
    let file = dir.join(disk::META_DIR).join("owner.json");
    match std::fs::read(&file) {
        Ok(bytes) => serde_json::from_slice::<serde_json::Value>(&bytes)
            .ok()
            .and_then(|v| v["installationId"].as_str().map(|s| s == installation))
            .unwrap_or(false),
        Err(_) => false,
    }
}
