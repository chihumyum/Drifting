//! The editor's settings, keyed as the shell's settings registry keys them.
//!
//! `dr-editor` does not depend on `dr-shell` (the shell embeds the editor), so
//! the shell hands the values over:
//!
//! ```ignore
//! let settings = EditorSettings::from_values(|key| Some(Settings::read(cx).get(key)));
//! chapter_editor.update(cx, |e, cx| e.set_settings(settings, cx));
//! ```

use std::collections::BTreeMap;

use gpui::{Hsla, px};
use gpui_prose::ProseStyle;
use serde_json::Value;

pub const FONT_SIZE: &str = "editor.font_size";
pub const LINE_HEIGHT: &str = "editor.line_height";
pub const PARAGRAPH_SPACING: &str = "editor.paragraph_spacing";
pub const PAGE_WIDTH: &str = "editor.page_width";
pub const PARAGRAPH_INDENT: &str = "editor.paragraph_indent";
pub const TYPEWRITER: &str = "editor.typewriter_mode";
/// 「自动要素链接」: names become entity links as the author types (the
/// 0.1 client's `autoEntityLinks`, on by default).
pub const AUTO_ENTITY_LINKS: &str = "editor.auto_entity_links";
/// Justified rows (`ProseStyle::justify`), off by default.
pub const JUSTIFY: &str = "editor.justify";
/// Where the typewriter keeps the caret's row, a share of the view's height
/// (0.25–0.75; the 0.1 client's 输入行位置).
pub const TYPEWRITER_LINE: &str = "editor.typewriter_position";
/// Prose font family (`None` / `""` / `"default"` uses the theme default).
pub const FONT_FAMILY: &str = "editor.font_family";
/// Custom caret colour (`#rrggbb`; `None` / `""` uses the theme accent).
pub const CARET_COLOR: &str = "editor.caret_color";
/// Tab indent width (1–4, default 2).
pub const TAB_INDENT_WIDTH: &str = "editor.tab_indent_width";
/// Text wrapping style (`"stable"` | `"pretty"`, default `"stable"`).
pub const TEXT_WRAP: &str = "editor.text_wrap";
/// Whether hovering/clicking entity links shows cards and opens targets.
pub const ENTITY_LINK_INTERACTIVE: &str = "editor.entity_link_interactive";
/// Whether comment highlights and ticks are visible in the editor.
pub const COMMENT_MARKS_VISIBLE: &str = "editor.comment_marks_visible";
/// How entity link colours are chosen (`"contextual"` | `"kind"` | `"hover"` | `"prose"`).
pub const ENTITY_LINK_COLOR_MODE: &str = "editor.entity_link_color_mode";
/// Which parts of an entity link are styled (`"both"` | `"band"` | `"text"`).
pub const ENTITY_LINK_HIGHLIGHT_MODE: &str = "editor.entity_link_highlight_mode";
/// Underline / band texture (`"wash"` | `"dots"`).
pub const ENTITY_LINK_BAND_STYLE: &str = "editor.entity_link_band_style";
/// Per-kind/template hex colour overrides for entity links (`{"entry_kind": "#rrggbb"}`).
pub const ENTITY_LINK_KIND_COLORS: &str = "editor.entity_link_kind_colors";
/// Independent switch for Agent prose edit reveal playback animation.
pub const AGENT_EDIT_REVEAL_ANIMATION: &str = "editor.agent_edit_reveal_animation";

/// How entity link colours are chosen in prose.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum EntityLinkColorMode {
    /// Theme link colour (default).
    #[default]
    Contextual,
    /// Coloured by entry / template / kind colour.
    Kind,
    /// Ordinary ink at rest; link colour/underline revealed on hover.
    Hover,
    /// Reads as ordinary prose text (still clickable if interactive).
    Prose,
}

impl EntityLinkColorMode {
    pub fn parse(s: &str) -> Self {
        match s {
            "kind" => Self::Kind,
            "hover" => Self::Hover,
            "prose" => Self::Prose,
            _ => Self::Contextual,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Contextual => "contextual",
            Self::Kind => "kind",
            Self::Hover => "hover",
            Self::Prose => "prose",
        }
    }
}

/// Whether entity links colour text, draw an underline/band, or both.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum EntityLinkHighlightMode {
    #[default]
    Both,
    Band,
    Text,
}

impl EntityLinkHighlightMode {
    pub fn parse(s: &str) -> Self {
        match s {
            "band" => Self::Band,
            "text" => Self::Text,
            _ => Self::Both,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Both => "both",
            Self::Band => "band",
            Self::Text => "text",
        }
    }

    pub fn styles_text(self) -> bool {
        matches!(self, Self::Both | Self::Text)
    }

    pub fn styles_band(self) -> bool {
        matches!(self, Self::Both | Self::Band)
    }
}

/// Visual style of the entity link underline/band.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum EntityLinkBandStyle {
    #[default]
    Wash,
    Dots,
}

impl EntityLinkBandStyle {
    pub fn parse(s: &str) -> Self {
        match s {
            "dots" => Self::Dots,
            _ => Self::Wash,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Wash => "wash",
            Self::Dots => "dots",
        }
    }
}

