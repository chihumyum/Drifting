//! What the author's undo costs on a chapter with a long history, and what
//! would make it cheap. Pure Loro: the chapters are Loro snapshots written by
//! `dr-testkit`'s aging step, so nothing here depends on Drifting's code.
//!
//! ```text
//! cd next
//! cargo run --release -p dr-testkit --example aging-bench -- chapter --dump /tmp/aged
//! cd spikes/loro-undo-lab
//! cargo run --release -- /tmp/aged
//! ```
//!
//! For every `<tier>.loro` in the directory it prints, in milliseconds:
//!
//! - **undo under four Loros** (`released` 1.17.1; upstream main `before`
//!   and `after` loro-dev/loro#1217; upstream main `head` as of 2026-11-12,
//!   the unreleased 1.18.0): the first undo after loading, the following
//!   ones, a burst of 20 items, redo;
//! - **other ways to call Loro** (released): one grouped item instead of 20,
//!   `diff` + `apply_diff`, `revert_to`;
//! - **a shallow snapshot** (released, and main head): its size and the same
//!   undo on a document that keeps only the last 30 days of history, the
//!   last 7, or none;
//! - **the editor's own inverse** (released): the insert or delete that takes
//!   a step back, positioned by a cursor, with no replay at all.
//!
//! and once, on a small document, what a shallow snapshot refuses to do.
//!
//! Analysis: `docs/rust-rewrite/spikes/history-aging.md`.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
use std::time::Instant;

/// Counts live heap bytes, for what an undo leaves in memory.
struct Counting;
static LIVE: AtomicUsize = AtomicUsize::new(0);

// SAFETY: every call goes straight to the system allocator; the counter only
// observes sizes.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        LIVE.fetch_add(layout.size(), Relaxed);
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        LIVE.fetch_sub(layout.size(), Relaxed);
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        LIVE.fetch_add(new_size, Relaxed);
        LIVE.fetch_sub(layout.size(), Relaxed);
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

fn live() -> usize {
    LIVE.load(Relaxed)
}

/// The text container of a prose document (dr-doc's `schema::prose::BODY`).
const BODY: &str = "body";
/// Items in one burst of typing undone together.
const BURST: usize = 20;
const DAY_S: i64 = 86_400;

/// SplitMix64: positions to type at.
struct Rng(u64);

impl Rng {
    fn below(&mut self, n: usize) -> usize {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        (((z ^ (z >> 31)) as u128 * n as u128) >> 64) as usize
    }
}

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1e3
}

/// `(p50, p95)` of samples.
fn summary(samples: &[f64]) -> (f64, f64) {
    let mut s = samples.to_vec();
    s.sort_by(|a, b| a.total_cmp(b));
    let at = |q: f64| s[((s.len() as f64 - 1.0) * q).round() as usize];
    (at(0.5), at(0.95))
}

fn row(label: &str, samples: &[f64]) {
    let (p50, p95) = summary(samples);
    println!(
        "  {label:44} n={:<3} p50 {p50:>9.3}  p95 {p95:>9.3}",
        samples.len()
    );
}

