//! A chapter page around its text (M03): the facts its head and end show
//! (the folio line 「第 N 章 · 故事线 · 字数」, the title, the synopsis, the
//! end ornament ⁂, the empty-chapter hint), the places to draw them (gpui-
//! prose's chapter slots, which scroll with the text), and the author's
//! actions on them.
//!
//! The host (F6) draws: it implements [`PageChrome`] and hands it to
//! [`crate::ChapterEditor::set_chrome`] or [`crate::BookEditor::set_chrome`].
//! The editor keeps each page's [`PageInfo`] current (the workspace's book
//! events for titles, status, storylines; the editor's own edits for the
//! word count and emptiness) and asks the host again when it changed.
//!
//! The rules are the 0.1 client's (`NodeEditorView.tsx`, `ChapterEditor.tsx`,
//! `ChapterEndOrnament.tsx`, `ChapterEmptyHints.tsx`):
//!
//! - N is the chapter's place in reading order among live chapters (F3's
//!   `number`), acts do not restart it; the storyline is the primary one,
//!   else the first; words are counted with `prose-metrics` (the body only).
//! - A title is trimmed; an empty one is not stored (the field shows the
//!   stored title again); an unchanged one writes nothing; a taken one gets
//!   a ` 2` suffix (F3). Enter or ↓ at its end hands over to the text
//!   ([`crate::ChapterEditor::focus_body`]); Esc shows the stored title again.
//! - A synopsis is trimmed and may be empty.
//! - ⁂: 「标为完成」 / 「改回草稿」 flips `finished` and `draft`; 「新建下一章」
//!   puts a draft chapter right after this one (never across an act
//!   boundary), titled 「新章节」 (made unique), on no storyline.
//! - The empty-chapter hint shows while the text is one empty paragraph.

use std::cell::RefCell;
use std::rc::Rc;

use dr_workspace::{Actor, Workspace, WsError};
use gpui::{
    AnyElement, App, ElementId, Entity, FontWeight, InteractiveElement, IntoElement, ParentElement,
    StatefulInteractiveElement, Styled, Window, div, px, relative,
};
use gpui_prose::{ChapterSlots, ProseDoc, ProseEditor, ProseStyle};
use serde_json::{Value, json};

/// What kind of page a prose document is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PageKind {
    /// An entry in the manuscript sequence (numbered as 「第 N 章」).
    Chapter,
    /// Any other prose page (shows its template name).
    Other,
}

/// The storyline a chapter page names in its folio line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StorylineMark {
    pub id: String,
    pub name: String,
    /// The storyline's colour as stored (`#rrggbb`).
    pub color: String,
}

/// The facts of one page, for its head and end.
#[derive(Clone, Debug, PartialEq)]
pub struct PageInfo {
    /// The prose document (`body:<entry>/<module>`, …).
    pub doc: String,
    pub kind: PageKind,
    /// Whether the host's page head and end chrome belong on this document.
    pub chrome: bool,
    /// 「第 N 章」: the entry's place in the manuscript sequence.
    pub number: Option<u32>,
    /// The entry's effective template name (empty when untemplated).
    pub template_name: String,
    /// The entry's resolved colour (`#rrggbb`), own colour field first, then
    /// template colour, then active primary/first lane colour.
    pub color: Option<String>,
    pub title: String,
    /// Whether the template exposes a summary/synopsis role field.
    pub has_synopsis: bool,
    /// The synopsis (梗概).
    pub synopsis: String,
    /// Whether the template exposes a status role field.
    pub has_status: bool,
    /// Status value (`draft` / `finished` / …) when `has_status` is true.
    pub status: String,
    pub storyline: Option<StorylineMark>,
    /// Words in the text (prose-metrics' rule), as the editor holds it.
    pub words: u64,
    /// The text is one empty paragraph (the empty-chapter hint shows).
    pub empty: bool,
}

impl PageInfo {
    pub(crate) fn blank(doc: &str) -> PageInfo {
        PageInfo {
            doc: doc.to_owned(),
            kind: PageKind::Other,
            chrome: false,
            number: None,
            template_name: String::new(),
            color: None,
            title: String::new(),
            has_synopsis: false,
            synopsis: String::new(),
            has_status: false,
            status: String::new(),
            storyline: None,
            words: 0,
            empty: false,
        }
    }

