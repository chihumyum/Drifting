use std::collections::BTreeMap;

use dr_doc::DocError;
use dr_doc::project_template::{
    ProjectTemplateDoc, ProjectTemplateInfo, extract_prose_paragraphs, genesis,
    write_prose_paragraphs,
};
use dr_doc::prose::{EmbedKind, ProseDoc};
use dr_doc::v3::{novel_project_template_source, novel_project_template_value};
use dr_model::id::{
    AssetId, BodyDocId, EmbedId, EntryId, EntryTemplateId, ModuleId, ProjectTemplateDocId,
};
use dr_model::kind::{EntityKind, ListKind};
use dr_model::pos::PosKey;
use dr_model::project_template::{
    StoredTemplateOrigin, TemplateBlockAttrs, TemplateEntityLink, TemplateListKind,
    TemplateParagraph, TemplateRun, TemplateTabMount, parse_project_template_json,
    to_canonical_json, validate_project_template_value,
};
use dr_model::prose::{Align, BlockAttrs, Heading, InlineMarks, InlineStyle};
use dr_model::v3::{
    EntityLinkV3, Entry, EntryTemplate, LevelSettingsOverride, ModuleConfig, ModuleKind,
    ModuleSpec, ProjectTemplateOrigin,
};
use dr_model::{DocId, Origin, Timestamp};
use loro::VersionVector;

#[test]
fn builtin_novel_template_passes_unified_validator_and_round_trips() {
    let val = novel_project_template_value();
    validate_project_template_value(&val)
        .expect("novel_project_template_value must pass validator");
    let json1 = to_canonical_json(&val).expect("canonical json");
    let parsed = parse_project_template_json(&json1).expect("parse back");
    assert_eq!(parsed, val);
    let json2 = to_canonical_json(&parsed).expect("canonical json 2");
    assert_eq!(json1, json2);

    let src = novel_project_template_source();
    assert_eq!(src.origin, Some(ProjectTemplateOrigin::Builtin));
    assert_eq!(src.name.as_deref(), Some("写书"));
    assert_eq!(src.id, "builtin:novel");
    // Version 5 uses project-wide relations and project-level guidance.
    assert_eq!(src.version, 5);
}

