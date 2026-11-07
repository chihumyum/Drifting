//! The body events are enough to follow a prose document without reading it
//! back, which is what the editor's paragraph mirror (F4) relies on. Three
//! devices type (inside, before and right after marked text, so `After`
//! marks extend and `None` marks do not), press Enter, delete, set and clear
//! bold / italic / links, link entities, set headings, undo, redo and sync
//! in random order. Each device keeps a copy built only from its events —
//! characters, and for each character the marks the last insert reported —
//! and after every step that copy must match a fresh read:
//!
//! - the text is the same, character for character;
//! - every inserted character has the marks its insert event reported;
//! - a character whose marks changed was covered by a `restyled` retain.
//!
//! `DR_PROP_CASES` sets the number of cases (default 128). The test asserts
//! that the run saw inherited marks and imported inserts.

use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
use std::sync::{Arc, Mutex};

use dr_doc::prose::{ProseDoc, ProseEvent, ProseTxn, StyleKey, TextChange, Trigger};
use dr_doc::undo::ProseUndo;
use dr_model::kind::EntityKind;
use dr_model::prose::{EntityLink, Heading, InlineMarks, InlineStyle};
use dr_model::{DocId, Origin};
use proptest::prelude::*;
use proptest::test_runner::{RngAlgorithm, TestRng, TestRunner};

const PEERS: usize = 3;
const ALPHABET: &[&str] = &["甲", "乙丙", "ab", "😀", "x"];

#[derive(Clone, Debug)]
enum Op {
    Insert {
        peer: usize,
        at: u16,
        s: u8,
    },
    Split {
        peer: usize,
        at: u16,
    },
    Delete {
        peer: usize,
        at: u16,
        len: u8,
    },
    Style {
        peer: usize,
        at: u16,
        len: u8,
        style: u8,
        set: bool,
    },
    Entity {
        peer: usize,
        at: u16,
        len: u8,
        target: u8,
    },
    Heading {
        peer: usize,
        at: u16,
        level: u8,
    },
    Undo {
        peer: usize,
    },
    Redo {
        peer: usize,
    },
    Sync {
        from: usize,
        to: usize,
    },
}

fn op() -> impl Strategy<Value = Op> {
    let p = 0..PEERS;
    prop_oneof![
        8 => (p.clone(), any::<u16>(), any::<u8>()).prop_map(|(peer, at, s)| Op::Insert { peer, at, s }),
        2 => (p.clone(), any::<u16>()).prop_map(|(peer, at)| Op::Split { peer, at }),
        2 => (p.clone(), any::<u16>(), 1u8..8).prop_map(|(peer, at, len)| Op::Delete { peer, at, len }),
        4 => (p.clone(), any::<u16>(), 1u8..6, 0u8..4, any::<bool>())
            .prop_map(|(peer, at, len, style, set)| Op::Style { peer, at, len, style, set }),
        1 => (p.clone(), any::<u16>(), 1u8..5, 0u8..2).prop_map(|(peer, at, len, target)| Op::Entity { peer, at, len, target }),
        1 => (p.clone(), any::<u16>(), 0u8..4).prop_map(|(peer, at, level)| Op::Heading { peer, at, level }),
        1 => p.clone().prop_map(|peer| Op::Undo { peer }),
        1 => p.clone().prop_map(|peer| Op::Redo { peer }),
        3 => (p.clone(), p).prop_map(|(from, to)| Op::Sync { from, to }),
    ]
}

fn style(n: u8) -> (InlineStyle, StyleKey) {
    match n {
        0 => (InlineStyle::Bold, StyleKey::Bold),
        1 => (InlineStyle::Italic, StyleKey::Italic),
        2 => (InlineStyle::Strike, StyleKey::Strike),
        _ => (
            InlineStyle::Link("https://example.com/a".into()),
            StyleKey::Link,
        ),
    }
}

/// One character of the event-built copy: its marks when the last event
/// that touched it said what they are (`None` for a newline, or after a
/// restyle until the next check reads it again).
type Shadow = Vec<(char, Option<InlineMarks>)>;

struct Peer {
    doc: ProseDoc,
    undo: ProseUndo,
    events: Arc<Mutex<Vec<ProseEvent>>>,
    shadow: Shadow,
    _sub: loro::Subscription,
}

fn read(d: &ProseDoc) -> Shadow {
    let mut out = Vec::new();
    for p in d.view().paragraphs() {
        for r in &p.runs {
            out.extend(r.text.chars().map(|c| (c, Some(r.marks.clone()))));
        }
        if p.terminated {
            out.push(('\n', None));
        }
    }
    out
}

fn apply(shadow: &mut Shadow, e: &ProseEvent) {
    let mut pos = 0usize;
    for c in &e.body {
        match c {
            TextChange::Retain { len, restyled } => {
                if *restyled {
                    for ch in &mut shadow[pos..pos + len] {
                        ch.1 = None;
                    }
                }
                pos += len;
            }
            TextChange::Insert { text, marks } => {
                let new: Vec<_> = text
                    .chars()
                    .map(|ch| (ch, (ch != '\n').then(|| marks.clone())))
                    .collect();
                if !marks.is_plain() && e.trigger == Trigger::Local {
                    STATS.marked_local.fetch_add(1, Relaxed);
                }
                if e.trigger == Trigger::Import {
                    STATS.imported.fetch_add(1, Relaxed);
                }
                let n = new.len();
                shadow.splice(pos..pos, new);
                pos += n;
            }
            TextChange::Delete { len } => {
                shadow.drain(pos..pos + len);
            }
        }
    }
}

