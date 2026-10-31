//! WordprocessingML package. Acts, chapters and prose headings map onto
//! Word's built-in Heading 1–5 styles, so the navigation pane and a Word table
//! of contents follow the outline.
use std::io::{Cursor, Write};

use zip::write::SimpleFileOptions;
use zip::CompressionMethod;

use super::text::{xml, Language};
use super::{Align, Block, Book, Run, Section};

const W_NS: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R_NS: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL_NS: &str = "http://schemas.openxmlformats.org/package/2006/relationships";
const DOC_REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/// A4 in twentieths of a point, 2.54 cm margins top/bottom and 3.17 cm sides.
const PAGE_W: u32 = 11_906;
const PAGE_H: u32 = 16_838;
const MARGIN_TB: u32 = 1_440;
const MARGIN_LR: u32 = 1_800;
const EMU_PER_TWIP: u64 = 635;

struct Fonts {
    latin: &'static str,
    east_asia: &'static str,
    east_asia_lang: &'static str,
}

fn fonts(language: Language) -> Fonts {
    match language {
        Language::SimplifiedChinese => Fonts {
            latin: "Times New Roman",
            east_asia: "SimSun",
            east_asia_lang: "zh-CN",
        },
        Language::TraditionalChinese => Fonts {
            latin: "Times New Roman",
            east_asia: "PMingLiU",
            east_asia_lang: "zh-TW",
        },
        Language::Japanese => Fonts {
            latin: "Times New Roman",
            east_asia: "Yu Mincho",
            east_asia_lang: "ja-JP",
        },
        Language::Korean => Fonts {
            latin: "Times New Roman",
            east_asia: "Batang",
            east_asia_lang: "ko-KR",
        },
        Language::Latin(_) => Fonts {
            latin: "Times New Roman",
            east_asia: "SimSun",
            east_asia_lang: "zh-CN",
        },
    }
}

#[derive(Default)]
struct Relationships {
    hyperlinks: Vec<(String, String)>,
}

impl Relationships {
    fn hyperlink(&mut self, href: &str) -> String {
        if let Some((id, _)) = self.hyperlinks.iter().find(|(_, target)| target == href) {
            return id.clone();
        }
        let id = format!("rIdLink{}", self.hyperlinks.len() + 1);
        self.hyperlinks.push((id.clone(), href.into()));
        id
    }
}

fn run_xml(run: &Run, out: &mut String) {
    let mut properties = String::new();
    if run.href.is_some() {
        properties.push_str("<w:rStyle w:val=\"Hyperlink\"/>");
    }
    if run.bold {
        properties.push_str("<w:b/><w:bCs/>");
    }
    if run.italic {
        properties.push_str("<w:i/><w:iCs/>");
    }
    if run.strike {
        properties.push_str("<w:strike/>");
    }
    if run.underline {
        properties.push_str("<w:u w:val=\"single\"/>");
    }
    out.push_str("<w:r>");
    if !properties.is_empty() {
        out.push_str(&format!("<w:rPr>{properties}</w:rPr>"));
    }
    for (index, line) in run.text.split('\n').enumerate() {
        if index > 0 {
            out.push_str("<w:br/>");
        }
        for (part_index, part) in line.split('\t').enumerate() {
            if part_index > 0 {
                out.push_str("<w:tab/>");
            }
            if !part.is_empty() {
                out.push_str(&format!("<w:t xml:space=\"preserve\">{}</w:t>", xml(part)));
            }
        }
    }
    out.push_str("</w:r>");
}

fn runs_xml(runs: &[Run], rels: &mut Relationships, out: &mut String) {
    let mut index = 0;
    while index < runs.len() {
        if let Some(href) = runs[index].href.as_deref() {
            let id = rels.hyperlink(href.trim());
            out.push_str(&format!("<w:hyperlink r:id=\"{id}\" w:history=\"1\">"));
            while index < runs.len() && runs[index].href.as_deref() == Some(href) {
                run_xml(&runs[index], out);
                index += 1;
            }
            out.push_str("</w:hyperlink>");
        } else {
            run_xml(&runs[index], out);
            index += 1;
        }
    }
}