    /// Whether ⁂ offers 「改回草稿」 (else 「标为完成」).
    pub fn finished(&self) -> bool {
        self.status == "finished"
    }
}

/// What the host draws around each page's text. Every element scrolls with
/// the text; a mouse press inside one stays there.
pub trait PageChrome: 'static {
    /// Drawn above the text, in place of the editor's own title row: the
    /// folio line, the title field, the synopsis, a rule. `None` keeps the
    /// editor's title row.
    fn head(&self, _page: &PageInfo, _window: &mut Window, _cx: &mut App) -> Option<AnyElement> {
        None
    }

    /// Drawn after the text: ⁂ and its actions, the empty-chapter hint.
    fn end(&self, _page: &PageInfo, _window: &mut Window, _cx: &mut App) -> Option<AnyElement> {
        None
    }

    /// The head's height before it is first drawn (for the scrollbar).
    fn head_estimate(&self, _page: &PageInfo) -> f32 {
        200.
    }

    /// The end's height before it is first drawn.
    fn end_estimate(&self, _page: &PageInfo) -> f32 {
        120.
    }
}

/// The rows of the empty-chapter hint the editor knows (the host adds its
/// own, such as search and the timeline with their keys): the heading
/// levels and the Markdown that makes them.
pub const EMPTY_HINTS: &[(&str, &str)] = &[("H1", "#"), ("H2", "##"), ("H3", "###")];

/// Prose-less section headings in a flattened book view, grouped around the
/// view's prose chapters.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct BookHeadings {
    pub before: Vec<Vec<crate::book::SectionHeading>>,
    pub chapters: Vec<(String, u32)>,
    pub after_last: Vec<crate::book::SectionHeading>,
}

impl BookHeadings {
    pub fn has_any(&self) -> bool {
        self.before.iter().any(|v| !v.is_empty()) || !self.after_last.is_empty()
    }
}

/// Renders one prose-less entry heading in the paper column, scaled by its
/// hierarchy `depth` relative to the starting level.
pub(crate) fn render_section_heading(
    heading: &crate::book::SectionHeading,
    style: &ProseStyle,
    first_in_scroll: bool,
    after_heading: bool,
) -> AnyElement {
    let (size, weight, color, top, bottom) = match heading.depth {
        0 => (
            style.title_size,
            FontWeight::BOLD,
            style.text,
            if first_in_scroll { px(56.) } else { px(88.) },
            px(20.),
        ),
        1 => (
            style.heading_sizes[0],
            FontWeight::SEMIBOLD,
            style.text,
            if first_in_scroll {
                px(48.)
            } else if after_heading {
                px(24.)
            } else {
                px(72.)
            },
            px(16.),
        ),
        2 => (
            style.heading_sizes[1],
            style.heading_weight,
            style.text,
            if after_heading { px(18.) } else { px(52.) },
            px(12.),
        ),
        _ => (
            style.heading_sizes[2],
            style.heading_weight,
            style.muted,
            if after_heading { px(14.) } else { px(40.) },
            px(10.),
        ),
    };
    let indent = px((heading.depth.saturating_sub(3) * 16) as f32);
    let selector = format!("book-section-heading-{}", heading.entry);
    let dbg = selector.clone();
    div()
        .id(ElementId::Name(selector.into()))
        .debug_selector(move || dbg.clone())
        .role(gpui::Role::Heading)
        .aria_label(heading.title.clone())
        .w_full()
        .px(style.gutter)
        .flex()
        .justify_center()
        .pt(top)
        .pb(bottom)
        .child(
            div()
                .max_w(style.max_width)
                .w_full()
                .pl(indent)
                .text_size(size)
                .line_height(relative(style.heading_line_height))
                .font_family(style.font_family.clone())
                .font_weight(weight)
                .text_color(color)
                .child(heading.title.clone()),
        )
        .into_any_element()
}

fn render_chapter_title_row(title: &str, style: &ProseStyle, after_heading: bool) -> AnyElement {
    let top = if after_heading { px(28.) } else { px(56.) };
    div()
        .w_full()
        .px(style.gutter)
        .flex()
        .justify_center()
        .pt(top)
        .pb(px(28.))
        .child(
            div()
                .max_w(style.max_width)
                .w_full()
                .text_size(style.title_size)
                .font_family(style.font_family.clone())
                .font_weight(FontWeight::BOLD)
                .text_color(style.text)
                .child(title.to_owned()),
        )
        .into_any_element()
}

