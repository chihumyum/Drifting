//! The bookshelf's pictures (M25, `dr-view-shelf-art`), as the shelf feeds
//! them: what each cover is drawn from, the book's genre at the cover's
//! foot, the year of writing days for the heat map and the cards' strips,
//! each book's colour, and the cover style the shelf shows.
//!
//! - The data is read through F3 off the main thread, after the shelf's own
//!   read and again whenever that one runs ([`ShelfArt::load`]).
//! - The style is the shelf's one choice for every cover (the 0.1 client's
//!   `shelf:cover-style`, kept on this device). Until the shell has a
//!   device value for it (m01-shelf.md, 「待协调」) it is kept for the
//!   session only: every shelf in the app follows it at once.

use std::collections::HashMap;
use std::rc::Rc;

use dr_ui::tokens::color::{Palette, Rgb, Story};
use dr_view_shelf_art::{
    CoverRequest, CoverStyle, WritingYear, cover_is_dark, cover_key, cover_request,
};
use dr_workspace::{
    Actor, Workspace as Library,
    commands::{BookIn, book::FactList},
};
use gpui::{App, Global};

/// One book's pictures.
pub struct BookArt {
    pub cover: Rc<CoverRequest>,
    /// The 「体裁」 project fact, written at the cover's foot.
    pub genre: Option<String>,
}

/// Everything the shelf's pictures are drawn from.
pub struct ShelfArt {
    pub books: HashMap<String, BookArt>,
    pub year: Rc<WritingYear>,
}

/// What [`ShelfArt::load`] reads off the main thread (no `Rc` yet).
pub struct Loaded {
    books: Vec<(String, CoverRequest, Option<String>)>,
    year: WritingYear,
}

impl ShelfArt {
    /// Reads every book's cover data and genre and the year of writing days
    /// up to `today` (`YYYY-MM-DD`). Call it off the main thread.
    pub fn load(lib: &Library, books: &[(String, String)], today: &str) -> Loaded {
        let ids: Vec<String> = books.iter().map(|(id, _)| id.clone()).collect();
        Loaded {
            books: books
                .iter()
                .map(|(id, name)| (id.clone(), cover_request(lib, id, name), genre(lib, id)))
                .collect(),
            year: WritingYear::load(lib, &ids, today),
        }
    }

    pub fn from_loaded(loaded: Loaded) -> ShelfArt {
        ShelfArt {
            books: loaded
                .books
                .into_iter()
                .map(|(id, cover, genre)| {
                    (
                        id,
                        BookArt {
                            cover: Rc::new(cover),
                            genre,
                        },
                    )
                })
                .collect(),
            year: Rc::new(loaded.year),
        }
    }

    /// Every cover is drawn in `style` (or could not be).
    pub fn drawn(&self, style: CoverStyle, cx: &App) -> bool {
        self.books
            .iter()
            .all(|(id, b)| cover_is_dark(&cover_key(id, style, &b.cover), cx).is_some())
    }

    /// The words of `book` on each of the last 30 days, today last.
    pub fn recent(&self, book: &str) -> Vec<u64> {
        self.year.recent(book, 30)
    }
}

/// The 「体裁」 project fact, trimmed, when it has a value (the 0.1 shelf's
/// `displayMetaFor`).
fn genre(lib: &Library, book: &str) -> Option<String> {
    let facts = lib
        .run::<FactList>(
            &Actor::User,
            BookIn {
                book: book.to_owned(),
            },
        )
        .ok()?
        .output;
    facts
        .into_iter()
        .find(|f| f.key.trim() == "体裁")
        .map(|f| f.value.trim().to_owned())
        .filter(|v| !v.is_empty())
}

/// A fixed today (captures of seeded data).
struct Today(chrono::NaiveDate);

impl Global for Today {}

/// Has the shelf count its year up to `day` (captures, like Project Home's
/// `set_today`).
pub fn set_today(day: chrono::NaiveDate, cx: &mut App) {
    cx.set_global(Today(day));
}

/// Today in the device's own calendar, as writing days are kept.
pub fn today(cx: &App) -> String {
    cx.try_global::<Today>()
        .map(|t| t.0)
        .unwrap_or_else(|| chrono::Local::now().date_naive())
        .format("%Y-%m-%d")
        .to_string()
}

/// A book's colour: one of the six storyline colours by its id (the 0.1
/// shelf's `hashToColor`); the heat map shows the book alone in it.
pub fn book_story(id: &str) -> Story {
    let mut h: u32 = 0;
    for (i, unit) in id.encode_utf16().enumerate() {
        h = h.wrapping_add(u32::from(unit).wrapping_mul(i as u32 + 7));
    }
    Story::ALL[h as usize % Story::ALL.len()]
}

pub fn book_color(id: &str, p: &Palette) -> Rgb {
    p.story(book_story(id))
}

/// The style every cover on the shelf is drawn in.
#[derive(Default)]
struct ShownStyle(Option<CoverStyle>);

impl Global for ShownStyle {}

/// Where the style is kept on this device (the 0.1 shelf's
/// `shelf:cover-style` in localStorage): the shell's device memory.
pub const STYLE_KEY: &str = "shelf.cover_style";

pub fn cover_style(cx: &App) -> CoverStyle {
    cx.try_global::<ShownStyle>()
        .and_then(|s| s.0)
        .or_else(|| {
            dr_shell::Settings::device_memory(cx, STYLE_KEY)
                .and_then(|v| v.as_str().and_then(CoverStyle::from_slug))
        })
        .unwrap_or(CoverStyle::DEFAULT)
}

/// Turns every cover to `style` and keeps it on this device; the shelves
/// redraw.
pub fn set_cover_style(style: CoverStyle, cx: &mut App) {
    cx.set_global(ShownStyle(Some(style)));
    dr_shell::Settings::set_device_memory(cx, STYLE_KEY, Some(style.slug().into()));
    cx.refresh_windows();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The 0.1 shelf's `hashToColor`, worked by hand: `(h + code × (i + 7))
    /// >>> 0`, then `h % 6`.
    #[test]
    fn a_book_keeps_the_0_1_colour() {
        // "a" = 97: 97 × 7 = 679, 679 % 6 = 1.
        assert_eq!(book_story("a"), Story::ALL[1]);
        // "ab": 679 + 98 × 8 = 1463, 1463 % 6 = 5.
        assert_eq!(book_story("ab"), Story::ALL[5]);
        assert_eq!(book_story(""), Story::ALL[0]);
    }
}
