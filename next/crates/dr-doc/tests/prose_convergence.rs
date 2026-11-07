//! Property tests on prose documents (P0-C's `three_peers_converge`, moved
//! onto the typed API): three devices edit at random — type, Enter, delete
//! across paragraphs, set headings, link entities, anchor text, undo, Agent
//! writes — and sync in random order. After a full sync:
//!
//! - every device has the same text and the same rich text;
//! - the body ends with its newline;
//! - block ids are unique and equal everywhere (imports repair duplicates;
//!   a final repair round settles repairs made on diverged states);
//! - every anchor resolves, in bounds, to the same range on every device,
//!   and a persisted replacement resolves to the same range.
//!
//! `DR_PROP_CASES` sets the number of cases (default 256; the milestone run
//! uses 3000). The generator is fixed, so the printed counts reproduce; the
//! test asserts that the run exercised repairs and anchors.

use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};

use dr_doc::Anchor;
use dr_doc::prose::{ProseDoc, ProseTxn};
use dr_doc::undo::ProseUndo;
use dr_model::book::EncodedAnchor;
use dr_model::kind::EntityKind;
use dr_model::prose::{EntityLink, Heading};
use dr_model::{DocId, Origin};
use proptest::prelude::*;
use proptest::test_runner::{RngAlgorithm, TestRng, TestRunner};

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
    Heading {
        peer: usize,
        at: u16,
        level: u8,
    },
    Link {
        peer: usize,
        at: u16,
        len: u8,
        target: u8,
    },
    Anchor {
        peer: usize,
        at: u16,
        len: u8,
    },
    Undo {
        peer: usize,
    },
    Agent {
        peer: usize,
        at: u16,
    },
    Sync {
        from: usize,
        to: usize,
    },
}

const PEERS: usize = 3;
const ALPHABET: &[&str] = &["甲", "乙丙", "丁", "ab", "戊己庚", "x", "😀"];

fn op() -> impl Strategy<Value = Op> {
    let p = 0..PEERS;
    prop_oneof![
        6 => (p.clone(), any::<u16>(), any::<u8>()).prop_map(|(peer, at, s)| Op::Insert { peer, at, s }),
        3 => (p.clone(), any::<u16>()).prop_map(|(peer, at)| Op::Split { peer, at }),
        3 => (p.clone(), any::<u16>(), 1u8..12).prop_map(|(peer, at, len)| Op::Delete { peer, at, len }),
        1 => (p.clone(), any::<u16>(), 0u8..4).prop_map(|(peer, at, level)| Op::Heading { peer, at, level }),
        1 => (p.clone(), any::<u16>(), 1u8..6, 0u8..3).prop_map(|(peer, at, len, target)| Op::Link { peer, at, len, target }),
        1 => (p.clone(), any::<u16>(), 1u8..8).prop_map(|(peer, at, len)| Op::Anchor { peer, at, len }),
        1 => p.clone().prop_map(|peer| Op::Undo { peer }),
        1 => (p.clone(), any::<u16>()).prop_map(|(peer, at)| Op::Agent { peer, at }),
        3 => (p.clone(), p).prop_map(|(from, to)| Op::Sync { from, to }),
    ]
}

struct Peer {
    doc: ProseDoc,
    undo: ProseUndo,
}

fn sync(peers: &mut [Peer], from: usize, to: usize) {
    let bytes = peers[from]
        .doc
        .export_updates_since(&peers[to].doc.version())
        .unwrap();
    let imported = peers[to].doc.import(&bytes, Origin::Sync).unwrap();
    if imported.repair.is_some() {
        STATS.repairs_on_import.fetch_add(1, Relaxed);
    }
}

fn full_sync(peers: &mut [Peer]) {
    for _ in 0..2 {
        for i in 0..PEERS {
            for j in 0..PEERS {
                if i != j {
                    sync(peers, i, j);
                }
            }
        }
    }
}

