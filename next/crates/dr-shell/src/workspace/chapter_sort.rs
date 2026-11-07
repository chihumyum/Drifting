//! The chapter panel's sorting and its cells' readouts (M04; the 0.1
//! client's `ChapterPanel` sort menu, `useSidebarPreference`).
//!
//! - The whole book: 按阅读顺序 (the default; acts show only in it), 按叙事顺序
//!   (by narrative order, chapters without one last), 按创建时间 and 按更新时间
//!   (newest first). Ties go by id, as in the 0.1 client.
//! - By storyline: the chapters inside each storyline by reading or
//!   narrative order; the storylines themselves in their own order or
//!   alphabetically; a chapter on several storylines under each of them or
//!   only under its primary one.
//! - The cell's right side: the date it was last changed (MM/DD this year,
//!   YY/MM/DD before), its word count (521, 1.2k, 12k), both, or nothing.
//!
//! The choice is the book's, kept in its local layout.

use chrono::{Datelike, Local, TimeZone};
use dr_i18n::{Key, keys};
use dr_ui::{
    Theme,
    components::{
        Menu, MenuItem,
        overlay::{self, Align, Layer, Place},
    },
    sand::Icon,
};
use dr_workspace::dto::ChapterInfo;
use gpui::{
    AnyElement, App, Bounds, Entity, InteractiveElement, IntoElement, ParentElement, Pixels, div,
};
use serde::{Deserialize, Serialize};

use super::Workspace;
use crate::strings::t;

/// How the whole book's chapters are ordered.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BookSort {
    #[default]
    BookOrder,
    NarrativeOrder,
    CreatedAt,
    UpdatedAt,
}

/// How a storyline's chapters are ordered.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InnerSort {
    #[default]
    BookOrder,
    NarrativeOrder,
}

/// How the storylines are ordered.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OuterSort {
    #[default]
    StorylineOrder,
    Alphabet,
}

/// What a chapter cell shows on its right.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CellMeta {
    #[default]
    Date,
    WordCount,
    Both,
    None,
}

/// The chapter panel's sorting, as the book's layout keeps it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ChapterSort {
    pub book: BookSort,
    pub inner: InnerSort,
    pub outer: OuterSort,
    /// A chapter on several storylines only under its primary one.
    pub primary_only: bool,
    pub meta: CellMeta,
}

/// Narrative order, chapters without one last, then by id.
fn by_narrative(a: &ChapterInfo, b: &ChapterInfo) -> std::cmp::Ordering {
    match (a.narrative_order, b.narrative_order) {
        (Some(x), Some(y)) => x.total_cmp(&y).then_with(|| a.id.cmp(&b.id)),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.id.cmp(&b.id),
    }
}

/// Newest first, chapters without the time last, then by id.
fn newest(
    a: &ChapterInfo,
    b: &ChapterInfo,
    at: impl Fn(&ChapterInfo) -> Option<i64>,
) -> std::cmp::Ordering {
    match (at(a), at(b)) {
        (Some(x), Some(y)) => y.cmp(&x).then_with(|| a.id.cmp(&b.id)),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.id.cmp(&b.id),
    }
}

/// `chapters` (in reading order) in the whole book's order.
pub fn sort_book(chapters: &[ChapterInfo], sort: BookSort) -> Vec<&ChapterInfo> {
    let mut out: Vec<&ChapterInfo> = chapters.iter().collect();
    match sort {
        BookSort::BookOrder => {}
        BookSort::NarrativeOrder => out.sort_by(|a, b| by_narrative(a, b)),
        BookSort::CreatedAt => out.sort_by(|a, b| newest(a, b, |c| c.created_at)),
        BookSort::UpdatedAt => out.sort_by(|a, b| newest(a, b, |c| c.updated_at)),
    }
    out
}

/// A storyline's chapters (in reading order) in its order.
pub fn sort_inner<'a>(
    chapters: impl Iterator<Item = &'a ChapterInfo>,
    sort: InnerSort,
) -> Vec<&'a ChapterInfo> {
    let mut out: Vec<&ChapterInfo> = chapters.collect();
    if sort == InnerSort::NarrativeOrder {
        out.sort_by(|a, b| by_narrative(a, b));
    }
    out
}

