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
    let mut t = model::blank("Synthetic template".into());
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
    let mut t = model::blank("Synthetic template".into());
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
    let mut t = model::blank("Synthetic".into());
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
    let mut template = model::blank("Synthetic tied positions".into());
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

#[test]
fn resetting_nullable_settings_merges_an_unrelated_remote_setting() {
    let (_dir, ws, book) = seed();
    let mut template = model::blank("Synthetic inheritance".into());
    template.level = true;
    template.settings.default_template = Some(None);
    template.settings.home = Some(None);
    template.settings.lane = Some(true);
    let template = model::save(&ws, &book, None, &template).unwrap();
    let mut mine = template.clone();
    mine.settings.default_template = None;
    mine.settings.home = None;
    mine.settings.lane = None;
    let mut remote = template.clone();
    remote.settings.display = Some("grid".into());
    model::save(&ws, &book, Some(&template), &remote).unwrap();
    let merged = model::save(&ws, &book, Some(&template), &mine).unwrap();
    assert_eq!(merged.settings.default_template, None);
    assert_eq!(merged.settings.home, None);
    assert_eq!(merged.settings.lane, None);
    assert_eq!(merged.settings.display.as_deref(), Some("grid"));
    assert_eq!(
        templates(&ws, &book)
            .into_iter()
            .find(|t| t.id == merged.id),
        Some(merged)
    );
    ws.shutdown().unwrap();
}

#[test]
fn level_settings_roundtrip_and_control_real_entry_residence_and_membership() {
    let (_dir, ws, book) = seed();
    let mut home_template = model::blank("Synthetic residence".into());
    home_template.level = true;
    let home_template = model::save(&ws, &book, None, &home_template).unwrap();
    let home = call(
        &ws,
        "entry.create",
        json!({"book":book,"title":"Synthetic home","template":home_template.id}),
    );
    let mut template = model::blank("Synthetic lane".into());
    template.level = true;
    for kind in model::FIELDS.iter().copied().chain(["kv"]) {
        model::add_module(&mut template, model::module(kind, kind.into()));
    }
    template.settings = LevelSettingsOverride {
        default_template: Some(Some("tpl-chapter".into())),
        display: Some("board".into()),
        auto_link: Some(true),
        accept: Some(false),
        home: Some(Some(home["id"].as_str().unwrap().into())),
        is_manuscript: Some(false),
        format_shortcuts: Some("notes".into()),
        lane: Some(true),
    };
    let template = model::save(&ws, &book, None, &template).unwrap();
    assert_eq!(
        templates(&ws, &book)
            .into_iter()
            .find(|t| t.id == template.id),
        Some(template.clone())
    );
    let lane = call(
        &ws,
        "entry.create",
        json!({"book":book,"title":"Synthetic lane","template":template.id}),
    );
    let level = call(&ws, "entry.get", json!({"book":book,"id":lane["id"]}))["below"].clone();
    assert_eq!(level["settings"]["accept"], true);
    assert_eq!(level["settings"]["lane"], true);
    assert_eq!(level["settings"]["format_shortcuts"], "notes");
    assert_eq!(level["settings"]["home"], home["id"]);
    let entry = call(
        &ws,
        "entry.create",
        json!({"book":book,"title":"Synthetic new entry","parent":lane["id"]}),
    );
    assert_eq!(entry["template"], "tpl-chapter");
    assert_eq!(entry["parent"], home["id"]);
    assert_eq!(entry["primary"], lane["id"]);
    let level = call(&ws, "entry.get", json!({"book":book,"id":lane["id"]}))["below"].clone();
    assert!(
        level["members"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["id"] == entry["id"])
    );
    let mut disabled = template.clone();
    disabled.settings.lane = Some(false);
    model::save(&ws, &book, Some(&template), &disabled).unwrap();
    let level = call(&ws, "entry.get", json!({"book":book,"id":lane["id"]}))["below"].clone();
    assert_eq!(level["settings"]["accept"], false);
    // The editor never replaces a stored false value with the lane's forced true.
    assert_eq!(disabled.settings.accept, Some(false));
    // Any template takes any module: a level template's own prose too.
    let mut with_prose = disabled.clone();
    model::add_module(
        &mut with_prose,
        model::module("prose", "Synthetic level body".into()),
    );
    model::save(&ws, &book, Some(&disabled), &with_prose).unwrap();
    ws.shutdown().unwrap();
}

