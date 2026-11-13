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
        let seeded = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
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
        let chapter =
            dr_testkit::seed::acceptance::entries_by_template(&ws, &book, "tpl-chapter")[0].clone();
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
        "project.create",
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
    assert!(catalog.descriptor("entry.update").is_some());
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
        "entry.update",
        json!({"id":title,"title":format!("{title} revised")}),
    )
    .unwrap();
    assert_eq!(call.arguments["book"], f.book.as_str());
    assert_eq!(call.arguments["id"], f.chapter["id"]);
    assert_eq!(call.targets, vec![format!("book:{}", f.book)]);
    assert_eq!(
        call.subjects,
        vec![format!("entry:{}", f.chapter["id"].as_str().unwrap())]
    );
    let prose = resolve(
        &f.ws,
        &f.book,
        "prose.read",
        json!({"doc":{"kind":"entry","module":"mod-prose","name":title}}),
    )
    .unwrap();
    assert_eq!(
        prose.arguments["doc"],
        format!("body:{}/mod-prose", f.chapter["id"].as_str().unwrap())
    );
    assert_eq!(
        prose.targets,
        vec![prose.arguments["doc"].as_str().unwrap()]
    );
    assert!(
        resolve(
            &f.ws,
            &f.book,
            "entry.update",
            json!({"id":"unknown-author-target","title":f.text})
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
    let foreign = f.out("project.create", json!({"name":f.text}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let chapter = dr_testkit::seed::acceptance::novel_entry(
        &f.ws,
        &foreign,
        "tpl-chapter",
        &f.text,
        Some(&f.text),
    );
    let doc = format!("body:{}/mod-prose", chapter["id"].as_str().unwrap());
    assert!(resolve(&f.ws, &f.book, "prose.read", json!({"doc":doc})).is_err());
    assert!(resolve(&f.ws,&f.book,"prose.link",json!({"links":[{"doc":doc,"target":{"kind":"entry","module":"mod-prose","name":f.chapter["title"]},"anchors":[]}]})).is_err());
    assert!(resolve(&f.ws, &f.book, "entry.list", json!({"book":foreign})).is_err());
    f.ws.call(
        &Actor::agent("foreign-run", 1, "write"),
        "entry.update",
        json!({"book":foreign,"id":chapter["id"],"title":format!("{} revised",f.text)}),
    )
    .unwrap();
    assert!(
        resolve(
            &f.ws,
            &f.book,
            "entry_history.version",
            json!({"session":"foreign-run"})
        )
        .is_err()
    );
    assert!(
        resolve(
            &f.ws,
            &f.book,
            "entry_history.restore",
            json!({"session":"foreign-run"})
        )
        .is_err()
    );
}

#[test]
fn read_coverage_names_returned_objects_and_never_treats_a_book_token_as_all_entities() {
    let f = Fixture::new();
    let args = json!({"book":f.book,"all":true});
    let entries = f.out("entry.list", args.clone());
    let read = coverage("entry.list", &args, &entries);
    assert!(read.contains(&"entry:*".into()));
    assert!(read.contains(&format!("entry:{}", f.chapter["id"].as_str().unwrap())));
    assert!(!read.contains(&format!("book:{}", f.book)));
    let book = f.out("book.get", json!({"book":f.book}));
    assert_eq!(
        coverage("book.get", &json!({"book":f.book}), &book),
        vec![format!("book:{}", f.book)]
    );
    assert!(coverage("entry.list", &json!({"query":"filtered"}), &json!([])).is_empty());
    assert!(
        coverage(
            "prose.read",
            &json!({"doc":"body:synthetic/mod-prose"}),
            &json!({"paragraphs":[]})
        )
        .contains(&"prose:body:synthetic/mod-prose".into())
    );
    assert!(
        !coverage(
            "prose.read",
            &json!({"doc":"body:synthetic/mod-prose"}),
            &json!({"paragraphs":[]})
        )
        .contains(&"entry:synthetic".into())
    );
    assert!(
        !coverage("relation.list", &json!({"trashed":true}), &json!([]))
            .contains(&"relation:all".into())
    );
    assert!(
        coverage(
            "entry.list",
            &json!({"all":true,"trashed":true}),
            &json!([])
        )
        .contains(&"entry:all".into())
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
        "entry.set_level",
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
        "memory.update",
        "memory.remove",
        "memory.restore",
        "relation.list",
        "relation.create",
        "relation.delete",
        "prose.shape",
        "prose.link",
        "prose.unlink",
        "entry_history.version",
        "entry_history.restore",
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
        "project.create",
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
        Some(first_revision.clone()),
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

    // 4. With its home level switched off, the action falls back to creating
    // under its own level, as `entry.create` does (no level restricts
    // templates any more, so the binding stays valid): its revision changes,
    // and a call made against the old one is refused without a write.
    let residence_level = first_storyline_action.home.as_ref().unwrap();
    f.out(
        "entry.set_level",
        json!({"book": f.book, "id": residence_level, "level": false}),
    );
    let updated_catalog = tools.catalog_for_book(&f.ws, &f.book).unwrap();
    assert!(
        updated_catalog.action_diagnostics().is_empty(),
        "{:?}",
        updated_catalog.action_diagnostics()
    );
    let rebound = updated_catalog
        .actions()
        .into_iter()
        .find(|a| a.reference == first_storyline_action.reference)
        .unwrap()
        .clone();
    assert_eq!(
        rebound.home.as_deref(),
        Some(first_storyline_action.reference.level.as_str())
    );
    assert_ne!(
        updated_catalog.descriptor(&rebound.id).unwrap().revision,
        first_revision
    );
    let before = f.ws.observe(&format!("book:{}", f.book)).unwrap();
    let stale_err = tools
        .invoke(
            &f.ws,
            &f.book,
            &actor,
            CallRequest::for_action(
                &first_storyline_action.reference,
                json!({"title": "不会创建的章节"}),
                Some(first_revision),
            ),
        )
        .unwrap_err();
    assert!(
        matches!(&stale_err, Error::Invalid(msg) if msg.contains("tool definition changed")),
        "expected a stale revision, got: {stale_err:?}"
    );
    assert_eq!(f.ws.observe(&before.doc).unwrap().version, before.version);
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

#[test]
fn timeline_field_commands_are_absent_and_refused_in_v3_agent_catalog() {
    use dr_agent_tools::{AgentTools, CallRequest, Error};
    let f = V3Fixture::new();
    let catalog = Catalog::for_book(&f.ws, &f.book).unwrap();
    let before = f.ws.observe(&format!("book:{}", f.book)).unwrap();
    let journal = serde_json::to_value(f.ws.journal(None, 100).unwrap()).unwrap();
    for name in [
        "timeline_view.rename",
        "timeline_view.add_lane",
        "timeline_view.move_lane",
        "timeline_view.set_lane_act_track",
        "timeline_view.remove_lane",
        "timeline_view.restore_fields",
    ] {
        assert!(
            dr_workspace::registry().get(name).is_some(),
            "command registered: {name}"
        );
        assert!(catalog.descriptor(name).is_none());
        let result = AgentTools::new().invoke(
            &f.ws,
            &f.book,
            &Actor::agent("timeline-excluded", 1, name),
            CallRequest {
                name: name.into(),
                arguments: json!({}),
                revision: None,
                edited_text: None,
            },
        );
        assert!(matches!(result, Err(Error::Invalid(message)) if message == "unknown book tool"));
    }
    let after = f.ws.observe(&before.doc).unwrap();
    assert_eq!(before.version, after.version);
    assert_eq!(before.value, after.value);
    assert_eq!(
        journal,
        serde_json::to_value(f.ws.journal(None, 100).unwrap()).unwrap()
    );
}

#[test]
fn v4_catalog_excludes_retired_level_queries_binds_actions_by_entry_switch_and_reuses_cached_catalog()
 {
    use dr_agent_tools::{AgentTools, CallRequest, Error};
    use std::sync::Arc;

    let f = V3Fixture::new();
    let tools = AgentTools::new();
    let c0 = tools.catalog_for_book(&f.ws, &f.book).unwrap();

    // 1. `level.get` and `level.list` are absent; `entry.set_level` is present.
    assert!(c0.descriptor("entry.set_level").is_some());
    let before = f.ws.observe(&format!("book:{}", f.book)).unwrap();
    for retired in ["level.get", "level.list"] {
        assert!(c0.descriptor(retired).is_none(), "{retired}");
        let res = tools.invoke(
            &f.ws,
            &f.book,
            &Actor::agent("v4-level-queries", 1, retired),
            CallRequest {
                name: retired.into(),
                arguments: json!({}),
                revision: None,
                edited_text: None,
            },
        );
        assert!(matches!(res, Err(Error::Invalid(msg)) if msg == "unknown book tool"));
    }
    assert_eq!(f.ws.observe(&before.doc).unwrap().version, before.version);

    // 2. Non-structural writes do not rebuild the cached `Arc<Catalog>`.
    let chapters = dr_testkit::seed::acceptance::entries_by_template(&f.ws, &f.book, "tpl-chapter");
    let chapter_id = chapters[0]["id"].as_str().unwrap().to_owned();
    let actor = Actor::agent("v4-cache", 1, "write");
    tools
        .invoke(
            &f.ws,
            &f.book,
            &actor,
            CallRequest {
                name: "entry.get".into(),
                arguments: json!({"id": chapter_id}),
                revision: None,
                edited_text: None,
            },
        )
        .unwrap();
    tools
        .invoke(
            &f.ws,
            &f.book,
            &actor,
            CallRequest {
                name: "entry.update".into(),
                arguments: json!({"id": chapter_id, "title": "改名后不重建目录"}),
                revision: None,
                edited_text: None,
            },
        )
        .unwrap();
    let c_after_leaf_rename = tools.catalog_for_book(&f.ws, &f.book).unwrap();
    assert!(
        Arc::ptr_eq(&c0, &c_after_leaf_rename),
        "renaming an entry with level=false must reuse the cached Catalog allocation"
    );

    let characters =
        dr_testkit::seed::acceptance::entries_by_template(&f.ws, &f.book, "tpl-character");
    let char_id = characters[0]["id"].as_str().unwrap().to_owned();
    let mods = f.out("module.list", json!({"book": f.book, "id": char_id}));
    if let Some(fields_mod) = mods
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["kind"] == "fields")
    {
        let mid = fields_mod["id"].as_str().unwrap();
        let read_mod = f.out(
            "module.read",
            json!({"book": f.book, "entry": char_id, "module": mid}),
        );
        if let Some(first_def) = read_mod["defs"].as_array().and_then(|d| d.first()) {
            let fid = first_def["id"].as_str().unwrap();
            f.out(
                "module.set_field",
                json!({"book": f.book, "entry": char_id, "module": mid, "field": fid, "value": null}),
            );
            let c_after_field = tools.catalog_for_book(&f.ws, &f.book).unwrap();
            assert!(Arc::ptr_eq(&c0, &c_after_field));
        }
    }

    let doc_id = format!("body:{chapter_id}/mod-prose");
    let prose = f.out("prose.read", json!({"doc": doc_id, "limit": 5}));
    if let Some(p0) = prose["paragraphs"].as_array().and_then(|p| p.first())
        && let Some(txt) = p0["text"].as_str()
        && !txt.is_empty()
    {
        f.out(
            "prose.replace",
            json!({"doc": doc_id, "block_id": p0["block_id"], "find": txt, "replace": format!("{txt}。")}),
        );
        let c_after_prose = tools.catalog_for_book(&f.ws, &f.book).unwrap();
        assert!(Arc::ptr_eq(&c0, &c_after_prose));
    }

    // 3. Template actions bind ONLY on entries whose `level` switch is ON.
    f.out(
        "entry_template.put",
        json!({
            "book": f.book,
            "template": {
                "id": "tpl-custom-card",
                "name": "卡片",
                "level": false,
                "linkable": false,
                "modules": [],
                "settings": {"default_template": "tpl-chapter"},
                "verbs": [{
                    "id": "verb-spawn",
                    "name": "派生章节",
                    "description": "在此条目下派生一章",
                    "target_template": "tpl-chapter",
                    "pos": "a0"
                }]
            }
        }),
    );
    let c_after_tpl = tools.catalog_for_book(&f.ws, &f.book).unwrap();
    assert!(
        !Arc::ptr_eq(&c0, &c_after_tpl),
        "template changes must invalidate CatalogStamp"
    );

    let off_entry = f.out(
        "entry.create",
        json!({"book": f.book, "title": "开关关闭的卡片", "template": "tpl-custom-card"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let on_entry = f.out(
        "entry.create",
        json!({"book": f.book, "title": "开关打开的卡片", "template": "tpl-custom-card"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let c_both_off = tools.catalog_for_book(&f.ws, &f.book).unwrap();
    assert!(
        Arc::ptr_eq(&c_after_tpl, &c_both_off),
        "creating level=false entries must keep CatalogStamp unchanged"
    );
    assert!(
        c_both_off
            .actions()
            .iter()
            .all(|a| a.reference.level != off_entry && a.reference.level != on_entry)
    );
    assert!(c_both_off.action_diagnostics().is_empty());

    f.out(
        "entry.set_level",
        json!({"book": f.book, "id": on_entry, "level": true}),
    );
    let c_one_on = tools.catalog_for_book(&f.ws, &f.book).unwrap();
    assert!(!Arc::ptr_eq(&c_both_off, &c_one_on));
    assert!(
        c_one_on
            .actions()
            .iter()
            .any(|a| a.reference.level == on_entry && a.reference.verb == "verb-spawn")
    );
    assert!(
        c_one_on
            .actions()
            .iter()
            .all(|a| a.reference.level != off_entry)
    );

    f.out(
        "entry.set_level",
        json!({"book": f.book, "id": on_entry, "level": false}),
    );
    let c_off_again = tools.catalog_for_book(&f.ws, &f.book).unwrap();
    assert!(
        c_off_again
            .actions()
            .iter()
            .all(|a| a.reference.level != on_entry)
    );
}
