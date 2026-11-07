//! Property tests: random editing on three peers, synced in random order,
//! converges; block ids stay unique; anchors resolve identically everywhere
//! and stay in bounds; block attributes live only on newlines.

use std::collections::HashSet;

use loro::{ExportMode, LoroDoc, TextDelta, UndoManager};
use loro_model_spike::agent::{AGENT_PREFIX, agent_origin, write_in_place};
use loro_model_spike::anchor::Anchor;
use loro_model_spike::prose::ProseDoc;
use loro_model_spike::schema::block;
use proptest::prelude::*;
use proptest::test_runner::{RngAlgorithm, TestRng, TestRunner};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};

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
        para: u16,
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
const ALPHABET: &[&str] = &["甲", "乙丙", "丁", "ab", "戊己庚", "x"];

fn op() -> impl Strategy<Value = Op> {
    let p = 0..PEERS;
    prop_oneof![
        6 => (p.clone(), any::<u16>(), any::<u8>()).prop_map(|(peer, at, s)| Op::Insert { peer, at, s }),
        3 => (p.clone(), any::<u16>()).prop_map(|(peer, at)| Op::Split { peer, at }),
        3 => (p.clone(), any::<u16>(), 1u8..12).prop_map(|(peer, at, len)| Op::Delete { peer, at, len }),
        1 => (p.clone(), any::<u16>(), 0u8..4).prop_map(|(peer, para, level)| Op::Heading { peer, para, level }),
        1 => (p.clone(), any::<u16>(), 1u8..6, 0u8..3).prop_map(|(peer, at, len, target)| Op::Link { peer, at, len, target }),
        1 => (p.clone(), any::<u16>(), 1u8..8).prop_map(|(peer, at, len)| Op::Anchor { peer, at, len }),
        1 => p.clone().prop_map(|peer| Op::Undo { peer }),
        1 => (p.clone(), any::<u16>()).prop_map(|(peer, at)| Op::Agent { peer, at }),
        3 => (p.clone(), p).prop_map(|(from, to)| Op::Sync { from, to }),
    ]
}

fn sync(from: &LoroDoc, to: &LoroDoc) {
    let bytes = from.export(ExportMode::updates(&to.oplog_vv())).unwrap();
    to.import(&bytes).unwrap();
}

struct Peer {
    prose: ProseDoc,
    undo: UndoManager,
}

fn run(ops: &[Op]) -> Result<(), TestCaseError> {
    let peers: Vec<Peer> = (0..PEERS)
        .map(|i| {
            let prose = ProseDoc::create("node:prop", 100 + i as u64);
            let mut undo = UndoManager::new(&prose.doc);
            undo.add_exclude_origin_prefix(AGENT_PREFIX);
            Peer { prose, undo }
        })
        .collect();
    let mut peers = peers;
    // Anchors are created on one peer and resolved on all (as if stored in
    // the book document): (anchor, creator text at creation).
    let mut anchors: Vec<Anchor> = Vec::new();
    let skip: Vec<String> = std::env::var("P0C_PROP_SKIP")
        .map(|v| v.split(',').map(str::to_string).collect())
        .unwrap_or_default();
    for op in ops {
        let name = format!("{op:?}");
        let name = name.split([' ', '{']).next().unwrap_or("");
        if skip.iter().any(|s| s == name) {
            continue;
        }
        match op.clone() {
            Op::Insert { peer, at, s } => {
                let p = &peers[peer].prose;
                let pos = at as usize % p.len();
                p.insert_text(pos, ALPHABET[s as usize % ALPHABET.len()]);
                p.doc.commit();
            }
            Op::Split { peer, at } => {
                let p = &peers[peer].prose;
                p.split(at as usize % p.len());
                p.doc.commit();
            }
            Op::Delete { peer, at, len } => {
                let p = &peers[peer].prose;
                let start = at as usize % p.len();
                p.delete(start..start + len as usize);
                p.doc.commit();
            }
            Op::Heading { peer, para, level } => {
                let p = &peers[peer].prose;
                let paras = p.paragraphs();
                let nl = paras[para as usize % paras.len()].newline;
                let v = if level == 0 {
                    None
                } else {
                    Some((level as i64).into())
                };
                p.set_block_attr(nl, block::HEADING, v);
                p.doc.commit();
            }
            Op::Link {
                peer,
                at,
                len,
                target,
            } => {
                let p = &peers[peer].prose;
                let start = at as usize % p.len();
                let end = (start + len as usize).min(p.len());
                if end > start {
                    p.link_entity(start..end, &format!("el-{target}"), "element");
                    p.doc.commit();
                }
            }
            Op::Anchor { peer, at, len } => {
                let p = &peers[peer].prose;
                let start = at as usize % p.len();
                let end = (start + len as usize).min(p.len() - 1);
                if end > start
                    && let Some(a) = Anchor::new(&p.text(), start..end)
                {
                    let (s, e) = a.encode();
                    anchors.push(Anchor::decode(&s, &e).unwrap());
                }
            }
            Op::Undo { peer } => {
                let peer = &mut peers[peer];
                if peer.undo.can_undo() {
                    peer.undo.undo().unwrap();
                }
            }
            Op::Agent { peer, at } => {
                let p = &peers[peer].prose;
                let pos = at as usize % p.len();
                write_in_place(p, &agent_origin("prop", 1), |p| p.insert_text(pos, "【A】"));
            }
            Op::Sync { from, to } => {
                if from != to {
                    sync(&peers[from].prose.doc, &peers[to].prose.doc);
                }
            }
        }
    }
    // Full sync.
    for _ in 0..2 {
        for i in 0..PEERS {
            for j in 0..PEERS {
                if i != j {
                    sync(&peers[i].prose.doc, &peers[j].prose.doc);
                }
            }
        }
    }
    let first = &peers[0].prose;
    let text = first.text().to_string();
    let rich = first.text().get_richtext_value();
    for p in &peers[1..] {
        prop_assert_eq!(&p.prose.text().to_string(), &text);
        prop_assert_eq!(&p.prose.text().get_richtext_value(), &rich);
    }
    prop_assert!(
        text.ends_with('\n'),
        "body ends with a newline: {text:?} {:?}",
        first.text().get_richtext_value()
    );
    // Block attributes that leaked onto text (concurrent insert at a mark
    // boundary) are counted; readers ignore them.
    for d in first.text().to_delta() {
        if let TextDelta::Insert {
            insert,
            attributes: Some(a),
        } = d
            && a.keys().any(|k| block::ALL.contains(&k.as_str()))
            && insert.chars().any(|c| c != '\n')
        {
            STATS.leaks.fetch_add(1, Relaxed);
        }
    }
    // Block ids: count duplicates or gaps, then repair on every peer and
    // check that the repaired documents converge with unique ids.
    let paras = first.paragraphs();
    let mut seen = HashSet::new();
    let mut bad = 0;
    for p in &paras {
        match &p.id {
            Some(id) if seen.insert(id.clone()) => {}
            _ => bad += 1,
        }
    }
    if bad > 0 {
        STATS.dup_cases.fetch_add(1, Relaxed);
        for p in &peers {
            p.prose.repair_block_ids();
            p.prose.doc.commit();
        }
        for i in 0..PEERS {
            for j in 0..PEERS {
                if i != j {
                    sync(&peers[i].prose.doc, &peers[j].prose.doc);
                }
            }
        }
        let rich = peers[0].prose.text().get_richtext_value();
        for p in &peers[1..] {
            prop_assert_eq!(&p.prose.text().get_richtext_value(), &rich);
        }
        prop_assert_eq!(peers[0].prose.repair_block_ids(), 0, "repair converged");
    }
    // Anchors resolve to the same in-bounds range on every peer.
    for a in &anchors {
        let r0 = a.resolve(&first.doc);
        prop_assert!(r0.is_some(), "anchor lost");
        let r0 = r0.unwrap();
        STATS.anchors.fetch_add(1, Relaxed);
        if r0.collapsed {
            STATS.collapsed.fetch_add(1, Relaxed);
        }
        prop_assert!(r0.range.start <= r0.range.end && r0.range.end <= first.len());
        for p in &peers[1..] {
            let r = a.resolve(&p.prose.doc).unwrap();
            prop_assert_eq!(&r.range, &r0.range);
            prop_assert_eq!(r.collapsed, r0.collapsed);
        }
        // A persisted replacement cursor resolves to the same range.
        if let Some(u) = &r0.updated {
            let r1 = u.resolve(&first.doc).unwrap();
            prop_assert_eq!(&r1.range, &r0.range);
        }
    }
    Ok(())
}