#[test]
fn actions_require_stable_unique_ids_and_live_allowed_targets_before_any_write() {
    let (_dir, ws, book) = seed();
    let mut template = model::blank("Synthetic actions".into());
    template.level = true;
    let saved = model::save(&ws, &book, None, &template).unwrap();
    let action = TemplateVerb {
        id: dr_model::id::new_uuid_v7(),
        name: "Synthetic create".into(),
        description: "Synthetic authored description".into(),
        target_template: Some("tpl-chapter".into()),
        pos: Some("a0".into()),
    };
    for target in [None, Some("missing-template")] {
        let mut invalid = saved.clone();
        let mut verb = action.clone();
        verb.target_template = target.map(str::to_owned);
        invalid.verbs.push(verb);
        assert!(model::save(&ws, &book, Some(&saved), &invalid).is_err());
        assert_eq!(
            templates(&ws, &book).into_iter().find(|t| t.id == saved.id),
            Some(saved.clone())
        );
    }
    let mut invalid = saved.clone();
    invalid.verbs = vec![action.clone(), action.clone()];
    assert!(model::save(&ws, &book, Some(&saved), &invalid).is_err());
    template.verbs.push(action.clone());
    let saved = model::save(&ws, &book, Some(&saved), &template).unwrap();
    template.verbs[0].name = "Synthetic renamed action".into();
    let saved = model::save(&ws, &book, Some(&saved), &template).unwrap();
    assert_eq!(saved.verbs[0].id, action.id);
    assert_eq!(saved.verbs[0].description, action.description);
    let target = model::blank("Synthetic action target".into());
    let target = model::save(&ws, &book, None, &target).unwrap();
    template.verbs[0].target_template = Some(target.id.clone());
    let saved = model::save(&ws, &book, Some(&saved), &template).unwrap();
    call(
        &ws,
        "entry_template.delete",
        json!({"book":book,"id":target.id}),
    );
    template.name = "Synthetic stale target draft".into();
    assert!(model::save(&ws, &book, Some(&saved), &template).is_err());
    assert_eq!(
        templates(&ws, &book).into_iter().find(|t| t.id == saved.id),
        Some(saved.clone())
    );
    template.verbs.clear();
    let saved = model::save(&ws, &book, Some(&saved), &template).unwrap();
    assert!(saved.verbs.is_empty());
    ws.shutdown().unwrap();
}

