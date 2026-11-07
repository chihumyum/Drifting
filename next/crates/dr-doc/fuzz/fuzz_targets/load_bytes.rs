//! Arbitrary bytes as stored blobs: loading or importing them must never
//! panic, and whatever loads must be readable and editable.

#![no_main]

use dr_doc::book::BookDoc;
use dr_doc::prose::ProseDoc;
use dr_model::id::BookId;
use dr_model::{DocId, Origin};
use libfuzzer_sys::fuzz_target;

#[path = "common.rs"]
mod common;

fuzz_target!(|data: &[u8]| {
    // Up to three blobs, split at the positions the first two bytes name.
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
});