const HEADING_ESTIMATE: f32 = 84.;

/// Each page's facts and the host's chrome, shared with the editor's slots.
#[derive(Default)]
pub(crate) struct Pages {
    infos: Rc<RefCell<Vec<PageInfo>>>,
    chrome: Option<Rc<dyn PageChrome>>,
    headings: Rc<RefCell<BookHeadings>>,
    style: Rc<RefCell<ProseStyle>>,
}

struct Slots {
    infos: Rc<RefCell<Vec<PageInfo>>>,
    chrome: Option<Rc<dyn PageChrome>>,
    headings: Rc<RefCell<BookHeadings>>,
    style: Rc<RefCell<ProseStyle>>,
}

impl Slots {
    fn page(&self, chapter: usize) -> Option<PageInfo> {
        self.infos.borrow().get(chapter).cloned()
    }
}

impl ChapterSlots for Slots {
    fn head(&self, chapter: usize, window: &mut Window, cx: &mut App) -> Option<AnyElement> {
        let (before, chapter_title) = {
            let h = self.headings.borrow();
            (
                h.before.get(chapter).cloned().unwrap_or_default(),
                h.chapters
                    .get(chapter)
                    .map(|(t, _)| t.clone())
                    .unwrap_or_default(),
            )
        };
        let chrome_head = self
            .chrome
            .as_ref()
            .and_then(|chrome| self.page(chapter).and_then(|p| chrome.head(&p, window, cx)));
        if before.is_empty() {
            return chrome_head;
        }
        let style = self.style.borrow().clone();
        let mut stack = div().w_full().flex().flex_col();
        for (ix, heading) in before.iter().enumerate() {
            stack = stack.child(render_section_heading(
                heading,
                &style,
                chapter == 0 && ix == 0,
                ix > 0,
            ));
        }
        let own =
            chrome_head.unwrap_or_else(|| render_chapter_title_row(&chapter_title, &style, true));
        Some(stack.child(own).into_any_element())
    }

    fn end(&self, chapter: usize, window: &mut Window, cx: &mut App) -> Option<AnyElement> {
        let after = {
            let h = self.headings.borrow();
            if chapter + 1 == h.chapters.len() {
                h.after_last.clone()
            } else {
                Vec::new()
            }
        };
        let chrome_end = self
            .chrome
            .as_ref()
            .and_then(|chrome| self.page(chapter).and_then(|p| chrome.end(&p, window, cx)));
        if after.is_empty() {
            return chrome_end;
        }
        let style = self.style.borrow().clone();
        let mut stack = div().w_full().flex().flex_col();
        if let Some(end) = chrome_end {
            stack = stack.child(end);
        }
        for (ix, heading) in after.iter().enumerate() {
            stack = stack.child(render_section_heading(heading, &style, false, ix > 0));
        }
        Some(stack.into_any_element())
    }

    fn head_estimate(&self, chapter: usize) -> f32 {
        let before_len = self
            .headings
            .borrow()
            .before
            .get(chapter)
            .map_or(0, Vec::len);
        let base = match &self.chrome {
            Some(chrome) => self
                .page(chapter)
                .map_or(200., |page| chrome.head_estimate(&page)),
            None if before_len > 0 => 96.,
            None => 160.,
        };
        before_len as f32 * HEADING_ESTIMATE + base
    }

    fn end_estimate(&self, chapter: usize) -> f32 {
        let after_len = {
            let h = self.headings.borrow();
            if chapter + 1 == h.chapters.len() {
                h.after_last.len()
            } else {
                0
            }
        };
        let base = match &self.chrome {
            Some(chrome) => self
                .page(chapter)
                .map_or(120., |page| chrome.end_estimate(&page)),
            None => 0.,
        };
        base + after_len as f32 * HEADING_ESTIMATE
    }
}

impl Pages {
    /// The page of chapter `ix` of the editor.
    pub fn info(&self, ix: usize) -> Option<PageInfo> {
        self.infos.borrow().get(ix).cloned()
    }

    pub fn has_chrome(&self) -> bool {
        self.chrome.is_some()
    }

    fn is_active(&self) -> bool {
        self.chrome.is_some() || self.headings.borrow().has_any()
    }

