#![allow(dead_code)]

use std::path::Path;
use std::sync::Arc;

use dr_store::synthetic;
use dr_store::{DocHandle, DocView, Library, LibraryOptions, OpenDoc, Origin};
use loro::{LoroDoc, LoroText};

pub const VERSION: &str = "0.2.0-test";

pub fn options() -> LibraryOptions {
    let mut o = LibraryOptions::new(VERSION);
    o.configure_doc = Some(Arc::new(synthetic::configure));
    o
}

pub fn open(dir: &Path) -> Library {
    Library::open(dir, options()).expect("open library")
}

/// A genesis like dr-doc's: a fixed peer with the top bit set, timestamp 0,
/// one paragraph break.
pub fn genesis(doc: &LoroDoc) {
    doc.set_peer_id((1 << 63) | 0x5EED).unwrap();
    doc.set_next_commit_timestamp(0);
    doc.get_text(synthetic::BODY).insert(0, "\n").unwrap();
}

pub fn create(lib: &Library, doc_id: &str) -> DocHandle {
    lib.open_doc(
        doc_id,
        OpenDoc::CreateIfMissing {
            kind: "node",
            book_id: Some("book-1"),
            genesis: &genesis,
        },
    )
    .expect("open doc")
}

/// The body text of a document or of an open document's view.
pub trait Body {
    fn body(&self) -> LoroText;
}

impl Body for LoroDoc {
    fn body(&self) -> LoroText {
        self.get_text(synthetic::BODY)
    }
}

impl Body for DocView {
    fn body(&self) -> LoroText {
        self.get_text(synthetic::BODY)
    }
}

pub fn text<D: Body>(doc: &D) -> String {
    doc.body().to_string()
}

pub fn insert(h: &DocHandle, origin: Origin, at: usize, s: &str) {
    let s = s.to_string();
    h.write(origin, move |doc| {
        doc.get_text(synthetic::BODY).insert(at, &s).unwrap();
    })
    .expect("write");
}

pub fn sha256_file(path: &Path) -> String {
    dr_store::digest::file_sha256(path).unwrap().0
}
