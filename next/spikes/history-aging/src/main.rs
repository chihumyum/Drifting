//! History aging through the interface layer, without a window.
//!
//! `dr-testkit`'s `chapter-aging` and `book-aging` suites stop at the
//! workspace, because a tool crate cannot depend on the interface. This
//! spike measures the two things above it:
//!
//! - **the editor's undo step**: dr-editor's `SessionSource` under
//!   gpui-prose's text layer (`gpui_prose::text::ProseDoc`), which is what
//!   ⌘Z calls: one author step is every Loro item typed within half a second
//!   of the step's first edit, undone item by item, then the editor's mirror
//!   and anchors brought up to date;
//! - **`dr_shell::Book::load`**: the snapshot of a book the shell builds when
//!   a book opens, on the book document as seeded and after one and three
//!   years of use.
//!
//! ```text
//! cargo run --release -p history-aging-spike            # the heavy seed
//! cargo run --release -p history-aging-spike -- --quick # the tiny seed, a smoke run
//! cargo run --release -p history-aging-spike -- close   # one section only
//! ```
//!
//! Then three things about the automatic entry checkpoints:
//!
//! - **every entry's fingerprint in one pass** over the same three book
//!   documents: entry by entry, as the checkpoints took it until 2026-11-12,
//!   and all at once, as they take it now;
//! - a probe of one product behaviour the book aging depends on: whether an
//!   entry earns an automatic checkpoint when only a sibling changed
//!   (through the real `entry_snapshot.capture` command);
//! - **the last sweep on quitting**: dr-view-history's `capture_on_close`
//!   over a library holding the whole seeded book, the first time (every
//!   entry earns its first checkpoint), again with nothing changed (what
//!   every later quit pays), and after one entry was renamed and one
//!   created.
//!
//! Sections can be picked by name: `editor`, `shell`, `fingerprint`,
//! `probe`, `close` (none named: all of them).
//!
//! Prints milliseconds; nothing is written. See
//! `docs/rust-rewrite/spikes/history-aging.md`.

use std::path::Path;
use std::time::Instant;

use dr_doc::prose::ProseDoc as StoredProse;
use dr_doc::v3::{BookDocV3, genesis_v3};
use dr_editor::SessionSource;
use dr_shell::book::Book;
use dr_testkit::aging::book::BookAging;
use dr_testkit::aging::chapter::ChapterAging;
use dr_testkit::aging::{self, book, chapter};
use dr_testkit::bench::aging::{chapter_suite, open_workspace};
use dr_testkit::bench::{Mode, Scratch};
use dr_testkit::evidence::{self, Summary};
use dr_testkit::seed::{self, DEFAULT_SEED};
use dr_workspace::Workspace;
use gpui_prose::text::{ORIGIN_USER, ProseDoc};

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1e3
}

