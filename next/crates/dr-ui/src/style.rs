//! Small styling helpers shared by the components.

use std::sync::Arc;

use gpui::{ElementId, FontWeight, SharedString, Styled, px};

use crate::fonts::Role;

pub trait DrStyled: Styled + Sized {
    /// The family of a text role.
    fn font_role(self, role: Role) -> Self {
        self.font_family(role.family())
    }

    /// A font size on a line height, px.
    fn type_px(self, size: f32, line: f32) -> Self {
        self.text_size(px(size)).line_height(px(line))
    }

    fn weight(self, weight: FontWeight) -> Self {
        self.font_weight(weight)
    }
}

impl<T: Styled> DrStyled for T {}

/// The id of a part of `parent` (its mark, its card, its list).
pub fn child_id(parent: &ElementId, name: impl Into<SharedString>) -> ElementId {
    ElementId::NamedChild(Arc::new(parent.clone()), name.into())
}
