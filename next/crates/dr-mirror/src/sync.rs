//! A single pass reads external edits before projecting local changes. Paths
//! only identify files inside the claimed project folder and the active
//! manifest, and every replacement checks the bytes learned by the pass.
//!
//! A pass skips what did not change since the App last looked: a file with
//! the size and modification time the ledger recorded is not read again, a
//! body this `Pass` already rendered at the same version is not rendered
//! again, and a level body whose version did not change is not loaded for
//! the layout.

mod copies;
mod project;
#[cfg(test)]
mod tests;

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use dr_model::{
    DocId,
    id::{BodyDocId, BookId},
};
use dr_workspace::{
    Actor, Workspace,
    commands::book::{BookList, ListBooksIn},
};

use crate::{
    Options, apply,
    body::{self, BodyIssue, FileLinks},
    disk, file,
    layout::{self, AssetFile, BookLayout, ProseFile},
    ledger::{Applying, Fingerprint, Ledger, ProjectRow, Row, Standing, Version},
    merge::{self, Refusal},
};
use loro::Frontiers;

use self::project::{Imported, Project, read_copy, render_prose};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub enum Problem {
    Frontmatter,
    WrongId,
    Emptied,
    StaleBase,
    NotUtf8,
    TooLarge,
    OwnedElsewhere,
    UnsafePath,
    Occupied,
    Duplicate,
    Moved,
    ReadOnly,
    MalformedTable,
    UnknownImage,
    FieldConflict,
    Disk,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Issue {
    pub book: String,
    pub doc: Option<String>,
    pub title: String,
    pub path: PathBuf,
    pub problem: Problem,
    /// Where the file was kept before the App rewrote it. Such an issue is
    /// reported again on every pass until that copy is gone.
    pub kept: Option<PathBuf>,
}

#[derive(Debug, Default)]
pub struct Report {
    pub merged: Vec<String>,
    pub written: usize,
    pub preserved: Vec<PathBuf>,
    pub issues: Vec<Issue>,
    pub waiting: bool,
    /// Projects to look at again soon (a file still settling, a raced
    /// write).
    pub(crate) retry: BTreeSet<BookId>,
    /// Projects with a file waiting only for the author's composition.
    pub(crate) composing: BTreeSet<BookId>,
    /// Each project folder as the pass left it.
    pub(crate) seen: BTreeMap<BookId, Seen>,
}

/// A project folder's files and the size and time each had when the App
/// last read or wrote it: a file event or check that finds those again is
/// the App's own write.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Seen {
    pub dir: PathBuf,
    pub files: BTreeMap<PathBuf, disk::Stat>,
}

impl Report {
    pub(crate) fn join(&mut self, other: Self) {
        self.merged.extend(other.merged);
        self.written += other.written;
        self.preserved.extend(other.preserved);
        self.issues.extend(other.issues);
        self.waiting |= other.waiting;
        self.retry.extend(other.retry);
        self.composing.extend(other.composing);
        self.seen.extend(other.seen);
    }

