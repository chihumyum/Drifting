//! M41's back end on real libraries: a hand-built book through F3's
//! commands and the editor's transactions, and the `lite` seed.

use std::io::{Cursor, Read};
use std::time::{Duration, Instant, UNIX_EPOCH};

use dr_doc::prose::EmbedKind;
use dr_export::{
    Align, Block, Format, Labels, MarkdownTarget, Options, Run, Section, default_chapters,
    markdown, outline, read_manuscript, render,
};
use dr_model::id::{EmbedId, MaterialId};
use dr_model::kind::EntityKind;
use dr_model::pos::PosKey;
use dr_model::prose::{BlockAttrs, EntityLink, Heading, InlineStyle, LINE_BREAK};
use dr_store::Library;
use dr_testkit::seed::{self, Preset};
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use serde_json::{Value, json};

struct Env {
    _dir: tempfile::TempDir,
    ws: Workspace,
}

impl Drop for Env {
    fn drop(&mut self) {
        self.ws.close();
    }
}

fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(dir.path(), library_options("test")).unwrap();
    let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
    Env { _dir: dir, ws }
}

fn out(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input)
        .unwrap_or_else(|e| panic!("{name}: {e}"))["output"]
        .clone()
}

fn id(v: &Value) -> String {
    v["id"].as_str().unwrap().to_owned()
}

fn labels() -> Labels {
    Labels {
        untitled_chapter: "未命名章节".into(),
        untitled_act: "未命名幕".into(),
    }
}

fn now() -> std::time::SystemTime {
    UNIX_EPOCH + Duration::from_secs(1_793_434_150)
}

fn run(text: &str) -> Run {
    Run {
        text: text.into(),
        ..Run::default()
    }
}

fn para(text: &str) -> Block {
    Block::Paragraph {
        runs: vec![run(text)],
        align: Align::Justify,
        indent: 0,
    }
}

struct Book {
    id: String,
    prologue: String,
    letters: String,
    harbour: String,
    voyage: String,
    cut: String,
}

/// 《雾港来信》: a prologue, two acts, a styled chapter and a discarded one.
fn book(ws: &Workspace) -> Book {
    let b = id(&out(ws, "book.create", json!({"name": "雾港来信"})));
    let chapter = |title: &str, text: &str, summary: &str| {
        id(&out(
            ws,
            "chapter.create",
            json!({"book": b, "title": title, "text": text, "summary": summary}),
        ))
    };
    let prologue = chapter("序章　灯下", "\n雾港的灯塔在午夜亮起。\n\n", "灯塔亮了");
    let letters = chapter(
        "第一章\n来信",
        "一　雨夜\n信使抵达\n这里有加粗、链接、坏链接和安娜。\n引文第一段\n引文第二段\n\n——完——\n附：潮汐表见第三页。\n表格之后\n  ",
        "",
    );
    let harbour = chapter("第二章　旧港", "「雾散之前，不要出海。」", "");
    let voyage = chapter("第三章　返航", "船回来了。", "");
    let cut = chapter("删掉的一章", "不要了。", "");
    out(
        ws,
        "chapter.update",
        json!({"book": b, "id": cut, "status": "discarded"}),
    );
    out(
        ws,
        "act.create",
        json!({"book": b, "name": "第一卷　潮起", "start_chapter": letters}),
    );
    out(
        ws,
        "act.create",
        json!({"book": b, "name": "第二卷　雾散", "start_chapter": voyage}),
    );
    let anna = id(&out(
        ws,
        "element.create",
        json!({"book": b, "name": "安娜"}),
    ));
    // Styles, quotes, a rule, alignment, indent, a line break and embeds,
    // the way the editor writes them.
    let session = ws.prose_session(&format!("node:{letters}")).unwrap();
    session
        .edit(move |t| {
            let start = |t: &dr_doc::prose::ProseTxn<'_>, text: &str| {
                let v = t.view();
                v.paragraphs()
                    .find(|p| p.text().starts_with(text))
                    .unwrap_or_else(|| panic!("{text}"))
                    .range
                    .start
            };
            let find = |t: &dr_doc::prose::ProseTxn<'_>, needle: &str| {
                let v = t.view();
                let all = v.plain_text();
                let byte = all.find(needle).unwrap();
                let at = all[..byte].chars().count();
                at..at + needle.chars().count()
            };
            let p = start(t, "一　雨夜");
            t.set_heading(p, Some(Heading::H1))?;
            let p = start(t, "信使抵达");
            t.set_heading(p, Some(Heading::H2))?;
            let r = find(t, "加粗");
            t.set_style(r, &InlineStyle::Bold)?;
            let r = find(t, "坏链接");
            t.set_style(r, &InlineStyle::Link("javascript:alert(1)".into()))?;
            let r = find(t, "链接、");
            t.set_style(
                r.start..r.end - 1,
                &InlineStyle::Link("https://example.com/fog".into()),
            )?;
            let r = find(t, "安娜");
            t.link_entity(
                r,
                &EntityLink {
                    target: anna.clone(),
                    kind: EntityKind::Element,
                    block: None,
                    end_block: None,
                },
            )?;
            let quote = BlockAttrs {
                quote: true,
                ..BlockAttrs::default()
            };
            let p = start(t, "引文第一段");
            t.set_block_attrs(p, &quote)?;
            let p = start(t, "引文第二段");
            t.set_block_attrs(p, &quote)?;
            t.insert_text(p + 2, &LINE_BREAK.to_string())?;
            let v = t.view();
            let empty = v
                .paragraphs()
                .find(|p| p.is_empty() && !p.attrs.quote)
                .unwrap()
                .range
                .start;
            t.set_block_attrs(
                empty,
                &BlockAttrs {
                    rule: true,
                    ..BlockAttrs::default()
                },
            )?;
            let p = start(t, "——完——");
            t.set_block_attrs(
                p,
                &BlockAttrs {
                    align: dr_model::prose::Align::Center,
                    ..BlockAttrs::default()
                },
            )?;
            let p = start(t, "附：");
            t.set_block_attrs(
                p,
                &BlockAttrs {
                    indent: 1,
                    ..BlockAttrs::default()
                },
            )?;
            let p = start(t, "表格之后");
            let table = EmbedId::new_v7();
            let w = t.insert_embed(p, &table, &EmbedKind::Table)?;
            let (c1, c2) = (PosKey::first(), PosKey::first().after());
            w.add_col("c1", &c1)?;
            w.add_col("c2", &c2)?;
            w.add_row("r1", &c1)?;
            w.set_cell("r1", "c1", "潮高")?;
            w.set_cell("r1", "c2", &format!("三米{LINE_BREAK}四米"))?;
            let p = start(t, "表格之后");
            t.insert_embed(
                p,
                &EmbedId::new_v7(),
                &EmbedKind::Material(MaterialId::new_v7()),
            )?;
            Ok(())
        })
        .unwrap();
    Book {
        id: b,
        prologue,
        letters,
        harbour,
        voyage,
        cut,
    }
}

