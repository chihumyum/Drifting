//! The outline rail in the page's left margin (M04; the 0.1 client's
//! `EditorOutlineRail`): words only, no marks.
//!
//! - On an entry's page its first level is the page's modules, in the
//!   page's order, each named as its head on the page names it; a body's
//!   H1, H2 and H3 come under its own module (OL, `kernel-v5.md` §15 item
//!   32, as the 0.1 client's element page lists its sections). Every body
//!   on the page is listed: the template's `show_outline` no longer counts.
//!   A module's row is in the structure face at a chapter's size (10.5 px,
//!   the 0.1 sections' tier).
//! - On a whole book's page (M05): its acts and the entries without book
//!   prose (11 px), each entry (10.5 px), under it the module of each body
//!   the view shows (10 px), then that body's headings, as in the 0.1
//!   client's 通览全书 with the modules between.
//! - Headings: H1 9.5, H2 9, H3 8 px in the index face.
//! - While every row fits, it stands at the share of the page above it
//!   (its top over the page's height): the rail is a map of the whole page.
//!   Rows keep 17 px apart, pushed down and, at the bottom, back up.
//! - When they do not fit, nothing is folded: the rows stand one after
//!   another, 17 px apart, and the rail scrolls on its own. It follows the
//!   row being read, which stays where it is until it comes within three
//!   rows of the rail's top or bottom; then the rail moves just enough
//!   (never to centre it). Once the author scrolls the rail it stays where
//!   they left it until the page scrolls.
//! - The row being read (the last one starting above the reading line, 80
//!   px below the top of the view) and its parents are drawn in the
//!   deepest ink, bold; those whose sections are on screen in the next
//!   ink.
//! - A click puts a heading at the top of the view, the caret at its
//!   start; an act or a chapter goes to the chapter's title
//!   (`BookEditor::jump_to`); a module of an entry's page goes to the top
//!   of the page, the caret where it was. The outline button in the
//!   paper's corner shows or hides the rail; it also hides itself when the
//!   margin left of the text is narrower than 196 px.
//!
//! H1, H2 and H3 are three levels whose meaning the author decides; the
//! rail treats them alike apart from their size.

use dr_i18n::keys;
use dr_ui::{
    Theme,
    fonts::{Role, weight},
    style::DrStyled,
};
use gpui::{
    AnyElement, App, Entity, InteractiveElement, IntoElement, ParentElement, ScrollHandle,
    StatefulInteractiveElement, Styled, Window, div, point, prelude::FluentBuilder as _, px,
};
use gpui_prose::text::BlockKind;

use super::Workspace;
use super::editors::{PAGE_GUTTER, PageView};
use crate::nav::Target;
use crate::v3::page::EntryPage;

/// The space each label keeps from the next.
pub const PITCH: f32 = 17.0;
/// The rail's top and bottom room (half a label).
const PAD: f32 = 9.0;
/// The rail is at most this wide; its labels start this far in.
const RAIL_WIDTH: f32 = 190.0;
const LABEL_LEFT: f32 = 12.0;
/// Narrower than this, the margin has no room for the rail.
pub const MIN_GUTTER: f32 = 196.0;
/// The reading line, below the top of the view, and its allowance.
const READING_LINE: f64 = 80.0;
const READING_SLACK: f64 = 24.0;
/// Following the page, the row being read keeps this many rows from the
/// rail's edges before the rail moves.
const FOLLOW_ROWS: f32 = 3.0;

/// An act, or an entry without book prose above a chapter (whole book).
pub const ACT: u8 = 1;
/// A chapter: an entry of the whole book.
pub const CHAPTER: u8 = 2;
/// A module: of an entry's page, or one of an entry's bodies in the whole
/// book.
pub const MODULE: u8 = 3;

/// One row of the rail.
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    /// [`ACT`], [`CHAPTER`], [`MODULE`]; 4–6 an H1–H3.
    pub level: u8,
    pub text: String,
    /// The chapter (prose document of its editor) it is in (0 on one
    /// document's page).
    pub chapter: usize,
    /// The paragraph it is; `None` for an act, a chapter or a module.
    pub line: Option<usize>,
    /// Its top in the page, px.
    pub top: f64,
}

/// The tier of a paragraph's heading level.
fn tier(kind: BlockKind) -> Option<u8> {
    match kind {
        BlockKind::Body => None,
        BlockKind::H1 => Some(4),
        BlockKind::H2 => Some(5),
        BlockKind::H3 => Some(6),
    }
}