struct Paragraph<'a> {
    style: Option<&'a str>,
    page_break_before: bool,
    align: Align,
    indent_level: u8,
    /// Latin books start a run of prose without a first-line indent.
    no_first_indent: bool,
}

fn paragraph_open(paragraph: &Paragraph<'_>, cjk: bool, out: &mut String) {
    let mut properties = String::new();
    if let Some(style) = paragraph.style {
        properties.push_str(&format!("<w:pStyle w:val=\"{style}\"/>"));
    }
    if paragraph.page_break_before {
        properties.push_str("<w:pageBreakBefore/>");
    }
    let centered = matches!(paragraph.align, Align::Center | Align::Right);
    if paragraph.indent_level > 0
        || paragraph.no_first_indent
        || (centered && paragraph.style.is_none())
    {
        let mut indent = String::from("<w:ind");
        if paragraph.indent_level > 0 {
            let chars = u32::from(paragraph.indent_level) * 200;
            indent.push_str(&format!(
                " w:leftChars=\"{chars}\" w:left=\"{}\"",
                chars * 24 / 10
            ));
        }
        if paragraph.no_first_indent || centered {
            indent.push_str(" w:firstLineChars=\"0\" w:firstLine=\"0\"");
        }
        indent.push_str("/>");
        properties.push_str(&indent);
    }
    let jc = match paragraph.align {
        Align::Justify => None,
        Align::Left => Some(if cjk { "left" } else { "start" }),
        Align::Center => Some("center"),
        Align::Right => Some(if cjk { "right" } else { "end" }),
    };
    if let Some(jc) = jc {
        properties.push_str(&format!("<w:jc w:val=\"{jc}\"/>"));
    }
    out.push_str("<w:p>");
    if !properties.is_empty() {
        out.push_str(&format!("<w:pPr>{properties}</w:pPr>"));
    }
}

struct Body<'a> {
    out: String,
    rels: Relationships,
    cjk: bool,
    /// The next paragraph starts a new page (a new act or chapter).
    pending_break: bool,
    heading_offset: u8,
    _book: &'a Book<'a>,
}

impl Body<'_> {
    fn paragraph(
        &mut self,
        style: Option<&str>,
        align: Align,
        indent: u8,
        first: bool,
        runs: &[Run],
    ) {
        let paragraph = Paragraph {
            style,
            page_break_before: std::mem::take(&mut self.pending_break),
            align,
            indent_level: indent,
            no_first_indent: first && !self.cjk && style.is_none(),
        };
        paragraph_open(&paragraph, self.cjk, &mut self.out);
        runs_xml(runs, &mut self.rels, &mut self.out);
        self.out.push_str("</w:p>\n");
    }

    fn blocks(&mut self, blocks: &[Block], quote: bool, first: &mut bool) {
        for block in blocks {
            match block {
                Block::Heading { level, runs, align } => {
                    let style = format!("Heading{}", (self.heading_offset + level).min(5));
                    self.paragraph(Some(&style), *align, 0, false, runs);
                    *first = true;
                }
                Block::Paragraph {
                    runs,
                    align,
                    indent,
                } => {
                    let style = quote.then_some("Quote");
                    self.paragraph(style, *align, *indent, *first, runs);
                    if runs.iter().any(|run| !run.text.is_empty()) {
                        *first = false;
                    }
                }
                Block::Quote { blocks } => {
                    let mut inner = true;
                    self.blocks(blocks, true, &mut inner);
                    *first = true;
                }
                Block::Break => {
                    let separator = [Run {
                        text: "*\u{2003}\u{2003}*\u{2003}\u{2003}*".into(),
                        ..Run::default()
                    }];
                    self.paragraph(Some("SceneBreak"), Align::Center, 0, false, &separator);
                    *first = true;
                }
            }
        }
    }
}