#[test]
fn the_outline_lists_chapters_in_book_order_under_their_acts() {
    let e = env();
    let b = book(&e.ws);
    let o = outline(&e.ws, &b.id).unwrap();
    assert_eq!(o.title, "雾港来信");
    assert_eq!(o.acts.len(), 2);
    let ids: Vec<&str> = o.chapters.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(
        ids,
        [&b.prologue, &b.letters, &b.harbour, &b.voyage, &b.cut].map(String::as_str)
    );
    assert_eq!(o.chapters[0].act, None);
    assert_eq!(o.chapters[1].act.as_deref(), Some(o.acts[0].id.as_str()));
    assert_eq!(o.chapters[3].act.as_deref(), Some(o.acts[1].id.as_str()));
    assert!(o.chapters[4].discarded());
    assert_eq!(
        default_chapters(&o),
        [&b.prologue, &b.letters, &b.harbour, &b.voyage].map(String::clone)
    );
}

#[test]
fn chapter_prose_becomes_manuscript_blocks() {
    let e = env();
    let b = book(&e.ws);
    let m = read_manuscript(
        &e.ws,
        &b.id,
        &Options {
            chapters: None,
            act_titles: true,
            chapter_titles: true,
            title: String::new(),
            author: " 合成作者 ".into(),
            cover: None,
        },
        &labels(),
        "zh-CN",
        None,
        now(),
    )
    .unwrap();
    assert_eq!(m.title, "雾港来信");
    assert_eq!(m.author, "合成作者");
    assert_eq!(m.identifier, b.id);
    assert_eq!(m.modified, "2026-10-31T08:09:10Z");
    let titles: Vec<String> = m
        .sections
        .iter()
        .map(|s| match s {
            Section::Act { title } => format!("act {title}"),
            Section::Chapter { title, .. } => title.clone(),
        })
        .collect();
    // The discarded chapter stays out; a title's line break is one space.
    assert_eq!(
        titles,
        [
            "序章　灯下",
            "act 第一卷　潮起",
            "第一章 来信",
            "第二章　旧港",
            "act 第二卷　雾散",
            "第三章　返航"
        ]
    );
    let Section::Chapter { blocks, .. } = &m.sections[0] else {
        panic!()
    };
    assert_eq!(
        blocks,
        &[para("雾港的灯塔在午夜亮起。")],
        "blank ends trimmed"
    );
    let Section::Chapter { blocks, .. } = &m.sections[2] else {
        panic!()
    };
    let bold = Run {
        bold: true,
        ..run("加粗")
    };
    let link = Run {
        href: Some("https://example.com/fog".into()),
        ..run("链接")
    };
    let expected = vec![
        Block::Heading {
            level: 1,
            runs: vec![run("一　雨夜")],
            align: Align::Justify,
        },
        Block::Heading {
            level: 2,
            runs: vec![run("信使抵达")],
            align: Align::Justify,
        },
        Block::Paragraph {
            runs: vec![
                run("这里有"),
                bold,
                run("、"),
                link,
                // An unsafe link and an entity link keep their words only.
                run("、坏链接和安娜。"),
            ],
            align: Align::Justify,
            indent: 0,
        },
        Block::Quote {
            blocks: vec![para("引文第一段"), para("引文\n第二段")],
        },
        Block::Break,
        Block::Paragraph {
            runs: vec![run("——完——")],
            align: Align::Center,
            indent: 0,
        },
        Block::Paragraph {
            runs: vec![run("附：潮汐表见第三页。")],
            align: Align::Justify,
            indent: 1,
        },
        // The table's words, cell line by cell line; the material is gone.
        para("潮高"),
        para("三米"),
        para("四米"),
        para("表格之后"),
    ];
    assert_eq!(blocks, &expected);

    // Every format takes it.
    for format in [Format::Epub, Format::Docx] {
        let bytes = render(&m, format).unwrap();
        assert!(bytes.starts_with(b"PK"), "{format:?}");
    }
    let epub = render(&m, Format::Epub).unwrap();
    let all = unzip_text(&epub);
    assert!(all.contains("<a href=\"https://example.com/fog\">链接</a>"));
    assert!(all.contains("引文<br/>第二段"));
    assert!(!all.contains("javascript:"));
    assert!(!all.contains("删掉的一章"));
}

