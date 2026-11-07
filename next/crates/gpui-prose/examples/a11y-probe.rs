//! What a screen reader gets from the editor on macOS, read in-process.
//!
//! Opens a small window with an editor, asks the window's content view for
//! its accessibility children (which is what wakes AccessKit's macOS adapter
//! when VoiceOver connects), and then reads the text area the way VoiceOver
//! does: its role and title, the number of characters, a range of text, the
//! selected range, the caret's line, which element the application and
//! AccessKit report as focused, and whether it stays in the tree when
//! something else in the window redraws. It also moves the caret through
//! `setAccessibilitySelectedTextRange:`, and, last, makes the content view
//! first responder for one reading to show why the application reports the
//! window as focused (G8 in the F4 patch ledger). Nothing outside this
//! process is queried, so no accessibility permission is needed. Each
//! reading is a line of JSON; the window closes by itself after about two
//! seconds. Results: docs/rust-rewrite/foundations/f4c-input.md, "测量".
//!
//! ```text
//! cargo run -p gpui-prose --example a11y-probe
//! cargo run -p gpui-prose --example a11y-probe -- --stock-cache   # without the workaround
//! ```
//!
//! `--stock-cache` embeds the editor as a plain cached view, as GPUI v1.27
//! would without gpui-prose's workaround (`input::a11y::editor_view`).

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("a11y-probe reads the macOS accessibility objects; it runs on macOS only");
}

#[cfg(target_os = "macos")]
fn main() {
    probe::run();
}

#[cfg(target_os = "macos")]
mod probe {
    use std::{ffi::CStr, time::Duration};

    use gpui::{
        App, AppContext, Bounds, Context, Entity, Focusable, IntoElement, ParentElement, Render,
        StyleRefinement, Styled, Window, WindowBounds, WindowOptions, div, px, size,
    };
    use gpui_prose::{BlockKind, Book, Chapter, ProseDoc, ProseEditor, ProseStyle};
    use objc2::{Encode, Encoding, msg_send, runtime::AnyObject};
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    #[repr(C)]
    #[derive(Clone, Copy, Debug, PartialEq)]
    struct NSRange {
        location: usize,
        length: usize,
    }

    // SAFETY: matches Foundation's `struct _NSRange { NSUInteger; NSUInteger; }`.
    unsafe impl Encode for NSRange {
        const ENCODING: Encoding =
            Encoding::Struct("_NSRange", &[usize::ENCODING, usize::ENCODING]);
    }

    #[repr(C)]
    #[derive(Clone, Copy, Debug, PartialEq)]
    struct CGRect {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    }

