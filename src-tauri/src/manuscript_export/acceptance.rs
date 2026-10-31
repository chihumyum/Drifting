//! Format checks on the synthetic sample book. The fixture is the renderer
//! converter's own output (kept equal by
//! `manuscript-export.acceptance.test.ts`); the cover is generated here.
use std::collections::{BTreeSet, HashMap};
use std::io::{Cursor, Read};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use image::{codecs::jpeg::JpegEncoder, Rgb, RgbImage};

use super::*;

pub(crate) const SAMPLE: &str = include_str!("fixtures/sample-manuscript.json");

/// Acts and chapters of the sample, in reading order.
const ORDER: [&str; 6] = [
    "序章　灯下",
    "第一卷　潮起",
    "第一章　来信",
    "第二章　旧港",
    "第二卷　雾散",
    "第三章　返航",
];

pub(crate) fn sample_cover() -> Cover {
    let mut image = RgbImage::new(600, 900);
    for (x, y, pixel) in image.enumerate_pixels_mut() {
        let band = if (380..520).contains(&y) { 40 } else { 0 };
        *pixel = Rgb([
            (30 + y / 6) as u8,
            (60 + x / 8) as u8,
            (110 + band + y / 12).min(255) as u8,
        ]);
    }
    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, 85)
        .encode_image(&image)
        .unwrap();
    Cover {
        media_type: "image/jpeg".into(),
        data: BASE64_STANDARD.encode(bytes),
        width: 600,
        height: 900,
    }
}

pub(crate) fn sample() -> Manuscript {
    let mut manuscript: Manuscript = serde_json::from_str(SAMPLE).unwrap();
    manuscript.cover = Some(sample_cover());
    manuscript
}

pub(crate) struct Entry {
    pub name: String,
    pub bytes: Vec<u8>,
    pub stored: bool,
}

pub(crate) fn unzip(bytes: &[u8]) -> Vec<Entry> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    (0..archive.len())
        .map(|index| {
            let mut file = archive.by_index(index).unwrap();
            let mut content = Vec::new();
            file.read_to_end(&mut content).unwrap();
            Entry {
                name: file.name().to_string(),
                bytes: content,
                stored: file.compression() == zip::CompressionMethod::Stored,
            }
        })
        .collect()
}

fn text_of(node: roxmltree::Node<'_, '_>) -> String {
    node.descendants()
        .filter(|child| child.is_text())
        .filter_map(|child| child.text())
        .collect()
}

fn resolve(base: &str, href: &str) -> String {
    let href = href.split('#').next().unwrap_or("");
    let mut parts: Vec<&str> = base.split('/').collect();
    parts.pop();
    for segment in href.split('/') {
        match segment {
            ".." => {
                parts.pop();
            }
            "." | "" => {}
            other => parts.push(other),
        }
    }
    parts.join("/")
}

