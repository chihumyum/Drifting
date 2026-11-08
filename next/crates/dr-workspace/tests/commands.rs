//! One or more tests per command and query.

mod common;

use common::*;
use dr_workspace::{Actor, WsError, registry};
use serde_json::{Value, json};

fn chapter(e: &Env, book: &str, title: &str) -> String {
    e.out("chapter.create", json!({"book": book, "title": title}))["id"]
        .as_str()
        .unwrap()
        .into()
}

fn element(e: &Env, book: &str, name: &str) -> String {
    e.out("element.create", json!({"book": book, "name": name}))["id"]
        .as_str()
        .unwrap()
        .into()
}

fn rel_type(e: &Env, book: &str) -> String {
    e.out(
        "relation_type.create",
        json!({"book": book, "name": "knows", "orientation": "symmetric",
               "source_kinds": ["element", "node"], "target_kinds": ["element", "node"]}),
    )["id"]
        .as_str()
        .unwrap()
        .into()
}

#[test]
fn books_create_list_update_trash() {
    let e = env();
    let b = e.book();
    let list = e.out("book.list", json!({}));
    assert_eq!(ids(&list), std::slice::from_ref(&b));
    e.call(
        "book.update",
        json!({"book": b, "name": "Renamed", "word_target": 0, "daily_word_target": 800}),
    );
    let got = e.out("book.get", json!({"book": b}));
    assert_eq!(got["name"], "Renamed");
    assert_eq!(got["word_target"], Value::Null, "0 turns the target off");
    assert_eq!(got["daily_word_target"], 800);
    e.call("book.trash", json!({"book": b}));
    assert!(ids(&e.out("book.list", json!({}))).is_empty());
    assert_eq!(
        ids(&e.out("book.list", json!({"trashed": true}))),
        std::slice::from_ref(&b)
    );
    e.call("book.restore", json!({"book": b}));
    assert_eq!(ids(&e.out("book.list", json!({}))), [b]);
    assert!(matches!(
        e.try_call("book.create", json!({"name": "  "})),
        Err(WsError::Violation(_))
    ));
    assert!(matches!(
        e.try_call("book.get", json!({"book": "nope"})),
        Err(WsError::NotFound { .. })
    ));
}

#[test]
fn chapters_are_ordered_and_titles_get_suffixes() {
    let e = env();
    let b = e.book();
    let a = chapter(&e, &b, "Opening");
    let c = chapter(&e, &b, "Opening");
    let got = e.out("chapter.list", json!({"book": b}));
    assert_eq!(field(&got, "title"), [json!("Opening"), json!("Opening 2")]);
    assert_eq!(field(&got, "number"), [json!(1), json!(2)]);
    // Insert between: before the next chapter.
    let mid = e.out(
        "chapter.create",
        json!({"book": b, "title": "Middle", "place": {"after": a}}),
    );
    assert_eq!(mid["title"], "Middle");
    assert_eq!(
        ids(&e.out("chapter.list", json!({"book": b}))),
        [a.clone(), mid["id"].as_str().unwrap().into(), c.clone()]
    );
    // Move first.
    e.call(
        "chapter.move",
        json!({"book": b, "id": c, "place": "first"}),
    );
    assert_eq!(ids(&e.out("chapter.list", json!({"book": b})))[0], c);
    // Rename to a taken title (ideas share the namespace).
    e.out("idea.create", json!({"book": b, "title": "Taken"}));
    let r = e.out(
        "chapter.update",
        json!({"book": b, "id": a, "title": "taken", "summary": "S", "status": "finished"}),
    );
    assert_eq!(r["name"], "taken 2");
    let ch = e.out("chapter.list", json!({"book": b}));
    let ch = ch
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["id"] == json!(a))
        .unwrap()
        .clone();
    assert_eq!(
        (ch["summary"].clone(), ch["status"].clone()),
        (json!("S"), json!("finished"))
    );
    assert!(matches!(
        e.try_call(
            "chapter.update",
            json!({"book": b, "id": a, "status": "drifting"})
        ),
        Err(WsError::Invalid(_))
    ));
    // Empty title.
    assert_eq!(
        e.out("chapter.create", json!({"book": b}))["title"],
        "Untitled"
    );
}

#[test]
fn chapter_storylines_and_primary() {
    let e = env();
    let b = e.book();
    let s = e.out("storyline.create", json!({"book": b, "name": "Main"}))["id"]
        .as_str()
        .unwrap()
        .to_string();
    let c = e.out(
        "chapter.create",
        json!({"book": b, "title": "One", "storyline": s}),
    )["id"]
        .as_str()
        .unwrap()
        .to_string();
    let ch = &e.out("chapter.list", json!({"book": b}))[0];
    assert_eq!(ch["primary_storyline"], json!(s));
    assert_eq!(
        e.out("storyline.list", json!({"book": b}))[0]["chapters"],
        1
    );
    // Leaving the primary storyline clears it.
    e.call(
        "chapter.update",
        json!({"book": b, "id": c, "remove_storylines": [s]}),
    );
    let ch = &e.out("chapter.list", json!({"book": b}))[0];
    assert_eq!(
        (ch["primary_storyline"].clone(), ch["storylines"].clone()),
        (Value::Null, json!([]))
    );
    assert!(matches!(
        e.try_call(
            "chapter.update",
            json!({"book": b, "id": c, "primary_storyline": s})
        ),
        Err(WsError::Invalid(_))
    ));
}

#[test]
fn chapter_with_text_writes_prose_first() {
    let e = env();
    let b = e.book();
    let c = e.out(
        "chapter.create",
        json!({"book": b, "title": "One", "text": "第一段。\n第二段有安娜。"}),
    );
    let doc = format!("node:{}", c["id"].as_str().unwrap());
    let p = e.out("prose.read", json!({"doc": doc}));
    assert_eq!(
        field(&p["paragraphs"], "text"),
        [json!("第一段。"), json!("第二段有安娜。")]
    );
    assert_eq!(p["total"], 2);
}

#[test]
fn trashing_never_refuses_and_reports_fallout() {
    let e = env();
    let b = e.book();
    let c = chapter(&e, &b, "One");
    let el = element(&e, &b, "Anna");
    let t = rel_type(&e, &b);
    e.call("relation.create", json!({"book": b, "from": {"kind": "element", "id": el}, "to": {"kind": "node", "id": c}, "relation_type": t}));
    e.call(
        "comment.create",
        json!({"book": b, "target": {"kind": "node", "id": c}, "body": "fix"}),
    );
    let o = e.call("chapter.trash", json!({"book": b, "id": c}));
    let fx = effects(&o);
    assert!(fx.contains(&"hidden relation".to_string()), "{fx:?}");
    assert!(fx.contains(&"unlocated comment".to_string()), "{fx:?}");
    assert!(fx.contains(&"trashed node".to_string()));
    assert!(
        e.out("relation.list", json!({"book": b}))
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        e.out("comment.list", json!({"book": b}))[0]["unlocated"],
        true
    );
    let o = e.call("chapter.restore", json!({"book": b, "id": c}));
    assert!(effects(&o).contains(&"shown relation".to_string()));
    assert_eq!(
        e.out("relation.list", json!({"book": b}))
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        e.out("comment.list", json!({"book": b}))[0]["unlocated"],
        false
    );
}

