//! Actual v3 results versus the independent, read-only inventory. Choices
//! below are synthetic test policy, not decisions for authors' libraries.

mod common;
#[path = "common/v3_manifest.rs"]
mod manifest;

use std::collections::{BTreeMap, BTreeSet};

use common::{v3_fixture as fixture, *};
use dr_doc::peer::random_device_peer;
use dr_doc::prose::ProseDoc;
use dr_doc::v3::novel::*;
use dr_doc::v3::{BookDocV3, BookViewV3};
use dr_import_v1::run::{self, Options, Outcome};
use dr_import_v1::v3::*;
use dr_model::id::*;
use dr_model::import_v1::ActId;
use dr_model::kind::*;
use dr_model::v3::*;
use dr_model::{DocId, ProseProfile};
use dr_samples::v3 as adapter;
use dr_store::{Library, LibraryOptions};

fn tid(s: &str) -> EntryTemplateId {
    EntryTemplateId::parse(s).unwrap()
}
fn mid(s: &str) -> ModuleId {
    ModuleId::parse(s).unwrap()
}
fn eid(s: &str) -> EntryId {
    EntryId::parse(s).unwrap()
}

fn choices() -> MappingChoices {
    MappingChoices {
        profile: Some("test-explicit".into()),
    }
}

fn entry_id(view: &BookViewV3<'_>, entry: &manifest::Entry) -> EntryId {
    use manifest::Entry::*;
    let root = |template| view.root_entry_by_template(&tid(template)).unwrap().id;
    match entry {
        Manuscript => root(TPL_MANUSCRIPT),
        Ideas => root(TPL_IDEAS),
        Elements => root(TPL_ELEMENTS),
        Storylines => root(TPL_STORYLINES),
        TextMaterials => {
            view.entries_raw()
                .into_iter()
                .find(|e| {
                    e.parent.is_none()
                        && e.template == Some(tid(TPL_GROUP))
                        && e.title == "文本素材"
                })
                .unwrap()
                .id
        }
        ActTrack => root(TPL_ACT_TRACK),
        ActLeaf { synthetic_rank, .. } => view.children_of(Some(&root(TPL_ACT_TRACK)))
            [*synthetic_rank]
            .id
            .clone(),
        Act(id) | Node(id) | IdeaGroup(id) | Category(id) | Element(id) | Storyline(id)
        | MaterialFolder(id) | Material(id) => eid(id),
        ElementGroup { category, name } => {
            view.children_of(Some(&eid(category)))
                .into_iter()
                .find(|e| e.template == Some(tid(TPL_GROUP)) && &e.title == name)
                .unwrap()
                .id
        }
        Unaffiliated => {
            let storylines_root = root(TPL_STORYLINES);
            let authored: BTreeSet<_> = [STORYLINE, fixture::STORYLINE_OTHER]
                .into_iter()
                .map(eid)
                .collect();
            view.children_of(Some(&storylines_root))
                .into_iter()
                .find(|e| {
                    e.template == Some(tid(TPL_STORYLINE))
                        && e.title == "未归属"
                        && !authored.contains(&e.id)
                })
                .unwrap()
                .id
        }
    }
}

fn template_id(template: &manifest::LeafTemplate) -> EntryTemplateId {
    match template {
        manifest::LeafTemplate::Chapter => tid(TPL_CHAPTER),
        manifest::LeafTemplate::Idea => tid(TPL_IDEA),
        manifest::LeafTemplate::Note => tid(TPL_NOTE),
        manifest::LeafTemplate::NotePlain => adapter::plain_note_template(),
        manifest::LeafTemplate::Category(id) => adapter::category_template(id),
        manifest::LeafTemplate::Storyline(id) => adapter::storyline_template(id),
    }
}

fn body_id(view: &BookViewV3<'_>, body: &manifest::Body) -> DocId {
    match body {
        manifest::Body::Leaf(entry) => adapter::body_id(entry_id(view, entry).as_str(), MOD_PROSE),
        manifest::Body::About(entry) => {
            adapter::body_id(entry_id(view, entry).as_str(), MOD_DESCRIPTION)
        }
        manifest::Body::Template(template) => DocId::Template(TemplateId::for_entry_module(
            view.book_id(),
            &template_id(template),
            &mid(MOD_PROSE),
        )),
    }
}

fn options(old: &Old) -> Options {
    let mut options = Options::new("k3-v3-test");
    options.v3 = choices();
    options.old_root = Some(old.root.clone());
    options.verify_history = true;
    // dr-index is still a v2 consumer (K4); v3 bodies/catalog are verified
    // directly through dr-doc here.
    options.index = false;
    options
}

fn open(root: &std::path::Path) -> Library {
    let start = std::time::Instant::now();
    loop {
        match Library::open(root, LibraryOptions::new("k3-v3-test")) {
            Ok(lib) => return lib,
            Err(error)
                if error.to_string().contains("already open") && start.elapsed().as_secs() < 5 =>
            {
                std::thread::sleep(std::time::Duration::from_millis(20))
            }
            Err(error) => panic!("{error}"),
        }
    }
}

fn load_prose(lib: &Library, id: &DocId) -> ProseDoc {
    let bytes = lib
        .load_copy(&id.to_string())
        .unwrap()
        .export(loro::ExportMode::Snapshot)
        .unwrap();
    ProseDoc::load(id.clone(), random_device_peer(), &[bytes]).unwrap()
}

fn text(entry: &Entry, key: &str) -> Option<String> {
    entry
        .fields
        .get(&mid(MOD_FIELDS))?
        .get(key)?
        .as_str()
        .map(str::to_owned)
}

fn comment_id(old: &str) -> CommentId {
    match old {
        NOTE_TODO => CommentId::for_projection(
            &ProjectionKind::NoteTask,
            &adapter::body_id(NOTE, MOD_PROSE),
            &BlockId::parse("tp1").unwrap(),
        ),
        MARKER_TODO => CommentId::for_projection(
            &ProjectionKind::Marker,
            &adapter::body_id(CHAPTER, MOD_PROSE),
            &BlockId::parse("p2").unwrap(),
        ),
        id => CommentId::parse(id).unwrap(),
    }
}

fn endpoint(
    view: &BookViewV3<'_>,
    endpoint: &manifest::Endpoint,
) -> dr_model::import_v1::EntityRef {
    use manifest::Endpoint::*;
    let (kind, id) = match endpoint {
        Entry(e) => (EntityKind::Entry, entry_id(view, e).to_string()),
        Asset(id) => (EntityKind::Asset, id.clone()),
        Comment(id) => (EntityKind::Comment, comment_id(id).to_string()),
        Patch(id) => (EntityKind::Patch, id.clone()),
        Unresolved { kind, id } => panic!("unexpected unresolved fixture endpoint: {kind}:{id}"),
    };
    dr_model::import_v1::EntityRef::new(kind, id)
}

fn compare(view: &BookViewV3<'_>, expected: &manifest::Manifest, lib: &Library) {
    adapter::validate(view).unwrap();
    let counts = expected.counts();
    assert_eq!(view.entries_raw().len(), counts.levels + counts.leaves);
    assert_eq!(
        view.meta().schema_version,
        dr_doc::schema::BOOK_SCHEMA_VERSION
    );
    let proj = view.project();
    // The book reads from the root: no start is written.
    assert!(proj.book.is_some());
    // No Tab mounts a view, and every lane takes entries from elsewhere
    // (DV, 2026-11-16).
    let snapshot = view.structure_snapshot();
    assert!(
        proj.tabs
            .iter()
            .all(|t| snapshot.is_valid_tab_mount(&t.mount)),
        "{:?}",
        proj.tabs
    );
    for tv in view.timeline_views_raw() {
        for l in &tv.lanes {
            assert!(
                dr_model::v3::check_timeline_lane(
                    &l.entry,
                    snapshot.entries_map(),
                    snapshot.templates_map()
                )
                .is_ok(),
                "lane {}",
                l.entry
            );
        }
    }
    assert_eq!(
        outermost_with_prose(view.structure_snapshot().book_sequence())
            .into_iter()
            .map(|e| e.entry.clone())
            .collect::<Vec<_>>()
            .iter()
            .map(|e| e.id.as_str())
            .collect::<Vec<_>>(),
        [
            fixture::CHAPTER_BEFORE,
            CHAPTER,
            fixture::CHAPTER_UNPLACED,
            fixture::CHAPTER_UNAFFILIATED
        ]
    );
    assert_eq!(
        view.children_of(Some(&entry_id(view, &manifest::Entry::Manuscript)))
            .iter()
            .map(|e| e.id.as_str())
            .collect::<Vec<_>>(),
        [fixture::CHAPTER_BEFORE, "act-1", "act-2"]
    );
    let book_cfg = proj.book.as_ref().expect("imported book config");
    assert_eq!(book_cfg.word_target_set, expected.settings.word_target);
    assert_eq!(
        book_cfg.daily_word_target_set,
        expected.settings.daily_word_target
    );
    let layout_positions = {
        let h = lib
            .open_doc(
                &format!("layout:{}", view.book_id()),
                dr_store::OpenDoc::Existing,
            )
            .unwrap();
        let b = view.book_id().clone();
        let all = h
            .read(move |d| {
                dr_doc::side::BorrowedLayout::new(d, &b)
                    .unwrap()
                    .view()
                    .all_positions()
            })
            .unwrap();
        h.close();
        all
    };
    for level in &expected.levels {
        let actual = view.entry(&entry_id(view, &level.entry)).unwrap();
        assert_eq!(actual.title, level.title, "{:?}", level.entry);
        assert_eq!(
            actual.parent,
            level.parent.as_ref().map(|e| entry_id(view, e)),
            "{:?}",
            level.entry
        );
        assert_eq!(actual.is_level(), level.is_level, "{:?}", level.entry);
        assert_eq!(
            actual.accepts_members(&view.templates_map()),
            level.accept,
            "{:?}",
            level.entry
        );
        if let Some(template) = &level.default_leaf {
            assert_eq!(
                view.level_settings(Some(&actual.id)).default_template,
                Some(template_id(template))
            );
        }
        if let Some(color) = &level.color {
            assert_eq!(text(&actual, "color").as_ref(), Some(color));
        }
        if let Some(manifest::Layout::Grid { x, y, .. }) = &level.layout {
            let scope = actual.parent.as_ref().map(|p| p.as_str()).unwrap_or("root");
            let got = layout_positions
                .get(&format!("{scope}/grid"))
                .and_then(|m| m.get(&actual.id))
                .copied();
            assert_eq!(got, x.zip(*y).map(|(gx, gy)| (gx as f64, gy as f64)));
        }
    }
    if !expected.default_view.act_tracks.is_empty() {
        let act_track_id = entry_id(view, &manifest::Entry::ActTrack);
        assert!(!act_track_id.as_str().starts_with("root-"));
        let act_settings = view.level_settings(Some(&act_track_id));
        assert_eq!(act_settings.default_template, Some(tid(TPL_IDEA)));
        assert_eq!(act_settings.home, None);
        assert!(act_settings.accept);
    }
    let storylines_root = entry_id(view, &manifest::Entry::Storylines);
    let manuscript_root = entry_id(view, &manifest::Entry::Manuscript);
    let unaffiliated_id = entry_id(view, &manifest::Entry::Unaffiliated);
    assert_eq!(
        view.children_of(Some(&storylines_root))
            .iter()
            .map(|e| e.id.clone())
            .collect::<Vec<_>>(),
        [
            eid(fixture::STORYLINE_OTHER),
            eid(STORYLINE),
            unaffiliated_id.clone(),
        ]
    );
    assert_eq!(
        view.level_settings(Some(&unaffiliated_id)).home,
        Some(manuscript_root)
    );
    let rel_type = view
        .relation_type(&RelationTypeId::parse(REL_TYPE).unwrap())
        .unwrap();
    assert_eq!(rel_type.source_kinds, [EntityKind::Entry]);
    assert_eq!(rel_type.target_kinds, [EntityKind::Entry]);
    assert!(rel_type.source_templates.is_empty());
    assert!(rel_type.target_templates.is_empty());
    let patch_rt = view
        .relation_type(&RelationTypeId::parse(fixture::PATCH_RELATION).unwrap())
        .unwrap();
    assert_eq!(patch_rt.source_kinds, [EntityKind::Patch]);
    assert_eq!(patch_rt.target_kinds, [EntityKind::Entry]);
    assert!(patch_rt.source_templates.is_empty());
    assert!(patch_rt.target_templates.is_empty());
    for leaf in &expected.leaves {
        let actual = view.entry(&entry_id(view, &leaf.entry)).unwrap();
        assert!(
            !actual.is_level(),
            "{:?} must keep its level switch off",
            leaf.entry
        );
        assert_eq!(actual.title, leaf.title);
        assert_eq!(actual.parent, leaf.home.as_ref().map(|e| entry_id(view, e)));
        assert_eq!(actual.template, leaf.template.as_ref().map(template_id));
        if matches!(
            leaf.entry,
            manifest::Entry::ActLeaf { .. } | manifest::Entry::Material(_)
        ) {
            assert_eq!(text(&actual, "summary"), None);
        } else {
            assert_eq!(
                text(&actual, "summary").as_deref(),
                Some(leaf.summary.as_str())
            );
        }
        if let Some(status) = &leaf.status {
            assert_eq!(text(&actual, "status").as_ref(), Some(status));
        }
        if !leaf.aliases.is_empty() {
            let FieldValue::List(aliases) = &actual.fields[&mid(MOD_FIELDS)]["aliases"] else {
                panic!("aliases field")
            };
            assert_eq!(
                aliases.iter().collect::<BTreeSet<_>>(),
                leaf.aliases.iter().collect::<BTreeSet<_>>()
            );
        }
        if let Some(portrait) = &leaf.portrait {
            assert_eq!(text(&actual, "portrait").as_ref(), Some(portrait));
        }
        let kv = actual.kv.get(&mid(MOD_KV)).cloned().unwrap_or_default();
        assert_eq!(
            kv.iter().map(|f| (&f.key, &f.value)).collect::<Vec<_>>(),
            leaf.kv
                .iter()
                .map(|f| (&f.name, &f.value))
                .collect::<Vec<_>>()
        );
        let template = actual
            .template
            .as_ref()
            .and_then(|id| view.template(id))
            .unwrap();
        for field in &leaf.fields {
            let definition = template
                .modules
                .iter()
                .flat_map(|m| &m.config.defs)
                .find(|d| d.name == field.name)
                .unwrap();
            assert_eq!(text(&actual, &definition.id).as_ref(), Some(&field.value));
        }
        match leaf.layout {
            Some(manifest::Layout::Board(x, y)) => {
                let scope = actual.parent.as_ref().map(|p| p.as_str()).unwrap_or("root");
                assert_eq!(
                    layout_positions
                        .get(&format!("{scope}/board"))
                        .and_then(|m| m.get(&actual.id))
                        .copied(),
                    Some((x, y))
                );
            }
            Some(manifest::Layout::Graph(x, y)) => {
                assert_eq!(
                    layout_positions
                        .get("root/relation_graph")
                        .and_then(|m| m.get(&actual.id))
                        .copied(),
                    Some((x, y))
                );
            }
            _ => {}
        }
    }
    for template in &expected.leaf_templates {
        let actual = view.template(&template_id(&template.template)).unwrap();
        assert!(!actual.level);
        assert_eq!(actual.name, template.name);
        for field in &template.fields {
            let want_default =
                (!field.value.is_empty()).then(|| FieldValue::Text(field.value.clone()));
            assert!(
                actual
                    .modules
                    .iter()
                    .flat_map(|m| &m.config.defs)
                    .any(|d| d.name == field.name
                        && d.id == field.old_id
                        && d.default_value == want_default)
            );
        }
    }
    let mut memberships: Vec<_> = view
        .memberships_raw()
        .iter()
        .map(|m| {
            (
                m.host.clone(),
                m.member.clone(),
                view.entry(&m.member).unwrap().primary.as_ref() == Some(&m.host),
            )
        })
        .collect();
    memberships.sort();
    let mut want: Vec<_> = expected
        .memberships
        .iter()
        .map(|m| {
            (
                entry_id(view, &m.level),
                entry_id(view, &m.member),
                m.primary,
            )
        })
        .collect();
    want.sort();
    assert_eq!(memberships, want);
    let timelines = view.timeline_views_raw();
    assert_eq!(timelines.len(), 1);
    let timeline = &timelines[0];
    assert_eq!(
        timeline
            .lanes
            .iter()
            .map(|l| l.entry.clone())
            .collect::<Vec<_>>(),
        expected
            .default_view
            .lanes
            .iter()
            .map(|e| entry_id(view, e))
            .collect::<Vec<_>>()
    );
    let want_act_tracks: BTreeSet<_> = expected
        .default_view
        .act_tracks
        .iter()
        .map(|e| entry_id(view, e))
        .collect();
    for lane in &timeline.lanes {
        if want_act_tracks.contains(&lane.entry) {
            assert_eq!(lane.act_track, Some(true));
        } else {
            assert_eq!(lane.act_track, None);
        }
    }
    let mut positions: Vec<_> = timeline
        .placements
        .iter()
        .map(|p| (p.entry.clone(), p.at, p.span))
        .collect();
    positions.sort_by(|a, b| a.0.cmp(&b.0));
    let mut want: Vec<_> = expected
        .default_view
        .placements
        .iter()
        .map(|p| (entry_id(view, &p.entry), p.at, p.span))
        .collect();
    want.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(positions, want);
    for pin in &expected.default_view.pins {
        let actual = timeline
            .pins
            .iter()
            .find(|p| p.id.as_str() == pin.old_id)
            .unwrap();
        assert_eq!(
            (actual.at, &actual.label, &actual.color, &actual.entry),
            (
                pin.at,
                &pin.label,
                &pin.color,
                &pin.entry.as_ref().map(|e| entry_id(view, e))
            )
        );
    }
    assert_eq!(view.patches().len(), expected.patches.len());
    for patch in &expected.patches {
        let actual = view
            .patches()
            .into_iter()
            .find(|p| p.id.as_str() == patch.old_id)
            .unwrap();
        assert_eq!(actual.entry, entry_id(view, &patch.owner));
        assert_eq!(actual.module, mid(MOD_PATCHES));
        assert_eq!(
            actual.source_entry,
            patch.source.as_ref().and_then(|b| match b {
                manifest::Body::Leaf(e) => Some(entry_id(view, e)),
                _ => None,
            })
        );
        assert_eq!(actual.source_module, Some(mid(MOD_PROSE)));
        let row = expected.source_rows["element_patch"]
            .iter()
            .find(|r| r["id"].as_str() == Some(&patch.old_id))
            .unwrap();
        assert_eq!(actual.title.as_deref(), row["title"].as_str());
        assert_eq!(
            actual.body,
            dr_import_v1::book::plain_text(row["content_json"].as_str().unwrap()).0
        );
        assert_eq!(
            actual.source_text.as_deref(),
            row["source_block_text"].as_str()
        );
    }
    for grid in &expected.plot_grids {
        let actual = view
            .plot_grid(&entry_id(view, &grid.entry), &mid(MOD_PLOT_GRID))
            .unwrap();
        let row = expected.source_rows["plot_grid_document"]
            .iter()
            .find(|r| r["id"].as_str() == Some(&grid.old_id))
            .unwrap();
        assert_eq!(actual.cell_w, row["cell_width"].as_f64().unwrap());
        assert_eq!(actual.cell_h, row["cell_height"].as_f64().unwrap());
        assert_eq!(
            actual.rows.len(),
            expected.source_rows["plot_grid_row"].len()
        );
        assert_eq!(
            actual.cols.len(),
            expected.source_rows["plot_grid_column"].len()
        );
        for row in &expected.source_rows["plot_grid_cell"] {
            assert_eq!(
                actual.cells[&(
                    PlotRowId::parse(row["row_id"].as_str().unwrap()).unwrap(),
                    PlotColId::parse(row["column_id"].as_str().unwrap()).unwrap()
                )],
                row["value"].as_str().unwrap()
            );
        }
    }
    assert_eq!(view.comments().len(), expected.comments.len());
    for comment in &expected.comments {
        let cid = if let Some((block_id, _, _)) = &comment.synthesized_task {
            let doc = body_id(view, comment.body.as_ref().unwrap());
            CommentId::for_projection(
                &ProjectionKind::NoteTask,
                &doc,
                &BlockId::parse(block_id).unwrap(),
            )
        } else {
            comment_id(&comment.old_id)
        };
        let actual = view.comments().into_iter().find(|c| c.id == cid).unwrap();
        assert_eq!(
            actual.target,
            comment.target.as_ref().map(|e| endpoint(view, e))
        );
        assert_eq!(actual.origin.as_str(), comment.origin);
        if let Some(body) = &comment.body
            && let DocId::Body(id) = body_id(view, body)
        {
            assert_eq!(actual.target_module.as_ref(), Some(id.module()));
        }
        if let Some((block_id, want_text, want_checked)) = &comment.synthesized_task {
            assert_eq!(
                actual.target_block.as_ref().map(BlockId::as_str),
                Some(block_id.as_str())
            );
            assert_eq!(
                actual
                    .projection
                    .as_ref()
                    .map(|p| (&p.kind, p.block.as_str())),
                Some((&ProjectionKind::NoteTask, block_id.as_str()))
            );
            assert_eq!(actual.body, *want_text);
            let want_status = if *want_checked {
                dr_model::kind::CommentStatus::Resolved
            } else {
                dr_model::kind::CommentStatus::Open
            };
            assert_eq!(actual.status, want_status);
            assert_eq!(actual.resolved_at.is_some(), *want_checked);
            continue;
        }
        if let Some(want_body) = &comment.synthesized_material {
            assert_eq!(actual.target_module, None);
            assert_eq!(actual.part, None);
            assert_eq!(actual.origin, CommentOrigin::Manual);
            assert_eq!(actual.author_kind, CommentAuthorKind::User);
            assert_eq!(actual.source, CommentSource::Manual);
            assert_eq!(actual.status, CommentStatus::Resolved);
            assert!(actual.resolved_at.is_some());
            assert_eq!(actual.metadata, None);
            assert_eq!(actual.body, *want_body);
            continue;
        }
        let row = expected.source_rows["comment"]
            .iter()
            .find(|r| r["id"].as_str() == Some(&comment.old_id))
            .unwrap();
        if actual
            .target
            .as_ref()
            .is_some_and(|t| t.kind == EntityKind::Asset)
        {
            assert_eq!(actual.target_module, None);
            if let Some(want) =
                serde_json::from_str::<serde_json::Value>(row["anchor_json"].as_str().unwrap())
                    .ok()
                    .and_then(|v| v.get("region").cloned())
            {
                // The rectangle itself, not only its kind (DY fix 14).
                let Some(CommentPart::Region { region }) = &actual.part else {
                    panic!("{} is a region comment: {:?}", comment.old_id, actual.part);
                };
                let f = |k: &str| want[k].as_f64().unwrap();
                assert_eq!(
                    (region.x, region.y, region.w, region.h),
                    (f("x"), f("y"), f("w"), f("h")),
                    "{}",
                    comment.old_id
                );
                assert_eq!(
                    region.page,
                    want["page"].as_u64().map(|p| p as u32),
                    "{}",
                    comment.old_id
                );
            }
        }
        assert_eq!(
            actual.body,
            dr_import_v1::book::plain_text(row["body_json"].as_str().unwrap()).0
        );
        assert_eq!(actual.metadata.as_deref(), row["metadata_json"].as_str());
    }
    assert_eq!(view.relations_raw().len(), expected.relations.len());
    for relation in &expected.relations {
        let actual = view
            .relations_raw()
            .into_iter()
            .find(|r| r.id.as_str() == relation.old_id)
            .unwrap();
        let (from, to) = if relation.orientation == "symmetric" {
            dr_model::import_v1::canonical_symmetric(
                endpoint(view, &relation.from),
                endpoint(view, &relation.to),
            )
        } else {
            (endpoint(view, &relation.from), endpoint(view, &relation.to))
        };
        assert_eq!(
            (actual.from, actual.to, actual.relation_type.to_string()),
            (from, to, relation.relation_type.clone())
        );
    }
    assert_eq!(
        view.assets().len(),
        expected.source_rows["project_asset"].len()
    );
    assert_eq!(
        view.memory().len(),
        expected.source_rows["agent_memory"].len()
    );
    // Writing days live beside the book document, in `stats:<book>`.
    let stats_id = format!("stats:{}", view.book_id());
    let writing_days = {
        let h = lib
            .open_doc(&stats_id, dr_store::OpenDoc::Existing)
            .unwrap();
        let book = view.book_id().clone();
        let days = h
            .read(move |d| {
                dr_doc::side::BorrowedStats::new(d, &book)
                    .unwrap()
                    .view()
                    .writing_days()
            })
            .unwrap();
        h.close();
        days
    };
    assert_eq!(
        writing_days.len(),
        expected.source_rows["writing_day"].len()
    );
    // `checkpoints:<book>` is created with its deterministic genesis only:
    // 0.1 had no entry checkpoints, so no post-genesis update is written.
    let checkpoints_id = format!("checkpoints:{}", view.book_id());
    let (cp_entries, cp_vv) = {
        let h = lib
            .open_doc(&checkpoints_id, dr_store::OpenDoc::Existing)
            .unwrap();
        let book = view.book_id().clone();
        let res = h
            .read(move |d| {
                let entries = dr_doc::side::BorrowedCheckpoints::new(d, &book)
                    .unwrap()
                    .view()
                    .entry_checkpoints();
                (entries, d.oplog_vv())
            })
            .unwrap();
        h.close();
        res
    };
    assert!(cp_entries.is_empty());
    let fresh_cp =
        dr_doc::side::CheckpointsDoc::create(view.book_id().clone(), random_device_peer()).unwrap();
    assert_eq!(cp_vv, fresh_cp.version());
    // Level descriptions sit in the `说明` prose module (`in_book = false`),
    // never in a separate `/about` document.
    for tpl_id in [TPL_CATEGORY, TPL_STORYLINE, TPL_IDEA_GROUP, TPL_GROUP] {
        let tpl = view.template(&tid(tpl_id)).unwrap();
        let desc = tpl
            .modules
            .iter()
            .find(|m| m.id.as_str() == MOD_DESCRIPTION)
            .unwrap();
        assert_eq!(desc.name, "说明");
        assert!(!desc.config.in_book);
    }
    for entry in view.entries_raw() {
        assert!(
            lib.doc_info(&format!("body:{}/about", entry.id))
                .unwrap()
                .is_none(),
            "no /about prose doc for {}",
            entry.id
        );
    }
    let has_text_materials = expected.source_rows["library_item"]
        .iter()
        .any(|r| r["kind"].as_str() == Some("text"));
    let text_materials_root =
        has_text_materials.then(|| entry_id(view, &manifest::Entry::TextMaterials));
    let mut note_folders = BTreeSet::new();
    for row in &expected.source_rows["library_item"] {
        if row["kind"].as_str() != Some("text") {
            continue;
        }
        let mut cur = row["folder_id"].as_str();
        while let Some(fid) = cur {
            if !note_folders.insert(fid.to_string()) {
                break;
            }
            cur = expected.source_rows["material_folder"]
                .iter()
                .find(|f| f["id"].as_str() == Some(fid))
                .and_then(|f| f["parent_folder_id"].as_str());
        }
    }
    for row in &expected.source_rows["material_folder"] {
        let fid = row["id"].as_str().unwrap();
        if note_folders.contains(fid) {
            let actual = view.entry(&eid(fid)).unwrap();
            assert!(actual.is_level());
            assert_eq!(actual.title, row["name"].as_str().unwrap());
            let expected_parent = row["parent_folder_id"]
                .as_str()
                .filter(|p| note_folders.contains(*p))
                .map(eid)
                .or_else(|| text_materials_root.clone());
            assert_eq!(actual.parent, expected_parent);
        } else {
            assert!(view.entry(&eid(fid)).is_none());
        }
    }
    for row in &expected.source_rows["library_item"] {
        let mid_str = row["id"].as_str().unwrap();
        let kind = row["kind"].as_str().unwrap();
        if kind == "text" {
            let actual = view.entry(&eid(mid_str)).unwrap();
            assert!(!actual.is_level());
            assert_eq!(actual.title, row["title"].as_str().unwrap());
            let expected_parent = row["folder_id"]
                .as_str()
                .filter(|f| note_folders.contains(*f))
                .map(eid)
                .or_else(|| text_materials_root.clone());
            assert_eq!(actual.parent, expected_parent);
            let want_tpl = if row["task_todos"].as_i64() == Some(1) {
                tid(TPL_NOTE)
            } else {
                adapter::plain_note_template()
            };
            assert_eq!(actual.template, Some(want_tpl));
        } else {
            assert!(
                view.entry(&eid(mid_str)).is_none(),
                "non-text material {mid_str} goes into assets, not entries"
            );
        }
    }
    // The notes keep their 0.1 order (`order_key`, then id) among their
    // siblings (DY fix 9: the order assertion the material rows had).
    let mut notes_by_parent: BTreeMap<Option<EntryId>, Vec<(i64, String)>> = BTreeMap::new();
    for row in &expected.source_rows["library_item"] {
        if row["kind"].as_str() != Some("text") {
            continue;
        }
        let parent = row["folder_id"]
            .as_str()
            .filter(|f| note_folders.contains(*f))
            .map(eid)
            .or_else(|| text_materials_root.clone());
        notes_by_parent.entry(parent).or_default().push((
            row["order_key"].as_i64().unwrap_or(0),
            row["id"].as_str().unwrap().to_owned(),
        ));
    }
    let structure = view.structure_snapshot();
    for (parent, mut want) in notes_by_parent {
        want.sort();
        let want: Vec<String> = want.into_iter().map(|(_, id)| id).collect();
        let have: Vec<String> = structure
            .children_of(parent.as_ref())
            .into_iter()
            .map(|e| e.id.to_string())
            .filter(|id| want.contains(id))
            .collect();
        assert_eq!(have, want, "notes under {parent:?} keep their order");
    }
    for row in &expected.source_rows["project_asset"] {
        let actual = view
            .assets()
            .into_iter()
            .find(|a| a.id.as_str() == row["id"].as_str().unwrap())
            .unwrap();
        assert_eq!(actual.sha256, row["source_sha256"].as_str().unwrap());
        assert_eq!(actual.mime, row["source_mime"].as_str().unwrap());
        assert_eq!(actual.size, row["source_size_bytes"].as_i64().unwrap());
        assert_eq!(actual.width, row["width"].as_i64());
        assert_eq!(actual.height, row["height"].as_i64());
        let stored = lib
            .asset(actual.id.as_str(), dr_store::asset::Variant::Source)
            .unwrap()
            .unwrap();
        assert_eq!(stored.sha256, actual.sha256);
    }
    for row in &expected.source_rows["agent_memory"] {
        let actual = view
            .memory()
            .into_iter()
            .find(|m| m.id.as_str() == row["id"].as_str().unwrap())
            .unwrap();
        assert_eq!(actual.body, row["body"].as_str().unwrap());
        assert_eq!(actual.kind.as_str(), row["kind"].as_str().unwrap());
        assert_eq!(actual.source.as_str(), row["source"].as_str().unwrap());
        assert_eq!(actual.status.as_str(), row["status"].as_str().unwrap());
        assert_eq!(
            actual.target.as_ref().map(|t| t.kind.clone()),
            Some(EntityKind::Entry)
        );
        assert_eq!(
            actual.target.as_ref().map(|t| t.id.as_str()),
            row["target_id"].as_str()
        );
    }
    for row in &expected.source_rows["writing_day"] {
        assert!(
            writing_days
                .iter()
                .any(|d| d.device.as_str() == row["device_key"].as_str().unwrap()
                    && d.day.to_string() == row["day"].as_str().unwrap()
                    && d.words == row["words"].as_i64().unwrap())
        );
    }
    let story_template = view.template(&tid(TPL_STORYLINE)).unwrap();
    let initial = &story_template
        .modules
        .iter()
        .find(|m| m.id.as_str() == MOD_KV)
        .unwrap()
        .config
        .initial_kv;
    assert_eq!(
        initial
            .iter()
            .map(|f| (f.key.as_str(), f.value.as_str()))
            .collect::<Vec<_>>(),
        [("目标", "")]
    );
    let mut spans = std::collections::HashMap::new();
    for body in &expected.prose {
        if matches!(body.target, manifest::Body::Template(_)) {
            continue;
        }
        let lines = dr_import_v1::prose::pm::parse(body.json.as_deref().unwrap_or("{}")).unwrap();
        let blocks = dr_import_v1::prose::doc_blocks(&lines);
        for id in blocks.ranges.keys() {
            if let Some(s) = blocks.span(id) {
                spans.entry(id.clone()).or_insert(s);
            }
        }
    }
    let mut material_assets = std::collections::HashMap::new();
    let mut non_text_materials = std::collections::HashMap::new();
    // A material whose file row is gone has no file to embed or link to.
    let files: BTreeSet<&str> = expected.source_rows["project_asset"]
        .iter()
        .filter_map(|r| r["id"].as_str())
        .collect();
    for row in &expected.source_rows["library_item"] {
        if let (Some(id), Some(aid)) = (row["id"].as_str(), row["asset_id"].as_str())
            && files.contains(aid)
            && let Ok(asset) = AssetId::parse(aid)
        {
            material_assets.insert(id.to_owned(), asset);
        }
        if row["kind"].as_str() != Some("text")
            && let (Some(id), Some(title)) = (row["id"].as_str(), row["title"].as_str())
        {
            non_text_materials.insert(id.to_owned(), title.to_owned());
        }
    }
    for body in &expected.prose {
        if matches!(body.target, manifest::Body::Template(_))
            && body
                .json
                .as_deref()
                .is_none_or(|j| !manifest::nonempty_body(j).unwrap())
        {
            continue;
        }
        let id = body_id(view, &body.target);
        let doc = load_prose(lib, &id);
        let json = body.json.as_deref().unwrap_or("{}");
        let lines = dr_import_v1::prose::pm::parse(json).unwrap();
        let blocks = dr_import_v1::prose::doc_blocks(&lines);
        let plan = dr_import_v1::prose::plan_v3(
            &lines,
            &blocks,
            &dr_import_v1::prose::Context {
                profile: ProseProfile::Prose,
                span: &|old| spans.get(old).cloned(),
                todo: &|id| Some(comment_id(id)),
                asset: &|id| material_assets.get(id).cloned(),
                non_text_material: &|id| non_text_materials.get(id).cloned(),
            },
        );
        assert_eq!(
            doc.view().plain_text().trim_end_matches('\n'),
            plan.body_text().trim_end_matches('\n'),
            "{id}"
        );
        let actual = dr_import_v1::prose::read::read_paras_v3(&doc.view());
        assert_eq!(actual.len(), plan.paras.len(), "{id}");
        for (actual, expected) in actual.iter().zip(plan.paras) {
            if expected.id.is_some() {
                assert_eq!(actual.id, expected.id, "{id}");
            }
            assert_eq!(actual.attrs, expected.attrs, "{id}");
            assert_eq!(actual.runs, expected.runs, "{id}");
            assert_eq!(actual.embed, expected.embed, "{id}");
            assert_eq!(actual.table_cells, expected.table_cells, "{id}");
            assert_eq!(actual.v3_links, expected.v3_links, "{id}");
        }
    }
}

