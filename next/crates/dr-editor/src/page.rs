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
use gpui::{AnyElement, App, Entity, Window};
use gpui_prose::{ChapterSlots, ProseDoc, ProseEditor};
use serde_json::{Value, json};

/// What kind of page a prose document is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PageKind {
    Chapter,
    /// An idea (构想).
    Idea,
    /// Anything else with prose (an element, a storyline …): no folio facts.
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
    /// The prose document (`node:<id>`, …).
    pub doc: String,
    pub kind: PageKind,
    /// 「第 N 章」: the chapter's place among live chapters in reading order.
    pub number: Option<u32>,
    pub title: String,
    /// The synopsis (梗概).
    pub synopsis: String,
    /// `draft`, `finished` or `discarded` for a chapter; `drifting` or
    /// `resting` for an idea; empty otherwise.
    pub status: String,
    pub storyline: Option<StorylineMark>,
    /// Words in the text (prose-metrics' rule), as the editor holds it.
    pub words: u64,
    /// The text is one empty paragraph (the empty-chapter hint shows).
    pub empty: bool,
    /// In the whole-book view, the act this chapter opens: the host draws
    /// the act's title page above the chapter's head.
    pub act_opening: Option<String>,
    /// The same act's title page in full: 「第一幕」, its name, and 「N 章 ·
    /// x 千字」 (see [`ActPage`]).
    pub act_page: Option<ActPage>,
}

/// What an act's title page shows in the whole-book view.
#[derive(Clone, Debug, PartialEq)]
pub struct ActPage {
    pub name: String,
    /// 1 for 「第一幕」: the act's place among the acts of the book.
    pub ordinal: usize,
    /// The act's chapters (this one and those after it, up to the next act).
    pub chapters: usize,
    /// Their words (prose-metrics, as the folio line counts them), live.
    pub words: u64,
}

