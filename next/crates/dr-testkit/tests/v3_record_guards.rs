//! Write guards on the records of a book document
//! (`docs/rust-rewrite/foundations/f3-write-guards.md`).
//!
//! A book document holds every structural collection of a book. A guarded
//! write is held to the records it replaces or was derived from: any other
//! write to the same book leaves it valid, a change to one of those records
//! refuses it, and stored data a filtered query does not show still counts.
//! Uses only the canonical Tiny v3 seed and synthetic entity names.

use dr_testkit::seed::{self, Preset};
use dr_workspace::{
    Actor, Expected, RecordKey, RecordObservation, Workspace, WritePreconditions, library_options,
};
use serde_json::{Value, json};

struct Env {
    dir: tempfile::TempDir,
    ws: Workspace,
    book: String,
    doc: String,
}

fn open(dir: &tempfile::TempDir) -> Workspace {
    let ws = Workspace::open_dir(dir.path(), "0.2.0-dev").unwrap();
    ws.set_auto_links(false);
    ws
}

impl Env {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let store = dr_store::Library::open(dir.path(), library_options("0.2.0-dev")).unwrap();
        let made = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        let book = made.books[0].book_id().to_string();
        made.write_to(&store).unwrap();
        store.close().unwrap();
        let ws = open(&dir);
        let doc = format!("book:{book}");
        Self { dir, ws, book, doc }
    }

    /// Close the library for good and open it again, as a restart does.
    fn reopen(&mut self) {
        let scratch = tempfile::tempdir().unwrap();
        let placeholder = Workspace::open_dir(scratch.path(), "0.2.0-dev").unwrap();
        std::mem::replace(&mut self.ws, placeholder)
            .shutdown()
            .unwrap();
        std::mem::replace(&mut self.ws, open(&self.dir))
            .shutdown()
            .unwrap();
    }

    fn out(&self, name: &str, input: Value) -> Value {
        self.ws.call(&Actor::User, name, input).unwrap()["output"].clone()
    }

    fn observe(&self, keys: &[RecordKey]) -> Vec<RecordObservation> {
        self.ws.observe_records(&self.doc, keys).unwrap()
    }

    fn one(&self, key: RecordKey) -> RecordObservation {
        self.observe(&[key]).remove(0)
    }

    fn read(&self, keys: &[RecordKey]) -> WritePreconditions {
        WritePreconditions::from_records(self.observe(keys))
    }

    fn guarded(
        &self,
        name: &str,
        input: Value,
        guards: WritePreconditions,
    ) -> dr_workspace::Result<Value> {
        self.ws.call_guarded(&Actor::User, name, input, guards)
    }

    fn root(&self, template: &str) -> String {
        self.out("entry.list", json!({"book": self.book, "all": true}))
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["template"] == template)
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    fn create(&self, parent: &str, template: &str, title: &str) -> String {
        self.out(
            "entry.create",
            json!({"book": self.book, "parent": parent, "template": template, "title": title}),
        )["id"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    /// A storyline lane and a chapter that belongs to it.
    fn lane_and_chapter(&self, name: &str) -> (String, String) {
        let lane = self.create(
            &self.root("tpl-storylines"),
            "tpl-storyline",
            &format!("Synthetic lane {name}"),
        );
        let chapter = self.create(
            &self.root("tpl-manuscript"),
            "tpl-chapter",
            &format!("Synthetic chapter {name}"),
        );
        (lane, chapter)
    }

    fn view_row(&self, view: &str) -> Value {
        self.out("timeline_view.list", json!({"book": self.book}))
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["id"] == view)
            .unwrap()
            .clone()
    }

    /// Writes the app makes to a book all the time, none of them to a
    /// timeline view: the writing-day recorder, another entry, a project fact.
    fn unrelated_writes(&self, chapter: &str) {
        self.out(
            "writing_day.record",
            json!({"book": self.book, "device": "device-000000000000000000000001",
                "day": "2026-11-12", "words": 1234}),
        );
        self.out(
            "entry.update",
            json!({"book": self.book, "id": chapter, "title": "Synthetic chapter renamed"}),
        );
        self.out(
            "fact.put",
            json!({"book": self.book, "key": "Synthetic fact", "value": "Synthetic value"}),
        );
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        self.ws.close();
    }
}

