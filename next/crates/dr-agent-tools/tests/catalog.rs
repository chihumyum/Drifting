use dr_agent::{ToolAccess, ToolPolicy};
use dr_agent_tools::{
    catalog::{Catalog, Search},
    resolve::{coverage, resolve},
};
use dr_model::id::BookId;
use dr_store::Library;
use dr_testkit::seed::{self, Preset};
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options, registry};
use serde_json::{Value, json};

struct Fixture {
    _dir: tempfile::TempDir,
    ws: Workspace,
    book: BookId,
    chapter: Value,
    text: String,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open(dir.path(), library_options("m29-catalog")).unwrap();
        let seeded = seed::generate(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        let book = seeded.books[0].book_id().clone();
        let text = seeded.books[0].prose[0]
            .view()
            .plain_text()
            .chars()
            .take(24)
            .collect();
        seeded.write_to(&lib).unwrap();
        let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
        ws.set_auto_links(false);
        let chapter = ws
            .call(&Actor::User, "chapter.list", json!({"book":book}))
            .unwrap()["output"][0]
            .clone();
        Self {
            _dir: dir,
            ws,
            book,
            chapter,
            text,
        }
    }
    fn out(&self, name: &str, args: Value) -> Value {
        self.ws.call(&Actor::User, name, args).unwrap()["output"].clone()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.ws.close();
    }
}

#[test]
fn generated_directory_snapshot() {
    let catalog = Catalog::new();
    let mut table = catalog.directory();
    table.push_str("\n\nSchema and facade revisions:\n");
    for entry in catalog.entries() {
        table.push_str(&format!(
            "{} {} {}\n",
            entry.name, entry.concurrency, entry.revision
        ));
    }
    table.push_str("\n\nExcluded registry operations:\n");
    for (name, reason) in catalog.exclusions() {
        table.push_str(&format!("{name}: {reason}\n"));
    }
    insta::assert_snapshot!("directory", table);
}

#[test]
fn descriptors_are_generated_stable_and_book_scoped() {
    let catalog = Catalog::new();
    let second = Catalog::new();
    assert_eq!(catalog.manifest(), second.manifest());
    assert_eq!(
        catalog.entries().len() + catalog.exclusions().len(),
        registry().len()
    );
    for entry in catalog.entries() {
        let source = registry().get(&entry.name).unwrap();
        assert!(entry.description.starts_with(source.summary));
        let mut raw = source.output_schema().as_value().clone();
        let defs = raw.as_object_mut().and_then(|raw| raw.remove("$defs"));
        assert_eq!(entry.output_schema.get("$defs"), defs.as_ref());
        assert_eq!(
            entry.output_schema["required"],
            json!(["output", "effects"])
        );
        if !matches!(entry.name.as_str(), "prose.read" | "prose.replace") {
            assert_eq!(entry.output_schema["properties"]["output"], raw);
        }
        assert_eq!(entry.access == ToolAccess::Read, source.is_query());
        assert_eq!(entry.revision.len(), 64);
        let descriptor = catalog.descriptor(&entry.name).unwrap();
        assert_eq!(descriptor.policy, ToolPolicy::Local);
        assert!(descriptor.input_schema["properties"].get("book").is_none());
    }
    for name in [
        "book.create",
        "book.list",
        "book.shelf",
        "book.purge_expired",
        "writing_day.record",
        "recent.touch",
        "todo.project",
        "note_tasks.project",
        "history.restore_point",
        "chapter.purge",
        "category.purge",
        "comment.delete",
        "patch.delete",
        "relation_type.delete",
        "material.delete",
        "idea.to_chapter",
        "idea.to_element",
    ] {
        assert!(catalog.descriptor(name).is_none(), "{name}");
    }
    assert!(catalog.descriptor("chapter.update").is_some());
    let relation = catalog.descriptor("relation.create").unwrap();
    assert!(relation.input_schema["properties"].get("id").is_none());
    assert_eq!(relation.input_schema["not"], json!({"required":["id"]}));
    assert!(
        catalog.descriptor("prose.read").unwrap().input_schema["properties"]["doc"]["anyOf"]
            .is_array()
    );
}