const OPF_NS: &str = "http://www.idpf.org/2007/opf";
const DC_NS: &str = "http://purl.org/dc/elements/1.1/";
const XHTML_NS: &str = "http://www.w3.org/1999/xhtml";
const EPUB_NS: &str = "http://www.idpf.org/2007/ops";
const W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/// EPUB Open Container and package rules that epubcheck reports as errors:
/// container layout, manifest/spine/nav integrity, XHTML well-formedness,
/// resolvable references and metadata. Returns the reading order.
pub(crate) fn check_epub(bytes: &[u8]) -> Vec<String> {
    // OCF: an uncompressed `mimetype` first, without an extra field.
    assert_eq!(&bytes[0..4], b"PK\x03\x04");
    assert_eq!(
        u16::from_le_bytes([bytes[8], bytes[9]]),
        0,
        "mimetype is stored"
    );
    assert_eq!(
        u16::from_le_bytes([bytes[28], bytes[29]]),
        0,
        "no extra field"
    );
    assert_eq!(&bytes[30..38], b"mimetype");
    assert_eq!(&bytes[38..58], b"application/epub+zip");
    let entries = unzip(bytes);
    assert_eq!(entries[0].name, "mimetype");
    assert!(entries[0].stored);
    let files: HashMap<&str, &Entry> = entries
        .iter()
        .map(|entry| (entry.name.as_str(), entry))
        .collect();
    assert_eq!(files.len(), entries.len(), "duplicate ZIP entries");

    let container = std::str::from_utf8(&files["META-INF/container.xml"].bytes).unwrap();
    let container = roxmltree::Document::parse(container).unwrap();
    let rootfile = container
        .descendants()
        .find(|node| node.has_tag_name("rootfile"))
        .unwrap();
    assert_eq!(
        rootfile.attribute("media-type"),
        Some("application/oebps-package+xml")
    );
    let opf_path = rootfile.attribute("full-path").unwrap();
    let opf_text = std::str::from_utf8(&files[opf_path].bytes).unwrap();
    let opf = roxmltree::Document::parse(opf_text).unwrap();
    let package = opf.root_element();
    assert!(package.has_tag_name((OPF_NS, "package")));
    assert_eq!(package.attribute("version"), Some("3.0"));
    let unique = package.attribute("unique-identifier").unwrap();
    let identifier = opf
        .descendants()
        .find(|node| {
            node.has_tag_name((DC_NS, "identifier")) && node.attribute("id") == Some(unique)
        })
        .expect("the unique identifier exists");
    let uid = identifier.text().unwrap().to_string();
    assert!(uid.starts_with("urn:uuid:"));
    let dc = |name: &str| {
        opf.descendants()
            .find(|node| node.has_tag_name((DC_NS, name)))
            .and_then(|node| node.text())
            .map(str::to_string)
    };
    assert_eq!(dc("title").as_deref(), Some("雾港来信（合成样书）"));
    assert_eq!(dc("creator").as_deref(), Some("合成作者"));
    assert_eq!(dc("language").as_deref(), Some("zh-CN"));
    let modified = opf
        .descendants()
        .find(|node| node.attribute("property") == Some("dcterms:modified"))
        .and_then(|node| node.text())
        .unwrap();
    assert_eq!(modified, "2026-10-31T08:00:00Z");

    let mut ids = BTreeSet::new();
    let mut manifest: HashMap<String, (String, String, String)> = HashMap::new();
    for item in opf
        .descendants()
        .filter(|node| node.has_tag_name((OPF_NS, "item")))
    {
        let id = item.attribute("id").unwrap().to_string();
        assert!(ids.insert(id.clone()), "duplicate manifest id {id}");
        let path = resolve(opf_path, item.attribute("href").unwrap());
        assert!(
            files.contains_key(path.as_str()),
            "manifest item {path} is missing"
        );
        manifest.insert(
            id,
            (
                path,
                item.attribute("media-type").unwrap().to_string(),
                item.attribute("properties").unwrap_or("").to_string(),
            ),
        );
    }
    let declared: BTreeSet<&str> = manifest
        .values()
        .map(|(path, _, _)| path.as_str())
        .collect();
    for entry in &entries {
        if !matches!(entry.name.as_str(), "mimetype" | "META-INF/container.xml")
            && entry.name != opf_path
        {
            assert!(
                declared.contains(entry.name.as_str()),
                "{} is not in the manifest",
                entry.name
            );
        }
    }
    let navs: Vec<_> = manifest
        .values()
        .filter(|(_, _, properties)| properties.split(' ').any(|p| p == "nav"))
        .collect();
    assert_eq!(navs.len(), 1, "exactly one navigation document");
    let (cover_path, cover_type, _) = manifest
        .values()
        .find(|(_, _, properties)| properties.contains("cover-image"))
        .expect("a cover image");
    assert_eq!(cover_type, "image/jpeg");
    assert_eq!(&files[cover_path.as_str()].bytes[0..3], &[0xff, 0xd8, 0xff]);

    let spine = opf
        .descendants()
        .find(|node| node.has_tag_name((OPF_NS, "spine")))
        .unwrap();
    let ncx_id = spine.attribute("toc").unwrap();
    assert_eq!(manifest[ncx_id].1, "application/x-dtbncx+xml");
    let reading: Vec<String> = spine
        .children()
        .filter(|node| node.has_tag_name((OPF_NS, "itemref")))
        .map(|node| manifest[node.attribute("idref").unwrap()].0.clone())
        .collect();

    // Every XHTML document is well-formed, in the XHTML namespace, carries a
    // language and only references files that exist.
    for (path, media_type, _) in manifest.values() {
        if media_type != "application/xhtml+xml" {
            continue;
        }
        let source = std::str::from_utf8(&files[path.as_str()].bytes).unwrap();
        let document = roxmltree::Document::parse_with_options(
            source,
            roxmltree::ParsingOptions {
                allow_dtd: true,
                ..Default::default()
            },
        )
        .unwrap_or_else(|error| panic!("{path}: {error}"));
        let html = document.root_element();
        assert!(html.has_tag_name((XHTML_NS, "html")), "{path}");
        assert_eq!(html.attribute("lang"), Some("zh-CN"), "{path}");
        let mut element_ids = BTreeSet::new();
        for node in document.descendants().filter(|node| node.is_element()) {
            if let Some(id) = node.attribute("id") {
                assert!(
                    element_ids.insert(id.to_string()),
                    "{path}: duplicate id {id}"
                );
            }
            for attribute in ["href", "src"] {
                if let Some(reference) = node.attribute(attribute) {
                    if reference.starts_with("http")
                        || reference.starts_with("mailto:")
                        || reference.starts_with('#')
                    {
                        continue;
                    }
                    let target = resolve(path, reference);
                    assert!(
                        files.contains_key(target.as_str()),
                        "{path}: {reference} does not resolve"
                    );
                }
            }
        }
    }

    // The navigation document lists acts and chapters in reading order.
    let nav_path = &navs[0].0;
    let nav_source = std::str::from_utf8(&files[nav_path.as_str()].bytes).unwrap();
    let nav = roxmltree::Document::parse_with_options(
        nav_source,
        roxmltree::ParsingOptions {
            allow_dtd: true,
            ..Default::default()
        },
    )
    .unwrap();
    let toc = nav
        .descendants()
        .find(|node| {
            node.has_tag_name((XHTML_NS, "nav")) && node.attribute((EPUB_NS, "type")) == Some("toc")
        })
        .unwrap();
    let nav_titles: Vec<String> = toc
        .descendants()
        .filter(|node| node.has_tag_name((XHTML_NS, "a")))
        .map(text_of)
        .collect();
    assert_eq!(nav_titles, ORDER);

    // NCX for EPUB 2 readers names the same book and order.
    let ncx_source = std::str::from_utf8(&files[manifest[ncx_id].0.as_str()].bytes).unwrap();
    let ncx = roxmltree::Document::parse(ncx_source).unwrap();
    let ncx_uid = ncx
        .descendants()
        .find(|node| node.attribute("name") == Some("dtb:uid"))
        .and_then(|node| node.attribute("content"))
        .unwrap();
    assert_eq!(ncx_uid, uid);
    let orders: Vec<usize> = ncx
        .descendants()
        .filter(|node| node.has_tag_name("navPoint"))
        .map(|node| node.attribute("playOrder").unwrap().parse().unwrap())
        .collect();
    assert_eq!(orders, (1..=ORDER.len()).collect::<Vec<_>>());

    // Body documents in spine order carry the act and chapter titles.
    let mut titles = Vec::new();
    for path in &reading {
        let source = std::str::from_utf8(&files[path.as_str()].bytes).unwrap();
        if let Some(start) = source
            .find("class=\"part-title\">")
            .or_else(|| source.find("class=\"chapter-title\">"))
        {
            let rest = &source[start..];
            let open = rest.find('>').unwrap() + 1;
            let close = rest.find("</h").unwrap();
            titles.push(rest[open..close].to_string());
        }
    }
    titles
}

