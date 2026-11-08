//! Whole-library backups: export while open, check and stage, replace with a
//! pre-restore backup first, a new epoch, assets added and never removed;
//! bad, old and newer backups refused with nothing changed.

mod common;

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use common::*;
use dr_store::asset::{SourceImport, Variant};
use dr_store::backup::{self, StagedBackup};
use dr_store::{Library, MIGRATIONS, Migration, OpenDoc, Origin, StoreError};

fn source<'a>(book: &'a str, asset: &'a str, path: &'a Path) -> SourceImport<'a> {
    SourceImport {
        book_id: book,
        asset_id: asset,
        source: path,
        mime: "image/png",
        ext: "png",
        dimensions: Some((4, 3)),
        limit: 1024,
    }
}

fn create_in(lib: &Library, doc_id: &str, book: &str, text: &str) {
    let h = lib
        .open_doc(
            doc_id,
            OpenDoc::CreateIfMissing {
                kind: "node",
                book_id: Some(book),
                genesis: &genesis,
            },
        )
        .unwrap();
    insert(&h, Origin::User, 0, text);
    h.close();
}

fn body(lib: &Library, doc_id: &str) -> String {
    text(&lib.load_copy(doc_id).unwrap())
}

fn code(e: StoreError) -> &'static str {
    match e {
        StoreError::Backup { code, .. } => code,
        other => panic!("not a backup error: {other}"),
    }
}

/// The library's files, for "nothing changed".
fn fingerprint(root: &Path) -> Vec<(PathBuf, String)> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for e in fs::read_dir(&dir).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                stack.push(p);
            } else if !p.ends_with("library.lock") {
                out.push((p.strip_prefix(root).unwrap().to_path_buf(), sha256_file(&p)));
            }
        }
    }
    out.sort();
    out
}

/// Copy `package` to `out`, changing entries with `f` (None drops one) and
/// adding `extra`.
fn rewrite(
    package: &Path,
    out: &Path,
    f: impl Fn(&str, Vec<u8>) -> Option<Vec<u8>>,
    extra: Option<(&str, &[u8])>,
) {
    let mut archive = zip::ZipArchive::new(fs::File::open(package).unwrap()).unwrap();
    let mut zip = zip::ZipWriter::new(fs::File::create(out).unwrap());
    for i in 0..archive.len() {
        let mut e = archive.by_index(i).unwrap();
        let name = e.name().unwrap().to_string();
        let mut bytes = Vec::new();
        e.read_to_end(&mut bytes).unwrap();
        if let Some(bytes) = f(&name, bytes) {
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(&bytes).unwrap();
        }
    }
    if let Some((name, bytes)) = extra {
        zip.start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap();
}

#[test]
fn a_backup_puts_the_library_back_as_it_was_and_the_restore_can_be_undone() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let files = tempfile::tempdir().unwrap();
    let png = files.path().join("a.png");
    fs::write(&png, b"\x89PNG one").unwrap();
    let lib = open(&root);
    create_in(&lib, "node:a", "book-1", "第一章原文");
    create_in(&lib, "node:b", "book-2", "另一本书");
    lib.import_asset(&source("book-1", "asset-1", &png))
        .unwrap();
    lib.local_set("ws", "recent", "[1]", None).unwrap();
    create_in(&lib, "node:gone", "book-1", "删掉的");
    lib.purge_doc("node:gone").unwrap();
    let epoch_before = lib.epoch();

    let package = files.path().join("Drifting.drifting");
    let names = HashMap::from([("book-1".to_string(), "甲书".to_string())]);
    let exported = lib.export_backup(&package, &names).unwrap();
    assert_eq!(exported.documents, 2);
    let books: Vec<(String, Option<String>, u64)> = exported
        .books
        .iter()
        .map(|b| (b.id.clone(), b.name.clone(), b.documents))
        .collect();
    assert_eq!(
        books,
        [
            ("book-1".to_string(), Some("甲书".to_string()), 1),
            ("book-2".to_string(), None, 1)
        ]
    );
    assert_eq!((exported.asset_files, exported.missing_assets), (1, 0));
    assert_eq!(
        exported.package_bytes,
        fs::metadata(&package).unwrap().len()
    );
    // Nothing is left behind in the library.
    assert!(!root.join("export-staging").exists());

    // The author carries on after the backup.
    let h = lib.open_doc("node:a", OpenDoc::Existing).unwrap();
    insert(&h, Origin::User, 0, "后来写的");
    h.close();
    create_in(&lib, "node:c", "book-1", "备份以后的新章");
    let png2 = files.path().join("b.png");
    fs::write(&png2, b"\x89PNG two").unwrap();
    lib.import_asset(&source("book-1", "asset-2", &png2))
        .unwrap();
    let after_backup = body(&lib, "node:a");

    // Checked while the library is open; replacing needs it closed.
    let staged = backup::stage(&root, &package, VERSION).unwrap();
    let mut want = exported.clone();
    want.package_bytes = staged.summary().package_bytes;
    assert_eq!(*staged.summary(), want);
    assert!(Library::restore_staged(&root, &staged, options()).is_err());
    lib.close().unwrap();
    let (lib, outcome) = Library::restore_staged(&root, &staged, options()).unwrap();
    drop(staged);
    assert!(!root.join("restore-staging").exists());

    assert_eq!(body(&lib, "node:a"), "第一章原文\n");
    assert_eq!(body(&lib, "node:b"), "另一本书\n");
    assert_eq!(lib.doc_info("node:c").unwrap(), None);
    assert_eq!(
        lib.local_get("ws", "recent").unwrap().as_deref(),
        Some("[1]")
    );
    assert!(lib.purged("node:gone").unwrap().is_some());
    assert_ne!(
        lib.epoch(),
        epoch_before,
        "a restored library starts a new epoch"
    );
    let a1 = lib.asset("asset-1", Variant::Source).unwrap().unwrap();
    assert_eq!(fs::read(&a1.path).unwrap(), b"\x89PNG one");
    // Asset files are added, never removed: the later one is still there.
    assert!(
        root.join("assets/book-1/asset-2/source.png").is_file(),
        "no asset file is removed"
    );
    assert_eq!(lib.asset("asset-2", Variant::Source).unwrap(), None);
    // The library keeps working.
    let h = lib.open_doc("node:a", OpenDoc::Existing).unwrap();
    insert(&h, Origin::User, 0, "恢复后");
    h.close();

    // The library as it was before the restore was saved, and restoring it
    // takes the restore back.
    let pre = outcome.pre_restore.unwrap();
    assert_eq!(
        Library::pre_restore_backups(&root).unwrap(),
        std::slice::from_ref(&pre)
    );
    let staged = backup::stage(&root, &pre, VERSION).unwrap();
    assert_eq!(staged.summary().documents, 3);
    lib.close().unwrap();
    let (lib, outcome) = Library::restore_staged(&root, &staged, options()).unwrap();
    assert_eq!(body(&lib, "node:a"), after_backup);
    assert_eq!(body(&lib, "node:c"), "备份以后的新章\n");
    assert!(lib.asset("asset-2", Variant::Source).unwrap().is_some());
    assert_eq!(Library::pre_restore_backups(&root).unwrap().len(), 2);
    assert!(outcome.pre_restore.is_some());
    lib.close().unwrap();
}