/// Bundled entity link appearance settings handed to `DriftingExtension` and `Layers`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LinkAppearance {
    pub color_mode: EntityLinkColorMode,
    pub highlight_mode: EntityLinkHighlightMode,
    pub band_style: EntityLinkBandStyle,
    pub kind_colors: BTreeMap<String, String>,
}

/// Parses a `#rrggbb` or `rrggbb` colour string into `Hsla`.
pub fn parse_hex_hsla(hex: &str) -> Option<Hsla> {
    let s = hex.trim().strip_prefix('#').unwrap_or(hex.trim());
    if s.len() != 6 {
        return None;
    }
    let val = u32::from_str_radix(s, 16).ok()?;
    Some(dr_ui::tokens::Rgb::hex(val).solid())
}

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
    /// Optional custom prose font family name.
    pub font_family: Option<String>,
    /// Optional custom caret colour (`#rrggbb`).
    pub caret_color: Option<String>,
    /// Tab indent width (1–4).
    pub tab_indent_width: u8,
    /// Whether hovering/clicking entity links opens cards & targets.
    pub entity_link_interactive: bool,
    /// Whether comment sand marks and ticks are displayed.
    pub comment_marks_visible: bool,
    /// Entity link visual appearance settings.
    pub entity_link_color_mode: EntityLinkColorMode,
    pub entity_link_highlight_mode: EntityLinkHighlightMode,
    pub entity_link_band_style: EntityLinkBandStyle,
    pub entity_link_kind_colors: BTreeMap<String, String>,
    /// Independent toggle for Agent edit reveal playback animation.
    pub agent_edit_reveal_animation: bool,
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
            font_family: None,
            caret_color: None,
            tab_indent_width: 2,
            entity_link_interactive: true,
            comment_marks_visible: true,
            entity_link_color_mode: EntityLinkColorMode::Contextual,
            entity_link_highlight_mode: EntityLinkHighlightMode::Both,
            entity_link_band_style: EntityLinkBandStyle::Wash,
            entity_link_kind_colors: BTreeMap::new(),
            agent_edit_reveal_animation: true,
        }
    }
}

impl EditorSettings {
    pub fn link_appearance(&self) -> LinkAppearance {
        LinkAppearance {
            color_mode: self.entity_link_color_mode,
            highlight_mode: self.entity_link_highlight_mode,
            band_style: self.entity_link_band_style,
            kind_colors: self.entity_link_kind_colors.clone(),
        }
    }

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
        let font_family = get(FONT_FAMILY)
            .as_ref()
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty() && *s != "default" && *s != "system-serif")
            .map(str::to_owned);
        let caret_color = get(CARET_COLOR)
            .as_ref()
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| parse_hex_hsla(s).is_some())
            .map(str::to_owned);
        let mut entity_link_kind_colors = BTreeMap::new();
        if let Some(map) = get(ENTITY_LINK_KIND_COLORS)
            .as_ref()
            .and_then(Value::as_object)
        {
            for (k, v) in map {
                if let Some(hex) = v.as_str().filter(|s| parse_hex_hsla(s).is_some()) {
                    entity_link_kind_colors.insert(k.clone(), hex.to_owned());
                }
            }
        }
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
            font_family,
            caret_color,
            tab_indent_width: num(TAB_INDENT_WIDTH, 1.0, 4.0, f32::from(d.tab_indent_width)).round()
                as u8,
            entity_link_interactive: get(ENTITY_LINK_INTERACTIVE)
                .and_then(|v| v.as_bool())
                .unwrap_or(d.entity_link_interactive),
            comment_marks_visible: get(COMMENT_MARKS_VISIBLE)
                .and_then(|v| v.as_bool())
                .unwrap_or(d.comment_marks_visible),
            entity_link_color_mode: get(ENTITY_LINK_COLOR_MODE)
                .as_ref()
                .and_then(Value::as_str)
                .map(EntityLinkColorMode::parse)
                .unwrap_or(d.entity_link_color_mode),
            entity_link_highlight_mode: get(ENTITY_LINK_HIGHLIGHT_MODE)
                .as_ref()
                .and_then(Value::as_str)
                .map(EntityLinkHighlightMode::parse)
                .unwrap_or(d.entity_link_highlight_mode),
            entity_link_band_style: get(ENTITY_LINK_BAND_STYLE)
                .as_ref()
                .and_then(Value::as_str)
                .map(EntityLinkBandStyle::parse)
                .unwrap_or(d.entity_link_band_style),
            entity_link_kind_colors,
            agent_edit_reveal_animation: get(AGENT_EDIT_REVEAL_ANIMATION)
                .and_then(|v| v.as_bool())
                .unwrap_or(d.agent_edit_reveal_animation),
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
        if let Some(ref family) = self.font_family {
            style.font_family = family.clone().into();
        }
        if let Some(cursor) = self.caret_color.as_deref().and_then(parse_hex_hsla) {
            style.cursor = cursor;
        }
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
