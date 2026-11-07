//! What the export dialog remembers between exports (the 0.1 client kept it
//! in `localStorage` under `drifting.manuscriptExport.v1`): the author's
//! name, and per book the format, the two title switches and a title that
//! differs from the book's name. The shell keeps them across restarts: it
//! fills this global from its settings file when it starts and writes the
//! file back whenever the global changes (dr-shell's `export_memory`).

use std::collections::HashMap;

use dr_export::Format;
use gpui::{App, Global};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BookPrefs {
    pub format: Format,
    pub act_titles: bool,
    pub chapter_titles: bool,
    /// Only when it is not the book's name.
    pub title: Option<String>,
}

impl Default for BookPrefs {
    fn default() -> Self {
        BookPrefs {
            format: Format::Epub,
            act_titles: true,
            chapter_titles: true,
            title: None,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Prefs {
    pub author: String,
    pub books: HashMap<String, BookPrefs>,
}

impl Global for Prefs {}

impl Prefs {
    pub fn get(cx: &App) -> Prefs {
        cx.try_global::<Prefs>().cloned().unwrap_or_default()
    }

    pub fn set(prefs: Prefs, cx: &mut App) {
        cx.set_global(prefs);
    }
}
