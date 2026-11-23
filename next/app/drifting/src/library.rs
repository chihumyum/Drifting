//! Opening the library (F2) with F3's hooks and this device's identity.
//!
//! The device directory is this client's own data folder (`AppDirs::own`),
//! beside the `library/` folder and outside it. F2's `Device` keeps there an
//! installation file in the 0.1 client's format, `sync-installation-v2.json`,
//! which machine it belongs to (a salted digest of `IOPlatformUUID` /
//! `MachineGuid`) and the library watermarks. With it the library notices a
//! copy from another machine or an older backup put back (a new epoch), and
//! M07's writing days are stored under this device's key
//! (`Workspace::writing_device`).
//!
//! Under the release identity `own` is beside the 0.1 client's data folder,
//! never in it, so the new client never writes the 0.1 client's
//! installation file, registry or libraries (`data_folder_tests`). Importing
//! a 0.1 library takes its installation id over (M10, `take_over`), so the
//! writing days continue under the 0.1 device key.
//!
//! A development build has a data folder of its own (`cc.drifting.next.dev`,
//! never the release app's), and `DRIFTING_PROFILE` (each worktree's
//! `cargo xtask dev`) gives every profile its own, so no two development
//! runs share a device identity either.
//!
//! When the identity cannot be read (an unreadable or corrupt file, which F2
//! never rewrites by itself), the library still opens, without it: the
//! author can write, writing days are counted but not stored, and the log
//! says why.

use std::path::{Path, PathBuf};

use dr_shell::library_failure::{Cause, LibraryFailure};
use dr_workspace::{Workspace, WorkspaceOptions, WsError};

/// The library's folder inside this client's own data folder (F2's
/// `library.sqlite`, `assets/`, …; `AppDirs::own`).
pub const LIBRARY_DIR: &str = "library";

/// Opens (or creates) the library in `<data>/library` with this device
/// (the tests'; the app opens the active one, [`open_active`]).
#[cfg(test)]
pub fn open(data: &Path, app_version: &str) -> dr_workspace::Result<Workspace> {
    open_at(data, &data.join(LIBRARY_DIR), app_version)
}

/// Opens the currently active library from `<data>/libraries.json` (M35),
/// falling back to `<data>/library` when no registry exists yet.
pub fn open_active(data: &Path, app_version: &str) -> dr_workspace::Result<Workspace> {
    open_at(data, &active_dir(data), app_version)
}

/// The active library's folder: the registry's (`<data>/libraries.json`,
/// M35), or `<data>/library` when there is none or it cannot be read.
pub fn active_dir(data: &Path) -> PathBuf {
    if data.join(dr_account::LIBRARIES_FILE).is_file() {
        dr_account::LibraryRegistry::load_or_init(data)
            .map(|reg| reg.active_library_dir(data))
            .unwrap_or_else(|_| data.join(LIBRARY_DIR))
    } else {
        data.join(LIBRARY_DIR)
    }
}

/// What the shell's page says when the active library of the data folder
/// `data` could not be opened ([`open_active`]): the cause, the stable code,
/// and the folder 「在访达中打开」 opens.
pub fn failure(error: &WsError, data: Option<&Path>) -> LibraryFailure {
    LibraryFailure {
        cause: open_failure_cause(error),
        code: open_failure_code(error),
        folder: reveal_folder(data),
    }
}

/// A failure that is no error of the store's or the workspace's (opening
/// panicked, its thread did not start, there is no data folder): the cause
/// is unknown, `code` names what happened.
pub fn other_failure(code: &str, data: Option<&Path>) -> LibraryFailure {
    LibraryFailure {
        cause: Cause::Unknown,
        code: code.to_owned(),
        folder: reveal_folder(data),
    }
}

/// The active library's folder, or the data folder when that one does not
/// exist; nothing without a data folder.
fn reveal_folder(data: Option<&Path>) -> Option<PathBuf> {
    let data = data?;
    let library = active_dir(data);
    if library.is_dir() {
        Some(library)
    } else {
        data.is_dir().then(|| data.to_path_buf())
    }
}

