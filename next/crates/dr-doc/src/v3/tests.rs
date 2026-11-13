//! Tests for the universal kernel v3 book document (`dr-doc::v3`).

use std::collections::BTreeSet;

use dr_model::id::*;
use dr_model::kind::EntityKind;
use dr_model::pos::PosKey;
use dr_model::shared::{EntityRef, KvEntry};
use dr_model::v3::*;
use dr_model::{DocId, Origin, Timestamp};

use super::novel::*;
use super::*;
use crate::prose::ProseDoc;

fn bid() -> BookId {
    BookId::parse("b-v3").unwrap()
}

fn eid(s: &str) -> EntryId {
    EntryId::parse(s).unwrap()
}

fn tid(s: &str) -> EntryTemplateId {
    EntryTemplateId::parse(s).unwrap()
}

fn mid(s: &str) -> ModuleId {
    ModuleId::parse(s).unwrap()
}

#[test]
fn book_genesis_sets_version_4_and_locked_generic_relation_type() {
    let doc = BookDocV3::create(bid(), 1).unwrap();
    let v = doc.view();
    assert_eq!(v.meta().schema_version, 4);
    assert_eq!(v.book_id(), &bid());
    let rts = v.relation_types();
    assert_eq!(rts.len(), 1);
    assert!(rts[0].locked);
    assert_eq!(
        rts[0].source_kinds,
        vec![EntityKind::Comment, EntityKind::Material]
    );
    assert_eq!(
        rts[0].target_kinds,
        vec![EntityKind::Entry, EntityKind::Patch]
    );
}

#[test]
fn novel_project_template_populates_stable_templates_roots_and_categories() {
    let mut doc = BookDocV3::create(bid(), 1).unwrap();
    let (res, committed) = doc.edit(Origin::User, apply_novel_project_template);
    let roots = res.unwrap();
    assert!(committed.is_some());

    let v = doc.view();
    assert_eq!(
        v.meta().project_template,
        Some(ProjectTemplateRef {
            id: NOVEL_PROJECT_TEMPLATE_ID.into(),
            version: NOVEL_PROJECT_TEMPLATE_VERSION,
        })
    );
    let tpls = v.templates_map();
    for id in [
        TPL_MANUSCRIPT,
        TPL_IDEAS,
        TPL_IDEA_GROUP,
        TPL_ELEMENTS,
        TPL_CATEGORY,
        TPL_GROUP,
        TPL_STORYLINES,
        TPL_STORYLINE,
        TPL_CHAPTER,
        TPL_IDEA,
        TPL_CHARACTER,
        TPL_LOCATION,
        TPL_ITEM,
        TPL_ORGANIZATION,
        TPL_ELEMENT,
    ] {
        assert!(
            tpls.contains_key(&tid(id)),
            "missing built-in template {id}"
        );
    }
    // One kind of template: the switch's default, `linkable`, `lane` in the
    // settings, and a 「说明」 that is not part of the book on every
    // organizing template (the 幕 template included).
    assert!(tpls[&tid(TPL_MANUSCRIPT)].level);
    assert_eq!(tpls[&tid(TPL_STORYLINE)].settings.lane, Some(true));
    assert_eq!(tpls[&tid(TPL_ACT_TRACK)].settings.lane, Some(true));
    assert!(!tpls[&tid(TPL_CHAPTER)].level);
    for t in tpls.values() {
        let description = t.module(&mid(MOD_DESCRIPTION));
        assert_eq!(t.level, description.is_some(), "{}", t.id);
        assert_eq!(t.linkable, !t.level, "{}", t.id);
        assert!(description.is_none_or(|d| !d.config.in_book), "{}", t.id);
    }
    assert_eq!(
        tpls[&tid(TPL_CHAPTER)]
            .book_prose_modules()
            .map(|m| m.id.as_str())
            .collect::<Vec<_>>(),
        [MOD_PROSE]
    );

    // Root entries in manuscript order: 书稿, 构想, 要素, 故事线 (all fresh UUIDv7).
    for id in [
        &roots.manuscript,
        &roots.ideas,
        &roots.elements,
        &roots.storylines,
        &roots.cat_character,
        &roots.cat_location,
        &roots.cat_item,
        &roots.cat_organization,
    ] {
        assert!(is_uuid_v7(id.as_str()), "expected uuidv7 root id, got {id}");
    }
    assert!(is_uuid_v7(roots.narrative_view.as_str()));
    assert_eq!(find_novel_roots(&v), Some(roots.clone()));
    assert_eq!(
        v.root_entry_by_template(&tid(TPL_MANUSCRIPT)).map(|e| e.id),
        Some(roots.manuscript.clone())
    );
    let top: Vec<EntryId> = v.children_of(None).into_iter().map(|e| e.id).collect();
    assert_eq!(
        top,
        vec![
            roots.manuscript.clone(),
            roots.ideas.clone(),
            roots.elements.clone(),
            roots.storylines.clone(),
        ]
    );
    assert_eq!(
        v.manuscript_levels(),
        BTreeSet::from([roots.manuscript.clone()])
    );

    // Categories under 要素 inherit auto_link = true and override default_template.
    let char_settings = v.level_settings(Some(&roots.cat_character));
    assert!(char_settings.auto_link);
    assert!(char_settings.accept);
    assert_eq!(char_settings.default_template, Some(tid(TPL_CHARACTER)));

    // Default narrative timeline view exists.
    let views = v.timeline_views();
    assert_eq!(views.len(), 1);
    assert_eq!(views[0].id, roots.narrative_view);
    assert_eq!(views[0].name, "叙事时间线");
}

#[test]
fn entries_tree_fields_kv_and_read_tolerances_round_trip() {
    let mut doc = BookDocV3::create(bid(), 1).unwrap();
    let (roots, _) = doc.edit(Origin::User, apply_novel_project_template);
    let roots = roots.unwrap();

    // Create a sub-group under 人物, two characters inside it, and two chapters under 书稿.
    let (r, _) = doc.edit(Origin::User, |t| {
        t.entries().create(
            &eid("grp-protagonists"),
            Some(&roots.cat_character),
            "主角们",
            Some(&tid(TPL_GROUP)),
            true,
        )?;
        let c1 = t.entries().create(
            &eid("char-1"),
            Some(&eid("grp-protagonists")),
            "林凯",
            Some(&tid(TPL_CHARACTER)),
            false,
        )?;
        c1.created_at(Some(Timestamp(100)))?
            .set_field(
                &mid(MOD_FIELDS),
                "aliases",
                Some(&FieldValue::List(vec!["阿凯".to_string()])),
            )?
            .set_field(
                &mid(MOD_FIELDS),
                "summary",
                Some(&FieldValue::Text("守塔人".into())),
            )?
            .put_kv(
                &mid(MOD_KV),
                &KvEntry {
                    id: KvEntryId::parse("kv-1").unwrap(),
                    key: "年龄".into(),
                    value: "27".into(),
                    pos: Some(PosKey::first()),
                },
            )?
            .relation_pin(Some((12.5, -4.0)))?;

        // Colliding auto-link leaf created later.
        let c2 = t.entries().create(
            &eid("char-2"),
            Some(&eid("grp-protagonists")),
            "阿凯",
            Some(&tid(TPL_CHARACTER)),
            false,
        )?;
        c2.created_at(Some(Timestamp(200)))?;

        // Two chapters under 书稿.
        t.entries().create(
            &eid("ch-1"),
            Some(&roots.manuscript),
            "第一章",
            Some(&tid(TPL_CHAPTER)),
            false,
        )?;
        t.entries().create(
            &eid("ch-2"),
            Some(&roots.manuscript),
            "第二章",
            Some(&tid(TPL_CHAPTER)),
            false,
        )?;
        t.entries().move_before(&eid("ch-2"), &eid("ch-1"))?;
        Ok(())
    });
    r.unwrap();

    let v = doc.view();
    // Group under 人物 inherits auto_link = true and default_template = tpl-character.
    let grp_settings = v.level_settings(Some(&eid("grp-protagonists")));
    assert!(grp_settings.auto_link);
    assert_eq!(grp_settings.default_template, Some(tid(TPL_CHARACTER)));

    // Auto-link conflict detected between char-1 ("阿凯" alias) and char-2 ("阿凯" title).
    assert_eq!(
        v.autolink_name_conflicts(),
        vec![(eid("char-2"), eid("char-1"))]
    );

    // Chapters under 书稿 reflect move_before order, numbered in the
    // manuscript sequence; 书稿 itself has no book prose.
    let structure = v.structure_snapshot();
    let numbered: Vec<(EntryId, Option<u32>)> = structure
        .manuscript()
        .into_iter()
        .flat_map(|p| p.entries)
        .map(|e| (e.entry.id.clone(), e.ordinal))
        .collect();
    assert_eq!(
        numbered,
        vec![
            (roots.manuscript.clone(), None),
            (eid("ch-2"), Some(1)),
            (eid("ch-1"), Some(2))
        ]
    );

    // Field values, kv rows and layout round-trip.
    let char1 = v.entry(&eid("char-1")).unwrap();
    assert_eq!(
        char1.fields[&mid(MOD_FIELDS)]["summary"],
        FieldValue::Text("守塔人".into())
    );
    assert_eq!(char1.kv[&mid(MOD_KV)][0].key, "年龄");
    assert_eq!(char1.layout.relation_graph, Some((12.5, -4.0)));
}