#[test]
fn purging_a_chapter_cleans_up_in_one_commit() {
    let e = env();
    let b = e.book();
    let c = chapter(&e, &b, "One");
    let el = element(&e, &b, "Anna");
    let t = rel_type(&e, &b);
    e.call("relation.create", json!({"book": b, "from": {"kind": "element", "id": el}, "to": {"kind": "node", "id": c}, "relation_type": t}));
    let cm = e.out(
        "comment.create",
        json!({"book": b, "target": {"kind": "node", "id": c}, "body": "keep me"}),
    )["id"]
        .clone();
    e.call("chapter.trash", json!({"book": b, "id": c}));
    let o = e.call("chapter.purge", json!({"book": b, "id": c}));
    let fx = effects(&o);
    assert!(
        fx.contains(&"purged relation".to_string()) && fx.contains(&"detached comment".to_string()),
        "{fx:?}"
    );
    let cs = e.out("comment.list", json!({"book": b}));
    assert_eq!(cs[0]["id"], cm);
    assert_eq!(
        (cs[0]["target"].clone(), cs[0]["body"].clone()),
        (Value::Null, json!("keep me")),
        "floating, text kept"
    );
    assert!(ids(&e.out("chapter.list", json!({"book": b, "trashed": true}))).is_empty());
    // Undo restores node, relation and comment target.
    e.ws().undo(&Actor::User).unwrap().expect("undoable");
    assert_eq!(
        ids(&e.out("chapter.list", json!({"book": b, "trashed": true}))),
        std::slice::from_ref(&c)
    );
    e.call("chapter.restore", json!({"book": b, "id": c}));
    assert_eq!(
        e.out("relation.list", json!({"book": b}))
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        e.out("comment.list", json!({"book": b}))[0]["target"]["id"],
        json!(c)
    );
}

#[test]
fn acts_partition_chapters() {
    let e = env();
    let b = e.book();
    let c1 = chapter(&e, &b, "1");
    let c2 = chapter(&e, &b, "2");
    let c3 = chapter(&e, &b, "3");
    let head = e.out("act.create", json!({"book": b, "name": "Act I"}))["id"].clone();
    let two = e.out(
        "act.create",
        json!({"book": b, "name": "Act II", "start_chapter": c2}),
    )["id"]
        .clone();
    let acts = e.out("act.list", json!({"book": b}));
    assert_eq!(
        field(&acts, "chapters"),
        [json!([c1.clone()]), json!([c2.clone(), c3.clone()])]
    );
    assert_eq!(e.out("chapter.list", json!({"book": b}))[1]["act"], two);
    assert!(matches!(
        e.try_call("act.create", json!({"book": b, "name": "Another head"})),
        Err(WsError::Invalid(_))
    ));
    // A chapter inserted after the last one of Act I stays in Act I.
    let mid = e.out(
        "chapter.create",
        json!({"book": b, "title": "1b", "place": {"after": c1}}),
    );
    let acts = e.out("act.list", json!({"book": b}));
    assert_eq!(acts[0]["chapters"], json!([c1, mid["id"].clone()]));
    let idea = e.out("idea.create", json!({"book": b, "title": "notes"}))["id"].clone();
    e.call(
        "act.update",
        json!({"book": b, "id": head, "name": "Prologue", "drift": idea}),
    );
    assert_eq!(e.out("act.list", json!({"book": b}))[0]["drift"], idea);
    e.call("act.delete", json!({"book": b, "id": two}));
    assert_eq!(
        e.out("act.list", json!({"book": b}))
            .as_array()
            .unwrap()
            .len(),
        1
    );
    e.ws().undo(&Actor::User).unwrap().unwrap();
    assert_eq!(
        e.out("act.list", json!({"book": b}))[1]["id"],
        two,
        "same id back"
    );
}

#[test]
fn storylines_order_rename_trash_purge() {
    let e = env();
    let b = e.book();
    let s1 = e.out("storyline.create", json!({"book": b, "name": "A"}))["id"].clone();
    let s2 = e.out("storyline.create", json!({"book": b, "name": "a"}));
    assert_eq!(s2["name"], "a 2");
    let s3 = e.out(
        "storyline.create",
        json!({"book": b, "name": "C", "place": "first"}),
    )["id"]
        .clone();
    assert_eq!(
        ids(&e.out("storyline.list", json!({"book": b})))[0],
        s3.as_str().unwrap()
    );
    e.call(
        "storyline.move",
        json!({"book": b, "id": s3, "place": "last"}),
    );
    assert_eq!(
        ids(&e.out("storyline.list", json!({"book": b})))
            .last()
            .unwrap(),
        s3.as_str().unwrap()
    );
    e.call(
        "storyline.update",
        json!({"book": b, "id": s1, "summary": "sum", "color": "#fff"}),
    );
    let c = e.out(
        "chapter.create",
        json!({"book": b, "title": "x", "storyline": s1}),
    )["id"]
        .clone();
    e.call("storyline.trash", json!({"book": b, "id": s1}));
    assert_eq!(
        e.out("storyline.list", json!({"book": b}))
            .as_array()
            .unwrap()
            .len(),
        2
    );
    e.call("storyline.restore", json!({"book": b, "id": s1}));
    let o = e.call("storyline.purge", json!({"book": b, "id": s1}));
    assert!(effects(&o).contains(&"detached node".to_string()));
    let ch = &e.out("chapter.list", json!({"book": b}))[0];
    assert_eq!(
        (
            ch["id"].clone(),
            ch["storylines"].clone(),
            ch["primary_storyline"].clone()
        ),
        (c, json!([]), Value::Null)
    );
}

#[test]
fn element_names_are_unique_and_placeholders_numbered() {
    let e = env();
    let b = e.book();
    let anna = element(&e, &b, "Anna");
    match e.try_call("element.create", json!({"book": b, "name": " anna "})) {
        Err(WsError::NameTaken { id, .. }) => assert_eq!(id, anna),
        other => panic!("{other:?}"),
    }
    let n1 = e.out(
        "element.create",
        json!({"book": b, "name": "New Element", "numbered": true}),
    );
    let n2 = e.out(
        "element.create",
        json!({"book": b, "name": "New Element", "numbered": true}),
    );
    assert_eq!(
        (n1["name"].clone(), n2["name"].clone()),
        (json!("New Element"), json!("New Element 2"))
    );
    // Aliases count.
    let bob = element(&e, &b, "Bob");
    assert!(matches!(
        e.try_call(
            "element.update",
            json!({"book": b, "id": bob, "add_aliases": ["ANNA"]})
        ),
        Err(WsError::NameTaken { .. })
    ));
    e.call(
        "element.update",
        json!({"book": b, "id": bob, "add_aliases": ["Bobby"], "summary": "s",
        "put_fields": [{"key": "age", "value": "30"}], "relate_pin": [1.0, 2.0]}),
    );
    assert!(matches!(
        e.try_call("element.create", json!({"book": b, "name": "bobby"})),
        Err(WsError::NameTaken { .. })
    ));
    let el = e.out("element.list", json!({"book": b}));
    let bobv = el
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["id"] == json!(bob))
        .unwrap()
        .clone();
    assert_eq!(bobv["aliases"], json!(["Bobby"]));
    assert_eq!(bobv["fields"][0]["key"], "age");
    assert_eq!(bobv["relate_pin"], json!([1.0, 2.0]));
    // A trashed element frees its name; restoring it gets a suffix.
    e.call("element.trash", json!({"book": b, "id": anna}));
    let anna2 = element(&e, &b, "Anna");
    let r = e.out("element.restore", json!({"book": b, "id": anna}));
    assert_eq!(r["name"], "Anna 2");
    assert_ne!(anna2, anna);
}