fn conflict(result: dr_workspace::Result<Value>, needle: &str) -> String {
    let error = result.unwrap_err();
    assert_eq!(error.code(), "conflict", "{error}");
    let message = error.to_string();
    assert!(message.contains(needle), "{message}");
    message
}

#[test]
fn an_unrelated_write_to_the_book_does_not_invalidate_a_record_guard() {
    let e = Env::new();
    let (lane, chapter) = e.lane_and_chapter("unrelated");
    let view = "synthetic-unrelated-view";
    let put = |name: &str| json!({"book": e.book, "view": {"id": view, "name": name, "lanes": [{"entry": lane}]}});
    e.out("timeline_view.put", put("Synthetic before"));

    let whole_book = WritePreconditions::from_observations([e.ws.observe(&e.doc).unwrap()]);
    let version = e.ws.version(&e.doc).unwrap();
    assert_eq!(whole_book.versions[&e.doc], version);
    let record = e.read(&[RecordKey::timeline_view(view)]);

    e.unrelated_writes(&chapter);
    assert_ne!(e.ws.version(&e.doc).unwrap(), version);

    // A caller that asks for the whole book to hold still is still refused …
    conflict(
        e.guarded("timeline_view.put", put("Synthetic stale"), whole_book),
        "stale observation:",
    );
    assert_eq!(e.view_row(view)["name"], "Synthetic before");
    // … and the caller that named the record it replaces is not.
    e.guarded("timeline_view.put", put("Synthetic after"), record)
        .unwrap();
    assert_eq!(e.view_row(view)["name"], "Synthetic after");
}

#[test]
fn a_changed_record_refuses_the_write_and_nothing_is_written() {
    let e = Env::new();
    let (lane, _) = e.lane_and_chapter("changed");
    let view = "synthetic-changed-view";
    e.out(
        "timeline_view.put",
        json!({"book": e.book, "view": {"id": view, "name": "Synthetic read", "lanes": [{"entry": lane}]}}),
    );
    let record = e.read(&[RecordKey::timeline_view(view)]);

    e.out(
        "timeline_view.rename",
        json!({"book": e.book, "view": view, "name": "Synthetic renamed elsewhere"}),
    );
    let before = (
        e.ws.version(&e.doc).unwrap(),
        e.one(RecordKey::timeline_view(view)).digest,
        e.ws.journal(None, 1000).unwrap().len(),
    );
    let message = conflict(
        e.guarded(
            "timeline_view.put",
            json!({"book": e.book, "view": {"id": view, "name": "Synthetic overwrite", "lanes": []}}),
            record,
        ),
        "stale observation:",
    );
    assert!(
        message.contains(&format!("timeline_views/{view}")),
        "{message}"
    );
    assert_eq!(
        before,
        (
            e.ws.version(&e.doc).unwrap(),
            e.one(RecordKey::timeline_view(view)).digest,
            e.ws.journal(None, 1000).unwrap().len(),
        ),
        "a refused write commits nothing and leaves no undo step"
    );
    let row = e.view_row(view);
    assert_eq!(row["name"], "Synthetic renamed elsewhere");
    assert_eq!(row["lanes"].as_array().unwrap().len(), 1);
}

#[test]
fn stored_data_a_filtered_read_hides_is_part_of_the_record() {
    let e = Env::new();
    let (lane, chapter) = e.lane_and_chapter("hidden");
    let view = "synthetic-hidden-view";
    e.out(
        "timeline_view.put",
        json!({"book": e.book, "view": {"id": view, "name": "Synthetic hidden", "lanes": [{"entry": lane}]}}),
    );
    let place = |at: f64| {
        e.out(
            "timeline_view.place",
            json!({"book": e.book, "view": view, "entry": chapter, "lane": lane, "at": at, "span": 7.0}),
        )
    };
    let trash = |name: &str| e.out(name, json!({"book": e.book, "id": lane}));
    place(41.0);
    trash("entry.trash");

    // The query hides the placement while its lane is in the trash; the
    // record observation shows what is stored.
    let listed = e.view_row(view);
    assert!(listed["placements"].as_array().unwrap().is_empty());
    let seen = e.one(RecordKey::timeline_view(view));
    assert_eq!(seen.value["placements"][&chapter]["at"], 41.0);

    // Another writer changes only what the query hides.
    trash("entry.restore");
    place(99.0);
    trash("entry.trash");
    assert_eq!(e.view_row(view), listed, "the filtered read cannot tell");

    // A whole-view replacement built from that filtered read would drop the
    // placement. Its guard was read before the hidden change: refused.
    conflict(
        e.guarded(
            "timeline_view.put",
            json!({"book": e.book, "view": listed}),
            WritePreconditions::from_records([seen]),
        ),
        "stale observation:",
    );
    let stored = e.one(RecordKey::timeline_view(view));
    assert_eq!(stored.value["placements"][&chapter]["at"], 99.0);
    assert_eq!(stored.value["placements"][&chapter]["span"], 7.0);
    trash("entry.restore");
    assert_eq!(e.view_row(view)["placements"][0]["at"], 99.0);
}

