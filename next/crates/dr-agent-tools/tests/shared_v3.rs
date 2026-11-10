//! Shared F3 names use the current book's signatures and the real M29 executor.
//! Fixtures are v3 testkit seeds; no model or network participates.
use dr_agent_tools::{AgentTools, CallRequest, Error};
use dr_doc::v3::novel::{MOD_PROSE, TPL_CHAPTER};
use dr_model::id::BookId;
use dr_testkit::seed::{self, Preset};
use dr_workspace::{Actor, Workspace, registry};
use serde_json::{Value, json};

struct Fixture {
    ws: Workspace,
    tools: AgentTools,
    book: BookId,
    entry: String,
    _dir: tempfile::TempDir,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::open_dir(dir.path(), "k6-shared-v3").unwrap();
        ws.set_auto_links(false);
        let seeded = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        let book = seeded.books[0].book_id().clone();
        let entry = seeded.books[0]
            .book
            .view()
            .entries()
            .into_iter()
            .find(|e| {
                e.template
                    .as_ref()
                    .is_some_and(|t| t.as_str() == TPL_CHAPTER)
            })
            .unwrap()
            .id
            .to_string();
        seeded.write_to(ws.library()).unwrap();
        Self {
            ws,
            tools: AgentTools::new(),
            book,
            entry,
            _dir: dir,
        }
    }
    fn call(&self, name: &str, args: Value) -> dr_agent_tools::Result<Value> {
        self.tools
            .invoke(
                &self.ws,
                &self.book,
                &Actor::agent("shared-v3", 1, name),
                CallRequest {
                    name: name.into(),
                    arguments: args,
                    revision: None,
                    edited_text: None,
                },
            )
            .map(|v| v["output"].clone())
    }
    fn out(&self, name: &str, mut args: Value) -> Value {
        if !args.as_object().unwrap().contains_key("doc") {
            args["book"] = json!(self.book);
        }
        self.ws.call(&Actor::User, name, args).unwrap()["output"].clone()
    }
    fn module(&self) {
        self.call(
            "module.read_prose",
            json!({"owner":self.entry,"module":MOD_PROSE}),
        )
        .unwrap();
    }
    fn target(&self) -> Value {
        json!({"kind":"entry","id":self.entry})
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.ws.close();
    }
}

#[test]
fn directory_projects_v3_input_output_and_revision_for_shared_names() {
    let f = Fixture::new();
    let cat = f.tools.catalog_for_book(&f.ws, &f.book).unwrap();
    let default_catalog = dr_agent_tools::catalog::Catalog::new();
    for name in [
        "book.get",
        "book.update",
        "comment.list",
        "comment.create",
        "comment.anchors",
    ] {
        let spec = registry().get(name).unwrap();
        let entry = cat.entries().iter().find(|e| e.name == name).unwrap();
        let expected_input = spec.input_schema();
        let mut expected_keys: Vec<_> = expected_input.as_value()["properties"]
            .as_object()
            .unwrap()
            .keys()
            .filter(|k| k.as_str() != "book")
            .collect();
        let mut actual_keys: Vec<_> = entry.input_schema["properties"]
            .as_object()
            .unwrap()
            .keys()
            .collect();
        expected_keys.sort();
        actual_keys.sort();
        assert_eq!(actual_keys, expected_keys);
        let mut output = spec.output_schema().as_value().clone();
        let defs = output.as_object_mut().unwrap().remove("$defs");
        assert_eq!(entry.output_schema["properties"]["output"], output);
        if let Some(defs) = defs {
            assert_eq!(entry.output_schema["$defs"], defs);
        }
        assert_eq!(
            entry.revision,
            default_catalog.descriptor(name).unwrap().revision
        );
    }
    let create = cat.descriptor("comment.create").unwrap();
    assert!(create.input_schema["properties"]["module"].is_object());
    let book = cat.descriptor("book.update").unwrap();
    assert!(book.input_schema["properties"]["word_target"].is_object());
}

