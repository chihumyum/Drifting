//! The corpus: F8's heavy seed (`dr_testkit::seed`, 100 chapters, about
//! 1.65 million characters), written into a library in a temporary
//! directory and opened through the workspace, as Drifting opens a book.
//! "The book" is every chapter; "the chapter" is the seed's longest (its
//! 20 000-word maximum, the benchmarks' 20k-char chapter), with the seed's
//! own headings, inline styles and entity links.
//!
//! Every document the editor gets opens through `dr_editor::SessionSource`,
//! Drifting's real path: reads on the document holder's thread, every
//! keystroke a dr-doc transaction persisted to SQLite before it returns, every
//! commit reaching the editor as an event. Where a measurement needs the
//! standalone `LoroSource` instead (an in-memory comparison, the synthetic
//! screenshots), it says so.

use std::collections::HashMap;

use dr_doc::schema::prose::BODY;
use dr_editor::SessionSource;
use dr_testkit::seed::{self, Preset};
use dr_workspace::{Workspace, library_options};
use gpui::SharedString;
use gpui_prose::{Book, Chapter, ProseDoc};
use serde_json::Value;

const VERSION: &str = env!("CARGO_PKG_VERSION");

/// One chapter as the book lists it.
pub struct Listed {
    /// The prose document, `node:<id>`.
    pub doc: String,
    pub title: String,
    /// Unicode scalars of its body as seeded, the final newline included.
    pub chars: usize,
}

/// The heavy seed in a library, open in a workspace.
pub struct Corpus {
    ws: Option<Workspace>,
    /// In reading order.
    pub chapters: Vec<Listed>,
    /// The longest chapter (an index into `chapters`).
    pub longest: usize,
    /// The seed's shape (preset, seed, sizes, corpus fingerprint), for the
    /// evidence.
    pub shape: Value,
    _dir: tempfile::TempDir,
}

impl Corpus {
    /// Generates the heavy preset, writes it into a fresh library and opens
    /// the workspace on it.
    pub fn heavy() -> Corpus {
        Self::heavy_v3()
    }

    pub fn ws(&self) -> &Workspace {
        self.ws.as_ref().expect("the workspace is open")
    }

    fn heavy_v3() -> Corpus {
        let dir = scratch_dir();
        let seeded = seed::generate_v3(Preset::Heavy, seed::DEFAULT_SEED).expect("v3 heavy seed");
        let shape = seeded.shape().to_json();
        let book = seeded.books[0].book_id().to_string();
        let chars: HashMap<_, _> = seeded
            .books
            .iter()
            .flat_map(|b| &b.prose)
            .map(|p| (p.doc_id().to_string(), p.view().len()))
            .collect();
        {
            let lib =
                dr_store::Library::open(dir.path(), library_options(VERSION)).expect("library");
            seeded.write_to(&lib).expect("write v3 seed");
            lib.rebuild_stale_indexes().expect("indexes");
            lib.close().expect("close library");
        }
        drop(seeded);
        let ws = Workspace::open_dir(dir.path(), VERSION).expect("workspace");
        let chapters: Vec<_> = dr_editor::v3::read(&ws, &book, |view| {
            let root = dr_editor::v3::manuscript_roots(&view)
                .into_iter()
                .next()
                .expect("manuscript root");
            dr_editor::v3::flatten_book(&view, &root).expect("flatten manuscript")
        })
        .expect("manuscript order")
        .into_iter()
        .filter_map(|s| Some((s.doc?, s.title)))
        .map(|(doc, title)| Listed {
            chars: *chars.get(&doc).expect("seeded body"),
            doc,
            title,
        })
        .collect();
        let longest = (0..chapters.len())
            .rev()
            .max_by_key(|&i| chapters[i].chars)
            .expect("body");
        Corpus {
            ws: Some(ws),
            chapters,
            longest,
            shape,
            _dir: dir,
        }
    }

