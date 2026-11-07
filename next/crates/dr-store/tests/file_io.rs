//! Tests for `file_io`, moved unchanged from the 0.1 client, which had none
//! of its own (some came from `native_capabilities.rs`).

use std::fs;
use std::io;
use std::path::Path;

use dr_store::file_io::*;

fn entries(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn atomic_write_replaces_content_and_leaves_no_partial_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("book/asset/source.bin");
    atomic_write(&path, b"first").unwrap();
    atomic_write(&path, b"second").unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"second");
    assert_eq!(entries(path.parent().unwrap()), ["source.bin"]);
}

#[test]
fn atomic_write_reports_a_parent_barrier_failure_after_the_rename() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("book/asset/source.bin");
    let barrier_called = std::cell::Cell::new(false);
    let error = atomic_write_with_commit(&path, b"durable bytes", |temporary, destination| {
        rename_then_sync_parent(
            temporary,
            destination,
            |source, target| fs::rename(source, target),
            |parent| {
                barrier_called.set(true);
                assert_eq!(parent, destination.parent().unwrap());
                assert_eq!(fs::read(destination).unwrap(), b"durable bytes");
                assert!(!temporary.exists());
                Err(io::Error::other("injected parent barrier failure"))
            },
        )
    })
    .unwrap_err();
    assert!(barrier_called.get());
    assert_eq!(error.to_string(), "injected parent barrier failure");
    assert_eq!(fs::read(&path).unwrap(), b"durable bytes");
    assert_eq!(entries(path.parent().unwrap()), ["source.bin"]);
}

#[test]
fn atomic_write_cleans_its_temporary_file_when_commit_fails() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("a/b.bin");
    let error = atomic_write_with_commit(&path, b"bytes", |_, _| {
        Err(io::Error::other("injected commit failure"))
    })
    .unwrap_err();
    assert_eq!(error.to_string(), "injected commit failure");
    assert!(entries(path.parent().unwrap()).is_empty());
}

#[test]
fn atomic_copy_cleans_its_temporary_file_when_commit_fails() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("input.bin");
    let path = dir.path().join("book/asset/source.bin");
    fs::write(&source, b"copy bytes").unwrap();
    let error = atomic_copy_capped_with_commit(&source, &path, 1024, |_, _| {
        Err(io::Error::other("injected commit failure"))
    })
    .unwrap_err();
    assert_eq!(error.to_string(), "injected commit failure");
    assert!(!path.exists());
    assert!(entries(path.parent().unwrap()).is_empty());
}

#[test]
fn atomic_copy_commits_bytes_and_enforces_its_cap() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("input.bin");
    let path = dir.path().join("book/asset/source.bin");
    fs::write(&source, b"copy bytes").unwrap();
    assert_eq!(atomic_copy_capped(&source, &path, 10).unwrap(), 10);
    assert_eq!(fs::read(&path).unwrap(), b"copy bytes");
    assert_eq!(entries(path.parent().unwrap()), ["source.bin"]);
    let other = dir.path().join("book/asset/other.bin");
    let error = atomic_copy_capped(&source, &other, 9).unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert!(!other.exists());
    let error = atomic_copy_capped(dir.path(), &other, 1024).unwrap_err();
    assert_eq!(
        error.kind(),
        io::ErrorKind::InvalidInput,
        "a directory is not a file"
    );
    assert_eq!(entries(path.parent().unwrap()), ["source.bin"]);
}

#[test]
fn temporary_siblings_are_hidden_unique_and_beside_the_target() {
    let target = Path::new("/x/library.sqlite");
    let a = temporary_sibling(target).unwrap();
    let b = temporary_sibling(target).unwrap();
    assert_ne!(a, b);
    assert_eq!(a.parent(), target.parent());
    let name = a.file_name().unwrap().to_str().unwrap();
    assert!(name.starts_with(".library.sqlite.") && name.ends_with(".part"));
    assert!(temporary_sibling(Path::new("/")).is_err());
}

#[test]
fn durable_replace_and_sync_file_work_on_real_files() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a");
    let b = dir.path().join("b");
    fs::write(&a, b"new").unwrap();
    fs::write(&b, b"old").unwrap();
    sync_file(&a).unwrap();
    durable_replace_file(&a, &b).unwrap();
    assert_eq!(fs::read(&b).unwrap(), b"new");
    assert!(!a.exists());
    sync_directory(dir.path()).unwrap();
    assert!(sync_directory(&b).is_err(), "a file is not a directory");
}

#[cfg(unix)]
#[test]
fn symlinked_directories_are_refused() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real");
    fs::create_dir_all(&real).unwrap();
    let link = dir.path().join("link");
    symlink(&real, &link).unwrap();
    let error = ensure_parent_directory(&link.join("file")).unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    assert!(atomic_write(&link.join("file"), b"x").is_err());
    assert!(
        entries(&real).is_empty(),
        "nothing written through the link"
    );
    assert!(sync_directory(&link).is_err());
}

#[cfg(windows)]
#[test]
fn windows_write_through_moves_replace_only_when_asked() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a");
    let b = dir.path().join("b");
    fs::write(&a, b"new").unwrap();
    fs::write(&b, b"old").unwrap();
    assert!(windows_move_write_through(&a, &b, false).is_err());
    assert_eq!(fs::read(&b).unwrap(), b"old");
    windows_move_write_through(&a, &b, true).unwrap();
    assert_eq!(fs::read(&b).unwrap(), b"new");
    let d1 = dir.path().join("d1");
    fs::create_dir_all(d1.join("inner")).unwrap();
    windows_move_write_through(&d1, &dir.path().join(".d1.deleting"), false).unwrap();
    assert!(dir.path().join(".d1.deleting/inner").is_dir());
}
