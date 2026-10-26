use super::*;

const SHA_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NOW: &str = "2026-10-28T00:00:00.000Z";

fn library(path: &Path) -> Connection {
    let connection = Connection::open(path).unwrap();
    apply_migrations(&connection).unwrap();
    connection
}

fn add_project(connection: &Connection, id: &str, name: &str) {
    connection
        .execute(
            "INSERT INTO project (id, name, user_id, created_at, updated_at) VALUES (?1, ?2, 'source-user', ?3, ?3)",
            params![id, name, NOW],
        )
        .unwrap();
}

fn add_asset(connection: &Connection, project: &str, id: &str) {
    connection
        .execute(
            "INSERT INTO project_asset (id, project_id, kind, source_mime, source_size_bytes, source_sha256, width, height, created_at) \
             VALUES (?1, ?2, 'image', 'image/png', 10, ?3, 4, 4, ?4)",
            params![id, project, SHA_A, NOW],
        )
        .unwrap();
}

fn add_writer(connection: &Connection, project: &str) {
    connection
        .execute(
            "INSERT INTO sync_generation (sync_generation_id, project_id, project_sync_id, created_at, updated_at) \
             VALUES ('generation-1', ?1, 'project-sync-1', ?2, ?2)",
            params![project, NOW],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO sync_generation_writer_state (sync_generation_id, writer_id, writer_epoch, installation_id, next_device_seq, created_at, updated_at) \
             VALUES ('generation-1', 'writer-1', 'epoch-1', 'installation-1', 42, ?1, ?1)",
            [NOW],
        )
        .unwrap();
}

fn write_asset(root: &Path, project: &str, asset: &str, file: &str, bytes: &[u8]) {
    let directory = root.join(project).join(asset);
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join(file), bytes).unwrap();
}

fn snapshot(source: &Path, destination: &Path) {
    let connection = Connection::open(source).unwrap();
    snapshot_connection_into(&connection, destination).unwrap();
}

/// A source library with one image (three variants) and one asset whose
/// directory is missing on disk, packaged into `backup.drifting`.
fn source_backup(root: &Path) -> (PathBuf, BackupSummary) {
    let database = root.join("source.db");
    let connection = library(&database);
    add_project(&connection, "project-new", "雾港");
    add_asset(&connection, "project-new", "asset-kept");
    add_asset(&connection, "project-new", "asset-missing");
    add_writer(&connection, "project-new");
    drop(connection);
    let assets = root.join("source-assets");
    write_asset(&assets, "project-new", "asset-kept", "source.png", b"backup source");
    write_asset(&assets, "project-new", "asset-kept", "display.jpg", b"backup display");
    write_asset(&assets, "project-new", "asset-kept", "thumbnail.jpg", b"backup thumbnail");
    write_asset(&assets, "project-new", "asset-kept", ".drifting-import-v1", b"session");
    let snapshot_path = root.join("snapshot.sqlite");
    snapshot(&database, &snapshot_path);
    let package = root.join("out").join("backup.drifting");
    let summary = write_backup_package(&snapshot_path, &assets, &package, "0.1.0-test", 1_000).unwrap();
    (package, summary)
}

fn plan(root: &Path, staging: &Path, assets: &Path) -> LibraryRestorePlan {
    LibraryRestorePlan {
        staging: staging.to_path_buf(),
        assets_root: assets.to_path_buf(),
        safety_directory: root.join("databases").join("safety-backups").join("pre-restore"),
        app_version: "0.1.0-test".into(),
        now_ms: 2_000,
    }
}

#[test]
fn export_lists_projects_and_every_referenced_asset_file() {
    let directory = tempfile::tempdir().unwrap();
    let (package, summary) = source_backup(directory.path());
    assert_eq!(summary.projects, vec![BackupProject { id: "project-new".into(), name: "雾港".into() }]);
    assert_eq!(summary.asset_file_count, 3, "the import marker is not packaged");
    assert_eq!(summary.missing_asset_count, 1);
    assert_eq!(summary.package_size_bytes, fs::metadata(&package).unwrap().len());
    let mut archive = ZipArchive::new(File::open(&package).unwrap()).unwrap();
    let mut names: Vec<_> = archive.file_names().map(str::to_owned).collect();
    names.sort();
    assert_eq!(
        names,
        [
            "assets/project-new/asset-kept/display.jpg",
            "assets/project-new/asset-kept/source.png",
            "assets/project-new/asset-kept/thumbnail.jpg",
            "library.sqlite",
            "manifest.json",
        ]
    );
    assert!(archive.by_name("manifest.json").is_ok());
}

