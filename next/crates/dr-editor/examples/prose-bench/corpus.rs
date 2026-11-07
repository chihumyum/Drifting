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
use std::time::Instant;

use dr_doc::schema::prose::BODY;
use dr_editor::SessionSource;
use dr_testkit::seed::{self, Preset};
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use gpui::SharedString;
use gpui_prose::{Book, Chapter, ProseDoc};
use serde_json::{Value, json};

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
        let started = Instant::now();
        let dir = scratch_dir();
        let seeded = seed::generate(Preset::Heavy, seed::DEFAULT_SEED).expect("generate the seed");
        let shape = seeded.shape().to_json();
        let chars: HashMap<String, usize> = seeded
            .books
            .iter()
            .flat_map(|b| &b.prose)
            .map(|p| (p.doc_id().to_string(), p.view().len()))
            .collect();
        {
            let lib = dr_store::Library::open(dir.path(), library_options(VERSION))
                .expect("open the library");
            seeded.write_to(&lib).expect("write the seed");
            // Search and derived indexes built now: in a library that has been
            // open a while they are, and a rebuild in the background holds
            // SQLite's write lock in front of the keystrokes being measured.
            lib.rebuild_stale_indexes().expect("build the indexes");
            lib.close().expect("close the library");
        }
        // The generator's copy of the book is not part of what is measured.
        drop(seeded);
        let lib = dr_store::Library::open(dir.path(), library_options(VERSION))
            .expect("open the library");
        let ws = Workspace::open(lib, WorkspaceOptions::default()).expect("open the workspace");
        let call = |name: &str, input: Value| {
            ws.call(&Actor::User, name, input)
                .unwrap_or_else(|e| panic!("{name}: {e}"))["output"]
                .clone()
        };
        let book = call("book.list", json!({}))[0]["id"]
            .as_str()
            .expect("a book")
            .to_owned();
        let chapters: Vec<Listed> = call("chapter.list", json!({ "book": book }))
            .as_array()
            .expect("the chapters")
            .iter()
            .map(|c| {
                let doc = format!("node:{}", c["id"].as_str().expect("a chapter id"));
                Listed {
                    chars: *chars.get(&doc).expect("the chapter's seeded body"),
                    title: c["title"].as_str().unwrap_or_default().to_owned(),
                    doc,
                }
            })
            .collect();
        // The first of the longest, if two are as long.
        let longest = (0..chapters.len())
            .rev()
            .max_by_key(|&i| chapters[i].chars)
            .expect("a chapter");
        eprintln!(
            "[{:6.1} s] seeded the heavy preset: {} chapters, the longest {} chars",
            started.elapsed().as_secs_f64(),
            chapters.len(),
            chapters[longest].chars
        );
        Corpus {
            ws: Some(ws),
            chapters,
            longest,
            shape,
            _dir: dir,
        }
    }

    pub fn ws(&self) -> &Workspace {
        self.ws.as_ref().expect("the workspace is open")
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
