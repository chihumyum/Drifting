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
fn manuscript_excludes_nonresident_and_trashed_content_and_preserves_v22() {
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
    let old = call(
        &ws,
        "book.create",
        json!({"name":"Synthetic compatibility"}),
    );
    let old_id = old["id"].as_str().unwrap();
    assert!(!v3::is_book(&ws, old_id).unwrap());
    assert!(v3::outline(&ws, old_id).is_err());
    assert!(dr_export::outline(&ws, old_id).unwrap().chapters.is_empty());
    ws.shutdown().unwrap();
}
