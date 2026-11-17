use std::time::{Duration, UNIX_EPOCH};

use dr_export::{Block, Labels, Options, Section, v3};
use dr_model::prose::Heading;
use dr_workspace::{Actor, Workspace};
use serde_json::{Value, json};

fn call(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input).unwrap()["output"].clone()
}

fn fixture() -> (tempfile::TempDir, Workspace, String) {
    let dir = tempfile::tempdir().unwrap();
    let store =
        dr_store::Library::open(dir.path(), dr_workspace::library_options("0.2.0-dev")).unwrap();
    let seed = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let id = seed.books[0].book_id().to_string();
    seed.write_to(&store).unwrap();
    store.close().unwrap();
    let ws = Workspace::open_dir(dir.path(), "0.2.0-dev").unwrap();
    (dir, ws, id)
}

fn read(ws: &Workspace, book: &str, entries: Option<Vec<String>>) -> dr_export::Manuscript {
    v3::read_manuscript(
        ws,
        book,
        &Options {
            chapters: entries,
            act_titles: true,
            chapter_titles: true,
            ..Options::default()
        },
        &Labels {
            untitled_chapter: "Untitled".into(),
            untitled_act: "Unused".into(),
            options: Default::default(),
        },
        "en",
        None,
        UNIX_EPOCH + Duration::from_secs(1_793_434_150),
    )
    .unwrap()
}

#[test]
fn manuscript_keeps_resident_order_and_each_prose_module_once() {
    let (_dir, ws, book) = fixture();
    let outline = v3::outline(&ws, &book).unwrap();
    assert!(outline.entries.len() >= 2);
    assert!(outline.entries.iter().all(|e| e.prose.len() == 1));
    let (first, second) = (&outline.entries[0], &outline.entries[1]);
    let source = call(
        &ws,
        "module.read_prose",
        json!({"book":book,"owner":second.id,"module":"mod-prose"}),
    );
    let paragraph = source["paragraphs"][0]["text"].as_str().unwrap();
    call(
        &ws,
        "entry_template.put_module",
        json!({"book":book,"template":"tpl-chapter",
        "module":{"id":"second-body","kind":"prose","name":"Second body"}}),
    );
    call(
        &ws,
        "module.set_prose",
        json!({"book":book,"owner":first.id,"module":"second-body","paragraphs":[{"text":paragraph}]}),
    );
    let session = ws.prose_session(&first.prose[0].to_string()).unwrap();
    session
        .edit(|t| {
            let starts: Vec<_> = t
                .view()
                .paragraphs()
                .take(3)
                .map(|p| p.range.start)
                .collect();
            for (start, heading) in starts
                .into_iter()
                .zip([Heading::H1, Heading::H2, Heading::H3])
            {
                t.set_heading(start, Some(heading))?;
            }
            Ok(())
        })
        .unwrap();
    drop(session);
    let versions: Vec<_> = ws
        .library()
        .docs(Some(&book), None)
        .unwrap()
        .into_iter()
        .map(|d| (d.doc_id.clone(), ws.observe(&d.doc_id).unwrap().version))
        .collect();
    let selected = read(
        &ws,
        &book,
        Some(vec![
            second.id.clone(),
            first.id.clone(),
            first.id.clone(),
            "outside-manuscript".into(),
        ]),
    );
    assert_eq!(selected.sections.len(), 2);
    assert!(
        selected
            .sections
            .iter()
            .all(|s| matches!(s, Section::Chapter { .. })),
        "no built-in act titles in v3"
    );
    let Section::Chapter { title, blocks, .. } = &selected.sections[0] else {
        unreachable!()
    };
    assert_eq!(title, &first.title);
    let levels: Vec<_> = blocks
        .iter()
        .filter_map(|b| match b {
            Block::Heading { level, .. } => Some(*level),
            _ => None,
        })
        .collect();
    assert_eq!(&levels[..3], [1, 2, 3]);
    assert!(
        matches!(blocks.last(), Some(Block::Paragraph { runs, .. }) if runs.iter().map(|r| r.text.as_str()).collect::<String>() == paragraph)
    );
    let Section::Chapter { title, .. } = &selected.sections[1] else {
        unreachable!()
    };
    assert_eq!(title, &second.title);
    for (doc, version) in versions {
        assert_eq!(ws.observe(&doc).unwrap().version, version);
    }
    let bytes = dr_export::render(&selected, dr_export::Format::Docx).unwrap();
    assert!(!bytes.is_empty());
    call(
        &ws,
        "entry_template.remove_module",
        json!({"book":book,"template":"tpl-chapter","module":"second-body"}),
    );
    assert!(
        ws.library()
            .docs(Some(&book), None)
            .unwrap()
            .iter()
            .any(|d| d.doc_id == format!("body:{}/second-body", first.id))
    );
    assert_eq!(
        v3::outline(&ws, &book).unwrap().entries[0].prose.len(),
        1,
        "retained bodies are not silently inserted into the manuscript"
    );
    ws.shutdown().unwrap();
}

