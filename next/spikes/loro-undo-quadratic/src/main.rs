//! Minimal reproduction: undoing N consecutive commits with Loro's
//! `UndoManager` (merge interval 0, so one item per commit).
//!
//! A text of N paragraphs; each commit replaces two characters in one
//! paragraph (a "replace all", back to front). Then all N items are undone.
//! For comparison the same N replacements go into one commit, undone once.
//!
//! ```text
//! cargo run --release -p loro-undo-quadratic-spike
//! ```
//!
//! Prints one line per N; the per-item undo cost growing with N (time
//! roughly ×4 when N doubles) is the quadratic behaviour.
//!
//! Reported upstream as loro-dev/loro#1263 (2026-11-08), with a smaller
//! reproduction. Each `undo()` replays the text's whole history, so its cost
//! follows the number of separate runs in that history, not the stack
//! length: here the N replacements sit in N paragraphs and the text grows
//! with N, so all three grow together. Rerun this before upgrading Loro and
//! check the issue (docs/rust-rewrite/foundations/f4b-layout.md).

use std::time::Instant;

use loro::{LoroDoc, UndoManager};

const PARAGRAPH: &str = "安娜站在窗前，看着雨。\n";

fn seed(n: usize) -> LoroDoc {
    let doc = LoroDoc::new();
    let text = doc.get_text("body");
    text.insert(0, &PARAGRAPH.repeat(n)).unwrap();
    doc.set_next_commit_origin("seed");
    doc.commit();
    doc
}

/// The offsets of the replaced characters, last first.
fn targets(n: usize) -> Vec<usize> {
    let len = PARAGRAPH.chars().count();
    (0..n).rev().map(|i| i * len).collect()
}

fn replace(doc: &LoroDoc, at: usize) {
    let text = doc.get_text("body");
    text.delete(at, 2).unwrap();
    text.insert(at, "小安").unwrap();
}

/// N commits, then N undos. Returns (edit ms, undo ms, text restored).
fn separate(n: usize) -> (f64, f64, bool) {
    let doc = seed(n);
    let before = doc.get_text("body").to_string();
    let mut undo = UndoManager::new(&doc);
    undo.set_merge_interval(0);
    // Loro keeps 100 items by default; gpui-prose keeps 100 000.
    undo.set_max_undo_steps(100_000);
    let t = Instant::now();
    for at in targets(n) {
        replace(&doc, at);
        doc.commit();
    }
    let edit = t.elapsed().as_secs_f64() * 1e3;
    let t = Instant::now();
    while undo.can_undo() {
        undo.undo().unwrap();
    }
    let undo_ms = t.elapsed().as_secs_f64() * 1e3;
    (edit, undo_ms, doc.get_text("body").to_string() == before)
}

/// One commit with the N replacements, then one undo.
fn together(n: usize) -> (f64, f64, bool) {
    let doc = seed(n);
    let before = doc.get_text("body").to_string();
    let mut undo = UndoManager::new(&doc);
    undo.set_merge_interval(0);
    // Loro keeps 100 items by default; gpui-prose keeps 100 000.
    undo.set_max_undo_steps(100_000);
    let t = Instant::now();
    for at in targets(n) {
        replace(&doc, at);
    }
    doc.commit();
    let edit = t.elapsed().as_secs_f64() * 1e3;
    let t = Instant::now();
    while undo.can_undo() {
        undo.undo().unwrap();
    }
    let undo_ms = t.elapsed().as_secs_f64() * 1e3;
    (edit, undo_ms, doc.get_text("body").to_string() == before)
}

/// Undo cost of the first and the last item when N items are on the stack:
/// whether one undo gets dearer the more items were pushed after it.
fn last_item_cost(n: usize) -> f64 {
    let doc = seed(n);
    let mut undo = UndoManager::new(&doc);
    undo.set_merge_interval(0);
    // Loro keeps 100 items by default; gpui-prose keeps 100 000.
    undo.set_max_undo_steps(100_000);
    for at in targets(n) {
        replace(&doc, at);
        doc.commit();
    }
    let t = Instant::now();
    undo.undo().unwrap();
    t.elapsed().as_secs_f64() * 1e3
}

fn main() {
    println!(
        "n\tseparate: edit ms\tundo ms\tper item\tone commit: edit ms\tundo ms\tfirst undo of n items ms"
    );
    for n in [50usize, 100, 200, 400, 800] {
        let (se, su, sok) = separate(n);
        let (te, tu, tok) = together(n);
        if !sok {
            println!("{n}: undoing the {n} separate commits did NOT restore the text");
        }
        if !tok {
            println!("{n}: undoing the one commit did NOT restore the text");
        }
        let first = last_item_cost(n);
        println!(
            "{n}\t{se:.1}\t{su:.1}\t{:.3}\t{te:.1}\t{tu:.2}\t{first:.3}",
            su / n as f64
        );
    }
}