pub(crate) struct DocxFacts {
    pub headings: Vec<(String, String)>,
    pub text: String,
}

pub(crate) fn check_docx(bytes: &[u8]) -> DocxFacts {
    let entries = unzip(bytes);
    let files: HashMap<&str, &Entry> = entries
        .iter()
        .map(|entry| (entry.name.as_str(), entry))
        .collect();
    let xml = |name: &str| std::str::from_utf8(&files[name].bytes).unwrap().to_string();
    for entry in &entries {
        if entry.name.ends_with(".xml") || entry.name.ends_with(".rels") {
            let source = std::str::from_utf8(&entry.bytes).unwrap();
            roxmltree::Document::parse(source)
                .unwrap_or_else(|error| panic!("{}: {error}", entry.name));
        }
    }
    // Every part has a content type.
    let types_source = xml("[Content_Types].xml");
    let types = roxmltree::Document::parse(&types_source).unwrap();
    let defaults: BTreeSet<String> = types
        .descendants()
        .filter(|node| node.has_tag_name("Default"))
        .map(|node| node.attribute("Extension").unwrap().to_ascii_lowercase())
        .collect();
    let overrides: BTreeSet<String> = types
        .descendants()
        .filter(|node| node.has_tag_name("Override"))
        .map(|node| {
            node.attribute("PartName")
                .unwrap()
                .trim_start_matches('/')
                .to_string()
        })
        .collect();
    for entry in &entries {
        if entry.name == "[Content_Types].xml" {
            continue;
        }
        let extension = entry.name.rsplit('.').next().unwrap().to_ascii_lowercase();
        assert!(
            overrides.contains(&entry.name) || defaults.contains(&extension),
            "{} has no content type",
            entry.name
        );
    }
    for name in &overrides {
        assert!(
            files.contains_key(name.as_str()),
            "{name} is declared but missing"
        );
    }
    // Relationships resolve.
    let mut relations = HashMap::new();
    for (rels, base) in [
        ("_rels/.rels", ""),
        ("word/_rels/document.xml.rels", "word/"),
    ] {
        let source = xml(rels);
        let document = roxmltree::Document::parse(&source).unwrap();
        for relation in document
            .descendants()
            .filter(|node| node.has_tag_name("Relationship"))
        {
            let target = relation.attribute("Target").unwrap();
            if relation.attribute("TargetMode") == Some("External") {
                relations.insert(
                    relation.attribute("Id").unwrap().to_string(),
                    target.to_string(),
                );
                continue;
            }
            let path = format!("{base}{target}");
            assert!(
                files.contains_key(path.as_str()),
                "{rels}: {target} is missing"
            );
            relations.insert(relation.attribute("Id").unwrap().to_string(), path);
        }
    }

    let styles_source = xml("word/styles.xml");
    let styles = roxmltree::Document::parse(&styles_source).unwrap();
    for level in 1..=5 {
        let style = styles
            .descendants()
            .find(|node| {
                node.has_tag_name((W, "style"))
                    && node.attribute((W, "styleId")) == Some(&format!("Heading{level}"))
            })
            .unwrap_or_else(|| panic!("Heading{level} is defined"));
        let name = style
            .children()
            .find(|node| node.has_tag_name((W, "name")))
            .unwrap();
        assert_eq!(
            name.attribute((W, "val")),
            Some(format!("heading {level}").as_str())
        );
        let outline = style
            .descendants()
            .find(|node| node.has_tag_name((W, "outlineLvl")))
            .unwrap();
        assert_eq!(
            outline.attribute((W, "val")),
            Some((level - 1).to_string().as_str())
        );
    }

    let document_source = xml("word/document.xml");
    let document = roxmltree::Document::parse(&document_source).unwrap();
    let mut headings = Vec::new();
    let mut text = String::new();
    let mut page_breaks = 0;
    for paragraph in document
        .descendants()
        .filter(|node| node.has_tag_name((W, "p")))
    {
        let style = paragraph
            .descendants()
            .find(|node| node.has_tag_name((W, "pStyle")))
            .and_then(|node| node.attribute((W, "val")))
            .unwrap_or("Normal");
        let content: String = paragraph
            .descendants()
            .filter(|node| node.has_tag_name((W, "t")) || node.has_tag_name((W, "br")))
            .map(|node| {
                if node.has_tag_name((W, "br")) {
                    "\n".to_string()
                } else {
                    node.text().unwrap_or("").to_string()
                }
            })
            .collect();
        if paragraph
            .descendants()
            .any(|node| node.has_tag_name((W, "pageBreakBefore")))
        {
            page_breaks += 1;
        }
        if style.starts_with("Heading") || style == "Title" || style == "Subtitle" {
            headings.push((style.to_string(), content.clone()));
        }
        text.push_str(&content);
        text.push('\n');
    }
    // Cover, then each act and chapter after the first starts a page.
    assert_eq!(page_breaks, ORDER.len());
    // The cover picture is embedded.
    let blip = document
        .descendants()
        .find(|node| node.tag_name().name() == "blip")
        .expect("a picture");
    let embed = blip.attribute((R, "embed")).unwrap();
    assert_eq!(
        &files[relations[embed].as_str()].bytes[0..3],
        &[0xff, 0xd8, 0xff]
    );
    // Marked runs and the one exported link.
    let run_with = |content: &str, property: &str| {
        document.descendants().any(|node| {
            node.has_tag_name((W, "r"))
                && text_of(node) == content
                && node
                    .descendants()
                    .any(|child| child.has_tag_name((W, property)))
        })
    };
    assert!(run_with("信使", "b"));
    assert!(run_with("Drifting 2026", "i"));
    assert!(run_with("下划线", "u"));
    assert!(run_with("划掉", "strike"));
    let link = document
        .descendants()
        .find(|node| node.has_tag_name((W, "hyperlink")))
        .unwrap();
    assert_eq!(text_of(link), "雾港志");
    assert_eq!(
        relations[link.attribute((R, "id")).unwrap()],
        "https://example.com/fog-harbor"
    );
    let sections: Vec<_> = document
        .descendants()
        .filter(|node| node.has_tag_name((W, "sectPr")))
        .collect();
    assert_eq!(sections.len(), 2, "front matter and body sections");
    assert!(sections[1]
        .descendants()
        .any(|node| node.has_tag_name((W, "footerReference"))));
    assert!(sections[1]
        .descendants()
        .any(|node| node.has_tag_name((W, "pgNumType"))));
    let core = xml("docProps/core.xml");
    assert!(core.contains("<dc:title>雾港来信（合成样书）</dc:title>"));
    assert!(core.contains("<dc:creator>合成作者</dc:creator>"));
    DocxFacts { headings, text }
}