#[test]
fn a_replacement_needs_a_read_of_what_it_replaces() {
    let e = Env::new();
    let (lane, chapter) = e.lane_and_chapter("required");
    let view = "synthetic-required-view";
    let put = |name: &str| json!({"book": e.book, "view": {"id": view, "name": name, "lanes": [{"entry": lane}]}});
    let rename = |name: &str| json!({"book": e.book, "view": view, "name": name});
    e.out("timeline_view.put", put("Synthetic one"));

    // No guard at all, and a fresh read of some other record: neither is a
    // read of the view.
    conflict(
        e.guarded(
            "timeline_view.put",
            put("Synthetic two"),
            WritePreconditions::default(),
        ),
        "read required:",
    );
    let message = conflict(
        e.guarded(
            "timeline_view.put",
            put("Synthetic two"),
            e.read(&[RecordKey::entry(&chapter)]),
        ),
        "read required:",
    );
    assert!(
        message.contains(&format!("timeline_views/{view}")),
        "{message}"
    );
    // A read of one field covers a write of that field, not of the record.
    let name = RecordKey::timeline_view(view).at(["name"]);
    conflict(
        e.guarded(
            "timeline_view.put",
            put("Synthetic two"),
            e.read(std::slice::from_ref(&name)),
        ),
        "read required:",
    );
    assert_eq!(e.view_row(view)["name"], "Synthetic one");
    e.guarded(
        "timeline_view.rename",
        rename("Synthetic two"),
        e.read(&[name]),
    )
    .unwrap();
    // A read of the record, or of its whole collection, covers both.
    e.guarded(
        "timeline_view.rename",
        rename("Synthetic three"),
        e.read(&[RecordKey::timeline_view(view)]),
    )
    .unwrap();
    e.guarded(
        "timeline_view.put",
        put("Synthetic four"),
        e.read(&[RecordKey::collection("timeline_views")]),
    )
    .unwrap();
    assert_eq!(e.view_row(view)["name"], "Synthetic four");

    // `require_all: false` only stops asking for reads the caller did not
    // offer. What it did offer is still compared.
    let mut offered = e.read(&[RecordKey::entry(&chapter)]);
    offered.require_all = false;
    e.guarded("timeline_view.put", put("Synthetic five"), offered)
        .unwrap();
    let mut stale = e.read(&[RecordKey::timeline_view(view)]);
    stale.require_all = false;
    e.out("timeline_view.rename", rename("Synthetic six"));
    conflict(
        e.guarded("timeline_view.put", put("Synthetic seven"), stale),
        "stale observation:",
    );
    assert_eq!(e.view_row(view)["name"], "Synthetic six");

    // A view that does not exist yet is a record too: its absence is read,
    // and a view someone else creates under that id is not overwritten.
    let new = "synthetic-new-view";
    let absent = e.read(&[RecordKey::timeline_view(new)]);
    let create =
        |name: &str| json!({"book": e.book, "view": {"id": new, "name": name, "lanes": []}});
    e.out("timeline_view.put", create("Synthetic created elsewhere"));
    conflict(
        e.guarded("timeline_view.put", create("Synthetic mine"), absent),
        "stale observation:",
    );
    assert_eq!(e.view_row(new)["name"], "Synthetic created elsewhere");
}