#[test]
fn restore_replaces_the_library_merges_assets_and_keeps_a_pre_restore_package() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let (package, _) = source_backup(root);

    let databases = root.join("databases");
    fs::create_dir_all(&databases).unwrap();
    let target = databases.join("drifting-library.db");
    let connection = library(&target);
    add_project(&connection, "project-old", "旧项目");
    add_asset(&connection, "project-old", "asset-old");
    drop(connection);
    let assets = root.join("target-assets");
    write_asset(&assets, "project-old", "asset-old", "source.png", b"old source");
    write_asset(&assets, "project-new", "asset-kept", "source.png", b"corrupt");
    write_asset(&assets, "project-new", "asset-kept", "display.jpg", b"local display");

    let staging = databases.join("library-restore").join("restore-1");
    let staged = stage_backup_package(&package, &staging, "drifting-library.db", NOW).unwrap();
    assert_eq!(staged.projects.len(), 1);
    let outcome = restore_staged_backup(&databases, &target, &plan(root, &staging, &assets)).unwrap();

    let restored = Connection::open(&target).unwrap();
    let projects: Vec<(String, String)> = restored
        .prepare("SELECT id, user_id FROM project")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(projects, vec![("project-new".into(), "drifting-library.db".into())]);
    let active_writers: i64 = restored
        .query_row(
            "SELECT count(*) FROM sync_generation_writer_state WHERE retired_at IS NULL",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(active_writers, 0, "restored writers must not reuse published sequences");
    drop(restored);

    let kept = assets.join("project-new").join("asset-kept");
    assert_eq!(fs::read(kept.join("source.png")).unwrap(), b"backup source");
    assert_eq!(fs::read(kept.join("display.jpg")).unwrap(), b"local display");
    assert_eq!(fs::read(kept.join("thumbnail.jpg")).unwrap(), b"backup thumbnail");
    assert_eq!(
        fs::read(assets.join("project-old").join("asset-old").join("source.png")).unwrap(),
        b"old source",
        "merging never removes asset files"
    );
    assert!(!staging.exists());

    let name = outcome.pre_restore_package.expect("the replaced library is packaged");
    assert_eq!(outcome.restored_project_count, 1);
    let previous = plan(root, &staging, &assets).safety_directory.join(name);
    let rollback = stage_backup_package(&previous, &databases.join("rollback"), "drifting-library.db", NOW).unwrap();
    assert_eq!(rollback.projects, vec![BackupProject { id: "project-old".into(), name: "旧项目".into() }]);
    assert_eq!(rollback.asset_file_count, 1);
}

#[test]
fn backups_and_restores_refuse_cloud_bound_libraries() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let database = root.join("hosted.db");
    let connection = library(&database);
    // A Hosted connection in progress: still `local`, but not stable.
    connection
        .execute(
            "UPDATE sync_app_authority SET transition_state = 'connecting', target_mode = 'hosted', attempt_id = 'attempt-1'",
            [],
        )
        .unwrap();
    drop(connection);
    let snapshot_path = root.join("snapshot.sqlite");
    snapshot(&database, &snapshot_path);
    let error = write_backup_package(&snapshot_path, &root.join("assets"), &root.join("out.drifting"), "0.1.0-test", 1)
        .unwrap_err();
    assert!(error.starts_with("library-sync-connected"), "{error}");
    assert!(!root.join("out.drifting").exists());

    let source = root.join("source");
    fs::create_dir_all(&source).unwrap();
    let (package, _) = source_backup(&source);
    let databases = root.join("databases");
    fs::create_dir_all(&databases).unwrap();
    let staging = databases.join("restore");
    stage_backup_package(&package, &staging, "drifting-library.db", NOW).unwrap();
    let error = restore_staged_backup(&databases, &database, &plan(root, &staging, &root.join("assets")))
        .unwrap_err();
    assert!(error.starts_with("library-sync-connected"), "{error}");
    let still_connecting: String = Connection::open(&database)
        .unwrap()
        .query_row("SELECT transition_state FROM sync_app_authority", [], |row| row.get(0))
        .unwrap();
    assert_eq!(still_connecting, "connecting", "a refused restore leaves the library untouched");
}

