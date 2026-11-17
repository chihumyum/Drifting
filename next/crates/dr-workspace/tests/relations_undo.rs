//! The undo of every relation command, and of a comment's text, takes back
//! only what that command wrote: members, rows, names, descriptions and
//! comment states others wrote since stay, and a value someone else changed
//! since refuses the step (RD review, 2026-11-17).

mod common;
use common::*;
use dr_workspace::{Actor, WsError};
use serde_json::{Value, json};

struct Book {
    env: Env,
    book: String,
    e: Vec<String>,
    kind: Value,
}

impl Book {
    fn new() -> Self {
        let env = env();
        let book = env.book();
        let e = ["阿林", "小竹", "石桥", "老钟", "青鸟", "白鹭"]
            .map(|title| {
                acceptance::novel_entry(env.ws(), &book, "tpl-character", title, None)["id"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .to_vec();
        let kind = env.out(
            "relation_type.create",
            json!({"book":book,"name":"Allies","description":"同路","direction":"directed"}),
        )["id"]
            .clone();
        Self { env, book, e, kind }
    }

    fn agent() -> Actor {
        Actor::agent("rd-review", 1, "relation")
    }

    fn as_agent(&self, name: &str, input: Value) -> Value {
        call(self.env.ws(), &Self::agent(), name, input)["output"].clone()
    }

    fn pair(&self, actor: &Actor, left: usize, right: usize) -> Value {
        call(
            self.env.ws(),
            actor,
            "relation_row.create_pair",
            json!({"book":self.book,"relation_type":self.kind,"left":self.e[left],"right":self.e[right]}),
        )["output"]
            .clone()
    }

    fn list(&self) -> Value {
        self.env
            .out("relation_type.list", json!({"book":self.book}))
    }

    /// Each shown row as `(left, right)` entry indexes, sorted.
    fn rows(&self) -> Vec<(Vec<usize>, Vec<usize>)> {
        let index = |ids: &Value| -> Vec<usize> {
            ids.as_array()
                .unwrap()
                .iter()
                .map(|id| self.e.iter().position(|e| e == id).unwrap())
                .collect()
        };
        sorted(
            self.list()
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|relation| relation["rows"].as_array().unwrap().clone())
                .map(|row| (index(&row["left"]), index(&row["right"])))
                .collect(),
        )
    }

    fn raw(&self) -> Value {
        self.env
            .ws()
            .observe(&format!("book:{}", self.book))
            .unwrap()
            .value
    }

    fn relation(&self) -> Value {
        self.list()
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == self.kind)
            .cloned()
            .unwrap_or(Value::Null)
    }

    fn undo(&self) -> dr_workspace::Result<()> {
        self.env.ws().undo(&Actor::User).map(|done| {
            done.expect("an undo step");
        })
    }

    fn redo(&self) {
        self.env
            .ws()
            .redo(&Actor::User)
            .unwrap()
            .expect("a redo step");
    }
}

fn sorted(mut rows: Vec<(Vec<usize>, Vec<usize>)>) -> Vec<(Vec<usize>, Vec<usize>)> {
    for (l, r) in &mut rows {
        l.sort();
        r.sort();
    }
    rows.sort();
    rows
}

fn conflict(result: dr_workspace::Result<()>) {
    assert!(
        matches!(result, Err(WsError::Conflict(_))),
        "expected a conflict: {result:?}"
    );
}

/// The review's scenario: the author opens a row with A–B, the Agent's A–C
/// lands in the same row, the author's ⌘Z takes out only A–B.
#[test]
fn undoing_a_pair_keeps_the_pair_the_agent_put_into_the_same_row() {
    let f = Book::new();
    let row = f.pair(&Actor::User, 0, 1);
    let agent = f.pair(&Book::agent(), 0, 2);
    assert_eq!(agent["id"], row["id"], "the Agent's pair lands in the row");
    assert_eq!(f.rows(), vec![(vec![0], vec![1, 2])]);
    f.undo().unwrap();
    assert_eq!(f.rows(), vec![(vec![0], vec![2])]);
    assert_eq!(f.relation()["rows"][0]["id"], row["id"]);
    f.redo();
    assert_eq!(f.rows(), vec![(vec![0], vec![1, 2])]);
    // The Agent's own undo takes out its pair and leaves the author's.
    f.env
        .ws()
        .undo(&Book::agent())
        .unwrap()
        .expect("the Agent's step");
    assert_eq!(f.rows(), vec![(vec![0], vec![1])]);
}

/// Taking an entry out of a row comes back on undo with the pairs others
/// added since; adding one goes on undo only while its pairs can go alone.
#[test]
fn undoing_row_edits_keeps_later_members_and_refuses_what_cannot_go_alone() {
    let f = Book::new();
    let row = f.pair(&Actor::User, 0, 1);
    f.pair(&Actor::User, 0, 2);
    f.env.call(
        "relation_row.remove_entry",
        json!({"book":f.book,"id":row["id"],"entry":f.e[1]}),
    );
    f.as_agent(
        "relation_row.add_entry",
        json!({"book":f.book,"id":row["id"],"side":"right","entry":f.e[3]}),
    );
    f.undo().unwrap();
    assert_eq!(f.rows(), vec![(vec![0], vec![1, 2, 3])]);

    // A–E added by the author; the Agent then puts F on the left, so taking
    // E out would take F–E with it: refused, nothing written.
    f.env.call(
        "relation_row.add_entry",
        json!({"book":f.book,"id":row["id"],"side":"right","entry":f.e[4]}),
    );
    f.as_agent(
        "relation_row.add_entry",
        json!({"book":f.book,"id":row["id"],"side":"left","entry":f.e[5]}),
    );
    let before = f.list();
    conflict(f.undo());
    assert_eq!(f.list(), before);
}

/// A relation made with its first pair goes with that pair's undo only
/// while nobody else's row is in it.
#[test]
fn undoing_a_pair_with_a_new_relation_keeps_the_relation_others_put_rows_in() {
    let f = Book::new();
    let placed = f.env.out(
        "relation_row.create_pair",
        json!({"book":f.book,"left":f.e[0],"right":f.e[1],"new_type":{"name":"家人","direction":"symmetric"}}),
    );
    let family = placed["relation_type"].clone();
    f.as_agent(
        "relation_row.create_pair",
        json!({"book":f.book,"relation_type":family,"left":f.e[2],"right":f.e[3]}),
    );
    f.undo().unwrap();
    let list = f.list();
    let kept = list
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == family)
        .expect("the relation stays");
    assert_eq!(kept["pair_count"], 1);
    assert_eq!(kept["rows"][0]["left"], json!([f.e[2]]));
    f.redo();
    assert_eq!(
        f.list()
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == family)
            .unwrap()["pair_count"],
        2
    );
}

