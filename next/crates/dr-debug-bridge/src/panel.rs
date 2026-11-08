//! The system's open and save panels (macOS).
//!
//! GPUI asks AppKit for them (`prompt_for_paths`, `prompt_for_new_path`): an
//! `NSOpenPanel` or `NSSavePanel` begun with a completion handler, which
//! reads the panel's `URLs` or `URL` once the author has chosen. On current
//! macOS the panel's contents live in a system service, so nothing in the
//! app can press its button (`-[NSSavePanel ok:]` throws "not implemented")
//! and the bridge's pointer never reaches it.
//!
//! So the bridge answers where AppKit hands the answer back. A scenario
//! arms an answer first (`panel.answer {path}` or `panel.cancel`), then
//! presses the app's own button; when the app begins its next panel, the
//! bridge's stand-in for `-[NSSavePanel beginWithCompletionHandler:]`
//! (`NSOpenPanel` inherits it) records what the app asked for (open or
//! save, the folder, the suggested name, the button's title), shows
//! nothing, and calls the app's handler at once with OK; while it runs,
//! the panel's `URL` / `URLs` give the armed path. What happens next is the
//! app's own path, exactly as after the author's click. Without an armed
//! answer the stand-ins hand straight to AppKit's own code, and the real
//! panel shows.
//!
//! The stand-ins are put in the first time an answer is armed, in a build
//! with the bridge only. No system permission is involved: the app's own
//! classes, on its main thread.

use std::path::PathBuf;

use serde_json::{Value, json};

/// What the next panel is answered with.
#[derive(Clone, Debug, PartialEq)]
pub enum Answer {
    Path(PathBuf),
    Cancel,
}

impl Answer {
    fn to_json(&self) -> Value {
        match self {
            Answer::Path(p) => json!(p.to_string_lossy()),
            Answer::Cancel => json!("cancel"),
        }
    }
}

/// A panel the app asked for.
#[derive(Clone, Debug, PartialEq)]
pub struct Request {
    /// `open` or `save`.
    pub kind: &'static str,
    /// The folder it was to show.
    pub directory: Option<String>,
    /// The save panel's suggested file name.
    pub name: Option<String>,
    /// Its default button's title.
    pub prompt: Option<String>,
    /// What the bridge answered; `None`: AppKit showed the real panel.
    pub answer: Option<Answer>,
}

impl Request {
    fn to_json(&self) -> Value {
        json!({
            "kind": self.kind,
            "directory": self.directory,
            "name": self.name,
            "prompt": self.prompt,
            "answer": self.answer.as_ref().map(Answer::to_json),
        })
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use std::cell::RefCell;
    use std::ffi::{CStr, CString, c_char, c_void};
    use std::path::Path;
    use std::sync::OnceLock;

    use objc2::rc::autoreleasepool;
    use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
    use objc2::{class, msg_send, sel};

    use super::{Answer, Request};

    thread_local! {
        static ARMED: RefCell<Option<Answer>> = const { RefCell::new(None) };
        /// The panel being answered now and its path, while the app's
        /// handler runs.
        static ANSWERING: RefCell<Option<(usize, std::path::PathBuf)>> = const { RefCell::new(None) };
        static LAST: RefCell<Option<Request>> = const { RefCell::new(None) };
    }

    /// `-beginWithCompletionHandler:`.
    type Begin = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut c_void);
    /// `-URL`, `-URLs`.
    type Getter = unsafe extern "C-unwind" fn(*mut AnyObject, Sel) -> *mut AnyObject;

    /// AppKit's own implementations, kept when the stand-ins go in.
    struct Originals {
        begin: Begin,
        url: Getter,
        urls: Getter,
    }

    static ORIGINALS: OnceLock<Originals> = OnceLock::new();

    /// The start of a block literal: the ABI every block shares.
    #[repr(C)]
    struct BlockLiteral {
        isa: *const c_void,
        flags: i32,
        reserved: i32,
        invoke: unsafe extern "C" fn(*mut BlockLiteral, isize),
    }

