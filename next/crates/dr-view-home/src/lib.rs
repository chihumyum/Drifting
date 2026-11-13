//! Canonical v3 Project Home.
pub mod v3;
pub mod v3_settings;

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
    dr_shell::pages::set_v3_home(cx, |ws, _, cx| cx.new(|cx| v3::Home::new(ws, cx)).into());
}
