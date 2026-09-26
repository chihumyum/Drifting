//! Actual NativeReplacement capture through the authored journal at crash cuts.
use super::*;
use drifting_core::original_body_archive::OriginalBodyArchiveStore;
use drifting_core::original_operation::{MutationTarget, OriginalOperationRef};
use drifting_core::original_operation_store::OriginalOperationStore;

pub const CHECKS: [&str; 12] = [
    "prose",
    "safe-comment",
    "native-command-declaration",
    "exact-update",
    "original-envelope",
    "body-archive",
    "revision",
    "journal-receipt",
    "covered-tail",
    "isolation",
    "integrity",
    "foreign-keys",
];

pub fn seed_native(gateway: &DatabaseGateway) {
    seed(gateway);
    let mut source = DocumentSession::with_test_client_id(46001).unwrap();
    let capture = source.capture_authored_updates().unwrap();
    for (id, value) in [("p", "甲北塔乙"), ("q", "海岸")] {
        source
            .edit(Edit::AppendParagraph {
                id: id.into(),
                text: value.into(),
            })
            .unwrap();
    }
    for record in capture.drain_records() {
        assert!(record.deletion().is_none());
        AuthoredProseJournal::new(gateway, CLIENT)
            .append(
                &context(),
                DOC,
                record.update(),
                &RevisionSource::User,
                None,
                None,
                |repo, tx| {
                    load_document(repo, DOC, tx)?
                        .0
                        .prepare_remote(record.update(), 1)
                        .map(|_| ())
                },
            )
            .unwrap();
    }
    source.set_comment_anchors(vec![CommentAnchorRecord {
        id:"synthetic-comment".into(),target_block_id:Some("q".into()),target_block_ids_json:"[\"q\"]".into(),
        anchor_json:json!({"selectedText":"海岸","futureField":{"keep":[1,2]},"textAnchor":{"startBlockId":"q","startOffset":0,"endBlockId":"q","endOffset":2,"text":"海岸"}}).to_string(),
    }]).unwrap();
    let record = &source.comment_anchor_records()[0];
    gateway.execute("UPDATE comment SET anchor_json=?,target_block_id='q',target_block_ids_json='[\"q\"]' WHERE id='synthetic-comment'".into(),vec![text(&record.anchor_json)],None,CLIENT.into()).unwrap();
    let mut owner = owner(gateway);
    owner
        .checkpoint(NOW, |_, _, _| Ok(()), &mut |_| {})
        .unwrap();
    assert_eq!(count(gateway, "sync_change_set"), 2);
    assert!(ProseRepository::new(gateway, CLIENT)
        .list_updates(DOC, None, None)
        .unwrap()
        .is_empty());
}

fn declaration(gateway: &DatabaseGateway, tx: u64) -> Value {
    let rows=query(gateway,"SELECT c.change_set_id,c.encoded_bytes,c.payload_sha256,m.payload_sha256,m.incarnation FROM sync_change_set c JOIN sync_mutation m USING(change_set_id) ORDER BY c.device_seq",Some(tx));
    assert_eq!(rows.len(), 3);
    let [V::Text(id), V::Blob(envelope), V::Text(envelope_hash), V::Text(payload_hash), V::Integer(incarnation)] =
        rows[2].as_slice()
    else {
        panic!("invalid declaration row")
    };
    let scope = scope();
    let reference = OriginalOperationRef {
        project_id: scope.project_id.clone(),
        project_sync_id: scope.project_sync_id.clone(),
        sync_generation_id: scope.sync_generation_id.clone(),
        change_set_id: id.clone(),
        mutation_index: 0,
        target: MutationTarget {
            family: "yjs".into(),
            kind: "prose-document".into(),
            id: DOC.into(),
            incarnation: incarnation.parse().unwrap(),
        },
        payload_sha256: format!("sha256:{payload_hash}"),
        original_envelope_sha256: envelope_hash.clone(),
    };
    let original = OriginalOperationStore::new(gateway, CLIENT)
        .load_verified_in_transaction(&reference, tx)
        .unwrap();
    assert_eq!(original.intent().offset_utf16, 1);
    assert_eq!(original.intent().length_utf16, 2);
    assert_eq!(original.device_seq(), 3);
    assert_eq!(original.source().target.incarnation, 0);
    let archive = OriginalBodyArchiveStore::new(gateway, CLIENT)
        .load_original_bodies_in_transaction(&scope, &[], tx)
        .unwrap();
    assert_eq!(archive.bodies().len(), 3);
    assert!(archive
        .bodies()
        .iter()
        .any(|body| body.source() == &reference && body.update() == original.exact_update()));
    json!({"reference":reference,"envelopeBase64":STANDARD.encode(envelope),"exactUpdateBase64":STANDARD.encode(original.exact_update()),
        "beforeSnapshotBase64":STANDARD.encode(original.before_snapshot()),"intent":{"targetText":original.intent().target_text,"offsetUtf16":original.intent().offset_utf16,"lengthUtf16":original.intent().length_utf16,"selectedSourceRanges":original.intent().selected_source_ranges},"archiveBodyCount":archive.bodies().len(),"deviceSeq":original.device_seq()})
}

