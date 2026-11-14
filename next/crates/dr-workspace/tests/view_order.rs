//! A folder's order while it is in a view and after it leaves its last one
//! (`kernel-v5.md` §4, §16 「泳道」): undo across a later entry, the
//! write-back touching only what lives directly in the folder, and every
//! entry of a lane getting a position on the scale.
mod common;
use common::*;
use dr_workspace::{Actor, Workspace};
use loro::ExportMode;
use serde_json::{Value, json};

struct Book<'a> {
    e: &'a Env,
    b: String,
}

impl<'a> Book<'a> {
    fn new(e: &'a Env) -> Self {
        Self { b: e.book(), e }
    }
    fn on(e: &'a Env, b: &str) -> Self {
        Self { e, b: b.to_owned() }
    }
    fn root(&self, template: &str) -> String {
        acceptance::novel_root(self.e.ws(), &self.b, template)
    }
    fn view(&self) -> String {
        self.e.out("timeline_view.list", json!({"book": self.b}))[0]["id"]
            .as_str()
            .unwrap()
            .to_owned()
    }
    fn create(&self, parent: &str, template: &str, title: &str) -> String {
        self.e.out(
            "entry.create",
            json!({"book": self.b, "parent": parent, "template": template, "title": title}),
        )["id"]
            .as_str()
            .unwrap()
            .to_owned()
    }
    fn call(&self, name: &str, mut input: Value) -> Value {
        input["book"] = json!(self.b);
        self.e.call(name, input)
    }
    /// The live entries stored directly under `parent`, in their manual
    /// order (what is stored, whether or not the folder is in a view).
    fn live_children(&self, parent: &str) -> Vec<String> {
        let book = dr_model::id::BookId::parse(&self.b).unwrap();
        let parent = dr_model::id::EntryId::parse(parent).unwrap();
        self.e
            .ws()
            .read_book_v3(&self.b, move |doc, _| {
                Ok(dr_doc::v3::BorrowedBookV3::new(doc, &book)
                    .unwrap()
                    .view()
                    .entries_raw()
                    .into_iter()
                    .filter(|e| e.parent.as_ref() == Some(&parent) && !e.is_trashed())
                    .map(|e| e.id.to_string())
                    .collect())
            })
            .unwrap()
    }
    fn parent(&self, id: &str) -> Value {
        self.e.out("entry.get", json!({"book": self.b, "id": id}))["parent"].clone()
    }
    /// The stored placements of `view` (not the filtered read).
    fn stored_placements(&self, view: &str) -> serde_json::Map<String, Value> {
        let raw = self
            .e
            .ws()
            .observe(&format!("book:{}", self.b))
            .unwrap()
            .value;
        raw["timeline_views"][view]["placements"]
            .as_object()
            .cloned()
            .unwrap_or_default()
    }
    fn at(&self, view: &str, entry: &str) -> Option<f64> {
        self.stored_placements(view)
            .get(entry)
            .and_then(|p| p["at"].as_f64())
    }
}