#[test]
fn undecided_mapping_stops_before_target_or_device_writes() {
    // 1. Default MappingChoices now imports the complete v3 fixture cleanly
    //    (policies #22, #23, and #25 are all author-settled 11-11 defaults).
    let clean = fixture::build();
    let temp = tempfile::tempdir().unwrap();
    let clean_root = temp.path().join("library-default");
    let mut default_opts = options(&clean);
    default_opts.v3 = MappingChoices::default();
    let (outcome, _) = run::import(&clean.db, &clean_root, &default_opts).unwrap();
    assert!(matches!(outcome, Outcome::Imported(r) if r.books[0].status == "imported"));

    // 2. A source preflight blocker (e.g. an act bound to a non-idea chapter node)
    //    still stops before claiming device identity or creating library.sqlite.
    let old = fixture::build();
    {
        let c = rusqlite::Connection::open(&old.db).unwrap();
        c.execute(
            "UPDATE book_act SET drift_node_id = ?1 WHERE id = 'act-1'",
            [CHAPTER],
        )
        .unwrap();
    }
    let root = temp.path().join("library");
    let device = temp.path().join("device");
    let mut options = options(&old);
    options.v3 = MappingChoices::default();
    options.device_dir = Some(device.clone());
    let error = run::import(&old.db, &root, &options).unwrap_err();
    let dr_import_v1::ImportError::V3Pending(pending) = error else {
        panic!("{error}")
    };
    let codes: BTreeSet<_> = pending.iter().map(|p| p.code.as_str()).collect();
    assert_eq!(codes, BTreeSet::from(["act-binding-not-an-idea"]));
    assert!(!device.exists());
    assert!(!root.join("library.sqlite").exists());
}

#[test]
fn every_inventory_row_imports_into_real_v3_documents_with_history() {
    let old = fixture::build();
    let expected = manifest::read(&old.db, BOOK).unwrap();
    let before = source_tree_snapshot(&old.root);
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("library");
    let (outcome, _) = run::import(&old.db, &root, &options(&old)).unwrap();
    let Outcome::Imported(receipt) = outcome else {
        panic!("not imported")
    };
    assert_eq!(
        source_tree_snapshot(&old.root),
        before,
        "source bytes, sizes and mtimes must never change"
    );
    assert_eq!(receipt.books[0].status, "imported");
    assert_eq!(receipt.books[0].history_meta_checked, 3);
    assert_eq!(receipt.books[0].assets_copied, 1);
    assert!(
        receipt
            .docs
            .iter()
            .all(|d| d.stored_exactly && d.round_trips)
    );
    assert!(receipt.anchors.iter().all(|a| a.cursor));
    let lib = open(&root);
    let bytes = lib
        .load_copy(&format!("book:{BOOK}"))
        .unwrap()
        .export(loro::ExportMode::Snapshot)
        .unwrap();
    let book =
        BookDocV3::load(BookId::parse(BOOK).unwrap(), random_device_peer(), &[bytes]).unwrap();
    compare(&book.view(), &expected, &lib);
    assert!(lib.doc_info(&format!("node:{CHAPTER}")).unwrap().is_none());
    let chapter = load_prose(&lib, &adapter::body_id(CHAPTER, MOD_PROSE));
    let comment = book
        .view()
        .comments()
        .into_iter()
        .find(|c| c.id.as_str() == COMMENT)
        .unwrap();
    let resolved = chapter
        .view()
        .resolve(&dr_doc::Anchor::decode(comment.anchor.as_ref().unwrap()).unwrap())
        .unwrap();
    assert!(!resolved.range.is_empty());
    assert_eq!(comment.target_module, Some(mid(MOD_PROSE)));
    assert_eq!(lib.history(&chapter.doc_id().to_string()).unwrap().len(), 3);
    lib.close().unwrap();
    let (second, _) = run::import(&old.db, &root, &options(&old)).unwrap();
    assert!(matches!(second,Outcome::Imported(r) if r.books[0].status == "already-imported"));
    assert_eq!(
        source_tree_snapshot(&old.root),
        before,
        "source bytes, sizes and mtimes must never change on repeat import"
    );
}

#[test]
fn malformed_source_is_reported_without_automatic_repairs() {
    let old = fixture::build();
    let c = rusqlite::Connection::open(&old.db).unwrap();
    c.pragma_update(None, "foreign_keys", false).unwrap();
    c.execute(
        "UPDATE element SET category_id='missing' WHERE id=?1",
        [ELEMENT],
    )
    .unwrap();
    drop(c);
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("library");
    let error = run::import(&old.db, &root, &options(&old)).unwrap_err();
    assert!(
        matches!(error,dr_import_v1::ImportError::V3Pending(p) if p.iter().any(|p| p.code == "element-missing-category"))
    );
    assert!(!root.join("library.sqlite").exists());
}

#[test]
fn a_long_legacy_id_is_reported_before_constructing_a_scoped_template_doc_id() {
    let old = fixture::build();
    let c = rusqlite::Connection::open(&old.db).unwrap();
    c.pragma_update(None, "foreign_keys", false).unwrap();
    let long = "c".repeat(220);
    c.execute(
        "UPDATE element_category SET id=?1 WHERE id=?2",
        [&long, CATEGORY],
    )
    .unwrap();
    drop(c);
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("library");
    let error = run::import(&old.db, &root, &options(&old)).unwrap_err();
    assert!(
        matches!(error, dr_import_v1::ImportError::V3Pending(p) if p.iter().any(|p| p.code == "template-prose-id-not-representable"))
    );
    assert!(!root.join("library.sqlite").exists());
}

#[test]
fn catalog_already_stored_before_interruption_keeps_its_generated_roots_on_resume() {
    let old = fixture::build();
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("library");
    let opts = options(&old);
    let cancel = opts.cancel.clone();
    let (first, _) = run::import_with(&old.db, &root, &opts, &mut |p| {
        if p.step == dr_import_v1::progress::Step::Assets && p.done == 0 {
            cancel.now();
        }
    })
    .unwrap();
    assert!(matches!(first, Outcome::Imported(r) if r.books[0].status == "importing"));
    let load = |lib: &Library| {
        let bytes = lib
            .load_copy(&format!("book:{BOOK}"))
            .unwrap()
            .export(loro::ExportMode::Snapshot)
            .unwrap();
        BookDocV3::load(BookId::parse(BOOK).unwrap(), random_device_peer(), &[bytes]).unwrap()
    };
    let roots = |book: &BookDocV3| -> Vec<EntryId> {
        let mut out: Vec<EntryId> = [TPL_MANUSCRIPT, TPL_IDEAS, TPL_ELEMENTS, TPL_STORYLINES]
            .iter()
            .map(|tpl| book.view().root_entry_by_template(&tid(tpl)).unwrap().id)
            .collect();
        if let Some(tm) = book.view().entries_raw().into_iter().find(|e| {
            e.parent.is_none() && e.template == Some(tid(TPL_GROUP)) && e.title == "文本素材"
        }) {
            out.push(tm.id);
        }
        out
    };
    let lib = open(&root);
    let before = load(&lib);
    let expected = manifest::read(&old.db, BOOK).unwrap();
    adapter::validate(&before.view()).unwrap();
    lib.close().unwrap();
    let (second, _) = run::import(&old.db, &root, &options(&old)).unwrap();
    assert!(matches!(second, Outcome::Imported(r) if r.books[0].status == "imported"));
    let lib = open(&root);
    let after = load(&lib);
    assert_eq!(roots(&before), roots(&after));
    assert_eq!(
        before.view().timeline_views_raw()[0].id,
        after.view().timeline_views_raw()[0].id
    );
    compare(&after.view(), &expected, &lib);
    let chapter = adapter::body_id(CHAPTER, MOD_PROSE);
    assert_eq!(lib.history(&chapter.to_string()).unwrap().len(), 3);
    lib.close().unwrap();
}

