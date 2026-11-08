//! Property test on conversation documents (`conversation`): three devices
//! append the events of their own runs, replay some (recovery appends the
//! same event again), and sync in random order, some updates delivered
//! before the ones they depend on. After a full sync:
//!
//! - honest syncs are never refused: an update with its dependencies is
//!   always accepted, and one that arrived early is accepted once they are
//!   there;
//! - every device reads the same entries, each event once, nothing
//!   unreadable or conflicting;
//! - every event appended anywhere is there, and each device's own events
//!   are in the order it appended them.
//!
//! `DR_PROP_CASES` sets the number of cases (default 128).

use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};

use dr_doc::conversation::{ConversationDoc, ConversationProblems};
use dr_model::Origin;
use dr_model::conversation::{ConversationEntry, ConversationEntryKind};
use dr_model::id::ConversationId;
use loro::VersionVector;
use proptest::prelude::*;
use proptest::test_runner::{RngAlgorithm, TestRng, TestRunner};
use serde_json::json;

const PEERS: usize = 3;

#[derive(Clone, Debug)]
enum Op {
    /// The next event of `peer`'s run.
    Append { peer: usize },
    /// Append one of `peer`'s earlier events again.
    Replay { peer: usize, back: u8 },
    /// What `to` lacks from `from`.
    Sync { from: usize, to: usize },
    /// `from`'s latest commit alone, whatever `to` has: early when `to`
    /// lacks what it depends on.
    Latest { from: usize, to: usize },
}

fn op() -> impl Strategy<Value = Op> {
    let p = 0..PEERS;
    prop_oneof![
        5 => p.clone().prop_map(|peer| Op::Append { peer }),
        1 => (p.clone(), 0u8..4).prop_map(|(peer, back)| Op::Replay { peer, back }),
        4 => (p.clone(), p.clone()).prop_map(|(from, to)| Op::Sync { from, to }),
        2 => (p.clone(), p).prop_map(|(from, to)| Op::Latest { from, to }),
    ]
}

fn id() -> ConversationId {
    ConversationId::parse("cv-prop").unwrap()
}

fn event(peer: usize, seq: u32) -> ConversationEntry {
    let session = format!("run-{peer}");
    let kind = [
        "user",
        "assistant",
        "tool_call",
        "tool_result",
        "future_kind",
    ][seq as usize % 5];
    ConversationEntry {
        id: format!("{session}:{seq}"),
        session,
        turn: seq / 3,
        kind: ConversationEntryKind::parse(kind),
        payload: json!({"text": format!("{peer}-{seq}"), "extra": {"seq": seq}}),
    }
}

struct Peer {
    doc: ConversationDoc,
    appended: Vec<ConversationEntry>,
    /// The version before this device's latest commit, and that commit.
    latest: Option<(VersionVector, Vec<u8>)>,
}

static STATS: Stats = Stats {
    entries: AtomicUsize::new(0),
    early: AtomicUsize::new(0),
    replays: AtomicUsize::new(0),
};

struct Stats {
    entries: AtomicUsize,
    early: AtomicUsize,
    replays: AtomicUsize,
}

fn sync(peers: &mut [Peer], from: usize, to: usize) -> Result<(), TestCaseError> {
    let bytes = peers[from]
        .doc
        .export_updates_since(&peers[to].doc.version())
        .unwrap();
    let r = peers[to].doc.import(&bytes, Origin::Sync);
    prop_assert!(r.is_ok(), "an honest sync was refused: {:?}", r.err());
    Ok(())
}

fn run(ops: &[Op]) -> Result<(), TestCaseError> {
    let mut peers: Vec<Peer> = (0..PEERS)
        .map(|i| Peer {
            doc: ConversationDoc::create(id(), i as u64 + 1).unwrap(),
            appended: Vec::new(),
            latest: None,
        })
        .collect();
    for op in ops {
        match *op {
            Op::Append { peer } => {
                let p = &mut peers[peer];
                let e = event(peer, p.appended.len() as u32);
                let before = p.doc.version();
                let (r, committed) = p.doc.append(Origin::User, &e);
                prop_assert!(r.unwrap());
                p.latest = Some((before, committed.unwrap().update));
                p.appended.push(e);
            }
            Op::Replay { peer, back } => {
                let p = &mut peers[peer];
                let Some(e) = p.appended.iter().rev().nth(back as usize).cloned() else {
                    continue;
                };
                let (r, committed) = p.doc.append(Origin::User, &e);
                prop_assert!(!r.unwrap() && committed.is_none(), "a replay wrote");
                STATS.replays.fetch_add(1, Relaxed);
            }
            Op::Sync { from, to } if from != to => sync(&mut peers, from, to)?,
            Op::Latest { from, to } if from != to => {
                let Some((before, bytes)) = peers[from].latest.clone() else {
                    continue;
                };
                let early = !before
                    .partial_cmp(&peers[to].doc.version())
                    .is_some_and(|o| o != std::cmp::Ordering::Greater);
                let r = peers[to].doc.import(&bytes, Origin::Sync);
                if early {
                    STATS.early.fetch_add(1, Relaxed);
                    prop_assert!(r.is_err(), "an early update was taken");
                } else {
                    prop_assert!(r.is_ok(), "an update in order was refused: {:?}", r.err());
                }
            }
            _ => {}
        }
    }
    for _ in 0..2 {
        for i in 0..PEERS {
            for j in 0..PEERS {
                if i != j {
                    sync(&mut peers, i, j)?;
                }
            }
        }
    }
    let read = peers[0].doc.entries().unwrap();
    for p in &peers {
        prop_assert_eq!(&p.doc.entries().unwrap(), &read);
        prop_assert_eq!(p.doc.problems(), ConversationProblems::default());
    }
    let total: usize = peers.iter().map(|p| p.appended.len()).sum();
    prop_assert_eq!(read.len(), total, "every event once");
    for p in &peers {
        let mine: Vec<&ConversationEntry> = read
            .iter()
            .filter(|e| p.appended.first().is_some_and(|f| f.session == e.session))
            .collect();
        prop_assert_eq!(mine, p.appended.iter().collect::<Vec<_>>());
    }
    STATS.entries.fetch_add(read.len(), Relaxed);
    Ok(())
}

#[test]
fn honest_devices_converge_and_are_never_refused() {
    let cases: u32 = std::env::var("DR_PROP_CASES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(128);
    let mut runner = TestRunner::new_with_rng(
        ProptestConfig {
            cases,
            failure_persistence: None,
            ..ProptestConfig::default()
        },
        TestRng::deterministic_rng(RngAlgorithm::ChaCha),
    );
    let result = runner.run(&prop::collection::vec(op(), 1..60), |ops| run(&ops));
    println!(
        "entries={} early-updates-refused={} replays={}",
        STATS.entries.load(Relaxed),
        STATS.early.load(Relaxed),
        STATS.replays.load(Relaxed),
    );
    if let Err(e) = result {
        panic!("{e}");
    }
    assert!(STATS.early.load(Relaxed) > 0 && STATS.replays.load(Relaxed) > 0);
}
