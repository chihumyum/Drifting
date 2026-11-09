//! Filtered timeline reads never authorize deleting retained data. All fixtures
//! use the v3 seed and public Workspace/AgentTools calls, without a model.
use std::sync::Barrier;

use dr_agent_tools::{AgentTools, CallRequest, Error};
use dr_doc::v3::novel::{TPL_CHARACTER, TPL_STORYLINE};
use dr_model::id::{BookId, TimePinId, TimelineViewId};
use dr_testkit::seed::{self, Preset};
use dr_workspace::{Actor, Workspace};
use serde_json::{Value, json};

struct Fixture {
    ws: Workspace,
    book: BookId,
    view: String,
    original: Value,
    _dir: tempfile::TempDir,
}
impl Fixture {
    fn new() -> Self {
        Self::from_seed(seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap())
    }
    fn from_seed(seed: seed::SeededV3) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::open_dir(dir.path(), "k6-timeline-coverage").unwrap();
        let book = seed.books[0].book_id().clone();
        seed.write_to(ws.library()).unwrap();
        let original = ws
            .call(&Actor::User, "timeline_view.list", json!({"book":book}))
            .unwrap()["output"][0]
            .clone();
        let view = original["id"].as_str().unwrap().into();
        Self {
            ws,
            book,
            view,
            original,
            _dir: dir,
        }
    }
    fn author(&self, name: &str, mut args: Value) -> Value {
        args["book"] = json!(self.book);
        self.ws.call(&Actor::User, name, args).unwrap()["output"].clone()
    }
    fn invoke(
        &self,
        tools: &AgentTools,
        actor: &Actor,
        name: &str,
        arguments: Value,
    ) -> dr_agent_tools::Result<Value> {
        tools.invoke(
            &self.ws,
            &self.book,
            actor,
            CallRequest {
                name: name.into(),
                arguments,
                revision: None,
                edited_text: None,
            },
        )
    }
    fn listed(&self, tools: &AgentTools, actor: &Actor) -> Value {
        self.invoke(tools, actor, "timeline_view.list", json!({}))
            .unwrap()["output"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == self.view)
            .unwrap()
            .clone()
    }
    fn raw(&self) -> Value {
        self.ws
            .observe(&format!("book:{}", self.book))
            .unwrap()
            .value
    }
    fn reject_rename(&self, tools: &AgentTools, actor: &Actor) {
        let mut shown = self.listed(tools, actor);
        shown["name"] = json!("Synthetic renamed timeline");
        let before = self.ws.observe(&format!("book:{}", self.book)).unwrap();
        let receipts = self.ws.library().settlements(None, None).unwrap().len();
        let result = self.invoke(tools, actor, "timeline_view.put", json!({"view":shown}));
        assert!(
            matches!(result, Err(Error::ReadRequired(ref message)) if message.contains("hidden lanes, placements or pin data")),
            "{result:?}"
        );
        let after = self.ws.observe(&before.doc).unwrap();
        assert_eq!(after.version, before.version);
        assert_eq!(after.value, before.value);
        assert_eq!(
            self.ws.library().settlements(None, None).unwrap().len(),
            receipts
        );
    }
    fn restored_rename(&self, tools: &AgentTools, actor: &Actor) {
        let mut restored = self.listed(tools, actor);
        assert_eq!(restored, self.original);
        restored["name"] = json!("Synthetic renamed timeline");
        self.invoke(tools, actor, "timeline_view.put", json!({"view":restored}))
            .unwrap();
        assert_eq!(self.listed(tools, actor), restored);
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.ws.close();
    }
}

#[test]
fn trashed_member_placement_survives_rejected_rename_and_restore() {
    let f = Fixture::new();
    let tools = AgentTools::new();
    let actor = Actor::agent("timeline-trashed-member", 1, "rename");
    // This initially complete observation must not survive a later filtered read.
    assert_eq!(f.listed(&tools, &actor), f.original);
    let member = f.original["placements"][0]["entry"].clone();
    f.author("entry.trash", json!({"id":member}));
    let raw = f.raw();
    assert!(
        raw["timeline_views"][&f.view]["placements"]
            .get(member.as_str().unwrap())
            .is_some()
    );
    let shown = f.listed(&tools, &actor);
    assert_eq!(
        shown["placements"].as_array().unwrap().len() + 1,
        f.original["placements"].as_array().unwrap().len()
    );
    f.reject_rename(&tools, &actor);
    f.author("entry.restore", json!({"id":member}));
    f.restored_rename(&tools, &actor);
}