    /// Gives the editor the host's chrome (or takes it away).
    pub fn set_chrome(
        &mut self,
        chrome: Option<Rc<dyn PageChrome>>,
        editor: &Entity<ProseEditor>,
        cx: &mut App,
    ) {
        self.chrome = chrome;
        self.attach(editor, cx);
    }

    /// Updates the flattened book's prose-less section headings around its
    /// prose chapters.
    pub fn set_headings(&self, headings: BookHeadings, editor: &Entity<ProseEditor>, cx: &mut App) {
        let was_active = self.is_active();
        let changed: Vec<usize> = {
            let old = self.headings.borrow();
            let n = headings.chapters.len();
            let old_n = old.chapters.len();
            (0..n)
                .filter(|&ix| {
                    old.before.get(ix) != headings.before.get(ix)
                        || (headings.before.get(ix).is_some_and(|b| !b.is_empty())
                            && old.chapters.get(ix) != headings.chapters.get(ix))
                        || ((ix + 1 == n || ix + 1 == old_n)
                            && old.after_last != headings.after_last)
                })
                .collect()
        };
        *self.headings.borrow_mut() = headings;
        let now_active = self.is_active();
        if was_active != now_active {
            self.attach(editor, cx);
        } else if now_active && !changed.is_empty() {
            editor.update(cx, |e, cx| {
                for ix in changed {
                    e.slots_changed(ix, cx);
                }
            });
        }
    }

    /// Updates the prose style used when rendering prose-less section headings.
    pub fn set_style(&self, style: ProseStyle, editor: &Entity<ProseEditor>, cx: &mut App) {
        if *self.style.borrow() == style {
            return;
        }
        *self.style.borrow_mut() = style;
        if self.headings.borrow().has_any() {
            let affected: Vec<usize> = {
                let h = self.headings.borrow();
                let n = h.chapters.len();
                (0..n)
                    .filter(|&ix| {
                        h.before.get(ix).is_some_and(|b| !b.is_empty())
                            || (ix + 1 == n && !h.after_last.is_empty())
                    })
                    .collect()
            };
            editor.update(cx, |e, cx| {
                for ix in affected {
                    e.slots_changed(ix, cx);
                }
            });
        }
    }

    /// Puts the chrome / section headings on a new editor (the view rebuilt or switched it).
    pub fn attach(&self, editor: &Entity<ProseEditor>, cx: &mut App) {
        let slots = self.is_active().then(|| {
            Rc::new(Slots {
                infos: self.infos.clone(),
                chrome: self.chrome.clone(),
                headings: self.headings.clone(),
                style: self.style.clone(),
            }) as Rc<dyn ChapterSlots>
        });
        editor.update(cx, |e, cx| e.set_slots(slots, cx));
    }

    /// Reads every page's facts again: the workspace's for `docs` (the
    /// editor's chapters, in order), the counts from the editor's text.
    pub fn refresh(
        &self,
        ws: &Workspace,
        book: &str,
        docs: &[String],
        editor: &Entity<ProseEditor>,
        cx: &mut App,
    ) {
        let (mut infos, _) = read(ws, book, docs);
        let e = editor.read(cx);
        let book = e.book();
        for (info, chapter) in infos.iter_mut().zip(&book.chapters) {
            (info.words, info.empty) = counts(&chapter.doc);
        }
        let changed: Vec<usize> = {
            let old = self.infos.borrow();
            (0..infos.len())
                .filter(|&ix| old.get(ix) != infos.get(ix))
                .collect()
        };
        *self.infos.borrow_mut() = infos;
        if self.chrome.is_some() && !changed.is_empty() {
            editor.update(cx, |e, cx| {
                for ix in changed {
                    e.slots_changed(ix, cx);
                }
            });
        }
    }

    /// The text of chapter `ix` changed: its word count and emptiness, and
    /// the words of the act it is in (on the act's opening chapter).
    pub fn edited(&self, ix: usize, editor: &Entity<ProseEditor>, cx: &mut App) {
        let e = editor.read(cx);
        let (words, empty) = counts(&e.book().chapters[ix].doc);
        let mut changed = Vec::new();
        {
            let mut infos = self.infos.borrow_mut();
            if let Some(info) = infos.get_mut(ix)
                && (info.words, info.empty) != (words, empty)
            {
                (info.words, info.empty) = (words, empty);
                changed.push(ix);
            }
        }
        if !changed.is_empty() && self.chrome.is_some() {
            editor.update(cx, |e, cx| {
                for k in changed {
                    e.slots_changed(k, cx);
                }
            });
        }
    }
}