#[test]
fn search_is_exact_or_paged_and_never_installs_another_schema_list() {
    let catalog = Catalog::new();
    let exact = catalog.search(Search {
        query: "prose.read".into(),
        ..Search::default()
    });
    assert_eq!(exact["total"], 1);
    assert_eq!(
        exact["tools"][0]["input_schema"],
        catalog.descriptor("prose.read").unwrap().input_schema
    );
    let page = catalog.search(Search {
        limit: 3,
        ..Search::default()
    });
    assert_eq!(page["tools"].as_array().unwrap().len(), 3);
    assert_eq!(page["next_offset"], 3);
    let next = catalog.search(Search {
        offset: 3,
        limit: 3,
        ..Search::default()
    });
    assert_ne!(page["tools"][0]["name"], next["tools"][0]["name"]);
    let no_match = catalog.search(Search {
        query: "not_a_registered_operation".into(),
        ..Search::default()
    });
    assert_eq!(no_match["total"], 0);
    assert!(no_match["next_offset"].is_null());
    for limit in [0, 51, usize::MAX] {
        assert!(
            Search {
                limit,
                ..Search::default()
            }
            .validate()
            .is_err()
        );
        assert!(
            catalog
                .search(Search {
                    limit,
                    ..Search::default()
                })
                .get("error")
                .is_some()
        );
    }
    assert!(serde_json::from_value::<Search>(json!({"query":"chapter","extra":true})).is_err());
}

#[test]
fn author_names_resolve_to_registry_arguments_without_requiring_ids() {
    let f = Fixture::new();
    let title = f.chapter["title"].as_str().unwrap();
    let call = resolve(
        &f.ws,
        &f.book,
        "chapter.update",
        json!({"id":title,"summary":f.text}),
    )
    .unwrap();
    assert_eq!(call.arguments["book"], f.book.as_str());
    assert_eq!(call.arguments["id"], f.chapter["id"]);
    assert_eq!(call.targets, vec![format!("book:{}", f.book)]);
    assert_eq!(
        call.subjects,
        vec![format!("chapter:{}", f.chapter["id"].as_str().unwrap())]
    );
    let prose = resolve(
        &f.ws,
        &f.book,
        "prose.read",
        json!({"doc":{"kind":"chapter","name":title}}),
    )
    .unwrap();
    assert_eq!(
        prose.arguments["doc"],
        format!("node:{}", f.chapter["id"].as_str().unwrap())
    );
    assert_eq!(
        prose.targets,
        vec![prose.arguments["doc"].as_str().unwrap()]
    );
    assert!(
        resolve(
            &f.ws,
            &f.book,
            "chapter.update",
            json!({"id":"unknown-author-target","summary":f.text})
        )
        .is_err()
    );
}

#[test]
fn ambiguous_names_are_refused_even_when_a_document_kind_is_known() {
    let f = Fixture::new();
    for _ in 0..2 {
        f.out(
            "material.create",
            json!({"book":f.book,"kind":"text","title":f.text,"text":f.text}),
        );
    }
    let error = resolve(
        &f.ws,
        &f.book,
        "prose.read",
        json!({"doc":{"kind":"material","name":f.text}}),
    )
    .unwrap_err();
    assert!(error.to_string().contains("ambiguous"));
}