#[test]
fn interrupted_v3_import_resumes_with_the_same_policy_and_rejects_another_path() {
    let old = fixture::build();
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("library");
    let opts = options(&old);
    let cancel = opts.cancel.clone();
    let (first, _) = run::import_with(&old.db, &root, &opts, &mut |p| {
        if p.step == dr_import_v1::progress::Step::Bodies && p.done == 1 {
            cancel.now();
        }
    })
    .unwrap();
    assert!(matches!(first,Outcome::Imported(r) if r.books[0].status == "importing"));
    let lib = open(&root);
    assert!(lib.doc_info(&format!("book:{BOOK}")).unwrap().is_none());
    lib.close().unwrap();
    let mut changed = options(&old);
    changed.v3.profile = Some("different test policy".into());
    assert!(
        matches!(run::import(&old.db,&root,&changed),Err(dr_import_v1::ImportError::Invalid(message)) if message.contains("mapping policy"))
    );
    let lib = open(&root);
    lib.close().unwrap();
    let (outcome, _) = run::import(&old.db, &root, &options(&old)).unwrap();
    let Outcome::Imported(receipt) = outcome else {
        panic!("resume")
    };
    assert_eq!(receipt.books[0].status, "imported");
    let lib = open(&root);
    let copy = lib.load_copy(&format!("book:{BOOK}")).unwrap();
    let book = BookDocV3::load(
        BookId::parse(BOOK).unwrap(),
        random_device_peer(),
        &[copy.export(loro::ExportMode::Snapshot).unwrap()],
    )
    .unwrap();
    compare(&book.view(), &manifest::read(&old.db, BOOK).unwrap(), &lib);
    let chapter = adapter::body_id(CHAPTER, MOD_PROSE);
    assert_eq!(lib.history(&chapter.to_string()).unwrap().len(), 3);
    lib.close().unwrap();
}

#[test]
fn ambiguous_or_unsupported_sources_stop_before_v3_writes() {
    let cases = [
        (
            "UPDATE drift_group SET parent_group_id=id",
            "source-tree-cycle",
        ),
        (
            "UPDATE book_act SET start_order=0",
            "duplicate-act-boundary",
        ),
        (
            "UPDATE book_node SET book_order=NULL WHERE kind='chapter'",
            "chapter-without-book-order",
        ),
        (
            "UPDATE book_node SET book_order=4 WHERE kind='drift'",
            "idea-has-legacy-book-order",
        ),
        (
            "UPDATE element SET kv_json='{broken'",
            "unreadable-source-kv-projection",
        ),
        (
            "UPDATE storylines SET node_content_template_json='{broken'",
            "unreadable-source-template",
        ),
        (
            "UPDATE entity_relation SET from_id='missing' WHERE id='rel-1'",
            "invalid-or-duplicate-source-relation",
        ),
        (
            "UPDATE comment SET target_id='missing' WHERE kind='note' AND target_kind='node'",
            "comment-target-missing-or-trashed",
        ),
        (
            "UPDATE timeline_marker SET drift_node_id='missing'",
            "pin-binding-missing-idea",
        ),
        (
            "UPDATE entity_snapshot_history SET meta_json='{broken' WHERE id='h-1'",
            "unreadable-history-metadata",
        ),
        (
            "UPDATE entity_snapshot_history SET meta_json='{\"writingStatus\":\"drifting\"}' WHERE id='h-1'",
            "incompatible-history-node-status",
        ),
        (
            "UPDATE entity_snapshot_history SET content_json=NULL WHERE id='h-1'",
            "history-preview-missing",
        ),
        (
            "UPDATE entity_snapshot_history SET entity_id='missing' WHERE id='h-1'",
            "orphan-history-source",
        ),
    ];
    for (sql, code) in cases {
        let old = fixture::build();
        let c = rusqlite::Connection::open(&old.db).unwrap();
        c.pragma_update(None, "foreign_keys", false).unwrap();
        c.execute(sql, []).unwrap();
        drop(c);
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("library");
        let error = run::import(&old.db, &root, &options(&old)).unwrap_err();
        assert!(
            matches!(&error,dr_import_v1::ImportError::V3Pending(p) if p.iter().any(|p| p.code == code)),
            "{sql}: {error}"
        );
        assert!(!root.join("library.sqlite").exists());
    }
}

#[test]
fn duplicate_historical_values_do_not_overwrite_one_structured_field() {
    use serde_json::json;
    for (entity_kind, entity_id, metadata, code) in [
        (
            "element",
            ELEMENT,
            json!({"kvJson":json!([{"key":"年龄","value":"1"},{"key":"年龄","value":"2"}]).to_string()}),
            "duplicate-history-value-for-template-field",
        ),
        (
            "category",
            CATEGORY,
            json!({"elementTemplateKvJson":json!([{"key":"年龄","value":""},{"key":"年龄","value":""}]).to_string()}),
            "ambiguous-history-template-field",
        ),
    ] {
        let old = fixture::build();
        let c = rusqlite::Connection::open(&old.db).unwrap();
        c.execute("UPDATE entity_snapshot_history SET entity_kind=?1,entity_id=?2,meta_json=?3 WHERE id='h-3'",rusqlite::params![entity_kind,entity_id,metadata.to_string()]).unwrap();
        drop(c);
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("library");
        let error = run::import(&old.db, &root, &options(&old)).unwrap_err();
        assert!(
            matches!(&error,dr_import_v1::ImportError::V3Pending(p) if p.iter().any(|p| p.code == code)),
            "{error}"
        );
        assert!(!root.join("library.sqlite").exists());
    }
}

#[test]
fn historical_kv_and_custom_fields_can_share_the_builtin_summarys_display_name() {
    use serde_json::json;
    for storyline in [false, true] {
        let old = fixture::build();
        let c = rusqlite::Connection::open(&old.db).unwrap();
        let (kind, id, metadata) = if storyline {
            c.execute("UPDATE entity_kv_entry SET key='摘要' WHERE id='kv-4'", [])
                .unwrap();
            c.execute(
                "UPDATE storylines SET kv_json=replace(kv_json,'起点','摘要') WHERE id=?1",
                [STORYLINE],
            )
            .unwrap();
            (
                "storyline",
                STORYLINE,
                json!({"name":"主线","summary":"主人公","kvJson":json!([{"key":"摘要","value":"未庄"}]).to_string()}),
            )
        } else {
            c.execute(
                "UPDATE entity_kv_entry SET key='摘要' WHERE id IN ('kv-7','kv-8')",
                [],
            )
            .unwrap();
            c.execute("UPDATE element_category SET element_template_kv_json=replace(element_template_kv_json,'年龄','摘要') WHERE id=?1",[CATEGORY]).unwrap();
            c.execute(
                "UPDATE element SET kv_json=replace(kv_json,'年龄','摘要') WHERE id=?1",
                [ELEMENT],
            )
            .unwrap();
            let mut metadata: serde_json::Value = serde_json::from_str(ELEMENT_META_V1).unwrap();
            metadata["kvJson"] = json!(
                json!([{"key":"摘要","value":"30"},{"key":"职业","value":"短工"}]).to_string()
            );
            ("element", ELEMENT, metadata)
        };
        c.execute("UPDATE entity_snapshot_history SET entity_kind=?1,entity_id=?2,meta_json=?3 WHERE id='h-3'",rusqlite::params![kind,id,metadata.to_string()]).unwrap();
        drop(c);
        let temp = tempfile::tempdir().unwrap();
        let (outcome, _) =
            run::import(&old.db, &temp.path().join("library"), &options(&old)).unwrap();
        let Outcome::Imported(receipt) = outcome else {
            panic!("import")
        };
        assert_eq!(receipt.books[0].history_meta_checked, 3);
        assert!(
            !receipt.books[0]
                .notes
                .0
                .contains_key("history-meta-differs")
        );
    }
}

#[test]
fn the_development_cli_exposes_v3_preflight_and_imports_default_acts() {
    let blocked = fixture::build();
    let c = rusqlite::Connection::open(&blocked.db).unwrap();
    c.execute(
        "UPDATE book_act SET drift_node_id = ?1",
        rusqlite::params![CHAPTER],
    )
    .unwrap();
    drop(c);
    let temp = tempfile::tempdir().unwrap();
    let blocked_root = temp.path().join("blocked");
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_m10-import"))
        .args(["import"])
        .arg(&blocked.db)
        .arg("--to")
        .arg(&blocked_root)
        .args(["--v3", "--no-index"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["outcome"], "v3-pending");
    assert!(
        value["pending"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["code"] == "act-binding-not-an-idea")
    );
    assert!(!blocked_root.join("library.sqlite").exists());

    let old = fixture::build();
    let root = temp.path().join("library");
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_m10-import"))
        .args(["import"])
        .arg(&old.db)
        .arg("--to")
        .arg(&root)
        .args(["--v3", "--no-index"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["outcome"], "imported");
    assert!(root.join("library.sqlite").exists());
}

#[test]
fn unsupported_prose_links_and_table_marks_remain_in_the_source_and_stop_import() {
    use serde_json::json;
    for (body, code) in [
        (
            json!({
                "type": "doc",
                "content": [{
                    "type": "paragraph",
                    "attrs": {"id": "e-p1"},
                    "content": [{
                        "type": "text",
                        "text": "批注链接",
                        "marks": [{"type": "entityLink", "attrs": {"targetKind": "comment", "targetId": COMMENT}}]
                    }]
                }]
            }),
            "unsupported-entity-link-target-kind",
        ),
        (
            json!({
                "type": "doc",
                "content": [{
                    "type": "paragraph",
                    "attrs": {"id": "e-p1"},
                    "content": [{
                        "type": "text",
                        "text": "非法模块标识",
                        "marks": [{"type": "entityLink", "attrs": {"targetKind": "library_item", "targetId": NOTE, "targetModule": "bad/module"}}]
                    }]
                }]
            }),
            "invalid-source-entity-link",
        ),
        (
            json!({
                "type": "doc",
                "content": [{
                    "type": "table",
                    "content": [{
                        "type": "tableRow",
                        "content": [{
                            "type": "tableCell",
                            "content": [{
                                "type": "paragraph",
                                "content": [{
                                    "type": "text",
                                    "text": "正文表格禁未知标记",
                                    "marks": [{"type": "subscript"}]
                                }]
                            }]
                        }]
                    }]
                }]
            }),
            "unsupported-table-cell-mark",
        ),
        (
            json!({
                "type": "doc",
                "content": [{
                    "type": "table",
                    "content": [{
                        "type": "tableRow",
                        "content": [{
                            "type": "tableCell",
                            "content": [{
                                "type": "codeBlock",
                                "attrs": {"language": "rust"},
                                "content": [{"type": "text", "text": "fn main() {}"}]
                            }]
                        }]
                    }]
                }]
            }),
            "unsupported-table-cell-content",
        ),
    ] {
        let old = fixture::build();
        let c = rusqlite::Connection::open(&old.db).unwrap();
        c.execute(
            "UPDATE element SET content_json=?1 WHERE id=?2",
            rusqlite::params![body.to_string(), ELEMENT],
        )
        .unwrap();
        drop(c);
        let before = source_tree_snapshot(&old.root);
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("library");
        let mut options = options(&old);
        options.accept = dr_import_v1::gate::Accept::EVERYTHING;
        let error = run::import(&old.db, &root, &options).unwrap_err();
        assert!(
            matches!(&error, dr_import_v1::ImportError::V3Pending(p) if p.iter().any(|p| p.code == code)),
            "{error}"
        );
        assert!(!root.join("library.sqlite").exists());
        assert_eq!(before, source_tree_snapshot(&old.root));
    }
}

fn source_tree_snapshot(
    root: &std::path::Path,
) -> Vec<(String, u64, std::time::SystemTime, String)> {
    fn walk(
        base: &std::path::Path,
        dir: &std::path::Path,
        out: &mut Vec<(String, u64, std::time::SystemTime, String)>,
    ) {
        let mut entries: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap())
            .collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let path = entry.path();
            let meta = std::fs::symlink_metadata(&path).unwrap();
            if meta.is_dir() {
                walk(base, &path, out);
            } else {
                let rel = path
                    .strip_prefix(base)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                let bytes = std::fs::read(&path).unwrap();
                out.push((
                    rel,
                    meta.len(),
                    meta.modified().unwrap(),
                    sha256_bytes(&bytes),
                ));
            }
        }
    }
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out
}

#[test]
fn legacy_entity_links_adapt_losslessly_to_v3_across_bodies_templates_and_history() {
    use serde_json::json;

    let old = fixture::build();
    let rich_element_v1 = json!({
        "type": "doc",
        "content": [{
            "type": "paragraph",
            "attrs": {"id": "e-p1"},
            "content": [
                {"type": "text", "text": "旧版参考"},
                {
                    "type": "text",
                    "text": "札记",
                    "marks": [{"type": "entityLink", "attrs": {"targetKind": "library_item", "targetId": NOTE}}]
                }
            ]
        }]
    });
    let rich_element_live = json!({
        "type": "doc",
        "content": [{
            "type": "paragraph",
            "attrs": {"id": "e-p1"},
            "content": [
                {
                    "type": "text",
                    "text": "札记",
                    "marks": [{"type": "entityLink", "attrs": {"targetKind": "library_item", "targetId": NOTE}}]
                },
                {"type": "text", "text": "与"},
                {
                    "type": "text",
                    "text": "引文整段",
                    "marks": [{"type": "entityLink", "attrs": {"targetKind": "node", "targetId": CHAPTER, "targetBlockId": "q", "targetEndBlockId": "q"}}]
                },
                {"type": "text", "text": "及"},
                {
                    "type": "text",
                    "text": "主线简介",
                    "marks": [{"type": "entityLink", "attrs": {"targetKind": "storyline", "targetId": STORYLINE, "targetBlockId": "s-p1"}}]
                },
                {"type": "text", "text": "和"},
                {
                    "type": "text",
                    "text": "分类简介",
                    "marks": [{"type": "entityLink", "attrs": {"targetKind": "category", "targetId": CATEGORY, "module": MOD_DESCRIPTION}}]
                }
            ]
        }]
    });
    let rich_category_tpl = json!({
        "type": "doc",
        "content": [{
            "type": "paragraph",
            "attrs": {"id": "tpl-p1"},
            "content": [
                {
                    "type": "text",
                    "text": "模板参考札记",
                    "marks": [{"type": "entityLink", "attrs": {"targetKind": "material", "targetId": NOTE}}]
                },
                {"type": "text", "text": "："},
                {
                    "type": "text",
                    "text": "第一章首段",
                    "marks": [{"type": "entityLink", "attrs": {"targetKind": "node", "targetId": CHAPTER, "targetModule": MOD_PROSE, "targetBlockId": "p1"}}]
                }
            ]
        }]
    });

    let c = rusqlite::Connection::open(&old.db).unwrap();
    c.execute(
        "UPDATE entity_snapshot_history SET content_json=?1 WHERE id='h-3'",
        [rich_element_v1.to_string()],
    )
    .unwrap();
    c.execute(
        "UPDATE element SET content_json=?1 WHERE id=?2",
        rusqlite::params![rich_element_live.to_string(), ELEMENT],
    )
    .unwrap();
    c.execute(
        "UPDATE element_category SET element_template_json=?1 WHERE id=?2",
        rusqlite::params![rich_category_tpl.to_string(), CATEGORY],
    )
    .unwrap();
    drop(c);

    let before = source_tree_snapshot(&old.root);
    assert!(before.len() >= 3);
    let expected = manifest::read(&old.db, BOOK).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("library");
    let mut opts = options(&old);
    opts.accept = dr_import_v1::gate::Accept::EVERYTHING;
    let (outcome, _) = run::import(&old.db, &root, &opts).unwrap();
    let Outcome::Imported(receipt) = outcome else {
        panic!("expected imported")
    };
    assert_eq!(before, source_tree_snapshot(&old.root));
    assert!(
        receipt
            .docs
            .iter()
            .all(|d| d.stored_exactly && d.round_trips)
    );

    let lib = open(&root);
    let bytes = lib
        .load_copy(&format!("book:{BOOK}"))
        .unwrap()
        .export(loro::ExportMode::Snapshot)
        .unwrap();
    let book =
        BookDocV3::load(BookId::parse(BOOK).unwrap(), random_device_peer(), &[bytes]).unwrap();
    compare(&book.view(), &expected, &lib);

    let elem_doc_id = adapter::body_id(ELEMENT, MOD_PROSE);
    let elem_doc = load_prose(&lib, &elem_doc_id);
    assert_eq!(
        elem_doc.view().entity_links_v3(),
        vec![
            (
                0..2,
                EntityLinkV3 {
                    target: NOTE.into(),
                    kind: EntityKind::Entry,
                    module: None,
                    block: None,
                    end_block: None,
                }
            ),
            (
                3..7,
                EntityLinkV3 {
                    target: CHAPTER.into(),
                    kind: EntityKind::Entry,
                    module: Some(mid(MOD_PROSE)),
                    block: Some(BlockId::parse("q1").unwrap()),
                    end_block: Some(BlockId::parse("q2").unwrap()),
                }
            ),
            (
                8..12,
                EntityLinkV3 {
                    target: STORYLINE.into(),
                    kind: EntityKind::Entry,
                    module: Some(mid(MOD_DESCRIPTION)),
                    block: Some(BlockId::parse("s-p1").unwrap()),
                    end_block: None,
                }
            ),
            (
                13..17,
                EntityLinkV3 {
                    target: CATEGORY.into(),
                    kind: EntityKind::Entry,
                    module: Some(mid(MOD_DESCRIPTION)),
                    block: None,
                    end_block: None,
                }
            ),
        ]
    );

    // Historical frontier of element body preserves the v1 material link!
    let elem_hist = lib.history(&elem_doc_id.to_string()).unwrap();
    let v1_label = elem_hist.iter().find(|h| h.label == "periodic").unwrap();
    let elem_bytes = vec![
        lib.load_copy(&elem_doc_id.to_string())
            .unwrap()
            .export(loro::ExportMode::Snapshot)
            .unwrap(),
    ];
    let elem_at_v1 =
        dr_doc::prose::ProseReader::load_at(elem_doc_id, &elem_bytes, &v1_label.frontiers).unwrap();
    assert_eq!(
        elem_at_v1.view().entity_links_v3(),
        vec![(
            4..6,
            EntityLinkV3 {
                target: NOTE.into(),
                kind: EntityKind::Entry,
                module: None,
                block: None,
                end_block: None,
            }
        )]
    );

    // Category prose template preserves both material and explicit-module block links!
    let tpl_doc_id = DocId::Template(TemplateId::for_entry_module(
        book.view().book_id(),
        &adapter::category_template(CATEGORY),
        &mid(MOD_PROSE),
    ));
    let tpl_doc = load_prose(&lib, &tpl_doc_id);
    assert_eq!(
        tpl_doc.view().entity_links_v3(),
        vec![
            (
                0..6,
                EntityLinkV3 {
                    target: NOTE.into(),
                    kind: EntityKind::Entry,
                    module: None,
                    block: None,
                    end_block: None,
                }
            ),
            (
                7..12,
                EntityLinkV3 {
                    target: CHAPTER.into(),
                    kind: EntityKind::Entry,
                    module: Some(mid(MOD_PROSE)),
                    block: Some(BlockId::parse("p1").unwrap()),
                    end_block: None,
                }
            ),
        ]
    );
    lib.close().unwrap();
}

