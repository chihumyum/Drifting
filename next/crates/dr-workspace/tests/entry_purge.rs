//! `entry.purge` (`kernel-v5.md` §16 「从最近删除里清除一个条目」; the author
//! chose 二乙 on 2026-11-21): an entry in Recently Deleted deleted for good
//! with what went in with it, and what every reader of the book reads
//! afterwards.
mod common;
use common::*;
use dr_doc::prose::BorrowedProse;
use dr_doc::v3::BorrowedBookV3;
use dr_model::id::{BookId, EntryId};
use dr_model::kind::EntityKind;
use dr_model::shared::EntityRef;
use dr_model::{DocId, Timestamp};
use dr_workspace::{Actor, WsError};
use loro::ExportMode;
use serde_json::{Value, json};

/// A small book: 书稿 holds 「第一幕」 (with two chapters) and a third
/// chapter; a storyline, a character.
struct Book {
    e: Env,
    b: String,
    ms: String,
    act: String,
    c1: String,
    c2: String,
    c3: String,
    line: String,
    person: String,
}

fn create(
    e: &Env,
    b: &str,
    parent: &str,
    template: &str,
    title: &str,
    text: Option<&str>,
) -> String {
    let mut input = json!({"book":b,"parent":parent,"template":template,"title":title});
    if let Some(text) = text {
        input["bodies"] = json!({"mod-prose": text});
    }
    e.out("entry.create", input)["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

impl Book {
    fn new() -> Self {
        let e = env();
        e.ws().set_auto_links(false);
        let b = e.book();
        let ms = acceptance::novel_root(e.ws(), &b, "tpl-manuscript");
        let lines = acceptance::novel_root(e.ws(), &b, "tpl-storylines");
        let act = create(&e, &b, &ms, "tpl-group", "第一幕", None);
        let c1 = create(
            &e,
            &b,
            &act,
            "tpl-chapter",
            "第一章 停摆",
            Some("钟楼的钟停在四点十七分。"),
        );
        let c2 = create(
            &e,
            &b,
            &act,
            "tpl-chapter",
            "第二章 面馆",
            Some("面馆开着。"),
        );
        let c3 = create(
            &e,
            &b,
            &ms,
            "tpl-chapter",
            "第三章 钟楼下",
            Some("第一章的钟还停着。"),
        );
        let line = create(&e, &b, &lines, "tpl-storyline", "修理单", None);
        let person = acceptance::novel_entry(e.ws(), &b, "tpl-character", "沈知微", None)["id"]
            .as_str()
            .unwrap()
            .to_owned();
        Self {
            e,
            b,
            ms,
            act,
            c1,
            c2,
            c3,
            line,
            person,
        }
    }
    fn call(&self, name: &str, mut input: Value) -> Value {
        input["book"] = json!(self.b);
        self.e.out(name, input)
    }
    fn try_call(&self, name: &str, mut input: Value) -> dr_workspace::Result<Value> {
        input["book"] = json!(self.b);
        self.e.try_call(name, input)
    }
    fn all(&self) -> Vec<Value> {
        self.call("entry.list", json!({"all":true,"trashed":true}))
            .as_array()
            .unwrap()
            .clone()
    }
    fn listed(&self, id: &str) -> Option<Value> {
        self.all().into_iter().find(|x| x["id"] == id)
    }
    fn raw(&self) -> Value {
        self.e
            .ws()
            .observe(&format!("book:{}", self.b))
            .unwrap()
            .value
    }
    /// The body documents the library stores for `entry`.
    fn bodies(&self, entry: &str) -> Vec<String> {
        self.e
            .ws()
            .library()
            .docs(Some(&self.b), Some("body"))
            .unwrap()
            .into_iter()
            .map(|d| d.doc_id)
            .filter(|d| d.starts_with(&format!("body:{entry}/")))
            .collect()
    }
    /// As if `id` had gone into Recently Deleted `secs` ago (a stamp of its
    /// own, apart from anything deleted in this second).
    fn age(&self, id: &str, secs: i64) {
        let (book, entry): (BookId, EntryId) = (self.b.parse().unwrap(), id.parse().unwrap());
        let at = Timestamp(Timestamp::now().0 - secs);
        self.e
            .ws()
            .library()
            .open_doc(&format!("book:{}", self.b), dr_store::OpenDoc::Existing)
            .unwrap()
            .write(dr_store::Origin::User, move |d| {
                BorrowedBookV3::new(d, &book)
                    .unwrap()
                    .txn()
                    .entries()
                    .entry(&entry)
                    .unwrap()
                    .deleted_at(Some(at))
                    .unwrap();
            })
            .unwrap();
    }
    fn book_view<R>(&self, f: impl FnOnce(dr_doc::v3::BookViewV3<'_>) -> R) -> R {
        let copy = self
            .e
            .ws()
            .library()
            .load_copy(&format!("book:{}", self.b))
            .unwrap();
        let book: BookId = self.b.parse().unwrap();
        let borrowed = BorrowedBookV3::new(&copy, &book).unwrap();
        f(borrowed.view())
    }
}

/// Only an entry in Recently Deleted can be deleted for good; a live one, an
/// unknown one or one already gone is refused, and nothing changes.
#[test]
fn only_an_entry_in_recently_deleted_is_purged() {
    let f = Book::new();
    let before = f.raw();
    assert!(matches!(
        f.try_call("entry.purge", json!({"id":f.c3})),
        Err(WsError::Invalid(_))
    ));
    assert!(matches!(
        f.try_call("entry.purge", json!({"id":"entry-nowhere"})),
        Err(WsError::NotFound { .. })
    ));
    // A chapter that went in with its act is in Recently Deleted too.
    f.call("entry.trash", json!({"id":f.act}));
    let trashed = f.raw();
    assert_ne!(before, trashed);
    assert!(matches!(
        f.try_call("entry.purge", json!({"id":f.ms})),
        Err(WsError::Invalid(_))
    ));
    assert_eq!(f.raw(), trashed);
    let out = f.call("entry.purge", json!({"id":f.c1}));
    assert_eq!(out["purged"], json!([f.c1]));
    assert!(f.listed(&f.c1).is_none());
    // What it went in with stays in Recently Deleted.
    assert!(f.listed(&f.act).unwrap()["deleted_at"].is_i64());
    assert!(matches!(
        f.try_call("entry.purge", json!({"id":f.c1})),
        Err(WsError::NotFound { .. })
    ));
}

/// The entry and what went in with it go; an entry below it that went in
/// on its own stays in Recently Deleted and moves up to where the entry
/// lived, so restoring it lands where it would have; their bodies are
/// deleted for good and recorded as purged, the others' are kept.
#[test]
fn an_entry_goes_with_what_went_in_with_it_and_nothing_else() {
    let f = Book::new();
    f.call("entry.trash", json!({"id":f.c2}));
    f.age(&f.c2, 3600);
    f.call("entry.trash", json!({"id":f.act}));
    let gone_bodies: Vec<String> = [&f.act, &f.c1].iter().flat_map(|id| f.bodies(id)).collect();
    assert!(!gone_bodies.is_empty());
    let kept_bodies: Vec<String> = [&f.c2, &f.c3].iter().flat_map(|id| f.bodies(id)).collect();
    let out = f.call("entry.purge", json!({"id":f.act}));
    assert_eq!(out["id"], json!(f.act));
    assert_eq!(out["purged"], json!([f.act, f.c1]));
    assert_eq!(out["docs"], json!(gone_bodies.len()));
    assert!(f.listed(&f.act).is_none() && f.listed(&f.c1).is_none());
    let c2 = f.listed(&f.c2).unwrap();
    assert!(c2["deleted_at"].is_i64(), "still in Recently Deleted");
    assert_eq!(c2["parent"], json!(f.ms), "moved up to where the act lived");
    assert_eq!(f.listed(&f.c3).unwrap()["parent"], json!(f.ms));
    let lib = f.e.ws().library();
    for doc in &gone_bodies {
        assert!(lib.doc_info(doc).unwrap().is_none(), "{doc}");
        assert!(
            lib.purged(doc).unwrap().is_some(),
            "{doc} is recorded as purged"
        );
        assert!(
            lib.doc_stats(doc).unwrap().is_none(),
            "{doc} has no derived rows"
        );
    }
    for doc in &kept_bodies {
        assert!(lib.doc_info(doc).unwrap().is_some(), "{doc}");
    }
    f.call("entry.restore", json!({"id":f.c2}));
    let c2 = f.listed(&f.c2).unwrap();
    assert!(c2["deleted_at"].is_null());
    assert_eq!(c2["parent"], json!(f.ms));
    assert_eq!(
        f.call(
            "module.read_prose",
            json!({"owner":f.c2,"module":"mod-prose"})
        )["paragraphs"][0]["text"],
        "面馆开着。"
    );
}

/// What the rest of the book reads afterwards, rule by rule (`kernel-v5.md`
/// §5, §18, §19 and the invariants named in `entry.purge`).
#[test]
fn the_rest_of_the_book_reads_what_the_rules_say() {
    let f = Book::new();
    // Hung on the storyline, placed on its lane, a pin bound to it.
    f.call("membership.add", json!({"host":f.line,"member":f.c1}));
    f.call("membership.add", json!({"host":f.line,"member":f.c3}));
    f.call(
        "timeline_view.put",
        json!({"view":{"id":"view-main","name":"叙事","lanes":[{"entry":f.line,"pos":"a0"}],
            "placements":[{"entry":f.c1,"at":0},{"entry":f.c3,"at":6}]}}),
    );
    f.call(
        "timeline_view.put_pin",
        json!({"view":"view-main","pin":{"id":"pin-rain","at":2,"label":"雨夜","entry":f.c1}}),
    );
    // Two relations: a row it shares, a row only it holds on one side.
    let along = f.call("relation_type.create", json!({"name":"同行"}))["id"].clone();
    let rivals = f.call("relation_type.create", json!({"name":"对手"}))["id"].clone();
    for (kind, left) in [(&along, &f.c1), (&along, &f.c3), (&rivals, &f.c1)] {
        f.call(
            "relation_row.create_pair",
            json!({"relation_type":kind,"left":left,"right":f.person}),
        );
    }
    // A Tab on the act; canvas coordinates on the outermost board and on
    // the act's own board.
    let tab = f.call(
        "tab.put",
        json!({"mount":{"kind":"entry","entry":f.act},"place":"last"}),
    )["id"]
        .clone();
    f.call(
        "layout.put",
        json!({"scope":f.ms,"mode":"board","positions":{&f.act:[1.0,2.0],&f.c3:[5.0,6.0]}}),
    );
    f.call(
        "layout.put",
        json!({"scope":f.act,"mode":"board","positions":{&f.c1:[3.0,4.0]}}),
    );
    // Checkpoints of the chapter and of the one that stays.
    f.call("entry_snapshot.create", json!({"entry":f.c1}));
    f.call("entry_snapshot.create", json!({"entry":f.c3}));
    let kept_points = f
        .call("entry_snapshot.list", json!({"entry":f.c3}))
        .as_array()
        .unwrap()
        .len();
    // An author's comment, and a checklist item's comment.
    let note = f.call(
        "comment.create",
        json!({"target":{"kind":"entry","id":f.c1},"module":"mod-prose","body":"这里再慢一点"}),
    )["id"]
        .clone();
    f.call(
        "module.set_prose",
        json!({"owner":f.c1,"module":"mod-prose","paragraphs":[
            {"text":"钟楼的钟停在四点十七分。"},{"text":"换掉表针","list":"task"}]}),
    );
    let projected = f.e.out(
        "comment.project",
        json!({"doc":format!("body:{}/mod-prose",f.c1),"markers":[],"tasks":[]}),
    )["created"][0]
        .clone();
    assert!(projected.is_string());
    // The third chapter's prose links to the first.
    let link_doc = format!("body:{}/mod-prose", f.c3);
    let (doc_id, target) = (DocId::parse(&link_doc).unwrap(), f.c1.clone());
    f.e.ws()
        .library()
        .open_doc(&link_doc, dr_store::OpenDoc::Existing)
        .unwrap()
        .write(dr_store::Origin::User, move |d| {
            BorrowedProse::new(d, &doc_id)
                .unwrap()
                .txn()
                .link_entity_v3(
                    0..3,
                    &dr_model::v3::EntityLinkV3 {
                        target,
                        kind: EntityKind::Entry,
                        module: None,
                        block: None,
                        end_block: None,
                    },
                )
                .unwrap();
        })
        .unwrap();

    f.call("entry.trash", json!({"id":f.act}));
    f.call("entry.purge", json!({"id":f.act}));

    // A Tab that showed it keeps its name and reads gone.
    let tabs = f.call("project.get", json!({}))["tabs"].clone();
    let kept = tabs
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == tab)
        .unwrap()
        .clone();
    assert_eq!(kept["mount_valid"], false);
    assert_eq!(kept["gone_title"], "第一幕");
    // Relations: it leaves every row; a row left with an empty side goes,
    // the relation stays without rows.
    let relations = f.call("relation_type.list", json!({}));
    let of = |id: &Value| {
        relations
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == *id)
            .unwrap()
            .clone()
    };
    assert_eq!(of(&along)["rows"].as_array().unwrap().len(), 1);
    assert_eq!(of(&along)["rows"][0]["left"], json!([f.c3]));
    assert_eq!(of(&along)["rows"][0]["right"], json!([f.person]));
    assert_eq!(of(&rivals)["rows"], json!([]));
    assert_eq!(of(&rivals)["pair_count"], 0);
    assert!(of(&rivals).get("hidden_rows").is_none());
    assert!(f.raw()["relations"].as_object().unwrap().len() == 1);
    // Memberships: what it was hung on no longer holds it.
    let ms = f.call("membership.list", json!({}));
    assert_eq!(ms.as_array().unwrap().len(), 1);
    assert_eq!(ms[0]["member"], json!(f.c3));
    assert!(
        f.raw()["memberships"]
            .as_object()
            .unwrap()
            .keys()
            .all(|k| !k.contains(&f.c1) && !k.contains(&f.act))
    );
    // The view: its place goes, the lane and the other place stay, the pin
    // is unbound.
    let view = f.raw()["timeline_views"]["view-main"].clone();
    assert!(view["placements"].get(&f.c1).is_none());
    assert!(view["placements"].get(&f.c3).is_some());
    assert!(view["lanes"].get(&f.line).is_some());
    assert_eq!(view["pins"]["pin-rain"]["label"], "雨夜");
    assert!(view["pins"]["pin-rain"].get("entry").is_none());
    // Canvas coordinates: its own on every canvas and its own canvases go.
    let layout = f.e.ws().layout_positions(&f.b).unwrap();
    let board = &layout[&format!("{}/board", f.ms)];
    assert!(!board.contains_key(&f.act));
    assert_eq!(board[&f.c3], (5.0, 6.0));
    assert!(!layout.contains_key(&format!("{}/board", f.act)));
    // Checkpoints: its go, the others stay.
    let checkpoints =
        f.e.ws()
            .library()
            .load_copy(&format!("checkpoints:{}", f.b))
            .unwrap();
    let book: BookId = f.b.parse().unwrap();
    let manifests = dr_doc::side::BorrowedCheckpoints::new(&checkpoints, &book)
        .unwrap()
        .view()
        .entry_checkpoints();
    assert!(!manifests.iter().any(|(_, m)| m.contains(&f.c1)));
    assert_eq!(
        f.call("entry_snapshot.list", json!({"entry":f.c3}))
            .as_array()
            .unwrap()
            .len(),
        kept_points
    );
    // Comments: the checklist item's goes with its line; the author's
    // stays and reads unlocated.
    let comments = f.call("comment.list", json!({}));
    let ids: Vec<&Value> = comments
        .as_array()
        .unwrap()
        .iter()
        .map(|c| &c["id"])
        .collect();
    assert!(!ids.contains(&&projected));
    let kept_note = comments
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == note)
        .unwrap();
    assert_eq!(kept_note["unlocated"], true);
    assert_eq!(kept_note["body"]["text"], "这里再慢一点");
    // A link to it from other prose keeps its data and reads as a link
    // whose target is gone.
    let copy = f.e.ws().library().load_copy(&link_doc).unwrap();
    let links = BorrowedProse::new(&copy, &DocId::parse(&link_doc).unwrap())
        .unwrap()
        .view()
        .entity_links_v3();
    assert!(links.iter().any(|(_, l)| l.target == f.c1));
    assert!(!f.book_view(|v| v.entity_exists(&EntityRef::new(EntityKind::Entry, f.c1.as_str()))));
    assert!(f.book_view(|v| v.entity_exists(&EntityRef::new(EntityKind::Entry, f.c3.as_str()))));
}