#[test]
fn default_level_switch_collapses_without_erasing_settings_and_never_mutates_existing_entries() {
    let (_dir, ws, book) = seed();
    let mut template = model::blank("Synthetic switchable template".into());
    template.level = true;
    template.settings.lane = Some(true);
    template.settings.display = Some("board".into());
    template.settings.default_template = Some(Some("tpl-chapter".into()));
    template.verbs.push(TemplateVerb {
        id: dr_model::id::new_uuid_v7(),
        name: "Synthetic level action".into(),
        description: "Synthetic action kept while collapsed".into(),
        target_template: Some("tpl-chapter".into()),
        pos: Some("a0".into()),
    });
    let saved_on = model::save(&ws, &book, None, &template).unwrap();
    assert!(saved_on.level);

    let entry_a = call(
        &ws,
        "entry.create",
        json!({"book":book,"title":"Synthetic created while on","template":saved_on.id}),
    );
    assert_eq!(entry_a["level"], true);
    let get_a = call(&ws, "entry.get", json!({"book":book,"id":entry_a["id"]}));
    assert_eq!(get_a["below"]["settings"]["lane"], true);
    assert_eq!(get_a["below"]["settings"]["display"], "board");

    // Turning off the template's default level switch keeps stored settings and
    // actions, and never retrofits existing entries.
    let mut collapsed = saved_on.clone();
    collapsed.level = false;
    let saved_off = model::save(&ws, &book, Some(&saved_on), &collapsed).unwrap();
    assert!(!saved_off.level);
    assert_eq!(saved_off.settings.lane, Some(true));
    assert_eq!(saved_off.settings.display.as_deref(), Some("board"));
    assert_eq!(saved_off.verbs.len(), 1);

    let get_a_after = call(&ws, "entry.get", json!({"book":book,"id":entry_a["id"]}));
    assert_eq!(get_a_after["level"], true);
    assert_eq!(get_a_after["below"]["settings"]["lane"], true);
    assert_eq!(get_a_after["below"]["settings"]["display"], "board");

    let entry_b = call(
        &ws,
        "entry.create",
        json!({"book":book,"title":"Synthetic created while off","template":saved_off.id}),
    );
    assert_eq!(entry_b["level"], false);
    let get_b = call(&ws, "entry.get", json!({"book":book,"id":entry_b["id"]}));
    assert!(get_b["below"].is_null());

    // Re-enabling the template's default level switch leaves entry B untouched.
    let mut reopened = saved_off.clone();
    reopened.level = true;
    let saved_reopened = model::save(&ws, &book, Some(&saved_off), &reopened).unwrap();
    assert!(saved_reopened.level);
    let get_b_after = call(&ws, "entry.get", json!({"book":book,"id":entry_b["id"]}));
    assert_eq!(get_b_after["level"], false);
    ws.shutdown().unwrap();
}