#[test]
fn book_metadata_requires_read_and_old_frontier_never_overwrites_author_update() {
    let f = Fixture::new();
    assert!(matches!(
        f.call("book.update", json!({"name":"unread"})),
        Err(Error::ReadRequired(_))
    ));
    f.call("book.get", json!({})).unwrap();
    f.call(
        "book.update",
        json!({"name":"Synthetic book","word_target":0,"daily_word_target":230}),
    )
    .unwrap();
    let book = f.call("book.get", json!({})).unwrap();
    assert_eq!(book["name"], "Synthetic book");
    assert!(book["word_target"].is_null());
    assert_eq!(
        f.ws.observe(&format!("book:{}", f.book)).unwrap().value["meta"]["word_target"],
        0
    );
    assert_eq!(book["daily_word_target"], 230);
    f.out("book.update", json!({"summary":"author edit"}));
    assert!(matches!(
        f.call("book.update", json!({"name":"stale"})),
        Err(Error::Conflict(_))
    ));
    f.call("book.get", json!({})).unwrap();
    f.call(
        "book.update",
        json!({"word_target":null,"daily_word_target":null}),
    )
    .unwrap();
    let book = f.call("book.get", json!({})).unwrap();
    assert_eq!(book["name"], "Synthetic book");
    assert_eq!(book["summary"], "author edit");
    assert_eq!(book["word_target"], dr_model::shared::DEFAULT_WORD_TARGET);
}

#[test]
fn module_comments_require_that_module_and_filtered_reads_do_not_cover_other_comments() {
    let f = Fixture::new();
    let mut template = f
        .out("entry_template.list", json!({}))
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == TPL_CHAPTER)
        .unwrap()
        .clone();
    let mut extra = template["modules"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == MOD_PROSE)
        .unwrap()
        .clone();
    extra["id"] = json!("synthetic-second-prose");
    extra["name"] = json!("Second body");
    template["modules"].as_array_mut().unwrap().push(extra);
    f.out("entry_template.put", json!({"template":template}));
    let args = json!({"target":f.target(),"module":MOD_PROSE,"body":"First module comment"});
    f.call("entry.get", json!({"id":f.entry})).unwrap();
    assert!(matches!(
        f.call("comment.create", args.clone()),
        Err(Error::ReadRequired(_))
    ));
    f.module();
    assert!(matches!(
        f.call(
            "comment.create",
            json!({"target":f.target(),"module":"Second body","body":"unread second"})
        ),
        Err(Error::ReadRequired(_))
    ));
    let comment = f.call("comment.create", args).unwrap();
    let second=f.out("comment.create",json!({"target":f.target(),"module":"synthetic-second-prose","body":"Second module comment"}));
    let rows = f
        .call(
            "comment.list",
            json!({"target":f.target(),"module":MOD_PROSE}),
        )
        .unwrap();
    assert!(
        rows.as_array()
            .unwrap()
            .iter()
            .all(|row| row["module"] == MOD_PROSE)
    );
    assert!(
        rows.as_array()
            .unwrap()
            .iter()
            .any(|row| row["id"] == comment["id"])
    );
    assert!(
        !rows
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["id"] == second["id"])
    );
    assert!(matches!(
        f.call("comment.update", json!({"id":second["id"],"body":"unread"})),
        Err(Error::ReadRequired(_))
    ));
    f.call(
        "comment.update",
        json!({"id":"First module comment","status":"resolved"}),
    )
    .unwrap();
    let rows = f
        .call(
            "comment.list",
            json!({"target":f.target(),"module":"Second body"}),
        )
        .unwrap();
    assert_eq!(rows[0]["id"], second["id"]);
    f.out(
        "comment.update",
        json!({"id":second["id"],"body":"author edit"}),
    );
    assert!(matches!(
        f.call(
            "comment.update",
            json!({"id":second["id"],"status":"resolved"})
        ),
        Err(Error::Conflict(_))
    ));
}

