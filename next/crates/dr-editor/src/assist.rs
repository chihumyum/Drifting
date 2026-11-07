//! What the editor does around the author's typing (F4e, second batch):
//! the @ picker, the slash menu, automatic entity links and their repair,
//! and the selection bar. One [`Assist`] sits beside each editor view
//! ([`crate::ChapterEditor`], [`crate::BookEditor`]); the view puts its
//! overlay next to the editor and its key handlers around it ([`wrap`]).
//!
//! The 0.1 client's rules (`entity-mention-suggestion.ts`,
//! `slash-menu.ts`, `editor-selection-bar.ts`), and where they changed:
//!
//! - **@ picker.** `@` (or the full-width `＠`) opens it at a paragraph's
//!   start, after a space, or after any character that is not an ASCII
//!   letter or digit, so `他@` in a Chinese sentence opens it too (the 0.1
//!   client needed a space before it, a Tiptap default nobody chose) while
//!   `a@b.c` does not. The query runs to the caret and stops at whitespace.
//!   Rows: element names and aliases (each alias its own row), then chapter
//!   and idea titles, those containing the query (case-insensitive), at most
//!   30; then 「创建要素「名字」」 when no element is called that. ↑↓ move
//!   (and wrap), Enter or a click chooses, Esc closes and leaves the text;
//!   it stays closed until the trigger goes. Choosing replaces `@query` with
//!   the name linked to its target and a space, one undo step. Creating
//!   makes the element (in the book's first category) and links it.
//! - **Slash menu.** `/` (or `／`) anywhere; the query stops at whitespace.
//!   Rows: 正文, 一级标题, 二级标题, 三级标题, 引用, 分隔线, matched by
//!   their words or by `h1`, `quote`, `rule` …. Choosing removes `/query`
//!   and changes the paragraph, one undo step. With no matching row nothing
//!   shows (the 0.1 client showed an empty menu).
//! - **Automatic links and repair**: [`crate::entity_links`].
//! - **Selection bar.** 180 ms after a selection with words in it settles
//!   (the mouse up), a horizontal bar floats 8 px above it (below when there
//!   is no room): 正文, H1, H2, H3, 引用 | 粗体, 斜体, 下划线, 删除线 |
//!   添加批注. The 0.1 client's 格式 flyout is laid out in the bar itself;
//!   新建补丁 has no counterpart in the new client yet. It hides on typing,
//!   on a new selection (and comes back when that settles), when the editor
//!   loses focus, and on Esc. Never on a right click: there are no custom
//!   context menus.

use std::ops::Range;
use std::rc::Rc;
use std::time::Duration;

use dr_model::kind::EntityKind;
use dr_text::autolink::LinkTarget;
use dr_ui::components::{Align, IconButton, Layer, Menu, MenuItem, MenuWidth, Place, RowIcon};
use dr_ui::sand::{self, Icon};
use dr_ui::theme::Theme;
use dr_workspace::{Actor, Workspace};
use gpui::{
    App, Bounds, Context, Entity, EventEmitter, InteractiveElement, IntoElement, KeyDownEvent,
    ParentElement, Pixels, Render, SharedString, Styled, Subscription, Task, Window, div, point,
    px, size,
};
use gpui_prose::input::actions::{MoveDown, MoveUp, Newline, SetBody, SetH1, SetH2, SetH3};
use gpui_prose::schema::{block, inline};
use gpui_prose::text::{BlockKind, ORIGIN_USER};
use gpui_prose::{EditorEvent, HostStep, ProseEditor};
use loro::LoroValue;
use serde_json::json;

use crate::entity_links::{self, NameIndex};

/// The pause after typing before automatic links are written.
pub const LINK_DELAY: Duration = Duration::from_millis(500);
/// How long a selection rests before its bar shows.
pub const BAR_DELAY: Duration = Duration::from_millis(180);
const MAX_ROWS: usize = 30;
const MAX_QUERY: usize = 32;
const BAR_BUTTON: f32 = 30.;
const BAR_PAD: f32 = 4.;
const BAR_GAP: f32 = 8.;

/// Which picker is open.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MenuKind {
    /// `@`: entity links.
    Mention,
    /// `/`: paragraph formats.
    Slash,
}

/// A paragraph format of the slash menu.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlockChoice {
    Body,
    H1,
    H2,
    H3,
    Quote,
    Rule,
}

impl BlockChoice {
    pub const ALL: [BlockChoice; 6] = [
        BlockChoice::Body,
        BlockChoice::H1,
        BlockChoice::H2,
        BlockChoice::H3,
        BlockChoice::Quote,
        BlockChoice::Rule,
    ];

