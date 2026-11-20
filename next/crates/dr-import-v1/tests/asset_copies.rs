//! 0.1's display and thumbnail copies carried with an image the new client
//! cannot decode itself (`dr_import_v1::copies`), on the synthetic 0.1
//! library with its image turned into an iPhone photo: the HEIC source and,
//! beside it, the `display.jpg` and `thumbnail.jpg` 0.1 makes
//! (`asset-store.service.ts`). The copies are stored byte for byte as the
//! asset's display and thumbnail variants, the source stays the original,
//! the 0.1 folder is only read, and the receipt and the loss detector
//! account for every copy carried or not.

mod common;

use std::collections::BTreeMap;
use std::io::Cursor;
use std::path::{Path, PathBuf};

use common::*;
use dr_import_v1::copies::why;
use dr_import_v1::receipt::BookRecord;
use dr_import_v1::run::{self, Options, Outcome};
use dr_import_v1::verify::{self, CatalogCheck};
use dr_store::asset::Variant;
use dr_store::{Library, LibraryOptions};

/// A JPEG of `width × height` in the quadrants' top-left red, as 0.1 would
/// have encoded its copy.
fn jpeg(width: u32, height: u32) -> Vec<u8> {
    let mut out = Vec::new();
    image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
        width,
        height,
        image::Rgb([200, 40, 40]),
    ))
    .write_to(&mut Cursor::new(&mut out), image::ImageFormat::Jpeg)
    .unwrap();
    out
}

fn asset_dir(old: &Old) -> PathBuf {
    old.root.join("assets").join(BOOK).join(ASSET)
}

/// The library with its image as a HEIC (the rows 0.1 writes for one) and
/// `copies` (file name → bytes) beside the source.
fn with_heic(copies: &[(&str, Vec<u8>)]) -> Old {
    let old = build_v3(true);
    let dir = asset_dir(&old);
    std::fs::remove_file(dir.join("source.png")).unwrap();
    std::fs::write(dir.join("source.heic"), dr_testkit::media::HEIC).unwrap();
    for (name, bytes) in copies {
        std::fs::write(dir.join(name), bytes).unwrap();
    }
    rusqlite::Connection::open(&old.db)
        .unwrap()
        .execute(
            "UPDATE project_asset SET source_mime = 'image/heic', source_size_bytes = ?1, source_sha256 = ?2, width = 600, height = 400 WHERE id = ?3",
            rusqlite::params![
                dr_testkit::media::HEIC.len() as i64,
                sha256_bytes(dr_testkit::media::HEIC),
                ASSET
            ],
        )
        .unwrap();
    old
}

/// Every file under `root`: its path and its bytes' hash.
fn files(root: &Path) -> BTreeMap<PathBuf, String> {
    let mut out = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                stack.push(path);
            } else {
                out.insert(path.clone(), sha256_bytes(&std::fs::read(&path).unwrap()));
            }
        }
    }
    out
}

fn import(old: &Old) -> (tempfile::TempDir, PathBuf, BookRecord) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("library");
    let mut options = Options::new("asset-copies-test");
    options.v3 = v3_choices();
    options.old_root = Some(old.root.clone());
    options.index = false;
    options.accept = dr_import_v1::gate::Accept::EVERYTHING;
    let (outcome, _) = run::import(&old.db, &root, &options).unwrap();
    let Outcome::Imported(receipt) = outcome else {
        panic!("not imported")
    };
    let book = receipt
        .books
        .iter()
        .find(|b| b.book_id == BOOK)
        .unwrap()
        .clone();
    assert_eq!(book.status, "imported");
    (temp, root, book)
}

fn open(root: &Path) -> Library {
    let start = std::time::Instant::now();
    loop {
        let mut o = LibraryOptions::new("asset-copies-test");
        o.configure_doc = Some(std::sync::Arc::new(dr_doc::schema::configure));
        match Library::open(root, o) {
            Ok(lib) => return lib,
            // m10-import.md 待协调 12: a closed library's lock can outlive
            // `close` for a moment.
            Err(error)
                if error.to_string().contains("already open") && start.elapsed().as_secs() < 5 =>
            {
                std::thread::sleep(std::time::Duration::from_millis(20))
            }
            Err(error) => panic!("{error}"),
        }
    }
}

fn tally(check: &CatalogCheck, table: &str) -> (usize, usize, usize) {
    let t = check.tables.get(table).cloned().unwrap_or_default();
    (t.source, t.carried, t.dropped)
}

