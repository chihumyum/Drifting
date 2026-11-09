mod common;
use common::*;
use dr_store::{DocHandle, Origin, StoreError};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
    mpsc,
};

#[test]
fn announces_only_after_every_document_is_durable_and_live() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let a = create(&lib, "node:a");
    let b = create(&lib, "node:b");
    let seen = Arc::new(AtomicUsize::new(0));
    let (other, stored, n) = (b.doc().clone(), lib.clone(), seen.clone());
    let _sub = a.subscribe(move |_| {
        assert!(text(&other).starts_with("B"));
        assert!(text(&stored.load_copy("node:b").unwrap()).starts_with("B"));
        n.fetch_add(1, Ordering::SeqCst);
    });
    DocHandle::atomic(
        &[b.clone(), a.clone()],
        Origin::Command,
        |docs| -> Result<(), StoreError> {
            docs["node:a"].body().insert(0, "A")?;
            docs["node:b"].body().insert(0, "B")?;
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(seen.load(Ordering::SeqCst), 1);
    assert_eq!(a.stats().outside_commits + b.stats().outside_commits, 0);
}
#[test]
fn staging_and_second_sql_append_failures_roll_back_every_document_after_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let a = create(&lib, "node:a");
    let b = create(&lib, "node:b");
    let before = lib.write_seq().unwrap();
    assert!(
        DocHandle::atomic(
            &[a.clone(), b.clone()],
            Origin::Command,
            |docs| -> Result<(), StoreError> {
                docs["node:a"].body().insert(0, "discard")?;
                Err(StoreError::NotFound("injected".into()))
            }
        )
        .is_err()
    );
    lib.local_transaction(|tx| { tx.execute_batch("CREATE TRIGGER reject_atomic BEFORE INSERT ON loro_update WHEN NEW.doc_id='node:b' BEGIN SELECT RAISE(ABORT, 'second append'); END;")?; Ok(()) }).unwrap();
    assert!(
        DocHandle::atomic(
            &[a.clone(), b.clone()],
            Origin::Command,
            |docs| -> Result<(), StoreError> {
                docs["node:a"].body().insert(0, "discard A")?;
                docs["node:b"].body().insert(0, "discard B")?;
                Ok(())
            }
        )
        .is_err()
    );
    assert_eq!(lib.write_seq().unwrap(), before);
    assert_eq!(text(a.doc()), "\n");
    assert_eq!(text(b.doc()), "\n");
    a.close();
    b.close();
    lib.close().unwrap();
    let reopened = open(dir.path());
    for id in ["node:a", "node:b"] {
        assert_eq!(text(&reopened.load_copy(id).unwrap()), "\n");
    }
}
#[test]
fn typing_queued_during_atomic_edit_survives_after_it() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let a = create(&lib, "node:a");
    let b = create(&lib, "node:b");
    let (ready, rx) = mpsc::channel();
    let (go, proceed) = mpsc::channel();
    let hs = [a.clone(), b.clone()];
    let edit = std::thread::spawn(move || {
        DocHandle::atomic(&hs, Origin::Command, |docs| -> Result<(), StoreError> {
            ready.send(()).unwrap();
            proceed.recv().unwrap();
            docs["node:a"].body().insert(0, "restored")?;
            docs["node:b"].body().insert(0, "other")?;
            Ok(())
        })
    });
    rx.recv().unwrap();
    let typing = a
        .submit(Origin::User, |d| d.body().insert(0, "typed "))
        .unwrap();
    go.send(()).unwrap();
    edit.join().unwrap().unwrap();
    typing.wait().unwrap().0.unwrap();
    assert_eq!(text(a.doc()), "typed restored\n");
    assert_eq!(text(b.doc()), "other\n");
}
