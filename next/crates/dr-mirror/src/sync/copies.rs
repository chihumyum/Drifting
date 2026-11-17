use std::collections::BTreeMap;
use std::fs;
use std::io;

use dr_store::asset::Variant;

use crate::{
    disk,
    layout::BookLayout,
    ledger::{CopyRow, ProjectRow},
};

use super::{BookPass, Problem, Project, Result, raced, unsafe_io};

impl BookPass<'_> {
    pub(super) fn copies(
        &mut self,
        project: &Project,
        layout: &BookLayout,
        book: &mut ProjectRow,
    ) -> Result<()> {
        let mut desired = BTreeMap::new();
        desired.insert(
            "contents".into(),
            Copy {
                rel: &layout.contents_path,
                sha: disk::sha256_hex(layout.contents.as_bytes()),
                data: Source::Contents(layout.contents.as_bytes()),
            },
        );
        for asset in layout.assets.iter().filter(|file| file.present) {
            let Some(source) = self
                .ws
                .library()
                .asset(asset.id.as_str(), Variant::Source)?
            else {
                continue;
            };
            if source.book_id != project.book.as_str() {
                continue;
            }
            desired.insert(
                format!("asset:{}", asset.id),
                Copy {
                    rel: &asset.path,
                    sha: source.sha256,
                    data: Source::Asset(source.path),
                },
            );
        }
        let obsolete: Vec<_> = book
            .copies
            .iter()
            .filter(|(key, row)| desired.get(*key).is_none_or(|next| next.rel != row.path))
            .map(|(key, row)| (key.clone(), row.clone()))
            .collect();
        for (key, row) in obsolete {
            if self.remove_copy(project, &row, key == "contents")? {
                book.copies.remove(&key);
            }
        }
        for (key, copy) in desired {
            if book
                .copies
                .get(&key)
                .is_some_and(|prev| prev.path != copy.rel)
            {
                continue;
            }
            if let Some(row) = self.write_copy(project, &copy, book.copies.get(&key))? {
                book.copies.insert(key, row);
            }
        }

        for rel in book
            .directories
            .iter()
            .rev()
            .filter(|rel| !layout.directories.contains(*rel))
        {
            if let Ok(path) = disk::checked(&self.dir, rel, false) {
                let _ = fs::remove_dir(path);
            }
        }
        for rel in &layout.directories {
            let path = disk::checked(&self.dir, rel, true)?;
            match fs::create_dir(&path) {
                Ok(()) => {}
                Err(err)
                    if err.kind() == io::ErrorKind::AlreadyExists
                        && fs::symlink_metadata(path)?.is_dir() => {}
                Err(err) if unsafe_io(&err) => self.issue(project, None, rel, Problem::UnsafePath),
                Err(err) => return Err(err.into()),
            }
        }
        book.directories = layout.directories.clone();
        book.assets = layout.assets.clone();
        Ok(())
    }

    fn remove_copy(&mut self, project: &Project, row: &CopyRow, index: bool) -> Result<bool> {
        let path = match disk::checked(&self.dir, &row.path, false) {
            Ok(path) => path,
            Err(_) => {
                self.issue(project, None, &row.path, Problem::UnsafePath);
                return Ok(false);
            }
        };
        let actual = disk::hash(&path)?;
        if !index && actual.as_deref().is_some_and(|sha| sha != row.sha) {
            self.keep(&row.path)?;
        }
        self.remove(project, None, &row.path, actual.as_deref())
    }

    fn write_copy(
        &mut self,
        project: &Project,
        copy: &Copy<'_>,
        prior: Option<&CopyRow>,
    ) -> Result<Option<CopyRow>> {
        let path = match disk::checked(&self.dir, copy.rel, false) {
            Ok(path) => path,
            Err(_) => {
                self.issue(project, None, copy.rel, Problem::UnsafePath);
                return Ok(None);
            }
        };
        // The copy the ledger knows, at the size and time it had then.
        if let Some(prior) = prior
            && prior.sha == copy.sha
            && prior.stat.is_some()
            && disk::stat(&path).ok().flatten() == prior.stat
        {
            return Ok(Some(prior.clone()));
        }
        let (actual, seen) = match disk::hash_with_stat(&path) {
            Ok(Some((sha, stat))) => (Some(sha), Some(stat)),
            Ok(None) => (None, None),
            Err(err) if unsafe_io(&err) => {
                self.issue(project, None, copy.rel, Problem::UnsafePath);
                return Ok(None);
            }
            Err(err) if raced(&err) => {
                self.wait();
                return Ok(None);
            }
            Err(err) => return Err(err.into()),
        };
        let index = matches!(copy.data, Source::Contents(_));
        let mut stat = seen;
        if actual.as_deref() != Some(copy.sha.as_str()) {
            if !index && let Some(actual) = actual.as_deref() {
                let Some(prior) = prior else {
                    self.issue(project, None, copy.rel, Problem::Occupied);
                    return Ok(None);
                };
                if actual != prior.sha {
                    self.keep(copy.rel)?;
                }
            }
            let result = match &copy.data {
                Source::Contents(bytes) => {
                    disk::write_checked(&self.dir, copy.rel, actual.as_deref(), bytes, true)
                }
                Source::Asset(src) => {
                    disk::copy_checked(src, &self.dir, copy.rel, actual.as_deref(), true)
                }
            };
            let installed = match result {
                Ok(installed) => installed,
                Err(err) if raced(&err) => {
                    self.wait();
                    return Ok(None);
                }
                Err(err) if unsafe_io(&err) => {
                    self.unsafe_issue(project, None, copy.rel, &err)?;
                    return Ok(None);
                }
                Err(err) => return Err(err.into()),
            };
            self.keep_displaced(project, None, copy.rel, installed.displaced.as_deref())?;
            if !installed.published {
                self.wait();
                return Ok(None);
            }
            stat = Some(installed.stat);
            self.report.written += 1;
        }
        Ok(Some(CopyRow {
            path: copy.rel.into(),
            sha: copy.sha.clone(),
            stat,
        }))
    }
}

struct Copy<'a> {
    rel: &'a str,
    sha: String,
    data: Source<'a>,
}

enum Source<'a> {
    Contents(&'a [u8]),
    Asset(std::path::PathBuf),
}