/// Where a row goes when clicked.
#[derive(Clone)]
enum Jump {
    /// A heading, an act or a chapter of one editor ([`jump_to`]).
    Prose {
        view: PageView,
        chapter: usize,
        line: Option<usize>,
    },
    /// A module of an entry's page: its top to the top of the page; a
    /// body's, the caret at the body's start too.
    Section {
        page: Entity<EntryPage>,
        ix: usize,
        body: Option<PageView>,
    },
}

/// What the rail lists for a page, and where the page is.
pub struct Rows {
    pub entries: Vec<Entry>,
    jumps: Vec<Jump>,
    /// The page's height, how far it is scrolled and how much of it shows.
    pub total: f64,
    pub scroll: f64,
    pub view: f64,
    /// The whole book's page: its modules sit under its entries.
    pub whole_book: bool,
}

impl Rows {
    /// The row being read.
    pub fn active(&self) -> Option<usize> {
        active(&self.entries, self.scroll)
    }
}

/// The rail's own scroll, per page.
#[derive(Default)]
pub struct RailScroll {
    handle: ScrollHandle,
    /// The author scrolled the rail: it stays there until the page
    /// scrolls.
    away: bool,
    /// The page's scroll the last time the rail was drawn.
    page_scroll: Option<f64>,
}

impl RailScroll {
    /// The page is at `scroll`: moved since the last frame, the rail
    /// follows it again.
    fn saw_page(&mut self, scroll: f64) {
        if self
            .page_scroll
            .is_none_or(|was| (was - scroll).abs() >= 0.5)
        {
            self.away = false;
        }
        self.page_scroll = Some(scroll);
    }
}

/// The key the rail's scroll is kept under: its page's (one page per
/// entry, whichever module a target names).
fn rail_key(target: &Target) -> String {
    match target {
        Target::Entry { id, .. } => Target::Entry {
            id: id.clone(),
            module: None,
        }
        .key(),
        other => other.key(),
    }
}

impl Workspace {
    /// How far the rail beside `target`'s page is scrolled, if it has been
    /// drawn (tests, the debug bridge).
    pub fn outline_scroll(&self, target: &Target) -> Option<f32> {
        let rail = self.outline_rails.get(&rail_key(target))?;
        Some(-f32::from(rail.handle.offset().y))
    }
}

/// An entry's parent: the nearest earlier entry of a higher level.
fn parent_of(entries: &[Entry], i: usize) -> Option<usize> {
    let level = entries[i].level;
    (0..i).rev().find(|&j| entries[j].level < level)
}

/// The entry being read: the last whose top is above the reading line.
pub fn active(entries: &[Entry], scroll_top: f64) -> Option<usize> {
    if entries.is_empty() {
        return None;
    }
    let line = scroll_top + READING_LINE + READING_SLACK;
    entries.iter().rposition(|e| e.top <= line).or(Some(0))
}

/// Where each label stands on a rail `height` px tall, and the height of
/// the rail's content: while they all fit, at their share of the page
/// (`total` px), kept apart; otherwise one after another, the rail taller
/// than it shows (it scrolls).
pub fn plan(entries: &[Entry], total: f64, height: f32) -> (Vec<f32>, f32) {
    let n = entries.len();
    if n == 0 {
        return (Vec::new(), height);
    }
    let span = (height - 2.0 * PAD).max(0.0);
    let capacity = (span / PITCH).floor() as usize;
    if n > capacity {
        let ys = (0..n).map(|i| PAD + i as f32 * PITCH).collect();
        return (ys, 2.0 * PAD + (n - 1) as f32 * PITCH);
    }
    let fraction = |i: usize| -> f32 {
        if total > 0.0 {
            (entries[i].top / total).clamp(0.0, 1.0) as f32
        } else if n > 1 {
            i as f32 / (n - 1) as f32
        } else {
            0.0
        }
    };
    let mut ys: Vec<f32> = (0..n).map(|i| PAD + fraction(i) * span).collect();
    spread(&mut ys, PAD, height - PAD);
    (ys, height)
}

/// Keeps labels [`PITCH`] apart between `min` and `max`.
pub fn spread(ys: &mut [f32], min: f32, max: f32) {
    let n = ys.len();
    if n == 0 {
        return;
    }
    let forward = |ys: &mut [f32], from: f32| {
        ys[0] = ys[0].max(from);
        for i in 1..ys.len() {
            ys[i] = ys[i].max(ys[i - 1] + PITCH);
        }
    };
    forward(ys, f32::MIN);
    if ys[n - 1] > max {
        ys[n - 1] = max;
        for i in (0..n - 1).rev() {
            ys[i] = ys[i].min(ys[i + 1] - PITCH);
        }
        if ys[0] < min {
            forward(ys, min);
        }
    }
}

