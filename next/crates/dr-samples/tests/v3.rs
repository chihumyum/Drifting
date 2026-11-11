//! The v3 sample recipes reuse the original public-domain corpus verbatim.
//! Policy here is test-only and does not settle m10's author decisions.

mod common;
use common::test_choices;
use dr_doc::v3::novel::*;
use dr_model::id::*;
use dr_samples::v3::*;

fn tid(id: &str) -> EntryTemplateId {
    EntryTemplateId::parse(id).unwrap()
}

#[test]
fn both_sample_recipes_keep_their_text_marks_structure_and_exact_anchors() {
    for source in [
        dr_samples::a_q().unwrap(),
        dr_samples::pride_and_prejudice().unwrap(),
    ] {
        let choices = test_choices(&source);
        let before = (source.book.version(), source.book.frontiers());
        let sample = convert(&source, &choices).unwrap();
        validate(&sample.book.view()).unwrap();
        assert_eq!(sample.book_id(), source.book_id());
        assert_eq!(sample.groups(), source.groups());
        assert_eq!(sample.counters(), source.counters());
        assert_eq!(
            sample.book.view().meta().name,
            source.book.view().meta().name
        );
        assert_eq!(source.prose.len(), sample.prose.len());
        for (old, new) in source.prose.iter().zip(&sample.prose) {
            assert_eq!(new.doc_id(), &prose_id(source.book_id(), old.doc_id()));
            assert_eq!(
                new.view().plain_text(),
                old.view().plain_text(),
                "{}",
                old.doc_id()
            );
            let old_paragraphs: Vec<_> = old.view().paragraphs().collect();
            let new_paragraphs: Vec<_> = new.view().paragraphs().collect();
            assert_eq!(old_paragraphs.len(), new_paragraphs.len());
            for (old, new) in old_paragraphs.iter().zip(&new_paragraphs) {
                assert_eq!(old.attrs, new.attrs);
                assert_eq!(old.stored_id, new.stored_id);
                let mut runs = old.runs.clone();
                for run in &mut runs {
                    for link in &mut run.marks.entities {
                        link.kind = map_kind(&link.kind);
                    }
                }
                assert_eq!(runs, new.runs);
            }
        }
        let view = sample.book.view();
        let entries = view.entries_map();
        let templates = view.templates_map();
        assert_eq!(
            entries.values().filter(|e| e.is_leaf(&templates)).count(),
            source.book.view().nodes().len() + source.book.view().elements().len()
        );
        for node in source.book.view().nodes() {
            let id = EntryId::parse(node.id.as_str()).unwrap();
            let entry = &entries[&id];
            assert_eq!(
                entry.primary,
                node.primary_storyline
                    .as_ref()
                    .map(|s| EntryId::parse(s.as_str()).unwrap())
            );
            for storyline in &node.storylines {
                assert!(
                    view.memberships_raw()
                        .iter()
                        .any(|m| m.member == id && m.host.as_str() == storyline.as_str())
                );
            }
        }
        for old in source.book.view().comments() {
            let new = view
                .comments()
                .into_iter()
                .find(|c| c.id == old.id)
                .unwrap();
            assert_eq!(new.body, old.body);
            assert_eq!(new.quote, old.quote);
            assert_eq!(new.snapshots, old.snapshots);
            if let (Some(target), Some(old_anchor), Some(new_anchor)) =
                (&old.target, &old.anchor, &new.anchor)
            {
                let index = source
                    .prose
                    .iter()
                    .position(|p| p.doc_id().entity_id() == target.id)
                    .unwrap();
                let a = source.prose[index]
                    .view()
                    .resolve(&dr_doc::Anchor::decode(old_anchor).unwrap())
                    .unwrap();
                let b = sample.prose[index]
                    .view()
                    .resolve(&dr_doc::Anchor::decode(new_anchor).unwrap())
                    .unwrap();
                assert_eq!(a.range, b.range);
            }
        }
        assert_eq!(
            (source.book.version(), source.book.frontiers()),
            before,
            "conversion never edits the v2 sample"
        );
        let all = dr_doc::loro_types::VersionVector::default();
        let repeat = convert(&source, &choices).unwrap();
        validate(&repeat.book.view()).unwrap();
        for template in [TPL_MANUSCRIPT, TPL_IDEAS, TPL_ELEMENTS, TPL_STORYLINES] {
            let a = view.root_entry_by_template(&tid(template)).unwrap();
            let b = repeat
                .book
                .view()
                .root_entry_by_template(&tid(template))
                .unwrap();
            assert_ne!(a.id, b.id, "new conversions generate fresh roots");
            assert_eq!(a.title, b.title);
        }
        for (a, b) in repeat.prose.iter().zip(&sample.prose) {
            assert!(
                a.export_updates_since(&all).unwrap() == b.export_updates_since(&all).unwrap(),
                "same v3 prose updates"
            );
        }
    }
}