/// A word count as the cells show it: 521, 1.2k, 12k (the 0.1 client's
/// `formatWordCount`).
pub fn compact_words(n: u64) -> String {
    match n {
        0..=999 => n.to_string(),
        1000..=9999 => format!("{:.1}k", n as f64 / 1000.0),
        _ => format!("{}k", (n as f64 / 1000.0).round() as u64),
    }
}

/// A date as the cells show it: MM/DD this year, YY/MM/DD before; local
/// time.
pub fn short_date(secs: i64, now_year: i32) -> Option<String> {
    let at = Local.timestamp_opt(secs, 0).single()?;
    Some(if at.year() == now_year {
        format!("{:02}/{:02}", at.month(), at.day())
    } else {
        format!("{}/{:02}/{:02}", at.year() % 100, at.month(), at.day())
    })
}

/// A chapter cell's right side, if it shows one.
pub fn readout(chapter: &ChapterInfo, meta: CellMeta) -> Option<String> {
    let year = Local::now().year();
    let date = || chapter.updated_at.and_then(|s| short_date(s, year));
    let words = || compact_words(chapter.words);
    match meta {
        CellMeta::None => None,
        CellMeta::Date => date(),
        CellMeta::WordCount => Some(words()),
        CellMeta::Both => Some(match date() {
            Some(d) => format!("{} · {d}", words()),
            None => words(),
        }),
    }
}

