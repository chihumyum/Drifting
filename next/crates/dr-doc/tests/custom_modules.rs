//! Custom modules in dr-doc (`custom-modules.md` §7, §11, §14): my modules'
//! library documents, a book's copies, the values an entry keeps and how
//! they survive replacing a copy, merging and undo. The sample modules are
//! dr-testkit's fixtures, read by path (dr-testkit depends on this crate).

use dr_doc::DocError;
use dr_doc::custom_module::{ModuleDoc, ModuleInfo, ModuleOrigin, genesis};
use dr_doc::v3::BookDocV3;
use dr_doc::v3::modules::CopySource;
use dr_model::custom_module::values::{BlockValue, ItemStep, StoredValue, read_scope};
use dr_model::custom_module::{BlockKind, ModuleValue, parse_module_json, to_canonical_json};
use dr_model::id::{BookId, CustomModuleId, EntryId, EntryTemplateId, ModuleId, ModuleItemId};
use dr_model::v3::{EntryTemplate, ModuleSpec};
use dr_model::{Origin, Timestamp};
use loro::VersionVector;

const FORESHADOWING: &str =
    include_str!("../../dr-testkit/fixtures/modules/foreshadowing.driftingmodule");
const CHRONOLOGY: &str =
    include_str!("../../dr-testkit/fixtures/modules/world-chronology.driftingmodule");
const MAGIC: &str = include_str!("../../dr-testkit/fixtures/modules/magic-rule.driftingmodule");

fn module(raw: &str) -> ModuleValue {
    parse_module_json(raw).unwrap()
}

fn info(ms: i64) -> ModuleInfo {
    ModuleInfo {
        origin: ModuleOrigin::Own,
        created_at: Some(Timestamp(ms)),
        updated_at: Some(Timestamp(ms)),
    }
}

fn sync(from: &ModuleDoc, to: &mut ModuleDoc) {
    let bytes = from
        .export_updates_since(&VersionVector::default())
        .unwrap();
    to.import(&bytes, Origin::Sync).unwrap();
}

#[test]
fn a_module_document_keeps_one_whole_module_when_two_devices_save() {
    let id = CustomModuleId::new_v7();
    assert_eq!(genesis(&id), genesis(&id), "genesis is deterministic");
    let mut a = ModuleDoc::create(id.clone(), 11).unwrap();
    let mut b = ModuleDoc::create(id.clone(), 22).unwrap();
    let first = module(FORESHADOWING);
    let (r, _) = a.edit(Origin::User, |t| {
        t.save(&info(1), &first)
            .map_err(|_| DocError::NotInProfile("save"))
    });
    r.unwrap();
    sync(&a, &mut b);
    assert_eq!(b.view().value().unwrap(), first);
    assert_eq!(b.view().raw_value().unwrap(), FORESHADOWING);

    // A renames, B changes the blocks, at once: one of the two whole.
    let mut renamed = first.clone();
    renamed.name = "伏笔".into();
    let mut reblocked = first.clone();
    reblocked.blocks[0].blocks.pop();
    reblocked.look.block = dr_model::custom_module::Node::Box(
        dr_model::custom_module::BoxNode::new(dr_model::custom_module::BoxDir::Col),
    );
    reblocked.sample.clear();
    reblocked.agent.blocks.remove("back");
    let (r, _) = a.edit(Origin::User, |t| {
        t.save(&info(2), &renamed)
            .map_err(|_| DocError::NotInProfile("save"))
    });
    r.unwrap();
    let (r, _) = b.edit(Origin::User, |t| {
        t.save(&info(3), &reblocked)
            .map_err(|_| DocError::NotInProfile("save"))
    });
    r.unwrap();
    sync(&a, &mut b);
    sync(&b, &mut a);
    let got_a = a.view().value().unwrap();
    let got_b = b.view().value().unwrap();
    assert_eq!(got_a, got_b);
    assert!(got_a == renamed || got_a == reblocked, "{got_a:?}");
}

