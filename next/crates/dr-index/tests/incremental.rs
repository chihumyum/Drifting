//! Deriving from Loro diffs gives exactly what reading the whole document
//! gives, whatever the edits: typing, Enter, deletes across paragraphs,
//! headings, styles, entity links, tables and material embeds, undo, a
//! block id copied onto another paragraph (a paste that kept it: the later
//! paragraph reads without an id until the earlier one goes), and a second
//! device's edits merged in (with the block-id repair that follows).

mod common;

use common::StoreDoc;
use dr_doc::prose::{EmbedKind, ProseDoc, ProseTxn};
use dr_index::TextDeriver;
use dr_model::id::{EmbedId, MaterialId};
use dr_model::kind::EntityKind;
use dr_model::pos::PosKey;
use dr_model::prose::{EntityLink, Heading, InlineStyle};
use dr_model::{DocId, Origin};
use dr_store::index::Deriver as _;
use proptest::prelude::*;
use std::sync::atomic::{AtomicU64, Ordering};

const POOL: &[&str] = &[
    "安娜",
    "ab",
    " ",
    "，",
    "卡列尼娜",
    "x\u{2028}y",
    "Hello",
    "。",
];

#[derive(Clone, Debug)]
enum Op {
    Type { at: usize, text: usize },
    Enter { at: usize },
    Paste { at: usize },
    Delete { at: usize, len: usize },
    Heading { at: usize, level: u8 },
    Bold { at: usize, len: usize },
    Link { at: usize, len: usize, target: u8 },
    Unlink { at: usize, len: usize, target: u8 },
    Table { at: usize },
    Cell { table: u8, text: usize },
    Material { at: usize },
    CopyId { from: usize, to: usize },
    Undo,
}

fn op() -> impl Strategy<Value = Op> {
    let at = 0usize..400;
    prop_oneof![
        6 => (at.clone(), 0..POOL.len()).prop_map(|(at, text)| Op::Type { at, text }),
        3 => at.clone().prop_map(|at| Op::Enter { at }),
        1 => at.clone().prop_map(|at| Op::Paste { at }),
        3 => (at.clone(), 1usize..30).prop_map(|(at, len)| Op::Delete { at, len }),
        2 => (at.clone(), 0u8..4).prop_map(|(at, level)| Op::Heading { at, level }),
        1 => (at.clone(), 1usize..8).prop_map(|(at, len)| Op::Bold { at, len }),
        2 => (at.clone(), 1usize..8, 0u8..3).prop_map(|(at, len, target)| Op::Link { at, len, target }),
        1 => (at.clone(), 1usize..8, 0u8..3).prop_map(|(at, len, target)| Op::Unlink { at, len, target }),
        1 => at.clone().prop_map(|at| Op::Table { at }),
        1 => (0u8..2, 0..POOL.len()).prop_map(|(table, text)| Op::Cell { table, text }),
        1 => at.clone().prop_map(|at| Op::Material { at }),
        2 => (at.clone(), at).prop_map(|(from, to)| Op::CopyId { from, to }),
        1 => Just(Op::Undo),
    ]
}

fn link(target: u8) -> EntityLink {
    EntityLink {
        target: format!("e{target}"),
        kind: EntityKind::Element,
        block: None,
        end_block: None,
    }
}

