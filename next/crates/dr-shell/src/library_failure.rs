//! The page the window shows when the library could not be opened at
//! start-up (the author, 2026-11-21: 「按推荐做」, the prototype's fourth
//! page 「资料库打不开时」 with every recommended option).
//!
//! The storage layer refuses and leaves the file as it was; the app logs
//! and reports `library-open-failed:<code>` and hands the shell no library
//! but a [`LibraryFailure`] (`Services::library_failure`): which of seven
//! [`Cause`]s it is and the stable code. The window then shows one quiet
//! page instead of the bookshelf (no 「0 个项目」, no first run, no import
//! offer, nothing else of the workspace):
//!
//! - three lines ([`lines`]): 「没能打开资料库」; 「资料库没有改动。」 (for
//!   [`Cause::UpgradedUnopenable`] 「升级前的资料库另外存了一份。」, for
//!   [`Cause::Unknown`] nothing); and what to do, by cause;
//! - a row of buttons ([`buttons`]): 「检查更新」 (only for
//!   [`Cause::Newer`], first; it follows the update service's states as the
//!   Settings row does, [`set_update_button`]), 「在访达中打开」 (the
//!   library's folder, or the data folder when that is missing), 「提交反馈」
//!   (the feedback dialog with 「没能打开资料库（<code>）」 written in it) and
//!   「退出 Drifting」 (the tray menu's words; the ordinary quit).
//!
//! The code is never on the page: only in the feedback's first line, the log
//! and the report. There is no 「重试」 (quitting and opening again is that)
//! and no restore from a snapshot or a backup yet.

use std::path::PathBuf;
use std::rc::Rc;

use dr_i18n::keys::library_open_failed as k;
use dr_ui::{Theme, components::Button, fonts::Role, style::DrStyled};
use gpui::{
    AnyElement, App, Global, InteractiveElement as _, IntoElement as _, ParentElement as _,
    SharedString, Styled as _, Window, div, prelude::FluentBuilder as _, px,
};

use crate::Services;
use crate::strings::{Strings, t, tf};

/// Why the library could not be opened, as the page tells the author.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Cause {
    /// A newer build wrote it (`schema-newer`).
    Newer,
    /// The file is damaged (SQLite: corrupt, not a database).
    Damaged,
    /// An upgrade was attempted and did not finish; the library is exactly
    /// as it was (a migration failure before the replacement).
    UpgradeUnfinished,
    /// The upgraded library replaced the old one and does not open; the one
    /// from before the upgrade is kept as a safety snapshot.
    UpgradedUnopenable,
    /// The folder or the file cannot be read or written.
    NoPermission,
    /// The disk is full.
    DiskFull,
    /// Anything else (another copy holding the library, a schema this build
    /// does not recognise, a panic while opening, no data folder …).
    Unknown,
}

impl Cause {
    pub const ALL: [Cause; 7] = [
        Cause::Newer,
        Cause::Damaged,
        Cause::UpgradeUnfinished,
        Cause::UpgradedUnopenable,
        Cause::NoPermission,
        Cause::DiskFull,
        Cause::Unknown,
    ];

    /// A name for logs and the debug bridge.
    pub fn slug(self) -> &'static str {
        match self {
            Cause::Newer => "newer",
            Cause::Damaged => "damaged",
            Cause::UpgradeUnfinished => "upgrade-unfinished",
            Cause::UpgradedUnopenable => "upgraded-unopenable",
            Cause::NoPermission => "no-permission",
            Cause::DiskFull => "disk-full",
            Cause::Unknown => "unknown",
        }
    }
}

/// The library could not be opened at start-up: what the page needs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LibraryFailure {
    pub cause: Cause,
    /// The stable code (`schema-newer`, `sqlite:not-a-database`, …), as in
    /// the log and the report: only ever in the feedback's first line.
    pub code: String,
    /// What 「在访达中打开」 opens: the library's folder, or the app's data
    /// folder when that one does not exist. `None` (no data folder at all):
    /// the button is left out.
    pub folder: Option<PathBuf>,
}

/// The page's three lines in the interface language.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Lines {
    /// 「没能打开资料库」, always.
    pub heading: SharedString,
    /// 「资料库没有改动。」, or for the upgraded library that does not open
    /// 「升级前的资料库另外存了一份。」; none for an unknown cause.
    pub second: Option<SharedString>,
    /// What to do, by cause.
    pub what_to_do: SharedString,
}

