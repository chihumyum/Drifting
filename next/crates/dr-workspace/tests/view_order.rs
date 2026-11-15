//! A lane's order while it is in a view and after it leaves (`kernel-v5.md`
//! §4, §16 「泳道」): every entry hung on a lane gets a position on the scale,
//! also when it comes back from Recently Deleted or when its lane takes
//! entries from elsewhere again; what only lives under a lane gets none (DV,
//! 2026-11-16: a lane holds only what is hung on it, and a folder's order is
//! always its manual order).
mod common;
use common::*;
use dr_workspace::Actor;
use serde_json::{Value, json};

struct Book<'a> {
    e: &'a Env,
    b: String,
}

impl<'a> Book<'a> {
    fn new(e: &'a Env) -> Self {
        Self { b: e.book(), e }
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
    /// Whether `timeline_view.list` shows `entry` on the scale of `view`.
    fn shown(&self, view: &str, entry: &str) -> bool {
        self.e
            .out("timeline_view.list", json!({"book": self.b}))
            .as_array()
            .unwrap()
            .iter()
            .filter(|v| v["id"] == view)
            .flat_map(|v| v["placements"].as_array().unwrap().clone())
            .any(|p| p["entry"] == entry)
    }
    /// Stores `lane` in `view` directly, as a book written before a lane had
    /// to take entries from elsewhere could (the command refuses it now).
    fn store_lane(&self, view: &str, lane: &str) {
        let book = dr_model::id::BookId::parse(&self.b).unwrap();
        let view = dr_model::id::TimelineViewId::parse(view).unwrap();
        let lane = dr_model::id::EntryId::parse(lane).unwrap();
        self.e
            .ws()
            .library()
            .open_doc(&format!("book:{}", self.b), dr_store::OpenDoc::Existing)
            .unwrap()
            .write(dr_store::Origin::Import, move |doc| {
                dr_doc::v3::BorrowedBookV3::new(doc, &book)
                    .unwrap()
                    .txn()
                    .timeline_view(&view)
                    .unwrap()
                    .put_lane(&lane, None)
                    .unwrap();
            })
            .unwrap();
    }
}

/// DX 12, after DV: an entry hung on a lane and trashed before the lane went
/// into the view gets a position when it comes back.
#[test]
fn an_entry_restored_onto_a_lane_that_entered_a_view_meanwhile_is_placed() {
    let e = env();
    let k = Book::new(&e);
    let ms = k.root("tpl-manuscript");
    let storylines = k.root("tpl-storylines");
    let view = k.view();
    let line = k.create(&storylines, "tpl-storyline", "主线");
    let one = k.create(&ms, "tpl-chapter", "一");
    let two = k.create(&ms, "tpl-chapter", "二");
    for c in [&one, &two] {
        k.call("membership.add", json!({"host": line, "member": c}));
    }
    k.call("entry.trash", json!({"id": two}));
    k.call(
        "timeline_view.add_lane",
        json!({"view": view, "lane": line}),
    );
    assert!(k.at(&view, &two).is_none());
    k.call("entry.restore", json!({"id": two}));
    let (a1, a2) = (k.at(&view, &one).unwrap(), k.at(&view, &two).unwrap());
    assert!(a2 > a1, "{a1} {a2}");
}

/// DV: coming back to another residence takes no position away. The entry
/// lived in a lane with both switches and hung on it; the lane is trashed
/// with it, the entry alone is restored into the nearest level, and when the
/// lane comes back the entry is on it where it was.
#[test]
fn an_entry_restored_elsewhere_keeps_its_place_on_the_lane_it_hangs_on() {
    let e = env();
    let k = Book::new(&e);
    let ms = k.root("tpl-manuscript");
    let view = k.view();
    let group = k.create(&ms, "tpl-group", "卷");
    k.call(
        "entry.update",
        json!({"id": group, "overrides": {"accept": true}}),
    );
    let inside = e.out(
        "entry.create",
        json!({"book": k.b, "host": group, "template": "tpl-chapter", "title": "卷中"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(k.parent(&inside), group, "it lives under the lane");
    k.call(
        "timeline_view.add_lane",
        json!({"view": view, "lane": group}),
    );
    let at = k
        .at(&view, &inside)
        .expect("hung on the lane: on the scale");
    k.call("entry.trash", json!({"id": group}));
    k.call("entry.restore", json!({"id": inside}));
    assert_eq!(k.parent(&inside), ms, "it lands in the nearest level");
    assert_eq!(k.at(&view, &inside), Some(at), "its position is kept");
    k.call("entry.restore", json!({"id": group}));
    assert!(k.shown(&view, &inside), "on the lane again where it was");
    assert_eq!(k.at(&view, &inside), Some(at));
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

/// DX 12, after DV: a lane stored in a view while it took no entries from
/// elsewhere (a book from before DV) reads as not in the view; turning
/// 「收别处的条目」 on places what is hung on it, not what lives under it.
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
    k.store_lane(&view, &folder);
    assert!(k.at(&view, &resident).is_none());
    assert!(k.at(&view, &member).is_none());
    k.call(
        "entry.update",
        json!({"id": folder, "overrides": {"accept": true}}),
    );
    assert!(k.at(&view, &member).is_some());
    assert!(k.at(&view, &resident).is_none(), "only what is hung on it");
    // One undo takes the switch and the position back.
    e.ws().undo(&Actor::User).unwrap().unwrap();
    assert!(k.at(&view, &member).is_none());
}

/// The same when it is the template that starts taking entries from
/// elsewhere: the members of its lanes already stored in a view are placed,
/// in the same step as the template.
#[test]
fn members_coming_back_when_the_template_takes_entries_again_are_placed() {
    let e = env();
    let k = Book::new(&e);
    let ms = k.root("tpl-manuscript");
    let view = k.view();
    let accept = |on: bool| {
        let mut t = e
            .out("entry_template.list", json!({"book": k.b}))
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["id"] == "tpl-group")
            .unwrap()
            .clone();
        t["settings"]["accept"] = json!(on);
        k.call("entry_template.put", json!({"template": t}));
    };
    let folder = k.create(&ms, "tpl-group", "卷");
    // One that says so itself does not follow the template.
    let own = k.create(&ms, "tpl-group", "自己定");
    k.call(
        "entry.update",
        json!({"id": own, "overrides": {"accept": true}}),
    );
    let resident = k.create(&folder, "tpl-chapter", "住着");
    let member = k.create(&ms, "tpl-chapter", "挂着");
    let other = k.create(&ms, "tpl-chapter", "挂在另一个上");
    accept(true);
    k.call("membership.add", json!({"host": folder, "member": member}));
    k.call("membership.add", json!({"host": own, "member": other}));
    accept(false);
    k.call(
        "entry.update",
        json!({"id": own, "overrides": {"accept": false}}),
    );
    for lane in [&folder, &own] {
        k.store_lane(&view, lane);
    }
    assert!(k.at(&view, &resident).is_none());
    assert!(k.at(&view, &member).is_none());
    assert!(k.at(&view, &other).is_none());

    accept(true);
    assert!(k.at(&view, &member).is_some());
    assert!(k.at(&view, &resident).is_none(), "only what is hung on it");
    assert!(
        k.at(&view, &other).is_none(),
        "its lane keeps its own setting, off"
    );
    // One undo takes the template and the position back.
    e.ws().undo(&Actor::User).unwrap().unwrap();
    assert!(k.at(&view, &member).is_none());
    // Saving the template again with nothing changed places nothing.
    accept(false);
    assert!(k.at(&view, &member).is_none());
}
