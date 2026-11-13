//! A durable, explicitly separate import destination. No active Workspace
//! enters the worker; import_with opens one store without a deriver, closes it,
//! and only then the normal index is rebuilt in a separate open/close cycle.
use std::path::{Path, PathBuf};

use dr_import_v1::{
    ImportError,
    gate::Accept,
    locate::Picked,
    progress::Progress,
    run::{self, Cancel, Options, Outcome},
    v3::MappingChoices,
};
use serde::{Deserialize, Serialize};

/// A development reimport writes book format 4 (`kernel-v4.md`). A target or
/// a pending record of an earlier format (`reimport-v3-…`) is left as it is
/// and never resumed.
const PREFIX: &str = "reimport-v4-";
const PENDING: &str = "reimport-v4-pending.json";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Destination {
    pub data: PathBuf,
    pub id: String,
    pub original: PathBuf,
    pub database: PathBuf,
    pub source_root: PathBuf,
    pub left: Vec<String>,
    pub choices: MappingChoices,
    pub completed: bool,
}
impl Destination {
    pub fn target(&self) -> PathBuf {
        self.data.join(&self.id)
    }
    fn manifest(&self) -> PathBuf {
        self.data.join(format!("{}.json", self.id))
    }
    fn validate(&self) -> Result<(), String> {
        if !self.id.starts_with(PREFIX)
            || !self
                .id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        {
            return Err("invalid import destination identity".into());
        }
        let data = self.data.canonicalize().map_err(|e| e.to_string())?;
        let original = self.original.canonicalize().map_err(|e| e.to_string())?;
        let source = self.source_root.canonicalize().map_err(|e| e.to_string())?;
        let target = data.join(&self.id);
        if self.target().is_symlink() {
            return Err("import target must not be a symlink".into());
        }
        if target.starts_with(&source)
            || source.starts_with(&target)
            || target.starts_with(&original)
            || original.starts_with(&target)
        {
            return Err("reimport requires a new destination".into());
        }
        Ok(())
    }
    pub fn prepare(original: &Path, picked: &Picked) -> Result<Self, String> {
        let data = original
            .parent()
            .ok_or("library has no data directory")?
            .to_path_buf();
        let registry = registry(&data, original)?;
        if !registry.is_active_local() || registry.active_library_dir(&data) != original {
            return Err("development reimport requires the active local library".into());
        }
        let pointer = data.join(PENDING);
        if pointer.is_file() {
            let id: String =
                serde_json::from_slice(&std::fs::read(&pointer).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            if !id.starts_with(PREFIX)
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            {
                return Err("invalid pending import identity".into());
            }
            let job: Self = serde_json::from_slice(
                &std::fs::read(data.join(format!("{id}.json"))).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            if job.data != data {
                return Err("pending import belongs to another data directory".into());
            }
            let registered = registry.entries.iter().any(|e| e.id == job.id);
            if !registered {
                job.validate()?;
            }
            if !registered && job.database == picked.database && job.source_root == picked.root {
                if job.original != original {
                    return Err("pending import was started from a different library".into());
                }
                return Ok(job);
            }
        }
        let job = Self {
            data,
            id: format!("{PREFIX}{}", dr_model::id::new_uuid_v7()),
            original: original.to_path_buf(),
            database: picked.database.clone(),
            source_root: picked.root.clone(),
            left: picked.left.clone(),
            choices: MappingChoices::default(),
            completed: false,
        };
        job.validate()?;
        if job.target().exists() || job.manifest().exists() {
            return Err("import destination already exists".into());
        }
        Ok(job)
    }
    /// Read only the local resume record at startup. The source may have
    /// moved; choosing a source again still performs full path validation.
    pub fn unfinished(original: &Path) -> Result<Option<Self>, String> {
        let data = original.parent().ok_or("library has no data directory")?;
        let pointer = data.join(PENDING);
        if !pointer.is_file() {
            return Ok(None);
        }
        let id: String =
            serde_json::from_slice(&std::fs::read(pointer).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        if !id.starts_with(PREFIX)
            || !id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        {
            return Err("invalid pending import identity".into());
        }
        let job: Self = serde_json::from_slice(
            &std::fs::read(data.join(format!("{id}.json"))).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        if job.data != data || job.id != id {
            return Err("pending import belongs to another library".into());
        }
        if job.original != original {
            return Ok(None);
        }
        let registered = registry(&job.data, original)?
            .entries
            .iter()
            .any(|e| e.id == job.id);
        Ok((!registered).then_some(job))
    }
    pub fn picked(&self) -> Picked {
        Picked {
            database: self.database.clone(),
            root: self.source_root.clone(),
            id: None,
            left: self.left.clone(),
        }
    }
    pub fn set_choices(&mut self, choices: MappingChoices) -> Result<(), String> {
        if self.manifest().is_file()
            && serde_json::to_vec(&self.choices).map_err(|e| e.to_string())?
                != serde_json::to_vec(&choices).map_err(|e| e.to_string())?
        {
            return Err(
                "an interrupted import must resume with the same explicit MappingChoices".into(),
            );
        }
        self.choices = choices;
        Ok(())
    }
    fn save(&self) -> Result<(), String> {
        self.validate()?;
        atomic_json(&self.manifest(), self)?;
        if !self.completed {
            atomic_json(&self.data.join(PENDING), &self.id)?;
        }
        Ok(())
    }
    /// The selected target is already closed. Persist the preferred local
    /// directory only after it can open normally. Keep every previous entry.
    pub fn open_target(
        &self,
        old: &Path,
        options: dr_store::LibraryOptions,
    ) -> Result<dr_store::Library, String> {
        self.validate()?;
        if old != self.original {
            return Err("the active library changed during import; target was preserved".into());
        }
        if !self.completed {
            return Err("the target import has not completed".into());
        }
        dr_store::Library::open(self.target(), options).map_err(|e| e.to_string())
    }
    pub fn commit_selection(&self, library: &dr_workspace::Workspace) -> Result<(), String> {
        self.validate()?;
        if library.library().paths().root != self.target() {
            return Err("prepared target does not match the import".into());
        }
        let mut registry = registry(&self.data, &self.original)?;
        if !registry.is_active_local() || registry.active_library_dir(&self.data) != self.original {
            return Err("active library selection changed; target was preserved".into());
        }
        if registry
            .entries
            .iter()
            .any(|e| e.id == self.id || e.path == self.id)
        {
            return Err("import destination is already registered".into());
        }
        registry.entries.insert(
            0,
            dr_account::LibraryEntry {
                id: self.id.clone(),
                path: self.id.clone(),
                owner: dr_account::LibraryOwner::Local,
                created_at: dr_store::now_ms() as u64,
            },
        );
        registry.active_id = self.id.clone();
        registry.save(&self.data)
    }
}
fn registry(data: &Path, original: &Path) -> Result<dr_account::LibraryRegistry, String> {
    if data.join(dr_account::LIBRARIES_FILE).is_file() {
        return dr_account::LibraryRegistry::load_or_init(data);
    }
    if original.file_name().and_then(|s| s.to_str()) != Some("library") {
        return Err(
            "unregistered library ownership; only a registered local library can be reimported"
                .into(),
        );
    }
    let mut registry = dr_account::LibraryRegistry::default_local();
    registry.entries[0].path = original
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("invalid local library path")?
        .into();
    Ok(registry)
}
fn atomic_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    let temp = path.with_extension("tmp");
    std::fs::write(&temp, bytes)
        .and_then(|_| std::fs::rename(&temp, path))
        .map_err(|e| e.to_string())
}
pub enum ResultOfImport {
    Blocked(dr_import_v1::gate::Gate),
    Cancelled,
    Imported {
        job: Box<Destination>,
        receipt: Box<dr_import_v1::receipt::Receipt>,
        timing: run::Timing,
    },
}
pub fn import(
    mut job: Destination,
    version: &str,
    accept: Accept,
    cancel: Cancel,
    progress: &mut dyn FnMut(&Progress),
) -> Result<ResultOfImport, ImportError> {
    job.validate().map_err(ImportError::Invalid)?;
    // Validate before even recording this job or touching a device identity.
    // Actual import stages and validates again: this is not write authorization.
    let staging = tempfile::tempdir_in(&job.data)?;
    let (_, legacy, _, gate) = run::analyse(&job.database, staging.path())?;
    let pending = dr_import_v1::v3::pending(&legacy, &job.choices)?;
    if !pending.is_empty() {
        return Err(ImportError::V3Pending(pending));
    }
    if cancel.requested() {
        return Ok(ResultOfImport::Cancelled);
    }
    if !gate.allows(accept) {
        return Ok(ResultOfImport::Blocked(gate));
    }
    drop(legacy);
    drop(staging);
    job.save().map_err(ImportError::Invalid)?;
    let mut options = Options::new(version);
    options.v3 = job.choices.clone();
    options.old_root = Some(job.source_root.clone());
    options.device_dir = Some(job.data.clone());
    options.accept = accept;
    options.cancel = cancel;
    let (outcome, timing) = run::import_with(&job.database, &job.target(), &options, progress)?;
    match outcome {
        Outcome::Blocked(gate) => Ok(ResultOfImport::Blocked(gate)),
        Outcome::Cancelled => Ok(ResultOfImport::Cancelled),
        Outcome::Imported(receipt) => {
            job.completed = !receipt.cancelled
                && receipt
                    .books
                    .iter()
                    .all(|b| matches!(b.status.as_str(), "imported" | "already-imported"));
            job.save().map_err(ImportError::Invalid)?;
            Ok(ResultOfImport::Imported {
                job: Box::new(job),
                receipt,
                timing,
            })
        }
    }
}
