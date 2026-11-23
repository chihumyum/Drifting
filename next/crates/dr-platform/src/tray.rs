//! Windows notification area (system tray) support (M43).
//!
//! Like the Dock on macOS, Windows keeps Drifting running in the notification
//! area when its window closes, so background Agent tasks, Hosted sync and the
//! local MCP bridge keep running. Closing the window saves and hides it there,
//! whatever it was showing, as the red light closes it on macOS (the author,
//! 2026-11-20); it comes back as it was left. With no notification area to
//! come back from, closing quits.
//!
//! A left click on the tray icon, the tray menu's "Open Drifting" item, or a
//! second instance forwarding its launch arguments (`single_instance`) brings
//! the window back. Choosing "Quit Drifting" from the tray menu flushes local
//! writes and exits the process. Menu labels follow the interface language and
//! are validated with the same rules as the 0.1 client's `windows_tray.rs`.

use std::sync::{Arc, Mutex};

use crate::identity::Identity;

/// Longest menu label the shell may set (matches 0.1's `windows_tray.rs`).
pub const MAX_LABEL_CHARS: usize = 80;

/// Checks that a tray menu label is a non-empty single line of at most
/// [`MAX_LABEL_CHARS`] characters with no control characters.
pub fn valid_label(label: &str) -> bool {
    let count = label.chars().count();
    count > 0 && count <= MAX_LABEL_CHARS && !label.chars().any(char::is_control)
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TrayError {
    #[error("tray labels are invalid")]
    InvalidLabel,
    #[error("tray could not be installed: {0}")]
    Platform(String),
}

/// Localized labels for the notification area context menu.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrayLabels {
    pub open: String,
    pub quit: String,
}

impl Default for TrayLabels {
    fn default() -> Self {
        Self {
            open: "Open Drifting".to_owned(),
            quit: "Quit Drifting".to_owned(),
        }
    }
}

impl TrayLabels {
    pub fn new(open: impl Into<String>, quit: impl Into<String>) -> Result<Self, TrayError> {
        let open = open.into();
        let quit = quit.into();
        if !valid_label(&open) || !valid_label(&quit) {
            return Err(TrayError::InvalidLabel);
        }
        Ok(Self { open, quit })
    }

    /// Default localized menu labels for one of Drifting's interface locales.
    pub fn for_locale(locale: &str) -> Self {
        let normalized = locale.trim().to_ascii_lowercase();
        let (open, quit) = match normalized.as_str() {
            "zh-cn" | "zh-hans" | "zh" => ("打开 Drifting", "退出 Drifting"),
            "zh-tw" | "zh-hant" | "zh-hk" => ("打開 Drifting", "結束 Drifting"),
            "ja" | "ja-jp" => ("Drifting を開く", "Drifting を終了"),
            "ko" | "ko-kr" => ("Drifting 열기", "Drifting 종료"),
            "fr" | "fr-fr" => ("Ouvrir Drifting", "Quitter Drifting"),
            "de" | "de-de" => ("Drifting öffnen", "Drifting beenden"),
            "es" | "es-es" => ("Abrir Drifting", "Salir de Drifting"),
            "pt-br" | "pt" => ("Abrir o Drifting", "Sair do Drifting"),
            "ru" | "ru-ru" => ("Открыть Drifting", "Выйти из Drifting"),
            _ => ("Open Drifting", "Quit Drifting"),
        };
        Self {
            open: open.to_owned(),
            quit: quit.to_owned(),
        }
    }
}

/// What the shell should do in response to a window close request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowCloseDecision {
    /// Flush pending writes and hide the window to the Windows notification
    /// area while keeping background Agent tasks, sync and MCP running.
    HideToTray,
    /// Flush pending writes and terminate the process.
    QuitProcess,
}

/// Commands emitted by the notification area icon, its context menu, or a
/// second instance wake.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayCommand {
    /// Unminimize, show and focus the main window.
    RestoreWindow,
    /// Run the flushed shutdown barrier and exit the application.
    QuitApp,
}

/// Pure state machine for the Windows notification area lifecycle.
#[derive(Debug, Clone)]
pub struct TrayState {
    manages_window_close: bool,
    keep_in_notification_area: bool,
    window_visible: bool,
    quitting: bool,
    tooltip: String,
    labels: TrayLabels,
}

