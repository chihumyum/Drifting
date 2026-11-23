//! Small styling helpers shared by the components.

use std::sync::Arc;

use gpui::{ElementId, FontWeight, SharedString, Styled, px};

use crate::fonts::{self, Role};

pub trait DrStyled: Styled + Sized {
    /// The family of a text role, and the fallback chain it names
    /// ([`Role::fallbacks`]: on Windows only).
    fn font_role(mut self, role: Role) -> Self {
        if let Some(fallbacks) = role.fallbacks() {
            self.text_style().font_fallbacks = Some(fallbacks);
        }
        self.font_family(role.family())
    }

    /// A font size on a line height, px.
    fn type_px(self, size: f32, line: f32) -> Self {
        self.text_size(px(size)).line_height(px(line))
    }

    fn weight(self, weight: FontWeight) -> Self {
        self.font_weight(weight)
    }

    /// Italic as the face draws it, never a slant made up for glyphs that
    /// have no italic (a preview's name, a lane's name): on macOS this is
    /// GPUI's `italic()` unchanged; where the platform would slant the
    /// upright face instead ([`fonts::SYNTHESIZES_ITALIC`], Windows) it asks
    /// for nothing, so the text stays as macOS draws it.
    fn italic_face(self) -> Self {
        if fonts::SYNTHESIZES_ITALIC {
            self
        } else {
            self.italic()
        }
    }
}

impl<T: Styled> DrStyled for T {}

/// The id of a part of `parent` (its mark, its card, its list).
pub fn child_id(parent: &ElementId, name: impl Into<SharedString>) -> ElementId {
    ElementId::NamedChild(Arc::new(parent.clone()), name.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::FontStyle;

    /// On macOS `italic_face` is GPUI's `italic()` as it was; on Windows,
    /// where an italic request on the bundled faces is a made-up slant, it
    /// asks for nothing (the macOS half runs on macOS CI, the Windows half
    /// on Windows CI).
    #[test]
    fn italic_face_asks_for_italic_only_where_none_is_made_up() {
        let mut asked = gpui::div().italic_face();
        let plain = gpui::div().italic().text_style().font_style;
        assert_eq!(plain, Some(FontStyle::Italic));
        let expected = if cfg!(windows) { None } else { plain };
        assert_eq!(asked.text_style().font_style, expected);
    }
}