/// Where a rail `height` px tall over `content` px, scrolled to `scroll`,
/// scrolls to keep the label at `y` in view: it stays put while the label
/// is [`FOLLOW_ROWS`] rows or more from either edge, and moves just enough
/// otherwise.
pub fn follow(y: f32, scroll: f32, height: f32, content: f32) -> f32 {
    let margin = FOLLOW_ROWS * PITCH;
    let mut to = scroll;
    if y - margin < to {
        to = y - margin;
    } else if y + margin > to + height {
        to = y + margin - height;
    }
    to.clamp(0.0, (content - height).max(0.0))
}

/// The headings of the page in `view` (and, for the whole book, its acts
/// and chapters), with their tops in the editor, the editor's height, its
/// scroll and the view's height.
pub fn read(view: &PageView, cx: &App) -> (Vec<Entry>, f64, f64, f64) {
    let book_editor = match view {
        PageView::Book(b) => Some(b.read(cx)),
        PageView::Doc(_) => None,
    };
    let whole_book = book_editor.is_some();
    let prose = view.prose(cx);
    let prose = prose.read(cx);
    let heights = prose.heights();
    let mut heights = heights.borrow_mut();
    let book = prose.book();
    let mut entries = Vec::new();
    for (chapter, c) in book.chapters.iter().enumerate() {
        if whole_book {
            let item = book.chapter_item(chapter);
            if item < heights.len() {
                let top = heights.top(item);
                if let Some(b) = &book_editor {
                    for h in b.headings_before(chapter) {
                        if h.depth > 0 && !h.title.is_empty() {
                            entries.push(Entry {
                                level: ACT,
                                text: h.title.clone(),
                                chapter,
                                line: None,
                                top,
                            });
                        }
                    }
                }
                if let Some(act) = book.act_opening(chapter) {
                    entries.push(Entry {
                        level: ACT,
                        text: act.to_string(),
                        chapter,
                        line: None,
                        top,
                    });
                }
                entries.push(Entry {
                    level: CHAPTER,
                    text: c.title.to_string(),
                    chapter,
                    line: None,
                    top,
                });
            }
        }
        let doc = &c.doc;
        for (line, l) in doc.lines()[..doc.visible_lines()].iter().enumerate() {
            let Some(level) = tier(l.kind) else {
                continue;
            };
            let item = book.line_item(chapter, line);
            if item < heights.len() {
                entries.push(Entry {
                    level,
                    text: l.text.trim_end_matches('\n').to_owned(),
                    chapter,
                    line: Some(line),
                    top: heights.top(item),
                });
            }
        }
    }
    let total = heights.total();
    drop(heights);
    let (scroll, _) = prose.scroll_y();
    let view = f64::from(f32::from(prose.list_state().viewport_bounds().size.height));
    (entries, total, scroll, view)
}

// G2's versioned prose adapter. The shell never imports a view crate and the
// registry owns no editor or library lease.
type V3OutlineKey = (gpui::EntityId, String, Option<(String, String)>);
#[derive(Default)]
struct V3Outlines(std::collections::HashMap<V3OutlineKey, Vec<V3Outline>>);
impl gpui::Global for V3Outlines {}
struct V3Outline {
    owner: gpui::WeakEntity<Workspace>,
    library: usize,
    editor: crate::pages::PageEditorRef,
    _changed: gpui::Subscription,
}
fn outline_editor(editor: &crate::pages::PageEditorRef) -> Option<PageView> {
    match editor {
        crate::pages::PageEditorRef::Doc(editor) => Some(PageView::Doc(editor.upgrade()?)),
        crate::pages::PageEditorRef::Book(editor) => Some(PageView::Book(editor.upgrade()?)),
    }
}
fn outline_editor_id(editor: &crate::pages::PageEditorRef) -> gpui::EntityId {
    match editor {
        crate::pages::PageEditorRef::Doc(editor) => editor.entity_id(),
        crate::pages::PageEditorRef::Book(editor) => editor.entity_id(),
    }
}
impl Workspace {
    /// G1 calls after creating each real editor (and when replacing it).
    /// `Some((entry,module))` registers one prose module; `None` the v3 whole
    /// manuscript editor. This does not reborrow the host workspace.
    pub fn register_v3_outline_editor(
        host: &crate::pages::PageHost,
        entry: Option<(&str, &str)>,
        cx: &mut App,
    ) {
        let Some(editor) = outline_editor(&host.editor) else {
            return;
        };
        let prose = editor.prose(cx);
        let owner = host.workspace.clone();
        let changed = cx.observe(&prose, move |_, cx| {
            owner.update(cx, |_, cx| cx.notify()).ok();
        });
        let key = (
            host.workspace.entity_id(),
            host.book.clone(),
            entry.map(|(entry, module)| (entry.to_owned(), module.to_owned())),
        );
        let registry = cx.default_global::<V3Outlines>();
        registry.0.retain(|_, entries| {
            entries.retain(|entry| {
                entry.owner.upgrade().is_some() && outline_editor(&entry.editor).is_some()
            });
            !entries.is_empty()
        });
        let entries = registry.0.entry(key).or_default();
        // A whole-book reload replaces its prose inside the same editor.
        entries.retain(|entry| outline_editor_id(&entry.editor) != outline_editor_id(&host.editor));
        entries.push(V3Outline {
            owner: host.workspace.clone(),
            library: host.library.library() as *const _ as usize,
            editor: host.editor.clone(),
            _changed: changed,
        });
    }
}