impl TrayState {
    /// Creates a state machine configured for the current platform (`true` on
    /// Windows, `false` elsewhere).
    pub fn new(identity: &Identity, labels: TrayLabels) -> Self {
        Self::with_platform_policy(identity, labels, cfg!(windows), cfg!(windows))
    }

    /// Creates a state machine with an explicit notification-area policy (used
    /// in cross-platform unit tests).
    pub fn with_platform(
        identity: &Identity,
        labels: TrayLabels,
        keep_in_notification_area: bool,
    ) -> Self {
        Self::with_platform_policy(identity, labels, true, keep_in_notification_area)
    }

    /// Creates a state machine with explicit close-interception and
    /// notification-area policies.
    pub fn with_platform_policy(
        identity: &Identity,
        labels: TrayLabels,
        manages_window_close: bool,
        keep_in_notification_area: bool,
    ) -> Self {
        Self {
            manages_window_close,
            keep_in_notification_area,
            window_visible: true,
            quitting: false,
            tooltip: identity.product_name.to_owned(),
            labels,
        }
    }

    pub fn manages_window_close(&self) -> bool {
        self.manages_window_close
    }

    pub fn keep_in_notification_area(&self) -> bool {
        self.keep_in_notification_area
    }

    /// Updates whether the session currently has a live notification area icon.
    /// When `false` (for example on headless Windows CI, Windows Server Core,
    /// or while Explorer is not running), closing quits cleanly
    /// instead of hiding the window into an unreachable invisible state.
    pub fn set_notification_area_available(&mut self, available: bool) {
        self.keep_in_notification_area = available;
    }

    pub fn window_visible(&self) -> bool {
        self.window_visible
    }

    pub fn is_quitting(&self) -> bool {
        self.quitting
    }

    /// Clears `quitting` when a flushed shutdown barrier is aborted by an error.
    pub fn cancel_quit(&mut self) {
        self.quitting = false;
    }

    pub fn tooltip(&self) -> &str {
        &self.tooltip
    }

    pub fn labels(&self) -> &TrayLabels {
        &self.labels
    }

    pub fn set_labels(&mut self, open: String, quit: String) -> Result<(), TrayError> {
        self.labels = TrayLabels::new(open, quit)?;
        Ok(())
    }

    /// Decides how to handle a window close button or Alt+F4 request.
    pub fn on_window_close_request(&mut self) -> WindowCloseDecision {
        if self.quitting {
            return WindowCloseDecision::QuitProcess;
        }
        if self.keep_in_notification_area {
            self.window_visible = false;
            WindowCloseDecision::HideToTray
        } else {
            self.quitting = true;
            WindowCloseDecision::QuitProcess
        }
    }

    /// Left-clicking the tray icon restores and focuses the window.
    pub fn on_left_click(&mut self) -> TrayCommand {
        self.window_visible = true;
        TrayCommand::RestoreWindow
    }

    /// Choosing "Open Drifting" from the tray menu restores the window.
    pub fn on_menu_open(&mut self) -> TrayCommand {
        self.window_visible = true;
        TrayCommand::RestoreWindow
    }

    /// A second instance forwarding its arguments (`single_instance`) restores
    /// the hidden window by the same path as the tray's "Open" item.
    pub fn on_second_instance_launch(&mut self) -> TrayCommand {
        self.window_visible = true;
        TrayCommand::RestoreWindow
    }

    /// Choosing "Quit Drifting" from the tray menu marks the app as quitting
    /// and requests a flushed exit.
    pub fn on_menu_quit(&mut self) -> TrayCommand {
        self.quitting = true;
        TrayCommand::QuitApp
    }
}

type Waker = Box<dyn Fn() + Send + Sync>;

/// Process-wide handle to the notification area icon and its command queue.
pub struct TrayController {
    state: Mutex<TrayState>,
    commands: Mutex<Vec<TrayCommand>>,
    waker: Mutex<Option<Waker>>,
    #[cfg(windows)]
    native: Mutex<Option<windows_impl::NativeTray>>,
}

impl std::fmt::Debug for TrayController {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        f.debug_struct("TrayController")
            .field("manages_window_close", &state.manages_window_close)
            .field(
                "keep_in_notification_area",
                &state.keep_in_notification_area,
            )
            .field("window_visible", &state.window_visible)
            .field("quitting", &state.quitting)
            .field("labels", &state.labels)
            .finish_non_exhaustive()
    }
}

