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
