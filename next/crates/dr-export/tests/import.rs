//! Importing Word, Markdown and text files into a real workspace: what each
//! file becomes, where it goes, and its prose read back.

use std::io::{Cursor, Write};
use std::sync::atomic::AtomicBool;

use dr_doc::prose::ProseView;
use dr_export::{
    Align, Block, ImportTarget, ImportWarning, ParsedDoc, Run, blocks, import_docs, parse_bytes,
};
use dr_store::Library;
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use serde_json::{Value, json};

struct Env {
    _dir: tempfile::TempDir,
    ws: Workspace,
    book: String,
}

impl Drop for Env {
    fn drop(&mut self) {
        self.ws.close();
    }
}

fn out(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input)
        .unwrap_or_else(|e| panic!("{name}: {e}"))["output"]
        .clone()
}

fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(dir.path(), library_options("test")).unwrap();
    let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
    let book = out(&ws, "book.create", json!({"name": "导入"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    Env {
        _dir: dir,
        ws,
        book,
    }
}

/// A document's prose as manuscript blocks.
fn prose(ws: &Workspace, doc: &str) -> Vec<Block> {
    let session = ws.prose_session(doc).unwrap();
    let reader = session.reader();
    let view: ProseView<'_> = reader.view();
    blocks(&view)
}

fn run(text: &str) -> Run {
    Run {
        text: text.into(),
        ..Run::default()
    }
}

fn para(runs: Vec<Run>) -> Block {
    Block::Paragraph {
        runs,
        align: Align::Justify,
        indent: 0,
    }
}

const W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

fn docx(body: &str) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default();
    zip.start_file("word/document.xml", opts).unwrap();
    write!(
        zip,
        r#"<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="{W}"><w:body>{body}</w:body></w:document>"#
    )
    .unwrap();
    zip.finish().unwrap().into_inner()
}

#[test]
fn files_become_chapters_after_the_last_one_with_their_formatting() {
    let e = env();
    let line = out(
        &e.ws,
        "storyline.create",
        json!({"book": e.book, "name": "主线"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let first = out(
        &e.ws,
        "chapter.create",
        json!({"book": e.book, "title": "原有"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let md = parse_bytes(
        "01 雨夜.md",
        "# 第一章 雨夜\n\n她**推开**门，*雨*还在下。见 [站点](https://example.com)。\n\n## 小节\n\n> 引文一\n>\n> 引文二\n\n---\n\n<center>不是对齐</center>\n第二行  \n第三行"
            .as_bytes(),
    )
    .unwrap();
    assert_eq!(md.title, "第一章 雨夜");
    let word = parse_bytes(
        "2 晨.docx",
        &docx(r#"<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>居中</w:t></w:r></w:p><w:p><w:r><w:rPr><w:strike/></w:rPr><w:t>删去</w:t></w:r></w:p>"#),
    )
    .unwrap();
    assert_eq!(word.title, "晨");
    let txt = parse_bytes("3 夜.txt", "一段\n同段\n\n二段".as_bytes()).unwrap();
    let docs = vec![
        (String::new(), md),
        ("自己的名字".to_owned(), word),
        (String::new(), txt),
    ];
    let items = import_docs(
        &e.ws,
        &Actor::User,
        &e.book,
        &ImportTarget::Chapter {
            storyline: Some(line.clone()),
        },
        &docs,
        None,
    )
    .unwrap();
    assert_eq!(items.len(), 3);
    let made: Vec<_> = items.iter().map(|i| i.result.clone().unwrap()).collect();
    assert_eq!(made[0].name, "第一章 雨夜");
    assert_eq!(made[1].name, "自己的名字");
    assert_eq!(made[2].name, "夜");

    // After the chapter that was there, in the order given, on the storyline.
    let chapters = out(&e.ws, "chapter.list", json!({"book": e.book}));
    let ids: Vec<&str> = chapters
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, [first.as_str(), &made[0].id, &made[1].id, &made[2].id]);
    for c in &chapters.as_array().unwrap()[1..] {
        assert_eq!(c["storylines"], json!([line]));
    }

    // The prose, read back as the manuscript export reads it.
    assert_eq!(
        prose(&e.ws, &made[0].doc),
        vec![
            para(vec![
                run("她"),
                Run {
                    bold: true,
                    ..run("推开")
                },
                run("门，"),
                Run {
                    italic: true,
                    ..run("雨")
                },
                run("还在下。见 "),
                Run {
                    href: Some("https://example.com".into()),
                    ..run("站点")
                },
                run("。"),
            ]),
            Block::Heading {
                level: 2,
                runs: vec![run("小节")],
                align: Align::Justify,
            },
            Block::Quote {
                blocks: vec![para(vec![run("引文一")]), para(vec![run("引文二")])]
            },
            Block::Break,
            // HTML the editor has no use for stays as text.
            para(vec![run("<center>不是对齐</center> 第二行\n第三行")]),
        ]
    );
    assert_eq!(
        prose(&e.ws, &made[1].doc),
        vec![
            Block::Paragraph {
                runs: vec![Run {
                    underline: true,
                    ..run("居中")
                }],
                align: Align::Center,
                indent: 0,
            },
            para(vec![Run {
                strike: true,
                ..run("删去")
            }]),
        ]
    );
    assert_eq!(
        prose(&e.ws, &made[2].doc),
        vec![para(vec![run("一段\n同段")]), para(vec![run("二段")])]
    );
    // Undo takes the last import back like any chapter the author made.
    assert!(e.ws.undo(&Actor::User).unwrap().is_some());
    let after = out(&e.ws, "chapter.list", json!({"book": e.book}));
    assert_eq!(after.as_array().unwrap().len(), 3);
}

#[test]
fn ideas_and_elements_and_what_fails_alone() {
    let e = env();
    let people = out(
        &e.ws,
        "category.create",
        json!({"book": e.book, "name": "人物"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    out(
        &e.ws,
        "element.create",
        json!({"book": e.book, "name": "安娜"}),
    );
    let parsed = |name: &str, text: &str| parse_bytes(name, text.as_bytes()).unwrap();
    let ideas = import_docs(
        &e.ws,
        &Actor::User,
        &e.book,
        &ImportTarget::Idea,
        &[(String::new(), parsed("念头.md", "一个**念头**"))],
        None,
    )
    .unwrap();
    let idea = ideas[0].result.clone().unwrap();
    let listed = out(&e.ws, "idea.list", json!({"book": e.book}));
    assert_eq!(listed[0]["id"], idea.id);
    assert_eq!(
        prose(&e.ws, &idea.doc),
        vec![para(vec![
            run("一个"),
            Run {
                bold: true,
                ..run("念头")
            }
        ])]
    );

    let items = import_docs(
        &e.ws,
        &Actor::User,
        &e.book,
        &ImportTarget::Element {
            category: Some(people.clone()),
        },
        &[
            (String::new(), parsed("安娜.md", "重名的要素")),
            (String::new(), parsed("本.md", "# 本\n\n钟表匠。")),
        ],
        None,
    )
    .unwrap();
    assert!(items[0].result.is_err(), "a taken element name is refused");
    let ben = items[1]
        .result
        .clone()
        .expect("the next file still imports");
    assert_eq!(ben.name, "本");
    assert!(ben.doc.starts_with("element:"));
    let el = out(
        &e.ws,
        "element.list",
        json!({"book": e.book, "category": people}),
    );
    assert_eq!(el[0]["name"], "本");
    assert_eq!(prose(&e.ws, &ben.doc), vec![para(vec![run("钟表匠。")])]);

    // A cancelled import stops before the next file.
    let stop = AtomicBool::new(true);
    let none = import_docs(
        &e.ws,
        &Actor::User,
        &e.book,
        &ImportTarget::Idea,
        &[(String::new(), parsed("x.md", "x"))],
        Some(&stop),
    )
    .unwrap();
    assert!(none.is_empty());
    // A book that is gone is refused as a whole.
    out(&e.ws, "book.trash", json!({"book": e.book}));
    assert!(
        import_docs(
            &e.ws,
            &Actor::User,
            &e.book,
            &ImportTarget::Idea,
            &[(String::new(), parsed("y.md", "y"))],
            None,
        )
        .is_err()
    );
}

#[test]
fn an_import_actor_gets_automatic_links() {
    let e = env();
    out(
        &e.ws,
        "element.create",
        json!({"book": e.book, "name": "安娜"}),
    );
    let doc: ParsedDoc = parse_bytes("a.txt", "安娜回来了。".as_bytes()).unwrap();
    let items = import_docs(
        &e.ws,
        &Actor::Import,
        &e.book,
        &ImportTarget::Chapter { storyline: None },
        &[(String::new(), doc)],
        None,
    )
    .unwrap();
    let made = items[0].result.clone().unwrap();
    let session = e.ws.prose_session(&made.doc).unwrap();
    let reader = session.reader();
    let view = reader.view();
    assert_eq!(
        view.entity_links().len(),
        1,
        "the name is linked as it is for any import"
    );
}

#[test]
fn warnings_travel_with_the_file() {
    let parsed = parse_bytes("a.md", "![图](p.png) 字".as_bytes()).unwrap();
    assert_eq!(parsed.warnings, vec![ImportWarning::ImagesDropped(1)]);
    assert_eq!(parsed.blocks, vec![para(vec![run("字")])]);
}