#[test]
fn a_field_guard_ignores_the_rest_of_its_record_and_a_record_guard_does_not() {
    let e = Env::new();
    let (_, chapter) = e.lane_and_chapter("fields");
    let entry = RecordKey::entry(&chapter);
    let title = entry.clone().at(["title"]);
    let rename = |title: &str| json!({"book": e.book, "id": chapter, "title": title});
    let layout = |x: f64| {
        e.out(
            "entry.update",
            json!({"book": e.book, "id": chapter, "layout": {"board": [x, 2.0]}}),
        )
    };

    let field = e.read(std::slice::from_ref(&title));
    let record = e.read(std::slice::from_ref(&entry));
    layout(1.0);
    // The whole entry changed; its title did not.
    conflict(
        e.guarded("entry.update", rename("Synthetic stale entry"), record),
        "stale observation:",
    );
    e.guarded("entry.update", rename("Synthetic title"), field)
        .unwrap();
    let read = e.out("entry.get", json!({"book": e.book, "id": chapter}));
    assert_eq!(read["title"], "Synthetic title");
    assert_eq!(read["layout"]["board"], json!([1.0, 2.0]));

    // entry.update writes the fields it names and no others: the title this
    // command sets leaves the layout record state untouched, and a layout
    // write leaves the title's.
    let layout_key = entry.clone().at(["layout"]);
    let before = e.observe(&[title.clone(), layout_key.clone()]);
    e.out("entry.update", rename("Synthetic title again"));
    let after_title = e.observe(&[title.clone(), layout_key.clone()]);
    assert_ne!(before[0].digest, after_title[0].digest);
    assert_eq!(before[1].digest, after_title[1].digest);
    layout(5.0);
    let after_layout = e.observe(&[title.clone(), layout_key]);
    assert_eq!(after_title[0].digest, after_layout[0].digest);
    assert_ne!(after_title[1].digest, after_layout[1].digest);

    // A stale title is refused whatever else is current.
    let stale = e.read(std::slice::from_ref(&title));
    e.out("entry.update", rename("Synthetic renamed elsewhere"));
    conflict(
        e.guarded("entry.update", rename("Synthetic lost update"), stale),
        "stale observation:",
    );
    assert_eq!(
        e.out("entry.get", json!({"book": e.book, "id": chapter}))["title"],
        "Synthetic renamed elsewhere"
    );
}

#[test]
fn the_order_of_a_levels_children_is_a_record() {
    let e = Env::new();
    let manuscript = e.root("tpl-manuscript");
    let first = e.create(&manuscript, "tpl-chapter", "Synthetic first");
    let second = e.create(&manuscript, "tpl-chapter", "Synthetic second");
    let children = RecordKey::children_of(Some(&manuscript));
    let order = e.one(children.clone());
    let listed: Vec<&str> = order
        .value
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_str().unwrap())
        .collect();
    assert_eq!(
        &listed[listed.len() - 2..],
        [first.as_str(), second.as_str()]
    );

    // Renaming a child is not a change of order.
    e.out(
        "entry.update",
        json!({"book": e.book, "id": first, "title": "Synthetic first renamed"}),
    );
    assert_eq!(e.one(children.clone()).digest, order.digest);

    // A move planned against a list that has since grown is refused: its
    // index no longer means the place the caller saw.
    let read = e.read(&[children.clone(), RecordKey::entry(&second)]);
    e.create(&manuscript, "tpl-chapter", "Synthetic third");
    assert_ne!(e.one(children.clone()).digest, order.digest);
    conflict(
        e.guarded(
            "entry.move",
            json!({"book": e.book, "id": second, "parent": manuscript, "index": 0}),
            read,
        ),
        "stale observation:",
    );
    let read = e.read(&[children.clone(), RecordKey::entry(&second)]);
    e.guarded(
        "entry.move",
        json!({"book": e.book, "id": second, "parent": manuscript, "index": 0}),
        read,
    )
    .unwrap();
    assert_eq!(e.one(children).value[0], second.as_str());
}

