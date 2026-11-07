//! Light and dark: which one the window shows, and two placeholder palettes
//! that prove the switch. F5 (`dr-ui`) replaces the palettes with the design
//! tokens; the resolution rules stay.

use gpui::{App, Global, Rgba, WindowAppearance, rgb};

/// The appearance a view paints with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Appearance {
    Light,
    Dark,
}

impl Appearance {
    pub fn from_window(appearance: WindowAppearance) -> Self {
        match appearance {
            WindowAppearance::Light | WindowAppearance::VibrantLight => Self::Light,
            WindowAppearance::Dark | WindowAppearance::VibrantDark => Self::Dark,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Light => "light",
            Self::Dark => "dark",
        }
    }
}

/// The development switch: `DRIFTING_APPEARANCE=light|dark` forces one
/// appearance without touching the system setting.
pub const SWITCH_ENV: &str = "DRIFTING_APPEARANCE";

/// Whether the app follows the system or a forced appearance.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum AppearanceSetting {
    #[default]
    System,
    Forced(Appearance),
}

impl Global for AppearanceSetting {}

impl AppearanceSetting {
    /// Reads the switch. Unset, empty or `system` follows the system.
    pub fn parse(value: Option<&str>) -> Result<Self, String> {
        match value.map(str::trim) {
            None | Some("" | "system") => Ok(Self::System),
            Some("light") => Ok(Self::Forced(Appearance::Light)),
            Some("dark") => Ok(Self::Forced(Appearance::Dark)),
            Some(other) => Err(format!(
                "{SWITCH_ENV}={other:?} is not light, dark or system; following the system"
            )),
        }
    }

    pub fn from_env() -> Self {
        let value = std::env::var(SWITCH_ENV).ok();
        Self::parse(value.as_deref()).unwrap_or_else(|message| {
            log::warn!("{message}");
            Self::System
        })
    }

    /// The appearance to paint with. Where the switch is applied natively
    /// (macOS: the app's `NSAppearance`), it reaches the window exactly like a
    /// system change, so the window's own appearance is followed and the switch
    /// exercises the same observer and repaint path. Elsewhere the palette
    /// takes the forced value directly.
    pub fn resolve(self, window: WindowAppearance, applied_natively: bool) -> Appearance {
        match self {
            Self::Forced(forced) if !applied_natively => forced,
            Self::Forced(_) | Self::System => Appearance::from_window(window),
        }
    }

    pub fn describe(self) -> &'static str {
        match self {
            Self::System => "follows the system",
            Self::Forced(_) => "forced by DRIFTING_APPEARANCE",
        }
    }
}

/// Whether [`apply_natively`] does anything on this platform.
pub const APPLIED_NATIVELY: bool = cfg!(target_os = "macos");

/// Hands a forced appearance to the platform so native chrome (traffic
/// lights, menus, the About window) follows it too.
#[cfg(target_os = "macos")]
pub fn apply_natively(setting: AppearanceSetting) {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{
        NSAppearance, NSAppearanceNameAqua, NSAppearanceNameDarkAqua, NSApplication,
    };

    let Some(main_thread) = MainThreadMarker::new() else {
        log::error!("the appearance switch must run on the main thread");
        return;
    };
    let app = NSApplication::sharedApplication(main_thread);
    let appearance = match setting {
        AppearanceSetting::System => None,
        // SAFETY: AppKit's appearance names are immutable statics.
        AppearanceSetting::Forced(Appearance::Light) => {
            NSAppearance::appearanceNamed(unsafe { NSAppearanceNameAqua })
        }
        AppearanceSetting::Forced(Appearance::Dark) => {
            NSAppearance::appearanceNamed(unsafe { NSAppearanceNameDarkAqua })
        }
    };
    app.setAppearance(appearance.as_deref());
}

#[cfg(not(target_os = "macos"))]
pub fn apply_natively(_setting: AppearanceSetting) {}

/// The appearance a window paints with right now.
pub fn current(window: &gpui::Window, cx: &App) -> Appearance {
    let setting = cx
        .try_global::<AppearanceSetting>()
        .copied()
        .unwrap_or_default();
    setting.resolve(window.appearance(), APPLIED_NATIVELY)
}