fn rewrite_package(source: &Path, destination: &Path, edit: impl Fn(&str, Vec<u8>) -> Option<Vec<u8>>, extra: Option<(&str, &[u8])>) {
    let mut archive = ZipArchive::new(File::open(source).unwrap()).unwrap();
    let mut zip = ZipWriter::new(File::create(destination).unwrap());
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).unwrap();
        let name = entry.name().to_owned();
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).unwrap();
        if let Some(bytes) = edit(&name, bytes) {
            zip.start_file(name, SimpleFileOptions::default()).unwrap();
            zip.write_all(&bytes).unwrap();
        }
    }
    if let Some((name, bytes)) = extra {
        zip.start_file(name, SimpleFileOptions::default()).unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap();
}

#[test]
fn staging_rejects_tampered_unexpected_and_traversal_entries() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let (package, _) = source_backup(root);

    let tampered = root.join("tampered.drifting");
    rewrite_package(
        &package,
        &tampered,
        |name, bytes| Some(if name.ends_with("source.png") { b"backup sourcX".to_vec() } else { bytes }),
        None,
    );
    let error = stage_backup_package(&tampered, &root.join("s1"), "u", NOW).unwrap_err();
    assert!(error.contains("checksum"), "{error}");
    assert!(!root.join("s1").exists(), "failed staging is removed");

    let extra = root.join("extra.drifting");
    rewrite_package(&package, &extra, |_, bytes| Some(bytes), Some(("notes.txt", b"hello")));
    let error = stage_backup_package(&extra, &root.join("s2"), "u", NOW).unwrap_err();
    assert!(error.contains("unexpected entries"), "{error}");

    let traversal = root.join("traversal.drifting");
    rewrite_package(
        &package,
        &traversal,
        |name, bytes| {
            Some(if name == MANIFEST_PATH {
                String::from_utf8(bytes)
                    .unwrap()
                    .replace("assets/project-new/asset-kept/source.png", "assets/../../escape/source.png")
                    .into_bytes()
            } else {
                bytes
            })
        },
        None,
    );
    let error = stage_backup_package(&traversal, &root.join("s3"), "u", NOW).unwrap_err();
    assert!(error.contains("invalid asset path"), "{error}");

    let not_zip = root.join("plain.drifting");
    fs::write(&not_zip, b"not a zip").unwrap();
    let error = stage_backup_package(&not_zip, &root.join("s4"), "u", NOW).unwrap_err();
    assert!(error.starts_with("backup-invalid"), "{error}");
}

#[test]
fn staging_rejects_a_backup_from_a_newer_build() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let (package, _) = source_backup(root);
    let newer = root.join("newer.drifting");
    let database = root.join("newer.sqlite");
    let manifest_bytes = {
        let mut archive = ZipArchive::new(File::open(&package).unwrap()).unwrap();
        let mut bytes = Vec::new();
        archive.by_name(DATABASE_PATH).unwrap().read_to_end(&mut bytes).unwrap();
        fs::write(&database, bytes).unwrap();
        let connection = Connection::open(&database).unwrap();
        connection
            .execute(
                "INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('future', 99999999999999)",
                [],
            )
            .unwrap();
        drop(connection);
        let (sha256, size_bytes) = file_sha256(&database).unwrap();
        let mut manifest: BackupManifest = {
            let mut bytes = Vec::new();
            archive.by_name(MANIFEST_PATH).unwrap().read_to_end(&mut bytes).unwrap();
            serde_json::from_slice(&bytes).unwrap()
        };
        manifest.database.sha256 = sha256;
        manifest.database.size_bytes = size_bytes;
        serde_json::to_vec(&manifest).unwrap()
    };
    let database_bytes = fs::read(&database).unwrap();
    rewrite_package(
        &package,
        &newer,
        |name, bytes| {
            Some(match name {
                MANIFEST_PATH => manifest_bytes.clone(),
                DATABASE_PATH => database_bytes.clone(),
                _ => bytes,
            })
        },
        None,
    );
    let error = stage_backup_package(&newer, &root.join("staging"), "u", NOW).unwrap_err();
    assert!(error.starts_with("backup-newer"), "{error}");
}