    /// `NSModalResponseOK`, `NSModalResponseCancel`.
    const OK: isize = 1;
    const CANCEL: isize = 0;

    /// # Safety
    /// `s` is nil or an `NSString`.
    unsafe fn string(s: *mut AnyObject) -> Option<String> {
        if s.is_null() {
            return None;
        }
        let utf8: *const c_char = unsafe { msg_send![s, UTF8String] };
        if utf8.is_null() {
            return None;
        }
        Some(
            unsafe { CStr::from_ptr(utf8) }
                .to_string_lossy()
                .into_owned(),
        )
    }

    /// An autoreleased file URL.
    ///
    /// # Safety
    /// On the main thread, inside a pool.
    unsafe fn file_url(path: &Path) -> *mut AnyObject {
        let c = CString::new(path.to_string_lossy().as_bytes()).unwrap_or_default();
        let s: *mut AnyObject =
            unsafe { msg_send![class!(NSString), stringWithUTF8String: c.as_ptr()] };
        unsafe {
            msg_send![class!(NSURL), fileURLWithPath: s, isDirectory: Bool::new(path.is_dir())]
        }
    }

    /// # Safety
    /// `url` is nil or an `NSURL`.
    unsafe fn url_path(url: *mut AnyObject) -> Option<String> {
        if url.is_null() {
            return None;
        }
        unsafe { string(msg_send![url, path]) }
    }

    /// # Safety
    /// `p` is an `NSSavePanel`.
    unsafe fn is_open(p: *mut AnyObject) -> bool {
        let open: &AnyClass = class!(NSOpenPanel);
        let b: Bool = unsafe { msg_send![p, isKindOfClass: open] };
        b.as_bool()
    }

    /// What the app set on the panel before beginning it.
    ///
    /// # Safety
    /// `p` is an `NSSavePanel`, on the main thread.
    unsafe fn request(p: *mut AnyObject, answer: Option<Answer>) -> Request {
        let open = unsafe { is_open(p) };
        Request {
            kind: if open { "open" } else { "save" },
            directory: unsafe { url_path(msg_send![p, directoryURL]) },
            name: if open {
                None
            } else {
                unsafe { string(msg_send![p, nameFieldStringValue]) }.filter(|s| !s.is_empty())
            },
            prompt: unsafe { string(msg_send![p, prompt]) }.filter(|s| !s.is_empty()),
            answer,
        }
    }

    fn answering(this: *mut AnyObject) -> Option<std::path::PathBuf> {
        ANSWERING.with(|a| {
            a.borrow()
                .as_ref()
                .filter(|(p, _)| *p == this as usize)
                .map(|(_, path)| path.clone())
        })
    }

    unsafe extern "C-unwind" fn begin(this: *mut AnyObject, cmd: Sel, handler: *mut c_void) {
        let armed = ARMED.with(|a| a.borrow_mut().take());
        let asked = unsafe { request(this, armed.clone()) };
        LAST.with(|l| *l.borrow_mut() = Some(asked));
        let Some(originals) = ORIGINALS.get() else {
            return;
        };
        let Some(answer) = armed else {
            unsafe { (originals.begin)(this, cmd, handler) };
            return;
        };
        let block = handler as *mut BlockLiteral;
        if block.is_null() {
            return;
        }
        match answer {
            Answer::Path(path) => {
                ANSWERING.with(|a| *a.borrow_mut() = Some((this as usize, path)));
                unsafe { ((*block).invoke)(block, OK) };
                ANSWERING.with(|a| *a.borrow_mut() = None);
            }
            Answer::Cancel => unsafe { ((*block).invoke)(block, CANCEL) },
        }
    }

