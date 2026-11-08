//! The colour swatch (the 0.1 client's `ColorPicker`, `ui-swatch`): any
//! colour the author picks (a storyline's, a category's, the accent, the
//! caret) shows as a round glass button 28 px across holding one seal of
//! that colour, or the kind's own sand mark in it ([`ColorSwatch::mark`]).
//! The value can be written beside it in index type, `#RRGGBB`.
//!
//! A click opens the system's colour picker, as the 0.1 client's
//! `<input type="color">` did: on macOS the shared colour panel (its wheel,
//! sliders and palettes; it stays open and the colour follows it while the
//! author drags), on Windows the system's colour dialog. The picked colour
//! comes back through [`ColorSwatch::on_pick`] on the main thread.
//!
//! GPUI has no call for either, so these are made here on the window's own
//! platform handle (as `input::ime` does for the input method). A window
//! without one (GPUI's test platform) opens nothing; tests and other hosts
//! put their own picker in with [`set_color_picker`].

use std::{cell::Cell, rc::Rc};

use gpui::{
    App, ElementId, Global, IntoElement, ParentElement as _, RenderOnce, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window, canvas, div, prelude::FluentBuilder as _,
    px,
};

use crate::{
    fonts::Role,
    glass::{self, Kind as GlassKind, Mode, Spec, Tone},
    sand::{self, Kind, KindMark, SandMask},
    style::DrStyled as _,
    theme::Theme,
    tokens::color::Rgb,
};

/// The swatch's size, and its seal's.
pub const SWATCH: f32 = 28.0;
const SEAL: f32 = 16.0;

/// What a picked colour is handed to.
pub type OnPick = Rc<dyn Fn(Rgb, &mut Window, &mut App)>;

/// Opens a colour picker on `current`; calls the [`OnPick`] with each colour
/// picked (as many times as the author changes it while it is open).
pub type Picker = Rc<dyn Fn(Rgb, OnPick, &mut Window, &mut App)>;

struct PickerHook(Picker);

impl Global for PickerHook {}

/// Has every swatch open `picker` instead of the system's colour picker
/// (tests, a host with a picker of its own).
pub fn set_color_picker(
    cx: &mut App,
    picker: impl Fn(Rgb, OnPick, &mut Window, &mut App) + 'static,
) {
    cx.set_global(PickerHook(Rc::new(picker)));
}

/// Opens the colour picker on `current`, as a click on a swatch does.
pub fn pick(current: Rgb, on_pick: OnPick, window: &mut Window, cx: &mut App) {
    match cx.try_global::<PickerHook>() {
        Some(hook) => (hook.0.clone())(current, on_pick, window, cx),
        None => system::pick(current, on_pick, window, cx),
    }
}

/// `#rrggbb`, as storylines and categories store their colour.
pub fn hex(color: Rgb) -> String {
    let channel = |c: f32| (c.clamp(0.0, 1.0) * 255.0).round() as u8;
    format!(
        "#{:02x}{:02x}{:02x}",
        channel(color.r),
        channel(color.g),
        channel(color.b)
    )
}

/// `#rrggbb` (either case) to a colour.
pub fn parse_hex(text: &str) -> Option<Rgb> {
    let digits = text.trim().strip_prefix('#')?;
    if digits.len() != 6 || !digits.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    u32::from_str_radix(digits, 16).ok().map(Rgb::hex)
}

#[derive(IntoElement)]
pub struct ColorSwatch {
    id: ElementId,
    color: Rgb,
    mark: Option<Kind>,
    value: bool,
    label: SharedString,
    disabled: bool,
    on_pick: Option<OnPick>,
}

impl ColorSwatch {
    pub fn new(id: impl Into<ElementId>, color: Rgb) -> ColorSwatch {
        ColorSwatch {
            id: id.into(),
            color,
            mark: None,
            value: false,
            label: SharedString::default(),
            disabled: false,
            on_pick: None,
        }
    }