#[test]
fn a_module_document_refuses_what_is_not_a_module() {
    let id = CustomModuleId::new_v7();
    let mut doc = ModuleDoc::create(id.clone(), 11).unwrap();
    let mut bad = module(FORESHADOWING);
    bad.look.line = Some(dr_model::custom_module::Node::Mark(
        dr_model::custom_module::MarkNode {
            mark: "star".into(),
        },
    ));
    let (r, c) = doc.edit(Origin::User, |t| {
        t.save(&info(1), &bad)
            .map_err(|_| DocError::NotInProfile("save"))
    });
    assert!(r.is_err());
    assert!(c.is_none(), "nothing written");
    // An update from elsewhere carrying a module this build refuses.
    let mut other = ModuleDoc::create(id.clone(), 33).unwrap();
    let (r, _) = other.edit(Origin::User, |t| {
        t.save(&info(1), &module(FORESHADOWING))
            .map_err(|_| DocError::NotInProfile("save"))
    });
    r.unwrap();
    // Forge a record whose value is not valid, as a damaged peer might.
    let forged = loro::LoroDoc::new();
    forged.import(&other.export_snapshot().unwrap()).unwrap();
    forged.set_peer_id(44).unwrap();
    let record: std::collections::HashMap<String, loro::LoroValue> = [
        ("info".to_owned(), loro::LoroValue::from(std::collections::HashMap::<String, loro::LoroValue>::new())),
        ("value".to_owned(), loro::LoroValue::from("{\"format\": \"drifting.module\", \"formatVersion\": 1, \"name\": \"x\", \"look\": {\"block\": {\"box\": \"col\", \"color\": \"red\"}}}")),
    ]
    .into_iter()
    .collect();
    forged
        .get_map("payload")
        .insert("record", loro::LoroValue::from(record))
        .unwrap();
    forged.commit();
    let bytes = forged
        .export(loro::ExportMode::updates(&other.version()))
        .unwrap();
    assert!(other.import(&bytes, Origin::Sync).is_err());
    assert_eq!(other.view().value().unwrap(), module(FORESHADOWING));
}

struct Book {
    doc: BookDocV3,
    entry: EntryId,
    template: EntryTemplateId,
    module: ModuleId,
}

fn book_with(copy_id: &CustomModuleId, value: &ModuleValue) -> Book {
    let book = BookId::new_v7();
    let mut doc = BookDocV3::create(book, 7).unwrap();
    let template = EntryTemplateId::parse("tpl-chapter").unwrap();
    let module = ModuleId::parse("mod-custom").unwrap();
    let entry = EntryId::new_v7();
    let (r, _) = doc.edit(Origin::User, |t| {
        t.put_module_copy(copy_id, value, &CopySource::Library)?;
        let tpl = EntryTemplate {
            id: template.clone(),
            name: "章节".into(),
            mark: None,
            color: None,
            agent: None,
            modules: vec![ModuleSpec::custom(module.clone(), "伏笔", copy_id.clone())],
            level: false,
            linkable: true,
            settings: Default::default(),
            verbs: Vec::new(),
            deleted_at: None,
        };
        t.template(&template)?.set_full(&tpl)?;
        t.entries()
            .create(&entry, None, "第一章", Some(&template), false)?;
        Ok(())
    });
    r.unwrap();
    Book {
        doc,
        entry,
        template,
        module,
    }
}

