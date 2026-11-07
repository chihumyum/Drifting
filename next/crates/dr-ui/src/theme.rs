//! Which palette and type scale a window paints with.
//!
//! [`ThemeSettings`] is a global: an optional forced appearance (the
//! gallery's switch, the app's `DRIFTING_APPEARANCE`), the interface text
//! size and reduced motion. [`Theme::of`] resolves it against the window's
//! own appearance, so a forced switch never touches the system setting.

use gpui::{App, Global, Window, WindowAppearance};

use crate::tokens::{Palette, TextSize, TypeScale};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Appearance {
    #[default]
    Light,
    Dark,
}

impl Appearance {
    pub fn from_window(appearance: WindowAppearance) -> Appearance {
        match appearance {
            WindowAppearance::Light | WindowAppearance::VibrantLight => Appearance::Light,
            WindowAppearance::Dark | WindowAppearance::VibrantDark => Appearance::Dark,
        }
    }

    pub const fn palette(self) -> &'static Palette {
        match self {
            Appearance::Light => &Palette::LIGHT,
            Appearance::Dark => &Palette::DARK,
        }
    }

    pub const fn slug(self) -> &'static str {
        match self {
            Appearance::Light => "light",
            Appearance::Dark => "dark",
        }
    }
}

/// How the app wants to look, independent of any one window.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ThemeSettings {
    /// `None` follows the window (the system); `Some` forces one appearance.
    pub forced: Option<Appearance>,
    pub text_size: TextSize,
    /// Skip every movement straight to where it ends. `None` follows the
    /// platform (GPUI's `reduce_motion`).
    pub reduce_motion: Option<bool>,
}

impl Global for ThemeSettings {}

/// What a view paints with right now.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Theme {
    pub appearance: Appearance,
    pub palette: &'static Palette,
    pub scale: TypeScale,
    pub reduce_motion: bool,
}

impl Theme {
    pub fn of(window: &Window, cx: &App) -> Theme {
        let settings = cx
            .try_global::<ThemeSettings>()
            .copied()
            .unwrap_or_default();
        let appearance = settings
            .forced
            .unwrap_or_else(|| Appearance::from_window(window.appearance()));
        Theme {
            appearance,
            palette: appearance.palette(),
            scale: settings.text_size.scale(),
            reduce_motion: settings.reduce_motion.unwrap_or_else(|| cx.reduce_motion()),
        }
    }

    /// A theme without a window (tests, offscreen drawing).
    pub fn fixed(appearance: Appearance) -> Theme {
        Theme {
            appearance,
            palette: appearance.palette(),
            scale: TypeScale::STANDARD,
            reduce_motion: false,
        }
    }

    pub fn dark(&self) -> bool {
        self.palette.dark
    }
}

/// Forces `appearance` (or follows the window again with `None`) and
/// repaints every window.
pub fn force_appearance(appearance: Option<Appearance>, cx: &mut App) {
    let mut settings = cx
        .try_global::<ThemeSettings>()
        .copied()
        .unwrap_or_default();
    settings.forced = appearance;
    cx.set_global(settings);
    cx.refresh_windows();
}

pub fn set_text_size(size: TextSize, cx: &mut App) {
    let mut settings = cx
        .try_global::<ThemeSettings>()
        .copied()
        .unwrap_or_default();
    settings.text_size = size;
    cx.set_global(settings);
    cx.refresh_windows();
}
