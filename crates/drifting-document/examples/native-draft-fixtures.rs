use base64::{engine::general_purpose::STANDARD, Engine};
use drifting_document::{DocumentSession, Edit, NativeInputEdit, NativeRange};
use serde_json::json;
fn source() -> DocumentSession {
    let mut seed = DocumentSession::with_test_client_id(65301).unwrap();
    seed.edit(Edit::AppendParagraph {
        id: "p".into(),
        text: "甲乙丙".into(),
    })
    .unwrap();
    let mut peer = DocumentSession::with_test_client_id(65302).unwrap();
    peer.apply_remote(&seed.update(None, 1).unwrap(), 1)
        .unwrap();
    peer.edit(Edit::Insert {
        block: "p".into(),
        offset: 1,
        text: "中🙂".into(),
    })
    .unwrap();
    let mut owner = DocumentSession::with_test_client_id(65303).unwrap();
    owner
        .apply_remote(&peer.update(None, 1).unwrap(), 1)
        .unwrap();
    owner
}
fn main() {
    let mut cases = Vec::new();
    for name in [
        "prefix-cross-client-emoji",
        "partial-remote-delete",
        "interior-remote-insert",
        "all-remote-deleted",
    ] {
        let mut owner = source();
        let authored_basis = owner.update(None, 1).unwrap();
        owner.fork_input("q".into(), None).unwrap();
        let log = owner.capture_authored_updates().unwrap();
        let mut peer = DocumentSession::with_test_client_id(65304).unwrap();
        peer.apply_remote(&authored_basis, 1).unwrap();
        let sv = peer.state_vector();
        match name {
            "prefix-cross-client-emoji" => peer
                .edit(Edit::Insert {
                    block: "p".into(),
                    offset: 0,
                    text: "远端".into(),
                })
                .unwrap(),
            "partial-remote-delete" => {
                peer.edit(Edit::Delete {
                    block: "p".into(),
                    offset: 1,
                    length: 1,
                })
                .unwrap();
                peer.edit(Edit::Insert {
                    block: "p".into(),
                    offset: 0,
                    text: "远".into(),
                })
                .unwrap();
            }
            "interior-remote-insert" => peer
                .edit(Edit::Insert {
                    block: "p".into(),
                    offset: 2,
                    text: "远".into(),
                })
                .unwrap(),
            _ => peer
                .edit(Edit::Delete {
                    block: "p".into(),
                    offset: 1,
                    length: 4,
                })
                .unwrap(),
        }
        owner
            .apply_remote(&peer.update(Some(&sv), 1).unwrap(), 1)
            .unwrap();
        let live_basis = owner.update(None, 1).unwrap();
        let before = owner.native_projection().unwrap();
        let authored = owner
            .replace_input(NativeInputEdit {
                key: "q".into(),
                sequence: 0,
                range: NativeRange {
                    location: 1,
                    length: 4,
                },
                text: "".into(),
                selection: None,
            })
            .unwrap();
        let records = log.drain_records();
        let rows:Vec<_>=records.iter().map(|record|json!({"exactUpdateBase64":STANDARD.encode(record.update()),"sourceRetentionProvenance":record.deletion().map(|proof|proof.transaction()),"sourceOperationIntent":record.deletion().map(|proof|proof.intent())})).collect();
        cases.push(json!({"name":name,"originalRange":{"location":1,"length":4},"authoredBasisBase64":STANDARD.encode(authored_basis),"liveBasisBase64":STANDARD.encode(live_basis),"beforeText":before.text,"afterText":owner.native_projection().unwrap().text,"authoredAfterText":authored.text,"records":rows}));
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({"synthetic":true,"cases":cases})).unwrap()
    );
}
