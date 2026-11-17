use dr_mirror::body::{BodyIssue, FileLinks, Kind, parse_with, render_with};
use dr_mirror::layout::AssetFile;
use dr_model::id::AssetId;
use dr_model::kind::{AssetKind, ListKind};

#[test]
fn list_depth_checkmarks_code_languages_and_callouts_survive() {
    let body = "- 一\n  1. 二\n    - [x] 三\n\n```rust\n    一\n\n  二\n```\n\n> [!note]\n> 段落\n> ==高亮== `行内`\n";
    let links = FileLinks::default();
    let read = parse_with(body, &links);
    let paras: Vec<_> = read.paragraphs.into_iter().map(|p| p.para).collect();
    assert_eq!(paras.len(), 8);
    assert_eq!(
        paras[0].kind,
        Kind::List {
            kind: ListKind::Bullet,
            level: 0,
            checked: false
        }
    );
    assert_eq!(
        paras[1].kind,
        Kind::List {
            kind: ListKind::Ordered,
            level: 1,
            checked: false
        }
    );
    assert_eq!(
        paras[2].kind,
        Kind::List {
            kind: ListKind::Task,
            level: 2,
            checked: true
        }
    );
    assert_eq!(paras[3].kind, Kind::Code("rust".into()));
    assert_eq!(paras[3].text(), "    一");
    assert_eq!(paras[4].text(), "");
    assert_eq!(paras[5].text(), "  二");
    assert_eq!(paras[6].kind, Kind::Callout("note".into()));
    assert!(paras[7].marks[0].highlight);
    assert!(paras[7].marks[3].code);
    assert_eq!(render_with(&paras, &links), body);
}

fn file(id: &str, path: &str, name: &str, kind: AssetKind) -> AssetFile {
    AssetFile {
        id: AssetId::parse(id).unwrap(),
        path: path.into(),
        name: name.into(),
        kind,
        present: true,
    }
}

#[test]
fn file_links_caption_embeds_and_pdf_are_resolved_only_in_the_project() {
    let files = [
        file(
            "picture",
            "素材库/参考图/钟楼 (夜).png",
            "钟楼 (夜).png",
            AssetKind::Image,
        ),
        file("pdf", "素材库/地图.pdf", "地图.pdf", AssetKind::Pdf),
    ];
    let links = FileLinks::new("书稿/第一卷/雨夜.md", &files);
    let body = "![图注](../../素材库/参考图/钟楼%20%28夜%29.png)\n\n![[地图.pdf]]\n\n[去看图](../../素材库/参考图/钟楼%20%28夜%29.png)\n";
    let read = parse_with(body, &links);
    assert!(read.issues.is_empty());
    let paras: Vec<_> = read.paragraphs.into_iter().map(|f| f.para).collect();
    assert_eq!(
        paras[0].kind,
        Kind::Asset {
            asset: files[0].id.clone(),
            caption: "图注".into()
        }
    );
    assert_eq!(
        paras[1].kind,
        Kind::Asset {
            asset: files[1].id.clone(),
            caption: String::new()
        }
    );
    assert_eq!(paras[2].marks[0].file.as_ref(), Some(&files[0].id));
    let written = render_with(&paras, &links);
    assert_eq!(
        written,
        body.replace("![[地图.pdf]]", "![地图.pdf](../../素材库/地图.pdf)")
    );
    let foreign = parse_with("![别处](../../../素材库/外部.png)\n", &links);
    assert!(foreign.issues.contains(&BodyIssue::UnknownImage));
    assert_eq!(
        foreign.paragraphs[0].para.text(),
        "![别处](../../../素材库/外部.png)"
    );
}

#[test]
fn tables_keep_cells_and_bad_tables_do_not_consume_other_paragraphs() {
    let links = FileLinks::default();
    let body = "| **名** | 值 |\n| --- | --- |\n| 左\\|右 | ==四==<br>两行 |\n\n她站在门口。\n";
    let read = parse_with(body, &links);
    assert!(read.issues.is_empty());
    let Kind::Table(rows) = &read.paragraphs[0].para.kind else {
        panic!("expected a table")
    };
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[1][0].text(), "左|右");
    assert_eq!(rows[1][1].text(), "四\u{2028}两行");
    assert!(rows[0][0].marks[0].bold);
    assert!(rows[1][1].marks[0].highlight);
    let edited = body.replace("| --- | --- |", "| --- |");
    let bad = parse_with(&edited, &links);
    assert!(bad.issues.contains(&BodyIssue::MalformedTable));
    assert!(matches!(bad.paragraphs[0].para.kind, Kind::BrokenTable(_)));
    assert_eq!(bad.paragraphs[1].para.text(), "她站在门口。");
}

#[test]
fn the_import_keeps_its_existing_plain_interpretation() {
    use dr_export::{Block, import::markdown_blocks, parse_bytes};
    let text = "> [!note]\n> ==亮== `码`";
    let blocks = markdown_blocks(text);
    let [Block::Callout { kind, blocks }] = blocks.as_slice() else {
        panic!("{blocks:?}")
    };
    assert_eq!(kind, "note");
    let [Block::Paragraph { runs, .. }] = blocks.as_slice() else {
        panic!("{blocks:?}")
    };
    assert!(runs[0].highlight);
    assert!(runs[2].code);
    let imported = parse_bytes("test.md", text.as_bytes()).unwrap();
    let [Block::Quote { blocks }] = imported.blocks.as_slice() else {
        panic!("{:?}", imported.blocks)
    };
    let [Block::Paragraph { runs, .. }] = blocks.as_slice() else {
        panic!("{blocks:?}")
    };
    assert!(runs.iter().all(|r| !r.highlight && !r.code));
    assert!(runs.iter().any(|r| r.text.contains("==亮==")));
}

