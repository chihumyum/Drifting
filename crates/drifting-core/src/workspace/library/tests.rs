use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};

const CLIENT: &str = "synthetic-library";
const NOW: &str = "2026-09-27T00:00:00.000Z";
const SEED: &str =
    "AQPC7RoABwEHZGVmYXVsdAMJcGFyYWdyYXBoBwDC7RoABigAwu0aAAJpZAF3FXRyYXNoLXN5bnRoZXRpYy1ibG9jawA=";
const CACHE: &str =
    r#"{"type":"doc","content":[{"type":"paragraph","attrs":{"id":"trash-synthetic-block"}}]}"#;

fn context() -> AuthoredProseContext {
    AuthoredProseContext {
        project_id: "library-project".into(),
        project_sync_id: "library-project-sync".into(),
        sync_generation_id: "library-generation".into(),
        installation_id: "library-installation".into(),
        new_writer_id: "library-writer".into(),
        new_writer_epoch: "library-epoch".into(),
        now_iso: NOW.into(),
        now_ms: 200,
    }
}
fn seed() -> ChapterSeed {
    ChapterSeed {
        update: STANDARD.decode(SEED).unwrap(),
        content_json: CACHE.into(),
    }
}
fn rows(g: &DatabaseGateway, sql: &str) -> Vec<Vec<V>> {
    g.query(sql.into(), vec![], None, CLIENT.into())
        .unwrap()
        .rows
}
fn image<'a>(id: &str, source: &'a Path) -> NewAssetFile<'a> {
    NewAssetFile {
        asset_id: id.into(),
        mime: "image/png".into(),
        extension: "png".into(),
        width: Some(640),
        height: Some(480),
        source,
    }
}