#[test]
fn pre_restore_packages_keep_the_three_newest() {
    let directory = tempfile::tempdir().unwrap();
    for stamp in 1..=5u64 {
        fs::write(
            directory.path().join(format!("{PRE_RESTORE_PREFIX}{stamp:016}.{BACKUP_EXTENSION}")),
            b"x",
        )
        .unwrap();
    }
    fs::write(directory.path().join("unrelated.drifting"), b"x").unwrap();
    retain_recent_pre_restore_packages(directory.path()).unwrap();
    let mut names: Vec<_> = fs::read_dir(directory.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    assert_eq!(
        names,
        [
            format!("{PRE_RESTORE_PREFIX}0000000000000003.drifting"),
            format!("{PRE_RESTORE_PREFIX}0000000000000004.drifting"),
            format!("{PRE_RESTORE_PREFIX}0000000000000005.drifting"),
            "unrelated.drifting".to_owned(),
        ]
    );
}

#[test]
fn gateway_restore_replaces_the_open_library_or_reopens_it_on_failure() {
    use crate::database::{DatabaseGateway, DatabaseValue};
    const SESSION: &str = "backup-renderer";
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let source = root.join("source");
    fs::create_dir_all(&source).unwrap();
    let (package, _) = source_backup(&source);
    let databases = root.join("databases");
    let assets = root.join("assets");
    let gateway = DatabaseGateway::new(databases.clone()).unwrap();
    gateway
        .open("drifting-library.db".into(), SESSION.into(), false)
        .unwrap();
    gateway
        .execute(
            "INSERT INTO project (id, name, user_id, created_at, updated_at) VALUES ('project-old', '旧项目', 'drifting-library.db', ?1, ?1)".into(),
            vec![DatabaseValue::Text(NOW.into())],
            None,
            SESSION.into(),
        )
        .unwrap();
    let project_ids = |session: &str| -> Result<Vec<DatabaseValue>, String> {
        gateway
            .query("SELECT id FROM project".into(), Vec::new(), None, session.into())
            .map(|result| result.rows.into_iter().flatten().collect())
    };

    let snapshot_path = root.join("gateway-snapshot.sqlite");
    gateway
        .snapshot_active_database(snapshot_path.clone(), SESSION.into())
        .unwrap();
    let exported =
        write_backup_package(&snapshot_path, &assets, &root.join("gateway.drifting"), "0.1.0-test", 3).unwrap();
    assert_eq!(exported.projects[0].id, "project-old");

    let mut restore = plan(root, &databases.join("library-restore").join("absent"), &assets);
    restore.app_version = env!("CARGO_PKG_VERSION").into();
    let error = gateway
        .restore_library_backup("drifting-library.db".into(), restore.clone(), SESSION.into())
        .unwrap_err();
    assert!(error.contains("no longer available"), "{error}");
    assert_eq!(
        project_ids(SESSION).unwrap(),
        vec![DatabaseValue::Text("project-old".into())],
        "a failed restore reopens the original library for the same renderer"
    );

    restore.staging = databases.join("library-restore").join("restore-1");
    stage_backup_package(&package, &restore.staging, "drifting-library.db", NOW).unwrap();
    let outcome = gateway
        .restore_library_backup("drifting-library.db".into(), restore, SESSION.into())
        .unwrap();
    assert!(outcome.pre_restore_package.is_some());
    assert!(project_ids(SESSION).is_err(), "the restored library stays closed");
    gateway
        .open("drifting-library.db".into(), "reloaded-renderer".into(), false)
        .unwrap();
    assert_eq!(
        project_ids("reloaded-renderer").unwrap(),
        vec![DatabaseValue::Text("project-new".into())]
    );
}
