//! The outline rail in the page's left margin (M04; the 0.1 client's
//! `EditorOutlineRail`): the page's H1, H2 and H3 as words only, no marks;
//! on the whole book's page (M05) also its acts and chapters, five tiers
//! as in the 0.1 client's 通览全书 (act 11 px and chapter 10.5 px in the
//! structure face, then H1 9.5, H2 9, H3 8 px).
//!
//! - A heading's label stands at the share of the document above it (its
//!   top over the document's height), not where it is on screen: the rail is
//!   a map of the whole page and does not move with the scroll.
//! - Labels keep 17 px apart, pushed down and, at the bottom, back up. When
//!   there are more than fit, the rail keeps the top-level headings and the
//!   branch being read; if those are still too many, a window round the
//!   heading being read, the rest folded into a 「…」 for each side.
//! - The heading being read (the last one starting above the reading line,
//!   80 px below the top of the view) and its parents are drawn in the
//!   deepest ink, bold; those whose sections are on screen in the next
//!   ink; the rest by level: H1 9.5 px, H2 9 px, H3 8 px in the index face.
//! - Under the pointer a 「…」 lists what it folds (the ten nearest the
//!   window, as in the 0.1 client), each in its tier's size; a click there
//!   jumps too. The list stays while the pointer moves from the 「…」 onto
//!   it and goes 140 ms after the pointer leaves both.
//! - A click puts that heading at the top of the view, the caret at its
//!   start; an act or a chapter goes to the chapter's title
//!   (`BookEditor::jump_to`). The outline button in the paper's corner shows or hides it; it
//!   also hides itself when the margin left of the text is narrower than
//!   196 px.
//!
//! H1, H2 and H3 are three levels whose meaning the author decides; the
//! rail treats them alike apart from their size.

use std::rc::Rc;

use std::time::Duration;

use dr_i18n::keys;
use dr_ui::{
    Theme,
    components::{
        Menu,
        overlay::{self, Layer, Place},
    },
    fonts::{Role, weight},
    sand::{self, Icon},
    style::DrStyled,
};
use gpui::{
    AnyElement, App, Entity, InteractiveElement, IntoElement, ListOffset, ParentElement,
    StatefulInteractiveElement, Styled, Window, div, point, prelude::FluentBuilder as _, px,
};
use gpui_prose::text::BlockKind;

use super::Workspace;
use super::editors::{PAGE_GUTTER, PageView};
use crate::nav::Target;
use crate::strings::tf;

/// The space each label keeps from the next.
pub const PITCH: f32 = 17.0;
/// The rail's top and bottom room (half a label).
const PAD: f32 = 9.0;
/// The rail is at most this wide; its labels start this far in.
const RAIL_WIDTH: f32 = 190.0;
const LABEL_LEFT: f32 = 12.0;
/// Narrower than this, the margin has no room for the rail.
pub const MIN_GUTTER: f32 = 196.0;
/// A 「…」 lists at most this many of what it folds (the nearest).
const REVEAL_LIMIT: usize = 10;
/// One row of that list, for placing it round the 「…」.
const REVEAL_ROW: f32 = 22.0;
/// How long the list stays after the pointer leaves it and its 「…」.
const REVEAL_CLOSE: Duration = Duration::from_millis(140);
/// The reading line, below the top of the view, and its allowance.
const READING_LINE: f64 = 80.0;
const READING_SLACK: f64 = 24.0;

/// One heading of the page.
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    /// The tier: 1 an act, 2 a chapter, 3–5 H1–H3.
    pub level: u8,
    pub text: String,
    /// The chapter it is in (0 on one document's page).
    pub chapter: usize,
    /// The paragraph it is; `None` for an act or a chapter (its title).
    pub line: Option<usize>,
    /// Its top in the document, px.
    pub top: f64,
}

/// The tier of a paragraph's heading level.
fn tier(kind: BlockKind) -> Option<u8> {
    match kind {
        BlockKind::Body => None,
        BlockKind::H1 => Some(3),
        BlockKind::H2 => Some(4),
        BlockKind::H3 => Some(5),
    }
}