/// Uncompressed PDF object facts: header, trailer, pages, fonts, image, outline.
pub(crate) struct PdfFacts {
    pub pages: usize,
    pub fonts: Vec<String>,
}

pub(crate) fn check_pdf(bytes: &[u8]) -> PdfFacts {
    assert!(bytes.starts_with(b"%PDF-"));
    assert!(bytes
        .windows(5)
        .rev()
        .take(64)
        .any(|window| window == b"%%EOF"));
    let raw = String::from_utf8_lossy(bytes);
    // `/Key /Name` or `/Key/Name`: the name values a dictionary key takes.
    let names = |key: &str| -> Vec<String> {
        raw.match_indices(key)
            .filter_map(|(index, _)| {
                let rest = raw[index + key.len()..].trim_start();
                let name = rest.strip_prefix('/')?;
                Some(
                    name.chars()
                        .take_while(|c| !c.is_whitespace() && !matches!(c, '/' | '>' | '[' | '('))
                        .collect(),
                )
            })
            .collect()
    };
    let pages = names("/Type").iter().filter(|name| *name == "Page").count();
    let mut fonts = names("/BaseFont");
    fonts.sort();
    fonts.dedup();
    assert!(
        raw.contains("/FontFile2") || raw.contains("/FontFile3"),
        "fonts are embedded"
    );
    assert!(raw.contains("/ToUnicode"), "text maps back to Unicode");
    assert!(raw.contains("/DCTDecode"), "the JPEG cover is embedded");
    assert!(raw.contains("/Outlines"), "bookmarks exist");
    assert!(
        fonts
            .iter()
            .all(|name| name.len() > 7 && name.as_bytes()[6] == b'+'),
        "subset fonts: {fonts:?}"
    );
    PdfFacts { pages, fonts }
}