#[test]
fn a_guarded_create_checks_its_reads_before_it_registers_prose() {
    let e = Env::new();
    let manuscript = e.root("tpl-manuscript");
    let create = |title: &str| {
        json!({"book": e.book, "parent": manuscript, "template": "tpl-chapter",
            "title": title, "bodies": {"mod-prose": "Synthetic body"}})
    };
    let docs = || e.ws.library().docs(Some(&e.book), None).unwrap().len();
    let before = docs();

    // A create replaces nothing stored, so it needs no read of the book …
    e.guarded(
        "entry.create",
        create("Synthetic unread"),
        WritePreconditions::default(),
    )
    .unwrap();
    assert!(docs() > before);
    // … but a write that does replace something still does.
    conflict(
        e.guarded(
            "entry.update",
            json!({"book": e.book, "id": manuscript, "title": "Synthetic unread rename"}),
            WritePreconditions::default(),
        ),
        "read required:",
    );
    // What a create did read still has to hold. The level it was created
    // under changed since it was read: refused before any prose document is
    // registered for the entry.
    let parent = e.read(&[RecordKey::entry(&manuscript)]);
    e.out(
        "entry.update",
        json!({"book": e.book, "id": manuscript, "title": "Synthetic manuscript renamed"}),
    );
    // (Renaming a level may register its description; count from here.)
    let before = docs();
    conflict(
        e.guarded("entry.create", create("Synthetic stale parent"), parent),
        "stale observation:",
    );
    assert_eq!(docs(), before);

    let parent = e.read(&[RecordKey::entry(&manuscript)]);
    let created = e
        .guarded("entry.create", create("Synthetic created"), parent)
        .unwrap();
    let doc = format!(
        "body:{}/mod-prose",
        created["output"]["id"].as_str().unwrap()
    );
    assert_eq!(
        e.out("prose.read", json!({"doc": doc}))["paragraphs"][0]["text"],
        "Synthetic body"
    );
    assert!(docs() > before);
}

#[test]
fn record_digests_survive_a_reopen_and_reject_malformed_guards() {
    let mut e = Env::new();
    let (lane, chapter) = e.lane_and_chapter("reopen");
    let view = "synthetic-reopen-view";
    e.out(
        "timeline_view.put",
        json!({"book": e.book, "view": {"id": view, "name": "Synthetic reopen", "lanes": [{"entry": lane}]}}),
    );
    let keys = [
        RecordKey::timeline_view(view),
        RecordKey::entry(&chapter),
        RecordKey::entry(&chapter).at(["title"]),
        RecordKey::children_of(None),
        RecordKey::collection("templates"),
        RecordKey::collection("meta"),
        // Never written in this book: absent, not an error.
        RecordKey::patch("synthetic-missing-patch"),
        RecordKey::collection("patches"),
    ];
    let before = e.observe(&keys);
    assert!(before[6].value.is_null());

    // A digest names stored state, not this process's view of it.
    e.reopen();
    let after = e.observe(&keys);
    for (a, b) in before.iter().zip(&after) {
        assert_eq!(a.digest, b.digest, "{:?}", a.key);
        assert_eq!(a.value, b.value, "{:?}", a.key);
    }

    assert_eq!(
        e.ws.observe_records(&e.doc, &[RecordKey::collection("no_such_collection")])
            .unwrap_err()
            .code(),
        "invalid"
    );
    let rename = json!({"book": e.book, "view": view, "name": "Synthetic malformed"});
    let mut bad_digest = e.read(&[RecordKey::timeline_view(view)]);
    bad_digest.records[0].expected = Expected::Digest("你好".into());
    let mut prose_record = e.read(&[RecordKey::timeline_view(view)]);
    prose_record.records[0].doc = format!("body:{chapter}/mod-prose");
    let no_values =
        WritePreconditions::default().with_value(&e.doc, RecordKey::timeline_view(view), []);
    for guards in [bad_digest, prose_record, no_values] {
        assert_eq!(
            e.guarded("timeline_view.rename", rename.clone(), guards)
                .unwrap_err()
                .code(),
            "invalid"
        );
    }
    assert_eq!(e.view_row(view)["name"], "Synthetic reopen");
}