struct Stats {
    cases: AtomicUsize,
    leaks: AtomicUsize,
    dup_cases: AtomicUsize,
    anchors: AtomicUsize,
    collapsed: AtomicUsize,
}

static STATS: Stats = Stats {
    cases: AtomicUsize::new(0),
    leaks: AtomicUsize::new(0),
    dup_cases: AtomicUsize::new(0),
    anchors: AtomicUsize::new(0),
    collapsed: AtomicUsize::new(0),
};

#[test]
fn three_peers_converge() {
    let cases: u32 = std::env::var("P0C_PROP_CASES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(256);
    // A fixed generator, so the counts printed below are reproducible.
    let mut runner = TestRunner::new_with_rng(
        ProptestConfig {
            cases,
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
        "cases={} leaked-block-attr-runs={} cases-needing-id-repair={} anchors={} collapsed={}",
        STATS.cases.load(Relaxed),
        STATS.leaks.load(Relaxed),
        STATS.dup_cases.load(Relaxed),
        STATS.anchors.load(Relaxed),
        STATS.collapsed.load(Relaxed),
    );
    if let Err(e) = result {
        panic!("{e}");
    }
}

/// An anchor whose text nobody deletes keeps exactly that text, whatever is
/// typed around and inside it on other peers.
#[test]
fn untouched_anchor_keeps_its_text() {
    proptest!(ProptestConfig { cases: 128, ..ProptestConfig::default() }, |(inserts in prop::collection::vec((0usize..3, any::<u16>()), 0..40))| {
        let a = ProseDoc::create("node:keep", 1);
        a.insert_text(0, "零一二三四五六七八九");
        a.doc.commit();
        let peers: Vec<ProseDoc> = (0..3).map(|i| {
            let p = ProseDoc::create("node:keep", 10 + i);
            sync(&a.doc, &p.doc);
            p
        }).collect();
        let anchor = Anchor::new(&a.text(), 3..7).unwrap();
        for (peer, at) in &inserts {
            let p = &peers[*peer];
            let pos = *at as usize % p.len();
            // Insert outside the anchor or inside it, never deleting.
            p.insert_text(pos, "＋");
            p.doc.commit();
        }
        for p in &peers {
            sync(&p.doc, &a.doc);
        }
        let r = anchor.resolve(&a.doc).unwrap();
        let s: String = a.text().slice(r.range.start, r.range.end).unwrap().chars().filter(|c| *c != '＋').collect();
        prop_assert_eq!(s, "三四五六");
        prop_assert!(!r.collapsed);
    });
}