    pub fn label(self) -> &'static str {
        match self {
            BlockChoice::Body => "正文",
            BlockChoice::H1 => "一级标题",
            BlockChoice::H2 => "二级标题",
            BlockChoice::H3 => "三级标题",
            BlockChoice::Quote => "引用",
            BlockChoice::Rule => "分隔线",
        }
    }

    /// What else finds it in the slash menu.
    fn words(self) -> &'static [&'static str] {
        match self {
            BlockChoice::Body => &["body", "text", "paragraph", "p"],
            BlockChoice::H1 => &["h1", "#"],
            BlockChoice::H2 => &["h2", "##"],
            BlockChoice::H3 => &["h3", "###"],
            BlockChoice::Quote => &["quote", ">"],
            BlockChoice::Rule => &["rule", "hr", "---", "divider"],
        }
    }

    fn icon(self) -> Icon {
        match self {
            BlockChoice::Body => Icon::FmtParagraph,
            BlockChoice::H1 => Icon::FmtH1,
            BlockChoice::H2 => Icon::FmtH2,
            BlockChoice::H3 => Icon::FmtH3,
            BlockChoice::Quote => Icon::FmtQuote,
            BlockChoice::Rule => Icon::Minus,
        }
    }

    fn matches(self, query: &str) -> bool {
        let q = query.to_lowercase();
        self.label().contains(&q) || self.words().iter().any(|w| w.starts_with(&q))
    }
}

/// A row of an open picker.
#[derive(Clone, Debug, PartialEq)]
pub enum MenuRow {
    /// Link to `target` under `name` (an alias is a row of its own), in
    /// the picker's `group` (要素, 章节, 构想).
    Link {
        name: String,
        target: LinkTarget,
        group: entity_links::NameGroup,
    },
    /// 「创建要素「name」」.
    Create {
        name: String,
    },
    Block(BlockChoice),
}

/// The open picker: where its trigger is and what it offers.
#[derive(Clone, Debug, PartialEq)]
pub struct OpenMenu {
    pub kind: MenuKind,
    pub chapter: usize,
    /// The trigger character's offset in the chapter.
    pub at: usize,
    /// What was typed after the trigger.
    pub query: String,
    pub rows: Vec<MenuRow>,
    pub selected: usize,
}

/// Finds a picker trigger in a paragraph's text before the caret: the kind,
/// the trigger's offset in `before` (characters), and the query after it.
pub fn trigger(before: &str) -> Option<(MenuKind, usize, String)> {
    let chars: Vec<char> = before.chars().collect();
    let mut query = Vec::new();
    for (ix, &c) in chars.iter().enumerate().rev() {
        let kind = match c {
            '@' | '＠' => Some(MenuKind::Mention),
            '/' | '／' => Some(MenuKind::Slash),
            _ => None,
        };
        if let Some(kind) = kind {
            if kind == MenuKind::Mention
                && ix > 0
                && (chars[ix - 1].is_ascii_alphanumeric() || chars[ix - 1] == '@')
            {
                return None;
            }
            query.reverse();
            return Some((kind, ix, query.into_iter().collect()));
        }
        if c.is_whitespace() || query.len() >= MAX_QUERY {
            return None;
        }
        query.push(c);
    }
    None
}

/// What the assist tells its view.
#[derive(Clone, Debug, PartialEq)]
pub enum AssistEvent {
    /// The selection bar's 添加批注: the host opens its comment composer on
    /// `range` of chapter `chapter`.
    Comment { chapter: usize, range: Range<usize> },
}

/// The pickers, automatic links and selection bar of one editor.
pub struct Assist {
    ws: Workspace,
    book: String,
    /// Each chapter's prose document (`node:<id>`, …), in the editor's order.
    docs: Vec<String>,
    editor: Entity<ProseEditor>,
    names: Option<Rc<NameIndex>>,
    auto_links: bool,
    /// Paragraphs typed in since the last automatic-link pass: chapter, block
    /// id, and the line index when it has none.
    pending: Vec<(usize, Option<String>, usize)>,
    link_task: Option<Task<()>>,
    /// Each chapter's author undo count after the last event (an undo
    /// lowers it).
    undo_counts: Vec<usize>,
    /// Each chapter's paragraph count after the last event (Enter raises
    /// it).
    line_counts: Vec<usize>,
    menu: Option<OpenMenu>,
    /// The menu opened at a new trigger since it was last drawn.
    menu_fresh: bool,
    /// A trigger the author closed with Esc: chapter and offset.
    dismissed: Option<(usize, usize)>,
    bar: Option<(usize, Range<usize>)>,
    bar_task: Option<Task<()>>,
    /// The assist's own edit is running (its events are not the author's).
    writing: bool,
    _editor_events: Subscription,
}

impl EventEmitter<AssistEvent> for Assist {}

