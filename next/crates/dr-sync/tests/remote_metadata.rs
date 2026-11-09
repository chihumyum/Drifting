use std::fs;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use dr_store::asset::{MAX_COPY_BYTES, SourceImport, Variant};
use dr_store::{Library, LibraryOptions};
use dr_sync::{FakeSyncServer, RemoteObjectPayload, SyncEngine, SyncError, SyncHttpClient};
use loro::{ExportMode, LoroDoc, VersionVector};

const TOKEN: &str = "synthetic-sync-token";

fn asset_payload() -> RemoteObjectPayload {
    RemoteObjectPayload::AssetBlob {
        asset_id: "synthetic-asset".into(),
        book_id: "synthetic-book".into(),
        variant: "source".into(),
        mime: "application/octet-stream".into(),
        ext: "bin".into(),
        width: None,
        height: None,
    }
}

#[test]
fn absolute_asset_id_is_rejected_without_changing_outside_library_bytes() {
    let scratch = tempfile::tempdir().unwrap();
    let victim = scratch.path().join("synthetic-manuscript-source.txt");
    let original = b"synthetic author text that must survive";
    fs::write(&victim, original).unwrap();
    let library = Library::open(
        scratch.path().join("library"),
        LibraryOptions::new("0.2.0-test"),
    )
    .unwrap();
    let server = FakeSyncServer::start(TOKEN);
    let client = SyncHttpClient::new(server.base_url()).unwrap();
    let mut payload = asset_payload();
    if let RemoteObjectPayload::AssetBlob { asset_id, ext, .. } = &mut payload {
        *asset_id = scratch
            .path()
            .join("synthetic-manuscript")
            .to_str()
            .unwrap()
            .to_owned();
        *ext = "txt".into();
    }
    client
        .put_object(TOKEN, "synthetic-object", &payload, b"remote bytes", None)
        .unwrap();
    let mut engine = SyncEngine::new(server.base_url(), &library).unwrap();
    let result = engine.sync_once(&library, TOKEN);

    assert!(victim.is_file(), "sync removed a file outside the library");
    assert_eq!(fs::read(&victim).unwrap(), original);
    assert!(
        matches!(result, Err(SyncError::InvalidPath(_))),
        "{result:?}"
    );
    assert_eq!(engine.cursor(), 0);
    assert!(library.assets_of_book("synthetic-book").unwrap().is_empty());
    assert!(!library.paths().assets.join(".sync-staging").exists());
}

fn assert_rejected_before_download(payload: &RemoteObjectPayload) {
    let scratch = tempfile::tempdir().unwrap();
    let library = Library::open(scratch.path(), LibraryOptions::new("0.2.0-test")).unwrap();
    let server = FakeSyncServer::start(TOKEN);
    let client = SyncHttpClient::new(server.base_url()).unwrap();
    client
        .put_object(TOKEN, "synthetic-object", payload, b"remote bytes", None)
        .unwrap();
    // Only the change-list request may succeed. A premature download would
    // return Offline instead of the required metadata validation error.
    server.set_fail_after_requests(Some(1));
    let mut engine = SyncEngine::new(server.base_url(), &library).unwrap();
    let result = engine.sync_once(&library, TOKEN);
    assert!(
        matches!(result, Err(SyncError::InvalidPath(_))),
        "{payload:?}: {result:?}"
    );
    assert_eq!(engine.cursor(), 0);
    assert!(library.docs(None, None).unwrap().is_empty());
    assert!(library.purged_docs(None).unwrap().is_empty());
    if library.paths().assets.exists() {
        assert_eq!(fs::read_dir(&library.paths().assets).unwrap().count(), 0);
    }
}

