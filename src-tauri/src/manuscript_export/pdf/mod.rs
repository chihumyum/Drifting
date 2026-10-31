//! A5 PDF typeset in Rust: installed fonts embedded as subsets, CJK
//! punctuation spacing and justification, a contents page with page numbers,
//! bookmarks and document metadata.
mod fonts;
mod layout;

use std::num::NonZeroU32;
use std::ops::Range;
use std::rc::Rc;

use fontdb::Database;
use krilla::action::{Action, LinkAction};
use krilla::annotation::{Annotation, LinkAnnotation, Target};
use krilla::destination::XyzDestination;
use krilla::geom::{PathBuilder, Point, Rect, Size, Transform};
use krilla::image::Image;
use krilla::metadata::{DateTime, Metadata};
use krilla::outline::{Outline, OutlineNode};
use krilla::page::{NumberingStyle, PageLabel, PageSettings};
use krilla::paint::{Fill, LineCap, LineJoin, Stroke, StrokeDash};
use krilla::text::{GlyphId, KrillaGlyph};
use krilla::Document;

pub(crate) use fonts::system_fonts;
use fonts::FontSet;
use layout::{break_lines, distribute, font_runs, FontRun, Line, Shaped, Shaper, TextStyle};

use super::text::Language;
use super::{Align, Block, Book, Run, Section};

/// A5 in points.
const PAGE_W: f32 = 419.53;
const PAGE_H: f32 = 595.28;
const TOP: f32 = 56.0;
const FOOTER_BASELINE: f32 = PAGE_H - 34.0;

/// Measures that depend on the book's script.
struct Metrics {
    body: f32,
    leading: f32,
    width: f32,
    left: f32,
    bottom: f32,
}

impl Metrics {
    fn new(cjk: bool) -> Self {
        let body = if cjk { 10.5 } else { 11.0 };
        let leading = body * if cjk { 1.75 } else { 1.42 };
        // A CJK measure is a whole number of characters.
        let width = if cjk { body * 30.0 } else { 312.0 };
        let lines = ((PAGE_H - TOP - 60.0) / leading).floor();
        Self {
            body,
            leading,
            width,
            left: (PAGE_W - width) / 2.0,
            bottom: TOP + lines * leading,
        }
    }

    fn em(&self) -> f32 {
        self.body
    }
}

/// One paragraph to typeset.
struct Para {
    text: String,
    spans: Vec<(Range<usize>, usize)>,
    runs: Vec<FontRun>,
    size: f32,
    line_height: f32,
    align: Align,
    first_indent: f32,
    left: f32,
    right: f32,
}

impl Para {
    /// The same box without text, for drawing pre-shaped lines.
    fn geometry(&self) -> Para {
        Para {
            text: String::new(),
            spans: Vec::new(),
            runs: Vec::new(),
            size: self.size,
            line_height: self.line_height,
            align: self.align,
            first_indent: self.first_indent,
            left: self.left,
            right: self.right,
        }
    }
}

/// The body as a vertical flow; pagination happens after shaping.
enum Flow {
    /// Start a page unless the current one is empty.
    NewPage,
    /// An act title alone on its page.
    Part { para: usize, anchor: usize },
    /// A chapter opening; the anchor is the chapter's bookmark.
    Chapter { anchor: usize },
    /// Vertical space, dropped at the top of a page.
    Space(f32),
    /// An empty editor paragraph: one blank line.
    Blank(f32),
    Para {
        para: usize,
        /// Lines of the next paragraph that must share this page.
        keep: usize,
        space_after: f32,
    },
}

struct Anchor {
    title: String,
    act: bool,
    toc_para: Option<usize>,
    page: usize,
    y: f32,
}

enum LinkTarget {
    Uri(String),
    Body { page: usize, y: f32 },
}

enum Op {
    Glyphs {
        x: f32,
        y: f32,
        face: usize,
        size: f32,
        glyphs: Vec<KrillaGlyph>,
        text: Rc<str>,
    },
    Rect {
        x: f32,
        y: f32,
        w: f32,
        h: f32,
    },
    Dots {
        x1: f32,
        x2: f32,
        y: f32,
    },
    Cover {
        x: f32,
        y: f32,
        w: f32,
        h: f32,
    },
}

