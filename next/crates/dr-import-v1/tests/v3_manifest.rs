//! K3 first half: expected v3 data derived only from the synthetic old DB.
//! No v3 writer, dr-store library or new document is opened by these tests.

mod common;
// The common fixture is also used by dr-view-import, which does not need
// this read-only oracle or its serde derives.
#[path = "common/v3_manifest.rs"]
mod manifest;

use common::v3_fixture as fixture;
use common::*;
use manifest::*;
use rusqlite::Connection;

fn read(old: &Old) -> Manifest {
    manifest::read(&old.db, BOOK).unwrap()
}

fn leaf<'a>(m: &'a Manifest, entry: &Entry) -> &'a Leaf {
    m.leaves.iter().find(|l| &l.entry == entry).unwrap()
}

fn level<'a>(m: &'a Manifest, entry: &Entry) -> &'a Level {
    m.levels.iter().find(|l| &l.entry == entry).unwrap()
}

#[test]
fn every_mapping_row_has_a_nonempty_fixture_and_pinned_totals() {
    let old = fixture::build();
    let m = read(&old);
    assert_eq!(
        m.counts(),
        Counts {
            levels: 16,
            leaves: 9,
            leaf_templates: 5,
            memberships: 8,
            primaries: 3,
            lanes: 4,
            placements: 5,
            pins: 2,
            patches: 1,
            plot_grids: 1,
            notes: 3,
            todos: 2,
            existing_relations: 4,
            materials: 2,
            folders: 1,
            assets: 1,
            memory: 1,
            writing_days: 1,
        }
    );
    // These are author data too, outside the old prose cache tables.
    assert_eq!(m.source_rows["plot_grid_row"].len(), 2);
    assert_eq!(m.source_rows["plot_grid_column"].len(), 1);
    assert_eq!(m.source_rows["plot_grid_cell"][0]["value"], "一张纸条");
    assert_eq!(m.source_rows["entity_relation_type"].len(), 3);
    assert_eq!(m.source_rows["entity_relation_type_endpoint_kind"].len(), 4);
    assert_eq!(m.source_rows["entity_kv_entry"].len(), 8);
    assert_eq!(m.settings.word_target, Some(80000));
    assert_eq!(m.settings.daily_word_target, Some(0));
    assert_eq!(m.settings.relation_type_colors[REL_TYPE], "#aa5500");
    assert_eq!(m.source_rows["agent_memory"][0]["target_block_id"], "q");
    assert_eq!(m.source_rows["writing_day"][0]["device_key"], DEVICE_KEY);
    // Known policy gaps are kept separate from the calculable data.
    assert_eq!(
        m.pending
            .iter()
            .map(|p| p.code.as_str())
            .collect::<Vec<_>>(),
        ["project-storyline-field-template-destination"]
    );
}

#[test]
fn manuscript_order_and_nested_homes_do_not_come_from_timeline_positions() {
    let old = fixture::build();
    let m = read(&old);
    for (node, home, order) in [
        (fixture::CHAPTER_BEFORE, Entry::Manuscript, Some(-5.)),
        (CHAPTER, Entry::Act("act-1".into()), Some(5.)),
        (
            fixture::CHAPTER_UNPLACED,
            Entry::Act("act-1".into()),
            Some(12.),
        ),
        (
            fixture::CHAPTER_UNAFFILIATED,
            Entry::Act("act-2".into()),
            Some(25.),
        ),
        (IDEA, Entry::IdeaGroup(SUBGROUP.into()), None),
        (fixture::IDEA_LINKED, Entry::IdeaGroup(GROUP.into()), None),
    ] {
        let l = leaf(&m, &Entry::Node(node.into()));
        assert_eq!(l.home, Some(home));
        assert_eq!(l.order, order);
    }
    assert_eq!(level(&m, &Entry::Act("act-1".into())).title, "第一幕");
    assert_eq!(
        level(&m, &Entry::Act("act-1".into())).color.as_deref(),
        Some("#aa0000")
    );
    assert_eq!(level(&m, &Entry::Act("act-2".into())).order, Some(20.));
    assert_eq!(
        level(&m, &Entry::IdeaGroup(SUBGROUP.into())).parent,
        Some(Entry::IdeaGroup(GROUP.into()))
    );
    assert_eq!(
        level(&m, &Entry::IdeaGroup(GROUP.into())).parent,
        Some(Entry::Ideas)
    );
    assert_eq!(
        leaf(&m, &Entry::Node(IDEA.into())).layout,
        Some(Layout::Board(120.5, -40.))
    );
    assert_eq!(level(&m, &Entry::ActTrack).title, "幕");
    assert_eq!(level(&m, &Entry::ActTrack).parent, None);
    assert!(level(&m, &Entry::ActTrack).lane);
    assert_eq!(
        level(&m, &Entry::ActTrack).default_leaf,
        Some(LeafTemplate::Idea)
    );
    assert_eq!(m.default_view.act_tracks, [Entry::ActTrack]);
    let act2_leaf = leaf(
        &m,
        &Entry::ActLeaf {
            act: "act-2".into(),
            synthetic_rank: 0,
        },
    );
    assert_eq!(act2_leaf.title, "第二幕");
    assert_eq!(act2_leaf.home, Some(Entry::ActTrack));
    assert_eq!(act2_leaf.template, Some(LeafTemplate::Idea));
    assert!(!m.default_view.book_order_view);
    assert!(!m.default_view.act_rail);
    assert_eq!(m.retired_timeline_view.as_deref(), Some("book"));
}

