//! RL's explicit draft row is one write, with no unselected pairs.
mod common;
use common::*;
use dr_doc::v3::BorrowedBookV3;
use dr_model::id::{BookId, EntryId};
use dr_workspace::{Actor, Workspace, WsError};
use serde_json::{Value, json};
use std::collections::BTreeSet;

struct Fixture {
    env: Env,
    book: String,
    entries: Vec<String>,
    kind: String,
    direction: &'static str,
}

impl Fixture {
    fn new(direction: &'static str) -> Self {
        let env = env();
        let book = env.book();
        let entries = ["阿林", "小竹", "石桥", "老钟", "青鸟", "白鹭"]
            .map(|title| {
                acceptance::novel_entry(env.ws(), &book, "tpl-character", title, None)["id"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .to_vec();
        let kind = env.out(
            "relation_type.create",
            json!({"book":book,"name":"Allies","direction":direction}),
        )["id"]
            .as_str()
            .unwrap()
            .to_owned();
        Self {
            env,
            book,
            entries,
            kind,
            direction,
        }
    }

    fn input(&self, left: &[usize], right: &[usize]) -> Value {
        json!({"book":self.book,"relation_type":self.kind,
            "expected_direction":self.direction,
            "left":left.iter().map(|i| &self.entries[*i]).collect::<Vec<_>>(),
            "right":right.iter().map(|i| &self.entries[*i]).collect::<Vec<_>>()})
    }

    fn group(&self, left: &[usize], right: &[usize]) -> Value {
        self.env
            .call("relation_row.create_group", self.input(left, right))
    }

    fn pair(&self, left: usize, right: usize) -> Value {
        self.env.out(
            "relation_row.create_pair",
            json!({"book":self.book,
            "relation_type":self.kind,"left":self.entries[left],"right":self.entries[right]}),
        )
    }

    fn list(&self) -> Value {
        self.env
            .out("relation_type.list", json!({"book":self.book}))
    }

    fn head(&self) -> String {
        self.env
            .ws()
            .observe(&format!("book:{}", self.book))
            .unwrap()
            .version
    }

    fn pairs(&self) -> BTreeSet<(usize, usize)> {
        let mut pairs = BTreeSet::new();
        for kind in self.list().as_array().unwrap() {
            for row in kind["rows"].as_array().unwrap() {
                for left in row["left"].as_array().unwrap() {
                    for right in row["right"].as_array().unwrap() {
                        let l = self.entries.iter().position(|id| id == left).unwrap();
                        let r = self.entries.iter().position(|id| id == right).unwrap();
                        pairs.insert((l, r));
                    }
                }
            }
        }
        pairs
    }

    fn refused(&self, input: Value) {
        let before = self.head();
        assert!(
            self.env
                .try_call("relation_row.create_group", input)
                .is_err()
        );
        assert_eq!(self.head(), before, "a refused group must write no subset");
    }
}

#[test]
fn exact_sets_have_one_undo_step_separate_from_the_cards_creation() {
    let f = Fixture::new("directed");
    let made = f.group(&[0, 1, 0], &[2, 3, 2]);
    assert!(made["journal"].is_number());
    assert_eq!(made["undo"].as_array().unwrap().len(), 1);
    assert_eq!(f.pairs(), BTreeSet::from([(0, 2), (0, 3), (1, 2), (1, 3)]));
    f.env
        .ws()
        .undo(&Actor::User)
        .unwrap()
        .expect("the entire group");
    assert!(f.pairs().is_empty());
    assert_eq!(
        f.list().as_array().unwrap().len(),
        1,
        "the preexisting card stays"
    );
    f.env
        .ws()
        .undo(&Actor::User)
        .unwrap()
        .expect("the preceding card creation");
    assert!(f.list().as_array().unwrap().is_empty());
    f.env.ws().redo(&Actor::User).unwrap().expect("card redo");
    f.env.ws().redo(&Actor::User).unwrap().expect("group redo");
    assert_eq!(f.pairs(), BTreeSet::from([(0, 2), (0, 3), (1, 2), (1, 3)]));
}

#[test]
fn a_draft_keeps_its_sides_instead_of_fitting_its_first_pair_into_another_row() {
    for direction in ["directed", "symmetric"] {
        let f = Fixture::new(direction);
        let old = f.pair(0, 1);
        let made = f.group(&[2, 3], &[0]);
        assert_ne!(made["output"]["id"], old["id"]);
        assert_eq!(f.list()[0]["rows"].as_array().unwrap().len(), 2);
        assert_eq!(f.pairs(), BTreeSet::from([(0, 1), (2, 0), (3, 0)]));
    }
}

#[test]
fn any_overlapping_pair_refuses_the_whole_draft_in_both_directions() {
    for direction in ["directed", "symmetric"] {
        let f = Fixture::new(direction);
        f.pair(0, 1);
        f.pair(0, 2);
        f.refused(f.input(&[0, 3], &[1]));
        if direction == "symmetric" {
            f.refused(f.input(&[1, 3], &[0]));
        }
        assert_eq!(f.pairs(), BTreeSet::from([(0, 1), (0, 2)]));
    }
}

#[test]
fn invalid_or_no_longer_live_members_never_publish_a_partial_group() {
    let f = Fixture::new("directed");
    for (left, right) in [
        (&[][..], &[1][..]),
        (&[0][..], &[][..]),
        (&[0, 1][..], &[1][..]),
    ] {
        f.refused(f.input(left, right));
    }
    let other = f.env.book();
    let foreign =
        acceptance::novel_entry(f.env.ws(), &other, "tpl-character", "白鹭", None)["id"].clone();
    let mut input = f.input(&[0, 1], &[2]);
    input["left"].as_array_mut().unwrap().push(foreign);
    f.refused(input);
    f.env
        .call("entry.trash", json!({"book":f.book,"id":f.entries[1]}));
    f.refused(f.input(&[0, 1], &[2]));
    let (book, entry) = (
        BookId::parse(&f.book).unwrap(),
        EntryId::parse(&f.entries[1]).unwrap(),
    );
    f.env
        .ws()
        .library()
        .open_doc(&format!("book:{book}"), dr_store::OpenDoc::Existing)
        .unwrap()
        .write(dr_store::Origin::User, move |doc| {
            BorrowedBookV3::new(doc, &book)
                .unwrap()
                .txn()
                .entries()
                .purge_subtree(&entry)
                .unwrap();
        })
        .unwrap();
    f.refused(f.input(&[0, 1], &[2]));
    assert!(f.pairs().is_empty());
}

#[test]
fn stale_direction_or_a_same_name_merge_winner_refuses_the_draft() {
    let mut f = Fixture::new("directed");
    f.env.call(
        "relation_type.set_direction",
        json!({"book":f.book,"id":f.kind,"direction":"symmetric"}),
    );
    let before = f.head();
    assert!(matches!(
        f.env
            .try_call("relation_row.create_group", f.input(&[0], &[1])),
        Err(WsError::Conflict(_))
    ));
    assert_eq!(f.head(), before);

    f.env
        .call("relation_type.delete", json!({"book":f.book,"id":f.kind}));
    let two = env();
    sync_docs(f.env.ws(), two.ws());
    let one_kind = f.env.out(
        "relation_type.create",
        json!({"book":f.book,"name":"Allies","direction":"directed"}),
    )["id"]
        .clone();
    let two_kind = two.out(
        "relation_type.create",
        json!({"book":f.book,"name":"Allies","direction":"directed"}),
    )["id"]
        .clone();
    sync_docs(two.ws(), f.env.ws());
    let winner = f.list()[0]["id"].clone();
    f.kind = if winner == one_kind {
        two_kind
    } else {
        one_kind
    }
    .as_str()
    .unwrap()
    .to_owned();
    let before = f.head();
    assert!(matches!(
        f.env
            .try_call("relation_row.create_group", f.input(&[0], &[1])),
        Err(WsError::Conflict(_))
    ));
    assert_eq!(f.head(), before);
}

#[test]
fn a_pair_arriving_from_another_device_is_checked_before_the_group_is_written() {
    let f = Fixture::new("directed");
    let two = env();
    sync_docs(f.env.ws(), two.ws());
    let draft = f.input(&[0, 1], &[2, 3]);
    two.call(
        "relation_row.create_pair",
        json!({"book":f.book,"relation_type":f.kind,
        "left":f.entries[1],"right":f.entries[3]}),
    );
    sync_docs(two.ws(), f.env.ws());
    f.refused(draft);
    assert_eq!(f.pairs(), BTreeSet::from([(1, 3)]));
}

#[test]
fn competing_group_submissions_write_the_selected_pairs_only_once() {
    let f = Fixture::new("directed");
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let jobs: Vec<_> = (0..2)
        .map(|_| {
            let (ws, input, barrier) =
                (f.env.ws().clone(), f.input(&[0, 1], &[2]), barrier.clone());
            std::thread::spawn(move || {
                barrier.wait();
                ws.call(&Actor::User, "relation_row.create_group", input)
            })
        })
        .collect();
    let results: Vec<_> = jobs.into_iter().map(|job| job.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(f.list()[0]["rows"].as_array().unwrap().len(), 1);
    assert_eq!(f.pairs(), BTreeSet::from([(0, 2), (1, 2)]));
}

#[test]
fn group_undo_and_redo_keep_a_remote_members_pairs_and_description() {
    let f = Fixture::new("directed");
    let made = f.group(&[0, 1], &[2]);
    let two = env();
    sync_docs(f.env.ws(), two.ws());
    two.call(
        "relation_row.add_entry",
        json!({"book":f.book,"id":made["output"]["id"],"side":"right","entry":f.entries[3]}),
    );
    two.call(
        "relation_type.set_description",
        json!({"book":f.book,"id":f.kind,"description":"另一个设备的说明"}),
    );
    sync_docs(two.ws(), f.env.ws());
    f.env
        .ws()
        .undo(&Actor::User)
        .unwrap()
        .expect("one group undo");
    assert_eq!(f.pairs(), BTreeSet::from([(0, 3), (1, 3)]));
    assert_eq!(f.list()[0]["description"]["text"], "另一个设备的说明");
    sync_docs(f.env.ws(), two.ws());
    assert_eq!(
        two.out("relation_type.list", json!({"book":f.book})),
        f.list()
    );
    f.env
        .ws()
        .redo(&Actor::User)
        .unwrap()
        .expect("one group redo");
    assert_eq!(f.pairs(), BTreeSet::from([(0, 2), (0, 3), (1, 2), (1, 3)]));
    assert_eq!(f.list()[0]["description"]["text"], "另一个设备的说明");
}

#[test]
fn undo_refuses_an_inseparable_later_grid_instead_of_deleting_others_pairs() {
    let f = Fixture::new("directed");
    let made = f.group(&[0, 1], &[2, 3]);
    let agent = Actor::agent("rl-group", 1, "relations");
    for (side, entry) in [("left", 4), ("right", 5)] {
        call(
            f.env.ws(),
            &agent,
            "relation_row.add_entry",
            json!({"book":f.book,
            "id":made["output"]["id"],"side":side,"entry":f.entries[entry]}),
        );
    }
    let before = f.head();
    assert!(matches!(
        f.env.ws().undo(&Actor::User),
        Err(WsError::Conflict(_))
    ));
    assert_eq!(f.head(), before);
    assert_eq!(f.pairs().len(), 9);
}

#[test]
fn a_failure_before_the_book_commit_leaves_no_group() {
    let f = Fixture::new("directed");
    f.env.faults.arm("after_prose");
    let before = f.head();
    assert!(matches!(
        f.env
            .try_call("relation_row.create_group", f.input(&[0, 1], &[2])),
        Err(WsError::Fault("after_prose"))
    ));
    assert_eq!(f.head(), before);
    assert!(f.pairs().is_empty());
}

// Use the same remote import boundary as the standing relation-merge tests.
fn sync_docs(from: &Workspace, to: &Workspace) {
    let mut docs = from.library().docs(None, None).unwrap();
    docs.sort_by_key(|doc| (doc.kind != "book", doc.doc_id.clone()));
    for doc in docs {
        if from.library().head(&doc.doc_id).unwrap().is_none() {
            continue;
        }
        let bytes = from
            .library()
            .load_copy(&doc.doc_id)
            .unwrap()
            .export(loro::ExportMode::all_updates())
            .unwrap();
        to.import_remote(
            &doc.doc_id,
            Some((&doc.kind, doc.book_id.as_deref().unwrap_or(""))),
            bytes,
            &Actor::Sync,
        )
        .unwrap();
    }
}
