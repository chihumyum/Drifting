//! Word (`.docx`) → manuscript blocks: what 0.1's `mammoth` conversion
//! (with Drifting's style map) and the editor's schema kept.
//!
//! - Paragraph styles by name (from `word/styles.xml`; the style id when it
//!   is not listed): Title and Heading 1 (also `标题 1`) are H1, Heading 2
//!   and 3 are H2 and H3, Heading 4–9 are H3 (the editor has three levels);
//!   Quote and Intense Quote (`引用`, `明显引用`) are a quote, consecutive
//!   quote paragraphs one quote (each still its own paragraph: 0.1's style
//!   map ran them together into one).
//! - A centred or right-aligned paragraph keeps its alignment.
//! - Runs keep bold, italic, underline, strike and double strike; a link
//!   (a hyperlink relationship, or a `HYPERLINK` field) keeps its address
//!   when it is a web or mail one. Line breaks stay; page and column breaks
//!   go. Tracked deletions go, insertions stay.
//! - Lists are paragraphs; a table's cells are paragraphs, row by row.
//! - Pictures are dropped and counted; empty paragraphs are dropped
//!   (mammoth's default).
//! - Whitespace runs as the editor's HTML parser read them in 0.1: spaces
//!   and tabs collapse to one space, none at a paragraph's ends.

use std::collections::HashMap;
use std::io::{Cursor, Read};

use roxmltree::{Document, Node, ParsingOptions};

use super::{ImportError, ImportWarning};
use crate::manuscript::{Align, Block, Run};

/// The largest part of a document read, decompressed (a zip bomb stops
/// here).
const MAX_PART_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Body,
    Heading(u8),
    Quote,
}

struct Para {
    kind: Kind,
    align: Align,
    runs: Vec<Run>,
}

/// What a field (`fldChar`) is doing to the runs in it.
enum Field {
    None,
    /// Between `begin` and `separate`: the instruction, not shown.
    Instr(String),
    /// Between `separate` and `end`: the result, linked when the field is a
    /// hyperlink.
    Result(Option<String>),
}

struct Cx {
    styles: HashMap<String, String>,
    rels: HashMap<String, String>,
    images: usize,
    field: Field,
}

fn part(
    zip: &mut zip::ZipArchive<Cursor<&[u8]>>,
    name: &str,
) -> Result<Option<String>, ImportError> {
    let file = match zip.by_name(name) {
        Ok(f) => f,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(e) => return Err(ImportError::NotDocx(e.to_string())),
    };
    let mut bytes = Vec::new();
    file.take(MAX_PART_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| ImportError::NotDocx(e.to_string()))?;
    if bytes.len() as u64 > MAX_PART_BYTES {
        return Err(ImportError::TooLarge);
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| ImportError::NotDocx(format!("{name} is not UTF-8")))
}

fn xml(text: &str) -> Result<Document<'_>, ImportError> {
    Document::parse_with_options(
        text,
        ParsingOptions {
            allow_dtd: false,
            ..ParsingOptions::default()
        },
    )
    .map_err(|e| ImportError::NotDocx(e.to_string()))
}

fn name<'a>(n: &Node<'a, '_>) -> &'a str {
    n.tag_name().name()
}

/// An attribute by its local name, whatever its namespace (transitional
/// and strict Word documents differ there).
fn attr<'a>(n: &Node<'a, '_>, local: &str) -> Option<&'a str> {
    n.attributes()
        .find(|a| a.name() == local)
        .map(|a| a.value())
}

fn child<'a, 'i>(n: &Node<'a, 'i>, local: &str) -> Option<Node<'a, 'i>> {
    n.children().find(|c| c.is_element() && name(c) == local)
}

/// `<w:b/>` is on; `w:val="0"`, `"false"`, `"off"` turn it off.
fn toggle(n: Option<Node<'_, '_>>) -> bool {
    n.is_some_and(|n| !matches!(attr(&n, "val"), Some("0" | "false" | "off" | "none")))
}

