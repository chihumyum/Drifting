//! Property test on seed changes (`book::seed`): three devices project TODOs
//! from the same markers (with the task read in different versions), edit,
//! resolve and delete them, create the same plot grids, label and move their
//! rows, add rows, write unrelated things (so their Lamport clocks run far
//! apart) and sync in random order. After a full sync:
//!
//! - every device reads the same TODOs and grids;
//! - a TODO nobody edited has exactly one of the task texts as its body,
//!   never two run together;
//! - a TODO someone resolved, and nobody deleted, is resolved: a late
//!   projection never reopens it;
//! - a grid has its three default rows and columns plus the rows added,
//!   never six by six;
//! - a row someone moved is where one of the real writes put it, never back
//!   at the default; a row someone labelled has one of those labels.
//!
//! `DR_PROP_CASES` sets the number of cases (default 128).

use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};

use dr_doc::book::{BookDoc, BookTxn, Collection};
use dr_model::id::*;
use dr_model::kind::*;
use dr_model::{DocId, Origin, Timestamp};
use proptest::prelude::*;
use proptest::test_runner::{RngAlgorithm, TestRng, TestRunner};

const PEERS: usize = 3;
const TASKS: &[&str] = &["补一场", "补一场雨", "查年代"];
const BODIES: &[&str] = &["作者改过", "改成这样"];
const LABELS: &[&str] = &["开端", "转折", "结局"];
const MOVES: &[&str] = &["Zz", "a0V", "a1V", "a5"];

#[derive(Clone, Debug)]
enum Op {
    Project {
        peer: usize,
        block: u8,
        task: u8,
    },
    EditBody {
        peer: usize,
        block: u8,
        text: u8,
    },
    Resolve {
        peer: usize,
        block: u8,
    },
    Remove {
        peer: usize,
        block: u8,
    },
    Busy {
        peer: usize,
    },
    CreateGrid {
        peer: usize,
        chapter: u8,
    },
    Label {
        peer: usize,
        chapter: u8,
        line: u8,
        text: u8,
    },
    Move {
        peer: usize,
        chapter: u8,
        line: u8,
        to: u8,
    },
    AddRow {
        peer: usize,
        chapter: u8,
        k: u8,
    },
    Sync {
        from: usize,
        to: usize,
    },
}

fn op() -> impl Strategy<Value = Op> {
    let p = 0..PEERS;
    prop_oneof![
        5 => (p.clone(), 0u8..3, 0u8..3).prop_map(|(peer, block, task)| Op::Project { peer, block, task }),
        1 => (p.clone(), 0u8..3, 0u8..2).prop_map(|(peer, block, text)| Op::EditBody { peer, block, text }),
        2 => (p.clone(), 0u8..3).prop_map(|(peer, block)| Op::Resolve { peer, block }),
        1 => (p.clone(), 0u8..3).prop_map(|(peer, block)| Op::Remove { peer, block }),
        1 => p.clone().prop_map(|peer| Op::Busy { peer }),
        4 => (p.clone(), 0u8..2).prop_map(|(peer, chapter)| Op::CreateGrid { peer, chapter }),
        2 => (p.clone(), 0u8..2, 1u8..4, 0u8..3).prop_map(|(peer, chapter, line, text)| Op::Label { peer, chapter, line, text }),
        2 => (p.clone(), 0u8..2, 1u8..4, 0u8..4).prop_map(|(peer, chapter, line, to)| Op::Move { peer, chapter, line, to }),
        1 => (p.clone(), 0u8..2, 0u8..2).prop_map(|(peer, chapter, k)| Op::AddRow { peer, chapter, k }),
        5 => (p.clone(), p).prop_map(|(from, to)| Op::Sync { from, to }),
    ]
}

fn sync(peers: &mut [BookDoc], from: usize, to: usize) {
    let bytes = peers[from]
        .export_updates_since(&peers[to].version())
        .unwrap();
    peers[to].import(&bytes, Origin::Sync).unwrap();
}

