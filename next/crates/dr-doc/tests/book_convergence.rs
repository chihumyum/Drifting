//! Property test on the book document: three devices create chapters, ideas,
//! elements, relations, storyline memberships and idea groups, trash and
//! purge things, move and delete groups, run background repairs and sync in
//! random order. After a full sync every device reads the same book, and
//! everything the readers return satisfies the read-time invariants
//! (`dr_model::invariant`), however the merge broke the stored state. A few
//! repair rounds empty the repair plan everywhere.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};

use dr_doc::book::{BookDoc, BookTxn, Collection};
use dr_model::book::{EntityRef, canonical_symmetric};
use dr_model::id::*;
use dr_model::kind::*;
use dr_model::order::cmp_order;
use dr_model::{Origin, Timestamp};
use proptest::prelude::*;
use proptest::test_runner::{RngAlgorithm, TestRng, TestRunner};

#[derive(Clone, Debug)]
enum Op {
    Chapter {
        peer: usize,
        id: u8,
        order: Option<u8>,
    },
    Drift {
        peer: usize,
        id: u8,
        group: Option<u8>,
    },
    Element {
        peer: usize,
        id: u8,
    },
    Trash {
        peer: usize,
        id: u8,
        on: bool,
    },
    PurgeElement {
        peer: usize,
        id: u8,
    },
    Relation {
        peer: usize,
        rid: u8,
        from: u8,
        to: u8,
        ty: u8,
    },
    Member {
        peer: usize,
        node: u8,
        storyline: u8,
        add: bool,
    },
    Primary {
        peer: usize,
        node: u8,
        storyline: u8,
    },
    GroupCreate {
        peer: usize,
        id: u8,
        parent: Option<u8>,
    },
    GroupMove {
        peer: usize,
        id: u8,
        parent: Option<u8>,
    },
    GroupDelete {
        peer: usize,
        id: u8,
    },
    Repair {
        peer: usize,
    },
    Sync {
        from: usize,
        to: usize,
    },
}

const PEERS: usize = 3;