/// A rename's undo brings the old name back and leaves a later description;
/// a description someone else overwrote refuses its undo.
#[test]
fn undoing_definition_edits_keeps_later_values_and_refuses_overwritten_ones() {
    let f = Book::new();
    f.env.call(
        "relation_type.rename",
        json!({"book":f.book,"id":f.kind,"name":"Friends"}),
    );
    f.as_agent(
        "relation_type.set_description",
        json!({"book":f.book,"id":f.kind,"description":"Agent 写的说明"}),
    );
    f.undo().unwrap();
    let relation = f.relation();
    assert_eq!(relation["name"], "Allies");
    assert_eq!(relation["description"]["text"], "Agent 写的说明");

    f.env.call(
        "relation_type.set_direction",
        json!({"book":f.book,"id":f.kind,"direction":"symmetric"}),
    );
    f.env.call(
        "relation_type.set_description",
        json!({"book":f.book,"id":f.kind,"description":"作者的说明"}),
    );
    f.as_agent(
        "relation_type.set_description",
        json!({"book":f.book,"id":f.kind,"description":"又一版"}),
    );
    conflict(f.undo());
    let relation = f.relation();
    assert_eq!(relation["description"]["text"], "又一版");
    assert_eq!(relation["direction"], "symmetric");
}

/// Deleting the relation comes back whole on undo; its redo deletes only
/// while nobody put a row in it since.
#[test]
fn undoing_a_relation_delete_brings_it_back_and_its_redo_keeps_new_rows() {
    let f = Book::new();
    f.pair(&Actor::User, 0, 1);
    f.pair(&Actor::User, 2, 3);
    let before = f.list();
    f.env
        .call("relation_type.delete", json!({"book":f.book,"id":f.kind}));
    assert_eq!(f.list(), json!([]));
    f.undo().unwrap();
    assert_eq!(f.list(), before);
    f.as_agent(
        "relation_row.create_pair",
        json!({"book":f.book,"relation_type":f.kind,"left":f.e[4],"right":f.e[3]}),
    );
    let with_agent = f.list();
    let redone = f.env.ws().redo(&Actor::User);
    assert!(matches!(redone, Err(WsError::Conflict(_))), "{redone:?}");
    assert_eq!(f.list(), with_agent);
}