#[test]
fn prose_in_book_children_module_and_linkable_govern_manuscript_and_autolinks() {
    let (_dir, ws, book) = seed();
    let (manuscript_id, category_id) = {
        let copy = ws.library().load_copy(&format!("book:{book}")).unwrap();
        let borrowed = dr_doc::v3::BorrowedBookV3::new(&copy, &book.parse().unwrap()).unwrap();
        let entries = borrowed.view().entries();
        let manuscript = entries
            .iter()
            .find(|e| e.template.as_ref().map(|t| t.as_str()) == Some("tpl-manuscript"))
            .unwrap()
            .id
            .to_string();
        let category = entries
            .iter()
            .find(|e| e.template.as_ref().map(|t| t.as_str()) == Some("tpl-category"))
            .unwrap()
            .id
            .to_string();
        (manuscript, category)
    };

    let mut template = model::blank("Synthetic dual prose".into());
    template.linkable = false;
    let body = model::module("prose", "Synthetic body".into());
    let body_id = body.id.clone();
    model::add_module(&mut template, body);
    let children = model::module("children", "Synthetic entries below".into());
    let children_id = children.id.clone();
    model::add_module(&mut template, children);
    let mut notes = model::module("prose", "Synthetic private notes".into());
    notes.config.in_book = false;
    let notes_id = notes.id.clone();
    model::add_module(&mut template, notes);

    let saved = model::save(&ws, &book, None, &template).unwrap();
    assert!(!saved.linkable);
    assert_eq!(saved.modules[1].id, children_id);
    assert_eq!(saved.modules[1].kind, "children");
    assert!(saved.modules[0].config.in_book);
    assert!(!saved.modules[2].config.in_book);

    let chapter = call(
        &ws,
        "entry.create",
        json!({"book":book,"parent":manuscript_id,"title":"Synthetic dual chapter","template":saved.id}),
    );
    let chapter_id = chapter["id"].as_str().unwrap().to_string();
    call(
        &ws,
        "module.set_prose",
        json!({"book":book,"owner":chapter_id,"module":body_id,"paragraphs":[{"text":"Synthetic counted prose"}]}),
    );
    call(
        &ws,
        "module.set_prose",
        json!({"book":book,"owner":chapter_id,"module":notes_id,"paragraphs":[{"text":"Synthetic uncounted notes"}]}),
    );

    let manuscript_prose_for = |ws: &Workspace, book: &str, entry_id: &str| -> Vec<String> {
        let copy = ws.library().load_copy(&format!("book:{book}")).unwrap();
        let borrowed = dr_doc::v3::BorrowedBookV3::new(&copy, &book.parse().unwrap()).unwrap();
        let view = borrowed.view();
        let snapshot = view.structure_snapshot();
        snapshot
            .manuscript()
            .into_iter()
            .flat_map(|part| {
                part.entries
                    .into_iter()
                    .filter(|e| e.entry.id.as_str() == entry_id)
                    .flat_map(|e| {
                        e.prose
                            .into_iter()
                            .map(|p| p.module.to_string())
                            .collect::<Vec<_>>()
                    })
                    .collect::<Vec<_>>()
            })
            .collect()
    };
    assert_eq!(
        manuscript_prose_for(&ws, &book, &chapter_id),
        vec![body_id.clone()]
    );

    let mut flipped = saved.clone();
    flipped.modules[0].config.in_book = false;
    flipped.modules[2].config.in_book = true;
    let saved = model::save(&ws, &book, Some(&saved), &flipped).unwrap();
    assert_eq!(
        manuscript_prose_for(&ws, &book, &chapter_id),
        vec![notes_id]
    );

    // Linkable governs auto-link name participation and uniqueness checks.
    let _existing = call(
        &ws,
        "entry.create",
        json!({"book":book,"parent":category_id,"title":"Synthetic Shared Autolink","template":"tpl-character"}),
    );
    let custom_entry = call(
        &ws,
        "entry.create",
        json!({"book":book,"parent":category_id,"title":"Synthetic Shared Autolink","template":saved.id}),
    );
    let custom_entry_id: dr_model::id::EntryId =
        custom_entry["id"].as_str().unwrap().parse().unwrap();

    let is_linked = |ws: &Workspace, book: &str, id: &dr_model::id::EntryId| -> bool {
        let copy = ws.library().load_copy(&format!("book:{book}")).unwrap();
        let borrowed = dr_doc::v3::BorrowedBookV3::new(&copy, &book.parse().unwrap()).unwrap();
        let view = borrowed.view();
        let entries: std::collections::BTreeMap<_, _> = view
            .entries()
            .into_iter()
            .map(|e| (e.id.clone(), e))
            .collect();
        let names = dr_model::v3::AutolinkNames::of(
            &entries,
            &view.memberships_raw(),
            &view.templates_map(),
        );
        names.is_linked(id)
    };
    assert!(!is_linked(&ws, &book, &custom_entry_id));

    let mut make_linkable = saved.clone();
    make_linkable.linkable = true;
    assert!(model::save(&ws, &book, Some(&saved), &make_linkable).is_err());

    call(
        &ws,
        "entry.update",
        json!({"book":book,"id":custom_entry_id.as_str(),"title":"Synthetic Unique Autolink"}),
    );
    let saved = model::save(&ws, &book, Some(&saved), &make_linkable).unwrap();
    assert!(saved.linkable);
    assert!(is_linked(&ws, &book, &custom_entry_id));
    ws.shutdown().unwrap();
}

#[test]
fn a_template_places_the_children_module_once() {
    let mut t = model::blank("Synthetic".into());
    model::add_module(&mut t, model::module("children", "Below".into()));
    model::add_module(&mut t, model::module("children", "Below again".into()));
    model::add_module(&mut t, model::module("prose", "Text".into()));
    assert_eq!(t.modules.iter().filter(|m| m.kind == "children").count(), 1);
    assert_eq!(t.modules.len(), 2);
    assert!(model::has_children_module(&t));
}
