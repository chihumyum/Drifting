//! Finding the 0.1 libraries on this device: the rules of the 0.1 client's
//! `src-tauri/src/library_registry.rs` and `data_paths.rs`, read-only.
//!
//! The 0.1 app's local data folder (`base`) holds `libraries.json`. The
//! library that existed before the registry is `legacy` and keeps `base`
//! itself; every other library lives in `base/libraries/<id>`. Each root has
//! its database at `databases/drifting-library.db`, and its assets
//! (`assets/<book>/<asset>/source.*`), installation identity
//! (`sync-installation-v2.json`) and Markdown folder state beside it. A
//! missing registry means only `legacy`; a corrupt one is refused, never
//! reset (as in 0.1).

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{ImportError, Result};

const REGISTRY_FILE: &str = "libraries.json";
const LIBRARIES_DIRECTORY: &str = "libraries";
const MAX_REGISTRY_BYTES: u64 = 256 * 1024;
pub const LEGACY_LIBRARY_ID: &str = "legacy";
/// The 0.1 database directory and file name (`data_paths.rs`,
/// `LOCAL_USER_ID` in `store/auth.ts`).
pub const DATABASE_DIRECTORY: &str = "databases";
pub const DATABASE_FILE: &str = "drifting-library.db";
/// The 0.1 installation identity (`installation_identity.rs`).
pub const INSTALLATION_FILE: &str = "sync-installation-v2.json";

/// Who a 0.1 library belongs to (`LibraryOwner`).
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Owner {
    /// Writing without an account.
    Local,
    /// One Hosted account, by its stable subject.
    Account { subject: String },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Entry {
    owner: Option<Owner>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Registry {
    version: u8,
    active: String,
    libraries: BTreeMap<String, Entry>,
}

impl Default for Registry {
    fn default() -> Self {
        let mut libraries = BTreeMap::new();
        libraries.insert(LEGACY_LIBRARY_ID.to_string(), Entry { owner: None });
        Self {
            version: 1,
            active: LEGACY_LIBRARY_ID.to_string(),
            libraries,
        }
    }
}

/// One 0.1 library found under `base`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyLibrary {
    pub id: String,
    /// `None`: the pre-registry library, never claimed (0.1 claims it on its
    /// first launch after the registry was added).
    pub owner: Option<Owner>,
    /// The library's data root: assets, identity, Markdown folder state.
    pub root: PathBuf,
    pub database: PathBuf,
    /// The library the 0.1 app would open next.
    pub active: bool,
    /// Whether its database file exists.
    pub exists: bool,
}

/// A library's data root relative to `base` (`legacy` is `base`).
pub fn relative_root(id: &str) -> PathBuf {
    if id == LEGACY_LIBRARY_ID {
        PathBuf::new()
    } else {
        Path::new(LIBRARIES_DIRECTORY).join(id)
    }
}

fn load(base: &Path) -> Result<Registry> {
    let path = base.join(REGISTRY_FILE);
    let meta = match std::fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Registry::default()),
        Err(e) => return Err(ImportError::Registry(format!("unreadable: {e}"))),
    };
    if !meta.is_file() || meta.len() > MAX_REGISTRY_BYTES {
        return Err(ImportError::Registry("invalid".into()));
    }
    let mut bytes = Vec::new();
    std::fs::File::open(&path)?
        .take(MAX_REGISTRY_BYTES + 1)
        .read_to_end(&mut bytes)?;
    let registry: Registry =
        serde_json::from_slice(&bytes).map_err(|_| ImportError::Registry("corrupt".into()))?;
    if registry.version != 1 || !registry.libraries.contains_key(&registry.active) {
        return Err(ImportError::Registry("corrupt".into()));
    }
    for id in registry.libraries.keys() {
        // An id is one path component (`local`, `legacy`, `account-<hex>`).
        if id.is_empty()
            || id == "."
            || id == ".."
            || id.contains(['/', '\\'])
            || id.chars().any(char::is_control)
        {
            return Err(ImportError::Registry(format!("invalid library id {id:?}")));
        }
    }
    Ok(registry)
}

/// Every 0.1 library the registry under `base` names, the active one first.
/// Reads only.
pub fn discover(base: &Path) -> Result<Vec<LegacyLibrary>> {
    let registry = load(base)?;
    let mut out: Vec<LegacyLibrary> = registry
        .libraries
        .iter()
        .map(|(id, entry)| {
            let root = base.join(relative_root(id));
            let database = root.join(DATABASE_DIRECTORY).join(DATABASE_FILE);
            LegacyLibrary {
                id: id.clone(),
                owner: entry.owner.clone(),
                active: *id == registry.active,
                exists: database.is_file(),
                root,
                database,
            }
        })
        .collect();
    out.sort_by_key(|l| (!l.active, l.id.clone()));
    Ok(out)
}