#[test]
fn workspace_library_items_assets_and_portraits() {
    let dir = tempfile::tempdir().unwrap();
    let g = DatabaseGateway::new(dir.path().join("db")).unwrap();
    g.open("library.db".into(), CLIENT.into(), false).unwrap();
    let assets = AssetStore::new(dir.path().join("assets"), "library-session");
    let source = dir.path().join("synthetic.png");
    std::fs::write(&source, b"synthetic png").unwrap();
    let pdf = dir.path().join("synthetic.pdf");
    std::fs::write(&pdf, b"%PDF-synthetic").unwrap();
    let store = WorkspaceStore::new(&g, CLIENT);
    let c = context();
    store
        .create_project(
            &c,
            CreateProject {
                user_id: "local-user".into(),
                name: "素材".into(),
                default_kv_ids: std::array::from_fn(|i| format!("library-fact-{i}")),
            },
        )
        .unwrap();
    // An image and a PDF land in the store, committed with their rows.
    let photo = store
        .import_library_file(
            &c,
            &assets,
            "photo",
            " 北塔远景 ",
            image("asset-photo", &source),
        )
        .unwrap();
    assert_eq!(
        (photo.title.as_str(), photo.kind.as_str(), photo.order_key),
        ("北塔远景", "image", 1)
    );
    let asset = photo.asset.clone().unwrap();
    assert_eq!(
        (asset.size_bytes, asset.width, asset.extension.as_str()),
        (13, Some(640), "png")
    );
    let photo_path = assets.path(&c.project_id, "asset-photo", "png").unwrap();
    assert!(photo_path.exists() && !photo_path.with_file_name(".importing").exists());
    let paper = store
        .import_library_file(
            &c,
            &assets,
            "paper",
            "考据",
            NewAssetFile {
                asset_id: "asset-paper".into(),
                mime: "application/pdf".into(),
                extension: "pdf".into(),
                width: None,
                height: None,
                source: &pdf,
            },
        )
        .unwrap();
    assert_eq!((paper.kind.as_str(), paper.order_key), ("pdf", 2));
    // The stored extension follows the MIME type, whatever the host sends.
    let jpeg = store
        .import_library_file(
            &c,
            &assets,
            "jpeg",
            "照片",
            NewAssetFile {
                asset_id: "asset-jpeg".into(),
                mime: "image/jpeg".into(),
                extension: "JPEG".into(),
                width: Some(4),
                height: Some(3),
                source: &source,
            },
        )
        .unwrap();
    assert_eq!(jpeg.asset.unwrap().extension, "jpg");
    assert!(assets
        .path(&c.project_id, "asset-jpeg", "jpg")
        .unwrap()
        .exists());
    // A refused row leaves no bytes behind.
    assert!(store
        .import_library_file(&c, &assets, "photo", "重复", image("asset-dup", &source))
        .is_err());
    assert!(!dir.path().join("assets/library-project/asset-dup").exists());
    assert!(store
        .import_library_file(
            &c,
            &assets,
            "bad",
            "x",
            NewAssetFile {
                asset_id: "asset-bad".into(),
                mime: "text/plain".into(),
                extension: "txt".into(),
                width: None,
                height: None,
                source: &source
            }
        )
        .is_err());
    // Links and text notes; notes and body edits journal one field each.
    let link = store
        .create_library_link(&c, "link", "钟楼资料", " https://example.invalid/tower ")
        .unwrap();
    assert_eq!(
        link.external_url.as_deref(),
        Some("https://example.invalid/tower")
    );
    assert!(store
        .create_library_link(&c, "bad-link", "x", "ftp://x")
        .is_err());
    let note = store
        .create_library_text(&c, "note", "灵感", "第一行\n第二行")
        .unwrap();
    assert_eq!(note.text, "第一行\n第二行");
    let edited = store
        .update_library_item(&c, "note", Some("灵感 2"), Some("来自旧稿"), Some("新正文"))
        .unwrap();
    assert_eq!(
        (
            edited.title.as_str(),
            edited.notes.as_str(),
            edited.text.as_str()
        ),
        ("灵感 2", "来自旧稿", "新正文")
    );
    let unchanged = rows(&g, "SELECT count(*) FROM sync_change_set");
    store
        .update_library_item(&c, "note", Some("灵感 2"), Some("来自旧稿"), Some("新正文"))
        .unwrap();
    assert_eq!(rows(&g, "SELECT count(*) FROM sync_change_set"), unchanged);
    assert!(
        store
            .update_library_item(&c, "photo", None, None, Some("x"))
            .is_err(),
        "only text notes have a body"
    );
    assert_eq!(
        store
            .library_items(&c.project_id)
            .unwrap()
            .iter()
            .map(|i| i.id.as_str())
            .collect::<Vec<_>>(),
        ["photo", "paper", "jpeg", "link", "note"]
    );
    // Deleting removes the rows, then the bytes.
    store.delete_library_item(&c, &assets, "photo").unwrap();
    assert!(!photo_path.exists());
    assert!(rows(&g, "SELECT 1 FROM project_asset WHERE id='asset-photo'").is_empty());
    assert!(store.delete_library_item(&c, &assets, "photo").is_err());
    // Portraits: set, replace (the old asset is released), clear.
    store
        .create_element_category(
            &c,
            NewElementCategory {
                id: "people".into(),
                name: "人物".into(),
                color: "#336699".into(),
                seed: seed(),
            },
        )
        .unwrap();
    let mut ids = 0;
    store
        .create_element(
            &c,
            NewElement {
                id: "mira".into(),
                category_id: "people".into(),
                name: Some("米拉".into()),
                group_name: None,
                seed: seed(),
            },
            &mut || {
                ids += 1;
                Ok(format!("library-kv-{ids}"))
            },
        )
        .unwrap();
    let portrait = store
        .set_element_portrait(&c, &assets, "mira", Some(image("portrait-1", &source)))
        .unwrap()
        .unwrap();
    assert_eq!(portrait.asset.id, "portrait-1");
    store
        .set_element_portrait(&c, &assets, "mira", Some(image("portrait-2", &source)))
        .unwrap();
    assert!(!dir
        .path()
        .join("assets/library-project/portrait-1")
        .exists());
    assert_eq!(
        store.element_portraits(&c.project_id).unwrap()[0].asset.id,
        "portrait-2"
    );
    // A trashed element keeps its portrait and restores with it.
    store.trash_element(&c, "mira").unwrap();
    store
        .restore_element(&c, "mira", |repo, tx, doc| {
            Ok(ChapterSeed {
                update: repo.list_updates(doc, None, Some(tx))?[0]
                    .update_blob
                    .clone(),
                content_json: CACHE.into(),
            })
        })
        .unwrap();
    assert_eq!(store.element_portraits(&c.project_id).unwrap().len(), 1);
    assert_eq!(
        store
            .set_element_portrait(&c, &assets, "mira", None)
            .unwrap(),
        None
    );
    assert!(store.element_portraits(&c.project_id).unwrap().is_empty());
    assert!(!dir
        .path()
        .join("assets/library-project/portrait-2")
        .exists());
    // Collection keeps committed assets and removes strays.
    std::fs::create_dir_all(dir.path().join("assets/library-project/stray")).unwrap();
    let collected = assets
        .collect_garbage(&store.retained_assets().unwrap())
        .unwrap();
    assert_eq!(collected.removed, 1);
    assert!(assets
        .path(&c.project_id, "asset-paper", "pdf")
        .unwrap()
        .exists());
}