#[test]
fn bad_old_and_newer_backups_are_refused_and_nothing_changes() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let files = tempfile::tempdir().unwrap();
    let png = files.path().join("a.png");
    fs::write(&png, b"\x89PNG one").unwrap();
    let lib = open(&root);
    create_in(&lib, "node:a", "book-1", "原文");
    lib.import_asset(&source("book-1", "asset-1", &png))
        .unwrap();
    let good = files.path().join("good.drifting");
    lib.export_backup(&good, &HashMap::new()).unwrap();
    lib.close().unwrap();
    let before = fingerprint(&root);

    let refused = |package: &Path| -> &'static str {
        let e = backup::stage(&root, package, VERSION).unwrap_err();
        assert!(!root.join("restore-staging").exists());
        code(e)
    };
    let path = |name: &str| files.path().join(name);

    fs::write(path("noise.drifting"), b"not a zip at all").unwrap();
    assert_eq!(refused(&path("noise.drifting")), backup::INVALID);

    let with_manifest = |name: &str, json: &str| {
        let json = json.to_string();
        rewrite(
            &good,
            &path(name),
            move |n, b| {
                Some(if n == "manifest.json" {
                    json.clone().into_bytes()
                } else {
                    b
                })
            },
            None,
        );
        path(name)
    };
    let v1 = with_manifest(
        "v1.drifting",
        r#"{"format":"drifting-library-backup","formatVersion":1,"projects":[]}"#,
    );
    assert_eq!(refused(&v1), backup::LEGACY);
    let v3 = with_manifest(
        "v3.drifting",
        r#"{"format":"drifting-library-backup","formatVersion":3}"#,
    );
    assert_eq!(refused(&v3), backup::NEWER);
    let other = with_manifest("other.drifting", r#"{"format":"x","formatVersion":2}"#);
    assert_eq!(refused(&other), backup::INVALID);

    // An asset file changed after the backup was written.
    rewrite(
        &good,
        &path("flipped.drifting"),
        |n, mut b| {
            if n.starts_with("assets/") {
                b[0] ^= 1;
            }
            Some(b)
        },
        None,
    );
    assert_eq!(refused(&path("flipped.drifting")), backup::INVALID);
    // A file the manifest does not list, and one it lists but is missing.
    rewrite(
        &good,
        &path("extra.drifting"),
        |_, b| Some(b),
        Some(("notes.txt", b"x")),
    );
    assert_eq!(refused(&path("extra.drifting")), backup::INVALID);
    rewrite(
        &good,
        &path("short.drifting"),
        |n, b| (!n.starts_with("assets/")).then_some(b),
        None,
    );
    assert_eq!(refused(&path("short.drifting")), backup::INVALID);

    // A library a newer build has migrated: saved there, refused here.
    let newer_root = dir.path().join("newer");
    let later: Vec<Migration> = MIGRATIONS
        .iter()
        .copied()
        .chain([Migration {
            name: "9999_later",
            sql: "CREATE TABLE later_build (x INTEGER) STRICT;",
        }])
        .collect();
    let newer = Library::open_with_migrations(&newer_root, options(), &later).unwrap();
    create_in(&newer, "node:n", "book-1", "新版");
    newer
        .export_backup(&path("newer.drifting"), &HashMap::new())
        .unwrap();
    newer.close().unwrap();
    assert_eq!(refused(&path("newer.drifting")), backup::NEWER);

    assert_eq!(fingerprint(&root), before, "the library is untouched");
    let lib = open(&root);
    assert_eq!(body(&lib, "node:a"), "原文\n");
    lib.close().unwrap();
}

