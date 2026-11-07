//! The inputs the fuzz targets crashed on (`fuzz/`), replayed through the
//! same code the target runs. Both are fuzzer-made bytes (synthetic):
//!
//! - `load-bytes-unchecked-checksum.bin`: a corrupted blob that made Loro's
//!   `import_batch` ask for 28.7 GB (it skips checksums); fixed by checking
//!   every blob first (`core.rs`).
//! - `load-bytes-anchor-missing-container.bin`: an anchor naming a container
//!   that does not exist, on which Loro panics; fixed in `anchor.rs`.

#[path = "../fuzz/fuzz_targets/common.rs"]
mod common;

use dr_doc::book::BookDoc;
use dr_doc::prose::ProseDoc;
use dr_model::id::BookId;
use dr_model::{DocId, Origin};

/// What the `load_bytes` target does with one input.
fn load_bytes(data: &[u8]) {
    let (head, rest) = data.split_at(data.len().min(2));
    let mut blobs = Vec::new();
    let mut cut = 0;
    for b in head {
        let at = (*b as usize).min(rest.len());
        if at > cut {
            blobs.push(rest[cut..at].to_vec());
            cut = at;
        }
    }
    blobs.push(rest[cut..].to_vec());
    let id = DocId::parse("node:fuzz").unwrap();
    if let Ok(mut d) = ProseDoc::load(id.clone(), 7, &blobs) {
        common::exercise_prose(&mut d, data);
    }
    let mut d = ProseDoc::create(id, 7).unwrap();
    for b in &blobs {
        let _ = d.import(b, Origin::Sync);
    }
    common::exercise_prose(&mut d, data);
    let book = BookId::parse("fuzz").unwrap();
    if let Ok(mut b) = BookDoc::load(book.clone(), 7, &blobs) {
        common::exercise_book(&mut b);
    }
    let mut b = BookDoc::create(book, 7).unwrap();
    for x in &blobs {
        let _ = b.import(x, Origin::Sync);
    }
    common::exercise_book(&mut b);
}

#[test]
fn a_blob_with_a_bad_checksum_is_an_error_not_an_allocation() {
    load_bytes(include_bytes!(
        "fuzz-regressions/load-bytes-unchecked-checksum.bin"
    ));
}

#[test]
fn an_anchor_into_a_missing_container_does_not_panic() {
    load_bytes(include_bytes!(
        "fuzz-regressions/load-bytes-anchor-missing-container.bin"
    ));
}