/// Which of the page's causes `error` is, from the error itself: the
/// storage layer's refusal and SQLite's or the system's class of error.
/// Anything not plainly one of them is unknown (in 0.2.0 that includes a
/// recovery receipt that needs attention: there is no restore on the page
/// yet).
///
/// | error | cause |
/// | --- | --- |
/// | `SchemaNewer` | newer |
/// | SQLite `DatabaseCorrupt`, `NotADatabase`; `Invalid { integrity check }` | damaged |
/// | `Migration` at a stage that leaves the source unchanged | upgrade unfinished |
/// | `Migration` at `Reopen` | upgraded library does not open |
/// | SQLite `PermissionDenied`, `ReadOnly`; I/O `PermissionDenied`, `ReadOnlyFilesystem` | no permission |
/// | SQLite `DiskFull`; I/O `StorageFull`, `QuotaExceeded` | disk full |
/// | everything else (`SchemaMismatch`, `Recovery`, the lock held elsewhere, other SQLite and I/O errors, workspace errors) | unknown |
pub fn open_failure_cause(error: &WsError) -> Cause {
    use std::io::ErrorKind;

    use dr_store::StoreError;
    use rusqlite::ErrorCode;

    let WsError::Store(store) = error else {
        return Cause::Unknown;
    };
    match store {
        StoreError::SchemaNewer { .. } => Cause::Newer,
        StoreError::Migration(failure) if failure.source_unchanged() => Cause::UpgradeUnfinished,
        StoreError::Migration(_) => Cause::UpgradedUnopenable,
        StoreError::Sqlite(error) => match error.sqlite_error_code() {
            Some(ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase) => Cause::Damaged,
            Some(ErrorCode::PermissionDenied | ErrorCode::ReadOnly) => Cause::NoPermission,
            Some(ErrorCode::DiskFull) => Cause::DiskFull,
            _ => Cause::Unknown,
        },
        StoreError::Io(error) => match error.kind() {
            ErrorKind::PermissionDenied | ErrorKind::ReadOnlyFilesystem => Cause::NoPermission,
            ErrorKind::StorageFull | ErrorKind::QuotaExceeded => Cause::DiskFull,
            _ => Cause::Unknown,
        },
        StoreError::Invalid {
            what: "integrity check",
            ..
        } => Cause::Damaged,
        _ => Cause::Unknown,
    }
}

/// The stable code of a library that could not be opened, for the log and
/// the integrity report (`library-open-failed:<this>`): the storage layer's
/// own code when it is the store that refused (`schema-newer`,
/// `sqlite:database-corrupt`, `migration:validate`, `io:permission-denied`),
/// otherwise the workspace's. Never text from the library.
pub fn open_failure_code(error: &WsError) -> String {
    match error {
        WsError::Store(store) => store.code(),
        other => other.code(),
    }
}

fn open_at(data: &Path, library_dir: &Path, app_version: &str) -> dr_workspace::Result<Workspace> {
    let mut options = dr_workspace::library_options(app_version);
    match dr_store::Device::open(data) {
        Ok(device) => {
            if device.machine_changed() {
                log::warn!("the app's data came from another machine: this is a new device");
            }
            options.device = Some(device);
        }
        Err(error) => {
            log::error!(
                "this device's identity could not be read, writing days are not stored: {error}"
            )
        }
    }
    let lib = dr_store::Library::open(library_dir, options)?;
    Workspace::open(lib, WorkspaceOptions::default())
}

#[cfg(test)]
mod tests {
    use super::*;

    const VERSION: &str = "0.2.0-test";

    /// The 0.1 client's installation file, which F2's `Device` reads.
    const IDENTITY_FILE: &str = "sync-installation-v2.json";

    fn close(ws: Workspace) {
        ws.close();
        let lib = ws.library().clone();
        drop(ws);
        lib.close().unwrap();
    }

    #[test]
    fn the_library_opens_with_this_devices_writing_day_key() {
        let data = tempfile::tempdir().unwrap();
        let ws = open(data.path(), VERSION).unwrap();
        let key = ws.writing_device().expect("the library knows this device");
        assert!(key.starts_with("device-"), "{key}");
        // The identity lives in the data folder, outside the library.
        assert!(data.path().join(IDENTITY_FILE).is_file());
        assert!(!data.path().join(LIBRARY_DIR).join(IDENTITY_FILE).exists());
        let device = dr_store::Device::open(data.path()).unwrap();
        assert_eq!(key, device.writing_device_key());
        close(ws);

        // Reopened, it is the same device.
        let ws = open(data.path(), VERSION).unwrap();
        assert_eq!(ws.writing_device().as_deref(), Some(key.as_str()));
        close(ws);
    }