/// A backup from an older build is upgraded while it is staged, so a
/// migration that fails would fail before the library is touched.
#[test]
fn an_older_backup_is_upgraded_while_staged() {
    let dir = tempfile::tempdir().unwrap();
    let files = tempfile::tempdir().unwrap();
    let old_root = dir.path().join("old");
    let before_local_state = MIGRATIONS
        .iter()
        .position(|m| m.name == "0004_local_state")
        .unwrap();
    {
        // Written by this build, then taken back to the older schema: the
        // later migrations only add tables and an index (and move one
        // setting).
        let lib = open(&old_root);
        create_in(&lib, "node:a", "book-1", "旧版写的");
        lib.close().unwrap();
        let conn = rusqlite::Connection::open(old_root.join("library.sqlite")).unwrap();
        conn.execute_batch(
            "DROP TABLE agent_event; DROP TABLE agent_session;
             DROP TABLE local_state; DROP TABLE purged_doc; DROP INDEX reference_by_book;
             INSERT INTO library_meta (key, value) VALUES ('ws.recent', '[7]');",
        )
        .unwrap();
        conn.execute(
            "DELETE FROM schema_migration WHERE version >= ?1",
            [before_local_state as i64],
        )
        .unwrap();
    }
    let old =
        Library::open_with_migrations(&old_root, options(), &MIGRATIONS[..before_local_state])
            .unwrap();
    let package = files.path().join("old.drifting");
    old.export_backup(&package, &HashMap::new()).unwrap();
    old.close().unwrap();

    let root = dir.path().join("library");
    let lib = open(&root);
    create_in(&lib, "node:z", "book-9", "现在的");
    let staged = backup::stage(&root, &package, VERSION).unwrap();
    assert_eq!(
        staged.summary().upgraded_migrations,
        MIGRATIONS.len() - before_local_state
    );
    lib.close().unwrap();
    let (lib, _) = Library::restore_staged(&root, &staged, options()).unwrap();
    assert_eq!(body(&lib, "node:a"), "旧版写的\n");
    assert_eq!(
        lib.local_get("ws", "recent").unwrap().as_deref(),
        Some("[7]")
    );
    assert_eq!(lib.doc_info("node:z").unwrap(), None);
    assert!(lib.agent_sessions(None).unwrap().is_empty());
    lib.close().unwrap();
}