#[test]
fn trashed_lane_and_its_hidden_members_survive_rename_and_restore() {
    let f = Fixture::new();
    let tools = AgentTools::new();
    let actor = Actor::agent("timeline-trashed-lane", 1, "rename");
    let lane = f.original["lanes"][0]["entry"].clone();
    f.author("entry.trash", json!({"id":lane}));
    let raw = f.raw();
    let memberships = raw["memberships"].clone();
    assert!(
        raw["timeline_views"][&f.view]["lanes"]
            .get(lane.as_str().unwrap())
            .is_some()
    );
    assert_eq!(
        f.listed(&tools, &actor)["lanes"].as_array().unwrap().len() + 1,
        f.original["lanes"].as_array().unwrap().len()
    );
    f.reject_rename(&tools, &actor);
    f.author("entry.restore", json!({"id":lane}));
    assert_eq!(f.raw()["memberships"], memberships);
    f.restored_rename(&tools, &actor);
}

#[test]
fn filtered_pin_binding_blocks_whole_put_even_when_counts_are_equal() {
    let f = Fixture::new();
    let tools = AgentTools::new();
    let actor = Actor::agent("timeline-pin-binding", 1, "rename");
    let entries = f.author("entry.list", json!({"all":true}));
    let target = entries
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["template"] == TPL_CHARACTER)
        .unwrap()["id"]
        .clone();
    let pin = TimePinId::new_v7().to_string();
    f.author("timeline_view.put_pin", json!({"view":f.view,"pin":{"id":pin,"at":19.0,"label":"Synthetic bound pin","entry":target}}));
    let before = f.listed(&tools, &actor);
    f.author("entry.trash", json!({"id":target}));
    let filtered = f.listed(&tools, &actor);
    assert_eq!(filtered["lanes"], before["lanes"]);
    assert_eq!(filtered["placements"], before["placements"]);
    assert_eq!(
        filtered["pins"].as_array().unwrap().len(),
        before["pins"].as_array().unwrap().len()
    );
    assert!(
        filtered["pins"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == pin)
            .unwrap()["entry"]
            .is_null()
    );
    let hidden = f.raw()["timeline_views"][&f.view]["pins"][&pin].clone();
    f.reject_rename(&tools, &actor);
    // A pin-only replacement must not erase the same hidden binding either.
    let mut edited = filtered["pins"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == pin)
        .unwrap()
        .clone();
    edited["label"] = json!("Synthetic renamed pin");
    for (name, args) in [
        ("timeline_view.put_pin", json!({"view":f.view,"pin":edited})),
        ("timeline_view.remove_pin", json!({"view":f.view,"pin":pin})),
    ] {
        let before = f.raw();
        let result = f.invoke(&tools, &actor, name, args);
        assert!(
            matches!(result, Err(Error::ReadRequired(ref message)) if message.contains("hidden pin data")),
            "{result:?}"
        );
        assert_eq!(f.raw(), before);
    }
    // Local commands remain usable and must keep the other pin's hidden binding.
    let added = TimePinId::new_v7().to_string();
    f.invoke(
        &tools,
        &actor,
        "timeline_view.put_pin",
        json!({"view":f.view,"pin":{"id":added,"at":29.0,"label":"Synthetic local pin"}}),
    )
    .unwrap();
    assert_eq!(f.raw()["timeline_views"][&f.view]["pins"][&pin], hidden);
    f.author("entry.restore", json!({"id":target}));
    let restored = f.listed(&tools, &actor);
    assert_eq!(
        restored["pins"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == pin)
            .unwrap()["entry"],
        target
    );
}

#[test]
fn unreadable_seed_pin_is_retained_when_the_query_omits_it() {
    // Synthetic imported data can retain a pin that the tolerant query omits.
    // Author commands reject non-finite coordinates, so change the seed before
    // importing it rather than bypassing the live command writer in the test.
    let mut seed = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
    let view = seed.books[0].book.view().timeline_views()[0].clone();
    let mut pin = view.pins[0].clone();
    pin.at = f64::NAN;
    seed.books[0]
        .book
        .edit(dr_model::origin::Origin::Import, |tx| {
            tx.timeline_view(&view.id)?.put_pin(&pin)?;
            Ok(())
        })
        .0
        .unwrap();
    let f = Fixture::from_seed(seed);
    let tools = AgentTools::new();
    let actor = Actor::agent("timeline-unreadable-pin", 1, "rename");
    assert!(
        f.raw()["timeline_views"][&f.view]["pins"]
            .get(pin.id.as_str())
            .is_some()
    );
    assert!(
        f.original["pins"]
            .as_array()
            .unwrap()
            .iter()
            .all(|p| p["id"] != pin.id.as_str())
    );
    f.reject_rename(&tools, &actor);
}

