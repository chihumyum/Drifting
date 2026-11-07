//! dr-ui: Drifting's design system on GPUI.
//!
//! One page of paper, two materials (docs/design-system/README.md): what the
//! hand presses is **glass** ([`glass`]), what the author leaves is **sand**
//! ([`sand`]), everything else is flat. This crate holds the tokens, the
//! bundled fonts, both materials, the components every view is built from,
//! and the transitions they share. The shell (F6) and every view use only
//! these.
//!
//! Set up once per app:
//!
//! ```ignore
//! gpui_platform::application()
//!     .with_assets(dr_ui::Assets::new())
//!     .run(|cx| {
//!         dr_ui::init(cx).expect("dr-ui fonts"); // or show the error
//!         // …
//!     });
//! ```
//!
//! See docs/rust-rewrite/foundations/f5-ui.md for the component list.

pub mod anim;
pub mod assets;
pub mod components;
pub mod fonts;
pub mod glass;
pub mod input;
pub mod sand;
pub mod style;
pub mod text;
pub mod theme;
pub mod tokens;
pub mod transitions;

pub use assets::Assets;
pub use theme::{Appearance, Theme, ThemeSettings};

use gpui::App;

/// Registers the fonts, the theme settings and the input's key bindings.
/// Call once at start. Fails when the fonts are missing (they are built,
/// not committed): the error says what to run. Nothing falls back to a
/// system face.
pub fn init(cx: &mut App) -> Result<(), fonts::FontsMissing> {
    let dir = fonts::register(cx)?;
    log::info!("dr-ui fonts from {}", dir.display());
    if cx.try_global::<ThemeSettings>().is_none() {
        cx.set_global(ThemeSettings::default());
    }
    cx.bind_keys(input::bindings());
    Ok(())
}
