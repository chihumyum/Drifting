//! Versioned host entry for the existing review card layout.

use std::rc::Rc;

use dr_i18n::{Locale, Platform};
use gpui::{AnyElement, App, IntoElement, Window};

use crate::v3::{Snapshot, Target};

pub type Open = Rc<dyn Fn(Target, &mut Window, &mut App)>;
pub type Marks = Rc<dyn Fn(&Target) -> Option<dr_ui::sand::Kind>>;

pub(crate) struct State {
    pub scope: Option<Target>,
    pub snapshot: Snapshot,
    pub open: Open,
    pub marks: Marks,
}

/// Ensures and configures a Hub-managed v3 [`crate::ReviewView`] so hosts that
/// arrange review cards across multiple columns (M23) share the same partial
/// write path, failed-draft retention and source hover cards.
#[allow(clippy::too_many_arguments)]
pub fn ensure(
    id: &str,
    book: &str,
    target: Option<Target>,
    locale: Locale,
    platform: Platform,
    open: Open,
    marks: Marks,
    cx: &mut App,
) -> Option<gpui::Entity<crate::ReviewView>> {
    let view = crate::ensure_view(id, cx)?;
    view.update(cx, |v, cx| {
        v.show_v3(book, target, locale, platform, open, marks, cx);
    });
    Some(view)
}

/// `None` follows the book; Entry includes its module, Material its own note.
/// The host converts these targets directly, without `book::nav_target`.
/// Writes use the registry's v3 partial comment commands and retain failed drafts.
#[allow(clippy::too_many_arguments)]
pub fn panel(
    id: &str,
    book: &str,
    target: Option<Target>,
    locale: Locale,
    platform: Platform,
    open: Open,
    marks: Marks,
    cx: &mut App,
) -> AnyElement {
    match ensure(id, book, target, locale, platform, open, marks, cx) {
        Some(view) => view.into_any_element(),
        None => gpui::Empty.into_any_element(),
    }
}