#[test]
fn timeline_view_requires_lane_membership_and_prose_ownership_works() {
    let mut doc = BookDocV3::create(bid(), 1).unwrap();
    let (roots, _) = doc.edit(Origin::User, apply_novel_project_template);
    let roots = roots.unwrap();

    let (r, _) = doc.edit(Origin::User, |t| {
        t.entries().create(
            &eid("sl-main"),
            Some(&roots.storylines),
            "主线",
            Some(&tid(TPL_STORYLINE)),
            true,
        )?;
        t.entries().create(
            &eid("ch-1"),
            Some(&roots.manuscript),
            "第一章",
            Some(&tid(TPL_CHAPTER)),
            false,
        )?;
        t.entries().create(
            &eid("ch-2"),
            Some(&roots.manuscript),
            "第二章",
            Some(&tid(TPL_CHAPTER)),
            false,
        )?;
        // Add sl-main to narrative view and place both ch-1 and ch-2,
        // but only give ch-1 membership in sl-main.
        t.put_membership(
            &eid("sl-main"),
            &eid("ch-1"),
            Some(&PosKey::first()),
            Some(Timestamp(10)),
        )?;
        let tv = t.timeline_view(&roots.narrative_view)?;
        tv.put_lane(&eid("sl-main"), Some(&PosKey::first()))?
            .put_placement(&eid("ch-1"), 100.0, Some(20.0))?
            .put_placement(&eid("ch-2"), 200.0, None)?
            .put_pin(&TimelinePin {
                id: TimePinId::parse("pin-1").unwrap(),
                at: 100.0,
                label: "开幕".into(),
                color: None,
                entry: Some(eid("ch-1")),
            })?;
        Ok(())
    });
    r.unwrap();

    let v = doc.view();
    let tv = v.timeline_view(&roots.narrative_view).unwrap();
    assert_eq!(tv.lanes.len(), 1);
    // ch-2 has no membership in sl-main, so V3-TIMELINE-PLACEMENT-IN-LANE hides its placement!
    assert_eq!(tv.placements.len(), 1);
    assert_eq!(tv.placements[0].entry, eid("ch-1"));
    assert_eq!(tv.pins.len(), 1);

    // Prose ownership: body:<entry>/<module>, template:<book>/<tpl>/<mod>.
    let ch_body = DocId::parse("body:ch-1/mod-prose").unwrap();
    let sl_about = DocId::parse("body:sl-main/mod-description").unwrap();
    let orphan_body = DocId::parse("body:missing/mod-prose").unwrap();
    let tpl_doc = DocId::parse("template:b-v3/tpl-chapter/mod-prose").unwrap();
    let other_book_tpl = DocId::parse("template:other-book/tpl-chapter/mod-prose").unwrap();
    assert!(v.owns_prose(&ch_body));
    assert!(v.owns_prose(&sl_about));
    assert!(!v.owns_prose(&orphan_body));
    assert!(v.owns_prose(&tpl_doc));
    assert!(!v.owns_prose(&other_book_tpl));

    // ProseDoc can open both body: and v3 template: document IDs.
    let mut p = ProseDoc::create(ch_body.clone(), 2).unwrap();
    let (pr, _) = p.edit(Origin::User, |pt| pt.insert_paragraphs(0, "正文第一段"));
    pr.unwrap();
    assert_eq!(p.view().plain_text(), "正文第一段\n");
}

#[test]
fn entry_snapshot_and_restore_round_trip() {
    let mut doc = BookDocV3::create(bid(), 1).unwrap();
    let (roots, _) = doc.edit(Origin::User, apply_novel_project_template);
    let roots = roots.unwrap();

    let (r, _) = doc.edit(Origin::User, |t| {
        let w = t.entries().create(
            &eid("ch-1"),
            Some(&roots.manuscript),
            "初稿标题",
            Some(&tid(TPL_CHAPTER)),
            false,
        )?;
        w.set_field(
            &mid(MOD_FIELDS),
            "summary",
            Some(&FieldValue::Text("初稿梗概".into())),
        )?;
        Ok(())
    });
    r.unwrap();

    let at_v1 = doc.frontiers();
    let snap_bytes = doc.export_snapshot().unwrap();

    // Mutate title and summary.
    let (r, _) = doc.edit(Origin::User, |t| {
        let w = t.entries().entry(&eid("ch-1"))?;
        w.title("改后标题")?.set_field(
            &mid(MOD_FIELDS),
            "summary",
            Some(&FieldValue::Text("改后梗概".into())),
        )?;
        Ok(())
    });
    r.unwrap();
    assert_eq!(doc.view().entry(&eid("ch-1")).unwrap().title, "改后标题");

    // Load historical reader at `at_v1` and restore entry ch-1.
    let reader_at = BookReaderV3::load_at(bid(), &[snap_bytes], &at_v1).unwrap();
    let entry_snap = reader_at.view().entry_snapshot(&eid("ch-1")).unwrap();
    let (r, _) = doc.edit(Origin::User, |t| t.restore_entry(&eid("ch-1"), &entry_snap));
    r.unwrap();

    let restored = doc.view().entry(&eid("ch-1")).unwrap();
    assert_eq!(restored.title, "初稿标题");
    assert_eq!(
        restored.fields[&mid(MOD_FIELDS)]["summary"],
        FieldValue::Text("初稿梗概".into())
    );
}

#[test]
fn novel_roots_are_found_by_template_after_renaming() {
    let mut doc = BookDocV3::create(bid(), 1).unwrap();
    let (roots, _) = doc.edit(Origin::User, apply_novel_project_template);
    let roots = roots.unwrap();
    doc.edit(Origin::User, |t| {
        t.entries()
            .entry(&roots.manuscript)?
            .title("Renamed manuscript")?;
        t.entries()
            .entry(&roots.cat_character)?
            .title("Renamed people")?;
        Ok(())
    })
    .0
    .unwrap();
    assert_eq!(find_novel_roots(&doc.view()), Some(roots));
}

