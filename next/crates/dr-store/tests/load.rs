//! Loading a stored document: the snapshot, then the newer updates one by one
//! in stored order. Every way in (`load_copy`, `load_copy_at`, a holder
//! opening the document, a read-only library, an index rebuild) must load
//! exactly what importing the snapshot and the updates in one `import_batch`
//! loaded, which is how the store loaded documents before.

mod common;

use std::sync::Arc;

use common::*;
use dr_store::{Library, OpenDoc, Origin, StoreError};
use loro::{ExportMode, Frontiers, LoroDoc, TreeParentId};
use rusqlite::OptionalExtension;

/// The previous loader, kept as the reference: the stored snapshot and every
/// update after it in one `import_batch` (one blob alone in `import`).
fn load_batch(lib: &Library, doc_id: &str) -> LoroDoc {
    let doc = LoroDoc::new();
    synthetic::configure(&doc);
    doc.set_record_timestamp(true);
    let snapshot: Option<(i64, Vec<u8>)> = lib
        .local_read(|c| {
            Ok(c.query_row(
                "SELECT upto_seq, bytes FROM loro_snapshot WHERE doc_id = ?1",
                [doc_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?)
        })
        .unwrap();
    let upto = snapshot.as_ref().map_or(0, |(seq, _)| *seq);
    let mut batch: Vec<Vec<u8>> = snapshot.into_iter().map(|(_, bytes)| bytes).collect();
    batch.extend(
        lib.updates_since(doc_id, upto)
            .unwrap()
            .into_iter()
            .map(|u| u.bytes),
    );
    assert!(!batch.is_empty(), "{doc_id} is stored");
    let status = if batch.len() == 1 {
        doc.import(&batch[0]).unwrap()
    } else {
        doc.import_batch(&batch).unwrap()
    };
    assert!(status.pending.is_none(), "the reference loads completely");
    doc
}

/// Versions, state and its version, and the document's whole value.
fn assert_same(loaded: &LoroDoc, reference: &LoroDoc) {
    assert_eq!(loaded.oplog_vv(), reference.oplog_vv(), "oplog_vv");
    assert_eq!(
        loaded.oplog_frontiers(),
        reference.oplog_frontiers(),
        "oplog_frontiers"
    );
    assert_eq!(
        loaded.state_frontiers(),
        reference.state_frontiers(),
        "state_frontiers"
    );
    assert_eq!(loaded.state_vv(), reference.state_vv(), "state_vv");
    assert_eq!(loaded.is_detached(), reference.is_detached(), "detached");
    assert_eq!(loaded.len_changes(), reference.len_changes(), "changes");
    assert_eq!(loaded.len_ops(), reference.len_ops(), "operations");
    assert_eq!(
        loaded.get_deep_value(),
        reference.get_deep_value(),
        "deep value"
    );
}

/// A write touching every kind of container a document has: styled text, a
/// map, a tree with node metadata, a movable list and a counter.
fn edit_everything(doc: &LoroDoc, k: i64) {
    let text = doc.get_text(synthetic::BODY);
    let len = text.len_unicode();
    text.insert(len.saturating_sub(1), &format!("第{k}段潮汐\n"))
        .unwrap();
    if k % 3 == 1 {
        text.mark(0..2, "bold", true).unwrap();
    }
    if k % 4 == 2 && len > 4 {
        text.delete(1, 2).unwrap();
    }
    doc.get_map("meta").insert("k", k).unwrap();
    let tree = doc.get_tree("entries");
    let node = tree.create(TreeParentId::Root).unwrap();
    tree.get_meta(node)
        .unwrap()
        .insert("title", format!("条目{k}"))
        .unwrap();
    if let Some(first) = tree.roots().first().copied()
        && first != node
    {
        tree.mov(node, TreeParentId::Node(first)).unwrap();
    }
    let list = doc.get_movable_list("order");
    list.push(k).unwrap();
    if list.len() > 2 {
        list.mov(0, list.len() - 1).unwrap();
    }
    doc.get_counter("count").increment(1.0).unwrap();
    // A root that ends up empty is still part of the document's value.
    let scratch = doc.get_map(format!("scratch{}", k % 3));
    scratch.insert("x", k).unwrap();
    scratch.delete("x").unwrap();
}

fn write(h: &dr_store::DocHandle, origin: Origin, k: i64) {
    h.write(origin, move |doc| edit_everything(doc, k)).unwrap();
}

/// An update another device made on top of `base` (a copy at some version).
fn remote_update(base: &LoroDoc, peer: u64, k: i64) -> Vec<u8> {
    let remote = base.fork();
    remote.set_peer_id(peer).unwrap();
    let vv = remote.oplog_vv();
    edit_everything(&remote, k);
    remote.commit();
    remote.export(ExportMode::updates(&vv)).unwrap()
}

/// Store `bytes` as the next update row, as a sync service that keeps blobs
/// in arrival order would (the holder itself never stores an update before
/// what it depends on).
fn store_row(lib: &Library, doc_id: &str, bytes: &[u8]) -> i64 {
    lib.local_transaction(|tx| {
        let seq: i64 = tx.query_row(
            "SELECT max(coalesce((SELECT max(seq) FROM loro_update WHERE doc_id = ?1), 0),
                        coalesce((SELECT upto_seq FROM loro_snapshot WHERE doc_id = ?1), 0)) + 1",
            [doc_id],
            |r| r.get(0),
        )?;
        tx.execute(
            "INSERT INTO loro_update (doc_id, seq, bytes, origin, ts) VALUES (?1, ?2, ?3, 'sync', 0)",
            rusqlite::params![doc_id, seq, bytes],
        )?;
        Ok(seq)
    })
    .unwrap()
}

fn check_copies(lib: &Library, doc_id: &str) -> LoroDoc {
    let reference = load_batch(lib, doc_id);
    let copy = lib.load_copy(doc_id).unwrap();
    assert_same(&copy, &reference);
    reference
}

#[test]
fn copies_load_like_one_batch_with_and_without_a_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let h = create(&lib, "node:a");
    let first = lib.load_copy("node:a").unwrap();
    for k in 0..6 {
        write(&h, Origin::User, k);
    }
    // Only updates, no snapshot.
    assert!(lib.snapshot_info("node:a").unwrap().is_none());
    check_copies(&lib, "node:a");

    // A snapshot and nothing after it.
    h.compact_now().unwrap().expect("compacted");
    assert!(lib.updates_since("node:a", 0).unwrap().is_empty());
    check_copies(&lib, "node:a");

    // A snapshot, local updates and one from another device made on an old
    // version (concurrent with everything after it).
    for k in 6..12 {
        write(&h, Origin::Command, k);
    }
    let concurrent = remote_update(&first, 0xbeef_0001, 100);
    assert!(
        h.import(concurrent, Origin::Sync)
            .unwrap()
            .status
            .pending
            .is_none()
    );
    write(&h, Origin::User, 12);
    assert_eq!(lib.updates_since("node:a", 0).unwrap().len(), 8);
    let reference = check_copies(&lib, "node:a");
    assert!(reference.oplog_vv().get(&0xbeef_0001).is_some());

    // What the holder has in memory is what a copy loads.
    assert_eq!(h.doc().oplog_vv(), reference.oplog_vv());
    assert_eq!(h.doc().get_deep_value(), reference.get_deep_value());
}

