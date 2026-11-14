//! Small command setups shared by canonical acceptance tests.
#![allow(dead_code)]
/// Canonical command setup for interface/storage acceptance tests. It uses
/// the existing novel template's actual dynamic roots, never static root ids.
pub fn novel_entry_as(
    actor: &dr_workspace::Actor,
    ws: &dr_workspace::Workspace,
    book: &str,
    template: &str,
    title: &str,
    text: Option<&str>,
) -> serde_json::Value {
    let id = dr_model::id::BookId::parse(book).expect("test book id");
    let raw = ws
        .library()
        .load_copy(&format!("book:{book}"))
        .expect("test book");
    let borrowed = dr_doc::v3::BorrowedBookV3::new(&raw, &id).expect("canonical test book");
    let view = borrowed.view();
    let root = |tpl: &str| {
        view.root_entry_by_template(&dr_model::id::EntryTemplateId::parse(tpl).unwrap())
            .expect("novel test root")
            .id
    };
    let cat = |leaf_tpl: &str| {
        let elements = root("tpl-elements");
        let entries = view.entries_raw();
        entries
            .iter()
            .find(|e| {
                e.parent.as_ref() == Some(&elements)
                    && !e.is_trashed()
                    && e.template
                        .as_ref()
                        .is_some_and(|t| t.as_str() == "tpl-category")
                    && e.overrides
                        .as_ref()
                        .and_then(|o| o.default_template.as_ref())
                        .and_then(|d| d.as_ref())
                        .is_some_and(|t| t.as_str() == leaf_tpl)
            })
            .or_else(|| {
                entries.iter().find(|e| {
                    e.parent.as_ref() == Some(&elements)
                        && !e.is_trashed()
                        && e.template
                            .as_ref()
                            .is_some_and(|t| t.as_str() == "tpl-category")
                })
            })
            .expect("novel test category")
            .id
            .clone()
    };
    let parent: Option<dr_model::id::EntryId> = match template {
        "tpl-chapter" | "tpl-group" => Some(root("tpl-manuscript")),
        "tpl-idea" | "tpl-idea-group" => Some(root("tpl-ideas")),
        "tpl-storyline" => Some(root("tpl-storylines")),
        "tpl-category" => Some(root("tpl-elements")),
        "tpl-element" | "tpl-character" => Some(cat("tpl-character")),
        "tpl-location" => Some(cat("tpl-location")),
        "tpl-item" => Some(cat("tpl-item")),
        "tpl-organization" => Some(cat("tpl-organization")),
        "tpl-note" => None,
        _ => panic!("explicit fixture template required"),
    };
    let mut input =
        serde_json::json!({"book":book,"parent":parent,"template":template,"title":title});
    if let Some(text) = text {
        input["bodies"] = serde_json::json!({"mod-prose":text});
    }
    ws.call(actor, "entry.create", input)
        .expect("canonical test entry")["output"]
        .clone()
}
pub fn novel_entry(
    ws: &dr_workspace::Workspace,
    book: &str,
    template: &str,
    title: &str,
    text: Option<&str>,
) -> serde_json::Value {
    novel_entry_as(&dr_workspace::Actor::User, ws, book, template, title, text)
}

/// An empty genuine previous-format document for refusal tests. It contains
/// no new corpus and never passes through the App's creation commands.
pub fn empty_source(lib: &dr_store::Library) -> String {
    let id = dr_model::id::BookId::new_v7();
    let bytes = dr_doc::import_v1::genesis(&id);
    let handle = lib
        .open_doc(
            &format!("book:{id}"),
            dr_store::OpenDoc::CreateIfMissing {
                kind: "book",
                book_id: Some(id.as_str()),
                genesis: &move |doc| {
                    doc.import(&bytes).unwrap();
                },
            },
        )
        .unwrap();
    handle
        .write(dr_store::Origin::Import, |doc| {
            doc.get_map("meta")
                .insert("name", "Synthetic source format")
                .unwrap();
        })
        .unwrap();
    handle.close();
    id.to_string()
}

/// Resolve a canonical novel root through its template, for small command
/// tests which deliberately use dynamic project-created identities.
pub fn novel_root(
    ws: &dr_workspace::Workspace,
    book: &impl serde::Serialize,
    template: &str,
) -> String {
    let value = serde_json::to_value(book).unwrap();
    let book = value.as_str().expect("test book id");
    let id = dr_model::id::BookId::parse(book).unwrap();
    let raw = ws.library().load_copy(&format!("book:{book}")).unwrap();
    let b = dr_doc::v3::BorrowedBookV3::new(&raw, &id).unwrap();
    b.view()
        .root_entry_by_template(&dr_model::id::EntryTemplateId::parse(template).unwrap())
        .expect("novel root")
        .id
        .to_string()
}

/// Fixture discovery through the canonical query; it grants no Agent coverage.
pub fn entries_by_template(
    ws: &dr_workspace::Workspace,
    book: &impl serde::Serialize,
    template: &str,
) -> Vec<serde_json::Value> {
    ws.call(
        &dr_workspace::Actor::User,
        "entry.list",
        serde_json::json!({"book":book,"all":true}),
    )
    .unwrap()["output"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["template"] == template)
        .cloned()
        .collect()
}

/// Entry history is the canonical recovery boundary (not the retired Agent
/// selective-revert API). These are ordinary author commands in tests.
pub fn entry_point(
    ws: &dr_workspace::Workspace,
    book: &impl serde::Serialize,
    entry: &impl serde::Serialize,
) -> serde_json::Value {
    ws.call(
        &dr_workspace::Actor::User,
        "entry_snapshot.create",
        serde_json::json!({"book":book,"entry":entry}),
    )
    .unwrap()["output"]["id"]
        .clone()
}
pub fn restore_entry(
    ws: &dr_workspace::Workspace,
    book: &impl serde::Serialize,
    entry: &impl serde::Serialize,
    point: &impl serde::Serialize,
) {
    let expected = ws
        .call(
            &dr_workspace::Actor::User,
            "entry_snapshot.preview",
            serde_json::json!({"book":book,"entry":entry,"point":point}),
        )
        .unwrap()["output"]["expected"]
        .clone();
    ws.call(
        &dr_workspace::Actor::User,
        "entry_snapshot.restore",
        serde_json::json!({"book":book,"entry":entry,"point":point,"expected":expected}),
    )
    .unwrap();
}
