//! Sizes: type, spacing, radii and the fixed sizes of glass controls, menus
//! and hover cards. From `desktop-typography.css`, `materials.css` (「尺寸」),
//! `index.css` (`--menu-*`) and docs/design-system/surfaces.md.

/// The interface text size setting (外观 → 界面字号). The renderer's sizes
/// are a base plus an increment per step; the default is Standard.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum TextSize {
    Smallest,
    Small,
    #[default]
    Standard,
    Large,
    Largest,
}

impl TextSize {
    pub const ALL: [TextSize; 5] = [
        TextSize::Smallest,
        TextSize::Small,
        TextSize::Standard,
        TextSize::Large,
        TextSize::Largest,
    ];

    /// `--ui-text-increment`.
    pub const fn increment(self) -> f32 {
        match self {
            TextSize::Smallest | TextSize::Small => 0.0,
            TextSize::Standard => 2.0,
            TextSize::Large => 4.0,
            TextSize::Largest => 6.0,
        }
    }

    pub const fn scale(self) -> TypeScale {
        TypeScale::at(self)
    }
}

/// Font sizes and line heights in px for one [`TextSize`]. Text roles
/// (body, secondary, caption, emphasis, heading) follow the renderer's
/// `--ui-font-*`; the smallest setting keeps the old per-component sizes,
/// which here are the Small values.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TypeScale {
    pub caption: f32,
    pub secondary: f32,
    pub body: f32,
    pub emphasis: f32,
    pub heading: f32,
    /// `--ui-line-caption`, `--ui-line-body`.
    pub line_caption: f32,
    pub line_body: f32,
    /// `--ui-control-height`: buttons, fields, selects.
    pub control_height: f32,
    /// `--ui-row-height`: list rows.
    pub row_height: f32,
    /// A menu row (`.menu-surface__item`): 5px padding round one line, 30px
    /// at the smaller sizes, growing with the step.
    pub menu_row: f32,
    /// Menu text: 14px on 20px at the smaller sizes, growing with the step.
    pub menu_text: f32,
    pub menu_line: f32,
    /// A dialog's title (heading role).
    pub dialog_title: f32,
    /// The sidebars' Panel Tab names (the `label` style, workspace.md):
    /// 11.5 / 13 / 15px at the small, standard and large sizes.
    pub label: f32,
}

impl TypeScale {
    pub const STANDARD: TypeScale = TypeScale::at(TextSize::Standard);

    pub const fn at(size: TextSize) -> TypeScale {
        let k = size.increment();
        TypeScale {
            caption: 12.0 + k,
            secondary: 13.0 + k,
            body: 14.0 + k,
            emphasis: 15.0 + k,
            heading: 16.0 + k,
            line_caption: 16.0 + k,
            line_body: 20.0 + k,
            control_height: 28.0 + k,
            row_height: 32.0 + k,
            menu_row: 30.0 + k,
            menu_text: 14.0 + k,
            menu_line: 20.0 + k,
            dialog_title: 16.0 + k,
            label: if k == 0.0 { 11.5 } else { 11.0 + k },
        }
    }
}

/// Corner radii (surfaces.md, 「形状语法」). Only 1–3px for ordinary things;
/// 16px is for the sheet the author writes on, menus and hover cards.
pub mod radius {
    /// Timeline chapter blocks.
    pub const XS: f32 = 1.0;
    /// The page, buttons, fields, chips, toasts, content cards.
    pub const SM: f32 = 2.0;
    pub const MD: f32 = 3.0;
    /// A menu's inset row.
    pub const MENU_ROW: f32 = 4.0;
    /// Menus, hover cards, the Agent composer and sent messages.
    pub const SHEET: f32 = 16.0;
}

/// Spacing steps in px. The renderer writes pixels directly; these are the
/// values it uses, named by size.
pub mod space {
    pub const S0: f32 = 2.0;
    pub const S1: f32 = 4.0;
    pub const S2: f32 = 6.0;
    pub const S3: f32 = 8.0;
    pub const S4: f32 = 10.0;
    pub const S5: f32 = 12.0;
    pub const S6: f32 = 14.0;
    pub const S7: f32 = 16.0;
    pub const S8: f32 = 20.0;
    pub const S9: f32 = 24.0;
    pub const S10: f32 = 32.0;
}

/// Glass controls (materials.md, 「尺寸」).
pub mod glass {
    /// Every round glass icon button.
    pub const ROUND: f32 = 28.0;
    /// The brush icon inside it.
    pub const ROUND_ICON: f32 = 16.0;
    /// A glass pill in a row with round buttons (a Dock pill).
    pub const PILL_HEIGHT: f32 = ROUND;
    /// The padding of a long pill holding round buttons (the paper's
    /// toolbar): it stands one padding taller on each side, 36px.
    pub const TRAY_PADDING: f32 = 4.0;
    /// `--glass-rim`: how far the bleed reaches in.
    pub const RIM: f32 = 9.0;
    /// A Switch's track and knob.
    pub const SWITCH_W: f32 = 32.0;
    pub const SWITCH_H: f32 = 18.0;
    pub const SWITCH_KNOB: f32 = 14.0;
}

/// Menus and hover cards (interaction.md).
pub mod menu {
    /// One column of actions.
    pub const WIDTH_STANDARD: f32 = 240.0;
    /// Menus holding more: images, lists of objects, forms.
    pub const WIDTH_WIDE: f32 = 320.0;
    /// Settings panels such as relation types.
    pub const WIDTH_SETTINGS: f32 = 420.0;
    /// `--menu-row-inset`.
    pub const ROW_INSET: f32 = 6.0;
    pub const ROW_PAD_Y: f32 = 5.0;
    pub const ROW_PAD_X: f32 = 10.0;
    pub const ICON: f32 = 16.0;
    pub const ICON_GAP: f32 = 10.0;
    /// The list's own padding above the first and below the last row.
    pub const PAD_Y: f32 = 6.0;
    /// `--menu-separator`: a 0.5px hairline, 5px above and below, inset 16px.
    pub const SEPARATOR: f32 = 0.5;
    pub const SEPARATOR_MARGIN: f32 = 5.0;
    pub const SEPARATOR_INSET: f32 = 16.0;
    /// A hover card (all of them are one card).
    pub const HOVER_CARD_WIDTH: f32 = 248.0;
    /// Text in a hover card starts this far in.
    pub const HOVER_CARD_PAD: f32 = 14.0;
    /// The gap between a hover card and the thing it belongs to.
    pub const HOVER_CARD_GAP: f32 = 6.0;
}

/// The workspace's hairlines and corners.
pub mod surface {
    /// A top-level module border, and the hairlines inside a sidebar.
    pub const HAIRLINE: f32 = 0.5;
    /// The page's corner (`--workspace-corner-radius`).
    pub const PAGE_RADIUS: f32 = 2.0;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_is_the_renderers_default() {
        let s = TypeScale::STANDARD;
        assert_eq!(s.body, 16.0);
        assert_eq!(s.secondary, 15.0);
        assert_eq!(s.caption, 14.0);
        assert_eq!(s.control_height, 30.0);
        assert_eq!(s.row_height, 34.0);
        assert_eq!(s.menu_row, 32.0);
        assert_eq!(TypeScale::at(TextSize::Small).menu_row, 30.0);
    }

    #[test]
    fn a_long_pill_is_one_padding_taller_than_its_buttons_on_each_side() {
        assert_eq!(glass::PILL_HEIGHT + 2.0 * glass::TRAY_PADDING, 36.0);
    }
}
