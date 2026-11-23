//! M41's back end on real libraries: a hand-built book through F3's
//! commands and the editor's transactions, and the `lite` seed.

use std::collections::HashMap;
use std::io::{Cursor, Read};
use std::time::{Duration, Instant, UNIX_EPOCH};

use dr_doc::prose::EmbedKind;
use dr_export::{
    Align, Block, Format, Labels, ListItem, ListKind, Options, Run, Section, default_chapters,
    outline, read_manuscript, render,
};
use dr_model::id::{AssetId, CommentId, EmbedId};
use dr_model::kind::{EntityKind, ListKind as ProseListKind};
use dr_model::pos::PosKey;
use dr_model::prose::{BlockAttrs, EntityLink, Heading, InlineMarks, InlineStyle, LINE_BREAK};
use dr_model::v3::EntityLinkV3;
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
        options: Default::default(),
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
    let b = id(&out(ws, "project.create", json!({"name": "雾港来信"})));
    let chapter = |title: &str, text: &str, _summary: &str| {
        id(&dr_testkit::seed::acceptance::novel_entry(
            ws,
            &b,
            "tpl-chapter",
            title,
            Some(text),
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
    let anna = id(&dr_testkit::seed::acceptance::novel_entry(
        ws,
        &b,
        "tpl-character",
        "安娜",
        Some(""),
    ));
    // Styles, quotes, a rule, alignment, indent, a line break and embeds,
    // the way the editor writes them.
    let session = ws
        .prose_session(&format!("body:{letters}/mod-prose"))
        .unwrap();
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
                    kind: EntityKind::Entry,
                    block: None,
                    end_block: None,
                    manual: false,
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
            t.insert_embed(p, &EmbedId::new_v7(), &EmbedKind::Asset(AssetId::new_v7()))?;
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
fn the_outline_lists_canonical_manuscript_entries_in_order() {
    let e = env();
    let b = book(&e.ws);
    let o = outline(&e.ws, &b.id).unwrap();
    assert_eq!(o.title, "雾港来信");
    assert!(o.acts.is_empty());
    let ids: Vec<&str> = o.chapters.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(
        ids,
        [&b.prologue, &b.letters, &b.harbour, &b.voyage, &b.cut].map(String::as_str)
    );
    assert_eq!(
        default_chapters(&o),
        [&b.prologue, &b.letters, &b.harbour, &b.voyage, &b.cut].map(String::clone)
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
            hung: Vec::new(),
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
            "第一章 来信",
            "第二章　旧港",
            "第三章　返航",
            "删掉的一章"
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
    let Section::Chapter { blocks, .. } = &m.sections[1] else {
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
        // The table's cells travel as a structured grid; the material is gone.
        Block::Table {
            rows: vec![vec![vec![run("潮高")], vec![run("三米\n四米")]]],
        },
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
    assert!(all.contains("删掉的一章"));
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
            hung: Vec::new(),
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
fn a_chapter_never_written_exports_empty() {
    let e = env();
    let b = id(&out(&e.ws, "project.create", json!({"name": "空书"})));
    dr_testkit::seed::acceptance::novel_entry(&e.ws, &b, "tpl-chapter", "空正文", Some(""));
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
    let seeded = seed::generate_v3(Preset::Lite, seed::DEFAULT_SEED).unwrap();
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
            hung: Vec::new(),
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
                Block::List { items, .. } => items
                    .iter()
                    .flat_map(|item| item.runs.iter())
                    .map(|r| r.text.chars().count())
                    .sum(),
                Block::CodeBlock { text, .. } => text.chars().count(),
                Block::Callout { blocks, .. } | Block::Quote { blocks } => chars(blocks),
                Block::Table { rows } => rows
                    .iter()
                    .flat_map(|row| row.iter())
                    .flat_map(|cell| cell.iter())
                    .map(|r| r.text.chars().count())
                    .sum(),
                Block::Image { caption, .. } => caption.chars().count(),
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
    eprintln!("lite export: {}", times.join(", "));
    ws.close();
}

struct PdfObj {
    header: String,
    stream: Option<Vec<u8>>,
}

fn is_pdf_delim_or_ws(b: u8) -> bool {
    b.is_ascii_whitespace()
        || matches!(
            b,
            b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%'
        )
}

fn find_pdf_key(dict: &str, key: &str) -> Option<usize> {
    let mut offset = 0;
    while let Some(rel) = dict[offset..].find(key) {
        let idx = offset + rel;
        let after = idx + key.len();
        if dict
            .as_bytes()
            .get(after)
            .is_none_or(|&b| is_pdf_delim_or_ws(b))
        {
            return Some(after);
        }
        offset = idx + 1;
    }
    None
}

fn direct_usize_after_key(dict: &str, key: &str) -> Option<usize> {
    let after = find_pdf_key(dict, key)?;
    let rest = dict[after..].trim_start();
    let digits_len = rest.bytes().take_while(|b| b.is_ascii_digit()).count();
    if digits_len == 0 {
        return None;
    }
    let val: usize = rest[..digits_len].parse().ok()?;
    let tail = rest[digits_len..].trim_start();
    if tail.starts_with("0 R") {
        return None;
    }
    Some(val)
}

fn parse_pdf_objects(pdf: &[u8]) -> HashMap<u32, PdfObj> {
    let mut out = HashMap::new();
    let mut pos = 0;
    while pos < pdf.len() {
        let Some(rel) = pdf[pos..].windows(4).position(|w| w == b" obj") else {
            break;
        };
        let obj_kw = pos + rel;
        let mut line_start = obj_kw;
        while line_start > pos && !matches!(pdf[line_start - 1], b'\n' | b'\r') {
            line_start -= 1;
        }
        let prefix = std::str::from_utf8(&pdf[line_start..obj_kw]).unwrap_or("");
        let parts: Vec<&str> = prefix.split_whitespace().collect();
        let body_start = obj_kw + 4;
        let Some(end_rel) = pdf[body_start..].windows(6).position(|w| w == b"endobj") else {
            break;
        };
        let body = &pdf[body_start..body_start + end_rel];
        if let [id_str, "0"] = parts.as_slice()
            && let Ok(obj_id) = id_str.parse::<u32>()
        {
            if let Some(s_rel) = body.windows(6).position(|w| w == b"stream")
                && (s_rel == 0 || body[s_rel - 1] != b'd')
            {
                let header = String::from_utf8_lossy(&body[..s_rel]).into_owned();
                let mut data_start = s_rel + 6;
                if body.get(data_start) == Some(&b'\r') {
                    data_start += 1;
                }
                if body.get(data_start) == Some(&b'\n') {
                    data_start += 1;
                }
                let raw_slice = if let Some(exact_len) = direct_usize_after_key(&header, "/Length")
                    && data_start + exact_len <= body.len()
                {
                    Some(&body[data_start..data_start + exact_len])
                } else {
                    body[data_start..]
                        .windows(9)
                        .rposition(|w| w == b"endstream")
                        .map(|es_rel| {
                            let mut raw = &body[data_start..data_start + es_rel];
                            if raw.ends_with(b"\n") {
                                raw = &raw[..raw.len() - 1];
                            }
                            if raw.ends_with(b"\r") {
                                raw = &raw[..raw.len() - 1];
                            }
                            raw
                        })
                };
                if let Some(raw) = raw_slice {
                    let decoded = if header.contains("/FlateDecode") {
                        let mut dec = flate2::read::ZlibDecoder::new(raw);
                        let mut buf = Vec::new();
                        if dec.read_to_end(&mut buf).is_ok() {
                            Some(buf)
                        } else {
                            None
                        }
                    } else {
                        Some(raw.to_vec())
                    };
                    out.insert(
                        obj_id,
                        PdfObj {
                            header,
                            stream: decoded,
                        },
                    );
                }
            } else {
                out.insert(
                    obj_id,
                    PdfObj {
                        header: String::from_utf8_lossy(body).into_owned(),
                        stream: None,
                    },
                );
            }
        }
        pos = body_start + end_rel + 6;
    }
    out
}

fn hex_bytes(hex: &str) -> Vec<u8> {
    let clean: Vec<u8> = hex.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    let mut out = Vec::with_capacity(clean.len().div_ceil(2));
    let mut i = 0;
    while i < clean.len() {
        let hi = (clean[i] as char).to_digit(16).unwrap_or(0) as u8;
        let lo = clean
            .get(i + 1)
            .and_then(|&b| (b as char).to_digit(16))
            .unwrap_or(0) as u8;
        out.push((hi << 4) | lo);
        i += 2;
    }
    out
}

fn utf16be_hex_to_string(hex: &str) -> String {
    let bytes = hex_bytes(hex);
    let units: Vec<u16> = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .copied()
        .map(u16::from_be_bytes)
        .collect();
    String::from_utf16_lossy(&units)
}

#[derive(Default)]
struct CMapTable {
    code_bytes: usize,
    map: HashMap<u16, String>,
}

fn parse_cmap(text: &str) -> CMapTable {
    let mut code_bytes = 2usize;
    if text.contains("<00> <FF>") || text.contains("<00><FF>") {
        code_bytes = 1;
    }
    let mut map = HashMap::new();
    let hex_tokens = |section: &str| -> Vec<String> {
        let mut tokens = Vec::new();
        let mut rest = section;
        while let Some(open) = rest.find('<') {
            let after = &rest[open + 1..];
            let Some(close) = after.find('>') else {
                break;
            };
            tokens.push(after[..close].to_owned());
            rest = &after[close + 1..];
        }
        tokens
    };
    let code_u16 = |hex: &str| -> u16 { u16::from_str_radix(hex.trim(), 16).unwrap_or(0) };
    let mut scan = text;
    while let Some(start) = scan.find("beginbfchar") {
        let after = &scan[start + "beginbfchar".len()..];
        let Some(end) = after.find("endbfchar") else {
            break;
        };
        let toks = hex_tokens(&after[..end]);
        if let Some(first) = toks.first() {
            code_bytes = (first.trim().len() / 2).clamp(1, 2);
        }
        for [k, v] in toks.as_chunks::<2>().0 {
            map.insert(code_u16(k), utf16be_hex_to_string(v));
        }
        scan = &after[end + "endbfchar".len()..];
    }
    let mut scan = text;
    while let Some(start) = scan.find("beginbfrange") {
        let after = &scan[start + "beginbfrange".len()..];
        let Some(end) = after.find("endbfrange") else {
            break;
        };
        for line in after[..end].lines() {
            let trimmed = line.trim();
            if !trimmed.starts_with('<') {
                continue;
            }
            if let Some(arr_open) = trimmed.find('[')
                && let Some(arr_close) = trimmed.rfind(']')
            {
                let bounds = hex_tokens(&trimmed[..arr_open]);
                let targets = hex_tokens(&trimmed[arr_open + 1..arr_close]);
                if bounds.len() == 2 {
                    code_bytes = (bounds[0].trim().len() / 2).clamp(1, 2);
                    let lo = code_u16(&bounds[0]);
                    let hi = code_u16(&bounds[1]);
                    for (offset, target) in (lo..=hi).zip(targets.iter()) {
                        map.insert(offset, utf16be_hex_to_string(target));
                    }
                }
            } else {
                let toks = hex_tokens(trimmed);
                if toks.len() == 3 {
                    code_bytes = (toks[0].trim().len() / 2).clamp(1, 2);
                    let lo = code_u16(&toks[0]);
                    let hi = code_u16(&toks[1]);
                    let base = utf16be_hex_to_string(&toks[2]);
                    let mut chars: Vec<u16> = base.encode_utf16().collect();
                    for code in lo..=hi {
                        map.insert(code, String::from_utf16_lossy(&chars));
                        if let Some(last) = chars.last_mut() {
                            *last = last.wrapping_add(1);
                        }
                    }
                }
            }
        }
        scan = &after[end + "endbfrange".len()..];
    }
    CMapTable { code_bytes, map }
}

fn dict_has_name_pair(dict: &str, key: &str, expected: &str) -> bool {
    let Some(after) = find_pdf_key(dict, key) else {
        return false;
    };
    let rest = dict[after..].trim_start();
    if !rest.starts_with(expected) {
        return false;
    }
    rest.as_bytes()
        .get(expected.len())
        .is_none_or(|&b| is_pdf_delim_or_ws(b))
}

fn ref_after_key(dict: &str, key: &str) -> Option<u32> {
    let after = find_pdf_key(dict, key)?;
    let rest = dict[after..].trim_start();
    let id_len = rest.bytes().take_while(|b| b.is_ascii_digit()).count();
    if id_len == 0 {
        return None;
    }
    let id: u32 = rest[..id_len].parse().ok()?;
    let after_id = rest[id_len..].trim_start();
    let after_gen = after_id.strip_prefix('0')?.trim_start();
    if after_gen.starts_with('R')
        && after_gen
            .as_bytes()
            .get(1)
            .is_none_or(|&b| is_pdf_delim_or_ws(b))
    {
        Some(id)
    } else {
        None
    }
}

fn parse_font_resource_map(text: &str) -> HashMap<String, u32> {
    let mut out = HashMap::new();
    let Some(after) = find_pdf_key(text, "/Font") else {
        return out;
    };
    let rest = &text[after..];
    let Some(open) = rest.find("<<") else {
        return out;
    };
    let inner = &rest[open + 2..];
    let Some(close) = inner.find(">>") else {
        return out;
    };
    let bytes = &inner.as_bytes()[..close];
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'/' {
            i += 1;
            let name_start = i;
            while i < bytes.len() && !is_pdf_delim_or_ws(bytes[i]) {
                i += 1;
            }
            let name = String::from_utf8_lossy(&bytes[name_start..i]).into_owned();
            while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            let id_start = i;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            let Ok(obj_id) = std::str::from_utf8(&bytes[id_start..i])
                .unwrap_or("")
                .parse::<u32>()
            else {
                continue;
            };
            while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            if bytes.get(i) != Some(&b'0') {
                continue;
            }
            i += 1;
            while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            if bytes.get(i) == Some(&b'R') {
                out.insert(name, obj_id);
                i += 1;
            }
        } else {
            i += 1;
        }
    }
    out
}

fn read_pdf_literal_string(bytes: &[u8], start: usize) -> (Vec<u8>, usize) {
    let mut out = Vec::new();
    let mut i = start + 1;
    let mut depth = 1usize;
    while i < bytes.len() && depth > 0 {
        match bytes[i] {
            b'(' => {
                depth += 1;
                out.push(b'(');
                i += 1;
            }
            b')' => {
                depth -= 1;
                if depth > 0 {
                    out.push(b')');
                }
                i += 1;
            }
            b'\\' => {
                i += 1;
                if i >= bytes.len() {
                    break;
                }
                match bytes[i] {
                    b'n' => {
                        out.push(b'\n');
                        i += 1;
                    }
                    b'r' => {
                        out.push(b'\r');
                        i += 1;
                    }
                    b't' => {
                        out.push(b'\t');
                        i += 1;
                    }
                    b'b' => {
                        out.push(0x08);
                        i += 1;
                    }
                    b'f' => {
                        out.push(0x0C);
                        i += 1;
                    }
                    b'\r' => {
                        i += 1;
                        if bytes.get(i) == Some(&b'\n') {
                            i += 1;
                        }
                    }
                    b'\n' => {
                        i += 1;
                    }
                    c @ b'0'..=b'7' => {
                        let mut val = c - b'0';
                        i += 1;
                        for _ in 0..2 {
                            if let Some(&d @ b'0'..=b'7') = bytes.get(i) {
                                val = val * 8 + (d - b'0');
                                i += 1;
                            } else {
                                break;
                            }
                        }
                        out.push(val);
                    }
                    other => {
                        out.push(other);
                        i += 1;
                    }
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    (out, i)
}

fn extract_pdf_text(pdf: &[u8]) -> String {
    let objs = parse_pdf_objects(pdf);
    let mut font_cmaps: HashMap<u32, CMapTable> = HashMap::new();
    for (&obj_id, obj) in &objs {
        if let Some(cmap_id) = ref_after_key(&obj.header, "/ToUnicode")
            && let Some(cmap_obj) = objs.get(&cmap_id)
            && let Some(stream) = &cmap_obj.stream
        {
            font_cmaps.insert(obj_id, parse_cmap(&String::from_utf8_lossy(stream)));
        }
    }
    let mut page_ids: Vec<u32> = objs
        .iter()
        .filter(|(_, obj)| dict_has_name_pair(&obj.header, "/Type", "/Page"))
        .map(|(&id, _)| id)
        .collect();
    page_ids.sort_unstable();

    let mut decoded = String::new();
    for page_id in page_ids {
        let page = &objs[&page_id];
        let mut fonts = parse_font_resource_map(&page.header);
        if fonts.is_empty()
            && let Some(res_id) = ref_after_key(&page.header, "/Resources")
            && let Some(res_obj) = objs.get(&res_id)
        {
            fonts = parse_font_resource_map(&res_obj.header);
        }
        let Some(contents_id) = ref_after_key(&page.header, "/Contents") else {
            continue;
        };
        let Some(stream) = objs.get(&contents_id).and_then(|o| o.stream.as_deref()) else {
            continue;
        };
        let mut active_font: Option<&CMapTable> = None;
        let mut last_name: Option<String> = None;
        let mut pending_strings: Vec<Vec<u8>> = Vec::new();
        let mut i = 0;
        while i < stream.len() {
            match stream[i] {
                b'%' => {
                    while i < stream.len() && !matches!(stream[i], b'\n' | b'\r') {
                        i += 1;
                    }
                }
                b'/' => {
                    i += 1;
                    let start = i;
                    while i < stream.len()
                        && !stream[i].is_ascii_whitespace()
                        && !matches!(stream[i], b'/' | b'<' | b'>' | b'(' | b')' | b'[' | b']')
                    {
                        i += 1;
                    }
                    last_name = Some(String::from_utf8_lossy(&stream[start..i]).into_owned());
                }
                b'(' => {
                    let (bytes, next) = read_pdf_literal_string(stream, i);
                    pending_strings.push(bytes);
                    i = next;
                }
                b'<' if stream.get(i + 1) != Some(&b'<') => {
                    let start = i + 1;
                    if let Some(rel) = stream[start..].iter().position(|&b| b == b'>') {
                        let hex = String::from_utf8_lossy(&stream[start..start + rel]);
                        pending_strings.push(hex_bytes(&hex));
                        i = start + rel + 1;
                    } else {
                        break;
                    }
                }
                b'<' => i += 2,
                b'>' if stream.get(i + 1) == Some(&b'>') => i += 2,
                b'[' => {
                    pending_strings.clear();
                    i += 1;
                }
                b']' => i += 1,
                b if b.is_ascii_whitespace() => i += 1,
                _ => {
                    let start = i;
                    while i < stream.len()
                        && !stream[i].is_ascii_whitespace()
                        && !matches!(stream[i], b'/' | b'<' | b'>' | b'(' | b')' | b'[' | b']')
                    {
                        i += 1;
                    }
                    let tok = &stream[start..i];
                    match tok {
                        b"Tf" => {
                            if let Some(name) = last_name.take() {
                                active_font = fonts
                                    .get(&name)
                                    .and_then(|font_obj| font_cmaps.get(font_obj));
                            }
                            pending_strings.clear();
                        }
                        b"Tj" | b"TJ" => {
                            if let Some(cmap) = active_font {
                                for raw_codes in pending_strings.drain(..) {
                                    if cmap.code_bytes == 1 {
                                        for &b in &raw_codes {
                                            if let Some(s) = cmap.map.get(&u16::from(b)) {
                                                decoded.push_str(s);
                                            }
                                        }
                                    } else {
                                        for &pair in raw_codes.as_chunks::<2>().0 {
                                            let cid = u16::from_be_bytes(pair);
                                            if let Some(s) = cmap.map.get(&cid) {
                                                decoded.push_str(s);
                                            }
                                        }
                                    }
                                }
                            } else {
                                pending_strings.clear();
                            }
                        }
                        b"ET" => {
                            pending_strings.clear();
                        }
                        _ => {}
                    }
                }
            }
        }
        decoded.push('\n');
    }
    decoded
}

#[test]
fn chapter_with_every_format_exports_to_epub_docx_and_pdf_without_dropping_text() {
    let e = env();
    let book_id = id(&out(
        &e.ws,
        "project.create",
        json!({"name": "全格式书稿验收"}),
    ));
    let lin = id(&dr_testkit::seed::acceptance::novel_entry(
        &e.ws,
        &book_id,
        "tpl-character",
        "林深",
        Some(""),
    ));
    let chapter_id = id(&dr_testkit::seed::acceptance::novel_entry(
        &e.ws,
        &book_id,
        "tpl-chapter",
        "第一章　全格式航志",
        Some(concat!(
            "一　出航\n",
            "正文含高亮标记词、行内代码片段 inline_beacon() 与角色林深。\n",
            "无序一：罗盘读数\n",
            "无序子项：偏东三度\n",
            "有序一：点火热机\n",
            "有序二：解缆离岸\n",
            "待办未完：清点淡水\n",
            "待办已完：封好舱门\n",
            "待办联动：校对航图\n",
            "fn signal_tide() -> &'static str {\n",
            "    \"灯塔信号73\"\n",
            "}\n",
            "提示块首段：暗礁水深不足两米。\n",
            "提示块次段：夜航务必减速。\n",
            "引文段落：风自北来。\n",
            "\n",
            "收尾段落：顺利靠岸。",
        )),
    ));

    // Create a linked TODO in the book document and mark it Resolved so the third
    // task item exercises `Comment::is_done` resolution during export.
    let done_todo_raw = id(&out(
        &e.ws,
        "comment.create",
        json!({
            "book": book_id,
            "target": {"kind": "entry", "id": chapter_id},
            "module": "mod-prose",
            "kind": "todo",
            "body": "校对航图"
        }),
    ));
    out(
        &e.ws,
        "comment.update",
        json!({
            "book": book_id,
            "id": done_todo_raw,
            "status": "resolved"
        }),
    );
    let done_todo: CommentId = done_todo_raw.parse().unwrap();

    let doc_id = format!("body:{chapter_id}/mod-prose");
    let session = e.ws.prose_session(&doc_id).unwrap();
    session
        .edit(move |t| {
            let start = |t: &dr_doc::prose::ProseTxn<'_>, prefix: &str| {
                t.view()
                    .paragraphs()
                    .find(|p| p.text().starts_with(prefix))
                    .unwrap_or_else(|| panic!("missing paragraph {prefix}"))
                    .range
                    .start
            };
            let find = |t: &dr_doc::prose::ProseTxn<'_>, needle: &str| {
                let all = t.view().plain_text();
                let byte = all
                    .find(needle)
                    .unwrap_or_else(|| panic!("missing {needle}"));
                let at = all[..byte].chars().count();
                at..at + needle.chars().count()
            };

            let p = start(t, "一　出航");
            t.set_heading(p, Some(Heading::H1))?;

            let r = find(t, "高亮标记词");
            t.set_style(r, &InlineStyle::Highlight("yellow".into()))?;
            let r = find(t, "行内代码片段 inline_beacon()");
            t.set_style(r, &InlineStyle::Code)?;
            let r = find(t, "林深");
            t.link_entity(
                r,
                &EntityLink {
                    target: lin.clone(),
                    kind: EntityKind::Entry,
                    block: None,
                    end_block: None,
                    manual: false,
                },
            )?;

            let p = start(t, "无序一：");
            t.set_block_attrs(
                p,
                &BlockAttrs {
                    list: Some(ProseListKind::Bullet),
                    list_level: 0,
                    ..BlockAttrs::default()
                },
            )?;
            let p = start(t, "无序子项：");
            t.set_block_attrs(
                p,
                &BlockAttrs {
                    list: Some(ProseListKind::Bullet),
                    list_level: 1,
                    ..BlockAttrs::default()
                },
            )?;

            for prefix in ["有序一：", "有序二："] {
                let p = start(t, prefix);
                t.set_block_attrs(
                    p,
                    &BlockAttrs {
                        list: Some(ProseListKind::Ordered),
                        ..BlockAttrs::default()
                    },
                )?;
            }

            let p = start(t, "待办未完：");
            t.set_block_attrs(
                p,
                &BlockAttrs {
                    list: Some(ProseListKind::Task),
                    checked: false,
                    ..BlockAttrs::default()
                },
            )?;
            let p = start(t, "待办已完：");
            t.set_block_attrs(
                p,
                &BlockAttrs {
                    list: Some(ProseListKind::Task),
                    checked: true,
                    ..BlockAttrs::default()
                },
            )?;
            let p = start(t, "待办联动：");
            t.set_block_attrs(
                p,
                &BlockAttrs {
                    list: Some(ProseListKind::Task),
                    checked: false,
                    todo: Some(done_todo.clone()),
                    ..BlockAttrs::default()
                },
            )?;

            for prefix in ["fn signal_tide()", "    \"灯塔信号73\"", "}"] {
                let p = start(t, prefix);
                t.set_block_attrs(
                    p,
                    &BlockAttrs {
                        code_block: Some("rust".into()),
                        ..BlockAttrs::default()
                    },
                )?;
            }

            for prefix in ["提示块首段：", "提示块次段："] {
                let p = start(t, prefix);
                t.set_block_attrs(
                    p,
                    &BlockAttrs {
                        callout: Some("info".into()),
                        ..BlockAttrs::default()
                    },
                )?;
            }

            let p = start(t, "引文段落：");
            t.set_block_attrs(
                p,
                &BlockAttrs {
                    quote: true,
                    ..BlockAttrs::default()
                },
            )?;

            let empty = t
                .view()
                .paragraphs()
                .find(|p| p.is_empty())
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

            let p = start(t, "收尾段落：");
            let table_id = EmbedId::new_v7();
            {
                let w = t.insert_embed(p, &table_id, &EmbedKind::Table)?;
                let (c1, c2) = (PosKey::first(), PosKey::first().after());
                let (r1, r2) = (PosKey::first(), PosKey::first().after());
                w.add_col("c1", &c1)?;
                w.add_col("c2", &c2)?;
                w.add_row("r1", &r1)?;
                w.add_row("r2", &r2)?;
            }
            let bold_marks = InlineMarks {
                bold: true,
                ..InlineMarks::default()
            };
            let code_marks = InlineMarks {
                code: true,
                ..InlineMarks::default()
            };
            let hl_marks = InlineMarks {
                highlight: Some("yellow".into()),
                ..InlineMarks::default()
            };
            t.set_table_cell_runs_v3(
                &table_id,
                "r1",
                "c1",
                &[dr_doc::prose::Run {
                    text: "表头泊位".into(),
                    marks: bold_marks.clone(),
                }],
                &[],
            )?;
            t.set_table_cell_runs_v3(
                &table_id,
                "r1",
                "c2",
                &[dr_doc::prose::Run {
                    text: "表头状态".into(),
                    marks: bold_marks,
                }],
                &[],
            )?;
            t.set_table_cell_runs_v3(
                &table_id,
                "r2",
                "c1",
                &[
                    dr_doc::prose::Run {
                        text: "北栈桥".into(),
                        marks: InlineMarks::default(),
                    },
                    dr_doc::prose::Run {
                        text: "A3".into(),
                        marks: code_marks,
                    },
                ],
                &[],
            )?;
            let prefix_text = format!("涨潮停靠{LINE_BREAK}");
            let hl_start = prefix_text.chars().count();
            let hl_end = hl_start + "高亮泊位备注".chars().count();
            let link_start = hl_end + 1;
            let link_end = link_start + "林深".chars().count();
            t.set_table_cell_runs_v3(
                &table_id,
                "r2",
                "c2",
                &[
                    dr_doc::prose::Run {
                        text: prefix_text,
                        marks: InlineMarks::default(),
                    },
                    dr_doc::prose::Run {
                        text: "高亮泊位备注".into(),
                        marks: hl_marks,
                    },
                    dr_doc::prose::Run {
                        text: " 林深".into(),
                        marks: InlineMarks::default(),
                    },
                ],
                &[(
                    link_start..link_end,
                    EntityLinkV3 {
                        target: lin,
                        kind: EntityKind::Entry,
                        module: None,
                        block: None,
                        end_block: None,
                        manual: false,
                    },
                )],
            )?;
            Ok(())
        })
        .unwrap();

    let manuscript = read_manuscript(
        &e.ws,
        &book_id,
        &Options {
            chapter_titles: true,
            author: "合成作者".into(),
            ..Options::default()
        },
        &labels(),
        "zh-CN",
        None,
        now(),
    )
    .unwrap();

    let [Section::Chapter { blocks, .. }] = manuscript.sections.as_slice() else {
        panic!("expected one chapter section");
    };
    assert!(blocks.iter().any(|b| matches!(
        b,
        Block::List {
            kind: ListKind::Bullet,
            items
        } if items.len() == 2 && items[1].level == 1
    )));
    assert!(blocks.iter().any(|b| matches!(
        b,
        Block::List {
            kind: ListKind::Ordered,
            items
        } if items.len() == 2
    )));
    assert!(blocks.iter().any(|b| matches!(
        b,
        Block::List {
            kind: ListKind::Task,
            items
        } if items == &[
            ListItem { runs: vec![run("待办未完：清点淡水")], level: 0, checked: false },
            ListItem { runs: vec![run("待办已完：封好舱门")], level: 0, checked: true },
            ListItem { runs: vec![run("待办联动：校对航图")], level: 0, checked: true },
        ]
    )));
    assert!(blocks.iter().any(|b| matches!(
        b,
        Block::CodeBlock { language, text }
            if language == "rust" && text.contains("灯塔信号73")
    )));
    assert!(blocks.iter().any(|b| matches!(
        b,
        Block::Callout { kind, blocks } if kind == "info" && blocks.len() == 2
    )));
    assert!(blocks.iter().any(|b| matches!(
        b,
        Block::Table { rows } if rows.len() == 2 && rows[0].len() == 2
    )));

    let must_contain = [
        "全格式书稿验收",
        "第一章　全格式航志",
        "一　出航",
        "高亮标记词",
        "inline_beacon()",
        "林深",
        "无序一：罗盘读数",
        "无序子项：偏东三度",
        "有序一：点火热机",
        "有序二：解缆离岸",
        "待办未完：清点淡水",
        "待办已完：封好舱门",
        "待办联动：校对航图",
        "fn signal_tide()",
        "灯塔信号73",
        "提示块首段：暗礁水深不足两米。",
        "提示块次段：夜航务必减速。",
        "引文段落：风自北来。",
        "表头泊位",
        "表头状态",
        "北栈桥A3",
        "涨潮停靠",
        "高亮泊位备注",
        "收尾段落：顺利靠岸。",
    ];

    // 1. EPUB: well-formed XHTML, structural elements for every format, no dropped text.
    let epub_bytes = render(&manuscript, Format::Epub).unwrap();
    let mut epub_zip = zip::ZipArchive::new(Cursor::new(&epub_bytes)).unwrap();
    let mut epub_xhtml = String::new();
    let mut epub_text = String::new();
    for idx in 0..epub_zip.len() {
        let mut file = epub_zip.by_index(idx).unwrap();
        let name = file.name().unwrap().into_owned();
        if name.ends_with(".xhtml") || name.ends_with(".xml") || name.ends_with(".ncx") {
            let mut xml_src = String::new();
            file.read_to_string(&mut xml_src).unwrap();
            let parsed = roxmltree::Document::parse_with_options(
                &xml_src,
                roxmltree::ParsingOptions {
                    allow_dtd: true,
                    ..Default::default()
                },
            )
            .unwrap_or_else(|err| panic!("{name}: {err}"));
            if name.ends_with(".xhtml") {
                epub_xhtml.push_str(&xml_src);
                for text in parsed
                    .descendants()
                    .filter(|n| n.is_text())
                    .filter_map(|n| n.text())
                {
                    epub_text.push_str(text);
                }
            }
        }
    }
    for fragment in [
        "<mark>高亮标记词</mark>",
        "<code>行内代码片段 inline_beacon()</code>",
        "<ul class=\"prose-list\">",
        "<li class=\"list-level-1\">无序子项：偏东三度</li>",
        "<ol class=\"prose-list\">",
        "<ul class=\"prose-list task-list\">",
        "☐ </span>待办未完：清点淡水",
        "☑ </span>待办已完：封好舱门",
        "☑ </span>待办联动：校对航图",
        "<pre class=\"code-block\" data-lang=\"rust\"><code>",
        "<aside class=\"callout\">",
        "<table class=\"prose-table\">",
        "<code>A3</code>",
        "<mark>高亮泊位备注</mark>",
    ] {
        assert!(epub_xhtml.contains(fragment), "EPUB missing {fragment}");
    }
    for phrase in must_contain {
        assert!(epub_text.contains(phrase), "EPUB dropped {phrase:?}");
    }

    // 2. DOCX: valid OOXML parts, format styles/tables/marks, no dropped text.
    let docx_bytes = render(&manuscript, Format::Docx).unwrap();
    let mut docx_zip = zip::ZipArchive::new(Cursor::new(&docx_bytes)).unwrap();
    let mut docx_doc_xml = String::new();
    for idx in 0..docx_zip.len() {
        let mut file = docx_zip.by_index(idx).unwrap();
        let name = file.name().unwrap().into_owned();
        if name.ends_with(".xml") || name.ends_with(".rels") {
            let mut xml_src = String::new();
            file.read_to_string(&mut xml_src).unwrap();
            let parsed =
                roxmltree::Document::parse(&xml_src).unwrap_or_else(|err| panic!("{name}: {err}"));
            if name == "word/document.xml" {
                docx_doc_xml = parsed
                    .descendants()
                    .filter(|n| n.is_text())
                    .filter_map(|n| n.text())
                    .collect::<String>();
                for raw_fragment in [
                    "<w:pStyle w:val=\"CodeBlock\"/>",
                    "<w:pStyle w:val=\"Callout\"/>",
                    "<w:highlight w:val=\"yellow\"/>",
                    "w:ascii=\"Courier New\"",
                    "<w:tbl>",
                    "• ",
                    "1. ",
                    "2. ",
                    "☐ ",
                    "☑ ",
                ] {
                    assert!(
                        xml_src.contains(raw_fragment),
                        "DOCX XML missing {raw_fragment}"
                    );
                }
            }
        }
    }
    for phrase in must_contain {
        assert!(docx_doc_xml.contains(phrase), "DOCX dropped {phrase:?}");
    }

    // 3. PDF: valid PDF with embedded subset fonts & ToUnicode, decoded glyph stream has all text.
    if dr_export::pdf_fonts(&manuscript).is_err() && !cfg!(target_os = "macos") {
        return;
    }
    let pdf_bytes = render(&manuscript, Format::Pdf).unwrap();
    assert!(pdf_bytes.starts_with(b"%PDF-"));
    let pdf_raw = String::from_utf8_lossy(&pdf_bytes);
    assert!(pdf_raw.contains("/ToUnicode"));
    assert!(pdf_raw.contains("/FontFile2") || pdf_raw.contains("/FontFile3"));
    let pdf_text = extract_pdf_text(&pdf_bytes);
    for phrase in must_contain {
        assert!(
            pdf_text.contains(phrase),
            "PDF dropped {phrase:?}; extracted text:\n{pdf_text}"
        );
    }
}

#[test]
fn embedded_images_captions_and_pdfs_export_across_epub_docx_and_pdf_while_trashed_assets_stay_out()
{
    use dr_doc::prose::FileEmbedLook;
    use dr_model::v3::{EmbedAlign, EmbedSize};
    use dr_store::asset::{MAX_COPY_BYTES, SourceImport};
    use image::{ImageFormat, Rgb, RgbImage};
    use sha2::{Digest, Sha256};

    let e = env();
    let book_id = id(&out(&e.ws, "project.create", json!({"name": "图文书稿"})));
    let staging = tempfile::tempdir().unwrap();

    // 1. Live PNG image asset with caption + non-default size/align.
    let png_bytes = dr_testkit::media::png(320, 180);
    let png_path = staging.path().join("harbour-beacon.png");
    std::fs::write(&png_path, &png_bytes).unwrap();
    let png_sha = format!("{:x}", Sha256::digest(&png_bytes));
    let png_id = AssetId::new_v7().to_string();
    e.ws.library()
        .import_asset(&SourceImport {
            book_id: &book_id,
            asset_id: &png_id,
            source: &png_path,
            mime: "image/png",
            ext: "png",
            dimensions: Some((320, 180)),
            limit: MAX_COPY_BYTES,
        })
        .unwrap();
    out(
        &e.ws,
        "asset.put",
        json!({
            "book": book_id,
            "id": png_id,
            "name": "灯塔航拍.png",
            "kind": "image",
            "mime": "image/png",
            "size": png_bytes.len() as i64,
            "sha256": png_sha,
            "width": 320,
            "height": 180,
        }),
    );

    // 2. Live JPEG image asset without caption (plus a JPEG cover to verify DOCX Content_Types deduplication).
    let mut jpg_img = RgbImage::new(240, 160);
    for (x, y, px) in jpg_img.enumerate_pixels_mut() {
        *px = Rgb([(40 + x % 180) as u8, (70 + y % 140) as u8, 130]);
    }
    let jpg_path = staging.path().join("dockyard.jpg");
    jpg_img
        .save_with_format(&jpg_path, ImageFormat::Jpeg)
        .unwrap();
    let jpg_bytes = std::fs::read(&jpg_path).unwrap();
    let jpg_sha = format!("{:x}", Sha256::digest(&jpg_bytes));
    let jpg_id = AssetId::new_v7().to_string();
    e.ws.library()
        .import_asset(&SourceImport {
            book_id: &book_id,
            asset_id: &jpg_id,
            source: &jpg_path,
            mime: "image/jpeg",
            ext: "jpg",
            dimensions: Some((240, 160)),
            limit: MAX_COPY_BYTES,
        })
        .unwrap();
    out(
        &e.ws,
        "asset.put",
        json!({
            "book": book_id,
            "id": jpg_id,
            "name": "船坞晨雾.jpg",
            "kind": "image",
            "mime": "image/jpeg",
            "size": jpg_bytes.len() as i64,
            "sha256": jpg_sha,
            "width": 240,
            "height": 160,
        }),
    );
    let cover_img = RgbImage::from_pixel(200, 300, Rgb([28, 42, 68]));
    let cover_path = staging.path().join("cover.jpg");
    cover_img
        .save_with_format(&cover_path, ImageFormat::Jpeg)
        .unwrap();
    let cover = dr_export::cover_from_path(&cover_path).unwrap();

    // 3. Live PDF asset -> exports as a single filename line.
    let pdf_src_bytes = dr_testkit::media::sample_pdf();
    let pdf_path = staging.path().join("tide-chart.pdf");
    std::fs::write(&pdf_path, &pdf_src_bytes).unwrap();
    let pdf_sha = format!("{:x}", Sha256::digest(&pdf_src_bytes));
    let pdf_id = AssetId::new_v7().to_string();
    e.ws.library()
        .import_asset(&SourceImport {
            book_id: &book_id,
            asset_id: &pdf_id,
            source: &pdf_path,
            mime: "application/pdf",
            ext: "pdf",
            dimensions: None,
            limit: MAX_COPY_BYTES,
        })
        .unwrap();
    out(
        &e.ws,
        "asset.put",
        json!({
            "book": book_id,
            "id": pdf_id,
            "name": "航海日志附录.pdf",
            "kind": "pdf",
            "mime": "application/pdf",
            "size": pdf_src_bytes.len() as i64,
            "sha256": pdf_sha,
        }),
    );

    // 4. Directly trashed image asset -> excluded.
    let trashed_img_bytes = dr_testkit::media::png(96, 64);
    let trashed_img_path = staging.path().join("trashed.png");
    std::fs::write(&trashed_img_path, &trashed_img_bytes).unwrap();
    let trashed_img_sha = format!("{:x}", Sha256::digest(&trashed_img_bytes));
    let trashed_img_id = AssetId::new_v7().to_string();
    e.ws.library()
        .import_asset(&SourceImport {
            book_id: &book_id,
            asset_id: &trashed_img_id,
            source: &trashed_img_path,
            mime: "image/png",
            ext: "png",
            dimensions: Some((96, 64)),
            limit: MAX_COPY_BYTES,
        })
        .unwrap();
    out(
        &e.ws,
        "asset.put",
        json!({
            "book": book_id,
            "id": trashed_img_id,
            "name": "已删插图.png",
            "kind": "image",
            "mime": "image/png",
            "size": trashed_img_bytes.len() as i64,
            "sha256": trashed_img_sha,
            "width": 96,
            "height": 64,
        }),
    );
    out(
        &e.ws,
        "asset.trash",
        json!({"book": book_id, "id": trashed_img_id}),
    );

    // 5. PDF asset inside a trashed asset folder -> excluded until folder restored.
    let folder_id = id(&out(
        &e.ws,
        "asset_folder.create",
        json!({"book": book_id, "name": "封存资料"}),
    ));
    let mut alt_pdf_bytes = dr_testkit::media::sample_pdf();
    alt_pdf_bytes.extend_from_slice(b"\n% folder-scoped\n");
    let folder_pdf_path = staging.path().join("folder-doc.pdf");
    std::fs::write(&folder_pdf_path, &alt_pdf_bytes).unwrap();
    let folder_pdf_sha = format!("{:x}", Sha256::digest(&alt_pdf_bytes));
    let folder_pdf_id = AssetId::new_v7().to_string();
    e.ws.library()
        .import_asset(&SourceImport {
            book_id: &book_id,
            asset_id: &folder_pdf_id,
            source: &folder_pdf_path,
            mime: "application/pdf",
            ext: "pdf",
            dimensions: None,
            limit: MAX_COPY_BYTES,
        })
        .unwrap();
    out(
        &e.ws,
        "asset.put",
        json!({
            "book": book_id,
            "id": folder_pdf_id,
            "name": "封存海图.pdf",
            "kind": "pdf",
            "mime": "application/pdf",
            "size": alt_pdf_bytes.len() as i64,
            "sha256": folder_pdf_sha,
            "folder": folder_id,
        }),
    );
    out(
        &e.ws,
        "asset_folder.trash",
        json!({"book": book_id, "id": folder_id}),
    );

    let ch = id(&dr_testkit::seed::acceptance::novel_entry(
        &e.ws,
        &book_id,
        "tpl-chapter",
        "第一章　插图与海图",
        Some("开篇夜色。\n结尾钟声。"),
    ));
    let session = e.ws.prose_session(&format!("body:{ch}/mod-prose")).unwrap();
    let png_aid = AssetId::parse(&png_id).unwrap();
    let jpg_aid = AssetId::parse(&jpg_id).unwrap();
    let pdf_aid = AssetId::parse(&pdf_id).unwrap();
    let trashed_aid = AssetId::parse(&trashed_img_id).unwrap();
    let folder_pdf_aid = AssetId::parse(&folder_pdf_id).unwrap();
    session
        .edit(move |t| {
            let at_end = |t: &dr_doc::prose::ProseTxn<'_>| {
                t.view()
                    .paragraphs()
                    .find(|p| p.text().starts_with("结尾钟声"))
                    .unwrap()
                    .range
                    .start
            };
            let e1 = EmbedId::new_v7();
            let pos = at_end(t);
            t.insert_embed(pos, &e1, &EmbedKind::Asset(png_aid))?;
            t.set_file_embed_look(
                &e1,
                &FileEmbedLook {
                    size: Some(EmbedSize::Small),
                    align: Some(EmbedAlign::Left),
                    caption: "  灯塔雾夜实景\n摄于旧港  ".into(),
                },
            )?;
            let e2 = EmbedId::new_v7();
            let pos = at_end(t);
            t.insert_embed(pos, &e2, &EmbedKind::Asset(jpg_aid))?;

            let e3 = EmbedId::new_v7();
            let pos = at_end(t);
            t.insert_embed(pos, &e3, &EmbedKind::Asset(pdf_aid))?;

            let e4 = EmbedId::new_v7();
            let pos = at_end(t);
            t.insert_embed(pos, &e4, &EmbedKind::Asset(trashed_aid))?;
            t.set_file_embed_look(
                &e4,
                &FileEmbedLook {
                    size: None,
                    align: None,
                    caption: "已删插图图注不应出现".into(),
                },
            )?;

            let e5 = EmbedId::new_v7();
            let pos = at_end(t);
            t.insert_embed(pos, &e5, &EmbedKind::Asset(folder_pdf_aid))?;
            Ok(())
        })
        .unwrap();

    let manuscript = read_manuscript(
        &e.ws,
        &book_id,
        &Options {
            chapter_titles: true,
            author: "合成作者".into(),
            cover: Some(cover),
            ..Options::default()
        },
        &labels(),
        "zh-CN",
        None,
        now(),
    )
    .unwrap();

    let [Section::Chapter { blocks, .. }] = manuscript.sections.as_slice() else {
        panic!("expected single chapter");
    };
    assert_eq!(blocks.len(), 5, "open + 2 live images + 1 live pdf + close");
    assert!(matches!(
        &blocks[1],
        Block::Image {
            media_type,
            width: 320,
            height: 180,
            caption,
            ..
        } if media_type == "image/png" && caption == "灯塔雾夜实景 摄于旧港"
    ));
    assert!(matches!(
        &blocks[2],
        Block::Image {
            media_type,
            width: 240,
            height: 160,
            caption,
            ..
        } if media_type == "image/jpeg" && caption.is_empty()
    ));
    assert_eq!(
        blocks[3],
        Block::Paragraph {
            runs: vec![run("航海日志附录.pdf")],
            align: Align::Left,
            indent: 0,
        }
    );

    // 1. EPUB: valid XHTML, manifest contains image-1.png and image-2.jpeg, figure+figcaption, no size/align classes, PDF filename present, trashed absent.
    let epub_bytes = render(&manuscript, Format::Epub).unwrap();
    let mut epub_zip = zip::ZipArchive::new(Cursor::new(&epub_bytes)).unwrap();
    let mut epub_names = Vec::new();
    let mut epub_xhtml = String::new();
    for idx in 0..epub_zip.len() {
        let mut file = epub_zip.by_index(idx).unwrap();
        let name = file.name().unwrap().into_owned();
        if name.ends_with(".xhtml") || name.ends_with(".xml") || name.ends_with(".ncx") {
            let mut src = String::new();
            file.read_to_string(&mut src).unwrap();
            roxmltree::Document::parse_with_options(
                &src,
                roxmltree::ParsingOptions {
                    allow_dtd: true,
                    ..Default::default()
                },
            )
            .unwrap_or_else(|err| panic!("{name}: {err}"));
            if name.ends_with(".xhtml") {
                epub_xhtml.push_str(&src);
            }
        }
        epub_names.push(name);
    }
    assert!(epub_names.iter().any(|n| n == "OEBPS/images/image-1.png"));
    assert!(epub_names.iter().any(|n| n == "OEBPS/images/image-2.jpeg"));
    assert!(epub_xhtml.contains("<figure class=\"prose-image\">"));
    assert!(
        epub_xhtml.contains("<img src=\"../images/image-1.png\" alt=\"灯塔雾夜实景 摄于旧港\"/>")
    );
    assert!(epub_xhtml.contains("<figcaption>灯塔雾夜实景 摄于旧港</figcaption>"));
    assert!(epub_xhtml.contains("<img src=\"../images/image-2.jpeg\" alt=\"\"/>"));
    assert!(epub_xhtml.contains("航海日志附录.pdf"));
    assert!(!epub_xhtml.contains("已删插图图注不应出现"));
    assert!(!epub_xhtml.contains("封存海图.pdf"));

    // 2. DOCX: valid XML across all parts, deduplicated Content_Types defaults, media files embedded, caption and PDF filename in document text.
    let docx_bytes = render(&manuscript, Format::Docx).unwrap();
    let mut docx_zip = zip::ZipArchive::new(Cursor::new(&docx_bytes)).unwrap();
    let mut docx_names = Vec::new();
    let mut docx_text = String::new();
    let mut docx_doc_src = String::new();
    for idx in 0..docx_zip.len() {
        let mut file = docx_zip.by_index(idx).unwrap();
        let name = file.name().unwrap().into_owned();
        if name.ends_with(".xml") || name.ends_with(".rels") {
            let mut src = String::new();
            file.read_to_string(&mut src).unwrap();
            let parsed =
                roxmltree::Document::parse(&src).unwrap_or_else(|err| panic!("{name}: {err}"));
            if name == "[Content_Types].xml" {
                let jpeg_defaults = parsed
                    .descendants()
                    .filter(|n| {
                        n.has_tag_name("Default") && n.attribute("Extension") == Some("jpeg")
                    })
                    .count();
                let png_defaults = parsed
                    .descendants()
                    .filter(|n| {
                        n.has_tag_name("Default") && n.attribute("Extension") == Some("png")
                    })
                    .count();
                assert_eq!(jpeg_defaults, 1, "deduplicated jpeg Default");
                assert_eq!(png_defaults, 1, "deduplicated png Default");
            }
            if name == "word/document.xml" {
                docx_text = parsed
                    .descendants()
                    .filter(|n| n.is_text())
                    .filter_map(|n| n.text())
                    .collect();
                docx_doc_src = src;
            }
        }
        docx_names.push(name);
    }
    assert!(docx_names.iter().any(|n| n == "word/media/image1.png"));
    assert!(docx_names.iter().any(|n| n == "word/media/image2.jpeg"));
    assert!(docx_doc_src.contains("r:embed=\"rIdImg1\""));
    assert!(docx_doc_src.contains("r:embed=\"rIdImg2\""));
    assert!(docx_doc_src.contains("<w:pStyle w:val=\"ImageCaption\"/>"));
    assert!(docx_text.contains("灯塔雾夜实景 摄于旧港"));
    assert!(docx_text.contains("航海日志附录.pdf"));
    assert!(!docx_text.contains("已删插图图注不应出现"));
    assert!(!docx_text.contains("封存海图.pdf"));

    // 3. PDF: valid PDF with image XObjects, shaped caption text and PDF filename line.
    if dr_export::pdf_fonts(&manuscript).is_ok() || cfg!(target_os = "macos") {
        let pdf_bytes = render(&manuscript, Format::Pdf).unwrap();
        assert!(pdf_bytes.starts_with(b"%PDF-"));
        let pdf_raw = String::from_utf8_lossy(&pdf_bytes);
        let image_xobjects = pdf_raw
            .match_indices("/Subtype")
            .filter(|(idx, _)| {
                pdf_raw[idx + "/Subtype".len()..]
                    .trim_start()
                    .starts_with("/Image")
            })
            .count();
        assert_eq!(image_xobjects, 3, "cover + 2 live inline images");
        let pdf_text = extract_pdf_text(&pdf_bytes);
        assert!(
            pdf_text.contains("灯塔雾夜实景 摄于旧港"),
            "PDF missing image caption; extracted:\n{pdf_text}"
        );
        assert!(
            pdf_text.contains("航海日志附录.pdf"),
            "PDF missing embedded PDF filename; extracted:\n{pdf_text}"
        );
        assert!(!pdf_text.contains("已删插图图注不应出现"));
        assert!(!pdf_text.contains("封存海图.pdf"));
    }

    // Restoring the trashed asset folder brings `封存海图.pdf` back into export.
    out(
        &e.ws,
        "asset_folder.restore",
        json!({"book": book_id, "id": folder_id}),
    );
    let restored = read_manuscript(
        &e.ws,
        &book_id,
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
    let [Section::Chapter { blocks, .. }] = restored.sections.as_slice() else {
        panic!("expected single chapter");
    };
    assert!(blocks.iter().any(|b| matches!(
        b,
        Block::Paragraph { runs, .. } if runs.iter().any(|r| r.text == "封存海图.pdf")
    )));
}

/// A HEIC (an iPhone photo) in prose: only the system decodes its source, so
/// the manuscript takes the JPEG display copy the material library keeps
/// beside it; without one the picture is left out, as an image that cannot
/// be read always was. The source stays the HEIC.
#[test]
fn a_heic_in_prose_exports_through_its_display_copy() {
    use dr_store::asset::{MAX_COPY_BYTES, SourceImport, Variant, VariantBytes};
    use sha2::{Digest, Sha256};

    let e = env();
    let book_id = id(&out(&e.ws, "project.create", json!({"name": "相册"})));
    let staging = tempfile::tempdir().unwrap();
    let heic = dr_testkit::media::HEIC;
    let path = staging.path().join("IMG_0001.HEIC");
    std::fs::write(&path, heic).unwrap();
    let asset = AssetId::new_v7();
    let asset_id = asset.to_string();
    e.ws.library()
        .import_asset(&SourceImport {
            book_id: &book_id,
            asset_id: &asset_id,
            source: &path,
            mime: "image/heic",
            ext: "heic",
            dimensions: Some((600, 400)),
            limit: MAX_COPY_BYTES,
        })
        .unwrap();
    out(
        &e.ws,
        "asset.put",
        json!({
            "book": book_id, "id": asset_id, "name": "IMG_0001", "kind": "image",
            "mime": "image/heic", "size": heic.len() as i64,
            "sha256": format!("{:x}", Sha256::digest(heic)), "width": 600, "height": 400,
        }),
    );
    let ch = id(&dr_testkit::seed::acceptance::novel_entry(
        &e.ws,
        &book_id,
        "tpl-chapter",
        "第一章",
        Some("海边。\n结尾。"),
    ));
    let session = e.ws.prose_session(&format!("body:{ch}/mod-prose")).unwrap();
    session
        .edit(move |t| {
            let pos = t
                .view()
                .paragraphs()
                .find(|p| p.text().starts_with("结尾"))
                .unwrap()
                .range
                .start;
            t.insert_embed(pos, &EmbedId::new_v7(), &EmbedKind::Asset(asset))?;
            Ok(())
        })
        .unwrap();
    let images = |e: &Env| {
        let manuscript = read_manuscript(
            &e.ws,
            &book_id,
            &Options::default(),
            &labels(),
            "zh-CN",
            None,
            now(),
        )
        .unwrap();
        let [Section::Chapter { blocks, .. }] = manuscript.sections.as_slice() else {
            panic!("expected one chapter");
        };
        blocks
            .iter()
            .filter_map(|b| match b {
                Block::Image {
                    media_type,
                    width,
                    height,
                    ..
                } => Some((media_type.clone(), *width, *height)),
                _ => None,
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(images(&e), vec![], "no copy yet: left out, as before");
    // The display copy the material library makes (a JPEG of the picture).
    let mut jpeg = Vec::new();
    image::load_from_memory(&dr_testkit::media::quadrants(600, 400))
        .unwrap()
        .to_rgb8()
        .write_to(&mut Cursor::new(&mut jpeg), image::ImageFormat::Jpeg)
        .unwrap();
    e.ws.library()
        .put_variant(
            &asset_id,
            Variant::Display,
            &VariantBytes {
                bytes: jpeg,
                mime: "image/jpeg".into(),
                ext: "jpg".into(),
                width: 600,
                height: 400,
            },
        )
        .unwrap();
    assert_eq!(images(&e), vec![("image/jpeg".to_owned(), 600, 400)]);
    let source =
        e.ws.library()
            .asset(&asset_id, Variant::Source)
            .unwrap()
            .unwrap();
    assert_eq!(std::fs::read(source.path).unwrap(), heic);
}