#[test]
fn values_are_kept_by_block_id_and_survive_replacing_the_copy() {
    let id = CustomModuleId::new_v7();
    let original = module(FORESHADOWING);
    let mut b = book_with(&id, &original);
    let item = ModuleItemId::new_v7();
    let step = |item: &ModuleItemId| ItemStep {
        list: "items".into(),
        item: item.to_string(),
    };
    let (r, _) = b.doc.edit(Origin::User, |t| {
        let e = t.entries().entry(&b.entry)?;
        e.insert_custom_item(&b.module, &[], "items", None, &item)?;
        e.set_custom_value(
            &b.module,
            &[step(&item)],
            "line",
            Some(&StoredValue::Text("旧照片".into())),
        )?;
        e.set_custom_value(
            &b.module,
            &[step(&item)],
            "st",
            Some(&StoredValue::Text("埋着".into())),
        )?;
        Ok(())
    });
    r.unwrap();
    let view = b.doc.view();
    let copy = view.module_copy(&id).unwrap();
    assert_eq!(copy.source, CopySource::Library);
    assert_eq!(copy.raw, FORESHADOWING);
    let stored = view.custom_values(&b.entry, &b.module);
    let read = read_scope(copy.module().unwrap(), None, &stored);
    let Some(BlockValue::List(items)) = read.get("items") else {
        panic!("{read:?}")
    };
    assert_eq!(items[0].id, item.to_string());
    assert_eq!(
        items[0].values.get("st"),
        Some(&BlockValue::Select("埋着".into()))
    );

    // The copy is replaced: `st` deleted, `line` now a number. Nothing stored moves.
    let mut changed = original.clone();
    changed.blocks[0].blocks.retain(|b| b.id != "st");
    changed.blocks[0].blocks[0].kind = BlockKind::Number;
    changed.look.block = dr_model::custom_module::Node::Box(dr_model::custom_module::BoxNode::new(
        dr_model::custom_module::BoxDir::Col,
    ));
    changed.sample.clear();
    changed.agent.blocks.remove("st");
    let (r, _) = b.doc.edit(Origin::User, |t| {
        t.put_module_copy(&id, &changed, &CopySource::Library)
    });
    r.unwrap();
    let view = b.doc.view();
    let after = view.custom_values(&b.entry, &b.module);
    assert_eq!(after, stored, "replacing a copy touches no value");
    let read = read_scope(&changed, None, &after);
    let Some(BlockValue::List(items)) = read.get("items") else {
        panic!()
    };
    assert!(
        !items[0].values.contains_key("st"),
        "a deleted block is not shown"
    );
    assert!(
        !items[0].values.contains_key("line"),
        "\"旧照片\" does not read as a number"
    );
    // The block comes back, and so does its value.
    let (r, _) = b.doc.edit(Origin::User, |t| {
        t.put_module_copy(&id, &original, &CopySource::Library)
    });
    r.unwrap();
    let view = b.doc.view();
    let read = read_scope(&original, None, &view.custom_values(&b.entry, &b.module));
    let Some(BlockValue::List(items)) = read.get("items") else {
        panic!()
    };
    assert_eq!(
        items[0].values.get("st"),
        Some(&BlockValue::Select("埋着".into()))
    );
    assert_eq!(
        items[0].values.get("line"),
        Some(&BlockValue::Text("旧照片".into()))
    );
    let _ = b.template;
}

#[test]
fn a_broken_copy_reads_as_broken_and_keeps_its_name() {
    let id = CustomModuleId::new_v7();
    let b = book_with(&id, &module(FORESHADOWING));
    // A newer build's copy arrives (written straight into the book).
    let newer = FORESHADOWING.replace("\"formatVersion\": 1", "\"formatVersion\": 2");
    let record: std::collections::HashMap<String, loro::LoroValue> = [
        ("value".to_owned(), loro::LoroValue::from(newer.as_str())),
        ("source".to_owned(), loro::LoroValue::from("library")),
    ]
    .into_iter()
    .collect();
    let mut doc = b.doc;
    let raw = loro::LoroDoc::new();
    raw.import(&doc.export_snapshot().unwrap()).unwrap();
    raw.set_peer_id(99).unwrap();
    raw.get_map("modules")
        .insert(id.as_str(), loro::LoroValue::from(record))
        .unwrap();
    raw.commit();
    doc.import(
        &raw.export(loro::ExportMode::updates(&doc.version()))
            .unwrap(),
        Origin::Sync,
    )
    .unwrap();
    let copy = doc.view().module_copy(&id).unwrap();
    assert!(copy.is_broken());
    assert_eq!(copy.name().as_deref(), Some("伏笔追踪"));
    assert!(doc.view().module_copies().contains_key(&id));
}

