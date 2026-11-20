//! The release identity on a device that ran the 0.1 client (F7's
//! hand-over). The release identity's data folder is the 0.1 client's
//! (`cc.drifting.client`, Tauri's `app_local_data_dir`), and both clients
//! name their files the same way: `libraries.json`, `libraries/account-<first
//! 16 bytes of SHA-256(subject), hex>/`. That folder is what 「导入 Drifting
//! 0.1」 reads, so starting the new client must leave every byte of it as it
//! was; the new client keeps its own files in `AppDirs::own`, beside it.
//!
//! Everything here runs in a temporary folder laid out by dr-platform's
//! release rules, macOS's and Windows's both on every system
//! (`AppDirs::for_layout_at(…, &RELEASE, …)`: macOS
//! `~/Library/Application Support/cc.drifting.client`, Windows
//! `%LOCALAPPDATA%\cc.drifting.client` with the program installed in
//! `%LOCALAPPDATA%\Drifting`), with the synthetic 0.1 library of
//! dr-import-v1's tests: never the real folders, never the author's library.

#[path = "../../../crates/dr-import-v1/tests/common/mod.rs"]
mod v1;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use dr_account::{AccountService, HostedConfig, LibraryRegistry};
use dr_platform::AppDirs;
use dr_platform::identity::RELEASE;
use dr_platform::paths::Layout;
use dr_platform::secrets::SecretStore;
use sha2::Digest as _;

use crate::library;

const VERSION: &str = "0.2.0-test";
/// A Hosted account that had a library in 0.1.
const SUBJECT: &str = "user-0123456789";

/// The 0.1 client's id for an account's library (`library_id_for` in
/// `src-tauri/src/library_registry.rs`).
fn v1_account_library(subject: &str) -> String {
    let digest = sha2::Sha256::digest(subject.as_bytes());
    let hex: String = digest[..16].iter().map(|b| format!("{b:02x}")).collect();
    format!("account-{hex}")
}

fn copy_tree(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), &target).unwrap();
        }
    }
}

/// A 0.1 data folder at `base`: the pre-registry library at the root (its
/// database, an image's bytes, the installation identity), one account
/// library under `libraries/`, an external Agent's connection file, and,
/// with `registry`, the `libraries.json` that names both (every 0.1 build
/// since the registry has one). On Windows also WebView2's profile, which
/// Tauri keeps in the same folder (`EBWebView/`).
fn v1_data_folder(layout: Layout, base: &Path, registry: bool) -> v1::Old {
    let old = v1::build(true);
    copy_tree(&old.root, base);
    if layout == Layout::Windows {
        std::fs::create_dir_all(base.join("EBWebView/Default")).unwrap();
        std::fs::write(base.join("EBWebView/Default/Preferences"), b"{}").unwrap();
    }
    let account = base.join("libraries").join(v1_account_library(SUBJECT));
    copy_tree(&old.root.join("databases"), &account.join("databases"));
    std::fs::copy(
        old.root.join("sync-installation-v2.json"),
        account.join("sync-installation-v2.json"),
    )
    .unwrap();
    std::fs::create_dir_all(base.join("mcp")).unwrap();
    std::fs::write(
        base.join("mcp/connection-synthetic.json"),
        br#"{"version":1,"synthetic":true}"#,
    )
    .unwrap();
    if registry {
        let libraries = serde_json::json!({
            "version": 1,
            "active": "legacy",
            "libraries": {
                "legacy": { "owner": { "kind": "local" } },
                v1_account_library(SUBJECT): {
                    "owner": { "kind": "account", "subject": SUBJECT }
                },
            },
        });
        std::fs::write(
            base.join("libraries.json"),
            serde_json::to_vec_pretty(&libraries).unwrap(),
        )
        .unwrap();
    }
    old
}

/// Every file and folder under `root`: its bytes' digest, length and
/// modification time (folders: `None`).
type Snapshot = BTreeMap<PathBuf, Option<(String, u64, std::time::SystemTime)>>;

fn snapshot(root: &Path) -> Snapshot {
    fn walk(root: &Path, dir: &Path, out: &mut Snapshot) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            let rel = path.strip_prefix(root).unwrap().to_path_buf();
            let meta = std::fs::symlink_metadata(&path).unwrap();
            if meta.is_dir() {
                out.insert(rel, None);
                walk(root, &path, out);
            } else {
                let bytes = std::fs::read(&path).unwrap();
                let digest = v1::sha256_bytes(&bytes);
                out.insert(rel, Some((digest, meta.len(), meta.modified().unwrap())));
            }
        }
    }
    let mut out = Snapshot::new();
    walk(root, root, &mut out);
    out
}

