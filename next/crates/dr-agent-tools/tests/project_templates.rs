//! PT4 (`docs/rust-rewrite/project-templates.md` §10, §13, §15): the Agent
//! and MCP reach saved project templates through `project_template.list`,
//! `get` and `save` only. Importing, exporting, editing (working copies)
//! and the community are the author's own. Uses the Tiny v3 seed and
//! synthetic names only; no model is called.

use std::collections::BTreeSet;

use dr_agent_tools::{AgentTools, CallRequest, Error, catalog::Catalog, resolve::resolve};
use dr_model::id::BookId;
use dr_testkit::seed::{self, Preset};
use dr_workspace::{Actor, Workspace};
use serde_json::{Value, json};

/// The whole `project_template` family the Agent may reach.
const OPEN: [&str; 3] = [
    "project_template.get",
    "project_template.list",
    "project_template.save",
];

struct Fixture {
    ws: Workspace,
    book: BookId,
    tools: AgentTools,
    _dir: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::open_dir(dir.path(), "pt4-template-agent").unwrap();
        ws.set_auto_links(false);
        let seeded = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        seeded.write_to(ws.library()).unwrap();
        let book = seeded.books[0].book_id().clone();
        Self {
            ws,
            book,
            tools: AgentTools::new(),
            _dir: dir,
        }
    }

    fn author(&self, name: &str, arguments: Value) -> Value {
        self.ws.call(&Actor::User, name, arguments).unwrap()["output"].clone()
    }

    fn agent_in(
        &self,
        book: &BookId,
        turn: u32,
        name: &str,
        arguments: Value,
    ) -> dr_agent_tools::Result<Value> {
        self.tools.invoke(
            &self.ws,
            book,
            &Actor::agent("pt4-agent", turn, "call"),
            CallRequest {
                name: name.into(),
                arguments,
                revision: None,
                edited_text: None,
            },
        )
    }

    fn agent(&self, turn: u32, name: &str, arguments: Value) -> dr_agent_tools::Result<Value> {
        self.agent_in(&self.book, turn, name, arguments)
    }

    fn template(&self, id: &str) -> Value {
        self.author("project_template.get", json!({"id": id}))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.ws.close();
    }
}

fn family(names: impl IntoIterator<Item = String>) -> BTreeSet<String> {
    names
        .into_iter()
        .filter(|name| name.starts_with("project_template."))
        .collect()
}