fn user(d: &mut ProseDoc, f: impl FnOnce(&mut ProseTxn<'_>) -> dr_doc::Result<()>) {
    let (r, _) = d.edit(Origin::User, f);
    r.unwrap();
}

fn ids(d: &ProseDoc) -> Vec<Option<String>> {
    d.view()
        .paragraphs()
        .map(|p| p.stored_id.map(|i| i.to_string()))
        .collect()
}

fn unique_ids(d: &ProseDoc) -> bool {
    let mut seen = HashSet::new();
    d.view()
        .paragraphs()
        .all(|p| p.stored_id.is_some_and(|i| seen.insert(i)))
}

fn run(ops: &[Op]) -> Result<(), TestCaseError> {
    let id = DocId::parse("node:prop").unwrap();
    let mut peers: Vec<Peer> = (0..PEERS)
        .map(|i| {
            let doc = ProseDoc::create(id.clone(), 100 + i as u64).unwrap();
            let undo = doc.undo_manager();
            Peer { doc, undo }
        })
        .collect();
    // Anchors are created on one device and resolved on all (as if stored in
    // the book document).
    let mut anchors: Vec<EncodedAnchor> = Vec::new();
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
                let l = d.view().len();
                let start = at as usize % l;
                let end = (start + len as usize).min(l);
                user(d, |t| t.delete(start..end));
            }
            Op::Heading { peer, at, level } => {
                let d = &mut peers[peer].doc;
                let pos = at as usize % d.view().len();
                let h = Heading::from_level(level as i64);
                user(d, |t| t.set_heading(pos, h));
            }
            Op::Link {
                peer,
                at,
                len,
                target,
            } => {
                let d = &mut peers[peer].doc;
                let l = d.view().len();
                let start = at as usize % l;
                let end = (start + len as usize).min(l);
                let link = EntityLink {
                    target: format!("el-{target}"),
                    kind: EntityKind::Element,
                    block: None,
                    end_block: None,
                };
                user(d, |t| t.link_entity(start..end, &link));
            }
            Op::Anchor { peer, at, len } => {
                let v = peers[peer].doc.view();
                let start = at as usize % v.len();
                let end = (start + len as usize).min(v.len() - 1);
                if end > start
                    && let Some(a) = v.anchor(start..end)
                {
                    anchors.push(a.encode());
                }
            }
            Op::Undo { peer } => {
                let Peer { doc, undo } = &mut peers[peer];
                if undo.can_undo() {
                    undo.undo(doc).unwrap();
                }
            }
            Op::Agent { peer, at } => {
                let d = &mut peers[peer].doc;
                let pos = at as usize % d.view().len();
                let (r, _) = d.edit(Origin::agent("prop", 1), |t| t.insert_text(pos, "【A】"));
                r.unwrap();
            }
            Op::Sync { from, to } => {
                if from != to {
                    sync(&mut peers, from, to);
                }
            }
        }
    }
    full_sync(&mut peers);
    // Repairs made on diverged states can collide; a few rounds settle them.
    let mut rounds = 0;
    while peers.iter().any(|p| !unique_ids(&p.doc)) {
        rounds += 1;
        prop_assert!(rounds <= 4, "repairs did not settle");
        for p in peers.iter_mut() {
            p.doc.repair().unwrap();
        }
        full_sync(&mut peers);
    }
    STATS.max_rounds.fetch_max(rounds, Relaxed);
    if rounds > 0 {
        STATS.extra_rounds.fetch_add(1, Relaxed);
    }
    let first = &peers[0].doc;
    let text = first.view().plain_text();
    for p in &peers[1..] {
        prop_assert_eq!(&p.doc.view().plain_text(), &text);
        prop_assert_eq!(ids(&p.doc), ids(first));
        let a: Vec<_> = first.view().paragraphs().collect();
        let b: Vec<_> = p.doc.view().paragraphs().collect();
        prop_assert_eq!(a, b);
    }
    prop_assert!(text.ends_with('\n'), "body ends with a newline: {text:?}");
    for p in &peers {
        prop_assert!(unique_ids(&p.doc));
    }
    // Anchors resolve to the same in-bounds range everywhere.
    for e in &anchors {
        let a = Anchor::decode(e).expect("anchor decodes");
        let r0 = first.view().resolve(&a);
        prop_assert!(r0.is_some(), "anchor lost");
        let r0 = r0.unwrap();
        STATS.anchors.fetch_add(1, Relaxed);
        if r0.collapsed {
            STATS.collapsed.fetch_add(1, Relaxed);
        }
        prop_assert!(r0.range.start <= r0.range.end && r0.range.end <= first.view().len());
        for p in &peers[1..] {
            let r = p.doc.view().resolve(&a).unwrap();
            prop_assert_eq!(&r.range, &r0.range);
            prop_assert_eq!(r.collapsed, r0.collapsed);
        }
        if let Some(u) = &r0.updated {
            let r1 = first.view().resolve(u).unwrap();
            prop_assert_eq!(&r1.range, &r0.range);
        }
    }
    Ok(())
}

struct Stats {
    cases: AtomicUsize,
    repairs_on_import: AtomicUsize,
    extra_rounds: AtomicUsize,
    max_rounds: AtomicUsize,
    anchors: AtomicUsize,
    collapsed: AtomicUsize,
}

static STATS: Stats = Stats {
    cases: AtomicUsize::new(0),
    repairs_on_import: AtomicUsize::new(0),
    extra_rounds: AtomicUsize::new(0),
    max_rounds: AtomicUsize::new(0),
    anchors: AtomicUsize::new(0),
    collapsed: AtomicUsize::new(0),
};