pub fn lines(cause: Cause, cx: &App) -> Lines {
    let second = match cause {
        Cause::Unknown => None,
        Cause::UpgradedUnopenable => Some(t(cx, k::KEPT_BEFORE_UPGRADE)),
        _ => Some(t(cx, k::UNCHANGED)),
    };
    let what_to_do = match cause {
        Cause::Newer => k::cause::NEWER,
        Cause::Damaged => k::cause::DAMAGED,
        Cause::UpgradeUnfinished => k::cause::UPGRADE_UNFINISHED,
        Cause::UpgradedUnopenable => k::cause::UPGRADED_UNOPENABLE,
        Cause::NoPermission => k::cause::NO_PERMISSION,
        Cause::DiskFull => k::cause::DISK_FULL,
        Cause::Unknown => k::cause::UNKNOWN,
    };
    Lines {
        heading: t(cx, k::TITLE),
        second,
        what_to_do: t(cx, what_to_do),
    }
}

/// The feedback dialog's message as it opens from the page: the first line
/// and the code, 「没能打开资料库（schema-newer）」.
pub fn feedback_message(failure: &LibraryFailure, cx: &App) -> String {
    tf(
        cx,
        k::FEEDBACK_MESSAGE,
        &[("title", &t(cx, k::TITLE)), ("code", &failure.code)],
    )
    .to_string()
}

/// One button of the page.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PageButton {
    /// 「检查更新」 and the update service's states after it.
    Update,
    /// 「在访达中打开」 (Windows: 「在文件资源管理器中打开」).
    Reveal,
    /// 「提交反馈」.
    Feedback,
    /// 「退出 Drifting」.
    Quit,
}

impl PageButton {
    /// The button's element id (and debug selector).
    pub fn id(self) -> &'static str {
        match self {
            PageButton::Update => "library-failure-update",
            PageButton::Reveal => "library-failure-reveal",
            PageButton::Feedback => "library-failure-feedback",
            PageButton::Quit => "library-failure-quit",
        }
    }
}

/// The page's buttons, in their order: 「检查更新」 first for a library a
/// newer version wrote (when this build can update), 「在访达中打开」 when
/// there is a folder to open, 「提交反馈」, 「退出 Drifting」.
pub fn buttons(failure: &LibraryFailure, cx: &App) -> Vec<PageButton> {
    let mut out = Vec::with_capacity(4);
    if failure.cause == Cause::Newer && update_button(cx).is_some() {
        out.push(PageButton::Update);
    }
    if failure.folder.is_some() {
        out.push(PageButton::Reveal);
    }
    out.push(PageButton::Feedback);
    out.push(PageButton::Quit);
    out
}

/// A button's words, as drawn and as its name for assistive technology.
pub fn button_label(button: PageButton, cx: &App) -> SharedString {
    match button {
        PageButton::Update => update_button(cx)
            .map(|b| b.label)
            .unwrap_or_else(|| t(cx, dr_i18n::keys::settings::update::CHECK_ACTION)),
        PageButton::Reveal => t(cx, dr_i18n::keys::settings::sync::projection::REVEAL),
        PageButton::Feedback => t(cx, dr_i18n::keys::feedback::TITLE),
        PageButton::Quit => quit_label(cx),
    }
}

/// The tray menu's 「退出 Drifting」 in the interface language
/// (`dr_platform::tray::TrayLabels`).
fn quit_label(cx: &App) -> SharedString {
    dr_platform::tray::TrayLabels::for_locale(Strings::get(cx).locale().code())
        .quit
        .into()
}

/// What a click on the page's update button does.
pub type RunUpdate = Rc<dyn Fn(&mut App)>;

/// Opens the feedback dialog from the page.
pub type OpenFeedback = Rc<dyn Fn(&mut Window, &mut App)>;

/// What the page's update button says and does now: what the update row in
/// Settings › 关于 would (M42 registers it, [`set_update_button`]).
#[derive(Clone)]
pub struct UpdateButton {
    pub label: SharedString,
    /// A check or a download is under way: the button turns and does
    /// nothing.
    pub busy: bool,
    /// What a click does; `None` while busy.
    pub run: Option<RunUpdate>,
}