#[test]
fn v3_sample_documents_store_body_first_and_reopen_as_v3() {
    let source = dr_samples::a_q().unwrap();
    let sample = convert(&source, &test_choices(&source)).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let lib = dr_store::Library::open(
        temp.path(),
        dr_store::LibraryOptions::new("k3-v3-sample-test"),
    )
    .unwrap();
    assert_eq!(write_book(&lib, &sample).unwrap(), sample.prose.len() + 1);
    let id = sample.book.doc_id().to_string();
    let copy = lib.load_copy(&id).unwrap();
    let bytes = copy.export(loro::ExportMode::Snapshot).unwrap();
    let loaded = dr_doc::v3::BookDocV3::load(
        sample.book_id().clone(),
        dr_doc::peer::random_device_peer(),
        &[bytes],
    )
    .unwrap();
    validate(&loaded.view()).unwrap();
    assert!(
        write_book(&lib, &sample).is_err(),
        "an existing sample is not overwritten"
    );
    lib.close().unwrap();
}

#[test]
fn two_samples_in_one_library_survive_permanent_deletion_of_either_book() {
    use dr_doc::peer::random_device_peer;
    use dr_doc::prose::ProseDoc;
    use dr_model::{DocId, Origin};
    use std::collections::{BTreeMap, BTreeSet};

    let mut samples: Vec<_> = [
        dr_samples::a_q().unwrap(),
        dr_samples::pride_and_prejudice().unwrap(),
    ]
    .iter()
    .map(|source| convert(source, &test_choices(source)).unwrap())
    .collect();
    for sample in &mut samples {
        let view = sample.book.view();
        let root = view
            .root_entry_by_template(&tid(TPL_MANUSCRIPT))
            .unwrap()
            .id;
        let module = ModuleId::parse(MOD_PROSE).unwrap();
        // Exercise both previously colliding document forms with actual
        // stored bytes. Reuse this sample's licensed prose, no new corpus.
        for id in [
            body_id(root.as_str(), MOD_ABOUT),
            DocId::Template(TemplateId::for_entry_module(
                sample.book_id(),
                &tid(TPL_CHAPTER),
                &module,
            )),
        ] {
            assert!(view.owns_prose(&id));
            let mut prose = ProseDoc::create(id, random_device_peer()).unwrap();
            let (r, _) = prose.edit(Origin::User, |t| t.insert_copy(0, &sample.prose[0].view()));
            r.unwrap();
            sample.prose.push(prose);
        }
    }
    let entries = |sample: &SampleBookV3| -> BTreeSet<_> {
        sample
            .book
            .view()
            .entries_raw()
            .into_iter()
            .map(|e| e.id)
            .collect()
    };
    assert!(entries(&samples[0]).is_disjoint(&entries(&samples[1])));
    for deleted in 0..2 {
        let survivor = &samples[1 - deleted];
        let temp = tempfile::tempdir().unwrap();
        let lib = dr_store::Library::open(
            temp.path(),
            dr_store::LibraryOptions::new("k3-v3-two-samples"),
        )
        .unwrap();
        for sample in &samples {
            write_book(&lib, sample).unwrap();
        }
        let documents = |book: &BookId| -> BTreeSet<String> {
            lib.docs(Some(book.as_str()), None)
                .unwrap()
                .into_iter()
                .map(|d| d.doc_id)
                .collect()
        };
        let removed = documents(samples[deleted].book_id());
        let kept = documents(survivor.book_id());
        assert_eq!(removed.len(), samples[deleted].prose.len() + 1);
        assert_eq!(kept.len(), survivor.prose.len() + 1);
        assert!(removed.is_disjoint(&kept));
        let before: BTreeMap<_, _> = kept
            .iter()
            .map(|id| {
                let copy = lib.load_copy(id).unwrap();
                (
                    id.clone(),
                    (
                        copy.oplog_vv(),
                        copy.export(loro::ExportMode::all_updates()).unwrap(),
                    ),
                )
            })
            .collect();
        let mut removed: Vec<_> = removed.into_iter().collect();
        removed.sort_by_key(|id| id.starts_with("book:"));
        for id in &removed {
            lib.purge_doc(id).unwrap();
            assert!(lib.doc_info(id).unwrap().is_none());
        }
        assert!(
            lib.book_purged(samples[deleted].book_id().as_str())
                .unwrap()
        );
        assert_eq!(documents(survivor.book_id()), kept);
        for (id, want) in before {
            let copy = lib.load_copy(&id).unwrap();
            assert_eq!(copy.oplog_vv(), want.0, "unchanged version: {id}");
            assert_eq!(
                copy.export(loro::ExportMode::all_updates()).unwrap(),
                want.1,
                "unchanged content: {id}"
            );
        }
        let bytes = lib
            .load_copy(&survivor.book.doc_id().to_string())
            .unwrap()
            .export(loro::ExportMode::Snapshot)
            .unwrap();
        let loaded =
            dr_doc::v3::BookDocV3::load(survivor.book_id().clone(), random_device_peer(), &[bytes])
                .unwrap();
        validate(&loaded.view()).unwrap();
        assert_eq!(
            loaded.view().entries_raw(),
            survivor.book.view().entries_raw()
        );
        for expected in &survivor.prose {
            let bytes = lib
                .load_copy(&expected.doc_id().to_string())
                .unwrap()
                .export(loro::ExportMode::Snapshot)
                .unwrap();
            let prose =
                ProseDoc::load(expected.doc_id().clone(), random_device_peer(), &[bytes]).unwrap();
            assert_eq!(prose.view().plain_text(), expected.view().plain_text());
        }
        lib.close().unwrap();
    }
}