#[test]
fn category_templates_fields_groups_and_prose_keep_the_authored_values() {
    let old = fixture::build();
    let m = read(&old);
    let cat = level(&m, &Entry::Category(CATEGORY.into()));
    assert_eq!(
        cat.default_leaf,
        Some(LeafTemplate::Category(CATEGORY.into()))
    );
    assert_eq!(
        cat.layout,
        Some(Layout::Grid {
            mode: "pinned".into(),
            x: Some(4),
            y: Some(-2)
        })
    );
    let template = m
        .leaf_templates
        .iter()
        .find(|t| t.template == LeafTemplate::Category(CATEGORY.into()))
        .unwrap();
    assert_eq!(
        template.fields,
        [Field {
            old_id: "kv-7".into(),
            name: "年龄".into(),
            value: "".into()
        }]
    );
    assert_eq!(template.initial_body.as_deref(), Some(CATEGORY_TEMPLATE));
    assert_eq!(
        template.field_projection.as_deref(),
        Some(r#"[{"key":"年龄","value":""}]"#)
    );
    // Even a category with no initial body has its own leaf template.
    assert!(
        m.leaf_templates
            .iter()
            .any(|t| t.template == LeafTemplate::Category(fixture::CATEGORY_OTHER.into()))
    );
    let e = leaf(&m, &Entry::Element(ELEMENT.into()));
    assert_eq!(
        e.home,
        Some(Entry::ElementGroup {
            category: CATEGORY.into(),
            name: "同行".into()
        })
    );
    assert_eq!(e.template, Some(LeafTemplate::Category(CATEGORY.into())));
    assert_eq!(
        e.fields,
        [Field {
            old_id: "kv-8".into(),
            name: "年龄".into(),
            value: "35".into()
        }]
    );
    assert_eq!(
        e.kv.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(),
        ["住处", "职业"]
    );
    assert_eq!(e.aliases, ["阿贵", "阿桂"]);
    assert_eq!(e.summary, "主人公");
    assert_eq!(e.portrait.as_deref(), Some(ASSET));
    assert_eq!(e.layout, Some(Layout::Graph(12.5, -40.)));
    let other = leaf(&m, &Entry::Element(fixture::ELEMENT_OTHER.into()));
    assert_eq!(
        other.home,
        Some(Entry::ElementGroup {
            category: fixture::CATEGORY_OTHER.into(),
            name: "同行".into()
        })
    );
    assert_ne!(e.home, other.home);
    assert!(m.prose.iter().any(
        |p| p.target == Body::About(Entry::Category(CATEGORY.into()))
            && p.json.as_deref() == Some(STORYLINE_JSON)
    ));
    assert!(
        m.prose
            .iter()
            .any(|p| p.target == Body::Leaf(Entry::Element(ELEMENT.into()))
                && p.json.as_deref() == Some(ELEMENT_JSON))
    );
}

#[test]
fn memberships_keep_primary_and_one_position_per_entry_in_multiple_lanes() {
    let old = fixture::build();
    let m = read(&old);
    assert_eq!(
        m.default_view.lanes,
        [
            Entry::ActTrack,
            Entry::Storyline(fixture::STORYLINE_OTHER.into()),
            Entry::Storyline(STORYLINE.into()),
            Entry::Unaffiliated
        ]
    );
    assert_eq!(
        level(&m, &Entry::Storyline(STORYLINE.into())).default_leaf,
        Some(LeafTemplate::Storyline(STORYLINE.into()))
    );
    assert_eq!(
        level(&m, &Entry::Storyline(fixture::STORYLINE_OTHER.into())).default_leaf,
        Some(LeafTemplate::Chapter)
    );
    let template = m
        .leaf_templates
        .iter()
        .find(|t| t.template == LeafTemplate::Storyline(STORYLINE.into()))
        .unwrap();
    assert_eq!(template.initial_body.as_deref(), Some(STORYLINE_TEMPLATE));
    // Existing chapters do not silently change to the lane's new template.
    assert_eq!(
        leaf(&m, &Entry::Node(CHAPTER.into())).template,
        Some(LeafTemplate::Chapter)
    );
    let members: Vec<_> = m
        .memberships
        .iter()
        .filter(|m| m.member == Entry::Node(CHAPTER.into()))
        .collect();
    assert_eq!(members.len(), 2);
    assert!(
        members
            .iter()
            .any(|m| m.level == Entry::Storyline(STORYLINE.into()) && m.primary)
    );
    assert!(
        members
            .iter()
            .any(|m| m.level == Entry::Storyline(fixture::STORYLINE_OTHER.into()) && !m.primary)
    );
    let positions = &m.default_view.placements;
    assert_eq!(
        positions
            .iter()
            .filter(|p| p.entry == Entry::Node(CHAPTER.into()))
            .count(),
        1
    );
    assert!(positions.iter().any(
        |p| p.entry == Entry::Node(fixture::CHAPTER_UNAFFILIATED.into())
            && p.at == 18.25
            && p.span.is_none()
    ));
    assert!(
        positions
            .iter()
            .any(|p| p.entry == Entry::Node(IDEA.into()) && p.at == 12.)
    );
    assert!(
        positions
            .iter()
            .any(|p| p.entry == Entry::Node(fixture::IDEA_LINKED.into()) && p.at == 21.75)
    );
    for node in [IDEA, fixture::CHAPTER_UNAFFILIATED] {
        assert!(m.memberships.contains(&Membership {
            member: Entry::Node(node.into()),
            level: Entry::Unaffiliated,
            primary: false
        }));
    }
    for node in [fixture::CHAPTER_BEFORE, fixture::CHAPTER_UNPLACED] {
        assert!(
            !positions
                .iter()
                .any(|p| p.entry == Entry::Node(node.into()))
        );
    }
    assert_eq!(level(&m, &Entry::Unaffiliated).title, "未归属");
    // Author settled 11-11 (#23): placed under Storylines with Chapter default leaf.
    assert_eq!(
        level(&m, &Entry::Unaffiliated).parent,
        Some(Entry::Storylines)
    );
    assert_eq!(
        level(&m, &Entry::Unaffiliated).default_leaf,
        Some(LeafTemplate::Chapter)
    );
    assert!(m.default_view.pins.contains(&Pin {
        old_id: "pin-1".into(),
        at: 11.5,
        label: "那年秋天".into(),
        color: None,
        entry: Some(Entry::Node(IDEA.into()))
    }));
    assert!(
        m.default_view
            .pins
            .iter()
            .any(|p| p.old_id == "pin-2" && p.entry.is_none() && p.at == 6.25)
    );
}

#[test]
fn retained_data_includes_targets_rich_json_anchors_and_grid_keys() {
    let old = fixture::build();
    let m = read(&old);
    assert_eq!(
        m.patches,
        [Patch {
            old_id: PATCH.into(),
            owner: Entry::Element(ELEMENT.into()),
            source: Some(Body::Leaf(Entry::Node(CHAPTER.into())))
        }]
    );
    assert_eq!(
        m.plot_grids,
        [PlotGrid {
            old_id: "pg".into(),
            entry: Entry::Node(CHAPTER.into())
        }]
    );
    assert_eq!(m.source_rows["plot_grid_row"][1]["position_key"], "a1");
    assert_eq!(m.source_rows["element_patch"][0]["source_block_id"], "q2");
    assert_eq!(
        m.source_rows["element_patch"][0]["text_anchor_json"],
        r#"{"startBlockId":"q2","startOffset":0,"endBlockId":"q2","endOffset":2,"text":"引文"}"#
    );
    assert!(m.comments.iter().any(|c| c.old_id == COMMENT
        && c.target == Some(Endpoint::Entry(Entry::Node(CHAPTER.into())))
        && c.body == Some(Body::Leaf(Entry::Node(CHAPTER.into())))));
    assert!(m.comments.iter().any(|c| c.old_id == NOTE_TODO
        && c.kind == "todo"
        && c.body == Some(Body::Material(NOTE.into()))));
    assert!(m.comments.iter().any(|c| c.old_id == "region-1"
        && c.target == Some(Endpoint::Material(IMAGE.into()))
        && c.body.is_none()));
    assert!(m.relations.iter().any(|r| r.old_id == "rel-material"
        && r.from == Endpoint::Material(NOTE.into())
        && r.to == Endpoint::Entry(Entry::Node(CHAPTER.into()))));
    assert!(m.relations.iter().any(|r| r.old_id == "rel-patch"
        && r.from == Endpoint::Patch(PATCH.into())
        && r.to == Endpoint::Entry(Entry::Storyline(STORYLINE.into()))));
    assert!(
        m.relations
            .iter()
            .any(|r| r.old_id == "rel-2" && r.from == Endpoint::Comment(NOTE_TODO.into()))
    );
    assert!(
        m.prose.iter().any(
            |p| p.target == Body::Material(NOTE.into()) && p.json.as_deref() == Some(NOTE_JSON)
        )
    );
    assert!(
        m.prose
            .iter()
            .any(|p| p.target == Body::Leaf(Entry::Node(CHAPTER.into()))
                && p.json.as_deref() == Some(CHAPTER_JSON))
    );
    assert_eq!(
        m.source_rows["project_asset"][0]["source_sha256"],
        sha256_bytes(IMAGE_BYTES)
    );
    assert_eq!(
        std::fs::read(
            old.root
                .join("assets")
                .join(BOOK)
                .join(ASSET)
                .join("source.png")
        )
        .unwrap(),
        IMAGE_BYTES
    );
}

#[test]
fn manifest_reads_the_source_instead_of_returning_fixed_fixture_counts() {
    let old = fixture::build();
    let before = read(&old);
    let c = Connection::open(&old.db).unwrap();
    c.execute(
        "DELETE FROM book_node WHERE id = ?1",
        [fixture::CHAPTER_UNAFFILIATED],
    )
    .unwrap();
    c.execute(
        "UPDATE book_node SET narrative_order = NULL WHERE id = ?1",
        [IDEA],
    )
    .unwrap();
    drop(c);
    let after = read(&old);
    assert_eq!(after.counts().leaves, before.counts().leaves - 1);
    assert_eq!(after.counts().levels, before.counts().levels - 1);
    assert_eq!(after.counts().lanes, 3);
    assert_eq!(after.counts().memberships, 6);
    assert_eq!(after.counts().placements, 3);
    assert!(after.default_view.placements.contains(&Placement {
        entry: Entry::Node(IDEA.into()),
        at: 10.,
        span: Some(4.),
    }));
    assert!(!after.default_view.placements.iter().any(|p| p.entry
        == Entry::ActLeaf {
            act: "act-2".into(),
            synthetic_rank: 0
        }));
    assert!(
        !after
            .pending
            .iter()
            .any(|p| p.code == "synthetic-lane-tree-home-and-template-settings")
    );
}

#[test]
fn unresolved_data_is_reported_without_inventing_homes_or_dropping_rows() {
    let old = fixture::build();
    let c = Connection::open(&old.db).unwrap();
    c.pragma_update(None, "foreign_keys", false).unwrap();
    c.execute(
        "UPDATE element SET category_id = NULL WHERE id = ?1",
        [ELEMENT],
    )
    .unwrap();
    c.execute(
        "UPDATE drift_group SET parent_group_id = id WHERE id = ?1",
        [GROUP],
    )
    .unwrap();
    c.execute("UPDATE book_act SET start_order = 0 WHERE id = 'act-2'", [])
        .unwrap();
    c.execute("DELETE FROM storylines WHERE id = ?1", [STORYLINE])
        .unwrap();
    drop(c);
    let m = read(&old);
    for code in [
        "element-without-category",
        "level-cycle",
        "duplicate-act-boundary",
        "dangling-membership",
    ] {
        assert!(
            m.pending.iter().any(|p| p.code == code),
            "{code}: {:?}",
            m.pending
        );
    }
    assert_eq!(m.leaves.len(), 9);
    assert_eq!(m.source_rows["element"].len(), 2);
    assert!(leaf(&m, &Entry::Element(ELEMENT.into())).home.is_none());
    assert!(leaf(&m, &Entry::Node(CHAPTER.into())).home.is_none());
    assert_eq!(
        level(&m, &Entry::IdeaGroup(GROUP.into())).parent,
        Some(Entry::IdeaGroup(GROUP.into()))
    );
}

#[test]
fn reading_is_repeatable_book_scoped_and_does_not_write_any_file() {
    let old = fixture::build();
    let c = Connection::open(&old.db).unwrap();
    c.execute("INSERT INTO project (id, name, summary, user_id, created_at, updated_at) VALUES ('another-book', '另一合成书', '', 'local', ?1, ?1)", [T0]).unwrap();
    c.execute("INSERT INTO book_act (id, project_id, name, start_order, created_at, updated_at) VALUES ('other-act', 'another-book', '另一幕', 0, ?1, ?1)", [T0]).unwrap();
    c.execute("INSERT INTO book_node (id, project_id, title, kind, book_order, position_x, position_y, created_at, updated_at) VALUES ('other-node', 'another-book', '另一章', 'chapter', 1, 0, 0, ?1, ?1)", [T0]).unwrap();
    drop(c);
    fn files(dir: &std::path::Path) -> Vec<(std::path::PathBuf, Vec<u8>, std::time::SystemTime)> {
        let mut out = vec![];
        for e in std::fs::read_dir(dir).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                out.extend(files(&p));
            } else {
                out.push((
                    p.clone(),
                    std::fs::read(&p).unwrap(),
                    std::fs::metadata(&p).unwrap().modified().unwrap(),
                ));
            }
        }
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }
    let before = files(old.dir.path());
    let m = read(&old);
    assert_eq!(m, read(&old));
    assert_eq!(m.counts().levels, 16);
    assert_eq!(m.counts().leaves, 9);
    assert!(
        !m.source_rows["book_node"]
            .iter()
            .any(|r| r["id"] == "other-node")
    );
    assert_eq!(before, files(old.dir.path()));
    // Baseline v2 fixture is deliberately still the old, smaller corpus (plus synthetic act leaf).
    let baseline = common::build(true);
    assert_eq!(
        manifest::read(&baseline.db, BOOK).unwrap().counts().leaves,
        4
    );
}