    /// The kind's own sand mark in the colour instead of a seal (a
    /// storyline's dash, a category's corner, a kind's link colour).
    pub fn mark(mut self, kind: Kind) -> Self {
        self.mark = Some(kind);
        self
    }

    /// `#RRGGBB` beside the swatch in index type.
    pub fn show_value(mut self) -> Self {
        self.value = true;
        self
    }

    /// What the swatch is the colour of, for the screen reader.
    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = label.into();
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// Called with each colour picked.
    pub fn on_pick(mut self, f: impl Fn(Rgb, &mut Window, &mut App) + 'static) -> Self {
        self.on_pick = Some(Rc::new(f));
        self
    }
}

impl RenderOnce for ColorSwatch {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let color = self.color;
        let seal = match self.mark {
            Some(kind) => KindMark::new(ElementId::Name(format!("{}-mark", self.id).into()), kind)
                .color(color)
                .scale(SEAL / 14.0)
                .into_any_element(),
            None => canvas(
                |_, _, _| (),
                move |bounds, _, window, cx| {
                    let p = Theme::of(window, cx).palette;
                    let ink = sand::sand_color(p, color).solid();
                    sand::paint_mask(SandMask::Blob2, bounds, ink, window, cx);
                },
            )
            .size(px(SEAL))
            .into_any_element(),
        };
        let mode = Mode {
            disabled: self.disabled,
            ..Mode::default()
        };
        let on_pick = self.on_pick.clone();
        let swatch = glass::glass_box(
            self.id.clone(),
            GlassKind::Rest,
            mode,
            false,
            Spec::new(Tone::Clear, SWATCH / 2.0),
            window,
            cx,
        )
        .flex_none()
        .size(px(SWATCH))
        .rounded(px(SWATCH / 2.0))
        .flex()
        .items_center()
        .justify_center()
        .role(gpui::Role::Button)
        .aria_label(self.label.clone())
        .child(seal)
        .when(!self.disabled, |el| {
            el.cursor_pointer().on_click(move |_, window, cx| {
                let on_pick = on_pick.clone().unwrap_or_else(|| Rc::new(|_, _, _| {}));
                pick(color, on_pick, window, cx);
            })
        });
        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .child(swatch)
            .when(self.value, |el| {
                el.child(
                    div()
                        .min_w(px(58.0))
                        .font_role(Role::Index)
                        .type_px(s.caption, s.line_caption)
                        .text_color(p.muted().solid())
                        .child(hex(color).to_uppercase()),
                )
            })
    }
}

// Turns of the picker: a newer one (another swatch) ends the older one's
// delivery.
thread_local! {
    static TURN: Cell<u64> = const { Cell::new(0) };
}

fn next_turn() -> u64 {
    TURN.with(|t| {
        t.set(t.get() + 1);
        t.get()
    })
}

fn turn() -> u64 {
    TURN.with(Cell::get)
}

#[cfg(target_os = "macos")]
mod system {
    //! `NSColorPanel`: the shared panel, its target an object of a small
    //! class made at run time whose `colorChanged:` keeps the latest colour
    //! (in sRGB); the window's task hands it on while the panel is open.

    use std::{cell::Cell, time::Duration};

    use gpui::{App, Window};
    use objc2::{
        class, msg_send,
        runtime::{AnyClass, AnyObject, ClassBuilder, Sel},
        sel,
    };

    use super::{OnPick, next_turn, turn};
    use crate::tokens::color::Rgb;

    /// How often the open panel's colour is looked at.
    const POLL: Duration = Duration::from_millis(50);

    thread_local! {
        static TARGET: Cell<*mut AnyObject> = const { Cell::new(std::ptr::null_mut()) };
        static PICKED: Cell<Option<Rgb>> = const { Cell::new(None) };
    }