/// Placeholder colours, one set per appearance.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Palette {
    pub background: Rgba,
    pub titlebar: Rgba,
    pub hairline: Rgba,
    pub text: Rgba,
    pub muted: Rgba,
    pub control_hover: Rgba,
    pub close_hover: Rgba,
}

impl Palette {
    pub fn for_appearance(appearance: Appearance) -> Self {
        match appearance {
            Appearance::Light => Self {
                background: rgb(0xf5f2eb),
                titlebar: rgb(0xebe6dc),
                hairline: rgb(0xd9d2c4),
                text: rgb(0x2b2925),
                muted: rgb(0x6f6a60),
                control_hover: rgb(0xddd7cb),
                close_hover: rgb(0xc42b1c),
            },
            Appearance::Dark => Self {
                background: rgb(0x1c1b19),
                titlebar: rgb(0x252421),
                hairline: rgb(0x3a3834),
                text: rgb(0xe9e5dc),
                muted: rgb(0x9a958b),
                control_hover: rgb(0x34322e),
                close_hover: rgb(0xc42b1c),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_window_appearance_maps_to_light_or_dark() {
        use WindowAppearance::*;
        assert_eq!(Appearance::from_window(Light), Appearance::Light);
        assert_eq!(Appearance::from_window(VibrantLight), Appearance::Light);
        assert_eq!(Appearance::from_window(Dark), Appearance::Dark);
        assert_eq!(Appearance::from_window(VibrantDark), Appearance::Dark);
    }

    #[test]
    fn the_switch_accepts_light_dark_and_system() {
        use AppearanceSetting::*;
        assert_eq!(AppearanceSetting::parse(None), Ok(System));
        assert_eq!(AppearanceSetting::parse(Some("")), Ok(System));
        assert_eq!(AppearanceSetting::parse(Some("system")), Ok(System));
        assert_eq!(
            AppearanceSetting::parse(Some(" dark ")),
            Ok(Forced(Appearance::Dark))
        );
        assert_eq!(
            AppearanceSetting::parse(Some("light")),
            Ok(Forced(Appearance::Light))
        );
        assert!(AppearanceSetting::parse(Some("sepia")).is_err());
    }

    #[test]
    fn the_system_appearance_wins_unless_the_switch_is_set() {
        let system = AppearanceSetting::System;
        let dark = AppearanceSetting::Forced(Appearance::Dark);
        assert_eq!(
            system.resolve(WindowAppearance::Dark, false),
            Appearance::Dark
        );
        // Not applied natively: the palette takes the forced value.
        assert_eq!(
            dark.resolve(WindowAppearance::Light, false),
            Appearance::Dark
        );
        // Applied natively: the window reports the forced appearance once
        // AppKit has delivered it, and the palette follows the window.
        assert_eq!(
            dark.resolve(WindowAppearance::Light, true),
            Appearance::Light
        );
        assert_eq!(dark.resolve(WindowAppearance::Dark, true), Appearance::Dark);
    }

    fn relative_luminance(colour: Rgba) -> f32 {
        let channel = |c: f32| {
            if c <= 0.039_28 {
                c / 12.92
            } else {
                ((c + 0.055) / 1.055).powf(2.4)
            }
        };
        0.2126 * channel(colour.r) + 0.7152 * channel(colour.g) + 0.0722 * channel(colour.b)
    }

    fn contrast(a: Rgba, b: Rgba) -> f32 {
        let (a, b) = (relative_luminance(a), relative_luminance(b));
        (a.max(b) + 0.05) / (a.min(b) + 0.05)
    }

    #[test]
    fn both_palettes_are_readable_and_distinct() {
        let light = Palette::for_appearance(Appearance::Light);
        let dark = Palette::for_appearance(Appearance::Dark);
        for palette in [light, dark] {
            assert!(contrast(palette.text, palette.background) >= 7.0);
            assert!(contrast(palette.muted, palette.background) >= 4.5);
            assert!(contrast(palette.text, palette.titlebar) >= 7.0);
        }
        assert!(relative_luminance(light.background) > relative_luminance(dark.background));
    }
}