pub(super) fn parse(
    bytes: &[u8],
    warnings: &mut Vec<ImportWarning>,
) -> Result<Vec<Block>, ImportError> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|e| ImportError::NotDocx(e.to_string()))?;
    let document = part(&mut zip, "word/document.xml")?
        .ok_or_else(|| ImportError::NotDocx("word/document.xml is missing".into()))?;
    let styles_xml = part(&mut zip, "word/styles.xml")?;
    let rels_xml = part(&mut zip, "word/_rels/document.xml.rels")?;

    let mut styles = HashMap::new();
    if let Some(text) = &styles_xml {
        for s in xml(text)?
            .descendants()
            .filter(|n| n.is_element() && name(n) == "style")
        {
            if let (Some(id), Some(n)) = (
                attr(&s, "styleId"),
                child(&s, "name").and_then(|n| attr(&n, "val")),
            ) {
                styles.insert(id.to_owned(), n.to_owned());
            }
        }
    }
    let mut rels = HashMap::new();
    if let Some(text) = &rels_xml {
        for r in xml(text)?
            .descendants()
            .filter(|n| n.is_element() && name(n) == "Relationship")
        {
            if let (Some(id), Some(target)) = (attr(&r, "Id"), attr(&r, "Target")) {
                rels.insert(id.to_owned(), target.to_owned());
            }
        }
    }
    let doc = xml(&document)?;
    let body = doc
        .descendants()
        .find(|n| n.is_element() && name(n) == "body")
        .ok_or_else(|| ImportError::NotDocx("the document has no body".into()))?;
    let mut cx = Cx {
        styles,
        rels,
        images: 0,
        field: Field::None,
    };
    let mut paras = Vec::new();
    blocks(body, &mut cx, &mut paras);
    if cx.images > 0 {
        warnings.push(ImportWarning::ImagesDropped(cx.images));
    }
    Ok(assemble(paras))
}

/// What a paragraph style makes of a paragraph, by its name.
fn kind_of(style_name: &str) -> Kind {
    let n: String = style_name
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_lowercase();
    if n == "title" {
        return Kind::Heading(1);
    }
    for prefix in ["heading", "标题"] {
        if let Some(d) = n.strip_prefix(prefix)
            && let Ok(level) = d.parse::<u8>()
            && (1..=9).contains(&level)
        {
            return Kind::Heading(level.min(3));
        }
    }
    if matches!(n.as_str(), "quote" | "intensequote" | "引用" | "明显引用") {
        return Kind::Quote;
    }
    Kind::Body
}

fn blocks(node: Node<'_, '_>, cx: &mut Cx, out: &mut Vec<Para>) {
    for c in node.children().filter(Node::is_element) {
        match name(&c) {
            "p" => paragraph(c, cx, out),
            "tbl" => {
                for row in c.children().filter(|r| r.is_element() && name(r) == "tr") {
                    for cell in row.children().filter(|t| t.is_element() && name(t) == "tc") {
                        blocks(cell, cx, out);
                    }
                }
            }
            "sdt" => {
                if let Some(content) = child(&c, "sdtContent") {
                    blocks(content, cx, out);
                }
            }
            "customXml" | "ins" | "sdtContent" => blocks(c, cx, out),
            _ => {}
        }
    }
}

fn paragraph(p: Node<'_, '_>, cx: &mut Cx, out: &mut Vec<Para>) {
    let props = child(&p, "pPr");
    let style = props
        .and_then(|pr| child(&pr, "pStyle"))
        .and_then(|s| attr(&s, "val"));
    let kind = style.map_or(Kind::Body, |id| {
        kind_of(cx.styles.get(id).map(String::as_str).unwrap_or(id))
    });
    let align = match props
        .and_then(|pr| child(&pr, "jc"))
        .and_then(|j| attr(&j, "val"))
    {
        Some("center") => Align::Center,
        Some("right" | "end") => Align::Right,
        _ => Align::Justify,
    };
    let mut runs = Vec::new();
    inline(p, cx, None, &mut runs);
    let runs = tidy(runs);
    if runs.iter().any(|r| !r.text.trim().is_empty()) {
        out.push(Para { kind, align, runs });
    }
}