    extern "C-unwind" fn color_changed(_this: &AnyObject, _cmd: Sel, sender: *mut AnyObject) {
        if sender.is_null() {
            return;
        }
        // SAFETY: AppKit sends this on the main thread with the colour
        // panel as the sender; every message here is NSColorPanel's,
        // NSColor's or NSColorSpace's own.
        unsafe {
            let color: *mut AnyObject = msg_send![sender, color];
            if color.is_null() {
                return;
            }
            let space: *mut AnyObject = msg_send![class!(NSColorSpace), sRGBColorSpace];
            let srgb: *mut AnyObject = msg_send![color, colorUsingColorSpace: space];
            if srgb.is_null() {
                return;
            }
            let r: f64 = msg_send![srgb, redComponent];
            let g: f64 = msg_send![srgb, greenComponent];
            let b: f64 = msg_send![srgb, blueComponent];
            PICKED.with(|p| p.set(Some(Rgb::new(r as f32, g as f32, b as f32))));
        }
    }

    /// The panel's target, made once and kept (the panel does not retain
    /// its target).
    fn target() -> *mut AnyObject {
        TARGET.with(|t| {
            if t.get().is_null() {
                let class = AnyClass::get(c"DrColorPanelTarget").unwrap_or_else(|| {
                    let mut builder = ClassBuilder::new(c"DrColorPanelTarget", class!(NSObject))
                        .expect("a class of that name is made only here");
                    // SAFETY: `colorChanged:` takes one object (the sender)
                    // and returns nothing, as the function does.
                    unsafe {
                        builder.add_method(
                            sel!(colorChanged:),
                            color_changed as extern "C-unwind" fn(_, _, _),
                        );
                    }
                    builder.register()
                });
                // SAFETY: a plain NSObject subclass, made with `new` and
                // never released (one for the life of the app).
                let object: *mut AnyObject = unsafe { msg_send![class, new] };
                t.set(object);
            }
            t.get()
        })
    }

    fn panel() -> *mut AnyObject {
        // SAFETY: AppKit's shared colour panel, on the main thread.
        unsafe { msg_send![class!(NSColorPanel), sharedColorPanel] }
    }

    /// Whether `window` is an AppKit window (not GPUI's test platform's).
    fn on_appkit(window: &Window) -> bool {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        HasWindowHandle::window_handle(window)
            .is_ok_and(|h| matches!(h.as_raw(), RawWindowHandle::AppKit(_)))
    }

    pub fn pick(current: Rgb, on_pick: OnPick, window: &mut Window, cx: &mut App) {
        if !on_appkit(window) {
            return;
        }
        let me = next_turn();
        PICKED.with(|p| p.set(None));
        let panel = panel();
        // SAFETY: NSColorPanel's own messages on the main thread; the
        // target is detached while the colour is set so the swatch that had
        // the panel before hears nothing of it.
        unsafe {
            let none: *mut AnyObject = std::ptr::null_mut();
            let _: () = msg_send![panel, setTarget: none];
            let _: () = msg_send![panel, setShowsAlpha: false];
            let _: () = msg_send![panel, setContinuous: true];
            let color: *mut AnyObject = msg_send![
                class!(NSColor),
                colorWithSRGBRed: current.r as f64,
                green: current.g as f64,
                blue: current.b as f64,
                alpha: 1.0f64
            ];
            let _: () = msg_send![panel, setColor: color];
            let _: () = msg_send![panel, setTarget: target()];
            let _: () = msg_send![panel, setAction: sel!(colorChanged:)];
            let _: () = msg_send![panel, orderFront: none];
        }
        window
            .spawn(cx, async move |cx| {
                loop {
                    cx.background_executor().timer(POLL).await;
                    if turn() != me {
                        return;
                    }
                    if let Some(color) = PICKED.with(|p| p.take()) {
                        let on_pick = on_pick.clone();
                        if cx.update(|window, cx| on_pick(color, window, cx)).is_err() {
                            return;
                        }
                    }
                    // SAFETY: on the main thread (the window's task).
                    let open: bool = unsafe { msg_send![panel, isVisible] };
                    if !open {
                        return;
                    }
                }
            })
            .detach();
    }
}