fn check(p: &mut Peer) -> Result<(), TestCaseError> {
    let events: Vec<ProseEvent> = std::mem::take(&mut *p.events.lock().unwrap());
    for e in &events {
        apply(&mut p.shadow, e);
    }
    let actual = read(&p.doc);
    let a: String = actual.iter().map(|c| c.0).collect();
    let s: String = p.shadow.iter().map(|c| c.0).collect();
    prop_assert_eq!(&s, &a, "the events rebuild the text");
    for (i, (have, want)) in p.shadow.iter().zip(&actual).enumerate() {
        if let Some(m) = &have.1 {
            prop_assert_eq!(
                Some(m),
                want.1.as_ref(),
                "marks of character {} ({:?}) in {:?}",
                i,
                have.0,
                a
            );
            STATS.checked.fetch_add(1, Relaxed);
        }
    }
    p.shadow = actual;
    Ok(())
}

fn user(d: &mut ProseDoc, f: impl FnOnce(&mut ProseTxn<'_>) -> dr_doc::Result<()>) {
    let (r, _) = d.edit(Origin::User, f);
    r.unwrap();
}

fn range(d: &ProseDoc, at: u16, len: u8) -> std::ops::Range<usize> {
    let l = d.view().len();
    let start = at as usize % l;
    start..(start + len as usize).min(l)
}

fn run(ops: &[Op]) -> Result<(), TestCaseError> {
    let id = DocId::parse("node:events").unwrap();
    let mut peers: Vec<Peer> = (0..PEERS)
        .map(|i| {
            let doc = ProseDoc::create(id.clone(), 200 + i as u64).unwrap();
            let undo = doc.undo_manager();
            let events: Arc<Mutex<Vec<ProseEvent>>> = Default::default();
            let e2 = events.clone();
            let sub = doc.subscribe(move |e| e2.lock().unwrap().push(e.clone()));
            let shadow = read(&doc);
            Peer {
                doc,
                undo,
                events,
                shadow,
                _sub: sub,
            }
        })
        .collect();
    for op in ops {
        match op.clone() {
            Op::Insert { peer, at, s } => {
                let d = &mut peers[peer].doc;
                let pos = at as usize % d.view().len();
                user(d, |t| {
                    t.insert_text(pos, ALPHABET[s as usize % ALPHABET.len()])
                });
            }
            Op::Split { peer, at } => {
                let d = &mut peers[peer].doc;
                let pos = at as usize % d.view().len();
                user(d, |t| t.split(pos).map(|_| ()));
            }
            Op::Delete { peer, at, len } => {
                let d = &mut peers[peer].doc;
                let r = range(d, at, len);
                user(d, |t| t.delete(r));
            }
            Op::Style {
                peer,
                at,
                len,
                style: n,
                set,
            } => {
                let d = &mut peers[peer].doc;
                let r = range(d, at, len);
                let (s, k) = style(n);
                if set {
                    user(d, |t| t.set_style(r, &s));
                } else {
                    user(d, |t| t.clear_style(r, k));
                }
            }
            Op::Entity {
                peer,
                at,
                len,
                target,
            } => {
                let d = &mut peers[peer].doc;
                let r = range(d, at, len);
                let link = EntityLink {
                    target: format!("el-{target}"),
                    kind: EntityKind::Element,
                    block: None,
                    end_block: None,
                };
                user(d, |t| t.link_entity(r, &link));
            }
            Op::Heading { peer, at, level } => {
                let d = &mut peers[peer].doc;
                let pos = at as usize % d.view().len();
                let h = Heading::from_level(level as i64);
                user(d, |t| t.set_heading(pos, h));
            }
            Op::Undo { peer } => {
                let Peer { doc, undo, .. } = &mut peers[peer];
                if undo.can_undo() {
                    undo.undo(doc).unwrap();
                }
            }
            Op::Redo { peer } => {
                let Peer { doc, undo, .. } = &mut peers[peer];
                if undo.can_redo() {
                    undo.redo(doc).unwrap();
                }
            }
            Op::Sync { from, to } => {
                if from != to {
                    let bytes = peers[from]
                        .doc
                        .export_updates_since(&peers[to].doc.version())
                        .unwrap();
                    peers[to].doc.import(&bytes, Origin::Sync).unwrap();
                }
            }
        }
        for p in peers.iter_mut() {
            check(p)?;
        }
    }
    Ok(())
}

struct Stats {
    checked: AtomicUsize,
    marked_local: AtomicUsize,
    imported: AtomicUsize,
}

static STATS: Stats = Stats {
    checked: AtomicUsize::new(0),
    marked_local: AtomicUsize::new(0),
    imported: AtomicUsize::new(0),
};

fn cases(default: u32) -> u32 {
    std::env::var("DR_PROP_CASES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

#[test]
fn insert_events_carry_the_marks_reads_see() {
    let mut runner = TestRunner::new_with_rng(
        ProptestConfig {
            cases: cases(128),
            failure_persistence: None,
            ..ProptestConfig::default()
        },
        TestRng::deterministic_rng(RngAlgorithm::ChaCha),
    );
    let result = runner.run(&prop::collection::vec(op(), 1..60), |ops| run(&ops));
    println!(
        "checked-characters={} marked-local-inserts={} imported-inserts={}",
        STATS.checked.load(Relaxed),
        STATS.marked_local.load(Relaxed),
        STATS.imported.load(Relaxed),
    );
    if let Err(e) = result {
        panic!("{e}");
    }
    // Typing next to bold text inherits it, and undo brings marked text back:
    // the run must have seen local inserts that came with marks.
    assert!(STATS.marked_local.load(Relaxed) > 0);
    assert!(STATS.imported.load(Relaxed) > 0);
}