fn full_sync(peers: &mut [BookDoc]) {
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

fn edit<R>(d: &mut BookDoc, f: impl FnOnce(&mut BookTxn<'_>) -> dr_doc::Result<R>) -> R {
    let (r, _) = d.edit(Origin::User, f);
    r.unwrap()
}

fn doc() -> DocId {
    DocId::Node(NodeId::parse("c1").unwrap())
}

fn block(i: u8) -> BlockId {
    BlockId::parse(&format!("{i}@9")).unwrap()
}

fn todo_id(i: u8) -> CommentId {
    CommentId::for_projection(&ProjectionKind::Marker, &doc(), &block(i))
}

fn chapter(i: u8) -> NodeId {
    NodeId::parse(&format!("g{i}")).unwrap()
}

/// What the run did, to check the merged result against.
#[derive(Default)]
struct Log {
    tasks: BTreeMap<u8, BTreeSet<&'static str>>,
    edited: BTreeSet<u8>,
    resolved: BTreeSet<u8>,
    removed: BTreeSet<u8>,
    created: BTreeSet<u8>,
    labels: BTreeMap<(u8, u8), BTreeSet<&'static str>>,
    /// Positions real writes gave a default row (moves, and the label
    /// writes, which write the position they saw).
    positions: BTreeMap<(u8, u8), BTreeSet<String>>,
    moved: BTreeSet<(u8, u8)>,
    added: BTreeMap<u8, BTreeSet<String>>,
}

fn snapshot(d: &BookDoc) -> String {
    let v = d.view();
    let grids: Vec<_> = (0..2).map(|c| v.plot_grid(&chapter(c))).collect();
    format!("{:?}\n{grids:?}", v.comments())
}

fn run(ops: &[Op]) -> Result<(), TestCaseError> {
    let book = BookId::parse("seeds").unwrap();
    let mut peers: Vec<BookDoc> = (0..PEERS)
        .map(|i| BookDoc::create(book.clone(), 300 + i as u64).unwrap())
        .collect();
    let mut log = Log::default();
    for op in ops {
        match op.clone() {
            Op::Project {
                peer,
                block: b,
                task,
            } => {
                let t = TASKS[task as usize];
                if peers[peer].view().comment(&todo_id(b)).is_none() {
                    log.tasks.entry(b).or_default().insert(t);
                }
                edit(&mut peers[peer], |x| {
                    let (_, w) = x.project_todo(&ProjectionKind::Marker, &doc(), &block(b), t)?;
                    w.source(&CommentSource::Manual)?
                        .created_at(Some(Timestamp(peer as i64)))?;
                    Ok(())
                });
            }
            Op::EditBody {
                peer,
                block: b,
                text,
            } => {
                if peers[peer].view().comment(&todo_id(b)).is_some() {
                    log.edited.insert(b);
                    edit(&mut peers[peer], |x| {
                        x.comment(&todo_id(b))?.body(BODIES[text as usize])?;
                        Ok(())
                    });
                }
            }
            Op::Resolve { peer, block: b } => {
                if peers[peer].view().comment(&todo_id(b)).is_some() {
                    log.resolved.insert(b);
                    edit(&mut peers[peer], |x| {
                        x.comment(&todo_id(b))?.status(&CommentStatus::Resolved)?;
                        Ok(())
                    });
                }
            }
            Op::Remove { peer, block: b } => {
                let open = peers[peer]
                    .view()
                    .comment(&todo_id(b))
                    .is_some_and(|c| c.status == CommentStatus::Open);
                if open {
                    log.removed.insert(b);
                    edit(&mut peers[peer], |x| {
                        x.purge(Collection::Comments, todo_id(b).as_str())
                    });
                }
            }
            Op::Busy { peer } => {
                for i in 0..12 {
                    edit(&mut peers[peer], |x| {
                        x.meta().summary(&format!("{peer}-{i}")).map(|_| ())
                    });
                }
            }
            Op::CreateGrid { peer, chapter: c } => {
                log.created.insert(c);
                edit(&mut peers[peer], |x| {
                    x.create_plot_grid(&chapter(c)).map(|_| ())
                });
            }
            Op::Label {
                peer,
                chapter: c,
                line,
                text,
            } => {
                let id = PlotRowId::default_for(&chapter(c), line as usize);
                let Some(g) = peers[peer].view().plot_grid(&chapter(c)) else {
                    continue;
                };
                let Some(row) = g.rows.iter().find(|r| r.id == id) else {
                    continue;
                };
                let pos = row.pos.as_ref().map(|p| p.to_string()).unwrap_or_default();
                let label = LABELS[text as usize];
                log.labels.entry((c, line)).or_default().insert(label);
                log.positions
                    .entry((c, line))
                    .or_default()
                    .insert(pos.clone());
                edit(&mut peers[peer], |x| {
                    x.plot_grid(&chapter(c))?.row(&id, &pos, label)?;
                    Ok(())
                });
            }
            Op::Move {
                peer,
                chapter: c,
                line,
                to,
            } => {
                let id = PlotRowId::default_for(&chapter(c), line as usize);
                let Some(g) = peers[peer].view().plot_grid(&chapter(c)) else {
                    continue;
                };
                let Some(row) = g.rows.iter().find(|r| r.id == id) else {
                    continue;
                };
                let pos = MOVES[to as usize];
                log.moved.insert((c, line));
                log.positions
                    .entry((c, line))
                    .or_default()
                    .insert(pos.to_string());
                let label = row.label.clone();
                edit(&mut peers[peer], |x| {
                    x.plot_grid(&chapter(c))?.row(&id, pos, &label)?;
                    Ok(())
                });
            }
            Op::AddRow {
                peer,
                chapter: c,
                k,
            } => {
                if peers[peer].view().plot_grid(&chapter(c)).is_some() {
                    let id = format!("x{peer}{k}");
                    log.added.entry(c).or_default().insert(id.clone());
                    edit(&mut peers[peer], |x| {
                        x.plot_grid(&chapter(c))?
                            .row(&PlotRowId::parse(&id).unwrap(), "a9", "")?;
                        Ok(())
                    });
                }
            }
            Op::Sync { from, to } => {
                if from != to {
                    sync(&mut peers, from, to);
                }
            }
        }
    }
    full_sync(&mut peers);
    let s0 = snapshot(&peers[0]);
    for p in &peers[1..] {
        prop_assert_eq!(&snapshot(p), &s0);
    }
    let v = peers[0].view();
    for b in 0..3u8 {
        let Some(c) = v.comment(&todo_id(b)) else {
            continue;
        };
        STATS.todos.fetch_add(1, Relaxed);
        if !log.edited.contains(&b) {
            let tasks = log.tasks.get(&b).cloned().unwrap_or_default();
            prop_assert!(
                tasks.contains(c.body.as_str()),
                "body {:?} of {:?}",
                c.body,
                tasks
            );
        }
        if log.resolved.contains(&b) && !log.removed.contains(&b) {
            STATS.resolved.fetch_add(1, Relaxed);
            prop_assert_eq!(c.status, CommentStatus::Resolved, "block {}", b);
        }
    }
    for c in 0..2u8 {
        let g = v.plot_grid(&chapter(c));
        prop_assert_eq!(g.is_some(), log.created.contains(&c));
        let Some(g) = g else { continue };
        STATS.grids.fetch_add(1, Relaxed);
        let added = log.added.get(&c).map_or(0, |a| a.len());
        prop_assert_eq!(g.rows.len(), 3 + added);
        prop_assert_eq!(g.cols.len(), 3);
        for line in 1..=3u8 {
            let id = PlotRowId::default_for(&chapter(c), line as usize);
            let row = g.rows.iter().find(|r| r.id == id);
            prop_assert!(row.is_some(), "default row {} is there", id);
            let row = row.unwrap();
            match log.labels.get(&(c, line)) {
                Some(ls) => {
                    prop_assert!(ls.contains(row.label.as_str()) || log.moved.contains(&(c, line)))
                }
                None => prop_assert!(row.label.is_empty() || log.moved.contains(&(c, line))),
            }
            if log.moved.contains(&(c, line)) {
                STATS.moved.fetch_add(1, Relaxed);
                let pos = row.pos.as_ref().map(|p| p.to_string()).unwrap_or_default();
                let real = &log.positions[&(c, line)];
                prop_assert!(
                    real.contains(&pos),
                    "row {} at {:?}, written {:?}",
                    id,
                    pos,
                    real
                );
            }
        }
    }
    Ok(())
}

struct Stats {
    todos: AtomicUsize,
    resolved: AtomicUsize,
    grids: AtomicUsize,
    moved: AtomicUsize,
}

static STATS: Stats = Stats {
    todos: AtomicUsize::new(0),
    resolved: AtomicUsize::new(0),
    grids: AtomicUsize::new(0),
    moved: AtomicUsize::new(0),
};

#[test]
fn seeds_merge_into_one_and_never_beat_a_real_edit() {
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
        "todos={} resolved-checked={} grids={} moved-rows-checked={}",
        STATS.todos.load(Relaxed),
        STATS.resolved.load(Relaxed),
        STATS.grids.load(Relaxed),
        STATS.moved.load(Relaxed),
    );
    if let Err(e) = result {
        panic!("{e}");
    }
    assert!(STATS.resolved.load(Relaxed) > 0 && STATS.moved.load(Relaxed) > 0);
}