#[test]
fn categories_and_their_elements() {
    let e = env();
    let b = e.book();
    let cat = e.out("category.create", json!({"book": b, "name": "People"}))["id"].clone();
    assert_eq!(
        e.out("category.create", json!({"book": b, "name": "people"}))["name"],
        "people 2"
    );
    let el = e.out(
        "element.create",
        json!({"book": b, "name": "Anna", "category": cat}),
    )["id"]
        .clone();
    assert_eq!(e.out("category.list", json!({"book": b}))[0]["elements"], 1);
    e.call(
        "category.update",
        json!({"book": b, "id": cat, "layout": "pinned", "grid": [1, 2]}),
    );
    assert_eq!(
        e.out("category.list", json!({"book": b}))[0]["layout"],
        "pinned"
    );
    e.call("category.trash", json!({"book": b, "id": cat}));
    assert_eq!(
        e.out("element.list", json!({"book": b}))[0]["category"],
        Value::Null,
        "reads uncategorized"
    );
    e.call("category.restore", json!({"book": b, "id": cat}));
    assert_eq!(
        e.out("element.list", json!({"book": b}))[0]["category"],
        cat
    );
    let o = e.call("category.purge", json!({"book": b, "id": cat}));
    assert!(effects(&o).contains(&"detached element".to_string()));
    assert_eq!(e.out("element.list", json!({"book": b}))[0]["id"], el);
    e.call("element.purge", json!({"book": b, "id": el}));
    assert!(
        e.out("element.list", json!({"book": b, "trashed": true}))
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn relations_validate_and_dedupe() {
    let e = env();
    let b = e.book();
    let a = element(&e, &b, "A");
    let c = element(&e, &b, "C");
    let t = rel_type(&e, &b);
    let r1 = e.out("relation.create", json!({"book": b, "from": {"kind": "element", "id": c}, "to": {"kind": "element", "id": a}, "relation_type": t}));
    let r2 = e.out("relation.create", json!({"book": b, "from": {"kind": "element", "id": a}, "to": {"kind": "element", "id": c}, "relation_type": t}));
    assert_eq!(r2["existing"], true);
    assert_eq!(r1["id"], r2["id"]);
    let list = e.out("relation.list", json!({"book": b}));
    assert_eq!(list[0]["from"]["id"], json!(a), "canonical order");
    assert!(matches!(e.try_call("relation.create", json!({"book": b, "from": {"kind": "element", "id": a}, "to": {"kind": "element", "id": a}, "relation_type": t})), Err(WsError::Violation(_))));
    assert!(matches!(e.try_call("relation.create", json!({"book": b, "from": {"kind": "element", "id": a}, "to": {"kind": "element", "id": "ghost"}, "relation_type": t})), Err(WsError::NotFound { .. })));
    // A comment links to structure through the built-in type.
    let cm = e.out(
        "comment.create",
        json!({"book": b, "kind": "todo", "body": "x"}),
    )["id"]
        .clone();
    e.call("relation.create", json!({"book": b, "from": {"kind": "comment", "id": cm}, "to": {"kind": "element", "id": a}}));
    assert_eq!(
        e.out(
            "relation.list",
            json!({"book": b, "entity": {"kind": "comment", "id": cm}})
        )
        .as_array()
        .unwrap()
        .len(),
        1
    );
    e.call("relation.delete", json!({"book": b, "id": r1["id"]}));
    assert_eq!(
        e.out("relation.list", json!({"book": b}))
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn relation_types_names_locks_and_cascade() {
    let e = env();
    let b = e.book();
    let t = rel_type(&e, &b);
    assert!(matches!(e.try_call("relation_type.create", json!({"book": b, "name": " KNOWS ", "source_kinds": ["element"], "target_kinds": ["element"], "source_role": "a", "target_role": "b"})), Err(WsError::NameTaken { .. })));
    assert!(matches!(
        e.try_call(
            "relation_type.create",
            json!({"book": b, "name": "bad", "source_kinds": [], "target_kinds": ["element"]})
        ),
        Err(WsError::Violation(_))
    ));
    let types = e.out("relation_type.list", json!({"book": b}));
    let generic = types
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["locked"] == json!(true))
        .unwrap()["id"]
        .clone();
    assert!(matches!(
        e.try_call(
            "relation_type.update",
            json!({"book": b, "id": generic, "name": "x"})
        ),
        Err(WsError::Locked(_))
    ));
    assert!(matches!(
        e.try_call("relation_type.delete", json!({"book": b, "id": generic})),
        Err(WsError::Locked(_))
    ));
    e.call(
        "relation_type.update",
        json!({"book": b, "id": t, "name": "friends", "color": "#f00"}),
    );
    let a = element(&e, &b, "A");
    let c = element(&e, &b, "C");
    e.call("relation.create", json!({"book": b, "from": {"kind": "element", "id": a}, "to": {"kind": "element", "id": c}, "relation_type": t}));
    let d = e.out("relation_type.delete", json!({"book": b, "id": t}));
    assert_eq!(d["relations"], 1);
    assert!(
        e.out("relation.list", json!({"book": b}))
            .as_array()
            .unwrap()
            .is_empty()
    );
    e.ws().undo(&Actor::User).unwrap().unwrap();
    assert_eq!(
        e.out("relation.list", json!({"book": b}))
            .as_array()
            .unwrap()
            .len(),
        1,
        "type and relation back"
    );
}

#[test]
fn ideas_and_groups() {
    let e = env();
    let b = e.book();
    let g = e.out("idea_group.create", json!({"book": b, "name": "G"}))["id"].clone();
    let sub = e.out(
        "idea_group.create",
        json!({"book": b, "name": "Sub", "parent": g}),
    )["id"]
        .clone();
    assert!(
        matches!(
            e.try_call(
                "idea_group.create",
                json!({"book": b, "name": "Deep", "parent": sub})
            ),
            Err(WsError::Invalid(_))
        ),
        "two levels at most"
    );
    let i = e.out(
        "idea.create",
        json!({"book": b, "title": "Spark", "group": sub, "position": [3.0, 4.0]}),
    )["id"]
        .clone();
    assert_eq!(
        e.out("idea.list", json!({"book": b, "group": sub}))[0]["id"],
        i
    );
    e.call(
        "idea.update",
        json!({"book": b, "id": i, "status": "resting", "narrative_order": 12.0}),
    );
    let idea = &e.out("idea.list", json!({"book": b}))[0];
    assert_eq!(
        (idea["status"].clone(), idea["narrative_order"].clone()),
        (json!("resting"), json!(12.0))
    );
    let other = e.out("idea_group.create", json!({"book": b, "name": "Other"}))["id"].clone();
    assert!(
        matches!(
            e.try_call(
                "idea_group.update",
                json!({"book": b, "id": g, "parent": other})
            ),
            Err(WsError::Invalid(_))
        ),
        "G has a child: would be three levels"
    );
    e.call("idea_group.delete", json!({"book": b, "id": sub}));
    let idea = &e.out("idea.list", json!({"book": b}))[0];
    assert_eq!(idea["group"], g, "moved up to the parent");
    e.ws().undo(&Actor::User).unwrap().unwrap();
    assert_eq!(
        e.out("idea.list", json!({"book": b}))[0]["group"],
        sub,
        "group restored with its member"
    );
    assert_eq!(
        e.out("idea_group.list", json!({"book": b}))
            .as_array()
            .unwrap()
            .len(),
        3
    );
    e.call("idea.trash", json!({"book": b, "id": i}));
    assert!(
        e.out("idea.list", json!({"book": b}))
            .as_array()
            .unwrap()
            .is_empty()
    );
    e.call("idea.restore", json!({"book": b, "id": i}));
}

#[test]
fn purging_an_idea_keeps_its_title_on_time_pins() {
    let e = env();
    let b = e.book();
    let i = e.out("idea.create", json!({"book": b, "title": "Battle"}))["id"].clone();
    let act = e.out("act.create", json!({"book": b, "name": "A"}))["id"].clone();
    e.call("act.update", json!({"book": b, "id": act, "drift": i}));
    let o = e.call("idea.purge", json!({"book": b, "id": i}));
    assert!(effects(&o).contains(&"detached act".to_string()));
    assert_eq!(
        e.out("act.list", json!({"book": b}))[0]["drift"],
        Value::Null
    );
}

#[test]
fn comments_with_anchors_and_metadata() {
    let e = env();
    let b = e.book();
    let c = e.out(
        "chapter.create",
        json!({"book": b, "title": "One", "text": "安娜走进了房间。"}),
    )["id"]
        .clone();
    let cm = e.out(
        "comment.create",
        json!({"book": b, "kind": "todo", "target": {"kind": "node", "id": c},
        "range": [0, 2], "body": "rename?", "priority": "high"}),
    )["id"]
        .clone();
    let got = &e.out("comment.list", json!({"book": b, "kind": "todo"}))[0];
    assert_eq!(
        (
            got["quote"].clone(),
            got["anchored"].clone(),
            got["priority"].clone()
        ),
        (json!("安娜"), json!(true), json!("high"))
    );
    e.call(
        "comment.update",
        json!({"book": b, "id": cm, "status": "resolved", "body": "done"}),
    );
    let got = &e.out("comment.list", json!({"book": b}))[0];
    assert_eq!(
        (got["status"].clone(), got["body"].clone()),
        (json!("resolved"), json!("done"))
    );
    assert!(
        e.out("comment.list", json!({"book": b, "status": "open"}))
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(
        matches!(
            e.try_call(
                "comment.create",
                json!({"book": b, "block_id": "b1", "body": "x"})
            ),
            Err(WsError::Violation(_))
        ),
        "a block needs a target"
    );
    e.call("comment.delete", json!({"book": b, "id": cm}));
    assert!(
        e.out("comment.list", json!({"book": b}))
            .as_array()
            .unwrap()
            .is_empty()
    );
    e.ws().undo(&Actor::User).unwrap().unwrap();
    assert_eq!(e.out("comment.list", json!({"book": b}))[0]["body"], "done");
}

#[test]
fn materials_folders_and_assets() {
    let e = env();
    let b = e.book();
    let f = e.out("material_folder.create", json!({"book": b, "name": "Refs"}))["id"].clone();
    let sub = e.out(
        "material_folder.create",
        json!({"book": b, "name": "Maps", "parent": f}),
    )["id"]
        .clone();
    assert!(matches!(
        e.try_call(
            "material_folder.update",
            json!({"book": b, "id": f, "parent": sub})
        ),
        Err(WsError::Invalid(_))
    ));
    e.call(
        "material_folder.update",
        json!({"book": b, "id": sub, "name": "Atlas"}),
    );
    let fs = e.out("material_folder.list", json!({"book": b}));
    assert_eq!(field(&fs, "name"), [json!("Refs"), json!("Atlas")]);
    assert_eq!(fs[1]["parent"], f);
    let t = e.out(
        "material.create",
        json!({"book": b, "kind": "text", "title": "Note", "folder": sub, "text": "a note"}),
    )["id"]
        .clone();
    assert_eq!(
        e.out(
            "prose.read",
            json!({"doc": format!("material:{}", t.as_str().unwrap())})
        )["paragraphs"][0]["text"],
        "a note"
    );
    assert!(
        matches!(
            e.try_call(
                "material.create",
                json!({"book": b, "kind": "image", "title": "pic"})
            ),
            Err(WsError::Violation(_))
        ),
        "an image needs its asset"
    );
    let sha = "a".repeat(64);
    e.call("asset.put", json!({"book": b, "id": "asset-1", "kind": "image", "mime": "image/png", "size": 10, "sha256": sha, "width": 2, "height": 2}));
    assert!(matches!(e.try_call("asset.put", json!({"book": b, "id": "asset-1", "kind": "image", "mime": "image/png", "size": 11, "sha256": sha, "width": 2, "height": 2})), Err(WsError::Locked(_))));
    let got = e.out("asset.get", json!({"book": b, "id": "asset-1"}));
    assert_eq!(
        got,
        json!({"id": "asset-1", "kind": "image", "mime": "image/png", "size": 10, "width": 2, "height": 2})
    );
    assert!(matches!(
        e.try_call("asset.get", json!({"book": b, "id": "asset-2"})),
        Err(WsError::NotFound { .. })
    ));
    let img = e.out(
        "material.create",
        json!({"book": b, "kind": "image", "title": "pic", "asset": "asset-1", "place": "first"}),
    )["id"]
        .clone();
    assert_eq!(
        ids(&e.out("material.list", json!({"book": b})))[0],
        img.as_str().unwrap()
    );
    e.call(
        "material.move",
        json!({"book": b, "id": img, "place": "last"}),
    );
    assert_eq!(
        ids(&e.out("material.list", json!({"book": b})))
            .last()
            .unwrap(),
        img.as_str().unwrap()
    );
    e.call(
        "material.update",
        json!({"book": b, "id": t, "description": "about maps", "task_todos": false, "folder": f}),
    );
    let m = e.out("material.list", json!({"book": b, "folder": f}));
    assert_eq!(
        (m[0]["description"].clone(), m[0]["task_todos"].clone()),
        (json!("about maps"), json!(false))
    );
    e.call("material_folder.delete", json!({"book": b, "id": f}));
    assert_eq!(
        e.out("material.list", json!({"book": b, "folder": ""}))
            .as_array()
            .unwrap()
            .len(),
        2
    );
    e.call("material.delete", json!({"book": b, "id": img}));
    assert_eq!(
        e.out("material.list", json!({"book": b}))
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn facts_and_memory() {
    let e = env();
    let b = e.book();
    let f1 = e.out(
        "fact.put",
        json!({"book": b, "key": "Era", "value": "1870s"}),
    )["id"]
        .clone();
    e.out(
        "fact.put",
        json!({"book": b, "key": "Place", "value": "Moscow", "place": "first"}),
    );
    assert_eq!(
        field(&e.out("fact.list", json!({"book": b})), "key"),
        [json!("Place"), json!("Era")]
    );
    e.call(
        "fact.put",
        json!({"book": b, "id": f1, "key": "Era", "value": "1880s"}),
    );
    assert_eq!(e.out("fact.list", json!({"book": b}))[1]["value"], "1880s");
    e.call("fact.remove", json!({"book": b, "id": f1}));
    assert_eq!(
        e.out("fact.list", json!({"book": b}))
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let m = e.out(
        "memory.add",
        json!({"book": b, "body": "Never use semicolons", "kind": "preference"}),
    )["id"]
        .clone();
    e.call(
        "memory.update",
        json!({"book": b, "id": m, "status": "dismissed"}),
    );
    assert_eq!(
        e.out("memory.list", json!({"book": b}))[0]["status"],
        "dismissed"
    );
    e.call("memory.remove", json!({"book": b, "id": m}));
    assert!(
        e.out("memory.list", json!({"book": b}))
            .as_array()
            .unwrap()
            .is_empty()
    );
    e.call("memory.restore", json!({"book": b, "id": m}));
    assert_eq!(
        e.out("memory.list", json!({"book": b}))[0]["source"],
        "author"
    );
    let am = e
        .ws()
        .call(
            &Actor::agent("s", 1, "c"),
            "memory.add",
            json!({"book": b, "body": "from agent"}),
        )
        .unwrap();
    assert!(am["output"]["id"].is_string());
    assert!(
        e.out("memory.list", json!({"book": b}))
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["source"] == "agent")
    );
}

#[test]
fn prose_replace_is_exact() {
    let e = env();
    let b = e.book();
    let c = e.out(
        "chapter.create",
        json!({"book": b, "title": "One", "text": "他说好。\n她说好。"}),
    )["id"]
        .clone();
    let doc = format!("node:{}", c.as_str().unwrap());
    assert!(matches!(
        e.try_call(
            "prose.replace",
            json!({"doc": doc, "find": "说好", "replace": "答应"})
        ),
        Err(WsError::Ambiguous(_))
    ));
    assert!(matches!(
        e.try_call(
            "prose.replace",
            json!({"doc": doc, "find": "没有", "replace": "x"})
        ),
        Err(WsError::NotFound { .. })
    ));
    let p = e.out("prose.read", json!({"doc": doc}));
    let block = p["paragraphs"][1]["block_id"].clone();
    let r = e.out(
        "prose.replace",
        json!({"doc": doc, "find": "说好", "replace": "答应", "block_id": block}),
    );
    assert_eq!(r["block_id"], block);
    assert_eq!(
        e.out("prose.read", json!({"doc": doc}))["paragraphs"][1]["text"],
        "她答应。"
    );
    e.ws().undo(&Actor::User).unwrap().unwrap();
    assert_eq!(
        e.out("prose.read", json!({"doc": doc}))["paragraphs"][1]["text"],
        "她说好。"
    );
    assert!(matches!(
        e.try_call(
            "prose.replace",
            json!({"doc": doc, "find": "他", "replace": "a\nb"})
        ),
        Err(WsError::Invalid(_))
    ));
}

#[test]
fn prose_restore_goes_back_and_forth() {
    let e = env();
    let b = e.book();
    let c = e.out(
        "chapter.create",
        json!({"book": b, "title": "One", "text": "原文。"}),
    )["id"]
        .clone();
    let doc = format!("node:{}", c.as_str().unwrap());
    let v0 = e.out("prose.read", json!({"doc": doc}))["version"].clone();
    e.call(
        "prose.replace",
        json!({"doc": doc, "find": "原文", "replace": "改过"}),
    );
    e.call("prose.restore", json!({"doc": doc, "at": v0}));
    assert_eq!(
        e.out("prose.read", json!({"doc": doc}))["paragraphs"][0]["text"],
        "原文。"
    );
    e.ws().undo(&Actor::User).unwrap().unwrap();
    assert_eq!(
        e.out("prose.read", json!({"doc": doc}))["paragraphs"][0]["text"],
        "改过。"
    );
}

#[test]
fn search_orders_by_book_order() {
    let e = env();
    let b = e.book();
    let c2 = e.out(
        "chapter.create",
        json!({"book": b, "title": "Two", "text": "安娜在第二章。"}),
    )["id"]
        .clone();
    let c1 = e.out(
        "chapter.create",
        json!({"book": b, "title": "One", "text": "安娜在第一章。", "place": "first"}),
    )["id"]
        .clone();
    e.out(
        "element.create",
        json!({"book": b, "name": "安娜", "text": "安娜是主角。"}),
    );
    // The index is derived when holders are idle; force it.
    for d in e.ws().library().docs(Some(&b), None).unwrap() {
        e.ws().library().reindex_doc(&d.doc_id).unwrap();
    }
    let hits = e.out("book.search", json!({"book": b, "query": "安娜"}));
    let owners: Vec<Value> = field(&hits, "owner");
    assert_eq!(owners.len(), 4);
    assert_eq!(
        (owners[0].clone(), owners[1].clone()),
        (c1.clone(), c2.clone()),
        "chapters in reading order first"
    );
    // The element's name, then its prose.
    assert_eq!(
        field(&hits, "kind")[2..],
        [json!("element"), json!("element")]
    );
    assert_eq!(field(&hits, "field")[2..], [json!("title"), json!("body")]);
    let one = e.out(
        "book.search",
        json!({"book": b, "query": "安娜在第", "limit": 1}),
    );
    assert_eq!(one.as_array().unwrap().len(), 1);
    // A trashed chapter neither shows nor takes a place before the cut.
    e.call("chapter.trash", json!({"book": b, "id": c1}));
    let after = e.out(
        "book.search",
        json!({"book": b, "query": "安娜", "limit": 1}),
    );
    assert_eq!(field(&after, "owner"), [c2]);
}

#[test]
fn search_reads_titles_summaries_and_material_descriptions_too() {
    let e = env();
    let b = e.book();
    let c = e.out(
        "chapter.create",
        json!({"book": b, "title": "灯塔", "summary": "她在灯塔下等。", "text": "第一段。\n灯塔亮了。"}),
    )["id"]
        .clone();
    let m = e.out(
        "material.create",
        json!({"book": b, "kind": "text", "title": "旧照片", "description": "一张灯塔的照片"}),
    )["id"]
        .clone();
    for d in e.ws().library().docs(Some(&b), None).unwrap() {
        e.ws().library().reindex_doc(&d.doc_id).unwrap();
    }
    let hits = e.out("book.search", json!({"book": b, "query": "灯塔"}));
    let fields: Vec<(Value, Value, Value)> = hits
        .as_array()
        .unwrap()
        .iter()
        .map(|h| {
            (
                h["owner"].clone(),
                h["field"].clone(),
                h["paragraph"].clone(),
            )
        })
        .collect();
    assert_eq!(
        fields,
        [
            (c.clone(), json!("title"), Value::Null),
            (c.clone(), json!("summary"), Value::Null),
            (c.clone(), json!("body"), json!(1)),
            (m.clone(), json!("description"), Value::Null),
        ]
    );
    assert_eq!(hits[0]["kind"], "chapter");
    assert_eq!(hits[3]["kind"], "material");
    // Where the match is in the snippet, for highlighting.
    for h in hits.as_array().unwrap() {
        let snippet: Vec<char> = h["snippet"].as_str().unwrap().chars().collect();
        let at = h["snippet_match"].as_u64().unwrap() as usize;
        let len = h["match_len"].as_u64().unwrap() as usize;
        assert_eq!(snippet[at..at + len].iter().collect::<String>(), "灯塔");
    }
    // The cut counts the short texts too, in the same order.
    let two = e.out(
        "book.search",
        json!({"book": b, "query": "灯塔", "limit": 2}),
    );
    assert_eq!(field(&two, "field"), [json!("title"), json!("summary")]);
    // Case folds as in the prose.
    e.call(
        "material.update",
        json!({"book": b, "id": m, "description": "A LIGHTHOUSE"}),
    );
    let latin = e.out("book.search", json!({"book": b, "query": "lighthouse"}));
    assert_eq!(field(&latin, "owner"), [m]);
}

#[test]
fn word_counts_come_from_the_index() {
    let e = env();
    let b = e.book();
    let s = e.out("storyline.create", json!({"book": b, "name": "Main"}))["id"]
        .as_str()
        .unwrap()
        .to_string();
    let one = e.out(
        "chapter.create",
        json!({"book": b, "title": "One", "text": "安娜在第一章。", "storyline": s}),
    )["id"]
        .clone();
    let two = e.out(
        "chapter.create",
        json!({"book": b, "title": "Two", "text": "Hello world"}),
    )["id"]
        .clone();
    e.out(
        "idea.create",
        json!({"book": b, "title": "Idea", "text": "构想"}),
    );
    let before = e.out("book.word_counts", json!({"book": b}));
    for d in e.ws().library().docs(Some(&b), None).unwrap() {
        e.ws().library().reindex_doc(&d.doc_id).unwrap();
    }
    let got = e.out("book.word_counts", json!({"book": b}));
    assert_eq!(field(&got["chapters"], "id"), [one.clone(), two.clone()]);
    assert_eq!(field(&got["chapters"], "words"), [json!(6), json!(2)]);
    assert_eq!(got["book"]["words"], 8, "the book counts its chapters only");
    assert_eq!(got["counted"], true);
    assert_eq!(got["ideas"][0]["words"], 2);
    assert_eq!(got["storylines"][0]["words"], 6);
    assert_eq!(got["storylines"][0]["chapters"], 1);
    assert_eq!(got["word_target"], 120_000);
    assert_eq!(got["daily_word_target"], 1_500);
    // Whatever the index had not counted yet says so.
    let _ = before;
    e.call("chapter.trash", json!({"book": b, "id": one}));
    let after = e.out("book.word_counts", json!({"book": b}));
    assert_eq!(after["book"]["words"], 2);
    assert_eq!(after["storylines"][0]["chapters"], 0);
}

#[test]
fn writing_days_sum_devices_and_keep_each_device_to_its_key() {
    let e = env();
    let b = e.book();
    let mac = "device-000000000000000000000001";
    let win = "device-000000000000000000000002";
    let rec = |device: &str, day: &str, words: i64| {
        e.call(
            "writing_day.record",
            json!({"book": b, "device": device, "day": day, "words": words}),
        );
    };
    rec(mac, "2026-11-08", 300);
    rec(win, "2026-11-08", 200);
    rec(mac, "2026-11-07", 50);
    rec(mac, "2026-11-05", 10);
    rec(mac, "2026-11-08", 350);
    let got = e.out(
        "book.writing_days",
        json!({"book": b, "today": "2026-11-08", "days": 4, "device": mac}),
    );
    assert_eq!(
        field(&got["days"], "words"),
        [json!(10), json!(0), json!(50), json!(550)]
    );
    assert_eq!(got["days"][0]["day"], "2026-11-05");
    assert_eq!(got["today"], 550);
    assert_eq!(got["mine_today"], 350);
    assert_eq!(got["week"], 610);
    assert_eq!(got["active_days"], 3);
    assert_eq!(got["streak"], 2);
    // Not undoable: undo leaves the writing day alone.
    assert!(matches!(
        e.try_call(
            "writing_day.record",
            json!({"book": b, "device": "mac|1", "day": "2026-11-08", "words": 1})
        ),
        Err(WsError::Invalid(_))
    ));
    assert!(matches!(
        e.try_call(
            "writing_day.record",
            json!({"book": b, "device": mac, "day": "2026-13-01", "words": 1})
        ),
        Err(WsError::Invalid(_))
    ));
    assert!(matches!(
        e.try_call(
            "writing_day.record",
            json!({"book": b, "device": mac, "day": "2026-11-08", "words": -1})
        ),
        Err(WsError::Invalid(_))
    ));
}

#[test]
fn unknown_commands_and_bad_input() {
    let e = env();
    assert!(matches!(
        e.try_call("nope.nothing", json!({})),
        Err(WsError::UnknownCommand(_))
    ));
    match e.try_call("chapter.create", json!({"title": "no book"})) {
        Err(err @ WsError::BadInput { .. }) => assert_eq!(err.code(), "bad_input"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn every_registered_entry_is_exercised_here() {
    // Keep this list in step with the registry: a new command needs a test
    // (here, in editor.rs for what the editor calls, in shelf.rs for the
    // shelf, recent pages and time pins, in points.rs for snapshot history,
    // in workshop.rs for plot grids, patches and templates).
    let srcs = [
        include_str!("commands.rs"),
        include_str!("editor.rs"),
        include_str!("shelf.rs"),
        include_str!("points.rs"),
        include_str!("autolink.rs"),
        include_str!("workshop.rs"),
    ];
    let missing: Vec<&str> = registry()
        .iter()
        .map(|s| s.name)
        .filter(|n| {
            !srcs.iter().any(|src| src.contains(&format!("\"{n}\"")))
                && ![
                    "history.restore_entities",
                    "history.undo_agent",
                    "history.agent_changes",
                ]
                .contains(n)
        })
        .collect();
    assert!(missing.is_empty(), "no test calls {missing:?}");
}

#[test]
fn null_clears_a_field_and_undo_brings_back_an_empty_one() {
    let e = env();
    let b = e.book();
    let u = Actor::User;
    let s = e.out("storyline.create", json!({"book": b, "name": "Main"}))["id"].clone();
    let c = e.out(
        "chapter.create",
        json!({"book": b, "title": "One", "storyline": s}),
    )["id"]
        .clone();
    // An explicit null clears; a missing field leaves it.
    e.call(
        "chapter.update",
        json!({"book": b, "id": c, "summary": "x"}),
    );
    assert_eq!(
        e.out("chapter.list", json!({"book": b}))[0]["primary_storyline"],
        s
    );
    e.call(
        "chapter.update",
        json!({"book": b, "id": c, "primary_storyline": null}),
    );
    assert_eq!(
        e.out("chapter.list", json!({"book": b}))[0]["primary_storyline"],
        Value::Null
    );
    e.ws().undo(&u).unwrap().unwrap();
    assert_eq!(
        e.out("chapter.list", json!({"book": b}))[0]["primary_storyline"],
        s,
        "undo sets it again"
    );
    // Undo of setting a field that was empty empties it again.
    let el = e.out("element.create", json!({"book": b, "name": "A"}))["id"].clone();
    e.call(
        "element.update",
        json!({"book": b, "id": el, "group_name": "Family", "relate_pin": [1.0, 1.0]}),
    );
    e.ws().undo(&u).unwrap().unwrap();
    let got = &e.out("element.list", json!({"book": b}))[0];
    assert_eq!(
        (got["group_name"].clone(), got["relate_pin"].clone()),
        (Value::Null, Value::Null)
    );
    let g = e.out("idea_group.create", json!({"book": b, "name": "G"}))["id"].clone();
    let i = e.out("idea.create", json!({"book": b, "title": "I", "group": g}))["id"].clone();
    e.call(
        "idea.update",
        json!({"book": b, "id": i, "group": null, "narrative_order": 3.0}),
    );
    let got = &e.out("idea.list", json!({"book": b}))[0];
    assert_eq!(
        (got["group"].clone(), got["narrative_order"].clone()),
        (Value::Null, json!(3.0))
    );
    e.ws().undo(&u).unwrap().unwrap();
    let got = &e.out("idea.list", json!({"book": b}))[0];
    assert_eq!(
        (got["group"].clone(), got["narrative_order"].clone()),
        (g, Value::Null)
    );
}

/// Links `ranges` (start, end) of `doc`'s text to element `target`.
fn link_text(e: &Env, doc: &str, target: &str, ranges: &[(usize, usize)]) {
    let session = e.ws().prose_session(doc).unwrap();
    let link = dr_model::prose::EntityLink {
        target: target.to_owned(),
        kind: dr_model::kind::EntityKind::Element,
        block: None,
        end_block: None,
    };
    let ranges = ranges.to_vec();
    session
        .edit(move |t| {
            for (start, end) in ranges {
                t.link_entity(start..end, &link)?;
            }
            Ok(())
        })
        .unwrap();
}

#[test]
fn mentions_go_out_and_come_in() {
    let e = env();
    let b = e.book();
    let anna = element(&e, &b, "安娜");
    let ben = element(&e, &b, "本");
    let one = e.out(
        "chapter.create",
        json!({"book": b, "title": "One", "text": "安娜说：「走吧。」\n安娜和本。"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let two = e.out(
        "chapter.create",
        json!({"book": b, "title": "Two", "text": "本走了。"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    link_text(&e, &format!("node:{one}"), &anna, &[(0, 2), (10, 12)]);
    link_text(&e, &format!("node:{one}"), &ben, &[(13, 14)]);
    link_text(&e, &format!("node:{two}"), &ben, &[(0, 1)]);
    for d in e.ws().library().docs(Some(&b), None).unwrap() {
        e.ws().library().reindex_doc(&d.doc_id).unwrap();
    }
    let node = |id: &str| json!({"kind": "node", "id": id});
    let el = |id: &str| json!({"kind": "element", "id": id});
    // Out: what chapter one mentions, the most mentioned first.
    let out = e.out("mention.list", json!({"book": b, "from": node(&one)}));
    let rows: Vec<(Value, Value, Value)> = out
        .as_array()
        .unwrap()
        .iter()
        .map(|r| (r["to"].clone(), r["blocks"].clone(), r["count"].clone()))
        .collect();
    assert_eq!(
        rows,
        [
            (el(&anna), json!(2), json!(2)),
            (el(&ben), json!(1), json!(1))
        ]
    );
    assert_eq!(out[0]["kind"], "link");
    // In: what mentions 本.
    let into = e.out("mention.list", json!({"book": b, "to": el(&ben)}));
    let mut from: Vec<Value> = field(&into, "from");
    from.sort_by_key(|v| v["id"].as_str().unwrap().to_owned());
    let mut want = vec![node(&one), node(&two)];
    want.sort_by_key(|v| v["id"].as_str().unwrap().to_owned());
    assert_eq!(from, want);
    // The whole book's mentions of elements.
    let all = e.out("mention.list", json!({"book": b, "to_kind": "element"}));
    assert_eq!(all.as_array().unwrap().len(), 3);
    // Ties come in a fixed order (by the mentioning document); `limit`
    // keeps the top rows.
    let mut tied = [node(&one), node(&two)];
    tied.sort_by_key(|v| format!("node:{}", v["id"].as_str().unwrap()));
    assert_eq!(field(&all, "from")[1..], tied[..]);
    assert_eq!(
        e.out("mention.list", json!({"book": b, "limit": 1})),
        json!([all[0]])
    );
    assert!(
        e.out("mention.list", json!({"book": b, "to_kind": "material"}))
            .as_array()
            .unwrap()
            .is_empty()
    );
    // Only live ends: a chapter in the trash mentions nothing.
    e.call("chapter.trash", json!({"book": b, "id": two}));
    let into = e.out("mention.list", json!({"book": b, "to": el(&ben)}));
    assert_eq!(field(&into, "from"), [node(&one)]);
    e.call("element.trash", json!({"book": b, "id": ben}));
    let out = e.out("mention.list", json!({"book": b, "from": node(&one)}));
    assert_eq!(field(&out, "to"), [el(&anna)]);
}

#[test]
fn prose_has_a_shape() {
    let e = env();
    let b = e.book();
    let one = e.out(
        "chapter.create",
        json!({"book": b, "title": "One", "text": "安娜说：「走吧。」\n\n安娜和本。"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let got = e.out("prose.shape", json!({"doc": format!("node:{one}")}));
    assert_eq!(got["paragraphs"], 2, "a blank paragraph is not one");
    assert_eq!(got["sentences"], 2);
    // 「走吧。」: three of the fourteen characters.
    let dialogue = got["dialogue"].as_f64().unwrap();
    assert!((dialogue - 3.0 / 14.0).abs() < 1e-6, "{dialogue}");
    assert_eq!(
        (got["tasks"].clone(), got["done"].clone()),
        (json!(0), json!(0))
    );
    assert_eq!(got["embeds"], json!([]));
    match e.try_call("prose.shape", json!({"doc": format!("book:{b}")})) {
        Err(WsError::Invalid(_)) => {}
        other => panic!("{other:?}"),
    }
}

/// One chapter as `chapter.list` shows it.
fn chapter_row(e: &Env, b: &str, id: &Value) -> Value {
    e.out("chapter.list", json!({"book": b}))
        .as_array()
        .unwrap()
        .iter()
        .find(|c| &c["id"] == id)
        .cloned()
        .unwrap()
}

#[test]
fn a_timeline_drop_moves_and_reroutes_a_chapter_in_one_step() {
    let e = env();
    let b = e.book();
    let u = Actor::User;
    let sa = e.out("storyline.create", json!({"book": b, "name": "A"}))["id"].clone();
    let sb = e.out("storyline.create", json!({"book": b, "name": "B"}))["id"].clone();
    let sc = e.out("storyline.create", json!({"book": b, "name": "C"}))["id"].clone();
    let c1 = e.out(
        "chapter.create",
        json!({"book": b, "title": "One", "storyline": sa}),
    )["id"]
        .clone();
    let c2 = e.out(
        "chapter.create",
        json!({"book": b, "title": "Two", "storyline": sa}),
    )["id"]
        .clone();
    e.call(
        "chapter.update",
        json!({"book": b, "id": c1, "add_storylines": [sb]}),
    );
    let before = chapter_row(&e, &b, &c1);
    assert_eq!(before["primary_storyline"], sa);

    // Onto lane C, after Two: C is primary, A (the old primary) goes, B stays.
    let done = e.call(
        "chapter.place",
        json!({"book": b, "id": c1, "axis": "book", "order": 12.5, "storyline": sc}),
    );
    assert_eq!(done["output"]["primary_storyline"], sc);
    assert_eq!(done["undo"].as_array().unwrap().len(), 1, "{done}");
    assert_eq!(effects(&done), ["moved node"]);
    let row = chapter_row(&e, &b, &c1);
    assert_eq!(row["book_order"], 12.5);
    assert_eq!(row["primary_storyline"], sc);
    let mut members: Vec<String> = row["storylines"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap().to_string())
        .collect();
    members.sort();
    let mut want = vec![
        sb.as_str().unwrap().to_string(),
        sc.as_str().unwrap().to_string(),
    ];
    want.sort();
    assert_eq!(members, want);
    assert_eq!(
        ids(&e.out("chapter.list", json!({"book": b}))),
        [c2.as_str().unwrap(), c1.as_str().unwrap()]
    );

    // One undo step brings back both the place and the storylines.
    e.ws().undo(&u).unwrap().unwrap();
    assert_eq!(chapter_row(&e, &b, &c1), before);
    e.ws().redo(&u).unwrap().unwrap();
    assert_eq!(chapter_row(&e, &b, &c1), row);

    // The same drop again changes nothing and leaves no step.
    let same = e.call(
        "chapter.place",
        json!({"book": b, "id": c1, "order": 12.5, "storyline": sc}),
    );
    assert!(effects(&same).is_empty(), "{same}");
    assert!(same["journal"].is_null());

    // 未归属: off every storyline.
    e.call(
        "chapter.place",
        json!({"book": b, "id": c1, "order": 12.5, "storyline": null}),
    );
    let row = chapter_row(&e, &b, &c1);
    assert_eq!(row["storylines"], json!([]));
    assert!(row["primary_storyline"].is_null());
    e.ws().undo(&u).unwrap().unwrap();
    assert_eq!(chapter_row(&e, &b, &c1)["primary_storyline"], sc);

    // Story time: the narrative place moves, reading order does not.
    let order = chapter_row(&e, &b, &c2)["book_order"].clone();
    e.call(
        "chapter.place",
        json!({"book": b, "id": c2, "axis": "narrative", "order": 33.0, "storyline": sb}),
    );
    let row = chapter_row(&e, &b, &c2);
    assert_eq!(row["narrative_order"], 33.0);
    assert_eq!(row["book_order"], order);
    assert_eq!(row["primary_storyline"], sb);
    e.ws().undo(&u).unwrap().unwrap();
    let row = chapter_row(&e, &b, &c2);
    assert!(row["narrative_order"].is_null());
    assert_eq!(row["primary_storyline"], sa);

    // A deleted storyline is refused.
    e.call("storyline.trash", json!({"book": b, "id": sb}));
    assert!(
        e.try_call(
            "chapter.place",
            json!({"book": b, "id": c2, "order": 1.0, "storyline": sb})
        )
        .is_err()
    );

    // chapter.update takes an exact reading place too.
    e.call(
        "chapter.update",
        json!({"book": b, "id": c2, "book_order": 99.0}),
    );
    assert_eq!(chapter_row(&e, &b, &c2)["book_order"], 99.0);
    e.ws().undo(&u).unwrap().unwrap();
    assert_eq!(chapter_row(&e, &b, &c2)["book_order"], order);
}

#[test]
fn spreading_respaces_chapters_and_their_act_boundaries_in_one_step() {
    let e = env();
    let b = e.book();
    let u = Actor::User;
    let mut cs = Vec::new();
    for (i, o) in [5.0, 5.1, 5.2, 20.0].into_iter().enumerate() {
        let c = e.out(
            "chapter.create",
            json!({"book": b, "title": format!("C{i}")}),
        )["id"]
            .clone();
        e.call("chapter.place", json!({"book": b, "id": c, "order": o}));
        cs.push(c);
    }
    e.call("act.create", json!({"book": b, "name": "Head"}));
    let act = e.out(
        "act.create",
        json!({"book": b, "name": "Two", "start_chapter": cs[2]}),
    )["id"]
        .clone();
    let list_before = e.out("chapter.list", json!({"book": b}));
    let acts_before = e.out("act.list", json!({"book": b}));

    let done = e.call("chapter.spread", json!({"book": b, "axis": "book"}));
    assert_eq!(done["undo"].as_array().unwrap().len(), 1, "{done}");
    let orders = field(&e.out("chapter.list", json!({"book": b})), "book_order");
    assert_eq!(orders, [json!(1.0), json!(6.0), json!(11.0), json!(16.0)]);
    let acts = e.out("act.list", json!({"book": b}));
    let two = acts
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["id"] == act)
        .unwrap();
    // Halfway between the chapters it fell between; the head act stays.
    assert_eq!(two["start_order"], 8.5);
    assert_eq!(two["chapters"], json!([cs[2], cs[3]]));
    assert!(
        acts.as_array()
            .unwrap()
            .iter()
            .any(|a| a["start_order"].is_null())
    );

    // Spread again: nothing to do, no step.
    let again = e.call("chapter.spread", json!({"book": b}));
    assert!(effects(&again).is_empty());
    assert!(again["journal"].is_null());

    // One undo step.
    e.ws().undo(&u).unwrap().unwrap();
    assert_eq!(e.out("chapter.list", json!({"book": b})), list_before);
    assert_eq!(e.out("act.list", json!({"book": b})), acts_before);
    e.ws().redo(&u).unwrap().unwrap();
    assert_eq!(
        field(&e.out("chapter.list", json!({"book": b})), "book_order")[3],
        16.0
    );

    // Story time: only the chapters placed on it, no acts.
    e.call(
        "chapter.place",
        json!({"book": b, "id": cs[3], "axis": "narrative", "order": 40.0}),
    );
    e.call(
        "chapter.place",
        json!({"book": b, "id": cs[0], "axis": "narrative", "order": 40.0}),
    );
    let spread = e.out("chapter.spread", json!({"book": b, "axis": "narrative"}));
    assert!(spread["acts"].as_array().unwrap().is_empty());
    let row = |c: &Value| chapter_row(&e, &b, c)["narrative_order"].clone();
    // Ties go by id, as everywhere: cs[0] was made first.
    assert_eq!((row(&cs[0]), row(&cs[3])), (json!(1.0), json!(6.0)));
    assert!(row(&cs[1]).is_null());

    // chapter.arrange sets exact coordinates; acts are reading order only.
    e.call(
        "chapter.arrange",
        json!({"book": b, "axis": "book", "chapters": [{"id": cs[0], "order": 2.0}], "acts": [{"id": act, "start_order": 10.0}]}),
    );
    assert_eq!(chapter_row(&e, &b, &cs[0])["book_order"], 2.0);
    e.ws().undo(&u).unwrap().unwrap();
    assert_eq!(chapter_row(&e, &b, &cs[0])["book_order"], 1.0);
    assert!(
        e.try_call(
            "chapter.arrange",
            json!({"book": b, "axis": "narrative", "acts": [{"id": act, "start_order": 1.0}]}),
        )
        .is_err()
    );
}

/// M19: a comment can mark a rectangle on an image or a PDF page; it is
/// listed with its region, and refused anywhere else, with a range, or
/// outside the picture.
#[test]
fn region_comments_sit_on_image_and_pdf_materials() {
    let e = env();
    let b = e.out("book.create", json!({"name": "Regions"}))["id"].clone();
    let sha = "b".repeat(64);
    e.call("asset.put", json!({"book": b, "id": "asset-pdf", "kind": "pdf", "mime": "application/pdf", "size": 10, "sha256": sha}));
    let pdf = e.out(
        "material.create",
        json!({"book": b, "kind": "pdf", "title": "notes", "asset": "asset-pdf"}),
    )["id"]
        .clone();
    let note = e.out(
        "material.create",
        json!({"book": b, "kind": "text", "title": "note", "text": "a note"}),
    )["id"]
        .clone();
    let on = |id: &Value| json!({"kind": "material", "id": id});
    let region = json!({"page": 2, "x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4});
    let c = e.out(
        "comment.create",
        json!({"book": b, "target": on(&pdf), "region": region, "body": "tide"}),
    )["id"]
        .clone();
    let listed = e.out("comment.list", json!({"book": b}));
    assert_eq!(listed[0]["id"], c);
    assert_eq!(listed[0]["region"], region);
    assert!(!listed[0]["anchored"].as_bool().unwrap());
    let refused = |input: Value| {
        matches!(
            e.try_call("comment.create", input),
            Err(WsError::Invalid(_))
        )
    };
    assert!(refused(
        json!({"book": b, "region": region, "body": "floating"})
    ));
    assert!(refused(
        json!({"book": b, "target": on(&note), "region": region, "body": "text"})
    ));
    let chapter = chapter(&e, b.as_str().unwrap(), "One");
    assert!(refused(
        json!({"book": b, "target": {"kind": "node", "id": chapter},
                           "region": region, "body": "prose"})
    ));
    assert!(refused(
        json!({"book": b, "target": on(&pdf), "body": "outside",
                           "region": {"x": 0.8, "y": 0.0, "w": 0.5, "h": 0.1}})
    ));
    assert!(refused(
        json!({"book": b, "target": on(&pdf), "body": "both",
                           "region": region, "range": [0, 1]})
    ));
}

#[test]
fn a_chapter_made_on_story_time_is_one_step() {
    let e = env();
    let b = e.book();
    let u = Actor::User;
    let done = e.call(
        "chapter.create",
        json!({"book": b, "title": "夜", "narrative_order": 33.0}),
    );
    let c = done["output"]["id"].clone();
    assert_eq!(done["undo"].as_array().unwrap().len(), 1, "{done}");
    assert_eq!(chapter_row(&e, &b, &c)["narrative_order"], 33.0);
    e.ws().undo(&u).unwrap().unwrap();
    assert!(
        e.out("chapter.list", json!({"book": b}))
            .as_array()
            .unwrap()
            .is_empty()
    );
    e.ws().redo(&u).unwrap().unwrap();
    assert_eq!(chapter_row(&e, &b, &c)["narrative_order"], 33.0);
    assert!(
        e.try_call(
            "chapter.create",
            json!({"book": b, "title": "x", "narrative_order": "never"}),
        )
        .is_err()
    );
}

#[test]
fn an_idea_turns_into_a_chapter_in_one_step() {
    let e = env();
    let b = e.book();
    let u = Actor::User;
    let line = e.out("storyline.create", json!({"book": b, "name": "主线"}))["id"].clone();
    let first = e.out("chapter.create", json!({"book": b, "title": "一"}))["id"].clone();
    let group = e.out("idea_group.create", json!({"book": b, "name": "灵光"}))["id"].clone();
    let idea = e.out(
        "idea.create",
        json!({"book": b, "title": "夜航", "summary": "船", "group": group, "text": "雾里有灯。"}),
    )["id"]
        .clone();
    let pin = e.out(
        "time_pin.create",
        json!({"book": b, "narrative_order": 7.0, "idea": idea}),
    )["id"]
        .clone();
    let act = e.out("act.create", json!({"book": b, "name": "第一幕"}))["id"].clone();
    e.call("act.update", json!({"book": b, "id": act, "drift": idea}));
    let text = |e: &Env| {
        field(
            &e.out(
                "prose.read",
                json!({"doc": format!("node:{}", idea.as_str().unwrap())}),
            )["paragraphs"],
            "text",
        )
    };
    let before = (
        e.out("idea.list", json!({"book": b})),
        e.out("time_pin.list", json!({"book": b})),
        e.out("act.list", json!({"book": b})),
        text(&e),
    );

    let done = e.call(
        "idea.to_chapter",
        json!({"book": b, "id": idea, "storyline": line}),
    );
    assert_eq!(done["undo"].as_array().unwrap().len(), 1, "{done}");
    // The same page, now the last chapter: a draft on the storyline.
    assert_eq!(
        ids(&e.out("chapter.list", json!({"book": b}))),
        [first.as_str().unwrap(), idea.as_str().unwrap()]
    );
    let row = chapter_row(&e, &b, &idea);
    assert_eq!(row["status"], "draft");
    assert_eq!(row["summary"], "船");
    assert_eq!(row["storylines"], json!([line]));
    assert_eq!(row["primary_storyline"], line);
    assert_eq!(text(&e), before.3);
    assert!(
        e.out("idea.list", json!({"book": b}))
            .as_array()
            .unwrap()
            .is_empty()
    );
    // What was bound to the idea lets go; a pin without a label keeps its title.
    let pins = e.out("time_pin.list", json!({"book": b}));
    assert!(pins[0]["idea"].is_null());
    assert_eq!(pins[0]["label"], "夜航");
    assert!(e.out("act.list", json!({"book": b}))[0]["drift"].is_null());

    // One undo step brings the idea back as it was.
    e.ws().undo(&u).unwrap().unwrap();
    assert_eq!(e.out("idea.list", json!({"book": b})), before.0);
    assert_eq!(e.out("time_pin.list", json!({"book": b})), before.1);
    assert_eq!(e.out("act.list", json!({"book": b})), before.2);
    assert_eq!(
        ids(&e.out("chapter.list", json!({"book": b}))),
        [first.as_str().unwrap()]
    );
    assert_eq!(pin, before.1[0]["id"]);
    e.ws().redo(&u).unwrap().unwrap();
    assert_eq!(chapter_row(&e, &b, &idea)["primary_storyline"], line);
    // A chapter, or an idea in the trash, is not an idea to turn.
    assert!(
        e.try_call("idea.to_chapter", json!({"book": b, "id": idea}))
            .is_err()
    );
}
