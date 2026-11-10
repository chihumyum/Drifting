mod common;
use common::*;
use dr_store::{AtomicNewDocument, AtomicScope, DocHandle, Origin, StoreError};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
    mpsc,
};

#[test]
fn atomic_user_installs_before_acknowledgment_and_keeps_original_api_command_only() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let a = create(&lib, "node:a");
    let b = create(&lib, "node:b");
    assert!(
        DocHandle::atomic(
            &[a.clone(), b.clone()],
            Origin::User,
            |_| Ok::<_, StoreError>(())
        )
        .is_err()
    );
    let acknowledged = Arc::new(AtomicUsize::new(0));
    let observed = acknowledged.clone();
    let _sub = a.subscribe(move |event| {
        assert_eq!(event.origin, Origin::User);
        assert_eq!(observed.load(Ordering::SeqCst), 1);
    });
    DocHandle::atomic_user(
        &[a.clone(), b.clone()],
        "book-1",
        |docs| -> Result<(), StoreError> {
            docs["node:a"].body().insert(0, "A")?;
            docs["node:b"].body().insert(0, "B")?;
            Ok(())
        },
        || {
            assert_eq!(text(a.doc()), "A\n");
            assert_eq!(text(b.doc()), "B\n");
            assert_eq!(text(&lib.load_copy("node:b").unwrap()), "B\n");
            acknowledged.fetch_add(1, Ordering::SeqCst);
        },
    )
    .unwrap();
    assert_eq!(acknowledged.load(Ordering::SeqCst), 1);
}

#[test]
fn atomic_user_staging_append_and_foreign_owner_fail_without_acknowledgment_or_partial_state() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let a = create(&lib, "node:a");
    let b = create(&lib, "node:b");
    let before = lib.write_seq().unwrap();
    let versions = [a.doc().oplog_frontiers(), b.doc().oplog_frontiers()];
    for phase in ["staging", "owner", "append"] {
        if phase == "append" {
            lib.local_transaction(|tx| {tx.execute_batch("CREATE TRIGGER user_atomic_fault BEFORE INSERT ON loro_update WHEN NEW.doc_id='node:b' BEGIN SELECT RAISE(ABORT,'second author append'); END;")?;Ok(())}).unwrap();
        }
        let result = DocHandle::atomic_user(
            &[a.clone(), b.clone()],
            if phase == "owner" { "book-2" } else { "book-1" },
            |docs| -> Result<(), StoreError> {
                docs["node:a"].body().insert(0, "A")?;
                if phase == "staging" {
                    return Err(StoreError::NotFound("staging".into()));
                }
                docs["node:b"].body().insert(0, "B")?;
                Ok(())
            },
            || panic!("failed author edit must not acknowledge undo"),
        );
        assert!(result.is_err());
        assert_eq!(lib.write_seq().unwrap(), before);
        assert_eq!(
            [a.doc().oplog_frontiers(), b.doc().oplog_frontiers()],
            versions
        );
        assert_eq!(text(a.doc()), "\n");
        assert_eq!(text(b.doc()), "\n");
    }
    a.close();
    b.close();
    lib.close().unwrap();
    let lib = open(dir.path());
    for id in ["node:a", "node:b"] {
        assert_eq!(text(&lib.load_copy(id).unwrap()), "\n");
    }
}

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

fn new_doc(id: &str) -> AtomicNewDocument {
    let d = loro::LoroDoc::new();
    genesis(&d);
    AtomicNewDocument {
        id: id.into(),
        kind: "node".into(),
        genesis: d.export(loro::ExportMode::all_updates()).unwrap(),
        pre_registered: false,
    }
}
fn scope() -> AtomicScope<'static> {
    AtomicScope {
        book_id: "book-1",
        prefix: "node:",
    }
}