pub fn crash_native(gateway: &DatabaseGateway, boundary: &str) {
    let baseline = summary(gateway, None);
    let mut document = owner(gateway);
    let before = document.update(None, 1).unwrap();
    let old = read_comments(gateway, None);
    let revision = document.native_projection().unwrap().revision;
    document
        .replace_native(NativeReplacement {
            revision,
            range: NativeRange {
                location: 1,
                length: 2,
            },
            text: String::new(),
        })
        .unwrap();
    assert_eq!(document.native_projection().unwrap().text, "甲乙\n海岸");
    let staged = RefCell::new(Value::Null);
    document.persist_authored(&context(),&RevisionSource::User,|gateway,tx,candidate|{
        write_comments(gateway,tx,candidate,&old)?;
        *staged.borrow_mut()=json!({"state":summary(gateway,Some(tx)),"original":declaration(gateway,tx)});
        Ok(())
    },&mut |phase|{
        let expected=match (boundary,phase) {
            ("native-delete-authored-before-commit",DurabilityPhase::AuthoredBeforeCommit)=>Some(&baseline),
            ("native-delete-authored-after-commit",DurabilityPhase::AuthoredAfterCommit)=>None,
            _=>return,
        };
        let staged=staged.borrow();
        pause(boundary,expected.unwrap_or(&staged["state"]),&baseline,json!({"nativeDeletion":true,"committed":expected.is_none(),"transactionWritten":true,"beforeUpdateBase64":STANDARD.encode(&before),"stagedOriginal":staged["original"]}));
    }).unwrap();
    let target = match boundary {
        "native-delete-checkpoint-after-snapshot" => DurabilityPhase::CheckpointAfterSnapshot,
        "native-delete-checkpoint-after-prune" => DurabilityPhase::CheckpointAfterPrune,
        "native-delete-checkpoint-after-commit" => DurabilityPhase::CheckpointAfterCommit,
        _ => panic!("invalid native deletion boundary"),
    };
    document.checkpoint(NOW,|_,_,_|Ok(()),&mut |phase|{
        if phase==target {
            let staged=staged.borrow();
            pause(boundary,&staged["state"],&baseline,json!({"nativeDeletion":true,"committed":true,"snapshotAndPruneSameTransaction":true,"beforeUpdateBase64":STANDARD.encode(&before),"stagedOriginal":staged["original"]}));
        }
    }).unwrap();
    panic!("native deletion hook did not fire");
}

pub fn recover_native(gateway: &DatabaseGateway, boundary: &str) {
    let mut document = owner(gateway);
    let baseline = boundary == "native-delete-authored-before-commit";
    let count_expected = if baseline { 2 } else { 3 };
    let projection = document.native_projection().unwrap();
    assert_eq!(
        projection.text,
        if baseline {
            "甲北塔乙\n海岸"
        } else {
            "甲乙\n海岸"
        }
    );
    assert_eq!(projection.comments.len(), 1);
    let comment = &projection.comments[0];
    assert_eq!(comment.quote, "海岸");
    assert_eq!(comment.status, "anchored");
    assert_eq!(
        json!(comment.ranges),
        json!([{"location":if baseline {5}else{3},"length":2}])
    );
    let record: Value =
        serde_json::from_str(&document.comment_anchor_records()[0].anchor_json).unwrap();
    assert_eq!(record["futureField"]["keep"], json!([1, 2]));
    assert!(!document.has_uncommitted_updates());
    assert!(!document.try_undo().unwrap());
    let repo = ProseRepository::new(gateway, CLIENT);
    assert_eq!(repo.get_revision(DOC, None).unwrap(), count_expected);
    assert_eq!(
        repo.list_revision_provenance(DOC, 0, None).unwrap().len() as u64,
        count_expected
    );
    for table in ["sync_change_set", "sync_mutation", "sync_apply_receipt"] {
        assert_eq!(count(gateway, table), count_expected);
    }
    let tail = repo.list_updates(DOC, None, None).unwrap();
    assert_eq!(
        tail.len(),
        usize::from(!baseline && boundary != "native-delete-checkpoint-after-commit")
    );
    assert_eq!(
        document.covered_update_id(),
        tail.last().map_or(0, |row| row.id)
    );
    let tx = gateway
        .begin(TransactionBehavior::Deferred, CLIENT.into())
        .unwrap();
    let original = if baseline {
        Value::Null
    } else {
        declaration(gateway, tx)
    };
    gateway.commit(tx, CLIENT.into()).unwrap();
    if let Some(row) = tail.first() {
        assert_eq!(
            STANDARD.encode(&row.update_blob),
            original["exactUpdateBase64"]
        );
    }
    assert_eq!(
        query(
            gateway,
            "SELECT name FROM project WHERE id='isolated-project'",
            None
        ),
        vec![vec![text("Untouched")]]
    );
    assert_eq!(
        repo.get_snapshot("isolated-document", None)
            .unwrap()
            .unwrap()
            .state_blob,
        vec![0, 0]
    );
    assert_eq!(
        query(gateway, "PRAGMA integrity_check", None),
        vec![vec![text("ok")]]
    );
    assert!(query(gateway, "PRAGMA foreign_key_check", None).is_empty());
    let state = summary(gateway, None);
    // Empty retry may replay, but cannot re-journal a declaration from cold state.
    document
        .persist_authored(
            &context(),
            &RevisionSource::User,
            |_, _, _| Ok(()),
            &mut |_| {},
        )
        .unwrap();
    assert_eq!(summary(gateway, None)["stateHash"], state["stateHash"]);
    emit(
        json!({"event":"recovered","boundary":boundary,"stateHash":state["stateHash"],"checks":CHECKS,"details":{
        "nativeDeletion":true,"committed":!baseline,"updateBase64":state["updateBase64"],"semantic":state["semantic"],
        "original":original,"revision":count_expected,"journalCount":count_expected,"receiptCount":count_expected,"tailCount":tail.len(),"retryStable":true,
        "commentRanges":comment.ranges,"scope":{"projectId":scope().project_id,"projectSyncId":scope().project_sync_id,"syncGenerationId":scope().sync_generation_id,"documentId":DOC,"incarnation":0},"noUserUndo":true}}),
    );
}
