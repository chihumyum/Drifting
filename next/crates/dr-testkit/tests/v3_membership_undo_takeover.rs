//! Permanent integration regressions. Canonical Tiny v3 seed,
//! public Workspace commands and the real User undo path; no model or UI.

use dr_testkit::seed::{self, Preset};
use dr_workspace::{Actor, Workspace, WsError};
use serde_json::{Value, json};

struct Fixture {
    _dir: tempfile::TempDir,
    ws: Workspace,
    book: String,
    lane: String,
    backup: String,
    member: String,
    view: String,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let store = dr_store::Library::open(dir.path(), dr_workspace::library_options("0.2.0-dev"))
            .unwrap();
        let made = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        let book = made.books[0].book_id().to_string();
        made.write_to(&store).unwrap();
        store.close().unwrap();
        let ws = Workspace::open_dir(dir.path(), "0.2.0-dev").unwrap();
        let entries = ws
            .call(&Actor::User, "entry.list", json!({"book":book,"all":true}))
            .unwrap()["output"]
            .clone();
        let root = |template: &str| {
            entries
                .as_array()
                .unwrap()
                .iter()
                .find(|entry| entry["template"] == template)
                .unwrap()["id"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        let create = |parent: &str, template: &str, title: &str| {
            ws.call(
                &Actor::User,
                "entry.create",
                json!({"book":book,"parent":parent,"template":template,"title":title}),
            )
            .unwrap()["output"]["id"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        let lane = create(
            &root("tpl-storylines"),
            "tpl-storyline",
            "Synthetic undo lane A",
        );
        let backup = create(
            &root("tpl-storylines"),
            "tpl-storyline",
            "Synthetic undo lane B",
        );
        let member = create(
            &root("tpl-manuscript"),
            "tpl-chapter",
            "Synthetic undo member",
        );
        let f = Self {
            _dir: dir,
            ws,
            book,
            lane,
            backup,
            member,
            view: "synthetic-undo-takeover".into(),
        };
        f.user(
            "timeline_view.put",
            json!({"view":{"id":f.view,"name":"Synthetic takeover view","lanes":[{"entry":f.lane}]}}),
        );
        f.user(
            "timeline_view.place",
            json!({"view":f.view,"entry":f.member,"lane":f.lane,"at":41.0,"span":7.0}),
        );
        f
    }

    fn call(&self, actor: &Actor, name: &str, mut args: Value) -> Value {
        args["book"] = json!(self.book);
        self.ws.call(actor, name, args).unwrap()["output"].clone()
    }

    fn user(&self, name: &str, args: Value) -> Value {
        self.call(&Actor::User, name, args)
    }

    fn placement(&self) -> Value {
        self.ws
            .observe(&format!("book:{}", self.book))
            .unwrap()
            .value["timeline_views"][&self.view]["placements"][&self.member]
            .clone()
    }

    fn cancel(&self) {
        let mut args = json!({"book":self.book,"host":self.lane,"member":self.member});
        let outcome = self
            .ws
            .call(&Actor::User, "membership.remove", args.take())
            .unwrap();
        assert_eq!(outcome["undo"][0]["command"], "membership.restore");
        assert!(
            self.placement().is_null(),
            "the User cancellation removed its own placement"
        );
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.ws.close();
    }
}

#[test]
fn user_undo_must_not_overwrite_an_agents_recreated_same_placement() {
    let f = Fixture::new();
    assert_eq!(f.placement()["at"], 41.0);
    assert_eq!(f.placement()["span"], 7.0);
    f.cancel();

    // This succeeds after cancellation and recreates the exact same edge and
    // placement. It belongs to a different journal actor from User.
    f.call(
        &Actor::agent("synthetic-takeover-placement", 1, "place"),
        "timeline_view.place",
        json!({"view":f.view,"entry":f.member,"lane":f.lane,"at":99.0,"span":11.0}),
    );
    let expected = f.placement();
    assert_eq!(expected["at"], 99.0);
    assert_eq!(expected["span"], 11.0);
    let before = f.ws.observe(&format!("book:{}", f.book)).unwrap();

    let result = f.ws.undo(&Actor::User);
    match &result {
        Ok(Some(_)) | Err(WsError::Conflict(_)) => {}
        other => {
            panic!("undo must either preserve the peer value or explicitly conflict: {other:?}")
        }
    }
    let after = f.ws.observe(&before.doc).unwrap();
    let actual = f.placement();
    eprintln!("User undo={result:?}; expected Agent placement={expected}; actual={actual}");
    assert_eq!(
        actual, expected,
        "User undo may not replace the Agent's successful 99/11 placement with historical 41/7"
    );
    if result.is_err() {
        assert_eq!(
            after.version, before.version,
            "Conflict must precede every mutation"
        );
        assert_eq!(
            after.value, before.value,
            "Conflict must not restore another selected path first"
        );
    }
}

#[test]
fn user_undo_must_not_replace_a_primary_selected_by_an_agent_after_cancellation() {
    let f = Fixture::new();
    f.user("membership.add", json!({"host":f.backup,"member":f.member}));
    f.user(
        "membership.primary",
        json!({"host":f.lane,"member":f.member}),
    );
    f.cancel();
    f.call(
        &Actor::agent("synthetic-takeover-primary", 1, "primary"),
        "membership.primary",
        json!({"host":f.backup,"member":f.member}),
    );
    assert_eq!(
        f.user("entry.get", json!({"id":f.member}))["primary"],
        f.backup
    );
    let before = f.ws.observe(&format!("book:{}", f.book)).unwrap();

    let result = f.ws.undo(&Actor::User);
    match &result {
        Ok(Some(_)) | Err(WsError::Conflict(_)) => {}
        other => {
            panic!("undo must either preserve the peer primary or explicitly conflict: {other:?}")
        }
    }
    let after = f.ws.observe(&before.doc).unwrap();
    let actual = f.user("entry.get", json!({"id":f.member}))["primary"].clone();
    eprintln!(
        "User undo={result:?}; expected Agent primary={}; actual={actual}",
        f.backup
    );
    assert_eq!(
        actual, f.backup,
        "User undo may not replace the Agent's selected primary B with old A"
    );
    if result.is_err() {
        assert_eq!(
            after.version, before.version,
            "Conflict must precede every mutation"
        );
        assert_eq!(
            after.value, before.value,
            "Conflict must not restore another selected path first"
        );
    }
}

#[test]
fn user_redo_conflicts_when_an_agent_takes_over_the_restored_position() {
    let f = Fixture::new();
    f.cancel();
    f.ws.undo(&Actor::User).unwrap().expect("undo");
    assert_eq!(f.placement()["at"], 41.0);
    f.call(
        &Actor::agent("synthetic-redo-takeover", 1, "place"),
        "timeline_view.place",
        json!({"view":f.view,"entry":f.member,"lane":f.lane,"at":99.0,"span":11.0}),
    );
    let before = f.ws.observe(&format!("book:{}", f.book)).unwrap();
    for _ in 0..2 {
        assert!(matches!(f.ws.redo(&Actor::User), Err(WsError::Conflict(_))));
        let after = f.ws.observe(&before.doc).unwrap();
        assert_eq!(after.version, before.version);
        assert_eq!(after.value, before.value);
    }
}
