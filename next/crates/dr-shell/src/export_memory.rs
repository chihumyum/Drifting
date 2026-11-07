//! What the export dialog remembers, across restarts (M41; the 0.1 client
//! kept it in `localStorage` under `drifting.manuscriptExport.v1`): the
//! author's name, and per book the format, the two title switches and a
//! title that differs from the book's name.
//!
//! dr-view-export keeps them in its `Prefs` global and cannot see the
//! settings file (the shell depends on it, not the other way round), so the
//! shell fills the global from the file when it starts and writes the file
//! whenever the global changes: the account value `export.author` and each
//! book's `export` entry (`settings/store.rs`).

use std::collections::HashMap;

use dr_view_export::Format;
use dr_view_export::prefs::{BookPrefs, Prefs};
use gpui::App;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::settings::Settings;

/// A book's export choices as the settings file has them.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    format: Format,
    act_titles: bool,
    chapter_titles: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    title: Option<String>,
}

impl From<&BookPrefs> for Stored {
    fn from(p: &BookPrefs) -> Stored {
        Stored {
            format: p.format,
            act_titles: p.act_titles,
            chapter_titles: p.chapter_titles,
            title: p.title.clone(),
        }
    }
}

impl From<Stored> for BookPrefs {
    fn from(s: Stored) -> BookPrefs {
        BookPrefs {
            format: s.format,
            act_titles: s.act_titles,
            chapter_titles: s.chapter_titles,
            title: s.title.filter(|t| !t.trim().is_empty()),
        }
    }
}

/// The remembered choices as dr-view-export holds them. An entry it cannot
/// read (a newer build's) is left out, and left in the file.
fn read(cx: &App) -> Prefs {
    let file = Settings::read(cx);
    let books: HashMap<String, BookPrefs> = file
        .book_exports()
        .into_iter()
        .filter_map(|(book, value)| {
            let stored: Stored = serde_json::from_value(value).ok()?;
            Some((book, stored.into()))
        })
        .collect();
    Prefs {
        author: file.export_author().unwrap_or("").to_owned(),
        books,
    }
}

/// Writes what changed in `prefs` into the settings file.
fn write(prefs: &Prefs, cx: &mut App) {
    let books: Vec<(String, Value)> = prefs
        .books
        .iter()
        .filter_map(|(book, p)| Some((book.clone(), serde_json::to_value(Stored::from(p)).ok()?)))
        .collect();
    let author = prefs.author.trim().to_owned();
    let changed = {
        let file = Settings::read(cx);
        file.export_author().unwrap_or("") != author
            || books.iter().any(|(book, value)| {
                !file
                    .book_exports()
                    .iter()
                    .any(|(b, v)| b == book && v == value)
            })
    };
    if !changed {
        return;
    }
    Settings::update(cx, |file| {
        file.set_export_author(&author);
        for (book, value) in books {
            file.set_book_export(&book, value);
        }
    });
}

/// Fills dr-view-export's choices from the settings file and keeps the file
/// in step from then on. Once, from [`crate::init`].
pub(crate) fn init(cx: &mut App) {
    Prefs::set(read(cx), cx);
    cx.observe_global::<Prefs>(|cx| {
        let prefs = Prefs::get(cx);
        write(&prefs, cx);
    })
    .detach();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_book_s_choices_round_trip_as_the_file_has_them() {
        let prefs = BookPrefs {
            format: Format::Docx,
            act_titles: false,
            chapter_titles: true,
            title: Some("慢钟（修订）".into()),
        };
        let value = serde_json::to_value(Stored::from(&prefs)).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "format": "docx",
                "actTitles": false,
                "chapterTitles": true,
                "title": "慢钟（修订）",
            })
        );
        let back: BookPrefs = serde_json::from_value::<Stored>(value).unwrap().into();
        assert_eq!(back, prefs);
        // A newer build's format is not read (and not lost).
        assert!(
            serde_json::from_value::<Stored>(serde_json::json!({
                "format": "odt", "actTitles": true, "chapterTitles": true
            }))
            .is_err()
        );
    }
}