#[test]
fn ideographic_spaces_do_not_turn_words_into_markdown_blocks() {
    use dr_mirror::body::Para;
    let links = FileLinks::default();
    for marker in [
        "---", "***", "___", "===", "~~~", "```", "> 话", "# 标题", "| 甲 |", "[!note]",
    ] {
        let text = format!("　{marker}");
        for quote in [false, true] {
            let expected = Para {
                kind: Kind::Text {
                    heading: None,
                    quote,
                },
                ..Para::plain(&text)
            };
            let raw = if quote {
                format!("> {text}\n")
            } else {
                format!("{text}\n")
            };
            let read = parse_with(&raw, &links);
            assert!(read.issues.is_empty(), "{raw:?}: {:?}", read.issues);
            assert_eq!(read.paragraphs.len(), 1, "{raw:?}");
            assert_eq!(read.paragraphs[0].para, expected, "raw {raw:?}");

            let written = render_with(std::slice::from_ref(&expected), &links);
            let again = parse_with(&written, &links);
            assert!(again.issues.is_empty(), "{written:?}: {:?}", again.issues);
            let got: Vec<_> = again.paragraphs.into_iter().map(|row| row.para).collect();
            assert_eq!(got, [expected], "rendered {written:?}");
        }
    }
}

#[test]
fn ideographic_spaces_are_not_setext_or_table_delimiters() {
    use dr_export::{Block, import::markdown_blocks};
    for underline in ["　---", "　===", "---　", "===　"] {
        let source = format!("正文\n{underline}");
        let read = markdown_blocks(&source);
        let [Block::Paragraph { runs, .. }] = read.as_slice() else {
            panic!("not a heading: {source:?}: {read:?}");
        };
        let text: String = runs.iter().map(|r| r.text.as_str()).collect();
        assert!(text.contains(underline), "{text:?}");
    }
    let links = FileLinks::default();
    let table = parse_with("| 表头 |\n| 　--- |\n| 内容 |\n", &links);
    assert!(table.issues.contains(&BodyIssue::MalformedTable));
    let Kind::BrokenTable(original) = &table.paragraphs[0].para.kind else {
        panic!(
            "the invalid delimiter is held, not consumed: {:?}",
            table.paragraphs
        );
    };
    assert!(original.contains("　---"));
}

use proptest::prelude::*;

proptest! {
    #![proptest_config({
        let mut config = ProptestConfig::default();
        config.cases = config.cases.max(512);
        config
    })]
    #[test]
    fn ideographic_spaces_stay_literal_and_round_trip(
        leading in 1..6_usize,
        middle in 1..6_usize,
        trailing in 1..6_usize,
        words in any::<bool>(),
    ) {
        use dr_mirror::body::Para;
        let sample = if words {
            format!("{}安娜{}钟楼{}", "　".repeat(leading), "　".repeat(middle), "　".repeat(trailing))
        } else {
            "　".repeat(leading + middle + trailing)
        };
        let links = FileLinks::default();
        let original = vec![Para::plain(&sample)];
        let written = render_with(&original, &links);
        prop_assert_eq!(written.as_str(), format!("{sample}\n"));
        let read = parse_with(&written, &links);
        let got: Vec<_> = read.paragraphs.into_iter().map(|row| row.para).collect();
        prop_assert_eq!(got, original);
        prop_assert!(read.issues.is_empty());
    }

    #[test]
    fn structured_body_round_trips(
        sample in prop::collection::vec(prop::sample::select(vec!['a', '钟', '。', ' ', '\u{3000}', '|', '\\', '`', '(', ')', '*', '=', '!', ']', '[', '#']), 1..16),
        level in 0..=8_u32,
        checked in any::<bool>(),
        code in any::<bool>(),
        highlight in any::<bool>(),
    ) {
        use dr_mirror::body::{Marks, Para};
        let sample: String = sample.into_iter().collect();
        let mut content = Para::plain(&sample);
        content.marks.fill(Marks { code, highlight, ..Marks::default() });
        let asset = file("picture", "素材库/钟楼.png", "钟楼.png", AssetKind::Image);
        let links = FileLinks::new("书稿/雨夜.md", std::slice::from_ref(&asset));
        let mut linked = Para::plain("参考图");
        linked.marks.fill(Marks { file: Some(asset.id.clone()), ..Marks::default() });
        let shaped = vec![
            Para { kind: Kind::List { kind: ListKind::Task, level, checked }, ..content.clone() },
            Para { kind: Kind::Code("rust".into()), ..Para::plain(&sample) },
            Para { kind: Kind::Code("rust".into()), ..Para::empty() },
            Para { kind: Kind::Callout("note".into()), ..content.clone() },
            Para { kind: Kind::Table(vec![vec![content.clone(), linked.clone()], vec![content, Para::empty()]]), ..Para::empty() },
            Para { kind: Kind::Asset { asset: asset.id.clone(), caption: "图注".into() }, ..Para::empty() },
            linked,
        ];
        let written = render_with(&shaped, &links);
        let parsed = parse_with(&written, &links);
        let got: Vec<_> = parsed.paragraphs.into_iter().map(|row| row.para).collect();
        prop_assert_eq!(got, shaped, "{:?}", written);
        prop_assert!(parsed.issues.is_empty());
    }
}
