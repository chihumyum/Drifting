//! Book document behaviour: genesis, field-level merges, read tolerance,
//! repairs, trees, events.

use std::sync::{Arc, Mutex};

use dr_model::book::{Asset, EntityRef, KvEntry, canonical_symmetric};
use dr_model::id::*;
use dr_model::kind::*;
use dr_model::pos::PosKey;
use dr_model::{Day, DocId, Origin, Timestamp};

use super::*;
use crate::error::DocError;
use crate::prose::ProseDoc;

fn bid() -> BookId {
    BookId::parse("b1").unwrap()
}

fn book(peer: u64) -> BookDoc {
    BookDoc::create(bid(), peer).unwrap()
}

fn user<R>(d: &mut BookDoc, f: impl FnOnce(&mut BookTxn<'_>) -> crate::Result<R>) -> R {
    let (r, _) = d.edit(Origin::User, f);
    r.unwrap()
}

fn sync(from: &BookDoc, to: &mut BookDoc) {
    let bytes = from.export_updates_since(&to.version()).unwrap();
    to.import(&bytes, Origin::Sync).unwrap();
}

fn sync_both(a: &mut BookDoc, b: &mut BookDoc) {
    sync(a, b);
    sync(b, a);
}

fn n(s: &str) -> NodeId {
    NodeId::parse(s).unwrap()
}

fn el(s: &str) -> EntityRef {
    EntityRef::new(EntityKind::Element, s)
}

fn chapter(t: &mut BookTxn<'_>, id: &str, order: Option<f64>) -> crate::Result<()> {
    let w = t.node(&n(id))?;
    w.kind(&NodeKind::Chapter)?.title(id)?.book_order(order)?;
    Ok(())
}

fn element(t: &mut BookTxn<'_>, id: &str) -> crate::Result<()> {
    t.element(&ElementId::parse(id).unwrap())?.name(id)?;
    Ok(())
}

#[test]
fn genesis_is_deterministic_and_the_builtin_type_exists_once() {
    assert_eq!(genesis(&bid()), genesis(&bid()));
    let mut a = book(1);
    let mut b = book(2);
    user(&mut a, |t| t.meta().name("甲书").map(|_| ()));
    user(&mut b, |t| t.meta().summary("梗概").map(|_| ()));
    sync_both(&mut a, &mut b);
    let types = a.view().relation_types();
    assert_eq!(types.len(), 1);
    let t = &types[0];
    assert_eq!(t.id, generic_relation_type_id(&bid()));
    assert_eq!(t.id.as_str(), "system:generic-association:b1");
    assert!(t.locked);
    assert_eq!(t.orientation, RelationOrientation::Directed);
    assert_eq!(t.system_key, Some(SystemRelationKey::GenericAssociation));
    assert_eq!(
        t.source_kinds,
        vec![EntityKind::Comment, EntityKind::Material]
    );
    assert_eq!(t.target_kinds.len(), 5);
    assert_eq!(t.normalized_name, "generic association");
    let m = a.view().meta();
    assert_eq!((m.name.as_str(), m.summary.as_str()), ("甲书", "梗概"));
    assert_eq!(m.schema_version, crate::schema::SCHEMA_VERSION);
}

#[test]
fn the_builtin_relation_type_is_locked() {
    let mut a = book(1);
    let id = generic_relation_type_id(&bid());
    let (r, c) = a.edit(Origin::User, |t| t.relation_type(&id).map(|_| ()));
    assert!(matches!(r, Err(DocError::Locked(_))));
    assert!(c.is_none());
    let (r, _) = a.edit(Origin::User, |t| {
        t.purge(Collection::RelationTypes, id.as_str())
    });
    assert!(matches!(r, Err(DocError::Locked(_))));
    // A user type is writable and purgeable.
    let mine = RelationTypeId::parse("rt-friend").unwrap();
    user(&mut a, |t| {
        t.relation_type(&mine)?
            .name("  Friend ")?
            .orientation(&RelationOrientation::Symmetric)?
            .source_kinds(&[EntityKind::Element])?
            .target_kinds(&[EntityKind::Element])?;
        Ok(())
    });
    let t = a.view().relation_type(&mine).unwrap();
    assert_eq!(
        (t.name.as_str(), t.normalized_name.as_str()),
        ("Friend", "friend")
    );
    user(&mut a, |t| {
        t.purge(Collection::RelationTypes, mine.as_str())
    });
    assert!(a.view().relation_type(&mine).is_none());
}

#[test]
fn entities_merge_field_by_field() {
    let mut a = book(1);
    let mut b = book(2);
    let e = ElementId::parse("el-1").unwrap();
    user(&mut a, |t| t.element(&e)?.name("安").map(|_| ()));
    user(&mut b, |t| {
        t.element(&e)?.summary("摘要")?.add_alias("小安")?;
        Ok(())
    });
    sync_both(&mut a, &mut b);
    let x = a.view().element(&e).unwrap();
    assert_eq!((x.name.as_str(), x.summary.as_str()), ("安", "摘要"));
    assert!(x.aliases.contains("小安"));
    // Concurrent edits of different fields of one entity both survive.
    user(&mut a, |t| t.element(&e)?.name("安娜").map(|_| ()));
    user(&mut b, |t| {
        t.element(&e)?.group_name(Some("主角")).map(|_| ())
    });
    sync_both(&mut a, &mut b);
    let x = b.view().element(&e).unwrap();
    assert_eq!(x.name, "安娜");
    assert_eq!(x.group_name.as_deref(), Some("主角"));
}

#[test]
fn unknown_fields_survive_an_edit() {
    // A field a newer version wrote is kept when this version edits the
    // entity: writes are per field.
    let mut a = book(1);
    let id = n("c1");
    user(&mut a, |t| chapter(t, "c1", Some(5.0)));
    a.edit(Origin::User, |t| {
        t.view
            .doc
            .get_map("nodes")
            .ensure_mergeable_map("c1")?
            .insert("future_field", 42)?;
        Ok(())
    })
    .0
    .unwrap();
    user(&mut a, |t| t.node(&id)?.title("改名").map(|_| ()));
    let v = a.view().doc.get_map("nodes").get_deep_value();
    let loro::LoroValue::Map(m) = v else { panic!() };
    let loro::LoroValue::Map(c) = &m["c1"] else {
        panic!()
    };
    assert_eq!(c.get("future_field"), Some(&loro::LoroValue::I64(42)));
    assert_eq!(a.view().node(&id).unwrap().title, "改名");
}

#[test]
fn chapters_sort_by_order_then_id_and_ideas_ignore_book_order() {
    let mut a = book(1);
    user(&mut a, |t| {
        chapter(t, "c-b", Some(10.0))?;
        chapter(t, "c-a", Some(10.0))?;
        chapter(t, "c-z", Some(5.0))?;
        chapter(t, "c-none", None)?;
        t.node(&n("d1"))?
            .kind(&NodeKind::Drift)?
            .book_order(Some(1.0))?;
        Ok(())
    });
    let ids: Vec<String> = a
        .view()
        .chapters()
        .into_iter()
        .map(|c| c.id.to_string())
        .collect();
    assert_eq!(ids, vec!["c-z", "c-a", "c-b", "c-none"]);
    let d = a.view().node(&n("d1")).unwrap();
    assert_eq!(d.book_order, None);
    assert_eq!(
        d.status,
        NodeStatus::Drifting,
        "a chapter status on an idea reads as its default"
    );
    assert_eq!(a.view().drifts().len(), 1);
    // Trash hides a chapter from the reading order.
    user(&mut a, |t| {
        t.node(&n("c-a"))?
            .deleted_at(Some(Timestamp(100)))
            .map(|_| ())
    });
    assert_eq!(a.view().chapters().len(), 3);
}

#[test]
fn repair_orders_chapters_identically_on_two_devices() {
    let mut a = book(1);
    user(&mut a, |t| {
        chapter(t, "c1", Some(5.0))?;
        chapter(t, "c3", None)?;
        chapter(t, "c2", None)?;
        t.node(&n("d1"))?
            .kind(&NodeKind::Drift)?
            .book_order(Some(2.0))?;
        Ok(())
    });
    let mut b = book(2);
    sync(&a, &mut b);
    let (pa, ca) = a.repair().unwrap();
    let (pb, cb) = b.repair().unwrap();
    assert_eq!(pa, pb, "the plan is a function of the state");
    assert_eq!(
        pa.chapters_without_order,
        vec![(n("c2"), 10.0), (n("c3"), 15.0)]
    );
    assert_eq!(pa.drifts_with_order, vec![n("d1")]);
    assert_eq!(ca.unwrap().origin, Origin::Repair);
    assert!(cb.is_some());
    sync_both(&mut a, &mut b);
    assert!(a.view().repair_plan().is_empty());
    let ids = |d: &BookDoc| {
        d.view()
            .chapters()
            .into_iter()
            .map(|c| c.id)
            .collect::<Vec<_>>()
    };
    assert_eq!(ids(&a), vec![n("c1"), n("c2"), n("c3")]);
    assert_eq!(ids(&a), ids(&b));
}

#[test]
fn acts_and_pins_drop_bindings_to_missing_ideas() {
    let mut a = book(1);
    let act = ActId::parse("act-1").unwrap();
    let pin = TimePinId::parse("pin-1").unwrap();
    user(&mut a, |t| {
        t.node(&n("d1"))?.kind(&NodeKind::Drift)?;
        t.act(&act)?
            .name("第一幕")?
            .start_order(Some(0.0))?
            .drift(Some(&n("d1")))?;
        t.time_pin(&pin)?
            .narrative_order(12.5)?
            .label("1900年")?
            .drift(Some(&n("gone")))?;
        t.act(&ActId::parse("act-0").unwrap())?
            .name("序")?
            .start_order(None)?;
        Ok(())
    });
    let acts = a.view().acts();
    assert_eq!(acts[0].id.as_str(), "act-0", "the head anchor comes first");
    assert_eq!(acts[1].drift, Some(n("d1")));
    assert_eq!(a.view().time_pins()[0].drift, None);
    user(&mut a, |t| t.purge(Collection::Nodes, "d1"));
    assert_eq!(a.view().acts()[1].drift, None);
}

#[test]
fn primary_storyline_must_be_a_member() {
    let mut a = book(1);
    let s1 = StorylineId::parse("s1").unwrap();
    let s2 = StorylineId::parse("s2").unwrap();
    user(&mut a, |t| {
        t.storyline(&s1)?.name("主线")?;
        t.storyline(&s2)?.name("副线")?;
        chapter(t, "c1", Some(5.0))?;
        t.node(&n("c1"))?
            .add_storyline(&s1)?
            .primary_storyline(Some(&s1))?;
        Ok(())
    });
    assert_eq!(
        a.view().node(&n("c1")).unwrap().primary_storyline,
        Some(s1.clone())
    );
    // Another device removes the membership while this one keeps primary.
    let mut b = book(2);
    sync(&a, &mut b);
    user(&mut b, |t| {
        t.node(&n("c1"))?.remove_storyline(&s1).map(|_| ())
    });
    user(&mut a, |t| t.node(&n("c1"))?.add_storyline(&s2).map(|_| ()));
    sync_both(&mut a, &mut b);
    let c = a.view().node(&n("c1")).unwrap();
    assert_eq!(c.storylines.iter().cloned().collect::<Vec<_>>(), vec![s2]);
    assert_eq!(c.primary_storyline, None);
}

#[test]
fn relations_are_shown_only_when_whole() {
    let mut a = book(1);
    let friend = RelationTypeId::parse("rt-friend").unwrap();
    let rival = RelationTypeId::parse("rt-rival").unwrap();
    let r = |s: &str| RelationId::parse(s).unwrap();
    user(&mut a, |t| {
        element(t, "e1")?;
        element(t, "e2")?;
        element(t, "e3")?;
        t.relation_type(&friend)?
            .name("朋友")?
            .orientation(&RelationOrientation::Symmetric)?
            .source_kinds(&[EntityKind::Element])?
            .target_kinds(&[EntityKind::Element])?;
        t.relation_type(&rival)?
            .name("对手")?
            .orientation(&RelationOrientation::Directed)?
            .source_kinds(&[EntityKind::Element])?
            .target_kinds(&[EntityKind::Element])?;
        let (x, y) = canonical_symmetric(el("e2"), el("e1"));
        t.relation(&r("r1"))?.ends(&x, &y)?.relation_type(&friend)?;
        // The same symmetric edge written the other way round: a duplicate.
        t.relation(&r("r2"))?
            .ends(&el("e2"), &el("e1"))?
            .relation_type(&friend)?;
        // Directed edges in both directions are two edges.
        t.relation(&r("r3"))?
            .ends(&el("e1"), &el("e2"))?
            .relation_type(&rival)?;
        t.relation(&r("r4"))?
            .ends(&el("e2"), &el("e1"))?
            .relation_type(&rival)?;
        t.relation(&r("r5"))?
            .ends(&el("e1"), &el("e2"))?
            .relation_type(&rival)?; // duplicate of r3
        t.relation(&r("r6"))?
            .ends(&el("e1"), &el("gone"))?
            .relation_type(&rival)?;
        t.relation(&r("r7"))?
            .ends(&el("e1"), &el("e3"))?
            .relation_type(&RelationTypeId::parse("nope").unwrap())?;
        t.relation(&r("r8"))?
            .ends(&el("e1"), &el("e1"))?
            .relation_type(&rival)?;
        // A storyline end is not allowed by "rival".
        t.storyline(&StorylineId::parse("s1").unwrap())?
            .name("主线")?;
        t.relation(&r("r9"))?
            .ends(&el("e1"), &EntityRef::new(EntityKind::Storyline, "s1"))?
            .relation_type(&rival)?;
        Ok(())
    });
    let shown: Vec<String> = a
        .view()
        .relations()
        .into_iter()
        .map(|x| x.id.to_string())
        .collect();
    assert_eq!(shown, vec!["r1", "r3", "r4"]);
    assert_eq!(a.view().relations_raw().len(), 9);
    let plan = a.view().repair_plan();
    assert_eq!(plan.duplicate_relations, vec![r("r2"), r("r5")]);
    // A trashed end hides the relation; restoring brings it back.
    user(&mut a, |t| {
        t.element(&ElementId::parse("e2").unwrap())?
            .deleted_at(Some(Timestamp(1)))
            .map(|_| ())
    });
    assert!(a.view().relations().is_empty());
    user(&mut a, |t| {
        t.element(&ElementId::parse("e2").unwrap())?
            .deleted_at(None)
            .map(|_| ())
    });
    assert_eq!(a.view().relations().len(), 3);
    // Two devices repairing converge.
    let mut b = book(2);
    sync(&a, &mut b);
    a.repair().unwrap();
    b.repair().unwrap();
    sync_both(&mut a, &mut b);
    assert_eq!(a.view().relations_raw().len(), 7);
    assert_eq!(a.view().relations(), b.view().relations());
}

#[test]
fn todo_links_through_the_builtin_type() {
    let mut a = book(1);
    let rt = generic_relation_type_id(&bid());
    user(&mut a, |t| {
        element(t, "e1")?;
        t.comment(&CommentId::parse("todo-1").unwrap())?
            .kind(&CommentKind::Todo)?
            .body("查资料")?;
        t.relation(&RelationId::parse("r1").unwrap())?
            .ends(&EntityRef::new(EntityKind::Comment, "todo-1"), &el("e1"))?
            .relation_type(&rt)?;
        // The reverse direction is not what the built-in type allows.
        t.relation(&RelationId::parse("r2").unwrap())?
            .ends(&el("e1"), &EntityRef::new(EntityKind::Comment, "todo-1"))?
            .relation_type(&rt)?;
        Ok(())
    });
    let shown: Vec<String> = a
        .view()
        .relations()
        .into_iter()
        .map(|x| x.id.to_string())
        .collect();
    assert_eq!(shown, vec!["r1"]);
}

#[test]
fn comments_keep_unlocated_targets_and_anchor_into_prose() {
    let mut a = book(1);
    let mut chapter_doc = ProseDoc::create(DocId::Node(n("c1")), 1).unwrap();
    chapter_doc
        .edit(Origin::User, |t| t.insert_text(0, "零一二三四五"))
        .0
        .unwrap();
    let anchor = chapter_doc.view().anchor(1..4).unwrap();
    let c = CommentId::parse("cm-1").unwrap();
    user(&mut a, |t| {
        chapter(t, "c1", Some(5.0))?;
        t.comment(&c)?
            .kind(&CommentKind::Note)?
            .target(Some(&EntityRef::new(EntityKind::Node, "c1")))?
            .target_block(Some(&BlockId::parse("0@1").unwrap()))?
            .anchor(Some(&anchor))?
            .body("这里要改")?
            .priority(Some(&CommentPriority::High))?;
        Ok(())
    });
    let got = a.view().comment(&c).unwrap();
    assert!(!got.target_missing);
    assert_eq!(got.body, "这里要改");
    assert_eq!(got.priority, Some(CommentPriority::High));
    let stored = crate::Anchor::decode(got.anchor.as_ref().unwrap()).unwrap();
    let r = chapter_doc.view().resolve(&stored).unwrap();
    assert_eq!(chapter_doc.view().text_in(r.range).unwrap(), "一二三");
    // The chapter goes to the trash: the comment stays, unlocated.
    user(&mut a, |t| {
        t.node(&n("c1"))?.deleted_at(Some(Timestamp(5))).map(|_| ())
    });
    assert!(a.view().comment(&c).unwrap().target_missing);
    // Unknown kinds read as they were written.
    user(&mut a, |t| {
        t.comment(&c)?
            .kind(&CommentKind::parse("suggestion"))
            .map(|_| ())
    });
    assert_eq!(a.view().comment(&c).unwrap().kind.as_str(), "suggestion");
}

#[test]
fn deleting_a_group_moves_children_and_ideas_up() {
    let mut a = book(1);
    let g = |s: &str| DriftGroupId::parse(s).unwrap();
    user(&mut a, |t| {
        let w = t.drift_groups();
        w.create("top", None, "顶层")?;
        w.create("mid", Some("top"), "中层")?;
        w.create("leaf", Some("mid"), "底层")?;
        t.node(&n("d1"))?
            .kind(&NodeKind::Drift)?
            .group(Some(&g("mid")))?;
        t.node(&n("d2"))?
            .kind(&NodeKind::Drift)?
            .group(Some(&g("leaf")))?;
        // A chapter cannot sit in a group: readers drop it.
        chapter(t, "c1", Some(1.0))?;
        t.node(&n("c1"))?.group(Some(&g("top")))?;
        Ok(())
    });
    let groups = a.view().drift_groups();
    let ids: Vec<(String, Option<String>)> = groups
        .iter()
        .map(|x| (x.id.to_string(), x.parent.as_ref().map(|p| p.to_string())))
        .collect();
    assert_eq!(
        ids,
        vec![
            ("top".into(), None),
            ("mid".into(), Some("top".into())),
            ("leaf".into(), Some("mid".into()))
        ]
    );
    assert_eq!(a.view().node(&n("c1")).unwrap().group, None);
    assert_eq!(a.view().repair_plan().chapters_in_groups, vec![n("c1")]);
    user(&mut a, |t| t.delete_drift_group(&g("mid")));
    let groups = a.view().drift_groups();
    assert_eq!(groups.len(), 2);
    assert_eq!(groups[1].id, g("leaf"));
    assert_eq!(groups[1].parent, Some(g("top")));
    assert_eq!(a.view().node(&n("d1")).unwrap().group, Some(g("top")));
    assert_eq!(a.view().node(&n("d2")).unwrap().group, Some(g("leaf")));
}

#[test]
fn concurrent_moves_never_make_a_cycle_and_missing_groups_read_as_root() {
    let mut a = book(1);
    user(&mut a, |t| {
        let w = t.drift_groups();
        w.create("x", None, "X")?;
        w.create("y", None, "Y")?;
        Ok(())
    });
    let mut b = book(2);
    sync(&a, &mut b);
    user(&mut a, |t| t.drift_groups().move_to("x", Some("y")));
    user(&mut b, |t| t.drift_groups().move_to("y", Some("x")));
    sync_both(&mut a, &mut b);
    let ga = a.view().drift_groups();
    assert_eq!(ga.len(), 2, "no group lost to a cycle: {ga:?}");
    assert!(
        ga.iter().any(|g| g.parent.is_none()),
        "someone is at the root"
    );
    assert_eq!(ga, b.view().drift_groups());
    // An idea in a group that another device deleted reads as at the root.
    user(&mut a, |t| {
        t.node(&n("d1"))?.kind(&NodeKind::Drift)?;
        Ok(())
    });
    sync(&a, &mut b);
    user(&mut b, |t| {
        t.delete_drift_group(&DriftGroupId::parse("x").unwrap())
    });
    user(&mut a, |t| {
        t.node(&n("d1"))?
            .group(Some(&DriftGroupId::parse("x").unwrap()))
            .map(|_| ())
    });
    sync_both(&mut a, &mut b);
    assert_eq!(a.view().node(&n("d1")).unwrap().group, None);
}

#[test]
fn materials_folders_and_assets() {
    let mut a = book(1);
    let img = AssetId::parse("as-1").unwrap();
    let asset = Asset {
        id: img.clone(),
        kind: AssetKind::Image,
        mime: "image/png".into(),
        size: 10,
        sha256: "a".repeat(64),
        width: Some(2),
        height: Some(3),
    };
    let m1 = MaterialId::parse("m1").unwrap();
    let m2 = MaterialId::parse("m2").unwrap();
    user(&mut a, |t| {
        t.put_asset(&asset)?;
        t.material_folders().create("f1", None, "人物")?;
        t.material_folders().create("f2", Some("f1"), "配角")?;
        t.material(&m1)?
            .title("照片")?
            .kind(&MaterialKind::Image)?
            .asset(Some(&img))?
            .folder(Some(&MaterialFolderId::parse("f2").unwrap()))?
            .pos(&PosKey::parse("a2").unwrap())?;
        t.material(&m2)?
            .title("PDF")?
            .kind(&MaterialKind::Pdf)?
            .asset(Some(&img))?
            .pos(&PosKey::parse("a1").unwrap())?;
        Ok(())
    });
    let ms = a.view().materials();
    assert_eq!(ms[0].id, m2);
    assert_eq!(
        ms[0].asset, None,
        "a PDF pointing at an image asset reads as missing"
    );
    assert_eq!(ms[1].asset, Some(img.clone()));
    assert!(ms[1].task_todos, "on by default");
    // Assets are immutable.
    let mut changed = asset.clone();
    changed.size = 11;
    let (r, _) = a.edit(Origin::User, |t| t.put_asset(&changed));
    assert!(matches!(r, Err(DocError::Locked(_))));
    user(&mut a, |t| t.put_asset(&asset));
    // Deleting a folder moves its materials up.
    user(&mut a, |t| {
        t.delete_material_folder(&MaterialFolderId::parse("f2").unwrap())
    });
    assert_eq!(
        a.view().materials()[1].folder,
        Some(MaterialFolderId::parse("f1").unwrap())
    );
    assert!(!a.view().owns_prose(&DocId::Node(n("x"))));
    user(&mut a, |t| {
        t.material(&MaterialId::parse("note").unwrap())?
            .kind(&MaterialKind::Text)?;
        Ok(())
    });
    assert!(a.view().owns_prose(&DocId::parse("material:note").unwrap()));
    assert!(
        !a.view().owns_prose(&DocId::parse("material:m1").unwrap()),
        "images have no prose"
    );
}

#[test]
fn key_value_lists_merge_by_entry_and_skip_empties() {
    let mut a = book(1);
    let mut b = book(2);
    let e = |id: &str, k: &str, v: &str, p: &str| KvEntry {
        id: KvEntryId::parse(id).unwrap(),
        key: k.into(),
        value: v.into(),
        pos: Some(PosKey::parse(p).unwrap()),
    };
    // Both devices import the same entry: one entry.
    user(&mut a, |t| t.put_fact(&e("f1", "视角", "第一人称", "a1")));
    user(&mut b, |t| t.put_fact(&e("f1", "视角", "第一人称", "a1")));
    user(&mut b, |t| t.put_fact(&e("f0", "文风", "冷", "a0V")));
    user(&mut a, |t| t.put_fact(&e("f-empty", "", "", "a0")));
    sync_both(&mut a, &mut b);
    let facts = a.view().facts();
    let keys: Vec<&str> = facts.iter().map(|f| f.key.as_str()).collect();
    assert_eq!(keys, vec!["文风", "视角"]);
    let s = StorylineId::parse("s1").unwrap();
    user(&mut a, |t| {
        t.storyline(&s)?
            .name("主线")?
            .put_fact(&e("k1", "主题", "合成", "a0"))?;
        Ok(())
    });
    assert_eq!(a.view().storylines()[0].facts.len(), 1);
    user(&mut a, |t| {
        t.storyline(&s)?
            .remove_fact(&KvEntryId::parse("k1").unwrap())
            .map(|_| ())
    });
    assert!(a.view().storylines()[0].facts.is_empty());
}

#[test]
fn writing_days_sum_over_devices() {
    let mut a = book(1);
    let mut b = book(2);
    let day = Day::parse("2026-11-07").unwrap();
    let mac = DeviceKey::parse("mac").unwrap();
    let win = DeviceKey::parse("win").unwrap();
    user(&mut a, |t| t.writing_day(&mac, &day, 300));
    user(&mut b, |t| t.writing_day(&win, &day, 200));
    user(&mut a, |t| t.writing_day(&mac, &day, 350));
    sync_both(&mut a, &mut b);
    assert_eq!(a.view().words_on(&day), 550);
    assert_eq!(b.view().writing_days().len(), 2);
}

#[test]
fn plot_grids_skip_orphan_cells_and_clamp_sizes() {
    let mut a = book(1);
    let c = n("c1");
    let r = |s: &str| PlotRowId::parse(s).unwrap();
    let k = |s: &str| PlotColId::parse(s).unwrap();
    user(&mut a, |t| {
        let g = t.plot_grid(&c)?;
        g.cell_w(9999.0)?.cell_h(10.0)?;
        g.row(&r("r1"), "a1", "行一")?.row(&r("r0"), "a0", "行零")?;
        g.col(&k("k1"), "a0", "列一")?;
        g.cell(&r("r1"), &k("k1"), Some("内容"))?;
        g.cell(&r("gone"), &k("k1"), Some("孤儿"))?;
        Ok(())
    });
    let grid = a.view().plot_grid(&c).unwrap();
    assert_eq!((grid.cell_w, grid.cell_h), (440.0, 56.0));
    assert_eq!(
        grid.rows.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(),
        vec!["r0", "r1"]
    );
    assert_eq!(grid.cells.len(), 1);
    user(&mut a, |t| {
        t.plot_grid(&c)?.remove_row(&r("r1")).map(|_| ())
    });
    assert!(a.view().plot_grid(&c).unwrap().cells.is_empty());
}

#[test]
fn events_name_the_entities_that_changed() {
    let mut a = book(1);
    let seen: Arc<Mutex<Vec<BookEvent>>> = Default::default();
    let s2 = seen.clone();
    let _sub = a.subscribe(move |e| s2.lock().unwrap().push(e.clone()));
    user(&mut a, |t| chapter(t, "c1", Some(5.0)));
    user(&mut a, |t| t.node(&n("c1"))?.title("新").map(|_| ()));
    user(&mut a, |t| t.drift_groups().create("g", None, "组"));
    user(&mut a, |t| t.purge(Collection::Nodes, "c1"));
    user(&mut a, |t| t.meta().name("书名").map(|_| ()));
    let ev = seen.lock().unwrap();
    let has = |i: usize, c: Collection, id: Option<&str>| {
        ev[i].changes.contains(&Change {
            collection: c,
            id: id.map(str::to_string),
        })
    };
    assert_eq!(ev.len(), 5);
    assert!(has(0, Collection::Nodes, Some("c1")), "{:?}", ev[0]);
    assert!(has(1, Collection::Nodes, Some("c1")), "{:?}", ev[1]);
    assert!(
        ev[2]
            .changes
            .iter()
            .any(|c| c.collection == Collection::DriftGroups)
    );
    assert!(has(3, Collection::Nodes, Some("c1")), "{:?}", ev[3]);
    assert!(
        ev[4]
            .changes
            .iter()
            .any(|c| c.collection == Collection::Meta)
    );
    assert!(ev.iter().all(|e| e.origin == Some(Origin::User)));
}

#[test]
fn loading_another_books_bytes_fails() {
    let mut a = book(1);
    user(&mut a, |t| t.meta().name("甲").map(|_| ()));
    let snap = a.export_snapshot().unwrap();
    assert!(matches!(
        BookDoc::load(BookId::parse("b2").unwrap(), 3, std::slice::from_ref(&snap)),
        Err(DocError::WrongDocument { .. })
    ));
    let b = BookDoc::load(bid(), 3, &[snap]).unwrap();
    assert_eq!(b.view().meta().name, "甲");
}

#[test]
fn history_copies_are_detached() {
    let mut a = book(1);
    user(&mut a, |t| t.meta().name("旧名").map(|_| ()));
    let f = a.frontiers();
    user(&mut a, |t| t.meta().name("新名").map(|_| ()));
    let old = BookReader::load_at(bid(), &[a.export_snapshot().unwrap()], &f).unwrap();
    assert_eq!(old.view().meta().name, "旧名");
    assert_eq!(a.view().meta().name, "新名");
    assert_eq!(a.reader().view().meta().name, "新名");
}

#[test]
fn references_to_missing_entities_read_as_none() {
    let mut a = book(1);
    let e = ElementId::parse("e1").unwrap();
    let cat = CategoryId::parse("cat").unwrap();
    let pdf = AssetId::parse("pdf").unwrap();
    let s1 = StorylineId::parse("s1").unwrap();
    user(&mut a, |t| {
        t.category(&cat)?.name("人物")?.color("#8B7355")?;
        t.put_asset(&Asset {
            id: pdf.clone(),
            kind: AssetKind::Pdf,
            mime: "application/pdf".into(),
            size: 9,
            sha256: "b".repeat(64),
            width: None,
            height: None,
        })?;
        t.element(&e)?
            .name("安")?
            .category(Some(&cat))?
            .portrait(Some(&pdf))?;
        t.storyline(&s1)?.name("主线")?;
        chapter(t, "c1", Some(5.0))?;
        t.node(&n("c1"))?.add_storyline(&s1)?;
        let p = t.patch(&PatchId::parse("p1").unwrap())?;
        p.element(&e)?
            .source_node(Some(&n("c1")))?
            .source_block(Some(&BlockId::parse("0@9").unwrap()))?;
        t.patch(&PatchId::parse("p-orphan").unwrap())?
            .element(&ElementId::parse("gone").unwrap())?;
        Ok(())
    });
    let x = a.view().element(&e).unwrap();
    assert_eq!(x.category, Some(cat.clone()));
    assert_eq!(x.portrait, None, "a portrait must be an image");
    let patches = a.view().patches();
    assert_eq!(
        patches.len(),
        1,
        "a patch of a missing element is not shown"
    );
    assert!(patches[0].source_block.is_some());
    // The category goes to the trash, the chapter and the storyline are purged.
    user(&mut a, |t| {
        t.category(&cat)?.deleted_at(Some(Timestamp(3)))?;
        t.purge(Collection::Nodes, "c1")?;
        t.purge(Collection::Storylines, "s1")
    });
    assert_eq!(a.view().element(&e).unwrap().category, None);
    let p = &a.view().patches()[0];
    assert_eq!(
        (p.source_node.as_ref(), p.source_block.as_ref()),
        (None, None)
    );
    user(&mut a, |t| chapter(t, "c1", Some(5.0)));
    assert!(
        a.view().node(&n("c1")).unwrap().storylines.is_empty(),
        "the purged storyline's membership is not listed"
    );
}

#[test]
fn a_group_created_on_two_devices_keeps_every_child() {
    // The property test's minimal case: two devices create group g1, one of
    // them puts g0 under its copy, an idea goes into g0. The copies read as
    // one group and g0 stays under it.
    let mut a = book(100);
    let mut c = book(102);
    user(&mut c, |t| {
        t.drift_groups().create("g1", None, "一")?;
        t.drift_groups().create("g0", Some("g1"), "零")
    });
    user(&mut a, |t| t.drift_groups().create("g1", None, "一"));
    user(&mut a, |t| {
        t.node(&n("d0"))?
            .kind(&NodeKind::Drift)?
            .group(Some(&DriftGroupId::parse("g0").unwrap()))?;
        Ok(())
    });
    sync_both(&mut a, &mut c);
    let groups = a.view().drift_groups();
    let ids: Vec<(&str, Option<&str>)> = groups
        .iter()
        .map(|g| (g.id.as_str(), g.parent.as_ref().map(|p| p.as_str())))
        .collect();
    assert_eq!(ids, vec![("g1", None), ("g0", Some("g1"))]);
    assert_eq!(groups, c.view().drift_groups());
    assert_eq!(
        a.view().node(&n("d0")).unwrap().group,
        Some(DriftGroupId::parse("g0").unwrap())
    );
    // Deleting g1 removes both copies and moves g0 and its idea up.
    user(&mut a, |t| {
        t.delete_drift_group(&DriftGroupId::parse("g1").unwrap())
    });
    sync_both(&mut a, &mut c);
    let groups = c.view().drift_groups();
    assert_eq!(groups.len(), 1);
    assert_eq!(
        (groups[0].id.as_str(), groups[0].parent.as_ref()),
        ("g0", None)
    );
}

#[test]
fn colours_targets_and_pins_live_in_the_book() {
    let mut a = book(1);
    let rt = RelationTypeId::parse("rt-friend").unwrap();
    let e = ElementId::parse("e1").unwrap();
    user(&mut a, |t| {
        t.relation_type(&rt)?.name("朋友")?.color(Some("#c0392b"))?;
        t.meta()
            .word_target(Some(200_000))?
            .daily_word_target(Some(0))?;
        t.element(&e)?.name("安")?.relate_pin(Some((12.5, -3.0)))?;
        Ok(())
    });
    let mut b = book(2);
    sync(&a, &mut b);
    assert_eq!(
        b.view().relation_type(&rt).unwrap().color.as_deref(),
        Some("#c0392b")
    );
    let m = b.view().meta();
    assert_eq!(m.word_target(), Some(200_000));
    assert_eq!(m.daily_word_target(), None, "0 turns the daily goal off");
    assert_eq!(b.view().element(&e).unwrap().relate_pin, Some((12.5, -3.0)));
    user(&mut b, |t| t.element(&e)?.relate_pin(None).map(|_| ()));
    assert_eq!(b.view().element(&e).unwrap().relate_pin, None);
    assert_eq!(
        BookView::meta(&book(3).view()).word_target(),
        Some(dr_model::book::DEFAULT_WORD_TARGET)
    );
}

#[test]
fn element_names_stay_unique_on_read_after_a_merge() {
    // Two devices create an element with the same name (and an alias that
    // collides). The one created first keeps the name; the other is flagged.
    let mut a = book(1);
    let mut b = book(2);
    user(&mut a, |t| {
        t.element(&ElementId::parse("e-late").unwrap())?
            .name("安娜")?
            .created_at(Some(Timestamp(200)))?;
        t.element(&ElementId::parse("e-alias").unwrap())?
            .name("Karenina")?
            .add_alias("Anna")?
            .created_at(Some(Timestamp(300)))?;
        Ok(())
    });
    user(&mut b, |t| {
        t.element(&ElementId::parse("e-early").unwrap())?
            .name(" 安娜 ")?
            .add_alias("anna")?
            .created_at(Some(Timestamp(100)))?;
        Ok(())
    });
    sync_both(&mut a, &mut b);
    let early = ElementId::parse("e-early").unwrap();
    let conflicts = a.view().element_name_conflicts();
    assert_eq!(
        conflicts,
        vec![
            (ElementId::parse("e-alias").unwrap(), early.clone()),
            (ElementId::parse("e-late").unwrap(), early.clone()),
        ]
    );
    assert_eq!(a.view().element(&early).unwrap().name_conflict, None);
    assert_eq!(conflicts, b.view().element_name_conflicts());
    // Trashing the winner hands its names to the others: nothing collides now.
    user(&mut a, |t| {
        t.element(&early)?
            .deleted_at(Some(Timestamp(1)))
            .map(|_| ())
    });
    assert!(a.view().element_name_conflicts().is_empty());
}

#[test]
fn projected_todos_are_one_entity_on_every_device() {
    let doc = DocId::Node(n("c1"));
    let block = BlockId::parse("4@9").unwrap();
    let mut a = book(1);
    let mut b = book(2);
    for d in [&mut a, &mut b] {
        user(d, |t| {
            chapter(t, "c1", Some(5.0))?;
            let (_, w) = t.projected_todo(&ProjectionKind::Marker, &doc, &block)?;
            w.body("查一下年代")?;
            Ok(())
        });
    }
    sync_both(&mut a, &mut b);
    let todos: Vec<_> = a
        .view()
        .comments()
        .into_iter()
        .filter(|c| c.is_todo())
        .collect();
    assert_eq!(todos.len(), 1, "both devices projected the same entity");
    let t0 = &todos[0];
    assert_eq!(t0.id.as_str(), "todo:marker:node:c1#4@9");
    assert_eq!(t0.target_block.as_ref(), Some(&block));
    let p = t0.projection.as_ref().unwrap();
    assert_eq!((&p.kind, &p.block), (&ProjectionKind::Marker, &block));
    assert_eq!(a.view().todo_done(&t0.id), Some(false));
    user(&mut b, |t| {
        t.comment(&t0.id)?
            .status(&CommentStatus::Resolved)
            .map(|_| ())
    });
    sync(&b, &mut a);
    assert_eq!(a.view().todo_done(&t0.id), Some(true));
    assert_eq!(a.view().todo_done(&CommentId::parse("nope").unwrap()), None);
}

/// Raise a device's Lamport clock well past anything a seed carries, as a
/// device that has been writing for a while has.
fn busy(d: &mut BookDoc) {
    for i in 0..40 {
        user(d, |t| t.meta().summary(&format!("忙{i}")).map(|_| ()));
    }
}

fn todos(d: &BookDoc) -> Vec<dr_model::book::Comment> {
    d.view()
        .comments()
        .into_iter()
        .filter(|c| c.is_todo())
        .collect()
}

#[test]
fn a_marker_projected_on_two_devices_is_one_todo_with_one_body() {
    let doc = DocId::Node(n("c1"));
    let block = BlockId::parse("4@9").unwrap();
    let mut a = book(1);
    let mut b = book(2);
    busy(&mut b);
    for d in [&mut a, &mut b] {
        user(d, |t| {
            let (_, w) = t.project_todo(&ProjectionKind::Marker, &doc, &block, "查一下年代")?;
            w.source(&CommentSource::Manual)?;
            Ok(())
        });
    }
    sync_both(&mut a, &mut b);
    let ts = todos(&a);
    assert_eq!(ts.len(), 1);
    assert_eq!(ts[0].body, "查一下年代", "not doubled");
    assert_eq!(ts[0].status, CommentStatus::Open);
    assert_eq!(ts[0].target, Some(EntityRef::new(EntityKind::Node, "c1")));
    assert_eq!(format!("{:?}", todos(&b)), format!("{ts:?}"));
    // The two devices wrote the same seed: one change, one peer, in both.
    let seed_peers = |d: &BookDoc| -> Vec<(u64, i32)> {
        d.version()
            .iter()
            .filter(|(p, _)| **p >> 63 == 1 && **p & 1 == 1)
            .map(|(p, c)| (*p, *c))
            .collect()
    };
    assert_eq!(seed_peers(&a).len(), 1);
    assert_eq!(seed_peers(&a), seed_peers(&b));

    // Two devices that read the marker's task differently (one saw a
    // later version of the paragraph): one body, the same everywhere.
    let other = BlockId::parse("5@9").unwrap();
    user(&mut a, |t| {
        t.project_todo(&ProjectionKind::Marker, &doc, &other, "补一场")
            .map(|_| ())
    });
    user(&mut b, |t| {
        t.project_todo(&ProjectionKind::Marker, &doc, &other, "补一场雨")
            .map(|_| ())
    });
    sync_both(&mut a, &mut b);
    let id = CommentId::for_projection(&ProjectionKind::Marker, &doc, &other);
    let body = a.view().comment(&id).unwrap().body;
    assert!(body == "补一场" || body == "补一场雨", "{body}");
    assert_eq!(b.view().comment(&id).unwrap().body, body);
}

#[test]
fn a_late_projection_never_reopens_a_resolved_todo() {
    let doc = DocId::Node(n("c1"));
    let block = BlockId::parse("4@9").unwrap();
    let id = CommentId::for_projection(&ProjectionKind::Marker, &doc, &block);
    // A projects and resolves; B, which has written much more, projects
    // the same marker before it hears of A's TODO.
    let mut a = book(1);
    let mut b = book(2);
    busy(&mut b);
    user(&mut a, |t| {
        t.project_todo(&ProjectionKind::Marker, &doc, &block, "查")?;
        t.comment(&id)?.status(&CommentStatus::Resolved).map(|_| ())
    });
    user(&mut b, |t| {
        t.project_todo(&ProjectionKind::Marker, &doc, &block, "查")
            .map(|_| ())
    });
    sync_both(&mut a, &mut b);
    assert_eq!(a.view().todo_done(&id), Some(true));
    assert_eq!(b.view().todo_done(&id), Some(true));
    // The same with ordinary writes: B's later default wins and the TODO
    // reopens, which is why the projection is a seed.
    let mut a = book(1);
    let mut b = book(2);
    busy(&mut b);
    user(&mut a, |t| {
        t.projected_todo(&ProjectionKind::Marker, &doc, &block)?;
        t.comment(&id)?.status(&CommentStatus::Resolved).map(|_| ())
    });
    user(&mut b, |t| {
        let (_, w) = t.projected_todo(&ProjectionKind::Marker, &doc, &block)?;
        w.status(&CommentStatus::Open).map(|_| ())
    });
    sync_both(&mut a, &mut b);
    assert_eq!(a.view().todo_done(&id), Some(false));
}

#[test]
fn a_todo_projected_again_after_its_marker_came_back_starts_fresh() {
    let doc = DocId::Node(n("c1"));
    let block = BlockId::parse("4@9").unwrap();
    let mut a = book(1);
    let id = user(&mut a, |t| {
        let (id, w) = t.project_todo(&ProjectionKind::Marker, &doc, &block, "旧")?;
        w.body("作者改过")?.priority(Some(&CommentPriority::High))?;
        Ok(id)
    });
    assert_eq!(a.view().comment(&id).unwrap().body, "作者改过");
    // The marker is removed (the TODO deleted), then typed again.
    user(&mut a, |t| t.purge(Collection::Comments, id.as_str()));
    assert!(a.view().comment(&id).is_none());
    user(&mut a, |t| {
        t.project_todo(&ProjectionKind::Marker, &doc, &block, "新")
            .map(|_| ())
    });
    let c = a.view().comment(&id).unwrap();
    assert_eq!((c.body.as_str(), c.priority), ("新", None));
    assert_eq!(c.status, CommentStatus::Open);
    // The same text as the first time: the seed is already in the history,
    // so the TODO comes back as ordinary writes.
    user(&mut a, |t| t.purge(Collection::Comments, id.as_str()));
    user(&mut a, |t| {
        t.project_todo(&ProjectionKind::Marker, &doc, &block, "旧")
            .map(|_| ())
    });
    assert_eq!(a.view().comment(&id).unwrap().body, "旧");
    // Projecting an existing TODO writes nothing.
    let (_, c) = a.edit(Origin::User, |t| {
        t.project_todo(&ProjectionKind::Marker, &doc, &block, "别的")
            .map(|_| ())
    });
    assert!(c.is_none());
    assert_eq!(a.view().comment(&id).unwrap().body, "旧");
    // An edited body replaces the task; an emptied one stays empty.
    user(&mut a, |t| t.comment(&id)?.body("").map(|_| ()));
    assert_eq!(a.view().comment(&id).unwrap().body, "");
}

#[test]
fn a_grid_created_on_two_devices_is_three_by_three_and_keeps_its_labels() {
    let c = n("c1");
    let mut a = book(1);
    let mut b = book(2);
    busy(&mut b);
    let r1 = PlotRowId::default_for(&c, 1);
    // A creates the grid, labels its first row and moves it to the end.
    user(&mut a, |t| {
        t.create_plot_grid(&c)?.row(&r1, "a3", "开端")?;
        Ok(())
    });
    user(&mut b, |t| t.create_plot_grid(&c).map(|_| ()));
    sync_both(&mut a, &mut b);
    let g = a.view().plot_grid(&c).unwrap();
    assert_eq!(
        g.rows.iter().map(|x| x.id.to_string()).collect::<Vec<_>>(),
        ["c1:r2", "c1:r3", "c1:r1"],
        "B's late default does not move it back"
    );
    assert_eq!(
        g.cols.iter().map(|x| x.id.to_string()).collect::<Vec<_>>(),
        ["c1:c1", "c1:c2", "c1:c3"]
    );
    assert_eq!(g.rows[2].label, "开端");
    assert_eq!((g.cell_w, g.cell_h), dr_model::book::PLOT_DEFAULT_CELL);
    assert_eq!(b.view().plot_grid(&c), Some(g));
    // Creating it again leaves it alone.
    let (_, c2) = a.edit(Origin::User, |t| t.create_plot_grid(&c).map(|_| ()));
    assert!(c2.is_none());
}

#[test]
fn comments_keep_what_the_text_was_and_material_regions() {
    let mut a = book(1);
    let c = CommentId::parse("c1").unwrap();
    let r = CommentId::parse("c2").unwrap();
    user(&mut a, |t| {
        t.comment(&c)?
            .quote(Some("被选中的字"))?
            .snapshots(&[
                dr_model::book::BlockSnapshot {
                    block: Some(BlockId::parse("1@1").unwrap()),
                    text: "第一段全文".into(),
                },
                dr_model::book::BlockSnapshot {
                    block: None,
                    text: "第二段".into(),
                },
            ])?
            .agent_conversation(Some("conv-7"))?;
        t.comment(&r)?
            .target(Some(&EntityRef::new(EntityKind::Material, "m1")))?
            .region(Some(
                &dr_model::book::MaterialRegion::new(Some(2), 0.1, 0.2, 0.3, 0.4).unwrap(),
            ))?;
        Ok(())
    });
    let got = a.view().comment(&c).unwrap();
    assert_eq!(got.quote.as_deref(), Some("被选中的字"));
    assert_eq!(got.snapshots.len(), 2);
    assert_eq!(got.snapshots[1].block, None);
    assert_eq!(got.agent_conversation.as_deref(), Some("conv-7"));
    let reg = a.view().comment(&r).unwrap().region.unwrap();
    assert_eq!((reg.page, reg.w), (Some(2), 0.3));
    // A region outside the box (written by something else) reads as none.
    a.edit(Origin::User, |t| {
        let m = t.view.doc.get_map("comments").ensure_mergeable_map("c2")?;
        let bad: Vec<(String, loro::LoroValue)> = vec![
            ("x".into(), 0.9.into()),
            ("y".into(), 0.0.into()),
            ("w".into(), 0.5.into()),
            ("h".into(), 0.1.into()),
        ];
        m.insert("region", loro::LoroValue::Map(bad.into()))?;
        Ok(())
    })
    .0
    .unwrap();
    assert_eq!(a.view().comment(&r).unwrap().region, None);
}

#[test]
fn materials_carry_a_description() {
    let mut a = book(1);
    let m = MaterialId::parse("m1").unwrap();
    user(&mut a, |t| {
        t.material(&m)?
            .kind(&MaterialKind::Text)?
            .description("清末上海的报刊目录")?;
        Ok(())
    });
    let mut b = book(2);
    sync(&a, &mut b);
    user(&mut a, |t| {
        t.material(&m)?
            .description("清末上海的报刊目录（补）")
            .map(|_| ())
    });
    user(&mut b, |t| {
        t.material(&m)?
            .description("晚清上海的报刊目录")
            .map(|_| ())
    });
    sync_both(&mut a, &mut b);
    let d = a.view().materials()[0].description.clone();
    assert_eq!(d, b.view().materials()[0].description);
    assert!(d.contains("上海的报刊目录"), "{d}");
}

#[test]
fn concurrent_reordering_keeps_both_intents() {
    // Numbers renumbered on two devices would interleave; position keys only
    // move the item that moved.
    let s = |i: &str| StorylineId::parse(i).unwrap();
    let mut a = book(1);
    user(&mut a, |t| {
        for (id, k) in [("s1", "a0"), ("s2", "a1"), ("s3", "a2")] {
            t.storyline(&s(id))?
                .name(id)?
                .pos(&PosKey::parse(k).unwrap())?;
        }
        Ok(())
    });
    let mut b = book(2);
    sync(&a, &mut b);
    // A moves s3 to the front; B moves s1 to the end.
    let front = PosKey::between(None, Some(&PosKey::parse("a0").unwrap())).unwrap();
    user(&mut a, |t| t.storyline(&s("s3"))?.pos(&front).map(|_| ()));
    let end = PosKey::parse("a2").unwrap().after();
    user(&mut b, |t| t.storyline(&s("s1"))?.pos(&end).map(|_| ()));
    sync_both(&mut a, &mut b);
    let order = |d: &BookDoc| {
        d.view()
            .storylines()
            .into_iter()
            .map(|x| x.id.to_string())
            .collect::<Vec<_>>()
    };
    assert_eq!(order(&a), vec!["s3", "s2", "s1"]);
    assert_eq!(order(&a), order(&b));
    // Two devices inserting into the same gap get the same key: id breaks the tie.
    let gap = PosKey::between(Some(&front), Some(&PosKey::parse("a1").unwrap())).unwrap();
    user(&mut a, |t| {
        t.storyline(&s("x-a"))?.name("x")?.pos(&gap).map(|_| ())
    });
    user(&mut b, |t| {
        t.storyline(&s("x-b"))?.name("x")?.pos(&gap).map(|_| ())
    });
    sync_both(&mut a, &mut b);
    assert_eq!(order(&a), vec!["s3", "x-a", "x-b", "s2", "s1"]);
}

#[test]
fn restoring_an_entity_writes_its_old_fields_back() {
    let mut a = book(1);
    let e = ElementId::parse("e1").unwrap();
    let kv = |id: &str, k: &str| KvEntry {
        id: KvEntryId::parse(id).unwrap(),
        key: k.into(),
        value: "v".into(),
        pos: Some(PosKey::first()),
    };
    user(&mut a, |t| {
        chapter(t, "c1", Some(5.0))?;
        t.node(&n("c1"))?
            .summary("旧梗概")?
            .status(&NodeStatus::Draft)?;
        t.element(&e)?
            .name("旧名")?
            .add_alias("甲")?
            .put_fact(&kv("f1", "身高"))?;
        Ok(())
    });
    let history = a.frontiers();
    user(&mut a, |t| {
        t.node(&n("c1"))?
            .title("新标题")?
            .summary("新梗概")?
            .status(&NodeStatus::Finished)?;
        t.element(&e)?
            .name("新名")?
            .remove_alias("甲")?
            .add_alias("乙")?
            .put_fact(&kv("f2", "年龄"))?;
        t.element(&ElementId::parse("e2").unwrap())?
            .name("别的要素")?;
        Ok(())
    });
    let old = BookReader::load_at(bid(), &[a.export_snapshot().unwrap()], &history).unwrap();
    let node_then = old.view().entity_snapshot(Collection::Nodes, "c1").unwrap();
    let el_then = old
        .view()
        .entity_snapshot(Collection::Elements, "e1")
        .unwrap();
    assert!(node_then.keys().contains(&"summary".to_string()));
    let (r, c) = a.edit(Origin::User, |t| {
        t.restore_fields(
            Collection::Nodes,
            "c1",
            &node_then,
            metadata_fields(Collection::Nodes),
        )?;
        t.restore_fields(
            Collection::Elements,
            "e1",
            &el_then,
            metadata_fields(Collection::Elements),
        )
    });
    r.unwrap();
    assert!(c.is_some(), "a restore is an ordinary new commit");
    let node = a.view().node(&n("c1")).unwrap();
    assert_eq!(
        (node.title.as_str(), node.summary.as_str()),
        ("c1", "旧梗概")
    );
    assert_eq!(node.status, NodeStatus::Draft);
    let el = a.view().element(&e).unwrap();
    assert_eq!(el.name, "旧名");
    assert_eq!(
        el.aliases.iter().cloned().collect::<Vec<_>>(),
        vec!["甲".to_string()]
    );
    assert_eq!(
        el.facts.iter().map(|f| f.key.as_str()).collect::<Vec<_>>(),
        vec!["身高"]
    );
    // The rest of the book is not reverted.
    assert!(a.view().element(&ElementId::parse("e2").unwrap()).is_some());
    // The built-in type cannot be restored over.
    let rt_snap = old
        .view()
        .entity_snapshot(
            Collection::RelationTypes,
            generic_relation_type_id(&bid()).as_str(),
        )
        .unwrap();
    let (r, _) = a.edit(Origin::User, |t| {
        t.restore_fields(
            Collection::RelationTypes,
            generic_relation_type_id(&bid()).as_str(),
            &rt_snap,
            &["name"],
        )
    });
    assert!(matches!(r, Err(DocError::Locked(_))));
}

#[test]
fn book_transactions_on_a_borrowed_document() {
    let raw = loro::LoroDoc::new();
    crate::schema::configure(&raw);
    raw.import(&genesis(&bid())).unwrap();
    raw.set_peer_id(7).unwrap();
    let reader = BookReader::from_loro(bid(), &raw).unwrap();
    {
        let b = BorrowedBook::new(&raw, &bid()).unwrap();
        let mut t = b.txn();
        chapter(&mut t, "c1", Some(5.0)).unwrap();
        element(&mut t, "e1").unwrap();
    }
    raw.commit_with(loro::CommitOptions::new().origin("user"));
    assert_eq!(
        reader.view().chapters().len(),
        1,
        "the reader shares the holder's document"
    );
    assert!(
        reader
            .view()
            .element(&ElementId::parse("e1").unwrap())
            .is_some()
    );
    assert!(matches!(
        BorrowedBook::new(&raw, &BookId::parse("b2").unwrap()),
        Err(DocError::WrongDocument { .. })
    ));
    assert!(matches!(
        BorrowedBook::new(&loro::LoroDoc::new(), &bid()),
        Err(DocError::NotInitialized(_))
    ));
}

#[test]
fn per_object_reads_match_the_whole_book_reads() {
    let mut a = book(1);
    let rt = RelationTypeId::parse("rt").unwrap();
    user(&mut a, |t| {
        t.relation_type(&rt)?
            .name("对手")?
            .orientation(&RelationOrientation::Directed)?
            .source_kinds(&[EntityKind::Element])?
            .target_kinds(&[EntityKind::Element])?;
        for e in ["e1", "e2", "e3"] {
            element(t, e)?;
        }
        t.relation(&RelationId::parse("r1").unwrap())?
            .ends(&el("e1"), &el("e2"))?
            .relation_type(&rt)?;
        t.relation(&RelationId::parse("r2").unwrap())?
            .ends(&el("e3"), &el("e1"))?
            .relation_type(&rt)?;
        t.relation(&RelationId::parse("r3").unwrap())?
            .ends(&el("e2"), &el("e3"))?
            .relation_type(&rt)?;
        t.patch(&PatchId::parse("p1").unwrap())?
            .element(&ElementId::parse("e1").unwrap())?;
        t.comment(&CommentId::parse("c1").unwrap())?
            .target(Some(&el("e2")))?;
        Ok(())
    });
    let v = a.view();
    let of = |id: &str| {
        v.relations_of(&el(id))
            .into_iter()
            .map(|r| r.id.to_string())
            .collect::<Vec<_>>()
    };
    assert_eq!(of("e1"), vec!["r1", "r2"]);
    assert_eq!(of("e3"), vec!["r2", "r3"]);
    let all: Vec<String> = v
        .relations()
        .into_iter()
        .map(|r| r.id.to_string())
        .collect();
    assert_eq!(all, vec!["r1", "r2", "r3"]);
    assert!(v.entity_exists(&EntityRef::new(EntityKind::Patch, "p1")));
    assert!(v.entity_exists(&EntityRef::new(EntityKind::Comment, "c1")));
    assert!(!v.entity_exists(&EntityRef::new(EntityKind::Node, "nope")));
    assert!(!v.entity_exists(&EntityRef::new(EntityKind::parse("future"), "e1")));
    user(&mut a, |t| {
        t.element(&ElementId::parse("e2").unwrap())?
            .deleted_at(Some(Timestamp(1)))
            .map(|_| ())
    });
    let v = a.view();
    assert!(!v.entity_exists(&el("e2")));
    assert_eq!(of_ids(v.relations_of(&el("e1"))), vec!["r2"]);
    assert!(
        v.comment(&CommentId::parse("c1").unwrap())
            .unwrap()
            .target_missing
    );
    user(&mut a, |t| t.purge(Collection::Elements, "e1"));
    assert!(
        !a.view()
            .entity_exists(&EntityRef::new(EntityKind::Patch, "p1")),
        "a patch needs its element"
    );
}

fn of_ids(v: Vec<dr_model::book::Relation>) -> Vec<String> {
    v.into_iter().map(|r| r.id.to_string()).collect()
}

#[test]
fn snapshots_expose_fields_and_their_differences() {
    let mut a = book(1);
    let e = ElementId::parse("e1").unwrap();
    user(&mut a, |t| {
        t.element(&e)?.name("旧")?.summary("同").map(|_| ())
    });
    let before = a
        .view()
        .entity_snapshot(Collection::Elements, "e1")
        .unwrap();
    user(&mut a, |t| {
        t.element(&e)?
            .name("新")?
            .add_alias("甲")?
            .group_name(None)
            .map(|_| ())
    });
    let after = a
        .view()
        .entity_snapshot(Collection::Elements, "e1")
        .unwrap();
    assert_eq!(before.field("name"), Some(&loro::LoroValue::from("旧")));
    let d = before.diff(&after);
    let keys: Vec<&str> = d.iter().map(|(k, _, _)| k.as_str()).collect();
    assert_eq!(keys, vec!["aliases", "name"]);
    assert_eq!(d[1].1, Some(loro::LoroValue::from("旧")));
    assert_eq!(d[1].2, Some(loro::LoroValue::from("新")));
    assert!(d[0].1.is_none());
    assert!(before.diff(&before).is_empty());
}

#[test]
fn needs_repair_agrees_with_the_plan() {
    let mut a = book(1);
    assert!(!a.view().needs_repair());
    user(&mut a, |t| chapter(t, "c1", None));
    assert!(a.view().needs_repair());
    let (plan, c) = a.repair().unwrap();
    assert!(!plan.is_empty() && c.is_some());
    assert!(!a.view().needs_repair());
    let (plan, c) = a.repair().unwrap();
    assert!(plan.is_empty() && c.is_none(), "nothing to do: no commit");
}

#[test]
fn a_template_belongs_to_its_category_or_storyline() {
    let mut a = book(1);
    let c = CategoryId::parse("cat").unwrap();
    let doc = TemplateOwner::Category(c.clone()).doc_id();
    assert!(!a.view().owns_prose(&doc));
    user(&mut a, |t| t.category(&c)?.name("人物").map(|_| ()));
    assert!(a.view().owns_prose(&doc));
    let s = StorylineId::parse("s").unwrap();
    assert!(!a.view().owns_prose(&TemplateOwner::Storyline(s).doc_id()));
}

/// JSON-FIELDS: a storyline's chapter template, a category's element
/// template, a comment's metadata and a material's provenance (the old
/// `*_json` columns) are one value each. dr-doc stores what it is given
/// without checking it (F3 checks before writing; readers treat what does
/// not parse as nothing), and two devices writing two documents at once
/// end with one of them whole on both, never a splice of the two (a text
/// merge would make broken JSON of two valid ones).
#[test]
fn json_fields_are_kept_whole() {
    let line = StorylineId::parse("s1").unwrap();
    let cat = CategoryId::parse("c1").unwrap();
    let cm = CommentId::parse("cm1").unwrap();
    let m = MaterialId::parse("m1").unwrap();
    let write = |d: &mut BookDoc, v: &str| {
        user(d, |t| {
            t.storyline(&line)?
                .name("主线")?
                .chapter_template(Some(v))?;
            t.category(&cat)?.name("人物")?.element_template(Some(v))?;
            t.comment(&cm)?
                .kind(&CommentKind::Todo)?
                .metadata(Some(v))?;
            t.material(&m)?
                .kind(&MaterialKind::Text)?
                .provenance(Some(v))?;
            Ok(())
        })
    };
    let read = |d: &BookDoc| {
        let v = d.view();
        [
            v.storylines()[0].chapter_template.clone(),
            v.categories()[0].element_template.clone(),
            v.comment(&cm).unwrap().metadata,
            v.materials()[0].provenance.clone(),
        ]
    };
    let mut a = book(1);
    write(&mut a, "not json {");
    assert_eq!(
        read(&a),
        std::array::from_fn(|_| Some("not json {".to_string()))
    );
    let mut b = book(2);
    sync(&a, &mut b);
    let ja = r#"{"type":"doc","content":[{"type":"paragraph"}]}"#;
    let jb = r#"{"kind":"todo-autoparse","prose_vv":{"7":3}}"#;
    write(&mut a, ja);
    write(&mut b, jb);
    sync_both(&mut a, &mut b);
    let got = read(&a);
    assert_eq!(got, read(&b));
    for v in got {
        let v = v.unwrap();
        assert!(v == ja || v == jb, "one write, whole: {v}");
        serde_json::from_str::<serde_json::Value>(&v).unwrap();
    }
    user(&mut a, |t| {
        t.storyline(&line)?.chapter_template(None)?;
        Ok(())
    });
    assert_eq!(read(&a)[0], None, "cleared");
}

/// A conversation belongs to its book like the book document does (storage
/// records which book): never an orphan to clean up. Only the book's text
/// projects TODOs, not the book document, a template or a conversation.
#[test]
fn conversations_belong_to_the_book_and_project_no_todos() {
    let mut a = book(1);
    let conversation = DocId::Conversation(ConversationId::parse("cv1").unwrap());
    assert!(a.view().owns_prose(&conversation));
    let block = BlockId::parse("b@1").unwrap();
    let cat = CategoryId::parse("c").unwrap();
    let before = a.version();
    for doc in [
        conversation,
        TemplateOwner::Category(cat).doc_id(),
        DocId::Book(bid()),
    ] {
        let (r, _) = a.edit(Origin::User, |t| {
            t.project_todo(&ProjectionKind::Marker, &doc, &block, "任务")
                .map(|_| ())
        });
        assert!(matches!(r, Err(DocError::NotInProfile(_))), "{doc}");
        let (r, _) = a.edit(Origin::User, |t| {
            t.projected_todo(&ProjectionKind::Marker, &doc, &block)
                .map(|_| ())
        });
        assert!(matches!(r, Err(DocError::NotInProfile(_))), "{doc}");
    }
    assert_eq!(a.version(), before, "nothing written");
    assert!(a.view().comments().is_empty());
}