fn cover_xml(book: &Book<'_>) -> Option<String> {
    let cover = book.cover.as_ref()?;
    let max_w = u64::from(PAGE_W - 2 * MARGIN_LR) * EMU_PER_TWIP;
    let max_h = u64::from(PAGE_H - 2 * MARGIN_TB - 400) * EMU_PER_TWIP;
    let (w, h) = (u64::from(cover.width), u64::from(cover.height));
    let (cx, cy) = if w * max_h > h * max_w {
        (max_w, max_w * h / w)
    } else {
        (max_h * w / h, max_h)
    };
    let name = xml(book.title());
    Some(format!(
        "<w:p><w:pPr><w:spacing w:before=\"0\" w:after=\"0\"/><w:ind w:firstLineChars=\"0\" w:firstLine=\"0\"/><w:jc w:val=\"center\"/></w:pPr><w:r><w:drawing><wp:inline distT=\"0\" distB=\"0\" distL=\"0\" distR=\"0\"><wp:extent cx=\"{cx}\" cy=\"{cy}\"/><wp:docPr id=\"1\" name=\"Cover\" descr=\"{name}\"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect=\"1\"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/picture\"><pic:pic><pic:nvPicPr><pic:cNvPr id=\"1\" name=\"cover.{ext}\"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed=\"rIdCover\"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>\n",
        ext = cover.extension()
    ))
}

fn section_properties(body: bool) -> String {
    let mut sect = String::from("<w:sectPr>");
    if body {
        sect.push_str("<w:footerReference w:type=\"default\" r:id=\"rIdFooter\"/>");
    }
    sect.push_str(&format!(
        "<w:type w:val=\"nextPage\"/><w:pgSz w:w=\"{PAGE_W}\" w:h=\"{PAGE_H}\"/><w:pgMar w:top=\"{MARGIN_TB}\" w:right=\"{MARGIN_LR}\" w:bottom=\"{MARGIN_TB}\" w:left=\"{MARGIN_LR}\" w:header=\"851\" w:footer=\"992\" w:gutter=\"0\"/>"
    ));
    if body {
        sect.push_str("<w:pgNumType w:start=\"1\"/>");
    }
    sect.push_str("</w:sectPr>");
    sect
}

fn document_xml(book: &Book<'_>) -> (String, Relationships) {
    let cjk = book.language.is_cjk();
    let has_acts = book.has_acts();
    let mut body = Body {
        out: String::new(),
        rels: Relationships::default(),
        cjk,
        pending_break: false,
        heading_offset: if has_acts { 2 } else { 1 },
        _book: book,
    };
    // Front matter: cover, title and author, closed by its own section so the
    // page numbers in the body footer start at 1.
    if let Some(cover) = cover_xml(book) {
        body.out.push_str(&cover);
        body.pending_break = true;
    }
    let title = [Run {
        text: book.title().into(),
        ..Run::default()
    }];
    body.paragraph(Some("Title"), Align::Center, 0, false, &title);
    if !book.author().is_empty() {
        let author = [Run {
            text: book.author().into(),
            ..Run::default()
        }];
        body.paragraph(Some("Subtitle"), Align::Center, 0, false, &author);
    }
    body.out.push_str(&format!(
        "<w:p><w:pPr>{}</w:pPr></w:p>\n",
        section_properties(false)
    ));

    for (index, section) in book.sections().iter().enumerate() {
        // The section break already starts the body on a new page.
        body.pending_break = index > 0;
        match section {
            Section::Act { title } => {
                let runs = [Run {
                    text: title.clone(),
                    ..Run::default()
                }];
                body.paragraph(Some("Heading1"), Align::Center, 0, false, &runs);
            }
            Section::Chapter {
                title,
                show_title,
                blocks,
            } => {
                if *show_title {
                    let runs = [Run {
                        text: title.clone(),
                        ..Run::default()
                    }];
                    let style = if has_acts { "Heading2" } else { "Heading1" };
                    body.paragraph(Some(style), Align::Center, 0, false, &runs);
                }
                let mut first = true;
                body.blocks(blocks, false, &mut first);
                if body.pending_break {
                    // An empty chapter without a title still owns its page.
                    body.paragraph(None, Align::Left, 0, false, &[]);
                }
            }
        }
    }
    let document = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<w:document xmlns:w=\"{W_NS}\" xmlns:r=\"{R_NS}\" xmlns:wp=\"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing\" xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:pic=\"http://schemas.openxmlformats.org/drawingml/2006/picture\">\n<w:body>\n{}{}</w:body>\n</w:document>\n",
        body.out,
        section_properties(true)
    );
    (document, body.rels)
}

