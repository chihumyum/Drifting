use dr_view_templates::model;
use dr_workspace::{
    Actor, Workspace,
    commands::{
        BookIn,
        v3::{template::TemplateList, types::*},
    },
};
use serde_json::{Value, json};

fn seed() -> (tempfile::TempDir, Workspace, String) {
    let dir = tempfile::tempdir().unwrap();
    let store =
        dr_store::Library::open(dir.path(), dr_workspace::library_options("0.2.0-dev")).unwrap();
    let seed = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let book = seed.books[0].book_id().to_string();
    seed.write_to(&store).unwrap();
    store.close().unwrap();
    let ws = Workspace::open_dir(dir.path(), "0.2.0-dev").unwrap();
    (dir, ws, book)
}
fn templates(ws: &Workspace, book: &str) -> Vec<EntryTemplate> {
    ws.run::<TemplateList>(&Actor::User, BookIn { book: book.into() })
        .unwrap()
        .output
}
fn call(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input).unwrap()["output"].clone()
}

#[test]
fn leaf_manifest_roundtrips_all_types_names_and_fractional_order() {
    let (_dir, ws, book) = seed();
    let mut t = model::blank("leaf", "Synthetic template".into());
    t.mark = Some("future-mark".into());
    for kind in model::MODULES.iter().chain(model::FIELDS) {
        model::add_module(&mut t, model::module(kind, format!("Synthetic {kind}")));
    }
    let original = model::save(&ws, &book, None, &t).unwrap();
    let loaded = templates(&ws, &book)
        .into_iter()
        .find(|x| x.id == t.id)
        .unwrap();
    assert_eq!(original, loaded);
    let mut draft = loaded.clone();
    let last = draft.modules.last().unwrap().id.clone();
    let first = draft.modules[0].id.clone();
    let untouched = draft.modules[0].pos.clone();
    model::move_module(&mut draft, &last, Some(&first));
    assert_eq!(draft.modules[1].pos, untouched);
    draft.modules[0].name = "Synthetic renamed".into();
    let saved = model::save(&ws, &book, Some(&loaded), &draft).unwrap();
    let loaded = templates(&ws, &book)
        .into_iter()
        .find(|x| x.id == t.id)
        .unwrap();
    assert_eq!(saved, loaded);
    assert_eq!(loaded.modules[0].id, last);
    assert_eq!(loaded.mark.as_deref(), Some("future-mark"));
    ws.shutdown().unwrap();
}

#[test]
fn removal_keeps_entry_values_and_multiple_prose_documents() {
    let (_dir, ws, book) = seed();
    let mut t = model::blank("leaf", "Synthetic template".into());
    for kind in ["prose", "text", "prose"] {
        model::add_module(&mut t, model::module(kind, kind.into()));
    }
    let t = model::save(&ws, &book, None, &t).unwrap();
    let entry = call(
        &ws,
        "entry.create",
        json!({"book":book,"title":"Synthetic entry","template":t.id}),
    );
    let entry = entry["id"].as_str().unwrap();
    let module = &t.modules[0].id;
    call(
        &ws,
        "module.set_prose",
        json!({"book":book,"owner":entry,"module":module,"paragraphs":[{"text":"Synthetic retained prose"}]}),
    );
    let field = &t.modules[1];
    call(
        &ws,
        "module.set_field",
        json!({"book":book,"entry":entry,"module":field.id,"field":field.config.defs[0].id,"value":"Synthetic retained value"}),
    );
    let mut draft = t.clone();
    draft.modules.drain(0..2);
    model::save(&ws, &book, Some(&t), &draft).unwrap();
    let prose = call(
        &ws,
        "module.read_prose",
        json!({"book":book,"owner":entry,"module":module}),
    );
    assert!(prose.to_string().contains("Synthetic retained prose"));
    let entry = call(&ws, "entry.get", json!({"book":book,"id":entry}));
    assert_eq!(
        entry["fields"][&field.id][&field.config.defs[0].id],
        "Synthetic retained value"
    );
    ws.shutdown().unwrap();
}

#[test]
fn concurrent_disjoint_edits_merge_and_overlapping_edits_refuse() {
    let (_dir, ws, book) = seed();
    let t = templates(&ws, &book)
        .into_iter()
        .find(|t| t.id == "tpl-chapter")
        .unwrap();
    let mut mine = t.clone();
    mine.name = "Synthetic renamed".into();
    let mut theirs = t.clone();
    theirs.mark = Some("unknown-mark".into());
    theirs.modules[0].config.show_outline = !theirs.modules[0].config.show_outline;
    model::save(&ws, &book, Some(&t), &theirs).unwrap();
    let saved = model::save(&ws, &book, Some(&t), &mine).unwrap();
    assert_eq!(saved.name, mine.name);
    assert_eq!(saved.mark, theirs.mark);
    assert_eq!(saved.modules, theirs.modules);
    mine.name = "Synthetic conflict".into();
    assert!(matches!(
        model::save(&ws, &book, Some(&t), &mine),
        Err(dr_workspace::WsError::Conflict(_))
    ));
    assert_eq!(
        templates(&ws, &book)
            .into_iter()
            .find(|x| x.id == t.id)
            .unwrap(),
        saved
    );
    ws.shutdown().unwrap();
}

#[test]
fn concurrent_module_deletion_cannot_hide_another_authors_edit() {
    let mut t = model::blank("leaf", "Synthetic".into());
    model::add_module(&mut t, model::module("text", "Synthetic".into()));
    let mut mine = t.clone();
    mine.modules.clear();
    let mut remote = t.clone();
    remote.modules[0].name = "Changed elsewhere".into();
    assert!(model::reconcile(&t, &mine, &remote).is_err());
}

#[test]
fn moving_between_equal_position_keys_never_drops_a_module() {
    let (_dir, ws, book) = seed();
    let mut template = model::blank("leaf", "Synthetic tied positions".into());
    for kind in ["prose", "text", "kv"] {
        let mut module = model::module(kind, kind.into());
        module.pos = Some("a0".into());
        template.modules.push(module);
    }
    let template = model::save(&ws, &book, None, &template).unwrap();
    // Work from the reader's actual tie order.
    let template = templates(&ws, &book)
        .into_iter()
        .find(|t| t.id == template.id)
        .unwrap();
    let mut draft = template.clone();
    let last = draft.modules[2].id.clone();
    let before = draft.modules[1].id.clone();
    model::move_module(&mut draft, &last, Some(&before));
    assert_eq!(draft.modules.len(), 3);
    assert_eq!(draft.modules[1].id, last);
    let saved = model::save(&ws, &book, Some(&template), &draft).unwrap();
    assert_eq!(
        templates(&ws, &book)
            .into_iter()
            .find(|t| t.id == saved.id)
            .unwrap(),
        saved
    );
    ws.shutdown().unwrap();
}