#[test]
fn sample_conversion_preserves_material_links_block_links_table_cell_links_and_field_defaults() {
    use dr_doc::prose::EmbedKind;
    use dr_model::Origin;
    use dr_model::kind::EntityKind;
    use dr_model::pos::PosKey;
    use dr_model::prose::{EntityLink, InlineStyle};
    use dr_model::v3::{EntityLinkV3, FieldValue};

    let mut source = dr_samples::a_q().unwrap();
    let cat_id = source.book.view().categories()[0].id.clone();
    let elem_id = source.book.view().elements()[0].id.clone();
    let mat_id = MaterialId::parse("sample-mat-note").unwrap();
    source
        .book
        .edit(Origin::Import, |t| {
            let p_mat = dr_model::pos::PosKey::parse("a0").unwrap();
            let m = t.material(&mat_id)?;
            m.title("考据札记")?
                .kind(&dr_model::kind::MaterialKind::Text)?
                .pos(&p_mat)?
                .description("合成测试素材")?;
            let f = dr_model::pos::PosKey::first().after();
            let kv_id = KvEntryId::parse("tpl-default-field").unwrap();
            let c = t.category(&cat_id)?;
            c.put_template_field(&dr_model::import_v1::KvEntry {
                id: kv_id,
                key: "默认籍贯".into(),
                value: "未庄".into(),
                pos: Some(f),
            })?;
            Ok(())
        })
        .0
        .unwrap();

    let block_id = BlockId::parse("target-block-1").unwrap();
    let elem_prose_idx = source
        .prose
        .iter()
        .position(|p| p.doc_id().entity_id() == elem_id.as_str())
        .unwrap();
    source.prose[elem_prose_idx]
        .edit(Origin::Import, |t| t.set_block_id(0, Some(&block_id)))
        .0
        .unwrap();

    let chapter_prose_idx = source
        .prose
        .iter()
        .position(|p| matches!(p.doc_id(), DocId::Node(_)))
        .unwrap();
    let tbl_id = EmbedId::parse("sample-tbl-1").unwrap();
    source.prose[chapter_prose_idx]
        .edit(Origin::Import, |t| {
            t.split(0)?;
            t.insert_text(0, "参见札记与阿Q小传")?;
            t.link_entity(
                2..4,
                &EntityLink {
                    target: mat_id.to_string(),
                    kind: EntityKind::Element,
                    block: None,
                    end_block: None,
                },
            )?;
            // Overwrite raw kind to material to mirror legacy material entityLink mark
            let key = format!("entity:{mat_id}");
            t.link_entity_v3(
                2..4,
                &EntityLinkV3 {
                    target: mat_id.to_string(),
                    kind: EntityKind::Material,
                    module: None,
                    block: None,
                    end_block: None,
                },
            )?;
            let _ = key;
            t.link_entity(
                5..9,
                &EntityLink {
                    target: elem_id.to_string(),
                    kind: EntityKind::Element,
                    block: Some(block_id.clone()),
                    end_block: None,
                },
            )?;
            let p0 = PosKey::parse("a0").unwrap();
            let w = t.insert_embed(10, &tbl_id, &EmbedKind::Table)?;
            w.add_row("r0", &p0)?;
            w.add_col("c0", &p0)?;
            let cell = w.cell("r0", "c0")?;
            cell.update("阿Q考", Default::default()).unwrap();
            cell.mark(0..2, "bold", true).unwrap();
            cell.mark(
                0..2,
                &format!("entity:{elem_id}"),
                loro::LoroValue::Map(
                    vec![
                        ("kind".into(), "element".into()),
                        ("block".into(), block_id.as_str().into()),
                    ]
                    .into(),
                ),
            )
            .unwrap();
            t.set_style(0..2, &InlineStyle::Bold)
        })
        .0
        .unwrap();

    let choices = test_choices(&source);
    let before = (source.book.version(), source.book.frontiers());
    let converted = convert(&source, &choices).unwrap();
    assert_eq!((source.book.version(), source.book.frontiers()), before);
    validate(&converted.book.view()).unwrap();

    let tpl = converted
        .book
        .view()
        .template(&category_template(cat_id.as_str()))
        .unwrap();
    let def = tpl
        .modules
        .iter()
        .flat_map(|m| &m.config.defs)
        .find(|d| d.id == "tpl-default-field")
        .unwrap();
    assert_eq!(def.default_value, Some(FieldValue::Text("未庄".into())));

    let new_chapter = &converted.prose[chapter_prose_idx];
    let body_links = new_chapter.view().entity_links_v3();
    assert!(body_links.iter().any(|(r, l)| {
        *r == (2..4)
            && l.target == mat_id.as_str()
            && l.kind == EntityKind::Material
            && l.module.is_none()
    }));
    assert!(body_links.iter().any(|(r, l)| {
        *r == (5..9)
            && l.target == elem_id.as_str()
            && l.kind == EntityKind::Entry
            && l.module == Some(ModuleId::parse(MOD_PROSE).unwrap())
            && l.block == Some(block_id.clone())
    }));

    let (_, copied_tbl) = new_chapter.view().embed_refs()[0].clone();
    let cell_runs = new_chapter
        .view()
        .table_cell(&copied_tbl, "r0", "c0")
        .unwrap();
    assert!(cell_runs[0].marks.bold);
    assert_eq!(
        new_chapter
            .view()
            .table_cell_entity_links_v3(&copied_tbl, "r0", "c0"),
        Some(vec![(
            0..2,
            EntityLinkV3 {
                target: elem_id.to_string(),
                kind: EntityKind::Entry,
                module: Some(ModuleId::parse(MOD_PROSE).unwrap()),
                block: Some(block_id),
                end_block: None,
            }
        )])
    );
}