/// The editor registered for `entry` (one body module; `None`: the whole
/// book) that is mounted under `target`'s page. Different tabs each compose
/// their own editor instances: only the one mounted under this exact page
/// is its rail's; another live tab reading the same document is not.
fn v3_registered(
    w: &Workspace,
    owner: gpui::EntityId,
    target: &Target,
    entry: Option<(String, String)>,
    window: &Window,
    cx: &App,
) -> Option<PageView> {
    use gpui::Focusable as _;
    let registry = cx.try_global::<V3Outlines>()?;
    let identity = w.library.as_ref()?.library() as *const _ as usize;
    let page = w.page_of(target)?;
    let page_focus = page
        .v3
        .as_ref()
        .map(|page| page.read(cx).focus.clone())
        .or_else(|| page.module.as_ref().map(|page| page.focus.clone()))?;
    registry
        .0
        .get(&(owner, w.book_id.clone(), entry))?
        .iter()
        .filter(|adapter| adapter.library == identity)
        .filter_map(|adapter| outline_editor(&adapter.editor))
        .find(|editor| page_focus.contains(&editor.prose(cx).focus_handle(cx), window))
}

/// The editor of body `module` on `target`'s entry page.
fn v3_module_editor(
    w: &Workspace,
    owner: gpui::EntityId,
    target: &Target,
    module: &str,
    window: &Window,
    cx: &App,
) -> Option<PageView> {
    let Target::Entry { id, .. } = target else {
        return None;
    };
    v3_registered(
        w,
        owner,
        target,
        Some((id.to_string(), module.to_owned())),
        window,
        cx,
    )
}

/// What the rail beside `target`'s page lists.
pub fn rows(
    w: &Workspace,
    owner: gpui::EntityId,
    target: &Target,
    window: &Window,
    cx: &App,
) -> Option<Rows> {
    if w.book.v3().is_some() {
        if matches!(target, Target::Entry { .. }) {
            return entry_rows(w, owner, target, window, cx);
        }
        if target.is_book() {
            let editor = v3_registered(w, owner, target, None, window, cx)?;
            return Some(book_rows(w, editor, cx));
        }
    }
    let editor = w.page_view(target)?.clone();
    let (entries, total, scroll, view) = read(&editor, cx);
    let jumps = entries
        .iter()
        .map(|e| Jump::Prose {
            view: editor.clone(),
            chapter: e.chapter,
            line: e.line,
        })
        .collect();
    Some(Rows {
        entries,
        jumps,
        total,
        scroll,
        view,
        whole_book: matches!(editor, PageView::Book(_)),
    })
}

/// An entry's page: its modules in the page's order (the template's; not
/// the blocks the page adds after them for an entry whose template has no
/// such module, nor the level's settings), each body's headings under its
/// module.
fn entry_rows(
    w: &Workspace,
    owner: gpui::EntityId,
    target: &Target,
    window: &Window,
    cx: &App,
) -> Option<Rows> {
    let Target::Entry { id, .. } = target else {
        return None;
    };
    let template = w.book.v3()?.template_of(id.as_str())?;
    let page_entity = w.page_of(target)?.v3.clone()?;
    let page = page_entity.read(cx);
    let geometry = page.outline_geometry()?;
    let mut entries = Vec::new();
    let mut jumps = Vec::new();
    for (ix, section) in page.sections.iter().enumerate() {
        if !template.modules.iter().any(|m| m.id == section.id) {
            continue;
        }
        let Some(top) = geometry.sections.get(ix).copied().flatten() else {
            continue;
        };
        entries.push(Entry {
            level: MODULE,
            text: section.name.clone(),
            chapter: 0,
            line: None,
            top,
        });
        let body = (section.kind == "prose")
            .then(|| v3_module_editor(w, owner, target, &section.id, window, cx))
            .flatten();
        jumps.push(Jump::Section {
            page: page_entity.clone(),
            ix,
            body: body.clone(),
        });
        let Some(editor) = body else {
            continue;
        };
        let Some(editor_top) = editor.prose(cx).read(cx).flow_page_top() else {
            continue;
        };
        let (headings, ..) = read(&editor, cx);
        for heading in headings {
            jumps.push(Jump::Prose {
                view: editor.clone(),
                chapter: heading.chapter,
                line: heading.line,
            });
            entries.push(Entry {
                top: f64::from(editor_top) + heading.top,
                ..heading
            });
        }
    }
    Some(Rows {
        entries,
        jumps,
        total: geometry.total,
        scroll: geometry.scroll,
        view: geometry.view,
        whole_book: false,
    })
}

