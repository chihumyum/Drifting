//! Canonical Project Home (`kernel-v5.md` §2 & §3).
mod project_template;
mod structure_thumbnail;
pub mod v3;

pub use project_template::Field;

use std::rc::Rc;

use chrono::NaiveDate;
use gpui::{App, AppContext as _, Global, WeakEntity, Window};

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

/// What the registered 「另存为项目模板」 opener (PT3) is given. Both
/// handles are weak, so a dialog keeping this does not hold the library
/// through a swap: upgrade them for one call (or one background job) and
/// let go; read the book from the workspace when it is needed.
#[derive(Clone)]
pub struct SaveProjectTemplateHost {
    pub workspace: WeakEntity<dr_shell::Workspace>,
    pub library: dr_workspace::WeakWorkspace,
    pub book_id: String,
}

type OpenSaveProjectTemplate = Rc<dyn Fn(SaveProjectTemplateHost, &mut Window, &mut App)>;

#[derive(Clone, Default)]
struct SaveProjectTemplateSlot(Option<OpenSaveProjectTemplate>);

impl Global for SaveProjectTemplateSlot {}

/// Registers the opener for Project Home's 「另存为项目模板」 action (PT3).
pub fn set_save_project_template(
    cx: &mut App,
    open: impl Fn(SaveProjectTemplateHost, &mut Window, &mut App) + 'static,
) {
    cx.default_global::<SaveProjectTemplateSlot>().0 = Some(Rc::new(open));
}

/// Clears any registered 「另存为项目模板」 opener (tests).
pub fn clear_save_project_template(cx: &mut App) {
    if cx.has_global::<SaveProjectTemplateSlot>() {
        cx.global_mut::<SaveProjectTemplateSlot>().0 = None;
    }
}

/// Whether a handler for 「另存为项目模板」 is registered; the button in the
/// 「项目模板」 block header is drawn only when this returns `true`.
pub fn has_save_project_template(cx: &App) -> bool {
    cx.try_global::<SaveProjectTemplateSlot>()
        .is_some_and(|s| s.0.is_some())
}

pub(crate) fn open_save_project_template(
    host: SaveProjectTemplateHost,
    window: &mut Window,
    cx: &mut App,
) {
    if let Some(open) = cx
        .try_global::<SaveProjectTemplateSlot>()
        .and_then(|s| s.0.clone())
    {
        open(host, window, cx);
    }
}

#[derive(Default)]
pub(crate) struct PendingTitleFocus(Option<String>);

impl Global for PendingTitleFocus {}

/// Requests that Project Home focus and select the inline title input once
/// `book_id` opens on Project Home (for PT3's newly created 「未命名」 project):
/// taken on the first frame Home shows that book, also when it shows it
/// already.
pub fn focus_project_title(book_id: impl Into<String>, cx: &mut App) {
    cx.default_global::<PendingTitleFocus>().0 = Some(book_id.into());
}

pub(crate) fn take_pending_title_focus(book_id: &str, cx: &mut App) -> bool {
    let Some(slot) = cx.try_global::<PendingTitleFocus>() else {
        return false;
    };
    if slot.0.as_deref() == Some(book_id) {
        cx.global_mut::<PendingTitleFocus>().0 = None;
        true
    } else {
        false
    }
}

/// Registers Project Home with the shell.
pub fn init(cx: &mut App) {
    dr_shell::pages::set_v3_home(cx, |ws, window, cx| {
        cx.new(|cx| v3::Home::new(ws, window, cx)).into()
    });
}