#[test]
fn new_documents_and_existing_updates_share_one_commit_or_no_commit() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let a = create(&lib, "node:a");
    let before = lib.write_seq().unwrap();
    lib.local_transaction(|tx| { tx.execute_batch("CREATE TRIGGER reject_new BEFORE INSERT ON loro_update WHEN NEW.doc_id='node:c' BEGIN SELECT RAISE(ABORT, 'last append'); END;")?; Ok(()) }).unwrap();
    let run = || {
        DocHandle::atomic_scoped(
            std::slice::from_ref(&a),
            Origin::Command,
            scope(),
            &[new_doc("node:b"), new_doc("node:c")],
            |docs| -> Result<(), StoreError> {
                for d in docs.values() {
                    d.body().insert(0, "atomic")?;
                }
                Ok(())
            },
        )
    };
    assert!(run().is_err());
    assert_eq!(text(a.doc()), "\n");
    assert!(lib.doc_info("node:b").unwrap().is_none());
    assert!(lib.doc_info("node:c").unwrap().is_none());
    assert_eq!(lib.write_seq().unwrap(), before);
    lib.local_transaction(|tx| {
        tx.execute_batch("DROP TRIGGER reject_new")?;
        Ok(())
    })
    .unwrap();
    run().unwrap();
    assert_eq!(text(a.doc()), "atomic\n");
    a.close();
    lib.close().unwrap();
    let lib = open(dir.path());
    for id in ["node:a", "node:b", "node:c"] {
        assert_eq!(text(&lib.load_copy(id).unwrap()), "atomic\n");
    }
}

#[test]
fn registry_changes_during_staging_are_rejected_and_the_new_authors_data_survives() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let a = create(&lib, "node:a");
    let result = DocHandle::atomic_scoped(
        std::slice::from_ref(&a),
        Origin::Command,
        scope(),
        &[],
        |docs| -> Result<(), StoreError> {
            docs["node:a"].body().insert(0, "discard")?;
            let b = create(&lib, "node:new");
            insert(&b, Origin::User, 0, "concurrent author");
            b.close();
            Ok(())
        },
    );
    assert!(matches!(
        result,
        Err(StoreError::Invalid {
            what: "atomic inventory",
            ..
        })
    ));
    assert_eq!(text(a.doc()), "\n");
    assert_eq!(
        text(&lib.load_copy("node:new").unwrap()),
        "concurrent author\n"
    );
}

#[test]
fn foreign_registry_owner_and_duplicate_handles_refuse_all_writes() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let a = create(&lib, "node:a");
    lib.register("node:foreign", "node", Some("book-2"))
        .unwrap();
    let result = DocHandle::atomic_scoped(
        std::slice::from_ref(&a),
        Origin::Command,
        scope(),
        &[],
        |docs| -> Result<(), StoreError> {
            docs["node:a"].body().insert(0, "discard")?;
            Ok(())
        },
    );
    assert!(result.is_err());
    assert!(
        DocHandle::atomic(
            &[a.clone(), a.clone()],
            Origin::Command,
            |_| -> Result<(), StoreError> { panic!("must not run") }
        )
        .is_err()
    );
    assert_eq!(text(a.doc()), "\n");
}

#[test]
fn panic_and_foreign_library_release_every_reservation_without_partial_writes() {
    let dir = tempfile::tempdir().unwrap();
    let other_dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let other = open(other_dir.path());
    let a = create(&lib, "node:a");
    let b = create(&lib, "node:b");
    let foreign = create(&other, "node:foreign");
    assert!(
        DocHandle::atomic(
            &[a.clone(), foreign],
            Origin::Command,
            |_| -> Result<(), StoreError> { panic!("must not enter") }
        )
        .is_err()
    );
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _: Result<(), StoreError> =
                DocHandle::atomic(&[a.clone(), b.clone()], Origin::Command, |docs| {
                    docs["node:a"].body().insert(0, "discard").unwrap();
                    panic!("staged failure")
                });
        }))
        .is_err()
    );
    insert(&b, Origin::User, 0, "still editable");
    assert_eq!(text(a.doc()), "\n");
    assert_eq!(text(b.doc()), "still editable\n");
}

#[test]
fn pre_registered_empty_document_is_guarded_against_a_racing_first_writer() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let a = create(&lib, "node:a");
    lib.register("node:b", "node", Some("book-1")).unwrap();
    let mut new = new_doc("node:b");
    new.pre_registered = true;
    let result = DocHandle::atomic_scoped(
        std::slice::from_ref(&a),
        Origin::Command,
        scope(),
        &[new],
        |docs| -> Result<(), StoreError> {
            docs["node:a"].body().insert(0, "discard")?;
            let b = create(&lib, "node:b");
            insert(&b, Origin::User, 0, "first author");
            b.close();
            Ok(())
        },
    );
    assert!(result.is_err());
    assert_eq!(text(a.doc()), "\n");
    assert_eq!(text(&lib.load_copy("node:b").unwrap()), "first author\n");
}
