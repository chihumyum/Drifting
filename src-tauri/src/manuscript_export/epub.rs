//! EPUB 3 package with a navigation document, an NCX for EPUB 2 readers, one
//! XHTML file per act and chapter, and an optional cover image.
use std::io::{Cursor, Write};

use zip::write::SimpleFileOptions;
use zip::CompressionMethod;

use super::text::{book_uuid, xml};
use super::{Align, Block, Book, Run, Section};

const XHTML_HEAD: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE html>\n";

struct Document {
    id: String,
    href: String,
    body: String,
}

/// One entry of the table of contents: an act with its chapters, or a chapter.
struct NavEntry {
    title: String,
    href: String,
    children: Vec<NavEntry>,
}

fn html_open(book: &Book<'_>, title: &str, css: &str) -> String {
    let lang = book.language.tag();
    format!(
        "{XHTML_HEAD}<html xmlns=\"http://www.w3.org/1999/xhtml\" xmlns:epub=\"http://www.idpf.org/2007/ops\" lang=\"{lang}\" xml:lang=\"{lang}\">\n<head>\n<meta charset=\"utf-8\"/>\n<title>{}</title>\n<link rel=\"stylesheet\" type=\"text/css\" href=\"{css}\"/>\n</head>\n",
        xml(title)
    )
}

fn runs_html(runs: &[Run], out: &mut String) {
    for run in runs {
        let mut open = String::new();
        let mut close = Vec::new();
        if let Some(href) = &run.href {
            open.push_str(&format!("<a href=\"{}\">", xml(href.trim())));
            close.push("</a>");
        }
        for (on, tag) in [
            (run.bold, "strong"),
            (run.italic, "em"),
            (run.underline, "u"),
            (run.strike, "s"),
        ] {
            if on {
                open.push_str(&format!("<{tag}>"));
                close.push(match tag {
                    "strong" => "</strong>",
                    "em" => "</em>",
                    "u" => "</u>",
                    _ => "</s>",
                });
            }
        }
        out.push_str(&open);
        for (index, line) in run.text.split('\n').enumerate() {
            if index > 0 {
                out.push_str("<br/>");
            }
            out.push_str(&xml(line));
        }
        for tag in close.iter().rev() {
            out.push_str(tag);
        }
    }
}

fn classes(align: Align, indent: u8, first: bool, extra: &str) -> String {
    let mut list: Vec<String> = Vec::new();
    if !extra.is_empty() {
        list.push(extra.into());
    }
    if first {
        list.push("first".into());
    }
    match align {
        Align::Justify => {}
        Align::Left => list.push("left".into()),
        Align::Center => list.push("center".into()),
        Align::Right => list.push("right".into()),
    }
    if indent > 0 {
        list.push(format!("indent-{indent}"));
    }
    if list.is_empty() {
        String::new()
    } else {
        format!(" class=\"{}\"", list.join(" "))
    }
}

/// `first` carries whether the next paragraph opens a run of prose.
fn blocks_html(blocks: &[Block], heading_base: u8, first: &mut bool, out: &mut String) {
    for block in blocks {
        match block {
            Block::Heading { level, runs, align } => {
                let tag = (heading_base + level).min(6);
                let role = ["scene", "beat", "note"][(*level as usize).clamp(1, 3) - 1];
                out.push_str(&format!("<h{tag}{}>", classes(*align, 0, false, role)));
                runs_html(runs, out);
                out.push_str(&format!("</h{tag}>\n"));
                *first = true;
            }
            Block::Paragraph {
                runs,
                align,
                indent,
            } => {
                let empty = runs.iter().all(|run| run.text.is_empty());
                if empty {
                    out.push_str("<p class=\"blank\">&#160;</p>\n");
                    continue;
                }
                out.push_str(&format!("<p{}>", classes(*align, *indent, *first, "")));
                runs_html(runs, out);
                out.push_str("</p>\n");
                *first = false;
            }
            Block::Quote { blocks } => {
                out.push_str("<blockquote>\n");
                let mut inner_first = true;
                blocks_html(blocks, heading_base, &mut inner_first, out);
                out.push_str("</blockquote>\n");
                *first = true;
            }
            Block::Break => {
                out.push_str("<hr class=\"scene-break\"/>\n");
                *first = true;
            }
        }
    }
}