#[derive(Default)]
struct PageOps {
    ops: Vec<Op>,
    links: Vec<(Rect, LinkTarget)>,
}

struct Builder<'a> {
    book: &'a Book<'a>,
    metrics: Metrics,
    cjk: bool,
    styles: Vec<TextStyle>,
    paras: Vec<Para>,
    flow: Vec<Flow>,
    anchors: Vec<Anchor>,
}

impl Builder<'_> {
    fn style(&mut self, style: TextStyle) -> usize {
        if let Some(index) = self.styles.iter().position(|known| known == &style) {
            return index;
        }
        self.styles.push(style);
        self.styles.len() - 1
    }

    fn para_from_runs(&mut self, runs: &[Run], size: f32, bold: bool) -> Para {
        let mut text = String::new();
        let mut spans = Vec::new();
        for run in runs {
            let piece = run.text.replace('\t', " ");
            if piece.is_empty() {
                continue;
            }
            let style = self.style(TextStyle {
                size,
                bold: bold || run.bold,
                italic: run.italic,
                underline: run.underline,
                strike: run.strike,
                href: run.href.as_ref().map(|href| href.trim().to_string()),
            });
            let start = text.len();
            text.push_str(&piece);
            spans.push((start..text.len(), style));
        }
        Para {
            text,
            spans,
            runs: Vec::new(),
            size,
            line_height: size * if self.cjk { 1.75 } else { 1.42 },
            align: Align::Justify,
            first_indent: 0.0,
            left: 0.0,
            right: 0.0,
        }
    }

    fn plain_para(
        &mut self,
        text: &str,
        style: TextStyle,
        align: Align,
        line_height: f32,
    ) -> usize {
        let size = style.size;
        let style = self.style(style);
        self.paras.push(Para {
            text: text.to_string(),
            spans: vec![(0..text.len(), style)],
            runs: Vec::new(),
            size,
            line_height,
            align,
            first_indent: 0.0,
            left: 0.0,
            right: 0.0,
        });
        self.paras.len() - 1
    }

    fn blocks(&mut self, blocks: &[Block], quote: f32, first: &mut bool) {
        let em = self.metrics.em();
        let leading = self.metrics.leading;
        for block in blocks {
            match block {
                Block::Heading { level, runs, align } => {
                    let (size, before, after, default_align) = match level {
                        1 => (if self.cjk { 12.0 } else { 12.5 }, 1.0, 0.5, Align::Center),
                        2 => (11.0, 0.75, 0.25, Align::Left),
                        _ => (self.metrics.body, 0.5, 0.25, Align::Left),
                    };
                    let mut para = self.para_from_runs(runs, size, true);
                    para.align = if *align == Align::Justify {
                        default_align
                    } else {
                        *align
                    };
                    para.line_height = size * 1.5;
                    para.left = quote;
                    self.paras.push(para);
                    self.flow.push(Flow::Space(before * leading));
                    self.flow.push(Flow::Para {
                        para: self.paras.len() - 1,
                        keep: 2,
                        space_after: after * leading,
                    });
                    self.flow.push(Flow::Space(after * leading));
                    *first = true;
                }
                Block::Paragraph {
                    runs,
                    align,
                    indent,
                } => {
                    if runs.iter().all(|run| run.text.is_empty()) {
                        self.flow.push(Flow::Blank(leading));
                        continue;
                    }
                    let mut para = self.para_from_runs(runs, self.metrics.body, false);
                    para.align = *align;
                    para.line_height = leading;
                    para.left = quote + f32::from(*indent) * 2.0 * em;
                    para.right = quote;
                    para.first_indent = match align {
                        Align::Center | Align::Right => 0.0,
                        _ if self.cjk => 2.0 * em,
                        _ if *first => 0.0,
                        _ => 1.5 * em,
                    };
                    self.paras.push(para);
                    self.flow.push(Flow::Para {
                        para: self.paras.len() - 1,
                        keep: 0,
                        space_after: 0.0,
                    });
                    *first = false;
                }
                Block::Quote { blocks } => {
                    self.flow.push(Flow::Space(0.4 * leading));
                    let mut inner = true;
                    self.blocks(blocks, quote + 2.0 * em, &mut inner);
                    self.flow.push(Flow::Space(0.4 * leading));
                    *first = true;
                }
                Block::Break => {
                    let para = self.plain_para(
                        "*    *    *",
                        TextStyle::plain(self.metrics.body),
                        Align::Center,
                        leading,
                    );
                    self.flow.push(Flow::Space(0.5 * leading));
                    self.flow.push(Flow::Para {
                        para,
                        keep: 1,
                        space_after: 0.5 * leading,
                    });
                    self.flow.push(Flow::Space(0.5 * leading));
                    *first = true;
                }
            }
        }
    }

    fn build_body(&mut self, with_toc: bool) {
        let sections = self.book.sections();
        let has_acts = self.book.has_acts();
        let toc_size = self.metrics.body;
        for section in sections {
            match section {
                Section::Act { title } => {
                    let size = if self.cjk { 20.0 } else { 22.0 };
                    let para =
                        self.plain_para(title, TextStyle::bold(size), Align::Center, size * 1.5);
                    let toc_para = with_toc.then(|| {
                        self.plain_para(
                            title,
                            TextStyle::bold(toc_size),
                            Align::Left,
                            toc_size * 1.6,
                        )
                    });
                    self.anchors.push(Anchor {
                        title: title.clone(),
                        act: true,
                        toc_para,
                        page: 0,
                        y: 0.0,
                    });
                    self.flow.push(Flow::NewPage);
                    self.flow.push(Flow::Part {
                        para,
                        anchor: self.anchors.len() - 1,
                    });
                }
                Section::Chapter {
                    title,
                    show_title,
                    blocks,
                } => {
                    let toc_para = with_toc.then(|| {
                        let para = self.plain_para(
                            title,
                            TextStyle::plain(toc_size),
                            Align::Left,
                            toc_size * 1.6,
                        );
                        if has_acts {
                            self.paras[para].left = 2.0 * toc_size;
                        }
                        para
                    });
                    self.anchors.push(Anchor {
                        title: title.clone(),
                        act: false,
                        toc_para,
                        page: 0,
                        y: 0.0,
                    });
                    self.flow.push(Flow::NewPage);
                    self.flow.push(Flow::Chapter {
                        anchor: self.anchors.len() - 1,
                    });
                    if *show_title {
                        let size = if self.cjk { 16.0 } else { 18.0 };
                        let para = self.plain_para(
                            title,
                            TextStyle::bold(size),
                            Align::Center,
                            size * 1.5,
                        );
                        self.flow.push(Flow::Space(3.0 * self.metrics.leading));
                        self.flow.push(Flow::Para {
                            para,
                            keep: 2,
                            space_after: 2.0 * self.metrics.leading,
                        });
                        self.flow.push(Flow::Space(2.0 * self.metrics.leading));
                    }
                    let mut first = true;
                    self.blocks(blocks, 0.0, &mut first);
                }
            }
        }
    }
}

