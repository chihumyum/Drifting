//! What a turn has read of a book is kept record by record
//! (`docs/rust-rewrite/foundations/f3-write-guards.md`): a write is refused
//! only when a record it was made from changed after the turn read it. Other
//! changes to the same book, the author's or the turn's own, cost the turn
//! nothing it has read. Uses the Tiny v3 seed and synthetic names only.

use dr_agent_tools::{AgentTools, CallRequest, Error};
use dr_model::id::BookId;
use dr_testkit::seed::{self, Preset};
use dr_workspace::{Actor, Workspace};
use serde_json::{Value, json};

struct Fixture {
    ws: Workspace,
    book: BookId,
    chapters: Vec<String>,
    character: String,
    tools: AgentTools,
    actor: Actor,
    _dir: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::open_dir(dir.path(), "record-coverage-test").unwrap();
        ws.set_auto_links(false);
        let seeded = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        seeded.write_to(ws.library()).unwrap();
        let book = seeded.books[0].book_id().clone();
        let ids = |template: &str| -> Vec<String> {
            seed::acceptance::entries_by_template(&ws, &book, template)
                .iter()
                .map(|entry| entry["id"].as_str().unwrap().to_owned())
                .collect()
        };
        let chapters = ids("tpl-chapter");
        let character = ids("tpl-character").remove(0);
        assert!(chapters.len() >= 2);
        Self {
            ws,
            book,
            chapters,
            character,
            tools: AgentTools::new(),
            actor: Actor::agent("record-coverage", 1, "call"),
            _dir: dir,
        }
    }

    fn agent(&self, name: &str, arguments: Value) -> dr_agent_tools::Result<Value> {
        self.tools.invoke(
            &self.ws,
            &self.book,
            &self.actor,
            CallRequest {
                name: name.into(),
                arguments,
                revision: None,
                edited_text: None,
            },
        )
    }

    fn read(&self, name: &str, arguments: Value) -> Value {
        self.agent(name, arguments).unwrap()["output"].clone()
    }

    fn author(&self, name: &str, mut arguments: Value) -> Value {
        arguments["book"] = json!(self.book);
        self.ws.call(&Actor::User, name, arguments).unwrap()["output"].clone()
    }

    fn title(&self, id: &str) -> String {
        self.author("entry.get", json!({"id": id}))["title"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    fn rename(&self, id: &str, title: &str) -> dr_agent_tools::Result<Value> {
        self.agent("entry.update", json!({"id": id, "title": title}))
    }

    fn version(&self) -> String {
        self.ws.version(&format!("book:{}", self.book)).unwrap()
    }

    fn receipts(&self) -> usize {
        self.ws
            .library()
            .settlements(Some("record-coverage"), None)
            .unwrap()
            .len()
    }

    /// Writes the app and the author make to a book while a turn runs, none
    /// of them to `chapters[0]`.
    fn unrelated_writes(&self) {
        self.author(
            "writing_day.record",
            json!({"device": "device-000000000000000000000001", "day": "2026-11-12", "words": 321}),
        );
        self.author("book.update", json!({"summary": "Synthetic summary"}));
        self.author(
            "entry.update",
            json!({"id": self.chapters[1], "title": "Synthetic other chapter"}),
        );
        self.author(
            "fact.put",
            json!({"key": "Synthetic fact", "value": "Synthetic value"}),
        );
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.ws.close();
    }
}

fn conflict(result: dr_agent_tools::Result<Value>, record: &str) {
    assert!(
        matches!(&result, Err(Error::Conflict(target)) if target.contains(record)),
        "{result:?}"
    );
}

fn read_required(result: dr_agent_tools::Result<Value>, subject: &str) {
    assert!(
        matches!(&result, Err(Error::ReadRequired(target)) if target.contains(subject)),
        "{result:?}"
    );
}

#[test]
fn an_unrelated_change_to_the_book_costs_the_turn_nothing_it_read() {
    let f = Fixture::new();
    let chapter = &f.chapters[0];
    f.read("entry.get", json!({"id": chapter}));
    let version = f.version();
    f.unrelated_writes();
    assert_ne!(f.version(), version);

    // The chapter was read before all of that, and is written without being
    // read again: its checkpoint and its write are held to the chapter.
    let receipts = f.receipts();
    f.rename(chapter, "Synthetic agent title").unwrap();
    assert_eq!(f.title(chapter), "Synthetic agent title");
    assert!(f.receipts() > receipts);
    assert_eq!(f.title(&f.chapters[1]), "Synthetic other chapter");
}

#[test]
fn a_changed_record_refuses_only_the_write_made_from_it() {
    let f = Fixture::new();
    let (a, b) = (&f.chapters[0], &f.chapters[1]);
    f.read("entry.get", json!({"id": a}));
    f.read("entry.get", json!({"id": b}));
    f.author(
        "entry.update",
        json!({"id": a, "title": "Synthetic author A"}),
    );

    let (version, receipts) = (f.version(), f.receipts());
    conflict(
        f.rename(a, "Synthetic lost update"),
        &format!("entries/{a}"),
    );
    assert_eq!(f.title(a), "Synthetic author A");
    assert_eq!((f.version(), f.receipts()), (version, receipts));
    // What the turn read of the other chapter still stands …
    f.rename(b, "Synthetic agent B").unwrap();
    assert_eq!(f.title(b), "Synthetic agent B");
    // … and the refused write was not a read of the first.
    read_required(f.rename(a, "Synthetic unread"), &format!("entry:{a}"));

    // Conflicts are counted by record: a second one on the same chapter
    // stops the turn for that chapter, whatever else it wrote meanwhile.
    f.read("entry.get", json!({"id": a}));
    f.author(
        "entry.update",
        json!({"id": a, "title": "Synthetic author A again"}),
    );
    let result = f.rename(a, "Synthetic lost again");
    assert!(
        matches!(&result, Err(Error::ConflictLimit(target)) if target.contains(&format!("entries/{a}"))),
        "{result:?}"
    );
    f.read("entry.get", json!({"id": a}));
    let result = f.rename(a, "Synthetic after the limit");
    assert!(matches!(result, Err(Error::ConflictLimit(_))), "{result:?}");
    assert_eq!(f.title(a), "Synthetic author A again");
    f.read("entry.get", json!({"id": b}));
    f.rename(b, "Synthetic agent B again").unwrap();
}

#[test]
fn the_turns_own_write_keeps_what_it_read_of_other_records() {
    let f = Fixture::new();
    let (a, b) = (&f.chapters[0], &f.chapters[1]);
    f.read("entry.list", json!({"all": true}));
    f.rename(a, "Synthetic first").unwrap();
    // Not read again since the list.
    f.rename(b, "Synthetic second").unwrap();
    assert_eq!(f.title(b), "Synthetic second");
    // What a write was made from is never refreshed implicitly.
    read_required(f.rename(a, "Synthetic third"), &format!("entry:{a}"));
    assert_eq!(f.title(a), "Synthetic first");
}

#[test]
fn a_module_is_held_to_what_was_read_of_it() {
    let f = Fixture::new();
    let c = &f.character;
    let target = json!({"entry": c, "module": "mod-patches"});
    let mut create = target.clone();
    create["title"] = json!("Synthetic patch");
    create["body"] = json!("Synthetic body");
    let patch = f.author("module.put_patch", create)["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let put = |body: &str| {
        let mut input = target.clone();
        input["id"] = json!(patch);
        input["title"] = json!("Synthetic patch");
        input["body"] = json!(body);
        f.agent("module.put_patch", input)
    };
    let stored = || {
        f.author("module.read", target.clone())["patches"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == patch.as_str())
            .unwrap()["body"]
            .clone()
    };

    // A list of the entry's modules does not show the patch.
    f.read("module.list", json!({"id": c}));
    read_required(put("Synthetic unread body"), &format!("patches/{patch}"));
    assert_eq!(stored(), "Synthetic body");

    // The module was read; the entry's title and its other modules are not
    // part of what was read of it.
    f.read("module.read", target.clone());
    f.author(
        "entry.update",
        json!({"id": c, "title": "Synthetic renamed owner"}),
    );
    f.author(
        "module.set_field",
        json!({"entry": c, "module": "mod-fields", "field": "summary", "value": "Synthetic summary"}),
    );
    put("Synthetic agent body").unwrap();
    assert_eq!(stored(), "Synthetic agent body");

    // The patch itself is.
    f.read("module.read", target.clone());
    let mut edit = target.clone();
    edit["id"] = json!(patch);
    edit["title"] = json!("Synthetic patch");
    edit["body"] = json!("Synthetic author body");
    f.author("module.put_patch", edit);
    conflict(put("Synthetic lost body"), &format!("patches/{patch}"));
    assert_eq!(stored(), "Synthetic author body");
}

#[test]
fn removing_a_membership_needs_a_read_of_that_membership() {
    let f = Fixture::new();
    let member = &f.chapters[0];
    let lane = f.author(
        "entry.create",
        json!({"title": "Synthetic lane", "template": "tpl-storyline"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    f.author("membership.add", json!({"host": lane, "member": member}));
    let stored = || {
        f.author("membership.list", json!({}))
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["host"] == lane.as_str() && m["member"] == member.as_str())
    };
    let remove = || f.agent("membership.remove", json!({"host": lane, "member": member}));

    // Both entries and the timeline were read, the membership was not.
    f.read("entry.get", json!({"id": lane}));
    f.read("entry.get", json!({"id": member}));
    f.read("timeline_view.list", json!({}));
    read_required(remove(), "membership:");
    assert!(stored());

    // The members of its level are a read of it. An unrelated membership
    // added meanwhile is not a change of this one.
    f.read("level.get", json!({"id": lane}));
    f.author(
        "membership.add",
        json!({"host": lane, "member": f.chapters[1]}),
    );
    remove().unwrap();
    assert!(!stored());

    // Adding a membership replaces nothing: the two entries are enough.
    f.read("entry.get", json!({"id": lane}));
    f.read("entry.get", json!({"id": member}));
    f.agent("membership.add", json!({"host": lane, "member": member}))
        .unwrap();
    assert!(stored());
    // Ordering one that exists replaces its order, and that needs a read of
    // the membership itself.
    let order = || {
        f.agent(
            "membership.add",
            json!({"host": lane, "member": member, "pos": "a5"}),
        )
    };
    f.read("entry.get", json!({"id": lane}));
    f.read("entry.get", json!({"id": member}));
    read_required(order(), "memberships/");
    f.read("entry.get", json!({"id": lane}));
    f.read("entry.get", json!({"id": member}));
    f.read("membership.list", json!({}));
    order().unwrap();
    assert!(
        f.author("membership.list", json!({}))
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["host"] == lane.as_str()
                && m["member"] == member.as_str()
                && m["pos"] == "a5")
    );
}

#[test]
fn a_view_replacement_is_held_to_the_view_it_replaces() {
    let f = Fixture::new();
    let listed = || f.read("timeline_view.list", json!({}))[0].clone();
    let view = listed();
    let id = view["id"].as_str().unwrap().to_owned();
    let put = |name: &str| {
        let mut replacement = view.clone();
        replacement["name"] = json!(name);
        f.agent("timeline_view.put", json!({"view": replacement}))
    };
    let name = || {
        f.author("timeline_view.list", json!({}))
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == id.as_str())
            .unwrap()["name"]
            .clone()
    };

    // Another view appears, and the book changes elsewhere: the view that
    // was read is as it was.
    f.unrelated_writes();
    f.author(
        "timeline_view.put",
        json!({"view": {"id": "synthetic-other-view", "name": "Synthetic other", "lanes": []}}),
    );
    put("Synthetic agent view").unwrap();
    assert_eq!(name(), "Synthetic agent view");

    // The view itself changes after it was read.
    let view = listed();
    let put = |name: &str| {
        let mut replacement = view.clone();
        replacement["name"] = json!(name);
        f.agent("timeline_view.put", json!({"view": replacement}))
    };
    f.author(
        "timeline_view.rename",
        json!({"view": id, "name": "Synthetic author view"}),
    );
    conflict(put("Synthetic lost view"), &format!("timeline_views/{id}"));
    assert_eq!(name(), "Synthetic author view");

    // A view the turn creates is held to the list it was not in: one made
    // elsewhere under the same id is not overwritten.
    listed();
    let create = |name: &str| {
        f.agent(
            "timeline_view.put",
            json!({"view": {"id": "synthetic-new-view", "name": name, "lanes": []}}),
        )
    };
    f.author(
        "timeline_view.put",
        json!({"view": {"id": "synthetic-new-view", "name": "Synthetic made elsewhere", "lanes": []}}),
    );
    conflict(create("Synthetic mine"), "timeline_views");
    listed();
    f.author(
        "fact.put",
        json!({"key": "Synthetic later fact", "value": "Synthetic"}),
    );
    f.agent(
        "timeline_view.put",
        json!({"view": {"id": "synthetic-agent-view", "name": "Synthetic agent made", "lanes": []}}),
    )
    .unwrap();
}