#[test]
fn epub_is_a_valid_package_with_navigation_cover_and_book_order() {
    let manuscript = sample();
    let book = prepare(&manuscript).unwrap();
    assert_eq!(book.language, Language::SimplifiedChinese);
    let bytes = render(&book, ManuscriptFormat::Epub).unwrap();
    assert_eq!(check_epub(&bytes), ORDER);
    let entries = unzip(&bytes);
    let chapter = |needle: &str| {
        entries
            .iter()
            .map(|entry| String::from_utf8_lossy(&entry.bytes).into_owned())
            .find(|source| source.contains(needle))
            .unwrap_or_else(|| panic!("{needle} is in the book"))
    };
    let first = chapter("“今夜无船。”");
    assert!(first.contains("——又展开——再折好……<br/>窗外"));
    let letters = chapter("<h3 class=\"scene\">一　雨夜</h3>");
    for fragment in [
        "<strong>信使</strong>",
        "<em>Drifting 2026</em>",
        "<u>下划线</u>",
        "<s>划掉</s>",
        "<a href=\"https://example.com/fog-harbor\">雾港志</a>",
        "<blockquote>",
        "<hr class=\"scene-break\"/>",
    ] {
        assert!(letters.contains(fragment), "{fragment}");
    }
    assert!(!entries
        .iter()
        .any(|entry| String::from_utf8_lossy(&entry.bytes).contains("drifting://")));
    let harbour = chapter("「雾散之前，不要出海。」（这句话她听过很多遍。）");
    assert!(harbour.contains("<p class=\"center\">——完——</p>"));
    assert!(harbour.contains("<p class=\"indent-1\">附：潮汐表见第三页。</p>"));
}