fn row(label: &str, samples: &[f64]) {
    let s = Summary::of(samples);
    println!(
        "  {label:36} n={:<4} p50 {:>9.3}  p95 {:>9.3}  max {:>9.3}",
        s.n, s.p50, s.p95, s.max
    );
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn open(ws: &Workspace, doc: &str) -> Result<ProseDoc, String> {
    Ok(ProseDoc::open(Box::new(
        SessionSource::open(ws, doc).map_err(err)?,
    )))
}

/// One author step of `items` keystrokes (typed at once, so they fall
/// within the editor's merge interval), undone and redone.
fn step(doc: &mut ProseDoc, at: usize, items: usize) -> Result<(f64, f64), String> {
    doc.checkpoint();
    let steps = doc.undo_count();
    for k in 0..items {
        doc.replace(at + k..at + k, "字", ORIGIN_USER);
    }
    if doc.undo_count() != steps + 1 {
        return Err(format!(
            "{items} keystrokes made {} steps, not one",
            doc.undo_count() - steps
        ));
    }
    let t = Instant::now();
    doc.undo().ok_or("nothing to undo")?;
    let undo = ms(t);
    let t = Instant::now();
    doc.redo().ok_or("nothing to redo")?;
    Ok((undo, ms(t)))
}

fn editor(mode: Mode, dir: &Path, book: &BookDocV3, chapter: &StoredProse) -> Result<(), String> {
    let all = Default::default();
    let id = chapter.doc_id().to_string();
    let ws = open_workspace(dir)?;
    aging::store(
        ws.library(),
        book.book_id(),
        chapter.doc_id(),
        dr_doc::prose::genesis(chapter.doc_id()),
        chapter.export_updates_since(&all).map_err(err)?,
    )
    .map_err(err)?;
    aging::store(
        ws.library(),
        book.book_id(),
        book.doc_id(),
        genesis_v3(book.book_id()),
        book.export_updates_since(&all).map_err(err)?,
    )
    .map_err(err)?;
    ws.shutdown().map_err(err)?;

    let mut cold = Vec::new();
    for _ in 0..mode.reps(2, 5) {
        let ws = open_workspace(dir)?;
        let t = Instant::now();
        let doc = open(&ws, &id)?;
        cold.push(ms(t));
        drop(doc);
        ws.shutdown().map_err(err)?;
    }
    row("open (workspace just opened)", &cold);

    let ws = open_workspace(dir)?;
    let mut doc = open(&ws, &id)?;
    let middle = doc.len_chars() / 2;
    let mut keys = Vec::new();
    for k in 0..mode.reps(20, 300) {
        let t = Instant::now();
        doc.replace(middle + k..middle + k, "字", ORIGIN_USER);
        keys.push(ms(t));
    }
    row("keystroke", &keys);
    for items in [1usize, 4, 20] {
        let (mut undo, mut redo) = (Vec::new(), Vec::new());
        for k in 0..mode.reps(2, 12) {
            // Somewhere else each time, as an author moves about.
            let at = (middle + 997 * (k + 1) * items) % (doc.len_chars() - items - 1);
            let (u, r) = step(&mut doc, at, items)?;
            undo.push(u);
            redo.push(r);
        }
        row(&format!("undo a step of {items}"), &undo);
        row(&format!("redo a step of {items}"), &redo);
    }
    if doc.mirror_snapshot() != doc.reread() {
        return Err("the editor's mirror no longer matches the document".into());
    }
    drop(doc);
    ws.shutdown().map_err(err)
}

fn shell(mode: Mode, dir: &Path, doc: &BookDocV3) -> Result<(), String> {
    let book = doc.book_id().to_string();
    let ws = open_workspace(dir)?;
    aging::store(
        ws.library(),
        doc.book_id(),
        doc.doc_id(),
        genesis_v3(doc.book_id()),
        doc.export_updates_since(&Default::default()).map_err(err)?,
    )
    .map_err(err)?;
    ws.shutdown().map_err(err)?;
    let mut cold = Vec::new();
    for _ in 0..mode.reps(2, 5) {
        let ws = open_workspace(dir)?;
        let t = Instant::now();
        let loaded = Book::load(&ws, &book).map_err(err)?;
        cold.push(ms(t));
        if loaded.v3().is_none() {
            return Err("Book::load did not read a v3 book".into());
        }
        ws.shutdown().map_err(err)?;
    }
    row("Book::load (workspace just opened)", &cold);
    let ws = open_workspace(dir)?;
    Book::load(&ws, &book).map_err(err)?;
    let mut warm = Vec::new();
    for _ in 0..mode.reps(3, 10) {
        let t = Instant::now();
        Book::load(&ws, &book).map_err(err)?;
        warm.push(ms(t));
    }
    row("Book::load (book already open)", &warm);
    ws.shutdown().map_err(err)
}

/// Every entry's fingerprint, taken once over the whole book: what the
/// automatic checkpoints compute after a book change that touches entries.
/// Until 2026-11-12 they asked for each entry by itself
/// (`entry_owned_raw_state`, which reads the whole book again for every
/// entry, so the pass grew with the square of the entries; it still serves
/// previews and restores, one entry at a time); now they read all entries in
/// one pass (`entry_change_states`). The old way gets one sample.
fn fingerprints(mode: Mode, doc: &BookDocV3) -> Result<(), String> {
    let hash = |state: &serde_json::Value| -> Result<usize, String> {
        Ok(dr_store::digest::sha256_hex(&serde_json::to_vec(state).map_err(err)?).len())
    };
    let v = doc.view();
    let t = Instant::now();
    let mut each = 0;
    for e in v.entries_raw() {
        each += hash(&v.entry_owned_raw_state(&e.id).ok_or("an entry is gone")?)?;
    }
    row("entry by entry (until 2026-11-12)", &[ms(t)]);
    let mut once = Vec::new();
    for _ in 0..mode.reps(3, 10) {
        let t = Instant::now();
        let mut all = 0;
        for (_, state) in v.entry_change_states() {
            all += hash(&state)?;
        }
        once.push(ms(t));
        if all != each {
            return Err("the two passes did not see the same entries".into());
        }
    }
    row("all entries in one pass (now)", &once);
    Ok(())
}

/// Whether an automatic checkpoint is saved for an entry whose own content
/// did not change, after a sibling was created or another entry edited, and
/// that one is saved when the entry itself moves: the real commands on the
/// tiny seed.
fn sibling_probe(dir: &Path) -> Result<(), String> {
    use serde_json::{Value, json};
    let seeded = seed::generate_v3(seed::Preset::Tiny, DEFAULT_SEED).map_err(err)?;
    let ws = Workspace::open_dir(dir, "0.2.0-bench").map_err(err)?;
    seeded.write_to(ws.library()).map_err(err)?;
    let book = seeded.books[0].book_id().to_string();
    let call = |name: &str, input: Value| -> Result<Value, String> {
        ws.call(&dr_workspace::Actor::User, name, input)
            .map(|v| v["output"].clone())
            .map_err(|e| format!("{name}: {e}"))
    };
    let entries = call("entry.list", json!({ "book": book, "all": true }))?;
    let chapters: Vec<&Value> = entries
        .as_array()
        .ok_or("entry.list returned no list")?
        .iter()
        .filter(|e| e["template"] == "tpl-chapter")
        .collect();
    let first = chapters.first().ok_or("the seed has no chapter")?;
    let (entry, parent) = (first["id"].clone(), first["parent"].clone());
    let other = chapters
        .iter()
        .find(|c| c["parent"] != parent)
        .or(chapters.get(1))
        .ok_or("the seed has one chapter only")?["id"]
        .clone();
    let points = |entry: &Value| -> Result<usize, String> {
        Ok(call(
            "entry_snapshot.list",
            json!({ "book": book, "entry": entry }),
        )?
        .as_array()
        .map_or(0, Vec::len))
    };
    let capture = |entry: &Value| -> Result<usize, String> {
        call(
            "entry_snapshot.capture",
            json!({ "book": book, "entry": entry, "reason": "close" }),
        )?;
        points(entry)
    };
    println!("\ncheckpoint probe (the real commands, tiny seed)");
    println!(
        "  first capture of a chapter:                      {} point(s)",
        capture(&entry)?
    );
    println!(
        "  captured again, nothing changed:                 {} point(s)",
        capture(&entry)?
    );
    call(
        "entry.update",
        json!({ "book": book, "id": other, "title": "另一章改了名" }),
    )?;
    println!(
        "  after another chapter was renamed:               {} point(s)",
        capture(&entry)?
    );
    call(
        "entry.create",
        json!({ "book": book, "title": "新加的一章", "parent": parent, "template": "tpl-chapter" }),
    )?;
    println!(
        "  after a sibling chapter was created:             {} point(s)",
        capture(&entry)?
    );
    let beside = chapters.iter().filter(|c| c["parent"] == parent).count();
    call(
        "entry.move",
        json!({ "book": book, "id": entry, "parent": parent, "index": beside }),
    )?;
    println!(
        "  after the chapter itself moved to the end:       {} point(s)",
        capture(&entry)?
    );
    println!(
        "  manifest bytes of its latest point:              {}",
        call(
            "entry_snapshot.list",
            json!({ "book": book, "entry": entry })
        )?[0]
            .to_string()
            .len()
    );
    ws.shutdown().map_err(err)
}

/// What quitting costs: the last sweep of the automatic entry checkpoints
/// (`dr_view_history::automatic::capture_on_close`, which the shell runs
/// when a library is released) over a library holding the seeded book with
/// all its bodies.
fn close_sweep(dir: &Path, seeded: &seed::SeededV3) -> Result<(), String> {
    use dr_view_history::automatic::capture_on_close;
    use serde_json::{Value, json};
    let ws = Workspace::open_dir(dir, "0.2.0-bench").map_err(err)?;
    seeded.write_to(ws.library()).map_err(err)?;
    let book = seeded.books[0].book_id().clone();
    let call = |name: &str, input: Value| -> Result<Value, String> {
        ws.call(&dr_workspace::Actor::User, name, input)
            .map(|v| v["output"].clone())
            .map_err(|e| format!("{name}: {e}"))
    };
    let points = || -> Result<usize, String> {
        let doc = ws
            .library()
            .load_copy(&format!("book:{book}"))
            .map_err(err)?;
        Ok(dr_doc::v3::BorrowedBookV3::new(&doc, &book)
            .map_err(err)?
            .view()
            .entry_checkpoints()
            .len())
    };
    let entries = call("entry.list", json!({ "book": book.as_str(), "all": true }))?;
    let entries = entries.as_array().ok_or("entry.list returned no list")?;
    let chapter = entries
        .iter()
        .find(|e| e["template"] == "tpl-chapter")
        .ok_or("the seed has no chapter")?;
    println!(
        "\nclose sweep (capture_on_close, the real commands): {} entries",
        entries.len()
    );
    let sweep = |label: &str| -> Result<(), String> {
        let before = points()?;
        let t = Instant::now();
        capture_on_close(&ws)?;
        let took = ms(t);
        println!(
            "  {label:44} {took:>10.1} ms  {:>5} more point(s)",
            points()? as i64 - before as i64
        );
        Ok(())
    };
    sweep("first quit (no checkpoints yet)")?;
    sweep("quit again, nothing changed")?;
    sweep("and again")?;
    call(
        "entry.update",
        json!({ "book": book.as_str(), "id": chapter["id"], "title": "改了名的一章" }),
    )?;
    sweep("after one chapter was renamed")?;
    call(
        "entry.create",
        json!({ "book": book.as_str(), "title": "新加的一章", "parent": chapter["parent"], "template": "tpl-chapter" }),
    )?;
    sweep("after a sibling chapter was created")?;
    ws.shutdown().map_err(err)
}

fn main() -> Result<(), String> {
    let mode = if std::env::args().any(|a| a == "--quick") {
        Mode::Quick
    } else {
        Mode::Full
    };
    let named: Vec<String> = std::env::args()
        .skip(1)
        .filter(|a| !a.starts_with("--"))
        .collect();
    if let Some(unknown) = named
        .iter()
        .find(|a| !["editor", "shell", "fingerprint", "probe", "close"].contains(&a.as_str()))
    {
        return Err(format!(
            "unknown section {unknown}: editor, shell, fingerprint, probe or close"
        ));
    }
    let wanted = |section: &str| named.is_empty() || named.iter().any(|a| a == section);
    if mode == Mode::Full && cfg!(debug_assertions) {
        eprintln!("history-aging-spike: a debug build; timings are not representative");
    }
    println!(
        "load average {} at the start",
        evidence::machine()["loadAverage1m"]
    );
    let seeded = seed::generate_v3(mode.preset(), DEFAULT_SEED).map_err(err)?;
    let seeded_book = &seeded.books[0];
    let base = chapter_suite::longest_chapter(seeded_book)?;
    let scratch = Scratch::new("history-aging-spike").map_err(err)?;

    let chapters: &[(&str, usize)] = match mode {
        Mode::Quick => &[("fresh", 0), ("ops4k", 4_000)],
        Mode::Full => &[
            ("fresh", 0),
            ("ops50k", 50_000),
            ("ops150k", 150_000),
            ("ops375k", 375_000),
        ],
    };
    for (name, target) in chapters {
        if !wanted("editor") {
            break;
        }
        let aged;
        let doc = if *target == 0 {
            base
        } else {
            aged = chapter::age(base, &ChapterAging::revision(*target)).map_err(err)?;
            &aged.doc
        };
        println!(
            "\neditor, chapter {name}: {} characters, {} operations",
            doc.view().len(),
            aging::ops(&doc.version())
        );
        editor(
            mode,
            &scratch.path().join(format!("chapter-{name}")),
            &seeded_book.book,
            doc,
        )?;
    }

    let books: &[(&str, u32)] = match mode {
        Mode::Quick => &[("fresh", 0), ("days30", 30)],
        Mode::Full => &[("fresh", 0), ("year1", 365), ("year3", 3 * 365)],
    };
    for (name, days) in books {
        if !wanted("shell") && !wanted("fingerprint") {
            break;
        }
        let aged;
        let doc = if *days == 0 {
            &seeded_book.book
        } else {
            aged = book::age(&seeded_book.book, &BookAging::days(*days)).map_err(err)?;
            &aged.doc
        };
        if wanted("shell") {
            println!(
                "\nshell, book {name}: {} operations",
                aging::ops(&doc.version())
            );
            shell(mode, &scratch.path().join(format!("book-{name}")), doc)?;
        }
        if wanted("fingerprint") {
            println!(
                "\nfingerprints, book {name}: {} entries",
                doc.view().entries_raw().len()
            );
            fingerprints(mode, doc)?;
        }
    }
    if wanted("probe") {
        sibling_probe(&scratch.path().join("checkpoint-probe"))?;
    }
    if wanted("close") {
        close_sweep(&scratch.path().join("close-sweep"), &seeded)?;
    }
    println!(
        "\nload average {} at the end",
        evidence::machine()["loadAverage1m"]
    );
    Ok(())
}
