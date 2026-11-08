//! Finding what the window shows by its accessible name (macOS).
//!
//! GPUI builds an AccessKit tree from every element with a role and an id
//! (dr-ui's buttons, cells, tabs, radios, sliders; ⁂ and its actions; the
//! selection bar's buttons …), but only while an assistive client is
//! connected. The bridge connects from inside the app: it asks the window's
//! content view for its accessibility children, as VoiceOver would, which
//! makes AccessKit request the tree and GPUI build it from the next frame
//! on. The nodes come back with their role, title (the element's
//! `aria_label`), value and frame; the frame is turned back into the
//! window's logical pixels, where the bridge's pointer events land.
//!
//! No system permission is involved: these are the app's own objects, read
//! on its main thread. Text fields have no role in dr-ui yet, so they are
//! not in the tree (`ui.focus` reaches them instead).

use gpui::Window;

/// One node of the window's accessibility tree, in the window's logical
/// pixels.
#[derive(Clone, Debug, PartialEq)]
pub struct Node {
    pub role: String,
    pub label: Option<String>,
    pub value: Option<String>,
    pub help: Option<String>,
    pub bounds: [f32; 4],
    pub focused: bool,
    pub enabled: bool,
    pub depth: usize,
}

impl Node {
    pub fn center(&self) -> (f32, f32) {
        let [x, y, w, h] = self.bounds;
        (x + w / 2.0, y + h / 2.0)
    }

    pub fn to_json(&self) -> serde_json::Value {
        let (cx, cy) = self.center();
        serde_json::json!({
            "role": self.role,
            "label": self.label,
            "value": self.value,
            "help": self.help,
            "bounds": { "x": self.bounds[0], "y": self.bounds[1], "width": self.bounds[2], "height": self.bounds[3] },
            "center": [cx, cy],
            "focused": self.focused,
            "enabled": self.enabled,
            "depth": self.depth,
        })
    }
}