#[cfg(windows)]
mod system {
    //! `ChooseColorW`: the system's colour dialog, owned by the window and
    //! run on a thread of its own (as GPUI runs the file dialogs) so the
    //! window's messages keep going; the colour comes back once it closes.
    //! The sixteen custom colours are kept for the session.

    use std::sync::Mutex;

    use gpui::{App, Window};

    use super::{OnPick, next_turn, turn};
    use crate::tokens::color::Rgb;

    static CUSTOM: Mutex<[u32; 16]> = Mutex::new([0x00ff_ffff; 16]);

    fn choose(owner: isize, current: Rgb) -> Option<Rgb> {
        use windows::Win32::{
            Foundation::{COLORREF, HWND},
            UI::Controls::Dialogs::{CC_FULLOPEN, CC_RGBINIT, CHOOSECOLORW, ChooseColorW},
        };
        let channel = |c: f32| (c.clamp(0.0, 1.0) * 255.0).round() as u32;
        // COLORREF is 0x00bbggrr.
        let bgr = channel(current.r) | channel(current.g) << 8 | channel(current.b) << 16;
        let mut custom = CUSTOM.lock().map(|c| *c).unwrap_or([0x00ff_ffff; 16]);
        let mut slots: Vec<COLORREF> = custom.iter().map(|&c| COLORREF(c)).collect();
        let mut dialog = CHOOSECOLORW {
            lStructSize: std::mem::size_of::<CHOOSECOLORW>() as u32,
            hwndOwner: HWND(owner as *mut _),
            rgbResult: COLORREF(bgr),
            lpCustColors: slots.as_mut_ptr(),
            Flags: CC_RGBINIT | CC_FULLOPEN,
            ..Default::default()
        };
        // SAFETY: the structure and the sixteen slots live across the call.
        let picked = unsafe { ChooseColorW(&mut dialog) }.as_bool();
        for (keep, slot) in custom.iter_mut().zip(&slots) {
            *keep = slot.0;
        }
        if let Ok(mut c) = CUSTOM.lock() {
            *c = custom;
        }
        picked.then(|| {
            let v = dialog.rgbResult.0;
            Rgb::new(
                (v & 0xff) as f32 / 255.0,
                ((v >> 8) & 0xff) as f32 / 255.0,
                ((v >> 16) & 0xff) as f32 / 255.0,
            )
        })
    }

    pub fn pick(current: Rgb, on_pick: OnPick, window: &mut Window, cx: &mut App) {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        let Ok(handle) = HasWindowHandle::window_handle(window) else {
            return;
        };
        let RawWindowHandle::Win32(win32) = handle.as_raw() else {
            return;
        };
        let owner = win32.hwnd.get();
        let me = next_turn();
        let task = cx.background_spawn(async move { choose(owner, current) });
        window
            .spawn(cx, async move |cx| {
                if let Some(color) = task.await
                    && turn() == me
                {
                    cx.update(|window, cx| on_pick(color, window, cx)).ok();
                }
            })
            .detach();
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod system {
    use gpui::{App, Window};

    use super::OnPick;
    use crate::tokens::color::Rgb;

    /// Elsewhere there is no system picker to open yet.
    pub fn pick(_: Rgb, _: OnPick, _: &mut Window, _: &mut App) {
        let _ = (super::next_turn, super::turn);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colours_go_to_hex_and_back() {
        assert_eq!(hex(Rgb::hex(0x3a6f9c)), "#3a6f9c");
        assert_eq!(hex(Rgb::new(1.2, -0.1, 0.5)), "#ff0080");
        assert_eq!(parse_hex("#3A6F9C").map(hex).as_deref(), Some("#3a6f9c"));
        assert_eq!(parse_hex(" #ffffff ").map(hex).as_deref(), Some("#ffffff"));
        for bad in ["", "#fff", "3a6f9c", "#3a6f9g", "#3a6f9c0"] {
            assert!(parse_hex(bad).is_none(), "{bad}");
        }
    }
}
