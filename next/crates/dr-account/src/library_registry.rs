//! Per-account library isolation and `<data>/libraries.json` registry.
//!
//! Each Drifting installation maintains:
//! - One local library at `<data>/library` (`id: "local"`, `owner: Local`)
//! - Zero or more account-bound libraries at `<data>/libraries/account-<sha256_16_hex>`
//!   (`id: "account-<sha256_16_hex>"`, `owner: Account { subject }`)
//!
//! Signing into an account activates (and if needed creates) that account's isolated
//! library directory without copying local books into the account library. Signing out
//! activates the local library again while keeping the account library directory on disk
//! so re-signing into the same account immediately restores its local state.
//!
//! An account's library can move once: importing a 0.1 library while signed in
//! writes a separate directory and, when it is complete, the account's entry is
//! pointed at it ([`LibraryRegistry::adopt_for_account`]). The entry keeps its id;
//! the previous (empty) directory stays on disk.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const LIBRARIES_FILE: &str = "libraries.json";
pub const DEFAULT_LOCAL_ID: &str = "local";
pub const DEFAULT_LOCAL_REL_PATH: &str = "library";

/// Ownership of a library directory in `<data>/libraries.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LibraryOwner {
    Local,
    Account { subject: String },
}

/// One registered library entry in `<data>/libraries.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEntry {
    pub id: String,
    pub path: String,
    pub owner: LibraryOwner,
    pub created_at: u64,
}

/// On-disk registry stored at `<data>/libraries.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryRegistry {
    pub version: u32,
    pub active_id: String,
    pub entries: Vec<LibraryEntry>,
}

static REGISTRY_LOCK: Mutex<()> = Mutex::new(());

/// Held around one read-modify-write of `<data>/libraries.json` (load, change,
/// save), so two writers in this process cannot lose each other's change: a
/// session refresh activating an account while an import points that account
/// at its new library, for one.
pub fn registry_lock() -> MutexGuard<'static, ()> {
    REGISTRY_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// Deterministic library id for an account `subject` (`account-<first 16 bytes of SHA-256 hex>`).