#[test]
fn nested_documents_and_history_sessions_cannot_cross_books() {
    let f = Fixture::new();
    let foreign = f.out("book.create", json!({"name":f.text}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let chapter = f.out(
        "chapter.create",
        json!({"book":foreign,"title":f.text,"text":f.text}),
    );
    let doc = format!("node:{}", chapter["id"].as_str().unwrap());
    assert!(resolve(&f.ws, &f.book, "prose.read", json!({"doc":doc})).is_err());
    assert!(resolve(&f.ws,&f.book,"prose.link",json!({"links":[{"doc":doc,"target":{"kind":"chapter","name":f.chapter["title"]},"anchors":[]}]})).is_err());
    assert!(resolve(&f.ws, &f.book, "chapter.list", json!({"book":foreign})).is_err());
    f.ws.call(
        &Actor::agent("foreign-run", 1, "write"),
        "chapter.update",
        json!({"book":foreign,"id":chapter["id"],"summary":f.text}),
    )
    .unwrap();
    assert!(
        resolve(
            &f.ws,
            &f.book,
            "history.agent_changes",
            json!({"session":"foreign-run"})
        )
        .is_err()
    );
    assert!(
        resolve(
            &f.ws,
            &f.book,
            "history.undo_agent",
            json!({"session":"foreign-run"})
        )
        .is_err()
    );
}

#[test]
fn read_coverage_names_returned_objects_and_never_treats_a_book_token_as_all_entities() {
    let f = Fixture::new();
    let chapters = f.out("chapter.list", json!({"book":f.book}));
    let read = coverage("chapter.list", &json!({"book":f.book}), &chapters);
    assert!(read.contains(&"chapter:*".to_owned()));
    assert!(read.contains(&format!("chapter:{}", f.chapter["id"].as_str().unwrap())));
    assert!(!read.contains(&format!("book:{}", f.book)));
    let book = f.out("book.get", json!({"book":f.book}));
    assert_eq!(
        coverage("book.get", &json!({"book":f.book}), &book),
        vec![format!("book:{}", f.book)]
    );
    assert!(
        coverage(
            "element.list",
            &json!({"book":f.book,"category":"filtered"}),
            &json!([])
        )
        .is_empty()
    );
    assert!(
        coverage(
            "prose.shape",
            &json!({"doc":"node:unused"}),
            &json!({"paragraphs":5})
        )
        .is_empty()
    );
    let prose_subjects = coverage(
        "prose.read",
        &json!({"doc":"element:synthetic-id"}),
        &json!({"paragraphs":[]}),
    );
    assert_eq!(prose_subjects, vec!["prose:element:synthetic-id"]);
    assert!(!prose_subjects.contains(&"element:synthetic-id".to_owned()));
    assert!(
        !coverage(
            "relation.list",
            &json!({"book":f.book,"trashed":true}),
            &json!([])
        )
        .contains(&"relation:all".to_owned())
    );
    assert!(
        coverage(
            "element.list",
            &json!({"book":f.book,"trashed":true}),
            &json!([])
        )
        .contains(&"element:all".to_owned())
    );
    let template_args = json!({"book":f.book,"category":"category-id"});
    assert_eq!(
        coverage("category_template.list", &template_args, &json!([])),
        vec!["category_template:category-id"]
    );
    assert_eq!(
        coverage("category_template.body", &template_args, &json!([])),
        vec!["prose:template:category:category-id"]
    );
}

#[test]
fn v3_registry_commands_are_absent_and_invocation_is_refused_until_k6() {
    use dr_agent_tools::{AgentTools, CallRequest, Error};
    let f = Fixture::new();
    let tools = AgentTools::new();
    let actor = Actor::agent("k1-catalog", 1, "refused");
    let before =
        f.ws.library()
            .load_copy(&format!("book:{}", f.book))
            .unwrap()
            .get_deep_value();
    let mut checked = 0;
    for spec in registry().iter().filter(|s| s.book_version == Some(3)) {
        checked += 1;
        assert!(
            tools.catalog().descriptor(spec.name).is_none(),
            "{}",
            spec.name
        );
        let result = tools.invoke(
            &f.ws,
            &f.book,
            &actor,
            CallRequest {
                name: spec.name.into(),
                arguments: json!({}),
                revision: None,
                edited_text: None,
            },
        );
        assert!(
            matches!(result, Err(Error::Invalid(message)) if message == "unknown book tool"),
            "{}",
            spec.name
        );
    }
    assert!(checked > 0);
    assert_eq!(
        before,
        f.ws.library()
            .load_copy(&format!("book:{}", f.book))
            .unwrap()
            .get_deep_value()
    );
}

struct V3Fixture {
    _dir: tempfile::TempDir,
    ws: Workspace,
    book: BookId,
}

impl V3Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open(dir.path(), library_options("k6-v3-catalog")).unwrap();
        let seeded = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        let book = seeded.books[0].book_id().clone();
        seeded.write_to(&lib).unwrap();
        let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
        ws.set_auto_links(false);
        Self {
            _dir: dir,
            ws,
            book,
        }
    }

    fn out(&self, name: &str, args: Value) -> Value {
        self.ws.call(&Actor::User, name, args).unwrap()["output"].clone()
    }
}