    #[test]
    fn a_library_that_cannot_be_opened_has_a_stable_code_and_is_left_alone() {
        // Written by a newer build: one migration more than this build knows.
        let data = tempfile::tempdir().unwrap();
        close(open(data.path(), VERSION).unwrap());
        let file = data.path().join(LIBRARY_DIR).join("library.sqlite");
        {
            let db = rusqlite::Connection::open(&file).unwrap();
            db.execute(
                "INSERT INTO schema_migration (version, name, sha256, applied_ms) \
                 SELECT max(version) + 1, 'from_a_newer_build', 'x', 0 FROM schema_migration",
                [],
            )
            .unwrap();
        }
        let before = std::fs::read(&file).unwrap();
        let error = open(data.path(), VERSION).err().expect("refused");
        assert_eq!(open_failure_code(&error), "schema-newer");
        assert_eq!(std::fs::read(&file).unwrap(), before, "nothing was changed");

        // Not a database at all.
        let data = tempfile::tempdir().unwrap();
        let dir = data.path().join(LIBRARY_DIR);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("library.sqlite");
        std::fs::write(
            &file,
            b"this is not a database, it only sits where one would be",
        )
        .unwrap();
        let error = open(data.path(), VERSION).err().expect("refused");
        assert_eq!(open_failure_code(&error), "sqlite:not-a-database");
        assert_eq!(
            std::fs::read(&file).unwrap(),
            b"this is not a database, it only sits where one would be"
        );
    }