/// A whole book's page: under each entry the module of each body the view
/// shows, then that body's headings. An entry's second body is the view's
/// next chapter (titled with its module's name): it is only a module row.
fn book_rows(w: &Workspace, editor: PageView, cx: &App) -> Rows {
    let (headings, total, scroll, view) = read(&editor, cx);
    let book = match &editor {
        PageView::Book(book) => Some(book.read(cx)),
        PageView::Doc(_) => None,
    };
    let module_of = |chapter: usize| -> Option<(String, String)> {
        let doc = book?.chapter_docs().nth(chapter)?;
        let (entry, module) = doc.strip_prefix("body:")?.rsplit_once('/')?;
        let name = w
            .book
            .v3()?
            .template_of(entry)?
            .modules
            .iter()
            .find(|m| m.id == module)?
            .name
            .clone();
        Some((entry.to_owned(), name))
    };
    let mut entries = Vec::new();
    let mut jumps = Vec::new();
    let mut last_entry: Option<String> = None;
    for heading in headings {
        let jump = Jump::Prose {
            view: editor.clone(),
            chapter: heading.chapter,
            line: heading.line,
        };
        if heading.level != CHAPTER {
            entries.push(heading);
            jumps.push(jump);
            continue;
        }
        let Some((entry, module)) = module_of(heading.chapter) else {
            last_entry = None;
            entries.push(heading);
            jumps.push(jump);
            continue;
        };
        if last_entry.as_deref() != Some(entry.as_str()) {
            entries.push(heading.clone());
            jumps.push(jump.clone());
        }
        last_entry = Some(entry);
        entries.push(Entry {
            level: MODULE,
            text: module,
            ..heading
        });
        jumps.push(jump);
    }
    Rows {
        entries,
        jumps,
        total,
        scroll,
        view,
        whole_book: true,
    }
}

/// A row's size, ink (1 deepest) and face.
fn face(level: u8, whole_book: bool) -> (f32, usize, Role) {
    match level {
        ACT => (11.0, 2, Role::Structure),
        CHAPTER => (10.5, 3, Role::Structure),
        MODULE if whole_book => (10.0, 3, Role::Structure),
        MODULE => (10.5, 3, Role::Structure),
        4 => (9.5, 3, Role::Ui),
        5 => (9.0, 4, Role::Ui),
        _ => (8.0, 5, Role::Index),
    }
}

