//! A durable, explicitly separate import destination. No active Workspace
//! enters the worker; import_with opens one store without a deriver, closes it,
//! and only then the normal index is rebuilt in a separate open/close cycle.
//!
//! The destination becomes the library of whoever owns the one open now: a new
//! local library, or, while signed in, the account's own library
//! ([`dr_account::LibraryRegistry::adopt_for_account`]). An account is imported
//! into only while it has nothing in the new format, on this device or on the
//! server ([`AccountCheck`]): one device imports for an account, every other
//! device syncs (`m10-import.md`, "登录状态下导入").
use std::path::{Path, PathBuf};

use dr_account::{LIBRARIES_FILE, LibraryEntry, LibraryOwner, LibraryRegistry};

use dr_import_v1::{
    ImportError,
    gate::Accept,
    locate::Picked,
    progress::Progress,
    run::{self, Cancel, Options, Outcome},
    v3::MappingChoices,
};
use serde::{Deserialize, Serialize};

/// A development reimport writes book format 5 (`kernel-v5.md`). A target or
/// a pending record of an earlier format (`reimport-v3-…`, `reimport-v4-…`) is
/// left as it is and never resumed.
const PREFIX: &str = "reimport-v5-";
/// The local library's unfinished import. An account library's is
/// `reimport-v5-pending-<its entry id>.json`, so each library carries on its
/// own ([`pending_pointer`]).
const PENDING: &str = "reimport-v5-pending.json";

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
        let (data, registry) = locate(original)?;
        let pointer = pending_pointer(&data, registry.active_entry())?;
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
            let registered = is_registered(&registry, &job.id);
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
        // Not the active library of a data folder: nothing of ours to resume.
        let Ok((data, registry)) = locate(original) else {
            return Ok(None);
        };
        let pointer = pending_pointer(&data, registry.active_entry())?;
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
        Ok((!is_registered(&registry, &job.id)).then_some(job))
    }

    /// Who the library the import began from belongs to, and so who the
    /// imported library will belong to. Whether it is still the active one is
    /// checked when the import is set up and when it is taken up.
    pub fn owner(&self) -> Result<LibraryOwner, String> {
        Ok(entry_of(&self.data, &self.original)?.owner)
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
            let entry = entry_of(&self.data, &self.original)?;
            atomic_json(&pending_pointer(&self.data, &entry)?, &self.id)?;
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
        let _held = dr_account::registry_lock();
        let (data, mut registry) = locate(&self.original)
            .map_err(|_| "active library selection changed; target was preserved".to_owned())?;
        if data != self.data {
            return Err("active library selection changed; target was preserved".into());
        }
        if is_registered(&registry, &self.id) {
            return Err("import destination is already registered".into());
        }
        match registry.active_entry().owner.clone() {
            LibraryOwner::Local => {
                registry.entries.insert(
                    0,
                    LibraryEntry {
                        id: self.id.clone(),
                        path: self.id.clone(),
                        owner: LibraryOwner::Local,
                        created_at: dr_store::now_ms() as u64,
                    },
                );
                registry.active_id = self.id.clone();
                registry.save(&self.data)
            }
            // The account's library is now this one; the empty one it had
            // stays on disk, unregistered.
            LibraryOwner::Account { subject } => registry
                .adopt_for_account(&self.data, &subject, &self.original, &self.id)
                .map(|_| ()),
        }
    }
}
/// Who owns `library`, while it is the active library of its data folder.
pub fn library_owner(library: &Path) -> Result<LibraryOwner, String> {
    Ok(locate(library)?.1.active_entry().owner.clone())
}
fn is_registered(registry: &LibraryRegistry, id: &str) -> bool {
    registry.entries.iter().any(|e| e.id == id || e.path == id)
}
/// The data folder whose `libraries.json` has `original` as its active
/// library, with that registry: `<data>/library`, `<data>/reimport-v5-…`, or an
/// account's `<data>/libraries/account-…`. Without a registry only
/// `<data>/library`, the local library a fresh data folder starts with, and the
/// registry it would have. Reads only.
fn locate(original: &Path) -> Result<(PathBuf, LibraryRegistry), String> {
    let parent = original.parent().ok_or("library has no data directory")?;
    let mut candidates = vec![parent];
    if parent.file_name().and_then(|s| s.to_str()) == Some("libraries")
        && let Some(data) = parent.parent()
    {
        candidates.push(data);
    }
    for data in candidates {
        if data.join(LIBRARIES_FILE).is_file() {
            let registry = LibraryRegistry::load_or_init(data)?;
            if registry.active_library_dir(data) == original {
                return Ok((data.to_path_buf(), registry));
            }
        }
    }
    if parent.join(LIBRARIES_FILE).is_file() {
        return Err("reimport requires the active library".into());
    }
    if original.file_name().and_then(|s| s.to_str()) != Some(dr_account::DEFAULT_LOCAL_REL_PATH) {
        return Err(
            "unregistered library ownership; only a registered library can be reimported".into(),
        );
    }
    Ok((parent.to_path_buf(), LibraryRegistry::default_local()))
}
/// The registry entry of `library` in the data folder `data`, active or not
/// (without a registry, `<data>/library` is the local one).
fn entry_of(data: &Path, library: &Path) -> Result<LibraryEntry, String> {
    let dir = |rel: &str| {
        rel.split('/')
            .filter(|p| !p.is_empty() && *p != ".")
            .fold(data.to_path_buf(), |dir, part| dir.join(part))
    };
    if data.join(LIBRARIES_FILE).is_file() {
        return LibraryRegistry::load_or_init(data)?
            .entries
            .into_iter()
            .find(|e| dir(&e.path) == library)
            .ok_or_else(|| "the library the import began from is not registered".into());
    }
    let local = LibraryRegistry::default_local().entries.remove(0);
    if dir(&local.path) == library {
        Ok(local)
    } else {
        Err("unregistered library ownership; only a registered library can be reimported".into())
    }
}
/// Where `entry`'s unfinished import is remembered ([`PENDING`]).
fn pending_pointer(data: &Path, entry: &LibraryEntry) -> Result<PathBuf, String> {
    match entry.owner {
        LibraryOwner::Local => Ok(data.join(PENDING)),
        LibraryOwner::Account { .. } => {
            if entry.id.is_empty()
                || !entry
                    .id
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            {
                return Err("invalid account library identity".into());
            }
            Ok(data.join(format!("{PREFIX}pending-{}.json", entry.id)))
        }
    }
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
    /// An account import that was not allowed: nothing was written, or (a
    /// late refusal) the complete target was kept and not taken up.
    Refused(Refusal),
    Imported {
        job: Box<Destination>,
        receipt: Box<dr_import_v1::receipt::Receipt>,
        timing: run::Timing,
    },
}

