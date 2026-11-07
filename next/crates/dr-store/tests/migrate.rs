//! The migration runner: baseline, safety snapshots, shadow migrations, and
//! a byte-identical library whenever a migration fails.

mod common;

use std::path::Path;

use common::*;
use dr_store::migrate::{FaultMode, MigrationFault};
use dr_store::{Library, MIGRATIONS, Migration, MigrationStage, Origin, StoreError};

const ADD_TABLE: Migration = Migration {
    name: "0001_test_add_table",
    sql: "CREATE TABLE test_added (id INTEGER PRIMARY KEY, note TEXT NOT NULL) STRICT;
          INSERT INTO test_added (note) SELECT doc_id FROM loro_doc;",
};

const BROKEN: Migration = Migration {
    name: "0001_test_broken",
    sql: "CREATE TABLE test_half (id INTEGER PRIMARY KEY); INSERT INTO no_such_table VALUES (1);",
};

fn later() -> Vec<Migration> {
    let mut m = MIGRATIONS.to_vec();
    m.push(ADD_TABLE);
    m
}

fn broken() -> Vec<Migration> {
    let mut m = MIGRATIONS.to_vec();
    m.push(BROKEN);
    m
}

/// A library with one document holding some text, closed cleanly.
fn seeded(dir: &Path) -> String {
    let lib = open(dir);
    let h = create(&lib, "node:a");
    insert(&h, Origin::User, 0, "春风十里");
    let content = text(h.doc());
    h.close();
    lib.close().unwrap();
    content
}

fn shadows(dir: &Path) -> usize {
    std::fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().ends_with(".part"))
        .count()
}

fn wal_is_empty(dir: &Path) -> bool {
    std::fs::metadata(dir.join("library.sqlite-wal"))
        .map(|m| m.len() == 0)
        .unwrap_or(true)
}

#[test]
fn a_new_library_gets_the_baseline_and_reopens_without_a_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let r = lib.open_report().clone();
    assert!(r.created);
    assert_eq!(r.migrations_applied, MIGRATIONS.len());
    assert!(r.safety_snapshot.is_none());
    let epoch = lib.epoch();
    assert_eq!(epoch.len(), 16);
    lib.close().unwrap();

    let lib = open(dir.path());
    let r = lib.open_report();
    assert!(!r.created);
    assert_eq!(r.migrations_applied, 0);
    assert!(r.safety_snapshot.is_none(), "same version, nothing pending");
    assert_eq!(lib.epoch(), epoch);
}

#[test]
fn a_new_app_version_takes_a_safety_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let content = seeded(dir.path());
    let mut o = options();
    o.app_version = "0.2.1-test".into();
    let lib = Library::open(dir.path(), o).unwrap();
    let snap = lib.open_report().safety_snapshot.clone().expect("snapshot");
    assert!(snap.starts_with(dir.path().join("safety-snapshots/0.2.1-test")));
    lib.close().unwrap();
    // The snapshot is a complete library on its own.
    let copy = tempfile::tempdir().unwrap();
    std::fs::copy(&snap, copy.path().join("library.sqlite")).unwrap();
    let lib = open(copy.path());
    assert_eq!(text(&lib.load_copy("node:a").unwrap()), content);
}

#[test]
fn a_later_build_migrates_a_shadow_copy_after_a_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let content = seeded(dir.path());
    let lib = Library::open_with_migrations(dir.path(), options(), &later()).unwrap();
    let r = lib.open_report().clone();
    assert_eq!(r.migrations_applied, 1);
    let snap = r.safety_snapshot.expect("snapshot before migrating");
    assert!(snap.exists());
    assert_eq!(text(&lib.load_copy("node:a").unwrap()), content);
    lib.close().unwrap();
    assert_eq!(shadows(dir.path()), 0);

    // An older build refuses the newer library and leaves it alone.
    let before = sha256_file(&dir.path().join("library.sqlite"));
    match Library::open(dir.path(), options()) {
        Err(StoreError::SchemaNewer { applied, known }) => {
            assert_eq!((applied, known), (MIGRATIONS.len() + 1, MIGRATIONS.len()));
        }
        other => panic!("expected SchemaNewer, got {:?}", other.err()),
    }
    assert_eq!(sha256_file(&dir.path().join("library.sqlite")), before);
    // The newer build still opens it, with nothing to do.
    let lib = Library::open_with_migrations(dir.path(), options(), &later()).unwrap();
    assert_eq!(lib.open_report().migrations_applied, 0);
}

