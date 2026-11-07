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
    assert!(lib.import_asset(&source("../x", "a", &file, 1024)).is_err());
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

    // An import another (dead) process left behind, and a directory whose
    // rows were deleted, are collected; this process's pending import stays.
    fs::create_dir_all(assets.join("book-1/orphan")).unwrap();
    fs::write(assets.join("book-1/orphan/.importing"), b"another-session").unwrap();
    fs::write(assets.join("book-1/orphan/source.pdf"), b"x").unwrap();
    fs::create_dir_all(assets.join("book-1/deleted")).unwrap();
    fs::write(assets.join("book-1/deleted/source.png"), b"x").unwrap();
    let g = lib.collect_asset_garbage().unwrap();
    assert_eq!((g.removed, g.cleared_markers), (2, 0));
    assert!(assets.join("book-1/asset-1/source.png").exists());

    assert!(lib.remove_asset("asset-1").unwrap());
    assert!(!assets.join("book-1/asset-1").exists());
    assert!(lib.asset("asset-1", Variant::Source).unwrap().is_none());
    assert!(!lib.remove_asset("asset-1").unwrap());
}