#[test]
fn project_template_doc_lww_replaces_whole_payload_and_update_touches_only_info() {
    let id = ProjectTemplateDocId::new_v7();
    let g1 = genesis(&id);
    let g2 = genesis(&id);
    assert_eq!(
        g1, g2,
        "project-template genesis must be byte-deterministic"
    );

    let mut peer_a = ProjectTemplateDoc::create(id.clone(), 101).unwrap();
    let mut peer_b = ProjectTemplateDoc::create(id.clone(), 202).unwrap();

    // Peer A saves initial template with 5 entries (`novel_project_template_value()`).
    let mut val_a = novel_project_template_value();
    val_a.name = "版本甲".to_owned();
    val_a.description = "甲的描述".to_owned();
    let info_a = ProjectTemplateInfo {
        name: "版本甲".to_owned(),
        description: "甲的描述".to_owned(),
        origin: StoredTemplateOrigin::Own,
        revision: 1,
        created_at: Some(Timestamp(1_000)),
        updated_at: Some(Timestamp(1_000)),
    };
    let (res, committed_a1) = peer_a.edit(Origin::User, |txn| {
        txn.save(&info_a, &val_a)
            .map_err(|_| DocError::NotInProfile("save failed"))
    });
    res.unwrap();
    assert!(committed_a1.is_some());

    // Sync initial state to Peer B.
    let init_updates = peer_a
        .export_updates_since(&VersionVector::default())
        .unwrap();
    peer_b.import(&init_updates, Origin::Sync).unwrap();
    assert_eq!(peer_b.view().value().unwrap().name, "版本甲");

    // Concurrent re-saves on Peer A and Peer B with disjoint template lists & entry counts:
    // LWW on `payload.value` must pick ONE complete JSON payload, never a half-merged hybrid!
    let vv_before = peer_a.version();

    let mut val_a2 = val_a.clone();
    val_a2.name = "甲重存".to_owned();
    val_a2.entries.truncate(1); // Only e1 (manuscript), adjust book/tabs/homes to stay valid:
    // 「全部」 and the tab on e1 (the manuscript) stay.
    val_a2.project.tabs.retain(|t| match &t.mount {
        TemplateTabMount::Root => true,
        TemplateTabMount::Entry { entry } => entry == "e1",
        _ => false,
    });
    for tpl in &mut val_a2.templates {
        if tpl.settings.home.is_some() {
            tpl.settings.home = Some(Some("e1".to_owned()));
        }
    }
    let info_a2 = ProjectTemplateInfo {
        name: "甲重存".to_owned(),
        description: "只留一个条目".to_owned(),
        origin: StoredTemplateOrigin::Own,
        revision: 2,
        created_at: Some(Timestamp(1_000)),
        updated_at: Some(Timestamp(2_000)),
    };
    peer_a
        .edit(Origin::User, |txn| {
            txn.save(&info_a2, &val_a2)
                .map_err(|_| DocError::NotInProfile("save a2"))
        })
        .0
        .unwrap();

    let mut val_b2 = novel_project_template_value();
    val_b2.name = "乙重存".to_owned();
    let info_b2 = ProjectTemplateInfo {
        name: "乙重存".to_owned(),
        description: "保留完整五目录".to_owned(),
        origin: StoredTemplateOrigin::Own,
        revision: 2,
        created_at: Some(Timestamp(1_000)),
        updated_at: Some(Timestamp(2_500)),
    };
    peer_b
        .edit(Origin::User, |txn| {
            txn.save(&info_b2, &val_b2)
                .map_err(|_| DocError::NotInProfile("save b2"))
        })
        .0
        .unwrap();

    let delta_a = peer_a.export_updates_since(&vv_before).unwrap();
    let delta_b = peer_b.export_updates_since(&vv_before).unwrap();
    peer_a.import(&delta_b, Origin::Sync).unwrap();
    peer_b.import(&delta_a, Origin::Sync).unwrap();

    let merged_a = peer_a.view().value().expect("merged peer A must validate");
    let merged_b = peer_b.view().value().expect("merged peer B must validate");
    assert_eq!(
        merged_a, merged_b,
        "both peers must converge to identical valid value"
    );
    let full_len = val_b2.entries.len();
    assert!(full_len > 1);
    assert!(
        merged_a.entries.len() == 1 || merged_a.entries.len() == full_len,
        "LWW must keep one complete payload (1 or {full_len} entries), got {}",
        merged_a.entries.len()
    );

    // `update_info` renames in `info` without rewriting `payload.value`.
    let raw_before_rename = peer_a.view().raw_payload().unwrap();
    peer_a
        .edit(Origin::User, |txn| {
            txn.update_info(Some("改名后的模板"), Some("新简介"), Timestamp(3_000))
        })
        .0
        .unwrap();
    let raw_after_rename = peer_a.view().raw_payload().unwrap();
    assert_eq!(
        raw_before_rename, raw_after_rename,
        "update_info must not rewrite payload.value"
    );
    let after_val = peer_a.view().value().unwrap();
    assert_eq!(after_val.name, "改名后的模板");
    assert_eq!(after_val.description, "新简介");
}

