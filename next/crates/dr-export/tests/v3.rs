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
fn manuscript_excludes_nonresident_and_trashed_content_and_refuses_old_books() {
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
    call(&ws, "entry.restore", json!({"book":book,"id":root}));
    assert_eq!(v3::outline(&ws, &book).unwrap(), before);
    let all = call(&ws, "entry.list", json!({"book":book,"all":true}));
    let nonresident: Vec<_> = all
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|e| e["id"].as_str())
        .filter(|id| !before.entries.iter().any(|e| e.id == *id))
        .map(str::to_owned)
        .collect();
    let labels = Labels {
        untitled_chapter: "Untitled".into(),
        untitled_act: "Unused".into(),
    };
    assert!(matches!(
        v3::read_manuscript(
            &ws,
            &book,
            &Options {
                chapters: Some(nonresident),
                ..Options::default()
            },
            &labels,
            "en",
            None,
            UNIX_EPOCH
        ),
        Err(dr_export::ExportError::NoChapters)
    ));
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
    assert_eq!(outline.parts.len(), 1);
    assert_eq!(outline.parts[0].id, manuscript_root);
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
fn multiple_manuscript_parts_export_together_or_individually() {
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

    // A non-manuscript container holding a second manuscript part (`外篇 / 番外稿`).
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

    let outline = v3::outline(&ws, &book).unwrap();
    assert_eq!(outline.parts.len(), 2);
    assert_eq!(outline.parts[0].id, main_part);
    assert_eq!(outline.parts[0].path, vec!["书稿"]);
    assert_eq!(outline.parts[0].entries.len(), 1);
    assert_eq!(outline.parts[0].entries[0].id, ch_main);
    assert_eq!(outline.parts[1].id, side_part);
    assert_eq!(outline.parts[1].path, vec!["外篇", "番外稿"]);
    assert_eq!(outline.parts[1].entries.len(), 1);
    assert_eq!(outline.parts[1].entries[0].id, ch_side);

    let labels = Labels {
        untitled_chapter: "Untitled".into(),
        untitled_act: "Unused".into(),
    };
    let only_side = v3::read_manuscript(
        &ws,
        &book,
        &Options {
            manuscript: Some(side_part),
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

    let missing = v3::read_manuscript(
        &ws,
        &book,
        &Options {
            manuscript: Some("missing-part".into()),
            ..Options::default()
        },
        &labels,
        "zh-CN",
        None,
        UNIX_EPOCH,
    );
    assert!(matches!(missing, Err(dr_export::ExportError::NotFound(_))));
    ws.close();
}