fn styles_xml(book: &Book<'_>) -> String {
    let cjk = book.language.is_cjk();
    let fonts = fonts(book.language);
    let latin_lang = match book.language {
        Language::Latin(tag) => tag,
        _ => "en-US",
    };
    let first_line = if cjk {
        "<w:ind w:firstLineChars=\"200\" w:firstLine=\"480\"/>"
    } else {
        "<w:ind w:firstLine=\"360\"/>"
    };
    let line = if cjk { 360 } else { 336 };
    let heading = |id: &str, level: u8, size: u32, before: u32, after: u32, center: bool| {
        format!(
            "<w:style w:type=\"paragraph\" w:styleId=\"{id}\"><w:name w:val=\"heading {level}\"/><w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:uiPriority w:val=\"9\"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before=\"{before}\" w:after=\"{after}\"/><w:ind w:firstLineChars=\"0\" w:firstLine=\"0\"/>{}<w:outlineLvl w:val=\"{}\"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val=\"{size}\"/><w:szCs w:val=\"{size}\"/></w:rPr></w:style>\n",
            if center { "<w:jc w:val=\"center\"/>" } else { "" },
            level - 1
        )
    };
    let has_acts = book.has_acts();
    // The two structural levels (act/chapter, or chapter alone) are centred
    // display titles; prose headings below them are smaller.
    let mut headings = String::new();
    let sizes: [(u32, u32, u32, bool); 5] = if has_acts {
        [
            (44, 4800, 600, true),
            (36, 1200, 720, true),
            (28, 480, 240, true),
            (24, 360, 120, false),
            (24, 240, 120, false),
        ]
    } else {
        [
            (36, 1200, 720, true),
            (28, 480, 240, true),
            (24, 360, 120, false),
            (24, 240, 120, false),
            (24, 240, 120, false),
        ]
    };
    for (index, (size, before, after, center)) in sizes.into_iter().enumerate() {
        let level = index as u8 + 1;
        headings.push_str(&heading(
            &format!("Heading{level}"),
            level,
            size,
            before,
            after,
            center,
        ));
    }
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<w:styles xmlns:w=\"{W_NS}\">\n<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii=\"{latin}\" w:hAnsi=\"{latin}\" w:eastAsia=\"{east}\" w:cs=\"{latin}\"/><w:sz w:val=\"24\"/><w:szCs w:val=\"24\"/><w:lang w:val=\"{latin_lang}\" w:eastAsia=\"{east_lang}\" w:bidi=\"ar-SA\"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after=\"0\" w:line=\"{line}\" w:lineRule=\"auto\"/></w:pPr></w:pPrDefault></w:docDefaults>\n<w:style w:type=\"paragraph\" w:default=\"1\" w:styleId=\"Normal\"><w:name w:val=\"Normal\"/><w:qFormat/><w:pPr><w:widowControl/>{first_line}<w:jc w:val=\"both\"/></w:pPr></w:style>\n<w:style w:type=\"character\" w:default=\"1\" w:styleId=\"DefaultParagraphFont\"><w:name w:val=\"Default Paragraph Font\"/><w:uiPriority w:val=\"1\"/><w:semiHidden/><w:unhideWhenUsed/></w:style>\n<w:style w:type=\"paragraph\" w:styleId=\"Title\"><w:name w:val=\"Title\"/><w:basedOn w:val=\"Normal\"/><w:next w:val=\"Subtitle\"/><w:uiPriority w:val=\"10\"/><w:qFormat/><w:pPr><w:spacing w:before=\"3600\" w:after=\"600\"/><w:ind w:firstLineChars=\"0\" w:firstLine=\"0\"/><w:jc w:val=\"center\"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val=\"52\"/><w:szCs w:val=\"52\"/></w:rPr></w:style>\n<w:style w:type=\"paragraph\" w:styleId=\"Subtitle\"><w:name w:val=\"Subtitle\"/><w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:uiPriority w:val=\"11\"/><w:qFormat/><w:pPr><w:ind w:firstLineChars=\"0\" w:firstLine=\"0\"/><w:jc w:val=\"center\"/></w:pPr><w:rPr><w:sz w:val=\"30\"/><w:szCs w:val=\"30\"/></w:rPr></w:style>\n{headings}<w:style w:type=\"paragraph\" w:styleId=\"Quote\"><w:name w:val=\"Quote\"/><w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:uiPriority w:val=\"29\"/><w:qFormat/><w:pPr><w:spacing w:before=\"120\" w:after=\"120\"/><w:ind w:left=\"720\" w:right=\"720\"/></w:pPr></w:style>\n<w:style w:type=\"paragraph\" w:customStyle=\"1\" w:styleId=\"SceneBreak\"><w:name w:val=\"Scene Break\"/><w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before=\"240\" w:after=\"240\"/><w:ind w:firstLineChars=\"0\" w:firstLine=\"0\"/><w:jc w:val=\"center\"/></w:pPr></w:style>\n<w:style w:type=\"paragraph\" w:styleId=\"Footer\"><w:name w:val=\"footer\"/><w:basedOn w:val=\"Normal\"/><w:uiPriority w:val=\"99\"/><w:unhideWhenUsed/><w:pPr><w:ind w:firstLineChars=\"0\" w:firstLine=\"0\"/><w:jc w:val=\"center\"/></w:pPr><w:rPr><w:sz w:val=\"18\"/><w:szCs w:val=\"18\"/></w:rPr></w:style>\n<w:style w:type=\"character\" w:styleId=\"Hyperlink\"><w:name w:val=\"Hyperlink\"/><w:basedOn w:val=\"DefaultParagraphFont\"/><w:uiPriority w:val=\"99\"/><w:unhideWhenUsed/><w:rPr><w:color w:val=\"0563C1\"/><w:u w:val=\"single\"/></w:rPr></w:style>\n</w:styles>\n",
        latin = fonts.latin,
        east = fonts.east_asia,
        east_lang = fonts.east_asia_lang,
    )
}

