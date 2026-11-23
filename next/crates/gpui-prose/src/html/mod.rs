//! Rich text from another program's HTML: what a word processor (Word,
//! Pages through the system's RTF reader), a browser or another editor puts
//! on the clipboard, read into a [`Fragment`] of this editor's paragraphs and
//! marks. What the format has stays; everything else leaves only its text.
//!
//! **Kept** (the rules of Drifting 0.1's editor, which read pasted HTML with
//! ProseMirror's schema rules):
//!
//! - paragraphs (`p`, `div` …, and `<br>` as a line break inside one);
//!   `h1`–`h3` as H1–H3 (`h4`–`h6` are body paragraphs); `blockquote` as a
//!   quote; `ul` / `ol` / `li` as bullet and numbered items with their depth;
//!   task items (Tiptap's `data-type="taskItem"`, or a checkbox at an item's
//!   start); `pre` as code lines (its language from `language-…`); `hr` as a
//!   rule; alignment centre and right (`text-align`, or the `align`
//!   attribute); Drifting 0.1's own `data-indent` and callouts;
//! - bold (`b`, `strong`, `font-weight` 600 and up), italic (`i`, `em`,
//!   `font-style: italic`), underline (`u`, `text-decoration`), strike-through
//!   (`s`, `strike`, `del`, `text-decoration`), inline code (`code`),
//!   highlight (`mark`), and links to `http`, `https`, `mailto` and `tel`;
//!   `font-weight: normal` and `font-style: normal` take bold and italic off
//!   again (Google Docs wraps everything in `<b style="font-weight:normal">`).
//!
//! **Dropped, text kept**: fonts, sizes, colours, other highlights, margins
//! and first-line indents, `h4`–`h6`, `sub` / `sup`, every other link; a
//! table is one paragraph per row, its cells separated by tabs.
//! **Dropped with their content**: images (never fetched), scripts, styles,
//! forms, media, `display: none`, Word's hidden text and list numbers, ruby
//! annotations. No inline mark in a code line; no underline in a link (a
//! link is drawn underlined already).
//!
//! **Word** writes lists as paragraphs with a hidden number
//! (`mso-list: l0 level1 lfo1`, the number in `mso-list: Ignore`, its format
//! in the document's `@list` rules). A bulleted one becomes a bullet item, one
//! numbered `1.`, `2.` … a numbered item; any other numbering (`一、`, `a)`,
//! `(i)`) stays as written, in front of a body paragraph, since this editor
//! numbers only `1.`. Numbered headings keep the heading and their number.
//!
//! Whitespace collapses as in a browser (kept in `pre` and
//! `white-space: pre…`, where a line break ends a paragraph); a line break in
//! the source between two Chinese or Japanese characters is no space; runs of
//! non-breaking spaces (how HTML keeps several spaces) are spaces again.
//!
//! Never fails and never recurses: input over [`MAX_HTML_BYTES`] or
//! with nothing to paste gives `None`, and the caller pastes plain text.

mod css;
mod entities;
mod tokenizer;

use std::{ops::Range, rc::Rc};

use loro::LoroValue;

use crate::{
    schema::{LINE_BREAK, OBJECT, block, inline},
    text::{BlockAttrs, Fragment, FragmentParagraph},
};
use css::{Decls, Sheet};
use tokenizer::{Token, Tokenizer};

/// The largest HTML read (8 MiB); larger pastes as plain text.
pub const MAX_HTML_BYTES: usize = 8 << 20;

/// Elements nested deeper than this are read as their parent's content.
const MAX_DEPTH: usize = 512;
/// The longest link kept.
const MAX_LINK_BYTES: usize = 8 << 10;
const MAX_LEVEL: i64 = 8;

/// The paragraphs and marks `html` holds, or `None` when it holds nothing
/// to paste or is larger than [`MAX_HTML_BYTES`].
pub fn parse(html: &str) -> Option<Fragment> {
    if html.len() > MAX_HTML_BYTES {
        return None;
    }
    // The document's styles come first: Word's list definitions and the
    // class rules of Cocoa's HTML are in the head.
    let mut sheet = Sheet::default();
    if html
        .as_bytes()
        .windows(6)
        .any(|w| w.eq_ignore_ascii_case(b"<style"))
    {
        let mut in_style = false;
        for token in Tokenizer::new(html) {
            match token {
                Token::Start { name, .. } => in_style = name == "style",
                Token::End { .. } => in_style = false,
                Token::Text(css) if in_style => sheet.add(&css),
                Token::Text(_) => {}
            }
        }
    }
    let mut reader = Reader::new(sheet);
    for token in Tokenizer::new(html) {
        reader.token(token);
    }
    let fragment = reader.finish();
    fragment
        .paragraphs
        .iter()
        .any(|p| !p.text.is_empty() || p.is_rule())
        .then_some(fragment)
}

