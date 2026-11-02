//! Account-isolated libraries.
//!
//! A library owns a whole App-local data root: its SQLite file, assets, sync
//! objects and restore attempts, Markdown projections and MCP state. Native
//! stores garbage-collect against the database that is open, so two libraries
//! must never share one root. The registry in the base root names the active
//! library; it is chosen once per process. Switching writes the registry and
//! relaunches through the flushed shutdown path, so no runtime, store or
//! renderer ever sees two libraries.
//!
//! The library that existed before this registry is `legacy` and keeps the
//! base root itself, so upgrading moves no files. The renderer claims its
//! owner on first launch from the library's own sync authority.

use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const REGISTRY_FILE: &str = "libraries.json";
const LIBRARIES_DIRECTORY: &str = "libraries";
const MAX_REGISTRY_BYTES: u64 = 256 * 1024;
pub const LEGACY_LIBRARY_ID: &str = "legacy";
const LOCAL_LIBRARY_ID: &str = "local";

/// Who a library belongs to. Unclaimed is only the pre-registry library before
/// its first launch on this version.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum LibraryOwner {
    /// Writing without an account: the library a signed-out author sees.
    Local,
    /// One Hosted account, by its stable account subject.
    Account { subject: String },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LibraryEntry {
    owner: Option<LibraryOwner>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Registry {
    version: u8,
    active: String,
    libraries: BTreeMap<String, LibraryEntry>,
}

impl Default for Registry {
    fn default() -> Self {
        let mut libraries = BTreeMap::new();
        libraries.insert(LEGACY_LIBRARY_ID.to_string(), LibraryEntry { owner: None });
        Self {
            version: 1,
            active: LEGACY_LIBRARY_ID.to_string(),
            libraries,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySummary {
    pub id: String,
    pub owner: Option<LibraryOwner>,
}

/// What the renderer may know: the library this process runs on, and the
/// libraries the registry holds now (an activation may already be pending).
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryState {
    pub active_id: String,
    pub active_owner: Option<LibraryOwner>,
    pub libraries: Vec<LibrarySummary>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryActivation {
    pub library_id: String,
    /// True when the process must relaunch onto another library.
    pub restarting: bool,
}

/// The library this process runs on, fixed at its first data-path lookup.
static RUNNING_LIBRARY: OnceLock<String> = OnceLock::new();

/// The relative data root of the running library under `base`.
pub fn running_library(base: &Path) -> &'static str {
    RUNNING_LIBRARY.get_or_init(|| {
        load(base)
            .map(|registry| registry.active)
            .unwrap_or_else(|_| LEGACY_LIBRARY_ID.to_string())
    })
}

/// A library's data root relative to the base root (`legacy` is the base).
pub fn relative_root(library_id: &str) -> PathBuf {
    if library_id == LEGACY_LIBRARY_ID {
        PathBuf::new()
    } else {
        Path::new(LIBRARIES_DIRECTORY).join(library_id)
    }
}

fn library_id_for(owner: &LibraryOwner) -> String {
    match owner {
        LibraryOwner::Local => LOCAL_LIBRARY_ID.to_string(),
        // Hex is a safe single path component on case-insensitive volumes,
        // whatever characters the account subject uses.
        LibraryOwner::Account { subject } => {
            let digest = Sha256::digest(subject.as_bytes());
            let hex: String = digest
                .iter()
                .take(16)
                .map(|byte| format!("{byte:02x}"))
                .collect();
            format!("account-{hex}")
        }
    }
}

fn validate_owner(owner: &LibraryOwner) -> Result<(), String> {
    if let LibraryOwner::Account { subject } = owner {
        if subject.trim().is_empty() || subject.len() > 256 || subject.chars().any(char::is_control)
        {
            return Err("LIBRARY_OWNER_INVALID: account subject is invalid".into());
        }
    }
    Ok(())
}

fn load(base: &Path) -> Result<Registry, String> {
    let path = base.join(REGISTRY_FILE);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Registry::default())
        }
        Err(error) => return Err(format!("library registry is unreadable: {error}")),
    };
    if !metadata.is_file() || metadata.len() > MAX_REGISTRY_BYTES {
        return Err("library registry is invalid".into());
    }
    let mut bytes = Vec::new();
    File::open(&path)
        .map_err(|error| format!("library registry is unreadable: {error}"))?
        .take(MAX_REGISTRY_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("library registry is unreadable: {error}"))?;
    let registry: Registry =
        serde_json::from_slice(&bytes).map_err(|_| "library registry is corrupt".to_string())?;
    if registry.version != 1 || !registry.libraries.contains_key(&registry.active) {
        return Err("library registry is corrupt".into());
    }
    Ok(registry)
}

fn save(base: &Path, registry: &Registry) -> Result<(), String> {
    fs::create_dir_all(base).map_err(|error| format!("library registry folder: {error}"))?;
    let bytes = serde_json::to_vec_pretty(registry).map_err(|error| error.to_string())?;
    let temporary = base.join(format!("{REGISTRY_FILE}.tmp"));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&temporary)
            .map_err(|error| format!("library registry write: {error}"))?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("library registry write: {error}"))?;
        fs::rename(&temporary, base.join(REGISTRY_FILE))
            .map_err(|error| format!("library registry write: {error}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn summarize(registry: &Registry, running: &str) -> LibraryState {
    LibraryState {
        active_id: running.to_string(),
        active_owner: registry
            .libraries
            .get(running)
            .and_then(|entry| entry.owner.clone()),
        libraries: registry
            .libraries
            .iter()
            .map(|(id, entry)| LibrarySummary {
                id: id.clone(),
                owner: entry.owner.clone(),
            })
            .collect(),
    }
}

pub fn state(base: &Path, running: &str) -> Result<LibraryState, String> {
    Ok(summarize(&load(base)?, running))
}

/// Record who the running library belongs to. Only an unclaimed library can be
/// claimed; claiming the owner it already has is a no-op.
pub fn claim(base: &Path, running: &str, owner: LibraryOwner) -> Result<LibraryState, String> {
    validate_owner(&owner)?;
    let mut registry = load(base)?;
    let current = registry
        .libraries
        .get(running)
        .ok_or_else(|| "LIBRARY_UNKNOWN: the running library is not registered".to_string())?;
    match &current.owner {
        Some(existing) if *existing == owner => return Ok(summarize(&registry, running)),
        Some(_) => return Err("LIBRARY_OWNER_CONFLICT: this library already has an owner".into()),
        None => {}
    }
    if registry
        .libraries
        .iter()
        .any(|(id, entry)| id != running && entry.owner.as_ref() == Some(&owner))
    {
        return Err("LIBRARY_OWNER_CONFLICT: another library already belongs to this owner".into());
    }
    registry
        .libraries
        .insert(running.to_string(), LibraryEntry { owner: Some(owner) });
    save(base, &registry)?;
    Ok(summarize(&registry, running))
}

/// Make `owner`'s library the one the next launch opens, creating an empty one
/// on first use. The running process keeps its library until it relaunches.
pub fn activate(
    base: &Path,
    running: &str,
    owner: LibraryOwner,
) -> Result<LibraryActivation, String> {
    validate_owner(&owner)?;
    let mut registry = load(base)?;
    let existing = registry
        .libraries
        .iter()
        .find(|(_, entry)| entry.owner.as_ref() == Some(&owner))
        .map(|(id, _)| id.clone());
    let library_id = match existing {
        Some(id) => id,
        None => {
            let id = library_id_for(&owner);
            if registry.libraries.contains_key(&id) {
                return Err("LIBRARY_OWNER_CONFLICT: library id is already taken".into());
            }
            fs::create_dir_all(base.join(relative_root(&id)))
                .map_err(|error| format!("library folder: {error}"))?;
            registry
                .libraries
                .insert(id.clone(), LibraryEntry { owner: Some(owner) });
            id
        }
    };
    if registry.active != library_id {
        registry.active = library_id.clone();
        save(base, &registry)?;
    }
    let restarting = library_id != running;
    Ok(LibraryActivation {
        library_id,
        restarting,
    })
}

fn base_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    crate::data_paths::base_local_root(app)
}