#[test]
fn structure_snapshot_is_explicit_and_fresh_after_pending_writes_import_and_checkout() {
    let mut doc = BookDocV3::create(bid(), 41).unwrap();
    let roots = doc
        .edit(Origin::User, apply_novel_project_template)
        .0
        .unwrap();
    doc.edit(Origin::User, |t| {
        let view = t.view();
        let before = view.structure_snapshot();
        t.entries().create(
            &eid("new"),
            Some(&roots.manuscript),
            "Before",
            Some(&tid(TPL_CHAPTER)),
            false,
        )?;
        let pending = view.doc.get_pending_txn_len();
        assert!(pending > 0);
        let after = view.structure_snapshot();
        assert_eq!(
            view.doc.get_pending_txn_len(),
            pending,
            "reading cannot commit pending writes"
        );
        assert!(before.entry(&eid("new")).is_none());
        assert_eq!(after.entry(&eid("new")).unwrap().title, "Before");
        t.entries().entry(&eid("new"))?.title("After")?;
        assert_eq!(
            view.structure_snapshot().entry(&eid("new")).unwrap().title,
            "After"
        );
        assert_eq!(after.entry(&eid("new")).unwrap().title, "Before");
        Ok(())
    })
    .0
    .unwrap();
    let old = doc.frontiers();
    let mut remote = BookDocV3::load(bid(), 42, &[doc.export_snapshot().unwrap()]).unwrap();
    remote
        .edit(Origin::User, |t| {
            t.entries().entry(&eid("new"))?.title("Imported")?;
            Ok(())
        })
        .0
        .unwrap();
    let reader = doc.reader();
    let view = reader.view();
    let before = view.structure_snapshot();
    doc.import(
        &remote.export_updates_since(&doc.version()).unwrap(),
        Origin::User,
    )
    .unwrap();
    assert_eq!(
        view.structure_snapshot().entry(&eid("new")).unwrap().title,
        "Imported"
    );
    assert_eq!(before.entry(&eid("new")).unwrap().title, "After");
    // The same live view sees checkout changes; old immutable snapshots stay put.
    view.doc.checkout(&old).unwrap();
    assert_eq!(
        view.structure_snapshot().entry(&eid("new")).unwrap().title,
        "After"
    );
    view.doc.checkout_to_latest();
    assert_eq!(
        view.structure_snapshot().entry(&eid("new")).unwrap().title,
        "Imported"
    );
    let other = BookDocV3::create(BookId::parse("other").unwrap(), 43).unwrap();
    assert!(
        other
            .view()
            .structure_snapshot()
            .entry(&eid("new"))
            .is_none()
    );
}

#[test]
fn structure_snapshot_matches_live_read_tolerances_and_order() {
    let mut doc = BookDocV3::create(bid(), 44).unwrap();
    let roots = doc
        .edit(Origin::User, apply_novel_project_template)
        .0
        .unwrap();
    doc.edit(Origin::User, |t| {
        t.entries()
            .create(
                &eid("a"),
                Some(&roots.cat_character),
                "Same",
                Some(&tid(TPL_CHARACTER)),
                false,
            )?
            .created_at(Some(Timestamp(1)))?;
        t.entries()
            .create(
                &eid("b"),
                Some(&roots.cat_character),
                "Same",
                Some(&tid(TPL_CHARACTER)),
                false,
            )?
            .created_at(Some(Timestamp(2)))?;
        t.entries()
            .create(
                &eid("dead"),
                Some(&roots.cat_character),
                "Hidden",
                Some(&tid(TPL_CHARACTER)),
                false,
            )?
            .deleted_at(Some(Timestamp(3)))?;
        // A merged child under a leaf is lifted, retaining the stored tree parent.
        t.entries()
            .create(&eid("lifted"), Some(&eid("a")), "Lifted", None, false)?;
        t.entries().create(
            &eid("unknown"),
            None,
            "Unknown",
            Some(&tid("missing-template")),
            false,
        )?;
        t.entries().move_before(&eid("b"), &eid("a"))?;
        t.put_membership(
            &roots.cat_character,
            &eid("unknown"),
            Some(&PosKey::first()),
            None,
        )?;
        t.put_membership(
            &roots.cat_character,
            &eid("a"),
            Some(&PosKey::first()),
            None,
        )?;
        t.put_membership(&roots.cat_character, &eid("dead"), None, None)?;
        t.put_membership(&eid("missing-host"), &eid("a"), None, None)?;
        Ok(())
    })
    .0
    .unwrap();
    let v = doc.view();
    let snapshot = v.structure_snapshot();
    assert_eq!(snapshot.entries().cloned().collect::<Vec<_>>(), v.entries());
    assert_eq!(snapshot.templates_map(), &v.templates_map());
    assert_eq!(snapshot.memberships(), v.memberships());
    assert_eq!(
        snapshot.entry(&eid("b")).unwrap().name_conflict,
        Some(eid("a"))
    );
    assert_eq!(
        snapshot.effective_parent(&eid("lifted")),
        Some(&roots.cat_character)
    );
    assert_eq!(
        snapshot
            .children_of(Some(&roots.cat_character))
            .iter()
            .map(|e| e.id.clone())
            .collect::<Vec<_>>(),
        vec![eid("b"), eid("a"), eid("lifted")]
    );
    for parent in std::iter::once(None).chain(v.entries().into_iter().map(|e| Some(e.id))) {
        assert_eq!(
            snapshot
                .children_of(parent.as_ref())
                .into_iter()
                .cloned()
                .collect::<Vec<_>>(),
            v.children_of(parent.as_ref())
        );
        if let Some(id) = parent {
            assert_eq!(
                snapshot.effective_parent(&id).cloned(),
                v.effective_parent(&id)
            );
            if let Some(settings) = snapshot.level_settings(&id) {
                assert_eq!(settings.settings, v.level_settings(Some(&id)));
            }
            assert_eq!(
                snapshot
                    .members_of(&id)
                    .into_iter()
                    .map(|e| e.id.clone())
                    .collect::<Vec<_>>(),
                v.memberships_of_host(&id)
                    .iter()
                    .map(|m| m.member.clone())
                    .collect::<Vec<_>>()
            );
        }
    }
}

#[test]
fn structure_snapshot_keeps_duplicate_tree_ids_and_domain_cycle_tolerance() {
    let doc = BookDocV3::create(bid(), 45).unwrap();
    let tree = doc.inner.core.doc.get_tree(crate::schema::book_v3::ENTRIES);
    tree.enable_fractional_index(0);
    let node = |id: &str, parent: Option<loro::TreeID>| {
        let n = tree.create(parent).unwrap();
        let meta = tree.get_meta(n).unwrap();
        meta.insert("id", id).unwrap();
        meta.insert("title", id).unwrap();
        n
    };
    let kept = node("shared", None);
    let copy = node("shared", None);
    // `shared` holds entries: its switch is on (on both copies).
    for n in [kept, copy] {
        tree.get_meta(n).unwrap().insert("level", true).unwrap();
    }
    node("child-one", Some(kept));
    node("child-two", Some(copy));
    // Loro's tree is acyclic, but canonical domain IDs can form a cycle.
    let x = node("x", None);
    let y = node("y", None);
    let x_copy = node("x", None);
    let y_copy = node("y", None);
    tree.mov(x, Some(y_copy)).unwrap();
    tree.mov(y, Some(x_copy)).unwrap();
    let live = doc.view();
    let snapshot = live.structure_snapshot();
    assert_eq!(
        snapshot.entries().cloned().collect::<Vec<_>>(),
        live.entries()
    );
    assert_eq!(
        snapshot.entries().map(|e| e.id.clone()).collect::<Vec<_>>(),
        vec![eid("shared"), eid("child-one"), eid("child-two")]
    );
    assert!(snapshot.entry(&eid("x")).is_none());
    assert!(snapshot.entry(&eid("y")).is_none());
    assert_eq!(snapshot.children_of(Some(&eid("shared"))).len(), 2);
}