// ----- elements -------------------------------------------------------------

const VOID: &[&str] = &[
    "area", "base", "basefont", "bgsound", "br", "col", "embed", "frame", "hr", "image", "img",
    "input", "keygen", "link", "meta", "param", "source", "track", "wbr",
];

/// Content never shown, or never text.
const HIDDEN: &[&str] = &[
    "applet", "audio", "canvas", "datalist", "head", "iframe", "map", "math", "noembed",
    "noframes", "noscript", "object", "rp", "rt", "script", "select", "style", "svg", "template",
    "textarea", "title", "video", "xml",
];

/// Elements that end the paragraph before and after them.
const BLOCKS: &[&str] = &[
    "address",
    "article",
    "aside",
    "blockquote",
    "body",
    "caption",
    "center",
    "dd",
    "details",
    "dialog",
    "dir",
    "div",
    "dl",
    "dt",
    "fieldset",
    "figcaption",
    "figure",
    "footer",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hgroup",
    "html",
    "legend",
    "li",
    "listing",
    "main",
    "menu",
    "nav",
    "ol",
    "p",
    "plaintext",
    "pre",
    "section",
    "summary",
    "table",
    "tr",
    "ul",
    "xmp",
];

/// Blocks that are a paragraph even when empty (`<p></p>`).
const PARAGRAPHS: &[&str] = &["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "pre", "tr"];

/// Start tags that end an open `<p>` (the HTML parsing rules).
const CLOSE_P: &[&str] = &[
    "address",
    "article",
    "aside",
    "blockquote",
    "center",
    "dd",
    "details",
    "dialog",
    "dir",
    "div",
    "dl",
    "dt",
    "fieldset",
    "figcaption",
    "figure",
    "footer",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hgroup",
    "hr",
    "li",
    "listing",
    "main",
    "menu",
    "nav",
    "ol",
    "p",
    "plaintext",
    "pre",
    "section",
    "summary",
    "table",
    "ul",
    "xmp",
];

/// Where looking for an element to close implicitly stops.
const SCOPE: &[&str] = &[
    "applet", "button", "caption", "html", "marquee", "object", "table", "td", "template", "th",
];

fn is(list: &[&str], name: &str) -> bool {
    list.contains(&name)
}

// ----- state ------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Space {
    #[default]
    Normal,
    /// `pre`, `pre-wrap`, `break-spaces`: every space and line break kept.
    Pre,
    /// `pre-line`: spaces collapse, line breaks are kept.
    PreLine,
}

/// The inline marks of text.
#[derive(Clone, Debug, Default, PartialEq)]
struct Marks {
    bold: bool,
    italic: bool,
    underline: bool,
    strike: bool,
    code: bool,
    highlight: bool,
    link: Option<Rc<str>>,
}

impl Marks {
    /// The value of `key` (one of [`MARK_KEYS`]).
    fn value(&self, key: &str) -> Option<LoroValue> {
        let on = match key {
            inline::BOLD => self.bold,
            inline::ITALIC => self.italic,
            inline::UNDERLINE => self.underline && self.link.is_none(),
            inline::STRIKE => self.strike,
            inline::CODE => self.code,
            inline::HIGHLIGHT => return self.highlight.then(|| LoroValue::from("")),
            inline::LINK => return self.link.as_deref().map(LoroValue::from),
            _ => false,
        };
        on.then_some(LoroValue::Bool(true))
    }
}