#[test]
fn duplicate_field_values_remain_visible_and_unreadable_templates_are_pending() {
    let old = fixture::build();
    let c = Connection::open(&old.db).unwrap();
    c.execute("INSERT INTO entity_kv_entry (id, project_id, owner_kind, owner_id, namespace, key, value) VALUES ('duplicate-template-field', ?1, 'element-category', ?2, 'element-template', '年龄', '')", rusqlite::params![BOOK, CATEGORY]).unwrap();
    c.execute("INSERT INTO entity_kv_entry (id, project_id, owner_kind, owner_id, namespace, key, value) VALUES ('duplicate-value', ?1, 'element', ?2, 'facts', '年龄', '36')", rusqlite::params![BOOK, ELEMENT]).unwrap();
    c.execute(
        "UPDATE storylines SET node_content_template_json = '{broken' WHERE id = ?1",
        [STORYLINE],
    )
    .unwrap();
    drop(c);
    let m = read(&old);
    for code in [
        "duplicate-category-field-name",
        "multiple-values-for-one-field",
        "unreadable-storyline-template",
    ] {
        assert!(m.pending.iter().any(|p| p.code == code), "{code}");
    }
    assert_eq!(
        leaf(&m, &Entry::Element(ELEMENT.into()))
            .fields
            .iter()
            .map(|f| f.value.as_str())
            .collect::<Vec<_>>(),
        ["35", "36"]
    );
    assert!(
        level(&m, &Entry::Storyline(STORYLINE.into()))
            .default_leaf
            .is_none()
    );
    assert!(
        m.source_rows["storylines"]
            .iter()
            .any(|r| r["id"] == STORYLINE && r["node_content_template_json"] == "{broken")
    );
    assert!(!nonempty_body("{}").unwrap());
    assert!(!nonempty_body(r#"{"type":"doc","content":[{"type":"paragraph"}]}"#).unwrap());
    assert!(nonempty_body(STORYLINE_TEMPLATE).unwrap());
}