#[test]
fn a_failing_migration_leaves_the_library_byte_identical() {
    let dir = tempfile::tempdir().unwrap();
    let content = seeded(dir.path());
    let db = dir.path().join("library.sqlite");
    assert!(wal_is_empty(dir.path()));
    let before = sha256_file(&db);

    let err = Library::open_with_migrations(dir.path(), options(), &broken())
        .err()
        .expect("must fail");
    let StoreError::Migration(f) = err else {
        panic!("expected a migration failure, got {err}");
    };
    assert_eq!(f.stage, MigrationStage::Migrate);
    assert!(f.source_unchanged());
    assert!(
        f.safety_snapshot.exists(),
        "the snapshot is kept for recovery"
    );
    assert_eq!((f.from, f.to), (MIGRATIONS.len(), MIGRATIONS.len() + 1));
    assert!(f.to_string().contains("not changed"));

    assert_eq!(sha256_file(&db), before, "library bytes unchanged");
    assert_eq!(shadows(dir.path()), 0, "the shadow is discarded");
    let lib = open(dir.path());
    assert_eq!(text(&lib.load_copy("node:a").unwrap()), content);
}

#[test]
fn faults_at_every_stage_before_replacing_leave_the_library_unchanged() {
    for stage in [
        MigrationStage::Snapshot,
        MigrationStage::Copy,
        MigrationStage::Migrate,
        MigrationStage::Validate,
        MigrationStage::Replace,
    ] {
        for mode in [FaultMode::Fail, FaultMode::Crash] {
            let dir = tempfile::tempdir().unwrap();
            let content = seeded(dir.path());
            let db = dir.path().join("library.sqlite");
            let before = sha256_file(&db);
            let mut o = options();
            o.migration_fault = Some(MigrationFault { stage, mode });
            let err = Library::open_with_migrations(dir.path(), o, &later())
                .err()
                .unwrap_or_else(|| panic!("{stage:?}/{mode:?} must fail"));
            match &err {
                StoreError::Migration(f) => {
                    assert_eq!(f.stage, stage);
                    assert!(f.source_unchanged());
                }
                other => panic!("{stage:?}/{mode:?}: unexpected {other}"),
            }
            assert_eq!(sha256_file(&db), before, "{stage:?}/{mode:?}: bytes");
            if mode == FaultMode::Fail {
                assert_eq!(shadows(dir.path()), 0, "{stage:?}: shadow removed");
            }
            // The next open (an old build) cleans up and sees the old data.
            let lib = open(dir.path());
            assert_eq!(shadows(dir.path()), 0, "{stage:?}/{mode:?}: stale shadow");
            assert_eq!(text(&lib.load_copy("node:a").unwrap()), content);
            lib.close().unwrap();
            // And the new build migrates it after all.
            let lib = Library::open_with_migrations(dir.path(), options(), &later()).unwrap();
            assert_eq!(
                lib.open_report().migrations_applied,
                1,
                "{stage:?}/{mode:?}"
            );
        }
    }
}

#[test]
fn a_fault_after_replacing_reports_that_the_library_changed() {
    let dir = tempfile::tempdir().unwrap();
    let content = seeded(dir.path());
    let mut o = options();
    o.migration_fault = Some(MigrationFault {
        stage: MigrationStage::Reopen,
        mode: FaultMode::Fail,
    });
    let Err(StoreError::Migration(f)) = Library::open_with_migrations(dir.path(), o, &later())
    else {
        panic!("must fail at reopen");
    };
    assert!(!f.source_unchanged());
    assert!(f.to_string().contains("could not be reopened"));
    let lib = Library::open_with_migrations(dir.path(), options(), &later()).unwrap();
    assert_eq!(lib.open_report().migrations_applied, 0, "already migrated");
    assert_eq!(text(&lib.load_copy("node:a").unwrap()), content);
}

#[test]
fn an_edited_migration_is_refused_without_touching_the_library() {
    let dir = tempfile::tempdir().unwrap();
    seeded(dir.path());
    let db = dir.path().join("library.sqlite");
    let before = sha256_file(&db);
    let edited_sql = format!("{}\n-- edited\n", MIGRATIONS[0].sql);
    let edited = [Migration {
        name: MIGRATIONS[0].name,
        sql: Box::leak(edited_sql.into_boxed_str()),
    }];
    match Library::open_with_migrations(dir.path(), options(), &edited) {
        Err(StoreError::SchemaMismatch(_)) => {}
        other => panic!("expected SchemaMismatch, got {:?}", other.err()),
    }
    assert_eq!(sha256_file(&db), before);
}

