//! RD's command and linked-text contracts through the normal workspace entry point.

mod common;
use common::*;
use dr_model::id::{BookId, EntryId};
use dr_model::v3::LinkedText;
use dr_workspace::Actor;
use serde_json::{Value, json};

struct RelationBook {
    env: Env,
    book: String,
    a: String,
    b: String,
    c: String,
    d: String,
    kind: Value,
}

impl RelationBook {
    fn new(direction: &str) -> Self {
        let env = env();
        let book = env.book();
        let [a, b, c, d] = ["阿林", "小竹", "石桥", "老钟"].map(|title| {
            acceptance::novel_entry(env.ws(), &book, "tpl-character", title, None)["id"]
                .as_str()
                .unwrap()
                .to_owned()
        });
        let kind = env.out(
            "relation_type.create",
            json!({
                "book":book,"name":" Allies ","description":"小竹与阿林","direction":direction,
            }),
        )["id"]
            .clone();
        Self {
            env,
            book,
            a,
            b,
            c,
            d,
            kind,
        }
    }

    fn pair(&self, left: &str, right: &str) -> Value {
        self.env.out(
            "relation_row.create_pair",
            json!({
                "book":self.book,"relation_type":self.kind,"left":left,"right":right,
            }),
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

    fn add(&self, row: &Value, side: &str, entry: &str) {
        self.env.call(
            "relation_row.add_entry",
            json!({"book":self.book,"id":row["id"],"side":side,"entry":entry}),
        );
    }

    fn set_direction(&self, direction: &str) {
        self.env.call(
            "relation_type.set_direction",
            json!({"book":self.book,"id":self.kind,"direction":direction}),
        );
    }
}

#[test]
fn pair_placement_prefers_the_singleton_left_over_the_singleton_right() {
    let f = RelationBook::new("directed");
    let first = f.pair(&f.a, &f.c);
    assert_ne!(f.pair(&f.d, &f.b)["id"], first["id"]);
    assert_eq!(f.pair(&f.a, &f.b)["id"], first["id"]);
    assert_eq!(f.list()[0]["pair_count"], 3);
}

#[test]
fn pair_placement_reuses_a_singleton_right() {
    let f = RelationBook::new("directed");
    let first = f.pair(&f.a, &f.b);
    assert_eq!(f.pair(&f.c, &f.b)["id"], first["id"]);
    assert_eq!(f.list()[0]["rows"][0]["left"], json!([f.a, f.c]));
}

#[test]
fn pair_placement_tries_the_reversed_sides_for_symmetric_relations() {
    let f = RelationBook::new("symmetric");
    let first = f.pair(&f.a, &f.b);
    assert_eq!(f.pair(&f.c, &f.a)["id"], first["id"]);
    assert_eq!(f.list()[0]["rows"][0]["left"], json!([f.a]));
    assert_eq!(f.list()[0]["rows"][0]["right"], json!([f.b, f.c]));
}

#[test]
fn pair_placement_opens_a_fresh_row_when_no_row_fits() {
    let f = RelationBook::new("directed");
    let first = f.pair(&f.a, &f.b);
    assert_ne!(f.pair(&f.c, &f.d)["id"], first["id"]);
    assert_eq!(f.list()[0]["rows"].as_array().unwrap().len(), 2);
}

#[test]
fn writing_an_existing_pair_returns_the_row_without_a_write() {
    let f = RelationBook::new("symmetric");
    let first = f.pair(&f.a, &f.b);
    let at = f.head();
    let again = f.pair(&f.b, &f.a);
    assert_eq!(again["id"], first["id"]);
    assert_eq!(again["existing"], true);
    assert_eq!(f.head(), at);
}

#[test]
fn a_row_keeps_two_disjoint_entry_sides_and_does_not_duplicate_pairs() {
    let f = RelationBook::new("directed");
    let other = f.pair(&f.c, &f.d);
    let row = f.pair(&f.a, &f.b);
    f.add(&row, "left", &f.c);
    let head = f.head();
    for (side, entry) in [("right", &f.a), ("right", &f.d)] {
        assert!(
            f.env
                .try_call(
                    "relation_row.add_entry",
                    json!({"book":f.book,"id":row["id"],"side":side,"entry":entry})
                )
                .is_err()
        );
    }
    assert_eq!(f.head(), head);
    f.env.call(
        "relation_row.delete",
        json!({"book":f.book,"id":other["id"]}),
    );
    f.add(&row, "right", &f.d);
    let list = f.list();
    assert_eq!(list[0]["pair_count"], 4);
    assert_eq!(list[0]["rows"][0]["left"], json!([f.a, f.c]));
    assert_eq!(list[0]["rows"][0]["right"], json!([f.b, f.d]));
}

#[test]
fn a_relation_pair_requires_distinct_live_entries_and_a_live_relation() {
    let f = RelationBook::new("directed");
    let asset = f.env.out("asset.put", json!({
        "book":f.book,"id":"asset-rd","name":"Synthetic image","kind":"image","mime":"image/png",
        "sha256":"1".repeat(64),"size":32,"width":2,"height":2,
    }))["id"].clone();
    let comment = f.env.out(
        "comment.create",
        json!({"book":f.book,"target":{"kind":"entry","id":f.a},"body":"Synthetic note"}),
    )["id"]
        .clone();
    let at = f.head();
    for (left, right, kind) in [
        (json!(f.a), asset, f.kind.clone()),
        (json!(f.a), comment, f.kind.clone()),
        (json!(f.a), json!(f.a), f.kind.clone()),
        (json!(f.a), json!(f.b), json!("missing")),
    ] {
        assert!(
            f.env
                .try_call(
                    "relation_row.create_pair",
                    json!({"book":f.book,"relation_type":kind,"left":left,"right":right})
                )
                .is_err()
        );
        assert_eq!(f.head(), at);
    }
}

#[test]
fn direction_switch_keeps_both_sides_and_projects_reciprocal_pairs_once() {
    let f = RelationBook::new("directed");
    f.pair(&f.a, &f.b);
    f.pair(&f.b, &f.a);
    let initial = f.list();
    assert_eq!(initial[0]["pair_count"], 2);
    f.set_direction("symmetric");
    let symmetric = f.list();
    assert_eq!(symmetric[0]["direction"], "symmetric");
    assert_eq!(symmetric[0]["rows"], initial[0]["rows"]);
    assert_eq!(symmetric[0]["pair_count"], 1);
    f.set_direction("directed");
    assert_eq!(f.list(), initial);
}

#[test]
fn trash_hides_only_the_trashed_members_and_restore_brings_the_rows_back() {
    let f = RelationBook::new("directed");
    f.pair(&f.a, &f.b);
    f.pair(&f.c, &f.b);
    let full = f.list();
    f.env.call("entry.trash", json!({"book":f.book,"id":f.a}));
    assert_eq!(f.list()[0]["rows"][0]["left"], json!([f.c]));
    f.env.call("entry.trash", json!({"book":f.book,"id":f.b}));
    assert_eq!(f.list()[0]["rows"], json!([]));
    f.env.call("entry.restore", json!({"book":f.book,"id":f.a}));
    f.env.call("entry.restore", json!({"book":f.book,"id":f.b}));
    assert_eq!(f.list(), full);
}

#[test]
fn deleting_the_last_row_and_its_linked_description_undoes_in_one_step() {
    let mut f = RelationBook::new("directed");
    let row = f.pair(&f.a, &f.b);
    let before = f.list();
    f.env.call(
        "relation_row.remove_entry",
        json!({"book":f.book,"id":row["id"],"entry":f.a}),
    );
    assert_eq!(f.list(), json!([]));
    f.env.reopen();
    f.env.ws().undo(&Actor::User).unwrap().unwrap();
    assert_eq!(f.list(), before);
    f.env
        .call("relation_type.delete", json!({"book":f.book,"id":f.kind}));
    assert_eq!(f.list(), json!([]));
    f.env.ws().undo(&Actor::User).unwrap().unwrap();
    assert_eq!(f.list(), before);
}

#[test]
fn duplicate_normalized_relation_name_is_refused_on_rename() {
    let f = RelationBook::new("directed");
    let other = f.env.out(
        "relation_type.create",
        json!({"book":f.book,"name":"Rivals"}),
    );
    let head = f.head();
    assert!(
        f.env
            .try_call(
                "relation_type.rename",
                json!({"book":f.book,"id":other["id"],"name":" aLLIES "})
            )
            .is_err()
    );
    assert_eq!(f.head(), head);
}

#[test]
fn linked_text_round_trips_resolves_renames_and_suppresses_trashed_targets() {
    let mut f = RelationBook::new("directed");
    let c = f.env.out(
        "comment.create",
        json!({"book":f.book,"body":{
            "text":"😀老钟","links":[{"start":1,"end":3,"entry":f.d}]
        }}),
    )["id"]
        .clone();
    let body =
        |f: &RelationBook| f.env.out("comment.list", json!({"book":f.book}))[0]["body"].clone();
    let before = body(&f);
    let desc = f.list()[0]["description"].clone();
    assert_eq!(before["links"][0]["entry"], f.d);
    assert_eq!(desc["links"].as_array().unwrap().len(), 2);
    f.env.reopen();
    assert_eq!(body(&f), before);
    assert_eq!(f.list()[0]["description"], desc);
    f.env.call(
        "entry.update",
        json!({"book":f.book,"id":f.d,"title":"新钟楼"}),
    );
    assert_eq!(
        body(&f),
        json!({"text":"😀新钟楼","links":[{"start":1,"end":4,"entry":f.d}]})
    );
    f.env.call("entry.trash", json!({"book":f.book,"id":f.d}));
    assert_eq!(body(&f), json!({"text":"😀老钟","links":[]}));
    f.env.call("entry.restore", json!({"book":f.book,"id":f.d}));
    assert_eq!(body(&f)["text"], "😀新钟楼");
    f.env.call("comment.delete", json!({"book":f.book,"id":c}));
    f.env.ws().undo(&Actor::User).unwrap().unwrap();
    assert_eq!(body(&f)["links"][0]["entry"], f.d);
}

#[test]
fn link_planning_respects_aliases_ownership_explicit_links_and_the_setting() {
    let f = RelationBook::new("directed");
    f.env.call(
        "module.set_field",
        json!({
            "book":f.book,"entry":f.b,"module":"mod-fields","field":"aliases","value":["青竹"],
        }),
    );
    let book = BookId::parse(&f.book).unwrap();
    let owner = EntryId::parse(&f.a).unwrap();
    let frontiers = f.head();
    let plan = f
        .env
        .ws()
        .plan_entry_text_links(&book, Some(&owner), &LinkedText::plain("阿林与青竹"))
        .unwrap();
    assert_eq!(plan.links.len(), 1);
    assert_eq!(plan.links[0].range(), 3..5);
    assert_eq!(plan.links[0].entry.as_str(), f.b);
    assert_eq!(f.head(), frontiers, "planning is read-only");
    let actor = Actor::agent("synthetic", 1, "create");
    let record = f
        .env
        .ws()
        .call(
            &actor,
            "comment.create",
            json!({
                "book":f.book,"target":{"kind":"entry","id":f.a},"body":"阿林与青竹",
            }),
        )
        .unwrap();
    let listed = f.env.out("comment.list", json!({"book":f.book}));
    assert_eq!(listed[0]["id"], record["output"]["id"]);
    assert_eq!(listed[0]["body"]["links"][0]["entry"], f.b);
    assert_eq!(listed[0]["body"]["links"].as_array().unwrap().len(), 1);

    let outside =
        acceptance::novel_entry(f.env.ws(), &f.book, "tpl-note", "书签", None)["id"].clone();
    let draft: LinkedText = serde_json::from_value(json!({
        "text":"书签阿林","links":[{"start":0,"end":2,"entry":outside}],
    }))
    .unwrap();
    assert_eq!(
        f.env
            .ws()
            .plan_entry_text_links(&book, None, &draft)
            .unwrap()
            .links
            .len(),
        2
    );
    f.env.ws().set_auto_links(false);
    assert_eq!(
        f.env
            .ws()
            .plan_entry_text_links(&book, None, &draft)
            .unwrap(),
        draft
    );
    f.env.call(
        "relation_type.set_description",
        json!({"book":f.book,"id":f.kind,"description":draft}),
    );
    assert_eq!(f.list()[0]["description"]["links"][0]["entry"], outside);
    assert_eq!(
        f.list()[0]["description"]["links"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn later_names_do_not_backfill_existing_comments_or_descriptions() {
    let f = RelationBook::new("directed");
    f.env.call(
        "comment.create",
        json!({"book":f.book,"body":"青鸟站在这里。"}),
    );
    f.env.call(
        "relation_type.set_description",
        json!({"book":f.book,"id":f.kind,"description":"青鸟在这里"}),
    );
    acceptance::novel_entry(f.env.ws(), &f.book, "tpl-character", "青鸟", None);
    assert_eq!(
        f.env.out("comment.list", json!({"book":f.book}))[0]["body"]["links"],
        json!([])
    );
    assert_eq!(f.list()[0]["description"]["links"], json!([]));
}

#[test]
fn checklist_and_marker_comments_copy_entry_links_from_the_prose() {
    let f = RelationBook::new("directed");
    f.env.ws().set_auto_links(false);
    let doc = format!("body:{}/mod-prose", f.a);
    f.env.call(
        "module.set_prose",
        json!({
            "book":f.book,"owner":f.a,"module":"mod-prose",
            "paragraphs":[{"text":"小竹", "list":"task"},{"text":"TODO 小竹"}],
        }),
    );
    let paragraphs = f.env.out("prose.read", json!({"doc":doc}))["paragraphs"].clone();
    for (block, range) in [(0, [0, 2]), (1, [8, 10])] {
        let [start, end] = range;
        let session = f.env.ws().prose_session(&doc).unwrap();
        let reader = session.reader();
        let anchor = reader.view().anchor(start..end).unwrap();
        let bytes = dr_workspace::dto::AnchorBytes::from(&anchor.encode());
        f.env.call(
            "prose.link",
            json!({"links":[{
                "doc":doc,"anchors":[bytes],"target":{"kind":"entry","id":f.b},
            }]}),
        );
        assert!(paragraphs[block]["block_id"].is_string());
    }
    f.env.call(
        "comment.project",
        json!({"doc":doc,"tasks":[],
            "markers":[{"block":paragraphs[1]["block_id"],"task":"小竹"}],
        }),
    );
    let comments = f.env.out("comment.list", json!({"book":f.book}));
    assert_eq!(comments.as_array().unwrap().len(), 2);
    for origin in ["task", "marker"] {
        let comment = comments
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["origin"] == origin)
            .unwrap();
        assert_eq!(
            comment["body"],
            json!({"text":"小竹","links":[{"start":0,"end":2,"entry":f.b}]})
        );
    }
}

#[test]
fn book_text_links_do_not_add_prose_cooccurrences() {
    let f = RelationBook::new("directed");
    let initial = f.env.ws().entry_cooccurrences(&f.book).unwrap();
    f.env
        .call("comment.create", json!({"book":f.book,"body":"阿林和小竹"}));
    f.env.call(
        "relation_type.set_description",
        json!({"book":f.book,"id":f.kind,"description":"小竹和石桥"}),
    );
    let after = f.env.ws().entry_cooccurrences(&f.book).unwrap();
    assert_eq!(initial, after);
}

#[test]
fn pair_and_new_relation_undo_together() {
    let f = RelationBook::new("directed");
    let before = f.list();
    let placed = f.env.out(
        "relation_row.create_pair",
        json!({
            "book":f.book,"left":f.a,"right":f.b,"new_type":{"name":"家人","direction":"symmetric"},
        }),
    );
    assert_eq!(f.list()[0]["id"], placed["relation_type"]);
    assert_eq!(f.list()[0]["rows"][0]["id"], placed["id"]);
    f.env.ws().undo(&Actor::User).unwrap().unwrap();
    assert_eq!(f.list(), before);
}