impl Assist {
    pub fn new(
        ws: Workspace,
        book: &str,
        editor: Entity<ProseEditor>,
        docs: Vec<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Assist {
        let events = cx.subscribe_in(&editor, window, |this, _, event, window, cx| {
            this.on_editor(event, window, cx)
        });
        let undo_counts = Self::counts(&editor, cx);
        let line_counts = Self::lines(&editor, cx);
        Assist {
            ws,
            book: book.to_owned(),
            docs,
            editor,
            names: None,
            auto_links: true,
            pending: Vec::new(),
            link_task: None,
            undo_counts,
            line_counts,
            menu: None,
            menu_fresh: false,
            dismissed: None,
            bar: None,
            bar_task: None,
            writing: false,
            _editor_events: events,
        }
    }

    fn lines(editor: &Entity<ProseEditor>, cx: &App) -> Vec<usize> {
        editor
            .read(cx)
            .book()
            .chapters
            .iter()
            .map(|c| c.doc.visible_lines())
            .collect()
    }

    fn counts(editor: &Entity<ProseEditor>, cx: &App) -> Vec<usize> {
        editor
            .read(cx)
            .book()
            .chapters
            .iter()
            .map(|c| c.doc.undo_count())
            .collect()
    }

    /// Follows a new editor (the view switched or rebuilt it).
    pub fn attach(
        &mut self,
        editor: Entity<ProseEditor>,
        docs: Vec<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self._editor_events = cx.subscribe_in(&editor, window, |this, _, event, window, cx| {
            this.on_editor(event, window, cx)
        });
        self.undo_counts = Self::counts(&editor, cx);
        self.line_counts = Self::lines(&editor, cx);
        self.editor = editor;
        self.docs = docs;
        self.pending.clear();
        self.link_task = None;
        self.menu = None;
        self.dismissed = None;
        self.hide_bar();
        cx.notify();
    }

    /// The book's names changed (an element renamed, a chapter added …).
    pub fn invalidate_names(&mut self) {
        self.names = None;
    }

    /// The setting `editor.auto_entity_links`.
    pub fn set_auto_links(&mut self, on: bool) {
        self.auto_links = on;
        if !on {
            self.pending.clear();
            self.link_task = None;
        }
    }

    pub fn menu(&self) -> Option<&OpenMenu> {
        self.menu.as_ref()
    }

    /// The selection the bar shows for, if it shows.
    pub fn bar(&self) -> Option<&(usize, Range<usize>)> {
        self.bar.as_ref()
    }

    fn names(&mut self) -> Option<Rc<NameIndex>> {
        if self.names.is_none() {
            match NameIndex::load(&self.ws, &self.book, &[]) {
                Ok(names) => self.names = Some(Rc::new(names)),
                Err(e) => log::warn!("dr-editor: names of {}: {e}", self.book),
            }
        }
        self.names.clone()
    }

    /// The target id of chapter `chapter`'s own document (never linked).
    fn own_id(&self, chapter: usize) -> Option<&str> {
        self.docs
            .get(chapter)
            .and_then(|d| d.split_once(':'))
            .map(|(_, id)| id)
    }

    // ----- the editor's events -------------------------------------------------------

    fn on_editor(&mut self, event: &EditorEvent, window: &mut Window, cx: &mut Context<Self>) {
        if self.writing {
            return;
        }
        match event {
            EditorEvent::Edited { chapter } => {
                let chapter = *chapter;
                let now = self.editor.read(cx).book().chapters[chapter]
                    .doc
                    .undo_count();
                let before = self.undo_counts.get(chapter).copied().unwrap_or(now);
                if let Some(c) = self.undo_counts.get_mut(chapter) {
                    *c = now;
                }
                self.hide_bar();
                if now < before {
                    // An undo: nothing of it is the author's typing.
                    self.line_counts = Self::lines(&self.editor, cx);
                    self.menu = None;
                    cx.notify();
                    return;
                }
                self.repair(chapter, window, cx);
                self.note_typing(chapter, window, cx);
                self.update_menu(cx);
            }
            EditorEvent::SelectionChanged => {
                self.update_menu(cx);
                self.schedule_bar(window, cx);
            }
            _ => {}
        }
    }

    // ----- automatic links and repair -----------------------------------------------

    fn repair(&mut self, chapter: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(names) = self.names() else { return };
        let (line_ix, caret, edits) = {
            let e = self.editor.read(cx);
            let sel = e.selection();
            if sel.chapter != chapter || !sel.is_empty() || e.composition().is_some() {
                return;
            }
            let doc = &e.book().chapters[chapter].doc;
            let line_ix = doc.line_of(sel.head);
            let line = doc.line(line_ix);
            let caret = sel.head - doc.line_start(line_ix);
            let runs = entity_links::link_runs(line);
            (
                line_ix,
                caret,
                entity_links::repairs(&line.text, &runs, caret, &names),
            )
        };
        let _ = caret;
        if edits.is_empty() {
            return;
        }
        self.write(chapter, HostStep::JoinLast, window, cx, move |doc| {
            entity_links::apply(doc, line_ix, &edits);
            None
        });
    }

    fn note_typing(&mut self, chapter: usize, window: &mut Window, cx: &mut Context<Self>) {
        if !self.auto_links {
            self.line_counts = Self::lines(&self.editor, cx);
            return;
        }
        let e = self.editor.read(cx);
        let sel = e.selection();
        if sel.chapter != chapter {
            return;
        }
        let doc = &e.book().chapters[chapter].doc;
        let line_ix = doc.line_of(sel.head);
        let bid = doc.line(line_ix).bid().map(str::to_owned);
        // Enter split a paragraph, or a paste brought several: every
        // paragraph the edit added above the caret's was typed in too (and a
        // block id may have moved down with its paragraph's end).
        let lines = doc.visible_lines();
        let added = self
            .line_counts
            .get(chapter)
            .map_or(0, |&before| lines.saturating_sub(before));
        if let Some(c) = self.line_counts.get_mut(chapter) {
            *c = lines;
        }
        let above = (1..=added.min(line_ix))
            .map(|k| line_ix - k)
            .map(|ix| (chapter, doc.line(ix).bid().map(str::to_owned), ix));
        for entry in std::iter::once((chapter, bid, line_ix)).chain(above) {
            if !self.pending.contains(&entry) {
                self.pending.push(entry);
            }
        }
        self.link_task = Some(cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(LINK_DELAY).await;
            this.update_in(cx, |this, window, cx| this.link_pass(window, cx))
                .ok();
        }));
    }

    /// Writes the automatic links of the paragraphs typed in.
    pub fn link_pass(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.link_task = None;
        let Some(names) = self.names() else {
            self.pending.clear();
            return;
        };
        let pending = std::mem::take(&mut self.pending);
        let mut later = Vec::new();
        for (chapter, bid, line_hint) in pending {
            let plan = {
                let e = self.editor.read(cx);
                if e.composition().is_some_and(|c| c.chapter == chapter) {
                    later.push((chapter, bid, line_hint));
                    continue;
                }
                let Some(c) = e.book().chapters.get(chapter) else {
                    continue;
                };
                let doc = &c.doc;
                let line_ix = match &bid {
                    Some(b) => doc.line_by_bid(b),
                    None => (line_hint < doc.visible_lines()).then_some(line_hint),
                };
                let Some(line_ix) = line_ix else { continue };
                let line = doc.line(line_ix);
                let runs = entity_links::link_runs(line);
                let own = self.own_id(chapter);
                let edits: Vec<_> = entity_links::autolink(&line.text, &runs, &names)
                    .into_iter()
                    .filter(|edit| match edit {
                        entity_links::LinkEdit::Link { target, .. } => {
                            Some(target.id.as_str()) != own
                        }
                        _ => true,
                    })
                    .collect();
                (line_ix, edits)
            };
            let (line_ix, edits) = plan;
            if edits.is_empty() {
                continue;
            }
            self.write(chapter, HostStep::JoinLast, window, cx, move |doc| {
                entity_links::apply(doc, line_ix, &edits);
                None
            });
        }
        if !later.is_empty() {
            self.pending = later;
            self.link_task = Some(cx.spawn_in(window, async move |this, cx| {
                cx.background_executor().timer(LINK_DELAY).await;
                this.update_in(cx, |this, window, cx| this.link_pass(window, cx))
                    .ok();
            }));
        }
    }

    /// An edit of the assist's own, folded in like the author's.
    fn write(
        &mut self,
        chapter: usize,
        step: HostStep,
        window: &mut Window,
        cx: &mut Context<Self>,
        f: impl FnOnce(&mut gpui_prose::ProseDoc) -> Option<usize>,
    ) -> bool {
        self.writing = true;
        let done = self
            .editor
            .update(cx, |e, cx| e.edit_chapter(chapter, step, window, cx, f));
        self.writing = false;
        self.undo_counts = Self::counts(&self.editor, cx);
        self.line_counts = Self::lines(&self.editor, cx);
        done
    }

    // ----- pickers ------------------------------------------------------------------

    fn update_menu(&mut self, cx: &mut Context<Self>) {
        let found = {
            let e = self.editor.read(cx);
            if e.composition().is_some() {
                // The query is being composed: keep the menu as it is.
                return;
            }
            let sel = e.selection();
            if !sel.is_empty() {
                None
            } else {
                let doc = &e.book().chapters[sel.chapter].doc;
                let line_ix = doc.line_of(sel.head);
                let start = doc.line_start(line_ix);
                let before: String = doc
                    .line(line_ix)
                    .text
                    .chars()
                    .take(sel.head - start)
                    .collect();
                trigger(&before).map(|(kind, at, query)| (kind, sel.chapter, start + at, query))
            }
        };
        let Some((kind, chapter, at, query)) = found else {
            self.dismissed = None;
            if self.menu.take().is_some() {
                cx.notify();
            }
            return;
        };
        if self.dismissed == Some((chapter, at)) {
            return;
        }
        let rows = self.rows(kind, chapter, &query);
        let selected = match &self.menu {
            Some(m) if m.chapter == chapter && m.at == at && m.query == query => {
                m.selected.min(rows.len().saturating_sub(1))
            }
            _ => 0,
        };
        self.menu_fresh |= !self
            .menu
            .as_ref()
            .is_some_and(|m| m.chapter == chapter && m.at == at);
        self.menu = (!rows.is_empty()).then_some(OpenMenu {
            kind,
            chapter,
            at,
            query,
            rows,
            selected,
        });
        cx.notify();
    }

    fn rows(&mut self, kind: MenuKind, chapter: usize, query: &str) -> Vec<MenuRow> {
        match kind {
            MenuKind::Slash => BlockChoice::ALL
                .into_iter()
                .filter(|c| c.matches(query))
                .map(MenuRow::Block)
                .collect(),
            MenuKind::Mention => {
                let Some(names) = self.names() else {
                    return Vec::new();
                };
                let own = self.own_id(chapter).map(str::to_owned);
                let mut rows: Vec<MenuRow> = names
                    .search(query, MAX_ROWS + 1)
                    .into_iter()
                    .filter(|(_, t, _)| Some(&t.id) != own.as_ref())
                    .take(MAX_ROWS)
                    .map(|(name, target, group)| MenuRow::Link {
                        name,
                        target,
                        group,
                    })
                    .collect();
                let q = query.trim();
                if !q.is_empty() && !names.has_element_named(q) {
                    rows.push(MenuRow::Create { name: q.to_owned() });
                }
                rows
            }
        }
    }

    /// Moves the picker's current row by `delta`, wrapping.
    pub fn move_selection(&mut self, delta: isize, cx: &mut Context<Self>) {
        if let Some(m) = &mut self.menu {
            let n = m.rows.len() as isize;
            m.selected = ((m.selected as isize + delta).rem_euclid(n)) as usize;
            cx.notify();
        }
    }

    /// Esc: the picker closes and stays closed for this trigger.
    pub fn dismiss(&mut self, cx: &mut Context<Self>) {
        if let Some(m) = self.menu.take() {
            self.dismissed = Some((m.chapter, m.at));
        }
        self.hide_bar();
        cx.notify();
    }

    /// Chooses row `ix` of the open picker (the current one when `None`).
    pub fn choose(&mut self, ix: Option<usize>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(menu) = self.menu.take() else { return };
        let Some(row) = menu.rows.get(ix.unwrap_or(menu.selected)).cloned() else {
            return;
        };
        let (chapter, at) = (menu.chapter, menu.at);
        let caret = {
            let sel = self.editor.read(cx).selection();
            if sel.chapter != chapter {
                return;
            }
            sel.head
        };
        match row {
            MenuRow::Link { name, target, .. } => {
                self.insert_link(chapter, at..caret, &name, &target, window, cx);
            }
            MenuRow::Create { name } => match self.create_element(&name) {
                Ok(target) => {
                    self.names = None;
                    self.insert_link(chapter, at..caret, &name, &target, window, cx);
                }
                Err(e) => {
                    log::warn!("dr-editor: creating element {name}: {e}");
                    self.write(chapter, HostStep::Own, window, cx, |doc| {
                        doc.delete(at..caret, ORIGIN_USER);
                        Some(at)
                    });
                }
            },
            MenuRow::Block(choice) => self.apply_block(chapter, at..caret, choice, window, cx),
        }
        self.dismissed = None;
        cx.notify();
    }

    fn insert_link(
        &mut self,
        chapter: usize,
        range: Range<usize>,
        name: &str,
        target: &LinkTarget,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let key = inline::entity_key(&target.id);
        let value = entity_links::link_value(target);
        let text = format!("{name} ");
        let len = name.chars().count();
        self.write(chapter, HostStep::Own, window, cx, move |doc| {
            doc.replace(range.clone(), &text, ORIGIN_USER);
            doc.mark(range.start..range.start + len, &key, value, ORIGIN_USER);
            Some(range.start + len + 1)
        });
    }

    fn create_element(&self, name: &str) -> Result<LinkTarget, String> {
        let category = self
            .ws
            .call(&Actor::User, "category.list", json!({ "book": self.book }))
            .ok()
            .and_then(|out| out["output"][0]["id"].as_str().map(str::to_owned));
        let mut input = json!({ "book": self.book, "name": name });
        if let Some(c) = category {
            input["category"] = c.into();
        }
        let out = self
            .ws
            .call(&Actor::User, "element.create", input)
            .map_err(|e| e.to_string())?;
        let id = out["output"]["id"]
            .as_str()
            .ok_or("element.create gave no id")?;
        Ok(LinkTarget::new(EntityKind::Element, id))
    }

    fn apply_block(
        &mut self,
        chapter: usize,
        range: Range<usize>,
        choice: BlockChoice,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.write(chapter, HostStep::Own, window, cx, move |doc| {
            doc.delete(range.clone(), ORIGIN_USER);
            let at = range.start;
            let ix = doc.line_of(at);
            let quote = |doc: &mut gpui_prose::ProseDoc, ix: usize, on: bool| {
                doc.set_block_attr(
                    ix,
                    block::QUOTE,
                    on.then_some(LoroValue::Bool(true)),
                    ORIGIN_USER,
                )
            };
            match choice {
                BlockChoice::Body => {
                    doc.set_kind(ix, BlockKind::Body, ORIGIN_USER);
                    quote(doc, ix, false);
                }
                BlockChoice::H1 => doc.set_kind(ix, BlockKind::H1, ORIGIN_USER),
                BlockChoice::H2 => doc.set_kind(ix, BlockKind::H2, ORIGIN_USER),
                BlockChoice::H3 => doc.set_kind(ix, BlockKind::H3, ORIGIN_USER),
                BlockChoice::Quote => quote(doc, ix, true),
                BlockChoice::Rule => {
                    // The rule is an empty paragraph of its own, where the
                    // caret was; the caret goes on after it.
                    let start = doc.line_start(ix);
                    let end = start + doc.line(ix).chars;
                    let rule_ix = if start == end {
                        ix
                    } else if at == start {
                        doc.split(at, ORIGIN_USER);
                        ix
                    } else if at == end {
                        doc.split(at, ORIGIN_USER);
                        ix + 1
                    } else {
                        doc.split(at, ORIGIN_USER);
                        doc.split(doc.line_start(ix + 1), ORIGIN_USER);
                        ix + 1
                    };
                    // A paragraph after it for the caret. Splitting moves the
                    // paragraph's own newline (its attributes) down, so every
                    // attribute is set after the splits.
                    if rule_ix + 1 >= doc.visible_lines() {
                        let end = doc.line_start(rule_ix) + doc.line(rule_ix).chars;
                        doc.split(end, ORIGIN_USER);
                    }
                    for key in [block::HEADING, block::QUOTE] {
                        doc.set_block_attr(rule_ix, key, None, ORIGIN_USER);
                    }
                    doc.set_block_attr(
                        rule_ix,
                        block::RULE,
                        Some(LoroValue::Bool(true)),
                        ORIGIN_USER,
                    );
                    let next = rule_ix + 1;
                    doc.set_block_attr(next, block::RULE, None, ORIGIN_USER);
                    return Some(doc.line_start(next));
                }
            }
            Some(at)
        });
    }

    // ----- selection bar ------------------------------------------------------------

    fn hide_bar(&mut self) {
        self.bar = None;
        self.bar_task = None;
    }

    fn schedule_bar(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.hide_bar();
        let sel = self.editor.read(cx).selection();
        if sel.is_empty() {
            cx.notify();
            return;
        }
        self.bar_task = Some(cx.spawn_in(window, async move |this, cx| {
            loop {
                cx.background_executor().timer(BAR_DELAY).await;
                let again = this
                    .update_in(cx, |this, window, cx| this.show_bar(window, cx))
                    .unwrap_or(false);
                if !again {
                    break;
                }
            }
        }));
        cx.notify();
    }

    /// Shows the bar if the selection settled; true to look again later (the
    /// mouse is still down).
    fn show_bar(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let e = self.editor.read(cx);
        if e.is_selecting() {
            return true;
        }
        let sel = e.selection();
        if sel.is_empty() || e.composition().is_some() {
            return false;
        }
        let focused = gpui::Focusable::focus_handle(e, cx).is_focused(window);
        let doc = &e.book().chapters[sel.chapter].doc;
        let words = !doc.slice(sel.range()).trim().is_empty();
        if focused && words {
            self.bar = Some((sel.chapter, sel.range()));
            self.bar_task = None;
            cx.notify();
        }
        false
    }

    /// The bar's paragraph buttons (正文, H1–H3, 引用 toggles).
    pub fn bar_block(&mut self, choice: BlockChoice, window: &mut Window, cx: &mut Context<Self>) {
        match choice {
            BlockChoice::Quote => {
                let Some((chapter, range)) = self.bar.clone() else {
                    return;
                };
                self.write(chapter, HostStep::Own, window, cx, move |doc| {
                    let lines = doc.line_of(range.start)..=doc.line_of(range.end);
                    let all = lines
                        .clone()
                        .all(|ix| doc.line(ix).block.get(block::QUOTE).is_some());
                    for ix in lines {
                        doc.set_block_attr(
                            ix,
                            block::QUOTE,
                            (!all).then_some(LoroValue::Bool(true)),
                            ORIGIN_USER,
                        );
                    }
                    None
                });
            }
            BlockChoice::Body => window.dispatch_action(Box::new(SetBody), cx),
            BlockChoice::H1 => window.dispatch_action(Box::new(SetH1), cx),
            BlockChoice::H2 => window.dispatch_action(Box::new(SetH2), cx),
            BlockChoice::H3 => window.dispatch_action(Box::new(SetH3), cx),
            BlockChoice::Rule => {}
        }
        self.hide_bar();
        cx.notify();
    }

    /// The bar's mark buttons (粗体, 斜体, 下划线, 删除线).
    pub fn bar_mark(&mut self, key: &'static str, window: &mut Window, cx: &mut Context<Self>) {
        self.editor
            .update(cx, |e, cx| e.toggle_mark(key, window, cx));
        self.hide_bar();
        cx.notify();
    }

    /// The bar's 添加批注.
    pub fn bar_comment(&mut self, cx: &mut Context<Self>) {
        if let Some((chapter, range)) = self.bar.take() {
            cx.emit(AssistEvent::Comment { chapter, range });
        }
        self.bar_task = None;
        cx.notify();
    }

    // ----- drawing ------------------------------------------------------------------

    fn menu_element(
        &self,
        menu: &OpenMenu,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        use entity_links::NameGroup;
        let this = cx.entity();
        let theme = Theme::of(window, cx);
        let mut list = Menu::new("dr-editor-picker").width(MenuWidth::Wide);
        let mut section: Option<NameGroup> = None;
        for (ix, row) in menu.rows.iter().enumerate() {
            // Each group under its heading; 创建要素 after a hairline.
            match row {
                MenuRow::Link { group, .. } if section != Some(*group) => {
                    if section.is_some() {
                        list = list.separator(&theme);
                    }
                    list = list.section(group.label(), &theme);
                    section = Some(*group);
                }
                MenuRow::Create { .. } if section.is_some() => {
                    list = list.separator(&theme);
                }
                _ => {}
            }
            let (icon, label, trailing): (RowIcon, SharedString, Option<&str>) = match row {
                MenuRow::Link { name, group, .. } => {
                    let kind = match group {
                        NameGroup::Element => sand::Kind::Element,
                        NameGroup::Chapter => sand::Kind::Chapter(0),
                        NameGroup::Idea => sand::Kind::Drift { loose: false },
                        NameGroup::Other => sand::Kind::Category,
                    };
                    (RowIcon::Mark(kind, None), name.clone().into(), None)
                }
                MenuRow::Create { name } => (
                    Icon::Plus.into(),
                    format!("创建要素「{name}」").into(),
                    None,
                ),
                MenuRow::Block(choice) => (choice.icon().into(), choice.label().into(), None),
            };
            let this = this.clone();
            let mut item = MenuItem::new(("dr-editor-picker-row", ix), icon, label)
                .current(ix == menu.selected)
                .on_click(move |_, window, cx| {
                    this.update(cx, |a, cx| a.choose(Some(ix), window, cx));
                });
            if let Some(word) = trailing.filter(|w| !w.is_empty()) {
                item = item.trailing(word);
            }
            list = list.item(item);
        }
        list
    }

    fn bar_element(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let this = cx.entity();
        let active: Vec<bool> = self.editor.update(cx, |e, _| {
            [
                inline::BOLD,
                inline::ITALIC,
                inline::UNDERLINE,
                inline::STRIKE,
            ]
            .iter()
            .map(|k| e.mark_active(k))
            .collect()
        });
        let block_button = |choice: BlockChoice, this: Entity<Assist>| {
            IconButton::new(("dr-editor-bar-block", choice as usize), choice.icon())
                .label(choice.label())
                .in_tray()
                .on_click(move |_, window, cx| {
                    this.update(cx, |a, cx| a.bar_block(choice, window, cx))
                })
        };
        let marks = [
            (inline::BOLD, Icon::FmtBold, "粗体"),
            (inline::ITALIC, Icon::FmtItalic, "斜体"),
            (inline::UNDERLINE, Icon::FmtUnderline, "下划线"),
            (inline::STRIKE, Icon::FmtStrike, "删除线"),
        ];
        let rule = || div().w(px(0.5)).h(px(18.)).mx(px(2.)).bg(p.hairline());
        let mut row = div().flex().flex_row().items_center().p(px(BAR_PAD));
        for choice in [
            BlockChoice::Body,
            BlockChoice::H1,
            BlockChoice::H2,
            BlockChoice::H3,
            BlockChoice::Quote,
        ] {
            row = row.child(block_button(choice, this.clone()));
        }
        row = row.child(rule());
        for (ix, (key, icon, label)) in marks.into_iter().enumerate() {
            let this = this.clone();
            row = row.child(
                IconButton::new(("dr-editor-bar-mark", ix), icon)
                    .label(label)
                    .in_tray()
                    .selected(active[ix])
                    .on_click(move |_, window, cx| {
                        this.update(cx, |a, cx| a.bar_mark(key, window, cx))
                    }),
            );
        }
        row = row.child(rule());
        let comment = this.clone();
        row = row.child(
            IconButton::new("dr-editor-bar-comment", Icon::CommentPlus)
                .label("添加批注")
                .in_tray()
                .on_click(move |_, _, cx| comment.update(cx, |a, cx| a.bar_comment(cx))),
        );
        dr_ui::glass::surface(
            dr_ui::glass::Ground::flat(p.desk),
            div()
                .id("dr-editor-bar")
                .relative()
                .rounded(px(dr_ui::tokens::radius::SHEET))
                .shadow(dr_ui::components::menu::float_shadow(p))
                .occlude()
                .child(dr_ui::components::menu::slab_edge(
                    p,
                    dr_ui::tokens::radius::SHEET,
                ))
                .child(row),
        )
    }

    /// The bar's width (its buttons are a fixed size).
    fn bar_size() -> gpui::Size<Pixels> {
        let buttons = 10.;
        size(
            px(buttons * BAR_BUTTON + 2. * 4.5 + 2. * BAR_PAD),
            px(BAR_BUTTON + 2. * BAR_PAD),
        )
    }

    /// Where the bar goes: centred 8 px above the selection, below it when
    /// there is no room above (and kept inside the window by the overlay).
    fn bar_place(sel: Bounds<Pixels>) -> Place {
        let bar = Self::bar_size();
        let x = sel.center().x - bar.width / 2.;
        let above = sel.top() - px(BAR_GAP) - bar.height;
        let y = if above >= px(dr_ui::components::overlay::MARGIN) {
            above
        } else {
            sel.bottom() + px(BAR_GAP)
        };
        Place::Point(point(x, y))
    }
}