#[tauri::command]
pub async fn library_state(app: tauri::AppHandle) -> Result<LibraryState, String> {
    let base = base_root(&app)?;
    let running = running_library(&base).to_string();
    tauri::async_runtime::spawn_blocking(move || state(&base, &running))
        .await
        .map_err(|_| "library registry worker failed".to_string())?
}

#[tauri::command]
pub async fn library_claim_owner(
    app: tauri::AppHandle,
    owner: LibraryOwner,
) -> Result<LibraryState, String> {
    let base = base_root(&app)?;
    let running = running_library(&base).to_string();
    tauri::async_runtime::spawn_blocking(move || claim(&base, &running, owner))
        .await
        .map_err(|_| "library registry worker failed".to_string())?
}

/// Switch to `owner`'s library. A different library relaunches the App through
/// the same flush barrier as an ordinary quit.
#[tauri::command]
pub async fn library_activate(
    app: tauri::AppHandle,
    owner: LibraryOwner,
) -> Result<LibraryActivation, String> {
    let base = base_root(&app)?;
    let running = running_library(&base).to_string();
    let activation = tauri::async_runtime::spawn_blocking(move || activate(&base, &running, owner))
        .await
        .map_err(|_| "library registry worker failed".to_string())??;
    if activation.restarting {
        relaunch(&app)?;
    }
    Ok(activation)
}