#[test]
fn comments_reject_foreign_targets_unknown_modules_and_unread_anchors() {
    let f = Fixture::new();
    let other_seed = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED + 1).unwrap();
    let other = other_seed.books[0].book_id().clone();
    let foreign = other_seed.books[0].book.view().entries()[0].id.to_string();
    other_seed.write_to(f.ws.library()).unwrap();
    for args in [
        json!({"target":{"kind":"entry","id":foreign},"module":MOD_PROSE,"body":"foreign"}),
        json!({"book":other,"target":f.target(),"body":"cross-book"}),
        json!({"target":f.target(),"module":"unknown-module","body":"unknown"}),
    ] {
        assert!(matches!(
            f.call("comment.create", args),
            Err(Error::Invalid(_))
        ));
    }
    let before = f.out("comment.list", json!({}));
    for anchor in [
        json!({"range":[0,2]}),
        json!({"block_id":"synthetic-unseen-block"}),
        json!({"anchor":{}}),
    ] {
        let mut args = json!({"target":f.target(),"module":MOD_PROSE,"body":"unsafe anchor"});
        args.as_object_mut()
            .unwrap()
            .extend(anchor.as_object().unwrap().clone());
        assert!(matches!(
            f.call("comment.create", args),
            Err(Error::ReadRequired(_))
        ));
    }
    assert_eq!(f.out("comment.list", json!({})), before);
}

#[test]
fn reading_module_prose_does_not_authorize_entry_metadata_replacement() {
    let f = Fixture::new();
    f.module();
    assert!(matches!(
        f.call(
            "entry.update",
            json!({"id":f.entry,"title":"unread metadata"})
        ),
        Err(Error::ReadRequired(_))
    ));
    f.call(
        "comment.create",
        json!({"target":f.target(),"module":MOD_PROSE,"body":"Comment on read prose"}),
    )
    .unwrap();
}

#[test]
fn material_metadata_and_text_use_current_book_scope_and_source_coverage() {
    let f = Fixture::new();
    f.call("material.list", json!({})).unwrap();
    let material=f.call("material.create",json!({"kind":"text","title":"Synthetic material","text":"First material paragraph.\nSecond material paragraph."})).unwrap();
    let id = material["id"].as_str().unwrap();
    let doc = json!({"kind":"material","name":"Synthetic material"});
    let body = f.call("prose.read", json!({"doc":doc,"limit":1})).unwrap();
    let full = f.out(
        "prose.read",
        json!({"doc":format!("material:{id}"),"limit":100}),
    );
    let second = &full["paragraphs"][1];
    assert!(matches!(f.call("prose.replace",json!({"doc":doc,"block_id":second["block_id"],"find":second["text"],"replace":"unread"})),Err(Error::ReadRequired(_))));
    let first = &body["paragraphs"][0];
    f.call("prose.replace",json!({"doc":doc,"block_id":first["block_id"],"find":first["text"],"replace":"Read material revision."})).unwrap();
    f.call("material.list", json!({"folder":""})).unwrap();
    f.call(
        "material.update",
        json!({"id":"Synthetic material","title":"Renamed material"}),
    )
    .unwrap();
    f.call("material.list", json!({})).unwrap();
    f.call(
        "comment.create",
        json!({"target":{"kind":"material","name":"Renamed material"},"body":"Material comment"}),
    )
    .unwrap();
    assert!(
        f.call(
            "comment.list",
            json!({"target":{"kind":"material","id":id},"module":MOD_PROSE})
        )
        .is_err()
    );
    f.call("material.list", json!({})).unwrap();
    f.out(
        "material.update",
        json!({"id":id,"description":"author edit"}),
    );
    assert!(matches!(
        f.call("material.update", json!({"id":id,"title":"stale"})),
        Err(Error::Conflict(_))
    ));
}