#[test]
fn field_def_default_value_round_trips_through_loro_and_omits_null() {
    let mut doc = BookDocV3::create(bid(), 46).unwrap();
    let p0 = PosKey::parse("a0").unwrap();
    let p1 = PosKey::parse("a1").unwrap();
    let p2 = PosKey::parse("a2").unwrap();
    let p3 = PosKey::parse("a3").unwrap();
    let p4 = PosKey::parse("a4").unwrap();
    let tpl = EntryTemplate {
        id: tid("tpl-char"),
        name: "人物".into(),
        mark: None,
        color: None,
        agent: None,
        modules: vec![ModuleSpec {
            id: mid("mod-fields"),
            kind: ModuleKind::Fields,
            name: "字段".into(),
            pos: Some(p0.clone()),
            config: ModuleConfig {
                defs: vec![
                    FieldDef {
                        id: "origin".into(),
                        name: "出身".into(),
                        field_type: FieldType::Text,
                        options: vec![],
                        target_template: None,
                        pos: Some(p0),
                        default_value: Some(FieldValue::Text("未庄".into())),
                    },
                    FieldDef {
                        id: "age".into(),
                        name: "年龄".into(),
                        field_type: FieldType::Number,
                        options: vec![],
                        target_template: None,
                        pos: Some(p1),
                        default_value: Some(FieldValue::Number(25.0)),
                    },
                    FieldDef {
                        id: "tags".into(),
                        name: "标签".into(),
                        field_type: FieldType::MultiSelect,
                        options: vec!["短工".into(), "闲人".into()],
                        target_template: None,
                        pos: Some(p2),
                        default_value: Some(FieldValue::List(vec!["短工".into(), "闲人".into()])),
                    },
                    FieldDef {
                        id: "empty".into(),
                        name: "备注".into(),
                        field_type: FieldType::Text,
                        options: vec![],
                        target_template: None,
                        pos: Some(p3),
                        default_value: None,
                    },
                    FieldDef {
                        id: "nullish".into(),
                        name: "空值".into(),
                        field_type: FieldType::Text,
                        options: vec![],
                        target_template: None,
                        pos: Some(p4),
                        default_value: Some(FieldValue::Null),
                    },
                ],
                ..ModuleConfig::default()
            },
            agent: None,
        }],
        level: false,
        linkable: true,
        settings: LevelSettingsOverride::default(),
        verbs: Vec::new(),
        deleted_at: None,
    };
    doc.edit(Origin::User, |t| {
        t.template(&tpl.id)?.set_full(&tpl)?;
        Ok(())
    })
    .0
    .unwrap();
    let snapshot = doc.export_snapshot().unwrap();
    let reopened = BookDocV3::load(bid(), 47, &[snapshot]).unwrap();
    let defs = &reopened.view().template(&tid("tpl-char")).unwrap().modules[0]
        .config
        .defs;
    assert_eq!(defs[0].default_value, Some(FieldValue::Text("未庄".into())));
    assert_eq!(defs[1].default_value, Some(FieldValue::Number(25.0)));
    assert_eq!(
        defs[2].default_value,
        Some(FieldValue::List(vec!["短工".into(), "闲人".into()]))
    );
    assert_eq!(defs[3].default_value, None);
    assert_eq!(defs[4].default_value, None);
}

/// A novel book in which entries own every kind of record: patches, a plot
/// grid, memberships (one with a host that does not exist, one that names its
/// member only in a field) and relations between entries and patches.
fn book_with_owned_records() -> (BookDocV3, NovelRootEntries) {
    let mut doc = BookDocV3::create(bid(), 51).unwrap();
    let roots = doc
        .edit(Origin::User, apply_novel_project_template)
        .0
        .unwrap();
    let patch = |s: &str| PatchId::parse(s).unwrap();
    let relation = |s: &str| RelationId::parse(s).unwrap();
    let entry = |s: &str| EntityRef::new(EntityKind::Entry, s);
    doc.edit(Origin::User, |t| {
        t.entries().create(
            &eid("grp"),
            Some(&roots.cat_character),
            "主角们",
            Some(&tid(TPL_GROUP)),
            true,
        )?;
        for (id, title) in [("char-a", "林凯"), ("char-b", "苏晚")] {
            t.entries()
                .create(
                    &eid(id),
                    Some(&eid("grp")),
                    title,
                    Some(&tid(TPL_CHARACTER)),
                    false,
                )?
                .created_at(Some(Timestamp(100)))?
                .set_field(
                    &mid(MOD_FIELDS),
                    "summary",
                    Some(&FieldValue::Text(format!("{title}的梗概"))),
                )?;
        }
        for (id, title) in [("ch-1", "第一章"), ("ch-2", "第二章"), ("ch-3", "第三章")] {
            t.entries().create(
                &eid(id),
                Some(&roots.manuscript),
                title,
                Some(&tid(TPL_CHAPTER)),
                false,
            )?;
        }
        t.patch(&patch("patch-a"))?
            .entry(&eid("char-a"))?
            .module(&mid(MOD_KV))?
            .body("人物的一条补丁")?;
        t.patch(&patch("patch-ch"))?
            .entry(&eid("ch-1"))?
            .module(&mid(MOD_KV))?
            .body("章节的一条补丁")?;
        t.create_plot_grid(&eid("ch-1"), &mid(MOD_KV))?;
        t.put_membership(
            &roots.cat_character,
            &eid("char-a"),
            Some(&PosKey::first()),
            Some(Timestamp(10)),
        )?;
        t.put_membership(&eid("missing-host"), &eid("char-a"), None, None)?;
        let generic = crate::catalog::generic_relation_type_id(&bid());
        t.relation(&relation("rel-entries"))?
            .relation_type(&generic)?
            .ends(&entry("char-a"), &entry("char-b"))?;
        t.relation(&relation("rel-patch"))?
            .relation_type(&generic)?
            .ends(
                &EntityRef::new(EntityKind::Patch, "patch-a"),
                &entry("ch-2"),
            )?;
        t.relation(&relation("rel-comment"))?
            .relation_type(&generic)?
            .ends(&EntityRef::new(EntityKind::Comment, "c-1"), &entry("ch-3"))?;
        Ok(())
    })
    .0
    .unwrap();
    // A membership whose key names nobody here: its fields do.
    let odd = doc
        .inner
        .core
        .doc
        .get_map(crate::schema::book_v3::MEMBERSHIPS)
        .ensure_mergeable_map("elsewhere|nobody")
        .unwrap();
    odd.insert("member", "char-b").unwrap();
    odd.insert("future", "kept as it is").unwrap();
    doc.inner.core.doc.commit();
    (doc, roots)
}