/// Places shaped paragraphs onto pages.
struct Pager<'s> {
    metrics: &'s Metrics,
    fonts: &'s FontSet,
    styles: &'s [TextStyle],
    pages: Vec<PageOps>,
    page: PageOps,
    y: f32,
}

impl<'s> Pager<'s> {
    fn new(metrics: &'s Metrics, fonts: &'s FontSet, styles: &'s [TextStyle]) -> Self {
        Self {
            metrics,
            fonts,
            styles,
            pages: Vec::new(),
            page: PageOps::default(),
            y: TOP,
        }
    }

    fn at_top(&self) -> bool {
        self.y <= TOP + 0.01
    }

    fn page_is_empty(&self) -> bool {
        self.page.ops.is_empty() && self.at_top()
    }

    fn new_page(&mut self) {
        self.pages.push(std::mem::take(&mut self.page));
        self.y = TOP;
    }

    fn finish(mut self) -> Vec<PageOps> {
        if !self.page_is_empty() || self.pages.is_empty() {
            self.pages.push(std::mem::take(&mut self.page));
        }
        self.pages
    }

    fn baseline(&self, top: f32, line_height: f32, size: f32) -> f32 {
        let body = &self.fonts.faces[self.fonts.chain[0]];
        let content = (body.ascender - body.descender) * size;
        top + (line_height - content) / 2.0 + body.ascender * size
    }