#[test]
fn a_heic_comes_with_0_1s_copies_and_the_0_1_folder_is_only_read() {
    let display = jpeg(600, 400);
    let thumbnail = jpeg(512, 341);
    let old = with_heic(&[
        ("display.jpg", display.clone()),
        ("thumbnail.jpg", thumbnail.clone()),
    ]);
    let before = files(&old.root);
    let (_temp, root, book) = import(&old);
    assert_eq!(files(&old.root), before, "the 0.1 folder is not written");

    let lib = open(&root);
    // The source is the original.
    let source = lib.asset(ASSET, Variant::Source).unwrap().unwrap();
    assert_eq!(source.mime, "image/heic");
    assert_eq!(
        std::fs::read(&source.path).unwrap(),
        dr_testkit::media::HEIC
    );
    // 0.1's copies, byte for byte, as the display and thumbnail variants.
    for (variant, bytes, size) in [
        (Variant::Display, &display, (600, 400)),
        (Variant::Thumbnail, &thumbnail, (512, 341)),
    ] {
        let copy = lib.asset(ASSET, variant).unwrap().unwrap();
        assert_eq!(copy.mime, "image/jpeg");
        assert_eq!(copy.ext, "jpg");
        assert_eq!((copy.width, copy.height), (Some(size.0), Some(size.1)));
        assert_eq!(&std::fs::read(&copy.path).unwrap(), bytes);
        assert_eq!(copy.sha256, sha256_bytes(bytes));
    }
    assert_eq!(
        book.asset_copies_carried,
        BTreeMap::from([(
            ASSET.to_owned(),
            vec!["display".to_owned(), "thumbnail".to_owned()]
        )])
    );
    assert!(book.asset_copies_missing.is_empty());

    let check = verify::check_catalog_in(&old.db, &lib).unwrap();
    assert!(check.is_clean(), "{:#?}", check.unexplained);
    assert_eq!(tally(&check, "project_asset (display)"), (1, 1, 0));
    assert_eq!(tally(&check, "project_asset (thumbnail)"), (1, 1, 0));
    lib.close().unwrap();
}

#[test]
fn copies_missing_or_damaged_in_0_1_are_recorded_and_left_to_the_client() {
    let thumbnail = jpeg(512, 341);
    let cut = thumbnail[..thumbnail.len() - 40].to_vec();
    let old = with_heic(&[("thumbnail.jpg", cut)]);
    let (_temp, root, book) = import(&old);
    assert!(book.asset_copies_carried.is_empty());
    assert_eq!(
        book.asset_copies_missing,
        BTreeMap::from([(
            ASSET.to_owned(),
            BTreeMap::from([
                ("display".to_owned(), why::MISSING.to_owned()),
                ("thumbnail".to_owned(), why::TRUNCATED.to_owned()),
            ])
        )])
    );
    let lib = open(&root);
    // The source came; the copies are the new client's to make.
    assert!(lib.asset(ASSET, Variant::Source).unwrap().is_some());
    assert!(lib.asset(ASSET, Variant::Display).unwrap().is_none());
    assert!(lib.asset(ASSET, Variant::Thumbnail).unwrap().is_none());
    let check = verify::check_catalog_in(&old.db, &lib).unwrap();
    assert!(check.is_clean(), "{:#?}", check.unexplained);
    assert_eq!(tally(&check, "project_asset (display)"), (1, 0, 1));
    assert_eq!(tally(&check, "project_asset (thumbnail)"), (1, 0, 1));

    // Negative control: a receipt that no longer says why.
    lib.local_transaction(|tx| {
        tx.execute(
            "UPDATE import_book SET record_json = json_remove(record_json, '$.assetCopiesMissing')",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    let unrecorded = verify::check_catalog_in(&old.db, &lib).unwrap();
    assert_eq!(
        unrecorded
            .unexplained
            .iter()
            .map(|u| (u.table.as_str(), u.id.as_str()))
            .collect::<Vec<_>>(),
        [
            ("project_asset (display)", ASSET),
            ("project_asset (thumbnail)", ASSET)
        ]
    );
    lib.close().unwrap();
}

#[test]
fn an_image_the_new_client_reads_itself_does_not_take_0_1s_copies() {
    // The fixture's image stays a PNG; 0.1's copies lie beside it.
    let old = build_v3(true);
    std::fs::write(asset_dir(&old).join("display.jpg"), jpeg(600, 400)).unwrap();
    std::fs::write(asset_dir(&old).join("thumbnail.jpg"), jpeg(512, 341)).unwrap();
    let (_temp, root, book) = import(&old);
    assert!(book.asset_copies_carried.is_empty());
    assert!(book.asset_copies_missing.is_empty());
    let lib = open(&root);
    assert!(lib.asset(ASSET, Variant::Source).unwrap().is_some());
    assert!(lib.asset(ASSET, Variant::Display).unwrap().is_none());
    let check = verify::check_catalog_in(&old.db, &lib).unwrap();
    assert!(check.is_clean(), "{:#?}", check.unexplained);
    assert!(!check.tables.contains_key("project_asset (display)"));
    lib.close().unwrap();
}