fn stylesheet(book: &Book<'_>) -> String {
    let mut css = String::from(
        "@charset \"UTF-8\";\n\
         html, body { margin: 0; padding: 0; }\n\
         body { margin: 0 5%; font-family: serif; text-align: justify; widows: 2; orphans: 2; }\n\
         p { margin: 0; }\n\
         p.blank { text-indent: 0; }\n\
         p.left { text-align: left; } p.center { text-align: center; text-indent: 0; } p.right { text-align: right; text-indent: 0; }\n\
         h1, h2, h3, h4, h5, h6 { font-weight: bold; line-height: 1.4; text-indent: 0; page-break-after: avoid; break-after: avoid; }\n\
         .center { text-align: center; } .right { text-align: right; }\n\
         .part-title { margin: 30% 0 0; font-size: 1.6em; text-align: center; }\n\
         .chapter-title { margin: 2.5em 0 2em; font-size: 1.4em; text-align: center; }\n\
         .scene { margin: 1.6em 0 0.8em; font-size: 1.1em; text-align: center; }\n\
         .beat { margin: 1.2em 0 0.6em; font-size: 1em; }\n\
         .note { margin: 1em 0 0.5em; font-size: 0.95em; }\n\
         blockquote { margin: 0.8em 2em; }\n\
         hr.scene-break { width: 20%; margin: 1.5em auto; border: none; border-top: 1px solid currentColor; }\n\
         .titlepage { margin-top: 30%; text-align: center; }\n\
         .titlepage .book-title { font-size: 1.8em; margin: 0 0 1.2em; }\n\
         .titlepage .book-author { font-size: 1.1em; text-indent: 0; text-align: center; }\n\
         .cover { margin: 0; padding: 0; text-align: center; }\n\
         .cover img { max-width: 100%; max-height: 100%; }\n\
         nav ol { list-style: none; padding-left: 0; } nav ol ol { padding-left: 1.5em; }\n\
         nav h1 { text-align: center; font-size: 1.4em; }\n",
    );
    for level in 1..=8 {
        css.push_str(&format!(
            ".indent-{level} {{ margin-left: {}em; }}\n",
            level * 2
        ));
    }
    if book.language.is_cjk() {
        css.push_str(
            "body { line-height: 1.8; line-break: strict; word-break: normal; }\n\
             p { text-indent: 2em; }\n",
        );
    } else {
        css.push_str(
            "body { line-height: 1.5; hyphens: auto; -webkit-hyphens: auto; }\n\
             p { text-indent: 1.5em; }\n\
             p.first { text-indent: 0; }\n",
        );
    }
    css
}

fn nav_list(entries: &[NavEntry], out: &mut String) {
    out.push_str("<ol>\n");
    for entry in entries {
        out.push_str(&format!(
            "<li><a href=\"{}\">{}</a>",
            entry.href,
            xml(&entry.title)
        ));
        if !entry.children.is_empty() {
            out.push('\n');
            nav_list(&entry.children, out);
        }
        out.push_str("</li>\n");
    }
    out.push_str("</ol>\n");
}

fn ncx_points(entries: &[NavEntry], order: &mut usize, out: &mut String) {
    for entry in entries {
        *order += 1;
        out.push_str(&format!(
            "<navPoint id=\"nav-{0}\" playOrder=\"{0}\"><navLabel><text>{1}</text></navLabel><content src=\"{2}\"/>\n",
            order,
            xml(&entry.title),
            entry.href
        ));
        ncx_points(&entry.children, order, out);
        out.push_str("</navPoint>\n");
    }
}