/// Its own records outside the tree go with it: a chapter's plot grid, a
/// character's patches; another entry's stay.
#[test]
fn its_patches_and_plot_grids_go_with_it() {
    let f = Book::new();
    let grid = |entry: &str| {
        json!({"entry":entry,"module":"mod-plot-grid","grid":{
            "cell_w":180.0,"cell_h":110.0,
            "rows":[{"id":"00000000-0000-7000-8000-000000000182","pos":"a0","label":"伏笔"}],
            "columns":[{"id":"00000000-0000-7000-8000-000000000183","pos":"a0","label":"钟"}],
            "cells":[{"row":"00000000-0000-7000-8000-000000000182",
                "column":"00000000-0000-7000-8000-000000000183","text":"停摆"}]}})
    };
    f.call("module.put_grid", grid(&f.c1));
    f.call("module.put_grid", grid(&f.c3));
    let patch = f.call(
        "module.put_patch",
        json!({"entry":f.person,"module":"mod-patches","title":"旧的说法","body":"她不修钟。"}),
    )["id"]
        .clone();
    let grids = |f: &Book| -> Vec<String> {
        f.raw()["plot_grids"]
            .as_object()
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default()
    };
    assert!(grids(&f).iter().any(|k| k.starts_with(&f.c1)));
    assert!(f.raw()["patches"].get(patch.as_str().unwrap()).is_some());
    for id in [&f.act, &f.person] {
        f.call("entry.trash", json!({"id":id}));
        f.call("entry.purge", json!({"id":id}));
    }
    assert!(!grids(&f).iter().any(|k| k.starts_with(&f.c1)));
    assert!(grids(&f).iter().any(|k| k.starts_with(&f.c3)));
    assert!(f.raw()["patches"].get(patch.as_str().unwrap()).is_none());
}