/// Apply one op; ops that do not fit the document are skipped.
fn apply(t: &mut ProseTxn<'_>, op: &Op, tables: &mut u8) {
    let len = t.view().len();
    let pos = |at: usize| at % len;
    let range = |at: usize, n: usize| {
        let start = pos(at);
        start..(start + n).min(len - 1)
    };
    let _ = match op {
        Op::Type { at, text } => t.insert_text(pos(*at), POOL[*text]),
        Op::Enter { at } => t.split(pos(*at)).map(|_| ()),
        Op::Paste { at } => t
            .insert_paragraphs(pos(*at), "粘贴一\n\n粘贴三")
            .map(|_| ()),
        Op::Delete { at, len: n } => t.delete(range(*at, *n)),
        Op::Heading { at, level } => {
            let h = match level {
                1 => Some(Heading::H1),
                2 => Some(Heading::H2),
                3 => Some(Heading::H3),
                _ => None,
            };
            t.set_heading(pos(*at), h)
        }
        Op::Bold { at, len: n } => t.set_style(range(*at, *n), &InlineStyle::Bold),
        Op::Link { at, len: n, target } => t.link_entity(range(*at, *n), &link(*target)),
        Op::Unlink { at, len: n, target } => t.unlink_entity(range(*at, *n), &format!("e{target}")),
        Op::Table { at } => {
            let start = t.view().paragraph_start(pos(*at));
            let id = EmbedId::parse(&format!("t{tables}")).unwrap();
            *tables += 1;
            t.insert_embed(start, &id, &EmbedKind::Table).and_then(|w| {
                w.add_col("c0", &PosKey::first())?;
                w.add_row("r0", &PosKey::first())?;
                w.set_cell("r0", "c0", "格")
            })
        }
        Op::Cell { table, text } => match EmbedId::parse(&format!("t{table}")) {
            Ok(id) => t
                .table(&id)
                .and_then(|w| w.set_cell("r0", "c0", POOL[*text])),
            Err(_) => Ok(()),
        },
        Op::Material { at } => {
            let start = t.view().paragraph_start(pos(*at));
            let id = EmbedId::parse(&format!("m{}", start)).unwrap();
            t.insert_embed(
                start,
                &id,
                &EmbedKind::Material(MaterialId::parse("mat1").unwrap()),
            )
            .map(|_| ())
        }
        Op::CopyId { from, to } => match t.view().paragraph_at(pos(*from)) {
            Ok(p) => t.set_block_id(pos(*to), p.stored_id.as_ref()),
            Err(e) => Err(e),
        },
        Op::Undo => Ok(()),
    };
}

fn sync(from: &ProseDoc, to: &mut ProseDoc) {
    let bytes = from.export_updates_since(&to.version()).unwrap();
    to.import(&bytes, Origin::Sync).unwrap();
}

/// One step: ops on device A (or B), maybe a sync between them, then the
/// store pulls A and derives from the diffs.
type Step = (bool, Vec<Op>, bool);

fn step() -> impl Strategy<Value = Step> {
    (
        proptest::bool::weighted(0.25),
        proptest::collection::vec(op(), 1..5),
        proptest::bool::weighted(0.3),
    )
}

fn run(steps: &[Step]) -> Result<(u64, u64), TestCaseError> {
    let id = DocId::parse("node:n1").unwrap();
    let mut a = ProseDoc::create(id.clone(), 11).unwrap();
    let mut b = ProseDoc::create(id.clone(), 12).unwrap();
    let mut undo = a.undo_manager();
    let (r, _) = a.edit(Origin::User, |t| {
        t.insert_paragraphs(0, "第一段安娜\n第二段 Hello\n第三段")
            .map(|_| ())
    });
    r.unwrap();
    sync(&a, &mut b);
    let store = StoreDoc::new("node:n1", 99);
    store.pull(&a);
    store.take_changes();
    let deriver = TextDeriver::new();
    store.derive(&deriver, None);
    let mut tables = 0u8;
    for (on_b, ops, exchange) in steps {
        for op in ops {
            if matches!(op, Op::Undo) {
                if !on_b {
                    let _ = undo.undo(&mut a);
                }
                continue;
            }
            let doc = if *on_b { &mut b } else { &mut a };
            let (r, _) = doc.edit(Origin::User, |t| {
                apply(t, op, &mut tables);
                Ok(())
            });
            r.unwrap();
        }
        if *exchange {
            sync(&b, &mut a);
            sync(&a, &mut b);
        }
        store.pull(&a);
        let changes = store.take_changes();
        let got = store.derive(&deriver, Some(&changes));
        let want = store.full_read();
        // The editor's live count agrees with the index.
        prop_assert_eq!(store.live_total(), (want.words, want.chars));
        prop_assert_eq!(got, want);
    }
    let s = deriver.stats();
    // Every derivation from diffs sent a patch, every other one everything.
    let (full, patches) = *store.updates.lock().unwrap();
    prop_assert_eq!((full, patches), (s.full, s.incremental));
    Ok((s.incremental, s.fallbacks))
}

proptest! {
    #![proptest_config(ProptestConfig {
        cases: std::env::var("DR_PROP_CASES").ok().and_then(|v| v.parse().ok()).unwrap_or(200),
        ..ProptestConfig::default()
    })]

    #[test]
    fn diffs_give_what_a_full_read_gives(steps in proptest::collection::vec(step(), 1..12)) {
        let (incremental, fallbacks) = run(&steps)?;
        let i = INCREMENTAL.fetch_add(incremental, Ordering::Relaxed) + incremental;
        let f = FALLBACKS.fetch_add(fallbacks, Ordering::Relaxed) + fallbacks;
        let c = CASES.fetch_add(1, Ordering::Relaxed) + 1;
        if std::env::var_os("DR_PROP_REPORT").is_some() {
            eprintln!("cases {c}: {i} derivations from diffs, {f} fell back to a full read");
        }
    }
}

