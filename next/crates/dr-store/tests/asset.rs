//! Asset files and rows: import protocol, variants, removal, garbage.

mod common;

use std::fs;
use std::path::Path;

use common::*;
use dr_store::StoreError;
use dr_store::asset::{Derived, ImageDeriver, SourceImport, Variant, VariantBytes};

fn source<'a>(book: &'a str, asset: &'a str, path: &'a Path, limit: u64) -> SourceImport<'a> {
    SourceImport {
        book_id: book,
        asset_id: asset,
        source: path,
        mime: "image/png",
        ext: "PNG",
        dimensions: Some((4, 3)),
        limit,
    }
}

struct FakeDeriver;

impl ImageDeriver for FakeDeriver {
    fn derive(&self, source: &Path, mime: &str) -> Result<Derived, String> {
        assert_eq!(mime, "image/png");
        let bytes = fs::read(source).map_err(|e| e.to_string())?;
        let jpeg = |n: usize, w, h| VariantBytes {
            bytes: bytes.iter().cycle().take(n).copied().collect(),
            mime: "image/jpeg".into(),
            ext: "jpg".into(),
            width: w,
            height: h,
        };
        Ok(Derived {
            display: jpeg(64, 4, 3),
            thumbnail: jpeg(16, 2, 1),
        })
    }
}

#[test]
fn import_variants_remove_and_collect() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("portrait.png");
    fs::write(&file, b"synthetic image bytes").unwrap();
    let lib = open(&dir.path().join("lib"));
    let assets = lib.paths().assets.clone();

    let r = lib
        .import_asset(&source("book-1", "asset-1", &file, 1024))
        .unwrap();
    assert_eq!(r.size, 21);
    assert_eq!(r.ext, "png");
    assert_eq!(r.path, assets.join("book-1/asset-1/source.png"));
    assert_eq!(
        r.sha256,
        "9d714b0153c5204b5503770a41d5800ed8ba4e24da1a9429b6654397075031b6"
    );
    assert!(
        !assets.join("book-1/asset-1/.importing").exists(),
        "marker cleared"
    );
    assert!(
        lib.import_asset(&source("book-1", "asset-1", &file, 1024))
            .is_err(),
        "sources are immutable"
    );
    assert!(
        matches!(
            lib.import_asset(&source("book-1", "asset-2", &file, 4)),
            Err(StoreError::Asset(_))
        ),
        "size cap"
    );
    assert!(
        !assets.join("book-1/asset-2").exists(),
        "a failed import leaves nothing"
    );
    // Ids are sanitized the 0.1 way, so they always stay inside the store.
    let escaped = lib.import_asset(&source("../x", "a", &file, 1024)).unwrap();
    assert_eq!(escaped.path, assets.join("_.._x/a/source.png"));
    lib.remove_asset("a").unwrap();
    let mut bad_ext = source("book-1", "asset-3", &file, 1024);
    bad_ext.ext = "p/g";
    assert!(lib.import_asset(&bad_ext).is_err());

    // Variants.
    let (display, thumb) = lib.derive_variants("asset-1", &FakeDeriver).unwrap();
    assert_eq!(display.path, assets.join("book-1/asset-1/display.jpg"));
    assert_eq!(thumb.path, assets.join("book-1/asset-1/thumbnail.jpg"));
    assert_eq!(fs::read(&thumb.path).unwrap().len(), 16);
    assert_eq!(
        lib.asset("asset-1", Variant::Thumbnail).unwrap().unwrap(),
        thumb
    );
    assert!(
        lib.put_variant(
            "asset-1",
            Variant::Source,
            &VariantBytes {
                bytes: vec![1],
                mime: "image/png".into(),
                ext: "png".into(),
                width: 1,
                height: 1
            }
        )
        .is_err()
    );
    assert_eq!(lib.assets_of_book("book-1").unwrap().len(), 3);
    assert_eq!(
        lib.find_asset_by_sha256("book-1", &r.sha256)
            .unwrap()
            .unwrap()
            .asset_id,
        "asset-1"
    );

    // An import another (dead) process left behind is collected; a
    // directory without a marker is never collected (0.1 semantics).
    fs::create_dir_all(assets.join("book-1/orphan")).unwrap();
    fs::write(
        assets.join("book-1/orphan/.drifting-import-v1"),
        b"another-session",
    )
    .unwrap();
    fs::write(assets.join("book-1/orphan/source.pdf"), b"x").unwrap();
    fs::create_dir_all(assets.join("book-1/unmarked")).unwrap();
    fs::write(assets.join("book-1/unmarked/source.png"), b"x").unwrap();
    let g = lib.collect_asset_garbage().unwrap();
    assert_eq!((g.removed_orphans, g.cleared_committed_markers), (1, 0));
    assert!(!assets.join("book-1/orphan").exists());
    assert!(assets.join("book-1/unmarked/source.png").exists());
    assert!(assets.join("book-1/asset-1/source.png").exists());

    // Upload state.
    assert_eq!(lib.assets_pending_upload().unwrap().len(), 3);
    assert!(lib.mark_asset_uploaded("asset-1", Variant::Source).unwrap());
    assert_eq!(lib.assets_pending_upload().unwrap().len(), 2);
    assert!(
        lib.asset("asset-1", Variant::Source)
            .unwrap()
            .unwrap()
            .uploaded_ms
            .is_some()
    );

    assert!(lib.remove_asset("asset-1").unwrap());
    assert!(!assets.join("book-1/asset-1").exists());
    assert!(lib.asset("asset-1", Variant::Source).unwrap().is_none());
    assert!(!lib.remove_asset("asset-1").unwrap());
}

#[test]
fn imports_follow_the_marker_protocol() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("scan.pdf");
    fs::write(&file, b"%PDF synthetic").unwrap();
    let lib = open(&dir.path().join("lib"));
    let assets = lib.paths().assets.clone();

    // Begin: directory and marker exist, no row yet.
    let mut import = lib.begin_asset_import("book/1", "asset 1").unwrap();
    let asset_dir = import.dir().to_path_buf();
    assert_eq!(asset_dir, assets.join("book_1/asset_1"), "0.1 sanitizing");
    assert!(asset_dir.join(".drifting-import-v1").exists());
    import
        .copy_variant(Variant::Source, &file, "application/pdf", "pdf", None, 1024)
        .unwrap();
    import
        .write_variant(
            Variant::Thumbnail,
            &VariantBytes {
                bytes: vec![1, 2, 3],
                mime: "image/jpeg".into(),
                ext: "jpg".into(),
                width: 2,
                height: 2,
            },
        )
        .unwrap();
    // This process's import in flight survives garbage collection.
    lib.collect_asset_garbage().unwrap();
    assert!(asset_dir.join("source.pdf").exists());
    assert!(lib.asset("asset 1", Variant::Source).unwrap().is_none());
    let records = import.commit().unwrap();
    assert_eq!(records.len(), 2);
    assert!(
        !asset_dir.join(".drifting-import-v1").exists(),
        "marker cleared after the rows"
    );
    assert_eq!(lib.assets_of_book("book/1").unwrap().len(), 2);

    // An abandoned import leaves nothing.
    let pending = lib.begin_asset_import("book/1", "asset-2").unwrap();
    let pending_dir = pending.dir().to_path_buf();
    pending.abandon().unwrap();
    assert!(!pending_dir.exists());

    // An import without a source cannot commit.
    let pending = lib.begin_asset_import("book/1", "asset-3").unwrap();
    assert!(pending.commit().is_err());
}