#[test]
fn the_catalog_offers_project_templates_through_list_get_and_save_only() {
    let f = Fixture::new();
    let open: BTreeSet<String> = OPEN.iter().map(|name| (*name).to_owned()).collect();
    let base = Catalog::new();
    let book = f.tools.catalog_for_book(&f.ws, &f.book).unwrap();
    for catalog in [&base, &*book] {
        assert_eq!(
            family(catalog.entries().iter().map(|e| e.name.clone())),
            open
        );
        for name in [
            "project_template.import",
            "project_template.export",
            "project_template.edit",
            "project_template.working_copies",
            "project_template.update",
            "project_template.remove",
        ] {
            assert!(catalog.descriptor(name).is_none(), "{name}");
        }
    }
    // Everything else of the family that is registered is excluded by name.
    let excluded = family(base.exclusions().iter().map(|(name, _)| name.clone()));
    for name in [
        "project_template.edit",
        "project_template.working_copies",
        "project_template.update",
        "project_template.remove",
    ] {
        assert!(excluded.contains(name), "{name}: {excluded:?}");
    }
    let reasons: BTreeSet<&str> = base
        .exclusions()
        .iter()
        .filter(|(name, _)| name.starts_with("project_template."))
        .map(|(_, reason)| reason.as_str())
        .collect();
    assert_eq!(reasons.len(), 1, "{reasons:?}");

    // save: the current project; name and description optional, the
    // template's own words for the Agent, no author credit.
    let save = base.descriptor("project_template.save").unwrap();
    let properties = save.input_schema["properties"].as_object().unwrap();
    for present in ["name", "description", "agent", "replace"] {
        assert!(properties.contains_key(present), "{present}");
    }
    for absent in ["book", "credit"] {
        assert!(!properties.contains_key(absent), "{absent}");
    }
    let required: Vec<&str> = save.input_schema["required"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    assert!(!required.contains(&"name"), "{required:?}");
    assert!(!required.contains(&"description"), "{required:?}");
    for said in [
        "`name`",
        "`replace`",
        "`agent`",
        "working copy",
        "project.update",
    ] {
        assert!(
            save.description.contains(said),
            "{said}: {}",
            save.description
        );
    }
    // A saved template is named by its id; author names are not resolved.
    let get = base.descriptor("project_template.get").unwrap();
    assert!(
        !get.input_schema["properties"]["id"]["description"]
            .as_str()
            .unwrap_or_default()
            .contains("author name"),
        "{}",
        get.input_schema
    );

    // Calling one of the others is refused before anything runs.
    let saved = f.author(
        "project_template.save",
        json!({"book": f.book, "name": "作者的模板"}),
    );
    let writes = f.ws.library().write_seq().unwrap();
    for (name, arguments) in [
        ("project_template.edit", json!({"id": saved["id"]})),
        ("project_template.working_copies", json!({})),
        (
            "project_template.update",
            json!({"id": saved["id"], "name": "改名"}),
        ),
        ("project_template.remove", json!({"id": saved["id"]})),
    ] {
        let refused = f.agent(1, name, arguments.clone()).unwrap_err();
        assert!(
            matches!(&refused, Error::Invalid(message) if message == "unknown book tool"),
            "{name}: {refused}"
        );
        let unresolved = resolve(&f.ws, &f.book, name, arguments).unwrap_err();
        assert!(
            unresolved
                .to_string()
                .contains("is not in this book's tool catalog"),
            "{name}: {unresolved}"
        );
    }
    assert_eq!(f.ws.library().write_seq().unwrap(), writes);
    assert_eq!(
        f.template(saved["id"].as_str().unwrap())["summary"]["name"],
        "作者的模板"
    );
}

#[test]
fn the_agent_lists_reads_and_saves_templates_and_replaces_only_what_it_read() {
    let f = Fixture::new();
    let project_agent = f.author("project.get", json!({"book": f.book}))["agent"].clone();

    // A new template from the current project needs nothing read first; the
    // words for the Agent given here go into the template only.
    let words =
        json!({"name": "合成帮手", "description": "合成说明", "instructions": "只在模板里"});
    let made = f
        .agent(
            1,
            "project_template.save",
            json!({"name": "帮手存的模板", "description": "合成描述", "agent": words}),
        )
        .unwrap();
    let id = made["output"]["id"].as_str().unwrap().to_owned();
    assert_eq!(made["output"]["name"], "帮手存的模板");
    assert_eq!(made["output"]["revision"], 1);
    let stored = f.template(&id);
    assert_eq!(stored["value"]["project"]["agent"], words);
    assert_eq!(
        f.author("project.get", json!({"book": f.book}))["agent"],
        project_agent
    );
    // It is the author's credit to give, not the Agent's.
    let credited = f
        .agent(
            1,
            "project_template.save",
            json!({"name": "冒名", "credit": {"author": "别人"}}),
        )
        .unwrap_err();
    assert!(matches!(credited, Error::Invalid(_)), "{credited}");
    // Its book is the current one; another book is refused.
    let foreign = f
        .agent(
            1,
            "project_template.save",
            json!({"book": BookId::new_v7(), "name": "别的书"}),
        )
        .unwrap_err();
    assert!(matches!(foreign, Error::Invalid(_)), "{foreign}");

    // Replacing a template needs it read in this turn.
    let unread = f
        .agent(2, "project_template.save", json!({"replace": id}))
        .unwrap_err();
    assert!(
        matches!(&unread, Error::ReadRequired(subject) if subject == &format!("project_template:{id}")),
        "{unread}"
    );
    let listed = f.agent(2, "project_template.list", json!({})).unwrap()["output"].clone();
    assert!(
        listed
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["id"] == id.as_str())
    );
    let replaced = f
        .agent(2, "project_template.save", json!({"replace": id}))
        .unwrap()["output"]
        .clone();
    // Replacing keeps its name and description; the revision moves on.
    assert_eq!(replaced["id"], id.as_str());
    assert_eq!(replaced["revision"], 2);
    assert_eq!(replaced["name"], "帮手存的模板");
    assert_eq!(replaced["description"], "合成描述");
    // What it replaced has to be read again.
    let again = f
        .agent(2, "project_template.save", json!({"replace": id}))
        .unwrap_err();
    assert!(matches!(again, Error::ReadRequired(_)), "{again}");

    // The author changes it after the Agent read it: the Agent's save is
    // refused and the author's change stays; twice stops the turn.
    let read = f
        .agent(3, "project_template.get", json!({"id": id}))
        .unwrap()["output"]
        .clone();
    assert_eq!(read["summary"]["revision"], 2);
    f.author(
        "project_template.save",
        json!({"book": f.book, "replace": id, "name": "作者改的名字"}),
    );
    let stale = f
        .agent(
            3,
            "project_template.save",
            json!({"replace": id, "name": "帮手的名字"}),
        )
        .unwrap_err();
    assert!(matches!(stale, Error::Conflict(_)), "{stale}");
    assert_eq!(f.template(&id)["summary"]["name"], "作者改的名字");
    f.agent(3, "project_template.get", json!({"id": id}))
        .unwrap();
    f.author(
        "project_template.save",
        json!({"book": f.book, "replace": id, "name": "作者又改"}),
    );
    let limit = f
        .agent(3, "project_template.save", json!({"replace": id}))
        .unwrap_err();
    assert!(matches!(limit, Error::ConflictLimit(_)), "{limit}");
    assert_eq!(f.template(&id)["summary"]["name"], "作者又改");

    // Read in a fresh turn, it replaces: the book itself is untouched.
    let book_version = f.ws.version(&format!("book:{}", f.book)).unwrap();
    f.agent(4, "project_template.get", json!({"id": id}))
        .unwrap();
    let saved = f
        .agent(
            4,
            "project_template.save",
            json!({"replace": id, "name": "帮手最后存的"}),
        )
        .unwrap()["output"]
        .clone();
    assert_eq!(saved["name"], "帮手最后存的");
    assert_eq!(
        f.ws.version(&format!("book:{}", f.book)).unwrap(),
        book_version
    );
}

