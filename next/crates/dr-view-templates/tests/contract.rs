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

#[test]
fn resetting_nullable_settings_merges_an_unrelated_remote_setting() {
    let (_dir, ws, book) = seed();
    let mut template = model::blank("level", "Synthetic inheritance".into());
    template.settings.default_template = Some(None);
    template.settings.home = Some(None);
    let template = model::save(&ws, &book, None, &template).unwrap();
    let mut mine = template.clone();
    mine.settings.default_template = None;
    mine.settings.home = None;
    let mut remote = template.clone();
    remote.settings.display = Some("grid".into());
    model::save(&ws, &book, Some(&template), &remote).unwrap();
    let merged = model::save(&ws, &book, Some(&template), &mine).unwrap();
    assert_eq!(merged.settings.default_template, None);
    assert_eq!(merged.settings.home, None);
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
    let home_template = model::blank("level", "Synthetic residence".into());
    let home_template = model::save(&ws, &book, None, &home_template).unwrap();
    let home = call(
        &ws,
        "entry.create",
        json!({"book":book,"title":"Synthetic home","template":home_template.id}),
    );
    let mut template = model::blank("level", "Synthetic lane".into());
    for kind in model::FIELDS.iter().copied().chain(["kv"]) {
        model::add_module(&mut template, model::module(kind, kind.into()));
    }
    template.settings = LevelSettingsOverride {
        default_template: Some(Some("tpl-chapter".into())),
        allow: Some(vec!["tpl-chapter".into()]),
        display: Some("board".into()),
        auto_link: Some(true),
        accept: Some(false),
        home: Some(Some(home["id"].as_str().unwrap().into())),
        is_manuscript: Some(false),
        format_shortcuts: Some("notes".into()),
    };
    template.lane = true;
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
    let level = call(&ws, "level.get", json!({"book":book,"id":lane["id"]}));
    assert_eq!(level["settings"]["accept"], true);
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
    let level = call(&ws, "level.get", json!({"book":book,"id":lane["id"]}));
    assert!(
        level["members"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["id"] == entry["id"])
    );
    let mut disabled = template.clone();
    disabled.lane = false;
    model::save(&ws, &book, Some(&template), &disabled).unwrap();
    let level = call(&ws, "level.get", json!({"book":book,"id":lane["id"]}));
    assert_eq!(level["settings"]["accept"], false);
    // The editor never replaces a stored false value with the lane's forced true.
    assert_eq!(disabled.settings.accept, Some(false));
    let mut forbidden = disabled.clone();
    model::add_module(
        &mut forbidden,
        model::module("prose", "Synthetic forbidden body".into()),
    );
    assert!(model::save(&ws, &book, Some(&disabled), &forbidden).is_err());
    ws.shutdown().unwrap();
}

#[test]
fn actions_require_stable_unique_ids_and_live_allowed_targets_before_any_write() {
    let (_dir, ws, book) = seed();
    let mut template = model::blank("level", "Synthetic actions".into());
    template.settings.allow = Some(vec!["tpl-chapter".into()]);
    let saved = model::save(&ws, &book, None, &template).unwrap();
    let action = TemplateVerb {
        id: dr_model::id::new_uuid_v7(),
        name: "Synthetic create".into(),
        description: "Synthetic authored description".into(),
        target_template: Some("tpl-chapter".into()),
        pos: Some("a0".into()),
    };
    for target in [None, Some("tpl-character"), Some("missing-template")] {
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
    let target = model::blank("leaf", "Synthetic action target".into());
    let target = model::save(&ws, &book, None, &target).unwrap();
    template.settings.allow = Some(vec![]);
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
