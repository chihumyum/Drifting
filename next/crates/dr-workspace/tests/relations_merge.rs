//! What a merge of two devices' relation writes reads as, and how the next
//! write cleans it (RD review, 2026-11-17): the same pair in two rows, two
//! relations with one normalized name, a row left with an empty side, a
//! member whose entry was purged on the other device.

mod common;
use common::*;
use dr_doc::v3::BorrowedBookV3;
use dr_model::id::{BookId, EntryId};
use dr_workspace::{Actor, Workspace};
use serde_json::{Value, json};

struct Devices {
    one: Env,
    two: Env,
    book: String,
    e: Vec<String>,
}

impl Devices {
    /// A book with six synthetic entries on both devices.
    fn new() -> Self {
        let one = env();
        let two = env();
        let book = one.book();
        let e = ["阿林", "小竹", "石桥", "老钟", "青鸟", "白鹭"]
            .map(|title| {
                acceptance::novel_entry(one.ws(), &book, "tpl-character", title, None)["id"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .to_vec();
        sync_docs(one.ws(), two.ws());
        Self { one, two, book, e }
    }

    fn relation(&self, on: &Env, name: &str, direction: &str) -> Value {
        on.out(
            "relation_type.create",
            json!({"book":self.book,"name":name,"direction":direction}),
        )["id"]
            .clone()
    }

    fn pair(&self, on: &Env, kind: &Value, left: usize, right: usize) -> Value {
        on.out(
            "relation_row.create_pair",
            json!({"book":self.book,"relation_type":kind,"left":self.e[left],"right":self.e[right]}),
        )
    }

    fn sync(&self) {
        sync_docs(self.one.ws(), self.two.ws());
        sync_docs(self.two.ws(), self.one.ws());
    }

    fn list(&self, on: &Env) -> Value {
        on.out("relation_type.list", json!({"book":self.book}))
    }

    fn raw(&self, on: &Env) -> Value {
        on.ws()
            .observe(&format!("book:{}", self.book))
            .unwrap()
            .value
    }

    fn converged(&self) -> Value {
        assert_eq!(
            self.raw(&self.one),
            self.raw(&self.two),
            "the devices converge"
        );
        let list = self.list(&self.one);
        assert_eq!(list, self.list(&self.two));
        list
    }
}

fn count(value: &Value) -> usize {
    value.as_object().map_or(0, |m| m.len())
}

/// Two devices open a row for the same pair at once: both rows are listed,
/// the pair counts once, and taking it out of one row takes it out of both;
/// the undo puts it back into both.
#[test]
fn the_same_pair_in_two_rows_reads_once_and_leaves_both_rows_together() {
    let d = Devices::new();
    let kind = d.relation(&d.one, "Allies", "directed");
    d.pair(&d.one, &kind, 2, 3);
    sync_docs(d.one.ws(), d.two.ws());
    d.pair(&d.one, &kind, 0, 1);
    d.pair(&d.two, &kind, 0, 1);
    d.sync();
    let list = d.converged();
    assert_eq!(count(&d.raw(&d.one)["relations"]), 3);
    assert_eq!(list[0]["pair_count"], 2);
    let twice: Vec<&Value> = list[0]["rows"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["left"] == json!([d.e[0]]) && row["right"] == json!([d.e[1]]))
        .collect();
    assert_eq!(twice.len(), 2, "both rows are listed");
    let shown = twice[1]["id"].clone();
    d.one.call(
        "relation_row.remove_entry",
        json!({"book":d.book,"id":shown,"entry":d.e[1]}),
    );
    let after = d.list(&d.one);
    assert_eq!(after[0]["pair_count"], 1);
    assert_eq!(after[0]["rows"][0]["left"], json!([d.e[2]]));
    assert!(after[0].get("hidden_rows").is_none());
    assert_eq!(
        count(&d.raw(&d.one)["relations"]),
        1,
        "no row keeps the pair"
    );
    d.one.ws().undo(&Actor::User).unwrap().expect("one step");
    assert_eq!(d.list(&d.one), list);
}

/// Two devices each create a relation with the same normalized name: they
/// read as one, the earliest, with both rows; renaming and deleting it take
/// both definitions along, and its undo brings both back.
#[test]
fn two_relations_with_one_name_read_as_the_earliest_and_move_together() {
    let d = Devices::new();
    let first = d.relation(&d.one, "盟友", "directed");
    d.pair(&d.one, &first, 0, 1);
    let second = d.relation(&d.two, " 盟友 ", "symmetric");
    d.pair(&d.two, &second, 2, 3);
    d.sync();
    let list = d.converged();
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["pair_count"], 2);
    assert_eq!(count(&d.raw(&d.one)["relation_types"]), 2);
    let shown = list[0]["id"].clone();
    assert!(shown == first || shown == second);
    // Either id is the shown relation; a write through it plans against both.
    let other = if shown == first { &second } else { &first };
    let placed = d.pair(&d.one, other, 0, 4);
    assert_eq!(placed["relation_type"], shown);
    d.one.call(
        "relation_type.rename",
        json!({"book":d.book,"id":shown,"name":"同盟"}),
    );
    let raw = d.raw(&d.one);
    for definition in raw["relation_types"].as_object().unwrap().values() {
        assert_eq!(definition["name"], "同盟");
    }
    assert_eq!(d.list(&d.one).as_array().unwrap().len(), 1);
    assert!(
        d.one
            .try_call("relation_type.create", json!({"book":d.book,"name":"同盟"}))
            .is_err()
    );
    let before = d.list(&d.one);
    d.one
        .call("relation_type.delete", json!({"book":d.book,"id":shown}));
    assert_eq!(d.list(&d.one), json!([]));
    let raw = d.raw(&d.one);
    assert_eq!(count(&raw["relation_types"]), 0);
    assert_eq!(count(&raw["relations"]), 0);
    d.one.ws().undo(&Actor::User).unwrap().expect("one step");
    assert_eq!(d.list(&d.one), before);
    assert_eq!(count(&d.raw(&d.one)["relation_types"]), 2);
}

/// Two devices each take the last-but-one entry off the same side: the row
/// is left with an empty side, is not shown, does not count as a row, and
/// goes with the next write.
#[test]
fn a_row_two_removals_emptied_does_not_count_and_is_cleaned() {
    let d = Devices::new();
    let kind = d.relation(&d.one, "Allies", "directed");
    let row = d.pair(&d.one, &kind, 0, 1)["id"].clone();
    d.pair(&d.one, &kind, 0, 2);
    let other = d.pair(&d.one, &kind, 3, 4)["id"].clone();
    sync_docs(d.one.ws(), d.two.ws());
    d.one.call(
        "relation_row.remove_entry",
        json!({"book":d.book,"id":row,"entry":d.e[1]}),
    );
    d.two.call(
        "relation_row.remove_entry",
        json!({"book":d.book,"id":row,"entry":d.e[2]}),
    );
    d.sync();
    let list = d.converged();
    assert_eq!(list[0]["rows"].as_array().unwrap().len(), 1);
    assert_eq!(list[0]["hidden_rows"], json!([row]));
    assert_eq!(list[0]["pair_count"], 1);
    // The other row is the last one that counts: deleting it deletes the
    // relation, and the emptied row goes too.
    d.one
        .call("relation_row.delete", json!({"book":d.book,"id":other}));
    assert_eq!(d.list(&d.one), json!([]));
    let raw = d.raw(&d.one);
    assert_eq!(count(&raw["relation_types"]), 0);
    assert_eq!(count(&raw["relations"]), 0);
    d.one.ws().undo(&Actor::User).unwrap().expect("one step");
    let back = d.list(&d.one);
    assert_eq!(back[0]["rows"].as_array().unwrap().len(), 1);
    assert_eq!(back[0]["rows"][0]["id"], other);
}

/// One device purges an entry while the other relates it: the member reads
/// as not there, its row does not count, and the next write takes it out.
#[test]
fn a_member_purged_on_the_other_device_reads_gone_and_is_cleaned() {
    let d = Devices::new();
    let kind = d.relation(&d.one, "Allies", "directed");
    let other = d.pair(&d.one, &kind, 3, 4)["id"].clone();
    let kept = d.pair(&d.one, &kind, 1, 5)["id"].clone();
    sync_docs(d.one.ws(), d.two.ws());
    purge(d.one.ws(), &d.book, &d.e[2]);
    let row = d.pair(&d.two, &kind, 0, 2)["id"].clone();
    d.two.call(
        "relation_row.add_entry",
        json!({"book":d.book,"id":kept,"side":"right","entry":d.e[2]}),
    );
    d.sync();
    let list = d.converged();
    assert_eq!(list[0]["hidden_rows"], json!([row]));
    assert_eq!(list[0]["pair_count"], 2);
    assert!(
        d.raw(&d.one)["relations"][kept.as_str().unwrap()]["members"][&d.e[2]].is_string(),
        "the purged member is still stored"
    );
    // The next relation write cleans both: the purged member and the row
    // it alone kept.
    d.one
        .call("relation_row.delete", json!({"book":d.book,"id":other}));
    let raw = d.raw(&d.one);
    assert!(raw["relations"][row.as_str().unwrap()].is_null());
    assert!(raw["relations"][kept.as_str().unwrap()]["members"][&d.e[2]].is_null());
    let list = d.list(&d.one);
    assert_eq!(list[0]["pair_count"], 1);
    // Deleting the last row that counts deletes the relation.
    d.one
        .call("relation_row.delete", json!({"book":d.book,"id":kept}));
    assert_eq!(d.list(&d.one), json!([]));
}

/// Only the entries in Recently Deleted are left on one side of a row:
/// the row is not shown but counts, so taking the last shown entry off the
/// other side keeps the relation, and restoring brings the row back
/// (kernel-v5 「替作者定的」).
#[test]
fn a_row_whose_side_is_all_in_recently_deleted_keeps_counting() {
    let d = Devices::new();
    let kind = d.relation(&d.one, "Allies", "directed");
    let row = d.pair(&d.one, &kind, 0, 1)["id"].clone();
    d.pair(&d.one, &kind, 0, 2);
    d.one
        .call("entry.trash", json!({"book":d.book,"id":d.e[2]}));
    d.one.call(
        "relation_row.remove_entry",
        json!({"book":d.book,"id":row,"entry":d.e[1]}),
    );
    let list = d.list(&d.one);
    assert_eq!(list[0]["id"], kind);
    assert_eq!(list[0]["rows"], json!([]));
    assert_eq!(list[0]["hidden_rows"], json!([row]));
    d.one
        .call("entry.restore", json!({"book":d.book,"id":d.e[2]}));
    assert_eq!(d.list(&d.one)[0]["rows"][0]["right"], json!([d.e[2]]));
}

fn purge(ws: &Workspace, book: &str, entry: &str) {
    let (book, entry) = (BookId::parse(book).unwrap(), EntryId::parse(entry).unwrap());
    ws.library()
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
}

/// Every stored document of `from`, the book first, imported into `to` as
/// another device's sync would.
fn sync_docs(from: &Workspace, to: &Workspace) {
    let mut docs = from.library().docs(None, None).unwrap();
    docs.sort_by_key(|d| (d.kind != "book", d.doc_id.clone()));
    for d in docs {
        if from.library().head(&d.doc_id).unwrap().is_none() {
            continue;
        }
        let bytes = from
            .library()
            .load_copy(&d.doc_id)
            .unwrap()
            .export(loro::ExportMode::all_updates())
            .unwrap();
        to.import_remote(
            &d.doc_id,
            Some((&d.kind, d.book_id.as_deref().unwrap_or(""))),
            bytes,
            &Actor::Sync,
        )
        .unwrap();
    }
}