/// What stands at one place on the rail.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Slot {
    Entry(usize),
    /// So many entries folded away before or after the window.
    More {
        count: usize,
        before: bool,
    },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Placed {
    pub slot: Slot,
    pub y: f32,
}

/// The 「…」 whose list is open: its page (target key) and side.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reveal {
    pub page: String,
    pub before: bool,
}

/// What a 「…」 lists: the entries it folds nearest the window, in order
/// (the last ten before it, the first ten after it).
pub fn revealed(n: usize, count: usize, before: bool) -> std::ops::Range<usize> {
    if before {
        count.saturating_sub(REVEAL_LIMIT)..count.min(n)
    } else {
        let start = n.saturating_sub(count);
        start..(start + REVEAL_LIMIT).min(n)
    }
}

impl Workspace {
    /// The pointer came onto a 「…」 or its list.
    fn reveal_outline(&mut self, reveal: Reveal, cx: &mut gpui::Context<Self>) {
        self.outline_reveal_close = None;
        if self.outline_reveal.as_ref() != Some(&reveal) {
            self.outline_reveal = Some(reveal);
            cx.notify();
        }
    }

    /// The pointer left a 「…」 or its list: it closes unless the pointer
    /// comes back within [`REVEAL_CLOSE`].
    fn conceal_outline(&mut self, cx: &mut gpui::Context<Self>) {
        let task = cx.spawn(async move |this, cx| {
            cx.background_executor().timer(REVEAL_CLOSE).await;
            this.update(cx, |ws, cx| {
                ws.outline_reveal = None;
                ws.outline_reveal_close = None;
                cx.notify();
            })
            .ok();
        });
        self.outline_reveal_close = Some(task);
    }
}