#[test]
fn non_empty_field_defaults_import_losslessly_in_live_and_historical_catalogs() {
    use serde_json::json;

    let old = fixture::build();
    let c = rusqlite::Connection::open(&old.db).unwrap();
    c.execute(
        "UPDATE entity_kv_entry SET value='二十五' WHERE id='kv-7'",
        [],
    )
    .unwrap();
    c.execute(
        "INSERT INTO entity_kv_entry (id, project_id, owner_kind, owner_id, namespace, key, value) VALUES ('kv-cat-job', ?1, 'element-category', ?2, 'element-template', '职业', '游民')",
        rusqlite::params![BOOK, CATEGORY],
    )
    .unwrap();
    c.execute(
        "UPDATE element_category SET element_template_kv_json=?1 WHERE id=?2",
        rusqlite::params![
            json!([
                {"key": "年龄", "value": "二十五"},
                {"key": "职业", "value": "游民"}
            ])
            .to_string(),
            CATEGORY
        ],
    )
    .unwrap();
    // Replay a historical snapshot on CATEGORY where default values were earlier ("二十" / "").
    let hist_meta = json!({
        "name": "人物",
        "elementTemplateKvJson": json!([
            {"key": "年龄", "value": "二十"},
            {"key": "职业", "value": ""}
        ]).to_string()
    });
    c.execute(
        "INSERT INTO entity_snapshot_history (id, project_id, entity_kind, entity_id, state_blob, content_json, meta_json, created_at) VALUES ('h-cat-1', ?1, 'category', ?2, X'00', ?3, ?4, '2026-09-30T08:00:00.000Z')",
        rusqlite::params![BOOK, CATEGORY, STORYLINE_JSON, hist_meta.to_string()],
    )
    .unwrap();
    drop(c);

    let before = source_tree_snapshot(&old.root);
    let expected = manifest::read(&old.db, BOOK).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("library");
    let mut opts = options(&old);
    opts.accept = dr_import_v1::gate::Accept::EVERYTHING;
    let (outcome, _) = run::import(&old.db, &root, &opts).unwrap();
    let Outcome::Imported(receipt) = outcome else {
        panic!("expected imported")
    };
    assert_eq!(before, source_tree_snapshot(&old.root));
    assert_eq!(receipt.books[0].history_meta_checked, 4);
    assert!(
        !receipt.books[0]
            .notes
            .0
            .contains_key("history-meta-differs")
    );

    let lib = open(&root);
    let book_copy = lib.load_copy(&format!("book:{BOOK}")).unwrap();
    let book_bytes = book_copy.export(loro::ExportMode::Snapshot).unwrap();
    let book = BookDocV3::load(
        BookId::parse(BOOK).unwrap(),
        random_device_peer(),
        std::slice::from_ref(&book_bytes),
    )
    .unwrap();
    compare(&book.view(), &expected, &lib);

    // Live template definitions carry the imported default values.
    let live_tpl = book
        .view()
        .template(&adapter::category_template(CATEGORY))
        .unwrap();
    let live_defs: std::collections::BTreeMap<_, _> = live_tpl
        .modules
        .iter()
        .flat_map(|m| &m.config.defs)
        .map(|d| (d.name.as_str(), d.default_value.clone()))
        .collect();
    assert_eq!(
        live_defs.get("年龄").cloned().flatten(),
        Some(FieldValue::Text("二十五".into()))
    );
    assert_eq!(
        live_defs.get("职业").cloned().flatten(),
        Some(FieldValue::Text("游民".into()))
    );

    // Existing imported elements retain their own authored values rather than template defaults.
    let elem = book.view().entry(&eid(ELEMENT)).unwrap();
    assert_eq!(text(&elem, "kv-7").as_deref(), Some("35"));
    assert_eq!(text(&elem, "kv-cat-job").as_deref(), Some("短工"));

    // Historical book frontier at h-cat-1 carries the historical default ("二十" and None)!
    let cat_doc_id = adapter::body_id(CATEGORY, MOD_DESCRIPTION);
    let cat_hist = lib.history(&cat_doc_id.to_string()).unwrap();
    let cat_label = cat_hist.iter().find(|h| h.label == "periodic").unwrap();
    let detached = dr_doc::v3::BookReaderV3::load_at(
        BookId::parse(BOOK).unwrap(),
        std::slice::from_ref(&book_bytes),
        cat_label
            .book_frontiers
            .as_ref()
            .expect("labels carry the book's version"),
    )
    .unwrap();
    let hist_tpl = detached
        .view()
        .template(&adapter::category_template(CATEGORY))
        .unwrap();
    let hist_defs: std::collections::BTreeMap<_, _> = hist_tpl
        .modules
        .iter()
        .flat_map(|m| &m.config.defs)
        .map(|d| (d.name.as_str(), d.default_value.clone()))
        .collect();
    assert_eq!(
        hist_defs.get("年龄").cloned().flatten(),
        Some(FieldValue::Text("二十".into()))
    );
    assert_eq!(hist_defs.get("职业").cloned().flatten(), None);
    lib.close().unwrap();
}

#[test]
fn marked_and_linked_legacy_table_cells_import_losslessly_across_profiles_templates_and_history() {
    use dr_model::prose::LINE_BREAK;
    use serde_json::json;

    let old = fixture::build();
    let elem_table_v1 = json!({
        "type": "doc",
        "content": [{
            "type": "table",
            "attrs": {"id": "tbl-elem"},
            "content": [{
                "type": "tableRow",
                "content": [
                    {
                        "type": "tableCell",
                        "content": [{
                            "type": "paragraph",
                            "content": [{
                                "type": "text",
                                "text": "旧格",
                                "marks": [{"type": "italic"}]
                            }]
                        }]
                    },
                    {
                        "type": "tableCell",
                        "content": [{
                            "type": "paragraph",
                            "content": [{"type": "text", "text": "将删列"}]
                        }]
                    }
                ]
            }]
        }]
    });
    let elem_table_live = json!({
        "type": "doc",
        "content": [{
            "type": "table",
            "attrs": {"id": "tbl-elem"},
            "content": [{
                "type": "tableRow",
                "content": [{
                    "type": "tableCell",
                    "content": [
                        {
                            "type": "paragraph",
                            "content": [
                                {
                                    "type": "text",
                                    "text": "赵太爷",
                                    "marks": [
                                        {"type": "bold"},
                                        {"type": "entityLink", "attrs": {"targetKind": "node", "targetId": CHAPTER, "targetBlockId": "q", "targetEndBlockId": "q"}}
                                    ]
                                },
                                {"type": "hardBreak", "marks": [{"type": "bold"}]},
                                {
                                    "type": "text",
                                    "text": "外链",
                                    "marks": [{"type": "underline"}, {"type": "link", "attrs": {"href": "https://example.com"}}]
                                }
                            ]
                        },
                        {
                            "type": "paragraph",
                            "content": [{
                                "type": "text",
                                "text": "札记链接",
                                "marks": [{"type": "strike"}, {"type": "entityLink", "attrs": {"targetKind": "library_item", "targetId": NOTE}}]
                            }]
                        }
                    ]
                }]
            }]
        }]
    });
    let note_with_table = json!({
        "type": "doc",
        "content": [
            {
                "type": "taskList",
                "attrs": {"id": "tl"},
                "content": [{
                    "type": "taskItem",
                    "attrs": {"id": "ti1", "checked": false, "todoId": NOTE_TODO},
                    "content": [{"type": "paragraph", "attrs": {"id": "tp1"}, "content": [{"type": "text", "text": "核对称呼"}]}]
                }]
            },
            {
                "type": "table",
                "attrs": {"id": "tbl-note"},
                "content": [{
                    "type": "tableRow",
                    "content": [{
                        "type": "tableCell",
                        "content": [{
                            "type": "paragraph",
                            "content": [
                                {"type": "text", "text": "高亮", "marks": [{"type": "highlight", "attrs": {"color": "#ff0"}}]},
                                {"type": "text", "text": "代码", "marks": [{"type": "code"}, {"type": "entityLink", "attrs": {"targetKind": "element", "targetId": ELEMENT, "targetModule": MOD_PROSE}}]}
                            ]
                        }]
                    }]
                }]
            }
        ]
    });
    let storyline_tpl_table = json!({
        "type": "doc",
        "content": [{
            "type": "table",
            "attrs": {"id": "tbl-tpl"},
            "content": [{
                "type": "tableRow",
                "content": [{
                    "type": "tableCell",
                    "content": [{
                        "type": "paragraph",
                        "content": [{
                            "type": "text",
                            "text": "模板人物格",
                            "marks": [
                                {"type": "bold"},
                                {"type": "entityLink", "attrs": {"targetKind": "element", "targetId": ELEMENT, "targetBlockId": "tbl-elem"}}
                            ]
                        }]
                    }]
                }]
            }]
        }]
    });

    let c = rusqlite::Connection::open(&old.db).unwrap();
    c.execute(
        "UPDATE entity_snapshot_history SET content_json=?1 WHERE id='h-3'",
        [elem_table_v1.to_string()],
    )
    .unwrap();
    c.execute(
        "UPDATE element SET content_json=?1 WHERE id=?2",
        rusqlite::params![elem_table_live.to_string(), ELEMENT],
    )
    .unwrap();
    c.execute(
        "UPDATE library_item SET body_json=?1 WHERE id=?2",
        rusqlite::params![note_with_table.to_string(), NOTE],
    )
    .unwrap();
    c.execute(
        "UPDATE storylines SET node_content_template_json=?1 WHERE id=?2",
        rusqlite::params![storyline_tpl_table.to_string(), STORYLINE],
    )
    .unwrap();
    drop(c);

    let before = source_tree_snapshot(&old.root);
    let expected = manifest::read(&old.db, BOOK).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("library");
    let mut opts = options(&old);
    opts.accept = dr_import_v1::gate::Accept::EVERYTHING;
    let (outcome, _) = run::import(&old.db, &root, &opts).unwrap();
    let Outcome::Imported(receipt) = outcome else {
        panic!("expected imported")
    };
    assert_eq!(before, source_tree_snapshot(&old.root));
    assert!(
        receipt
            .docs
            .iter()
            .all(|d| d.stored_exactly && d.round_trips)
    );
    assert!(
        !receipt.books[0]
            .notes
            .0
            .contains_key("history-version-differs")
    );

    let lib = open(&root);
    let bytes = lib
        .load_copy(&format!("book:{BOOK}"))
        .unwrap()
        .export(loro::ExportMode::Snapshot)
        .unwrap();
    let book =
        BookDocV3::load(BookId::parse(BOOK).unwrap(), random_device_peer(), &[bytes]).unwrap();
    compare(&book.view(), &expected, &lib);

    // 1. Live Prose-profile element table cell preserves bold, marked hardBreak, underline+link, joined paragraph break, and strike+material/block links!
    let elem_doc_id = adapter::body_id(ELEMENT, MOD_PROSE);
    let elem_doc = load_prose(&lib, &elem_doc_id);
    let tbl_elem = EmbedId::parse("tbl-elem").unwrap();
    let runs = elem_doc.view().table_cell(&tbl_elem, "r0", "c0").unwrap();
    let full_text: String = runs.iter().map(|r| r.text.as_str()).collect();
    assert_eq!(
        full_text,
        format!("赵太爷{LINE_BREAK}外链{LINE_BREAK}札记链接")
    );
    assert!(runs[0].marks.bold);
    assert!(runs.iter().any(|r| {
        r.text == "外链"
            && r.marks.underline
            && r.marks.link.as_deref() == Some("https://example.com")
    }));
    assert!(runs.iter().any(|r| r.text == "札记链接" && r.marks.strike));
    assert_eq!(
        elem_doc
            .view()
            .table_cell_entity_links_v3(&tbl_elem, "r0", "c0"),
        Some(vec![
            (
                0..3,
                EntityLinkV3 {
                    target: CHAPTER.into(),
                    kind: EntityKind::Entry,
                    module: Some(mid(MOD_PROSE)),
                    block: Some(BlockId::parse("q1").unwrap()),
                    end_block: Some(BlockId::parse("q2").unwrap()),
                }
            ),
            (
                7..11,
                EntityLinkV3 {
                    target: NOTE.into(),
                    kind: EntityKind::Entry,
                    module: None,
                    block: None,
                    end_block: None,
                }
            ),
        ])
    );

    // Historical v1 frontier of element table preserves italic cell and second column c1!
    let elem_hist = lib.history(&elem_doc_id.to_string()).unwrap();
    let v1_label = elem_hist.iter().find(|h| h.label == "periodic").unwrap();
    let elem_bytes = vec![
        lib.load_copy(&elem_doc_id.to_string())
            .unwrap()
            .export(loro::ExportMode::Snapshot)
            .unwrap(),
    ];
    let elem_v1 =
        dr_doc::prose::ProseReader::load_at(elem_doc_id, &elem_bytes, &v1_label.frontiers).unwrap();
    let v1_runs = elem_v1.view().table_cell(&tbl_elem, "r0", "c0").unwrap();
    assert_eq!(v1_runs[0].text, "旧格");
    assert!(v1_runs[0].marks.italic);
    assert_eq!(
        elem_v1.view().table_cell(&tbl_elem, "r0", "c1").unwrap()[0].text,
        "将删列"
    );

    // 2. Material note table cell preserves highlight + code + explicit-module entityLink!
    let note_doc_id = adapter::body_id(NOTE, MOD_PROSE);
    let note_doc = load_prose(&lib, &note_doc_id);
    let tbl_note = EmbedId::parse("tbl-note").unwrap();
    let note_runs = note_doc.view().table_cell(&tbl_note, "r0", "c0").unwrap();
    assert_eq!(note_runs[0].marks.highlight.as_deref(), Some("#ff0"));
    assert!(note_runs[1].marks.code);
    assert_eq!(
        note_doc
            .view()
            .table_cell_entity_links_v3(&tbl_note, "r0", "c0"),
        Some(vec![(
            2..4,
            EntityLinkV3 {
                target: ELEMENT.into(),
                kind: EntityKind::Entry,
                module: Some(mid(MOD_PROSE)),
                block: None,
                end_block: None,
            }
        )])
    );

    // 3. Storyline template table cell preserves bold + block link!
    let tpl_doc_id = DocId::Template(TemplateId::for_entry_module(
        book.view().book_id(),
        &adapter::storyline_template(STORYLINE),
        &mid(MOD_PROSE),
    ));
    let tpl_doc = load_prose(&lib, &tpl_doc_id);
    let tbl_tpl = EmbedId::parse("tbl-tpl").unwrap();
    let tpl_runs = tpl_doc.view().table_cell(&tbl_tpl, "r0", "c0").unwrap();
    assert!(tpl_runs[0].marks.bold);
    assert_eq!(
        tpl_doc
            .view()
            .table_cell_entity_links_v3(&tbl_tpl, "r0", "c0"),
        Some(vec![(
            0..5,
            EntityLinkV3 {
                target: ELEMENT.into(),
                kind: EntityKind::Entry,
                module: Some(mid(MOD_PROSE)),
                block: Some(BlockId::parse("tbl-elem").unwrap()),
                end_block: None,
            }
        )])
    );
    lib.close().unwrap();
}

#[test]
fn an_open_library_with_a_v2_deriver_is_not_given_v3_documents() {
    let old = fixture::build();
    let temp = tempfile::tempdir().unwrap();
    let mut config = LibraryOptions::new("k3-v3-test");
    dr_index::attach(&mut config);
    let lib = Library::open(temp.path(), config).unwrap();
    let error = run::import_into_library(&old.db, &lib, &options(&old), &mut |_| {}).unwrap_err();
    assert!(matches!(error, dr_import_v1::ImportError::Blocked(_)));
    assert!(lib.doc_info(&format!("book:{BOOK}")).unwrap().is_none());
    lib.close().unwrap();
}

#[test]
fn default_unaffiliated_lane_created_only_when_needed_and_placed_last_under_storylines() {
    use dr_import_v1::gate::Accept;

    // 1. Positive case: source has narrative-ordered unaffiliated chapter & idea,
    //    plus unaffiliated unplaced chapters (`CHAPTER_BEFORE`, `CHAPTER_UNPLACED`
    //    when unlinked), and no act drift binding -> imports with zero MappingChoices.
    let old = fixture::build();
    {
        let c = rusqlite::Connection::open(&old.db).unwrap();
        c.execute(
            "UPDATE book_act SET drift_node_id = NULL WHERE id = 'act-1'",
            [],
        )
        .unwrap();
        // Make CHAPTER_UNPLACED unaffiliated as well (still narrative_order = NULL)
        // to prove unplaced chapters never trigger or enter 未归属.
        c.execute(
            "DELETE FROM node_storyline_link WHERE node_id = ?1",
            [fixture::CHAPTER_UNPLACED],
        )
        .unwrap();
    }
    let before = source_tree_snapshot(&old.root);
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("library-with-unaffiliated");
    let mut opts = Options::new("k3-v3-test");
    opts.accept = Accept::EVERYTHING;
    opts.v3 = MappingChoices::default();
    opts.old_root = Some(old.root.clone());
    opts.verify_history = true;
    opts.index = false;

    let (outcome, _) = run::import(&old.db, &root, &opts).unwrap();
    assert!(matches!(outcome, Outcome::Imported(_)));
    assert_eq!(
        before,
        source_tree_snapshot(&old.root),
        "source bytes, sizes and mtimes must never change"
    );

    let lib = open(&root);
    let bytes = lib
        .load_copy(&format!("book:{BOOK}"))
        .unwrap()
        .export(loro::ExportMode::Snapshot)
        .unwrap();
    let book =
        BookDocV3::load(BookId::parse(BOOK).unwrap(), random_device_peer(), &[bytes]).unwrap();
    let view = book.view();
    adapter::validate(&view).unwrap();

    let storylines_root = view
        .root_entry_by_template(&tid(TPL_STORYLINES))
        .unwrap()
        .id;
    let manuscript_root = view
        .root_entry_by_template(&tid(TPL_MANUSCRIPT))
        .unwrap()
        .id;
    assert!(!storylines_root.as_str().starts_with("root-"));
    assert!(!manuscript_root.as_str().starts_with("root-"));

    let lane_children = view.children_of(Some(&storylines_root));
    assert_eq!(
        lane_children.len(),
        3,
        "two authored storylines then 未归属"
    );
    assert_eq!(lane_children[0].id.as_str(), fixture::STORYLINE_OTHER);
    assert_eq!(lane_children[1].id.as_str(), STORYLINE);
    let unaffiliated = &lane_children[2];
    assert_eq!(unaffiliated.title, "未归属");
    assert_eq!(unaffiliated.parent, Some(storylines_root.clone()));
    assert_eq!(unaffiliated.template, Some(tid(TPL_STORYLINE)));
    assert_eq!(unaffiliated.overrides, None);
    assert!(!unaffiliated.id.as_str().starts_with("root-"));
    assert_ne!(unaffiliated.id.as_str(), STORYLINE);
    assert_ne!(unaffiliated.id.as_str(), fixture::STORYLINE_OTHER);

    // Same template and level settings as standard imported storylines, with
    // home pointing at the actual returned manuscript root UUIDv7.
    let unaffiliated_settings = view.level_settings(Some(&unaffiliated.id));
    let other_settings = view.level_settings(Some(&eid(fixture::STORYLINE_OTHER)));
    assert_eq!(unaffiliated_settings, other_settings);
    assert_eq!(unaffiliated_settings.home, Some(manuscript_root.clone()));
    assert_eq!(
        unaffiliated_settings.default_template,
        Some(tid(TPL_CHAPTER))
    );
    let tpl_storyline = view.template(&tid(TPL_STORYLINE)).unwrap();
    assert_eq!(tpl_storyline.settings.home, Some(Some(manuscript_root)));
    let initial_kv = &tpl_storyline
        .modules
        .iter()
        .find(|m| m.id.as_str() == MOD_KV)
        .unwrap()
        .config
        .initial_kv;
    assert_eq!(initial_kv.len(), 1);
    assert_eq!(initial_kv[0].key, "目标");

    let act_track_id = view.root_entry_by_template(&tid(TPL_ACT_TRACK)).unwrap().id;
    let timeline = &view.timeline_views_raw()[0];
    assert_eq!(
        timeline
            .lanes
            .iter()
            .map(|l| l.entry.clone())
            .collect::<Vec<_>>(),
        [
            act_track_id,
            eid(fixture::STORYLINE_OTHER),
            eid(STORYLINE),
            unaffiliated.id.clone(),
        ]
    );

    // Unaffiliated narrative-ordered chapter & idea join 未归属 without primary,
    // keeping exact narrative placements.
    for (node_id, expected_at) in [(fixture::CHAPTER_UNAFFILIATED, 18.25), (IDEA, 12.0)] {
        let entry = view.entry(&eid(node_id)).unwrap();
        assert_eq!(entry.primary, None, "{node_id} must have no primary lane");
        let hosts: Vec<_> = view
            .memberships_raw()
            .into_iter()
            .filter(|m| m.member == entry.id)
            .map(|m| m.host)
            .collect();
        assert_eq!(hosts, std::slice::from_ref(&unaffiliated.id));
        assert!(
            timeline
                .placements
                .iter()
                .any(|p| p.entry == entry.id && p.at == expected_at && p.span.is_none())
        );
    }
    // Unaffiliated nodes WITHOUT narrative_order never join 未归属 or timeline placements.
    for unplaced in [fixture::CHAPTER_BEFORE, fixture::CHAPTER_UNPLACED] {
        assert!(
            !view
                .memberships_raw()
                .iter()
                .any(|m| m.member.as_str() == unplaced)
        );
        assert!(
            !timeline
                .placements
                .iter()
                .any(|p| p.entry.as_str() == unplaced)
        );
    }
    lib.close().unwrap();

    // 2. Negative case: when every narrative-ordered node belongs to at least one
    //    storyline (even if unaffiliated nodes without narrative_order exist),
    //    未归属 is NOT created at all.
    let old_no_unaff = fixture::build();
    {
        let c = rusqlite::Connection::open(&old_no_unaff.db).unwrap();
        c.execute(
            "UPDATE book_act SET drift_node_id = NULL WHERE id = 'act-1'",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO node_storyline_link (node_id, storyline_id, is_primary) VALUES (?1, ?2, 0)",
            rusqlite::params![fixture::CHAPTER_UNAFFILIATED, STORYLINE],
        )
        .unwrap();
        c.execute(
            "UPDATE book_node SET narrative_order = NULL WHERE id = ?1",
            [IDEA],
        )
        .unwrap();
    }
    let before_no_unaff = source_tree_snapshot(&old_no_unaff.root);
    let root_no_unaff = temp.path().join("library-without-unaffiliated");
    let mut opts_no_unaff = opts.clone();
    opts_no_unaff.old_root = Some(old_no_unaff.root.clone());
    let (outcome, _) = run::import(&old_no_unaff.db, &root_no_unaff, &opts_no_unaff).unwrap();
    assert!(matches!(outcome, Outcome::Imported(_)));
    assert_eq!(
        before_no_unaff,
        source_tree_snapshot(&old_no_unaff.root),
        "source bytes, sizes and mtimes must never change"
    );

    let lib_no_unaff = open(&root_no_unaff);
    let bytes = lib_no_unaff
        .load_copy(&format!("book:{BOOK}"))
        .unwrap()
        .export(loro::ExportMode::Snapshot)
        .unwrap();
    let book_no_unaff =
        BookDocV3::load(BookId::parse(BOOK).unwrap(), random_device_peer(), &[bytes]).unwrap();
    let view_no_unaff = book_no_unaff.view();
    adapter::validate(&view_no_unaff).unwrap();
    assert!(
        !view_no_unaff
            .entries_raw()
            .iter()
            .any(|e| e.title == "未归属"),
        "未归属 must not be created when no narrative-ordered unaffiliated node exists"
    );
    let sl_root = view_no_unaff
        .root_entry_by_template(&tid(TPL_STORYLINES))
        .unwrap()
        .id;
    assert_eq!(
        view_no_unaff
            .children_of(Some(&sl_root))
            .iter()
            .map(|e| e.id.as_str())
            .collect::<Vec<_>>(),
        [fixture::STORYLINE_OTHER, STORYLINE]
    );
    let act_track_no_unaff = view_no_unaff
        .root_entry_by_template(&tid(TPL_ACT_TRACK))
        .unwrap()
        .id;
    assert_eq!(
        view_no_unaff.timeline_views_raw()[0]
            .lanes
            .iter()
            .map(|l| l.entry.as_str())
            .collect::<Vec<_>>(),
        [
            act_track_no_unaff.as_str(),
            fixture::STORYLINE_OTHER,
            STORYLINE
        ]
    );
    lib_no_unaff.close().unwrap();
}