#[test]
fn a_working_copy_saves_only_over_the_template_it_edits() {
    let f = Fixture::new();
    let own = f.author(
        "project_template.save",
        json!({"book": f.book, "name": "在编辑的模板"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let other = f.author(
        "project_template.save",
        json!({"book": f.book, "name": "另一份模板"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let copy = BookId::parse(
        f.author("project_template.edit", json!({"id": own}))["book"]
            .as_str()
            .unwrap(),
    )
    .unwrap();

    // Saving in the working copy replaces the template it edits: that one
    // has to be read first, like any replacement.
    let unread = f
        .agent_in(&copy, 1, "project_template.save", json!({}))
        .unwrap_err();
    assert!(
        matches!(&unread, Error::ReadRequired(subject) if subject == &format!("project_template:{own}")),
        "{unread}"
    );
    // Another template is refused even when read.
    f.agent_in(&copy, 1, "project_template.list", json!({}))
        .unwrap();
    let elsewhere = f
        .agent_in(&copy, 1, "project_template.save", json!({"replace": other}))
        .unwrap_err();
    assert!(
        elsewhere
            .to_string()
            .contains("a working copy saves over the template it edits"),
        "{elsewhere}"
    );
    assert_eq!(f.template(&other)["summary"]["revision"], 1);
    let saved = f
        .agent_in(&copy, 1, "project_template.save", json!({}))
        .unwrap()["output"]
        .clone();
    assert_eq!(saved["id"], own.as_str());
    assert_eq!(f.template(&other)["summary"]["revision"], 1);
}

/// In a working copy the template's name, description and words for the
/// Agent are the copy's own book name, profile and project: the copy saves
/// itself after every change and would take them back, so a save that
/// gives them is refused and points to `project.update` (PT4 hand-back).
#[test]
fn a_working_copy_takes_its_templates_words_from_project_update_only() {
    let f = Fixture::new();
    let own = f.author(
        "project_template.save",
        json!({"book": f.book, "name": "在编辑的模板", "description": "原来的描述"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let copy = BookId::parse(
        f.author("project_template.edit", json!({"id": own}))["book"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    let before = f.template(&own);

    f.agent_in(&copy, 1, "project_template.get", json!({"id": own}))
        .unwrap();
    let words =
        json!({"name": "合成帮手", "description": "合成说明", "instructions": "只在模板里"});
    for given in [
        json!({"name": "帮手起的名字"}),
        json!({"description": "帮手写的描述"}),
        json!({"agent": words}),
        json!({"agent": null}),
        json!({"replace": own, "name": "帮手起的名字", "description": "帮手写的描述"}),
    ] {
        let refused = f
            .agent_in(&copy, 1, "project_template.save", given.clone())
            .unwrap_err();
        let message = refused.to_string();
        assert!(
            message.contains("project.update") && message.contains("working copy"),
            "{given}: {message}"
        );
        // The author is refused the same way.
        let mut theirs = given.clone();
        theirs["book"] = json!(copy);
        let author =
            f.ws.call(&Actor::User, "project_template.save", theirs)
                .unwrap_err();
        assert!(
            author.to_string().contains("project.update"),
            "{given}: {author}"
        );
    }
    f.ws.flush_working_copies().unwrap();
    assert_eq!(f.template(&own), before);
    // Refused before anything ran: the template read in this turn still
    // counts, and a save without them goes through.
    let plain = f
        .agent_in(&copy, 1, "project_template.save", json!({}))
        .unwrap()["output"]
        .clone();
    assert_eq!(plain["id"], own.as_str());
    assert_eq!(f.template(&own), before);

    // Through `project.update` the copy changes, and the template follows
    // it and keeps it through the copy's later saves.
    f.agent_in(&copy, 2, "project.get", json!({})).unwrap();
    f.agent_in(&copy, 2, "book.get", json!({})).unwrap();
    f.agent_in(
        &copy,
        2,
        "project.update",
        json!({"name": "帮手起的名字", "summary": "帮手写的描述", "agent": words}),
    )
    .unwrap();
    f.ws.flush_working_copies().unwrap();
    let followed = f.template(&own);
    assert_eq!(followed["summary"]["name"], "帮手起的名字");
    assert_eq!(followed["summary"]["description"], "帮手写的描述");
    assert_eq!(followed["value"]["project"]["agent"], words);
    let first = f.author("entry.list", json!({"book": copy, "all": true}))[0]["id"].clone();
    f.author(
        "entry.update",
        json!({"book": copy, "id": first, "title": "后来改的标题"}),
    );
    f.ws.flush_working_copies().unwrap();
    f.agent_in(&copy, 3, "project_template.get", json!({"id": own}))
        .unwrap();
    f.agent_in(&copy, 3, "project_template.save", json!({}))
        .unwrap();
    let kept = f.template(&own);
    assert!(
        kept["summary"]["revision"].as_i64() > followed["summary"]["revision"].as_i64(),
        "{kept}"
    );
    assert_eq!(kept["summary"]["name"], "帮手起的名字");
    assert_eq!(kept["summary"]["description"], "帮手写的描述");
    assert_eq!(kept["value"]["project"]["agent"], words);
}
