//! What was painted this frame, for hit testing, vertical movement and the
//! input method's candidate window.

use std::rc::Rc;

use gpui::{Bounds, Pixels, Point, SharedString};

use crate::layout::ProseLayout;

/// The composition shown inside a paragraph, in display-text bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CompSpan {
    /// Where the marked text starts.
    pub at: usize,
    /// Length of the marked text.
    pub len: usize,
    /// Length of committed text hidden behind it (a replaced selection).
    pub replaced: usize,
}

impl CompSpan {
    /// Display byte → byte in the committed line text.
    pub fn to_line_byte(&self, display: usize) -> usize {
        if display <= self.at {
            display
        } else if display < self.at + self.len {
            self.at
        } else {
            display - self.len + self.replaced
        }
    }
}

/// A paragraph as it was painted this frame.
#[derive(Clone)]
pub struct PaintedLine {
    pub chapter: usize,
    pub line: usize,
    pub rev: u64,
    pub text: SharedString,
    pub bounds: Bounds<Pixels>,
    pub origin: Point<Pixels>,
    pub layout: Rc<ProseLayout>,
    pub line_height: Pixels,
    pub comp: Option<CompSpan>,
}

#[derive(Default)]
pub struct FrameCache {
    pub lines: Vec<PaintedLine>,
}

impl FrameCache {
    pub fn get(&self, chapter: usize, line: usize) -> Option<&PaintedLine> {
        self.lines
            .iter()
            .find(|painted| painted.chapter == chapter && painted.line == line)
    }
}