impl Render for Assist {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let mut root = div().absolute().top_0().left_0().size_0();
        let focused = {
            let e = self.editor.read(cx);
            gpui::Focusable::focus_handle(e, cx).is_focused(window)
        };
        if let Some(menu) = self.menu.clone().filter(|_| focused) {
            let e = self.editor.read(cx);
            let anchor = e
                .range_bounds(menu.chapter, menu.at..menu.at + 1)
                .or_else(|| e.caret_bounds());
            if let Some(rect) = anchor {
                let place = Place::Rect {
                    rect,
                    align: Align::Start,
                    gap: 2.,
                };
                root = root.child(dr_ui::components::float(
                    place,
                    Layer::Popover,
                    self.menu_element(&menu, window, cx),
                ));
            }
            // The trigger was just typed: place the menu again once the
            // editor has drawn it.
            if std::mem::take(&mut self.menu_fresh) {
                let this = cx.entity();
                self.editor.update(cx, |e, _| {
                    e.after_next_paint(move |_, cx| {
                        this.update(cx, |_, cx| cx.notify());
                    })
                });
            }
        }
        if let Some((chapter, range)) = self.bar.clone().filter(|_| focused) {
            let rect = self.editor.read(cx).range_bounds(chapter, range);
            if let Some(rect) = rect {
                let place = Self::bar_place(rect);
                let bar = self.bar_element(window, cx);
                root = root.child(dr_ui::components::float(place, Layer::Popover, bar));
            }
        }
        root
    }
}