/// `entry_change_state` as `entry_owned_raw_state` defines the rest of it:
/// the same metadata, records and parent, the entry's own position key in
/// place of the list of its siblings.
fn change_state_from_raw_state(v: &BookViewV3<'_>, e: &Entry) -> serde_json::Value {
    let mut expected = v.entry_owned_raw_state(&e.id).unwrap();
    let map = expected.as_object_mut().unwrap();
    assert!(map.remove("siblings").is_some());
    map.insert("position".into(), serde_json::json!(e.pos));
    expected
}

#[test]
fn entry_change_states_read_every_entry_at_once_as_the_single_read_does() {
    let (doc, _) = book_with_owned_records();
    let v = doc.view();
    let entries = v.entries_raw();
    let all = v.entry_change_states();
    assert_eq!(
        all.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>(),
        entries.iter().map(|e| e.id.clone()).collect::<Vec<_>>(),
        "every entry once, in tree order"
    );
    for ((id, state), e) in all.iter().zip(&entries) {
        assert_eq!(v.entry_change_state(id).as_ref(), Some(state), "{id}");
        assert_eq!(state, &change_state_from_raw_state(&v, e), "{id}");
        assert_eq!(
            state.as_object().unwrap().keys().collect::<Vec<_>>(),
            ["metadata", "parent", "position", "records"],
            "{id}"
        );
        // The owners of a record are those `entry_owned_records` gives it.
        for (collection, rows) in v.entry_owned_records(id) {
            assert_eq!(
                state["records"][collection.root()]
                    .as_object()
                    .unwrap()
                    .keys()
                    .cloned()
                    .collect::<Vec<_>>(),
                rows.into_keys().collect::<Vec<_>>(),
                "{id} {}",
                collection.root()
            );
        }
    }
    // The fixture is not vacuous: each kind of record has its owners.
    let keys = |id: &str, root: &str| -> Vec<String> {
        v.entry_change_state(&eid(id)).unwrap()["records"][root]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect()
    };
    assert_eq!(keys("char-a", "patches"), ["patch-a"]);
    assert_eq!(keys("ch-1", "patches"), ["patch-ch"]);
    assert_eq!(keys("ch-1", "plot_grids"), [format!("ch-1/{MOD_KV}")]);
    assert_eq!(keys("char-a", "memberships").len(), 2);
    assert_eq!(keys("char-b", "memberships"), ["elsewhere|nobody"]);
    assert_eq!(keys("char-a", "relations"), ["rel-entries", "rel-patch"]);
    assert_eq!(keys("char-b", "relations"), ["rel-entries"]);
    assert_eq!(keys("ch-2", "relations"), ["rel-patch"]);
    assert_eq!(keys("ch-3", "relations"), ["rel-comment"]);
    assert!(v.entry_change_state(&eid("nobody")).is_none());
}

#[test]
fn an_entry_change_state_follows_the_entry_and_not_its_siblings() {
    let (mut doc, roots) = book_with_owned_records();
    let state = |doc: &BookDocV3, id: &str| doc.view().entry_change_state(&eid(id)).unwrap();
    let siblings = |doc: &BookDocV3, id: &str| {
        doc.view().entry_owned_raw_state(&eid(id)).unwrap()["siblings"].clone()
    };
    let edit = |doc: &mut BookDocV3, f: &dyn Fn(&mut BookTxnV3<'_>) -> Result<()>| {
        let (r, committed) = doc.edit(Origin::User, f);
        r.unwrap();
        assert!(committed.is_some(), "the step wrote something");
    };
    let (one, two, three) = (
        state(&doc, "ch-1"),
        state(&doc, "ch-2"),
        state(&doc, "ch-3"),
    );
    let listed = siblings(&doc, "ch-2");

    // Siblings arrive: one at the end, one in front of them all.
    edit(&mut doc, &|t| {
        t.entries().create(
            &eid("ch-new"),
            Some(&roots.manuscript),
            "新的一章",
            Some(&tid(TPL_CHAPTER)),
            false,
        )?;
        t.entries().create_at(
            &eid("ch-first"),
            Some(&roots.manuscript),
            0,
            "序",
            Some(&tid(TPL_CHAPTER)),
            false,
        )?;
        Ok(())
    });
    assert_ne!(
        siblings(&doc, "ch-2"),
        listed,
        "the sibling list did change"
    );
    for (id, before) in [("ch-1", &one), ("ch-2", &two), ("ch-3", &three)] {
        assert_eq!(&state(&doc, id), before, "{id} after siblings arrived");
    }

    // A sibling moves across the entry: the mover changed, nobody else.
    edit(&mut doc, &|t| {
        t.entries().move_before(&eid("ch-3"), &eid("ch-1"))
    });
    let moved = state(&doc, "ch-3");
    assert_ne!(moved, three);
    assert_eq!(moved["parent"], three["parent"]);
    assert_ne!(moved["position"], three["position"]);
    assert_eq!(moved["metadata"], three["metadata"]);
    assert_eq!(state(&doc, "ch-1"), one);
    assert_eq!(state(&doc, "ch-2"), two);

    // A sibling is trashed, leaves for another parent, and siblings are
    // deleted (one of them keeping a child, which moves up beside the entry).
    edit(&mut doc, &|t| {
        t.entries()
            .entry(&eid("ch-new"))?
            .deleted_at(Some(Timestamp(7)))?;
        Ok(())
    });
    edit(&mut doc, &|t| {
        t.entries().move_to(&eid("ch-3"), Some(&roots.ideas))
    });
    edit(&mut doc, &|t| {
        t.entries().create(
            &eid("under-first"),
            Some(&eid("ch-first")),
            "子条目",
            None,
            false,
        )?;
        Ok(())
    });
    edit(&mut doc, &|t| t.entries().purge_subtree(&eid("ch-new")));
    edit(&mut doc, &|t| {
        t.entries().delete_keep_children(&eid("ch-first"))?;
        Ok(())
    });
    assert_eq!(state(&doc, "ch-1"), one);
    assert_eq!(state(&doc, "ch-2"), two);
    assert_eq!(
        state(&doc, "ch-3")["parent"],
        serde_json::json!(roots.ideas),
        "the entry that left has another home"
    );
    assert_eq!(
        state(&doc, "under-first")["parent"],
        serde_json::json!(roots.manuscript),
        "a child lifted to its grandparent changed its own home"
    );

    // The entry's own moves: among its siblings, then to another parent.
    edit(&mut doc, &|t| {
        t.entries().move_before(&eid("ch-2"), &eid("ch-1"))
    });
    let reordered = state(&doc, "ch-2");
    assert_ne!(reordered["position"], two["position"]);
    assert_eq!(reordered["parent"], two["parent"]);
    assert_eq!(
        state(&doc, "ch-1"),
        one,
        "the entry it passed did not change"
    );
    edit(&mut doc, &|t| {
        t.entries().move_to(&eid("ch-2"), Some(&roots.ideas))
    });
    assert_ne!(state(&doc, "ch-2")["parent"], reordered["parent"]);
    assert_eq!(state(&doc, "ch-1"), one);

    // Its own content still counts, and so do the records it owns.
    edit(&mut doc, &|t| {
        t.entries().entry(&eid("ch-1"))?.title("改了名")?;
        Ok(())
    });
    let renamed = state(&doc, "ch-1");
    assert_ne!(renamed["metadata"], one["metadata"]);
    assert_eq!(renamed["position"], one["position"]);
    edit(&mut doc, &|t| {
        t.patch(&PatchId::parse("patch-ch").unwrap())?
            .body("补丁改了")?;
        Ok(())
    });
    assert_ne!(state(&doc, "ch-1")["records"], renamed["records"]);
}