/// Words (prose-metrics) and whether the text is one empty paragraph.
pub fn counts(doc: &ProseDoc) -> (u64, bool) {
    let empty = doc.visible_lines() <= 1 && doc.lines().first().is_none_or(|l| l.text.is_empty());
    if empty {
        return (0, true);
    }
    let words = doc.lines()[..doc.visible_lines()]
        .iter()
        .map(|l| prose_metrics::count_words(&l.text))
        .sum();
    (words, false)
}

fn call(ws: &Workspace, name: &str, input: Value) -> Result<Value, WsError> {
    Ok(ws.call(&Actor::User, name, input)?["output"].clone())
}

/// The workspace's facts of each document (counts left at zero), and each
/// act's ordinal by the index of its first chapter in `docs`.
fn read(
    ws: &Workspace,
    book: &str,
    docs: &[String],
) -> (Vec<PageInfo>, std::collections::HashMap<usize, usize>) {
    (
        crate::v3::page_infos(ws, book, docs).unwrap_or_else(|error| {
            log::warn!("v3 page facts: {error}");
            docs.iter().map(|d| PageInfo::blank(d)).collect()
        }),
        Default::default(),
    )
}

/// Stores a new title the author typed on a chapter's or an idea's page.
/// Returns the stored title, or `None` when nothing was written (empty
/// after trimming: the field shows the stored title again; or unchanged).
pub fn rename(
    ws: &Workspace,
    book: &str,
    doc: &str,
    title: &str,
) -> Result<Option<String>, WsError> {
    let title = title.trim();
    if let Some((id, _)) = crate::v3::body(doc) {
        let current = call(ws, "entry.get", json!({"book": book, "id": id}))?;
        if title.is_empty() || current["title"].as_str() == Some(title) {
            return Ok(None);
        }
        call(
            ws,
            "entry.update",
            json!({"book": book, "id": id, "title": title}),
        )?;
        return Ok(Some(title.to_owned()));
    }
    Err(WsError::Invalid(
        "page title requires a canonical entry body".into(),
    ))
}

/// Stores the synopsis of a chapter's or an idea's page (trimmed; empty
/// clears it). Returns whether it changed.
pub fn set_synopsis(ws: &Workspace, book: &str, doc: &str, text: &str) -> Result<bool, WsError> {
    crate::v3::set_role_field(ws, book, doc, "summary", text.trim())
}

/// ⁂'s 「标为完成」 (`true`) or 「改回草稿」 (`false`).
pub fn set_finished(ws: &Workspace, book: &str, doc: &str, finished: bool) -> Result<(), WsError> {
    crate::v3::set_role_field(
        ws,
        book,
        doc,
        "status",
        if finished { "finished" } else { "draft" },
    )
    .map(|_| ())
}

/// ⁂'s 「新建下一章」: a draft chapter right after `doc` titled `title`
/// (the host's 「新章节」 / "New chapter"; a taken title gets a suffix).
/// Returns its prose document (`node:<id>`), for the host to open with the
/// title field focused.
pub fn new_chapter_after(
    ws: &Workspace,
    book: &str,
    doc: &str,
    title: &str,
) -> Result<String, WsError> {
    if let Some((id, module)) = crate::v3::body(doc) {
        let current = call(ws, "entry.get", json!({"book": book, "id": id}))?;
        let siblings = call(
            ws,
            "entry.list",
            json!({"book": book, "parent": current["parent"]}),
        )?;
        let index = siblings
            .as_array()
            .and_then(|xs| xs.iter().position(|e| e["id"].as_str() == Some(&id)))
            .map(|i| i + 1);
        let created = call(
            ws,
            "entry.create",
            json!({"book": book, "parent": current["parent"], "template": current["template"], "title": title}),
        )?;
        let new_id = created["id"]
            .as_str()
            .ok_or_else(|| WsError::Invalid("entry.create returned no id".into()))?;
        call(
            ws,
            "entry.move",
            json!({"book": book, "id": new_id, "parent": current["parent"], "index": index}),
        )?;
        return Ok(format!("body:{new_id}/{module}"));
    }
    Err(WsError::Invalid(
        "new sibling requires a canonical entry body".into(),
    ))
}