/// The view's editor element with the assist around it: its overlay beside
/// the editor, and ↑ ↓ Enter Esc going to the open picker first.
pub fn wrap(assist: &Entity<Assist>, editor: impl IntoElement) -> impl IntoElement {
    let (up, down, enter, esc) = (
        assist.clone(),
        assist.clone(),
        assist.clone(),
        assist.clone(),
    );
    div()
        .size_full()
        .relative()
        .capture_action(move |_: &MoveUp, _, cx| {
            if up.read(cx).menu.is_some() {
                up.update(cx, |a, cx| a.move_selection(-1, cx));
                cx.stop_propagation();
            }
        })
        .capture_action(move |_: &MoveDown, _, cx| {
            if down.read(cx).menu.is_some() {
                down.update(cx, |a, cx| a.move_selection(1, cx));
                cx.stop_propagation();
            }
        })
        .capture_action(move |_: &Newline, window, cx| {
            if enter.read(cx).menu.is_some() {
                enter.update(cx, |a, cx| a.choose(None, window, cx));
                cx.stop_propagation();
            }
        })
        .capture_key_down(move |event: &KeyDownEvent, _, cx| {
            if event.keystroke.key == "escape" {
                let a = esc.read(cx);
                if a.menu.is_some() || a.bar.is_some() {
                    esc.update(cx, |a, cx| a.dismiss(cx));
                    cx.stop_propagation();
                }
            }
        })
        .child(editor)
        .child(assist.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn triggers_follow_the_rules() {
        assert_eq!(trigger("@"), Some((MenuKind::Mention, 0, String::new())));
        assert_eq!(trigger("他@叶"), Some((MenuKind::Mention, 1, "叶".into())));
        assert_eq!(trigger("见 @ye"), Some((MenuKind::Mention, 2, "ye".into())));
        assert_eq!(trigger("a@b"), None, "an e-mail address");
        assert_eq!(trigger("@叶 青"), None, "a space ends the query");
        assert_eq!(trigger("文字/h1"), Some((MenuKind::Slash, 2, "h1".into())));
        assert_eq!(trigger("／引"), Some((MenuKind::Slash, 0, "引".into())));
        assert_eq!(trigger("没有触发"), None);
    }

    #[test]
    fn slash_rows_match_words_and_aliases() {
        let rows = |q: &str| -> Vec<BlockChoice> {
            BlockChoice::ALL
                .into_iter()
                .filter(|c| c.matches(q))
                .collect()
        };
        assert_eq!(rows("").len(), 6);
        assert_eq!(rows("一"), [BlockChoice::H1]);
        assert_eq!(
            rows("标题"),
            [BlockChoice::H1, BlockChoice::H2, BlockChoice::H3]
        );
        assert_eq!(rows("H2"), [BlockChoice::H2]);
        assert_eq!(rows("quo"), [BlockChoice::Quote]);
        assert!(rows("zz").is_empty());
    }
}