/// The experiments, once per Loro build.
macro_rules! lab {
    ($name:ident, $loro:ident) => {
        pub mod $name {
            use super::{BODY, BURST, DAY_S, Rng, ms};
            use std::time::Instant;
            use $loro::cursor::{PosType, Side};
            use $loro::{
                ExpandType, ExportMode, Frontiers, ID, LoroDoc, LoroText, StyleConfig, TextDelta,
                UndoManager, VersionVector,
            };

            /// Load a chapter the way storage does and edit as a new device.
            pub fn load(bytes: &[u8]) -> LoroDoc {
                let doc = LoroDoc::new();
                // Any mark key may appear in a chapter; none expands here.
                doc.config_default_text_style(Some(StyleConfig {
                    expand: ExpandType::None,
                }));
                doc.set_record_timestamp(true);
                doc.import(bytes).expect("a chapter snapshot imports");
                doc.set_peer_id(0x0A61_9E00_0000_0002).expect("a peer id");
                doc
            }

            /// The author's undo as dr-doc configures it.
            pub fn manager(doc: &LoroDoc) -> UndoManager {
                let mut undo = UndoManager::new(doc);
                undo.set_max_undo_steps(usize::MAX);
                undo.set_merge_interval(0);
                undo
            }

            fn type_at(doc: &LoroDoc, text: &LoroText, at: usize) {
                text.insert(at, "字").expect("insert");
                doc.set_next_commit_origin("user");
                doc.commit();
            }

            pub struct Undo {
                pub load: f64,
                /// Live heap of the loaded document, after its first undo,
                /// and after all of them (bytes).
                pub heap: [usize; 3],
                pub first: f64,
                pub items: Vec<f64>,
                pub redo: Vec<f64>,
                pub burst: Vec<f64>,
                pub keystroke: Vec<f64>,
            }

            /// Type one character somewhere, undo it, redo it; then bursts.
            pub fn undo(bytes: &[u8], reps: usize) -> Undo {
                let empty = super::live();
                let t = Instant::now();
                let doc = load(bytes);
                let load = ms(t);
                let text = doc.get_text(BODY);
                // Decode the state, as showing the chapter does.
                let len = text.to_string().chars().count();
                let mut heap = [super::live().saturating_sub(empty); 3];
                let mut undo = manager(&doc);
                let mut rng = Rng(7);
                type_at(&doc, &text, len / 2);
                let t = Instant::now();
                undo.undo().expect("undo");
                let first = ms(t);
                heap[1] = super::live().saturating_sub(empty);
                let (mut items, mut redo, mut burst, mut keystroke) =
                    (Vec::new(), Vec::new(), Vec::new(), Vec::new());
                for _ in 0..reps {
                    let at = rng.below(text.len_unicode() - 1);
                    let t = Instant::now();
                    type_at(&doc, &text, at);
                    keystroke.push(ms(t));
                    let t = Instant::now();
                    undo.undo().expect("undo");
                    items.push(ms(t));
                    let t = Instant::now();
                    undo.redo().expect("redo");
                    redo.push(ms(t));
                }
                for _ in 0..reps.div_ceil(3) {
                    let at = rng.below(text.len_unicode() - 1);
                    for k in 0..BURST {
                        type_at(&doc, &text, at + k);
                    }
                    let t = Instant::now();
                    for _ in 0..BURST {
                        undo.undo().expect("undo");
                    }
                    burst.push(ms(t));
                }
                heap[2] = super::live().saturating_sub(empty);
                Undo {
                    load,
                    heap,
                    first,
                    items,
                    redo,
                    burst,
                    keystroke,
                }
            }

            /// Twenty keystrokes as one Loro item (`group_start` / `group_end`).
            pub fn grouped(bytes: &[u8], reps: usize) -> Vec<f64> {
                let doc = load(bytes);
                let text = doc.get_text(BODY);
                let mut undo = manager(&doc);
                let mut rng = Rng(11);
                type_at(&doc, &text, 0);
                undo.undo().expect("warm");
                (0..reps)
                    .map(|_| {
                        let at = rng.below(text.len_unicode() - 1);
                        undo.group_start().expect("group");
                        for k in 0..BURST {
                            type_at(&doc, &text, at + k);
                        }
                        undo.group_end();
                        let t = Instant::now();
                        undo.undo().expect("undo");
                        ms(t)
                    })
                    .collect()
            }

            /// `diff(after, before)` + `apply_diff`, and `revert_to(before)`.
            pub fn diff_and_revert(bytes: &[u8], reps: usize) -> (Vec<f64>, Vec<f64>) {
                let doc = load(bytes);
                let text = doc.get_text(BODY);
                let mut rng = Rng(13);
                let (mut by_diff, mut by_revert) = (Vec::new(), Vec::new());
                for _ in 0..reps {
                    let at = rng.below(text.len_unicode() - 1);
                    let before = doc.state_frontiers();
                    type_at(&doc, &text, at);
                    let after = doc.state_frontiers();
                    let t = Instant::now();
                    let diff = doc.diff(&after, &before).expect("diff");
                    doc.apply_diff(diff).expect("apply");
                    doc.commit();
                    by_diff.push(ms(t));
                    let before = doc.state_frontiers();
                    type_at(&doc, &text, at);
                    let t = Instant::now();
                    doc.revert_to(&before).expect("revert");
                    doc.commit();
                    by_revert.push(ms(t));
                }
                (by_diff, by_revert)
            }

            /// The version of `doc` as it was `days` before its last change.
            pub fn frontiers_days_ago(doc: &LoroDoc, days: i64) -> Frontiers {
                let vv = doc.oplog_vv();
                let mut last = 0;
                let mut changes = Vec::new();
                for (peer, end) in vv.iter() {
                    let mut counter = 0;
                    while counter < *end {
                        let Some(change) = doc.get_change(ID::new(*peer, counter)) else {
                            break;
                        };
                        let next = change.id.counter + change.len.max(1) as i32;
                        last = last.max(change.timestamp);
                        changes.push((*peer, next, change.timestamp));
                        counter = next;
                    }
                }
                let cutoff = last - days * DAY_S;
                // The last change of each peer made by then, and everything
                // those depend on: devices' clocks need not agree, so the
                // changes before a moment are not always a version by
                // themselves.
                let mut heads: std::collections::BTreeMap<u64, i32> = Default::default();
                for (peer, end, at) in changes {
                    if at <= cutoff {
                        let known = heads.entry(peer).or_insert(0);
                        *known = (*known).max(end);
                    }
                }
                let heads: Vec<ID> = heads
                    .into_iter()
                    .map(|(peer, end)| ID::new(peer, end - 1))
                    .collect();
                let closed: VersionVector = doc
                    .frontiers_to_vv(&Frontiers::from(heads))
                    .expect("changes of this document");
                doc.vv_to_frontiers(&closed)
            }

            pub struct Shallow {
                pub full_bytes: usize,
                pub bytes: usize,
                pub export: f64,
                pub load: f64,
                pub ops: usize,
                /// Heads of the version asked for, operations up to it, and
                /// operations up to where the snapshot really starts.
                pub asked: (usize, usize, usize),
                pub first: f64,
                pub items: Vec<f64>,
                pub burst: Vec<f64>,
            }

            /// A shallow snapshot that keeps the history after `keep_days`
            /// days ago (`None`: after the latest version, so none), and the
            /// same undo on a document loaded from it.
            pub fn shallow(bytes: &[u8], keep_days: Option<i64>, reps: usize) -> Shallow {
                let full = load(bytes);
                let root = match keep_days {
                    Some(days) => frontiers_days_ago(&full, days),
                    None => full.oplog_frontiers(),
                };
                let t = Instant::now();
                let trimmed = full
                    .export(ExportMode::shallow_snapshot(&root))
                    .expect("a shallow snapshot");
                let export = ms(t);
                let undone = undo(&trimmed, reps);
                let doc = load(&trimmed);
                assert!(doc.is_shallow());
                assert_eq!(
                    doc.get_text(BODY).to_string(),
                    full.get_text(BODY).to_string(),
                    "a shallow snapshot shows the same text"
                );
                Shallow {
                    full_bytes: bytes.len(),
                    bytes: trimmed.len(),
                    export,
                    load: undone.load,
                    ops: doc.len_ops(),
                    asked: (
                        root.len(),
                        full.frontiers_to_vv(&root)
                            .map_or(0, |vv| vv.values().map(|end| *end as usize).sum()),
                        doc.shallow_since_vv()
                            .iter()
                            .map(|(_, end)| *end as usize)
                            .sum(),
                    ),
                    first: undone.first,
                    items: undone.items,
                    burst: undone.burst,
                }
            }

            /// One step the editor can take back by itself.
            pub enum Inverse {
                /// Typed text: delete `len` characters from the cursor on.
                Typed {
                    at: $loro::cursor::Cursor,
                    len: usize,
                },
                /// Deleted text: put `delta` back after the cursor's character
                /// (`None`: at the start).
                Deleted {
                    after: Option<$loro::cursor::Cursor>,
                    delta: Vec<TextDelta>,
                },
            }

            /// Insert `s` at `at` and return its inverse.
            pub fn insert_recorded(doc: &LoroDoc, text: &LoroText, at: usize, s: &str) -> Inverse {
                text.insert(at, s).expect("insert");
                doc.set_next_commit_origin("user");
                doc.commit();
                Inverse::Typed {
                    at: text.get_cursor(at, Side::Middle).expect("a cursor"),
                    len: s.chars().count(),
                }
            }

            /// Delete `len` characters at `at` and return the inverse: the
            /// deleted text with its marks, anchored after the character
            /// before it (which survives).
            pub fn delete_recorded(
                doc: &LoroDoc,
                text: &LoroText,
                at: usize,
                len: usize,
            ) -> Inverse {
                let delta = text
                    .slice_delta(at, at + len, PosType::Unicode)
                    .expect("the deleted text");
                let after =
                    (at > 0).then(|| text.get_cursor(at - 1, Side::Middle).expect("a cursor"));
                text.delete(at, len).expect("delete");
                doc.set_next_commit_origin("user");
                doc.commit();
                Inverse::Deleted { after, delta }
            }

            /// Apply an inverse as one commit. Returns false when the text it
            /// would remove is already gone.
            pub fn apply_inverse(doc: &LoroDoc, text: &LoroText, inverse: &Inverse) -> bool {
                let done = match inverse {
                    Inverse::Typed { at, len } => {
                        let Ok(found) = doc.get_cursor_pos(at) else {
                            return false;
                        };
                        // The cursor moved to a neighbour: its own character
                        // was deleted by someone else.
                        if found.update.is_some() {
                            return false;
                        }
                        text.delete(found.current.pos, *len).is_ok()
                    }
                    Inverse::Deleted { after, delta } => {
                        let mut at = match after {
                            Some(c) => match doc.get_cursor_pos(c) {
                                Ok(found) => {
                                    found.current.pos + usize::from(found.update.is_none())
                                }
                                Err(_) => return false,
                            },
                            None => 0,
                        };
                        for piece in delta {
                            if let TextDelta::Insert { insert, attributes } = piece {
                                let n = insert.chars().count();
                                text.insert(at, insert).expect("insert");
                                for (key, value) in attributes.iter().flatten() {
                                    text.mark(at..at + n, key, value.clone()).expect("mark");
                                }
                                at += n;
                            }
                        }
                        true
                    }
                };
                doc.set_next_commit_origin("user");
                doc.commit();
                done
            }

            pub struct OwnInverse {
                pub record_insert: Vec<f64>,
                pub undo_insert: Vec<f64>,
                pub undo_burst: Vec<f64>,
                pub record_delete: Vec<f64>,
                pub undo_delete: Vec<f64>,
                pub same_text: bool,
                pub with_remote_edit: bool,
            }

            /// The editor's own inverse on a chapter, checked against Loro's
            /// undo for the same steps.
            pub fn own_inverse(bytes: &[u8], reps: usize) -> OwnInverse {
                let doc = load(bytes);
                let text = doc.get_text(BODY);
                let mut rng = Rng(17);
                let original = text.to_string();
                let mut out = OwnInverse {
                    record_insert: Vec::new(),
                    undo_insert: Vec::new(),
                    undo_burst: Vec::new(),
                    record_delete: Vec::new(),
                    undo_delete: Vec::new(),
                    same_text: true,
                    with_remote_edit: true,
                };
                for _ in 0..reps {
                    let at = rng.below(text.len_unicode() - 1);
                    let t = Instant::now();
                    let inverse = insert_recorded(&doc, &text, at, "字");
                    out.record_insert.push(ms(t));
                    let t = Instant::now();
                    apply_inverse(&doc, &text, &inverse);
                    out.undo_insert.push(ms(t));
                }
                for _ in 0..reps.div_ceil(3) {
                    let at = rng.below(text.len_unicode() - 1);
                    let steps: Vec<Inverse> = (0..BURST)
                        .map(|k| insert_recorded(&doc, &text, at + k, "字"))
                        .collect();
                    let t = Instant::now();
                    for inverse in steps.iter().rev() {
                        apply_inverse(&doc, &text, inverse);
                    }
                    out.undo_burst.push(ms(t));
                }
                for _ in 0..reps {
                    let at = 1 + rng.below(text.len_unicode() - 200);
                    let t = Instant::now();
                    let inverse = delete_recorded(&doc, &text, at, 120);
                    out.record_delete.push(ms(t));
                    let t = Instant::now();
                    apply_inverse(&doc, &text, &inverse);
                    out.undo_delete.push(ms(t));
                }
                out.same_text = text.to_string() == original;

                // Another device edits in front of the step before it is
                // undone: the cursor still finds it. Loro's undo is the oracle.
                let run = |own: bool| -> String {
                    let doc = load(bytes);
                    let text = doc.get_text(BODY);
                    let mut undo = manager(&doc);
                    let at = text.len_unicode() / 2;
                    let typed = insert_recorded(&doc, &text, at, "字字字");
                    let cut = delete_recorded(&doc, &text, at + 50, 30);
                    let other = load(bytes);
                    other.set_peer_id(0x0A61_9E00_0000_0004).expect("a peer id");
                    other
                        .get_text(BODY)
                        .insert(10, "别的设备写的一句话。")
                        .expect("insert");
                    other.get_text(BODY).delete(at + 200, 40).expect("delete");
                    other.commit();
                    doc.import_with(
                        &other.export(ExportMode::all_updates()).expect("export"),
                        "sync",
                    )
                    .expect("import");
                    if own {
                        apply_inverse(&doc, &text, &cut);
                        apply_inverse(&doc, &text, &typed);
                    } else {
                        undo.undo().expect("undo");
                        undo.undo().expect("undo");
                    }
                    text.to_string()
                };
                out.with_remote_edit = run(true) == run(false);
                out
            }

            /// The full snapshot of a chapter after one more keystroke, and
            /// that keystroke as an update: what another build must read.
            pub fn reexport(bytes: &[u8]) -> (Vec<u8>, Vec<u8>, String) {
                let doc = load(bytes);
                let text = doc.get_text(BODY);
                let before = doc.oplog_vv();
                type_at(&doc, &text, text.len_unicode() / 2);
                (
                    doc.export(ExportMode::Snapshot).expect("snapshot"),
                    doc.export(ExportMode::updates(&before)).expect("updates"),
                    text.to_string(),
                )
            }

            /// Read what [`reexport`] of another build wrote: the snapshot,
            /// and the update on top of the original chapter.
            pub fn reads(bytes: &[u8], other: &(Vec<u8>, Vec<u8>, String)) -> (bool, bool) {
                let from_snapshot = LoroDoc::new();
                let snapshot_ok = from_snapshot.import(&other.0).is_ok()
                    && from_snapshot.get_text(BODY).to_string() == other.2;
                let doc = load(bytes);
                let update_ok =
                    doc.import(&other.1).is_ok() && doc.get_text(BODY).to_string() == other.2;
                (snapshot_ok, update_ok)
            }

            /// What a shallow document refuses: one line each.
            // `checkout_to_latest` is the one spelling all four builds have.
            #[allow(deprecated)]
            pub fn shallow_limits() -> Vec<(String, String)> {
                let mut out = Vec::new();
                let a = LoroDoc::new();
                a.set_peer_id(1).expect("peer");
                let text = a.get_text(BODY);
                text.insert(0, "第一段写在很久以前。").expect("insert");
                a.commit();
                let early = a.oplog_frontiers();
                let early_vv = a.oplog_vv();
                // A comment anchored on a character that is later deleted.
                let anchor = text.get_cursor(2, Side::Middle).expect("cursor");
                // A device that goes offline here.
                let offline = LoroDoc::new();
                offline.set_peer_id(2).expect("peer");
                offline
                    .import(&a.export(ExportMode::all_updates()).expect("export"))
                    .expect("import");
                text.delete(0, 5).expect("delete");
                text.insert(0, "后来改写了开头，").expect("insert");
                a.commit();
                let root = a.oplog_frontiers();
                text.insert(text.len_unicode(), "再往后又添了一句。")
                    .expect("insert");
                a.commit();
                let shallow_bytes = a
                    .export(ExportMode::shallow_snapshot(&root))
                    .expect("shallow");
                let s = LoroDoc::new();
                s.set_peer_id(3).expect("peer");
                s.import(&shallow_bytes).expect("import");
                let say = |r: Result<String, String>| match r {
                    Ok(s) => format!("ok: {s}"),
                    Err(e) => format!("refused: {e}"),
                };
                out.push((
                    "check out a version before the shallow root (a history point)".into(),
                    say(s
                        .checkout(&early)
                        .map(|_| "checked out".into())
                        .map_err(|e| e.to_string())),
                ));
                s.checkout_to_latest();
                out.push((
                    "check out the shallow root itself".into(),
                    say(s
                        .checkout(&root)
                        .map(|_| s.get_text(BODY).to_string())
                        .map_err(|e| e.to_string())),
                ));
                s.checkout_to_latest();
                let since_early = s.export(ExportMode::updates(&early_vv));
                out.push((
                    "export the updates a device at the early version lacks".into(),
                    say(since_early
                        .as_ref()
                        .map(|b| format!("{} bytes", b.len()))
                        .map_err(|e| e.to_string())),
                ));
                if let Ok(bytes) = &since_early {
                    // What that device makes of them.
                    let behind = LoroDoc::new();
                    behind.set_peer_id(5).expect("peer");
                    behind
                        .import(&offline.export(ExportMode::all_updates()).expect("export"))
                        .expect("import");
                    out.push((
                        "…and the device at the early version imports them".into(),
                        say(behind
                            .import(bytes)
                            .map(|st| {
                                format!(
                                    "applied {:?}, left pending {:?}; its text: {}",
                                    st.success,
                                    st.pending,
                                    behind.get_text(BODY).to_string()
                                )
                            })
                            .map_err(|e| e.to_string())),
                    ));
                }
                // The offline device wrote on top of the early version.
                offline
                    .get_text(BODY)
                    .insert(0, "离线时写的。")
                    .expect("insert");
                offline.commit();
                let late = offline
                    .export(ExportMode::updates(&early_vv))
                    .expect("export");
                out.push((
                    "import an edit made on top of a version before the root".into(),
                    say(s
                        .import(&late)
                        .map(|st| format!("success {:?}, pending {:?}", st.success, st.pending))
                        .map_err(|e| e.to_string())),
                ));
                out.push((
                    "…the same edit into the full document".into(),
                    say(a
                        .import(&late)
                        .map(|_| a.get_text(BODY).to_string())
                        .map_err(|e| e.to_string())),
                ));
                out.push((
                    "resolve an anchor on a character deleted before the root".into(),
                    say(s
                        .get_cursor_pos(&anchor)
                        .map(|p| format!("position {}", p.current.pos))
                        .map_err(|e| format!("{e:?}"))),
                ));
                out.push((
                    "…the same anchor in the full document".into(),
                    say(a
                        .get_cursor_pos(&anchor)
                        .map(|p| format!("position {}", p.current.pos))
                        .map_err(|e| format!("{e:?}"))),
                ));
                // A device that already has the full history takes the shallow snapshot.
                let full = LoroDoc::new();
                full.set_peer_id(4).expect("peer");
                full.import(&a.export(ExportMode::Snapshot).expect("export"))
                    .expect("import");
                out.push((
                    "import the shallow snapshot into a document with full history".into(),
                    say(full
                        .import(&shallow_bytes)
                        .map(|_| format!("still shallow: {}", full.is_shallow()))
                        .map_err(|e| e.to_string())),
                ));
                out
            }
        }
    };
}