/// A single-choice group's rows: each sets its value with `set`, the one
/// equal to `current` ticked.
fn group<'a, T: Copy + PartialEq + 'static>(
    ws: &'a Entity<Workspace>,
    current: T,
    set: fn(&mut ChapterSort, T),
    cx: &'a App,
) -> impl Fn(&'static str, Icon, Key, T) -> MenuItem + 'a {
    move |id, icon, label, value| {
        let ws = ws.clone();
        MenuItem::new(id, icon, t(cx, label))
            .checked(value == current)
            .on_click(move |_, _, cx| {
                ws.update(cx, |ws, cx| {
                    set(&mut ws.chapter_sort, value);
                    ws.changed(cx);
                })
            })
    }
}

/// The sort menu under the chapter panel's sort button (the 0.1 client's
/// `SortMenu` for the chapter panel).
pub fn menu(
    ws: &Entity<Workspace>,
    sort: ChapterSort,
    by_book: bool,
    anchor: Bounds<Pixels>,
    theme: &Theme,
    cx: &App,
) -> AnyElement {
    use keys::left_sidebar::sort as k;
    let mut menu = Menu::new("chapter-sort-menu");
    if by_book {
        let row = group(ws, sort.book, |s, v| s.book = v, cx);
        menu = menu
            .section(t(cx, k::CHAPTERS), theme)
            .item(row(
                "sort-book",
                Icon::OpenBook,
                k::BOOK_ORDER,
                BookSort::BookOrder,
            ))
            .item(row(
                "sort-narrative",
                Icon::Bamboo,
                k::NARRATIVE_ORDER,
                BookSort::NarrativeOrder,
            ))
            .item(row(
                "sort-created",
                Icon::Sprout,
                k::CREATED_AT,
                BookSort::CreatedAt,
            ))
            .item(row(
                "sort-updated",
                Icon::BrushWriting,
                k::UPDATED_AT,
                BookSort::UpdatedAt,
            ));
    } else {
        let inner = group(ws, sort.inner, |s, v| s.inner = v, cx);
        let outer = group(ws, sort.outer, |s, v| s.outer = v, cx);
        let dup = group(ws, sort.primary_only, |s, v| s.primary_only = v, cx);
        menu = menu
            .section(t(cx, k::STORYLINE_CHAPTERS), theme)
            .item(inner(
                "sort-inner-book",
                Icon::OpenBook,
                k::BOOK_ORDER,
                InnerSort::BookOrder,
            ))
            .item(inner(
                "sort-inner-narrative",
                Icon::Bamboo,
                k::NARRATIVE_ORDER,
                InnerSort::NarrativeOrder,
            ))
            .separator(theme)
            .section(t(cx, k::OUTER_STORYLINES_GROUP), theme)
            .item(outer(
                "sort-outer-order",
                Icon::LanesStagger,
                k::STORYLINE_ORDER,
                OuterSort::StorylineOrder,
            ))
            .item(outer(
                "sort-outer-alpha",
                Icon::AlphaDown,
                k::ALPHABET,
                OuterSort::Alphabet,
            ))
            .separator(theme)
            .section(t(cx, k::DUPLICATES_GROUP), theme)
            .item(dup(
                "sort-dup-all",
                Icon::SealFork,
                k::DUPLICATES_ALL,
                false,
            ))
            .item(dup(
                "sort-dup-primary",
                Icon::SealMain,
                k::DUPLICATES_PRIMARY,
                true,
            ));
    }
    let meta = group(ws, sort.meta, |s, v| s.meta = v, cx);
    menu = menu
        .separator(theme)
        .section(t(cx, k::CELL_META_GROUP), theme)
        .item(meta("meta-date", Icon::Ri, k::SHOW_DATE, CellMeta::Date))
        .item(meta(
            "meta-words",
            Icon::Zi,
            k::SHOW_WORD_COUNT,
            CellMeta::WordCount,
        ))
        .item(meta("meta-both", Icon::ZiRi, k::SHOW_BOTH, CellMeta::Both))
        .item(meta("meta-none", Icon::Wu, k::SHOW_NONE, CellMeta::None));
    let dismiss = ws.clone();
    overlay::float(
        Place::Rect {
            rect: anchor,
            align: Align::End,
            gap: 6.0,
        },
        Layer::Popover,
        div()
            .id("chapter-sort-float")
            .occlude()
            .on_mouse_down_out(move |e, _, cx| {
                // The button toggles it itself.
                if anchor.contains(&e.position) {
                    return;
                }
                dismiss.update(cx, |ws, cx| {
                    ws.chapter_sort_open = None;
                    cx.notify();
                })
            })
            .child(menu),
    )
    .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chapter(id: &str, narrative: Option<f64>, created: Option<i64>, words: u64) -> ChapterInfo {
        ChapterInfo {
            id: id.into(),
            title: String::new(),
            summary: String::new(),
            number: None,
            book_order: None,
            narrative_order: narrative,
            status: "draft".into(),
            act: None,
            storylines: Vec::new(),
            primary_storyline: None,
            trashed: false,
            words,
            created_at: created,
            updated_at: created,
        }
    }

    #[test]
    fn the_orders_are_the_0_1_clients() {
        let list = [
            chapter("a", Some(3.0), Some(10), 0),
            chapter("b", None, Some(30), 0),
            chapter("c", Some(1.0), None, 0),
        ];
        let ids = |v: Vec<&ChapterInfo>| v.iter().map(|c| c.id.clone()).collect::<Vec<_>>();
        assert_eq!(ids(sort_book(&list, BookSort::BookOrder)), ["a", "b", "c"]);
        assert_eq!(
            ids(sort_book(&list, BookSort::NarrativeOrder)),
            ["c", "a", "b"]
        );
        assert_eq!(ids(sort_book(&list, BookSort::CreatedAt)), ["b", "a", "c"]);
    }

    #[test]
    fn word_counts_read_short() {
        assert_eq!(compact_words(521), "521");
        assert_eq!(compact_words(1234), "1.2k");
        assert_eq!(compact_words(2000), "2.0k");
        assert_eq!(compact_words(12_345), "12k");
        let this_year = Local::now().year();
        let jan = Local
            .with_ymd_and_hms(this_year, 1, 5, 12, 0, 0)
            .unwrap()
            .timestamp();
        assert_eq!(short_date(jan, this_year).as_deref(), Some("01/05"));
        assert_eq!(
            short_date(jan, this_year + 1),
            Some(format!("{}/01/05", this_year % 100))
        );
    }
}