fn settings_xml(book: &Book<'_>) -> String {
    let fonts = fonts(book.language);
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<w:settings xmlns:w=\"{W_NS}\"><w:zoom w:percent=\"100\"/><w:defaultTabStop w:val=\"420\"/><w:characterSpacingControl w:val=\"compressPunctuation\"/><w:compat><w:compatSetting w:name=\"compatibilityMode\" w:uri=\"http://schemas.microsoft.com/office/word\" w:val=\"15\"/></w:compat><w:themeFontLang w:val=\"{}\" w:eastAsia=\"{}\"/></w:settings>\n",
        match book.language {
            Language::Latin(tag) => tag,
            _ => "en-US",
        },
        fonts.east_asia_lang
    )
}

pub(crate) fn write(book: &Book<'_>) -> Result<Vec<u8>, String> {
    let (document, rels) = document_xml(book);
    let mut document_rels = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"{REL_NS}\">\n<Relationship Id=\"rIdStyles\" Type=\"{DOC_REL}/styles\" Target=\"styles.xml\"/>\n<Relationship Id=\"rIdSettings\" Type=\"{DOC_REL}/settings\" Target=\"settings.xml\"/>\n<Relationship Id=\"rIdFooter\" Type=\"{DOC_REL}/footer\" Target=\"footer1.xml\"/>\n"
    );
    if let Some(cover) = &book.cover {
        document_rels.push_str(&format!(
            "<Relationship Id=\"rIdCover\" Type=\"{DOC_REL}/image\" Target=\"media/cover.{}\"/>\n",
            cover.extension()
        ));
    }
    for (id, target) in &rels.hyperlinks {
        document_rels.push_str(&format!(
            "<Relationship Id=\"{id}\" Type=\"{DOC_REL}/hyperlink\" Target=\"{}\" TargetMode=\"External\"/>\n",
            xml(target)
        ));
    }
    document_rels.push_str("</Relationships>\n");

    let mut content_types = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\n<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\n<Default Extension=\"xml\" ContentType=\"application/xml\"/>\n",
    );
    if let Some(cover) = &book.cover {
        content_types.push_str(&format!(
            "<Default Extension=\"{}\" ContentType=\"{}\"/>\n",
            cover.extension(),
            cover.media_type()
        ));
    }
    content_types.push_str("<Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>\n<Override PartName=\"/word/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml\"/>\n<Override PartName=\"/word/settings.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml\"/>\n<Override PartName=\"/word/footer1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml\"/>\n<Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/>\n<Override PartName=\"/docProps/app.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.extended-properties+xml\"/>\n</Types>\n");

    let package_rels = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"{REL_NS}\">\n<Relationship Id=\"rId1\" Type=\"{DOC_REL}/officeDocument\" Target=\"word/document.xml\"/>\n<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties\" Target=\"docProps/core.xml\"/>\n<Relationship Id=\"rId3\" Type=\"{DOC_REL}/extended-properties\" Target=\"docProps/app.xml\"/>\n</Relationships>\n"
    );
    let modified = book.modified.iso();
    let mut core = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:dcterms=\"http://purl.org/dc/terms/\" xmlns:dcmitype=\"http://purl.org/dc/dcmitype/\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\"><dc:title>{}</dc:title>",
        xml(book.title())
    );
    if !book.author().is_empty() {
        core.push_str(&format!("<dc:creator>{}</dc:creator>", xml(book.author())));
    }
    core.push_str(&format!(
        "<dc:language>{}</dc:language><dcterms:created xsi:type=\"dcterms:W3CDTF\">{modified}</dcterms:created><dcterms:modified xsi:type=\"dcterms:W3CDTF\">{modified}</dcterms:modified></cp:coreProperties>\n",
        book.language.tag()
    ));
    let app = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Properties xmlns=\"http://schemas.openxmlformats.org/officeDocument/2006/extended-properties\"><Application>Drifting</Application></Properties>\n";
    let footer = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<w:ftr xmlns:w=\"{W_NS}\" xmlns:r=\"{R_NS}\"><w:p><w:pPr><w:pStyle w:val=\"Footer\"/></w:pPr><w:fldSimple w:instr=\" PAGE \"><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p></w:ftr>\n"
    );

    let time = book.modified.zip_time();
    let deflated = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .compression_level(Some(6))
        .last_modified_time(time);
    let stored = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .last_modified_time(time);
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let mut put = |path: &str, bytes: &[u8], options: SimpleFileOptions| -> Result<(), String> {
        zip.start_file(path, options)
            .map_err(|error| error.to_string())?;
        zip.write_all(bytes).map_err(|error| error.to_string())
    };
    put("[Content_Types].xml", content_types.as_bytes(), deflated)?;
    put("_rels/.rels", package_rels.as_bytes(), deflated)?;
    put("docProps/core.xml", core.as_bytes(), deflated)?;
    put("docProps/app.xml", app.as_bytes(), deflated)?;
    put("word/document.xml", document.as_bytes(), deflated)?;
    put(
        "word/_rels/document.xml.rels",
        document_rels.as_bytes(),
        deflated,
    )?;
    put("word/styles.xml", styles_xml(book).as_bytes(), deflated)?;
    put("word/settings.xml", settings_xml(book).as_bytes(), deflated)?;
    put("word/footer1.xml", footer.as_bytes(), deflated)?;
    if let Some(cover) = &book.cover {
        put(
            &format!("word/media/cover.{}", cover.extension()),
            &cover.bytes,
            stored,
        )?;
    }
    drop(put);
    Ok(zip
        .finish()
        .map_err(|error| error.to_string())?
        .into_inner())
}
