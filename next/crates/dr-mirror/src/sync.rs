//! A single pass reads external edits before projecting local changes. Paths
//! only identify files inside the claimed project folder and the active
//! manifest, and every replacement checks the bytes learned by the pass.

mod copies;
mod project;

use std::collections::{BTreeMap, BTreeSet};
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
    ledger::{Applying, Fingerprint, Ledger, ProjectRow, Row, Version},
    merge::{self, Refusal},
};

use self::project::{Project, read_copy, render_prose};

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
}

#[derive(Debug, Default)]
pub struct Report {
    pub merged: Vec<String>,
    pub written: usize,
    pub preserved: Vec<PathBuf>,
    pub issues: Vec<Issue>,
    pub waiting: bool,
}

impl Report {
    pub(crate) fn join(&mut self, other: Self) {
        self.merged.extend(other.merged);
        self.written += other.written;
        self.preserved.extend(other.preserved);
        self.issues.extend(other.issues);
        self.waiting |= other.waiting;
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

pub struct Pass<'a> {
    ws: &'a Workspace,
    options: &'a Options,
}

impl<'a> Pass<'a> {
    pub fn new(ws: &'a Workspace, options: &'a Options) -> Self {
        Self { ws, options }
    }

    fn root(&self) -> Result<PathBuf> {
        Ok(self.options.root.canonicalize()?)
    }

    pub fn folder(&self, book: &BookId) -> Result<Option<PathBuf>> {
        let root = self.root()?;
        Ledger::new(self.ws.library(), book, &root)
            .project()?
            .map(|row| Ok(disk::checked(&root, &row.folder, false)?))
            .transpose()
    }

    pub fn run(&self) -> Result<Report> {
        self.reconcile(|_| true)
    }

    /// The fallback watcher only walks folders already recorded in the
    /// ledger. Files are opened later, by the normal reconciliation pass.
    pub(crate) fn disk_stamp(&self) -> Result<BTreeMap<PathBuf, disk::Stat>> {
        let root = self.root()?;
        let lib = self.ws.library();
        let mut stamp = BTreeMap::new();
        for doc in lib.docs(None, Some("book"))? {
            let Ok(DocId::Book(book)) = DocId::parse(&doc.doc_id) else {
                continue;
            };
            let Some(row) = Ledger::new(lib, &book, &root).project()? else {
                continue;
            };
            let Ok(dir) = disk::checked(&root, &row.folder, false) else {
                continue;
            };
            let Ok(files) = disk_markdown(&dir, "", "") else {
                continue;
            };
            for file in files {
                if let Ok(path) = disk::checked(&dir, &file, false)
                    && let Ok(Some(stat)) = disk::stat(&path)
                {
                    stamp.insert(path, stat);
                }
            }
        }
        Ok(stamp)
    }

    pub(crate) fn reconcile(&self, writeback: impl Fn(&BookId) -> bool) -> Result<Report> {
        let mut report = Report::default();
        for info in self
            .ws
            .run::<BookList>(&Actor::Mirror, ListBooksIn { trashed: false })?
            .output
        {
            let book = BookId::parse(&info.id).map_err(|e| SyncError::Invalid(e.to_string()))?;
            match self.reconcile_book(&book, writeback(&book)) {
                Ok(one) => report.join(one),
                Err(err) => {
                    log::warn!("Markdown folder project pass: {err}");
                    report.issues.push(Issue {
                        book: info.id,
                        doc: None,
                        title: info.name,
                        path: self.options.root.clone(),
                        problem: Problem::Disk,
                    });
                }
            }
        }
        Ok(report)
    }

    pub fn book(&self, book: &BookId) -> Result<Report> {
        self.reconcile_book(book, true)
    }

