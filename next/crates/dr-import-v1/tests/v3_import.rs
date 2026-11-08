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
    let mut choice = MappingChoices::default();
    let mut lane = novel_project_templates()
        .into_iter()
        .find(|t| t.id.as_str() == TPL_STORYLINE)
        .unwrap();
    lane.id = tid("test-unaffiliated-template");
    lane.settings.home = Some(None);
    choice.unaffiliated = Some(UnaffiliatedChoice {
        parent: None,
        template: lane,
    });
    choice.act_binding = Some(ActBindingChoice {
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
    });
    choice.relation_templates.insert(
        RelationTypeId::parse(REL_TYPE).unwrap(),
        TemplateRestriction {
            source: vec![
                adapter::category_template(CATEGORY),
                adapter::category_template(fixture::CATEGORY_OTHER),
            ],
            target: vec![],
        },
    );
    choice.relation_templates.insert(
        RelationTypeId::parse(fixture::PATCH_RELATION).unwrap(),
        TemplateRestriction {
            source: vec![],
            target: vec![tid(TPL_STORYLINE)],
        },
    );
    choice
}

fn entry_id(entry: &manifest::Entry) -> EntryId {
    use manifest::Entry::*;
    match entry {
        Manuscript => eid(ROOT_MANUSCRIPT),
        Ideas => eid(ROOT_IDEAS),
        Elements => eid(ROOT_ELEMENTS),
        Storylines => eid(ROOT_STORYLINES),
        Act(id) | Node(id) | IdeaGroup(id) | Category(id) | Element(id) | Storyline(id) => eid(id),
        ElementGroup { category, name } => adapter::element_group(category, name),
        Unaffiliated => eid(adapter::UNAFFILIATED),
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

fn body_id(body: &manifest::Body) -> DocId {
    match body {
        manifest::Body::Leaf(entry) => adapter::body_id(entry_id(entry).as_str(), MOD_PROSE),
        manifest::Body::About(entry) => adapter::body_id(entry_id(entry).as_str(), MOD_ABOUT),
        manifest::Body::Material(id) => DocId::Material(MaterialId::parse(id).unwrap()),
        manifest::Body::Template(template) => DocId::Template(TemplateId::for_entry_module(
            &template_id(template),
            &mid(MOD_PROSE),
        )),
    }
}

fn options(old: &Old) -> Options {
    let mut options = Options::new("k3-v3-test");
    options.v3 = Some(choices());
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

fn endpoint(endpoint: &manifest::Endpoint) -> dr_model::book::EntityRef {
    use manifest::Endpoint::*;
    let (kind, id) = match endpoint {
        Entry(e) => (EntityKind::Entry, entry_id(e).to_string()),
        Material(id) => (EntityKind::Material, id.clone()),
        Comment(id) => (EntityKind::Comment, comment_id(id).to_string()),
        Patch(id) => (EntityKind::Patch, id.clone()),
        Unresolved { kind, id } => panic!("unexpected unresolved fixture endpoint: {kind}:{id}"),
    };
    dr_model::book::EntityRef::new(kind, id)
}

fn compare(view: &BookViewV3<'_>, expected: &manifest::Manifest, lib: &Library) {
    adapter::validate(view).unwrap();
    let counts = expected.counts();
    assert_eq!(view.entries_raw().len(), counts.levels + counts.leaves);
    assert_eq!(view.meta().schema_version, 3);
    assert_eq!(
        view.manuscript_leaves(&eid(ROOT_MANUSCRIPT))
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
        view.children_of(Some(&eid(ROOT_MANUSCRIPT)))
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
        let actual = view.entry(&entry_id(&level.entry)).unwrap();
        assert_eq!(actual.title, level.title, "{:?}", level.entry);
        // The independent oracle intentionally leaves the synthetic home
        // undecided. Only this test supplies its explicit home/template.
        if level.entry != manifest::Entry::Unaffiliated {
            assert_eq!(actual.parent, level.parent.as_ref().map(entry_id));
        }
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
    for leaf in &expected.leaves {
        let actual = view.entry(&entry_id(&leaf.entry)).unwrap();
        assert_eq!(actual.title, leaf.title);
        assert_eq!(actual.parent, leaf.home.as_ref().map(entry_id));
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
            assert!(
                actual
                    .modules
                    .iter()
                    .flat_map(|m| &m.config.defs)
                    .any(|d| d.name == field.name && d.id == field.old_id)
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
        .map(|m| (entry_id(&m.level), entry_id(&m.member), m.primary))
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
            .map(entry_id)
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
        .map(|p| (entry_id(&p.entry), p.at, p.span))
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
                &pin.entry.as_ref().map(entry_id)
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
        assert_eq!(actual.entry, entry_id(&patch.owner));
        assert_eq!(actual.module, mid(MOD_PATCHES));
        assert_eq!(
            actual.source_entry,
            patch.source.as_ref().and_then(|b| match b {
                manifest::Body::Leaf(e) => Some(entry_id(e)),
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
            .plot_grid(&entry_id(&grid.entry), &mid(MOD_PLOT_GRID))
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
        assert_eq!(actual.target, comment.target.as_ref().map(endpoint));
        assert_eq!(actual.kind.as_str(), comment.kind);
        if let Some(body) = &comment.body
            && let DocId::Body(id) = body_id(body)
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
            dr_model::book::canonical_symmetric(endpoint(&relation.from), endpoint(&relation.to))
        } else {
            (endpoint(&relation.from), endpoint(&relation.to))
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
                    && r.from.id == entry_id(&binding.act).as_str()
                    && r.to.id == entry_id(&binding.idea).as_str())
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
    for body in &expected.prose {
        if matches!(body.target, manifest::Body::Template(_))
            && body
                .json
                .as_deref()
                .is_none_or(|j| !manifest::nonempty_body(j).unwrap())
        {
            continue;
        }
        let id = body_id(&body.target);
        let doc = load_prose(lib, &id);
        let json = body.json.as_deref().unwrap_or("{}");
        let lines = dr_import_v1::prose::pm::parse(json).unwrap();
        let blocks = dr_import_v1::prose::doc_blocks(&lines);
        let plan = dr_import_v1::prose::plan(
            &lines,
            &blocks,
            &dr_import_v1::prose::Context {
                profile: if matches!(body.target, manifest::Body::Material(_)) {
                    ProseProfile::Note
                } else {
                    ProseProfile::Prose
                },
                span: &|_| None,
                todo: &|id| Some(comment_id(id)),
            },
        );
        assert_eq!(
            doc.view().plain_text().trim_end_matches('\n'),
            plan.body_text().trim_end_matches('\n'),
            "{id}"
        );
        let actual = dr_import_v1::prose::read::read_paras(&doc.view());
        assert_eq!(actual.len(), plan.paras.len(), "{id}");
        for (actual, mut expected) in actual.iter().zip(plan.paras) {
            for run in &mut expected.runs {
                for link in &mut run.marks.entities {
                    link.kind = adapter::map_kind(&link.kind);
                }
            }
            if expected.id.is_some() {
                assert_eq!(actual.id, expected.id, "{id}");
            }
            assert_eq!(actual.attrs, expected.attrs, "{id}");
            assert_eq!(actual.runs, expected.runs, "{id}");
            assert_eq!(actual.embed, expected.embed, "{id}");
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
    options.v3 = Some(MappingChoices::default());
    options.device_dir = Some(device.clone());
    let error = run::import(&old.db, &root, &options).unwrap_err();
    let dr_import_v1::ImportError::V3Pending(pending) = error else {
        panic!("{error}")
    };
    let codes: BTreeSet<_> = pending.iter().map(|p| p.code.as_str()).collect();
    assert!(codes.contains("act-binding-relation-type-and-direction"));
    assert!(codes.contains("synthetic-lane-tree-home-and-template-settings"));
    assert!(codes.contains("relation-type-template-restrictions"));
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
        .as_mut()
        .unwrap()
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
    let mut v2 = options(&old);
    v2.v3 = None;
    assert!(
        matches!(run::import(&old.db,&root,&v2),Err(dr_import_v1::ImportError::Invalid(message)) if message.contains("another import path"))
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
            "UPDATE entity_kv_entry SET value='default' WHERE id='kv-7'",
            "field-default-value-interface-missing",
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
    for (attrs, code) in [
        (
            json!({"targetKind":"library_item","targetId":NOTE}),
            "v3-prose-link-writer-missing",
        ),
        (
            json!({"targetKind":"element","targetId":ELEMENT,"targetBlockId":"e-p1"}),
            "v3-prose-link-writer-missing",
        ),
        (
            json!({"targetKind":"element","targetId":ELEMENT,"targetModule":MOD_PROSE}),
            "v3-prose-link-writer-missing",
        ),
        (serde_json::Value::Null, "legacy-table-cell-format-mapping"),
    ] {
        let old = fixture::build();
        let mut body: serde_json::Value = serde_json::from_str(ELEMENT_JSON).unwrap();
        if attrs.is_null() {
            let paragraph = body["content"][0].clone();
            body["content"] = json!([{"type":"table","content":[{"type":"tableRow","content":[{"type":"tableCell","content":[paragraph]}]}]}]);
        } else {
            body["content"][0]["content"][0]["marks"] =
                json!([{"type":"entityLink","attrs":attrs}]);
        }
        let c = rusqlite::Connection::open(&old.db).unwrap();
        c.execute(
            "UPDATE element SET content_json=?1 WHERE id=?2",
            rusqlite::params![body.to_string(), ELEMENT],
        )
        .unwrap();
        drop(c);
        let before = sha256_bytes(&std::fs::read(&old.db).unwrap());
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("library");
        let mut options = options(&old);
        options.accept = dr_import_v1::gate::Accept::EVERYTHING;
        let error = run::import(&old.db, &root, &options).unwrap_err();
        assert!(
            matches!(&error,dr_import_v1::ImportError::V3Pending(p) if p.iter().any(|p| p.code == code)),
            "{error}"
        );
        assert!(!root.join("library.sqlite").exists());
        assert_eq!(before, sha256_bytes(&std::fs::read(&old.db).unwrap()));
    }
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