type MakeUpdateButton = Rc<dyn Fn(&App) -> Option<UpdateButton>>;

struct UpdateHook(MakeUpdateButton);

impl Global for UpdateHook {}

/// Registers the page's update button. `make` answers `None` when this
/// build cannot update (no update row control and no state to follow);
/// without a registered maker the page has no update button either.
pub fn set_update_button(cx: &mut App, make: impl Fn(&App) -> Option<UpdateButton> + 'static) {
    cx.set_global(UpdateHook(Rc::new(make)));
}

pub(crate) fn update_button(cx: &App) -> Option<UpdateButton> {
    let make = cx.try_global::<UpdateHook>()?.0.clone();
    make(cx)
}

/// The failure the app started with, while no library has been taken up
/// since.
pub fn current(cx: &App) -> Option<LibraryFailure> {
    let services = cx.try_global::<Services>()?;
    if services.library.is_some() {
        return None;
    }
    services.library_failure.clone()
}

/// The prototype's measures: the column is 520 wide and sits a little
/// above the middle; 14 under the heading, 6 between the lines, 28 above
/// the buttons, 8 between them.
const WIDTH: f32 = 520.0;
const RAISE: f32 = 70.0;
const HEADING_GAP: f32 = 14.0;
const LINE_GAP: f32 = 6.0;
const BUTTONS_GAP: f32 = 28.0;
const BUTTON_GAP: f32 = 8.0;
/// The heading: the structure face, a little larger than 「全部项目」.
const HEADING_SIZE: f32 = 24.0;
const HEADING_LINE: f32 = 32.0;

/// The page's column: the lines and the buttons, centred in the window.
/// `on_feedback` opens the feedback dialog with [`feedback_message`].
pub(crate) fn page(
    failure: &LibraryFailure,
    on_feedback: OpenFeedback,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let s = theme.scale;
    let lines = lines(failure.cause, cx);
    let line = |id: &'static str, text: SharedString| {
        div()
            .id(id)
            .debug_selector(move || id.to_owned())
            .child(dr_ui::text::wrapped(text))
    };
    let row = buttons(failure, cx).into_iter().map(|which| {
        let label = button_label(which, cx);
        let button = Button::new(which.id(), label);
        match which {
            PageButton::Update => match update_button(cx) {
                Some(update) => button
                    .busy(update.busy)
                    .disabled(update.run.is_none())
                    .when_some(update.run, |b, run| b.on_click(move |_, _, cx| run(cx))),
                None => button.disabled(true),
            },
            PageButton::Reveal => {
                let folder = failure.folder.clone();
                button.on_click(move |_, _, cx| {
                    if let Some(folder) = &folder {
                        cx.open_with_system(folder);
                    }
                })
            }
            PageButton::Feedback => {
                let open = on_feedback.clone();
                button.on_click(move |_, window, cx| open(window, cx))
            }
            PageButton::Quit => button.text().on_click(|_, _, cx| crate::quit::request(cx)),
        }
        .into_any_element()
    });
    div()
        .absolute()
        .inset_0()
        .flex()
        .items_center()
        .justify_center()
        .px(px(32.0))
        .child(
            div()
                .id("library-failure")
                .w(px(WIDTH))
                .max_w_full()
                .mt(px(-RAISE))
                .flex()
                .flex_col()
                .child(
                    line("library-failure-heading", lines.heading)
                        .font_role(Role::Structure)
                        .type_px(HEADING_SIZE, HEADING_LINE)
                        .text_color(p.ink(1).solid()),
                )
                .child(
                    div()
                        .mt(px(HEADING_GAP))
                        .flex()
                        .flex_col()
                        .gap(px(LINE_GAP))
                        .font_role(Role::Ui)
                        .type_px(s.secondary, s.line_body + 2.0)
                        .text_color(p.ink(2).solid())
                        .when_some(lines.second, |el, second| {
                            el.child(line("library-failure-second", second))
                        })
                        .child(line("library-failure-what-to-do", lines.what_to_do)),
                )
                .child(
                    div()
                        .mt(px(BUTTONS_GAP))
                        .flex()
                        .flex_row()
                        .flex_wrap()
                        .gap(px(BUTTON_GAP))
                        .children(row),
                ),
        )
        .into_any_element()
}
