//! Settings: the registry ([`registry`]), the file ([`store`]), the panel
//! ([`panel`]), and the global that ties them to the app.
//!
//! Changing a setting goes through [`Settings::update`]: the file changes,
//! the change takes effect (theme, text size, language, crash reports, the
//! keymap), every window repaints, and the file is written 300 ms later.

pub mod panel;
pub mod registry;
pub mod store;

use std::collections::HashMap;
use std::rc::Rc;
use std::time::Duration;

use dr_i18n::Locale;
use dr_ui::tokens::TextSize;
use gpui::{AnyElement, App, BorrowAppContext as _, Global, SharedString, Task, Window};

pub use store::SettingsFile;

use crate::{ShellInfo, Strings, appearance};

/// How long after a change the file is written.
pub const SAVE_DELAY: Duration = Duration::from_millis(300);

type MakeModuleRow = Rc<dyn Fn(&mut Window, &mut App) -> AnyElement>;

#[derive(Default)]
struct ModuleRows(HashMap<&'static str, MakeModuleRow>);
impl Global for ModuleRows {}

type PanelClosed = Rc<dyn Fn(gpui::WindowId, &mut App)>;

#[derive(Default)]
struct PanelClosedHooks(Vec<PanelClosed>);
impl Global for PanelClosedHooks {}

/// Cancels work owned by a settings surface when it is dismissed. Module
/// controls may remain cached, so dropping their view is not a close signal.
pub fn on_panel_closed(cx: &mut App, hook: impl Fn(gpui::WindowId, &mut App) + 'static) {
    cx.default_global::<PanelClosedHooks>()
        .0
        .push(Rc::new(hook));
}

pub(crate) fn panel_closed(window: gpui::WindowId, cx: &mut App) {
    let hooks = cx
        .try_global::<PanelClosedHooks>()
        .map(|hooks| hooks.0.clone())
        .unwrap_or_default();
    for hook in hooks {
        hook(window, cx);
    }
}

/// Registers the control of a declared module row. The declaration remains
/// the single source for type validation, account scope, ordering and search.
pub fn set_module_row(
    cx: &mut App,
    id: &'static str,
    make: impl Fn(&mut Window, &mut App) -> AnyElement + 'static,
) {
    assert!(
        registry::find(id).is_some_and(|def| matches!(def.kind, registry::Kind::Module(_)))
            || registry::INFO_ROWS
                .iter()
                .any(|row| row.id == id && row.action == registry::RowAction::Module),
        "a module settings row must be declared"
    );
    cx.default_global::<ModuleRows>()
        .0
        .insert(id, Rc::new(make));
}

pub(crate) fn module_row(id: &str, window: &mut Window, cx: &mut App) -> Option<AnyElement> {
    let make = cx.try_global::<ModuleRows>()?.0.get(id)?.clone();
    Some(make(window, cx))
}

pub(crate) fn has_module_section(section: registry::Section, cx: &App) -> bool {
    let Some(rows) = cx.try_global::<ModuleRows>() else {
        return false;
    };
    registry::in_section(section).any(|def| rows.0.contains_key(def.key))
        || registry::info_in(section).any(|row| rows.0.contains_key(row.id))
}

#[derive(Default)]
struct RequestedSection(Option<(gpui::WindowId, registry::Section)>);
impl Global for RequestedSection {}

/// Opens a settings section, including when the panel is already open.
pub fn open_section(section: registry::Section, window: &mut Window, cx: &mut App) {
    cx.default_global::<RequestedSection>().0 = Some((window.window_handle().window_id(), section));
    window.dispatch_action(Box::new(crate::actions::OpenSettings), cx);
    window.refresh();
}

pub(crate) fn take_requested_section(window: &Window, cx: &mut App) -> Option<registry::Section> {
    let requested = &mut cx.default_global::<RequestedSection>().0;
    if requested.is_some_and(|(id, _)| id == window.window_handle().window_id()) {
        requested.take().map(|(_, section)| section)
    } else {
        None
    }
}

/// The update row of 关于 (M42, `dr-view-update`): the words under its
/// label (what the last check found) and its button.
pub struct UpdatesRow {
    pub description: Option<SharedString>,
    pub control: Option<AnyElement>,
}

type MakeUpdatesRow = Rc<dyn Fn(&mut Window, &mut App) -> UpdatesRow>;

struct UpdatesHook(MakeUpdatesRow);

impl Global for UpdatesHook {}

/// Registers the update row of 关于. Without it (tests, captures, a
/// platform with no updates) the row is left out.
pub fn set_updates_row(cx: &mut App, make: impl Fn(&mut Window, &mut App) -> UpdatesRow + 'static) {
    cx.set_global(UpdatesHook(Rc::new(make)));
}

pub(crate) fn updates_row(window: &mut Window, cx: &mut App) -> Option<UpdatesRow> {
    let make = cx.try_global::<UpdatesHook>()?.0.clone();
    Some(make(window, cx))
}

pub(crate) fn has_updates_row(cx: &App) -> bool {
    cx.has_global::<UpdatesHook>()
}

pub struct Settings {
    file: SettingsFile,
    save: Option<Task<()>>,
    applied: Applied,
}

impl Global for Settings {}

/// What has been applied, so only changes are applied again.
#[derive(Clone, Default, PartialEq)]
struct Applied {
    theme: Option<String>,
    text_size: Option<String>,
    locale: Option<Locale>,
    crash_reports: Option<bool>,
}

impl Settings {
    pub fn read(cx: &App) -> &SettingsFile {
        &cx.global::<Settings>().file
    }

    /// What a module keeps on this device under `key`
    /// ([`SettingsFile::device_memory`]); `None` without the settings
    /// (a module's own tests).
    pub fn device_memory(cx: &App, key: &str) -> Option<serde_json::Value> {
        cx.try_global::<Settings>()?
            .file
            .device_memory(key)
            .cloned()
    }

    /// Keeps `value` on this device under `key` (`None` forgets it); the
    /// file is written a moment later. Does nothing without the settings.
    pub fn set_device_memory(cx: &mut App, key: &str, value: Option<serde_json::Value>) {
        if cx.has_global::<Settings>() {
            Settings::update(cx, |file| file.set_device_memory(key, value));
        }
    }

    /// Changes the file, applies the change and schedules the write.
    pub fn update<R>(cx: &mut App, f: impl FnOnce(&mut SettingsFile) -> R) -> R {
        let result = cx.update_global::<Settings, _>(|settings, _| f(&mut settings.file));
        if Settings::read(cx).is_dirty() {
            schedule_save(cx);
        }
        apply(cx);
        result
    }

    /// Writes the file now, if anything changed.
    pub fn flush(cx: &mut App) {
        cx.update_global::<Settings, _>(|settings, _| {
            settings.save = None;
            if let Err(error) = settings.file.save() {
                log::error!("could not write the settings file: {error}");
            }
        });
    }

    /// The interface language: the stored choice, else the system's.
    pub fn locale(cx: &App) -> Locale {
        Settings::read(cx)
            .str(registry::UI_LOCALE)
            .map(|code| Locale::from_code(&code))
            .unwrap_or_else(Locale::from_system)
    }
}

fn schedule_save(cx: &mut App) {
    let task = cx.spawn(async move |cx| {
        cx.background_executor().timer(SAVE_DELAY).await;
        cx.update(Settings::flush);
    });
    cx.global_mut::<Settings>().save = Some(task);
}

pub(crate) fn install(file: SettingsFile, cx: &mut App) {
    cx.set_global(Settings {
        file,
        save: None,
        applied: Applied::default(),
    });
    apply(cx);
}

/// Makes the stored values take effect where they changed.
fn apply(cx: &mut App) {
    let file = Settings::read(cx);
    let now = Applied {
        theme: file.str(registry::THEME),
        text_size: file.str(registry::TEXT_SIZE),
        locale: Some(Settings::locale(cx)),
        crash_reports: Some(file.bool(registry::CRASH_REPORTS)),
    };
    let before = cx.global::<Settings>().applied.clone();
    if now == before {
        return;
    }
    if now.theme != before.theme {
        let forced = cx
            .try_global::<ShellInfo>()
            .and_then(|info| info.forced_appearance)
            .or_else(|| now.theme.as_deref().and_then(appearance::from_setting));
        appearance::apply(forced, cx);
    }
    if now.text_size != before.text_size {
        dr_ui::theme::set_text_size(text_size(now.text_size.as_deref()), cx);
    }
    if now.locale != before.locale
        && let Some(locale) = now.locale
    {
        Strings::install(locale, cx);
    }
    if now.crash_reports != before.crash_reports
        && before.crash_reports.is_some()
        && let Some(reports) = cx
            .try_global::<crate::Services>()
            .and_then(|s| s.crash_reports.as_ref())
    {
        // The launch already passed the stored consent to `crash::init`.
        reports.set_consent(now.crash_reports.unwrap_or(true));
    }
    cx.global_mut::<Settings>().applied = now;
    cx.refresh_windows();
}

pub fn text_size(value: Option<&str>) -> TextSize {
    match value {
        Some("smallest") => TextSize::Smallest,
        Some("small") => TextSize::Small,
        Some("large") => TextSize::Large,
        Some("largest") => TextSize::Largest,
        _ => TextSize::Standard,
    }
}