/// A failure before the database is replaced leaves the library exactly as
/// it was (its pre-restore backup aside); a library whose database cannot
/// be read at all can still be restored, and is kept as a raw copy.
#[test]
fn a_failed_restore_leaves_the_library_and_a_broken_one_can_be_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let files = tempfile::tempdir().unwrap();
    let png = files.path().join("a.png");
    fs::write(&png, b"\x89PNG one").unwrap();
    let lib = open(&root);
    create_in(&lib, "node:a", "book-1", "备份里的");
    lib.import_asset(&source("book-1", "asset-1", &png))
        .unwrap();
    let package = files.path().join("b.drifting");
    lib.export_backup(&package, &HashMap::new()).unwrap();
    let h = lib.open_doc("node:a", OpenDoc::Existing).unwrap();
    insert(&h, Origin::User, 0, "现在的");
    h.close();
    lib.remove_asset("asset-1").unwrap();
    let staged: StagedBackup = backup::stage(&root, &package, VERSION).unwrap();
    lib.close().unwrap();

    // Something is in the way of an asset file the backup brings back.
    let blocker = root.join("assets/book-1/asset-1/source.png");
    fs::create_dir_all(&blocker).unwrap();
    let db_before = sha256_file(&root.join("library.sqlite"));
    assert!(Library::restore_staged(&root, &staged, options()).is_err());
    assert_eq!(sha256_file(&root.join("library.sqlite")), db_before);
    let lib = open(&root);
    assert_eq!(body(&lib, "node:a"), "现在的备份里的\n");
    lib.close().unwrap();
    fs::remove_dir(&blocker).unwrap();

    // The current database is unreadable: restoring still works.
    fs::write(root.join("library.sqlite"), b"garbage, not a database").unwrap();
    let staged = backup::stage(&root, &package, VERSION).unwrap();
    let (lib, outcome) = Library::restore_staged(&root, &staged, options()).unwrap();
    let raw = outcome.pre_restore.unwrap();
    assert_eq!(raw.extension().and_then(|e| e.to_str()), Some("sqlite"));
    assert_eq!(fs::read(&raw).unwrap(), b"garbage, not a database");
    assert_eq!(body(&lib, "node:a"), "备份里的\n");
    assert!(lib.asset("asset-1", Variant::Source).unwrap().is_some());
    lib.close().unwrap();
}

#[test]
fn only_the_newest_pre_restore_backups_are_kept() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let files = tempfile::tempdir().unwrap();
    let lib = open(&root);
    create_in(&lib, "node:a", "book-1", "一");
    let package = files.path().join("b.drifting");
    lib.export_backup(&package, &HashMap::new()).unwrap();
    lib.close().unwrap();
    let mut seen = Vec::new();
    for _ in 0..(backup::PRE_RESTORE_KEPT + 2) {
        let staged = backup::stage(&root, &package, VERSION).unwrap();
        let (lib, outcome) = Library::restore_staged(&root, &staged, options()).unwrap();
        lib.close().unwrap();
        seen.push(outcome.pre_restore.unwrap());
        // Names carry the millisecond.
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
    let kept = Library::pre_restore_backups(&root).unwrap();
    let mut want: Vec<PathBuf> = seen
        .iter()
        .rev()
        .take(backup::PRE_RESTORE_KEPT)
        .cloned()
        .collect();
    want.sort();
    want.reverse();
    assert_eq!(kept, want);
}

/// A new computer with no library yet: the backup becomes the library, and
/// there is nothing to save first.
#[test]
fn a_backup_restores_into_an_empty_folder() {
    let dir = tempfile::tempdir().unwrap();
    let files = tempfile::tempdir().unwrap();
    let png = files.path().join("a.png");
    fs::write(&png, b"\x89PNG one").unwrap();
    let lib = open(&dir.path().join("old"));
    create_in(&lib, "node:a", "book-1", "带过来的");
    lib.import_asset(&source("book-1", "asset-1", &png))
        .unwrap();
    let package = files.path().join("b.drifting");
    lib.export_backup(&package, &HashMap::new()).unwrap();
    lib.close().unwrap();

    let root = dir.path().join("new");
    let staged = backup::stage(&root, &package, VERSION).unwrap();
    let (lib, outcome) = Library::restore_staged(&root, &staged, options()).unwrap();
    assert_eq!(outcome.pre_restore, None);
    assert_eq!(body(&lib, "node:a"), "带过来的\n");
    let a1 = lib.asset("asset-1", Variant::Source).unwrap().unwrap();
    assert_eq!(fs::read(&a1.path).unwrap(), b"\x89PNG one");
    lib.close().unwrap();
}

/// Every report of `seen`, as (step, done, total); checks each step's
/// bytes only go up and end at its total.
fn steps(seen: &[backup::Progress]) -> Vec<backup::Step> {
    let mut out: Vec<backup::Step> = Vec::new();
    for (i, p) in seen.iter().enumerate() {
        assert!(p.done <= p.total || p.total == 0, "{p:?}");
        if out.last() != Some(&p.step) {
            out.push(p.step);
        } else {
            assert!(p.done >= seen[i - 1].done, "{p:?} after {:?}", seen[i - 1]);
        }
        let last_of_step = seen.get(i + 1).is_none_or(|n| n.step != p.step);
        if last_of_step {
            assert_eq!(p.done, p.total, "{p:?} ends its step");
        }
    }
    out
}