    unsafe extern "C-unwind" fn url(this: *mut AnyObject, cmd: Sel) -> *mut AnyObject {
        match answering(this) {
            Some(path) => unsafe { file_url(&path) },
            None => match ORIGINALS.get() {
                Some(o) => unsafe { (o.url)(this, cmd) },
                None => std::ptr::null_mut(),
            },
        }
    }

    unsafe extern "C-unwind" fn urls(this: *mut AnyObject, cmd: Sel) -> *mut AnyObject {
        match answering(this) {
            Some(path) => unsafe {
                let url = file_url(&path);
                msg_send![class!(NSArray), arrayWithObject: url]
            },
            None => match ORIGINALS.get() {
                Some(o) => unsafe { (o.urls)(this, cmd) },
                None => std::ptr::null_mut(),
            },
        }
    }

    /// Puts the stand-ins in (once).
    fn install() -> bool {
        if ORIGINALS.get().is_some() {
            return true;
        }
        let save: &AnyClass = class!(NSSavePanel);
        let open: &AnyClass = class!(NSOpenPanel);
        let (Some(m_begin), Some(m_url), Some(m_urls)) = (
            save.instance_method(sel!(beginWithCompletionHandler:)),
            save.instance_method(sel!(URL)),
            open.instance_method(sel!(URLs)),
        ) else {
            return false;
        };
        // SAFETY: the stand-ins have the methods' own signatures (`v@:@?`,
        // `@@:`), and AppKit's implementations are kept to call on.
        unsafe {
            let originals = Originals {
                begin: std::mem::transmute::<Imp, Begin>(m_begin.implementation()),
                url: std::mem::transmute::<Imp, Getter>(m_url.implementation()),
                urls: std::mem::transmute::<Imp, Getter>(m_urls.implementation()),
            };
            if ORIGINALS.set(originals).is_err() {
                return true;
            }
            m_begin.set_implementation(std::mem::transmute::<Begin, Imp>(begin));
            m_url.set_implementation(std::mem::transmute::<Getter, Imp>(url));
            m_urls.set_implementation(std::mem::transmute::<Getter, Imp>(urls));
        }
        true
    }

    pub fn arm(answer: Option<Answer>) -> bool {
        if !install() {
            return false;
        }
        ARMED.with(|a| *a.borrow_mut() = answer);
        true
    }

    pub fn armed() -> Option<Answer> {
        ARMED.with(|a| a.borrow().clone())
    }

    pub fn last() -> Option<Request> {
        LAST.with(|l| l.borrow().clone())
    }

    /// A real panel on screen (one nobody answered).
    pub fn shown() -> bool {
        autoreleasepool(|_| unsafe {
            let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            if app.is_null() {
                return false;
            }
            let windows: *mut AnyObject = msg_send![app, windows];
            if windows.is_null() {
                return false;
            }
            let save: &AnyClass = class!(NSSavePanel);
            let n: usize = msg_send![windows, count];
            (0..n).any(|i| {
                let w: *mut AnyObject = msg_send![windows, objectAtIndex: i];
                if w.is_null() {
                    return false;
                }
                let is_panel: Bool = msg_send![w, isKindOfClass: save];
                let visible: Bool = msg_send![w, isVisible];
                is_panel.as_bool() && visible.as_bool()
            })
        })
    }
}

/// Arms the answer for the next panel the app begins (`None` disarms);
/// false where there is no such thing.
pub fn arm(answer: Option<Answer>) -> bool {
    #[cfg(target_os = "macos")]
    {
        mac::arm(answer)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = answer;
        false
    }
}

/// `panel.state`: the armed answer, the last panel the app asked for, and
/// whether a real one is on screen.
pub fn state() -> Value {
    #[cfg(target_os = "macos")]
    {
        json!({
            "armed": mac::armed().as_ref().map(Answer::to_json),
            "last": mac::last().as_ref().map(Request::to_json),
            "shown": mac::shown(),
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        json!({ "armed": null, "last": null, "shown": false })
    }
}