#[test]
fn a_chosen_set_keeps_book_order_and_the_title_switches() {
    let e = env();
    let b = book(&e.ws);
    let m = read_manuscript(
        &e.ws,
        &b.id,
        &Options {
            chapters: Some(vec![b.voyage.clone(), b.cut.clone(), b.prologue.clone()]),
            act_titles: false,
            chapter_titles: false,
            title: " 选章 ".into(),
            author: String::new(),
            cover: None,
        },
        &labels(),
        "en",
        Some("Songti SC".into()),
        now(),
    )
    .unwrap();
    assert_eq!(m.title, "选章");
    assert_eq!(m.preferred_font.as_deref(), Some("Songti SC"));
    let shown: Vec<(&str, bool)> = m
        .sections
        .iter()
        .map(|s| match s {
            Section::Chapter {
                title, show_title, ..
            } => (title.as_str(), *show_title),
            Section::Act { .. } => panic!("act titles are off"),
        })
        .collect();
    // A discarded chapter goes in when it is chosen.
    assert_eq!(
        shown,
        [
            ("序章　灯下", false),
            ("第三章　返航", false),
            ("删掉的一章", false)
        ]
    );
    let none = read_manuscript(
        &e.ws,
        &b.id,
        &Options {
            chapters: Some(vec![]),
            ..Options::default()
        },
        &labels(),
        "en",
        None,
        now(),
    );
    assert!(matches!(none, Err(dr_export::ExportError::NoChapters)));
}

#[test]
fn markdown_shares_the_book_and_one_document() {
    let e = env();
    let b = book(&e.ws);
    let doc = markdown(&e.ws, &b.id, &MarkdownTarget::Book).unwrap();
    assert_eq!(doc.title, "雾港来信");
    assert_eq!(doc.filename, "雾港来信.md");
    assert_eq!(
        doc.documents, 5,
        "every live chapter, the discarded one too"
    );
    let md = &doc.markdown;
    assert!(
        md.starts_with("# 雾港来信\n\n### 序章　灯下\n\n> 灯塔亮了\n\n"),
        "{md}"
    );
    assert!(
        md.contains(
            "\n\n## 第一卷　潮起\n\n### 第一章 来信\n\n#### 一　雨夜\n\n##### 信使抵达\n\n"
        )
    );
    assert!(md.contains(
        "这里有**加粗**、[链接](https://example.com/fog)、坏链接和安娜。\n\n> 引文第一段<br><br>引文<br>第二段\n\n---\n\n——完——"
    ));
    assert!(md.contains("\n\n## 第二卷　雾散\n\n### 第三章　返航\n\n船回来了。\n\n### 删掉的一章"));
    assert!(md.ends_with("不要了。\n"));

    let one = markdown(
        &e.ws,
        &b.id,
        &MarkdownTarget::Doc(format!("node:{}", b.prologue)),
    )
    .unwrap();
    assert_eq!(one.documents, 1);
    // Empty paragraphs stay empty blocks, as in 0.1 (Markdown collapses
    // the blank lines).
    assert_eq!(
        one.markdown,
        "# 序章　灯下\n\n> 灯塔亮了\n\n\n\n雾港的灯塔在午夜亮起。\n\n\n\n\n"
    );
    let gone = markdown(&e.ws, &b.id, &MarkdownTarget::Doc("element:nope".into()));
    assert!(gone.is_err());
    let material = markdown(&e.ws, &b.id, &MarkdownTarget::Doc("material:x".into()));
    assert!(matches!(material, Err(dr_export::ExportError::Invalid(_))));
}