impl TrayController {
    /// The state, the command queue and the waker, without a native icon:
    /// what [`Self::install`] builds before it adds the icon on Windows.
    fn without_icon(identity: &Identity, labels: TrayLabels) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(TrayState::new(identity, labels)),
            commands: Mutex::new(Vec::new()),
            waker: Mutex::new(None),
            #[cfg(windows)]
            native: Mutex::new(None),
        })
    }

    /// Creates an in-memory controller with an explicit notification-area
    /// policy (for cross-platform shell tests).
    pub fn with_platform(
        identity: &Identity,
        labels: TrayLabels,
        keep_in_notification_area: bool,
    ) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(TrayState::with_platform(
                identity,
                labels,
                keep_in_notification_area,
            )),
            commands: Mutex::new(Vec::new()),
            waker: Mutex::new(None),
            #[cfg(windows)]
            native: Mutex::new(None),
        })
    }

    /// Installs the notification area controller and message window on the
    /// current (main) thread on Windows; on other platforms returns an inert
    /// controller with the same command channel and label validation.
    ///
    /// On Windows sessions without an Explorer notification area (such as
    /// headless CI or Windows Server Core, or before Explorer finishes
    /// starting), the hidden message window still installs cleanly while
    /// [`Self::has_notification_icon`] stays `false` until `TaskbarCreated`
    /// registers the icon, so closing quits cleanly instead of
    /// hiding the window with no way back.
    pub fn install(identity: &Identity, labels: TrayLabels) -> Result<Arc<Self>, TrayError> {
        let controller = Self::without_icon(identity, labels);
        #[cfg(windows)]
        {
            let native = windows_impl::NativeTray::create(identity.product_name, &controller)?;
            *controller.native.lock().unwrap_or_else(|e| e.into_inner()) = Some(native);
        }
        Ok(controller)
    }

    /// Whether this controller intercepts main-window close requests (`true` on
    /// Windows, or in cross-platform tests built with [`Self::with_platform`]).
    pub fn manages_window_close(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .manages_window_close()
    }

    /// Whether a live notification area icon is currently registered so the
    /// window can safely hide to the tray.
    pub fn has_notification_icon(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .keep_in_notification_area()
    }

    /// Updates whether a notification area icon is currently available.
    pub fn set_notification_area_available(&self, available: bool) {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .set_notification_area_available(available);
    }

    /// Clears `quitting` when a shutdown barrier fails and leaves the app open.
    pub fn cancel_quit(&self) {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .cancel_quit();
    }

    pub fn tooltip(&self) -> String {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .tooltip()
            .to_owned()
    }

    /// Hides a native Win32 top-level `HWND` when hiding to the notification
    /// area (posted to the window, so it is hidden a moment later); no-op off
    /// Windows or when `hwnd` is zero/invalid.
    pub fn hide_hwnd(hwnd: isize) {
        #[cfg(windows)]
        windows_impl::hide_hwnd(hwnd);
        #[cfg(not(windows))]
        let _ = hwnd;
    }

    /// Shows a hidden Win32 top-level `HWND` again, or restores a minimized
    /// one; the caller brings it to the foreground with GPUI's
    /// `Window::activate_window`. No-op off Windows or when `hwnd` is
    /// zero/invalid.
    pub fn restore_hwnd(hwnd: isize) {
        #[cfg(windows)]
        windows_impl::restore_hwnd(hwnd);
        #[cfg(not(windows))]
        let _ = hwnd;
    }

    /// Updates the tray menu labels in the current interface language.
    pub fn set_labels(&self, open: String, quit: String) -> Result<(), TrayError> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.set_labels(open, quit)
    }

    pub fn labels(&self) -> TrayLabels {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .labels()
            .clone()
    }

    pub fn window_visible(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .window_visible()
    }

    pub fn is_quitting(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_quitting()
    }

    /// Evaluates a window close request and updates the tray visibility state.
    pub fn handle_window_close(&self) -> WindowCloseDecision {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.on_window_close_request()
    }

    /// Called when `single_instance` receives arguments from a second launch:
    /// wakes the main window just like clicking "Open Drifting" in the tray.
    pub fn notify_second_instance(&self) {
        let cmd = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state.on_second_instance_launch()
        };
        self.push_command(cmd);
    }

    /// Simulates or delivers a left click on the tray icon.
    pub fn notify_left_click(&self) {
        let cmd = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state.on_left_click()
        };
        self.push_command(cmd);
    }

    /// Simulates or delivers a click on the tray menu's "Open Drifting" item.
    pub fn notify_menu_open(&self) {
        let cmd = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state.on_menu_open()
        };
        self.push_command(cmd);
    }

    /// Simulates or delivers a click on the tray menu's "Quit Drifting" item.
    pub fn notify_menu_quit(&self) {
        let cmd = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state.on_menu_quit()
        };
        self.push_command(cmd);
    }

    /// Registers a waker that brings the host's main thread back to drain
    /// [`Self::drain_commands`].
    pub fn set_waker(&self, waker: impl Fn() + Send + Sync + 'static) {
        *self.waker.lock().unwrap_or_else(|e| e.into_inner()) = Some(Box::new(waker));
    }

    /// Takes all pending tray commands in arrival order.
    pub fn drain_commands(&self) -> Vec<TrayCommand> {
        let mut commands = self.commands.lock().unwrap_or_else(|e| e.into_inner());
        std::mem::take(&mut *commands)
    }

    fn push_command(&self, command: TrayCommand) {
        self.commands
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(command);
        if let Some(waker) = self
            .waker
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            waker();
        }
    }
}