/// Two devices: each undo takes back only its own device's write, and the
/// devices converge.
#[test]
fn two_devices_undo_their_own_relation_writes_and_converge() {
    let one = Book::new();
    let two = env();
    sync_docs(one.env.ws(), two.ws());
    let row = one.pair(&Actor::User, 0, 1);
    sync_docs(one.env.ws(), two.ws());
    call(
        two.ws(),
        &Actor::User,
        "relation_row.add_entry",
        json!({"book":one.book,"id":row["id"],"side":"right","entry":one.e[2]}),
    );
    call(
        two.ws(),
        &Actor::User,
        "relation_type.rename",
        json!({"book":one.book,"id":one.kind,"name":"Comrades"}),
    );
    sync_docs(two.ws(), one.env.ws());
    one.undo().unwrap();
    assert_eq!(one.rows(), vec![(vec![0], vec![2])]);
    assert_eq!(one.relation()["name"], "Comrades");
    sync_docs(one.env.ws(), two.ws());
    two.ws().undo(&Actor::User).unwrap().expect("two's rename");
    two.ws()
        .undo(&Actor::User)
        .unwrap()
        .expect("two's added entry");
    sync_docs(two.ws(), one.env.ws());
    let list = |ws: &dr_workspace::Workspace| {
        ws.call(&Actor::User, "relation_type.list", json!({"book":one.book}))
            .unwrap()["output"]
            .clone()
    };
    assert_eq!(list(one.env.ws()), list(two.ws()));
    assert_eq!(one.relation()["name"], "Allies");
    assert_eq!(one.rows(), Vec::<(Vec<usize>, Vec<usize>)>::new());
}

/// Undoing a comment's text edit brings back the text only: a resolve, its
/// time and a linked conversation the Agent set since stay; a text someone
/// else wrote since refuses it.
#[test]
fn undoing_a_comment_text_edit_brings_back_only_the_text() {
    let f = Book::new();
    let id = f.env.out(
        "comment.create",
        json!({"book":f.book,"target":{"kind":"entry","id":f.e[0]},"body":"初稿"}),
    )["id"]
        .clone();
    let comment = |f: &Book| {
        f.env
            .out("comment.list", json!({"book":f.book}))
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == id)
            .unwrap()
            .clone()
    };
    f.env.call(
        "comment.update",
        json!({"book":f.book,"id":id,"body":"二稿"}),
    );
    f.as_agent(
        "comment.update",
        json!({"book":f.book,"id":id,"status":"resolved","agent_conversation":"conv-rd"}),
    );
    let resolved_at = |f: &Book| f.raw()["comments"][id.as_str().unwrap()]["resolved_at"].clone();
    assert_eq!(comment(&f)["status"], "resolved");
    let at = resolved_at(&f);
    assert!(at.is_number());
    f.undo().unwrap();
    let after = comment(&f);
    assert_eq!(after["body"]["text"], "初稿");
    assert_eq!(after["status"], "resolved");
    assert_eq!(resolved_at(&f), at);
    assert_eq!(after["agent_conversation"], "conv-rd");
    f.redo();
    assert_eq!(comment(&f)["body"]["text"], "二稿");

    f.env.call(
        "comment.update",
        json!({"book":f.book,"id":id,"body":"三稿"}),
    );
    f.as_agent(
        "comment.update",
        json!({"book":f.book,"id":id,"body":"Agent 改的"}),
    );
    conflict(f.undo());
    assert_eq!(comment(&f)["body"]["text"], "Agent 改的");
}