fn inline(node: Node<'_, '_>, cx: &mut Cx, href: Option<&str>, runs: &mut Vec<Run>) {
    for c in node.children().filter(Node::is_element) {
        match name(&c) {
            "r" => run(c, cx, href, runs),
            "hyperlink" => {
                let target = attr(&c, "id")
                    .and_then(|id| cx.rels.get(id).cloned())
                    .filter(|t| crate::manuscript::exported_link(t.trim()));
                let target = target.map(|t| t.trim().to_owned());
                inline(c, cx, target.as_deref().or(href), runs);
            }
            "fldSimple" => {
                let link = attr(&c, "instr").and_then(hyperlink_field);
                inline(c, cx, link.as_deref().or(href), runs);
            }
            "sdt" => {
                if let Some(content) = child(&c, "sdtContent") {
                    inline(content, cx, href, runs);
                }
            }
            "ins" | "smartTag" | "customXml" | "sdtContent" | "bdo" | "dir" => {
                inline(c, cx, href, runs)
            }
            _ => {}
        }
    }
}

/// The address of a `HYPERLINK "…"` field instruction (web and mail only).
fn hyperlink_field(instr: &str) -> Option<String> {
    let rest = instr.trim().strip_prefix("HYPERLINK")?.trim();
    let url = match rest.strip_prefix('"') {
        Some(q) => q.split('"').next()?,
        None => rest.split_whitespace().next()?,
    };
    crate::manuscript::exported_link(url.trim()).then(|| url.trim().to_owned())
}

fn run(r: Node<'_, '_>, cx: &mut Cx, href: Option<&str>, runs: &mut Vec<Run>) {
    let props = child(&r, "rPr");
    let has = |local: &str| props.and_then(|p| child(&p, local));
    let mut style = Run {
        text: String::new(),
        bold: toggle(has("b")),
        italic: toggle(has("i")),
        underline: toggle(has("u")),
        strike: toggle(has("strike")) || toggle(has("dstrike")),
        href: href.map(str::to_owned),
    };
    let mut text = String::new();
    for c in r.children().filter(Node::is_element) {
        match name(&c) {
            "fldChar" => match attr(&c, "fldCharType") {
                Some("begin") => cx.field = Field::Instr(String::new()),
                Some("separate") => {
                    let link = match &cx.field {
                        Field::Instr(instr) => hyperlink_field(instr),
                        _ => None,
                    };
                    cx.field = Field::Result(link);
                }
                Some("end") => cx.field = Field::None,
                _ => {}
            },
            "instrText" => {
                if let Field::Instr(instr) = &mut cx.field {
                    instr.push_str(c.text().unwrap_or(""));
                }
            }
            _ if matches!(cx.field, Field::Instr(_)) => {}
            "t" => text.push_str(c.text().unwrap_or("")),
            "tab" | "ptab" => text.push(' '),
            "br" => {
                if !matches!(attr(&c, "type"), Some("page" | "column")) {
                    text.push('\n');
                }
            }
            "cr" => text.push('\n'),
            "noBreakHyphen" => text.push('-'),
            "drawing" | "pict" | "object" => cx.images += 1,
            _ => {}
        }
    }
    if let Field::Result(Some(link)) = &cx.field
        && style.href.is_none()
    {
        style.href = Some(link.clone());
    }
    if !text.is_empty() {
        style.text = text;
        runs.push(style);
    }
}

/// Spaces collapsed, ends trimmed, equal neighbours merged.
fn tidy(runs: Vec<Run>) -> Vec<Run> {
    let mut out: Vec<Run> = Vec::new();
    let mut last_space = true;
    for mut r in runs {
        let mut text = String::with_capacity(r.text.len());
        for c in r.text.chars() {
            if matches!(c, ' ' | '\t' | '\r' | '\u{0C}') {
                if !last_space {
                    text.push(' ');
                }
                last_space = true;
            } else {
                text.push(c);
                last_space = c == '\n';
            }
        }
        if text.is_empty() {
            continue;
        }
        r.text = text;
        match out.last_mut() {
            Some(last)
                if last.bold == r.bold
                    && last.italic == r.italic
                    && last.underline == r.underline
                    && last.strike == r.strike
                    && last.href == r.href =>
            {
                last.text.push_str(&r.text)
            }
            _ => out.push(r),
        }
    }
    // No space before a line break, none at the end.
    for r in &mut out {
        while r.text.contains(" \n") {
            r.text = r.text.replace(" \n", "\n");
        }
    }
    while let Some(last) = out.last_mut() {
        let t = last.text.trim_end_matches([' ', '\n']).to_owned();
        if t.is_empty() {
            out.pop();
        } else {
            last.text = t;
            break;
        }
    }
    while let Some(first) = out.first_mut() {
        let t = first.text.trim_start_matches([' ', '\n']).to_owned();
        if t.is_empty() {
            out.remove(0);
        } else {
            first.text = t;
            break;
        }
    }
    out
}