#[cfg(desktop)]
fn relaunch(app: &tauri::AppHandle) -> Result<(), String> {
    if !crate::request_flushed_shutdown(app, crate::state::ShutdownAction::RestartApp) {
        crate::relaunch_app(app);
    }
    Ok(())
}

#[cfg(mobile)]
fn relaunch(_app: &tauri::AppHandle) -> Result<(), String> {
    Err("LIBRARY_SWITCH_UNSUPPORTED: this platform cannot relaunch onto another library".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(subject: &str) -> LibraryOwner {
        LibraryOwner::Account {
            subject: subject.to_string(),
        }
    }

    #[test]
    fn an_upgraded_install_runs_its_existing_root_as_the_unclaimed_legacy_library() {
        let base = tempfile::tempdir().unwrap();
        let state = state(base.path(), LEGACY_LIBRARY_ID).unwrap();
        assert_eq!(state.active_id, LEGACY_LIBRARY_ID);
        assert_eq!(state.active_owner, None);
        assert_eq!(relative_root(LEGACY_LIBRARY_ID), PathBuf::new());
    }

    #[test]
    fn each_owner_gets_its_own_root_and_switching_back_reuses_it() {
        let base = tempfile::tempdir().unwrap();
        claim(base.path(), LEGACY_LIBRARY_ID, account("Owner-A")).unwrap();

        let local = activate(base.path(), LEGACY_LIBRARY_ID, LibraryOwner::Local).unwrap();
        assert_eq!(
            local,
            LibraryActivation {
                library_id: "local".into(),
                restarting: true
            }
        );
        assert!(base.path().join("libraries/local").is_dir());

        let other = activate(base.path(), "local", account("owner-a")).unwrap();
        assert!(other.library_id.starts_with("account-"));
        assert!(other.restarting);
        assert_ne!(
            other.library_id, "legacy",
            "subjects differing only in case stay apart"
        );

        let back = activate(base.path(), &other.library_id, account("Owner-A")).unwrap();
        assert_eq!(
            back,
            LibraryActivation {
                library_id: "legacy".into(),
                restarting: true
            }
        );
        assert_eq!(load(base.path()).unwrap().active, "legacy");

        let same = activate(base.path(), "legacy", account("Owner-A")).unwrap();
        assert!(!same.restarting);
    }

    #[test]
    fn a_claimed_library_never_changes_owner() {
        let base = tempfile::tempdir().unwrap();
        claim(base.path(), LEGACY_LIBRARY_ID, LibraryOwner::Local).unwrap();
        claim(base.path(), LEGACY_LIBRARY_ID, LibraryOwner::Local).unwrap();
        assert!(claim(base.path(), LEGACY_LIBRARY_ID, account("a"))
            .unwrap_err()
            .contains("CONFLICT"));
    }

    #[test]
    fn an_owner_cannot_be_claimed_twice() {
        let base = tempfile::tempdir().unwrap();
        let created = activate(base.path(), LEGACY_LIBRARY_ID, account("a")).unwrap();
        assert!(created.restarting);
        assert!(claim(base.path(), LEGACY_LIBRARY_ID, account("a"))
            .unwrap_err()
            .contains("CONFLICT"));
    }

    #[test]
    fn a_corrupt_registry_is_refused_rather_than_reset() {
        let base = tempfile::tempdir().unwrap();
        fs::write(base.path().join(REGISTRY_FILE), b"{not json").unwrap();
        assert!(state(base.path(), LEGACY_LIBRARY_ID).is_err());
        assert!(activate(base.path(), LEGACY_LIBRARY_ID, LibraryOwner::Local).is_err());
    }

    #[test]
    fn invalid_account_subjects_are_rejected() {
        let base = tempfile::tempdir().unwrap();
        assert!(activate(base.path(), LEGACY_LIBRARY_ID, account(" ")).is_err());
        assert!(activate(base.path(), LEGACY_LIBRARY_ID, account("a\nb")).is_err());
    }
}