#[cfg(windows)]
mod windows_impl {
    use std::sync::{
        Arc, OnceLock, Weak,
        atomic::{AtomicBool, Ordering},
    };

    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::Shell::{
        NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE, NOTIFYICONDATAW, Shell_NotifyIconW,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        AppendMenuW, CreatePopupMenu, CreateWindowExW, DefWindowProcW, DestroyMenu, DestroyWindow,
        GWLP_USERDATA, GetCursorPos, GetWindowLongPtrW, IDI_APPLICATION, IsIconic, IsWindow,
        LoadIconW, MF_STRING, PostMessageW, RegisterClassW, RegisterWindowMessageW, SW_HIDE,
        SW_RESTORE, SW_SHOW, SetForegroundWindow, SetWindowLongPtrW, ShowWindowAsync,
        TPM_BOTTOMALIGN, TPM_LEFTALIGN, TPM_RIGHTBUTTON, TrackPopupMenu, WINDOW_EX_STYLE,
        WINDOW_STYLE, WM_COMMAND, WM_CONTEXTMENU, WM_LBUTTONUP, WM_NULL, WM_RBUTTONUP, WM_USER,
        WNDCLASSW,
    };
    use windows::core::{PCWSTR, w};

    use super::{TrayController, TrayError};

    const WM_TRAYICON: u32 = WM_USER + 0x44;
    const TRAY_ICON_ID: u32 = 1;
    const ID_TRAY_OPEN: usize = 1001;
    const ID_TRAY_QUIT: usize = 1002;

    struct WindowContext {
        controller: Weak<TrayController>,
        icon_registered: Arc<AtomicBool>,
    }

    pub(super) struct NativeTray {
        hwnd: isize,
        icon_registered: Arc<AtomicBool>,
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }

    fn taskbar_created_msg() -> u32 {
        static MSG: OnceLock<u32> = OnceLock::new();
        *MSG.get_or_init(|| {
            // SAFETY: registers or retrieves the system-wide message broadcast
            // by Explorer whenever the taskbar notification area is created.
            unsafe { RegisterWindowMessageW(w!("TaskbarCreated")) }
        })
    }