/// Whether the platform has this.
pub const SUPPORTED: bool = cfg!(target_os = "macos");

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::{CStr, c_char};
    use std::ptr;

    use gpui::Window;
    use objc2::encode::{Encode, Encoding};
    use objc2::msg_send;
    use objc2::rc::autoreleasepool;
    use objc2::runtime::{AnyObject, Bool};

    use super::Node;

    #[repr(C)]
    #[derive(Clone, Copy, Debug, Default)]
    struct CGPoint {
        x: f64,
        y: f64,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Debug, Default)]
    struct CGSize {
        width: f64,
        height: f64,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Debug, Default)]
    struct CGRect {
        origin: CGPoint,
        size: CGSize,
    }

    // SAFETY: the layouts and type encodings of CoreGraphics' structs (as
    // objc2-core-foundation declares them).
    unsafe impl Encode for CGPoint {
        const ENCODING: Encoding = Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
    }
    unsafe impl Encode for CGSize {
        const ENCODING: Encoding = Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
    }
    unsafe impl Encode for CGRect {
        const ENCODING: Encoding =
            Encoding::Struct("CGRect", &[CGPoint::ENCODING, CGSize::ENCODING]);
    }

    /// The window's content view (the one AccessKit's adapter wraps).
    fn content_view(window: &Window) -> Option<*mut AnyObject> {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        let handle = HasWindowHandle::window_handle(window).ok()?;
        let RawWindowHandle::AppKit(appkit) = handle.as_raw() else {
            return None;
        };
        let view = appkit.ns_view.as_ptr() as *mut AnyObject;
        // SAFETY: GPUI's own view, on the main thread.
        unsafe {
            let ns_window: *mut AnyObject = msg_send![view, window];
            if ns_window.is_null() {
                return Some(view);
            }
            let content: *mut AnyObject = msg_send![ns_window, contentView];
            Some(if content.is_null() { view } else { content })
        }
    }

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

    /// # Safety
    /// `o` is nil or an object.
    unsafe fn described(o: *mut AnyObject) -> Option<String> {
        if o.is_null() {
            return None;
        }
        let d: *mut AnyObject = unsafe { msg_send![o, description] };
        unsafe { string(d) }.filter(|s| !s.is_empty())
    }

    struct Frame {
        view: *mut AnyObject,
        window: *mut AnyObject,
        flipped: bool,
        height: f64,
    }

    impl Frame {
        /// A frame in screen coordinates as the view's top-left logical
        /// pixels (GPUI's window coordinates).
        unsafe fn local(&self, r: CGRect) -> [f32; 4] {
            if self.window.is_null() {
                return [0.0; 4];
            }
            let r: CGRect = unsafe { msg_send![self.window, convertRectFromScreen: r] };
            let r: CGRect = unsafe {
                msg_send![self.view, convertRect: r, fromView: ptr::null_mut::<AnyObject>()]
            };
            let y = if self.flipped {
                r.origin.y
            } else {
                self.height - r.origin.y - r.size.height
            };
            [
                r.origin.x as f32,
                y as f32,
                r.size.width as f32,
                r.size.height as f32,
            ]
        }
    }

    /// Visits every node under the content view, depth first, with the
    /// object (valid until `walk` returns) for pressing. The visitor
    /// returns true to stop.
    pub fn walk(window: &Window, mut visit: impl FnMut(&Node, *mut AnyObject) -> bool) -> bool {
        let Some(view) = content_view(window) else {
            return false;
        };
        autoreleasepool(|_| unsafe {
            let ns_window: *mut AnyObject = msg_send![view, window];
            let flipped: Bool = msg_send![view, isFlipped];
            let bounds: CGRect = msg_send![view, bounds];
            let frame = Frame {
                view,
                window: ns_window,
                flipped: flipped.as_bool(),
                height: bounds.size.height,
            };
            let mut stack: Vec<(*mut AnyObject, usize)> = Vec::new();
            let push_children =
                |stack: &mut Vec<(*mut AnyObject, usize)>, of: *mut AnyObject, depth| {
                    let children: *mut AnyObject = msg_send![of, accessibilityChildren];
                    if children.is_null() {
                        return;
                    }
                    let n: usize = msg_send![children, count];
                    for i in (0..n).rev() {
                        let child: *mut AnyObject = msg_send![children, objectAtIndex: i];
                        if !child.is_null() {
                            stack.push((child, depth));
                        }
                    }
                };
            push_children(&mut stack, view, 0);
            while let Some((o, depth)) = stack.pop() {
                let role: *mut AnyObject = msg_send![o, accessibilityRole];
                let title: *mut AnyObject = msg_send![o, accessibilityTitle];
                let value: *mut AnyObject = msg_send![o, accessibilityValue];
                let help: *mut AnyObject = msg_send![o, accessibilityHelp];
                let rect: CGRect = msg_send![o, accessibilityFrame];
                let focused: Bool = msg_send![o, isAccessibilityFocused];
                let enabled: Bool = msg_send![o, isAccessibilityEnabled];
                let node = Node {
                    role: string(role)
                        .map(|r| r.trim_start_matches("AX").to_owned())
                        .unwrap_or_default(),
                    label: string(title).filter(|s| !s.is_empty()),
                    value: described(value),
                    help: string(help).filter(|s| !s.is_empty()),
                    bounds: frame.local(rect),
                    focused: focused.as_bool(),
                    enabled: enabled.as_bool(),
                    depth,
                };
                if visit(&node, o) {
                    return true;
                }
                push_children(&mut stack, o, depth + 1);
            }
            false
        })
    }

    /// Connects as an assistive client would: AccessKit asks GPUI for the
    /// tree, and GPUI builds it from the next frame on.
    pub fn connect(window: &Window) {
        if let Some(view) = content_view(window) {
            autoreleasepool(|_| unsafe {
                let _: *mut AnyObject = msg_send![view, accessibilityChildren];
            });
        }
    }

    /// AccessKit's press (GPUI clicks the centre of the element's own
    /// bounds, or runs its accessibility action), increment or decrement.
    pub fn perform(o: *mut AnyObject, action: super::Action) -> bool {
        // SAFETY: an object `walk` handed out, still inside its pool.
        let done: Bool = unsafe {
            match action {
                super::Action::Press => msg_send![o, accessibilityPerformPress],
                super::Action::Increment => msg_send![o, accessibilityPerformIncrement],
                super::Action::Decrement => msg_send![o, accessibilityPerformDecrement],
            }
        };
        done.as_bool()
    }
}

/// What AccessKit is asked to do with a node.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Press,
    Increment,
    Decrement,
}

/// Every node the window's accessibility tree has now, and whether that
/// tree is current: `false` while the tree is only being connected (GPUI
/// builds it from the next frame on), when the nodes are not to be trusted.
pub fn nodes(window: &mut Window) -> (Vec<Node>, bool) {
    #[cfg(target_os = "macos")]
    {
        let current = window.is_a11y_active();
        if !current {
            mac::connect(window);
            window.refresh();
        }
        let mut all = Vec::new();
        mac::walk(window, |n, _| {
            all.push(n.clone());
            false
        });
        (all, current)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        (Vec::new(), false)
    }
}

/// Asks AccessKit to do `action` to the `nth` node `matches` accepts; the
/// node, if there was one.
pub fn perform(
    window: &mut Window,
    nth: usize,
    action: Action,
    matches: impl Fn(&Node) -> bool,
) -> Option<Node> {
    #[cfg(target_os = "macos")]
    {
        let mut seen = 0usize;
        let mut found = None;
        mac::walk(window, |n, o| {
            if !matches(n) {
                return false;
            }
            if seen < nth {
                seen += 1;
                return false;
            }
            mac::perform(o, action);
            found = Some(n.clone());
            true
        });
        found
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, nth, action, matches);
        None
    }
}
