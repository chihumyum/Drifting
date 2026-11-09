//! Platform font fallback order for Windows and macOS (M43, `docs/windows.md`).
//!
//! `dr-ui` bundles six static faces (`Drifting Sans` 400/500/600,
//! `Drifting Serif` 400/700, `Sarasa Mono SC` 400) built from Source Sans 3,
//! Newsreader, Noto Sans SC, Noto Serif SC and Sarasa Mono SC. On Windows, when
//! a character is outside the primary face or when system font stacks are
//! resolved for prose and interface text, the fallback order follows the
//! rules in `docs/windows.md`:
//!
//! - **Prose & structure serif**: falls back to the bundled `Drifting Serif`
//!   and `Noto Serif SC` before `SimSun` (`宋体`), so Chinese prose never
//!   degrades to bitmap-hinted SimSun unless a rare CJK extension character is
//!   absent from Noto Serif SC.
//! - **Interface sans**: falls back from `Drifting Sans` and `Noto Sans SC` to
//!   `Microsoft YaHei UI` and `Microsoft YaHei` (`微软雅黑`), never `SimSun`.
//! - **Index monospace**: falls back from `Sarasa Mono SC` to `Cascadia Mono`,
//!   `Consolas`, and `Microsoft YaHei UI`.

pub const BUNDLED_SANS: &str = "Drifting Sans";
pub const BUNDLED_SERIF: &str = "Drifting Serif";
pub const BUNDLED_MONO: &str = "Sarasa Mono SC";

/// Every bundled font file that `bundle-windows.ps1` / `drifting.nsi` and
/// `bundle-mac` place in the application's `fonts/` directory.
pub const BUNDLED_FACES: [&str; 6] = [
    "DriftingSans-Regular.ttf",
    "DriftingSans-Medium.ttf",
    "DriftingSans-SemiBold.ttf",
    "DriftingSerif-Regular.ttf",
    "DriftingSerif-Bold.ttf",
    "SarasaMonoSC-Regular.ttf",
];

/// Logical typography roles matching `dr_ui::fonts::Role`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FontRole {
    /// Interface controls, entity names, comments.
    Ui,
    /// Panel tabs, storylines, categories, acts, section titles.
    Structure,
    /// Counts, filters, states, metadata.
    Index,
    /// Manuscript body and headings.
    Prose,
}

impl FontRole {
    pub const fn primary_family(self) -> &'static str {
        match self {
            Self::Ui => BUNDLED_SANS,
            Self::Structure | Self::Prose => BUNDLED_SERIF,
            Self::Index => BUNDLED_MONO,
        }
    }
}

/// Windows fallback families in priority order (after `primary_family`),
/// following `docs/windows.md`.
pub const WINDOWS_UI_FALLBACKS: &[&str] = &[
    "Noto Sans SC",
    "Microsoft YaHei UI",
    "Microsoft YaHei",
    "Segoe UI",
    "SimHei",
];

/// Windows serif fallback families in priority order: bundled `Noto Serif SC`
/// always precedes `SimSun` (`docs/windows.md`).
pub const WINDOWS_SERIF_FALLBACKS: &[&str] =
    &["Noto Serif SC", "Songti SC", "SimSun", "Microsoft YaHei"];

/// Windows monospace fallback families in priority order.
pub const WINDOWS_MONO_FALLBACKS: &[&str] = &[
    "Cascadia Mono",
    "Consolas",
    "Microsoft YaHei UI",
    "Microsoft YaHei",
];

/// macOS fallback families in priority order.
pub const MACOS_UI_FALLBACKS: &[&str] = &["Noto Sans SC", "PingFang SC", "Hiragino Sans GB"];
pub const MACOS_SERIF_FALLBACKS: &[&str] = &["Noto Serif SC", "Songti SC", "STSong"];
pub const MACOS_MONO_FALLBACKS: &[&str] = &["Menlo", "PingFang SC"];

/// Returns the ordered Windows fallback list for `role` (excluding the primary
/// bundled family).
pub const fn windows_fallbacks_for(role: FontRole) -> &'static [&'static str] {
    match role {
        FontRole::Ui => WINDOWS_UI_FALLBACKS,
        FontRole::Structure | FontRole::Prose => WINDOWS_SERIF_FALLBACKS,
        FontRole::Index => WINDOWS_MONO_FALLBACKS,
    }
}