#[test]
fn a_chapter_never_written_exports_empty() {
    let e = env();
    let b = id(&out(&e.ws, "book.create", json!({"name": "空书"})));
    let c = id(&out(
        &e.ws,
        "chapter.create",
        json!({"book": b, "title": ""}),
    ));
    let m = read_manuscript(
        &e.ws,
        &b,
        &Options {
            chapter_titles: true,
            ..Options::default()
        },
        &labels(),
        "zh-CN",
        None,
        now(),
    )
    .unwrap();
    assert_eq!(m.title, "空书");
    let [Section::Chapter { title, blocks, .. }] = m.sections.as_slice() else {
        panic!("{:?}", m.sections)
    };
    assert!(!title.is_empty());
    assert!(blocks.is_empty());
    for format in [Format::Epub, Format::Docx] {
        render(&m, format).unwrap();
    }
    let md = markdown(&e.ws, &b, &MarkdownTarget::Doc(format!("node:{c}"))).unwrap();
    assert!(md.markdown.starts_with("# "));
}

fn unzip_text(bytes: &[u8]) -> String {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut all = String::new();
    for i in 0..archive.len() {
        let mut f = archive.by_index(i).unwrap();
        let mut s = String::new();
        if f.read_to_string(&mut s).is_ok() {
            all.push_str(&s);
        }
    }
    all
}

/// The `lite` seed (20 chapters, 150 000 words) read and laid out in every
/// format. Timings are printed for reference (`--nocapture`).
#[test]
fn the_lite_seed_exports_in_every_format() {
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(dir.path(), library_options("test")).unwrap();
    let seeded = seed::generate(Preset::Lite, seed::DEFAULT_SEED).unwrap();
    seeded.write_to(&lib).unwrap();
    let book = seeded.books[0].book_id().to_string();
    let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
    let started = Instant::now();
    let o = outline(&ws, &book).unwrap();
    let m = read_manuscript(
        &ws,
        &book,
        &Options {
            chapters: None,
            act_titles: true,
            chapter_titles: true,
            title: String::new(),
            author: "合成作者".into(),
            cover: None,
        },
        &labels(),
        "zh-CN",
        None,
        now(),
    )
    .unwrap();
    let read = started.elapsed();
    let chapters = m
        .sections
        .iter()
        .filter(|s| matches!(s, Section::Chapter { .. }))
        .count();
    assert_eq!(chapters, default_chapters(&o).len());
    assert!(chapters > 0);
    fn chars(blocks: &[Block]) -> usize {
        blocks
            .iter()
            .map(|b| match b {
                Block::Heading { runs, .. } | Block::Paragraph { runs, .. } => {
                    runs.iter().map(|r| r.text.chars().count()).sum()
                }
                Block::Quote { blocks } => chars(blocks),
                Block::Break => 0,
            })
            .sum()
    }
    let total: usize = m
        .sections
        .iter()
        .map(|s| match s {
            Section::Chapter { blocks, .. } => chars(blocks),
            Section::Act { .. } => 0,
        })
        .sum();
    assert!(
        total > 100_000,
        "the prose came through: {total} characters"
    );
    let mut times = vec![format!("read {read:?}")];
    for format in Format::ALL {
        if format == Format::Pdf && dr_export::pdf_fonts(&m).is_err() && !cfg!(target_os = "macos")
        {
            eprintln!("skipping the PDF without CJK fonts");
            continue;
        }
        let t = Instant::now();
        let bytes = render(&m, format).unwrap();
        times.push(format!(
            "{} {:?} {} KiB",
            format.label(),
            t.elapsed(),
            bytes.len() / 1024
        ));
        assert!(!bytes.is_empty());
    }
    let t = Instant::now();
    let md = markdown(&ws, &book, &MarkdownTarget::Book).unwrap();
    times.push(format!(
        "Markdown {:?} {} KiB",
        t.elapsed(),
        md.markdown.len() / 1024
    ));
    eprintln!("lite export: {}", times.join(", "));
    ws.close();
}