/// `entry_history.restore` to a point before a comment would delete it:
/// the Agent may not do that to the author's comment, only to its own.
#[test]
fn an_agent_restore_cannot_delete_the_authors_comment() {
    let f = Book::new();
    let at = f.env.out("entry_history.version", json!({"book":f.book}))["version"].clone();
    let author = f.env.out(
        "comment.create",
        json!({"book":f.book,"target":{"kind":"entry","id":f.e[0]},"body":"作者的批注"}),
    )["id"]
        .clone();
    let own = f.as_agent(
        "comment.create",
        json!({"book":f.book,"target":{"kind":"entry","id":f.e[1]},"body":"Agent 的批注"}),
    )["id"]
        .clone();
    let restore = |id: &Value| {
        f.env.ws().call(
            &Book::agent(),
            "entry_history.restore",
            json!({"book":f.book,"at":at,"targets":[{"collection":"comments","id":id}]}),
        )
    };
    let refused = restore(&author);
    assert!(
        matches!(refused, Err(WsError::Invalid(ref m)) if m.contains("reserved for the author")),
        "{refused:?}"
    );
    restore(&own).unwrap();
    let ids: Vec<Value> = f
        .env
        .out("comment.list", json!({"book":f.book}))
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["id"].clone())
        .collect();
    assert_eq!(ids, vec![author]);
    // The author's own restore may.
    f.env.call(
        "entry_history.restore",
        json!({"book":f.book,"at":at,"targets":[{"collection":"comments","id":ids[0]}]}),
    );
    assert_eq!(f.env.out("comment.list", json!({"book":f.book})), json!([]));
}

/// Each relation write and a comment's text edit declare a scoped inverse
/// (`relation_type.restore`, `comment.restore_body`) naming only what they
/// wrote; replaying one by hand twice is a no-op the second time.
#[test]
fn relation_and_comment_text_undos_are_scoped_restores() {
    let f = Book::new();
    let placed = call(
        f.env.ws(),
        &Actor::User,
        "relation_row.create_pair",
        json!({"book":f.book,"relation_type":f.kind,"left":f.e[0],"right":f.e[1]}),
    );
    let undo = &placed["undo"][0];
    assert_eq!(undo["command"], "relation_type.restore");
    assert_eq!(
        undo["input"]["rows"],
        json!([{"id":placed["output"]["id"],"relation_type":f.kind,
            "created_at":undo["input"]["rows"][0]["created_at"],"take":[[f.e[0],f.e[1]]]}])
    );
    let restored = f.env.call("relation_type.restore", undo["input"].clone());
    assert_eq!(f.rows(), Vec::<(Vec<usize>, Vec<usize>)>::new());
    assert_eq!(
        restored["undo"][0]["input"]["rows"][0]["put"],
        json!([[f.e[0], f.e[1]]])
    );
    let again = f.env.call("relation_type.restore", undo["input"].clone());
    assert!(
        again["effects"].as_array().unwrap().is_empty(),
        "already undone"
    );

    let id = f
        .env
        .out("comment.create", json!({"book":f.book,"body":"初稿"}))["id"]
        .clone();
    let edited = f.env.call(
        "comment.update",
        json!({"book":f.book,"id":id,"body":"二稿"}),
    );
    let undo = &edited["undo"][0];
    assert_eq!(undo["command"], "comment.restore_body");
    assert_eq!(undo["input"]["expected"]["text"], "二稿");
    assert_eq!(undo["input"]["body"]["text"], "初稿");
    f.env.call("comment.restore_body", undo["input"].clone());
    assert_eq!(
        f.env.out("comment.list", json!({"book":f.book}))[0]["body"]["text"],
        "初稿"
    );
}

/// Every stored document of `from`, the book first, imported into `to` as
/// another device's sync would.
fn sync_docs(from: &dr_workspace::Workspace, to: &dr_workspace::Workspace) {
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