/// The rail beside the page showing `target`, in a column `column_w` wide
/// and `column_h` tall, if it is shown and has room.
pub fn rail(
    w: &mut Workspace,
    ws: &Entity<Workspace>,
    target: Option<&Target>,
    column_w: f32,
    column_h: f32,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    if w.outline_hidden || w.immersive || w.covered() {
        return None;
    }
    let target = target?;
    let page_w = w.editor_settings.page_width;
    let sheet = page_w.min(column_w);
    let gutter = (column_w - sheet) / 2.0 + PAGE_GUTTER;
    if gutter < MIN_GUTTER {
        return None;
    }
    let rows = rows(w, ws.entity_id(), target, window, cx)?;
    if rows.entries.is_empty() {
        return None;
    }
    let Rows {
        entries,
        jumps,
        total,
        scroll,
        view,
        whole_book,
    } = &rows;
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let top = (super::TITLEBAR_HEIGHT + dr_ui::tokens::glass::PILL_HEIGHT) / 2.0;
    let height = (column_h - top).max(0.0);
    let width = RAIL_WIDTH.min(gutter - 8.0);
    let current = rows.active();
    let parent: Vec<Option<usize>> = (0..entries.len()).map(|i| parent_of(entries, i)).collect();
    let mut lineage = vec![false; entries.len()];
    let mut at = current;
    while let Some(i) = at {
        lineage[i] = true;
        at = parent[i];
    }
    // Sections on screen, and their parents.
    let mut visible = vec![false; entries.len()];
    for i in 0..entries.len() {
        let start = entries[i].top;
        let end = entries.get(i + 1).map_or(*total, |e| e.top);
        if end > *scroll && start < *scroll + *view {
            let mut at = Some(i);
            while let Some(j) = at {
                visible[j] = true;
                at = parent[j];
            }
        }
    }
    let (ys, content) = plan(entries, *total, height);
    let scrolls = content > height;
    // The rail's own scroll: still while the author has scrolled it and
    // the page has not moved since; otherwise it follows the row read.
    let key = rail_key(target);
    let open: Vec<String> = w
        .outline_rails
        .keys()
        .filter(|k| Target::from_key(k).is_some_and(|t| w.page_of(&t).is_some()))
        .cloned()
        .collect();
    w.outline_rails.retain(|k, _| *k == key || open.contains(k));
    let state = w.outline_rails.entry(key.clone()).or_default();
    state.saw_page(*scroll);
    let handle = state.handle.clone();
    if !scrolls {
        state.away = false;
        handle.set_offset(point(px(0.0), px(0.0)));
    } else if !state.away
        && let Some(i) = current
    {
        let at = -f32::from(handle.offset().y);
        let to = follow(ys[i], at, height, content);
        handle.set_offset(point(px(0.0), px(-to)));
    }
    let v3_labels = w.book.v3().is_some();
    let page = target.key();
    let labels: Vec<AnyElement> = entries
        .iter()
        .zip(ys)
        .enumerate()
        .map(|(i, (e, y))| {
            let (size, ink, role) = face(e.level, *whole_book);
            let ink = if lineage[i] {
                p.ink(1)
            } else if visible[i] {
                p.ink(2)
            } else {
                p.ink(ink)
            };
            let jump = jumps[i].clone();
            let ws = ws.clone();
            let key = key.clone();
            div()
                .id(gpui::ElementId::Name(format!("outline-{page}-{i}").into()))
                .debug_selector({
                    let page = page.clone();
                    move || format!("outline-row-{page}-{i}")
                })
                .absolute()
                .left(px(LABEL_LEFT))
                .top(px(y - PITCH / 2.0))
                .max_w(px(width - LABEL_LEFT - 2.0))
                .h(px(PITCH))
                .flex()
                .items_center()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .cursor_pointer()
                .font_role(role)
                .text_size(px(size))
                .when(lineage[i], |el| el.weight(weight::SEMIBOLD))
                .text_color(ink.solid())
                .role(gpui::Role::Link)
                .when(v3_labels, |el| el.aria_label(e.text.clone()))
                .child(e.text.clone())
                .on_click(move |_, window, cx| {
                    ws.update(cx, |ws, cx| {
                        if let Some(rail) = ws.outline_rails.get_mut(&key) {
                            rail.away = false;
                        }
                        cx.notify();
                    });
                    go(&jump, window, cx);
                })
                .into_any_element()
        })
        .collect();
    let away = ws.clone();
    let wheel_key = key.clone();
    Some(
        div()
            .id(gpui::ElementId::Name(
                format!("outline-rail-{}", target.key()).into(),
            ))
            .debug_selector({
                let page = page.clone();
                move || format!("outline-rail-{page}")
            })
            .absolute()
            .left_0()
            .top(px(top))
            .bottom_0()
            .w(px(width))
            .role(gpui::Role::Navigation)
            .aria_label(crate::t(cx, keys::editor_outline::ARIA))
            .when(scrolls, |rail| {
                rail.overflow_y_scroll()
                    .track_scroll(&handle)
                    .on_scroll(move |_, _, cx| {
                        away.update(cx, |ws, cx| {
                            if let Some(rail) = ws.outline_rails.get_mut(&wheel_key) {
                                rail.away = true;
                            }
                            cx.notify();
                        });
                    })
            })
            .child(div().relative().w_full().h(px(content)).children(labels))
            .into_any_element(),
    )
}

/// Goes where a row points.
fn go(jump: &Jump, window: &mut Window, cx: &mut App) {
    match jump {
        Jump::Prose {
            view,
            chapter,
            line,
        } => jump_to(view, *chapter, *line, window, cx),
        Jump::Section { page, ix, body } => {
            let ix = *ix;
            page.update(cx, |page, cx| page.scroll_to_section(ix, cx));
            // A body's row also puts the caret at the body's start (as the
            // prototype's click does), the page left at the module's top.
            if let Some(body) = body {
                body.prose(cx)
                    .update(cx, |p, cx| p.place_caret(0, 0, window, cx));
            }
        }
    }
}

