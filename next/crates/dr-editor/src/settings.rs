//! The editor's settings, keyed as the shell's settings registry keys them.
//!
//! `dr-editor` does not depend on `dr-shell` (the shell embeds the editor), so
//! the shell hands the values over:
//!
//! ```ignore
//! let settings = EditorSettings::from_values(|key| Some(Settings::read(cx).get(key)));
//! chapter_editor.update(cx, |e, cx| e.set_settings(settings, cx));
//! ```

use gpui::px;
use gpui_prose::ProseStyle;
use serde_json::Value;

pub const FONT_SIZE: &str = "editor.font_size";
pub const LINE_HEIGHT: &str = "editor.line_height";
pub const PARAGRAPH_SPACING: &str = "editor.paragraph_spacing";
pub const PAGE_WIDTH: &str = "editor.page_width";
pub const PARAGRAPH_INDENT: &str = "editor.paragraph_indent";
pub const TYPEWRITER: &str = "editor.typewriter_mode";
/// 「自动要素链接」: names become entity links as the author types (the
/// 0.1 client's `autoEntityLinks`, on by default). Not in the shell's
/// registry yet (see m03-page.md).
pub const AUTO_ENTITY_LINKS: &str = "editor.auto_entity_links";
/// Justified rows (`ProseStyle::justify`), off by default.
pub const JUSTIFY: &str = "editor.justify";
/// Where the typewriter keeps the caret's row, a share of the view's height
/// (0.25–0.75; the 0.1 client's 输入行位置).
pub const TYPEWRITER_LINE: &str = "editor.typewriter_position";

/// Where typewriter scrolling holds the caret's row: the 0.1 client's
/// default (its setting ranged 25–75 % and is not in the registry yet).
pub const TYPEWRITER_POSITION: f32 = 0.5;

/// The 0.1 client's H1, H2 and H3 (28, 22 and 18 px) over its 17 px body, as
/// the shell's read-only page scales them.
pub const HEADING_SCALE: [f32; 3] = [28.0 / 17.0, 22.0 / 17.0, 18.0 / 17.0];

/// What the editor's settings say (defaults: the 0.1 client's).
#[derive(Clone, Debug, PartialEq)]
pub struct EditorSettings {
    /// Body text size, px.
    pub font_size: f32,
    /// Line height, a multiple of the size.
    pub line_height: f32,
    /// Space after a paragraph, em.
    pub paragraph_spacing: f32,
    /// Paper width, px.
    pub page_width: f32,
    /// First-line indent of body paragraphs, in characters (0, 1, 2).
    pub paragraph_indent: u8,
    /// Typewriter scrolling (the caret's row held at the middle of the view,
    /// the 0.1 client's default position).
    pub typewriter: bool,
    /// Automatic entity links while typing.
    pub auto_entity_links: bool,
    /// Justified rows.
    pub justify: bool,
    /// The typewriter's row, a share of the view's height.
    pub typewriter_position: f32,
}

impl Default for EditorSettings {
    fn default() -> Self {
        EditorSettings {
            font_size: 17.0,
            line_height: 1.5,
            paragraph_spacing: 1.0,
            page_width: 720.0,
            paragraph_indent: 0,
            typewriter: false,
            auto_entity_links: true,
            justify: false,
            typewriter_position: TYPEWRITER_POSITION,
        }
    }
}

