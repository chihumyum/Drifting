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

use std::cell::Cell;
use std::collections::HashSet;
use std::ops::Range;
use std::path::PathBuf;
use std::rc::Rc;
use std::time::Duration;

use dr_model::pos::{PosKey, cmp_pos};
use dr_store::asset::Variant;
use dr_text::autolink::LinkTarget;
use dr_ui::components::menu::{float_shadow, slab_edge};
use dr_ui::components::{Align, IconButton, Layer, Menu, MenuItem, MenuWidth, Place, RowIcon};
use dr_ui::fonts::{Role, weight};
use dr_ui::input::{FieldEvent, TextField};
use dr_ui::sand::{self, Icon};
use dr_ui::style::DrStyled as _;
use dr_ui::theme::Theme;
use dr_ui::tokens::radius;
use dr_workspace::commands::ListIn;
use dr_workspace::commands::asset::{
    AssetFolderInfo, AssetFolderList, AssetFolderListIn, AssetInfo, AssetList,
};
use dr_workspace::{Actor, Workspace};
use gpui::prelude::FluentBuilder as _;
use gpui::{
    AnyElement, App, AppContext as _, Bounds, Context, ElementId, Entity, EventEmitter,
    Focusable as _, InteractiveElement, IntoElement, KeyDownEvent, ObjectFit, ParentElement,
    PathPromptOptions, Pixels, Render, SharedString, StatefulInteractiveElement, Styled,
    StyledImage as _, Subscription, Task, Window, canvas, div, img, point, px, size,
};
use gpui_prose::input::actions::{MoveDown, MoveUp, Newline, SetBody, SetH1, SetH2, SetH3};
use gpui_prose::render::DecorationEvent;
use gpui_prose::schema::{block, inline};
use gpui_prose::text::{BlockKind, ORIGIN_USER};
use gpui_prose::{EditorEvent, HostStep, ProseEditor};
use loro::LoroValue;

use crate::entity_links::{self, NameIndex};

pub mod relate;

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
    /// 插入素材…: a note's images and PDFs (opened from the slash menu, not
    /// by a typed trigger; any edit or caret move closes it).
    Material,
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

/// Drifting's own entries of the slash menu, after the formats.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SlashAction {
    /// 人物链接: the @ picker, here.
    Mention,
    /// 待办: a TODO marker at the paragraph's start (projected into TODOs).
    Todo,
    /// 批注: the host's comment composer on this paragraph.
    Comment,
    /// 位置链接: a location link to this paragraph, copied.
    PositionLink,
}

impl SlashAction {
    pub const ALL: [SlashAction; 4] = [
        SlashAction::Mention,
        SlashAction::Todo,
        SlashAction::Comment,
        SlashAction::PositionLink,
    ];

    pub fn label(self) -> &'static str {
        match self {
            SlashAction::Mention => "人物链接",
            SlashAction::Todo => "待办",
            SlashAction::Comment => "批注",
            SlashAction::PositionLink => "位置链接",
        }
    }

    fn words(self) -> &'static [&'static str] {
        match self {
            SlashAction::Mention => &["@", "mention", "link", "人物", "要素", "链接"],
            SlashAction::Todo => &["todo", "task", "待办"],
            SlashAction::Comment => &["comment", "note", "批注"],
            SlashAction::PositionLink => &["location", "link", "位置"],
        }
    }

    fn icon(self) -> Icon {
        match self {
            SlashAction::Mention => Icon::NameSeal,
            SlashAction::Todo => Icon::ChecklistPlus,
            SlashAction::Comment => Icon::CommentPlus,
            SlashAction::PositionLink => Icon::KnotLinks,
        }
    }

    fn matches(self, query: &str) -> bool {
        let q = query.to_lowercase();
        self.label().contains(&q) || self.words().iter().any(|w| w.starts_with(&q))
    }
}

/// Insert-group formats of the slash menu (lists, tasks, tables, code blocks,
/// inline code, callouts, highlights, plus `插入素材…` in material notes).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoteChoice {
    Bullet,
    Ordered,
    Task,
    Table,
    Code,
    InlineCode,
    Callout,
    Highlight,
    Material,
}

impl NoteChoice {
    pub const ALL: [NoteChoice; 9] = [
        NoteChoice::Bullet,
        NoteChoice::Ordered,
        NoteChoice::Task,
        NoteChoice::Table,
        NoteChoice::Code,
        NoteChoice::InlineCode,
        NoteChoice::Callout,
        NoteChoice::Highlight,
        NoteChoice::Material,
    ];

    /// Every unified prose format (`kernel-v5.md` §6, `v5-tracks.md` §T5:
    /// every prose document offers `图片或 PDF…`).
    pub const PROSE: [NoteChoice; 9] = NoteChoice::ALL;

    pub fn label(self) -> &'static str {
        match self {
            NoteChoice::Bullet => "无序列表",
            NoteChoice::Ordered => "有序列表",
            NoteChoice::Task => "待办清单",
            NoteChoice::Table => "表格",
            NoteChoice::Code => "代码块",
            NoteChoice::InlineCode => "行内代码",
            NoteChoice::Callout => "提示块",
            NoteChoice::Highlight => "高亮",
            NoteChoice::Material => "图片或 PDF…",
        }
    }

    fn words(self) -> &'static [&'static str] {
        match self {
            NoteChoice::Bullet => &["bullet", "list", "ul", "-"],
            NoteChoice::Ordered => &["ordered", "numbered", "ol", "1."],
            NoteChoice::Task => &["task", "todo", "checklist", "[]"],
            NoteChoice::Table => &["table", "grid"],
            NoteChoice::Code => &["code", "```"],
            NoteChoice::InlineCode => &["inline code", "inline-code", "inline", "code", "`"],
            NoteChoice::Callout => &["callout", "note", "tip"],
            NoteChoice::Highlight => &["highlight", "mark", "=="],
            NoteChoice::Material => &["material", "image", "pdf", "file", "图片", "文件", "素材"],
        }
    }

    fn icon(self) -> Icon {
        match self {
            NoteChoice::Bullet => Icon::ListBullet,
            NoteChoice::Ordered => Icon::ListOrdered,
            NoteChoice::Task => Icon::Checklist,
            NoteChoice::Table => Icon::Table,
            NoteChoice::Code | NoteChoice::InlineCode => Icon::Code,
            NoteChoice::Callout => Icon::StickyNote,
            NoteChoice::Highlight => Icon::Highlight,
            NoteChoice::Material => Icon::Image,
        }
    }

    fn matches(self, query: &str) -> bool {
        let q = query.to_lowercase();
        self.label().contains(&q) || self.words().iter().any(|w| w.starts_with(&q))
    }
}

/// The marker 「待办」 puts at a paragraph's start (the typed-marker rule
/// of [`crate::todo`]).
pub const TODO_MARKER: &str = "待办：";

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
    Block(BlockChoice),
    Action(SlashAction),
    /// A material note's own entry.
    Note(NoteChoice),
    /// An image or PDF material to embed (插入素材…).
    Material {
        id: String,
        title: String,
        pdf: bool,
    },
    /// A row that only says something (no materials yet).
    Nothing(&'static str),
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
    /// The selection bar's 添加批注 (or the slash menu's 批注, on the
    /// paragraph): the host opens its comment composer on `range` of
    /// chapter `chapter`.
    Comment { chapter: usize, range: Range<usize> },
    /// The slash menu's 位置链接 put `link` on the clipboard.
    LinkCopied { chapter: usize, link: String },
    /// A plain click on a live entity link in chapter `chapter`: the host
    /// opens `target` (a preview tab, as the 0.1 client did).
    OpenLink {
        chapter: usize,
        target: LinkTarget,
        module: Option<String>,
    },
    /// The slash menu's 表格 (a material note): a table at the caret.
    InsertTable { chapter: usize },
    /// 建立 in the relation composer placed a pair in relation row `row`
    /// (`relation_row.create_pair`, which also answers an existing pair's
    /// row): the host shows that row in the right column.
    RelationPlaced { row: String },
    /// 插入素材…: material `material` embedded at the caret. `chapter` is
    /// the chapter the menu was opened in; the caret may have left it while
    /// the system's file window was open (`BookEditor::insert_material` says
    /// where the file goes then).
    InsertMaterial { chapter: usize, material: String },
    /// The link card's 「自动链接」: the host turns entry `entry`'s own
    /// switch to `on` (`entry.set_auto_link`, `kernel-v5.md` §16) and says
    /// so when the book refuses it.
    AutoLink { entry: String, on: bool },
}