#[test]
fn a_foreign_database_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let conn = rusqlite::Connection::open(dir.path().join("library.sqlite")).unwrap();
    conn.execute_batch("CREATE TABLE something (x); INSERT INTO something VALUES (1);")
        .unwrap();
    drop(conn);
    assert!(matches!(
        Library::open(dir.path(), options()),
        Err(StoreError::SchemaMismatch(_))
    ));
}

#[test]
fn a_library_is_open_once() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    assert!(Library::open(dir.path(), options()).is_err());
    lib.close().unwrap();
    open(dir.path());
}

#[test]
fn restoring_a_backup_starts_a_new_epoch() {
    let dir = tempfile::tempdir().unwrap();
    seeded(dir.path());
    // Take a backup by opening with a new version.
    let mut o = options();
    o.app_version = "0.2.1-test".into();
    let lib = Library::open(dir.path(), o).unwrap();
    let backup = lib.open_report().safety_snapshot.clone().unwrap();
    let old_epoch = lib.epoch();
    let old_peer = lib.peer_for("node:a").unwrap();
    let h = lib.open_doc("node:a", dr_store::OpenDoc::Existing).unwrap();
    insert(&h, Origin::User, 0, "后来写的");
    h.close();
    lib.close().unwrap();

    let lib = Library::restore_backup(dir.path(), &backup, options()).unwrap();
    assert_ne!(lib.epoch(), old_epoch);
    assert_ne!(
        lib.peer_for("node:a").unwrap(),
        old_peer,
        "new peer after restore"
    );
    let restored = text(&lib.load_copy("node:a").unwrap());
    assert!(!restored.contains("后来写的"), "the backup's state");
    assert!(restored.contains("春风十里"));
}

fn receipts(dir: &Path) -> Vec<dr_store::migrate::RecoveryReceipt> {
    Library::recovery_receipts(dir).unwrap()
}

/// Leave a receipt behind as a crash at the copy stage would.
fn crashed_attempt(dir: &Path) -> dr_store::migrate::RecoveryReceipt {
    let mut o = options();
    o.migration_fault = Some(MigrationFault {
        stage: MigrationStage::Copy,
        mode: FaultMode::Crash,
    });
    assert!(Library::open_with_migrations(dir, o, &later()).is_err());
    let mut r = receipts(dir);
    assert_eq!(r.len(), 1);
    r.remove(0)
}

#[test]
fn a_failed_migration_keeps_its_receipt_until_the_next_open() {
    let dir = tempfile::tempdir().unwrap();
    seeded(dir.path());
    let Err(StoreError::Migration(f)) =
        Library::open_with_migrations(dir.path(), options(), &broken())
    else {
        panic!("must fail");
    };
    let r = receipts(dir.path());
    assert_eq!(r.len(), 1);
    assert_eq!(Some(&r[0].recovery_id), f.recovery_id.as_ref());
    assert_eq!(r[0].failed_stage.as_deref(), Some("migrate"));
    assert_eq!(
        (r[0].from_migrations, r[0].to_migrations),
        (MIGRATIONS.len(), MIGRATIONS.len() + 1)
    );
    assert_eq!(r[0].shadow_file, None, "the shadow was cleaned up");
    let snapshot =
        dr_store::migrate::verified_snapshot(&dir.path().join("safety-snapshots"), &r[0]).unwrap();
    assert_eq!(snapshot, f.safety_snapshot);
    // The next open settles the receipt (and, here, works with the old list).
    open(dir.path());
    assert!(receipts(dir.path()).is_empty());
}

#[test]
fn a_malformed_receipt_stops_the_open_instead_of_guessing() {
    let dir = tempfile::tempdir().unwrap();
    seeded(dir.path());
    let before = sha256_file(&dir.path().join("library.sqlite"));
    let recovery = dir.path().join("safety-snapshots/recovery");
    std::fs::create_dir_all(&recovery).unwrap();
    let id = "0123456789abcdef".repeat(4);
    std::fs::write(recovery.join(format!("{id}.json")), b"{not-json").unwrap();
    match Library::open(dir.path(), options()) {
        Err(StoreError::Recovery { recovery_id, code }) => {
            assert_eq!(
                (recovery_id.as_str(), code),
                (id.as_str(), "recovery-receipt-invalid")
            );
        }
        other => panic!("expected a recovery stop, got {:?}", other.err()),
    }
    assert_eq!(sha256_file(&dir.path().join("library.sqlite")), before);
}