#[test]
fn a_copy_with_local_updates_on_its_snapshot_builds_no_history_cache() {
    // The reason the store does not use `import_batch`: its closing checkout
    // builds Loro's history cache, decoding every change the document ever
    // had (about 160 ms on a book written over three years, see f2-store.md).
    // Updates imported one by one on top of the snapshot apply as plain
    // diffs. If a Loro upgrade changes this, measure loading again.
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let h = create(&lib, "node:a");
    for k in 0..30 {
        write(&h, Origin::User, k);
    }
    h.compact_now().unwrap().expect("compacted");
    for k in 30..40 {
        write(&h, Origin::User, k);
    }
    let copy = lib.load_copy("node:a").unwrap();
    assert!(!copy.has_history_cache());
    assert_same(&copy, &load_batch(&lib, "node:a"));
}

#[test]
fn updates_stored_out_of_causal_order_load_like_one_batch() {
    for compacted in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let mut o = options();
        let deriver = Arc::new(synthetic::LinesDeriver::default());
        o.deriver = Some(deriver);
        o.rebuild_indexes_on_open = false;
        let lib = Library::open(dir.path(), o.clone()).unwrap();
        let h = create(&lib, "node:b");
        for k in 0..4 {
            write(&h, Origin::User, k);
        }
        if compacted {
            h.compact_now().unwrap().expect("compacted");
        }
        let base = lib.load_copy("node:b").unwrap();
        drop(h);
        lib.close().unwrap();
        let lib = Library::open(dir.path(), o.clone()).unwrap();

        // Peer 7 writes u1, then u2 on top of it; peer 8 writes u3 on the
        // base, concurrently; u4 (peer 7 again) needs u2 and u3.
        let seven = base.fork();
        seven.set_peer_id(7).unwrap();
        let vv0 = seven.oplog_vv();
        edit_everything(&seven, 71);
        seven.commit();
        let u1 = seven.export(ExportMode::updates(&vv0)).unwrap();
        let after_u1 = seven.oplog_frontiers();
        let vv1 = seven.oplog_vv();
        edit_everything(&seven, 72);
        seven.commit();
        let u2 = seven.export(ExportMode::updates(&vv1)).unwrap();
        let u3 = remote_update(&base, 8, 81);
        seven.import(&u3).unwrap();
        let vv2 = seven.oplog_vv();
        edit_everything(&seven, 73);
        seven.commit();
        let u4 = seven.export(ExportMode::updates(&vv2)).unwrap();
        let everything = seven.oplog_vv();

        // Stored in arrival order: u2 and u4 before what they wait for, a
        // duplicate of u1, and a row repeating what is already there.
        let mut rows = vec![store_row(&lib, "node:b", &u4)];
        rows.push(store_row(&lib, "node:b", &u2));
        rows.push(store_row(&lib, "node:b", &u3));
        rows.push(store_row(&lib, "node:b", &u1));
        rows.push(store_row(&lib, "node:b", &u1));
        rows.push(store_row(
            &lib,
            "node:b",
            &base.export(ExportMode::all_updates()).unwrap(),
        ));
        assert!(rows.windows(2).all(|w| w[0] < w[1]));

        let reference = check_copies(&lib, "node:b");
        assert_eq!(reference.oplog_vv(), everything);
        assert_eq!(
            lib.load_copy("node:b")
                .unwrap()
                .get_map("meta")
                .get_deep_value(),
            seven.get_map("meta").get_deep_value()
        );

        // A copy checked out at a past version: before the stored rows, and
        // between them (u1 is stored last but is in the middle of history).
        for at in [
            base.oplog_frontiers(),
            after_u1,
            reference.oplog_frontiers(),
        ] {
            let past = lib.load_copy_at("node:b", &at).unwrap();
            let expected = load_batch(&lib, "node:b");
            expected.checkout(&at).unwrap();
            assert_same(&past, &expected);
        }

        // An index rebuild of the closed document reads the same text.
        assert!(lib.reindex_doc("node:b").unwrap());
        let lines: Vec<u32> = text(&reference)
            .split_terminator('\n')
            .map(|l| l.chars().count() as u32)
            .collect();
        assert_eq!(lib.block_lengths("node:b").unwrap(), lines);

        // A read-only library loads the same copy.
        {
            let ro = Library::open_read_only(dir.path(), o.clone()).unwrap();
            assert_same(&ro.load_copy("node:b").unwrap(), &reference);
        }

        // A holder opening the document starts from the same state, and
        // appends after the last stored row.
        let h = lib.open_doc("node:b", OpenDoc::Existing).unwrap();
        assert_eq!(h.doc().oplog_vv(), reference.oplog_vv());
        assert_eq!(h.doc().oplog_frontiers(), reference.oplog_frontiers());
        assert_eq!(h.doc().state_frontiers(), reference.state_frontiers());
        assert_eq!(h.doc().get_deep_value(), reference.get_deep_value());
        let committed = h
            .write(Origin::User, |doc| edit_everything(doc, 9))
            .unwrap()
            .1;
        assert_eq!(committed.seq, Some(rows.last().unwrap() + 1));
        let reference = check_copies(&lib, "node:b");
        assert_eq!(h.doc().get_deep_value(), reference.get_deep_value());
        drop(h);
        lib.close().unwrap();
    }
}