fn invalid_path_ids() -> Vec<String> {
    let mut values: Vec<_> = [
        "",
        ".",
        "..",
        ".hidden",
        "asset.",
        " asset",
        "asset ",
        "two words",
        "/tmp/asset",
        "../asset",
        "a/../b",
        "a/b",
        "a\\b",
        "C:\\asset",
        "C:asset",
        "\\\\server\\share",
        "//server/share",
        "\\\\?\\C:\\asset",
        "%2e%2e",
        "a%2Fb",
        "a%5Cb",
        "a:b",
        "a?b",
        "a*b",
        "a|b",
        "a<b",
        "a>b",
        "a\"b",
        "a\0b",
        "a\nb",
        "素材",
        "CON",
        "nul.txt",
        "COM1",
        "lPt9.jpg",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    values.push("a".repeat(129));
    values
}

#[test]
fn asset_and_book_ids_reject_noncanonical_or_nonportable_paths_before_download() {
    for invalid in invalid_path_ids() {
        for is_book in [false, true] {
            let mut payload = asset_payload();
            if let RemoteObjectPayload::AssetBlob {
                asset_id, book_id, ..
            } = &mut payload
            {
                if is_book {
                    *book_id = invalid.clone();
                } else {
                    *asset_id = invalid.clone();
                }
            }
            assert_rejected_before_download(&payload);
        }
    }
}

#[test]
fn variants_and_extensions_are_validated_before_download() {
    for invalid in [
        "",
        "Source",
        "..",
        "source/..",
        "source\\..",
        "source:stream",
        "display.",
        "thumbnail ",
    ] {
        let mut payload = asset_payload();
        if let RemoteObjectPayload::AssetBlob { variant, .. } = &mut payload {
            *variant = invalid.into();
        }
        assert_rejected_before_download(&payload);
    }
    for invalid in [
        "",
        ".",
        ".png",
        "PNG",
        "png.",
        "png ",
        " png",
        "p/ng",
        "p\\ng",
        "../txt",
        "C:txt",
        "x:stream",
        "%2f",
        "p\0ng",
        "png?download",
        "abcdefghijklmnopq",
        "图片",
    ] {
        let mut payload = asset_payload();
        if let RemoteObjectPayload::AssetBlob { ext, .. } = &mut payload {
            *ext = invalid.into();
        }
        assert_rejected_before_download(&payload);
    }
}

#[test]
fn duplicate_assets_cannot_bypass_metadata_validation() {
    for field in ["asset_id", "book_id", "ext"] {
        let scratch = tempfile::tempdir().unwrap();
        let source = scratch.path().join("input.bin");
        let original = b"synthetic local asset bytes";
        fs::write(&source, original).unwrap();
        let library = Library::open(
            scratch.path().join("library"),
            LibraryOptions::new("0.2.0-test"),
        )
        .unwrap();
        // F2's legacy import permits sanitizing an id. Sync must still reject
        // its noncanonical remote spelling, even when the exact row exists.
        let id = if field == "asset_id" {
            "unsafe/asset"
        } else {
            "synthetic-asset"
        };
        library
            .import_asset(&SourceImport {
                book_id: "synthetic-book",
                asset_id: id,
                source: &source,
                mime: "application/octet-stream",
                ext: "bin",
                dimensions: None,
                limit: MAX_COPY_BYTES,
            })
            .unwrap();
        library.mark_asset_uploaded(id, Variant::Source).unwrap();
        let before = library.asset(id, Variant::Source).unwrap().unwrap();

        let server = FakeSyncServer::start(TOKEN);
        let client = SyncHttpClient::new(server.base_url()).unwrap();
        let mut payload = asset_payload();
        if let RemoteObjectPayload::AssetBlob {
            asset_id,
            book_id,
            ext,
            ..
        } = &mut payload
        {
            match field {
                "asset_id" => *asset_id = id.into(),
                "book_id" => *book_id = "../book".into(),
                "ext" => *ext = "../bin".into(),
                _ => unreachable!(),
            }
        }
        client
            .put_object(TOKEN, "synthetic-object", &payload, b"remote bytes", None)
            .unwrap();
        server.set_fail_after_requests(Some(1));
        let mut engine = SyncEngine::new(server.base_url(), &library).unwrap();
        let result = engine.sync_once(&library, TOKEN);
        assert!(
            matches!(result, Err(SyncError::InvalidPath(_))),
            "{field}: {result:?}"
        );
        assert_eq!(engine.cursor(), 0);
        assert_eq!(library.asset(id, Variant::Source).unwrap().unwrap(), before);
        assert_eq!(fs::read(&before.path).unwrap(), original);
        assert!(!library.paths().assets.join(".sync-staging").exists());
    }
}

fn document_payload(doc_id: &str, book_id: Option<&str>, purge: bool) -> RemoteObjectPayload {
    if purge {
        RemoteObjectPayload::DocPurge {
            doc_id: doc_id.into(),
            kind: "custom-document-kind".into(),
            book_id: book_id.map(str::to_owned),
            purged_ms: 1,
        }
    } else {
        RemoteObjectPayload::LoroUpdate {
            doc_id: doc_id.into(),
            kind: "custom-document-kind".into(),
            book_id: book_id.map(str::to_owned),
            vv_base64: URL_SAFE_NO_PAD.encode(VersionVector::default().encode()),
            is_snapshot: false,
        }
    }
}

#[test]
fn document_limits_and_book_ids_are_checked_before_update_or_purge() {
    for purge in [false, true] {
        for doc_id in [
            "".into(),
            "doc\0id".into(),
            "doc\nid".into(),
            "a".repeat(257),
        ] {
            assert_rejected_before_download(&document_payload(&doc_id, None, purge));
        }
        for book_id in invalid_path_ids() {
            assert_rejected_before_download(&document_payload(
                "body:book/item/prose",
                Some(&book_id),
                purge,
            ));
        }
    }
}

#[test]
fn opaque_document_ids_keep_colons_slashes_and_storage_length_limit() {
    let scratch = tempfile::tempdir().unwrap();
    let library = Library::open(scratch.path(), LibraryOptions::new("0.2.0-test")).unwrap();
    let server = FakeSyncServer::start(TOKEN);
    let client = SyncHttpClient::new(server.base_url()).unwrap();
    let doc = LoroDoc::new();
    doc.get_map("metadata").insert("synthetic", true).unwrap();
    let bytes = doc.export(ExportMode::all_updates()).unwrap();
    let doc_ids = [
        "body:book/item/prose".into(),
        "template:book/tpl/prose".into(),
        "d".repeat(256),
    ];
    for (i, doc_id) in doc_ids.iter().enumerate() {
        let mut payload = document_payload(doc_id, Some("synthetic-book"), false);
        if let RemoteObjectPayload::LoroUpdate { vv_base64, .. } = &mut payload {
            *vv_base64 = URL_SAFE_NO_PAD.encode(doc.oplog_vv().encode());
        }
        client
            .put_object(TOKEN, &format!("update-{i}"), &payload, &bytes, None)
            .unwrap();
    }
    let mut engine = SyncEngine::new(server.base_url(), &library).unwrap();
    let report = engine.sync_once(&library, TOKEN).unwrap();
    assert_eq!(report.downloaded_docs, doc_ids.len());
    for doc_id in &doc_ids {
        assert_eq!(
            library.load_copy(doc_id).unwrap().get_deep_value(),
            doc.get_deep_value()
        );
    }

    let purge = document_payload(&doc_ids[0], Some("synthetic-book"), true);
    client
        .put_object(TOKEN, "purge", &purge, b"", None)
        .unwrap();
    let report = engine.sync_once(&library, TOKEN).unwrap();
    assert_eq!(report.applied_purges, 1);
    assert!(library.doc_info(&doc_ids[0]).unwrap().is_none());
    assert!(library.purged(&doc_ids[0]).unwrap().is_some());
    assert!(library.doc_info(&doc_ids[1]).unwrap().is_some());
}

#[test]
fn canonical_asset_paths_accept_all_variants_and_identifier_extension_limits() {
    let scratch = tempfile::tempdir().unwrap();
    let library = Library::open(scratch.path(), LibraryOptions::new("0.2.0-test")).unwrap();
    let server = FakeSyncServer::start(TOKEN);
    let client = SyncHttpClient::new(server.base_url()).unwrap();
    let ids = [
        ("book.part-1_".into(), "_asset..part-1".into()),
        ("b".repeat(128), "a".repeat(128)),
    ];
    for (i, (book, asset)) in ids.iter().enumerate() {
        for variant in ["source", "display", "thumbnail"] {
            let payload = RemoteObjectPayload::AssetBlob {
                asset_id: asset.clone(),
                book_id: book.clone(),
                variant: variant.into(),
                mime: "application/octet-stream".into(),
                ext: "abcdefghijklmnop".into(),
                width: Some(1),
                height: Some(1),
            };
            client
                .put_object(
                    TOKEN,
                    &format!("asset-{i}-{variant}"),
                    &payload,
                    b"remote bytes",
                    None,
                )
                .unwrap();
        }
    }
    let mut engine = SyncEngine::new(server.base_url(), &library).unwrap();
    let report = engine.sync_once(&library, TOKEN).unwrap();
    assert_eq!(report.downloaded_assets, 6);
    for (book, asset) in &ids {
        for variant in [Variant::Source, Variant::Display, Variant::Thumbnail] {
            let record = library.asset(asset, variant).unwrap().unwrap();
            assert_eq!(&record.book_id, book);
            assert_eq!(fs::read(&record.path).unwrap(), b"remote bytes");
            assert!(record.path.starts_with(&library.paths().assets));
            assert!(record.uploaded_ms.is_some());
        }
    }
    assert_eq!(
        fs::read_dir(library.paths().assets.join(".sync-staging"))
            .unwrap()
            .count(),
        0
    );
}