#[test]
fn changed_allow_rules_hide_members_without_authorizing_placement_deletion() {
    let f = Fixture::new();
    let tools = AgentTools::new();
    let actor = Actor::agent("timeline-hidden-membership", 1, "rename");
    let templates = f.author("entry_template.list", json!({}));
    let original = templates
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == TPL_STORYLINE)
        .unwrap()
        .clone();
    let mut changed = original.clone();
    changed["settings"]["allow"] = json!([TPL_CHARACTER]);
    let memberships = f.raw()["memberships"].clone();
    f.author("entry_template.put", json!({"template":changed}));
    let shown = f.listed(&tools, &actor);
    assert_eq!(shown["lanes"], f.original["lanes"]);
    assert!(shown["placements"].as_array().unwrap().is_empty());
    assert_eq!(f.raw()["memberships"], memberships);
    f.reject_rename(&tools, &actor);
    f.author("entry_template.put", json!({"template":original}));
    assert_eq!(f.raw()["memberships"], memberships);
    f.restored_rename(&tools, &actor);
}

#[test]
fn concurrent_whole_view_edits_conflict_then_preserve_both_successful_changes() {
    let f = Fixture::new();
    let a = AgentTools::new();
    let b = AgentTools::new();
    let actor_a = Actor::agent("timeline-concurrent-a", 1, "rename");
    let actor_b = Actor::agent("timeline-concurrent-b", 1, "pin");
    let mut edit_a = f.listed(&a, &actor_a);
    let mut edit_b = f.listed(&b, &actor_b);
    assert!(!edit_b["pins"].as_array().unwrap().is_empty());
    let pin = edit_b["pins"][0]["id"].clone();
    edit_a["name"] = json!("Synthetic concurrent rename");
    edit_b["pins"][0]["label"] = json!("Synthetic concurrent pin label");
    let barrier = Barrier::new(2);
    let (result_a, result_b) = std::thread::scope(|scope| {
        let one = scope.spawn(|| {
            barrier.wait();
            f.invoke(&a, &actor_a, "timeline_view.put", json!({"view":edit_a}))
        });
        let two = scope.spawn(|| {
            barrier.wait();
            f.invoke(&b, &actor_b, "timeline_view.put", json!({"view":edit_b}))
        });
        (one.join().unwrap(), two.join().unwrap())
    });
    assert_eq!(
        usize::from(result_a.is_ok()) + usize::from(result_b.is_ok()),
        1,
        "{result_a:?}; {result_b:?}"
    );
    if let Err(error) = result_a {
        assert!(matches!(error, Error::Conflict(_)), "{error:?}");
        let mut fresh = f.listed(&a, &actor_a);
        fresh["name"] = json!("Synthetic concurrent rename");
        f.invoke(&a, &actor_a, "timeline_view.put", json!({"view":fresh}))
            .unwrap();
    }
    if let Err(error) = result_b {
        assert!(matches!(error, Error::Conflict(_)), "{error:?}");
        let mut fresh = f.listed(&b, &actor_b);
        fresh["pins"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|p| p["id"] == pin)
            .unwrap()["label"] = json!("Synthetic concurrent pin label");
        f.invoke(&b, &actor_b, "timeline_view.put", json!({"view":fresh}))
            .unwrap();
    }
    let final_view = f.listed(&a, &actor_a);
    assert_eq!(final_view["name"], "Synthetic concurrent rename");
    assert_eq!(
        final_view["pins"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == pin)
            .unwrap()["label"],
        "Synthetic concurrent pin label"
    );
    assert_eq!(final_view["lanes"], f.original["lanes"]);
    assert_eq!(final_view["placements"], f.original["placements"]);
}