#[test]
fn a_field_edit_is_held_to_the_value_it_was_made_from() {
    let e = Env::new();
    let (_, chapter) = e.lane_and_chapter("values");
    let title = RecordKey::entry(&chapter).at(["title"]);
    let shown = "Synthetic chapter values";
    let rename = |to: &str| json!({"book": e.book, "id": chapter, "title": to});
    // The view showed `from`; its author typed `to`. No observation is made.
    let edit = |from: &str, to: &str| {
        e.guarded(
            "entry.update",
            rename(to),
            WritePreconditions::default().with_value(
                &e.doc,
                title.clone(),
                [json!(from), json!(to)],
            ),
        )
    };
    let read = || e.out("entry.get", json!({"book": e.book, "id": chapter}))["title"].clone();

    // Other writes to the book, and to other fields of the same entry, are
    // not a change of the title.
    e.unrelated_writes(&e.lane_and_chapter("values elsewhere").1);
    e.out(
        "entry.update",
        json!({"book": e.book, "id": chapter, "layout": {"board": [3.0, 4.0]}}),
    );
    edit(shown, "Synthetic edited").unwrap();
    assert_eq!(read(), "Synthetic edited");

    // Someone else changed the title after it was shown: the draft is refused
    // and their title stays.
    e.out("entry.update", rename("Synthetic changed elsewhere"));
    conflict(
        edit("Synthetic edited", "Synthetic draft"),
        "stale observation:",
    );
    assert_eq!(read(), "Synthetic changed elsewhere");
    // The same edit already made elsewhere is not a conflict.
    edit("Synthetic edited", "Synthetic changed elsewhere").unwrap();
    assert_eq!(read(), "Synthetic changed elsewhere");
    // An expected value never stands for a whole record.
    conflict(
        e.guarded(
            "entry.update",
            rename("Synthetic by record"),
            WritePreconditions::default().with_value(
                &e.doc,
                RecordKey::entry(&chapter),
                [json!("Synthetic changed elsewhere")],
            ),
        ),
        "stale observation:",
    );

    // A typed field that was never set is `null`; a text (a patch body) is
    // its string.
    let entries = e.out("entry.list", json!({"book": e.book, "all": true}));
    let character = entries
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["template"] == "tpl-character")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let target = json!({"book": e.book, "entry": character, "module": "mod-fields"});
    let field = RecordKey::entry(&character).at(["fields", "mod-fields", "synthetic-unset"]);
    let unset = e.one(field.clone());
    assert!(unset.value.is_null());
    let summary = RecordKey::entry(&character).at(["fields", "mod-fields", "summary"]);
    let before = e.one(summary.clone()).value;
    let set = |from: &Value, to: &str| {
        let mut input = target.clone();
        input["field"] = json!("summary");
        input["value"] = json!(to);
        e.guarded(
            "module.set_field",
            input,
            WritePreconditions::default().with_value(
                &e.doc,
                summary.clone(),
                [from.clone(), json!(to)],
            ),
        )
    };
    set(&before, "Synthetic summary").unwrap();
    conflict(set(&before, "Synthetic lost summary"), "stale observation:");
    assert_eq!(e.one(summary).value, "Synthetic summary");

    let patches = json!({"book": e.book, "entry": character, "module": "mod-patches"});
    let mut create = patches.clone();
    create["title"] = json!("Synthetic patch");
    create["body"] = json!("Synthetic patch body");
    let patch = e.out("module.put_patch", create)["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let put = |title: &str, from: &str, to: &str| {
        let mut input = patches.clone();
        input["id"] = json!(patch);
        input["title"] = json!(title);
        input["body"] = json!(to);
        e.guarded(
            "module.put_patch",
            input,
            WritePreconditions::default()
                .with_value(
                    &e.doc,
                    RecordKey::patch(&patch).at(["title"]),
                    [json!(title)],
                )
                .with_value(
                    &e.doc,
                    RecordKey::patch(&patch).at(["body"]),
                    [json!(from), json!(to)],
                ),
        )
    };
    put(
        "Synthetic patch",
        "Synthetic patch body",
        "Synthetic patch body, edited",
    )
    .unwrap();
    conflict(
        put(
            "Synthetic patch",
            "Synthetic patch body",
            "Synthetic lost body",
        ),
        "stale observation:",
    );
    assert_eq!(
        e.one(RecordKey::patch(&patch).at(["body"])).value,
        "Synthetic patch body, edited"
    );
}