impl Drop for V3Fixture {
    fn drop(&mut self) {
        self.ws.close();
    }
}

#[test]
fn v3_catalog_exposes_generic_commands_and_excludes_v2_2_fixed_domains() {
    use dr_agent_tools::{
        AgentTools, CallRequest, Error,
        catalog::{BookKernelVersion, FACADE_REVISION_V3},
    };
    let f = V3Fixture::new();
    let catalog = Catalog::for_book(&f.ws, &f.book).unwrap();
    assert_eq!(catalog.kernel_version(), BookKernelVersion::V3);

    for v3_cmd in [
        "entry.list",
        "entry.get",
        "entry.create",
        "entry.update",
        "entry.move",
        "entry.trash",
        "entry.restore",
        "level.get",
        "entry_template.list",
        "entry_template.put",
        "entry_template.delete",
        "entry_template.put_module",
        "entry_template.remove_module",
        "module.list",
        "module.read",
        "module.set_field",
        "module.put_kv",
        "module.remove_kv",
        "module.read_prose",
        "module.set_prose",
        "module.replace_prose",
        "module.put_patch",
        "module.remove_patch",
        "module.put_grid",
        "module.put_relation",
        "module.remove_relation",
        "entry_relation_type.list",
        "entry_relation_type.put",
        "entry_relation_type.delete",
        "membership.list",
        "membership.add",
        "membership.remove",
        "membership.primary",
        "timeline_view.list",
        "timeline_view.put",
        "timeline_view.delete",
        "timeline_view.place",
        "timeline_view.remove",
        "timeline_view.put_pin",
        "timeline_view.remove_pin",
        "entry_history.version",
        "entry_history.restore",
        "book.get",
        "book.update",
        "prose.read",
        "prose.replace",
        "prose.shape",
        "prose.link",
        "prose.unlink",
        "prose.restore",
        "comment.anchors",
        "comment.create",
        "comment.list",
        "comment.reanchor",
        "comment.update",
        "material.list",
        "material.create",
        "material.move",
        "material.update",
        "material_folder.list",
        "material_folder.create",
        "material_folder.update",
        "material_folder.delete",
        "asset.get",
        "fact.list",
        "fact.put",
        "fact.remove",
        "memory.add",
        "memory.list",
        "memory.remove",
        "memory.restore",
        "memory.update",
        "history.points",
        "history.preview",
        "history.agent_changes",
        "history.undo_agent",
        "relation.list",
        "relation.create",
        "relation.delete",
    ] {
        let descriptor = catalog.descriptor(v3_cmd).expect(v3_cmd);
        assert!(
            descriptor.input_schema["properties"].get("book").is_none(),
            "{v3_cmd} should strip book from facade input_schema"
        );
    }

    for excluded in [
        "project.create",
        "module.prose_document",
        "history.restore_entities",
        "relation_type.list",
        "book.create",
        "book.list",
        "chapter.list",
        "chapter.create",
        "chapter.update",
        "idea.list",
        "element.list",
        "category.list",
        "storyline.list",
        "act.list",
        "idea_group.list",
        "plot_grid.get",
        "patch.list",
        "time_pin.list",
        "category_template.list",
        "chapter_template.list",
        "storyline_template.list",
    ] {
        assert!(
            catalog.descriptor(excluded).is_none(),
            "{excluded} must not appear in v3 catalog"
        );
    }

    let tools = AgentTools::new();
    let actor = Actor::agent("k6-v3-refuse", 1, "refused");
    let res = tools.invoke(
        &f.ws,
        &f.book,
        &actor,
        CallRequest {
            name: "chapter.list".into(),
            arguments: json!({}),
            revision: None,
            edited_text: None,
        },
    );
    assert!(matches!(res, Err(Error::Invalid(msg)) if msg == "unknown book tool"));

    // Template verbs are generated for live levels in the v3 novel book.
    assert!(!catalog.actions().is_empty());
    assert!(catalog.action_diagnostics().is_empty());
    let search = catalog.search(Search {
        query: "新建章节".into(),
        limit: 20,
        offset: 0,
    });
    let matched_actions: Vec<&Value> = search["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item.get("action").is_some())
        .collect();
    assert!(
        matched_actions.len() >= 2,
        "新建章节 should appear on 书稿 and storyline levels: {matched_actions:?}"
    );
    for item in matched_actions {
        assert!(item["name"].as_str().unwrap().starts_with("action:"));
        assert_eq!(item["action"]["command"], "entry.create");
        assert_eq!(item["revision"].as_str().unwrap().len(), 64);
    }
    let _ = FACADE_REVISION_V3;
}

#[test]
fn v3_template_verbs_bind_atomically_disambiguate_paths_and_guard_revisions() {
    use dr_agent_tools::{AgentTools, CallRequest, Error};
    let f = V3Fixture::new();
    let tools = AgentTools::new();
    let actor = Actor::agent("k6-verbs", 1, "verbs");

    // 1. Wire mutual exclusion between `name` and `action`.
    assert!(
        serde_json::from_value::<CallRequest>(json!({
            "name": "entry.create",
            "action": {"level": "x", "verb": "新建章节"},
            "arguments": {}
        }))
        .is_err()
    );
    assert!(serde_json::from_value::<CallRequest>(json!({"arguments": {}})).is_err());

    // 2. Duplicate verb name ("新建章节") with an ambiguous path fails without side effects.
    let catalog = tools.catalog_for_book(&f.ws, &f.book).unwrap();
    let storyline_actions: Vec<_> = catalog
        .actions()
        .into_iter()
        .filter(|a| a.display_name == "新建章节" && a.home.as_ref() != Some(&a.reference.level))
        .collect();
    assert!(!storyline_actions.is_empty());
    let first_storyline_action = storyline_actions[0].clone();
    let first_revision = catalog
        .descriptor(&first_storyline_action.id)
        .unwrap()
        .revision;
    let storyline_root_id = first_storyline_action.path[0].entry.clone();

    // Create a second sub-storyline with the same title as the first one to test path collision.
    let duplicate_title = first_storyline_action.path.last().unwrap().title.clone();
    f.out(
        "entry.create",
        json!({
            "book": f.book,
            "parent": storyline_root_id,
            "title": duplicate_title,
            "template": first_storyline_action.reference.template,
        }),
    );

    let ambiguous_req: CallRequest = serde_json::from_value(json!({
        "action": {
            "path": ["故事线", duplicate_title],
            "verb": "新建章节"
        },
        "arguments": {"title": "不会创建的章节"}
    }))
    .unwrap();
    let err = tools
        .invoke(&f.ws, &f.book, &actor, ambiguous_req)
        .unwrap_err();
    assert!(
        matches!(&err, Error::Invalid(msg) if msg.contains("ambiguous")),
        "expected ambiguity error, got: {err:?}"
    );
    assert!(
        f.ws.library()
            .settlements(Some("k6-verbs"), None)
            .unwrap()
            .is_empty()
    );

    // 3. Calling the storyline verb by explicit level id requires reading entry first,
    // then atomically creates the chapter under 书稿 and adds membership under the storyline.
    let action_req = CallRequest::for_action(
        &first_storyline_action.reference,
        json!({"title": "风雪夜归人"}),
        Some(first_revision),
    );
    let unread_err = tools
        .invoke(&f.ws, &f.book, &actor, action_req.clone())
        .unwrap_err();
    assert!(
        matches!(unread_err, Error::ReadRequired(_)),
        "{unread_err:?}"
    );

    tools
        .invoke(
            &f.ws,
            &f.book,
            &actor,
            CallRequest {
                name: "entry.list".into(),
                arguments: json!({"all": true}),
                revision: None,
                edited_text: None,
            },
        )
        .unwrap();

    let created = tools.invoke(&f.ws, &f.book, &actor, action_req).unwrap();
    let new_chapter_id = created["output"]["id"].as_str().unwrap().to_owned();
    let new_chapter = f.out("entry.get", json!({"book": f.book, "id": new_chapter_id}));
    assert_eq!(
        new_chapter["parent"].as_str(),
        first_storyline_action.home.as_deref()
    );
    assert_eq!(
        new_chapter["primary"].as_str(),
        Some(first_storyline_action.reference.level.as_str())
    );
    assert_eq!(
        new_chapter["template"].as_str(),
        Some(first_storyline_action.target_template.as_str())
    );
    let memberships = f.out(
        "membership.list",
        json!({"book": f.book, "host": first_storyline_action.reference.level}),
    );
    assert!(
        memberships
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["member"].as_str() == Some(new_chapter_id.as_str()))
    );

    // 4. Changing the residence level's allowed templates invalidates the action and records a diagnostic.
    let residence_level = first_storyline_action.home.as_ref().unwrap();
    f.out(
        "entry.update",
        json!({
            "book": f.book,
            "id": residence_level,
            "overrides": {
                "allow": [first_storyline_action.reference.template]
            }
        }),
    );
    let updated_catalog = tools.catalog_for_book(&f.ws, &f.book).unwrap();
    assert!(
        updated_catalog.action_diagnostics().iter().any(|d| {
            d.level.as_deref() == Some(first_storyline_action.reference.level.as_str())
                && d.code == "invalid_residence_binding"
        }),
        "expected diagnostic on disabled verb: {:?}",
        updated_catalog.action_diagnostics()
    );
    let disabled_err = tools
        .invoke(
            &f.ws,
            &f.book,
            &actor,
            CallRequest::for_action(
                &first_storyline_action.reference,
                json!({"title": "被禁用的章节"}),
                None,
            ),
        )
        .unwrap_err();
    assert!(
        matches!(&disabled_err, Error::Invalid(msg) if msg.contains("invalid_residence_binding")),
        "expected diagnostic error, got: {disabled_err:?}"
    );
}

#[test]
fn scoped_membership_restore_is_absent_and_refused_in_v3_agent_catalog() {
    use dr_agent_tools::{AgentTools, CallRequest, Error};
    let f = V3Fixture::new();
    let catalog = Catalog::for_book(&f.ws, &f.book).unwrap();
    let name = "membership.restore";
    assert!(catalog.descriptor(name).is_none());
    let before = f.ws.observe(&format!("book:{}", f.book)).unwrap();
    let result = AgentTools::new().invoke(
        &f.ws,
        &f.book,
        &Actor::agent("scoped-membership-refusal", 1, "write"),
        CallRequest {
            name: name.into(),
            arguments: json!({}),
            revision: None,
            edited_text: None,
        },
    );
    assert!(matches!(result, Err(Error::Invalid(message)) if message == "unknown book tool"));
    let after = f.ws.observe(&before.doc).unwrap();
    assert_eq!(before.version, after.version);
    assert_eq!(before.value, after.value);
}
