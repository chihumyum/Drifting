//! The look of the prose and a few editor options.

use std::time::Duration;

use gpui::{Font, FontStyle, FontWeight, Hsla, Pixels, SharedString, font, hsla, px};

use crate::{layout::BlockMetrics, text::BlockKind};

/// Visual style of the prose. Defaults follow the current Drifting editor:
/// 17.5 px body at 1.75 line height, paragraph spacing 1.1 em, H1/H2/H3 at
/// 28/22/18 px weight 500.
#[derive(Clone, Debug, PartialEq)]
pub struct ProseStyle {
    pub font_family: SharedString,
    /// The face of code blocks (material notes).
    pub mono_family: SharedString,
    pub body_size: Pixels,
    pub body_line_height: f32,
    pub heading_sizes: [Pixels; 3],
    pub heading_line_height: f32,
    pub heading_weight: FontWeight,
    pub bold_weight: FontWeight,
    pub paragraph_spacing: f32,
    pub heading_space_above: f32,
    pub title_size: Pixels,
    pub max_width: Pixels,
    pub gutter: Pixels,
    pub text: Hsla,
    pub muted: Hsla,
    pub background: Hsla,
    pub selection: Hsla,
    pub cursor: Hsla,
    pub link: Hsla,
    /// First-line indent of body paragraphs, in ems of the body size (the
    /// editor setting: 0, 1 or 2). Headings are never indented.
    pub first_line_indent: f32,
    /// Justify: every row of a left-aligned paragraph but its last spans
    /// the column (spare width between characters, a hanging mark outside).
    pub justify: bool,
    /// Squeeze adjacent full-width punctuation (标点挤压: 「。」」 at 1.5 em).
    pub squeeze: bool,
    /// Typewriter scrolling: while the author types or moves the caret, its
    /// row stays at this fraction of the view's height (0.25–0.75; the old
    /// editor's default 0.5). `None`: the view scrolls only to keep the
    /// caret in sight.
    pub typewriter: Option<f32>,
}

impl Default for ProseStyle {
    fn default() -> Self {
        ProseStyle {
            font_family: "PingFang SC".into(),
            mono_family: "Menlo".into(),
            body_size: px(17.5),
            body_line_height: 1.75,
            heading_sizes: [px(28.), px(22.), px(18.)],
            heading_line_height: 1.4,
            heading_weight: FontWeight(500.),
            bold_weight: FontWeight::SEMIBOLD,
            paragraph_spacing: 1.1,
            heading_space_above: 0.8,
            title_size: px(30.),
            max_width: px(680.),
            gutter: px(48.),
            text: hsla(0., 0., 0.13, 1.),
            muted: hsla(0., 0., 0.45, 1.),
            background: hsla(40. / 360., 0.3, 0.985, 1.),
            selection: hsla(210. / 360., 0.9, 0.55, 0.22),
            cursor: hsla(210. / 360., 0.9, 0.45, 1.),
            link: hsla(210. / 360., 0.7, 0.42, 1.),
            first_line_indent: 0.,
            justify: false,
            squeeze: true,
            typewriter: None,
        }
    }
}

impl ProseStyle {
    pub fn font_size(&self, kind: BlockKind) -> Pixels {
        match kind {
            BlockKind::Body => self.body_size,
            BlockKind::H1 => self.heading_sizes[0],
            BlockKind::H2 => self.heading_sizes[1],
            BlockKind::H3 => self.heading_sizes[2],
        }
    }

    pub fn metrics(&self, kind: BlockKind) -> BlockMetrics {
        let font_size = f32::from(self.font_size(kind));
        let spacing = f32::from(self.body_size) * self.paragraph_spacing;
        match kind {
            BlockKind::Body => BlockMetrics {
                font_size,
                line_height: (font_size * self.body_line_height).round(),
                pad_top: 0.,
                pad_bottom: spacing.round(),
            },
            _ => BlockMetrics {
                font_size,
                line_height: (font_size * self.heading_line_height).round(),
                pad_top: (font_size * self.heading_space_above).round(),
                pad_bottom: spacing.round(),
            },
        }
    }

    /// The font of unmarked text in a paragraph of `kind`.
    pub fn base_font(&self, kind: BlockKind) -> Font {
        let mut base = font(self.font_family.clone());
        if kind != BlockKind::Body {
            base.weight = self.heading_weight;
        }
        base
    }

    /// The font with bold and italic applied.
    pub fn font_for(&self, kind: BlockKind, bold: bool, italic: bool) -> Font {
        let mut f = self.base_font(kind);
        if bold {
            f.weight = if kind == BlockKind::Body {
                self.bold_weight
            } else {
                FontWeight::BOLD
            };
        }
        if italic {
            f.style = FontStyle::Italic;
        }
        f
    }
}

/// Behaviour switches of an editor.
#[derive(Clone, Debug)]
pub struct EditorOptions {
    /// Draw right after each edit instead of on the next display-link tick
    /// (needs [`crate::PlatformHooks::present_now`]). Off by default until the
    /// real on-glass latency is measured (see the F4 notes).
    pub present_now: bool,
    /// Caret blink half-period; `None` keeps the caret solid.
    pub cursor_blink: Option<Duration>,
    /// Print every input-method call to stderr (real-IME testing).
    pub ime_log: bool,
    /// A small editor that grows with its text instead of scrolling (a
    /// table cell): no title rows, no scrollbar, every paragraph drawn in a
    /// plain column (no virtual list), as tall as they are.
    pub fit_content: bool,
}

impl Default for EditorOptions {
    fn default() -> Self {
        EditorOptions {
            present_now: false,
            cursor_blink: Some(Duration::from_millis(530)),
            ime_log: false,
            fit_content: false,
        }
    }
}