    /// Draw one line whose box starts at `top`; returns nothing, positions
    /// follow from the paragraph geometry.
    fn draw_line(
        &mut self,
        shaped: &Shaped,
        para: &Para,
        line: &Line,
        first: bool,
        x0: f32,
        width: f32,
        top: f32,
    ) {
        let indent = if first { para.first_indent } else { 0.0 };
        let available = width - para.left - para.right - indent;
        let (offset, extra) = distribute(shaped, line, available, para.align);
        let baseline = self.baseline(top, para.line_height, para.size);
        let mut x = x0 + para.left + indent + offset;
        let mut index = line.start;
        while index < line.end {
            let (face, style) = (shaped.clusters[index].face, shaped.clusters[index].style);
            let start_x = x;
            let mut glyphs = Vec::new();
            let size = shaped.clusters[index].size;
            while index < line.end
                && shaped.clusters[index].face == face
                && shaped.clusters[index].style == style
            {
                let cluster = &shaped.clusters[index];
                let gap = extra[index - line.start];
                let last = cluster.glyphs.len().saturating_sub(1);
                for (position, glyph) in cluster.glyphs.iter().enumerate() {
                    let advance = glyph.advance + if position == last { gap / size } else { 0.0 };
                    glyphs.push(KrillaGlyph::new(
                        GlyphId::new(u32::from(glyph.id)),
                        advance,
                        glyph.x_offset,
                        glyph.y_offset,
                        0.0,
                        glyph.range.clone(),
                        None,
                    ));
                    x += advance * size;
                }
                index += 1;
            }
            let text_style = &self.styles[style];
            let run_width = x - start_x;
            if text_style.underline {
                self.page.ops.push(Op::Rect {
                    x: start_x,
                    y: baseline + size * 0.14,
                    w: run_width,
                    h: size * 0.05,
                });
            }
            if text_style.strike {
                self.page.ops.push(Op::Rect {
                    x: start_x,
                    y: baseline - size * 0.32,
                    w: run_width,
                    h: size * 0.05,
                });
            }
            if let Some(href) = &text_style.href {
                if let Some(rect) =
                    Rect::from_xywh(start_x, top, run_width.max(0.1), para.line_height)
                {
                    self.page.links.push((rect, LinkTarget::Uri(href.clone())));
                }
            }
            if !glyphs.is_empty() {
                self.page.ops.push(Op::Glyphs {
                    x: start_x,
                    y: baseline,
                    face,
                    size,
                    glyphs,
                    text: shaped.text.clone(),
                });
            }
        }
    }

    /// Lay out one paragraph with widow/orphan control.
    fn paragraph(&mut self, shaped: &Shaped, para: &Para, keep_height: f32) {
        let width = self.metrics.width;
        let lines = break_lines(
            shaped,
            width - para.left - para.right - para.first_indent,
            width - para.left - para.right,
        );
        let line_height = para.line_height;
        let bottom = self.metrics.bottom;
        if keep_height > 0.0
            && !self.page_is_empty()
            && self.y + lines.len() as f32 * line_height + keep_height > bottom + 0.01
        {
            self.new_page();
        }
        let mut index = 0;
        while index < lines.len() {
            let fit = (((bottom - self.y) / line_height) + 0.001).floor().max(0.0) as usize;
            let remaining = lines.len() - index;
            let mut take = remaining.min(fit);
            if take < remaining {
                if take == 0 || (index == 0 && take < 2 && !self.page_is_empty()) {
                    if self.page_is_empty() {
                        take = 1;
                    } else {
                        self.new_page();
                        continue;
                    }
                } else if remaining - take == 1 && take >= 2 {
                    take -= 1;
                }
            }
            for (offset, line) in lines[index..index + take].iter().enumerate() {
                let top = self.y;
                self.draw_line(
                    shaped,
                    para,
                    line,
                    index + offset == 0,
                    self.metrics.left,
                    width,
                    top,
                );
                self.y += line_height;
            }
            index += take;
            if index < lines.len() {
                self.new_page();
            }
        }
    }