lab!(released, loro_released);
lab!(before, loro_before);
lab!(after, loro_after);
lab!(head, loro_head);

fn main() {
    let dir = std::env::args().nth(1).unwrap_or_else(|| {
        eprintln!("usage: loro-undo-lab <directory of <tier>.loro chapter snapshots> [reps]");
        std::process::exit(2);
    });
    let reps: usize = std::env::args()
        .nth(2)
        .and_then(|s| s.parse().ok())
        .unwrap_or(30);
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .expect("the directory")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "loro"))
        .collect();
    files.sort();
    for path in files {
        let bytes = std::fs::read(&path).expect("a snapshot");
        let tier = path.file_stem().unwrap().to_string_lossy().to_string();
        let doc = released::load(&bytes);
        println!(
            "\n== {tier}: {} bytes, {} ops, {} changes, {} characters",
            bytes.len(),
            doc.len_ops(),
            doc.len_changes(),
            doc.get_text(BODY).len_unicode()
        );
        drop(doc);

        let (old, new) = (released::reexport(&bytes), head::reexport(&bytes));
        println!(
            " formats: main head reads 1.17.1's snapshot and update {:?}; 1.17.1 reads main head's {:?}",
            head::reads(&bytes, &old),
            released::reads(&bytes, &new)
        );
        println!(" undo under four Loros (ms)");
        macro_rules! undo_rows {
            ($name:ident, $label:literal) => {{
                let u = $name::undo(&bytes, reps);
                println!(
                    "  {:44} load {:.3}  first undo {:.3}  heap: loaded {:.2} MB, after the first undo {:.2} MB, after all {:.2} MB",
                    $label,
                    u.load,
                    u.first,
                    u.heap[0] as f64 / 1e6,
                    u.heap[1] as f64 / 1e6,
                    u.heap[2] as f64 / 1e6
                );
                row(concat!($label, ": keystroke"), &u.keystroke);
                row(concat!($label, ": undo one item"), &u.items);
                row(concat!($label, ": redo one item"), &u.redo);
                row(concat!($label, ": undo a burst of 20"), &u.burst);
            }};
        }
        undo_rows!(released, "released 1.17.1");
        undo_rows!(before, "main before #1217");
        undo_rows!(after, "main after #1217");
        undo_rows!(head, "main head (1.18.0-dev)");

        println!(" other ways to call Loro (released, ms)");
        row(
            "20 keystrokes grouped as one item, undone",
            &released::grouped(&bytes, reps),
        );
        let (by_diff, by_revert) = released::diff_and_revert(&bytes, reps.min(10));
        row("diff(after, before) + apply_diff", &by_diff);
        row("revert_to(before)", &by_revert);
        println!(" the same on main head (ms)");
        row(
            "20 keystrokes grouped as one item, undone",
            &head::grouped(&bytes, reps),
        );
        let (by_diff, by_revert) = head::diff_and_revert(&bytes, reps.min(10));
        row("diff(after, before) + apply_diff", &by_diff);
        row("revert_to(before)", &by_revert);

        println!(" shallow snapshots (released, ms)");
        for keep in [Some(30), Some(7), None] {
            let s = released::shallow(&bytes, keep, reps);
            let label = match keep {
                Some(days) => format!("history of the last {days} days"),
                None => "no history".into(),
            };
            println!(
                "  {label:44} {} bytes ({:.0}% of full), {} ops kept, export {:.3}, load {:.3}, first undo {:.3}",
                s.bytes,
                100.0 * s.bytes as f64 / s.full_bytes as f64,
                s.ops,
                s.export,
                s.load,
                s.first
            );
            println!(
                "  {:44} asked to start after {} ops ({} heads); starts after {}",
                "", s.asked.1, s.asked.0, s.asked.2
            );
            row(&format!("{label}: undo one item"), &s.items);
            row(&format!("{label}: undo a burst of 20"), &s.burst);
        }

        // loro-dev/loro#1217 keeps the tracker only for documents with their
        // full history: does a shallow one get the fix?
        println!(" shallow snapshots (main head, ms)");
        for keep in [Some(30), None] {
            let s = head::shallow(&bytes, keep, reps);
            let label = match keep {
                Some(days) => format!("history of the last {days} days"),
                None => "no history".into(),
            };
            println!(
                "  {label:44} {} bytes, {} ops kept, export {:.3}, load {:.3}, first undo {:.3}",
                s.bytes, s.ops, s.export, s.load, s.first
            );
            row(&format!("{label}: undo one item"), &s.items);
            row(&format!("{label}: undo a burst of 20"), &s.burst);
        }

        println!(" the editor's own inverse (released, ms)");
        let own = released::own_inverse(&bytes, reps);
        row(
            "type one character and record its inverse",
            &own.record_insert,
        );
        row("undo it", &own.undo_insert);
        row("undo a burst of 20", &own.undo_burst);
        row(
            "delete 120 characters and record the inverse",
            &own.record_delete,
        );
        row("undo it (text and marks back)", &own.undo_delete);
        println!(
            "  text back to the original: {}; same result as Loro's undo after a remote edit: {}",
            own.same_text, own.with_remote_edit
        );
    }

    println!("\n== what a shallow document refuses");
    for (label, variants) in [
        ("released 1.17.1", released::shallow_limits()),
        ("main head (1.18.0-dev)", head::shallow_limits()),
    ] {
        println!(" {label}");
        for (what, result) in variants {
            println!("  {what}\n      {result}");
        }
    }
}