/// Returns the ordered macOS fallback list for `role` (excluding the primary
/// bundled family).
pub const fn macos_fallbacks_for(role: FontRole) -> &'static [&'static str] {
    match role {
        FontRole::Ui => MACOS_UI_FALLBACKS,
        FontRole::Structure | FontRole::Prose => MACOS_SERIF_FALLBACKS,
        FontRole::Index => MACOS_MONO_FALLBACKS,
    }
}

/// Returns the fallback list for the current target platform.
pub const fn fallbacks_for(role: FontRole) -> &'static [&'static str] {
    if cfg!(windows) {
        windows_fallbacks_for(role)
    } else {
        macos_fallbacks_for(role)
    }
}

/// Returns the complete ordered font stack (primary bundled family followed by
/// platform fallbacks) for `role`.
pub fn font_stack_for(role: FontRole, is_windows: bool) -> Vec<&'static str> {
    let fallbacks = if is_windows {
        windows_fallbacks_for(role)
    } else {
        macos_fallbacks_for(role)
    };
    let mut stack = Vec::with_capacity(1 + fallbacks.len());
    stack.push(role.primary_family());
    stack.extend_from_slice(fallbacks);
    stack
}

/// Resolves the first family in `role`'s stack that satisfies `covers_glyph`.
pub fn resolve_glyph_family(
    role: FontRole,
    is_windows: bool,
    mut covers_glyph: impl FnMut(&str) -> bool,
) -> Option<&'static str> {
    font_stack_for(role, is_windows)
        .into_iter()
        .find(|family| covers_glyph(family))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_prose_serif_falls_back_to_bundled_noto_serif_sc_before_simsun() {
        let stack = font_stack_for(FontRole::Prose, true);
        assert_eq!(stack[0], BUNDLED_SERIF);
        let noto_pos = stack
            .iter()
            .position(|&f| f == "Noto Serif SC")
            .expect("Noto Serif SC in Windows prose serif stack");
        let simsun_pos = stack
            .iter()
            .position(|&f| f == "SimSun")
            .expect("SimSun in Windows prose serif stack");
        assert!(
            noto_pos < simsun_pos,
            "Noto Serif SC ({noto_pos}) must precede SimSun ({simsun_pos}) on Windows"
        );

        // When a glyph is missing from the primary face but present in both
        // Noto Serif SC and SimSun, Windows resolves Noto Serif SC first.
        let picked = resolve_glyph_family(FontRole::Prose, true, |family| {
            matches!(family, "Noto Serif SC" | "SimSun")
        });
        assert_eq!(picked, Some("Noto Serif SC"));

        // Rare CJK extension glyph absent from Drifting Serif and Noto Serif SC
        // still reaches SimSun rather than rendering a tofu box.
        let rare = resolve_glyph_family(FontRole::Prose, true, |family| family == "SimSun");
        assert_eq!(rare, Some("SimSun"));
    }

    #[test]
    fn windows_ui_sans_names_microsoft_yahei_and_never_simsun() {
        let stack = font_stack_for(FontRole::Ui, true);
        assert_eq!(stack[0], BUNDLED_SANS);
        assert!(stack.contains(&"Noto Sans SC"));
        assert!(stack.contains(&"Microsoft YaHei"));
        assert!(
            !stack.contains(&"SimSun"),
            "interface sans must never fall back to SimSun"
        );

        let picked = resolve_glyph_family(FontRole::Ui, true, |family| {
            matches!(family, "Microsoft YaHei" | "SimHei")
        });
        assert_eq!(picked, Some("Microsoft YaHei"));
    }

    #[test]
    fn windows_index_mono_starts_with_sarasa_and_falls_back_to_cascadia_and_yahei() {
        let stack = font_stack_for(FontRole::Index, true);
        assert_eq!(stack[0], BUNDLED_MONO);
        assert!(stack.contains(&"Cascadia Mono"));
        assert!(stack.contains(&"Consolas"));
        assert!(stack.contains(&"Microsoft YaHei"));
    }
}
