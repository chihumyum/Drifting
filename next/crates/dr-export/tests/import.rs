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
    let book = out(&ws, "project.create", json!({"name": "导入"}))["id"]
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
    let line = dr_testkit::seed::acceptance::novel_entry(
        &e.ws,
        &e.book,
        "tpl-storyline",
        "主线",
        None,
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let first = dr_testkit::seed::acceptance::novel_entry(
        &e.ws,
        &e.book,
        "tpl-chapter",
        "原有",
        None,
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
        &ImportTarget::new(line.clone()),
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
    let chapters = serde_json::json!(dr_testkit::seed::acceptance::entries_by_template(
        &e.ws,
        &e.book,
        "tpl-chapter"
    ));
    let ids: Vec<&str> = chapters
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, [first.as_str(), &made[0].id, &made[1].id, &made[2].id]);
    for c in &chapters.as_array().unwrap()[1..] {
        assert!(
            out(&e.ws, "membership.list", json!({"book":e.book}))
                .as_array()
                .unwrap()
                .iter()
                .any(|m| m["host"] == line && m["member"] == c["id"])
        );
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
    let after = serde_json::json!(dr_testkit::seed::acceptance::entries_by_template(
        &e.ws,
        &e.book,
        "tpl-chapter"
    ));
    assert_eq!(after.as_array().unwrap().len(), 3);
}

#[test]
fn ideas_and_elements_and_what_fails_alone() {
    let e = env();
    let raw =
        e.ws.library()
            .load_copy(&format!("book:{}", e.book))
            .unwrap();
    let book_id = e.book.parse().unwrap();
    let roots = dr_doc::v3::find_novel_roots(
        &dr_doc::v3::BorrowedBookV3::new(&raw, &book_id)
            .unwrap()
            .view(),
    )
    .unwrap();
    let ideas_root = roots.ideas.to_string();
    let people = roots.cat_character.to_string();
    dr_testkit::seed::acceptance::novel_entry(&e.ws, &e.book, "tpl-character", "安娜", None);
    let parsed = |name: &str, text: &str| parse_bytes(name, text.as_bytes()).unwrap();
    let ideas = import_docs(
        &e.ws,
        &Actor::User,
        &e.book,
        &ImportTarget::new(ideas_root.clone()),
        &[(String::new(), parsed("念头.md", "一个**念头**"))],
        None,
    )
    .unwrap();
    let idea = ideas[0].result.clone().unwrap();
    let listed = serde_json::json!(dr_testkit::seed::acceptance::entries_by_template(
        &e.ws, &e.book, "tpl-idea"
    ));
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
        &ImportTarget::new(people.clone()),
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
    assert!(ben.doc.starts_with("body:"));
    let el = out(&e.ws, "entry.get", json!({"book":e.book,"id":ben.id}));
    assert_eq!(el["title"], "本");
    assert_eq!(el["parent"], people);
    assert_eq!(prose(&e.ws, &ben.doc), vec![para(vec![run("钟表匠。")])]);

    // A cancelled import stops before the next file.
    let stop = AtomicBool::new(true);
    let none = import_docs(
        &e.ws,
        &Actor::User,
        &e.book,
        &ImportTarget::new(ideas_root.clone()),
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
            &ImportTarget::new(ideas_root),
            &[(String::new(), parsed("y.md", "y"))],
            None,
        )
        .is_err()
    );
}