/// The installation id stored in a 0.1 library root, if it has a valid one
/// (`sync-installation-v2.json`, version 2, `install-` + 64 hex digits).
pub fn installation_id(root: &Path) -> Option<String> {
    let path = root.join(INSTALLATION_FILE);
    let meta = std::fs::symlink_metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > 1024 {
        return None;
    }
    let value: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).ok()?).ok()?;
    if value.get("version")?.as_u64()? != 2 {
        return None;
    }
    let id = value.get("installation_id")?.as_str()?;
    let suffix = id.strip_prefix("install-")?;
    (suffix.len() == 64 && suffix.bytes().all(|c| c.is_ascii_hexdigit())).then(|| id.to_string())
}

/// The 0.1 library a chosen folder stands for (the app's folder picker).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Picked {
    /// Its database (`databases/drifting-library.db`).
    pub database: PathBuf,
    /// Its data root: assets, installation identity.
    pub root: PathBuf,
    /// Its registry id, when the folder was the 0.1 app's data folder.
    pub id: Option<String>,
    /// The other libraries there that this import leaves alone: account
    /// libraries go into per-account libraries (M35), one at a time.
    pub left: Vec<String>,
}

/// Which 0.1 library `folder` means. Read-only. Accepted:
///
/// - the 0.1 app's data folder (a registry, `libraries/`, or the
///   pre-registry library's `databases/` in it): its local library
///   (`legacy` unclaimed or claimed locally, or `local`; the active one when
///   both exist). A folder holding only account libraries is refused;
/// - one library's root (`databases/drifting-library.db` in it), such as
///   `libraries/<id>`;
/// - that library's `databases` folder.
pub fn resolve(folder: &Path) -> Result<Picked> {
    let database_here = folder.join(DATABASE_FILE);
    let looks_like_base = folder.join(REGISTRY_FILE).exists()
        || folder.join(LIBRARIES_DIRECTORY).is_dir()
        || folder
            .join(DATABASE_DIRECTORY)
            .join(DATABASE_FILE)
            .is_file();
    if !looks_like_base {
        if database_here.is_file() {
            let root = folder.parent().unwrap_or(folder).to_path_buf();
            return Ok(Picked {
                database: database_here,
                root,
                id: None,
                left: Vec::new(),
            });
        }
        return Err(ImportError::NotALibrary(format!(
            "no {DATABASE_DIRECTORY}/{DATABASE_FILE} in the folder"
        )));
    }
    let found: Vec<LegacyLibrary> = discover(folder)?.into_iter().filter(|l| l.exists).collect();
    let local = |l: &LegacyLibrary| matches!(l.owner, None | Some(Owner::Local));
    // `discover` lists the active library first.
    let Some(chosen) = found.iter().find(|l| local(l)) else {
        if found.is_empty() {
            return Err(ImportError::NotALibrary(format!(
                "no library with a {DATABASE_FILE} in the folder"
            )));
        }
        return Err(ImportError::AccountLibrariesOnly(
            found
                .iter()
                .map(|l| l.id.clone())
                .collect::<Vec<_>>()
                .join(", "),
        ));
    };
    Ok(Picked {
        database: chosen.database.clone(),
        root: chosen.root.clone(),
        id: Some(chosen.id.clone()),
        left: found
            .iter()
            .filter(|l| l.id != chosen.id)
            .map(|l| l.id.clone())
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn without_a_registry_there_is_the_legacy_library() {
        let base = tempfile::tempdir().unwrap();
        let found = discover(base.path()).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "legacy");
        assert_eq!(found[0].owner, None);
        assert!(found[0].active && !found[0].exists);
        assert_eq!(
            found[0].database,
            base.path().join("databases/drifting-library.db")
        );
    }

    #[test]
    fn account_and_local_libraries_have_their_own_roots() {
        let base = tempfile::tempdir().unwrap();
        std::fs::write(
            base.path().join(REGISTRY_FILE),
            r#"{"version":1,"active":"local","libraries":{
                "legacy":{"owner":{"kind":"account","subject":"Owner-A"}},
                "local":{"owner":{"kind":"local"}},
                "account-0123456789abcdef0123456789abcdef":{"owner":{"kind":"account","subject":"b"}}}}"#,
        )
        .unwrap();
        let db = base.path().join("libraries/local/databases");
        std::fs::create_dir_all(&db).unwrap();
        std::fs::write(db.join(DATABASE_FILE), b"").unwrap();
        let found = discover(base.path()).unwrap();
        assert_eq!(found[0].id, "local");
        assert!(found[0].active && found[0].exists);
        assert_eq!(found[0].owner, Some(Owner::Local));
        let legacy = found.iter().find(|l| l.id == "legacy").unwrap();
        assert_eq!(legacy.root, base.path());
        assert_eq!(
            legacy.owner,
            Some(Owner::Account {
                subject: "Owner-A".into()
            })
        );
        assert!(found.iter().any(|l| {
            l.root
                == base
                    .path()
                    .join("libraries/account-0123456789abcdef0123456789abcdef")
        }));
    }

    #[test]
    fn a_corrupt_registry_is_refused() {
        let base = tempfile::tempdir().unwrap();
        std::fs::write(base.path().join(REGISTRY_FILE), b"{not json").unwrap();
        assert!(matches!(
            discover(base.path()),
            Err(ImportError::Registry(_))
        ));
        std::fs::write(
            base.path().join(REGISTRY_FILE),
            r#"{"version":1,"active":"gone","libraries":{"legacy":{"owner":null}}}"#,
        )
        .unwrap();
        assert!(discover(base.path()).is_err());
        std::fs::write(
            base.path().join(REGISTRY_FILE),
            r#"{"version":1,"active":"..","libraries":{"..":{"owner":null}}}"#,
        )
        .unwrap();
        assert!(discover(base.path()).is_err());
    }

    #[test]
    fn installation_identity() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(installation_id(root.path()), None);
        let id = format!("install-{}", "ab".repeat(32));
        std::fs::write(
            root.path().join(INSTALLATION_FILE),
            format!(r#"{{"version":2,"installation_id":"{id}"}}"#),
        )
        .unwrap();
        assert_eq!(installation_id(root.path()), Some(id));
        std::fs::write(
            root.path().join(INSTALLATION_FILE),
            r#"{"version":2,"installation_id":"install-zz"}"#,
        )
        .unwrap();
        assert_eq!(installation_id(root.path()), None);
    }

    fn database_at(dir: &Path) {
        let db = dir.join(DATABASE_DIRECTORY);
        std::fs::create_dir_all(&db).unwrap();
        std::fs::write(db.join(DATABASE_FILE), b"").unwrap();
    }

    #[test]
    fn a_chosen_folder_means_one_local_library() {
        // The data folder of a 0.1 app that never had the registry.
        let base = tempfile::tempdir().unwrap();
        assert!(matches!(
            resolve(base.path()),
            Err(ImportError::NotALibrary(_))
        ));
        database_at(base.path());
        let picked = resolve(base.path()).unwrap();
        assert_eq!(picked.id.as_deref(), Some("legacy"));
        assert_eq!(picked.root, base.path());
        // Its `databases` folder: the root is the folder above.
        let databases = base.path().join(DATABASE_DIRECTORY);
        let picked = resolve(&databases).unwrap();
        assert_eq!((picked.root.as_path(), picked.id), (base.path(), None));
        assert_eq!(picked.database, databases.join(DATABASE_FILE));

        // With the registry: the local library, the account ones left.
        std::fs::write(
            base.path().join(REGISTRY_FILE),
            r#"{"version":1,"active":"account-0123456789abcdef0123456789abcdef","libraries":{
                "legacy":{"owner":{"kind":"account","subject":"a"}},
                "local":{"owner":{"kind":"local"}},
                "account-0123456789abcdef0123456789abcdef":{"owner":{"kind":"account","subject":"b"}}}}"#,
        )
        .unwrap();
        database_at(&base.path().join("libraries/local"));
        database_at(
            &base
                .path()
                .join("libraries/account-0123456789abcdef0123456789abcdef"),
        );
        let picked = resolve(base.path()).unwrap();
        assert_eq!(picked.id.as_deref(), Some("local"));
        assert_eq!(picked.root, base.path().join("libraries/local"));
        assert_eq!(
            picked.left,
            ["account-0123456789abcdef0123456789abcdef", "legacy"]
        );
        // One library's own root.
        let one = base
            .path()
            .join("libraries/account-0123456789abcdef0123456789abcdef");
        assert_eq!(resolve(&one).unwrap().root, one);

        // Only account libraries: refused.
        std::fs::remove_dir_all(base.path().join("libraries/local")).unwrap();
        std::fs::write(
            base.path().join(REGISTRY_FILE),
            r#"{"version":1,"active":"legacy","libraries":{
                "legacy":{"owner":{"kind":"account","subject":"a"}},
                "local":{"owner":{"kind":"local"}}}}"#,
        )
        .unwrap();
        assert!(matches!(
            resolve(base.path()),
            Err(ImportError::AccountLibrariesOnly(_))
        ));
    }
}