#[test]
fn guarded_entry_range_anchor_bytes_and_reanchor_use_the_exact_source_module() {
    let f = Fixture::new();
    let prose = f
        .call(
            "module.read_prose",
            json!({"owner":f.entry,"module":MOD_PROSE}),
        )
        .unwrap();
    let expected: String = prose["paragraphs"][0]["text"]
        .as_str()
        .unwrap()
        .chars()
        .take(3)
        .collect();
    let id = f
        .call(
            "comment.create",
            json!({"target":f.target(),"module":MOD_PROSE,"range":[0,3],"body":"Guarded range"}),
        )
        .unwrap()["id"]
        .clone();
    let rows = f
        .call(
            "comment.list",
            json!({"target":f.target(),"module":MOD_PROSE}),
        )
        .unwrap();
    let row = rows
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == id)
        .unwrap();
    assert_eq!(row["quote"], expected);
    assert_eq!(row["author_kind"], "ai");
    assert_eq!(row["source"], "api");
    let anchors = f
        .call(
            "comment.anchors",
            json!({"target":f.target(),"module":MOD_PROSE}),
        )
        .unwrap();
    let anchor = anchors
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["id"] == id)
        .unwrap()["anchor"]
        .clone();
    f.call("comment.reanchor", json!({"id":id,"anchor":null}))
        .unwrap();
    f.call(
        "comment.list",
        json!({"target":f.target(),"module":MOD_PROSE}),
    )
    .unwrap();
    assert!(matches!(
        f.call("comment.reanchor", json!({"id":id,"anchor":anchor})),
        Err(Error::ReadRequired(_))
    ));
    f.module();
    f.call("comment.reanchor", json!({"id":id,"anchor":anchor}))
        .unwrap();
    f.module();
    let copied=f.call("comment.create",json!({"target":f.target(),"module":MOD_PROSE,"anchor":anchor,"body":"Guarded anchor bytes"})).unwrap()["id"].clone();
    let rows = f
        .call(
            "comment.list",
            json!({"target":f.target(),"module":MOD_PROSE}),
        )
        .unwrap();
    assert_eq!(
        rows.as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == copied)
            .unwrap()["quote"],
        expected
    );
    assert!(
        f.out("entry_snapshot.list", json!({"entry":f.entry}))
            .as_array()
            .unwrap()
            .is_empty(),
        "comment source reads must not create checkpoints"
    );
}

#[test]
fn partial_prose_allows_only_a_read_block_and_not_ranges_or_unseen_blocks() {
    let f = Fixture::new();
    let doc = format!("body:{}/{}", f.entry, MOD_PROSE);
    let full = f.out("prose.read", json!({"doc":doc,"limit":100}));
    assert!(full["paragraphs"].as_array().unwrap().len() > 1);
    let partial = f.call("prose.read", json!({"doc":doc,"limit":1})).unwrap();
    let base = json!({"target":f.target(),"module":MOD_PROSE,"body":"Partial source"});
    let before = f.ws.observe(&format!("book:{}", f.book)).unwrap().version;
    for extra in [
        json!({"range":[0,2]}),
        json!({"block_id":full["paragraphs"][1]["block_id"]}),
    ] {
        let mut args = base.clone();
        args.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        assert!(matches!(
            f.call("comment.create", args),
            Err(Error::ReadRequired(_))
        ));
    }
    assert_eq!(
        f.ws.observe(&format!("book:{}", f.book)).unwrap().version,
        before
    );
    let mut args = base;
    args["block_id"] = partial["paragraphs"][0]["block_id"].clone();
    let id = f.call("comment.create", args).unwrap()["id"].clone();
    let rows = f.out("comment.list", json!({}));
    assert_eq!(
        rows.as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == id)
            .unwrap()["target_block"],
        partial["paragraphs"][0]["block_id"]
    );
}