#[test]
fn an_entry_made_on_two_devices_reads_its_change_state_from_the_kept_node() {
    let (first, roots) = book_with_owned_records();
    let mut one = BookDocV3::load(bid(), 61, &[first.export_snapshot().unwrap()]).unwrap();
    let mut two = BookDocV3::load(bid(), 62, &[first.export_snapshot().unwrap()]).unwrap();
    // Each device makes the entry with the same content before they meet,
    // and gives it a child of its own.
    for (doc, child) in [(&mut one, "child-one"), (&mut two, "child-two")] {
        doc.edit(Origin::User, |t| {
            t.entries()
                .create(
                    &eid("twice"),
                    Some(&roots.ideas),
                    "两台设备各建了一个",
                    Some(&tid(TPL_IDEA_GROUP)),
                    true,
                )?
                .created_at(Some(Timestamp(5)))?;
            t.entries().create(
                &eid(child),
                Some(&eid("twice")),
                child,
                Some(&tid(TPL_IDEA)),
                false,
            )?;
            Ok(())
        })
        .0
        .unwrap();
    }
    let states = |doc: &BookDocV3| -> std::collections::BTreeMap<EntryId, serde_json::Value> {
        doc.view().entry_change_states().into_iter().collect()
    };
    let (before_one, before_two) = (states(&one), states(&two));
    let from_two = two.export_updates_since(&one.version()).unwrap();
    let from_one = one.export_updates_since(&two.version()).unwrap();
    one.import(&from_two, Origin::Sync).unwrap();
    two.import(&from_one, Origin::Sync).unwrap();

    let (after_one, after_two) = (states(&one), states(&two));
    assert_eq!(after_one, after_two, "both devices read the same");
    for doc in [&one, &two] {
        let v = doc.view();
        assert_eq!(
            v.tree_index(crate::schema::book_v3::ENTRIES)["twice"].len(),
            2
        );
        let all = v.entry_change_states();
        assert_eq!(all.len(), v.entries_raw().len(), "the entry is listed once");
        for ((id, state), e) in all.iter().zip(&v.entries_raw()) {
            assert_eq!(v.entry_change_state(id).as_ref(), Some(state), "{id}");
            assert_eq!(state, &change_state_from_raw_state(&v, e), "{id}");
        }
    }
    // The children of both nodes are the entry's children.
    for child in ["child-one", "child-two"] {
        assert_eq!(after_one[&eid(child)]["parent"], "twice");
    }
    // The node kept is the first device's (the smaller tree id). The second
    // node holds the same content at the same key, so on neither device did
    // the entry, its children or anything else change by the meeting.
    for (id, state) in &before_one {
        assert_eq!(&after_one[id], state, "{id} on the first device");
    }
    for (id, state) in &before_two {
        assert_eq!(&after_two[id], state, "{id} on the second device");
    }

    // Moving the entry moves the kept node: that is a change; a move beside
    // it is not.
    one.edit(Origin::User, |t| {
        t.entries().create(
            &eid("beside"),
            Some(&roots.ideas),
            "旁边的",
            Some(&tid(TPL_IDEA)),
            false,
        )?;
        t.entries().move_before(&eid("beside"), &eid("twice"))
    })
    .0
    .unwrap();
    assert_eq!(states(&one)[&eid("twice")], after_one[&eid("twice")]);
    one.edit(Origin::User, |t| {
        t.entries().move_before(&eid("twice"), &eid("beside"))
    })
    .0
    .unwrap();
    assert_ne!(
        states(&one)[&eid("twice")]["position"],
        after_one[&eid("twice")]["position"]
    );
}

#[test]
fn siblings_holding_one_position_key_get_new_keys_when_an_entry_goes_between_them() {
    // The one case in which an entry's position changes without the entry
    // being moved by anyone: two devices each put an entry at the end of the
    // same level, so the two hold the same key; when a third goes between
    // them Loro has no key to give it and re-keys the neighbours.
    let (first, roots) = book_with_owned_records();
    let mut one = BookDocV3::load(bid(), 71, &[first.export_snapshot().unwrap()]).unwrap();
    let mut two = BookDocV3::load(bid(), 72, &[first.export_snapshot().unwrap()]).unwrap();
    for (doc, id) in [(&mut one, "ch-east"), (&mut two, "ch-west")] {
        doc.edit(Origin::User, |t| {
            t.entries().create(
                &eid(id),
                Some(&roots.manuscript),
                id,
                Some(&tid(TPL_CHAPTER)),
                false,
            )?;
            Ok(())
        })
        .0
        .unwrap();
    }
    let from_two = two.export_updates_since(&one.version()).unwrap();
    one.import(&from_two, Origin::Sync).unwrap();
    let state = |doc: &BookDocV3, id: &str| doc.view().entry_change_state(&eid(id)).unwrap();
    let (east, west, third) = (
        state(&one, "ch-east"),
        state(&one, "ch-west"),
        state(&one, "ch-3"),
    );
    assert_eq!(east["position"], west["position"], "one key for both");
    let order = |doc: &BookDocV3| -> Vec<String> {
        doc.view()
            .children_of(Some(&roots.manuscript))
            .into_iter()
            .map(|e| e.id.to_string())
            .collect()
    };
    assert_eq!(order(&one), ["ch-1", "ch-2", "ch-3", "ch-east", "ch-west"]);

    one.edit(Origin::User, |t| {
        t.entries().create_at(
            &eid("ch-between"),
            Some(&roots.manuscript),
            4,
            "夹在中间",
            Some(&tid(TPL_CHAPTER)),
            false,
        )?;
        Ok(())
    })
    .0
    .unwrap();
    assert_eq!(
        order(&one),
        ["ch-1", "ch-2", "ch-3", "ch-east", "ch-between", "ch-west"]
    );
    let (east_after, west_after) = (state(&one, "ch-east"), state(&one, "ch-west"));
    assert_ne!(east_after["position"], west_after["position"]);
    assert!(
        east_after["position"] != east["position"] || west_after["position"] != west["position"],
        "a neighbour was given a new key"
    );
    // Nothing but the key: what they own and where they live is as it was.
    for (before, after) in [(&east, &east_after), (&west, &west_after)] {
        for key in ["metadata", "records", "parent"] {
            assert_eq!(before[key], after[key]);
        }
    }
    // And only the neighbours that shared the key: nobody further away.
    assert_eq!(state(&one, "ch-3"), third);
}

#[test]
fn entry_change_states_leave_out_what_the_tree_readers_leave_out() {
    // The duplicate and cyclic shapes of
    // `structure_snapshot_keeps_duplicate_tree_ids_and_domain_cycle_tolerance`.
    let doc = BookDocV3::create(bid(), 63).unwrap();
    let tree = doc.inner.core.doc.get_tree(crate::schema::book_v3::ENTRIES);
    tree.enable_fractional_index(0);
    let node = |id: &str, parent: Option<loro::TreeID>| {
        let n = tree.create(parent).unwrap();
        let meta = tree.get_meta(n).unwrap();
        meta.insert("id", id).unwrap();
        meta.insert("title", id).unwrap();
        n
    };
    let kept = node("shared", None);
    let copy = node("shared", None);
    // `shared` holds entries: its switch is on (on both copies).
    for n in [kept, copy] {
        tree.get_meta(n).unwrap().insert("level", true).unwrap();
    }
    node("child-one", Some(kept));
    node("child-two", Some(copy));
    let x = node("x", None);
    let y = node("y", None);
    let x_copy = node("x", None);
    let y_copy = node("y", None);
    tree.mov(x, Some(y_copy)).unwrap();
    tree.mov(y, Some(x_copy)).unwrap();
    let v = doc.view();
    let all = v.entry_change_states();
    assert_eq!(
        all.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>(),
        vec![eid("shared"), eid("child-one"), eid("child-two")]
    );
    for ((id, state), e) in all.iter().zip(&v.entries_raw()) {
        assert_eq!(v.entry_change_state(id).as_ref(), Some(state), "{id}");
        assert_eq!(state, &change_state_from_raw_state(&v, e), "{id}");
    }
    assert_eq!(
        all[0].1["position"],
        serde_json::json!(tree.fractional_index(kept).unwrap()),
        "the kept node's key"
    );
    assert_ne!(
        tree.fractional_index(kept),
        tree.fractional_index(copy),
        "the copy sits elsewhere"
    );
    assert_eq!(all[2].1["parent"], "shared");
    assert!(v.entry_change_state(&eid("x")).is_none());
    assert!(v.entry_change_state(&eid("y")).is_none());
}

