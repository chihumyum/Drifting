use drifting_core::database::{DatabaseGateway, DatabaseValue as V};
use drifting_document::{DocumentSession, Edit};
use drifting_prose::search::read_search_text;

#[test]
fn closed_search_is_read_only_and_releases_failed_captures() {
    let directory = tempfile::tempdir().unwrap();
    let gateway = DatabaseGateway::new(directory.path().into()).unwrap();
    let client = "synthetic-search";
    gateway
        .open("synthetic.db".into(), client.into(), false)
        .unwrap();
    let mut doc = DocumentSession::with_test_client_id(88002).unwrap();
    doc.edit(Edit::AppendParagraph {
        id: "block".into(),
        text: "合成👩🏽‍🚀".into(),
    })
    .unwrap();
    let bytes = doc.update(None, 1).unwrap();
    gateway
        .execute(
            "INSERT INTO yjs_snapshots VALUES (?, ?, ?)".into(),
            vec![
                V::Text("node-content:synthetic".into()),
                V::Blob(bytes.clone()),
                V::Text("synthetic-time".into()),
            ],
            None,
            client.into(),
        )
        .unwrap();
    gateway
        .execute(
            "INSERT INTO yjs_document_revision VALUES (?, ?, ?)".into(),
            vec![
                V::Text("node-content:synthetic".into()),
                V::Integer("7".into()),
                V::Text("synthetic-time".into()),
            ],
            None,
            client.into(),
        )
        .unwrap();
    let before = gateway
        .query("SELECT total_changes()".into(), vec![], None, client.into())
        .unwrap();
    let rows = read_search_text(
        &gateway,
        client,
        &["node-content:synthetic".into(), "node-content:seed".into()],
    )
    .unwrap();
    assert_eq!(rows[0].revision, 7);
    assert_eq!(
        rows[0].blocks.as_ref().unwrap(),
        &vec!["合成👩🏽‍🚀".to_string()]
    );
    assert!(rows[1].blocks.is_none());
    assert!(read_search_text(&gateway, client, &["".into()]).is_err());
    assert!(
        read_search_text(&gateway, client, &vec!["node-content:synthetic".into(); 17]).is_err()
    );
    assert_eq!(
        gateway
            .query("SELECT total_changes()".into(), vec![], None, client.into())
            .unwrap(),
        before
    );
    assert_eq!(
        gateway
            .query(
                "SELECT state_blob FROM yjs_snapshots".into(),
                vec![],
                None,
                client.into()
            )
            .unwrap()
            .rows[0][0],
        V::Blob(bytes)
    );
    gateway
        .execute(
            "UPDATE yjs_snapshots SET state_blob = X'ffff'".into(),
            vec![],
            None,
            client.into(),
        )
        .unwrap();
    assert!(
        read_search_text(&gateway, client, &["node-content:synthetic".into()]).unwrap()[0]
            .blocks
            .is_none()
    );
    gateway.close(client.into()).unwrap();
}
