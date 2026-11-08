//! Tests for the universal kernel v3 book document (`dr-doc::v3`).

use std::collections::BTreeSet;

use dr_model::book::KvEntry;
use dr_model::id::*;
use dr_model::kind::EntityKind;
use dr_model::pos::PosKey;
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

    // Root entries in manuscript order: 书稿, 构想, 要素, 故事线.
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

    // Prose ownership: body:<entry>/<module>, body:<entry>/about, template:<tpl>/<mod>.
    let ch_body = DocId::parse("body:ch-1/mod-prose").unwrap();
    let sl_about = DocId::parse("body:sl-main/about").unwrap();
    let orphan_body = DocId::parse("body:missing/mod-prose").unwrap();
    let tpl_doc = DocId::parse("template:tpl-chapter/mod-prose").unwrap();
    assert!(v.owns_prose(&ch_body));
    assert!(v.owns_prose(&sl_about));
    assert!(!v.owns_prose(&orphan_body));
    assert!(v.owns_prose(&tpl_doc));

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