pub(crate) fn write(book: &Book<'_>) -> Result<Vec<u8>, String> {
    let has_acts = book.has_acts();
    let heading_base = if has_acts { 2 } else { 1 };
    let uuid = book_uuid(&book.source.identifier);
    let title = book.title();
    let author = book.author();
    let lang = book.language;
    let mut documents: Vec<Document> = Vec::new();

    if let Some(cover) = &book.cover {
        let mut body = html_open(book, lang.cover_label(), "../styles/book.css");
        body.push_str(&format!(
            "<body class=\"cover\">\n<section epub:type=\"cover\" class=\"cover\">\n<img role=\"doc-cover\" src=\"../images/cover.{}\" alt=\"{}\"/>\n</section>\n</body>\n</html>\n",
            cover.extension(),
            xml(title)
        ));
        documents.push(Document {
            id: "cover".into(),
            href: "text/cover.xhtml".into(),
            body,
        });
    }

    let mut title_page = html_open(book, title, "../styles/book.css");
    title_page.push_str(&format!(
        "<body>\n<section epub:type=\"titlepage\" class=\"titlepage\">\n<h1 class=\"book-title\">{}</h1>\n",
        xml(title)
    ));
    if !author.is_empty() {
        title_page.push_str(&format!("<p class=\"book-author\">{}</p>\n", xml(author)));
    }
    title_page.push_str("</section>\n</body>\n</html>\n");
    documents.push(Document {
        id: "title-page".into(),
        href: "text/title.xhtml".into(),
        body: title_page,
    });

    let mut nav: Vec<NavEntry> = Vec::new();
    let mut in_act = false;
    for (index, section) in book.sections().iter().enumerate() {
        let id = format!("s{:04}", index + 1);
        let href = format!("text/{id}.xhtml");
        match section {
            Section::Act { title: act } => {
                let mut body = html_open(book, act, "../styles/book.css");
                body.push_str(&format!(
                    "<body>\n<section epub:type=\"part\" role=\"doc-part\">\n<h1 class=\"part-title\">{}</h1>\n</section>\n</body>\n</html>\n",
                    xml(act)
                ));
                documents.push(Document {
                    id,
                    href: href.clone(),
                    body,
                });
                nav.push(NavEntry {
                    title: act.clone(),
                    href,
                    children: Vec::new(),
                });
                in_act = true;
            }
            Section::Chapter {
                title: chapter,
                show_title,
                blocks,
            } => {
                let mut body = html_open(book, chapter, "../styles/book.css");
                if *show_title {
                    body.push_str(&format!(
                        "<body>\n<section epub:type=\"chapter\" role=\"doc-chapter\">\n<h{0} class=\"chapter-title\">{1}</h{0}>\n",
                        heading_base,
                        xml(chapter)
                    ));
                } else {
                    body.push_str(&format!(
                        "<body>\n<section epub:type=\"chapter\" role=\"doc-chapter\" aria-label=\"{}\">\n",
                        xml(chapter)
                    ));
                }
                let mut first = true;
                blocks_html(blocks, heading_base, &mut first, &mut body);
                body.push_str("</section>\n</body>\n</html>\n");
                documents.push(Document {
                    id,
                    href: href.clone(),
                    body,
                });
                let entry = NavEntry {
                    title: chapter.clone(),
                    href,
                    children: Vec::new(),
                };
                match nav.last_mut() {
                    Some(act) if in_act => act.children.push(entry),
                    _ => nav.push(entry),
                }
            }
        }
    }
    let first_body = documents
        .iter()
        .find(|document| document.id.starts_with('s'))
        .map(|document| document.href.clone())
        .unwrap_or_else(|| "text/title.xhtml".into());

    let mut nav_doc = html_open(book, lang.contents_label(), "styles/book.css");
    nav_doc.push_str(&format!(
        "<body>\n<nav epub:type=\"toc\" id=\"toc\" role=\"doc-toc\">\n<h1>{}</h1>\n",
        xml(lang.contents_label())
    ));
    nav_list(&nav, &mut nav_doc);
    nav_doc.push_str("</nav>\n<nav epub:type=\"landmarks\" hidden=\"hidden\">\n<ol>\n");
    if book.cover.is_some() {
        nav_doc.push_str(&format!(
            "<li><a epub:type=\"cover\" href=\"text/cover.xhtml\">{}</a></li>\n",
            xml(lang.cover_label())
        ));
    }
    nav_doc.push_str(&format!(
        "<li><a epub:type=\"toc\" href=\"#toc\">{}</a></li>\n<li><a epub:type=\"bodymatter\" href=\"{}\">{}</a></li>\n</ol>\n</nav>\n</body>\n</html>\n",
        xml(lang.contents_label()),
        first_body,
        xml(title)
    ));

    let mut ncx = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<ncx xmlns=\"http://www.daisy.org/z3986/2005/ncx/\" version=\"2005-1\" xml:lang=\"{}\">\n<head>\n<meta name=\"dtb:uid\" content=\"urn:uuid:{uuid}\"/>\n<meta name=\"dtb:depth\" content=\"{}\"/>\n<meta name=\"dtb:totalPageCount\" content=\"0\"/>\n<meta name=\"dtb:maxPageNumber\" content=\"0\"/>\n</head>\n<docTitle><text>{}</text></docTitle>\n<navMap>\n",
        lang.tag(),
        if has_acts { 2 } else { 1 },
        xml(title)
    );
    let mut order = 0;
    ncx_points(&nav, &mut order, &mut ncx);
    ncx.push_str("</navMap>\n</ncx>\n");

    let mut opf = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<package xmlns=\"http://www.idpf.org/2007/opf\" version=\"3.0\" unique-identifier=\"book-id\" xml:lang=\"{0}\">\n<metadata xmlns:dc=\"http://purl.org/dc/elements/1.1/\">\n<dc:identifier id=\"book-id\">urn:uuid:{uuid}</dc:identifier>\n<dc:title>{1}</dc:title>\n<dc:language>{0}</dc:language>\n",
        lang.tag(),
        xml(title)
    );
    if !author.is_empty() {
        opf.push_str(&format!("<dc:creator>{}</dc:creator>\n", xml(author)));
    }
    opf.push_str(&format!(
        "<meta property=\"dcterms:modified\">{}</meta>\n",
        book.modified.iso()
    ));
    if book.cover.is_some() {
        opf.push_str("<meta name=\"cover\" content=\"cover-image\"/>\n");
    }
    opf.push_str("</metadata>\n<manifest>\n<item id=\"nav\" href=\"nav.xhtml\" media-type=\"application/xhtml+xml\" properties=\"nav\"/>\n<item id=\"ncx\" href=\"toc.ncx\" media-type=\"application/x-dtbncx+xml\"/>\n<item id=\"css\" href=\"styles/book.css\" media-type=\"text/css\"/>\n");
    if let Some(cover) = &book.cover {
        opf.push_str(&format!(
            "<item id=\"cover-image\" href=\"images/cover.{}\" media-type=\"{}\" properties=\"cover-image\"/>\n",
            cover.extension(),
            cover.media_type()
        ));
    }
    for document in &documents {
        opf.push_str(&format!(
            "<item id=\"{}\" href=\"{}\" media-type=\"application/xhtml+xml\"/>\n",
            document.id, document.href
        ));
    }
    opf.push_str("</manifest>\n<spine toc=\"ncx\">\n");
    for document in &documents {
        opf.push_str(&format!("<itemref idref=\"{}\"/>\n", document.id));
        if document.id == "title-page" {
            opf.push_str("<itemref idref=\"nav\"/>\n");
        }
    }
    opf.push_str("</spine>\n</package>\n");

    let container = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<container version=\"1.0\" xmlns=\"urn:oasis:names:tc:opendocument:xmlns:container\">\n<rootfiles>\n<rootfile full-path=\"OEBPS/content.opf\" media-type=\"application/oebps-package+xml\"/>\n</rootfiles>\n</container>\n";

    let time = book.modified.zip_time();
    let stored = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .last_modified_time(time);
    let deflated = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .compression_level(Some(6))
        .last_modified_time(time);
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let mut put = |path: &str, bytes: &[u8], options: SimpleFileOptions| -> Result<(), String> {
        zip.start_file(path, options)
            .map_err(|error| error.to_string())?;
        zip.write_all(bytes).map_err(|error| error.to_string())
    };
    // The OCF container requires an uncompressed `mimetype` as the first entry.
    put("mimetype", b"application/epub+zip", stored)?;
    put("META-INF/container.xml", container.as_bytes(), deflated)?;
    put("OEBPS/content.opf", opf.as_bytes(), deflated)?;
    put("OEBPS/nav.xhtml", nav_doc.as_bytes(), deflated)?;
    put("OEBPS/toc.ncx", ncx.as_bytes(), deflated)?;
    put(
        "OEBPS/styles/book.css",
        stylesheet(book).as_bytes(),
        deflated,
    )?;
    if let Some(cover) = &book.cover {
        put(
            &format!("OEBPS/images/cover.{}", cover.extension()),
            &cover.bytes,
            stored,
        )?;
    }
    for document in &documents {
        put(
            &format!("OEBPS/{}", document.href),
            document.body.as_bytes(),
            deflated,
        )?;
    }
    drop(put);
    Ok(zip
        .finish()
        .map_err(|error| error.to_string())?
        .into_inner())
}