    fn space(&mut self, height: f32) {
        if self.at_top() {
            return;
        }
        if self.y + height > self.metrics.bottom {
            self.new_page();
        } else {
            self.y += height;
        }
    }
}

fn numbers_para(text: &str, face: usize, style: usize) -> Vec<FontRun> {
    vec![FontRun {
        range: 0..text.len(),
        face,
        style,
    }]
}

pub(crate) fn write(book: &Book<'_>, database: &Database) -> Result<Vec<u8>, String> {
    let cjk = book.language.is_cjk();
    let compress = matches!(
        book.language,
        Language::SimplifiedChinese | Language::Japanese
    );
    let mut fonts = FontSet::resolve(
        database,
        book.language,
        book.source.preferred_font.as_deref(),
    )?;
    let metrics = Metrics::new(cjk);
    let mut builder = Builder {
        book,
        metrics,
        cjk,
        styles: Vec::new(),
        paras: Vec::new(),
        flow: Vec::new(),
        anchors: Vec::new(),
    };
    let with_toc = book
        .sections()
        .iter()
        .filter(|section| matches!(section, Section::Chapter { .. }))
        .count()
        > 1
        && book.sections().iter().any(|section| {
            matches!(
                section,
                Section::Chapter {
                    show_title: true,
                    ..
                }
            )
        });

    // Front matter paragraphs.
    let title_para = {
        let size = if cjk { 24.0 } else { 26.0 };
        builder.plain_para(
            book.title(),
            TextStyle::bold(size),
            Align::Center,
            size * 1.5,
        )
    };
    let author_para = (!book.author().is_empty()).then(|| {
        builder.plain_para(
            book.author(),
            TextStyle::plain(13.0),
            Align::Center,
            13.0 * 1.6,
        )
    });
    let contents_para = with_toc.then(|| {
        builder.plain_para(
            book.language.contents_label(),
            TextStyle::bold(16.0),
            Align::Center,
            24.0,
        )
    });
    builder.build_body(with_toc);
    let number_style = builder.style(TextStyle::plain(9.0));
    let toc_number_style = builder.style(TextStyle::plain(builder.metrics.body));
    let Builder {
        metrics,
        styles,
        mut paras,
        flow,
        mut anchors,
        ..
    } = builder;

    // Phase A: pick faces (mutates the font set). Phase B: shape.
    for para in &mut paras {
        para.runs = font_runs(&mut fonts, database, &para.text, &para.spans, &styles, cjk);
    }
    let number_face = fonts.face_for('0', true, cjk);
    let fonts = fonts;
    let mut shaper = Shaper::new(&fonts);
    let shaped: Vec<Shaped> = paras
        .iter()
        .map(|para| shaper.shape(&para.text, &para.runs, &styles, compress))
        .collect();

    // Body.
    let mut pager = Pager::new(&metrics, &fonts, &styles);
    for (index, item) in flow.iter().enumerate() {
        match item {
            Flow::NewPage => {
                if !pager.page_is_empty() {
                    pager.new_page();
                }
            }
            Flow::Part { para, anchor } => {
                let para_ref = &paras[*para];
                pager.y = PAGE_H * 0.36;
                anchors[*anchor].page = pager.pages.len();
                anchors[*anchor].y = pager.y;
                pager.paragraph(&shaped[*para], para_ref, 0.0);
                pager.new_page();
            }
            Flow::Chapter { anchor } => {
                anchors[*anchor].page = pager.pages.len();
                anchors[*anchor].y = pager.y;
            }
            Flow::Space(height) => pager.space(*height),
            Flow::Blank(height) => {
                if !pager.at_top() {
                    pager.space(*height);
                }
            }
            Flow::Para {
                para,
                keep,
                space_after,
            } => {
                let next_height = if *keep > 0 {
                    flow[index + 1..]
                        .iter()
                        .find_map(|next| match next {
                            Flow::Para { para, .. } => Some(paras[*para].line_height),
                            Flow::Blank(height) => Some(*height),
                            _ => None,
                        })
                        .map(|height| height * *keep as f32 + space_after)
                        .unwrap_or(0.0)
                } else {
                    0.0
                };
                pager.paragraph(&shaped[*para], &paras[*para], next_height);
            }
        }
    }
    let mut body_pages = pager.finish();

    // Page numbers in the body footer.
    for (index, page) in body_pages.iter_mut().enumerate() {
        let label = (index + 1).to_string();
        let runs = numbers_para(&label, number_face, number_style);
        let number = shaper.shape(&label, &runs, &styles, false);
        let width: f32 = number.clusters.iter().map(|cluster| cluster.width).sum();
        let line = Line {
            start: 0,
            end: number.clusters.len(),
            width,
            last: true,
        };
        let para = Para {
            text: label.clone(),
            spans: Vec::new(),
            runs: Vec::new(),
            size: 9.0,
            line_height: 12.0,
            align: Align::Center,
            first_indent: 0.0,
            left: 0.0,
            right: 0.0,
        };
        let mut footer = Pager::new(&metrics, &fonts, &styles);
        let top = FOOTER_BASELINE - footer.baseline(0.0, 12.0, 9.0);
        footer.draw_line(
            &number,
            &para,
            &line,
            true,
            metrics.left,
            metrics.width,
            top,
        );
        page.ops.append(&mut footer.page.ops);
    }

    // Front matter: cover, title page, contents.
    let mut front: Vec<PageOps> = Vec::new();
    if let Some(cover) = &book.cover {
        let (w, h) = (cover.width as f32, cover.height as f32);
        let scale = (PAGE_W / w).min(PAGE_H / h);
        let (w, h) = (w * scale, h * scale);
        front.push(PageOps {
            ops: vec![Op::Cover {
                x: (PAGE_W - w) / 2.0,
                y: (PAGE_H - h) / 2.0,
                w,
                h,
            }],
            links: Vec::new(),
        });
    }
    {
        let mut title_page = Pager::new(&metrics, &fonts, &styles);
        title_page.y = PAGE_H * 0.30;
        title_page.paragraph(&shaped[title_para], &paras[title_para], 0.0);
        if let Some(author) = author_para {
            title_page.y += 2.0 * metrics.leading;
            title_page.paragraph(&shaped[author], &paras[author], 0.0);
        }
        front.extend(title_page.finish());
    }
    let mut toc_pages: Vec<PageOps> = Vec::new();
    if let Some(contents) = contents_para {
        let mut toc = Pager::new(&metrics, &fonts, &styles);
        toc.y = TOP + metrics.leading;
        toc.paragraph(&shaped[contents], &paras[contents], 0.0);
        toc.y += metrics.leading;
        let right = metrics.left + metrics.width;
        for anchor in &anchors {
            let Some(entry) = anchor.toc_para else {
                continue;
            };
            let para = &paras[entry];
            if anchor.act && !toc.at_top() {
                toc.space(0.5 * metrics.leading);
            }
            let label = (anchor.page + 1).to_string();
            let runs = numbers_para(&label, number_face, toc_number_style);
            let number = shaper.shape(&label, &runs, &styles, false);
            let number_width: f32 = number.clusters.iter().map(|cluster| cluster.width).sum();
            let reserve = number_width + 2.5 * metrics.body;
            let narrow = Para {
                right: reserve,
                ..para.geometry()
            };
            let lines = break_lines(
                &shaped[entry],
                metrics.width - narrow.left - narrow.right,
                metrics.width - narrow.left - narrow.right,
            );
            let needed = lines.len() as f32 * para.line_height;
            if toc.y + needed > metrics.bottom {
                toc.new_page();
            }
            let entry_top = toc.y;
            let page_index = toc.pages.len();
            for (index, line) in lines.iter().enumerate() {
                let top = toc.y;
                toc.draw_line(
                    &shaped[entry],
                    &narrow,
                    line,
                    index == 0,
                    metrics.left,
                    metrics.width,
                    top,
                );
                if index + 1 == lines.len() {
                    let baseline = toc.baseline(top, para.line_height, para.size);
                    let text_end = metrics.left + narrow.left + line.width;
                    let number_x = right - number_width;
                    if number_x - text_end > metrics.body {
                        toc.page.ops.push(Op::Dots {
                            x1: text_end + 0.5 * metrics.body,
                            x2: number_x - 0.5 * metrics.body,
                            y: baseline - 0.5,
                        });
                    }
                    let number_para = Para {
                        text: String::new(),
                        spans: Vec::new(),
                        runs: Vec::new(),
                        size: para.size,
                        line_height: para.line_height,
                        align: Align::Right,
                        first_indent: 0.0,
                        left: 0.0,
                        right: 0.0,
                    };
                    let number_line = Line {
                        start: 0,
                        end: number.clusters.len(),
                        width: number_width,
                        last: true,
                    };
                    toc.draw_line(
                        &number,
                        &number_para,
                        &number_line,
                        true,
                        metrics.left,
                        metrics.width,
                        top,
                    );
                }
                toc.y += para.line_height;
            }
            if toc.pages.len() == page_index {
                if let Some(rect) =
                    Rect::from_xywh(metrics.left, entry_top, metrics.width, toc.y - entry_top)
                {
                    toc.page.links.push((
                        rect,
                        LinkTarget::Body {
                            page: anchor.page,
                            y: anchor.y,
                        },
                    ));
                }
            }
        }
        toc_pages = toc.finish();
    }
    front.extend(toc_pages);
    let front_count = front.len();

    // Render.
    let mut document = Document::new();
    let all = front.into_iter().chain(body_pages);
    for (absolute, page_ops) in all.enumerate() {
        let mut settings = PageSettings::from_wh(PAGE_W, PAGE_H).ok_or("invalid page size")?;
        if absolute == 0 && front_count > 0 {
            settings = settings.with_page_label(PageLabel::new(
                Some(NumberingStyle::LowerRoman),
                None,
                NonZeroU32::new(1),
            ));
        } else if absolute == front_count {
            settings = settings.with_page_label(PageLabel::new(
                Some(NumberingStyle::Arabic),
                None,
                NonZeroU32::new(1),
            ));
        }
        let mut page = document.start_page_with(settings);
        for (rect, target) in page_ops.links {
            let target = match target {
                LinkTarget::Uri(uri) => Target::Action(Action::Link(LinkAction::new(uri))),
                LinkTarget::Body { page, y } => Target::Destination(
                    XyzDestination::new(front_count + page, Point::from_xy(0.0, y)).into(),
                ),
            };
            page.add_annotation(Annotation::new_link(
                LinkAnnotation::new(rect, target),
                None,
            ));
        }
        let mut surface = page.surface();
        for op in page_ops.ops {
            match op {
                Op::Glyphs {
                    x,
                    y,
                    face,
                    size,
                    glyphs,
                    text,
                } => {
                    let face = &fonts.faces[face];
                    surface.set_fill(Some(Fill::default()));
                    if face.synthetic_bold {
                        surface.set_stroke(Some(Stroke {
                            width: size * 0.035,
                            line_join: LineJoin::Round,
                            ..Stroke::default()
                        }));
                    }
                    if face.synthetic_italic {
                        // A 12° slant around the baseline origin.
                        surface.push_transform(&Transform::from_row(1.0, 0.0, -0.21, 1.0, x, y));
                        surface.draw_glyphs(
                            Point::from_xy(0.0, 0.0),
                            &glyphs,
                            face.font.clone(),
                            &text,
                            size,
                            false,
                        );
                        surface.pop();
                    } else {
                        surface.draw_glyphs(
                            Point::from_xy(x, y),
                            &glyphs,
                            face.font.clone(),
                            &text,
                            size,
                            false,
                        );
                    }
                    surface.set_stroke(None);
                }
                Op::Rect { x, y, w, h } => {
                    let mut path = PathBuilder::new();
                    if let Some(rect) = Rect::from_xywh(x, y, w.max(0.1), h.max(0.1)) {
                        path.push_rect(rect);
                    }
                    if let Some(path) = path.finish() {
                        surface.set_fill(Some(Fill::default()));
                        surface.draw_path(&path);
                    }
                }
                Op::Dots { x1, x2, y } => {
                    let mut path = PathBuilder::new();
                    path.move_to(x1, y);
                    path.line_to(x2, y);
                    if let Some(path) = path.finish() {
                        surface.set_fill(None);
                        surface.set_stroke(Some(Stroke {
                            width: 0.9,
                            line_cap: LineCap::Round,
                            dash: Some(StrokeDash {
                                array: vec![0.0, 3.0],
                                offset: 0.0,
                            }),
                            ..Stroke::default()
                        }));
                        surface.draw_path(&path);
                        surface.set_stroke(None);
                    }
                }
                Op::Cover { x, y, w, h } => {
                    let Some(cover) = &book.cover else { continue };
                    let data = cover.bytes.clone().into();
                    let image = if cover.png {
                        Image::from_png(data, true)
                    } else {
                        Image::from_jpeg(data, true)
                    }
                    .map_err(|error| format!("cover image: {error}"))?;
                    let size = Size::from_wh(w, h).ok_or("invalid cover size")?;
                    surface.push_transform(&Transform::from_translate(x, y));
                    surface.draw_image(image, size);
                    surface.pop();
                }
            }
        }
        surface.finish();
        page.finish();
    }

    let mut outline = Outline::new();
    let mut act_node: Option<OutlineNode> = None;
    for anchor in &anchors {
        let destination =
            XyzDestination::new(front_count + anchor.page, Point::from_xy(0.0, anchor.y));
        let node = OutlineNode::new(anchor.title.clone(), destination);
        if anchor.act {
            if let Some(previous) = act_node.take() {
                outline.push_child(previous);
            }
            act_node = Some(node);
        } else if let Some(act) = act_node.as_mut() {
            act.push_child(node);
        } else {
            outline.push_child(node);
        }
    }
    if let Some(previous) = act_node.take() {
        outline.push_child(previous);
    }
    document.set_outline(outline);

    let stamp = &book.modified;
    let mut metadata = Metadata::new()
        .title(book.title().to_string())
        .language(book.language.tag().to_string())
        .creator("Drifting".to_string())
        .creation_date(
            DateTime::new(stamp.year)
                .month(stamp.month)
                .day(stamp.day)
                .hour(stamp.hour)
                .minute(stamp.minute)
                .second(stamp.second)
                .utc_offset_hour(0)
                .utc_offset_minute(0),
        );
    if !book.author().is_empty() {
        metadata = metadata.authors(vec![book.author().to_string()]);
    }
    document.set_metadata(metadata);
    document
        .finish()
        .map_err(|error| format!("could not write the PDF: {error:?}"))
}

/// Font summary for acceptance evidence: which installed faces a book uses.
#[cfg(test)]
pub(crate) fn body_font_names(
    book: &Book<'_>,
    database: &Database,
) -> Result<(String, Option<String>), String> {
    let fonts = FontSet::resolve(
        database,
        book.language,
        book.source.preferred_font.as_deref(),
    )?;
    let body = fonts.faces[fonts.chain[0]].post_script_name.clone();
    let latin = fonts
        .latin
        .map(|face| fonts.faces[face].post_script_name.clone());
    Ok((body, latin))
}