#[test]
fn items_move_with_their_values_and_merge_by_id() {
    let id = CustomModuleId::new_v7();
    let chron = module(CHRONOLOGY);
    let mut a = book_with(&id, &chron);
    let era1 = ModuleItemId::new_v7();
    let era2 = ModuleItemId::new_v7();
    let ev = ModuleItemId::new_v7();
    let (r, _) = a.doc.edit(Origin::User, |t| {
        let e = t.entries().entry(&a.entry)?;
        e.insert_custom_item(&a.module, &[], "eras", None, &era1)?;
        e.insert_custom_item(&a.module, &[], "eras", None, &era2)?;
        let into_era1 = [ItemStep {
            list: "eras".into(),
            item: era1.to_string(),
        }];
        e.set_custom_value(
            &a.module,
            &into_era1,
            "era",
            Some(&StoredValue::Text("雾纪".into())),
        )?;
        e.insert_custom_item(&a.module, &into_era1, "events", None, &ev)?;
        let into_ev = [
            into_era1[0].clone(),
            ItemStep {
                list: "events".into(),
                item: ev.to_string(),
            },
        ];
        e.set_custom_value(
            &a.module,
            &into_ev,
            "year",
            Some(&StoredValue::Number(12.0)),
        )?;
        Ok(())
    });
    r.unwrap();
    // A second device, then each moves or edits.
    let mut b = BookDocV3::load(
        a.doc.book_id().clone(),
        8,
        &[a.doc.export_snapshot().unwrap()],
    )
    .unwrap();
    let (r, _) = a.doc.edit(Origin::User, |t| {
        t.entries()
            .entry(&a.entry)?
            .move_custom_item(&a.module, &[], "eras", era2.as_str(), 0)?;
        Ok(())
    });
    r.unwrap();
    let (r, _) = b.edit(Origin::User, |t| {
        t.entries().entry(&a.entry)?.set_custom_value(
            &a.module,
            &[ItemStep {
                list: "eras".into(),
                item: era1.to_string(),
            }],
            "span",
            Some(&StoredValue::Text("1–120".into())),
        )?;
        Ok(())
    });
    r.unwrap();
    a.doc
        .import(
            &b.export_updates_since(&a.doc.version()).unwrap(),
            Origin::Sync,
        )
        .unwrap();
    b.import(
        &a.doc.export_updates_since(&b.version()).unwrap(),
        Origin::Sync,
    )
    .unwrap();
    for view in [a.doc.view(), b.view()] {
        let read = read_scope(&chron, None, &view.custom_values(&a.entry, &a.module));
        let Some(BlockValue::List(eras)) = read.get("eras") else {
            panic!()
        };
        assert_eq!(eras.len(), 2);
        assert_eq!(eras[0].id, era2.to_string(), "the move kept");
        assert_eq!(
            eras[1].values.get("era"),
            Some(&BlockValue::Text("雾纪".into()))
        );
        assert_eq!(
            eras[1].values.get("span"),
            Some(&BlockValue::Text("1–120".into()))
        );
        let Some(BlockValue::List(events)) = eras[1].values.get("events") else {
            panic!()
        };
        assert_eq!(
            events[0].values.get("year"),
            Some(&BlockValue::Number(12.0))
        );
    }
    // A step that is not there writes nothing.
    let before = a.doc.version();
    let (r, c) = a.doc.edit(Origin::User, |t| {
        t.entries().entry(&a.entry)?.set_custom_value(
            &a.module,
            &[ItemStep {
                list: "eras".into(),
                item: "gone".into(),
            }],
            "era",
            Some(&StoredValue::Text("x".into())),
        )?;
        Ok(())
    });
    assert!(r.is_err());
    assert!(c.is_none());
    assert_eq!(a.doc.version(), before);
    // Removing an item takes what it keeps with it.
    let (r, _) = a.doc.edit(Origin::User, |t| {
        t.entries()
            .entry(&a.entry)?
            .remove_custom_item(&a.module, &[], "eras", era1.as_str())?;
        Ok(())
    });
    r.unwrap();
    let stored = a.doc.view().custom_values(&a.entry, &a.module);
    assert_eq!(stored.lists["eras"].len(), 1);
}