#[test]
fn default_relation_type_endpoints_dedup_leave_templates_empty_and_preserve_legacy_kinds_in_receipt()
 {
    use dr_import_v1::gate::Accept;

    const RT_ALL_KINDS: &str = "custom-rt-all-seven-legacy-kinds";
    let old = fixture::build();
    {
        let c = rusqlite::Connection::open(&old.db).unwrap();
        c.execute(
            "UPDATE book_act SET drift_node_id = NULL WHERE id = 'act-1'",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO entity_relation_type (id, project_id, name, normalized_name, description, orientation, system_key, locked, source_role, target_role, created_at, updated_at) VALUES (?1, ?2, '全端点测试', '全端点测试', '覆盖七种旧端点', 'directed', NULL, 0, '起', '止', ?3, ?3)",
            rusqlite::params![RT_ALL_KINDS, BOOK, T0],
        )
        .unwrap();
        for kind in [
            "node",
            "element",
            "category",
            "storyline",
            "patch",
            "comment",
            "library_item",
        ] {
            c.execute(
                "INSERT INTO entity_relation_type_endpoint_kind (relation_type_id, side, entity_kind) VALUES (?1, 'source', ?2)",
                rusqlite::params![RT_ALL_KINDS, kind],
            )
            .unwrap();
        }
        for kind in ["node", "element", "category", "storyline", "patch"] {
            c.execute(
                "INSERT INTO entity_relation_type_endpoint_kind (relation_type_id, side, entity_kind) VALUES (?1, 'target', ?2)",
                rusqlite::params![RT_ALL_KINDS, kind],
            )
            .unwrap();
        }
    }

    let before = source_tree_snapshot(&old.root);
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("library-relation-types");
    let mut opts = Options::new("k3-v3-test");
    opts.accept = Accept::EVERYTHING;
    opts.v3 = MappingChoices::default();
    opts.old_root = Some(old.root.clone());
    opts.verify_history = true;
    opts.index = false;

    let (outcome, _) = run::import(&old.db, &root, &opts).unwrap();
    let Outcome::Imported(receipt) = outcome else {
        panic!("expected default relation-type import to succeed")
    };
    assert_eq!(
        before,
        source_tree_snapshot(&old.root),
        "source bytes, sizes and mtimes must never change"
    );

    let lib = open(&root);
    let bytes = lib
        .load_copy(&format!("book:{BOOK}"))
        .unwrap()
        .export(loro::ExportMode::Snapshot)
        .unwrap();
    let book =
        BookDocV3::load(BookId::parse(BOOK).unwrap(), random_device_peer(), &[bytes]).unwrap();
    let view = book.view();
    adapter::validate(&view).unwrap();

    // 1. Custom relation type with all 7 legacy kinds: mapped + deduplicated, templates empty.
    let all_rt = view
        .relation_type(&RelationTypeId::parse(RT_ALL_KINDS).unwrap())
        .unwrap();
    assert_eq!(
        all_rt.source_kinds,
        [
            EntityKind::Patch,
            EntityKind::Entry,
            EntityKind::Comment,
            EntityKind::Asset,
        ],
        "node/element/category/storyline collapse to Entry and library_item expands to Entry + Asset alongside Patch and Comment"
    );
    assert_eq!(
        all_rt.target_kinds,
        [EntityKind::Patch, EntityKind::Entry],
        "node/element/category/storyline collapse to one Entry alongside Patch"
    );
    assert!(all_rt.source_templates.is_empty());
    assert!(all_rt.target_templates.is_empty());

    // 2. Fixture custom relation types also have mapped kinds and empty template lists.
    let rel_rt = view
        .relation_type(&RelationTypeId::parse(REL_TYPE).unwrap())
        .unwrap();
    assert_eq!(rel_rt.source_kinds, [EntityKind::Entry]);
    assert_eq!(rel_rt.target_kinds, [EntityKind::Entry]);
    assert!(rel_rt.source_templates.is_empty());
    assert!(rel_rt.target_templates.is_empty());

    let patch_rt = view
        .relation_type(&RelationTypeId::parse(fixture::PATCH_RELATION).unwrap())
        .unwrap();
    assert_eq!(patch_rt.source_kinds, [EntityKind::Patch]);
    assert_eq!(patch_rt.target_kinds, [EntityKind::Entry]);
    assert!(patch_rt.source_templates.is_empty());
    assert!(patch_rt.target_templates.is_empty());

    // 3. Built-in generic-association relation type stays completely untouched.
    let generic_id = dr_doc::catalog::generic_relation_type_id(&BookId::parse(BOOK).unwrap());
    let generic = view.relation_type(&generic_id).unwrap();
    assert!(generic.locked);
    assert_eq!(
        generic.system_key,
        Some(SystemRelationKey::GenericAssociation)
    );
    assert_eq!(
        generic.source_kinds,
        [EntityKind::Comment, EntityKind::Entry, EntityKind::Asset]
    );
    assert_eq!(
        generic.target_kinds,
        [EntityKind::Entry, EntityKind::Patch, EntityKind::Asset]
    );
    assert!(generic.source_templates.is_empty());
    assert!(generic.target_templates.is_empty());
    lib.close().unwrap();

    // 4. Verbatim legacy endpoint kinds are preserved in receipt.originals AND
    //    durably stored in import_original (`collection = 'relation_types'`),
    //    while the built-in generic-association type is never recorded there.
    let want_originals = [
        (
            RT_ALL_KINDS.to_owned(),
            "source_kinds".to_owned(),
            vec![
                "category",
                "comment",
                "element",
                "library_item",
                "node",
                "patch",
                "storyline",
            ],
        ),
        (
            RT_ALL_KINDS.to_owned(),
            "target_kinds".to_owned(),
            vec!["category", "element", "node", "patch", "storyline"],
        ),
        (
            fixture::PATCH_RELATION.to_owned(),
            "source_kinds".to_owned(),
            vec!["patch"],
        ),
        (
            fixture::PATCH_RELATION.to_owned(),
            "target_kinds".to_owned(),
            vec!["storyline"],
        ),
        (
            REL_TYPE.to_owned(),
            "source_kinds".to_owned(),
            vec!["element"],
        ),
        (
            REL_TYPE.to_owned(),
            "target_kinds".to_owned(),
            vec!["element"],
        ),
    ];

    let mut receipt_rt: Vec<(String, String, Vec<String>)> = receipt
        .originals
        .iter()
        .filter(|(c, _, _, _)| c == "relation_types")
        .map(|(_, id, field, json)| {
            let mut kinds: Vec<String> = serde_json::from_str(json).unwrap();
            kinds.sort();
            (id.clone(), field.clone(), kinds)
        })
        .collect();
    receipt_rt.sort_by(|a, b| (&a.0, &a.1).cmp(&(&b.0, &b.1)));
    let mut expected_sorted: Vec<(String, String, Vec<String>)> = want_originals
        .iter()
        .map(|(id, f, ks)| {
            (
                id.clone(),
                f.clone(),
                ks.iter().map(|s| (*s).to_owned()).collect(),
            )
        })
        .collect();
    expected_sorted.sort_by(|a, b| (&a.0, &a.1).cmp(&(&b.0, &b.1)));
    assert_eq!(receipt_rt, expected_sorted);

    let target_db = dr_store::LibraryPaths::new(&root).db;
    let conn = rusqlite::Connection::open(&target_db).unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT id, field, json FROM import_original
             WHERE collection = 'relation_types'
             ORDER BY id, field",
        )
        .unwrap();
    let stored: Vec<(String, String, Vec<String>)> = stmt
        .query_map([], |r| {
            let json: String = r.get(2)?;
            let mut kinds: Vec<String> = serde_json::from_str(&json).unwrap();
            kinds.sort();
            Ok((r.get(0)?, r.get(1)?, kinds))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(stored, expected_sorted);
    assert!(
        !stored.iter().any(|(id, _, _)| id == generic_id.as_str()),
        "built-in relation type must not be written into import_original"
    );
}

#[test]
fn act_track_imports_all_eight_cases_preserves_color_and_leaves_source_untouched() {
    use dr_import_v1::gate::Accept;

    // Part A: when a legacy book has NO acts, no act track or TPL_ACT_TRACK is created.
    let old_no_acts = fixture::build();
    {
        let c = rusqlite::Connection::open(&old_no_acts.db).unwrap();
        c.execute("DELETE FROM book_act", []).unwrap();
    }
    let before_no_acts = source_tree_snapshot(&old_no_acts.root);
    let temp = tempfile::tempdir().unwrap();
    let root_no_acts = temp.path().join("library-no-acts");
    let mut opts_no_acts = Options::new("k3-v3-test");
    opts_no_acts.accept = Accept::EVERYTHING;
    opts_no_acts.v3 = MappingChoices::default();
    opts_no_acts.old_root = Some(old_no_acts.root.clone());
    opts_no_acts.verify_history = true;
    opts_no_acts.index = false;
    let (outcome_no_acts, _) = run::import(&old_no_acts.db, &root_no_acts, &opts_no_acts).unwrap();
    assert!(matches!(outcome_no_acts, Outcome::Imported(_)));
    assert_eq!(
        before_no_acts,
        source_tree_snapshot(&old_no_acts.root),
        "source bytes, sizes and mtimes must never change"
    );
    let lib_no_acts = open(&root_no_acts);
    let bytes_no_acts = lib_no_acts
        .load_copy(&format!("book:{BOOK}"))
        .unwrap()
        .export(loro::ExportMode::Snapshot)
        .unwrap();
    let book_no_acts = BookDocV3::load(
        BookId::parse(BOOK).unwrap(),
        random_device_peer(),
        &[bytes_no_acts],
    )
    .unwrap();
    let view_no_acts = book_no_acts.view();
    adapter::validate(&view_no_acts).unwrap();
    // The 幕 template comes with every book; no act track is created.
    assert!(view_no_acts.template(&tid(TPL_ACT_TRACK)).is_some());
    assert!(
        view_no_acts
            .root_entry_by_template(&tid(TPL_ACT_TRACK))
            .is_none()
    );
    assert!(
        !view_no_acts
            .entries_raw()
            .iter()
            .any(|e| e.parent.is_none() && e.title == "幕")
    );
    assert!(
        view_no_acts.timeline_views_raw()[0]
            .lanes
            .iter()
            .all(|l| l.act_track.is_none())
    );
    lib_no_acts.close().unwrap();

    // Part B: comprehensive 8-case book:
    //   1. 绑定 (`act-bound` -> live unplaced `idea-bound`)
    //   2. 未绑定 (`act-unbound` -> `drift_node_id = NULL`)
    //   3. 构想已删除 (`act-missing` hard-deleted + `act-trashed` soft-deleted `deleted_at`)
    //   4. 一个构想绑多个幕 (`act-shared-1` & `act-shared-2` both bound to `idea-shared`)
    //   5. 空幕 (`act-empty` with zero chapters)
    //   6. 章节没有位置 (`act-unplaced` whose chapter has `narrative_order = NULL`)
    //   7. 构想原来就有位置 (`act-placed-idea` bound to `IDEA` at `12.0`)
    //   8. 重叠 (`act-bound` [10, 22] overlapping `act-unbound` [14, 24])
    //   Plus: placed chapter before first act (`CHAPTER_BEFORE` at book_order -5, narrative 2)
    //   generates NO act entry, and manuscript act groups remain intact.
    const IDEA_BOUND: &str = "01900000-0000-7000-8000-0000000000d3";
    const IDEA_TRASHED: &str = "01900000-0000-7000-8000-0000000000d4";
    const IDEA_SHARED: &str = "01900000-0000-7000-8000-0000000000d5";
    const IDEA_MISSING: &str = "01900000-0000-7000-8000-0000000000d9";

    let old = fixture::build();
    {
        let c = rusqlite::Connection::open(&old.db).unwrap();
        c.pragma_update(None, "foreign_keys", false).unwrap();
        c.execute("DELETE FROM book_act", []).unwrap();
        // Give CHAPTER_BEFORE a narrative placement before the first act to verify
        // pre-first-act chapters still never generate an act entry.
        c.execute(
            "UPDATE book_node SET narrative_order = 2.0 WHERE id = ?1",
            [fixture::CHAPTER_BEFORE],
        )
        .unwrap();
        c.execute(
            "INSERT INTO node_storyline_link (node_id, storyline_id, is_primary) VALUES (?1, ?2, 1)",
            rusqlite::params![fixture::CHAPTER_BEFORE, STORYLINE],
        )
        .unwrap();

        for (id, title, group, deleted_at) in [
            (IDEA_BOUND, "幕绑定构想", Some(SUBGROUP), None),
            (IDEA_TRASHED, "已删幕构想", Some(GROUP), Some(T1)),
            (IDEA_SHARED, "多幕共用构想", Some(GROUP), None),
        ] {
            c.execute(
                "INSERT INTO book_node (id, project_id, title, summary, book_order, narrative_order, writing_status, kind, drift_group_id, position_x, position_y, deleted_at, created_at, updated_at)
                 VALUES (?1, ?2, ?3, '', NULL, NULL, 'drifting', 'drift', ?4, 15.0, -25.0, ?5, ?6, ?6)",
                rusqlite::params![id, BOOK, title, group, deleted_at, T0],
            )
            .unwrap();
            c.execute(
                "INSERT INTO node_content (node_id, content_json, created_at, updated_at) VALUES (?1, '{}', ?2, ?2)",
                rusqlite::params![id, T0],
            )
            .unwrap();
        }

        for (id, name, color, start_order, drift) in [
            (
                "act-bound",
                "第一幕·绑定",
                Some("#aa0000"),
                0.0,
                Some(IDEA_BOUND),
            ),
            ("act-unbound", "第二幕·未绑", Some("#bb1100"), 10.0, None),
            (
                "act-missing",
                "第三幕·硬删构想",
                Some("#cc2200"),
                20.0,
                Some(IDEA_MISSING),
            ),
            (
                "act-trashed",
                "第四幕·回收站构想",
                Some("#dd3300"),
                30.0,
                Some(IDEA_TRASHED),
            ),
            (
                "act-shared-1",
                "第五幕·共用甲",
                Some("#ee4400"),
                40.0,
                Some(IDEA_SHARED),
            ),
            (
                "act-shared-2",
                "第六幕·共用乙",
                Some("#ff5500"),
                50.0,
                Some(IDEA_SHARED),
            ),
            ("act-empty", "第七幕·空幕", None, 60.0, None),
            ("act-unplaced", "第八幕·无位置章节", None, 70.0, None),
            (
                "act-placed-idea",
                "第九幕·已有位置构想",
                Some("#1166aa"),
                80.0,
                Some(IDEA),
            ),
        ] {
            c.execute(
                "INSERT INTO book_act (id, project_id, name, color, start_order, drift_node_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                rusqlite::params![id, BOOK, name, color, start_order, drift, T0],
            )
            .unwrap();
        }

        // Reuse existing fixture chapters in act-bound (CHAPTER at book_order=5, narrative=10;
        // CHAPTER_UNPLACED at book_order=12 -> move to 8, narrative=NULL) and act-unbound
        // (CHAPTER_UNAFFILIATED at book_order=25 -> move to 15, narrative=20.0), then add the rest.
        c.execute(
            "UPDATE book_node SET book_order = 8.0 WHERE id = ?1",
            [fixture::CHAPTER_UNPLACED],
        )
        .unwrap();
        c.execute(
            "UPDATE book_node SET book_order = 15.0, narrative_order = 20.0 WHERE id = ?1",
            [fixture::CHAPTER_UNAFFILIATED],
        )
        .unwrap();

        for (id, title, book_order, narrative_order) in [
            (
                "01900000-0000-7000-8000-0000000000c5",
                "绑定幕末章",
                6.0,
                Some(18.0),
            ),
            (
                "01900000-0000-7000-8000-0000000000c6",
                "未绑幕首章",
                12.0,
                Some(14.0),
            ),
            (
                "01900000-0000-7000-8000-0000000000c7",
                "硬删幕章",
                22.0,
                Some(30.0),
            ),
            (
                "01900000-0000-7000-8000-0000000000c8",
                "回收站幕章",
                32.0,
                Some(36.0),
            ),
            (
                "01900000-0000-7000-8000-0000000000c9",
                "共用甲章",
                42.0,
                Some(42.0),
            ),
            (
                "01900000-0000-7000-8000-0000000000ca",
                "共用乙章",
                52.0,
                Some(50.0),
            ),
            (
                "01900000-0000-7000-8000-0000000000cb",
                "无叙事序幕章",
                72.0,
                None,
            ),
            (
                "01900000-0000-7000-8000-0000000000cc",
                "已摆构想幕章",
                82.0,
                Some(60.0),
            ),
        ] {
            c.execute(
                "INSERT INTO book_node (id, project_id, title, summary, book_order, narrative_order, writing_status, kind, position_x, position_y, created_at, updated_at)
                 VALUES (?1, ?2, ?3, '', ?4, ?5, 'draft', 'chapter', 0.0, 0.0, ?6, ?6)",
                rusqlite::params![id, BOOK, title, book_order, narrative_order, T0],
            )
            .unwrap();
            c.execute(
                "INSERT INTO node_content (node_id, content_json, created_at, updated_at) VALUES (?1, '{}', ?2, ?2)",
                rusqlite::params![id, T0],
            )
            .unwrap();
            c.execute(
                "INSERT INTO node_storyline_link (node_id, storyline_id, is_primary) VALUES (?1, ?2, 1)",
                rusqlite::params![id, STORYLINE],
            )
            .unwrap();
        }
    }

    let before = source_tree_snapshot(&old.root);
    let root = temp.path().join("library-eight-cases");
    let mut opts = Options::new("k3-v3-test");
    opts.accept = Accept::EVERYTHING;
    opts.v3 = MappingChoices::default();
    opts.old_root = Some(old.root.clone());
    opts.verify_history = true;
    opts.index = false;

    let (outcome, _) = run::import(&old.db, &root, &opts).unwrap();
    let Outcome::Imported(receipt) = outcome else {
        panic!("expected default 8-case act-track import to succeed")
    };
    assert_eq!(
        before,
        source_tree_snapshot(&old.root),
        "source bytes, sizes and mtimes must never change"
    );

    // Report notes recorded in both structured Receipt and import-v1/summary.md.
    let book_rec = receipt.books.iter().find(|b| b.book_id == BOOK).unwrap();
    assert_eq!(
        book_rec
            .notes
            .0
            .get("act-binding-shared-idea-split")
            .copied(),
        Some(1)
    );
    assert_eq!(
        book_rec
            .notes
            .0
            .get("act-binding-kept-existing-placement")
            .copied(),
        Some(1)
    );
    let summary_md = std::fs::read_to_string(root.join("import-v1").join("summary.md")).unwrap();
    assert!(summary_md.contains("act-binding-shared-idea-split"));
    assert!(summary_md.contains("act-binding-kept-existing-placement"));

    let lib = open(&root);
    let bytes = lib
        .load_copy(&format!("book:{BOOK}"))
        .unwrap()
        .export(loro::ExportMode::Snapshot)
        .unwrap();
    let book =
        BookDocV3::load(BookId::parse(BOOK).unwrap(), random_device_peer(), &[bytes]).unwrap();
    let view = book.view();
    adapter::validate(&view).unwrap();

    // No outline / act-binding relation created.
    assert!(
        !view
            .relation_types()
            .iter()
            .any(|rt| rt.name == "大纲" || rt.id.as_str().contains("act"))
    );
    assert!(
        !view
            .relations_raw()
            .iter()
            .any(|r| r.id.as_str().starts_with("import-act-binding-"))
    );

    // Top-level "幕" act track level & default view lane[0].
    let act_track = view
        .root_entry_by_template(&tid(TPL_ACT_TRACK))
        .expect("root act track");
    assert_eq!(act_track.title, "幕");
    assert_eq!(act_track.parent, None);
    assert!(!act_track.id.as_str().starts_with("root-"));
    assert!(dr_model::v3::is_in_any_view(
        &act_track.id,
        &view.timeline_views_raw(),
        &view.entries_map(),
        &view.templates_map(),
    ));
    let act_settings = view.level_settings(Some(&act_track.id));
    assert_eq!(act_settings.default_template, Some(tid(TPL_IDEA)));
    assert_eq!(act_settings.home, None);
    assert!(act_settings.accept);

    let timeline = &view.timeline_views_raw()[0];
    assert_eq!(timeline.lanes[0].entry, act_track.id);
    assert_eq!(timeline.lanes[0].act_track, Some(true));
    assert!(timeline.lanes[1..].iter().all(|l| l.act_track.is_none()));

    // Manuscript act groups under 书稿 remain intact, with CHAPTER_BEFORE first.
    let manuscript_root = view
        .root_entry_by_template(&tid(TPL_MANUSCRIPT))
        .unwrap()
        .id;
    assert_eq!(
        view.children_of(Some(&manuscript_root))
            .iter()
            .map(|e| e.id.as_str())
            .collect::<Vec<_>>(),
        [
            fixture::CHAPTER_BEFORE,
            "act-bound",
            "act-unbound",
            "act-missing",
            "act-trashed",
            "act-shared-1",
            "act-shared-2",
            "act-empty",
            "act-unplaced",
            "act-placed-idea",
        ]
    );

    // Synthetic entries residing directly under "幕" (6 acts: unbound, missing,
    // trashed, shared-2, empty, unplaced). Pre-first-act CHAPTER_BEFORE creates none.
    let synth_children = view.children_of(Some(&act_track.id));
    assert_eq!(
        synth_children
            .iter()
            .map(|e| e.title.as_str())
            .collect::<Vec<_>>(),
        [
            "第二幕·未绑",
            "第三幕·硬删构想",
            "第四幕·回收站构想",
            "第六幕·共用乙",
            "第七幕·空幕",
            "第八幕·无位置章节",
        ]
    );
    for child in &synth_children {
        assert_eq!(child.parent, Some(act_track.id.clone()));
        assert_eq!(child.template, Some(tid(TPL_IDEA)));
        assert_eq!(child.deleted_at, None);
    }

    // Reused live ideas keep their original homes unchanged!
    assert_eq!(
        view.entry(&eid(IDEA_BOUND)).unwrap().parent,
        Some(eid(SUBGROUP))
    );
    assert_eq!(
        view.entry(&eid(IDEA_SHARED)).unwrap().parent,
        Some(eid(GROUP))
    );
    assert_eq!(view.entry(&eid(IDEA)).unwrap().parent, Some(eid(SUBGROUP)));
    // Soft-trashed idea was NOT bound into the act track.
    assert!(
        !view
            .memberships_raw()
            .iter()
            .any(|m| m.host == act_track.id && m.member == eid(IDEA_TRASHED))
    );

    // Memberships on "幕" omit `pos` (`VIEW-LANE-MEMBERS-PLACED`) and `members_of`
    // reads all 9 acts in narrative-view scale order.
    let track_members: Vec<_> = view
        .memberships_raw()
        .into_iter()
        .filter(|m| m.host == act_track.id)
        .collect();
    assert_eq!(track_members.len(), 9);
    assert!(track_members.iter().all(|m| m.pos.is_none()));
    let expected_scale_order = [
        eid(IDEA_BOUND),
        eid(IDEA),
        synth_children[0].id.clone(),
        synth_children[1].id.clone(),
        synth_children[2].id.clone(),
        eid(IDEA_SHARED),
        synth_children[3].id.clone(),
        synth_children[4].id.clone(),
        synth_children[5].id.clone(),
    ];
    assert_eq!(
        view.structure_snapshot()
            .members_of(&act_track.id)
            .into_iter()
            .map(|e| e.id.clone())
            .collect::<Vec<_>>(),
        expected_scale_order
    );

    let placement_of = |id: &EntryId| -> Option<(f64, Option<f64>)> {
        timeline
            .placements
            .iter()
            .find(|p| &p.entry == id)
            .map(|p| (p.at, p.span))
    };

    // Case 1 (`绑定`) + Case 8 (`重叠` with Case 2): chapters at 10.0 and 18.0 -> [10.0, 22.0] => (10.0, Some(12.0))
    assert_eq!(placement_of(&eid(IDEA_BOUND)), Some((10.0, Some(12.0))));
    // Case 2 (`未绑定`) + Case 8 (`重叠`): chapters at 14.0 and 20.0 -> [14.0, Some(10.0)]
    assert_eq!(
        placement_of(&synth_children[0].id),
        Some((14.0, Some(10.0)))
    );
    // Case 3a (`构想已删除` hard-missing): chapter at 30.0 -> (30.0, Some(4.0))
    assert_eq!(placement_of(&synth_children[1].id), Some((30.0, Some(4.0))));
    // Case 3b (`构想已删除` soft-trashed): chapter at 36.0 -> (36.0, Some(4.0))
    assert_eq!(placement_of(&synth_children[2].id), Some((36.0, Some(4.0))));
    // Case 4 (`一个构想绑多个幕`): earliest act reuses IDEA_SHARED at (42.0, Some(4.0));
    // second act creates synth_children[3] at (50.0, Some(4.0)).
    assert_eq!(placement_of(&eid(IDEA_SHARED)), Some((42.0, Some(4.0))));
    assert_eq!(placement_of(&synth_children[3].id), Some((50.0, Some(4.0))));
    // Case 5 (`空幕`) & Case 6 (`章节没有位置`): auto-placed at scale end (`VIEW-LANE-MEMBERS-PLACED`).
    assert_eq!(placement_of(&synth_children[4].id), Some((61.0, None)));
    assert_eq!(placement_of(&synth_children[5].id), Some((62.0, None)));
    // Case 7 (`构想原来就有位置`): keeps original (12.0, None) without overwriting with (60.0, Some(4.0))!
    assert_eq!(placement_of(&eid(IDEA)), Some((12.0, None)));

    lib.close().unwrap();

    // Part C: when the act-track leaf template declares `color_field`, synthetic
    // act entries carry over `act.color` via that `color_field` interface.
    let mut seeded = dr_samples::a_q().unwrap();
    let act_colored = ActId::parse("sample-act-colored").unwrap();
    seeded
        .book
        .edit(dr_model::Origin::Import, |t| {
            t.act(&act_colored)?
                .name("彩幕")?
                .color(Some("#336699"))?
                .start_order(Some(0.0))?;
            Ok(())
        })
        .0
        .unwrap();
    let mut colored_doc =
        BookDocV3::create(seeded.book.book_id().clone(), random_device_peer()).unwrap();
    colored_doc
        .edit(dr_model::Origin::Import, |t| {
            apply_novel_project_template(t)?;
            let mut colored_leaf = t.view().template(&tid(TPL_IDEA)).unwrap();
            colored_leaf.id = tid("tpl-colored-act-leaf");
            let fields_mod = colored_leaf
                .modules
                .iter_mut()
                .find(|m| m.id == mid(MOD_FIELDS))
                .unwrap();
            fields_mod.config.defs.push(FieldDef {
                id: "act_color".into(),
                name: "幕色".into(),
                field_type: FieldType::Text,
                options: Vec::new(),
                target_template: None,
                default_value: None,
                pos: None,
            });
            fields_mod.config.color_field = Some("act_color".into());
            t.template(&colored_leaf.id)?.set_full(&colored_leaf)?;

            let mut custom_track = dr_doc::v3::act_track_template();
            custom_track.settings.default_template = Some(Some(colored_leaf.id.clone()));
            t.template(&custom_track.id)?.set_full(&custom_track)?;

            adapter::sync_catalog(t, &seeded.book.view(), &MappingChoices::default())
        })
        .0
        .unwrap();
    let cview = colored_doc.view();
    let ctrack = cview.root_entry_by_template(&tid(TPL_ACT_TRACK)).unwrap();
    let cleaf = cview
        .children_of(Some(&ctrack.id))
        .into_iter()
        .find(|e| e.title == "彩幕")
        .expect("synthetic colored act leaf");
    assert_eq!(text(&cleaf, "act_color").as_deref(), Some("#336699"));
}

#[test]
fn unified_entry_v4_side_documents_summary_copy_and_format3_resume_guard() {
    // 1. Even when a 0.1 book has zero writing_day rows, both `stats:<book>` and
    //    `checkpoints:<book>` are stored at their deterministic genesis only,
    //    `summary_zh` reflects the unified-entry model without retired template
    //    split terms, and the source directory stays untouched (bytes + mtime).
    let old = fixture::build();
    {
        let c = rusqlite::Connection::open(&old.db).unwrap();
        c.execute("DELETE FROM writing_day", []).unwrap();
    }
    let before = source_tree_snapshot(&old.root);
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("library-zero-writing-days");
    let (outcome, _) = run::import(&old.db, &root, &options(&old)).unwrap();
    let Outcome::Imported(receipt) = outcome else {
        panic!("expected imported")
    };
    assert_eq!(
        source_tree_snapshot(&old.root),
        before,
        "source bytes, sizes and mtimes must never change"
    );

    let summary_md = std::fs::read_to_string(root.join("import-v1").join("summary.md")).unwrap();
    assert_eq!(summary_md, dr_import_v1::receipt::summary_zh(&receipt));
    assert!(summary_md.contains("条目模板的初始正文，新建条目照它开头"));
    for banned in [
        "层级模板",
        "叶子模板",
        "层级模版",
        "叶子模版",
        "leaf template",
        "level template",
        "v2",
        "v3",
    ] {
        assert!(
            !summary_md.contains(banned),
            "summary.md must not mention {banned:?}: {summary_md}"
        );
    }

    let book_id = BookId::parse(BOOK).unwrap();
    let lib = open(&root);
    let stats_vv = {
        let h = lib
            .open_doc(&format!("stats:{BOOK}"), dr_store::OpenDoc::Existing)
            .unwrap();
        let b = book_id.clone();
        let (days, vv) = h
            .read(move |d| {
                let days = dr_doc::side::BorrowedStats::new(d, &b)
                    .unwrap()
                    .view()
                    .writing_days();
                (days, d.oplog_vv())
            })
            .unwrap();
        h.close();
        assert!(days.is_empty());
        vv
    };
    let fresh_stats =
        dr_doc::side::StatsDoc::create(book_id.clone(), random_device_peer()).unwrap();
    assert_eq!(stats_vv, fresh_stats.version());

    let cp_vv = {
        let h = lib
            .open_doc(&format!("checkpoints:{BOOK}"), dr_store::OpenDoc::Existing)
            .unwrap();
        let b = book_id.clone();
        let (entries, vv) = h
            .read(move |d| {
                let entries = dr_doc::side::BorrowedCheckpoints::new(d, &b)
                    .unwrap()
                    .view()
                    .entry_checkpoints();
                (entries, d.oplog_vv())
            })
            .unwrap();
        h.close();
        assert!(entries.is_empty());
        vv
    };
    let fresh_cp = dr_doc::side::CheckpointsDoc::create(book_id, random_device_peer()).unwrap();
    assert_eq!(cp_vv, fresh_cp.version());
    lib.close().unwrap();

    // 2. An interrupted target directory carrying an earlier format-3 kernel
    //    marker (`3:<sha256>`) is refused before resuming, leaving source untouched.
    let interrupted = temp.path().join("library-interrupted-v3");
    let opts = options(&old);
    let cancel = opts.cancel.clone();
    let (first, _) = run::import_with(&old.db, &interrupted, &opts, &mut |p| {
        if p.step == dr_import_v1::progress::Step::Bodies && p.done == 1 {
            cancel.now();
        }
    })
    .unwrap();
    assert!(matches!(first, Outcome::Imported(r) if r.books[0].status == "importing"));
    {
        let db_path = dr_store::LibraryPaths::new(&interrupted).db;
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        let cur: String = conn
            .query_row(
                "SELECT value FROM local_state WHERE scope = 'import-v1-kernel' AND key = ?1",
                [BOOK],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            cur.starts_with("5:"),
            "v5 kernel marker must use prefix 5:, got {cur}"
        );
        let legacy_v4_marker = cur.replacen("5:", "4:", 1);
        conn.execute(
            "UPDATE local_state SET value = ?1 WHERE scope = 'import-v1-kernel' AND key = ?2",
            rusqlite::params![&legacy_v4_marker, BOOK],
        )
        .unwrap();
    }
    let err = run::import(&old.db, &interrupted, &options(&old)).unwrap_err();
    assert!(
        matches!(&err, dr_import_v1::ImportError::Invalid(m) if m.contains("mapping policy")),
        "expected format-3 target refusal, got {err:?}"
    );
    assert_eq!(
        source_tree_snapshot(&old.root),
        before,
        "source bytes, sizes and mtimes must never change"
    );
}

#[test]
fn step8_asset_library_imports_folders_direct_comments_relations_and_file_links() {
    use dr_model::id::AssetFolderId;
    use dr_model::shared::{EntityRef, MaterialRegion};
    use serde_json::json;

    const ASSET_PDF: &str = "01900000-0000-7000-8000-0000000000ab";
    const PDF_ITEM: &str = "01900000-0000-7000-8000-0000000000f3";
    const MF_REF: &str = "01900000-0000-7000-8000-000000000082";
    const MF_ARCH: &str = "01900000-0000-7000-8000-000000000083";
    const IDEA_LINKING: &str = "01900000-0000-7000-8000-0000000000d9";
    const BOOK_NO_NOTES: &str = "01900000-0000-7000-8000-000000000002";
    const ASSET_B2: &str = "01900000-0000-7000-8000-0000000000ac";
    const IMAGE_B2: &str = "01900000-0000-7000-8000-0000000000f4";
    const IMAGE_NO_FILE: &str = "01900000-0000-7000-8000-0000000000f5";
    const PDF_BYTES: &[u8] = b"%PDF-1.4\nsynthetic-pdf-for-step7\n%%EOF";

    let old = fixture::build();
    let pdf_dir = old.root.join("assets").join(BOOK).join(ASSET_PDF);
    std::fs::create_dir_all(&pdf_dir).unwrap();
    std::fs::write(pdf_dir.join("source.pdf"), PDF_BYTES).unwrap();

    let img_b2_dir = old.root.join("assets").join(BOOK_NO_NOTES).join(ASSET_B2);
    std::fs::create_dir_all(&img_b2_dir).unwrap();
    std::fs::write(img_b2_dir.join("source.png"), IMAGE_BYTES).unwrap();

    let c = rusqlite::Connection::open(&old.db).unwrap();
    c.pragma_update(None, "foreign_keys", false).unwrap();

    // Nested media-only folders ("参考图" -> "建筑") with zero text notes.
    c.execute(
        "INSERT INTO material_folder (id, project_id, name, parent_folder_id, created_at, updated_at) VALUES (?1, ?2, '参考图', NULL, ?3, ?3)",
        rusqlite::params![MF_REF, BOOK, T0],
    )
    .unwrap();
    c.execute(
        "INSERT INTO material_folder (id, project_id, name, parent_folder_id, created_at, updated_at) VALUES (?1, ?2, '建筑', ?3, ?4, ?4)",
        rusqlite::params![MF_ARCH, BOOK, MF_REF, T0],
    )
    .unwrap();
    c.execute(
        "UPDATE library_item SET folder_id = ?1 WHERE id = ?2",
        rusqlite::params![MF_ARCH, IMAGE],
    )
    .unwrap();

    // PDF asset + library_item in the note folder 「资料」: a folder holding
    // both is rebuilt on both sides.
    c.execute(
        "INSERT INTO project_asset (id, project_id, kind, source_mime, source_size_bytes, source_sha256, width, height, created_at) VALUES (?1, ?2, 'pdf', 'application/pdf', ?3, ?4, NULL, NULL, ?5)",
        rusqlite::params![
            ASSET_PDF,
            BOOK,
            PDF_BYTES.len() as i64,
            sha256_bytes(PDF_BYTES),
            T0
        ],
    )
    .unwrap();
    c.execute(
        "INSERT INTO library_item (id, project_id, title, kind, asset_id, external_url, body_json, notes_json, preview_image_url, order_key, created_at, updated_at, provenance_json, folder_id, task_todos) VALUES (?1, ?2, '城防志.pdf', 'pdf', ?3, NULL, NULL, NULL, NULL, 2, ?4, ?4, NULL, ?5, 0)",
        rusqlite::params![PDF_ITEM, BOOK, ASSET_PDF, T0, FOLDER],
    )
    .unwrap();
    // An image material whose file row is gone (damaged 0.1 data): a link
    // to it has nothing to point at.
    c.execute(
        "INSERT INTO library_item (id, project_id, title, kind, asset_id, external_url, body_json, notes_json, preview_image_url, order_key, created_at, updated_at, provenance_json, folder_id, task_todos) VALUES (?1, ?2, '缺图', 'image', '01900000-0000-7000-8000-0000000000ad', NULL, NULL, NULL, NULL, 3, ?3, ?3, NULL, NULL, 0)",
        rusqlite::params![IMAGE_NO_FILE, BOOK, T0],
    )
    .unwrap();

    // Page-2 region comment on the PDF item, plus a direct relation between IMAGE and CHAPTER.
    let pdf_comment_body = json!({
        "type": "doc",
        "content": [{"type": "paragraph", "content": [{"type": "text", "text": "城门尺寸"}]}]
    })
    .to_string();
    c.execute(
        "INSERT INTO comment (id, project_id, kind, target_kind, target_id, target_block_id, anchor_json, author_kind, author_id, author_name, body_json, status, priority, source, metadata_json, target_block_ids_json, resolved_at, created_at, updated_at) VALUES ('region-pdf', ?1, 'note', 'library_item', ?2, NULL, '{\"region\":{\"v\":1,\"page\":2,\"x\":0.2,\"y\":0.3,\"w\":0.4,\"h\":0.1}}', 'user', NULL, NULL, ?3, 'open', NULL, 'manual', NULL, '[]', NULL, ?4, ?4)",
        rusqlite::params![BOOK, PDF_ITEM, pdf_comment_body, T1],
    )
    .unwrap();
    let generic = format!("system:generic-association:{BOOK}");
    c.execute(
        "INSERT INTO entity_relation (id, project_id, from_kind, from_id, to_kind, to_id, relation_type_id, created_at, updated_at) VALUES ('rel-img-chapter', ?1, 'library_item', ?2, 'node', ?3, ?4, ?5, ?5)",
        rusqlite::params![BOOK, IMAGE, CHAPTER, generic, T0],
    )
    .unwrap();

    // Seed-only idea linking IMAGE (a link to its file), the image without a
    // file (plain text + receipt entry) and NOTE (stays linked).
    let linking_prose = json!({
        "type": "doc",
        "content": [{
            "type": "paragraph",
            "attrs": {"id": "p-link"},
            "content": [
                {"type": "text", "text": "参见"},
                {
                    "type": "text",
                    "text": "插图原件",
                    "marks": [{"type": "entityLink", "attrs": {"targetKind": "library_item", "targetId": IMAGE}}]
                },
                {"type": "text", "text": "、"},
                {
                    "type": "text",
                    "text": "缺图",
                    "marks": [{"type": "entityLink", "attrs": {"targetKind": "library_item", "targetId": IMAGE_NO_FILE}}]
                },
                {"type": "text", "text": "与"},
                {
                    "type": "text",
                    "text": "待查笔记",
                    "marks": [{"type": "entityLink", "attrs": {"targetKind": "library_item", "targetId": NOTE}}]
                }
            ]
        }]
    })
    .to_string();
    c.execute(
        "INSERT INTO book_node (id, project_id, title, summary, book_order, narrative_order, writing_status, kind, drift_group_id, position_x, position_y, created_at, updated_at) VALUES (?1, ?2, '考据附记', '', NULL, NULL, 'drifting', 'drift', ?3, 0, 0, ?4, ?4)",
        rusqlite::params![IDEA_LINKING, BOOK, GROUP, T0],
    )
    .unwrap();
    c.execute(
        "INSERT INTO node_content (node_id, content_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
        rusqlite::params![IDEA_LINKING, linking_prose, T0],
    )
    .unwrap();

    // Second project with ONLY an image material and zero text notes -> must NOT create "文本素材".
    c.execute(
        "INSERT INTO project (id, name, summary, kv_json, storyline_template_kv_json, user_id, created_at, updated_at, deleted_at) VALUES (?1, '纯图像集', '', '[]', '[]', 'local', ?2, ?2, NULL)",
        rusqlite::params![BOOK_NO_NOTES, T0],
    )
    .unwrap();
    let generic_b2 = format!("system:generic-association:{BOOK_NO_NOTES}");
    c.execute(
        "INSERT INTO entity_relation_type (id, project_id, name, normalized_name, description, orientation, system_key, locked, source_role, target_role, created_at, updated_at) VALUES (?1, ?2, 'Generic association', 'generic association', '', 'directed', 'generic-association', 1, 'Source', 'Target', ?3, ?3)",
        rusqlite::params![generic_b2, BOOK_NO_NOTES, T0],
    )
    .unwrap();
    c.execute(
        "INSERT INTO project_asset (id, project_id, kind, source_mime, source_size_bytes, source_sha256, width, height, created_at) VALUES (?1, ?2, 'image', 'image/png', ?3, ?4, 4, 3, ?5)",
        rusqlite::params![
            ASSET_B2,
            BOOK_NO_NOTES,
            IMAGE_BYTES.len() as i64,
            sha256_bytes(IMAGE_BYTES),
            T0
        ],
    )
    .unwrap();
    c.execute(
        "INSERT INTO library_item (id, project_id, title, kind, asset_id, external_url, body_json, notes_json, preview_image_url, order_key, created_at, updated_at, provenance_json, folder_id, task_todos) VALUES (?1, ?2, '独图', 'image', ?3, NULL, NULL, NULL, NULL, 0, ?4, ?4, NULL, NULL, 0)",
        rusqlite::params![IMAGE_B2, BOOK_NO_NOTES, ASSET_B2, T0],
    )
    .unwrap();
    drop(c);

    let before = source_tree_snapshot(&old.root);
    let expected = manifest::read(&old.db, BOOK).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("library");
    let mut opts = options(&old);
    opts.accept = dr_import_v1::gate::Accept::EVERYTHING;
    let (outcome, _) = run::import(&old.db, &root, &opts).unwrap();
    let Outcome::Imported(receipt) = outcome else {
        panic!("expected imported");
    };
    assert_eq!(source_tree_snapshot(&old.root), before);

    let lib = open(&root);
    let book_bytes = lib
        .load_copy(&format!("book:{BOOK}"))
        .unwrap()
        .export(loro::ExportMode::Snapshot)
        .unwrap();
    let book = BookDocV3::load(
        BookId::parse(BOOK).unwrap(),
        random_device_peer(),
        std::slice::from_ref(&book_bytes),
    )
    .unwrap();
    let v = book.view();
    compare(&v, &expected, &lib);

    // 1. Image and PDF are in the built-in asset library, in folders of the
    // same names as the 0.1 folders, nested as they were (`kernel-v5.md` §13).
    let fid = |s: &str| AssetFolderId::parse(s).unwrap();
    let img_asset = v.asset(&AssetId::parse(ASSET).unwrap()).unwrap();
    assert_eq!(img_asset.name, "插图");
    assert_eq!(img_asset.folder, Some(fid(MF_ARCH)));
    let pdf_asset = v.asset(&AssetId::parse(ASSET_PDF).unwrap()).unwrap();
    assert_eq!(pdf_asset.name, "城防志.pdf");
    assert_eq!(pdf_asset.folder, Some(fid(FOLDER)));
    let folders: Vec<(String, String, Option<AssetFolderId>)> = v
        .asset_folders()
        .into_iter()
        .map(|f| (f.id.to_string(), f.name, f.parent))
        .collect();
    assert_eq!(folders.len(), 3, "{folders:?}");
    for want in [
        (MF_REF.to_string(), "参考图".to_string(), None),
        (MF_ARCH.to_string(), "建筑".to_string(), Some(fid(MF_REF))),
        (FOLDER.to_string(), "资料".to_string(), None),
    ] {
        assert!(folders.contains(&want), "{want:?} in {folders:?}");
    }

    // 2. Media-only folders do not become entries; note folders & notes live under "文本素材".
    assert!(v.entry(&eid(MF_REF)).is_none());
    assert!(v.entry(&eid(MF_ARCH)).is_none());
    let text_root = v
        .entries()
        .into_iter()
        .find(|e| e.parent.is_none() && e.title == "文本素材")
        .expect("文本素材 top-level folder");
    let note_folder = v.entry(&eid(FOLDER)).unwrap();
    assert_eq!(note_folder.parent.as_ref(), Some(&text_root.id));
    let note_entry = v.entry(&eid(NOTE)).unwrap();
    assert_eq!(note_entry.parent.as_ref(), Some(&eid(FOLDER)));

    // 3. Direct asset region comments (image & PDF page) and asset relation survive intact.
    let comments = v.comments();
    let c_img = comments
        .iter()
        .find(|c| c.id.as_str() == "region-1")
        .unwrap();
    assert_eq!(c_img.target, Some(EntityRef::new(EntityKind::Asset, ASSET)));
    assert_eq!(c_img.target_module, None);
    assert!(!c_img.target_missing);
    assert_eq!(
        c_img.part,
        Some(CommentPart::Region {
            region: MaterialRegion {
                page: None,
                x: 0.1,
                y: 0.2,
                w: 0.3,
                h: 0.4,
            }
        })
    );
    let c_pdf = comments
        .iter()
        .find(|c| c.id.as_str() == "region-pdf")
        .unwrap();
    assert_eq!(
        c_pdf.target,
        Some(EntityRef::new(EntityKind::Asset, ASSET_PDF))
    );
    assert_eq!(c_pdf.target_module, None);
    assert!(!c_pdf.target_missing);
    assert_eq!(
        c_pdf.part,
        Some(CommentPart::Region {
            region: MaterialRegion {
                page: Some(2),
                x: 0.2,
                y: 0.3,
                w: 0.4,
                h: 0.1,
            }
        })
    );
    let rel = v
        .relations()
        .into_iter()
        .find(|r| r.id.as_str() == "rel-img-chapter")
        .unwrap();
    assert_eq!(rel.from, EntityRef::new(EntityKind::Asset, ASSET));
    assert_eq!(rel.to, EntityRef::new(EntityKind::Entry, CHAPTER));

    // 4. The prose link to IMAGE points at its file; the one to the image
    // without a file is plain text + receipt/summary record; NOTE's remains.
    let linking_doc_id = adapter::body_id(IDEA_LINKING, MOD_PROSE);
    let linking_bytes = lib
        .load_copy(&linking_doc_id.to_string())
        .unwrap()
        .export(loro::ExportMode::Snapshot)
        .unwrap();
    let linking_doc = ProseDoc::load(
        linking_doc_id.clone(),
        random_device_peer(),
        std::slice::from_ref(&linking_bytes),
    )
    .unwrap();
    let para = linking_doc.view().paragraphs().next().unwrap();
    assert_eq!(para.text(), "参见插图原件、缺图与待查笔记");
    let file_run = para.runs.iter().find(|r| r.text == "插图原件").unwrap();
    assert_eq!(file_run.marks.entities.len(), 1, "{:?}", para.runs);
    assert_eq!(file_run.marks.entities[0].kind, EntityKind::Asset);
    assert_eq!(file_run.marks.entities[0].target, ASSET);
    assert!(file_run.marks.entities[0].block.is_none());
    let unlinked_run = para.runs.iter().find(|r| r.text.contains("缺图")).unwrap();
    assert!(unlinked_run.marks.entities.is_empty());
    let linked_run = para.runs.iter().find(|r| r.text == "待查笔记").unwrap();
    assert_eq!(linked_run.marks.entities.len(), 1);
    assert_eq!(linked_run.marks.entities[0].target, NOTE);

    let book1_rec = receipt.books.iter().find(|b| b.book_id == BOOK).unwrap();
    assert_eq!(book1_rec.unlinked_asset_links.len(), 1);
    assert_eq!(book1_rec.unlinked_asset_links[0].material_id, IMAGE_NO_FILE);
    assert_eq!(book1_rec.unlinked_asset_links[0].material_title, "缺图");
    assert_eq!(book1_rec.unlinked_asset_links[0].text, "缺图");
    // No priority comes over (the 0.1 fixture has one comment with one).
    assert_eq!(
        book1_rec.notes.0.get("comment-priority-dropped"),
        Some(&1),
        "{:?}",
        book1_rec.notes
    );
    let summary_md = std::fs::read_to_string(root.join("import-v1").join("summary.md")).unwrap();
    assert!(summary_md.contains("缺图"));
    assert!(summary_md.contains("批注的优先级没有导入"));

    // 5. Project with zero text materials does NOT create a "文本素材" top-level entry.
    let book2_bytes = lib
        .load_copy(&format!("book:{BOOK_NO_NOTES}"))
        .unwrap()
        .export(loro::ExportMode::Snapshot)
        .unwrap();
    let book2 = BookDocV3::load(
        BookId::parse(BOOK_NO_NOTES).unwrap(),
        random_device_peer(),
        std::slice::from_ref(&book2_bytes),
    )
    .unwrap();
    assert_eq!(book2.view().assets().len(), 1);
    assert_eq!(book2.view().assets()[0].id.as_str(), ASSET_B2);
    assert_eq!(book2.view().assets()[0].folder, None, "at the top");
    assert!(book2.view().asset_folders().is_empty());
    assert!(
        !book2
            .view()
            .entries_raw()
            .iter()
            .any(|e| e.title == "文本素材"),
        "project without text materials must not create 文本素材"
    );
    lib.close().unwrap();
}

/// A 0.1 checklist TODO whose state disagrees with its line's tick imports
/// as the tick (`kernel-v5.md` §13): the comment is the line's shadow.
#[test]
fn a_checklist_todo_whose_state_disagrees_with_its_tick_imports_as_the_tick() {
    let note_doc = adapter::body_id(NOTE, MOD_PROSE);
    let todo = CommentId::for_projection(
        &ProjectionKind::NoteTask,
        &note_doc,
        &BlockId::parse("tp1").unwrap(),
    );
    // (0.1 status, line ticked) -> the imported status.
    for (status, ticked, want) in [
        ("resolved", false, CommentStatus::Open),
        ("open", true, CommentStatus::Resolved),
    ] {
        let old = fixture::build();
        let c = rusqlite::Connection::open(&old.db).unwrap();
        c.execute(
            "UPDATE comment SET status = ?2, resolved_at = CASE ?2 WHEN 'resolved' THEN ?3 ELSE NULL END WHERE id = ?1",
            rusqlite::params![NOTE_TODO, status, T1],
        )
        .unwrap();
        if ticked {
            let body = NOTE_JSON.replacen(
                r#""id":"ti1","checked":false"#,
                r#""id":"ti1","checked":true"#,
                1,
            );
            assert_ne!(body, NOTE_JSON);
            c.execute(
                "UPDATE library_item SET body_json = ?2 WHERE id = ?1",
                rusqlite::params![NOTE, body],
            )
            .unwrap();
        }
        drop(c);
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("library");
        let mut opts = options(&old);
        opts.accept = dr_import_v1::gate::Accept::EVERYTHING;
        let (outcome, _) = run::import(&old.db, &root, &opts).unwrap();
        let Outcome::Imported(receipt) = outcome else {
            panic!("expected imported");
        };
        let lib = open(&root);
        let bytes = lib
            .load_copy(&format!("book:{BOOK}"))
            .unwrap()
            .export(loro::ExportMode::Snapshot)
            .unwrap();
        let book =
            BookDocV3::load(BookId::parse(BOOK).unwrap(), random_device_peer(), &[bytes]).unwrap();
        let comment = book.view().comment(&todo).expect("the checklist comment");
        assert_eq!(comment.status, want, "0.1 {status}, ticked {ticked}");
        assert_eq!(
            comment.resolved_at.is_some(),
            want == CommentStatus::Resolved
        );
        let prose_bytes = lib
            .load_copy(&note_doc.to_string())
            .unwrap()
            .export(loro::ExportMode::Snapshot)
            .unwrap();
        let prose = ProseDoc::load(note_doc.clone(), random_device_peer(), &[prose_bytes]).unwrap();
        let line = prose.view().paragraphs().next().unwrap();
        assert_eq!(line.attrs.checked, ticked, "the tick is kept");
        let rec = receipt.books.iter().find(|b| b.book_id == BOOK).unwrap();
        assert_eq!(rec.notes.0.get("task-status-follows-tick"), Some(&1));
        assert_eq!(rec.task_status_changes.len(), 1);
        assert_eq!(rec.task_status_changes[0].comment_id, NOTE_TODO);
        assert_eq!(rec.task_status_changes[0].checked, ticked);
        assert_eq!(rec.material_descriptions_to_comments, 2);
        assert_eq!(rec.material_provenances_to_comments, 1);
        let summary_md =
            std::fs::read_to_string(root.join("import-v1").join("summary.md")).unwrap();
        assert!(summary_md.contains("旧库里有 "), "{summary_md}");
        assert!(
            summary_md.contains("清单项不再单独链接旧版待办"),
            "{summary_md}"
        );
        assert!(
            summary_md.contains("清单项关联的待办状态与勾选不一致"),
            "{summary_md}"
        );
        assert!(
            summary_md.contains("按清单项勾选调整了状态的待办明细："),
            "{summary_md}"
        );
        assert!(summary_md.contains(NOTE_TODO), "{summary_md}");
        assert!(
            summary_md.contains("旧版素材上的 2 条说明、1 条出处已转为已解决的批注"),
            "{summary_md}"
        );
        assert!(!summary_md.contains("gpt-image-1"), "{summary_md}");
        assert!(!summary_md.contains("王胡与小D的记事"), "{summary_md}");
        lib.close().unwrap();
    }
}

#[test]
fn note_order_in_folder_and_cross_doc_checklist_ticks_stay_independent() {
    const NOTE_SECOND: &str = "01900000-0000-7000-8000-0000000000f9";
    let old = fixture::build();
    let c = rusqlite::Connection::open(&old.db).unwrap();
    let note_first_body = r#"{"type":"doc","content":[{"type":"taskList","attrs":{"id":"tl"},"content":[{"type":"taskItem","attrs":{"id":"shared-ti","checked":true,"todoId":"01900000-0000-7000-8000-000000000062"},"content":[{"type":"paragraph","attrs":{"id":"shared-tp"},"content":[{"type":"text","text":"甲篇已勾"}]}]}]}]}"#;
    let note_second_body = r#"{"type":"doc","content":[{"type":"taskList","attrs":{"id":"tl"},"content":[{"type":"taskItem","attrs":{"id":"shared-ti","checked":false},"content":[{"type":"paragraph","attrs":{"id":"shared-tp"},"content":[{"type":"text","text":"乙篇未勾"}]}]},{"type":"taskItem","attrs":{"checked":true},"content":[{"type":"paragraph","content":[{"type":"text","text":"无段落号已勾"}]}]}]}]}"#;
    c.execute(
        "UPDATE library_item SET body_json = ?2, order_key = 10 WHERE id = ?1",
        rusqlite::params![NOTE, note_first_body],
    )
    .unwrap();
    // Inserted after NOTE and with a larger UUID, but a smaller order_key (-5 < 10).
    c.execute(
        "INSERT INTO library_item (id, project_id, title, kind, asset_id, external_url, body_json, notes_json, preview_image_url, order_key, created_at, updated_at, provenance_json, folder_id, task_todos) VALUES (?1, ?2, '先读札记', 'text', NULL, NULL, ?3, NULL, NULL, -5, ?4, ?4, NULL, ?5, 0)",
        rusqlite::params![NOTE_SECOND, BOOK, note_second_body, T0, FOLDER],
    )
    .unwrap();
    drop(c);

    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("library");
    let mut opts = options(&old);
    opts.accept = dr_import_v1::gate::Accept::EVERYTHING;
    let (outcome, _) = run::import(&old.db, &root, &opts).unwrap();
    assert!(matches!(outcome, Outcome::Imported(_)));

    let lib = open(&root);
    let bytes = lib
        .load_copy(&format!("book:{BOOK}"))
        .unwrap()
        .export(loro::ExportMode::Snapshot)
        .unwrap();
    let book =
        BookDocV3::load(BookId::parse(BOOK).unwrap(), random_device_peer(), &[bytes]).unwrap();
    let view = book.view();

    let children: Vec<_> = view
        .children_of(Some(&eid(FOLDER)))
        .into_iter()
        .map(|e| e.id.to_string())
        .collect();
    assert_eq!(children, vec![NOTE_SECOND.to_string(), NOTE.to_string()]);

    let first_doc = adapter::body_id(NOTE, MOD_PROSE);
    let second_doc = adapter::body_id(NOTE_SECOND, MOD_PROSE);
    let first_comment = view
        .comment(&CommentId::for_projection(
            &ProjectionKind::NoteTask,
            &first_doc,
            &BlockId::parse("shared-tp").unwrap(),
        ))
        .expect("NOTE shared-tp task comment");
    assert_eq!(first_comment.status, CommentStatus::Resolved);

    let second_comment = view
        .comment(&CommentId::for_projection(
            &ProjectionKind::NoteTask,
            &second_doc,
            &BlockId::parse("shared-tp").unwrap(),
        ))
        .expect("NOTE_SECOND shared-tp task comment");
    assert_eq!(second_comment.status, CommentStatus::Open);

    let second_prose = load_prose(&lib, &second_doc);
    let generated_block = second_prose
        .view()
        .blocks()
        .get(1)
        .and_then(|b| b.id.clone())
        .expect("repaired block id for second task item");
    let unlinked_generated = view
        .comment(&CommentId::for_projection(
            &ProjectionKind::NoteTask,
            &second_doc,
            &generated_block,
        ))
        .expect("projected comment for task item without authored paragraph id");
    assert_eq!(unlinked_generated.status, CommentStatus::Resolved);
    assert_eq!(unlinked_generated.body, "无段落号已勾");
    lib.close().unwrap();
}

#[test]
fn merged_duplicate_files_rebuild_second_folder_retarget_all_references_and_report_cleanly() {
    use dr_doc::prose::EmbedView;
    use dr_import_v1::receipt::MaterialDropped;

    const MF_FIRST: &str = "01900000-0000-7000-8000-00000000008a";
    const MF_SECOND: &str = "01900000-0000-7000-8000-00000000008b";
    const MF_MISSING: &str = "01900000-0000-7000-8000-00000000008c";
    const MF_EMPTY: &str = "01900000-0000-7000-8000-00000000008d";
    const IMAGE_DUP: &str = "01900000-0000-7000-8000-0000000000f3";
    const IMAGE_MISSING: &str = "01900000-0000-7000-8000-0000000000f4";
    const ASSET_DUP: &str = "01900000-0000-7000-8000-0000000000ab";

    let old = fixture::build();
    let dup_dir = old.root.join("assets").join(BOOK).join(ASSET_DUP);
    std::fs::create_dir_all(&dup_dir).unwrap();
    std::fs::write(dup_dir.join("source.png"), IMAGE_BYTES).unwrap();

    let c = rusqlite::Connection::open(&old.db).unwrap();
    c.pragma_update(None, "foreign_keys", false).unwrap();
    for (fid, name) in [
        (MF_FIRST, "甲夹"),
        (MF_SECOND, "乙夹"),
        (MF_MISSING, "缺件夹"),
        (MF_EMPTY, "真空夹"),
    ] {
        c.execute(
            "INSERT INTO material_folder (id, project_id, name, parent_folder_id, created_at, updated_at) VALUES (?1, ?2, ?3, NULL, ?4, ?4)",
            rusqlite::params![fid, BOOK, name, T0],
        )
        .unwrap();
    }
    let multiline_notes = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"第一行说明"}]},{"type":"paragraph","content":[{"type":"text","text":"- 第二行带短横线"}]}]}"#;
    c.execute(
        "UPDATE library_item SET folder_id = ?2, notes_json = ?3 WHERE id = ?1",
        rusqlite::params![IMAGE, MF_FIRST, multiline_notes],
    )
    .unwrap();
    c.execute(
        "INSERT INTO project_asset (id, project_id, kind, source_mime, source_size_bytes, source_sha256, width, height, created_at) VALUES (?1, ?2, 'image', 'image/png', ?3, ?4, 4, 3, ?5)",
        rusqlite::params![
            ASSET_DUP,
            BOOK,
            IMAGE_BYTES.len() as i64,
            common::sha256_bytes(IMAGE_BYTES),
            T0
        ],
    )
    .unwrap();
    let dup_dir = old.root.join("assets").join(BOOK).join(ASSET_DUP);
    std::fs::create_dir_all(&dup_dir).unwrap();
    std::fs::write(dup_dir.join("source.png"), IMAGE_BYTES).unwrap();
    c.execute(
        "INSERT INTO library_item (id, project_id, title, kind, asset_id, external_url, body_json, notes_json, preview_image_url, order_key, created_at, updated_at, provenance_json, folder_id, task_todos) VALUES (?1, ?2, '同图副本', 'image', ?3, NULL, NULL, ?6, NULL, 2, ?4, ?4, NULL, ?5, 0)",
        rusqlite::params![
            IMAGE_DUP,
            BOOK,
            ASSET_DUP,
            T0,
            MF_SECOND,
            r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"副本上的说明"}]}]}"#
        ],
    )
    .unwrap();
    c.execute(
        "INSERT INTO library_item (id, project_id, title, kind, asset_id, external_url, body_json, notes_json, preview_image_url, order_key, created_at, updated_at, provenance_json, folder_id, task_todos) VALUES (?1, ?2, '缺件图', 'image', '01900000-0000-7000-8000-0000000000ad', NULL, NULL, ?5, NULL, 3, ?3, ?3, NULL, ?4, 0)",
        rusqlite::params![IMAGE_MISSING, BOOK, T0, MF_MISSING, multiline_notes],
    )
    .unwrap();

    let generic = format!("system:generic-association:{BOOK}");
    for (rid, mid_str) in [
        ("rel-dup-img", IMAGE_DUP),
        ("rel-missing-img", IMAGE_MISSING),
    ] {
        c.execute(
            "INSERT INTO entity_relation (id, project_id, from_kind, from_id, to_kind, to_id, relation_type_id, created_at, updated_at) VALUES (?1, ?2, 'library_item', ?3, 'node', ?4, ?5, ?6, ?6)",
            rusqlite::params![rid, BOOK, mid_str, CHAPTER, generic, T0],
        )
        .unwrap();
    }
    let cbody = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"图上批注"}]}]}"#;
    for (cid, mid_str) in [
        ("com-dup-img", IMAGE_DUP),
        ("com-missing-img", IMAGE_MISSING),
    ] {
        c.execute(
            "INSERT INTO comment (id, project_id, kind, target_kind, target_id, target_block_id, anchor_json, author_kind, author_id, author_name, body_json, status, priority, source, metadata_json, target_block_ids_json, resolved_at, created_at, updated_at) VALUES (?1, ?2, 'note', 'library_item', ?3, NULL, '{\"region\":{\"v\":1,\"x\":0.2,\"y\":0.2,\"w\":0.3,\"h\":0.3}}', 'user', NULL, NULL, ?4, 'open', NULL, 'manual', NULL, '[]', NULL, ?5, ?5)",
            rusqlite::params![cid, BOOK, mid_str, cbody, T1],
        )
        .unwrap();
    }
    let idea_prose = format!(
        r#"{{"type":"doc","content":[{{"type":"paragraph","attrs":{{"id":"ip1"}},"content":[{{"type":"text","text":"看"}},{{"type":"text","text":"同图副本","marks":[{{"type":"entityLink","attrs":{{"targetKind":"library_item","targetId":"{IMAGE_DUP}"}}}}]}}]}},{{"type":"materialEmbed","attrs":{{"id":"emb-by-item","libraryItemId":"{IMAGE_DUP}"}}}},{{"type":"materialEmbed","attrs":{{"id":"emb-by-asset","assetId":"{ASSET_DUP}"}}}}]}}"#
    );
    c.execute(
        "UPDATE node_content SET content_json = ?2 WHERE node_id = ?1",
        rusqlite::params![IDEA, idea_prose],
    )
    .unwrap();
    drop(c);

    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("library");
    let mut opts = options(&old);
    opts.accept = dr_import_v1::gate::Accept::EVERYTHING;
    let (outcome, _) = run::import(&old.db, &root, &opts).unwrap();
    let Outcome::Imported(receipt) = outcome else {
        panic!("expected imported");
    };
    let rec = receipt.books.iter().find(|b| b.book_id == BOOK).unwrap();
    assert_eq!(rec.assets_copied, 1, "identical bytes copied once");

    let lib = open(&root);
    assert_eq!(lib.assets_of_book(BOOK).unwrap().len(), 1);
    let bytes = lib
        .load_copy(&format!("book:{BOOK}"))
        .unwrap()
        .export(loro::ExportMode::Snapshot)
        .unwrap();
    let book =
        BookDocV3::load(BookId::parse(BOOK).unwrap(), random_device_peer(), &[bytes]).unwrap();
    let view = book.view();
    assert_eq!(view.assets().len(), 1);
    assert_eq!(view.assets()[0].id.as_str(), ASSET);

    // Second folder (MF_SECOND) is rebuilt empty in asset_folders alongside MF_FIRST.
    let folder_ids: BTreeSet<String> = view
        .asset_folders()
        .into_iter()
        .map(|f| f.id.to_string())
        .collect();
    assert!(folder_ids.contains(MF_FIRST), "{folder_ids:?}");
    assert!(folder_ids.contains(MF_SECOND), "{folder_ids:?}");
    assert!(!folder_ids.contains(MF_MISSING), "{folder_ids:?}");
    assert!(!folder_ids.contains(MF_EMPTY), "{folder_ids:?}");

    // Comment, relation, prose entityLink, and both prose embeds point to kept ASSET.
    let dup_comment = view
        .comment(&CommentId::parse("com-dup-img").unwrap())
        .expect("comment on merged duplicate material");
    assert_eq!(
        dup_comment.target,
        Some(dr_model::shared::EntityRef::new(EntityKind::Asset, ASSET))
    );
    assert!(!dup_comment.target_missing);

    let dup_rel = view
        .relations()
        .into_iter()
        .find(|r| r.id.as_str() == "rel-dup-img")
        .expect("relation on merged duplicate material");
    assert_eq!(
        dup_rel.from,
        dr_model::shared::EntityRef::new(EntityKind::Asset, ASSET)
    );

    let idea_doc = load_prose(&lib, &adapter::body_id(IDEA, MOD_PROSE));
    let link_run = idea_doc
        .view()
        .paragraphs()
        .next()
        .unwrap()
        .runs
        .into_iter()
        .find(|r| r.text == "同图副本")
        .unwrap();
    assert_eq!(link_run.marks.entities.len(), 1);
    assert_eq!(link_run.marks.entities[0].kind, EntityKind::Asset);
    assert_eq!(link_run.marks.entities[0].target, ASSET);
    for emb_id in ["emb-by-item", "emb-by-asset"] {
        let Some(EmbedView::Asset { asset, .. }) =
            idea_doc.view().embed(&EmbedId::parse(emb_id).unwrap())
        else {
            panic!("missing asset embed {emb_id}");
        };
        assert_eq!(asset, Some(AssetId::parse(ASSET).unwrap()), "{emb_id}");
    }

    // Missing-file material lists its description, relation and comment; folder wording & multiline safety.
    assert!(
        rec.materials_dropped.iter().any(|d| matches!(
            d,
            MaterialDropped::WithoutFile {
                material_id,
                description: Some(desc),
                relations,
                comments,
                ..
            } if material_id == IMAGE_MISSING
                && desc == "第一行说明\n- 第二行带短横线"
                && relations == &vec!["rel-missing-img".to_string()]
                && comments == &vec!["com-missing-img".to_string()]
        )),
        "{:?}",
        rec.materials_dropped
    );
    // Both merged duplicate materials attach their own resolved description comment to kept ASSET.
    let book_id = BookId::parse(BOOK).unwrap();
    for (mid_str, want_desc) in [
        (IMAGE, "第一行说明\n- 第二行带短横线"),
        (IMAGE_DUP, "副本上的说明"),
    ] {
        let cid = dr_import_v1::book::material_comment_id(&book_id, mid_str, "description");
        let c = view
            .comment(&cid)
            .expect("merged material description comment");
        assert_eq!(
            c.target,
            Some(dr_model::shared::EntityRef::new(EntityKind::Asset, ASSET))
        );
        assert_eq!(c.target_module, None);
        assert_eq!(c.part, None);
        assert_eq!(c.status, CommentStatus::Resolved);
        assert_eq!(c.origin, CommentOrigin::Manual);
        assert_eq!(c.body, want_desc);
    }
    assert!(
        view.comment(&dr_import_v1::book::material_comment_id(
            &book_id,
            IMAGE_MISSING,
            "description"
        ))
        .is_none(),
        "missing-file material must not emit an unlocated comment"
    );
    assert!(
        rec.materials_dropped.iter().any(|d| matches!(
            d,
            MaterialDropped::UnimportedFolder { folder_id, name }
                if folder_id == MF_MISSING && name == "缺件夹"
        )),
        "{:?}",
        rec.materials_dropped
    );
    assert!(
        rec.materials_dropped.iter().any(|d| matches!(
            d,
            MaterialDropped::EmptyFolder { folder_id, name }
                if folder_id == MF_EMPTY && name == "真空夹"
        )),
        "{:?}",
        rec.materials_dropped
    );

    let summary_md = std::fs::read_to_string(root.join("import-v1").join("summary.md")).unwrap();
    assert!(
        summary_md.contains("1 条关系（`rel-missing-img`）、1 条批注（`com-missing-img`）"),
        "{summary_md}"
    );
    assert!(
        summary_md.contains("里面的素材都没有带过来的素材夹「缺件夹」"),
        "{summary_md}"
    );
    assert!(summary_md.contains("空的素材夹「真空夹」"), "{summary_md}");
    let dropped_pos = summary_md.find("旧版素材里没有带过来的：").unwrap();
    let merged_pos = summary_md.find("合并为同一个文件的旧版素材：").unwrap();
    let same_file_pos = summary_md.find("同图副本").unwrap();
    assert!(
        dropped_pos < merged_pos && merged_pos < same_file_pos,
        "{summary_md}"
    );
    assert!(
        !summary_md
            .lines()
            .any(|l| l.starts_with("- 第二行带短横线")),
        "multiline description must not split markdown list: {summary_md}"
    );
    assert!(
        summary_md.contains("说明「第一行说明 ↵ - 第二行带短横线」"),
        "{summary_md}"
    );
    assert!(!summary_md.contains("副本上的说明"), "{summary_md}");
    lib.close().unwrap();
}