impl EditorSettings {
    /// Reads every key through `get` (the shell's settings file); missing or
    /// malformed values keep their defaults, out-of-range numbers are clamped
    /// to the registry's ranges.
    pub fn from_values(get: impl Fn(&str) -> Option<Value>) -> EditorSettings {
        let d = EditorSettings::default();
        let num = |key: &str, min: f32, max: f32, default: f32| {
            get(key)
                .and_then(|v| v.as_f64())
                .map(|v| (v as f32).clamp(min, max))
                .unwrap_or(default)
        };
        EditorSettings {
            font_size: num(FONT_SIZE, 12.0, 28.0, d.font_size),
            line_height: num(LINE_HEIGHT, 1.0, 2.0, d.line_height),
            paragraph_spacing: num(PARAGRAPH_SPACING, 0.0, 2.5, d.paragraph_spacing),
            page_width: num(PAGE_WIDTH, 480.0, 1280.0, d.page_width),
            paragraph_indent: match get(PARAGRAPH_INDENT).as_ref().and_then(Value::as_str) {
                Some("one") => 1,
                Some("two") => 2,
                _ => 0,
            },
            typewriter: get(TYPEWRITER)
                .and_then(|v| v.as_bool())
                .unwrap_or(d.typewriter),
            auto_entity_links: get(AUTO_ENTITY_LINKS)
                .and_then(|v| v.as_bool())
                .unwrap_or(d.auto_entity_links),
            justify: get(JUSTIFY).and_then(|v| v.as_bool()).unwrap_or(d.justify),
            // Stored as a percentage (the 0.1 client's 25–75 %).
            typewriter_position: num(TYPEWRITER_LINE, 25.0, 75.0, d.typewriter_position * 100.0)
                / 100.0,
        }
    }

    /// `base` with these settings applied (colours and fonts stay).
    pub fn style(&self, base: &ProseStyle) -> ProseStyle {
        self.style_for(base, false)
    }

    /// [`EditorSettings::style`], in immersive writing or not. Immersed,
    /// typewriter scrolling is on whatever its switch says, on the line the
    /// settings give (the 0.1 client's `typewriterMode || immersive`).
    pub fn style_for(&self, base: &ProseStyle, immersive: bool) -> ProseStyle {
        let mut style = base.clone();
        style.body_size = px(self.font_size);
        style.body_line_height = self.line_height;
        style.heading_sizes = HEADING_SCALE.map(|s| px((self.font_size * s).round()));
        style.paragraph_spacing = self.paragraph_spacing;
        style.max_width = px(self.page_width);
        style.first_line_indent = f32::from(self.paragraph_indent);
        style.typewriter = (self.typewriter || immersive).then_some(self.typewriter_position);
        style.justify = self.justify;
        style
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn values_are_read_clamped_and_defaulted() {
        let s = EditorSettings::from_values(|k| match k {
            FONT_SIZE => Some(json!(20)),
            LINE_HEIGHT => Some(json!(9.0)),
            PARAGRAPH_INDENT => Some(json!("two")),
            PAGE_WIDTH => Some(json!("wide")),
            _ => None,
        });
        assert_eq!(s.font_size, 20.0);
        assert_eq!(s.line_height, 2.0);
        assert_eq!(s.paragraph_indent, 2);
        assert_eq!(s.page_width, 720.0);
        let style = s.style(&ProseStyle::default());
        assert_eq!(style.heading_sizes[0], px((20.0f32 * 28.0 / 17.0).round()));
        // The first-line indent and typewriter scrolling reach the layout.
        assert_eq!(style.first_line_indent, 2.0);
        assert_eq!(style.typewriter, None);
        let s = EditorSettings::from_values(|k| match k {
            TYPEWRITER => Some(json!(true)),
            _ => None,
        });
        assert_eq!(s.style(&ProseStyle::default()).typewriter, Some(0.5));
        assert_eq!(s.style(&ProseStyle::default()).first_line_indent, 0.0);
    }

    #[test]
    fn justify_and_the_typewriter_line_reach_the_style() {
        let s = EditorSettings::from_values(|k| match k {
            TYPEWRITER => Some(json!(true)),
            TYPEWRITER_LINE => Some(json!(90)),
            JUSTIFY => Some(json!(true)),
            _ => None,
        });
        let style = s.style(&ProseStyle::default());
        assert_eq!(style.typewriter, Some(0.75), "kept between 25% and 75%");
        assert!(style.justify);
        let s = EditorSettings::from_values(|k| match k {
            TYPEWRITER_LINE => Some(json!(30)),
            _ => None,
        });
        assert_eq!(s.typewriter_position, 0.3);
        assert_eq!(s.style(&ProseStyle::default()).typewriter, None);
        assert!(!s.style(&ProseStyle::default()).justify);
    }
}