    fn reconcile_book(&self, book: &BookId, writeback: bool) -> Result<Report> {
        let Some(mut project) = Project::read(self.ws, book)? else {
            return Ok(Report::default());
        };
        let root = self.root()?;
        let ledger = Ledger::new(self.ws.library(), book, &root);
        let mut row = allocate(&root, &ledger, &project.title, &self.options.names)?;
        let dir = disk::checked(&root, &row.folder, false)?;
        let mut state = BookPass {
            ws: self.ws,
            dir,
            ledger,
            options: self.options,
            report: Report::default(),
            stamp: chrono::Local::now()
                .format("%Y-%m-%dT%H-%M-%S-%9f")
                .to_string(),
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
        let layout = project.layout(self.ws.library(), &row.names)?;
        let mut files = state.ledger.files()?;
        let mut held = state.ingest(&project, &layout, &row, &mut files)?;
        if !writeback {
            return Ok(state.report);
        }
        if let Some(latest) = Project::read(self.ws, book)? {
            project = latest;
        } else {
            return Ok(state.report);
        }
        let layout = project.layout(self.ws.library(), &row.names)?;
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
                if !state.take_away(&project, id, &file.current)? {
                    held.insert(id.clone());
                    continue;
                }
                file.current.disk = None;
                file.current.retired = !active.contains_key(id);
                file.outgoing = None;
                file.applying = None;
                state.ledger.put_file(id, file)?;
            }
        }
        for file in &layout.prose {
            if !held.contains(&file.id) {
                state.project_file(&project, &layout, file, files.remove(&file.id))?;
            }
        }
        state.copies(&project, &layout, &mut row)?;
        state.rename_folder(&root, &project.title, &mut row)?;
        state.ledger.put_project(&row)?;
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
}

impl BookPass<'_> {
    fn issue(&mut self, book: &Project, id: Option<&BodyDocId>, rel: &str, problem: Problem) {
        let title = id.map_or(book.title.as_str(), |id| book.title_for(id));
        self.report.issues.push(Issue {
            book: book.book.to_string(),
            doc: id.map(|id| DocId::Body(id.clone()).to_string()),
            title: title.into(),
            path: self.dir.join(rel),
            problem,
        });
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
        for row in rows.values() {
            paths.insert(row.current.path.clone());
            if let Some(out) = &row.outgoing {
                paths.insert(out.path.clone());
            }
        }
        for file in &layout.prose {
            paths.insert(file.path.clone());
        }
        let probes: BTreeMap<_, _> = paths
            .into_iter()
            .map(|p| {
                let state = scan(&self.dir, &p, self.options.settle);
                (p, state)
            })
            .collect();
        let mut by_id: BTreeMap<BodyDocId, Vec<&str>> = BTreeMap::new();
        for (path, state) in &probes {
            if let Probe::File(found) = state
                && let Ok(parsed) = &found.parsed
                && let Some(id) = parsed
                    .id
                    .as_deref()
                    .and_then(|id| BodyDocId::parse(id).ok())
                && desired.contains_key(&id)
            {
                by_id.entry(id).or_default().push(path);
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
            let mut row = match (rows.remove(&id), wanted) {
                (Some(row), _) => row,
                (None, Some(file)) => self.new_row(project, layout, file, String::new())?,
                (None, None) => continue,
            };
            if let Some(outgoing) = row.outgoing.take()
                && probes
                    .get(&outgoing.path)
                    .and_then(Probe::fingerprint)
                    .map(|f| f.sha.as_str())
                    == outgoing.sha()
            {
                row.current = outgoing;
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
                self.report.waiting = true;
                held.insert(id.clone());
                rows.insert(id, row);
                continue;
            }
            let source = if matches!(original, Probe::Missing)
                && previous.disk.is_some()
                && !previous.retired
            {
                let moved = sources
                    .iter()
                    .copied()
                    .filter(|p| !tracked.contains(*p))
                    .collect::<Vec<_>>();
                if moved.len() == 1 && sources.len() == 1 {
                    moved[0]
                } else {
                    path
                }
            } else {
                path
            };
            for duplicate in sources
                .iter()
                .copied()
                .filter(|p| *p != source && *p != path)
            {
                self.issue(project, Some(&id), duplicate, Problem::Duplicate);
            }
            if source == path && matches!(original, Probe::Missing) && sources.len() > 1 {
                held.insert(id.clone());
            }
            let found = probes.get(source).unwrap_or(&Probe::Missing);
            if matches!(found, Probe::Young) {
                self.report.waiting = true;
                held.insert(id.clone());
            } else if let Probe::Unsafe = found {
                self.issue(project, Some(&id), source, Problem::UnsafePath);
                held.insert(id.clone());
            } else if let Probe::File(contents) = found {
                let occupied = previous.disk.is_none()
                    && !previous.retired
                    && wanted.is_some_and(|p| p.present);
                let unsafe_basis = !project.accepts(&id, &previous)
                    || wanted.is_some_and(|p| !p.present && previous.disk.is_some());
                let known_previous = previous.disk.is_some()
                    || previous.retired
                        && matches!(&contents.parsed, Ok(p) if p.id.as_deref() == Some(id.as_str()));
                if occupied {
                    self.issue(project, Some(&id), source, Problem::Occupied);
                    held.insert(id.clone());
                } else if unsafe_basis {
                    if known_previous {
                        if previous.sha() != Some(&contents.fingerprint.sha) {
                            self.issue(project, Some(&id), source, Problem::StaleBase);
                            self.keep(source)?;
                        }
                        if !self.remove(source, Some(&contents.fingerprint.sha))? {
                            held.insert(id.clone());
                        }
                        row.current.disk = None;
                    } else if wanted.is_some() {
                        held.insert(id.clone());
                    }
                } else if previous.sha() != Some(&contents.fingerprint.sha) {
                    let Some(wanted) = wanted else {
                        unreachable!("checked active module")
                    };
                    let accepted =
                        self.read_change(project, &assets, wanted, contents, source, &mut row)?;
                    if !accepted {
                        held.insert(id.clone());
                    }
                } else if source != path {
                    self.issue(project, Some(&id), source, Problem::Moved);
                    row.current.path = source.into();
                }
            } else if matches!(found, Probe::Missing) {
                row.current.disk = None;
            }
            self.ledger.put_file(&id, &row)?;
            rows.insert(id, row);
        }
        Ok(held)
    }

    fn new_row(
        &self,
        project: &Project,
        layout: &BookLayout,
        file: &ProseFile,
        extra: String,
    ) -> Result<Row> {
        let doc = DocId::Body(file.id.clone());
        let raw = read_copy(self.ws.library(), &doc)?;
        let links = FileLinks::new(&file.path, &layout.assets);
        let (template, fields) = project
            .headers(&file.id, layout, &links, self.options)
            .ok_or_else(|| SyncError::Invalid("prose module left the active template".into()))?;
        Ok(Row {
            current: Version {
                path: file.path.clone(),
                disk: None,
                base: raw.oplog_frontiers().encode(),
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
        let id = &planned.id;
        let parsed = match &input.parsed {
            Ok(parsed) => parsed,
            Err(problem) => {
                self.issue(project, Some(id), source, *problem);
                if *problem == Problem::Frontmatter || row.current.disk.is_none() {
                    return Ok(false);
                }
                self.keep(source)?;
                return self
                    .remove(source, Some(&input.fingerprint.sha))
                    .inspect(|&removed| {
                        if removed {
                            row.current.disk = None;
                        }
                    });
            }
        };
        let vacant_level = !planned.present && row.current.disk.is_none() && source == planned.path;
        if parsed.id.as_deref() != Some(id.as_str()) && !(vacant_level && parsed.id.is_none()) {
            self.issue(project, Some(id), source, Problem::WrongId);
            if row.current.disk.is_none() {
                return Ok(false);
            }
            self.keep(source)?;
            let removed = self.remove(source, Some(&input.fingerprint.sha))?;
            if removed {
                row.current.disk = None;
            }
            return Ok(removed);
        }
        if (self.options.composing)() {
            self.report.waiting = true;
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
                self.issue(project, Some(id), source, problem);
                self.keep(source)?;
                let removed = self.remove(source, Some(&input.fingerprint.sha))?;
                if removed {
                    row.current.disk = None;
                }
                return Ok(removed);
            }
        };
        let edits = parsed.edits(&row.current.fields);
        if !project::check_active(self.ws.library(), &project.book, id, &row.current)? {
            self.report.waiting = true;
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
            });
            self.ledger.put_file(id, row)?;
        }
        if !project::import(
            self.ws,
            &project.book,
            id,
            &row.current,
            head,
            merged.update,
        )? {
            self.report.waiting = true;
            return Ok(false);
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
        if !conflicts.is_empty() {
            self.issue(project, Some(id), source, Problem::FieldConflict);
        }
        if edits.read_only_changed {
            self.issue(project, Some(id), source, Problem::ReadOnly);
        }
        for issue in read.issues {
            self.issue(
                project,
                Some(id),
                source,
                match issue {
                    BodyIssue::MalformedTable => Problem::MalformedTable,
                    BodyIssue::UnknownImage => Problem::UnknownImage,
                },
            );
            if issue == BodyIssue::MalformedTable {
                self.keep(source)?;
            }
        }
        if !conflicts.is_empty() {
            self.keep(source)?;
        }
        if source != row.current.path {
            self.issue(project, Some(id), source, Problem::Moved);
        }
        row.current.path = source.into();
        row.current.disk = Some(input.fingerprint.clone());
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
                self.report.waiting = true;
                return Ok(false);
            }
            self.keep(&file.path)?;
            self.issue(project, Some(id), &file.path, Problem::StaleBase);
        }
        self.remove(&file.path, actual.as_deref())
    }