#[test]
fn a_changed_safety_snapshot_stops_the_open() {
    let dir = tempfile::tempdir().unwrap();
    seeded(dir.path());
    let r = crashed_attempt(dir.path());
    let snapshot = dir.path().join("safety-snapshots").join(&r.snapshot_file);
    std::fs::write(&snapshot, b"tampered").unwrap();
    assert!(matches!(
        Library::open(dir.path(), options()),
        Err(StoreError::Recovery {
            code: "safety-snapshot-invalid",
            ..
        })
    ));
}

#[test]
fn an_incomplete_replacement_stops_the_open_and_migrates_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let content = seeded(dir.path());
    let mut r = crashed_attempt(dir.path());
    // Pretend the crash happened after the rename: the receipt says
    // "replacing", the shadow is gone, but the library is the old one.
    r.state = dr_store::migrate::ReceiptState::Replacing;
    r.shadow_file = Some(".library.sqlite.gone.part".into());
    dr_store::migrate::write_receipt(&dir.path().join("safety-snapshots"), &r).unwrap();
    assert!(matches!(
        Library::open_with_migrations(dir.path(), options(), &later()),
        Err(StoreError::Recovery {
            code: "activated-database-invalid",
            ..
        })
    ));
    let conn = rusqlite::Connection::open(dir.path().join("library.sqlite")).unwrap();
    let applied: i64 = conn
        .query_row("SELECT count(*) FROM schema_migration", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        applied as usize,
        MIGRATIONS.len(),
        "nothing migrated while the receipt is unsettled"
    );
    drop(conn);
    // The way out: restore the receipt's snapshot.
    let lib = Library::restore_from_receipt(dir.path(), &r.recovery_id, options()).unwrap();
    assert_eq!(text(&lib.load_copy("node:a").unwrap()), content);
    assert!(receipts(dir.path()).is_empty());
}

#[test]
fn a_completed_replacement_clears_its_receipt_after_validating() {
    let dir = tempfile::tempdir().unwrap();
    seeded(dir.path());
    let mut o = options();
    o.migration_fault = Some(MigrationFault {
        stage: MigrationStage::Reopen,
        mode: FaultMode::Crash,
    });
    assert!(Library::open_with_migrations(dir.path(), o, &later()).is_err());
    let r = receipts(dir.path());
    assert_eq!(r[0].state, dr_store::migrate::ReceiptState::Replacing);
    let lib = Library::open_with_migrations(dir.path(), options(), &later()).unwrap();
    assert_eq!(lib.open_report().migrations_applied, 0);
    assert!(receipts(dir.path()).is_empty());
}

#[test]
fn a_baseline_library_gets_the_later_published_migrations() {
    let dir = tempfile::tempdir().unwrap();
    // A library made by a build that only had the baseline: its schema, and
    // rows written the way that build wrote them.
    let lib = Library::open_with_migrations(dir.path(), options(), &MIGRATIONS[..1]).unwrap();
    lib.close().unwrap();
    let doc = loro::LoroDoc::new();
    doc.get_text(common::synthetic::BODY)
        .insert(0, "旧库里的字\n")
        .unwrap();
    doc.commit();
    let conn = rusqlite::Connection::open(dir.path().join("library.sqlite")).unwrap();
    conn.execute_batch(
        "INSERT INTO loro_doc VALUES ('node:a', 'node', NULL, 0);
         INSERT INTO history_label (doc_id, frontiers, label, ts) VALUES ('node:a', x'', 'periodic', 1);",
    )
    .unwrap();
    conn.execute(
        "INSERT INTO loro_update VALUES ('node:a', 1, ?1, 'user', 1)",
        [doc.export(loro::ExportMode::all_updates()).unwrap()],
    )
    .unwrap();
    drop(conn);

    let lib = open(dir.path());
    let r = lib.open_report().clone();
    assert_eq!(r.migrations_applied, MIGRATIONS.len() - 1);
    assert!(r.safety_snapshot.is_some(), "snapshot before migrating");
    assert_eq!(text(&lib.load_copy("node:a").unwrap()), "旧库里的字\n");
    let conn = rusqlite::Connection::open(dir.path().join("library.sqlite")).unwrap();
    let keep: i64 = conn
        .query_row(
            "SELECT keep FROM history_label WHERE doc_id = 'node:a'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(keep, 0, "existing labels follow the usual retention");
    drop(conn);
    let runs: i64 = lib
        .local_read(|c| Ok(c.query_row("SELECT count(*) FROM import_run", [], |r| r.get(0))?))
        .unwrap();
    assert_eq!(runs, 0, "the import receipt tables exist");
}