fn op() -> impl Strategy<Value = Op> {
    let p = 0..PEERS;
    prop_oneof![
        3 => (p.clone(), 0u8..6, prop::option::of(0u8..4)).prop_map(|(peer, id, order)| Op::Chapter { peer, id, order }),
        2 => (p.clone(), 0u8..4, prop::option::of(0u8..3)).prop_map(|(peer, id, group)| Op::Drift { peer, id, group }),
        2 => (p.clone(), 0u8..4).prop_map(|(peer, id)| Op::Element { peer, id }),
        1 => (p.clone(), 0u8..4, any::<bool>()).prop_map(|(peer, id, on)| Op::Trash { peer, id, on }),
        1 => (p.clone(), 0u8..4).prop_map(|(peer, id)| Op::PurgeElement { peer, id }),
        3 => (p.clone(), 0u8..8, 0u8..4, 0u8..4, 0u8..3).prop_map(|(peer, rid, from, to, ty)| Op::Relation { peer, rid, from, to, ty }),
        2 => (p.clone(), 0u8..6, 0u8..2, any::<bool>()).prop_map(|(peer, node, storyline, add)| Op::Member { peer, node, storyline, add }),
        1 => (p.clone(), 0u8..6, 0u8..2).prop_map(|(peer, node, storyline)| Op::Primary { peer, node, storyline }),
        2 => (p.clone(), 0u8..3, prop::option::of(0u8..3)).prop_map(|(peer, id, parent)| Op::GroupCreate { peer, id, parent }),
        2 => (p.clone(), 0u8..3, prop::option::of(0u8..3)).prop_map(|(peer, id, parent)| Op::GroupMove { peer, id, parent }),
        1 => (p.clone(), 0u8..3).prop_map(|(peer, id)| Op::GroupDelete { peer, id }),
        1 => p.clone().prop_map(|peer| Op::Repair { peer }),
        4 => (p.clone(), p).prop_map(|(from, to)| Op::Sync { from, to }),
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

/// Ignore refusals (a move under a missing group, say): the property is
/// about what merges produce, not about which local writes are allowed.
fn try_edit(d: &mut BookDoc, f: impl FnOnce(&mut BookTxn<'_>) -> dr_doc::Result<()>) {
    let _ = d.edit(Origin::User, f);
}

fn node(i: u8) -> NodeId {
    NodeId::parse(&format!("n{i}")).unwrap()
}
fn elem(i: u8) -> ElementId {
    ElementId::parse(&format!("e{i}")).unwrap()
}
fn group(i: u8) -> String {
    format!("g{i}")
}
fn storyline(i: u8) -> StorylineId {
    StorylineId::parse(&format!("s{i}")).unwrap()
}

const FRIEND: &str = "rt-friend";
const RIVAL: &str = "rt-rival";

fn check_views(d: &BookDoc) -> Result<(), TestCaseError> {
    let v = d.view();
    // The cheap check agrees with the full plan.
    prop_assert_eq!(v.needs_repair(), !v.repair_plan().is_empty());
    // Per-endpoint relation reads agree with the whole list.
    for e in 0..4u8 {
        let end = EntityRef::new(EntityKind::Element, elem(e).to_string());
        let want: Vec<_> = v
            .relations()
            .into_iter()
            .filter(|r| r.from == end || r.to == end)
            .collect();
        prop_assert_eq!(v.relations_of(&end), want);
    }
    // Relations shown are whole and unique.
    let mut seen = HashSet::new();
    let live_elements: HashSet<String> = v
        .elements()
        .into_iter()
        .filter(|e| e.deleted_at.is_none())
        .map(|e| e.id.to_string())
        .collect();
    let types: HashMap<String, RelationOrientation> = v
        .relation_types()
        .into_iter()
        .map(|t| (t.id.to_string(), t.orientation))
        .collect();
    for r in v.relations() {
        prop_assert!(live_elements.contains(&r.from.id) && live_elements.contains(&r.to.id));
        prop_assert!(r.from != r.to);
        let o = types.get(r.relation_type.as_str());
        prop_assert!(o.is_some());
        let key = if o == Some(&RelationOrientation::Symmetric) {
            canonical_symmetric(r.from.clone(), r.to.clone())
        } else {
            (r.from.clone(), r.to.clone())
        };
        prop_assert!(
            seen.insert((key, r.relation_type.clone())),
            "semantic duplicate shown"
        );
    }
    // Chapters are live chapters in (order, id) order.
    let chapters = v.chapters();
    for w in chapters.windows(2) {
        prop_assert!(cmp_order((w[0].book_order, &w[0].id), (w[1].book_order, &w[1].id)).is_le());
    }
    prop_assert!(chapters.iter().all(|c| c.is_chapter() && !c.is_trashed()));
    // Groups form a forest; nodes point only at existing groups; chapters at
    // none; the primary storyline is a member.
    let groups = v.drift_groups();
    let mut listed = HashSet::new();
    for g in &groups {
        if let Some(p) = &g.parent {
            prop_assert!(listed.contains(p.as_str()), "parent listed before child");
        }
        prop_assert!(listed.insert(g.id.to_string()), "group listed once");
    }
    for n in v.nodes() {
        if let Some(g) = &n.group {
            prop_assert!(listed.contains(g.as_str()));
            prop_assert!(n.is_drift());
        }
        if let Some(p) = &n.primary_storyline {
            prop_assert!(n.storylines.contains(p));
        }
        if n.is_drift() {
            prop_assert!(n.book_order.is_none());
        }
    }
    Ok(())
}

fn snapshot_of(d: &BookDoc) -> String {
    let v = d.view();
    format!(
        "{:?}\n{:?}\n{:?}\n{:?}\n{:?}\n{:?}",
        v.nodes(),
        v.elements(),
        v.relations(),
        v.drift_groups(),
        v.chapters(),
        v.repair_plan()
    )
}

fn run(ops: &[Op]) -> Result<(), TestCaseError> {
    let book = BookId::parse("prop").unwrap();
    let mut peers: Vec<BookDoc> = (0..PEERS)
        .map(|i| BookDoc::create(book.clone(), 100 + i as u64).unwrap())
        .collect();
    try_edit(&mut peers[0], |t| {
        t.relation_type(&RelationTypeId::parse(FRIEND).unwrap())?
            .name("朋友")?
            .orientation(&RelationOrientation::Symmetric)?
            .source_kinds(&[EntityKind::Element])?
            .target_kinds(&[EntityKind::Element])?;
        t.relation_type(&RelationTypeId::parse(RIVAL).unwrap())?
            .name("对手")?
            .orientation(&RelationOrientation::Directed)?
            .source_kinds(&[EntityKind::Element])?
            .target_kinds(&[EntityKind::Element])?;
        for i in 0..2 {
            t.storyline(&storyline(i))?.name("线")?;
        }
        Ok(())
    });
    full_sync(&mut peers);
    for op in ops {
        match op.clone() {
            Op::Chapter { peer, id, order } => try_edit(&mut peers[peer], |t| {
                t.node(&node(id))?
                    .kind(&NodeKind::Chapter)?
                    .title("章")?
                    .book_order(order.map(|o| o as f64 * 5.0))?;
                Ok(())
            }),
            Op::Drift { peer, id, group: g } => try_edit(&mut peers[peer], |t| {
                let gid = g.map(|g| DriftGroupId::parse(&group(g)).unwrap());
                t.node(&node(10 + id))?
                    .kind(&NodeKind::Drift)?
                    .title("构想")?
                    .group(gid.as_ref())?;
                Ok(())
            }),
            Op::Element { peer, id } => try_edit(&mut peers[peer], |t| {
                t.element(&elem(id))?.name("要素")?;
                Ok(())
            }),
            Op::Trash { peer, id, on } => try_edit(&mut peers[peer], |t| {
                t.element(&elem(id))?
                    .deleted_at(on.then_some(Timestamp(1)))?;
                Ok(())
            }),
            Op::PurgeElement { peer, id } => try_edit(&mut peers[peer], |t| {
                t.purge(Collection::Elements, elem(id).as_str())
            }),
            Op::Relation {
                peer,
                rid,
                from,
                to,
                ty,
            } => try_edit(&mut peers[peer], |t| {
                let a = EntityRef::new(EntityKind::Element, elem(from).to_string());
                let b = EntityRef::new(EntityKind::Element, elem(to).to_string());
                let (ty, (a, b)) = match ty {
                    0 => (FRIEND, canonical_symmetric(a, b)),
                    1 => (FRIEND, (a, b)), // a device that did not canonicalize
                    _ => (RIVAL, (a, b)),
                };
                t.relation(&RelationId::parse(&format!("r{rid}")).unwrap())?
                    .ends(&a, &b)?
                    .relation_type(&RelationTypeId::parse(ty).unwrap())?;
                Ok(())
            }),
            Op::Member {
                peer,
                node: n,
                storyline: s,
                add,
            } => try_edit(&mut peers[peer], |t| {
                let w = t.node(&node(n))?;
                if add {
                    w.add_storyline(&storyline(s))?;
                } else {
                    w.remove_storyline(&storyline(s))?;
                }
                Ok(())
            }),
            Op::Primary {
                peer,
                node: n,
                storyline: s,
            } => try_edit(&mut peers[peer], |t| {
                t.node(&node(n))?.primary_storyline(Some(&storyline(s)))?;
                Ok(())
            }),
            Op::GroupCreate { peer, id, parent } => try_edit(&mut peers[peer], |t| {
                let p = parent.map(group);
                t.drift_groups().create(&group(id), p.as_deref(), "组")
            }),
            Op::GroupMove { peer, id, parent } => try_edit(&mut peers[peer], |t| {
                let p = parent.map(group);
                t.drift_groups().move_to(&group(id), p.as_deref())
            }),
            Op::GroupDelete { peer, id } => try_edit(&mut peers[peer], |t| {
                t.delete_drift_group(&DriftGroupId::parse(&group(id)).unwrap())
            }),
            Op::Repair { peer } => {
                peers[peer].repair().unwrap();
            }
            Op::Sync { from, to } => {
                if from != to {
                    sync(&mut peers, from, to);
                }
            }
        }
    }
    full_sync(&mut peers);
    let s0 = snapshot_of(&peers[0]);
    for p in &peers[1..] {
        prop_assert_eq!(&snapshot_of(p), &s0);
    }
    for p in &peers {
        check_views(p)?;
    }
    if !peers[0].view().repair_plan().is_empty() {
        STATS.needing_repair.fetch_add(1, Relaxed);
    }
    let mut rounds = 0;
    while peers.iter().any(|p| !p.view().repair_plan().is_empty()) {
        rounds += 1;
        prop_assert!(rounds <= 4, "repairs did not settle");
        for p in peers.iter_mut() {
            p.repair().unwrap();
        }
        full_sync(&mut peers);
    }
    STATS.max_rounds.fetch_max(rounds, Relaxed);
    let s0 = snapshot_of(&peers[0]);
    for p in &peers[1..] {
        prop_assert_eq!(&snapshot_of(p), &s0);
    }
    for p in &peers {
        check_views(p)?;
    }
    STATS
        .relations
        .fetch_add(peers[0].view().relations().len(), Relaxed);
    STATS
        .groups
        .fetch_add(peers[0].view().drift_groups().len(), Relaxed);
    Ok(())
}

struct Stats {
    cases: AtomicUsize,
    needing_repair: AtomicUsize,
    max_rounds: AtomicUsize,
    relations: AtomicUsize,
    groups: AtomicUsize,
}

static STATS: Stats = Stats {
    cases: AtomicUsize::new(0),
    needing_repair: AtomicUsize::new(0),
    max_rounds: AtomicUsize::new(0),
    relations: AtomicUsize::new(0),
    groups: AtomicUsize::new(0),
};

#[test]
fn three_peers_read_the_same_book() {
    let cases: u32 = std::env::var("DR_PROP_CASES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(256);
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
        "cases={} cases-needing-repair-after-sync={} max-repair-rounds={} relations-shown={} groups={}",
        STATS.cases.load(Relaxed),
        STATS.needing_repair.load(Relaxed),
        STATS.max_rounds.load(Relaxed),
        STATS.relations.load(Relaxed),
        STATS.groups.load(Relaxed),
    );
    if let Err(e) = result {
        panic!("{e}");
    }
    // The run exercised what it claims to (3000 cases, release: 1725 needed a
    // repair after sync, always one round).
    assert!(
        STATS.needing_repair.load(Relaxed) > 0,
        "no merge ever needed a repair"
    );
    assert!(STATS.relations.load(Relaxed) > 0 && STATS.groups.load(Relaxed) > 0);
    assert!(STATS.max_rounds.load(Relaxed) <= 1);
}