    /// One prose document through a workspace session (Drifting's path).
    pub fn open(&self, doc: &str) -> ProseDoc {
        let source = SessionSource::open(self.ws(), doc)
            .unwrap_or_else(|e| panic!("open a session on {doc}: {e}"));
        ProseDoc::open(Box::new(source))
    }

    /// Every chapter's session and document, on all cores, as dr-editor's
    /// `BookEditor` opens a book.
    pub fn open_all(&self) -> Vec<ProseDoc> {
        let workers = std::thread::available_parallelism()
            .map_or(4, |n| n.get())
            .clamp(1, self.chapters.len().max(1));
        let next = std::sync::atomic::AtomicUsize::new(0);
        let slots: Vec<std::sync::Mutex<Option<ProseDoc>>> = self
            .chapters
            .iter()
            .map(|_| std::sync::Mutex::new(None))
            .collect();
        std::thread::scope(|scope| {
            for _ in 0..workers {
                scope.spawn(|| {
                    loop {
                        let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        let Some(chapter) = self.chapters.get(i) else {
                            break;
                        };
                        let doc = self.open(&chapter.doc);
                        *slots[i].lock().unwrap_or_else(|e| e.into_inner()) = Some(doc);
                    }
                });
            }
        });
        slots
            .into_iter()
            .map(|slot| {
                slot.into_inner()
                    .unwrap_or_else(|e| e.into_inner())
                    .expect("every chapter opened")
            })
            .collect()
    }

    /// The whole book for the editor.
    pub fn book(&self) -> Book {
        let docs = self.open_all();
        Book::new(
            docs.into_iter()
                .zip(&self.chapters)
                .map(|(doc, listed)| Chapter {
                    title: SharedString::from(listed.title.clone()),
                    doc,
                })
                .collect(),
        )
    }

    /// The longest chapter alone.
    pub fn chapter(&self) -> Book {
        let listed = &self.chapters[self.longest];
        Book::new(vec![Chapter {
            title: SharedString::from(listed.title.clone()),
            doc: self.open(&listed.doc),
        }])
    }

    pub fn titles(&self) -> Vec<SharedString> {
        self.chapters
            .iter()
            .map(|c| SharedString::from(c.title.clone()))
            .collect()
    }

    pub fn chapter_title(&self) -> SharedString {
        SharedString::from(self.chapters[self.longest].title.clone())
    }

    pub fn book_chars(&self) -> usize {
        self.chapters.iter().map(|c| c.chars).sum()
    }

    pub fn chapter_chars(&self) -> usize {
        self.chapters[self.longest].chars
    }
}

impl Drop for Corpus {
    fn drop(&mut self) {
        if let Some(ws) = self.ws.take() {
            let _ = ws.shutdown();
        }
    }
}

/// What storage holds of a document's body, in Unicode scalars (the final
/// newline included): read on the holder's thread, so marked text that the
/// editor shows but has not committed is not in it. `None` for a document
/// that is not on a workspace session.
pub fn stored_len(doc: &ProseDoc) -> Option<usize> {
    doc.source_as::<SessionSource>()?
        .handle()
        .read(|d| d.get_text(BODY).len_unicode())
        .ok()
}

/// A temporary directory for the library, under `<tmp>/prose-bench/`.
/// GPUI's run loop ends the process without dropping anything, and so does
/// the watchdog, so the directories of earlier runs whose process is gone
/// are removed first.
fn scratch_dir() -> tempfile::TempDir {
    let parent = std::env::temp_dir().join("prose-bench");
    std::fs::create_dir_all(&parent).expect("create the scratch directory");
    for entry in std::fs::read_dir(&parent).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let pid = name.split('-').next().and_then(|p| p.parse::<i32>().ok());
        if pid.is_some_and(|pid| !alive(pid)) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
    tempfile::Builder::new()
        .prefix(&format!("{}-", std::process::id()))
        .tempdir_in(&parent)
        .expect("create the library directory")
}

fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 only asks whether the process exists.
    let found = unsafe { libc::kill(pid, 0) } == 0;
    found || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}