#[test]
fn an_import_actor_gets_automatic_links() {
    let e = env();
    let manuscript =
        dr_testkit::seed::acceptance::novel_root(&e.ws, &e.book, dr_doc::v3::novel::TPL_MANUSCRIPT);
    dr_testkit::seed::acceptance::novel_entry(
        &e.ws,
        &e.book,
        dr_doc::v3::novel::TPL_CHARACTER,
        "安娜",
        None,
    );
    let doc: ParsedDoc = parse_bytes("a.txt", "安娜回来了。".as_bytes()).unwrap();
    let items = import_docs(
        &e.ws,
        &Actor::Import,
        &e.book,
        &ImportTarget::new(manuscript),
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
fn target_level_inherits_default_template_and_refuses_non_level_or_missing_default() {
    use dr_doc::v3::novel;

    let e = env();
    let manuscript =
        dr_testkit::seed::acceptance::novel_root(&e.ws, &e.book, novel::TPL_MANUSCRIPT);
    let volume = out(
        &e.ws,
        "entry.create",
        json!({
            "book": e.book,
            "parent": manuscript,
            "template": novel::TPL_GROUP,
            "level": true,
            "title": "第一卷"
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // `第一卷` (`tpl-group`) has no own default_template, so it inherits
    // `tpl-chapter` from `书稿` and places the imported entry under `第一卷`.
    let doc = parse_bytes("01 晨雾.md", "# 晨雾\n\n桥上起雾了。".as_bytes()).unwrap();
    let imported = import_docs(
        &e.ws,
        &Actor::User,
        &e.book,
        &ImportTarget::new(volume.clone()),
        &[(String::new(), doc)],
        None,
    )
    .unwrap();
    let made = imported[0].result.clone().expect("inherits tpl-chapter");
    let created = out(&e.ws, "entry.get", json!({"book": e.book, "id": made.id}));
    assert_eq!(created["parent"], volume);
    assert_eq!(created["template"], novel::TPL_CHAPTER);
    assert_eq!(
        prose(&e.ws, &made.doc),
        vec![para(vec![run("桥上起雾了。")])]
    );

    // An entry whose level switch is off cannot be an import target.
    let non_level = import_docs(
        &e.ws,
        &Actor::User,
        &e.book,
        &ImportTarget::new(made.id.clone()),
        &[(
            String::new(),
            parse_bytes("b.txt", "字".as_bytes()).unwrap(),
        )],
        None,
    )
    .unwrap();
    assert!(non_level[0].result.is_err());

    // A top-level `tpl-group` has no default_template anywhere up its chain.
    let bare_level = out(
        &e.ws,
        "entry.create",
        json!({
            "book": e.book,
            "template": novel::TPL_GROUP,
            "level": true,
            "title": "无默认模板"
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let no_default = import_docs(
        &e.ws,
        &Actor::User,
        &e.book,
        &ImportTarget::new(bare_level.clone()),
        &[(
            String::new(),
            parse_bytes("c.txt", "字".as_bytes()).unwrap(),
        )],
        None,
    )
    .unwrap();
    assert!(no_default[0].result.is_err());
    let children = out(
        &e.ws,
        "entry.list",
        json!({"book": e.book, "parent": bare_level}),
    );
    assert_eq!(children.as_array().unwrap().len(), 0);
}

#[test]
fn the_text_goes_into_the_first_book_prose_else_the_first_prose() {
    use dr_doc::v3::novel;

    let e = env();
    let templates = out(&e.ws, "entry_template.list", json!({"book": e.book}));
    let chapter = templates
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == novel::TPL_CHAPTER)
        .unwrap();
    let module = chapter["modules"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == novel::MOD_PROSE)
        .unwrap()
        .clone();
    // The chapter's own prose stops counting; a second one after it counts.
    let mut first = module.clone();
    first["config"]["in_book"] = json!(false);
    let mut second = module;
    second["id"] = json!("synthetic-book-body");
    second["name"] = json!("Synthetic book body");
    second["config"]["in_book"] = json!(true);
    for module in [first, second] {
        out(
            &e.ws,
            "entry_template.put_module",
            json!({"book": e.book, "template": novel::TPL_CHAPTER, "module": module}),
        );
    }
    let manuscript =
        dr_testkit::seed::acceptance::novel_root(&e.ws, &e.book, novel::TPL_MANUSCRIPT);
    let imported = import_docs(
        &e.ws,
        &Actor::User,
        &e.book,
        &ImportTarget::new(manuscript.clone()),
        &[(
            String::new(),
            parse_bytes("雾.md", "# 雾\n\n桥上起雾了。".as_bytes()).unwrap(),
        )],
        None,
    )
    .unwrap();
    let made = imported[0].result.clone().expect("two prose bodies");
    assert_eq!(made.doc, format!("body:{}/synthetic-book-body", made.id));
    assert_eq!(
        prose(&e.ws, &made.doc),
        vec![para(vec![run("桥上起雾了。")])]
    );

    // A level whose new entries' prose counts nowhere: the first prose.
    let level = out(
        &e.ws,
        "entry.create",
        json!({
            "book": e.book,
            "template": novel::TPL_GROUP,
            "level": true,
            "title": "分类夹"
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    out(
        &e.ws,
        "entry.update",
        json!({"book": e.book, "id": level, "overrides": {"default_template": novel::TPL_CATEGORY}}),
    );
    let imported = import_docs(
        &e.ws,
        &Actor::User,
        &e.book,
        &ImportTarget::new(level),
        &[(
            String::new(),
            parse_bytes("说明.txt", "一段说明".as_bytes()).unwrap(),
        )],
        None,
    )
    .unwrap();
    let made = imported[0].result.clone().expect("description only");
    assert_eq!(
        made.doc,
        format!("body:{}/{}", made.id, novel::MOD_DESCRIPTION)
    );
}

#[test]
fn warnings_travel_with_the_file() {
    let parsed = parse_bytes("a.md", "![图](p.png) 字".as_bytes()).unwrap();
    assert_eq!(parsed.warnings, vec![ImportWarning::ImagesDropped(1)]);
    assert_eq!(parsed.blocks, vec![para(vec![run("字")])]);
}