impl PageInfo {
    fn blank(doc: &str) -> PageInfo {
        PageInfo {
            doc: doc.to_owned(),
            kind: PageKind::Other,
            number: None,
            title: String::new(),
            synopsis: String::new(),
            status: String::new(),
            storyline: None,
            words: 0,
            empty: false,
            act_opening: None,
            act_page: None,
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

/// Each page's facts and the host's chrome, shared with the editor's slots.
#[derive(Default)]
pub(crate) struct Pages {
    infos: Rc<RefCell<Vec<PageInfo>>>,
    chrome: Option<Rc<dyn PageChrome>>,
    /// Each act's ordinal (「第一幕」) by its first chapter's index here:
    /// its place among all the book's acts, empty ones included.
    ordinals: RefCell<std::collections::HashMap<usize, usize>>,
}

struct Slots {
    infos: Rc<RefCell<Vec<PageInfo>>>,
    chrome: Rc<dyn PageChrome>,
}

impl Slots {
    fn page(&self, chapter: usize) -> Option<PageInfo> {
        self.infos.borrow().get(chapter).cloned()
    }
}

impl ChapterSlots for Slots {
    fn head(&self, chapter: usize, window: &mut Window, cx: &mut App) -> Option<AnyElement> {
        let page = self.page(chapter)?;
        self.chrome.head(&page, window, cx)
    }

    fn end(&self, chapter: usize, window: &mut Window, cx: &mut App) -> Option<AnyElement> {
        let page = self.page(chapter)?;
        self.chrome.end(&page, window, cx)
    }

    fn head_estimate(&self, chapter: usize) -> f32 {
        self.page(chapter)
            .map_or(200., |page| self.chrome.head_estimate(&page))
    }

    fn end_estimate(&self, chapter: usize) -> f32 {
        self.page(chapter)
            .map_or(120., |page| self.chrome.end_estimate(&page))
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

    /// Puts the chrome on a new editor (the view rebuilt or switched it).
    pub fn attach(&self, editor: &Entity<ProseEditor>, cx: &mut App) {
        let slots = self.chrome.clone().map(|chrome| {
            Rc::new(Slots {
                infos: self.infos.clone(),
                chrome,
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
        let (mut infos, ordinals) = read(ws, book, docs);
        let e = editor.read(cx);
        let book = e.book();
        for (ix, (info, chapter)) in infos.iter_mut().zip(&book.chapters).enumerate() {
            (info.words, info.empty) = counts(&chapter.doc);
            info.act_opening = book.act_opening(ix).map(|a| a.to_string());
        }
        act_pages(&mut infos, book.acts(), &ordinals);
        *self.ordinals.borrow_mut() = ordinals;
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
        let acts = e.book().acts().to_vec();
        let mut changed = Vec::new();
        {
            let mut infos = self.infos.borrow_mut();
            if let Some(info) = infos.get_mut(ix)
                && (info.words, info.empty) != (words, empty)
            {
                (info.words, info.empty) = (words, empty);
                changed.push(ix);
                let before: Vec<Option<ActPage>> =
                    infos.iter().map(|i| i.act_page.clone()).collect();
                act_pages(&mut infos, &acts, &self.ordinals.borrow());
                changed.extend(
                    (0..infos.len()).filter(|&k| k != ix && infos[k].act_page != before[k]),
                );
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

/// Each act's title page on the chapter that opens it (`acts`: the first
/// chapter of each act and its name, sorted, as the book keeps them).
fn act_pages(
    infos: &mut [PageInfo],
    acts: &[(usize, gpui::SharedString)],
    ordinals: &std::collections::HashMap<usize, usize>,
) {
    for info in infos.iter_mut() {
        info.act_page = None;
    }
    for (k, (first, name)) in acts.iter().enumerate() {
        let end = acts.get(k + 1).map_or(infos.len(), |(next, _)| *next);
        let Some(chapters) = infos.get(*first..end.min(infos.len())) else {
            continue;
        };
        let page = ActPage {
            name: name.to_string(),
            ordinal: ordinals.get(first).copied().unwrap_or(k + 1),
            chapters: chapters.len(),
            words: chapters.iter().map(|c| c.words).sum(),
        };
        infos[*first].act_page = Some(page);
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

fn str_of(v: &Value, k: &str) -> String {
    v[k].as_str().unwrap_or_default().to_owned()
}

/// The workspace's facts of each document (counts left at zero), and each
/// act's ordinal by the index of its first chapter in `docs`.
fn read(
    ws: &Workspace,
    book: &str,
    docs: &[String],
) -> (Vec<PageInfo>, std::collections::HashMap<usize, usize>) {
    let mut infos: Vec<PageInfo> = docs.iter().map(|d| PageInfo::blank(d)).collect();
    let ids: Vec<Option<&str>> = docs.iter().map(|d| d.strip_prefix("node:")).collect();
    let mut ordinals = std::collections::HashMap::new();
    if ids.iter().all(Option::is_none) {
        return (infos, ordinals);
    }
    // 「第 N 幕」 counts every act in the book's order, empty ones and the
    // book-head act included (the 0.1 client's `deriveActSegments`).
    if docs.len() > 1 {
        let index: std::collections::HashMap<&str, usize> = ids
            .iter()
            .enumerate()
            .filter_map(|(i, id)| id.map(|id| (id, i)))
            .collect();
        let acts = call(ws, "act.list", json!({ "book": book })).unwrap_or_default();
        for (k, act) in acts.as_array().into_iter().flatten().enumerate() {
            let first = act["chapters"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|c| index.get(c.as_str()?).copied())
                .min();
            if let Some(first) = first {
                ordinals.entry(first).or_insert(k + 1);
            }
        }
    }
    let chapters = call(ws, "chapter.list", json!({ "book": book })).unwrap_or_default();
    let storylines = call(ws, "storyline.list", json!({ "book": book })).unwrap_or_default();
    let storyline = |id: &str| {
        storylines
            .as_array()
            .into_iter()
            .flatten()
            .find(|s| s["id"].as_str() == Some(id))
            .map(|s| StorylineMark {
                id: id.to_owned(),
                name: str_of(s, "name"),
                color: str_of(s, "color"),
            })
    };
    let mut ideas: Option<Value> = None;
    for (info, id) in infos.iter_mut().zip(ids) {
        let Some(id) = id else { continue };
        if let Some(c) = chapters
            .as_array()
            .into_iter()
            .flatten()
            .find(|c| c["id"].as_str() == Some(id))
        {
            info.kind = PageKind::Chapter;
            info.number = c["number"].as_u64().map(|n| n as u32);
            info.title = str_of(c, "title");
            info.synopsis = str_of(c, "summary");
            info.status = str_of(c, "status");
            let primary = c["primary_storyline"]
                .as_str()
                .map(str::to_owned)
                .or_else(|| {
                    c["storylines"]
                        .as_array()
                        .and_then(|s| s.first())
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                });
            info.storyline = primary.as_deref().and_then(storyline);
            continue;
        }
        let ideas = ideas.get_or_insert_with(|| {
            call(ws, "idea.list", json!({ "book": book })).unwrap_or_default()
        });
        if let Some(i) = ideas
            .as_array()
            .into_iter()
            .flatten()
            .find(|i| i["id"].as_str() == Some(id))
        {
            info.kind = PageKind::Idea;
            info.title = str_of(i, "title");
            info.synopsis = str_of(i, "summary");
            info.status = str_of(i, "status");
        }
    }
    (infos, ordinals)
}

fn chapter_id(doc: &str) -> Result<&str, WsError> {
    doc.strip_prefix("node:")
        .ok_or_else(|| WsError::Invalid(format!("not a chapter: {doc}")))
}

/// Where a page's title and synopsis live: a chapter (`chapter.update`) or
/// an idea (`idea.update`), with the stored values.
fn titled(ws: &Workspace, book: &str, doc: &str) -> Result<(&'static str, Value), WsError> {
    let id = chapter_id(doc)?;
    let find = |list: Value| {
        list.as_array()
            .into_iter()
            .flatten()
            .find(|c| c["id"].as_str() == Some(id))
            .cloned()
    };
    if let Some(c) = find(call(ws, "chapter.list", json!({ "book": book }))?) {
        return Ok(("chapter.update", c));
    }
    if let Some(i) = find(call(ws, "idea.list", json!({ "book": book }))?) {
        return Ok(("idea.update", i));
    }
    Err(WsError::NotFound {
        what: "chapter or idea",
        id: id.to_owned(),
    })
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
    let (command, current) = titled(ws, book, doc)?;
    if title.is_empty() || current["title"].as_str() == Some(title) {
        return Ok(None);
    }
    let out = call(
        ws,
        command,
        json!({ "book": book, "id": chapter_id(doc)?, "title": title }),
    )?;
    Ok(Some(
        out["title"]
            .as_str()
            .or(out["name"].as_str())
            .unwrap_or(title)
            .to_owned(),
    ))
}

/// Stores the synopsis of a chapter's or an idea's page (trimmed; empty
/// clears it). Returns whether it changed.
pub fn set_synopsis(ws: &Workspace, book: &str, doc: &str, text: &str) -> Result<bool, WsError> {
    let text = text.trim();
    let (command, current) = titled(ws, book, doc)?;
    if current["summary"].as_str() == Some(text) {
        return Ok(false);
    }
    call(
        ws,
        command,
        json!({ "book": book, "id": chapter_id(doc)?, "summary": text }),
    )?;
    Ok(true)
}

/// ⁂'s 「标为完成」 (`true`) or 「改回草稿」 (`false`).
pub fn set_finished(ws: &Workspace, book: &str, doc: &str, finished: bool) -> Result<(), WsError> {
    let status = if finished { "finished" } else { "draft" };
    call(
        ws,
        "chapter.update",
        json!({ "book": book, "id": chapter_id(doc)?, "status": status }),
    )?;
    Ok(())
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
    let out = call(
        ws,
        "chapter.create",
        json!({ "book": book, "title": title, "place": { "after": chapter_id(doc)? } }),
    )?;
    Ok(format!("node:{}", str_of(&out, "id")))
}