/// What changed between two snapshots: added, removed and changed paths,
/// `/`-separated on every system.
fn changes(before: &Snapshot, after: &Snapshot) -> Vec<String> {
    let name = |path: &Path| path.to_string_lossy().replace('\\', "/");
    let mut out = Vec::new();
    for (path, was) in before {
        match after.get(path) {
            None => out.push(format!("removed {}", name(path))),
            Some(now) if now != was => out.push(format!("changed {}", name(path))),
            Some(_) => {}
        }
    }
    for path in after.keys().filter(|p| !before.contains_key(*p)) {
        out.push(format!("added {}", name(path)));
    }
    out
}

fn close(ws: dr_workspace::Workspace) {
    ws.close();
    let lib = ws.library().clone();
    drop(ws);
    lib.close().unwrap();
}

/// What `main` does with `own` up to the open library, in its order,
/// signed out and then signed in: the settings file (written as the shell
/// writes a change), the active library with this device's identity, the
/// account service settling the registry, the account's own library, and
/// the diagnostics id feedback sends. Errors are returned, not unwrapped:
/// the old layout below fails part-way, as the app did.
fn start_like_the_app(own: &Path) -> Vec<String> {
    let mut errors = Vec::new();
    let mut settings = dr_shell::SettingsFile::open(own);
    settings.set_last_book("01900000-0000-7000-8000-000000000001");
    if let Err(e) = settings.save() {
        errors.push(format!("settings: {e}"));
    }
    match library::open_active(own, VERSION) {
        Ok(ws) => close(ws),
        Err(e) => errors.push(format!("library: {e}")),
    }
    match AccountService::new(
        HostedConfig::local_only(),
        own,
        RELEASE.url_scheme,
        Arc::new(SecretStore::in_memory()),
    ) {
        Ok(account) => drop(account.bootstrap()),
        Err(e) => errors.push(format!("account: {e:?}")),
    }
    match LibraryRegistry::settle_for_startup(own, true, Some(SUBJECT)) {
        Ok(_) => match library::open_active(own, VERSION) {
            Ok(ws) => close(ws),
            Err(e) => errors.push(format!("account library: {e}")),
        },
        Err(e) => errors.push(format!("sign-in: {e}")),
    }
    dr_platform::diagnostics::installation_id(Some(own));
    errors
}

const LAYOUTS: [Layout; 2] = [Layout::MacOs, Layout::Windows];

fn release_dirs(layout: Layout, root: &Path) -> AppDirs {
    AppDirs::for_layout_at(layout, &RELEASE, &root.join("local"), &root.join("Logs"))
}

/// Windows: the 0.1 Tauri installer's program folder,
/// `%LOCALAPPDATA%\<product name>`, which the new installer updates in
/// place; the app itself never writes there.
fn v1_install_folder(root: &Path) -> PathBuf {
    let install = root.join("local").join(RELEASE.product_name);
    std::fs::create_dir_all(&install).unwrap();
    std::fs::write(install.join("drifting.exe"), b"MZ synthetic 0.1 executable").unwrap();
    std::fs::write(install.join("uninstall.exe"), b"MZ synthetic uninstaller").unwrap();
    install
}

#[test]
fn both_clients_name_an_accounts_library_alike() {
    // Why the folders cannot be shared: the same account's library has the
    // same folder name in both clients.
    assert_eq!(
        dr_account::account_library_id(SUBJECT),
        v1_account_library(SUBJECT)
    );
    assert_eq!(dr_account::LIBRARIES_FILE, "libraries.json");
}