fn cases(default: u32) -> u32 {
    std::env::var("DR_PROP_CASES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

#[test]
fn three_peers_converge() {
    let mut runner = TestRunner::new_with_rng(
        ProptestConfig {
            cases: cases(256),
            failure_persistence: None,
            ..ProptestConfig::default()
        },
        TestRng::deterministic_rng(RngAlgorithm::ChaCha),
    );
    let result = runner.run(&prop::collection::vec(op(), 1..60), |ops| {
        STATS.cases.fetch_add(1, Relaxed);
        run(&ops)
    });
    println!(
        "cases={} repairs-on-import={} cases-needing-extra-repair-rounds={} max-extra-rounds={} anchors={} collapsed={}",
        STATS.cases.load(Relaxed),
        STATS.repairs_on_import.load(Relaxed),
        STATS.extra_rounds.load(Relaxed),
        STATS.max_rounds.load(Relaxed),
        STATS.anchors.load(Relaxed),
        STATS.collapsed.load(Relaxed),
    );
    if let Err(e) = result {
        panic!("{e}");
    }
    // The run exercised what it claims to (3000 cases, release, fixed
    // generator: 1622 repairs on import, 2708 anchors, 793 collapsed, no
    // extra repair round).
    assert!(
        STATS.repairs_on_import.load(Relaxed) > 0,
        "no duplicate block id was ever repaired"
    );
    assert!(STATS.anchors.load(Relaxed) > 0 && STATS.collapsed.load(Relaxed) > 0);
    assert!(STATS.max_rounds.load(Relaxed) <= 1);
}

proptest! {
    #![proptest_config(ProptestConfig { cases: cases(128), ..ProptestConfig::default() })]

    /// An anchor whose text nobody deletes keeps exactly that text, whatever
    /// is typed around and inside it on other devices.
    #[test]
    fn untouched_anchor_keeps_its_text(inserts in prop::collection::vec((0usize..3, any::<u16>()), 0..40)) {
        let id = DocId::parse("node:keep").unwrap();
        let mut a = ProseDoc::create(id.clone(), 1).unwrap();
        user(&mut a, |t| t.insert_text(0, "零一二三四五六七八九"));
        let mut peers: Vec<ProseDoc> = (0..3).map(|i| {
            let mut p = ProseDoc::create(id.clone(), 10 + i).unwrap();
            p.import(&a.export_updates_since(&p.version()).unwrap(), Origin::Sync).unwrap();
            p
        }).collect();
        let anchor = a.view().anchor(3..7).unwrap();
        for (peer, at) in &inserts {
            let p = &mut peers[*peer];
            let pos = *at as usize % p.view().len();
            user(p, |t| t.insert_text(pos, "＋"));
        }
        for p in &peers {
            a.import(&p.export_updates_since(&a.version()).unwrap(), Origin::Sync).unwrap();
        }
        let r = a.view().resolve(&anchor).unwrap();
        let s: String = a.view().text_in(r.range).unwrap().chars().filter(|c| *c != '＋').collect();
        prop_assert_eq!(s, "三四五六");
        prop_assert!(!r.collapsed);
    }

    /// The block-id repair is a function of the state: two devices holding the
    /// same (damaged) state write the same ids, and the merged result needs no
    /// further repair.
    #[test]
    fn repair_is_deterministic(texts in prop::collection::vec("[甲乙丙a-c]{0,4}", 1..8), dups in prop::collection::vec((any::<u8>(), any::<u8>()), 1..6)) {
        let id = DocId::parse("node:rep").unwrap();
        let mut a = ProseDoc::create(id.clone(), 1).unwrap();
        user(&mut a, |t| {
            t.insert_paragraphs(0, &texts.join("\n")).map(|_| ())
        });
        // Damage: copy one paragraph's id onto another, or remove it.
        let blocks = a.view().blocks();
        for (from, to) in &dups {
            let src = &blocks[*from as usize % blocks.len()];
            let dst = &blocks[*to as usize % blocks.len()];
            let (_, _) = a.edit(Origin::User, |t| {
                t.set_block_id(dst.newline, src.id.as_ref())
            });
        }
        // Load (no automatic repair) the same damaged state on a second device.
        let mut b = ProseDoc::load(id.clone(), 2, &[a.export_snapshot().unwrap()]).unwrap();
        let (ra, ca) = a.edit(Origin::Repair, |t| t.repair_block_ids());
        let (rb, cb) = b.edit(Origin::Repair, |t| t.repair_block_ids());
        prop_assert_eq!(ra.unwrap(), rb.unwrap());
        prop_assert_eq!(ca.is_some(), cb.is_some());
        prop_assert_eq!(ids(&a), ids(&b));
        prop_assert!(unique_ids(&a));
        let bytes = b.export_updates_since(&a.version()).unwrap();
        a.import(&bytes, Origin::Sync).unwrap();
        prop_assert!(unique_ids(&a));
        let (r, _) = a.edit(Origin::Repair, |t| t.repair_block_ids());
        prop_assert_eq!(r.unwrap(), 0);
    }
}
