//! Windows notification area (system tray) support (M43).
//!
//! Like the Dock on macOS, Windows keeps Drifting running in the notification
//! area when its window closes on the bookshelf so background Agent tasks,
//! Hosted sync and the local MCP bridge keep running. Closing a window while a
//! book is open returns to the shelf first; closing on the shelf saves and
//! hides the window to the notification area.
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
            "ru" | "ru-ru" => ("Открыть Drifting", "Выйти из Drifting"),
            _ => ("Open Drifting", "Quit Drifting"),
        };
        Self {
            open: open.to_owned(),
            quit: quit.to_owned(),
        }
    }
}

/// Where the main window is when the user presses its close button.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowCloseContext {
    /// A book is open in the workspace: closing returns to the bookshelf.
    BookOpen,
    /// The window is on the bookshelf: closing hides to the notification area
    /// on Windows.
    OnShelf,
}

/// What the shell should do in response to a window close request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowCloseDecision {
    /// Close the current book and return to the bookshelf without hiding or
    /// quitting the window.
    ReturnToShelf,
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
        Self::with_platform(identity, labels, cfg!(windows))
    }

    /// Creates a state machine with an explicit platform policy (used in
    /// cross-platform unit tests).
    pub fn with_platform(
        identity: &Identity,
        labels: TrayLabels,
        keep_in_notification_area: bool,
    ) -> Self {
        Self {
            keep_in_notification_area,
            window_visible: true,
            quitting: false,
            tooltip: identity.product_name.to_owned(),
            labels,
        }
    }

    pub fn window_visible(&self) -> bool {
        self.window_visible
    }

    pub fn is_quitting(&self) -> bool {
        self.quitting
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
    pub fn on_window_close_request(&mut self, context: WindowCloseContext) -> WindowCloseDecision {
        if self.quitting {
            return WindowCloseDecision::QuitProcess;
        }
        match context {
            WindowCloseContext::BookOpen => WindowCloseDecision::ReturnToShelf,
            WindowCloseContext::OnShelf => {
                if self.keep_in_notification_area {
                    self.window_visible = false;
                    WindowCloseDecision::HideToTray
                } else {
                    self.quitting = true;
                    WindowCloseDecision::QuitProcess
                }
            }
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
            .field("window_visible", &state.window_visible)
            .field("quitting", &state.quitting)
            .field("labels", &state.labels)
            .finish_non_exhaustive()
    }
}

impl TrayController {
    /// Installs the notification area icon on the current (main) thread on
    /// Windows; on other platforms returns an inert controller with the same
    /// command channel and label validation.
    pub fn install(identity: &Identity, labels: TrayLabels) -> Result<Arc<Self>, TrayError> {
        let controller = Arc::new(Self {
            state: Mutex::new(TrayState::new(identity, labels)),
            commands: Mutex::new(Vec::new()),
            waker: Mutex::new(None),
            #[cfg(windows)]
            native: Mutex::new(None),
        });
        #[cfg(windows)]
        {
            let native = windows_impl::NativeTray::create(identity.product_name, &controller)?;
            *controller.native.lock().unwrap_or_else(|e| e.into_inner()) = Some(native);
        }
        Ok(controller)
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
    pub fn handle_window_close(&self, context: WindowCloseContext) -> WindowCloseDecision {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.on_window_close_request(context)
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
    use std::sync::{Arc, OnceLock, Weak};

    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::Shell::{
        NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE, NOTIFYICONDATAW, Shell_NotifyIconW,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        AppendMenuW, CreatePopupMenu, CreateWindowExW, DefWindowProcW, DestroyMenu, DestroyWindow,
        GWLP_USERDATA, GetCursorPos, GetWindowLongPtrW, HWND_MESSAGE, IDI_APPLICATION, LoadIconW,
        MF_STRING, PostMessageW, RegisterClassW, SetForegroundWindow, SetWindowLongPtrW,
        TPM_BOTTOMALIGN, TPM_LEFTALIGN, TPM_RIGHTBUTTON, TrackPopupMenu, WINDOW_EX_STYLE,
        WINDOW_STYLE, WM_COMMAND, WM_CONTEXTMENU, WM_LBUTTONUP, WM_NULL, WM_RBUTTONUP, WM_USER,
        WNDCLASSW,
    };
    use windows::core::PCWSTR;

    use super::{TrayController, TrayError};

    const WM_TRAYICON: u32 = WM_USER + 0x44;
    const TRAY_ICON_ID: u32 = 1;
    const ID_TRAY_OPEN: usize = 1001;
    const ID_TRAY_QUIT: usize = 1002;

    pub(super) struct NativeTray {
        hwnd: isize,
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
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

    impl NativeTray {
        pub(super) fn create(
            tooltip: &str,
            controller: &Arc<TrayController>,
        ) -> Result<Self, TrayError> {
            let class_name = register_class();
            let title = wide(tooltip);
            // SAFETY: creates a message-only window (`HWND_MESSAGE`) on the
            // current thread to receive `Shell_NotifyIconW` callbacks.
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
                    Some(HWND_MESSAGE),
                    None,
                    None,
                    None,
                )
            }
            .map_err(|e| TrayError::Platform(e.to_string()))?;

            let weak = Box::new(Arc::downgrade(controller));
            // SAFETY: stores the heap-allocated `Weak<TrayController>` in the
            // message window's user data slot; freed in `Drop`.
            unsafe {
                let _ = SetWindowLongPtrW(hwnd, GWLP_USERDATA, Box::into_raw(weak) as isize);
            }

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

            // SAFETY: `nid` is initialized with `cbSize` and valid handles.
            let added = unsafe { Shell_NotifyIconW(NIM_ADD, &nid) };
            if !added.as_bool() {
                unsafe {
                    let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut Weak<TrayController>;
                    let _ = SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
                    if !ptr.is_null() {
                        drop(Box::from_raw(ptr));
                    }
                    let _ = DestroyWindow(hwnd);
                }
                return Err(TrayError::Platform(
                    "Shell_NotifyIconW(NIM_ADD) failed".into(),
                ));
            }

            Ok(Self {
                hwnd: hwnd.0 as isize,
            })
        }
    }

    impl Drop for NativeTray {
        fn drop(&mut self) {
            let hwnd = HWND(self.hwnd as *mut core::ffi::c_void);
            let nid = NOTIFYICONDATAW {
                cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
                hWnd: hwnd,
                uID: TRAY_ICON_ID,
                ..Default::default()
            };
            // SAFETY: removes the notification icon and frees the window's
            // user data before destroying the message window.
            unsafe {
                let _ = Shell_NotifyIconW(NIM_DELETE, &nid);
                let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut Weak<TrayController>;
                let _ = SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
                if !ptr.is_null() {
                    drop(Box::from_raw(ptr));
                }
                let _ = DestroyWindow(hwnd);
            }
        }
    }

    unsafe fn controller_from_hwnd(hwnd: HWND) -> Option<Arc<TrayController>> {
        // SAFETY: reads the `Weak<TrayController>` pointer set in `create`.
        let ptr = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) } as *const Weak<TrayController>;
        if ptr.is_null() {
            None
        } else {
            unsafe { (*ptr).upgrade() }
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
                if let Some(controller) = unsafe { controller_from_hwnd(hwnd) } {
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
                if let Some(controller) = unsafe { controller_from_hwnd(hwnd) } {
                    match command_id {
                        ID_TRAY_OPEN => controller.notify_menu_open(),
                        ID_TRAY_QUIT => controller.notify_menu_quit(),
                        _ => {}
                    }
                }
                LRESULT(0)
            }
            // SAFETY: forwards unhandled messages to the default window proc.
            _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
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

    #[test]
    fn locale_labels_cover_all_nine_interface_languages() {
        for locale in ["zh-CN", "zh-TW", "en", "ja", "ko", "fr", "de", "es", "ru"] {
            let labels = TrayLabels::for_locale(locale);
            assert!(valid_label(&labels.open), "invalid open label for {locale}");
            assert!(valid_label(&labels.quit), "invalid quit label for {locale}");
        }
        let zh = TrayLabels::for_locale("zh-CN");
        assert_eq!(zh.open, "打开 Drifting");
        assert_eq!(zh.quit, "退出 Drifting");
    }

    #[test]
    fn windows_shelf_close_hides_to_tray_and_restore_paths_bring_window_back() {
        let mut state = TrayState::with_platform(&DEVELOPMENT, TrayLabels::default(), true);
        assert!(state.window_visible());
        assert!(!state.is_quitting());

        // Closing while a book is open returns to the shelf first.
        assert_eq!(
            state.on_window_close_request(WindowCloseContext::BookOpen),
            WindowCloseDecision::ReturnToShelf
        );
        assert!(state.window_visible());

        // Closing on the shelf hides the window to the notification area.
        assert_eq!(
            state.on_window_close_request(WindowCloseContext::OnShelf),
            WindowCloseDecision::HideToTray
        );
        assert!(!state.window_visible());
        assert!(!state.is_quitting());

        // Left-clicking the tray icon brings the window back.
        assert_eq!(state.on_left_click(), TrayCommand::RestoreWindow);
        assert!(state.window_visible());

        // Hide again, then restore via a second instance launch forwarding args.
        assert_eq!(
            state.on_window_close_request(WindowCloseContext::OnShelf),
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
            state.on_window_close_request(WindowCloseContext::OnShelf),
            WindowCloseDecision::HideToTray
        );
        assert_eq!(state.on_menu_open(), TrayCommand::RestoreWindow);
        assert!(state.window_visible());

        // Choosing Quit from the tray menu marks the app as quitting.
        assert_eq!(state.on_menu_quit(), TrayCommand::QuitApp);
        assert!(state.is_quitting());
        assert_eq!(
            state.on_window_close_request(WindowCloseContext::OnShelf),
            WindowCloseDecision::QuitProcess
        );
    }

    #[test]
    fn controller_queues_commands_updates_labels_and_wakes_listener() {
        let controller = TrayController::install(&DEVELOPMENT, TrayLabels::default())
            .expect("controller installs");
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
}