#[test]
fn trashed_entries_stay_out_ticked_non_book_entries_export_and_old_books_are_refused() {
    let (_dir, ws, book) = fixture();
    assert!(v3::is_book(&ws, &book).unwrap());
    let before = v3::outline(&ws, &book).unwrap();
    let entry = &before.entries[0].id;
    let details = call(&ws, "entry.get", json!({"book":book,"id":entry}));
    let root = details["parent"].as_str().unwrap();
    call(&ws, "entry.trash", json!({"book":book,"id":root}));
    let hidden = v3::outline(&ws, &book).unwrap();
    assert!(hidden.entries.len() < before.entries.len());
    assert!(!hidden.entries.iter().any(|e| &e.id == entry));
    assert!(!hidden.tree_ids().iter().any(|id| id == root || id == entry));
    let labels = Labels {
        untitled_chapter: "Untitled".into(),
        untitled_act: "Unused".into(),
        options: Default::default(),
    };
    assert!(matches!(
        v3::read_manuscript(
            &ws,
            &book,
            &Options {
                chapters: Some(vec![root.to_owned(), entry.clone()]),
                ..Options::default()
            },
            &labels,
            "en",
            None,
            UNIX_EPOCH
        ),
        Err(dr_export::ExportError::NoChapters)
    ));
    call(&ws, "entry.restore", json!({"book":book,"id":root}));
    assert_eq!(v3::outline(&ws, &book).unwrap(), before);
    let all = call(&ws, "entry.list", json!({"book":book,"all":true}));
    let non_book: Vec<_> = all
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|e| e["id"].as_str())
        .filter(|id| !before.entries.iter().any(|e| e.id == *id))
        .map(str::to_owned)
        .collect();
    assert!(!non_book.is_empty());
    // Book-prose mode (`chapters: None`) excludes non-book entries, while
    // manual tree selection (`chapters: Some(...)`) exports them.
    let book_only = read(&ws, &book, None);
    let non_book_titles: std::collections::HashSet<String> = all
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| {
            e["id"]
                .as_str()
                .is_some_and(|id| non_book.iter().any(|nb| nb == id))
        })
        .filter_map(|e| e["title"].as_str().map(str::to_owned))
        .collect();
    for section in &book_only.sections {
        if let Section::Chapter { title, .. } = section {
            assert!(!non_book_titles.contains(title));
        }
    }
    let picked_non_book = read(&ws, &book, Some(non_book));
    assert!(!picked_non_book.sections.is_empty());
    let old_id = dr_testkit::seed::acceptance::empty_source(ws.library());
    assert!(!v3::is_book(&ws, &old_id).unwrap());
    assert!(v3::outline(&ws, &old_id).is_err());
    assert!(dr_export::outline(&ws, &old_id).is_err());
    ws.shutdown().unwrap();
}

