//! The editor on Drifting's real write path, on the seed corpus (F8's
//! `dr_testkit::seed`, the Lite preset): opening chapters, a keystroke
//! persisted through the workspace session, undo, and an Agent's command
//! reaching the open editor. No window: the GPUI frame and on-glass
//! measurements are `prose-bench`'s, next to this one (see f4-editor.md).
//!
//! ```text
//! cargo run --release -p dr-editor --example editor-bench            # print
//! cargo run --release -p dr-editor --example editor-bench -- --write # f4-m3-editor-bench.json
//! ```

use std::time::Instant;

use dr_editor::SessionSource;
use dr_testkit::evidence::{self, Evidence, Summary};
use dr_testkit::seed::{self, Preset};
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use gpui_prose::text::{ORIGIN_USER, ProseDoc};
use serde_json::{Value, json};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const KEYS: usize = 400;
const STEPS: usize = 60;

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}

fn summary(samples: &[f64]) -> Value {
    serde_json::to_value(Summary::of(samples)).expect("summary")
}

fn out(ws: &Workspace, actor: &Actor, name: &str, input: Value) -> Value {
    ws.call(actor, name, input)
        .unwrap_or_else(|e| panic!("{name}: {e}"))["output"]
        .clone()
}

fn open(ws: &Workspace, doc: &str) -> ProseDoc {
    ProseDoc::open(Box::new(SessionSource::open(ws, doc).expect("open")))
}

fn main() {
    let write = std::env::args().any(|a| a == "--write");
    let dir = tempfile::tempdir().expect("temp dir");
    let seeded = seed::generate(Preset::Lite, seed::DEFAULT_SEED).expect("seed");
    {
        let lib = dr_store::Library::open(dir.path(), library_options(VERSION)).expect("library");
        seeded.write_to(&lib).expect("write the seed");
        // Search and derived indexes built now: in a library that has been
        // open a while they are, and a rebuild in the background holds
        // SQLite's write lock in front of the keystrokes being measured.
        lib.rebuild_stale_indexes().expect("build the indexes");
        lib.close().expect("close");
    }
    let lib = dr_store::Library::open(dir.path(), library_options(VERSION)).expect("library");
    let ws = Workspace::open(lib, WorkspaceOptions::default()).expect("workspace");
    let user = Actor::User;
    let book = out(&ws, &user, "book.list", json!({}))[0]["id"]
        .as_str()
        .expect("a book")
        .to_owned();
    let chapters: Vec<String> = out(&ws, &user, "chapter.list", json!({"book": book}))
        .as_array()
        .expect("chapters")
        .iter()
        .map(|c| format!("node:{}", c["id"].as_str().unwrap()))
        .collect();

    // Opening: the holder loads the document from SQLite (cold), then the
    // same document again while its holder is open (warm).
    let mut cold = Vec::new();
    let mut warm = Vec::new();
    let mut largest = (0usize, String::new());
    for doc in &chapters {
        let t = Instant::now();
        let d = open(&ws, doc);
        cold.push(ms(t));
        let chars = d.len_chars();
        if chars > largest.0 {
            largest = (chars, doc.clone());
        }
        drop(d);
        let t = Instant::now();
        let d = open(&ws, doc);
        warm.push(ms(t));
        drop(d);
    }
    let (largest_chars, largest_doc) = largest;

    // A keystroke: one character through the session (a dr-doc transaction
    // in the holder's write job, appended to SQLite before it returns), and
    // the editor's mirror updated from the event.
    let mut doc = open(&ws, &largest_doc);
    let at = doc.line(0).chars;
    let mut keys = Vec::with_capacity(KEYS);
    for i in 0..KEYS {
        let t = Instant::now();
        doc.replace(at + i..at + i, "字", ORIGIN_USER);
        keys.push(ms(t));
    }
    assert_eq!(doc.mirror_snapshot(), doc.reread(), "the mirror follows");

    // Undo: one author step at a time.
    let mut undo = Vec::with_capacity(STEPS);
    for i in 0..STEPS {
        doc.checkpoint();
        doc.replace(at + i..at + i, "步", ORIGIN_USER);
    }
    for _ in 0..STEPS {
        let t = Instant::now();
        doc.undo();
        undo.push(ms(t));
    }

    // An Agent's command on the open document: the command itself, then the
    // editor folding its event in.
    let agent = Actor::agent("bench", 1, "c");
    let mut command = Vec::with_capacity(STEPS);
    let mut fold = Vec::with_capacity(STEPS);
    // `prose.replace` wants a unique match: one marker, swapped back and forth.
    doc.replace(at..at, "〔甲〕", ORIGIN_USER);
    for i in 0..STEPS {
        let (find, replace) = if i % 2 == 0 {
            ("〔甲〕", "〔乙〕")
        } else {
            ("〔乙〕", "〔甲〕")
        };
        let t = Instant::now();
        out(
            &ws,
            &agent,
            "prose.replace",
            json!({"doc": largest_doc, "find": find, "replace": replace}),
        );
        command.push(ms(t));
        let t = Instant::now();
        doc.drain();
        fold.push(ms(t));
    }
    assert_eq!(
        doc.mirror_snapshot(),
        doc.reread(),
        "the mirror follows the Agent"
    );
    drop(doc);

    // The whole book in editor documents (each chapter its own session).
    let t = Instant::now();
    let docs: Vec<ProseDoc> = chapters.iter().map(|d| open(&ws, d)).collect();
    let book_open = ms(t);
    let book_chars: usize = docs.iter().map(ProseDoc::len_chars).sum();
    drop(docs);

    let results = json!({
        "chapters": chapters.len(),
        "book_chars": book_chars,
        "open_chapter_cold": summary(&cold),
        "open_chapter_warm": summary(&warm),
        "largest_chapter_chars": largest_chars,
        "keystroke": summary(&keys),
        "keystroke_budget_p50_ms": 2.0,
        "undo_step": summary(&undo),
        "agent_command": summary(&command),
        "agent_change_folded": summary(&fold),
        "open_book_ms": (book_open * 1000.0).round() / 1000.0,
    });
    ws.shutdown().expect("shutdown");
    println!("{}", serde_json::to_string_pretty(&results).unwrap());
    if write {
        let root = evidence::workspace_root();
        let mut e = Evidence::new(
            "editor-bench",
            "f4-m3",
            "cargo run --release -p dr-editor --example editor-bench -- --write",
        )
        .inputs(
            &root,
            &[
                "crates/dr-editor",
                "crates/gpui-prose",
                "crates/dr-workspace",
                "crates/dr-store",
                "crates/dr-doc",
                "crates/dr-testkit/src/seed",
            ],
        )
        .expect("fingerprint the inputs");
        e.corpus = seeded.shape().to_json();
        e.results = results;
        let path = e
            .write(&root.join(evidence::DIR))
            .expect("write the evidence");
        eprintln!("wrote {}", path.display());
    }
}
