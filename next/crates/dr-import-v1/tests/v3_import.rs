//! Actual v3 results versus the independent, read-only inventory. Choices
//! below are synthetic test policy, not decisions for authors' libraries.

mod common;
#[path = "common/v3_manifest.rs"]
mod manifest;

use std::collections::BTreeSet;

use common::{v3_fixture as fixture, *};
use dr_doc::peer::random_device_peer;
use dr_doc::prose::ProseDoc;
use dr_doc::v3::novel::*;
use dr_doc::v3::{BookDocV3, BookViewV3};
use dr_import_v1::run::{self, Options, Outcome};
use dr_import_v1::v3::*;
use dr_model::id::*;
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
        act_binding: Some(ActBindingChoice {
            act_is_source: true,
            relation_type: RelationTypeV3 {
                id: RelationTypeId::parse("test-act-binding").unwrap(),
                name: "测试幕注".into(),
                normalized_name: "测试幕注".into(),
                description: String::new(),
                orientation: RelationOrientation::Directed,
                system_key: None,
                locked: false,
                source_role: String::new(),
                target_role: String::new(),
                color: None,
                source_kinds: vec![EntityKind::Entry],
                target_kinds: vec![EntityKind::Entry],
                source_templates: vec![tid(TPL_GROUP)],
                target_templates: vec![tid(TPL_IDEA)],
            },
        }),
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
        Act(id) | Node(id) | IdeaGroup(id) | Category(id) | Element(id) | Storyline(id) => eid(id),
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
        manifest::LeafTemplate::Category(id) => adapter::category_template(id),
        manifest::LeafTemplate::Storyline(id) => adapter::storyline_template(id),
    }
}