#[derive(Clone, Debug)]
struct MentionAsset {
    id: String,
    name: String,
    pdf: bool,
    initials: crate::pinyin::Initials,
}

#[derive(Clone, Debug)]
struct PickerAsset {
    id: String,
    name: String,
    pdf: bool,
    folder: Option<String>,
    thumb: Option<PathBuf>,
}

struct MaterialPickerState {
    search: Entity<TextField>,
    _search_sub: Subscription,
    query: String,
    folder: Option<String>,
    assets: Vec<PickerAsset>,
    folders: Vec<AssetFolderInfo>,
}

/// The pickers, automatic links and selection bar of one editor.
pub struct Assist {
    ws: Workspace,
    book: String,
    /// Each chapter's prose document (`node:<id>`, …), in the editor's order.
    docs: Vec<String>,
    editor: Entity<ProseEditor>,
    extension: Option<Rc<crate::links::DriftingExtension>>,
    assist_origin: Rc<Cell<gpui::Point<Pixels>>>,
    names: Option<Rc<NameIndex>>,
    /// Every live entry's names, for the @ picker (`kernel-v5.md` §16: it
    /// lists the book's live entries whatever their 「自动链接」).
    mention_names: Option<Rc<NameIndex>>,
    mention_assets: Option<Vec<MentionAsset>>,
    material_picker: Option<MaterialPickerState>,
    /// How many times `asset.list` ran for the slash file picker (for tests;
    /// `v5-tracks.md` §T5 requires once per picker open, never inside `render`).
    pub material_list_calls: usize,
    /// How many times the book's names were dropped to be read again (for
    /// tests).
    pub names_dropped: usize,
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
    /// The caret paragraph's link runs as they were before the next edit:
    /// chapter, block id, line, and `(target, text)` of each run.
    before: Option<BeforeEdit>,
    /// A trigger the author closed with Esc: chapter and offset.
    dismissed: Option<(usize, usize)>,
    bar: Option<(usize, Range<usize>)>,
    /// The selection the bar shows for runs across chapters: it sits over
    /// one chapter's part, and what writes to one chapter only (引用, 添加批注)
    /// is greyed.
    bar_across: bool,
    bar_task: Option<Task<()>>,
    /// The assist's own edit is running (its events are not the author's).
    writing: bool,
    _editor_events: Subscription,
    /// The link decoration under the pointer: chapter and decoration id.
    pointed_link: Option<(usize, SharedString)>,
    /// The open link card, and the link it is for.
    card: Option<OpenCard>,
    card_task: Option<Task<()>>,
    over_card: bool,
    _decor_events: Subscription,
    /// The document is a material note: the note's slash entries, the
    /// bar's 高亮.
    note: bool,
    /// A whole-book view's chapters, each as [`Self::note`] is for a
    /// chapter editor's document ([`Self::set_chapter_notes`]).
    chapter_notes: Vec<bool>,
    /// The v3 page host supplies localized format names; legacy hosts keep their labels.
    block_labels: Option<[SharedString; 6]>,
    entry_label: Option<SharedString>,
    /// Relations in the prose: lines between linked names, the card's
    /// 「建关系」 and its composer ([`relate`]).
    relate: relate::Relate,
}

/// A paragraph's links before an edit: chapter, block id, line, and
/// `(target, text)` of each run.
type BeforeEdit = (usize, Option<String>, usize, Vec<(String, String)>);