static CASES: AtomicU64 = AtomicU64::new(0);
static INCREMENTAL: AtomicU64 = AtomicU64::new(0);
static FALLBACKS: AtomicU64 = AtomicU64::new(0);

/// The property above would pass if every derivation fell back to a full
/// read; make sure ordinary edits take the incremental path.
#[test]
fn ordinary_edits_use_the_diffs() {
    let steps: Vec<Step> = (0..20)
        .map(|i| {
            (
                false,
                vec![
                    Op::Type {
                        at: i * 7,
                        text: i % POOL.len(),
                    },
                    if i % 5 == 0 {
                        Op::Enter { at: i * 3 }
                    } else {
                        Op::Bold { at: i, len: 2 }
                    },
                ],
                false,
            )
        })
        .collect();
    let (incremental, fallbacks) = run(&steps).unwrap();
    assert_eq!((incremental, fallbacks), (20, 0));
}

/// One keystroke: a patch of one row; an Enter: one row becomes two.
#[test]
fn a_keystroke_patches_one_row() {
    let id = DocId::parse("node:n1").unwrap();
    let mut a = ProseDoc::create(id, 11).unwrap();
    let (r, _) = a.edit(Origin::User, |t| {
        t.insert_paragraphs(0, "第一段\n第二段\n第三段\n第四段")
            .map(|_| ())
    });
    r.unwrap();
    let store = StoreDoc::new("node:n1", 99);
    store.pull(&a);
    store.take_changes();
    let deriver = TextDeriver::new();
    store.derive(&deriver, None);
    let input = |store: &StoreDoc, changes: &[dr_store::ContainerChange]| {
        let i = dr_store::index::DeriveInput {
            doc_id: "node:n1",
            kind: "node",
            book_id: Some("b1"),
            doc: &store.doc,
            changes: Some(changes),
            held: true,
        };
        match deriver.derive(&i) {
            Some(dr_store::index::DerivedUpdate::Patch(p)) => p,
            other => panic!("not a patch: {other:?}"),
        }
    };
    let (r, _) = a.edit(Origin::User, |t| t.insert_text(5, "字"));
    r.unwrap();
    store.pull(&a);
    let p = input(&store, &store.take_changes());
    assert_eq!(p.base_paragraphs, 4);
    assert_eq!(p.splices.len(), 1);
    assert_eq!((p.splices[0].at, p.splices[0].removed), (1, 1));
    assert_eq!(p.splices[0].blocks[0].text, "第字二段");
    assert_eq!(p.references, None);
    let (r, _) = a.edit(Origin::User, |t| t.split(10).map(|_| ()));
    r.unwrap();
    store.pull(&a);
    let p = input(&store, &store.take_changes());
    assert_eq!(p.base_paragraphs, 4);
    assert_eq!(p.splices.len(), 1);
    let s = &p.splices[0];
    assert_eq!((s.at, s.removed, s.blocks.len()), (2, 1, 2));
    assert_eq!(p.paragraphs(), 5);
}

#[test]
fn a_cache_entry_is_only_used_for_its_own_document() {
    let id = DocId::parse("node:n1").unwrap();
    let mut a = ProseDoc::create(id, 11).unwrap();
    let (r, _) = a.edit(Origin::User, |t| t.insert_text(0, "原文"));
    r.unwrap();
    let deriver = TextDeriver::new();
    // The holder's document (device peer 99), then a copy for a background
    // rebuild and a holder of another library sharing the deriver (another
    // peer), of the same document id.
    let holder = StoreDoc::new("node:n1", 99);
    holder.pull(&a);
    holder.take_changes();
    holder.derive(&deriver, None);
    let (r, _) = a.edit(Origin::User, |t| t.insert_text(0, "新"));
    r.unwrap();
    let copy = StoreDoc::copy("node:n1", 1234);
    copy.pull(&a);
    copy.derive(&deriver, None);
    let other = StoreDoc::new("node:n1", 4321);
    other.pull(&a);
    other.take_changes();
    other.derive(&deriver, None);
    // The holder's diffs apply to what the holder derived, not the others.
    holder.pull(&a);
    let changes = holder.take_changes();
    let got = holder.derive(&deriver, Some(&changes));
    assert_eq!(got.blocks[0].text, "新原文");
    assert_eq!(deriver.stats().incremental, 1);
}