#[test]
fn descriptions_and_empty_levels_stay_out_while_own_book_prose_precedes_children() {
    let dir = tempfile::tempdir().unwrap();
    let lib = dr_store::Library::open(dir.path(), dr_workspace::library_options("test")).unwrap();
    let ws = Workspace::open(lib, dr_workspace::WorkspaceOptions::default()).unwrap();
    let book = call(&ws, "project.create", json!({"name": "多层级成书"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let manuscript_root = dr_testkit::seed::acceptance::novel_root(&ws, &book, "tpl-manuscript");

    // Write level descriptions (`in_book = false`) on both the manuscript root
    // and an intermediate organizing level (`第一卷`).
    call(
        &ws,
        "module.set_prose",
        json!({
            "book": book,
            "owner": manuscript_root,
            "module": "mod-description",
            "paragraphs": [{"text": "全书大纲说明，不进导出"}]
        }),
    );
    let volume_one = call(
        &ws,
        "entry.create",
        json!({
            "book": book,
            "parent": manuscript_root,
            "template": "tpl-group",
            "title": "第一卷",
            "bodies": {"mod-description": "第一卷说明，不进导出"}
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // Add a non-book note module (`in_book = false`) to `tpl-chapter` as well.
    call(
        &ws,
        "entry_template.put_module",
        json!({
            "book": book,
            "template": "tpl-chapter",
            "module": {
                "id": "author-notes",
                "kind": "prose",
                "name": "作者备注",
                "config": {"in_book": false}
            }
        }),
    );

    // Under `第一卷` (no book prose of its own), create a chapter whose level
    // switch is turned on so child chapters live beneath it.
    let parent_chapter = call(
        &ws,
        "entry.create",
        json!({
            "book": book,
            "parent": volume_one,
            "template": "tpl-chapter",
            "level": true,
            "title": "楔子与总起",
            "bodies": {
                "mod-prose": "总起自己的成书正文。",
                "author-notes": "总起备注，不进导出"
            }
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let child_one = call(
        &ws,
        "entry.create",
        json!({
            "book": book,
            "parent": parent_chapter,
            "template": "tpl-chapter",
            "title": "其一",
            "bodies": {
                "mod-prose": "子章一的正文。",
                "author-notes": "子章一备注，不进导出"
            }
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let child_two = call(
        &ws,
        "entry.create",
        json!({
            "book": book,
            "parent": volume_one,
            "template": "tpl-chapter",
            "title": "其二",
            "bodies": {"mod-prose": "同卷后一章的正文。"}
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let outline = v3::outline(&ws, &book).unwrap();
    assert!(outline.has_book);
    let ids: Vec<&str> = outline.entries.iter().map(|e| e.id.as_str()).collect();
    assert_eq!(
        ids,
        [
            parent_chapter.as_str(),
            child_one.as_str(),
            child_two.as_str()
        ],
        "organizing level without book prose stays out; parent chapter precedes its child"
    );

    let exported = read(&ws, &book, None);
    let rendered: Vec<(&str, String)> = exported
        .sections
        .iter()
        .map(|s| match s {
            Section::Chapter { title, blocks, .. } => {
                let text: String = blocks
                    .iter()
                    .filter_map(|b| match b {
                        Block::Paragraph { runs, .. } => {
                            Some(runs.iter().map(|r| r.text.as_str()).collect::<String>())
                        }
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                (title.as_str(), text)
            }
            Section::Act { .. } => panic!("no built-in act sections"),
        })
        .collect();
    assert_eq!(
        rendered,
        vec![
            ("楔子与总起", "总起自己的成书正文。".to_owned()),
            ("其一", "子章一的正文。".to_owned()),
            ("其二", "同卷后一章的正文。".to_owned()),
        ]
    );
    ws.close();
}

#[test]
fn export_reads_the_book_from_the_root_and_is_empty_when_the_book_is_off() {
    let dir = tempfile::tempdir().unwrap();
    let lib = dr_store::Library::open(dir.path(), dr_workspace::library_options("test")).unwrap();
    let ws = Workspace::open(lib, dr_workspace::WorkspaceOptions::default()).unwrap();
    let book = call(&ws, "project.create", json!({"name": "双卷书"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let main_part = dr_testkit::seed::acceptance::novel_root(&ws, &book, "tpl-manuscript");
    let ch_main = call(
        &ws,
        "entry.create",
        json!({
            "book": book,
            "parent": main_part,
            "template": "tpl-chapter",
            "title": "正篇第一章",
            "bodies": {"mod-prose": "正篇内容。"}
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // A second folder (`外篇 / 番外稿`) at the root, after the writing
    // template's own.
    let container = call(
        &ws,
        "entry.create",
        json!({
            "book": book,
            "template": "tpl-group",
            "level": true,
            "title": "外篇"
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let side_part = call(
        &ws,
        "entry.create",
        json!({
            "book": book,
            "parent": container,
            "template": "tpl-manuscript",
            "level": true,
            "title": "番外稿",
            "bodies": {"mod-description": "番外说明，不进导出"}
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let ch_side = call(
        &ws,
        "entry.create",
        json!({
            "book": book,
            "parent": side_part,
            "template": "tpl-chapter",
            "title": "番外一",
            "bodies": {"mod-prose": "番外内容。"}
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // One project has one book sequence, read from the root (DW): 书稿's
    // chapter, then the one under 外篇 / 番外稿.
    let outline = v3::outline(&ws, &book).unwrap();
    assert!(outline.has_book);
    assert_eq!(
        outline
            .entries
            .iter()
            .map(|e| e.id.clone())
            .collect::<Vec<_>>(),
        vec![ch_main.clone(), ch_side.clone()]
    );

    let labels = Labels {
        untitled_chapter: "Untitled".into(),
        untitled_act: "Unused".into(),
        options: Default::default(),
    };
    let only_side = v3::read_manuscript(
        &ws,
        &book,
        &Options {
            chapters: Some(vec![ch_side.clone()]),
            chapter_titles: true,
            ..Options::default()
        },
        &labels,
        "zh-CN",
        None,
        UNIX_EPOCH,
    )
    .unwrap();
    let side_titles: Vec<&str> = only_side
        .sections
        .iter()
        .map(|s| match s {
            Section::Chapter { title, .. } => title.as_str(),
            Section::Act { .. } => unreachable!(),
        })
        .collect();
    assert_eq!(side_titles, ["番外一"]);

    // Build a timeline view with two lanes (`主线甲`, `主线乙`): chapters
    // attached to them live in 书稿, so they are in the book where 书稿 is.
    let storylines_root = dr_testkit::seed::acceptance::novel_root(&ws, &book, "tpl-storylines");
    let lane_a = call(
        &ws,
        "entry.create",
        json!({
            "book": book,
            "parent": storylines_root,
            "template": "tpl-storyline",
            "title": "主线甲"
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let lane_b = call(
        &ws,
        "entry.create",
        json!({
            "book": book,
            "parent": storylines_root,
            "template": "tpl-storyline",
            "title": "主线乙"
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // Create three chapter entries attached to lanes (and keep `ch_main` & `ch_side` unattached).
    let ch_b_early = call(
        &ws,
        "entry.create",
        json!({
            "book": book,
            "host": lane_b,
            "template": "tpl-chapter",
            "title": "乙线早章",
            "bodies": {"mod-prose": "乙线先发生。"}
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let ch_a_mid = call(
        &ws,
        "entry.create",
        json!({
            "book": book,
            "host": lane_a,
            "template": "tpl-chapter",
            "title": "甲线中章",
            "bodies": {"mod-prose": "甲线居中。"}
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let ch_a_late = call(
        &ws,
        "entry.create",
        json!({
            "book": book,
            "host": lane_a,
            "template": "tpl-chapter",
            "title": "甲线后章",
            "bodies": {"mod-prose": "甲线收束。"}
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let view_id = dr_model::id::TimelineViewId::new_v7().to_string();
    call(
        &ws,
        "timeline_view.put",
        json!({
            "book": book,
            "view": {
                "id": view_id,
                "name": "全书时间线",
                "lanes": [
                    {"entry": lane_a, "pos": "a0"},
                    {"entry": lane_b, "pos": "a1"}
                ],
                "placements": [
                    {"entry": ch_b_early, "at": 10.0},
                    {"entry": ch_a_mid, "at": 20.0},
                    {"entry": ch_a_late, "at": 30.0}
                ],
                "pins": []
            }
        }),
    );

    let titles = |m: &dr_export::Manuscript| -> Vec<String> {
        m.sections
            .iter()
            .map(|s| match s {
                Section::Chapter { title, .. } => title.clone(),
                Section::Act { .. } => unreachable!(),
            })
            .collect()
    };
    // 书稿 in its manual order, then 番外稿.
    assert_eq!(
        titles(&read(&ws, &book, None)),
        ["正篇第一章", "乙线早章", "甲线中章", "甲线后章", "番外一"]
    );

    // Disabling `成书` yields `has_book == false`, an empty book-prose outline,
    // and refuses `chapters: None`, while manual tree selection exports the whole tree.
    call(
        &ws,
        "project.update",
        json!({"book": book, "has_book": false}),
    );
    let disabled = v3::outline(&ws, &book).unwrap();
    assert!(!disabled.has_book);
    assert!(disabled.entries.is_empty());
    assert!(!disabled.tree.is_empty());
    assert!(matches!(
        v3::read_manuscript(
            &ws,
            &book,
            &Options::default(),
            &labels,
            "zh-CN",
            None,
            UNIX_EPOCH
        ),
        Err(dr_export::ExportError::NoChapters)
    ));
    let tree_export = read(&ws, &book, Some(disabled.tree_ids()));
    assert_eq!(tree_export.sections.len(), disabled.tree_ids().len());
    ws.close();
}

#[test]
fn tree_selection_exports_all_content_modules_with_tree_hierarchy_across_formats() {
    use dr_model::id::AssetId;
    use dr_store::asset::{MAX_COPY_BYTES, SourceImport};
    use sha2::{Digest, Sha256};
    use std::io::Read as _;

    let dir = tempfile::tempdir().unwrap();
    let lib = dr_store::Library::open(dir.path(), dr_workspace::library_options("test")).unwrap();
    let ws = Workspace::open(lib, dr_workspace::WorkspaceOptions::default()).unwrap();
    let book = call(&ws, "project.create", json!({"name": "全内容树导出"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    call(
        &ws,
        "project.update",
        json!({"book": book, "has_book": false}),
    );

    // Rich custom entry template carrying every data-bearing module kind:
    // non-in_book Prose, Fields (text, number, toggle, aliases, entity_ref, image),
    // KeyValue, Media, Patches, PlotGrid, Relations, plus structural Children/Members.
    let png_bytes = dr_testkit::media::png(18, 12);
    let png_path = dir.path().join("portrait.png");
    std::fs::write(&png_path, &png_bytes).unwrap();
    let png_sha = format!("{:x}", Sha256::digest(&png_bytes));
    let live_img = AssetId::new_v7().to_string();
    ws.library()
        .import_asset(&SourceImport {
            book_id: &book,
            asset_id: &live_img,
            source: &png_path,
            mime: "image/png",
            ext: "png",
            dimensions: Some((18, 12)),
            limit: MAX_COPY_BYTES,
        })
        .unwrap();
    call(
        &ws,
        "asset.put",
        json!({
            "book": book,
            "id": live_img,
            "name": "人物立绘.png",
            "kind": "image",
            "mime": "image/png",
            "size": png_bytes.len() as i64,
            "sha256": png_sha,
            "width": 18,
            "height": 12,
        }),
    );

    let pdf_bytes = dr_testkit::media::sample_pdf();
    let pdf_path = dir.path().join("dossier.pdf");
    std::fs::write(&pdf_path, &pdf_bytes).unwrap();
    let pdf_sha = format!("{:x}", Sha256::digest(&pdf_bytes));
    let live_pdf = AssetId::new_v7().to_string();
    ws.library()
        .import_asset(&SourceImport {
            book_id: &book,
            asset_id: &live_pdf,
            source: &pdf_path,
            mime: "application/pdf",
            ext: "pdf",
            dimensions: None,
            limit: MAX_COPY_BYTES,
        })
        .unwrap();
    call(
        &ws,
        "asset.put",
        json!({
            "book": book,
            "id": live_pdf,
            "name": "卷宗档案.pdf",
            "kind": "pdf",
            "mime": "application/pdf",
            "size": pdf_bytes.len() as i64,
            "sha256": pdf_sha,
        }),
    );

    let trashed_bytes = dr_testkit::media::png(8, 8);
    let trashed_png_path = dir.path().join("trashed.png");
    std::fs::write(&trashed_png_path, &trashed_bytes).unwrap();
    let trashed_sha = format!("{:x}", Sha256::digest(&trashed_bytes));
    let trashed_img = AssetId::new_v7().to_string();
    ws.library()
        .import_asset(&SourceImport {
            book_id: &book,
            asset_id: &trashed_img,
            source: &trashed_png_path,
            mime: "image/png",
            ext: "png",
            dimensions: Some((8, 8)),
            limit: MAX_COPY_BYTES,
        })
        .unwrap();
    call(
        &ws,
        "asset.put",
        json!({
            "book": book,
            "id": trashed_img,
            "name": "废弃草图.png",
            "kind": "image",
            "mime": "image/png",
            "size": trashed_bytes.len() as i64,
            "sha256": trashed_sha,
            "width": 8,
            "height": 8,
        }),
    );

    let tpl_rich = call(
        &ws,
        "entry_template.put",
        json!({
            "book": book,
            "template": {
                "id": "tpl-archive-card",
                "name": "档案卡",
                "level": true,
                "modules": [
                    {
                        "id": "mod-notes",
                        "kind": "prose",
                        "name": "非成书备注",
                        "config": {"in_book": false}
                    },
                    {
                        "id": "mod-fields",
                        "kind": "fields",
                        "name": "属性",
                        "config": {
                            "defs": [
                                {"id": "role", "name": "身份", "field_type": "text"},
                                {"id": "age", "name": "年龄", "field_type": "number"},
                                {"id": "alive", "name": "在场", "field_type": "toggle"},
                                {"id": "aliases", "name": "别称", "field_type": "aliases"},
                                {"id": "mentor", "name": "师承", "field_type": "entity_ref"},
                                {"id": "avatar", "name": "肖像", "field_type": "image"},
                                {"id": "discarded", "name": "旧图", "field_type": "image"}
                            ]
                        }
                    },
                    {"id": "mod-kv", "kind": "kv", "name": "补充键值"},
                    {"id": "mod-media", "kind": "media", "name": "附件"},
                    {"id": "mod-patches", "kind": "patches", "name": "摘录补丁"},
                    {"id": "mod-grid", "kind": "plot_grid", "name": "阶段规划"},
                    {"id": "mod-kids", "kind": "children", "name": "下面的条目"},
                    {"id": "mod-members", "kind": "members", "name": "挂在这里的条目"}
                ]
            }
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let root_group = call(
        &ws,
        "entry.create",
        json!({
            "book": book,
            "parent": null,
            "level": true,
            "title": "人物卷宗"
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let mentor = call(
        &ws,
        "entry.create",
        json!({
            "book": book,
            "parent": root_group,
            "title": "老守塔人"
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let card = call(
        &ws,
        "entry.create",
        json!({
            "book": book,
            "parent": root_group,
            "template": tpl_rich,
            "level": true,
            "title": "林晚",
            "bodies": {"mod-notes": "备注正文：只在自己勾时导出。"}
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    for (field, value) in [
        ("role", json!("校对员")),
        ("age", json!(29)),
        ("alive", json!(true)),
        ("aliases", json!(["阿晚", "小晚"])),
        ("mentor", json!(mentor.clone())),
        ("avatar", json!(live_img.clone())),
        ("discarded", json!(trashed_img.clone())),
    ] {
        call(
            &ws,
            "module.set_field",
            json!({
                "book": book,
                "entry": card,
                "module": "mod-fields",
                "field": field,
                "value": value
            }),
        );
    }
    let sub_note = call(
        &ws,
        "entry.create",
        json!({
            "book": book,
            "parent": card,
            "template": "tpl-note",
            "title": "旧伤来历",
            "bodies": {"mod-prose": "小时候在灯室被碎玻璃划伤。"}
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // Populate KV, Media (live PDF + trashed image), Patch, PlotGrid, and Relation.
    call(
        &ws,
        "module.put_kv",
        json!({
            "book": book,
            "entry": card,
            "module": "mod-kv",
            "row": {"id": "kv-1", "key": "惯用手", "value": "左手"}
        }),
    );
    call(
        &ws,
        "module.put_media",
        json!({
            "book": book,
            "entry": card,
            "module": "mod-media",
            "item": {"id": "m-1", "asset": live_pdf, "caption": "北岬调令"}
        }),
    );
    call(
        &ws,
        "module.put_media",
        json!({
            "book": book,
            "entry": card,
            "module": "mod-media",
            "item": {"id": "m-2", "asset": trashed_img, "caption": "废弃草图说明"}
        }),
    );
    call(&ws, "asset.trash", json!({"book": book, "id": trashed_img}));
    call(
        &ws,
        "module.put_grid",
        json!({
            "book": book,
            "entry": card,
            "module": "mod-grid",
            "grid": {
                "cell_w": 180,
                "cell_h": 120,
                "rows": [{"id": "r1", "pos": "a0", "label": "雾夜"}],
                "columns": [{"id": "c1", "pos": "a0", "label": "行动"}],
                "cells": [{"row": "r1", "column": "c1", "text": "登塔守灯"}]
            }
        }),
    );
    call(
        &ws,
        "module.put_patch",
        json!({
            "book": book,
            "entry": card,
            "module": "mod-patches",
            "title": "手腕旧伤",
            "body": "与十年前台风夜有关。"
        }),
    );
    call(
        &ws,
        "relation_row.create_pair",
        json!({
            "book":book,"left":card,"right":mentor,"new_type":{"name":"只在关系中"},
        }),
    );

    let outline = v3::outline(&ws, &book).unwrap();
    assert!(!outline.has_book);
    let picked = vec![root_group.clone(), card.clone(), sub_note.clone()];
    let manuscript = read(&ws, &book, Some(picked));
    let summary: Vec<(&str, Option<u8>, bool)> = manuscript
        .sections
        .iter()
        .map(|s| match s {
            Section::Chapter {
                title,
                depth,
                show_title,
                ..
            } => (title.as_str(), *depth, *show_title),
            Section::Act { .. } => unreachable!(),
        })
        .collect();
    assert_eq!(
        summary,
        [
            ("人物卷宗", Some(0), true),
            ("林晚", Some(1), true),
            ("旧伤来历", Some(2), true),
        ]
    );

    let Section::Chapter { blocks, .. } = &manuscript.sections[1] else {
        unreachable!()
    };
    let rendered_json = serde_json::to_string(blocks).unwrap();
    assert!(!rendered_json.contains("只在关系中"));
    for expected in [
        "备注正文：只在自己勾时导出。",
        "校对员",
        "29",
        "阿晚、小晚",
        "老守塔人",
        "肖像",
        "惯用手",
        "左手",
        "卷宗档案.pdf — 北岬调令",
        "手腕旧伤",
        "与十年前台风夜有关。",
        "雾夜",
        "行动",
        "登塔守灯",
    ] {
        assert!(
            rendered_json.contains(expected),
            "missing `{expected}` in exported blocks: {rendered_json}"
        );
    }
    assert!(!rendered_json.contains("废弃草图"));
    assert!(!rendered_json.contains("旧图"));

    // Verify EPUB, DOCX, and PDF all render the hierarchical tree manuscript cleanly.
    let epub = dr_export::render(&manuscript, dr_export::Format::Epub).unwrap();
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(&epub)).unwrap();
    let mut nav_xhtml = String::new();
    archive
        .by_name("OEBPS/nav.xhtml")
        .unwrap()
        .read_to_string(&mut nav_xhtml)
        .unwrap();
    assert!(nav_xhtml.contains("人物卷宗"));
    assert!(nav_xhtml.contains("<ol>\n<li><a href=\"text/s0002.xhtml\">林晚</a>"));
    let mut s1 = String::new();
    archive
        .by_name("OEBPS/text/s0001.xhtml")
        .unwrap()
        .read_to_string(&mut s1)
        .unwrap();
    let mut s2 = String::new();
    archive
        .by_name("OEBPS/text/s0002.xhtml")
        .unwrap()
        .read_to_string(&mut s2)
        .unwrap();
    let mut s3 = String::new();
    archive
        .by_name("OEBPS/text/s0003.xhtml")
        .unwrap()
        .read_to_string(&mut s3)
        .unwrap();
    assert!(s1.contains("<h1 class=\"chapter-title depth-0\">人物卷宗</h1>"));
    assert!(s2.contains("<h2 class=\"chapter-title depth-1\">林晚</h2>"));
    assert!(s3.contains("<h3 class=\"chapter-title depth-2\">旧伤来历</h3>"));

    let docx = dr_export::render(&manuscript, dr_export::Format::Docx).unwrap();
    let mut docx_zip = zip::ZipArchive::new(std::io::Cursor::new(&docx)).unwrap();
    let mut doc_xml = String::new();
    docx_zip
        .by_name("word/document.xml")
        .unwrap()
        .read_to_string(&mut doc_xml)
        .unwrap();
    assert!(doc_xml.contains("Heading1"));
    assert!(doc_xml.contains("Heading2"));
    assert!(doc_xml.contains("Heading3"));

    let pdf = dr_export::render(&manuscript, dr_export::Format::Pdf).unwrap();
    assert!(pdf.starts_with(b"%PDF-"));

    // Turning off `chapter_titles` (`条目标题`) suppresses titles in the body while keeping sections.
    let untitled_body = v3::read_manuscript(
        &ws,
        &book,
        &Options {
            chapters: Some(vec![card]),
            chapter_titles: false,
            ..Options::default()
        },
        &Labels {
            untitled_chapter: "Untitled".into(),
            untitled_act: "Unused".into(),
            options: Default::default(),
        },
        "zh-CN",
        None,
        UNIX_EPOCH,
    )
    .unwrap();
    assert!(matches!(
        &untitled_body.sections[0],
        Section::Chapter {
            show_title: false,
            depth: Some(1),
            ..
        }
    ));

    ws.close();
}

/// T3b: a choice prints as the field shows it (built-in options in the
/// interface language, an author's own as they are), several values are
/// joined as a review card quotes them (「、」), a value kept from an older
/// field definition does not print, and a ticked row of an entry hung on
/// another prints that entry once more there, after what lives under the
/// host (作者 2026-11-16 十乙).
#[test]
fn choices_read_as_shown_only_defined_fields_print_and_hung_rows_print_again() {
    let dir = tempfile::tempdir().unwrap();
    let lib = dr_store::Library::open(dir.path(), dr_workspace::library_options("test")).unwrap();
    let ws = Workspace::open(lib, dr_workspace::WorkspaceOptions::default()).unwrap();
    let book = call(&ws, "project.create", json!({"name": "挂着的也印"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let template = json!({
        "id": "tpl-choice-card",
        "name": "选项卡",
        "modules": [{
            "id": "mod-fields",
            "kind": "fields",
            "name": "属性",
            "config": {"defs": [
                {"id": "state", "name": "状态", "field_type": "select", "options": ["finished", "自己的选项"]},
                {"id": "tags", "name": "标签", "field_type": "multi_select", "options": ["drifting", "自定"]},
                {"id": "old", "name": "旧栏", "field_type": "text"}
            ]}
        }]
    });
    call(
        &ws,
        "entry_template.put",
        json!({"book": book, "template": template}),
    );
    let manuscript_root = dr_testkit::seed::acceptance::novel_root(&ws, &book, "tpl-manuscript");
    let card = call(
        &ws,
        "entry.create",
        json!({"book": book, "parent": manuscript_root, "template": "tpl-choice-card", "title": "卡片"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    for (field, value) in [
        ("state", json!("finished")),
        ("tags", json!(["drifting", "自定"])),
        ("old", json!("旧值不印")),
    ] {
        call(
            &ws,
            "module.set_field",
            json!({"book": book, "entry": card, "module": "mod-fields", "field": field, "value": value}),
        );
    }
    // The 「旧栏」 field leaves the template; its value stays in the entry.
    let mut narrower = template.clone();
    narrower["modules"][0]["config"]["defs"]
        .as_array_mut()
        .unwrap()
        .pop();
    call(
        &ws,
        "entry_template.put",
        json!({"book": book, "template": narrower}),
    );
    // A chapter hung on a storyline.
    let chapter = call(
        &ws,
        "entry.create",
        json!({"book": book, "parent": manuscript_root, "template": "tpl-chapter", "title": "第一章", "bodies": {"mod-prose": "雾三天没散。"}}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let storylines = dr_testkit::seed::acceptance::novel_root(&ws, &book, "tpl-storylines");
    let line = call(
        &ws,
        "entry.create",
        json!({"book": book, "parent": storylines, "template": "tpl-storyline", "title": "主线"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    call(
        &ws,
        "membership.add",
        json!({"book": book, "host": line, "member": chapter}),
    );

    let outline = v3::outline(&ws, &book).unwrap();
    assert_eq!(outline.hung_rows(), vec![(line.clone(), chapter.clone())]);
    let labels = Labels {
        untitled_chapter: "Untitled".into(),
        untitled_act: "Unused".into(),
        options: [
            ("finished".to_owned(), "完成".to_owned()),
            ("drifting".to_owned(), "漂流".to_owned()),
        ]
        .into_iter()
        .collect(),
    };
    let export = |chapters: Vec<String>, hung: Vec<(String, String)>| {
        v3::read_manuscript(
            &ws,
            &book,
            &Options {
                chapters: Some(chapters),
                hung,
                chapter_titles: true,
                ..Options::default()
            },
            &labels,
            "zh-CN",
            None,
            UNIX_EPOCH,
        )
        .unwrap()
    };
    let titled = |m: &dr_export::Manuscript| -> Vec<(String, Option<u8>)> {
        m.sections
            .iter()
            .filter_map(|s| match s {
                Section::Chapter { title, depth, .. } => Some((title.clone(), *depth)),
                _ => None,
            })
            .collect()
    };

    let fields = export(vec![card.clone()], Vec::new());
    let text = serde_json::to_string(&fields.sections).unwrap();
    assert!(text.contains("完成"), "{text}");
    assert!(!text.contains("\"finished\""), "{text}");
    assert!(text.contains("漂流、自定"), "{text}");
    assert!(
        !text.contains("旧值不印") && !text.contains("旧栏"),
        "{text}"
    );

    // Ticked where it lives and where it hangs: printed twice, in tree order
    // (书稿 › 第一章, then 故事线 › 主线 › 第一章).
    let both = export(
        vec![chapter.clone(), line.clone()],
        vec![(line.clone(), chapter.clone())],
    );
    assert_eq!(
        titled(&both),
        vec![
            ("第一章".to_owned(), Some(1)),
            ("主线".to_owned(), Some(1)),
            ("第一章".to_owned(), Some(2)),
        ]
    );
    // Only the hung row: printed there alone.
    let hung_only = export(Vec::new(), vec![(line.clone(), chapter.clone())]);
    assert_eq!(titled(&hung_only), vec![("第一章".to_owned(), Some(2))]);
    ws.shutdown().unwrap();
}