/// A link's hover card that is open.
#[derive(Clone, Debug)]
struct OpenCard {
    chapter: usize,
    id: SharedString,
    facts: crate::link_card::CardFacts,
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
        let decor_events = Self::watch_decorations(&editor, window, cx);
        let undo_counts = Self::counts(&editor, cx);
        let line_counts = Self::lines(&editor, cx);
        let mut assist = Assist {
            ws,
            book: book.to_owned(),
            docs,
            editor,
            extension: None,
            assist_origin: Rc::new(Cell::new(point(px(0.), px(0.)))),
            names: None,
            mention_names: None,
            mention_assets: None,
            material_picker: None,
            material_list_calls: 0,
            names_dropped: 0,
            auto_links: true,
            pending: Vec::new(),
            link_task: None,
            undo_counts,
            line_counts,
            menu: None,
            menu_fresh: false,
            before: None,
            dismissed: None,
            bar: None,
            bar_across: false,
            bar_task: None,
            writing: false,
            note: false,
            chapter_notes: Vec::new(),
            block_labels: None,
            entry_label: None,
            _editor_events: events,
            pointed_link: None,
            card: None,
            card_task: None,
            over_card: false,
            _decor_events: decor_events,
            relate: relate::Relate::new(),
        };
        assist.watch_relation_focus(window, cx);
        // What the book is called now: new names are told from these.
        assist.names();
        assist
    }

    fn watch_decorations(
        editor: &Entity<ProseEditor>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Subscription {
        cx.subscribe_in(
            editor,
            window,
            |this, _, event: &DecorationEvent, window, cx| this.on_decoration(event, window, cx),
        )
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
        self._decor_events = Self::watch_decorations(&editor, window, cx);
        self.pointed_link = None;
        self.close_card();
        self.drop_compose();
        self.undo_counts = Self::counts(&editor, cx);
        self.line_counts = Self::lines(&editor, cx);
        self.editor = editor;
        self.docs = docs;
        self.pending.clear();
        self.link_task = None;
        self.menu = None;
        self.material_picker = None;
        self.dismissed = None;
        self.hide_bar();
        cx.notify();
    }

    pub fn set_extension(&mut self, ext: Rc<crate::links::DriftingExtension>) {
        self.extension = Some(ext);
    }

    /// The book's names changed (an element made or renamed, an alias, a
    /// chapter …): they are read again when next needed. Linking a new
    /// name in the text already written is the command's (F3's
    /// `autolink`); its links reach this editor as someone else's write.
    pub fn invalidate_names(&mut self, cx: &mut Context<Self>) {
        self.relate.invalidate();
        self.names = None;
        self.mention_names = None;
        self.mention_assets = None;
        self.names_dropped += 1;
        cx.notify();
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

    /// The document is a material note (its slash entries, the bar's 高亮).
    pub fn set_note(&mut self, note: bool) {
        self.note = note;
    }

    pub fn is_note(&self) -> bool {
        self.note
    }

    /// A whole-book view: whether each chapter (in the editor's order)
    /// follows its level's format shortcuts, so a chapter's slash menu is
    /// the one [`Self::set_note`] gives the same document in a chapter
    /// editor. A chapter past the list goes by [`Self::set_note`].
    pub fn set_chapter_notes(&mut self, notes: Vec<bool>) {
        self.chapter_notes = notes;
    }

    /// Whether chapter `chapter` is a note ([`Self::set_note`],
    /// [`Self::set_chapter_notes`]).
    fn note_in(&self, chapter: usize) -> bool {
        self.chapter_notes
            .get(chapter)
            .copied()
            .unwrap_or(self.note)
    }

    pub fn set_block_labels(&mut self, labels: [SharedString; 6]) {
        self.block_labels = Some(labels);
    }

    pub fn set_entry_label(&mut self, label: SharedString) {
        self.entry_label = Some(label);
    }

    fn block_label(&self, choice: BlockChoice) -> SharedString {
        self.block_labels
            .as_ref()
            .map(|labels| labels[choice as usize].clone())
            .unwrap_or_else(|| choice.label().into())
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

    /// Every live entry's names for the @ picker, read once until the book's
    /// names change.
    fn mention_names(&mut self) -> Option<Rc<NameIndex>> {
        if self.mention_names.is_none() {
            match self.ws.book_mention_names(&self.book) {
                Ok(names) => {
                    let groups = names
                        .iter()
                        .map(|n| (n.target.id.clone(), entity_links::NameGroup::Entry))
                        .collect();
                    self.mention_names = Some(Rc::new(NameIndex::new(names).with_groups(groups)));
                }
                Err(e) => log::warn!("dr-editor: entries of {}: {e}", self.book),
            }
        }
        self.mention_names.clone()
    }

    /// The target id of chapter `chapter`'s own document (never linked).
    fn own_id(&self, chapter: usize) -> Option<&str> {
        let doc = self.docs.get(chapter)?;
        let (_, id) = doc.split_once(':')?;
        Some(if doc.starts_with("body:") {
            id.split('/').next().unwrap_or(id)
        } else {
            id
        })
    }

    // ----- the editor's events -------------------------------------------------------

    fn on_editor(&mut self, event: &EditorEvent, window: &mut Window, cx: &mut Context<Self>) {
        if self.writing {
            return;
        }
        match event {
            EditorEvent::Edited { chapter } => {
                let chapter = *chapter;
                self.close_card();
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
                    self.material_picker = None;
                    cx.notify();
                    return;
                }
                self.repair(chapter, window, cx);
                self.note_typing(chapter, window, cx);
                self.update_menu(cx);
            }
            EditorEvent::SelectionChanged => {
                self.note_before(cx);
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
            // The paragraph's runs before this edit, if they were noted.
            let before: &[(String, String)] = match &self.before {
                Some((c, bid, l, runs))
                    if *c == chapter
                        && (bid.is_some() && bid.as_deref() == line.bid()
                            || bid.is_none() && *l == line_ix) =>
                {
                    runs
                }
                _ => &[],
            };
            (line_ix, caret, {
                let edits = entity_links::repairs(&line.text, &runs, caret, &names, before);
                entity_links::protect_v3(line, edits)
            })
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

    /// Notes the caret paragraph's links, for the next edit's repair.
    fn note_before(&mut self, cx: &App) {
        let e = self.editor.read(cx);
        let sel = e.selection();
        let Some(c) = e.book().chapters.get(sel.chapter) else {
            return;
        };
        let doc = &c.doc;
        let line_ix = doc.line_of(sel.head);
        let line = doc.line(line_ix);
        let runs = entity_links::link_runs(line);
        self.before = Some((
            sel.chapter,
            line.bid().map(str::to_owned),
            line_ix,
            entity_links::run_texts(&line.text, &runs),
        ));
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
                let edits = { entity_links::protect_v3(line, edits) };
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
        self.note_before(cx);
        done
    }

    // ----- pickers ------------------------------------------------------------------

    fn update_menu(&mut self, cx: &mut Context<Self>) {
        // The material picker has no trigger in the text: it stays while
        // the caret stays where it opened, and anything else closes it.
        if let Some(m) = self.menu.as_ref().filter(|m| m.kind == MenuKind::Material) {
            let e = self.editor.read(cx);
            let sel = e.selection();
            if e.composition().is_none()
                && sel.is_empty()
                && sel.chapter == m.chapter
                && sel.head == m.at
            {
                return;
            }
            self.menu = None;
            self.material_picker = None;
            cx.notify();
            return;
        }
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
            self.material_picker = None;
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
            MenuKind::Slash => {
                let mut rows: Vec<MenuRow> = if self.note_in(chapter) {
                    // A material note: the formats, the rule and all insert-group
                    // entries (including 插入素材…), then 人物链接 / 批注.
                    BlockChoice::ALL
                        .into_iter()
                        .filter(|c| c.matches(query))
                        .map(MenuRow::Block)
                        .chain(
                            NoteChoice::ALL
                                .into_iter()
                                .filter(|c| c.matches(query))
                                .map(MenuRow::Note),
                        )
                        .chain(
                            [SlashAction::Mention, SlashAction::Comment]
                                .into_iter()
                                .filter(|a| a.matches(query))
                                .map(MenuRow::Action),
                        )
                        .collect()
                } else {
                    BlockChoice::ALL
                        .into_iter()
                        .filter(|c| c.matches(query))
                        .map(MenuRow::Block)
                        .chain(
                            NoteChoice::PROSE
                                .into_iter()
                                .filter(|c| c.matches(query))
                                .map(MenuRow::Note),
                        )
                        .chain(
                            SlashAction::ALL
                                .into_iter()
                                .filter(|a| a.matches(query))
                                .map(MenuRow::Action),
                        )
                        .collect()
                };
                if !query.is_empty() {
                    let q = query.to_lowercase();
                    rows.sort_by_key(|r| {
                        let label: SharedString = match r {
                            MenuRow::Block(c) => self.block_label(*c),
                            MenuRow::Note(c) => c.label().into(),
                            MenuRow::Action(a) => a.label().into(),
                            _ => SharedString::default(),
                        };
                        label.to_lowercase() != q
                    });
                }
                rows
            }
            MenuKind::Material => self.filtered_material_rows(),
            MenuKind::Mention => {
                let own = self.own_id(chapter).map(str::to_owned);
                let mut rows: Vec<MenuRow> = self
                    .mention_names()
                    .map(|names| {
                        names
                            .search(query, MAX_ROWS + 1)
                            .into_iter()
                            .filter(|(_, t, _)| Some(&t.id) != own.as_ref())
                            .take(MAX_ROWS)
                            .map(|(name, target, group)| MenuRow::Link {
                                name,
                                target,
                                group,
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                let asset_matches = self.search_mention_assets(query);
                if !asset_matches.is_empty() {
                    if rows.len() + asset_matches.len() > MAX_ROWS {
                        let reserve = asset_matches.len().min(8);
                        rows.truncate(MAX_ROWS.saturating_sub(reserve));
                    }
                    let room = MAX_ROWS.saturating_sub(rows.len());
                    rows.extend(asset_matches.into_iter().take(room).map(|a| MenuRow::Link {
                        name: a.name,
                        target: LinkTarget::new(dr_model::kind::EntityKind::Asset, a.id),
                        group: entity_links::NameGroup::Asset,
                    }));
                }
                rows
            }
        }
    }

    fn load_mention_assets(&mut self) -> &[MentionAsset] {
        if self.mention_assets.is_none() {
            let loaded = crate::v3::read(&self.ws, &self.book, |v| {
                v.assets()
                    .into_iter()
                    .map(|a| MentionAsset {
                        id: a.id.to_string(),
                        pdf: a.kind == dr_model::kind::AssetKind::Pdf,
                        initials: crate::pinyin::Initials::of(&a.name),
                        name: a.name,
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
            self.mention_assets = Some(loaded);
        }
        self.mention_assets.as_deref().unwrap_or(&[])
    }

    fn search_mention_assets(&mut self, query: &str) -> Vec<MentionAsset> {
        let q = query.to_lowercase();
        let mut matched: Vec<(bool, MentionAsset)> = self
            .load_mention_assets()
            .iter()
            .filter_map(|a| {
                let contains = a.name.to_lowercase().contains(&q);
                (contains || a.initials.matches(&q)).then(|| (contains, a.clone()))
            })
            .collect();
        matched.sort_by(|a, b| {
            b.0.cmp(&a.0)
                .then_with(|| entity_links::compare_names(&a.1.name, &b.1.name))
        });
        matched.into_iter().map(|(_, a)| a).collect()
    }

    /// Moves the picker's current row by `delta`, wrapping.
    pub fn move_selection(&mut self, delta: isize, cx: &mut Context<Self>) {
        if let Some(m) = &mut self.menu {
            let n = m.rows.len() as isize;
            if n > 0 {
                m.selected = ((m.selected as isize + delta).rem_euclid(n)) as usize;
                cx.notify();
            }
        }
    }

    /// Esc: the picker closes and stays closed for this trigger.
    pub fn dismiss(&mut self, cx: &mut Context<Self>) {
        self.close_card();
        self.drop_compose();
        self.material_picker = None;
        if let Some(m) = self.menu.take() {
            self.dismissed = Some((m.chapter, m.at));
        }
        self.hide_bar();
        cx.notify();
    }

    /// Chooses row `ix` of the open picker (the current one when `None`).
    pub fn choose(&mut self, ix: Option<usize>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(menu) = self.menu.take() else { return };
        self.material_picker = None;
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

            MenuRow::Block(choice) => self.apply_block(chapter, at..caret, choice, window, cx),
            MenuRow::Action(action) => self.apply_action(chapter, at..caret, action, window, cx),
            MenuRow::Note(choice) => self.apply_note(chapter, at..caret, choice, window, cx),
            MenuRow::Material { id, .. } => {
                let focus = self.editor.read(cx).focus_handle(cx);
                window.focus(&focus, cx);
                cx.emit(AssistEvent::InsertMaterial {
                    chapter,
                    material: id,
                });
            }
            MenuRow::Nothing(_) => {
                let focus = self.editor.read(cx).focus_handle(cx);
                window.focus(&focus, cx);
            }
        }
        self.dismissed = None;
        cx.notify();
    }

    /// Filters the open slash file picker by query text without re-calling `asset.list`.
    pub fn set_material_picker_query(&mut self, query: impl Into<String>, cx: &mut Context<Self>) {
        let q = query.into();
        if let Some(p) = &mut self.material_picker {
            p.query = q.clone();
            p.search.update(cx, |f, cx| {
                if f.text() != q {
                    f.set_text(q, cx);
                }
            });
        }
        self.sync_material_picker_rows(cx);
    }

    /// Filters the open slash file picker by folder (`None` = `全部`) without re-calling `asset.list`.
    pub fn set_material_picker_folder(&mut self, folder: Option<String>, cx: &mut Context<Self>) {
        if let Some(p) = &mut self.material_picker {
            p.folder = folder;
        }
        self.sync_material_picker_rows(cx);
    }

    fn sync_material_picker_rows(&mut self, cx: &mut Context<Self>) {
        let rows = self.filtered_material_rows();
        if let Some(m) = self.menu.as_mut().filter(|m| m.kind == MenuKind::Material) {
            m.rows = rows;
            m.selected = m.selected.min(m.rows.len().saturating_sub(1));
            cx.notify();
        }
    }

    fn filtered_picker_assets(&self) -> Vec<PickerAsset> {
        let Some(p) = &self.material_picker else {
            return Vec::new();
        };
        let subtree: Option<HashSet<String>> = p.folder.as_ref().map(|fid| {
            let mut set = HashSet::new();
            collect_picker_subtree(&p.folders, fid, &mut set);
            set
        });
        let q = p.query.trim().to_lowercase();
        p.assets
            .iter()
            .filter(|a| match &subtree {
                Some(set) => a.folder.as_deref().is_some_and(|f| set.contains(f)),
                None => true,
            })
            .filter(|a| q.is_empty() || a.name.to_lowercase().contains(&q))
            .cloned()
            .collect()
    }

    fn filtered_material_rows(&self) -> Vec<MenuRow> {
        let rows: Vec<MenuRow> = self
            .filtered_picker_assets()
            .into_iter()
            .map(|a| MenuRow::Material {
                id: a.id,
                title: a.name,
                pdf: a.pdf,
            })
            .collect();
        if rows.is_empty() {
            vec![MenuRow::Nothing("还没有文件")]
        } else {
            rows
        }
    }

    fn open_material_picker(
        &mut self,
        chapter: usize,
        at: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.material_list_calls += 1;
        let mut raw_assets: Vec<AssetInfo> = self
            .ws
            .run::<AssetList>(
                &Actor::User,
                ListIn {
                    book: self.book.clone(),
                    trashed: false,
                },
            )
            .map(|o| o.output)
            .unwrap_or_default();
        raw_assets.sort_by(|a, b| {
            let pa = a.pos.as_deref().and_then(|s| PosKey::parse(s).ok());
            let pb = b.pos.as_deref().and_then(|s| PosKey::parse(s).ok());
            cmp_pos((pa.as_ref(), &a.id), (pb.as_ref(), &b.id))
        });
        let mut raw_folders: Vec<AssetFolderInfo> = self
            .ws
            .run::<AssetFolderList>(
                &Actor::User,
                AssetFolderListIn {
                    book: self.book.clone(),
                    trashed: false,
                },
            )
            .map(|o| o.output)
            .unwrap_or_default();
        raw_folders.sort_by(|a, b| {
            let pa = a.pos.as_deref().and_then(|s| PosKey::parse(s).ok());
            let pb = b.pos.as_deref().and_then(|s| PosKey::parse(s).ok());
            cmp_pos((pa.as_ref(), &a.id), (pb.as_ref(), &b.id))
        });
        let store = self.ws.library();
        let assets: Vec<PickerAsset> = raw_assets
            .into_iter()
            .filter(|a| matches!(a.kind.as_str(), "image" | "pdf"))
            .map(|a| {
                let thumb = store
                    .asset(&a.id, Variant::Thumbnail)
                    .ok()
                    .flatten()
                    .or_else(|| store.asset(&a.id, Variant::Display).ok().flatten())
                    .or_else(|| store.asset(&a.id, Variant::Source).ok().flatten())
                    .and_then(|r| r.path.exists().then_some(r.path));
                PickerAsset {
                    id: a.id,
                    name: a.name,
                    pdf: a.kind == "pdf",
                    folder: a.folder,
                    thumb,
                }
            })
            .collect();

        let strings = crate::file_host::strings(cx);
        let search = cx.new(|cx| {
            TextField::new(
                ElementId::Name("dr-editor-file-pick-search".into()),
                window,
                cx,
            )
            .small()
            .placeholder(strings.find_file)
        });
        let search_sub = cx.subscribe_in(
            &search,
            window,
            |this, field, ev: &FieldEvent, window, cx| match ev {
                FieldEvent::Changed(q) => {
                    if let Some(p) = &mut this.material_picker {
                        p.query = q.clone();
                    }
                    this.sync_material_picker_rows(cx);
                }
                FieldEvent::Submitted(_) => {
                    this.choose(None, window, cx);
                }
                FieldEvent::Cancelled => {
                    if !field.read(cx).text().is_empty() {
                        field.update(cx, |f, cx| f.set_text(String::new(), cx));
                        if let Some(p) = &mut this.material_picker {
                            p.query.clear();
                        }
                        this.sync_material_picker_rows(cx);
                    } else {
                        let focus = this.editor.read(cx).focus_handle(cx);
                        window.focus(&focus, cx);
                        this.dismiss(cx);
                    }
                }
                FieldEvent::Blurred => {}
            },
        );
        let search_focus = search.read(cx).focus_handle(cx);
        self.material_picker = Some(MaterialPickerState {
            search,
            _search_sub: search_sub,
            query: String::new(),
            folder: None,
            assets,
            folders: raw_folders,
        });
        let rows = self.filtered_material_rows();
        self.menu = Some(OpenMenu {
            kind: MenuKind::Material,
            chapter,
            at,
            query: String::new(),
            rows,
            selected: 0,
        });
        self.menu_fresh = true;
        window.focus(&search_focus, cx);
    }

    /// The file picker's 「从电脑选…」: the system's file window, then each
    /// chosen file goes into the library (the same bytes give back the file
    /// already there) and is embedded at the caret, which may by then have
    /// left chapter `chapter`, the menu's ([`AssistEvent::InsertMaterial`],
    /// one per file).
    pub fn pick_material_from_computer(
        &mut self,
        chapter: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.menu = None;
        self.material_picker = None;
        let focus = self.editor.read(cx).focus_handle(cx);
        window.focus(&focus, cx);
        cx.notify();
        let prompt = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: true,
            prompt: None,
        });
        let ws = self.ws.clone();
        let book = self.book.clone();
        let host_fn = crate::file_host::import_paths_fn(cx);
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = prompt.await else {
                return;
            };
            if paths.is_empty() {
                return;
            }
            let imported = cx
                .background_spawn(async move {
                    crate::file_host::import_paths_blocking(host_fn.as_ref(), &ws, &book, &paths)
                })
                .await;
            this.update(cx, |_, cx| {
                let mut flash_keys = Vec::new();
                for file in imported {
                    flash_keys.push(format!("library-asset:{}", file.id));
                    flash_keys.push(file.id.clone());
                    cx.emit(AssistEvent::InsertMaterial {
                        chapter,
                        material: file.id,
                    });
                }
                crate::file_host::trigger_flash(flash_keys, cx);
            })
            .ok();
        })
        .detach();
    }

    /// A material note's own slash entries: `/query` goes, then the entry.
    fn apply_note(
        &mut self,
        chapter: usize,
        range: Range<usize>,
        choice: NoteChoice,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let block_attr = |key: &'static str, value: LoroValue| {
            let range = range.clone();
            move |doc: &mut gpui_prose::ProseDoc| {
                doc.delete(range.clone(), ORIGIN_USER);
                let ix = doc.line_of(range.start);
                doc.set_block_attr(ix, key, Some(value), ORIGIN_USER);
                Some(range.start)
            }
        };
        match choice {
            NoteChoice::Bullet => {
                self.write(
                    chapter,
                    HostStep::Own,
                    window,
                    cx,
                    block_attr(block::LIST, "bullet".into()),
                );
            }
            NoteChoice::Ordered => {
                self.write(
                    chapter,
                    HostStep::Own,
                    window,
                    cx,
                    block_attr(block::LIST, "ordered".into()),
                );
            }
            NoteChoice::Task => {
                self.write(
                    chapter,
                    HostStep::Own,
                    window,
                    cx,
                    block_attr(block::LIST, "task".into()),
                );
            }
            NoteChoice::Code => {
                self.write(
                    chapter,
                    HostStep::Own,
                    window,
                    cx,
                    block_attr(block::CODE_BLOCK, "".into()),
                );
            }
            NoteChoice::Callout => {
                // The 0.1 note had one kind of callout (imported as `note`).
                self.write(
                    chapter,
                    HostStep::Own,
                    window,
                    cx,
                    block_attr(block::CALLOUT, "note".into()),
                );
            }
            NoteChoice::Highlight
            | NoteChoice::InlineCode
            | NoteChoice::Table
            | NoteChoice::Material => {
                self.write(chapter, HostStep::Own, window, cx, |doc| {
                    doc.delete(range.clone(), ORIGIN_USER);
                    Some(range.start)
                });
                match choice {
                    // At the caret: what is typed next carries the mark.
                    NoteChoice::Highlight => self.editor.update(cx, |e, cx| {
                        e.toggle_mark_value(
                            crate::highlight::KEY,
                            crate::highlight::value(),
                            window,
                            cx,
                        )
                    }),
                    NoteChoice::InlineCode => self
                        .editor
                        .update(cx, |e, cx| e.toggle_mark(inline::CODE, window, cx)),
                    NoteChoice::Table => cx.emit(AssistEvent::InsertTable { chapter }),
                    _ => self.open_material_picker(chapter, range.start, window, cx),
                }
            }
        }
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
        // Picked with @: recorded as manual (`kernel-v5.md` §16).
        let value = entity_links::picked_link_value(target);
        let text = format!("{name} ");
        let len = name.chars().count();
        self.write(chapter, HostStep::Own, window, cx, move |doc| {
            doc.replace(range.clone(), &text, ORIGIN_USER);
            doc.mark(range.start..range.start + len, &key, value, ORIGIN_USER);
            Some(range.start + len + 1)
        });
    }

    /// Drifting's own slash entries: `/query` goes, then the action.
    fn apply_action(
        &mut self,
        chapter: usize,
        range: Range<usize>,
        action: SlashAction,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match action {
            SlashAction::Mention => {
                self.write(chapter, HostStep::Own, window, cx, |doc| {
                    doc.replace(range.clone(), "@", ORIGIN_USER);
                    Some(range.start + 1)
                });
                // Written as the assist's own edit: open the @ picker here.
                self.update_menu(cx);
            }
            SlashAction::Todo => {
                self.write(chapter, HostStep::Own, window, cx, |doc| {
                    doc.delete(range.clone(), ORIGIN_USER);
                    let ix = doc.line_of(range.start);
                    let start = doc.line_start(ix);
                    if crate::todo::parse(&doc.line(ix).text).is_some() {
                        return Some(range.start);
                    }
                    doc.replace(start..start, TODO_MARKER, ORIGIN_USER);
                    Some(range.start + TODO_MARKER.chars().count())
                });
            }
            SlashAction::Comment => {
                let mut paragraph = range.start..range.start;
                self.write(chapter, HostStep::Own, window, cx, |doc| {
                    doc.delete(range.clone(), ORIGIN_USER);
                    let ix = doc.line_of(range.start);
                    let start = doc.line_start(ix);
                    paragraph = start..start + doc.line(ix).chars;
                    Some(range.start)
                });
                cx.emit(AssistEvent::Comment {
                    chapter,
                    range: paragraph,
                });
            }
            SlashAction::PositionLink => {
                let mut line = 0;
                self.write(chapter, HostStep::Own, window, cx, |doc| {
                    doc.delete(range.clone(), ORIGIN_USER);
                    line = doc.line_of(range.start);
                    Some(range.start)
                });
                if let Some(link) = self.position_link(chapter, line) {
                    cx.write_to_clipboard(gpui::ClipboardItem::new_string(link.clone()));
                    cx.emit(AssistEvent::LinkCopied { chapter, link });
                }
            }
        }
    }

    /// The location link of paragraph `line` of chapter `chapter`, in the
    /// document form: `drifting:<group>/id-<id>/prose.md#L<2N+1>`.
    pub fn position_link(&self, chapter: usize, line: usize) -> Option<String> {
        if let Some((entry, module)) = self.docs.get(chapter).and_then(|d| crate::v3::body(d)) {
            return Some(
                crate::v3_link::Address {
                    book: None,
                    endpoint: crate::v3_link::Endpoint::Entry {
                        id: dr_model::id::EntryId::parse(&entry).ok()?,
                        module: Some(dr_model::id::ModuleId::parse(&module).ok()?),
                    },
                    lines: Some((
                        (line as u32).saturating_mul(2).saturating_add(1),
                        (line as u32).saturating_mul(2).saturating_add(1),
                    )),
                }
                .format("drifting-next-dev"),
            );
        }

        None
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
                    for key in [
                        block::QUOTE,
                        block::LIST,
                        block::LIST_LEVEL,
                        block::CHECKED,
                        block::TODO,
                        block::CODE_BLOCK,
                        block::CALLOUT,
                    ] {
                        doc.set_block_attr(ix, key, None, ORIGIN_USER);
                    }
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
                    for key in [
                        block::HEADING,
                        block::QUOTE,
                        block::LIST,
                        block::LIST_LEVEL,
                        block::CHECKED,
                        block::TODO,
                        block::CODE_BLOCK,
                        block::CALLOUT,
                    ] {
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

    // ----- the link card -------------------------------------------------------------

    /// The link card that is open: the link's chapter and its target.
    pub fn card(&self) -> Option<(usize, &LinkTarget)> {
        self.card.as_ref().map(|c| (c.chapter, &c.facts.target))
    }

    fn close_card(&mut self) {
        self.card = None;
        self.card_task = None;
        self.over_card = false;
        self.relate.card_closed();
    }

    fn on_decoration(
        &mut self,
        event: &DecorationEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let DecorationEvent::Pointed { ids } = event else {
            return;
        };
        // While a relation is being made a name is picked, not carded.
        if self.relate.composing() {
            self.pointed_link = None;
            return;
        }
        let link = ids
            .iter()
            .find(|(_, k)| k.group == "links")
            .map(|(c, k)| (*c, k.id.clone()));
        if link == self.pointed_link {
            return;
        }
        self.pointed_link = link.clone();
        let wait = dr_ui::tokens::motion::dwell::HOVER_CARD_DELAY;
        match link {
            Some((chapter, id)) => {
                // Rest on it a moment, then open (another link's card goes).
                if self
                    .card
                    .as_ref()
                    .is_some_and(|c| c.chapter != chapter || c.id != id)
                {
                    self.close_card();
                }
                if self.card.is_none() {
                    self.card_task = Some(cx.spawn_in(window, async move |this, cx| {
                        cx.background_executor().timer(wait).await;
                        this.update(cx, |this, cx| this.open_card(chapter, id, cx))
                            .ok();
                    }));
                }
            }
            None if self.card.is_some() => {
                // A moment to reach the card.
                let grace = dr_ui::tokens::motion::dwell::HOVER_CARD_GRACE;
                self.card_task = Some(cx.spawn_in(window, async move |this, cx| {
                    cx.background_executor().timer(grace).await;
                    this.update(cx, |this, cx| {
                        if !this.over_card && this.pointed_link.is_none() {
                            this.close_card();
                            cx.notify();
                        }
                    })
                    .ok();
                }));
            }
            None => self.card_task = None,
        }
    }

    /// The target of link decoration `id` in chapter `chapter`.
    fn link_target(&self, chapter: usize, id: &str, cx: &App) -> Option<LinkTarget> {
        let e = self.editor.read(cx);
        let range = e.decoration_range(chapter, "links", id)?;
        let doc = &e.book().chapters.get(chapter)?.doc;
        let marks = doc.marks_before(range.start + 1);
        // The first mark there that reads as a link (`kernel-v5.md` §16).
        marks.entities().find_map(|(target, value)| {
            let link = dr_doc::prose::v3::decode_entity_link(target, value)?;
            self.shows_as_link(&link, value)
                .then(|| LinkTarget::new(link.kind, link.target))
        })
    }

    /// Whether `link` (its raw `value`) reads as a link now: through the
    /// editor's extension when it has one, from the book otherwise.
    fn shows_as_link(&self, link: &dr_model::v3::EntityLinkV3, value: &loro::LoroValue) -> bool {
        match &self.extension {
            Some(x) => x.show(&link.kind, &link.target, value).is_link(),
            None => crate::v3::link_show(&self.ws, &self.book, link).is_link(),
        }
    }

    fn open_card(&mut self, chapter: usize, id: SharedString, cx: &mut Context<Self>) {
        self.card_task = None;
        if self.pointed_link.as_ref() != Some(&(chapter, id.clone())) {
            return;
        }
        let Some(target) = self.link_target(chapter, &id, cx) else {
            return;
        };
        if let Some(facts) = crate::link_card::card_facts(&self.ws, &self.book, &target) {
            self.card = Some(OpenCard { chapter, id, facts });
            cx.notify();
        }
    }

    /// A plain click on a live link: the host opens its target.
    pub fn link_clicked(&mut self, cx: &mut Context<Self>) {
        if self.relate.composing() {
            return;
        }
        let Some((chapter, id)) = self.pointed_link.clone() else {
            return;
        };
        {
            let link = self
                .editor
                .read(cx)
                .decoration_range(chapter, "links", &id)
                .and_then(|r| {
                    self.editor
                        .read(cx)
                        .book()
                        .chapters
                        .get(chapter)
                        .map(|c| c.doc.marks_before(r.start + 1))
                })
                .and_then(|m| {
                    m.entities().find_map(|(t, v)| {
                        dr_doc::prose::v3::decode_entity_link(t, v)
                            .filter(|link| self.shows_as_link(link, v))
                    })
                });
            self.close_card();
            if let Some(link) = link {
                self.open_entity_link_v3(link, cx);
            }
        }
    }

    /// Body and table clicks share the versioned endpoint and raw mark reader.
    pub fn open_entity_link_v3(
        &mut self,
        link: dr_model::v3::EntityLinkV3,
        cx: &mut Context<Self>,
    ) {
        // An automatic link whose entry's 「自动链接」 is off (or any while
        // the setting is off) reads as text and opens nothing
        // (`kernel-v5.md` §16); so does a trashed file's.
        if !crate::v3::link_show(&self.ws, &self.book, &link).is_link() {
            return;
        }
        if crate::link_card::card_facts(
            &self.ws,
            &self.book,
            &LinkTarget::new(link.kind.clone(), link.target.clone()),
        )
        .is_some()
        {
            crate::links::open_v3(&self.ws, &self.book, link, cx);
        }
    }

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
        let across = sel.spans_chapters();
        let (chapter, range, words) = if across {
            // Over the caret's chapter's part, or the anchor's when the
            // caret's holds none of it (it sits at that chapter's start).
            let part = |c: usize| e.selected_in(c).filter(|(r, _)| !r.is_empty());
            let (chapter, range) = match part(sel.chapter) {
                Some((r, _)) => (sel.chapter, r),
                None => match part(sel.anchor_chapter) {
                    Some((r, _)) => (sel.anchor_chapter, r),
                    None => return false,
                },
            };
            (chapter, range, !e.selected_text().trim().is_empty())
        } else {
            let doc = &e.book().chapters[sel.chapter].doc;
            let words = !doc.slice(sel.range()).trim().is_empty();
            (sel.chapter, sel.range(), words)
        };
        if focused && words {
            self.bar = Some((chapter, range));
            self.bar_across = across;
            self.bar_task = None;
            cx.notify();
        }
        false
    }

    /// The bar's paragraph buttons (正文, H1–H3, 引用 toggles).
    pub fn bar_block(&mut self, choice: BlockChoice, window: &mut Window, cx: &mut Context<Self>) {
        match choice {
            BlockChoice::Quote => {
                let Some((chapter, range)) = self.bar.clone().filter(|_| !self.bar_across) else {
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
        self.editor.update(cx, |e, cx| {
            if key == crate::highlight::KEY {
                e.toggle_mark_value(key, crate::highlight::value(), window, cx);
            } else {
                e.toggle_mark(key, window, cx);
            }
        });
        self.hide_bar();
        cx.notify();
    }

    /// The bar's 添加批注.
    pub fn bar_comment(&mut self, cx: &mut Context<Self>) {
        // A comment is on one document: not on a selection across chapters.
        if self.bar_across {
            return;
        }
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
                    let label = if *group == NameGroup::Entry {
                        self.entry_label.clone().unwrap_or_default()
                    } else {
                        group.label().into()
                    };
                    if !label.is_empty() {
                        list = list.section(label, &theme);
                    }
                    section = Some(*group);
                }

                // The slash menu: the formats, the rule, Drifting's own.
                MenuRow::Block(BlockChoice::Rule) if ix > 0 => {
                    list = list.separator(&theme);
                }
                MenuRow::Action(_)
                    if ix > 0 && !matches!(menu.rows[ix - 1], MenuRow::Action(_)) =>
                {
                    list = list.separator(&theme);
                }
                // Insert-group entries open their group when the rule is
                // filtered out or an exact action match sorted first.
                MenuRow::Note(_)
                    if ix > 0
                        && (matches!(menu.rows[ix - 1], MenuRow::Block(c) if c != BlockChoice::Rule)
                            || matches!(menu.rows[ix - 1], MenuRow::Action(_))) =>
                {
                    list = list.separator(&theme);
                }
                _ => {}
            }
            let (icon, label, trailing): (RowIcon, SharedString, Option<&str>) = match row {
                MenuRow::Link {
                    name,
                    target,
                    group,
                } => {
                    if *group == NameGroup::Asset {
                        let is_pdf = self
                            .mention_assets
                            .as_ref()
                            .and_then(|list| list.iter().find(|a| a.id == target.id))
                            .is_some_and(|a| a.pdf);
                        (
                            if is_pdf { Icon::FileText } else { Icon::Image }.into(),
                            name.clone().into(),
                            if is_pdf { Some("PDF") } else { None },
                        )
                    } else {
                        let kind = match group {
                            NameGroup::Element => sand::Kind::Element,
                            NameGroup::Chapter => sand::Kind::Chapter(0),
                            NameGroup::Idea => sand::Kind::Drift { loose: false },
                            NameGroup::Entry | NameGroup::Asset | NameGroup::Other => {
                                sand::Kind::Category
                            }
                        };
                        (RowIcon::Mark(kind, None), name.clone().into(), None)
                    }
                }

                MenuRow::Block(choice) => (choice.icon().into(), self.block_label(*choice), None),
                MenuRow::Action(action) => (action.icon().into(), action.label().into(), None),
                MenuRow::Note(choice) => {
                    let label = if *choice == NoteChoice::Material {
                        crate::file_host::strings(cx).slash_image_or_pdf
                    } else {
                        choice.label().into()
                    };
                    (choice.icon().into(), label, None)
                }
                MenuRow::Material { title, pdf, .. } => (
                    if *pdf { Icon::FileText } else { Icon::Image }.into(),
                    title.clone().into(),
                    Some(if *pdf { "PDF" } else { "" }),
                ),
                MenuRow::Nothing(text) => (Icon::ImagePlus.into(), (*text).into(), None),
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

    fn material_picker_element(
        &self,
        menu: &OpenMenu,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(picker) = &self.material_picker else {
            return div().into_any_element();
        };
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let strings = crate::file_host::strings(cx);
        let all_count = picker.assets.len();
        let all_selected = picker.folder.is_none();
        let mut chips = div().flex().flex_row().flex_wrap().gap(px(4.));
        chips = chips.child(
            div()
                .id("dr-editor-file-pick-chip-all")
                .px(px(8.))
                .py(px(2.))
                .rounded(px(999.))
                .cursor_pointer()
                .role(gpui::Role::Button)
                .bg(if all_selected {
                    p.accent.alpha(0.16)
                } else {
                    p.ink(1).alpha(0.04)
                })
                .font_role(Role::Index)
                .type_px(s.caption, s.line_caption)
                .text_color(if all_selected {
                    p.ink(1).solid()
                } else {
                    p.ink(3).solid()
                })
                .child(format!("{} {all_count}", strings.all_folders))
                .on_click(cx.listener(|a, _, _, cx| a.set_material_picker_folder(None, cx))),
        );
        for folder in &picker.folders {
            let mut set = HashSet::new();
            collect_picker_subtree(&picker.folders, &folder.id, &mut set);
            let count = picker
                .assets
                .iter()
                .filter(|a| a.folder.as_deref().is_some_and(|f| set.contains(f)))
                .count();
            let selected = picker.folder.as_deref() == Some(folder.id.as_str());
            let fid = folder.id.clone();
            chips = chips.child(
                div()
                    .id(ElementId::Name(
                        format!("dr-editor-file-pick-chip-{}", folder.id).into(),
                    ))
                    .px(px(8.))
                    .py(px(2.))
                    .rounded(px(999.))
                    .cursor_pointer()
                    .role(gpui::Role::Button)
                    .bg(if selected {
                        p.accent.alpha(0.16)
                    } else {
                        p.ink(1).alpha(0.04)
                    })
                    .font_role(Role::Index)
                    .type_px(s.caption, s.line_caption)
                    .text_color(if selected {
                        p.ink(1).solid()
                    } else {
                        p.ink(3).solid()
                    })
                    .child(format!("{} {count}", folder.name))
                    .on_click(cx.listener(move |a, _, _, cx| {
                        a.set_material_picker_folder(Some(fid.clone()), cx);
                    })),
            );
        }

        let shown = self.filtered_picker_assets();
        let mut grid = div()
            .id("dr-editor-file-pick-grid")
            .max_h(px(248.))
            .overflow_y_scroll()
            .flex()
            .flex_row()
            .flex_wrap()
            .gap(px(6.));
        if shown.is_empty() {
            grid = grid.child(
                div()
                    .w_full()
                    .py(px(18.))
                    .flex()
                    .justify_center()
                    .font_role(Role::Ui)
                    .type_px(s.secondary, s.line_body)
                    .text_color(p.ink(4).solid())
                    .child(strings.empty),
            );
        } else {
            for (ix, asset) in shown.into_iter().enumerate() {
                let is_current = ix == menu.selected;
                grid = grid.child(
                    div()
                        .id(ElementId::Name(
                            format!("dr-editor-file-pick-cell-{}", asset.id).into(),
                        ))
                        .w(px(100.))
                        .p(px(4.))
                        .rounded(px(radius::SM))
                        .cursor_pointer()
                        .role(gpui::Role::Button)
                        .aria_label(asset.name.clone())
                        .when(is_current, |d| {
                            d.bg(p.accent.alpha(0.12))
                                .border_1()
                                .border_color(p.accent.alpha(0.45))
                        })
                        .hover(move |st| st.bg(p.ink(1).alpha(0.06)))
                        .flex()
                        .flex_col()
                        .gap(px(3.))
                        .child(
                            div()
                                .w_full()
                                .h(px(70.))
                                .rounded(px(4.))
                                .overflow_hidden()
                                .bg(p.ink(1).alpha(0.05))
                                .flex()
                                .items_center()
                                .justify_center()
                                .child(match asset.thumb {
                                    Some(path) => img(path)
                                        .size_full()
                                        .object_fit(if asset.pdf {
                                            ObjectFit::Contain
                                        } else {
                                            ObjectFit::Cover
                                        })
                                        .into_any_element(),
                                    None => sand::icon(
                                        if asset.pdf {
                                            Icon::FileText
                                        } else {
                                            Icon::Image
                                        },
                                        18.,
                                        p.ink(3).solid(),
                                    )
                                    .into_any_element(),
                                }),
                        )
                        .child(
                            div()
                                .w_full()
                                .overflow_hidden()
                                .whitespace_nowrap()
                                .font_role(Role::Ui)
                                .type_px(s.caption, s.line_caption)
                                .text_color(p.ink(2).solid())
                                .child(asset.name),
                        )
                        .on_click(cx.listener(move |a, _, window, cx| {
                            a.choose(Some(ix), window, cx);
                        })),
                );
            }
        }

        let chapter = menu.chapter;
        div()
            .id("dr-editor-file-picker")
            .relative()
            .occlude()
            .w(px(340.))
            .p(px(10.))
            .rounded(px(radius::SHEET))
            .bg(p.desk.solid())
            .shadow(float_shadow(p))
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(slab_edge(p, radius::SHEET))
            .on_mouse_down_out(cx.listener(|a, _, _, cx| a.dismiss(cx)))
            .child(picker.search.clone())
            .child(chips)
            .child(grid)
            .child(div().h(px(1.)).w_full().bg(p.hairline()))
            .child(
                div()
                    .id("dr-editor-file-pick-from-disk")
                    .px(px(8.))
                    .py(px(5.))
                    .rounded(px(radius::MENU_ROW))
                    .cursor_pointer()
                    .role(gpui::Role::MenuItem)
                    .hover(move |st| st.bg(p.ink(1).alpha(0.06)))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.))
                    .font_role(Role::Index)
                    .type_px(s.secondary, s.line_body)
                    .text_color(p.ink(2).solid())
                    .weight(weight::MEDIUM)
                    .child(sand::icon(Icon::ImagePlus, 14., p.ink(2).solid()))
                    .child(strings.pick_from_computer)
                    .on_click(cx.listener(move |a, _, window, cx| {
                        a.pick_material_from_computer(chapter, window, cx);
                    })),
            )
            .into_any_element()
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
                inline::CODE,
                crate::highlight::KEY,
            ]
            .iter()
            .map(|k| e.mark_active(k))
            .collect()
        });
        let across = self.bar_across;
        let block_button = |choice: BlockChoice, this: Entity<Assist>| {
            IconButton::new(("dr-editor-bar-block", choice as usize), choice.icon())
                .label(self.block_label(choice))
                .in_tray()
                .disabled(across && choice == BlockChoice::Quote)
                .on_click(move |_, window, cx| {
                    this.update(cx, |a, cx| a.bar_block(choice, window, cx))
                })
        };
        let marks = [
            (inline::BOLD, Icon::FmtBold, "粗体"),
            (inline::ITALIC, Icon::FmtItalic, "斜体"),
            (inline::UNDERLINE, Icon::FmtUnderline, "下划线"),
            (inline::STRIKE, Icon::FmtStrike, "删除线"),
            (inline::CODE, Icon::Code, "行内代码"),
            (crate::highlight::KEY, Icon::Highlight, "高亮"),
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
                .disabled(across)
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
        let buttons = 12.;
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
        let origin_cell = self.assist_origin.clone();
        let mut root = div().absolute().top_0().left_0().size_0().child(
            canvas(
                move |bounds, _, _| origin_cell.set(bounds.origin),
                |_, _, _, _| {},
            )
            .size_0(),
        );
        if let Some(ext) = &self.extension {
            let origin = self.assist_origin.get();
            let e = self.editor.read(cx);
            let link_color = e.style().link.opacity(0.85);
            for chapter in 0..self.docs.len() {
                for (id, is_pdf) in ext.file_link_badges(chapter) {
                    if let Some(painted) = e.painted_decoration(chapter, "links", &id)
                        && let Some(last_box) = painted.boxes.last().copied()
                    {
                        let left = last_box.right() - origin.x + px(1.5);
                        let top = last_box.center().y - origin.y - px(5.5);
                        root = root.child(
                            div()
                                .debug_selector(|| "dr-editor-file-link-badge".into())
                                .absolute()
                                .left(left)
                                .top(top)
                                .child(sand::icon(
                                    if is_pdf { Icon::FileText } else { Icon::Image },
                                    11.,
                                    link_color,
                                )),
                        );
                    }
                }
            }
        }
        let focused = {
            let e = self.editor.read(cx);
            gpui::Focusable::focus_handle(e, cx).is_focused(window)
        };
        if let Some(menu) = self
            .menu
            .clone()
            .filter(|m| focused || m.kind == MenuKind::Material)
        {
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
                let popup = if menu.kind == MenuKind::Material {
                    self.material_picker_element(&menu, window, cx)
                } else {
                    self.menu_element(&menu, window, cx).into_any_element()
                };
                root = root.child(dr_ui::components::float(place, Layer::Popover, popup));
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
        // The relation lines under the card, and the relation composer.
        root = self.relation_overlay(root, window, cx);
        if let Some(card) = self.card.clone() {
            let painted = self
                .editor
                .read(cx)
                .painted_decoration(card.chapter, "links", &card.id);
            if let Some(rect) =
                painted.and_then(|p| p.boxes.iter().copied().reduce(|a, b| a.union(&b)))
            {
                // Away from the lines: above the name when more go down.
                let above = self.card_goes_above();
                let this = cx.entity();
                let actions = if card.facts.target.kind == dr_model::kind::EntityKind::Entry {
                    let start = cx.entity();
                    let switch = cx.entity();
                    let on = card.facts.auto_link;
                    let entry = card.facts.target.id.clone();
                    vec![
                        dr_ui::components::CardAction::new(
                            "dr-editor-link-card-relate",
                            Icon::KnotLinks,
                            self.relate_label(),
                        )
                        .on_click(move |_, window, cx| {
                            start.update(cx, |a, cx| a.start_relation(window, cx));
                        })
                        .into_any_element(),
                        // The entry's own 「自动链接」 under 「建关系」
                        // (`kernel-v5.md` §16): off, this link and every
                        // automatic one to the entry read as text.
                        dr_ui::components::CardAction::new(
                            "dr-editor-link-card-auto-link",
                            Icon::Hook,
                            self.auto_link_label(),
                        )
                        .current(on)
                        .on_click(move |_, _, cx| {
                            let entry = entry.clone();
                            switch.update(cx, |a, cx| {
                                // Shown at once; turned off, the card goes
                                // with the link once the editor redraws.
                                if let Some(card) = a.card.as_mut() {
                                    card.facts.auto_link = !on;
                                }
                                cx.emit(AssistEvent::AutoLink { entry, on: !on });
                                cx.notify();
                            });
                        })
                        .into_any_element(),
                    ]
                } else {
                    Vec::new()
                };
                let body = div()
                    .id("dr-editor-link-card")
                    .debug_selector(|| "dr-editor-link-card".into())
                    .occlude()
                    .on_hover(move |on, _, cx| {
                        let on = *on;
                        this.update(cx, |a, cx| {
                            a.over_card = on;
                            if !on && a.pointed_link.is_none() {
                                a.close_card();
                                cx.notify();
                            }
                        });
                    })
                    .child(crate::link_card::card_element_with(
                        &card.facts,
                        actions,
                        window,
                        cx,
                    ));
                let place = if above {
                    Place::Above {
                        rect,
                        align: Align::Start,
                        gap: 8.,
                    }
                } else {
                    Place::below(rect, 8.)
                };
                root = root.child(dr_ui::components::float(place, Layer::Popover, body));
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
    wrap_at(assist, editor, false, false)
}

/// Module pages sit in a scrolling composition. Read the preceding frame's
/// text geometry before the accessibility-enabled editor clears it for paint.
/// The assist's deferred overlays still paint above the text.
pub fn wrap_module(assist: &Entity<Assist>, editor: impl IntoElement) -> impl IntoElement {
    wrap_at(assist, editor, true, false)
}

/// [`wrap_module`] for a natural-height (`flow`) prose module inside an
/// outer scrolling page (`EntryPage`), sizing horizontally (`w_full`) without
/// clamping height.
pub fn wrap_flat_module(assist: &Entity<Assist>, editor: impl IntoElement) -> impl IntoElement {
    wrap_at(assist, editor, true, true)
}

fn wrap_at(
    assist: &Entity<Assist>,
    editor: impl IntoElement,
    assist_first: bool,
    fit_content: bool,
) -> impl IntoElement {
    let (up, down, enter, esc) = (
        assist.clone(),
        assist.clone(),
        assist.clone(),
        assist.clone(),
    );
    let copy = assist.clone();
    let cut = assist.clone();
    let paste = assist.clone();
    let plain = assist.clone();
    // Where the editor is, for the relation lines and their composer.
    let viewport = {
        let probe = assist.clone();
        canvas(
            move |bounds, _, cx| probe.read(cx).relate.viewport.set(Some(bounds)),
            |_, _, _, _| {},
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full()
    };
    div()
        .when(fit_content, |d| d.w_full())
        .when(!fit_content, |d| d.size_full())
        .relative()
        .child(viewport)
        .capture_action(move |_: &gpui_prose::input::actions::Copy, window, cx| {
            if crate::clipboard::copy(&copy.read(cx).editor.clone(), false, window, cx) {
                cx.stop_propagation();
            }
        })
        .capture_action(move |_: &gpui_prose::input::actions::Cut, window, cx| {
            if crate::clipboard::copy(&cut.read(cx).editor.clone(), true, window, cx) {
                cx.stop_propagation();
            }
        })
        .capture_action(move |_: &gpui_prose::input::actions::Paste, window, cx| {
            // Drifting's own copy first, then another program's formatting;
            // else gpui-prose pastes the plain text.
            let editor = paste.read(cx).editor.clone();
            if crate::clipboard::paste(&editor, window, cx)
                || crate::clipboard::paste_html(&editor, window, cx)
            {
                cx.stop_propagation();
            }
        })
        // ⇧⌘V: only the text, past every formatted paste above and the
        // tables, images and files of the host's own ⌘V.
        .capture_action(move |_: &crate::clipboard::PasteAsPlainText, window, cx| {
            let editor = plain.read(cx).editor.clone();
            if crate::clipboard::paste_plain_text(&editor, window, cx) {
                cx.stop_propagation();
            }
        })
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
        .capture_key_down(move |event: &KeyDownEvent, window, cx| {
            let key = event.keystroke.key.as_str();
            if key == "escape" {
                let a = esc.read(cx);
                if a.menu.is_some() || a.bar.is_some() || a.card.is_some() || a.relate.composing() {
                    let focus = a.editor.read(cx).focus_handle(cx);
                    window.focus(&focus, cx);
                    esc.update(cx, |a, cx| a.dismiss(cx));
                    cx.stop_propagation();
                }
                return;
            }
            if esc
                .read(cx)
                .menu
                .as_ref()
                .is_some_and(|m| m.kind == MenuKind::Material)
                && !event.keystroke.modifiers.modified()
            {
                match key {
                    "up" => {
                        esc.update(cx, |a, cx| {
                            let step = if a.menu.as_ref().is_some_and(|m| m.rows.len() > 3) {
                                -3
                            } else {
                                -1
                            };
                            a.move_selection(step, cx);
                        });
                        cx.stop_propagation();
                    }
                    "down" => {
                        esc.update(cx, |a, cx| {
                            let step = if a.menu.as_ref().is_some_and(|m| m.rows.len() > 3) {
                                3
                            } else {
                                1
                            };
                            a.move_selection(step, cx);
                        });
                        cx.stop_propagation();
                    }
                    "left" => {
                        let search_focused =
                            esc.read(cx).material_picker.as_ref().is_some_and(|p| {
                                p.search.read(cx).focus_handle(cx).is_focused(window)
                            });
                        if !search_focused {
                            esc.update(cx, |a, cx| a.move_selection(-1, cx));
                            cx.stop_propagation();
                        }
                    }
                    "right" => {
                        let search_focused =
                            esc.read(cx).material_picker.as_ref().is_some_and(|p| {
                                p.search.read(cx).focus_handle(cx).is_focused(window)
                            });
                        if !search_focused {
                            esc.update(cx, |a, cx| a.move_selection(1, cx));
                            cx.stop_propagation();
                        }
                    }
                    _ => {}
                }
            }
        })
        .on_mouse_up(gpui::MouseButton::Left, {
            let assist = assist.clone();
            move |event: &gpui::MouseUpEvent, _, cx| {
                // A plain click (no drag, no modifier) on a link.
                if event.click_count == 1 && !event.modifiers.modified() {
                    assist.update(cx, |a, cx| {
                        if a.editor.read(cx).selection().is_empty() {
                            a.link_clicked(cx);
                        }
                    });
                }
            }
        })
        .map(|root| {
            if assist_first {
                root.child(assist.clone()).child(editor)
            } else {
                root.child(editor).child(assist.clone())
            }
        })
}

fn collect_picker_subtree(folders: &[AssetFolderInfo], root: &str, out: &mut HashSet<String>) {
    if !out.insert(root.to_owned()) {
        return;
    }
    for f in folders {
        if f.parent.as_deref() == Some(root) {
            collect_picker_subtree(folders, &f.id, out);
        }
    }
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
