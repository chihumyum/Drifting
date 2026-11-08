//! F4c — input: actions and key bindings (macOS and Windows schemes), the
//! selection, input-method composition and the `EntityInputHandler`, caret
//! movement (grapheme clusters, ICU words, rows, paragraphs), editing
//! actions, the mouse (word and paragraph drags), find and replace, the
//! text exposed to screen readers, the system input-method hooks,
//! selections across chapters, list items (Enter, Tab, ticks), and the caret
//! around embeds (`objects.rs`).

pub mod a11y;
pub mod actions;
pub mod composition;
mod editing;
pub mod find;
mod ime;
mod lists;
pub mod mouse;
mod movement;
mod objects;
pub mod selection;
mod span;
pub mod system_ime;

pub use actions::{KEY_CONTEXT, KeyScheme, bind_keys, bind_keys_for, key_bindings};
pub use composition::{Composition, Marked16, Marking, Overlay, Virtual16};
pub use find::{FindEvent, FindHit, FindOptions, FindOutcome, FindScope, FindStatus};
pub use mouse::Granularity;
pub use selection::Selection;

/// The input layer's own state in [`crate::ProseEditor`] (one field, so the
/// other sub-lines' edits of `editor.rs` stay apart from this one's).
#[derive(Default)]
pub(crate) struct InputState {
    pub find: find::FindState,
    /// The unit a drag started by a double or triple click extends by.
    pub drag: Option<mouse::DragUnit>,
    pub a11y: a11y::A11yState,
    /// The last edit group handed out (`span.rs`): edits across chapters.
    pub edit_groups: u64,
    /// Whether typed Markdown list markers make list items (`lists.rs`).
    pub list_shortcuts: bool,
}

impl crate::ProseEditor {
    /// Registers the input layer's actions added since the first milestone
    /// (paragraph moves, find) on the editor's root element; the older ones
    /// are registered in `editor.rs`.
    pub(crate) fn register_input_actions(
        &mut self,
        root: gpui::Stateful<gpui::Div>,
        cx: &mut gpui::Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        use gpui::InteractiveElement as _;
        root.on_action(cx.listener(Self::on_move_to_paragraph_start))
            .on_action(cx.listener(Self::on_move_to_paragraph_end))
            .on_action(cx.listener(Self::on_move_to_next_paragraph))
            .on_action(cx.listener(Self::on_select_to_paragraph_start))
            .on_action(cx.listener(Self::on_select_to_paragraph_end))
            .on_action(cx.listener(Self::on_select_to_next_paragraph))
            .on_action(cx.listener(Self::on_find_next))
            .on_action(cx.listener(Self::on_find_previous))
            .on_action(cx.listener(Self::on_use_selection_for_find))
            .on_action(cx.listener(Self::on_indent_list_item))
            .on_action(cx.listener(Self::on_outdent_list_item))
            .on_action(cx.listener(Self::on_toggle_task))
    }
}

#[cfg(test)]
mod tests;
