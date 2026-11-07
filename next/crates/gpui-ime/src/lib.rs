//! gpui-ime: input-method composition rules with no dependencies.
//!
//! Two shapes of the same rules:
//!
//! - [`overlay`]: composition shown over a document the input method does
//!   not own (gpui-prose's editor): the marked text never reaches the
//!   document; confirming writes it once; [`Marked16`] maps between the
//!   committed text and the input method's virtual text in UTF-16.
//! - [`line`]: one line of text that owns its buffer (dr-ui's fields).
//!
//! Shared rules: marked text is never reported as committed; composing over
//! a selection replaces it only on confirm; deleting all marked text cancels
//! with the text untouched; **losing focus discards the marked text** and the
//! host asks the system input method to drop it (`[NSTextInputContext
//! discardMarkedText]` on macOS, `ImmNotifyIME(…, NI_COMPOSITIONSTR,
//! CPS_CANCEL, 0)` on Windows).

pub mod line;
pub mod overlay;
pub mod units;

pub use line::{Boundaries, Change, LineComposer, Scalars};
pub use overlay::{Marked16, Marking, Overlay, Virtual16};

/// What losing focus does with marked text: always [`BlurRule::Discard`]
/// (the author's decision). A named constant so hosts can assert it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlurRule {
    /// Drop the marked text here and in the system input method.
    Discard,
}

pub const BLUR_RULE: BlurRule = BlurRule::Discard;