    // SAFETY: matches CoreGraphics' `struct CGRect { CGPoint; CGSize; }`.
    unsafe impl Encode for CGRect {
        const ENCODING: Encoding = Encoding::Struct(
            "CGRect",
            &[
                Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]),
                Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]),
            ],
        );
    }

    struct Probe {
        editor: Entity<ProseEditor>,
        stock_cache: bool,
        ticks: usize,
    }

    impl Render for Probe {
        fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            let layer = self.editor.read(cx).cursor_layer();
            let editor = if self.stock_cache {
                div()
                    .size_full()
                    .relative()
                    .child(
                        self.editor
                            .clone()
                            .cached(StyleRefinement::default().size_full()),
                    )
                    .child(layer)
                    .into_any_element()
            } else {
                ProseEditor::element(&self.editor, cx).into_any_element()
            };
            div()
                .size_full()
                .child(div().h(px(20.)).child(format!("tick {}", self.ticks)))
                .child(editor)
        }
    }

    /// An `NSString` as Rust text.
    unsafe fn string(object: *mut AnyObject) -> Option<String> {
        if object.is_null() {
            return None;
        }
        let utf8: *const std::ffi::c_char = unsafe { msg_send![object, UTF8String] };
        (!utf8.is_null()).then(|| {
            unsafe { CStr::from_ptr(utf8) }
                .to_string_lossy()
                .into_owned()
        })
    }

    unsafe fn children(element: *mut AnyObject) -> Vec<*mut AnyObject> {
        let array: *mut AnyObject = unsafe { msg_send![element, accessibilityChildren] };
        if array.is_null() {
            return Vec::new();
        }
        let count: usize = unsafe { msg_send![array, count] };
        (0..count)
            .map(|ix| unsafe { msg_send![array, objectAtIndex: ix] })
            .collect()
    }

    unsafe fn role(element: *mut AnyObject) -> Option<String> {
        unsafe { string(msg_send![element, accessibilityRole]) }
    }

    /// The first element with role `wanted` under `element`.
    unsafe fn find(element: *mut AnyObject, wanted: &str, depth: usize) -> Option<*mut AnyObject> {
        if unsafe { role(element) }.as_deref() == Some(wanted) {
            return Some(element);
        }
        if depth == 0 {
            return None;
        }
        unsafe { children(element) }
            .into_iter()
            .find_map(|child| unsafe { find(child, wanted, depth - 1) })
    }

    /// The window's content view, which AccessKit's adapter subclasses.
    fn content_view(window: &Window) -> *mut AnyObject {
        let view = match HasWindowHandle::window_handle(window).map(|h| h.as_raw()) {
            Ok(RawWindowHandle::AppKit(appkit)) => appkit.ns_view.as_ptr() as *mut AnyObject,
            _ => panic!("not an AppKit window"),
        };
        // SAFETY: GPUI's own view, on the main thread.
        unsafe {
            let ns_window: *mut AnyObject = msg_send![view, window];
            msg_send![ns_window, contentView]
        }
    }

    /// The roles under `element`, indented, for a reading that found no
    /// text area.
    unsafe fn dump(element: *mut AnyObject, depth: usize, out: &mut Vec<String>) {
        out.push(format!(
            "{}{}",
            "  ".repeat(3 - depth),
            unsafe { role(element) }.unwrap_or_default()
        ));
        if depth > 0 {
            for child in unsafe { children(element) } {
                unsafe { dump(child, depth - 1, out) };
            }
        }
    }

    /// One reading of the text area, printed as a line of JSON.
    fn report(step: &str, window: &Window) {
        let view = content_view(window);
        // SAFETY: AppKit and AccessKit objects on the main thread, messages
        // of the NSAccessibility protocol they implement.
        unsafe {
            let Some(area) = find(view, "AXTextArea", 6) else {
                let mut roles = Vec::new();
                dump(view, 3, &mut roles);
                println!(
                    r#"{{"step":"{step}","text_area":false,"a11y_active":{},"roles":{roles:?}}}"#,
                    window.is_a11y_active()
                );
                return;
            };
            let label = string(msg_send![area, accessibilityTitle]).unwrap_or_default();
            let count: isize = msg_send![area, accessibilityNumberOfCharacters];
            let selected: NSRange = msg_send![area, accessibilitySelectedTextRange];
            let line: isize = msg_send![area, accessibilityInsertionPointLineNumber];
            let head = NSRange {
                location: 0,
                length: (count as usize).min(12),
            };
            let text =
                string(msg_send![area, accessibilityStringForRange: head]).unwrap_or_default();
            let selected_text =
                string(msg_send![area, accessibilitySelectedText]).unwrap_or_default();
            // Lines as the screen reader counts them (screen rows since F4b),
            // and the screen frame of the character after the caret.
            let last_line: isize = msg_send![area, accessibilityLineForIndex: (count - 1).max(0)];
            let probe_range = NSRange {
                location: selected.location,
                length: 1,
            };
            let char_frame: CGRect = msg_send![area, accessibilityFrameForRange: probe_range];
            let ns_window: *mut AnyObject = msg_send![view, window];
            let key: bool = msg_send![ns_window, isKeyWindow];
            // What VoiceOver asks: the application's focused element (AppKit
            // goes through the key window's first responder).
            let app: *mut AnyObject = msg_send![objc2::class!(NSApplication), sharedApplication];
            let focused: *mut AnyObject = msg_send![app, accessibilityFocusedUIElement];
            let focused_role = if focused.is_null() {
                String::new()
            } else {
                role(focused).unwrap_or_default()
            };
            // What the adapter itself reports as focused.
            let adapter_focus: *mut AnyObject = msg_send![view, accessibilityFocusedUIElement];
            let adapter_focus = if adapter_focus.is_null() {
                "null".to_owned()
            } else {
                role(adapter_focus).unwrap_or_default()
            };
            let responder: *mut AnyObject = msg_send![ns_window, firstResponder];
            let responder_is_content_view = responder == view;
            println!(
                "{{\"step\":{step:?},\"text_area\":true,\"label\":{label:?},\"characters\":{count},\
                 \"start\":{text:?},\"selected\":[{},{}],\"selected_text\":{selected_text:?},\
                 \"line\":{line},\"last_line\":{last_line},\
                 \"char_frame\":[{:.0},{:.0},{:.0},{:.0}],\
                 \"key_window\":{key},\"app_focused_role\":{focused_role:?},\
                 \"adapter_focused_role\":{adapter_focus:?},\
                 \"first_responder_is_content_view\":{responder_is_content_view},\
                 \"gpui_focus_role\":{:?}}}",
                selected.location,
                selected.length,
                char_frame.x,
                char_frame.y,
                char_frame.width,
                char_frame.height,
                gpui_focus_role(window)
            );
        }
    }

    /// The role of the node GPUI reported as focused in its last tree.
    fn gpui_focus_role(window: &Window) -> String {
        let Some(json) = window.debug_a11y_tree_json() else {
            return String::new();
        };
        let field = |text: &str, key: &str| -> Option<String> {
            let at = text.find(&format!("\"{key}\": \""))? + key.len() + 5;
            Some(text[at..].split('"').next()?.to_owned())
        };
        let Some(id) = field(&json, "gpui_focus") else {
            return String::new();
        };
        let Some(at) = json.find(&format!("\"{id}\": {{")) else {
            return String::new();
        };
        field(&json[at..], "role").unwrap_or_default()
    }

    fn set_selected_range(window: &Window, range: NSRange) {
        let view = content_view(window);
        // SAFETY: as in `report`.
        unsafe {
            if let Some(area) = find(view, "AXTextArea", 6) {
                let _: () = msg_send![area, setAccessibilitySelectedTextRange: range];
            }
        }
    }

    pub fn run() {
        let stock_cache = std::env::args().any(|a| a == "--stock-cache");
        gpui_platform::application().run(move |cx: &mut App| {
            gpui_prose::bind_keys(cx);
            let doc = ProseDoc::from_paragraphs([
                (BlockKind::H1, "第一章　雨夜"),
                (BlockKind::Body, "天色将晚，雨还没有停。"),
                (BlockKind::Body, "她把伞靠在门边。"),
                (
                    BlockKind::Body,
                    "“你来了”这句话在嘴边转了几圈，终于没有说出口。窗外的雨一阵紧一阵慢，屋里只听得见钟摆的声音，她数着，数到第三十下的时候，门开了。",
                ),
            ]);
            let book = Book::new(vec![Chapter {
                title: "雨夜".into(),
                doc,
            }]);
            let bounds = Bounds::centered(None, size(px(520.), px(320.)), cx);
            let handle = cx
                .open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(bounds)),
                        ..Default::default()
                    },
                    |window, cx| {
                        let editor =
                            cx.new(|cx| ProseEditor::new(book, ProseStyle::default(), window, cx));
                        let focus = editor.read(cx).focus_handle(cx);
                        window.focus(&focus, cx);
                        cx.new(|_| Probe {
                            editor,
                            stock_cache,
                            ticks: 0,
                        })
                    },
                )
                .expect("open the window");
            cx.activate(true);
            println!(
                r#"{{"mode":{:?}}}"#,
                if stock_cache {
                    "stock-cache"
                } else {
                    "gpui-prose"
                }
            );
            cx.spawn(async move |cx| {
                let executor = cx.background_executor().clone();
                let pause = |ms| executor.timer(Duration::from_millis(ms));
                pause(300).await;
                // What VoiceOver does first: ask the view for its children.
                handle
                    .update(cx, |_, window, _| {
                        let view = content_view(window);
                        // SAFETY: as in `report`.
                        unsafe { children(view) };
                    })
                    .ok();
                pause(300).await;
                handle
                    .update(cx, |_, window, _| report("activated", window))
                    .ok();
                // Something else in the window redraws; the editor does not.
                for _ in 0..3 {
                    handle
                        .update(cx, |probe, _, cx| {
                            probe.ticks += 1;
                            cx.notify();
                        })
                        .ok();
                    pause(100).await;
                }
                handle
                    .update(cx, |_, window, _| report("after_other_redraws", window))
                    .ok();
                // The author moves the caret.
                handle
                    .update(cx, |probe, window, cx| {
                        probe
                            .editor
                            .update(cx, |editor, cx| editor.select(0, 9..12, window, cx));
                    })
                    .ok();
                pause(200).await;
                handle
                    .update(cx, |_, window, _| report("after_select", window))
                    .ok();
                // VoiceOver moves the caret.
                handle
                    .update(cx, |_, window, _| {
                        set_selected_range(
                            window,
                            NSRange {
                                location: 18,
                                length: 0,
                            },
                        )
                    })
                    .ok();
                pause(200).await;
                handle
                    .update(cx, |probe, window, cx| {
                        let sel = probe.editor.read(cx).selection();
                        println!(
                            r#"{{"step":"set_by_screen_reader","editor_selection":[{},{}]}}"#,
                            sel.anchor, sel.head
                        );
                        report("after_set_by_screen_reader", window);
                    })
                    .ok();
                // Diagnosis: AppKit answers "which element has focus" from
                // the first responder, which is GPUI's own view, while
                // AccessKit subclassed the window's content view. Make the
                // content view first responder for one reading, then put
                // GPUI's view back.
                handle
                    .update(cx, |_, window, _| {
                        let content = content_view(window);
                        let gpui_view =
                            match HasWindowHandle::window_handle(&*window).map(|h| h.as_raw()) {
                                Ok(RawWindowHandle::AppKit(appkit)) => {
                                    appkit.ns_view.as_ptr() as *mut AnyObject
                                }
                                _ => return,
                            };
                        // SAFETY: as in `report`.
                        unsafe {
                            let ns_window: *mut AnyObject = msg_send![content, window];
                            let _: bool = msg_send![ns_window, makeFirstResponder: content];
                            report("content_view_first_responder", window);
                            let _: bool = msg_send![ns_window, makeFirstResponder: gpui_view];
                        }
                    })
                    .ok();
                handle
                    .update(cx, |_, window, _| window.remove_window())
                    .ok();
                cx.update(|cx| cx.quit());
            })
            .detach();
        });
    }
}
