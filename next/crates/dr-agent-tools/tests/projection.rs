use dr_agent_tools::prose::{CommentAnchor, Projection, comment_anchors, plan, project};
use dr_testkit::seed::{self, Preset};
use dr_workspace::{Actor, Workspace};
use serde_json::{Value, json};

fn seed_text() -> String {
    let seeded = seed::generate(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
    seeded.books[0]
        .prose
        .iter()
        .flat_map(|doc| doc.view().paragraphs())
        .find(|paragraph| paragraph.text().chars().count() > 12)
        .unwrap()
        .text()
}

fn read(text: &str, heading: u8) -> Value {
    json!({"version":"00","total":1,"paragraphs":[{
        "index":0,"block_id":"block-1","heading":heading,"text":text
    }]})
}

fn replace_content_line(projection: &Projection, block: usize, content: &str) -> String {
    let mut lines: Vec<_> = projection.text.split('\n').map(str::to_owned).collect();
    lines[projection.blocks[block].line - 1] = content.to_owned();
    lines.join("\n")
}

fn text_edit(projection: &Projection, block: usize, text: &str) -> String {
    let replacement = project(
        "node:fixture",
        &read(text, projection.blocks[block].heading),
        &[],
    )
    .unwrap();
    let line = replacement.text.split('\n').nth(1).unwrap();
    replace_content_line(projection, block, line)
}

#[test]
fn tiny_and_lite_round_trips_keep_every_loro_snapshot_byte() {
    for preset in [Preset::Tiny, Preset::Lite] {
        let dir = tempfile::tempdir().unwrap();
        let workspace = Workspace::open_dir(dir.path(), "projection-test").unwrap();
        let seeded = seed::generate(preset, seed::DEFAULT_SEED).unwrap();
        seeded.write_to(workspace.library()).unwrap();
        let mut documents = 0;
        for book in &seeded.books {
            for prose in &book.prose {
                let doc = prose.doc_id().to_string();
                let read = workspace
                    .call(
                        &Actor::User,
                        "prose.read",
                        json!({"doc":doc,"limit":usize::MAX}),
                    )
                    .unwrap();
                let before = workspace
                    .library()
                    .load_copy(&doc)
                    .unwrap()
                    .export(loro::ExportMode::Snapshot)
                    .unwrap();
                let projection = project(&doc, &read["output"], &[]).unwrap();
                assert!(plan(&projection, &projection.text).unwrap().is_none());
                let after = workspace
                    .library()
                    .load_copy(&doc)
                    .unwrap()
                    .export(loro::ExportMode::Snapshot)
                    .unwrap();
                assert_eq!(before, after, "{preset:?}: {doc}");
                documents += 1;
            }
        }
        assert!(documents > 0);
    }
}

#[test]
fn one_paragraph_edit_runs_through_existing_f3_and_keeps_block_ids() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open_dir(dir.path(), "projection-test").unwrap();
    let seeded = seed::generate(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
    seeded.write_to(workspace.library()).unwrap();
    let prose = &seeded.books[0].prose[0];
    let doc = prose.doc_id().to_string();
    let read = workspace
        .call(
            &Actor::User,
            "prose.read",
            json!({"doc":doc,"limit":usize::MAX}),
        )
        .unwrap();
    let projection = project(&doc, &read["output"], &[]).unwrap();
    let (index, paragraph) = read["output"]["paragraphs"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .find(|(_, paragraph)| paragraph["text"].as_str().unwrap().chars().count() > 2)
        .unwrap();
    let before = paragraph["text"].as_str().unwrap();
    let mut desired = before.to_owned();
    desired.push(before.chars().next().unwrap());
    let edited = text_edit(&projection, index, &desired);
    let replacement = plan(&projection, &edited).unwrap().unwrap();
    let guarded_read = workspace
        .call(
            &Actor::User,
            "prose.read",
            json!({"doc":doc,"limit":usize::MAX}),
        )
        .unwrap();
    assert_eq!(guarded_read["output"]["version"], projection.version);
    workspace
        .call(&Actor::User, "prose.replace", replacement.input())
        .unwrap();
    let after = workspace
        .call(
            &Actor::User,
            "prose.read",
            json!({"doc":doc,"limit":usize::MAX}),
        )
        .unwrap();
    assert_eq!(read["output"]["total"], after["output"]["total"]);
    for (at, (old, new)) in read["output"]["paragraphs"]
        .as_array()
        .unwrap()
        .iter()
        .zip(after["output"]["paragraphs"].as_array().unwrap())
        .enumerate()
    {
        assert_eq!(old["block_id"], new["block_id"]);
        assert_eq!(old["heading"], new["heading"]);
        if at == index {
            assert_eq!(new["text"], desired);
        } else {
            assert_eq!(old, new);
        }
    }
}

#[test]
fn unicode_replacements_are_minimal_unique_and_anchor_insertions() {
    let source = seed_text();
    let mut symbols = Vec::new();
    for c in source.chars().filter(|c| !c.is_ascii()) {
        if !symbols.contains(&c) {
            symbols.push(c);
        }
        if symbols.len() == 3 {
            break;
        }
    }
    let [a, b, c] = symbols.as_slice() else {
        panic!("seed has diverse Unicode")
    };
    let original = format!("{a}{b}{a}{b}{c}");
    let projection = project("node:fixture", &read(&original, 0), &[]).unwrap();
    for desired in [
        format!("{a}{b}{a}{c}{c}"),
        format!("{c}{a}{b}{a}{b}{c}"),
        format!("{a}{b}{a}{b}{c}{a}"),
        format!("{a}{b}{a}{b}"),
        String::new(),
    ] {
        let replacement = plan(&projection, &text_edit(&projection, 0, &desired))
            .unwrap()
            .unwrap();
        assert!(!replacement.find.is_empty());
        assert_eq!(original.match_indices(&replacement.find).count(), 1);
        assert_eq!(
            original.replacen(&replacement.find, &replacement.replace, 1),
            desired
        );
    }
    let unique = project("node:fixture", &read(&format!("{a}{b}{c}"), 0), &[]).unwrap();
    let replacement = plan(&unique, &text_edit(&unique, 0, &format!("{a}{c}{c}")))
        .unwrap()
        .unwrap();
    assert_eq!(replacement.find, b.to_string());
    assert_eq!(replacement.replace, c.to_string());
}

#[test]
fn h1_h2_h3_text_edits_keep_heading_and_comment_anchors() {
    let text = seed_text();
    let comments = [
        CommentAnchor {
            id: "comment-block".into(),
            block_id: Some("block-1".into()),
        },
        CommentAnchor {
            id: "comment-cursor".into(),
            block_id: None,
        },
    ];
    for heading in 1..=3 {
        let projection = project("node:fixture", &read(&text, heading), &comments).unwrap();
        assert_eq!(projection.blocks[0].comments, ["comment-block"]);
        assert!(projection.text.contains("comment-cursor"));
        let desired = format!("{text}{text}");
        assert!(
            plan(&projection, &text_edit(&projection, 0, &desired))
                .unwrap()
                .is_some()
        );
        let heading_edit = replace_content_line(
            &projection,
            0,
            &format!("{} {text}", "#".repeat(heading as usize % 3 + 1)),
        );
        assert!(plan(&projection, &heading_edit).is_err());
        assert!(
            plan(
                &projection,
                &projection.text.replace("comment-block", "comment-other")
            )
            .is_err()
        );
        assert!(
            plan(
                &projection,
                &projection.text.replace("block-1", "block-other")
            )
            .is_err()
        );
    }
}

#[test]
fn escapes_preserve_literal_markdown_and_reject_formatting_requests() {
    let source = seed_text();
    for text in [
        format!("**{source}**"),
        format!("1. {source}"),
        format!("- {source}"),
        format!("#{source}\\{source}"),
        format!("<{source}> [_{source}_]"),
    ] {
        let projection = project("node:fixture", &read(&text, 0), &[]).unwrap();
        let desired = format!("{text}{source}");
        let replacement = plan(&projection, &text_edit(&projection, 0, &desired))
            .unwrap()
            .unwrap();
        assert_eq!(
            text.replacen(&replacement.find, &replacement.replace, 1),
            desired
        );
    }
    let projection = project("node:fixture", &read(&source, 0), &[]).unwrap();
    for content in [
        format!("**{source}**"),
        format!("# {source}"),
        format!("- {source}"),
        format!("[{source}](https://example.invalid)"),
    ] {
        assert!(plan(&projection, &replace_content_line(&projection, 0, &content)).is_err());
    }
}

#[test]
fn rejects_structural_embed_missing_identity_and_multi_paragraph_edits() {
    let text = seed_text();
    let mut input = read(&text, 0);
    input["total"] = 2.into();
    input["paragraphs"]
        .as_array_mut()
        .unwrap()
        .push(json!({"index":1,"block_id":"block-2","heading":0,"text":text}));
    let projection = project("node:fixture", &input, &[]).unwrap();
    assert!(plan(&projection, &format!("{}\n{text}", projection.text)).is_err());
    let edited = text_edit(&projection, 0, &format!("{text}{text}"));
    let mut lines: Vec<_> = edited.split('\n').map(str::to_owned).collect();
    lines[projection.blocks[1].line - 1].push_str(&text);
    assert!(plan(&projection, &lines.join("\n")).is_err());
    for original in [
        String::new(),
        "\u{FFFC}".to_owned(),
        format!("{text}\u{FFFC}"),
    ] {
        let projection = project("node:fixture", &read(&original, 0), &[]).unwrap();
        assert!(plan(&projection, &projection.text).unwrap().is_none());
        assert!(plan(&projection, &text_edit(&projection, 0, &text)).is_err());
    }
    let mut input = read(&text, 0);
    input["paragraphs"][0]["block_id"] = Value::Null;
    let projection = project("node:fixture", &input, &[]).unwrap();
    assert!(
        plan(
            &projection,
            &text_edit(&projection, 0, &format!("{text}{text}"))
        )
        .is_err()
    );
}

#[test]
fn malformed_read_metadata_fails_before_exposing_an_editable_projection() {
    let source = seed_text();
    for input in [
        read(&source, 4),
        json!({"version":"00","total":0,"paragraphs":[{"index":0,"block_id":"block-1","heading":0,"text":source}]}),
        json!({"version":"00","total":2,"paragraphs":[{"index":0,"block_id":"block-1","heading":0,"text":source},{"index":1,"block_id":"block-1","heading":0,"text":source}]}),
    ] {
        assert!(project("node:fixture", &input, &[]).is_err());
    }
}

#[test]
fn comment_list_uses_exact_targets_and_never_guesses_cursor_locations() {
    let comment = |id: &str, kind: &str, target: &str, block: Option<&str>| {
        json!({"id":id,"target":{"kind":kind,"id":target},"unlocated":false,
            "target_block":block,"anchored":true,"region":null})
    };
    let mut unlocated = comment("gone", "node", "target", Some("block-1"));
    unlocated["unlocated"] = true.into();
    let mut region = comment("region", "node", "target", None);
    region["region"] = json!({"page":1,"x":0,"y":0,"width":0.1,"height":0.1});
    let comments = json!([
        comment("block-comment", "node", "target", Some("block-1")),
        comment("cursor-comment", "node", "target", None),
        comment("other-kind", "element", "target", Some("block-1")),
        comment("other-id", "node", "other", Some("block-1")),
        unlocated,
        region,
        {"id":"floating","target":null,"unlocated":false,"target_block":null},
        {"id":"invalid","target":{"kind":"node","id":"target"},"target_block":"block-1"}
    ]);
    let anchors = comment_anchors("node:target", &comments);
    assert_eq!(
        anchors,
        [
            CommentAnchor {
                id: "block-comment".into(),
                block_id: Some("block-1".into())
            },
            CommentAnchor {
                id: "cursor-comment".into(),
                block_id: None
            }
        ]
    );
    let projection = project("node:target", &read(&seed_text(), 0), &anchors).unwrap();
    assert_eq!(projection.blocks[0].comments, ["block-comment"]);
    assert!(projection.text.contains("cursor-comment"));
    assert!(comment_anchors("conversation:target", &comments).is_empty());
    assert!(comment_anchors("node:target", &Value::Null).is_empty());
}
