//! Migrations killed at every stage, on dr-testkit's crash harness. (Kills
//! while editing are `crash_store`, on a real holder.) This is dr-store's
//! test; it lives here because the harness writes libraries through
//! dr-store, and dr-store depending on dr-testkit, even for tests, would
//! close a cycle that dx's hot patching refuses (see `dr-corpus`).
//!
//! For each stage a writer process opens a seeded library with a later
//! build's migrations and pauses at that stage; the pause reports "ready" to
//! the harness, which kills the process there. Then: before the replacement
//! the library is byte-for-byte unchanged and an older build opens it; after
//! it, the newer build opens it without migrating again. Either way the next
//! newer build ends up migrated with the text intact, and the attempt's
//! recovery receipt is settled.

#[path = "../../dr-store/tests/common/mod.rs"]
mod common;

use std::path::Path;

use common::*;
use dr_store::digest::file_sha256;
use dr_store::migrate::{FaultMode, MigrationFault};
use dr_store::{Library, MIGRATIONS, Migration, MigrationStage, OpenDoc, Origin};
use dr_testkit::crash::{self, Harness, Recovered, Reporter};

const DOC: &str = "node:crash-probe";

/// What a later build appends.
const LATER: Migration = Migration {
    name: "9999_crash_probe",
    sql: "CREATE TABLE crash_probe (id INTEGER PRIMARY KEY, note TEXT NOT NULL) STRICT;
          INSERT INTO crash_probe (note) SELECT doc_id FROM loro_doc;",
};

fn later() -> Vec<Migration> {
    let mut m = MIGRATIONS.to_vec();
    m.push(LATER);
    m
}

fn lib_dir(root: &Path) -> std::path::PathBuf {
    root.join("lib")
}

fn stage_of(index: usize) -> MigrationStage {
    MigrationStage::ALL[index % MigrationStage::ALL.len()]
}

/// A fresh library with one document, and the stage the next writer stops
/// at. Returns the document's text and the library file's hash.
fn prepare(root: &Path, stage: MigrationStage) -> (String, String) {
    let _ = std::fs::remove_dir_all(root);
    std::fs::create_dir_all(root).unwrap();
    std::fs::write(root.join("stage"), stage.as_str()).unwrap();
    let lib = Library::open(lib_dir(root), options()).unwrap();
    let h = lib
        .open_doc(
            DOC,
            OpenDoc::CreateIfMissing {
                kind: "node",
                book_id: None,
                genesis: &genesis,
            },
        )
        .unwrap();
    for i in 0..20 {
        insert(&h, Origin::User, 0, &format!("第{i}句。"));
    }
    h.compact_now().unwrap();
    let content = text(h.doc());
    h.close();
    lib.close().unwrap();
    let hash = file_sha256(&lib_dir(root).join("library.sqlite"))
        .unwrap()
        .0;
    (content, hash)
}

fn shadows(dir: &Path) -> usize {
    std::fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().ends_with(".part"))
        .count()
}

/// The writer: opens the library with the later migrations and pauses at
/// the stage written beside it; the pause tells the harness to kill.
#[test]
fn migration_writer() {
    let Some(root) = crash::child_root() else {
        return;
    };
    let stage = std::fs::read_to_string(root.join("stage")).unwrap();
    let stage = MigrationStage::parse(stage.trim()).unwrap();
    dr_store::migrate::on_migration_pause(|stage| {
        let mut r = Reporter::new();
        r.phase(stage.as_str());
    });
    let mut o = options();
    o.migration_fault = Some(MigrationFault {
        stage,
        mode: FaultMode::Pause,
    });
    let _ = Library::open_with_migrations(lib_dir(&root), o, &later());
    unreachable!("the migration pauses until it is killed");
}

#[test]
fn migrations_killed_at_every_stage_recover() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("run");
    let mut expected = prepare(&root, stage_of(0));
    let stages = MigrationStage::ALL.len();
    let report = Harness::for_test("migration_writer")
        .kills(stages)
        .delay_ms(5, 30)
        .run(&root, |kill, root| {
            let stage = stage_of(kill.index);
            if kill.phase != stage.as_str() {
                return Err(format!("killed in {} instead of {stage}", kill.phase));
            }
            let lib_root = lib_dir(root);
            let db = lib_root.join("library.sqlite");
            let unchanged = file_sha256(&db).map_err(|e| e.to_string())?.0 == expected.1;
            let replaced = stage == MigrationStage::Reopen;
            if unchanged == replaced {
                return Err(format!("{stage}: library bytes unchanged = {unchanged}"));
            }
            // An older build: opens the old library (cleaning up), refuses
            // the replaced one without touching it.
            match Library::open(&lib_root, options()) {
                Ok(lib) if !replaced => {
                    if shadows(&lib_root) != 0 {
                        return Err(format!("{stage}: a stale shadow survived the open"));
                    }
                    if text(&lib.load_copy(DOC).map_err(|e| e.to_string())?) != expected.0 {
                        return Err(format!("{stage}: the old build lost text"));
                    }
                    lib.close().map_err(|e| e.to_string())?;
                }
                Err(dr_store::StoreError::SchemaNewer { .. }) if replaced => {}
                other => return Err(format!("{stage}: older build got {:?}", other.err())),
            }
            // The newer build: migrated, text intact, receipt settled.
            let lib = Library::open_with_migrations(&lib_root, options(), &later())
                .map_err(|e| e.to_string())?;
            let migrated = lib.open_report().migrations_applied;
            if migrated != usize::from(!replaced) {
                return Err(format!("{stage}: migrated {migrated} on the next open"));
            }
            if text(&lib.load_copy(DOC).map_err(|e| e.to_string())?) != expected.0 {
                return Err(format!("{stage}: the new build lost text"));
            }
            lib.close().map_err(|e| e.to_string())?;
            if !Library::recovery_receipts(&lib_root)
                .map_err(|e| e.to_string())?
                .is_empty()
            {
                return Err(format!("{stage}: a recovery receipt is left"));
            }
            if kill.index + 1 < stages {
                expected = prepare(root, stage_of(kill.index + 1));
            }
            Ok(Recovered { step: -1 })
        })
        .unwrap();
    assert_eq!(report.kills, stages);
    assert_eq!(report.by_phase.len(), stages, "{:?}", report.by_phase);
}
