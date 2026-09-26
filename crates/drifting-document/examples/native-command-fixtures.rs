//! Synthetic, deterministic CRDT identities; no application database is read.
use base64::{engine::general_purpose::STANDARD, Engine};
use drifting_document::{DocumentSession, Edit, NativeRange, NativeReplacement};
use serde_json::json;

fn seed() -> DocumentSession {
    let mut first = DocumentSession::with_test_client_id(64501).unwrap();
    first
        .edit(Edit::AppendParagraph {
            id: "a".into(),
            text: "甲乙丙".into(),
        })
        .unwrap();
    let mut peer = DocumentSession::with_test_client_id(64502).unwrap();
    peer.apply_remote(&first.update(None, 1).unwrap(), 1)
        .unwrap();
    peer.edit(Edit::Insert {
        block: "a".into(),
        offset: 1,
        text: "中🙂".into(),
    })
    .unwrap();
    let mut live = DocumentSession::with_test_client_id(64503).unwrap();
    live.apply_remote(&peer.update(None, 1).unwrap(), 1)
        .unwrap();
    live
}
fn main() {
    let mut cases = Vec::new();
    for (name, offset, length, previous_delete) in [
        ("chinese", 1, 1, false),
        ("emoji", 2, 2, false),
        ("multi-item", 0, 5, false),
        ("prior-delete-basis", 1, 2, true),
    ] {
        let mut live = seed();
        if previous_delete {
            live.edit(Edit::Delete {
                block: "a".into(),
                offset: 5,
                length: 1,
            })
            .unwrap();
        }
        if previous_delete {
            live.edit(Edit::Delete {
                block: "a".into(),
                offset: 1,
                length: 1,
            })
            .unwrap();
        }
        let retained = live.update(None, 1).unwrap();
        let before = live.native_projection().unwrap();
        let log = live.capture_authored_updates().unwrap();
        live.replace_native(NativeReplacement {
            revision: before.revision,
            range: NativeRange {
                location: offset,
                length,
            },
            text: String::new(),
        })
        .unwrap();
        let records = log.drain_records();
        assert_eq!(records.len(), 1);
        let evidence = records[0].deletion().expect("real command captured");
        cases.push(json!({"name":name,"retainedBodyBase64":STANDARD.encode(retained),"beforeText":before.text,"afterText":live.native_projection().unwrap().text,
            "exactUpdateBase64":STANDARD.encode(records[0].update()),"sourceRetentionProvenance":evidence.transaction(),"sourceOperationIntent":evidence.intent()}));
    }
    println!("{}",serde_json::to_string_pretty(&json!({"synthetic":true,"claim":"Native command observation only; not journal durability, authentication or deletion-routing authorization","cases":cases})).unwrap());
}
