//! Extension points for editors built on gpui-prose (Drifting's `dr-editor`
//! adds entity links, Markdown input rules, TODO markers and the selection
//! toolbar through these).
//!
//! Two hooks: styling marked runs, and input rules (what typed text turns
//! into). Hosts also see what happens through [`crate::EditorEvent`] and can
//! query marks at a position ([`crate::ProseEditor::marks_at`]).

use std::ops::Range;

use loro::LoroValue;

use crate::{
    render::RunStyle,
    style::ProseStyle,
    text::{BlockKind, Marks},
};

/// What the author just typed, for [`ProseExtension::input_rule`].
#[derive(Clone, Copy, Debug)]
pub struct Typed<'a> {
    /// The paragraph's text before the caret, the typed text included.
    pub before: &'a str,
    /// The text just typed: one keystroke, or a confirmed composition.
    pub typed: &'a str,
    /// The paragraph's heading level.
    pub kind: BlockKind,
}

/// What an input rule turns typed text into. Offsets are characters of
/// [`Typed::before`] (0 is the paragraph start). gpui-prose applies it as its
/// own undo step right after the typing, so Undo brings the literal text
/// back.
#[derive(Clone, Debug, PartialEq)]
pub enum InputRule {
    /// Mark `inner` with `key` = `value` and delete the marker characters
    /// `open` (right before `inner`) and `close` (right after it). Typing
    /// then continues without the mark.
    Mark {
        open: Range<usize>,
        inner: Range<usize>,
        close: Range<usize>,
        key: String,
        value: LoroValue,
    },
    /// Delete `prefix` (at the paragraph start) and set the paragraph
    /// attribute `key` (a heading level, a quote).
    Block {
        prefix: Range<usize>,
        key: &'static str,
        value: LoroValue,
    },
}

pub trait ProseExtension: 'static {
    /// Adjusts how a run of marked text looks; `run` starts as gpui-prose's
    /// default look for `marks` (bold, italic, links, underline, strike).
    /// Entity links (`entity:<id>` keys) have no default look.
    fn style_run(&self, _marks: &Marks, _run: &mut RunStyle, _style: &ProseStyle) {}

    /// Called after the author typed text outside a composition (and after a
    /// composition is confirmed); returns what the text turns into, if
    /// anything.
    fn input_rule(&self, _typed: &Typed<'_>) -> Option<InputRule> {
        None
    }

    /// Whether the TODO a task item is linked to (`todo` on its paragraph)
    /// is done; the item shows that instead of a `checked` of its own.
    /// `None`: not known (drawn as not done).
    fn task_done(&self, _todo: &str) -> Option<bool> {
        None
    }
}