fn assemble(paras: Vec<Para>) -> Vec<Block> {
    let mut out: Vec<Block> = Vec::new();
    for p in paras {
        let block = match p.kind {
            Kind::Heading(level) => Block::Heading {
                level,
                runs: p.runs,
                align: p.align,
            },
            Kind::Body | Kind::Quote => Block::Paragraph {
                runs: p.runs,
                align: p.align,
                indent: 0,
            },
        };
        if p.kind == Kind::Quote {
            if let Some(Block::Quote { blocks }) = out.last_mut() {
                blocks.push(block);
            } else {
                out.push(Block::Quote {
                    blocks: vec![block],
                });
            }
        } else {
            out.push(block);
        }
    }
    out
}

#[cfg(test)]
pub(crate) mod tests {
    use std::io::Write;

    use super::*;

    const W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    const R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

    /// A synthetic `.docx`: `body` is the inside of `<w:body>`.
    pub(crate) fn docx(body: &str, styles: &str, rels: &str) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let opts = zip::write::SimpleFileOptions::default();
        let mut put = |name: &str, text: String| {
            zip.start_file(name, opts).unwrap();
            zip.write_all(text.as_bytes()).unwrap();
        };
        put(
            "word/document.xml",
            format!(
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="{W}" xmlns:r="{R}"><w:body>{body}</w:body></w:document>"#
            ),
        );
        if !styles.is_empty() {
            put(
                "word/styles.xml",
                format!(
                    r#"<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="{W}">{styles}</w:styles>"#
                ),
            );
        }
        if !rels.is_empty() {
            put(
                "word/_rels/document.xml.rels",
                format!(
                    r#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{rels}</Relationships>"#
                ),
            );
        }
        zip.finish().unwrap().into_inner()
    }

    pub(crate) const STYLES: &str = r#"<w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style><w:style w:type="paragraph" w:styleId="a5"><w:name w:val="Quote"/></w:style><w:style w:type="paragraph" w:styleId="H5"><w:name w:val="标题 5"/></w:style>"#;

    fn run(text: &str) -> Run {
        Run {
            text: text.into(),
            ..Run::default()
        }
    }

    fn p(style: &str, inner: &str) -> String {
        let props = if style.is_empty() {
            String::new()
        } else {
            format!(r#"<w:pPr><w:pStyle w:val="{style}"/></w:pPr>"#)
        };
        format!("<w:p>{props}{inner}</w:p>")
    }

    fn r(props: &str, text: &str) -> String {
        format!(r#"<w:r><w:rPr>{props}</w:rPr><w:t xml:space="preserve">{text}</w:t></w:r>"#)
    }

    #[test]
    fn styles_runs_links_and_breaks() {
        let body = [
            p("1", &r("", "第一章")),
            p("", &format!("{}{}{}", r("<w:b/>", "粗"), r("<w:i/><w:u w:val=\"single\"/>", "斜下"), r("<w:b w:val=\"0\"/><w:dstrike/>", "删"))),
            p("", r#"<w:hyperlink r:id="rId9"><w:r><w:t>站点</w:t></w:r></w:hyperlink><w:r><w:t xml:space="preserve">  一 	行</w:t><w:br/><w:t>二行</w:t><w:br w:type="page"/></w:r>"#),
            p("Heading2", &r("", "小节")),
            p("H5", &r("", "深处")),
            p("a5", &r("", "引一")),
            p("a5", &r("", "引二")),
            p("", ""),
            r#"<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>居中</w:t></w:r><w:r><w:drawing/></w:r></w:p>"#.to_owned(),
            r#"<w:tbl><w:tr><w:tc><w:p><w:r><w:t>格一</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>格二</w:t></w:r></w:p></w:tc></w:tr></w:tbl>"#.to_owned(),
            r#"<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> HYPERLINK "https://f.example" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>域</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:del><w:r><w:delText>删掉的</w:delText></w:r></w:del><w:ins><w:r><w:t>加的</w:t></w:r></w:ins></w:p>"#.to_owned(),
        ]
        .concat();
        let rels = r#"<Relationship Id="rId9" Type="hyperlink" Target="https://example.com/" TargetMode="External"/>"#;
        let mut warnings = Vec::new();
        let got = parse(&docx(&body, STYLES, rels), &mut warnings).unwrap();
        let heading = |level: u8, text: &str| Block::Heading {
            level,
            runs: vec![run(text)],
            align: Align::Justify,
        };
        let para = |runs: Vec<Run>, align: Align| Block::Paragraph {
            runs,
            align,
            indent: 0,
        };
        assert_eq!(got[0], heading(1, "第一章"));
        assert_eq!(
            got[1],
            para(
                vec![
                    Run {
                        bold: true,
                        ..run("粗")
                    },
                    Run {
                        italic: true,
                        underline: true,
                        ..run("斜下")
                    },
                    Run {
                        strike: true,
                        ..run("删")
                    },
                ],
                Align::Justify
            )
        );
        assert_eq!(
            got[2],
            para(
                vec![
                    Run {
                        href: Some("https://example.com/".into()),
                        ..run("站点")
                    },
                    run(" 一 行\n二行"),
                ],
                Align::Justify
            )
        );
        assert_eq!(got[3], heading(2, "小节"));
        assert_eq!(got[4], heading(3, "深处"), "Heading 5 is H3");
        assert_eq!(
            got[5],
            Block::Quote {
                blocks: vec![
                    para(vec![run("引一")], Align::Justify),
                    para(vec![run("引二")], Align::Justify)
                ]
            }
        );
        assert_eq!(
            got[6],
            para(vec![run("居中")], Align::Center),
            "the empty paragraph is gone"
        );
        assert_eq!(got[7], para(vec![run("格一")], Align::Justify));
        assert_eq!(got[8], para(vec![run("格二")], Align::Justify));
        assert_eq!(
            got[9],
            para(
                vec![
                    Run {
                        href: Some("https://f.example".into()),
                        ..run("域")
                    },
                    run("加的")
                ],
                Align::Justify
            )
        );
        assert_eq!(got.len(), 10);
        assert_eq!(warnings, vec![ImportWarning::ImagesDropped(1)]);
    }

    #[test]
    fn style_ids_stand_in_for_missing_styles() {
        let got = parse(
            &docx(
                &[p("Title", &r("", "书名")), p("Heading3", &r("", "三"))].concat(),
                "",
                "",
            ),
            &mut Vec::new(),
        )
        .unwrap();
        assert!(matches!(&got[0], Block::Heading { level: 1, .. }));
        assert!(matches!(&got[1], Block::Heading { level: 3, .. }));
    }

    #[test]
    fn what_is_not_a_word_document_is_refused() {
        assert!(matches!(
            parse(b"plain text", &mut Vec::new()),
            Err(ImportError::NotDocx(_))
        ));
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        zip.start_file("other.xml", zip::write::SimpleFileOptions::default())
            .unwrap();
        let bytes = zip.finish().unwrap().into_inner();
        assert!(matches!(
            parse(&bytes, &mut Vec::new()),
            Err(ImportError::NotDocx(_))
        ));
        // A DTD (an entity expansion attack) is refused.
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        zip.start_file(
            "word/document.xml",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        zip.write_all(
            br#"<!DOCTYPE x [<!ENTITY a "aaaa">]><w:document xmlns:w="w"><w:body/></w:document>"#,
        )
        .unwrap();
        let bytes = zip.finish().unwrap().into_inner();
        assert!(matches!(
            parse(&bytes, &mut Vec::new()),
            Err(ImportError::NotDocx(_))
        ));
    }
}