#[must_use]
pub fn account_library_id(subject: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(subject.trim().as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(32);
    for b in &digest[..16] {
        use std::fmt::Write as _;
        let _ = write!(&mut hex, "{b:02x}");
    }
    format!("account-{hex}")
}

/// Deterministic relative path under `<data>` for an account's isolated library.
#[must_use]
pub fn account_library_rel_path(subject: &str) -> String {
    format!("libraries/{}", account_library_id(subject))
}

impl LibraryRegistry {
    /// Load `<data>/libraries.json` or initialize a default registry pointing to `<data>/library`.
    pub fn load_or_init(data_dir: &Path) -> Result<Self, String> {
        let file_path = data_dir.join(LIBRARIES_FILE);
        if file_path.is_file() {
            let raw = fs::read_to_string(&file_path)
                .map_err(|e| format!("read {}: {e}", file_path.display()))?;
            let mut reg: Self = serde_json::from_str(&raw)
                .map_err(|e| format!("parse {}: {e}", file_path.display()))?;
            reg.ensure_local_entry();
            return Ok(reg);
        }

        let reg = Self::default_local();
        reg.save(data_dir)?;
        Ok(reg)
    }

    /// Create a fresh in-memory registry with only the local library entry.
    #[must_use]
    pub fn default_local() -> Self {
        Self {
            version: 1,
            active_id: DEFAULT_LOCAL_ID.to_string(),
            entries: vec![LibraryEntry {
                id: DEFAULT_LOCAL_ID.to_string(),
                path: DEFAULT_LOCAL_REL_PATH.to_string(),
                owner: LibraryOwner::Local,
                created_at: now_ms(),
            }],
        }
    }

    fn ensure_local_entry(&mut self) {
        let has_local = self
            .entries
            .iter()
            .any(|e| matches!(e.owner, LibraryOwner::Local));
        if !has_local {
            self.entries.insert(
                0,
                LibraryEntry {
                    id: DEFAULT_LOCAL_ID.to_string(),
                    path: DEFAULT_LOCAL_REL_PATH.to_string(),
                    owner: LibraryOwner::Local,
                    created_at: now_ms(),
                },
            );
        }
        if !self.entries.iter().any(|e| e.id == self.active_id)
            && let Some(local) = self
                .entries
                .iter()
                .find(|e| matches!(e.owner, LibraryOwner::Local))
        {
            self.active_id = local.id.clone();
        }
    }

    /// Persist `<data>/libraries.json` atomically.
    pub fn save(&self, data_dir: &Path) -> Result<(), String> {
        fs::create_dir_all(data_dir).map_err(|e| format!("create {}: {e}", data_dir.display()))?;
        let file_path = data_dir.join(LIBRARIES_FILE);
        let tmp_path = data_dir.join(format!("{LIBRARIES_FILE}.tmp"));
        let json =
            serde_json::to_string_pretty(self).map_err(|e| format!("serialize registry: {e}"))?;
        fs::write(&tmp_path, json).map_err(|e| format!("write {}: {e}", tmp_path.display()))?;
        fs::rename(&tmp_path, &file_path)
            .map_err(|e| format!("rename {}: {e}", file_path.display()))
    }

    /// Currently active `LibraryEntry`.
    #[must_use]
    pub fn active_entry(&self) -> &LibraryEntry {
        self.entries
            .iter()
            .find(|e| e.id == self.active_id)
            .or_else(|| {
                self.entries
                    .iter()
                    .find(|e| matches!(e.owner, LibraryOwner::Local))
            })
            .expect("LibraryRegistry always contains at least one local entry")
    }

    /// Absolute path of the currently active library directory.
    #[must_use]
    pub fn active_library_dir(&self, data_dir: &Path) -> PathBuf {
        resolve_entry_dir(data_dir, &self.active_entry().path)
    }

    /// Absolute path of the local library directory.
    #[must_use]
    pub fn local_library_dir(&self, data_dir: &Path) -> PathBuf {
        let rel = self
            .entries
            .iter()
            .find(|e| matches!(e.owner, LibraryOwner::Local))
            .map(|e| e.path.as_str())
            .unwrap_or(DEFAULT_LOCAL_REL_PATH);
        resolve_entry_dir(data_dir, rel)
    }

    /// Whether the currently active entry is the local library.
    #[must_use]
    pub fn is_active_local(&self) -> bool {
        matches!(self.active_entry().owner, LibraryOwner::Local)
    }

    /// Whether the currently active entry belongs to `subject`.
    #[must_use]
    pub fn is_active_account(&self, subject: &str) -> bool {
        let trimmed = subject.trim();
        matches!(
            &self.active_entry().owner,
            LibraryOwner::Account { subject: active } if active == trimmed
        )
    }

    /// Currently active account subject, if the active library is an account library.
    #[must_use]
    pub fn active_account_subject(&self) -> Option<&str> {
        match &self.active_entry().owner {
            LibraryOwner::Account { subject } => Some(subject.as_str()),
            LibraryOwner::Local => None,
        }
    }

    /// Activate the isolated library for `subject`, creating its directory if needed,
    /// and persist `<data>/libraries.json`.
    pub fn activate_account(&mut self, data_dir: &Path, subject: &str) -> Result<PathBuf, String> {
        let subject = subject.trim();
        if subject.is_empty() {
            return Err("account subject cannot be empty".into());
        }
        let id = account_library_id(subject);
        let rel_path = account_library_rel_path(subject);
        if !self.entries.iter().any(|e| e.id == id) {
            self.entries.push(LibraryEntry {
                id: id.clone(),
                path: rel_path,
                owner: LibraryOwner::Account {
                    subject: subject.to_string(),
                },
                created_at: now_ms(),
            });
        }
        self.active_id = id;
        let dir = self.active_library_dir(data_dir);
        fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        self.save(data_dir)?;
        Ok(dir)
    }

    /// Points the active account library at `rel_path` (one directory name
    /// under `data_dir`): the import of a 0.1 library while signed in, once the
    /// new library is complete. Only while `subject`'s library is the active one
    /// and is still `from`; the entry keeps its id and owner, and `from` stays on
    /// disk. Persists `<data>/libraries.json` and returns the new directory.
    pub fn adopt_for_account(
        &mut self,
        data_dir: &Path,
        subject: &str,
        from: &Path,
        rel_path: &str,
    ) -> Result<PathBuf, String> {
        let subject = subject.trim();
        if subject.is_empty() || !self.is_active_account(subject) {
            return Err("the account's library is no longer the active one".into());
        }
        if self.active_library_dir(data_dir) != from {
            return Err("the account's library changed".into());
        }
        if rel_path.is_empty()
            || rel_path == "."
            || rel_path == ".."
            || rel_path.contains(['/', '\\'])
            || rel_path.chars().any(char::is_control)
        {
            return Err("invalid library directory".into());
        }
        if self
            .entries
            .iter()
            .any(|e| e.path == rel_path || e.id == rel_path)
        {
            return Err("library directory is already registered".into());
        }
        let dir = resolve_entry_dir(data_dir, rel_path);
        if !dir.is_dir() {
            return Err(format!("{} is not a library directory", dir.display()));
        }
        let active = self.active_id.clone();
        let entry = self
            .entries
            .iter_mut()
            .find(|e| e.id == active)
            .ok_or("the account's library is not registered")?;
        entry.path = rel_path.to_owned();
        self.save(data_dir)?;
        Ok(dir)
    }

    /// Switch the active library back to the local library without deleting any
    /// account library directories on disk.
    pub fn activate_local(&mut self, data_dir: &Path) -> Result<PathBuf, String> {
        self.ensure_local_entry();
        if let Some(local) = self
            .entries
            .iter()
            .find(|e| matches!(e.owner, LibraryOwner::Local))
        {
            self.active_id = local.id.clone();
        }
        let dir = self.active_library_dir(data_dir);
        fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        self.save(data_dir)?;
        Ok(dir)
    }

    /// Resolve which library directory to open at application startup.
    ///
    /// - If `has_session_token` is false, the user is signed out: switch back to the local library.
    /// - If `has_session_token` is true and `known_subject` is `Some(sub)`, ensure that account's
    ///   library is active.
    /// - If `has_session_token` is true and `known_subject` is `None`, preserve whatever entry is
    ///   currently active in `libraries.json`.
    pub fn settle_for_startup(
        data_dir: &Path,
        has_session_token: bool,
        known_subject: Option<&str>,
    ) -> Result<(Self, PathBuf), String> {
        let _held = registry_lock();
        let mut reg = Self::load_or_init(data_dir)?;
        let dir = if !has_session_token {
            reg.activate_local(data_dir)?
        } else if let Some(subject) = known_subject.filter(|s| !s.trim().is_empty()) {
            reg.activate_account(data_dir, subject)?
        } else {
            let d = reg.active_library_dir(data_dir);
            fs::create_dir_all(&d).map_err(|e| format!("create {}: {e}", d.display()))?;
            d
        };
        Ok((reg, dir))
    }
}

fn resolve_entry_dir(data_dir: &Path, rel: &str) -> PathBuf {
    let mut out = data_dir.to_path_buf();
    for part in rel.split('/').filter(|p| !p.is_empty() && *p != ".") {
        out.push(part);
    }
    out
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