/// Two devices saving one template at once keep one whole record: the name,
/// description and revision always come with the content they were saved
/// with, whichever device wins, never one device's name over the other's
/// content. Tried over many device-id pairs, since which one wins depends
/// on them.
#[test]
fn concurrent_saves_keep_the_name_with_its_own_content() {
    // One device keeps the description and the other changes it: a field
    // written with the value it already has leaves no change behind, so the
    // two saves write a different number of fields.
    let info = |name: &str, description: &str, revision: i64, at: i64| ProjectTemplateInfo {
        name: name.to_owned(),
        description: description.to_owned(),
        origin: StoredTemplateOrigin::Own,
        revision,
        created_at: Some(Timestamp(1_000)),
        updated_at: Some(Timestamp(at)),
    };
    let full = novel_project_template_value();
    for pair in 0..40u64 {
        let id = ProjectTemplateDocId::new_v7();
        // Which device has the larger id alternates.
        let (low, high) = (1 + pair, 9_000 - pair);
        let (peer_a, peer_b) = if pair % 2 == 0 {
            (low, high)
        } else {
            (high, low)
        };
        let mut a = ProjectTemplateDoc::create(id.clone(), peer_a).unwrap();
        let mut b = ProjectTemplateDoc::create(id.clone(), peer_b).unwrap();
        let mut first = full.clone();
        first.name = "起初".to_owned();
        a.edit(Origin::User, |txn| {
            txn.save(&info("起初", "原来的说明", 1, 1_000), &first)
                .map_err(|_| DocError::NotInProfile("save"))
        })
        .0
        .unwrap();
        b.import(
            &a.export_updates_since(&VersionVector::default()).unwrap(),
            Origin::Sync,
        )
        .unwrap();
        let before = a.version();

        // A keeps only the manuscript; B keeps everything, under other names.
        let mut short = full.clone();
        short.name = "甲".to_owned();
        short.entries.truncate(1);
        short.project.tabs.retain(|t| match &t.mount {
            TemplateTabMount::Root => true,
            TemplateTabMount::Entry { entry } => entry == "e1",
            _ => false,
        });
        for tpl in &mut short.templates {
            if tpl.settings.home.is_some() {
                tpl.settings.home = Some(Some("e1".to_owned()));
            }
        }
        a.edit(Origin::User, |txn| {
            txn.save(&info("甲", "原来的说明", 2, 2_000), &short)
                .map_err(|_| DocError::NotInProfile("save a"))
        })
        .0
        .unwrap();
        let mut long = full.clone();
        long.name = "乙".to_owned();
        b.edit(Origin::User, |txn| {
            txn.save(&info("乙", "乙的说明", 2, 2_500), &long)
                .map_err(|_| DocError::NotInProfile("save b"))
        })
        .0
        .unwrap();
        let from_a = a.export_updates_since(&before).unwrap();
        let from_b = b.export_updates_since(&before).unwrap();
        a.import(&from_b, Origin::Sync).unwrap();
        b.import(&from_a, Origin::Sync).unwrap();

        let (got_a, got_b) = (a.view().value().unwrap(), b.view().value().unwrap());
        assert_eq!(got_a, got_b, "pair {pair}: both devices agree");
        let info_a = a.view().info().unwrap();
        assert_eq!(
            info_a.name, got_a.name,
            "pair {pair}: the list shows the same name"
        );
        match got_a.name.as_str() {
            "甲" => assert_eq!(
                got_a.entries.len(),
                1,
                "pair {pair}: 甲 with its own content"
            ),
            "乙" => assert_eq!(
                got_a.entries.len(),
                full.entries.len(),
                "pair {pair}: 乙 with its own content"
            ),
            other => panic!("pair {pair}: unexpected name {other}"),
        }
        let description = if got_a.name == "甲" {
            "原来的说明"
        } else {
            "乙的说明"
        };
        assert_eq!(
            got_a.description, description,
            "pair {pair}: its own description"
        );
    }
}