#[test]
fn an_update_whose_dependency_is_not_stored_is_refused_as_before() {
    for compacted in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let lib = open(dir.path());
        let h = create(&lib, "node:c");
        write(&h, Origin::User, 0);
        if compacted {
            h.compact_now().unwrap().expect("compacted");
        }
        let base = lib.load_copy("node:c").unwrap();
        drop(h);
        lib.close().unwrap();
        let lib = open(dir.path());

        let seven = base.fork();
        seven.set_peer_id(7).unwrap();
        edit_everything(&seven, 1);
        seven.commit();
        let vv1 = seven.oplog_vv();
        edit_everything(&seven, 2);
        seven.commit();
        // Only the second update is stored; the first never arrived.
        store_row(
            &lib,
            "node:c",
            &seven.export(ExportMode::updates(&vv1)).unwrap(),
        );
        // An update that does not wait is stored after it.
        store_row(&lib, "node:c", &remote_update(&base, 8, 3));

        let refused = |e: StoreError| {
            assert!(
                e.to_string()
                    .contains("stored updates depend on operations that are not stored"),
                "{e}"
            );
        };
        refused(lib.load_copy("node:c").unwrap_err());
        refused(
            lib.load_copy_at("node:c", &Frontiers::default())
                .unwrap_err(),
        );
        match lib.open_doc("node:c", OpenDoc::Existing) {
            Ok(_) => panic!("a holder opened a document missing a dependency"),
            Err(e) => refused(e),
        }
        // The batch import leaves the same update waiting.
        let doc = LoroDoc::new();
        let upto = lib.snapshot_info("node:c").unwrap().map_or(0, |(s, _)| s);
        let mut batch = Vec::new();
        if compacted {
            batch.push(
                lib.local_read(|c| {
                    Ok(c.query_row(
                        "SELECT bytes FROM loro_snapshot WHERE doc_id = ?1",
                        ["node:c"],
                        |r| r.get::<_, Vec<u8>>(0),
                    )?)
                })
                .unwrap(),
            );
        }
        batch.extend(
            lib.updates_since("node:c", upto)
                .unwrap()
                .into_iter()
                .map(|u| u.bytes),
        );
        assert!(doc.import_batch(&batch).unwrap().pending.is_some());
    }
}