#[test]
fn material_descriptions_and_provenance_become_resolved_manual_comments_hidden_from_open_filter() {
    const PDF_ITEM: &str = "01900000-0000-7000-8000-0000000000f5";
    const PDF_ASSET: &str = "01900000-0000-7000-8000-0000000000ac";
    const DUP_ITEM: &str = "01900000-0000-7000-8000-0000000000f6";
    const DUP_ASSET: &str = "01900000-0000-7000-8000-0000000000ae";
    const BLANK_NOTE: &str = "01900000-0000-7000-8000-0000000000f7";
    const PDF_BYTES: &[u8] = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj<<>>endobj\n%%EOF\n";
    const MAT_TS: &str = "2025-03-04T05:06:07.000Z";

    let old = fixture::build();
    for (aid, ext, bytes) in [
        (PDF_ASSET, "source.pdf", PDF_BYTES),
        (DUP_ASSET, "source.png", IMAGE_BYTES),
    ] {
        let dir = old.root.join("assets").join(BOOK).join(aid);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(ext), bytes).unwrap();
    }

    let c = rusqlite::Connection::open(&old.db).unwrap();
    let doc_text = |s: &str| {
        serde_json::json!({
            "type": "doc",
            "content": [{"type": "paragraph", "content": [{"type": "text", "text": s}]}]
        })
        .to_string()
    };
    c.execute(
        "UPDATE library_item SET updated_at = ?2 WHERE id = ?1",
        rusqlite::params![IMAGE, MAT_TS],
    )
    .unwrap();
    // 1. PDF material with a description.
    c.execute(
        "INSERT INTO project_asset (id, project_id, kind, source_mime, source_size_bytes, source_sha256, width, height, created_at) VALUES (?1, ?2, 'pdf', 'application/pdf', ?3, ?4, NULL, NULL, ?5)",
        rusqlite::params![
            PDF_ASSET,
            BOOK,
            PDF_BYTES.len() as i64,
            common::sha256_bytes(PDF_BYTES),
            T0
        ],
    )
    .unwrap();
    c.execute(
        "INSERT INTO library_item (id, project_id, title, kind, asset_id, external_url, body_json, notes_json, preview_image_url, order_key, created_at, updated_at, provenance_json, folder_id, task_todos) VALUES (?1, ?2, '县志摘抄.pdf', 'pdf', ?3, NULL, NULL, ?4, NULL, 2, ?5, ?6, NULL, ?7, 0)",
        rusqlite::params![
            PDF_ITEM,
            BOOK,
            PDF_ASSET,
            doc_text("绍兴府城防旧档"),
            T0,
            MAT_TS,
            FOLDER
        ],
    )
    .unwrap();
    // 2. Duplicate-byte image material with its own description AND former-portrait provenance,
    //    plus an unparseable `updated_at` to exercise fallback to import time.
    c.execute(
        "INSERT INTO project_asset (id, project_id, kind, source_mime, source_size_bytes, source_sha256, width, height, created_at) VALUES (?1, ?2, 'image', 'image/png', ?3, ?4, 4, 3, ?5)",
        rusqlite::params![
            DUP_ASSET,
            BOOK,
            IMAGE_BYTES.len() as i64,
            common::sha256_bytes(IMAGE_BYTES),
            T0
        ],
    )
    .unwrap();
    let portrait_prov = format!(
        r#"{{"v":1,"origin":"element-portrait","elementId":"{ELEMENT}","replacedAt":"2025-04-01T09:00:00.000Z"}}"#
    );
    c.execute(
        "INSERT INTO library_item (id, project_id, title, kind, asset_id, external_url, body_json, notes_json, preview_image_url, order_key, created_at, updated_at, provenance_json, folder_id, task_todos) VALUES (?1, ?2, '旧立绘备份', 'image', ?3, NULL, NULL, ?4, NULL, 3, ?5, '', ?6, NULL, 0)",
        rusqlite::params![
            DUP_ITEM,
            BOOK,
            DUP_ASSET,
            doc_text("换下前的草稿立绘"),
            T0,
            portrait_prov
        ],
    )
    .unwrap();
    // 3. Text note with empty/whitespace description must NOT create a comment.
    c.execute(
        "INSERT INTO library_item (id, project_id, title, kind, asset_id, external_url, body_json, notes_json, preview_image_url, order_key, created_at, updated_at, provenance_json, folder_id, task_todos) VALUES (?1, ?2, '空说明札记', 'text', NULL, NULL, ?3, ?4, NULL, 4, ?5, ?5, NULL, ?6, 0)",
        rusqlite::params![
            BLANK_NOTE,
            BOOK,
            doc_text("正文内容"),
            doc_text("   "),
            T0,
            FOLDER
        ],
    )
    .unwrap();
    drop(c);

    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("library");
    let mut opts = options(&old);
    opts.accept = dr_import_v1::gate::Accept::EVERYTHING;
    let (outcome, _) = run::import(&old.db, &root, &opts).unwrap();
    let Outcome::Imported(receipt) = outcome else {
        panic!("expected imported");
    };
    let rec = receipt.books.iter().find(|b| b.book_id == BOOK).unwrap();
    // Descriptions: IMAGE + NOTE + PDF_ITEM + DUP_ITEM = 4 (BLANK_NOTE ignored).
    // Provenances: IMAGE (generated) + DUP_ITEM (element-portrait) = 2.
    assert_eq!(rec.material_descriptions_to_comments, 4);
    assert_eq!(rec.material_provenances_to_comments, 2);

    let lib = open(&root);
    let bytes = lib
        .load_copy(&format!("book:{BOOK}"))
        .unwrap()
        .export(loro::ExportMode::Snapshot)
        .unwrap();
    let book_id = BookId::parse(BOOK).unwrap();
    let book = BookDocV3::load(book_id.clone(), random_device_peer(), &[bytes]).unwrap();
    let view = book.view();

    let want_mat_ts = dr_import_v1::time::parse_iso(MAT_TS).unwrap();
    let want_import_ts = dr_model::Timestamp(receipt.started_ms / 1000);
    let check_comment = |mid_str: &str,
                         slot: &str,
                         want_target: dr_model::shared::EntityRef,
                         want_body: &str,
                         want_ts: dr_model::Timestamp|
     -> CommentId {
        let cid = dr_import_v1::book::material_comment_id(&book_id, mid_str, slot);
        let c = view
            .comment(&cid)
            .unwrap_or_else(|| panic!("missing {mid_str}:{slot}"));
        assert_eq!(c.target, Some(want_target));
        assert_eq!(c.target_module, None);
        assert_eq!(c.part, None);
        assert!(!c.target_missing);
        assert_eq!(c.status, CommentStatus::Resolved);
        assert_eq!(c.origin, CommentOrigin::Manual);
        assert_eq!(c.author_kind, CommentAuthorKind::User);
        assert_eq!(c.source, CommentSource::Manual);
        assert_eq!(c.metadata, None);
        assert_eq!(c.body, want_body);
        assert_eq!(c.created_at, Some(want_ts));
        assert_eq!(c.updated_at, Some(want_ts));
        assert_eq!(c.resolved_at, Some(want_ts));
        cid
    };

    // Generated image: description + readable provenance both on ASSET.
    let c_img_desc = check_comment(
        IMAGE,
        "description",
        dr_model::shared::EntityRef::new(EntityKind::Asset, ASSET),
        "未庄的土谷祠",
        want_mat_ts,
    );
    let c_img_prov = check_comment(
        IMAGE,
        "provenance",
        dr_model::shared::EntityRef::new(EntityKind::Asset, ASSET),
        "模型：gpt-image-1\n主体：未庄的土谷祠\n风格：水墨淡彩\n附加提示词：不要现代器物\n生成对象：阿Q\n生成时间：2025-01-02T03:04:05.000Z",
        want_mat_ts,
    );
    // PDF: description on PDF_ASSET.
    let c_pdf_desc = check_comment(
        PDF_ITEM,
        "description",
        dr_model::shared::EntityRef::new(EntityKind::Asset, PDF_ASSET),
        "绍兴府城防旧档",
        want_mat_ts,
    );
    // Text note: description on whole Entry(NOTE), without module.
    let note_ts = dr_import_v1::time::parse_iso(T0).unwrap();
    let c_note_desc = check_comment(
        NOTE,
        "description",
        dr_model::shared::EntityRef::new(EntityKind::Entry, NOTE),
        "王胡与小D的记事",
        note_ts,
    );
    // Duplicate-byte image merged into ASSET: its own description and former-portrait provenance
    // also attach to kept ASSET, with fallback to import timestamp.
    let c_dup_desc = check_comment(
        DUP_ITEM,
        "description",
        dr_model::shared::EntityRef::new(EntityKind::Asset, ASSET),
        "换下前的草稿立绘",
        want_import_ts,
    );
    let c_dup_prov = check_comment(
        DUP_ITEM,
        "provenance",
        dr_model::shared::EntityRef::new(EntityKind::Asset, ASSET),
        "原为「阿Q」的立绘\n换下时间：2025-04-01T09:00:00.000Z",
        want_import_ts,
    );
    // Blank description creates no comment.
    assert!(
        view.comment(&dr_import_v1::book::material_comment_id(
            &book_id,
            BLANK_NOTE,
            "description"
        ))
        .is_none()
    );

    // Filtering by unresolved ("open"), as the review panel's default filter does,
    // excludes every imported material description and provenance comment.
    let open_ids: BTreeSet<CommentId> = view
        .comments()
        .into_iter()
        .filter(|c| c.status == CommentStatus::Open)
        .map(|c| c.id)
        .collect();
    for cid in [
        &c_img_desc,
        &c_img_prov,
        &c_pdf_desc,
        &c_note_desc,
        &c_dup_desc,
        &c_dup_prov,
    ] {
        assert!(
            !open_ids.contains(cid),
            "{cid} must be hidden when filtering open"
        );
    }

    // Raw JSON remains in import_original; summary.md lists counts only.
    for (mid_str, field) in [
        (IMAGE, "description"),
        (IMAGE, "provenance"),
        (PDF_ITEM, "description"),
        (NOTE, "description"),
        (DUP_ITEM, "description"),
        (DUP_ITEM, "provenance"),
    ] {
        assert!(
            receipt
                .originals
                .iter()
                .any(|(col, id, f, _)| col == "materials" && id == mid_str && f == field),
            "missing import_original for {mid_str}:{field}"
        );
    }
    let summary_md = std::fs::read_to_string(root.join("import-v1").join("summary.md")).unwrap();
    assert!(
        summary_md.contains("旧版素材上的 4 条说明、2 条出处已转为已解决的批注"),
        "{summary_md}"
    );
    for raw_text in [
        "绍兴府城防旧档",
        "王胡与小D的记事",
        "换下前的草稿立绘",
        "gpt-image-1",
    ] {
        assert!(
            !summary_md.contains(raw_text),
            "{raw_text} leaked into {summary_md}"
        );
    }
    lib.close().unwrap();
}

/// The outermost entries of the book sequence that carry book prose (the
/// chapters; one living under an entry with book prose of its own is part of
/// it). The App numbers nothing.
fn outermost_with_prose<'a>(seq: Vec<dr_doc::v3::FlatEntry<'a>>) -> Vec<dr_doc::v3::FlatEntry<'a>> {
    let mut inside: Option<u32> = None;
    seq.into_iter()
        .filter(|e| {
            if inside.is_some_and(|d| e.depth <= d) {
                inside = None;
            }
            let outer = inside.is_none() && !e.prose.is_empty();
            if outer {
                inside = Some(e.depth);
            }
            outer
        })
        .collect()
}
