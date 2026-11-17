//! The right sidebar's 「关系」 (RL, `kernel-v5.md` §19, `v5-tracks.md` § RL):
//! what the shell keeps between the rail a module draws
//! ([`crate::pages::set_relations`], `dr-view-relations`) and the prose.
//!
//! - [`RailHover`]: the row the pointer is on in the rail. The prose draws
//!   that row's pairs among the names on screen while it is set (「指针停在
//!   一行上：正文里把这一行连出来」); the rail sets it, the page hosts read
//!   it.
//! - [`PendingReveal`]: a row the rail is to scroll to and flash once it has
//!   drawn it. [`crate::actions::RevealRelationRow`] sets it on the workspace
//!   after opening the sidebar on 「关系」 (`Workspace::reveal_relation_row`).

use gpui::{App, Global};

/// One relation row as the rail shows it: entry ids on each side. A
/// directed relation's left side points to its right side; a symmetric one
/// (`directed == false`) has no arrow.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RailRow {
    pub book: String,
    /// The row's id (`RelationRow::id`).
    pub row: String,
    /// The relation's name.
    pub name: String,
    pub directed: bool,
    pub left: Vec<String>,
    pub right: Vec<String>,
}

/// The row the pointer is on in the rail, if any.
#[derive(Clone, Debug, Default)]
pub struct RailHover(pub Option<RailRow>);

impl Global for RailHover {}

/// Sets the row the pointer is on (`None` when it leaves the rows). Only a
/// change is written, so observers hear each move once.
pub fn set_rail_hover(row: Option<RailRow>, cx: &mut App) {
    if cx.try_global::<RailHover>().map(|h| &h.0) == Some(&row) {
        return;
    }
    if row.is_none() && !cx.has_global::<RailHover>() {
        return;
    }
    cx.set_global(RailHover(row));
    cx.refresh_windows();
}

/// The row the pointer is on in the rail.
pub fn rail_hover(cx: &App) -> Option<RailRow> {
    cx.try_global::<RailHover>().and_then(|h| h.0.clone())
}

/// A row to scroll to and flash, in `book`; `serial` tells two asks for the
/// same row apart.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reveal {
    pub book: String,
    pub row: String,
    pub serial: u64,
}

/// The row the rail is to reveal next (taken by the rail once it shows it).
#[derive(Clone, Debug, Default)]
pub struct PendingReveal {
    pub reveal: Option<Reveal>,
    serial: u64,
}

impl Global for PendingReveal {}

/// Asks the rail to scroll to `row` of `book` and flash it.
pub fn request_reveal(book: &str, row: &str, cx: &mut App) {
    let pending = cx.default_global::<PendingReveal>();
    pending.serial += 1;
    pending.reveal = Some(Reveal {
        book: book.to_owned(),
        row: row.to_owned(),
        serial: pending.serial,
    });
    cx.refresh_windows();
}

/// The row waiting to be revealed in `book`, without taking it.
pub fn pending_reveal(book: &str, cx: &App) -> Option<Reveal> {
    cx.try_global::<PendingReveal>()
        .and_then(|p| p.reveal.clone())
        .filter(|r| r.book == book)
}

/// Takes the waiting reveal when it is `serial` (the rail drew that row).
pub fn take_reveal(serial: u64, cx: &mut App) {
    if let Some(p) = cx.try_global::<PendingReveal>()
        && p.reveal.as_ref().is_some_and(|r| r.serial == serial)
    {
        cx.global_mut::<PendingReveal>().reveal = None;
    }
}