const MARK_KEYS: &[&str] = &[
    inline::BOLD,
    inline::ITALIC,
    inline::UNDERLINE,
    inline::STRIKE,
    inline::CODE,
    inline::HIGHLIGHT,
    inline::LINK,
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ListKind {
    Bullet,
    Ordered,
    Task,
}

impl ListKind {
    fn as_str(self) -> &'static str {
        match self {
            ListKind::Bullet => "bullet",
            ListKind::Ordered => "ordered",
            ListKind::Task => "task",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
struct Item {
    kind: ListKind,
    level: i64,
    checked: bool,
}

/// What applies inside an element.
#[derive(Clone, Debug, Default)]
struct Ctx {
    hidden: bool,
    space: Space,
    marks: Marks,
    heading: Option<i64>,
    quote: bool,
    callout: bool,
    /// The list the `li`s here belong to: its kind and depth.
    list: Option<(ListKind, i64)>,
    item: Option<Item>,
    /// Word's list paragraph: the list (`l0`) and its level (1 outermost).
    word_list: Option<(String, i64)>,
    /// A code line's language.
    code: Option<String>,
    align: Option<&'static str>,
    indent: i64,
    /// Inside a table's cell: paragraphs run together.
    cell: bool,
}

struct Frame {
    name: String,
    ctx: Ctx,
    /// Ends the paragraph around it.
    block: bool,
    /// How many paragraphs had been opened when it started.
    opened_at: usize,
    /// An `li`'s own paragraph (its index in `done`), which later
    /// paragraphs of the same item join with a line break.
    item_para: Option<usize>,
    /// A `tr`'s cells so far.
    cells: usize,
    /// A Word list paragraph: the hidden number read so far.
    marker: Option<String>,
    /// Word's hidden list number (`mso-list: Ignore`): its text is the
    /// marker of the paragraph it is in.
    capture: bool,
}

/// A paragraph being read.
struct Para {
    text: String,
    len: usize,
    runs: Vec<(Range<usize>, Marks)>,
    attrs: BlockAttrs,
    code: bool,
}

impl Para {
    fn new(attrs: BlockAttrs, code: bool) -> Para {
        Para {
            text: String::new(),
            len: 0,
            runs: Vec::new(),
            attrs,
            code,
        }
    }

    fn last(&self) -> Option<char> {
        self.text.chars().next_back()
    }

    fn push(&mut self, c: char, marks: &Marks) {
        self.text.push(c);
        self.len += 1;
        let marks = if self.code || c == LINE_BREAK {
            Marks::default()
        } else {
            marks.clone()
        };
        match self.runs.last_mut() {
            Some((range, m)) if *m == marks => range.end = self.len,
            _ => self.runs.push((self.len - 1..self.len, marks)),
        }
    }

    /// Drops trailing line breaks; a paragraph of nothing but spaces is
    /// empty; non-breaking spaces next to a space are spaces.
    fn settle(&mut self) {
        while self.last() == Some(LINE_BREAK) {
            self.text.pop();
            self.len -= 1;
        }
        for run in &mut self.runs {
            run.0.end = run.0.end.min(self.len);
        }
        self.runs.retain(|(r, _)| !r.is_empty());
        if self.code {
            return;
        }
        if self
            .text
            .chars()
            .all(|c| matches!(c, ' ' | '\u{a0}' | '\t' | LINE_BREAK))
        {
            self.text.clear();
            self.len = 0;
            self.runs.clear();
            return;
        }
        if self.text.contains('\u{a0}') {
            let chars: Vec<char> = self.text.chars().collect();
            let space = |ix: Option<usize>| {
                ix.and_then(|ix| chars.get(ix))
                    .is_some_and(|c| matches!(c, ' ' | '\u{a0}'))
            };
            self.text = chars
                .iter()
                .enumerate()
                .map(|(ix, c)| {
                    if *c == '\u{a0}' && (space(ix.checked_sub(1)) || space(Some(ix + 1))) {
                        ' '
                    } else {
                        *c
                    }
                })
                .collect();
        }
    }

    fn into_paragraph(self) -> FragmentParagraph {
        let mut marks = Vec::new();
        for key in MARK_KEYS {
            let mut open: Option<(usize, LoroValue)> = None;
            for (range, m) in &self.runs {
                let value = m.value(key);
                if open.as_ref().map(|(_, v)| v) == value.as_ref() {
                    continue;
                }
                if let Some((start, v)) = open.take() {
                    marks.push((start..range.start, key.to_string(), v));
                }
                open = value.map(|v| (range.start, v));
            }
            if let Some((start, v)) = open {
                marks.push((start..self.len, key.to_string(), v));
            }
        }
        FragmentParagraph {
            text: self.text,
            marks,
            attrs: self.attrs,
        }
    }
}

/// What a Word list paragraph becomes.
#[derive(Clone, Debug, PartialEq)]
enum WordItem {
    Bullet,
    Ordered,
    /// Its number as written, in front of a body paragraph.
    Literal(String),
}

fn word_item(level: Option<(String, Option<String>)>, marker: Option<&str>) -> WordItem {
    let marker = marker
        .map(|m| m.trim_matches(|c: char| c.is_whitespace()))
        .filter(|m| !m.is_empty());
    if level
        .as_ref()
        .is_some_and(|(format, _)| format == "bullet" || format == "image")
    {
        return WordItem::Bullet;
    }
    match marker {
        Some(m) if decimal_dot(m) => WordItem::Ordered,
        Some(m) if bullet_glyph(m) => WordItem::Bullet,
        Some(m) => WordItem::Literal(m.to_owned()),
        // The number was in a comment Word wrote for itself: what the
        // list's definition says, else a bullet.
        None if level.is_some() => WordItem::Ordered,
        None => WordItem::Bullet,
    }
}

/// `1.`, `12.`: what this editor's numbered items show.
fn decimal_dot(m: &str) -> bool {
    m.strip_suffix('.')
        .is_some_and(|d| !d.is_empty() && d.len() <= 9 && d.bytes().all(|b| b.is_ascii_digit()))
}

/// One symbol (`·`, ``, `§`, `▪`, Word's `o` for the second level).
fn bullet_glyph(m: &str) -> bool {
    let mut chars = m.chars();
    m == "o" || matches!((chars.next(), chars.next()), (Some(c), None) if !c.is_alphanumeric())
}

/// Wide (Chinese, Japanese) characters, between which a line break in the
/// source is not a space (CSS Text 3, segment break transformation).
fn wide(c: char) -> bool {
    matches!(c as u32,
        0x2E80..=0x303E | 0x3041..=0x33FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF
        | 0xA000..=0xA4CF | 0xF900..=0xFAFF | 0xFE30..=0xFE4F | 0xFF00..=0xFF60
        | 0xFFE0..=0xFFE6 | 0x20000..=0x2FFFD | 0x30000..=0x3FFFD)
}

fn link_url(href: &str) -> Option<Rc<str>> {
    let url: String = href
        .chars()
        .filter(|c| !matches!(c, '\t' | '\n' | '\r'))
        .collect();
    let url = url.trim();
    if url.is_empty() || url.len() > MAX_LINK_BYTES {
        return None;
    }
    let (scheme, _) = url.split_once(':')?;
    matches!(
        scheme.to_ascii_lowercase().as_str(),
        "http" | "https" | "mailto" | "tel"
    )
    .then(|| Rc::from(url))
}

fn align(value: &str) -> Option<&'static str> {
    match value.trim() {
        "center" | "-webkit-center" | "-moz-center" | "middle" => Some("center"),
        "right" | "-webkit-right" | "-moz-right" => Some("right"),
        _ => None,
    }
}

/// `font-weight`: on, off, or no say.
fn weight(value: &str) -> Option<bool> {
    match value {
        "bold" | "bolder" => Some(true),
        "normal" | "lighter" => Some(false),
        v => v.parse::<f32>().ok().map(|w| w >= 600.0),
    }
}

/// Word's `mso-list: l0 level1 lfo1`: the list and the level.
fn word_list(value: &str) -> Option<(String, i64)> {
    let mut list = None;
    let mut level = None;
    for word in value.split_whitespace() {
        if let Some(n) = word.strip_prefix("level") {
            level = n.parse::<i64>().ok();
        } else if word.len() > 1
            && word.starts_with('l')
            && word[1..].bytes().all(|b| b.is_ascii_digit())
        {
            list = Some(word.to_owned());
        }
    }
    Some((list?, level?.clamp(1, MAX_LEVEL + 1)))
}

// ----- the reader -----------------------------------------------------------------

struct Reader {
    sheet: Sheet,
    stack: Vec<Frame>,
    /// Start tags past [`MAX_DEPTH`] still open.
    overflow: usize,
    root: Ctx,
    done: Vec<Para>,
    cur: Option<Para>,
    /// Paragraphs opened so far.
    opened: usize,
    /// Collapsible white space since the last character: the marks it
    /// had, and whether it held a line break.
    pending: Option<(Marks, bool)>,
    /// Kept white space: a line break just ended a paragraph.
    pre_break: bool,
    /// Right after `<pre>`: its first line break is not content.
    skip_break: bool,
    /// A block ended inside a table cell: the cell's next text starts on a
    /// new line.
    cell_break: bool,
    /// Word list numbers being read.
    capturing: usize,
}

impl Reader {
    fn new(sheet: Sheet) -> Reader {
        Reader {
            sheet,
            stack: Vec::new(),
            overflow: 0,
            root: Ctx::default(),
            done: Vec::new(),
            cur: None,
            opened: 0,
            pending: None,
            pre_break: false,
            skip_break: false,
            cell_break: false,
            capturing: 0,
        }
    }

    fn ctx(&self) -> &Ctx {
        self.stack.last().map_or(&self.root, |f| &f.ctx)
    }

    fn token(&mut self, token: Token<'_>) {
        match token {
            Token::Start { name, attrs, .. } => self.start(name, &attrs),
            Token::End { name } => self.end(&name),
            Token::Text(text) => self.text(&text),
        }
    }

    fn finish(mut self) -> Fragment {
        while let Some(frame) = self.stack.pop() {
            self.end_frame(frame);
        }
        self.close_para();
        Fragment {
            paragraphs: self.done.into_iter().map(Para::into_paragraph).collect(),
        }
    }

    // ----- tags -----------------------------------------------------------------------

    fn start(&mut self, name: String, attrs: &[(String, String)]) {
        let void = is(VOID, &name);
        if self.overflow > 0 || self.stack.len() >= MAX_DEPTH {
            if !void {
                self.overflow += 1;
            }
            return;
        }
        self.close_implicitly(&name);
        let attr = |key: &str| {
            attrs
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.as_str())
        };
        if void {
            match name.as_str() {
                "br" => self.line_break(),
                "hr" => self.rule(),
                "input" if attr("type").is_some_and(|t| t.eq_ignore_ascii_case("checkbox")) => {
                    self.checkbox(attr("checked").is_some())
                }
                _ => {}
            }
            return;
        }

        let mut decls: Decls = self.sheet.for_element(&name, attr("class").unwrap_or(""));
        if let Some(style) = attr("style") {
            decls.extend(css::declarations(style));
        }
        let decl = |property: &str| css::get(&decls, property);
        let parent = self.ctx().clone();
        let mut ctx = parent.clone();
        let mut capture = false;
        let mut tabs = 0;

        if is(HIDDEN, &name)
            || attr("hidden").is_some()
            || decl("display") == Some("none")
            || decl("mso-hide") == Some("all")
            || matches!(decl("visibility"), Some("hidden" | "collapse"))
        {
            ctx.hidden = true;
        }
        let mso_list = decl("mso-list").map(str::to_owned);
        if mso_list.as_deref() == Some("ignore") {
            ctx.hidden = true;
            capture = true;
        }
        if let Some(n) = decl("mso-tab-count").and_then(|n| n.trim().parse::<usize>().ok()) {
            // Word's tab: the spaces it wrote for it are one tab per count.
            tabs = n.min(16);
            ctx.hidden = true;
        }
        match decl("white-space") {
            Some("pre" | "pre-wrap" | "break-spaces") => ctx.space = Space::Pre,
            Some("pre-line") => ctx.space = Space::PreLine,
            Some("normal" | "nowrap") => ctx.space = Space::Normal,
            _ => {}
        }

        // Inline marks: the element's own, then its style's.
        let m = &mut ctx.marks;
        match name.as_str() {
            "b" | "strong" => m.bold = true,
            "i" | "em" => m.italic = true,
            "u" => m.underline = true,
            "s" | "strike" | "del" => m.strike = true,
            "code" if parent.code.is_none() => m.code = true,
            "mark" => m.highlight = true,
            "a" => {
                if let Some(url) = attr("href").and_then(link_url) {
                    m.link = Some(url);
                }
            }
            _ => {}
        }
        if let Some(bold) = decl("font-weight").and_then(weight) {
            m.bold = bold;
        }
        match decl("font-style") {
            Some("italic" | "oblique") => m.italic = true,
            Some("normal") => m.italic = false,
            _ => {}
        }
        for property in ["text-decoration", "text-decoration-line"] {
            if let Some(d) = decl(property) {
                // A link's own underline is the link's.
                if d.contains("underline") && name != "a" {
                    m.underline = true;
                }
                if d.contains("line-through") {
                    m.strike = true;
                }
            }
        }

        // Paragraph kinds.
        let block = is(BLOCKS, &name);
        match name.as_str() {
            "h1" | "h2" | "h3" => ctx.heading = name[1..].parse().ok(),
            "h4" | "h5" | "h6" => ctx.heading = None,
            "blockquote" => ctx.quote = true,
            "aside" if attr("data-callout").is_some() => ctx.callout = true,
            "ul" | "ol" | "menu" | "dir" => {
                let kind = if name == "ol" {
                    ListKind::Ordered
                } else if attr("data-type") == Some("taskList") {
                    ListKind::Task
                } else {
                    ListKind::Bullet
                };
                let level = parent.list.map_or(0, |(_, l)| (l + 1).min(MAX_LEVEL));
                ctx.list = Some((kind, level));
                ctx.item = None;
            }
            "li" => {
                let (kind, level) = parent.list.unwrap_or((ListKind::Bullet, 0));
                let task = attr("data-type") == Some("taskItem");
                ctx.item = Some(Item {
                    kind: if task { ListKind::Task } else { kind },
                    level,
                    checked: task && attr("data-checked") == Some("true"),
                });
            }
            "pre" | "listing" | "xmp" | "plaintext" => {
                ctx.space = Space::Pre;
                ctx.code = Some(language(attr("class")).unwrap_or_default());
            }
            "code" => {
                // `<pre><code class="language-rust">`: the language of the
                // block, while it has no text yet.
                if parent.code.is_some()
                    && self.cur.is_none()
                    && let Some(lang) = language(attr("class"))
                {
                    if let Some(pre) = self.stack.iter_mut().rev().find(|f| f.ctx.code.is_some()) {
                        pre.ctx.code = Some(lang.clone());
                    }
                    ctx.code = Some(lang);
                }
            }
            "td" | "th" | "tr" => ctx.cell = true,
            _ => {}
        }
        if block {
            ctx.align = decl("text-align")
                .and_then(align)
                .or_else(|| attr("align").and_then(align));
        }
        if let Some(n) = attr("data-indent").and_then(|n| n.trim().parse::<i64>().ok()) {
            ctx.indent = n.clamp(0, MAX_LEVEL);
        }
        let mut word_owner = false;
        if let Some(list) = mso_list.as_deref().and_then(word_list)
            && (block || name == "li")
        {
            ctx.word_list = Some(list);
            ctx.item = None;
            word_owner = true;
        }

        // What starting it does to the text around it.
        let visible = !ctx.hidden;
        if !parent.hidden {
            for _ in 0..tabs {
                self.literal('\t');
            }
        }
        if visible {
            if block {
                if parent.cell {
                    self.cell_break = true;
                } else {
                    self.break_block();
                }
            }
            if name == "td" || name == "th" {
                self.cell();
            }
        }
        // The line break right after `<pre>` is not content.
        self.skip_break = matches!(name.as_str(), "pre" | "listing");
        if capture {
            self.capturing += 1;
        }
        self.stack.push(Frame {
            name,
            ctx,
            block: block && visible,
            opened_at: self.opened,
            item_para: None,
            cells: 0,
            marker: word_owner.then(String::new),
            capture,
        });
    }

    fn end(&mut self, name: &str) {
        if self.overflow > 0 {
            self.overflow -= 1;
            return;
        }
        if name == "br" {
            // `</br>` is a `<br>` to a browser.
            self.line_break();
            return;
        }
        let Some(ix) = self.stack.iter().rposition(|f| f.name == name) else {
            return;
        };
        // An inline element's end does not end the blocks opened in it
        // (`<b><p>…</b>…</p>`): the paragraph goes on.
        if !self.stack[ix].block
            && !matches!(name, "td" | "th")
            && self.stack[ix + 1..].iter().any(|f| f.block)
        {
            return;
        }
        while self.stack.len() > ix {
            let frame = self.stack.pop().expect("the stack holds the frame");
            self.end_frame(frame);
        }
    }

    /// The start tags that end an open element (`<p>`, `<li>` …).
    fn close_implicitly(&mut self, name: &str) {
        let find = |stack: &[Frame], targets: &[&str], stops: &[&str]| {
            for (ix, f) in stack.iter().enumerate().rev() {
                if targets.contains(&f.name.as_str()) {
                    return Some(ix);
                }
                if stops.contains(&f.name.as_str()) {
                    return None;
                }
            }
            None
        };
        let list_scope: Vec<&str> = SCOPE
            .iter()
            .copied()
            .chain(["ul", "ol", "menu", "dir"])
            .collect();
        let dl_scope: Vec<&str> = SCOPE.iter().copied().chain(["dl"]).collect();
        let close = |reader: &mut Reader, ix: Option<usize>| {
            if let Some(ix) = ix {
                while reader.stack.len() > ix {
                    let frame = reader.stack.pop().expect("the stack holds the frame");
                    reader.end_frame(frame);
                }
            }
        };
        if is(CLOSE_P, name) {
            let ix = find(&self.stack, &["p"], SCOPE);
            close(self, ix);
        }
        match name {
            "li" => {
                let ix = find(&self.stack, &["li"], &list_scope);
                close(self, ix);
            }
            "dt" | "dd" => {
                let ix = find(&self.stack, &["dt", "dd"], &dl_scope);
                close(self, ix);
            }
            "td" | "th" => {
                let ix = find(&self.stack, &["td", "th"], &["tr", "table"]);
                close(self, ix);
            }
            "tr" => {
                let ix = find(&self.stack, &["tr"], &["table", "tbody", "thead", "tfoot"]);
                close(self, ix);
            }
            // A heading right inside a heading ends it.
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
                if self.stack.last().is_some_and(|f| {
                    matches!(f.name.as_str(), "h1" | "h2" | "h3" | "h4" | "h5" | "h6")
                }) =>
            {
                let ix = self.stack.len() - 1;
                close(self, Some(ix));
            }
            _ => {}
        }
    }

    fn end_frame(&mut self, frame: Frame) {
        if frame.capture {
            self.capturing -= 1;
        }
        let parent_cell = self.ctx().cell;
        if frame.block {
            if parent_cell {
                self.cell_break = true;
            } else {
                self.break_block();
                if is(PARAGRAPHS, &frame.name) && self.opened == frame.opened_at {
                    let attrs = self.attrs_for(&frame.ctx, frame.marker.as_deref()).0;
                    let code = frame.ctx.code.is_some();
                    self.opened += 1;
                    self.done.push(Para::new(attrs, code));
                }
            }
        }
    }

    // ----- text -----------------------------------------------------------------------

    fn text(&mut self, text: &str) {
        let (hidden, space, marks) = {
            let ctx = self.ctx();
            (ctx.hidden, ctx.space, ctx.marks.clone())
        };
        if hidden {
            if self.capturing > 0
                && let Some(owner) = self.stack.iter_mut().rev().find_map(|f| f.marker.as_mut())
                && owner.len() < 64
            {
                owner.push_str(text);
            }
            return;
        }
        let normalized;
        let text = if space != Space::Normal && text.contains('\r') {
            normalized = text.replace("\r\n", "\n").replace('\r', "\n");
            normalized.as_str()
        } else {
            text
        };
        for c in text.chars() {
            let skip = std::mem::take(&mut self.skip_break);
            match (space, c) {
                (Space::Normal, ' ' | '\t' | '\n' | '\r' | '\x0c')
                | (Space::PreLine, ' ' | '\t' | '\x0c') => {
                    let had_break = self.pending.as_ref().is_some_and(|(_, b)| *b);
                    self.pending = Some((marks.clone(), had_break || matches!(c, '\n' | '\r')));
                }
                (Space::Pre | Space::PreLine, '\n') => {
                    if !skip {
                        self.kept_break();
                    }
                }
                _ => self.char(c, &marks),
            }
        }
    }

    /// One character of content.
    fn char(&mut self, c: char, marks: &Marks) {
        match c {
            OBJECT | '\u{feff}' => return,
            LINE_BREAK | '\u{2029}' => return self.line_break(),
            '\t' => {}
            c if c.is_control() => return,
            _ => {}
        }
        self.open();
        let para = self.cur.as_mut().expect("open");
        if std::mem::take(&mut self.cell_break) && para.len > 0 && para.last() != Some('\t') {
            para.push(LINE_BREAK, marks);
        }
        if let Some((space, had_break)) = self.pending.take()
            && let Some(last) = para.last()
            && last != LINE_BREAK
            && last != '\t'
            && !(had_break && wide(last) && wide(c))
        {
            para.push(' ', &space);
        }
        para.push(c, marks);
        self.pre_break = false;
    }

    /// A character that is never white space to collapse (a cell's tab).
    fn literal(&mut self, c: char) {
        if self.ctx().hidden {
            return;
        }
        self.open();
        self.pending = None;
        let para = self.cur.as_mut().expect("open");
        para.push(c, &Marks::default());
        self.pre_break = false;
    }

    /// `<br>`.
    fn line_break(&mut self) {
        let ctx = self.ctx();
        if ctx.hidden {
            return;
        }
        if ctx.code.is_some() && !ctx.cell {
            return self.kept_break();
        }
        self.pending = None;
        self.open();
        let para = self.cur.as_mut().expect("open");
        para.push(LINE_BREAK, &Marks::default());
        self.pre_break = false;
    }

    /// A line break in kept white space: it ends the paragraph (each line
    /// of code is one); two in a row leave an empty one.
    fn kept_break(&mut self) {
        if self.ctx().cell {
            return self.line_break_in_cell();
        }
        if self.cur.is_some() {
            self.close_para();
        } else {
            self.open();
            self.close_para();
        }
        self.pre_break = true;
    }

    fn line_break_in_cell(&mut self) {
        self.pending = None;
        self.open();
        let para = self.cur.as_mut().expect("open");
        para.push(LINE_BREAK, &Marks::default());
    }

    /// `<hr>`: a rule of its own.
    fn rule(&mut self) {
        let ctx = self.ctx();
        if ctx.hidden || ctx.cell {
            return;
        }
        self.break_block();
        let mut attrs = BlockAttrs::default();
        attrs.set(block::RULE, Some(LoroValue::Bool(true)));
        self.opened += 1;
        self.done.push(Para::new(attrs, false));
    }

    /// A checkbox at the start of a list item makes it a task.
    fn checkbox(&mut self, checked: bool) {
        if self.ctx().hidden || self.cur.as_ref().is_some_and(|p| p.len > 0) {
            return;
        }
        let Some(li) = self.stack.iter().rposition(|f| f.name == "li") else {
            return;
        };
        if self.stack[li].item_para.is_some() {
            return;
        }
        for frame in &mut self.stack[li..] {
            if let Some(item) = &mut frame.ctx.item {
                item.kind = ListKind::Task;
                item.checked = checked;
            }
        }
    }

    /// A table cell starts: after the first, a tab.
    fn cell(&mut self) {
        self.cell_break = false;
        if let Some(tr) = self.stack.iter().rposition(|f| f.name == "tr") {
            if self.stack[tr].cells > 0 {
                self.literal('\t');
            }
            self.stack[tr].cells += 1;
        }
    }

    // ----- paragraphs -----------------------------------------------------------------

    fn break_block(&mut self) {
        self.close_para();
        self.pending = None;
        self.pre_break = false;
        self.cell_break = false;
    }

    fn close_para(&mut self) {
        if let Some(mut para) = self.cur.take() {
            para.settle();
            self.done.push(para);
        }
        self.pending = None;
    }

    /// Opens a paragraph for the text that comes, with the attributes of
    /// where it is, unless one is open.
    fn open(&mut self) {
        if self.cur.is_some() {
            return;
        }
        let ctx = self.ctx().clone();
        let marker = self
            .stack
            .iter()
            .rev()
            .find_map(|f| f.marker.as_deref())
            .map(str::to_owned);
        let (attrs, prefix) = self.attrs_for(&ctx, marker.as_deref());
        let code = ctx.code.is_some() && !ctx.cell;
        self.opened += 1;
        // A later block of the same list item joins its first paragraph.
        let li = (!ctx.cell)
            .then(|| self.stack.iter().rposition(|f| f.name == "li"))
            .flatten()
            .filter(|_| ctx.item.is_some());
        if let Some(li) = li
            && let Some(ix) = self.stack[li].item_para
            && ix + 1 == self.done.len()
            && self.done[ix].attrs == attrs
        {
            let mut para = self.done.pop().expect("the item's paragraph");
            if para.len > 0 {
                para.push(LINE_BREAK, &Marks::default());
            }
            self.cur = Some(para);
            return;
        }
        if let Some(li) = li {
            self.stack[li].item_para = Some(self.done.len());
        }
        let mut para = Para::new(attrs, code);
        if let Some(prefix) = prefix {
            for c in prefix.chars() {
                para.push(c, &Marks::default());
            }
        }
        self.cur = Some(para);
    }

    /// The attributes of a paragraph opened in `ctx`, and the text that
    /// goes in front of it (a Word number kept as written).
    fn attrs_for(&self, ctx: &Ctx, marker: Option<&str>) -> (BlockAttrs, Option<String>) {
        let mut a = BlockAttrs::default();
        let mut prefix = None;
        if ctx.quote {
            a.set(block::QUOTE, Some(LoroValue::Bool(true)));
        }
        if ctx.callout {
            a.set(block::CALLOUT, Some(LoroValue::from("note")));
        }
        if ctx.cell {
            return (a, None);
        }
        let mut list = None;
        if let Some(lang) = &ctx.code {
            a.set(block::CODE_BLOCK, Some(LoroValue::from(lang.as_str())));
            return (a, None);
        } else if let Some(item) = &ctx.item {
            list = Some((item.kind, item.level));
            if item.kind == ListKind::Task && item.checked {
                a.set(block::CHECKED, Some(LoroValue::Bool(true)));
            }
        } else if let Some((id, level)) = &ctx.word_list {
            let def = self.sheet.word_level(id, *level);
            let item = word_item(def, marker);
            if let Some(h) = ctx.heading {
                // Word's numbered heading: a heading, its number as written.
                a.set(block::HEADING, Some(LoroValue::I64(h)));
                let number = match item {
                    WordItem::Literal(m) => Some(m),
                    WordItem::Ordered => marker
                        .map(|m| m.trim().to_owned())
                        .filter(|m| !m.is_empty()),
                    WordItem::Bullet => None,
                };
                prefix = number.map(with_separator);
            } else {
                match item {
                    WordItem::Bullet => list = Some((ListKind::Bullet, level - 1)),
                    WordItem::Ordered => list = Some((ListKind::Ordered, level - 1)),
                    WordItem::Literal(m) => prefix = Some(with_separator(m)),
                }
            }
        } else if let Some(h) = ctx.heading {
            a.set(block::HEADING, Some(LoroValue::I64(h)));
        }
        if let Some((kind, level)) = list {
            a.set(block::LIST, Some(LoroValue::from(kind.as_str())));
            let level = level.clamp(0, MAX_LEVEL);
            if level > 0 {
                a.set(block::LIST_LEVEL, Some(LoroValue::I64(level)));
            }
        } else if ctx.indent > 0 {
            a.set(block::INDENT, Some(LoroValue::I64(ctx.indent)));
        }
        if let Some(align) = ctx.align {
            a.set(block::ALIGN, Some(LoroValue::from(align)));
        }
        (a, prefix)
    }
}

/// A number written in front of a paragraph, and what separates it from
/// the text: nothing after Chinese punctuation (`一、`, `（一）`), a space
/// otherwise.
fn with_separator(mut marker: String) -> String {
    if !marker.ends_with(|c: char| wide(c)) {
        marker.push(' ');
    }
    marker
}

/// The language of `class="language-rust"` (or `lang-rust`).
fn language(class: Option<&str>) -> Option<String> {
    class?.split_ascii_whitespace().find_map(|c| {
        c.strip_prefix("language-")
            .or_else(|| c.strip_prefix("lang-"))
            .filter(|l| !l.is_empty() && l.len() <= 32)
            .map(str::to_ascii_lowercase)
    })
}

#[cfg(test)]
mod tests;
