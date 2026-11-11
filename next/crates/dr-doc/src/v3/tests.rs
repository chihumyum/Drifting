//! Tests for the universal kernel v3 book document (`dr-doc::v3`).

use std::collections::BTreeSet;

use dr_model::id::*;
use dr_model::kind::EntityKind;
use dr_model::pos::PosKey;
use dr_model::shared::KvEntry;
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
fn genesis_v3_sets_version_3_and_locked_generic_relation_type() {
    let doc = BookDocV3::create(bid(), 1).unwrap();
    let v = doc.view();
    assert_eq!(v.meta().schema_version, 3);
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
    assert!(tpls[&tid(TPL_MANUSCRIPT)].is_level());
    assert!(tpls[&tid(TPL_STORYLINE)].is_lane_level());
    assert!(tpls[&tid(TPL_CHAPTER)].is_leaf());

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
    assert_eq!(v.novel_roots(), Some(roots.clone()));
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
        )?;
        let c1 = t.entries().create(
            &eid("char-1"),
            Some(&eid("grp-protagonists")),
            "林凯",
            Some(&tid(TPL_CHARACTER)),
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
        )?;
        c2.created_at(Some(Timestamp(200)))?;

        // Two chapters under 书稿.
        t.entries().create(
            &eid("ch-1"),
            Some(&roots.manuscript),
            "第一章",
            Some(&tid(TPL_CHAPTER)),
        )?;
        t.entries().create(
            &eid("ch-2"),
            Some(&roots.manuscript),
            "第二章",
            Some(&tid(TPL_CHAPTER)),
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

    // Chapters under 书稿 reflect move_before order.
    let leaves: Vec<EntryId> = v
        .manuscript_leaves(&roots.manuscript)
        .into_iter()
        .map(|e| e.id)
        .collect();
    assert_eq!(leaves, vec![eid("ch-2"), eid("ch-1")]);

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
        )?;
        t.entries().create(
            &eid("ch-1"),
            Some(&roots.manuscript),
            "第一章",
            Some(&tid(TPL_CHAPTER)),
        )?;
        t.entries().create(
            &eid("ch-2"),
            Some(&roots.manuscript),
            "第二章",
            Some(&tid(TPL_CHAPTER)),
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

    // Prose ownership: body:<entry>/<module>, body:<entry>/about, template:<book>/<tpl>/<mod>.
    let ch_body = DocId::parse("body:ch-1/mod-prose").unwrap();
    let sl_about = DocId::parse("body:sl-main/about").unwrap();
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
    assert_eq!(doc.view().novel_roots(), Some(roots));
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
            )?
            .created_at(Some(Timestamp(1)))?;
        t.entries()
            .create(
                &eid("b"),
                Some(&roots.cat_character),
                "Same",
                Some(&tid(TPL_CHARACTER)),
            )?
            .created_at(Some(Timestamp(2)))?;
        t.entries()
            .create(
                &eid("dead"),
                Some(&roots.cat_character),
                "Hidden",
                Some(&tid(TPL_CHARACTER)),
            )?
            .deleted_at(Some(Timestamp(3)))?;
        // A merged child under a leaf is lifted, retaining the stored tree parent.
        t.entries()
            .create(&eid("lifted"), Some(&eid("a")), "Lifted", None)?;
        t.entries().create(
            &eid("unknown"),
            None,
            "Unknown",
            Some(&tid("missing-template")),
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
        kind: TemplateKind::Leaf,
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
        settings: LevelSettingsOverride::default(),
        lane: false,
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
