//! dr-view-home: Project Home (module M02).
//!
//! The paper when no tab is active (docs/project-home.md; components.md,
//! 「作品主页」): one page-white plane, the content as wide as the paper.
//!
//! - **The title**: 「作品主页 · 某年某月起」, the book's name (a frameless
//!   field: renamed in place), one line of counts and words against the book's target, a dry
//!   stroke for the book's progress, today's words against the daily goal
//!   and the streak.
//! - **继续写**: the chapter or idea opened last on this device (else the
//!   chapter changed last), with its storyline, when, its words and two
//!   lines of its summary; under it up to three more pages opened recently
//!   (chapters, ideas, elements); the shell records what the window opens
//!   (`recent.touch`). The whole book is a text button in the head.
//! - **全书**: one row per storyline (its chapters done of all, a dry stroke
//!   in its colour, its words), then the categories.
//! - **设定** (the other view): the word targets and the summary (a framed
//!   multi-line field).
//!
//! The create row and the Agent's check-in cards are later (the create row
//! is M02's second milestone, the cards are stage 5); see m02-home.md.
//!
//! The app registers it with [`init`]; the shell (`dr_shell::pages`) shows
//! it.

pub mod data;
mod view;

pub use view::{Home, HomeView, continue_page, opened_more, recent};

use chrono::NaiveDate;
use gpui::{App, AppContext as _, Global};

/// The calendar day Project Home counts today's words for: the device's
/// own day, unless a capture or a test pinned one.
#[derive(Clone, Copy, Debug)]
pub struct Today(pub NaiveDate);

impl Global for Today {}

/// Pins today (captures and tests: the seeded writing days are dated).
pub fn set_today(day: NaiveDate, cx: &mut App) {
    cx.set_global(Today(day));
}

pub fn today(cx: &App) -> NaiveDate {
    cx.try_global::<Today>()
        .map(|t| t.0)
        .unwrap_or_else(|| chrono::Local::now().date_naive())
}

/// Registers Project Home with the shell.
pub fn init(cx: &mut App) {
    dr_shell::pages::set_home(cx, |ws, window, cx| {
        cx.new(|cx| Home::new(ws, window, cx)).into()
    });
}