#[test]
fn docx_maps_the_outline_to_word_heading_styles_in_book_order() {
    let manuscript = sample();
    let book = prepare(&manuscript).unwrap();
    let facts = check_docx(&render(&book, ManuscriptFormat::Docx).unwrap());
    let headings: Vec<(&str, &str)> = facts
        .headings
        .iter()
        .map(|(style, text)| (style.as_str(), text.as_str()))
        .collect();
    assert_eq!(
        headings,
        vec![
            ("Title", "雾港来信（合成样书）"),
            ("Subtitle", "合成作者"),
            ("Heading2", "序章　灯下"),
            ("Heading1", "第一卷　潮起"),
            ("Heading2", "第一章　来信"),
            ("Heading3", "一　雨夜"),
            ("Heading3", "二　旧信"),
            ("Heading2", "第二章　旧港"),
            ("Heading1", "第二卷　雾散"),
            ("Heading2", "第三章　返航"),
        ]
    );
    assert!(facts.text.contains("“今夜无船。”"));
    assert!(facts.text.contains("——又展开——再折好……\n窗外"));
    assert!(facts
        .text
        .contains("「雾散之前，不要出海。」（这句话她听过很多遍。）"));
}

#[test]
fn docx_without_acts_or_titles_starts_chapters_at_heading_one() {
    let mut manuscript = sample();
    manuscript
        .sections
        .retain(|section| matches!(section, Section::Chapter { .. }));
    for section in &mut manuscript.sections {
        if let Section::Chapter {
            title, show_title, ..
        } = section
        {
            *show_title = title != "第一章　来信";
        }
    }
    let book = prepare(&manuscript).unwrap();
    let bytes = render(&book, ManuscriptFormat::Docx).unwrap();
    let entries = unzip(&bytes);
    let document = String::from_utf8_lossy(
        &entries
            .iter()
            .find(|e| e.name == "word/document.xml")
            .unwrap()
            .bytes,
    )
    .into_owned();
    let style_of = |needle: &str| {
        let at = document.find(needle).unwrap_or_else(|| panic!("{needle}"));
        let paragraph = &document[document[..at].rfind("<w:p>").unwrap()..at];
        paragraph
            .split("<w:pStyle w:val=\"")
            .nth(1)
            .map(|rest| rest.split('"').next().unwrap().to_string())
    };
    assert_eq!(style_of(">序章　灯下<").as_deref(), Some("Heading1"));
    assert_eq!(
        style_of(">一　雨夜<").as_deref(),
        Some("Heading2"),
        "scenes move up a level"
    );
    assert!(
        !document.contains(">第一章　来信<"),
        "a hidden chapter title stays out"
    );
}