/// Progress for the backup dialog: each operation's steps in order, bytes
/// reported along the way (every MiB) and ending at the step's total.
#[test]
fn backups_report_their_progress_step_by_step() {
    use backup::Step::*;
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let files = tempfile::tempdir().unwrap();
    // An asset of 3 MiB, so the packing reports more than once.
    let big = files.path().join("big.png");
    let mut rng = common::synthetic::Rng::new(5);
    let bytes: Vec<u8> = (0..3 * 1024 * 1024).map(|_| rng.next_u64() as u8).collect();
    fs::write(&big, &bytes).unwrap();
    let lib = open(&root);
    create_in(&lib, "node:a", "book-1", "进度");
    lib.import_asset(&SourceImport {
        limit: 8 * 1024 * 1024,
        ..source("book-1", "asset-1", &big)
    })
    .unwrap();
    let package = files.path().join("b.drifting");
    let mut seen = Vec::new();
    lib.export_backup_with(&package, &HashMap::new(), &mut |p| {
        seen.push(*p);
        true
    })
    .unwrap();
    assert_eq!(steps(&seen), [Snapshot, Pack]);
    let pack: Vec<_> = seen.iter().filter(|p| p.step == Pack).collect();
    assert!(pack.len() >= 4, "{pack:?}");
    assert!(pack[0].total > bytes.len() as u64);

    let mut seen = Vec::new();
    let staged = backup::stage_with(&root, &package, VERSION, &mut |p| {
        seen.push(*p);
        true
    })
    .unwrap();
    assert_eq!(steps(&seen), [Extract, Verify]);
    assert!(seen[0].total > bytes.len() as u64);

    lib.close().unwrap();
    let mut seen = Vec::new();
    let (lib, _) = Library::restore_staged_with(&root, &staged, options(), &mut |p| {
        seen.push(*p);
        true
    })
    .unwrap();
    assert_eq!(steps(&seen), [SaveCurrent, CopyAssets, Replace]);
    let copy = seen.iter().find(|p| p.step == CopyAssets).unwrap();
    assert_eq!(copy.total, bytes.len() as u64);
    lib.close().unwrap();
}

/// Cancelling leaves nothing behind: no package, nothing staged, the
/// library as it was (and the staged backup still restorable); once the
/// database is being replaced, a restore no longer stops.
#[test]
fn a_cancelled_backup_leaves_nothing_behind() {
    use backup::Step::*;
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let files = tempfile::tempdir().unwrap();
    let png = files.path().join("a.png");
    fs::write(&png, b"\x89PNG one").unwrap();
    let lib = open(&root);
    create_in(&lib, "node:a", "book-1", "原文");
    lib.import_asset(&source("book-1", "asset-1", &png))
        .unwrap();
    let cancelled =
        |e: StoreError| matches!(e, StoreError::Backup { code, .. } if code == backup::CANCELLED);

    let out = files.path().join("out");
    fs::create_dir_all(&out).unwrap();
    let package = out.join("b.drifting");
    let e = lib
        .export_backup_with(&package, &HashMap::new(), &mut |p| p.step != Pack)
        .unwrap_err();
    assert!(cancelled(e));
    assert_eq!(
        fs::read_dir(&out).unwrap().count(),
        0,
        "no package, no part file"
    );
    assert!(!root.join("export-staging").exists());

    lib.export_backup(&package, &HashMap::new()).unwrap();
    let e = backup::stage_with(&root, &package, VERSION, &mut |p| p.step != Verify).unwrap_err();
    assert!(cancelled(e));
    assert!(!root.join("restore-staging").exists());

    let h = lib.open_doc("node:a", OpenDoc::Existing).unwrap();
    insert(&h, Origin::User, 0, "后来");
    h.close();
    let staged = backup::stage(&root, &package, VERSION).unwrap();
    lib.close().unwrap();
    let db = sha256_file(&root.join("library.sqlite"));
    let e = Library::restore_staged_with(&root, &staged, options(), &mut |p| p.step != CopyAssets)
        .err()
        .expect("cancelled");
    assert!(cancelled(e));
    assert_eq!(sha256_file(&root.join("library.sqlite")), db);
    // Asking to stop while the database is replaced changes nothing: it
    // finishes.
    let (lib, _) =
        Library::restore_staged_with(&root, &staged, options(), &mut |p| p.step != Replace)
            .unwrap();
    assert_eq!(body(&lib, "node:a"), "原文\n");
    lib.close().unwrap();
}