/// The heading at paragraph `line` of `chapter` to the top of the view,
/// the caret at its start; without a line, the chapter's title
/// (`BookEditor::jump_to` on the whole book).
pub fn jump_to(
    view: &PageView,
    chapter: usize,
    line: Option<usize>,
    window: &mut Window,
    cx: &mut App,
) {
    let prose = view.prose(cx);
    match (view, line) {
        (PageView::Book(book), None) => {
            let doc = book.read(cx).chapter_docs().nth(chapter).map(str::to_owned);
            if let Some(doc) = doc {
                book.update(cx, |b, cx| b.jump_to(&doc, window, cx));
            }
        }
        (_, line) => prose.update(cx, |p, cx| {
            p.jump_to_line(chapter, line.unwrap_or(0), window, cx);
        }),
    }
    let focus = gpui::Focusable::focus_handle(prose.read(cx), cx);
    window.focus(&focus, cx);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{rc::Rc, time::Duration};

    #[gpui::test]
    fn an_entry_opened_from_two_targets_owns_one_outline_editor(cx: &mut gpui::TestAppContext) {
        use gpui::{AppContext as _, Context, FocusHandle, Render, prelude::*};
        use std::{cell::RefCell, time::Instant};
        struct ProsePart {
            editor: Entity<dr_editor::ChapterEditor>,
            focus: FocusHandle,
        }
        impl Render for ProsePart {
            fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
                div()
                    .id("v3-outline-test-body")
                    .track_focus(&self.focus)
                    .h(px(300.0))
                    .w_full()
                    .child(self.editor.clone())
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let store = dr_store::Library::open(dir.path(), dr_workspace::library_options("0.2.0-dev"))
            .unwrap();
        let seed = dr_testkit::seed::generate_v3(
            dr_testkit::seed::Preset::Tiny,
            dr_testkit::seed::DEFAULT_SEED,
        )
        .unwrap();
        let book = seed.books[0].book_id().to_string();
        seed.write_to(&store).unwrap();
        store.close().unwrap();
        let lib = dr_workspace::Workspace::open_dir(dir.path(), "0.2.0-dev").unwrap();
        let made = Rc::new(RefCell::new(Vec::new()));
        cx.executor().allow_parking();
        cx.update(|cx| {
            crate::init(
                crate::ShellInfo {
                    app_name: "Drifting Next",
                    bundle_id: "cc.drifting.next.dev",
                    version: "0.2.0-dev",
                    url_scheme: "drifting-next-dev",
                    forced_appearance: None,
                },
                crate::Services {
                    library: Some(lib),
                    book: Some(book),
                    ..Default::default()
                },
                crate::SettingsFile::in_memory(),
                cx,
            );
            let made = made.clone();
            crate::v3::add_module_view(cx, "prose", move |host, window, cx| {
                let source = dr_editor::v3::prepare_body(
                    &host.page.library,
                    &host.page.book_id,
                    &host.entry,
                    &host.module.id,
                )
                .unwrap();
                let doc = format!("body:{}/{}", host.entry, host.module.id);
                let settings = super::super::editors::editor_settings(cx);
                let editor = cx.new(|cx| {
                    dr_editor::ChapterEditor::with_session(
                        host.page.library.clone(),
                        &host.page.book_id,
                        &doc,
                        source,
                        settings,
                        window,
                        cx,
                    )
                });
                let page = crate::pages::PageHost {
                    workspace: host.page.workspace,
                    library: host.page.library,
                    book: host.page.book_id,
                    editor: crate::pages::PageEditorRef::Doc(editor.downgrade()),
                };
                Workspace::register_v3_outline_editor(
                    &page,
                    Some((&host.entry, &host.module.id)),
                    cx,
                );
                made.borrow_mut().push(editor.clone());
                let view = cx.new(|cx| ProsePart {
                    editor,
                    focus: cx.focus_handle(),
                });
                let focus = view.read(cx).focus.clone();
                crate::v3::Rendered::new(view).focus(focus)
            });
        });
        let (shell, cx) = cx.add_window_view(Workspace::new);
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            cx.run_until_parked();
            if shell.read_with(cx, |ws, _| ws.book.v3().is_some()) {
                break;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
        let entry = shell.read_with(cx, |ws, _| {
            ws.book
                .v3()
                .unwrap()
                .entries
                .iter()
                .find(|e| e.template.as_deref() == Some("tpl-chapter"))
                .unwrap()
                .id
                .clone()
        });
        let first = Target::from_key(&format!("entry:{entry}/mod-prose")).unwrap();
        let second = Target::from_key(&format!("entry:{entry}")).unwrap();
        for target in [&first, &second, &first] {
            shell.update(cx, |ws, cx| {
                ws.open(target.clone(), crate::nav::Open::KEEP, cx)
            });
            for _ in 0..6 {
                cx.executor().advance_clock(Duration::from_millis(100));
                cx.update(|window, cx| window.draw(cx).clear(cx));
                cx.run_until_parked();
            }
        }
        // One entry, one tab (kernel v5, T1): the second target is the same
        // page, so its body is mounted once.
        assert_eq!(made.borrow().len(), 1, "one page, one body editor");
        shell.read_with(cx, |ws, _| assert_eq!(ws.nav.tabs().len(), 1));
        cx.update(|window, cx| {
            for target in [&first, &second] {
                let selected = v3_module_editor(
                    shell.read(cx),
                    shell.entity_id(),
                    target,
                    "mod-prose",
                    window,
                    cx,
                )
                .expect("the current page has a mounted prose editor");
                let PageView::Doc(selected) = selected else {
                    panic!("module editor")
                };
                assert_eq!(selected.entity_id(), made.borrow()[0].entity_id());
            }
        });
    }

    fn entry(level: u8, top: f64) -> Entry {
        Entry {
            level,
            text: format!("H{level}"),
            chapter: 0,
            line: Some(top as usize),
            top,
        }
    }

    #[test]
    fn labels_stand_at_their_share_of_the_page() {
        let entries = [entry(1, 0.0), entry(2, 500.0), entry(2, 1000.0)];
        let (ys, content) = plan(&entries, 1000.0, 218.0);
        assert_eq!(ys, [9.0, 109.0, 209.0]);
        assert_eq!(content, 218.0, "they fit: the rail does not scroll");
    }

    #[test]
    fn crowded_labels_keep_apart_and_stay_inside() {
        let mut ys = [9.0, 10.0, 11.0, 200.0, 205.0];
        spread(&mut ys, 9.0, 209.0);
        assert_eq!(ys, [9.0, 26.0, 43.0, 192.0, 209.0]);
        let mut ys = [190.0, 200.0, 205.0];
        spread(&mut ys, 9.0, 209.0);
        assert_eq!(ys, [175.0, 192.0, 209.0]);
    }

    #[test]
    fn too_many_stand_one_after_another_and_the_rail_scrolls() {
        // Four H1s with three H2s each (16 rows); room for 7.
        let mut entries = Vec::new();
        for h1 in 0..4 {
            entries.push(entry(4, (h1 * 400) as f64));
            for h2 in 1..4 {
                entries.push(entry(5, (h1 * 400 + h2 * 100) as f64));
            }
        }
        let height = 2.0 * PAD + 7.0 * PITCH;
        let (ys, content) = plan(&entries, 1600.0, height);
        assert_eq!(ys.len(), entries.len(), "nothing folded");
        let expected: Vec<f32> = (0..16).map(|i| PAD + i as f32 * PITCH).collect();
        assert_eq!(ys, expected, "one after another, 17 px apart");
        assert_eq!(content, 2.0 * PAD + 15.0 * PITCH);
        assert!(content > height, "taller than the rail: it scrolls");
    }

    #[test]
    fn following_keeps_the_row_read_still_until_three_rows_from_an_edge() {
        let (height, content) = (200.0, 1000.0);
        // Well inside: the rail does not move.
        assert_eq!(follow(150.0, 50.0, height, content), 50.0);
        assert_eq!(follow(101.0, 50.0, height, content), 50.0);
        // Within three rows of the bottom: just enough to keep three rows.
        assert_eq!(follow(220.0, 50.0, height, content), 220.0 + 51.0 - 200.0);
        // Within three rows of the top: just enough the other way.
        assert_eq!(follow(80.0, 50.0, height, content), 80.0 - 51.0);
        // Never past either end, and never centred.
        assert_eq!(follow(10.0, 50.0, height, content), 0.0);
        assert_eq!(follow(995.0, 700.0, height, content), 800.0);
    }

    #[test]
    fn the_rail_stays_where_the_author_left_it_until_the_page_scrolls() {
        let mut rail = RailScroll::default();
        rail.saw_page(300.0);
        assert!(!rail.away);
        rail.away = true;
        rail.saw_page(300.0);
        rail.saw_page(300.2);
        assert!(rail.away, "the page did not move: the rail stays");
        rail.saw_page(340.0);
        assert!(!rail.away, "the page scrolled: the rail follows again");
    }

    #[test]
    fn the_heading_read_is_the_last_above_the_reading_line() {
        let entries = [entry(1, 0.0), entry(2, 300.0), entry(2, 900.0)];
        assert_eq!(active(&entries, 0.0), Some(0));
        assert_eq!(active(&entries, 200.0), Some(1));
        assert_eq!(active(&entries, 796.0), Some(2));
        assert_eq!(parent_of(&entries, 2), Some(0));
    }
}