#[test]
fn hidden_data_is_scoped_to_its_view_and_new_ids_still_require_fresh_observations() {
    let f = Fixture::new();
    let tools = AgentTools::new();
    let actor = Actor::agent("timeline-new-view", 1, "create");
    let member = f.original["placements"][0]["entry"].clone();
    f.author("entry.trash", json!({"id":member}));
    f.listed(&tools, &actor);
    let hidden = f.raw()["timeline_views"][&f.view].clone();
    let id = TimelineViewId::new_v7();
    let fresh = json!({"id":id,"name":"Synthetic new timeline"});
    f.invoke(&tools, &actor, "timeline_view.put", json!({"view":fresh}))
        .unwrap();
    assert_eq!(f.raw()["timeline_views"][&f.view], hidden);
    f.listed(&tools, &actor);
    let id = TimelineViewId::new_v7();
    let author_view = json!({"id":id,"name":"Synthetic author's new timeline"});
    f.author("timeline_view.put", json!({"view":author_view}));
    let before = f.raw();
    let result = f.invoke(
        &tools,
        &actor,
        "timeline_view.put",
        json!({"view":{"id":id,"name":"Synthetic stale new timeline"}}),
    );
    assert!(matches!(result, Err(Error::Conflict(_))), "{result:?}");
    assert_eq!(f.raw(), before);
}

#[test]
fn removing_visible_membership_cannot_delete_a_hidden_lanes_retained_placement() {
    let f = Fixture::new();
    let tools = AgentTools::new();
    let actor = Actor::agent("timeline-hidden-other-membership", 1, "remove");
    let member = f.original["placements"][0]["entry"].clone();
    let memberships = f.author("membership.list", json!({}));
    let hidden_host = memberships
        .as_array()
        .unwrap()
        .iter()
        .find(|m| {
            m["member"] == member
                && f.original["lanes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|l| l["entry"] == m["host"])
        })
        .unwrap()["host"]
        .clone();
    let visible_host = f.author(
        "entry.create",
        json!({"title":"Synthetic visible lane","template":TPL_STORYLINE}),
    )["id"]
        .clone();
    f.author(
        "membership.add",
        json!({"host":visible_host,"member":member}),
    );
    let mut view = f.original.clone();
    view["lanes"]
        .as_array_mut()
        .unwrap()
        .push(json!({"entry":visible_host,"pos":null}));
    view["placements"][0]["at"] = json!(7.5);
    view["placements"][0]["span"] = json!(8.25);
    let expected_placements = view["placements"].clone();
    f.author("timeline_view.put", json!({"view":view}));
    f.author("entry.trash", json!({"id":hidden_host}));
    for (name, args) in [
        (
            "membership.remove",
            json!({"host":visible_host,"member":member}),
        ),
        (
            "timeline_view.remove",
            json!({"view":f.view,"lane":visible_host,"entry":member}),
        ),
    ] {
        f.invoke(&tools, &actor, "entry.list", json!({"all":true}))
            .unwrap();
        f.invoke(&tools, &actor, "membership.list", json!({}))
            .unwrap();
        f.listed(&tools, &actor);
        let before = f.ws.observe(&format!("book:{}", f.book)).unwrap();
        let journal = f.ws.journal(None, 1000).unwrap().len();
        let receipts = f.ws.library().settlements(None, None).unwrap().len();
        let result = f.invoke(&tools, &actor, name, args);
        assert!(
            matches!(result,Err(Error::ReadRequired(ref message)) if message.contains("hidden lanes, placements or pin data")),
            "{result:?}"
        );
        let after = f.ws.observe(&before.doc).unwrap();
        assert_eq!(after.version, before.version);
        assert_eq!(after.value, before.value);
        assert_eq!(f.ws.journal(None, 1000).unwrap().len(), journal);
        assert_eq!(
            f.ws.library().settlements(None, None).unwrap().len(),
            receipts
        );
    }
    f.author("entry.restore", json!({"id":hidden_host}));
    assert_eq!(f.listed(&tools, &actor)["placements"], expected_placements);
    // Fresh complete evidence allows the local operation. The restored lane
    // still owns the placement, which must survive removal of the other edge.
    f.invoke(&tools, &actor, "entry.list", json!({"all":true}))
        .unwrap();
    f.invoke(&tools, &actor, "membership.list", json!({}))
        .unwrap();
    f.listed(&tools, &actor);
    f.invoke(
        &tools,
        &actor,
        "membership.remove",
        json!({"host":visible_host,"member":member}),
    )
    .unwrap();
    assert_eq!(f.listed(&tools, &actor)["placements"], expected_placements);
}