    fn sqlite(code: std::ffi::c_int) -> WsError {
        WsError::Store(dr_store::StoreError::Sqlite(
            rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(code), None),
        ))
    }

    fn io(kind: std::io::ErrorKind) -> WsError {
        WsError::Store(dr_store::StoreError::Io(std::io::Error::new(
            kind,
            "synthetic",
        )))
    }

    fn migration(stage: dr_store::MigrationStage) -> WsError {
        WsError::Store(dr_store::StoreError::Migration(
            dr_store::MigrationFailure {
                stage,
                detail: "synthetic".into(),
                safety_snapshot: PathBuf::new(),
                recovery_id: None,
                from: 8,
                to: 9,
            },
        ))
    }

    /// Every row of `open_failure_cause`'s table.
    #[test]
    fn each_open_failure_is_one_of_the_pages_causes() {
        use dr_store::{MigrationStage, StoreError};
        use rusqlite::ffi;
        use std::io::ErrorKind;

        let store = WsError::Store;
        let mut cases = vec![
            (
                store(StoreError::SchemaNewer {
                    applied: 10,
                    known: 9,
                }),
                Cause::Newer,
            ),
            (sqlite(ffi::SQLITE_CORRUPT), Cause::Damaged),
            (sqlite(ffi::SQLITE_NOTADB), Cause::Damaged),
            (
                store(StoreError::Invalid {
                    what: "integrity check",
                    value: "row 7".into(),
                }),
                Cause::Damaged,
            ),
            (migration(MigrationStage::Reopen), Cause::UpgradedUnopenable),
            (sqlite(ffi::SQLITE_PERM), Cause::NoPermission),
            (sqlite(ffi::SQLITE_READONLY), Cause::NoPermission),
            (io(ErrorKind::PermissionDenied), Cause::NoPermission),
            (io(ErrorKind::ReadOnlyFilesystem), Cause::NoPermission),
            (sqlite(ffi::SQLITE_FULL), Cause::DiskFull),
            (io(ErrorKind::StorageFull), Cause::DiskFull),
            (io(ErrorKind::QuotaExceeded), Cause::DiskFull),
            // Unknown: when unsure, the page does not guess.
            (
                store(StoreError::SchemaMismatch("a table".into())),
                Cause::Unknown,
            ),
            (
                store(StoreError::Recovery {
                    recovery_id: "01aa".into(),
                    code: "snapshot-changed",
                }),
                Cause::Unknown,
            ),
            (
                store(StoreError::Invalid {
                    what: "library",
                    value: "already open in another process or handle".into(),
                }),
                Cause::Unknown,
            ),
            (
                store(StoreError::Invalid {
                    what: "foreign key check",
                    value: "a table".into(),
                }),
                Cause::Unknown,
            ),
            (sqlite(ffi::SQLITE_IOERR), Cause::Unknown),
            (sqlite(ffi::SQLITE_CANTOPEN), Cause::Unknown),
            (sqlite(ffi::SQLITE_BUSY), Cause::Unknown),
            (
                store(StoreError::Sqlite(rusqlite::Error::QueryReturnedNoRows)),
                Cause::Unknown,
            ),
            (io(ErrorKind::NotFound), Cause::Unknown),
            (io(ErrorKind::Other), Cause::Unknown),
            (store(StoreError::ReadOnly), Cause::Unknown),
            // Not the store's: the workspace's own errors, even SQLite ones.
            (WsError::Internal("synthetic".into()), Cause::Unknown),
            (
                WsError::Local(rusqlite::Error::SqliteFailure(
                    ffi::Error::new(ffi::SQLITE_CORRUPT),
                    None,
                )),
                Cause::Unknown,
            ),
        ];
        // Every stage before the replacement leaves the library as it was.
        for stage in MigrationStage::ALL {
            if stage.source_unchanged() {
                cases.push((migration(stage), Cause::UpgradeUnfinished));
            }
        }
        for (error, cause) in &cases {
            assert_eq!(open_failure_cause(error), *cause, "{error}");
        }
        // Every cause is reachable from some error.
        for cause in Cause::ALL {
            assert!(cases.iter().any(|(_, c)| *c == cause), "{cause:?}");
        }
        // What is no error of the store's is unknown.
        assert_eq!(other_failure("panicked", None).cause, Cause::Unknown);
        assert_eq!(other_failure("no-data-folder", None).folder, None);

        // 「在访达中打开」: the library's folder, else the data folder.
        let data = tempfile::tempdir().unwrap();
        assert_eq!(
            other_failure("panicked", Some(data.path())).folder,
            Some(data.path().to_path_buf())
        );
        std::fs::create_dir_all(data.path().join(LIBRARY_DIR)).unwrap();
        assert_eq!(
            failure(&io(ErrorKind::PermissionDenied), Some(data.path())).folder,
            Some(data.path().join(LIBRARY_DIR))
        );
    }

    /// A library marked as written by a newer build, and a file that is not
    /// a database, reach the shell as their cause and code (what `main`
    /// hands it), and the window shows the page, not the bookshelf.
    #[gpui::test]
    fn a_refused_library_reaches_the_shell_as_its_cause_and_code(cx: &mut gpui::TestAppContext) {
        use dr_shell::{Services, SettingsFile, ShellInfo, Workspace};

        // Written by a newer build.
        let newer = tempfile::tempdir().unwrap();
        close(open_active(newer.path(), VERSION).unwrap());
        let file = active_dir(newer.path()).join("library.sqlite");
        rusqlite::Connection::open(&file)
            .unwrap()
            .execute(
                "INSERT INTO schema_migration (version, name, sha256, applied_ms) \
                 SELECT max(version) + 1, 'from_a_newer_build', 'x', 0 FROM schema_migration",
                [],
            )
            .unwrap();
        let error = open_active(newer.path(), VERSION).err().expect("refused");
        let first = failure(&error, Some(newer.path()));
        assert_eq!(
            first,
            LibraryFailure {
                cause: Cause::Newer,
                code: "schema-newer".into(),
                folder: Some(newer.path().join(LIBRARY_DIR)),
            }
        );

        // Not a database.
        let broken = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(active_dir(broken.path())).unwrap();
        std::fs::write(
            active_dir(broken.path()).join("library.sqlite"),
            b"this is not a database, it only sits where one would be",
        )
        .unwrap();
        let error = open_active(broken.path(), VERSION).err().expect("refused");
        let second = failure(&error, Some(broken.path()));
        assert_eq!(
            (second.cause, second.code.as_str()),
            (Cause::Damaged, "sqlite:not-a-database")
        );

        cx.update(|cx| {
            dr_shell::init(
                ShellInfo {
                    app_name: crate::identity::APP_NAME,
                    bundle_id: crate::identity::BUNDLE_ID,
                    version: VERSION,
                    url_scheme: "drifting-next-dev",
                    forced_appearance: None,
                },
                Services {
                    library_failure: Some(first.clone()),
                    ..Services::default()
                },
                SettingsFile::in_memory(),
                cx,
            );
        });
        for expected in [first, second] {
            cx.update(|cx| {
                cx.global_mut::<Services>().library_failure = Some(expected.clone());
            });
            let (view, cx) = cx.add_window_view(Workspace::new);
            cx.run_until_parked();
            view.read_with(cx, |ws, cx| {
                assert_eq!(ws.library_failure(cx), Some(expected.clone()));
                assert!(!ws.shelf_open);
            });
        }
    }

    #[test]
    fn every_data_folder_is_its_own_device() {
        let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let (wa, wb) = (
            open(a.path(), VERSION).unwrap(),
            open(b.path(), VERSION).unwrap(),
        );
        assert_ne!(wa.writing_device(), wb.writing_device());
        close(wa);
        close(wb);
    }

    #[test]
    fn a_broken_identity_still_opens_the_library_without_storing_days() {
        let data = tempfile::tempdir().unwrap();
        std::fs::write(data.path().join(IDENTITY_FILE), b"broken").unwrap();
        let ws = open(data.path(), VERSION).unwrap();
        assert_eq!(ws.writing_device(), None);
        close(ws);
        // F2 never rewrites a corrupt identity by itself.
        assert_eq!(
            std::fs::read(data.path().join(IDENTITY_FILE)).unwrap(),
            b"broken"
        );
    }
}