/// A novel book with entries added by `f`.
fn novel_book(
    peer: u64,
    f: impl FnOnce(&mut BookTxnV3<'_>, &NovelRootEntries) -> Result<()>,
) -> (BookDocV3, NovelRootEntries) {
    let mut doc = BookDocV3::create(bid(), peer).unwrap();
    let (roots, _) = doc.edit(Origin::User, apply_novel_project_template);
    let roots = roots.unwrap();
    let (r, _) = doc.edit(Origin::User, |t| f(t, &roots));
    r.unwrap();
    (doc, roots)
}

#[test]
fn the_manuscript_sequence_puts_each_entrys_own_book_prose_before_what_lives_under_it() {
    let chapter = tid(TPL_CHAPTER);
    let group = tid(TPL_GROUP);
    let (doc, roots) = novel_book(70, |t, roots| {
        let ms = Some(&roots.manuscript);
        // A chapter with entries under it: its own prose comes first.
        t.entries()
            .create(&eid("vol"), ms, "第一卷", Some(&chapter), true)?;
        t.entries()
            .create(&eid("ch-a"), Some(&eid("vol")), "甲", Some(&chapter), false)?;
        // A group: its 「说明」 is not part of the book, so it has no number.
        t.entries()
            .create(&eid("grp"), ms, "分组", Some(&group), true)?;
        t.entries()
            .create(&eid("ch-c"), Some(&eid("grp")), "丙", Some(&chapter), false)?;
        t.entries()
            .create(&eid("ch-b"), ms, "乙", Some(&chapter), false)?;
        // A merge left `lifted` under `ch-b`, whose switch is off.
        t.entries().create(
            &eid("lifted"),
            Some(&eid("ch-b")),
            "丁",
            Some(&chapter),
            false,
        )?;
        // Trashed: neither it nor what lives under it counts.
        t.entries()
            .create(&eid("gone"), ms, "删", Some(&chapter), true)?
            .deleted_at(Some(Timestamp(9)))?;
        t.entries().create(
            &eid("gone-child"),
            Some(&eid("gone")),
            "删下",
            Some(&chapter),
            false,
        )?;
        // A second, separate manuscript: numbering continues there.
        t.entries()
            .create(&eid("appendix"), None, "附录", Some(&group), true)?
            .overrides(Some(&LevelSettingsOverride {
                is_manuscript: Some(true),
                ..LevelSettingsOverride::default()
            }))?;
        t.entries().create(
            &eid("ch-z"),
            Some(&eid("appendix")),
            "戊",
            Some(&chapter),
            false,
        )?;
        Ok(())
    });
    let s = doc.view().structure_snapshot();
    let parts = s.manuscript();
    let read = |part: &ManuscriptPart<'_>| -> Vec<(String, u32, Option<u32>, Vec<String>)> {
        part.entries
            .iter()
            .map(|e| {
                (
                    e.entry.title.clone(),
                    e.depth,
                    e.ordinal,
                    e.prose.iter().map(|p| p.module.to_string()).collect(),
                )
            })
            .collect()
    };
    assert_eq!(parts.len(), 2);
    assert_eq!(parts[0].root.id, roots.manuscript);
    let prose = || vec![MOD_PROSE.to_string()];
    assert_eq!(
        read(&parts[0]),
        vec![
            ("书稿".into(), 0, None, vec![]),
            ("第一卷".into(), 1, Some(1), prose()),
            ("甲".into(), 2, Some(2), prose()),
            ("分组".into(), 1, None, vec![]),
            ("丙".into(), 2, Some(3), prose()),
            ("乙".into(), 1, Some(4), prose()),
            ("丁".into(), 1, Some(5), prose()),
        ]
    );
    assert_eq!(parts[1].root.id, eid("appendix"));
    assert_eq!(
        read(&parts[1]),
        vec![
            ("附录".into(), 0, None, vec![]),
            ("戊".into(), 1, Some(6), prose())
        ]
    );
    assert_eq!(s.ordinal(&eid("ch-c")), Some(3));
    assert_eq!(s.ordinal(&eid("grp")), None);
    assert_eq!(s.ordinal(&eid("gone")), None);
    assert_eq!(
        s.manuscript_docs().first(),
        Some(&DocId::Body(BodyDocId::new(eid("vol"), mid(MOD_PROSE))))
    );
    // The same walk with every prose: the 「说明」 shows, still not in the book.
    let all = s
        .flatten(
            &roots.manuscript,
            Flatten {
                in_book_only: false,
                include_members: false,
            },
        )
        .unwrap();
    let description = &all[0].prose;
    assert_eq!(description.len(), 1);
    assert_eq!(description[0].module, mid(MOD_DESCRIPTION));
    assert!(!description[0].in_book);
    assert_eq!(description[0].name, "说明");
}

#[test]
fn flattening_a_lane_reads_its_members_in_lane_order_once_and_leaves_the_manuscript_alone() {
    let chapter = tid(TPL_CHAPTER);
    let (doc, _) = novel_book(71, |t, roots| {
        // `holder` lives at the root and accepts; the storyline lives under it
        // and has `holder` as a member: a cycle through a membership.
        t.entries()
            .create(&eid("holder"), None, "容器", Some(&tid(TPL_GROUP)), true)?
            .overrides(Some(&LevelSettingsOverride {
                accept: Some(true),
                ..LevelSettingsOverride::default()
            }))?;
        t.entries().create(
            &eid("sl"),
            Some(&eid("holder")),
            "主线",
            Some(&tid(TPL_STORYLINE)),
            true,
        )?;
        t.entries().create(
            &eid("own"),
            Some(&eid("sl")),
            "线上的构想",
            Some(&tid(TPL_IDEA)),
            false,
        )?;
        for (id, title) in [("ch-a", "甲"), ("ch-b", "乙"), ("ch-t", "删")] {
            t.entries().create(
                &eid(id),
                Some(&roots.manuscript),
                title,
                Some(&chapter),
                false,
            )?;
        }
        t.entries()
            .entry(&eid("ch-t"))?
            .deleted_at(Some(Timestamp(3)))?;
        let p = |s: &str| PosKey::parse(s).unwrap();
        // The lane's own order: `ch-b` after `ch-a` although created later.
        t.put_membership(&eid("sl"), &eid("ch-b"), Some(&p("a1")), None)?;
        t.put_membership(&eid("sl"), &eid("ch-a"), Some(&p("a0")), None)?;
        t.put_membership(&eid("sl"), &eid("holder"), Some(&p("a2")), None)?;
        t.put_membership(&eid("sl"), &eid("ch-t"), Some(&p("a3")), None)?;
        // `ch-a` belongs to `holder` too: still once.
        t.put_membership(&eid("holder"), &eid("ch-a"), None, None)?;
        Ok(())
    });
    let s = doc.view().structure_snapshot();
    let titles = |from: &str, include_members: bool| -> Vec<(String, u32)> {
        s.flatten(
            &eid(from),
            Flatten {
                in_book_only: true,
                include_members,
            },
        )
        .unwrap()
        .into_iter()
        .map(|e| (e.entry.title.clone(), e.depth))
        .collect()
    };
    // Residents first, then members by the lane's order; each entry once;
    // the trashed member not at all.
    assert_eq!(
        titles("sl", true),
        vec![
            ("主线".into(), 0),
            ("线上的构想".into(), 1),
            ("甲".into(), 1),
            ("乙".into(), 1),
            ("容器".into(), 1),
        ]
    );
    assert_eq!(
        titles("holder", true),
        vec![
            ("容器".into(), 0),
            ("主线".into(), 1),
            ("线上的构想".into(), 2),
            ("甲".into(), 2),
            ("乙".into(), 2),
        ]
    );
    assert_eq!(
        titles("sl", false),
        vec![("主线".into(), 0), ("线上的构想".into(), 1)]
    );
    // The manuscript takes residents only.
    let manuscript: Vec<String> = s
        .manuscript()
        .into_iter()
        .flat_map(|p| p.entries)
        .map(|e| e.entry.title.clone())
        .collect();
    assert_eq!(manuscript, vec!["书稿", "甲", "乙"]);
    // Only a live entry whose switch is on can be a starting point.
    assert_eq!(
        s.flatten(&eid("ch-a"), Flatten::default()).unwrap_err(),
        NotALevel(eid("ch-a"))
    );
}