/// The release layout: starting the new client leaves the 0.1 data folder
/// byte for byte as it was (its `libraries.json`, `databases/`, every
/// `libraries/*/`, and everything else in it), and on Windows the program
/// folder too; the new client's files are all in `own`, and 「导入 Drifting
/// 0.1」 still finds the 0.1 library and accepts a destination in `own`.
#[test]
fn the_release_layout_leaves_the_0_1_data_folder_untouched() {
    for (layout, registry) in LAYOUTS.into_iter().flat_map(|l| [(l, true), (l, false)]) {
        let case = format!("{layout:?}, registry {registry}");
        let root = tempfile::tempdir().unwrap();
        let dirs = release_dirs(layout, root.path());
        let _old = v1_data_folder(layout, &dirs.data, registry);
        let install = v1_install_folder(root.path());
        let before = snapshot(&dirs.data);
        let installed = snapshot(&install);
        assert!(before.contains_key(Path::new("databases/drifting-library.db")));
        let found = dr_view_import::find_local_libraries(&dirs.data);
        assert_eq!(found.len(), 1, "{case}");
        assert_eq!(found[0].picked.root, dirs.data);

        let errors = start_like_the_app(&dirs.own);
        assert!(errors.is_empty(), "{case}: {errors:?}");

        let after = snapshot(&dirs.data);
        assert_eq!(changes(&before, &after), Vec::<String>::new(), "{case}");
        assert_eq!(
            changes(&installed, &snapshot(&install)),
            Vec::<String>::new(),
            "{case}"
        );
        // The new client's own files, beside the 0.1 folder and the program.
        for folder in [&dirs.own, &dirs.logs, &dirs.crashes] {
            assert!(!folder.starts_with(&dirs.data), "{case}: {folder:?}");
            assert!(!folder.starts_with(&install), "{case}: {folder:?}");
        }
        let own = LibraryRegistry::load_or_init(&dirs.own).unwrap();
        assert!(own.is_active_account(SUBJECT));
        assert!(dirs.own.join("library").is_dir());
        assert!(
            dirs.own
                .join("libraries")
                .join(v1_account_library(SUBJECT))
                .is_dir()
        );
        assert!(dirs.own.join("settings.json").is_file());
        assert!(
            dirs.own
                .join(dr_platform::diagnostics::INSTALLATION_FILE)
                .is_file()
        );

        // 「导入 Drifting 0.1」: still finds the 0.1 library, and takes a
        // destination next to the local library in `own` (it refuses one
        // inside the library it reads, whose root is the 0.1 folder).
        let found = dr_view_import::find_local_libraries(&dirs.data);
        assert_eq!(found.len(), 1, "{case}");
        LibraryRegistry::settle_for_startup(&dirs.own, false, None).unwrap();
        let local = dirs.own.join("library");
        let destination = dr_view_import::reimport::Destination::prepare(&local, &found[0].picked)
            .unwrap_or_else(|e| panic!("{case}: {e}"));
        assert!(destination.target().starts_with(&dirs.own));
        assert_eq!(snapshot(&dirs.data), before, "{case}");
    }
}

/// The negative control: the layout before the fix (the new client's files
/// in the 0.1 folder itself, as a development build keeps them in its own)
/// changes the 0.1 folder, and with no registry yet it writes a
/// `libraries.json` the 0.1 rules call corrupt, after which 「导入 Drifting
/// 0.1」 no longer finds the 0.1 library.
#[test]
fn the_layout_before_the_fix_writes_into_the_0_1_data_folder() {
    for (layout, registry) in LAYOUTS.into_iter().flat_map(|l| [(l, true), (l, false)]) {
        let case = format!("{layout:?}, registry {registry}");
        let root = tempfile::tempdir().unwrap();
        let dirs = release_dirs(layout, root.path());
        let _old = v1_data_folder(layout, &dirs.data, registry);
        let before = snapshot(&dirs.data);

        let errors = start_like_the_app(&dirs.data);

        let changed = changes(&before, &snapshot(&dirs.data));
        assert!(
            changed.contains(&"added library".to_owned()),
            "{case}: {changed:?}"
        );
        let found = dr_view_import::find_local_libraries(&dirs.data);
        if registry {
            // The 0.1 registry is not the new client's format: the account
            // service cannot start on it (the app fell back to a temporary
            // folder), signing in cannot record the account library.
            assert!(
                errors.iter().any(|e| e.starts_with("account:")),
                "{case}: {errors:?}"
            );
            assert_eq!(found.len(), 1, "{case}");
        } else {
            assert!(
                changed.contains(&"added libraries.json".to_owned()),
                "{case}"
            );
            assert!(
                changed
                    .iter()
                    .any(|c| c.starts_with("added libraries/account-")),
                "{case}: {changed:?}"
            );
            assert_eq!(
                found.len(),
                0,
                "{case}: the 0.1 library is lost to the import"
            );
        }
    }
}