    fn project_file(
        &mut self,
        project: &Project,
        layout: &BookLayout,
        file: &ProseFile,
        prior: Option<Row>,
    ) -> Result<()> {
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
            return Ok(());
        }
        let doc = DocId::Body(id.clone());
        let raw = read_copy(self.ws.library(), &doc)?;
        next.current.base = raw.oplog_frontiers().encode();
        let links = FileLinks::new(&file.path, &layout.assets);
        let (body, asset_links) = render_prose(&raw, &doc, &links)?;
        next.current.asset_links = asset_links;
        let markdown = match file::render(id, &next.current.fields, &extra, &body) {
            Ok(markdown) => markdown,
            Err(_) => {
                self.issue(project, Some(id), &file.path, Problem::Frontmatter);
                return Ok(());
            }
        };
        let desired = disk::sha256_hex(markdown.as_bytes());
        let path = disk::checked(&self.dir, &file.path, false)?;
        let expected = prior
            .as_ref()
            .filter(|r| r.current.path == file.path)
            .and_then(|r| r.current.sha());
        if expected != Some(desired.as_str()) {
            if !project::check_active(self.ws.library(), &project.book, id, &next.current)? {
                self.report.waiting = true;
                return Ok(());
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
            if let Err(err) =
                disk::write_checked(&self.dir, &file.path, expected, markdown.as_bytes(), false)
            {
                if raced(&err) {
                    self.report.waiting = true;
                    return Ok(());
                }
                if unsafe_io(&err) {
                    self.issue(project, Some(id), &file.path, Problem::UnsafePath);
                    return Ok(());
                }
                return Err(err.into());
            }
            self.report.written += 1;
        }
        next.current.disk = disk::stat(&path)?.map(|stat| Fingerprint { sha: desired, stat });
        if prior.as_ref() != Some(&next) {
            self.ledger.put_file(id, &next)?;
        }
        Ok(())
    }

    fn keep(&mut self, rel: &str) -> Result<()> {
        let saved = disk::preserve_file(&self.dir, rel, &self.stamp)?;
        self.report.preserved.push(saved);
        Ok(())
    }

    fn remove(&mut self, rel: &str, expected: Option<&str>) -> Result<bool> {
        let path = disk::checked(&self.dir, rel, false)?;
        if disk::hash(&path)?.as_deref() != expected {
            self.report.waiting = true;
            return Ok(false);
        }
        if expected.is_some() {
            disk::remove(&path, &self.dir)?;
        }
        Ok(true)
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
                fs::rename(&self.dir, to)?;
                dr_store::file_io::sync_directory(root)?;
                row.folder = new;
            } else {
                self.report.waiting = true;
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

enum Probe {
    Missing,
    Young,
    Unsafe,
    File(Box<ReadFile>),
}

impl Probe {
    fn fingerprint(&self) -> Option<&Fingerprint> {
        if let Self::File(file) = self {
            Some(&file.fingerprint)
        } else {
            None
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

fn disk_markdown(root: &Path, rel: &str, contents: &str) -> io::Result<BTreeSet<String>> {
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
