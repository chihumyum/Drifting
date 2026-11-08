#![allow(dead_code)]

use std::path::Path;
use std::sync::Arc;

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

/// Synthetic text and edits for these tests, on dr-testkit's random streams
/// and corpus (the shared seeds); no manuscript text.
pub mod synthetic {
    use loro::{ExpandType, LoroDoc, StyleConfig, StyleConfigMap};

    pub use dr_corpus::rng::Rng;

    /// The text container edits go to.
    pub const BODY: &str = "body";

    /// A style configuration shaped like loro-schema v0 (paragraph
    /// attributes without expansion, bold expanding after).
    pub fn configure(doc: &LoroDoc) {
        let mut map = StyleConfigMap::new();
        map.insert(
            "heading".into(),
            StyleConfig {
                expand: ExpandType::None,
            },
        );
        map.insert(
            "bold".into(),
            StyleConfig {
                expand: ExpandType::After,
            },
        );
        doc.config_text_style(map);
    }

    /// About `words` words of dr-testkit's corpus, one paragraph per line.
    pub fn chapter(rng: &mut Rng, words: usize) -> String {
        let paras = dr_corpus::text::body(rng, words, dr_corpus::text::BodyShape::default());
        dr_corpus::text::plain(&paras)
    }

    /// One keystroke-sized edit near `cursor`: insert a few characters, or
    /// (one time in six) delete one to three. Returns the new cursor.
    pub fn keystroke(doc: &LoroDoc, rng: &mut Rng, cursor: usize) -> usize {
        let text = doc.get_text(BODY);
        let len = text.len_unicode();
        let at = cursor.min(len.saturating_sub(1));
        if rng.below(6) == 0 && at > 3 {
            let n = rng.range(1, 3);
            text.delete(at - n, n).expect("delete");
            at - n
        } else {
            let s = ["潮", "灯", "记", "录", "风"][rng.below(5) as usize].repeat(rng.range(1, 6));
            text.insert(at, &s).expect("insert");
            at + s.chars().count()
        }
    }

    /// The `k` the copies test records in `meta.k`, or -1.
    pub fn last_crash_edit(doc: &LoroDoc) -> i64 {
        match doc.get_map("meta").get("k") {
            Some(loro::ValueOrContainer::Value(loro::LoroValue::I64(k))) => k,
            _ => -1,
        }
    }

    /// A deriver for tests: one block per line of `body`, no block ids,
    /// every character a word. Counts its calls and how many had diffs.
    #[derive(Default)]
    pub struct LinesDeriver {
        pub calls: std::sync::atomic::AtomicUsize,
        pub with_changes: std::sync::atomic::AtomicUsize,
    }

    impl dr_store::index::Deriver for LinesDeriver {
        fn derive(
            &self,
            input: &dr_store::index::DeriveInput<'_>,
        ) -> Option<dr_store::index::DerivedUpdate> {
            use std::sync::atomic::Ordering;
            self.calls.fetch_add(1, Ordering::Relaxed);
            if input.changes.is_some() {
                self.with_changes.fetch_add(1, Ordering::Relaxed);
            }
            let text = input.doc.get_text(BODY).to_string();
            let blocks: Vec<dr_store::index::BlockRow> = text
                .split_terminator('\n')
                .map(|line| dr_store::index::BlockRow {
                    block_id: None,
                    heading: 0,
                    chars: line.chars().count() as u32,
                    text: line.to_string(),
                })
                .collect();
            let chars = blocks.iter().map(|b| b.chars as u64).sum();
            Some(dr_store::index::DerivedUpdate::Full(
                dr_store::index::Derived {
                    words: chars,
                    chars,
                    blocks,
                    references: Vec::new(),
                },
            ))
        }
    }
}