#[test]
fn prose_paragraphs_round_trip_blocks_marks_links_tables_and_strip_assets() {
    let tpl_char_id = EntryTemplateId::parse("utpl-char").unwrap();
    let mod_bio_id = ModuleId::parse("mod-bio").unwrap();
    let char_tpl = EntryTemplate {
        id: tpl_char_id.clone(),
        name: "人物".to_owned(),
        mark: None,
        color: None,
        agent: None,
        modules: vec![ModuleSpec {
            id: mod_bio_id.clone(),
            kind: ModuleKind::Prose,
            name: "小传".to_owned(),
            pos: Some(PosKey::first()),
            config: ModuleConfig::default(),
            agent: None,
        }],
        level: false,
        linkable: true,
        settings: LevelSettingsOverride::default(),
        verbs: vec![],
        deleted_at: None,
    };

    let included_entry = EntryId::new_v7();
    let excluded_entry = EntryId::new_v7();
    let asset_id = AssetId::new_v7();

    let live_templates = BTreeMap::from([(tpl_char_id.clone(), char_tpl)]);
    let live_entries = BTreeMap::from([(
        included_entry.clone(),
        Entry {
            id: included_entry.clone(),
            parent: None,
            pos: "a0".to_owned(),
            title: "顾侦探".to_owned(),
            mark: None,
            template: Some(tpl_char_id),
            level: false,
            overrides: None,
            fields: BTreeMap::new(),
            kv: BTreeMap::new(),
            media: BTreeMap::new(),
            arrangements: BTreeMap::new(),
            primary: None,
            created_at: None,
            updated_at: None,
            deleted_at: None,
            name_conflict: None,
        },
    )]);
    let entry_refs = BTreeMap::from([(included_entry.clone(), "e1".to_owned())]);

    // Author a rich prose document containing:
    // 0: H2 heading
    // 1: paragraph with bold+included module link, italic+excluded entry link (degrades to italic text),
    //    and underline+asset link (degrades to underline text)
    // 2: checked task list item
    // 3: asset embed (must be stripped in Phase 1)
    // 4: 2x2 table with bold cell and entity link cell
    let src_doc_id = DocId::Body(BodyDocId::new(included_entry.clone(), mod_bio_id.clone()));
    let mut src_doc = ProseDoc::create(src_doc_id, 1).unwrap();
    src_doc
        .edit(Origin::User, |txn| {
            // Paragraph 0: Heading H2 "线索纪要"
            txn.insert_text(0, "线索纪要")?;
            txn.set_block_attrs(
                0,
                &BlockAttrs {
                    heading: Some(Heading::H2),
                    align: Align::Center,
                    ..BlockAttrs::default()
                },
            )?;
            let mut pos = txn.view().len(); // after "线索纪要\n" (5)

            // Paragraph 1: "顾侦探调查旧宅并查看照片"
            txn.split(pos - 1)?;
            pos = txn.view().len() - 1;
            let text = "顾侦探调查旧宅并查看照片";
            txn.insert_text(pos, text)?;
            // "顾侦探" (0..3): bold + included entry link with prose module
            txn.set_style(pos..pos + 3, &InlineStyle::Bold)?;
            txn.link_entity_v3(
                pos..pos + 3,
                &EntityLinkV3 {
                    target: included_entry.to_string(),
                    kind: EntityKind::Entry,
                    module: Some(mod_bio_id.clone()),
                    block: None,
                    end_block: None,
                },
            )?;
            // "旧宅" (pos+5..pos+7): italic + excluded entry link -> keeps italic, drops link
            txn.set_style(pos + 5..pos + 7, &InlineStyle::Italic)?;
            txn.link_entity_v3(
                pos + 5..pos + 7,
                &EntityLinkV3 {
                    target: excluded_entry.to_string(),
                    kind: EntityKind::Entry,
                    module: None,
                    block: None,
                    end_block: None,
                },
            )?;
            // "照片" (pos+10..pos+12): underline + Asset link -> keeps underline, drops link
            txn.set_style(pos + 10..pos + 12, &InlineStyle::Underline)?;
            txn.link_entity_v3(
                pos + 10..pos + 12,
                &EntityLinkV3 {
                    target: asset_id.to_string(),
                    kind: EntityKind::Asset,
                    module: None,
                    block: None,
                    end_block: None,
                },
            )?;

            // Paragraph 2: checked task item
            let end1 = txn.view().len() - 1;
            txn.split(end1)?;
            let p2 = txn.view().len() - 1;
            txn.insert_text(p2, "核对不在场证明")?;
            txn.set_block_attrs(
                p2,
                &BlockAttrs {
                    list: Some(ListKind::Task),
                    list_level: 1,
                    checked: true,
                    ..BlockAttrs::default()
                },
            )?;

            // Paragraph 3: Asset embed (should be omitted on extraction)
            let end2 = txn.view().len() - 1;
            txn.split(end2)?;
            let p3 = txn.view().len() - 1;
            let asset_embed = EmbedId::new_v7();
            txn.insert_embed(p3, &asset_embed, &EmbedKind::Asset(asset_id.clone()))?;

            // Paragraph 4: Table embed 2x2
            let p4 = txn.view().len() - 1;
            let table_embed = EmbedId::new_v7();
            {
                let tw = txn.insert_embed(p4, &table_embed, &EmbedKind::Table)?;
                let c1 = PosKey::first();
                let c2 = c1.after();
                tw.add_col("c1", &c1)?;
                tw.add_col("c2", &c2)?;
                let r1 = PosKey::first();
                let r2 = r1.after();
                tw.add_row("r1", &r1)?;
                tw.add_row("r2", &r2)?;
            }
            txn.set_table_cell_runs_v3(
                &table_embed,
                "r1",
                "c1",
                &[dr_doc::prose::Run {
                    text: "人物".to_owned(),
                    marks: InlineMarks {
                        bold: true,
                        ..InlineMarks::default()
                    },
                }],
                &[],
            )?;
            txn.set_table_cell_runs_v3(
                &table_embed,
                "r2",
                "c1",
                &[dr_doc::prose::Run {
                    text: "顾侦探".to_owned(),
                    marks: InlineMarks::default(),
                }],
                &[(
                    0..3,
                    EntityLinkV3 {
                        target: included_entry.to_string(),
                        kind: EntityKind::Entry,
                        module: Some(mod_bio_id.clone()),
                        block: None,
                        end_block: None,
                    },
                )],
            )?;
            Ok(())
        })
        .0
        .unwrap();

    let extracted =
        extract_prose_paragraphs(&src_doc.view(), &entry_refs, &live_templates, &live_entries)
            .expect("extract prose");

    // Asset embed paragraph was omitted (and trailing empty paragraph after embed if any):
    // Verify H2, body paragraph, task paragraph, and table paragraph!
    assert!(
        extracted.iter().any(|p| p.attrs
            == TemplateBlockAttrs {
                heading: Some(2),
                align: Align::Center,
                ..TemplateBlockAttrs::default()
            }
            && p.runs == vec![TemplateRun::plain("线索纪要")]),
        "missing H2 paragraph: {extracted:#?}"
    );

    let link_para = extracted
        .iter()
        .find(|p| p.runs.iter().any(|r| r.text.contains("顾侦探")))
        .expect("link paragraph");
    assert_eq!(
        link_para.runs,
        vec![
            TemplateRun {
                text: "顾侦探".to_owned(),
                bold: true,
                entities: vec![TemplateEntityLink {
                    entry: "e1".to_owned(),
                    module: Some("mod-bio".to_owned()),
                }],
                ..TemplateRun::default()
            },
            TemplateRun::plain("调查"),
            TemplateRun {
                text: "旧宅".to_owned(),
                italic: true,
                entities: vec![], // degraded!
                ..TemplateRun::default()
            },
            TemplateRun::plain("并查看"),
            TemplateRun {
                text: "照片".to_owned(),
                underline: true,
                entities: vec![], // asset link degraded!
                ..TemplateRun::default()
            },
        ]
    );

    assert!(
        extracted.iter().any(|p| p.attrs
            == TemplateBlockAttrs {
                list: Some(TemplateListKind::Task),
                list_level: 1,
                checked: true,
                ..TemplateBlockAttrs::default()
            }),
        "missing task list paragraph"
    );
    assert!(
        extracted.iter().any(|p| p.table.is_some()),
        "missing table paragraph"
    );

    // Write into a brand-new prose doc with a fresh EntryId and re-extract -> identical!
    let new_entry = EntryId::new_v7();
    let dst_doc_id = DocId::Body(BodyDocId::new(new_entry.clone(), mod_bio_id.clone()));
    let mut dst_doc = ProseDoc::create(dst_doc_id, 2).unwrap();
    let entry_map = BTreeMap::from([("e1".to_owned(), new_entry.clone())]);
    dst_doc
        .edit(Origin::User, |txn| {
            write_prose_paragraphs(txn, &extracted, &entry_map)
        })
        .0
        .unwrap();

    let mut dst_live_entries = BTreeMap::new();
    let mut cloned_entry = live_entries[&included_entry].clone();
    cloned_entry.id = new_entry.clone();
    dst_live_entries.insert(new_entry.clone(), cloned_entry);
    let dst_refs = BTreeMap::from([(new_entry, "e1".to_owned())]);

    let re_extracted = extract_prose_paragraphs(
        &dst_doc.view(),
        &dst_refs,
        &live_templates,
        &dst_live_entries,
    )
    .expect("re-extract");

    // Trim trailing empty plain paragraph if `insert_embed` left the genesis trailing newline.
    let trim_trailing_empty = |mut v: Vec<TemplateParagraph>| {
        while v
            .last()
            .is_some_and(|p| p.attrs.is_plain() && p.runs.is_empty() && p.table.is_none())
        {
            v.pop();
        }
        v
    };
    assert_eq!(
        trim_trailing_empty(re_extracted),
        trim_trailing_empty(extracted)
    );
}
