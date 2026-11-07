//! What the sync service has (`remote_vv`), independent of compaction.

mod common;

use common::*;
use dr_store::{Library, Origin};

#[test]
fn uploads_export_from_the_document_and_survive_compaction() {
    let tmp = tempfile::tempdir().unwrap();
    let a = open(&tmp.path().join("a"));
    let b = open(&tmp.path().join("b"));
    let ha = create(&a, "node:a");
    insert(&ha, Origin::User, 0, "甲写的");
    assert_eq!(a.docs_with_local_changes().unwrap(), ["node:a"]);

    // Upload, and the other device imports from "the server".
    let batch = a
        .export_for_upload("node:a")
        .unwrap()
        .expect("something to send");
    let hb = create(&b, "node:a");
    let imported = hb.import(batch.bytes.clone(), Origin::Sync).unwrap();
    assert!(imported.status.pending.is_none());
    a.mark_uploaded("node:a", &batch.vv).unwrap();
    assert!(a.docs_with_local_changes().unwrap().is_empty());
    assert!(
        a.export_for_upload("node:a").unwrap().is_none(),
        "nothing new"
    );
    // What came from the server is known to be there.
    assert!(b.docs_with_local_changes().unwrap().is_empty());

    // More edits, then compaction folds the rows into the snapshot: the
    // upload still carries exactly the new operations.
    insert(&ha, Origin::User, 3, "，又写");
    ha.compact_now().unwrap();
    assert!(
        a.updates_since("node:a", 0).unwrap().is_empty(),
        "rows compacted"
    );
    assert_eq!(a.docs_with_local_changes().unwrap(), ["node:a"]);
    let batch = a.export_for_upload("node:a").unwrap().unwrap();
    hb.import(batch.bytes, Origin::Sync).unwrap();
    a.mark_uploaded("node:a", &batch.vv).unwrap();
    assert_eq!(text(hb.doc()), text(ha.doc()));
    assert!(a.docs_with_local_changes().unwrap().is_empty());

    // A closed document exports from a copy.
    insert(&hb, Origin::User, 0, "乙");
    hb.close();
    let batch = b.export_for_upload("node:a").unwrap().unwrap();
    ha.import(batch.bytes, Origin::Sync).unwrap();
    assert_eq!(text(ha.doc()), "乙甲写的，又写\n");
    assert!(a.docs_with_local_changes().unwrap().is_empty());
    assert_eq!(
        b.docs_with_local_changes().unwrap(),
        ["node:a"],
        "until marked"
    );
}

#[test]
fn sync_to_disk_raises_the_watermark() {
    let tmp = tempfile::tempdir().unwrap();
    let mut o = options();
    o.device = Some(dr_store::Device::open(tmp.path().join("device")).unwrap());
    let lib = Library::open(tmp.path().join("lib"), o).unwrap();
    let h = create(&lib, "node:a");
    insert(&h, Origin::User, 0, "字");
    lib.sync_to_disk().unwrap();
    let device = dr_store::Device::open(tmp.path().join("device")).unwrap();
    assert_eq!(
        device.watermark(lib.library_id()).unwrap(),
        Some(lib.write_seq().unwrap())
    );
    assert_eq!(lib.write_seq().unwrap(), 2, "genesis and one edit");
}

#[test]
fn repair_and_genesis_rows_are_appended_and_uploaded_like_any_other() {
    let tmp = tempfile::tempdir().unwrap();
    let a = open(&tmp.path().join("a"));
    let h = create(&a, "node:a");
    insert(&h, Origin::User, 0, "字");
    // dr-doc's deterministic repair writes through the holder like anything.
    insert(&h, Origin::Repair, 0, "修");
    let rows = a.updates_since("node:a", 0).unwrap();
    let origins: Vec<&str> = rows.iter().map(|r| r.origin.as_str()).collect();
    assert_eq!(origins, ["genesis", "user", "repair"]);
    // The repair is recognisable in history, and nobody's periodic label.
    let changes = h
        .read(|doc| dr_store::history::changes_since(doc, 0))
        .unwrap();
    assert!(
        changes
            .iter()
            .any(|c| c.message.as_deref() == Some("repair"))
    );
    // Everything, genesis and repair included, goes to the server.
    let batch = a.export_for_upload("node:a").unwrap().unwrap();
    let probe = loro::LoroDoc::new();
    common::synthetic::configure(&probe);
    probe.import(&batch.bytes).unwrap();
    assert_eq!(text(&probe), text(h.doc()));
    assert_eq!(probe.oplog_vv(), h.doc().oplog_vv());
}