    /// The chosen folder cannot be reached (moved, unmounted, not
    /// readable): one issue for it, nothing read or written.
    fn unreachable(root: &Path) -> Self {
        Self {
            issues: vec![Issue {
                book: String::new(),
                doc: None,
                title: root.display().to_string(),
                path: root.to_path_buf(),
                problem: Problem::Disk,
                kept: None,
            }],
            ..Self::default()
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    #[error(transparent)]
    Workspace(#[from] dr_workspace::WsError),
    #[error(transparent)]
    Store(#[from] dr_store::StoreError),
    #[error(transparent)]
    Doc(#[from] dr_doc::DocError),
    #[error(transparent)]
    Loro(#[from] loro::LoroError),
    #[error(transparent)]
    Merge(#[from] merge::MergeError),
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error("{0}")]
    Invalid(String),
}
pub type Result<T> = std::result::Result<T, SyncError>;

/// What a `Pass` remembers between passes (the worker keeps one).
#[derive(Default)]
struct Cache {
    /// A level body's version and whether it had text.
    levels: HashMap<DocId, (Frontiers, bool)>,
    /// What this process last rendered for a body.
    rendered: HashMap<BodyDocId, Rendered>,
}

struct Rendered {
    /// The row the rendering came from: path, fields, extra and version.
    version: Version,
    /// The project's asset files, which links are rendered from.
    assets: String,
    sha: String,
}

#[cfg(test)]
thread_local! {
    /// Markdown files read in full, for the tests of what a pass skips.
    pub(crate) static RENDERS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    pub(crate) static READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

pub struct Pass<'a> {
    ws: &'a Workspace,
    options: &'a Options,
    cache: RefCell<Cache>,
}

impl<'a> Pass<'a> {
    pub fn new(ws: &'a Workspace, options: &'a Options) -> Self {
        Self {
            ws,
            options,
            cache: RefCell::default(),
        }
    }

    fn root(&self) -> Result<PathBuf> {
        Ok(self.options.root.canonicalize()?)
    }

    /// The chosen folder, or `None` when it cannot be reached.
    fn reachable(&self) -> Option<PathBuf> {
        let root = self.root().ok()?;
        fs::read_dir(&root).ok()?;
        Some(root)
    }

    pub fn folder(&self, book: &BookId) -> Result<Option<PathBuf>> {
        let root = self.root()?;
        Ledger::new(self.ws.library(), book, &root)
            .project()?
            .map(|row| Ok(disk::checked(&root, &row.folder, false)?))
            .transpose()
    }

    pub fn run(&self) -> Result<Report> {
        self.reconcile(None, |_| true)
    }

    /// `books`: only these projects (all when `None`).
    pub(crate) fn reconcile(
        &self,
        books: Option<&BTreeSet<BookId>>,
        writeback: impl Fn(&BookId) -> bool,
    ) -> Result<Report> {
        let Some(root) = self.reachable() else {
            return Ok(Report::unreachable(&self.options.root));
        };
        let mut report = Report::default();
        let targets: Vec<_> = if let Some(books) = books {
            // A notification for one project must not decode every other
            // book just to discover that its ID is outside this pass.
            books
                .iter()
                .map(|book| {
                    let title = Ledger::new(self.ws.library(), book, &root)
                        .project()?
                        .map_or_else(|| book.to_string(), |row| row.title);
                    Ok((book.clone(), title))
                })
                .collect::<Result<_>>()?
        } else {
            self.ws
                .run::<BookList>(&Actor::Mirror, ListBooksIn { trashed: false })?
                .output
                .into_iter()
                .map(|info| {
                    let book =
                        BookId::parse(&info.id).map_err(|e| SyncError::Invalid(e.to_string()))?;
                    Ok((book, info.name))
                })
                .collect::<Result<_>>()?
        };
        for (book, title) in targets {
            match self.reconcile_book(&root, &book, writeback(&book)) {
                Ok(one) => report.join(one),
                Err(err) => {
                    log::warn!("Markdown folder project pass: {err}");
                    report.issues.push(Issue {
                        book: book.to_string(),
                        doc: None,
                        title,
                        path: self.options.root.clone(),
                        problem: if matches!(&err, SyncError::Io(io) if unsafe_io(io)) {
                            Problem::UnsafePath
                        } else {
                            Problem::Disk
                        },
                        kept: None,
                    });
                }
            }
        }
        Ok(report)
    }

    pub fn book(&self, book: &BookId) -> Result<Report> {
        match self.reachable() {
            Some(root) => self.reconcile_book(&root, book, true),
            None => Ok(Report::unreachable(&self.options.root)),
        }
    }

    fn reconcile_book(&self, root: &Path, book: &BookId, writeback: bool) -> Result<Report> {
        let Some(project) = Project::read(self.ws, book)? else {
            return Ok(Report::default());
        };
        let ledger = Ledger::new(self.ws.library(), book, root);
        let mut row = allocate(root, &ledger, &project.title, &self.options.names)?;
        let dir = disk::checked(root, &row.folder, false)?;
        let mut state = BookPass {
            ws: self.ws,
            dir,
            ledger,
            options: self.options,
            report: Report::default(),
            stamp: chrono::Local::now()
                .format("%Y-%m-%dT%H-%M-%S-%9f")
                .to_string(),
            cache: &self.cache,
            retry: false,
            composing: false,
            read: false,
            standing: Vec::new(),
        };
        match disk::claim_for(
            &state.dir,
            &self.options.installation,
            &self.options.app,
            book.as_str(),
        ) {
            Ok(Ok(())) => {}
            Ok(Err(_)) => {
                state.issue(&project, None, "", Problem::OwnedElsewhere);
                return Ok(state.report);
            }
            Err(err) if unsafe_io(&err) => {
                state.issue(&project, None, "", Problem::UnsafePath);
                return Ok(state.report);
            }
            Err(err) => return Err(err.into()),
        }
        let (project, files) = state.steps(project, &mut row, root, writeback)?;
        state.settle(&project, &files, &row)?;
        Ok(state.report)
    }
}

fn allocate(
    root: &Path,
    ledger: &Ledger<'_>,
    title: &str,
    names: &layout::Names,
) -> Result<ProjectRow> {
    if let Some(mut row) = ledger.project()? {
        if let Some(pending) = row.renaming.take()
            && !disk::checked(root, &row.folder, false)?.exists()
            && disk::checked(root, &pending, false)?.is_dir()
        {
            row.folder = pending;
        }
        let dir = disk::checked(root, &row.folder, false)?;
        if !dir.exists() {
            fs::create_dir(&dir)?;
        }
        return Ok(row);
    }
    let taken = occupied(root, None)?;
    let folder = layout::project_folder_name(title, names, taken.iter().map(String::as_str));
    fs::create_dir(disk::checked(root, &folder, false)?)?;
    let row = ProjectRow {
        folder,
        title: title.into(),
        names: names.clone(),
        renaming: None,
        assets: Vec::new(),
        copies: BTreeMap::new(),
        directories: BTreeSet::new(),
    };
    ledger.put_project(&row)?;
    Ok(row)
}

fn occupied(root: &Path, exclude: Option<&str>) -> io::Result<Vec<String>> {
    fs::read_dir(root)?
        .filter_map(|p| match p {
            Ok(p) => p
                .file_name()
                .into_string()
                .ok()
                .filter(|n| Some(n.as_str()) != exclude)
                .map(Ok),
            Err(err) => Some(Err(err)),
        })
        .collect()
}

struct BookPass<'a> {
    ws: &'a Workspace,
    dir: PathBuf,
    ledger: Ledger<'a>,
    options: &'a Options,
    report: Report,
    stamp: String,
    cache: &'a RefCell<Cache>,
    /// Waiting for something other than a composition.
    retry: bool,
    /// Waiting for the author's composition to end.
    composing: bool,
    /// A changed file was read: the project may have changed with it.
    read: bool,
    /// Files kept and rewritten in this pass.
    standing: Vec<Standing>,
}

impl BookPass<'_> {
    /// Everything after the claim: read the folder, then write it.
    fn steps(
        &mut self,
        mut project: Project,
        row: &mut ProjectRow,
        root: &Path,
        writeback: bool,
    ) -> Result<(Project, BTreeMap<BodyDocId, Row>)> {
        let mut layout = {
            let mut cache = self.cache.borrow_mut();
            project.layout(self.ws.library(), &row.names, &mut cache.levels)?
        };
        let mut files = self.ledger.files()?;
        let mut held = self.ingest(&project, &layout, row, &mut files)?;
        if !writeback {
            return Ok((project, files));
        }
        if self.read {
            let Some(latest) = Project::read(self.ws, &project.book)? else {
                return Ok((project, files));
            };
            project = latest;
            let mut cache = self.cache.borrow_mut();
            layout = project.layout(self.ws.library(), &row.names, &mut cache.levels)?;
        }
        let active: BTreeMap<_, _> = layout
            .prose
            .iter()
            .map(|file| (file.id.clone(), file))
            .collect();
        for (id, file) in &mut files {
            if held.contains(id) {
                continue;
            }
            let desired = active.get(id).filter(|f| f.present);
            if desired.is_none_or(|want| want.path != file.current.path) {
                if !self.take_away(&project, id, &file.current)? {
                    held.insert(id.clone());
                    continue;
                }
                file.current.disk = None;
                file.current.retired = !active.contains_key(id);
                file.outgoing = None;
                file.applying = None;
                self.ledger.put_file(id, file)?;
            }
        }
        let assets = disk::sha256_hex(
            serde_json::to_string(&layout.assets)
                .map_err(|e| SyncError::Invalid(e.to_string()))?
                .as_bytes(),
        );
        let mut projected = BTreeMap::new();
        for file in &layout.prose {
            if !held.contains(&file.id) {
                let prior = files.remove(&file.id);
                if let Some(row) = self.project_file(
                    &project,
                    &layout,
                    file,
                    prior,
                    &assets,
                    row.assets == layout.assets,
                )? {
                    projected.insert(file.id.clone(), row);
                }
            }
        }
        files.append(&mut projected);
        self.copies(&project, &layout, row)?;
        self.rename_folder(root, &project.title, row)?;
        self.ledger.put_project(row)?;
        Ok((project, files))
    }

    /// Report what is still kept from earlier passes, and what the folder
    /// holds now.
    fn settle(
        &mut self,
        project: &Project,
        files: &BTreeMap<BodyDocId, Row>,
        row: &ProjectRow,
    ) -> Result<()> {
        let before = self.ledger.standing()?;
        let mut standing: Vec<Standing> = before
            .iter()
            .filter(|old| {
                !self.standing.contains(old)
                    // The ledger generated this relative path. Only inspect
                    // the directory entry: an unsafe retained symlink also
                    // keeps its notice, without following its target.
                    && fs::symlink_metadata(self.dir.join(&old.kept)).is_ok()
            })
            .cloned()
            .collect();
        for old in &standing {
            let id = old.doc.as_deref().and_then(|doc| match DocId::parse(doc) {
                Ok(DocId::Body(id)) => Some(id),
                _ => None,
            });
            let title = id
                .as_ref()
                .map_or(project.title.as_str(), |id| project.title_for(id));
            self.report.issues.push(Issue {
                book: project.book.to_string(),
                doc: old.doc.clone(),
                title: title.into(),
                path: self.dir.join(&old.rel),
                problem: old.problem,
                kept: Some(self.dir.join(&old.kept)),
            });
        }
        standing.append(&mut self.standing);
        if standing != before {
            self.ledger.put_standing(&standing)?;
        }
        let book = project.book.clone();
        if self.retry {
            self.report.retry.insert(book.clone());
        }
        if self.composing {
            self.report.composing.insert(book.clone());
        }
        let mut seen = Seen {
            dir: self.dir.clone(),
            files: BTreeMap::new(),
        };
        for file in files.values() {
            if let Some(disk) = &file.current.disk {
                seen.files
                    .insert(self.dir.join(&file.current.path), disk.stat);
            }
        }
        for copy in row.copies.values() {
            if let Some(stat) = copy.stat {
                seen.files.insert(self.dir.join(&copy.path), stat);
            }
        }
        self.report.seen.insert(book, seen);
        Ok(())
    }

    fn wait(&mut self) {
        self.report.waiting = true;
        self.retry = true;
    }

    fn wait_composing(&mut self) {
        self.report.waiting = true;
        self.composing = true;
    }

    fn issue(&mut self, book: &Project, id: Option<&BodyDocId>, rel: &str, problem: Problem) {
        self.issue_kept(book, id, rel, problem, None);
    }

    fn issue_kept(
        &mut self,
        book: &Project,
        id: Option<&BodyDocId>,
        rel: &str,
        problem: Problem,
        kept: Option<PathBuf>,
    ) {
        let title = id.map_or(book.title.as_str(), |id| book.title_for(id));
        self.report.issues.push(Issue {
            book: book.book.to_string(),
            doc: id.map(|id| DocId::Body(id.clone()).to_string()),
            title: title.into(),
            path: self.dir.join(rel),
            problem,
            kept,
        });
    }

    /// Keep the file before the App rewrites it, and say so until the
    /// author has dealt with the kept copy.
    fn keep_with_issue(
        &mut self,
        book: &Project,
        id: &BodyDocId,
        rel: &str,
        problem: Problem,
    ) -> Result<()> {
        let kept = self.keep(rel)?;
        self.record_kept(book, Some(id), rel, problem, kept)
    }

    fn record_kept(
        &mut self,
        book: &Project,
        id: Option<&BodyDocId>,
        rel: &str,
        problem: Problem,
        kept: PathBuf,
    ) -> Result<()> {
        self.standing.push(Standing {
            doc: id.map(|id| DocId::Body(id.clone()).to_string()),
            rel: rel.into(),
            problem,
            kept: kept
                .strip_prefix(&self.dir)
                .map_err(|e| SyncError::Invalid(e.to_string()))?
                .to_string_lossy()
                .into_owned(),
        });
        self.issue_kept(book, id, rel, problem, Some(kept));
        Ok(())
    }

    fn unsafe_issue(
        &mut self,
        project: &Project,
        id: Option<&BodyDocId>,
        rel: &str,
        err: &io::Error,
    ) -> Result<()> {
        if let Some(held) = disk::retained_entry(err) {
            self.record_kept(project, id, rel, Problem::UnsafePath, held.to_path_buf())?;
        } else {
            self.issue(project, id, rel, Problem::UnsafePath);
        }
        Ok(())
    }

    fn keep_displaced(
        &mut self,
        project: &Project,
        id: Option<&BodyDocId>,
        rel: &str,
        displaced: Option<&Path>,
    ) -> Result<()> {
        if let Some(displaced) = displaced {
            let kept = disk::preserve_displaced(&self.dir, rel, &self.stamp, displaced)?;
            self.report.preserved.push(kept.clone());
            self.record_kept(project, id, rel, Problem::StaleBase, kept)?;
        }
        Ok(())
    }

    fn ingest(
        &mut self,
        project: &Project,
        layout: &BookLayout,
        book_row: &ProjectRow,
        rows: &mut BTreeMap<BodyDocId, Row>,
    ) -> Result<BTreeSet<BodyDocId>> {
        let desired: BTreeMap<_, _> = layout.prose.iter().map(|file| (&file.id, file)).collect();
        let assets: Vec<_> = book_row.assets.iter().chain(&layout.assets).collect();
        let mut paths = disk_markdown(&self.dir, "", &layout.contents_path)?;
        // Which bodies each path belongs to, as far as the ledger and the
        // layout know.
        let mut owners: BTreeMap<String, BTreeSet<BodyDocId>> = BTreeMap::new();
        for (id, row) in rows.iter() {
            let pending = row
                .outgoing
                .iter()
                .map(|v| &v.path)
                .chain(row.applying.as_ref().and_then(|a| a.path.as_ref()));
            for path in std::iter::once(&row.current.path).chain(pending) {
                owners.entry(path.clone()).or_default().insert(id.clone());
            }
        }
        for file in &layout.prose {
            owners
                .entry(file.path.clone())
                .or_default()
                .insert(file.id.clone());
        }
        paths.extend(owners.keys().cloned());
        let probes: BTreeMap<String, Probe> = paths
            .into_iter()
            .map(|p| {
                let probe = self.probe(&p, &owners, rows);
                (p, probe)
            })
            .collect();
        let mut by_id: BTreeMap<BodyDocId, Vec<String>> = BTreeMap::new();
        for (path, state) in &probes {
            if let Some(id) = state.claimed()
                && desired.contains_key(&id)
            {
                by_id.entry(id).or_default().push(path.clone());
            }
        }
        let tracked: BTreeSet<_> = rows
            .values()
            .filter(|r| r.current.disk.is_some())
            .map(|r| r.current.path.clone())
            .collect();
        let settling_unknown_path = probes
            .iter()
            .any(|(path, probe)| matches!(probe, Probe::Young) && !tracked.contains(path));
        let mut held = BTreeSet::new();
        let work: BTreeSet<_> = desired
            .keys()
            .map(|id| (*id).clone())
            .chain(rows.keys().cloned())
            .collect();
        for id in work {
            let wanted = desired.get(&id).copied();
            let (mut row, stored) = match (rows.remove(&id), wanted) {
                (Some(row), _) => (row.clone(), Some(row)),
                (None, Some(file)) => (self.new_row(project, layout, file, String::new())?, None),
                (None, None) => continue,
            };
            if let Some(stale) = self.pending(project, &id, &mut row, &probes)? {
                // A write or merge whose acknowledgment never reached the
                // ledger (a crash), then an outside save: merging that
                // against the older baseline would add the App's text a
                // second time. Keep the file and write it again.
                self.keep_with_issue(project, &id, &stale.path, Problem::StaleBase)?;
                if self.remove(project, Some(&id), &stale.path, Some(&stale.sha))? {
                    if stale.path == row.current.path {
                        row.current.disk = None;
                    }
                } else {
                    held.insert(id.clone());
                }
                self.ledger.put_file(&id, &row)?;
                rows.insert(id, row);
                continue;
            }

            let previous = row.current.clone();
            let path = previous.path.as_str();
            let sources = by_id.get(&id).map_or(&[][..], Vec::as_slice);
            let original = probes.get(path).unwrap_or(&Probe::Missing);
            // A save at an untracked path may be the missing file's rename.
            // Recreating the old path now would turn it into a duplicate.
            if settling_unknown_path
                && matches!(original, Probe::Missing)
                && previous.disk.is_some()
                && !previous.retired
            {
                self.wait();
                held.insert(id.clone());
                if stored.as_ref() != Some(&row) {
                    self.ledger.put_file(&id, &row)?;
                }
                rows.insert(id, row);
                continue;
            }
            let source = if matches!(original, Probe::Missing)
                && previous.disk.is_some()
                && !previous.retired
            {
                let moved = sources
                    .iter()
                    .filter(|p| !tracked.contains(*p))
                    .collect::<Vec<_>>();
                if moved.len() == 1 && sources.len() == 1 {
                    moved[0].as_str()
                } else {
                    path
                }
            } else {
                path
            };
            for duplicate in sources.iter().filter(|p| *p != source && *p != path) {
                self.issue(project, Some(&id), duplicate, Problem::Duplicate);
            }
            if source == path && matches!(original, Probe::Missing) && sources.len() > 1 {
                held.insert(id.clone());
            }
            let found = probes.get(source).unwrap_or(&Probe::Missing);
            if matches!(found, Probe::Young) {
                self.wait();
                held.insert(id.clone());
            } else if let Probe::Unsafe = found {
                self.issue(project, Some(&id), source, Problem::UnsafePath);
                held.insert(id.clone());
            } else if let Some(fingerprint) = found.fingerprint() {
                let occupied = previous.disk.is_none()
                    && !previous.retired
                    && wanted.is_some_and(|p| p.present);
                let unsafe_basis = !project.accepts(&id, &previous)
                    || wanted.is_some_and(|p| !p.present && previous.disk.is_some());
                let known_previous = previous.disk.is_some()
                    || previous.retired && found.claimed().as_ref() == Some(&id);
                if occupied {
                    self.issue(project, Some(&id), source, Problem::Occupied);
                    held.insert(id.clone());
                } else if unsafe_basis {
                    if known_previous {
                        if previous.sha() != Some(&fingerprint.sha) {
                            self.keep_with_issue(project, &id, source, Problem::StaleBase)?;
                        }
                        if !self.remove(project, Some(&id), source, Some(&fingerprint.sha))? {
                            held.insert(id.clone());
                        }
                        row.current.disk = None;
                    } else if wanted.is_some() {
                        held.insert(id.clone());
                    }
                } else if previous.sha() != Some(&fingerprint.sha) {
                    let Some(wanted) = wanted else {
                        unreachable!("checked active module")
                    };
                    // Only a file the ledger does not already know is read.
                    let rescanned;
                    let contents = match found {
                        Probe::File(contents) => contents,
                        _ => {
                            rescanned = scan(&self.dir, source, self.options.settle);
                            match &rescanned {
                                Probe::File(contents) => contents,
                                _ => {
                                    self.wait();
                                    held.insert(id.clone());
                                    self.ledger.put_file(&id, &row)?;
                                    rows.insert(id, row);
                                    continue;
                                }
                            }
                        }
                    };
                    self.read = true;
                    let accepted =
                        self.read_change(project, &assets, wanted, contents, source, &mut row)?;
                    if !accepted {
                        held.insert(id.clone());
                    }
                } else if source != path {
                    self.keep_with_issue(project, &id, source, Problem::Moved)?;
                    row.current.path = source.into();
                } else if previous
                    .disk
                    .as_ref()
                    .is_some_and(|d| d.stat != fingerprint.stat)
                {
                    // Same bytes, touched: remember the new time so the next
                    // pass does not read it again.
                    row.current.disk = Some(fingerprint.clone());
                }
            } else if matches!(found, Probe::Missing) {
                row.current.disk = None;
            }
            if stored.as_ref() != Some(&row) {
                self.ledger.put_file(&id, &row)?;
            }
            rows.insert(id, row);
        }
        Ok(held)
    }

    /// A file the ledger knows, with the size and time it had when the App
    /// last read or wrote it, is not read again.
    fn probe(
        &self,
        rel: &str,
        owners: &BTreeMap<String, BTreeSet<BodyDocId>>,
        rows: &BTreeMap<BodyDocId, Row>,
    ) -> Probe {
        if let Some(ids) = owners.get(rel)
            && ids.len() == 1
            && let Some(id) = ids.first()
            && let Some(row) = rows.get(id)
            && row.outgoing.is_none()
            && row.applying.is_none()
            && row.current.path == rel
            && let Some(known) = &row.current.disk
            && let Ok(path) = disk::checked(&self.dir, rel, false)
            && disk::stat(&path).ok().flatten() == Some(known.stat)
        {
            return Probe::Same(id.clone(), known.clone());
        }
        scan(&self.dir, rel, self.options.settle)
    }

    /// Settle a write (App → file) or a merge (file → App) the ledger saw
    /// start but not finish. `Some`: the file is neither what was there
    /// nor what was being written or merged.
    fn pending(
        &mut self,
        project: &Project,
        id: &BodyDocId,
        row: &mut Row,
        probes: &BTreeMap<String, Probe>,
    ) -> Result<Option<Stale>> {
        let mut stale = None;
        if let Some(outgoing) = row.outgoing.take() {
            match probes.get(&outgoing.path) {
                Some(Probe::Young | Probe::Unsafe) => row.outgoing = Some(outgoing),
                Some(found) => match found.fingerprint() {
                    Some(f) if Some(f.sha.as_str()) == outgoing.sha() => row.current = outgoing,
                    Some(f)
                        if outgoing.path == row.current.path
                            && Some(f.sha.as_str()) != row.current.sha() =>
                    {
                        stale = Some(Stale {
                            path: outgoing.path,
                            sha: f.sha.clone(),
                        });
                    }
                    // The old file, or none: the write did not land.
                    _ => {}
                },
                None => {}
            }
        }
        if let Some(applying) = row.applying.take() {
            let at = applying
                .path
                .clone()
                .unwrap_or_else(|| row.current.path.clone());
            match probes.get(&at).and_then(Probe::fingerprint) {
                // The same file: the merge replays and finishes.
                Some(f) if f.sha == applying.sha => row.applying = Some(applying),
                Some(f) if Some(f.sha.as_str()) != row.current.sha() && stale.is_none() => {
                    if self.landed(id, &applying)? {
                        self.finish_landed(project, id, &applying)?;
                    }
                    stale = Some(Stale {
                        path: at,
                        sha: f.sha.clone(),
                    });
                }
                None if matches!(probes.get(&at), Some(Probe::Young | Probe::Unsafe)) => {
                    row.applying = Some(applying);
                }
                _ => {}
            }
        }
        Ok(stale)
    }

    /// Whether the body already holds the merge `applying` started.
    fn landed(&self, id: &BodyDocId, applying: &Applying) -> Result<bool> {
        let Some(at) = applying
            .frontiers
            .as_deref()
            .and_then(|bytes| Frontiers::decode(bytes).ok())
        else {
            return Ok(false);
        };
        let raw = read_copy(self.ws.library(), &DocId::Body(id.clone()))?;
        let vv = raw.oplog_vv();
        Ok(at.iter().all(|point| vv.includes_id(point)))
    }

    /// The side effects of a merge that landed before the crash.
    fn finish_landed(&self, project: &Project, id: &BodyDocId, applying: &Applying) -> Result<()> {
        apply::record_conflicts(
            self.ws,
            &project.book,
            id,
            &applying.conflicts,
            &self.options.author,
            &self.options.conflict,
        )?;
        apply::project_comments(self.ws, id, self.options.marker)?;
        Ok(())
    }

    fn new_row(
        &self,
        project: &Project,
        layout: &BookLayout,
        file: &ProseFile,
        extra: String,
    ) -> Result<Row> {
        let doc = DocId::Body(file.id.clone());
        // The stored head names the version without loading the body.
        let base = match self.ws.library().head(&doc.to_string())? {
            Some(head) => head.frontiers,
            None => read_copy(self.ws.library(), &doc)?.oplog_frontiers(),
        };
        let links = FileLinks::new(&file.path, &layout.assets);
        let (template, fields) = project
            .headers(&file.id, layout, &links, self.options)
            .ok_or_else(|| SyncError::Invalid("prose module left the active template".into()))?;
        Ok(Row {
            current: Version {
                path: file.path.clone(),
                disk: None,
                projected: false,
                base: base.encode(),
                epoch: project.epoch.clone(),
                template,
                restore: project.restore(&file.id),
                fields,
                asset_links: Vec::new(),
                extra,
                retired: false,
            },
            outgoing: None,
            applying: None,
        })
    }

    fn read_change(
        &mut self,
        project: &Project,
        destinations: &[&AssetFile],
        planned: &ProseFile,
        input: &ReadFile,
        source: &str,
        row: &mut Row,
    ) -> Result<bool> {
        let ws = self.ws;
        ws.with_book_lease(&project.book, || {
            self.read_change_leased(project, destinations, planned, input, source, row)
        })
    }

    // The body and its conflict/field receipts complete under one book
    // lease. Otherwise a trash immediately after body import can prevent
    // those receipts from being recorded even though the text landed.
    fn read_change_leased(
        &mut self,
        project: &Project,
        destinations: &[&AssetFile],
        planned: &ProseFile,
        input: &ReadFile,
        source: &str,
        row: &mut Row,
    ) -> Result<bool> {
        let id = &planned.id;
        let parsed = match &input.parsed {
            Ok(parsed) => parsed,
            Err(problem) => {
                if *problem == Problem::Frontmatter || row.current.disk.is_none() {
                    self.issue(project, Some(id), source, *problem);
                    return Ok(false);
                }
                self.keep_with_issue(project, id, source, *problem)?;
                return self
                    .remove(project, Some(id), source, Some(&input.fingerprint.sha))
                    .inspect(|&removed| {
                        if removed {
                            row.current.disk = None;
                        }
                    });
            }
        };
        let vacant_level = !planned.present && row.current.disk.is_none() && source == planned.path;
        if parsed.id.as_deref() != Some(id.as_str()) && !(vacant_level && parsed.id.is_none()) {
            if row.current.disk.is_none() {
                self.issue(project, Some(id), source, Problem::WrongId);
                return Ok(false);
            }
            self.keep_with_issue(project, id, source, Problem::WrongId)?;
            let removed = self.remove(project, Some(id), source, Some(&input.fingerprint.sha))?;
            if removed {
                row.current.disk = None;
            }
            return Ok(removed);
        }
        if (self.options.composing)() {
            self.wait_composing();
            return Ok(false);
        }
        let doc = DocId::Body(id.clone());
        let raw = read_copy(self.ws.library(), &doc)?;
        let head = raw.oplog_frontiers();
        let Some(base) = row.current.frontiers() else {
            self.issue(project, Some(id), source, Problem::StaleBase);
            return Ok(false);
        };
        let mut assets = row.current.asset_links.clone();
        for &asset in destinations {
            if !assets.iter().any(|old| old.path == asset.path) {
                assets.push(asset.clone());
            }
        }
        let links = FileLinks::new(&row.current.path, &assets);
        let read = body::parse_with(&parsed.body, &links);
        let names = if self.ws.auto_links() {
            Some(
                self.ws
                    .book_link_matcher(project.book.as_str(), id.entry().as_str())?,
            )
        } else {
            None
        };
        let peer = merge::merge_peer(&doc, &base, &input.bytes);
        let merged = match merge::merge_with(
            &raw,
            &doc,
            &base,
            &read.paragraphs,
            peer,
            names.as_deref(),
            &links,
        )? {
            Ok(merged) => merged,
            Err(refusal) => {
                let problem = match refusal {
                    Refusal::Emptied => Problem::Emptied,
                    Refusal::UnknownBase => Problem::StaleBase,
                };
                self.keep_with_issue(project, id, source, problem)?;
                let removed =
                    self.remove(project, Some(id), source, Some(&input.fingerprint.sha))?;
                if removed {
                    row.current.disk = None;
                }
                return Ok(removed);
            }
        };
        let edits = parsed.edits(&row.current.fields);
        if !project::check_active(self.ws.library(), &project.book, id, &row.current)? {
            self.wait();
            return Ok(false);
        }
        if merged.needs_snapshot() && !merged.update.is_empty() {
            apply::save_before_removal(self.ws, &project.book, id)?;
        }
        let body_changed = !merged.update.is_empty();
        if body_changed {
            row.applying = Some(Applying {
                sha: input.fingerprint.sha.clone(),
                conflicts: merged.conflicts.clone(),
                path: (source != row.current.path).then(|| source.to_owned()),
                frontiers: Some(merged.frontiers.encode()),
            });
            self.ledger.put_file(id, row)?;
        }
        // Checked again under the book's lease, right before the commit: a
        // composition can start while the merge is worked out.
        match project::import(
            self.ws,
            &project.book,
            id,
            &row.current,
            head,
            merged.update,
            &self.options.composing,
        )? {
            Imported::Done => {}
            Imported::Stale => {
                row.applying = None;
                self.wait();
                return Ok(false);
            }
            Imported::Composing => {
                row.applying = None;
                self.wait_composing();
                return Ok(false);
            }
        }
        if body_changed || merged.replayed {
            if let Some(applied) = row
                .applying
                .as_ref()
                .filter(|a| a.sha == input.fingerprint.sha)
            {
                apply::record_conflicts(
                    self.ws,
                    &project.book,
                    id,
                    &applied.conflicts,
                    &self.options.author,
                    &self.options.conflict,
                )?;
            }
            apply::project_comments(self.ws, id, self.options.marker)?;
            if body_changed {
                self.report.merged.push(doc.to_string());
            }
        }
        row.applying = None;
        let conflicts = apply::apply_fields(
            self.ws,
            &project.book,
            id,
            &row.current.template,
            &edits.fields,
        )?;
        let mut problems = Vec::new();
        if !conflicts.is_empty() {
            problems.push(Problem::FieldConflict);
        }
        if edits.read_only_changed {
            problems.push(Problem::ReadOnly);
        }
        for issue in read.issues {
            problems.push(match issue {
                BodyIssue::MalformedTable => Problem::MalformedTable,
                BodyIssue::UnknownImage => Problem::UnknownImage,
            });
        }
        if source != row.current.path {
            problems.push(Problem::Moved);
        }
        if !problems.is_empty() {
            // One preserved source can explain several outstanding notices.
            let kept = self.keep(source)?;
            for problem in problems {
                self.record_kept(project, Some(id), source, problem, kept.clone())?;
            }
        }
        row.current.path = source.into();
        row.current.disk = Some(input.fingerprint.clone());
        row.current.projected = false;
        row.current.base = merged.frontiers.encode();
        row.current.extra = parsed.extra(&row.current.fields);
        Ok(true)
    }

    fn take_away(&mut self, project: &Project, id: &BodyDocId, file: &Version) -> Result<bool> {
        if file.disk.is_none() {
            return Ok(true);
        }
        let path = disk::checked(&self.dir, &file.path, false)?;
        let actual = disk::hash(&path)?;
        if actual.as_deref() != file.sha() && actual.is_some() {
            if project.accepts(id, file) {
                self.wait();
                return Ok(false);
            }
            self.keep_with_issue(project, id, &file.path, Problem::StaleBase)?;
        }
        self.remove(project, Some(id), &file.path, actual.as_deref())
    }

    /// Write the body's file when it differs from what the ledger says is
    /// there. Returns the row the ledger now holds for it.
    fn project_file(
        &mut self,
        project: &Project,
        layout: &BookLayout,
        file: &ProseFile,
        prior: Option<Row>,
        assets: &str,
        assets_unchanged: bool,
    ) -> Result<Option<Row>> {
        let extra = prior
            .as_ref()
            .filter(|row| row.current.epoch == project.epoch)
            .map_or_else(String::new, |row| row.current.extra.clone());
        let mut next = self.new_row(project, layout, file, extra.clone())?;
        let id = &file.id;
        if !file.present {
            if prior.as_ref() != Some(&next) {
                self.ledger.put_file(id, &next)?;
            }
            return Ok(Some(next));
        }
        // The durable base is already the current body and its metadata
        // and asset destinations are unchanged. This also skips rendering
        // on the first idle pass after restarting the worker.
        if assets_unchanged
            && let Some(prior) = &prior
            && prior.outgoing.is_none()
            && prior.applying.is_none()
            && prior.current.disk.is_some()
            && prior.current.projected
        {
            let mut known = prior.current.clone();
            known.disk = None;
            known.projected = false;
            known.asset_links.clear();
            if known == next.current {
                return Ok(Some(prior.clone()));
            }
        }
        // This process rendered exactly this version to this file already.
        if let Some(prior) = &prior
            && prior.outgoing.is_none()
            && prior.applying.is_none()
            && prior.current.path == file.path
            && self.cache.borrow().rendered.get(id).is_some_and(|done| {
                done.version == next.current
                    && done.assets == assets
                    && prior.current.sha() == Some(done.sha.as_str())
            })
        {
            return Ok(Some(prior.clone()));
        }
        let key = next.current.clone();
        let doc = DocId::Body(id.clone());
        let raw = read_copy(self.ws.library(), &doc)?;
        next.current.base = raw.oplog_frontiers().encode();
        let links = FileLinks::new(&file.path, &layout.assets);
        #[cfg(test)]
        RENDERS.set(RENDERS.get() + 1);
        let (body, asset_links) = render_prose(&raw, &doc, &links)?;
        next.current.asset_links = asset_links;
        let markdown = match file::render(id, &next.current.fields, &extra, &body) {
            Ok(markdown) => markdown,
            Err(_) => {
                self.issue(project, Some(id), &file.path, Problem::Frontmatter);
                return Ok(prior);
            }
        };
        let desired = disk::sha256_hex(markdown.as_bytes());
        next.current.projected = true;
        let known = prior
            .as_ref()
            .filter(|r| r.current.path == file.path)
            .and_then(|r| r.current.disk.clone());
        let expected = known.as_ref().map(|f| f.sha.clone());
        if expected.as_deref() == Some(desired.as_str()) {
            // What the ingest saw there, bytes and time together.
            next.current.disk = known;
        } else {
            if !project::check_active(self.ws.library(), &project.book, id, &next.current)? {
                self.wait();
                return Ok(prior);
            }
            // The old row survives a failed CAS. A completed write whose
            // acknowledgment was interrupted is distinguishable after restart.
            let mut pre = prior.clone().unwrap_or_else(|| next.clone());
            let mut intended = next.current.clone();
            intended.disk = Some(Fingerprint {
                sha: desired.clone(),
                stat: disk::Stat {
                    size: markdown.len() as u64,
                    mtime: 0,
                },
            });
            pre.outgoing = Some(intended);
            self.ledger.put_file(id, &pre)?;
            let installed = match disk::write_checked(
                &self.dir,
                &file.path,
                expected.as_deref(),
                markdown.as_bytes(),
                false,
            ) {
                Ok(installed) => installed,
                Err(err) if raced(&err) => {
                    // Refused before anything was installed: an outside
                    // save is there, for the next pass to read.
                    pre.outgoing = None;
                    self.ledger.put_file(id, &pre)?;
                    self.wait();
                    return Ok(Some(pre));
                }
                Err(err) if unsafe_io(&err) => {
                    self.unsafe_issue(project, Some(id), &file.path, &err)?;
                    return Ok(Some(pre));
                }
                Err(err) => return Err(err.into()),
            };
            self.keep_displaced(
                project,
                Some(id),
                &file.path,
                installed.displaced.as_deref(),
            )?;
            if !installed.published {
                pre.outgoing = None;
                self.ledger.put_file(id, &pre)?;
                self.wait();
                return Ok(Some(pre));
            }
            self.report.written += 1;
            next.current.disk = Some(Fingerprint {
                sha: desired.clone(),
                stat: installed.stat,
            });
        }
        self.cache.borrow_mut().rendered.insert(
            id.clone(),
            Rendered {
                version: key,
                assets: assets.into(),
                sha: desired,
            },
        );
        if prior.as_ref() != Some(&next) {
            self.ledger.put_file(id, &next)?;
        }
        Ok(Some(next))
    }

    fn keep(&mut self, rel: &str) -> Result<PathBuf> {
        let saved = disk::preserve_file(&self.dir, rel, &self.stamp)?;
        self.report.preserved.push(saved.clone());
        Ok(saved)
    }

    fn remove(
        &mut self,
        project: &Project,
        id: Option<&BodyDocId>,
        rel: &str,
        expected: Option<&str>,
    ) -> Result<bool> {
        let path = disk::checked(&self.dir, rel, false)?;
        let Some(expected) = expected else {
            return Ok(true);
        };
        match disk::remove_checked(&path, expected) {
            Ok(displaced) => {
                self.keep_displaced(project, id, rel, displaced.as_deref())?;
                Ok(true)
            }
            Err(err) if raced(&err) || err.kind() == std::io::ErrorKind::NotFound => {
                self.wait();
                Ok(false)
            }
            Err(err) if unsafe_io(&err) => {
                self.unsafe_issue(project, id, rel, &err)?;
                Ok(false)
            }
            Err(err) => Err(err.into()),
        }
    }

    fn rename_folder(&mut self, root: &Path, title: &str, row: &mut ProjectRow) -> Result<()> {
        if row.title == title {
            return Ok(());
        }
        let taken = occupied(root, Some(&row.folder))?;
        let new = layout::project_folder_name(title, &row.names, taken.iter().map(String::as_str));
        if new != row.folder {
            let to = disk::checked(root, &new, false)?;
            row.renaming = Some(new.clone());
            self.ledger.put_project(row)?;
            if !to.exists() || layout::name_key(&row.folder) == layout::name_key(&new) {
                fs::rename(&self.dir, &to)?;
                dr_store::file_io::sync_directory(root)?;
                for issue in &mut self.report.issues {
                    if let Ok(rel) = issue.path.strip_prefix(&self.dir) {
                        issue.path = to.join(rel);
                    }
                    if let Some(kept) = &mut issue.kept
                        && let Ok(rel) = kept.strip_prefix(&self.dir)
                    {
                        *kept = to.join(rel);
                    }
                }
                for kept in &mut self.report.preserved {
                    if let Ok(rel) = kept.strip_prefix(&self.dir) {
                        *kept = to.join(rel);
                    }
                }
                self.dir = to;
                row.folder = new;
            } else {
                self.wait();
                return Ok(());
            }
        }
        row.renaming = None;
        row.title = title.into();
        Ok(())
    }
}

struct ReadFile {
    fingerprint: Fingerprint,
    bytes: Vec<u8>,
    parsed: std::result::Result<file::Parsed, Problem>,
}

/// A file a pending write or merge left as neither of its versions.
struct Stale {
    path: String,
    sha: String,
}

enum Probe {
    Missing,
    Young,
    Unsafe,
    File(Box<ReadFile>),
    /// Unchanged since the App last read or wrote it for this body: not read.
    Same(BodyDocId, Fingerprint),
}

impl Probe {
    fn fingerprint(&self) -> Option<&Fingerprint> {
        match self {
            Self::File(file) => Some(&file.fingerprint),
            Self::Same(_, known) => Some(known),
            _ => None,
        }
    }

    /// The body the file says it belongs to.
    fn claimed(&self) -> Option<BodyDocId> {
        match self {
            Self::File(file) => file
                .parsed
                .as_ref()
                .ok()
                .and_then(|p| p.id.as_deref())
                .and_then(|id| BodyDocId::parse(id).ok()),
            Self::Same(id, _) => Some(id.clone()),
            _ => None,
        }
    }
}

fn scan(root: &Path, rel: &str, settle: std::time::Duration) -> Probe {
    let Ok(path) = disk::checked(root, rel, false) else {
        return Probe::Unsafe;
    };
    let fresh = |modified| {
        SystemTime::now()
            .duration_since(modified)
            .is_ok_and(|elapsed| elapsed < settle)
    };
    match disk::read(&path) {
        Ok(None) => Probe::Missing,
        Ok(Some((bytes, modified, stat))) => {
            #[cfg(test)]
            READS.set(READS.get() + 1);
            if fresh(modified) {
                return Probe::Young;
            }
            let sha = disk::sha256_hex(&bytes);
            let parsed = std::str::from_utf8(&bytes)
                .map_err(|_| Problem::NotUtf8)
                .and_then(|text| file::parse(text).map_err(|_| Problem::Frontmatter));
            Probe::File(Box::new(ReadFile {
                fingerprint: Fingerprint { sha, stat },
                bytes,
                parsed,
            }))
        }
        Err(err) if raced(&err) => Probe::Young,
        Err(err) if err.kind() == io::ErrorKind::FileTooLarge => {
            if fs::symlink_metadata(&path)
                .ok()
                .and_then(|m| m.modified().ok())
                .is_some_and(fresh)
            {
                return Probe::Young;
            }
            match (disk::hash(&path), disk::stat(&path)) {
                (Ok(Some(sha)), Ok(Some(stat))) => Probe::File(Box::new(ReadFile {
                    fingerprint: Fingerprint { sha, stat },
                    bytes: Vec::new(),
                    parsed: Err(Problem::TooLarge),
                })),
                _ => Probe::Unsafe,
            }
        }
        Err(_) => Probe::Unsafe,
    }
}

pub(crate) fn disk_markdown(
    root: &Path,
    rel: &str,
    contents: &str,
) -> io::Result<BTreeSet<String>> {
    let dir = if rel.is_empty() {
        root.to_path_buf()
    } else {
        disk::checked(root, rel, false)?
    };
    let mut files = BTreeSet::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if name.starts_with('.') || ty.is_symlink() {
            continue;
        }
        let path = if rel.is_empty() {
            name
        } else {
            format!("{rel}/{name}")
        };
        if ty.is_dir() {
            files.extend(disk_markdown(root, &path, contents)?);
        } else if ty.is_file()
            && path != contents
            && Path::new(&path)
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("md"))
        {
            files.insert(path);
        }
    }
    Ok(files)
}

fn raced(err: &io::Error) -> bool {
    matches!(
        err.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::AlreadyExists
    )
}

fn unsafe_io(err: &io::Error) -> bool {
    matches!(
        err.kind(),
        io::ErrorKind::PermissionDenied | io::ErrorKind::NotADirectory
    )
}