/// Every stored document of `from` imported into `to`, the book first, as
/// another device's sync would.
fn sync(from: &Workspace, to: &Workspace) {
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
            .export(ExportMode::all_updates())
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

/// DX 10: a folder leaves its last view (its scale order goes back into the
/// folder), a chapter is created and undone, then the folder's leaving is
/// undone too: the trashed chapter is no reason to refuse.
#[test]
fn undoing_a_folders_last_view_exit_ignores_entries_trashed_since() {
    let e = env();
    let k = Book::new(&e);
    let ms = k.root("tpl-manuscript");
    let view = k.view();
    let c: Vec<String> = ["一", "二", "三"]
        .iter()
        .map(|t| k.create(&ms, "tpl-chapter", t))
        .collect();
    k.call("timeline_view.add_lane", json!({"view": view, "lane": ms}));
    k.call("entry.move", json!({"id": c[2], "parent": ms, "index": 0}));
    k.call(
        "timeline_view.remove_lane",
        json!({"view": view, "lane": ms}),
    );
    assert_eq!(
        k.live_children(&ms),
        vec![c[2].clone(), c[0].clone(), c[1].clone()]
    );
    let four = k.create(&ms, "tpl-chapter", "四");
    e.ws().undo(&Actor::User).unwrap().expect("the creation");
    assert!(k.live_children(&ms).iter().all(|id| id != &four));
    e.ws()
        .undo(&Actor::User)
        .expect("undoing the exit is not refused")
        .expect("the exit");
    assert_eq!(k.live_children(&ms), c, "the manual order is back");
    let lanes = e.out("timeline_view.list", json!({"book": k.b}))[0]["lanes"].clone();
    assert!(
        lanes.as_array().unwrap().iter().any(|l| l["entry"] == ms),
        "{lanes}"
    );
}

/// DX 11: the write-back only puts in order what is stored directly in the
/// folder. An entry a merge left under a level that is now off reads as
/// living in the folder, but it stays where it is stored.
#[test]
fn leaving_the_last_view_never_moves_an_entry_stored_elsewhere_into_the_folder() {
    let (ea, ez) = (env(), env());
    let a = Book::new(&ea);
    let ms = a.root("tpl-manuscript");
    let view = a.view();
    let c: Vec<String> = ["一", "二", "三"]
        .iter()
        .map(|t| a.create(&ms, "tpl-chapter", t))
        .collect();
    let group = a.create(&ms, "tpl-group", "卷");
    a.call("timeline_view.add_lane", json!({"view": view, "lane": ms}));
    a.call("entry.move", json!({"id": c[2], "parent": ms, "index": 0}));
    sync(ea.ws(), ez.ws());
    let z = Book::on(&ez, &a.b);
    // Offline: A puts a chapter in the group, Z turns the group's level off.
    let inside = a.create(&group, "tpl-chapter", "卷中");
    z.call("entry.set_level", json!({"id": group, "level": false}));
    sync(ez.ws(), ea.ws());
    assert_eq!(
        a.parent(&inside),
        group,
        "the merge keeps where it is stored"
    );
    a.call(
        "timeline_view.remove_lane",
        json!({"view": view, "lane": ms}),
    );
    assert_eq!(a.parent(&inside), group, "the write-back left it alone");
    assert_eq!(
        a.live_children(&ms),
        vec![c[2].clone(), c[0].clone(), c[1].clone(), group.clone()]
    );
}

/// DX 11: two devices. Z moves a chapter out of the folder while A takes
/// the folder out of its last view: A's write-back moves only what is out
/// of order, so Z's move is not undone by it.
#[test]
fn leaving_the_last_view_keeps_another_devices_move_out_of_the_folder() {
    let (ea, ez) = (env(), env());
    let a = Book::new(&ea);
    let ms = a.root("tpl-manuscript");
    let ideas = a.root("tpl-ideas");
    let view = a.view();
    let c: Vec<String> = ["一", "二", "三", "四"]
        .iter()
        .map(|t| a.create(&ms, "tpl-chapter", t))
        .collect();
    a.call("timeline_view.add_lane", json!({"view": view, "lane": ms}));
    // Along the scale: 二 三 四 一.
    a.call("entry.move", json!({"id": c[0], "parent": ms, "index": 3}));
    sync(ea.ws(), ez.ws());
    let z = Book::on(&ez, &a.b);
    z.call("entry.move", json!({"id": c[2], "parent": ideas}));
    a.call(
        "timeline_view.remove_lane",
        json!({"view": view, "lane": ms}),
    );
    sync(ez.ws(), ea.ws());
    sync(ea.ws(), ez.ws());
    for k in [&a, &z] {
        assert_eq!(k.parent(&c[2]), ideas, "Z's move stands");
        assert_eq!(
            k.live_children(&ms),
            vec![c[1].clone(), c[3].clone(), c[0].clone()]
        );
    }
}

/// DX 12: an entry trashed before its folder went into the view gets a
/// position when it comes back.
#[test]
fn an_entry_restored_into_a_folder_that_entered_a_view_meanwhile_is_placed() {
    let e = env();
    let k = Book::new(&e);
    let ms = k.root("tpl-manuscript");
    let view = k.view();
    let one = k.create(&ms, "tpl-chapter", "一");
    let two = k.create(&ms, "tpl-chapter", "二");
    k.call("entry.trash", json!({"id": two}));
    k.call("timeline_view.add_lane", json!({"view": view, "lane": ms}));
    assert!(k.at(&view, &two).is_none());
    k.call("entry.restore", json!({"id": two}));
    let (a1, a2) = (k.at(&view, &one).unwrap(), k.at(&view, &two).unwrap());
    assert!(a2 > a1, "{a1} {a2}");
}

/// DX 12: an entry restored to another residence (its folder is gone) loses
/// its position in the views of the folder it no longer lives in.
#[test]
fn an_entry_restored_elsewhere_leaves_its_old_folders_views() {
    let e = env();
    let k = Book::new(&e);
    let ms = k.root("tpl-manuscript");
    let view = k.view();
    let group = k.create(&ms, "tpl-group", "卷");
    let inside = k.create(&group, "tpl-chapter", "卷中");
    k.call(
        "timeline_view.add_lane",
        json!({"view": view, "lane": group}),
    );
    assert!(k.at(&view, &inside).is_some());
    k.call("entry.trash", json!({"id": group}));
    k.call("entry.restore", json!({"id": inside}));
    assert_eq!(k.parent(&inside), ms, "it lands in the nearest level");
    assert!(
        k.at(&view, &inside).is_none(),
        "{:?}",
        k.stored_placements(&view)
    );
    // Undo puts it back as it was.
    e.ws().undo(&Actor::User).unwrap().unwrap();
    assert_eq!(k.parent(&inside), group);
    assert!(k.at(&view, &inside).is_some());
}

/// DX 12: several entries coming back at once each get their own position.
#[test]
fn entries_restored_together_land_on_distinct_positions() {
    let e = env();
    let k = Book::new(&e);
    let ideas = k.root("tpl-ideas");
    let storylines = k.root("tpl-storylines");
    let view = k.view();
    let line = k.create(&storylines, "tpl-storyline", "主线");
    let group = k.create(&ideas, "tpl-idea-group", "一组");
    let x = k.create(&group, "tpl-idea", "甲");
    let y = k.create(&group, "tpl-idea", "乙");
    for m in [&x, &y] {
        k.call("membership.add", json!({"host": line, "member": m}));
    }
    k.call("entry.trash", json!({"id": group}));
    k.call(
        "timeline_view.add_lane",
        json!({"view": view, "lane": line}),
    );
    k.call("entry.restore", json!({"id": group}));
    let (ax, ay) = (k.at(&view, &x).unwrap(), k.at(&view, &y).unwrap());
    assert_ne!(ax, ay);
}

/// DX 12: turning 「收别处的条目」 back on for a lane already in a view
/// places the members that come back.
#[test]
fn members_coming_back_to_a_lane_in_a_view_are_placed() {
    let e = env();
    let k = Book::new(&e);
    let ms = k.root("tpl-manuscript");
    let view = k.view();
    let folder = k.create(&ms, "tpl-group", "卷");
    k.call(
        "entry.update",
        json!({"id": folder, "overrides": {"accept": true}}),
    );
    let resident = k.create(&folder, "tpl-chapter", "住着");
    let member = k.create(&ms, "tpl-chapter", "挂着");
    k.call("membership.add", json!({"host": folder, "member": member}));
    k.call(
        "entry.update",
        json!({"id": folder, "overrides": {"accept": false}}),
    );
    k.call(
        "timeline_view.add_lane",
        json!({"view": view, "lane": folder}),
    );
    assert!(k.at(&view, &resident).is_some());
    assert!(k.at(&view, &member).is_none());
    k.call(
        "entry.update",
        json!({"id": folder, "overrides": {"accept": true}}),
    );
    let (ar, am) = (
        k.at(&view, &resident).unwrap(),
        k.at(&view, &member).unwrap(),
    );
    assert!(am > ar, "{ar} {am}");
    // One undo takes the switch and the position back.
    e.ws().undo(&Actor::User).unwrap().unwrap();
    assert!(k.at(&view, &member).is_none());
}