/// Opens or closes a 「…」's list as the pointer comes and goes.
fn hover_reveal(
    ws: &Entity<Workspace>,
    reveal: Reveal,
) -> impl Fn(&bool, &mut Window, &mut App) + use<> {
    let ws = ws.clone();
    move |hovered, _, cx| {
        let reveal = reveal.clone();
        ws.update(cx, |ws, cx| {
            if *hovered {
                ws.reveal_outline(reveal, cx)
            } else {
                ws.conceal_outline(cx)
            }
        })
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

/// Where each label stands on a rail `height` px tall.
pub fn plan(entries: &[Entry], total: f64, height: f32, active: Option<usize>) -> Vec<Placed> {
    let n = entries.len();
    if n == 0 {
        return Vec::new();
    }
    let span = (height - 2.0 * PAD).max(0.0);
    let fraction = |i: usize| -> f32 {
        if total > 0.0 {
            (entries[i].top / total).clamp(0.0, 1.0) as f32
        } else if n > 1 {
            i as f32 / (n - 1) as f32
        } else {
            0.0
        }
    };
    let capacity = ((span / PITCH).floor() as usize).max(5);
    let mut slots: Vec<Slot> = if n <= capacity {
        (0..n).map(Slot::Entry).collect()
    } else {
        // The top-level entries and the branch being read.
        let parent: Vec<Option<usize>> = (0..n).map(|i| parent_of(entries, i)).collect();
        let root_of = |mut i: usize| {
            while let Some(p) = parent[i] {
                i = p;
            }
            i
        };
        let active_root = active.map(root_of);
        let branch: Vec<usize> = (0..n)
            .filter(|&i| parent[i].is_none() || Some(root_of(i)) == active_root)
            .collect();
        if branch.len() <= capacity {
            branch.into_iter().map(Slot::Entry).collect()
        } else {
            window(n, capacity, active.unwrap_or(0))
        }
    };
    let mut ys: Vec<f32> = slots
        .iter()
        .map(|s| {
            let at = match *s {
                Slot::Entry(i) => i,
                Slot::More {
                    count,
                    before: true,
                } => count - 1,
                Slot::More {
                    count,
                    before: false,
                } => n - count,
            };
            PAD + fraction(at) * span
        })
        .collect();
    spread(&mut ys, PAD, height - PAD);
    slots
        .drain(..)
        .zip(ys)
        .map(|(slot, y)| Placed { slot, y })
        .collect()
}

/// A window of entries round `active` with a 「…」 for what is left out on
/// each side.
fn window(n: usize, capacity: usize, active: usize) -> Vec<Slot> {
    let size = capacity.saturating_sub(2).max(1);
    let mut start = active.saturating_sub(size / 2);
    let mut end = (start + size).min(n);
    start = end.saturating_sub(size);
    // Touching an edge needs one 「…」 fewer: the window grows by one.
    let omissions = usize::from(start > 0) + usize::from(end < n);
    let size = capacity.saturating_sub(omissions).max(1);
    if start == 0 {
        end = size.min(n);
    } else if end == n {
        start = n.saturating_sub(size);
    } else {
        start = active.saturating_sub(size / 2).min(n - size);
        end = start + size;
    }
    let mut slots = Vec::new();
    if start > 0 {
        slots.push(Slot::More {
            count: start,
            before: true,
        });
    }
    slots.extend((start..end).map(Slot::Entry));
    if end < n {
        slots.push(Slot::More {
            count: n - end,
            before: false,
        });
    }
    slots
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

/// The headings of the page in `view` (and, for the whole book, its acts
/// and chapters), with their tops, the document's height, the scroll and
/// the view's height.
pub fn read(view: &PageView, cx: &App) -> (Vec<Entry>, f64, f64, f64) {
    let whole_book = matches!(view, PageView::Book(_));
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
                if let Some(act) = book.act_opening(chapter) {
                    entries.push(Entry {
                        level: 1,
                        text: act.to_string(),
                        chapter,
                        line: None,
                        top,
                    });
                }
                entries.push(Entry {
                    level: 2,
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

/// The rail beside the page showing `target`, in a column `column_w` wide
/// and `column_h` tall, if it is shown and has room.
pub fn rail(
    w: &Workspace,
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
    let editor = w.page_view(target)?.clone();
    let page_w = w.editor_settings.page_width;
    let sheet = page_w.min(column_w);
    let gutter = (column_w - sheet) / 2.0 + PAGE_GUTTER;
    if gutter < MIN_GUTTER {
        return None;
    }
    let (entries, total, scroll, view) = read(&editor, cx);
    if entries.is_empty() {
        return None;
    }
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let top = (super::TITLEBAR_HEIGHT + dr_ui::tokens::glass::PILL_HEIGHT) / 2.0;
    let height = (column_h - top).max(0.0);
    let width = RAIL_WIDTH.min(gutter - 8.0);
    let current = active(&entries, scroll);
    let parent: Vec<Option<usize>> = (0..entries.len()).map(|i| parent_of(&entries, i)).collect();
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
        let end = entries.get(i + 1).map_or(total, |e| e.top);
        if end > scroll && start < scroll + view {
            let mut at = Some(i);
            while let Some(j) = at {
                visible[j] = true;
                at = parent[j];
            }
        }
    }
    let placed = plan(&entries, total, height, current);
    let entries = Rc::new(entries);
    let page = target.key();
    let open = w
        .outline_reveal
        .as_ref()
        .filter(|r| r.page == page)
        .map(|r| r.before);
    let mut reveal_list: Option<AnyElement> = None;
    let labels = placed.into_iter().map(|Placed { slot, y }| {
        let label_top = px(y - PITCH / 2.0);
        match slot {
            Slot::Entry(i) => {
                let e = &entries[i];
                let (size, ink, role) = match e.level {
                    1 => (11.0, 2, Role::Structure),
                    2 => (10.5, 3, Role::Structure),
                    3 => (9.5, 3, Role::Ui),
                    4 => (9.0, 4, Role::Ui),
                    _ => (8.0, 5, Role::Index),
                };
                let ink = if lineage[i] {
                    p.ink(1)
                } else if visible[i] {
                    p.ink(2)
                } else {
                    p.ink(ink)
                };
                let jump = editor.clone();
                let (chapter, line) = (e.chapter, e.line);
                div()
                    .id(gpui::ElementId::Name(
                        format!("outline-{}-{i}", target.key()).into(),
                    ))
                    .absolute()
                    .left(px(LABEL_LEFT))
                    .top(label_top)
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
                    .child(e.text.clone())
                    .on_click(move |_, window, cx| jump_to(&jump, chapter, line, window, cx))
                    .into_any_element()
            }
            Slot::More { count, before } => {
                let bounds = overlay::use_bounds(
                    gpui::ElementId::Name(format!("outline-more-at-{page}-{before}").into()),
                    window,
                    cx,
                );
                let reveal = Reveal {
                    page: page.clone(),
                    before,
                };
                if open == Some(before)
                    && let Some(at) = *bounds.read(cx)
                {
                    let range = revealed(entries.len(), count, before);
                    reveal_list = Some(reveal_menu(
                        ws,
                        &editor,
                        &entries,
                        range,
                        reveal.clone(),
                        at,
                        &theme,
                    ));
                }
                div()
                    .id(gpui::ElementId::Name(
                        format!("outline-more-{page}-{before}").into(),
                    ))
                    .absolute()
                    .left(px(LABEL_LEFT))
                    .top(label_top)
                    .h(px(PITCH))
                    .flex()
                    .items_center()
                    .role(gpui::Role::Note)
                    .aria_label(tf(
                        cx,
                        keys::editor_outline::HIDDEN_ITEMS,
                        &[("count", &count)],
                    ))
                    .on_hover(hover_reveal(ws, reveal))
                    .child(overlay::probe(bounds))
                    .child(sand::icon(
                        Icon::More,
                        12.0,
                        if open == Some(before) {
                            p.ink(2).solid()
                        } else {
                            p.ink(4).solid()
                        },
                    ))
                    .into_any_element()
            }
        }
    });
    let labels: Vec<AnyElement> = labels.collect();
    Some(
        div()
            .id(gpui::ElementId::Name(
                format!("outline-rail-{}", target.key()).into(),
            ))
            .absolute()
            .left_0()
            .top(px(top))
            .bottom_0()
            .w(px(width))
            .role(gpui::Role::Navigation)
            .aria_label(crate::t(cx, keys::editor_outline::ARIA))
            .children(labels)
            .children(reveal_list)
            .into_any_element(),
    )
}

/// The list a 「…」 opens: the folded entries in `range`, each in its
/// tier's face (the 0.1 client's `editor__toc-reveal-item--l1…l5`),
/// centred on the 「…」.
#[allow(clippy::too_many_arguments)]
fn reveal_menu(
    ws: &Entity<Workspace>,
    editor: &PageView,
    entries: &Rc<Vec<Entry>>,
    range: std::ops::Range<usize>,
    reveal: Reveal,
    at: gpui::Bounds<gpui::Pixels>,
    theme: &Theme,
) -> AnyElement {
    let p = theme.palette;
    let rows = range.len() as f32;
    let top = f32::from(at.center().y) - rows * REVEAL_ROW / 2.0;
    let mut menu = Menu::new(gpui::ElementId::Name(
        format!("outline-reveal-{}-{}", reveal.page, reveal.before).into(),
    ));
    for i in range {
        let e = &entries[i];
        let (size, ink, role, bold) = match e.level {
            1 => (11.0, 2, Role::Structure, true),
            2 => (10.5, 2, Role::Ui, true),
            3 => (10.5, 3, Role::Ui, false),
            4 => (9.5, 3, Role::Ui, false),
            _ => (9.0, 3, Role::Index, false),
        };
        let (jump, ws) = (editor.clone(), ws.clone());
        let (chapter, line) = (e.chapter, e.line);
        let hover = p.ink(1).solid();
        menu = menu.child(
            div()
                .id(gpui::ElementId::Name(
                    format!("outline-reveal-{}-{i}", reveal.page).into(),
                ))
                .mx(px(dr_ui::tokens::menu::ROW_INSET))
                .px(px(10.0))
                .py(px(4.0))
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .cursor_pointer()
                .font_role(role)
                .text_size(px(size))
                .when(bold, |el| el.weight(weight::SEMIBOLD))
                .text_color(p.ink(ink).solid())
                .hover(move |st| st.text_color(hover))
                .role(gpui::Role::Link)
                .child(e.text.clone())
                .on_click(move |_, window, cx| {
                    ws.update(cx, |ws, cx| {
                        ws.outline_reveal = None;
                        ws.outline_reveal_close = None;
                        cx.notify();
                    });
                    jump_to(&jump, chapter, line, window, cx)
                }),
        );
    }
    overlay::float(
        Place::Point(point(at.left(), px(top.max(8.0)))),
        Layer::Popover,
        div()
            .id(gpui::ElementId::Name(
                format!("outline-reveal-hover-{}-{}", reveal.page, reveal.before).into(),
            ))
            .on_hover(hover_reveal(ws, reveal))
            .child(menu),
    )
    .into_any_element()
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
            let line = line.unwrap_or(0);
            let at = p.book().chapters[chapter].doc.line_start(line);
            p.select(chapter, at..at, window, cx);
            let item = p.book().line_item(chapter, line);
            p.list_state().scroll_to(ListOffset {
                item_ix: item,
                offset_in_item: px(0.0),
            });
            cx.notify();
        }),
    }
    let focus = gpui::Focusable::focus_handle(prose.read(cx), cx);
    window.focus(&focus, cx);
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let placed = plan(&entries, 1000.0, 218.0, Some(0));
        let ys: Vec<f32> = placed.iter().map(|p| p.y).collect();
        assert_eq!(ys, [9.0, 109.0, 209.0]);
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
    fn too_many_keep_the_branch_being_read_then_a_window() {
        // Four H1s with three H2s each; room for 7 labels.
        let mut entries = Vec::new();
        for h1 in 0..4 {
            entries.push(entry(1, (h1 * 400) as f64));
            for h2 in 1..4 {
                entries.push(entry(2, (h1 * 400 + h2 * 100) as f64));
            }
        }
        let height = 2.0 * PAD + 7.0 * PITCH;
        let reading = 5; // the second H1's first H2
        let placed = plan(&entries, 1600.0, height, Some(reading));
        let shown: Vec<usize> = placed
            .iter()
            .filter_map(|p| match p.slot {
                Slot::Entry(i) => Some(i),
                Slot::More { .. } => None,
            })
            .collect();
        assert_eq!(
            shown,
            [0, 4, 5, 6, 7, 8, 12],
            "the roots and the branch read"
        );
        // Room for 5: a window round the entry read, 「…」 either side.
        let height = 2.0 * PAD + 5.0 * PITCH;
        let placed = plan(&entries, 1600.0, height, Some(reading));
        assert!(matches!(placed[0].slot, Slot::More { before: true, .. }));
        assert!(matches!(
            placed.last().unwrap().slot,
            Slot::More { before: false, .. }
        ));
        assert!(placed.iter().any(|p| p.slot == Slot::Entry(reading)));
        let counted: usize = placed
            .iter()
            .map(|p| match p.slot {
                Slot::Entry(_) => 1,
                Slot::More { count, .. } => count,
            })
            .sum();
        assert_eq!(counted, entries.len(), "nothing lost");
    }

    #[test]
    fn the_heading_read_is_the_last_above_the_reading_line() {
        let entries = [entry(1, 0.0), entry(2, 300.0), entry(2, 900.0)];
        assert_eq!(active(&entries, 0.0), Some(0));
        assert_eq!(active(&entries, 200.0), Some(1));
        assert_eq!(active(&entries, 796.0), Some(2));
        assert_eq!(parent_of(&entries, 2), Some(0));
    }

    #[test]
    fn a_fold_lists_the_ten_nearest_the_window() {
        // 30 entries, 25 folded before the window, 3 after it.
        assert_eq!(revealed(30, 25, true), 15..25);
        assert_eq!(revealed(30, 3, false), 27..30);
        assert_eq!(revealed(30, 4, true), 0..4);
        assert_eq!(revealed(30, 12, false), 18..28);
    }
}