fn body_id(view: &BookViewV3<'_>, body: &manifest::Body) -> DocId {
    match body {
        manifest::Body::Leaf(entry) => adapter::body_id(entry_id(view, entry).as_str(), MOD_PROSE),
        manifest::Body::About(entry) => adapter::body_id(entry_id(view, entry).as_str(), MOD_ABOUT),
        manifest::Body::Material(id) => DocId::Material(MaterialId::parse(id).unwrap()),
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
            &DocId::Material(MaterialId::parse(NOTE).unwrap()),
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
        Material(id) => (EntityKind::Material, id.clone()),
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
    assert_eq!(view.meta().schema_version, 3);
    assert_eq!(
        view.manuscript_leaves(&entry_id(view, &manifest::Entry::Manuscript))
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
    assert_eq!(view.meta().word_target_set, expected.settings.word_target);
    assert_eq!(
        view.meta().daily_word_target_set,
        expected.settings.daily_word_target
    );
    for level in &expected.levels {
        let actual = view.entry(&entry_id(view, &level.entry)).unwrap();
        assert_eq!(actual.title, level.title, "{:?}", level.entry);
        assert_eq!(
            actual.parent,
            level.parent.as_ref().map(|e| entry_id(view, e)),
            "{:?}",
            level.entry
        );
        assert!(actual.is_level(&view.templates_map()));
        assert_eq!(actual.is_lane_level(&view.templates_map()), level.lane);
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
            assert_eq!(actual.layout.grid, x.zip(*y));
        }
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
        assert_eq!(actual.title, leaf.title);
        assert_eq!(actual.parent, leaf.home.as_ref().map(|e| entry_id(view, e)));
        assert_eq!(actual.template, leaf.template.as_ref().map(template_id));
        assert_eq!(
            text(&actual, "summary").as_deref(),
            Some(leaf.summary.as_str())
        );
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
            Some(manifest::Layout::Board(x, y)) => assert_eq!(actual.layout.board, Some((x, y))),
            Some(manifest::Layout::Graph(x, y)) => {
                assert_eq!(actual.layout.relation_graph, Some((x, y)))
            }
            _ => {}
        }
    }
    for template in &expected.leaf_templates {
        let actual = view.template(&template_id(&template.template)).unwrap();
        assert!(actual.is_leaf());
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
        let actual = view
            .comments()
            .into_iter()
            .find(|c| c.id == comment_id(&comment.old_id))
            .unwrap();
        assert_eq!(
            actual.target,
            comment.target.as_ref().map(|e| endpoint(view, e))
        );
        assert_eq!(actual.kind.as_str(), comment.kind);
        if let Some(body) = &comment.body
            && let DocId::Body(id) = body_id(view, body)
        {
            assert_eq!(actual.target_module.as_ref(), Some(id.module()));
        }
        let row = expected.source_rows["comment"]
            .iter()
            .find(|r| r["id"].as_str() == Some(&comment.old_id))
            .unwrap();
        assert_eq!(
            actual.body,
            dr_import_v1::book::plain_text(row["body_json"].as_str().unwrap()).0
        );
        assert_eq!(actual.metadata.as_deref(), row["metadata_json"].as_str());
    }
    assert_eq!(
        view.relations_raw().len(),
        expected.relations.len() + expected.act_bindings.len()
    );
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
    for binding in &expected.act_bindings {
        assert!(
            view.relations_raw()
                .iter()
                .any(|r| r.relation_type.as_str() == "test-act-binding"
                    && r.from.id == entry_id(view, &binding.act).as_str()
                    && r.to.id == entry_id(view, &binding.idea).as_str())
        );
    }
    assert_eq!(
        view.materials().len(),
        expected.source_rows["library_item"].len()
    );
    assert_eq!(
        view.material_folders().len(),
        expected.source_rows["material_folder"].len()
    );
    assert_eq!(
        view.assets().len(),
        expected.source_rows["project_asset"].len()
    );
    assert_eq!(
        view.memory().len(),
        expected.source_rows["agent_memory"].len()
    );
    assert_eq!(
        view.writing_days().len(),
        expected.source_rows["writing_day"].len()
    );
    for row in &expected.source_rows["library_item"] {
        let actual = view
            .materials()
            .into_iter()
            .find(|m| m.id.as_str() == row["id"].as_str().unwrap())
            .unwrap();
        assert_eq!(actual.title, row["title"].as_str().unwrap());
        assert_eq!(
            actual.folder.as_ref().map(|id| id.as_str()),
            row["folder_id"].as_str()
        );
        assert_eq!(
            actual.asset.as_ref().map(|id| id.as_str()),
            row["asset_id"].as_str()
        );
        assert_eq!(actual.task_todos, row["task_todos"].as_i64() == Some(1));
        assert_eq!(
            actual.provenance.as_deref(),
            row["provenance_json"].as_str()
        );
        if let Some(notes) = row["notes_json"].as_str() {
            assert_eq!(actual.description, dr_import_v1::book::plain_text(notes).0);
        }
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
            view.writing_days()
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
                profile: if matches!(body.target, manifest::Body::Material(_)) {
                    ProseProfile::Note
                } else {
                    ProseProfile::Prose
                },
                span: &|old| spans.get(old).cloned(),
                todo: &|id| Some(comment_id(id)),
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
    let old = fixture::build();
    let temp = tempfile::tempdir().unwrap();
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
    assert_eq!(
        codes,
        BTreeSet::from(["act-binding-relation-type-and-direction"])
    );
    assert!(!device.exists());
    assert!(!root.join("library.sqlite").exists());
}

#[test]
fn every_inventory_row_imports_into_real_v3_documents_with_history() {
    let old = fixture::build();
    let expected = manifest::read(&old.db, BOOK).unwrap();
    let before = sha256_bytes(&std::fs::read(&old.db).unwrap());
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("library");
    let (outcome, _) = run::import(&old.db, &root, &options(&old)).unwrap();
    let Outcome::Imported(receipt) = outcome else {
        panic!("not imported")
    };
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
    assert_eq!(sha256_bytes(&std::fs::read(&old.db).unwrap()), before);
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
        [TPL_MANUSCRIPT, TPL_IDEAS, TPL_ELEMENTS, TPL_STORYLINES]
            .iter()
            .map(|tpl| book.view().root_entry_by_template(&tid(tpl)).unwrap().id)
            .collect()
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
    changed
        .v3
        .act_binding
        .as_mut()
        .unwrap()
        .relation_type
        .description = "different test policy".into();
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
fn the_development_cli_exposes_v3_preflight_without_choosing_policy() {
    let old = fixture::build();
    let temp = tempfile::tempdir().unwrap();
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
    assert_eq!(value["outcome"], "v3-pending");
    assert!(!value["pending"].as_array().unwrap().is_empty());
    assert!(!root.join("library.sqlite").exists());
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
                        "text": "素材错挂模块",
                        "marks": [{"type": "entityLink", "attrs": {"targetKind": "library_item", "targetId": NOTE, "targetModule": MOD_PROSE}}]
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
                                    "text": "正文表格禁高亮",
                                    "marks": [{"type": "highlight", "attrs": {"color": "#ff0"}}]
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
                    "marks": [{"type": "entityLink", "attrs": {"targetKind": "category", "targetId": CATEGORY, "module": MOD_ABOUT}}]
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
                    kind: EntityKind::Material,
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
                    module: Some(mid(MOD_ABOUT)),
                    block: Some(BlockId::parse("s-p1").unwrap()),
                    end_block: None,
                }
            ),
            (
                13..17,
                EntityLinkV3 {
                    target: CATEGORY.into(),
                    kind: EntityKind::Entry,
                    module: Some(mid(MOD_ABOUT)),
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
                kind: EntityKind::Material,
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
                    kind: EntityKind::Material,
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
    let cat_doc_id = adapter::body_id(CATEGORY, MOD_ABOUT);
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
                    kind: EntityKind::Material,
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

    // 2. Note-profile material table cell preserves highlight + code + explicit-module entityLink!
    let note_doc_id = DocId::Material(MaterialId::parse(NOTE).unwrap());
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

    let timeline = &view.timeline_views_raw()[0];
    assert_eq!(
        timeline
            .lanes
            .iter()
            .map(|l| l.entry.clone())
            .collect::<Vec<_>>(),
        [
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
    assert_eq!(
        view_no_unaff.timeline_views_raw()[0]
            .lanes
            .iter()
            .map(|l| l.entry.as_str())
            .collect::<Vec<_>>(),
        [fixture::STORYLINE_OTHER, STORYLINE]
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
            EntityKind::Material,
        ],
        "node/element/category/storyline collapse to one Entry alongside Patch, Comment and Material"
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
        [EntityKind::Comment, EntityKind::Material]
    );
    assert_eq!(generic.target_kinds, [EntityKind::Entry, EntityKind::Patch]);
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