#[test]
fn stale_anchor_source_and_invalid_ranges_never_write_comments_or_settlements() {
    let f = Fixture::new();
    let doc = format!("body:{}/{}", f.entry, MOD_PROSE);
    let prose = f
        .call(
            "module.read_prose",
            json!({"owner":f.entry,"module":MOD_PROSE}),
        )
        .unwrap();
    let p = &prose["paragraphs"][0];
    f.out("prose.replace",json!({"doc":doc,"block_id":p["block_id"],"find":p["text"],"replace":"Author changed the source before annotation"}));
    let before = f.ws.observe(&format!("book:{}", f.book)).unwrap().version;
    let body_before = f.ws.observe(&doc).unwrap().version;
    let journal = f.ws.journal(None, 1000).unwrap().len();
    let args = json!({"target":f.target(),"module":MOD_PROSE,"range":[0,3],"body":"Stale anchor"});
    assert!(matches!(
        f.call("comment.create", args),
        Err(Error::Conflict(_))
    ));
    f.module();
    for extra in [
        json!({"range":[0,999999]}),
        json!({"anchor":{}}),
        json!({"block_id":"not-a-block"}),
    ] {
        let mut args = json!({"target":f.target(),"module":MOD_PROSE,"body":"Invalid anchor"});
        args.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        assert!(f.call("comment.create", args).is_err());
        f.module();
    }
    assert_eq!(
        f.ws.observe(&format!("book:{}", f.book)).unwrap().version,
        before
    );
    assert_eq!(f.ws.observe(&doc).unwrap().version, body_before);
    assert_eq!(f.ws.journal(None, 1000).unwrap().len(), journal);
    assert!(
        f.ws.library()
            .settlements(Some("shared-v3"), None)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn material_range_comments_guard_the_material_document_and_reject_foreign_anchor_bytes() {
    let f = Fixture::new();
    // Reuse seed text for the material source.
    let seeded = f.out(
        "module.read_prose",
        json!({"owner":f.entry,"module":MOD_PROSE}),
    );
    let text = seeded["paragraphs"][0]["text"].as_str().unwrap();
    let id = f.out(
        "material.create",
        json!({"kind":"text","title":"Anchor material","text":text}),
    )["id"]
        .clone();
    let doc = format!("material:{}", id.as_str().unwrap());
    f.call("prose.read", json!({"doc":doc,"limit":100}))
        .unwrap();
    let cid = f
        .call(
            "comment.create",
            json!({"target":{"kind":"material","id":id},"range":[0,3],"body":"Material range"}),
        )
        .unwrap()["id"]
        .clone();
    let anchors = f
        .call(
            "comment.anchors",
            json!({"target":{"kind":"material","id":id}}),
        )
        .unwrap();
    let anchor = anchors
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["id"] == cid)
        .unwrap()["anchor"]
        .clone();
    f.module();
    let before = f.ws.observe(&format!("book:{}", f.book)).unwrap().version;
    let journal = f.ws.journal(None, 1000).unwrap().len();
    let settlements =
        f.ws.library()
            .settlements(Some("shared-v3"), None)
            .unwrap()
            .len();
    assert!(
        f.call(
            "comment.create",
            json!({"target":f.target(),"module":MOD_PROSE,"anchor":anchor,"body":"Wrong source"})
        )
        .is_err()
    );
    assert_eq!(
        f.ws.observe(&format!("book:{}", f.book)).unwrap().version,
        before
    );
    assert_eq!(f.ws.journal(None, 1000).unwrap().len(), journal);
    assert_eq!(
        f.ws.library()
            .settlements(Some("shared-v3"), None)
            .unwrap()
            .len(),
        settlements
    );
}

#[test]
fn reanchor_rejects_a_source_changed_after_its_read_without_a_receipt() {
    let f = Fixture::new();
    f.module();
    let id = f
        .call(
            "comment.create",
            json!({"target":f.target(),"module":MOD_PROSE,"range":[0,3],"body":"Reanchor source"}),
        )
        .unwrap()["id"]
        .clone();
    let anchors = f
        .call(
            "comment.anchors",
            json!({"target":f.target(),"module":MOD_PROSE}),
        )
        .unwrap();
    let anchor = anchors
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["id"] == id)
        .unwrap()["anchor"]
        .clone();
    f.call("comment.list", json!({})).unwrap();
    f.call("comment.reanchor", json!({"id":id,"anchor":null}))
        .unwrap();
    f.call("comment.list", json!({})).unwrap();
    let prose = f
        .call(
            "module.read_prose",
            json!({"owner":f.entry,"module":MOD_PROSE}),
        )
        .unwrap();
    let p = &prose["paragraphs"][0];
    let doc = format!("body:{}/{}", f.entry, MOD_PROSE);
    f.out("prose.replace",json!({"doc":doc,"block_id":p["block_id"],"find":p["text"],"replace":"Author source edit before reanchor"}));
    let before = f.ws.observe(&format!("book:{}", f.book)).unwrap().version;
    let journal = f.ws.journal(None, 1000).unwrap().len();
    let settlements =
        f.ws.library()
            .settlements(Some("shared-v3"), None)
            .unwrap()
            .len();
    assert!(matches!(
        f.call("comment.reanchor", json!({"id":id,"anchor":anchor})),
        Err(Error::Conflict(_))
    ));
    assert_eq!(
        f.ws.observe(&format!("book:{}", f.book)).unwrap().version,
        before
    );
    assert_eq!(f.ws.journal(None, 1000).unwrap().len(), journal);
    assert_eq!(
        f.ws.library()
            .settlements(Some("shared-v3"), None)
            .unwrap()
            .len(),
        settlements
    );
}
