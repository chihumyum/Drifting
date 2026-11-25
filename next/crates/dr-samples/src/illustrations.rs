//! Public-domain 1894 Hugh Thomson illustrations bundled for the
//! *Pride and Prejudice* built-in sample (see `ASSET_PROVENANCE.md`).

use dr_model::id::{AssetFolderId, AssetId};
use dr_model::kind::AssetKind;
use dr_model::pos::PosKey;
use dr_model::shared::Asset;
use dr_store::Library;
use dr_store::asset::{Variant, VariantBytes};

use crate::layout::sample_id;

pub struct BundledIllustration {
    pub name: &'static str,
    pub title: &'static str,
    pub sha256: &'static str,
    pub width: u32,
    pub height: u32,
    pub display: &'static [u8],
    pub thumbnail: &'static [u8],
}

pub const PRIDE_AND_PREJUDICE_KEY: &str = "sample/pride-and-prejudice";

/// The five Hugh Thomson material illustrations for *Pride and Prejudice*.
pub static PRIDE_AND_PREJUDICE_ILLUSTRATIONS: &[BundledIllustration] = &[
    BundledIllustration {
        name: "mr-and-mrs-bennet",
        title: "Mr. & Mrs. Bennet",
        sha256: "5a1e9d45a6b0ad4a6c415426e15fe1240fb987d17d9d901aefb665a1c9353ff2",
        width: 613,
        height: 760,
        display: include_bytes!("../books/pride-and-prejudice/mr-and-mrs-bennet.jpg"),
        thumbnail: include_bytes!("../books/pride-and-prejudice/mr-and-mrs-bennet.thumbnail.jpg"),
    },
    BundledIllustration {
        name: "she-is-tolerable",
        title: "“She is tolerable”",
        sha256: "b75c50f62bc3cbc81ab4c81d7ad035cd7b42baa933d05229f25e4350e696d9d5",
        width: 652,
        height: 760,
        display: include_bytes!("../books/pride-and-prejudice/she-is-tolerable.jpg"),
        thumbnail: include_bytes!("../books/pride-and-prejudice/she-is-tolerable.thumbnail.jpg"),
    },
    BundledIllustration {
        name: "never-read-novels",
        title: "“Protested that he never read novels”",
        sha256: "3e79b53f51cfa581cec303af02e0ec70096138e6a95a04924fec3e57bf6ab483",
        width: 498,
        height: 760,
        display: include_bytes!("../books/pride-and-prejudice/never-read-novels.jpg"),
        thumbnail: include_bytes!("../books/pride-and-prejudice/never-read-novels.thumbnail.jpg"),
    },
    BundledIllustration {
        name: "hearing-herself-called",
        title: "“Hearing herself called”",
        sha256: "37c6c2e5b43d4609b51fc3b7d85d169cbb85b6e48402a7e5826fe81d2218517c",
        width: 760,
        height: 621,
        display: include_bytes!("../books/pride-and-prejudice/hearing-herself-called.jpg"),
        thumbnail: include_bytes!(
            "../books/pride-and-prejudice/hearing-herself-called.thumbnail.jpg"
        ),
    },
    BundledIllustration {
        name: "after-a-short-survey",
        title: "“After a short survey”",
        sha256: "8d65070a26f5357e3619d65bddfe59a9bac000a7240611f703ad63cf970ceec1",
        width: 484,
        height: 760,
        display: include_bytes!("../books/pride-and-prejudice/after-a-short-survey.jpg"),
        thumbnail: include_bytes!(
            "../books/pride-and-prejudice/after-a-short-survey.thumbnail.jpg"
        ),
    },
];

pub fn pride_and_prejudice_book_id() -> String {
    sample_id(PRIDE_AND_PREJUDICE_KEY, "book", 0)
}

pub fn illustrations_folder_id() -> AssetFolderId {
    AssetFolderId::parse(&sample_id(PRIDE_AND_PREJUDICE_KEY, "asset-folder", 0))
        .expect("deterministic asset folder id")
}

pub fn asset_id(index: usize) -> AssetId {
    AssetId::parse(&sample_id(PRIDE_AND_PREJUDICE_KEY, "asset", index))
        .expect("deterministic asset id")
}

/// Deterministic `Asset` metadata records for *Pride and Prejudice*.
pub fn pride_and_prejudice_assets() -> Vec<Asset> {
    let folder = illustrations_folder_id();
    let positions = crate::build::positions(PRIDE_AND_PREJUDICE_ILLUSTRATIONS.len());
    PRIDE_AND_PREJUDICE_ILLUSTRATIONS
        .iter()
        .enumerate()
        .map(|(i, item)| Asset {
            id: asset_id(i),
            name: item.title.into(),
            kind: AssetKind::Image,
            mime: "image/jpeg".into(),
            size: item.display.len() as i64,
            sha256: item.sha256.into(),
            width: Some(item.width as i64),
            height: Some(item.height as i64),
            created_at: None,
            folder: Some(folder.clone()),
            pos: Some(positions[i].clone()),
            deleted_at: None,
            trashed_with: None,
        })
        .collect()
}

/// Writes the bundled JPEG bytes (source, display, thumbnail) for *Pride and
/// Prejudice* into `lib`'s asset store, skipping any asset already stored.
pub fn write_pride_and_prejudice_assets(
    lib: &Library,
    book_id: &str,
) -> std::result::Result<(), crate::WriteError> {
    if book_id != pride_and_prejudice_book_id() {
        return Ok(());
    }
    for (i, item) in PRIDE_AND_PREJUDICE_ILLUSTRATIONS.iter().enumerate() {
        let aid = asset_id(i);
        if lib.asset(aid.as_str(), Variant::Source)?.is_some() {
            continue;
        }
        let mut pending = lib.begin_asset_import(book_id, aid.as_str())?;
        let display = VariantBytes {
            bytes: item.display.to_vec(),
            mime: "image/jpeg".into(),
            ext: "jpg".into(),
            width: item.width,
            height: item.height,
        };
        let thumb_w = (item.width / 2).max(1);
        let thumb_h = (item.height / 2).max(1);
        let thumbnail = VariantBytes {
            bytes: item.thumbnail.to_vec(),
            mime: "image/jpeg".into(),
            ext: "jpg".into(),
            width: thumb_w,
            height: thumb_h,
        };
        if let Err(e) = pending
            .write_variant(Variant::Source, &display)
            .and_then(|_| pending.write_variant(Variant::Display, &display))
            .and_then(|_| pending.write_variant(Variant::Thumbnail, &thumbnail))
        {
            let _ = pending.abandon();
            return Err(e.into());
        }
        pending.commit()?;
    }
    Ok(())
}

/// Deterministic position for the "Illustrations" asset folder.
pub fn illustrations_folder_pos() -> PosKey {
    PosKey::first()
}
