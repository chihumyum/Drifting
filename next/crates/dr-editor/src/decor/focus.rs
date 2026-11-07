//! What the Review panel and the prose say to each other about comments
//! (M18): which cards the pointer is on (their sand in the prose turns hot),
//! which comments the pointer rests on in the prose (their cards light up),
//! and the comment the author jumped to (its sand is drawn again along its
//! rows and the editor shows it).
//!
//! A GPUI global, so neither side holds the other: the panel writes `cards`
//! and `jump`, editors write `prose`; both observe it.

use gpui::{App, Global};

/// A comment the author chose (jump to its text, its tick, just written).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Jump {
    pub comment: String,
    /// A new number each time, so jumping to the same comment twice draws
    /// it twice.
    pub serial: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ReviewFocus {
    /// Comments whose cards the pointer is on.
    pub cards: Vec<String>,
    /// Comments the pointer rests on in the prose.
    pub prose: Vec<String>,
    pub jump: Option<Jump>,
    serial: u64,
}

impl Global for ReviewFocus {}

impl ReviewFocus {
    pub fn get(cx: &App) -> ReviewFocus {
        cx.try_global::<ReviewFocus>().cloned().unwrap_or_default()
    }

    /// The pointer is on these cards (empty: on none).
    pub fn point_cards(ids: Vec<String>, cx: &mut App) {
        if cx.default_global::<ReviewFocus>().cards != ids {
            cx.global_mut::<ReviewFocus>().cards = ids;
        }
    }

    /// The pointer rests on these comments in the prose.
    pub fn point_prose(ids: Vec<String>, cx: &mut App) {
        if cx.default_global::<ReviewFocus>().prose != ids {
            cx.global_mut::<ReviewFocus>().prose = ids;
        }
    }

    /// The author chose `comment`: the editor that holds it shows it and
    /// draws it again.
    pub fn jump(comment: &str, cx: &mut App) -> u64 {
        let focus = cx.default_global::<ReviewFocus>();
        focus.serial += 1;
        let serial = focus.serial;
        focus.jump = Some(Jump {
            comment: comment.to_owned(),
            serial,
        });
        serial
    }

    /// The jump to `comment` is over (the author clicked in the prose or
    /// typed).
    pub fn settle(comment: &str, cx: &mut App) {
        let focus = cx.default_global::<ReviewFocus>();
        if focus.jump.as_ref().is_some_and(|j| j.comment == comment) {
            cx.global_mut::<ReviewFocus>().jump = None;
        }
    }
}