/// A storyline deleted for good: what was hung on it is no longer hung,
/// keeps living where it lives, and its places in the views (there only
/// because of the lane) go; a Tab on it keeps its name.
#[test]
fn a_lane_deleted_for_good_takes_the_places_only_it_gave() {
    let f = Book::new();
    let other = create(
        &f.e,
        &f.b,
        &acceptance::novel_root(f.e.ws(), &f.b, "tpl-storylines"),
        "tpl-storyline",
        "钟楼",
        None,
    );
    f.call("membership.add", json!({"host":f.line,"member":f.c1}));
    f.call("membership.add", json!({"host":f.line,"member":f.c3}));
    f.call("membership.add", json!({"host":other,"member":f.c3}));
    f.call(
        "timeline_view.put",
        json!({"view":{"id":"view-main","name":"叙事",
            "lanes":[{"entry":f.line,"pos":"a0"},{"entry":other,"pos":"a1"}],
            "placements":[{"entry":f.c1,"at":0},{"entry":f.c3,"at":6}]}}),
    );
    let tab = f.call(
        "tab.put",
        json!({"mount":{"kind":"entry","entry":f.line},"place":"last"}),
    )["id"]
        .clone();
    f.call("entry.trash", json!({"id":f.line}));
    f.call("entry.purge", json!({"id":f.line}));
    let view = f.raw()["timeline_views"]["view-main"].clone();
    assert!(view["lanes"].get(&f.line).is_none());
    assert!(view["lanes"].get(&other).is_some());
    assert!(
        view["placements"].get(&f.c1).is_none(),
        "only the lane placed it"
    );
    assert!(
        view["placements"].get(&f.c3).is_some(),
        "still on the other lane"
    );
    let ms = f.call("membership.list", json!({}));
    assert_eq!(ms.as_array().unwrap().len(), 1);
    assert_eq!(ms[0]["host"], json!(other));
    for chapter in [&f.c1, &f.c3] {
        let e = f.listed(chapter).unwrap();
        assert!(e["deleted_at"].is_null());
        assert_ne!(e["parent"], Value::Null);
    }
    let kept = f.call("project.get", json!({}))["tabs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == tab)
        .unwrap()
        .clone();
    assert_eq!(kept["gone_title"], "修理单");
}

/// It cannot be undone (as `asset.purge`): Undo passes over the steps that
/// would bring its records back, to the step before them, and history does
/// not revive it.
#[test]
fn a_purged_entry_does_not_come_back_through_undo_or_entry_history() {
    let mut f = Book::new();
    f.call("entry.update", json!({"id":f.c3,"title":"第三章 改过"}));
    let before = f.call("entry_history.version", json!({}))["version"].clone();
    f.call("entry.update", json!({"id":f.c1,"title":"第一章 改过"}));
    f.call("entry.trash", json!({"id":f.act}));
    let out = f.e.call("entry.purge", json!({"book":f.b,"id":f.act}));
    assert!(out["undo"].is_null(), "it cannot be undone: {out}");
    assert_eq!(
        effects(&out)
            .iter()
            .filter(|e| *e == "purged entry")
            .count(),
        3,
        "the act and its two chapters: {out}"
    );
    f.e.reopen();
    let undone = f.e.ws().undo_in(&Actor::User, &f.b, None).unwrap();
    assert_eq!(
        undone.map(|u| u.entry.command),
        Some("entry.update".to_owned()),
        "neither the trash nor the rename of what is gone is undone"
    );
    assert_eq!(f.listed(&f.c3).unwrap()["title"], "第三章 钟楼下");
    for gone in [&f.act, &f.c1, &f.c2] {
        assert!(f.listed(gone).is_none(), "{gone}");
    }
    let revived = f.try_call(
        "entry_history.restore",
        json!({"at":before,"targets":[{"collection":"entries","id":f.act}]}),
    );
    assert!(
        matches!(revived, Err(WsError::NotFound { .. })),
        "{revived:?}"
    );
    assert!(f.listed(&f.act).is_none());
}

/// Every stored document of `from`, imported into `to` as sync would, and
/// the purges `from` recorded applied there as sync applies them.
fn sync(from: &Env, to: &Env) {
    let mut docs = from.ws().library().docs(None, None).unwrap();
    docs.sort_by_key(|d| (d.kind != "book", d.doc_id.clone()));
    for d in docs {
        if from.ws().library().head(&d.doc_id).unwrap().is_none() {
            continue;
        }
        let book = d.book_id.clone().unwrap_or_default();
        let bytes = from
            .ws()
            .library()
            .load_copy(&d.doc_id)
            .unwrap()
            .export(ExportMode::all_updates())
            .unwrap();
        to.ws()
            .import_remote(&d.doc_id, Some((&d.kind, &book)), bytes, &Actor::Sync)
            .unwrap();
    }
    for p in from.ws().library().purged_docs(None).unwrap() {
        if to.ws().library().purged(&p.doc_id).unwrap().is_none() {
            to.ws().release_idle_doc_for_remote_purge(&p.doc_id);
            to.ws().library().purge_doc(&p.doc_id).unwrap();
        }
    }
}

/// Another device: the purge arrives as the book's change and its bodies'
/// purge records; it reads the same, and its older copies of those bodies
/// never come back to the first device.
#[test]
fn a_purge_reaches_another_device_and_old_copies_stay_out() {
    let f = Book::new();
    let z = env();
    sync(&f.e, &z);
    let bodies: Vec<String> = [&f.act, &f.c1, &f.c2]
        .iter()
        .flat_map(|id| f.bodies(id))
        .collect();
    let old: Vec<(String, Vec<u8>)> = bodies
        .iter()
        .map(|doc| {
            (
                doc.clone(),
                z.ws()
                    .library()
                    .load_copy(doc)
                    .unwrap()
                    .export(ExportMode::all_updates())
                    .unwrap(),
            )
        })
        .collect();
    f.call("entry.trash", json!({"id":f.act}));
    f.call("entry.purge", json!({"id":f.act}));
    sync(&f.e, &z);
    let listed = z.out("entry.list", json!({"book":f.b,"all":true,"trashed":true}));
    let ids: Vec<&str> = listed
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["id"].as_str().unwrap())
        .collect();
    for gone in [&f.act, &f.c1, &f.c2] {
        assert!(!ids.contains(&gone.as_str()), "{gone}");
    }
    assert!(ids.contains(&f.c3.as_str()));
    for doc in &bodies {
        assert!(z.ws().library().doc_info(doc).unwrap().is_none(), "{doc}");
        assert!(z.ws().library().purged(doc).unwrap().is_some(), "{doc}");
    }
    for (doc, bytes) in old {
        let book = f.b.clone();
        let imported =
            f.e.ws()
                .import_remote(&doc, Some(("body", &book)), bytes, &Actor::Sync)
                .unwrap();
        assert!(!imported, "{doc} stays deleted");
        assert!(f.e.ws().library().doc_info(&doc).unwrap().is_none());
    }
}