#[test]
fn pdf_embeds_subset_fonts_cover_and_bookmarks() {
    let manuscript = sample();
    let book = prepare(&manuscript).unwrap();
    let database = pdf::system_fonts();
    match pdf::body_font_names(&book, database) {
        Ok((body, latin)) => {
            eprintln!("PDF body font {body}, Latin font {latin:?}");
        }
        Err(error) if !cfg!(target_os = "macos") => {
            eprintln!("skipping PDF layout without CJK fonts: {error}");
            return;
        }
        Err(error) => panic!("{error}"),
    }
    let bytes = render(&book, ManuscriptFormat::Pdf).unwrap();
    let facts = check_pdf(&bytes);
    // Cover, title page, contents and at least one page per act and chapter.
    assert!(facts.pages >= 3 + ORDER.len(), "{} pages", facts.pages);
    if cfg!(target_os = "macos") {
        assert!(
            facts.fonts.iter().any(|font| font.contains("Song")),
            "{:?}",
            facts.fonts
        );
    }
}

#[test]
fn pdf_lays_out_a_latin_book_with_the_latin_serif_first() {
    let mut manuscript = sample();
    manuscript.sections.retain(
        |section| matches!(section, Section::Chapter { title, .. } if title == "第三章　返航"),
    );
    if let Section::Chapter { blocks, .. } = &mut manuscript.sections[0] {
        blocks.remove(1);
    }
    manuscript.title = "Letters from the Fog Harbour".into();
    manuscript.locale = "en".into();
    let book = prepare(&manuscript).unwrap();
    assert_eq!(book.language, Language::Latin("en"));
    let database = pdf::system_fonts();
    if let Err(error) = pdf::body_font_names(&book, database) {
        assert!(!cfg!(target_os = "macos"), "{error}");
        return;
    }
    let facts = check_pdf(&render(&book, ManuscriptFormat::Pdf).unwrap());
    assert!(facts.pages >= 3);
}

#[test]
fn rejects_payloads_the_writers_cannot_honour() {
    let mut manuscript = sample();
    manuscript.cover.as_mut().unwrap().media_type = "image/png".into();
    assert!(
        prepare(&manuscript).is_err(),
        "media type must match the bytes"
    );
    let mut manuscript = sample();
    manuscript
        .sections
        .retain(|section| matches!(section, Section::Act { .. }));
    assert!(prepare(&manuscript).is_err(), "at least one chapter");
    let mut manuscript = sample();
    manuscript.modified = "yesterday".into();
    assert!(prepare(&manuscript).is_err());
    let invalid = SAMPLE.replace("https://example.com/fog-harbor", "javascript:alert(1)");
    let manuscript: Manuscript = serde_json::from_str(&invalid).unwrap();
    assert!(prepare(&manuscript).is_err(), "unsafe links are refused");
    assert!(serde_json::from_str::<Manuscript>(&SAMPLE.replacen(
        "\"title\"",
        "\"surprise\": 1, \"title\"",
        1
    ))
    .is_err());
}

/// Writes the sample in all three formats for `scripts/run-manuscript-export-acceptance.mjs`
/// (or `DRIFTING_MANUSCRIPT_PAYLOAD`, a payload captured from the dialog).
#[test]
#[ignore]
fn write_sample_outputs() {
    let directory = std::env::var("DRIFTING_MANUSCRIPT_OUT").expect("DRIFTING_MANUSCRIPT_OUT");
    // A payload captured from the app's dialog can replace the sample.
    let manuscript = match std::env::var("DRIFTING_MANUSCRIPT_PAYLOAD") {
        Ok(path) => serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap(),
        Err(_) => sample(),
    };
    let book = prepare(&manuscript).unwrap();
    for format in [
        ManuscriptFormat::Epub,
        ManuscriptFormat::Docx,
        ManuscriptFormat::Pdf,
    ] {
        let started = std::time::Instant::now();
        let bytes = render(&book, format).unwrap();
        let elapsed = started.elapsed().as_millis();
        std::fs::write(format!("{directory}/sample.{}", format.extension()), &bytes).unwrap();
        std::fs::write(
            format!("{directory}/sample.{}.ms", format.extension()),
            elapsed.to_string(),
        )
        .unwrap();
    }
    let (body, latin) = pdf::body_font_names(&book, pdf::system_fonts()).unwrap();
    std::fs::write(
        format!("{directory}/fonts.json"),
        serde_json::json!({ "body": body, "latin": latin }).to_string(),
    )
    .unwrap();
}