#[test]
fn switching_off_moves_direct_children_after_the_top_level_entry_with_their_subtrees() {
    let chapter = tid(TPL_CHAPTER);
    let (mut doc, roots) = novel_book(72, |t, roots| {
        t.entries().create(
            &eid("vol"),
            Some(&roots.manuscript),
            "卷",
            Some(&tid(TPL_GROUP)),
            true,
        )?;
        t.entries()
            .entry(&eid("vol"))?
            .overrides(Some(&LevelSettingsOverride {
                auto_link: Some(true),
                ..LevelSettingsOverride::default()
            }))?;
        for id in ["c1", "c2", "c3"] {
            t.entries()
                .create(&eid(id), Some(&eid("vol")), id, Some(&chapter), id == "c3")?;
        }
        t.entries()
            .entry(&eid("c2"))?
            .deleted_at(Some(Timestamp(4)))?;
        t.entries()
            .create(&eid("c3a"), Some(&eid("c3")), "c3a", Some(&chapter), false)?;
        Ok(())
    });
    let (moved, _) = doc.edit(Origin::User, |t| t.entries().switch_level_off(&eid("vol")));
    assert_eq!(moved.unwrap(), vec![eid("c1"), eid("c2"), eid("c3")]);
    let v = doc.view();
    let raw = v.entries_raw();
    let at = |id: &str| raw.iter().find(|e| e.id == eid(id)).unwrap();
    // Right after the top-level entry `vol` lives under, in their order,
    // the trashed one included; subtrees go along.
    let roots_order: Vec<EntryId> = raw
        .iter()
        .filter(|e| e.parent.is_none())
        .map(|e| e.id.clone())
        .collect();
    assert_eq!(
        roots_order,
        vec![
            roots.manuscript.clone(),
            eid("c1"),
            eid("c2"),
            eid("c3"),
            roots.ideas.clone(),
            roots.elements.clone(),
            roots.storylines.clone(),
        ]
    );
    assert_eq!(at("c3a").parent, Some(eid("c3")));
    assert!(at("c2").is_trashed());
    // `vol` keeps its place and its overrides; only its switch changed.
    assert_eq!(at("vol").parent, Some(roots.manuscript.clone()));
    assert!(!at("vol").level);
    assert!(
        at("vol")
            .overrides
            .as_ref()
            .is_some_and(|o| o.auto_link == Some(true))
    );

    // An entry at the root: its children go right after itself.
    let (r, _) = doc.edit(Origin::User, |t| {
        t.entries().create(
            &eid("idea"),
            Some(&roots.ideas),
            "构想甲",
            Some(&tid(TPL_IDEA)),
            false,
        )?;
        Ok(())
    });
    r.unwrap();
    let (moved, _) = doc.edit(Origin::User, |t| t.entries().switch_level_off(&roots.ideas));
    assert_eq!(moved.unwrap(), vec![eid("idea")]);
    let after: Vec<EntryId> = doc
        .view()
        .entries_raw()
        .into_iter()
        .filter(|e| e.parent.is_none())
        .map(|e| e.id)
        .collect();
    let i = after.iter().position(|e| e == &roots.ideas).unwrap();
    assert_eq!(after[i + 1], eid("idea"));
}

#[test]
fn entry_headers_read_what_the_checks_read_like_a_full_read() {
    let (doc, _) = novel_book(73, |t, roots| {
        let fmod = mid(MOD_FIELDS);
        for (id, title, alias) in [("p1", "林凯", "凯哥"), ("p2", "凯哥", "阿凯")] {
            t.entries()
                .create(
                    &eid(id),
                    Some(&roots.cat_character),
                    title,
                    Some(&tid(TPL_CHARACTER)),
                    false,
                )?
                .created_at(Some(Timestamp(if id == "p1" { 1 } else { 2 })))?
                .set_field(
                    &fmod,
                    "aliases",
                    Some(&FieldValue::List(vec![alias.into()])),
                )?
                .set_field(&fmod, "summary", Some(&FieldValue::Text("长摘要".into())))?;
        }
        t.entries()
            .entry(&eid("p2"))?
            .deleted_at(Some(Timestamp(3)))?;
        Ok(())
    });
    let v = doc.view();
    let templates = v.templates_map();
    let full = v.entries_map();
    let headers = v.entry_headers();
    assert_eq!(full.len(), headers.len());
    for (id, e) in &full {
        let h = &headers[id];
        assert_eq!(
            (&h.parent, &h.title, &h.template, h.level, &h.overrides),
            (&e.parent, &e.title, &e.template, e.level, &e.overrides),
            "{id}"
        );
        assert_eq!((h.created_at, h.deleted_at), (e.created_at, e.deleted_at));
        assert_eq!(h.aliases(&templates), e.aliases(&templates), "{id}");
    }
    // Only alias fields are read.
    assert!(!headers[&eid("p1")].fields[&mid(MOD_FIELDS)].contains_key("summary"));
    let memberships = v.memberships_raw();
    assert_eq!(
        AutolinkNames::of(&headers, &memberships, &templates),
        AutolinkNames::of(&full, &memberships, &templates)
    );
    // One entry with its conflict, as the full read marks it.
    let (doc, _) = novel_book(74, |t, roots| {
        for (id, title) in [("q1", "同名"), ("q2", "同名")] {
            t.entries()
                .create(
                    &eid(id),
                    Some(&roots.cat_character),
                    title,
                    Some(&tid(TPL_CHARACTER)),
                    false,
                )?
                .created_at(Some(Timestamp(if id == "q1" { 1 } else { 2 })))?;
        }
        Ok(())
    });
    let v = doc.view();
    for e in v.entries() {
        assert_eq!(v.entry(&e.id).unwrap(), e, "{}", e.id);
    }
    assert_eq!(v.entry(&eid("q2")).unwrap().name_conflict, Some(eid("q1")));
}