/// Why an import into an account's library was not allowed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// The account already has something in the new format, on this device
    /// or on the server: it is synced, not imported again.
    AccountHasBooks,
    /// The server could not say whether the account is empty (offline, an
    /// error, no session): nothing is guessed.
    Unasked {
        /// The session was refused (signed in again, it can be asked).
        expired: bool,
        why: String,
    },
}

/// How to ask the server about the account an import writes for.
#[derive(Clone)]
pub struct AccountCheck {
    /// The signed-in account: must own the library the import began from.
    pub subject: String,
    pub base_url: String,
    pub access_token: String,
}

impl std::fmt::Debug for AccountCheck {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AccountCheck")
            .field("subject", &self.subject)
            .field("base_url", &self.base_url)
            .finish_non_exhaustive()
    }
}

impl AccountCheck {
    /// Asks the server once whether this account's `loro-v2` feed is empty.
    pub fn ask(&self) -> Result<(), Refusal> {
        let unasked = |e: dr_sync::SyncError| Refusal::Unasked {
            expired: e.is_unauthorized(),
            why: e.to_string(),
        };
        let client = dr_sync::SyncHttpClient::new(&self.base_url).map_err(unasked)?;
        match client.feed_is_empty(&self.access_token) {
            Ok(true) => Ok(()),
            Ok(false) => Err(Refusal::AccountHasBooks),
            Err(e) => Err(unasked(e)),
        }
    }
}

/// Whether `library` holds nothing at all: an account's library is imported
/// into only then (books in Recently Deleted and books kept only on this
/// device count as something).
pub fn library_is_empty(library: &dr_workspace::Workspace) -> Result<bool, String> {
    Ok(library
        .library()
        .docs(None, None)
        .map_err(|e| e.to_string())?
        .is_empty())
}

/// [`import_for`] a local library: an account's import needs its check.
pub fn import(
    job: Destination,
    version: &str,
    accept: Accept,
    cancel: Cancel,
    progress: &mut dyn FnMut(&Progress),
) -> Result<ResultOfImport, ImportError> {
    import_for(job, version, accept, cancel, None, progress)
}

/// Imports `job`. When the library it began from is an account's, `account`
/// must be that account's: the server is asked before anything is written
/// and again once the target is complete, and any answer but "empty" refuses.
pub fn import_for(
    mut job: Destination,
    version: &str,
    accept: Accept,
    cancel: Cancel,
    account: Option<&AccountCheck>,
    progress: &mut dyn FnMut(&Progress),
) -> Result<ResultOfImport, ImportError> {
    job.validate().map_err(ImportError::Invalid)?;
    let account = match job.owner().map_err(ImportError::Invalid)? {
        LibraryOwner::Local => None,
        LibraryOwner::Account { subject } => match account {
            Some(check) if check.subject == subject => Some(check),
            _ => {
                return Ok(ResultOfImport::Refused(Refusal::Unasked {
                    expired: false,
                    why: "no session for the account this library belongs to".into(),
                }));
            }
        },
    };
    // The account is empty on the server, or nothing is written (not even
    // the staging copy below).
    if let Some(check) = account
        && let Err(refusal) = check.ask()
    {
        return Ok(ResultOfImport::Refused(refusal));
    }
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
            // Another device may have begun meanwhile: still empty, or the
            // complete target is kept and not taken up.
            if job.completed
                && let Some(check) = account
                && let Err(refusal) = check.ask()
            {
                return Ok(ResultOfImport::Refused(refusal));
            }
            Ok(ResultOfImport::Imported {
                job: Box::new(job),
                receipt,
                timing,
            })
        }
    }
}