#[test]
fn undo_brings_values_back_from_an_entry_snapshot() {
    let id = CustomModuleId::new_v7();
    let chron = module(CHRONOLOGY);
    let mut b = book_with(&id, &chron);
    let era1 = ModuleItemId::new_v7();
    let era2 = ModuleItemId::new_v7();
    let (r, _) = b.doc.edit(Origin::User, |t| {
        let e = t.entries().entry(&b.entry)?;
        e.insert_custom_item(&b.module, &[], "eras", None, &era1)?;
        e.insert_custom_item(&b.module, &[], "eras", None, &era2)?;
        e.set_custom_value(
            &b.module,
            &[ItemStep {
                list: "eras".into(),
                item: era1.to_string(),
            }],
            "era",
            Some(&StoredValue::Text("雾纪".into())),
        )?;
        Ok(())
    });
    r.unwrap();
    let snapshot = b.doc.view().entry_snapshot(&b.entry).unwrap();
    let before = b.doc.view().custom_values(&b.entry, &b.module);
    // Then: era1 removed, era2 moved and renamed, a new one added.
    let (r, _) = b.doc.edit(Origin::User, |t| {
        let e = t.entries().entry(&b.entry)?;
        e.remove_custom_item(&b.module, &[], "eras", era1.as_str())?;
        e.insert_custom_item(&b.module, &[], "eras", Some(0), &ModuleItemId::new_v7())?;
        e.set_custom_value(
            &b.module,
            &[ItemStep {
                list: "eras".into(),
                item: era2.to_string(),
            }],
            "era",
            Some(&StoredValue::Text("钟纪".into())),
        )?;
        Ok(())
    });
    r.unwrap();
    assert_ne!(b.doc.view().custom_values(&b.entry, &b.module), before);
    let (r, _) = b
        .doc
        .edit(Origin::User, |t| t.restore_entry(&b.entry, &snapshot));
    r.unwrap();
    assert_eq!(b.doc.view().custom_values(&b.entry, &b.module), before);
}

#[test]
fn a_project_template_carries_the_modules_its_templates_draw() {
    let id = CustomModuleId::new_v7();
    let magic = module(MAGIC);
    let b = book_with(&id, &magic);
    let value = dr_doc::project_template::extract_project_template(
        &b.doc.view(),
        &dr_doc::project_template::ExtractTemplateMeta {
            name: "魔法书".into(),
            ..Default::default()
        },
        &dr_doc::project_template::ExtractSelection::default(),
        |_, _, _, _| Ok(None),
    )
    .unwrap();
    assert_eq!(value.modules.len(), 1);
    assert_eq!(value.modules[id.as_str()], magic);
    let spec = value
        .templates
        .iter()
        .flat_map(|t| &t.modules)
        .find(|m| m.config.module.is_some())
        .unwrap();
    assert!(!spec.config.in_book);
    assert_eq!(spec.config.module.as_deref(), Some(id.as_str()));
    // The template's canonical JSON round-trips.
    let json = dr_model::project_template::to_canonical_json(&value).unwrap();
    assert_eq!(
        dr_model::project_template::parse_project_template_json(&json).unwrap(),
        value
    );
    // A new project from it has the copy under the same id.
    let mat = dr_doc::project_template::materialize_project_template(&value, None).unwrap();
    let mut fresh = BookDocV3::create(BookId::new_v7(), 9).unwrap();
    let (r, _) = fresh.edit(Origin::User, |t| {
        dr_doc::project_template::apply_materialized_project_template(t, &mat, Timestamp(1))
    });
    r.unwrap();
    let copy = fresh.view().module_copy(&id).unwrap();
    assert_eq!(copy.source, CopySource::Template);
    assert_eq!(copy.raw, to_canonical_json(&magic).unwrap());
    // A template that carries a module nothing uses, or names one it does not carry, is refused.
    let mut unused = value.clone();
    unused
        .modules
        .insert(CustomModuleId::new_v7().to_string(), magic.clone());
    assert!(dr_model::project_template::validate_project_template_value(&unused).is_err());
    let mut dangling = value.clone();
    dangling.modules.clear();
    assert!(dr_model::project_template::validate_project_template_value(&dangling).is_err());
    let mut in_book = value;
    for t in &mut in_book.templates {
        for m in &mut t.modules {
            if m.config.module.is_some() {
                m.config.in_book = true;
            }
        }
    }
    assert!(dr_model::project_template::validate_project_template_value(&in_book).is_err());
}