    fn register_class() -> &'static [u16] {
        static CLASS_NAME: OnceLock<Vec<u16>> = OnceLock::new();
        CLASS_NAME.get_or_init(|| {
            let name = wide("DriftingNotificationAreaWindow");
            // SAFETY: `name` is NUL-terminated and static; `wnd_proc` is a
            // valid Win32 window procedure.
            unsafe {
                let hinstance = GetModuleHandleW(None).unwrap_or_default();
                let wc = WNDCLASSW {
                    lpfnWndProc: Some(wnd_proc),
                    hInstance: hinstance.into(),
                    lpszClassName: PCWSTR::from_raw(name.as_ptr()),
                    ..Default::default()
                };
                let _ = RegisterClassW(&wc);
            }
            name
        })
    }

    fn build_notify_icon_data(hwnd: HWND, tooltip: &str) -> NOTIFYICONDATAW {
        let mut nid = NOTIFYICONDATAW {
            cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
            hWnd: hwnd,
            uID: TRAY_ICON_ID,
            uFlags: NIF_MESSAGE | NIF_ICON | NIF_TIP,
            uCallbackMessage: WM_TRAYICON,
            ..Default::default()
        };
        // SAFETY: loads the default application icon when no resource icon
        // is embedded yet.
        if let Ok(icon) = unsafe { LoadIconW(None, IDI_APPLICATION) } {
            nid.hIcon = icon;
        }
        for (dst, src) in nid.szTip.iter_mut().take(127).zip(tooltip.encode_utf16()) {
            *dst = src;
        }
        nid
    }

    fn try_add_icon(hwnd: HWND, tooltip: &str) -> bool {
        let nid = build_notify_icon_data(hwnd, tooltip);
        // SAFETY: `nid` is initialized with `cbSize` and valid handles.
        unsafe { Shell_NotifyIconW(NIM_ADD, &nid) }.as_bool()
    }

    /// Removes this window's icon; one that is not registered is left alone.
    fn remove_icon(hwnd: HWND) {
        let nid = NOTIFYICONDATAW {
            cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
            hWnd: hwnd,
            uID: TRAY_ICON_ID,
            ..Default::default()
        };
        // SAFETY: `nid` names the icon by this window and its id; deleting
        // one that is not registered only returns false.
        let _ = unsafe { Shell_NotifyIconW(NIM_DELETE, &nid) };
    }

    pub(super) fn hide_hwnd(raw: isize) {
        if raw == 0 {
            return;
        }
        let hwnd = HWND(raw as *mut core::ffi::c_void);
        // Posted, not sent (`ShowWindowAsync`, as GPUI's own `activate`
        // does): the callers hold GPUI's app state, and a show or hide sent
        // at once runs the window procedure inside that borrow, where GPUI
        // drops what it cannot deliver ("RefCell already borrowed", seen on
        // Windows 11 ARM on 2026-11-21: the activation, visibility and
        // input callbacks of that moment).
        // SAFETY: `IsWindow` validates the handle before hiding it.
        unsafe {
            if IsWindow(Some(hwnd)).as_bool() {
                let _ = ShowWindowAsync(hwnd, SW_HIDE);
            }
        }
    }

    pub(super) fn restore_hwnd(raw: isize) {
        if raw == 0 {
            return;
        }
        let hwnd = HWND(raw as *mut core::ffi::c_void);
        // Posted, like the hide above. Bringing it to the foreground is the
        // caller's `Window::activate_window`, which GPUI runs outside its
        // app state; `SetForegroundWindow` here would send the activation
        // messages inside the caller's borrow.
        // SAFETY: `IsWindow` validates the handle before restoring it.
        unsafe {
            if IsWindow(Some(hwnd)).as_bool() {
                let cmd = if IsIconic(hwnd).as_bool() {
                    SW_RESTORE
                } else {
                    SW_SHOW
                };
                let _ = ShowWindowAsync(hwnd, cmd);
            }
        }
    }

    impl NativeTray {
        pub(super) fn create(
            tooltip: &str,
            controller: &Arc<TrayController>,
        ) -> Result<Self, TrayError> {
            let class_name = register_class();
            let _ = taskbar_created_msg();
            let title = wide(tooltip);
            // SAFETY: creates a hidden top-level window (never shown, so no
            // taskbar button) on the current thread to receive both
            // `Shell_NotifyIconW` callbacks and `TaskbarCreated` broadcasts.
            let hwnd = unsafe {
                CreateWindowExW(
                    WINDOW_EX_STYLE(0),
                    PCWSTR::from_raw(class_name.as_ptr()),
                    PCWSTR::from_raw(title.as_ptr()),
                    WINDOW_STYLE(0),
                    0,
                    0,
                    0,
                    0,
                    None,
                    None,
                    None,
                    None,
                )
            }
            .map_err(|e| TrayError::Platform(e.to_string()))?;

            let icon_registered = Arc::new(AtomicBool::new(false));
            let ctx = Box::new(WindowContext {
                controller: Arc::downgrade(controller),
                icon_registered: icon_registered.clone(),
            });
            // SAFETY: stores the heap-allocated `WindowContext` in the
            // hidden window's user data slot; freed in `Drop`.
            unsafe {
                let _ = SetWindowLongPtrW(hwnd, GWLP_USERDATA, Box::into_raw(ctx) as isize);
            }

            let added = try_add_icon(hwnd, tooltip);
            icon_registered.store(added, Ordering::SeqCst);
            controller.set_notification_area_available(added);
            if !added {
                tracing::debug!(
                    "Windows notification area unavailable at startup; deferring tray icon until TaskbarCreated"
                );
            }

            Ok(Self {
                hwnd: hwnd.0 as isize,
                icon_registered,
            })
        }
    }

    impl Drop for NativeTray {
        fn drop(&mut self) {
            let hwnd = HWND(self.hwnd as *mut core::ffi::c_void);
            // SAFETY: removes the notification icon (when registered) and
            // frees the window's user data before destroying the window.
            unsafe {
                if self.icon_registered.swap(false, Ordering::SeqCst) {
                    let nid = NOTIFYICONDATAW {
                        cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
                        hWnd: hwnd,
                        uID: TRAY_ICON_ID,
                        ..Default::default()
                    };
                    let _ = Shell_NotifyIconW(NIM_DELETE, &nid);
                }
                let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut WindowContext;
                let _ = SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
                if !ptr.is_null() {
                    drop(Box::from_raw(ptr));
                }
                let _ = DestroyWindow(hwnd);
            }
        }
    }

    unsafe fn context_from_hwnd(hwnd: HWND) -> Option<(Arc<TrayController>, Arc<AtomicBool>)> {
        // SAFETY: reads the `WindowContext` pointer set in `create`.
        let ptr = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) } as *const WindowContext;
        if ptr.is_null() {
            None
        } else {
            let ctx = unsafe { &*ptr };
            ctx.controller
                .upgrade()
                .map(|c| (c, ctx.icon_registered.clone()))
        }
    }

    unsafe fn show_context_menu(hwnd: HWND, controller: &TrayController) {
        let labels = controller.labels();
        let open_wide = wide(&labels.open);
        let quit_wide = wide(&labels.quit);
        // SAFETY: creates and displays a modal Win32 popup menu at the cursor
        // position on the main UI thread, then destroys the menu handle.
        unsafe {
            let Ok(menu) = CreatePopupMenu() else {
                return;
            };
            let _ = AppendMenuW(
                menu,
                MF_STRING,
                ID_TRAY_OPEN,
                PCWSTR::from_raw(open_wide.as_ptr()),
            );
            let _ = AppendMenuW(
                menu,
                MF_STRING,
                ID_TRAY_QUIT,
                PCWSTR::from_raw(quit_wide.as_ptr()),
            );
            let mut pt = POINT::default();
            let _ = GetCursorPos(&mut pt);
            let _ = SetForegroundWindow(hwnd);
            let _ = TrackPopupMenu(
                menu,
                TPM_LEFTALIGN | TPM_BOTTOMALIGN | TPM_RIGHTBUTTON,
                pt.x,
                pt.y,
                None,
                hwnd,
                None,
            );
            let _ = PostMessageW(Some(hwnd), WM_NULL, WPARAM(0), LPARAM(0));
            let _ = DestroyMenu(menu);
        }
    }

    unsafe extern "system" fn wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match msg {
            WM_TRAYICON => {
                let event = (lparam.0 as u32) & 0xffff;
                if let Some((controller, _)) = unsafe { context_from_hwnd(hwnd) } {
                    match event {
                        WM_LBUTTONUP => controller.notify_left_click(),
                        WM_RBUTTONUP | WM_CONTEXTMENU => unsafe {
                            show_context_menu(hwnd, &controller);
                        },
                        _ => {}
                    }
                }
                LRESULT(0)
            }
            WM_COMMAND => {
                let command_id = wparam.0 & 0xffff;
                if let Some((controller, _)) = unsafe { context_from_hwnd(hwnd) } {
                    match command_id {
                        ID_TRAY_OPEN => controller.notify_menu_open(),
                        ID_TRAY_QUIT => controller.notify_menu_quit(),
                        _ => {}
                    }
                }
                LRESULT(0)
            }
            other if other != 0 && other == taskbar_created_msg() => {
                if let Some((controller, icon_registered)) = unsafe { context_from_hwnd(hwnd) } {
                    // Explorer announces a new taskbar after it restarts, when
                    // the old icon is gone, but the same message also reaches a
                    // window whose icon is still there. Adding an icon that is
                    // still registered fails, which would read as "no
                    // notification area" and turn the next close of the window
                    // into a quit, so whatever this window has goes first.
                    remove_icon(hwnd);
                    let added = try_add_icon(hwnd, &controller.tooltip());
                    icon_registered.store(added, Ordering::SeqCst);
                    controller.set_notification_area_available(added);
                }
                LRESULT(0)
            }
            // SAFETY: forwards unhandled messages to the default window proc.
            _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
        }
    }

    /// Tests: delivers tray icon, context-menu and `TaskbarCreated` messages to
    /// the hidden window procedure on the current thread.
    #[cfg(test)]
    pub(super) mod simulate {
        use windows::Win32::Foundation::{LPARAM, WPARAM};
        use windows::Win32::UI::WindowsAndMessaging::{SendMessageW, WM_COMMAND, WM_LBUTTONUP};

        use super::{
            HWND, ID_TRAY_OPEN, ID_TRAY_QUIT, TrayController, WM_TRAYICON, taskbar_created_msg,
        };

        fn send(controller: &TrayController, msg: u32, wparam: usize, lparam: isize) {
            let hwnd = {
                let native = controller.native.lock().unwrap_or_else(|e| e.into_inner());
                HWND(
                    native
                        .as_ref()
                        .expect("the hidden window is installed")
                        .hwnd as *mut core::ffi::c_void,
                )
            };
            // SAFETY: the hidden window lives on this thread, so this calls
            // its window procedure directly.
            unsafe { SendMessageW(hwnd, msg, Some(WPARAM(wparam)), Some(LPARAM(lparam))) };
        }

        pub(in crate::tray) fn left_click(controller: &TrayController) {
            send(controller, WM_TRAYICON, 0, WM_LBUTTONUP as isize);
        }

        pub(in crate::tray) fn menu_open(controller: &TrayController) {
            send(controller, WM_COMMAND, ID_TRAY_OPEN, 0);
        }

        pub(in crate::tray) fn menu_quit(controller: &TrayController) {
            send(controller, WM_COMMAND, ID_TRAY_QUIT, 0);
        }

        pub(in crate::tray) fn taskbar_created(controller: &TrayController) {
            let msg = taskbar_created_msg();
            if msg != 0 {
                send(controller, msg, 0, 0);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use crate::identity::DEVELOPMENT;

    #[test]
    fn labels_are_short_single_lines() {
        assert!(valid_label("打开 Drifting"));
        assert!(valid_label("Open Drifting"));
        assert!(!valid_label(""));
        assert!(!valid_label("Quit\nDrifting"));
        assert!(!valid_label("Quit\rDrifting"));
        assert!(!valid_label("Quit\u{7}Drifting"));
        assert!(!valid_label(&"x".repeat(MAX_LABEL_CHARS + 1)));
    }

    /// The nine interface languages, by `dr_i18n::Locale::code`: each has
    /// labels of its own, none left in English but English itself.
    #[test]
    fn locale_labels_cover_all_nine_interface_languages() {
        let english = TrayLabels::default();
        for locale in [
            "zh-CN", "zh-TW", "en", "ja", "ko", "es", "de", "fr", "pt-BR",
        ] {
            let labels = TrayLabels::for_locale(locale);
            assert!(valid_label(&labels.open), "invalid open label for {locale}");
            assert!(valid_label(&labels.quit), "invalid quit label for {locale}");
            if locale != "en" {
                assert_ne!(labels.open, english.open, "{locale} open left in English");
                assert_ne!(labels.quit, english.quit, "{locale} quit left in English");
            }
        }
        let zh = TrayLabels::for_locale("zh-CN");
        assert_eq!(zh.open, "打开 Drifting");
        assert_eq!(zh.quit, "退出 Drifting");
        let pt = TrayLabels::for_locale("pt-BR");
        assert_eq!(pt.open, "Abrir o Drifting");
        assert_eq!(pt.quit, "Sair do Drifting");
    }

    #[test]
    fn windows_close_hides_to_tray_and_restore_paths_bring_window_back() {
        let mut state = TrayState::with_platform(&DEVELOPMENT, TrayLabels::default(), true);
        assert!(state.window_visible());
        assert!(!state.is_quitting());

        // Closing hides the window to the notification area at once.
        assert_eq!(
            state.on_window_close_request(),
            WindowCloseDecision::HideToTray
        );
        assert!(!state.window_visible());
        assert!(!state.is_quitting());

        // Left-clicking the tray icon brings the window back.
        assert_eq!(state.on_left_click(), TrayCommand::RestoreWindow);
        assert!(state.window_visible());

        // Hide again, then restore via a second instance launch forwarding args.
        assert_eq!(
            state.on_window_close_request(),
            WindowCloseDecision::HideToTray
        );
        assert!(!state.window_visible());
        assert_eq!(
            state.on_second_instance_launch(),
            TrayCommand::RestoreWindow
        );
        assert!(state.window_visible());

        // Hide again, then restore via the tray menu's Open item.
        assert_eq!(
            state.on_window_close_request(),
            WindowCloseDecision::HideToTray
        );
        assert_eq!(state.on_menu_open(), TrayCommand::RestoreWindow);
        assert!(state.window_visible());

        // Choosing Quit from the tray menu marks the app as quitting.
        assert_eq!(state.on_menu_quit(), TrayCommand::QuitApp);
        assert!(state.is_quitting());
        assert_eq!(
            state.on_window_close_request(),
            WindowCloseDecision::QuitProcess
        );
    }

    #[test]
    fn missing_notification_icon_quits_on_close_until_taskbar_appears() {
        let controller = TrayController::with_platform(&DEVELOPMENT, TrayLabels::default(), false);
        assert!(controller.manages_window_close());
        assert!(!controller.has_notification_icon());

        // Closing without a tray icon quits cleanly instead of hiding the
        // window into an invisible unreachable state.
        assert_eq!(
            controller.handle_window_close(),
            WindowCloseDecision::QuitProcess
        );
        assert!(controller.window_visible());
        assert!(controller.is_quitting());

        // If the shutdown barrier fails, cancelling quit restores normal state;
        // once `TaskbarCreated` registers the icon, closing hides to tray.
        controller.cancel_quit();
        assert!(!controller.is_quitting());
        controller.set_notification_area_available(true);
        assert!(controller.has_notification_icon());
        assert_eq!(
            controller.handle_window_close(),
            WindowCloseDecision::HideToTray
        );
        assert!(!controller.window_visible());
    }

    /// The queue, the labels and the waker, on every platform: without the
    /// native icon, which the next test covers.
    #[test]
    fn controller_queues_commands_updates_labels_and_wakes_listener() {
        let controller = TrayController::without_icon(&DEVELOPMENT, TrayLabels::default());
        let woken = Arc::new(AtomicUsize::new(0));
        let woken_clone = woken.clone();
        controller.set_waker(move || {
            woken_clone.fetch_add(1, Ordering::SeqCst);
        });

        controller
            .set_labels("打开 Drifting".into(), "退出 Drifting".into())
            .expect("valid Chinese labels");
        assert_eq!(controller.labels().open, "打开 Drifting");
        assert_eq!(
            controller.set_labels("".into(), "退出 Drifting".into()),
            Err(TrayError::InvalidLabel)
        );

        controller.notify_left_click();
        controller.notify_second_instance();
        controller.notify_menu_quit();

        assert_eq!(woken.load(Ordering::SeqCst), 3);
        assert_eq!(
            controller.drain_commands(),
            vec![
                TrayCommand::RestoreWindow,
                TrayCommand::RestoreWindow,
                TrayCommand::QuitApp,
            ]
        );
        assert!(controller.drain_commands().is_empty());
    }

    /// On Windows the hidden notification window always installs (even on
    /// headless CI sessions without Explorer's taskbar notification area),
    /// degrades closing to `QuitProcess` when `NIM_ADD` is unavailable,
    /// handles `TaskbarCreated`, and routes left-click and menu commands
    /// through its Win32 window procedure into the queue. Off Windows it is the
    /// inert controller.
    #[test]
    fn install_adds_the_icon_and_its_window_feeds_the_queue() {
        let controller = TrayController::install(&DEVELOPMENT, TrayLabels::default())
            .expect("controller installs");
        #[cfg(windows)]
        {
            if !controller.has_notification_icon() {
                assert_eq!(
                    controller.handle_window_close(),
                    WindowCloseDecision::QuitProcess
                );
                controller.cancel_quit();
            }
            // The taskbar announcing itself to a window that already has its
            // icon keeps the icon: closing still hides.
            let had_icon = controller.has_notification_icon();
            windows_impl::simulate::taskbar_created(&controller);
            if had_icon {
                assert!(controller.has_notification_icon());
                assert_eq!(
                    controller.handle_window_close(),
                    WindowCloseDecision::HideToTray
                );
            }
            windows_impl::simulate::left_click(&controller);
            windows_impl::simulate::menu_open(&controller);
            windows_impl::simulate::menu_quit(&controller);
            assert_eq!(
                controller.drain_commands(),
                vec![
                    TrayCommand::RestoreWindow,
                    TrayCommand::RestoreWindow,
                    TrayCommand::QuitApp,
                ]
            );
            assert!(controller.is_quitting());
        }
        assert!(controller.drain_commands().is_empty());
    }
}
